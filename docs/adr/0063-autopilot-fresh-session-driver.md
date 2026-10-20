# ADR-0063: Autopilot — owner-launched fresh-session driver (Claude-only)

## Status

Accepted (2026-09-29, owner decision).
- Drafted 2026-09-24/25 in the owner's handoff package, outside this repository.
- Adopted here as Proposed on 2026-09-29 (#835) with its probe record,
  [`docs/assurance/evidence/autopilot-probes-2026-09-24/`](../assurance/evidence/autopilot-probes-2026-09-24/).
- Realigned before adoption to ADR-0059–0062 (§Context, "Since the probes").
- Owner decisions taken for this ADR on 2026-09-29:
  - D1: ADR-0035 is cross-referenced, not amended;
  - D2: a new `/engineer:commit`;
  - D4: v1 covers macros and verb-chains only;
  - D23: the owner lands, and the driver records the landing.
- Accepted the same day. The accepting commit applied the §Amendment cascade,
  with one citation corrected:
  - The draft named the entry-brief state→command table "ADR-0045 §16".
  - ADR-0045 has no §16. The table is its §5, and §16 is the section of
    `plugins/runtime/docs/session-capture-contract.md` that carries it.
  - Cascade item 6 therefore amends ADR-0045 §5, and §Context and §References
    cite §5.
- Amended by [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
  (2026-10-08): R2's halt wording; D1's worktree-lanes clause; D3's
  `/orchestrator:next` row and D4's proceed rules 1, 2, 4 and 5, per lane;
  D4's gate enum, its `version-drift` and `budget` halt rows and its Lanes
  paragraph; D5's Spawn paragraph and Env; D8's ledger location, run
  directory list and Lock bullet.
- Amended 2026-10-13 by the owner's review decisions C105 and C136 (recorded
  outside this repository): D1's Bounded property, D4's proceed rule 6 and
  its `budget` row lose the run's wall clock; D7's guards and D4's
  `step-oversized` row retire the size halt, a step's size being an
  observation. Each place keeps its text and carries a dated note.
- Amended 2026-10-14 by the owner's review decision C120 (recorded outside
  this repository): a document deliverable is critiqued in full once, then
  re-checked only where a refine changed it, and its recurring findings come
  from a review ledger. D4's ceremony gates carry a dated note; the contract
  is § Amendment 2026-10-14 — document deliverables converge (C120).
- Amended 2026-10-19 by
  [ADR-0068](0068-autopilot-lanes-that-keep-going.md) (accepted 2026-10-20): with
  lanes, a lane halt parks only its lane, and the owner can hold a lane and
  release it. R2, D4's halt table and Lanes paragraph, D6's `next_step`,
  D8's macro-scoped files and halt signal, and the S3+S4 note on
  `finish-verb` carry dated notes.
- Amended 2026-10-19 by ADR-0068's slice 2 (accepted 2026-10-20): stall
  detection, log-only until the owner switches it on, and the driver's event
  file that the main session watches. D1's Bounded property, D4's proceed
  rule 6, D5's session hosting, D8's halt signal and Q5 carry dated notes.
- Amended 2026-10-20 by ADR-0068's slice 3 (accepted 2026-10-20): a
  verification step the driver runs with no LLM, and one heavy-work lock.
  D1's effect domain, D3's step model, D4's `no-progress` trigger, D5's
  worker contract and D8's Lock bullet carry dated notes.
- Amended 2026-10-20 by ADR-0068's slice 4 (accepted 2026-10-20): the main
  session's instructions to a lane, applied at its next step boundary, and
  the rebinding of a dispatched subtask by an approved change of its
  instructions. The S6 note and the S8 note's forced-step rules carry dated
  notes.

<!--
Adds one named effect domain — S1, owner-launched fresh-session spawn —
executed by the orchestrator Claude adapter, NOT by runtime. Cross-references
(does not relax) ADR-0035 §2/§4 and ADR-0031 §6; notes ADR-0019 §1 and
ADR-0062. On acceptance apply the §Amendment cascade blocks verbatim. The
handoff package's DESIGN.md is the design source this ADR copies its names,
enums and reason codes from; it wins on any drift until this ADR is Accepted.
Citations are `path:line` at agentic-plugins 68438b9e (re-verified 2026-09-29;
the draft was written at 1346e36).
-->

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
| R2 | At a genuine judgment point the run **halts**, and reports it: terminal + `halt.json` + exit code 2. Nothing starts after the halt. With parallel lanes ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6) the halt **drains**: no new lane or step starts, steps already running finish and are recorded, then every lane reports once. A subtask that waits for its PR to land is not a judgment point (D3a). |
| R3 | **Claude-only.** Codex parity is not required (Claude adapter, documented non-parity). |
| R4 | `decide` results are auto-accepted **unless** the ensemble verdict is CONFLICT or confidence is below HIGH. |
| R5 | **Deterministic control.** The driver never synthesizes a command from free text. Commands come only from closed enums in state (same principle as entry-brief R0). |

*Note 2026-10-19 on R2 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
accepted 2026-10-20):* with lanes, a judgment point in a
lane parks that lane only, and the other lanes go on; the run-wide halts
still drain, and the run reports once nothing can start (ADR-0068 Decision
1).

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
    (`plugins/orchestrator/scripts/landing.mjs:82-87`).
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
| ADR-0010 §5 | cross-plugin contact via artifacts, no imports | The driver reads state through CLIs and files and invokes commands through `claude`; it imports nothing. Precedent: orchestrator already runs engineer's `state.mjs find-active` (`plugins/orchestrator/core/skills/next/SKILL.md:107`). |
| ADR-0019 §1 | dispatch must go through the engineer command, with exports + Phase 0 in one shell (`next/SKILL.md:134`, `:224`) | Preserved: each worker runs `/orchestrator:next` in full, in one process. |
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
- **Bounded.** Max iterations, a total cost cap, a per-step `--max-budget-usd`,
  and a per-step wall clock. On timeout or abort the driver may kill **only the
  worker process group it spawned** (the ADR-0035 §4 child-only rule).
  *Amendment 2026-10-13 (C105):* these, with a halt and `stop`, are the
  bounds. No run wall clock bounds a run: a step that starts late gets its
  whole per-step wall clock. The `--max-time` option that set one is
  removed, and an args file that still passes it is refused as an unknown
  option.

  *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 2,
  accepted 2026-10-20):* a stall
  detector judges every step from its stream and its descendants' CPU. It
  records only, and the per-step wall clock stays the step's bound, until
  the owner switches it on after reviewing its verdicts; then a step stalled
  10 minutes is aborted, and the wall clock's default becomes an 8-hour
  emergency cap (ADR-0068 Decision 3).
- **No implicit retry loop.** A step never re-runs automatically. The loop
  advances only on an **observed state change** (fingerprint differs).
  `no-progress` halts.
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
  ref.

  *Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 3,
  accepted 2026-10-20):* S1 also covers the driver's
  verification checks: each a kind the repository declares, read from the
  run's baseline, run as an argv array with checked arguments in the lane's
  checkout (serial: the driven checkout), in its own process group, which
  only the driver kills, with a worker's environment minus the run's
  admission token and autopilot flag, under the heavy-work lock (ADR-0068
  Decisions 5 and 6).

Runtime is **not** granted S1. Runtime's §4 ceiling, including "hidden host
startup", is unchanged.

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
  the installed file only bootstraps, and runtime never executes it.
- **Oracle:** `runtime:context entry-brief` stays runtime-owned and **R0**. It
  gains rows for the D6 fields (plugin change spec). The driver consumes it
  through `--surface cli`, which always computes.
- **Host-neutral vs adapter.** The D6 state additions are host-neutral core
  contract. Only the driver is adapter.

### D3. Step model

One **step** = one command executed in one fresh `claude` process.

| step command | when | notes |
|---|---|---|
| `/orchestrator:next` | macro approved, a subtask is ready, no active engineer child (with lanes, [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6: none on that subtask, which gets its own lane) | dispatch + the subtask's first verb in the same process (ADR-0019 §1 requires the exports + Phase 0 + Phase 4 in one process) |
| `/engineer:<verb>` | active engineer child with `next_step.kind=verb`, `confidence=HIGH` | reattaches (append-on-resume) |
| `/engineer:commit` | `next_step.kind ∈ {commit, done}`, `confidence=HIGH` | New verb-chain commit surface (Q1, D2; plugin change spec §1.8). `done` routes here too: with nothing staged it archives the workflow instead of committing (the no-changes close). It lands together with "autopilot verbs skip `set-terminal`". |
| `/orchestrator:done <id>` | a committed subtask whose PR has merged (`state.mjs resolve-landing` ok), or `--no-commit` after a no-changes close | records completion (ADR-0062); successors unblock (D3a) |
| `/orchestrator:finalize` | every subtask `completed` (none deferred/abandoned) | terminal close |

The verb is the atomic durable unit. `/engineer:start` keeps direction
approval, the exploration map and the plan only in conversation, so it is
**out of scope**: autopilot runs macros whose subtasks are verb-chains. The
driver is stateless across runs. It re-derives everything from durable state
each iteration, so re-launching after a halt continues.

*Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 3,
accepted 2026-10-20):* one more step, which runs no
`claude` process: when the child's next step is `verify` and the run offers
verification, the driver runs the requested checks with no LLM, records each
result in the workflow, and then dispatches the request's `on_pass` when
every check passed on the lane's current tree, leaves the request for later
when a stop, a hold, a drain or the driver's end cut the batch short, or
resumes the requesting verb otherwise. It costs nothing and is bounded by
the checks' timeouts, the batch's running time and its wait for the
heavy-work lock (ADR-0068 Decision 5).

### D3a. Landing (ADR-0062; owner decision D23, 2026-09-29)

The owner lands the work, and the driver records the landing and waits for it.
ADR-0062 is unchanged.
- **Landing check.**
  - For every `in_progress` subtask whose engineer workflow is archived with its
    terminal marker set, the observer runs `git fetch origin <integration branch>`
    and then orchestrator `state.mjs resolve-landing`.
    - That CLI is read-only (`plugins/orchestrator/scripts/state.mjs:4209-4237`).
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
    the owner.
- **Any other refusal** → halt `owner-choice` with the reason.
- **Resume.** The owner pushes, reviews and merges, then relaunches. The driver
  is stateless, so it records the landings and continues.

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
   current `subtasks[]`.
4. For `/orchestrator:next` only: the working tree it runs in is clean (with
   lanes, the lane's).
5. The state fingerprint changed since the previous step: with lanes, a
   lane's fingerprint since that lane's previous step, while `/orchestrator:done`
   and `/orchestrator:finalize` keep the macro-wide one. The first iteration
   is exempt, and with lanes each lane's first step.
6. Budgets remain: iterations, total cost, wall clock. *Amendment 2026-10-13
   (C105):* the run's wall clock is removed. Iterations and total cost
   remain, and each step's own wall clock (D1) still bounds that step.
   *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 2,
   accepted 2026-10-20):* once the
   owner switches the stall detector on, a step is bounded by the stall rule
   and by the emergency cap (ADR-0068 Decision 3, item 8).

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
| `no-progress` | fingerprint unchanged after a step that exited 0 |
| `worker-failed` | non-zero exit, `is_error`, or timeout |
| `permission-denied` | the worker hit a denied tool it needed (from `permission_denials`) and made no progress |
| `compaction-imminent` | a PreCompact hook event appears in the worker stream (the step is aborted) |
| `step-oversized` | the step's peak context exceeds the oversize threshold (D7). *Retired 2026-10-13 (C136):* never raised; a step's peak context is recorded, an observation (D7) |
| `budget` | iteration, cost or time cap reached, or a rate-limit window that cannot reopen before the deadline ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6). *Amendment 2026-10-13 (C105):* there is no time cap and no deadline: the iteration or cost cap, or a rate-limit window that throttles new lanes with no reset time while nothing runs to refresh it |
| `version-drift` | installed plugin versions changed since the run started, or the content of a loaded plugin or a pinned script root did ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 8) |
| `interrupted` | SIGINT/SIGTERM from the owner |

*Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
accepted 2026-10-20):* the codes are unchanged, and with
lanes each halt has a scope, set by its cause, not by its code or by
whether it names a subtask. The run-wide causes are a closed list:
`version-drift`, `budget`, `plan-unapproved`, a gate on the macro, a halt
that names no lane of the plan (the other macro-level halts, the aggregate
halts), the run's footing wherever it is met (the baseline fetch, the
rollback fence), a finalize's halts, a done's once its worker started (a
done that could not spawn parks its lane), the checks on the driver's own
checkout, a worker group that outlived SIGKILL (in any lane, although its
code is the lane's `worker-failed`) and an unreadable holds directory; they
drain the run. `interrupted` aborts it. Every other halt is a lane halt and
parks only that lane (ADR-0068 Decision 1, item 1). Serial runs keep the
drain.

*Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 3,
accepted 2026-10-20):* `no-progress` gains one trigger: a
verb that asks for the same checks again on an unchanged tree after a
verification batch in which they all passed or one failed (after a timeout
with no failure they run again). A batch is judged by its results, never
by `no-progress`, and its recorded results count as a change of the child
for the step it dispatches (ADR-0068 Decision 5, items 7 and 10).

**`awaiting_owner.gate`** is a closed enum of genuine-judgment gates only:
`plan-approval`, `plan-conflict`, `scope-routing`, `decide-conflict`,
`peer-conflict` ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
Decision 8: a conflict verdict in critique or investigate),
`recurring-finding`, `staging-set`, `pr-handling`, `duplicate-workflow`. The
source of each gate is mapped in DESIGN §6.3.

**Ceremony gates** auto-pass while `AGENTIC_AUTOPILOT` is set:
- **Commit subject confirmation:** a conventional subject is inferred from verb, profile and package.
- **"Recommended: X. Proceed?":** proceed with X.
- **Presentation-mode prompt:** batch.
- **critique → refine MINOR selection:** the existing default rule, CRITICAL + MAJOR.
- **End-of-verb Active Next-Action Proposal:** persisted as `next_step`; the driver decides from it.

The same gates stay interactive when a human drives.

*Amendment 2026-10-14 (C120):* for a document deliverable, "CRITICAL + MAJOR"
is the open CRITICAL and MAJOR findings of the workflow's review ledger, a
scoped re-critique leaves a new non-CRITICAL finding outside the passages a
refine changed open for the owner instead of carrying it, and the
`recurring-finding` gate fires on the ledger's recurring findings only. Code
deliverables keep the rule above. § Amendment 2026-10-14 — document
deliverables converge (C120).

**`decide` (R4):**
- ensemble verdict CONFLICT → `awaiting_owner.gate=decide-conflict` → halt;
- `next_step.confidence < HIGH` → halt (`low-confidence`);
- otherwise proceed with the recommended direction.

**Lanes (W2).** Any lane halt drains the run: no new lane or step starts,
in-flight steps finish, then every lane reports once. SIGINT/SIGTERM aborts
without draining. Scheduling, the per-lane fingerprint, budgets and the
throttle: [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
Decision 6.

*Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
accepted 2026-10-20):* only a run-wide halt drains. A
lane halt parks its lane while the other lanes go on, the park is kept for
the next run, and the lane is judged again once its record changes or the
owner releases it; a lane the owner holds is left alone (ADR-0068 Decisions
1 and 2).

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
       --append-system-prompt <plugin-root hint + autopilot rules>
       --max-budget-usd <per-step cap>
       [--model <m>] [--effort <e>]
```

**Env.**
- `AGENTIC_AUTOPILOT=<run-id>`, the mode flag read by runbooks and hooks.
- Plugin roots resolved once by the driver, to the installed version (the
  ADR-0061 rule: the caller's own install cache, not the highest cached SemVer):
  - `AGENTIC_ORCHESTRATOR_ROOT` (already honored by
    `plugins/engineer/scripts/parent-writeback.mjs:60`);
  - `AGENTIC_ENGINEER_ROOT`;
  - `AGENTIC_RUNTIME_ROOT`.
- `AGENTIC_STATE_BASE=<the run's effective state root>` and
  `AGENTIC_AUTOPILOT_TOKEN=<the run's admission secret>`
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 2
  and 4). An inherited value of either is scrubbed first.
- Scrubbed:
  - the launching session's identity (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
    `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_*`,
    `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
    `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`);
  - `AGENTIC_NOTIFY_EGRESS_CHANNEL`, so there are no per-step E1 sends.
- Never set: `AGENTIC_COMPANION_DEPTH`. Workers are not companions, and an
  inherited depth would make in-worker peer ensembles refuse.

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
   pattern, `plugins/engineer/scripts/peer-runner.mjs:711-725`).

   *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 2,
   accepted 2026-10-20):* the host also
   keeps the time of the last stream event other than heartbeats and hooks,
   and the driver samples the worker's descendants' CPU. Log-only, the
   verdicts are recorded and nothing is aborted; switched on, a `stalled`
   verdict is one more abort, `stalled`, with the timeout's teardown,
   outranking a close on a finished report as every abort does. The detector
   stops watching at that close (ADR-0068 Decision 3).
5. The worker's own `Stop` hooks archive the engineer workflow and send its
   terminal note to the macro (probe E8). Since ADR-0062 that note no longer
   completes the subtask (D3a).

*Amendment 2026-10-13 (C127, C123):* a worker that has finished its runbook
can leave a background task pending (a test run, a monitor), and item 3 then
held the step open to its wall clock: of the 11 step timeouts the owner
measured over the 264 steps run before this change, 8 ended that way. The step report gains a required boolean,
`waiting_on_background`: `true` in a report the worker files while it still
waits on a background task's notification (the provisional report, which also
says `failed`), `false` in its last. The worker's appended rule 6 says both.
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
  point.

**Plugin-root hint.** Until runbooks prefer `AGENTIC_<PLUGIN>_ROOT` over their
cache fallback, the driver appends a short hint naming the resolved roots
(proven in E7/E8).

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
- A needed-but-denied action surfaces as `permission-denied` or
  `awaiting-owner:pr-handling`.
- A dedicated worktree (the `runtime:worktree` planner) is recommended.

*Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 3,
accepted 2026-10-20):* in a run that offers verification
(recorded in `run.json` and told to each worker), a worker makes its edits
and the quick checks it judges to take minutes, runs no mutation run and not
the whole test suite in its step, never waits there for the heavy-work lock,
and ends with the next step `verify`, a request naming declared checks with
data arguments and the step that follows. The posture does not bind the
processes a check starts, as it does not bind those a worker's script starts
(ADR-0068 Decision 5, items 1, 2 and 8).

### D6. State contract additions (host-neutral core)

- **`next_step` (engineer workflow).** Written at verb State finalize.

  *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
  accepted 2026-10-20):* every persona operation of a
  macro's child also stays visible, from its first write to its last (the
  write that records `next_step`, the close without a commit, or, for a
  commit, its archive and the parent writeback after it), through one new
  field of the child and a record beside the macro's holds. A release can so
  tell that no persona operation is still open in a held lane, those begun
  before the macro had a holds directory included (ADR-0068 Decision 2,
  items 7 and 9).

  - `kind`: `verb | commit | owner-decision | done`.
    - `done` means the subtask needs no further step. `/engineer:commit`
      closes it without a commit, and `/orchestrator:done --no-commit` records
      completion (D3a).
    - A missing `next_step` is unknown, and the driver halts `owner-choice`.
  - `verb`: one of the six canonical verbs when `kind=verb`, otherwise `null`.
  - `confidence`: `HIGH | MEDIUM | LOW`.
  - It is the persisted, closed-enum form of the end-of-verb Active Next-Action
    Proposal (ADR-0029). Free-text `next_action` stays for humans and is never
    parsed by the driver.
- **`awaiting_owner` (engineer workflow and macro).**
  - Carries `gate` from the D4 enum.
  - Set by the surface that pauses; cleared by the resolving surface, which
    records `resolved_at` (Q2).
- **`plan_approval` (macro).**
  - `status` (`pending | approved`) and `plan_hash` over `subtasks[]`.
  - Approval is an explicit owner act. A plan change invalidates it by hash.
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
  Percent is that divided by `result.modelUsage.<model>.contextWindow`.
  *Amendment 2026-10-13 (C136):* a `modelUsage` key may carry a window
  suffix the stream's model name lacks (`<model>[1m]`). The key as written
  decides first, then every key that is the model once a bracketed suffix is
  dropped from both, the largest window among them.
- **Guards.**
  - `step-oversized`: halt after the step if the peak exceeds 25% of the window
    (configurable). The step or verb should be split.
    *Amendment 2026-10-13 (C136):* retired, with its `--oversize-pct`
    option. A step's size is an observation: the ledger records each step's
    `peak_ctx`, `peak_pct` and `context_window`, and no halt reads them. Over
    the 116 verb steps the owner measured, every size band ended normally 86%
    of the time or more, and each abnormal end was a worker failure of
    another cause. What a step's result shows (critique, a recurring finding,
    a postcondition, the tests) is what halts.
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
6 and 7). The run directory holds:
- `run.json`: config, pinned plugin versions, git baseline, start/end, final status.
- `steps.jsonl`: one line per step with:
  - seq, command, session_id, timings, exit, is_error;
  - cost, peak_ctx, peak_pct, permission_denials;
  - fingerprint_before / fingerprint_after, outcome.
- `worker-<seq>.jsonl`: the raw stream, pointer-referenced only, with bounded
  retention.
- `halt.json`: reason code, pointers to the blocking file + field, resume hint.
- `lanes.jsonl`: with lanes, one line per lane event — created, adopted,
  removed, kept, reconciled ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
  Decision 6).
- `landing.jsonl` (listed 2026-10-14, docket C123): one line per landing
  report the run published, each a subtask committed and not landed with its
  commit, its readiness (`sync`: ready, needs-sync or unknown), its overlap and
  the merge order. The macro's landing log under the main worktree holds the
  same records across runs ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
  Decision 7 and its note of that date).

*Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
accepted 2026-10-20):* the macro-scoped files under the
main worktree gain the macro's holds directory,
`.agentic-plugins/runs/autopilot/holds/<macro-id>/`: the owner's hold
records, what the driver and the persona record beside them, and the lane
parks kept for the next run, under a lock of their own (ADR-0068 Decision
1, item 3; Decision 2, item 1).

Other rules:
- **Status** (listed 2026-10-14, docket C123): `agentic-autopilot status`
  reads these files, a run's landing records among them, one line each with
  its readiness; `status --json` prints them as `landing`, beside `run`,
  `steps`, `lanes` and `halt`.
- **Lock.** One run per macro: `<main>/.agentic-plugins/runs/autopilot/locks/<macro-id>.lock`,
  with a pid + start-time fingerprint. A run also holds the worktree lock of
  every checkout it drives, `<checkout>/.agentic-plugins/runs/autopilot/worktree.lock`:
  its own, and with lanes each lane's. With lanes a run adds one entry per
  worker group in flight, so a driver that died with a lane worker alive
  still holds its locks. The interactive orchestrator commands join the
  macro lock as admission entries, live until released, and
  `/orchestrator:next` first joins the worktree lock of its checkout
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 4
  and 6).

  *Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 3,
  accepted 2026-10-20):* beside these, one heavy-work lock
  per repository, the mutation harness's
  `<git-common-dir>/mutation-harness.lock`, with one holder at a time: the
  harness, or the wrapper `agentic-autopilot heavy --`, which the driver uses
  for a verification check whose command does not take the lock itself. A
  holder's descendants join its ownership by an inherited proof (an older
  harness copy cannot, and waits), and it releases only after its process
  group has stopped; an older harness copy, as a reader, may start after a
  holder's end beside a process that outlived it. The driver waits for it
  while holding its run locks; no holder of it waits for a run lock, so the
  order cannot deadlock (ADR-0068 Decision 6).
- **Resume a halted step interactively:** `claude --resume <session_id>`.
- **Halt signal:** terminal output + `halt.json` + exit code 2. There is no plugin
  notification: the notification feature is removed ([ADR-0064](0064-runtime-surface-reduction.md), proposed alongside).
  The optional driver-local `--notify-local` shows one macOS notification through
  `osascript`, with a fixed script, the payload as argv, and no egress (Q5 resolved).

  *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
  accepted 2026-10-20):* with lanes, the run ends when
  nothing runs and nothing can start, every remaining lane parked, held
  (its handoff done or pending, or its record unreadable), waiting to land,
  or blocked behind one of those, or the plan done; exit 2 keeps its
  meaning, and `halt.json` gives each lane its state and resolution
  (ADR-0068 Decision 1, items 7 and 9).

  *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 2,
  accepted 2026-10-20):* beside
  these, the driver appends one JSON line per event (a park, a halt, a
  failed step, a finished commit, a stall verdict, the run's end) to the
  event file of its lock scope, `events/<macro-id>.jsonl` under the main
  worktree's `.agentic-plugins/runs/autopilot/` for a macro, and the main
  session watches it with the Monitor tool. The lines hold codes, ids and
  pointers, never free text; `--notify-local` is unchanged (ADR-0068
  Decision 4).
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
- The consensus executor caps at 600 s (`plugins/runtime/scripts/consensus.mjs:49-50`),
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

## Amendment cascade (applied on acceptance, 2026-09-29)

The accepting commit applied these blocks as written, except in three places:
- item 1's date is filled in;
- item 6 cites ADR-0045 §5, not §16 (§Status);
- item 8's status column reads Accepted.

**1. ADR-0035 — Status block, after the ADR-0044 paragraph:**

```markdown
**§2 / §4 cross-referenced by [ADR-0063](0063-autopilot-fresh-session-driver.md)
(YYYY-MM-DD, domain S1).** ADR-0063 adds exactly one named effect domain —
**S1 (owner-launched fresh-session spawn)** — executed by the orchestrator
Claude adapter, **not by runtime**. Runtime's tiers and §4 ceiling are
unchanged: runtime still MUST NOT start, resume, fork, compact or switch host
sessions, and `runtime:context entry-brief` stays R0. See ADR-0063 D1 and the
§4 note below.
```

**2. ADR-0035 §4 — after the tier-E1 amendment blockquote:**

```markdown
> **Cross-reference — domain S1 (owner-launched fresh-session spawn),
> [ADR-0063](0063-autopilot-fresh-session-driver.md):** the "hidden host
> startup" line above continues to bind runtime without exception. ADR-0063
> authorizes, **outside runtime**, exactly one shape of host startup: the
> orchestrator Claude adapter's foreground driver, started by an explicit owner
> invocation, spawning **new** `claude -p` processes (never resuming, forking or
> compacting an existing session) under an owner-declared, never-escalated
> permission posture, with §3 invariants 2–10 adopted by reference, a finite
> per-step timeout, and child-only process-group termination. This is a bounded
> cross-reference, not a precedent for runtime-hosted session control.
```

**3. ADR-0031 §6 — appended note:**

```markdown
> **Note ([ADR-0063](0063-autopilot-fresh-session-driver.md)):** §6 continues to
> bind runtime. The `fresh_or_resumed` recommendation may now be *acted on* by
> the owner-launched autopilot driver outside runtime, which rotates at every
> step boundary and never compacts. §7 is unchanged for the footer: the driver's
> context sensor is scoped to its own worker streams. The Amendment item 7
> residual ("cannot guarantee a workflow is driven to completion") narrows, for
> autopilot runs, to "the driver halts at owner gates".
```

**4. ADR-0019 §1 — appended note:**

```markdown
> **Note ([ADR-0063](0063-autopilot-fresh-session-driver.md)):** the same-host
> runbook path is unchanged. The autopilot driver invokes `/orchestrator:next`
> and `/engineer:<verb>` inside fresh `claude -p` worker processes; each worker
> runs this same-host path in full (exports, engineer Phase 0, Phase 4 writeback
> in one process). `--peer` (PR-F) stays deferred and is not used for workers.
```

**5. ADR-0029 §3 — appended note (closed-enum sibling of `next_action`):**

```markdown
> **Amendment ([ADR-0063](0063-autopilot-fresh-session-driver.md)):** the compact
> durable next-action (selected_next + one-line rationale + next_command) keeps
> its free-text form for humans. Forward-decision verb completions additionally
> persist its closed-enum projection as flat scalars `next_step_kind`
> (`verb | commit | owner-decision | done`), `next_step_verb` (present iff
> kind=verb) and `next_step_confidence` (`HIGH | MEDIUM | LOW`). Confidence
> otherwise has no durable home. Machine consumers read only the closed-enum keys
> and never parse `next_action`.
```

**6. ADR-0045 §5 — amendment (entry-brief 1.1 rows):**

```markdown
> **Amendment ([ADR-0063](0063-autopilot-fresh-session-driver.md)):** the §5 state
> table (packaged as `session-capture-contract.md` §16) gains rows for engineer
> `next_step_*`, `awaiting_owner_*` (engineer and macro), and an unapproved macro
> plan (`plan_approval_status=pending`). Commands stay synthesized only from
> the table, never from stored text; a set `awaiting_owner_gate` or a pending
> approval yields `owner-choice-required`.
> Schema `runtime-entry-brief-1.1` adds closed enums only. R0 is unchanged: no
> writes, no consumption. Row design: ADR-0063's plugin change specification §3.
```

**7. ADR-0062 — appended note (autopilot and landing):**

This item replaces the draft's amendment of ADR-0019 §4. ADR-0062 superseded
that part of §4 before this ADR was adopted.

```markdown
> **Note ([ADR-0063](0063-autopilot-fresh-session-driver.md)):** completion is
> unchanged — `/orchestrator:done` records it after the pull request merges. In
> autopilot mode verbs do not set the terminal marker; only the verb-chain
> commit surface (`/engineer:commit`) does, and a subtask with nothing to commit
> is archived and then completed with `/orchestrator:done --no-commit`. The
> autopilot driver never pushes, opens or merges a pull request: it waits for
> the owner's landing, records it by running `/orchestrator:done` once
> `state.mjs resolve-landing` reports the merge, and halts `awaiting-landing`
> when nothing else can be dispatched (ADR-0063 D3a).
```

**8. `docs/adr/README.md` — index row:**

```markdown
| [0063](0063-autopilot-fresh-session-driver.md) | Autopilot — owner-launched fresh-session driver (Claude-only): adds one named effect domain **S1 (owner-launched fresh-session spawn)** executed by the orchestrator Claude adapter, **not runtime** (ADR-0035 §2/§4 cross-referenced, runtime ceiling unchanged); one command per fresh `claude -p` worker hosted over stream-json (background tasks survive, model re-invoked on completion); deterministic gate policy over closed-enum state (`next_step`, `awaiting_owner`, `plan_approval`) with halt-on-judgment and a closed halt reason set; boundary-based rotation with a context sensor as guard (oversize halt, PreCompact abort); `manual` + allow/deny posture, never escalated; ADR-0062 unchanged — the owner lands each pull request and the driver records the landing through `/orchestrator:done`, halting `awaiting-landing` when nothing else can run; ledger + terminal halt signal, no plugin notification; Codex non-parity documented | Proposed |
```

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
  workflow fields itself? Leaning towards the driver composing, with entry-brief
  gaining only the rows.
- **Q4. Model and effort defaults per verb** (D5, open). For example, compose/critique on the
  owner default and mechanical steps on sonnet.
- **Q5. Halt notification kind.** *Resolved 2026-09-25:* no plugin notification; terminal + ledger + optional `--notify-local`. (Previously: reuse `response-needed`, or add an
  `autopilot-halt` kind to ADR-0047.)
  *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md), slice 2,
  accepted 2026-10-20):* the
  resolution stands. The driver's event file is part of the ledger, appended
  and read by local processes: no plugin notification, no egress, no
  ADR-0047 kind (ADR-0068 Decision 4, item 7).
- **Q6** (raised by this ADR; **resolved**, D2 above). The command is dry-run
  by default, matching ADR-0035 §3 invariant 1:
  - A bare invocation or `preview` observes and decides, prints the posture, and
    spawns nothing.
  - `start --execute` launches. Explicit invocation plus the action-specific flag
    is the opt-in.
  - The prototype mirrors this with `--dry-run`.

## Implementation note 2026-09-29 — S0 (headless-safe runbooks)

- **"Claude-provided" is a load-time substitution, not an environment
  variable.**
  - Claude Code 2.1.284 writes the plugin's path in place of the braced
    `${CLAUDE_PLUGIN_ROOT}` when it loads a plugin command or skill body. It
    leaves the bare `$CLAUDE_PLUGIN_ROOT` alone, and that is empty in a Bash
    tool call (probe B). Measured with a `--plugin-dir` probe and with this
    repository's directory marketplace.
  - So every command block that uses the root now opens with
    `CLAUDE_PLUGIN_ROOT="${AGENTIC_<PLUGIN>_ROOT:-${CLAUDE_PLUGIN_ROOT}}"`.
    When that is still empty, it falls back to the newest cached version.
    Only release directory names count: `X.Y.Z` without leading zeros,
    optionally with build metadata whose identifiers are all non-empty. `sort -V` alone ranks a prerelease or a
    stray name above the newest release. The resolution order in D5 is
    unchanged.
  - Path references in command prose use the braced form too, so the model
    reads where the skill files are.
- **On a directory marketplace the substituted path is the marketplace
  source.** On the owner's machine that is the repository's `plugins/<name>`,
  not the install cache. An interactive session there therefore runs the
  working tree's scripts with the text it loaded. A worker still runs the
  installed version, because the driver's `AGENTIC_<PLUGIN>_ROOT` exports come
  first (D5 Env).
- **No `rm` in runbook shell.** No runbook writes a temporary file it would
  have to remove:
  - stderr passes straight through;
  - the decide context is printed
    ([ADR-0027](0027-decide-skill-multi-axis-evolution.md) amendment of this
    date);
  - `/orchestrator:done` pipes its note to `state.mjs --reason-file -`;
  - `/orchestrator:abort` and `/orchestrator:finalize` take the step-2 tally
    from the shim's exit status;
  - the args-file reader removes what it read
    ([ADR-0059](0059-runbook-argument-transport.md) amendment of this date).
- **Runbook defects found on the way.** `/abort` and `/finalize` had four:
  - They ended with exit 0 when find-active or find-macro failed, because
    `$?` inside an `if !` branch is the negation's status.
  - Their step-2 gate skipped its check when the tally file was missing.
  - Their step-2 shim logged a child of the macro it could not read and moved
    on without counting it, so step 3 closed the macro over a live child.
  - Phases 1–3 read what Phase 0 set, but nothing said to run them in one
    shell. Run one per Bash call, they called `/scripts/state.mjs`, and
    Phase 3 printed success anyway.

  All four are fixed. The runbooks now say to run Phases 0–3 in one Bash
  invocation, and each later block stops when Phase 0 has not run in its
  shell. `tests/orchestrator/test-abort-finalize-runbook.mjs` runs the blocks
  to show it.
- `tests/plugin-shape/test-headless-safe-runbooks.mjs` pins both rules, and
  `scripts/mutation-specs/headless-safe-runbooks.mjs` shows each check fails
  on the defect it guards.
- **The plugin-root hint (D5)** is no longer needed by an installed version
  that carries S0.

## Implementation note 2026-09-30 — S1 (engineer schema 1.4)

- **Schema 1.4** adds the D6 engineer fields as six optional flat scalars:
  `next_step_kind`, `next_step_verb`, `next_step_confidence`,
  `awaiting_owner_gate`, `awaiting_owner_since` and `awaiting_owner_pointer`.
  - An absent key means null.
  - Validation is per key, so a file on disk schema 1.3 may carry them, and a
    write never changes a file's schema.
  - The engineer gates are `scope-routing`, `decide-conflict`,
    `recurring-finding`, `staging-set` and `pr-handling`. `plan-approval` and
    `plan-conflict` live on the macro, and `duplicate-workflow` is not stored.
- **Their position matters.** A 1.3 reader keeps keys it does not know in its
  forward-compat carrier and writes them after every key it knows. The six
  keys come after `parent_writeback_at`, which is where that puts them, so a
  1.3 reader's write leaves them byte for byte. A test builds such a reader
  from this build minus the six keys.
- **Formats the plugin change specification left open:**
  - `awaiting_owner_since` has the form the state script writes for its own
    timestamps, `YYYY-MM-DDTHH:MM:SSZ`, and must be a real instant.
    `Date.parse` alone would turn 2026-02-30 into 2026-03-02.
  - `awaiting_owner_pointer` is `path#anchor`. Both parts are non-empty, use
    only `[A-Za-z0-9._/-]`, and the pointer has no leading `/` and no `..`.
- **CLI:**
  - `append` and `set-terminal` take `--next-step-kind`, `--next-step-verb`
    and `--next-step-confidence`, which replace all three keys at once. The
    verb is required exactly when the kind is `verb`.
  - Every flag in this CLI takes a value, so clearing is
    `append --clear-next-step true`, parsed strictly. It cannot be combined
    with the `--next-step-*` flags; `--clear-next-step false` is the default
    and changes nothing.
  - `awaiting-owner-set` defaults `--since` to now. Setting the gate that is
    already set replaces its pointer and since; a different gate is refused.
  - `awaiting-owner-clear` is refused when no gate is set, when the gate named
    is not the one set, and when `AGENTIC_AUTOPILOT` names an autopilot run.
    The keys are deleted, so it appends
    `### Owner gate resolved: <gate> at <iso>` with the since and pointer it
    cleared (Q2).
  - Input is checked before the file lock is taken, and the frontmatter is
    checked again before it is written, so an inconsistent set never reaches
    disk.
- `tests/engineer/test-state-schema-14.mjs` and the last block of
  `tests/engineer/test-state-schema-forward-compat.mjs` cover this.
  `scripts/mutation-specs/engineer-schema-14.mjs` shows each check fails on
  the defect it guards.

## Implementation note 2026-09-30 — S2 (orchestrator schema 1.2 + plan approval)

- **Schema 1.2** adds the D6 macro fields as six optional flat scalars:
  `plan_approval_status`, `plan_approval_approved_at`,
  `plan_approval_plan_hash`, `awaiting_owner_gate`, `awaiting_owner_since`
  and `awaiting_owner_pointer`. They come after `terminal_marker`, where a 1.1
  reader's forward-compat carrier writes keys it does not know, so a 1.1
  reader's write leaves them byte for byte. The macro gates are
  `plan-approval` and `plan-conflict`; the since and pointer formats are S1's.
- **Invariants.** `approved_at` and `plan_hash` are present exactly when the
  status is `approved`, and the three `awaiting_owner_*` keys appear all or
  none. The specification required a pending plan to carry a macro gate. The
  converse holds too, because both macro gates concern the approval: a macro
  gate is set only while the plan is pending.
- **`plan_hash`** is sha256 over JSON with sorted keys and no whitespace. The
  input is `plan.subtasks[]` in order, each projected to `id`, `label`,
  `branch`, `blocked_by`, `verb`, `profile` and `topic`. An absent or null
  field is left out, because the serializer drops a null optional field, so
  a plan hashes the same before and after it is written. The order of
  `blocked_by` counts. `state.mjs plan-hash` prints the hash and the
  projection it covers, so no other plugin recomputes it.
- **Transitions.** Each is one write under the macro's lock:
  - `plan-set`, from any state, gives `pending`. The gate is
    `plan-conflict` when `--verdict conflict` is passed, and `plan-approval`
    otherwise.
  - `awaiting-owner-set --gate plan-conflict` raises `plan-approval` to
    `plan-conflict`.
  - `awaiting-owner-clear --gate plan-conflict` returns it to
    `plan-approval`.
  - `plan-approve` gives `approved` with no gate.

  The specification contradicted itself here. `plan-set` sets
  `plan-approval`, and the conflict path's later `awaiting-owner-set` would
  then refuse a different gate under the engineer contract. A later write would
  also leave a window in which another session could approve the disputed plan
  (the Codex review reproduced it). `/orchestrator:plan` knows its verdict
  before it writes the plan, so `plan-set` takes it and sets the conflict gate
  in the same write. Raising `plan-approval` to `plan-conflict` is still the
  one change of gate that `awaiting-owner-set` allows. Clearing
  `plan-conflict` does not leave the plan without a gate, because it is still
  pending. `plan-approval` is never cleared, only resolved by approving. This
  is the method of owner decision D7, which is still open.
- **`plan-set` revokes on every write.** That includes a write that leaves
  the hash unchanged: the specification says any plan edit revokes, and a
  re-plan is what the owner re-approves. Progress writes do not revoke an
  approval: `subtask-update`, the engineer terminal note and
  `bulk-subtask-status`.
- **`plan-approve`** takes `--expect-hash`. It is refused when that hash
  differs from the current one, while `plan-conflict` is set, on an empty
  plan, on a terminal macro, and under an autopilot run. Approving the same
  hash again writes nothing. Two cases are allowed, because each is the
  owner acting on a plan they were shown:
  - a macro planned before 1.2, which has no approval keys;
  - a stale approval, one whose hash a 1.1 writer's plan change no longer
    matches.
- **`next-ready`** adds `approval: {status: approved|pending|absent,
  hash_ok: true|false|null}` on every output shape.
- **`/orchestrator:approve`** and its Codex mirror show every field the hash
  covers, the topic included, then approve with `--expect-hash` set to the
  hash shown. `/orchestrator:plan` passes its verdict to `plan-set`; the
  state script computes the pointer from the macro's state home.
- **Pointer anchors are labels.** `#macro-plan` names the frontmatter
  `plan` block, and `#ensemble-synthesis` names the plan's Plan-verify
  synthesis: its `plan-verify` entry in `ensemble_results`, and the
  `### Ensemble synthesis` phase note that `/orchestrator:plan` appends.
  Neither is an HTML id: a macro collects one synthesis per revision, so a
  fixed id would be ambiguous, and the owner finds the section by name.
- **Not in S2:** the `/orchestrator:next` gate (S6) and the entry-brief rows
  (S7). Until S6 lands, nothing refuses to dispatch an unapproved plan: the
  documentation says the autopilot "is to" dispatch only an approved plan.
  - For S7: a plan hash is 64 hex characters, which the state scripts'
    secret scrubber (`[a-fA-F0-9]{32,}`) redacts. A reader that scrubs the
    frontmatter text before it reads the hash loses it.
  - A macro that `/orchestrator:finalize` or `/orchestrator:abort` closes
    keeps its approval keys as they were.
- Tests:
  - `tests/orchestrator/test-state-schema-12.mjs`;
  - `tests/orchestrator/test-approve-runbook.mjs`, which runs the approve block
    and `/orchestrator:plan`'s note + ensemble block in bash and zsh;
  - the last two blocks of `tests/orchestrator/test-state-schema-forward-compat.mjs`,
    one with a 1.1 reader derived from this build and one with the released
    1.1 code, read from the tag `plugin-orchestrator-v0.14.1` (skipped in a
    clone without it);
  - `tests/plugin-shape/test-autopilot-enum-parity.mjs`, which holds the
    engineer and orchestrator copies of `isAutopilotRun` and the pointer
    shape equal.

  `scripts/mutation-specs/orchestrator-schema-12.mjs` shows each check fails
  on the defect it guards, the lock included.

## Implementation note 2026-09-30 — S6 (`/orchestrator:next` approval gate)

S6 closes the gap the S2 note leaves open: `/orchestrator:next` now refuses,
under an autopilot run, a plan the owner has not approved at its current hash.

- **One decision point.** `state.mjs approval-gate --workflow-path <macro>
  --host claude|codex --subtask-json <subtask>` decides; `planApprovalGate`
  is its function. It reads
  the approval from `planApprovalState`, the facts `next-ready` reports, and
  `isAutopilotRun` for the mode. The runbooks neither compare hashes nor match
  `AGENTIC_AUTOPILOT` themselves, so the run-id pattern keeps the one copy per
  plugin that `tests/plugin-shape/test-autopilot-enum-parity.mjs` holds equal,
  and both hosts get the same decision and the same text.
- **Where it runs.** `commands/next.md` Phase 1, after the dispatch-ready
  validation and before Phase 2, for an explicit id as well as for the
  automatic pick (`subtask-readiness` reports no approval). The Codex mirror
  runs the same command with `--host codex`.
- **Autopilot.** Only an approved plan whose hash matches proceeds. A plan
  pending approval, one changed since it was approved, and one with no
  approval recorded are refused: `✗ plan-unapproved — …`, then
  `Pointer: <path#anchor>` and the owner's action, exit 1. The pointer is the
  macro's `awaiting_owner_pointer` when a gate is set (`#ensemble-synthesis`
  under `plan-conflict`), and `<macro file>#macro-plan` otherwise.
- **Bound to the selection.** The runbook dispatches the subtask as its
  selection step read it, which is an earlier read than the gate's. The gate
  therefore takes that subtask (`--subtask-json`) and, under autopilot,
  refuses it unless it equals the approved plan's entry for its id in every
  field the hash covers. Without this, a plan rewritten and approved between
  the two reads passed the gate while the old subtask went on to dispatch (the
  Codex review reproduced it in bash and zsh, by explicit id and automatic
  pick). The refusal tells the worker to run `/orchestrator:next` again.
  Interactive dispatch is not refused over it.
- **Interactive (D3 = a).** Never refused. One warning line for a plan pending
  approval, and also for one whose approved hash no longer matches: the
  specification names only pending, but D4 treats a mismatch as unapproved,
  and staying silent would present a stale approval as valid. A macro with no
  approval keys (planned before 1.2) and an approved plan get no line.
- **Not a lock.** The gate checks at dispatch. A `plan-set` that lands between
  the gate and Phase 5's `subtask-update` revokes the approval after the
  check, and the dispatch goes on with the subtask as it was approved; the
  driver's own policy (D4 rule 3, S8) halts before the next step.

  *Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
  slice 4, accepted 2026-10-20):* the gate is unchanged.
  An approval that changes the plan joins the run locks as an admission, so
  it is refused beside a live run of the macro. A `plan-set` followed by an
  approval between two of the driver's looks therefore no longer passes
  unseen: the approval is refused, and the run halts at its next look. An
  approval that changes an in-progress subtask's topic or profile records a
  rebinding of its child, and is also refused while that lane is held, has
  a release awaiting comparison or has a persona operation open. The
  dispatch comparison accepts the rebinding only under the current
  approval, and for an active child only once the child has been told
  (ADR-0068 Decision 8).
- Tests: `tests/orchestrator/test-next-approval-gate.mjs` covers the function
  over every approval state in both modes, the binding, the CLI, the runbook
  block and Phase 1 end to end in bash and zsh (explicit id and automatic
  pick, and a plan replaced and approved between selection and gate), and the
  Codex mirror's snippet, run as written. `scripts/mutation-specs/orchestrator-next-approval-gate.mjs`
  shows each check fails on the defect it guards.

## Implementation note 2026-10-01 — S3+S4 (verb runbook deltas and `/engineer:commit`)

S3 and S4 land together: once autopilot verbs stop writing the terminal
marker, only the commit surface can close a workflow. The rules the runbooks
follow live in one file, `plugins/engineer/core/skills/_shared/references/autopilot-mode.md`.

- **Every mode decision is made in code.** A runbook never matches
  `AGENTIC_AUTOPILOT`:
  - `state.mjs autopilot-preflight [--surface verb|commit]` runs in Phase 0
    before any write. Interactively it prints nothing. Under an autopilot run
    it prints the rules for that surface. With an owner gate set it refuses
    under autopilot; interactively it prints the gate, its pointer, how it is
    resolved and the clear command.
  - `state.mjs finish-verb` is each verb's last write, in both modes.
    - Interactive: the old `set-terminal summary-complete` plus the next step,
      so the footer prints as before.

      *Note 2026-10-19 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
      accepted 2026-10-20):* not while the workflow's
      subtask is held or has a kept lane park, nor while a run of its macro
      is live: then it records the next step and leaves the terminal marker
      unset, as under autopilot, and the driver resumes the lane from that
      step (ADR-0068 Decision 2, item 6).
    - Autopilot: the next action and next step only. The terminal marker is
      turned off, an inherited one included, and the handoff sidecar is
      skipped. A pending peer ensemble is refused.
    - `set-terminal` with the marker on (the default) is refused under
      autopilot.
  - `phase7-commit.mjs --mode autopilot` is `/engineer:commit`'s whole step.
- **`next_step`.**
  - The six verbs pass kind, verb and confidence to `finish-verb`.
  - Phase 0's resume clears the next step.
  - Phase 0's resume write, Phase 2's note and Phase 2's `ensemble-commit`
    stop the block when they fail. Before, the final write ran anyway, so a
    failed write could still publish a next step.
  - The entry-routing contract states the projection, including `done`, and
    amends its "confidence has no durable home" paragraph (item 5 above).
- **Owner gates.** Specification §1.4 and D6 have the pausing surface set
  the gate, in either mode:
  - `decide-conflict`, `recurring-finding` and `scope-routing` are recorded in
    both modes. `finish-verb --owner-gate <gate> --owner-gate-anchor <label>`
    writes the gate and the next step `owner-decision` in one write, at the
    proposal's own confidence. The workflow stays non-terminal until the owner
    resolves the gate.
  - `staging-set` and `pr-handling` are autopilot set points, where the
    specification places them. Interactively the owner answers in the dialog.
  - Recording a gate turns an inherited terminal marker off in the same
    write, whichever path records it. A workflow waiting on its owner is not
    complete, and a refusal after the owner's resolution would otherwise leave
    the old marker in front of a Stop hook that sees HEAD moved.
  - They are resolved by D7's specification method, D7 still being open:
    decide's Owner selection step, refine's Owner decision step, interactive
    `/engineer:commit` for `staging-set`, and `awaiting-owner-clear` for the
    rest.
    - `awaiting-owner-clear` now takes `--next-step-*` and `--resolution`.
      The owner's decision in words, the clear and the next step it implies
      are one write. The next step therefore never becomes runnable without
      the decision behind it, and a failure cannot leave the `owner-decision`
      the gate recorded. Every resolving block uses it, resolves the workflow
      itself rather than relying on an earlier Bash call, and stops when a
      write fails.
  - The Stop hook's gate 5 means a workflow with a gate pending is not
    archived. The same holds in the branch-agnostic sweep, including for a
    workflow whose branch was deleted.
  - Anchors are labels, as in S2. `autopilot-mode.md`'s table is the source,
    and a shape test holds the anchors the runbooks and `phase7-commit.mjs`
    use to it.
- **Ceremonies.** The rules are stated where each ceremony lives:
  - the presentation-mode offer and "Recommended: X. Proceed?";
  - critique's MINOR pick;
  - each verb's Autopilot section;
  - the approval points inside the decide, compose and refine skills. Their
    own "wait for the user" instructions would otherwise stall an unattended
    step, since Claude commands run those skills too.

  compose and refine never commit.
- **Peer collection.** The six verb launch blocks ran the runner behind a
  shell `&`. That detaches it from the host's background-task tracking: under
  stream-json hosting the step can end before the peer does, and a model left
  waiting has nothing to wait on. Probe E saw workers sleep-poll for a peer;
  that the detached runner is why is an inference. The blocks now run the runner
  in the foreground of a host background task (Claude: `run_in_background`),
  and `ensemble-protocol.md` states the rule. The designer and founder
  runbooks keep the `&`; they are outside this slice.
- **`/engineer:commit`** is a new meta command with a Codex skill, over the
  ADR-0028 driver. Its changes to the driver:
  - **`classifyNoChanges`** decides what a clean tree means. Plan reports it,
    and execute and close act on it:
    - `recovery` is the A2 fast path, on its old condition;
    - `close` needs a clean `git status`, HEAD at the baseline, no marked
      commit, `next_step_kind: done`, and a workflow that is not an
      `/engineer:start` one;
    - `blocked` carries one of `partial-commit`, `unmarked-commits`,
      `next-step-not-done`, `no-baseline`, `git-probe-failed`,
      `status-not-clean` or `start-workflow`.

    `git diff --name-only HEAD` alone cannot prove a clean tree: it does not
    show a staged change the working tree reverted. Both endpoints of a
    rename count, so a rename into workflow storage is a deletion outside
    it.
  - **`--mode close`** writes `close-complete` with the marker, then archives
    the workflow: its HEAD never moved, so the Stop hook would not. It prints
    no handoff, whose projection would read the unmoved HEAD as blocked and
    advise a commit.
    - A close stopped between its two writes is finished by running it
      again.
    - The handoff a Stop hook renders for such a workflow names that rerun,
      not a commit.
    - The Stop hook never notes a `close-complete` workflow on its parent.
  - **Execute** takes the workflow out of its terminal state (`beginCommit`:
    `phase-7-commit`, marker off) once every subject is checked, before the
    first commit, and before the A2 fast path's gates.
    - Before this, a split failing at its second commit left an interactive
      verb's inherited marker in front of a Stop that saw HEAD moved. That
      Stop archived the half-committed workflow and noted its first commit on
      the macro.
    - `/engineer:start` gains only the phase name on a failed Phase 7 (ADR-0028
      §P5 note).
    - Execute and close refuse while an owner gate is set, in both modes.
  - **`--suggested-subjects`** uses plan mode's `inferSubject` for every
    commit, single or split, so no subject passes through a shell.
  - **`--mode autopilot`** refuses:
    - outside an autopilot run;
    - on an `/engineer:start` workflow;
    - over an owner gate;
    - with a pending peer ensemble, before anything is committed.

    On a clean tree it recovers, closes or refuses. It stops at `staging-set`
    when `ask_user` is true, when the workflow did not begin on a clean tree
    (its recorded status digest is not the digest of an empty status), or when
    the index is pre-staged: only the owner can tell pre-existing hunks from
    the workflow's own. Otherwise it commits with the suggested subjects and
    `--strict-cc`.
  - **Under autopilot** every staging bypass is refused with exit 2:
    `--confirm-non-interactive`, `--non-interactive`, `--accept-current-tree`,
    `--include-extra` and `ACCEPT_CURRENT_TREE=1`. So are `--mode execute` and
    `--mode close`: they run only from inside `--mode autopilot`, so no direct
    call steps around its clean-baseline and pre-staged rules.
  - **The next step is left as it was on a commit.** `done` means the
    no-commit close (D6), so writing it after a commit would send the driver
    to `--no-commit`. A routine commit sets no `pr-handling` gate: waiting to
    land is read from state (D3a).
- **Outcomes S8 reads.** This refines D3a's "archived with its terminal marker
  set". Once a workflow is terminal its phase is the outcome, and `next_step`
  is history:

  | durable state | meaning |
  |---|---|
  | active, not terminal (commits may exist) | in progress, or an interrupted commit: `/engineer:commit` recovers it |
  | archived, terminal, `commit-complete` | committed: check the landing (D3a) |
  | archived, terminal, `close-complete` | closed without a commit: `/orchestrator:done <id> --no-commit` |
  | active, terminal | the archive has not run (a Stop gate failed, or a close stopped before its archive): `/engineer:commit` again |

- **Capability floor for S8.** The S0 note explains how runbook text and
  scripts can come from different versions. The released engineer 0.23.0
  scripts have no `autopilot-preflight`, `finish-verb`, `--mode close` or
  `--mode autopilot`. With them, a verb's Phase 0 fails before any write,
  which a test checks against the tagged scripts. The driver has to require
  the engineer release that carries S3+S4 before it starts a run.
- **Known limits.**
  - The suggested subject's type follows the workflow's last verb, so a
    compose → critique → commit chain suggests `chore`. The squash title the
    owner lands is what reaches `main`.
  - The model-judged set points (`recurring-finding`, `scope-routing`,
    `pr-handling`) are pinned by shape tests, not by code; the driver's halts
    are the backstop.
- Tests:
  - `tests/engineer/test-autopilot-verbs.mjs` (state);
  - `tests/engineer/test-engineer-commit.mjs` (the driver against sandbox
    repositories, including the half-commit Stop case and the spec §1.9 chain);
  - `tests/engineer/test-verb-runbook-autopilot.mjs` (the blocks as written in
    bash and zsh, including the released 0.23.0 scripts);
  - `tests/plugin-shape/test-engineer-autopilot-runbooks.mjs` (placement and
    anchors).

  `scripts/mutation-specs/engineer-autopilot-verbs.mjs` shows each check fails
  on the defect it guards.

## Implementation note 2026-10-01 — S8 (the driver and `/orchestrator:autopilot`)

S8 ports the handoff prototype into `plugins/orchestrator/adapters/claude/autopilot/`
and replaces its four shims with the state the earlier slices added. The
driver is one loop — observe, decide, act, verify — over seven modules:
`observe.mjs` assembles the view through the owning plugins' CLIs and git,
`policy.mjs` decides from it (pure), `worker.mjs` hosts each step, `ledger.mjs`
keeps the run's record and locks, `roots.mjs` resolves and checks the plugin
roots, `driver.mjs` runs the loop, and `cli.mjs` is the entry of
`commands/autopilot.md` and of the optional launcher.

- **The shims are gone.**
  - SHIM-1: the next step and owner gates are read from the engineer workflow
    (`next_step_*`, `awaiting_owner_*`) and the macro. The worker's structured
    report stays as a cross-check (owner decision D11, 2026-10-01): it names the
    engineer workflow it echoes, and a report that disagrees with the state halts
    `owner-choice`. It never allows a step.
  - SHIM-2: `plan_approval_*` through `next-ready`'s `approval`.
  - SHIM-3: the plugin-root hint is removed. S0 is released, and the capability
    floor below requires releases that carry it; the appended system prompt keeps
    only the step rules.
  - SHIM-4: `/engineer:commit`.
- **Owner decisions taken for S8 (2026-10-01).**
  - D5: the model plan is asked before each start — `owner-default`, `mixed`
    (judgment verbs on the owner's default, compose and refine on sonnet/medium,
    the mechanical steps on sonnet/low) or `sonnet`. `/orchestrator:autopilot
    start` asks; a terminal start asks on its TTY; anything else must pass
    `--models` (or `--model`/`--effort`).
  - D10: budgets stay finite, as D1 requires, but out of the way: 60 steps, $250
    a run, $25 and 60 minutes a step, 24 hours a run. The run's caps bound each
    step too (a step may spend only what is left, and run only until the run's
    deadline), a killed worker that reported no cost is charged its whole step
    budget, and a time bound under 60 seconds is refused rather than raised.
    The state is read before the budgets, so completion on the last step the cap
    allowed is completion.
  - D11: the report is kept as a cross-check (above).
  - D13: the launcher ships (`launcher.template.mjs`); `preview` prints the
    command that installs it, and nothing installs it for the owner.
- **The step table** (D3) is the closed set the policy renders from; only
  identifiers checked against a closed alphabet enter a prompt:
  `/orchestrator:next <id> --workflow=<macro>`, `/engineer:<verb>`,
  `/engineer:commit`, `/orchestrator:done <id> --workflow=<macro>`,
  `/orchestrator:done <id> --no-commit --workflow=<macro> <fixed reason>` and
  `/orchestrator:finalize --workflow=<macro>`. The macro is pinned on the first
  look, so a later step finds it whatever branch is checked out.
- **D3a, landing.** A subtask whose engineer workflow is archived terminal is
  checked with `git fetch origin <integration>` and `state.mjs resolve-landing`:
  merged → `/orchestrator:done`; `no_pr` or `not_merged` → it waits; any other
  answer → `owner-choice`. `close-complete` → `/orchestrator:done --no-commit`.
  When nothing else is dispatchable and a subtask waits, the run halts
  `awaiting-landing` with each branch's push and pull-request commands (none
  for a branch outside `[A-Za-z0-9._/-]`). Several subtasks may be in progress
  at once; the prototype's "more than one in progress halts" rule is gone.
  Success is the archived macro — and only for the plan the owner approved:
  an archived macro whose plan changed during the last step halts
  `plan-unapproved`. `gh` is found through PATH, the seam the tests use.
- **Rules the review added (Codex Plan-verify, round 1).**
  - Every live engineer workflow that claims the macro must be the active child
    of an in-progress subtask; a dispatch interrupted before it recorded the
    subtask in progress halts instead of dispatching beside it.
  - An archived child is held to the same linkage as an active one (parent,
    subtask, branch, id): a plan revision that moves an in-progress subtask to
    another branch keeps its old engineer id.
  - A live workflow in `phase-7-commit` (an interrupted commit) or in a terminal
    commit phase routes to `/engineer:commit`, never to its stale next step; an
    `/engineer:start` workflow, a detached child and a pending peer ensemble halt.
  - `--next` replaces only the judgment halts of the active engineer child
    (low confidence, an owner decision, no next step) and goes through its
    step's prerequisites. Its grammar is `/engineer:<verb>`,
    `/engineer:commit` and `/orchestrator:next [<subtask>]`:
    `/orchestrator:done` and `/orchestrator:finalize` run exactly when their
    prerequisites hold, so forcing one could only skip a prerequisite (round 2
    reproduced a forced `--no-commit` completing unlanded work).

    *Note 2026-10-20 ([ADR-0068](0068-autopilot-lanes-that-keep-going.md),
    slice 4, accepted 2026-10-20):* the owner may also
    give a lane its next step while a run lives, as an instruction: the same
    grammar without the dispatch, and the same reach (it replaces the
    recorded step and its judgment halt, goes through the step's
    prerequisites, and leaves every gate, error and landing refusal
    standing), except that it never replaces an interrupted commit, which
    runs again first; with a note for the child, applied at the lane's next
    step boundary. A forced step on a lane with a pending instruction that
    carries a step is refused (ADR-0068 Decision 7).
  - Each step has a postcondition beyond "something changed": a dispatch leaves
    the subtask in progress with an active child; a commit archives, commits or
    sets a gate; a done completes the subtask; a finalize archives the macro.
    A commit recovery the Stop hook keeps refusing therefore halts once instead
    of repeating.
- **The worker's loaded plugins are checked at init.** The `system/init` event
  lists the plugins the worker loaded, with their paths and versions. Measured
  on the owner's machine (2.1.286): on a directory marketplace they are the
  marketplace checkout, so commands, skills and hooks come from that checkout's
  branch while the runbooks' scripts come from the pinned roots. The step is
  aborted before its first turn when a loaded orchestrator, engineer or runtime
  lies inside the repository the run drives (`owner-choice`: drive a separate
  worktree), or differs from the pinned version, or from what earlier steps
  loaded (`version-drift`). Roots inside the repository are refused at start for
  the same reason.
- **Pushes are blocked at the git level too.** Measured on 2.1.286: Claude
  Code's Bash rules match a command's leading words, so `git -C <dir> push`
  passes `Bash(git push:*)`, with or without a wildcard rule. Each worker's
  environment therefore carries `GIT_CONFIG_*` entries that rewrite a push to any
  https, http, ssh or git URL, and to each remote's own URL, to a scheme no
  remote helper serves (`pushInsteadOf`; `insteadOf` for an explicit pushurl,
  which git exempts from `pushInsteadOf`). Every push form fails at once; local
  pushes and fetches are untouched. `git@` covers the scp-style form of
  common hosts. A remote whose explicit pushurl equals a fetch URL cannot be
  covered without breaking the fetch, so the driver refuses to start on such a
  repository and says how to remove the redundant pushurl. Left open: an
  scp-style URL with another user that is no remote's URL.
- **The environment.** Beyond D5's list, the worker loses the launching
  session's `CLAUDE_CODE_SESSION_*`, `CLAUDE_BG_*` and `CLAUDE_RELAUNCH_*`
  variables (a background session's permission rules travel there), and the
  dispatch contract variables an outer session may have exported
  (`AGENTIC_PARENT_WORKFLOW`, `AGENTIC_ORIGINATING_SUBTASK`, `AGENTIC_PROFILE`,
  `AGENTIC_TOPIC`, `AGENTIC_HOST`, `CLAUDE_PLUGIN_ROOT`).
- **What a killed step leaves.** A peer runs detached from the worker's process
  group, so after a step that was aborted or failed, the driver cancels the peer
  runs that step left pending — on any engineer workflow of the macro, so a
  dispatch killed before it recorded its subtask in progress is covered —
  through engineer's own `peer-runner cancel`, which verifies the process
  fingerprint. A step that ended normally with a peer still pending halts for the
  owner instead.
- **Starting and stopping a worker.** Everything that can fail is set up before
  the worker is spawned, and the worker is recorded in the run's locks before it
  receives its prompt: a driver that dies in between leaves a worker with nothing
  to do, which exits when its stdin closes. An abort sends SIGTERM to the
  worker's process group, and SIGKILL five seconds later to a worker that has
  not exited. Once the worker has exited, output a descendant still holds is
  abandoned after three seconds rather than waited on.
- **Nothing a step started outlives it in its process group.** A step is over
  only once its worker's process group is empty. After every step, aborted or
  not, the group is sent SIGTERM (unless an abort already sent it) and is
  polled; five seconds after the signal, what is left gets SIGKILL. The driver
  releases its locks and exits only after that. Round 3 reproduced a driver that
  exited before an unreferenced SIGKILL timer fired, leaving a member that
  ignores SIGTERM running with no lock to show it. The ledger records
  `group_teardown` for each step: `empty`, `terminated`, `killed`, or
  `lingering` when a process outlives SIGKILL. A `lingering` step halts
  `worker-failed` whatever else it did, and the run keeps its lock entries,
  which name the worker's process group. Such an entry stays live while the
  group has members, so no run starts beside them; round 4 reproduced a run
  that went on to its next step. A process group under that id whose leader
  is provably another process does not count. POSIX reuses neither a pid nor
  a process group id while a group of that id exists, so a reused worker pid
  means the worker's group had ended. Round 5 reproduced a dead run's lock
  held by such an unrelated group. Only a different start time proves a
  reused pid. On macOS the fingerprint also holds the command line, which a
  wrapper that execs `claude` in place changes without becoming another
  process; round 6 reproduced a live worker's lock taken that way.
- **Locks.** There are two:
  - one per macro under the main worktree (D8);
  - one per worktree, because two runs of different macros must not switch one
    checkout's branch.

  A lock is a directory. Each run that wants it adds an entry of its own,
  `h-<pid>-<random>.json`, written whole. An entry records the driver and,
  while a step runs, its worker. It is stale only when both are gone, and a
  fingerprint that cannot be read counts as live. A process that has exited
  but that its parent has not yet reaped counts as gone, although
  `kill(pid, 0)` still finds it. The start time is compared first: an exited
  process that started after the recorded one is a stranger that reused the
  pid, not the recorded process having exited (round 8). The fingerprints are the driver's own
  (`processFingerprint`): `/proc` on Linux, and on macOS `ps` run in the C
  locale. peer-runner's `fingerprintForPid` reads the start time in the
  caller's locale, and its pattern fits only the C locale. Measured under
  ko_KR on 2026-10-03: the start time then swallowed the command line. The
  start alone could not be compared, and two processes in different locales
  fingerprinted the same process differently. A run holds the lock when,
  after adding its entry, it finds no other live entry. Otherwise it removes
  its own entry and retries after a random pause. It is refused when another
  run already holds the lock, or on its last attempt.

  Only entries whose runs are gone are removed, and no participant reuses
  another's name, so no run removes a live participant's entry. "Gone" holds
  only for the record it was judged on. An entry is read, then its processes
  are checked, so a gone entry is read once more after the check. Only an
  unchanged one is removed: only its owner writes it, and the check found that
  owner dead. Round 4 reproduced the failure this prevents. An owner recorded
  its worker and died between another run's read and its check, and that run
  removed the entry and started beside the worker. Two runs
  cannot both hold the lock: whichever added its entry second sees the first
  one's. This replaces the takeover protocol of rounds 1 and 2. Rounds 2 and 3
  each reproduced two holders in it: a paused contender lost an age-expired
  takeover, and then three contenders reclaimed one dead owner's takeover at
  the same time.

  The run takes its locks after its first look at the state. It looks again
  once it holds them and decides its first step from that second look.
  Round 6 reproduced the race this closes: a run that finished in between
  left a halt, and the new run stepped past it.
- **`stop`** signals only a pid it can prove is the run's process: alive, with
  a readable fingerprint that matches the lock's record. Liveness alone, which
  errs toward "held" for the lock, is not enough to signal. The pid it signals
  is one of:
  - the driver, which then empties its worker's group and records the halt;
  - when the driver died, the worker's process group, which `stop` empties
    itself the same way. It reports success only once the group is empty.
- **The ledger** writes a step's `started` record before the worker is spawned
  and its `finished` record after; `status` pairs them and names a driver that
  died mid-step.
- **Entry-brief.** Entry-brief 1.0 has no next-step rows (S7 has not shipped), so
  the driver composes the view itself (D8 = a) and uses the brief as a guard:
  `indeterminate`, `no-branch-context`, two live workflows competing on the
  branch, or a lead outside the step table halt `owner-choice`. The entry-capture
  lead and a leaderless `owner-choice-required` are normal between steps.
- **Not in S8:** the V1 harness (`e2e-macro.sh` still drives the prototype's
  interface), S7's entry-brief rows, worktree lanes, a dashboard row, and
  cross-run retention of the autopilot ledger (each raw worker stream is capped
  at 64 MiB).
- **Known limits.**
  - The denylist and the git-level block are guardrails, not a sandbox: a
    worker with `Bash` can reach the network another way (`curl` stays allowed,
    owner decision D17), and `gh` subcommands with global flags first pass the
    `Bash(gh pr:*)`-style rules.
  - The ADR-0059 args-file library's header still names four packages; the
    orchestrator copy is byte-identical, and the header is corrected in all five
    copies by a later change (one that touches those packages anyway).
- Tests: `tests/orchestrator/test-autopilot-policy.mjs` (every step and reason),
  `-worker.mjs` (a fake `claude`), `-ledger.mjs`, `-observe.mjs` (real state, a
  bare origin, a fake `gh`), `-driver.mjs` (the loop end to end with a scripted
  worker that runs `phase7-commit --mode autopilot` and the real Stop hooks,
  including the landing round trip), `-cli.mjs` (the runbook blocks in bash and
  zsh, the launcher); `tests/plugin-shape/test-orchestrator-plugin.mjs` (Claude
  only, no Codex skill) and `test-autopilot-enum-parity.mjs` (the driver's copies
  of the engineer enums and the D4 reason set).
  `scripts/mutation-specs/orchestrator-autopilot-driver.mjs` shows each check
  fails on the defect it guards.

## Amendment 2026-10-14 — document deliverables converge (C120)

**The problem.** A document subtask (an ADR, a runbook, other prose as the
main artifact) under autopilot did not converge. Every critique reviewed the
whole document again, so each round found new MINOR or MAJOR points in text
no refine had touched; refine fixed them, the next full critique found more,
and the model-judged recurring-finding rule could not tell a finding that
survived a fix from a new one in unchanged text. Code does not show this: its
review is held to the change set, and tests decide most findings.

**The rule.** A document deliverable gets one full critique. After a refine,
the next critique reviews the passages the refine changed and the findings it
targeted (a *scoped* critique). A new finding outside those passages is left
open for the owner (`### Left open` in the note), unless it is CRITICAL, which
refine carries. Every CRITICAL and MAJOR finding open in the ledger is
refine's work, targeted before or not, so a prior finding a refine skipped
still blocks. A finding a refine targeted that a critique leaves open is
*recurring*, and fixing it again is the owner's call (`recurring-finding`). A
code deliverable keeps the full critique and the judged recurring rule.

**What is a document.** The artifact set is every path that differs between
the workflow's `git_baseline.head` and the working tree (the state homes left
out). The deliverable is a document only when that set is not empty, every
path is a regular Markdown file ending in `.md` or `.markdown` (`.mdx`
carries code), no changed line, on either side, blank lines included, is or
may be code, and no path's code is changed by its prose: the sequence of
CommonMark code blocks and HTML blocks in the old text, each block's kind,
info string and content, is the one in the new text. A line is code when
either of two readers says so:

- *Reader 1*, a stateless over-reading with no fence pairing and no container
  tracking, so nothing in it can be paired or tracked wrong: every line from
  the file's first fence-like line (one holding three or more backticks or
  tildes, wherever they sit) to its last; every line whose leading white
  space reaches column 4 at the line start, or five columns past a
  block-quote or list marker in its prefix (tabs to the next multiple of
  four), with no paragraph exception; each blank run between two such lines;
  and each such line's neighbours.
- *Reader 2*, the CommonMark reference parser (commonmark.js): every line a
  code block spans, fenced or indented, fence lines included, and every line
  an HTML block spans, whatever its tags (a `<pre><code>` block carries a
  command as text, and a list of tags would pass one it does not name). CommonMark also
  ends a line at a bare CR, which git does not, so a text holding one is read
  as code throughout (its parser lines are not git's).

Reader 2 settles where an unclosed or mis-paired fence ends, which reader 1
cannot without pairing; reader 1 covers what the specification reads as text
but an agent may run (an indented line CommonMark joins to a link definition's
title or a paragraph). Markdown can execute, and a runbook's shell block is
code. Other prose formats stay full: a `.txt` name is no evidence
(`CMakeLists.txt`, `requirements.txt`), and reStructuredText and AsciiDoc have
code block forms the test does not read.

*Note 2026-10-15 (the owner's ruling on the recurring M3 finding).* Three
refine rounds each fixed the reported cases of a hand-written classifier that
paired fences and tracked containers, and each Refine-verify found new
CommonMark cases where a command edit read as prose (a quoted fence closed
early, a rejected closer that desynchronized later fences, code characters
read as container markers, a paragraph exception that trusted a link title,
a blank line inside indented code). The union above replaces that classifier.
On the owner's prototype measurement (not peer-verified), of 204 all-Markdown
commits on `main` the earlier classifier called documents, the union keeps
183, and it only ever moves a change from document to code. Reader 2 is the
persona scripts' first third-party code: commonmark.js 0.31.2 (BSD-2-Clause,
with the MIT notice of one derived file), its self-contained
`dist/commonmark.min.js` vendored byte for byte as
`persona-pipeline/files/scripts/lib/vendor/commonmark.min.cjs` under a copy
notice that carries its LICENSE, the npm tarball's shasum and the sha256 of
the upstream bytes, which a test checks; `review-scope.mjs` loads it with
`createRequire` on first use. It is a parser of a frozen specification, read
for its code blocks and HTML blocks only (their positions, and the kind, info
string and content the block-sequence rule compares), so it is updated only
for a CommonMark release or a parser fix that changes those, by replacing
the bytes, the LICENSE and the two hashes together. Refine-verify of the union
found one more shape: an explicit HTML code block (`<pre><code
class="language-sh">` with a command inside) is an HTML block to CommonMark,
not a code block, and reader 1 has no rule for it, so a changed command there
read as prose. The owner widened reader 2 to every HTML block, with no tag
list: on `main` it moves 7 of the union's 183 documents to code (176 kept),
where counting only blocks that name `<pre>`, `<code>`, `<script>`,
`<textarea>` or `<style>` moved none but would pass a tag it does not name.
The closing critique then found that a change can leave every changed line
prose and still change code (its M1): dropping a list marker four lines above
a fence pulls an unchanged, unindented `rm -rf ~/work` into the fence, the
passage is only the edited line, and a new MAJOR at the command could be left
open. A fuzzer found 25 of 1,187 document verdicts whose code or HTML block
contents differed between the two texts. The owner ruled for the
block-sequence rule above, beside the union: it reads what the blocks hold,
not where, so prose that only moves a block changes nothing, and it only ever
moves a change from document to code. On `main` it moves none of the 176
documents.

**The evidence a fresh worker reads** is the review ledger,
`<state home>/reviews/<workflow id>.json`, written by `state.mjs` holding the
workflow's lock; no plan field and no frontmatter key is added (the plan's
field set is closed and hashed, and the ledger's name derives from the
workflow's). It holds one *generation* per critique (mode, reason, the
working tree it reviewed as a tree object, HEAD, the baseline, the artifact
set, the passages of a scoped one, its targets, the critique runs the
workflow had noted when it opened, open / closed / abandoned),
every finding with a workflow-wide id (`G<generation>-F<n>`), severity,
location, text, disposition (open / resolved / left-open) and the refine
attempts that targeted it, and one refine attempt per critique (`R<generation>`:
its targets and the tree it left). Each ledger has an id of its own, which
`critique-scope` prints and `critique-close` must name: ids restart in a
ledger that replaced another, so a close from before the reset is refused,
never applied to findings it did not see.

- `critique-scope` opens generation g at the working tree T, captured as
  `peer-snapshot.mjs` captures a snapshot, without materializing it, and
  prints the scope. A deliverable that is not a document records nothing,
  and a ledger an earlier critique left is moved aside, so a document that
  turned into code hands refine no findings its last critique never judged.
  So does a checkout the ledger cannot vouch for: a baseline that is not a
  full commit id resolving to a commit (a symbolic `HEAD` or branch moves
  with the checkout), or a working tree the capture cannot read (a conflicted
  merge, HEAD moving) or cannot vouch for (an index entry marked
  assume-unchanged or skip-worktree: `git add -A` keeps its staged blob, so
  an edit to that file would not be in T).
- `refine-record` (after the fix, before Refine-verify) records the targets
  and the tree the refine left; a later edit in the same refine re-records.
  It also prints `verify`, the mode the next critique would have on that
  tree: Refine-verify is scoped only when that is `scoped`, so it is held to
  the same conditions.
- `critique-close --ledger <id> --generation g` records the synthesis's
  findings and prints the disposition (`converged`, `carry`, `left_open`,
  `recurring`). It refuses when the checkout no longer holds T, or the
  ledger is not the one `critique-scope` named: findings are never held to
  text nobody reviewed. A generation a crashed run left open is abandoned by the next
  `critique-scope`.
- `review-status` prints the ledger for refine: its work (`carry`) and the
  recurring findings (a refine targeted it, and a critique closed since
  judged it unresolved; a target no critique has judged since its refine,
  such as one a partial critique did not report, is not one),
  which end it on the gate before any fix, unless the owner already cleared
  that gate with Fix now after the last critique's notes (the resume note a
  fresh worker writes after it does not count against the ruling).
- From a checkout that is not on the workflow's branch, whatever state its
  working tree is in, `critique-scope` and `refine-record` record nothing
  and leave the ledger alone, and `critique-close` refuses: a worktree sharing the state root never writes
  another branch's ledger. A ledger whose entries are malformed is moved
  aside and the critique is full; `review-status` reads it as no ledger. So
  is one whose stored passages are not line ranges on its artifact paths, or
  whose generation ids do not run 1, 2, 3 in order. A checkout whose HEAD git
  cannot read reaches the script all the same, which falls back.
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
  is not caught either, and its findings are not in the notes refine reads. More runs noted than the last generation counted (plus the caller's
  own run, for `critique-scope`) means a critique the ledger did not see:
  `review-status` and `refine-record` read no ledger, and `critique-scope`
  moves it aside and opens a full one. A run stopped before it reached
  `critique-scope` counts too, which costs only the scope.

**Scoped, or full.** A critique is scoped only when all of these hold, and
full otherwise, with the first that failed as its reason: the default review
profile (another profile is `partial`, below); no merge, rebase, cherry-pick
or revert in progress; a non-empty
document artifact set; a full generation closed in the ledger; a last closed
generation that is not partial; a refine recorded after it whose tree the checkout still holds
(nothing was edited after the record, and an older release's refine, which
records nothing, falls back); HEAD and the baseline unchanged since that
generation (no commit and no merge); the same artifact set (no path added,
removed or renamed); every target a ledger finding; and the tree the last
critique reviewed still readable (it is unreferenced, so `git gc` may prune
it, and a lost file is not an absent one). A full critique never
takes the left-open route: every CRITICAL and MAJOR it finds is carried, and
a prior finding it does not report again is resolved. A *partial* critique (a
profile other than the default, such as a single lens) judges only what it
reports: it resolves no finding it does not, leaves nothing open by scope,
and is never the full critique a scoped one starts from. A refine's targets
stay targets until a critique judges them (a full one judges them all, the
ones it does not report included): one a partial critique does not
report is open, it stays a target of the next partial critique, and since the
lens may not cover it, the omission is no judgment the recurring rule counts. A finding's severity
follows the latest judgment, except that a scoped or partial critique never
lowers a CRITICAL or MAJOR one, and references that disagree take the
highest. A scoped critique resolves a finding the refine did not target only
when the critique places it in a passage, in the current text (the ledger's
location is in the coordinates of the text it was found in, which the refine
may have shifted): elsewhere it read no text, so the verdict is noted and the
finding stays.

**Passages.** The diff from the last critique's tree to the current one, per
artifact path, at Markdown block level in the current text: a code or HTML
block as CommonMark reads it, a list or a table with no blank line in it, and a heading
are each one block. A
deletion anchors to the blocks just before and after it, with the deleted text
shown as before; a change that leaves a file with no block makes the whole
file the passage. A finding is in scope when its location overlaps a passage,
whatever scope the peer claimed, and when the review marks it in; a location
with no line range on a passage path counts in scope unless marked outside,
and a finding with no location cannot be shown outside. A location is read
the ways reviewers write it (`path:12`, `path:12-20`, `path:12:3`,
`path#L12`, `./path`, an absolute path ending in an artifact path); one on
a path the artifact set does not hold (a relative path that only ends in an
artifact path is another file) cannot be placed, and counts in scope.
A reversed line range is refused. A left-open finding reported again, not
CRITICAL, stays left open only when every report of it places it outside the
passages in the current text, or each scoped critique would pull it back
into refine; a report with no location is not placed outside (the ledger's
location may have shifted). A finding a refine targeted is judged as any
target, whatever it was before: left open, or resolved by an earlier critique
and edited again, it is carried when unresolved or given no verdict.

**The peer contract.** Scoped review and Scoped refine-verify templates (the
ensemble protocol's § Scoped re-check) give the peer the passages and the
findings by id, and ask one line per finding: id or NEW, a verdict for an id,
severity, location, in or outside, evidence. A target with no verdict, two or
contradictory ones counts unresolved. The convergence rule is the script's,
never the synthesis's.

**Precedence.** A `conflict` verdict ends on `peer-conflict` first. `converged`
only adds the commit route when the persona's own conditions also hold
(designer's accessibility veto and re-render, founder's gate verdicts).

**Plans.** `/orchestrator:plan` proposes an ADR or other document subtask
that would settle more than two decisions as chained slices of one or two,
each stating what it owns, the ADR number every slice claims and how later
slices amend it, at the cost of one landing round per slice. Advice, not a
`plan-set` rule.

**Known limits.**

- Interactively a verb's last write is terminal and the Stop hook archives the
  workflow; the next verb starts a new workflow with no ledger, so its
  critique is full. Under autopilot one workflow carries the critique-refine
  loop, which is where the loop did not converge.
- `/engineer:commit` commits the tree as it is; it does not check the tree the
  last critique reviewed, for any verb (not a property this rule adds).
- A `/<persona>:start` lifecycle runs critique and refine as skills, not as
  the commands that hold the ledger blocks, so its critique stays full; so
  does every critique on Codex, where the verbs run as skills.
- The ledger is not archived with its workflow and is not pruned.

Implemented in `persona-pipeline/files/scripts/lib/review-scope.mjs` and
`state.mjs` (the four subcommands), the regions `critique-scope-prepare`,
`critique-scope-close`, `refine-scope-record` and `ensemble-scoped-recheck`,
the vendored CommonMark parser (`lib/vendor/commonmark.min.cjs`), and the
orchestrator plan skill's Step 2. The capture now stamps its index
copies with the live index's times, so a same-size edit made in the second the
index was written is not missed (racy git). Tests:
`tests/persona-pipeline/_review-scope-suite.mjs` (real repositories, every
persona, run by one `test-review-scope-<persona>.mjs` each); `scripts/mutation-specs/review-scope.mjs`.

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
