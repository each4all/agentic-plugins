# ADR-0028: Engineer Phase 7 commit automation

## Status

Proposed

> ADR number 0027 was ceded to
> [`0027-decide-skill-multi-axis-evolution.md`](0027-decide-skill-multi-axis-evolution.md)
> (PR #346), which opened mid-plan. This ADR documents the same EPCC
> closure macro Phase 7 work under the next free number. The macro's
> worktree counterpart (originally reserved as ADR-0028) shifts to
> ADR-0029.

## Context

`/engineer:start` Phase 7 today writes a single `set-terminal` frontmatter
mutation and then asks the human to compose the actual git commit by hand
(`plugins/engineer/commands/start.md` Phase 7 + `skills/start/SKILL.md`
Phase 7 mirror). The Stop hook attempts a soft conventional-commit warning
gate via an inline regex copy (`plugins/engineer/scripts/stop-archive.mjs`
line 230 and `plugins/engineer/adapters/claude/hooks/_shared.mjs` line 83
each carry their own `CONVENTIONAL_COMMIT_RE`).

Manual Phase 7 has three recurring failure modes:

1. **CC regex duplication drift.** Two inline copies of the regex live in
   `plugins/engineer`. The pattern lacks `!` breaking support. A future
   refinement (e.g., the trailer-allowlist policy below) cannot land
   atomically without touching both copies.
2. **Cross-package routing surprises.** ADR-0016 §"Cross-package commit
   splitting" documents that a single commit footer routes to every
   release-please package whose tracked path the commit touches. The
   current human gate is reviewer attention. Routing knowledge lives in
   prose (`AGENTS.md` lines 214–230) — not in any pre-push automation —
   and is already out of sync (AGENTS.md states 4 tracked packages while
   `release-please-config.json` declares 5).
3. **Premature terminal-archive risk.** ADR-0017 sub-decision 5
   auto-archive triggers when `terminal_marker: true` and HEAD moved past
   `git_baseline.head`. The current Phase 7 path writes `set-terminal`
   *before* the user has actually run `git commit`, so the gate depends
   on HEAD movement to suppress the archive. A user who closes the
   session between `set-terminal` and the manual commit is not yet
   archived (HEAD did not move), but the workflow's `next_action` no
   longer truthfully describes the next step.

The EPCC lifecycle closure macro plan
(`macro-plan-20260518T233055Z-276fb4`) raised this as the trigger for an
explicit Phase 7 commit automation policy. The compose phase ran six
ensemble rounds (`plan-verify` → `review` → 3× `refine-verify` → `decide`
brainstorm) and absorbed 30 finding-resolution items. The `decide`
ensemble (run-id `brainstorm-20260519T015539Z-67bc658`) crystallized three
peer-and-self-AGREED architectural archetypes — clean-baseline
precondition (peer A1 + self I4), workflow-recorded manifest (peer A2 +
self I1+I5), and explicit user commit scope (peer A3 + self I3) — into a
single 3-layer defense. The user resolved the primary fork at Phase 2 of
that decide round by selecting **F2 (PR1-full, all three layers)** over
**F1 (PR1-minimum, layers 1+3 only)** and **F3 (defer Phase 7 entirely)**.

This ADR records the resulting policy. The implementation slice lands as
the EPCC macro's PR1; the worktree slice (`/runtime:worktree` apply +
engineer Phase 0 hook) lands as PR2a/PR2b under ADR-0029.

## Decision

Phase 7 of `/engineer:start` automates the commit step under fourteen
explicit policies and a three-layer defense architecture. The
implementation is a host-shared driver
(`plugins/engineer/scripts/phase7-commit.mjs`) invoked by both the
Claude command bootstrap (`commands/start.md` Phase 7) and the Codex
skill narration (`skills/start/SKILL.md` Phase 7) — consistent with
ADR-0022's commands-hold-bootstrap / skills-hold-cognition split. All
conventional-commit regex usage centralizes in
`plugins/engineer/scripts/validate-commit.mjs`; the two existing inline
copies become re-exports.

### Architecture — F2 three-layer defense

#### Layer 1 — Phase 0 clean-baseline check

`/engineer:start` Phase 0 inspects `git status --porcelain` at workflow
START, *before* `state.mjs create`. When the tree is dirty (tracked
modifications, staged changes, or untracked files excluding the
`.agentic-plugins/state` workflow storage), Phase 0 refuses to bootstrap
and presents four resolutions:

- **clean** — abort and let the user reset
- **stash** — `git stash push --include-untracked` then resume
- **worktree** — escalate to `/runtime:worktree` apply (ADR-0029)
- **accept-current-tree** — bypass via `ACCEPT_CURRENT_TREE=1` env-var
  (the workflow's commit will sweep whatever was in the tree; the user
  acknowledges this)

The Layer 1 gate is the source of truth for the "intended" signal:
post-baseline changes ARE workflow-intended by construction. Layer 3
relies on this property.

#### Layer 2 — Phase 4 / Phase 6 manifest recording

Frontmatter schema bumps from 1.1 to 1.2 with one additive optional key:

```yaml
commit_manifest:
  - path: "plugins/engineer/scripts/validate-commit.mjs"
    phase: "compose"
    op: "create"
    recorded_at: "2026-05-19T04:00:00Z"
```

The schema bump is additive: schema 1.1 readers (legacy active workflows,
host_history snapshots from earlier sessions) MUST continue to read the
file when `commit_manifest` is absent. Schema 1.2 emitters MAY omit the
key when no manifest entries exist (compatible with pre-1.2 files).
`state.mjs` gains a `recordCommittedPath` helper (or equivalent
verb-scoped `recordComposedFile` / `recordRefineFile`) that appends to
`commit_manifest` under the per-file lock.

Recording is scoped to **command-mode invocations only**. The `compose`
and `refine` verb skills already document this boundary
(`plugins/engineer/skills/compose/SKILL.md` line 148:
"When invoked from a workflow command, the invoking command writes the
plan / task list / implementation progress to its workflow file. When
invoked standalone, no workflow file write occurs."; refine SKILL.md line
156 mirrors). The Layer 2 record helpers respect that boundary: they
run when `$ACTIVE` is bound (sub-step invocation) and are no-ops
otherwise.

Eight `state.mjs` touchpoints update to recognize the new key:

| Line | Concern |
|---|---|
| 65 | Schema constant (`SCHEMA_VERSION`) bump |
| 767 | `parseFrontmatter` key allowlist |
| 825 | `ENTRY_KEYS_BY_LIST_KEY` entry shape requirement |
| 845 | Cross-key validator |
| 911 | Serializer branch membership |
| 1080 | Parser block-list membership |
| 1131 | Inline `[]` membership |
| 1174 | Default factory |

(Line numbers are stable as of `a5cbace`. The implementation MAY refresh
this table if subsequent commits drift any touchpoint.)

#### Layer 3 — Phase 7 staging

Phase 7 computes the candidate staging set from native git, intersects
it with the recorded manifest, and ASKs the user when the two disagree.
Concretely:

```
git_changes      = git diff --name-only HEAD                       # tracked changes (staged + unstaged)
                 ∪ git ls-files -o --exclude-standard               # untracked, gitignore-respecting
                 \ {.agentic-plugins/state/**}                      # workflow storage excluded
manifest_paths   = frontmatter.commit_manifest.map(e => e.path)
```

`git diff --name-only HEAD` covers both staged-only changes and
unstaged-only changes by default — the earlier draft's `git ls-files -m`
predicate missed staged-only changes, which the round-2 peer verified by
sandbox reproduction. Phase 7 then branches:

- `manifest_paths ⊇ git_changes` → stage `manifest_paths ∩ git_changes`
  (validated, no prompt)
- `manifest_paths ⊊ git_changes` → ASK the user whether the
  non-manifest changes should be included; treat as Layer 1
  `accept-current-tree` for the remainder of Phase 7 if approved
- `manifest_paths = ∅` (Layer 2 not exercised — e.g., user ran `/engineer:start`
  but never went through compose/refine sub-steps) → ASK the user to
  approve all of `git_changes`

Staging uses explicit pathspecs (`git add <paths>`). `git add -A` is
forbidden — it sweeps adjacent user-staged work outside the workflow's
scope. Mixed-hunk detection runs per staged path:

```
cached_numstat   = git diff --cached --numstat <path>
head_numstat     = git diff --numstat HEAD -- <path>
```

When the two differ substantially (`cached_numstat`'s additions/deletions
under-count `head_numstat`'s totals), the file has hunks that were not
in the manifest scope. The fix is one of: `git add --patch <path>`
interactive, or refuse-and-ask. The earlier `cached`-vs-unstaged
comparison produced a false positive on fully-staged files; the peer
sandbox round-3 verification confirmed `cached`-vs-`HEAD` is the
correct predicate.

### Fourteen policy sections

#### P1 — Commit body source policy

The commit body is composed from three sources in order:

1. The workflow's `original_request` (one-line scrubbed user request).
2. `git diff --stat HEAD` of the staged paths (truncated to 20 lines).
3. The most recent `ensemble_results[*].summary` if it is shorter than
   200 characters; otherwise omitted.

Sources 1–3 are concatenated as Markdown paragraphs separated by blank
lines. The body MUST NOT include the raw frontmatter, raw peer output,
or any field listed under P9.

#### P2 — Partial split failure recovery

When a per-package commit split lands N commits successfully and then
fails on commit N+1 (hook rejection, signing failure, etc.), Phase 7
does NOT roll back the landed commits. Instead it surfaces the failure
to the user with the names of the pending packages and exits with a
refine fallback — the user invokes `/engineer:refine` to address the
remaining packages, and Phase 7 re-runs against the now-cleaner state.

#### P3 — Consumer-repo missing-config behavior

`readPackageMap(configPath, {strict})` degrades gracefully when invoked
in a consumer repo with no `release-please-config.json`: it returns `[]`
and Phase 7 emits a single-commit path. Inside the agentic-plugins
repo itself, `readPackageMap` runs in `strict=true` mode and throws on
malformed JSON — letting a malformed config silently degrade to "no
packages" would mask exactly the bug ADR-0016 was written to prevent.

#### P4 — Pre-commit vs commit-msg uniformity

Pre-commit hook failure and commit-msg hook failure produce the same
outcome: Phase 7 emits a refine fallback. The user invokes
`/engineer:refine` against the workflow; the file delta plus hook output
are surfaced as part of the refine prompt. (Pre-commit and commit-msg
both arrive as `git commit` exit codes from Phase 7's perspective; the
hook scripts themselves remain unchanged.)

#### P5 — Terminal-marker-last invariant

`set-terminal` is the final `state.mjs` mutation Phase 7 emits. The
ordering is:

1. Validate Layer 1 / Layer 2 / Layer 3 inputs.
2. Compose subject (P6), validate (P11 + CONVENTIONAL_COMMIT_RE).
3. Stage + commit.
4. `noPendingEnsembleCheck` (P12).
5. `noActiveChildrenCheck`.
6. `git status --porcelain` clean-after-commit gate.
7. Parent-writeback (P10).
8. **Only when 4–7 all pass** → `set-terminal`.

Any failure between steps 1 and 7 leaves `terminal_marker` unset and the
workflow remains resumable. `set-terminal` must not be followed by any
other `state.mjs` write in the same Phase 7 invocation — otherwise the
Stop hook may auto-archive before the trailing write lands.

#### P6 — Subject inference and user confirmation

Phase 7 NEVER auto-commits. It infers a candidate subject from the
workflow's verb, profile, and (when applicable) the changed package
key, then prompts the user to confirm, edit, or reject:

```
Suggested subject: feat(engineer): add validate-commit.mjs centralization
[a]ccept / [e]dit / [c]ancel:
```

Non-interactive e2e tests use `--subject "<text>"` and
`--confirm-non-interactive`. The flag combination is the only way to
bypass the prompt; absent both, Phase 7 always asks.

#### P7 — `!` breaking-change support in the regex

The conventional-commit regex MUST accept `!` between the optional scope
and the colon:

```
/^(feat|fix|docs|ci|refactor|chore|test)(\([^)]+\))?!?:/
```

`parseCommitSubject` returns `{type, scope, breaking, description}` where
`breaking` is the boolean form of the trailing `!`. Both inline copies
in `stop-archive.mjs` and `_shared.mjs` collapse to a re-export of the
centralized `CONVENTIONAL_COMMIT_RE`.

#### P8 — Per-package subject inference (`--subject-pkg` matrix)

When the staging set crosses package boundaries (`shouldSplit === true`),
Phase 7 splits into one commit per package. Each commit gets its own
subject via repeated `--subject-pkg <package-key>=<subject>` flags
(commander-style, repeatable):

```
phase7-commit.mjs \
  --subject-pkg plugins/engineer="feat(engineer): add Phase 7 driver" \
  --subject-pkg plugins/runtime="docs(runtime): mention Phase 7"
```

A single `--subject` is rejected when `shouldSplit === true`. Subject
parsing splits on the *first* `=` only — subjects MAY contain
additional `=` characters (e.g., `feat(engineer): set FOO=bar`). When
the user confirms interactively, Phase 7 presents one
`package × subject` row per pending commit.

#### P9 — Trailer allowlist policy

Body composition (P1) MUST scan source 1 (`original_request`) and
source 3 (`ensemble_results.summary`) for trailer-shaped lines:

```
^(BREAKING CHANGE|BREAKING-CHANGE|Co-Authored-By|Closes|Fixes|Refs):
```

Such lines are stripped from the inserted body. release-please routes
`BREAKING CHANGE:` trailers to every touched package (ADR-0016 §"the
28b5eb8 incident"); silently propagating one from a verbatim user
request or ensemble summary into Phase 7's commit body is exactly the
class of accidental routing that ADR-0016 made convention.

#### P10 — Synchronous parent-writeback policy

Phase 7 invokes `writebackParent` *synchronously* after the
clean-after-commit gate (step 6 of P5) and *before* `set-terminal`. A
write-ahead marker (frontmatter `parent_writeback_at`) is set BEFORE
the parent file is touched; on writeback success the marker is left in
place; on writeback failure the marker is cleared. The Stop hook's
deferred-writeback path checks the marker as an idempotency gate. The
combination ensures the canonical orchestrator subtask completion
record lands at Phase 7 commit time rather than waiting for the next
Stop event (which `/orchestrator:next` may pre-empt).

The marker-write-ahead pattern does not eliminate the crash window
between successful parent file write and marker persistence; the Stop
hook handles that residual case via parent-side
`updateSubtask({if_match: ...})` idempotent compare-and-no-op.

#### P11 — `pending_ensemble` gate (`noPendingEnsembleCheck`)

Phase 7 refuses to write `set-terminal` while `pending_ensemble` is
non-empty. The existing four Stop hook gates
(`stop-archive.mjs:47-92`) cover HEAD-moved, terminal-marker, no
active children, and CC subject; they do NOT cover pending ensemble
runs. A workflow can — and during this very compose phase did — hold
`pending_ensemble: [...review-...]` AND `terminal_marker: true`
simultaneously while the peer was still running. The Phase 7
`noPendingEnsembleCheck` closes that gap by gating on the live state
rather than the Stop hook's frontmatter snapshot. When the gate fails,
Phase 7 emits `pending_ensemble:non_empty:<run-ids>` and exits with a
refine fallback.

#### P12 — `classifyMixedCase` enum

The classifier emits one of the following from a partition of the
staged paths against the package map:

| Enum | Condition | Commit shape |
|---|---|---|
| `single-package` | Exactly one package key matches, no exempt-path remainder | 1 commit |
| `single-package-with-docs` | Exactly one package key matches + exempt paths | 1 commit (docs folded in) OR 2 commits at author discretion |
| `multi-package` | 2+ package keys match, no exempt-path remainder | N commits |
| `multi-package-with-docs` | 2+ package keys match + exempt paths | N + 1 commits (last commit is docs-only) |

ADR-0016 §"Mixed cases" enumerates three shapes (one-package + docs,
two-packages, two-packages + docs). The fourth enum case
(`multi-package`, no docs) is a strict subset of two-packages and is
named explicitly here for the implementation's switch statement; it is
*not* a new ADR-0016 contract.

#### P13 — Strict / lenient CC enforcement gradient

`stop-archive.mjs:81-85` currently treats CC violations as a soft warning
(non-blocking archive). Phase 7 adopts the same default for consumer
repos: an unrecognized subject prints a warning but proceeds. Inside the
agentic-plugins repo (and any repo that opts in via
`.agentic-plugins/config.toml`), Phase 7 enforces CC as a hard block
— the commit is refused and the user is asked to amend the subject.

The opt-in marker lives at `.agentic-plugins/config.toml`:

```toml
[phase7]
strictCC = true
```

Absent or malformed config → lenient (soft warning). Present but missing
the `[phase7]` table or `strictCC` key → lenient. Only an explicit
`strictCC = true` enables strict mode. Phase 7 reads the file via a
single inline parser that recognizes only `[section]` headers and
`key = value` flat lines (no nested tables, no arrays) — avoiding a
runtime TOML dependency.

#### P14 — PR1 landing strategy

This PR1 (the EPCC closure macro's first subtask) lands by hand. Phase
7 is not used to commit its own creation — the chicken-and-egg risk is
not worth the first-dogfood ergonomic. The first non-PR1 invocation of
`/engineer:start` after this PR1 merges will exercise the new Phase 7
end to end and serve as the first observed-parity dogfood data point
for ADR-0024 §observed-experience-parity scoring.

### Centralization

All conventional-commit regex usage centralizes in
`plugins/engineer/scripts/validate-commit.mjs`:

| Export | Purpose |
|---|---|
| `CONVENTIONAL_COMMIT_RE` | The single regex; `!` breaking-aware |
| `parseCommitSubject(subject)` | Returns `{type, scope, breaking, description}` or `null` |
| `readPackageMap(configPath, {strict})` | release-please packages with strict/lenient mode |
| `detectCrossPackageRoutes(files, packageMap)` | Returns `{shouldSplit, perPackageCommits[], docsCommit?, classification}` |
| `isExemptPath(path, packageMap)` | Structural predicate: `!packageMap.some(prefix => isSegmentPrefixOf(prefix, path))` |
| `classifyMixedCase(routes)` | One of the four enum values from P12 |

The two inline copies (`stop-archive.mjs:230`, `_shared.mjs:83`)
collapse to re-exports of `CONVENTIONAL_COMMIT_RE`. The module is pure
(no I/O, no global state) per the
`plugins/engineer/scripts/stop-archive.mjs` lines 222–228 purity
invariant; `readPackageMap` is the one exception and accepts the file
path as a parameter so tests can drive it with fixtures.

## Consequences

**Positive**

- Single source of truth for conventional-commit semantics across the
  three call sites (`phase7-commit.mjs`, `stop-archive.mjs`,
  `_shared.mjs`).
- Cross-package commit splitting moves from reviewer-attention
  convention (AGENTS.md prose) to automated detection at commit time,
  closing the recurrence class of ADR-0016 §"28b5eb8 incident".
- The Layer 1 clean-baseline gate eliminates the "intended" ambiguity
  by construction — post-baseline changes ARE workflow-intended, no
  flag-soup required.
- Layer 2 manifest gives future verbs (and post-mortem audit) a
  programmatic provenance trail for which file came from which phase.
- Phase 7 becomes resumable on every failure mode; `set-terminal`
  fires only when the commit and writeback both land cleanly.

**Negative**

- Schema 1.1 → 1.2 is additive but introduces 8 `state.mjs` touchpoints
  that all must update atomically; missing one produces silent reader
  failures for new workflows.
- `phase7-commit.mjs` adds ~900 LOC and 12 CLI flags to the engineer
  plugin's maintenance surface.
- The opt-in `.agentic-plugins/config.toml` is a new repo-level
  surface; consumer repos must learn about it to enable strict CC.
- PR1 itself does not dogfood its own automation (P14); the first
  observed-parity data point arrives one PR later.

**Neutral**

- Both `compose` and `refine` skills gain manifest-record sub-steps
  but the boundary remains "command-mode only", so standalone
  invocations are unaffected.
- The Codex parity surface (`skills/start/SKILL.md` Phase 7 mirror)
  narrates the same host-shared driver via the user-approved shell
  tool — no new Codex hook is required, and `plugin_hooks` policy is
  unchanged.

## Alternatives Considered

### F1 — PR1-minimum (Layer 1 + Layer 3 only)

Layer 1 (Phase 0 clean-baseline) + Layer 3 (Phase 7 staging with
explicit pathspecs + user-confirm fallback). No schema change. No
compose/refine record-helpers. ~500 LOC. 14 e2e scenarios instead of
23. 9-axis score 22★ tied with F2 but dominating on 표준 (CI
convention), 실용성, 유지보수.

**Rejected** — the user resolved the primary fork at decide round
Phase 2 in favor of F2, citing 정석 / 본질 / 근본 priority. F1
remains the documented degradation path if Layer 2 implementation
hits unforeseen issues; the schema bump is additive specifically so
F1 → F2 is a future-compatible promotion.

### F2 — PR1-full (all three layers) — CHOSEN

This ADR's Decision.

### F3 — Defer Phase 7 automation entirely

Keep current `set-terminal`-only Phase 7. ADR-0027/0028 documents the
intent but no implementation lands in PR1. PR2+ owns the entire
commit automation track.

**Rejected** — the EPCC closure macro's premise is that Phase 7 is the
remaining lifecycle gap; deferring it punts the macro's primary
deliverable.

### Single-source intent — peer A1, A2, A3 ensemble alternatives

The decide-round ensemble surfaced three architectural archetypes that
each individually could serve as the "intended signal" source: A1
(clean-baseline precondition at workflow START), A2 (workflow-recorded
manifest), A3 (explicit user commit scope at Phase 7). The 3-layer
defense is their **superposition**, not a choice among them. The
peer's specific refinements — Phase 0 over Phase 7 for the clean-tree
gate, mixed-hunk hazard on the manifest, `commit_mode = clean-baseline
| manual-scope` enum framing — were absorbed directly into the Layer
1/2/3 definitions above.

### `--intended-paths` CLI flag (orchestrator I2)

A single `--intended-paths` flag passed at `/engineer:start` invocation.
**Rejected** — flag-soup; doesn't compose with multi-verb workflows
where Phase 4 compose and Phase 6 refine each touch different paths.
Subsumed by Layer 2 manifest recording.

### Sidecar provenance file (orchestrator I5)

A separate `.agentic-plugins/state/engineer/manifests/<workflow_id>.json`
file. **Rejected** — same semantics as Layer 2 manifest but with an
extra file format; subsumed.

### Stage-on-write in compose verb (orchestrator I6)

`compose --profile=code` runs `git add <file>` after each Write/Edit.
**Rejected** — couples the verb to git state mid-workflow; conflicts
with the compose/refine standalone-vs-command-mode boundary.

### `--subjects '<pkg>=<subj>;<pkg>=<subj>'` delimiter parsing

Plan v4 specified a single delimiter-separated `--subjects` flag.
**Rejected** — subjects may contain both `;` and `=`; escaping rules
become a parser of their own. Repeated structured `--subject-pkg`
(commander style, P8) is the standard idiom and avoids the ambiguity.

### Hand-curated `isRootDocsPath` allowlist

Plan v2.1 proposed an allowlist of root-level docs filenames (`AGENTS.md`,
`README.md`, `CLAUDE.md`, `LICENSE`). **Rejected** — misclassifies
future root files like `.nvmrc`, `tsconfig.json`, `.editorconfig`. The
exemption is structural per ADR-0016: "NOT in any package prefix" is
the predicate. `isExemptPath` implements that predicate directly.

### Hard CC enforcement for all repos

Plan v2.1 proposed escalating the soft-warning to a hard block in all
repos. **Rejected** — consumer repos that don't use conventional
commits would find Phase 7 unusable. P13's opt-in gradient lets the
agentic-plugins repo enforce strict mode while consumers default to
the current soft-warning behavior.

### Skip Proposed → Accepted directly

The Codex round-1 peer suggested merging this ADR as `Accepted`
without the intermediate `Proposed` state, on the theory that the
ensemble process subsumed the discuss-then-merge step. **Rejected** —
AGENTS.md §"ADR process" lines 235–239 require Proposed → Accepted
transition on merge. The mid-PR status flip is the canonical pattern
and serves as the durable record that the ADR text shipped via the
PR-review gate, not just the ensemble-review gate.
