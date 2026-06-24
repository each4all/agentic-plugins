# ADR-0037: `image` capability plugin — cross-host image generation via the companion bridge

## Status

Proposed

## Context

A real demand arrived (2026-06-23): the user wants an image-generation
capability in agentic-plugins, motivated by Codex's native `gpt-image`
support. This is the first concrete demand for image generation, and it
forces the design decisions that ADR-0010 anticipated but left as future
work.

Forces at play:

1. **The capability is host-asymmetric.** Codex CLI exposes
   `image_generation` (feature flag `stable true`) as an **in-session
   model tool** (gpt-image) — there is no dedicated `codex image` CLI
   command; the model invokes the tool during a turn (`codex exec
   --image` is for *attaching* input images, not generating). Claude
   Code has **no native image generation** (Claude models do not produce
   images). This sits squarely on [ADR-0001](0001-hexagonal-architecture.md)'s
   "honest scope / no false unification" boundary.

2. **ADR-0010 already anticipated this plugin.**
   [ADR-0010](0010-plugin-boundary-policy.md) §6 Trigger 2 (distinct
   cost/quota/auth profile) names image generation explicitly — "image
   generation has external-API quotas, billing implications, and
   prompt-engineering complexity that engineering tooling doesn't … future
   example: `image` plugin" — and §7 (name policy) lists `image` as the
   sanctioned **L2 capability** name (activity/domain noun, not an
   artifact-noun). §6 framed the example as "separated from `designer`
   after design ships," but the trigger itself is the cost/quota profile,
   which holds **independently** of whether `designer` exists.

3. **Demand-triggered, not speculative.** The project's discipline is to
   add capabilities when real demand arrives, not to pre-build. `designer`
   remains deferred for lack of demand; the image-generation demand is
   distinct and concrete.

4. **Feasibility is confirmed.** A spike on 2026-06-23 ran the
   companion's exact non-interactive mode —
   `codex exec --skip-git-repo-check --ephemeral --cd <dir> "<generate +
   save prompt>"` — and Codex fired gpt-image and wrote a valid
   `256×256` RGB PNG (57 KB) to the working directory, self-reporting the
   path, size, and dimensions. The spike used
   `--dangerously-bypass-approvals-and-sandbox` only to skip the
   first-use trust prompt on an untrusted temp cwd; writing within a
   `workspace-write` sandbox in a trusted workspace is expected to work
   without the bypass, to be re-confirmed during integration.

5. **The user's framing fixes the shape.** The user wants a *general
   image-generation function* as the plugin, with domains (design,
   diagram, marketing, game assets) as *ways of using it*, not as
   separate plugins. That is exactly the L2-capability model
   (persona-agnostic activity reused by multiple personas/profiles).

## Decision

Add **`plugins/image`** as a Layer-2 capability plugin
([ADR-0010](0010-plugin-boundary-policy.md) §6 Trigger 2 + §7). It does
**not** require `designer` to ship first — `designer` stays deferred;
`image` is persona-agnostic and reusable by any future persona
(`designer`, `founder`, `engineer`) and self-serve via its own commands.

1. **Verbs (full six-verb capability).** Canonical names `image:<verb>`,
   the standard six cognitive verbs
   ([ADR-0010](0010-plugin-boundary-policy.md) §2):
   - `image:investigate` — gather visual references, style exemplars,
     and brand/visual constraints.
   - `image:frame` — turn the request into an explicit **image brief**:
     subject, composition, style, palette, aspect ratio, and the desired
     output parameters (size, format, transparency, variant count) plus
     success criteria.
   - `image:decide` — choose among candidate approaches, styles, or
     generated variants under the brief's constraints.
   - `image:compose` — generate the image (the generative core).
   - `image:critique` — evaluate a generated image against the brief
     using vision input (Codex `exec --image <FILE>` attaches the
     generated file back — a clean compose/critique symmetry).
   - `image:refine` — apply critique/feedback and regenerate.

   The capability is designed **full six-verb** to support quality-first
   image work (explicit brief, variant selection, evaluation loop), not a
   bare prompt-to-file shim. The build MAY sequence `compose` first to
   validate the cross-host pipeline, then layer the deliberative and
   evaluation verbs — but the target surface is all six.

2. **Domains are profiles/usage, not plugins.** Design / diagram /
   marketing / game-asset usage are L4 profiles (or caller-supplied
   context) that shape the prompt template, style, aspect ratio, and
   constraints over the *same* capability. No per-domain plugins
   (avoids the artifact-noun anti-pattern of §3/§7).

3. **Cross-host execution via the existing companion bridge.**
   - On **Codex**: native — `image:compose` drives the in-session
     gpt-image tool through `codex exec`.
   - On **Claude**: dispatch through `companions/codex-companion.mjs`
     (the existing Claude→Codex bridge). The generated image is written
     to the **shared filesystem**; the companion's **text** response
     carries the artifact path and metadata (same shared-fs-artifact +
     text-pointer pattern engineer/orchestrator already use for state).
     No new binary channel in `companions/contract.md`.

   This honors the dual-host charter without false unification: Claude's
   path is honestly "image generated by Codex on your behalf," surfaced
   as such, not a pretend-native capability.

4. **Output convention.** Generated images land under a conventional,
   gitignored runs directory (e.g. `.agentic-plugins/runs/image/`) unless
   the caller specifies a path; results are returned by path, never
   inlined as raw bytes into the session.

5. **Privacy gate.** Cross-host image prompts go through the existing
   peer-dispatch privacy gate (genericize before dispatch), since the
   prompt text leaves the local host for Codex.

6. **Honest-scope failure mode.** Where neither native generation nor a
   reachable Codex bridge exists (e.g. Claude host with Codex
   unavailable/unauthenticated), `image:compose` reports the limitation
   explicitly rather than failing silently or pretending.

7. **Generation parameters — prompt-rendered through Codex, structured
   only via direct API.** OpenAI exposes image generation two ways: the
   **Image API** (`images.generate`/`.edit`, caller picks the GPT Image
   model directly, e.g. `gpt-image-2`) and the **Responses API**
   `image_generation` built-in tool (a mainline model such as `gpt-5.5`
   invokes it). **Codex uses the Responses-API tool path.** Empirically
   (probe 2026-06-24) Codex surfaces only the **`prompt`** to the
   session — it does **not** expose `size`, `quality`, `format`,
   `background`, `n`, or edit/mask options as controllable parameters,
   even though the tool itself accepts several of them. The underlying
   **`gpt-image-2`** model supports (per OpenAI's image-generation guide;
   re-confirm at build time):
   - **size** — flexible, *not* a fixed list: any resolution with edges
     multiples of `16px`, max edge ≤ `3840px`, aspect ≤ `3:1`, total
     `655,360`–`8,294,400` px (popular: `1024x1024`, `1536x1024`,
     `1024x1536`, `2048x2048`, 2K/4K, `auto`);
   - **quality** — `low` / `medium` / `high` / `auto`;
   - **format** — `png` (default) / `jpeg` / `webp`, plus
     `output_compression` (0–100) for jpeg/webp;
   - **background** — `opaque` / `auto` only; **`gpt-image-2` does NOT
     support transparent backgrounds** (a regression from `gpt-image-1`);
   - **n** (multiple images), **moderation** (`auto`/`low`), **edits**
     (one+ reference images + optional alpha **mask**), **partial_images**
     (0–3, streaming).

   Therefore `image:frame` captures the desired parameters in the brief;
   through the Codex bridge they are **rendered into the prompt**
   (best-effort — the 2026-06-24 spike confirms a prompt-stated size was
   honored). A **guaranteed structured-parameter contract** (exact size,
   quality tier, format/compression, masked edits) requires a **direct
   OpenAI Images/Responses API** path (API key + org verification, not
   host-native via Codex), kept as a documented option (Alternative 6)
   for fidelity-critical use.

This ADR records the **decision to build**; the build itself is a
multi-deliverable effort (plugin scaffold + verb skills + companion
dispatch glue + adapters + tests + marketplace entries) suited to
`/orchestrator:plan` after this ADR is Accepted. The first build slice
must re-confirm items 3 and 7 through the *actual* `codex-companion`
invocation (no sandbox bypass) — both the file return and which
prompt-rendered parameters Codex reliably honors.

## Consequences

**Positive**:

- Cross-host image generation that reuses existing companion
  infrastructure — no new L1 framework primitive, no `contract.md`
  binary extension.
- Already sanctioned by ADR-0010 §6 Trigger 2 and §7, so the plugin
  boundary and name need no new policy — this ADR *applies* existing
  policy rather than inventing it.
- Opt-in isolation for image generation's distinct cost/quota/
  content-safety profile, exactly the concern §6 Trigger 2 cites.
- `designer`, whenever demand arrives, *composes* this capability
  instead of re-implementing image generation.

**Negative**:

- Image generation carries external-API cost, quota, and
  content-safety concerns the rest of agentic-plugins does not; the
  plugin must surface these (no hidden spend).
- The Claude path pays a Claude→Codex companion round-trip latency, and
  depends on Codex being installed/authenticated on the same machine.
- Binary artifacts live out-of-band on the shared filesystem; callers
  must handle path-based results, and cleanup/retention of generated
  images is a new concern.
- Integration must still confirm the non-bypassed sandbox/approval path;
  the feasibility spike used a bypass flag to isolate the core question.
- Through Codex, generation parameters (size / quality / format / variant
  count) are **prompt-rendered best-effort**, not a structured contract;
  fidelity-critical control needs the direct-API path (Alternative 6).
  Some controls are model-limited regardless — e.g. `gpt-image-2` has no
  transparent-background support.
- Image generation has **real per-image cost** (`gpt-image-2` ≈ $0.005
  low / $0.04 medium / $0.17–0.21 high, size-dependent) and a
  content-moderation gate (`moderation_blocked` with category/stage
  detail); the plugin must surface cost and handle moderation/quota
  errors explicitly — no hidden spend, no blind retry of user errors.

**Neutral**:

- Domains-as-profiles keeps the capability surface small and defers
  per-domain styling to configuration data.
- `image` arriving before `designer` inverts ADR-0010 §6's illustrative
  ordering ("after design ships") but not its logic — Trigger 2 is
  independently sufficient.

## Alternatives Considered

1. **Fold image generation into `designer` as a profile.** Rejected:
   `designer` is deferred for lack of demand, and §6 Trigger 2 (distinct
   cost/quota/auth) independently justifies a separate plugin. Image
   generation is also reusable well beyond the design discipline
   (diagrams, marketing, game assets), so binding it to `designer` would
   under-serve the demand.

2. **Codex-only plugin with a documented host limit.** Rejected as the
   *end state* — it abandons the dual-host charter for a capability that
   the companion bridge can genuinely deliver to both hosts. Retained as
   the explicit **fallback** if integration shows the bridge path is not
   viable in practice.

3. **MCP-based image generation** (an image-gen MCP server usable by
   both hosts). Rejected: introduces a third-party runtime dependency,
   conflicting with the project's zero-dependency lean, and it is not the
   host-native `gpt-image` the user asked for.

4. **Artifact-noun naming** (`image-gen`, `poster`, …). Rejected per
   ADR-0010 §3/§7 — those name a specific output artifact, an
   anti-pattern; `image` is the domain/material noun §7 endorses for an
   L2 capability.

5. **Extend `companions/contract.md` with a binary/image return
   channel.** Rejected as over-engineering: the spike shows a shared-fs
   path + text pointer already suffices, and keeping the contract
   text-only preserves the wire-spec's simplicity (ADR-0009).

6. **Direct OpenAI Images/Responses API for structured parameters.**
   Calling the Image API (`gpt-image-2`) or constructing the Responses
   API `image_generation` tool call directly would give exact control
   over size / quality / format / compression / n / masked edits — which
   the Codex bridge does not surface (Decision 7). Rejected as the
   *default* path: it needs an `OPENAI_API_KEY` plus org verification,
   reintroduces a direct external-service dependency outside the
   host-native/zero-config posture, and duplicates auth Codex already
   holds. Retained as an explicit **opt-in path** (behind a user-provided
   key) for fidelity-critical parameter control if prompt-rendering via
   Codex proves insufficient.

## References

- [ADR-0001](0001-hexagonal-architecture.md) — honest scope / no false
  unification across hosts.
- [ADR-0009](0009-companion-contract.md) — companion wire-spec the
  cross-host dispatch rides on (kept text-only).
- [ADR-0010](0010-plugin-boundary-policy.md) — §6 Trigger 2 (separation
  trigger) and §7 (name policy) that sanction `image` as an L2
  capability.
- `companions/codex-companion.mjs` — the Claude→Codex bridge used for
  the Claude-host path.
- 2026-06-23 feasibility spike — `codex exec` non-interactive gpt-image
  generation producing a valid PNG on the filesystem.
- 2026-06-24 Codex parameter probe — Codex's `image_generation` tool
  surfaces only `prompt`, not structured size/quality/format/background/n.
- OpenAI image-generation guide (`gpt-image-2`) — Image API vs Responses
  API tool, size/quality/format/compression/background/n/moderation/edits
  parameters, per-image cost, and content-moderation error handling.
