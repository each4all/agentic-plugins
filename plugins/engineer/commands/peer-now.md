---
description: Ad-hoc peer consultation — dispatch a verbatim prompt to the cross-host companion (claude or codex) outside a verb's normal ensemble flow
argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)
---

# Engineer · Peer-Now (ad-hoc consultation)

$ARGUMENTS

`/engineer:peer-now` is a meta command per ADR-0017 §sub-decision-3:
a thin wrapper over `dispatch-peer.mjs` that fires a verbatim prompt
at the cross-host peer companion (`claude` or `codex`) without
opening a full ensemble dispatch via one of the six verbs. The peer's
response is appended to the active workflow's body under a `[Peer]`
label phase note when a workflow exists; otherwise the response is
printed to stdout and the command exits.

This command is a deliberate side-channel: it does NOT update
`current_phase`, `next_action`, `latest_checkpoint`, or the
`ensemble_results` frontmatter list. peer-now is excluded from
`ensemble_results` by design — that field is reserved for the verb's
structured ensemble verdicts (omcc-dev's `Result Bookkeeping
exclusions` precedent for `codex-now` carries forward to
`peer-now`).

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT`
(set by Claude Code for plugin slash commands). If unset for any
reason, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

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

## Phase 1 — Dispatch verbatim

`dispatch-peer.mjs` is a generic wrapper. Without a `--workflow-path`
flag it does NOT touch `pending_ensemble` or `ensemble_results` — it
just runs the companion `task` subcommand and surfaces the response.
Use `--output-format text` so the raw companion stdout flows through
unmodified.

```bash
DISPATCH_OUT="$(mktemp -t engineer-peer-now.XXXXXX).out"
DISPATCH_ERR="$(mktemp -t engineer-peer-now.XXXXXX).err"

# $PROMPT_ARG is either `--prompt-text "<text>"` or
# `--prompt-file <path>` based on Phase 0's parse.
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer "$PEER" $PROMPT_ARG \
  --output-format text \
  > "$DISPATCH_OUT" 2> "$DISPATCH_ERR"
DISPATCH_RC=$?
```

Exit-code semantics (per `companions/contract.md` §5.1):

- 0 — success, peer response in `$DISPATCH_OUT`
- 1 — peer_run_error (companion ran but peer signaled failure)
- 2 — companion_misuse (bad CLI args; this command's bug)
- 3 — peer CLI infrastructure failure (companion not found)

On `DISPATCH_RC != 0`, surface the first stderr line + exit code to
the user and stop (do NOT append any phase note). Exit non-zero from
this command too.

---

## Phase 2 — Optional `[Peer]` label injection

Locate the active workflow:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/engineer-peer-now-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow. Standalone case:
  print the response from `$DISPATCH_OUT` to stdout and skip the
  state mutation step.
- **Exit 0, single path** → append a `[Peer]` label phase note to
  that workflow's body. Do NOT pass `--current-phase` or
  `--next-action` — peer-now does not advance phase.

  ```bash
  RESPONSE="$(head -c 4000 "$DISPATCH_OUT")"
  NOTE="peer: $PEER
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

  The 4000-char cap on the appended response keeps a single
  consultation from blowing the workflow body out; the full
  `$DISPATCH_OUT` is also printed to the user separately.

- **Exit 1, per-branch duplicate error** → reject with a hint
  pointing at `/engineer:resume` (peer-now must not pick a workflow
  itself — per-branch duplicate is a user-resolvable invariant
  violation per ADR-0018 §sub-2 cascade of ADR-0011 §1).

---

## Completion

Emit one of:

- `✓ Peer consultation recorded under [Peer] $PEER consultation in <workflow path>.`
  (followed by the response printed beneath).
- `✓ Peer consultation completed (standalone — no active workflow).`
  (when no active workflow exists; the response is printed beneath).
- `✗ Peer dispatch failed (exit <RC>): <first stderr line>.` — Phase 1
  failed.
- `✗ <usage hint from Phase 0>.` — argument parsing rejected.
- `✗ Per-branch duplicate detected — resolve via /engineer:resume.` —
  Phase 2 found more than one workflow file on the current branch
  (ADR-0018 §sub-2 violation: corruption / external mutation).

The peer's response is printed verbatim, with no synthesis label
injection or AGREED/PEER-ONLY/CONFLICT structuring. That structuring
is a verb-level concern (compose / critique / decide / …) carried by
the ensemble dispatch contract; peer-now is meant for casual
cross-host probes where the user wants the raw answer.
