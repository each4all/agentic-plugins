# ADR-0025: Workflow storage migration to `.agentic-plugins`

## Status

Accepted

## Context

[ADR-0011](0011-workflow-continuity-storage.md) chose the original
engineer workflow storage location:

```text
<repo>/.claude/agentic-engineer/workflows/
<repo>/.claude/agentic-engineer/archive/
```

[ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
mirrored that convention for orchestrator:

```text
<repo>/.claude/agentic-orchestrator/workflows/
<repo>/.claude/agentic-orchestrator/archive/
```

[ADR-0023](0023-peer-runner-supervisor-layer.md) then added
plugin-local peer-run ledgers under:

```text
<repo>/.claude/agentic-engineer/peer-runs/
<repo>/.claude/agentic-orchestrator/peer-runs/
```

These paths worked as a host-shared local state location, but the
namespace is now misleading. Codex-side workflows also read and write
`.claude/agentic-*`, and runtime/operator work now has a first-class
agentic-plugins-owned path under `.agentic-plugins`.

[ADR-0024](0024-runtime-operator-control-plane.md) deliberately avoided
silently rewriting established workflow storage. It allowed new runtime
configuration and run artifacts under:

```text
<repo>/.agentic-plugins/config.toml
<repo>/.agentic-plugins/runs/
~/.agentic-plugins/config.toml
```

but kept existing workflow files under `.claude/agentic-*` as the
compatibility source of truth "until a separate migration ADR changes
that." The runtime artifact policy PR later made this distinction
explicit: `.agentic-plugins/config.toml` may be tracked intentionally,
while generated runtime artifacts under `.agentic-plugins/runs/` stay
ignored. Workflow state still needs an equivalent decision.

The migration must satisfy four constraints:

1. Stop treating a Claude-named directory as the canonical state home
   for cross-host agentic-plugins workflows.
2. Preserve existing engineer and orchestrator workflow compatibility.
3. Keep runtime/operator run artifacts, workflow state, and repo-shared
   config distinct.
4. Avoid implicit migration during ordinary command execution.

## Decision

### 1. Canonical state namespace

The canonical repo-local workflow and peer-run state home is:

```text
<repo>/.agentic-plugins/state/<plugin>/
```

The first plugin namespaces are:

```text
<repo>/.agentic-plugins/state/engineer/workflows/
<repo>/.agentic-plugins/state/engineer/archive/
<repo>/.agentic-plugins/state/engineer/peer-runs/
<repo>/.agentic-plugins/state/engineer/.creation-lock

<repo>/.agentic-plugins/state/orchestrator/workflows/
<repo>/.agentic-plugins/state/orchestrator/archive/
<repo>/.agentic-plugins/state/orchestrator/peer-runs/
<repo>/.agentic-plugins/state/orchestrator/.creation-lock
```

`<plugin>` is the plugin package name, not the host. Future workflow-owning
plugins use the same layout.

### 2. Git policy

`.agentic-plugins/state/` is generated local workflow/runtime state and
MUST be ignored by git.

The repo-local `.agentic-plugins` split becomes:

| Path | Git policy | Purpose |
|---|---|---|
| `.agentic-plugins/config.toml` | trackable by intent | shared repo defaults for agentic-plugins-owned config |
| `.agentic-plugins/*.local.toml` | ignored | local overrides |
| `.agentic-plugins/runs/` | ignored | runtime command artifacts, consensus/context outputs, doctor run artifacts |
| `.agentic-plugins/state/` | ignored | durable local workflow files, archives, peer-run ledgers, locks, migration manifests |
| `.agentic-plugins/tmp/` | ignored | temporary operator process byproducts |
| `.agentic-plugins/cache/` | ignored | repo-local runtime caches |

The artifact validator introduced by the runtime artifact policy must be
extended before implementation to require `.agentic-plugins/state/` ignore
coverage and to fail if state files are already tracked.

### 3. Path migration only, not schema or format rewrite

This ADR changes the storage home. It does not rewrite the workflow
schemas or peer-run handle schemas.

Engineer workflows continue to use the current ADR-0011/0017/0020
Markdown plus YAML frontmatter schema. Orchestrator workflows continue
to use the current ADR-0018/0019 schema. Peer-run ledgers continue to
use the ADR-0023 `handle.json`, `stdout.log`, `stderr.log`,
`envelope.json`, and optional `prompt.xml` layout.

Rationale: changing both path and format would make the migration hard
to audit and hard to roll back. A future ADR may define a JSON-only
workflow schema, but that is not part of this migration.

### 4. Dual-home read contract

Engineer and orchestrator state readers must support two homes:

```text
canonical: <repo>/.agentic-plugins/state/<plugin>/
legacy:    <repo>/.claude/agentic-<plugin>/
```

Default discovery is `auto`:

1. Look in the canonical home.
2. If no relevant canonical state exists, fall back to the legacy home.
3. If both homes contain an active workflow for the same plugin and
   branch, fail closed with an ambiguity diagnostic. Do not pick one
   silently.

The branch-keyed active workflow invariant from ADR-0018 remains
unchanged. The active workflow is still the unique workflow whose
`git_baseline.branch` matches the current branch. Only the directory
searched for that file changes.

### 5. Write contract

After implementation:

- New repositories with no legacy state create workflow state in the
  canonical `.agentic-plugins/state/<plugin>/` home.
- Repositories that still contain legacy `.claude/agentic-*` state keep
  writing to that legacy home until an explicit migration command moves
  the state.
- Once a repo is migrated, all future writes for that plugin use the
  canonical home.

This avoids a half-migrated repository where old workflows stay in
`.claude` while new workflows of the same plugin appear in
`.agentic-plugins/state` without an operator decision.

### 6. Explicit migration command

Migration is an operator action, not a side effect of ordinary
`engineer`, `orchestrator`, or `runtime:doctor` execution.

A runtime-owned migration command or script may implement:

```text
legacy .claude/agentic-engineer      -> .agentic-plugins/state/engineer
legacy .claude/agentic-orchestrator -> .agentic-plugins/state/orchestrator
```

It must be dry-run by default and require an explicit apply flag. The
dry run reports:

- which plugin namespaces exist in legacy and canonical homes;
- active workflow count by plugin and branch;
- peer-run count and non-terminal peer-run count;
- lock files that would block migration;
- ambiguity cases where both homes already contain state;
- exact source and destination paths.

The apply path must refuse to run when any of the following is true:

- a creation lock or workflow file lock is present and not proven stale;
- a peer-run handle is non-terminal;
- canonical state for the same plugin already exists and is not an exact
  migration target.

Tracked worktree dirtiness is reported for operator awareness but is not
itself a blocker, because the migration command moves only gitignored
local state and must not edit tracked files.

The command moves state directories rather than copying them, so there
is one active home after success. It writes a migration manifest under:

```text
<repo>/.agentic-plugins/state/migrations/workflow-storage-v1.json
```

The manifest records timestamp, plugin namespaces migrated, source and
destination paths, counts, and tool version. It is local ignored state,
not a committed artifact.

### 7. Runtime diagnostics

`runtime:doctor` should report workflow storage home status for
engineer and orchestrator:

- `canonical`
- `legacy`
- `empty`
- `ambiguous`
- `migration_blocked`

Doctor remains read-only. It may recommend the migration command, but it
must not move files or alter config.

### 8. Supersession scope

When accepted and implemented, this ADR partially supersedes only the
storage-location portions of:

- ADR-0011 section 1 for engineer workflow and archive paths;
- ADR-0018 sub-decision 1 for orchestrator workflow and archive paths;
- ADR-0023 peer-run ledger paths for engineer and orchestrator.

The following decisions remain operative:

- ADR-0011 lock ownership protocol and workflow schema;
- ADR-0017 engineer schema extensions, ensemble results, and stop archive
  rules;
- ADR-0018 branch-as-workflow-context invariant;
- ADR-0019 orchestrator subtask schema, parent/child linkage, and macro
  lifecycle;
- ADR-0023 peer-runner supervision semantics;
- ADR-0024 runtime/operator boundaries.

## Consequences

**Positive**:

- The canonical workflow state namespace becomes host-neutral and owned
  by agentic-plugins rather than by a Claude-named directory.
- Existing workflows remain readable during migration.
- Runtime/operator artifacts, workflow state, and shared config have
  separate paths and git policies.
- The migration has a clear read-only diagnosis path before any mutation.

**Negative**:

- State helpers need dual-home path resolution until legacy support is
  retired.
- Operator migration must handle locks, peer-run state, and ambiguity
  cases carefully.
- Tests must cover both homes for engineer, orchestrator, runtime doctor,
  peer-runner, stop-archive, and cross-host workflows.

**Neutral**:

- Workflow files remain Markdown plus YAML frontmatter for now.
- `.claude/` remains ignored because host-native Claude state can still
  exist there even after agentic-plugins workflow state migrates away.
- `.agentic-plugins/state/` is durable local state, while
  `.agentic-plugins/runs/` remains runtime command artifact output.

## Alternatives Considered

### Keep `.claude/agentic-*` indefinitely

Rejected. It preserves compatibility but leaves Codex and cross-host
agentic-plugins state under a Claude-named namespace. That contradicts
ADR-0024's separation between host-native plugin surfaces and
agentic-plugins-owned runtime state.

### Immediately rewrite all workflow state into JSON under `.agentic-plugins`

Rejected for this migration. JSON-only state may be a good future
schema, but coupling a path move with a format rewrite would make
compatibility, rollback, and review much harder. The current workflow
schemas are already load-bearing across many commands and tests.

### Store workflow state under `.agentic-plugins/runs/`

Rejected. `runs/` is for command artifacts and bounded runtime outputs
such as context and consensus runs. Workflow state is durable local
continuity state with different lifecycle and ambiguity rules.

### Make `.agentic-plugins/state/` trackable

Rejected. Workflow files, peer-run logs, lock files, and migration
manifests are local process state and may contain raw peer output or
repo-specific paths. They belong in gitignored local state, not in
committed source.

### Auto-migrate on first command invocation

Rejected. Ordinary `engineer` and `orchestrator` commands should not
move state as a hidden side effect. Migration needs a dry-run report,
explicit apply, and refusal rules for locks and non-terminal peer runs.
