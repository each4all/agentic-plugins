# `image:compose` — transparent-background probe (ADR-0037 Decision 7 re-test)

ADR-0037 Decision 7 states that **`gpt-image-2` does NOT support transparent
backgrounds** (recorded as a regression from `gpt-image-1`), and
`scripts/brief-validate.mjs` enforces that: `BACKGROUNDS = ['opaque', 'auto']`
and `TRANSPARENT_BG_RE` reject a transparent-background request anywhere in a
brief's text fields. Codex `0.148.0` ships native transparency in its imagegen
skill, so the prohibition needed re-testing against the installed pair rather
than being carried forward on the ADR's word.

This note records that re-test. It is plugin-local evidence, not a per-run
artifact (`docs/contracts.md` §6), and it is a **read-only probe** — no
behaviour changed in this slice.

## Installed pair

- Claude Code → `compose-dispatch.mjs` (`plugins/image` 0.2.0) →
  `codex-companion` (`plugins/companions` 0.4.0) → Codex's integrated
  `image_gen.imagegen` tool.
- `codex-cli 0.148.0`. Probed binary:
  `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` (205 MB) —
  **not** the 7 KB `bin/codex.js` shim that `readlink -f` resolves to.
- Date: 2026-08-23.

## Runs — a 2×2, because one cell proves nothing

Transparency was requested in the free-text image description, since there is
no parameter to request it with (see *Wiring* below). Both controls succeeded,
so both effects are attributable rather than incidental.

| run | format | transparency asked? | run id | result |
|-----|--------|--------------------|--------|--------|
| **T1** | png | yes | `image-20260823T041514Z-8018a8` | **real alpha**, 411,928 B, 1254×1254 |
| **C1** | png | no (control) | `image-20260823T041935Z-d77afa` | RGB, **no alpha channel at all**, 919,075 B |
| **T2** | jpeg | yes | `image-20260823T041938Z-910d59` | **no file written**, `error.kind = write_failed` |
| **C2** | jpeg | no (control) | `image-20260823T042203Z-f22a21` | jpeg written, 158,930 B, `hasAlpha: no` |

## Alpha evidence — decoded pixels, not `hasAlpha`

`hasAlpha: yes` only says the channel exists; it cannot distinguish a real
cutout from an RGBA image whose every pixel is opaque. The probe therefore
decodes the IDAT stream (zlib + PNG un-filtering) and histograms the actual
alpha byte of every pixel. The decoder was control-verified first against three
synthesized PNGs — a real cutout, an all-opaque RGBA, and a plain RGB — and
separates all three.

**T1** (`color_type 6`, no `tRNS`, 1,572,516 px):

| alpha | share | reading |
|-------|-------|---------|
| `0` | **70.40 %** | background, fully transparent |
| `251–254` | 28.28 % | leaf body (254 ≈ 99.6 % opaque) |
| `1–250` | 0.81 % | anti-aliased edge |
| `255` | 0.13 % | — |

**C1**: `color_type 2 (rgb)` — the file carries no alpha channel whatsoever.

Two things follow. The transparency in T1 is **caused by the request**: Codex's
default output is RGB, and it switched to RGBA only when asked. And the subject
lands at **254, not 255** — a strict "subject alpha must be 255" assertion would
fail on a correct image.

## Host contract — transparency is reported, not requested

From the binary's own strings:

- > `- **Default built-in tool mode (preferred):** built-in image_gen tool for
  >   image generation, editing, and transparent-image requests.`
- > `- For transparent images, ask built-in image_gen for a transparent
  >   background and preserve the generated alpha.`
- `struct ImagegenArgs with 3 elements` → `prompt`,
  `referenced_image_paths`, `num_last_images_to_include`. **There is no
  background parameter.**
- `ImageGenerationEndEvent` / `ImageGenerationItem` carry
  `transparent_background` / `transparentBackground` — the outcome is
  **reported back**, not selected.

A `low|medium|high|auto|transparent|opaque` run of enum values does appear
adjacent to `ImagegenArgs` in the string table. Adjacency in a string blob is
not ownership, and the 3-element struct rules it out; it is recorded here only
so a future reader does not re-derive it as a parameter.

## Wiring — nothing in this plugin can carry it today

`buildPrompt(userPrompt, outPath, format, size, quality)` renders `size` and
`quality` into prose and has **no background channel**; the CLI exposes
`--format`, `--slug`, `--size`, `--quality` and no `--background`. So the only
route is the free-text description — which `brief-validate.mjs` rejects.

## Guard defect found while probing the wording rules

`brief-validate.mjs` tests both patterns against the **whole field**:

```js
if (TRANSPARENT_BG_RE.test(f) && !NEGATED_RE.test(f)) { /* reject */ }
```

Because `NEGATED_RE` is not scoped to the match, **any** negation word elsewhere
in the same field disarms the guard:

| field text | guard |
|---|---|
| `transparent background` | rejects ✓ |
| `no transparent background` | passes ✓ (a constraint, correctly) |
| `transparent watercolor wash on paper` | passes ✓ (material adjective, correctly) |
| **`transparent background, not opaque`** | **passes ✗ — an explicit request, admitted** |
| `a glass bottle on a transparent background` | rejects — arguably right, but for the wrong reason |

This is a pre-existing defect independent of the transparency question: the
guard is bypassable by adding an unrelated `no` / `not` / `without` / `opaque`
to the field.

## Verdict

**Supported** on the installed pair, for PNG — with two qualifications that
matter more than the headline:

1. **Prompt-mediated, not parameterised.** Consistent with ADR-0037's
   prompt-mediation model, but it means transparency cannot be requested,
   validated, or recorded as a parameter until `buildPrompt` and the brief
   schema gain a background channel.
2. **Alpha-incapable formats fail silently and are mis-typed.** T2 wrote no
   file, and the dispatcher reported `write_failed` — "Codex reported success
   but no image is at the expected path". C2 rules out a general jpeg fault, so
   the trigger is the transparency request. The taxonomy blames the writer for
   what is a format/alpha incompatibility.

ADR-0037 Decision 7's factual claim is **superseded for `codex 0.148.0`**. The
`BACKGROUNDS`/`TRANSPARENT_BG_RE` prohibition now blocks a capability the host
has.

## What this does not establish

One prompt, one subject, one host version. It does not establish that every
style or size yields a clean cutout, that the 254-not-255 subject alpha is
stable, that webp behaves like jpeg (untested), or anything about
`gpt-image-2`'s API-level `background` parameter — this probe only ever went
through Codex's integrated tool, per ADR-0037 Alternative 6.
