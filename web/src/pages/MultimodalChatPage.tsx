/**
 * Multimodal Chat — camera/screen capture wired into one Hermes session.
 *
 * Phase 2 of the multimodal integration. Unlike the standalone MultimodalPage
 * (which talks the legacy /api/multimodal/ws DualAgent protocol), this page
 * drives the MAIN chat agent over the gateway JSON-RPC WebSocket:
 *
 *   - Owns one gateway session (session.create).
 *   - Streams camera/screen frames at ~2fps via the `multimodal.frame` RPC into
 *     that session agent's FrameBuffer.
 *   - Sends text questions via `prompt.submit`; the main agent routes one-shot
 *     visual questions through `query_multimodal`, whose QueryWorker reads the
 *     ask-time frames and chooses direct VQA, Recall, or Search as needed.
 *   - Renders the streamed answer from `message.start/delta/complete` events.
 *
 * Frames + questions share ONE session, so workers resolve the same buffer.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC, type UIEvent } from "react";
import { Activity, Bug, Camera, Database, FileText, Monitor, RefreshCw, Search, Send, Mic, Volume2, Square, Play, Loader2, ArrowDown, NotebookPen, ChevronDown, MessagesSquare, Table2, X } from "lucide-react";
import { ChatModelPill } from "@/components/ChatModelPill";
import { useSearchParams } from "react-router-dom";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { GatewayClient } from "@/lib/gatewayClient";
import { HERMES_BASE_PATH, api } from "@/lib/api";
import type {
  MmMemoryDebugEvent,
  MmMemoryDebugFrameResponse,
  MmMemoryDebugSearchResult,
  MmMemoryDebugSessionResponse,
  MmMemoryDebugSessionSummary,
  MmMemoryDebugTraceResponse,
} from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { MmReadinessBanner, type MmReadinessReport } from "@/components/MmReadinessBanner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useProfileScope } from "@/contexts/useProfileScope";
import { preferLightCapture } from "@/lib/perf-hints";
import { formatElapsed, useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { visualCaptureProfile } from "@/lib/visual-capture-profile";
import {
  isEphemeralControl,
  monitorPresentation,
  removeEphemeralControlTurn,
  resolveRegistryPull,
  type MonitorRegistryItem,
} from "@/lib/monitor-control";

type SourceType = "camera" | "screen" | null;

const QUERY_MULTIMODAL_TOOL_NAME = "query_multimodal";
const LEGACY_QUERY_MULTIMODAL_TOOL_NAME = "recall_multimodal_memory";

/** Match the model-visible tool used by new live QueryWorker handoffs. */
// eslint-disable-next-line react-refresh/only-export-components
export function isQueryMultimodalToolName(toolName: unknown): boolean {
  return toolName === QUERY_MULTIMODAL_TOOL_NAME;
}

/**
 * Match persisted QueryWorker handoffs. Older sessions keep their original
 * tool rows, so hydration accepts the pre-rename name without exposing it to
 * the new live event path.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isQueryMultimodalHistoryToolName(toolName: unknown): boolean {
  return isQueryMultimodalToolName(toolName)
    || toolName === LEGACY_QUERY_MULTIMODAL_TOOL_NAME;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  queued?: boolean;
  queuePosition?: number;
  voice?: boolean;
  // Inline progress entries (kind!=="chat") interleave with chat bubbles.
  kind?: "chat" | "tool" | "status" | "clarify";
  // clarify-entry fields (kind==="clarify"): a blocking clarify.request from a
  // tool (e.g. set_monitor silent-mode). Rendered inline in the waterfall as a
  // question with option buttons; answered via clarify.respond.
  clarifyReqId?: string;
  clarifyQuestion?: string;
  clarifyChoices?: string[];
  clarifyAnswer?: string;   // set once answered → buttons freeze, show choice
  // tool-entry fields
  toolId?: string;
  toolName?: string;
  toolCtx?: string;
  toolDone?: boolean;
  toolSummary?: string;
  toolDurationMs?: number;
  toolDetail?: string;   // result_text / inline_diff (expandable)
  // Structured, privacy-classified call args from tool.start's `args_fields`.
  // Ships in every mode (not just verbose) so a tool row always has something
  // to expand — a bare tool name can't tell the user what the model did.
  toolArgs?: ToolArgField[];
  recallTrace?: RecallTraceEntry[];
  recallFindings?: string;
  // QueryWorker owns the answer after query_multimodal hands off.
  // Its live trajectory is folded back into this same tool card by task id.
  workerTaskId?: string;
  workerStatus?: "running" | "complete" | "error" | "cancelled";
  workerProgress?: QueryWorkerProgressStep[];
  // assistant reasoning (kept separate from the answer text)
  reasoning?: string;
  // Auxiliary-LLM-summarised label of the latest reasoning segment
  // (~10 chars). If empty and streaming reasoning exists, the raw tail is
  // shown instead. Cleared once the answer body starts streaming.
  reasoningSummary?: string;
  // Streaming state machine flags (for the AssistantMessage "first line"):
  //   awaitingFirstDelta = true → 显示 "Waiting response…"
  //   hasReasoning       = true → 显示 "Thinking…" / reasoning 内容
  //   收到 message.delta 后, streaming 保持 true 但 hasReasoning 已经不重要
  //     (第一行整体消失, 让位给正文)
  awaitingFirstDelta?: boolean;
  hasReasoning?: boolean;
  // error styling
  isError?: boolean;
  // marks proactive bubbles from the multimodal RouterEngine
  deepResearch?: boolean;
  // Phase 10: concurrent-instance routing. proactive bubbles from
  // RouterEngine carry request_id; monitor SPEAK bubbles carry monitor_id.
  requestId?: string;
  monitorId?: string;
  monitorLabel?: string;   // user-facing short label (id is never shown)
  // Phase 13: which background worker produced this bubble. Drives a
  // distinct color so sub-agent output reads differently from both the
  // real user's turns and the main agent's replies.
  //   "monitor" → monitor daemon proactive alert (amber)
  //   "router"  → RouterEngine deep-research result (violet)
  //   "query_worker" → one-shot Recall/Search answer owner (cyan)
  //   undefined → main agent reply (or real user turn on role="user")
  subRole?: "monitor" | "router" | "watcher_report" | "query_worker";
  // Post-Clarify thread-back: shown in the center chat (not the left sub-window).
  threadback?: boolean;
  // Deep-research event name (the brief the user asked) — shown as the router
  // badge instead of the old "已回传主对话" text.
  brief?: string;
  // watcher_report: 本段画面时段区间 (mm:ss–mm:ss), 展示在头部行。
  deepRange?: string;
  // Client-local creation time (epoch ms) → absolute HH:MM:SS beside role name.
  createdAt?: number;
}

export interface QueryWorkerProgressStep {
  id: string;
  seq: number;
  ts: number;
  worker: string;
  phase: string;
  title: string;
  detail?: string;
  metrics?: string[];
  plannedTools?: RecallTraceToolCall[];
  toolResults?: RecallTraceToolObs[];
  frames?: MmTrajectoryFrame[];
  ocrRecords?: QueryWorkerOcrRecord[];
  ocrState?: "available" | "empty" | "skipped" | "timeout" | "error";
  ocrReason?: string;
  ocrRecordCount?: number;
  ocrElapsedSec?: number;
  taskRef?: string;
  callState?: "planned" | "called";
  terminal?: boolean;
  status?: "running" | "complete" | "error" | "cancelled";
}

export interface QueryWorkerOcrRecord {
  frameTs?: number;
  sourceType?: string;
  evidenceSource?: string;
  app?: string;
  windowTitle?: string;
  rawText: string;
}

const QUERY_WORKER_PROGRESS_LIMIT = 80;
const QUERY_WORKER_TASK_CACHE_LIMIT = 48;
const QUERY_WORKER_IMAGE_TASK_LIMIT = 4;
const QUERY_WORKER_IMAGE_CHAR_BUDGET = 4_000_000;
const QUERY_WORKER_OCR_RECORD_LIMIT = 3;
const QUERY_WORKER_OCR_TEXT_LIMIT = 1_800;

function frameImageChars(frame: MmTrajectoryFrame): number {
  return (typeof frame.jpeg_b64 === "string" ? frame.jpeg_b64.length : 0)
    + (typeof frame.thumb_b64 === "string" ? frame.thumb_b64.length : 0);
}

function withoutFrameImage(frame: MmTrajectoryFrame): MmTrajectoryFrame {
  if (frame.jpeg_b64 == null && frame.thumb_b64 == null) return frame;
  const metadata = { ...frame };
  delete metadata.jpeg_b64;
  delete metadata.thumb_b64;
  return metadata;
}

function compactFrames(
  frames: MmTrajectoryFrame[] | undefined,
  remaining: { chars: number },
  protectedInput = false,
): MmTrajectoryFrame[] | undefined {
  if (!frames?.length) return frames;
  if (protectedInput) return frames;
  return frames.map((frame) => {
    const chars = frameImageChars(frame);
    if (chars === 0) return frame;
    if (chars <= remaining.chars) {
      remaining.chars -= chars;
      return frame;
    }
    return withoutFrameImage(frame);
  });
}

function recentTaskIds(taskOrder: string[]): Set<string> {
  return new Set(taskOrder.slice(-QUERY_WORKER_IMAGE_TASK_LIMIT));
}

/**
 * Keep QueryWorker progress globally bounded while preserving textual/frame
 * metadata. The latest task's frozen ``started`` inputs are protected; older
 * debug images are evicted before their timestamps, source labels, or steps.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function updateQueryWorkerProgressCache(
  existing: Map<string, QueryWorkerProgressStep[]>,
  taskId: string,
  incoming: QueryWorkerProgressStep | QueryWorkerProgressStep[],
): Map<string, QueryWorkerProgressStep[]> {
  const next = new Map(existing);
  const merged = mergeQueryWorkerProgress(next.get(taskId) || [], incoming);
  // Delete + set makes Map insertion order the LRU order.
  next.delete(taskId);
  next.set(taskId, merged);
  while (next.size > QUERY_WORKER_TASK_CACHE_LIMIT) {
    const oldest = next.keys().next().value;
    if (typeof oldest !== "string") break;
    next.delete(oldest);
  }

  const order = Array.from(next.keys());
  const newest = order.at(-1) || "";
  const imageTasks = recentTaskIds(order);
  const protectedChars = (next.get(newest) || [])
    .filter((step) => step.phase.startsWith("started:"))
    .flatMap((step) => step.frames || [])
    .reduce((total, frame) => total + frameImageChars(frame), 0);
  const remaining = {
    chars: Math.max(0, QUERY_WORKER_IMAGE_CHAR_BUDGET - protectedChars),
  };

  for (const id of order.slice().reverse()) {
    const steps = next.get(id) || [];
    const keepTaskImages = imageTasks.has(id);
    const compacted = steps.slice().reverse().map((step) => {
      const protectedInput = id === newest && step.phase.startsWith("started:");
      const frames = keepTaskImages
        ? compactFrames(step.frames, remaining, protectedInput)
        : step.frames?.map(withoutFrameImage);
      return frames === step.frames ? step : { ...step, frames };
    }).reverse();
    next.set(id, compacted);
  }
  return next;
}

export function mergeQueryWorkerProgress(
  existing: QueryWorkerProgressStep[],
  incoming: QueryWorkerProgressStep | QueryWorkerProgressStep[],
): QueryWorkerProgressStep[] {
  const byId = new Map<string, QueryWorkerProgressStep>();
  for (const step of existing) byId.set(step.id, step);
  for (const step of Array.isArray(incoming) ? incoming : [incoming]) {
    byId.set(step.id, step);
  }
  return Array.from(byId.values())
    .sort((a, b) => a.seq - b.seq || a.ts - b.ts || a.id.localeCompare(b.id))
    .slice(-QUERY_WORKER_PROGRESS_LIMIT);
}

/** Guard an async trajectory hydrate against session switches and stale pulls. */
// eslint-disable-next-line react-refresh/only-export-components
export function isCurrentTrajectoryHydration(
  requestedSessionId: string,
  requestedGeneration: number,
  currentSessionId: string,
  currentGeneration: number,
): boolean {
  return Boolean(requestedSessionId)
    && requestedSessionId === currentSessionId
    && requestedGeneration === currentGeneration;
}

/** Apply the bounded cache to already-rendered tool cards without losing steps. */
// eslint-disable-next-line react-refresh/only-export-components
export function compactQueryWorkerMessageProgress(
  messages: ChatMsg[],
  cache: Map<string, QueryWorkerProgressStep[]>,
): ChatMsg[] {
  let changed = false;
  const compacted = messages.map((message) => {
    if (!message.workerTaskId || !message.workerProgress?.length) return message;
    const cached = cache.get(message.workerTaskId);
    const progress = cached || message.workerProgress.map((step) => {
      if (!step.frames?.some((frame) => frameImageChars(frame) > 0)) return step;
      return { ...step, frames: step.frames.map(withoutFrameImage) };
    });
    if (progress === message.workerProgress) return message;
    changed = true;
    return { ...message, workerProgress: progress };
  });
  return changed ? compacted : messages;
}

interface RecallTraceToolObs {
  name?: string;
  args?: Record<string, unknown>;
  obs_len?: number;
  elapsed_sec?: number;
  obs_summary?: string;
  frame_ids?: string[];
  evidence_segments?: RecallEvidenceSegment[];
  source_urls?: string[];
  cache_hit?: boolean;
  anchor?: string;
  anchor_ts?: number;
}

interface RecallTraceToolCall {
  name?: string;
  args?: Record<string, unknown>;
  anchor?: string;
  anchor_ts?: number;
}

interface RecallEvidenceSegment {
  kind?: string;
  t_start?: number;
  t_end?: number;
  frame_ids?: string[];
  preview?: string;
}

/** One classified tool-call argument (backend: agent.display.describe_arg_fields).
 *  - literal    → `value` is safe to display (identifiers, enums, paths, intent prose)
 *  - freeform   → payload the call is writing/sending; only `chars` is sent, never
 *                 the content, so a DM body or file content can't surface in the UI
 *  - shape      → array/object; only `count` is sent
 *  - credential → a secret (password/token/ssn/…): key ONLY, no value and no
 *                 length, since a secret's length is itself a hint
 *  - elided     → synthetic trailing entry (`key` is ""), `count` = how many
 *                 fields were dropped past the backend's per-call cap */
interface ToolArgField {
  key: string;
  kind: "literal" | "freeform" | "shape" | "credential" | "elided";
  value?: string;
  chars?: number;
  count?: number;
}

interface RecallTraceEntry {
  phase?: string;
  round?: number;
  can_answer?: boolean;
  next_tool_calls?: RecallTraceToolCall[];
  tools?: RecallTraceToolObs[];
  thought?: string;
  decision_summary?: string;
  useful_info?: string;
  clue?: string;
  query?: string;
  findings_len?: number;
  frame_ids?: string[];
  parallel_elapsed_sec?: number;
  elapsed_sec?: number;
  error?: string;
  stage?: string;
}

interface CropItem {
  label: string;
  bbox?: number[];
  width?: number;
  height?: number;
  jpeg_b64: string;
}

// One readable "segment" of a deep-research run — a single analysis round,
// rendered as a card: 🎬 第N段 [mm:ss–mm:ss] → 👁 看到 → 🔎/🧩 检索 → 📝 就绪.
interface BgSegment {
  seg: number;                    // segment/round index (1-based for display)
  tsRange?: [number, number];     // frame time range for the header
  scene?: string;                 // 场景标记 (后端从本段 thought 廉价提取, 标题行展示)
  saw?: string;                   // 👁 what the model saw this round (from `thought`)
  thinking?: string;              // 💭 model's raw reasoning trace (thinking models)
  // 🔧 tool calls the model issued this round (name + a short arg preview).
  toolCalls?: { name: string; arg?: string }[];
  // ⚠️ tool failures this round (which tool + why).
  toolErrors?: { name: string; error: string }[];
  // 🔎 search / 🧩 recall lines: query → result summary.
  lookups: { kind: "search" | "recall"; query: string; result?: string; done?: boolean }[];
  ready?: boolean;                // 📝 this segment's 解读 is generated
  readyChars?: number;
  answer?: string;                // 📝 this segment's interpretation text (for folding)
  crops?: CropItem[];             // 🖼 crop thumbnails (image search)
}

interface BgItem {
  id: string;                     // one item per request_id
  requestId?: string;             // which RouterEngine delegation
  label?: string;                 // UI label (lightweight summary) for the card title
  segments: BgSegment[];          // ordered segment cards (one per productive round)
  // frame-accumulation status: current/target frames + ttl countdown.
  waiting?: { have: number; need: number; ttlSec?: number; ttlRemaining?: number; seg?: number; paused?: boolean } | null;
  done?: boolean;
  report?: string;                // ★ latest incremental deep-research report (progress_report)
  reportBatches?: number;
  // Final consolidated report (summarize_watch) pushed once on completion via
  // watcher.final — the authoritative result, shown in-panel. The main agent
  // chat is never touched by the watcher.
  finalReport?: string;
}

interface ObsItem {
  ts: string;       // mm:ss timestamp
  speaker?: string; // audio-observation speaker label
  text: string;
}

interface CtxState {
  version: number;
  obs: ObsItem[];         // 画面观察(时间轴)
  audioObs: ObsItem[];    // 音频观察(时间轴)
  facts: Record<string, string>;  // SearchFactStore 的 UI 字符串投影
}

interface TtsRefs {
  audioCtx: AudioContext | null;
  audioNextStart: number;
  active: AudioBufferSourceNode[];
  currentRid: string | null;
  cancelled: Set<string>;
  // Barge-in guard: mute the mic (drop PCM, don't send to ASR) until this
  // epoch-ms deadline, so speaker-played TTS isn't re-captured and looped.
  ttsMuteUntil: number;
  // ★ #2 播放 ack: 追踪当前 rid 的播放进度, 打断时回传"实际听了多少"给后端,
  //   后端据此把"我说过什么"截断到用户真听到的部分。
  ctxStartTime: number;   // 当前 rid 首块的 AudioContext 起播时刻
  scheduledSec: number;   // 当前 rid 已排定的总播放时长 (秒)
}

interface Refs {
  gw: GatewayClient | null;
  sessionId: string;
  stream: MediaStream | null;
  sourceType: SourceType;
  capFps: number;
  capTimer: number | null;
  startTs: number;
  sentFrames: number;
  // Frames skipped because the WS out-buffer was over the backpressure
  // threshold. Surfaced in the diag log so we can tell "capture is throttling"
  // apart from "capture is broken".
  droppedFrames: number;
  // Last time (performance.now ms) the frameCount state was pushed — throttles
  // the display-only count to ~1/s so screen-share capture doesn't re-render
  // the page every tick.
  _lastCountPush?: number;
  // DEPRECATED bookkeeping: tracks whether any assistant bubble is streaming.
  // It NO LONGER gates frame capture — capture is always-on now (pausing it
  // dropped frames + staled the stream-liveness signal). Kept only because a few
  // error-recovery paths still reset it; safe to remove in a later cleanup.
  isAnswering: boolean;
  // mic (user speech → streaming realtime ASR → ask). Uses AudioWorklet
  // (off-main-thread) so PCM downsampling + base64 doesn't block the UI thread.
  micStream: MediaStream | null;
  micAudioCtx: AudioContext | null;
  micNode: AudioWorkletNode | null;
  micSource: MediaStreamAudioSourceNode | null;
  isRecording: boolean;
  // env audio (screen/people speaking → audio_observation in memory)
  envStream: MediaStream | null;
  envRecorder: MediaRecorder | null;
  envStop: boolean;
  envMime: string;
  envWindowSec: number;
  envSliceTimer: number | null;
  envCaptureId: string;
  envChunkSeq: number;
  envLastError: string;
  // Set by the gateway effect so the ?mm= watcher can switch sessions in place
  // (resume a different id + restore its transcript) without a full remount.
  resumeSessionById?: (sid: string, restoreHistory: boolean) => Promise<boolean>;
  // Set by the gateway effect so the ?mm=new (新建) handler can create a fresh
  // session on demand (returns the new persisted id).
  createSession?: () => Promise<string>;
  // ★ The PERSISTED session id (stored_session_id / session_key), distinct from
  //   `sessionId` (the live runtime id RPCs route by). This is what `?mm=`, the
  //   sidebar list, and localStorage use — it survives auto-compress rotation.
  storedSid: string;
  // Stashed so the monitor/watcher toggle (render scope) can re-pull the
  // authoritative registry after a toggle (confirm the optimistic flip).
  fetchRegistries?: (sid: string) => void;
}

function pickMicMime(): string {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const m of c) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = (r.result as string) || "";
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

let _seq = 0;
const nid = () => `m${++_seq}_${Date.now()}`;

// ── Backend history → ChatMsg[] (resume restoration) ────────────────────────
// Convert the flat message array returned by `session.resume` (gateway) or
// `getSessionMessages` (REST) into the page's ChatMsg bubbles, so reopening a
// session restores its transcript instead of a blank waterfall.
//
// Field shapes differ between the two sources — we accept both:
//   gateway resume: { role, text, name?, context?, subRole?, monitorLabel?, ... }
//   REST messages : { role, content, tool_name?, tool_call_id?, reasoning?, tool_calls? }
// so we read text from `text || content`, tool name from `name || tool_name`, etc.
interface RawHistoryMsg {
  role?: string;
  text?: string;
  content?: unknown;
  timestamp?: number;   // DB 消息时间戳 (秒); 恢复气泡用它还原 createdAt
  name?: string;
  tool_name?: string;
  context?: string;      // 调用侧: 命令/参数预览 (≠ 工具返回值)
  args_fields?: ToolArgField[];  // 调用侧结构化入参 (与实时 tool.start 同构)
  summary?: string;      // 工具结果摘要 (exit code / error 首行)
  tool_call_id?: string;
  tool_calls?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  subRole?: string;
  requestId?: string;
  monitorLabel?: string;
  eventId?: string;
  brief?: string;
  deepRange?: string;
  deepReportRid?: string;
  deepRound?: number;
  history_policy?: unknown;
  ephemeral_control?: unknown;
  ephemeral?: unknown;
}

/** Coerce a message `content`/`text` field to a plain display string.
 *  Backend flattens most content to a string already; array content (rare,
 *  multimodal blocks) is reduced to its text parts + [image]/[audio] markers. */
function _coerceHistoryText(m: RawHistoryMsg): string {
  if (typeof m.text === "string") return m.text;
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (typeof part === "string") { parts.push(part); continue; }
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
        else if (p.type === "image_url" || p.type === "image") parts.push("[image]");
        else if (p.type === "input_audio" || p.type === "audio") parts.push("[audio]");
      }
    }
    return parts.join("");
  }
  return "";
}

/** Convert a backend history array into ChatMsg bubbles for the waterfall.
 *   orphanIds: monitor/watcher event ids that are NOT on this session's disk
 *  (磁盘为权威) → their bubbles are dropped (not rendered). The caller toasts. */
// eslint-disable-next-line react-refresh/only-export-components
export function historyToMmMessages(raw: unknown, orphanIds?: Set<string>): ChatMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMsg[] = [];
  const orphans = orphanIds || new Set<string>();

  // ── Per-turn aggregation (对齐实时流式观感) ─────────────────────────────
  // 实时时, 主 agent 一轮内的所有普通文本 delta 都追加到【同一条】assistant
  // 气泡 (ensureBubble 按 stream-key 复用 id), tool 气泡穿插其后 → 观感是
  // "一条文本 + 其后一串工具"。但 DB 把一轮存成多行:
  //   assistant(文本1+tool_calls) → tool → assistant(文本2+tool_calls) → tool
  // 逐行重建会拆成 [文本1,工具1,文本2,工具2] 交替多条, 与实时不一致 (用户报的
  // "退出重进后展开成多个交替消息")。这里按轮聚合: 把同一轮的多段主 agent 文本
  // 合并成一条气泡, 该轮的 tool 气泡跟在其后, 复刻实时的分组。
  //
  // 轮边界: 一条 user 消息开启新轮 (monitor/watcher 触发的 user 注入同样算新轮)。
  // 只聚合"普通主 agent 文本" (无特殊 subRole); monitor/watcher/router 子气泡与
  // reasoning 保持各自独立, 不并入合并文本。
  let turnTextSegs: string[] = [];
  let turnReasoning: string | undefined;
  let turnTools: ChatMsg[] = [];
  const flushTurn = () => {
    if (turnTextSegs.length > 0 || turnReasoning) {
      const merged = turnTextSegs.filter(Boolean).join("\n\n").trim();
      if (merged || turnReasoning) {
        out.push({
          id: nid(), role: "assistant", text: merged,
          ...(turnReasoning ? { reasoning: turnReasoning } : {}),
        });
      }
    }
    for (const t of turnTools) out.push(t);
    turnTextSegs = [];
    turnReasoning = undefined;
    turnTools = [];
  };

  for (const item of raw as RawHistoryMsg[]) {
    if (!item || typeof item !== "object") continue;
    // Defensive compatibility for sessions written during a staggered
    // backend rollout. New pure Monitor controls are not persisted at all;
    // if an older writer did persist a marked row, never resurrect it here.
    if (isEphemeralControl(item)) continue;

    // ★ mm_notice 双形态兜底 (对齐 desktop toChatMessages):
    //   两条恢复路径返回的形态不同 ——
    //     gateway session.resume → _history_to_messages 已重建: 顶层带 subRole /
    //       monitorLabel / eventId / deepReportRid (下面 subRole 分支认)。
    //     REST /api/sessions/{id}/messages → 未重建, 还是原始 dict:
    //       { role, content:{ type:"mm_notice", mm_kind, mm_event_id, mm_label,
    //         mm_round?, text } } —— 无 subRole。
    //   历史恢复实际可能吃到任一条 (gateway 或 REST/兜底), 所以这里【两种都认】,
    //   把原始 dict 也重建成 monitor/watcher_report 气泡, 否则该条会因 text 取不到
    //   (content 是 dict) 被当空消息丢弃 (web 端曾丢 monitor/watcher 通知的真因)。
    const _c = (item as { content?: unknown }).content;
    if (_c && typeof _c === "object" && !Array.isArray(_c)
        && (_c as { type?: string }).type === "mm_notice") {
      // Monitor + watcher notices no longer live in the center chat — they
      // hydrate the right multimodal panel from mm_monitor_alerts +
      // mm_watcher_reports sidechannel tables (see list_monitor_alerts /
      // list_watcher_content RPCs). Legacy rows from before the split are
      // simply skipped here; the query/query_user notices don't take this raw
      // branch (they come through as subRole:query_worker in the reshaped
      // branch below).
      continue;
    }

    // ★ 孤儿丢弃: 该 monitor/watcher 气泡的 event id 不在磁盘 → 不渲染。
    const _eid = String(
      (item as { monitorId?: string; deepReportRid?: string; eventId?: string })
        .monitorId
      || (item as { deepReportRid?: string }).deepReportRid
      || (item as { eventId?: string }).eventId || "");
    if (_eid && orphans.has(_eid)) continue;
    const role = String(item.role || "");
    // Tool result rows → a completed tool bubble, buffered into the current
    // turn so it renders after this turn's merged assistant text (matching the
    // realtime "one text bubble + trailing tool bubbles" grouping).
    if (role === "tool") {
      const toolName = String(item.name || item.tool_name || "tool");
      // ★ ctx 与 detail 是【两个不同东西】, 不能互相兜底:
      //     context = 调用侧 (命令/参数预览, 后端 _tool_ctx 截到 80 字)
      //     content = 工具真正的返回值 (后端 _history_tool_result 截断后的投影)
      //   旧代码 `_coerceHistoryText(item) || item.context` 在没有 content 时
      //   回落到 context, 把"命令预览"塞进 toolDetail → 摘要行只剩 "✓ terminal",
      //   同时凭空多出一层 <details>, 点开只有那 80 字命令 (用户报的"点开很冗余
      //   又没信息")。现在各归各位: 没有真实输出就不给 toolDetail, 不出折叠层。
      const detail = _coerceHistoryText(item);
      const ctx = typeof item.context === "string" ? item.context : "";
      const recallDebug = isQueryMultimodalHistoryToolName(toolName)
        ? extractRecallDebug(null, detail)
        : null;
      const parsedToolResult = safeJsonParse(detail);
      const workerTaskId = isQueryMultimodalHistoryToolName(toolName)
        && isRecord(parsedToolResult)
        && parsedToolResult.reply_owner === "query_worker"
        && typeof parsedToolResult.task_id === "string"
          ? parsedToolResult.task_id : "";
      turnTools.push({
        id: nid(), role: "assistant", text: "", kind: "tool",
        toolName, toolDone: true,
        ...(ctx ? { toolCtx: ctx } : {}),
        ...(item.args_fields?.length ? { toolArgs: item.args_fields } : {}),
        ...(detail ? { toolDetail: detail } : {}),
        ...(item.summary ? { toolSummary: String(item.summary) } : {}),
        ...(recallDebug?.trace?.length ? { recallTrace: recallDebug.trace } : {}),
        ...(recallDebug?.findings ? { recallFindings: recallDebug.findings } : {}),
        ...(workerTaskId ? {
          workerTaskId,
          workerStatus: "running" as const,
          workerProgress: [],
        } : {}),
      });
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const text = _coerceHistoryText(item);
    // Monitor + watcher_report legacy rows are dropped here — they hydrate
    // the right multimodal panel from the sidechannel RPCs instead. Only
    // query_worker (main-agent-driven Recall) still shows as a center bubble.
    const subRole = item.subRole;
    if (subRole === "monitor" || subRole === "watcher_report") {
      continue;
    }
    if (subRole === "query_worker") {
      // Special sub-agent bubble ends the current main-agent turn aggregation.
      flushTurn();
      const _ts2 = typeof item.timestamp === "number" && item.timestamp > 0
        ? item.timestamp * 1000
        : undefined;
      out.push({
        id: nid(), role: "assistant", text,
        subRole: "query_worker",
        requestId: item.requestId || item.eventId || undefined,
        brief: item.brief,
        deepRange: item.deepRange,
        ...(_ts2 ? { createdAt: _ts2 } : {}),
      });
      continue;
    }
    // An assistant turn that only carried tool_calls (no visible text) is a
    // routing placeholder — skip it (the tool rows above already show the work).
    if (role === "assistant" && !text && item.tool_calls) continue;
    if (!text) continue;
    const reasoning =
      typeof item.reasoning === "string" ? item.reasoning
      : typeof item.reasoning_content === "string" ? item.reasoning_content
      : undefined;
    if (role === "assistant") {
      // Accumulate this turn's main-agent text; merged into one bubble at the
      // turn boundary (flushTurn) so multi-tool turns render as a single
      // message + trailing tool bubbles, matching the realtime stream.
      turnTextSegs.push(text);
      if (reasoning && !turnReasoning) turnReasoning = reasoning;
      continue;
    }
    // user / system: a real turn boundary — flush the prior turn first, then
    // push this message independently.
    flushTurn();
    out.push({
      id: nid(), role: role as ChatMsg["role"], text,
      ...(reasoning ? { reasoning } : {}),
    });
  }
  flushTurn();
  return out;
}

/** Format an epoch-ms timestamp as local HH:MM:SS for a message header. */
const fmtClock = (ms?: number): string => {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};


async function blitVideoToCanvas(
  v: HTMLVideoElement,
  cvs: HTMLCanvasElement,
  w: number,
  h: number,
  resizeQuality: "low" | "medium" | "high" = "low",
): Promise<void> {
  if (cvs.width !== w) cvs.width = w;
  if (cvs.height !== h) cvs.height = h;
  const ctx = cvs.getContext("2d");
  if (!ctx) return;
  // createImageBitmap(resize*) offloads downscale off the sync drawImage path;
  // Retina / HiDPI screen-share tracks are often 2–4× the logical size (e.g. a
  // 2560-wide native capture). Frames arrive here already clamped by their
  // visual-capture profile, so this is a light blit; "medium" keeps text crisp
  // on the normal 1080p screen tier while 720p camera/light tiers stay cheap.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(v, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality,
      });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return;
    } catch {
      /* fall through */
    }
  }
  ctx.drawImage(v, 0, 0, w, h);
}

// Input row (textarea + mic + send) as an isolated leaf. It owns `askText`
// locally so each keystroke re-renders ONLY this component — not the whole
// page and its (up to 120) message bubbles. onSend receives the text and the
// composer clears itself; the parent never sees per-keystroke state.
const _MM_SESSION_KEY = "mm.sessionId";

// 新会话/切换会话时置顶的"系统"引导气泡。★ 用工厂函数 (每次给新 id), 避免多处共用同
//   一 object 引用。之前性能重构把它只放进 useState 初值, resetSessionUi 清成 [] 后不再
//   补回 → 新建/切换会话就没有这条置顶引导了。
const _mmWelcomeMsg = (): ChatMsg => ({
  id: nid(), role: "system",
  text: "Turn on the camera or share your screen, then just ask. One-shot visual questions go to QueryWorker, which reads the frames from the moment you asked and, when needed, recalls history or searches for reference material.",
});
const ChatComposer = memo(function ChatComposer({
  micState, onSend, onMicToggle, generating, onStop,
  ttsEnabled, onTtsToggle,
  voiceDialogEnabled, onVoiceDialogToggle,
}: {
  micState: "idle" | "connecting" | "recording";
  onSend: (text: string) => void;
  onMicToggle: () => void;
  generating: boolean;
  onStop: () => void;
  ttsEnabled: boolean;
  onTtsToggle: () => void;
  voiceDialogEnabled: boolean;
  onVoiceDialogToggle: () => void;
}) {
  const [askText, setAskText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const submit = () => {
    const t = askText.trim();
    if (!t) return;
    onSend(t);
    setAskText("");
  };
  // 单行起步, 内容换行时长高到 max-h-24 为止 —— 否则 rows={1} 的可视高度固定,
  // 第二行会被裁掉(overflow 能滚, 但用户看不见自己刚打的字)。清空后缩回一行。
  // 在 layout effect 里做, 避免先按旧高度绘制再跳一帧。
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";              // 先塌陷, 再按真实内容量取值
    el.style.height = `${el.scrollHeight}px`;
  }, [askText]);
  const connecting = micState === "connecting";
  const recording = micState === "recording";
  return (
    // items-end: composer surface 现在比三个 icon 按钮高, 按钮贴底对齐才不会飘在
    // 输入框中部 (desktop 同样用 items-end)。
    <div className="flex items-end gap-2 border-t p-3">
      <Button size="icon"
        // Red only when actually recording. While connecting: neutral +
        // disabled + spinner (not red). Idle: outlined.
        // ★ 对话模式开时: 按钮态保持不变(不禁用/不联动高亮), 但点击无效 —— 拦截+
        //   提示在父级 onMicToggle 里做 (对话独占麦, 后台已联动)。
        destructive={recording}
        outlined={!recording}
        disabled={connecting}
        title={recording ? "点击结束录音"
          : connecting ? "正在连接语音…"
          : "点击开始说话(流式语音)"}
        onClick={onMicToggle}>
        {connecting ? <Loader2 className="animate-spin" /> : <Mic />}
      </Button>
      <Button size="icon"
        // 独立 TTS 语音播报开关 (与麦克风解耦): 开 = 实心高亮, 关 = 描边。
        // ★ 对话模式开时: 喇叭按钮态保持不变(后台已强制 TTS 生效), 点击无效 ——
        //   拦截+提示在父级 onTtsToggle 里做。
        outlined={!ttsEnabled}
        title={ttsEnabled
          ? "语音播报:开(主Agent/监控/深度分析气泡自动朗读)—点击关闭"
          : "语音播报:关—点击开启自动朗读"}
        onClick={onTtsToggle}>
        <Volume2 />
      </Button>
      <Button size="icon"
        outlined={!voiceDialogEnabled}
        className={voiceDialogEnabled
          ? "bg-amber-400 text-background-base hover:bg-amber-500 active:bg-amber-500"
          : "hover:border-amber-400/70 hover:text-amber-300"}
        title={voiceDialogEnabled
          ? "对话模式:开(语音自然交互, 智能分诊+秒回+可打断)—点击关闭"
          : "对话模式:关—点击进入语音对话交互"}
        aria-pressed={voiceDialogEnabled}
        onClick={onVoiceDialogToggle}>
        <MessagesSquare />
      </Button>
      {/* ★ Composer surface —— 单行: 输入区 + pill 同处一行、同一个 border 内。
          发送/停止 在 surface 之外的右侧 (和左侧那三个 toggle 一样是框外控件);
          框内只放"编辑相关"的东西, 动作按钮不进编辑框。
          文字在 pill 处截止 —— 靠 flex 分栏而非 padding 预留: 输入区是
          `min-w-0 flex-1`, pill 是 `shrink-0`, 所以文字天然写到 pill 左边缘就
          换行, 不会跑到 pill 底下。
          注意不要加 overflow-hidden: ChatModelPill 的面板是 `absolute
          bottom-full` 向上弹出的, 会被裁掉。 */}
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3 py-1 focus-within:border-foreground/30">
        <textarea
          ref={taRef}
          value={askText}
          onChange={(e) => setAskText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          rows={1}
          placeholder="提问(画面会随问题一起发送)"
          // min-w-0 让 flex 子项可以真正收缩(否则 textarea 的默认固有宽度会把
          // pill 挤出去); max-h-24 是长高的上限, 超过就内部滚动。
          className="max-h-24 min-w-0 flex-1 resize-none self-center overflow-y-auto border-0 bg-transparent p-0 text-sm leading-snug outline-none" />
        <ChatModelPill className="shrink-0" />
      </div>
      {/* A live foreground turn no longer disables intake. New sends are
          accepted into the backend FIFO; Stop remains an explicit, separate
          action for cancelling the current turn + its queued successors. */}
      {generating && (
        <Button className="shrink-0" size="icon" destructive title="停止当前回答" onClick={onStop}>
          <Square />
        </Button>
      )}
      <Button className="shrink-0" size="sm" prefix={<Send />} onClick={submit}>
        {generating ? "排队发送" : "发送"}
      </Button>
    </div>
  );
});

// ASR live preview — isolated so partial transcript updates don't re-render
// the chat list / video column (Mac Chrome was stuttering during voice input).
// buffer: already-stitched EOU segments shown behind the current partial.
const AsrBar = memo(function AsrBar({
  recording, partial, buffer,
}: { recording: boolean; partial: string; buffer: string[] }) {
  if (!recording && !partial && buffer.length === 0) return null;
  const buffered = buffer.join(" ").trim();
  return (
    <div className="flex items-center gap-2 border-t px-3 pt-2 text-xs text-muted-foreground">
      {recording && <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-red-500" />}
      <span className="truncate">
        {buffered ? (
          <>
            <span className="opacity-60">{buffered}</span>
            {partial ? <span className="ml-1">{partial}</span> : null}
          </>
        ) : (
          partial || "Listening..."
        )}
      </span>
    </div>
  );
});

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function extractRecallDebug(result: unknown, detail?: string): {
  trace: RecallTraceEntry[];
  findings?: string;
} | null {
  const direct = isRecord(result) ? result : null;
  const parsed = !direct && detail ? safeJsonParse(detail) : null;
  const obj = direct || (isRecord(parsed) ? parsed : null);
  if (!obj) return null;
  const traceValue = obj.recall_trace ?? obj.trace;
  const trace = Array.isArray(traceValue)
    ? traceValue.filter(isRecord) as RecallTraceEntry[]
    : [];
  const findings = typeof obj.findings === "string"
    ? obj.findings
    : typeof obj.partial_findings === "string"
      ? obj.partial_findings
      : undefined;
  if (!trace.length && !findings) return null;
  return { trace, findings };
}

function argPreview(args: Record<string, unknown> | undefined, max = 180): string {
  if (!args) return "";
  const q = args.query ?? args.entity_id ?? args.task_id ?? args.frame_id ?? args.target;
  const raw = typeof q === "string" ? q : JSON.stringify(args);
  return String(raw || "").replace(/\s+/g, " ").slice(0, max);
}

export function formatTraceTime(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "";
  const tenths = Math.round(value * 10);
  const whole = Math.floor(tenths / 10);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  const tenth = tenths % 10;
  const fraction = tenth ? `.${tenth}` : "";
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}${fraction}`;
}

function normalizeQueryWorkerOcrRecords(value: unknown): QueryWorkerOcrRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, QUERY_WORKER_OCR_RECORD_LIMIT).map((record) => {
    const frameTsRaw = Number(record.frame_ts ?? record.frameTs);
    const bounded = (snake: string, camel: string, limit: number): string => {
      const raw = record[snake] ?? record[camel];
      return typeof raw === "string" ? raw.slice(0, limit) : "";
    };
    return {
      ...(Number.isFinite(frameTsRaw) ? { frameTs: frameTsRaw } : {}),
      ...(bounded("source_type", "sourceType", 80)
        ? { sourceType: bounded("source_type", "sourceType", 80) } : {}),
      ...(bounded("evidence_source", "evidenceSource", 120)
        ? { evidenceSource: bounded("evidence_source", "evidenceSource", 120) } : {}),
      ...(bounded("app", "app", 160) ? { app: bounded("app", "app", 160) } : {}),
      ...(bounded("window_title", "windowTitle", 240)
        ? { windowTitle: bounded("window_title", "windowTitle", 240) } : {}),
      rawText: bounded("raw_text", "rawText", QUERY_WORKER_OCR_TEXT_LIMIT),
    };
  });
}

function queryOcrSourceLabel(sourceType?: string): string {
  const value = String(sourceType || "").trim().toLowerCase();
  if (value === "camera" || value === "webcam") return "摄像头";
  if (["screen", "screenshare", "screen_share", "desktop", "display", "window", "tab"].includes(value)) {
    return "屏幕共享";
  }
  return sourceType?.trim() || "来源未知";
}

function queryOcrMethodLabel(evidenceSource?: string): string {
  const value = String(evidenceSource || "").trim().toLowerCase();
  if (value === "background_screen_texts" || value.includes("background") || value.includes("cache")) {
    return "后台 OCR 缓存";
  }
  if (value === "synchronous_camera_ocr") return "摄像头即时 OCR";
  if (value === "synchronous_screen_fallback") return "屏幕即时 OCR";
  return evidenceSource?.trim() || "OCR 方法未知";
}

function queryOcrStateMessage(step: QueryWorkerProgressStep): string {
  if (step.ocrState === "timeout") {
    return "OCR 超时；QueryWorker 已继续使用原始画面，不会因此阻塞回答。";
  }
  if (step.ocrState === "error") {
    return "OCR 提取失败；QueryWorker 已继续使用原始画面。";
  }
  if (step.ocrState === "skipped") {
    if (step.ocrReason === "no_frozen_frames") return "已跳过 OCR：没有可用的冻结输入帧。";
    if (step.ocrReason === "ocr_unavailable") return "已跳过 OCR：OCR 服务当前不可用。";
    return `已跳过 OCR${step.ocrReason ? `：${step.ocrReason}` : "。"}`;
  }
  return "OCR 已完成，但没有识别到可用文字。";
}

function QueryWorkerOcrEvidence({ step }: { step: QueryWorkerProgressStep }) {
  const records = step.ocrRecords || [];
  const count = step.ocrRecordCount ?? records.length;
  return (
    <details open className="mt-1.5 rounded border border-sky-300/20 bg-sky-300/5 px-2 py-1.5">
      <summary className="cursor-pointer select-none list-none text-[10px] font-medium text-sky-100">
        OCR 辅助文字
        <span className="ml-1.5 font-normal text-muted-foreground/70">
          {records.length ? `${count} 条` : "无文字"}
          {step.ocrElapsedSec != null ? ` · ${step.ocrElapsedSec.toFixed(2)}s` : ""}
        </span>
      </summary>
      {records.length ? (
        <div className="mt-1.5 space-y-1.5">
          {records.map((record, index) => (
            <div key={`${record.frameTs ?? "unknown"}-${record.evidenceSource || "ocr"}-${index}`} className="rounded border border-sky-300/15 bg-black/15 p-1.5">
              <div className="flex flex-wrap gap-1">
                <span className="rounded border border-sky-300/20 px-1.5 py-0.5 font-mono text-[9px] text-sky-100/75">
                  {record.frameTs != null ? formatTraceTime(record.frameTs) : "时间未知"}
                </span>
                <span className="rounded border border-sky-300/20 px-1.5 py-0.5 text-[9px] text-sky-100/75">
                  {queryOcrSourceLabel(record.sourceType)}
                </span>
                <span className="rounded border border-sky-300/20 px-1.5 py-0.5 text-[9px] text-sky-100/75">
                  {queryOcrMethodLabel(record.evidenceSource)}
                </span>
              </div>
              {(record.app || record.windowTitle) && (
                <div className="mt-1 truncate text-[9px] text-muted-foreground/60" title={[record.app, record.windowTitle].filter(Boolean).join(" · ")}>
                  {[record.app, record.windowTitle].filter(Boolean).join(" · ")}
                </div>
              )}
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[10px] text-foreground/80">
                {record.rawText || "（该帧未识别到文字）"}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 rounded bg-black/15 px-2 py-1 text-[10px] text-muted-foreground/75">
          {queryOcrStateMessage(step)}
        </div>
      )}
      <div className="mt-1 text-[9px] text-sky-100/45">
        仅作文字识别辅助，最终判断仍以冻结原图为准。
      </div>
    </details>
  );
}

function sourceClipMetric(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const start = formatTraceTime(value.t_start);
  const end = formatTraceTime(value.t_end);
  if (!start || !end) return undefined;
  const count = Number(value.n_frames || 0);
  return `触发片段 ${start}–${end}${count ? ` · ${count} 帧` : ""}`;
}

function evidenceSegmentLabel(segment: RecallEvidenceSegment): string {
  const start = formatTraceTime(segment.t_start);
  const end = formatTraceTime(segment.t_end);
  if (!start) return "";
  const time = end && end !== start ? `${start}–${end}` : start;
  const kind = segment.kind === "audio" ? "音频"
    : segment.kind === "quote" ? "引语"
      : segment.kind === "screen" ? "屏幕"
        : segment.kind === "frame" ? "画面" : "记忆";
  return `${kind} ${time}`;
}

function RecallTracePanel({
  trace, findings,
}: {
  trace?: RecallTraceEntry[];
  findings?: string;
}) {
  const items = trace || [];
  if (!items.length && !findings) return null;
  const toolCount = items.reduce((n, e) => n + (e.tools?.length || 0), 0);
  return (
    <details className="mt-1 rounded border border-emerald-400/30 bg-emerald-400/5 p-2 text-[11px] text-emerald-100/90">
      <summary className="cursor-pointer select-none font-medium text-emerald-200">
        Recall 执行轨迹 · {items.length} 步{toolCount ? ` · ${toolCount} 个内部工具` : ""}
      </summary>
      <div className="mt-1 text-[10px] text-emerald-100/55">
        结构化决策与证据摘要，不包含模型隐藏思维链。
      </div>
      <div className="mt-2 space-y-2">
        {findings && (
          <div className="rounded border border-emerald-400/20 bg-background/40 p-2">
            <div className="mb-1 text-emerald-300/90">findings</div>
            <div className="whitespace-pre-wrap break-words text-foreground/85">{findings}</div>
          </div>
        )}
        {items.map((e, idx) => {
          const phase = String(e.phase || "step");
          return (
            <div key={`${phase}-${idx}`} className="rounded border border-border/60 bg-background/40 p-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-emerald-200">
                <span className="font-medium">{phase}</span>
                {e.round != null && <span className="text-muted-foreground">r{e.round}</span>}
                {e.can_answer != null && (
                  <span className={e.can_answer ? "text-emerald-300" : "text-amber-300"}>
                    can_answer={String(e.can_answer)}
                  </span>
                )}
                {e.parallel_elapsed_sec != null && (
                  <span className="text-muted-foreground">
                    {Number(e.parallel_elapsed_sec).toFixed(2)}s
                  </span>
                )}
              </div>
              {e.decision_summary && (
                <div className="mb-1 whitespace-pre-wrap break-words text-muted-foreground">
                  决策摘要：{e.decision_summary}
                </div>
              )}
              {e.error && (
                <div className="mb-1 whitespace-pre-wrap break-words text-red-300">
                  {e.stage ? `${e.stage}: ` : ""}{e.error}
                </div>
              )}
              {e.useful_info && <div className="mb-1 whitespace-pre-wrap break-words text-foreground/80">useful: {e.useful_info}</div>}
              {e.clue && <div className="mb-1 whitespace-pre-wrap break-words text-foreground/80">clue: {e.clue}</div>}
              {e.query && <div className="mb-1 break-words text-muted-foreground">query: {e.query}</div>}
              {Array.isArray(e.next_tool_calls) && e.next_tool_calls.length > 0 && (
                <div className="space-y-1">
                  <div className="text-emerald-300/90">planned tools</div>
                  {e.next_tool_calls.map((tc, i) => (
                    <div key={`planned-${i}`} className="rounded bg-muted/30 px-2 py-1">
                      <span className="font-medium text-foreground/90">{tc.name || "tool"}</span>
                      {tc.args && <span className="text-muted-foreground"> · {argPreview(tc.args)}</span>}
                    </div>
                  ))}
                </div>
              )}
              {Array.isArray(e.tools) && e.tools.length > 0 && (
                <div className="space-y-1">
                  <div className="text-emerald-300/90">tool results</div>
                  {e.tools.map((tool, i) => (
                    <details key={`tool-${i}`} className="rounded bg-muted/30 px-2 py-1">
                      <summary className="cursor-pointer select-none list-none">
                        <span className="font-medium text-foreground/90">{tool.name || "tool"}</span>
                        {tool.args && <span className="text-muted-foreground"> · {argPreview(tool.args)}</span>}
                        {tool.obs_len != null && <span className="text-muted-foreground/70"> · {tool.obs_len} chars</span>}
                        {tool.frame_ids?.length ? <span className="text-muted-foreground/70"> · {tool.frame_ids.length} frames</span> : null}
                      </summary>
                      {tool.obs_summary && (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border bg-background/50 p-2 text-foreground/80">
                          {tool.obs_summary}
                        </pre>
                      )}
                    </details>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

export const QueryWorkerProgressPanel = memo(function QueryWorkerProgressPanel({
  taskId, status, steps,
}: {
  taskId: string;
  status?: ChatMsg["workerStatus"];
  steps: QueryWorkerProgressStep[];
}) {
  const active = !status || status === "running";
  const visible = steps.slice(-QUERY_WORKER_PROGRESS_LIMIT);
  return (
    <div className="mt-2 rounded border border-cyan-400/35 bg-cyan-950/20 p-2 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5 text-cyan-200">
        {active
          ? <span className="inline-block animate-spin">◌</span>
          : status === "complete" ? <span className="text-emerald-400">✓</span>
            : <span className="text-red-400">!</span>}
        <span className="font-semibold">QueryWorker 实时过程</span>
        <span className="font-mono text-[10px] text-cyan-300/60">#{taskId}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          {active ? "工作中" : status === "complete" ? "已完成" : status || "已结束"}
        </span>
      </div>
      <div className="mt-1 text-[10px] leading-snug text-cyan-100/55">
        展示结构化决策摘要、工具与证据；不包含模型隐藏思维链。
      </div>
      {visible.length === 0 ? (
        <div className="mt-1.5 animate-pulse text-muted-foreground/70">等待第一条 worker 进度…</div>
      ) : (
        <div className="mt-2 space-y-1 border-l border-cyan-400/25 pl-2">
          {visible.map((step, idx) => {
            const latest = idx === visible.length - 1;
            const askTimeFrames = step.phase.startsWith("started:");
            const ocrEvidence = step.phase.startsWith("ocr_evidence:");
            return (
              <div key={step.id} className="relative rounded bg-background/25 px-2 py-1.5">
                <span className={`absolute -left-[13px] top-2.5 h-1.5 w-1.5 rounded-full ${
                  step.status === "error" ? "bg-red-400"
                    : step.status === "complete" ? "bg-emerald-400"
                      : latest && active ? "animate-pulse bg-cyan-300" : "bg-cyan-500/70"
                }`} />
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 font-medium text-cyan-100">{step.worker}</span>
                  <span className="min-w-0 flex-1 break-words text-foreground/85">{step.title}</span>
                  {step.taskRef && (
                    <span className="shrink-0 rounded border border-cyan-400/20 px-1 font-mono text-[9px] text-cyan-200/55">
                      {step.taskRef}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/45">#{step.seq}</span>
                </div>
                {ocrEvidence && <QueryWorkerOcrEvidence step={step} />}
                {step.detail && step.detail.length > 180 && (
                  <details className="mt-1" open={latest && active}>
                    <summary className="cursor-pointer select-none break-words text-muted-foreground/80">
                      {`${step.detail.slice(0, 180)}…`}
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border bg-black/20 p-1.5 text-[10px] text-foreground/75">
                      {step.detail}
                    </pre>
                  </details>
                )}
                {step.detail && step.detail.length <= 180 && (
                  <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground/80">
                    {step.detail}
                  </div>
                )}
                {!!step.metrics?.length && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {step.metrics.map((metric, i) => (
                      <span key={`${metric}-${i}`} className="rounded border border-cyan-400/20 bg-cyan-400/5 px-1.5 py-0.5 font-mono text-[9px] text-cyan-100/70">
                        {metric}
                      </span>
                    ))}
                  </div>
                )}
                {!!step.plannedTools?.length && (
                  <div className="mt-1.5 space-y-1">
                    <div className="text-[10px] text-cyan-200/70">
                      {step.callState === "called" ? "实际调用" : "计划调用"}
                    </div>
                    {step.plannedTools.map((tool, i) => (
                      <details
                        key={`${tool.name || "tool"}-${i}`}
                        open={step.callState === "called"}
                        className="rounded border border-cyan-400/15 bg-black/10 px-2 py-1"
                      >
                        <summary className="cursor-pointer select-none break-words text-foreground/80">
                          <span className="font-medium text-cyan-100">{tool.name || "memory tool"}</span>
                          {tool.args ? <span className="text-muted-foreground"> · {argPreview(tool.args)}</span> : null}
                          {tool.anchor ? (
                            <span className="text-muted-foreground/70">
                              {` · anchor=${tool.anchor}${tool.anchor_ts != null ? ` @${formatTraceTime(tool.anchor_ts)}` : ""}`}
                            </span>
                          ) : null}
                        </summary>
                        {tool.args && (
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[10px] text-foreground/70">
                            {JSON.stringify(tool.args, null, 2)}
                          </pre>
                        )}
                      </details>
                    ))}
                  </div>
                )}
                {!!step.toolResults?.length && (
                  <div className="mt-1.5 space-y-1">
                    <div className="text-[10px] text-emerald-200/70">工具返回</div>
                    {step.toolResults.map((tool, i) => (
                      <details
                        key={`${tool.name || "tool-result"}-${i}`}
                        open
                        className="rounded border border-emerald-400/15 bg-emerald-400/5 px-2 py-1"
                      >
                        <summary className="cursor-pointer select-none break-words text-foreground/80">
                          <span className="font-medium text-emerald-200">{tool.name || "memory tool"}</span>
                          {tool.args ? <span className="text-muted-foreground"> · {argPreview(tool.args)}</span> : null}
                          {tool.obs_len != null ? <span className="text-muted-foreground/70"> · {tool.obs_len} 字</span> : null}
                          {tool.elapsed_sec != null ? <span className="text-muted-foreground/70"> · {tool.elapsed_sec.toFixed(2)}s</span> : null}
                          {tool.frame_ids?.length ? <span className="text-muted-foreground/70"> · {tool.frame_ids.length} 帧</span> : null}
                          {tool.cache_hit ? <span className="text-amber-200/70"> · cache hit</span> : null}
                          {tool.anchor ? (
                            <span className="text-muted-foreground/70">
                              {` · anchor=${tool.anchor}${tool.anchor_ts != null ? ` @${formatTraceTime(tool.anchor_ts)}` : ""}`}
                            </span>
                          ) : null}
                        </summary>
                        {tool.args && (
                          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[10px] text-foreground/65">
                            {JSON.stringify(tool.args, null, 2)}
                          </pre>
                        )}
                        {tool.obs_summary && (
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-emerald-400/10 bg-black/20 p-1.5 text-[10px] text-foreground/75">
                            {tool.obs_summary}
                          </pre>
                        )}
                        {!!tool.frame_ids?.length && (
                          <div className="mt-1 break-all font-mono text-[9px] text-muted-foreground/60">
                            frame_ids: {tool.frame_ids.join(", ")}
                          </div>
                        )}
                        {!!tool.evidence_segments?.length && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {tool.evidence_segments.slice(0, 12).map((segment, idx) => {
                              const label = evidenceSegmentLabel(segment);
                              if (!label) return null;
                              return (
                                <span
                                  key={`${label}-${idx}`}
                                  title={segment.preview || label}
                                  className="rounded border border-amber-300/20 bg-amber-300/5 px-1.5 py-0.5 font-mono text-[9px] text-amber-100/80"
                                >
                                  {label}{segment.frame_ids?.length ? ` · ${segment.frame_ids.length}帧` : ""}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {!!tool.source_urls?.length && (
                          <div className="mt-1 space-y-0.5 text-[9px] text-cyan-200/65">
                            {tool.source_urls.slice(0, 5).map((url) => (
                              <a key={url} href={url} target="_blank" rel="noreferrer" className="block truncate hover:underline">
                                {url}
                              </a>
                            ))}
                          </div>
                        )}
                      </details>
                    ))}
                  </div>
                )}
                {!!step.frames?.length && (
                  <div className="mt-1.5">
                    <div className="mb-1 text-[10px] text-cyan-200/70">
                      {askTimeFrames
                        ? "提问时刻冻结输入帧（QueryWorker 实际输入的同源缩略图）"
                        : "Recall 证据帧"}
                    </div>
                    <div className={askTimeFrames
                      ? "grid grid-cols-1 gap-1 sm:grid-cols-3"
                      : "grid grid-cols-2 gap-1 sm:grid-cols-4"}
                    >
                      {step.frames.slice(0, 8).map((fr, i) => {
                        const b64 = fr.thumb_b64 || fr.jpeg_b64 || "";
                        const usable = b64 && !b64.startsWith("<omitted");
                        const dataUrl = usable ? `data:image/jpeg;base64,${b64}` : "";
                        return (
                          <figure key={`${fr.frame_id || fr.ts || i}-${i}`} className="overflow-hidden rounded border border-cyan-400/20 bg-black/20">
                            {usable ? (
                              <a
                                href={dataUrl}
                                target="_blank"
                                rel="noreferrer"
                                title="点击放大查看"
                                className="block"
                              >
                                <img
                                  src={dataUrl}
                                  alt={fr.frame_id || `${askTimeFrames ? "ask-time input" : "recall evidence"} ${i + 1}`}
                                  className="h-20 w-full cursor-zoom-in object-contain"
                                />
                              </a>
                            ) : (
                              <div className="flex h-20 items-center justify-center text-[9px]">no thumbnail</div>
                            )}
                            <figcaption className="truncate px-1 py-0.5 font-mono text-[9px] text-cyan-200/70">
                              {fr.frame_id || `${askTimeFrames ? "输入帧" : "frame"} ${i + 1}`}
                              {fr.ts != null ? ` · ${formatTraceTime(fr.ts)}` : ""}
                              {fr.source_type ? ` · ${fr.source_type}` : ""}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// Tool-call arguments, rendered as key/value rows inside an expanded tool row.
//
// Why this exists: the collapsed line only has room for a one-line preview, so
// a call like `computer_use` used to be a dead end — the user could see the
// tool ran but never what it was told to do. The backend now ships classified
// args on every tool.start (see agent.display.describe_arg_fields), and this
// panel is where they land.
//
// Privacy is enforced BACKEND-side, not here: `freeform` fields (message
// bodies, file contents) arrive as a character count and `credential` fields
// (password/token/ssn/…) as a bare key, both with no value attached, so there
// is nothing to accidentally render. This component therefore never has to
// decide what is safe — it just can't display what it wasn't given.
export const ToolArgsPanel = memo(function ToolArgsPanel({
  fields,
}: {
  fields?: ToolArgField[];
}) {
  if (!fields || !fields.length) return null;
  return (
    <div className="mt-1">
      <div className="mb-0.5 text-[10px] text-muted-foreground/70">入参</div>
      <div className="space-y-px rounded border bg-background/50 p-2">
        {fields.map((f, i) =>
          // `elided` carries no key (it is the "+N more" tail, not a field), so
          // it can't use f.key as its React key and renders as a bare note.
          f.kind === "elided" ? (
            <div key="elided" className="font-mono text-[10px] leading-relaxed text-muted-foreground/50 italic">
              还有 {f.count} 个字段 (未显示)
            </div>
          ) : (
            <div key={`${f.key}-${i}`} className="flex gap-2 font-mono text-[10px] leading-relaxed">
              <span className="shrink-0 text-violet-300/80">{f.key}</span>
              {f.kind === "credential" ? (
                // 凭证类字段连长度都不发 —— 密码的长度本身就是线索。
                <span className="text-amber-400/70 italic">已隐去 (凭证)</span>
              ) : f.kind === "freeform" ? (
                // 正文类字段只有长度 —— 后端不发内容, 这里也就无从渲染。
                <span className="text-muted-foreground/60 italic">{f.chars} 字符 (未显示)</span>
              ) : f.kind === "shape" ? (
                <span className="text-muted-foreground/80">{f.count} 项</span>
              ) : (
                <span className="min-w-0 break-all text-foreground/80">{f.value}</span>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
});

// Grouped "background" card (tools + status). Memoized so it only re-renders
// when its `items` array identity changes (the parent rebuilds `rows` from a
// new `messages` array only when a message actually changes).
// Exported for the render test that pins disclosure nesting depth.
export const BgBlock = memo(function BgBlock({ items }: { items: ChatMsg[] }) {
  const running = items.some((it) => it.kind === "tool"
    && (!it.toolDone || it.workerStatus === "running"));
  return (
    <div className="ml-9 rounded-md border border-dashed border-violet-400/40 bg-violet-400/5 px-2.5 py-1.5 text-[11px]">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-violet-400">
        {running
          ? <span className="inline-block animate-spin">◌</span>
          : <span className="text-emerald-500">✓</span>}
        处理过程
      </div>
      <div className="space-y-0.5">
        {items.map((it) => {
          if (it.kind === "status") {
            return (
              <div key={it.id} className="italic text-muted-foreground/80">
                {it.text}
              </div>
            );
          }
          // tool entry — collapsible if it has detail
          const head = (
            <>
              {it.toolDone
                ? <span className="text-emerald-500">✓</span>
                : <span className="inline-block animate-spin text-violet-400">◌</span>}
              {" "}
              {/* 未完成的工具: 名字 + 参数摘要一起走 .shimmer 流光, 与上方思考行同一
                  套动效语言。完成后换成静态实色 + ✓ + 耗时, 一眼区分"在跑"和"跑完"。
                  这里不挂计时器: 行在 map 里, 每行一个 hook 需要拆组件, 而完成态本就
                  显示 toolDurationMs, 运行态的时长由上方思考行的计时器代表。 */}
              <span className={it.toolDone ? "font-medium text-foreground/90" : "shimmer font-medium text-violet-300"}>
                {it.toolName}
              </span>
              {it.toolCtx ? (
                <span className={it.toolDone ? "text-muted-foreground" : "shimmer text-violet-300/80"}>
                  {" · "}{it.toolCtx.slice(0, 80)}
                </span>
              ) : null}
              {it.toolDone && it.toolSummary ? <span className="text-muted-foreground"> ↳ {it.toolSummary.slice(0, 120)}</span> : null}
              {it.toolDurationMs != null ? <span className="text-muted-foreground/60"> · {(it.toolDurationMs / 1000).toFixed(1)}s</span> : null}
            </>
          );
          const hasRecallTrace = !!(it.recallTrace && it.recallTrace.length) || !!it.recallFindings;
          const hasArgs = !!(it.toolArgs && it.toolArgs.length);
          return (
            <div key={it.id} className="break-words text-muted-foreground">
              {it.toolDetail || hasRecallTrace || hasArgs ? (
                <details>
                  <summary className="cursor-pointer select-none break-words">
                    {head}
                    {hasRecallTrace ? (
                      <span className="ml-2 rounded border border-emerald-400/30 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        展开 Recall Trace
                      </span>
                    ) : null}
                  </summary>
                  {/* 入参放最上面: 用户点开一个工具行, 第一个问题总是"它是拿什么参数
                      调的", 而不是"它返回了什么"。 */}
                  <ToolArgsPanel fields={it.toolArgs} />
                  <RecallTracePanel trace={it.recallTrace} findings={it.recallFindings} />
                  {/* ★ 输出直接平铺, 不再套第二层 "Raw tool result" <details>: 用户已经
                      点开一层才看到它, 再折一层等于两次点击才见内容。只有 Recall 那种
                      "结构化轨迹 + 原始输出"并存的工具才需要区分两块 —— 此时给原始输出
                      加个轻标题即可, 层级仍是一层。 */}
                  {it.toolDetail && (
                    <div className="mt-1">
                      {hasRecallTrace && (
                        <div className="mb-0.5 text-[10px] text-muted-foreground/70">原始输出</div>
                      )}
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-background/50 p-2">{it.toolDetail}</pre>
                    </div>
                  )}
                </details>
              ) : <div>{head}</div>}
              {it.workerTaskId && (
                <QueryWorkerProgressPanel
                  taskId={it.workerTaskId}
                  status={it.workerStatus}
                  steps={it.workerProgress || []}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}, (a, b) =>
  // ★ 性能(#6): 按 items 逐元素引用比较 (不是数组引用)。rows useMemo 每次都 new 一个
  //   items 数组, 但纯 chat 流式期间 tool/status 消息对象 identity 不变 → 内容相同的
  //   bg 块在这里判等、跳过重渲染。只有本块的 tool/status 真变 (新增/patch) 才重渲染。
  a.items.length === b.items.length && a.items.every((it, i) => it === b.items[i]),
);

// Stable no-op play handler for contexts that render ChatBubble without TTS
// (the deep-research sub-window). A module-level constant keeps ChatBubble's
// memo intact — an inline `() => {}` would be a new identity every render and
// force every sub-window bubble to re-render on each parent tick.
const NOOP_PLAY = (_text: string) => { /* no TTS in sub-window */ };

// Inline clarify bubble: a blocking clarify.request from a tool, rendered in
// the chat waterfall as a question + option buttons (Claude-Code-desktop
// style). Once answered, the buttons freeze and the picked answer is shown.
// Memoized so unrelated stream ticks don't re-render every clarify row.
const ClarifyBubble = memo(function ClarifyBubble({
  m, onAnswer,
}: {
  m: ChatMsg;
  onAnswer: (reqId: string, answer: string) => void;
}) {
  const reqId = m.clarifyReqId || "";
  const answered = m.clarifyAnswer !== undefined;
  const choices = m.clarifyChoices || [];
  const openEnded = choices.length === 0;
  // Local draft for open-ended (no-choices) clarify — the answer is free text.
  const [draft, setDraft] = useState("");
  const submitText = () => {
    const t = draft.trim();
    if (!t) return;
    onAnswer(reqId, t);
    setDraft("");
  };
  // ★ Once answered, the question box + option buttons collapse into ONE compact
  // system line ("✓ 已选择：<choice>"). This is nicer than freezing the dialog
  // in place: the prompt disappears and the choice reads as a settled step in
  // the conversation. (The answer already reached the tool via clarify.respond;
  // this is purely the front-end presentation.)
  if (answered) {
    return (
      <div className="flex gap-2">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted text-xs text-foreground">
          ✓
        </div>
        <div className="min-w-0 flex-1 self-center text-xs text-muted-foreground">
          已选择：<span className="text-foreground">{m.clarifyAnswer || "（空）"}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-semibold text-black">
        ?
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-medium text-amber-300">需要你确认</div>
        <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-2.5">
          <div className="mb-2 whitespace-pre-wrap text-sm text-amber-100">{m.clarifyQuestion}</div>
          {/* Only the unanswered state renders here — the answered case is
              handled by the compact early return above. */}
          {!openEnded ? (
            <div className="flex flex-wrap gap-1.5">
              {choices.map((c) => (
                <Button key={c} size="sm" outlined
                  onClick={() => onAnswer(reqId, c)}>
                  {c}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitText(); }}
                placeholder="输入你的回答，回车提交…"
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs" />
              <Button size="sm" onClick={submitText}>提交</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// 深度回传气泡: 头部行 (🔬 label·第N段 + [时段区间] + 时间, #事件id 右对齐) + 正文受控折叠。
// 默认折叠 (三角 ▸ + 正文首行 line-clamp-1 省略号); 点三角展开 (▾ + 全文)。与桌面端一致。
const WatcherReportBubble = memo(function WatcherReportBubble({
  m, onPlay,
}: { m: ChatMsg; onPlay?: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const body = m.text.trim();
  // brief 形如 "腾讯会议新消息监控 · 第1段" → 拆成 标签(进紫框) + 段号(做正文折叠头)。
  const rawBrief = m.brief || "深度分析";
  const sepIdx = rawBrief.lastIndexOf(" · ");
  const label = sepIdx >= 0 ? rawBrief.slice(0, sepIdx) : rawBrief;
  const segment = sepIdx >= 0 ? rawBrief.slice(sepIdx + 3) : "";
  // 正文第一行预览 (去掉 markdown 标题/列表符号), 折叠时作为 "第N段" 后的灰字提示。
  const firstLine = (body.split("\n").find((l) => l.trim()) || "")
    .replace(/^#+\s*/, "").replace(/^[-*>]\s*/, "").trim();
  // 与 monitor 气泡同构: [笔记本头像] [紫框标签] [时间] [播放] ...... [#事件id 右对齐]
  return (
    <div className="flex gap-2">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-violet-500 text-white">
        <NotebookPen className="h-4 w-4 -rotate-12" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-violet-300">{label}</span>
          {m.createdAt != null && (
            <span className="tabular-nums text-muted-foreground/60">{fmtClock(m.createdAt)}</span>
          )}
          {body && onPlay && (
            <button
              onClick={() => onPlay(body)}
              title="播放语音"
              className="ml-1 inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/60 hover:text-primary">
              <Play className="h-3 w-3" /> 播放
            </button>
          )}
          {m.requestId && (
            <span className="ml-auto font-mono text-muted-foreground/50">#{m.requestId}</span>
          )}
        </div>
        {/* 正文卡: 折叠时 "第N段" + 一行灰色正文预览 (≤75% 宽, 溢出 " ..." 收尾),
            右上角 "点击展开" 图标; 展开后显示该段全文。 */}
        <div className="rounded-md border-l-2 border-violet-400/50 bg-violet-950/30 px-3 py-2">
          <div
            className="flex w-full cursor-pointer select-none items-center gap-1.5 text-left text-sm"
            onClick={() => setOpen((o) => !o)}
          >
            <span className="shrink-0 font-medium text-violet-200">{segment || "查看分析"}</span>
            {m.deepRange && (
              <span className="shrink-0 tabular-nums text-xs font-normal text-violet-300/70">{m.deepRange}</span>
            )}
            {!open && firstLine && (
              // ≤75% 宽, 溢出用 " ..." 收尾 (overflow-hidden 不带原生 "…", 显式三点)。
              <span className="flex min-w-0 max-w-[75%] items-baseline text-xs text-muted-foreground/70">
                <span className="min-w-0 overflow-hidden whitespace-nowrap">{firstLine}</span>
                <span className="shrink-0">{" ..."}</span>
              </span>
            )}
            {/* 展开/收起 小胶囊按钮 (对齐头部 "▷ 播放" 形态), 紫色调。 */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
              title={open ? "收起" : "展开全文"}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-violet-400/50 px-1.5 py-0.5 text-[10px] text-violet-300 hover:border-violet-300 hover:text-violet-200">
              <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
              {open ? "收起" : "展开全文"}
            </button>
          </div>
          {open && (
            <div className="mt-2 border-t border-violet-400/20 pt-2">
              <Markdown content={body} streaming={false} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// 判定"纯思考态" chat 行: assistant 流式中、还没有正文 (且非错误/监控/深度/QueryWorker)。
// 这一形态只渲染一行 💭 状态 (ThinkingLine), 不出完整 AssistantMessage。renderRow 与
// ChatBubble 共用此判据, 保证"是否走思考行"两处完全一致。
function isPureThinkingChat(m: ChatMsg): boolean {
  return (
    m.role === "assistant" && !!m.streaming && !m.text?.trim() && !m.isError &&
    !m.monitorId && !m.deepResearch && m.subRole !== "query_worker"
  );
}

// 一行"思考中"提示行 —— 事件驱动状态机 (跟 desktop CurrentActivityLine 同思路)。
//   0. streaming + 有正在运行的工具 (toolActivity)   → 显示工具活动 ("toolName · ctx")
//   1. streaming + awaitingFirstDelta               → "Waiting response…"
//   2. streaming + hasReasoning + reasoningSummary  → 显示 aux 生成的 ~10 字 label
//   3. streaming + hasReasoning + 无 summary + 有 reasoning 正文 → 原文最后 1 行滚动
//   4. streaming + hasReasoning + 无 summary + 无正文 (只是 Luna 那类 signal-only)
//                                                    → "Thinking…"
//   5. 兜底: 流开始 3s 都还没任何 delta                → 自动切 "Thinking…"
// ★ 工具活动优先于思维链: 工具在跑时显示工具, 工具间隙 (无运行中工具) 回落到 reasoning
//   摘要 → 二者随本轮进展【交替显示】(对齐 desktop CurrentActivityLine "最新动作胜出")。
// ★ 纵轴对齐: 用隐形头像列占位 (h-7 w-7) + gap-2 + px-3, 让 💭 文字左缘与 user/assistant
//   气泡正文左缘精确对齐 —— 不再顶到 UserMessage 边界前面。
// 首个正文 delta 落地后, 父组件不再渲染这一行 (整体消失)。
const ThinkingLine: FC<{ msg: ChatMsg; toolActivity?: string }> = ({ msg, toolActivity }) => {
  const [fallbackThinking, setFallbackThinking] = useState(false);
  // 计时器 key 绑消息 id: 本轮内 label 在 工具↔思维链 之间切换【不】重置总时长,
  // 换一轮 (新 assistant 消息) 才从 0 开始。本组件只在 streaming 时被渲染
  // (isPureThinkingChat), 所以恒 active —— 正文落地后父级直接不渲染这一行。
  const elapsed = useElapsedSeconds(true, `activity:${msg.id}`);
  useEffect(() => {
    if (!msg.awaitingFirstDelta) return;
    const timer = window.setTimeout(() => setFallbackThinking(true), 3000);
    return () => window.clearTimeout(timer);
  }, [msg.awaitingFirstDelta]);
  useEffect(() => {
    if (!msg.awaitingFirstDelta) setFallbackThinking(false);
  }, [msg.awaitingFirstDelta]);

  let label = "Waiting response…";
  if (toolActivity) {
    label = toolActivity;
  } else if (msg.hasReasoning) {
    if (msg.reasoningSummary) {
      label = msg.reasoningSummary;
    } else if (msg.reasoning) {
      // 原文最后 1 行滚动 (取最后 60 字, 避免撑爆一行)
      const tail = msg.reasoning.replace(/\s+$/, "").split(/\n/).pop() || "";
      label = tail.length > 60 ? `…${tail.slice(-60)}` : (tail || "Thinking…");
    } else {
      label = "Thinking…";
    }
  } else if (fallbackThinking) {
    label = "Thinking…";
  }
  return (
    <div className="flex gap-2">
      <div className="h-7 w-7 flex-shrink-0" aria-hidden="true" />
      {/* 对齐基准 = 气泡【正文首字】的左缘 (不是 "You" 头部行的左缘), 所以这里用气泡
          自身的 px-3 (12px) 而非 0。再减 3px 是实测视觉微调: 12px 时 💭 的墨迹看起来
          比正文首字偏右一点 (emoji 字形自带左侧留白), 减 3px 后两者视觉左缘齐平。
          ★ 原先 label 与 emoji 之间靠 "💭 " 的尾随空格分隔, 现已改为 flex + gap-1.5
          (加计时器后需要 flex 布局), 该空格不再存在 —— 但 -3px 仍只补 emoji 自身的
          左侧留白, 故保持不变。改动这里请同时目视核对一次。 */}
      <div className="min-w-0 flex-1 pl-[calc(0.75rem-3px)] pr-3">
        {/* ★ 动效 (对齐 desktop CurrentActivityLine): 💭 脉冲 + label 流光 + 计时。
            label 用 .shimmer 让一道高光沿文字扫过 —— 工具执行/思考期间这一行是
            页面上唯一在动的元素, 用它告诉用户"没卡住, 正在跑"。此前只有 emoji
            在 pulse, 文字完全静止, 长工具 (curl / 大文件读) 看着像 UI 假死。
            flex + min-w-0 让 label 独占剩余宽度并 truncate, 计时器 shrink-0
            永不被挤掉。 */}
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 animate-pulse">💭</span>
          <span className="shimmer min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/55">
            {formatElapsed(elapsed)}
          </span>
        </div>
      </div>
    </div>
  );
};

// A single chat bubble (user / assistant / system / sub-agent). Memoized with
// the default shallow prop compare: `m` is a fresh object only when THAT
// message changes (delta append maps to a new object), and `model`/`onPlay`
// are stable refs. So a streaming bubble re-renders alone; idle bubbles are
// skipped — the parent can re-render freely (frame ticks, ctx updates) without
// re-diffing the whole list. Markdown inside stays memoized on top of this.
const ChatBubble = memo(function ChatBubble({
  m, model, onPlay, onReopenDeep, inToolCall, toolActivity,
}: {
  m: ChatMsg;
  model: string;
  onPlay?: (text: string) => void;   // undefined = 自动播报开着, 隐藏逐条 ▶
  onReopenDeep?: (rid: string) => void;
  // 由父级 rows 映射判断: 当前 streaming assistant 消息紧邻其后有 tool 条目。
  // ★ 不再让它翻到"完整空气泡"分支 —— 工具调用期间仍走思考行 (ThinkingLine),
  //   把工具活动写进 💭 位置, 不出空的 AssistantMessage; 待正文落地再出完整气泡。
  inToolCall?: boolean;
  // 当前正在运行的工具的一句话活动 (由父级从相邻 bg 行的运行中 tool 派生), 传给
  // ThinkingLine 作为最高优先级 label。无运行中工具时为空 → 回落到 reasoning 摘要。
  toolActivity?: string;
}) {
  // Monitor SPEAK bubbles are labelled with the short event label
  // (never "Assistant" / raw id) so the user sees what fired.
  const roleName = m.role === "user" ? "You"
    : m.monitorId ? (m.monitorLabel || "监控提醒")
    : m.subRole === "query_worker" ? "QueryWorker"
    : m.threadback ? "深度分析"
    : m.role === "assistant" ? "Assistant" : "System";
  // Trim leading/trailing blank lines from the answer (the model often emits a
  // leading newline). Keep interior whitespace; while streaming, only trim the
  // start so the cursor doesn't jump.
  const body = m.streaming ? m.text.replace(/^\s+/, "") : m.text.trim();
  // ★ 丝滑修复: 不再对 body 叠加第二层节流。body 本身已由统一 flush (80ms) 限速,
  //   token 只在每次 flush 时批量并入 → Markdown 天然 ~12.5fps 重解析。再套一层
  //   120ms useThrottledValue 会与 flush 相位错开, 产生"一段段"拍频。直接用 body。
  // ── Watcher per-round report: 头部行 (🔬 label·第N段 + [时段区间] + 时间, #id 右对齐) +
  //    正文受控折叠 (默认折叠露第一行行末省略, 点三角展开全文)。Ephemeral, 不入 history。
  if (m.subRole === "watcher_report") {
    return <WatcherReportBubble m={m} onPlay={onPlay} />;
  }
  // ★ 纯思考态: assistant 流式中、还没有正文 → 只渲染一小行 💭 状态文字, 用隐形头像列
  //   占位与 UserMessage/正文气泡左缘对齐。工具卡/监控/深度/QueryWorker 各有形态均不走
  //   这条。★ inToolCall (本轮已产生 tool 条目) 时【也走这条】: 工具调用提示 (toolActivity)
  //   直接写进 💭 位置, 不再翻到"完整空气泡 + ▍"分支 (不出空 AssistantMessage); 待正文
  //   落地或本轮结束后思考行消失, 再由完整正文气泡一次性渲染。判据与 isPureThinkingChat
  //   一致 (见其定义), 保证 renderRow 的 spacing/派生与此处渲染同步。
  if (isPureThinkingChat(m)) {
    return <ThinkingLine msg={m} toolActivity={toolActivity} />;
  }
  return (
    <div className="flex gap-2">
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        m.subRole === "monitor" ? "bg-amber-500 text-black"
          : m.subRole === "router" ? "bg-violet-500 text-white"
          : m.subRole === "query_worker" ? "bg-cyan-400 text-black"
          : m.role === "user" ? "bg-emerald-500 text-black"
          : m.role === "assistant" ? "bg-sky-400 text-black"
          : "bg-muted text-foreground"}`}>
        {m.subRole === "monitor" ? "👁" : m.subRole === "router" ? "🔬"
          : m.subRole === "query_worker" ? "Q"
          : m.role === "user" ? "U" : m.role === "assistant" ? "A" : "i"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
          {/* 监控/深度气泡: 只显示 [事件tab #id] + 时间, 不显示角色名/模型名 (对齐桌面端形态)。
              普通 user/assistant: 角色名 + 时间 + 模型徽标。 */}
          {m.deepResearch ? (
            <Badge tone="outline"
              className={`border-violet-400/60 text-violet-300${
                m.requestId && onReopenDeep ? " cursor-pointer hover:bg-violet-400/15" : ""}`}
              title={m.requestId ? "点击重新打开该深度研究(只读)" : ""}
              onClick={m.requestId && onReopenDeep ? () => onReopenDeep(m.requestId as string) : undefined}>
              {`🔬 ${m.brief || "深度分析"}${m.requestId ? ` #${m.requestId}` : ""}`}
            </Badge>
          ) : m.monitorId ? (
            <Badge tone="outline" className="border-amber-400/60 text-amber-300">
              {m.monitorLabel || "监控"}
            </Badge>
          ) : (
            roleName
          )}
          {m.createdAt != null && (
            <span className="tabular-nums text-muted-foreground/60">{fmtClock(m.createdAt)}</span>
          )}
          {/* 模型名只在普通 assistant 回复显示; 监控/深度气泡不显示。 */}
          {m.role === "assistant" && !m.isError && !m.monitorId
            && !m.deepResearch && m.subRole !== "query_worker" && model && (
            <Badge tone="secondary" className="ml-1">{model}</Badge>
          )}
          {m.voice && <Badge tone="secondary" className="ml-1">🎤 语音</Badge>}
          {m.queued && (
            <Badge tone="outline" className="ml-1">
              {m.queuePosition ? `排队 #${m.queuePosition}` : "排队中"}
            </Badge>
          )}
          {onPlay && m.role === "assistant" && !m.isError && !m.streaming && m.text.trim() && (
            <button
              onClick={() => onPlay(m.text)}
              title="播放语音"
              className="ml-1 inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/60 hover:text-primary">
              <Play className="h-3 w-3" /> 播放
            </button>
          )}
          {/* 监控事件 id 挪到框外最右侧右对齐 (对齐 watcher 汇报形态)。 */}
          {m.monitorId && (
            <span className="ml-auto font-mono text-muted-foreground/50">#{m.monitorId}</span>
          )}
        </div>
        {/* AssistantMessage 第一行 —— 事件驱动状态机:
            - streaming + 未收到任何 delta        → "Waiting response…"
            - streaming + 收到 reasoning 但无内容 → "Thinking…"
            - streaming + 有 reasoning 内容
                * 有 reasoningSummary (aux 生成的 ~10 字 label) → 显示 summary
                * 无 aux (失败/未启用) → 原 reasoning 最后一行滚动
            - 首个 message.delta 落地后 → 整行消失 (但 m.reasoning 后台保留)。
            推理完成 (!streaming) 也一并隐藏, 后台记录仅供下一轮 API 回传。 */}
        {m.role === "assistant" && m.streaming && !body && !m.isError && !inToolCall && (
          <ThinkingLine msg={m} />
        )}
        {(body || m.streaming) && (
          <div className={`break-words rounded-md px-3 py-2 text-sm ${
            m.isError ? "bg-red-500/15 text-red-400"
              : m.subRole === "monitor" ? "bg-amber-950/40 border-l-2 border-amber-400/50"
              : m.subRole === "router" ? "bg-violet-950/40 border-l-2 border-violet-400/50"
              : m.subRole === "query_worker" ? "bg-cyan-950/30 border-l-2 border-cyan-400/50"
              : m.role === "user" ? "bg-emerald-950/40" : "bg-muted/50"}`}>
            {m.queued && !body ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                等待前一条回答完成
                <span className="animate-pulse">…</span>
              </span>
            ) : m.role === "assistant" && !m.isError ? (
              // 流式渲染直接吃 body (唯一节流是 80ms 统一 flush, 见上); Markdown 的
              // streaming prop 画尾部光标并容忍半开语法; 完成后 body 即最终全文。
              // ★ 工具调用进行中 (inToolCall) 或还没落字的空 body 流式态 → Markdown
              // 空内容不画光标, 手动补一个 ▍ 让"气泡已就位、正文在路上"这件事看得见。
              m.streaming && !body ? (
                <span className="animate-pulse text-primary">▍</span>
              ) : m.streaming ? (
                <Markdown content={body} streaming={true} />
              ) : (
                <Markdown content={body} streaming={false} />
              )
            ) : (
              <span className="whitespace-pre-wrap">
                {body}
                {m.streaming && <span className="animate-pulse text-primary">▍</span>}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// mm:ss formatter for frame time ranges.
function fmtTs(s?: number): string {
  if (s == null || !isFinite(s)) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// 深度分析面板的段解读 / 最终报告 Markdown。
// ★ 丝滑修复: 不再叠加第二层节流 (原来套 150ms useThrottledValue, 与统一 80ms flush
//   相位错开 → "一段段"拍频)。content 已由 answer_delta 入队合并 + 80ms 统一 flush 限速,
//   这里直接渲染即可; memo 保证只有 content 变化的段才重解析, 不会全列重渲。
const LiveMarkdown = memo(function LiveMarkdown({ content }: { content: string }) {
  return <Markdown content={content} streaming={false} />;
});

// One readable analysis-round card: 🎬 第N段 [mm:ss–mm:ss] → 👁 看到 →
// 🔎/🧩 检索 → 🖼 crops → 📝 就绪. Mirrors the desktop SegmentCard.
// 后端在模型 thought 为空时合成的占位句 (_workers.py)。它们不是真实画面描述,
// 不作为段描述行展示 (否则整段只剩一句没信息量的"可直接解读本段画面")。
const _SYNTH_SAW = new Set(["可直接解读本段画面", "继续观察本段画面"]);
const SegmentCard = memo(function SegmentCard({ s, defaultOpen }: { s: BgSegment; defaultOpen?: boolean }) {
  const range = s.tsRange ? ` ${fmtTs(s.tsRange[0])}–${fmtTs(s.tsRange[1])}` : "";
  // 真实的段描述: 排除后端合成的占位句。
  const desc = s.saw && !_SYNTH_SAW.has(s.saw.trim()) ? s.saw : "";
  const empty = !desc && s.lookups.length === 0 && !s.ready && !(s.crops && s.crops.length)
    && !(s.toolCalls && s.toolCalls.length) && !(s.toolErrors && s.toolErrors.length);
  // req ④: only the current/active segment is expanded by default; older ones
  // fold to a one-line summary the user can click to expand.
  const [open, setOpen] = useState(!!defaultOpen);
  useEffect(() => { setOpen(!!defaultOpen); }, [defaultOpen]);
  return (
    <div className="flex flex-col gap-1 rounded border border-violet-400/30 bg-background/40 px-2 py-1.5 text-[11px]">
      {/* 标题行 (唯一可点击行): ▸/▾ + 第N段 + 时间戳 + 场景标记。 */}
      <button onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left font-semibold text-violet-300">
        <span className="shrink-0">{open ? "▾" : "▸"}</span>
        <span className="shrink-0">🎬 第 {s.seg} 段</span>
        {range && <span className="shrink-0 font-normal text-violet-300/70 tabular-nums">{range}</span>}
        {s.scene && (
          <span className="ml-0.5 truncate rounded bg-violet-400/15 px-1.5 py-0.5 font-normal text-violet-200/90">
            {s.scene}
          </span>
        )}
      </button>
      {/* 标题行下方固定一行文本描述 (来自 s.saw, 不限字数, 可换行成多行)。
          合成占位句已被 desc 过滤掉。 */}
      {desc ? (
        <div className="break-words leading-snug text-muted-foreground">
          {desc}
        </div>
      ) : empty ? (
        <div className="leading-snug text-violet-200/60">⏳ 正在分析这段画面…</div>
      ) : null}
      {/* 💭 思考: 默认折叠 (<details>, 对齐主 Agent), 点击展开看全文。思考中 (本段还没
          ready) 时图标带脉冲动画, 避免被误认为界面卡死。
          🔧 工具调用 / ⚠️ 错误 / 🔎 检索: 始终展示 (过程事实, 非内心独白), 见下方。 */}
      {s.thinking && (
        <details className="text-violet-200/70">
          <summary className="flex cursor-pointer list-none select-none items-center gap-1 leading-snug">
            <span className={s.ready ? "" : "animate-pulse"}>💭</span>
            <span>思考过程{!s.ready && "…"}</span>
            {!s.ready && (
              <span className="ml-0.5 inline-flex gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.3s]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.15s]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-violet-400" />
              </span>
            )}
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words rounded bg-violet-500/5 px-1.5 py-1 leading-snug">
            {s.thinking}
          </div>
        </details>
      )}
      {s.toolCalls && s.toolCalls.map((c, i) => (
        <div key={`tc${i}`} className="break-words leading-snug text-sky-300/80">
          🔧 调用 {c.name}{c.arg ? `(${c.arg})` : ""}
        </div>
      ))}
      {s.toolErrors && s.toolErrors.map((e, i) => (
        <div key={`te${i}`} className="break-words leading-snug text-red-400">
          ⚠️ {e.name} 调用失败:{e.error}
        </div>
      ))}
      {s.lookups.map((l, i) => (
        <div key={i} className="break-words leading-snug text-muted-foreground">
          {l.kind === "search" ? "🔎 搜索" : "🧩 记忆"}「{l.query}」
          {l.result ? ` → ${l.result}` : "…"}
        </div>
      ))}
      {open && (<>
        {s.crops && s.crops.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {s.crops.map((c, i) => (
              <img key={i} src={`data:image/jpeg;base64,${c.jpeg_b64}`} alt={c.label || `crop ${i}`}
                className="h-12 w-auto rounded border object-cover" title={c.label} />
            ))}
          </div>
        )}
        {s.ready && (
          <div className="leading-snug text-violet-100/90">
            {s.answer ? (
              // ★ 段解读走 Markdown 渲染 (支持表格 / LaTeX 公式), 不再纯文本。
              <div className="flex gap-1">
                <span className="shrink-0">📝</span>
                <div className="min-w-0 flex-1"><LiveMarkdown content={s.answer} /></div>
              </div>
            ) : (
              // s.ready 但没有流式 answer 文本: 本段没有独立解读 (通常是模型直接跳到
              // 回答/无额外发现), 内容已并入下方的累积报告 —— 如实说明, 不摆"就绪"空架子。
              <span className="whitespace-pre-wrap text-muted-foreground">
                📝 本段无独立解读，内容已并入下方报告
              </span>
            )}
          </div>
        )}
      </>)}
    </div>
  );
});

// One RouterEngine deep-research sub-window (left column). Renders that
// delegation's streamed bubbles (reusing ChatBubble) + live search/recall
// progress + an optional Clarify follow-up input. Collapsible: only the
// expanded one shows its body.
// 攒帧进度条 (下一段的实时帧计数 + ttl 倒数)。抽成独立组件, 供【固定顶栏】复用 ——
// 现固定渲染在"深度分析 · 标签"标题下方的一行, 不再夹在段卡片之间随内容滚走。
function WaitingBanner({ waiting }: { waiting: NonNullable<BgItem["waiting"]> }) {
  const segPrefix = typeof waiting.seg === "number" ? `Seg ${waiting.seg} · ` : "";
  // paused: 无新帧且 ttl 到 → 后端暂停攒帧, 不倒计时。显示 "Waiting for new frames…", 无进度条。
  if (waiting.paused) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-violet-200/60">
        <span className="inline-flex gap-0.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400/60" />
        </span>
        <span>{segPrefix}Waiting for new frames…</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-[11px] text-violet-200/80">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex gap-0.5">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400" />
        </span>
        <span>
          {segPrefix}Buffering frames… {waiting.have}/{waiting.need}
          {typeof waiting.ttlRemaining === "number" && (
            <span className="ml-1 text-violet-300/70">· ⏱ {Math.max(0, Math.ceil(waiting.ttlRemaining))}s left</span>
          )}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-violet-400/15">
        <div className="h-full rounded bg-violet-400/70 transition-all duration-300"
          style={{ width: `${Math.min(100, waiting.need ? (waiting.have / waiting.need) * 100 : 0)}%` }} />
      </div>
      {typeof waiting.ttlSec === "number" && typeof waiting.ttlRemaining === "number" && waiting.ttlSec > 0 && (
        <div className="h-0.5 w-full overflow-hidden rounded bg-amber-400/15">
          <div className="h-full rounded bg-amber-400/60 transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, waiting.ttlRemaining / waiting.ttlSec) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

const DeepWindow = memo(function DeepWindow({
  rid, item, msgs, model, expanded, onToggle,
}: {
  rid: string;
  item: BgItem | undefined;
  msgs: ChatMsg[];
  model: string;
  expanded: boolean;
  onToggle: (rid: string) => void;
}) {
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  // 用户是否停在底部。仅当停在底部时才随新内容自动下拉; 用户一旦向上翻 (atBottom
  // 变 false) 就不再打断他, 直到他自己滚回底部。onScroll 里用 24px 容差判定。
  const atBottomRef = useRef(true);
  const onBodyScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);
  const streaming = msgs.some((m) => m.streaming);
  const shortId = rid.replace(/^req_/, "").slice(0, 6);
  const label = item?.label || "";
  const segments = item?.segments || [];
  const waiting = item?.waiting;
  // Collapsed one-line preview: the waiting banner, else the newest segment's
  // most-informative line, else any streamed answer text — so a folded window is
  // never a blank title bar during long ReAct phases.
  const lastSeg = segments[segments.length - 1];
  const _wSeg = waiting && typeof waiting.seg === "number" ? `Seg ${waiting.seg} · ` : "";
  const segPreview = waiting
    ? (waiting.paused ? `⏳ ${_wSeg}Waiting for new frames…` : `⏳ ${_wSeg}Buffering frames… (${waiting.have}/${waiting.need})`)
    : lastSeg
      ? (lastSeg.saw ? `👁 ${lastSeg.saw}` : `🎬 第 ${lastSeg.seg} 段分析中…`)
      : "";
  // ★ 性能: answerPreview 只在真需要时算 (没有 segPreview 且窗口收起才显示 preview)。
  //   旧代码每次渲染都 msgs.map/join/replace 全量拼接一遍, 展开时根本用不到。
  const answerPreview = useMemo(
    () => (segPreview ? "" : msgs.map((m) => m.text).join(" ").replace(/\s+/g, " ").trim()),
    [segPreview, msgs],
  );
  const preview = segPreview || answerPreview;
  const hasLiveWork = streaming || (item ? !item.done : false);

  useEffect(() => {
    const el = bodyScrollRef.current;
    // 只有用户仍停在底部时才自动下拉; 展开切换时重置为跟随底部。
    if (el && expanded && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs, segments, expanded]);

  return (
    <div className="rounded-md border border-violet-400/40 bg-violet-400/5">
      <button onClick={() => onToggle(rid)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-violet-300">
        <span>{expanded ? "▾" : "▸"}</span>
        <span>🔬 深度分析{label ? ` · ${label}` : ` #${shortId}`}</span>
        {hasLiveWork ? <span className="animate-pulse">…</span>
          : <span className="ml-auto text-[10px] font-normal text-violet-300/60">已完成</span>}
      </button>
      {!expanded && preview && (
        <div className="truncate px-2.5 pb-1.5 text-[11px] text-violet-200/60">
          {preview}
        </div>
      )}
      {/* 攒帧进度条固定在标题正下方一行 (展开时), 不随段卡片滚动而离场。 */}
      {expanded && waiting && (
        <div className="border-t border-violet-400/20 px-2.5 py-1.5">
          <WaitingBanner waiting={waiting} />
        </div>
      )}
      {expanded && (
        <div className="border-t border-violet-400/20 px-2 py-2">
          <div ref={bodyScrollRef} onScroll={onBodyScroll} className="max-h-64 space-y-2 overflow-y-auto">
            {/* 段卡片: 旧段折叠 + 当前段展开。攒帧进度条已移到固定顶栏 (标题下方),
                不再夹在段之间随滚动离场。 */}
            {(() => {
              const older = segments.slice(0, Math.max(0, segments.length - 1));
              const last = segments.length > 0 ? segments[segments.length - 1] : null;
              return (
                <>
                  {older.length > 0 && (
                    <div className="space-y-1.5">
                      {older.map((s) => (
                        <SegmentCard key={s.seg} s={s} defaultOpen={false} />
                      ))}
                    </div>
                  )}
                  {last && (
                    <div className="space-y-1.5">
                      <SegmentCard key={last.seg} s={last} defaultOpen={true} />
                    </div>
                  )}
                </>
              );
            })()}
            {!answerPreview && hasLiveWork && segments.length === 0 && !waiting && (
              <div className="text-[11px] text-violet-200/70">
                深度分析启动中…
              </div>
            )}
            {/* Final consolidated report (watcher.final) — the authoritative
                result, shown in-panel; the main agent chat is never touched. */}
            {item?.finalReport && (
              <div className="rounded-md border border-violet-400/50 bg-violet-400/10 p-2">
                <div className="mb-1 text-[11px] font-medium text-violet-200">📋 最终报告</div>
                <div className="text-[12px] leading-relaxed text-violet-50">
                  {/* ★ 最终报告走 Markdown (表格 / LaTeX 公式), 不再纯文本。
                      节流解析 (LiveMarkdown): 长报告在同帧与主 agent 并发时不再双 O(n²) 撑爆主线程。 */}
                  <LiveMarkdown content={item.finalReport} />
                </div>
              </div>
            )}
            {msgs.map((m) => (
              <ChatBubble key={m.id} m={m} model={model} onPlay={NOOP_PLAY} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

/* ================================================================== */
/*  Column components (perf: isolate re-renders)                       */
/*  三列各自 memo 化: 任一 setState 只重渲染其数据切片所在的那一列, 而不是                */
/*  整个 3500 行 render body。父组件仍持有全部 state + 派生值, 只负责把                  */
/*  【引用稳定】的 props 传下去 —— 无关的 setState (frameCount 1/s /                  */
/*  anchor / ctx / bgItems) 不改动某列的 props → 该列 memo 命中、跳过。                */
/* ================================================================== */

// grouped waterfall row (chat bubble | background progress block). Hoisted to
// module scope so the column components can reference it.
type Row =
  | { type: "chat"; msg: ChatMsg }
  | { type: "bg"; id: string; items: ChatMsg[] };

type WatcherReg = { watcher_id: string; label?: string; task_instruction?: string; status?: string };
type MonitorReg = MonitorRegistryItem;
// One proactive alert emitted by a monitor. Alerts render inline under their
// monitor row in the right registry (never as center-chat bubbles).
type MonitorAlert = { id: string; text: string; ts: number; streaming?: boolean };
type MmToast = { id: string; level: string; text: string };
type AnchorFrame = { ts: number | null; jpeg_b64: string };

/* ── LEFT column: 视频 + 注入帧 + 画面/音频观察 + 搜索事实 ────────────────── */
const LeftPanels = memo(function LeftPanels({
  sourceType, frameCount, anchorFrames, ctxVersion, obs, audioObs, factsList,
  videoRef, obsScrollRef, audioObsScrollRef,
  onStartCamera, onStopStream, onStartScreen,
}: {
  sourceType: SourceType;
  frameCount: number;
  anchorFrames: AnchorFrame[];
  ctxVersion: number;
  obs: ObsItem[];
  audioObs: ObsItem[];
  factsList: [string, string][];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  obsScrollRef: React.RefObject<HTMLDivElement | null>;
  audioObsScrollRef: React.RefObject<HTMLDivElement | null>;
  onStartCamera: () => void;
  onStopStream: () => void;
  onStartScreen: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
      <Card>
        <CardContent className="p-3">
          <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-black [contain:strict]">
            <video ref={videoRef} autoPlay playsInline muted
              className="h-full w-full object-cover [transform:translateZ(0)]" />
            {!sourceType && (
              <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-white">未开启画面</div>
            )}
            {sourceType && (
              <div className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                REC · {sourceType === "camera" ? "摄像头" : "屏幕"} · {frameCount} 帧
              </div>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button size="sm" prefix={<Camera />}
              destructive={sourceType === "camera"} disabled={sourceType === "screen"}
              onClick={() => (sourceType === "camera" ? onStopStream() : onStartCamera())}>
              {sourceType === "camera" ? "停止摄像头" : "启动摄像头"}
            </Button>
            <Button size="sm" prefix={<Monitor />}
              destructive={sourceType === "screen"} outlined={sourceType !== "screen"}
              disabled={sourceType === "camera"}
              onClick={() => (sourceType === "screen" ? onStopStream() : onStartScreen())}>
              {sourceType === "screen" ? "停止共享" : "共享屏幕"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ② Anchor debug: frames the vision model saw this turn */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
            🎯 注入帧 {anchorFrames.length > 0 && <span className="text-primary">· {anchorFrames.length}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {anchorFrames.length === 0
            ? <div className="text-xs italic text-muted-foreground">(提问时若有画面流,这里显示模型本回合实际看到的帧)</div>
            : (
              <div className="flex gap-1.5 overflow-x-auto">
                {anchorFrames.map((f, i) => (
                  <div key={i} className="flex-shrink-0">
                    <img src={`data:image/jpeg;base64,${f.jpeg_b64}`} alt={`frame ${i}`}
                      className="h-16 w-auto cursor-zoom-in rounded border"
                      onClick={() => window.open(`data:image/jpeg;base64,${f.jpeg_b64}`, "_blank")} />
                    {f.ts != null && <div className="mt-0.5 text-center text-[10px] text-muted-foreground">{f.ts.toFixed(1)}s</div>}
                  </div>
                ))}
              </div>
            )}
        </CardContent>
      </Card>

      {/* ③ 画面观察 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
            画面观察 <span className="text-primary">v{ctxVersion}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div ref={obsScrollRef} className="max-h-52 space-y-2 overflow-y-auto rounded border bg-background/50 p-2 text-xs">
            {obs.length === 0
              ? <span className="italic text-muted-foreground">(空)</span>
              : obs.map((o, i) => (
                  <div key={`obs-${i}`} className="rounded border border-border/60 bg-background/60 p-2">
                    <div className="mb-1 flex items-center gap-1">
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-400">{o.ts}</span>
                      {o.speaker ? <span className="text-[10px] text-muted-foreground">{o.speaker}</span> : null}
                    </div>
                    <div className="whitespace-pre-wrap leading-snug">{o.text}</div>
                  </div>
                ))}
          </div>
        </CardContent>
      </Card>

      {/* ④ 音频观察 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">音频观察</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div ref={audioObsScrollRef} className="max-h-44 space-y-2 overflow-y-auto rounded border bg-background/50 p-2 text-xs">
            {audioObs.length === 0
              ? <span className="italic text-muted-foreground">(共享屏幕并分享音频后才有)</span>
              : audioObs.map((o, i) => (
                  <div key={`aobs-${i}`} className="rounded border border-border/60 bg-background/60 p-2">
                    <div className="mb-1 flex items-center gap-1">
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-400">{o.ts}</span>
                      {o.speaker ? <span className="text-[10px] text-muted-foreground">🗣 {o.speaker}</span> : null}
                    </div>
                    <div className="whitespace-pre-wrap leading-snug">{o.text}</div>
                  </div>
                ))}
          </div>
        </CardContent>
      </Card>

      {/* ⑤ SearchFactStore: 外部检索证据 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">搜索事实</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="max-h-48 overflow-y-auto rounded border bg-background/50 p-2 text-xs">
            {factsList.length === 0
              ? <span className="italic text-muted-foreground">(暂无)</span>
              : <ul className="space-y-1">{factsList.map(([k, v]) => (
                  <li key={k}><span className="text-violet-400">{k}</span>: {String(v)}</li>
                ))}</ul>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
});

/* ── MIDDLE column: 聊天列 + AsrBar + ChatComposer ────────────────────── */
const ChatColumn = memo(function ChatColumn({
  rows, renderRow, itemKey, atBottom, chatScrollRef, onChatScroll, scrollChatToBottom,
  chatAtBottomRef, isRecordingUI, asrPartial, asrBuffer,
  micState, ttsEnabled, onTtsToggle,
  voiceDialogEnabled, onVoiceDialogToggle,
  generating, onStop, onSend, onMicToggle,
}: {
  rows: Row[];
  renderRow: (i: number, row: Row) => React.ReactNode;
  itemKey: (i: number, row: Row) => string;
  atBottom: boolean;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  onChatScroll: () => void;
  scrollChatToBottom: (smooth?: boolean) => void;
  chatAtBottomRef: React.RefObject<boolean>;
  isRecordingUI: boolean;
  asrPartial: string;
  asrBuffer: string[];
  micState: "idle" | "connecting" | "recording";
  ttsEnabled: boolean;
  onTtsToggle: () => void;
  voiceDialogEnabled: boolean;
  onVoiceDialogToggle: () => void;
  generating: boolean;
  onStop: () => void;
  onSend: (text: string) => void;
  onMicToggle: () => void;
}) {
  // ★ 自动跟随底部 (替代 Virtuoso followOutput)。仅当用户原本就在底部才下拉。
  //   移进 ChatColumn: 只在 rows 变(消息/流式)时跑, 不再被 ctx/anchor/frameCount 触发。
  useLayoutEffect(() => {
    if (chatAtBottomRef.current) scrollChatToBottom(false);
  }, [rows, scrollChatToBottom, chatAtBottomRef]);
  return (
    <Card className="relative flex min-h-0 min-w-0 flex-col">
      {/* ★ 普通滚动 div 全量渲染 (取代 react-virtuoso —— 它对流式大表格会测量死循环)。
          消息量由 capMsgs 软上限兜底。min-w-0: 让列可收缩, 超长不换行内容(长英文
          标题/表格)不撑破列宽 → 消除切屏后右侧溢出。 */}
      <div
        ref={chatScrollRef}
        onScroll={onChatScroll}
        className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-3 pb-24 pt-3"
      >
        {rows.map((row, _i) => {
          // renderRow 可能返回 null (如流式期间被隐藏的"处理过程"bg 行) —— 此时不发出
          // 空 wrapper div, 避免 space-y-3 在其位置留下一段幽灵间距。
          const el = renderRow(_i, row);
          return el == null ? null : <div key={itemKey(_i, row)}>{el}</div>;
        })}
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollChatToBottom(true)}
          title="跳到最新"
          className="absolute bottom-20 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-md backdrop-blur hover:text-foreground">
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
      <AsrBar recording={isRecordingUI} partial={asrPartial} buffer={asrBuffer} />
      <ChatComposer
        micState={micState}
        ttsEnabled={ttsEnabled}
        onTtsToggle={onTtsToggle}
        voiceDialogEnabled={voiceDialogEnabled}
        onVoiceDialogToggle={onVoiceDialogToggle}
        generating={generating}
        onStop={onStop}
        onSend={onSend}
        onMicToggle={onMicToggle}
      />
    </Card>
  );
});

/* ── 监控 / 深度分析 注册表 (右列顶部) ─────────────────────────────────── */
const RegistryPanels = memo(function RegistryPanels({
  monitors, watchers, onToggleMonitor, onToggleWatcher,
}: {
  monitors: MonitorReg[];
  watchers: WatcherReg[];
  onToggleMonitor: (m: MonitorReg) => void;
  onToggleWatcher: (w: WatcherReg) => void;
}) {
  return (
    <>
      {/* ① Monitor registry (multi-instance, set_monitor CRUD) */}
      {monitors.some((m) => m.status !== "deleted") && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
              👁 监控任务 <span className="text-amber-300">· {monitors.filter((m) => m.status !== "deleted").length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-2 text-[11px]">
            {monitors.filter((m) => m.status !== "deleted").map((m) => {
              const { active: on, canToggle, done, modeLabel, statusLabel } = monitorPresentation(m);
              const label = (m.label && m.label.trim()) || m.brief.slice(0, 10) || "监控";
              return (
                <div key={m.monitor_id}
                  className={`flex items-center justify-between gap-2 rounded border px-2.5 py-2 ${
                    done ? "border-emerald-400/30 bg-emerald-400/5"
                    : on ? "border-amber-400/30 bg-amber-400/5"
                    : "border-border/40 bg-muted/20 opacity-60"}`}>
                  {/* label · 触发模式 · 状态 · #事件号 同一行。 */}
                  <span className={`flex min-w-0 flex-1 items-baseline gap-1 break-words leading-tight ${
                    done ? "text-emerald-200" : on ? "text-amber-200" : "text-muted-foreground"}`}
                    title={`${label} · ${modeLabel} · ${statusLabel} · #${m.monitor_id}`}>
                    <span className="truncate">{label}</span>
                    <span className="shrink-0 rounded border border-current/20 px-1 text-[9px] opacity-75">{modeLabel}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">· {statusLabel}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/45">· #{m.monitor_id}</span>
                  </span>
                  <button
                    type="button"
                    disabled={!canToggle}
                    onClick={() => canToggle && onToggleMonitor(m)}
                    title={done
                      ? "单次监控已完成；如需再等待一次，请新建监控"
                      : on ? "点击暂停该监控" : "点击恢复该监控"}
                    aria-label={`${label}：${statusLabel}`}
                    className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors ${
                      done ? "cursor-not-allowed bg-emerald-400/35"
                      : on ? "bg-amber-400/70" : "bg-muted-foreground/30"}`}>
                    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all ${
                      on ? "left-3.5" : "left-0.5"}`} />
                  </button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ①b Active watchers registry (set_live_watcher CRUD + reopen). */}
      {watchers.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
              🔬 深度分析 <span className="text-violet-300">· {watchers.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-2 text-[11px]">
            {watchers.filter((w) => w.status !== "deleted").map((w) => {
              const on = w.status === "running";
              const label = (w.label && w.label.trim())
                || (w.task_instruction || "").slice(0, 12) || "深度分析";
              // ★ 五态标签: running=进行中 / done=已完成 / stopping=正在停止 /
              //   interrupted=已中断(需开流重启)。
              const statusLabel =
                w.status === "running" ? "进行中"
                : w.status === "done" ? "已完成"
                : w.status === "stopping" ? "正在停止"
                : "已中断";
              return (
                <div key={w.watcher_id}
                  className={`flex items-center justify-between gap-2 rounded border px-2.5 py-2 ${
                    on ? "border-violet-400/30 bg-violet-400/5" : "border-border/40 bg-muted/20 opacity-60"}`}>
                  {/* label · 状态 · #事件号 同一行 (溢出截断)。 */}
                  <span className={`flex min-w-0 flex-1 items-baseline gap-1 break-words leading-tight ${
                    on ? "text-violet-200" : "text-muted-foreground"}`}
                    title={`${label} · ${statusLabel} · #${w.watcher_id}`}>
                    <span className="truncate">{label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">· {statusLabel}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/45">· #{w.watcher_id}</span>
                  </span>
                  <button
                    onClick={() => onToggleWatcher(w)}
                    title={on ? "点击暂停该分析" : "点击恢复该分析(需视频流)"}
                    className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors ${
                      on ? "bg-violet-400/70" : "bg-muted-foreground/30"}`}>
                    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all ${
                      on ? "left-3.5" : "left-0.5"}`} />
                  </button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </>
  );
});

/* ── Per-monitor alert panel: title bar (collapsible) + up to 2 latest hits +
   "展开更多" expander to reveal all history. Amber-themed to match the monitor
   registry row. Display-only (the enable/disable toggle stays on the registry
   card above). */
const MONITOR_ALERTS_VISIBLE = 2;
const MonitorPanel = memo(function MonitorPanel({
  monitor, alerts, collapsed, expanded, onToggleCollapsed, onToggleExpanded,
}: {
  monitor: MonitorReg;
  alerts: MonitorAlert[];
  collapsed: boolean;                 // title-bar arrow
  expanded: boolean;                  // "展开更多" → show all vs. only latest 2
  onToggleCollapsed: (mid: string) => void;
  onToggleExpanded: (mid: string) => void;
}) {
  const mid = monitor.monitor_id;
  const label = (monitor.label && monitor.label.trim())
    || monitor.brief.slice(0, 12) || "监控";
  const { active: on, done, modeLabel, statusLabel } = monitorPresentation(monitor);
  const streaming = alerts.some((a) => a.streaming);
  const hiddenCount = Math.max(0, alerts.length - MONITOR_ALERTS_VISIBLE);
  const shown = expanded ? alerts : alerts.slice(-MONITOR_ALERTS_VISIBLE);
  return (
    <div className={`rounded-md border ${
      done ? "border-emerald-400/35 bg-emerald-400/5"
      : on ? "border-amber-400/40 bg-amber-400/5"
      : "border-border/40 bg-muted/20 opacity-70"}`}>
      {/* Title bar — click to collapse/expand the whole panel. */}
      <button onClick={() => onToggleCollapsed(mid)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-amber-200">
        <span className="shrink-0 text-amber-300/70">{collapsed ? "▸" : "▾"}</span>
        <span>👁</span>
        <span className="min-w-0 truncate">监控 · {label}</span>
        <span className="shrink-0 rounded border border-current/20 px-1 text-[9px] font-normal opacity-70">{modeLabel}</span>
        {streaming
          ? <span className="animate-pulse text-amber-300/70">…</span>
          : <span className="shrink-0 text-[10px] font-normal text-amber-300/60">· {statusLabel}</span>}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-amber-300/45">#{mid}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-amber-400/20 px-2 py-2">
          {alerts.length === 0 && (
            <div className="text-[11px] text-amber-200/70">
              {done ? "单次监控已完成" : on ? "监控中,暂无命中…" : "监控已暂停"}
            </div>
          )}
          {hiddenCount > 0 && (
            <button onClick={() => onToggleExpanded(mid)}
              className="mb-1.5 text-[10px] text-amber-300/70 hover:text-amber-200">
              {expanded ? "▾ 收起早期" : `▸ 展开更多 (${hiddenCount})`}
            </button>
          )}
          <div className={`space-y-1.5 ${expanded ? "max-h-64 overflow-y-auto" : ""}`}>
            {shown.map((a) => (
              <div key={a.id}
                className="rounded border-l-2 border-amber-400/50 bg-amber-950/30 px-2 py-1.5">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-amber-300/60">
                  <span className="tabular-nums">{fmtClock(a.ts)}</span>
                  {a.streaming && <span className="animate-pulse">…</span>}
                </div>
                <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-amber-50">
                  {a.text || (a.streaming ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

/* ── RIGHT column: 监控/深研注册表 + 监控 panel + 深研窗口 + toast ────────── */
const DeepColumn = memo(function DeepColumn({
  showDeepCol, mmToasts, monitors, watchers, onToggleMonitor, onToggleWatcher,
  visibleDeep, bgByRid, deepExpanded, model, onToggleDeep,
  monitorAlerts, monitorCollapsed, monitorExpanded,
  onToggleMonitorCollapsed, onToggleMonitorExpanded,
}: {
  showDeepCol: boolean;
  mmToasts: MmToast[];
  monitors: MonitorReg[];
  watchers: WatcherReg[];
  onToggleMonitor: (m: MonitorReg) => void;
  onToggleWatcher: (w: WatcherReg) => void;
  visibleDeep: { rid: string; msgs: ChatMsg[] }[];
  bgByRid: Map<string, BgItem>;
  deepExpanded: string | null;
  model: string;
  onToggleDeep: (rid: string) => void;
  monitorAlerts: Map<string, MonitorAlert[]>;
  monitorCollapsed: Set<string>;
  monitorExpanded: Set<string>;
  onToggleMonitorCollapsed: (mid: string) => void;
  onToggleMonitorExpanded: (mid: string) => void;
}) {
  if (!showDeepCol) return null;
  // Monitor panels: display in the order the monitors were created (registry
  // is already sorted by created_at asc — the earliest sits at the top). Users
  // asked for this stacking so a session with multiple monitors reads as a
  // stable timeline.
  const activeMonitors = monitors
    .filter((m) => m.status !== "deleted")
    .slice()
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return (
    <div className="relative flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto">
      {/* 底部 toast 小框栈 (监控/深度研究过程失败/停用, 3s 淡出)。 */}
      {mmToasts.length > 0 && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 flex flex-col gap-1.5">
          {mmToasts.map((t) => (
            <div key={t.id}
              className={`mm-toast-in pointer-events-auto rounded-md border px-2.5 py-1.5 text-[11px] leading-snug shadow-md backdrop-blur-sm ${
                t.level === "warning"
                  ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
                  : t.level === "info"
                    ? "border-border/50 bg-muted/40 text-muted-foreground"
                    : "border-red-400/40 bg-red-500/10 text-red-300"}`}>
              {t.text}
            </div>
          ))}
        </div>
      )}
      {/* 监控 / 深度分析 注册表: 置于深度研究窗口之上 (对齐桌面端 deep-panel)。 */}
      <RegistryPanels
        monitors={monitors}
        watchers={watchers}
        onToggleMonitor={onToggleMonitor}
        onToggleWatcher={onToggleWatcher}
      />
      {/* Monitor alert panels — one per active monitor, stacked in creation
          order. Each shows latest 2 alerts by default, expandable to full
          history; the title bar arrow collapses the whole panel. */}
      {activeMonitors.map((m) => (
        <MonitorPanel
          key={m.monitor_id}
          monitor={m}
          alerts={monitorAlerts.get(m.monitor_id) || []}
          collapsed={monitorCollapsed.has(m.monitor_id)}
          expanded={monitorExpanded.has(m.monitor_id)}
          onToggleCollapsed={onToggleMonitorCollapsed}
          onToggleExpanded={onToggleMonitorExpanded}
        />
      ))}
      {visibleDeep.map(({ rid, msgs }, i) => {
        const streaming = msgs.some((m) => m.streaming);
        const ridBg = bgByRid.get(rid);
        const ridBusy = streaming || (ridBg ? !ridBg.done : false);
        // Explicit user choice for this rid wins (open or the "" collapse
        // sentinel). Otherwise: expand while streaming/busy, else newest.
        const userChoice = deepExpanded === rid;
        const userCollapsed = deepExpanded === "";
        const expanded = userChoice
          || (!userCollapsed && (ridBusy || (deepExpanded === null && i === 0)));
        return (
          <DeepWindow
            key={rid}
            rid={rid}
            msgs={msgs}
            item={ridBg}
            model={model}
            expanded={expanded}
            onToggle={onToggleDeep}
          />
        );
      })}
    </div>
  );
});

interface MmTrajectoryFrame {
  frame_id?: string;
  ts?: number;
  jpeg_b64?: string;
  thumb_b64?: string;
  source_type?: string;
}

interface MmTrajectoryEntry {
  id: string;
  seq: number;
  ts: number;
  event: string;
  worker: string;
  phase: string;
  payload: Record<string, unknown>;
}

/**
 * Bound image bytes in the inspector's trajectory copy. QueryWorker entries
 * keep their structured payload and frame metadata; only old base64 fields are
 * evicted. This is separate from the progress-card cache because the Debug
 * inspector also retains the normalized trajectory rows.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function compactQueryWorkerTrajectory(
  entries: MmTrajectoryEntry[],
): MmTrajectoryEntry[] {
  const taskOrder: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const taskId = typeof entry.payload?.task_id === "string"
      ? entry.payload.task_id : "";
    if (!taskId) continue;
    if (seen.has(taskId)) {
      taskOrder.splice(taskOrder.indexOf(taskId), 1);
    } else {
      seen.add(taskId);
    }
    taskOrder.push(taskId);
  }
  const newest = taskOrder.at(-1) || "";
  const imageTasks = recentTaskIds(taskOrder);
  const protectedChars = entries.reduce((total, entry) => {
    const p = entry.payload || {};
    if (p.task_id !== newest || String(entry.phase || p.phase) !== "started") {
      return total;
    }
    const frames = Array.isArray(p.frames) ? p.frames.filter(isRecord) : [];
    return total + frames.reduce(
      (sum, frame) => sum + frameImageChars(frame as MmTrajectoryFrame), 0,
    );
  }, 0);
  const remaining = {
    chars: Math.max(0, QUERY_WORKER_IMAGE_CHAR_BUDGET - protectedChars),
  };

  return entries.slice().reverse().map((entry) => {
    const p = entry.payload || {};
    const taskId = typeof p.task_id === "string" ? p.task_id : "";
    const rawFrames = Array.isArray(p.frames) ? p.frames : null;
    if (!taskId || !rawFrames?.length) return entry;
    const protectedInput = taskId === newest
      && String(entry.phase || p.phase) === "started";
    const frames = rawFrames.map((value) => {
      if (!isRecord(value)) return value;
      return imageTasks.has(taskId)
        ? compactFrames([value as MmTrajectoryFrame], remaining, protectedInput)?.[0] || value
        : withoutFrameImage(value as MmTrajectoryFrame);
    });
    return { ...entry, payload: { ...p, frames } };
  }).reverse();
}

export function queryWorkerProgressFromTrajectory(item: MmTrajectoryEntry): {
  taskId: string;
  step: QueryWorkerProgressStep;
} | null {
  const p = item.payload || {};
  const taskId = typeof p.task_id === "string" ? p.task_id : "";
  const parentId = typeof p.parent_user_message_id === "string"
    ? p.parent_user_message_id : "";
  if (!taskId || (!taskId.startsWith("qry_") && !parentId)) return null;
  const ev = isRecord(p.event) ? p.event : {};
  const outerPhase = String(item.phase || p.phase || "progress");
  const phase = String(ev.phase || ev.type || outerPhase);
  const channel = String(ev.channel || p.channel || "").toLowerCase();
  // Raw token-level thinking would add hundreds of rows and is not part of the
  // public execution trace.  Decisions below are synthesized from structured
  // fields (can_answer/tool calls/evidence), while every Recall/Search action
  // remains inspectable.
  if (outerPhase === "router_thinking" || phase === "router_thinking") return null;

  let worker = String(item.worker || "QueryWorker");
  if (channel === "recall" || outerPhase === "recall_done") worker = "RecallWorker";
  if (channel === "search" || outerPhase === "search_done") worker = "SearchWorker";
  let title = phase;
  let detail = "";
  let metrics: string[] = [];
  let plannedTools: RecallTraceToolCall[] = [];
  let toolResults: RecallTraceToolObs[] = [];
  let ocrRecords: QueryWorkerOcrRecord[] = [];
  let ocrState: QueryWorkerProgressStep["ocrState"];
  let ocrReason: string | undefined;
  let ocrRecordCount: number | undefined;
  let ocrElapsedSec: number | undefined;
  let status: QueryWorkerProgressStep["status"] = "running";
  let terminal = false;
  const roundRaw = Number(ev.round);
  const decisionRound = /^r(\d+)_decision$/.exec(phase);
  const round = Number.isFinite(roundRaw)
    ? roundRaw + 1
    : decisionRound ? Number(decisionRound[1]) + 1 : undefined;
  const observations = Array.isArray(ev.observations)
    ? ev.observations.filter(isRecord) : [];
  const recallTasks = Array.isArray(ev.recall_tasks) ? ev.recall_tasks : [];
  const toolCalls = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
  const rawFrames = Array.isArray(p.frames) ? p.frames : [];
  const elapsedRaw = Number(ev.elapsed_sec ?? p.elapsed_sec);
  const elapsed = Number.isFinite(elapsedRaw) ? elapsedRaw : undefined;
  const clipMetric = sourceClipMetric(ev.source_clip ?? p.source_clip);
  const taskRef = typeof ev.task_id === "string" && ev.task_id !== taskId
    ? ev.task_id : undefined;
  let callState: QueryWorkerProgressStep["callState"];
  const addMetric = (value: string | undefined) => {
    if (value) metrics.push(value);
  };

  if (outerPhase === "started") {
    title = `接手问题并锁定提问时刻 · 冻结输入帧 ${Number(p.n_frames || 0)}`;
    addMetric(Number(p.ask_ts) ? `ask_ts ${Number(p.ask_ts).toFixed(1)}s` : undefined);
  } else if (outerPhase === "ocr_evidence") {
    worker = "OCR";
    ocrRecords = normalizeQueryWorkerOcrRecords(
      p.evidence ?? p.records ?? ev.evidence ?? ev.records,
    );
    const countRaw = Number(p.record_count ?? ev.record_count ?? ocrRecords.length);
    ocrRecordCount = Number.isFinite(countRaw) && countRaw >= 0
      ? Math.floor(countRaw) : ocrRecords.length;
    const elapsedOcrRaw = Number(p.elapsed_sec ?? ev.elapsed_sec);
    ocrElapsedSec = Number.isFinite(elapsedOcrRaw) && elapsedOcrRaw >= 0
      ? elapsedOcrRaw : undefined;
    ocrReason = String(p.reason ?? ev.reason ?? "").trim() || undefined;
    const stateRaw = String(
      p.evidence_state ?? ev.evidence_state ?? p.status ?? ev.status ?? "",
    ).trim().toLowerCase();
    if (stateRaw === "skipped") {
      ocrState = "skipped";
    } else if (stateRaw === "timeout" || ocrReason === "deadline_exceeded") {
      ocrState = "timeout";
    } else if (stateRaw === "error" || stateRaw === "failed") {
      ocrState = "error";
    } else if (ocrRecords.length || ocrRecordCount > 0 || stateRaw === "available") {
      ocrState = "available";
    } else {
      ocrState = "empty";
    }
    status = ocrState === "timeout" || ocrState === "error" ? "error" : "complete";
    title = ocrState === "available"
      ? `OCR 辅助文字 · ${ocrRecordCount} 条`
      : ocrState === "skipped" ? "OCR 辅助文字 · 已跳过"
        : ocrState === "timeout" ? "OCR 辅助文字 · 超时"
          : ocrState === "error" ? "OCR 辅助文字 · 提取失败"
            : "OCR 辅助文字 · 未识别到文字";
  } else if (outerPhase === "delegate_start") {
    title = "开始分析问题，准备决定 Recall / Search";
  } else if (outerPhase === "router_react") {
    const noTools = recallTasks.length === 0 && toolCalls.length === 0;
    title = noTools
      ? "完成一轮规划 · 本轮未调用 Recall / Search"
      : `完成一轮规划${recallTasks.length ? ` · Recall ${recallTasks.length}` : ""}${toolCalls.length ? ` · Search ${toolCalls.length}` : ""}`;
    plannedTools = [
      ...toolCalls.filter(isRecord).map((call) => ({
        name: String(call.name || "search tool"),
        ...(isRecord(call.args) ? { args: call.args } : {}),
        ...(typeof call.anchor === "string" ? { anchor: call.anchor } : {}),
      })),
      ...recallTasks.filter(isRecord).map((call) => ({
        name: "recall_memory",
        args: { brief: String(call.brief || "") },
      })),
    ];
    callState = "planned";
    addMetric(round ? `外层第 ${round} 轮` : undefined);
    addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
  } else if (outerPhase === "recall_skipped") {
    worker = "RecallWorker";
    title = ev.reason === "retry_limit_after_two_failures"
      ? "停止重试 Recall · 相同任务已连续失败 2 次"
      : "跳过重复 Recall · 已用本次分析的召回结果";
    detail = String(ev.brief || "");
    addMetric(round ? `外层第 ${round} 轮` : undefined);
  } else if (outerPhase === "bg_progress" && channel === "recall") {
    if (phase === "bg_progress") {
      title = `Recall 调用 · ${String(ev.tool_name || "recall_memory")}${round ? ` · 外层第 ${round} 轮` : ""}`;
      detail = String(ev.brief || ev.obs_summary || "");
      if (typeof ev.tool_name === "string") {
        plannedTools = [{
          name: ev.tool_name,
          ...(isRecord(ev.args) ? { args: ev.args } : {}),
        }];
        callState = "called";
      }
    } else if (phase === "start") {
      title = "开始召回多模态记忆";
      detail = String(ev.brief || "");
      addMetric(typeof ev.model === "string" ? `model ${ev.model}` : undefined);
      addMetric(Number(ev.ask_ts) ? `ask_ts ${Number(ev.ask_ts).toFixed(1)}s` : undefined);
    } else if (phase === "tool_obs") {
      title = `Recall 第${round || "?"}轮读取记忆工具 · ${observations.length} 项结果`;
      toolResults = observations.map((obs) => ({
        name: String(obs.name || "memory tool"),
        ...(isRecord(obs.args) ? { args: obs.args } : {}),
        ...(Number.isFinite(Number(obs.obs_len)) ? { obs_len: Number(obs.obs_len) } : {}),
        ...(Number.isFinite(Number(obs.elapsed_sec)) ? { elapsed_sec: Number(obs.elapsed_sec) } : {}),
        ...(typeof obs.obs_summary === "string" ? { obs_summary: obs.obs_summary } : {}),
        ...(Array.isArray(obs.frame_ids)
          ? { frame_ids: obs.frame_ids.map(String).filter(Boolean) }
          : {}),
        ...(Array.isArray(obs.evidence_segments)
          ? {
              evidence_segments: obs.evidence_segments
                .filter(isRecord)
                .slice(0, 12)
                .map((segment) => ({
                  ...(typeof segment.kind === "string" ? { kind: segment.kind } : {}),
                  ...(Number.isFinite(Number(segment.t_start)) ? { t_start: Number(segment.t_start) } : {}),
                  ...(Number.isFinite(Number(segment.t_end)) ? { t_end: Number(segment.t_end) } : {}),
                  ...(Array.isArray(segment.frame_ids)
                    ? { frame_ids: segment.frame_ids.map(String).filter(Boolean) }
                    : {}),
                  ...(typeof segment.preview === "string" ? { preview: segment.preview } : {}),
                })),
            }
          : {}),
      }));
      addMetric(Number.isFinite(Number(ev.parallel_elapsed_sec))
        ? `并行读取 ${Number(ev.parallel_elapsed_sec).toFixed(2)}s` : undefined);
      addMetric(Array.isArray(ev.new_frame_ids) && ev.new_frame_ids.length
        ? `新证据帧 ${ev.new_frame_ids.length}` : undefined);
    } else if (phase === "distill") {
      title = `Recall 第${round || "?"}轮提炼出有效线索`;
      detail = String(ev.clue || "");
    } else if (decisionRound) {
      const canAnswer = ev.can_answer === true;
      const nNext = Number(ev.n_next_calls || 0);
      title = `Recall 第${round || "?"}轮决策 · ${
        canAnswer ? "证据已足够" : nNext ? `继续检索 ${nNext} 个工具` : "无后续工具"
      }`;
      detail = String(ev.decision_summary || ev.useful_info || "");
      const nextCalls = Array.isArray(ev.next_tool_calls)
        ? ev.next_tool_calls.filter(isRecord) : [];
      plannedTools = nextCalls.map((call) => ({
        name: String(call.name || "memory tool"),
        ...(isRecord(call.args) ? { args: call.args } : {}),
      }));
      callState = "planned";
      addMetric(`can_answer ${String(canAnswer)}`);
      addMetric(Number(ev.n_clues_so_far || 0)
        ? `已有线索 ${Number(ev.n_clues_so_far)}` : undefined);
      if (ev.useful_info && ev.decision_summary) {
        detail += `${detail ? "\n" : ""}证据摘要：${String(ev.useful_info)}`;
      }
    } else if (phase === "tool_skipped") {
      title = `Recall 第${round || "?"}轮跳过重复记忆读取`;
      detail = String(ev.name || "memory tool");
      plannedTools = [{
        name: String(ev.name || "memory tool"),
        ...(isRecord(ev.args) ? { args: ev.args } : {}),
      }];
    } else if (phase === "verify") {
      title = `Recall 视觉复核 · 保留 ${Number(ev.n_kept || 0)}/${Number(ev.n_in || 0)} 帧`;
      detail = String(ev.visual_correction || "未发现需要纠正的画面冲突");
    } else if (phase === "fast_table") {
      status = "complete";
      const toolName = String(ev.tool_name || "search_screen_text");
      title = `Recall 快速工具返回 · ${toolName} · ${Number(ev.findings_len || 0)} 字证据`;
      detail = String(ev.findings_preview || ev.obs_summary || "");
      toolResults = [{
        name: toolName,
        ...(isRecord(ev.args) ? { args: ev.args } : {}),
        ...(Number.isFinite(Number(ev.obs_len ?? ev.findings_len))
          ? { obs_len: Number(ev.obs_len ?? ev.findings_len) } : {}),
        ...(elapsed != null ? { elapsed_sec: elapsed } : {}),
        ...(typeof ev.obs_summary === "string"
          ? { obs_summary: ev.obs_summary }
          : typeof ev.findings_preview === "string"
            ? { obs_summary: ev.findings_preview } : {}),
        ...(Array.isArray(ev.frame_ids)
          ? { frame_ids: ev.frame_ids.map(String).filter(Boolean) }
          : {}),
        ...(Array.isArray(ev.evidence_segments)
          ? {
              evidence_segments: ev.evidence_segments
                .filter(isRecord)
                .slice(0, 12)
                .map((segment) => ({
                  ...(typeof segment.kind === "string" ? { kind: segment.kind } : {}),
                  ...(Number.isFinite(Number(segment.t_start)) ? { t_start: Number(segment.t_start) } : {}),
                  ...(Number.isFinite(Number(segment.t_end)) ? { t_end: Number(segment.t_end) } : {}),
                  ...(Array.isArray(segment.frame_ids)
                    ? { frame_ids: segment.frame_ids.map(String).filter(Boolean) }
                    : {}),
                  ...(typeof segment.preview === "string" ? { preview: segment.preview } : {}),
                })),
            }
          : {}),
      }];
      addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
    } else if (phase === "error") {
      status = "error";
      title = `Recall 请求失败${ev.stage ? ` · ${String(ev.stage)}` : ""}`;
      detail = String(ev.error || "未知错误");
      addMetric(typeof ev.model === "string" ? `model ${ev.model}` : undefined);
      addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
    } else if (phase === "done") {
      status = "complete";
      const found = Number(ev.n_clues || 0) > 0
        || (String(ev.findings_preview || "")
          && String(ev.findings_preview || "") !== "(记忆里未找到相关线索)");
      title = `Recall 完成 · ${found ? `${Number(ev.n_clues || 0)} 条线索` : "未找到可靠线索"}`;
      detail = String(ev.findings_preview || "");
      addMetric(Number(ev.rounds || 0) ? `内层轮数 ${Number(ev.rounds)}` : undefined);
      addMetric(Number(ev.findings_len || 0) ? `证据 ${Number(ev.findings_len)} 字` : undefined);
      addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
    } else {
      title = `Recall ${phase}${round ? ` · 第${round}轮` : ""}`;
      detail = String(ev.clue || ev.obs_summary || "");
    }
  } else if (outerPhase === "bg_progress" && channel === "search") {
    const toolName = String(ev.tool_name || "text_search");
    title = phase === "bg_progress"
      ? `Search 调用 · ${toolName}`
      : `Search ${phase === "start" ? "开始检索" : phase}`;
    detail = String(ev.brief || ev.obs_summary || ev.findings || "");
    plannedTools = [{
      name: toolName,
      ...(isRecord(ev.args) ? { args: ev.args } : {}),
      ...(typeof ev.anchor === "string" ? { anchor: ev.anchor } : {}),
      ...(ev.anchor_ts != null && Number.isFinite(Number(ev.anchor_ts))
        ? { anchor_ts: Number(ev.anchor_ts) } : {}),
    }];
    callState = "called";
  } else if (outerPhase === "recall_done") {
    status = "complete";
    const found = ev.found !== false
      && String(ev.findings_preview || "") !== "(记忆里未找到相关线索)";
    title = `Recall 返回 · ${found ? `${Number(ev.n_clues || 0)} 条线索` : "未找到可靠线索"}${rawFrames.length ? ` · ${rawFrames.length} 帧` : ""}`;
    detail = String(ev.findings_preview || "");
    toolResults = [{
      name: String(ev.tool_name || "recall_memory"),
      ...(isRecord(ev.args) ? { args: ev.args } : {}),
      ...(Number.isFinite(Number(ev.findings_len)) ? { obs_len: Number(ev.findings_len) } : {}),
      ...(elapsed != null ? { elapsed_sec: elapsed } : {}),
      ...(typeof ev.findings_preview === "string" ? { obs_summary: ev.findings_preview } : {}),
      ...(Array.isArray(ev.frame_ids)
        ? { frame_ids: ev.frame_ids.map(String).filter(Boolean) }
        : {}),
    }];
    addMetric(Number(ev.rounds || 0) ? `内层轮数 ${Number(ev.rounds)}` : undefined);
    addMetric(Number(ev.findings_len || 0) ? `证据 ${Number(ev.findings_len)} 字` : undefined);
    addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
  } else if (outerPhase === "search_done") {
    status = "complete";
    title = `Search 返回 · ${Number(ev.findings_len || 0)} 字证据`;
    detail = String(ev.findings_preview || "");
    toolResults = [{
      name: String(ev.tool_name || "text_search"),
      ...(isRecord(ev.args) ? { args: ev.args } : {}),
      ...(Number.isFinite(Number(ev.findings_len)) ? { obs_len: Number(ev.findings_len) } : {}),
      ...(elapsed != null ? { elapsed_sec: elapsed } : {}),
      ...(typeof ev.findings_preview === "string" ? { obs_summary: ev.findings_preview } : {}),
      ...(Array.isArray(ev.source_urls)
        ? { source_urls: ev.source_urls.map(String).filter(Boolean).slice(0, 12) }
        : {}),
      ...(typeof ev.cache_hit === "boolean" ? { cache_hit: ev.cache_hit } : {}),
      ...(typeof ev.anchor === "string" ? { anchor: ev.anchor } : {}),
      ...(ev.anchor_ts != null && Number.isFinite(Number(ev.anchor_ts))
        ? { anchor_ts: Number(ev.anchor_ts) } : {}),
    }];
    addMetric(ev.cache_hit === true ? "cache hit" : undefined);
    addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
  } else if (outerPhase === "answer_ready") {
    title = "证据已齐，正在组织最终答案";
    detail = String(ev.text_preview || "");
  } else if (["complete", "error", "cancelled"].includes(outerPhase)) {
    terminal = true;
    status = outerPhase as QueryWorkerProgressStep["status"];
    title = outerPhase === "complete" ? "回答已完成并回填原问题"
      : outerPhase === "cancelled" ? "任务已取消" : "任务执行失败";
    detail = String(p.answer_preview || "");
    addMetric(elapsed != null ? `${elapsed.toFixed(2)}s` : undefined);
  } else if (outerPhase === "tool_error") {
    status = "error";
    worker = channel === "recall" ? "RecallWorker"
      : channel === "search" ? "SearchWorker" : worker;
    title = `${channel === "search" ? "Search" : "Recall"} 子任务失败 · ${String(ev.target || "unknown")}`;
    detail = String(ev.findings || "未知错误");
    if (typeof ev.tool_name === "string") {
      plannedTools = [{
        name: ev.tool_name,
        ...(isRecord(ev.args) ? { args: ev.args } : {}),
        ...(typeof ev.anchor === "string" ? { anchor: ev.anchor } : {}),
        ...(ev.anchor_ts != null && Number.isFinite(Number(ev.anchor_ts))
          ? { anchor_ts: Number(ev.anchor_ts) } : {}),
      }];
    }
  } else {
    // Keep the chat card readable; the full unfiltered event remains available
    // in Memory → Debug → worker trajectory.
    return null;
  }

  addMetric(clipMetric);

  const frames = rawFrames.filter(isRecord) as MmTrajectoryFrame[];
  return {
    taskId,
    step: {
      id: item.id,
      seq: item.seq,
      ts: item.ts,
      worker,
      phase: `${outerPhase}:${phase}`,
      title,
      ...(detail.trim() ? { detail: detail.trim() } : {}),
      ...(metrics.length ? { metrics } : {}),
      ...(plannedTools.length ? { plannedTools } : {}),
      ...(toolResults.length ? { toolResults } : {}),
      ...(frames.length ? { frames } : {}),
      ...(ocrState ? { ocrState } : {}),
      ...(ocrRecords.length ? { ocrRecords } : {}),
      ...(ocrReason ? { ocrReason } : {}),
      ...(ocrRecordCount != null ? { ocrRecordCount } : {}),
      ...(ocrElapsedSec != null ? { ocrElapsedSec } : {}),
      ...(taskRef ? { taskRef } : {}),
      ...(callState ? { callState } : {}),
      ...(terminal ? { terminal: true } : {}),
      status,
    },
  };
}

type MemoryDebugTab = "memory" | "frame" | "search" | "debug";

function fmtDebugTime(seconds?: number): string {
  if (seconds == null || !isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtDebugWall(seconds?: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}

function fmtDebugBytes(bytes?: number): string {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function debugJson(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function extractDebugBox(block: unknown): number[] | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const raw = b.bbox || b.box || b.rect || b.points || b.polygon || b.poly;
  if (!Array.isArray(raw)) return null;
  if (raw.length >= 4 && raw.every((x) => typeof x === "number")) {
    const nums = raw.slice(0, 4) as number[];
    if (nums[2] > nums[0] && nums[3] > nums[1]) return nums;
    return [nums[0], nums[1], nums[0] + Math.max(0, nums[2]), nums[1] + Math.max(0, nums[3])];
  }
  const pts = raw.filter((p) => Array.isArray(p) && p.length >= 2) as unknown[][];
  if (pts.length >= 2) {
    const xs = pts.map((p) => Number(p[0])).filter(Number.isFinite);
    const ys = pts.map((p) => Number(p[1])).filter(Number.isFinite);
    if (xs.length && ys.length) return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return null;
}

function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  return String((block as Record<string, unknown>).text || "");
}

const OcrOverlayImage = memo(function OcrOverlayImage({
  imageB64, blocks,
}: { imageB64: string; blocks: unknown[] }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const boxes = useMemo(() => {
    const arr = Array.isArray(blocks) ? blocks : [];
    const rawBoxes = arr.map((b) => ({ block: b, box: extractDebugBox(b) })).filter((x) => x.box) as Array<{ block: unknown; box: number[] }>;
    if (!size || rawBoxes.length === 0) return [];
    const maxX = Math.max(...rawBoxes.map((x) => Math.max(x.box[0], x.box[2])));
    const maxY = Math.max(...rawBoxes.map((x) => Math.max(x.box[1], x.box[3])));
    const norm = maxX <= 1.5 && maxY <= 1.5;
    return rawBoxes.map(({ block, box }) => {
      const [x1, y1, x2, y2] = box;
      return {
        block,
        left: norm ? x1 * 100 : (x1 / Math.max(maxX, size.w)) * 100,
        top: norm ? y1 * 100 : (y1 / Math.max(maxY, size.h)) * 100,
        width: norm ? (x2 - x1) * 100 : ((x2 - x1) / Math.max(maxX, size.w)) * 100,
        height: norm ? (y2 - y1) * 100 : ((y2 - y1) / Math.max(maxY, size.h)) * 100,
      };
    });
  }, [blocks, size]);
  if (!imageB64) {
    return <div className="flex aspect-video items-center justify-center border bg-black text-xs text-muted-foreground">no frame image</div>;
  }
  return (
    <div className="relative overflow-hidden border bg-black">
      <img
        src={`data:image/jpeg;base64,${imageB64}`}
        alt="memory frame"
        className="max-h-[48vh] w-full object-contain"
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
      {boxes.map((b, i) => (
        <div
          key={i}
          title={blockText(b.block)}
          className="absolute border border-amber-300/90 bg-amber-300/10"
          style={{
            left: `${Math.max(0, Math.min(100, b.left))}%`,
            top: `${Math.max(0, Math.min(100, b.top))}%`,
            width: `${Math.max(0.4, Math.min(100, b.width))}%`,
            height: `${Math.max(0.4, Math.min(100, b.height))}%`,
          }}
        />
      ))}
    </div>
  );
});

const MemoryTableView = memo(function MemoryTableView({
  rows, columns,
}: { rows: unknown[]; columns: string[] }) {
  const displayRows = rows.slice(0, 30);
  if (columns.length === 0 && displayRows.length === 0) {
    return <div className="text-xs italic text-muted-foreground">(no structured rows)</div>;
  }
  if (columns.length === 0) {
    return <pre className="max-h-56 overflow-auto whitespace-pre-wrap border bg-background/50 p-2 text-[11px]">{debugJson(displayRows)}</pre>;
  }
  return (
    <div className="max-h-64 overflow-auto border">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-background">
          <tr>{columns.map((c) => <th key={c} className="border-b border-r px-2 py-1 text-left font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => {
            const obj = row && typeof row === "object" && !Array.isArray(row)
              ? row as Record<string, unknown> : {};
            return (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} className="max-w-[220px] border-r border-t px-2 py-1 align-top">
                    <span className="whitespace-pre-wrap break-words">{String(obj[c] ?? "")}</span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

const MemoryEventCard = memo(function MemoryEventCard({
  event, level, onFrame,
}: {
  event: MmMemoryDebugEvent;
  level: "micro" | "macro" | "super";
  onFrame: (frameId: string) => void;
}) {
  const entities = event.entity_names || event.key_entities || [];
  const frameIds = event.frame_ids || [];
  const title = event.label || event.action || event.id;
  const description = event.summary || event.description || "(暂无描述)";
  return (
    <details className="rounded border bg-background/50 p-2 text-xs" open={level !== "micro"}>
      <summary className="cursor-pointer list-none">
        <span className={`mr-2 rounded px-1.5 py-0.5 font-mono text-[10px] ${
          level === "super" ? "bg-violet-500/15 text-violet-200"
            : level === "macro" ? "bg-amber-500/15 text-amber-200"
              : "bg-cyan-500/15 text-cyan-200"
        }`}>{level}</span>
        <span className="font-semibold">{title}</span>
        <span className="ml-2 font-mono text-muted-foreground">
          {fmtDebugTime(event.t_start)}–{fmtDebugTime(event.t_end)}
        </span>
      </summary>
      <div className="mt-2 whitespace-pre-wrap leading-relaxed text-foreground/85">{description}</div>
      {(entities.length > 0 || frameIds.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {entities.map((name) => (
            <span key={name} className="rounded bg-muted px-1.5 py-0.5">entity: {name}</span>
          ))}
          {frameIds.map((fid) => (
            <button
              key={fid}
              type="button"
              onClick={() => onFrame(fid)}
              className="rounded border border-emerald-400/30 px-1.5 py-0.5 font-mono text-emerald-200 hover:bg-emerald-400/10"
            >
              {fid}
            </button>
          ))}
        </div>
      )}
      {((event.narrative_arc?.length || 0) > 0 || Object.keys(event.entity_arcs || {}).length > 0) && (
        <div className="mt-2 rounded bg-black/20 p-2">
          {event.narrative_arc?.map((phase, i) => (
            <div key={i} className="mb-1 last:mb-0">{debugJson(phase)}</div>
          ))}
          {Object.entries(event.entity_arcs || {}).map(([name, arc]) => (
            <div key={name}><span className="font-semibold">{name}</span> → {debugJson(arc)}</div>
          ))}
        </div>
      )}
    </details>
  );
});

const MemoryDebugPanel = memo(function MemoryDebugPanel({
  open, onClose, currentSessionId, trajectory,
}: {
  open: boolean;
  onClose: () => void;
  currentSessionId: string;
  trajectory: MmTrajectoryEntry[];
}) {
  const [tab, setTab] = useState<MemoryDebugTab>("memory");
  const [sessions, setSessions] = useState<MmMemoryDebugSessionSummary[]>([]);
  const [selectedDb, setSelectedDb] = useState("");
  const [overview, setOverview] = useState<MmMemoryDebugSessionResponse | null>(null);
  const [trace, setTrace] = useState<MmMemoryDebugTraceResponse | null>(null);
  const [frame, setFrame] = useState<MmMemoryDebugFrameResponse | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [searchScope, setSearchScope] = useState<"latest" | "today" | "all">("all");
  const [searchResults, setSearchResults] = useState<MmMemoryDebugSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [workerFilter, setWorkerFilter] = useState("all");
  const [trajectoryDisplayLimit, setTrajectoryDisplayLimit] = useState(200);
  const selectedDbManually = useRef(false);

  useEffect(() => {
    selectedDbManually.current = false;
    setSelectedDb("");
    setSelectedFrameId("");
    setFrame(null);
  }, [currentSessionId]);

  const refreshSessions = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.getMultimodalMemoryDebugSessions(80);
      setSessions(res.sessions);
      setSelectedDb((prev) => {
        const previousStillExists = Boolean(
          prev && res.sessions.some((s) => s.name === prev),
        );
        if (selectedDbManually.current && previousStillExists) return prev;
        const current = res.sessions.find(
          (s) => s.meta?.hermes_session_id === currentSessionId,
        );
        if (current) return current.name;
        if (previousStillExists) return prev;
        const newestNonEmpty = res.sessions.find((s) =>
          Object.values(s.counts || {}).some((n) => Number(n) > 0));
        return newestNonEmpty?.name || res.sessions[0]?.name || "";
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [open, currentSessionId]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  const refreshOverview = useCallback(async () => {
    if (!open || !selectedDb) return;
    setLoading(true);
    setError("");
    try {
      const ov = await api.getMultimodalMemoryDebugSession(
        selectedDb, { session_id: currentSessionId, limit: 260 },
      );
      setOverview(ov);
      setSelectedFrameId((prev) => prev || ov.timeline[ov.timeline.length - 1]?.frame_id || "");
      if (tab === "debug") {
        const tr = await api.getMultimodalMemoryDebugTrace({
          session_id: currentSessionId, db: selectedDb, limit: 160,
        });
        setTrace(tr);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [open, selectedDb, currentSessionId, tab]);

  useEffect(() => { void refreshOverview(); }, [refreshOverview]);

  useEffect(() => {
    if (!open || tab !== "frame" || !selectedDb || !selectedFrameId) return;
    let cancelled = false;
    api.getMultimodalMemoryDebugFrame(selectedDb, selectedFrameId)
      .then((res) => { if (!cancelled) setFrame(res); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [open, tab, selectedDb, selectedFrameId]);

  const runSearch = useCallback(async () => {
    const q = searchQ.trim();
    if (!q) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.searchMultimodalMemoryDebug(q, {
        scope: searchScope,
        session: searchScope === "latest" ? selectedDb : undefined,
        limit: 50,
      });
      setSearchResults(res.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [searchQ, searchScope, selectedDb]);

  const workers = useMemo(() => Array.from(new Set(
    trajectory.map((it) => it.worker).filter(Boolean),
  )).sort(), [trajectory]);
  const visibleTrajectory = useMemo(() => (
    workerFilter === "all"
      ? trajectory
      : trajectory.filter((it) => it.worker === workerFilter)
  ), [trajectory, workerFilter]);
  const renderedTrajectory = useMemo(
    () => visibleTrajectory.slice(-trajectoryDisplayLimit),
    [visibleTrajectory, trajectoryDisplayLimit],
  );
  if (!open) return null;
  const counts = overview?.session.counts || {};
  const logs = trace?.logs || overview?.trace.logs || [];
  const activeFrame = frame?.frame_id === selectedFrameId ? frame : null;
  const blocks = activeFrame?.screen_text?.ocr_blocks || [];
  const health = overview?.health || {};
  const memory = overview?.memory;
  const entities = memory?.entities || [];
  const microEvents = memory?.events.micro || [];
  const macroEvents = memory?.events.macro || [];
  const superEvents = memory?.events.super || [];
  const entityStates = memory?.evolution.entity_states || [];
  const revisions = memory?.evolution.revisions || [];
  const eventCount = microEvents.length + macroEvents.length + superEvents.length;
  const evolutionCount = entityStates.length + revisions.length;
  const tabLabels: Record<MemoryDebugTab, string> = {
    memory: "本次记忆",
    frame: "帧详情",
    search: "搜索",
    debug: "高级 Debug",
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[min(980px,96vw)] flex-col border-l border-border bg-background/95 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Database className="h-4 w-4 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">本次多模态记忆</div>
          <div className="truncate text-[11px] text-muted-foreground">
            帧 · 实体 · 事件 · 演化 · {overview?.session.meta?.summary || selectedDb || "暂无记忆库"}
          </div>
        </div>
        <Button size="icon" outlined title="刷新" onClick={() => { void refreshSessions(); void refreshOverview(); }}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <Button size="icon" outlined title="关闭" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <select
          value={selectedDb}
          onChange={(e) => {
            selectedDbManually.current = true;
            setSelectedDb(e.target.value);
            setSelectedFrameId("");
            setFrame(null);
          }}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
        >
          {sessions.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} · frames {s.counts.memory_frames || 0} · OCR {s.counts.screen_texts || 0}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          {(["memory", "frame", "search", "debug"] as MemoryDebugTab[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded border px-2 py-1 text-xs ${tab === k ? "border-emerald-300 text-emerald-200" : "border-border text-muted-foreground"}`}
            >
              {tabLabels[k]}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="border-b border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "memory" && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[
                ["记忆帧", overview?.timeline.length || 0, counts.memory_frames || 0],
                ["实体", entities.length, counts.entities || 0],
                ["事件", eventCount, (counts.micro_events || 0) + (counts.macro_events || 0) + (counts.super_events || 0)],
                ["演化记录", evolutionCount, (counts.entity_states || 0) + (counts.revision_log || 0)],
              ].map(([label, shown, total]) => (
                <div key={String(label)} className="rounded border bg-background/50 p-3">
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className="mt-1 font-mono text-xl text-emerald-200">{String(shown)}</div>
                  {Number(total) > Number(shown) && (
                    <div className="text-[10px] text-muted-foreground">库内共 {String(total)}</div>
                  )}
                </div>
              ))}
            </div>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">1. 本次留下了哪些帧</h3>
                  <p className="text-[11px] text-muted-foreground">只显示真正进入 memory_frames 的证据帧；不是每秒采样日志。</p>
                </div>
                <Button size="sm" outlined onClick={() => setTab("frame")}>查看全部与 OCR</Button>
              </div>
              {(overview?.timeline.length || 0) === 0 ? (
                <div className="rounded border p-3 text-xs italic text-muted-foreground">本次还没有写入任何记忆帧。</div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {(overview?.timeline || []).slice(-48).reverse().map((it) => (
                    <button
                      key={it.frame_id}
                      type="button"
                      onClick={() => { setSelectedFrameId(it.frame_id); setTab("frame"); }}
                      className="overflow-hidden rounded border bg-background/50 text-left hover:border-emerald-300/60"
                    >
                      {it.thumb_b64 ? (
                        <img src={`data:image/jpeg;base64,${it.thumb_b64}`} alt={it.frame_id} className="h-24 w-full object-cover" />
                      ) : <div className="flex h-24 items-center justify-center bg-black/30 text-[10px] text-muted-foreground">no image</div>}
                      <div className="p-1.5">
                        <div className="truncate font-mono text-[10px] text-emerald-200">{fmtDebugTime(it.t_observed)} · {it.frame_id}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{it.source || "unknown"} · {it.note || it.micro_id || "key frame"}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">2. 本次有哪些实体</h3>
                <p className="text-[11px] text-muted-foreground">人物、物体、地点及其属性、别名、出现次数和证据帧。</p>
              </div>
              {entities.length === 0 ? (
                <div className="rounded border p-3 text-xs italic text-muted-foreground">尚未抽取出实体。</div>
              ) : (
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {entities.map((entity) => (
                    <details key={entity.id} className="rounded border bg-background/50 p-3 text-xs" open={entities.length <= 8}>
                      <summary className="cursor-pointer list-none">
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200">{entity.type}</span>
                        <span className="ml-2 font-semibold">{entity.name}</span>
                        <span className="ml-2 text-muted-foreground">出现 {entity.seen_count} 次 · {fmtDebugTime(entity.first_seen)}–{fmtDebugTime(entity.last_seen)}</span>
                      </summary>
                      {entity.aliases.length > 0 && (
                        <div className="mt-2 text-muted-foreground">别名：{entity.aliases.join(" / ")}</div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {Object.entries(entity.attributes || {}).map(([key, value]) => (
                          <span key={key} className="rounded bg-muted px-1.5 py-0.5">
                            <span className="text-muted-foreground">{key}:</span> {debugJson(value)}
                          </span>
                        ))}
                      </div>
                      {entity.frame_ids.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {entity.frame_ids.map((fid) => (
                            <button
                              key={fid}
                              type="button"
                              onClick={() => { setSelectedFrameId(fid); setTab("frame"); }}
                              className="rounded border border-emerald-400/30 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200"
                            >{fid}</button>
                          ))}
                        </div>
                      )}
                    </details>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">3. 本次发生了哪些事件</h3>
                <p className="text-[11px] text-muted-foreground">micro 是局部观察，macro 是阶段总结，super 是跨阶段叙事。</p>
              </div>
              {eventCount === 0 ? (
                <div className="rounded border p-3 text-xs italic text-muted-foreground">尚未形成事件。</div>
              ) : (
                <div className="space-y-2">
                  {[...superEvents, ...macroEvents, ...microEvents].map((event) => (
                    <MemoryEventCard
                      key={event.id}
                      event={event}
                      level={superEvents.includes(event) ? "super" : macroEvents.includes(event) ? "macro" : "micro"}
                      onFrame={(fid) => { setSelectedFrameId(fid); setTab("frame"); }}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">4. 实体和事件如何演化</h3>
                <p className="text-[11px] text-muted-foreground">按时间展示首次发现、属性变化、新别名，以及 Reviewer 对记忆的修订。</p>
              </div>
              {evolutionCount === 0 ? (
                <div className="rounded border p-3 text-xs italic text-muted-foreground">尚无演化或修订记录。</div>
              ) : (
                <div className="space-y-2">
                  {entityStates.map((state) => (
                    <div key={`state-${state.id}`} className="rounded border-l-2 border-l-cyan-300 border-y border-r bg-background/50 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-cyan-200">{fmtDebugTime(state.t_observed)}</span>
                        <span className="font-semibold">{state.entity_name}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5">{state.state_label}</span>
                        <span className="text-muted-foreground">{state.source}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {Object.entries(state.attributes_delta || {}).map(([key, value]) => (
                          <span key={key} className="rounded bg-cyan-500/10 px-1.5 py-0.5"><span className="text-muted-foreground">{key} →</span> {debugJson(value)}</span>
                        ))}
                        {state.new_aliases.map((alias) => <span key={alias} className="rounded bg-violet-500/10 px-1.5 py-0.5">+ alias {alias}</span>)}
                      </div>
                      {state.evidence_frame_ids.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {state.evidence_frame_ids.map((fid) => (
                            <button key={fid} type="button" onClick={() => { setSelectedFrameId(fid); setTab("frame"); }} className="font-mono text-[10px] text-emerald-200 underline-offset-2 hover:underline">{fid}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {revisions.map((revision) => (
                    <details key={`revision-${revision.id}`} className={`rounded border-l-2 border-y border-r bg-background/50 p-2 text-xs ${revision.success ? "border-l-amber-300" : "border-l-red-300"}`}>
                      <summary className="cursor-pointer list-none">
                        <span className="font-mono text-amber-200">{fmtDebugWall(revision.t_applied)}</span>
                        <span className="ml-2 font-semibold">Reviewer: {revision.op}</span>
                        <span className="ml-2 text-muted-foreground">{revision.target_ids.join(", ")}</span>
                      </summary>
                      <div className="mt-2 whitespace-pre-wrap">{revision.reason || revision.error || "(无说明)"}</div>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[11px]">{debugJson(revision.payload)}</pre>
                    </details>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === "debug" && (
          <div className="space-y-3">
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded border bg-background/95 p-2 text-xs backdrop-blur">
              <Activity className="h-3.5 w-3.5 text-cyan-300" />
              <span className="font-semibold">Live worker trajectory</span>
              <span className="text-muted-foreground">
                showing {renderedTrajectory.length} / {visibleTrajectory.length} events
              </span>
              <select
                value={workerFilter}
                onChange={(e) => setWorkerFilter(e.target.value)}
                className="ml-auto rounded border bg-background px-2 py-1 text-xs"
              >
                <option value="all">all workers</option>
                {workers.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            {visibleTrajectory.length === 0 ? (
              <div className="rounded border p-3 text-xs italic text-muted-foreground">
                暂无 trajectory。开始摄像头/共享屏幕、提问、Recall 或 Monitor 后会实时出现。
              </div>
            ) : [...renderedTrajectory].reverse().map((it) => {
              const rawFrames = (it.payload?.frames || []) as MmTrajectoryFrame[];
              const frames = Array.isArray(rawFrames) ? rawFrames : [];
              return (
                <details key={it.id} open={frames.length > 0} className="rounded border bg-background/50 p-2 text-xs">
                  <summary className="cursor-pointer list-none">
                    <span className="font-mono text-cyan-300">#{it.seq}</span>
                    <span className="ml-2 font-semibold text-emerald-200">{it.worker}</span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono">{it.phase}</span>
                    <span className="ml-2 text-muted-foreground">{fmtDebugWall(it.ts)}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground">{it.event}</span>
                  </summary>
                  {frames.length > 0 && (
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                      {frames.map((fr, i) => {
                        const b64 = fr.thumb_b64 || fr.jpeg_b64 || "";
                        const usableB64 = b64 && !b64.startsWith("<omitted");
                        return (
                          <figure key={`${fr.frame_id || fr.ts || i}-${i}`} className="overflow-hidden rounded border bg-black/20">
                            {usableB64
                              ? <img src={`data:image/jpeg;base64,${b64}`} alt="recall evidence" className="h-28 w-full object-contain" />
                              : <div className="flex h-28 items-center justify-center text-[10px] text-muted-foreground">thumbnail omitted</div>}
                            <figcaption className="px-1.5 py-1 font-mono text-[10px] text-muted-foreground">
                              {fr.frame_id || `frame ${i + 1}`} · {fmtDebugTime(fr.ts)}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  )}
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 text-[11px] leading-snug">
                    {debugJson(it.payload)}
                  </pre>
                </details>
              );
            })}
            {renderedTrajectory.length < visibleTrajectory.length && (
              <Button
                size="sm"
                outlined
                onClick={() => setTrajectoryDisplayLimit((n) => Math.min(n + 200, 2000))}
              >
                再显示 200 条
              </Button>
            )}
          </div>
        )}

        {tab === "debug" && (
          <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr]">
            <section className="min-w-0">
              <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                <Activity className="h-3.5 w-3.5" /> Recall Messages
              </div>
              <div className="space-y-2">
                {(trace?.messages || []).length === 0 ? (
                  <div className="rounded border p-2 text-xs italic text-muted-foreground">No persisted recall tool messages for this session.</div>
                ) : trace!.messages.map((m, i) => (
                  <details key={`${m.timestamp}-${i}`} className="rounded border bg-background/50 p-2 text-xs">
                    <summary className="cursor-pointer list-none">
                      <span className="font-mono text-emerald-300">{m.tool_name || m.role}</span>
                      <span className="ml-2 text-muted-foreground">{fmtDebugWall(m.timestamp)}</span>
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{m.content || debugJson(m.tool_calls)}</pre>
                  </details>
                ))}
              </div>
            </section>
            <section className="min-w-0">
              <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> Relevant Logs
              </div>
              <pre className="max-h-[70vh] overflow-auto rounded border bg-black/30 p-2 text-[11px] leading-snug text-muted-foreground">
                {logs.join("\n") || "No recall/writer/OCR logs found."}
              </pre>
            </section>
          </div>
        )}

        {tab === "frame" && (
          <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-[330px_minmax(0,1fr)]">
            <section className="min-w-0">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>All-scene memory frames · {overview?.timeline.length || 0}</span>
                <span>Indexed {counts.memory_frames || 0} · OCR {counts.screen_texts || 0} · Tables {counts.screen_tables || 0}</span>
              </div>
              <div className="max-h-[72vh] space-y-1 overflow-y-auto">
                {(overview?.timeline || []).map((it) => (
                  <button
                    key={it.frame_id}
                    type="button"
                    onClick={() => setSelectedFrameId(it.frame_id)}
                    className={`flex w-full gap-2 rounded border p-2 text-left text-xs ${selectedFrameId === it.frame_id ? "border-emerald-300/70 bg-emerald-400/10" : "border-border bg-background/40"}`}
                  >
                    {it.thumb_b64 ? <img src={`data:image/jpeg;base64,${it.thumb_b64}`} alt="" className="h-12 w-16 shrink-0 object-cover" /> : <div className="h-12 w-16 shrink-0 bg-black" />}
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-emerald-300">{fmtDebugTime(it.t_observed)} · {it.frame_id}</span>
                      <span className="block truncate text-muted-foreground">
                        <span className="mr-1 rounded bg-muted px-1 py-0.5">{it.source_type || it.source || "unknown"}</span>
                        {it.window_title || it.app || it.note || it.micro_id}
                      </span>
                      <span className="line-clamp-2 text-foreground/80">{it.raw_preview || it.observation_preview || "(visual key frame; no OCR text)"}</span>
                    </span>
                    {it.table_count > 0 && <Table2 className="h-4 w-4 shrink-0 text-amber-300" />}
                  </button>
                ))}
              </div>
            </section>
            <section className="min-w-0 space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-emerald-300">{selectedFrameId || "no frame selected"}</span>
                {activeFrame?.memory_frame && <span>{fmtDebugTime(activeFrame.memory_frame.t_observed)}</span>}
                {activeFrame?.memory_frame?.source_type && <span className="rounded bg-muted px-1.5 py-0.5">{activeFrame.memory_frame.source_type}</span>}
                {activeFrame?.screen_text && <span>{fmtDebugTime(activeFrame.screen_text.t_observed)}</span>}
                {activeFrame?.screen_text?.source && <span>{activeFrame.screen_text.source}</span>}
              </div>
              <OcrOverlayImage imageB64={activeFrame?.image_b64 || ""} blocks={blocks} />
              <div>
                <div className="mb-1 text-xs font-semibold text-muted-foreground">All-scene Memory Frame Metadata</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-background/50 p-2 text-[11px]">{debugJson(activeFrame?.memory_frame || {})}</pre>
              </div>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">OCR Raw Text</div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-background/50 p-2 text-[11px]">{activeFrame?.screen_text?.raw_text || "(empty)"}</pre>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">OCR Blocks · {Array.isArray(blocks) ? blocks.length : 0}</div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-background/50 p-2 text-[11px]">{debugJson((Array.isArray(blocks) ? blocks : []).slice(0, 80))}</pre>
                </div>
              </div>
              {(activeFrame?.tables || []).map((t) => (
                <div key={`${t.table_id}-${t.frame_id}`} className="space-y-1">
                  <div className="text-xs font-semibold text-amber-200">{t.table_id} · {t.title || "table"}</div>
                  <MemoryTableView rows={t.rows} columns={t.columns} />
                </div>
              ))}
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded border bg-background/50 p-2 text-[11px]">{debugJson(activeFrame?.micro_events || [])}</pre>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded border bg-background/50 p-2 text-[11px]">{debugJson(activeFrame?.entities || [])}</pre>
              </div>
            </section>
          </div>
        )}

        {tab === "search" && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
                  placeholder="Search OCR / tables / events across sessions"
                  className="w-full rounded border bg-background py-2 pl-8 pr-3 text-sm"
                />
              </div>
              <select value={searchScope} onChange={(e) => setSearchScope(e.target.value as typeof searchScope)}
                className="rounded border bg-background px-2 text-xs">
                <option value="all">all sessions</option>
                <option value="today">today</option>
                <option value="latest">selected DB</option>
              </select>
              <Button size="sm" prefix={<Search />} onClick={() => void runSearch()}>Search</Button>
            </div>
            <div className="space-y-2">
              {searchResults.map((r, i) => (
                <details key={`${r.session}-${r.kind}-${r.frame_id}-${i}`} className="rounded border bg-background/50 p-2 text-xs" open={i < 3}>
                  <summary className="flex cursor-pointer list-none items-center gap-2">
                    {r.thumb_b64 ? <img src={`data:image/jpeg;base64,${r.thumb_b64}`} alt="" className="h-10 w-14 object-cover" /> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.title}</span>
                      <span className="font-mono text-muted-foreground">{r.session} · {r.kind} · score {r.score} · {r.frame_id || ""}</span>
                    </span>
                  </summary>
                  <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded border bg-black/20 p-2">{r.snippet}</pre>
                  {r.table && <MemoryTableView rows={r.table.row_hits.map((x) => x.row)} columns={r.table.columns} />}
                </details>
              ))}
            </div>
          </div>
        )}

        {tab === "debug" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {Object.entries(counts).map(([k, v]) => (
                <div key={k} className="rounded border bg-background/50 p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">{k}</div>
                  <div className="font-mono text-lg text-emerald-200">{String(v)}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded border bg-background/50 p-2 text-xs">
                <div className="mb-1 font-semibold text-muted-foreground">Session</div>
                <div>mtime: {overview?.session.mtime ? fmtDebugWall(overview.session.mtime) : ""}</div>
                <div>size: {fmtDebugBytes(overview?.session.size)}</div>
                <div>frame files: {String(health.frame_files ?? 0)}</div>
                <div>micro no frames: {String(health.micro_events_without_frames ?? 0)}</div>
                <div>empty OCR: {String(health.screen_texts_without_raw_text ?? 0)}</div>
              </div>
              <div className="rounded border bg-background/50 p-2 text-xs">
                <div className="mb-1 font-semibold text-muted-foreground">Meta</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{debugJson(overview?.session.meta || {})}</pre>
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground">Recent Writer / OCR / Recall Warnings</div>
              <pre className="max-h-[42vh] overflow-auto rounded border bg-black/30 p-2 text-[11px] leading-snug text-muted-foreground">
                {debugJson(health.recent_log_warnings || [])}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default function MultimodalChatPage() {
  const refs = useRef<Refs>({
    gw: null, sessionId: "", storedSid: "", stream: null, sourceType: null,
    capFps: 2, capTimer: null,
    startTs: 0, sentFrames: 0, droppedFrames: 0, isAnswering: false,
    micStream: null, micAudioCtx: null, micNode: null, micSource: null,
    isRecording: false,
    envStream: null, envRecorder: null, envStop: false, envMime: "audio/webm",
    envWindowSec: 5, envSliceTimer: null, envCaptureId: "", envChunkSeq: 0,
    envLastError: "",
  });
  // The mount-time establish path and the ?mm= watcher must never both create
  // a session for the same `?mm=new` navigation.
  const sessionEstablishedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Phase 10: route message.* events by key (request_id / monitor_id / __main__)
  // so concurrent RouterEngine delegations + multi-monitor SPEAKs land in
  // distinct bubbles. Key "__main__" is the regular main-agent turn bubble.
  const curAssistantId = useRef<Map<string, string>>(new Map());
  // Per-key monitor-alert routing. Keys mirror curAssistantId (via keyOf), but
  // point to {monitorId, alertId} pairs so message.delta / message.complete can
  // append to monitorAlerts[monitorId] instead of the center-chat messages list.
  const curMonitorAlertId = useRef<Map<string, { monitorId: string; alertId: string }>>(new Map());
  const queryProgressByTaskRef = useRef<
    Map<string, QueryWorkerProgressStep[]>
  >(new Map());
  // Invalidates trajectory.list responses that race a session switch or a
  // newer hydrate request for the same live session.
  const trajectoryHydrationGenerationRef = useRef(0);
  const ttsRefs = useRef<TtsRefs>({
    audioCtx: null, audioNextStart: 0, active: [], ttsMuteUntil: 0,
    currentRid: null, cancelled: new Set(),
    ctxStartTime: 0, scheduledSec: 0,
  });

  const { setAfterTitle, setEnd } = usePageHeader();
  // ?mm=<id> selects which session to open (set by the sidebar session list).
  // scopedProfile scopes the "default = newest session" lookup on first load.
  const [searchParams, setSearchParams] = useSearchParams();
  const mmParam = searchParams.get("mm");
  const { profile: scopedProfile } = useProfileScope();
  const [connected, setConnected] = useState(false);
  // Multimodal readiness advisory (soft, non-blocking) — fetched once on connect
  // over the page's own gateway connection (no extra WS), rendered as a banner.
  const [mmReadiness, setMmReadiness] = useState<MmReadinessReport | null>(null);
  // Raw connection state for a 3-way badge (已连接 / 重连中 / 未连接).
  const [connState, setConnState] = useState<string>("connecting");
  const [model, setModel] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>(null);
  const [frameCount, setFrameCount] = useState(0);
  // Mic lifecycle: idle → connecting (ASR WS opening, button shows a spinner,
  // NOT red) → recording (red). Any failure returns to idle. stopMic flips to
  // idle IMMEDIATELY (button de-actives at once, teardown runs after).
  const [micState, setMicState] = useState<"idle" | "connecting" | "recording">("idle");
  const isRecordingUI = micState === "recording";
  // 独立 TTS 语音播报开关 (与麦克风解耦)。默认关; 切换时通知后端 announcer。
  // toggleTts 定义在 pushTopToast 之后 (需引用它做"对话托管"拦截提示)。
  const [ttsEnabled, setTtsEnabled] = useState(false);
  // 独立【对话模式】开关: 开 = VoiceAgent 分诊+决策+秒回+防误识别; 关 = 传统 ASR→主Agent.
  // 【自动开麦】见后面 toggleVoiceDialog useCallback (放 startMic 之后, 引用得到).
  const [voiceDialogEnabled, setVoiceDialogEnabled] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>(() => [_mmWelcomeMsg()]);
  // ★ 聊天列表已改普通 div 全量渲染 (非虚拟化) —— 渲染成本随消息数线性增长, 所以这个
  //   软上限从 5000 降到 400: 只保留最近 400 条 chat+tool+status 气泡, 更早的 tail-slice
  //   丢弃, 防长会话全量渲染卡顿 / 堆增长 (气泡可能带 base64 图)。400 对单次工作会话
  //   足够, 超出的历史仍在后端 DB, 重开某更早节点可再看。
  const MAX_MESSAGES = 400;
  const HISTORY_PAGE = 200;   // 向上翻到顶时每次补进渲染窗的历史条数
  // ★ 历史回看: reopen 时后端一次性返回**全部**历史。之前 capMsgs 直接 slice 掉头部
  //   400 条外的, 用户翻到顶就再也看不到 → 现在把全量历史存进 ref(不渲染), 只渲染尾部
  //   窗口; 滚到顶再从 ref 预取上一段补进窗口 (见 loadOlderHistory)。
  const fullHistoryRef = useRef<ChatMsg[]>([]);   // reopen 的完整历史 (含已划出窗口的头部)
  const [hasMoreHistory, setHasMoreHistory] = useState(false);  // 窗口上方还有没有更早历史
  const capMsgs = (list: ChatMsg[]) => {
    // Stamp a client-local creation time on any message that lacks one (new
    // items are appended last; already-stamped ones are untouched) so each
    // bubble can show an absolute HH:MM:SS timestamp.
    const now = Date.now();
    for (const m of list) if (m.createdAt == null) m.createdAt = now;
    return list.length > MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES) : list;
  };
  const [ctx, setCtx] = useState<CtxState>({ version: 0, obs: [], audioObs: [], facts: {} });
  const [anchorFrames, setAnchorFrames] = useState<{ ts: number | null; jpeg_b64: string }[]>([]);
  const [bgItems, setBgItems] = useState<BgItem[]>([]);
  // Per-monitor alert history. Keyed by monitor_id. Rendered in the right
  // multimodal panel (never as center-chat bubbles). Hydrated on session
  // resume via the multimodal.list_monitor_alerts RPC.
  const [monitorAlerts, setMonitorAlerts] = useState<Map<string, MonitorAlert[]>>(() => new Map());
  // Title-bar collapse for a monitor's panel (default expanded: not in set).
  const [monitorCollapsed, setMonitorCollapsed] = useState<Set<string>>(() => new Set());
  // "展开更多" — reveal older alerts beyond the default 2 (default off).
  const [monitorExpanded, setMonitorExpanded] = useState<Set<string>>(() => new Set());
  // Which deep-research sub-window is expanded (request_id). Only the newest is
  // open by default; clicking a title toggles. null = default (newest open).
  const [deepExpanded, setDeepExpanded] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorReg[]>([]);
  // 右侧面板底部 toast (监控/深度研究过程失败/停用), 3s 后自动移除。不进 history、不发主气泡。
  const [mmToasts, setMmToasts] = useState<{ id: string; level: string; text: string }[]>([]);
  // 顶部居中 toast (页面级操作提示, 如"未开启视频流无法恢复监控"), 3s 淡出。
  const [topToasts, setTopToasts] = useState<{ id: string; level: string; text: string }[]>([]);
  const [memoryDebugOpen, setMemoryDebugOpen] = useState(false);
  const [trajectory, setTrajectory] = useState<MmTrajectoryEntry[]>([]);
  const pushTopToast = useCallback((text: string, level: string = "warning") => {
    const id = nid();
    setTopToasts((prev) => [...prev, { id, level, text }]);
    setTimeout(() => setTopToasts((prev) => prev.filter((x) => x.id !== id)), 2000);
  }, []);
  // TTS 播报开关切换。★ 对话模式开时喇叭由对话托管 (后端 is_speaker_on OR 对话态
  //   已强制 TTS 生效), 单独点喇叭无效 → 拦截 + 顶部小提示 (按钮态不变)。
  const toggleTts = useCallback(() => {
    if (voiceDialogEnabled) {
      pushTopToast("对话模式下语音播报已自动生效, 请先关闭对话模式再单独控制", "info");
      return;
    }
    setTtsEnabled((prev) => {
      const next = !prev;
      const r = refs.current;
      try {
        r.gw?.request("multimodal.tts_toggle",
          { session_id: r.sessionId, enabled: next }).catch(() => {});
      } catch { /* noop */ }
      return next;
    });
  }, [voiceDialogEnabled, pushTopToast]);
  // Watcher (set_live_watcher) registry — mirrors monitors. A reopened session
  // re-registers interrupted watchers (disabled) so this list + on/off toggle
  // can surface + re-enable them (parity with desktop WatcherList).
  // (WatcherReg type hoisted to module scope.)
  const [watchers, setWatchers] = useState<WatcherReg[]>([]);
  // Ref so the (event-handler-scoped) watcher.report_append handler can read the
  // latest registry for a report's label without re-subscribing on every change.
  const watchersRef = useRef<WatcherReg[]>([]);
  useEffect(() => { watchersRef.current = watchers; }, [watchers]);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [asrPartial, setAsrPartial] = useState("");
  // EOU 监听中状态下已拼接但未 flush 的各段文本 (由 asr_buffer 事件更新)
  const [asrBuffer, setAsrBuffer] = useState<string[]>([]);
  // ★ 聊天列表改用普通滚动 div (去掉 react-virtuoso) —— Virtuoso 遇到流式中突然变高
  //   的 item(大表格) + followOutput:"auto" 会进 measure→scroll→remeasure 同步死循环,
  //   把主线程占死 (大型 Markdown 工具结果已用 F12 复现)。普通 div 全量渲染无此问题;
  //   消息量由 capMsgs 软上限兜底 (见下)。
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatAtBottomRef = useRef(true);        // 用户是否停在底部 (ref, 不触发重渲)
  const [atBottom, setAtBottom] = useState(true);  // 同值 state, 仅驱动"跳到最新"按钮显隐
  // ★ 翻到顶补历史: 从 fullHistoryRef 取当前渲染窗上方的一段 (HISTORY_PAGE 条) prepend
  //   进 messages。prepend 会撑高内容 → 视口会跳; 用 scrollHeight 差值补 scrollTop 保持
  //   用户视线锚定在原来那条上 (无跳动)。同步桥用 useLayoutEffect (见下 pendingPrependRef)。
  const pendingPrependRef = useRef<number>(0);   // 本次 prepend 前的 scrollHeight, 供布局后补偿
  const loadOlderHistory = useCallback(() => {
    const el = chatScrollRef.current;
    const full = fullHistoryRef.current;
    if (!el || full.length === 0) return;
    setMessages((cur) => {
      // 置顶欢迎气泡不在 fullHistoryRef 里 (纯前端), 定位/长度都要跳过它。
      const welcomeAtHead = cur.length > 0 && cur[0]?.role === "system"
        && cur[0]?.text === _mmWelcomeMsg().text ? 1 : 0;
      const realCurLen = cur.length - welcomeAtHead;
      if (realCurLen >= full.length) { setHasMoreHistory(false); return cur; }
      // cur 的头部 (跳过 welcome) 对应 full 里的某个位置: 用第一条真实历史 id 定位 (id 稳定)。
      const firstId = cur[welcomeAtHead]?.id;
      let headIdx = firstId ? full.findIndex((m) => m.id === firstId) : full.length - realCurLen;
      if (headIdx < 0) headIdx = Math.max(0, full.length - realCurLen);
      if (headIdx <= 0) { setHasMoreHistory(false); return cur; }
      const newStart = Math.max(0, headIdx - HISTORY_PAGE);
      pendingPrependRef.current = el.scrollHeight;   // 记录撑高前高度, 布局后补偿
      const older = full.slice(newStart, headIdx);
      setHasMoreHistory(newStart > 0);
      // welcome 仍留在顶: [welcome?, older..., realCur...]
      return welcomeAtHead
        ? [cur[0], ...older, ...cur.slice(1)]
        : [...older, ...cur];
    });
  }, []);
  // prepend 后校正 scrollTop: 新内容撑高了 scrollHeight, 加上差值让视线不跳。
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el || pendingPrependRef.current === 0) return;
    const delta = el.scrollHeight - pendingPrependRef.current;
    pendingPrependRef.current = 0;
    if (delta > 0) el.scrollTop = el.scrollTop + delta;
  });
  // 滚动监听: 更新"是否在底部"。阈值 40px 容差。翻到顶(≤80px)且还有更早历史 → 补一页。
  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    chatAtBottomRef.current = bottom;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
    if (el.scrollTop <= 80 && hasMoreHistory) loadOlderHistory();
  }, [hasMoreHistory, loadOlderHistory]);
  const scrollChatToBottom = useCallback((smooth = false) => {
    const el = chatScrollRef.current;
    if (!el) return;
    const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
    el.scrollTo({ top: el.scrollHeight, behavior });
    if (!smooth) {
      requestAnimationFrame(() => {
        const next = chatScrollRef.current;
        if (next) next.scrollTop = next.scrollHeight;
      });
    }
  }, []);
  const obsScrollRef = useRef<HTMLDivElement | null>(null);
  const audioObsScrollRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll the observation timelines to the bottom whenever new items
  // arrive — newest observation is now rendered at the bottom (natural
  // chronological order), so the interesting content is what we scroll to.
  useEffect(() => {
    const el = obsScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ctx.obs.length, ctx.version]);
  useEffect(() => {
    const el = audioObsScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ctx.audioObs.length]);
  const factsList = useMemo(() => Object.entries(ctx.facts), [ctx.facts]);

  // Group consecutive progress entries (tool/status) into one "background" block,
  // so the chat reads as: chat bubble → [background card] → chat bubble.
  // (Row type hoisted to module scope so the column components can use it.)
  //
  // ★ 性能(#6 BgBlock memo 稳定): 每次 messages 变(哪怕只有一个 chat 气泡在流式
  //   追加 text), rows 都会重建, 每个 bg 行都 new 一个 items 数组 → 若 BgBlock 用默认
  //   浅比 (比 items 引用) 则全部失效重渲染。解决放在 BgBlock 自己的 memo 比较器里
  //   (按 items 【逐元素引用】比较, 见 BgBlock 定义处) —— tool/status 对象在纯 chat
  //   流式期间 identity 不变, 故内容相同的 bg 块 memo 命中、跳过。��处保持纯函数、
  //   不在 render 期读写 ref。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const m of messages) {
      // Live deep-research streams live in the left sub-windows; post-Clarify
      // thread-backs (threadback=true) render here in the center chat.
      if (m.subRole === "router" && !m.threadback) continue;
      // Safety net: monitor + watcher_report never render in the center chat
      // any more (they live in the right multimodal panel). Any legacy message
      // that slipped through is filtered here.
      if (m.subRole === "monitor" || m.subRole === "watcher_report") continue;
      if (m.kind === "tool" || m.kind === "status") {
        const last = out[out.length - 1];
        if (last && last.type === "bg") last.items.push(m);
        else out.push({ type: "bg", id: `bg_${m.id}`, items: [m] });
      } else {
        out.push({ type: "chat", msg: m });
      }
    }
    return out;
  }, [messages]);

  // (Chat auto-scroll useLayoutEffect moved into <ChatColumn> so it only runs
  //  when `rows` changes — not on every ctx/anchor/frameCount setState.)

  // RouterEngine deep-research sub-windows: group the router bubbles by
  // requestId (each request_id = one delegation, possibly multi-round via the
  // Clarify loop). Newest first. Rendered in the left column under the video.
  const deepWindows = useMemo(() => {
    const byRid = new Map<string, ChatMsg[]>();
    for (const m of messages) {
      if (m.subRole !== "router" || m.threadback) continue;
      const rid = m.requestId || "__deep__";
      const arr = byRid.get(rid);
      if (arr) arr.push(m); else byRid.set(rid, [m]);
    }
    // Progress (multimodal.bg) can lead message.start by a tick — still show a
    // sub-window shell so the user sees incremental search/recall updates.
    for (const b of bgItems) {
      if (!b.requestId || byRid.has(b.requestId)) continue;
      byRid.set(b.requestId, []);
    }
    // Insertion order = chronological; reverse for newest-first display.
    return Array.from(byRid.entries()).reverse().map(([rid, msgs]) => ({ rid, msgs }));
  }, [messages, bgItems]);

  // One bg item per request_id now (the reducer groups internally), so map
  // rid → its single BgItem for O(1) lookup by the windows below.
  const bgByRid = useMemo(() => {
    const byRid = new Map<string, BgItem>();
    for (const b of bgItems) {
      const rid = b.requestId || "__deep__";
      if (!byRid.has(rid)) byRid.set(rid, b);
    }
    return byRid;
  }, [bgItems]);

  // A deep-research delegation is "active" while it is still streaming, has
  // unfinished background search/recall, or is waiting on a Clarify follow-up.
  // The right RouteEngine column only opens for active delegations (plus any the
  // user explicitly re-opened for review via a thread-back bubble). Once a rid
  // finishes AND isn't the re-opened one, it drops out → the column closes.
  // A window is shown if it is still working OR it has produced any content
  // (segments / final report). req A-fix: a FINISHED watcher must NOT vanish —
  // its process segments + final report stay visible in-panel (the whole point
  // of the panel). It only disappears once evicted by the bgItems cap (last 8).
  const ridIsActive = useCallback((rid: string, msgs: ChatMsg[]) => {
    if (msgs.some((m) => m.streaming)) return true;
    const b = bgByRid.get(rid);
    if (!b) return false;
    if (!b.done) return true;                 // still working
    if (b.finalReport) return true;           // finished — keep the result visible
    if (b.segments && b.segments.length) return true;  // keep the process visible
    return false;
  }, [bgByRid]);

  const visibleDeep = useMemo(
    () => deepWindows.filter(({ rid, msgs }) => ridIsActive(rid, msgs)),
    [deepWindows, ridIsActive],
  );
  // 右侧列承载: 监控注册表 + 深度分析注册表 + 深度研究窗口 (与桌面端 deep-panel 一致)。
  // 只按【未完成】任务自动打开: watcher status ∈ {running,interrupted,disabled} 都算未完成;
  // monitor 在册即算; visibleDeep 含实时进度 + 用户手动重开的只读窗口。
  // ★ 五态统一: "未完成"= running / interrupted / stopping (disabled 已并入 interrupted;
  //   done/deleted 视为已结束, 不撑开面板)。
  const hasIncompleteWatcher = watchers.some((w) =>
    ["running", "interrupted", "stopping"].includes(String(w.status || "")));
  // 有 toast 时也保持右列可见 (监控停用后可能已无活跃任务, 否则 toast 无处可显)。
  const showDeepCol = visibleDeep.length > 0 || monitors.length > 0 || hasIncompleteWatcher || mmToasts.length > 0;
  const generating = useMemo(() => messages.some((m) => m.streaming), [messages]);

  // 监控 / 深度分析 注册表 toggle 回调 (稳定引用 → <RegistryPanels> memo 命中)。
  // ★ I: 不再用客户端 r.stream 硬拦。后端 is_source_live() 判据是 _source_stopped
  //   (前端 source_stopped{started} RPC 驱动) + "从未采集过" 兜底, 不是 buffer 有无帧。
  //   以后端为准: 直接发, 后端拒了走 catch → rollback + toast。
  const onToggleMonitor = useCallback((m: MonitorReg) => {
    const on = m.enabled !== false;
    const label = (m.label && m.label.trim()) || m.brief.slice(0, 10) || "监控";
    const r = refs.current;
    if (!r.gw || !r.sessionId) return;
    setMonitors((prev) => prev.map((x) =>
      x.monitor_id === m.monitor_id ? { ...x, enabled: !on } : x));
    r.gw.request("multimodal.monitor_toggle", {
      session_id: r.sessionId, monitor_id: m.monitor_id, enabled: !on,
    }).then(() => {
      // ★ H: 成功后拉权威注册表对账 (push best-effort, 丢了会永久 desync)。
      refs.current.fetchRegistries?.(r.sessionId);
    }).catch((e: { error?: string; message?: string }) => {
      setMonitors((prev) => prev.map((x) =>
        (x.monitor_id === m.monitor_id && x.enabled === !on)
          ? { ...x, enabled: on } : x));
      // ★ M: 开启 AND 关闭失��都提示。
      pushTopToast(
        `${!on ? "无法开启" : "无法暂停"}监控「${label}」: ${e?.error || e?.message || "未知错误"}`,
        "error");
    });
  }, [pushTopToast]);
  const onToggleWatcher = useCallback((w: WatcherReg) => {
    const on = w.status === "running";
    const label = (w.label && w.label.trim())
      || (w.task_instruction || "").slice(0, 12) || "深度分析";
    const r = refs.current;
    if (!r.gw || !r.sessionId) return;
    const want = !on;
    // Optimistic: 开→running; 关→stopping (当前轮收尾, 后端收尾后落 interrupted)。
    setWatchers((prev) => prev.map((x) =>
      x.watcher_id === w.watcher_id
        ? { ...x, status: want ? "running" : "stopping" } : x));
    r.gw.request("multimodal.watcher_toggle", {
      session_id: r.sessionId, watcher_id: w.watcher_id, enabled: want,
    }).then(() => {
      refs.current.fetchRegistries?.(r.sessionId);
    }).catch((e: { error?: string; message?: string }) => {
      setWatchers((prev) => prev.map((x) =>
        (x.watcher_id === w.watcher_id
          && x.status === (want ? "running" : "stopping"))
          ? { ...x, status: on ? "running" : "interrupted" } : x));
      pushTopToast(
        `${want ? "无法开启" : "无法暂停"}深度研究「${label}」: ${e?.error || e?.message || "未知错误"}`,
        "error");
    });
  }, [pushTopToast]);

  // (Chat auto-scroll: see the useLayoutEffect on `rows` above — scrolls the
  // plain scroll div to bottom on new content when the user is already at bottom.)

  const addMsg = useCallback((m: ChatMsg) => setMessages((p) => capMsgs([...p, m])), []);

  // ★ 切换会话时清空 ALL 上一会话的 UI 状态 (对齐 desktop resetDeepUi + 更全)。
  //   只清 messages/curAssistantId 会让旧会话的深研窗/注入帧/观察面板/监控列表/
  //   toast/帧计数残留到新会话。这里一次清干净; 新会话的 registries 由 resume 后的
  //   fetchRegistries + push 重新填充。
  const resetSessionUi = useCallback(() => {
    trajectoryHydrationGenerationRef.current += 1;
    curAssistantId.current.clear();
    curMonitorAlertId.current.clear();
    queryProgressByTaskRef.current.clear();
    // ★ 清历史回看窗口状态 (切换/新建会话不能串到上一会话的历史)。
    fullHistoryRef.current = [];
    setHasMoreHistory(false);
    // ★ 不清成空 —— 补回置顶"系统"引导气泡 (新建/切换会话都保留)。
    setMessages([_mmWelcomeMsg()]);
    setBgItems([]);
    setMonitors([]);
    setWatchers([]);
    setMonitorAlerts(new Map());
    setMonitorCollapsed(new Set());
    setMonitorExpanded(new Set());
    setMmToasts([]);
    setTopToasts([]);
    setAnchorFrames([]);
    setCtx({ version: 0, obs: [], audioObs: [], facts: {} });
    setDeepExpanded(null);
    setFrameCount(0);
    setAsrPartial("");
    setAsrBuffer([]);
    setTrajectory([]);
    refs.current.sentFrames = 0;
  }, []);

  // ★ 性能: 稳定的 rid 折叠回调 (每个 DeepWindow 复用同一个函数引用 → 不破坏 memo)。
  //   旧代码在 .map 里为每个 window 现造 () => setDeepExpanded(...), 每次父渲染都换
  //   新 onToggle identity → 所有 DeepWindow memo 失效、全部重渲染。
  const toggleDeepWindow = useCallback(
    (rid: string) => setDeepExpanded((cur) => (cur === rid ? "" : rid)), []);
  const toggleMonitorCollapsed = useCallback((mid: string) => {
    setMonitorCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid); else next.add(mid);
      return next;
    });
  }, []);
  const toggleMonitorExpanded = useCallback((mid: string) => {
    setMonitorExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid); else next.add(mid);
      return next;
    });
  }, []);

  // ── TTS playback (WebAudio, gapless scheduling) ────────────────────────
  const ensureAudioCtx = useCallback(() => {
    const r = ttsRefs.current;
    if (!r.audioCtx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      r.audioCtx = new AC();
      r.audioNextStart = r.audioCtx!.currentTime;
    }
    if (r.audioCtx!.state === "suspended") r.audioCtx!.resume().catch(() => {});
    return r.audioCtx!;
  }, []);

  const stopAllTts = useCallback((resetRid: boolean) => {
    const r = ttsRefs.current;
    // ★ #2 播放 ack: 停播前先算"当前 rid 实际听了多少", 回传后端截断"我说过什么"。
    //   played = min(经过的挂钟时长, 已排定总时长); total = 已排定总时长。
    if (resetRid && r.currentRid && r.audioCtx && r.scheduledSec > 0) {
      const elapsed = Math.max(0, r.audioCtx.currentTime - r.ctxStartTime);
      const playedSec = Math.min(elapsed, r.scheduledSec);
      const rr = refs.current;
      if (rr.gw && rr.sessionId) {
        rr.gw.request("multimodal.tts_played", {
          session_id: rr.sessionId,
          response_id: r.currentRid,
          played_ms: playedSec * 1000,
          total_ms: r.scheduledSec * 1000,
        }).catch(() => { /* best-effort */ });
      }
    }
    for (const src of r.active) { try { src.stop(); } catch { /* noop */ } }
    r.active = [];
    // Playback stopped early → lift the mic mute now (keep only a short tail for
    // speaker/AEC decay) so the user can talk again immediately.
    r.ttsMuteUntil = Math.min(r.ttsMuteUntil, Date.now() + 300);
    if (resetRid && r.currentRid) {
      r.cancelled.add(r.currentRid);
      // Cap the cancelled Set so it can't grow unbounded over a long session.
      if (r.cancelled.size > 64) {
        r.cancelled = new Set(Array.from(r.cancelled).slice(-32));
      }
      r.currentRid = null;
      r.scheduledSec = 0;
      if (r.audioCtx) r.audioNextStart = r.audioCtx.currentTime;
      setTtsPlaying(false);
    }
  }, []);

  const onTtsChunk = useCallback((msg: {
    response_id?: string; pcm_b64?: string; sample_rate?: number; is_final?: boolean;
  }) => {
    const r = ttsRefs.current;
    const rid = msg.response_id || "";
    // ★ Barge-in sentinel: 后端 interrupt_tts 发 rid="__interrupt__" + is_final=true
    //   通知前端立即停播。之前只按 rid 匹配, 这个 sentinel 匹配不上任何当前 rid → 忽略,
    //   前端已收到的 PCM 继续在 WebAudio 里播完 = "打断没效果"。识别它 → 全停。
    if (rid === "__interrupt__") {
      stopAllTts(true);
      return;
    }
    if (r.cancelled.has(rid)) return;
    if (msg.is_final) {
      if (r.currentRid === rid) {
        // Let queue drain; just clear the playing badge.
        setTtsPlaying(false);
      }
      return;
    }
    if (!msg.pcm_b64) return;
    const ctx = ensureAudioCtx();
    if (r.currentRid !== rid) {
      for (const s of r.active) { try { s.stop(); } catch { /* noop */ } }
      r.active = [];
      r.currentRid = rid;
      r.audioNextStart = ctx.currentTime;
      // ★ #2: 新 rid 开播 → 记起播时刻 + 清零已排定时长 (用于打断时算"实际听了多少")。
      r.ctxStartTime = ctx.currentTime;
      r.scheduledSec = 0;
      setTtsPlaying(true);
    }
    try {
      const bin = atob(msg.pcm_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // PCM16 is 2 bytes/sample; `new Int16Array(buffer)` throws RangeError if
      // the byte length is odd (a truncated chunk at a boundary). Drop the
      // trailing odd byte so a malformed frame degrades to a tiny gap instead
      // of a swallowed exception.
      const evenLen = bytes.byteLength & ~1;
      const i16 = new Int16Array(bytes.buffer, 0, evenLen >> 1);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768.0;
      const sr = msg.sample_rate || 24000;
      const buf = ctx.createBuffer(1, f32.length, sr);
      buf.copyToChannel(f32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, r.audioNextStart);
      src.start(startAt);
      r.active.push(src);
      r.audioNextStart = startAt + buf.duration;
      r.scheduledSec += buf.duration;   // ★ #2: 累计当前 rid 已排定总时长
      // Mute the mic through this chunk's playback (AudioContext time → wall
      // clock) + a short tail, so speaker output isn't re-captured into ASR.
      const playoutMs = Math.max(0, r.audioNextStart - ctx.currentTime) * 1000;
      r.ttsMuteUntil = Math.max(r.ttsMuteUntil, Date.now() + playoutMs + 300);
      src.onended = () => {
        const i = r.active.indexOf(src);
        if (i >= 0) r.active.splice(i, 1);
      };
    } catch { /* drop chunk */ }
  }, [ensureAudioCtx, stopAllTts]);

  // ── Gateway session lifecycle ──────────────────────────────────────────
  useEffect(() => {
    const gw = new GatewayClient();
    refs.current.gw = gw;

    // ★ Session-scoped guard (对齐 desktop mine()). Backend _emit stamps every
    //   event with session_id = the LIVE sid. After a ?mm= switch (or any
    //   session change) refs.current.sessionId points at the NEW session, so
    //   straggler events from the OLD session (still finishing server-side)
    //   carry a different sid → dropped here instead of polluting the new
    //   session's waterfall/panels. Untagged events (no session_id) are treated
    //   as ours (legacy/broadcast).
    const isMine = (ev: { session_id?: string }): boolean =>
      !ev.session_id || ev.session_id === refs.current.sessionId;

    // Phase 10: derive a routing key from payload (request_id > monitor_id >
    // "__main__"). The frontend keeps one bubble per key so concurrent
    // RouterEngine delegations + multi-monitor SPEAKs don't share streams.
    const keyOf = (p: any): string =>
      (p && (p.request_id || p.monitor_id)) || "__main__";
    let activeForegroundKey = "__main__";
    // Trace helper — logs one milestone the first time it's seen this turn.
    // Cleared when sendAsk fires a new turn (via __mmTraceLast reset).
    const traceOnce = (stage: string, color = "#0d6efd") => {
      const w = window as any;
      const t = w.__mmTraceLast;
      if (!t || t.seen[stage]) return;
      t.seen[stage] = true;
      // eslint-disable-next-line no-console
      console.log(
        `%c[mm-trace-fe] +${(performance.now() - t.t0).toFixed(0)}ms ${stage}`,
        `color:${color}`,
      );
    };

    // Create the assistant bubble for a stream key and register its id. Shared
    // by message.start AND message.delta/.complete: if a delta/complete arrives
    // for a key that has no bubble yet (events can arrive out of order — a
    // watcher delta racing ahead of its message.start would otherwise be
    // dropped, leaving the sub-window title present but body empty), we lazily
    // synthesize the bubble here from the event's own payload so no token is
    // lost. Returns the bubble id.
    // Monitor alerts are routed to the right multimodal panel (monitorAlerts
    // state), NOT to the center chat. Everything else (main agent, query
    // worker, deep-research router bubbles) still creates a center-chat bubble.
    // Watcher no longer streams message.* into the chat at all — its content
    // arrives through watcher.report_append + multimodal.bg (right panel only).
    const ensureBubble = (p: {
      source?: string; request_id?: string;
      monitor_id?: string; monitor_label?: string; brief?: string;
    }): string => {
      const key = keyOf(p);
      const isMonitor = p.source === "monitor" || !!p.monitor_id;
      if (isMonitor) {
        const monitorId = p.monitor_id || key;
        const existing = curMonitorAlertId.current.get(key);
        if (existing) return existing.alertId;
        const alertId = nid();
        curMonitorAlertId.current.set(key, { monitorId, alertId });
        // Seed the alert into monitorAlerts as a streaming placeholder. Text
        // fills in via message.delta; message.complete flips streaming → false.
        setMonitorAlerts((prev) => {
          const next = new Map(prev);
          const list = next.get(monitorId) ? next.get(monitorId)!.slice() : [];
          list.push({ id: alertId, text: "", ts: Date.now(), streaming: true });
          next.set(monitorId, list);
          return next;
        });
        return alertId;
      }
      const existing = curAssistantId.current.get(key);
      if (existing) return existing;
      const id = nid();
      curAssistantId.current.set(key, id);
      setMessages((prev) => capMsgs([...prev, {
        id, role: "assistant", text: "", streaming: true,
        awaitingFirstDelta: true,
        hasReasoning: false,
        brief: p.brief,
        requestId: p.request_id,
      }]));
      refs.current.isAnswering = true;
      return id;
    };

    // A user turn owns its answer slot before the backend starts. When the
    // main agent transfers reply ownership, QueryWorker reuses that same slot;
    // tag it in place so out-of-order completion remains visibly attributable
    // without moving the bubble away from its originating question.
    const markQueryWorker = (p: { source?: string; request_id?: string }) => {
      if (p.source !== "query_worker") return;
      const id = curAssistantId.current.get(keyOf(p));
      if (!id) return;
      setMessages((prev) => prev.map((m) => (
        m.id === id && m.subRole !== "query_worker"
          ? { ...m, subRole: "query_worker" }
          : m
      )));
    };

    const offStart = gw.on<{ source?: string; request_id?: string; monitor_id?: string; monitor_label?: string; brief?: string }>(
      "message.start", (ev) => {
        if (!isMine(ev)) return;
        const p = ev.payload || {};
        traceOnce(`message_start (source=${p.source || "-"})`);
        markQueryWorker(p);
        const key = keyOf(p);
        if (!p.monitor_id && p.source !== "monitor") activeForegroundKey = key;
        // User-originated turns already own a preallocated answer slot directly
        // below their query. Mark that slot active without moving it. Backend-
        // originated turns still create lazily on delta/complete so user_echo
        // remains before their assistant bubble.
        const id = curAssistantId.current.get(key);
        if (id) {
          setMessages((prev) => prev.map((m) => (
            m.id === id && m.queued
              ? { ...m, queued: false, queuePosition: undefined }
              : m
          )));
        }
      });
    // ── Streaming batcher ────────────────────────────────────────────────
    // The old code called setMessages + prev.map() PER TOKEN for message.delta,
    // reasoning.delta and thinking.delta. On qwen3.x with thinking ON, one turn
    // easily emits 200+ tokens; after 3-4 turns the chat list is ~30 items and
    // Markdown+syntax-highlighter re-parse every assistant bubble each frame.
    // React couldn't keep up → main thread wedged (hover unresponsive).
    //
    // Fix: buffer text/reasoning deltas into refs keyed by bubble id, and flush
    // them in a single setMessages() on a throttled timer (~10 fps). rAF-only
    // batching still hit 60 updates/s — too many when combined with screen
    // capture JPEG encode + JSON.stringify on the same main thread.
    // ★ 80ms ≈ 12.5fps 的统一 flush (主 agent message.delta + 深度分析 bg 共用)。
    //   ★ 丝滑修复: 下游渲染【不再叠加第二层节流】—— 主气泡 Markdown 直接吃 body、
    //   面板 LiveMarkdown 直接吃 content。原来在 flush 之上又套 120/150ms 的
    //   useThrottledValue, 与 flush 相位错开产生"一段段"拍频, 已移除。现在唯一的节流
    //   就是这个 flush, 帧率稳定无拍频。
    const STREAM_FLUSH_MS = 80;
    const streamBuf = { text: new Map<string, string>(), reasoning: new Map<string, string>() };
    // ★ multimodal.bg 事件队列 (answer_delta 流式高频)。
    let bgQueue: any[] = [];
    // Deferred deepExpanded update: raw bg handler records the last rid, flush
    // applies it once (one setState per flush cycle instead of per-event).
    let bgPendingExpandRid: string | null = null;
    // ★ 消息队列: tool.start / tool.complete / status.update / watcher.report_append
    //   等非流式但高频的事件。之前直接调 setMessages() → 深度研究时 watcher ReAct 循环
    //   密集 tool 调用 (每轮 2-4 个, 10 轮 = 40-80 次) 绕过 80ms 节流系统, 每次都触发
    //   全量重渲染与已节流的 flush 竞争主线程 → livelock → 界面卡死。现在统一入队, 由
    //   runUnifiedFlush 一帧 drain 一次, 与 stream/bg 合并为一次 React 批量更新。
    type MsgQueueEntry =
      | { action: "append"; msg: ChatMsg }
      | { action: "patch_tool"; toolId: string; toolName?: string; patch: Partial<ChatMsg> }
      | { action: "patch_query_worker"; taskId: string; step: QueryWorkerProgressStep }
      | { action: "collapse_status"; text: string };
    let msgQueue: MsgQueueEntry[] = [];
    // Progress can race ahead of tool.complete because QueryWorker is scheduled
    // before the tool handler returns. Buffer by qry_* so the complete event can
    // attach every already-seen step to the correct tool card in one patch.
    // ★ 统一节流器: message.delta (主 agent) 与 multimodal.bg (深度分析) 共用 ONE
    //   timer + ONE rAF。两个 Agent 并发输出时, 同一帧内把两条流一次性 drain
    //   (runStreamFlush + runBgFlush 背靠背), React 自动把两次 setState 批处理成
    //   一次重渲染 —— 避免"长 markdown 报告重渲 + deep-panel 重渲"在同一主线程各自
    //   触发把线程撑爆 (页面无响应)。
    let flushTimer: number | null = null;
    let flushRaf: number | null = null;   // ★ C26: 卸载时取消, 防卸载后 setState。
    let flushDisposed = false;
    const runStreamFlush = () => {
      if (streamBuf.text.size === 0 && streamBuf.reasoning.size === 0) return;
      _mmAct("streamFlush", `keys=${streamBuf.text.size}`);
      const textDrain = streamBuf.text; streamBuf.text = new Map();
      const reasonDrain = streamBuf.reasoning; streamBuf.reasoning = new Map();
      setMessages((prev) => {
        // Single pass over the list; only patch objects that actually have
        // pending deltas (avoid new-referencing the entire list per turn).
        let dirty = false;
        const next = prev.map((m) => {
          const td = textDrain.get(m.id);
          const rd = reasonDrain.get(m.id);
          if (td === undefined && rd === undefined) return m;
          dirty = true;
          const patch: Partial<ChatMsg> = {};
          if (td !== undefined) {
            patch.text = m.text + td;
            // 一旦正文开始, 第一行整体让位 —— 清 awaiting/hasReasoning。
            //   m.reasoning 后台保留, 供下一轮 API 回传。
            patch.awaitingFirstDelta = false;
            patch.hasReasoning = false;
            patch.reasoningSummary = undefined;
          }
          if (rd !== undefined) {
            patch.reasoning = (m.reasoning || "") + rd;
            patch.awaitingFirstDelta = false;
            patch.hasReasoning = true;
          }
          if (td !== undefined && m.queued) patch.queued = false;
          return { ...m, ...patch };
        });
        try { (window as any).__mmN = { ...(window as any).__mmN, msgs: next.length }; } catch { /* noop */ }
        return dirty ? next : prev;
      });
    };
    // ── ★ 主线程卡顿看门狗 + 面包屑 (诊断"整界面卡死", F12 一卡就死拿不到 profile) ──
    //   _mmAct("动作名"): 记录最近一次热路径动作 + 时间戳到 window.__mmAct。
    //   看门狗每 250ms tick 一次; 若两次 tick 间隔 >> 250ms, 说明主线程刚被占死过,
    //   console.warn 报出"卡了多久 + 卡死前最后动作 + 当前数据规模"。卡死缓过来后
    //   Console 里最后一条 [mm-watchdog] 就是现场。生产可留 (开销极小)。
    const _mmAct = (name: string, extra?: string) => {
      (window as any).__mmAct = { name, extra: extra || "", t: performance.now() };
    };
    let _wdLast = performance.now();
    const _watchdog = window.setInterval(() => {
      const now = performance.now();
      const gap = now - _wdLast;
      _wdLast = now;
      // 期望间隔 250ms; 超过 600ms 视为主线程被占死过一段。
      if (gap > 600) {
        const a = (window as any).__mmAct || {};
        const sinceAct = a.t ? Math.round(now - a.t) : -1;
        // eslint-disable-next-line no-console
        console.warn(
          `%c[mm-watchdog] 主线程卡顿 ${Math.round(gap)}ms | 卡死前最后动作=${a.name || "?"}` +
          `${a.extra ? "(" + a.extra + ")" : ""} 距今${sinceAct}ms`,
          "color:#dc3545;font-weight:bold",
        );
      }
    }, 250);

    // 批量 flush: 把 msgQueue 里累积的 tool/status/report 事件一次性 reduce 进
    // messages, 只触发 1 次 setMessages。由统一节流器 runUnifiedFlush 调用。
    const runMsgQueueFlush = () => {
      if (msgQueue.length === 0) return;
      const drain = msgQueue; msgQueue = [];
      _mmAct("msgQueueFlush", `queued=${drain.length}`);
      setMessages((prev) => {
        let list = prev;
        for (const entry of drain) {
          if (entry.action === "append") {
            list = capMsgs([...list, entry.msg]);
          } else if (entry.action === "patch_tool") {
            let idx = entry.toolId
              ? list.findIndex((m) => m.kind === "tool" && m.toolId === entry.toolId && !m.toolDone)
              : -1;
            if (idx < 0 && entry.toolName) {
              for (let i = list.length - 1; i >= 0; i--) {
                const m = list[i];
                if (m.kind === "tool" && m.toolName === entry.toolName && !m.toolDone) { idx = i; break; }
              }
            }
            if (idx >= 0) {
              const next = list.slice();
              next[idx] = { ...next[idx], ...entry.patch };
              list = next;
            } else {
              list = capMsgs([...list, {
                id: nid(), role: "assistant", text: "", kind: "tool",
                toolId: entry.toolId, toolName: entry.toolName || "tool",
                ...entry.patch,
              } as ChatMsg]);
            }
          } else if (entry.action === "patch_query_worker") {
            const idx = list.findIndex((m) =>
              m.kind === "tool" && m.workerTaskId === entry.taskId);
            if (idx >= 0) {
              const current = list[idx];
              const existing = current.workerProgress || [];
              if (!existing.some((step) => step.id === entry.step.id)) {
                const nextProgress = queryProgressByTaskRef.current.get(entry.taskId)
                  || mergeQueryWorkerProgress(existing, entry.step);
                const next = list.slice();
                next[idx] = {
                  ...current,
                  workerProgress: nextProgress,
                  workerStatus: entry.step.terminal
                    ? entry.step.status
                    : current.workerStatus || "running",
                };
                list = next;
              }
            }
          } else if (entry.action === "collapse_status") {
            const last = list[list.length - 1];
            if (last && last.kind === "status") {
              const next = list.slice();
              next[next.length - 1] = { ...last, text: entry.text };
              list = next;
            } else {
              list = capMsgs([...list, { id: nid(), role: "assistant", text: entry.text, kind: "status" }]);
            }
          }
        }
        return compactQueryWorkerMessageProgress(
          list, queryProgressByTaskRef.current,
        );
      });
    };

    // 统一 flush: 同一帧内同时 drain 主 agent 流 + 深度分析 bg 流 + 消息队列。
    const runUnifiedFlush = () => {
      const _t0 = performance.now();
      _mmAct("unifiedFlush");
      runStreamFlush();
      runBgFlush();
      runMsgQueueFlush();
      const _dt = performance.now() - _t0;
      // 单次 flush >50ms = 一帧预算 (16ms) 的 3 倍以上, 该帧必掉。报出规模帮定位。
      if (_dt > 50) {
        // eslint-disable-next-line no-console
        console.warn(
          `%c[mm-watchdog] flush 耗时 ${Math.round(_dt)}ms | msgs=${(window as any).__mmN?.msgs ?? "?"}` +
          ` bg=${(window as any).__mmN?.bg ?? "?"} seg=${(window as any).__mmN?.seg ?? "?"}`,
          "color:#dc3545",
        );
      }
    };
    const scheduleFlush = () => {
      if (flushTimer !== null || flushDisposed) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        if (flushDisposed) return;
        flushRaf = requestAnimationFrame(() => {
          flushRaf = null;
          if (flushDisposed) return;
          runUnifiedFlush();
        });
      }, STREAM_FLUSH_MS);
    };
    const appendText = (id: string, delta: string) => {
      if (!id || !delta) return;
      streamBuf.text.set(id, (streamBuf.text.get(id) || "") + delta);
      scheduleFlush();
    };
    const offDelta = gw.on<{ text?: string; source?: string; request_id?: string; monitor_id?: string; monitor_label?: string }>(
      "message.delta", (ev) => {
        if (!isMine(ev)) return;
        const p = ev.payload || {};
        traceOnce("first_message_delta", "#28a745");
        if (!p.text) return;
        const isMonitor = p.source === "monitor" || !!p.monitor_id;
        if (isMonitor) {
          // Route monitor deltas to the right-panel alert list (NOT chat).
          // Lazily create the alert if the delta beat message.start.
          ensureBubble(p);
          const key = keyOf(p);
          const rec = curMonitorAlertId.current.get(key);
          if (!rec) return;
          setMonitorAlerts((prev) => {
            const next = new Map(prev);
            const list = next.get(rec.monitorId);
            if (!list) return prev;
            const at = list.findIndex((a) => a.id === rec.alertId);
            if (at < 0) return prev;
            const cp = list.slice();
            cp[at] = { ...cp[at], text: cp[at].text + p.text! };
            next.set(rec.monitorId, cp);
            return next;
          });
          return;
        }
        // Lazily create the bubble if the delta beat its message.start (out of
        // order delivery) — otherwise the token would be silently dropped.
        const id = ensureBubble(p);
        markQueryWorker(p);
        appendText(id, p.text);
      });
    const offComplete = gw.on<{
      text?: string; source?: string; request_id?: string;
      monitor_id?: string; monitor_label?: string; status?: string; brief?: string;
      history_policy?: unknown; ephemeral_control?: unknown; ephemeral?: unknown;
    }>(
      "message.complete", (ev) => {
        if (!isMine(ev)) return;
        const p = ev.payload || {};
        const isMonitor = p.source === "monitor" || !!p.monitor_id;
        if (isMonitor) {
          // Finalize the monitor alert on the right-panel list. If the whole
          // stream arrived as one complete (no prior start/delta), synthesize
          // the alert now so its text isn't lost. Then flip streaming → false.
          ensureBubble(p);
          const key = keyOf(p);
          const rec = curMonitorAlertId.current.get(key);
          curMonitorAlertId.current.delete(key);
          if (!rec) return;
          const finalText = (p.text || "").toString();
          setMonitorAlerts((prev) => {
            const next = new Map(prev);
            const list = next.get(rec.monitorId);
            if (!list) return prev;
            const at = list.findIndex((a) => a.id === rec.alertId);
            if (at < 0) return prev;
            const cp = list.slice();
            const cur = cp[at];
            // If deltas already accumulated, keep that; else use the payload's
            // full text (single-complete case).
            const text = cur.text.trim() ? cur.text : finalText;
            cp[at] = { ...cur, text, streaming: false };
            next.set(rec.monitorId, cp);
            return next;
          });
          return;
        }
        // (Watcher no longer streams into the center chat via message.* — the dead
        // source=watcher/watcher_threadback branches were removed. Watcher
        // process/report live in the right panel + arrive as folded bubbles via
        // watcher.report_append.)
        const key = keyOf(p);
        const ephemeralControl = isEphemeralControl(p);
        // If the whole stream arrived as a single complete (no start/delta seen),
        // synthesize the bubble so its text isn't lost, then finalize it.
        const id = curAssistantId.current.get(key) ?? ensureBubble(p);
        markQueryWorker(p);
        curAssistantId.current.delete(key);
        if (activeForegroundKey === key) activeForegroundKey = "__main__";
        refs.current.isAnswering = curAssistantId.current.size > 0;
        traceOnce("message_complete", "#28a745");
        if (!id) return;
        // Cancel any pending throttled flush — we drain inline below.
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        // Final flush + clear streaming flag in ONE setMessages call. Running
        // flush inline ensures the completed bubble's last tokens land before
        // we mark it not-streaming (otherwise the tail could be lost if a rAF
        // was still pending).
        const textDrain = streamBuf.text; streamBuf.text = new Map();
        const reasonDrain = streamBuf.reasoning; streamBuf.reasoning = new Map();
        // tool.complete precedes message.complete on the wire, but its throttled
        // card update may still be queued. Flush it first so the final ephemeral
        // turn cleanup runs after every tool card has been correlated/rendered.
        if (ephemeralControl) runMsgQueueFlush();
        setMessages((prev) => {
          const completed = prev.map((m) => {
            if (m.id !== id) {
              // Still apply any pending drains to non-target bubbles.
              const td = textDrain.get(m.id); const rd = reasonDrain.get(m.id);
              if (td === undefined && rd === undefined) return m;
              return { ...m, ...(td !== undefined ? { text: m.text + td } : {}),
                       ...(rd !== undefined ? { reasoning: (m.reasoning || "") + rd } : {}),
                       ...(td !== undefined && m.queued
                         ? { queued: false, queuePosition: undefined } : {}) };
            }
            const td = textDrain.get(id) || ""; const rd = reasonDrain.get(id) || "";
            const streamed = m.text + td;
            // Thread-back completes carry the full body in payload.text with no
            // prior deltas — don't leave the bubble empty.
            const text = streamed.trim() ? streamed : (p.text || streamed);
            return { ...m, text,
                     reasoning: rd ? (m.reasoning || "") + rd : m.reasoning,
                     streaming: false, queued: false, queuePosition: undefined };
          });
          // Pure Monitor control turns live in the right-side registry and
          // sidechannel, not in canonical chat. The final turn-level marker is
          // authoritative: drop every center item carrying this request id,
          // including all tool cards in the batch. Legacy uncorrelated events
          // still remove only the known assistant bubble.
          return ephemeralControl
            ? removeEphemeralControlTurn(completed, key === "__main__" ? "" : key, id)
            : completed;
        });
        // ★ 统一节流器: message.complete 取消了共享 flushTimer, 若此刻有排队的 bg/msg
        //   事件 (深度分析并发) 会被搁置 → 这里补 drain 一次, 不丢进度。
        runBgFlush();
        runMsgQueueFlush();
      });
    // Observation panels (画面观察/音频观察/搜索事实) pushed by the memory backend.
    let ctxPending: CtxState | null = null;
    let ctxFlushScheduled = false;
    let ctxRaf: number | null = null;
    const offCtx = gw.on<{
      obs?: ObsItem[]; audio_obs?: ObsItem[];
      facts?: Record<string, string>; version?: number;
    }>("multimodal.ctx", (ev) => {
      if (!isMine(ev)) return;
      const c = ev.payload || {};
      // Cap the observation arrays — backend pushes the full log each time and
      // over a long session these grow unbounded, making each obs-panel render
      // slower. Keep the most recent 200 (matches the visible scrollable view).
      const rawObs = c.obs || [];
      const rawAObs = c.audio_obs || [];
      ctxPending = {
        version: c.version || 0,
        obs: rawObs.length > 200 ? rawObs.slice(rawObs.length - 200) : rawObs,
        audioObs: rawAObs.length > 200 ? rawAObs.slice(rawAObs.length - 200) : rawAObs,
        facts: c.facts || {},
      };
      if (ctxFlushScheduled) return;
      ctxFlushScheduled = true;
      ctxRaf = requestAnimationFrame(() => {
        ctxFlushScheduled = false;
        ctxRaf = null;
        // Guard against a rAF firing after unmount (setState on dead component).
        if (flushDisposed) return;
        if (ctxPending) setCtx(ctxPending);
      });
    });

    // ── Tool / status / reasoning progress (so long requests show feedback) ──
    // ★ tool.start / tool.complete 走 msgQueue + 统一节流 flush, 不再直接
    //   setMessages。深度研究 watcher ReAct 循环密集 tool 调用绕过节流系统是
    //   "界面卡死"的主因。
    const offToolStart = gw.on<{
      tool_id?: string; name?: string; context?: any; args_text?: string;
      args_fields?: ToolArgField[]; request_id?: string;
    }>(
      "tool.start", (ev) => {
        if (!isMine(ev)) return;
        const p = ev.payload || {};
        const turnRequestId = p.request_id
          || (activeForegroundKey !== "__main__" ? activeForegroundKey : undefined);
        // ★ 每个分支都要能落到下一个兜底。之前写成
        //   `typeof p.context === "string" ? p.context : (…) || p.args_text`,
        //   于是 context 为空字符串时三元的第一支直接返回 "" —— 后面的
        //   args_text 兜底永远不生效 (verbose 模式对这行完全无效)。
        const ctxStr =
          (typeof p.context === "string" ? p.context : "")
          || (p.context && typeof p.context === "object"
            ? (p.context.summary || p.context.text || "") : "")
          || p.args_text
          || "";
        msgQueue.push({ action: "append", msg: {
          id: nid(), role: "assistant", text: "", kind: "tool",
          toolId: p.tool_id, toolName: p.name || "tool", toolCtx: String(ctxStr || ""),
          ...(p.args_fields?.length ? { toolArgs: p.args_fields } : {}),
          toolDone: false, requestId: turnRequestId,
        }});
        scheduleFlush();
      });
    const offToolComplete = gw.on<{
      tool_id?: string; name?: string; summary?: string; duration_s?: number;
      result_text?: string; inline_diff?: string; render_hint?: string;
      dispatch_label?: string; dispatch_note?: string; request_id?: string; task_id?: string;
      result?: unknown;
      recall_debug?: unknown;
    }>("tool.complete", (ev) => {
      if (!isMine(ev)) return;
      const p = ev.payload || {};
      const turnRequestId = p.request_id
        || (activeForegroundKey !== "__main__" ? activeForegroundKey : undefined);
      const detail = p.dispatch_note || p.inline_diff || p.result_text || "";
      const durMs = p.duration_s != null ? Math.round(p.duration_s * 1000) : undefined;
      const summary = p.dispatch_label || p.summary || "";
      const recallDebug = isQueryMultimodalToolName(p.name)
        ? (extractRecallDebug(p.recall_debug, detail) || extractRecallDebug(p.result, detail))
        : null;
      const workerTaskId = isQueryMultimodalToolName(p.name)
        ? String(p.task_id || "") : "";
      const bufferedWorkerProgress = workerTaskId
        ? (queryProgressByTaskRef.current.get(workerTaskId) || [])
          .slice(-QUERY_WORKER_PROGRESS_LIMIT) : [];
      const terminalWorkerStep = [...bufferedWorkerProgress]
        .reverse().find((step) => step.terminal);
      msgQueue.push({ action: "patch_tool", toolId: p.tool_id || "", toolName: p.name, patch: {
        toolDone: true, toolSummary: summary, toolDurationMs: durMs, toolDetail: detail,
        ...(recallDebug?.trace?.length ? { recallTrace: recallDebug.trace } : {}),
        ...(recallDebug?.findings ? { recallFindings: recallDebug.findings } : {}),
        ...(turnRequestId ? { requestId: turnRequestId } : {}),
        ...(workerTaskId ? {
          workerTaskId,
          workerStatus: (terminalWorkerStep?.status || "running") as ChatMsg["workerStatus"],
          workerProgress: bufferedWorkerProgress,
        } : {}),
      }});
      scheduleFlush();
    });
    // Live-watcher is FULLY decoupled from the main agent chat: per-round process
    // arrives via multimodal.bg (DeepPanel segment cards) and the final
    // consolidated report via watcher.final. NOTHING is appended to the center
    // chat — no turn-2 mutation, no lock contention with user/agent turns.
    const offWatcherFinal = gw.on<{ request_id?: string; brief?: string; text?: string }>(
      "watcher.final", (ev) => {
        if (!isMine(ev)) return;
        const p = ev.payload || {};
        const rid = p.request_id || "";
        const text = (p.text || "").trim();
        if (!rid || !text) return;
        setBgItems((prev) => {
          const idx = prev.findIndex((b) => b.requestId === rid);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = { ...next[idx], finalReport: text, done: true };
            return next;
          }
          // No bg item yet (run produced no visible events) → create one so the
          // final report is still shown in the panel.
          return [...prev, { id: rid, requestId: rid, segments: [], finalReport: text, done: true }].slice(-8);
        });
      });
    // Per-round report: the live DeepWindow already streams each segment's
    // answer via multimodal.bg answer_delta events, and the backend persists
    // each round to mm_watcher_reports for reopen restore. So this event is a
    // no-op on the frontend now — no center-chat bubble, no double-append.
    const offReportAppend = gw.on<{ request_id?: string; round?: number; text?: string }>(
      "watcher.report_append", () => { /* no-op: live=bg, reopen=list_watcher_content */ });
    // Terminal marker: the delegation finished. The final report is delivered via
    // watcher.final; this is kept only for potential future UI cues.
    const offDeepComplete = gw.on<{ request_id?: string; brief?: string }>(
      "watcher.complete", () => { /* no-op: final report delivered via watcher.final */ });
    const offStatus = gw.on<{ kind?: string; text?: string }>("status.update", (ev) => {
      if (!isMine(ev)) return;
      const text = (ev.payload?.text || "").trim();
      if (!text) return;
      msgQueue.push({ action: "collapse_status", text });
      scheduleFlush();
    });
    const appendReasoning = (delta: string) => {
      // reasoning.delta has no id → attach to the main agent's open bubble
      // (the only bubble that produces reasoning in the mainline path).
      // Routes through the same rAF-batched streamBuf as message.delta so
      // reasoning tokens don't trigger a re-render each.
      const id = curAssistantId.current.get(activeForegroundKey)
        || curAssistantId.current.get("__main__");
      if (!id || !delta) return;
      streamBuf.reasoning.set(id, (streamBuf.reasoning.get(id) || "") + delta);
      scheduleFlush();
    };
    const offReasoning = gw.on<{ text?: string }>("reasoning.delta",
      (ev) => { if (!isMine(ev)) return; traceOnce("first_reasoning_delta"); appendReasoning(ev.payload?.text || ""); });
    const offThinking = gw.on<{ text?: string }>("thinking.delta",
      (ev) => { if (!isMine(ev)) return; traceOnce("first_thinking_delta"); appendReasoning(ev.payload?.text || ""); });
    // Auxiliary-LLM 生成的 ~10 字段级 label. 后端每攒够一段 reasoning 就
    // fire 一次; 前端把最新一条塞进 m.reasoningSummary, 供 AssistantMessage
    // 第一行滚动展示。失败/超时时后端不推 —— FE 自动 fallback 到"reasoning
    // 原文最后一行"呈现 (在渲染层判断)。
    const offReasoningSummary = gw.on<{ text?: string }>("reasoning.summary",
      (ev) => {
        if (!isMine(ev)) return;
        const t = (ev.payload?.text || "").trim();
        if (!t) return;
        const id = curAssistantId.current.get(activeForegroundKey)
          || curAssistantId.current.get("__main__");
        if (!id) return;
        setMessages((prev) => prev.map((m) => (
          m.id === id ? { ...m, reasoningSummary: t, hasReasoning: true, awaitingFirstDelta: false } : m
        )));
      });
    const offError = gw.on<{ message?: string; request_id?: string }>("error", (ev) => {
      if (!isMine(ev)) return;
      const p = ev.payload || {};
      const msg = p.message || "未知错误";
      if (p.request_id) {
        const id = curAssistantId.current.get(p.request_id);
        curAssistantId.current.delete(p.request_id);
        if (activeForegroundKey === p.request_id) activeForegroundKey = "__main__";
        if (id) {
          setMessages((prev) => prev.map((m) => (
            m.id === id
              ? { ...m, text: `错误: ${msg}`, streaming: false,
                  queued: false, queuePosition: undefined, isError: true }
              : m
          )));
          refs.current.isAnswering = curAssistantId.current.size > 0;
          return;
        }
      }
      // An error aborts whatever streams were in flight — no message.complete
      // will arrive to clear their curAssistantId keys. Clear the key map and
      // close any still-streaming bubbles so stale streaming state doesn't
      // linger. (isAnswering is deprecated no-op bookkeeping now.)
      curAssistantId.current.clear();
      refs.current.isAnswering = false;
      setMessages((prev) => capMsgs([
        ...prev.map((m) => (m.streaming
          ? { ...m, streaming: false, queued: false, queuePosition: undefined }
          : m)),
        { id: nid(), role: "system", text: `错误: ${msg}`, isError: true },
      ]));
    });
    const offSessionInfo = gw.on<{ model?: string }>("session.info", (ev) => {
      const m = ev.payload?.model;
      if (m) setModel(m);
    });
    // 监控/深度研究过程失败/停用 → 右侧面板底部 toast (10s 淡出, 多条自然堆叠 —— 见 setMmToasts
    //   的 prev+push, 不做互相踢)。不进 history、不发主气泡。
    const offToast = gw.on<{ level?: string; text?: string }>("multimodal.toast", (ev) => {
      if (!isMine(ev)) return;
      const text = (ev.payload?.text || "").trim();
      if (!text) return;
      const id = nid();
      const level = ev.payload?.level || "error";
      setMmToasts((prev) => [...prev, { id, level, text }]);
      setTimeout(() => setMmToasts((prev) => prev.filter((x) => x.id !== id)), 10000);
    });
    // Multimodal RouterEngine background progress (search / recall / crop).
    const offBg = gw.on<{
      type?: string; channel?: string; task_id?: string; brief?: string;
      label?: string; phase?: string; frame_ts?: number; target?: string;
      crops?: CropItem[]; anchor_ts?: number; anchor_jpeg_b64?: string;
      observations?: { name?: string; obs_summary?: string }[];
      findings_len?: number; n_frames?: number; rounds?: number;
      elapsed_sec?: number; findings?: string; thought?: string;
      can_answer?: boolean; text_len?: number; text_preview?: string;
      have?: number; need?: number;
      report?: string; batches?: number; obs_summary?: string; n_clues?: number;
      frame_ts_range?: [number, number]; seg?: number; delegation_done?: boolean;
    }>("multimodal.bg", (ev) => {
      if (!isMine(ev)) return;
      const p: any = ev.payload || {};
      const rid = p.request_id || "";
      // ★ 性能: setDeepExpanded 移到 runBgFlush 末尾统一处理, 不再在每个 bg 事件
      //   上直接 setState → 减少一个与 flush 竞争主线程的重渲染源。
      if (rid) bgPendingExpandRid = rid;
      // ★ 性能 (livelock 根治): deep research 现在是真实 LLM token 流式 (每 chunk 一条
      //   answer_delta), 一段几千字仍是成百上千条事件。策略与主 Agent 一致 —— 后端不合并,
      //   靠前端吸收: (1) 这里【入队时合并】—— 若队尾已是同一 (rid, seg) 的 answer_delta,
      //   直接把本次 delta 追加到队尾那条上, 不新增队列项 → 无论后端发多快, answer_delta
      //   在队列里对每个段最多占 1 条, 队列长度不随 token 数增长 (根治雪崩);
      //   (2) 下游走与 message.delta 共用的 100ms 节流 flush (scheduleFlush)。双重吸收。
      if (p.type === "answer_delta" && typeof p.delta === "string") {
        const tail = bgQueue[bgQueue.length - 1];
        if (tail && tail.type === "answer_delta"
            && (tail.request_id || "") === rid
            && tail.seg === p.seg
            && (tail.channel || "bg") === (p.channel || "bg")) {
          tail.delta = String(tail.delta || "") + p.delta;
          scheduleFlush();
          return;
        }
      }
      bgQueue.push(p);
      scheduleFlush();
    });
    // reduceBg: 把一个 bg payload 折进 bgItems 列表 (纯函数, 逻辑与原 setBgItems 内联体
    //   一字不差, 只是抽出来供批量 flush 复用)。
    const reduceBg = (prevList: BgItem[], p: any): BgItem[] => {
      const ch = p.channel || "bg";
      const rid = p.request_id || "";
      if (p.delegation_done && rid) {
        return prevList.map((b) => (b.requestId === rid && !b.done
          ? { ...b, done: true, waiting: null } : b));
      }
      const itemId = rid || `_:${ch}`;
      const prev = prevList;
      {
        const idx = prev.findIndex((b) => b.id === itemId);
        // ★ 性能: 只浅拷贝 BgItem + segments 数组本身, 不深拷贝每个 segment。旧代码
        //   segments.map(s => ({...s})) 每个事件都给【所有】段换新对象 identity →
        //   SegmentCard 的 memo 全部失效 → 每 100ms flush 整列段重渲染。改成: 数组浅拷,
        //   只有被本次修改的那个段 (segFor 里) 才 clone-on-write, 其余段保持原引用 →
        //   memo 生效, 只有变化的那张卡重渲染。
        const cur: BgItem = idx >= 0
          ? { ...prev[idx], segments: prev[idx].segments.slice() }
          : { id: itemId, requestId: rid || undefined, segments: [] };
        if (p.label) cur.label = p.label;

        const t = p.type || "";
        // ★ L: 若本 item 已 done (watcher.final 已到), 忽略迟到的攒帧/新段类事件 ——
        //   它们会重设 cur.waiting / 加空段, 导致"完成报告"下方又冒出"攒帧中…"。
        //   (bg 队列 80ms flush, watcher.final 内联 → final 可能先于最后一批 bg 到。)
        if (idx >= 0 && prev[idx].done &&
            (t === "waiting" || t === "batch_ready" || t === "segment_start")) {
          return prev;
        }
        const clip = (s: any, n: number) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
        // clone-on-write: 把 cur.segments[i] 换成一个新对象 (仅这一个段变 identity),
        // 返回它供修改。其余段引用不变 → 它们的 SegmentCard memo 命中、不重渲染。
        const cowAt = (i: number): BgSegment => {
          const copy = { ...cur.segments[i], lookups: cur.segments[i].lookups.slice() };
          cur.segments[i] = copy;
          return copy;
        };
        const curSeg = (): BgSegment => {
          if (cur.segments.length === 0) cur.segments.push({ seg: 1, lookups: [] });
          return cowAt(cur.segments.length - 1);
        };
        // The backend stamps `seg` (1-based round index) on every round event.
        // Route to the matching segment (create if new) so out-of-order deltas
        // still land in the right card.
        const segNo = typeof p.seg === "number" && p.seg > 0 ? p.seg : undefined;
        const segFor = (): BgSegment => {
          if (segNo === undefined) return curSeg();
          const at = cur.segments.findIndex((x) => x.seg === segNo);
          if (at < 0) {
            const s = { seg: segNo, lookups: [] } as BgSegment;
            cur.segments.push(s); cur.segments.sort((a, b) => a.seg - b.seg);
            return cur.segments.find((x) => x.seg === segNo)!;
          }
          return cowAt(at);
        };

        if (t === "waiting") {
          // Frame-accumulation: current/target frames + ttl countdown (so the
          // panel shows a live "攒帧 N/target · ttl 余 Ns" instead of freezing).
          cur.waiting = {
            have: p.have ?? 0, need: p.need ?? 0,
            ttlSec: typeof p.ttl_sec === "number" ? p.ttl_sec : undefined,
            ttlRemaining: typeof p.ttl_remaining === "number" ? p.ttl_remaining : undefined,
            seg: typeof p.seg === "number" ? p.seg : undefined,
            paused: !!p.paused,
          };
        } else if (t === "answer_delta") {
          // Live streaming of THIS segment's interpretation, token by token.
          const s = segFor();
          if (p.delta) s.answer = (s.answer || "") + String(p.delta);
        } else if (t === "batch_ready") {
          // 攒够/开始分析: ★ 不再把 waiting 置 null (那会让攒帧条整块卸载→下次心跳再挂载,
          //   产生"消失又重现"闪烁)。改成原位标记为满额 (have=need), 保持组件挂载;
          //   分析期间的心跳 waiting 会继续原位更新数字, 直到 done 才真正清除。
          if (cur.waiting) cur.waiting = { ...cur.waiting, have: cur.waiting.need };
        } else if (t === "segment_start") {
          // New analysis round → a fresh segment card with its frame time range.
          // 后端在首次拿到 thought 后会补发一条带 scene_label 的 segment_start, 刷新场景标记。
          // ★ 不清 waiting: 保持攒帧条原位, 由后续 waiting 事件原位更新 (见 batch_ready)。
          const s = segFor();
          if (p.frame_ts_range && p.frame_ts_range.length === 2) s.tsRange = p.frame_ts_range;
          if (p.scene_label) s.scene = String(p.scene_label);
        } else if (t === "router_react") {
          // The model's per-round reasoning → 👁 看到 (most human-readable) +
          // 💭 thinking trace + 🔧 tool calls (req ②: show thinking & tool calls).
          const s = segFor();
          // 固定文本描述 (标题行下方): 用户要求不限制字数, 只去首尾空白/换行折叠展示。
          if (p.thought) s.saw = String(p.thought).replace(/\s+/g, " ").trim();
          const tc = (p.tool_calls || []) as { name?: string; args?: Record<string, unknown> }[];
          if (tc.length) {
            s.toolCalls = tc.map((c) => ({
              name: String(c.name || "tool"),
              arg: clip((c.args && (c.args.query ?? c.args.target ?? JSON.stringify(c.args))) as string, 60),
            }));
          }
        } else if (t === "router_thinking") {
          // Raw reasoning trace from a thinking model (req ②).
          const s = segFor();
          if (p.text) s.thinking = ((s.thinking || "") + String(p.text)).slice(-2000);
        } else if (t === "tool_error") {
          // A tool call failed (req ③: surface failures, don't swallow).
          const s = segFor();
          s.toolErrors = s.toolErrors || [];
          s.toolErrors.push({ name: String(p.target || p.brief || "tool"), error: clip(p.findings || p.obs_summary || "调用失败", 120) });
        } else if (t === "bg_progress") {
          // A search/recall dispatched — show it "in flight" (query, no result yet).
          const s = segFor();
          const kind = ch === "recall" ? "recall" : "search";
          const query = clip(p.brief, 80);
          if (query && !s.lookups.some((l) => l.kind === kind && l.query === query)) {
            s.lookups.push({ kind, query });
          }
        } else if (t === "search_done" || t === "recall_done") {
          const s = segFor();
          const kind = t === "recall_done" ? "recall" : "search";
          const query = clip(p.brief, 80);
          const clues = t === "recall_done" && p.n_clues ? ` · ${p.n_clues} 条线索` : "";
          const result = `找到 ${p.findings_len || 0} 字${clues}`
            + (p.elapsed_sec != null ? ` · ${Number(p.elapsed_sec).toFixed(1)}s` : "");
          const existing = s.lookups.find((l) => l.kind === kind && l.query === query && !l.done);
          if (existing) { existing.result = result; existing.done = true; }
          else s.lookups.push({ kind, query, result, done: true });
        } else if (t === "answer_ready") {
          const s = segFor();
          s.ready = true;
          s.readyChars = p.text_len || 0;
          // Store this segment's interpretation text so the expanded card shows
          // it (req ④ folding). Only use the preview if we DIDN'T already stream
          // the full answer via answer_delta (else we'd truncate it to 400 chars).
          if (p.text_preview && !(s.answer && s.answer.length >= (p.text_len || 0)))
            s.answer = clip(p.text_preview, 400);
          // Fallback "看到" when the round jumped straight to answering with an
          // empty thought (self-explanatory scene) — use the answer preview so
          // the segment card is never just "📝就绪".
          if (!s.saw && p.text_preview) s.saw = clip(p.text_preview, 140);
        } else if (t === "progress_report") {
          cur.report = String(p.report || "");
          cur.reportBatches = p.batches || 0;
        } else if (p.phase === "crop_images") {
          const s = segFor();
          s.crops = (p.crops || []).filter((c: CropItem) => c.jpeg_b64);
        } else if (p.phase === "done") {
          cur.done = true;
          cur.waiting = null;   // 整个深度研究结束 → 才真正撤掉攒帧条
        }
        // Note: writer_start / distill / tool_obs / rN_decision / start are
        // intentionally ignored — internal ReAct steps, not user-facing progress.

        const next = idx >= 0 ? prev.slice() : [...prev, cur];
        if (idx >= 0) next[idx] = cur;
        // Cap segments per item so a very long run doesn't grow unbounded.
        if (cur.segments.length > 40) cur.segments = cur.segments.slice(-40);
        return next.slice(-8);
      }
    };
    // 批量 flush: 把队列里累积的 bg 事件一次性 reduce 进 bgItems, 只触发 1 次重渲染。
    // 由统一节流器 runUnifiedFlush 调用 (跟主 agent 流同一帧), 不再单独排 timer/rAF。
    const runBgFlush = () => {
      if (bgQueue.length === 0 && bgPendingExpandRid === null) return;
      const n = bgQueue.length;
      const drain = bgQueue; bgQueue = [];
      if (n > 0) {
        _mmAct("bgFlush", `queued=${n}`);
        setBgItems((prev) => {
          const next = drain.reduce((acc, p) => reduceBg(acc, p), prev);
          try {
            const seg = next.reduce((mx: number, b: BgItem) => Math.max(mx, b.segments.length), 0);
            (window as any).__mmN = { ...(window as any).__mmN, bg: next.length, seg };
          } catch { /* noop */ }
          return next;
        });
      }
      // Auto-open the matching sub-window (deferred from raw bg handler).
      if (bgPendingExpandRid !== null) {
        const rid = bgPendingExpandRid;
        bgPendingExpandRid = null;
        setDeepExpanded((cur) => (cur === "" ? cur : rid));
      }
    };
    // Multimodal monitor registry push (set_monitor CRUD result).
    const offMonitors = gw.on<{
      monitors?: MonitorReg[];
    }>("multimodal.monitors", (ev) => {
      if (!isMine(ev)) return;
      setMonitors(ev.payload?.monitors || []);
    });
    // Multimodal watcher registry push (set_live_watcher CRUD + reopen re-register).
    const offWatchers = gw.on<{ watchers?: WatcherReg[] }>(
      "multimodal.watchers", (ev) => {
        if (!isMine(ev)) return;
        setWatchers(ev.payload?.watchers || []);
      });
    // Generic blocking clarify.request from a tool (e.g. set_monitor silent-
    // mode). The backend blocks the tool thread until we answer via
    // clarify.respond, so we MUST surface it — otherwise the tool hangs ~300s
    // and its tool.complete never fires. Render inline in the chat waterfall as
    // a question + option buttons (Claude-Code-desktop style). Dedup by
    // request_id so a re-emit doesn't stack duplicate bubbles.
    const offClarify = gw.on<{ request_id?: string; question?: string; choices?: string[] | null }>(
      "clarify.request", (ev) => {
        if (!isMine(ev)) return;
        const p = ev.payload || {};
        const reqId = p.request_id || "";
        if (!reqId) return;
        const choices = Array.isArray(p.choices)
          ? p.choices.filter((c): c is string => typeof c === "string") : [];
        setMessages((prev) => {
          if (prev.some((m) => m.kind === "clarify" && m.clarifyReqId === reqId)) return prev;
          return capMsgs([...prev, {
            id: nid(), role: "assistant", text: "", kind: "clarify",
            clarifyReqId: reqId,
            clarifyQuestion: p.question || "请选择",
            clarifyChoices: choices,
          }]);
        });
      });
    // Multimodal TTS chunk (legacy PCM streaming → WebAudio).
    const offTts = gw.on<{
      response_id?: string; pcm_b64?: string;
      sample_rate?: number; is_final?: boolean;
    }>("multimodal.tts", (ev) => onTtsChunk(ev.payload || {}));
    // Streaming realtime ASR: live partial preview + EOU buffer + final.
    const offAsrPartial = gw.on<{ text?: string }>(
      "multimodal.asr_partial", (ev) => { if (!isMine(ev)) return; setAsrPartial(ev.payload?.text || ""); });
    // EOU listening state: already-stitched segments (shown as dimmed prefix in AsrBar).
    const offAsrBuffer = gw.on<{ segments?: string[] }>(
      "multimodal.asr_buffer", (ev) => { if (!isMine(ev)) return; setAsrBuffer(ev.payload?.segments ?? []); });
    const offAsrFinal = gw.on<{ text?: string; request_id?: string }>(
      "multimodal.asr_final", (ev) => {
        if (!isMine(ev)) return;
        const t = (ev.payload?.text || "").trim();
        if (t) addMsg({
          id: nid(), role: "user", text: t, voice: true,
          requestId: ev.payload?.request_id,
        });
        setAsrPartial("");
        setAsrBuffer([]);
      });
    // Anchor debug: the exact frames injected into the vision model this turn.
    const offAnchor = gw.on<{ frames?: { ts: number | null; jpeg_b64: string }[] }>(
      "multimodal.anchor", (ev) => {
        if (!isMine(ev)) return;
        const frames = ev.payload?.frames || [];
        if (frames.length) setAnchorFrames(frames);
      });
    // ★ 后端发起的 user turn 回显 (watcher/monitor hook 完成 → 把 hook 指令作为正式
    //   UserMessage 注入主 agent)。普通用户输入由前端本地 addMsg, 不走这里; 只有
    //   后端注入的 (前端没本地加过) 才靠这个 echo 显示 user 气泡, 否则用户看不到
    //   触发这轮的那条指令。
    const offUserEcho = gw.on<{
      text?: string; request_id?: string;
      history_policy?: unknown; ephemeral_control?: unknown; ephemeral?: unknown;
    }>("message.user_echo", (ev) => {
      if (!isMine(ev)) return;
      if (isEphemeralControl(ev.payload)) return;
      const t = (ev.payload?.text || "").trim();
      if (t) addMsg({
        id: nid(), role: "user", text: t,
        requestId: ev.payload?.request_id,
      });
    });
    // LLM latency diagnostic: chat_completion_helpers pushes SEND/RECV/
    // FIRST_BYTE events with model / msg count / image count / image bytes /
    // prompt tokens / reasoning tokens / elapsed seconds. Dump to F12 so you
    // can see "why is this turn slow" without SSHing to the gateway box.
    const offDiag = gw.on<any>("multimodal.diag", (ev) => {
      const p = ev.payload || {};
      // Green for SEND, blue for RECV/FIRST_BYTE, red if slow (>10s).
      const slow = typeof p.elapsed_s === "number" && p.elapsed_s > 10;
      const color = p.phase === "SEND" ? "#28a745"
        : slow ? "#dc3545" : "#0d6efd";
      // eslint-disable-next-line no-console
      console.log("%c[mm-llm] " + (p.phase || "?"),
        `color:${color};font-weight:bold`, p);
      // Cross-reference: mark this LLM event on the per-turn trace so a
      // single glance at `[mm-trace-fe]` tells you where the LLM SEND
      // happened relative to prompt.submit and where FIRST_BYTE arrived.
      if (p.phase === "SEND") traceOnce(`llm_SEND (msgs=${p.msgs ?? "?"} imgs=${p.imgs ?? 0})`);
      else if (p.phase === "FIRST_BYTE") traceOnce("llm_FIRST_BYTE");
      else if (p.phase === "RECV") traceOnce(`llm_RECV (elapsed_s=${p.elapsed_s ?? "?"})`);
    });
    // Unified, bounded worker trajectory. This is intentionally one typed event
    // rather than the old onAny logger that copied every chat token and made the
    // page stutter. Backend entries already include Writer/OCR/Recall/Search/
    // Watcher/Monitor/MainScheduler phases and recalled frame thumbnails.
    const offTrajectory = gw.on<MmTrajectoryEntry>("multimodal.trajectory", (ev) => {
      if (!isMine(ev)) return;
      const item = ev.payload;
      if (!item?.id) return;
      const queryProgress = queryWorkerProgressFromTrajectory(item);
      if (queryProgress) {
        const current = queryProgressByTaskRef.current.get(queryProgress.taskId) || [];
        if (!current.some((step) => step.id === queryProgress.step.id)) {
          queryProgressByTaskRef.current = updateQueryWorkerProgressCache(
            queryProgressByTaskRef.current,
            queryProgress.taskId,
            queryProgress.step,
          );
          msgQueue.push({
            action: "patch_query_worker",
            taskId: queryProgress.taskId,
            step: queryProgress.step,
          });
          scheduleFlush();
        }
      }
      setTrajectory((prev) => {
        if (prev.some((x) => x.id === item.id)) return prev;
        const next = [...prev, item];
        return compactQueryWorkerTrajectory(
          next.length > 2000 ? next.slice(next.length - 2000) : next,
        );
      });
    });


    // ★ 拉注册表 (monitor/watcher): 有未完成任务 → 右侧面板自动打开。
    //   抽为独立函数, 供 resume 和 create 两条路径复用。
    const fetchRegistries = (sid: string) => {
      if (!sid) return;
      gw.request<{
        monitors?: MonitorReg[];
        watchers?: WatcherReg[];
        ready?: boolean;
      }>(
        "multimodal.list_registries", { session_id: sid },
      ).then((r) => {
        // ★ K: list_registries 用 _sess_nowait, 冷 resume 时 agent 还没 build 完 →
        //   ready=false/legacy 空 pull 不覆盖已到的 push。agent 就绪后 ready=true，
        //   空数组也是权威快照，可清掉断线期间已删除的最后一张旧卡。
        setMonitors((prev) => resolveRegistryPull(prev, r?.monitors, r?.ready));
        setWatchers((prev) => resolveRegistryPull(prev, r?.watchers, r?.ready));
      }).catch(() => { /* best-effort */ });
    };
    refs.current.fetchRegistries = fetchRegistries;

    // Hydrate the multimodal sidechannel state (monitor alerts + watcher
    // content) on session resume. The main-agent history no longer carries
    // these — they live in dedicated DB tables.
    const fetchMmSidechannel = (sid: string) => {
      if (!sid) return;
      gw.request<{ alerts?: { monitor_id: string; text: string; label?: string; wall_ts: number }[] }>(
        "multimodal.list_monitor_alerts", { session_id: sid },
      ).then((r) => {
        const list = Array.isArray(r?.alerts) ? r!.alerts! : [];
        if (list.length === 0) return;
        const grouped = new Map<string, MonitorAlert[]>();
        for (const a of list) {
          if (!a.monitor_id || !a.text) continue;
          const cur = grouped.get(a.monitor_id) || [];
          cur.push({
            id: `${a.monitor_id}_${a.wall_ts}_${cur.length}`,
            text: a.text,
            ts: Math.round((a.wall_ts || 0) * 1000),
          });
          grouped.set(a.monitor_id, cur);
        }
        setMonitorAlerts(grouped);
      }).catch(() => { /* best-effort */ });
      gw.request<{
        reports?: { watcher_id: string; round_idx: number; text: string; label?: string; wall_ts: number }[];
        finals?: { watcher_id: string; text: string; wall_ts: number }[];
      }>("multimodal.list_watcher_content", { session_id: sid }).then((r) => {
        const reports = Array.isArray(r?.reports) ? r!.reports! : [];
        const finals = Array.isArray(r?.finals) ? r!.finals! : [];
        if (reports.length === 0 && finals.length === 0) return;
        // Reconstruct one BgItem per watcher_id from persisted reports+finals.
        // Each report becomes a BgSegment (seg = round_idx, answer = text). The
        // final report (if any) attaches to the BgItem's finalReport. Segments
        // are ordered by round_idx asc so the newest sits at the bottom (same
        // as live streaming order).
        const byRid = new Map<string, BgItem>();
        for (const rp of reports) {
          if (!rp.watcher_id || !rp.text) continue;
          const cur = byRid.get(rp.watcher_id)
            || { id: rp.watcher_id, requestId: rp.watcher_id, segments: [], done: true };
          cur.segments.push({ seg: rp.round_idx || cur.segments.length + 1,
                              lookups: [], answer: rp.text });
          if (rp.label && !cur.label) cur.label = rp.label;
          byRid.set(rp.watcher_id, cur);
        }
        for (const f of finals) {
          if (!f.watcher_id || !f.text) continue;
          const cur = byRid.get(f.watcher_id)
            || { id: f.watcher_id, requestId: f.watcher_id, segments: [], done: true };
          cur.finalReport = f.text;
          byRid.set(f.watcher_id, cur);
        }
        if (byRid.size === 0) return;
        // Merge with any bgItems already populated by live events (rare on
        // fresh resume, but be defensive): live wins if same rid + live has
        // richer segments (crops/lookups); else replace with restored one.
        setBgItems((prev) => {
          const live = new Map(prev.map((b) => [b.requestId || b.id, b]));
          for (const [rid, restored] of byRid) {
            const cur = live.get(rid);
            if (!cur) { live.set(rid, restored); continue; }
            // If the live item has any segment with crops/lookups (streaming
            // detail), keep it; otherwise adopt the restored segments.
            const richLive = cur.segments.some((s) =>
              (s.crops && s.crops.length > 0) || (s.lookups && s.lookups.length > 0));
            if (!richLive) cur.segments = restored.segments;
            if (!cur.finalReport && restored.finalReport) cur.finalReport = restored.finalReport;
            if (!cur.label && restored.label) cur.label = restored.label;
            live.set(rid, cur);
          }
          return Array.from(live.values()).slice(-8);
        });
      }).catch(() => { /* best-effort */ });
    };

    const fetchTrajectory = (sid: string) => {
      if (!sid) return;
      const generation = ++trajectoryHydrationGenerationRef.current;
      gw.request<{ entries?: MmTrajectoryEntry[] }>(
        "multimodal.trajectory.list", { session_id: sid, limit: 2000 },
      ).then((res) => {
        if (!isCurrentTrajectoryHydration(
          sid,
          generation,
          refs.current.sessionId,
          trajectoryHydrationGenerationRef.current,
        )) return;
        const pulled = Array.isArray(res?.entries) ? res.entries : [];
        for (const item of pulled) {
          const qp = queryWorkerProgressFromTrajectory(item);
          if (!qp) continue;
          const current = queryProgressByTaskRef.current.get(qp.taskId) || [];
          if (current.some((step) => step.id === qp.step.id)) continue;
          queryProgressByTaskRef.current = updateQueryWorkerProgressCache(
            queryProgressByTaskRef.current,
            qp.taskId,
            qp.step,
          );
          msgQueue.push({ action: "patch_query_worker", taskId: qp.taskId, step: qp.step });
        }
        if (msgQueue.length) scheduleFlush();
        setTrajectory((live) => {
          const merged = new Map<string, MmTrajectoryEntry>();
          for (const it of [...pulled, ...live]) if (it?.id) merged.set(it.id, it);
          return compactQueryWorkerTrajectory(Array.from(merged.values())
            .sort((a, b) => (a.seq || 0) - (b.seq || 0))
            .slice(-2000));
        });
      }).catch(() => { /* best-effort */ });
    };

    // ★ resume 一个指定 session 并把历史灌进 waterfall。返回是否成功。
    //   restoreHistory=true 时把后端返回的 transcript 转成气泡显示 (只在 waterfall
    //   还是初始态时灌, 避免覆盖用户已输入 / 重复灌)。
    const resumeSessionById = async (
      targetSid: string, restoreHistory: boolean,
    ): Promise<boolean> => {
      if (!targetSid) return false;
      try {
        const res = await gw.request<{
          session_id?: string; session_key?: string; resumed?: string;
          messages?: unknown; orphan_event_ids?: string[];
        }>("session.resume", {
          session_id: targetSid,
          // A persisted session can predate the dedicated source value. The
          // multimodal page is authoritative about the runtime it needs when
          // reopening it.
          source: "multimodal",
          close_on_disconnect: false,
        });
        // ★ 两个 id: session_id=live runtime key (RPC 路由用); session_key/resumed=
        //   持久 DB id (跨 auto-compress 稳定, ?mm=/侧边栏/localStorage 用)。之前错把
        //   live sid 存进 localStorage → 下次 resume 必 404。
        const liveSid = res?.session_id || targetSid;
        const storedSid = res?.session_key || res?.resumed || targetSid;
        refs.current.sessionId = liveSid;
        refs.current.storedSid = storedSid;
        try { localStorage.setItem(_MM_SESSION_KEY, storedSid); } catch { /* noop */ }
        if (restoreHistory) {
          // ★ F: 孤儿 monitor/watcher (history 有、本 session 磁盘无) → 丢弃气泡 + 提示。
          const orphans = new Set(
            Array.isArray(res?.orphan_event_ids) ? res!.orphan_event_ids : []);
          const restored = historyToMmMessages(res?.messages, orphans);
          if (restored.length > 0) {
            // ★ 窗口化: 全量历史存 ref (含头部), 只渲染尾部 MAX_MESSAGES 条; 头部留给
            //   "翻到顶再取"(loadOlderHistory)。补 createdAt (capMsgs 会截头, 这里要全量)。
            const now = Date.now();
            for (const m of restored) if (m.createdAt == null) m.createdAt = now;
            fullHistoryRef.current = restored;
            const start = Math.max(0, restored.length - MAX_MESSAGES);
            // ★ 置顶欢迎气泡 (纯前端引导, 不入 backend history)。老 session 刷新走这里
            //   恢复历史, 若不主动 prepend 会被 restored 冲掉。
            setMessages([_mmWelcomeMsg(), ...restored.slice(start)]);
            setHasMoreHistory(start > 0);
          } else {
            // 空 history 也要留一条欢迎气泡 (与 resetSessionUi 一致)。
            setMessages([_mmWelcomeMsg()]);
          }
          if (orphans.size > 0) {
            pushTopToast(
              `error msg: monitor / watcher event id ${Array.from(orphans).join(", ")} not found in local files.`,
              "error");
          }
        }
        fetchRegistries(liveSid);
        fetchMmSidechannel(liveSid);
        fetchTrajectory(liveSid);
        return true;
      } catch {
        return false;
      }
    };

    // ★ 新建一个持久化 session (close_on_disconnect: false → WS 断开不销毁;
    //   source: "multimodal" → 区分 TUI("tui")/子 agent("tool"), session.list 可见)。
    //   返回新会话的持久 id (供"新建"路径把 URL ?mm= 换成它)。
    const createSession = async (): Promise<string> => {
      try {
        const res = await gw.request<{ session_id: string; stored_session_id?: string }>(
          "session.create", { close_on_disconnect: false, source: "multimodal" },
        );
        const liveSid = res?.session_id || "";
        const storedSid = res?.stored_session_id || liveSid;
        refs.current.sessionId = liveSid;
        refs.current.storedSid = storedSid;
        if (storedSid) {
          try { localStorage.setItem(_MM_SESSION_KEY, storedSid); } catch { /* noop */ }
        }
        // 新会话是空的: 清掉上一会话残留的 UI 状态 + 灌入初始欢迎气泡。
        resetSessionUi();
        fetchRegistries(liveSid);
        fetchMmSidechannel(liveSid);
        fetchTrajectory(liveSid);
        return storedSid;
      } catch (e) {
        addMsg({ id: nid(), role: "system",
          text: `会话建立失败: ${e instanceof Error ? e.message : String(e)}` });
        return "";
      }
    };
    // Expose create so the ?mm=new (新建) handler can call it.
    refs.current.createSession = createSession;

    // ★ 建会话的决策链 (首次连接 / 重连时都走它):
    //   0) URL ?mm=new (侧边栏加号) → 强制新建一个空会话
    //   1) URL ?mm=<id> 指定 → resume 它 (侧边栏点选)
    //   2) localStorage 上次打开的 → resume 它 (刷新保持)
    //   3) 都没有 → 拉最近会话列表, resume 最上面那条 (默认打开最新)
    //   4) 一条都没有 → 新建
    const establishSession = async () => {
      try {
        const urlSid = new URLSearchParams(window.location.search).get("mm");
        if (urlSid === "new") {
          const newSid = await createSession();
          if (newSid) setSearchParams({ mm: newSid }, { replace: true });
          return;
        }
        if (urlSid && await resumeSessionById(urlSid, true)) return;

        let savedSid: string | null = null;
        try { savedSid = localStorage.getItem(_MM_SESSION_KEY); } catch { /* noop */ }
        if (savedSid && await resumeSessionById(savedSid, true)) return;
        // resume 失败 → 清掉过期 id
        if (savedSid) { try { localStorage.removeItem(_MM_SESSION_KEY); } catch { /* noop */ } }

        // 默认打开最近一条会话 (session list 最上面)。exclude tool/cron 子会话,
        // 否则可能 resume 到子 agent/cron 会话当主对话。
        try {
          const list = await api.getSessions(1, 0, scopedProfile ?? "", "recent", "tool,cron");
          const top = list?.sessions?.[0]?.id;
          if (top && await resumeSessionById(top, true)) return;
        } catch { /* best-effort → 落到 create */ }

        await createSession();
      } finally {
        sessionEstablishedRef.current = true;
      }
    };
    // Expose the resume core so the ?mm= watcher effect can switch sessions.
    refs.current.resumeSessionById = resumeSessionById;

    // ★ Connection state drives the UI + capture. Without this the badge was set
    //   true once and never cleared — a dropped WS looked "connected" forever
    //   while frames were black-holed. Now: badge follows real state, capture
    //   pauses off-line, and an auto-reconnect rebuilds the session.
    const offGwState = gw.onState((s) => {
      setConnected(s === "open");
      setConnState(s);
      if (s !== "open") {
        sessionEstablishedRef.current = false;
        // Pause frame capture while disconnected — pushing into a dead socket
        // just burns CPU/encoding for frames that go nowhere.
        try { stopCapture(); } catch { /* noop */ }
        // ★ E: WS 断了, 正在流式的那轮不会再收到 message.complete/error → streaming
        //   标志永远清不掉, composer 卡在"停止"。这里主动清所有 streaming + 打开的
        //   bubble 映射, 让 composer 回到"发送"。
        curAssistantId.current.clear();
        setMessages((prev) => {
          if (!prev.some((m) => m.streaming)) return prev;
          return prev.map((m) => (m.streaming
            ? { ...m, streaming: false, queued: false, queuePosition: undefined }
            : m));
        });
        // ★ J: 断线时后端 ASR 会话被回收, 但前端仍以为在录音 (红点常亮, PCM 打到死
        //   socket)。这里同步拆本地 mic (inline, 因 stopMic 定义在此 effect 之后)。
        const r = refs.current;
        if (r.isRecording) {
          r.isRecording = false;
          setMicState("idle");
          try { if (r.micNode) { r.micNode.port.onmessage = null; r.micNode.port.close(); r.micNode.disconnect(); } } catch { /* noop */ }
          try { r.micSource?.disconnect(); } catch { /* noop */ }
          try { void r.micAudioCtx?.close(); } catch { /* noop */ }
          try { r.micStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
          r.micNode = null; r.micSource = null; r.micAudioCtx = null; r.micStream = null;
          setAsrPartial("");
        setAsrBuffer([]);
        }
      }
    });
    const offReconnect = gw.onReconnect(() => {
      // WS came back — session 还在 (close_on_disconnect: false), establishSession
      // 先 try resume 再 fallback create。
      void establishSession().then(() => {
        if (refs.current.stream) { try { startCapture(); } catch { /* noop */ } }
      });
    });

    gw.connect()
      .then(() => establishSession())
      .then(() => {
        // Reuse this connection to fetch the multimodal readiness advisory once
        // (no separate WS). probe_endpoints=true opts in to a bounded TCP probe
        // of each configured LLM endpoint so the banner can warn "endpoint
        // unreachable — requests will hang" instead of the user hitting the
        // mysterious "agent initialization timed out" wall.
        gw.request<MmReadinessReport>("mm.readiness", { probe_endpoints: true })
          .then((r) => { if (r && typeof r.ready === "boolean") setMmReadiness(r); })
          .catch(() => { /* advisory is best-effort */ });
      })
      .catch((e: Error) => addMsg({ id: nid(), role: "system", text: `连接失败: ${e.message}` }));

    return () => {
      flushDisposed = true;
      clearInterval(_watchdog);
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (flushRaf !== null) cancelAnimationFrame(flushRaf);
      if (ctxRaf !== null) cancelAnimationFrame(ctxRaf);
      msgQueue = [];
      bgPendingExpandRid = null;
      offGwState();
      offReconnect();
      offStart();
      offDelta();
      offComplete();
      offCtx();
      offToolStart();
      offToolComplete();
      offWatcherFinal();
      offReportAppend();
      offDeepComplete();
      offStatus();
      offReasoning();
      offThinking();
      offReasoningSummary();
      offError();
      offSessionInfo();
      offToast();
      offBg();
      offMonitors();
      offWatchers();
      offClarify();
      offTts();
      offAsrPartial();
      offAsrBuffer();
      offAsrFinal();
      offAnchor();
      offUserEcho();
      offDiag();
      offTrajectory();
      stopAllTts(true);
      // Close the AudioContext (browsers cap ~6 per page; leaking one per
      // mount eventually throws on new AudioContext()).
      try {
        const ac = ttsRefs.current.audioCtx;
        if (ac && ac.state !== "closed") ac.close();
      } catch { /* noop */ }
      ttsRefs.current.audioCtx = null;
      // Stop the streaming mic (not covered by stopStream, which only tears
      // down the video + env-audio path).
      try {
        const rr = refs.current;
        if (rr.micNode) {
          try { rr.micNode.port.onmessage = null; } catch { /* noop */ }
          try { rr.micNode.port.close(); } catch { /* noop */ }
          try { rr.micNode.disconnect(); } catch { /* noop */ }
        }
        if (rr.micSource) rr.micSource.disconnect();
        if (rr.micAudioCtx && rr.micAudioCtx.state !== "closed") void rr.micAudioCtx.close();
      } catch { /* noop */ }
      if (refs.current.micStream) {
        refs.current.micStream.getTracks().forEach((t) => t.stop());
        refs.current.micStream = null;
      }
      refs.current.micNode = null;
      refs.current.micSource = null;
      refs.current.micAudioCtx = null;
      // Clear the per-key bubble map so it can't leak across a remount.
      curAssistantId.current.clear();
      refs.current.isAnswering = false;
      stopStream();
      gw.close();
      refs.current.gw = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ?mm= 切换: 用户在侧边栏点了另一条 session → resume 它 + 恢复历史 ──────────
  //   与上面的 mount-once 建会话逻辑分开: mount 时那次已按初始 ?mm= 处理, 这里只
  //   处理【挂载后】param 的变化。切换前清空 waterfall (旧会话气泡不能串到新会话),
  //   由 resumeSessionById(restoreHistory=true) 灌入新会话的 transcript。
  useEffect(() => {
    if (!mmParam) return;
    if (!connected || !sessionEstablishedRef.current) return;
    const resume = refs.current.resumeSessionById;
    if (!resume) return;                       // 会话地基还没建好, mount 那次会处理
    // ★ 新建 (?mm=new, 侧边栏加号): 强制建一个空会话, 再把 URL 换成新会话 id
    //   (replace, 不留 new 在历史)。切换前先关流 + 清 UI。
    if (mmParam === "new") {
      sessionEstablishedRef.current = false;
      if (refs.current.stream) { try { stopStream(); } catch { /* noop */ } }
      // 切换会话必须【同步】清空上一会话 UI (气泡/深研窗/面板), 否则旧内容会串到新
      // 会话——这是有意的同步 reset, 不是 cascading-render bug。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      resetSessionUi();
      void refs.current.createSession?.().then((newSid) => {
        if (newSid) setSearchParams({ mm: newSid }, { replace: true });
      }).finally(() => {
        sessionEstablishedRef.current = true;
      });
      return;
    }
    // ★ 守卫比【持久 id】(storedSid), 不是 live sid —— mmParam 是持久 id, live sid
    //   会因 auto-compress 变化, 用它比永不相等 (死守卫)。
    if (mmParam === refs.current.storedSid) return;  // 已经是当前会话, 免重复
    // ★ G2: 切换 session 前先关掉视频流 —— 采集属于【旧会话】, 不能带进新会话。
    //   stopStream() 会给旧 session 发 source_stopped{started:false} (让旧会话的
    //   monitor/watcher 停止等帧) + 停本地采集。新会话默认无流, 用户按需重开;
    //   因此不需要给新会话补 started:true 握手 (本来就没流)。
    if (refs.current.stream) { try { stopStream(); } catch { /* noop */ } }
    // 切换前清空上一会话的【全部】UI 状态 (气泡/深研窗/注入帧/观察/监控/toast/帧数),
    // 再由 resumeSessionById(restoreHistory=true) 灌入新会话的 transcript + registries。
    resetSessionUi();
    void resume(mmParam, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mmParam, connected]);

  // ── Frame capture ──────────────────────────────────────────────────────
  // Reuse ONE offscreen canvas across ticks. The old code did
  // document.createElement("canvas") every 500ms — cheap allocation but
  // 2 fps × long session = thousands of throwaway canvases + GC pressure.
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // ASYNC frame capture. The old sync path called canvas.toDataURL() which
  // BLOCKS the main thread for 20-60 ms per 720p JPEG encode — every 500 ms
  // at 2 fps that's 5-15% of every second frozen. Symptom: user sends a
  // query while screen-sharing, WS delta events arrive on time but React
  // never repaints because setState-triggered rAFs sit behind the next
  // toDataURL. Chrome/Edge exposes canvas.convertToBlob() which offloads
  // the encode to a compositor thread; combined with FileReader (also
  // async) the whole capture stays off the main thread. Fallback to
  // toDataURL only on ancient browsers where convertToBlob is missing.
  const captureFrame = useCallback(async (): Promise<string | null> => {
    const r = refs.current;
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    let w = v.videoWidth, h = v.videoHeight;
    const isScreen = r.sourceType === "screen";
    const profile = visualCaptureProfile(
      isScreen ? "screen" : "camera",
      preferLightCapture(),
    );
    const maxSide = profile.maxSide;
    if (maxSide > 0 && Math.max(w, h) > maxSide) {
      const scale = maxSide / Math.max(w, h);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    let cvs = captureCanvasRef.current;
    if (!cvs) {
      cvs = document.createElement("canvas");
      captureCanvasRef.current = cvs;
    }
    if (cvs.width !== w) cvs.width = w;
    if (cvs.height !== h) cvs.height = h;
    await blitVideoToCanvas(v, cvs, w, h, profile.resizeQuality);
    const quality = profile.jpegQuality;

    // Async path: convertToBlob offloads JPEG encode off the main thread.
    // Available in Chrome 66+/Edge 79+/Firefox 105+ — safe for a dashboard.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cAny = cvs as any;
    if (typeof cAny.convertToBlob === "function"
        || typeof (cvs as HTMLCanvasElement).toBlob === "function") {
      const blob = await new Promise<Blob | null>((resolve) => {
        if (typeof cAny.convertToBlob === "function") {
          cAny.convertToBlob({ type: "image/jpeg", quality })
            .then(resolve, () => resolve(null));
        } else {
          (cvs as HTMLCanvasElement).toBlob(resolve, "image/jpeg", quality);
        }
      });
      if (!blob) return null;
      // FileReader.readAsDataURL is async & runs the base64 encode off-thread.
      // Slice off the "data:image/jpeg;base64," prefix — the gateway wants
      // the raw base64 body (it strips data: prefixes but the extra bytes
      // are pure waste on a WS notify at 2 fps).
      const dataUrl = await new Promise<string | null>((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
      if (!dataUrl) return null;
      const i = dataUrl.indexOf(",");
      return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    }
    // Legacy sync fallback.
    return cvs.toDataURL("image/jpeg", quality).split(",")[1] || null;
  }, []);

  const startCapture = useCallback(() => {
    const r = refs.current;
    const period = Math.max(50, Math.round(1000 / r.capFps));
    if (r.capTimer) clearInterval(r.capTimer);
    // Backpressure: if the WS send buffer has more than this many bytes
    // waiting to hit the wire, skip this tick. Screen frames are ~200 KB
    // base64 apiece; anything above ~2 frames pending means we're already
    // saturating the WS and chat SSE would queue behind us. 512 KB gives
    // one frame of headroom without letting the buffer balloon.
    const BUF_LIMIT = 512 * 1024;
    // Reentrancy guard: if a capture is still in flight when the next tick
    // fires (slow encode / disk-IO stall), skip rather than pile up
    // parallel encodes on the compositor. Without this a 2 fps interval
    // could balloon into 5-10 concurrent encodes under load.
    let inFlight = false;
    r.capTimer = window.setInterval(() => {
      const gw = r.gw;
      if (!gw || !r.sessionId) return;
      if (inFlight) return;
      // ★ Capture NEVER pauses — not even while the agent is answering. Pausing
      //   on isAnswering dropped a run of frames every time the agent spoke,
      //   leaving holes in the video the monitor / deep-analysis rely on, and
      //   staling _last_push_wall (which wrongly read as "source stopped"). The
      //   starvation this once guarded against is already handled: the inFlight
      //   reentrancy guard, off-thread JPEG encode (convertToBlob/FileReader),
      //   the setTimeout(0) yield below, and bufferedAmount backpressure — so at
      //   2fps the per-tick cost is negligible and must not cost us frames.
      inFlight = true;
      void (async () => {
        try {
      const data = await captureFrame();
      if (!data) return;
      const ts = (performance.now() - r.startTs) / 1000;
      // Yield so stream flushes + UI events run before JSON.stringify blocks.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      // Fire-and-forget notify (no ACK): the frame is best-effort, we
      // don't need a per-frame roundtrip and blocking on ACK meant every
      // qwen SSE token had to queue behind the frame reply on the single
      // shared WS. `notify` returns the post-send bufferedAmount so we
      // can drop the NEXT tick if the pipe is backed up.
      const buffered = gw.notify(
        "multimodal.frame",
        { session_id: r.sessionId, ts, jpeg_b64: data, source_type: r.sourceType },
      );
      if (buffered < 0) return; // socket not open
      if (buffered > BUF_LIMIT) {
        r.droppedFrames = (r.droppedFrames || 0) + 1;
        return;
      }
      r.sentFrames++;
      // Throttle the frame-count state push to ~1/s. It only feeds a display
      // number in the local video overlay; pushing every frame (2 fps) forces a
      // MultimodalChatPage re-render each tick for no visible benefit. The final
      // count is flushed by stopCapture.
      {
        const _now = performance.now();
        if (_now - (r._lastCountPush || 0) >= 1000) {
          r._lastCountPush = _now;
          setFrameCount(r.sentFrames);
        }
      }
        } finally {
          inFlight = false;
        }
      })();
    }, period);
  }, [captureFrame]);

  const stopCapture = useCallback(() => {
    const r = refs.current;
    if (r.capTimer) { clearInterval(r.capTimer); r.capTimer = null; }
    // Flush the final count (throttled pushes may have skipped the last frames).
    r._lastCountPush = 0;
    setFrameCount(r.sentFrames);
  }, []);

  const attachStream = useCallback(async (stream: MediaStream, st: SourceType) => {
    const r = refs.current;
    r.stream = stream; r.sourceType = st;
    setSourceType(st);
    const v = videoRef.current;
    if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
    r.startTs = performance.now();
    startCapture();
    // Tell the backend a video source is LIVE, so a continuous deep-analysis
    // run knows to keep waiting for frames (vs one-shot when no source).
    if (r.gw && r.sessionId) {
      r.gw.request("multimodal.source_stopped", {
        session_id: r.sessionId, started: true, source_type: st,
      }).catch(() => { /* best-effort */ });
    }
  }, [startCapture]);

  const stopStream = useCallback(() => {
    const r = refs.current;
    stopCapture();
    // Inline env-audio teardown (avoid const-ordering coupling with stopEnvAudio).
    r.envStop = true;
    if (r.envSliceTimer != null) {
      clearTimeout(r.envSliceTimer);
      r.envSliceTimer = null;
    }
    if (r.envRecorder) {
      try { if (r.envRecorder.state === "recording") r.envRecorder.stop(); } catch { /* noop */ }
      r.envRecorder = null;
    }
    if (r.envStream) { r.envStream.getTracks().forEach((t) => t.stop()); r.envStream = null; }
    r.envCaptureId = "";
    r.envChunkSeq = 0;
    r.envLastError = "";
    if (r.stream) r.stream.getTracks().forEach((t) => t.stop());
    r.stream = null; r.sourceType = null;
    setSourceType(null);
    if (videoRef.current) videoRef.current.srcObject = null;
    // Tell the backend the video source CLOSED, so any continuous deep-analysis
    // run stops waiting for new frames and finishes after draining the buffer.
    if (r.gw && r.sessionId) {
      r.gw.request("multimodal.source_stopped", {
        session_id: r.sessionId, started: false,
      }).catch(() => { /* best-effort */ });
    }
  }, [stopCapture]);

  const startCamera = useCallback(async () => {
    if (refs.current.stream) return;
    try {
      const profile = visualCaptureProfile("camera", preferLightCapture());
      // ★ frameRate ideal:24 → smooth local preview. The vision pipeline still
      //   only SAMPLES the buffer at capFps (~2fps); the higher source rate only
      //   affects the on-screen <video> mirror's smoothness, not the push rate.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: profile.width, max: profile.width },
          height: { ideal: profile.height, max: profile.height },
          frameRate: { ideal: profile.sourceFrameRate },
          facingMode: "user",
        },
        audio: false,
      });
      await attachStream(stream, "camera");
    } catch (e: any) {
      addMsg({ id: nid(), role: "system", text: `摄像头启动失败: ${e?.message}` });
    }
  }, [attachStream, addMsg]);

  // ── Mic: streaming realtime ASR (DashScope). Mic PCM → multimodal.asr_audio;
  //    server-side VAD segments speech → asr_partial (live preview) + asr_final
  //    (submitted as a user turn on the backend).
  //
  //    Downsampling runs in an AudioWorklet (dedicated audio thread) so main-
  //    thread stays free for UI; the worklet batches ~200ms of PCM before
  //    posting to us, cutting RPC rate ~2.5x vs the old 85ms cadence. Server-
  //    side VAD (silence_ms=1200) doesn't care about packet cadence.
  // ────────────────────────────────────────────────────────────────────────
  const startMic = useCallback(async () => {
    const r = refs.current;
    if (r.isRecording) return;
    if (!r.gw || !r.sessionId) return;
    // Immediate feedback: enter "connecting" (spinner, NOT red) so the user
    // knows the click registered while the ASR WebSocket opens. The button
    // only turns red after the whole chain (asr_start + mic + worklet) succeeds.
    setMicState("connecting");
    try {
      // Open the streaming session first; bail if the backend has no key.
      const res: any = await r.gw.request("multimodal.asr_start", {
        session_id: r.sessionId,
      });
      if (!res?.enabled) {
        addMsg({ id: nid(), role: "system",
          text: "流式语音未启用(需在配置里填 dashscope_api_key)。" });
        setMicState("idle");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        // Full software 3A incl. auto-gain (AGC levels your voice above the
        // background). Browser ceiling: suppresses steady noise but can't
        // beam-form / target-speaker like a phone, so nearby speech still leaks.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      r.micStream = stream;
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      r.micAudioCtx = ctx;
      // Worklet lives at /pcm-worklet.js served from public/. Prefix with the
      // deployed base path so it resolves correctly under a non-root mount.
      await ctx.audioWorklet.addModule(`${HERMES_BASE_PATH}/pcm-worklet.js`);
      const source = ctx.createMediaStreamSource(stream);
      r.micSource = source;
      const node = new AudioWorkletNode(ctx, "pcm-downsample-processor", {
        numberOfInputs: 1, numberOfOutputs: 1,
        processorOptions: { inRate: ctx.sampleRate, batchMs: 200 },
      });
      r.micNode = node;
      // Worklet posts Int16 ArrayBuffer batches. Main thread only base64-
      // encodes + fires one RPC per batch — no per-sample math here.
      node.port.onmessage = (ev: MessageEvent) => {
        const rr = refs.current;
        if (!rr.isRecording || !rr.gw || !rr.sessionId) return;
        // Barge-in guard: while the assistant's TTS is audible (+ tail), drop the
        // mic PCM so speaker output isn't re-captured and looped back into ASR.
        if (Date.now() < ttsRefs.current.ttsMuteUntil) return;
        const buf = ev.data as ArrayBuffer;
        if (!buf || !buf.byteLength) return;
        // Encode ArrayBuffer → base64 without going through a string first
        // (fromCharCode.apply blows the stack on large buffers).
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const pcm_b64 = btoa(bin);
        rr.gw.request("multimodal.asr_audio", {
          session_id: rr.sessionId, pcm_b64,
        }).catch(() => {});
      };
      source.connect(node);
      node.connect(ctx.destination);
      r.isRecording = true;
      // Fully connected → NOW turn the button red.
      setMicState("recording");
    } catch (e: any) {
      addMsg({ id: nid(), role: "system", text: `麦克风启动失败: ${e?.message}` });
      setMicState("idle");
      try { await r.gw?.request("multimodal.asr_stop", { session_id: r.sessionId }); } catch { /* noop */ }
    }
  }, [addMsg]);

  const stopMic = useCallback(async () => {
    const r = refs.current;
    if (!r.isRecording) return;
    r.isRecording = false;
    // De-active the button IMMEDIATELY (before the async teardown / asr_stop),
    // so it visibly goes inactive the instant the user clicks stop.
    setMicState("idle");
    try {
      if (r.micNode) {
        try { r.micNode.port.onmessage = null; } catch { /* noop */ }
        try { r.micNode.port.close(); } catch { /* noop */ }
        try { r.micNode.disconnect(); } catch { /* noop */ }
      }
      if (r.micSource) { try { r.micSource.disconnect(); } catch { /* noop */ } }
      if (r.micAudioCtx) { try { await r.micAudioCtx.close(); } catch { /* noop */ } }
      if (r.micStream) r.micStream.getTracks().forEach((t) => t.stop());
    } finally {
      r.micNode = null; r.micSource = null; r.micAudioCtx = null; r.micStream = null;
    }
    if (r.gw && r.sessionId) {
      r.gw.request("multimodal.asr_stop", { session_id: r.sessionId }).catch(() => {});
    }
    setAsrPartial("");
        setAsrBuffer([]);
    // ★ 麦关 → 强制关对话模式: 对话模式必须有活麦, 否则相当于哑火。用 functional
    //   setter 拿到最新值判断, 避免闭包旧值; 只在真的处于开态时下发后端 toggle
    //   RPC, 不做多余的服务端调用。
    setVoiceDialogEnabled((prev) => {
      if (!prev) return prev;
      try {
        r.gw?.request("multimodal.voice_dialog_toggle",
          { session_id: r.sessionId, enabled: false }).catch(() => {});
      } catch { /* noop */ }
      return false;
    });
  }, []);

  // ── Env audio: screen/people speaking → multimodal.env_audio → memory ────
  const startEnvRecorder = useCallback(() => {
    const recordChunk = () => {
      const r = refs.current;
      const envStream = r.envStream;
      if (r.envStop || !envStream || !envStream.getAudioTracks().some((t) => t.readyState === "live")) return;

      const requestedMime = r.envMime || "audio/webm";
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(envStream, { mimeType: requestedMime });
      } catch {
        try {
          rec = new MediaRecorder(envStream);
        } catch (e) {
          const key = `recorder:${e instanceof Error ? e.message : String(e)}`;
          if (r.envLastError !== key) {
            r.envLastError = key;
            pushTopToast(`共享音频录制失败: ${e instanceof Error ? e.message : String(e)}`, "error");
          }
          return;
        }
      }

      const chunkSeq = ++r.envChunkSeq;
      const captureId = r.envCaptureId;
      const chunkId = `${captureId}:${chunkSeq}`;
      const chunkStartedAt = performance.now();
      const timelineOrigin = r.startTs;
      const gw = r.gw;
      const sessionId = r.sessionId;
      const parts: Blob[] = [];
      let blobTimecode = 0;
      let chunkStoppedAt: number | null = null;
      r.envRecorder = rec;

      rec.ondataavailable = (ev: BlobEvent) => {
        if (ev.data.size > 0) parts.push(ev.data);
        if (Number.isFinite(ev.timecode)) blobTimecode = ev.timecode;
      };
      rec.onstop = () => {
        const rr = refs.current;
        if (rr.envRecorder === rec) rr.envRecorder = null;
        const chunkEndedAt = chunkStoppedAt ?? performance.now();
        const payloadMime = parts[0]?.type || rec.mimeType || requestedMime;
        const blob = parts.length === 1 ? parts[0] : new Blob(parts, { type: payloadMime });
        if (!blob || blob.size < 1000 || !gw || !sessionId) return;

        const clientStartTs = Math.max(0, (chunkStartedAt - timelineOrigin) / 1000);
        const clientEndTs = Math.max(clientStartTs, (chunkEndedAt - timelineOrigin) / 1000);
        const clientDurationSec = Math.max(0, (chunkEndedAt - chunkStartedAt) / 1000);
        void blobToBase64(blob).then((b64) => {
          console.debug("[mm-env-asr-fe] sending complete audio chunk", {
            capture_id: captureId, chunk_id: chunkId, chunk_seq: chunkSeq,
            bytes: blob.size, mime: payloadMime,
            client_start_ts: clientStartTs, client_end_ts: clientEndTs,
            client_duration_sec: clientDurationSec, blob_timecode: blobTimecode,
          });
          return gw.request<{ ingested?: boolean; reason?: string }>("multimodal.env_audio", {
            session_id: sessionId, data_b64: b64, mime: payloadMime,
            // Compatibility field: this is the beginning of the audio window,
            // not the time at which its upload happened.
            window_ts: clientStartTs,
            capture_id: captureId,
            chunk_id: chunkId,
            chunk_seq: chunkSeq,
            client_start_ts: clientStartTs,
            client_end_ts: clientEndTs,
            client_duration_sec: clientDurationSec,
            blob_timecode: blobTimecode,
          });
        }).then((res) => {
          if (res?.ingested !== false) {
            refs.current.envLastError = "";
            return;
          }
          const reason = res.reason || "unknown";
          if (reason === "too_short") return;
          const latest = refs.current;
          if (latest.envLastError !== reason) {
            latest.envLastError = reason;
            pushTopToast(`共享音频 ASR 未接收: ${reason}`, "error");
          }
        }).catch((e) => {
          const reason = e instanceof Error ? e.message : String(e);
          const latest = refs.current;
          if (latest.envLastError !== reason) {
            latest.envLastError = reason;
            pushTopToast(`共享音频 ASR 请求失败: ${reason}`, "error");
          }
        });
      };

      try {
        // A MediaRecorder timeslice is a continuation fragment on some browsers
        // (only the first fragment has a WebM/MP4 header), so it is not safe to
        // decode every dataavailable Blob as a standalone ASR file. Stop this
        // recorder and start a fresh one per window: every upload is then a
        // complete, independently decodable media container.
        rec.start();
        const timer = window.setTimeout(() => {
          const latest = refs.current;
          if (latest.envSliceTimer !== timer) return;
          latest.envSliceTimer = null;
          if (latest.envRecorder !== rec || rec.state === "inactive") return;

          chunkStoppedAt = performance.now();
          const shouldRestart = !latest.envStop
            && latest.envStream === envStream
            && envStream.getAudioTracks().some((t) => t.readyState === "live");
          try {
            rec.stop();
          } catch (e) {
            const key = `stop:${e instanceof Error ? e.message : String(e)}`;
            if (latest.envLastError !== key) {
              latest.envLastError = key;
              pushTopToast(`共享音频切片失败: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
            return;
          }
          if (latest.envRecorder === rec) latest.envRecorder = null;
          if (shouldRestart) recordChunk();
        }, Math.max(1000, Math.round(r.envWindowSec * 1000)));
        r.envSliceTimer = timer;
      } catch (e) {
        if (r.envRecorder === rec) r.envRecorder = null;
        const key = `start:${e instanceof Error ? e.message : String(e)}`;
        if (r.envLastError !== key) {
          r.envLastError = key;
          pushTopToast(`共享音频录制启动失败: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
      }
    };

    recordChunk();
  }, [pushTopToast]);

  const startEnvAudio = useCallback((stream: MediaStream) => {
    const r = refs.current;
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) return;
    // Defensive restart cleanup: normally this runs once per screen share, but
    // a repeated start must not orphan the previous recorder/timer.
    r.envStop = true;
    if (r.envSliceTimer != null) {
      clearTimeout(r.envSliceTimer);
      r.envSliceTimer = null;
    }
    if (r.envRecorder) {
      try { if (r.envRecorder.state === "recording") r.envRecorder.stop(); } catch { /* noop */ }
      r.envRecorder = null;
    }
    r.envStream = new MediaStream(tracks);
    r.envMime = pickMicMime() || "audio/webm";
    r.envStop = false;
    r.envCaptureId = `cap_${nid()}`;
    r.envChunkSeq = 0;
    r.envLastError = "";
    startEnvRecorder();
  }, [startEnvRecorder]);

  // ── Ask ─────────────────────────────────────────────────────────────────
  // Text is passed in from <ChatComposer> (which owns the input state) rather
  // than read from a parent-level `askText` state — so keystrokes only
  // re-render the composer leaf, never the whole page / message list.
  const startScreen = useCallback(async () => {
    if (refs.current.stream) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      addMsg({ id: nid(), role: "system", text: "浏览器不支持屏幕共享" });
      return;
    }
    try {
      // ★ frameRate ideal:4 — 后端只 2fps 采样，MediaStream 开得越高 OS 合成器
      //   就要以那个频率刷新捕获管道，直接和鼠标渲染/UI 合成抢 GPU 资源 → 鼠标卡。
      //   4fps 给 2fps 采样留足余量，OS 开销降到 15fps 的 1/4，鼠标立刻流畅。
      // Normal mode uses 1080p for OCR; Mac/HiDPI keeps the original 720p
      // light profile to avoid compositor and base64/JSON serialization stalls.
      const profile = visualCaptureProfile("screen", preferLightCapture());
      const screenVideo = {
        frameRate: { ideal: profile.sourceFrameRate, max: profile.sourceFrameRate },
        width: { ideal: profile.width, max: profile.width },
        height: { ideal: profile.height, max: profile.height },
      };
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: screenVideo, audio: true,
      });
      stream.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => stopStream(), { once: true }));
      await attachStream(stream, "screen");
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        startEnvAudio(stream);
        pushTopToast(`共享音频已接入 ASR (${audioTracks.length} 条音轨)`, "info");
      } else {
        pushTopToast(
          "屏幕共享已开始，但浏览器没有提供音轨；请选择带音频的标签页/窗口并勾选共享音频。",
          "warning",
        );
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.name !== "NotAllowedError") {
        addMsg({ id: nid(), role: "system", text: `屏幕共享失败: ${err.message}` });
      }
    }
  }, [addMsg, attachStream, pushTopToast, startEnvAudio, stopStream]);

  const sendAsk = useCallback((raw: string) => {
    const text = raw.trim();
    const r = refs.current;
    if (!text || !r.gw || !r.sessionId) return;
    // Allocate a stable turn id and its assistant slot before sending. This
    // keeps every answer directly below its own query even when Q2/Q3 are
    // accepted while Q1 is still streaming; gateway events route back by the
    // same id instead of all competing for a single "__main__" bubble.
    const clientRequestId = `turn_${nid()}`;
    const answerId = nid();
    curAssistantId.current.set(clientRequestId, answerId);
    r.isAnswering = true;
    // NB: do NOT preset queued=true. If prompt.submit later returns
    // status="queued" we flip it below; otherwise queued stays false so the
    // bubble renders as a normal streaming answer (blinking cursor). Presetting
    // queued=true used to leak a misleading "等待前一条回答完成 ..." message
    // whenever the LLM endpoint was unreachable — message.start never fired
    // (the call was stuck in TCP timeout), so the flag was never cleared and
    // the user saw an imaginary "previous turn is running" state.
    setMessages((prev) => capMsgs([
      ...prev,
      { id: nid(), role: "user", text, requestId: clientRequestId },
      {
        id: answerId,
        role: "assistant",
        text: "",
        streaming: true,
        awaitingFirstDelta: true,
        hasReasoning: false,
        requestId: clientRequestId,
      },
    ]));
    // Per-turn front-end trace. Complements the gateway [mm-trace] lines —
    // together they give you: send from browser → server enter →
    // agent_run_start → LLM SEND → LLM FIRST_BYTE → first delta reaches
    // browser. Any wide gap = the stall's location.
    const traceStart = performance.now();
    // eslint-disable-next-line no-console
    console.log(`%c[mm-trace-fe] +0ms sendAsk ("${text.slice(0, 40)}")`,
      "color:#28a745");
    (window as any).__mmTraceLast = { text, t0: traceStart, seen: {} };
    r.gw.request<{ status?: string; queue_position?: number }>("prompt.submit", {
      session_id: r.sessionId,
      text,
      client_request_id: clientRequestId,
      // Keep the current direct answer intact. The server accepts this message
      // as a distinct FIFO turn while watcher/monitor workers continue in their
      // own loops.
      queue_if_busy: true,
    })
      .then((res) => {
        if (res?.status === "queued" && res.queue_position != null) {
          setMessages((prev) => prev.map((m) => (
            m.id === answerId
              ? { ...m, queued: true, queuePosition: res.queue_position }
              : m
          )));
        }
        // eslint-disable-next-line no-console
        console.log(`%c[mm-trace-fe] +${(performance.now() - traceStart).toFixed(0)}ms prompt_submit_ack`,
          "color:#28a745");
      })
      .catch((e: Error) => {
        // eslint-disable-next-line no-console
        console.log(`%c[mm-trace-fe] +${(performance.now() - traceStart).toFixed(0)}ms prompt_submit_error ${e.message}`,
          "color:#dc3545");
        curAssistantId.current.delete(clientRequestId);
        refs.current.isAnswering = curAssistantId.current.size > 0;
        setMessages((prev) => prev.map((m) => (
          m.id === answerId
            ? { ...m, text: `发送失败: ${e.message}`, streaming: false,
                queued: false, queuePosition: undefined, isError: true }
            : m
        )));
      });
  }, []);

  // Stop button: interrupt the in-flight turn (session.interrupt aborts the live
  // turn + clears any queued prompt). Optimistically clear streaming flags so the
  // composer flips Stop→Send immediately even if the server's final events race.
  const stopAsk = useCallback(() => {
    const r = refs.current;
    setMessages((prev) => prev.some((m) => m.streaming)
      ? prev.map((m) => (m.streaming
        ? {
            ...m,
            text: m.text || (m.queued ? "已取消" : m.text),
            streaming: false,
            queued: false,
            queuePosition: undefined,
          }
        : m)) : prev);
    r.isAnswering = false;
    if (!r.gw || !r.sessionId) return;
    r.gw.request("session.interrupt", { session_id: r.sessionId })
      .catch(() => { /* best-effort — turn may have already finished */ });
  }, []);

  // Mic toggle (稳定引用给 <ChatColumn>)。connecting 期忽略点击 (避免 double
  // asr_start / 竞态 teardown); recording → stop; idle → start。仅随 micState 变。
  // ★ 对话模式开时麦由对话托管, 单独点麦无效 —— 拦截 + 顶部小提示 (按钮态不变)。
  const onMicToggle = useCallback(() => {
    if (voiceDialogEnabled) {
      pushTopToast("对话模式下麦克风已由对话接管, 请先关闭对话模式再单独控制", "info");
      return;
    }
    if (micState === "connecting") return;
    if (micState === "recording") void stopMic();
    else void startMic();
  }, [micState, stopMic, startMic, voiceDialogEnabled, pushTopToast]);

  // 【对话模式】= 后台统一接管麦/喇叭 (用户方案: UI 麦/喇叭按钮态保持不变, 仅后台联动)。
  //   ON  → ①后端 voice_dialog_toggle (使 is_speaker_on OR 对话态 → 强制 TTS; ASR final
  //           走 v2 分诊) ②前端物理开麦 (getUserMedia 采集是唯一能真正识别的途径, 后端
  //           无法凭空开麦; 麦按钮随之自然变红, 反映真实录音态)。喇叭按钮态不变。
  //   OFF → ①后端 voice_dialog_toggle(false) ②物理关麦 → 一切恢复各自 _mm_asr_on/
  //           _mm_tts_on 真实态。
  const toggleVoiceDialog = useCallback(() => {
    setVoiceDialogEnabled((prev) => {
      const next = !prev;
      const r = refs.current;
      // ★ 无 session 保护: 未选中 session 时 startMic 会静默 return, 用户点了没反应
      //   会以为对话模式坏。开显式提示后仍写下 flag(等选中 session 后交互仍生效)。
      if (next && (!r.gw || !r.sessionId)) {
        addMsg({ id: nid(), role: "system",
          text: "对话模式已打开, 但当前无活动 session (请先在左侧选一个)。选中后再点麦克风即可开始语音对话。" });
      }
      try {
        r.gw?.request("multimodal.voice_dialog_toggle",
          { session_id: r.sessionId, enabled: next }).catch(() => {});
      } catch { /* noop */ }
      // 麦克风物理联动 (TTS 由后端 is_speaker_on OR 对话态 强制, 不动 UI atom)。
      if (next) {
        if (micState === "idle" && r.gw && r.sessionId) {
          try { void startMic(); } catch { /* noop */ }
        }
      } else if (micState === "recording" || micState === "connecting") {
        try { void stopMic(); } catch { /* noop */ }
      }
      return next;
    });
  }, [micState, startMic, stopMic, addMsg]);

  // ▶ 播放 button on assistant bubbles for text-input turns (voice-input turns
  // auto-speak in the backend hook, so no button appears there).
  const playAssistantAudio = useCallback((text: string) => {
    const r = refs.current;
    if (!r.gw || !r.sessionId || !text.trim()) return;
    r.gw.request("multimodal.tts_speak", {
      session_id: r.sessionId, text,
    }).catch(() => { /* best-effort; TTS failure never blocks chat */ });
  }, []);

  // Virtuoso item renderer + stable key. Defined AFTER playAssistantAudio so
  // the callback closes over the stable ref (not a TDZ ref). Per-item px-4 pb-3
  // reproduces the old container p-4 + space-y-3 (container spacing utilities
  // don't apply to virtualized rows, which sit in their own positioned wrappers).
  // Answer a generic blocking clarify.request (e.g. set_monitor silent-mode).
  // Freezes the inline bubble to show the chosen answer, then unblocks the
  // waiting tool via clarify.respond. Idempotent: ignores clicks on an
  // already-answered bubble. Declared before renderRow (which lists it as a
  // useCallback dep) to avoid a temporal-dead-zone reference.
  const answerClarify = useCallback((reqId: string, answer: string) => {
    const r = refs.current;
    let already = false;
    setMessages((prev) => prev.map((m) => {
      if (m.kind !== "clarify" || m.clarifyReqId !== reqId) return m;
      if (m.clarifyAnswer !== undefined) { already = true; return m; }
      return { ...m, clarifyAnswer: answer };
    }));
    if (already || !r.gw || !r.sessionId) return;
    r.gw.request("clarify.respond", {
      session_id: r.sessionId, request_id: reqId, answer,
    }).catch(() => { /* best-effort; tool will time out server-side */ });
  }, []);

  // 点击历史深度研究气泡 → 从 analyse 文件读回, 在右侧重建一个【只读】BgItem
  // (分段 + 最终报告), 使 ridIsActive 命中 → visibleDeep 纳入 → 右侧窗口打开。
  const reopenDeepReport = useCallback((rid: string) => {
    const r = refs.current;
    if (!r.gw || !r.sessionId || !rid) return;
    r.gw.request<{
      found?: boolean;
      status?: string;
      query?: string;
      rounds?: { n: number; frame_range?: string; sub_queries?: string[]; findings?: string }[];
      final_report?: string;
    }>("multimodal.get_watcher_report", { session_id: r.sessionId, request_id: rid })
      .then((res) => {
        if (!res || res.found === false) return;
        const segments: BgSegment[] = (res.rounds || []).map((rd) => ({
          seg: rd.n,
          saw: "",
          answer: (rd.findings || "").trim(),
          ready: true,
          lookups: (rd.sub_queries || []).map((q) => ({ kind: "search" as const, query: q, done: true })),
        }));
        const label = watchersRef.current.find((w) => w.watcher_id === rid)?.label
          || res.query || "深度分析";
        // done 按文件真实 status 判定, 不硬编码 (否则进行中的任务被点开会错显"已完成")。
        const st = String(res.status || "").toLowerCase();
        const isDone = ["completed", "complete", "done", "stopped"].includes(st);
        const item: BgItem = {
          id: rid, requestId: rid, label, segments, done: isDone, waiting: null,
          finalReport: (res.final_report || "").trim() || undefined,
        };
        setBgItems((prev) => {
          // ★ 若该 rid 已在面板里【实时进行中】(existing.done !== true), 不用只读快照顶替
          //   (否则把"进行中"错显成"已完成"并盖掉实时流)。只置顶已有条目即可。
          const existing = prev.find((b) => (b.requestId || b.id) === rid);
          if (existing && existing.done !== true) {
            return [existing, ...prev.filter((b) => (b.requestId || b.id) !== rid)];
          }
          return [item, ...prev.filter((b) => (b.requestId || b.id) !== rid)].slice(-8);
        });
        setDeepExpanded(rid);   // 强制展开该窗口
      })
      .catch(() => { /* best-effort */ });
  }, []);

  // ★ 逐条 ▶ 手动播放按钮只在"无自动播报"时显示 (喇叭关 且 对话关)。任一自动播报
  //   开着 → 传 undefined 让 ChatBubble 隐藏 ▶, 防"自动念 + 手动点"双重播放。
  const autoSpeakOn = ttsEnabled || voiceDialogEnabled;
  const renderRow = useCallback((_i: number, row: Row) => {
    // ── bg (工具/状态) 行 ──
    // ★ 流式期间隐藏"处理过程"卡: 若上一行正是本轮 streaming 空 body 的 assistant
    //   (isPureThinkingChat) 且本 bg 行含 tool 条目 → 该 bg 属于进行中的这一轮, 其
    //   工具活动已由上方 💭 思考行实时呈现, 这里不重复出卡。待本轮产出正文/结束后,
    //   上一行不再是纯思考态, 本 bg 卡自然重新出现 (或让位给完整 AssistantMessage)。
    if (row.type === "bg") {
      const prev = rows[_i - 1];
      const ownedByStreamingTurn =
        prev?.type === "chat" &&
        isPureThinkingChat(prev.msg) &&
        row.items.some((it) => it.kind === "tool");
      if (ownedByStreamingTurn) return null;
      return (
        <div className="px-4 pb-3">
          <BgBlock items={row.items} />
        </div>
      );
    }

    // ── chat 行 ──
    const msg = row.msg;
    const pureThinking = isPureThinkingChat(msg);
    // ── 从相邻 bg 行派生: 本轮是否已产生 tool 条目 (inToolCall), 以及【当前正在运行】
    //    的工具的一句话活动 (toolActivity, 最新的运行中 tool 胜出)。toolActivity 只在
    //    有运行中 (!toolDone) 工具时非空 —— 工具跑完的间隙回落到 reasoning 摘要, 从而与
    //    思维链在 💭 位置【交替显示】。工具是独立 kind:"tool" 消息, 相邻合并进一个 bg row。
    let inToolCall = false;
    let toolActivity = "";
    if (pureThinking) {
      const next = rows[_i + 1];
      if (next && next.type === "bg") {
        const tools = next.items.filter((it) => it.kind === "tool");
        if (tools.length) {
          inToolCall = true;
          // 最新的运行中工具 (从尾部找第一个 !toolDone)。
          let running: ChatMsg | undefined;
          for (let k = tools.length - 1; k >= 0; k--) {
            if (!tools[k].toolDone) { running = tools[k]; break; }
          }
          if (running?.toolName) {
            toolActivity = running.toolCtx
              ? `${running.toolName} · ${running.toolCtx.slice(0, 60)}`
              : running.toolName;
          }
        }
      }
    }
    // 紧凑收纳: 纯思考行 (含工具调用态) 只是一行小状态文字, 上下都不需要 12px 大间距,
    // 用 -mt-3 抵消 space-y-3 让它紧贴上一条 UserMessage, 用 pb-0 拿掉底部 padding ——
    // 下一条 (最终气泡) 靠 space-y-3 自己拿间距。
    return (
      <div className={pureThinking ? "-mt-3 px-4 pb-0" : "px-4 pb-3"}>
        {msg.kind === "clarify"
          ? <ClarifyBubble m={msg} onAnswer={answerClarify} />
          : <ChatBubble m={msg} model={model}
              onPlay={autoSpeakOn ? undefined : playAssistantAudio}
              onReopenDeep={reopenDeepReport}
              inToolCall={inToolCall}
              toolActivity={toolActivity} />}
      </div>
    );
  }, [rows, model, playAssistantAudio, answerClarify, reopenDeepReport, autoSpeakOn]);
  const itemKey = useCallback(
    (_i: number, row: Row) => (row.type === "bg" ? row.id : row.msg.id),
    [],
  );

  // Publish the model / source / TTS badges next to the "Multimodal" page title,
  // and the connection status (+ stop-TTS control) into the header's end slot.
  //
  // ★ PERF: this effect updates the App-level PageHeaderProvider state
  // (setAfterTitle/setEnd), whose children include the ENTIRE current page. So
  // anything in this effect's deps that changes frequently re-renders the whole
  // page from the top. `frameCount` updates ~2×/s during screen share → that
  // was re-rendering the full page (video + chat + all panels) twice a second,
  // making the whole UI janky and typing laggy. Do NOT depend on frameCount
  // here — the live frame count is shown in the local video overlay instead.
  useEffect(() => {
    setAfterTitle(
      <div className="flex flex-wrap items-center gap-1.5">
        {sourceType && <Badge tone="secondary">{sourceType === "camera" ? "摄像头" : "屏幕"}</Badge>}
        {ttsPlaying && (
          <Badge tone="outline" className="gap-1 border-violet-400/60 text-violet-300">
            <Volume2 className="h-3 w-3" /> TTS
          </Badge>
        )}
      </div>,
    );
    setEnd(
      <div className="flex items-center gap-2">
        {ttsPlaying && (
          <Button size="sm" outlined prefix={<Square />} onClick={() => stopAllTts(true)}>
            停说
          </Button>
        )}
        <Badge tone={connected ? "success"
          : connState === "reconnecting" || connState === "connecting" ? "warning"
          : "destructive"}>
          {connected ? "已连接"
            : connState === "reconnecting" ? "重连中…"
            : connState === "connecting" ? "连接中…"
            : "已断开"}
        </Badge>
      </div>,
    );
    return () => { setAfterTitle(null); setEnd(null); };
  }, [sourceType, ttsPlaying, connected, connState, stopAllTts, setAfterTitle, setEnd]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3 p-4">
      <MmReadinessBanner report={mmReadiness} />
      <button
        type="button"
        onClick={() => setMemoryDebugOpen(true)}
        title="Memory Debug"
        className="absolute right-4 top-4 z-30 inline-flex h-8 items-center gap-1.5 rounded border border-emerald-300/40 bg-background/80 px-2 text-xs text-emerald-200 backdrop-blur hover:border-emerald-200"
      >
        <Bug className="h-3.5 w-3.5" />
        Memory
      </button>
      <MemoryDebugPanel
        open={memoryDebugOpen}
        onClose={() => setMemoryDebugOpen(false)}
        currentSessionId={refs.current.storedSid || refs.current.sessionId}
        trajectory={trajectory}
      />
      {/* 顶部居中 toast (页面级操作提示, 如未开视频流恢复监控失败), 2s 淡出。
          fixed 贴视口顶部 (不受页面 p-4 内边距下压), 悬浮在最上层。 */}
      {topToasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 top-2 z-[100] flex flex-col items-center gap-1.5">
          {topToasts.map((tt) => (
            <div key={tt.id}
              className={`mm-toast-in pointer-events-auto max-w-[90%] rounded-md border px-3 py-2 text-xs leading-snug shadow-lg backdrop-blur-sm ${
                tt.level === "warning"
                  ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
                  : tt.level === "info"
                    ? "border-border/50 bg-muted/50 text-muted-foreground"
                    : "border-red-400/40 bg-red-500/15 text-red-200"}`}>
              {tt.text}
            </div>
          ))}
        </div>
      )}
      {/* ★ 列宽用 minmax(0,1fr) 而非 1fr: CSS grid 的 1fr 默认 min-width:auto =
          内容宽度, 中/右列一旦有超长不换行内容(长英文标题/表格/代码)就会把列撑破,
          整行溢出、右列冲出容器右边界 (切屏后偶发的"没有右边界")。minmax(0,1fr)
          让列可收缩到 0 以下由内层 overflow/break 兜住, 消除溢出。 */}
      <div className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${
        showDeepCol ? "lg:grid-cols-[360px_minmax(0,1fr)_minmax(0,1fr)]" : "lg:grid-cols-[360px_minmax(0,1fr)]"}`}>
        {/* LEFT: 视频 + 注入帧 + 画面/音频观察 + 搜索事实。frameCount(1/s)/anchor/ctx
            的 setState 只重渲染这一列, 不再牵动中间聊天列与右侧深研列。 */}
        <LeftPanels
          sourceType={sourceType}
          frameCount={frameCount}
          anchorFrames={anchorFrames}
          ctxVersion={ctx.version}
          obs={ctx.obs}
          audioObs={ctx.audioObs}
          factsList={factsList}
          videoRef={videoRef}
          obsScrollRef={obsScrollRef}
          audioObsScrollRef={audioObsScrollRef}
          onStartCamera={() => void startCamera()}
          onStopStream={stopStream}
          onStartScreen={() => void startScreen()}
        />

        {/* MIDDLE: 聊天列。messages(rows) 变才重渲染; anchor/ctx/frameCount 变时
            rows 引用不变 → 此列 memo 命中、跳过。 */}
        <ChatColumn
          rows={rows}
          renderRow={renderRow}
          itemKey={itemKey}
          atBottom={atBottom}
          chatScrollRef={chatScrollRef}
          onChatScroll={onChatScroll}
          scrollChatToBottom={scrollChatToBottom}
          chatAtBottomRef={chatAtBottomRef}
          isRecordingUI={isRecordingUI}
          asrPartial={asrPartial}
          asrBuffer={asrBuffer}
          micState={micState}
          ttsEnabled={ttsEnabled}
          onTtsToggle={toggleTts}
          voiceDialogEnabled={voiceDialogEnabled}
          onVoiceDialogToggle={toggleVoiceDialog}
          generating={generating}
          onStop={stopAsk}
          onSend={sendAsk}
          onMicToggle={onMicToggle}
        />

        {/* RIGHT: 监控/深研注册表 + 深研窗口 + toast。bgItems/visibleDeep/monitors/
            watchers 变才重渲染; 主 agent 纯文本流 (messages 变但不涉 router) 不必然
            触及此列 (deepWindows 依赖 messages, 保持现状——router 气泡本就该更新)。 */}
        <DeepColumn
          showDeepCol={showDeepCol}
          mmToasts={mmToasts}
          monitors={monitors}
          watchers={watchers}
          onToggleMonitor={onToggleMonitor}
          onToggleWatcher={onToggleWatcher}
          visibleDeep={visibleDeep}
          bgByRid={bgByRid}
          deepExpanded={deepExpanded}
          model={model}
          onToggleDeep={toggleDeepWindow}
          monitorAlerts={monitorAlerts}
          monitorCollapsed={monitorCollapsed}
          monitorExpanded={monitorExpanded}
          onToggleMonitorCollapsed={toggleMonitorCollapsed}
          onToggleMonitorExpanded={toggleMonitorExpanded}
        />
      </div>
    </div>
  );
}
