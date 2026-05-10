# ADR-0019: Cross-plugin invocation contract — orchestrator → engineer (Stage 3+ §sub-1 follow-up)

## Status

Proposed

## Context

[ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
§sub-decision-1 established `plugins/orchestrator` as the L2
multi-deliverable orchestration capability and explicitly deferred
the cross-plugin invocation contract to a follow-up ADR:

> Cross-plugin invocation contract: separate ADR (Sub-decision 1
> follow-up) when implementation begins.

The plan-only MVP (`/orchestrator:plan` shipped via PR #53) is in
`main`. `/orchestrator:next` and `/orchestrator:done` were
explicitly deferred (acknowledged in `plugins/orchestrator/README.md`
Status table and `plugins/orchestrator/scripts/state.mjs:69-71`
comments). This ADR closes the deferral.

This contract is the precondition for two
[ADR-0012](0012-omcc-removal-preconditions.md) condition advances:

- **Condition 1** (engineer feature parity with omcc-dev): the
  multi-deliverable workflow shape that omcc-dev hosts via
  `plan.deliverables[]` + sharded layout becomes available in
  agentic-plugins via `orchestrator + engineer` composition.
- **Condition 3** (Stage 3 designer plugin can be developed
  engineer-only): designer's first non-trivial workflow likely
  needs multi-deliverable orchestration; without this contract,
  designer would have to drive subtasks manually with no provenance
  back to orchestrator's macro plan.

Five decision items surfaced through brainstorm:

1. **Host dispatch model** — same-host slash-command vs companions
   wire-spec dispatch?
2. **Subtask spec → engineer verb mapping** — explicit fields vs LLM
   inference vs verb chains?
3. **Parent-child workflow linkage** — bidirectional, unidirectional,
   sharded, or independent?
4. **Subtask result writeback** — automatic via Stop hook, manual via
   `/done`, or hybrid?
5. **`/orchestrator:done` semantics** — full-completion only, partial
   completion allowed, or hybrid?

Phase 1 brainstorm ran 9-axis matrix Round 1
(`표준 / 권장 / 정석 / 본질 / 근본 / 확장 / 유지보수 / 고도화 / 실용성`,
workload deliberately excluded per memory
`feedback_decision_methodology_quality_axes`) followed by Round 2
(5-axis 정밀 deliberation on `표준 / 정석 / 본질 / 근본 / 권장` only)
for the contested D1 decision. Phase 2 explore mapped 9 code-surface
targets, 4 missing entry points, and 6 reusable patterns. Phase 3
plan-verify caught 8 issues + 1 needs-clarification, all applied
below.

## Decision

### §1 Dispatch model — D1=C3 (same-host primary + `--peer` cross-host fallback)

`/orchestrator:next` ships two dispatch paths:

**Default — same-host LLM runbook**: `/orchestrator:next` emits a
self-contained prompt instructing the current LLM (the Claude or
Codex session running orchestrator) to invoke engineer's **command
file** at `$ENGINEER_PLUGIN_ROOT/commands/<verb>.md` with the
selected subtask's `verb / profile / topic` plus parent metadata
and **host** exposed via env vars (`AGENTIC_PARENT_WORKFLOW=
<orchestrator id>`, `AGENTIC_ORIGINATING_SUBTASK=<subtask id>`,
`AGENTIC_HOST=claude|codex` — set to whichever host orchestrator is
running on, or to the explicit peer host when dispatching via
`--peer`). PR-A and PR-D ship the engineer-side support for this
dispatch shape: PR-A adds `--parent-workflow` /
`--originating-subtask` flags to `state.mjs create`; PR-D updates
each engineer command's Phase 0 boilerplate (e.g.,
`plugins/engineer/commands/investigate.md:24-95`) to read the env
vars — including `AGENTIC_HOST` to override the currently-hardcoded
`--host claude` value at line 65 — and forward them as the
appropriate CLI flags so the engineer workflow file is bootstrapped
with parent linkage AND the correct host in `host_history`, then
proceeds to invoke the verb's `SKILL.md`. Without the host
parameterization, Codex-originated child workflows would record
`host: claude` and corrupt the cross-host provenance. **The runbook MUST route
through the engineer command, not the skill directly** — direct skill
invocation skips engineer's create-time bootstrap and leaves
`parent_workflow` / `engineer_workflow_id` unrecorded, breaking
§4 auto-writeback. Same runbook pattern as
`plugins/orchestrator/commands/plan.md:71-85` invoking the plan
skill via "Follow the plan skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/plan/SKILL.md`". No new host-runtime
mechanism is introduced.

**Override — `--peer` companions cross-host**: `/orchestrator:next
--peer` dispatches via `plugins/companions` wire-spec v0.1.1 `task`
subcommand. Orchestrator owns an XML prompt template that says
"Read `$ENGINEER_PLUGIN_ROOT/commands/<verb>.md` and follow it with
`AGENTIC_PARENT_WORKFLOW=<id>`, `AGENTIC_ORIGINATING_SUBTASK=<id>`,
**and `AGENTIC_HOST=<peer-host>`** (e.g., `AGENTIC_HOST=codex` when
the orchestrator is on Claude and dispatching to Codex peer; the
peer host name is whichever side the companion task is targeting)
env vars set so engineer's Phase 0 bootstrap records parent linkage
AND the correct host in `host_history`; return result metadata as
JSON envelope". Without `AGENTIC_HOST` in the peer template,
Codex-created child workflows would record `host: claude` and
corrupt cross-host provenance. Same routing rule as same-host:
through the command, not the skill directly.
`companions/contract.md` §6.5 explicitly sanctions plugin-layer
prompt schemas atop the `task` subcommand — **no `verb` subcommand
is added; companions wire-spec stays unchanged**.

#### Branch precondition

Engineer's Phase 0 captures `git_baseline.branch` from
`git branch --show-current` at create time, and ADR-0018 §sub-2
enforces single-active workflow per branch. If `/orchestrator:next`
invokes engineer while still on the macro-plan's branch, every
child engineer workflow anchors to that same branch — successive
subtasks then collide on the per-branch single-active invariant.

The runbook (both same-host and `--peer` paths) MUST therefore
include a branch step before invoking the engineer command. The
order is **clean check → branch resolve → ownership check →
switch → engineer**:

1. **Clean-worktree check (BEFORE any `git switch`)**: verify the
   working tree is clean enough that engineer's Phase 0
   `status_digest` capture is meaningful — abort with a clear
   diagnostic if there are uncommitted changes from the macro
   plan. The check happens before any branch side-effect so the
   abort leaves the user on the macro-plan branch with their
   uncommitted work intact, not on a half-created subtask branch.
2. **Resolve branch name** (REQUIRED + git-ref validation):
   `subtasks[i].branch` is **REQUIRED** in schema 1.1 — every
   subtask must declare its own branch at plan time. The auto-
   derivation defaulting was rejected (Pass 9 review): a
   `<parent-branch>/<id>` form clashes with the parent branch's
   own ref namespace (e.g., `main/T1` cannot coexist with `main`
   per git ref-format rules), so any default-derived form would
   be unsafe across plan shapes. Plan authors must set `branch`
   explicitly. The branch value MUST pass git ref-format
   validation (no spaces, no leading `.`, no `..`, no
   `~ ^ : ? * [ \`, no trailing `/` or `.lock`); validation lives
   in PR-B `validateSubtasks` cascade. Plan-verify ensemble
   prompts (Plan-verify XML template) include "subtask branch
   names must be valid git refs" as a constraint so peer-emitted
   plans don't bypass validation at the producer side.
3. **Ownership check (always, before any branch side-effect)**:
   regardless of whether the resolved git branch already exists,
   scan engineer's workflow directory via the engineer state CLI:
   ```
   node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" find-active \
     --repo-root "$REPO_ROOT" \
     --branch "<resolved-branch>"
   ```
   for the resolved branch name. The `find-active --branch` CLI is
   file-based (calls `findActiveWorkflowByBranch` internally) and
   detects active engineer workflow files even when the git branch
   was later deleted. If a workflow path is returned, read its
   frontmatter and inspect `parent_workflow` and
   `originating_subtask`. Three outcomes:
   - **Match** (parent_workflow == this orchestrator id AND
     originating_subtask == chosen subtask id): re-attach (per
     §2 idempotent `/next` rule). **Still execute step 4** (`git
     switch <branch>`) — engineer's resume keys on
     `git branch --show-current` and will not find the child
     workflow if `/next` is re-invoked from the macro branch
     after a session crash. Step 5 then invokes engineer; the
     command's Phase 0 detects the existing workflow on that
     branch and resumes idempotently.
   - **Mismatch** (different parent or different subtask): abort
     with a clear diagnostic asking the user to either pick a
     different `subtasks[i].branch`, archive the unrelated
     workflow, or specify a fresh branch suffix. **Do NOT proceed**
     — engineer's resume would attach to the unrelated workflow
     and `auto-writeback` would have no matching subtask to
     update.
   - **No active workflow** on the existing branch: proceed to
     step 4.
4. **Switch**: if the branch does not yet exist,
   `git switch -c <branch>`; if it exists (and ownership check
   passed), `git switch <branch>`.
5. **Invoke** the engineer command with parent metadata env vars
   (per the dispatch path above).

After engineer terminates, the runbook does NOT automatically
`git switch` back to the macro branch — the user typically wants
to stay on the subtask branch to inspect the resulting commit.
Subsequent `/orchestrator:next`, `/done`, `/finalize`, `/abort`
calls therefore find themselves on a subtask branch where the
default branch-keyed `state.mjs find-active` cannot locate the
macro orchestrator workflow. Orchestrator's command runbooks MUST
accept either an explicit `--workflow <id>` flag OR auto-resolve
the macro workflow branch-agnostically by walking
`<repo>/.claude/agentic-orchestrator/workflows/` for a
non-archived workflow whose `plan.subtasks[].branch` matches the
current branch — the same scan pattern as PR-E's branch-agnostic
stop-archive discovery (§5).

**Uniqueness rule (fail-closed)**: subtask `branch` is not
schema-globally-unique (the same branch name can theoretically
appear in two non-archived macro workflows, e.g., a
`feat/auth-rewrite` branch reused across two macro plans). The
auto-resolution scan MUST find **exactly one** non-archived
orchestrator workflow whose `plan.subtasks[].branch` matches the
current branch. If zero match, abort with "no macro workflow
references this branch — use `--workflow <id>` to specify, or run
`/orchestrator:plan` to start a new macro plan". If two or more
match, abort with "ambiguous: branch <name> appears in macro
workflows <id-A>, <id-B>; use `--workflow <id>` to specify".
The fail-closed rule prevents writes from landing on the wrong
parent.

PR-D ships this branch step inside `/orchestrator:next.md` as part
of the runbook prompt; the prompt emits the `git status` /
`git rev-parse` / `git switch` shell commands for the LLM to
execute as normal steps before the engineer command invocation.

#### Plugin root resolution

`$ENGINEER_PLUGIN_ROOT` (used by both dispatch paths above) is NOT
a host-provided variable — it must be resolved by orchestrator at
`/next` time. In a developer checkout the path is
`<repo>/plugins/engineer/`; in a consumer environment the engineer
plugin lives under each host's plugin cache (e.g., Claude:
`~/.claude/plugins/cache/agentic-plugins/engineer/<version>/`;
Codex: equivalent path under Codex's plugin cache directory).

PR-D includes a sibling-plugin-root resolver, modelled on
`plugins/companions/scripts/discover-peer.mjs`'s discovery (env
override → cache-glob walk with SemVer ordering for Claude's
multi-version cache layout, **plus** Codex's single-fixed-path
marketplace layout per `plugins/orchestrator/scripts/dispatch-peer.mjs:57-60,94-132`).
The resolver MUST support BOTH host layouts:

- **Claude**: `~/.claude/plugins/cache/<marketplace>/engineer/<version>/`
  with multi-version cache; resolver picks the latest SemVer.
- **Codex**: a single fixed path under Codex's plugin install
  directory (no version directory in the path); resolver returns
  it directly when it exists.

The resolver returns the absolute path to the sibling engineer
plugin's root directory; orchestrator's runbook substitutes it into
the prompt template before emitting. If discovery fails (engineer not
installed), `/orchestrator:next` exits with a clear diagnostic —
same shape as `dispatch-peer.mjs`'s `peer_cli_not_found` graceful
degradation.

Two additional concerns the resolver MUST handle:

- **`CLAUDE_PLUGIN_ROOT` rebind (per-snippet inline scope)**:
  engineer commands' shell snippets reference `$CLAUDE_PLUGIN_ROOT`
  in multiple places — Phase 0 `state.mjs` calls, Phase 1
  `skills/<verb>/SKILL.md` paths, `dispatch-peer.mjs` invocations,
  and `_shared/references/*.md` includes. When /orchestrator:next
  invokes engineer commands, `$CLAUDE_PLUGIN_ROOT` is still pointing
  at the orchestrator plugin root. **A single `export
  CLAUDE_PLUGIN_ROOT=...` does NOT reliably propagate** across
  engineer's command snippets, because each markdown-runbook bash
  snippet typically runs as a separate shell tool invocation
  (Claude Code / Codex CLI exec each snippet in its own process).
  The runbook MUST therefore wrap EVERY emitted shell snippet
  inside the engineer command body in a subshell that exports the
  full env, AND use `$ENGINEER_PLUGIN_ROOT` directly in path argv
  (not the rebound `$CLAUDE_PLUGIN_ROOT` — argv expansion happens
  before inline assignment, so a `CLAUDE_PLUGIN_ROOT=… node
  "$CLAUDE_PLUGIN_ROOT/…"` form would expand to the orchestrator
  path):
  ```
  (
    export CLAUDE_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT"
    export AGENTIC_PARENT_WORKFLOW="<orchestrator id>"
    export AGENTIC_ORIGINATING_SUBTASK="<subtask id>"
    export AGENTIC_HOST="<host>"
    node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
      create --repo-root "$REPO_ROOT" --verb "<verb>" \
      --host "$AGENTIC_HOST" --parent-workflow "$AGENTIC_PARENT_WORKFLOW" \
      --originating-subtask "$AGENTIC_ORIGINATING_SUBTASK" \
      ...
  )
  ```
  PR-D's runbook prompt-emission code is responsible for emitting
  this wrapper for every state.mjs / dispatch-peer.mjs / skill-path
  snippet encountered while following the engineer command, with
  `$ENGINEER_PLUGIN_ROOT` substituted into argv directly (not via
  the rebound `$CLAUDE_PLUGIN_ROOT`). The Codex-equivalent variable
  name is also rebound when running on Codex.
- **Minimum-version preflight**: an older engineer install may be
  discovered successfully but lack PR-A `--parent-workflow` /
  `--originating-subtask` CLI flag support or PR-D Phase 0 env-var
  ingestion. The resolver MUST preflight the installed engineer's
  capability — either by parsing `plugin.json` `version` against a
  minimum required version, or by feature-probing (`engineer state
  create --help` output contains the new flags). On preflight
  failure, `/orchestrator:next` aborts with a "engineer install
  too old; upgrade to >=X.Y.Z" diagnostic before dispatch, so the
  parent linkage contract cannot silently break.

Rationale: 9-axis Round 1 split (Codex=B, Claude=A); 5-axis Round 2
converged both models on **C3**:

- 표준 / 정석: B 우세 (`companions/contract.md:76` task 단일 +
  ADR-0018 line 75 "modelled on the companions invocation pattern").
- 본질: neutral (essence = macro→micro handoff, not host-uniformity).
- 근본: A 우세 (engineer Stop hook A1-A4 = host machinery; subprocess
  외부에서 미발화 → engineer lifecycle 손상).
- 권장: A primary + B fallback (orchestrator MVP `plan.md:150,186`
  guidance가 이미 same-host driving이 default; `plan.md:98,110`은
  companions task를 peer-verify 용도로만 사용).

### §2 Subtask schema extension — D2=A + Lifecycle

`SUBTASK_KEYS`
(`plugins/orchestrator/scripts/state.mjs:93-103`) extends with
three fields:

| Key | Required | Notes |
|---|---|---|
| `verb` | **REQUIRED in schema 1.1** | Canonical 6-verb name (investigate / frame / decide / compose / critique / refine). Validated at `plan-set` time. |
| `branch` | **REQUIRED in schema 1.1** | Git branch name where the engineer subtask runs. Must pass git ref-format validation (no spaces, no leading `.`, no `..`, no `~ ^ : ? * [ \`, no trailing `/` or `.lock`). Existing `branch` field at `SUBTASK_KEYS:96` was previously optional in 1.0; PR-B promotes it to REQUIRED for 1.1 (needed by §1 branch precondition step 2). |
| `profile` | optional | Sub-discipline argument passed to engineer (e.g., backend, frontend, architecture). |
| `topic` | optional | One-line objective; passed as engineer's `original_request` if set. |

**Orchestrator schema bump 1.0 → 1.1**: making `verb` REQUIRED is a
breaking change for the closed-set 1.0 validator (existing
`subtasks[]` produced by the plan-only MVP do not carry `verb` and
would fail the new validator at every read/mutation boundary). PR-B
therefore bumps `SCHEMA_VERSION` to `'1.1'` and accepts BOTH
versions in `SUPPORTED_SCHEMA_VERSIONS`. PR-B's 1.1 frontmatter
also adds `terminal_marker: boolean` as an optional top-level field
(closed-set extension, mirrors engineer schema 1.1 §sub-1
`terminal_marker` per ADR-0017) — required by §5's macro-adapted A1
gate. Without including `terminal_marker` in the orchestrator
schema's `FRONTMATTER_KEY_ORDER` + parser + serializer +
validator, `/finalize` / `/abort` / stop-archive cannot persist
the field, and the A1 gate can never pass.

The 1.0 → 1.1 reader semantics:

- 1.0 reader path: legacy validator (no `verb` requirement); read-
  only mode for files written before PR-B. Mutations to a 1.0 file
  are gated — orchestrator emits a "schema 1.0 file detected;
  archive this legacy plan and run `/orchestrator:plan` to start a
  fresh 1.1 plan" diagnostic and refuses to write back the new
  fields. The user MUST manually archive the legacy 1.0 file
  before re-running `/orchestrator:plan` on the same branch — by
  ADR-0018 §sub-2 single-active per branch, `/orchestrator:plan`
  on a branch that already has a non-archived workflow file
  resumes that workflow rather than creating a fresh one. Once
  the legacy file is moved to `archive/`, the next
  `/orchestrator:plan` invocation creates a fresh 1.1 file.
  PR-B emits the diagnostic with the explicit `mv` command in
  the suggestion.
- 1.1 reader path: full validator with `verb` REQUIRED; new plans
  produced by post-PR-B `/orchestrator:plan` are written as 1.1.

This mirrors engineer's `[1, '1.1']` SUPPORTED_SCHEMA_VERSIONS
pattern at `plugins/engineer/scripts/state.mjs:64`. Schema bump
(rather than additive within 1.0) is justified because `verb`
is REQUIRED — additive-optional under 1.0 is what engineer's
schema 1.1 fields use because they are optional. The asymmetry
reflects a real difference: engineer's added fields are advisory;
orchestrator's are dispatch-load-bearing.

`VALID_SUBTASK_STATUSES`
(`plugins/orchestrator/scripts/state.mjs:85-90`) extends with two
terminal-partial statuses:

| Status | Set by | Meaning |
|---|---|---|
| `deferred` | `/orchestrator:finalize` | Macro plan terminated before this subtask started; deferred for a future plan revision. |
| `abandoned` | `/orchestrator:abort` | Macro plan aborted; this subtask intentionally not done. |

#### Lifecycle / state transitions

```text
              blocked_by 의존
  pending ⇌ blocked
     │
     │ /next
     ▼
  in_progress ────/done OR engineer Stop auto────► completed
     │
     ├─/finalize 잔존─► deferred
     └─/abort 잔존──► abandoned
```

- **`/next` is idempotent**: if an engineer workflow already exists
  with `(parent_workflow == <this orchestrator id>,
  originating_subtask == <chosen subtask id>)`, `/next` re-attaches
  (re-emits the runbook prompt; engineer resumes via existing
  workflow file) instead of creating a duplicate. Handles the
  "user re-runs `/next` after a session crash" case.
- **`/done <subtask-id>` is idempotent**: applying it after the
  engineer Stop hook already wrote back is a no-op
  (`engineer_workflow_id`, `commit`, `closed_at` already set).
- **Crash recovery**: an `in_progress` subtask whose engineer
  workflow did not reach a terminal commit (engineer Stop did not
  fire) stays `in_progress`. The user reconciles by either
  re-running `/next` (re-attach + drive to completion) or
  `/finalize` / `/abort` (terminate the macro plan, leaving the
  subtask `deferred` / `abandoned`). No automatic rescue from
  `in_progress` — explicit user reconciliation only.

### §3 State linkage — D3=A (bidirectional, immutable create-time)

**Engineer schema 1.1 additive update** (joins ADR-0017 optional
fields under `validateSchema11Fields` at
`plugins/engineer/scripts/state.mjs:1098`):

```yaml
parent_workflow: <orchestrator workflow_id>     # immutable, set at create
originating_subtask: <subtask id>                # immutable, set at create
```

Both fields are **immutable after `createWorkflowUnderLock`**. The
dispatch boundary uses two layers (per §1):

1. orchestrator's runbook prompt sets `AGENTIC_PARENT_WORKFLOW` and
   `AGENTIC_ORIGINATING_SUBTASK` env vars when invoking the engineer
   command (same-host) or when shipping the prompt template via
   companions (`--peer`).
2. engineer's command Phase 0 boilerplate reads those env vars and
   forwards them as `--parent-workflow` / `--originating-subtask`
   CLI flags to `state.mjs create`, which writes them into the
   frontmatter at `plugins/engineer/scripts/state.mjs:1351-1372`.

The fields are then preserved verbatim by `appendPhase` and all
subsequent mutations. Later association of a manually-started
engineer workflow to an orchestrator subtask is **not supported**
in this contract; if the need surfaces, raise a follow-up ADR for
`/engineer:link-parent` or similar.

**Schema-version handling**: engineer schema 1.1 frontmatter is
**closed-set** at top level (`plugins/engineer/scripts/state.mjs:993-1000`
rejects unknown frontmatter keys; `:846-854` rejects on
serialization). The PR-A schema extension (see Implementation
Roadmap) MUST update `FRONTMATTER_KEY_ORDER`, `validateSchema11Fields`
known-set, and parser/serializer simultaneously. Pre-PR-A engineer
code reading post-PR-A files (with `parent_workflow` set) will
EXPLICITLY REJECT — coordination is at PR-A merge time.
**Schema version stays at `'1.1'`** (additive within the closed
schema, per ADR-0017 precedent for `terminal_marker`,
`child_completions`, etc.).

**Orchestrator schema** uses the existing
`subtasks[i].engineer_workflow_id` field (already in
`SUBTASK_KEYS:99`); `/orchestrator:next` populates it on dispatch
via the orchestrator single-subtask update API (PR-C0). Concretely,
the runbook performs these steps after engineer's command terminates:

1. Query engineer's branch-keyed find-active CLI to discover the
   active workflow on the subtask branch:
   ```
   ACTIVE_PATH=$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
     find-active --repo-root "$REPO_ROOT" --branch "<subtask-branch>")
   ```
   This works for BOTH paths — the create path (engineer just
   created the workflow) AND the re-attach path (engineer resumed
   an existing workflow on this branch). Engineer commands
   internally assign create stdout to a variable rather than
   echoing it, so direct stdout capture from the command is not
   reliable; querying via the state CLI after the command
   terminates is the canonical capture method.
2. Extract the workflow_id from the path basename (the
   `<verb>-<iso>-<rand>.md` form, strip `.md`).
3. Call orchestrator's PR-C0 single-subtask update API (under the
   parent's per-file lock) to set `subtasks[i].engineer_workflow_id
   = <captured id>` AND `subtasks[i].status = 'in_progress'`
   atomically.

Without this post-create writeback, the parent subtask remains
without `engineer_workflow_id` AND `pending` status, breaking
`/orchestrator:done`'s primary lookup AND `/next`'s idempotent
re-attach detection (which keys on `(parent_workflow,
originating_subtask) ↔ engineer_workflow_id`).

### §4 Result writeback — D4=C (auto + idempotent backup)

Two paths, both terminate at the same orchestrator
`subtasks[i]` mutation:

**Automatic — engineer Stop hook**: After engineer's `runStopArchive`
(`plugins/engineer/scripts/stop-archive.mjs:108`) successfully
archives (all 4 hard gates pass + archive succeeds), if the archived
engineer workflow's frontmatter has `parent_workflow` set, dispatch
parent writeback:

1. Extract `parent_workflow`, `originating_subtask`, terminal commit
   SHA from the engineer workflow's git_baseline / latest commit.
2. Resolve parent workflow path:
   `<repo>/.claude/agentic-orchestrator/workflows/<parent_workflow>.md`.
3. If parent file is in `archive/` (already moved), skip writeback
   with a stderr warning (continuity-protocol §Cross-workflow
   Handoff archive fallback semantics).
4. Acquire parent's per-file lock (`<parent>.md.lock`).
5. Atomically mutate `subtasks[i]` where `id == originating_subtask`:
   - **Precondition check**: if current
     `status ∈ {deferred, abandoned}` (terminal non-completed),
     SKIP the mutation. The user invoked `/orchestrator:finalize`
     or `/orchestrator:abort` while this subtask was active; their
     intent (deferred/abandoned) takes precedence over the
     in-flight engineer Stop event. Emit a stderr note ("subtask
     X already terminal as <status>; engineer completion not
     overriding").
   - **Otherwise**: set `commit`, `closed_at`,
     `status = 'completed'`; ensure `engineer_workflow_id` matches.
6. **Unblock pass** (atomic with step 5): scan `plan.subtasks[]`
   for any entry with `status == 'blocked'` whose `blocked_by`
   predecessors are now all `completed`. Transition each such
   entry to `status = 'pending'` in the same atomic write. Without
   this pass, dependent subtasks would remain permanently
   `blocked` after their predecessors finish (e.g., subtask B
   declared `blocked_by: [A]` and starts at `blocked`; when A's
   writeback completes, B must transition to `pending` so the
   next `/orchestrator:next` invocation can pick it up).
7. **Auto-terminal pass** (atomic with step 5): if step 5 caused
   ALL `plan.subtasks[]` to reach a terminal status
   (`completed | deferred | abandoned`) AND the orchestrator's
   `terminal_marker` is not already set, also write
   `terminal_marker: true` AND `current_phase: 'commit-complete'`
   in the same atomic write. This is the happy-path equivalent of
   /finalize/abort — the last child completion auto-promotes the
   macro to terminal so A1+A2 gates pass on the next Stop
   evaluation without requiring an explicit /finalize call. (When
   the user explicitly invoked /finalize or /abort earlier, those
   commands set `terminal_marker` AND a different terminal phase
   label per §5; the precondition `terminal_marker not already
   set` prevents this auto-pass from overwriting that.)
8. Release parent lock.

**Manual backup — `/orchestrator:done <subtask-id>`**: idempotent
command the user invokes when:

- engineer Stop hook did not fire (e.g., session crashed before
  terminal commit).
- Cross-host dispatch (`--peer` path) was used and the peer's hooks
  do not auto-archive in the local host's Stop event.
- The user wants to manually confirm subtask completion.

`/done` extracts the latest commit SHA on the engineer workflow's
branch (or accepts `--commit <sha>` override) and looks up the
engineer workflow file by `engineer_workflow_id` (already set by
`/next`'s post-create writeback). When `engineer_workflow_id` is
unexpectedly unset (e.g., a `/next` aborted before reaching its
post-create step), the fallback scan **MUST require BOTH
`parent_workflow == <this orchestrator id>` AND `originating_subtask
== <this subtask id>`** — scanning by `originating_subtask` alone
would mismatch when two separate macro plans both have a subtask
labelled `PR1`, writing the wrong commit/status into this parent.
The fallback uses the same ownership shape as §1 step 3.
`/done` then applies the parent-writeback mutation. Idempotent:
applying after auto-writeback is a no-op.

**Helper location**: `plugins/engineer/scripts/parent-writeback.mjs`
— **engineer-local** for now. Cross-plugin import from engineer to
orchestrator is forbidden (ADR-0010 §5 lines 225-227); the helper
takes generic arguments (`parentPath`, `originatingSubtaskId`,
mutation payload) and applies a generic YAML mutation. **Promotion
to a shared L1 helper occurs only when designer (or another L3
persona) becomes a second consumer**, per ADR-0010 §6 trigger 1
(lines 234-239: "Infrastructure used by 2+ other plugins"). Until
then, the helper stays inside engineer.

### §5 Macro completion semantics — D5=C

Three terminal pathways:

**Auto-archive** — when **all subtasks** reach a terminal status
(`completed | deferred | abandoned`), the orchestrator stop-archive
A1-A4 macro adaptation (engineer's ADR-0017 §sub-5 pattern, applied
to orchestrator) fires on the next host Stop event. The macro
workflow is moved to `archive/`.

**Branch-agnostic discovery (PR-E divergence from engineer's
pattern)**: engineer's stop-archive uses branch-keyed
`findActiveWorkflow` because each engineer workflow is anchored to
exactly one branch. orchestrator workflows, by design, span multiple
branches (one macro plan + N subtasks each on their own branch).
The orchestrator stop-archive PR-E therefore scans **all** files
under `<repo>/.claude/agentic-orchestrator/workflows/` regardless
of the current branch when evaluating archive candidates, evaluates
the macro-adapted A1-A4 (below) on each, and archives any that pass.
This is the deliberate deviation from engineer's per-branch pattern
— required so the Stop event that completes the last subtask
(firing on a subtask branch) can still trigger the macro
auto-archive (orchestrator workflow anchored to the macro branch).

**Macro-adapted A1-A4 gates**: engineer's gate set assumes
single-branch workflow; macro orchestrator gates are reformulated
because current HEAD may belong to a child branch when Stop fires:

| Engineer gate | Macro adaptation |
|---|---|
| A1 `terminal_marker` | A1 same — orchestrator workflow has explicit `terminal_marker: true` (set by `/orchestrator:finalize` / `/orchestrator:abort`, OR auto-set when the all-subtasks-terminal precondition flips on parent writeback) |
| A2 `terminal_phase` | A2 same — `current_phase` is one of macro-terminal labels (`commit-complete`, `finalized`, `aborted`) |
| A3 `head_moved` | **A3 replaced** with `all_subtasks_terminal` — every entry in `plan.subtasks[]` has `status ∈ {completed, deferred, abandoned}`. Reasons: macro plan's HEAD comparison is meaningless when current branch is a subtask child; the operative completion signal is "every subtask reached a terminal state" |
| A4 `no_active_children` | A4 reformulated — no engineer workflow file (active or pending) references this orchestrator's id via `parent_workflow`. Walks engineer's workflows directory + filters by `parent_workflow == this orchestrator id` |

PR-E ships these macro-specific gates inside orchestrator's
stop-archive equivalent. Engineer's `evaluateStopArchive` is NOT
reused directly — it would silently misbehave under the macro head
semantics.

**`/orchestrator:finalize`** — the user explicitly closes the macro
plan when remaining subtasks are intentional non-completions. The
operation is **subtask-status-first, then child-detach, then
terminal-marker**, with the parent's per-file lock acquired and
released SEPARATELY for steps 1 and 3 (NOT held continuously
across step 2's child operations — child engineer's stop-archive
post-archive writeback acquires the same parent lock and would
deadlock per §6 if step 2 ran while we held it):

1. **Subtask status transition (FIRST, before any child archive)**:
   acquire parent's per-file lock; transition all `pending |
   blocked | in_progress` subtasks to `deferred` (with timestamp
   annotation in subtask body or a `closed_at` field); release
   parent lock. This MUST happen before step 2 child detach
   because §4 parent-writeback's precondition only skips when
   current `status ∈ {deferred, abandoned}` — if a child reaches
   terminal commit during step 2, its writeback would otherwise see
   `in_progress` and mark the subtask `completed` against the
   user's deferral intent.
2. **Active-children detach pass (NO parent lock held)**: scan
   engineer workflows for any whose `parent_workflow == this
   orchestrator id` AND are not already in engineer's `archive/`
   directory. For each:
   - If the engineer workflow has reached a terminal commit (its
     own A1-A4 would pass): invoke engineer's stop-archive on it
     directly. Its parent writeback path acquires and releases the
     parent lock independently per §6 child release → parent
     acquire rule; sees the subtask already `deferred` (set in
     step 1) and skips per §4 precondition (no completion
     override).
   - If the engineer workflow is still active mid-flight (no
     terminal commit): mark its frontmatter with
     `terminal_marker: false` AND `parent_detached: true` (a new
     optional engineer 1.1 field set by /finalize) and archive
     it with a "detached by parent /finalize" stderr note.
3. **Terminal markers (re-acquire parent lock)**: acquire parent's
   per-file lock again; set on the macro orchestrator workflow:
   - `terminal_marker: true`
   - `current_phase: 'finalized'` (terminal phase label, satisfies
     A2 gate; the macro-terminal phase set is `{commit-complete,
     finalized, aborted}` per §5 above)
   ; release parent lock.
4. Auto-archive A1-A4 evaluation triggers on next Stop (now A1
   `terminal_marker` passes, A2 `current_phase ∈ terminal-phases`
   passes, A3 all-subtasks-terminal passes via step 1, A4
   no-active-children passes via step 2).

The active-children detach pass is what unblocks the macro A4
gate. Without it, /finalize on a plan with in_progress subtasks
would mark them deferred but the underlying engineer workflows
would remain active, leaving A4 ("no engineer workflow file
references this orchestrator as parent and is not archived")
permanently false and the macro never auto-archives.

Engineer schema 1.1 additive (PR-A scope expansion): `parent_detached`
optional boolean, set when the parent /finalize or /abort detaches
the child mid-flight. Pre-PR-A engineer code reading post-PR-A
files with this field set will reject (closed-set), so PR-A's
schema gate covers this field too.

**`/orchestrator:abort`** — the user explicitly abandons the macro
plan. Same ordering as `/finalize` (subtask-status → child-detach
→ terminal-markers); status transition is `abandoned` instead of
`deferred`:

1. All `pending | blocked | in_progress` subtasks transition to
   `abandoned` (atomic with parent file lock).
2. Active-children detach pass (per /finalize step 2). Engineer
   children with terminal commit archive normally; their writeback
   hits the abandoned subtask and skips per §4 precondition.
3. Terminal markers on macro: `terminal_marker: true`,
   `current_phase: 'aborted'`.
2. Auto-archive A1-A4 evaluation triggers on next Stop.

**`/orchestrator:done <subtask-id>` is per-subtask only** (D4
backup path). It does NOT close the macro plan; macro auto-archive
is triggered by §5 conditions independently.

### §6 Lock-order — child release → parent acquire

Cross-plugin two-file mutation introduces the first lock-order
contract in agentic-plugins (ADR-0011 §Stage 2 Non-Goal #8 was
"single-file means lock-order is trivial" — Stage 3 cascades to
"scoped to cross-plugin parent-writeback only"). The rule:

> **Mutate the child workflow under its own lock(s), release ALL
> child-side locks, THEN acquire the parent workflow's per-file
> lock for writeback. Never hold child and parent locks
> simultaneously.**

Concrete sequence in `runStopArchive` post-archive:

```text
1. snapshot()              [acquires + releases engineer per-file lock]
2. archiveWorkflow()       [acquires + releases engineer dir + per-file locks]
3. all engineer locks released
4. read parent_workflow from frontmatter (post-archive, from the
   in-memory snapshot; the file is already moved to archive/)
5. acquire parent per-file lock (<parent>.md.lock)
6. mutate subtasks[i] by id == originating_subtask
7. release parent lock
```

Steps 1-2 fully complete (release their own locks) before step 5
acquires a different file's lock — the rule is naturally satisfied.
The pattern generalizes to `/orchestrator:done` (which never holds
engineer locks anyway — it's orchestrator-side only).

**ADR-0011 amendments land on this ADR's acceptance** (not on
proposal). When this ADR moves Proposed → Accepted, the same PR
adds two updates to ADR-0011: (a) an amendment header noting the
ADR-0019 cascade for §Stage 2 Non-Goal #8, and (b) a §3 atomic
write protocol pointer subsection "Cross-file lock-order: see
ADR-0019 §6". Coupling the cascade landing to acceptance prevents
an Accepted ADR-0011 from depending on a Proposed ADR-0019. This
follows the precedent set by ADR-0018, whose ADR-0011 amendment
landed in the same `Proposed → Accepted` PR (commit `405f582`).

### §7 C3 dispatch detection + Manual peer selection

**Default behavior**: `/orchestrator:next` (no flag) takes the
same-host LLM runbook path. orchestrator assumes engineer is
co-resident in the same host runtime — this matches the typical
install pattern where users install both plugins together.

**`--peer` flag**: `/orchestrator:next --peer` opts into the
companions cross-host dispatch path. Use `--peer` when:

- The engineer subtask should run in the opposite host (e.g.,
  Claude orchestrator wanting Codex to execute the verb for
  cross-host parity validation, or for a different model context).
- Capacity / cost separation between hosts.

**Degradation on peer unavailable**: when `--peer` is given but
`plugins/companions/scripts/discover-peer.mjs` returns
`peer_cli_not_found`, the subtask remains in `pending` status (NOT
advanced to `in_progress`) and `/next` surfaces a clear error to
the user. Rationale: an unfulfilled cross-host dispatch must not
silently degrade to same-host (different cognitive context), and
must not mark the subtask in_progress when no engineer workflow was
actually created. Compare with `/orchestrator:plan` Plan-verify
ensemble degradation (LOCAL-ONLY plan when peer absent), which is
acceptable because the local Claude can still produce a valid plan;
`/next --peer` unavailability has no equivalent local-OK path.

**Auto-detection** (e.g., scanning the engineer plugin install
directory) is **out of scope for this ADR**. If user demand
surfaces after `--peer` ships in PR-F, raise a follow-up ADR for
auto-detect heuristics.

## Consequences

### Positive

- **Engineer parity unlock**: closes ADR-0012 condition 1 trigger
  — multi-deliverable workflow shape now expressible via
  orchestrator + engineer composition. Sharded layout was rejected
  per ADR-0018 §sub-1, but flat `subtasks[]` + per-subtask engineer
  workflow is the equivalent expressive surface.
- **Designer Stage 3 unblocked**: ADR-0012 condition 3 trigger
  becomes tractable — designer inherits the same C3 contract and
  parent-writeback helper pattern (subject to ADR-0010 §6 trigger 1
  extraction when designer becomes the second helper consumer).
- **Framework cross-host identity preserved**: the `--peer` path
  ensures "agentic-plugins is a cross-host AI agent collaboration
  framework" remains operatively true even when most users default
  to same-host.
- **MVP closure**: orchestrator MVP (plan-only) advances to
  full-cycle (plan + next + done + finalize/abort) over the
  trigger-driven PR-A through PR-F sequence.
- **Engineer SRP preserved**: engineer schema gains optional fields
  (`parent_workflow`, `originating_subtask`) but does NOT import
  orchestrator code; the parent-writeback helper takes generic
  parameters (no orchestrator-schema knowledge).
- **Lock-order discipline established**: first concrete cross-plugin
  lock-order rule documented for future cross-plugin patterns
  (designer → engineer, future personas).

### Negative

- **Schema additions on both plugins**: engineer 1.1 closed-schema
  expansion (PR-A) requires coordinated update to
  `FRONTMATTER_KEY_ORDER` + `validateSchema11Fields` + parser +
  serializer; pre-PR-A readers reject post-PR-A files with
  `parent_workflow` set. This is a hard merge-time coordination,
  not a forward-compatible field addition.
- **Two-file lock-order surface introduced**: ADR-0011 had
  intentionally avoided multi-file lock-order via the single-file
  invariant; this ADR reintroduces it (scoped narrowly to
  cross-plugin parent-writeback). Future cross-plugin patterns
  must follow §6 rule.
- **`--peer` UX cliff**: users must know when cross-host is needed;
  no auto-detection in MVP. Mitigated by §7 "Manual peer selection"
  guidance + degradation that does not silently fall back to
  same-host.
- **engineer-local helper, not yet cross-plugin reusable**: the
  parent-writeback helper duplicates if designer (or another
  persona) needs the same. ADR-0010 §6 trigger 1 defers
  generalization until 2+ consumers — accepted trade-off.

### Neutral

- **Auto-detection deferred**: future ADR can promote `--peer` to
  auto-detected dispatch when user feedback or install-pattern
  surveys justify the heuristics.
- **`/orchestrator:next` and `/done` are slash-command runbooks**,
  not new host-runtime APIs. Same pattern as existing
  `/orchestrator:plan`. No host-runtime contract change required.
- **Codex hook auto-packaging unchanged**: orchestrator stop-archive
  (PR-E) inherits engineer's pattern — Claude auto via
  `adapters/claude/hooks/stop.mjs`; Codex manual helper via
  `adapters/codex/hooks/stop.mjs`. ADR-0017 §sub-5 precedent.

## Alternatives Considered

### D1 dispatch model

- **Pure A (same-host only)** — rejected: framework cross-host
  identity (memory `project_design_intent`: agentic-plugins은
  redesign over omcc, results 우월) is undermined.
- **Pure B (companions only)** — rejected: engineer Stop hook A1-A4
  (`stop-archive.mjs`) is host machinery; subprocess (companions
  peer) doesn't trigger host's Stop event → engineer lifecycle
  broken for cross-host subtasks. Codex Round 1 picked B (MEDIUM)
  but reversed in Round 2 5-axis re-deliberation: "Round 1의 순수
  D1=B 입장은 철회합니다."
- **C1 (A primary + B reserved future)** — rejected: peer dispatch
  is not future-only; cross-host need exists at MVP scope (e.g.,
  Codex peer review of a Claude-orchestrated subtask).
- **C2 (B primary + A as in-process shortcut)** — rejected: makes
  the exception path primary, sacrificing engineer lifecycle
  fidelity in the common same-host case.

### D2 subtask spec mapping

- **B (orchestrator infers verb at /next time from label)** —
  rejected: non-deterministic; turns `/next` into a second
  planning event; debug-hostile.
- **D (verb chains in subtask schema)** — rejected: orchestrator
  takes on cognitive responsibility (verb sequencing) that belongs
  to engineer's own resume mechanism. ADR-0010 SRP violation.

### D3 state linkage

- **B (unidirectional, orchestrator → engineer only)** — rejected:
  engineer Stop hook cannot find parent without `parent_workflow`
  in frontmatter; D4 auto-writeback path becomes impossible.
- **C (sharded layout)** — rejected: ADR-0018 §sub-1 explicitly
  rejected sharded layout; orchestrator stays single-file flat
  `subtasks[]`.
- **D (complete separation)** — rejected: no provenance; macro plan
  loses traceability.

### D4 result writeback

- **A (auto only)** — rejected: cross-host (`--peer`) path doesn't
  fire host's Stop hook; auto-only leaves cross-host subtasks
  uncompletable. Manual backup is required.
- **B (manual /done only)** — rejected: same-host path's engineer
  Stop hook is the natural completion trigger; manual-only is a
  regression for the common case.
- **D (orchestrator polls git history)** — rejected: heuristic and
  racy; doesn't solve the writeback problem cleanly.

### D5 macro completion semantics

- **A (full-completion only)** — rejected: forces all subtasks to
  complete even when some are correctly out-of-scope (intentional
  defer / abandon).
- **B (partial-only, no auto-archive)** — rejected: drops the
  "happy path" of all-complete auto-archive; user must always
  explicitly close.
- **D (passive — never auto-close)** — rejected: stale workflows
  accumulate; macro plan state leaks across sessions.

### Engineer schema 1.2 bump (vs 1.1 additive)

Rejected. ADR-0017 precedent established the 1.1-additive pattern
(`terminal_marker`, `child_completions`, `latest_checkpoint`,
`pending_ensemble`, `ensemble_results` — all added without a schema
version bump). Pre-PR-A reader rejection of post-PR-A files is a
one-time merge-time coordination, not a permanent forward-compat
constraint. Bumping to `'1.2'` would require explicit schema-version
migration logic for no operational benefit.

### Generic shared helper at first commit (vs engineer-local)

Rejected. ADR-0010 §6 trigger 1 (lines 234-239) explicitly states
"Infrastructure used by 2+ other plugins" promotes extraction to L1.
Premature extraction introduces a shared module with one consumer
and forces an artificial cross-plugin import boundary. Engineer-
local helper with generic parameters is the right shape until
designer (or another L3) becomes the second consumer.

## Implementation Roadmap

Trigger-driven per ADR-0017 pattern; this is **not** a committed
timeline. Each PR ships when its trigger fires.

| PR | Scope | Trigger |
|---|---|---|
| **PR-A** | engineer schema additive: `parent_workflow` + `originating_subtask` + `parent_detached` (optional boolean for §5 finalize/abort detach pass) in `FRONTMATTER_KEY_ORDER`, `validateSchema11Fields`, parser/serializer, `createWorkflowUnderLock` CLI args | ADR-0019 Accepted |
| **PR-B** | orchestrator schema bump 1.0 → 1.1 + plan producers (atomic): `SUBTASK_REQUIRED_KEYS += verb, branch` (per §2 — branch was previously optional in 1.0); `SUBTASK_KEYS += verb, profile, topic` (the closed unknown-key check runs before required-key handling, so `verb` must be added to the known set in addition to the required set); `VALID_SUBTASK_STATUSES += deferred / abandoned`; `validateSubtasks` cascade including subtask-id / branch ref-format validation per §1; `FRONTMATTER_KEY_ORDER += terminal_marker` (optional boolean, top-level, mirrors engineer 1.1) per §5 A1 gate; parser/serializer/validator updated for both 1.0 and 1.1. Same PR also updates `plugins/orchestrator/commands/plan.md` + `skills/plan/SKILL.md` + Plan-verify XML template + relevant tests so the existing `/orchestrator:plan` command emits the new required `verb` AND `branch` fields — schema-validator divergence from plan producers would break every non-empty plan immediately on merge. | ADR-0019 Accepted (parallel with PR-A) |
| **PR-C0** | orchestrator single-subtask update API (atomic mutation of one `subtasks[i]` entry without rewriting the whole plan; needed by PR-C and PR-D) | PR-A + PR-B merged |
| **PR-C** | engineer-local `parent-writeback.mjs` helper + integration into `runStopArchive` (post-archive parent writeback) | PR-C0 merged |
| **PR-D** | `/orchestrator:next` (same-host default, runbook prompt template) + `/orchestrator:done` (idempotent backup) + Phase 0 boilerplate updates in engineer commands to receive parent metadata | PR-C merged |
| **PR-E** | `/orchestrator:finalize` + `/orchestrator:abort` + orchestrator stop-archive A1-A4 macro adaptation. Both Claude auto (`adapters/claude/hooks/stop.mjs`) and Codex manual helper (`adapters/codex/hooks/stop.mjs`) parity. | PR-D merged |
| **PR-F** | `--peer` flag + companions cross-host dispatch path (XML prompt template owned by orchestrator per `companions/contract.md` §6.5; graceful degradation when peer unavailable per §7) | Cross-host need surfaces (user request or first concrete cross-host workflow) |

## References

- [ADR-0010](0010-plugin-boundary-policy.md) — 4-layer composition;
  §5 lines 225-227 cross-plugin import policy; §6 trigger 1
  (lines 234-239) extraction trigger
- [ADR-0011](0011-workflow-continuity-storage.md) — workflow
  continuity storage; **amended** by this ADR (§Stage 2 Non-Goal #8
  cascade + §3 cross-file lock-order pointer)
- [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) —
  schema 1.1 additive-optional precedent (`terminal_marker`,
  `child_completions`, `ensemble_results`); §sub-5 Stop auto-archive
  4-gate pattern that orchestrator's PR-E adapts
- [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
  — parent ADR; §sub-decision-1 deferred this contract; line 74
  "modelled on the companions invocation pattern"
- `companions/contract.md` v0.1.1 — §2.1 single `task` subcommand
  rule (line 76); §6.5 plugin-layer authority for per-task schemas
- `plugins/orchestrator/commands/plan.md` — line 71-85
  `/orchestrator:plan` runbook pattern that `/next` mirrors;
  line 150,186 manual same-host driving guidance; line 98,110
  companions task usage for Plan-verify ensemble
