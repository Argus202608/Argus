import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from '@assistant-ui/core'
import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  type ToolCallMessagePartProps,
  useAui,
  useAuiState,
  useMessageRuntime
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  type ClipboardEvent,
  type ComponentProps,
  type FC,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { COMPOSER_DROP_ACTIVE_CLASS, COMPOSER_DROP_FADE_CLASS } from '@/app/chat/composer/drop-affordance'
import {
  type ComposerInsertMode,
  focusComposerInput,
  markActiveComposer,
  onComposerFocusRequest,
  onComposerInsertRequest
} from '@/app/chat/composer/focus'
import { useAtCompletions } from '@/app/chat/composer/hooks/use-at-completions'
import { useSlashCompletions } from '@/app/chat/composer/hooks/use-slash-completions'
import { QueryWorkerTrajectoryPanel } from '@/app/multimodal/query-worker-trajectory-panel'
import { queryWorkerTaskId } from '@/app/multimodal/query-worker-trajectory'
import type { MmTrajectoryEntry } from '@/app/multimodal/trajectory-grouping'
import {
  dragHasAttachments,
  droppedFileInlineRefs,
  type InlineRefInput,
  insertInlineRefsIntoEditor
} from '@/app/chat/composer/inline-refs'
import {
  composerPlainText,
  placeCaretEnd,
  refChipElement,
  renderComposerContents,
  RICH_INPUT_SLOT
} from '@/app/chat/composer/rich-editor'
import { detectTrigger, textBeforeCaret, type TriggerState } from '@/app/chat/composer/text-utils'
import { ComposerTriggerPopover } from '@/app/chat/composer/trigger-popover'
import {
  extractDroppedFiles,
  HERMES_PATHS_MIME,
  isImagePath,
  partitionDroppedFiles
} from '@/app/chat/hooks/use-composer-actions'
import { uploadComposerAttachment } from '@/app/session/hooks/use-prompt-actions'
import { ClarifyTool } from '@/components/assistant-ui/clarify-tool'
import { DirectiveContent, hermesDirectiveFormatter } from '@/components/assistant-ui/directive-text'
import { MarkdownText, MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { ThreadMessageList } from '@/components/assistant-ui/thread-list'
import { ThreadTimeline } from '@/components/assistant-ui/thread-timeline'
import { ToolFallback, ToolGroupSlot } from '@/components/assistant-ui/tool-fallback'
import { selectMessageHasVisibleText } from '@/components/assistant-ui/tool-fallback-model'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { UserMessageText } from '@/components/assistant-ui/user-message-text'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { DisclosureRow } from '@/components/chat/disclosure-row'
import { GeneratedImage } from '@/components/chat/generated-image-result'
import { Intro, type IntroProps } from '@/components/chat/intro'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Loader } from '@/components/ui/loader'
import type { HermesGateway } from '@/hermes'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { attachmentDisplayText, attachmentId, pathLabel } from '@/lib/chat-runtime'
import { DATA_IMAGE_URL_RE } from '@/lib/embedded-images'
import { LinkifiedText } from '@/lib/external-link'
import { triggerHaptic } from '@/lib/haptics'
import { Eye, GitBranchIcon, Loader2Icon, Play, Search, StopFilled, Volume2Icon, VolumeXIcon, XIcon } from '@/lib/icons'
import { extractPreviewTargets } from '@/lib/preview-targets'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { playSpeechText, stopVoicePlayback } from '@/lib/voice-playback'
import { $backgroundResume } from '@/store/background-delegation'
import { queryTrajectoryTaskStore } from '@/store/multimodal'
import { $compactionActive } from '@/store/compaction'
import type { ComposerAttachment } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import { $activeSessionAwaitingInput } from '@/store/prompts'
import { fmtClock } from '@/store/multimodal'
import { $connection } from '@/store/session'
import { notifyThreadEditClose } from '@/store/thread-scroll'
import { $voicePlayback } from '@/store/voice-playback'
import { $isWindowResizing } from '@/store/window-resize'

type ThreadLoadingState = 'response' | 'session'
interface RestoreMessageTarget {
  text: string
  userOrdinal: number | null
}

interface MessageActionProps {
  messageId: string
  /** Lazy accessor — reads the live message text at action time. Passing the
   *  text itself as a prop forces the whole footer to re-render on every
   *  streaming delta flush (the text changes ~30×/s), which profiling showed
   *  was a large slice of per-token script time on long transcripts. */
  getMessageText: () => string
  onBranchInNewChat?: (messageId: string) => void
}

let readAloudAudio: HTMLAudioElement | null = null

function partText(part: unknown): string {
  if (typeof part === 'string') {
    return part
  }

  if (!part || typeof part !== 'object') {
    return ''
  }

  const row = part as { text?: unknown; type?: unknown }

  return (!row.type || row.type === 'text') && typeof row.text === 'string' ? row.text : ''
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  return Array.isArray(content) ? content.map(partText).join('').trim() : ''
}

// Cheap streaming-stable "does this message have visible text" check: returns
// on the first non-whitespace text part without concatenating the whole
// message. Used as a useAuiState selector so its boolean output stays stable
// across token flushes (flips false→true once per turn).
function contentHasVisibleText(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  if (!Array.isArray(content)) {
    return false
  }

  for (const part of content) {
    if (partText(part).trim().length > 0) {
      return true
    }
  }

  return false
}

export const Thread: FC<{
  clampToComposer?: boolean
  cwd?: string | null
  gateway?: HermesGateway | null
  intro?: IntroProps
  loading?: ThreadLoadingState
  onBranchInNewChat?: (messageId: string) => void
  onCancel?: () => Promise<void> | void
  onDismissError?: (messageId: string) => void
  onRestoreToMessage?: (messageId: string, target?: RestoreMessageTarget) => Promise<void> | void
  sessionId?: string | null
  sessionKey?: string | null
}> = ({
  clampToComposer = false,
  cwd = null,
  gateway = null,
  intro,
  loading,
  onBranchInNewChat,
  onCancel,
  onDismissError,
  onRestoreToMessage,
  sessionId = null,
  sessionKey
}) => {
  const { t } = useI18n()
  const copy = t.assistant.thread

  const [restoreConfirmTarget, setRestoreConfirmTarget] = useState<
    (RestoreMessageTarget & { messageId: string }) | null
  >(null)

  const closeRestoreConfirm = useCallback(() => setRestoreConfirmTarget(null), [])

  const confirmRestore = useCallback(() => {
    if (!restoreConfirmTarget || !onRestoreToMessage) {
      throw new Error('Restore is unavailable for this message.')
    }

    const { messageId, text, userOrdinal } = restoreConfirmTarget

    closeRestoreConfirm()
    void Promise.resolve(onRestoreToMessage(messageId, { text, userOrdinal })).catch((error: unknown) => {
      notifyError(error, 'Restore failed')
    })
  }, [closeRestoreConfirm, onRestoreToMessage, restoreConfirmTarget])

  const requestRestoreConfirm = useCallback((messageId: string, target: RestoreMessageTarget) => {
    setRestoreConfirmTarget({ messageId, ...target })
  }, [])

  const messageComponents = useMemo(
    () => ({
      AssistantMessage: () => (
        <AssistantMessage onBranchInNewChat={onBranchInNewChat} onDismissError={onDismissError} />
      ),
      SystemMessage,
      UserEditComposer: () => <UserEditComposer cwd={cwd} gateway={gateway} sessionId={sessionId} />,
      UserMessage: () => (
        <UserMessage
          onCancel={onCancel}
          onRequestRestoreConfirm={onRestoreToMessage ? requestRestoreConfirm : undefined}
        />
      )
    }),
    [cwd, gateway, onBranchInNewChat, onCancel, onDismissError, onRestoreToMessage, requestRestoreConfirm, sessionId]
  )

  // ★ 多模态引导气泡: 常驻主 Agent 对话顶部, 空态时也显示 (空态走
  //   emptyPlaceholder, 非空时走 topBanner 与消息一起滚动)。发送消息后不消失。
  const introBubble = intro ? <Intro {...intro} /> : undefined
  const emptyPlaceholder = introBubble ? (
    <div className="flex min-h-0 w-full flex-col items-stretch justify-start px-4 pt-4">
      {introBubble}
    </div>
  ) : undefined

  return (
    <div className="relative grid h-full min-h-0 max-w-full grid-rows-[minmax(0,1fr)] overflow-hidden bg-transparent contain-[layout_paint]">
      <ThreadMessageList
        clampToComposer={clampToComposer}
        components={messageComponents}
        emptyPlaceholder={emptyPlaceholder}
        loadingIndicator={loading === 'response' ? <ResponseLoadingIndicator /> : <BackgroundResumeNotice />}
        sessionKey={sessionKey}
        topBanner={introBubble}
      />
      {loading === 'session' && <CenteredThreadSpinner />}
      <ThreadTimeline />
      <ConfirmDialog
        confirmLabel={copy.restoreConfirm}
        description={copy.restoreBody}
        destructive
        onClose={closeRestoreConfirm}
        onConfirm={confirmRestore}
        open={Boolean(restoreConfirmTarget)}
        title={copy.restoreTitle}
      />
    </div>
  )
}

function pickPrimaryPreviewTarget(targets: string[]): string[] {
  if (targets.length <= 1) {
    return targets
  }

  const localUrl = targets.find(value => /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(value))

  return [localUrl || targets[targets.length - 1]]
}

const CenteredThreadSpinner: FC = () => {
  const { t } = useI18n()

  return (
    <div
      aria-label={t.assistant.thread.loadingSession}
      className="pointer-events-none absolute inset-0 z-1 grid place-items-center"
      role="status"
    >
      <Loader
        aria-hidden="true"
        className="size-12 text-midground/70"
        pathSteps={220}
        role="presentation"
        strokeScale={0.72}
        type="rose-curve"
      />
    </div>
  )
}

// Sub-role metadata carried on an assistant message (monitor SPEAK /
// deep-research threadback) — see toRuntimeMessage's metadata.custom.
interface SubRoleMeta {
  subRole?: 'monitor' | 'router' | 'watcher_report'
  monitorLabel?: string
  brief?: string
  deepReportRid?: string
  deepRange?: string
  deepRound?: number
  model?: string
  voice?: boolean
}

// (SubRoleHeader 已移除: monitor/router 的头部行现在渲染在各自卡片内第一行,
//  watcher_report 用其 <details> summary; 不再有卡片外的独立头部行。)

// ── Web-style 头像 + 头部行 (对齐 web 多模态页): 圆形头像 (U/A) + 角色名 + 时间 +
//    (assistant) 模型徽标 + 播放按钮。配色全用桌面 token, 不引入 web 硬编码色。 ──────
const MessageAvatar: FC<{ role: 'user' | 'assistant' }> = ({ role }) => (
  <div
    className={cn(
      'flex size-7 shrink-0 select-none items-center justify-center rounded-full text-[0.7rem] font-semibold',
      role === 'user'
        ? 'bg-(--ui-accent)/20 text-(--ui-accent)'
        : 'bg-(--ui-purple)/15 text-(--ui-purple)'
    )}
    aria-hidden="true"
  >
    {role === 'user' ? 'U' : 'A'}
  </div>
)

// 可见的播放/停止按钮 (放在 assistant 头部行)。复用主聊天原生的 $voicePlayback /
// playSpeechText / stopVoicePlayback: 它已带 messageId + 单实例语义 (playSpeechText
// 内部先 stopVoicePlayback → 切到别条会自动停旧的, 旧按钮据 messageId 复位为播放)。
const ReadAloudButton: FC<{ getText: () => string; messageId: string }> = ({ getText, messageId }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const voicePlayback = useStore($voicePlayback)
  const status =
    voicePlayback.source === 'read-aloud' && voicePlayback.messageId === messageId
      ? voicePlayback.status
      : 'idle'
  const isPreparing = status === 'preparing'
  const isSpeaking = status === 'speaking'
  // 播放 ▶ (三角) / 停止 ■ (StopFilled) / 准备中转圈。
  const Icon = isPreparing ? Loader2Icon : isSpeaking ? StopFilled : Play
  const onClick = useCallback(async () => {
    if (isSpeaking) {
      void stopVoicePlayback()
      return
    }
    if (isPreparing) return
    const text = getText()
    if (!text) return
    try {
      await playSpeechText(text, { messageId, source: 'read-aloud' })
    } catch (error) {
      notifyError(error, copy.readAloudFailed)
    }
  }, [copy.readAloudFailed, getText, isPreparing, isSpeaking, messageId])
  return (
    <button
      className="inline-flex items-center gap-1 rounded border border-(--ui-stroke-tertiary) px-1.5 py-0.5 text-[0.6rem] text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground [-webkit-app-region:no-drag]"
      onClick={() => void onClick()}
      title={isSpeaking ? 'Stop' : 'Play'}
      type="button"
    >
      <Icon className={cn('size-3', isPreparing && 'animate-spin')} />
      {isSpeaking ? 'Stop' : 'Play'}
    </button>
  )
}

// 普通 assistant 头部行: A 角色名 + 时间 + 模型徽标 + 播放按钮。
const AssistantHeaderRow: FC<{
  createdAt?: Date
  model?: string
  getText: () => string
  messageId: string
  showActions?: boolean
  onBranchInNewChat?: (messageId: string) => void
}> = ({ createdAt, model, getText, messageId, showActions, onBranchInNewChat }) => {
  const clock = fmtClock(createdAt ? createdAt.getTime() : undefined)
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[0.65rem] text-(--ui-text-tertiary)">
      <span className="font-medium text-(--ui-text-secondary)">Assistant</span>
      {clock && <span className="tabular-nums text-(--ui-text-quaternary)">{clock}</span>}
      {model && <Badge variant="outline">{model}</Badge>}
      <ReadAloudButton getText={getText} messageId={messageId} />
      {/* Copy / Reload / More: 挪到头部行右侧 (ml-auto), 不再占正文下方一整行。
         hover 显隐仍靠 MessagePrimitive.Root 的 group。 */}
      {showActions && (
        <div className="ml-auto">
          <AssistantActionBar getMessageText={getText} messageId={messageId} onBranchInNewChat={onBranchInNewChat} />
        </div>
      )}
    </div>
  )
}

// 深度回传正文卡: 受控折叠 (非 <details>, 因为原生 details 折叠时整块隐藏, 做不到"露一行")。
// 默认折叠 → 三角 ▸ + 正文单行行末省略号 (truncate); 点三角展开 → ▾ + 多行全文。
// 头部 (第N段/时段区间/时间/#id) 在卡片外, 这里只管正文的折叠。
const WatcherReportBody: FC = () => {
  const [open, setOpen] = useState(false)
  // ★ 与 web 对齐: 正文卡头显示「第N段 + 时段区间」。段号走 deepRound(独立字段),
  //   时段走 deepRange —— 之前 desktop 抠出 deepRange 却没渲染 (bug 级遗漏)。
  const subMeta = useAuiState(s => (s.message.metadata?.custom ?? {}) as SubRoleMeta)
  const segLabel = subMeta.deepRound != null ? `第${subMeta.deepRound}段` : ''
  const rangeLabel = subMeta.deepRange || ''
  return (
    <div className="rounded-lg border-l-2 border-(--ui-purple) bg-(--ui-purple)/8 px-3 py-2">
      <button
        className="flex w-full cursor-pointer select-none items-start gap-1.5 text-left text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground"
        onClick={() => setOpen(o => !o)}
        type="button"
      >
        <span className={cn('mt-0.5 shrink-0 select-none text-(--ui-text-quaternary) transition-transform', open && 'rotate-90')}>
          ▸
        </span>
        {(segLabel || rangeLabel) && (
          <span className="mt-0.5 shrink-0 tabular-nums text-(--ui-text-tertiary)">
            {[segLabel, rangeLabel].filter(Boolean).join(' ')}
          </span>
        )}
        {/* 折叠: 用 max-height 夹成约一行高 + overflow-hidden (line-clamp/truncate 对
            块级 markdown 子元素无效, 这才可靠)。折叠时右下角叠一个 " ..." 表示省略。
            展开: max-height 放开显示全文, 隐藏省略号。 */}
        <div className="relative min-w-0 max-w-full">
          <div
            className="wrap-anywhere overflow-hidden"
            style={{ maxHeight: open ? 'none' : '1.6em' }}
          >
            <MessagePrimitive.Parts components={MESSAGE_PARTS_COMPONENTS} />
          </div>
          {!open && (
            <span className="pointer-events-none absolute bottom-0 right-0 bg-(--ui-purple)/8 pl-1 text-(--ui-text-tertiary)">
              {' ...'}
            </span>
          )}
        </div>
      </button>
    </div>
  )
}

const AssistantMessage: FC<{
  onBranchInNewChat?: (messageId: string) => void
  onDismissError?: (messageId: string) => void
}> = ({ onBranchInNewChat, onDismissError }) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRuntime = useMessageRuntime()
  const { t } = useI18n()

  // Sub-role tag (monitor SPEAK / deep-research threadback). Stable across token
  // flushes, so reading it here doesn't add per-delta re-renders.
  const subMeta = useAuiState(s => (s.message.metadata?.custom ?? {}) as SubRoleMeta)
  const subRole = subMeta.subRole
  const messageCreatedAt = useAuiState(s => s.message.createdAt)

  // PERF: this component must NOT subscribe to the streaming text. Every
  // selector here returns a value that stays referentially stable across
  // token flushes (booleans, status strings, '' while running), so the
  // 30 Hz delta stream only re-renders the markdown part and the tiny
  // StreamStallIndicator leaf — not the footer/preview/root subtree.
  const messageStatus = useAuiState(s => s.message.status?.type)
  const isRunning = messageStatus === 'running'
  const isPlaceholder = useAuiState(s => s.message.status?.type === 'running' && s.message.content.length === 0)
  const hasVisibleText = useAuiState(s => contentHasVisibleText(s.message.content))

  // Preview targets only materialize once the turn completes — while running
  // the selector returns '' (stable), so per-token flushes skip the regex
  // scan and the re-render it would cause.
  const completedText = useAuiState(s =>
    s.message.status?.type === 'running' ? '' : messageContentText(s.message.content)
  )

  const previewTargets = useMemo(() => {
    if (!completedText || !/(https?:\/\/|file:\/\/)/i.test(completedText)) {
      return []
    }

    return pickPrimaryPreviewTarget(extractPreviewTargets(completedText))
  }, [completedText])

  const getMessageText = useCallback(() => messageContentText(messageRuntime.getState().content), [messageRuntime])

  const enterRef = useEnterAnimation(isRunning, `assistant-message:${messageId}`)

  // ★ 占位态 (running 但 content 还完全为空, 一个 part 都没到) → 本组件不渲染, 交给
  //   Thread 的 ResponseLoadingIndicator ("Waiting response…") 独占这一行。★ 关键: 必须
  //   排在下面"纯思考态"分支【之前】—— 否则 content 为空时 !hasVisibleText 也成立, 会
  //   走纯思考态渲染出一行 CurrentActivityLine ("Thinking"), 与 ResponseLoadingIndicator
  //   的 "Waiting…" 同屏并存 → 两行。首个 part (reasoning/tool) 落地后 content 非空,
  //   本分支不再命中, 下面纯思考行接管, 零跳变、恒为单行。
  if (isPlaceholder) {
    return null
  }

  // ★ 纯思考态: 运行中、已有 part 但还没有正文 → 不渲染 AssistantMessage 卡, 只渲染
  //   【一行】独立思考状态 (💭 + 当前动作 + 计时)。★ 有工具调用时也走这条 (不再出一张空的
  //   AssistantMessage 卡 / 空行): 工具执行期间 CurrentActivityLine 会显示
  //   "Running: …" 等当前动作, 待正文落地 (hasVisibleText) 或本轮完成后, thinking
  //   行消失, 再由下方完整 AssistantMessage 卡一次性渲染 (正文 + 工具卡)。
  //   【不显示头像 A, 不缩进】—— 左缘对齐 composer 文本框左边, 计时器 ml-auto 对齐
  //   右边, 字号 text-xs。只用 CurrentActivityLine 单指示器 (它 fallback 恒显
  //   "Thinking" + 计时), 保证单行不多行。subRole (monitor/router/watcher) 不走这条,
  //   保留自身彩色卡形态。NB: 该行布局须与 ResponseLoadingIndicator ("Waiting…") 一致。
  if (isRunning && !subRole && !hasVisibleText) {
    return (
      <div
        className="group flex w-full min-w-0 max-w-full flex-row items-center gap-2 self-start overflow-hidden"
        data-role="assistant"
        data-slot="aui_assistant-thinking-row"
        ref={enterRef}
      >
        {/* 隐形头像占位: 与下方完整 AssistantMessage 卡的 MessageAvatar (size-7 + gap-2)
            同宽, 让思考行 body 与 "You"/正文卡左缘对齐, 不再贴到 chat gutter。 */}
        <div aria-hidden className="size-7 shrink-0" />
        <CurrentActivityLine />
      </div>
    )
  }

  return (
    <MessagePrimitive.Root
      className="group flex w-full min-w-0 max-w-full flex-row gap-2 self-start overflow-hidden"
      data-role="assistant"
      data-slot="aui_assistant-message-root"
      data-streaming={isRunning ? 'true' : undefined}
      ref={enterRef}
    >
      {/* Web 风格头像列 (A / subRole emoji), body 列靠它自然缩进。 */}
      <MessageAvatar role="assistant" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
      {/* 普通 assistant: 头部行 (角色名+时间+模型+播放按钮)。subRole 用各自的 SubRoleHeader。 */}
      {!subRole && (
        <AssistantHeaderRow
          createdAt={messageCreatedAt}
          getText={getMessageText}
          messageId={messageId}
          model={subMeta.model}
          onBranchInNewChat={onBranchInNewChat}
          showActions={hasVisibleText}
        />
      )}
      {/* 监控 / 深度分析(router/watcher_report) 卡片外头部行: [事件tab (含"第N段")] [绝对时间]
         左对齐, #事件id 右对齐 (ml-auto)。 */}
      {(subRole === 'monitor' || subRole === 'router' || subRole === 'watcher_report') && (
        <div className="mb-1 flex items-center gap-1.5 text-[0.65rem]">
          <Badge
            className={cn(
              'bg-transparent px-0',
              subRole === 'monitor' ? 'text-(--ui-yellow)' : 'text-(--ui-purple)'
            )}
            variant="muted"
          >
            {subRole === 'monitor' ? <Eye /> : <Search />}
            {subRole === 'monitor'
              ? subMeta.monitorLabel || t.assistant.thread.monitorAlert
              : subMeta.monitorLabel || subMeta.brief || t.assistant.thread.deepResearch}
          </Badge>
          {fmtClock(messageCreatedAt ? messageCreatedAt.getTime() : undefined) && (
            <span className="tabular-nums text-(--ui-text-quaternary)">
              {fmtClock(messageCreatedAt ? messageCreatedAt.getTime() : undefined)}
            </span>
          )}
          {subMeta.deepReportRid && (
            <span className="ml-auto font-mono text-(--ui-text-quaternary)">#{subMeta.deepReportRid}</span>
          )}
        </div>
      )}
      {/* ★ 思考气泡: 独立于 AssistantMessage 正文卡片, 放在气泡外的一行。原因:
         interleaved thinking (reasoning ↔ tool_call ↔ text 交错) 时, 如果把
         "✷ Thinking / Reading X" 塞进正文卡内, 卡片会因 label 时隐时现而"抖":
         text 流出 → 隐藏 → 又来一段 reasoning → 顶部又冒出 shimmer 行, 阅读被
         打断。挪到卡片外独立成一"思考气泡", 状态机自己一行, 不再占用 (也不再
         reflow) 正文卡 —— 交错工具/文本随 MessagePrimitive.Parts 平铺照常。
         深度/监控子角色气泡样式独立, 不套这一层。 */}
      {isRunning && !subRole && <ThinkingBubble />}
      {/* ★ 完成态 reasoning 回看: 也搬到正文卡外, 保持"整条 thinking 状态机全部
         不占用 AssistantMessage 正文卡"的一致性。gated on !isRunning 避免和上面
         流式 ThinkingBubble 打架; gated on !subRole 让 monitor/router/watcher
         保留自身彩色卡形态。 */}
      {!isRunning && !subRole && <CompletedReasoningPanel />}
      {/* 深度分析回传: 卡片内 = 第几段 + 时段区间 + 正文(单行, 行末省略)。 */}
      {subRole === 'watcher_report' ? (
        // 深度回传: 正文左侧三角 (▸/▾), 默认折叠单行行末省略, 点三角展开全文。
        <WatcherReportBody />
      ) : (
      <div
        className={cn(
          'wrap-anywhere min-w-0 max-w-full overflow-hidden text-pretty text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground',
          // 监控 = 偏黄, 深度研究 = 偏紫: 整卡带对应色调的淡底 (不只是左边框),
          // 与主 Assistant 的中性 --ui-bg-elevated 明显区分, 避免撞色。
          subRole === 'monitor' &&
            'rounded-lg border-l-2 border-(--ui-yellow) bg-(--ui-yellow)/8 py-2 pl-3 pr-3',
          subRole === 'router' &&
            'rounded-lg border-l-2 border-(--ui-purple) bg-(--ui-purple)/8 py-2 pl-3 pr-3',
          // ★ 普通主 Assistant 回复 (无 subRole): 浅中性底色卡片 (--ui-bg-elevated),
          //   比 user 气泡浅一档, 一眼区分, 且与紫色深度卡不混淆。运行中此路径只在
          //   hasVisibleText (正文已落地) 时到达; 完成态则承载正文 + 工具卡。卡内
          //   必有内容; empty:hidden 仅作兜底 (如仅 todo 工具被上抬后的空卡)。
          !subRole && 'rounded-lg bg-(--ui-bg-elevated) px-3 py-2 empty:hidden'
        )}
        data-slot="aui_assistant-message-content"
      >
        {/* 监控/router 头部行已移到卡片外 (见上); 此处只放正文。
           思考状态机 (CurrentActivityLine / StreamStallIndicator) 亦已移到卡外
           的 ThinkingBubble, 保持卡内只承载 message.parts 生成的正文/工具节点。 */}
        {/* Todos render in the composer status stack now, not inline. */}
        <MessagePrimitive.Parts components={MESSAGE_PARTS_COMPONENTS} />
        {previewTargets.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {previewTargets.map(target => (
              <PreviewAttachment key={target} source="explicit-link" target={target} />
            ))}
          </div>
        )}
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root
            className="mt-1.5 flex items-start gap-1.5 text-[0.78rem] leading-5 text-[color-mix(in_srgb,var(--dt-destructive)_78%,var(--ui-text-secondary))]"
            role="alert"
          >
            <ErrorPrimitive.Message className="min-w-0 flex-1" />
            {onDismissError && (
              <TooltipIconButton
                className="-my-0.5 shrink-0 text-current opacity-70 hover:opacity-100"
                onClick={() => onDismissError(messageId)}
                side="top"
                tooltip={t.assistant.thread.dismissError}
              >
                <XIcon className="size-3.5" />
              </TooltipIconButton>
            )}
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      )}
      {hasVisibleText && subRole !== 'watcher_report' && (
        <AssistantFooter getMessageText={getMessageText} messageId={messageId} onBranchInNewChat={onBranchInNewChat} />
      )}
      {/* ★ 工具历史折叠区: 正文落地后, 工具从卡内消失 (ToolGroupSlot 返回 null),
         转而以独立白框呈现在 footer 下方。在 body 列内, 自然和正文卡左对齐,
         但没有额外的头像/header。默认折叠一行 "N tool calls", 点击展开。 */}
      {!subRole && <ToolHistoryPanel />}
      </div>
    </MessagePrimitive.Root>
  )
}

const StatusRow: FC<{ children: ReactNode; label: string } & React.ComponentPropsWithoutRef<'div'>> = ({
  children,
  label,
  className,
  ...rest
}) => (
  <div
    aria-label={label}
    aria-live="polite"
    className={cn('flex w-full max-w-full items-center gap-1.5 self-start text-xs text-muted-foreground/70', className)}
    role="status"
    {...rest}
  >
    {children}
  </div>
)

// Fixed label while auto-compaction runs — decoupled from backend status text.
const COMPACTION_LABEL = 'Summarizing thread'

const CompactionHint: FC = () => (
  <span className="shimmer min-w-0 truncate text-muted-foreground/55">{COMPACTION_LABEL}</span>
)

const ResponseLoadingIndicator: FC = () => {
  const { t } = useI18n()
  const elapsed = useElapsedSeconds()
  const compacting = useStore($compactionActive)

  // ★ 事件驱动状态机 (与 web ThinkingLine 对齐):
  //   - 流开始 → "Waiting response…"
  //   - 3s 都还没任何 delta → 兜底切 "Thinking…" (覆盖闭源模型不透 reasoning 但
  //     内部真推理的场景, 如 GPT-5.6 Luna)。
  //   一旦第一个 reasoning / tool / message part 到达, AssistantMessage 挂上,
  //   CurrentActivityLine 接管 —— 本组件就消失。
  const [fallbackThinking, setFallbackThinking] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setFallbackThinking(true), 3000)
    return () => window.clearTimeout(timer)
  }, [])
  const thinkingLabel = fallbackThinking ? t.assistant.thread.thinking : 'Waiting response…'

  // ★ 与 AssistantMessage 的"纯思考态"行完全同款:【不显示头像 A】, 但保留头像列
  //   宽度的隐形占位 (size-7 + gap-2), 一行 💭 状态, 无头部行、无正文卡。首个 part
  //   落地 → 本组件卸载, AssistantMessage 接管同款一行, 零跳变。布局须与 thread.tsx
  //   里 aui_assistant-thinking-row 保持一致。
  return (
    <div
      aria-label={compacting ? COMPACTION_LABEL : t.assistant.thread.loadingResponse}
      aria-live="polite"
      className="group flex w-full min-w-0 max-w-full flex-row items-center gap-2 self-start overflow-hidden"
      data-slot="aui_response-loading"
      role="status"
    >
      {/* 隐形头像占位: 与 AssistantMessage 的 MessageAvatar (size-7 + gap-2) 同宽,
          让 "Thinking/Waiting" 行 body 与 "You"/正文卡左缘对齐。 */}
      <div aria-hidden className="size-7 shrink-0" />
      <StatusRow label="">
        {compacting ? (
          <CompactionHint />
        ) : (
          <>
            <span className="animate-pulse">💭</span>
            <span className="shimmer min-w-0 truncate text-muted-foreground/70">{thinkingLabel}</span>
          </>
        )}
        <ActivityTimerText className="ml-auto" seconds={elapsed} />
      </StatusRow>
    </div>
  )
}

// Parked-background affordance: a top-level delegate_task runs in the
// background, so the parent turn ends and the app goes idle while the subagent
// keeps working and its result re-enters as a fresh turn later. Instead of a
// spinner (reads as "stuck"), reuse the same compact, centered system-note
// chrome as the steer / slash-status lines (SystemMessage above) so it sits in
// the thread like every other meta line. Idle-only (gated upstream). Null when
// nothing is parked.
const BackgroundResumeNotice: FC = () => {
  const { t } = useI18n()
  const resume = useStore($backgroundResume)

  if (!resume) {
    return null
  }

  const label = resume.activity ?? t.assistant.thread.resumeWhenBackgroundDone(resume.count)

  return (
    <div
      aria-live="polite"
      className="flex max-w-[min(86%,44rem)] items-center gap-1.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/55"
      data-slot="aui_background-resume"
      role="status"
    >
      <Codicon className="text-muted-foreground/55" name="sync" size="0.75rem" />
      <span className="shimmer min-w-0 truncate">{label}</span>
    </div>
  )
}

// Seconds of no visible output (text or part count) before a still-running turn
// is treated as stalled and the thinking indicator returns at the tail.
const STREAM_STALL_S = 2

// Tail "still thinking" indicator: the pre-first-token spinner goes away once
// text flows, but if the stream then goes quiet mid-turn (tool think-time,
// provider stall) nothing signals that work continues. Watch a per-flush
// activity signal; when it hasn't changed for STREAM_STALL_S, re-show the
// dither + a timer counting from the last activity.
//
// Subscribes to the activity signal ITSELF (rather than taking it as a prop)
// so that per-token updates re-render only this leaf, not the whole
// AssistantMessage subtree.
const StreamStallIndicator: FC = () => {
  const activity = useAuiState(s => {
    let textLength = 0

    for (const part of s.message.content) {
      const text = (part as { text?: unknown }).text

      if (typeof text === 'string') {
        textLength += text.length
      }
    }

    return `${s.message.content.length}:${textLength}`
  })

  const [stalled, setStalled] = useState(false)
  const compacting = useStore($compactionActive)
  const { t } = useI18n()
  // A pending clarify / approval / sudo / secret means the turn is paused on the
  // user, not working — so don't resurrect the "thinking" timer while they
  // decide (matches the pet's awaitingInput pose taking priority over busy).
  const awaitingInput = useStore($activeSessionAwaitingInput)

  useEffect(() => {
    setStalled(false)
    const id = window.setTimeout(() => setStalled(true), STREAM_STALL_S * 1000)

    return () => window.clearTimeout(id)
  }, [activity])

  const active = (stalled || compacting) && !awaitingInput
  const elapsed = useElapsedSeconds(active)

  if (!active) {
    return null
  }

  return (
    <StatusRow
      className="mt-1.5"
      data-slot="aui_stream-stall"
      label={compacting ? COMPACTION_LABEL : 'Argus is thinking'}
    >
      {compacting ? (
        <CompactionHint />
      ) : (
        <>
          <span className="animate-pulse">💭</span>
          <span className="shimmer min-w-0 truncate text-muted-foreground/70">{t.assistant.thread.thinking}</span>
        </>
      )}
      <ActivityTimerText className="ml-auto" seconds={elapsed} />
    </StatusRow>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// CurrentActivityLine — Claude Code 风格的"当前动作"心跳行。
//
// 目标: 用户提问后, 与其展示一个默认展开、又大又空的"💭 思考过程" 折叠块,
//   不如仿照 Claude Code CLI 那样在一行里持续告诉用户: agent 现在在干什么、
//   干了多久。encrypted reasoning 场景下也不再露"空黑框", 而是一句
//   "✷ Thinking… 3s" 的脉冲行。
//
// 从 useAuiState 里读【消息 parts 数组的末尾一项】, 派生成一句人话:
//   * tool-call part  -> "✷ Reading /path/to/file"、"✷ Running: git status"…
//   * reasoning part  -> "✷ <reasoning 首行>"
//   * 其它 (纯文本刚开始 / 空 parts) -> "✷ Thinking"
//
// 只订阅【小体积派生字符串】(activityKey), 避免每次 token flush 都触发这个组件
// re-render (parts 数组本身在流式过程中身份会变, 但 activityKey 只在"动作切换"
// 时才变)。计时器复用 ActivityTimerText + useElapsedSeconds, timerKey 按消息id
// 稳定, 不会因 activity 切换而重置总时长。
const _MAX_ACTIVITY_LEN = 80

function _truncate(s: string, max = _MAX_ACTIVITY_LEN): string {
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

function _pickToolLabel(toolName: string, args: unknown): string {
  // 只提取一个字段作为一句话摘要, 不调 buildToolView (那是完整视图, 每次 flush
  // 都跑正则/JSON 解析太贵)。字段挑选参考 tool-fallback-model.ts 里各工具用的
  // 主参数名, 覆盖读文件/终端/浏览器/搜索这几大类, 其它工具回退到 toolName 本身。
  const a = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  // 路径类
  const p = str(a.path) || str(a.file_path) || str(a.filepath) || str(a.filename)
  if (p) {
    if (toolName === 'read_file' || toolName === 'view_file') return `Reading ${p}`
    if (toolName === 'edit_file' || toolName === 'str_replace_editor'
        || toolName === 'apply_patch' || toolName === 'write_file') return `Editing ${p}`
    return `${toolName} ${p}`
  }
  // Shell / code
  const cmd = str(a.command) || str(a.code)
  if (cmd) return `Running: ${_truncate(cmd, 60)}`
  // 搜索类
  const q = str(a.query) || str(a.pattern) || str(a.q)

  if (q) {
    // query_multimodal may inspect current frames, recall buffered evidence,
    // or hand the answer to QueryWorker. Calling every one of those paths a
    // web-style "Search" made a healthy visual dispatch look like the wrong
    // tool was running.
    if (toolName === 'query_multimodal') {
      return `QueryWorker: ${_truncate(q, 60)}`
    }

    return `Searching: ${_truncate(q, 60)}`
  }
  // 浏览器导航
  const u = str(a.url)
  if (u) return `Opening ${u}`
  // 兜底: 直接用工具名
  return toolName
}

// activitySnapshot: 从 parts 末尾派生【一句显示标签】+ 一个稳定 kind 判据。
// 返回一个 [label, kind] 元组的编码字符串, 让 useAuiState 内部做 identity 比对
// 只在真正变化时触发 re-render。返回 '' 表示"不显示这一行"(正文已开始 / 无 parts)。
//
// 直接返回 string 而不是 object: useAuiState 的默认比较是 Object.is, 每次新对象
// 都会触发 re-render, 用 primitive string 才能保证 token flush 不重渲。
function _computeActivityLabel(parts: readonly unknown[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as { type?: string; toolName?: string; args?: unknown; text?: string } | null
    if (!p) continue
    if (p.type === 'tool-call' && typeof p.toolName === 'string') {
      return _truncate(_pickToolLabel(p.toolName, p.args))
    }
    if (p.type === 'reasoning' && typeof p.text === 'string') {
      // 思维链摘要: 取【最新一行】(reasoning 流式增长, 末行 = 当前进展/最新摘要),
      // 让 thinking 区域"及时"反映最新思考, 而不是恒定停在第一行。截断到
      // _MAX_ACTIVITY_LEN 控制单行长度与重渲频率 (行内每 token 变一次, 换行后
      // 跳到新行; 仅这一个轻量 leaf 重渲, 可接受)。
      const lines = p.text.trimEnd().split('\n')
      let latest = ''
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j].trim()
        if (line) {
          latest = line
          break
        }
      }
      return latest ? _truncate(latest) : 'Thinking'
    }
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) {
      // 正文已开始流出 -> 不显示当前动作行。
      return ''
    }
  }
  return 'Thinking'
}

const CurrentActivityLine: FC = () => {
  const label = useAuiState(s => _computeActivityLabel(s.message.parts as readonly unknown[]))
  const messageId = useAuiState(s => s.message.id)
  const awaitingInput = useStore($activeSessionAwaitingInput)

  const active = Boolean(label) && !awaitingInput
  // 计时器 key 绑消息 id: 换消息才重置; 消息内 activity 切换不重置总时长。
  const elapsed = useElapsedSeconds(active, `activity:${messageId}`)

  if (!active) {
    return null
  }

  return (
    <StatusRow
      className="mb-1"
      data-slot="aui_current-activity"
      label={`Current activity: ${label}`}
    >
      <span className="animate-pulse">💭</span>
      <span className="shimmer min-w-0 truncate text-muted-foreground/70">{label}</span>
      <ActivityTimerText className="ml-auto" seconds={elapsed} />
    </StatusRow>
  )
}

// ThinkingBubble — 正文卡【上方】的一行思考状态指示 (isRunning 时挂上)。
// 内容: CurrentActivityLine (parts 尾项派生的当前动作) + StreamStallIndicator
//        (无 delta 停顿 STREAM_STALL_S 后的"仍在思考"兜底)。
// ★ 关键: 这里【不是】一个带背景色的气泡框 —— "思考气泡"指的是 💭 脉冲动效,
//   不是 CSS 卡片。之前误加了 rounded + bg-(--ui-bg-elevated)/60 + w-fit, 结果
//   (1) 底色与正文卡相同又贴在一起, 看着像"融进正文气泡里"; (2) w-fit 让框宽度
//   随 label 长短 (Waiting→✷ Reading /very/long/path) 抖动。现改回纯文本行:
//   无背景、无 padding, 只有 💭 + shimmer label + 计时器, 一眼就是正文卡"上方"
//   一行, 且宽度变化不可见 (无框, 只是文字变长)。与 web 端 ThinkingLine 对齐。
const ThinkingBubble: FC = () => (
  <div className="flex flex-col gap-0 self-start empty:hidden" data-slot="aui_thinking-bubble">
    <CurrentActivityLine />
    <StreamStallIndicator />
  </div>
)

// CompletedReasoningPanel — 完成态下, 从 message.parts 里聚合所有 reasoning
// 部件 (跨 interleaved 出现的多个 reasoning group), 用【一整个】可折叠
// ThinkingDisclosure 渲染在正文卡外。这样 [reasoning, tool, text, reasoning,
// tool, text] 交错也只显示一块 "Thinking", 不再跟工具卡/正文交织 —— 这正是
// 用户原始 concern "interleaved thinking 展示异常"的完成态复现路径。
//
// 使用 selector 派生【拼接后的 reasoning 文本】(string, 稳定比对) 作为唯一
// 订阅, 避免每次 parts 数组身份变更就 re-render (与 CurrentActivityLine 的
// 一致做法)。多段 reasoning 用两次换行分段, 阅读时保留跨段停顿感。
const _REASONING_SEP = '\n\n───\n\n'

const CompletedReasoningPanel: FC = () => {
  const messageId = useAuiState(s => s.message.id)
  const reasoningText = useAuiState(s => {
    const segments: string[] = []
    for (const part of s.message.parts) {
      const p = part as { type?: string; text?: unknown } | null
      if (p?.type === 'reasoning' && typeof p.text === 'string') {
        const trimmed = p.text.trim()
        if (trimmed) segments.push(trimmed)
      }
    }
    return segments.join(_REASONING_SEP)
  })

  if (!reasoningText) {
    return null
  }

  return (
    <ThinkingDisclosure timerKey={`reasoning:${messageId}`}>
      <MarkdownTextContent
        containerClassName="text-xs leading-snug text-muted-foreground/85"
        containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
        isRunning={false}
        text={reasoningText}
      />
    </ThinkingDisclosure>
  )
}

// ToolHistoryPanel — 完成态 + 有正文时, 从 message.parts 里聚合所有
// tool-call 部件, 折叠在正文卡 **下方** 的一个独立无头区块里 (默认折叠)。
// 这样正文是主角, 工具历史不占视觉空间却随时可展开回看。
// 结构上平行于 CompletedReasoningPanel (只是一个管 reasoning, 一个管 tools)。
//
// ⚠ 渲染稳定性: useAuiState selector 只返回 primitive (number) 以避免 Object.is
// 对新数组引用判定不等 → 无限 re-render。完整 content 仅在展开 (open) 时通过
// runtime.getState() 同步读取, 不走订阅。
export const ToolHistoryPanel: FC = () => {
  const { t } = useI18n()
  const hasVisibleText = useAuiState(selectMessageHasVisibleText)
  // Stable primitive: only changes when tool-call count actually changes.
  const toolCount = useAuiState(s => {
    let count = 0

    for (const part of s.message.parts) {
      if ((part as { type?: string } | null)?.type === 'tool-call') {
        count++
      }
    }

    return count
  })

  const runtime = useMessageRuntime()

  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? false // default collapsed

  if (!hasVisibleText || toolCount === 0) {
    return null
  }

  // Extract full tool parts only when expanded — avoids array allocation cost
  // when collapsed, and sidesteps the useAuiState identity problem entirely.
  const toolParts: Array<ToolCallMessagePartProps & { argsFields?: unknown }> = []

  if (open) {
    const state = runtime.getState()

    for (const part of state.content) {
      if (part.type !== 'tool-call') {
        continue
      }

      const partRuntime = runtime.getMessagePartByToolCallId(part.toolCallId)
      const partState = partRuntime.getState()
      if (partState.type !== 'tool-call') {
        continue
      }

      // Rebuild the exact renderer props from the live part runtime. This keeps
      // status/addResult/resume and the private argsFields sidecar intact, then
      // runs the same specialised dispatcher used while the turn is streaming
      // (QueryWorker trajectory, image generation, clarify, etc.).
      toolParts.push({
        ...partState,
        ...('argsFields' in part ? { argsFields: part.argsFields } : {}),
        addResult: result => partRuntime.addToolResult(result),
        resume: payload => partRuntime.resumeToolCall(payload)
      })
    }
  }

  return (
    <div
      className="w-full min-w-0 max-w-full rounded-lg bg-(--ui-bg-elevated) px-3 py-2 text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)"
      data-slot="aui_tool-history-panel"
    >
      <DisclosureRow onToggle={() => setUserOpen(!open)} open={open}>
        <span className="text-[length:var(--conversation-tool-font-size)] font-medium leading-(--conversation-line-height) text-(--ui-text-secondary)">
          {t.assistant.thread.toolHistory(toolCount)}
        </span>
      </DisclosureRow>
      {open && (
        <div className="mt-1 grid min-w-0 max-w-full gap-(--tool-row-gap) overflow-hidden">
          {toolParts.map(part => (
            <ChainToolFallback
              key={part.toolCallId || part.toolName}
              {...part}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const ImageGenerateTool: FC<ToolCallMessagePartProps> = ({ args, result }) => {
  const aspectRatio = typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : undefined

  return (
    <div className="mt-1.5">
      <GeneratedImage aspectRatio={aspectRatio} result={result} />
    </div>
  )
}

function queryWorkerResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as unknown

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** The ordinary tool card remains the durable receipt. The runtime-only panel
 * below it mirrors Web's QueryWorker progress inspector and is populated from
 * the redacted trajectory sidechannel, never from model-facing history. */
export function selectQueryWorkerToolEntries(
  trajectory: MmTrajectoryEntry[],
  taskId: string,
  toolCallId: string
): MmTrajectoryEntry[] {
  if (!taskId) {
    return []
  }

  const selected = new Map<string, MmTrajectoryEntry>()

  for (const entry of trajectory) {
    const entryTaskId = queryWorkerTaskId(entry)
    const payloadToolId = typeof entry.payload.tool_id === 'string' ? entry.payload.tool_id : ''

    if (entryTaskId === taskId || (payloadToolId && payloadToolId === toolCallId)) {
      selected.set(entry.id, entry)
    }
  }

  return [...selected.values()].sort((a, b) => a.seq - b.seq || a.ts - b.ts)
}

export const QueryMultimodalTool: FC<ToolCallMessagePartProps> = props => {
  const result = queryWorkerResult(props.result)
  const taskId = typeof result.task_id === 'string' ? result.task_id.trim() : ''
  const trajectoryStore = useMemo(() => queryTrajectoryTaskStore(taskId), [taskId])
  const trajectory = useStore(trajectoryStore)

  const entries = useMemo(
    () => selectQueryWorkerToolEntries(trajectory, taskId, props.toolCallId),
    [props.toolCallId, taskId, trajectory]
  )

  return (
    <div className="space-y-2">
      <ToolFallback {...props} />
      {taskId && entries.length > 0 && <QueryWorkerTrajectoryPanel entries={entries} />}
      {taskId && entries.length === 0 && (
        <div
          className="rounded border border-cyan-400/25 bg-cyan-400/5 px-2 py-1.5 text-[0.6875rem] text-cyan-200"
          data-testid="query-worker-trajectory-waiting"
        >
          <span className="mr-1.5 inline-block animate-spin">◌</span>
          等待 QueryWorker 第一条结构化轨迹…
        </div>
      )}
    </div>
  )
}

const ChainToolFallback: FC<ToolCallMessagePartProps> = props => {
  // todo parts are hoisted to a dedicated panel above the message content.
  if (props.toolName === 'todo') {
    return null
  }

  if (props.toolName === 'image_generate') {
    return <ImageGenerateTool {...props} />
  }

  if (props.toolName === 'clarify') {
    return <ClarifyTool {...props} />
  }

  if (props.toolName === 'query_multimodal') {
    return <QueryMultimodalTool {...props} />
  }

  return <ToolFallback {...props} />
}

const ThinkingDisclosure: FC<{
  children: ReactNode
  messageRunning?: boolean
  pending?: boolean
  timerKey?: string
}> = ({ children, messageRunning = false, pending = false, timerKey }) => {
  const { t } = useI18n()
  // `null` = no explicit user toggle yet, defer to the streaming default.
  // The default is "auto-open while streaming, auto-collapse when done" so
  // reasoning surfaces a live preview without manual interaction. The first
  // explicit toggle wins from then on.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const elapsed = useElapsedSeconds(pending, timerKey)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const enterRef = useEnterAnimation(messageRunning, timerKey)

  const open = userOpen ?? pending
  const isPreview = pending && userOpen === null

  // While the preview is live, pin the scroll container to the bottom on
  // every content growth so the latest tokens are always visible. Combined
  // with the top mask in styles.css, this reads as text settling in from
  // below while older lines fade out at the top.
  useEffect(() => {
    if (!isPreview) {
      return
    }

    const el = scrollRef.current
    const content = contentRef.current

    if (!el || !content) {
      return
    }

    const pin = () => {
      el.scrollTop = el.scrollHeight
    }

    pin()
    const observer = new ResizeObserver(pin)
    observer.observe(content)

    return () => observer.disconnect()
    // Re-run when the disclosure toggles so the observer attaches to the new
    // DOM after expand/collapse (refs are conditionally rendered on `open`).
  }, [isPreview, open])

  return (
    <div
      className="text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)"
      data-slot="aui_thinking-disclosure"
      ref={enterRef}
    >
      <DisclosureRow onToggle={() => setUserOpen(!open)} open={open}>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={cn(
              'text-[length:var(--conversation-tool-font-size)] font-medium leading-(--conversation-line-height) text-(--ui-text-secondary)',
              pending && 'shimmer text-foreground/55'
            )}
          >
            {t.assistant.thread.thinking}
          </span>
          {pending && (
            <ActivityTimerText
              className="text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)"
              seconds={elapsed}
            />
          )}
        </span>
      </DisclosureRow>
      {open && (
        <div
          className={cn(
            // Body sits flush with the "Thinking" header — no left indent —
            // and inherits the disclosure-level opacity fade defined in
            // styles.css (~0.67 at rest, 1 on hover/focus).
            'mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1',
            isPreview && 'thinking-preview max-h-40'
          )}
          ref={scrollRef}
        >
          <div ref={contentRef}>{children}</div>
        </div>
      )}
    </div>
  )
}

// ★ ReasoningGroup slot 全程 return null: reasoning 的 UI 表达完全交给
//   AssistantMessage 层的 ThinkingBubble (流式期) / CompletedReasoningPanel
//   (完成后) —— 都是"卡外一整块", 不再随 message.parts 顺序内嵌到正文卡里,
//   彻底避开 interleaved thinking (reasoning ↔ tool_call ↔ text 交错) 在完成态
//   把多个 "Thinking" 折叠块散布进 tool card / 正文之间的显示异常。
const ReasoningAccordionGroup: FC<{ children?: ReactNode; endIndex: number; startIndex: number }> = () => null

const ReasoningTextPart: FC<{ text: string; status?: { type: string } }> = ({ text, status }) => {
  const displayText = text.trimStart()
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')
  const isRunning = status?.type === 'running' || messageRunning

  return (
    <MarkdownTextContent
      containerClassName="text-xs leading-snug text-muted-foreground/85"
      containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
      isRunning={isRunning}
      text={displayText}
    />
  )
}

// Module-level constant so the `components` prop on `MessagePrimitive.Parts`
// has a stable identity across renders. Without this every AssistantMessage
// render would create a fresh `components` object, invalidating the memo on
// `MessagePrimitivePartByIndex` and forcing every tool/reasoning child to
// re-render on every streaming delta. Memo invalidation alone doesn't
// remount, but combined with the previous ToolFallback group-swap it was a
// big chunk of the per-delta work.
const MESSAGE_PARTS_COMPONENTS = {
  Reasoning: ReasoningTextPart,
  ReasoningGroup: ReasoningAccordionGroup,
  Text: MarkdownText,
  ToolGroup: ToolGroupSlot,
  tools: { Fallback: ChainToolFallback }
} as const

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short'
})

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function formatMessageTimestamp(
  value: Date | string | number | undefined,
  labels: { today: (time: string) => string; yesterday: (time: string) => string }
): string {
  if (!value) {
    return ''
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)

  if (dayDelta === 0) {
    return labels.today(TIME_FMT.format(date))
  }

  if (dayDelta === 1) {
    return labels.yesterday(TIME_FMT.format(date))
  }

  return SHORT_FMT.format(date)
}

const AssistantActionBar: FC<MessageActionProps> = ({ messageId, getMessageText, onBranchInNewChat }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="relative flex shrink-0 justify-end">
      <ActionBarPrimitive.Root
        className={cn(
          // NOTE: intentionally NOT `hideWhenRunning`. That prop unmounts the
          // bar while the thread streams, which shifts layout when the turn
          // resolves. It's invisible by default (opacity-0 + pointer-events-none,
          // reveals on hover), so keeping it mounted keeps layout stable.
          // Lives inline in the header row now — no vertical padding, sits at
          // text height, hover-reveals in place at the row's right edge.
          'relative flex flex-row items-center justify-end gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
          menuOpen && 'pointer-events-auto opacity-100 [&_button]:opacity-100'
        )}
        data-slot="aui_msg-actions"
      >
        <CopyButton appearance="icon" buttonSize="icon" label={copy.copy} text={getMessageText} />
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton onClick={() => triggerHaptic('submit')} tooltip={copy.refresh}>
            <Codicon name="refresh" />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
        <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip={copy.moreActions}>
              <Codicon name="ellipsis" />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={e => e.preventDefault()} sideOffset={6}>
            <MessageTimestamp />
            <DropdownMenuItem onSelect={() => onBranchInNewChat?.(messageId)}>
              <GitBranchIcon />
              {copy.branchNewChat}
            </DropdownMenuItem>
            <ReadAloudItem getText={getMessageText} messageId={messageId} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ActionBarPrimitive.Root>
    </div>
  )
}

const ReadAloudItem: FC<{ getText: () => string; messageId: string }> = ({ getText, messageId }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const voicePlayback = useStore($voicePlayback)

  const readAloudStatus =
    voicePlayback.source === 'read-aloud' && voicePlayback.messageId === messageId ? voicePlayback.status : 'idle'

  const isPreparing = readAloudStatus === 'preparing'
  const isSpeaking = readAloudStatus === 'speaking'
  const anyPlaybackActive = voicePlayback.status !== 'idle'
  const Icon = isPreparing ? Loader2Icon : isSpeaking ? VolumeXIcon : Volume2Icon

  const read = useCallback(async () => {
    const text = getText()

    if (!text || $voicePlayback.get().status !== 'idle') {
      return
    }

    try {
      await playSpeechText(text, { messageId, source: 'read-aloud' })
    } catch (error) {
      notifyError(error, copy.readAloudFailed)
    }
  }, [copy.readAloudFailed, getText, messageId])

  return (
    <DropdownMenuItem
      disabled={isPreparing || (!isSpeaking && anyPlaybackActive)}
      onSelect={e => {
        e.preventDefault()
        void (isSpeaking ? stopVoicePlayback() : read())
      }}
    >
      <Icon className={isPreparing ? 'animate-spin' : undefined} />
      {isPreparing ? copy.preparingAudio : isSpeaking ? copy.stopReading : copy.readAloud}
    </DropdownMenuItem>
  )
}

const MessageTimestamp: FC = () => {
  const { t } = useI18n()
  const createdAt = useAuiState(s => s.message.createdAt)
  const label = formatMessageTimestamp(createdAt, t.assistant.thread)

  if (!label) {
    return null
  }

  return <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{label}</DropdownMenuLabel>
}

// Footer now only carries the branch picker (hidden when single branch). The
// Copy / Reload / More action bar moved up into the header row (right-aligned),
// so a completed reply no longer reserves an extra footer row below the prose.
const AssistantFooter: FC<MessageActionProps> = () => (
  <div className="flex flex-col items-end gap-1 pr-(--message-text-indent) pl-(--message-text-indent) empty:hidden">
    {/* empty:hidden + no min-height: with a single branch the picker renders
        nothing, so this row collapses to 0 instead of reserving space. */}
    <BranchPickerPrimitive.Root
      className="inline-flex h-6 items-center gap-1 text-xs text-muted-foreground"
      hideWhenSingleBranch
    >
      <BranchPickerPrimitive.Previous className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-35">
        <Codicon name="chevron-left" size="0.875rem" />
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-35">
        <Codicon name="chevron-right" size="0.875rem" />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  </div>
)

const EMPTY_ATTACHMENT_REFS: string[] = []

function messageAttachmentRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return EMPTY_ATTACHMENT_REFS
  }

  return value.every(ref => typeof ref === 'string') ? value : EMPTY_ATTACHMENT_REFS
}

function StickyHumanMessageContainer({
  attachments,
  children,
  messageId
}: {
  attachments?: ReactNode
  children: ReactNode
  messageId?: string
}) {
  return (
    // Fragment, not a wrapper: a wrapping element becomes the sticky's
    // containing block (it'd stick within its own height = never). The bubble
    // and attachments are flow siblings so the bubble pins against the scroller
    // while attachments below it scroll away.
    <>
      <div
        className="group/user-message sticky z-40 -mx-4 flex w-[calc(100%+2rem)] min-w-0 max-w-none flex-col items-stretch gap-0 self-start overflow-visible bg-(--ui-chat-surface-background) px-4 pb-(--conversation-turn-gap) pt-1"
        data-message-id={messageId}
        data-role="user"
        data-slot="aui_user-message-root"
      >
        {children}
      </div>
      {attachments}
    </>
  )
}

// Shared "user bubble" base. Both the read-only message and the inline
// edit composer render the same bubble surface (rounded glass card);
// they only differ in border weight, cursor, and padding-right (the
// read-only view reserves room for the restore icon).
//
// no-drag: sticky bubbles park at --sticky-human-top (~4px), sliding under the
// titlebar's [-webkit-app-region:drag] strips (app-shell.tsx). Electron resolves
// drag regions at the compositor level — z-index and pointer-events don't help —
// so without the carve-out, clicking a stuck bubble drags the window instead of
// opening the edit composer.
const USER_BUBBLE_BASE_CLASS =
  'composer-human-message standalone-glass relative flex w-full min-w-0 max-w-full flex-col gap-1.5 overflow-y-auto rounded-xl border bg-(--dt-user-bubble) px-3 py-2 text-left [-webkit-app-region:no-drag]'

const USER_ACTION_ICON_BUTTON_CLASS =
  'grid place-items-center rounded-md bg-transparent text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground disabled:cursor-default disabled:text-(--ui-text-quaternary) disabled:opacity-70'

const USER_ACTION_ICON_SIZE = '0.6875rem'
const StopGlyph = <StopFilled aria-hidden className="size-3.5 -translate-y-px" />

// Background-process notifications are injected into the conversation as user
// messages (the agent must react to them, and message-role alternation forbids
// a synthetic system row mid-loop). They are NOT something the human typed, so
// render them as a compact system-style notice instead of a user bubble.
// Shape: see tools/process_registry.py format_process_notification().
const PROCESS_NOTIFICATION_RE = /^\[IMPORTANT: Background process [\s\S]*\]$/

const ProcessNotificationNote: FC<{ text: string }> = ({ text }) => {
  const body = text.replace(/^\[IMPORTANT:\s*/, '').replace(/\]$/, '')
  const newline = body.indexOf('\n')
  const headline = (newline === -1 ? body : body.slice(0, newline)).trim()
  const detail = newline === -1 ? '' : body.slice(newline + 1).trim()

  return (
    <div className="flex max-w-[min(86%,44rem)] flex-col gap-0.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60">
      <span className="flex items-center gap-1.5">
        <Codicon className="shrink-0 text-muted-foreground/55" name="terminal" size="0.75rem" />
        <span className="wrap-anywhere">{headline}</span>
      </span>
      {detail && (
        <details className="pl-[1.3125rem]">
          <summary className="cursor-pointer select-none text-muted-foreground/45 hover:text-muted-foreground/70">
            output
          </summary>
          <pre
            className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[0.625rem] leading-4 text-muted-foreground/55"
            data-selectable-text="true"
          >
            {detail}
          </pre>
        </details>
      )}
    </div>
  )
}

const UserMessage: FC<{
  onCancel?: () => Promise<void> | void
  onRequestRestoreConfirm?: (messageId: string, target: RestoreMessageTarget) => void
}> = ({ onCancel, onRequestRestoreConfirm }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const messageId = useAuiState(s => s.message.id)
  const content = useAuiState(s => s.message.content)
  const messageText = messageContentText(content)
  const threadRunning = useAuiState(s => s.thread.isRunning)
  const messageCreatedAt = useAuiState(s => s.message.createdAt)

  const latestUserId = useAuiState(s => {
    for (let i = s.thread.messages.length - 1; i >= 0; i--) {
      const message = s.thread.messages[i] as { id?: string; role?: string }

      if (message.role === 'user') {
        return message.id ?? null
      }
    }

    return null
  })

  const runtimeUserOrdinal = useAuiState(s => {
    let ordinal = 0

    for (const message of s.thread.messages) {
      if (message.role !== 'user') {
        continue
      }

      if (message.id === s.message.id) {
        return ordinal
      }

      ordinal += 1
    }

    return null
  })

  const attachmentRefs = useAuiState(s => {
    const custom = (s.message.metadata?.custom ?? {}) as { attachmentRefs?: unknown }

    return messageAttachmentRefs(custom.attachmentRefs)
  })

  // Sticky human bubbles clamp to ~2 lines with a soft fade so a long prompt
  // doesn't dominate the viewport while the response streams underneath; the
  // clamp lifts on hover / focus (see styles.css). We measure the *unclamped*
  // inner wrapper so the ResizeObserver only fires on real content / width
  // changes, not on every frame while the outer max-height animates open.
  const clampInnerRef = useRef<HTMLDivElement | null>(null)
  const [bodyClamped, setBodyClamped] = useState(false)
  const lastClampHeightRef = useRef(-1)
  const lineHeightRef = useRef(0)
  // ★ 拖窗口时 resize 门控: 100+ user bubble 各自的 measureClamp 在拖动每 tick 都
  //   fire → 100+ setState 涌上 = 内容跟不上"缓好久"。拖动期只缓存新 height 不
  //   setState; 停手 (windowResize settle) 后一次性 flush 最后一次的值。见
  //   [[../store/window-resize.ts]] 的 SETTLE_MS。
  const pendingClampHeightRef = useRef<number | null>(null)

  const measureClamp = useCallback((entries: readonly ResizeObserverEntry[]) => {
    const inner = clampInnerRef.current
    const outer = inner?.parentElement

    if (!inner || !outer) {
      return
    }

    // Prefer the size the ResizeObserver already computed — reading
    // `scrollHeight` outside RO timing forces a synchronous layout, and with
    // many user bubbles observed at once those reads interleave with the
    // style write below into a read-write-read reflow cascade.
    const entryHeight = entries.find(entry => entry.target === inner)?.borderBoxSize?.[0]?.blockSize
    const fullHeight = Math.ceil(entryHeight ?? inner.scrollHeight)

    if (fullHeight === lastClampHeightRef.current) {
      return
    }

    // ★ 窗口正在 resize: 只缓存, 不 setState/写 style。settle useEffect (见下) 会 flush。
    if ($isWindowResizing.get()) {
      pendingClampHeightRef.current = fullHeight
      return
    }

    lastClampHeightRef.current = fullHeight

    // Line-height is stable for the life of the bubble (font settings don't
    // change under it) — resolve the computed style once.
    if (!lineHeightRef.current) {
      const styles = getComputedStyle(inner)
      lineHeightRef.current = parseFloat(styles.lineHeight) || 1.5 * parseFloat(styles.fontSize) || 20
    }

    outer.style.setProperty('--human-msg-full', `${fullHeight}px`)
    setBodyClamped(fullHeight > lineHeightRef.current * 2 + 1)
  }, [])

  // ★ 窗口 settle 时 flush 最新 pending 尺寸 (每 user bubble 独立跑, 但 settle 只发生
  //   一次 → 一批 flush 集中发生, React 会 batch 掉多个 setState 到同一次渲染)。
  useEffect(() => {
    const unsub = $isWindowResizing.subscribe(resizing => {
      if (resizing) return
      const pending = pendingClampHeightRef.current
      if (pending == null) return
      pendingClampHeightRef.current = null
      const inner = clampInnerRef.current
      const outer = inner?.parentElement
      if (!inner || !outer) return
      lastClampHeightRef.current = pending
      if (!lineHeightRef.current) {
        const styles = getComputedStyle(inner)
        lineHeightRef.current = parseFloat(styles.lineHeight) || 1.5 * parseFloat(styles.fontSize) || 20
      }
      outer.style.setProperty('--human-msg-full', `${pending}px`)
      setBodyClamped(pending > lineHeightRef.current * 2 + 1)
    })
    return unsub
  }, [])

  useResizeObserver(measureClamp, clampInnerRef)

  // Injected background-process notification, not a human prompt — render the
  // compact system-style notice (after all hooks above have run).
  if (PROCESS_NOTIFICATION_RE.test(messageText.trim())) {
    return (
      <MessagePrimitive.Root
        className="flex w-full min-w-0 flex-col items-stretch"
        data-role="user"
        data-slot="aui_user-message-root"
      >
        <ProcessNotificationNote text={messageText.trim()} />
      </MessagePrimitive.Root>
    )
  }

  const hasBody = messageText.trim().length > 0
  const isLatestUser = messageId === latestUserId
  const showStop = isLatestUser && threadRunning && Boolean(onCancel)
  // Restore (re-run this exact prompt) is available everywhere the Stop button
  // isn't — including mid-stream on older prompts, since the action interrupts
  // the live turn before rewinding.
  const showRestore = !showStop && Boolean(onRequestRestoreConfirm) && hasBody

  // user 气泡与 Assistant 正文卡片完全一致: 圆角 + 浅中性底色 (--ui-bg-elevated),
  // 只读, 不可编辑 (无 hover 变色 / 无编辑光标 / 无内联编辑器)。
  const bubbleClassName = cn(
    'composer-human-message relative flex w-full min-w-0 max-w-full flex-col gap-1.5 rounded-lg bg-(--ui-bg-elevated) px-3 py-2 text-left [-webkit-app-region:no-drag]',
    'text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground'
  )

  const bubbleContent = hasBody && (
    // Render the user's text through a minimal markdown pipeline:
    // backtick `code` and ``` fenced ``` blocks, with directive chips
    // (`@file:` etc.) still resolved inside the plain-text spans.
    <div className="sticky-human-clamp" data-clamped={bodyClamped ? 'true' : undefined}>
      {/* Match the edit composer's collapsed line box (min-h-[1.25rem]) so
          clicking to edit can't grow the bubble by a sub-pixel and reflow the
          turn 1px. */}
      <div className="min-h-[1.25rem]" ref={clampInnerRef}>
        <UserMessageText className="wrap-anywhere" text={messageText} />
      </div>
    </div>
  )

  return (
    <MessagePrimitive.Root asChild>
      <StickyHumanMessageContainer
        attachments={
          // Attachments live BELOW the sticky bubble in normal flow, so they
          // scroll away behind the pinned bubble instead of riding along with
          // it. Image refs render as thumbnails, file refs as chips; no border.
          attachmentRefs.length > 0 ? (
            <div className="flex flex-wrap gap-1 -mt-3 mb-2">
              <DirectiveContent text={attachmentRefs.join(' ')} />
            </div>
          ) : null
        }
        messageId={messageId}
      >
        <ActionBarPrimitive.Root className="relative w-full max-w-full" data-slot="aui_user-bubble-actions">
          {/* 与 Assistant 一致的布局: 左侧头像列 + body 列, 使 You 与 Assistant 的
             发言块左缘对齐。 */}
          <div className="human-message-with-todos-wrapper flex w-full flex-row gap-2">
            <MessageAvatar role="user" />
            <div className="flex min-w-0 flex-1 flex-col gap-0">
            {/* Web 风格头部行 (左对齐, 与 Assistant 一致): "You" + 时间。
               Stop / Restore 挪到本行右侧 (ml-auto), 不再叠在气泡右下角。
               hover 显隐仍靠 MessagePrimitive.Root 的 group/user-message。 */}
            <div className="mb-1 flex items-center gap-1.5 text-[0.65rem] text-(--ui-text-tertiary)">
              <span className="font-medium text-(--ui-text-secondary)">You</span>
              {fmtClock(messageCreatedAt ? messageCreatedAt.getTime() : undefined) && (
                <span className="tabular-nums text-(--ui-text-quaternary)">
                  {fmtClock(messageCreatedAt ? messageCreatedAt.getTime() : undefined)}
                </span>
              )}
              {/* ★ Stop 按钮 (showStop) 已从此处移除 —— 流式期间要取消, 用 composer
                  提交按钮 (会翻成 Stop, thread.tsx 底部 submitting 分支)。这里只保留
                  restore checkpoint 按钮 (只在 !showStop 且有正文时出现)。 */}
              {showRestore && (
                <div className="pointer-events-none ml-auto flex items-center justify-center opacity-0 transition-opacity group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100">
                  <button
                    aria-label={copy.restoreCheckpoint}
                    className={cn('pointer-events-auto size-6', USER_ACTION_ICON_BUTTON_CLASS)}
                    onClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      triggerHaptic('selection')
                      onRequestRestoreConfirm?.(messageId, {
                        text: messageText,
                        userOrdinal: runtimeUserOrdinal
                      })
                    }}
                    onPointerDown={event => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    title={copy.restoreFromHere}
                    type="button"
                  >
                    <Codicon name="discard" size="0.875rem" />
                  </button>
                </div>
              )}
            </div>
            <div className="relative w-full">
              {/* Read-only user bubble — styled identically to the Assistant
                  content card. No inline editing, no overlaid controls. */}
              <div className={bubbleClassName} data-slot="aui_user-bubble">
                {bubbleContent}
              </div>
            </div>
            <BranchPickerPrimitive.Root
              className="checkpoint-container flex items-center gap-1 pb-0 pt-1 pl-1.5 text-[0.75rem] leading-none text-(--ui-text-tertiary)"
              hideWhenSingleBranch
            >
              <span aria-hidden className="checkpoint-icon size-1.5 rounded-full border border-current" />
              <BranchPickerPrimitive.Previous
                className="checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default"
                title={copy.restorePrevious}
              >
                {copy.restoreCheckpoint}
              </BranchPickerPrimitive.Previous>
              <span className="checkpoint-divider opacity-55">
                <BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count />
              </span>
              <BranchPickerPrimitive.Next
                className="checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default"
                title={copy.restoreNext}
              >
                {copy.goForward}
              </BranchPickerPrimitive.Next>
            </BranchPickerPrimitive.Root>
            </div>
          </div>
        </ActionBarPrimitive.Root>
      </StickyHumanMessageContainer>
    </MessagePrimitive.Root>
  )
}

const SLASH_STATUS_RE = /^slash:(?<command>\/[^\n]+)\n(?<output>[\s\S]*)$/
const STEER_NOTE_RE = /^steer:(?<text>[\s\S]+)$/

const SystemMessage: FC = () => {
  const text = useAuiState(s => messageContentText(s.message.content))

  if (!text) {
    return null
  }

  const steerNote = text.match(STEER_NOTE_RE)

  if (steerNote?.groups) {
    return (
      <MessagePrimitive.Root
        className="flex max-w-[min(86%,44rem)] items-center gap-1.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60"
        data-role="system"
        data-slot="aui_system-message-root"
      >
        <Codicon className="text-muted-foreground/55" name="compass" size="0.75rem" />
        <span className="text-muted-foreground/55">steered</span>
        <span className="text-muted-foreground/35">·</span>
        <span className="whitespace-pre-wrap">{steerNote.groups.text.trim()}</span>
      </MessagePrimitive.Root>
    )
  }

  const slashStatus = text.match(SLASH_STATUS_RE)

  if (slashStatus?.groups) {
    const output = slashStatus.groups.output.trim()
    // Single-line status (e.g. "model → x") reads best centered inline; padded
    // multiline output (catalogs, usage tables) needs left-aligned, wider room
    // or the column alignment breaks.
    const multiline = output.includes('\n')

    return (
      <MessagePrimitive.Root
        className={cn(
          'w-[60%] max-w-[44rem] self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60',
          multiline ? 'text-left' : 'text-center'
        )}
        data-role="system"
        data-slot="aui_system-message-root"
      >
        <span className="font-mono text-muted-foreground/55">{slashStatus.groups.command}</span>
        {multiline ? (
          <LinkifiedText className="mt-0.5 block whitespace-pre-wrap" explicitOnly pretty={false} text={output} />
        ) : (
          <>
            <span className="mx-1.5 text-muted-foreground/35">·</span>
            <LinkifiedText className="whitespace-pre-wrap" explicitOnly pretty={false} text={output} />
          </>
        )}
      </MessagePrimitive.Root>
    )
  }

  const multiline = text.includes('\n')

  return (
    <MessagePrimitive.Root
      className={cn(
        'w-[60%] max-w-[44rem] self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/55',
        multiline ? 'text-left' : 'text-center'
      )}
      data-role="system"
      data-slot="aui_system-message-root"
    >
      <LinkifiedText className="whitespace-pre-wrap" explicitOnly pretty={false} text={text} />
    </MessagePrimitive.Root>
  )
}

interface UserEditComposerProps {
  cwd: string | null
  gateway: HermesGateway | null
  sessionId: string | null
}

const UserEditComposer: FC<UserEditComposerProps> = ({ cwd, gateway, sessionId }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const aui = useAui()
  const draft = useAuiState(s => s.composer.text)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef(draft)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [triggerActive, setTriggerActive] = useState(0)
  const [triggerItems, setTriggerItems] = useState<readonly Unstable_TriggerItem[]>([])
  // See index.tsx: set in keydown when the open popover consumes a nav/control
  // key so the matching keyup skips refreshTrigger (timing-immune vs reading
  // `trigger`, which keyup sees as already-null after Escape).
  const triggerKeyConsumedRef = useRef(false)
  const [triggerPlacement, setTriggerPlacement] = useState<'bottom' | 'top'>('top')
  const [focusRequestId, setFocusRequestId] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  // True while OS-drop files are being staged/uploaded into the session. Blocks
  // submit and shows a spinner so confirming the edit can't race the async
  // upload and drop the gateway-side ref before it lands in the draft.
  const [staging, setStaging] = useState(false)
  const expanded = draft.includes('\n')
  const canSubmit = draft.trim().length > 0
  const at = useAtCompletions({ cwd, gateway, sessionId })
  const slash = useSlashCompletions({ gateway })

  useEffect(() => () => notifyThreadEditClose(), [])

  const focusEditor = useCallback(() => {
    const editor = editorRef.current

    focusComposerInput(editor)

    if (editor) {
      placeCaretEnd(editor)
    }

    markActiveComposer('edit')
  }, [])

  const requestEditFocus = useCallback(() => {
    setFocusRequestId(id => id + 1)
  }, [])

  const appendExternalText = useCallback(
    (text: string, mode: ComposerInsertMode) => {
      const value = text.trim()

      if (!value) {
        return
      }

      const base = mode === 'inline' ? draftRef.current.trimEnd() : draftRef.current
      const sep = mode === 'inline' ? (base ? ' ' : '') : base && !base.endsWith('\n') ? '\n\n' : ''
      const next = `${base}${sep}${value}`

      draftRef.current = next
      aui.composer().setText(next)

      const editor = editorRef.current

      if (editor) {
        renderComposerContents(editor, next)
        placeCaretEnd(editor)
      }

      setFocusRequestId(id => id + 1)
    },
    [aui]
  )

  useEffect(() => {
    draftRef.current = draft

    const editor = editorRef.current

    if (
      editor &&
      (editor.childNodes.length === 0 || (document.activeElement !== editor && composerPlainText(editor) !== draft))
    ) {
      renderComposerContents(editor, draft)

      if (document.activeElement === editor) {
        placeCaretEnd(editor)
      }
    }
  }, [draft])

  useEffect(() => {
    focusEditor()
  }, [focusEditor, focusRequestId])

  useEffect(() => {
    const offFocus = onComposerFocusRequest(target => {
      if (target === 'edit') {
        setFocusRequestId(id => id + 1)
      }
    })

    const offInsert = onComposerInsertRequest(({ mode, target, text }) => {
      if (target === 'edit') {
        appendExternalText(text, mode)
      }
    })

    return () => {
      offFocus()
      offInsert()
    }
  }, [appendExternalText])

  const syncDraftFromEditor = useCallback(
    (editor: HTMLDivElement) => {
      const nextDraft = composerPlainText(editor)

      if (nextDraft !== draftRef.current) {
        draftRef.current = nextDraft
        aui.composer().setText(nextDraft)
      }

      return nextDraft
    },
    [aui]
  )

  const refreshTrigger = useCallback(() => {
    const editor = editorRef.current

    if (!editor) {
      return
    }

    const before = textBeforeCaret(editor)
    const detected = detectTrigger(before ?? composerPlainText(editor))

    if (detected) {
      const rect = editor.getBoundingClientRect()
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom

      setTriggerPlacement(spaceAbove < 220 && spaceBelow > spaceAbove ? 'bottom' : 'top')
    }

    setTrigger(detected)

    // Only reset the highlight when the trigger actually changed (opened, or
    // the query/kind differs). Re-detecting the *same* trigger — e.g. on a
    // caret move (mouseup) or a stray refresh — must preserve the user's
    // current selection instead of snapping back to the first item.
    if (detected?.kind !== trigger?.kind || detected?.query !== trigger?.query) {
      setTriggerActive(0)
    }
  }, [trigger])

  const closeTrigger = useCallback(() => {
    setTrigger(null)
    setTriggerItems([])
    setTriggerActive(0)
  }, [])

  const triggerAdapter: Unstable_TriggerAdapter | null =
    trigger?.kind === '@' ? at.adapter : trigger?.kind === '/' ? slash.adapter : null

  useEffect(() => {
    if (!trigger || !triggerAdapter?.search) {
      setTriggerItems([])

      return
    }

    setTriggerItems(triggerAdapter.search(trigger.query))
  }, [trigger, triggerAdapter])

  useEffect(() => {
    setTriggerActive(idx => Math.min(idx, Math.max(0, triggerItems.length - 1)))
  }, [triggerItems.length])

  const triggerLoading = trigger?.kind === '@' ? at.loading : trigger?.kind === '/' ? slash.loading : false

  const replaceTriggerWithChip = useCallback(
    (item: Unstable_TriggerItem) => {
      const editor = editorRef.current

      if (!editor || !trigger) {
        return
      }

      const serialized = hermesDirectiveFormatter.serialize(item)
      const starter = serialized.endsWith(':')
      const text = starter || serialized.endsWith(' ') ? serialized : `${serialized} `
      const directive = !starter && serialized.match(/^@([^:]+):(.+)$/)

      const finish = () => {
        draftRef.current = composerPlainText(editor)
        aui.composer().setText(draftRef.current)
        requestEditFocus()
        starter ? window.setTimeout(refreshTrigger, 0) : closeTrigger()
      }

      const sel = window.getSelection()
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null
      const node = range?.startContainer
      const offset = range?.startOffset ?? 0

      if (!sel || !range || node?.nodeType !== Node.TEXT_NODE || offset < trigger.tokenLength) {
        const current = composerPlainText(editor)
        renderComposerContents(editor, `${current.slice(0, Math.max(0, current.length - trigger.tokenLength))}${text}`)
        placeCaretEnd(editor)

        return finish()
      }

      const replaceRange = document.createRange()
      replaceRange.setStart(node, offset - trigger.tokenLength)
      replaceRange.setEnd(node, offset)
      replaceRange.deleteContents()

      if (directive) {
        const chip = refChipElement(directive[1], directive[2])
        const space = document.createTextNode(' ')
        const fragment = document.createDocumentFragment()
        fragment.append(chip, space)
        replaceRange.insertNode(fragment)

        const caret = document.createRange()
        caret.setStart(space, 1)
        caret.collapse(true)
        sel.removeAllRanges()
        sel.addRange(caret)

        return finish()
      }

      document.execCommand('insertText', false, text)
      finish()
    },
    [aui, closeTrigger, refreshTrigger, requestEditFocus, trigger]
  )

  const insertRefStrings = useCallback(
    (refs: InlineRefInput[]) => {
      const editor = editorRef.current

      if (!editor || refs.length === 0) {
        return false
      }

      const nextDraft = insertInlineRefsIntoEditor(editor, refs)

      if (nextDraft === null) {
        return false
      }

      draftRef.current = nextDraft
      aui.composer().setText(nextDraft)
      requestEditFocus()

      return true
    },
    [aui, requestEditFocus]
  )

  const insertDroppedRefs = useCallback(
    (candidates: ReturnType<typeof extractDroppedFiles>) => insertRefStrings(droppedFileInlineRefs(candidates, cwd)),
    [cwd, insertRefStrings]
  )

  // OS/Finder drops carry an absolute path on THIS machine — the gateway can't
  // read it in remote mode, and an image needs its bytes uploaded for vision.
  // Stage each through the same file.attach/image.attach_bytes pipeline the main
  // composer uses, then insert the *gateway-side* ref the agent can resolve —
  // never the raw local path (the MahmoudR remote-attach bug, which the main
  // composer fixes but this edit composer used to reproduce).
  const uploadOsDropRefs = useCallback(
    async (osDrops: ReturnType<typeof extractDroppedFiles>): Promise<InlineRefInput[]> => {
      if (!gateway || !sessionId) {
        // No session to stage into — best-effort inline refs (matches old path).
        return droppedFileInlineRefs(osDrops, cwd)
      }

      const remote = $connection.get()?.mode === 'remote'

      const requestGateway = <T,>(method: string, params?: Record<string, unknown>) =>
        gateway.request<T>(method, params)

      const refs: InlineRefInput[] = []

      for (const candidate of osDrops) {
        const path = candidate.path || ''

        if (!path) {
          continue
        }

        const kind: ComposerAttachment['kind'] =
          candidate.file?.type.startsWith('image/') || isImagePath(candidate.file?.name || path) ? 'image' : 'file'

        try {
          const uploaded = await uploadComposerAttachment(
            { detail: path, id: attachmentId(kind, path), kind, label: pathLabel(path), path },
            { remote, requestGateway, sessionId }
          )

          const ref = attachmentDisplayText(uploaded)

          if (ref) {
            refs.push(ref)
          }
        } catch (err) {
          notifyError(err, t.desktop.dropFiles)
        }
      }

      return refs
    },
    [cwd, gateway, sessionId, t.desktop.dropFiles]
  )

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0
    setDragActive(false)
  }, [])

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1

    if (!dragActive) {
      setDragActive(true)
    }
  }

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (!candidates.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    resetDragState()

    // In-app drags (project tree / gutter) are workspace-relative paths that
    // resolve on the gateway as-is, so they stay inline refs. OS drops need to
    // be staged + uploaded first, then their gateway-side ref is inserted.
    const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)

    if (insertDroppedRefs(inAppRefs)) {
      triggerHaptic('selection')
    }

    if (osDrops.length) {
      setStaging(true)
      void uploadOsDropRefs(osDrops)
        .then(refs => {
          if (insertRefStrings(refs)) {
            triggerHaptic('selection')
          }
        })
        .finally(() => setStaging(false))
    }
  }

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const editor = event.currentTarget

    if (editor.childNodes.length === 1 && editor.firstChild?.nodeName === 'BR') {
      editor.replaceChildren()
    }

    syncDraftFromEditor(editor)
    window.setTimeout(refreshTrigger, 0)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pastedText = event.clipboardData.getData('text')

    if (!pastedText || DATA_IMAGE_URL_RE.test(pastedText.trim())) {
      event.preventDefault()

      return
    }

    event.preventDefault()
    document.execCommand('insertText', false, pastedText)
    syncDraftFromEditor(event.currentTarget)
  }

  const submitEdit = (editor: HTMLDivElement) => {
    const nextDraft = syncDraftFromEditor(editor)

    if (submitting || staging || !nextDraft.trim()) {
      return
    }

    setSubmitting(true)
    aui.composer().send()
  }

  const handleEditBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget

      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return
      }

      window.setTimeout(() => {
        const root = rootRef.current
        const active = document.activeElement

        if (submitting || (root && active && root.contains(active))) {
          return
        }

        closeTrigger()
        aui.composer().cancel()
      }, 80)
    },
    [aui, closeTrigger, submitting]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (trigger && triggerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        setTriggerActive(idx => (idx + 1) % triggerItems.length)

        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        setTriggerActive(idx => (idx - 1 + triggerItems.length) % triggerItems.length)

        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        const item = triggerItems[triggerActive]

        if (item) {
          replaceTriggerWithChip(item)
        }

        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        closeTrigger()

        return
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      aui.composer().cancel()

      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitEdit(event.currentTarget)
    }
  }

  const handleKeyUp = () => {
    // If this keyup belongs to a key the open trigger popover already consumed
    // in keydown (Arrow/Enter/Tab/Escape), skip the refresh. Those keys never
    // edit text, and for Escape the keydown already closed the menu — a refresh
    // here would re-detect the still-present `/` and instantly reopen it. We
    // read a ref set during keydown rather than `trigger`, because by keyup
    // time React has re-rendered and `trigger` may already be null.
    if (triggerKeyConsumedRef.current) {
      triggerKeyConsumedRef.current = false

      return
    }

    window.setTimeout(refreshTrigger, 0)
  }

  return (
    <ComposerPrimitive.Root className="contents" data-slot="aui_edit-composer-root">
      <StickyHumanMessageContainer>
        <div
          className="composer-human-message-container human-execution-message-top relative flex w-full items-start rounded-md bg-(--ui-chat-surface-background)"
          onBlur={handleEditBlur}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          ref={rootRef}
        >
          {trigger && (
            <ComposerTriggerPopover
              activeIndex={triggerActive}
              items={triggerItems}
              kind={trigger.kind}
              loading={triggerLoading}
              onHover={setTriggerActive}
              onPick={replaceTriggerWithChip}
              placement={triggerPlacement}
            />
          )}
          <div
            className={cn(
              USER_BUBBLE_BASE_CLASS,
              'ui-prompt-input__container relative border-(--ui-stroke-secondary) data-[expanded=true]:min-h-20',
              COMPOSER_DROP_FADE_CLASS,
              dragActive && COMPOSER_DROP_ACTIVE_CLASS
            )}
            data-expanded={expanded ? 'true' : undefined}
          >
            <div
              aria-label={copy.editMessage}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(
                'ui-prompt-input-editor__input max-h-48 w-full resize-none bg-transparent p-0 pr-7 text-[length:var(--conversation-text-font-size)] text-foreground/95 outline-none',
                'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60',
                '**:data-ref-text:cursor-default',
                expanded ? 'min-h-16' : 'min-h-[1.25rem]'
              )}
              contentEditable
              data-placeholder={copy.editMessage}
              data-slot={RICH_INPUT_SLOT}
              onBlur={() => window.setTimeout(closeTrigger, 80)}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onFocus={() => markActiveComposer('edit')}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onMouseUp={refreshTrigger}
              onPaste={handlePaste}
              ref={editorRef}
              role="textbox"
              spellCheck={false}
              suppressContentEditableWarning
            />
            <ComposerPrimitive.Input
              asChild
              className="sr-only"
              submitMode="ctrlEnter"
              tabIndex={-1}
              unstable_focusOnScrollToBottom={false}
            >
              <textarea
                aria-hidden
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="sr-only"
                spellCheck={false}
                tabIndex={-1}
              />
            </ComposerPrimitive.Input>
            {staging && (
              <span
                className="pointer-events-none absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-background/80 px-1.5 py-0.5 text-[0.62rem] text-muted-foreground backdrop-blur-[1px]"
                data-slot="aui_edit-staging"
              >
                <Loader2Icon className="size-3 animate-spin" />
                {copy.attachingFile}
              </span>
            )}
            <button
              aria-label={copy.sendEdited}
              className={cn('absolute right-2 bottom-2 size-5', USER_ACTION_ICON_BUTTON_CLASS)}
              disabled={!canSubmit || submitting || staging}
              onClick={() => {
                const editor = editorRef.current

                if (editor) {
                  submitEdit(editor)
                }
              }}
              title={copy.sendEdited}
              type="button"
            >
              {submitting ? StopGlyph : <Codicon name="arrow-up" size={USER_ACTION_ICON_SIZE} />}
            </button>
          </div>
        </div>
      </StickyHumanMessageContainer>
    </ComposerPrimitive.Root>
  )
}
