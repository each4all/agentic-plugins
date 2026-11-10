---
description: Run an approved macro unattended — one fresh Claude worker per step, halting at owner judgment (ADR-0063, Claude only; dry-run by default)
argument-hint: "[preview|start [--execute]|status|stop|release <subtask> [--hold <id>|--discard-unreadable]|hold <subtask>|writer-clear <subtask> --operation <id>|instruct <subtask> (--note-file <path> [--next \"<step>\"] [--revises <id>:<revision>]|--withdraw <id>)|events (--macro <id>|--checkout <dir>) --after <run-id>:<seq> [--follow]|retention [--execute]] [--macro <id>] [--models owner-default|mixed|sonnet] [--model <m>] [--effort <e>] [--max-steps <n>] [--max-cost <usd>] [--step-budget <usd>] [--step-timeout <s>] [--stall-detector log|on] [--lanes <n>] [--next \"<step>\"] [--lane <subtask> --next \"<step>\"] [--notify-local] [--json]"
---

# Orchestrator · Autopilot

$ARGUMENTS

`/orchestrator:autopilot` drives an approved macro plan without the owner
relaying commands between sessions
([ADR-0063](../../../docs/adr/0063-autopilot-fresh-session-driver.md)). Each
worker step runs as one command in a fresh `claude -p` worker, the driver decides the
next step from durable state alone, and it **halts** wherever the owner has to
judge. A halt prints the reason, writes `halt.json` in the run's ledger
(`.agentic-plugins/runs/autopilot/<run-id>/`) and exits 2. The driver never
pushes, opens or merges a pull request: landing is the owner's, and after the
merge a relaunch records it and goes on.

**Claude Code only** (ADR-0063 D9). There is no Codex skill for this command;
on Codex the steps stay manual.

This page holds what a session does to preview, start, watch and report a run.
What the run and each subcommand do in detail is in
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-run.md` (the
file shipped with this command text, whatever root the blocks' scripts are
pinned to), keyed on the state: a halt, a `◆ landing-…` line, a lane parked
or held, a `verify` step, `stop`, `release`, `hold`, `writer-clear`,
`instruct`, `status --macro`, the stall detector. Showing or reporting the
CLI's output as printed needs none of it: read a section when the owner asks
what a state means or what resolves it, or before you advise on one.

- `preview` (also a bare invocation) and `start` without `--execute` observe,
  decide and print the worker posture. They spawn nothing.
- `start --execute` runs it. Only the owner starts a run: never start one
  unless the owner asked, and never from inside an autopilot worker (the CLI
  refuses when `AGENTIC_AUTOPILOT` names a run).
- `--lanes N` (2 or more) drives up to N subtasks at once, each in its own git
  worktree beside the repository. Run it from a checkout no one works in.
  Lanes need shared creation on (`docs/runbooks/state-root-cutover.md`);
  `preview --lanes 2` shows the lanes it would reconcile and the first steps. A
  halt in one lane parks that lane only, and the other lanes go on. With more
  than one subtask in progress, `--next` needs `--lane <subtask>` before it
  (one pair per lane).
- `status` reads the latest run's ledger; `status --macro <id>` adds the
  macro's holds and instructions. `stop` ends the run driving a macro and
  cleans up after one whose driver died; it exits 1, printing what is left,
  when it could not finish.
- `release <subtask> --macro <id>` ends that subtask's kept park;
  `--discard-unreadable` ends one whose record cannot be read, keeping a copy.
- `hold <subtask> --macro <id>` holds a lane for a person (ADR-0068 Decision
  2); the person starts once the hold's own line in `status --macro <id>` says
  held. `release <subtask> --macro <id> --hold <hold id>` gives it back: stop
  editing and close the session first.
- `writer-clear <subtask> --macro <id> --operation <operation id>` is the
  owner's word that the session of an operation stopped by an error is gone.
- `instruct <subtask> --macro <id> --note-file <path> [--next "<step>"]` is
  the owner's instruction to a lane (ADR-0068 Decision 7): a note, and at most
  one next step (`/engineer:<verb>` or `/engineer:commit`, never a dispatch),
  applied at the lane's next step boundary. Write the note with your
  file-writing tool into a file in a `mktemp -d` directory and pass its path:
  the note never crosses as a word of the command (ADR-0059), and it is never
  printed. `--revises <id>:<revision>` replaces a pending one, and
  `--withdraw <id>` withdraws it.
- `events --macro <id> --after <run-id>:<seq> [--follow]` prints the run's
  events after that one, one JSON line each, and with `--follow` keeps
  watching, across relaunches: the Monitor recipe below (ADR-0068 Decision 4).
- `retention` shows what the cap on this checkout's old runs would trim (their
  worker streams and verification logs; never `run.json` or the step log,
  and nothing of a run a workflow names) and the temporary directories earlier runs
  left; `retention --execute` trims and removes what nothing uses any more.
  A run's start does both, so the command is for looking, or for a checkout
  no run starts in (ADR-0068, amendment of 2026-11-10).
- Holds, releases, instructions and writer-clear refuse inside an autopilot
  worker. Rolling the orchestrator back below the release that added holds
  while a hold exists is unsupported: a hold on a subtask with no lane has no
  fence an older driver would respect.

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

## preview, status, stop, release, hold, writer-clear, instruct, events, retention, and start without --execute

Run this block when the arguments do not contain `start` together with
`--execute`:

```bash
ARGS_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs" --args-file "$ARGS_DIR/args.json"
```

Show the output as it is. Exit 0: the preview would proceed (or status, stop,
release, hold, writer-clear, instruct, events or retention succeeded). Exit 2: the preview would halt — the reason and its pointer are in
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
   when it ends. Do not poll it: arm the Monitor on its event file instead
   ([Watching a run](#watching-a-run-the-event-file), below), with the
   `<run-id>:0` its `watch:` line printed.
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

## The stall detector

Every step is judged `active`, `stalled` or `unknown` while it runs (ADR-0068
Decision 3). `--stall-detector log`, the default, records the verdicts and
never acts; `--stall-detector on` is the owner's switch, which aborts a
stalled step. The verdict's rule, the observation configuration
(`--stall-detector log --step-timeout 10800`) and what `on` changes are in
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-run.md` § The stall detector.

## Watching a run (the event file)

Every run writes its events to one file per macro,
`.agentic-plugins/runs/autopilot/events/<macro-id>.jsonl` under the main
worktree (a verb chain's is `.agentic-plugins/runs/autopilot/events.jsonl` in
its checkout), and prints at its start the path and the command that watches
it (ADR-0068 Decision 4):

```text
  events <path>
  watch: agentic-autopilot events --macro <id> --after <run-id>:0 --follow
```

Each line is one JSON object of machine data: the run's start, a run-wide
halt, a lane parked or picked up again, held or released, a step that failed,
a commit step that finished, and the run's end, `run-ended`, the only line
with `"terminal": true`. No line carries what a worker, a peer or a person
wrote: each points at the record that holds the rest (`run.json`,
`steps.jsonl`, `lanes.jsonl`, a kept park, the landing log, and `halt.json`
from the `run-ended` of a run that halted; the reader prints a pointer null
when its checkout is no longer one of the repository's). A relaunch writes to
the same file. The reader adds lines of its own, each with `cursor`, the identity of the
last event it passed on: `reader-armed` at each arm (the latest run, live or
ended, its last `seq`, its failed writes); `reader-gap` (a `seq` missing, a
hint); `reader-skipped` (a line that does not parse, or is no line the writer
could have written: its offset only, never its content); `reader-terminal-missing`
(a run that ended or died with no `run-ended` on file: read its `run.json`, or
`status`); `reader-summary` (`stall` lines folded past a burst); and
`reader-error`, after which it exits 1 (the file cannot be read, was truncated
or replaced, or the cursor names no line).

Once the start block runs, arm the host's Monitor on the run, so the session
hears each event as it happens:

1. Create a new args directory, and `args.json` in it, as the two steps
   before the first block of this page say (the private directory, then the
   file), with `text` set to
   `events --macro <id> --after <run-id>:0 --follow`, the macro and the
   `<run-id>:0` the run printed (for a verb chain, `--checkout <dir>` in place
   of `--macro <id>`). The CLI removes the directory once it has read it:
   every arm, and every re-arm below, takes a new one.
2. Run the block below with Monitor, `timeout_ms` 1800000 (its maximum,
   30 minutes). Its `2>&1` hands the session what the CLI prints on stderr
   too: an args file it cannot read, or an `--after` it refuses, ends it
   before the reader starts, with no reader line.

```bash
ARGS_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs" --args-file "$ARGS_DIR/args.json" 2>&1
```

3. The reader is the filter: add none. A session that narrows it anyway
   keeps every line the pattern below matches, so no run's end and no word
   of the reader's own is dropped. It pipes the block's output through this
   filter, as written (an extended pattern, and each line passed on as it
   comes, not when the reader exits):

```text
grep -E --line-buffered '"terminal":true|"kind":"reader-'
```

4. When the Monitor expires, or stops early for any cause other than a
   `reader-error`, re-arm it with the cursor of the last line it received:
   an event's `<run_id>:<seq>`, or a reader line's `cursor`; with none
   received, the `<run-id>:0` the run printed. Each re-arm is steps 1 and 2
   again, with a new args directory. An exit 1 with no reader line (the CLI
   refused before the reader started: what it printed says why) counts as a
   `reader-error`: never re-arm the same arguments. A re-arm neither repeats nor skips an event, across a relaunch
   too, and keeps watching every run with a line on file whose `run-ended`
   is not there, before the cursor too: such a run is reported
   (`reader-terminal-missing`) at each arm until its end is on file, so drop
   one already handled by its `run_id`. After a `reader-error` (the reader
   exits 1), never re-arm from its `cursor`, which fails the same way: re-arm
   once with `--after <run-id>:0` for every run of the macro not seen end, as
   step 5 does, dropping what was already handled; when that ends in a
   `reader-error` too, stop re-arming and report it to the owner.
5. After a restart of the session (its cursor lost), re-arm with
   `--after <run-id>:0` for every run of the macro not seen end (`--after`
   repeats), and drop by `run_id` and `seq` the events already handled.

Stop the Monitor once the run's `run-ended` has arrived and its task has
ended. The event file is a signal beside the run's records: a write that
fails is printed and counted in `run.json`, never stops the run, and is
reported by the reader as a run missing its end.
