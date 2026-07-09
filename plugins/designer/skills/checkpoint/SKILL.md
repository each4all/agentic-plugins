---
name: checkpoint
description: "Records a one-line progress checkpoint on the active designer workflow for SessionStart re-injection — the designer plugin's checkpoint meta skill (ADR-0022 meta-skill category, ADR-0042 SD7). A workflow-continuity meta operation, not a cognitive verb and not a lifecycle macro. Use to leave a short, durable progress note on a design deliverable that a future session re-surfaces. Trigger phrases include 'checkpoint', 'mark progress', 'save where I am', 'note for next session', '체크포인트', '진행 메모', '다음 세션에 남길 메모'. Cross-host handoff works through durable state; Codex re-injection additionally requires the plugin enabled with generic `[features].hooks` (default on) and `/hooks` review/trust."
---

# Checkpoint (designer persona, meta skill)

The `checkpoint` meta skill writes a one-line progress summary into the
active designer workflow's `latest_checkpoint` frontmatter field. The next
session's SessionStart hook re-injects that summary so a resumed
conversation knows where the previous session stopped — useful for the
multi-session arc of a design deliverable (a flow spec, a wireframe set, a
post-code critique loop) where `current_phase` and `next_action` alone
undersell the context ("left off after the a11y lens found a contrast
barrier on the pay button; next: re-render and re-critique").

It is a **meta skill** per [ADR-0010](../../../../docs/adr/0010-plugin-boundary-policy.md)
§3 cascade ([ADR-0022](../../../../docs/adr/0022-engineer-meta-skill-category.md),
adopted for designer per ADR-0042 SD7): not a verb (no cognitive activity),
not a macro (no phase sequencing), but a workflow-continuity operation that
augments `latest_checkpoint` without mutating `current_phase` or
`next_action`.

`checkpoint` does NOT bootstrap a new workflow — use one of the six designer
verbs (`/designer:investigate / :frame / :decide / :compose / :critique /
:refine`) or `/designer:start` for that.

---

## Host availability (ADR-0022)

| Operation | Claude | Codex |
|-----------|--------|-------|
| `state.mjs checkpoint-set` (write `latest_checkpoint`) | `--host claude` | `--host codex` — same on-disk schema; the host flag distinguishes write provenance in `host_history` |
| Schema preservation (schema 1 keeps 1; '1.1' keeps '1.1') | Yes | Yes — `state.mjs` is host-agnostic |
| SessionStart re-injection of the summary into a new session | Yes (next Claude session, via the SessionStart hook surfacing `[designer-active-metadata]` with the checkpoint summary + timestamp) | Yes when the designer plugin's hooks are enabled (`[features].hooks`, default on) and `/hooks`-reviewed/trusted; otherwise manual `$designer:resume` reads the same durable checkpoint |

The Codex use case is **cross-host handoff**: a user on Codex who leaves a
checkpoint will see it re-injected on the next Claude Code session, and on
Codex sessions where the plugin's hooks are enabled and trusted. Without
that active-session trust, Codex can still durably *write* the checkpoint
and `$designer:resume` reads it manually. (Per ADR-0030/0035 the Codex hook
model is generic `[features].hooks` + `/hooks` review/trust — there is no
`plugin_hooks` settings key.)

---

## Claude/Codex command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Plugin root | `$CLAUDE_PLUGIN_ROOT` (set by the Claude Code runtime); Claude fallback `$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d \| sort -V \| tail -1)` | Direct path: `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/designer` (Codex marketplace install layout per ADR-0008) |
| Entry path | `/designer:checkpoint <one-line summary>` | `$designer:checkpoint <one-line summary>` — this SKILL.md is the runbook; the skill-mention argument string is the `$ARGUMENTS` equivalent |
| `state.mjs` host flag | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Inspect the argument string (the full text after `/designer:checkpoint` on
Claude, or after `$designer:checkpoint` on Codex):

- **Empty / whitespace-only** → reject with a one-line usage hint:
  `<command-or-skill-name> <one-line summary>` is required. A checkpoint
  without a summary defeats the purpose — re-injection would have nothing
  to surface.
- **Otherwise** → treat the entire argument text as the summary. Trim
  leading/trailing whitespace. Do NOT split on whitespace, do NOT parse
  sub-commands. Multi-word summaries are normal.

**Privacy note**: the checkpoint summary is durable workflow state, not an
external transmission — it is NOT sent to the peer host or web search, so
the peer-dispatch privacy gate does not fire here. Still, keep it free of
raw proprietary identifiers when the workflow file may be shared: no
unreleased feature names, no customer identifiers, no secrets pasted from
frontend code, and never a transcribed screenshot of real customer data. A
checkpoint is a progress pointer, not a data store.

Length: `state.mjs checkpoint-set` does not enforce a hard cap on disk; the
SessionStart hook truncates on display but the on-disk record keeps the
full text. If the argument is unusually long (>1000 chars), warn that
re-injection shows only a prefix; do not silently truncate.

---

## Phase 1 — Locate active workflow

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>/tmp/designer-checkpoint-find.err)"
FIND_RC=$?
```

Branch on the result:

- **Exit 0, empty stdout** → no active workflow; tell the user "*No active
  workflow; nothing to checkpoint.*" and recommend bootstrapping with a
  verb skill (or `/designer:start`) first.
- **Exit 0, single path** → that path is the active workflow. Continue with
  Phase 2.
- **Exit 1, per-branch duplicate error** → reject with a hint pointing at
  the `resume` meta skill (which lists per-branch candidates and archives
  stale ones). Per-branch duplicate is a user-resolvable invariant
  violation per ADR-0018 §sub-2; do NOT pick one yourself.

---

## Phase 2 — Set checkpoint

```bash
node "<plugin-root>/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host <claude|codex> --summary "$SUMMARY"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving (`latest_checkpoint` is a schema-1.1 additive field that
1.0 readers tolerantly ignore; `host_history` gains a `{host, at, event:
checkpointed}` entry per ADR-0011 §1).

Pass `$SUMMARY` as a single quoted argument so embedded whitespace and
special characters survive intact. The CLI rejects empty summaries; Phase 0
already filtered that case.

**Cross-Bash-call note**: shell-variable state (`$ACTIVE`, `$SUMMARY`) does
not survive across Bash tool invocations. If Phase 1 and Phase 2 run in
separate Bash calls, re-resolve both values inside the second call — or
combine them in a single Bash call.

---

## Completion outcomes

- `✓ Checkpoint recorded: <summary>` — Phase 2 succeeded. Surface the
  absolute workflow path so the user can inspect by hand.
- `✗ No active workflow; nothing to checkpoint.` — Phase 1 found nothing.
- `✗ Per-branch duplicate detected — resolve via the resume meta skill
  before checkpointing.` — Phase 1 found more than one workflow.
- `✗ Empty summary; <command-or-skill-name> <summary> required.` — Phase 0
  rejected.

On Claude, the next SessionStart re-injects the summary into the
post-compact session as part of the `[designer-active-metadata]` marker — no
need to re-issue `resume`. On Codex, the next Claude session re-injects (the
on-disk `latest_checkpoint` is host-agnostic); a Codex session re-injects
only when the plugin's hooks are enabled and trusted, per the Host
availability table.

---

## Anti-patterns

- **Recording a checkpoint without a summary.** Re-injection has nothing to
  surface; the checkpoint is dead weight. Phase 0 rejects this.
- **Treating checkpoint as a phase transition.** It does NOT mutate
  `current_phase` or `next_action`. Use a verb skill or `designer:start` to
  advance phases.
- **Bootstrapping a workflow via `checkpoint`.** It requires an active
  workflow. Bootstrap first via one of the six verb skills or the start macro.
- **Bypassing `state.mjs` and editing the workflow file by hand.** The CLI
  guarantees atomic write under the per-file lock and preserves schema;
  hand-edits break those guarantees and may corrupt `host_history`.
- **Pasting proprietary UI text, customer data, or secrets into the
  summary.** A checkpoint is a progress pointer, not a data store.
