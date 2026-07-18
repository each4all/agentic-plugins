# ADR-0044: Session-generic handoff capture — a code firing point for out-of-workflow session boundaries

## Status

Proposed

## Context

### The gap: handoff coverage ends where workflows end

The completion/handoff surface is now code-fired **inside** workflows:
ADR-0031's projection seam plus ADR-0039's sidecar piggyback make the
continue-vs-fresh footer fire from `state.mjs set-terminal` /
`setMacroTerminal` on the terminal path of every engineer and
orchestrator verb (and, per ADR-0043, founder and designer). That
firing point is hard-gated on a **workflow terminal mutation**: no
active workflow, or no terminal event, means no code path runs at all.

Sessions **outside** a workflow — ad-hoc Q&A, exploratory
investigation, operator sessions driving `runtime:*` commands, any
session that never opens a persona workflow — end silently. The
2026-07-12 four-question diagnosis traced the observed handoff-quality
variance to exactly this structural line: *completion-time + in-workflow
is code-normed; entry-time + out-of-workflow is model discretion*.

The capture surface for this gap already exists. `runtime:context`
(the ADR-0024 context-hygiene surface) ships `capture` as a complete
M1 executor with field-level validation (`validateRiskLevel`,
`validateRunId`, single-line enforcement, lexical repo-relative
pointer checks — `context.mjs:583`, `:1129`, `:657`, `:574-581`), a
fixed artifact layout (`.agentic-plugins/runs/context/<run-id>/` with
`context.json`, `summary.md`, `next-session-prompt.md` —
`context.mjs:1145-1151`), and a schema id
(`runtime-context-artifact-1.0`, `context.mjs:12`). But it has **zero
code callers**: no script imports `captureContext`, no hook or adapter
spawns `context.mjs capture`; the only invocations are prose in
`commands/context.md` / `skills/context/SKILL.md` and tests.
`plugins/runtime/README.md:7` records the deferral explicitly
("automatic context mutation/capture triggers are deferred to
follow-up PRs").

ADR-0031's Amendment already proved what prose-only firing is worth:

> "In practice the session-level continue-vs-fresh handoff has **zero
> active triggers** — it depends entirely on the LLM choosing to honor
> a markdown instruction at the end of a verb."
> (`0031-session-level-active-handoff-layer.md:210-213`)

and rejected "add a runbook step" as a fix because "a runbook step is
*also* markdown prose, so (A) does not escape the very prose-dependence
this amendment exists to remove" (`:349-352`). The Amendment then wired
the **in-workflow** path (realized by ADR-0039). The out-of-workflow
path is the same disease in the remaining limb, and it needs the same
cure: a firing point that is code on a path that actually runs.

### Governing constraints

Any design here is bounded by four accepted decisions:

1. **ADR-0035 (execution boundary)** — `context capture` is classified
   **M1** ("agentic-plugins-owned writes only", §2 line 107; "Any mode
   of a command that emits a `.agentic-plugins/**` artifact is M1, not
   R0", line 106). Invariant 1 (§3): mutate only under an explicit,
   action-specific opt-in. The §4 ceiling forbids — independent of any
   flag — mutating the active host session/context, arbitrary argv /
   `shell: true`, and touching auth or host config. New executors pass
   the §5 add-gate (host-truth evidence, tier classification, exact
   command spec, safety proof, artifact schema, tests, docs).
2. **ADR-0040 (observability placement)** — runtime is deliberately
   **hook-free** ("this ADR's own placement decision", `:513-521`);
   host-lifecycle hooks live in the tiny, rarely-releasing, hook-only
   `plugins/attention` (ADR-0010 §6 Trigger 2, `:343-347`). For its
   own hook-invoked surface, ADR-0040 §2 amended ADR-0035 invariant 1
   from "explicit action-specific *flag*" to "explicit action-specific
   **config key**" with a shipped no-op default
   (`notify_channel = "none"`, `:284-291`) — an amendment **scoped to
   the notification-emit executor only**; it does not license any
   other hook-invoked executor. The Codex posture is a two-part
   invariant: no `.codex-plugin/plugin.json` `hooks` key **and** no
   root `hooks/hooks.json`; Claude registration is manifest-scoped
   under `adapters/claude/` (Amendment 2026-07-11, `:628-630`).
3. **ADR-0031 (projection model)** — dependency direction is
   push-not-pull: personas compute their own projections and hand them
   to runtime; runtime never shell-reads or imports persona state
   (`:64-70`). Decision §6 additionally ruled that cross-session
   persistence of the next-session prompt "reuses the **existing**
   `runtime:context` artifact rather than introducing a second
   state-like artifact" (`:113-118`). Completion-path scripts write
   files and at most one stderr line; stdout is a load-bearing machine
   channel (`:249-262`). Everything is fail-closed and non-fatal
   (`:304-311`).
4. **ADR-0041 (egress)** — supplies two reusable shapes:
   default-OFF opt-ins that are independent switches and fail-closed
   when unset (§3a `:234-245`), and an honestly-degraded Claude-only
   limb (`:246-252`) — though there the degradation covers only the
   optional `headline` field while base notifications still reach
   Codex; it is a shape precedent, not an equivalence, for any
   surface that is Claude-only in its entirety. Its stricter
   tracked-config-inert / env-only activation rules are scoped to
   **network egress** and do not automatically govern repo-local M1
   writes.

### Host truth and the spam problem

Recorded host truth gives Claude a rich plugin-registrable lifecycle
vocabulary — `SessionStart`, `Stop`, `SubagentStop`, `PreCompact`,
`PostCompact`, `Notification`, and more
(`plugins/runtime/docs/host-parity-baseline.md:95`; persona plugins
already bind SessionStart/PreCompact/Stop,
`plugins/engineer/hooks/hooks.json:14`). There is **no** recorded
evidence of a session-end event. `Stop` **fires on every turn end**,
not once per session (`0040-operator-observability.md:67-68`), and
does not fire at all on abrupt host termination. On Codex, the
recognized lifecycle vocabulary is `session_start` / `pre_compact` /
`stop` / `subagent_stop`
(`plugins/runtime/docs/codex-capability-baseline.md:63-68`), but
attention deliberately registers **zero** Codex hooks (path isolation,
above), and the Codex `notify=` shuttle carries a bare `turn-complete`
with no payload.

A turn-frequency event driving an append-only ledger is the "capture
spam" failure mode the plan-verify peer flagged for this subtask —
along with non-git cwd, malformed-artifact pinning (today
`findLatestContextArtifact` silently skips unreadable runs,
`context.mjs:701-720`, and capture's three writes are plain
`writeFile`s with no temp+rename, `context.mjs:61-121`), and
consumption semantics across `/clear` / resume / compact / startup.

### Scope split with ADR-0045

Per the macro plan's arbitration: **this ADR owns the exit side** —
production and lifecycle of the session-generic handoff artifact. Entry
arbitration and presentation (what a new session does with this
artifact, SessionStart `startup` matchers, prompt-time surfacing) are
**ADR-0045** (reserved, subtask S6). This ADR defines the artifact
contract that ADR-0045 consumes — including the field semantics a
consumer needs to arbitrate staleness — and nothing about how it is
shown.

## Decision

Adopt a **two-tier, slot-based, config-gated session capture** fired by
the attention plugin's existing Claude `Stop` sensor into a new
runtime-owned publisher executor. What it produces is honestly a
**rolling turn-complete checkpoint**: the last successful refresh
before a session ends — however it ends — *is* the handoff. Ten
sub-decisions:

### 1. Two-tier trust model: structural floor, model-authored ceiling

A hook script cannot synthesize a trustworthy semantic summary — only
the model knows what a session was about, and only code can be trusted
to fire. The design therefore splits the guarantee from the semantics:

- **Tier 1 (guaranteed, machine-derived)**: the Stop-fired publisher
  records structural facts, each labeled by its observer:
  *publisher-observed* — repo root, branch, short HEAD, dirty-file
  count, status digest, timestamps (bounded git probes, §9); and
  *sensor-relayed* — `host`, hook-supplied `session_id`, and
  `repo_recent_terminal_evidence` (§5), which arrive as argv from the
  attention sensor and are validated and clamped, never trusted as
  publisher observations. All Tier 1 fields are data, not prose.
- **Tier 2 (opportunistic, staged)**: a semantic summary enters the
  slot only through the staged note (§6). Provenance proves the
  **channel**, not the author: `summary_source = staged-note` asserts
  "an explicit local `context note` invocation staged this", nothing
  stronger — consumers treat it as untrusted quoted data either way.
  Manual `runtime:context capture` remains the adjacent, richer
  explicit surface with its own run ledger; it is **not** folded into
  the slot (Alternatives, and §7).

`summary_source` is `staged-note` or `structural` (no note). Consumers
can always distinguish "code guaranteed this fired" from "something
semantic was actually staged". Fabricating semantics in code — e.g.
mining the transcript — is rejected (Alternatives E).

### 2. Firing point and placement: attention senses, runtime publishes

The firing point is the **attention plugin's existing Claude `Stop`
sensor** (`plugins/attention/adapters/claude/hooks/stop.mjs`), which
already performs the two capabilities this needs on every turn end: a
version-gated `discover-runtime.mjs` ladder plus fixed-argv `spawnSync`
shuttle into a runtime executor (`sensor.mjs:682-721`), and the §3
freshness-checked read of persona `last-session-handoff.json`
projections and `.footer-rendered` markers (`sensor.mjs:318-444`, the
documented cross-package contract from ADR-0043).

The Stop hook additionally spawns the new runtime publisher
(`context.mjs publish-session`, §10) with the same fixed-argv
discipline. Control-flow requirements, from the current Stop
implementation's actual shape (`stop.mjs:47-51`, `:114-140`):

- **Capture runs before, and independent of, notification work.** The
  publisher spawn is ordered ahead of terminal-notification batching
  and its network egress (which may legitimately consume most of the
  hook deadline), inside the shared Stop budget with its own bounded
  timeout slice. Notification eligibility short-circuits (missing
  `session_id`/`prompt_id`, no terminal event, notify errors) must not
  skip or abort the capture spawn, and capture failure must not skip
  notification.
- **Explicit argv, no inheritance**: `--repo-root` (resolved from the
  hook payload `cwd` exactly as the sensor already resolves it),
  `--host claude` (hardcoded on this path), `--session-id` (optional;
  clamped; omitted when absent), `--workflow-evidence` (§5; omitted
  when unknown).

**Division of competence** (preserves ADR-0031's push-not-pull): the
*sensor* relays what it observed — it already reads persona
projections for enrichment in the same pass, and pushes that
observation as data. The *publisher* decides "may I write, and what" —
opt-in gate, fingerprint, lock, atomic publication. Runtime never
reads persona state; attention never applies policy.

**Placement ruling**: runtime stays hook-free — this ADR adds **no**
runtime hook and does not touch the Codex two-part invariant. This ADR
**amends ADR-0040 §3's attention charter** from "notification sensors"
to *host-lifecycle sensors feeding allowlisted runtime-owned
executors* — today: `notify.mjs emit` and `context.mjs
publish-session`. The amendment is bounded: attention remains
hook-only (no skills, verbs, or state), remains Claude-manifest-scoped,
and takes a one-time release for the new consumer; its steady-state
release cadence — the reason the hook surface was isolated there — is
unchanged.

**Dual discovery floor**: attention's current
`MIN_RUNTIME_VERSION = '0.71.0'` is the **notify** floor — the first
released runtime shipping `notify.mjs`
(`plugins/attention/scripts/discover-runtime.mjs:35-41`). The
publisher gets its **own, separate capability floor**: the first
**released** runtime version shipping `publish-session`, pinned only
after that release exists (the ADR-0043 rule — a planned-but-unreleased
version must never be pinned). Below the publisher floor, attention
skips the capture spawn silently while notifications keep working at
the notify floor; the two gates never share a constant.

### 3. Opt-in: `session_capture` config key — an explicit, narrow ADR-0035 §3 amendment

Automatic capture is an M1 write invoked by a hook, not by the
operator's hand — so a flag is the wrong shape, for the same reason
ADR-0040 §2 established for the notification emitter. Because that
amendment is **scoped to the notification-emit executor only**, this
ADR carries its own authorization:

> **ADR-0035 §3 invariant 1 is hereby amended, scoped to the
> `publish-session` executor only** (every other executor remains
> bound by §3 as written): the explicit action-specific *flag* is
> replaced by the explicit action-specific **config key**
> `session_capture`, whose shipped default `"off"` makes the
> hook-auto-invoked publisher mutate nothing until the operator opts
> in. Additionally, the publisher and `note` executor MAY delete
> **only** their own lock, temp/staging, and expired-claim files under
> `.agentic-plugins/state/runtime/session-capture/` (the bounded
> retention-deletion shape ADR-0040 §1 established for notify-owned
> state); no other deletion is authorized.

The key:

```
session_capture = "off"   # shipped default; enum: off | stop-hook
```

registered as a new `session` family in `runtime-config.mjs`
`CONFIG_KEY_FAMILIES` (`runtime-config.mjs:24-43`) with an enum
validator. The value is an enum, not a boolean, to leave room for
future origins without a schema break (mirroring `notify_channel`).
The generic TOML differ/upsert machinery applies, but the integration
is **not** free and is in scope for the implementing PR: an effective
repo→user-global→default loader for the new family (the notify
loader is notify-private, `notify.mjs:133-190`), settings
plan/report/help coverage, and an operator-visible readiness
diagnosis in doctor/settings for the half-enabled states ("key on but
attention missing/disabled", "key on but runtime below publisher
floor", "safe mode disables hooks entirely" —
`host-parity-baseline.md:95`). Without that diagnosis, a
"code-guaranteed" firing chain that is silently broken would be
indistinguishable from working.

**The gate is evaluated inside the runtime publisher, not the sensor**
— exactly like `notify.mjs emit` no-ops on `notify_channel = "none"`.
The sensor stays policy-free; policy enforcement lives in one place,
with the executor. The stricter ADR-0041 activation rules (env-only,
tracked-config-inert) are deliberately **not** imported: this surface
has no network effect, no credential, and writes only repo-local
`.agentic-plugins/**` state — the notify-key weight class is the
proportionate precedent (Alternatives H).

### 4. Artifact model: a slot, not a ledger — with `entry.json` as the commit record

The auto path writes a **fixed-location slot**, never a per-event run
directory:

```
.agentic-plugins/state/runtime/session-capture/
  slot.json    # raw capture   — schema runtime-session-capture-1.0
  entry.json   # sanitized projection + commit record — schema runtime-session-entry-1.0
  note.json    # staged semantic note — schema runtime-session-note-1.0
```

- **Slot, by construction, solves spam-volume and retention**: a
  turn-frequency event refreshing one directory is O(1) on disk no
  matter how long the machine runs. The append-only
  `.agentic-plugins/runs/context/` ledger remains reserved for
  **explicit** captures (manual `context capture`), unchanged.
- **State, not runs**: mutable last-writer slots belong under
  `state/runtime/` (precedent: `state/runtime/notify/`); append-only
  ledgers under `runs/`. Repo-scoped only — the machine-global
  `~/.agentic-plugins` home stays bootstrap-only (the ADR-0046
  location extension, itself still Proposed, is not extended here).
- **ADR-0031 §6 narrow amendment, declared**: §6 ruled that the
  in-workflow next-session prompt reuses the existing `runtime:context`
  artifact "rather than introducing a second state-like artifact". That
  ruling governed the in-workflow prompt-persistence surface; it did
  not contemplate a turn-frequency automatic producer, for which the
  append-only run ledger is structurally unsuitable (unbounded
  growth). This ADR **narrowly amends** that clause: the session-capture
  slot is authorized as a second, *bounded-by-construction* artifact
  home for the out-of-workflow limb only. Everything else in §6 —
  non-mutating runtime, no host-session mutation — stands.
- **Atomicity, honestly**: each file is written to a uniquely-named
  sibling temp and `rename`d into place — per-file atomicity is what
  the filesystem gives; no primitive makes two replacements one
  transaction. The pair is therefore made safe by **commit-record
  semantics**: publication order is `slot.json` first, then
  `entry.json`, and both carry the same `fingerprint`. `entry.json` is
  the **commit record**: the refresh no-op decision (§5) reads the
  committed `entry.json` — never the possibly-newer `slot.json` — and
  a fingerprint mismatch between the two files marks an incomplete
  generation that **forces republication** on the next Stop
  (self-healing within one turn) instead of being pinned by a
  young-slot no-op. This replaces the naive "no partial slot
  observable" claim with a testable invariant: *a mixed generation is
  never load-bearing and never survives the next publisher run.*
- **Validated on write AND read**: the publisher validates before
  rename; every consumer — `context status --slot` (§10) and every
  ADR-0045 surface — must schema-validate and **skip fail-closed** on
  mismatch, with slot/entry/note each recovering independently (a
  malformed file is skipped by readers and overwritten by the next
  publish; it is never repaired in place, never deleted on read).
- **Concurrency and ownership**: last-writer-wins across concurrent
  sessions of one repo (the ADR-0043 slot concession, accepted for the
  same reason). Producers never delete on read; consumers are strictly
  read-only on all three files — if ADR-0045 needs consumed-state, it
  introduces its **own** sibling artifact it owns; nothing here
  reserves or performs such a write.
- **Normative schemas live in a packaged contract doc**: the exact
  field tables (required/optional/nullable/forbidden), per-field caps,
  TTLs, fingerprint algorithm and canonicalization, git digest rules,
  temp naming, and sweep bounds are specified in
  `plugins/runtime/docs/session-capture-contract.md` — plugin-packaged
  and content-token-enforced à la `footer-contract.md` /
  `machine-bootstrap-contract.md` (the ADR-0046 vehicle rationale:
  only a packaged doc is readable from a consumer machine). This ADR
  fixes the *policy*; the contract doc is a required §10 deliverable
  and the single normative source for the numbers. Policy defaults
  decided here: refresh TTL 300 s, lock stale-age 60 s with a bounded
  future-skew tolerance (the `sensor.mjs:471-492` skew discipline),
  note cap 4 KiB, note fold window 24 h, entry string fields
  single-line ≤ 160 chars.

`slot.json` carries: schema id, `captured_at`, `origin` (`stop-hook`),
`summary_source`, sensor-relayed `host` / `session_id` /
`repo_recent_terminal_evidence` (labeled as such), publisher-observed
git facts (branch — nullable on detached HEAD, short HEAD, dirty
count, status digest — nullable per §9 degradation), the folded note
verbatim with its staging metadata (§6), and `fingerprint`.

### 5. Refresh control: fingerprint no-op, a real lock, and evidence instead of suppression

Claude `Stop` fires every turn; the publisher makes that cheap and
quiet:

1. **Fingerprint no-op against the commit record**:
   `fingerprint = "fp1:" + sha256(canonical-JSON of {branch, head,
   status_digest, session_id, note content hash, workflow evidence})`.
   If the committed `entry.json` is valid, fingerprint-matched with
   `slot.json`, unchanged from the computed value, and younger than
   the refresh TTL, the publisher exits without writing. Any mixed or
   malformed generation fails this check and republishes (§4).
   Including `session_id` and the note hash means alternating
   sessions and fresh notes refresh immediately; identical-state
   churn stays suppressed.
2. **A real mutex, not a dedupe claim**: concurrent publishers
   serialize through a dedicated lock file created `O_EXCL` with an
   owner token, released in `finally`, with stale-lock takeover by age
   (bounded future-skew). `claimDedupe`
   (`notify-schema.mjs:461-520`) is the *atomic-create precedent*, not
   the mechanism — it is a once-per-TTL fire-rights record, and
   reusing it verbatim would either suppress changed captures (fixed
   key) or fail to serialize (fingerprint key). A losing/locked-out
   publisher exits silently.
3. **Evidence, not suppression**: the sensor relays
   `repo_recent_terminal_evidence: none|fresh` from the projection
   read it already performs. This is **repo-level, last-observed**
   evidence — the projection schema carries no session identity
   (`context.mjs:23-30`), so it can neither prove this session is
   in-workflow (a fresh terminal projection may be another session's)
   nor prove it is not (an active non-terminal workflow emits no
   projection at all). The publisher therefore **never suppresses on
   it**; it records it, and entry-side arbitration (ADR-0045) — which
   sees this artifact *and* the persona handoff surfaces — decides
   which source wins. An absent flag is recorded as `none`.

### 6. Semantic source: the staged note

New M1 subcommand `runtime:context note --text <t> | --file <path>`
(plus `--clear`) writes `note.json` — byte-capped, atomically renamed,
**repo-global by design**: the CLI has no trustworthy session identity
available, so the note is honestly a per-repo staging slot, not a
per-session one. To keep that honest and bound its blast radius:

- `note.json` records `staged_at`, the staging-time git context
  (branch, short HEAD — nullable), `host` when supplied, and the
  content hash that also feeds the slot fingerprint.
- The publisher folds a note only within the **fold window** (default
  24 h); older notes are ignored (not deleted). `--clear` empties the
  staging slot explicitly.
- The slot carries the note verbatim **plus** its staging metadata, so
  a consumer can see that a note staged on another branch or hours
  earlier is being republished, and weigh it accordingly. Entry-side
  (§7) exposes `note_staged_at` rather than a pre-computed age.
- `--file` reads only a regular file (`lstat`, no-follow — FIFOs,
  devices, and symlinked sources are rejected), bounded to the note
  cap.

The explicit invocation is itself the action-specific opt-in ADR-0035
invariant 1 requires for this write — the same trust level as today's
manual `context capture`. What the note does architecturally: it moves
the prose dependency from the *end* of a session (where sessions die
abruptly and prose provably never fires) to *any point during* it —
verb skills, checkpoint habits, and future ADR-0045 nudges can all
stage a note cheaply while context is alive. What it does not do is
manufacture semantics or prove authorship: a session that never stages
a note hands off a structural-only slot, and says so.

### 7. Sanitized entry projection, separate from raw status output

`entry.json` is the **only** session-capture file the entry side
(ADR-0045) should read. It is an enumerated, injection-hardened
projection:

- Fixed field set, unknown keys forbidden (the `normalizeProjection`
  discipline, `context.mjs:909-968`): schema id, `captured_at`,
  `origin`, `summary_source`, `host`, `branch`, `head_short`,
  `dirty_count`, `repo_recent_terminal_evidence`, `summary_line`,
  `note_staged_at`, `fingerprint`. `summary_line` is the clamped
  first line of the folded note; absent when `summary_source =
  structural`. Consumers recompute staleness from `captured_at` /
  `note_staged_at` — no pre-computed age field that freezes at
  publication.
- Every string single-line and length-clamped (the
  `clampReinjectField` precedent from the SessionStart backstop).
- **No imperative field**: deliberately no `next_action` /
  recommended-command slot — the SessionStart reinjection already
  excludes `next_action` as a prompt-injection vector, and this
  projection inherits that ruling. Clamping bounds the channel; it
  does **not** make the content safe — ADR-0045 must present
  `summary_line` as untrusted quoted data, never as instructions.
- **Config-off semantics**: setting `session_capture = "off"` stops
  production; existing artifacts remain on disk and readable.
  Consumers arbitrate their staleness like any other slot state;
  removing them is an operator action (or the rollback cleanup, §10).

The raw `slot.json` and the operator-facing `context status` output
(full summaries, previews) remain distinct surfaces; the projection is
smaller than both by design. `context status` gains an explicit
`--slot` selector (§10) so operators can inspect the validated
slot/entry pair without ADR-0045 machinery; the existing
`--run-id | --latest` ledger selectors are untouched.

### 8. Cross-host: an explicit v1 scope decision — Claude limb only

**This ADR decides that v1 closes only the Claude limb.** The firing
point ships on the Claude `Stop` path; there is no Codex firing point
at v1 — not a degraded one: none. This is an owner-arbitrated scope
decision recorded here, not an implication borrowed from ADR-0041
(whose Claude-only degradation covers an optional field while base
notifications still reach Codex). What Codex sessions get at v1 is
shared-filesystem **participation**: they can stage notes and run
manual captures via the CLI (prose path, `$runtime:context`), and
every artifact this ADR defines is host-neutral and readable from
either host — a Claude-captured entry is visible to a Codex session's
entry-side consumer and vice versa. Codex gets **no new hook surface**
(the two-part invariant stands). Revisit triggers: (a) Codex ships an
operator-scoped lifecycle-hook mechanism outside the plugin `/hooks`
trust flow, or (b) a dedicated ADR accepts the Codex plugin-hook trust
burden for attention.

### 9. Lifecycle, failure, and consumption semantics

- **Hook-grade output discipline, explicitly diverging from the
  operator subcommands**: `publish-session` and `note` (when
  hook/sidecar-invoked) exit 0 always, write nothing to stdout, and
  emit at most one stderr line — unlike `capture`/`status`/`check`,
  which are operator-facing reporters (stdout report, exit 1 on
  error, `context.mjs:1194-1213`). The implementing PR must not let
  the publisher inherit the reporting path. Any failure degrades to
  no-op; a capture failure must never break a turn, hook, or commit.
- **Conditional guarantee, stated**: "code-fired" means the code runs
  when the chain runs. Safe mode disables plugins and hooks entirely
  (`host-parity-baseline.md:95`), a disabled attention plugin, an
  unmet publisher floor, or a missing runtime all silently disable
  capture — that is the fail-closed design working, and the
  half-enabled states are surfaced by the §3 readiness diagnosis, not
  by breaking the hook.
- **Structural git capture is bounded**: probes follow the
  `source-snapshot.mjs:75-121` discipline (sequential bounded
  subprocesses, ~3 s / 1 MiB class caps, total hot-path budget in the
  contract doc). Degradation is per-field and honest: detached HEAD →
  `branch: null`; unborn HEAD / porcelain overflow / probe error →
  the affected fields null with the digest marked unavailable; no
  repo root at all → silent no-op (v1 is repo-scoped; non-git cwd
  produces nothing).
- **Failure recovery**: temp files use unique names; the publisher
  sweeps only its own staging area, only entries older than the
  maximum writer lifetime, bounded per run (deletion authorized by
  §3). Mixed or malformed generations republish per §4/§5. Clock
  rollback and future mtimes are bounded by the same skew tolerance
  as the lock (§4 defaults).
- **Consumption semantics**: the slot is a **durable, last-writer-wins
  advisory**, not a one-shot. The producer cannot know which entry
  event — startup, resume, post-`/clear`, post-compact — constitutes
  consumption, so it never deletes on read and encodes what a
  consumer needs to judge staleness (`captured_at`, `fingerprint`,
  `note_staged_at`, `repo_recent_terminal_evidence`). Post-compact
  turns keep refreshing the slot (Stop keeps firing), and at compact
  time the slot is at most one turn stale — which is why a PreCompact
  sensor is not part of v1 (Alternatives G). Abrupt termination emits
  no final capture; the previous turn's slot *is* the handoff (the
  rolling-checkpoint limit, stated).
- **Retention**: auto path bounded by construction (one slot). The
  manual run ledger stays append-only and unbounded **by design**,
  with visibility through `runtime:doctor`'s artifact inventory; a
  hard cap is deferred until doctor evidence shows real accumulation
  pressure.

### 10. Executor contract, add-gate, and rollout/rollback

The implementing PR extends `context.mjs` `VALID_COMMANDS`
(`context.mjs:13`) with:

- `publish-session` — the hook-fired slot publisher. Transaction
  order: config gate → canonical write-root containment check →
  acquire slot lock (`O_EXCL`, owner token) → read committed
  generation (`entry.json`) → gather bounded structural + note inputs
  → compute fingerprint → no-op or publish full generation
  (slot temp+rename, then entry temp+rename) → sweep own stale temps
  → release lock in `finally`.
- `note` — the staging write (`--text | --file | --clear`), with the
  §6 source-file hardening.

**Containment hardening is part of the executor contract**: the
existing pointer checks are lexical only
(`context.mjs:574-580`, `:1166-1173`), and the shared containment
helper explicitly requires callers to canonicalize when symlinks
matter (`path-containment.mjs:22-28`). An *automatic* writer gets the
stronger rule: the session-capture write root is canonicalized
(`realpath` of the parent), writes refuse to traverse symlinked
parents, and `note --file` applies the §6 no-follow/regular-file/size
gates. Hostile-path cases are required tests.

Both executors register in the ADR-0035 §5 enforcement machinery —
extending the executor registry's semantics if needed (today it
registers files and privileged primitives,
`tests/plugin-shape/runtime-executor-registry.mjs`); "registered" here
means the registry + static tests actually model the new mutation
primitives, not an administrative row. The add-gate items: host-truth
evidence (ADR-0040 §Context Stop truth; `host-parity-baseline.md:95`),
tier classification (M1, existing artifact domain, new
`state/runtime/session-capture/` location, §3 deletion scope), exact
command spec (this section + the contract doc), safety proof (§4
ceiling untouched: fixed argv, no shell, no host config, no session
mutation, repo-scoped canonicalized writes), artifact schemas (the
contract doc), tests, and docs (SKILL/commands/README + the contract
doc's content-token test).

Required tests, mutation-verified: gate-off default no-op; commit-record
no-op (reads `entry.json`, not `slot.json`); mixed-generation forced
republish; lock contention + stale-lock takeover + future-skew bound;
fingerprint sensitivity (session change, note change, evidence change
each republish; identical state no-ops); injection clamps on
`entry.json`; symlinked write-root refusal; `note --file`
FIFO/oversize/symlink rejection; non-git no-op; schema round-trip +
per-file malformed fail-closed skip; sensor exit-0-always with
publisher absent/below-floor; capture-before-notification ordering
with notification short-circuits not skipping capture.

**Rollout order** (the ADR-0043 release-gate shape): runtime ships
first — schemas, contract doc, config family, executors, status
`--slot`, readiness diagnosis, tests — and **releases**; only then
does attention pin the publisher floor to that released version and
ship its sensor change. **Rollback order**: consumer-first (ADR-0045
surfaces, when they exist), then `session_capture = "off"`, then
attention before runtime; durable slot/note artifacts do not
self-delete — rollback notes the one-shot cleanup
(`state/runtime/session-capture/` removal) exactly as ADR-0043 does
for its one-shot artifacts, so a stale note cannot silently resurface
after a re-upgrade.

## Consequences

**Positive**

- The out-of-workflow limb of the handoff system gains what the
  in-workflow limb got from ADR-0039: a firing point that is code on a
  path that actually runs — closing the "zero active triggers" gap for
  general sessions instead of re-stating it in prose.
- The trust split is explicit and durable: observer-labeled Tier 1
  fields, channel-honest `summary_source`, and an entry projection
  that consumers must treat as data — the artifact can never quietly
  overstate what is known.
- Spam, retention, and atomicity are solved structurally (slot +
  commit-record + fingerprint + lock + rename), not by tunable policy
  that can drift; a mixed generation is self-healing by construction.
- Entry-side work (ADR-0045) gets a stable, sanitized input contract
  — including the staleness-arbitration fields and config-off
  semantics — decided before any presentation surface exists.
- Reuses the heaviest proven mechanisms — attention's sensor ladder
  and marker reads, the notify config-key gate shape, the ADR-0043
  slot concession and release-gate/rollback shapes, the ADR-0046
  packaged-contract vehicle — introducing no new plugin, no new hook
  event, and no new mutation tier.

**Negative**

- Semantics remain prose-dependent: a session that never stages a note
  hands off structure only. This ADR narrows the prose dependency to
  "sometime during the session" but cannot eliminate it — only the
  model can say what a session meant.
- attention's charter widens (one more runtime executor it feeds) and
  it takes a one-time release, briefly spending the "rarely-releasing"
  budget that motivated its isolation.
- The Stop hot path grows: runtime discovery, projection reads, a
  publisher spawn with git probes, locking, and up to two renames run
  on every turn end when enabled — bounded per §9/§10, but the
  aggregate hook-latency budget is a real implementation constraint,
  and when disabled the no-op gate check still costs one spawn per
  turn (the accepted notify cost shape).
- The settings/doctor blast radius is larger than one config table:
  effective-config loading for a new family, plan/report/help
  coverage, readiness diagnosis, and a two-package
  (runtime → attention) release choreography.
- The firing guarantee is conditional on the hook chain being enabled
  — safe mode, plugin disablement, or floor mismatch silently disable
  capture; honesty here costs a diagnosis surface rather than a
  stronger guarantee.
- Codex sessions get no automatic capture at v1 — an explicit
  asymmetry, chosen over inventing an unproven Codex mechanism.

**Neutral**

- The manual `context capture` run-ledger path is untouched; two
  capture shapes (ledger for explicit, slot for automatic) now
  coexist, distinguished by `origin`, and the slot's only semantic
  inlet is the staged note.
- `session_capture` adds a third config-key family; the generic differ
  absorbs it, the family-specific surfaces are new work (scoped in
  §3).
- Two narrow amendments ride in this ADR rather than as separate
  amendment PRs (single-decision locality): ADR-0035 §3 invariant 1
  (scoped to `publish-session`, §3) and ADR-0031 §6's
  second-artifact clause (scoped to the session-capture slot, §4);
  ADR-0040 §3's attention charter is widened (§2). The affected ADRs
  gain pointer lines at implementation time.

## Alternatives Considered

**A. Runtime owns the Stop hook directly.** Rejected: violates
ADR-0040's placement decision (`:513-521`) — runtime releases
frequently, and a hook-bearing runtime would re-impose the Codex
`/hooks` re-attestation burden on every release; the isolation plugin
exists precisely to prevent this.

**B. Strengthen the prose (better runbook steps, louder SKILL
instructions).** Rejected on ADR-0031 Amendment grounds (`:349-352`): a
runbook step is also markdown prose; it re-states the passive gap. The
measured result of prose-only firing is zero callers.

**C. A new dedicated hook-only plugin (`session-capture`).** Rejected:
plugin proliferation with no isolation gain — attention already is the
isolated host-lifecycle sensor, already ships the discover ladder, the
freshness-checked projection reads, and the marker contract this needs.
ADR-0010 §6 high-cohesion favors absorption into the existing L1.

**D. Fire from the persona plugins' existing Stop hooks.** Rejected:
persona hooks are workflow-scoped by charter; a session-generic
capture from four persona hooks means 4× duplicated firing logic,
racing publishers, and an ownership lie (a persona plugin publishing
non-persona state).

**E. Derive semantics from the transcript (`transcript_path`).**
Rejected for v1: raw session content is an injection and secrets
surface, host-format-coupled, and the sanitization burden contradicts
the enumerated-metadata discipline ADR-0041 fought for. Revisit only
with a dedicated decision if structural-only slots prove insufficient
— and then extract enumerated signals, never prose.

**F. Append a run-ledger entry per firing (reuse `capture`
verbatim).** Rejected: `Stop` is turn-frequency; an append-only ledger
driven by it is unbounded growth and reintroduces the spam problem the
peer flagged. The slot is the load-bearing fix.

**G. Fire on `PreCompact` (or add it alongside `Stop`).**
`PreCompact` **is** recorded, plugin-registrable host truth
(`host-parity-baseline.md:95`; persona plugins already bind it,
`plugins/engineer/hooks/hooks.json:14`) — so unlike a session-end
event (for which no evidence exists), this is a genuine candidate.
Rejected for v1 on marginal value: the slot refreshes on every turn
end, so at compact time it is at most one turn stale, and post-compact
turns keep refreshing; a PreCompact sensor would add a second firing
surface (and its share of the hook budget) to close a ≤1-turn window.
If ADR-0045's compact-entry consumer shows that window matters in
practice, adding a PreCompact binding to the same publisher is a
bounded amendment — the publisher contract does not change.

**H. ADR-0041-grade activation (env-only, tracked-config-inert).**
Rejected as disproportionate: those rules exist because egress crosses
the network boundary with a credential. This surface writes repo-local
artifacts with no credential; the `notify_channel` weight class is the
matching precedent. Importing the heavier gate would also make the
notify precedent incoherent (two hook-gated M1 config keys with
inconsistent activation rules and no risk difference to justify it).

**I. One-shot consumption (delete-on-read, like the SessionStart
pending-handoff).** Rejected: the pending-handoff one-shot works
because exactly one consumer (the persona's own SessionStart hook)
owns it. This artifact has an open consumer set across hosts and entry
events; delete-on-read from any of them races the rest. Durable
last-writer-wins + self-described staleness is the stable contract.

**J. Publisher-side suppression when the repo shows fresh in-workflow
evidence.** Rejected (it was this draft's own first design): the
projection schema carries no session identity (`context.mjs:23-30`),
so "fresh terminal evidence" is neither necessary nor sufficient to
call *this* session in-workflow — it false-suppresses a concurrent
ad-hoc session after another session's terminal, misses active
non-terminal workflows entirely (they emit no projection), and races
persona-hook ordering. Recording the observation honestly
(`repo_recent_terminal_evidence`) and letting entry-side arbitration
weigh it against the persona surfaces keeps every party truthful.

## References

- ADR-0024 (context-hygiene surface), ADR-0031 + Amendment (projection
  model; §6 second-artifact clause — narrowly amended here;
  zero-active-triggers; output discipline), ADR-0035 (§1-§5; §3
  invariant 1 narrowly amended here for `publish-session`), ADR-0039
  (sidecar activation), ADR-0040 (§2 notify-scoped config-key
  amendment — shape, not license; §3 attention charter — widened
  here; 2026-07-11 packaging amendment), ADR-0041 (§3a opt-in shape;
  Claude-only-field degradation — shape, not equivalence), ADR-0043
  (slot concession; footer-rendered cross-package contract;
  released-floor rule; rollback shape), ADR-0046 (Proposed;
  packaged-contract vehicle; machine-global M1 location not extended
  here).
- Host truth: `plugins/runtime/docs/host-parity-baseline.md:95`
  (Claude lifecycle vocabulary incl. `PreCompact`/`PostCompact`; safe
  mode), `plugins/runtime/docs/codex-capability-baseline.md:63-68`
  (Codex vocabulary), `0040-operator-observability.md:64-68` (Stop
  fires per turn end).
- Code anchors: `plugins/runtime/scripts/context.mjs` (`:12-13`,
  `:23-30`, `:54-121`, `:574-583`, `:657`, `:691-726`, `:909-968`,
  `:1129-1151`, `:1166-1173`, `:1194-1213`),
  `plugins/runtime/scripts/lib/runtime-config.mjs:24-43`,
  `plugins/runtime/scripts/notify.mjs:133-190`,
  `plugins/runtime/scripts/lib/notify-schema.mjs:461-520`,
  `plugins/runtime/scripts/lib/path-containment.mjs:22-28`,
  `plugins/runtime/scripts/source-snapshot.mjs:75-121`,
  `plugins/attention/scripts/discover-runtime.mjs:35-41`,
  `plugins/attention/scripts/lib/sensor.mjs` (`:318-444`, `:471-492`,
  `:648-725`), `plugins/attention/adapters/claude/hooks/stop.mjs`
  (`:47-51`, `:114-140`), `plugins/runtime/README.md:7`,
  `tests/plugin-shape/runtime-executor-registry.mjs`.
- Macro provenance: `macro-plan-20260712T022752Z-d542f5` subtask S5;
  macro plan-verify edge-case pointers (capture spam, non-git cwd,
  malformed-artifact pinning, consumption semantics); ADR number 0044
  reserved by that plan. Draft plan-verify peer run
  `plan-verify-20260718T053114Z-17f4ef5e` (verdict: modify — 5
  Blockers, 6 Majors, 3 Moderates, 1 Minor, 12 factual corrections;
  all source-verified and folded into this revision).
