# ADR-0011: Workflow continuity storage — minimal Option III for Stage 2

## Status

Accepted

> **Amendment 2026-05-08 (ADR-0018 cascade)**: §Stage 2 Non-Goals
> items #1 / #2 / #3 / #5 / #6 / #7 carry resolution stances assigned
> by [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
> §"ADR-0011 §Stage 2 Non-Goals — cascade after this ADR". Items #4 /
> #8 / #9 stay deferred. ADR-0011's body text remains as written for
> historical record; ADR-0018 carries the per-item current stance.
>
> **Amendment 2026-05-10 (ADR-0019 cascade)**: §Stage 2 Non-Goal #8
> (per-step lock-ordering across multiple files) is now scoped — the
> cross-plugin parent-writeback case is covered by
> [ADR-0019 §6](0019-cross-plugin-invocation-contract.md) "Lock-order
> — child release → parent acquire". Other multi-file lock-order
> cases (sharded layout, multi-shard coordination) remain out of scope
> per the original Non-Goal. §3 atomic write protocol below carries an
> inline pointer to ADR-0019 §6.
>
> **Amendment 2026-05-11 (ADR-0020 cascade)**:
> [ADR-0020](0020-engineer-integrated-workflow-umbrella.md) proposes
> a `workflow_type` frontmatter field (enum: `verb-chain` | `start`)
> for engineer's workflow schema. The field is **additive within the
> closed schema** (no `SCHEMA_VERSION` bump), following the
> [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) /
> [ADR-0019 §881-889](0019-cross-plugin-invocation-contract.md)
> *1.1-additive* precedent (`terminal_marker`, `child_completions`,
> `latest_checkpoint`, `pending_ensemble`, `ensemble_results`,
> `parent_workflow`, `originating_subtask`, `parent_detached`).
> When `workflow_type` is absent (older workflows or new direct verb
> invocations), readers treat it as `verb-chain`. The ADR-0020 PR 2
> implementation lands the field in `state.mjs`'s
> `FRONTMATTER_KEY_ORDER`, `SCHEMA_1_1_OPTIONAL_KEYS`,
> `validateSchema11Fields`, and `createWorkflowUnderLock` in a single
> coordinated commit (closed-schema constraint, same as ADR-0019
> PR-A). §2 "File format" below is the storage shape this cascade
> extends.

## Context

[ADR-0007](0007-migration-cutover-plan.md) §Data migration leaves the
workflow-state storage format as an explicit Stage 2 decision:

> Workflow state (omcc-dev `workflows/` YAML, ensemble run history,
> etc.): agentic-plugins' storage format may differ. … The exact
> decision is made when Stage 2's storage format is finalized

The Stage 2 self-development plugin ([`engineer`](../../plugins/),
once added in Phase 4 Deliverable C — see
[ADR-0010](0010-plugin-boundary-policy.md) for naming) needs durable
workflow state to survive context boundaries on both hosts: Claude
Code (PreCompact mid-session, Stop at session end) and Codex CLI
(Stop at session end; no PreCompact equivalent per
[ADR-0001](0001-hexagonal-architecture.md) §"What is host-neutral
vs host-specific" — the table row "Continuity mechanism | ADAPTER |
PreCompact (Claude) vs Stop-based (Codex)").

Phase 1 brainstorm exposed a tension. The user's stated value is
"editing-tool-level ease of use" (omcc-dev's automatic continuity
felt good even when its quality was unverified). Phase 2 inventory
recommendations from Codex/Claude both observed that omcc-dev's full
continuity surface (sharded workflow layout, drift classification,
cross-host workflow id portability, audit/checkpoint/resume commands,
multi-active workflows) is large, and that Stage 2 should not absorb
all of it without risking shallow implementation.

The user resolved this with an explicit reframing: "*최상의 결과 = 품질
최상*, not maximum scope." The narrow + deep approach was endorsed
("Make it work, make it right, make it fast" — Kent Beck;
"Premature optimization is the root of all evil" — Knuth) over either
the full-omcc-dev port or the no-continuity-at-all defer.

This ADR formalizes the **Option III (minimal continuity)** scope and
storage format chosen at Phase 3 plan approval.

## Decision

### 1. Storage location and naming

```text
<repo_root>/.claude/agentic-engineer/workflows/<workflow_id>.md
<repo_root>/.claude/agentic-engineer/workflows/<workflow_id>.md.lock
```

- `.claude/agentic-engineer/` is gitignored (added by Deliverable A
  alongside this ADR if not yet present).
- Path is host-agnostic — both Claude adapter and Codex adapter read
  and write the same file.
- The directory is created at mode `0700` on first use; the workflow
  files are written at mode `0600`.
- Single-active constraint: at most one workflow file **per branch**
  may exist in this directory at a time. **Stage 2 baseline** was
  directory-wide single-active (a single `.md` entry IS the active
  workflow); **Stage 3+ cascades to per-branch single-active** per
  [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
  §sub-2 — the directory may carry multiple `.md` entries on parallel
  branches, with `git branch --show-current` resolving the active
  one. Two workflow files coexisting on the **same branch** remain a
  corruption / external-mutation scenario (`createWorkflow` rejects
  same-branch duplicates at write time; `findActiveWorkflow` throws
  if two slip in via external means). See Non-goals below for the
  historical Stage 2.5+ multi-active frame, since superseded by the
  branch-keyed model.

`<workflow_id>` format:

```text
<verb>-<UTC-timestamp>-<6-char-shortid>
```

Examples:

- `investigate-20260505T120000Z-a3b7c2`
- `compose-20260506T093015Z-9f1e44`
- `refine-20260507T143022Z-bb3a18`

Verb is the canonical 6-verb name from ADR-0010 (no aliases).
Timestamp is ISO-8601 UTC with `T` and trailing `Z`. Shortid is
6 hex characters from `crypto.randomBytes(3).toString('hex')`.

### 2. File format — Markdown with YAML frontmatter

```yaml
---
schema: 1                                  # integer, this storage format version
workflow_id: <verb>-<timestamp>-<shortid>
persona: engineer                          # always "engineer" in Stage 2; designer in Stage 3
verb: investigate | frame | decide | compose | critique | refine
profile: <sub-discipline>                  # e.g., backend, ui, architecture; or "" if not set
original_request: "<single-line scrubbed user request>"
started_at: <ISO-8601 UTC>
updated_at: <ISO-8601 UTC>
repo_root: <absolute path from git rev-parse --show-toplevel>
git_baseline:
  branch: <branch name at workflow start>
  head: <full SHA at workflow start>
  status_digest: <sha256 hex of `git status --porcelain=v1 -z` at start>
current_phase: <free-form short phase label>
next_action: <one-sentence imperative>
tasks: []                                  # empty at bootstrap; updated from TaskCreate/TaskUpdate IDs+states
host_history:                              # which host(s) have touched this file, append-only
  - host: claude | codex
    at: <ISO-8601 UTC>
    event: created | updated | snapshot | resumed
last_snapshot:                             # most recent automatic mechanical snapshot
  at: <ISO-8601 UTC>
  trigger: pre-compact | stop              # which hook fired
  status_digest: <sha256 hex>
---

# <Workflow title — usually persona:verb topic>

## Original Request

<unaltered scrubbed user message>

## Phase notes

<free-form Markdown — phase boundaries, decisions, references>
```

**Field rules**:

- All optional fields MUST be omitted (not written as `null`) when
  the condition for them does not hold — same rule as omcc-dev
  schema-2 §Always-required-frontmatter.
- `original_request` is single-line. Newlines in user input are
  collapsed to spaces. The single-line constraint preserves YAML
  parser compatibility without complex multiline-block syntax.
- `original_request` is scrubbed for secrets (regex: AWS access
  keys, GitHub tokens, generic 32+ hex bearer tokens) before
  writing. Scrubbed substrings are replaced with `<redacted>`.
- `host_history` is append-only. Each host write appends one entry.
- `last_snapshot` is overwritten in place (not append-only) — only
  the most recent snapshot is retained.

### 3. Atomic write protocol

Two distinct lock scopes are required: directory-level (for
workflow creation and discovery — enforces the single-active
invariant from §1) and per-file (for mutations to an existing
workflow).

**Lock file ownership protocol** (applies to both lock scopes
below — directory-level and per-file).

Every lock file MUST contain an **owner token** unique to the
acquiring invocation:

```text
<PID>:<monotonic-nanoseconds-at-acquire>:<8-byte-random-hex>
```

The token is written to the lock file immediately after creation
(within the same atomic O_EXCL operation, or as a separate write
followed by `fsync` if the platform's O_EXCL+write atomicity is not
available). Three rules govern lock lifecycle:

- **Acquire**: create lock with O_EXCL; if successful, write own
  token. If create fails (lock exists), follow stale-detection
  below.
- **Release**: read the lock file's current contents. If the token
  matches the acquirer's own token, unlink. **If the token does
  NOT match** (another invocation reclaimed the lock as stale
  while this acquirer was paused), do NOT unlink (would delete
  another owner's lock); abort the current operation, do NOT
  commit any in-flight write, and surface a clear diagnostic so
  the user can investigate (this indicates one writer was paused
  long enough to be reclaimed — its work product is suspect).
- **Stale detection** (when O_EXCL acquire fails):
  1. Read the lock file's contents (token T₁) and mtime.
  2. If mtime is fresh (within the staleness threshold below),
     retry with exponential backoff up to 5 seconds; abort if still
     failing.
  3. If mtime is older than the staleness threshold, sleep for one
     full threshold-window then re-read the lock file's contents
     (token T₂).
  4. If T₁ == T₂ (no progress made by holder during the window),
     the holder is genuinely stale — unlink and acquire fresh.
  5. If T₁ != T₂ (the holder is making progress, or another
     reclaimer beat us to it), retry from step 1.

Staleness threshold: **60 seconds** (deliberately longer than the
typical companion peer-call wall time of 1-3 minutes is too
permissive; 60s catches genuinely-crashed writers without
prematurely reclaiming locks held by long peer calls — Codex
ensemble dispatch is non-blocking on the lock holder, so 60s
should never be exceeded by a healthy writer).

This protocol prevents the race where writer A pauses past the
threshold, writer B reclaims the lock, then writer A's release
unlinks B's lock — leaving the directory unlocked while B believes
it holds exclusive access (Codex Round 4 review finding).

**Directory-level lock** (acquired by every verb invocation that
might create a new workflow OR resume the existing one):

All steps below MUST be wrapped in a `try ... finally` (or
language-equivalent guarantee) so step 6's release runs on every
exit path — successful completion, abort due to multi-file state,
or unexpected exception. The release path itself follows the
ownership-verify rule above.

1. Acquire `<repo_root>/.claude/agentic-engineer/.creation-lock`
   per the Lock file ownership protocol above (with stale detection
   if O_EXCL fails).
2. List `.md` files in `workflows/`.
3. **Zero files**: create a new `<workflow_id>.md` using the
   create-only path below (the per-file lock protocol is for
   existing files only and would fail to bootstrap because step 2
   reads the current file). Release the directory lock only AFTER
   the create-only path completes, so the new file is observable
   before the lock drops.
4. **Exactly one file**: this verb invocation appends to the existing
   workflow. Release the directory lock immediately at step 6, then
   proceed with per-file lock below for the append.
5. **More than one file**: abort with diagnostic — single-active
   invariant is broken. Indicates either (a) a previous race
   condition that the directory lock was meant to prevent, or (b)
   manual intervention. User must reconcile manually before
   continuing. **The finally clause still releases `.creation-lock`
   per ownership-verify so the user's reconciliation invocation
   can proceed.**
6. Release `.creation-lock` per the ownership-verify rule (in the
   finally block, so this also runs on abort paths from steps 3-5).

**Create-only write path** (used for the first creation of a new
`<workflow_id>.md` under the directory lock above; no per-file lock
needed because the directory lock guarantees no concurrent creation):

1. Compute `<workflow_id>` (`<verb>-<timestamp>-<shortid>` per §1).
2. Render the new file's complete contents in memory (frontmatter +
   body), with `host_history` initialized to a single
   `event: created` entry.
3. Write rendered contents to `<workflow_id>.md.tmp` in the
   workflows directory.
4. `fsync` the temp file.
5. Atomically rename `<workflow_id>.md.tmp` → `<workflow_id>.md`.
6. (No `<workflow_id>.md.lock` is created — there is nothing to
   synchronize against under the directory lock.)

**Per-file lock** (acquired for mutations to an existing
`<workflow_id>.md` — appends, hook snapshots, frontmatter updates):

Same `try ... finally` discipline applies — step 7's release MUST
run on every exit path including write failures and exceptions.
The Lock file ownership protocol above applies (60-second staleness
threshold, owner token, ownership-verify on release).

1. Acquire `<workflow_id>.md.lock` per the Lock file ownership
   protocol above.
2. Read current file contents.
3. Apply the in-memory change.
4. Write the new contents to `<workflow_id>.md.tmp` in the same
   directory.
5. `fsync` the temp file.
6. Atomically rename `<workflow_id>.md.tmp` → `<workflow_id>.md`.
7. Release `<workflow_id>.md.lock` per the ownership-verify rule
   (in the finally block, so this also runs on write/rename failure
   paths).

The directory-level lock prevents the race condition where two host
sessions or two parallel commands observe an empty `workflows/` and
each create a different `<workflow_id>.md` (which would silently
break the §1 single-active invariant). Per-file lock has the same
shape as omcc-dev's `atomicModifyFile` (simplified — no sharded
coordination needed since Stage 2 has no shards).

**Cross-file lock-order (Stage 3+ amendment)**: cross-plugin parent-
writeback (engineer → orchestrator subtask completion) introduces the
first multi-file mutation in this storage system. The lock-ordering
rule lives in [ADR-0019 §6](0019-cross-plugin-invocation-contract.md):
mutate the child workflow under its own lock(s), release ALL
child-side locks, THEN acquire the parent workflow's per-file lock
for writeback. Never hold child and parent locks simultaneously. See
ADR-0019 §6 for the concrete `runStopArchive` post-archive sequence.

### 4. Hook contracts

Both adapters install a single small hook that triggers automatic
snapshot:

| Host | Hook event | What the hook writes |
|------|-----------|------------------------|
| Claude Code | `PreCompact` (mid-session, before context auto-compaction) | Update `last_snapshot` + `updated_at` + append `host_history` entry with `event: snapshot` |
| Claude Code | `Stop` (session end) | Same as above with `event: snapshot` |
| Claude Code | `SessionStart` (new session begins) | Read active workflow file, inject one-line summary into the session header (does not modify file) |
| Codex CLI | `Stop` (session end) | Same shape: update `last_snapshot` + `updated_at` + append `host_history` entry |

Hook implementations live in
`plugins/engineer/adapters/{claude,codex}/hooks/` and use the
workflow-state I/O module (Deliverable D) for atomic writes.

**Hook absence is non-fatal.** A workflow that is never touched by a
hook still survives — it just lacks the snapshot metadata. The
workflow file itself is the authoritative state; hooks are
accelerators per the Phase 1 framing ("state file is source of
truth, hooks are adapter-specific accelerators" — Codex Round 3).

### 5. Resume mechanism — implicit, not commanded

Stage 2 has no `/engineer:resume` command. Resume is implicit:

- When any `/engineer:<verb>` command starts, it first checks
  `.claude/agentic-engineer/workflows/` for an existing `.md` file
  (under the directory-level lock per §3).
- If none exists, the verb starts a new workflow with workflow_id
  `<verb>-<timestamp>-<shortid>`.
- If exactly one exists, the verb **appends to it**:
  - Append a phase note to the Markdown body recording the verb
    transition (e.g., `## Phase: Frame (transitioned from Investigate)`).
  - Update frontmatter `verb` field to the newly-invoked verb.
  - Update `current_phase` and `next_action`.
  - Append a `host_history` entry with `event: resumed`.
  - **The workflow_id (file name) does not change** — it remains the
    origin verb id from when the workflow was first created. The
    file name is immutable; the active verb is read from the
    frontmatter `verb` field.
  - This means a workflow originating as `investigate-...md` may
    legitimately have `verb: refine` in its frontmatter at later
    stages; the file name preserves origin, the frontmatter records
    current state.
- If more than one exists, abort with a clear error message
  instructing the user to manually delete or archive stale files
  (multi-active is a Stage 2.5+ concern; the directory-level lock
  per §3 is intended to prevent this state from ever arising, so
  encountering it indicates manual intervention or a bug).

The `SessionStart` hook (Claude only) reads the file at session
start and surfaces a one-line summary in the session header so the
user sees the active workflow immediately — Claude's primary
"editing-tool-level ease" affordance.

### 6. Workflow archival — manual

When a workflow is finished (its terminal commit is created), the
user manually moves the file:

```text
mv .claude/agentic-engineer/workflows/<workflow_id>.md \
   .claude/agentic-engineer/archive/<workflow_id>.md
```

Stage 2 does NOT automate this. The Stop hook does NOT auto-archive.
This is Phase 1's "narrow + deep" trade-off: automatic archival
requires a "is this workflow terminal?" decision protocol that
mirrors omcc-dev's A1-A4 conditions, which is the kind of
machinery Phase 2 inventory flagged as Stage 2.5+ scope.

A future ADR (post-Stage 2) may add automatic archival; for now,
manual is acceptable per the user's "편함 + quality, not breadth"
framing.

## Stage 2 Non-Goals (explicit)

These are intentionally **out of scope** and MUST NOT be added to
Deliverables A–E:

1. **Sharded workflow layout** — single root file + N shard files
   per omcc-dev `continuity-protocol.md` §Hierarchical workflow
   shards. Stage 2 uses one flat file per workflow.
2. **Drift classification** — sophisticated comparison of
   `status_digest` deltas (clean / dirty-aligned / dirty-divergent
   / divergent) per omcc-dev. Stage 2 stores `status_digest` for
   reference but does not classify.
3. **Explicit cross-host workflow transition guarantees** — Stage 2
   does NOT promise that a workflow created on Claude is
   correctness-tested when subsequently invoked from Codex (or
   vice versa). The §1 host-agnostic file format and §5 append-on-
   resume protocol DO permit same-file resume across hosts
   (because the workflow file is host-agnostic Markdown+YAML and
   neither adapter writes host-specific binary data), but Stage 2
   does not run cross-host integration tests, validate hook-state
   coherence across hosts, or guarantee snapshot-timing semantics
   when the host alternates. Same-file cross-host resume works in
   practice; explicit transition guarantees are Stage 2.5+ scope.
4. **omcc-dev → agentic-engineer migration script** — clean start
   per [ADR-0007](0007-migration-cutover-plan.md) §Data migration.
   Active omcc-dev workflows must be wrapped up under omcc-dev
   before agentic-engineer takes over.
5. **Multi-active workflows** — at most one workflow at a time.
6. **`/engineer:resume`, `/engineer:checkpoint`, `/engineer:audit`
   as separate commands** — resume is implicit (§5);
   checkpoint/audit semantics are absorbed into the 6 verbs per
   [ADR-0010](0010-plugin-boundary-policy.md) (audit ≈
   `critique --profile=full-codebase`, checkpoint not needed at
   Stage 2 scale).
7. **Active registry file** (`active.md` per omcc-dev) — directory
   listing IS the registry in Stage 2.
8. **Per-step state mutation lock-ordering across multiple files
   or shards** — single-file means lock-order is trivial.
9. **Plugin-name level marketplace aliases** (e.g., `/dev:` as a
   marketplace-supported alias for `/engineer:`) — current Claude
   Code and Codex CLI marketplace contracts require plugin name =
   catalog name = install-folder name = manifest name
   (validator-enforced). Catalog-level alias support would require
   schema changes on both hosts. Out of scope for Stage 2; verb-level
   aliases inside a plugin are permitted (ADR-0010 §3). If user
   demand surfaces in Stage 2 dogfood, raise a Stage 2.5+ ADR.

If any of these prove necessary during Stage 2 dogfood, raise a
follow-up ADR rather than smuggling them in.

## Consequences

**Positive**:

- Storage format is small enough to specify completely in this ADR
  and to review during Phase 5b cross-deliverable review.
- All mutations go through a single I/O module (Deliverable D);
  one place to verify correctness.
- File-based markdown means `cat`, `vim`, `git diff` all work for
  debugging — no opaque DB.
- Workflow file format is host-agnostic; the same file can be read
  on Claude or Codex without conversion (even though Stage 2 does
  not guarantee cross-host transition correctness).
- Clean break from omcc-dev's storage format means agentic-engineer
  has design freedom; future format changes are free of legacy
  coupling.
- The narrow scope reserves quality-engineering time for the parts
  that matter most (the verb skills themselves).

**Negative**:

- No multi-active means a user cannot run two `/engineer:*` workflows
  in parallel during Stage 2. This is the explicit trade-off for
  narrow scope.
- No `/engineer:resume` command means stale workflow files that
  the user wants to kill must be manually deleted. (Resume from
  the file is automatic on the next verb invocation, but
  cancellation is manual.)
- No drift classification means a workflow file that's "stale"
  relative to current git state is not flagged automatically;
  the user must notice from the `git_baseline` mismatch.
- omcc-dev users (the user themselves, transitionally) face a
  one-way migration: in-flight omcc-dev workflows must be
  finished or abandoned before switching, with no automated
  carry-over.

**Neutral**:

- Hook absence is non-fatal: agentic-engineer works without hooks
  installed, just without automatic snapshots. This means the
  Stage 2 plugin can be tested in environments where hooks are not
  yet wired.
- Schema field set is similar in *spirit* to omcc-dev schema-2 but
  intentionally smaller and renamed. Future ADRs may add fields
  (non-breaking) or break the schema (requires supersedure).

## Alternatives Considered

1. **Port omcc-dev schema-2 verbatim** (sharded + drift +
   active registry + hooks A1-A4 + resume + checkpoint commands):
   rejected per Phase 3 plan-verify. Implementation surface large
   enough that Stage 2 quality would suffer.
2. **JSON format instead of YAML+Markdown frontmatter**: rejected
   because Markdown body sections (Original Request, Phase notes)
   are user-readable narrative; JSON would require either parallel
   companion files or escaped-string fields. The YAML+Markdown
   form mirrors omcc-dev precedent that the user is already
   comfortable with.
3. **SQLite or LMDB**: rejected. Adds an install dependency, makes
   debugging harder, gains nothing at single-active scale.
4. **Defer all continuity to Stage 2.5** (Phase 2 inventory
   recommendation, "no runtime"): rejected because it abandons the
   user's explicit "ease of use" value statement and means Stage 2
   plugin cannot survive a single context compaction without
   manual restart.
5. **Cross-host workflow id portability included**: rejected
   because Claude PreCompact has no Codex equivalent (per ADR-0001
   line 150) and the format-translation cost across host runtime
   models is large enough to merit its own ADR. Stage 2's
   single-active + same-file approach handles incidental
   cross-host writes; explicit transition is Stage 2.5+.
6. **Per-shard files keyed by deliverable** (lighter version of
   omcc-dev sharded layout): rejected because it adds the
   coordination cost without the omcc-dev re-contextualization
   benefit at Stage 2's small workflow size (typical Stage 2
   workflow is 5-10 phase notes, fits in one file's body).
7. **Storage location under `~/` (user home) instead of repo
   root**: rejected because workflows are per-project. A workflow
   started in agentic-plugins should not pollute or collide with a
   workflow started in another project. `<repo_root>/.claude/`
   gives natural per-project isolation.

## References

- [ADR-0001](0001-hexagonal-architecture.md) — continuity is an ADAPTER concern; PreCompact (Claude) vs Stop (Codex) split documented there
- [ADR-0007](0007-migration-cutover-plan.md) — §Data migration mandates Stage 2 storage finalization (this ADR fulfills that mandate)
- [ADR-0010](0010-plugin-boundary-policy.md) — sibling ADR; defines the `engineer` plugin and 6 verbs that this storage format serves
- omcc-dev `continuity-protocol.md` (cached at `~/.claude/plugins/cache/omcc/omcc-dev/2.10.0/continuity-protocol.md`) — reference for storage shape; explicitly NOT portable to agentic-engineer per ADR-0007 redesign mandate
