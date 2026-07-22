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

## 2. Release B publication — the owner-gated release step

The accumulated §6/§7 commits are bundled in the **open** release-please PR
**#616** (`chore: release main`). `main` currently carries `plugin-runtime`
**0.84.0** and `plugin-attention` **0.8.0**; the installed caches match 0.84.0 /
0.8.0, i.e. **Release B is on `main` but not yet published/installed**. Merging
#616 bumps the versions, tags the release, and syncs the catalogs (the standard
release-please flow). *This merge is an owner decision — it publishes versions.*

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

## Verdict

**Release B is implementation-complete, adversarially reviewed, and
safe-validated** (read-only plan + throwaway `--execute` e2e + the plan-hash
safety gate, full suite green, 22 retention mutants RED). The remaining
acceptance work is the **owner-gated** publish/install/real-exercise/rollback
sequence in §4 — surfaced with exact steps, deliberately not performed here
because it publishes versions, mutates the machine, and sends real
notifications. Cited local run evidence is intact.
