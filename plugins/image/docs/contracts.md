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
    "size":       "string — e.g. 1024x1024 (edges multiple of 16, max edge <=3840, aspect <=3:1)",
    "quality":    "low | medium | high | auto",
    "format":     "png | jpeg | webp",
    "background": "opaque | auto | transparent — transparent is png-only (§5)",
    "variants":   "integer >= 1 — number of images to generate (n)"
  },
  "success_criteria": ["string — what 'good' means; used by image:critique"],
  "constraints":      ["string — hard constraints / things to avoid"]
}
```

`image:frame` MUST warn or reject brief fields that gpt-image-2 cannot
honor (see §5).

**`output.background` is authoritative over brief prose** (ADR-0055 §2).
Prose is still scanned, but only to catch a request the structured field
never recorded — an unrecorded request never reaches
`requested_parameters`, so nothing can check it against the returned
bytes:

| `output.background` | prose asks for transparency | `validateBrief` |
|---|---|---|
| `transparent` | yes / no | accepted |
| `opaque` | yes | **issue** — a contradiction the prompt would fight |
| `auto` or unset | yes | **warning** — record it in `output.background` |
| any | no | accepted |

---

## 4. `ImageResult` run manifest (`manifest.json`, written by `image:compose` / `refine`)

```json
{
  "run_id":   "image-<iso-utc>-<rand>",
  "host":     "codex | claude",
  "status":   "success | error",
  "brief_ref": "brief.json | null",
  "prompt":   "string — the exact prompt rendered for Codex's gpt-image tool",
  "requested_parameters": { "size": "…", "quality": "…", "format": "…", "background": "opaque | auto | transparent | null", "variants": 1 },
  "observed_parameters":  {
    "width": "integer | null", "height": "integer | null", "format": "png | jpeg | webp",
    "background": "transparent | opaque | null — read from the bytes, null when undecided",
    "alpha": { "format": "…", "valid": "boolean", "channel": "boolean | null", "transparent": "boolean | null", "source": "pixels | flag | format | null", "reason": "string | null" },
    "note": "best-effort; some requested params may be silently ignored (§6)"
  },
  "generation_attempted": "boolean — false when a pre-flight rejection returned before the companion ran, so `cost` cannot be read as spend",
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
  "failed_outputs": ["same shape as images[] — a file that landed but failed verification"],
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

**`images[]` stays candidates-only.** `variant-select.mjs` and the
decide skill treat every `images[]` entry as a selectable candidate
*without* consulting `status`, so a file that landed but failed
verification is filed under `failed_outputs[]` instead — retained,
because it exists and was paid for, but never selectable. The field is
purely additive; a consumer that does not know it ignores it
(ADR-0055 §5).

**Alpha observation (ADR-0055 §4).** `observed_parameters.alpha` is
recorded on every successful generation, whatever the requested
background, and is read from the **pixels** — the same standard this
plugin already applies to dimensions. `transparent: true` means *at
least one decoded pixel is not fully opaque*: a byte-level fact, **not**
a judgement that the background was cut out well. No coverage threshold
exists, deliberately. `valid: false` separates a malformed image from a
well-formed one the inspector declines to decode (interlaced PNG, WebP
pixel data), which is why an undecided result never becomes a failure.

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
- **background** — `opaque` / `auto` / `transparent`
  ([ADR-0055](../../../docs/adr/0055-image-transparent-background-support.md)).
  A 2026-08-23 probe decoded a genuinely transparent PNG out of Codex
  `0.148.0`'s integrated tool (`transparency-probe.md`), so the earlier
  blanket prohibition no longer describes the installed pair. The
  contract that replaces it:
  - **`transparent` is png-only.** JPEG has no alpha channel. WebP *is*
    alpha-capable, but this plugin reads WebP alpha only at the
    header-flag level, and a transparency claim it cannot verify is
    exactly what this contract exists to prevent — so `transparent` +
    `webp` is rejected as unverified-here, not as impossible. Both
    rejections happen before discovery, before the run dir, before spend.
  - **The result is checked, never assumed.** An explicit `transparent`
    request whose bytes carry no transparency is
    `background_not_honored` (§8) — prompt wording still guarantees
    nothing, which is the part of ADR-0037 Decision 7 that stands.
  - **There is no minimum Codex version.** The probe could not record
    which backend served the request, so a version floor would proxy a
    capability nobody measured. The byte check is a **post-spend
    verification**, not a pre-spend capability check.
  - **Known gap:** the direct `compose-dispatch` path does not scan its
    prompt text for an unrecorded transparency request — only brief
    validation does. Blocking there was rejected because the
    `alpha channel` pattern would refuse a legitimate diagram *about*
    alpha channels (ADR-0055 §Consequences).

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
| `malformed_envelope` | companion returned non-JSON / unparseable output | surface; no retry |
| `peer_run_error` | companion ran but failed for another (non-typed) reason | surface detail; no blind retry |
| `unsupported_parameters` | the requested parameter set cannot be honored — rejected **before any spend** | fix the parameters; nothing was generated |
| `background_not_honored` | an **explicit** `transparent` request whose returned bytes carry no transparency | the file is retained in `failed_outputs[]`; retry via `image:refine` |

**Alpha outcomes, in full** (ADR-0055 §5). Only an explicit
`transparent` request is gated at all; `auto` and `opaque` record the
observation and never fail on it:

| requested | `alpha.valid` | `alpha.transparent` | outcome |
|---|---|---|---|
| `transparent` | `true` | `true` | `success` |
| `transparent` | `true` | `false` | `background_not_honored` — the definite negative |
| `transparent` | `true` | `null` | `success`, with `observed_parameters.background: null` and `alpha.reason` — unknown is not failure |
| `transparent` | `false` | any | `write_failed` — the image could not be decoded, so nothing could be verified |
| `auto` / `opaque` / unset | any | any | `success` — the observation is recorded, never gated |
| any (pre-flight) | — | — | `unsupported_parameters`, `generation_attempted: false`, no run dir |

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
