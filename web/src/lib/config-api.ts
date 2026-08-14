/**
 * Shared helpers for reading/writing `agent.reasoning_effort` in config.yaml.
 *
 * Used by ModelPickerDialog (dashboard sidebar Thinking bar) and ChatModelPill
 * (multimodal composer). Same read-modify-write flow in one place keeps the
 * two surfaces from drifting.
 *
 * Semantics mirror hermes_constants.parse_reasoning_effort:
 *   ""            → Hermes default (treated as "medium" client-side)
 *   "none"        → thinking OFF
 *   valid level   → thinking ON at that level
 */

import { api } from "@/lib/api";
import { normalizeEffort, VALID_EFFORTS } from "@/lib/reasoning-effort";

export async function getReasoningEffort(): Promise<string> {
  try {
    const cfg = await api.getConfig();
    const agent = (cfg?.agent as Record<string, unknown> | undefined) ?? {};
    return normalizeEffort(agent.reasoning_effort);
  } catch {
    return "medium";
  }
}

/** Read-modify-write the config so sibling keys are preserved. Returns the
 *  applied effort on success; throws on failure so callers can revert. */
export async function setReasoningEffort(next: string): Promise<string> {
  if (!VALID_EFFORTS.has(next)) {
    throw new Error(`invalid reasoning effort: ${next}`);
  }
  const cfg = await api.getConfig();
  const base = (cfg ?? {}) as Record<string, unknown>;
  const agent =
    base.agent && typeof base.agent === "object"
      ? { ...(base.agent as Record<string, unknown>) }
      : {};
  agent.reasoning_effort = next;
  await api.saveConfig({ ...base, agent });
  return next;
}
