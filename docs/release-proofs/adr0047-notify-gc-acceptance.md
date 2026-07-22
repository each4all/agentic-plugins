# Release proof — ADR-0047 Release B (notify GC + citation-aware retention)

**Ship gate for `macro-plan-20260721T020414Z-7c4166` subtask `acceptance`
(verb=critique, profile=full-codebase).** This records that the ADR-0047
**Release B** surface — the `withReclaimLock` locking repair + bounded
expired-claim sweep (§6) and the citation-aware retention planner + M1 deleting
apply executor (§7) — is **implemented, adversarially reviewed, and
safe-validated on this machine**, and it enumerates the **owner-gated** final
acceptance steps (publish the release, install on both host caches, exercise the
real notify/GC matrix, record rollback evidence). Verdict at the bottom.

> **Boundary.** This gate covers *implementation completeness + a safe GC
> plan/apply proof + the release readiness*. The three genuinely
> **owner-gated** acts — (a) merging the release-please PR that publishes the
> new `plugin-runtime`/`plugin-attention` versions, (b) installing those
> versions into the owner's real Claude/Codex plugin caches, and (c) exercising
> the **real** response-needed/approval/filter notification matrix (which sends
> real notifications to the owner's Telegram) and the GC apply path against the
> owner's **real** `.agentic-plugins/runs/` evidence — are **surfaced with exact
> steps, not performed here**. They mutate the owner's machine, publish versions,
> and send real messages; the operator runs them. Cited local run evidence under
> `.agentic-plugins/runs/` is left intact (the apply proof below runs on a
> throwaway fixture, never the real repo).

## 1. What is on `main` and Accepted

ADR-0047 is **Accepted (2026-07-21)**. The Release B code is merged to `main`:

| Section | Surface | Commits (feat + review-fold) |
| --- | --- | --- |
| §1/§2 | `response-needed` notify kind + Stop finality classifier + headline producers | `365fb96`, `c6465d8` (Release A) |
| §6 | `withReclaimLock` non-recursive repair + `sweepExpiredClaims` (bounded/fair, capture-verified) | `1dc3bc4`, `949aa65` |
| §7 planner | `planRetention` read-only (closed registry, 4 fail-closed pins, plan hash) + doctor/dashboard adoption | `123e9a0`, `e9d5a1c` |
| §7 apply | `applyRetention` M1 deleting executor + `runtime:retention` CLI | `1a3c5c6`, `0bdbdd5` |

Export presence verified on `main` (not just a version string):

- `notify-schema.mjs` → `NOTIFY_KINDS` includes `response-needed`; `sweepExpiredClaims` exported (function).
- `retention-planner.mjs` → `planRetention` (function).
- `retention-apply.mjs` → `applyRetention`, `validateDeletionTarget` (functions).

## 2. Release B publication — DONE (step 1)

*(Updated 2026-07-22.)* The accumulated §6/§7 commits (including retention-apply
`0bdbdd5`) were published via release-please PR **#616** (`chore: release main`,
merge `c2bc0f99`) — **owner-authorized and performed**:

| Package | Version | Release B code shipped | Tag / release |
| --- | --- | --- | --- |
| `plugin-runtime` | 0.84.0 → **0.85.0** | §6 `sweepExpiredClaims`; §7 `planRetention` / `applyRetention` / `runtime:retention` CLI | `plugin-runtime-v0.85.0` (Latest) |
| `plugin-attention` | 0.8.0 → **0.9.0** | §1/§2 `response-needed` classifier + headline producers | `plugin-attention-v0.9.0` |

Verified the tags carry the code, not just a version bump:
`git show plugin-runtime-v0.85.0:plugins/runtime/scripts/lib/retention-apply.mjs`
resolves, and `…/notify-schema.mjs` contains `sweepExpiredClaims`. The Claude
marketplace catalog synced to 0.85.0 / 0.9.0 (`validate:versions` green); the
Codex catalog is versionless by design.

The remaining acceptance work — **install on both host caches, post-release
freshness, real-matrix exercise, rollback evidence** (§4 below) — stays
owner-gated (machine mutation + real notifications); it is not performed here.

## 3. Autonomous safe-validation evidence (performed here)

All read-only / throwaway-fixture; the owner's real state is untouched.

**3.1 Retention plan (read-only) on the real repo** — `runtime:retention plan`:
- `scan_complete: true`; a stable `plan_hash`; per family: `doctor` 39 runs / 39
  pinned / **0 actionable** (retention-observed, not deletable at v1 — proof
  reusability needs host state the read-only planner does not gather, ADR §7
  pin-3 amendment), `compat` 34 runs / 17 pinned / **14 actionable**. Deletes
  nothing; writes nothing.

**3.2 Apply dry-run (default) — `runtime:retention apply --family compat`**:
- reports "would delete 14 of 14 candidate(s)" under the pinned ceilings;
  deletes nothing; writes **no receipt**.

**3.3 Safety gate — `apply --family compat --execute` with NO `--expected-plan-hash`**:
- **REFUSED**: "`--execute` requires `--expected-plan-hash` (ADR-0047 §7
  plan-hash binding)". A bare `--execute` cannot delete against an unreviewed plan.

**3.4 Real `--execute` end-to-end on a THROWAWAY fixture** (3 old compat runs,
newest pinned via `latest.json`, cap 1):
- `applied`; **deleted the 2 oldest unpinned runs**, **kept the pinned latest**,
  **kept `latest.json`**; receipt `closed` with every target `completed`.
- Re-run is **idempotent** — nothing left over cap, `deleted: []`.

**3.5 Test + adversarial-review evidence**:
- Full repo suite **5432 pass / 0 fail**.
- The §6 slice was cross-host reviewed and folded (`949aa65`); §7 planner
  reviewed + folded (`e9d5a1c`, 12 MAJOR/6 MINOR); §7 apply reviewed + folded
  (`0bdbdd5`) — the apply review **reproduced 6 CRITICAL + 8 MAJOR data-loss
  bugs** (deletion outside the tree, deletion of newly-pinned runs, a non-mutex
  lock), all closed. Each reproduced attack is an **executable test that passes
  (attack blocked) and bites under mutation**; **22 mutants** RED-verified across
  the retention slice, de-vacuuming 4 double-guard-masked tests.
- *Peer confirmation caveat*: three follow-up confirmation re-reviews failed to a
  codex-side environment error (peer exit 1, truncated stdout, gpt-5.6-sol
  ultra-effort) — not a prompt issue. Closure rests on the mutation-verified
  reproduction tests, which are executable proof rather than an eyeball pass.

## 4. Owner-gated final acceptance steps (the ADR §8 Release B enable sequence)

Perform in order on the machine; each is the operator's to run:

1. **Publish Release B**: merge release-please PR **#616**; confirm the
   `plugin-runtime`/`plugin-attention` tags carry the §6/§7 code.
2. **Install on BOTH host caches** — `claude plugin update` (and the Codex
   equivalent). "Installed" means verified on both limbs (bootstrap/settings
   readiness), because the two caches are separate installations.
3. **Post-release freshness** — re-record the `runtime:doctor --record` proof
   after the version bump, refresh the host-parity baseline, and update the
   doc-freshness tokens (the standard post-release recovery; a version bump
   alone leaves hand-managed docs stale).
4. **Exercise the real matrix** — drive a real response-needed / approval /
   `notify_kinds`-filter sequence and confirm delivery (real Telegram), then run
   `runtime:retention plan` → review the hash → `apply --family compat
   --expected-plan-hash <hash> --execute` against the **real** repo only after
   confirming the actionable set is genuinely uncited, keeping `resolve` handy
   for an interrupted receipt.
5. **Rollback evidence** — record the rollback lever (uninstall/downgrade to the
   pre-B version; the §6 sweep and §7 apply are additive and behind the
   dry-run/plan-hash gates, so B is safe to disable without data migration) and
   the dual-kind window handling per ADR §8.

## 5. Owner-exercised real matrix + GC apply — 実証 (performed 2026-07-22)

The owner authorized and this session performed the §4 real-exercise steps on
this machine (`e16tae.local`; runtime **0.85.0** / attention **0.9.0** installed
on the Claude cache; egress = Telegram via the ADR-0041 env activation). Real
notifications were delivered to the owner's Telegram and 16 real compat run
directories were deleted. Every claim below is backed by an observed artifact —
the egress file-log mirror (`.agentic-plugins/state/runtime/notify/log.ndjson`),
the retention receipt, or a command return. The only tracked change is this
doc; the deleted runs are gitignored state, and the config/shuttle live under
`~/.agentic-plugins/` (outside the repo).

### 5.1 A(1) — real Stop/Notification sensors → real Telegram, kinds distinguished

Drove the **installed** attention sensors (`stop.mjs` / `notification.mjs`,
0.9.0) with the two documented Stop payload shapes and a `permission_prompt`;
each ran the real ADR-0047 §2 finality classifier and spawned the installed
`notify.mjs` (0.85.0) → real `node:https` egress. Classifier verdicts, exercised
against the **real repo** peer-run ledgers (all stale ⇒ `live:false`):

| payload shape | classifier verdict | emitted kind |
| --- | --- | --- |
| `background_tasks:[]`, `session_crons:[]` | `final` (no-interim-evidence) | **response-needed** |
| `background_tasks:[{…running}]` | `interim` (background-tasks-pending) | turn-complete |
| `session_crons:[{…}]` | `interim` (session-crons-pending) | turn-complete |
| neither field observable | `unpromotable` (payload-surface-unobservable) | turn-complete (fallback) |

Delivered egress mirror rows:

| kind | urgency | egress_status | headline |
| --- | --- | --- | --- |
| response-needed | normal | **dispatched** | your-turn |
| turn-complete | normal | **dispatched** | — |
| approval | **urgent** | **dispatched** | needs-approval |

`dispatched` = Telegram API returned `ok:true`. response-needed (final turn) and
turn-complete (interim turn) are distinguished by the real classifier and both
delivered; approval arrives urgent.

### 5.2 A(2) — kinds filter acts before the dedupe stage

Toggled `notify_kinds` and emitted through the real `runEmit` pipeline (real
egress), reading `{status, stage, reason}`:

| window (`notify_kinds`) | emit turn-complete | emit response-needed |
| --- | --- | --- |
| dual-kind `turn-complete,response-needed` | dispatched @ egress | dispatched @ egress |
| response-needed only | **suppressed @ kinds-filter** | dispatched @ egress |

Filter-precedes-dedupe proof (one fixed event_id throughout):
1. response-needed-only, emit turn-complete → suppressed @ **kinds-filter**;
2. dual-kind, emit the SAME event_id → **dispatched** (NOT deduped) — step 1's
   filtered emit never claimed the dedupe slot;
3. dual-kind, emit the SAME event_id a third time → suppressed @ **dedupe**
   (dedupe-duplicate) — the slot is claimed only once a kind passes the filter.

Confirms the §1 pipeline order: kinds-filter (stage 2) precedes dedupe (stage 3),
so a disabled kind consumes no TTL slot.

### 5.3 A(3) — Codex shuttle re-rendered + re-installed → response-needed

`runtime:settings --notification-plan` re-rendered the receiver shuttle (mode
`already-configured` — the Codex user `config.toml` already points `notify=` at
the install path; re-merging is idempotent) and recorded plan artifact
`notification-20260722T031438Z-d94910`. The migration:

| | installed (before) | re-rendered (after) |
| --- | --- | --- |
| `MIN_RUNTIME_VERSION` | 0.83.1 | 0.85.0 |
| emitted kind | turn-complete | **response-needed** |

Re-installed the rendered shuttle over
`~/.agentic-plugins/bin/codex-notify-shuttle.mjs` (the explicit user action —
runtime never installs it) and exercised it with a real Codex
`agent-turn-complete` payload → emitted **response-needed** → egress
**dispatched**. The Codex limb (whose only notify variant is
`agent-turn-complete`) now maps to response-needed per ADR-0047 §5.

### 5.4 B — 16 uncited compat runs deleted under the reviewed plan hash

Read-only plan (`plan_hash sha256:63119f47…4131a`, `scan_complete: true`):
compat 36 runs / 19 pinned / **16 actionable**; doctor 41/41 pinned/0 actionable;
settings 35/35/0. **육안 확인**: every one of the 16 actionable run ids was
independently confirmed absent from all tracked files (`git grep`), while the
docs-cited compat runs (`…5af90f`, `…c44cea`, `…32cdf0`, `…34315e` in
`host-parity-baseline.md` / `DEVELOPMENT.md`) were all pinned, never actionable —
the citation auto-pin held. The 16 are the oldest uncited over-cap runs; deleting
them lands compat exactly at the run cap of 20 (19 pinned + 1 newest-uncited kept
as cap headroom).

Apply (dry-run → `--execute --expected-plan-hash …63119f47…4131a`):

| stage | result |
| --- | --- |
| dry-run | would delete 16 of 16 (writes no receipt) |
| execute | **applied**; deleted 16, conceded 0, failed 0 |
| receipt | `.../retention/compat/receipt.json` **closed** (closed_at `03:17:45Z`), 16 targets all `completed` |
| after | compat 36 → 20 dirs (~114 KB freed); cited runs + `latest.json` intact |
| idempotency | re-plan: compat over-cap=false, **actionable=0** |
| drift guard | re-apply with the now-stale hash → **REFUSED (plan-hash-mismatch)** (recomputed `…23882a3a…`) |

No cited local evidence was touched; only unpinned, over-cap, age-cleared compat
runs were removed. `notify_kinds` was restored to its prior `approval` value
after the exercise.

## Verdict

**Release B is implementation-complete, adversarially reviewed, safe-validated,
AND owner-exercised on the real machine.** §1–§3 established implementation plus
safe validation; §4 enumerated the owner-gated sequence; **§5 records that the
owner authorized and this session performed the real notify matrix (real Telegram
delivery of response-needed / turn-complete / approval, the kinds filter acting
pre-dedupe, and the Codex shuttle's turn-complete→response-needed migration) and
the real GC apply (16 uncited compat runs deleted under the reviewed plan hash,
receipt closed with all targets completed, cited evidence and `latest.json`
intact, and the plan-hash drift guard verified).** What remains genuinely
owner-only is the routine post-bump freshness upkeep and the ongoing rollback
lever (§4 steps 3 and 5), neither of which sends notifications or deletes
evidence. Cited local run evidence is intact; `notify_kinds` restored to
`approval`.
