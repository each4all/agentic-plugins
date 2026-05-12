---
name: peer-now
description: "Dispatches a verbatim prompt at the cross-host companion (claude or codex) outside a verb skill's normal ensemble flow — the engineer plugin's peer-now meta skill (ADR-0017 §sub-decision-3). A side-channel meta operation, not a cognitive verb and not a lifecycle macro. Use when the user wants a quick ad-hoc cross-host consultation without opening a full ensemble dispatch. Trigger phrases include 'ask the peer', 'consult codex', 'consult claude', 'peer consultation', 'peer dispatch', '피어 자문', '크로스 호스트 질의'. Symmetric on both sides — Claude can ask Codex; Codex can ask Claude; companions/ ships both bridges as first-party (ADR-0001 §COMPANION bidirectional design)."
---

# Peer-now (engineer persona, meta skill)

The `peer-now` meta skill is a thin wrapper over `dispatch-peer.mjs`
that fires a verbatim prompt at the cross-host peer companion
(`claude` or `codex`) without opening a full verb-skill ensemble.
The peer's response is appended to the active workflow's body under
a `[Peer]` label phase note when a workflow exists; otherwise the
response is printed and the skill exits.

It is a **meta skill** per [ADR-0010](../../../../docs/adr/0010-plugin-boundary-policy.md)
§3 cascade ([ADR-0022](../../../../docs/adr/0022-engineer-meta-skill-category.md)):
not a verb (no cognitive activity of the engineer plugin's own),
not a macro (no phase sequencing), but a side-channel operation
that surfaces a raw cross-host probe.

This skill is a deliberate side-channel: it does NOT update
`current_phase`, `next_action`, `latest_checkpoint`, or the
`ensemble_results` frontmatter list. peer-now is **excluded from
`ensemble_results`** by design — that field is reserved for verb-
skill structured ensemble verdicts. The four-flag
ensemble-bookkeeping argument set documented at
`scripts/dispatch-peer.mjs --help`
(`--workflow-path / --phase / --ensemble-type / --run-id`) is what
opts a dispatch INTO `ensemble_results`; `peer-now` deliberately
omits those flags, mirroring the structural exclusion that
verb-skill ensembles record in
`skills/_shared/references/ensemble-protocol.md`
§ State Bookkeeping.

---

## Host availability

| Operation | Claude side | Codex side |
|-----------|-------------|------------|
| Argument parse + dispatch | Yes | Yes |
| `dispatch-peer.mjs --peer codex` (Claude asking Codex) | Native — `codex-companion.mjs` invoked | N/A (Codex would not ask itself) |
| `dispatch-peer.mjs --peer claude` (Codex asking Claude) | N/A (Claude would not ask itself) | Native — `claude-companion.mjs` invoked |
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
| Companion bridge invoked | `--peer codex` runs `<plugin-root>/scripts/dispatch-peer.mjs` → `companions/codex-companion.mjs` | `--peer claude` runs `<plugin-root>/scripts/dispatch-peer.mjs` → `companions/claude-companion.mjs` (same `dispatch-peer.mjs` path inside the engineer plugin's `scripts/` on both hosts; only the bridge target differs) |
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

## Phase 1 — Dispatch verbatim

`dispatch-peer.mjs` is a generic wrapper. **Without** the four-flag
ensemble-bookkeeping argument set (`--workflow-path / --phase /
--ensemble-type / --run-id`), it does NOT touch `pending_ensemble`
or `ensemble_results` — it just runs the companion `task`
subcommand and surfaces the response. Use `--output-format text`
so the raw companion stdout flows through unmodified.

```bash
DISPATCH_OUT="$(mktemp -t engineer-peer-now.XXXXXX).out"
DISPATCH_ERR="$(mktemp -t engineer-peer-now.XXXXXX).err"

node "<plugin-root>/scripts/dispatch-peer.mjs" \
  --peer "$PEER" $PROMPT_ARG \
  --output-format text \
  > "$DISPATCH_OUT" 2> "$DISPATCH_ERR"
DISPATCH_RC=$?
```

Exit-code semantics (per `companions/contract.md` §5.1):

- 0 — success, peer response in `$DISPATCH_OUT`
- 1 — `peer_run_error` (companion ran but peer signaled failure)
- 2 — `companion_misuse` (bad CLI args; this command's bug)
- 3 — peer CLI infrastructure failure (companion not found)

On `DISPATCH_RC != 0`, surface the first stderr line plus the exit
code and stop (do NOT append any phase note). Exit non-zero from
this skill too.

---

## Phase 2 — Optional `[Peer]` label injection

Locate the active workflow with `state.mjs find-active`:

- **Exit 0, empty stdout** → no active workflow. Standalone mode:
  print the response from `$DISPATCH_OUT` to stdout and skip the
  state mutation step.
- **Exit 0, single path** → append a `[Peer]` label phase note to
  that workflow's body via
  `state.mjs append --phase-label "[Peer] $PEER consultation"
  --phase-note "<note>" --event updated`. Do NOT pass
  `--current-phase` or `--next-action` — `peer-now` does not
  advance phase.
  - Cap the appended response excerpt at 4000 chars (`head -c 4000`
    on `$DISPATCH_OUT`) so one consultation cannot blow the
    workflow body out. The full response is also printed to the
    user separately.
  - **Cross-Bash-call note (parallel to `resume` Phase 2b)**:
    shell-variable state (`$DISPATCH_OUT`, `$ACTIVE`, `$PEER`) does
    not survive across Bash tool invocations. If Phase 1 dispatch
    and Phase 2 state-write run in separate Bash calls, re-resolve
    the active workflow inside Phase 2 (e.g., re-run
    `state.mjs find-active`) and re-read `$DISPATCH_OUT` via
    `head -c 4000` after locating the file path; the temp file
    itself persists across calls but the variable does not.
- **Exit 1, per-branch duplicate error** → reject with a hint
  pointing at the `resume` meta skill. `peer-now` must not pick a
  workflow itself — per-branch duplicate is a user-resolvable
  invariant violation per ADR-0018 §sub-2.

---

## Completion outcomes

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <workflow path>.` (followed by the response).
- `✓ Peer consultation completed (standalone — no active workflow).` (followed by the response).
- `✗ Peer dispatch failed (exit <RC>): <first stderr line>.` — Phase 1 failed.
- `✗ <usage hint from Phase 0>.` — argument parsing rejected.
- `✗ Per-branch duplicate detected — resolve via the resume meta skill.` — Phase 2 found more than one workflow on the current branch.

The peer's response is printed verbatim, with no synthesis label
injection or `AGREED / PEER-ONLY / CONFLICT` structuring. That
structuring is a verb-level concern (compose / critique / decide /
…) carried by the verb-skill ensemble dispatch contract; `peer-now`
is meant for casual cross-host probes where the user wants the raw
answer.

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
