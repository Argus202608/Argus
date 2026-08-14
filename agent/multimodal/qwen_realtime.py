"""DashScope (Qwen) realtime speech clients — async, over ``websockets``.

Ported from streaming_demo/qwen_asr.py + qwen_tts_realtime.py, but rewritten on
the async ``websockets`` library (already a dependency) instead of the sync
``websocket-client`` the demo used — so both fit the multimodal backend's
daemon-thread asyncio loop with no extra package and no sync↔async bridge.

Endpoint (Beijing region):
    wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<model>
Auth: ``Authorization: Bearer <dashscope_api_key>``.

Both clients are NO-OPs when the api key is blank (the key is a per-account
DashScope key that must be configured in ~/.hermes/config.yaml — it is not
bundled). Callers should check ``bool(api_key)`` before starting a session.

  * :class:`QwenRealtimeASR` — streaming user-speech recognition. Feed PCM16
    (16 kHz mono) via :meth:`append_audio`; server-side VAD segments speech and
    emits partial (``on_partial``) + final (``on_final``) text.
  * :class:`QwenRealtimeTTS` — streaming text→speech. :meth:`synthesize` sends
    text + commit and yields PCM16 (24 kHz mono) chunks as they arrive.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Awaitable, Callable, Optional

log = logging.getLogger("hermes.multimodal.qwen_realtime")

_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"

# TTS input_text_buffer.append 单帧安全字节上限。DashScope WS 帧上限 256KB (262144),
# 超了服务端回 1009 (message too big) 直接关连接。留足 JSON 包裹余量 → 60KB (≈2万汉字,
# 单段口播绝够; 长文本会被切成多个 append)。
_TTS_APPEND_MAX_BYTES = 60000


def _chunk_text_by_bytes(text: str, max_bytes: int):
    """把 text 按 UTF-8 字节上限切成多片, **不切坏多字节字符**。短文本原样单片返回。"""
    if not text:
        return
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        yield text
        return
    buf = []
    size = 0
    for ch in text:
        b = len(ch.encode("utf-8"))
        if size + b > max_bytes and buf:
            yield "".join(buf)
            buf, size = [], 0
        buf.append(ch)
        size += b
    if buf:
        yield "".join(buf)


class QwenRealtimeASR:
    """Streaming ASR over the DashScope realtime WebSocket (server-VAD).

    Lifecycle (all async, run on the caller's loop):
        asr = QwenRealtimeASR(api_key, on_partial=..., on_final=...)
        await asr.connect()          # opens WS + configures session
        await asr.append_audio(pcm)  # feed 16k PCM16 chunks repeatedly
        ...                          # on_partial / on_final fire from _reader
        await asr.close()            # finish session + close WS
    """

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "qwen3-asr-flash-realtime",
        language: str = "zh",
        sample_rate: int = 16000,
        # VAD defaults tuned for "listen like a human" — the demo's 0.7/500ms
        # cuts speech mid-sentence when the user pauses to think. 0.5/1200ms is
        # more tolerant (roughly 2× wait for silence, less trigger-happy on
        # noise). Override via realtime_asr_vad_* in config.
        vad_threshold: float = 0.5,
        vad_silence_ms: int = 1200,
        on_partial: Optional[Callable[[str], Awaitable[None]]] = None,
        on_final: Optional[Callable[[str], Awaitable[None]]] = None,
        on_speech_started: Optional[Callable[[], Awaitable[None]]] = None,
        on_speech_stopped: Optional[Callable[[], Awaitable[None]]] = None,
    ):
        self.api_key = (api_key or "").strip()
        self.model = model
        self.language = language
        self.sample_rate = sample_rate
        self.vad_threshold = vad_threshold
        self.vad_silence_ms = vad_silence_ms
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_speech_started = on_speech_started
        self.on_speech_stopped = on_speech_stopped

        self._ws = None
        self._reader_task: Optional[asyncio.Task] = None
        self._connected = False
        # Set by _reader when the server acknowledges our session.update
        # (session.updated / session.created). connect() waits on this before
        # returning so the caller doesn't start pumping audio while the server
        # is still configuring VAD — otherwise the FIRST utterance's opening is
        # dropped and only the 2nd+ utterance transcribes.
        self._session_ready: asyncio.Event = asyncio.Event()

    @property
    def is_connected(self) -> bool:
        """True 当且仅当上游 WS 活着 (reader 未把 _connected 置 False, 且 ws 还在)。
        watcher_engine.asr_audio 用它判"上游死没死"→ 死了触发重连自愈。"""
        return bool(self._connected and self._ws is not None)

    async def connect(self) -> bool:
        if not self.api_key:
            log.warning("[qwen-asr] no api_key; realtime ASR disabled")
            return False
        # ★ 重连安全 (同对象再次 connect): 先清理上一条死连接的残留 reader + 重置
        #   session_ready, 否则重连会泄漏旧 reader task / 卡在旧的 ready 事件上。
        if self._reader_task is not None:
            try:
                self._reader_task.cancel()
            except Exception:
                pass
            self._reader_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        self._session_ready.clear()
        try:
            import websockets
        except Exception as exc:  # pragma: no cover
            log.warning("[qwen-asr] websockets unavailable: %s", exc)
            return False
        url = f"{_BASE_URL}?model={self.model}"
        headers = {"Authorization": f"Bearer {self.api_key}",
                   "OpenAI-Beta": "realtime=v1"}
        try:
            # additional_headers (websockets>=13); fall back to extra_headers.
            try:
                self._ws = await websockets.connect(url, additional_headers=headers)
            except TypeError:
                self._ws = await websockets.connect(url, extra_headers=headers)
        except Exception as exc:
            log.warning("[qwen-asr] connect failed: %s", exc)
            return False
        self._connected = True
        # Start the reader FIRST so it can observe the server's session
        # acknowledgement, THEN send our config.
        self._reader_task = asyncio.create_task(self._reader())
        await self._send_session_update()
        # Wait until the server has processed our session.update (server VAD is
        # then armed). Without this, the caller starts streaming audio
        # immediately and the first utterance's opening is dropped. Bounded so a
        # server that never sends the ack doesn't hang the mic — degrade to
        # "ready" after the timeout rather than block.
        try:
            await asyncio.wait_for(self._session_ready.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            log.warning("[qwen-asr] session.updated not received within 3s — "
                        "proceeding (first utterance may clip)")
        log.info("[qwen-asr] connected model=%s", self.model)
        return True

    async def _send_session_update(self) -> None:
        event = {
            "event_id": "session_update",
            "type": "session.update",
            "session": {
                "modalities": ["text"],
                "input_audio_format": "pcm",
                "sample_rate": self.sample_rate,
                "input_audio_transcription": {"language": self.language},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": self.vad_threshold,
                    "silence_duration_ms": self.vad_silence_ms,
                },
            },
        }
        await self._ws.send(json.dumps(event))

    async def append_audio(self, pcm: bytes) -> None:
        """Feed a chunk of 16 kHz mono PCM16 audio (raw bytes)."""
        if not self._connected or not self._ws or not pcm:
            return
        try:
            event = {"type": "input_audio_buffer.append",
                     "audio": base64.b64encode(pcm).decode("ascii")}
            await self._ws.send(json.dumps(event))
        except Exception as exc:
            log.debug("[qwen-asr] append_audio failed: %s", exc)

    async def _reader(self) -> None:
        try:
            async for message in self._ws:
                try:
                    data = json.loads(message)
                except Exception:
                    continue
                et = data.get("type")
                if et in ("session.updated", "session.created"):
                    # Server processed our session.update (VAD armed). Release
                    # connect() so the caller may start streaming audio.
                    self._session_ready.set()
                elif et == "conversation.item.input_audio_transcription.text":
                    txt = (data.get("text") or "").strip()
                    if txt and self.on_partial:
                        await self.on_partial(txt)
                elif et == "conversation.item.input_audio_transcription.completed":
                    txt = (data.get("transcript") or "").strip()
                    if txt and self.on_final:
                        await self.on_final(txt)
                elif et == "input_audio_buffer.speech_started":
                    if self.on_speech_started:
                        await self.on_speech_started()
                elif et == "input_audio_buffer.speech_stopped":
                    if self.on_speech_stopped:
                        await self.on_speech_stopped()
                elif et == "session.finished":
                    txt = (data.get("transcript") or "").strip()
                    if txt and self.on_final:
                        await self.on_final(txt)
                elif et == "error":
                    msg = (data.get("error") or {}).get("message", "unknown")
                    log.warning("[qwen-asr] server error: %s", msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.debug("[qwen-asr] reader ended: %s", exc)
        finally:
            # ★ C2: WS closed or errored out on its own — the connection is dead.
            # Clear the flag so append_audio() stops sending to a dead socket
            # (the caller can then observe disconnection / trigger a reconnect).
            self._connected = False

    async def close(self) -> None:
        self._connected = False
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "session.finish"}))
            except Exception:
                pass
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        self._ws = None
        self._reader_task = None


class QwenRealtimeTTS:
    """Streaming TTS over the DashScope realtime WebSocket (client_commit).

    Usage — yields PCM16 (24 kHz mono) chunks:
        tts = QwenRealtimeTTS(api_key, voice="Cherry")
        async for pcm, sr in tts.synthesize("你好"):
            ...
    """

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "qwen3-tts-flash-realtime",
        voice: str = "Cherry",
        sample_rate: int = 24000,
        language_type: str = "Auto",
        speech_rate: float = 1.3,
    ):
        self.api_key = (api_key or "").strip()
        self.model = model
        self.voice = voice
        self.sample_rate = sample_rate
        self.language_type = language_type
        # Playback speed. This deployment honors `speech_rate` (NOT `rate` /
        # `speed`, probed 2026-07-02): 1.0 = default (sounds slow/robotic),
        # 1.3 ≈ natural conversational pace, 2.0 = fast. Tunable via config
        # realtime_tts_speech_rate.
        self.speech_rate = float(speech_rate)

    async def synthesize(self, text: str):
        """Async generator yielding ``(pcm_bytes, sample_rate)`` chunks."""
        text = (text or "").strip()
        if not text or not self.api_key:
            return
        try:
            import websockets
        except Exception as exc:  # pragma: no cover
            log.warning("[qwen-tts] websockets unavailable: %s", exc)
            return
        url = f"{_BASE_URL}?model={self.model}"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        ws = None
        try:
            try:
                ws = await websockets.connect(url, additional_headers=headers)
            except TypeError:
                ws = await websockets.connect(url, extra_headers=headers)
        except Exception as exc:
            log.warning("[qwen-tts] connect failed: %s", exc)
            return
        try:
            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "mode": "client_commit",
                    "voice": self.voice,
                    "language_type": self.language_type,
                    "response_format": "pcm",
                    "sample_rate": self.sample_rate,
                    "speech_rate": self.speech_rate,
                },
            }))
            # ★ 分片 append 防 1009 (frame too big, 上限 256KB): text 过长时一次性 append
            #   的出站帧可能超限被服务端 1009 关连接。按 UTF-8 字节安全上限分多次 append
            #   (不切坏多字节字符), 最后 commit。短文本仍是一次 append (行为不变)。
            for _piece in _chunk_text_by_bytes(text, _TTS_APPEND_MAX_BYTES):
                await ws.send(json.dumps({"type": "input_text_buffer.append",
                                          "text": _piece}))
            await ws.send(json.dumps({"type": "input_text_buffer.commit"}))

            async for message in ws:
                try:
                    event = json.loads(message)
                except Exception:
                    continue
                et = event.get("type")
                if et == "response.audio.delta":
                    b64 = event.get("delta", "")
                    if b64:
                        try:
                            yield base64.b64decode(b64), self.sample_rate
                        except Exception:
                            pass
                elif et == "response.done":
                    break
                elif et == "error":
                    msg = (event.get("error") or {}).get("message", "unknown")
                    log.warning("[qwen-tts] server error: %s", msg)
                    break
        except Exception as exc:
            log.warning("[qwen-tts] stream error: %s", exc)
        finally:
            try:
                await ws.send(json.dumps({"type": "session.finish"}))
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass
