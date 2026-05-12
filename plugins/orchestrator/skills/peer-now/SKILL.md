---
name: peer-now
description: "Dispatches a verbatim ad-hoc prompt to the cross-host companion outside Plan-verify, optionally recording a [Peer] note on the active orchestrator macro workflow. A side-channel meta operation, not a managed ensemble."
---

# Peer-Now (orchestrator meta skill)

`peer-now` sends a raw prompt to the selected peer host through
`peer-runner.mjs run --kind peer-now`. When a macro workflow is
active, it can append a `[Peer]` note to the workflow body. It never
records `pending_ensemble` or `ensemble_results`; those fields are
reserved for managed Plan-verify runs.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Ask Codex with `--peer codex` | Yes | No self-dispatch |
| Ask Claude with `--peer claude` | No self-dispatch | Yes |
| Peer-run status/cancel | Yes | Yes |
| Append `[Peer]` note | `--host claude` | `--host codex` |
| Managed ensemble bookkeeping | No — deliberately excluded | No — deliberately excluded |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:peer-now --peer <peer> (--prompt-text ... \| --prompt-file <path>)` | `$orchestrator:peer-now --peer <peer> (--prompt-text ... \| --prompt-file <path>)` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator` |
| Host flag for state note | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Require:

- `--peer claude|codex`
- Exactly one of `--prompt-text` or `--prompt-file`

Reject self-dispatch, missing prompt, duplicate prompt forms, or an
unreadable prompt file.

---

## Phase 1 — Dispatch

```bash
node "<plugin-root>/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" $PROMPT_ARG \
  --output-format text \
  --host <claude|codex> \
  --cwd "$REPO_ROOT"
```

The runner writes a ledger under
`.claude/agentic-orchestrator/peer-runs/<run_id>/`. Use
`peer-runner.mjs status` and `peer-runner.mjs cancel` for operational
control.

---

## Phase 2 — Optional workflow note

If `state.mjs find-active` finds one active macro, append a note:

```bash
node "<plugin-root>/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host <claude|codex> \
  --phase-label "[Peer] $PEER consultation" \
  --phase-note "$NOTE" \
  --event updated
```

Do not pass `--current-phase`, `--next-action`, or managed ensemble
bookkeeping flags. Print the peer response verbatim in every success
case.

---

## Anti-patterns

- Do not use peer-now for Plan-verify.
- Do not write peer-now results into `ensemble_results`.
- Do not synthesize the raw peer response unless the user separately
  asks.
- Do not mutate macro phase or subtask status.
