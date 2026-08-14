"""ZAI / GLM provider profile.

GLM's thinking-capable models (GLM-4.5+, GLM-5+) default to thinking-mode ON and
gate it with a ``thinking: {"type": "enabled" | "disabled"}`` parameter — the
same wire shape as DeepSeek. On the OpenAI-compatible endpoint that non-standard
field is passed via ``extra_body``. Without an explicit flag GLM keeps reasoning
on and emits reasoning content, which (combined with Hermes' history replay) can
trip the "reasoning must be echoed back" contract on later turns, and Hermes'
unified reasoning toggle silently did nothing (defect D3).

Wire shape:

    {"extra_body": {"thinking": {"type": "enabled" | "disabled"}}}

Non-thinking GLM models (glm-4-9b, glm-4-flash, glm-4v-*) are left as no-ops so
their wire format is untouched.
"""

from __future__ import annotations

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile


def _model_supports_thinking(model: str | None) -> bool:
    """GLM thinking-capable model families.

    Covers GLM-4.5+ and GLM-5+ (glm-4.5-*, glm-4.6-*, glm-5-*, glm-5.2-*, …).
    Older glm-4-9b / glm-4-flash / vision glm-4v-* are excluded (no thinking mode
    or a different contract). Tolerant of the dot-vs-dash version separator.
    """
    m = (model or "").strip().lower().rsplit("/", 1)[-1]
    if not m or not m.startswith("glm"):
        return False
    if m.startswith("glm-4v") or m.startswith("glm-4-9b") or m.startswith("glm-4-flash"):
        return False
    # GLM-5+ generations always have thinking.
    if m.startswith(("glm-5", "glm-6", "glm5", "glm6")):
        return True
    # GLM-4.5 / 4.6 (dot or dash separator).
    if m.startswith(("glm-4.5", "glm-4-5", "glm-4.6", "glm-4-6")):
        return True
    return False


class ZaiProfile(ProviderProfile):
    """Z.AI / GLM — extra_body.thinking:{type}."""

    def build_api_kwargs_extras(
        self, *, reasoning_config: dict | None = None,
        model: str | None = None, **context,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body: dict[str, Any] = {}
        top_level: dict[str, Any] = {}

        if not _model_supports_thinking(model):
            return extra_body, top_level

        enabled = True
        if isinstance(reasoning_config, dict) and reasoning_config.get("enabled") is False:
            enabled = False

        extra_body["thinking"] = {"type": "enabled" if enabled else "disabled"}
        return extra_body, top_level


zai = ZaiProfile(
    name="zai",
    aliases=("glm", "z-ai", "z.ai", "zhipu"),
    env_vars=("GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"),
    display_name="Z.AI (GLM)",
    description="Z.AI / GLM — Zhipu AI models",
    signup_url="https://z.ai/",
    fallback_models=(
        "glm-5.2",
        "glm-5",
        "glm-4-9b",
    ),
    base_url="https://api.z.ai/api/paas/v4",
    default_aux_model="glm-4.5-flash",
)

register_provider(zai)
