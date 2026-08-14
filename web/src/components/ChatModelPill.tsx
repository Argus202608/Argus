/**
 * ChatModelPill — 输入框内右下角的一颗胶囊, 点开就是 model + reasoning-effort
 * 二合一面板 (对齐 desktop ModelPill 观感):
 *   - 顶部搜索框
 *   - 中部按 provider 分组的 model 列表, 点击即切
 *   - 底部 Thinking 一栏, 6 档滑块 Off/Min/Low/Med/High/Max —— 档位与文案都取自
 *     lib/reasoning-effort 的 EFFORT_OPTIONS (它有不变量测试守着, 对齐
 *     hermes_constants.VALID_REASONING_EFFORTS), 不再在这里手写第二份表。
 *     后端按当前模型能力做映射: OpenAI reasoning_effort / Claude budget /
 *     Qwen enable_thinking。当前模型 capabilities.supports_reasoning 为 false
 *     时滑块整体置灰 (对齐 desktop 按 capabilities.reasoning 收起该控件)。
 *
 * 持久化仍走 config-api: model 走 api.setModelAssignment, effort 走
 * setReasoningEffort → agent.reasoning_effort。
 */

import { ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ThinkingSlider } from "@/components/ThinkingSlider";
import { api } from "@/lib/api";
import type { ModelOptionProvider } from "@/lib/api";
import { getReasoningEffort, setReasoningEffort } from "@/lib/config-api";
import {
  effortShortLabel,
  normalizeEffort,
  VALID_EFFORTS,
} from "@/lib/reasoning-effort";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
}

interface FlatEntry {
  provider: string;
  providerSlug: string;
  model: string;
}

export function ChatModelPill({ className }: Props) {
  const [model, setModel] = useState<string>("");
  const [provider, setProvider] = useState<string>("");
  const [effort, setEffort] = useState<string>("medium");
  // Current model's reasoning capability, from /api/model/info. Defaults to
  // true: the effort dial is broadly accepted and a no-op where unsupported,
  // so hiding it from a capable-but-uncatalogued model is the worse failure
  // (same rationale as hermes_cli/inventory.py's _apply_capabilities).
  const [canReason, setCanReason] = useState(true);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ModelOptionProvider[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    void api
      .getModelInfo()
      .then((r) => {
        if (r?.model) setModel(String(r.model));
        if (r?.provider) setProvider(String(r.provider));
        setCanReason(r?.capabilities?.supports_reasoning !== false);
      })
      .catch(() => {
        /* keep last known */
      });
    void getReasoningEffort().then((e) => setEffort(normalizeEffort(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void api.getModelOptions().then((r) => {
      setProviders(r?.providers ?? []);
    }).catch(() => {
      setProviders([]);
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const applyEffort = useCallback(
    (next: string) => {
      if (!VALID_EFFORTS.has(next) || next === effort || saving) return;
      const prev = effort;
      setEffort(next);
      setSaving(true);
      setReasoningEffort(next)
        .catch(() => setEffort(prev))
        .finally(() => setSaving(false));
    },
    [effort, saving],
  );

  const applyModel = useCallback(
    (nextProvider: string, nextModel: string) => {
      if (nextModel === model && nextProvider === provider) {
        setOpen(false);
        return;
      }
      const prevModel = model;
      const prevProvider = provider;
      setModel(nextModel);
      setProvider(nextProvider);
      setOpen(false);
      void api
        .setModelAssignment({
          scope: "main",
          provider: nextProvider,
          model: nextModel,
        })
        .then((res) => {
          if (res?.confirm_required) {
            setModel(prevModel);
            setProvider(prevProvider);
          }
          refresh();
        })
        .catch(() => {
          setModel(prevModel);
          setProvider(prevProvider);
        });
    },
    [model, provider, refresh],
  );

  const filtered = useMemo<FlatEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const out: FlatEntry[] = [];
    for (const p of providers) {
      const models = p.models || [];
      for (const m of models) {
        if (!q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
          out.push({ provider: p.name, providerSlug: p.slug, model: m });
        }
      }
    }
    return out;
  }, [providers, query]);

  const grouped = useMemo(() => {
    const g = new Map<string, FlatEntry[]>();
    for (const e of filtered) {
      const arr = g.get(e.provider);
      if (arr) arr.push(e);
      else g.set(e.provider, [e]);
    }
    return Array.from(g.entries());
  }, [filtered]);

  const modelShort = model.split("/").slice(-1)[0] || model || "select model";
  const tierLabel = effortShortLabel(effort);

  return (
    <div ref={rootRef} className={cn("relative flex items-center text-xs", className)}>
      <button
        type="button"
        className={cn(
          // h-6: pill 现在活在单行 composer 里, 它是那一行的最高元素 —— 高度直接
          // 决定编辑框高度。h-8(32px) 会把框顶到 43px, 明显比一行文字该有的高度高。
          "flex h-6 items-center gap-1 rounded px-1.5 text-text-tertiary transition-colors",
          "hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={canReason ? `${modelShort} · ${tierLabel}` : modelShort}
      >
        {/* 窄屏(<sm)收成"只剩箭头"的紧凑态 —— composer 是单行布局, pill 若始终
            占满 ~137px 会把输入区挤成 0 宽、并把发送按钮顶出边框 (对齐 desktop
            ModelPill 的 compact 模式: 窄容器下同样只留 chevron)。 */}
        <span className="hidden max-w-[10rem] truncate font-normal sm:inline">{modelShort}</span>
        {/* 不支持推理的模型不显示档位 —— 显示一个不生效的 "Med" 是误导。 */}
        {canReason && (
          <>
            <span className="hidden text-text-tertiary/70 sm:inline">·</span>
            <span className="hidden font-normal text-text-tertiary sm:inline">{tierLabel}</span>
          </>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
      </button>

      {/* 面板宽度 w-60 (240px): 由最窄的硬约束决定 —— Thinking 那排 6 个刻度
          (Off/Min/Low/Med/High/Max, 10px 字) 约 130px, 加左右 padding 也就
          ~180px。之前的 w-80(320px) 是照抄 dialog 的尺寸, 挂在单行 composer 上方
          时明显过宽、右侧留一大片空白; 模型名本来就靠 truncate 收口, 再宽也换不
          来可读性。 */}
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 w-60 rounded-md border bg-background p-0 shadow-lg">
          <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-text-tertiary" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search model or provider…"
              className="min-w-0 flex-1 border-0 bg-transparent text-xs outline-none placeholder:text-text-tertiary"
              autoFocus
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            {providers.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-text-tertiary">
                Loading models…
              </div>
            )}
            {providers.length > 0 && filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-text-tertiary">
                No matches
              </div>
            )}
            {grouped.map(([providerName, entries]) => (
              <div key={providerName} className="mb-1 last:mb-0">
                <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-text-tertiary">
                  {providerName}
                </div>
                {entries.map((entry) => {
                  const active =
                    entry.model === model && entry.providerSlug === (
                      providers.find((p) => p.name === entry.provider)?.slug || ""
                    );
                  return (
                    <button
                      key={`${entry.providerSlug}::${entry.model}`}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted",
                        active && "bg-muted font-medium",
                      )}
                      onClick={() => applyModel(entry.providerSlug, entry.model)}
                    >
                      <span className="min-w-0 truncate">{entry.model}</span>
                      {active && (
                        <span className="ml-2 shrink-0 text-text-tertiary">✓</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Thinking —— 6 档滑块, 档位/文案来自 EFFORT_OPTIONS。后端按当前模型
              能力做映射 (OpenAI reasoning_effort / Claude budget / Qwen bool)。 */}
          <div className="border-t px-3 py-2">
            <ThinkingSlider
              disabled={!canReason}
              disabledHint="This model doesn't support reasoning effort."
              onChange={applyEffort}
              saving={saving}
              value={effort}
            />
          </div>
        </div>
      )}
    </div>
  );
}
