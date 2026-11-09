# ADR-0028: Engineer Phase 7 commit automation

## Status

Accepted (5-PR series complete: PR1 #349, PR2 #350, PR3 #352, PR4 #353, PR5 #356; orchestrator forward-compat port #357)

Superseded in part by [ADR-0062](0062-subtask-completion-recorded-at-landing.md) — §P10 only (2026-09-27)

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

> 2026-10-05: that slice never landed. ADR-0029 went to entry-routing
> contract enforcement, and `runtime:worktree` ships only its read-only
> `plan` subcommand; see the note under Layer 1.

## Decision

Phase 7 of `/engineer:start` automates the commit step under fourteen
explicit policies and a three-layer defense architecture. The
implementation is a host-shared driver
(`plugins/engineer/scripts/phase7-commit.mjs`) invoked by both the
Claude command bootstrap (`commands/start.md` Phase 7) and the Codex
skill narration (`core/skills/start/SKILL.md` Phase 7) — consistent with
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

> 2026-10-05: `runtime:worktree` has no `apply` subcommand; its CLI
> accepts only `plan`. The gate's worktree resolution names
> `/runtime:worktree plan`, which suggests the `git worktree add` command
> for a clean checkout once its checks pass, without running it.

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

> **Note (2026-10-01, [ADR-0063](0063-autopilot-fresh-session-driver.md)
> S3+S4):** `/engineer:commit` applies this layer to verb-chain workflows
> through the same driver, with two modes added: `close`, which closes a
> workflow whose last verb recorded `next_step_kind: done` and which committed
> nothing, and `autopilot`, which decides the whole step in code. A close
> needs `git status` clean, not only an empty `git_changes`: a staged change
> the working tree reverted is invisible to `git diff --name-only HEAD`.
> Under autopilot the staging set is committed without the owner only when
> it is fully implied, the workflow began on a clean tree and nothing is
> pre-staged; the ADR-0063 implementation note has the rest.

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

> **Note (2026-10-01, [ADR-0063](0063-autopilot-fresh-session-driver.md)
> S3+S4):** "leaves `terminal_marker` unset" held because an
> `/engineer:start` workflow has no marker before Phase 7. A verb-chain
> workflow committed through `/engineer:commit` arrives with an interactive
> verb's `summary-complete` marker set, and a split failing at its second
> commit then left that marker in front of a Stop that saw HEAD moved: the
> half-committed workflow was archived and its first commit noted on the
> macro. Execute therefore writes `current_phase: phase-7-commit` with the
> marker off (`beginCommit`) after step 2 and before step 3, and before the
> A2 fast path's gates, so the sentence holds for every workflow.

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

*Implementation note 2026-11-04 (C163):* the subject's type is now checked
against the change it commits. The verb and profile, which chose the type
alone, say nothing about the files: a critique that ended in a package fix
suggested `chore`, and an ADR composed outside every package suggested
`feat`. The topic was also cut at 60 characters for the description. Every
autopilot landing since Macro 2 had its title rewritten by hand.

- **Where the rule holds.** Only in a repository whose
  `release-please-config.json` names packages (a non-empty `readPackageMap`).
  With none, nothing changes: a consumer repository's paths are not "outside a
  package", they are simply not routed. A root package (`"."`) owns every
  path no other package does, which the routing cannot show, so a commit of
  those paths is left unchecked.
- **The rule, per commit.** A commit touching a package path takes a type
  that routes it to a release: `feat` or `fix` (release-please's default
  changelog sections, within the types `CONVENTIONAL_COMMIT_RE` accepts). Its
  scope names the package: its `packageScope`, the key itself, or
  `plugin/<name>` for `plugins/<name>`, but never another package's own scope.
  A change under `plugins/runtime/data/` is such a commit, and the reason the
  driver gives names it, since runtime commands read those assets from the
  installed plugin. A commit touching no package path never takes `feat` or
  `fix`: it takes `docs` when its content is documentation only (prose by its
  extension: Markdown, MDX, reStructuredText or AsciiDoc; not by directory, so
  a script under `docs/` is code, and not `.txt`, which names build inputs as
  often as prose), `test` when
  it is tests only (under a `tests/`, `test/` or `__tests__/` directory, or
  named `test-*`, `*.test.*`, `*.spec.*` or `*.smoke.*`), and `chore`, `ci` or
  `refactor` otherwise. Its scope is free. The routing class `docs-only`
  (P12: no package path) and documentation-only content are two different
  things, and the names and messages keep them apart. Paths cannot decide
  between `feat` and `fix`; that stays the author's choice. A mixed commit
  (`single-package-with-docs`) is decided by its package part, and each
  commit of a split by its own files.
- **Plan mode** reports each commit's `subject_rule` (`allowed_types`,
  `scopes`, `content`, `reason`; null with no package map). Its
  `suggested_subject` keeps the verb's type where the rule allows it, and
  otherwise takes `fix` for a package commit or the rule's first type.
- **Execute** checks every subject before anything is written: one picked
  with `--suggested-subjects`, a file or an inline flag. Interactively, a
  subject that does not fit is a warning that names the reason and the
  corrected subject, and the commit lands as given. Every interactive Phase 7
  text (`/engineer:start` Phase 7 in its command and its Codex skill, and the
  commit command and skill) tells the agent to check an edited subject against the rule before
  execute, and to pass the warning and the corrected subject to the user.
- **Autopilot** (`--mode autopilot`). The commit worker reads the plan and
  writes each subject to a file: a type and scope the rule allows, and a
  one-line summary of the change. It passes the files as `--subject-file`, or
  as `--subject-pkg-file` per commit of a split. The driver refuses three
  things (exit 9) before anything is written, with the reason, which the
  step's report carries: a subject that does not fit, no subject where a
  commit is due, and a description that is the topic cut short. An empty
  description fails the rule in either mode (a warning interactively, a
  refusal here), and conventional-commit checking is strict whatever
  `--lenient-cc` says. Where the description is the topic cut short or
  empty, the refusal gives no corrected subject, which would keep that
  description and be refused again: it names the corrected type and scope,
  and the worker writes its own summary after them. The runbook's step block
  passes `subject.txt` only when it is there, so on a clean tree (the close
  and the recovery) it passes none.
  `--suggested-subjects` is refused outright (exit 2). The worker-written
  subject and the topic-cut refusal hold in a consumer repository too: "with
  none, nothing changes" scopes the type rule, and a title cut mid-word is a
  defect wherever it lands. A staging set that needs the owner still stops at
  the `staging-set` gate first, which writes the gate and commits nothing; the
  subjects are checked when the commit runs.
- **Every path that writes a commit.** The A2 recovery path makes no commit
  of its own. It finishes landed commits that carry the workflow's
  `Workflow-ID:`, so it checks their subjects against their own files: a
  warning interactively, a refusal under autopilot. Every marked commit is
  checked, not only the newest, and under autopilot a landed description that
  is the topic cut short is refused too. A landed commit touching several
  packages fails there as well (ADR-0016), with no corrected subject: it is
  to be split. Under autopilot a landed commit's refusal is the owner's to
  act on: the step rewrites no history (no amend, rebase or reset), and the
  refusal and the runbook both tell the worker to report the commit and its
  reason, and stop. A retry after a partial
  multi-package commit plans only the commits still to make. It checks those
  as any execute does, and it checks the workflow's commits already landed
  in `baseline..HEAD` as the recovery path does.
- **Limits.** The autopilot worker's system prompt (the orchestrator's
  `worker.mjs`) still tells a step to "use the suggested conventional
  subject". That is another package's text, left for a change of its own.
  The runbook's Autopilot section names that instruction and the banner below,
  and says it governs; a suggestion written verbatim is refused when it is
  the topic cut short. A refusal writes
  nothing, so a workflow that an interactive verb left terminal keeps its
  marker. That is rare: Stop archives such a workflow once HEAD moves. The
  scopes accepted are `packageScope`'s spellings; two packages whose last
  segments collide outside `plugins/` both accept the bare segment, as
  `packageScope` itself does. The autopilot banner (`state.mjs`'s commit rules) still says
  that `--mode autopilot` "commits with the suggested subjects". `state.mjs`
  is generated into every persona, so correcting that sentence would release
  designer and founder for a text neither prints. The runbook's Autopilot
  block is the instruction that counts. A worker that follows the banner
  alone gets the refusal, which names the plan, the files and the flags. The
  sentence is corrected with the next `state.mjs` change that releases every
  persona anyway.
- Tests: `tests/persona-pipeline/test-phase7-subject-type.mjs`; mutation
  proof: `scripts/mutation-specs/phase7-subject-type.mjs`.

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

*Note 2026-10-10:* the driver can take a subject the agent edits from a
file, so that it need not travel on a command line. It also reads
`--subject-file <path>` and a repeated `--subject-pkg-file <package>=<path>`,
each file holding the subject the agent wrote with its file-writing tool.
The engineer runbooks and skills still pass `--subject` inline until a later
change moves them to the files. The driver reads the files when it starts,
before anything is written, and the recovery path's `beginCommit` comes
after that read too. A file's subject must be one line, and the rules above
apply to it as to an inline subject. A file and an inline flag for the same
commit are refused together. The plan's notes and the diagnostics name
`--suggested-subjects` for a subject used as suggested and the subject files
for an edited one. The inline flags stay for programs. The `--subject "<text>"`
form in P6's non-interactive tests above is the inline one.
[ADR-0059's amendment of 2026-10-10](0059-runbook-argument-transport.md#amendment-2026-10-10--text-an-agent-authors-reaches-the-cli-as-a-file-item-j)
holds the rule and the file contract.

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

> **Superseded by [ADR-0062](0062-subtask-completion-recorded-at-landing.md)
> §Decision 2 (2026-09-27).** P10 no longer records the subtask's
> completion: it writes the ownership-binding engineer-terminal note, and
> `/orchestrator:done` records completion after the merge. The
> `updateSubtask({if_match})` compare-and-no-op described below was never
> implemented; ADR-0062 §Decision 3 is the guard that exists.

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

### Forward-compat — minor-version schema evolution policy (PR4)

The engineer workflow frontmatter has accreted several closed
schema versions: `1` (ADR-0011 §2), `1.1` (ADR-0017), `1.2`
(ADR-0028 PR1 — `commit_manifest`), `1.3` (ADR-0028 PR3 —
`parent_writeback_at` write-ahead marker per §P10). All four
versions share the same required-key set; minor bumps add purely
optional keys.

> **Note (2026-09-30, [ADR-0063](0063-autopilot-fresh-session-driver.md)
> D6):** schema `1.4` adds six optional flat scalars, `next_step_*` and
> `awaiting_owner_*`, and keeps the required-key set. They sit at the
> tail of the key order, after `parent_writeback_at`, so the carrier
> described below keeps them in place when a 1.3 reader writes the file.
>
> **Note (2026-09-30, ADR-0063 D6, orchestrator):** the orchestrator port
> (#357) follows the same rule. Its schema `1.2` adds `plan_approval_*` and
> `awaiting_owner_*` after `terminal_marker`, where a 1.1 reader's carrier
> writes them back.

**Context (the cache vs. main divergence window).** The
agentic-plugins marketplace cache lags `main` between releases
(e.g. cached `engineer@0.12.1` emits/reads schema 1.2 while `main`
has already shipped 1.3 emitters in PR3). In a single working
directory this is a non-issue because the cache and the in-repo
helpers are the same code path. The divergence becomes load-bearing
when a user runs multi-worktree dev with a `.agentic-plugins/state`
symlink that points back to the main worktree's state directory
(per `[[feedback_worktree_state_single_home]]`): a `main`-side
write of a 1.3 file can then be observed by a worktree using the
cached 1.2 reader, and the closed schema gate
(`state.mjs:1019`/`state.mjs:1168`/`state.mjs:1195-1204`) would
throw on the unknown additive key.

**Policy (this PR's contribution).** Minor bumps are
contractually **additive-only** — they MAY add optional frontmatter
keys but MUST NOT change the meaning of an existing key or add a
required key. Combined with that contract:

1. **Read tolerance** — a schema `1.x` reader that meets a `1.y`
   file with `y > x` accepts the schema version field as a known
   minor, accepts unknown additive frontmatter keys as a future
   minor's contribution, and surfaces them through the parsed
   object so downstream code can preserve them.
2. **Round-trip preserve attempt (lossless intent)** — on write,
   the older reader carries the unknown keys through verbatim
   when possible, preserving the original disk-recorded schema
   field (no silent promotion). Where a write helper has no
   structural place to surface an unknown key, it documents the
   intentional drop in its caller-facing return shape.
3. **No reverse compat** — an older-major or unknown-major schema
   is REJECTED. The policy only relaxes the *additive-minor* case.
4. **No promotion on read** — observing a higher minor does NOT
   bump the reader's schema field; the existing
   ADR-0017 §"Schema versioning policy" no-silent-promotion rule
   stands.

This policy generalizes the existing
`state.mjs:2021-2030` Legacy-schema comment (PR1 Codex compose-time
review G2) — that note documented the 1.1→1.2 forward-additive case
specifically; this sub-decision extends the same tolerance to every
minor pair going forward.

**Scope split (Codex peer plan-verify, run-id
`peer-now-20260525T043242Z-69109b3`).** This PR4 commits the
**policy text only** (the ADR sub-decision above). The behavior
change in `state.mjs` (`validateFrontmatter` future-minor
tolerance, serialize-side preserve attempt for unknown keys) is
**split into a follow-up PR (PR5)**. Codex flagged the behavior
change as non-trivial: the current parser/serializer is intentionally
closed and rejects unknown keys at parse and serialize boundaries;
"preserved on write" for unknown additive keys requires explicit
raw-preservation semantics (block values, key ordering, comment
preservation) that exceed a small tolerant-read tweak. Splitting
keeps PR4 scope bounded and gives the behavior change a clean
commit boundary in PR5 with its own RED-GREEN coverage.

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

### Implementation note 2026-11-07 — a commit past an unusable review (C163 A1b)

Phase 7 checked that no peer ensemble was still pending (P11), but not how a
settled one ended: a review that failed, degraded or never ran committed as if
it had passed. Since C163 A1a each review attempt keeps one outcome in the
workflow (`review_attempts`, ADR-0023 implementation note of 2026-11-05); this
note enforces it.

- **The rule.** The workflow's latest review outcome (the last attempt it
  lists, "latest" meaning last registered, not last recorded; `unknown` when
  that one is superseded, since a replacement registers after the attempt it
  replaces and is listed after it: `replacement-missing` when it is not
  listed, `replacement-backward` when it names an attempt listed before,
  which is never followed, so the latest only moves forward and an
  acceptance a later registration made stale stays stale; a legacy review
  row, read `unknown`, when an older writer added it after the attempt that
  ran last, when the two cannot be ordered (a time missing or unparseable;
  times compare as instants, never as strings), or when there is no attempt;
  a record that cannot be read is `unknown`) holds the commit back
  when it is `failed`, `degraded`, `unavailable`, `malformed` or `unknown`,
  and when it is `skipped` with no reason given (`unspecified`) or as
  `owner-skip`: the record cannot tell an owner's skip from a worker's claim
  of one, so a review no one is known to have chosen to skip holds as an
  unknown one does (interactively that is a warning only). `passed`,
  `concerns` and `conflict` are usable reviews, and `skipped` as `local-only`
  or `privacy-gate` is a choice the verb records. No skip, of any reason,
  clears anything: its reason is the worker's claim, which settle never
  checks, so when the latest attempt before it that ran holds, that attempt is
  read in the skip's place (the latest line names the skip, `later_skip`, and
  only that attempt can be accepted, so accepting a skip never clears a failure
  it does not name; a superseded attempt on the way is read as it would be
  listed last, so one whose replacement is not listed after it holds as
  `unknown`). Otherwise a skip stays the latest, and a usable one holds nothing,
  unless a skip that holds comes before it (read instead, `later_skip` naming
  the usable one) or attempts were dropped from the record (`truncation`), when
  with no review before it what ran cannot be told and the skip reads `unknown`
  (`history-truncated`). Compaction never drops the last attempt listed, since
  that is the one read as the latest. A workflow with no review at all is not
  held. Conservative until the tree a review saw is compared (C163
  A2): the latest outcome counts whatever tree it saw. The pure rule is
  `reviewGate` in `scripts/lib/review-attempts.mjs`, which the orchestrator
  reads from its byte copy.
- **The owner's way on.** `state.mjs review-accept --workflow-path <p>
  --attempt-id <id> [--note-file <f>]` records the owner's acceptance of the
  latest blocking attempt (`review_acceptance`, one JSON document in its own
  frontmatter scalar, after `review_attempts`): the attempt, the outcome it
  read with its error kind and reason, the record as the owner saw it
  (`listed`, the last attempt listed then with its time, and `gaps`, the
  coverage reasons then), and the working tree it is given for (`head` and
  `tree`, the tree a review snapshot would hold). It covers the latest only
  while that is the same attempt with the same outcome, error kind and
  reason, the last attempt listed is still the one it saw, and no gap was
  found since: a later review attempt makes it stale for good (a skip that
  reads the accepted attempt again does not revive it, nor does an id
  compaction dropped and a writer recorded again, which is listed with a new
  time), and so do another outcome of the attempt accepted, a gap found since
  (coverage reasons are never removed), and another tree: the tree alone
  is compared, so a commit of the accepted content (the recovery path's)
  keeps it and an edit moves it. It is refused under an autopilot run (only
  the owner accepts), for an attempt that is not the latest, for one that
  holds nothing back, and for one still open or whose run is still pending
  (it has no outcome yet: settle its run first).
  `state.mjs review-gate` prints the judgment, read-only.
  `state.mjs review-attempt-supersede` refuses a replacement listed at or
  before the attempt it replaces.
- **Under autopilot** `--mode autopilot` refuses (exit 10, `review-held`) the
  commit and the recovery of a commit begun alike, before anything is written,
  with one line naming the attempt, its outcome and error kind, why no
  acceptance covers it, and both ways on (a new review, or `review-accept`,
  its workflow path quoted as one shell word when it needs it). Each way on
  it names is one the command takes: an attempt still open offers only the
  new review, since `review-accept` refuses it until its run is settled, and
  a record this reader cannot use (a later version, or one that cannot be
  read) offers neither, since nothing can be recorded over it: the line says
  to upgrade the plugins, or to repair `review_attempts` by hand. A working
  tree that cannot be compared (an index entry marked assume-unchanged, a
  conflicted index) holds the commit, as one that moved does.
  A close lands nothing and is not held. The commit is judged before the
  staging-set gate, which would otherwise write a gate over a held review,
  and the commit and the recovery are judged again at admission, just before
  their first write, from the workflow file as it is then: the frontmatter
  the step began with was read before planning, and an outcome a concurrent
  writer recorded while the plan was made would go unseen.
- **Interactively** `--mode plan` names the hold (`review_hold`, the same
  line; null over a clean tree that lands nothing), and the runbooks show it
  before asking, which is where the user decides. `--mode execute` warns with
  the same line and commits.
- **Limits.** The last check is at admission, before the commit: an outcome
  a writer records after it, while the commit runs, and an edit of the
  working tree between it and the staging, are not seen (no writer of a run
  does either: P11 refuses a pending run first). A pre-commit hook that
  rewrites the change commits content the acceptance was not given for (no
  hook of this repository does; a consumer's that does should be reviewed
  again after it runs). The tree compared is the one a review snapshot would
  hold, and that capture respects a submodule set `ignore=all`, which Phase 7
  stages all the same: moving such a submodule's commit after the acceptance
  leaves the tree `same`, and the commit lands a gitlink the acceptance was not
  given for. It takes an accepted blocking outcome and that setting together,
  and seeing it would change what every review snapshot holds, so it is left a
  limit, under the owner's rule of 2026-10-25. An open attempt compaction
  dropped comes back closed and is listed last, so its outcome is read as the
  latest though it registered before others, with `truncation` the only trace;
  it takes 32 KiB of attempts open at once in one workflow (the bound is bytes:
  about 190 with timestamped ids, about 75 with ids of the longest form), and
  is left a limit under the same rule. `review-accept` is a plain write, so a lane the owner
  holds (ADR-0068 Decision 2) refuses it until the owner releases the hold.
  Its owner-only check is `AGENTIC_AUTOPILOT` alone, as for the other owner
  writes. A legacy review row (a writer older than C163 A1a, or a direct
  `commitEnsemble` call that passes no `review`; settle and the `ensemble-commit`
  CLI always record an outcome) counts while `ensemble_results` holds it: once
  about 20 later results have pruned it, the gate no longer sees it, so a passed
  attempt before it reads `passed` again; and an acceptance whose `gaps` already
  held `missing-outcome` cannot tell that row from the one it saw, so it matches
  again. No runbook writes such a row, and the driver's capability floor
  excludes an engineer older than the record from a run. Recording every row
  durably would add a field to A1a's document for an arrangement that rare, so
  this is left a limit, under the owner's rule of 2026-10-25.

Tests: `tests/persona-pipeline/test-review-gate.mjs`;
`scripts/mutation-specs/review-gate.mjs` (groups S and P, and the cases on the
engineer's library copy: L6, L14, L19, L24–L27, K3, K5, K15). The autopilot's
half is ADR-0063's implementation note of the same date.

> **Implementation note of 2026-11-07 (C163 A2b, ADR-0069).** The review gate above
> no longer reads "the latest outcome whatever tree it saw" where a change is
> compared: Phase 7 compares the change with its reviews on every path that lands a
> commit, from the tree the series' last commit will hold, and the outcome gate reads
> only reviews of that change (an attempt with no identity stays read). The plan names
> the comparison (`review_binding`). Under autopilot `different` and `not-comparable`
> refuse with exit 10 (`review-held`); interactively `different` refuses with exit 10
> (`review-binding-mismatch`), re-routed to critique, and `not-comparable` warns
> (a `repository-mismatch` refuses in both modes).
> `state.mjs review-binding-accept` is the owner's way on. After a last commit Phase 7
> records the comparison, keyed by the commit, for the landing. ADR-0069 Decisions 3
> and 4 hold the rule. (Refines of 2026-11-08: only a comparison that read counting
> reviews, `same` or `different`, narrows the outcome gate, path by path, from what
> the record shows (ADR-0069 Decision 3, as simplified on 2026-11-09); and the tree
> compared is projected from Phase 7's own staging set, through the same `git add` in
> the same environment.)

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
