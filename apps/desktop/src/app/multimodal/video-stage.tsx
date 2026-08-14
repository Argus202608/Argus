import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Bug, Eye, Monitor, Square } from '@/lib/icons'
import { $mmSessionId } from '@/store/multimodal'
import {
  $mmCapStats,
  $mmCaptureDebug,
  $mmSource,
  $mmStream,
  startCameraCapture,
  startScreenCapture,
  stopCaptureAndNotify
} from '@/store/multimodal-capture'
import { $selectedStoredSessionId, $sessions } from '@/store/session'

import { MemoryDebugPanel, resolveMemoryDebugSessionIds } from './memory-debug-panel'

/**
 * VideoStage — live camera/screen preview + capture controls for the multimodal
 * page's right rail (desktop port of the web MultimodalChatPage video card).
 *
 * Mirrors the module-scoped $mmStream into a local <video>. When no source is
 * active the stage shows an empty black frame with a "未开启画面" hint, matching
 * the web version. The capture pipeline itself runs headless in the store; this
 * <video> is purely a preview mirror.
 */
export function VideoStage() {
  const source = useStore($mmSource)
  const stream = useStore($mmStream)
  const capStats = useStore($mmCapStats)
  const captureDebug = useStore($mmCaptureDebug)
  const liveSessionId = useStore($mmSessionId)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const sessions = useStore($sessions)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [capError, setCapError] = useState('')
  const [memoryDebugOpen, setMemoryDebugOpen] = useState(false)

  const capturing = source !== 'none'

  const recording = capturing && (
    captureDebug.code === 'sending' || captureDebug.code === 'backpressure'
  )

  const capturePhaseLabel = captureDebug.code === 'gateway_not_open'
    ? '连接中断，记录已暂停'
    : '正在启动记录'

  const restoringStoredSession = Boolean(selectedStoredSessionId && !liveSessionId)

  const durableSessionIds = useMemo(
    () => resolveMemoryDebugSessionIds(selectedStoredSessionId, sessions, liveSessionId),
    [liveSessionId, selectedStoredSessionId, sessions]
  )

  // Mirror the live MediaStream into the preview <video>.
  useEffect(() => {
    const v = videoRef.current

    if (!v) {
      return
    }

    v.srcObject = stream

    if (stream) {
      void v.play().catch(() => undefined)
    }
  }, [stream])

  const startCam = async () => {
    setCapError('')

    try {
      await startCameraCapture()
    } catch (e) {
      setCapError(`摄像头开启失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const startScreen = async () => {
    setCapError('')

    try {
      await startScreenCapture()
    } catch (e) {
      setCapError(
        `屏幕共享开启失败：${e instanceof Error ? e.message : String(e)}（macOS 需在“系统设置 → 隐私与安全 → 屏幕录制”授权）`
      )
    }
  }

  return (
    // A card wrapper (mirrors web's <Card><CardContent p-3>) for a solid,
    // finished feel instead of a bare washed-out box.
    <div className="flex flex-col gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-3">
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-black [contain:strict]">
        <video
          autoPlay
          className="h-full w-full object-cover [transform:translateZ(0)]"
          muted
          playsInline
          ref={videoRef}
        />
        {!capturing ? (
          <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-white/90 backdrop-blur-sm">
            未开启画面
          </div>
        ) : recording ? (
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-white backdrop-blur-sm">
            <span className="size-2 animate-pulse rounded-full bg-red-500" />
            REC · {source === 'camera' ? '摄像头' : '屏幕'} · {capStats.sent} 帧
            {capStats.dropped > 0 ? `（丢 ${capStats.dropped}）` : ''}
          </div>
        ) : (
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-white backdrop-blur-sm">
            <span className="size-2 animate-pulse rounded-full bg-amber-400" />
            预览 · {source === 'camera' ? '摄像头' : '屏幕'} · {capturePhaseLabel}
          </div>
        )}
      </div>

      {!capturing ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={restoringStoredSession}
            onClick={() => void startCam()}
            size="sm"
            variant="secondary"
          >
            <Eye className="mr-1 size-3.5" /> 摄像头
          </Button>
          <Button
            disabled={restoringStoredSession}
            onClick={() => void startScreen()}
            size="sm"
            variant="secondary"
          >
            <Monitor className="mr-1 size-3.5" /> 屏幕共享
          </Button>
        </div>
      ) : (
        <Button onClick={() => stopCaptureAndNotify()} size="sm" variant="destructive">
          <Square className="mr-1 size-3.5" /> 停止{source === 'camera' ? '摄像头' : '屏幕共享'}
        </Button>
      )}
      {!capturing && restoringStoredSession && (
        <div className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-300">
          正在恢复当前会话，完成后可开启画面记录。
        </div>
      )}
      {capError && <div className="text-xs text-(--ui-red)">{capError}</div>}
      {capturing && (capStats.sent === 0 || captureDebug.code !== 'sending') && (
        <div className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-300">
          采集诊断：{captureDebug.detail}
        </div>
      )}
      <Button
        disabled={!liveSessionId && durableSessionIds.length === 0}
        onClick={() => setMemoryDebugOpen(true)}
        size="sm"
        variant="outline"
      >
        <Bug className="mr-1 size-3.5" /> Memory Debug
      </Button>
      <MemoryDebugPanel
        durableSessionIds={durableSessionIds}
        liveSessionId={liveSessionId}
        onOpenChange={setMemoryDebugOpen}
        open={memoryDebugOpen}
      />
    </div>
  )
}
