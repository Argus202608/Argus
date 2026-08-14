import { atom } from 'nanostores'

import { $gateway } from './gateway'
import { $mmSessionId, addVoiceUserMessage } from './multimodal'

/**
 * Voice I/O for the multimodal page (desktop port of web startMic/stopMic +
 * onTtsChunk + env-audio):
 *   - Mic streaming ASR: getUserMedia → AudioWorklet(pcm-worklet.js) → 16k PCM
 *     batches → multimodal.asr_audio; asr_partial/asr_final drive the preview
 *     bar and inject the final as a voice user message.
 *   - TTS playback: multimodal.tts PCM16 chunks → WebAudio gapless scheduling.
 *   - Env audio: screen-share audio track → MediaRecorder 5s slices →
 *     multimodal.env_audio.
 *
 * Cross-platform: standard WebAudio / MediaRecorder / AudioWorklet (Electron
 * Chromium, identical on macOS/Windows/Linux). Module-scoped state so playback
 * keeps working when the page/window is hidden.
 */

export type MicState = 'idle' | 'connecting' | 'recording'

export const $mmMicState = atom<MicState>('idle')
export const $mmAsrPartial = atom<string>('')
// EOU listening mode can stitch several finalized speech segments before it
// submits the complete user turn. Keep those segments separate from the live
// partial so the composer can render the stable prefix dimmed, matching Web.
export const $mmAsrBuffer = atom<string[]>([])
export const $mmTtsPlaying = atom<boolean>(false)
// ★ 语音自动播报开关 (对齐 web): 开启后后端 VoiceAgent 旁路会自动把主 agent / watcher /
//   monitor 的完成气泡改写口语化 → 播报。与麦克风解耦, 默认关。
export const $mmTtsEnabled = atom<boolean>(false)
// ★ 对话模式开关 (对齐 web): 开启 → ASR final 进 VoiceAgent v2 主线程分诊
//   (self 直答 / 委派主 Agent 时回一句承接语 + 层2/层3防误识别); 关闭 → ASR final
//   走传统路径 (_run_prompt_submit)。与麦克风联动 (见 toggleMultimodalVoiceDialog):
//   开对话自动开麦; 关麦强制关对话 (无麦相当于哑火)。
//   注: 分诊/播报/承接语等全部逻辑在共用的 Python 后端 (agent/multimodal/voice_agent_v2*),
//   desktop 端只有这几个 UI 开关 —— 后端改动 web/desktop 自动共享, 无需在此同步。
export const $mmVoiceDialogEnabled = atom<boolean>(false)

const WORKLET_URL = `${import.meta.env.BASE_URL || './'}pcm-worklet.js`

// ── base64 helpers (chunked to avoid stack blowups on large buffers) ────────
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ── Mic streaming ASR ───────────────────────────────────────────────────────
interface MicRefs {
  stream: MediaStream | null
  ctx: AudioContext | null
  source: MediaStreamAudioSourceNode | null
  node: AudioWorkletNode | null
  recording: boolean
  generation: number
  gateway: ReturnType<typeof $gateway.get>
  sessionId: string
  /** User intent kept across a reconnect attempt that races runtime resume. */
  rearmPending: boolean
  draftEnsureSession: (() => Promise<string | null>) | null
  preRoll: ArrayBuffer[]
  preRollBytes: number
  cancelPendingDraft: (() => void) | null
}

const mic: MicRefs = {
  stream: null,
  ctx: null,
  source: null,
  node: null,
  recording: false,
  generation: 0,
  gateway: null,
  sessionId: '',
  rearmPending: false,
  draftEnsureSession: null,
  preRoll: [],
  preRollBytes: 0,
  cancelPendingDraft: null
}

const MIC_PRE_ROLL_MAX_BYTES = 16_000 * 2 * 3

/** Desktop main-chat injection point. It deliberately creates nothing until
 * the locally-armed draft mic produces non-empty PCM. */
export function configureDraftMicSessionEnsurer(ensureSession: (() => Promise<string | null>) | null): void {
  mic.draftEnsureSession = ensureSession
}

function clearMicPreRoll(): void {
  mic.preRoll = []
  mic.preRollBytes = 0
}

function appendMicPreRoll(buf: ArrayBuffer): void {
  const copy = buf.slice(0)

  mic.preRoll.push(copy)
  mic.preRollBytes += copy.byteLength

  while (mic.preRollBytes > MIC_PRE_ROLL_MAX_BYTES && mic.preRoll.length > 1) {
    const dropped = mic.preRoll.shift()

    mic.preRollBytes -= dropped?.byteLength || 0
  }
}

function clearAsrPreview(): void {
  $mmAsrPartial.set('')
  $mmAsrBuffer.set([])
}

/** True when the mic either owns resources or is waiting for the replacement
 * runtime of the same durable conversation. The latter intentionally does not
 * rely on the presentation atom: a failed start against the stale runtime may
 * return the UI to idle before session.resume publishes its replacement id. */
export function hasMicCaptureIntent(): boolean {
  return Boolean(mic.rearmPending || mic.recording || mic.sessionId || $mmMicState.get() !== 'idle')
}

async function startMicOwned(keepRearmIntentOnFailure: boolean): Promise<void> {
  if (mic.recording || $mmMicState.get() === 'connecting') {
    return
  }

  const gw = $gateway.get()
  const sid = $mmSessionId.get()

  if (!gw || !sid) {
    return
  }

  const generation = mic.generation + 1

  mic.generation = generation
  mic.gateway = gw
  mic.sessionId = sid
  clearAsrPreview()
  $mmMicState.set('connecting')

  let pendingStream: MediaStream | null = null
  let pendingCtx: AudioContext | null = null

  const stillOwnsStart = () => mic.generation === generation && mic.sessionId === sid && $mmSessionId.get() === sid

  const releasePending = () => {
    if (pendingCtx) {
      void pendingCtx.close().catch(() => undefined)
      pendingCtx = null
    }

    if (pendingStream) {
      pendingStream.getTracks().forEach(track => track.stop())
      pendingStream = null
    }
  }

  const stopOwnedBackend = () => {
    // A superseding generation may deliberately re-open ASR on the same
    // runtime (transport reconnect). Its session now owns that backend key, so
    // a late stale starter must not stop the replacement it just created.
    if (mic.generation !== generation && mic.sessionId === sid) {
      return
    }

    void gw.request('multimodal.asr_stop', { session_id: sid }).catch(() => undefined)
  }

  const abandonStaleStart = () => {
    releasePending()
    stopOwnedBackend()

    // If no newer generation took ownership, this start became stale solely
    // because its session disappeared. Do not leave the UI stuck connecting.
    if (mic.generation === generation && mic.sessionId === sid) {
      mic.gateway = null
      mic.sessionId = ''

      if (!keepRearmIntentOnFailure) {
        mic.rearmPending = false
      }

      $mmMicState.set('idle')
      clearAsrPreview()
    }
  }

  try {
    const res = await gw.request<{ enabled?: boolean }>('multimodal.asr_start', { session_id: sid }, 210_000)

    if (!stillOwnsStart()) {
      abandonStaleStart()

      return
    }

    if (!res?.enabled) {
      $mmMicState.set('idle')
      throw new Error('流式语音未启用（需在配置里填 dashscope_api_key）')
    }

    pendingStream = await navigator.mediaDevices.getUserMedia({
      // Full software 3A: echo-cancel + noise-suppress + auto-gain (AGC was
      // missing — it levels your voice so it stands out over background). This
      // is the browser/Electron ceiling: it suppresses STEADY noise but cannot
      // beam-form or target-speaker like a phone's mic array + DSP, so nearby
      // human speech still leaks. channelCount:1 = mono (ASR wants 16k mono).
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    })

    if (!stillOwnsStart()) {
      abandonStaleStart()

      return
    }

    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    pendingCtx = new Ctx()
    await pendingCtx.audioWorklet.addModule(WORKLET_URL)

    if (!stillOwnsStart()) {
      abandonStaleStart()

      return
    }

    const source = pendingCtx.createMediaStreamSource(pendingStream)
    const node = new AudioWorkletNode(pendingCtx, 'pcm-downsample-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { inRate: pendingCtx.sampleRate, batchMs: 200 }
    })

    node.port.onmessage = (ev: MessageEvent) => {
      if (!mic.recording || mic.generation !== generation || mic.sessionId !== sid || $mmSessionId.get() !== sid) {
        return
      }
      // Barge-in guard: while the assistant's TTS is audible (+ tail), drop the
      // mic PCM so speaker output isn't re-captured and looped back into ASR.
      if (micGatedForTts()) {
        return
      }

      const buf = ev.data as ArrayBuffer

      if (!buf || !buf.byteLength) {
        return
      }

      const pcm_b64 = bytesToBase64(new Uint8Array(buf))
      void gw.request('multimodal.asr_audio', { session_id: sid, pcm_b64 }).catch(() => undefined)
    }
    source.connect(node)
    node.connect(pendingCtx.destination)

    mic.stream = pendingStream
    mic.ctx = pendingCtx
    mic.source = source
    mic.node = node
    pendingStream = null
    pendingCtx = null
    mic.recording = true
    mic.rearmPending = false
    $mmMicState.set('recording')
  } catch (e) {
    releasePending()
    stopOwnedBackend()

    if (mic.generation !== generation || mic.sessionId !== sid) {
      return
    }

    mic.gateway = null
    mic.sessionId = ''

    if (!keepRearmIntentOnFailure) {
      mic.rearmPending = false
    }

    $mmMicState.set('idle')
    clearAsrPreview()

    throw e
  }
}

async function armDraftMic(): Promise<void> {
  if (hasMicCaptureIntent()) {
    return
  }

  const ensureSession = mic.draftEnsureSession

  if (!ensureSession) {
    return
  }

  const generation = mic.generation + 1

  mic.generation = generation
  mic.rearmPending = true
  clearAsrPreview()
  clearMicPreRoll()
  $mmMicState.set('connecting')

  let pendingStream: MediaStream | null = null
  let pendingCtx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let createInFlight: Promise<void> | null = null

  const stillOwnsDraft = () => mic.generation === generation && mic.rearmPending
  const releasePending = () => {
    if (node) {
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
      node = null
    }
    source?.disconnect()
    source = null

    if (pendingCtx) {
      void pendingCtx.close().catch(() => undefined)
      pendingCtx = null
    }
    if (pendingStream) {
      pendingStream.getTracks().forEach(track => track.stop())
      pendingStream = null
    }
  }
  mic.cancelPendingDraft = releasePending

  const failDraft = () => {
    if (!stillOwnsDraft()) {
      return
    }

    mic.rearmPending = false
    mic.cancelPendingDraft = null
    $mmMicState.set('idle')
    clearMicPreRoll()
    releasePending()

    if ($mmVoiceDialogEnabled.get()) {
      $mmVoiceDialogEnabled.set(false)
    }
  }

  try {
    pendingStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    })

    if (!stillOwnsDraft()) {
      releasePending()

      return
    }

    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    pendingCtx = new Ctx()
    await pendingCtx.audioWorklet.addModule(WORKLET_URL)

    if (!stillOwnsDraft()) {
      releasePending()

      return
    }

    source = pendingCtx.createMediaStreamSource(pendingStream)
    node = new AudioWorkletNode(pendingCtx, 'pcm-downsample-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { inRate: pendingCtx.sampleRate, batchMs: 200 }
    })
    node.port.onmessage = (ev: MessageEvent) => {
      if (!stillOwnsDraft()) {
        return
      }

      const buf = ev.data as ArrayBuffer

      if (!buf?.byteLength) {
        return
      }

      appendMicPreRoll(buf)

      createInFlight ??= (async () => {
        const sid = await ensureSession()

        if (!sid || !stillOwnsDraft() || $mmSessionId.get() !== sid) {
          failDraft()

          return
        }

        const gw = $gateway.get()

        if (!gw) {
          failDraft()

          return
        }

        const res = await gw.request<{ enabled?: boolean }>(
          'multimodal.asr_start',
          {
            session_id: sid
          },
          210_000
        )

        if (!res?.enabled || !stillOwnsDraft() || $gateway.get() !== gw || $mmSessionId.get() !== sid) {
          if (res?.enabled) {
            void gw.request('multimodal.asr_stop', { session_id: sid }).catch(() => undefined)
          }

          failDraft()

          return
        }

        const committedNode = node

        if (!committedNode) {
          failDraft()

          return
        }

        mic.gateway = gw
        mic.sessionId = sid
        mic.stream = pendingStream
        mic.ctx = pendingCtx
        mic.source = source
        mic.node = committedNode
        mic.recording = true
        mic.rearmPending = false
        mic.cancelPendingDraft = null
        pendingStream = null
        pendingCtx = null
        source = null
        node = null
        $mmMicState.set('recording')

        committedNode.port.onmessage = (event: MessageEvent) => {
          if (
            !mic.recording ||
            mic.generation !== generation ||
            mic.sessionId !== sid ||
            $mmSessionId.get() !== sid ||
            micGatedForTts()
          ) {
            return
          }

          const liveBuf = event.data as ArrayBuffer

          if (!liveBuf?.byteLength) {
            return
          }

          const pcm_b64 = bytesToBase64(new Uint8Array(liveBuf))

          void gw.request('multimodal.asr_audio', { session_id: sid, pcm_b64 }).catch(() => undefined)
        }

        const queued = mic.preRoll

        clearMicPreRoll()
        for (const chunk of queued) {
          if (mic.generation !== generation || mic.sessionId !== sid || $mmSessionId.get() !== sid) {
            break
          }
          const pcm_b64 = bytesToBase64(new Uint8Array(chunk))

          void gw.request('multimodal.asr_audio', { session_id: sid, pcm_b64 }).catch(() => undefined)
        }

        if ($mmVoiceDialogEnabled.get() && mic.generation === generation) {
          void gw
            .request('multimodal.voice_dialog_toggle', {
              session_id: sid,
              enabled: true
            })
            .catch(() => undefined)
        }
      })().catch(failDraft)
    }
    source.connect(node)
    node.connect(pendingCtx.destination)
  } catch (error) {
    releasePending()

    if (stillOwnsDraft()) {
      mic.rearmPending = false
      mic.cancelPendingDraft = null
      $mmMicState.set('idle')
      clearMicPreRoll()

      if ($mmVoiceDialogEnabled.get()) {
        $mmVoiceDialogEnabled.set(false)
      }
    }

    throw error
  }
}

export async function startMic(): Promise<void> {
  if (!$mmSessionId.get()) {
    await armDraftMic()

    return
  }

  // A direct user start is a fresh attempt. Only reconnect/rebind paths keep a
  // latent intent when the old runtime rejects before its replacement exists.
  mic.rearmPending = false
  clearMicPreRoll()
  await startMicOwned(false)
}

/** Tear down mic AudioContext/worklet/stream (no server call). Shared by
 *  stopMic, the startMic failure path, and reconnect re-arm. Idempotent. */
function _releaseMicResources(): void {
  try {
    if (mic.node) {
      try {
        mic.node.port.onmessage = null
        mic.node.port.close()
        mic.node.disconnect()
      } catch {
        /* noop */
      }
    }
    if (mic.source) {
      try {
        mic.source.disconnect()
      } catch {
        /* noop */
      }
    }
    if (mic.ctx) void mic.ctx.close().catch(() => undefined)
    if (mic.stream) mic.stream.getTracks().forEach(t => t.stop())
  } finally {
    mic.node = null
    mic.source = null
    mic.ctx = null
    mic.stream = null
  }
}

/** ★ Reconnect re-arm (background-lifecycle): after a gateway drop+reconnect the
 *  server's ASR session was reaped (close_on_disconnect), so a still-"recording"
 *  mic would stream PCM into a dead ASR session — transcription silently dies.
 *  Called from the connection onState handler on reconnect: if the user had the
 *  mic on, tear the local audio graph down and start it fresh against the new
 *  session id. No-op if the mic wasn't recording. */
async function rearmMic(stopPreviousBackend: boolean, keepIntentForReplacement: boolean): Promise<void> {
  if (!hasMicCaptureIntent()) {
    return
  }

  const previousGateway = mic.gateway
  const previousSessionId = mic.sessionId
  const cancelPendingDraft = mic.cancelPendingDraft

  mic.rearmPending = true
  mic.generation += 1
  mic.cancelPendingDraft = null
  mic.recording = false
  mic.gateway = null
  mic.sessionId = ''
  _releaseMicResources()
  cancelPendingDraft?.()
  clearMicPreRoll()
  clearAsrPreview()

  $mmMicState.set('connecting')

  if (stopPreviousBackend && previousGateway && previousSessionId) {
    void previousGateway
      .request('multimodal.asr_stop', {
        session_id: previousSessionId
      })
      .catch(() => undefined)
  }

  if (!$mmSessionId.get()) {
    if (!keepIntentForReplacement) {
      mic.rearmPending = false
    }

    $mmMicState.set('idle')

    return
  }

  $mmMicState.set('idle')

  try {
    await startMicOwned(keepIntentForReplacement)

    // A replacement runtime has a fresh session dictionary. Restore the
    // conversation-mode bit after ASR comes up so the UI's still-enabled
    // dialog mode continues routing finals through VoiceAgent on the new sid.
    const currentGateway = $gateway.get()
    const currentSessionId = $mmSessionId.get()

    if ($mmVoiceDialogEnabled.get() && $mmMicState.get() === 'recording' && currentGateway && currentSessionId) {
      void currentGateway
        .request('multimodal.voice_dialog_toggle', {
          session_id: currentSessionId,
          enabled: true
        })
        .catch(() => undefined)
    }
  } catch {
    // The stale runtime can reject before session.resume publishes A2. The
    // transport-reconnect caller keeps that one-shot intent separately from
    // the idle presentation state; the concrete A2 rebind is the final attempt
    // and consumes it even if ASR is now disabled.
    $mmMicState.set('idle')
  }
}

/** Recreate ASR after a transport reconnect. The old backend-side ASR session
 * was already reaped with the socket, so only the local graph needs rearming. */
export async function rearmMicAfterReconnect(): Promise<void> {
  await rearmMic(false, true)
}

/** Move a live mic from an obsolete runtime id to the replacement runtime for
 * the same durable conversation. The old runtime is explicitly stopped before
 * the new ASR session starts; voice-dialog state remains enabled. */
export async function rearmMicForSessionRebind(): Promise<void> {
  await rearmMic(true, false)
}

export async function stopMic(): Promise<void> {
  // Always clear the preview, even if a late stop races with an ASR/server
  // disconnect and the local recorder is already idle.
  const wasActive = hasMicCaptureIntent()
  const ownerGateway = mic.gateway
  const ownerSessionId = mic.sessionId
  const cancelPendingDraft = mic.cancelPendingDraft

  mic.generation += 1
  mic.rearmPending = false
  mic.cancelPendingDraft = null
  mic.recording = false
  mic.gateway = null
  mic.sessionId = ''
  $mmMicState.set('idle')
  _releaseMicResources()
  cancelPendingDraft?.()
  clearAsrPreview()
  clearMicPreRoll()

  if (!wasActive) {
    return
  }

  if (ownerGateway && ownerSessionId) {
    void ownerGateway
      .request('multimodal.asr_stop', {
        session_id: ownerSessionId
      })
      .catch(() => undefined)
  }

  // ★ 麦关 → 强制关对话模式 (对话模式必须有活麦, 否则相当于哑火, 对齐 web)。
  //   只在真的处于开态时下发 RPC + set atom, 不做多余调用。不动 $mmTtsEnabled
  //   (喇叭按钮态由用户自己控制; 对话态清掉后后端 is_speaker_on 自然回落到 _mm_tts_on)。
  if ($mmVoiceDialogEnabled.get()) {
    $mmVoiceDialogEnabled.set(false)

    if (ownerGateway && ownerSessionId) {
      void ownerGateway
        .request('multimodal.voice_dialog_toggle', {
          session_id: ownerSessionId,
          enabled: false
        })
        .catch(() => undefined)
    }
  }
}

export function onAsrPartial(text: string): void {
  $mmAsrPartial.set(text || '')
}

export function onAsrBuffer(segments: unknown): void {
  const next = Array.isArray(segments)
    ? segments.filter((segment): segment is string => typeof segment === 'string' && Boolean(segment.trim()))
    : []

  $mmAsrBuffer.set(next)
}
export function onAsrFinal(text: string): void {
  const t = (text || '').trim()

  if (t) {
    addVoiceUserMessage(t)
  }

  clearAsrPreview()
}

// ── TTS playback (WebAudio gapless) ─────────────────────────────────────────
interface TtsRefs {
  ctx: AudioContext | null
  currentRid: string
  nextStart: number
  active: AudioBufferSourceNode[]
  cancelled: Set<string>
}
const tts: TtsRefs = { ctx: null, currentRid: '', nextStart: 0, active: [], cancelled: new Set() }

// ── Barge-in / self-hear guard ──────────────────────────────────────────────
// On a laptop with SPEAKER output, the mic re-captures the TTS the assistant is
// playing and feeds it back into ASR (echo/loop). Browser echoCancellation
// alone doesn't fully suppress loud speaker playback. So while TTS is audible we
// DROP the mic's PCM instead of sending it to ASR. `ttsMuteUntil` is a monotone
// deadline (epoch ms): each scheduled chunk pushes it to the chunk's playback
// end + a short tail (AEC/speaker decay lingers a bit past the last sample).
const TTS_MIC_TAIL_MS = 300
let ttsMuteUntil = 0
/** True while TTS is playing (or within the post-playback tail) → mute the mic. */
function micGatedForTts(): boolean {
  return Date.now() < ttsMuteUntil
}

function ensureTtsCtx(): AudioContext {
  if (!tts.ctx) {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    tts.ctx = new Ctx()
  }
  // Autoplay policy can leave the context 'suspended' until a user gesture; the
  // first TTS chunk would then play silently. Resume best-effort (mirrors web).
  if (tts.ctx.state === 'suspended') void tts.ctx.resume().catch(() => undefined)
  return tts.ctx
}

export interface TtsChunk {
  response_id?: string
  pcm_b64?: string
  sample_rate?: number
  is_final?: boolean
}

export function onTtsChunk(msg: TtsChunk): void {
  const rid = msg.response_id || ''
  // ★ Barge-in sentinel: 后端 interrupt_tts 发 rid="__interrupt__" + is_final=true 通知
  //   前端立即停播。之前只按 rid 匹配, 这个 sentinel 匹配不上任何当前 rid → 忽略, 用户
  //   已收到的 PCM 继续在 WebAudio 里播完 = "打断没效果"。识别它 → 全停。
  if (rid === '__interrupt__') {
    stopAllTts()
    return
  }
  if (tts.cancelled.has(rid)) return
  if (msg.is_final) {
    if (tts.currentRid === rid) $mmTtsPlaying.set(false)
    return
  }
  if (!msg.pcm_b64) return
  const ctx = ensureTtsCtx()
  if (tts.currentRid !== rid) {
    for (const s of tts.active) {
      try {
        s.stop()
      } catch {
        /* noop */
      }
    }
    tts.active = []
    tts.currentRid = rid
    tts.nextStart = ctx.currentTime
    $mmTtsPlaying.set(true)
  }
  try {
    const bytes = base64ToBytes(msg.pcm_b64)
    // PCM16 = 2 bytes/sample; drop a trailing odd byte so a truncated chunk
    // degrades to a tiny gap instead of a RangeError.
    const evenLen = bytes.byteLength & ~1
    const i16 = new Int16Array(bytes.buffer, 0, evenLen >> 1)
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768.0
    const sr = msg.sample_rate || 24000
    const buf = ctx.createBuffer(1, f32.length, sr)
    buf.copyToChannel(f32, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime, tts.nextStart)
    src.start(startAt)
    tts.active.push(src)
    tts.nextStart = startAt + buf.duration
    // Mute the mic through this chunk's playback (converting AudioContext time to
    // wall-clock) + a short tail, so speaker output isn't re-captured into ASR.
    const playoutMs = Math.max(0, tts.nextStart - ctx.currentTime) * 1000
    ttsMuteUntil = Math.max(ttsMuteUntil, Date.now() + playoutMs + TTS_MIC_TAIL_MS)
    src.onended = () => {
      const i = tts.active.indexOf(src)
      if (i >= 0) tts.active.splice(i, 1)
    }
  } catch {
    /* drop chunk */
  }
}

/** Stop all TTS playback; cancel the current rid so late chunks are ignored. */
export function stopAllTts(): void {
  if (tts.currentRid) {
    tts.cancelled.add(tts.currentRid)
    // Cap the cancelled-rid set: a long background session (monitors / deep
    // analysis produce many rids) would otherwise grow it unbounded.
    if (tts.cancelled.size > 64) {
      tts.cancelled = new Set(Array.from(tts.cancelled).slice(-32))
    }
  }
  for (const s of tts.active) {
    try {
      s.stop()
    } catch {
      /* noop */
    }
  }
  tts.active = []
  tts.currentRid = ''
  if (tts.ctx) tts.nextStart = tts.ctx.currentTime
  // Playback stopped early → lift the mic mute now (keep only a short tail for
  // the speaker/AEC decay) so the user can talk again immediately.
  ttsMuteUntil = Math.min(ttsMuteUntil, Date.now() + TTS_MIC_TAIL_MS)
  $mmTtsPlaying.set(false)
}

/** Ask the server to speak `text` (multimodal.tts_speak → streams tts chunks).
 *
 * ★ Manual play PREEMPTS any in-flight auto/streaming TTS: stopAllTts() first
 *   stops the currently-audible sources AND cancels the old rid so its remaining
 *   server chunks (already in flight) are dropped by onTtsChunk and never
 *   resume — no double audio, and the preempted auto-speech does not continue
 *   after the manual one finishes. */
export function speakText(text: string): void {
  const t = (text || '').trim()
  const gw = $gateway.get()
  const sid = $mmSessionId.get()
  if (!t || !gw || !sid) return
  stopAllTts()
  void gw.request('multimodal.tts_speak', { session_id: sid, text: t }).catch(() => undefined)
}

/** 切换自动播报开关 (对齐 web): 通知后端 VoiceAgent 旁路开/关。关闭时顺带停掉在播的 TTS。 */
export function toggleMultimodalTts(): void {
  const next = !$mmTtsEnabled.get()
  $mmTtsEnabled.set(next)
  if (!next) stopAllTts()
  const gw = $gateway.get()
  const sid = $mmSessionId.get()
  if (gw && sid) {
    void gw.request('multimodal.tts_toggle', { session_id: sid, enabled: next }).catch(() => undefined)
  }
}

/** ★ 切换对话模式 (对齐 web MultimodalChatPage.toggleVoiceDialog) = 后台统一接管麦/喇叭:
 *    用户方案: UI 麦/喇叭按钮态保持不变, 仅后台联动。
 *    - ON  → ①通知后端 voice_dialog_toggle (后端 is_speaker_on OR 对话态 → 强制 TTS;
 *            ASR final 走 v2 分诊) ②物理开麦 (idle 时 startMic; getUserMedia 采集是唯一
 *            能真正识别的途径, 后端无法凭空开麦; 麦按钮随之自然变红反映真实录音态)。
 *    - OFF → ①通知后端 ②物理关麦 → 一切恢复各自 _mm_asr_on/_mm_tts_on 真实态。
 *    不动 $mmTtsEnabled atom (喇叭按钮态不变; TTS 由后端强制)。stopMic 里有"关麦→
 *    强制关对话"的反向联动, 幂等安全。
 */
export function toggleMultimodalVoiceDialog(): void {
  const next = !$mmVoiceDialogEnabled.get()
  $mmVoiceDialogEnabled.set(next)
  const gw = $gateway.get()
  const sid = $mmSessionId.get()
  if (gw && sid) {
    void gw.request('multimodal.voice_dialog_toggle', { session_id: sid, enabled: next }).catch(() => undefined)
  }
  // 麦克风物理联动 (TTS 由后端强制, 不动 UI atom)。
  if (next) {
    if ($mmMicState.get() === 'idle') void startMic().catch(() => undefined)
  } else if (hasMicCaptureIntent()) {
    void stopMic().catch(() => undefined)
  }
}

// ── Env audio (screen-share audio → 5s MediaRecorder slices) ────────────────
interface EnvRefs {
  stream: MediaStream | null
  recorder: MediaRecorder | null
  ctx: AudioContext | null
  source: MediaStreamAudioSourceNode | null
  node: AudioWorkletNode | null
  mime: string
  stop: boolean
  timer: ReturnType<typeof setTimeout> | null
  windowSec: number
  startTs: number
  generation: number
  ownerGateway: ReturnType<typeof $gateway.get>
  ownerSessionId: string
  captureId: string
  chunkSeq: number
  lastError: string
  mode: 'idle' | 'media_recorder' | 'pcm_starting' | 'pcm_worklet'
  pcmChunks: ArrayBuffer[]
  pcmBytes: number
  pcmWindowStartedAt: number
}
const env: EnvRefs = {
  stream: null,
  recorder: null,
  ctx: null,
  source: null,
  node: null,
  mime: 'audio/webm',
  stop: false,
  timer: null,
  windowSec: 5,
  startTs: 0,
  generation: 0,
  ownerGateway: null,
  ownerSessionId: '',
  captureId: '',
  chunkSeq: 0,
  lastError: '',
  mode: 'idle',
  pcmChunks: [],
  pcmBytes: 0,
  pcmWindowStartedAt: 0
}

function envRecorderMimeCandidates(): Array<string | null> {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  if (typeof MediaRecorder === 'undefined') {
    return [null]
  }
  const supported = candidates.filter(m => MediaRecorder.isTypeSupported?.(m))

  return supported.length > 0
    ? [
        supported[0],
        // Chromium occasionally accepts a MIME at construction time but its
        // encoder rejects it in start(). Let Chromium choose its native default
        // before falling back to raw PCM.
        null,
        ...supported.slice(1)
      ]
    : [null]
}

function newEnvCaptureId(generation: number): string {
  const randomId = globalThis.crypto?.randomUUID?.()

  return `cap_${randomId || `${Date.now().toString(36)}_${generation}`}`
}

function ownsEnvCapture(
  generation: number,
  captureId: string,
  ownerGateway: ReturnType<typeof $gateway.get>,
  ownerSessionId: string
): boolean {
  return Boolean(
    !env.stop &&
    env.generation === generation &&
    env.captureId === captureId &&
    env.ownerGateway === ownerGateway &&
    env.ownerSessionId === ownerSessionId &&
    ownerGateway &&
    ownerSessionId &&
    $gateway.get() === ownerGateway &&
    $mmSessionId.get() === ownerSessionId
  )
}

function reportEnvError(
  generation: number,
  captureId: string,
  ownerGateway: ReturnType<typeof $gateway.get>,
  ownerSessionId: string,
  key: string,
  text: string
): void {
  if (!ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
    return
  }
  if (env.lastError === key) {
    return
  }

  env.lastError = key
  // Keep the voice module's eager dependency graph small: multimodal-deep
  // already imports the main multimodal store, which in turn imports this
  // module. Resolve the toast action only on an actual error and re-check
  // ownership after the async module boundary so an old capture cannot flash
  // an error in the replacement session.
  void import('./multimodal-deep')
    .then(({ pushMmToast }) => {
      if (!ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
        return
      }
      if (env.lastError !== key) {
        return
      }

      pushMmToast({ level: 'error', text })
    })
    .catch(() => undefined)
}

/** Start env-audio capture from a screen-share stream's audio tracks (if any). */
export function startEnvAudio(stream: MediaStream): void {
  const tracks = stream.getAudioTracks()
  if (tracks.length === 0) {
    return
  }

  stopEnvAudio()
  env.generation += 1
  // Record from owned clones, matching the known-good macOS/Electron path.
  // Keeping the native loopback tracks out of the recorder lifecycle prevents
  // MediaRecorder retries and stop/start slicing from disturbing the screen
  // share itself. stopEnvAudio() owns and stops only these clones; stopCapture()
  // remains the sole owner of the original display-media tracks.
  env.stream = new MediaStream(tracks.map(track => track.clone()))
  env.mime = 'audio/webm'
  env.stop = false
  env.startTs = performance.now()
  env.ownerGateway = $gateway.get()
  env.ownerSessionId = $mmSessionId.get()
  env.captureId = newEnvCaptureId(env.generation)
  env.chunkSeq = 0
  env.lastError = ''
  env.mode = 'idle'
  env.pcmChunks = []
  env.pcmBytes = 0
  env.pcmWindowStartedAt = 0
  cycleEnvRecorder()
}

function cycleEnvRecorder(): void {
  if (env.stop || !env.stream) {
    return
  }

  const generation = env.generation
  const ownerGateway = env.ownerGateway
  const ownerSessionId = env.ownerSessionId
  const captureId = env.captureId
  const captureStartTs = env.startTs
  const failures: string[] = []

  for (const requestedMime of envRecorderMimeCandidates()) {
    let rec: MediaRecorder
    try {
      rec = requestedMime ? new MediaRecorder(env.stream, { mimeType: requestedMime }) : new MediaRecorder(env.stream)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${requestedMime || 'browser-default'} construct: ${reason}`)
      continue
    }

    if (
      startEnvMediaRecorder(
        rec,
        requestedMime || rec.mimeType || 'audio/webm',
        generation,
        captureId,
        ownerGateway,
        ownerSessionId,
        captureStartTs
      )
    ) {
      return
    }

    const reason = env.lastError || 'MediaRecorder.start() failed'
    failures.push(`${requestedMime || 'browser-default'} start: ${reason}`)
    // A failed candidate is diagnostic-only. Do not expose it as the active
    // error when the next codec or PCM fallback can keep ASR working.
    env.lastError = ''
  }

  startEnvPcmFallback(generation, captureId, ownerGateway, ownerSessionId, failures)
}

function startEnvMediaRecorder(
  rec: MediaRecorder,
  requestedMime: string,
  generation: number,
  captureId: string,
  ownerGateway: ReturnType<typeof $gateway.get>,
  ownerSessionId: string,
  captureStartTs: number
): boolean {
  env.recorder = rec
  let chunkSeq = 0
  let chunkId = ''
  const chunkStartedAt = performance.now()
  const chunks: Blob[] = []
  let blobTimecode = 0
  let chunkStoppedAt: number | null = null
  let recorderFailed = false
  rec.ondataavailable = ev => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data)
    }
    if (Number.isFinite(ev.timecode)) {
      blobTimecode = ev.timecode
    }
  }
  rec.onstop = () => {
    if (env.recorder === rec) {
      env.recorder = null
    }

    if (recorderFailed) {
      return
    }

    const chunkEndedAt = chunkStoppedAt ?? performance.now()
    if (ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
      cycleEnvRecorder()
    }
    // stopEnvAudio is a hard session/source ownership boundary. Discard the
    // recorder's trailing slice rather than letting its async base64 encode
    // finish after the UI has already rebound to another conversation.
    if (!ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
      return
    }
    if (chunks.length === 0) {
      return
    }

    const payloadMime = chunks[0]?.type || rec.mimeType || requestedMime
    const blob = chunks.length === 1 ? chunks[0] : new Blob(chunks, { type: payloadMime })
    const clientStartTs = Math.max(0, (chunkStartedAt - captureStartTs) / 1000)
    const clientEndTs = Math.max(clientStartTs, (chunkEndedAt - captureStartTs) / 1000)
    const clientDurationSec = Math.max(0, (chunkEndedAt - chunkStartedAt) / 1000)

    submitEnvAudioBlob(blob, {
      generation,
      captureId,
      ownerGateway,
      ownerSessionId,
      payloadMime,
      chunkId,
      chunkSeq,
      clientStartTs,
      clientEndTs,
      clientDurationSec,
      blobTimecode
    })
  }
  rec.onerror = event => {
    if (!ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
      return
    }

    recorderFailed = true
    if (env.timer) {
      clearTimeout(env.timer)
      env.timer = null
    }
    if (env.recorder === rec) {
      env.recorder = null
    }
    const reason = event.error?.message || 'MediaRecorder runtime error'

    startEnvPcmFallback(generation, captureId, ownerGateway, ownerSessionId, [`${requestedMime} runtime: ${reason}`])
  }
  try {
    rec.start()
  } catch (error) {
    recorderFailed = true
    if (env.recorder === rec) {
      env.recorder = null
    }

    const reason = error instanceof Error ? error.message : String(error)
    env.lastError = reason
    rec.ondataavailable = null
    rec.onstop = null
    rec.onerror = null

    return false
  }
  chunkSeq = ++env.chunkSeq
  chunkId = `${captureId}:${chunkSeq}`
  env.mime = rec.mimeType || requestedMime
  env.mode = 'media_recorder'
  env.lastError = ''
  env.timer = setTimeout(
    () => {
      env.timer = null
      if (rec.state === 'recording') {
        chunkStoppedAt = performance.now()
        try {
          rec.stop()
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          reportEnvError(
            generation,
            captureId,
            ownerGateway,
            ownerSessionId,
            `stop:${reason}`,
            `共享音频切片失败: ${reason}`
          )
        }
      }
    },
    Math.max(1000, Math.round(env.windowSec * 1000))
  )

  return true
}

interface EnvAudioUpload {
  generation: number
  captureId: string
  ownerGateway: ReturnType<typeof $gateway.get>
  ownerSessionId: string
  payloadMime: string
  chunkId: string
  chunkSeq: number
  clientStartTs: number
  clientEndTs: number
  clientDurationSec: number
  blobTimecode: number
}

function submitEnvAudioBlob(blob: Blob, upload: EnvAudioUpload): void {
  if (blob.size < 1000) {
    return
  }

  void blobToBase64(blob)
    .then(b64 => {
      if (!ownsEnvCapture(upload.generation, upload.captureId, upload.ownerGateway, upload.ownerSessionId)) {
        return undefined
      }

      return upload.ownerGateway!.request<{ ingested?: boolean; reason?: string }>('multimodal.env_audio', {
        session_id: upload.ownerSessionId,
        data_b64: b64,
        mime: upload.payloadMime,
        window_ts: upload.clientStartTs,
        capture_id: upload.captureId,
        chunk_id: upload.chunkId,
        chunk_seq: upload.chunkSeq,
        client_start_ts: upload.clientStartTs,
        client_end_ts: upload.clientEndTs,
        client_duration_sec: upload.clientDurationSec,
        blob_timecode: upload.blobTimecode
      })
    })
    .then(result => {
      if (result === undefined) {
        return
      }
      if (!ownsEnvCapture(upload.generation, upload.captureId, upload.ownerGateway, upload.ownerSessionId)) {
        return
      }
      if (result?.ingested !== false) {
        env.lastError = ''

        return
      }

      const reason = result.reason || 'unknown'
      if (reason === 'too_short') {
        return
      }

      reportEnvError(
        upload.generation,
        upload.captureId,
        upload.ownerGateway,
        upload.ownerSessionId,
        reason,
        `共享音频 ASR 未接收: ${reason}`
      )
    })
    .catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      reportEnvError(
        upload.generation,
        upload.captureId,
        upload.ownerGateway,
        upload.ownerSessionId,
        reason,
        `共享音频 ASR 请求失败: ${reason}`
      )
    })
}

function pcm16WavBlob(chunks: ArrayBuffer[], byteLength: number): Blob {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 16_000 * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, byteLength, true)

  return new Blob([header, ...chunks], { type: 'audio/wav' })
}

function pcm16HasSignal(chunks: ArrayBuffer[]): boolean {
  for (const chunk of chunks) {
    const samples = new Int16Array(chunk)

    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i] !== 0) {
        return true
      }
    }
  }

  return false
}

function scheduleEnvPcmWindow(
  upload: Omit<
    EnvAudioUpload,
    'payloadMime' | 'chunkId' | 'chunkSeq' | 'clientStartTs' | 'clientEndTs' | 'clientDurationSec' | 'blobTimecode'
  >
): void {
  env.timer = setTimeout(
    () => {
      env.timer = null
      if (
        env.mode !== 'pcm_worklet' ||
        !ownsEnvCapture(upload.generation, upload.captureId, upload.ownerGateway, upload.ownerSessionId)
      ) {
        return
      }

      const endedAt = performance.now()
      const startedAt = env.pcmWindowStartedAt
      const chunks = env.pcmChunks
      const byteLength = env.pcmBytes

      env.pcmChunks = []
      env.pcmBytes = 0
      env.pcmWindowStartedAt = endedAt
      scheduleEnvPcmWindow(upload)

      if (byteLength < 1000) {
        return
      }

      // A live MediaStreamTrack can still be a dead CoreAudio tap whose PCM is
      // entirely zero. Uploading that valid-looking WAV makes ASR hallucinate
      // fillers such as "嗯。" and hides the real capture failure. Reject exact
      // digital silence locally and surface a stable, actionable diagnostic.
      if (!pcm16HasSignal(chunks)) {
        reportEnvError(
          upload.generation,
          upload.captureId,
          upload.ownerGateway,
          upload.ownerSessionId,
          'capture:silent_pcm',
          '共享音频没有收到有效采样，请检查 macOS“屏幕与系统音频录制”权限，然后停止并重新共享屏幕。'
        )

        return
      }

      const chunkSeq = ++env.chunkSeq
      submitEnvAudioBlob(pcm16WavBlob(chunks, byteLength), {
        ...upload,
        payloadMime: 'audio/wav',
        chunkId: `${upload.captureId}:${chunkSeq}`,
        chunkSeq,
        clientStartTs: Math.max(0, (startedAt - env.startTs) / 1000),
        clientEndTs: Math.max(0, (endedAt - env.startTs) / 1000),
        clientDurationSec: Math.max(0, (endedAt - startedAt) / 1000),
        blobTimecode: 0
      })
    },
    Math.max(1000, Math.round(env.windowSec * 1000))
  )
}

function startEnvPcmFallback(
  generation: number,
  captureId: string,
  ownerGateway: ReturnType<typeof $gateway.get>,
  ownerSessionId: string,
  recorderFailures: string[]
): void {
  if (
    env.mode === 'pcm_starting' ||
    env.mode === 'pcm_worklet' ||
    !env.stream ||
    !ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)
  ) {
    return
  }

  env.mode = 'pcm_starting'
  console.warn(`[multimodal] MediaRecorder unavailable; falling back to PCM/WAV: ${recorderFailures.join(' | ')}`)

  const fallbackStream = env.stream
  void (async () => {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) {
      throw new Error('AudioContext unavailable')
    }

    const ctx = new Ctx()
    let source: MediaStreamAudioSourceNode | null = null
    let node: AudioWorkletNode | null = null
    const releaseLocal = () => {
      if (node) {
        node.port.onmessage = null
        node.port.close()
        node.disconnect()
      }
      source?.disconnect()
      void ctx.close().catch(() => undefined)
    }

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL)
      if (env.stream !== fallbackStream || !ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
        releaseLocal()
        return
      }

      source = ctx.createMediaStreamSource(fallbackStream)
      node = new AudioWorkletNode(ctx, 'pcm-downsample-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { inRate: ctx.sampleRate, batchMs: 200 }
      })
      node.port.onmessage = (event: MessageEvent) => {
        if (env.mode !== 'pcm_worklet' || !ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
          return
        }
        const pcm = event.data as ArrayBuffer
        if (!pcm?.byteLength) {
          return
        }
        env.pcmChunks.push(pcm)
        env.pcmBytes += pcm.byteLength
      }
      source.connect(node)
      node.connect(ctx.destination)
      await ctx.resume()

      if (env.stream !== fallbackStream || !ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
        releaseLocal()
        return
      }

      env.ctx = ctx
      env.source = source
      env.node = node
      env.mime = 'audio/wav'
      env.mode = 'pcm_worklet'
      env.pcmChunks = []
      env.pcmBytes = 0
      env.pcmWindowStartedAt = performance.now()
      env.lastError = ''
      scheduleEnvPcmWindow({
        generation,
        captureId,
        ownerGateway,
        ownerSessionId
      })
    } catch (error) {
      releaseLocal()
      throw error
    }
  })().catch(error => {
    if (!ownsEnvCapture(generation, captureId, ownerGateway, ownerSessionId)) {
      return
    }
    env.mode = 'idle'
    const fallbackReason = error instanceof Error ? error.message : String(error)
    const detail = [...recorderFailures, `PCM fallback: ${fallbackReason}`].join(' | ')
    reportEnvError(
      generation,
      captureId,
      ownerGateway,
      ownerSessionId,
      `capture:${detail}`,
      `共享音频录制启动失败: ${detail}`
    )
  })
}

export function stopEnvAudio(): void {
  env.generation += 1
  env.stop = true
  if (env.timer) {
    clearTimeout(env.timer)
    env.timer = null
  }
  if (env.recorder && env.recorder.state === 'recording') {
    try {
      env.recorder.stop()
    } catch {
      /* noop */
    }
  }
  if (env.node) {
    try {
      env.node.port.onmessage = null
      env.node.port.close()
      env.node.disconnect()
    } catch {
      /* noop */
    }
  }

  if (env.source) {
    try {
      env.source.disconnect()
    } catch {
      /* noop */
    }
  }

  if (env.ctx) {
    void env.ctx.close().catch(() => undefined)
  }

  // env.stream contains recorder-owned clones, never the original screen-share
  // tracks. Release them here so repeated sharing cannot leak native captures.
  if (env.stream) {
    env.stream.getTracks().forEach(track => {
      try {
        track.stop()
      } catch {
        /* noop */
      }
    })
  }
  env.recorder = null
  env.stream = null
  env.ctx = null
  env.source = null
  env.node = null
  env.ownerGateway = null
  env.ownerSessionId = ''
  env.captureId = ''
  env.chunkSeq = 0
  env.lastError = ''
  env.mode = 'idle'
  env.pcmChunks = []
  env.pcmBytes = 0
  env.pcmWindowStartedAt = 0
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result || '')
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}
