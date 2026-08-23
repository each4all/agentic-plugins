# `image:compose` — transparent-background probe (ADR-0037 Decision 7 re-test)

ADR-0037 Decision 7 states that **`gpt-image-2` does NOT support transparent
backgrounds**, and `scripts/brief-validate.mjs` enforces that:
`BACKGROUNDS = ['opaque', 'auto']` plus a `TRANSPARENT_BG_RE` scan of the
brief's text fields. Codex `0.148.0` ships transparency in its imagegen skill,
so the prohibition needed re-testing against the installed pair rather than
being carried forward on the ADR's word.

Plugin-local evidence, not a per-run artifact (`docs/contracts.md` §6).
**Read-only probe — no behaviour changed in this slice.**

Raw prompts, manifests, the decoder and image checksums are committed beside
this note under `evidence/transparency-probe-20260823/`.

## Verdict — **partial**

One real companion run produced a genuinely transparent PNG. That is an
existential proof: transparency **can** come through the installed pair, so
ADR-0037 Decision 7's factual text no longer describes `codex 0.148.0`'s
integrated tool, and the current prohibition blocks something the host can do.

It is **not** a reliability, contract, or supersession result:

- every cell is `n = 1`, unreplicated;
- the probe never records **which** GPT Image backend the integrated tool
  selected, and ADR-0037 distinguishes the direct model from the integrated
  tool — so this cannot by itself retire the ADR's claim about `gpt-image-2`;
- the JPEG failure's **cause** is unknown (see below);
- there is no structured way to request, validate, or record transparency in
  this plugin today.

Formal supersession requires an ADR and a status change (`AGENTS.md` §ADR
process), not this note.

## Installed pair

- Claude Code → `compose-dispatch.mjs` (`plugins/image` 0.2.0) →
  `codex-companion` (`plugins/companions` 0.4.0) → Codex's integrated
  `image_gen.imagegen` tool.
- `codex-cli 0.148.0`. Strings were read from
  `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` (205 MB) —
  **not** the 7 KB `bin/codex.js` shim that `readlink -f` resolves to.
- Date: 2026-08-23.

## Runs

Transparency was requested in the free-text image description, since there is
no argument to request it with (see *Wiring*).

| run | format | background wording | run id | result |
|-----|--------|--------------------|--------|--------|
| **T1** | png | explicit transparent | `image-20260823T041514Z-8018a8` | real alpha, 411,928 B, 1254×1254 |
| **C1** | png | explicit opaque (light grey) | `image-20260823T041935Z-d77afa` | RGB, no alpha channel, 919,075 B |
| **T2** | jpeg | explicit transparent | `image-20260823T041938Z-910d59` | no file written; `error.kind = write_failed` |
| **C2** | jpeg | explicit opaque (light grey) | `image-20260823T042203Z-f22a21` | jpeg written, 158,930 B, `hasAlpha: no` |

**What this design does and does not license.** C1 is an *explicit-opaque* arm,
not a default arm: its prompt asks for "a plain solid light-grey background".
So these runs are consistent with prompt-mediated transparency — an explicit
transparent request yielded alpha, an explicit opaque request did not — but they
say nothing about Codex's behaviour when the background is left **unmentioned**.
A no-background arm is missing. Likewise C2 shows JPEG succeeding once; it does
not establish that T2 failed *because* of the transparency request. C1 and T2
also ran concurrently, three seconds apart.

## Alpha evidence — decoded pixels, not `hasAlpha`

`hasAlpha: yes` only says the channel exists; it cannot separate a real cutout
from an RGBA image whose every pixel is opaque. The probe therefore decodes the
IDAT stream (zlib + PNG un-filtering) and histograms the actual alpha byte of
every pixel. The decoder (`evidence/.../inspect_alpha.py`) was control-verified
first against three synthesized PNGs — a real cutout, an all-opaque RGBA, and a
plain RGB — and separates all three.

**T1** — `color_type 6`, no `tRNS`, 1,572,516 px:

| alpha | pixels | share |
|-------|-------:|------:|
| `0` | 1,107,066 | 70.40 % |
| `1–250` | 18,723 | 1.19 % |
| `251–254` | 444,719 | 28.28 % |
| `255` | 2,008 | 0.13 % |

**C1** — `color_type 2 (rgb)`: no alpha channel at all.

A histogram carries no spatial information, so it cannot by itself say which
pixels are subject, edge, or speckle. A 4-connected component pass over the
non-transparent pixels gives **859 components**: the largest holds 463,163 px —
**99.51 %** of all non-transparent pixels — and the remaining 858 hold 2,287 px
(0.15 % of the image). So T1 is one clean cutout plus scattered speckle, and the
`1–250` band is a mixture of true edge and that speckle, not edge alone.

Two narrower readings survive. The alpha is **request-linked**: the same subject
rendered RGBA under a transparent request and RGB under an opaque one. And the
cutout body sits at **254, not 255** — a strict "subject alpha must be 255"
assertion would fail on a correct image.

## Host contract — reported, not selected (qualified)

`compose-dispatch.mjs` source settles the plugin side deterministically; the
host side below is a weaker, string-derived observation and should be read as
such.

From the binary's strings:

- > `- **Default built-in tool mode (preferred):** built-in image_gen tool for
  >   image generation, editing, and transparent-image requests.`
- > `- For transparent images, ask built-in image_gen for a transparent
  >   background and preserve the generated alpha.`
- `struct ImagegenArgs with 3 elements` → `prompt`, `referenced_image_paths`,
  `num_last_images_to_include`.
- `ImageGenerationEndEvent` / `ImageGenerationItem` carry
  `transparent_background` / `transparentBackground`.

The safe inference is that the **model-visible** argument surface exposes no
background parameter, and that an end-event field by that name exists. Strings
cannot prove there is no internal, prompt-derived, or post-processing background
selection, nor that the event field is purely observational. A
`low|medium|high|auto|transparent|opaque` enum run does sit adjacent to
`ImagegenArgs` in the string table; adjacency in a string blob is not ownership,
and the 3-element struct argues against it — recorded so a later reader does not
re-derive it as a parameter, and does not treat its absence as proven either.

## Wiring — free text carries it; nothing structured does

`buildPrompt(userPrompt, outPath, format, size, quality)` renders `size` and
`quality` into prose and has no background channel; the CLI exposes `--format`,
`--slug`, `--size`, `--quality` and no `--background`. But `userPrompt` is
passed through verbatim, and that is exactly how T1 succeeded. The accurate
claim is therefore: **there is no structured, validated, version-gated
background argument, CLI flag, or manifest field** — not that the plugin cannot
carry transparency at all.

Note also that the direct `compose-dispatch` path does not invoke
`brief-validate`; validation is instructed by the frame skill, not enforced by
the dispatcher.

## Guard defect — demonstrated by this probe's own treatment prompt

`brief-validate.mjs` tests both patterns against the **whole field**:

```js
if (TRANSPARENT_BG_RE.test(f) && !NEGATED_RE.test(f)) { /* reject */ }
```

Because `NEGATED_RE` is not scoped to the match, any negation word elsewhere in
the same field disarms the guard. **T1's own prompt is admitted by
`validateBrief`**: it asks for "a fully transparent background with a real alpha
channel" and then says "No backdrop, no white fill", and that `No` clears the
guard. The successful treatment run therefore exercises the defect, which means
the sentence "the free-text route is what `brief-validate` rejects" is false as
stated — it rejects *some* wordings.

| field text | guard | correct? |
|---|---|---|
| `transparent background` | rejects | ✓ |
| `no transparent background` | passes | ✓ constraint, not a request |
| `transparent watercolor wash on paper` | passes | ✓ material adjective |
| `a glass bottle on a transparent background` | rejects | ✓ it does contain the request |
| **`transparent background, not opaque`** | **passes** | **✗ an explicit request, admitted** |
| **T1's prompt (above)** | **passes** | **✗ an explicit request, admitted** |

This is a pre-existing defect, independent of whether transparency is supported.

## JPEG — correctly typed, cause unrecorded

T2 wrote no file and the dispatcher returned `write_failed`. That type is
**correct** for what the dispatcher can observe: `docs/contracts.md` defines it
as "image could not be written/verified on the shared fs". The gap is upstream —
the dispatcher discards the successful companion envelope's stdout, so Codex's
own explanation was never retained. "Format/alpha incompatibility" is therefore
a hypothesis, not a finding. WebP is alpha-capable and was **not** tested.

## What this does not establish

One prompt, one subject, one host version, one run per cell, run partly
concurrently. It does not establish reliability across styles or sizes, the
default (background-unmentioned) behaviour, that the 254 body alpha is stable,
WebP behaviour, the JPEG failure's cause, which backend model served the
request, or anything about a direct API `background` parameter — this probe only
ever went through Codex's integrated tool, per ADR-0037 Alternative 6.

The decoder is also fit for this file, not for production: its synthetic
fixtures are filter-0, single-IDAT, 8-bit, non-interlaced, and it exercises
neither `tRNS`, palette, 16-bit, multi-IDAT, nor CRC validation.

## What a follow-up slice still has to decide

Relaxing `BACKGROUNDS` or `TRANSPARENT_BG_RE` is **not** a complete change. Each
of these becomes load-bearing the moment transparency is allowed:

- **Schema** — `output.background` is validated in code but absent from the
  documented `ImageBrief`; a top-level `background` is also scanned. Defaults,
  precedence, and conflict with contradictory free text are undefined.
- **Wiring** — `--background`, a dispatch option, `buildPrompt` wording,
  `requested_parameters` / `observed_parameters`, and refine propagation need
  one contract.
- **Format policy** — reject transparent+JPEG before spend, offer a consented
  switch to PNG/WebP, or add a typed incompatibility error; WebP needs a real
  end-to-end alpha probe first.
- **Verification** — decide what counts as success (channel present? any pixel
  below 255? meaningful transparent coverage? spatial cutout quality?) and
  support RGBA, grayscale+alpha, `tRNS`, palette PNG and WebP. The 254-body and
  70 %-coverage numbers here are content-specific and must not become thresholds.
- **Observation** — whether the companion can surface the
  `transparent_background` event, whether bytes stay authoritative, and how
  "opaque output despite a transparent request" is typed.
- **Compatibility** — a minimum Codex version versus a dynamic capability probe,
  behaviour on older installs, and native-Codex parity.
- **Wording** — the minimal reliable phrasing, and mixed/negated resolution.
  Reusing the current regex for transparent+format validation would carry the
  bypass above straight into the new code path.
