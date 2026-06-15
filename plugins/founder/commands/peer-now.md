---
description: Ad-hoc cross-host business consultation — dispatch a verbatim (genericized) prompt to claude or codex outside a verb's ensemble flow
argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)
---

# Founder · Peer-now

$ARGUMENTS

`/founder:peer-now` is a meta command per ADR-0022 (meta-skill category,
adopted for founder per ADR-0036 SD2): a side-channel wrapper over
`peer-runner.mjs run --kind peer-now` that fires a verbatim prompt at the
cross-host peer companion (`claude` or `codex`) without opening a full
verb-skill ensemble. It does NOT advance any workflow phase and is excluded
from `ensemble_results` by design.

**Cognitive runbook + the Host-availability matrix live in
`$CLAUDE_PLUGIN_ROOT/skills/peer-now/SKILL.md`** per ADR-0022. This command
file owns the Claude-host bash below.

Plugin root is `$CLAUDE_PLUGIN_ROOT` (set by Claude Code). If unset, fall
back to
`$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Privacy gate (before any dispatch)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web search
AND peer-host dispatch. peer-now sends a **verbatim** prompt to the peer
host — genericize it first (no proprietary venture concept, customer /
interview identities, unpublished product or pricing names, internal
financials, or pasted internal documents); the pre-genericization value MUST
never leave the local host. The gate is bidirectional (Claude→Codex and
Codex→Claude alike). If the prompt cannot be genericized without losing the
question, confirm with the user or decline and answer locally. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

---

## Phase 0 — Argument parsing

Parse `$ARGUMENTS`:

- `--peer <claude|codex>` — REQUIRED. On Claude side `claude` is forbidden
  (no self-dispatch).
- `--prompt-text "..."` OR `--prompt-file <path>` — REQUIRED, exactly one.

Reject with a one-line usage hint and stop on: `--peer` missing / invalid /
self; neither or both prompt flags; an unreadable `--prompt-file`. Then run
the privacy gate above before dispatching.

---

## Phase 1 — Dispatch verbatim with operational tracking

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUN_ID="peer-now-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
RUN_JSON="$(mktemp -t founder-peer-now.XXXXXX).json"
RUN_ERR="$(mktemp -t founder-peer-now.XXXXXX).err"
# $PEER from --peer; $PROMPT_ARG is --prompt-text "<text>" or --prompt-file <path>
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --kind peer-now \
  --peer "$PEER" $PROMPT_ARG --output-format text \
  --host claude --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?
STDOUT_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stdout_path)||"")}catch{}' "$RUN_JSON")"
```

The dispatch is **synchronous** — `peer-runner.mjs run` blocks until the
peer responds, and the response is read from `$STDOUT_PATH` immediately
after. Do NOT background the Bash call: peer-now is a side-channel that
returns the raw answer now (unlike the verb-skill ensembles, which background
the peer so local analysis proceeds in parallel). Exit codes (per
`companions/contract.md` §5.1): 0 success; 1 `peer_run_error`; 2
`companion_misuse`; 3 peer CLI infrastructure failure. On `RUN_RC != 0`,
surface the first `$RUN_ERR` line + exit code + run id; do not append a note.

---

## Phase 2 — Optional `[Peer]` label injection

```bash
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT" 2>/dev/null)"
```

- **Empty** → standalone: print the response from `$STDOUT_PATH`; no state
  mutation.
- **Single path** → append a `[Peer]` note (cap the excerpt at `head -c 4000
  "$STDOUT_PATH"`, include `run_id`), no phase mutation:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude \
    --phase-label "[Peer] $PEER consultation" \
    --phase-note "run_id=$RUN_ID
  $(head -c 4000 "$STDOUT_PATH")" \
    --event updated
  ```

- **Per-branch duplicate error** → reject with a hint pointing at
  `/founder:resume`.

---

## Completion

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <path> (run_id=<id>).` (+ response).
- `✓ Peer consultation completed (standalone, run_id=<id>).` (+ response).
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <first stderr line>.`
- `✗ Privacy gate not cleared — prompt not dispatched.`
- `✗ <usage hint>` — Phase 0 rejected.

The peer response is printed verbatim — no synthesis or `AGREED / PEER-ONLY
/ CONFLICT` structuring (that is a verb-level concern).
