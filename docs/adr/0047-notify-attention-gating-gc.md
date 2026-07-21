# ADR-0047: Response-needed notification signal + bounded notify/artifact GC

## Status

Proposed (macro subtask `adr` of `macro-plan-20260721T020414Z-7c4166`; flips
to Accepted at merge per AGENTS.md §ADR process)

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
  - ADR-0035 §4 exemption registration (Decision §7): the artifact-retention
    apply executor joins the enumerated ADR-gated deletion exemptions (the
    same model ADR-0040 §2 used for claim/log retention and ADR-0044 §3 used
    for capture-lock cleanup). The §4 ceiling text itself is unchanged.
  - ADR-0041 §3a is NOT amended: wiring the `your-turn` / `needs-approval`
    producers realizes the §3a design (the vocabulary and both guards already
    ship); no vocabulary, guard, or opt-in change.
  - ADR-0040 §2's retention authorization (TTL-expired dedupe claims +
    log rotation are "routine deletions of runtime-owned notify state") is
    NOT re-authorized — Decision §6 implements it with explicit bounds.

Implementation is staged by `macro-plan-20260721T020414Z-7c4166`: this ADR is
subtask `adr`'s deliverable; subtasks `compat-watch`, `signal-runtime`,
`signal-runtime-release`, `signal`, `claim-gc`, `retention-core`,
`retention-apply`, and `acceptance` implement against it.
-->

## Context

### 1. Every bare Stop looks the same, so operators cannot filter for "your turn"

The Claude `Stop` sensor (ADR-0040 §3, `plugins/attention/adapters/claude/
hooks/stop.mjs`) reads exactly three payload fields — `cwd`, `session_id`,
`prompt_id` — and branches on persona-projection freshness alone: a fresh
terminal workflow projection emits `workflow-terminal`; everything else is a
bare `turn-complete`. There is no interim/final discrimination anywhere in
the pipeline. A Stop fired while background tasks are still running (peer
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
(`plugins/runtime/docs/host-parity-baseline.md:97`; recorded baseline is
2.1.206, so the fields are available on the supported floor), and the
four persona peer-run ledgers (`.agentic-plugins/state/<persona>/peer-runs/
<run_id>/handle.json`, ADR-0023) carry non-terminal statuses
(`queued|spawning|running|cancel_requested`) plus PID/fingerprint liveness
(`plugins/engineer/scripts/peer-runner.mjs:40-51,475-560`) that a Stop-time
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
same problem.

### 4. The notify dedupe state has one real locking defect and two accumulation/observation defects

- **`withReclaimLock` provides no mutual exclusion** —
  `notify-schema.mjs:629` acquires its lock with
  `fs.mkdirSync(lockDir, { recursive: true })`, and `recursive: true` never
  raises `EEXIST`, so the contention branch (`:631-643`) is unreachable and
  two concurrent finalizers both "acquire" the lock (last `owner` write
  wins). The neighboring `claimDedupe` reclaim path (`:529`) and the log
  rotation lock (`notify.mjs:287`) use non-recursive `mkdirSync` and are
  correct — this is a single defective instance, not a systemic pattern, but
  the repair slice must still sweep for mirrors per the repo's
  fix-the-mirror convention.
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
  `stat` by a concurrent emit is a normal race, not a health fault.

### 5. Run artifacts only grow, while committed docs cite them

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
reference for cross-session verification". Run artifacts also reference each
other: `cutover-audit.mjs:573-593` embeds consensus/context/compat run ids in
cutover evidence; the entry-brief arbiter emits validated pointers into
context and consensus runs; `latest.json` pointers exist in every
runtime-owned family except context. A naive cap-based GC would delete
cited evidence and dangle cross-artifact references; the ADR-0035 §4 ceiling
("never delete artifacts as part of status/cancel/cleanup") forbids shipping
it as a side effect of anything.

### 6. Prior decisions bound the solution space

ADR-0035 (§1 read-only default; §2 tiers R0/M1/H2/H3; §3 per-executor
invariants; §4 ceiling with the ADR-gated owned-state exemption model; §5
add-gate) governs every new mutation. ADR-0040 owns the notify pipeline and
the §1 kind/subject contract. ADR-0041 §3a owns the headline vocabulary,
guards, and opt-in. ADR-0044 fixed the Stop hot-path shape (capture before
notification; the 36 s budget is the code contract at
`sensor.mjs:517-532` — 12 s emit slots, pinned by plugin-shape tests) and
rejected transcript semantics (Alt E). ADR-0043 established the released-only
capability-floor rule ("floor = first released runtime version containing the
contract, never pinned pre-release") and ADR-0044 the "two gates never share
a constant" floor-separation rule. ADR-0045 rejected mtime-recency as an
activity signal and established honest-refusal degradation.

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
your-turn signal.

### 2. The Claude structural classifier matrix

At a bare Stop (no fresh terminal projection — Decision §3 handles the
non-bare case), the sensor classifies **interim vs final** from structural
evidence only, in this order:

| # | Evidence source | Reading | Verdict contribution |
|---|-----------------|---------|----------------------|
| 1 | `payload.background_tasks` (Stop input, Claude ≥ 2.1.145) | enumerate; any entry not in a completed/terminal state | non-empty incomplete set ⇒ **interim** |
| 2 | `payload.session_crons` (same) | enumerate; any pending/scheduled session cron implies the session resumes itself | non-empty ⇒ **interim** |
| 3 | Peer-run ledger fallback (`.agentic-plugins/state/<persona>/peer-runs/*/handle.json`, all four `SENSOR_PERSONAS`) | non-terminal status (`queued|spawning|running|cancel_requested`) AND `isProcessAlive(pid)` AND process-fingerprint match | any live run ⇒ **interim** |
| 4 | None of the above observable | — | **no promotion** (see below) |

- **Verdict rule**: any interim evidence ⇒ emit `turn-complete` (unchanged
  shape, no headline). No interim evidence AND at least one payload field
  (row 1/2) was *observable* (present on the payload, even if empty) ⇒
  **final** ⇒ emit `response-needed` with the `your-turn` headline.
- **Conservative false-negative policy**: when neither payload field is
  present (host below 2.1.145, malformed payload) and the ledger scan is
  empty or errored, the sensor does **not** promote — it emits the bare
  `turn-complete` exactly as today. A missed `response-needed` costs
  nothing over the status quo; a wrong one trains the operator to ignore
  the only headline that matters. Classifier errors of any kind degrade the
  same way (fail-closed observer, ADR-0040 §7).
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
- **Bounded**: the ledger scan is capped (fixed per-persona handle limit,
  newest-first by directory mtime, with an aggregate time budget) and runs
  inside the existing Stop emission slot; the classifier adds no new spawn
  and no new slot to the `sensor.mjs:517-532` 36 s contract. Exact caps are
  implementation constants pinned by the plugin-shape test alongside the
  existing four budget constants.
- **No transcript semantics**: the classifier never opens
  `transcript_path` — ADR-0044 Alt E's rejection (injection/secrets surface,
  host-format coupling) applies verbatim and is not relitigated here.

### 3. Event precedence at Stop: exactly one user-turn signal

Per Stop, the sensor emits **at most one user-turn-signal event**:

1. Fresh terminal workflow projection(s) exist ⇒ `workflow-terminal`
   event(s) only (unchanged, including their archive-gate headlines). No
   `response-needed`, no `turn-complete`: the workflow-terminal set already
   IS the user-turn signal, and a second same-moment event would be the
   duplicate the operator then mutes.
2. Bare Stop classified **final** ⇒ `response-needed` only.
3. Bare Stop classified **interim** (or unpromotable, Decision §2) ⇒
   `turn-complete` only.

`turn-complete` and `response-needed` are therefore mutually exclusive by
producer rule (the **no-duplicate default**) — dedupe cannot enforce this
(different kinds build different keys), so the contract lives in the sensor
and is mutation-tested there. `subagent-complete`, `approval`, `idle`, and
the capture spawn ordering (ADR-0044 §2) are untouched. `turn-complete`'s
meaning narrows from "a turn ended" to "an interim turn ended"; the kind
name, subject, status, and schema are unchanged (ADR-0040 §1 Amendment
records the narrowed row).

### 4. Headline producer contracts: `your-turn` and `needs-approval`

Both wirings realize ADR-0041 §3a's existing design — vocabulary, Guard 1
(producer map-or-omit), Guard 2 (runtime validate-or-drop), and the
default-OFF egress opt-in are all unchanged:

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

- **`agent-turn-complete` remaps to `response-needed`**: Codex's `notify=`
  hook fires when the agent's turn completes and input is awaited — its
  semantics match `response-needed`, not the narrowed interim
  `turn-complete`. The receiver shuttle (runtime-owned render-input data,
  `codex-notify-shuttle.mjs`) changes kind only; subject
  (`codex-turn:<turn-id>`), status (`fired`), source (`codex-notify`), and
  the no-headline posture are preserved (ADR-0041 §3a is Claude-Stop-only at
  v1; extending the headline to the shuttle is a future slice with its own
  parity note). Operators re-render and re-install the shuttle via the
  existing `runtime:settings --notification-plan` flow after the runtime
  upgrade (rollout §8) — an older installed shuttle keeps emitting
  `turn-complete`, which the new runtime still accepts (the kind is not
  removed), so the migration degrades softly instead of breaking.
- **Approval variant stays a silent no-op until source-verified**: no
  approval payload reaches `notify=` today (Context §3), so the shuttle's
  unknown-type behavior (return without output) is contractual, not an
  accident. The `compat-watch` subtask adds a notification-specific watch
  surface to `runtime:compat`'s release-note gap analysis covering, at
  minimum: (a) any Codex `notify=` payload variant beyond
  `agent-turn-complete` (especially approval/permission shapes), and (b) the
  Claude 2.1.198 `agent_needs_input` / `agent_completed` notification types
  already recorded as candidate signals (`host-parity-baseline.md:272`).
  Each watch hit produces a planning row, never an automatic mapping; wiring
  a newly-observed variant requires a source-verified payload and its own
  follow-up decision (ADR-0030 discipline).

### 6. Bounded expired-claim sweep + locking repair (realizing ADR-0040 §2's authorization)

- **Repair `withReclaimLock` first**: the lock acquisition becomes
  non-recursive `mkdirSync(lockDir)` (the `claimDedupe:529` shape) so
  `EEXIST` is reachable and mutual exclusion is real. The repair slice
  sweeps the repo for mirror instances of recursive-mkdir-as-lock (per the
  fix-the-mirror convention); `claimDedupe` and `maybeRotate` are already
  verified correct.
- **Sweep placement**: inside `runEmit`, at the dedupe stage — strictly
  **after** the effective-channel gate (`none` ⇒ no sweep: an off system
  leaves no notify state and touches none, ADR-0040 §2) and **after** the
  kinds filter (a filtered-out event does no maintenance work). One sweep
  attempt per dispatched-or-deduped emit, never a standalone daemon and
  never a new executor — this is the bounded implementation of the deletion
  ADR-0040 §2 already authorized.
- **Sweep targets**: `.claim` files whose mtime exceeds the effective
  `notify_dedupe_ttl_seconds` (same config the claim logic uses — one TTL
  source) plus a fixed safety margin, and stale `.reclaim.lock` directories
  older than `lockStaleMs`. Fresh claims and live locks are never touched.
- **Bounds and fairness**: per-emit caps on entries examined and deletions
  performed, plus a wall-clock cutoff, all implementation constants pinned
  by test; the sweep is best-effort and fair (a large backlog converges
  over successive emits rather than blocking one). The added work must fit
  the existing emit slot; the Stop hot-path budget contract
  (`sensor.mjs:517-532`) gains no new constant.
- **Concurrency posture**: sweep deletions follow the §1 concession rules —
  re-check mtime immediately before unlink, tolerate `ENOENT` (a concurrent
  reclaim won), and never sweep-and-fire in a way that could double-fire a
  notification; contention is conceded, not fought (the
  `swept-stale-lock` precedent).
- **Observer semantics unified with the dashboard**: a path that vanishes
  between `readdir` and `stat` is a **concurrent change** — skipped, not
  counted — in both the sweep and `inspectNotifyState` (`ENOENT` from the
  stat probe stops flipping status to `blocked`; genuinely unreadable
  entries — `EACCES`, `EIO` — keep doing so). Both surfaces measure claim
  expiry against the same TTL source.

### 7. Citation-aware artifact retention: read-only planner + explicit apply (M1)

Retention over `.agentic-plugins/runs/` splits into two surfaces with a hard
boundary between them:

- **Planner (`retention-core`)**: pure read-only computation — it deletes
  nothing and its default invocation writes nothing. It produces, per
  family: the run inventory, the **pin set** with per-run pin reasons, the
  **actionable excess** (over-cap, unpinned — deletable), and the
  **pinned overage** (over-cap but pinned — *informational only*, never a
  warning that asks the operator to act against a pin). Doctor/dashboard
  artifact-attention surfaces adopt this split so "over cap because cited"
  stops reading as a fault. Stable projections; no schema break to the
  existing inventory advisory.
- **Closed family registry**: v1 scope is exactly
  **`doctor`, `compat`, `settings`** — runtime-owned, `latest.json`-bearing,
  self-contained families. Excluded, each for a named reason: `consensus`
  (in-run integrity hub: manifest/owner-decision/ratification pointers gate
  live command behavior), `context` (entry-brief pointer target, no latest
  pointer), `cutover` (embeds other families' run ids as evidence),
  `notification`/`permission`/`egress-launcher` (operator-plan records;
  candidate second slice after v1 proves the pin scanner), `bootstrap` /
  `profiles` (machine-scoped home, ADR-0046 contract §10; profiles are
  operator input and retention-exempt), `image` (owned by `plugins/image`,
  not runtime), and every unknown/discovered directory (inventory stays
  advisory there). Widening the registry is a follow-up decision, not a
  config knob.
- **Pin taxonomy** (a run matching ANY pin is never deletable):
  1. **Tracked-doc citations** — a bounded scan of git-tracked text files
     for both citation shapes observed in the wild: bare or backticked
     run-id tokens (`<family>-YYYYMMDDTHHMMSSZ-<6hex>`) and
     `.agentic-plugins/runs/<family>/<run-id>` path strings
     (`docs/DEVELOPMENT.md:440`, `docs/assurance/omcc-cutover-scorecard.md`,
     the consensus dogfood record). Scan bounds (file-count/byte caps,
     tracked-files-only) are implementation constants pinned by test.
  2. **Latest pointers** — the run referenced by the family's
     `latest.json`.
  3. **Live runs** — family-specific non-terminal states. Vacuous for the
     v1 families (their runs are terminal at write time); the pin class
     exists so widening the registry cannot silently skip it.
  4. **Cross-artifact references** — run ids embedded in other run
     artifacts that outlive them; v1 concretely scans cutover evidence
     (`evidence.json` + `runs/cutover/latest.json` embed compat run ids —
     `cutover-audit.mjs:573-606`) for references into the v1 families.
- **Apply (`retention-apply`)**: a separate explicit executor behind its own
  action-specific flag (ADR-0035 §3 invariant 1: dry-run default, explicit
  `--execute`-class opt-in), registered through the §5 add-gate with all
  seven items. Its contract:
  - **Stale-plan revalidation**: apply re-runs the full pin scan
    immediately before acting; an unreadable citation source (any pin-1
    scan input) **fails the apply closed** — an unscannable doc is treated
    as potentially citing everything.
  - **Containment + symlink refusal**: every deletion target must realpath
    inside `.agentic-plugins/runs/<family>/`; symlinked run directories are
    refused, never followed.
  - **Family locking**: one apply per family at a time (mkdir-lock
    precedent), so two applies cannot interleave receipts.
  - **Write-ahead receipts**: the planned deletion list + plan fingerprint
    are persisted *before* the first unlink (ADR-0046's write-ahead
    ordering, which narrowly superseded "re-run, not rollback" for
    executors of this class); each deletion appends to the receipt, so a
    crash leaves an honest partial record and a re-run is idempotent.
  - **Explicit irreversible delete** (the "quarantine vs delete" call):
    deletion is real `rm -rf`-equivalent on the run directory, recorded in
    the receipt. Quarantine (move-aside) is rejected — it re-creates the
    unbounded-growth problem one directory over, and a moved run breaks
    every pointer shape the pin scan protects anyway (Alternatives §6).
    Safety comes from pins + revalidation + write-ahead + containment, not
    from a second copy.
  - **Partial-failure posture**: `latest.json` is never a deletion target
    (pin 2) and is rewritten never; a mid-apply failure stops the executor,
    leaves the receipt marking done/undone entries, and the next plan run
    reflects observed reality. The recursive-removal capability is
    registered in the ADR-0035 §4 executor-registry static scan scoped to
    exactly this executor and these containment predicates.
- **Tier and ceiling**: planner R0-shaped (read-only; if a plan artifact is
  recorded it is an M1 write under the existing runs/ conventions); apply is
  **M1** (deletes only agentic-plugins-owned state under
  `.agentic-plugins/runs/`, never host config, never outside the registry).
  The ADR-0035 §4 "never delete artifacts as part of status/cancel/cleanup"
  bullet stands: this is the enumerated ADR-gated exemption model (ADR-0040
  §2, ADR-0044 §3 precedents) applied to one named executor with an
  enumerated grant — delete only unpinned, over-cap runs of the three v1
  families, under write-ahead receipts, behind an explicit flag.
- **No new config keys**: caps reuse the existing inventory guidance
  (`DEFAULT_ARTIFACT_RETENTION_CAP` 20 / 50 MiB, CLI-overridable per
  invocation). A persistent retention-policy key is deliberately deferred
  until dogfood shows per-family cap pressure.

### 8. Rollout and rollback order

Order is load-bearing; each arrow names the failure it prevents:

1. **Runtime releases and installs first** (`signal-runtime` →
   `signal-runtime-release`): the kind enum, filter vocabulary, sweep, and
   GC land in a released `plugin-runtime` version, installed on the machine.
   *Prevents*: an attention producer emitting a kind the installed runtime's
   `validateEvent` rejects (silent notification loss), and — worse — an
   operator `notify_kinds` token the installed runtime's `parseKindsFilter`
   hard-errors on, which fail-closes the **entire** notify pipeline
   (`loadNotifyConfig` returns invalid; every emit reports
   `failed at config`).
2. **Codex shuttle re-render** after install (`runtime:settings
   --notification-plan` → operator applies): the receiver starts emitting
   `response-needed`. An un-re-rendered shuttle keeps working (§5).
3. **Config token last on the enable side**: only after the new runtime is
   installed may `notify_kinds` include `response-needed`.
4. **Attention releases and installs last** (`signal`): the classifier +
   producers ship behind a dedicated released-runtime capability floor
   (Decision §9); attention on an old runtime never runs the new path.

**Rollback is the exact reverse**: downgrade/disable attention first (stop
producing the kind), remove the `notify_kinds` token second (before any
runtime downgrade — an old runtime with the token present kills the
pipeline), re-render the shuttle, downgrade runtime last. The `acceptance`
subtask records both directions as executed evidence.

### 9. Released-runtime floor pin for attention

The attention classifier/producer path is gated by a **new, dedicated
capability floor** — "first released runtime version containing the
response-needed contract" (recorded by `signal-runtime-release`, never a
pre-release per ADR-0043's floor rule) — declared in attention's
`data/runtime-floors.json` alongside the publisher and entry-brief floors.
It does **not** raise the existing notify floor (0.71.0): the ADR-0044 "two
gates never share a constant" rule applies — raising the shared notify floor
would silence every existing notification on a merely-current runtime,
punishing kinds that need nothing new. Below the new floor the sensor takes
the pre-ADR-0047 bare path (`turn-complete`, no classifier, no headline) —
graceful degradation, not an error.

## Consequences

**Positive**:

- "The agent is waiting on you" becomes a first-class, filterable,
  headline-bearing signal on both hosts; the noise remedy is a one-line
  `notify_kinds` config instead of muting the pipeline.
- The two dead vocabulary tokens (`your-turn`, `needs-approval`) become
  reachable exactly as ADR-0041 §3a designed, with no guard or opt-in
  changes.
- A real mutual-exclusion defect (`withReclaimLock`) is repaired, and the
  two-year-old ADR-0040 §2 retention authorization finally gets its bounded
  implementation; notify state stops growing without bound and the
  dashboard stops mislabeling concurrent races as `blocked`.
- Run-artifact growth gets a safe relief valve whose pin taxonomy encodes
  the repo's actual citation practices; cited proof runs
  (`doctor-20260720T175310Z-a0fd88` et al.) are structurally undeletable.
- Every mutation stays inside the ADR-0035 model: one realized
  authorization (sweep), one enumerated new exemption (retention apply)
  through the §5 add-gate, ceiling text untouched.

**Negative**:

- `turn-complete` semantics narrow (interim-only on Claude; migrated away
  on Codex). Anyone whose config or tooling keyed on `turn-complete`
  meaning "turn ended" must adopt `response-needed` — mitigated by the
  soft-degrade shuttle migration and the kind's continued validity.
- The Stop sensor gains real work (payload enumeration + bounded ledger
  scan) on a hot path; bounded and slot-contained, but nonzero.
- The classifier is honest about its blind spots: repo-scoped peer-run
  correlation and host-version dependence mean some genuinely-final Stops
  will still read interim (accepted false negatives).
- The rollout has four ordered steps across two plugins, a config key, and
  an operator re-render; getting it wrong in the token/runtime direction
  fail-closes notifications (which is why §8 is normative, not advisory).
- Two new mutation-verified test surfaces (classifier hostile-state matrix,
  retention pin/apply) must be built and maintained.

**Neutral**:

- The kind enum grows to eight; `health` remains reserved/producer-less.
- Retention v1 covers three families; the registry is closed and widening
  is a decision, not drift.
- `pinned_overage` reframes some existing "over cap" warnings as
  informational — dashboards read differently, on purpose.

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
   for v1 — the notification type is newly added, unprobed, and its firing
   semantics (TUI-idle nudge vs structural turn-end) are unverified; it
   enters the compat watch (§5) with a source-verification trigger instead.
   The Stop-payload route works on the recorded 2.1.206 baseline today.
4. **mtime/recency heuristics for interim detection** (recent state-file
   writes ⇒ still working): rejected — ADR-0045 already established that
   Stop-driven snapshot rewrites make mtime measure hook scheduling, not
   activity.
5. **Sweep as a standalone GC command or SessionStart hook**: rejected —
   a new executor/surface for a deletion ADR-0040 §2 already scoped to
   routine notify-state maintenance; emit-path placement inherits the
   activation gates for free (an off or fully-filtered system does no
   maintenance), and SessionStart is latency-budgeted (ADR-0045 §11) with
   no headroom to spend on janitorial work.
6. **Quarantine-then-purge instead of irreversible delete** for retention
   apply: rejected — re-creates unbounded growth one directory over,
   requires a second GC decision for the quarantine home, and a moved run
   breaks every pointer the pin scan exists to protect; write-ahead
   receipts + revalidation + containment deliver the recoverability
   quarantine pretended to.
7. **One unified GC command over all families including notify state**:
   rejected — the claim sweep is an already-authorized routine maintenance
   of emitter-owned state (bounded, gate-inherited, no flag), while runs/
   deletion is a new ADR-gated exemption requiring an explicit flag and
   receipts; merging them would either over-ceremonialize the former or
   under-protect the latter. Family heterogeneity (machine-scoped homes,
   foreign-plugin ownership, integrity hubs) makes "one command" a false
   simplification.
8. **Defer the locking repair to "when it bites"**: rejected — the
   unreachable-EEXIST defect silently voids the §7 claim-finalization
   guarantees ADR-0041 depends on (double promote/release), the repair is
   one line plus tests, and the sweep (this ADR) adds a new concurrent
   deleter that makes real mutual exclusion load-bearing.

## References

- ADR-0023 (peer-run supervision — ledger statuses, liveness, sweep
  precedent), ADR-0030 (source-verification discipline), ADR-0035
  (execution-boundary policy), ADR-0040 (notify pipeline; §2 retention
  authorization at `docs/adr/0040-operator-observability.md:301-305`),
  ADR-0041 (§3a headline vocabulary/guards/opt-in), ADR-0043 (released-only
  floor rule), ADR-0044 (Stop ordering, hot-path budget, Alt E), ADR-0045
  (governance-amendment pattern, mtime rejection), ADR-0046 (write-ahead
  ordering, machine-home contract).
- Code anchors: `plugins/runtime/scripts/lib/notify-schema.mjs`
  (:42-50 kinds, :346-372 filter, :624-668 `withReclaimLock`),
  `plugins/runtime/scripts/notify.mjs` (runEmit pipeline),
  `plugins/attention/adapters/claude/hooks/stop.mjs`,
  `plugins/attention/scripts/lib/sensor.mjs` (:142-161 headline map,
  :517-532 budget contract), `plugins/runtime/scripts/dashboard.mjs`
  (:436-543 notify-state health),
  `plugins/runtime/receivers/codex-notify-shuttle.mjs`,
  `plugins/runtime/scripts/lib/state-readers.mjs` (:150 family registry,
  :701-853 inventory advisory), `plugins/runtime/scripts/cutover-audit.mjs`
  (:573-606 cross-artifact embeds),
  `plugins/runtime/docs/host-parity-baseline.md` (:97, :272).

## Provenance

Authored as subtask `adr` of `macro-plan-20260721T020414Z-7c4166`
(engineer workflow `compose-20260721T024104Z-99a5af`), following the
plan-verify ensemble `macro-plan-20260721T020614Z-51f6fbc`
(verdict `concerns`; the peer's 9-subtask decomposition, floor ordering,
`withReclaimLock` defect grounding, and payload-evidence anchors are
adopted throughout). Evidence gathered 2026-07-21 against `main`
@ `117712d` with three parallel repository surveys (notify/attention
surface, Stop-payload + Codex ingress + peer-ledger, runs/retention +
citation corpus).
