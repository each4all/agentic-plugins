# ADR-0063: Autopilot — owner-launched fresh-session driver (Claude-only)

## Status

Accepted (2026-09-29, owner decision). Amended since by
[ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) (2026-10-08),
[ADR-0068](0068-autopilot-lanes-that-keep-going.md) (2026-10-19 and
2026-10-20, accepted 2026-10-20) and the owner's review decisions C105,
C136, C127 and C123 (2026-10-13), C120 and C123 (2026-10-14), C176
(2026-11-09) and C178 (2026-11-10); each item an amendment changed carries
its dated marker. Two clauses rest on Proposed decisions and say so where
they stand: D4's review binding (ADR-0069 Decisions 3 and 4) and D5's model
plan (ADR-0071).

## Context

### The owner's pain

A goal runs today as `/orchestrator:plan` → `/orchestrator:next` → engineer
verbs → commit → `/orchestrator:next` … Whenever a session's context fills,
the owner opens a new session and types `/orchestrator:next` or
`/engineer:resume`.

That relay carries **no judgment**:
- workflow state is durable under `.agentic-plugins/state/`;
- the next command is derivable from it (ADR-0045 §5 table, `next_action`).

The owner acts as the actuator, and often as the sensor, for a decision the
system already computes. Two gaps sit at the root:

1. **No sensor.** Context risk is caller-supplied, never measured
   (ADR-0031 §7). With nothing supplied the footer prints
   `context state: unmeasured (no budget sensor)`
   (`plugins/runtime/docs/footer-contract.md:173`), and "a real read-only
   budget sensor remains separate, future work" (`:224`).
2. **No actuator.** Runtime "never mutates/compacts/switches/starts host
   session context" (ADR-0031 §6). A fresh session can be *recommended*
   (`recommended_session: fresh_or_resumed`) but not *started*. The
   2026-06-22 amendment names the residual limit exactly: a markdown
   command "cannot guarantee a workflow is driven to completion at all"
   (ADR-0031 Amendment item 7,
   `docs/adr/0031-session-level-active-handoff-layer.md:349-360`).

### Owner requirements (2026-09-24)

| id | requirement |
|----|-------------|
| R1 | Each step runs in a **truly fresh context**. No compaction-based continuation: the owner's primary concern is context contamination. Carry-over happens only through curated durable state. |
| R2 | At a genuine judgment point the run **halts**, and reports it: terminal + `halt.json` + exit code 2. Nothing starts after the halt. With parallel lanes ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6) a judgment point in a lane parks that lane only, and the other lanes go on; a run-wide halt **drains**: no new lane or step starts, steps already running finish and are recorded, then the run reports once nothing can start ([ADR-0068](0068-autopilot-lanes-that-keep-going.md) Decision 1). A subtask that waits for its PR to land is not a judgment point (D3a). *Amended 2026-10-19 (ADR-0068, lanes that keep going): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).* |
| R3 | **Claude-only.** Codex parity is not required (Claude adapter, documented non-parity). |
| R4 | `decide` results are auto-accepted **unless** the ensemble verdict is CONFLICT or confidence is below HIGH. |
| R5 | **Deterministic control.** The driver never synthesizes a command from free text. Commands come only from closed enums in state (same principle as entry-brief R0). |

### Host truth

Probes ran on 2026-09-24 against Claude Code 2.1.281 with the installed
plugin set (orchestrator 0.13.7, engineer 0.21.10, runtime 0.97.4,
attention 0.9.0, companions 0.4.1), in scratch git repos only. The full
record is [`PROBES.md`](../assurance/evidence/autopilot-probes-2026-09-24/PROBES.md).

- **A1/A2 — headless basics.**
  - `claude -p` runs nested inside a live session, with both inherited and
    scrubbed session env.
  - All agentic-plugins load, and their commands are registered
    (`orchestrator:next` and `engineer:compose` among 128).
  - `SessionStart:startup`, `UserPromptSubmit` and `Stop` hooks fire. attention
    injects the entry-brief line.
  - `AskUserQuestion` is **absent** from the `-p` tool list.
  - Every assistant message carries `usage`, and the `result` carries
    `modelUsage.<model>.contextWindow`.
- **B — plugin command under `-p`.** `/orchestrator:resume` executes its
  runbook under `-p`. `$CLAUDE_PLUGIN_ROOT` is **unset** in runbook Bash, so the
  model searched the plugin cache and first tried a version-less path.
- **D / D2 — background tasks.**
  - D: a background Bash task is **killed** when a `-p "<prompt>"` process
    exits at turn end.
  - D2: with `--input-format stream-json` and stdin held open, task completion
    **re-invokes the model** automatically, and the task's effect lands.
- **E — full chain, fresh process per step** (sonnet/medium):
  - Steps: plan (E2) → `/orchestrator:next` dispatch + compose (E4) →
    `/engineer:critique` (E7) → commit (E8).
  - E8's own `Stop` ran engineer archive + parent writeback. The subtask became
    `completed` and next-ready returned the second subtask.
  - ADR-0019 links that held across processes: dispatch linkage, Phase 4
    update, reattach, Stop writeback/archive.
  - Peak context per step ≤ 72K (7.2% of 1M); the fresh baseline is ≈ 40K.
  - Cost: productive steps $1.87, total $2.40.
  - It completed only with three driver-side mitigations: a plugin-root hint, a
    Bash allow, and reading the next verb from free-text `next_action`.
  - Without the hint, 2 of 2 critique runs declared the plugin "not installed"
    and skipped the runbook (E5, E6).
  - Three runs exited 0 having changed nothing (E3, E5, E6).
- **P1–P5 — permission posture.**
  - `--permission-mode auto` is classifier-driven: it denied compound runbook
    blocks in E4/E7 despite `--allowedTools Bash`, allowed a similar block in
    P5, and silently fell back to `default` on haiku (P1).
  - `manual` plus `--allowedTools` plus `--permission-prompts none` behaved
    deterministically (P3, P4).

### State gaps E exposed

- **Next step is free text.** After a verb completes, the engineer workflow reads
  `terminal_marker=true` / `current_phase=summary-complete`, so entry-brief
  leads with `/runtime:context status --slot` rather than the next verb. The
  next verb exists only in free-text `next_action`.
- **Plan approval is not durable.** The macro stays at `phase-2-presented` with
  "Await user approval…" forever, and `/orchestrator:next` dispatches without
  checking it.
- **Judgment requests leave no trace.** An entry-routing refusal (E1) wrote no
  state.
- **Commit timing is unguarded.** `terminal_marker` is already true after
  compose, so a commit made during compose would close the subtask before
  critique.

### Since the probes (2026-09-25 → 2026-09-29)

Four accepted ADRs landed between the probes and this ADR's adoption. One of
them changes the model.
- **[ADR-0062](0062-subtask-completion-recorded-at-landing.md): completion is
  recorded at landing.**
  - In probe E and V0, the committing worker's own Stop wrote the subtask
    `completed` and unblocked its successor.
  - Since orchestrator 0.14.0 the engineer's Stop and Phase 7 only note the branch
    commit (`subtask-engineer-terminal`).
  - `/orchestrator:done` records `completed` once the pull request has merged.
    The recorded commit is its merge commit, reachable from
    `refs/remotes/origin/<integration branch>`
    (`plugins/orchestrator/scripts/landing.mjs:15-16`, `:137`, `:230-232`).
  - Successors unblock only then.
  - Workers may not push or open PRs (D5). So, as drafted, the driver would stop
    for good after the first subtask's commit. The measured prototype does
    exactly that on the installed 0.14.0. D3a is the answer (owner decision D23).
- **[ADR-0059](0059-runbook-argument-transport.md): runbook arguments travel in
  an args file.** Its cleanup trap (`rm -f -- "$ARGS_DIR/args.json"`) adds 24
  `rm` lines to the engineer and runtime runbooks and skills. The headless worker
  must avoid them, just like the 37 found in V0.
  - Codex refuses the same trap (review docket C74).
  - The headless-runbook slice (S0) removes both.
- **[ADR-0061](0061-codex-installs-pinned-to-release-commits.md): cross-plugin
  discovery reads the caller's own install cache.** The driver resolves plugin
  roots the same way: the installed version, not the cache's highest SemVer.
- **[ADR-0060](0060-remove-host-version-tracking.md)** removed host-version
  tracking. Nothing here depended on it.

### Boundary collisions

| Where | Text | Collision |
|---|---|---|
| ADR-0035 §2 | "A new mutation domain (… host session, etc.) is forbidden until a **new** ADR adds a specifically scoped executor for it." | Starting sessions is a host-session domain. This ADR is that new ADR, scoped outside runtime. |
| ADR-0035 §4 | runtime MUST NOT "mutate active host session/context — no compaction, resume/fork/archive, session switching, or hidden host startup" | Runtime-scoped. The driver is not in runtime, but the same safety reasoning must hold. |
| ADR-0031 §6 | runtime "never mutates/compacts/switches/starts host session context" | Unchanged for runtime. The autopilot acts on the recommendation from outside runtime. |
| ADR-0024 §8 | the footer "must not auto-open new workflows or switch hosts without explicit user intent" | Launching the driver is the explicit intent. The footer itself stays advisory. |
| ADR-0010 §5 | cross-plugin contact via artifacts, no imports | The driver reads state through CLIs and files and invokes commands through `claude`; it imports nothing. Precedent: orchestrator already runs engineer's `state.mjs find-active` (`plugins/orchestrator/core/skills/next/SKILL.md:277`, `:311-312`). |
| ADR-0019 §1 | dispatch must go through the engineer command, with exports + Phase 0 in one shell (`next/SKILL.md:493`, `:528-529`) | Preserved: each worker runs `/orchestrator:next` in full, in one process. |
| `plugins/runtime/scripts/dashboard.mjs:27-29` | "never an unattended daemon" | The driver is a foreground, bounded, owner-launched loop with an explicit exit. It is not a daemon. |
| ADR-0062 §2 | a subtask is `completed` only by `/orchestrator:done` after its pull request merges | Preserved (D3a). The driver never pushes, opens or merges a PR. It records only landings the owner made, through the same `/orchestrator:done`. |

## Decision

### D1. New effect domain: `S1 — owner-launched fresh-session spawn`

Exactly one new effect domain is authorized: an owner-invoked,
foreground driver that starts **new** `claude` processes, one per step, in
the owner's repo. The safety argument rests on seven properties:

- **Owner-invoked.** The run starts only through an explicit
  `/orchestrator:autopilot start` or the terminal launcher. The explicit
  invocation is itself the action-specific opt-in, per the ADR-0044 §6
  (`docs/adr/0044-session-generic-handoff-capture.md:467`) and ADR-0045 §7
  precedents. No hook, footer, config key or schedule may start a run.
- **New processes only.** The driver never resumes, forks, compacts or switches
  an existing session, including the launching one. Every step gets a fresh
  `--session-id`.
- **Foreground and visible.** No hidden startup:
  - one run per macro (lock, D8);
  - every spawn is recorded in the ledger (D8) before it starts;
  - `status`/`stop` surfaces exist;
  - the process exits on halt, completion, budget exhaustion or SIGINT/SIGTERM.
- **Bounded.** Max iterations, a total cost cap, a per-step `--max-budget-usd`
  and a per-step wall clock, with a halt and `stop`, are the bounds. No run
  wall clock bounds a run: a step that starts late gets its whole per-step
  wall clock, and an args file that still passes the removed `--max-time`
  is refused as an unknown option. *Amended 2026-10-13 (C105): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).*
  The defaults stay finite but out of the way (owner decision D10): 60
  steps, $250 a run, $25 and 60 minutes a step. A step may spend only what
  the run has left, a killed worker that reported no cost is charged its
  whole step budget, a time bound under 60 seconds is refused rather than
  raised, and the state is read before the budgets, so completion on the
  last step the cap allowed is completion. *Amended 2026-10-01 (S8, owner decision D10): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
  On timeout or abort the driver may kill **only the worker process group it
  spawned** (the ADR-0035 §4 child-only rule).
  A stall detector judges every step from its stream and its descendants'
  CPU. It records only, and the per-step wall clock stays the step's bound,
  until the owner switches it on after reviewing its verdicts; then a step
  stalled 10 minutes is aborted, and the wall clock's default becomes an
  8-hour emergency cap (ADR-0068 Decision 3). *Amended 2026-10-19 (ADR-0068, stall detection): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--stall-detection-and-the-drivers-event-file-adr-0068-slice-2).*
- **No implicit retry loop.** A step never re-runs automatically. The loop
  advances only on an **observed state change** (the fingerprint, or the
  content of the checkout's files, differs; D4 rule 5). `no-progress` halts.
  *Amended 2026-11-04 (C163, content progress): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-04--a-verb-steps-evidence-c163).*
- **Owner-declared permission posture.** The worker posture (D5) is shown before
  launch and fixed for the run.
  - The driver never escalates it.
  - `bypassPermissions` and `--dangerously-skip-permissions` are refused.
  - `--permission-prompts none` means nothing can wait on a prompt.
- **ADR-0035 §3 invariants 2–10 adopted by reference** for the driver's spawn
  executor: exact allowlist, argv arrays only, preflight, finite timeout,
  sanitized main-session output (raw worker streams only in pointer-referenced
  ledger files), post-verify, semantic failure classes, no mutation of
  sandbox/approval/auth/trust/active-session state, and documented
  partial-failure recovery.
- **Worktree lanes ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)).**
  S1 also covers, for the macro being driven and only for lanes the driver
  created (proven by the lock reason, or for an unlocked lane by an open
  removal intent that names its lane id, ADR-0067 Decision 5):
  - `git fetch --no-tags --refmap= origin +refs/heads/<baseline>:refs/remotes/origin/<baseline>`
    at the start of a run with lanes and before it creates a lane, which
    writes only that remote-tracking ref (and `FETCH_HEAD`);
  - `git worktree add --lock --reason "agentic-autopilot <macro-id> <subtask-id>"`
    under `<parent>/<repo>-lanes/<macro-id>/`. When the subtask branch is
    absent it creates it with `--no-track -b <branch>` from
    `refs/remotes/origin/<baseline>`, as `/orchestrator:next` would: the one
    branch S1 creates;
  - `git worktree lock`, `unlock` and `remove` (never `--force`) for those
    lanes.

  The lane operations above never touch a worktree the driver did not
  create. For lanes S1 grants no `git worktree prune` (prune has no path
  selector, so the owner prunes), no push, no merge, and no ref write but
  the lane fetch's (its remote-tracking ref and `FETCH_HEAD`) and a new
  lane's branch. D3a's landing fetch is unchanged. The runtime executor
  guard still forbids the operations above for runtime; the orchestrator
  adapter performs them. There is no local integration branch (ADR-0067
  L1). Interactive lane sessions (`claude --bg`) are left to a later ADR.

  In every run, serial or with lanes, S1 also covers the read-only overlap
  check `git merge-tree --write-tree` (ADR-0067 Decision 7), which writes no
  ref. *Amended 2026-10-08 (ADR-0067, worktree lanes): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).*

  S1 also covers the driver's verification checks: each a kind the
  repository declares, read from the run's baseline, run as an argv array
  with checked arguments in the lane's checkout (serial: the driven
  checkout), in its own process group, which only the driver kills, with a
  worker's environment minus the run's admission token and autopilot flag,
  under the heavy-work lock (ADR-0068 Decisions 5 and 6). *Amended 2026-10-20 (ADR-0068, driver-run verification): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3).*

Runtime is **not** granted S1. Runtime's §4 ceiling, including "hidden host
startup", is unchanged. ADR-0035 is cross-referenced, not amended (owner
decision D1, 2026-09-29).

### D2. Placement

- **Driver:** `plugins/orchestrator/adapters/claude/autopilot/`, a Claude-only
  adapter. Node ESM, no dependencies. It spawns the `claude` CLI; no Agent SDK.
  - Orchestrator owns macro sequencing.
  - ADR-0019 §1 already designs out-of-process dispatch (`--peer`, deferred PR-F).
- **Command:** `/orchestrator:autopilot [preview|start --execute|status|stop]`,
  dry-run by default (Q6): a bare invocation or `preview` observes, decides and
  prints the posture without spawning anything.
- **Optional terminal launcher:** `~/.agentic-plugins/bin/agentic-autopilot`,
  a thin shim that finds the installed orchestrator and delegates. It follows the
  statusline/codex-shuttle template pattern
  (`plugins/runtime/scripts/receiver-api.mjs:5-26`): logic lives in the plugin,
  the installed file only bootstraps, and runtime never executes it. The
  launcher ships as `launcher.template.mjs`; `preview` prints the command that
  installs it, and nothing installs it for the owner (owner decision D13). *Amended 2026-10-01 (S8, owner decision D13): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- **Oracle:** `runtime:context entry-brief` stays runtime-owned and **R0**. It
  gains rows for the D6 fields (plugin change spec). The driver consumes it
  through `--surface cli`, which always computes. Until those rows ship (S7),
  the driver composes the view itself and uses the brief as a guard:
  `indeterminate`, `no-branch-context`, two live workflows competing on the
  branch, or a lead outside the step table halt `owner-choice`, while the
  entry-capture lead and a leaderless `owner-choice-required` are normal
  between steps. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- **Host-neutral vs adapter.** The D6 state additions are host-neutral core
  contract. Only the driver is adapter.

### D3. Step model

One **step** = one command executed in one fresh `claude` process.

| step command | when | notes |
|---|---|---|
| `/orchestrator:next` | macro approved, a subtask is ready, no active engineer child (with lanes, [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6: none on that subtask, which gets its own lane; *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).*) | dispatch + the subtask's first verb in the same process (ADR-0019 §1 requires the exports + Phase 0 + Phase 4 in one process) |
| `/engineer:<verb>` | active engineer child with `next_step.kind=verb`, `confidence=HIGH` | reattaches (append-on-resume) |
| `/engineer:commit` | `next_step.kind ∈ {commit, done}`, `confidence=HIGH` | New verb-chain commit surface (Q1, D2; plugin change spec §1.8). `done` routes here too: with nothing staged it archives the workflow instead of committing (the no-changes close). It lands together with "autopilot verbs skip `set-terminal`". |
| `/orchestrator:done <id>` | a committed subtask whose PR has merged (`state.mjs resolve-landing` ok), or `--no-commit` after a no-changes close | records completion (ADR-0062); successors unblock (D3a) |
| `/orchestrator:finalize` | every subtask `completed` (none deferred/abandoned) | terminal close |

The verb is the atomic durable unit. `/engineer:start` keeps direction
approval, the exploration map and the plan only in conversation, so it is
**out of scope**: autopilot runs macros whose subtasks are verb-chains (v1
covers macros and verb-chains only, owner decision D4, 2026-09-29). The
driver is stateless across runs. It re-derives everything from durable state
each iteration, so re-launching after a halt continues.

**The step grammar.** The policy renders a step only from this closed set,
and only identifiers checked against a closed alphabet enter a prompt:
`/orchestrator:next <id> --workflow=<macro>`, `/engineer:<verb>`,
`/engineer:commit`, `/orchestrator:done <id> --workflow=<macro>`,
`/orchestrator:done <id> --no-commit --workflow=<macro> <fixed reason>` and
`/orchestrator:finalize --workflow=<macro>`. The macro is pinned on the
first look, so a later step finds it whatever branch is checked out. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
The one other text the driver puts in a prompt is a fixed sentence after a
verb's command when it resumes that verb for the final verification (the
commit gate, below): fixed in the driver (`policy.mjs`
`FINAL_VERIFY_SENTENCE`), in a closed alphabet, and carrying no word of the
owner's, of a worker's or of a file's. The owner's `--next` still accepts
the bare commands alone. *Amended 2026-11-10 (C178, the commit gate): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-10--the-commit-gate-c178).*

**The verification step.** One more step runs no `claude` process: when the
child's next step is `verify` and the run offers verification, the driver
runs the requested checks with no LLM, records each result in the workflow,
and then dispatches the request's `on_pass` when every check passed on the
lane's current tree, leaves the request for later when a stop, a hold, a
drain or the driver's end cut the batch short, or resumes the requesting
verb otherwise. It costs nothing and is bounded by the checks' timeouts, the
batch's running time and its wait for the heavy-work lock (ADR-0068
Decision 5). *Amended 2026-10-20 (ADR-0068, driver-run verification): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3).*

**`/engineer:commit`** is `phase7-commit.mjs --mode autopilot`, the whole
step. It refuses outside an autopilot run, on an `/engineer:start`
workflow, over an owner gate, and with a pending peer ensemble, before
anything is committed. On a clean tree it recovers an interrupted commit,
closes the workflow, or refuses with the reason: a close needs a clean `git
status`, HEAD at the baseline, no marked commit, `next_step_kind: done` and
a workflow that is not an `/engineer:start` one; a refusal (`blocked`)
carries one of `partial-commit`, `unmarked-commits`, `next-step-not-done`,
`no-baseline`, `git-probe-failed`, `status-not-clean` or `start-workflow`.
`git diff --name-only HEAD` alone cannot prove a clean tree: it does not
show a staged change the working tree reverted. It stops at `staging-set`
when `ask_user` is true, when the workflow did not begin on a clean tree
(its recorded status digest is not the digest of an empty status), or when
the index is pre-staged: only the owner can tell pre-existing hunks
from the workflow's own. Otherwise it commits under `--strict-cc`. Under
autopilot every staging bypass (`--confirm-non-interactive`,
`--non-interactive`, `--accept-current-tree`, `--include-extra`,
`ACCEPT_CURRENT_TREE=1`) and a direct `--mode execute` or `--mode close` are
refused with exit 2. A close writes `close-complete` with the marker and
archives the workflow itself, printing no handoff; one stopped between its
two writes is finished by running it again, and the handoff a Stop hook
renders for such a workflow names that rerun, not a commit. The Stop hook
never notes a `close-complete` workflow on its parent. In the clean-tree
test both endpoints of a rename count, so a rename into workflow storage is
a deletion outside it. Execute takes the workflow out of its terminal state
(`beginCommit`: `phase-7-commit`, marker off) once every subject is checked,
before the first commit, and before the A2 fast path's gates. Execute and close refuse while an owner gate is
set, in either mode. The interactive `--suggested-subjects` option uses
plan mode's `inferSubject` for every commit, single or split, so no subject
passes through a shell. A commit leaves the next step as it was and sets no
`pr-handling` gate: waiting to land is read from state (D3a). *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*
The commit worker writes each subject, and Phase 7 checks its type and
scope against the files that commit touches (ADR-0028 §P6, its
implementation note of 2026-11-04). *Amended 2026-11-04 (C163): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*

**The commit gate.** In a run that offers verification over a declaration
with a suite kind, the driver takes the commit step only with the whole
suite's evidence for the lane's tree as it is. Without it the driver resumes
the workflow's last verb, with the fixed sentence above after the verb's
command, so that the verb ends with the final verification. The owner's
forced commit is refused the same way, and an interrupted commit is taken up
only on the content it was admitted on. The rule, its routes, its records
and its limits are ADR-0068's (Amendment 2026-11-10, rule 4). The resumed
verb is usually a critique, and counts as a round of the critique cap (D4). *Amended 2026-11-10 (C178, the commit gate): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-10--the-commit-gate-c178).*

**Postconditions.** Each step has one beyond "something changed": a dispatch
leaves the subtask in progress with an active child; a commit archives,
commits or sets a gate; a done completes the subtask; a finalize archives
the macro. A commit recovery the Stop hook keeps refusing therefore halts
once instead of repeating. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
A step that runs a verb (a dispatch's first verb, and every later verb step,
a verification resumption included) must also leave, in what it appended to
its child's phase notes, at least one new `### Phase 1: <Verb> (synthesized)`
section of that verb, with text under its synthesis or its artifact (a
subsection other than `Ensemble launched …` and `Active next-action
proposal`; a fence delimiter is not text), among the headings after the
body's `## Phase notes` (never the request quoted before it; a body with
no recognized `## Phase notes` is no evidence): the body the look before the step read must be the start of the
body after it, and the section must begin past it. The verb is the step's;
a dispatch whose subtask names none is judged by the child's
`dispatched_verb`, or else by any verb. A dispatch's child is new, so its
baseline is an empty body; only a dispatch's is. A later verb step is bound to the child the look
before it read, halts when that look held no child for the subtask, another
workflow id or an `error` child, and must leave its child active (only
`/engineer:commit` closes a workflow under autopilot), so a step that
archives its child, completes its subtask or archives the macro cannot leave
the rule with nothing to judge. A step that fails this, a look that could
not read the notes before or after the step, and a step that changed the
notes before its appended part halt `owner-choice` on the subtask with no
pointer, the shape of every postcondition, the detail naming the missing
section. A verb
that concludes nothing records that in its own section and passes; no verb
is required to change a file, and a changed file never stands in for the
section. An owner-forced step, a verify step
and a step whose child now records an owner gate are not held to it. All of
this is read from facts the observer reads itself, never from the worker's
report. It is judged after the step's other checks and after the peers it
left are settled. The grammar reads the request before `## Phase notes` as
no markdown (its first such line ends it), so a fence there cannot hide the
notes, and inside the notes it opens a backtick fence only as CommonMark 4.5
does (an info string with no backtick), so a note line such as "```a```
inline" swallows no later section. The blank lines the engineer's writes add
before a body are dropped before the comparison. A fence a note opens and
never closes runs to the end of the body, as in CommonMark, and hides the
sections after it: the step halts, a limit that fails closed. Its other
limits: it proves a recorded completion, not the truth of the worker's
analysis (a fabricated section with text passes, and so does a note appended
twice); a worker that brings back an archived workflow of the subtask as its
dispatch's child passes on that workflow's old sections; when the step fails
the rule and a more precise diagnosis (a plan revised past its approval, a
peer left pending) also holds, the step's halt is the one reported and the
other shows at the next run; a child
archived between the look's two reads is unreadable notes, a halt with no
retry; and the content projection trusts each entry's stat as `git status`
does, so an edit whose file times were put back reads as no progress, a
halt. *Amended 2026-11-04 (C163, a verb step's evidence): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-04--a-verb-steps-evidence-c163).*

### D3a. Landing (ADR-0062; owner decision D23, 2026-09-29)

The owner lands the work, and the driver records the landing and waits for it.
ADR-0062 is unchanged.
- **Landing check.**
  - For every `in_progress` subtask whose engineer workflow is archived with its
    terminal marker set, the observer runs `git fetch origin <integration branch>`
    and then orchestrator `state.mjs resolve-landing`.
    - That CLI is read-only (`plugins/orchestrator/scripts/state.mjs:8470-8504`).
    - It answers `ok` or a closed `reason` enum.
  - "Waiting to land" is derived from these state facts, never from the macro
    note's text (R5).
- **Landed** → step `/orchestrator:done <id>`.
  - Its runbook calls `gh` only from inside node, so the worker's `Bash(gh …)`
    denials do not block it, and it pushes nothing.
- **No commit to land** → after the no-changes close, step
  `/orchestrator:done <id> --no-commit`. The reason is an agent-written file
  (ADR-0059, ADR-0062 §3).
- **Not landed yet** (`no_pr`, `not_merged`) → the subtask waits.
  - Other ready subtasks are still dispatched. None of them can depend on it,
    because an unlanded predecessor keeps its successors blocked.
  - When nothing is dispatchable and one or more subtasks wait, the run halts
    `awaiting-landing`. It lists each branch with the push and PR commands for
    the owner (none for a branch outside `[A-Za-z0-9._/-]`).
  - Several subtasks may be in progress at once. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- **Any other refusal** → halt `owner-choice` with the reason.
- **Resume.** The owner pushes, reviews and merges, then relaunches. The driver
  is stateless, so it records the landings and continues.
- **Success** is the archived macro, and only for the plan the owner approved:
  an archived macro whose plan changed during the last step halts
  `plan-unapproved`. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- **Outcomes.** Once a workflow is terminal its phase is the outcome, and
  `next_step` is history:

  | durable state | meaning |
  |---|---|
  | active, not terminal (commits may exist) | in progress, or an interrupted commit: `/engineer:commit` recovers it |
  | archived, terminal, `commit-complete` | committed: check the landing |
  | archived, terminal, `close-complete` | closed without a commit: `/orchestrator:done <id> --no-commit` |
  | active, terminal | the archive has not run (a Stop gate failed, or a close stopped before its archive): `/engineer:commit` again |

  *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*

A chain macro therefore needs one landing round per link. That cost is accepted,
for three reasons:
- A merge is a review, a genuine judgment (R2).
- What the driver removes is the mechanical relay between verbs and sessions.
- The alternatives reopen what ADR-0062 closed (§Alternatives).

### D4. Gate policy

The policy is a pure function `(view) → proceed(command) | halt(reason)`. The
view is:
- entry-brief (`--format json`);
- orchestrator `state.mjs next-ready`;
- the active engineer workflow's `next_step` / `awaiting_owner`;
- the macro's `plan_approval`;
- git branch / HEAD / clean.

**Proceed** only when **all** of the following hold:
1. The observer yields exactly one command from the D3 step table: one in a
   serial run, and one per lane with lanes
   ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6).
   It comes from an entry-brief `disposition=lead` with an allowlisted
   command, or from engineer `next_step`, or from next-ready.
2. No `awaiting_owner` is set on the macro or on the active engineer
   workflow (with lanes, on the lane's).
3. `plan_approval.status=approved` and `plan_approval.plan_hash` matches the
   current `subtasks[]`. `/orchestrator:next` holds the same gate itself
   (`state.mjs approval-gate`, one decision point for both hosts, which no
   runbook re-derives), in `commands/next.md` Phase 1 after the
   dispatch-ready validation and before Phase 2, for an explicit id as well
   as for the automatic pick, and the Codex mirror runs the same command
   with `--host codex`. Under autopilot it refuses a plan pending approval,
   changed since it was approved, or with no approval recorded (`✗
   plan-unapproved`, then `Pointer: <path#anchor>` and the owner's action,
   exit 1: the macro's `awaiting_owner_pointer` when a gate is set
   (`#ensemble-synthesis` under `plan-conflict`), and `<macro file>#macro-plan`
   otherwise), and a
   selected subtask that differs from the approved plan's entry for its id in
   any field the hash covers (that refusal tells the worker to run
   `/orchestrator:next` again); interactively it never refuses, and prints one
   warning line for a pending or stale approval. The gate checks at
   dispatch and is not a lock; this rule halts before the next step. An
   approval that changes the plan joins the run locks as an admission, so it
   is refused beside a live run of the macro, and one that changes an
   in-progress subtask's topic or profile records a rebinding of its child,
   and is also refused while that lane is held, has a release awaiting
   comparison or has a persona operation open; the dispatch comparison
   accepts the rebinding only under the current approval, and for an active
   child only once the child has been told (ADR-0068 Decision 8). *Amended 2026-09-30 (S6): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s6-orchestratornext-approval-gate).* *Amended 2026-10-20 (ADR-0068, rebinding): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--main-session-instructions-and-rebinding-adr-0068-slice-4).*
4. For `/orchestrator:next` only: the working tree it runs in is clean (with
   lanes, the lane's).
5. The step made progress since the previous step (its state fingerprint or
   the content of the checkout's files changed, as below): with lanes, a
   lane's fingerprint since that lane's previous step, while `/orchestrator:done`
   and `/orchestrator:finalize` keep the macro-wide one. The first iteration
   is exempt, and with lanes each lane's first step. *Amended 2026-10-08 (ADR-0067, rules 1, 2, 4 and 5 per lane): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).*
   `no-progress` (and the C127 peers-only check) hold a step unchanged only
   when its fingerprint and the content of the checkout's files are both
   unchanged, so an edit of an already-modified file is progress. The
   content is `lane-digest.mjs` `contentProjection`: the tree the checkout's
   non-ignored files make through a temporary index, without HEAD, without
   `.agentic-plugins/state` and `.agentic-plugins/runs`, each checked-out
   submodule by its own projection in place of its gitlink (so a commit
   inside one is no content either). A look that could not project it
   compares as before. The projection is no fingerprint's, so no park record
   changes version, and it is never evidence of a verb. *Amended 2026-11-04 (C163): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-04--a-verb-steps-evidence-c163).*
6. Budgets remain: iterations and total cost; each step's own wall clock
   (D1) still bounds that step, and there is no run wall clock. *Amended 2026-10-13 (C105): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).*
   Once the owner switches the stall detector on, a step is bounded by the
   stall rule and by the emergency cap (ADR-0068 Decision 3, item 8). *Amended 2026-10-19 (ADR-0068, stall detection): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--stall-detection-and-the-drivers-event-file-adr-0068-slice-2).*

**Halt** reason codes (closed set):

| reason | trigger |
|---|---|
| `owner-choice` | entry-brief `owner-choice-required`, `indeterminate` or `no-branch-context`, or a lead command outside the allowlist (e.g. `/orchestrator:plan`, `/runtime:context status --slot` when nothing else leads) |
| `awaiting-owner:<gate>` | `awaiting_owner.gate` is set |
| `low-confidence` | `next_step.confidence` is MEDIUM or LOW |
| `owner-decision` | `next_step.kind=owner-decision` |
| `plan-unapproved` | `plan_approval` missing, pending, or hash mismatch |
| `awaiting-landing` | committed subtasks wait for their PRs to merge, and nothing else is dispatchable (D3a) |
| `dirty-tree` | tree not clean before a dispatch |
| `no-progress` | fingerprint and content unchanged (proceed rule 5) after a step that exited 0; or a verb that asks for the same checks again on an unchanged tree after a verification batch in which they all passed or one failed (after a timeout with no failure they run again). A batch is judged by its results, never by `no-progress`, and its recorded results count as a change of the child for the step it dispatches (ADR-0068 Decision 5, items 7 and 10). *Amended 2026-10-20 (ADR-0068, driver-run verification): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3).* |
| `worker-failed` | non-zero exit, `is_error`, or timeout |
| `permission-denied` | the worker hit a denied tool it needed (from `permission_denials`) and made no progress |
| `compaction-imminent` | a PreCompact hook event appears in the worker stream (the step is aborted) |
| `step-oversized` | retired: never raised; a step's peak context is recorded, an observation (D7). The code stays in the closed set. *Amended 2026-10-13 (C136): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).* |
| `budget` | the iteration or cost cap reached, or a rate-limit window that throttles new lanes with no reset time while nothing runs to refresh it ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6); there is no time cap and no deadline. *Amended 2026-10-13 (C105): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).* |
| `version-drift` | installed plugin versions changed since the run started, or the content of a loaded plugin or a pinned script root did ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 8) *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).* |
| `interrupted` | SIGINT/SIGTERM from the owner |

**Halt scope.** With lanes each halt has a scope, set by its cause, not by
its code or by whether it names a subtask. The run-wide causes are a closed
list:
`version-drift`, `budget`, `plan-unapproved`, a gate on the macro, a halt
that names no lane of the plan (the other macro-level halts, the aggregate
halts), the run's footing wherever it is met (the baseline fetch, the
rollback fence), a finalize's halts, a done's once its worker started (a
done that could not spawn parks its lane), the checks on the driver's own
checkout, a worker group that outlived SIGKILL (in any lane, although its
code is the lane's `worker-failed`) and an unreadable holds directory; they
drain the run. `interrupted` aborts it. Every other halt is a lane halt and
parks only that lane (ADR-0068 Decision 1, item 1). Serial runs keep the
drain. *Amended 2026-10-19 (ADR-0068, lanes that keep going): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).*

**Live workflows.** Every live engineer workflow that claims the macro must
be the active child of an in-progress subtask: a dispatch interrupted before
it recorded the subtask in progress halts instead of dispatching beside it.
An archived child is held to the same linkage as an active one (parent,
subtask, branch, id). A live workflow in `phase-7-commit` (an interrupted
commit) or in a terminal commit phase routes to `/engineer:commit`, never to
its stale next step; an `/engineer:start` workflow, a detached child and a
pending peer ensemble halt. The worker's structured report is a cross-check
only (owner decision D11): it names the engineer workflow it echoes, a
report that disagrees with the state halts `owner-choice`, and it never
allows a step. *Amended 2026-10-01 (S8, owner decision D11): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*

**Owner-forced steps.** `--next` replaces only the judgment halts of the
active engineer child (low confidence, an owner decision, no next step) and
goes through its step's prerequisites. Its grammar is `/engineer:<verb>`,
`/engineer:commit` and `/orchestrator:next [<subtask>]`: `/orchestrator:done`
and `/orchestrator:finalize` run exactly when their prerequisites hold, so
forcing one could only skip a prerequisite. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).* While a
run lives, the owner may also give a lane its next step as an instruction:
the same grammar without the dispatch, and the same reach (it replaces the
recorded step and its judgment halt, goes through the step's prerequisites,
and leaves every gate, error and landing refusal standing), except that it
never replaces an interrupted commit, which runs again first; with a note for
the child, applied at the lane's next step boundary. A forced step on a lane
with a pending instruction that carries a step is refused (ADR-0068
Decision 7). *Amended 2026-10-20 (ADR-0068, main-session instructions): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--main-session-instructions-and-rebinding-adr-0068-slice-4).*

**`awaiting_owner.gate`** is a closed enum of genuine-judgment gates only:
`plan-approval`, `plan-conflict`, `scope-routing`, `decide-conflict`,
`peer-conflict` ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
Decision 8: a conflict verdict in critique or investigate),
`recurring-finding`, `staging-set`, `pr-handling`, `critique-cap`,
`duplicate-workflow`. The source of each gate is mapped in DESIGN §6.3. *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).* *Amended 2026-11-09 (C176, `critique-cap`): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-09--critique-convergence-c176).*
One more gate, `review-outcome`, is derived and never stored (the review
gate, below).

**Ceremony gates** auto-pass while `AGENTIC_AUTOPILOT` is set:
- **Commit subject confirmation:** the commit worker writes each conventional
  subject, and Phase 7 checks its type and scope against the files that
  commit touches (D3). *Amended 2026-11-04 (C163; the subject was first
  inferred from verb, profile and package): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*
- **"Recommended: X. Proceed?":** proceed with X.
- **Presentation-mode prompt:** batch.
- **critique → refine MINOR selection:** the existing default rule, CRITICAL + MAJOR.
  For a document deliverable that is the open CRITICAL and MAJOR findings
  of the workflow's review ledger, a scoped re-critique leaves a new
  non-CRITICAL finding outside the passages a refine changed open for the
  owner instead of carrying it, and the `recurring-finding` gate fires on
  the ledger's recurring findings only (§ Document deliverables, below);
  code deliverables keep the default rule. *Amended 2026-10-14 (C120): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--the-ceremony-gates-c120).* From a
  subtask's second critique the selection narrows further (§ Critique
  convergence, below). *Amended 2026-11-09 (C176): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-09--critique-convergence-c176).*
- **End-of-verb Active Next-Action Proposal:** persisted as `next_step`; the driver decides from it.
- **The approval points inside the decide, compose and refine skills**, and
  each verb's Autopilot section: their own "wait for the user" instructions
  would otherwise stall an unattended step, since Claude commands run those
  skills too. *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*

The same gates stay interactive when a human drives.

**`decide` (R4):**
- ensemble verdict CONFLICT → `awaiting_owner.gate=decide-conflict` → halt;
- `next_step.confidence < HIGH` → halt (`low-confidence`);
- otherwise proceed with the recommended direction.

**Lanes (W2).** Only a run-wide halt drains the run: no new lane or step
starts, in-flight steps finish, then every lane reports once. A lane halt
parks its lane while the other lanes go on, the park is kept for the next
run, and the lane is judged again once its record changes or the owner
releases it; a lane the owner holds is left alone (ADR-0068 Decisions 1 and
2). SIGINT/SIGTERM aborts without draining. Scheduling, the per-lane
fingerprint, budgets and the throttle:
[ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6. *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).* *Amended 2026-10-19 (ADR-0068, lanes that keep going): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).*

#### The review gate

The observer reads each child's review record through the orchestrator's
byte copy of the persona library (`reviewGate`): its latest review outcome,
whether that outcome holds the commit back, each outcome, and whether the
history is complete. An outcome holds the commit back when it is `failed`,
`degraded`, `unavailable`, `malformed` or `unknown`, or `skipped` with no
reason given or as `owner-skip` (an autopilot step can write that with no
owner present); no skip, of any reason, clears an earlier outcome that
holds, and a superseded attempt listed last reads `unknown` (ADR-0028's
implementation note of 2026-11-07 gives the rule and the owner's
acceptance).

1. *The halt.* A lane whose next step would run `/engineer:commit` (a commit
   or done step, or the recovery of a commit begun) while its latest outcome
   holds the commit back halts `awaiting-owner:review-outcome`, pointing at
   the child's `review_attempts`. Its detail names the attempt, its outcome
   and error kind, why no acceptance covers it, whether the history is
   incomplete, and the ways on the command takes: run the review again
   (`--next /engineer:critique`, or `--lane <subtask> --next
   /engineer:critique` with lanes), or the owner's `state.mjs review-accept`
   of that attempt in the lane's checkout, then relaunch. The command names
   the workflow file's own path, quoted as one shell word when it holds a
   space, a quote or a non-ASCII character; only a path with a control
   character is left out, and the attempt is still named. Each `--next` is
   printed with nothing attached that `parseForcedStep` would refuse. An
   attempt still open offers only the new review; a record this reader cannot
   use offers neither, and says to upgrade the plugins or repair
   `review_attempts` by hand. A parked lane's `resolution.change` names the
   same ways on, from its record. A verb next step is not held.
2. *A derived gate.* `review-outcome` is never stored: a recorded owner gate
   would stop classification before the owner's `--next` and be refused by
   Phase 7. It is a judgment halt, so `--next <verb>` (a new review)
   replaces it, while a forced `/engineer:commit` is refused while the lane
   is held. A worker's report cannot name it. A forced commit a run with
   lanes took at its start meets the gate again at each decision, so an
   outcome recorded since holds it too.
3. *Resolution.* An acceptance naming the latest attempt, with the outcome,
   error kind and reason it reads now, lets the commit; the relaunched run
   reads it at its first look. A later review attempt, another outcome of the
   accepted attempt, or a gap in the history found since makes it stale for
   good (the acceptance records the record as the owner saw it); the lane
   halts again on the new outcome. Whether the working tree is still the
   accepted one is Phase 7's to compare (it reads the tree a snapshot would
   hold; this policy does not): the observer asks it (`state.mjs
   review-gate`) in the checkout it looks from, for a child of that
   checkout's branch whose accepted outcome blocks, and a tree that moved or
   cannot be compared reads held: a serial run halts on the gate with no
   worker spent. A run with lanes decides from the
   main checkout, which reads no lane's tree, so there the commit step runs,
   Phase 7 refuses it (exit 10, writing nothing), and the look from the lane
   reads the gate holding; a commit step that leaves the gate holding, with
   no new commit and no owner gate, is this same halt (`verifyStep`), with
   the record, the ways on and what the worker reported. No new
   commit alone says nothing of the review: a step stopped by a refused
   subject or an unfinished recovery, whose acceptance still covers its tree,
   is judged as any other. A worker that reports the refusal as a failure
   stays `worker-failed`, so the run cancels its peers, and carries the
   record. The latest outcome (while it blocks) and the acceptance with its
   tree, its state (matching or stale, so a re-acceptance of the same attempt
   and tree after it settled with another outcome counts) and its time (so
   accepting the first tree again, after a refusal at a second, counts: an
   act of the owner's is always reconsidered) are added to the lane's
   fingerprint, only while one of them is there, so a child with neither
   keeps the fingerprint it had: a lane parked on the gate is picked up again
   when the owner accepts, accepts again for another tree, or a new outcome
   is recorded (a no-run outcome moves no count the fingerprint held; a skip
   after a failure clears nothing, so it moves nothing). Those facts changed
   what a park's fingerprint hashes, so `PARK_FINGERPRINT_VERSION` is 4: a
   park an earlier release kept is never compared, and resumes only on the
   owner's release.
4. *Reports.* Each subtask waiting to land carries its review record in the
   landing report (the landing-ready event and its log line), the terminal
   headline and the `awaiting-landing` halt: each outcome, whether the latest
   holds the commit back, the acceptance, and an incomplete history with its
   reasons. A review-outcome halt's record keeps the same, and so does a
   lane's park, its entry in the run's lane report, its printed park line,
   and the halt a run with lanes ends on (the first held lane's as the halt's
   own, every other held lane's in its `also`). The landing log's
   observation key includes the outcomes, the acceptance and the
   completeness, so a new outcome at unchanged commits is reported again; a
   record logged before the outcomes observed none, and its subject is
   reported once more.

The driver's capability floor requires an engineer with `review-accept`, and
the observer also reads the record from an engineer's forward-compat
carrier. Limits: a workflow begun before C163 A1a holds only legacy review
rows, so its lane halts once on `unknown` and the owner accepts or reviews
again; a `done` step is held like a commit, since `/engineer:commit` commits
whatever the tree holds (over a clean tree it would only close, and the
owner's acceptance lets it); in a run with lanes a commit step over a moved
tree spends a worker, as above; a park's fingerprint holds the
acceptance, not the tree compare, so a lane parked over a moved tree is
picked up by a new acceptance or a new outcome, not by restoring the tree
alone; a legacy row pruned from `ensemble_results` is no longer seen. *Amended 2026-11-07 (C163 A1b, the review gate): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-07--the-review-gate-c163-a1b).*

#### The review binding

*Proposed (ADR-0069 Decisions 3 and 4, which hold the rule):* no look
compares a change with its reviews. The main checkout's look never runs
`review-gate` in a lane's worktree nor touches a lane's index, and every look
reads the review record as it is: the outcome gate above, and the committed
comparison Phase 7 recorded, which the landing report shows as provisional.
The comparison is Phase 7's, on every route that lands a commit; under
autopilot its refusal (exit 10, `review-held`, nothing written) ends the
step, whose report needs the owner, and the lane halts `owner-choice` with
the refusal's text; the owner's `review-binding-accept` joins the lane's
fingerprint once given, so it picks the parked lane up, and a worker's
`review-binding-accept` is refused at the write. A landing that differs from what was committed halts
`owner-choice` before the done step; one that cannot be compared goes on,
and the macro records why. A worker's `/orchestrator:done` with
`--accept-landed-change` or a waiver is refused at the write
(`subtask-update`; `--correct` is not an owner override and is not refused),
and a done step that completed its subtask with no landed commit
(`--no-commit`) halts, the macro's last subtask included, whose done
archives the macro: only the driver's done-no-commit step completes one that way. *Amended 2026-11-07 (C163 A2b, as simplified 2026-11-09): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-07--review-binding-under-autopilot-c163-a2b-adr-0069).*

#### Document deliverables

A document deliverable gets one full critique. After a refine, the next
critique reviews the passages the refine changed and the findings it
targeted (a *scoped* critique). A new finding outside those passages is left
open for the owner (`### Left open` in the note), unless it is CRITICAL,
which refine carries. Every CRITICAL and MAJOR finding open in the ledger is
refine's work, targeted before or not. A finding a refine targeted that a
critique leaves open is *recurring*, and fixing it again is the owner's call
(`recurring-finding`). A code deliverable keeps the full critique and the
judged recurring rule. *Amended 2026-10-14 (C120): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--document-deliverables-converge-c120).*

**What is a document.** The artifact set is every path that differs between
the workflow's `git_baseline.head` and the working tree (the state homes
left out). The deliverable is a document only when that set is not empty,
every path is a regular Markdown file ending in `.md` or `.markdown`
(`.mdx` carries code), no changed line, on either side, blank lines
included, is or may be code, and no path's code is changed by its prose: the
sequence of CommonMark code blocks and HTML blocks in the old text, each
block's kind, info string and content, is the one in the new text. A line is
code when either of two readers says so:

- *Reader 1*, a stateless over-reading with no fence pairing and no
  container tracking: every line from the file's first fence-like line (one
  holding three or more backticks or tildes, wherever they sit) to its last;
  every line whose leading white space reaches column 4 at the line start, or
  five columns past a block-quote or list marker in its prefix (tabs to the
  next multiple of four), with no paragraph exception; each blank run between
  two such lines; and each such line's neighbours.
- *Reader 2*, the CommonMark reference parser (commonmark.js): every line a
  code block spans, fenced or indented, fence lines included, and every line
  an HTML block spans, whatever its tags. A text holding a bare CR is read as
  code throughout (CommonMark ends a line there, git does not).

Other prose formats stay full: a `.txt` name is no evidence, and
reStructuredText and AsciiDoc have code block forms the test does not read.
*Amended 2026-10-15 (the owner's ruling on the recurring M3 finding: the two readers, every HTML block, the block-sequence rule, the vendored parser): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--document-deliverables-converge-c120).*
The parser is vendored byte for byte
(`persona-pipeline/files/scripts/lib/vendor/commonmark.min.cjs`) under a
copy notice carrying its LICENSE, the npm tarball's shasum and the sha256 of
the upstream bytes, which a test checks; it is updated only for a CommonMark
release or a parser fix that changes what it is read for, by replacing the
bytes, the LICENSE and the two hashes together.

**The review ledger** is the evidence a fresh worker reads:
`<state home>/reviews/<workflow id>.json`, written by `state.mjs` holding
the workflow's lock; no plan field and no frontmatter key is added. It holds
one *generation* per critique (mode, reason, the working tree it reviewed as
a tree object, HEAD, the baseline, the artifact set, the passages of a
scoped one, its targets, the critique runs the workflow had noted when it
opened, open / closed / abandoned), every finding with a workflow-wide id
(`G<generation>-F<n>`), severity, location, text, disposition and the refine
attempts that targeted it, and one refine attempt per critique
(`R<generation>`: its targets and the tree it left). Each ledger has an id of
its own, which `critique-scope` prints and `critique-close` must name. The
ledger is not archived with its workflow and is not pruned.

- `critique-scope` opens generation g at the working tree T, captured as a
  peer snapshot is, without materializing it, and prints the scope. A
  deliverable that is not a document records nothing and moves an earlier
  ledger aside; so does a checkout the ledger cannot vouch for (a baseline
  that is not a full commit id resolving to a commit, a working tree the
  capture cannot read, or an index entry marked assume-unchanged or
  skip-worktree). A generation a crashed run left open is abandoned by the
  next `critique-scope`. The capture stamps its index copies with the live
  index's times, so a same-size edit made in the second the index was
  written is not missed (racy git).
- `refine-record` (after the fix, before Refine-verify) records the targets
  and the tree the refine left, and prints `verify`, the mode the next
  critique would have on that tree: Refine-verify is scoped only when that
  is `scoped`.
- `critique-close --ledger <id> --generation g` records the synthesis's
  findings and prints the disposition (`converged`, `carry`, `left_open`,
  `recurring`). It refuses when the checkout no longer holds T, or the ledger
  is not the one `critique-scope` named.
- `review-status` prints refine's work (`carry`) and the recurring findings
  (a refine targeted it, and a critique closed since judged it unresolved; a
  target no critique has judged since its refine, such as one a partial
  critique did not report, is not one), which end refine on the gate before
  any fix, unless the owner already cleared that gate with Fix now after the
  last critique's notes (the resume note a fresh worker writes after it does
  not count against the ruling).
- `refine-record` runs again after any later edit in the same refine: the
  next critique is scoped only while the checkout holds the tree the last
  record saw.
- From a checkout that is not on the workflow's branch, whatever state its
  working tree is in, `critique-scope` and `refine-record` record nothing
  and leave the ledger alone, and `critique-close` refuses: a worktree
  sharing the state root never writes another branch's ledger. A ledger
  whose entries are malformed is moved aside and the critique is full;
  `review-status` reads it as no ledger. So is one whose stored passages are
  not line ranges on its artifact paths, or whose generation ids do not run
  1, 2, 3 in order. A checkout whose HEAD git cannot read reaches the script
  all the same, which falls back.
- None of this stops a verb. The runbook blocks fall back when the script
  fails (an older release without the subcommands answers `unknown
  subcommand`): the critique runs unrecorded and full, refine reads no
  ledger, and a missing refine record makes the next critique full unless an
  earlier record of the refine saw the same tree. A critique whose close
  refuses counts as a full one the ledger did not record, and until a later
  critique closes the ledger vouches for nothing: `review-status` reads no
  ledger, `refine-record` records nothing and the next critique is full.
- A critique the ledger never opened a generation for (its `critique-scope`
  failed, an older release ran it, the checkout was on another branch or
  mid-rebase, a `/<persona>:start` lifecycle ran it in its own phase) is
  caught from the workflow file, which the critique writes in any case:
  `state.mjs append --verb critique`, which the critique command's resume and
  each critique phase of a lifecycle run, notes a marker line
  (`<!-- agentic: critique run -->`) before the phase note, and each
  generation counts those notes when it opens. An older release noted only
  the critique command's `Phase 0: Resume into critique` heading, which
  counts when no marker stands on the line before it; a critique an older
  release runs inside a lifecycle notes nothing and is not caught. A run
  that names no verb in its writes (a host skill used outside the commands)
  is not caught either, and its findings are not in the notes refine reads.
  More runs noted than the last generation counted (plus the caller's own
  run, for `critique-scope`) means a critique the ledger did not see:
  `review-status` and `refine-record` read no ledger, and `critique-scope`
  moves it aside and opens a full one. A run stopped before it reached
  `critique-scope` counts too, which costs only the scope.

**Scoped, or full.** A critique is scoped only when all of these hold, and
full otherwise, with the first that failed as its reason: the default review
profile (another profile is `partial`, below); no merge, rebase, cherry-pick
or revert in progress; a non-empty document artifact set; a full generation
closed in the ledger; a last closed generation that is not partial; a refine
recorded after it whose tree the checkout still holds (nothing was edited
after the record, and an older release's refine, which records nothing,
falls back); HEAD and the baseline unchanged since that generation (no
commit and no merge); the same artifact set (no path added, removed or
renamed); every target a ledger finding; and the tree the last critique
reviewed still readable (it is unreferenced, so `git gc` may prune it, and a
lost file is not an absent one). A full critique never takes the left-open
route: every CRITICAL and MAJOR it finds is carried, and a prior finding it
does not report again is resolved (a deferred one excepted, § Critique
convergence). A *partial* critique (a profile other than the default, such
as a single lens) judges only what it reports: it resolves no finding it
does not, leaves nothing open by scope, and is never the full critique a
scoped one starts from. A refine's targets stay targets until a critique
judges them (a full one judges them all, the ones it does not report
included): one a partial critique does not report is open, it stays a target
of the next partial critique, and since the lens may not cover it, the
omission is no judgment the recurring rule counts. A finding's severity
follows the latest judgment, except that a scoped or partial critique never
lowers a CRITICAL or MAJOR one, and references that disagree take the
highest. A scoped critique resolves a finding the refine did not target only
when the critique places it in a passage, in the current text (the ledger's
location is in the coordinates of the text it was found in, which the refine
may have shifted): elsewhere it read no text, so the verdict is noted and
the finding stays.

**Passages.** The diff from the last critique's tree to the current one, per
artifact path, at Markdown block level in the current text: a code or HTML
block as CommonMark reads it, a list or a table with no blank line in it,
and a heading are each one block. A deletion anchors to the blocks just
before and after it, with the deleted text shown as before; a change that
leaves a file with no block makes the whole file the passage. A finding is
in scope when its location overlaps a passage, whatever scope the peer
claimed, and when the review marks it in. A location with no line range on
a passage path counts in scope unless marked outside; a finding with no
location cannot be shown outside; a location on a path the artifact set does
not hold (a relative path that only ends in an artifact path is another
file) cannot be placed, and counts in scope. Locations are read the ways reviewers write them (`path:12`,
`path:12-20`, `path:12:3`, `path#L12`, `./path`, an absolute path ending in
an artifact path); a reversed range is refused. A left-open finding reported
again, not CRITICAL, stays left open only when every report places it
outside the passages in the current text; a report with no location is not
placed outside. A finding a refine targeted is judged as any target,
whatever it was before: left open, or resolved by an earlier critique and
edited again, it is carried when unresolved or given no verdict.

**The peer contract.** The Scoped review and Scoped refine-verify templates
(the ensemble protocol's § Scoped re-check) give the peer the passages and
the findings by id, and ask one line per finding: id or NEW, a verdict for
an id, severity, location, in or outside, evidence. A target with no
verdict, two or contradictory ones counts unresolved. The convergence rule
is the script's, never the synthesis's.

**Precedence.** A `conflict` verdict ends on `peer-conflict` first.
`converged` only adds the commit route when the persona's own conditions
also hold (designer's accessibility veto and re-render, founder's gate
verdicts).

**Plans.** `/orchestrator:plan` proposes an ADR or other document subtask
that would settle more than two decisions as chained slices of one or two,
each stating what it owns, the ADR number every slice claims and how later
slices amend it. Advice, not a `plan-set` rule.

**Known limits.** Interactively a verb's last write is terminal and the Stop
hook archives the workflow (unless its subtask is held, has a kept lane park,
or a run of its macro is live, D6), so the next verb starts a new workflow with no
ledger and its critique is full; under autopilot one workflow carries the
loop. `/engineer:commit` commits the tree as it is and does not check the
tree the last critique reviewed. A `/<persona>:start` lifecycle runs
critique and refine as skills, not as the commands that hold the ledger
blocks, so its critique stays full; so does every critique on Codex. *Amended 2026-10-14 (C120): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--document-deliverables-converge-c120).*

#### Critique convergence

From a subtask's second critique, refine takes only CRITICAL findings and
MAJOR findings on a frequent, natural path, test gaps included. A MAJOR on a
rare path (a hand-made file, a gap of the same class as one already
recorded, a special layout) is *deferred*: recorded as a known limit, its
severity kept. This is the owner rule of 2026-10-25 applied by the loop
itself. A recurring finding, one a peer contested and one a persona veto
gate raised (designer accessibility, founder regulatory or safety) are never
deferred. A subtask also gets a cap of critique rounds, 3 by default: a
critique at the cap with nothing CRITICAL or MAJOR open proceeds to the
commit; one that is not clean parks only its lane on the owner gate
`critique-cap`, and the owner decides.

- *The gate.* `critique-cap` is a stored engineer owner gate (heading
  `### Critique cap reached`, anchor `critique-cap`), settable only with
  `dispatch_target` on, as `pr-handling` is. The policy halts
  `awaiting-owner:critique-cap` with the subtask id; the serial driver
  halts; the lane scheduler parks that lane only; the owner's clear moves
  the lane's fingerprint.
- *The count.* `critique_rounds` counts the critique syntheses a
  finish-verb recorded under an autopilot run, in all three of its forms
  (verb, owner-decision, verify), inside the same locked write, once per
  critique run (`critique_rounds_entry` keeps the run identity last counted:
  the critique-run markers of the body, plus one for a workflow the critique
  verb created). An interactive critique is no round. A critique stopped
  before its finish-verb counts nothing, and a finalize run again counts
  nothing more. A failed peer attempt is an attempt, not a synthesis: the
  finalize settles the run's review attempt before finish-verb counts, and a
  launched run whose critique attempt closed last ended with an outcome that
  is no synthesis (anything but passed, concerns or conflict) counts nothing;
  a critique that launched no
  peer is a local synthesis and counts, and one resumed after a failed
  verification batch is a new round. The keys are flat integers at the
  frontmatter's tail.
- *The limit.* `critique_round_limit` is absolute, 3 when absent. A critique
  is at the cap when the rounds, this one counted, reach the limit. Only an
  autopilot run enforces it: `finish-verb` refuses a next step that goes on
  past the critique (any verb, or a verify request whose `on_pass` is one),
  naming `OWNER_GATE=critique-cap`, before any write and again in its locked
  write, and the critique's finalize asks the same before settle, its first
  write (`state.mjs critique-cap-check` for the verb form,
  `verify-request-check` for a request's `on_pass`), both read-only, so a
  critique at the cap stops with nothing written and ends on its gate; run
  before the settle, they take the run as counted. At the cap only commit, done and an owner gate end a critique.
- *The deferral round.* A review ledger generation stores its `round`, 1
  plus the closed generations of the current ledger; `critique-scope`
  prints it, with the cap's `rounds` and `limit`. A `/<persona>:start`
  lifecycle's critiques count here though they never call finish-verb, and a
  ledger that replaced another starts again at round 1, so a finding
  recurring in the old one cannot come back deferrable. With no ledger (a code deliverable) the
  round is the cap's count with this run in it, and the deferral is applied
  in the critique's note (`### Known limits (deferred)`) by the runbook, not
  by code; the cap still bounds the loop in code.
- *Deferral in the ledger.* `closeGeneration` alone decides it. A reference
  may carry `defer` (its known limit, one line), `veto: true` and
  `conflict: true`. A deferral is taken only from round 2, for a finding
  that is MAJOR after this judgment, not recurring (computed before any
  deferral, with each candidate still open), never flagged `veto` or
  `conflict` (the flags are sticky across generations), and when every
  reference to it in this close carries `defer`, with no `resolved` verdict
  and one severity. Otherwise it stays open and the result names the refusal
  (`deferral_refused`: round, critical, not-major, recurring, veto, conflict
  or ambiguous). The
  disposition `deferred` keeps the severity, stores `defer_reason`, and does
  not block convergence. A later critique that does not report it, a full
  one included, leaves it deferred; one that reports it with no `defer`
  opens it again; a `resolved` verdict resolves it. The schema stays `review-ledger-1`.
- *The owner's exits.* Clearing `critique-cap` with
  `--grant-critique-rounds <n>` (n of 1 or more) and a verb as the next step
  sets the limit to the rounds counted plus n in the same write. Or the owner
  accepts the open findings as known limits: the next step commit, with a
  resolution naming them; that grants no round and leaves the ledger as it
  is. Clearing `critique-cap` or `peer-conflict` with another round while
  the rounds have reached the limit, without a sufficient grant, is refused;
  a grant on any other gate is refused; every clear stays refused under
  autopilot (Q2). A `peer-conflict` at the cap ends on its own gate.

The budget is per workflow: a replacement attempt of a subtask starts its
count again. Engineer and orchestrator ship this in one release: an older
reader refuses a workflow that holds `critique-cap` (a downgraded workflow
is recovered by clearing the gate with the newer engineer first), and
refuses a ledger that holds `deferred`, starting a new one with a full
critique. Known limits: an engineer older than this amendment never writes
the gate or the count, so the cap is not enforced; with no ledger the
deferral round is the cap's count, which only an autopilot verb chain's
finish-verb advances, so a code deliverable's critique in a
`/<persona>:start` lifecycle, or in a persona with `dispatch_target` off,
stays at round 1 and defers nothing; a note that quotes a critique-run
marker (or an older release's resume heading) on a line of its own, appended
again by a rerun of its finalize, counts as another round (only a hand-made
note does that); the finalize's checks before settle take the run as
counted, so a critique at the cap whose peer failed ends on `critique-cap`
(the owner grants a round), though finish-verb would have counted nothing;
the binding of a failed attempt to the run is the critique attempt closed
last (`recorded_at`, to the second; a tie goes to the later entry), so a run
settled by hand outside the finalize, or two finalizes in one second, can
leave another run's attempt the one closed last; and a peer that fails on
every critique counts no round, so the cap does not bound that loop (the
driver's other halts do). *Amended 2026-11-09 (C176, critique convergence): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-09--critique-convergence-c176).*

### D5. Worker contract

**Spawn.** An argv array, never a shell string. cwd is the checkout the step
runs in: in a serial run the driven worktree; with lanes, the subtask's lane
for dispatch, verbs and commit, and the driver's own checkout for done and
finalize
([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 5).
stdin is a pipe:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-hook-events
       --session-id <uuid>
       --permission-mode manual --permission-prompts none
       --allowedTools <allowlist> --disallowedTools <denylist>
       --append-system-prompt <autopilot rules>
       --max-budget-usd <per-step cap>
       [--model <m>] [--effort <e>]
```

*Amended 2026-10-08 (ADR-0067, the cwd): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).* The appended system prompt holds
the step rules only; the plugin-root hint it once carried is gone (below). *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*

**Model plan.** The model plan is asked before each start (owner decision
D5): `owner-default`, `mixed` (judgment verbs on the owner's default,
compose and refine on sonnet/medium, the mechanical steps on sonnet/low) or
`sonnet`. `/orchestrator:autopilot start` asks; a terminal start asks on its
TTY; anything else must pass `--models` (or `--model`/`--effort`). *Amended 2026-10-01 (S8, owner decision D5): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
*Proposed ([ADR-0071](0071-autopilot-step-model-from-settings.md)):* on its
acceptance the plans become suggestions, and the `autopilot_*` settings
(`autopilot_<step>_model`/`_effort`, read once when a run starts) a plan of
their own: with a key set and no flag a start takes them without asking;
with none set the decision above stands. *Amended 2026-11-12 (ADR-0071 proposed): [history](history/0063-autopilot-fresh-session-driver.md#observation-2026-11-12--per-step-model-settings-proposed-adr-0071).*

**Env.**
- `AGENTIC_AUTOPILOT=<run-id>`, the mode flag read by runbooks and hooks.
- Plugin roots resolved once by the driver, to the installed version (the
  ADR-0061 rule: the caller's own install cache, not the highest cached SemVer):
  - `AGENTIC_ORCHESTRATOR_ROOT` (already honored by
    `plugins/engineer/scripts/parent-writeback.mjs:76`, `:289`);
  - `AGENTIC_ENGINEER_ROOT`;
  - `AGENTIC_RUNTIME_ROOT`.
- `AGENTIC_STATE_BASE=<the run's effective state root>` and
  `AGENTIC_AUTOPILOT_TOKEN=<the run's admission secret>`
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 2
  and 4). An inherited value of either is scrubbed first. *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).*
- Scrubbed:
  - the launching session's identity (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
    `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_*`,
    `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
    `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`);
  - `AGENTIC_NOTIFY_EGRESS_CHANNEL`, so there are no per-step E1 sends;
  - the launching session's `CLAUDE_CODE_SESSION_*`, `CLAUDE_BG_*` and
    `CLAUDE_RELAUNCH_*` variables (a background session's permission rules
    travel there), and the dispatch contract variables an outer session may
    have exported (`AGENTIC_PARENT_WORKFLOW`, `AGENTIC_ORIGINATING_SUBTASK`,
    `AGENTIC_PROFILE`, `AGENTIC_TOPIC`, `AGENTIC_HOST`, `CLAUDE_PLUGIN_ROOT`). *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- Never set: `AGENTIC_COMPANION_DEPTH`. Workers are not companions, and an
  inherited depth would make in-worker peer ensembles refuse.
- `GIT_CONFIG_*` entries that block every push at the git level (Permission
  posture, below). *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*

**Session hosting (stream-json).**
1. Write one user message carrying the step command.
2. Track:
   - `system/background_tasks_changed`;
   - `result`;
   - `system/permission_denied`;
   - `system/hook_response` (PreCompact → abort);
   - per-message `usage`.
3. Close stdin only when a `result` has arrived **and** the pending background
   set is empty. Completion re-invokes the model, per probe D2.
4. On timeout or abort, kill the worker's process group (the peer-runner
   pattern, `plugins/engineer/scripts/peer-runner.mjs:711-725`). The host
   also keeps the time of the last stream event other than heartbeats and
   hooks, and the driver samples the worker's descendants' CPU. Log-only,
   the stall verdicts are recorded and nothing is aborted; switched on, a
   `stalled` verdict is one more abort, `stalled`, with the timeout's
   teardown, outranking a close on a finished report as every abort does.
   The detector stops watching at that close (ADR-0068 Decision 3). *Amended 2026-10-19 (ADR-0068, stall detection): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--stall-detection-and-the-drivers-event-file-adr-0068-slice-2).*
5. The worker's own `Stop` hooks archive the engineer workflow and send its
   terminal note to the macro (probe E8). Since ADR-0062 that note no longer
   completes the subtask (D3a).

**The finished report.** A worker that has finished its runbook can leave a
background task pending (a test run, a monitor), which item 3 would hold
open to the step's wall clock. The step report carries a required boolean,
`waiting_on_background`: `true` in a report the worker files while it still
waits on a background task's notification (the provisional report, which also
says `failed`), `false` in its last. The worker's appended rule 6 says both. *Amended 2026-10-13 (C127, C123): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).*
- **Close on a finished report.** Item 3 stands, and one more close is added:
  when the last `result` is not an error and its report is valid in every
  required field with `waiting_on_background: false`, stdin closes after the
  2 s debounce even with background tasks pending. That close is armed once
  per result: other stream events, the task list moving included, do not
  push it back, and a new result, a task notification or an abort disarms
  it. A worker that exits before it fires is not closed on its report. A
  report that says it waits, or that is missing the field or invalid in
  another, keeps today's wait.
- **Shutdown after it.** A worker that has not exited 10 s after that EOF gets
  SIGTERM on its group, and SIGKILL 5 s later. Nothing after the EOF re-arms
  the grace. The group teardown of item 4 then ends what is left: the
  abandoned background tasks. An abort (timeout, PreCompact, interrupt,
  provenance) keeps its precedence throughout: it disarms the close and runs
  its own escalation.
- **Judging it.** `verifyStep` does not judge the exit status of a step closed
  on its report while that report is still the last result and is not an
  error: a signal of the teardown is not the step's failure. A result that
  arrives after the EOF ends that exception, never the record of the EOF. A failure report still halts
  `worker-failed`, a lingering group still halts, and a last report that says
  it still waits, from a worker that exited, halts `owner-choice` (or
  `worker-failed` when it says `failed`).
- **Ledger.** The step's `finished` line records `report_eof` (stdin was
  closed on a finished report), `closed_on_report` (that close still holds),
  `abandoned_background` (each `{task_id, task_type, description, run_id}`,
  the tasks pending at the EOF), `report_teardown` (`null`, `signalled` or
  `killed`) and `peer_settlements`.
- **The step's peers.** A peer runs detached from the worker's group, so the
  teardown does not reach a peer run the step left pending. `finish-verb`
  already refuses under autopilot while a peer is pending on its workflow,
  so such a run is one left after the verb's last write, or on another
  workflow that claims the subtask. On this success
  path (any step whose stdin was closed on its report) the driver cancels each run that became pending during the step on its
  own subtask's engineer workflows (the same scope as after a failed step,
  [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6), then
  settles it from its ledger with `peer-runner settle` and no verdict: a run
  that failed, was cancelled or was abandoned is recorded `failed`, one that
  completed with no usable answer `degraded`. A run that completed with an
  answer is not settled, since no synthesis took it: the step halts
  `owner-choice` naming it. The step is judged before this cleanup, and the
  next decision reads the state after it. A cancellation that does not go
  through keeps the run's open-run record for the next run's cleanup; a
  settlement that does not leaves the pending row, which the policy halts on
  until it is settled. Either halts the step with the command to run. A
  step that changed nothing but such a peer row then halts `no-progress`:
  the row alone passed the progress check, and the next decision would run
  the step again. With
  lanes the work runs off the loop, in the lane's checkout. The run refuses
  to start on an engineer without `peer-runner settle`.
- **Known limits.** A peer whose pending row was never recorded is not
  found, as after a failed step. `peer-runner cancel` signals the run's
  verified process; a detached descendant that leaves its group is not
  reached. A dead run's cleanup still cancels without settling.
  `peer-runner cancel` reads the run's status before it verifies the
  process, so a peer that completes in between is recorded cancelled, and
  then settled `failed` though it had an answer; closing that race is the
  engineer's.
- **C123.** The serial driver checks for an interrupt once more after the
  last await before a spawn (the drift check's root resolution), and an
  interrupt there releases the step's reservation and ends the run
  `interrupted` with no worker started and no `started` line, before any
  drift the same resolution found. A run with lanes already yields at that
  point. *Amended 2026-10-13 (C127, C123): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).*

**Worker lifetime.** Everything that can fail is set up before the worker is
spawned, and the worker is recorded in the run's locks before it receives
its prompt, so a driver that dies in between leaves a worker with nothing to
do, which exits when its stdin closes. An abort sends SIGTERM to the
worker's process group, and SIGKILL five seconds later to a worker that has
not exited; once the worker has exited, output a descendant still holds is
abandoned after three seconds. A step is over only once its worker's process
group is empty: after every step the group is sent SIGTERM (unless an abort
already sent it) and polled, and five seconds after the signal what is left
gets SIGKILL; the driver releases its locks and exits only after that. The
ledger records `group_teardown` (`empty`, `terminated`, `killed`, or
`lingering` when a process outlives SIGKILL); a `lingering` step halts
`worker-failed` whatever else it did, and the run keeps its lock entries,
which name the worker's process group, so no run starts beside them; a
process group under that id whose leader is provably another process does
not count. Only a different start time proves a reused pid: on macOS the
fingerprint also holds the command line, which a wrapper that execs
`claude` in place changes without becoming another process. After a
step that was aborted or failed, the driver cancels the peer runs that step
left pending on its own subtask's engineer workflows (ADR-0067 Decision 6),
through engineer's own `peer-runner cancel`, which verifies the process
fingerprint. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).* *Amended 2026-10-08 (the scope narrowed to the step's own subtask): [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6.*

**Plugin roots.** Every runbook block that uses its plugin root opens with
`CLAUDE_PLUGIN_ROOT="${AGENTIC_<PLUGIN>_ROOT:-${CLAUDE_PLUGIN_ROOT}}"` (Claude
Code writes the plugin's path in place of the braced form when it loads a
command or skill; the bare variable is empty in a Bash call), and when that
is still empty falls back to the newest cached release directory (`X.Y.Z`
with no leading zeros, optionally with build metadata whose identifiers are
all non-empty; `sort -V` alone ranks a prerelease or a stray name above the
newest release). Path references in command prose use the braced form too,
so the model reads where the skill files are. On a directory marketplace
the substituted path is the marketplace source (on the owner's machine the
repository's `plugins/<name>`, not the install cache), so an interactive
session there runs the working tree's scripts with the text it loaded. A
worker still runs the installed version the driver's exports name, since
`AGENTIC_<PLUGIN>_ROOT` comes first, and no runbook shell removes a
file (`rm`). *Amended 2026-09-29 (S0): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-29--s0-headless-safe-runbooks).* The driver's plugin-root hint is
removed: the capability floor requires releases that carry S0. The step is
aborted before its first turn when a plugin the worker loaded (its
`system/init` event) is an orchestrator, engineer or runtime that lies inside
the repository the run drives (`owner-choice`: drive a separate worktree),
or differs from the pinned version or from what earlier steps loaded
(`version-drift`); roots inside the repository are refused at start for the
same reason. The driver requires the engineer release that carries S3+S4
(`autopilot-preflight`, `finish-verb`, `/engineer:commit`'s modes) before it
starts a run. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).* *Amended 2026-10-01 (S3+S4, the capability floor): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*

**Runbook blocks.** A block stops when one of its writes fails (a resume
write, a phase note, an `ensemble-commit`), so a failed write never
publishes a next step; `/orchestrator:abort` and `/orchestrator:finalize`
run their Phases 0 to 3 in one Bash call, and each later block stops when
Phase 0 has not run in its shell. Those two take the step-2 tally from the
shim's exit status, exit non-zero when find-active or find-macro fails, fail
their step-2 gate when the tally file is missing, and count a child of the
macro the shim cannot read, so step 3 never closes the macro over a live
child. compose and refine never commit. A verb
runs its peer runner in the foreground of a host background task (on
Claude, `run_in_background`), never behind a shell `&`, so the step can
wait for it; at S3+S4 the rule covered engineer's verbs (designer and founder
kept the `&`), and their runbooks now follow it too. *Amended 2026-09-29 (S0): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-29--s0-headless-safe-runbooks).* *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*

**Permission posture.**
- Mode: `manual`, not `auto`, because auto is classifier-driven and
  nondeterministic (P1–P5).
- Allowlist: `Bash Read Edit Write NotebookEdit Task Skill WebFetch WebSearch TaskStop Monitor`.
  `Task` is the subagent tool's name in a `-p` worker on 2.1.281 (interactive
  sessions call it `Agent`). investigate and critique spawn read-only subagents
  through it.
- Denylist, outward-facing or scope-escaping:
  `Bash(git push:*) Bash(gh pr:*) Bash(gh release:*) Bash(gh repo:*) Bash(gh api:*) Bash(gh issue:*) Bash(osascript:*) Bash(open:*) Bash(npm publish:*) Bash(git remote:*)`
  plus `PushNotification RemoteTrigger CronCreate ScheduleWakeup SendMessage EnterWorktree Workflow`.
  All of these appear in the `-p` worker tool list.
- Pushes are blocked at the git level too, since Bash rules match a
  command's leading words (`git -C <dir> push` passes `Bash(git push:*)`):
  each worker's environment carries `GIT_CONFIG_*` entries that rewrite a
  push to any https, http, ssh or git URL, and to each remote's own URL, to a
  scheme no remote helper serves (`pushInsteadOf`; `insteadOf` for an
  explicit pushurl). Local pushes and fetches are untouched; `git@` covers
  the scp-style form of common hosts, and an scp-style URL with another user
  that is no remote's URL is left open. The driver refuses to start on a
  repository whose remote has an explicit pushurl equal to a fetch URL, and
  says how to remove it. The denylist and this block are guardrails, not a
  sandbox: `curl` stays allowed (owner decision D17), and `gh` subcommands
  with global flags first pass the `Bash(gh pr:*)`-style rules. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- A needed-but-denied action surfaces as `permission-denied` or
  `awaiting-owner:pr-handling`.
- A dedicated worktree (the `runtime:worktree` planner) is recommended.
- In a run that offers verification (recorded in `run.json` and told to each
  worker), a worker makes its edits and the quick checks it judges to take
  minutes, runs no mutation run and not the whole test suite in its step,
  never waits there for the heavy-work lock, and ends with the next step
  `verify`, a request naming declared checks with data arguments and the
  step that follows. The posture does not bind the processes a check starts,
  as it does not bind those a worker's script starts (ADR-0068 Decision 5,
  items 1, 2 and 8). *Amended 2026-10-20 (ADR-0068, driver-run verification): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3).*

### D6. State contract additions (host-neutral core)

- **`next_step` (engineer workflow).** Written at verb State finalize.
  - `kind`: `verb | commit | owner-decision | done`, and `verify` for the
    driver-run verification step (ADR-0068 Decision 5). *Amended 2026-10-20 (ADR-0068, `verify`): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3).*
    - `done` means the subtask needs no further step. `/engineer:commit`
      closes it without a commit, and `/orchestrator:done --no-commit` records
      completion (D3a).
    - A missing `next_step` is unknown, and the driver halts `owner-choice`.
  - `verb`: one of the six canonical verbs when `kind=verb`, otherwise `null`.
  - `confidence`: `HIGH | MEDIUM | LOW`.
  - It is the persisted, closed-enum form of the end-of-verb Active Next-Action
    Proposal (ADR-0029). Free-text `next_action` stays for humans and is never
    parsed by the driver.
  - Stored as the flat scalars `next_step_kind`, `next_step_verb` and
    `next_step_confidence` (engineer schema 1.4; an absent key means null,
    validation is per key, and a write never changes a file's schema). The
    keys come after `parent_writeback_at`, where an older reader's
    forward-compat carrier writes keys it does not know, so its write leaves
    them byte for byte. `append` and `set-terminal` replace all three at
    once, the verb required exactly when the kind is `verb`; `append
    --clear-next-step true` clears them (never with the `--next-step-*`
    flags; `false` changes nothing), and Phase 0's resume does. Input is
    checked before the file lock is taken and the frontmatter again before
    it is written. *Amended 2026-09-30 (S1): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s1-engineer-schema-14).*
  - `state.mjs finish-verb` is each verb's last write, in both modes.
    Interactively it is the terminal `set-terminal summary-complete` plus the
    next step; under autopilot it writes the next action and next step only,
    turns the terminal marker off (an inherited one included), skips the
    handoff sidecar, and refuses while a peer ensemble is pending.
    `set-terminal` with the marker on is refused under autopilot. Each mode
    decision is made in code: Phase 0's `state.mjs autopilot-preflight`
    runs before any write, prints nothing interactively and the surface's
    rules under autopilot, and with an owner gate set refuses under
    autopilot, while interactively it prints the gate, its pointer, how it is
    resolved and the clear command; no runbook
    matches `AGENTIC_AUTOPILOT`. *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).* Interactively,
    too, `finish-verb` leaves the marker unset and records only the next step
    while the workflow's subtask is held, has a kept lane park, or a run of
    its macro is live, and the driver resumes the lane from that step
    (ADR-0068 Decision 2, item 6). *Amended 2026-10-19 (ADR-0068): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).*
  - Every persona operation of a macro's child stays visible, from its first
    write to its last (the write that records `next_step`, the close without
    a commit, or, for a commit, its archive and the parent writeback after
    it), through one new field of the child and a record beside the macro's
    holds, so a release can tell that no persona operation is still open in
    a held lane, those begun before the macro had a holds directory included
    (ADR-0068 Decision 2, items 7 and 9). *Amended 2026-10-19 (ADR-0068): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).*
- **`awaiting_owner` (engineer workflow and macro).**
  - Carries `gate` from the D4 enum.
  - Set by the surface that pauses; cleared by the resolving surface, which
    records `resolved_at` (Q2).
  - Stored as `awaiting_owner_gate`, `awaiting_owner_since`
    (`YYYY-MM-DDTHH:MM:SSZ`, a real instant) and `awaiting_owner_pointer`
    (`path#anchor`, both parts non-empty, only `[A-Za-z0-9._/-]`, no leading
    `/` and no `..`; anchors are labels, not HTML ids), all three or none.
    The keys come after `parent_writeback_at` on an engineer workflow and
    after `terminal_marker` on a macro, where an older reader's
    forward-compat carrier writes keys it does not know, so its write leaves
    them byte for byte.
    The engineer gates are `scope-routing`, `decide-conflict`,
    `peer-conflict`, `recurring-finding`, `staging-set`, `pr-handling` and
    `critique-cap`; the
    macro's are `plan-approval` and `plan-conflict`; `duplicate-workflow` is
    not stored. *Amended 2026-09-30 (S1): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s1-engineer-schema-14).* *Amended 2026-09-30 (S2): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s2-orchestrator-schema-12--plan-approval).* *Amended 2026-10-08 (`peer-conflict`): [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 8.* *Amended 2026-11-09 (`critique-cap`, C176): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-09--critique-convergence-c176).*
  - `awaiting-owner-set` defaults `--since` to now, replaces the pointer and
    since of the gate already set and refuses a different one (raising `plan-approval` to
    `plan-conflict` is the one change it allows). `awaiting-owner-clear` is
    refused when no gate is set, when the gate named is not the one set, and
    under an autopilot run. On the macro, clearing `plan-conflict` returns
    the gate to `plan-approval`, which is never cleared, only resolved by
    approving. On a workflow the clear takes the next step and the owner's
    resolution in words, so the clear and the step it implies are one write,
    and, since the keys are deleted, it appends `### Owner gate resolved:
    <gate> at <iso>` with the since and pointer it cleared. Every resolving
    block uses that one write, resolves the workflow itself rather than
    relying on an earlier Bash call, and stops when a write fails, so a next
    step never becomes runnable without the decision behind it. *Amended 2026-09-30 (S1): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s1-engineer-schema-14).* *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*
  - `decide-conflict`, `recurring-finding` and `scope-routing` are recorded
    in both modes, by `finish-verb --owner-gate <gate> --owner-gate-anchor
    <label>`, with the next step `owner-decision` in one write, at the
    proposal's own confidence; the workflow stays non-terminal (interactively
    too) until the owner resolves the gate; `staging-set`
    and `pr-handling` are autopilot set points, interactively answered in the
    dialog. Recording a gate turns an inherited terminal marker off in the
    same write, and the Stop hook archives no workflow with a gate pending,
    in the branch-agnostic sweep too, including for a workflow whose branch was
    deleted. The gates are resolved by decide's
    Owner selection step, refine's Owner decision step, interactive
    `/engineer:commit` for `staging-set`, and `awaiting-owner-clear` for the
    rest (D7's method, still open). Anchors are labels; `autopilot-mode.md`'s
    table is the source, and a shape test holds the anchors the runbooks and
    `phase7-commit.mjs` use to it. *Amended 2026-10-01 (S3+S4): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*
- **`plan_approval` (macro).**
  - `status` (`pending | approved`) and `plan_hash` over `subtasks[]`.
  - Approval is an explicit owner act. A plan change invalidates it by hash.
  - Stored as `plan_approval_status`, `plan_approval_approved_at` and
    `plan_approval_plan_hash` (orchestrator schema 1.2, after
    `terminal_marker`); `approved_at` and `plan_hash` are present exactly
    when the status is `approved`, and a macro gate is set exactly while the
    plan is pending (a pending plan carries one, and an approved plan none). `plan_hash` is sha256 over JSON with sorted keys and no
    whitespace of `plan.subtasks[]` in order, each projected to `id`,
    `label`, `branch`, `blocked_by`, `verb`, `profile` and `topic`, an absent
    or null field left out and the order of `blocked_by` counting; `state.mjs
    plan-hash` prints it, so no other plugin recomputes it.
  - Each transition is one write under the macro's lock: `plan-set`, from
    any state, gives `pending` with the gate `plan-conflict` when it is
    passed `--verdict conflict` and `plan-approval` otherwise, and revokes an
    approval on every write, a write that leaves the hash unchanged included;
    `plan-approve --expect-hash` gives `approved` with no gate, and is
    refused when that hash differs from the current one, while
    `plan-conflict` is set, on an empty plan, on a terminal macro, and under
    an autopilot run. Progress writes (`subtask-update`, the engineer
    terminal note, `bulk-subtask-status`) revoke nothing. Approving the
    same hash again writes nothing; a macro planned before 1.2, and a stale
    approval whose hash an older writer's plan change no longer matches, may
    be approved. `/orchestrator:approve` and its Codex mirror show every
    field the hash covers, the topic included, then approve with
    `--expect-hash` set to the hash shown. `next-ready`
    reports `approval: {status: approved|pending|absent, hash_ok:
    true|false|null}` on every output shape. `/orchestrator:plan` passes its
    verdict to `plan-set`; the state script computes the pointer from the
    macro's state home. The pointer anchors are labels, not HTML ids:
    `#macro-plan` names the frontmatter `plan` block, and
    `#ensemble-synthesis` the plan's Plan-verify synthesis (its `plan-verify`
    entry in `ensemble_results` and the `### Ensemble synthesis` phase note),
    which the owner finds by name. A macro
    that `/orchestrator:finalize` or `/orchestrator:abort` closes keeps its
    approval keys as they were. A plan hash is 64 hex characters, which the
    state scripts' secret scrubber (`[a-fA-F0-9]{32,}`) redacts: a reader
    that scrubs the frontmatter text before it reads the hash loses it. *Amended 2026-09-30 (S2): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s2-orchestrator-schema-12--plan-approval).*
- **entry-brief rows** for these fields. They are pointer-only and closed-enum,
  with commands synthesized only from the table (the ADR-0045 R0 principle).

Exact file/field/test changes are deferred to the plugin change specification.
It lives in the owner's handoff package, outside this repository, and its
content lands with the implementing pull requests.

### D7. Sensor and boundary-based rotation

- **Rotation is boundary-based.** Every step is a fresh session, so rotation never
  depends on measured risk.
- **Occupancy.** Per assistant message it is
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
  Percent is that divided by `result.modelUsage.<model>.contextWindow`. A
  `modelUsage` key may carry a window suffix the stream's model name lacks
  (`<model>[1m]`): the key as written decides first, then every key that is
  the model once a bracketed suffix is dropped from both, the largest window
  among them. *Amended 2026-10-13 (C136): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).*
- **Guards.**
  - A step's size is an observation, not a guard: the ledger records each
    step's `peak_ctx`, `peak_pct` and `context_window`, and no halt reads
    them. What a step's result shows (critique, a recurring finding, a
    postcondition, the tests) is what halts. The `step-oversized` halt and
    its `--oversize-pct` option are retired. *Amended 2026-10-13 (C136): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123).*
  - `compaction-imminent`: a PreCompact event aborts the step immediately.
    Compaction never happens inside autopilot (R1).
- **Scope.** The sensor is scoped to the driver's worker streams. It does not
  change ADR-0031 §7 for the runtime footer. Feeding a measured risk into
  runtime is out of scope.

### D8. Ledger and halt signal

A run's records live under `<repo>/.agentic-plugins/runs/autopilot/<run-id>/`
in the checkout it was launched in. The macro-scoped files live under the
main worktree's `.agentic-plugins/runs/autopilot/` instead: the lock, the
landing log, the lane removal intents and the open-run records
([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 5,
6 and 7), and the macro's holds directory,
`.agentic-plugins/runs/autopilot/holds/<macro-id>/`: the owner's hold
records, what the driver and the persona record beside them, and the lane
parks kept for the next run, under a lock of their own (ADR-0068 Decision
1, item 3; Decision 2, item 1). *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).* *Amended 2026-10-19 (ADR-0068, the holds directory): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).*
The run directory holds:
- `run.json`: config, pinned plugin versions, git baseline, start/end, final status.
- `steps.jsonl`: one line per step with:
  - seq, command, session_id, timings, exit, is_error;
  - cost, peak_ctx, peak_pct, permission_denials;
  - fingerprint_before / fingerprint_after, outcome.

  A step's `started` line is written before the worker is spawned and its
  `finished` line after; `status` pairs them and names a driver that died
  mid-step. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- `worker-<seq>.jsonl`: the raw stream, pointer-referenced only, with bounded
  retention (each capped at 64 MiB). *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- `halt.json`: reason code, pointers to the blocking file + field, resume hint.
- `lanes.jsonl`: with lanes, one line per lane event — created, adopted,
  removed, kept, reconciled ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
  Decision 6).
- `landing.jsonl`: one line per landing report the run published, each a
  subtask committed and not landed with its commit, its readiness (`sync`:
  ready, needs-sync or unknown), its overlap and the merge order. The macro's
  landing log under the main worktree holds the same records across runs
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 7 and
  its note of 2026-10-14). *Amended 2026-10-14 (C123): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--the-landing-report-in-the-ledger-c123).*

Other rules:
- **Status:** `agentic-autopilot status` reads these files, a run's landing
  records among them, one line each with its readiness; `status --json`
  prints them as `landing`, beside `run`, `steps`, `lanes` and `halt`. *Amended 2026-10-14 (C123): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--the-landing-report-in-the-ledger-c123).*
- **Lock.** One run per macro: `<main>/.agentic-plugins/runs/autopilot/locks/<macro-id>.lock`,
  with a pid + start-time fingerprint. A run also holds the worktree lock of
  every checkout it drives, `<checkout>/.agentic-plugins/runs/autopilot/worktree.lock`:
  its own, and with lanes each lane's, because two runs of different macros
  must not switch one checkout's branch. With lanes a run adds one entry per
  worker group in flight, so a driver that died with a lane worker alive
  still holds its locks. The interactive orchestrator commands join the
  macro lock as admission entries, live until released, and
  `/orchestrator:next` first joins the worktree lock of its checkout
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 4
  and 6). *Amended 2026-10-08 (ADR-0067): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067).*

  A lock is a directory. Each run that wants it adds an entry of its own,
  `h-<pid>-<random>.json`, written whole, recording the driver and, while a
  step runs, its worker. An entry is stale only when both are gone; a
  fingerprint that cannot be read counts as live, an exited but unreaped
  process counts as gone although `kill(pid, 0)` still finds it, and the
  start time is compared first: an exited process that started after the
  recorded one is a stranger that reused the pid, not the recorded process
  having exited. The fingerprints are the driver's own
  (`processFingerprint`: `/proc` on Linux, `ps` in the C locale on macOS;
  peer-runner's `fingerprintForPid` reads the start time in the caller's
  locale, which fits only the C locale). A run holds the lock when, after
  adding its entry, it finds no other live entry; otherwise it removes its
  own entry and retries after a random pause, and it is refused when
  another run already holds the lock, or on its last attempt. Only entries
  whose runs are gone are removed, and no participant reuses another's
  name, so no run removes a live participant's entry; "gone" holds only for
  the record it was judged on, so a gone entry is read once more after the
  check and removed only when unchanged. The run takes its locks after its first
  look at the state, looks again once it holds them, and decides its first
  step from that second look. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*

  Beside these, one heavy-work lock per repository, the mutation harness's
  `<git-common-dir>/mutation-harness.lock`, with one holder at a time: the
  harness, or the wrapper `agentic-autopilot heavy --`, which the driver uses
  for a verification check whose command does not take the lock itself. A
  holder's descendants join its ownership by an inherited proof (an older
  harness copy cannot, and waits), and it releases only after its process
  group has stopped; an older harness copy, as a reader, may start after a
  holder's end beside a process that outlived it. The driver waits for it
  while holding its run locks; no holder of it waits for a run lock, so the
  order cannot deadlock (ADR-0068 Decision 6). *Amended 2026-10-20 (ADR-0068, the heavy-work lock): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3).*
- **`stop`** signals only a pid it can prove is the run's process: alive,
  with a readable fingerprint that matches the lock's record. It signals the
  driver, which then empties its worker's group and records the halt, or,
  when the driver died, the worker's process group, which `stop` empties
  itself, reporting success only once the group is empty. *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- **Resume a halted step interactively:** `claude --resume <session_id>`.
- **Halt signal:** terminal output + `halt.json` + exit code 2. There is no plugin
  notification: the notification feature is removed ([ADR-0064](0064-runtime-surface-reduction.md), proposed alongside).
  The optional driver-local `--notify-local` shows one macOS notification through
  `osascript`, with a fixed script, the payload as argv, and no egress (Q5 resolved).

  With lanes, the run ends when nothing runs and nothing can start, every
  remaining lane parked, held (its handoff done or pending, or its record
  unreadable), waiting to land, or blocked behind one of those, or the plan
  done; exit 2 keeps its meaning, and `halt.json` gives each lane its state
  and resolution (ADR-0068 Decision 1, items 7 and 9). *Amended 2026-10-19 (ADR-0068, lanes that keep going): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1).*

  Beside these, the driver appends one JSON line per event (a park, a halt,
  a failed step, a finished commit, a stall verdict, the run's end) to the
  event file of its lock scope, `events/<macro-id>.jsonl` under the main
  worktree's `.agentic-plugins/runs/autopilot/` for a macro, and the main
  session watches it with the Monitor tool. The lines hold codes, ids and
  pointers, never free text; `--notify-local` is unchanged (ADR-0068
  Decision 4). *Amended 2026-10-19 (ADR-0068, the event file): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--stall-detection-and-the-drivers-event-file-adr-0068-slice-2).*
- **Consumer repos** must gitignore `.agentic-plugins/{runs,state,tmp,cache}/`.
  Otherwise session-capture writes trip the clean-tree gate (observed in E).

### D9. Codex non-parity

Autopilot is a Claude adapter. The following are all Claude host truth and are
not unified into a fake common API (`docs/ARCHITECTURE.md:223`, `:235-237`;
ADR-0001 honest scope):
- stream-json session hosting;
- `--permission-prompts none`;
- `--include-hook-events`;
- per-message usage;
- plugin loading under `-p`.

Codex remains manual. It still benefits from the host-neutral D6 fields
through entry-brief. A Codex driver would need its own host-truth probes and
its own ADR.

## Consequences

**Positive**:

- The owner stops acting as a relay. Judgment reaches the owner only through
  closed-enum halts, and each halt points at the exact blocking field.
- Contamination is structurally bounded. Every step starts at the fresh
  baseline (≈ 40K) and carries over only durable state. Compaction never runs.
- ADR-0031's residual "cannot guarantee a workflow is driven to completion" limit
  narrows to "the driver halts at owner gates".
- The first host-measured context sensor ships, scoped to worker streams.
- The D6 fields make pauses and next steps machine-readable for every consumer,
  including manual Codex use and the dashboard.

**Negative**:

- Unattended cost:
  - probe E, sonnet/medium: $0.10–0.64 and 16–284 s per step;
  - Opus/max: several times higher.
  - Budgets are mandatory, not optional.
- Pre-approved tools (`Bash`, `Edit`, `Write`) run without per-action owner
  review. Mitigations: the denylist, `--permission-prompts none`, a dedicated
  worktree, and the ledger.
- More contract surface. Three state fields, entry-brief rows and autopilot-mode
  branches in runbooks, all needing tests.
- The driver depends on Claude CLI stream-json semantics. A host change there
  breaks hosting, not state.
- The driver is foreground, so it needs a terminal or a live session for the
  duration of a run.
- Every committed subtask waits for the owner's landing (D3a). A chain macro
  needs one push–review–merge round per link. Only independent subtasks overlap
  with a wait.
- The model-judged set points (`recurring-finding`, `scope-routing`,
  `pr-handling`) are pinned by shape tests, not by code; the driver's halts
  are the backstop. *Amended 2026-10-01 (S3+S4, known limits): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit).*

**Neutral**:

- Runtime's tier model and §4 ceiling are unchanged. S1 lives in orchestrator.
- `/engineer:start` is unchanged and remains interactive-only.
- Interactive use is unchanged. Ceremony gates auto-pass only when
  `AGENTIC_AUTOPILOT` is set.

## Alternatives Considered

**Subagent conductor.** A main session spawns one subagent per step.
Rejected:
- The conductor's context still accumulates, which moves contamination to the
  decision-maker (R1).
- engineer and orchestrator register only `Stop`, not `SubagentStop`. Archive and
  writeback fire at the parent turn end, on whatever branch is checked out then,
  so several subtasks in one turn lose writeback and need a manual
  `/orchestrator:done`.
- The conductor's job is deterministic and belongs in code.

**Compaction + `SessionStart(compact)` re-injection.** This already ships
(the persona `compact` hooks). Rejected by R1: the summary derives from the
contaminated context.

**`Stop`-hook `decision: block` in-session continuation.** Keeps one session
alive by blocking stop. Rejected:
- the context never resets (R1);
- every turn end becomes a continuation point;
- an implicit loop with no progress proof.

**Agent SDK host.** Rejected for v1:
- It adds an npm dependency to a dependency-free plugin set.
- The CLI already exposes everything the driver needs: stream-json hosting,
  hook events, budgets, session ids.
- Plugin loading through the SDK was not verified.
- Revisit if stream-json hosting proves insufficient.

**`claude --bg` background sessions + `attach`.** These are daemon-hosted
interactive sessions. `claude agents --json` exposes only coarse `status`, with
no usage or hook stream for the driver. In-place answering is not required (R2).
Kept as a possible future "answer in place" enhancement.

**Cloud routines.** Rejected: remote sandbox, and no access to the local repo
state or the locally installed plugin set.

**Runtime-hosted executor.** Rejected:
- It collides head-on with ADR-0035 §4 ("hidden host startup") and ADR-0031 §6.
- Runtime is L1 infrastructure, not macro sequencing (ADR-0024 §2).
- Amending runtime's ceiling would set a broad precedent.

**Reusing the companion as the worker launcher.** Rejected:
- The depth stamp (`AGENTIC_COMPANION_DEPTH`, max 1,
  `plugins/companions/scripts/claude-companion.mjs:54-68`) makes in-worker peer
  ensembles refuse.
- `--no-session-persistence` (`:297-298`) leaves no resumable transcript.
- `--output-format text` carries no usage or hook events.
- The consensus executor caps at 600 s (`plugins/runtime/scripts/consensus.mjs:53`),
  while E steps took up to 284 s and verbs can exceed 600 s.
- The supervision *pattern* (handle ledger, pgid, fingerprinted cancel) is
  reused; the launcher is not.

**Count a local integration merge as landing** (D23 option B). The driver would
merge each committed subtask into a local `integration/<macro-id>` branch and
record completion there. The run would be unattended to the end, with one PR
at the finish. Rejected:
- It needs ADR-0062 amended. `landing.mjs` refuses a local-only integration ref
  because a local commit "proves nothing".
- Once the owner squash-merges the final PR, every recorded commit is off `main`
  again. That is the failure ADR-0062 measured: 150 of 236 recorded commits
  were not on `main`. Each subtask would then need a `--correct`.

**The driver pushes, opens and merges pull requests** (D23 option C). Fully
unattended. Rejected:
- Unreviewed code would reach `main`.
- It reverses the push/PR denials that the worker posture rests on (D5).

**A separate `autopilot` plugin** (ADR-0010 §6 trigger 2: distinct
cost profile). Deferred:
- The driver's logic is macro sequencing bound to orchestrator state.
- Opt-in is already explicit at invocation.
- A split remains open if the cost/permission profile warrants its own install
  unit.

## Open questions

- **Q1. Verb-chain commit surface.** *Resolved 2026-09-29 (owner decision D2):* a
  new `/engineer:commit` meta surface reusing `phase7-commit.mjs` plan/execute
  (D3). The alternative was extending the verb State finalize. Probe E8 had
  committed with plain git and got a non-conventional subject.
- **Q2. Who clears `awaiting_owner`** (owner decision D7, open). The resolving surface does, e.g. an explicit
  `/orchestrator:approve` for `plan-approval`, or the owner's decide selection for
  `decide-conflict`. That surface records `resolved_at` and clears the gate.
- **Q3. Where view assembly lives** (D8, open). Does entry-brief grow an `autopilot` surface
  that returns the whole view, or does the driver compose entry-brief + next-ready +
  workflow fields itself? *Resolved 2026-10-01 (owner decision D8 = a):* the
  driver composes the view, and entry-brief, which has no next-step rows
  yet, is a guard (D2). *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).*
- **Q4. Model and effort defaults per verb** (D5). For example, compose/critique on the
  owner default and mechanical steps on sonnet. *Resolved 2026-10-01 (owner
  decision D5):* the model plan is asked before each start (D5, Model plan).
  *Amended 2026-10-01 (S8): [history](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot).* *Proposed:*
  [ADR-0071](0071-autopilot-step-model-from-settings.md) answers it with
  per-step `autopilot_<step>_model`/`_effort` settings, read once when a run
  starts. *Amended 2026-11-12 (ADR-0071 proposed): [history](history/0063-autopilot-fresh-session-driver.md#observation-2026-11-12--per-step-model-settings-proposed-adr-0071).*
- **Q5. Halt notification kind.** *Resolved 2026-09-25:* no plugin notification; terminal + ledger + optional `--notify-local`. (Previously: reuse `response-needed`, or add an
  `autopilot-halt` kind to ADR-0047.) The driver's event file is part of the
  ledger, appended and read by local processes: no plugin notification, no
  egress, no ADR-0047 kind (ADR-0068 Decision 4, item 7). *Amended 2026-10-19 (ADR-0068, the event file): [history](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--stall-detection-and-the-drivers-event-file-adr-0068-slice-2).*
- **Q6** (raised by this ADR; **resolved**, D2 above). The command is dry-run
  by default, matching ADR-0035 §3 invariant 1:
  - A bare invocation or `preview` observes and decides, prints the posture, and
    spawns nothing.
  - `start --execute` launches. Explicit invocation plus the action-specific flag
    is the opt-in.
  - The prototype mirrors this with `--dry-run`.

## References

- ADR-0001 (honest scope)
- ADR-0010 §1, §5, §6
- ADR-0019 §1, §4
- ADR-0024 §2, §8
- ADR-0029 (Active Next-Action Proposal)
- ADR-0031 §6, §7, Amendment item 7
- ADR-0035 §2–§5
- ADR-0041 (bounded-domain amendment precedent)
- ADR-0044 §6
- ADR-0045 §5, §7
- ADR-0047 (notification kinds, retention)
- ADR-0059 (args-file transport; its cleanup trap is removed by the headless-runbook slice)
- ADR-0061 §Decision 3 (cross-plugin discovery reads the caller's install cache)
- ADR-0062 (completion recorded at landing; D3a)
- Probe record: [`docs/assurance/evidence/autopilot-probes-2026-09-24/`](../assurance/evidence/autopilot-probes-2026-09-24/) (host truth, Claude Code 2.1.281, 2026-09-24/25)
- The owner's handoff package, outside this repository:
  - `DESIGN.md` (the design source);
  - `design/plugin-changes.md` (the field/file/test specification);
  - `DECISIONS.md` (owner decisions D1–D23, W1–W9).
- The `path:line` citations of the text adopted on 2026-09-29 were verified at
  agentic-plugins `68438b9e` (the draft was written at `1346e36`).

## History

The records behind this decision, in [the history file](history/0063-autopilot-fresh-session-driver.md):

- 2026-09-29, amendment cascade: [Amendment cascade (applied on acceptance, 2026-09-29)](history/0063-autopilot-fresh-session-driver.md#amendment-cascade-applied-on-acceptance-2026-09-29)
- 2026-09-29, implementation note: [S0 (headless-safe runbooks)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-29--s0-headless-safe-runbooks)
- 2026-09-30, implementation note: [S1 (engineer schema 1.4)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s1-engineer-schema-14)
- 2026-09-30, implementation note: [S2 (orchestrator schema 1.2 + plan approval)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s2-orchestrator-schema-12--plan-approval)
- 2026-09-30, implementation note: [S6 (`/orchestrator:next` approval gate)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-09-30--s6-orchestratornext-approval-gate)
- 2026-10-01, implementation note: [S3+S4 (verb runbook deltas and `/engineer:commit`)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s3s4-verb-runbook-deltas-and-engineercommit)
- 2026-10-01, implementation note: [S8 (the driver and `/orchestrator:autopilot`)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-10-01--s8-the-driver-and-orchestratorautopilot)
- 2026-10-08, amendment: [worktree lanes (ADR-0067)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-08--worktree-lanes-adr-0067)
- 2026-10-13, amendment: [bounds and the report close (C105, C136, C127, C123)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-13--bounds-and-the-report-close-c105-c136-c127-c123)
- 2026-10-14, amendment: [document deliverables converge (C120)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--document-deliverables-converge-c120)
- 2026-10-14, amendment: [the ceremony gates (C120)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--the-ceremony-gates-c120)
- 2026-10-14, amendment: [the landing report in the ledger (C123)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--the-landing-report-in-the-ledger-c123)
- 2026-10-15, note: the owner's ruling on the recurring M3 finding, inside [document deliverables converge (C120)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-14--document-deliverables-converge-c120)
- 2026-10-19, amendment: [lanes that keep going (ADR-0068, slice 1)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--lanes-that-keep-going-adr-0068-slice-1)
- 2026-10-19, amendment: [stall detection and the driver's event file (ADR-0068, slice 2)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-19--stall-detection-and-the-drivers-event-file-adr-0068-slice-2)
- 2026-10-20, amendment: [driver-run verification and the heavy-work lock (ADR-0068, slice 3)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--driver-run-verification-and-the-heavy-work-lock-adr-0068-slice-3)
- 2026-10-20, amendment: [main-session instructions and rebinding (ADR-0068, slice 4)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-10-20--main-session-instructions-and-rebinding-adr-0068-slice-4)
- 2026-11-04, implementation note: [a verb step's evidence (C163)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-04--a-verb-steps-evidence-c163)
- 2026-11-07, implementation note: [the review gate (C163 A1b)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-07--the-review-gate-c163-a1b)
- 2026-11-07, implementation note: [review binding under autopilot (C163 A2b, ADR-0069)](history/0063-autopilot-fresh-session-driver.md#implementation-note-2026-11-07--review-binding-under-autopilot-c163-a2b-adr-0069)
- 2026-11-09, amendment: [critique convergence (C176)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-09--critique-convergence-c176)
- 2026-11-10, amendment: [the commit gate (C178)](history/0063-autopilot-fresh-session-driver.md#amendment-2026-11-10--the-commit-gate-c178)
- 2026-11-12, observation: [per-step model settings proposed (ADR-0071)](history/0063-autopilot-fresh-session-driver.md#observation-2026-11-12--per-step-model-settings-proposed-adr-0071)
- 2026-11-14, superseded text: [the Status section before the ADR-0070 migration](history/0063-autopilot-fresh-session-driver.md#superseded-text-2026-11-14--the-status-section-before-the-adr-0070-migration)
