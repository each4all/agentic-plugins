---
name: peer-now
description: "Dispatches a verbatim prompt at the cross-host companion (claude or codex) outside a verb skill's normal ensemble flow — the engineer plugin's peer-now meta skill (ADR-0017 §sub-decision-3). A side-channel meta operation, not a cognitive verb and not a lifecycle macro. Use when the user wants a quick ad-hoc cross-host consultation without opening a full ensemble dispatch. Trigger phrases include 'ask the peer', 'consult codex', 'consult claude', 'peer consultation', 'peer dispatch', '피어 자문', '크로스 호스트 질의'. Symmetric on both sides — Claude can ask Codex; Codex can ask Claude; companions/ ships both bridges as first-party (ADR-0001 §COMPANION bidirectional design)."
---

# Peer-now (engineer persona, meta skill)

The `peer-now` meta skill is a side-channel wrapper over
`peer-runner.mjs run --kind peer-now` that fires a verbatim prompt
at the cross-host peer companion (`claude` or `codex`) without
opening a full verb-skill ensemble. The peer's response is appended
to the active workflow's body under a `[Peer]` label phase note when
a workflow exists; otherwise the response is printed and the skill
exits.

It is a **meta skill** per [ADR-0010](../../../../docs/adr/0010-plugin-boundary-policy.md)
§3 cascade ([ADR-0022](../../../../docs/adr/0022-engineer-meta-skill-category.md)):
not a verb (no cognitive activity of the engineer plugin's own),
not a macro (no phase sequencing), but a side-channel operation
that surfaces a raw cross-host probe.

This skill is a deliberate side-channel: it does NOT update
`current_phase`, `next_action`, `latest_checkpoint`, or the
`ensemble_results` frontmatter list. peer-now is **excluded from
`ensemble_results`** by design — that field is reserved for verb-
skill structured ensemble verdicts. The managed ensemble
bookkeeping argument set (`--workflow-path / --phase /
--ensemble-type / --run-id`) is what opts a dispatch INTO
`ensemble_results`; `peer-now` deliberately omits the workflow
bookkeeping flags even though it now has an operational `run_id`,
mirroring the structural exclusion that verb-skill ensembles record in
`skills/_shared/references/ensemble-protocol.md`
§ State Bookkeeping.

---

## Host availability

| Operation | Claude side | Codex side |
|-----------|-------------|------------|
| Argument parse + dispatch | Yes | Yes |
| `peer-runner.mjs run --kind peer-now --peer codex` (Claude asking Codex) | Native — `codex-companion.mjs` invoked and tracked under `.claude/agentic-engineer/peer-runs/<run_id>/` | N/A (Codex would not ask itself) |
| `peer-runner.mjs run --kind peer-now --peer claude` (Codex asking Claude) | N/A (Claude would not ask itself) | Native — `claude-companion.mjs` invoked and tracked under `.claude/agentic-engineer/peer-runs/<run_id>/` |
| `peer-runner.mjs status/cancel --run-id <id>` | Yes — local status/cancel surface for peer-now ledgers | Yes — same local status/cancel surface |
| `state.mjs append --phase-label "[Peer] <peer> consultation"` (when active workflow exists) | `--host claude` | `--host codex` |
| Standalone mode (no active workflow → stdout only) | Yes | Yes |

`peer-now` is the most symmetric of the three meta skills:
`companions/` ships `codex-companion.mjs` (Claude → Codex bridge)
and `claude-companion.mjs` (Codex → Claude bridge) as first-party
peer-host invocation primitives (ADR-0001 §COMPANION, ADR-0008,
ADR-0009 wire spec v0.1.1). The runtime determines which bridge
fires based on the `--peer` flag.

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by the Claude Code runtime); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` — versioned subdirectory layout | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/engineer` (Codex marketplace install layout per ADR-0008 — no versioned subdirectory, no glob needed) |
| Entry path | `/engineer:peer-now --peer <claude|codex> (--prompt-text "..." \| --prompt-file <path>)` | `$engineer:peer-now --peer <claude|codex> (--prompt-text "..." \| --prompt-file <path>)` |
| Companion bridge invoked | `--peer codex` runs `<plugin-root>/scripts/peer-runner.mjs run --kind peer-now` → `companions/codex-companion.mjs` | `--peer claude` runs `<plugin-root>/scripts/peer-runner.mjs run --kind peer-now` → `companions/claude-companion.mjs` (same `peer-runner.mjs` path inside the engineer plugin's `scripts/` on both hosts; only the bridge target differs) |
| `state.mjs` host flag (when injecting `[Peer]` note) | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Parse the argument string for these flags:

- `--peer <claude|codex>` — REQUIRED. The peer host whose companion
  should run the prompt. On Claude side, `claude` is forbidden (no
  self-dispatch). On Codex side, `codex` is forbidden (no
  self-dispatch).
- `--prompt-text "..."` OR `--prompt-file <path>` — REQUIRED. One
  of the two, not both. The verbatim prompt to forward.

Reject with a one-line usage hint and stop on:

- `--peer` missing, value not in `{claude, codex}`, or set to the
  current host.
- Neither `--prompt-text` nor `--prompt-file` provided, OR both.
- `--prompt-file` path that does not exist or is not readable.

---

## Phase 1 — Dispatch verbatim with operational tracking

`peer-runner.mjs` supervises the companion process and writes a
hidden repo-local ledger under
`.claude/agentic-engineer/peer-runs/<run_id>/`. With
`--kind peer-now`, it does NOT touch `pending_ensemble` or
`ensemble_results` — it just tracks the side-channel process and
surfaces the response path. Use `--output-format text` so the raw
companion stdout remains verbatim in `stdout.log`.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOST="${AGENTIC_HOST:-claude}" # Codex-side command-invoked mode uses codex.
RUN_ID="peer-now-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
RUN_JSON="$(mktemp -t engineer-peer-now.XXXXXX).json"
RUN_ERR="$(mktemp -t engineer-peer-now.XXXXXX).err"

echo "peer-now run_id=$RUN_ID" >&2

node "<plugin-root>/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" $PROMPT_ARG \
  --output-format text \
  --host "$HOST" \
  --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?

STDOUT_PATH="$(jq -r '.stdout_path // empty' "$RUN_JSON" 2>/dev/null)"
STDERR_PATH="$(jq -r '.stderr_path // empty' "$RUN_JSON" 2>/dev/null)"
HANDLE_PATH="$(jq -r '.handle_path // empty' "$RUN_JSON" 2>/dev/null)"
ERROR_KIND="$(jq -r '.error_kind // empty' "$RUN_JSON" 2>/dev/null)"
```

Exit-code semantics (per `companions/contract.md` §5.1):

- 0 — success, peer response in `$STDOUT_PATH`
- 1 — `peer_run_error` (companion ran but peer signaled failure)
- 2 — `companion_misuse` (bad CLI args; this command's bug)
- 3 — peer CLI infrastructure failure (companion not found)

While the run is active, another local host/session can inspect or
cancel it:

```bash
node "<plugin-root>/scripts/peer-runner.mjs" status \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --json
node "<plugin-root>/scripts/peer-runner.mjs" cancel \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID"
```

On `RUN_RC != 0`, surface the first line from `$RUN_ERR`, then
`$STDERR_PATH`, then `$ERROR_KIND` as fallback, plus the exit code
and run id. Stop without appending a phase note and exit non-zero
from this skill too.

---

## Phase 2 — Optional `[Peer]` label injection

Locate the active workflow with `state.mjs find-active`:

- **Exit 0, empty stdout** → no active workflow. Standalone mode:
  print the response from `$STDOUT_PATH` to stdout and skip the
  state mutation step.
- **Exit 0, single path** → append a `[Peer]` label phase note to
  that workflow's body via
  `state.mjs append --phase-label "[Peer] $PEER consultation"
  --phase-note "<note>" --event updated`. Do NOT pass
  `--current-phase` or `--next-action` — `peer-now` does not
  advance phase.
  - Include `run_id: $RUN_ID` and `handle: $HANDLE_PATH` in the
    `[Peer]` note so the raw ledger can be inspected while retention
    keeps it.
  - Cap the appended response excerpt at 4000 chars (`head -c 4000`
    on `$STDOUT_PATH`) so one consultation cannot blow the
    workflow body out. The full response is also printed to the
    user separately.
  - **Cross-Bash-call note (parallel to `resume` Phase 2b)**:
    shell-variable state (`$STDOUT_PATH`, `$ACTIVE`, `$PEER`) does
    not survive across Bash tool invocations. If Phase 1 dispatch
    and Phase 2 state-write run in separate Bash calls, re-resolve
    the active workflow inside Phase 2 (e.g., re-run
    `state.mjs find-active`) and re-read `$STDOUT_PATH` via
    `head -c 4000` after locating the file path; the ledger file
    itself persists until peer-run retention removes it, but the
    variable does not.
- **Exit 1, per-branch duplicate error** → reject with a hint
  pointing at the `resume` meta skill. `peer-now` must not pick a
  workflow itself — per-branch duplicate is a user-resolvable
  invariant violation per ADR-0018 §sub-2.

---

## Completion outcomes

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <workflow path> (run_id=<id>).` (followed by the response).
- `✓ Peer consultation completed (standalone — no active workflow, run_id=<id>).` (followed by the response).
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <first stderr line>.` — Phase 1 failed.
- `✗ <usage hint from Phase 0>.` — argument parsing rejected.
- `✗ Per-branch duplicate detected — resolve via the resume meta skill.` — Phase 2 found more than one workflow on the current branch.

The peer's response is printed verbatim from `$STDOUT_PATH`, with no
synthesis label injection or `AGREED / PEER-ONLY / CONFLICT`
structuring. That structuring is a verb-level concern (compose /
critique / decide / …) carried by the verb-skill ensemble dispatch
contract; `peer-now` is meant for casual cross-host probes where the
user wants the raw answer.

---

## Anti-patterns

- **Using `peer-now` to drive a verb's ensemble.** Verb skills have
  their own ensemble dispatch (always-max policy per ADR-0020 §Sub-
  decision 3); `peer-now` is the side-channel, not the main
  channel. The `ensemble_results` exclusion is the structural
  marker.
- **Recording `peer-now` into `ensemble_results`.** Forbidden by
  design — `ensemble_results` is reserved for structured verb-skill
  ensemble verdicts.
- **Self-dispatch.** Claude → Claude or Codex → Codex is rejected
  in Phase 0. Use the local conversation directly instead.
- **Synthesizing the peer's response without surfacing the raw
  text.** The user invoked `peer-now` for a raw cross-host probe;
  the response is printed verbatim. Synthesis is a verb-skill
  concern.
- **Mutating `current_phase` or `next_action`.** `peer-now` is a
  side-channel. Phase progression belongs to verb skills or the
  lifecycle macro.
