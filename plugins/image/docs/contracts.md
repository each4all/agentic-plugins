# `image` capability — contract surfaces (ADR-0037)

This document defines the data and behavioural contracts that the six
`image` verbs share. The **scaffold** slice (PR `scaffold`) establishes
these surfaces so that the later verb PRs (`compose-core`, `frame`,
`investigate`, `decide`, `critique`, `refine`) consume a stable shape
rather than re-inventing it. Field-level enforcement lands with each
consuming verb; this file is the single source of truth for the shape.

> **Design posture — lean L2.** `image` carries **no** workflow-continuity
> machinery (no `state.mjs`, no hooks, no `start` macro, no
> resume/checkpoint/peer-now meta skills). The brief and the result flow
> between verbs through **run manifests on the shared filesystem**, not a
> durable workflow state file. This is the deliberate ADR-0037 lean-L2
> decision (peer-confirmed at plan time): `image` is a transactional
> generation capability, not a long-running persona workflow.

---

## 1. Artifact layout

Generated images and their manifests land under a conventional,
gitignored runs root (already covered by `.gitignore`'s
`.agentic-plugins/runs/`):

```
.agentic-plugins/runs/image/
└── <run-id>/                      # run-id = image-<iso-utc>-<rand>
    ├── manifest.json              # the ImageResult run manifest (§4)
    ├── brief.json                 # the ImageBrief for this run (§3), if framed
    ├── <slug>-1.<ext>             # generated image(s)
    └── <slug>-2.<ext>             # additional variants when n>1
```

- Images are **returned by path, never inlined** as raw bytes into the
  session (ADR-0037 Decision 4).
- A caller-specified output path overrides the default root; the verb
  MUST refuse to escape the intended artifact area (no `..` traversal,
  no overwrite without explicit confirmation).
- The ADR item-7 `parameter-probe.md` evidence note is **plugin-local**,
  not a per-run artifact — it lives at `plugins/image/docs/parameter-probe.md`
  (see §6), not under the runs root.

---

## 2. Cross-host execution contract

- **Codex host**: `image:compose` drives the in-session gpt-image tool
  natively via `codex exec`.
- **Claude host**: dispatch through `companions/codex-companion.mjs`
  (the `task` subcommand). The generated image is written to the shared
  filesystem; the companion's **text** response carries the artifact
  path + metadata. No binary channel is added to
  `companions/contract.md` (kept text-only per ADR-0009).
- Generation **always** runs through Codex's *integrated* gpt-image
  tool. agentic-plugins **never** calls the OpenAI image API directly
  (ADR-0037 Alternative 6 — rejected outright; enforced by the
  direct-API-ban sentinel test).

---

## 3. `ImageBrief` (produced by `image:frame`)

The explicit brief that `image:compose` renders into a prompt. JSON
shape (fields filled best-effort; unknowns omitted):

```json
{
  "subject":      "string — what the image depicts",
  "composition":  "string — framing, layout, focal point",
  "style":        "string — art direction / medium / rendering style",
  "palette":      "string — colours / mood",
  "aspect_ratio": "string — e.g. 1:1, 3:2, 2:3 (must satisfy gpt-image-2 limits, §5)",
  "output": {
    "size":     "string — e.g. 1024x1024 (edges multiple of 16, max edge <=3840, aspect <=3:1)",
    "quality":  "low | medium | high | auto",
    "format":   "png | jpeg | webp",
    "variants": "integer >= 1 — number of images to generate (n)"
  },
  "success_criteria": ["string — what 'good' means; used by image:critique"],
  "constraints":      ["string — hard constraints / things to avoid"]
}
```

`image:frame` MUST warn or reject brief fields that gpt-image-2 cannot
honor (e.g. a transparent-background request — see §5).

---

## 4. `ImageResult` run manifest (`manifest.json`, written by `image:compose` / `refine`)

```json
{
  "run_id":   "image-<iso-utc>-<rand>",
  "host":     "codex | claude",
  "status":   "success | error",
  "brief_ref": "brief.json | null",
  "prompt":   "string — the exact prompt rendered for Codex's gpt-image tool",
  "requested_parameters": { "size": "…", "quality": "…", "format": "…", "variants": 1 },
  "observed_parameters":  { "size": "…", "format": "…", "note": "best-effort; some requested params may be silently ignored (§6)" },
  "images": [
    {
      "path":       "absolute path under the run dir",
      "bytes":      "integer — verified non-empty",
      "width":      "integer | null — sniffed",
      "height":     "integer | null — sniffed",
      "format":     "png | jpeg | webp — sniffed",
      "selected":   "boolean — image:decide marks the chosen variant",
      "rejected":   "boolean — retained as an audit artifact unless cleaned (§7)"
    }
  ],
  "cost": { "estimate_usd": "number — surfaced, not hidden", "tier": "low | medium | high", "basis": "string" },
  "error": { "kind": "see §8 | null", "message": "string", "detail": "string" },
  "created_at": "iso-utc"
}
```

**Return-validation (ADR-0037 + peer):** `image:compose` MUST NOT trust
Codex stdout. Before recording `status: success` it verifies each image
path: (a) exists, (b) is under the expected output root unless an
override was explicit, (c) is non-empty, (d) sniffs dimensions/format,
and (e) reconciles them against the claimed metadata.

---

## 5. gpt-image-2 parameter limits + Codex-prompt-path surface (re-confirm at build time)

Codex's integrated tool surfaces only the **`prompt`** to the session —
`size` / `quality` / `format` / `background` / `n` are **not** exposed as
controllable parameters. `image:frame` captures the desired values and
`image:compose` **renders them into the prompt** (best-effort). Model
limits to respect when framing:

- **size** — flexible, not a fixed list: edges multiple of `16px`, max
  edge `<= 3840px`, aspect `<= 3:1`, total `655,360`–`8,294,400` px
  (popular: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `auto`).
- **quality** — `low` / `medium` / `high` / `auto`.
- **format** — `png` (default) / `jpeg` / `webp` (+ `output_compression`
  0–100 for jpeg/webp).
- **background** — `opaque` / `auto` only. **gpt-image-2 does NOT
  support transparent backgrounds** (a regression from gpt-image-1) —
  `image:frame` must reject/warn, never pretend prompt wording guarantees it.

Capabilities the underlying model has but that the **Codex prompt path
does NOT surface as structured controls** (classified so later verbs do
not assume them):

- **moderation** — a content-moderation gate (`auto`/`low`) governs
  generation; blocks surface as `moderation_blocked` (§8). It is a gate,
  not a controllable output parameter through the prompt path.
- **edits / reference images / masks** — gpt-image-2 supports image edits
  with one+ reference images and an optional alpha **mask**, but Codex's
  integrated tool does **not** expose them through the prompt path:
  treat as **unsupported through Codex / deferred** (a direct-API path is
  out of scope, ADR-0037 Alternative 6).
- **n (multiple images)** — prompt-mediated best-effort; the run may
  return fewer/more files than requested (§4 verifies actual outputs).
- **partial_images (streaming, 0–3)** — not surfaced through the Codex
  prompt path: **deferred**.

---

## 6. Prompt-rendered-parameter record (`plugins/image/docs/parameter-probe.md`)

`compose-core` re-confirms ADR-0037 items 3 (file return via the real,
non-bypassed companion) and 7 (which prompt-rendered parameters Codex
reliably honors) and commits the findings as a durable evidence note at
**`plugins/image/docs/parameter-probe.md`** — plugin-local evidence, NOT a
per-run artifact under the runs root. The note carries a `requested vs
observed` table per parameter (size, quality, format, variant count), with
a best-effort honored/ignored verdict.

---

## 7. Retention / cleanup policy

- The default is **one image** per generation; multi-variant runs
  (`variants > 1`) require explicit cost disclosure + a cap.
- Rejected variants (not `selected` by `image:decide`) are **retained as
  audit artifacts by default**, marked `rejected: true` in the manifest.
- Cleanup is **explicit**, never automatic: a verb may offer to prune
  rejected variants, but must not delete generated images silently.
- The runs root is gitignored — generated images never enter version
  control.

---

## 8. Typed error taxonomy

Verbs classify failures into typed kinds (no blind retry of user/auth
errors):

| kind | meaning | retry posture |
|------|---------|---------------|
| `moderation_blocked` | content-moderation gate refused the prompt/image | surface category/stage; no blind retry |
| `quota_exhausted` | account quota/billing limit hit | surface; no retry |
| `peer_cli_not_found` | Codex CLI / companion not installed (Claude host) | honest-scope failure, no retry |
| `peer_unauthenticated` | Codex present but not authenticated | honest-scope failure, no retry |
| `tool_unavailable` | gpt-image tool not available in the Codex session | honest-scope failure |
| `write_failed` | image could not be written/verified on the shared fs | surface path + reason |

The **honest-scope failure mode** (ADR-0037 Decision 6): where neither
native generation nor a reachable Codex bridge exists, `image:compose`
reports the limitation explicitly rather than failing silently or
pretending a native capability.

---

## 9. Privacy gate

Cross-host image prompts pass an explicit privacy gate (genericize
before dispatch) since the prompt text — and, for `image:critique`, the
attached image file and any reference assets — leaves the local host for
Codex. Only the genericized form leaves the local host.
