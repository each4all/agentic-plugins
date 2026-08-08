---
name: checkpoint
description: "Records a one-line progress checkpoint summary on the active engineer workflow for SessionStart re-injection — the engineer plugin's checkpoint meta skill (ADR-0017 §sub-decision-2). A workflow-continuity meta operation, not a cognitive verb and not a lifecycle macro. Use when the user wants to leave a short, durable progress note that a future session will re-surface. Trigger phrases include 'checkpoint', 'mark progress', 'save where I am', 'note for next session', '체크포인트', '진행 메모', '다음 세션에 남길 메모'. Cross-host handoff works through durable state; Codex re-injection additionally requires the plugin enabled with generic `[features].hooks` (default on) and `/hooks` review/trust."
---

# Checkpoint (engineer persona, meta skill)

The `checkpoint` meta skill writes a one-line progress summary into
the active workflow's `latest_checkpoint` frontmatter field. The
SessionStart hook re-injects that summary after compact — both hosts
register it with `matcher: "compact"` — so a resumed conversation
knows where the previous session stopped —
useful for multi-day deliverables where `current_phase` and
`next_action` alone undersell the context.

It is a **meta skill** per [ADR-0010](../../../../docs/adr/0010-plugin-boundary-policy.md)
§3 cascade ([ADR-0022](../../../../docs/adr/0022-engineer-meta-skill-category.md)):
not a verb (no cognitive activity), not a macro (no phase sequencing),
but a workflow-continuity operation that augments
`latest_checkpoint` without mutating `current_phase` or
`next_action`.

`checkpoint` does NOT bootstrap a new workflow — use one of the six
verb skills (`/engineer:investigate / :frame / :decide / :compose /
:critique / :refine`) for that.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| `state.mjs checkpoint-set` (write `latest_checkpoint`) | `--host claude` | `--host codex` — same on-disk schema; the host flag distinguishes write provenance in `host_history` |
| Schema preservation (schema 1 keeps 1; '1.1' keeps '1.1' per ADR-0017 schema versioning policy) | Yes | Yes — `state.mjs` is host-agnostic |
| SessionStart re-injection of the summary — both hosts register the hook with `matcher: "compact"`, so this is **post-compact only**, never an arbitrary new session | Yes — the SessionStart hook surfaces `[engineer-active-metadata]` with `checkpoint_summary` + `checkpoint_at` after compact | Yes once the bundled hooks load (generic `[features].hooks`) and pass `/hooks` trust; otherwise manual resume reads the same durable checkpoint |

The Codex use case is **cross-host handoff**: a checkpoint written on
Codex is re-injected on either host's next post-compact session, given
that host's hook is live — on Codex that means plugin hooks enabled and
`/hooks`-trusted. Without that trust, Codex can still durably *write* the
checkpoint and `$engineer:resume` reads it manually.

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by the Claude Code runtime); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` — versioned subdirectory layout | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/engineer` (Codex marketplace install layout per ADR-0008 — no versioned subdirectory, no glob needed) |
| Entry path | `/engineer:checkpoint <one-line summary>` | `$engineer:checkpoint <one-line summary>` — this SKILL.md is the runbook; the full skill-mention argument string is the `$ARGUMENTS` equivalent |
| `state.mjs` host flag | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Inspect the argument string (the full text after
`/engineer:checkpoint` on Claude, or after `$engineer:checkpoint`
on Codex):

- **Empty / whitespace-only** → reject with a one-line usage hint:
  `<command-or-skill-name> <one-line summary>` is required. A
  checkpoint without a summary defeats the purpose — re-injection
  would have nothing to surface.
- **Otherwise** → treat the entire argument text as the summary.
  Trim leading/trailing whitespace. Do NOT split on whitespace, do
  NOT attempt to parse sub-commands. Multi-word summaries are
  normal (the whole text is one logical sentence).

Length: `state.mjs checkpoint-set` does not enforce a hard cap on
disk — the SessionStart hook truncates to 256 chars on display per
its `MAX_LENGTHS.checkpoint_summary` constant, but the on-disk
record keeps the full text. If the argument is unusually long
(>1000 chars), warn the user that re-injection will display only a
prefix; do not silently truncate.

---

## Phase 1 — Locate active workflow

Use `state.mjs find-active` against the repository root:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/engineer-checkpoint-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow; tell the user
  "*No active workflow; nothing to checkpoint.*" and recommend
  bootstrapping a workflow with a verb skill first.
- **Exit 0, single path** → that path is the active workflow.
  Continue with Phase 2.
- **Exit 1, per-branch duplicate error** → reject with a hint
  pointing at the `resume` meta skill (which can list per-branch
  candidates and archive stale ones). Per-branch duplicate is a
  user-resolvable invariant violation per ADR-0018 §sub-2; do NOT
  pick one yourself.

---

## Phase 2 — Set checkpoint

```bash
node "<plugin-root>/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host <claude|codex> --summary "$SUMMARY"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving:

- Schema 1 stays schema 1 — `latest_checkpoint` is a schema-1.1
  additive field that 1.0 readers tolerantly ignore (ADR-0017
  §"Schema versioning policy", additive non-breaking).
- Schema '1.1' stays '1.1'.
- `host_history` gains a `{host, at, event: checkpointed}` entry
  per ADR-0011 §1's host-history append contract.

Pass `$SUMMARY` as a single quoted argument so embedded whitespace
and special characters survive intact. The CLI rejects empty
summaries; Phase 0 already filtered that case.

**Cross-Bash-call note (parallel to `resume` Phase 2b)**: shell-
variable state (e.g., `$ACTIVE`, `$SUMMARY`) does not survive
across Bash tool invocations. If Phase 1 (`find-active`) and
Phase 2 (`checkpoint-set`) run in separate Bash calls, re-resolve
both values inside the second call — or capture them in a single
combined Bash call to avoid the re-read.

---

## Completion outcomes

- `✓ Checkpoint recorded: <summary>` — Phase 2 succeeded. Surface
  the absolute workflow path so the user can inspect by hand.
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found
  nothing.
- `✗ Per-branch duplicate detected — resolve via the resume meta
  skill before checkpointing.` — Phase 1 found more than one
  workflow on the current branch.
- `✗ Empty summary; <command-or-skill-name> <summary> required.` —
  Phase 0 rejected.

Both hosts re-inject through a SessionStart hook registered with
`matcher: "compact"`, so the summary surfaces in the **post-compact**
session context as part of the `[engineer-active-metadata]` marker. It is
not re-injected into an arbitrary new session, and not on
`claude --continue` — those carry a different SessionStart source that the
matcher does not select. Inside that window the user does not need to
re-issue `resume` to see the checkpoint.

Codex re-injects the same way once the bundled hooks load (generic
`[features].hooks`) and pass `/hooks` review/trust (ADR-0030). The on-disk
`latest_checkpoint` is host-agnostic, so a checkpoint written on either
host is read by either host. Outside the post-compact window — or on Codex
before hook trust — `resume` reads the same durable checkpoint manually.

---

## Anti-patterns

- **Recording a checkpoint without a summary.** The
  re-injection mechanism has nothing to surface; the checkpoint
  becomes dead weight in the workflow file. Phase 0 rejects this.
- **Treating checkpoint as a phase transition.** It does NOT
  mutate `current_phase` or `next_action`. Use a verb skill or the
  lifecycle macro to advance phases.
- **Bootstrapping a workflow via `checkpoint`.** The skill
  requires an active workflow. Bootstrap first via one of the six
  verb skills.
- **Bypassing `state.mjs` and editing the workflow file by hand.**
  The CLI guarantees atomic write under the per-file lock and
  preserves schema; hand-edits break those guarantees and may
  corrupt `host_history` ordering.
