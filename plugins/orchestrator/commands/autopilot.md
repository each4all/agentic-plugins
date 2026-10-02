---
description: Run an approved macro unattended — one fresh Claude worker per step, halting at owner judgment (ADR-0063, Claude only; dry-run by default)
argument-hint: "[preview|start [--execute]|status|stop] [--macro <id>] [--models owner-default|mixed|sonnet] [--model <m>] [--effort <e>] [--max-steps <n>] [--max-cost <usd>] [--step-budget <usd>] [--step-timeout <s>] [--max-time <s>] [--next \"<step>\"] [--notify-local] [--json]"
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
notification (`--notify-local` adds one local macOS notification).

The driver never pushes, opens or merges a pull request. Landing is the
owner's: at an `awaiting-landing` halt it lists each branch with the push and
pull-request commands; after the merge, relaunch, and it records the landing
with `/orchestrator:done` and goes on (ADR-0062, D3a).

**Claude Code only** (ADR-0063 D9). There is no Codex skill for this command;
on Codex the steps stay manual.

- `preview` (also a bare invocation) and `start` without `--execute` observe,
  decide and print the worker posture. They spawn nothing.
- `start --execute` runs it. Only the owner starts a run: never start one
  unless the owner asked, and never from inside an autopilot worker (the CLI
  refuses when `AGENTIC_AUTOPILOT` names a run).
- `status` reads the latest run's ledger; `stop` sends SIGTERM to the run
  driving a macro, which records an `interrupted` halt. When that run's driver
  has died, `stop` ends the worker's processes itself, and no halt is recorded.

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

## preview, status, stop, and start without --execute

Run this block when the arguments do not contain `start` together with
`--execute`:

```bash
ARGS_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs" --args-file "$ARGS_DIR/args.json"
```

Show the output as it is. Exit 0: the preview would proceed (or status/stop
succeeded). Exit 2: the preview would halt — the reason and its pointer are in
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
   Unless the arguments name `--max-time`, leave `MAX_TIME=7000` in the block,
   so the run ends with a recorded `budget` halt before the host stops it; a
   relaunch continues where it stopped. When the owner wants one run longer
   than that, it belongs in a terminal: `preview` prints the command that
   installs the `agentic-autopilot` launcher, and then
   `~/.agentic-plugins/bin/agentic-autopilot start --execute --repo <repo> --models <plan>`.
3. Run the block **as a host background task** — on Claude, the Bash tool's
   `run_in_background`, with its longest timeout (7200000 ms) — never with a
   trailing `&`, so the session is told when the run ends:

```bash
ARGS_DIR='<directory from step 1>'
MODELS=''
MAX_TIME='7000'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
EXTRA=()
[ -n "$MODELS" ] && EXTRA+=(--models "$MODELS")
[ -n "$MAX_TIME" ] && EXTRA+=(--max-time "$MAX_TIME")
node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs" --args-file "$ARGS_DIR/args.json" "${EXTRA[@]}"
```

4. Tell the owner the run started: its id and ledger path (the first lines of
   the task's output), that `/orchestrator:autopilot status` shows progress and
   `/orchestrator:autopilot stop` stops it, and that the session is notified
   when it ends. Do not poll it.
5. When the task ends, read its output and report, without adding to it:
   - exit 0 — the macro completed (it is archived);
   - exit 2 — the halt: its reason, detail and pointer, and for
     `awaiting-landing` each branch with its push and pull-request commands;
     then the resume hints it printed (`claude --resume <session>` to inspect
     the last step, and the relaunch command);
   - exit 1 — the start condition or error it printed.

Do not resolve a halt yourself. Each one names what the owner decides; the
relaunch continues from the state that decision leaves.
