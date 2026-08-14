import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Mic, Send, Square, Volume2 } from '@/lib/icons'
import {
  $mmGenerating,
  interruptMultimodal,
  sendMultimodalPrompt
} from '@/store/multimodal'
import { $mmAsrBuffer, $mmAsrPartial, $mmMicState, $mmTtsEnabled, startMic, stopMic, toggleMultimodalTts } from '@/store/multimodal-voice'

/**
 * Slim composer for the multimodal page: a text field + mic / TTS toggles.
 * Intentionally NOT the heavy session-bound desktop composer — this page owns
 * its own session.
 *
 * Camera / screen capture controls live in VideoStage (right rail), not here.
 */
export function Composer() {
  const ttsEnabled = useStore($mmTtsEnabled)
  const micState = useStore($mmMicState)
  const asrPartial = useStore($mmAsrPartial)
  const asrBuffer = useStore($mmAsrBuffer)
  const generating = useStore($mmGenerating)
  const [capError, setCapError] = useState('')
  const [text, setText] = useState('')

  const toggleMic = () => {
    if (micState === 'recording' || micState === 'connecting') void stopMic()
    else {
      setCapError('')
      void startMic().catch(e => setCapError(`麦克风启动失败：${e instanceof Error ? e.message : String(e)}`))
    }
  }

  const submit = () => {
    if (generating) return // don't stack a new turn while one is streaming
    const t = text.trim()
    if (!t) return
    void sendMultimodalPrompt(t)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const recording = micState === 'recording'
  const connecting = micState === 'connecting'
  const bufferedAsr = asrBuffer.join(' ').trim()

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-2 shadow-sm">
      {/* Live ASR partial preview (above the field, like a caption). */}
      {(recording || asrPartial || bufferedAsr) && (
        <div className="flex items-center gap-2 px-1 text-xs text-(--ui-text-tertiary)">
          {recording && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-(--ui-red)" />}
          <span className="truncate">
            {bufferedAsr ? (
              <>
                <span className="opacity-60">{bufferedAsr}</span>
                {asrPartial ? <span className="ml-1">{asrPartial}</span> : null}
              </>
            ) : (
              asrPartial || '正在聆听…'
            )}
          </span>
        </div>
      )}

      {/* One-row control bar (web-aligned):
            LEFT  toggles: 语音(Mic) — solid when on, outline when off.
            MIDDLE: text field. RIGHT: Send ↔ Stop. */}
      <div className="flex items-center gap-1.5">
        {/* 语音: outline idle · destructive recording · spinner connecting. Runs
            module-scoped in the store, so it survives the window being hidden. */}
        <Button
          className="shrink-0"
          size="icon-sm"
          variant={recording ? 'destructive' : 'outline'}
          disabled={connecting}
          aria-pressed={recording}
          onClick={toggleMic}
          title={recording ? '点击结束录音' : connecting ? '正在连接语音…' : '点击开始说话（流式语音）'}
        >
          {connecting ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
        </Button>
        {/* 语音播报: solid when ON — 自动朗读主 agent / 深度分析的分析内容。 */}
        <Button
          className="shrink-0"
          size="icon-sm"
          variant={ttsEnabled ? 'default' : 'outline'}
          aria-pressed={ttsEnabled}
          onClick={toggleMultimodalTts}
          title={ttsEnabled ? '语音播报：开（自动朗读分析）— 点击关闭' : '语音播报：关 — 点击开启'}
        >
          <Volume2 className="size-4" />
        </Button>

        <Textarea
          className="max-h-24 min-h-8 flex-1 resize-none self-center border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="提问（开启画面后，画面会随问题一起发送）…"
          rows={1}
          value={text}
        />

        {/* Send ↔ Stop: while a turn streams, the primary button interrupts it. */}
        {generating ? (
          <Button className="shrink-0" size="sm" variant="destructive" onClick={() => void interruptMultimodal()} title="停止生成">
            <Square className="mr-1 size-3.5" /> 停止
          </Button>
        ) : (
          <Button className="shrink-0" size="sm" disabled={!text.trim()} onClick={submit}>
            <Send className="mr-1 size-3.5" /> 发送
          </Button>
        )}
      </div>

      {capError && <div className="px-1 text-xs text-(--ui-red)">{capError}</div>}
    </div>
  )
}
