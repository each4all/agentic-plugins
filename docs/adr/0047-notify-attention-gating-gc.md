# ADR-0047: Response-needed notification signal + bounded notify/artifact GC

## Status

Accepted (2026-07-21)

<!--
This ADR sits inside the ADR-0024 runtime/operator control-plane track. It
composes — and narrowly amends where stated — ADR-0035 (execution-boundary
policy), ADR-0040 (operator observability), ADR-0041 (egress + §3a headline),
ADR-0044 (session capture), and ADR-0045 (entry-time surfaces). Amendments
carried here, each scoped and named per the ADR-0045 §2 governance pattern
("silence was the blocker pattern; name the authorizations"):

  - ADR-0040 §1 Amendment (Decision §1/§3): the kind enum gains
    `response-needed`; the bare-Stop mapping row splits into final →
    `response-needed` / interim → `turn-complete`.
  - ADR-0041 §3a Amendment, narrow (Decision §4): the producer-signal
    domain widens from the recognized `(kind=workflow-terminal,
    archive_gate)` combinations to two additional structural signals — the
    Decision §2 final verdict (kind-total mapping to `your-turn`) and the
    `Notification/permission_prompt` matcher (mapping to `needs-approval`).
    The vocabulary, both guards, the default-OFF opt-in, and the
    Claude-limb-only v1 scope are unchanged.
  - ADR-0035 §4 exemption registration (Decision §7): the artifact-retention
    apply executor joins the enumerated ADR-gated deletion exemptions (the
    same model ADR-0040 §2 used for claim/log retention and ADR-0044 §3 used
    for capture-lock cleanup). The §4 ceiling text itself is unchanged.
  - ADR-0040 §2's retention authorization (TTL-expired dedupe claims +
    log rotation are "routine deletions of runtime-owned notify state") is
    NOT re-authorized — Decision §6 implements it with explicit bounds and
    the same reclaim-lock protocol the claim machinery uses.

Implementation is staged by `macro-plan-20260721T020414Z-7c4166`: this ADR is
subtask `adr`'s deliverable; subtasks `compat-watch`, `signal-runtime`,
`signal-runtime-release`, `signal`, `claim-gc`, `retention-core`,
`retention-apply`, and `acceptance` implement against it. Decision §8 maps
the two-release rollout onto that dependency graph explicitly.

Flipped to Accepted 2026-07-21 on merge of the authoring PR #609 (squash
4faa2da), per the ADR process §3 merge-time default (#554/#586 precedent).
Authored as macro subtask `adr` of `macro-plan-20260721T020414Z-7c4166`;
acceptance gates the remaining implementation subtasks (`compat-watch`
onward) rather than following them — none had shipped at flip time.
-->

## Context

### 1. Every bare Stop looks the same, so operators cannot filter for "your turn"

The Claude `Stop` sensor (ADR-0040 §3, `plugins/attention/adapters/claude/
hooks/stop.mjs`) reads exactly three payload fields — `cwd`, `session_id`,
`prompt_id` — and branches on persona-projection freshness alone: a fresh
terminal workflow projection emits `workflow-terminal`; everything else is a
bare `turn-complete`. There is no interim/final discrimination anywhere in
the pipeline. A Stop fired while background work is still running (peer
dispatches in flight, scheduled wakeups pending — the agent is *not* waiting
on the user) and a Stop that genuinely ends the agent's turn (the user must
respond for work to continue) produce byte-identical `turn-complete` events.

The operator-facing consequence is structural, not cosmetic: the 2026-07-21
seven-item diagnosis traced notification noise on this machine to exactly
this — `notify_kinds` defaults to `null` (all kinds), and the only remedy the
current taxonomy offers is disabling `turn-complete` entirely, which also
silences the one signal the operator most wants ("the agent is waiting on
you"). `notify_kinds` filters exact kind names only
(`plugins/runtime/scripts/lib/notify-schema.mjs:346-372`; unknown tokens are
a hard parse error, there is no status- or predicate-level filtering), so a
filterable "response needed" signal **must** be a kind, not a status
refinement — a status token on `turn-complete` would be invisible to the
filter by construction.

Meanwhile the structural evidence needed to discriminate exists and is
unconsumed: Claude Code **2.1.145** added `background_tasks` /
`session_crons` to `Stop`/`SubagentStop` hook input
(`plugins/runtime/docs/host-parity-baseline.md:97`; the recorded baseline is
2.1.215 / Codex 0.144.6 as of 2026-07-20, so the fields are available on the
supported floor), and the four persona peer-run ledgers
(`.agentic-plugins/state/<persona>/peer-runs/<run_id>/handle.json`, with a
still-supported legacy home per the peer-runner's dual-home resolution,
ADR-0023) carry non-terminal statuses
(`queued|spawning|running|cancel_requested`) plus recorded PIDs
(`plugins/engineer/scripts/peer-runner.mjs:40-51`) that a Stop-time
classifier can consult as a filesystem fallback.

### 2. The `your-turn` / `needs-approval` headline tokens exist but have no producer

ADR-0041 §3a shipped the closed headline vocabulary (`your-turn`,
`needs-approval`, `in-progress`, `blocked`, `complete`, `failed` —
`notify-schema.mjs:83-90`), both guards (producer map-or-omit in
`plugins/attention/scripts/lib/sensor.mjs:142-161`; runtime validate-or-drop
via `isHeadlineToken`), and the default-OFF egress opt-in. But
`deriveHeadlineToken` returns `null` for every kind except
`workflow-terminal`, and the `Notification` sensor
(`adapters/claude/hooks/notification.mjs:58-69`) builds the `approval` event
with no headline at all. Two of the six vocabulary tokens — the two that
answer "do I need to pick up my phone" — are unreachable dead vocabulary.

### 3. Codex approval attention has no ingress path at all

The Codex `notify=` program hook delivers exactly one event type:
`agent-turn-complete` (`plugins/runtime/receivers/codex-notify-shuttle.mjs:158`
returns on everything else). `approval-requested` exists only in the
`tui.notifications` enum (`plugins/runtime/scripts/lib/notification-plan.mjs:85-87`)
— a Codex-native TUI display setting, never delivered to the program hook.
There is no payload to map, and inventing one would violate the
source-verification discipline that ADR-0030 established after the
`plugin_hooks` drift incident. Separately, Claude **2.1.198** added
`agent_needs_input` / `agent_completed` `notification_type` values, recorded
in the parity baseline (`host-parity-baseline.md:272`) as "candidate future
attention signal, not a break" — a second unwatched evolution surface on the
same problem, and one that version-drift-triggered compat analysis will
never resurface on its own because the drift already happened.

### 4. The notify dedupe state has one real locking defect and two accumulation/observation defects

- **`withReclaimLock` provides no mutual exclusion** —
  `notify-schema.mjs:629` acquires its lock with
  `fs.mkdirSync(lockDir, { recursive: true })`, and `recursive: true` never
  raises `EEXIST`, so the contention branch (`:631-643`) is unreachable and
  two concurrent finalizers both "acquire" the lock (last `owner` write
  wins). The neighboring `claimDedupe` reclaim path (`:529`) and the log
  rotation lock (`notify.mjs:287`) use non-recursive `mkdirSync` and are
  correct — this is a single defective instance, not a systemic pattern, but
  the repair slice must still sweep the repo for mirror instances of
  recursive-mkdir-as-lock per the fix-the-mirror convention.
- **Expired `.claim` files accumulate without bound** — a claim is deleted
  only by `releaseClaim` (egress failure) or replaced on reclaim of the
  *same* `event_id`; a subject that never recurs leaves its claim file
  forever. The dashboard already diagnoses the symptom
  (`dashboard.mjs:436-439,514-516` "stale claim buildup … a claim for a
  subject that never recurs is never reclaimed") but nothing removes them —
  ADR-0040 §2 explicitly authorized this deletion ("TTL-expired dedupe claim
  files … are routine deletions of runtime-owned notify state") and the
  authorization has never been implemented.
- **A concurrently-vanishing claim reads as `blocked`** — the dashboard's
  readdir-then-stat walk counts any stat failure as `unreadable`
  (`dashboard.mjs:481-484` via `statIfExists`, which does not distinguish
  `ENOENT`), and any `unreadable > 0` flips the whole notify-state status to
  `blocked` (`:537`). A claim legitimately unlinked between `readdir` and
  `stat` by a concurrent emit is a normal race, not a health fault. The
  dashboard and the claim logic also disagree at the TTL boundary (`>` vs
  `<` — `dashboard.mjs:493`, `notify-schema.mjs:519-520`), a discrepancy any
  new deleter must not inherit.

### 5. Run artifacts only grow, while committed docs and other artifacts cite them

No code deletes anything under `.agentic-plugins/runs/` today. The
doctor/dashboard artifact inventory (`state-readers.mjs:701-760`, caps 20
runs / 50 MiB per family) is explicitly advisory — *"no retention, cleanup,
deletion, or compaction happens in runtime:doctor"* (`:848-853`) — and the
only real deletion precedents live elsewhere: the peer-run ledger sweep
(state/, TTL 14 d + cap 200) and the in-frontmatter `ensemble_results` prune
(cap 20). At the same time, committed documents cite gitignored local run
ids as evidence: `docs/DEVELOPMENT.md:440` names
`doctor-20260720T175310Z-a0fd88` as the latest installed proof;
`docs/assurance/omcc-cutover-scorecard.md` cites 20+ doctor run ids (both
backticked and bare); `docs/assurance/runtime-consensus-dogfood-2026-05-29.md`
cites a full `.agentic-plugins/runs/consensus/<id>/` path as a "reproducible
reference for cross-session verification". Run artifacts and their readers
also reference runs beyond each family's `latest.json`: recorded doctor
artifacts snapshot the whole sanitized report — including other families'
evidence ids — into `doctor.json` (`doctor.mjs:4888-4902`); cutover evidence
records operator-supplied artifact pointers (`cutover-audit.mjs:359-376`);
settings persists **non-terminal** `planned`/`in-progress` execution
artifacts that doctor later surfaces as interrupted executions
(`settings.mjs:1449-1469`, `doctor.mjs:1776-1805`); and dashboard/doctor
readers deliberately select *older-than-latest* runs (hook attestations,
reusable doctor proofs — `dashboard.mjs:328-377`, `doctor.mjs:1906-1920`).
A naive cap-based GC would delete cited or still-load-bearing evidence; the
ADR-0035 §4 ceiling ("never delete artifacts as part of
status/cancel/cleanup") forbids shipping it as a side effect of anything.

### 6. Prior decisions bound the solution space

ADR-0035 (§1 read-only default; §2 tiers R0/M1/H2/H3; §3 per-executor
invariants including finite bounded execution; §4 ceiling with the ADR-gated
owned-state exemption model; §5 add-gate) governs every new mutation.
ADR-0040 owns the notify pipeline and the §1 kind/subject contract. ADR-0041
§3a owns the headline vocabulary, guards, and opt-in. ADR-0044 fixed the
Stop hot-path shape (capture before notification; the 36 s budget is the
code contract at `sensor.mjs:517-532` — 12 s emit slots, pinned by
plugin-shape tests) and rejected transcript semantics (Alt E). ADR-0043
established the released-only capability-floor rule ("floor = first released
runtime version containing the contract, never pinned pre-release") and
ADR-0044 the "two gates never share a constant" floor-separation rule.
ADR-0045 rejected mtime-recency as an activity signal and established
honest-refusal degradation. ADR-0046 established write-ahead ordering with a
presented-plan hash that the executor refuses to drift from.

## Decision

### 1. `response-needed` is a new notification kind

The filterable identity is a **new kind `response-needed`** appended to
`NOTIFY_KINDS` — not a status refinement of `turn-complete` (invisible to the
exact-kind filter, Context §1) and not a repurposing of `approval` (approval
is a mid-turn host prompt; response-needed is an end-of-turn state).

Contract details, all following the ADR-0040 §1 mapping discipline:

- **Subject**: `session:<session_id>:<prompt_id>` on the Claude limb — the
  same two documented common input fields `turn-complete` uses; the
  classifier never adds Stop-specific payload material to the subject. On
  the Codex limb the existing shuttle subject namespace `codex-turn:<turn-id>`
  is preserved (Decision §5). The two namespaces cannot collide.
- **Status**: `response-needed` joins `KINDS_WITH_DEFAULT_STATUS` (fixed
  `fired` token) — like `approval`/`idle`/`turn-complete` it marks a moment
  with no natural terminal status.
- **Urgency**: `normal`. `approval` remains the only urgent-by-contract kind.
- **Dedupe**: standard TTL claim; `kind` differing from `turn-complete`
  keeps the keys distinct even on identical subjects. The hostname
  uniformity invariant is unaffected: the attention sensor remains the sole
  producer of the hostname-bearing Claude-limb kinds and passes hostname on
  `response-needed` exactly as it does for `turn-complete`; the Codex
  shuttle's subject namespace disjointness (`codex-turn:`) means the two
  limbs never observe the same moment.
- **Single source of truth**: the enum change lands in
  `notify-schema.mjs` and in attention's copy-not-import sensor parallel
  (`sensor.mjs:54-62`), with the existing parity test extended — per
  ADR-0010 §5 there is no cross-plugin import to update.

The operator remedy for the Context §1 noise problem becomes expressible:
`notify_kinds = "response-needed,approval,workflow-terminal"` (or any
subset) — interim `turn-complete` chatter is filterable without losing the
your-turn signal. (During rollout the operator keeps `turn-complete`
alongside it — Decision §8's dual-kind window.)

### 2. The Claude structural classifier matrix

At a bare Stop (no fresh terminal projection — Decision §3 handles the
non-bare case), the sensor classifies **interim vs final** from structural
evidence only, in this order:

| # | Evidence source | Reading | Verdict contribution |
|---|-----------------|---------|----------------------|
| 1 | `payload.background_tasks` (Stop input, Claude ≥ 2.1.145) | enumerate; any entry not in a completed/terminal state | non-empty incomplete set ⇒ **interim** |
| 2 | `payload.session_crons` (same) | enumerate; any pending/scheduled session cron implies the session resumes itself | non-empty ⇒ **interim** |
| 3 | Peer-run ledger fallback: **both** the canonical and legacy peer-run homes (the peer-runner's own dual-home set) for all four `SENSOR_PERSONAS` | a non-terminal handle is **live** when: status `running|cancel_requested` with a recorded PID that answers `process.kill(pid, 0)`; or status `queued|spawning` (no PID yet by design, `peer-runner.mjs:380-395,684-686`) with `updated_at` inside the ledger's own stale-grace window | any live handle ⇒ **interim** |
| 4 | None of the above observable | — | **no promotion** (see below) |

- **Verdict rule**: any interim evidence ⇒ emit `turn-complete` (unchanged
  shape, no headline). **Final** — and therefore `response-needed` with the
  `your-turn` headline — requires ALL of: at least one payload field (row
  1/2) observable **and well-formed** (an array; a present-but-null, scalar,
  or otherwise malformed field is *unobservable*, never "empty"), no interim
  evidence from any row, and a **complete** row-3 scan.
- **Scan-completeness contract (row 3)**: the ledger scan is complete only
  when every consulted home directory was readable, no handle read failed
  or was malformed, no handle carried a future-skewed timestamp, the
  per-persona handle cap and the aggregate time budget were not exhausted,
  and no persona presented the peer-runner's own ambiguous dual-home state.
  **Any incomplete scan blocks promotion** (the Stop degrades to
  `turn-complete`) — a live handle hiding beyond a cap must not produce a
  false final. Handle reads use the existing bounded-read guard shape
  (regular file, size cap, no special files — the `sensor.mjs:895-907`
  pattern) so a planted FIFO cannot stall Stop.
- **No process fingerprinting in the classifier**: row 3 uses recorded
  handle fields and the zero-cost `process.kill(pid, 0)` probe only — it
  never runs the ledger's `ps`-based fingerprint verifier (an unbounded
  spawn, `peer-runner.mjs:475-515`). A PID reused by an unrelated process
  therefore reads as live ⇒ interim — an accepted false-negative-direction
  error, consistent with the conservative policy; the classifier adds **no
  new spawn** to the Stop hot path.
- **Conservative false-negative policy**: when neither payload field is
  present (host below 2.1.145, malformed payload) — regardless of what row
  3 says — the sensor does **not** promote: absence of the payload surface
  means the primary evidence class is unobservable, and the sensor emits
  the bare `turn-complete` exactly as today. Classifier errors of any kind
  degrade the same way (fail-closed observer, ADR-0040 §7). Repo-scoped
  row-3 false negatives (below) are accepted behavior, not classifier
  errors — docs and any metrics must not count them as defects.
- **Payload schema verification**: the parity baseline records the fields'
  existence, not their shape. The `signal` implementation slice MUST
  source-verify the 2.1.145+ field schema against a live payload (probe
  matrix, ADR-0045 §7 precedent) before wiring row 1/2 predicates, and
  record the observed shape in `host-parity-baseline.md`. If the observed
  shape cannot distinguish incomplete entries, the affected row degrades to
  "present ⇒ unobservable" (row 4), never to a guess.
- **Session-correlation limits, stated honestly**: peer-run handles carry no
  session identity, so row 3 is repo-scoped — a live peer run from a
  *different* session in the same repo reads as interim. This is accepted:
  it errs in the conservative direction (suppressing `response-needed`,
  never fabricating it). The limit is documented in the sensor and in the
  attention README rather than "fixed" with heuristics.
- **Bounded**: per-persona handle caps (newest-first by directory mtime),
  an aggregate time budget, and the read guards above are implementation
  constants pinned by the plugin-shape test alongside the existing four
  budget constants; the classifier runs inside the existing Stop emission
  slot and adds no slot to the `sensor.mjs:517-532` 36 s contract.
- **No transcript semantics**: the classifier never opens
  `transcript_path` — ADR-0044 Alt E's rejection (injection/secrets surface,
  host-format coupling) applies verbatim and is not relitigated here.

### 3. Event precedence at Stop: exactly one signal class

Per Stop, the sensor selects **exactly one signal class**:

1. Fresh workflow projection(s) exist ⇒ the **workflow-terminal branch**: a
   bounded batch of `workflow-terminal` events, one per fresh persona
   projection, exactly as today (including their archive-gate headlines and
   the ADR-0043 §3 two-slot batching). No `response-needed`, no
   `turn-complete` — this branch already carries the user-facing signal for
   the turn, whatever the gate value: `ready_to_archive`/`blocked`
   projections announce a workflow needing the user, and a fresh
   `not_terminal` projection (headline `in-progress`) announces live
   workflow activity that makes a simultaneous bare-Stop signal redundant.
   Suppressing the bare signals behind a fresh `not_terminal` projection is
   an explicit v1 decision (it preserves today's behavior; revisit only
   with dogfood evidence that a your-turn signal is being lost behind
   long-lived fresh projections).
2. No fresh projection, classified **final** ⇒ one `response-needed`.
3. No fresh projection, classified **interim** (or unpromotable, Decision
   §2) ⇒ one `turn-complete`.

`turn-complete` and `response-needed` are therefore mutually exclusive by
producer rule (the **no-duplicate default**) — dedupe cannot enforce this
(different kinds build different keys), so the contract lives in the sensor
and is mutation-tested there. `subagent-complete`, `approval`, `idle`, and
the capture spawn ordering (ADR-0044 §2) are untouched. (A Claude
`idle_prompt` some seconds after a final Stop remains a separate kind on a
separate moment, exactly as it was alongside `turn-complete`; operators
filter it with `notify_kinds` as before.) `turn-complete`'s meaning narrows
from "a turn ended" to "an interim turn ended"; the kind name, subject,
status, and schema are unchanged (ADR-0040 §1 Amendment records the
narrowed row).

### 4. Headline producer contracts: `your-turn` and `needs-approval`

Both wirings extend ADR-0041 §3a's producer-signal domain — the **narrow
§3a amendment named in the Status note**. The vocabulary, Guard 1 (producer
map-or-omit), Guard 2 (runtime validate-or-drop), the default-OFF egress
opt-in, and the Claude-limb-only v1 scope are all unchanged; what widens is
only which structural signals may born a token:

- **`your-turn`**: born only on the Decision §2 **final** verdict —
  `deriveHeadlineToken` gains the mapping `kind === 'response-needed'` ⇒
  `'your-turn'`. The kind itself already encodes the structural verdict, so
  the map is total for this kind; map-or-omit is preserved because an
  uncertain classification never produces the kind in the first place.
- **`needs-approval`**: born on the `Notification/permission_prompt` path —
  the `approval` event gains `headline: 'needs-approval'`. The host's
  `notification_type` matcher IS the structural signal (no inference), so
  map-or-omit is preserved by the same argument. The `idle_prompt` path
  stays headline-free.
- `turn-complete` remains headline-free (now doubly so: it marks interim
  turns). Headlines remain egress-display fields behind the §3a opt-in;
  local channels are unaffected.

### 5. Codex limb: mapping migration + approval compat trigger

- **`agent-turn-complete` remaps to `response-needed`** — recorded as an
  **accepted approximation**, not a source-verified equivalence: the
  verified Codex behavior (ADR-0040 §4 evidence) is that `notify=` fires
  after a completed turn and not during approvals; whether every such turn
  "awaits input" (e.g. the final turn of a non-interactive `codex exec`) is
  not established. The approximation is accepted because a completed Codex
  turn with nobody watching is at worst an early your-turn, never a lost
  one, and the alternative (keeping `turn-complete`) buries the Codex limb
  under the interim semantics this ADR narrows that kind to. The receiver
  shuttle (runtime-owned render-input data, `codex-notify-shuttle.mjs`)
  changes kind only; subject (`codex-turn:<turn-id>`), status (`fired`),
  source (`codex-notify`), and the no-headline posture are preserved.
  Operators re-render and re-install the shuttle via the existing
  `runtime:settings --notification-plan` flow after the runtime upgrade
  (rollout §8) — an older installed shuttle keeps emitting `turn-complete`,
  which the new runtime still accepts, so the migration degrades softly
  provided the §8 dual-kind window is open.
- **Approval variant stays a silent no-op until source-verified**: no
  approval payload reaches `notify=` today (Context §3), so the shuttle's
  unknown-type behavior (return without output) is contractual, not an
  accident. The `compat-watch` subtask adds a notification-specific watch
  surface to `runtime:compat` covering: (a) any Codex `notify=` payload
  variant beyond `agent-turn-complete` (especially approval/permission
  shapes), and (b) the Claude `agent_needs_input` / `agent_completed`
  notification types. Because (b) is *already* in the recorded baseline
  (`host-parity-baseline.md:272`) and compat's gap analysis activates on
  version drift and newly-ingested release notes (`compat.mjs:332-376`),
  the watch MUST be a **seeded standing row** evaluated on every compat
  plan run — not a keyword that only fires on future drift — so the
  historical known gap stays visible until resolved. Each watch hit
  produces a planning row, never an automatic mapping; wiring a
  newly-observed variant requires a source-verified payload and its own
  follow-up decision (ADR-0030 discipline).

### 6. Bounded expired-claim sweep + locking repair (realizing ADR-0040 §2's authorization)

- **Repair `withReclaimLock` first**: the lock acquisition becomes
  non-recursive `mkdirSync(lockDir)` (the `claimDedupe:529` shape) so
  `EEXIST` is reachable and mutual exclusion is real. The repair slice
  sweeps the repo for mirror instances of recursive-mkdir-as-lock (per the
  fix-the-mirror convention); `claimDedupe` and `maybeRotate` are already
  verified correct.
- **Sweep placement and sub-order**: inside `runEmit`, at the dedupe stage —
  strictly **after** the effective-channel gate (`none` ⇒ no sweep: an off
  system leaves no notify state and touches none, ADR-0040 §2) and **after**
  the kinds filter (a filtered-out event does no maintenance work). The
  sub-order is pinned: the current event's `claimDedupe` runs **first**;
  the bounded sweep attempt runs after it regardless of claim outcome
  (claimed or deduped both do maintenance), always **excluding the current
  event's claim path**; the emit result is computed from the claim outcome
  alone. One sweep attempt per emit that reaches the dedupe stage — never a
  standalone daemon, command, or hook, and no new executor: this is the
  bounded implementation of the deletion ADR-0040 §2 already authorized.
- **Sweep locking protocol** (the load-bearing rule): a sweep may unlink an
  expired claim **only while holding that claim's `.reclaim.lock`**,
  acquired with the same non-recursive-mkdir protocol as the (repaired)
  claim machinery, with an mtime re-check inside the lock; `EEXIST` ⇒
  concede that entry (a live reclaimer/finalizer owns it). Without the
  lock, a sweep unlink can interleave with `claimDedupe`'s reclaim window
  (`notify-schema.mjs:555-585` re-checks mtime once at lock entry, then
  unlinks) such that the reclaimer destroys a *fresh* claim a third emitter
  just created — two `claimed: true` returns for one TTL window, the exact
  double-fire ADR-0040 §1 forbids. Stale sweep-side locks follow the
  existing sweep-for-the-next-caller-and-concede rule. After this ADR,
  exactly one lock protocol governs all three claim mutators (reclaim,
  finalize, sweep).
- **Sweep targets and shared predicates**: only regular files matching the
  `*.claim` name shape, whose mtime exceeds the effective
  `notify_dedupe_ttl_seconds` **plus a fixed safety margin**
  (`gc_eligible`), and stale `.reclaim.lock` directories older than
  `lockStaleMs`. The expiry predicates are exported from `notify-schema.mjs`
  and consumed by both the sweep and the dashboard so the two never
  disagree again (the dashboard keeps reporting TTL-`expired` counts as
  advisory; `gc_eligible` — TTL + margin — is the deletion predicate; the
  existing `>` / `<` boundary discrepancy is resolved in the shared
  predicate). Fresh claims, live locks, and any non-conforming entry
  (unexpected name, symlink, non-regular file) are never touched.
- **Bounds and fairness**: per-emit caps on entries examined and deletions
  performed, plus a wall-clock cutoff — implementation constants pinned by
  test. Enumeration starts from a rotating position (persisted cursor or
  equivalent randomized start), so a backlog whose head is perpetually
  fresh cannot starve the tail; convergence over successive emits is a
  tested property, not a hope. A per-entry sweep failure is contained: it
  never changes the current emit's outcome (a successfully-claimed
  notification must not report `failed at dedupe` because janitorial work
  hiccupped).
- **Observer semantics unified with the dashboard**: a path that vanishes
  between `readdir` and `stat` is a **concurrent change** — skipped, not
  counted — in both the sweep and `inspectNotifyState` (`ENOENT` from the
  stat probe stops flipping status to `blocked`; genuinely unreadable
  entries — `EACCES`, `EIO` — keep doing so).
- **Transition window, accepted and named**: until every long-lived
  pre-repair process exits, an old-protocol finalizer (whose recursive
  `mkdirSync` ignores the sweep's lock) can resurrect a just-swept claim by
  rewriting it (`promoteClaim`'s in-lock rewrite). The effect is bounded
  over-suppression — one ghost claim, removed by a later sweep, never a
  double-fire — and is accepted for the rollout window rather than gated on
  process quiescence.

### 7. Citation-aware artifact retention: read-only planner + explicit apply (M1)

Retention over `.agentic-plugins/runs/` splits into two surfaces with a hard
boundary between them:

- **Planner (`retention-core`)**: pure read-only computation — it deletes
  nothing. It produces, per family: the run inventory, the **pin set** with
  per-run pin reasons, a **`scan_complete` verdict** (below), the
  **actionable excess** (over-cap, unpinned — deletable), the **pinned
  overage** (over-cap but pinned — *informational only*, never a warning
  that asks the operator to act against a pin), and a **canonical plan
  hash** covering the registry + scanner versions, effective caps, the pin
  set, and the ordered deletion list. Doctor/dashboard artifact-attention
  surfaces adopt the actionable/pinned split so "over cap because cited"
  stops reading as a fault. Retention caps mean what the inventory already
  means — **total** runs (and bytes) per family, pins included; when pins
  alone exceed a cap, everything is `pinned_overage` and nothing is
  deletable. Deletion candidates are ordered oldest-first by run-id
  timestamp, and must additionally clear a **minimum-age guard**
  (implementation constant): a recently-written run is never a candidate
  regardless of cap pressure, which is the first half of the
  writer-coordination story (below).
- **`scan_complete` (fail-closed pin scanning)**: every pin source degrades
  the same way — if tracked-file enumeration fails or its file/byte caps
  are exhausted before completion, if any tracked citation file is
  unreadable, if a family's `latest.json` is missing-but-referenced,
  unreadable, or malformed, if a cross-artifact source (below) is
  unreadable or malformed, or if any family artifact needed for pin 3/4
  evaluation cannot be read — the planner records `scan_complete: false`
  with the reason, and **apply refuses to run** against such a plan. An
  unscannable citation source is treated as potentially citing everything.
- **Closed family registry**: v1 scope is exactly
  **`doctor`, `compat`, `settings`** — runtime-owned, `latest.json`-bearing
  families. Excluded, each for a named reason: `consensus` (in-run
  integrity hub: manifest/owner-decision/ratification pointers gate live
  command behavior), `context` (entry-brief pointer target, no latest
  pointer), `cutover` (evidence records operator-supplied pointers into
  other families), `notification`/`permission`/`egress-launcher`
  (operator-plan records; candidate second slice after v1 proves the pin
  scanner), `bootstrap` / `profiles` (machine-scoped home, ADR-0046
  contract §10; profiles are operator input and retention-exempt), `image`
  (owned by `plugins/image`, not runtime), and every unknown/discovered
  directory (inventory stays advisory there). Only **validated run-id
  directories** of a registry family are ever candidates — malformed names,
  temp files, and lock directories are skipped as non-candidates (the
  family readers' validated-id discipline, `state-readers.mjs:314-318`).
  Widening the registry is a follow-up decision, not a config knob.
- **Pin taxonomy** (a run matching ANY pin is never deletable):
  1. **Tracked-doc citations** — a bounded scan of git-tracked text files
     for both citation shapes observed in the wild: bare or backticked
     run-id tokens (`<family>-YYYYMMDDTHHMMSSZ-<6hex>`) and
     `.agentic-plugins/runs/<family>/<run-id>` path strings
     (`docs/DEVELOPMENT.md:440`, `docs/assurance/omcc-cutover-scorecard.md`,
     the consensus dogfood record). Scan bounds (file-count/byte caps,
     tracked-files-only, binary/undecodable files skipped-and-recorded) are
     implementation constants pinned by test; hitting a bound flips
     `scan_complete` to false rather than silently narrowing the pin set.
  2. **Latest pointers** — the run referenced by the family's
     `latest.json`. Apply never deletes or rewrites `latest.json` itself.
  3. **Live / reader-selected runs** — non-terminal artifacts and runs a
     runtime reader still selects: concretely at v1, settings execution
     artifacts whose recorded status is non-terminal
     (`planned`/`in-progress`, `settings.mjs:1449-1469` — doctor surfaces
     these as interrupted executions), the older-than-latest settings
     attestation the dashboard resolves (`dashboard.mjs:328-377`), and the
     reusable doctor proof selection (`doctor.mjs:1906-1920`). This pin is
     **not** vacuous for v1 and its per-family predicates are part of the
     registry entry.
  4. **Cross-artifact references** — run ids embedded in other run
     artifacts that outlive them: concretely at v1, recorded `doctor.json`
     report snapshots (which embed other families' evidence ids,
     `doctor.mjs:4888-4902`) and cutover evidence artifact-pointer lists
     (`cutover-audit.mjs:359-376`), scanned as data with the same
     bounded-read guards. (The in-memory cutover checklist is not a
     persisted reference and is not scanned.)
- **Apply (`retention-apply`)**: a separate explicit executor behind its own
  action-specific flag (ADR-0035 §3 invariant 1: dry-run default, explicit
  `--execute`-class opt-in), registered through the §5 add-gate with all
  seven items. Its contract:
  - **Plan-hash binding**: apply requires the plan hash of the plan the
    operator reviewed (flag or plan-artifact pointer). After acquiring the
    family lock, apply **recomputes** the plan (full pin re-scan under the
    same registry/scanner versions); any hash mismatch — new citations, new
    runs, changed pins, changed caps — is a **refusal with re-present**,
    never a silent proceed (the ADR-0046 presented-plan contract, adopted
    here independently for this executor).
  - **Writer coordination**: the family lock serializes applies; the
    minimum-age candidate guard plus a **per-run last-instant re-check**
    (lstat inside the lock immediately before deletion; any mtime inside
    the age margin ⇒ concede that run) closes the window against the
    family's own writers (doctor/compat/settings creating or resuming
    runs), which do not take the retention lock. A concurrent writer
    touching a candidate mid-apply loses nothing: the run is conceded and
    reappears in the next plan.
  - **Containment + symlink refusal at the destructive boundary**: every
    deletion target must resolve inside `.agentic-plugins/runs/<family>/`;
    validation is component-wise and no-follow (lstat) and is re-run at
    deletion time, not only at planning time, so a symlink swapped in after
    validation is refused (TOCTOU).
  - **Write-ahead receipts with a per-target state machine**: before the
    first unlink, apply persists a receipt (plan hash, ordered target
    list, all targets `planned`) via atomic temp+rename; each target
    transitions `planned → started → completed|failed` with an atomic
    rewrite per transition, so a crash brands the in-flight target
    `started` (recoverable as "state unknown — re-inventory") rather than
    lying in either direction. Receipts live under
    `.agentic-plugins/state/runtime/retention/` — outside `runs/`, so the
    receipt home is structurally out of candidate scope. An **open receipt
    blocks new applies** for that family until resolved (a resolve step
    re-inventories `started` targets and closes the receipt); receipts are
    schema-versioned so a downgrade meeting a newer open receipt refuses
    deletion-capable operation instead of misreading it.
  - **Per-invocation ceilings**: caps on deletions, bytes, and wall-clock
    per apply run (ADR-0035 §3 finite-bounded-execution invariant) —
    implementation constants pinned by test; excess work waits for the next
    explicit invocation.
  - **Explicit irreversible delete** (the "quarantine vs delete" call):
    deletion is real recursive removal of the run directory, recorded in
    the receipt. Quarantine (move-aside) is rejected — it re-creates the
    unbounded-growth problem one directory over, and a moved run breaks
    every pointer shape the pin scan protects anyway (Alternatives §6).
    Safety comes from pins + `scan_complete` + plan-hash revalidation +
    write-ahead receipts + containment, not from a second copy.
  - **Enforcement honesty**: the recursive-removal capability is registered
    in the ADR-0035 §4 executor-registry static scan (callee +
    first-argument identity, as that scanner actually checks —
    `runtime-executor-scan.mjs:1415-1422`); the containment and no-follow
    predicates are proven by behavioral/mutation tests, which the static
    scanner explicitly delegates to. The ADR claims no stronger static
    proof than the scanner provides.
- **Tier and ceiling**: planner is read-only (recording its plan artifact,
  when requested, is an M1 write under the existing runs/ conventions);
  apply is **M1** (deletes only agentic-plugins-owned state under
  `.agentic-plugins/runs/`, never host config, never outside the registry).
  The ADR-0035 §4 "never delete artifacts as part of status/cancel/cleanup"
  bullet stands: this is the enumerated ADR-gated exemption model (ADR-0040
  §2, ADR-0044 §3 precedents) applied to one named executor with an
  enumerated grant — delete only unpinned, over-cap, age-cleared runs of
  the three v1 families, under a reviewed plan hash and write-ahead
  receipts, behind an explicit flag.
- **No new config keys**: caps reuse the existing inventory guidance
  (`DEFAULT_ARTIFACT_RETENTION_CAP` 20 / 50 MiB, CLI-overridable per
  invocation). A persistent retention-policy key is deliberately deferred
  until dogfood shows per-family cap pressure.

### 8. Rollout and rollback: two releases, one dual-kind window

The macro's dependency graph ships runtime changes in **two releases**, and
§8 binds to that explicitly:

- **Release A** (`signal-runtime` + `compat-watch` →
  `signal-runtime-release`): the `response-needed` contract (schema, filter
  vocabulary, shuttle remap template) and the compat watch. Release A's
  version is what the attention floor pins (Decision §9).
- **Release B** (`claim-gc`, `retention-core`, `retention-apply` →
  released/installed within `acceptance`): the locking repair + sweep and
  the retention planner/apply. B follows A because `claim-gc` serializes
  behind `signal-runtime` on the shared notify-schema surface; nothing in
  the attention rollout waits on B.

**Enable sequence** (each arrow names the failure it prevents):

1. **Install Release A on both host caches** — the Claude plugin cache and
   the Codex plugin cache are separate installations, and the shuttle
   resolves the Codex cache first *without falling back* when that copy is
   below its floor (`codex-notify-shuttle.mjs:104-139`); "installed on the
   machine" means **verified on both limbs**, per the existing bootstrap/
   settings readiness checks. *Prevents*: a producer emitting a kind the
   resolving runtime's `validateEvent` rejects (silent loss), and — worse —
   an operator `notify_kinds` token an older runtime's `parseKindsFilter`
   hard-errors on, which fail-closes the **entire** notify pipeline
   (`loadNotifyConfig` invalid ⇒ every emit `failed at config`).
2. **Open the dual-kind window**: set `notify_kinds` to include **both**
   `turn-complete` and `response-needed` (or leave the filter unset =
   all kinds). *Prevents*: silent signal loss during the mixed-producer
   window — a re-rendered shuttle or new attention emitting
   `response-needed` against a `turn-complete`-only filter, or an
   un-upgraded producer emitting `turn-complete` against a
   `response-needed`-only filter.
3. **Re-render + re-install the Codex shuttle** (`runtime:settings
   --notification-plan`, operator applies): the Codex limb migrates to
   `response-needed`.
4. **Install the attention release** (`signal` subtask): the classifier +
   producers activate behind the Decision §9 floor.
5. **Optionally narrow the filter** (drop `turn-complete`) only after both
   producers are verified upgraded — the acceptance subtask's filter-matrix
   check is the verification.

**Rollback is order-reversed with the window held open**: widen the filter
back to both kinds first; downgrade/disable attention (stop producing the
kind on Claude); re-render the shuttle **from the downgraded runtime
package** (re-rendering is not version-pinned — it renders the installed
template, `notification-plan.mjs:347-369`, so the downgrade must precede
the render); remove the `response-needed` token; downgrade runtime last.
Two hard scope notes: retention deletions are **irreversible and outside
rollback** (rollback restores software and config, never deleted runs —
the write-ahead receipts are the durable record), and a deletion-capable
downgrade is **blocked while an open retention receipt exists** (§7).
The `acceptance` subtask exercises the boundary matrix as executed
evidence: old-runtime + new-token fail-close, each single-sided filter
loss, the un-re-rendered shuttle, and both rollback directions.

### 9. Released-runtime floor pin for attention

The attention classifier/producer path is gated by a **new, dedicated
capability floor** — "first released runtime version containing the
response-needed contract" (= Release A, recorded by
`signal-runtime-release`, never a pre-release per ADR-0043's floor rule) —
declared in attention's `data/runtime-floors.json` alongside the publisher
and entry-brief floors. It does **not** raise the existing notify floor
(0.71.0): the ADR-0044 "two gates never share a constant" rule applies —
raising the shared notify floor would silence every existing notification
on a merely-current runtime, punishing kinds that need nothing new. Below
the new floor the sensor takes the pre-ADR-0047 bare path (`turn-complete`,
no classifier, no headline) — graceful degradation, not an error — and the
§8 dual-kind window keeps that fallback visible rather than filtered.

## Consequences

**Positive**:

- "The agent is waiting on you" becomes a first-class, filterable signal on
  both hosts — headline-bearing on the Claude limb (`your-turn`,
  `needs-approval`; the Codex shuttle stays headline-free at v1) — and the
  noise remedy becomes a one-line `notify_kinds` config instead of muting
  the pipeline.
- The two dead vocabulary tokens become reachable exactly as ADR-0041 §3a
  designed, through a named narrow amendment rather than silent scope
  creep.
- A real mutual-exclusion defect (`withReclaimLock`) is repaired, and the
  ADR-0040 §2 retention authorization finally gets its bounded
  implementation under the same lock protocol as the claim machinery;
  notify state stops growing without bound and the dashboard stops
  mislabeling concurrent races as `blocked`.
- Run-artifact growth gets a safe relief valve whose pin taxonomy encodes
  the repo's actual citation and reader-selection practices; cited proof
  runs (`doctor-20260720T175310Z-a0fd88` et al.) and still-load-bearing
  older runs are structurally undeletable, and apply can only execute the
  plan the operator reviewed (hash-bound).
- Every mutation stays inside the ADR-0035 model: one realized
  authorization (sweep), one enumerated new exemption (retention apply)
  through the §5 add-gate, ceiling text untouched.

**Negative**:

- `turn-complete` semantics narrow (interim-only on Claude; migrated away
  on Codex). Anyone keyed on `turn-complete` meaning "turn ended" must
  adopt `response-needed` — mitigated by the §8 dual-kind window and the
  kind's continued validity.
- The Stop sensor gains real work (payload enumeration + bounded dual-home
  ledger scan) on a hot path; bounded and slot-contained, but nonzero.
- The classifier is honest about its blind spots: repo-scoped peer-run
  correlation, no fingerprint verification (PID reuse reads interim), and
  host-version dependence mean some genuinely-final Stops will read
  interim (accepted false negatives).
- The Codex remap is an accepted approximation (§5): non-interactive Codex
  completions can surface as your-turn.
- The rollout has five ordered steps across two releases, two host caches,
  a config window, and an operator re-render; §8 is normative because the
  token/runtime direction fail-closes notifications when misordered.
- Retention apply carries real operational ceremony — plan hash, open
  receipts, resolve steps — which is the price of irreversible deletion
  under the §4 ceiling's exemption model.
- Three new mutation-verified test surfaces (classifier hostile-state
  matrix incl. scan-completeness, sweep concurrency/fairness, retention
  pin/apply incl. receipt recovery) must be built and maintained.

**Neutral**:

- The kind enum grows to eight; `health` remains reserved/producer-less.
- Retention v1 covers three families; the registry is closed and widening
  is a decision, not drift.
- `pinned_overage` reframes some existing "over cap" warnings as
  informational — dashboards read differently, on purpose.
- One lock protocol now governs reclaim, finalize, and sweep; the
  transition window's ghost-claim resurrection is a named, bounded,
  self-healing artifact of the repair.

## Alternatives Considered

1. **Status refinement instead of a new kind** (`turn-complete` with
   `status=final|interim`): rejected — `notify_kinds` filters exact kinds
   only (`notify-schema.mjs:346-372`); a status token is invisible to the
   only filter surface, and `turn-complete` is a `KINDS_WITH_DEFAULT_STATUS`
   member whose distinct-status moments would now collide or require a
   contract break in the dedupe key rules.
2. **Transcript-derived finality** (parse `transcript_path` for a trailing
   question/prompt): rejected verbatim per ADR-0044 Alt E — injection and
   secrets surface, host-format coupling, and the enumerated-metadata
   discipline; structural signals only.
3. **Adopt Claude 2.1.198 `agent_needs_input` as the signal now**: rejected
   for v1 — the notification type is unprobed and its firing semantics
   (TUI-idle nudge vs structural turn-end) are unverified; it enters the
   §5 seeded standing compat watch with a source-verification trigger
   instead. The Stop-payload route works on the recorded 2.1.215 baseline
   today.
4. **mtime/recency heuristics for interim detection** (recent state-file
   writes ⇒ still working): rejected — ADR-0045 already established that
   Stop-driven snapshot rewrites make mtime measure hook scheduling, not
   activity. (Row 3's `updated_at` freshness for PID-less `queued|spawning`
   handles is not this: it reads the ledger's own liveness field under the
   ledger's own stale-grace contract, the same rule its sweep applies.)
5. **Fingerprint-verified liveness in the classifier** (reuse the ledger's
   `ps`-based verifier to eliminate PID-reuse false interims): rejected —
   it spawns an unbounded process on the Stop hot path, and the error it
   prevents is in the accepted conservative direction; the ledger's own
   sweep remains the place where fingerprint truth is enforced.
6. **Quarantine-then-purge instead of irreversible delete** for retention
   apply: rejected — re-creates unbounded growth one directory over,
   requires a second GC decision for the quarantine home, and a moved run
   breaks every pointer the pin scan exists to protect; write-ahead
   receipts + plan-hash revalidation + containment deliver the
   recoverability quarantine pretended to.
7. **One unified GC command over all families including notify state**:
   rejected — the claim sweep is an already-authorized routine maintenance
   of emitter-owned state (bounded, gate-inherited, no flag), while runs/
   deletion is a new ADR-gated exemption requiring an explicit flag,
   plan-hash binding, and receipts; merging them would either
   over-ceremonialize the former or under-protect the latter. Family
   heterogeneity (machine-scoped homes, foreign-plugin ownership,
   integrity hubs) makes "one command" a false simplification.
8. **Defer the locking repair to "when it bites"**: rejected — the
   unreachable-EEXIST defect silently voids the §7 claim-finalization
   guarantees ADR-0041 depends on (double promote/release), the repair is
   one line plus tests, and the sweep (this ADR) adds a new concurrent
   deleter whose safety argument (§6 lock protocol) requires real mutual
   exclusion to exist at all.

## References

- ADR-0023 (peer-run supervision — ledger statuses, stale-grace, sweep
  precedent), ADR-0030 (source-verification discipline), ADR-0035
  (execution-boundary policy), ADR-0040 (notify pipeline; §2 retention
  authorization at `docs/adr/0040-operator-observability.md:301-305`; §4
  Codex `notify=` evidence), ADR-0041 (§3a headline
  vocabulary/guards/opt-in), ADR-0043 (released-only floor rule), ADR-0044
  (Stop ordering, hot-path budget, Alt E), ADR-0045 (governance-amendment
  pattern, mtime rejection, probe-matrix precedent), ADR-0046 (write-ahead
  ordering + presented-plan hash, machine-home contract).
- Code anchors: `plugins/runtime/scripts/lib/notify-schema.mjs`
  (:42-50 kinds, :346-372 filter, :519-520 TTL boundary, :529 correct lock,
  :624-668 `withReclaimLock`), `plugins/runtime/scripts/notify.mjs`
  (runEmit pipeline :757-795), `plugins/attention/adapters/claude/hooks/
  stop.mjs`, `plugins/attention/scripts/lib/sensor.mjs` (:142-161 headline
  map, :517-532 budget contract, :895-907 bounded-read guard),
  `plugins/runtime/scripts/dashboard.mjs` (:328-377 attestation selection,
  :428-434 `statIfExists`, :436-543 notify-state health),
  `plugins/runtime/receivers/codex-notify-shuttle.mjs` (:104-139 resolution,
  :158 type gate), `plugins/engineer/scripts/peer-runner.mjs` (:40-51
  statuses, :380-395/:684-686 PID lifecycle, :475-515 fingerprint spawn),
  `plugins/runtime/scripts/lib/state-readers.mjs` (:150 family registry,
  :314-318 validated ids, :701-853 inventory advisory),
  `plugins/runtime/scripts/settings.mjs` (:1449-1469 non-terminal
  execution artifacts, :1504-1524 atomic write-ahead),
  `plugins/runtime/scripts/doctor.mjs` (:1776-1805 interrupted executions,
  :1906-1920 proof selection, :4888-4902 report snapshot embeds),
  `plugins/runtime/scripts/cutover-audit.mjs` (:359-392 evidence shape),
  `tests/plugin-shape/runtime-executor-scan.mjs` (:1379-1422 scanner
  honesty), `plugins/runtime/docs/host-parity-baseline.md` (:97, :272,
  2026-07-20 row).

## Provenance

Authored as subtask `adr` of `macro-plan-20260721T020414Z-7c4166`
(engineer workflow `compose-20260721T024104Z-99a5af`), following the
plan-verify ensemble `macro-plan-20260721T020614Z-51f6fbc`
(verdict `concerns`; the peer's 9-subtask decomposition, floor ordering,
`withReclaimLock` defect grounding, and payload-evidence anchors are
adopted throughout). Evidence gathered 2026-07-21 against `main`
@ `117712d` with three parallel repository surveys (notify/attention
surface, Stop-payload + Codex ingress + peer-ledger, runs/retention +
citation corpus). A second plan-verify ensemble on the drafted ADR itself
(`plan-verify-20260721T025928Z-37d26e`, verdict `request-changes`) returned
3 CRITICAL / 20+ MAJOR findings — sweep reclaim-lock protocol, writer/apply
coordination, plan-hash binding, receipt state machine, scan-completeness
contracts, ledger dual-home + PID-lifecycle corrections, §3a amendment
naming, release A/B split, dual-kind rollout window, and citation
corrections (cutover evidence shape, live-run vacuity, baseline 2.1.215) —
all folded into this revision; no findings were rejected.
