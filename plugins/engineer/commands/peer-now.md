---
description: Ad-hoc peer consultation — dispatch a verbatim prompt to the cross-host companion (claude or codex) outside a verb's normal ensemble flow
argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)
---

# Engineer · Peer-Now (ad-hoc consultation)

$ARGUMENTS

`/engineer:peer-now` is a meta command per ADR-0017 §sub-decision-3:
a side-channel wrapper over `peer-runner.mjs run --kind peer-now`
that fires a verbatim prompt at the cross-host peer companion
(`claude` or `codex`) without opening a full ensemble dispatch via
one of the six verbs. The peer's response is appended to the active
workflow's body under a `[Peer]` label phase note when a workflow
exists; otherwise the response is printed to stdout and the command
exits.

This command is a deliberate side-channel: it does NOT update
`current_phase`, `next_action`, `latest_checkpoint`, or the
`ensemble_results` frontmatter list. peer-now is excluded from
`ensemble_results` by design — that field is reserved for verb-skill
structured ensemble verdicts. The exclusion is structural: opting a
dispatch INTO `ensemble_results` requires the managed ensemble
bookkeeping flags (`--workflow-path / --phase / --ensemble-type /
--run-id`), and peer-now deliberately omits the workflow bookkeeping
flags even though it now has an operational `run_id`. See
`core/skills/peer-now/SKILL.md` § Phase 1 for the cognitive framing
(why peer-now is a raw cross-host probe, not a synthesis).

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/peer-now/SKILL.md`** per ADR-0022
(meta-skill category, ADR-0010 §3 cascade). This command file owns
the Claude-host bash bootstrap and the `peer-runner.mjs` /
`state.mjs` invocations below; for each Phase 0–2 the cognitive
description, peer-prompt phrasing guidance, host-availability matrix,
and status/cancel controls delegate to SKILL.md via the matching
`§ Phase N` pointer.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

---

## Phase 0 — Argument parsing

Parse `$ARGUMENTS` for these flags:

- `--peer claude|codex` — REQUIRED. The peer host whose companion
  should run the prompt.
- `--prompt-text "..."` OR `--prompt-file <path>` — REQUIRED (one,
  not both). The verbatim prompt to forward.

Reject with a one-line usage hint and stop on:

- `--peer` missing or its value not in `{claude, codex}`.
- Neither `--prompt-text` nor `--prompt-file` provided, OR both.
- `--prompt-file` path that does not exist or is not readable.

---

## Phase 1 — Dispatch verbatim with operational tracking

`peer-runner.mjs` supervises the companion process and writes a
hidden repo-local ledger under
`.agentic-plugins/state/engineer/peer-runs/<run_id>/` for new repos
(legacy `.claude/agentic-engineer/peer-runs/<run_id>/` remains active
until explicit migration). With
`--kind peer-now`, it does NOT touch `pending_ensemble` or
`ensemble_results` — it just tracks the side-channel process and
surfaces the response path. Use `--output-format text` so the raw
companion stdout remains verbatim in `stdout.log`.

<!-- pipeline:begin peer-now-dispatch -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUN_ID="peer-now-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
RUN_JSON="$(mktemp -t 'engineer'-peer-now.XXXXXX).json"
RUN_ERR="$(mktemp -t 'engineer'-peer-now.XXXXXX).err"
echo "peer-now run_id=$RUN_ID" >&2
# $PEER from --peer; $PROMPT_ARG is --prompt-text "<text>" or --prompt-file <path>
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --kind peer-now \
  --peer "$PEER" $PROMPT_ARG --output-format text \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?
STDOUT_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stdout_path)||"")}catch{}' "$RUN_JSON")"
STDERR_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stderr_path)||"")}catch{}' "$RUN_JSON")"
HANDLE_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).handle_path)||"")}catch{}' "$RUN_JSON")"
ERROR_KIND="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error_kind)||"")}catch{}' "$RUN_JSON")"
```
<!-- pipeline:end peer-now-dispatch -->

Exit-code semantics (per `companions/contract.md` §5.1):

- 0 — success, peer response in `$STDOUT_PATH`
- 1 — peer_run_error (companion ran but peer signaled failure)
- 2 — companion_misuse (bad CLI args; this command's bug)
- 3 — peer CLI infrastructure failure (companion not found)

While the run is active, another local host/session can inspect or
cancel it:

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" status \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --json
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" cancel \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID"
```

On `RUN_RC != 0`, surface the first line from `$RUN_ERR`, then
`$STDERR_PATH`, then `$ERROR_KIND` as fallback, plus exit code + run
id. Stop without appending a phase note and exit non-zero from this
command too.

---

## Phase 2 — Optional `[Peer]` label injection

Locate the active workflow:

<!-- pipeline:begin peer-now-locate -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT" 2>/tmp/'engineer'-peer-now-find.err)"
FIND_RC=$?
```
<!-- pipeline:end peer-now-locate -->

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Standalone case:
  print the response from `$STDOUT_PATH` to stdout and skip the
  state mutation step.
- **Exit 0, single path** → append a `[Peer]` label phase note to
  that workflow's body with the block below. Do NOT pass
  `--current-phase` or `--next-action` — peer-now does not advance
  phase.
- **Exit 1, per-branch duplicate error** → reject with a hint
  pointing at `/engineer:resume` (peer-now must not pick a workflow
  itself — per-branch duplicate is a user-resolvable invariant
  violation per ADR-0018 §sub-2 cascade of ADR-0011 §1).

<!-- pipeline:begin peer-now-note -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "[Peer] $PEER consultation" \
  --phase-note "peer: $PEER
run_id: $RUN_ID
handle: $HANDLE_PATH
prompt-mode: verbatim

### Response

$(head -c 4000 "$STDOUT_PATH")" \
  --event updated
```
<!-- pipeline:end peer-now-note -->

The 4000-char cap on the appended response keeps a single
consultation from blowing the workflow body out; the full
`$STDOUT_PATH` is also printed to the user separately.

---

## Completion

Emit one of:

- `✓ Peer consultation recorded under [Peer] $PEER consultation in <workflow path> (run_id=<id>).`
  (followed by the response printed beneath).
- `✓ Peer consultation completed (standalone — no active workflow, run_id=<id>).`
  (when no active workflow exists; the response is printed beneath).
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <first stderr line>.` — Phase 1
  failed.
- `✗ <usage hint from Phase 0>.` — argument parsing rejected.
- `✗ Per-branch duplicate detected — resolve via /engineer:resume.` —
  Phase 2 found more than one workflow file on the current branch
  (ADR-0018 §sub-2 violation: corruption / external mutation).

The peer's response is printed verbatim from `$STDOUT_PATH`, with no
synthesis label injection or AGREED/PEER-ONLY/CONFLICT structuring.
That structuring is a verb-level concern (compose / critique / decide
/ …) carried by the ensemble dispatch contract; peer-now is meant for
casual cross-host probes where the user wants the raw answer.
