---
name: peer-now
description: "Dispatches a verbatim prompt at the cross-host companion (claude or codex) outside a verb skill's normal ensemble flow — the founder plugin's peer-now meta skill (ADR-0022 meta-skill category, ADR-0036 SD2). A side-channel meta operation, not a cognitive verb and not a lifecycle macro. Use for a quick ad-hoc cross-host business consultation without opening a full ensemble dispatch. Trigger phrases include 'ask the peer', 'consult codex', 'consult claude', 'peer consultation', '피어 자문', '크로스 호스트 질의'. Symmetric on both sides — Claude can ask Codex; Codex can ask Claude; companions/ ships both bridges as first-party (ADR-0001 §COMPANION bidirectional design). The privacy gate applies: genericize before dispatch."
---

# Peer-now (founder persona, meta skill)

The `peer-now` meta skill is a side-channel wrapper over `peer-runner.mjs
run --kind peer-now` that fires a verbatim prompt at the cross-host peer
companion (`claude` or `codex`) without opening a full verb-skill ensemble.
The peer's response is appended to the active workflow's body under a
`[Peer]` label phase note when a workflow exists; otherwise the response is
printed and the skill exits.

It is a **meta skill** per [ADR-0010](../../../../docs/adr/0010-plugin-boundary-policy.md)
§3 cascade ([ADR-0022](../../../../docs/adr/0022-engineer-meta-skill-category.md),
adopted for founder per ADR-0036 SD2): not a verb (no cognitive activity of
founder's own), not a macro (no phase sequencing), but a side-channel
operation that surfaces a raw cross-host probe.

This skill is a deliberate side-channel: it does NOT update `current_phase`,
`next_action`, `latest_checkpoint`, or the `ensemble_results` frontmatter
list. peer-now is **excluded from `ensemble_results`** by design — that
field is reserved for verb-skill structured ensemble verdicts. peer-now
deliberately omits the workflow bookkeeping flags (`--workflow-path /
--phase / --ensemble-type / --run-id` for ensemble accounting), mirroring
the structural exclusion documented in
`../_shared/references/ensemble-protocol.md` § State Bookkeeping.

---

## Privacy gate (load-bearing for this skill)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web search
AND peer-host dispatch. peer-now sends a **verbatim** prompt to the peer
host — that is an external transmission. Before dispatch:

- **Genericize** the prompt the same way you would for a WebSearch query —
  no proprietary venture concept, customer/interview identities, unpublished
  product or pricing names, internal financials, or pasted internal
  documents. The pre-genericization value MUST never leave the local host.
- If the user's prompt cannot be meaningfully genericized without losing the
  question, ask the user to confirm before dispatching, or decline and
  answer locally.
- The gate is **bidirectional** — the same discipline applies whether the
  local host is Claude (sending to Codex) or Codex (sending to Claude).

See `../investigate/references/business-brief-spec.md` § Privacy Gate for
the canonical rule. When the user declines genericization, do NOT dispatch —
answer in the local conversation instead.

---

## Host availability (ADR-0022)

| Operation | Claude side | Codex side |
|-----------|-------------|------------|
| Privacy-gate check + argument parse + dispatch | Yes | Yes |
| `peer-runner.mjs run --kind peer-now --peer codex` (Claude asking Codex) | Native — `codex-companion.mjs` invoked and tracked under `.agentic-plugins/state/founder/peer-runs/<run_id>/` | N/A (Codex would not ask itself) |
| `peer-runner.mjs run --kind peer-now --peer claude` (Codex asking Claude) | N/A (Claude would not ask itself) | Native — `claude-companion.mjs` invoked and tracked under `.agentic-plugins/state/founder/peer-runs/<run_id>/` |
| `peer-runner.mjs status/cancel --run-id <id>` | Yes — local status/cancel surface | Yes — same local surface |
| `state.mjs append --phase-label "[Peer] <peer> consultation"` (when active workflow exists) | `--host claude` | `--host codex` |
| Standalone mode (no active workflow → stdout only) | Yes | Yes |

`peer-now` is the most symmetric of the three meta skills: `companions/`
ships `codex-companion.mjs` (Claude → Codex bridge) and `claude-companion.mjs`
(Codex → Claude bridge) as first-party peer-host invocation primitives
(ADR-0001 §COMPANION, ADR-0008, ADR-0009 wire spec v0.1.1). The runtime
determines which bridge fires based on the `--peer` flag.

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by Claude Code); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/founder` (Codex marketplace install layout per ADR-0008) |
| Entry path | `/founder:peer-now --peer <claude\|codex> (--prompt-text "..." \| --prompt-file <path>)` | `$founder:peer-now --peer <claude\|codex> (--prompt-text "..." \| --prompt-file <path>)` |
| Companion bridge invoked | `--peer codex` runs `<plugin-root>/scripts/peer-runner.mjs run --kind peer-now` → `companions/codex-companion.mjs` | `--peer claude` runs the same `peer-runner.mjs` → `companions/claude-companion.mjs` (only the bridge target differs) |
| `state.mjs` host flag (when injecting `[Peer]` note) | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake + privacy gate

Parse the argument string for these flags:

- `--peer <claude|codex>` — REQUIRED. The peer host whose companion runs the
  prompt. On Claude side, `claude` is forbidden (no self-dispatch); on Codex
  side, `codex` is forbidden.
- `--prompt-text "..."` OR `--prompt-file <path>` — REQUIRED. One of the
  two, not both. The verbatim (genericized) prompt to forward.

Reject with a one-line usage hint and stop on: `--peer` missing / not in
`{claude, codex}` / set to the current host; neither or both of
`--prompt-text` / `--prompt-file`; a `--prompt-file` path that does not
exist or is not readable.

**Then run the privacy gate above** on the prompt content before any
dispatch. Genericize, or decline.

---

## Phase 1 — Dispatch verbatim with operational tracking

`peer-runner.mjs` supervises the companion process and writes a hidden
repo-local ledger under `.agentic-plugins/state/founder/peer-runs/<run_id>/`.
With `--kind peer-now`, it does NOT touch `pending_ensemble` or
`ensemble_results` — it just tracks the side-channel process and surfaces
the response path. Use `--output-format text` so the raw companion stdout
stays verbatim in `stdout.log`.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOST="${AGENTIC_HOST:-claude}"  # Codex-side command-invoked mode uses codex.
RUN_ID="peer-now-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
RUN_JSON="$(mktemp -t founder-peer-now.XXXXXX).json"
RUN_ERR="$(mktemp -t founder-peer-now.XXXXXX).err"

node "<plugin-root>/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --kind peer-now \
  --peer "$PEER" $PROMPT_ARG --output-format text \
  --host "$HOST" --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?

STDOUT_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stdout_path)||"")}catch{}' "$RUN_JSON")"
ERROR_KIND="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error_kind)||"")}catch{}' "$RUN_JSON")"
```

Exit-code semantics (per `companions/contract.md` §5.1): 0 success (response
in `$STDOUT_PATH`); 1 `peer_run_error`; 2 `companion_misuse` (bad CLI args,
this command's bug); 3 peer CLI infrastructure failure (companion not
found). On `RUN_RC != 0`, surface the first line from `$RUN_ERR`, then
`$ERROR_KIND` + exit code + run id; stop without appending a phase note and
exit non-zero.

The run can be inspected / cancelled from another local session:
`peer-runner.mjs status --run-id <id> --json` / `peer-runner.mjs cancel
--run-id <id>`.

---

## Phase 2 — Optional `[Peer]` label injection

Locate the active workflow with `state.mjs find-active`:

- **Empty stdout** → no active workflow. Standalone mode: print the response
  from `$STDOUT_PATH` and skip the state mutation.
- **Single path** → append a `[Peer]` label phase note via `state.mjs append
  --phase-label "[Peer] $PEER consultation" --phase-note "<note>" --event
  updated`. Do NOT pass `--current-phase` / `--next-action`. Include
  `run_id: $RUN_ID` in the note; cap the appended excerpt at 4000 chars
  (`head -c 4000` on `$STDOUT_PATH`); print the full response to the user
  separately. Re-resolve `$STDOUT_PATH` / `$ACTIVE` if Phase 1 and Phase 2
  run in separate Bash calls.
- **Per-branch duplicate error** → reject with a hint pointing at the
  `resume` meta skill. Do NOT pick a workflow yourself.

---

## Completion outcomes

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <workflow path> (run_id=<id>).` (+ the response).
- `✓ Peer consultation completed (standalone — no active workflow, run_id=<id>).` (+ the response).
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <first stderr line>.`
- `✗ <usage hint>` — argument parsing rejected.
- `✗ Privacy gate not cleared — prompt not dispatched.` — the user declined
  genericization.
- `✗ Per-branch duplicate detected — resolve via the resume meta skill.`

The peer's response is printed verbatim from `$STDOUT_PATH`, with no
synthesis label injection or `AGREED / PEER-ONLY / CONFLICT` structuring —
that structuring is a verb-level concern carried by the verb-skill ensemble
dispatch contract. `peer-now` is for casual cross-host business probes where
the user wants the raw answer.

---

## Anti-patterns

- **Dispatching before the privacy gate.** peer-now sends a verbatim prompt
  to the peer host — genericize first; the pre-genericization value never
  leaves the local host.
- **Using `peer-now` to drive a verb's ensemble.** Verb skills have their
  own always-max ensemble dispatch; `peer-now` is the side-channel. The
  `ensemble_results` exclusion is the structural marker.
- **Self-dispatch.** Claude → Claude or Codex → Codex is rejected in Phase
  0. Use the local conversation directly.
- **Synthesizing the peer's response without surfacing the raw text.** The
  user invoked `peer-now` for a raw probe; print it verbatim.
- **Mutating `current_phase` or `next_action`.** peer-now is a side-channel.
  Phase progression belongs to verb skills or `founder:start`.
