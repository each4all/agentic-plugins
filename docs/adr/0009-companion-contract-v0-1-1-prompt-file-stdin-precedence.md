# ADR-0009: Companion contract v0.1.1 — `--prompt-file` and PROMPT_ARG precedence over stdin

## Status

Accepted

## Context

[ADR-0001](0001-hexagonal-architecture.md) places the bidirectional
companion bridges in the COMPANION layer.
[`companions/contract.md`](../../companions/contract.md) v0.1.0 § 2.3
defined prompt-input precedence and conflict rules:

> 1. `--prompt-file <path>` — read prompt from the given file (UTF-8).
> 2. `PROMPT_ARG` — positional argument, used when `--prompt-file` is
>    not given.
> 3. **stdin** — used when neither `--prompt-file` nor `PROMPT_ARG` is
>    given AND stdin is a pipe (not a TTY).
>
> Conflict and missing-input rules (companion MUST exit with
> `companion_misuse`, exit code `2`):
> - Both `--prompt-file` and `PROMPT_ARG` are given.
> - **`--prompt-file` is given AND stdin is a pipe (not a TTY).**
> - **`PROMPT_ARG` is given AND stdin is a pipe (not a TTY).**
> - No flag, no positional argument, AND stdin is a TTY.

The two emphasized rules were intended to protect callers from "I
meant to pipe the prompt but accidentally also passed
`--prompt-file`" mistakes. The original rationale (v0.1.0 § 2.3):
*"silently discarding stdin would hide caller mistakes."*

In practice, **every background-Bash adapter invocation receives a
non-TTY stdin** — the spawned process inherits the parent shell's
piped stdin. When a consumer plugin's adapter dispatches the companion
via Claude Code's `Bash` tool with `run_in_background: true`, the
spawned `node companion.mjs task --prompt-file <path>` always sees
`stdin.isTTY === false`. The companion exits with `companion_misuse`
despite the caller's intent being unambiguous: an explicit
`--prompt-file` is the input source; stdin is incidental.

This pattern is the **normal-path invocation** for every bidirectional
ensemble adapter in this repository — including the research plugin's
`adapters/{claude,codex}/scripts/discover-companion.mjs` callers
invoked from SKILL.md command-invoked mode. The contract v0.1.0 rule
therefore was not protecting against caller mistakes but blocking the
design intent of [ADR-0008](0008-companion-distribution-model.md)'s
distribution model.

**Empirical confirmation (2026-05-04)**: Manual smoke of
`/research:research` on Claude Code 2.1.126 reproduced the failure.
The adapter resolved the codex-companion path via cache-glob (per
ADR-0008 § (b)), wrote the prompt to a tempfile, and invoked
`codex-companion task --prompt-file <tmp> --output-format json` in
background. The companion rejected with stderr `--prompt-file
conflicts with piped stdin` and exit `2` / `companion_misuse`.
Graceful degradation correctly fell back to local-only research, but
the bidirectional ensemble (C.18 Stage 1 exit criterion) did not
round-trip.

Adapter-level workarounds (PTY allocation via `script`, `setsid`)
were rejected as cross-platform fragile and as fighting an over-strict
contract. The right fix is a contract amendment.

## Decision

`companions/contract.md` is amended to **v0.1.1**. The precedence
rules in § 2.3 are restated as **strict precedence** instead of
mutual exclusion:

1. `--prompt-file <path>` — when given, **stdin is ignored**
   regardless of whether stdin is a TTY or pipe.
2. `PROMPT_ARG` — when given (and `--prompt-file` is not), **stdin
   is ignored** regardless of TTY/pipe state.
3. **stdin** — used when neither `--prompt-file` nor `PROMPT_ARG`
   is given AND stdin is a pipe (not a TTY).

Conflict and missing-input rules (companion MUST exit with
`companion_misuse`, exit code `2`):

- Both `--prompt-file` and `PROMPT_ARG` are given.
- No flag, no positional argument, AND stdin is a TTY (no input
  source available).

The two v0.1.0 rules `--prompt-file + stdin pipe` and
`PROMPT_ARG + stdin pipe` are removed. They were defensive against
the wrong threat model: every realistic adapter invocation has a
non-TTY stdin (Bash subprocess inheritance), so the rule fired on
correct usage rather than caller mistakes. Silently ignoring stdin
when an explicit input source is given is the correct precedence
semantics; the rejected v0.1.0 case was caller-mistake protection
that costs more than it saves.

### Compatibility

This is a **patch bump (0.1.0 → 0.1.1)**:

- The change is a strict relaxation: every call valid under v0.1.0
  is still valid under v0.1.1.
- v0.1.1 accepts additional cases (`--prompt-file + stdin pipe`,
  `PROMPT_ARG + stdin pipe`) that v0.1.0 rejected. Callers depending
  on v0.1.0 rejecting these cases would be a contradiction (they'd be
  intentionally constructing the rejected case).
- No exit codes, `error.kind` values, JSON envelope fields, or option
  names change.

`companions/contract.md` § 8.3 SemVer policy previously defined minor
(additive) and major (breaking) bumps. v0.1.1 introduces the patch
case for backward-compatible relaxations / bug fixes; § 8.3 is
amended to make this explicit.

### Implementation

1. `companions/contract.md`: Status block → v0.1.1; § 2.3 rewritten
   per Decision; § 8.3 patch-bump clause added; § 8.1 References cites
   this ADR.
2. `companions/claude-companion.mjs` and `companions/codex-companion.mjs`:
   - `CONTRACT_VERSION = '0.1.1'`
   - `resolvePromptInput()` — remove the two conflict checks
     (`promptFile && stdinIsPipe`, `promptArg && stdinIsPipe`).
3. `plugins/companions/scripts/{claude,codex}-companion.mjs` — synced
   via `npm run sync:companions`; the drift-detection test continues
   to enforce byte equality.
4. `companions/tests/{claude,codex}-companion.test.mjs`:
   - Remove the two `--prompt-file + piped stdin` and
     `PROMPT_ARG + piped stdin` "throws" cases.
   - Add two new cases: "ignores piped stdin when --prompt-file is
     given" (returns the file's content) and "ignores piped stdin when
     PROMPT_ARG is given" (returns the positional argument's content).
5. `.release-please-manifest.json`: `companions` 0.1.0 → 0.1.1,
   `plugins/companions` 0.1.0 → 0.1.1.
6. `plugins/companions/.claude-plugin/plugin.json` and
   `.codex-plugin/plugin.json`: version 0.1.0 → 0.1.1.
7. `.claude-plugin/marketplace.json` companions entry version
   0.1.0 → 0.1.1. The Codex marketplace catalog has no per-entry
   version field, so no change there.

The research plugin's
`adapters/<host>/scripts/discover-companion.mjs` preflight accepts
any major-0 `CONTRACT_VERSION`, so this bump propagates without
consumer-side changes.

## Consequences

**Positive**:
- Bidirectional ensemble round-trip works in normal adapter
  invocations (background Bash and equivalent). Resolves the C.18
  Stage 1 exit criterion blocker for the research plugin.
- Precedence semantics are now strict: explicit input flag >
  positional > stdin. Adapters do not need per-host PTY workarounds.
- Caller mental model is simpler: one explicit input source
  determines the prompt; stdin is consulted only when no other
  source is given.

**Negative**:
- The original protective intent (v0.1.0 conflict rules) is gone.
  A caller that pipes content to a companion while also passing
  `--prompt-file` will see their pipe silently ignored. The
  trade-off is accepted: real callers either pipe OR pass an
  explicit flag, not both.
- One more contract version to track. Future amendments to § 2.3
  must consider both v0.1.0 and v0.1.1 semantics if v0.1.0 is still
  installed in the wild during a transition window.

**Neutral**:
- Test surface adjusts (two cases inverted from "throws" to
  "succeeds"). Drift-detection test continues to enforce byte
  equality between canonical and bundled scripts.

## Alternatives Considered

1. **Adapter-level PTY allocation** — Rejected.
   `script -q /dev/null node companion.mjs ...` allocates a PTY but
   is platform-specific (BSD vs GNU `script` syntax differ;
   `setsid` does not actually allocate a PTY). Any per-host
   workaround would still be fighting an over-strict contract.

2. **New flag `--ignore-stdin`** — Rejected. Adds a flag for a
   behavior that is already implied by the precedence rule.
   Increases the option surface companion implementations and
   callers must coordinate on. Not worth it for a fix this small.

3. **Major bump (0.2.0) instead of patch** — Rejected. The change is
   a strict relaxation with no breaking observable behavior. SemVer
   patch is the right notation for "bug fix in conflict detection."
   Pre-1.0 SemVer additionally allows any change at any bump per the
   contract's own § 8.3, but signaling "patch" communicates the
   right relationship to consumers.

4. **Document v0.1.0 limitation in research plugin's SKILL.md and
   accept the C.18 failure** — Rejected. The contract is the
   foundation for every bidirectional ensemble. An over-strict rule
   in v0.1.0 would block every consumer plugin's normal-path
   invocation. Fix once at the contract level rather than documenting
   and working around in N consumers.

## References

- [ADR-0001](0001-hexagonal-architecture.md) — COMPANION layer
  placement and bidirectional symmetry
- [ADR-0004](0004-companion-ownership.md) — first-party companion
  ownership (this amendment is a maintenance event under that
  ownership)
- [ADR-0008](0008-companion-distribution-model.md) — companion
  distribution model whose normal-path invocation triggered the
  v0.1.0 bug
- [`companions/contract.md`](../../companions/contract.md) — wire
  spec v0.1.1 (post-amendment)
- [`AGENTS.md`](../../AGENTS.md) § ADR process — procedural context
  for this amendment
