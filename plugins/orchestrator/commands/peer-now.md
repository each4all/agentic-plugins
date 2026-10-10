---
description: Ad-hoc peer consultation for a macro workflow — dispatch a verbatim prompt to claude or codex outside Plan-verify
argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)
---

# Orchestrator · Peer-Now

$ARGUMENTS

`/orchestrator:peer-now` is a side-channel meta command. It dispatches
a verbatim prompt through `scripts/peer-runner.mjs run --kind
peer-now` and records a `[Peer]` phase note on the active macro
workflow when one exists. It is not Plan-verify and it never writes
`pending_ensemble` or `ensemble_results`.
The workflow and peer-run namespace is `.agentic-plugins/state/orchestrator/`
for new repos; legacy `.claude/agentic-orchestrator/` state remains active
until explicit migration.

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/peer-now/SKILL.md`**. The skill contains
the host-availability matrix, prompt guidance, and status/cancel
controls.

---

## Phase 0 — Argument parsing

Required:

- `--peer claude|codex`
- Exactly one of `--prompt-text "..."` or `--prompt-file <path>`

Reject missing peer, invalid peer, both prompt forms, no prompt form,
or unreadable prompt file. Do not self-dispatch.

The prompt reaches the runner as a file, never as shell source (ADR-0059,
amendment of 2026-10-10): a prompt or a path spliced into a block is cut at
`;`, expanded at `$(…)` and run at a backtick.

1. Create a private directory, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool (Claude: the Write tool), not the shell, write
   one file in that directory: for `--prompt-text`, `prompt.xml` holding the
   prompt exactly as given; for `--prompt-file <path>`, `prompt-path.txt`
   holding that path, as given, on one line. The runner then reads the
   prompt from the user's file itself, byte for byte.

Phase 1's block reads it from there: put the path in its `TEXT_DIR` line, and
`claude` or `codex` in its `PEER` line. Nothing deletes the files (a headless
run can deny `rm`).

---

## Phase 1 — Dispatch with operational tracking

```bash
TEXT_DIR='<directory from step 1>'
PEER='<claude|codex>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# The prompt: the file prompt-path.txt names (--prompt-file), read by the
# runner, or the prompt.xml written for --prompt-text. The path is data cat
# read, never shell source.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
if [ -f "$TEXT_DIR/prompt-path.txt" ]; then PROMPT_FILE="$(cat "$TEXT_DIR/prompt-path.txt")"; fi
[ -s "$PROMPT_FILE" ] || { echo "✗ The prompt file ($PROMPT_FILE) is missing or empty; nothing was dispatched." >&2; exit 1; }
RUN_ID="peer-now-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
RUN_JSON="$(mktemp -t orchestrator-peer-now.XXXXXX).json"
RUN_ERR="$(mktemp -t orchestrator-peer-now.XXXXXX).err"

node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" --prompt-file "$PROMPT_FILE" \
  --output-format text \
  --host "${AGENTIC_HOST:-claude}" \
  --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?

STDOUT_PATH="$(jq -r '.stdout_path // empty' "$RUN_JSON" 2>/dev/null)"
STDERR_PATH="$(jq -r '.stderr_path // empty' "$RUN_JSON" 2>/dev/null)"
HANDLE_PATH="$(jq -r '.handle_path // empty' "$RUN_JSON" 2>/dev/null)"
ERROR_KIND="$(jq -r '.error_kind // empty' "$RUN_JSON" 2>/dev/null)"
```

Status/cancel controls:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" status \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --json
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" cancel \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID"
```

On non-zero exit, surface the first useful stderr/error line, include
`run_id`, and stop without mutating workflow state.

---

## Phase 2 — Optional `[Peer]` macro note

Locate the active macro:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/orchestrator-peer-now-find.err)"
FIND_RC=$?
```

- **No active macro** -> print the peer response only.
- **Single active macro** -> append a phase note without changing
  phase or next action:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  # The note holds only values programs read or printed (the run's id and
  # paths, head's read of the response) and the peer enum, no text written
  # into this block: an expansion's result is not evaluated again (ADR-0059,
  # amendment of 2026-10-10).
  RESPONSE="$(head -c 4000 "$STDOUT_PATH")"
  NOTE="peer: $PEER
  run_id: $RUN_ID
  handle: $HANDLE_PATH
  prompt-mode: verbatim

  ### Response

  $RESPONSE
  "

  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude \
    --phase-label "[Peer] $PEER consultation" \
    --phase-note "$NOTE" \
    --event updated
  ```

- **Duplicate/corrupt branch state** -> reject and point at
  `/orchestrator:resume`.

The 4000-character note cap keeps the macro workflow readable; the
full response remains in the peer-run ledger until retention prunes it.

---

## Completion

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <workflow path> (run_id=<id>).`
- `✓ Peer consultation completed (standalone — no active macro workflow, run_id=<id>).`
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <reason>.`
- `✗ Per-branch duplicate detected — resolve via /orchestrator:resume.`

Print the peer response verbatim. Do not synthesize it into
AGREED/LOCAL-ONLY/PEER-ONLY/CONFLICT categories; that structure is
reserved for managed ensemble points like Plan-verify.
