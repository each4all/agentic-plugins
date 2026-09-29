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
| R2 | At a genuine judgment point the run **halts**, and reports it: terminal + `halt.json` + exit code 2. It does not keep other subtasks running. With parallel lanes (W2, 2026-09-25) the halt **drains**: in-flight steps finish, and then everything stops. A subtask that waits for its PR to land is not a judgment point (D3a). |
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
- **Worktree lanes (W1; the exact scope waits on W4 and W8).** S1 is meant to
  cover, for the macro being driven, creating and removing lane worktrees
  (`git worktree add/remove/prune`) under `<parent>/<repo>-lanes/<macro-id>/`.
  - Never on the owner's checkout, never a push.
  - The runtime executor guard still forbids these for runtime; the
    orchestrator adapter performs them.
  - Interactive phase 2 adds owner-invoked background lane sessions
    (`claude --bg`, launched by `/orchestrator:next --parallel`).
  - The 2026-09-25 draft also authorized a driver merge into a local
    `integration/<macro-id>` branch. That clause is **held**: under ADR-0062 and
    D3a a local merge completes nothing. The lanes track re-asks W4 (how results
    integrate) before it starts, and amends this clause then.

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
| `/orchestrator:next` | macro approved, a subtask is ready, no active engineer child | dispatch + the subtask's first verb in the same process (ADR-0019 §1 requires the exports + Phase 0 + Phase 4 in one process) |
| `/engineer:<verb>` | active engineer child with `next_step.kind=verb`, `confidence=HIGH` | reattaches (append-on-resume) |
| `/engineer:commit` | `next_step.kind ∈ {commit, done}`, `confidence=HIGH` | New verb-chain commit surface (Q1, D2; plugin change spec §1.8). `done` routes here too: with nothing staged it archives the workflow instead of committing (the no-changes close). It lands together with "autopilot verbs skip `set-terminal`". |
| `/orchestrator:done <id>` | a committed subtask whose PR has merged (`state.mjs resolve-landing` ok), or `--no-commit` after a no-changes close | records completion (ADR-0062); successors unblock (D3a) |
| `/orchestrator:finalize` | every subtask `completed` (none deferred/abandoned) | terminal close |

The verb is the atomic durable unit. `/engineer:start` keeps direction
approval, the exploration map and the plan only in conversation, so it is
**out of scope**: autopilot runs macros whose subtasks are verb-chains. The
driver is stateless across runs. It re-derives everything from durable state
each iteration, so re-launching after a halt continues.

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
1. The observer yields exactly one command from the D3 step table. It comes from
   an entry-brief `disposition=lead` with an allowlisted command, or from
   engineer `next_step`, or from next-ready.
2. No `awaiting_owner` is set on the macro or on the active engineer workflow.
3. `plan_approval.status=approved` and `plan_approval.plan_hash` matches the
   current `subtasks[]`.
4. For `/orchestrator:next` only: the working tree is clean.
5. The state fingerprint changed since the previous step. The first iteration is
   exempt.
6. Budgets remain: iterations, total cost, wall clock.

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
| `step-oversized` | the step's peak context exceeds the oversize threshold (D7) |
| `budget` | iteration, cost or time cap reached |
| `version-drift` | installed plugin versions changed since the run started |
| `interrupted` | SIGINT/SIGTERM from the owner |

**`awaiting_owner.gate`** is a closed enum of genuine-judgment gates only:
`plan-approval`, `plan-conflict`, `scope-routing`, `decide-conflict`,
`recurring-finding`, `staging-set`, `pr-handling`, `duplicate-workflow`, `merge-conflict` (lanes; stored on the macro, see `design/worktree-parallel.md` §4.3). The
source of each gate is mapped in DESIGN §6.3.

**Ceremony gates** auto-pass while `AGENTIC_AUTOPILOT` is set:
- **Commit subject confirmation:** a conventional subject is inferred from verb, profile and package.
- **"Recommended: X. Proceed?":** proceed with X.
- **Presentation-mode prompt:** batch.
- **critique → refine MINOR selection:** the existing default rule, CRITICAL + MAJOR.
- **End-of-verb Active Next-Action Proposal:** persisted as `next_step`; the driver decides from it.

The same gates stay interactive when a human drives.

**`decide` (R4):**
- ensemble verdict CONFLICT → `awaiting_owner.gate=decide-conflict` → halt;
- `next_step.confidence < HIGH` → halt (`low-confidence`);
- otherwise proceed with the recommended direction.

**Lanes (W2).** Any lane halt drains the run: no new lane or step starts,
in-flight steps finish, then every lane reports once. SIGINT/SIGTERM aborts
without draining.

### D5. Worker contract

**Spawn.** An argv array, never a shell string. cwd is the repo root, and stdin
is a pipe:

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
5. The worker's own `Stop` hooks archive the engineer workflow and send its
   terminal note to the macro (probe E8). Since ADR-0062 that note no longer
   completes the subtask (D3a).

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

### D6. State contract additions (host-neutral core)

- **`next_step` (engineer workflow).** Written at verb State finalize.
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
- **Guards.**
  - `step-oversized`: halt after the step if the peak exceeds 25% of the window
    (configurable). The step or verb should be split.
  - `compaction-imminent`: a PreCompact event aborts the step immediately.
    Compaction never happens inside autopilot (R1).
- **Scope.** The sensor is scoped to the driver's worker streams. It does not
  change ADR-0031 §7 for the runtime footer. Feeding a measured risk into
  runtime is out of scope.

### D8. Ledger and halt signal

Everything lives under `<repo>/.agentic-plugins/runs/autopilot/<run-id>/`:
- `run.json`: config, pinned plugin versions, git baseline, start/end, final status.
- `steps.jsonl`: one line per step with:
  - seq, command, session_id, timings, exit, is_error;
  - cost, peak_ctx, peak_pct, permission_denials;
  - fingerprint_before / fingerprint_after, outcome.
- `worker-<seq>.jsonl`: the raw stream, pointer-referenced only, with bounded
  retention.
- `halt.json`: reason code, pointers to the blocking file + field, resume hint.

Other rules:
- **Lock.** One run per macro: `<main>/.agentic-plugins/runs/autopilot/locks/<macro-id>.lock`,
  with a pid + start-time fingerprint. The serial prototype keeps a per-repo
  `.lock`.
- **Resume a halted step interactively:** `claude --resume <session_id>`.
- **Halt signal:** terminal output + `halt.json` + exit code 2. There is no plugin
  notification: the notification feature is removed ([ADR-0064](0064-runtime-surface-reduction.md), proposed alongside).
  The optional driver-local `--notify-local` shows one macOS notification through
  `osascript`, with a fixed script, the payload as argv, and no egress (Q5 resolved).
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
