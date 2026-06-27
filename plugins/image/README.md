# image — cross-host image generation capability (ADR-0037)

`image` is a **Layer-2 capability plugin** (ADR-0010 4-layer composition)
that generates images across Claude Code and Codex CLI through Codex's
**integrated gpt-image** tool. It is persona-agnostic — any persona
(designer, founder, engineer) can compose it, and it is self-serve via its
own six verb commands.

## Surface — the six cognitive verbs

| Verb | What it does |
|------|--------------|
| `image:investigate` | Gather visual references, style exemplars, brand/visual constraints |
| `image:frame` | Turn a request into an explicit image brief (subject, composition, style, palette, aspect ratio, output params, success criteria) |
| `image:decide` | Choose among candidate approaches, styles, or generated variants |
| `image:compose` | Generate the image (the generative core) |
| `image:critique` | Evaluate a generated image against the brief using vision input |
| `image:refine` | Apply critique/feedback and regenerate |

Invoke as `/image:<verb>` (Claude Code) or `$image:<verb>` (Codex CLI).

## How generation works

- **Codex host**: native — `image:compose` drives the in-session gpt-image
  tool via `codex exec`.
- **Claude host**: dispatch through `companions/codex-companion.mjs` (the
  Claude→Codex bridge). The generated image is written to the shared
  filesystem; the companion's text response carries the artifact path +
  metadata (no binary channel in `companions/contract.md`).
- Generation **always** runs through Codex's integrated gpt-image tool.
  agentic-plugins **never** calls the OpenAI image API directly (ADR-0037
  Alternative 6 — rejected outright, enforced by a sentinel test).

## Design — lean L2

`image` carries **no** workflow-continuity machinery (no `state.mjs`, no
hooks, no `start` macro, no resume/checkpoint/peer-now meta skills). It is a
transactional generation capability: the brief and result flow through **run
manifests** under `.agentic-plugins/runs/image/` (gitignored), not a durable
workflow file. See [`docs/contracts.md`](docs/contracts.md) for the shared
contract surfaces (ImageBrief, ImageResult run manifest, gpt-image-2
parameter limits, typed error taxonomy, retention policy, privacy gate).

## Cost, privacy, honest scope

- **Cost**: gpt-image-2 has real per-image cost (~$0.005 low / $0.04 medium
  / $0.17–0.21 high, size-dependent). The capability surfaces cost — no
  hidden spend, no blind retry of user/moderation errors.
- **Privacy gate**: cross-host prompts (and, for `image:critique`, attached
  images and reference assets) are genericized before dispatch.
- **Honest scope**: where neither native generation nor a reachable Codex
  bridge exists, `image:compose` reports the limitation explicitly.

## Status

Shipped (v0.1.0) — all six verbs built and verified per ADR-0037. compose
(generative core), critique (vision evaluation), and refine (regeneration loop)
were confirmed **end-to-end with real gpt-image generation** through the
`codex-companion` bridge (no sandbox bypass); frame (ImageBrief + gpt-image-2
validation), investigate (visual references), and decide (variant selection +
safe retention) round out the capability. Lean L2 — no workflow-continuity
machinery.

> Follow-up: adding `image` to runtime's `PLUGIN_NAMES` (so `runtime:doctor` /
> `runtime:settings` diagnose it) is a separate cross-package `plugin/runtime`
> PR (ADR-0016), pending runtime settings/doctor test-fixture updates.

## Install

```sh
# Claude Code
claude plugin marketplace add each4all/agentic-plugins
claude plugin install image@agentic-plugins

# OpenAI Codex CLI — add the marketplace, then enable in ~/.codex/config.toml:
#   [plugins."image@agentic-plugins"]
#   enabled = true
codex plugin marketplace add each4all/agentic-plugins
```

The Claude host path needs Codex installed + authenticated on the same machine
(generation rides Codex's integrated gpt-image through the `codex-companion`
bridge).

See [ADR-0037](../../docs/adr/0037-image-capability-plugin.md).
