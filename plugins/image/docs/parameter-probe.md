# `image:compose` — parameter-probe evidence (ADR-0037 items 3 + 7)

This note records the **non-bypassed** `codex-companion` re-confirmation that
ADR-0037's first build slice (compose-core) requires: (item 3) the file is
actually returned through the real companion bridge, and (item 7) which
prompt-rendered parameters Codex's integrated gpt-image tool reliably honors.

Plugin-local evidence — **not** a per-run artifact (`docs/contracts.md` §6).

## Run

- Date: 2026-06-25 (run `image-20260625T011402Z-6f3227`)
- Path: Claude → `compose-dispatch.mjs` → `codex-companion` (`companions`
  0.4.0) → Codex's integrated gpt-image tool
- Sandbox: **workspace-write, NO `--dangerously-bypass-approvals-and-sandbox`**
  — the dispatcher passes no bypass flag (guarded by a test). The ADR-0037
  spike used a bypass only to skip the first-use trust prompt on an untrusted
  temp cwd; writing inside the trusted repo workspace works WITHOUT it, exactly
  as the ADR predicted ("expected to work without the bypass, to be
  re-confirmed during integration").
- Prompt: "A minimalist flat-style solid blue circle centered on a plain white
  background, rendered at 1024x1024 pixels. Simple test image, no text, no
  people."

## Item 3 — file return: CONFIRMED

`compose-dispatch.mjs` did NOT trust Codex stdout; it verified the file on the
shared filesystem:

- path exists under the run root ✓
- non-empty: **763,301 bytes** ✓
- sniffed off the PNG IHDR bytes (not the model's self-report): **1024 × 1024,
  png** ✓
- visually correct: a solid blue circle on a white background, matching the
  prompt ✓

## Item 7 — prompt-rendered parameter honoring

| parameter | requested (rendered into prompt) | observed (sniffed) | honored? |
|-----------|----------------------------------|--------------------|----------|
| size      | `1024x1024`                      | `1024 × 1024`      | ✅ yes (this run) |
| format    | `png`                            | `png`              | ✅ yes |
| quality   | `low`                            | not observable from output bytes | n/a — no structured readback |

**Finding**: a prompt-stated pixel size was honored in this run and the
requested format matched. Quality is not observable from the bytes. This is
consistent with ADR-0037 Decision 7 — Codex surfaces only the `prompt`, so
parameters are **prompt-mediated best-effort**: `image:frame` captures them and
`image:compose` renders them into the prompt. The contract treats size/format
as best-effort (honored here) and moderation / edits / reference-masks /
partial_images as unsupported-through-Codex / deferred (`docs/contracts.md` §5).

> One sample is not a guarantee across every size/style; this confirms the
> mechanism works end-to-end and the dispatcher's verification path is sound.
> Broader parameter sweeps belong to later verb work, not this feasibility
> slice.

**Re-confirmed after the dispatcher refactor** (run
`image-20260625T022109Z-2c32fb`): the production `--size 768x768` flag —
rendered into the prompt by `buildPrompt`, not hand-written into the
description — produced a verified **768 × 768** PNG (415,807 bytes). The
prompt-mediated size channel works through the helper's own flag, confirming
the fix for the "size never reaches generation" review finding.

## Cost

gpt-image-2 `low` ≈ **$0.005** for this 1024×1024 image — surfaced in the run
manifest (`cost.estimate_usd`); actual spend is billed by Codex/OpenAI. No
hidden spend, no blind retry of user/moderation errors.
