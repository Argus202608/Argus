"""Alibaba Cloud DashScope provider profile.

DashScope's OpenAI-compatible endpoint gates reasoning on the non-standard
``enable_thinking`` parameter, passed through ``extra_body`` (Python SDK). Hybrid
thinking models (Qwen3 / Qwen3.5 / Qwen3.6 / Qwen3.7 — Max/Plus/Flash/Turbo and
open-source variants) default to thinking OFF for -max and ON for others, so the
flag must be set explicitly to honor Hermes' unified reasoning toggle. Without
this override, ``reasoning_config`` never reached the wire and the thinking
switch silently did nothing (defect D6).

Wire shape (per Alibaba Model Studio docs):

    {"extra_body": {"enable_thinking": true | false,
                    "thinking_budget": <int, optional>}}

``enable_thinking`` is top-level in ``extra_body`` — NOT nested under
``chat_template_kwargs`` (that's the vLLM/self-hosted convention). Thinking-only
models (QwQ, ``*-thinking-*``) ignore the flag, so we omit it for them; models
that aren't recognizably hybrid-thinking are left untouched to avoid perturbing
older qwen-vl / qwen-max-2024 wire formats.
"""

from __future__ import annotations

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile


def _model_supports_thinking_toggle(model: str | None) -> bool:
    """True for DashScope Qwen models whose reasoning can be toggled per request.

    Covers the Qwen3+ hybrid families (qwen3-*, qwen3.5-*, qwen3.6-*, qwen3.7-*,
    and the bare qwen-plus/qwen-flash/qwen-turbo/qwen-max aliases which currently
    route to a Qwen3 hybrid backend). Thinking-only models (``*-thinking*``,
    ``qwq*``) are excluded — the flag is a no-op / rejected there. Older
    non-thinking models (qwen-vl-*, qwen-max-2024-*, qwen2*) are excluded so we
    don't perturb their wire format.
    """
    m = (model or "").strip().lower().rsplit("/", 1)[-1]
    if not m:
        return False
    # Thinking-only → no toggle (always reasons).
    if "thinking" in m or m.startswith("qwq"):
        return False
    # Explicit Qwen3+ generations.
    if m.startswith(("qwen3", "qwen-3")):
        return True
    # Bare current aliases that route to Qwen3 hybrid backends.
    if m in ("qwen-plus", "qwen-flash", "qwen-turbo", "qwen-max",
             "qwen-plus-latest", "qwen-flash-latest",
             "qwen-turbo-latest", "qwen-max-latest"):
        return True
    return False


class AlibabaProfile(ProviderProfile):
    """Alibaba DashScope — extra_body.enable_thinking (+ optional thinking_budget)."""

    def build_api_kwargs_extras(
        self, *, reasoning_config: dict | None = None,
        model: str | None = None, **context,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body: dict[str, Any] = {}
        top_level: dict[str, Any] = {}

        if not _model_supports_thinking_toggle(model):
            # Thinking-only / non-thinking / unknown → leave wire untouched.
            return extra_body, top_level

        # Default enabled (matches most hybrid Qwen3 non-max defaults); an
        # explicit reasoning_config.enabled=False disables it.
        enabled = True
        if isinstance(reasoning_config, dict) and reasoning_config.get("enabled") is False:
            enabled = False

        extra_body["enable_thinking"] = enabled

        if enabled and isinstance(reasoning_config, dict):
            # Map a numeric budget through if provided; DashScope caps reasoning
            # tokens with thinking_budget (Qwen3 thinking mode + Kimi).
            budget = reasoning_config.get("thinking_budget")
            if budget is None:
                budget = reasoning_config.get("budget_tokens")
            try:
                if budget is not None:
                    extra_body["thinking_budget"] = int(budget)
            except (TypeError, ValueError):
                pass

        return extra_body, top_level


alibaba = AlibabaProfile(
    name="alibaba",
    aliases=("dashscope", "alibaba-cloud", "qwen-dashscope"),
    env_vars=("DASHSCOPE_API_KEY",),
    base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
)

register_provider(alibaba)
