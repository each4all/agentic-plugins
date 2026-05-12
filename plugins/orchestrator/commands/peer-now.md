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
The workflow and peer-run namespace is `.claude/agentic-orchestrator/`.

**Cognitive runbook lives in
`$CLAUDE_PLUGIN_ROOT/skills/peer-now/SKILL.md`**. The skill contains
the host-availability matrix, prompt guidance, and status/cancel
controls.

---

## Phase 0 — Argument parsing

Required:

- `--peer claude|codex`
- Exactly one of `--prompt-text "..."` or `--prompt-file <path>`

Reject missing peer, invalid peer, both prompt forms, no prompt form,
or unreadable prompt file. Do not self-dispatch.

---

## Phase 1 — Dispatch with operational tracking

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUN_ID="peer-now-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
RUN_JSON="$(mktemp -t orchestrator-peer-now.XXXXXX).json"
RUN_ERR="$(mktemp -t orchestrator-peer-now.XXXXXX).err"

node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" $PROMPT_ARG \
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
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/orchestrator-peer-now-find.err)"
FIND_RC=$?
```

- **No active macro** -> print the peer response only.
- **Single active macro** -> append a phase note without changing
  phase or next action:

  ```bash
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
