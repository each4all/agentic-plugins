# ADR-0031 Activation — Firing-Surface Map

**Supporting evidence brief** for the ADR-0031 *activation* track (the
completion-script **sidecar** that actively emits the session-handoff
projection, as opposed to the already-shipped passive projection-model wiring
of PRs #376–#386).

- **Macro plan**: `macro-plan-20260622T034242Z-d416fb` ("ADR-0031 activation impl")
- **Subtask**: `handoff-surface-map` (verb=investigate, profile=analysis)
- **Date**: 2026-06-22
- **Method**: local 3-agent scan + Codex peer ensemble (`investigate-20260622T043327Z-1c378c79`); synthesis verdict **concerns** (peer corrected two local claims, both reconciled by direct source verification)
- **Consumers**: `adr-revise` (revise ADR-0031), `engineer-sidecar`, `orchestrator-sidecar`, `runtime-unsupported-kind`

> **Scope**: this brief *maps where a sidecar can fire and what constrains it*.
> It does **not** decide the wiring approach — that decision belongs to
> `adr-revise`. The design branch is surfaced (§4) as input to that decision.

---

## 1. Engineer completion firing surfaces

| Surface | file:line | Must-run? | stdout contract | Candidate sidecar hook |
|---|---|---|---|---|
| `state.mjs set-terminal` | `plugins/engineer/scripts/state.mjs:3544` | ✅ but **standalone-verb only** (investigate/frame/refine Phase 2 finalize) | **path only** — `process.stdout.write(\`${flags['workflow-path']}\n\`)` | command-runbook footer (never write from inside `state.mjs` stdout) |
| `phase7-commit.mjs --mode execute` | `plugins/engineer/scripts/phase7-commit.mjs:1420` | ✅ but **`/engineer:start` Phase 7 only** | **JSON** — `{ ok: true, landed }` (pretty); plan mode JSON at `:1391` | command footer after success (`start.md:536-548`) |
| `stop-archive.mjs` (Stop hook) | `plugins/engineer/scripts/stop-archive.mjs:112` | ⚠️ conditional (4 gates) | hook writes no success stdout; CLI wrapper emits JSON at `state.mjs:3610-3627` | file/stderr only — cleanup surface, not the primary terminal write |

**Mutual exclusivity (peer-confirmed)**: engineer's two terminal surfaces are
**path-exclusive** — standalone verbs reach `set-terminal`; `/engineer:start`
reaches `phase7-commit` instead. Neither alone covers every completion; the
sidecar must hook **both** to cover all engineer completions.

**Engineer Stop-archive gates** (all AND-combined; `stop-archive.mjs:50-95`):
`terminal_marker === true` → `current_phase ∈ {commit-complete, summary-complete, fix-complete}` → HEAD-moved → no-active-children. An evidence-only
completion (no commit → HEAD unchanged) does **not** trip the HEAD-moved gate,
so the Stop hook will not auto-archive or auto-writeback for it.

---

## 2. Orchestrator completion firing surfaces

| Surface | file:line | Must-run? | stdout contract | Candidate sidecar hook |
|---|---|---|---|---|
| `updateSubtask` auto-terminal | `plugins/orchestrator/scripts/state.mjs:2808` (envelope `:3848-3860`) | ✅ happy-path (last subtask terminal) | **JSON** `{workflowPath, updatedSubtask, autoTerminal}` (+ optional `skipped/skipReason`) | after envelope is parsed/surfaced — file/footer |
| `setMacroTerminal` (set-terminal) | `plugins/orchestrator/scripts/state.mjs:3793` | ✅ finalize/abort Phase 3 | **path only** | command footer |
| `bulkSubtaskStatus` | `plugins/orchestrator/scripts/state.mjs:3024-3090` | ✅ finalize/abort step-1 (gates child-detach) | **JSON** `{workflowPath, transitionedIds}` | — |
| macro `stop-archive.mjs` | `plugins/orchestrator/scripts/stop-archive.mjs:265-291` | ⚠️ conditional (A1–A4) | hook writes no success stdout | file/stderr only |

**Macro auto-archive gates** (A1–A4; `stop-archive.mjs:73-116`):
`terminal_marker` → `current_phase ∈ {commit-complete, finalized, aborted}` →
all subtasks terminal → no active engineer children (fail-closed scan).

**Non-terminal commands**: `/orchestrator:plan` and `/orchestrator:next` do not
set terminal markers (`plan.md`, `next.md` Phase 5 writes `in_progress` only).
`/orchestrator:done` has an **early no-op `exit 0`** (`done.md:112-114`) that
bypasses the normal footer block — the sidecar must account for footer-bypassing
paths.

---

## 3. Binding constraints

### 3.1 Import-cycle (CONFLICT → resolved by direct edge probe)

Local read claimed "no cycle, static import safe"; the Codex peer claimed a
static `state.mjs → session-handoff` import would cycle. **Peer is correct**,
confirmed by direct edge probe of the engineer cluster:

```
session-handoff.mjs → state.mjs          (session-handoff.mjs:25)
session-handoff.mjs → stop-archive.mjs   (session-handoff.mjs:26)
stop-archive.mjs    → state.mjs          (stop-archive.mjs:31)
state.mjs           → session-handoff    = 0 edges today
```

Adding a **static** `state.mjs → session-handoff` import closes a direct cycle
(`state → session-handoff → state`). `state.mjs` **already** avoids exactly this
hazard for stop-archive via a **lazy** `await import('./stop-archive.mjs')`
(`plugins/engineer/scripts/state.mjs:3616`).

> **Constraint**: never add a static top-level `session-handoff` import to
> `state.mjs`. Wire at **command-runbook level** (subprocess → file) or, if it
> must live inside `state.mjs`, use the existing **lazy `await import()`**
> precedent.

### 3.2 Output-compatibility

A sidecar must **not** pollute completion-script stdout — existing contracts are
already parsed by callers:

- `phase7` plan/execute JSON → parsed at `engineer/commands/start.md:471-488` + `tests/engineer/test-phase7-commit.mjs:604-612`
- orchestrator `subtask-update` JSON envelope → parsed at `engineer/scripts/parent-writeback.mjs:438-466`
- engineer `stop-archive` / `detach-archive` JSON → parsed at `orchestrator/commands/finalize.md:224-269`, `abort.md:193-228`

> **Constraint**: sidecar projection goes to a **separate temp file**
> (`--workflow-projection-file`) with **stderr** for diagnostics — never stdout.
> Refuted premise: `/orchestrator:next` does **not** parse `set-terminal` stdout;
> it captures the workflow path via `find-active` (`next.md:345-351`). No current
> production parser consumes `set-terminal` stdout.

### 3.3 Risk-default (fail-closed, non-fatal)

Projection failure must be non-fatal — completion/commit must still succeed.
Precedents: runtime `loadWorkflowProjection` degrades to no projection
(`plugins/runtime/scripts/context.mjs:517-530`); `normalizeProjection` rejects
malformed projections without interpreting partial data (`:858-900`);
stop-archive returns non-throwing failure envelopes
(`engineer/scripts/stop-archive.mjs:11-14`); the orchestrator A4 scan sets a
fail-closed sentinel on error (`orchestrator/scripts/session-handoff.mjs:176-184`).

> **Constraint**: on projection error, return
> `{projection: null, status: 'fail_closed', error, routing}`, write the error
> to stderr, and let the runtime seam degrade to context-risk + routing only.

### 3.4 Reuse, don't duplicate

`session-handoff.mjs` exists in **3 plugins** — engineer/founder near-identical,
orchestrator intentionally divergent (cross-branch macro lookup, A4 child scan,
**no HEAD probe**). The sidecar must **reuse** the existing per-plugin
projection compute, not re-implement it.

**Reusable seam (signatures):**

```
# runtime (L1) — generic composition
context.mjs: loadWorkflowProjection(options) -> { projection|null, error|null }   (:521)
context.mjs: normalizeProjection(raw)        -> { projection|null, error|null }   (:864)
context.mjs: evaluateSessionHandoff({ riskLevel, projection, routing }) -> {...}|null (:789)
footer.mjs:  buildHandoffGuidance({ runId, stale, sourceFreshness, sessionHandoff }) (:755)

# plugin (L2/L3) — fail-closed projection compute
engineer/orchestrator/founder session-handoff.mjs:
  computeEngineerProjection({repoRoot, branch, routing, headSha, headSubject})
  computeOrchestratorProjection({repoRoot, branch, routing, headSubject})   # no headSha (HEAD-independent)
  computeFounderProjection({repoRoot, branch, routing, headSha, headSubject})
  -> { projection, status, routing, error? }
```

---

## 4. Design branch for `adr-revise` — WHERE to fire the sidecar

A genuine 2-branch decision (surfaced per ADR-0029 §2; compact 4-axis lens —
decision deferred to `adr-revise`):

| Axis (role) | (A) command-runbook level (subprocess → file) | (B) inside `state.mjs` via lazy `await import()` |
|---|---|---|
| Essence (본질, decisive) | ✅ fires at completion, directly | ✅ same goal |
| Foundation (근본, decisive) | ✅ zero cycle risk · preserves output-compat invariant · reuses seam | ⚠️ eval-order fragility · requires lazy-import discipline |
| Practical-fit (실용성) | ✅ matches existing `--workflow-projection-file` pattern | ⚠️ must handle footer-bypass paths (`/done` no-op, conditional stop-archive) |
| Entry-routing-guarantee (진입경로보증) | ✅ clear verify/rollback per runbook step | ⚠️ hooks scattered across every firing surface |

The lens leans **(A) command-runbook level**, but the call is `adr-revise`'s.

---

## 5. Top gotchas for the implementer

1. **Never write sidecar data to stdout** — JSON/path contracts are already parsed (§3.2).
2. **Never add a static `state.mjs → session-handoff` import** — it cycles through `stop-archive` (§3.1); use runbook-level or lazy import.
3. **Stop-hook archive is conditional and non-fatal, and `/done` has an early no-op `exit 0`** — active handoff must cover paths that never reach the normal footer block (§2).
