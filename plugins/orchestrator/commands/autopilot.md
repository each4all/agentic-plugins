---
description: Run an approved macro unattended — one fresh Claude worker per step, halting at owner judgment (ADR-0063, Claude only; dry-run by default)
argument-hint: "[preview|start [--execute]|status|stop|release <subtask> [--hold <id>|--discard-unreadable]|hold <subtask>|writer-clear <subtask> --operation <id>] [--macro <id>] [--models owner-default|mixed|sonnet] [--model <m>] [--effort <e>] [--max-steps <n>] [--max-cost <usd>] [--step-budget <usd>] [--step-timeout <s>] [--lanes <n>] [--next \"<step>\"] [--lane <subtask> --next \"<step>\"] [--notify-local] [--json]"
---

# Orchestrator · Autopilot

$ARGUMENTS

`/orchestrator:autopilot` drives an approved macro plan without the owner
relaying commands between sessions
([ADR-0063](../../../docs/adr/0063-autopilot-fresh-session-driver.md)). Each
step — `/orchestrator:next`, `/engineer:<verb>`, `/engineer:commit`,
`/orchestrator:done`, `/orchestrator:finalize` — runs as one command in a fresh
`claude -p` worker, so every step starts from durable state and no context
carries over. The driver decides the next step from that state alone (closed
enums: `next_step`, `awaiting_owner`, `plan_approval`, next-ready, the landing
check) and **halts** wherever the owner has to judge: a plan that is not
approved, an owner gate, a next step below HIGH confidence, a subtask waiting
for its pull request to merge (`awaiting-landing`), a step that changed
nothing. A halt prints the reason, writes `halt.json` in the run's ledger
(`.agentic-plugins/runs/autopilot/<run-id>/`) and exits 2; there is no plugin
notification (`--notify-local` adds one local macOS notification). A halt on
a conflict gate (`decide-conflict`, `peer-conflict`, or `plan-conflict` under
`plan-unapproved`) carries its proposal in `halt.json`'s `proposals`: the
bounded consensus round to run before the owner decides, with its task file
(ADR-0067 Decision 8). The driver never runs it.

The driver never pushes, opens or merges a pull request. Landing is the
owner's. Once a subtask is committed, the run reports it and goes on with any
other ready subtask (ADR-0067 Decision 7): a `◆ landing-ready` line (or one
of the two below), a record
in the run's ledger, and a line appended to
`.agentic-plugins/runs/autopilot/landing/<macro-id>.jsonl` under the main
worktree, which a watcher can tail across relaunches. Each names the branch,
its commit, the push and pull-request commands, a read-only overlap check
(`git merge-tree`) against the integration branch and every other branch
waiting to land, and an advisory merge order. The check runs in a scratch
repository that borrows only the objects, so no merge driver, config or
attribute of the checkout applies: its answer is git's own merge of the two
commits. Each also says whether the branch is ready to land: only when it
contains the integration branch's tip as the run fetched it, so the CI its push
runs checks the tree that lands. A branch behind it, another lane's landing for
instance, is reported `◆ landing-sync` with the commands that merge the tip in
and push; one whose freshness could not be told (a failed fetch, a shallow
clone) is `◆ landing-unknown`, and neither is ready. Every record keeps the
event name `landing-ready`: read its `ready` field to tell. A branch is reported
again when its commit, the tip or its readiness changes, not while what it
reports stays the latest record, and a commit that no run reported is reported
when the next run starts. However a run with lanes ends, it lists each lane
still waiting with its readiness in its lane report and in `status`:
`unknown` when its last look failed or could not read it, or when the run ended
without that look (interrupted, or stopped by an error). A serial run's halt
lists each waiting branch the same way, whatever its reason, and an
`awaiting-landing` halt does too: what waits as the run ended, so a branch that
landed meanwhile is not listed. After the merge, relaunch, and it records the
landing with `/orchestrator:done` and goes on (ADR-0062, D3a).

**Lanes.** With `--lanes N` (2 or more; the owner's default is 2, and a larger N
spends the rate limit faster) the run drives up to N subtasks at once, each in
its own git worktree beside the repository, with `/orchestrator:done` and
`/orchestrator:finalize` in the checkout the run starts from (ADR-0067
Decision 6). Run it from a checkout no one works in: work there halts the run
at its next done. A new lane waits while the rate limit's five-hour window is
at 0.85 or more, or refused. A halt in one lane (its gate, a judgment, a step
or a creation of that lane that failed) **parks that lane only** (ADR-0068
Decision 1): it starts nothing more, and the other lanes go on. The park is
kept in the macro's records (`.agentic-plugins/runs/autopilot/holds/<macro-id>/parks/`),
so a relaunch parks the lane again at once while its record is unchanged, and a
step that wrote nothing is never retried on that record. The lane is picked up
again, within about a minute while the run lives or at the next relaunch, once
its record changes (the owner clears its gate, records a next step, settles a
pending peer ensemble, commits or moves its branch) or once the owner releases
it with `release <subtask> --macro <id>`, with or without a live run; its lane
is reconciled again first, as at a run's start. A lane the owner holds, or
whose release was rejected, is not picked up by a change of its record: its
`release --hold`, or a new hold and release, gives it back. No worker spawns into a lane
while a persona operation is open there (ADR-0068 Decision 2, item 7): the
child's operation entries and the macro's operation records, read fresh, so a
gate resolution (its clear, then its next step) finishes first, however long
it writes nothing. A run-wide halt (version drift, an
exhausted budget, a plan change that revokes the approval, a gate on the macro,
a halt that names no lane, the baseline or the rollback fence, the driver's
own done or finalize, a worker group that outlived SIGKILL) lets the steps in
flight finish, then reports every lane and exits 2. The run also ends, exit 2,
once nothing runs and nothing can start: every remaining lane parked, held,
waiting to land, or behind one of those; `halt.json` names the first lane
still parked (after a run-wide halt), or the first held lane when only held
lanes are left, lists the others under `also`, and gives each lane's state
and what resolves it (a held lane's release command), and `status` shows each
parked lane's reason and since when. A release after the run has ended starts
nothing: relaunch. A serial run does not start beside a kept park: release
it, or run with lanes. Ctrl-C, `stop` or a closed terminal
(SIGINT, SIGTERM, SIGHUP) ends it at once instead: a lane's creation or removal,
or a peer run's cancellation, already under way gets 15 s to finish, the workers
and everything else in flight are stopped, and the lanes are kept for the next
run. With more than one subtask in progress,
`--next` needs `--lane <subtask>` before it (one pair per lane). Lanes need
shared creation on (`docs/runbooks/state-root-cutover.md`); `preview --lanes 2`
shows the lanes it would reconcile and the first steps. A halt prints the
relaunch command with the run's `--macro` and `--lanes`.

**Claude Code only** (ADR-0063 D9). There is no Codex skill for this command;
on Codex the steps stay manual.

- `preview` (also a bare invocation) and `start` without `--execute` observe,
  decide and print the worker posture. They spawn nothing.
- `start --execute` runs it. Only the owner starts a run: never start one
  unless the owner asked, and never from inside an autopilot worker (the CLI
  refuses when `AGENTIC_AUTOPILOT` names a run).
- `status` reads the latest run's ledger; `stop` sends SIGTERM to the run
  driving a macro, which records an `interrupted` halt. When that run's driver
  has died, `stop` ends the worker's processes itself, then cleans up after the
  run (ADR-0067 Decision 6): it cancels the pending peer runs that name it,
  counts its unfinished step as spent, and records the `interrupted` halt. The
  next run of the macro does the same before its first step. What it cannot
  finish (a peer it could not cancel, a peer-run home it could not read, a
  ledger that is gone) it prints, keeps, and makes `stop` exit 1, as does a
  run any part of which still runs.
- `release <subtask> --macro <id>` ends that subtask's kept park (ADR-0068
  Decision 1, item 4): a live run picks the lane up at its next tick, the next
  run judges it afresh. It refuses inside an autopilot worker, a subtask with
  no kept park, and a step a live run has under way. A park whose cause lies
  outside the lane's record (another worktree holds its branch, another session
  holds its lock) waits for this release. A park whose record cannot be read
  is never deleted by it: `release <subtask> --macro <id> --discard-unreadable`
  keeps a copy and ends it. It refuses on a held lane, and on a lane whose
  release the driver has not compared yet or rejected.
- `hold <subtask> --macro <id>` holds a lane for a person (ADR-0068 Decision
  2): the driver leaves the subtask alone (no dispatch, adoption,
  reconciliation, step or removal) while other lanes go on. The hold is
  *pending* until nothing of the lane is in flight and no persona operation is
  open there, then *held*, its lane fenced in its worktree lock; start once
  the hold's own line in `status --macro <id>` says held (the run's lane table
  shows the lane held from the moment the hold is set). Work the lane's active
  child: the engineer refuses to begin an unlinked workflow in a held lane. A
  step already running is never aborted:
  it runs to its end first. `hold` prints the hold id, the lane, its last
  session (`claude --resume <id>`) and the engineer the person needs. It refuses
  beside a live run that does not honour holds (a serial run: `stop` it), a
  completed subtask, an owner record it cannot read, and until the hold-aware engineer
  is installed on both hosts and pinned by the launcher.
- `release <subtask> --macro <id> --hold <hold id>` gives a held lane back:
  it refuses while a persona operation is open there, a peer ensemble is
  pending or the child's workflow is locked. Stop editing and close the
  session first: the driver compares the lane once before it steps, and an
  edit after the release still there at the comparison rejects it (the lane
  parks until a new hold and release); one after the comparison is not seen.
  A pending hold is
  withdrawn, with nothing to compare.
- `writer-clear <subtask> --macro <id> --operation <operation id>` is the
  owner's word that the session of an operation stopped by an error is gone:
  the operation no longer keeps the lane.
- `status --macro <id>` adds the macro's holds, from any checkout, with or
  without a run, with each hold's state, what blocks its handoff, its open
  operations and the release command; with no live run it completes a pending
  handoff and repairs a fence an older orchestrator removed.
- Holds, releases and writer-clear refuse inside an autopilot worker. Rolling
  the orchestrator back below the release that added holds while a hold
  exists is unsupported: a hold on a subtask with no lane has no fence an
  older driver would respect.

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call. When the repository the run
drives is the checkout these scripts come from (a directory marketplace),
`start --execute` refuses: a step switches that checkout's branch. Pin
`AGENTIC_ORCHESTRATOR_ROOT`, `AGENTIC_ENGINEER_ROOT` and `AGENTIC_RUNTIME_ROOT`
to an install or a snapshot worktree first.

The arguments above reach the CLI through an args file, never through the
shell (ADR-0059): typed text spliced into a command line is cut at `;`,
expanded at `$(…)` and redirected at `>`, and the damage can exit zero.
Before each block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

The CLI reads the text as shell-style words and expands nothing: quote a value
that holds spaces (`--next "/engineer:refine"`), and quote `;` `&` `|` `<` `>`
`(` `)`, a backquote, a `$` expansion, or a word-initial `#` or `~` to pass it
as text. It removes the args file and its directory once it has read them.

---

## preview, status, stop, release, hold, writer-clear, and start without --execute

Run this block when the arguments do not contain `start` together with
`--execute`:

```bash
ARGS_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs" --args-file "$ARGS_DIR/args.json"
```

Show the output as it is. Exit 0: the preview would proceed (or status, stop,
release, hold or writer-clear succeeded). Exit 2: the preview would halt — the reason and its pointer are in
the output. Exit 1: an error or a start condition that fails; the output names
it.

## start --execute

1. **Model plan (owner decision D5: asked before each start).** When the
   arguments name none of `--models`, `--model` or `--effort`, ask the owner
   which model plan this run's workers use — with the host's question tool
   when the session has one — and set `MODELS` in the block below to the
   answer:
   - `owner-default` — every step on the owner's Claude Code default model and
     effort;
   - `mixed` — decide, critique, investigate and frame on the owner's default;
     compose and refine on sonnet/medium; commit, done and finalize on
     sonnet/low;
   - `sonnet` — every step on sonnet/medium.

   When the arguments already name one of them, leave `MODELS` empty.
2. **The two-hour limit.** A host background task is stopped after two hours.
   The run has no clock of its own: its steps, its cost, each step's timeout,
   a halt or `stop` end it (ADR-0063 D1, amendment of 2026-10-13). Do not
   count on a host stop to end it cleanly: it may leave no halt record and no
   exit 2, and the workers, which run detached, may still be at work. After a
   host stop, run `/orchestrator:autopilot status`; when it shows the run or
   its worker groups still there, run `/orchestrator:autopilot stop`, which
   ends them and cleans up after the run; then relaunch, which continues where
   the state says. A run that may take longer than two hours belongs in a
   terminal: `preview` prints the command that installs the
   `agentic-autopilot` launcher, and then
   `~/.agentic-plugins/bin/agentic-autopilot start --execute --repo <repo> --models <plan>`.
3. Run the block **as a host background task** — on Claude, the Bash tool's
   `run_in_background`, with its longest timeout (7200000 ms) — never with a
   trailing `&`, so the session is told when the run ends:

```bash
ARGS_DIR='<directory from step 1>'
MODELS=''
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
EXTRA=()
[ -n "$MODELS" ] && EXTRA+=(--models "$MODELS")
node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs" --args-file "$ARGS_DIR/args.json" "${EXTRA[@]}"
```

4. Tell the owner the run started: its id and ledger path (the first lines of
   the task's output), that `/orchestrator:autopilot status` shows progress and
   `/orchestrator:autopilot stop` stops it, and that the session is notified
   when it ends. Do not poll it.
5. When the task ends, read its output and report, without adding to it:
   - exit 0 — the macro completed (it is archived);
   - exit 2 — the halt: its reason, detail and pointer, and each branch it
     lists waiting to land (an `awaiting-landing` halt, and a serial run's
     halt for any reason) with its commit, its readiness and sync commands,
     overlap, and push and pull-request commands, and the merge order;
     then the resume hints it printed (`claude --resume <session>` to inspect
     the last step, and the relaunch command);
   - exit 1 — the start condition or error it printed.

Do not resolve a halt yourself. Each one names what the owner decides; the
relaunch continues from the state that decision leaves.
