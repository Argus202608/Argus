---
title: "Mm Research Example — Example skill OWNED by the multimodal deep-research (RouterEngine) sub-agent"
sidebar_label: "Mm Research Example"
description: "Example skill OWNED by the multimodal deep-research (RouterEngine) sub-agent"
---

{/* This page is auto-generated from the skill's SKILL.md by website/scripts/generate-skill-docs.py. Edit the source SKILL.md, not this page. */}

# Mm Research Example

Example skill OWNED by the multimodal deep-research (RouterEngine) sub-agent.
Registered under config.yaml skills.mm_research, so the MAIN agent never loads
it — only the deep-research ReAct loop sees this content. Replace/extend with
real deep-research guidance (analysis rubrics, domain checklists, etc.).

## Skill metadata

| | |
|---|---|
| Source | Bundled (installed by default) |
| Path | `skills/multimodal/mm_research_example` |
| Version | `0.1.0` |
| Platforms | macos, windows, linux |
| Tags | `multimodal`, `deep-research`, `example` |

## Reference: full SKILL.md

:::info
The following is the complete skill definition that Argus loads when this skill is triggered. This is what the agent sees as instructions when the skill is active.
:::

# Deep-research analysis guidance (example)

You are the video deep-research sub-agent. This skill is loaded only into YOUR
ReAct prompt (the main agent can't see it). Use it as domain guidance while you
decompose a complex multimodal question into search / recall sub-tasks.

## How to work a segment

- Analyze the video from its beginning, batch by batch, forward to the live edge.
- Ground every claim in a specific frame timestamp — never assert "earlier X
  happened" without a recall/search finding backing it.
- Prefer recall_* (local memory graph, cheap) before a paid image/text search.
- Keep each round's sub-queries concrete and self-contained (no vague pronouns).

## What NOT to do

- Don't fabricate off-screen facts. If the answer isn't in the frames or memory,
  say so and (if a live source is on) keep watching.
- Don't obsess over information the video can't provide (e.g. post-event stats).

*(This is a placeholder example proving the mm_research skill-ownership wiring.
Replace its body with real deep-research playbooks as you develop them.)*
