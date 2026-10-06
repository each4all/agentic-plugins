### The bounded projection schema (input (b))

Each onboarded persona — engineer, orchestrator, founder and designer (the
seam accepts all four kinds, ADR-0043 §1) — reads its **own** workflow state
(its own `state.mjs read` / `find-active`; orchestrator macros resolve via
`find-macro`, never `find-active` on a subtask branch) and emits a bounded
projection. The seam consumes it as a single `--workflow-projection-file` JSON
object (mirroring the existing `--subtasks-json-file` file-passing pattern),
never as per-field flags. This contract fixes the **fields, their semantics,
and the fail-closed rule**; the footer rendering is the runtime's. The
projection carries **only** these fields, and only **generic semantic**
values:

| Field | Meaning | Notes |
|---|---|---|
| `workflow_kind` | `engineer` \| `orchestrator` \| `founder` \| `designer` | The owning layer — the only discriminator the runtime sees (four-persona seam per ADR-0043; a kind outside the enum degrades honestly on the runtime side). |
| `workflow_id` | The active workflow id | Pointer only. |
| `workflow_path` | Path to the workflow file | Pointer only; the runtime does not read it. |
| `phase` | Current phase label | Generic string, for the prompt. |
| `next_action` | The workflow's recorded next action | Generic string. |
| `checkpoint` | Latest checkpoint summary | Optional; omitted when none. |
| `archive_gate` | `ready_to_archive` \| `blocked` \| `not_terminal` | Generic readiness state; mapping below. |
| `routing_recommendation` | The input-(c) route | Same value as (c); carried here when a workflow exists. |

**Computing `archive_gate`.** The owning surface first gathers the pure
evaluator's inputs — a persona probes the git HEAD (`headSha`), the
orchestrator runs its child scan (`noActiveEngineerChildren`) — then calls its
**pure** evaluator (`evaluateStopArchive` / `evaluateMacroStopArchive`, each in
its plugin's `stop-archive.mjs`; never the side-effecting Stop runner) and
collapses the `{shouldArchive, gateFailures}` verdict to one generic value:

- `ready_to_archive` — `shouldArchive === true` (`gateFailures` empty).
- `not_terminal` — `gateFailures` contains `terminal_marker` (the workflow has
  not been marked terminal yet; work in progress).
- `blocked` — `shouldArchive === false` **without** a `terminal_marker` failure:
  terminal-marked but another gate is unmet (a persona's `terminal_phase` /
  `head_moved` / `no_active_children`; the orchestrator's
  `all_subtasks_terminal` / `no_active_engineer_children` /
  `macro_terminal_phase`) — archivable *soon* but awaiting a commit or active
  children. If the gate **cannot be computed** (HEAD probe or child scan
  fails), the surface reports `blocked` conservatively, carrying the reason,
  rather than guessing readiness.

**Fail-closed.** If the owning plugin's state read is ambiguous or corrupt (a
case its state manager already fails closed on), the surface **omits the
projection entirely** (degrading to (a)+(c)) and surfaces the reason; it never
emits a half-trusted projection. The seam likewise treats a malformed
projection (invalid JSON, missing required field, unknown `workflow_kind` /
`archive_gate`, empty pointer, or out-of-repo `workflow_path`) as **absent +
reported**, never interpreted.

The seam treats every field as opaque: it renders them, it does not re-derive
per-persona semantics from them. A future persona passes the same shape once
its kind joins the seam enum (the ADR-0043 onboarding pattern); an unknown
kind degrades honestly without the runtime learning its schema.
