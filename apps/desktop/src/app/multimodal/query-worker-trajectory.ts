import type { MmTrajectoryEntry, MmTrajectoryFrame } from './trajectory-grouping'

export type QueryWorkerStatus = 'cancelled' | 'complete' | 'error' | 'running'

export interface QueryWorkerToolCall {
  anchor?: string
  anchorTs?: number
  args?: Record<string, unknown>
  name: string
}

export interface QueryWorkerEvidenceSegment {
  frameIds: string[]
  kind?: string
  preview?: string
  tEnd?: number
  tStart?: number
}

export interface QueryWorkerToolResult extends QueryWorkerToolCall {
  cacheHit?: boolean
  elapsedSec?: number
  evidenceSegments: QueryWorkerEvidenceSegment[]
  frameIds: string[]
  obsLength?: number
  sourceUrls: string[]
  summary?: string
}

export interface QueryWorkerOcrRecord {
  app?: string
  evidenceSource?: string
  frameTs?: number
  rawText: string
  sourceType?: string
  windowTitle?: string
}

export interface QueryWorkerTimelineStep {
  callState?: 'called' | 'planned'
  detail?: string
  frames: MmTrajectoryFrame[]
  id: string
  metrics: string[]
  ocrRecords: QueryWorkerOcrRecord[]
  ocrElapsedSec?: number
  ocrReason?: string
  ocrRecordCount?: number
  ocrState?: 'available' | 'empty' | 'error' | 'skipped' | 'timeout'
  phase: string
  raw: MmTrajectoryEntry
  seq: number
  status: QueryWorkerStatus
  taskRef?: string
  title: string
  toolCalls: QueryWorkerToolCall[]
  toolResults: QueryWorkerToolResult[]
  ts: number
  worker: string
}

export interface QueryWorkerTimeline {
  firstSeq: number
  lastSeq: number
  status: QueryWorkerStatus
  steps: QueryWorkerTimelineStep[]
  taskId: string
}

const TERMINAL_PHASES = new Set(['cancelled', 'complete', 'error'])
const QUERY_WORKER_STEP_LIMIT = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value)

  return Number.isFinite(number) ? number : undefined
}

function resultOf(entry: MmTrajectoryEntry): Record<string, unknown> {
  return isRecord(entry.payload.result) ? entry.payload.result : {}
}

function nestedEvent(entry: MmTrajectoryEntry): Record<string, unknown> {
  return isRecord(entry.payload.event) ? entry.payload.event : {}
}

function isQueryTool(entry: MmTrajectoryEntry): boolean {
  const result = resultOf(entry)
  const name = cleanString(entry.payload.name || entry.payload.tool_name || result.name)

  return name === 'query_multimodal'
}

/** Return the outer QueryWorker task id without confusing Recall/Search child ids. */
export function queryWorkerTaskId(entry: MmTrajectoryEntry): string {
  const payload = entry.payload || {}
  const result = resultOf(entry)
  const direct = cleanString(payload.task_id || result.task_id)
  const parentId = cleanString(payload.parent_user_message_id || result.parent_user_message_id)
  const worker = cleanString(entry.worker).toLowerCase()
  const workerOwned = worker.includes('query') || worker.includes('recall') || worker.includes('search')

  if (direct && (direct.startsWith('qry_') || (parentId && workerOwned))) {
    return direct
  }

  return ''
}

export function isQueryWorkerTrajectoryEntry(entry: MmTrajectoryEntry): boolean {
  return Boolean(queryWorkerTaskId(entry)) || isQueryTool(entry)
}

function normalizeToolCall(value: unknown, fallbackName = 'memory tool'): QueryWorkerToolCall | null {
  if (!isRecord(value)) {
    return null
  }

  const args = isRecord(value.args) ? value.args : undefined

  return {
    ...(cleanString(value.anchor) ? { anchor: cleanString(value.anchor) } : {}),
    ...(finiteNumber(value.anchor_ts) !== undefined ? { anchorTs: finiteNumber(value.anchor_ts) } : {}),
    ...(args ? { args } : {}),
    name: cleanString(value.name || value.tool_name) || fallbackName
  }
}

function normalizeEvidenceSegments(value: unknown): QueryWorkerEvidenceSegment[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).slice(0, 12).map(segment => ({
    frameIds: Array.isArray(segment.frame_ids) ? segment.frame_ids.map(String).filter(Boolean) : [],
    ...(cleanString(segment.kind) ? { kind: cleanString(segment.kind) } : {}),
    ...(cleanString(segment.preview) ? { preview: cleanString(segment.preview) } : {}),
    ...(finiteNumber(segment.t_end) !== undefined ? { tEnd: finiteNumber(segment.t_end) } : {}),
    ...(finiteNumber(segment.t_start) !== undefined ? { tStart: finiteNumber(segment.t_start) } : {})
  }))
}

function normalizeToolResult(value: unknown, fallbackName = 'memory tool'): QueryWorkerToolResult | null {
  const call = normalizeToolCall(value, fallbackName)

  if (!call || !isRecord(value)) {
    return null
  }

  return {
    ...call,
    ...(typeof value.cache_hit === 'boolean' ? { cacheHit: value.cache_hit } : {}),
    ...(finiteNumber(value.elapsed_sec) !== undefined ? { elapsedSec: finiteNumber(value.elapsed_sec) } : {}),
    evidenceSegments: normalizeEvidenceSegments(value.evidence_segments),
    frameIds: Array.isArray(value.frame_ids) ? value.frame_ids.map(String).filter(Boolean) : [],
    ...(finiteNumber(value.obs_len ?? value.findings_len) !== undefined
      ? { obsLength: finiteNumber(value.obs_len ?? value.findings_len) }
      : {}),
    sourceUrls: Array.isArray(value.source_urls) ? value.source_urls.map(String).filter(Boolean).slice(0, 12) : [],
    ...(cleanString(value.obs_summary || value.findings_preview || value.findings)
      ? { summary: cleanString(value.obs_summary || value.findings_preview || value.findings) }
      : {})
  }
}

function normalizeOcrRecords(value: unknown): QueryWorkerOcrRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).slice(0, 12).map(record => ({
    ...(cleanString(record.app) ? { app: cleanString(record.app).slice(0, 160) } : {}),
    ...(cleanString(record.evidence_source || record.evidenceSource)
      ? { evidenceSource: cleanString(record.evidence_source || record.evidenceSource).slice(0, 120) }
      : {}),
    ...(finiteNumber(record.frame_ts ?? record.frameTs) !== undefined
      ? { frameTs: finiteNumber(record.frame_ts ?? record.frameTs) }
      : {}),
    rawText: cleanString(record.raw_text || record.rawText).slice(0, 12_000),
    ...(cleanString(record.source_type || record.sourceType)
      ? { sourceType: cleanString(record.source_type || record.sourceType).slice(0, 80) }
      : {}),
    ...(cleanString(record.window_title || record.windowTitle)
      ? { windowTitle: cleanString(record.window_title || record.windowTitle).slice(0, 240) }
      : {})
  }))
}

function sourceClipMetric(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const start = finiteNumber(value.t_start)
  const end = finiteNumber(value.t_end)
  const count = finiteNumber(value.n_frames)

  if (start === undefined || end === undefined) {
    return undefined
  }

  return `source ${start.toFixed(1)}–${end.toFixed(1)}s${count ? ` · ${count} frames` : ''}`
}

function toolCompleteStep(entry: MmTrajectoryEntry): QueryWorkerTimelineStep {
  const payload = entry.payload
  const result = resultOf(entry)
  const error = cleanString(payload.error || result.error)
  const taskId = cleanString(result.task_id || payload.task_id)
  const handoff = result.control === 'handoff' || cleanString(result.reply_owner) === 'query_worker'

  // query_multimodal's tool receipt is only the handoff boundary. The
  // QueryWorker's own `complete/error/cancelled` trajectory row is the sole
  // task terminal; treating this receipt as terminal makes a live task look
  // finished before OCR/Recall/Search have even started.
  return {
    detail: error || cleanString(result.query || payload.context),
    frames: [],
    id: entry.id,
    metrics: taskId ? [`task ${taskId}`] : [],
    ocrRecords: [],
    phase: entry.event,
    raw: entry,
    seq: entry.seq,
    status: error ? 'error' : 'running',
    title: error ? 'QueryWorker handoff failed' : handoff ? 'Main Agent handed the question to QueryWorker' : 'query_multimodal completed',
    toolCalls: [],
    toolResults: [],
    ts: entry.ts,
    worker: 'Main Agent'
  }
}

/** Convert one normalized gateway row into a public execution step (never hidden chain-of-thought). */
export function queryWorkerStepFromTrajectory(entry: MmTrajectoryEntry): QueryWorkerTimelineStep | null {
  if (isQueryTool(entry)) {
    if (entry.event === 'tool.complete') {
      return toolCompleteStep(entry)
    }

    return {
      callState: 'called',
      detail: cleanString(entry.payload.context),
      frames: [],
      id: entry.id,
      metrics: [],
      ocrRecords: [],
      phase: entry.event,
      raw: entry,
      seq: entry.seq,
      status: 'running',
      title: 'Main Agent called query_multimodal',
      toolCalls: [normalizeToolCall(entry.payload, 'query_multimodal') || { name: 'query_multimodal' }],
      toolResults: [],
      ts: entry.ts,
      worker: 'Main Agent'
    }
  }

  if (!queryWorkerTaskId(entry)) {
    return null
  }

  const payload = entry.payload || {}
  const event = nestedEvent(entry)
  const outerPhase = cleanString(entry.phase || payload.phase) || 'progress'
  const innerPhase = cleanString(event.phase || event.type) || outerPhase
  const channel = cleanString(event.channel || payload.channel).toLowerCase()

  // Raw token-level thinking is intentionally not exposed. Structured decisions remain below.
  if (outerPhase === 'router_thinking' || innerPhase === 'router_thinking') {
    return null
  }

  const rawFrames = Array.isArray(payload.frames) ? payload.frames.filter(isRecord) as MmTrajectoryFrame[] : []
  const elapsed = finiteNumber(event.elapsed_sec ?? payload.elapsed_sec)
  const roundRaw = finiteNumber(event.round)
  const round = roundRaw === undefined ? undefined : roundRaw + 1
  const metrics: string[] = []
  let worker = cleanString(entry.worker) || 'QueryWorker'
  let title = innerPhase
  let detail = ''
  let status: QueryWorkerStatus = 'running'
  let toolCalls: QueryWorkerToolCall[] = []
  let toolResults: QueryWorkerToolResult[] = []
  let callState: QueryWorkerTimelineStep['callState']
  let ocrRecords: QueryWorkerOcrRecord[] = []
  let ocrState: QueryWorkerTimelineStep['ocrState']
  let ocrElapsedSec: number | undefined
  let ocrReason: string | undefined
  let ocrRecordCount: number | undefined

  if (channel === 'recall' || outerPhase === 'recall_done') {worker = 'RecallWorker'}

  if (channel === 'search' || outerPhase === 'search_done') {worker = 'SearchWorker'}

  if (outerPhase === 'started') {
    title = `接手问题并锁定提问时刻 · 冻结输入帧 ${Number(payload.n_frames || rawFrames.length)}`
    const askTs = finiteNumber(payload.ask_ts)

    if (askTs !== undefined) {metrics.push(`ask_ts ${askTs.toFixed(1)}s`)}
  } else if (outerPhase === 'ocr_evidence') {
    worker = 'OCR'
    ocrRecords = normalizeOcrRecords(payload.evidence ?? payload.records ?? event.evidence ?? event.records)
    const state = cleanString(payload.evidence_state || event.evidence_state || payload.status || event.status).toLowerCase()
    const reason = cleanString(payload.reason || event.reason)
    const recordCount = finiteNumber(payload.record_count ?? event.record_count)
    const ocrElapsed = finiteNumber(payload.elapsed_sec ?? event.elapsed_sec)

    ocrReason = reason || undefined
    ocrRecordCount = recordCount === undefined ? ocrRecords.length : Math.max(0, Math.floor(recordCount))
    ocrElapsedSec = ocrElapsed === undefined ? undefined : Math.max(0, ocrElapsed)

    if (state === 'skipped') {ocrState = 'skipped'}
    else if (state === 'timeout' || reason === 'deadline_exceeded') {ocrState = 'timeout'}
    else if (state === 'error' || state === 'failed') {ocrState = 'error'}
    else if (ocrRecords.length || state === 'available') {ocrState = 'available'}
    else {ocrState = 'empty'}

    status = ocrState === 'error' || ocrState === 'timeout' ? 'error' : 'complete'
    title = ocrState === 'available'
      ? `OCR 辅助文字 · ${ocrRecordCount} 条`
      : ocrState === 'skipped'
        ? 'OCR 辅助文字 · 已跳过'
        : ocrState === 'timeout'
          ? 'OCR 辅助文字 · 超时'
          : ocrState === 'error'
            ? 'OCR 辅助文字 · 提取失败'
            : 'OCR 辅助文字 · 未识别到文字'
    detail = reason

    if (ocrElapsedSec !== undefined) {metrics.push(`${ocrElapsedSec.toFixed(2)}s`)}
  } else if (outerPhase === 'delegate_start') {
    title = '开始分析，准备决定 Recall / Search'
  } else if (outerPhase === 'router_react') {
    const searchCalls = Array.isArray(event.tool_calls) ? event.tool_calls.map(value => normalizeToolCall(value, 'search tool')).filter(Boolean) as QueryWorkerToolCall[] : []

    const recallCalls = Array.isArray(event.recall_tasks)
      ? event.recall_tasks.filter(isRecord).map(value => ({ name: 'recall_memory', args: { brief: cleanString(value.brief) } }))
      : []

    toolCalls = [...searchCalls, ...recallCalls]
    callState = 'planned'
    title = toolCalls.length
      ? `完成一轮规划${recallCalls.length ? ` · Recall ${recallCalls.length}` : ''}${searchCalls.length ? ` · Search ${searchCalls.length}` : ''}`
      : '完成一轮规划 · 本轮未调用 Recall / Search'
    detail = cleanString(event.decision_summary || event.useful_info)
  } else if (outerPhase === 'recall_skipped') {
    title = event.reason === 'retry_limit_after_two_failures'
      ? '停止重试 Recall · 相同任务已连续失败 2 次'
      : '跳过重复 Recall · 已用本次分析的召回结果'
    detail = cleanString(event.brief || event.reason)
  } else if (outerPhase === 'bg_progress') {
    const fallbackName = channel === 'search' ? 'text_search' : 'recall_memory'
    const call = normalizeToolCall(event, fallbackName)

    detail = cleanString(event.brief || event.obs_summary || event.clue)

    if (channel === 'search') {
      if (call) {toolCalls = [call]}
      callState = 'called'
      title = innerPhase === 'start'
        ? 'Search 开始检索'
        : `Search 实际调用 · ${call?.name || fallbackName}`
    } else if (innerPhase === 'bg_progress') {
      if (call) {toolCalls = [call]}
      callState = 'called'
      title = `Recall 实际调用 · ${call?.name || fallbackName}`
    } else if (innerPhase === 'start') {
      title = '开始召回多模态记忆'

      if (cleanString(event.model)) {metrics.push(`model ${cleanString(event.model)}`)}
    } else if (innerPhase === 'tool_obs') {
      const observations = Array.isArray(event.observations) ? event.observations : []

      toolResults = observations.map(value => normalizeToolResult(value)).filter(Boolean) as QueryWorkerToolResult[]
      title = `Recall 第${round || '?'}轮读取记忆工具 · ${toolResults.length} 项结果`
      const parallelElapsed = finiteNumber(event.parallel_elapsed_sec)

      if (parallelElapsed !== undefined) {metrics.push(`并行读取 ${parallelElapsed.toFixed(2)}s`)}

      if (Array.isArray(event.new_frame_ids) && event.new_frame_ids.length) {
        metrics.push(`新证据帧 ${event.new_frame_ids.length}`)
      }
    } else if (innerPhase === 'distill') {
      title = `Recall 第${round || '?'}轮提炼出有效线索`
      detail = cleanString(event.clue)
    } else if (/^r\d+_decision$/.test(innerPhase) || /decision$/.test(innerPhase)) {
      const nextCalls = Array.isArray(event.next_tool_calls) ? event.next_tool_calls : []

      toolCalls = nextCalls.map(value => normalizeToolCall(value)).filter(Boolean) as QueryWorkerToolCall[]
      callState = toolCalls.length ? 'planned' : undefined
      title = `Recall 第${round || '?'}轮决策 · ${
        event.can_answer === true
          ? '证据已足够'
          : toolCalls.length
            ? `继续检索 ${toolCalls.length} 个工具`
            : '无后续工具'
      }`
      detail = cleanString(event.decision_summary || event.useful_info)
      const clues = finiteNumber(event.n_clues_so_far)

      metrics.push(`can_answer ${String(event.can_answer === true)}`)

      if (clues) {metrics.push(`已有线索 ${clues}`)}

      if (event.useful_info && event.decision_summary) {
        detail += `${detail ? '\n' : ''}证据摘要：${cleanString(event.useful_info)}`
      }
    } else if (innerPhase === 'tool_skipped') {
      title = `Recall 第${round || '?'}轮跳过重复记忆读取`
      detail = cleanString(event.name || event.tool_name)

      if (call) {toolCalls = [call]}
    } else if (innerPhase === 'verify') {
      title = `Recall 视觉复核 · 保留 ${Number(event.n_kept || 0)}/${Number(event.n_in || 0)} 帧`
      detail = cleanString(event.visual_correction) || '未发现需要纠正的画面冲突'
    } else if (innerPhase === 'fast_table') {
      status = 'complete'
      const result = normalizeToolResult(event, fallbackName)

      if (result) {toolResults = [result]}
      title = `Recall 快速工具返回 · ${call?.name || fallbackName} · ${Number(event.findings_len || 0)} 字证据`
      detail = cleanString(event.findings_preview || event.obs_summary)
    } else if (innerPhase === 'done') {
      status = 'complete'
      const found = Number(event.n_clues || 0) > 0 || Boolean(cleanString(event.findings_preview))

      title = `Recall 完成 · ${found ? `${Number(event.n_clues || 0)} 条线索` : '未找到可靠线索'}`
      detail = cleanString(event.findings_preview)
    } else if (innerPhase === 'error') {
      status = 'error'
      title = `Recall 请求失败${event.stage ? ` · ${String(event.stage)}` : ''}`
      detail = cleanString(event.error)

      if (cleanString(event.model)) {metrics.push(`model ${cleanString(event.model)}`)}
    } else {
      title = `Recall ${innerPhase}${round ? ` · 第${round}轮` : ''}`
    }
  } else if (outerPhase === 'recall_done' || outerPhase === 'search_done') {
    status = 'complete'
    const fallbackName = outerPhase === 'search_done' ? 'text_search' : 'recall_memory'
    const result = normalizeToolResult(event, fallbackName)

    if (result) {toolResults = [result]}
    const recallFound = event.found !== false && cleanString(event.findings_preview) !== '(记忆里未找到相关线索)'

    title = outerPhase === 'search_done'
      ? `Search 返回 · ${Number(event.findings_len || 0)} 字证据`
      : `Recall 返回 · ${recallFound ? `${Number(event.n_clues || 0)} 条线索` : '未找到可靠线索'}${rawFrames.length ? ` · ${rawFrames.length} 帧` : ''}`
    detail = cleanString(event.findings_preview)

    if (event.cache_hit === true) {metrics.push('cache hit')}
  } else if (outerPhase === 'answer_ready') {
    title = '证据已齐，组织最终答案'
    detail = cleanString(event.text_preview)
  } else if (outerPhase === 'tool_error') {
    status = 'error'
    title = `${channel === 'search' ? 'Search' : 'Recall'} 子任务失败`
    detail = cleanString(event.findings || event.error)
    const call = normalizeToolCall(event, channel === 'search' ? 'text_search' : 'recall_memory')

    if (call) {toolCalls = [call]}
  } else if (TERMINAL_PHASES.has(outerPhase)) {
    status = outerPhase as QueryWorkerStatus
    title = outerPhase === 'complete' ? '回答已完成并回填原问题' : outerPhase === 'cancelled' ? '任务已取消' : '任务执行失败'
    detail = cleanString(payload.answer_preview || payload.error)
  } else {
    title = `${worker} · ${innerPhase}`
    detail = cleanString(event.detail || event.brief || event.obs_summary || payload.detail)
  }

  if (round !== undefined) {metrics.push(`round ${round}`)}

  if (elapsed !== undefined) {metrics.push(`${elapsed.toFixed(2)}s`)}
  const sourceMetric = sourceClipMetric(event.source_clip || payload.source_clip)

  if (sourceMetric) {metrics.push(sourceMetric)}

  return {
    ...(callState ? { callState } : {}),
    ...(detail ? { detail } : {}),
    frames: rawFrames,
    id: entry.id,
    metrics,
    ocrRecords,
    ...(ocrElapsedSec !== undefined ? { ocrElapsedSec } : {}),
    ...(ocrReason ? { ocrReason } : {}),
    ...(ocrRecordCount !== undefined ? { ocrRecordCount } : {}),
    ...(ocrState ? { ocrState } : {}),
    phase: `${outerPhase}:${innerPhase}`,
    raw: entry,
    seq: entry.seq,
    status,
    ...(cleanString(event.task_id) ? { taskRef: cleanString(event.task_id) } : {}),
    title,
    toolCalls,
    toolResults,
    ts: entry.ts,
    worker
  }
}

/** Build task-owned timelines. Tool handoff rows are attached only when ownership is unambiguous. */
export function buildQueryWorkerTimelines(entries: MmTrajectoryEntry[]): QueryWorkerTimeline[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq || a.ts - b.ts)
  const taskIds = [...new Set(sorted.map(queryWorkerTaskId).filter(Boolean))]
  const grouped = new Map<string, QueryWorkerTimelineStep[]>()

  for (const entry of sorted) {
    let taskId = queryWorkerTaskId(entry)

    if (!taskId && isQueryTool(entry) && taskIds.length === 1) {
      taskId = taskIds[0]
    }

    if (!taskId) {
      continue
    }

    const step = queryWorkerStepFromTrajectory(entry)

    if (!step) {
      continue
    }

    const current = grouped.get(taskId) || []
    const existing = current.findIndex(value => value.id === step.id)

    if (existing >= 0) {
      // Live and hydrate copies share an id. Keep whichever normalized row is
      // newer, rather than letting an older late list response overwrite a
      // fresher live payload just because it was merged later.
      const previous = current[existing]

      if (step.seq > previous.seq || (step.seq === previous.seq && step.ts > previous.ts)) {
        current[existing] = step
      }
    } else {
      current.push(step)
    }

    grouped.set(taskId, current)
  }

  return [...grouped.entries()].map(([taskId, taskSteps]) => {
    const steps = taskSteps
      .sort((a, b) => a.seq - b.seq || a.ts - b.ts || a.id.localeCompare(b.id))
      .slice(-QUERY_WORKER_STEP_LIMIT)

    const terminal = [...steps].reverse().find(step =>
      TERMINAL_PHASES.has(cleanString(step.raw.phase || step.raw.payload.phase))
    )

    const failedHandoff = [...steps].reverse().find(step =>
      step.raw.event === 'tool.complete' && step.status === 'error'
    )

    return {
      firstSeq: steps[0]?.seq ?? 0,
      lastSeq: steps.at(-1)?.seq ?? 0,
      status: terminal?.status || failedHandoff?.status || 'running',
      steps,
      taskId
    }
  }).sort((a, b) => a.firstSeq - b.firstSeq)
}
