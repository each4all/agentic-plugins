---
name: resume
description: "Re-enters an in-flight engineer workflow with a clean/dirty drift report against git baseline (or archives a stale one) — the engineer plugin's resume meta skill (ADR-0017 §sub-decision-1). A workflow-continuity meta operation, not a cognitive verb and not a lifecycle macro. Use when the user wants to pick up an active engineer workflow after compaction, a new session, or a branch switch, or when the user wants to archive a stale workflow. Trigger phrases include 'resume engineer', 'continue the engineer workflow', 'pick up where I left off', 'drift report', 'archive this workflow', '재개', '이어서 진행', '워크플로 정리'. Cross-host inspection (Codex looking at a Claude-started workflow, or vice versa) is the canonical Codex use case — the filesystem state is host-shared."
---

# Resume (engineer persona, meta skill)

The `resume` meta skill re-enters an in-flight single-deliverable
workflow without bootstrapping a new one. Unlike the six engineer
verb skills (which advance the workflow), `resume` reports state and
gates re-entry on a **clean/dirty** drift classification — *clean* if
the recorded `git_baseline` (branch + HEAD + status digest) matches
the current git state, *dirty* otherwise (per ADR-0017 §sub-decision-1
two-tier discipline; ADR-0018 §sub-decision-3 enriches the dirty
case with four native git probes and an explicit
auto-reconcile-not-supported notice).

It is a **meta skill** per [ADR-0010](../../../../docs/adr/0010-plugin-boundary-policy.md)
§3 cascade ([ADR-0022](../../../../docs/adr/0022-engineer-meta-skill-category.md)):
not a verb (no cognitive activity), not a macro (no phase sequencing),
but a workflow-continuity operation against existing state.

The skill also exposes an `archive` sub-mode that moves the active
workflow file from `workflows/` to `archive/` via
`state.mjs archive` — a host-agnostic filesystem operation.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| `state.mjs find-active` (locate the per-branch active workflow) | Yes | Yes — filesystem state is host-shared |
| Drift report (clean/dirty classification + ADR-0018 §sub-3 four-probe enrichment) | Yes | Yes — `git` probes are host-agnostic |
| `state.mjs append --event resumed` (host_history append) | `--host claude` | `--host codex` — distinguishes Claude vs Codex re-entry in `host_history` for post-mortem audit |
| `state.mjs archive` (move file to `archive/`) | `--host claude` | `--host codex` — host-agnostic filesystem op |
| SessionStart re-injection of `[engineer-active-metadata]` marker | Yes (next Claude session) | Yes once the bundled hooks load (generic `[features].hooks`) and pass `/hooks` trust; otherwise resume reads the same durable workflow file |

Cross-host inspection is the canonical Codex use case: a user who
started a workflow on Claude can `$engineer:resume` on Codex to see
the current drift state, then either continue on Codex (via any verb
skill) or hand back to Claude.

**Caveat (ADR-0013 cascade)**: Codex-side continuation does NOT
automatically run the Claude command-mode Phase 0 / Phase 2 state
writes (per `plugins/engineer/README.md` §"Codex-side scope (Stage
2, honest)"). On Codex, verb-skill invocations either run
state-less or the user invokes `state.mjs` CLI subcommands manually.
`resume`'s drift report and `host_history` append are themselves
host-agnostic and work; the limitation is the *downstream verb's*
state-writing convenience, not `resume` itself.

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by Claude Code); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` — versioned subdirectory layout | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/engineer` (Codex marketplace install layout per ADR-0008 — no versioned subdirectory, no glob needed) |
| Entry path | `/engineer:resume [archive [<id>]]` (slash command in `commands/resume.md`) | `$engineer:resume` skill mention — this SKILL.md is the runbook |
| `state.mjs` host flag | `--host claude` | `--host codex` |
| Argument intake | `$ARGUMENTS` (Claude convention) | The full skill-mention argument string passed by the Codex runtime |

---

## Phase 0 — Argument intake

Inspect the argument string (the full text after `/engineer:resume`
on Claude, or after `$engineer:resume` on Codex):

- **Empty** → *resume mode* (default). Continue with Phase 1.
- **Starts with `archive` (case-insensitive)** → *archive mode*.
  Continue with Phase 3.
- **Anything else** → reject with a one-line usage hint and stop.
  Do NOT guess — `resume` accepts only the empty form or
  `archive [<id>]`.

---

## Phase 1 — Locate active workflow

Use `state.mjs find-active` with the repository root:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/engineer-resume-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow on the current
  branch. Tell the user: "*No active workflow; nothing to resume.*"
  Recommend `/engineer:investigate` (or another verb) to bootstrap
  a new workflow.
- **Exit 0, single path** → that path is the per-branch single
  active workflow. Continue with Phase 2.
- **Exit 1, per-branch duplicate error** → corruption / external
  mutation (`createWorkflow` itself rejects same-branch duplicates
  per ADR-0018 §sub-2). List ALL candidate workflow files together
  with each file's `git_baseline.branch`; the duplicates are the
  rows whose branch matches the current branch. Ask the user to
  pick one to resume or to archive stale candidates first via
  `/engineer:resume archive <id>` (or `$engineer:resume archive
  <id>` on Codex). Do NOT pick one yourself — per-branch duplicate
  is a user-resolvable invariant violation.

---

## Phase 2 — Drift report (clean / dirty)

Read the active workflow's frontmatter (via `state.mjs read
--workflow-path <path>`) and compute drift against current git state:

```bash
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
```

Drift classification (ADR-0017 §sub-decision-1):
- **clean** — `CURRENT_BRANCH == git_baseline.branch` AND
  `CURRENT_HEAD == git_baseline.head` AND
  (`git_baseline.status_digest` absent OR `CURRENT_DIGEST ==
  git_baseline.status_digest`).
- **dirty** — any other state.

The richer four-tier classification
(`clean / compatible / conflicting / rewound`) is **deferred to a
Stage 3+ trigger** per ADR-0017 §sub-decision-1; current behavior is
two-tier.

Render the drift report:

```text
Workflow: <ACTIVE>
  workflow_id:    <from frontmatter>
  workflow_type:  <workflow_type, default verb-chain if absent>
  verb:           <verb>
  current_phase:  <current_phase>
  next_action:    <next_action>
  drift:          clean | dirty
    branch:       <BASE_BRANCH> → <CURRENT_BRANCH>      (only if changed)
    head:         <BASE_HEAD>… → <CURRENT_HEAD>…         (only if changed)
    commits:      <git log --oneline BASE_HEAD..HEAD>    (only if HEAD advanced)
    working tree: <count> file(s) modified               (only if digest changed)
```

`workflow_type` is the ADR-0020 §Sub-decision 5 shape discriminator
(`verb-chain` for the six single-verb engineer commands; `start` for
the lifecycle-macro workflows produced by `/engineer:start`). Legacy
1.1 files without the field default to `verb-chain`. `verb` is the
last cognitive activity (ADR-0010 §3 six canonical verbs).

If `latest_checkpoint` is present, include its `at` and `summary` as
a one-line "Last checkpoint" entry above the drift block.

### Dirty-case enrichment (ADR-0018 §sub-decision-3)

When `drift == dirty`, run four native git probes guarded by a
baseline validity check (the baseline commit object must be
available via `git cat-file -e <head>^{commit}` — guards against
shallow / GC'd / rewritten / hand-edited baselines):

1. `git log <BASE_HEAD>..HEAD --oneline` — commits since baseline.
2. `git diff --stat HEAD` — working-tree diff stat (vs HEAD;
   untracked files excluded by this command).
3. `git log --diff-filter=R --name-status <BASE_HEAD>..HEAD` —
   renames since baseline.
4. `git log --diff-filter=D --name-status <BASE_HEAD>..HEAD` —
   deletes since baseline.

Each probe captures its own exit status — empty stdout with exit 0
prints a per-probe `(none; ...)` placeholder; non-zero exit prints
`(probe failed: ...)`. If the baseline commit object is not
available, skip all four probes and tell the user to hand-inspect
the workflow file or `archive` the workflow.

After the probes, **always** render the auto-reconcile-not-supported
notice (ADR-0018 §sub-decision-3):

```
  current plugin does not auto-reconcile; review and decide [resume / archive / abort]
```

---

## Phase 2b — Append resume marker

If the baseline commit object is available, append a
`host_history` entry via `state.mjs append --event resumed` —
host-flag is `claude` or `codex` per the runtime invoking this
skill. Per ADR-0017 §sub-decision-1 host_history fidelity, **skip**
the marker append when the baseline is invalid (re-validate here
because shell-variable state from Phase 2 may not survive across
Bash invocations).

Do NOT bump `current_phase` or `next_action` — the resume marker is
purely a host-history append. The user (or the next verb skill /
command) controls phase progression.

---

## Phase 3 — Archive mode

When the argument starts with `archive`:

- `archive` (no id) → archive the single active workflow on the
  current branch. If `find-active` returned a per-branch duplicate
  error, reject — the user must run `archive <workflow-id>`
  explicitly.
- `archive <id>` → validate the id against the workflow-id regex
  (ADR-0011 §1), resolve to
  `<REPO_ROOT>/.agentic-plugins/state/engineer/workflows/<id>.md`
  (or the legacy `.claude/agentic-engineer/workflows/<id>.md`), confirm
  it exists.

Confirm with the user before mutating state — archive is reversible
(the file moves to `archive/`, not deleted) but the active registry
loses the entry. Show the workflow_id, current_phase, and
next_action so the user can sanity-check.

On confirmation:

```bash
node "<plugin-root>/scripts/state.mjs" archive \
  --workflow-path "$WORKFLOW" --host <claude|codex> --repo-root "$REPO_ROOT"
```

The CLI is collision-safe (timestamp suffix on collision) and
idempotent (no-op if the file already moved). If
`archived: false, reason: source-missing` is reported, treat it as
already-archived and tell the user.

---

## Anti-patterns

- **Picking one of the per-branch duplicates without user input.**
  Per-branch duplicate is corruption per ADR-0018 §sub-2; the
  invariant is user-resolvable. Surfacing the list and asking is
  the contract.
- **Bumping `current_phase` or `next_action` on resume.** The
  marker is a `host_history` append only. Phase progression
  belongs to verb skills (`investigate`, `frame`, …) or the
  lifecycle macro (`start`).
- **Mirroring Claude's `--host claude` on the Codex side.** The
  Codex SessionStart hook requires the plugin enabled with generic
  `[features].hooks` (default on) and `/hooks` review/trust. If the
  hook is not active, the host flag
  semantics still matter for post-mortem audit of who re-entered
  the workflow. Use `--host codex` when invoked via
  `$engineer:resume`.
- **Treating drift as a fix-up step.** The two-tier
  `clean / dirty` classification is informational. Reconciliation
  is deferred (ADR-0018 §sub-decision-3 auto-reconcile-not-supported
  notice). The user decides resume / archive / abort.
