import { useMemo, useState } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import {
  buildQueryWorkerTimelines,
  type QueryWorkerEvidenceSegment,
  type QueryWorkerTimeline,
  type QueryWorkerTimelineStep,
  type QueryWorkerToolCall,
  type QueryWorkerToolResult
} from './query-worker-trajectory'
import type { MmTrajectoryEntry, MmTrajectoryFrame } from './trajectory-grouping'

interface QueryWorkerTrajectoryPanelProps {
  entries: MmTrajectoryEntry[]
}

function debugJson(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const HIDDEN_REASONING_KEYS = new Set([
  'analysis',
  'chain_of_thought',
  'internal_reasoning',
  'raw_output',
  'raw_thinking',
  'reasoning',
  'reasoning_content',
  'router_thinking',
  'thought'
])

const RAW_IMAGE_KEYS = new Set(['image_b64', 'jpeg_b64', 'thumb_b64'])

function redactUrlUserinfo(value: string): string {
  return value.replace(/\b(https?:\/\/)([^\s/@]+)@/gi, (_match, scheme: string, userinfo: string) => {
    const separator = userinfo.indexOf(':')

    return separator >= 0
      ? `${scheme}${userinfo.slice(0, separator)}:***@`
      : `${scheme}***@`
  })
}

/** Trajectory payloads are already secret-redacted by the gateway. Apply a
 * second, UI-specific boundary for private model reasoning: the inspector may
 * show actions, arguments, observations and evidence, but never hidden CoT. */
export function publicQueryWorkerTracePayload(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '<max-depth>'
  }

  if (typeof value === 'string') {
    return redactUrlUserinfo(value)
  }

  if (Array.isArray(value)) {
    return value.map(item => publicQueryWorkerTracePayload(item, depth + 1))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      HIDDEN_REASONING_KEYS.has(key.toLowerCase())
        ? '<hidden internal reasoning>'
        : RAW_IMAGE_KEYS.has(key.toLowerCase()) && typeof item === 'string'
          ? `<image rendered above; ${item.length} chars>`
          : publicQueryWorkerTracePayload(item, depth + 1)
    ])
  )
}

function formatTraceTime(seconds: unknown): string {
  const value = Number(seconds)

  if (!Number.isFinite(value) || value < 0) {
    return ''
  }

  const tenths = Math.round(value * 10)
  const whole = Math.floor(tenths / 10)
  const minutes = Math.floor(whole / 60)
  const second = whole % 60
  const fraction = tenths % 10 ? `.${tenths % 10}` : ''

  return `${String(minutes).padStart(2, '0')}:${String(second).padStart(2, '0')}${fraction}`
}

function argsPreview(args?: Record<string, unknown>): string {
  if (!args) {
    return ''
  }

  const preferred = args.query ?? args.brief ?? args.entity_id ?? args.frame_id ?? args.target

  return String(typeof preferred === 'string' ? preferred : JSON.stringify(args)).replace(/\s+/g, ' ').slice(0, 180)
}

function safeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return ''
    }

    if (parsed.password) {
      parsed.password = '***'
    } else if (parsed.username) {
      parsed.username = '***'
    }

    return parsed.href
  } catch {
    return ''
  }
}

function evidenceLabel(segment: QueryWorkerEvidenceSegment): string {
  const start = formatTraceTime(segment.tStart)
  const end = formatTraceTime(segment.tEnd)
  const range = start && end && start !== end ? `${start}–${end}` : start

  return `${segment.kind || '记忆'}${range ? ` ${range}` : ''}`
}

function ToolCallCard({ call, state }: { call: QueryWorkerToolCall; state?: 'called' | 'planned' }) {
  return (
    <details
      className="rounded border border-cyan-400/20 bg-black/10 px-2 py-1"
      open={state === 'called'}
    >
      <summary className="cursor-pointer list-none break-words text-(--ui-text-secondary)">
        <span className="font-medium text-cyan-300">{call.name}</span>
        {call.args && <span className="text-(--ui-text-tertiary)"> · {argsPreview(call.args)}</span>}
        {call.anchor && (
          <span className="text-(--ui-text-tertiary)">
            {' '}· anchor={call.anchor}{call.anchorTs !== undefined ? ` @${formatTraceTime(call.anchorTs)}` : ''}
          </span>
        )}
      </summary>
      {call.args && (
        <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[0.625rem]">
          {debugJson(call.args)}
        </pre>
      )}
    </details>
  )
}

function ToolResultCard({ result }: { result: QueryWorkerToolResult }) {
  const sourceUrls = result.sourceUrls.map(safeSourceUrl).filter(Boolean)

  return (
    <details className="rounded border border-emerald-400/20 bg-emerald-400/5 px-2 py-1" open>
      <summary className="cursor-pointer list-none break-words text-(--ui-text-secondary)">
        <span className="font-medium text-emerald-400">{result.name}</span>
        {result.args && <span className="text-(--ui-text-tertiary)"> · {argsPreview(result.args)}</span>}
        {result.obsLength !== undefined && <span className="text-(--ui-text-tertiary)"> · {result.obsLength} 字</span>}
        {result.elapsedSec !== undefined && (
          <span className="text-(--ui-text-tertiary)"> · {result.elapsedSec.toFixed(2)}s</span>
        )}
        {result.frameIds.length > 0 && (
          <span className="text-(--ui-text-tertiary)"> · {result.frameIds.length} 帧</span>
        )}
        {result.cacheHit && <span className="text-amber-300"> · cache hit</span>}
      </summary>
      {result.args && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[0.625rem]">
          {debugJson(result.args)}
        </pre>
      )}
      {result.summary && (
        <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[0.625rem] text-(--ui-text-secondary)">
          {result.summary}
        </pre>
      )}
      {result.frameIds.length > 0 && (
        <div className="mt-1 break-all font-mono text-[0.5625rem] text-(--ui-text-tertiary)">
          frame_ids: {result.frameIds.join(', ')}
        </div>
      )}
      {result.evidenceSegments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {result.evidenceSegments.map((segment, index) => (
            <span
              className="rounded border border-amber-300/20 bg-amber-300/5 px-1.5 py-0.5 font-mono text-[0.5625rem] text-amber-200"
              key={`${evidenceLabel(segment)}-${index}`}
              title={segment.preview || evidenceLabel(segment)}
            >
              {evidenceLabel(segment)}{segment.frameIds.length ? ` · ${segment.frameIds.length}帧` : ''}
            </span>
          ))}
        </div>
      )}
      {sourceUrls.length > 0 && (
        <div className="mt-1 space-y-0.5 text-[0.5625rem]">
          {sourceUrls.map(url => (
            <a
              className="block truncate text-cyan-300 hover:underline"
              href={url}
              key={url}
              rel="noreferrer"
              target="_blank"
            >
              {url}
            </a>
          ))}
        </div>
      )}
    </details>
  )
}

function OcrEvidence({ step }: { step: QueryWorkerTimelineStep }) {
  const emptyMessage = step.ocrState === 'skipped'
    ? `已跳过 OCR${step.ocrReason ? `：${step.ocrReason}` : ''}。`
    : step.ocrState === 'timeout'
      ? 'OCR 超时；QueryWorker 已继续使用原始画面。'
      : step.ocrState === 'error'
        ? `OCR 提取失败${step.ocrReason ? `：${step.ocrReason}` : ''}；QueryWorker 已继续使用原始画面。`
        : 'OCR 已完成，但没有识别到可用文字。'

  return (
    <details className="mt-1.5 rounded border border-sky-300/20 bg-sky-300/5 px-2 py-1.5" open>
      <summary className="cursor-pointer list-none font-medium text-sky-300">
        OCR 辅助文字 · {step.ocrRecordCount ?? step.ocrRecords.length}
        {step.ocrElapsedSec !== undefined && ` · ${step.ocrElapsedSec.toFixed(2)}s`}
      </summary>
      {step.ocrRecords.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {step.ocrRecords.map((record, index) => (
            <div
              className="rounded border border-sky-300/15 bg-black/15 p-1.5"
              key={`${record.frameTs ?? 'unknown'}-${record.evidenceSource || 'ocr'}-${index}`}
            >
              <div className="flex flex-wrap gap-1 text-[0.5625rem] text-sky-200">
                <span>{record.frameTs !== undefined ? formatTraceTime(record.frameTs) : '时间未知'}</span>
                {record.sourceType && <span>· {record.sourceType}</span>}
                {record.evidenceSource && <span>· {record.evidenceSource}</span>}
                {(record.app || record.windowTitle) && <span>· {[record.app, record.windowTitle].filter(Boolean).join(' / ')}</span>}
              </div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[0.625rem]">
                {record.rawText || '（该帧未识别到文字）'}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[0.625rem] text-(--ui-text-tertiary)">
          {emptyMessage}
        </div>
      )}
    </details>
  )
}

function FrameGrid({ askTime, frames }: { askTime: boolean; frames: MmTrajectoryFrame[] }) {
  const [selected, setSelected] = useState<{ label: string; src: string } | null>(null)

  return (
    <>
      <div className="mt-1.5">
        <div className="mb-1 text-cyan-300">
          {askTime ? '提问时刻冻结输入帧（QueryWorker 实际看到）' : 'Recall 证据帧'}
        </div>
        <div className={askTime ? 'grid grid-cols-1 gap-1 sm:grid-cols-3' : 'grid grid-cols-2 gap-1 sm:grid-cols-4'}>
          {frames.slice(0, 12).map((frame, index) => {
            const b64 = frame.thumb_b64 || frame.jpeg_b64 || ''
            const usable = Boolean(b64) && !b64.startsWith('<omitted')
            const src = usable ? `data:image/jpeg;base64,${b64}` : ''
            const label = frame.frame_id || `${askTime ? '输入帧' : 'frame'} ${index + 1}`

            return (
              <figure
                className="overflow-hidden rounded border border-cyan-400/20 bg-black/20"
                key={`${frame.frame_id || frame.ts || index}-${index}`}
              >
                {usable ? (
                  <button
                    className="block w-full cursor-zoom-in"
                    onClick={() => setSelected({ label, src })}
                    title="点击放大查看"
                    type="button"
                  >
                    <img alt={label} className="h-24 w-full object-contain" src={src} />
                  </button>
                ) : (
                  <div className="grid h-24 place-items-center text-[0.5625rem] text-(--ui-text-tertiary)">
                    thumbnail omitted
                  </div>
                )}
                <figcaption className="px-1 py-0.5 font-mono text-[0.5625rem] text-cyan-300">
                  <div className="truncate">{label}</div>
                  <div className="truncate text-(--ui-text-tertiary)">
                    {frame.ts !== undefined ? formatTraceTime(frame.ts) : 'ts unknown'}
                    {frame.source_type ? ` · ${frame.source_type}` : ' · source unknown'}
                  </div>
                </figcaption>
              </figure>
            )
          })}
        </div>
      </div>
      <Dialog onOpenChange={open => !open && setSelected(null)} open={Boolean(selected)}>
        <DialogContent className="max-w-[92vw] sm:max-w-[92vw]">
          <DialogHeader>
            <DialogTitle>{selected?.label || '证据帧'}</DialogTitle>
          </DialogHeader>
          {selected && <img alt={selected.label} className="max-h-[78vh] w-full object-contain" src={selected.src} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function TimelineStep({ step }: { step: QueryWorkerTimelineStep }) {
  const askTimeFrames = step.phase.startsWith('started:')

  return (
    <div className="relative rounded bg-(--ui-bg-elevated) px-2 py-1.5" data-query-worker-seq={step.seq}>
      <span
        className={`absolute -left-[0.8125rem] top-2.5 size-1.5 rounded-full ${
          step.status === 'error' ? 'bg-red-400' : step.status === 'complete' ? 'bg-emerald-400' : 'bg-cyan-400'
        }`}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-medium text-cyan-300">{step.worker}</span>
        <span className="min-w-0 flex-1 break-words text-(--ui-text-primary)">{step.title}</span>
        {step.taskRef && <span className="font-mono text-[0.5625rem] text-cyan-300">{step.taskRef}</span>}
        <span className="font-mono text-[0.5625rem] text-(--ui-text-tertiary)">#{step.seq}</span>
      </div>
      {step.phase.startsWith('ocr_evidence:') && <OcrEvidence step={step} />}
      {step.detail && <div className="mt-1 whitespace-pre-wrap break-words text-(--ui-text-secondary)">{step.detail}</div>}
      {step.metrics.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {step.metrics.map((metric, index) => (
            <span
              className="rounded border border-cyan-400/20 px-1.5 py-0.5 font-mono text-[0.5625rem] text-cyan-300"
              key={`${metric}-${index}`}
            >
              {metric}
            </span>
          ))}
        </div>
      )}
      {step.toolCalls.length > 0 && (
        <div className="mt-1.5 space-y-1">
          <div className="text-cyan-300">{step.callState === 'called' ? '实际调用' : '计划调用'}</div>
          {step.toolCalls.map((call, index) => (
            <ToolCallCard call={call} key={`${call.name}-${index}`} state={step.callState} />
          ))}
        </div>
      )}
      {step.toolResults.length > 0 && (
        <div className="mt-1.5 space-y-1">
          <div className="text-emerald-400">工具返回</div>
          {step.toolResults.map((result, index) => (
            <ToolResultCard key={`${result.name}-${index}`} result={result} />
          ))}
        </div>
      )}
      {step.frames.length > 0 && <FrameGrid askTime={askTimeFrames} frames={step.frames} />}
      <details className="mt-1.5 rounded border border-(--ui-stroke-secondary) bg-black/10 px-2 py-1">
        <summary className="cursor-pointer list-none text-[0.625rem] text-(--ui-text-tertiary)">
          原始事件 · {step.raw.event} / {step.raw.phase}
        </summary>
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[0.625rem]">
          {debugJson(publicQueryWorkerTracePayload(step.raw.payload))}
        </pre>
      </details>
    </div>
  )
}

function Timeline({ timeline }: { timeline: QueryWorkerTimeline }) {
  return (
    <section
      className="rounded border border-cyan-400/30 bg-cyan-400/5 p-2 text-[0.6875rem]"
      data-query-worker-task={timeline.taskId}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-cyan-300">
        <span className={timeline.status === 'running' ? 'animate-spin' : ''}>
          {timeline.status === 'running' ? '◌' : timeline.status === 'complete' ? '✓' : '!'}
        </span>
        <span className="font-semibold">QueryWorker 完整轨迹</span>
        <span className="font-mono text-[0.625rem]">#{timeline.taskId}</span>
        <span className="ml-auto text-[0.625rem] text-(--ui-text-tertiary)">
          {timeline.status === 'running' ? '工作中' : timeline.status === 'complete' ? '已完成' : timeline.status}
        </span>
      </div>
      <div className="mt-1 text-[0.625rem] text-(--ui-text-tertiary)">
        结构化执行记录：冻结画面、OCR、计划/实际工具、证据与结果；不包含模型隐藏思维链。
      </div>
      <div className="mt-2 space-y-1.5 border-l border-cyan-400/25 pl-2">
        {timeline.steps.map(step => (
          <TimelineStep key={step.id || `seq:${step.seq}`} step={step} />
        ))}
      </div>
    </section>
  )
}

export function QueryWorkerTrajectoryPanel({ entries }: QueryWorkerTrajectoryPanelProps) {
  const timelines = useMemo(() => buildQueryWorkerTimelines(entries), [entries])

  if (timelines.length === 0) {
    return null
  }

  return (
    <div className="space-y-2" data-testid="query-worker-trajectory-panel">
      {timelines.map(timeline => (
        <Timeline key={timeline.taskId} timeline={timeline} />
      ))}
    </div>
  )
}
