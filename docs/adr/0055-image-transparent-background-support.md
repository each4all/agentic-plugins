# ADR-0055: Transparent backgrounds in `image` — verified in the bytes, contracted for PNG; partially supersedes ADR-0037 Decision 7

## Status

Accepted

## Context

[ADR-0037](0037-image-capability-plugin.md) Decision 7 records that
**`gpt-image-2` does not support transparent backgrounds**, and
`plugins/image` enforces it: `BACKGROUNDS = ['opaque', 'auto']` plus a
regex scan that rejects a transparent request found anywhere in a
brief's text fields.

Codex `0.148.0` ships transparency in its integrated imagegen skill, so
that claim was re-tested against the installed pair rather than carried
forward on the ADR's word. The probe is committed at
`plugins/image/docs/transparency-probe.md` with its prompts, manifests,
decoder and checksums beside it. Its verdict was **partial**, and both
halves matter:

- One real companion run produced a genuinely transparent PNG — alpha
  read by decoding the IDAT stream and histogramming every pixel, with
  the decoder control-verified against a real cutout, an all-opaque
  RGBA image and a plain RGB image first. That is an **existential
  proof**: ADR-0037 Decision 7's factual text no longer describes what
  `codex 0.148.0`'s integrated tool does, and the prohibition blocks
  something the host can do.
- It is **not** a reliability or supersession result. Every cell is
  `n = 1`; the probe never recorded which GPT Image backend served the
  request; the JPEG arm's failure cause is unknown; and WebP was never
  tested at all.

The probe also found a **pre-existing guard defect**, independent of
whether transparency is supported. `brief-validate.mjs` tested
`TRANSPARENT_BG_RE` and `NEGATED_RE` against the **whole field**, so a
negation word anywhere disarmed the guard. The probe's own successful
transparent prompt is admitted by `validateBrief`, because it ends
"No backdrop, no white fill".

And the probe closed by naming what a follow-up still had to decide:
schema and precedence, wiring, format policy, what counts as
verification, how an unhonored request is typed, compatibility, and
wording. Relaxing the two constants is not a complete change; each of
those becomes load-bearing the moment transparency is allowed.

## Decision

### 1. Partially supersede ADR-0037 Decision 7

Decision 7's transparency clause — "**`background` — `opaque` / `auto`
only; `gpt-image-2` does NOT support transparent backgrounds**" — is no
longer operatively accurate for the path this project actually uses, so
per `docs/adr/README.md` § *Amendments vs Supersedes* this is a
**supersede**, not an amendment. Only that clause is superseded.
Decision 7's operative core — that Codex surfaces **only the prompt**,
so every generation parameter is prompt-mediated and best-effort — is
untouched and is in fact what the rest of this ADR is built around.

The narrower claim about the **direct `gpt-image-2` model** is neither
confirmed nor denied here: this project only ever reaches the model
through Codex's integrated tool (ADR-0037 Alternative 6), so it has no
evidence either way and makes no claim.

### 2. `output.background` gains `transparent`, and is authoritative

`BACKGROUNDS = ['opaque', 'auto', 'transparent']`. The structured field
is the authority; brief prose is advisory. Precedence:

| `output.background` | prose asks for transparency | outcome |
|---|---|---|
| `transparent` | yes / no | accepted |
| `opaque` | yes | **issue** — a contradiction the prompt would fight |
| `auto` or unset | yes | **warning** — record it in `output.background` |
| any | no | accepted |

The warning exists because an unrecorded request is unverifiable: it
never reaches `requested_parameters`, so nothing can be checked against
the returned bytes.

### 3. Transparency is contracted for PNG only

- `transparent` + `jpeg` — **rejected**. JPEG has no alpha channel.
- `transparent` + `webp` — **rejected**, and for a different reason
  that the message states plainly: WebP *is* alpha-capable, but this
  plugin can only read WebP alpha at the header-flag level, and a
  declared channel is not proof that any pixel uses it. A transparency
  claim this plugin cannot verify is precisely what §4 exists to
  prevent. Admitting WebP needs a real end-to-end probe and a VP8L
  decoder, in that order.
- `transparent` + `png` — the proven path.

Both rejections happen **before** companion discovery, before the run
directory exists, and before any spend.

### 4. Verification reads pixels, not a header flag

`plugins/image/scripts/alpha-inspect.mjs` decodes the returned image
and reports whether any pixel is actually non-opaque.

This follows the rule the plugin already applies to dimensions —
`compose-dispatch.mjs` refuses to trust Codex's stdout and sniffs
width/height off the bytes. A `hasAlpha`-style channel check would be a
*weaker* standard for alpha than the plugin already holds for size, and
it cannot separate a real cutout from an all-opaque RGBA image; the
probe's control fixtures exist to make exactly that distinction.

What a positive result means is stated narrowly: **at least one decoded
pixel is not fully opaque**. That is a byte-level fact, not a judgement
that the background was cut out well — a stray semi-transparent speckle
satisfies it too, and the probe needed a connected-component pass
before it could say anything about cutout quality. No coverage
threshold is set: the probe's 70.4 % and its body alpha of 254 are
content-specific numbers and must not become acceptance criteria. The
**negative** result is the strong one — zero non-opaque pixels means
the request was definitively not honored.

The inspector reports three-valued transparency (`true` / `false` /
`null` for undecided) plus a separate `valid` flag, because a
**malformed** image and a **well-formed image it declines to decode**
are different outcomes and must not collapse into one.

### 5. Two new error kinds

- `unsupported_parameters` — a parameter set rejected before any spend
  (§3, an unknown enum value, an unknown format). Distinct from
  `write_failed`, which correctly described the probe's JPEG arm but
  said nothing about why.
- `background_not_honored` — an **explicit** `transparent` request whose
  returned bytes carry no transparency. `auto` and `opaque` never gate
  on alpha. An undecided inspection never fails: unknown is reported as
  unknown. A file that cannot be decoded at all is `write_failed`, not
  a broken promise.

A file retained after `background_not_honored` goes into a new
`failed_outputs[]`, **not** `images[]`. `variant-select.mjs` and the
decide skill treat every `images[]` entry as a selectable candidate
without consulting `status`, so filing a failure there would let a
rejected output be selected — including by an older installed version
reading the persisted manifest. `failed_outputs[]` is purely additive
and older consumers ignore it.

Manifests also carry `generation_attempted`, so the cost **estimate**
on a pre-flight rejection cannot be read as money spent.

### 6. No version floor — verification by result

No minimum Codex version is required. The probe could not record which
backend served the request, so a version number would be a proxy for a
capability it never measured. §4's byte-level check is a dynamic
capability check *by result*, which is strictly more truthful. It is a
**post-spend** verification, not a pre-spend capability check, and the
contract says so rather than implying otherwise.

### 7. Match-scoped negation, independent candidates

The guard is rebuilt rather than relaxed, because reusing it would
carry its defect into the new path:

- Negation is judged in a **bounded window ending at the match** — a
  negation token then at most three intervening words — instead of
  against the whole field. Punctuation bounds the window naturally.
- Negation **inside** the matched span is also checked, which a
  preceding-only window cannot see (`background: not transparent`).
- Candidate patterns are matched **independently** and may overlap.
  A single alternation let an early negated candidate consume text a
  later un-negated one needed.
- Hyphenated `transparent-background` now matches; it did not before.

## Consequences

- The prohibition is gone, and every path that could previously only
  promise transparency in prose now records it, renders it, and checks
  it. `image:refine` forwards `--background` explicitly rather than
  inheriting it, so a caller that omits it gets an opaque image and a
  plain reason instead of a silently carried-over policy.
- Transparency requests that the model does not honor now **fail**
  rather than succeeding quietly. This is intended: reporting success
  would be the "pretend prompt wording guarantees it" failure ADR-0037
  warned against. With `n = 1` reliability evidence, some legitimate
  runs will fail this way and need a refine iteration.
- The plugin now carries a PNG decoder. Its scope is declared, not
  implied: colour types 0/2/3/4/6, bit depths 1–16, `tRNS`, multi-IDAT;
  interlaced PNG is refused with a reason unless the colour type makes
  transparency impossible anyway; APNG animation frames are not walked.
  It is bounded twice against decompression bombs — against the size
  IHDR implies, before inflating, and by `maxOutputLength` during.
- Alpha is inspected on every successful generation. The claim that
  this is negligible was **measured, not assumed**: the worst case (an
  all-opaque image, so no early exit) at the largest size `gpt-image-2`
  can produce is **36 ms**, against a generation that takes tens of
  seconds and costs money.
- **A known gap is left open deliberately.** `compose-dispatch` does not
  scan its prompt text for an unrecorded transparency request, so the
  prose→dispatch path is still unenforced; only brief validation sees
  it. Enforcing it there was prototyped and rejected: the `alpha
  channel` pattern would block a legitimate generation whose subject is
  a diagram *about* alpha channels, and a blocked generation is a worse
  failure than an unrecorded request. Closing it properly needs one
  shared intent resolver used by validation, compose, refine and the
  native Codex path — a follow-up, recorded rather than pretended away.
- Two predictions from cross-host review were **refuted by measurement**
  and are recorded so they are not re-derived: that the hyphenated
  `non-transparent background` row would fail (it passes — measured
  across all 22 rows), and that per-run alpha inspection would be a
  material runtime cost (36 ms worst case). Both had been asserted
  confidently; neither survived a measurement.

## Alternatives Considered

1. **Amend ADR-0037 in place.** Rejected on the repository's own
   discriminator: `README.md` § *Amendments vs Supersedes* reserves
   amendment for when the original Decision prose stays *operatively
   accurate*. Decision 7's transparency clause is being reversed, so a
   reader landing on ADR-0037 must be pointed here.

2. **Header-flag alpha detection only** (read PNG colour type / the
   WebP ALPHA bit, no decode). Rejected: it cannot distinguish a real
   cutout from an all-opaque RGBA image — the exact failure the probe
   built control fixtures to expose — and it would hold alpha to a
   weaker standard than the dimensions this plugin already sniffs.

3. **Allow `transparent` + `webp` with a warning.** Rejected. It spends
   money on a result the plugin can never verify, which contradicts §4.
   Warnings also have no channel on the direct dispatch path, so the
   caution would not reach the person paying for the run.

4. **Retain a failed transparent output inside `images[]`** with a
   `status` guard added to consumers. Rejected as a breaking, rollback-
   unsafe schema change: an older installed version reading a persisted
   manifest would make the failed file selectable again.
   `failed_outputs[]` is additive and needs no consumer change.

5. **A minimum Codex version floor.** Rejected — see §6. Nothing in the
   evidence ties the capability to a version.

6. **Record a non-opaque pixel count** rather than an early-exit
   boolean. Rejected: a count invites the same over-reading the probe
   warned about — it still carries no spatial information, so it cannot
   distinguish a clean cutout from scattered speckle — while forcing a
   full scan on every image. The boolean plus an explicit statement of
   what it does not mean is more honest and cheaper.

## References

- [ADR-0037](0037-image-capability-plugin.md) — the `image` capability
  plugin; Decision 7's transparency clause is superseded here.
- `plugins/image/docs/transparency-probe.md` — the 2026-08-23 probe,
  with raw prompts, manifests, decoder and checksums under
  `docs/evidence/transparency-probe-20260823/`.
- `plugins/image/docs/contracts.md` §3–§5, §8 — the brief, manifest,
  parameter and error-taxonomy surfaces this decision changes.
- [PNG specification](https://www.w3.org/TR/png-3/) — colour types, bit
  depths, filtering and `tRNS` semantics the inspector implements.
