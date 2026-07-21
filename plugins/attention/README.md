# plugins/attention — hook-only Claude attention sensors

Hook-only **Layer 1 framework primitive** per
[ADR-0040 §3](../../docs/adr/0040-operator-observability.md), amended by
[ADR-0044 §2](../../docs/adr/0044-session-generic-handoff-capture.md) and
[ADR-0045 §2](../../docs/adr/0045-entry-time-proposal-surfaces.md) from
"notification sensors" to **host-lifecycle sensors feeding allowlisted
runtime-owned executors** — today `notify.mjs emit` (operator notifications),
`context.mjs publish-session` (the session-capture publisher), and
`context.mjs entry-brief` (the R0 entry arbiter). It ships
**hooks + sensor scripts only** — no skills, no verbs, no state machinery —
the hook-bearing sibling of the
[ADR-0008](../../docs/adr/0008-companion-distribution-model.md)
script-only library shape, isolated in its own rarely-releasing plugin so the
hook review/trust burden never attaches to frequently-releasing packages
(ADR-0010 §6 Trigger 2).

## What it registers (Claude Code, manifest-declared `adapters/claude/hooks/hooks.json`)

| Hook event | Matcher | Event kind (ADR-0040 §1) | Subject | Urgency |
|---|---|---|---|---|
| `Notification` | `permission_prompt` | `approval` | `session:<session_id>:<message-content-hash>` | urgent |
| `Notification` | `idle_prompt` | `idle` | `session:<session_id>` | normal |
| `Stop` | — (none exists) | `workflow-terminal` when a **fresh** persona projection proves a terminal workflow; else EXACTLY ONE of `response-needed` (classified **final**, ADR-0047 §2) or `turn-complete` (interim / unpromotable / below the §9 floor) | `<workflow_id>` / `session:<session_id>:<prompt_id>` (shared by both bare kinds; the differing kind keeps dedupe keys distinct) | normal |
| `SubagentStop` | — (`agent_type` available for tuning) | `subagent-complete` | `<agent_id>` | normal |
| `SessionStart` | `startup` (explicit, `timeout: 15`) | — (no notify event; relays the ADR-0045 entry-brief line, or nothing) | — | — |

The kind/subject mapping is the ADR-0040 §1 **contract**, not sensor
discretion — the approval content-hash keeps two different approval prompts
in one session from deduping against each other; the bare-Stop subject uses
only documented common input fields (`session_id`, `prompt_id`), never a
Stop-specific payload field. The SessionStart row is not a notify-pipeline
sensor at all: it is the ADR-0045 §7 entry sensor (below), whose only
output channel is the hook's own stdout-into-context line.

### The Stop sensor's freshness gate

`workflow-terminal` is emitted **only** behind a freshness-checked read of
`last-session-handoff.json` (the ADR-0031/0039 sidecar projection), per
persona — all four onboarded personas since the ADR-0043 §3 follow-up
(engineer, orchestrator, founder, designer):

1. **workflow-id + kind consistency** — the projection's `workflow_id` must
   match the `.footer-rendered` marker's, the marker must record
   `status: "rendered"` (a `claimed` marker is a render in flight, not a
   completed terminal presentation), and the projection's `workflow_kind`
   must strictly equal the persona (the canonical bounded schema requires
   the field — a malformed projection degrades, never enriches);
2. **transition anchor** — both the projection's mtime AND the rendered
   marker's `at` timestamp (the render moment) must be recent
   (`HANDOFF_FRESHNESS_MS`, 10 minutes). The marker anchor is what ties
   enrichment to the terminal *transition*: founder/designer publish-needed
   workflows stay active-terminal with their Stop backstop refreshing the
   projection every turn, but the rendered `at` is written once per
   transition — so later turns degrade back to bare `turn-complete` instead
   of re-notifying once per rolling dedupe-TTL window (a primary
   re-terminalization rewrites the marker and re-arms enrichment);
3. **per-persona marker shape** — engineer, founder, and designer key
   `<projection>.footer-rendered`; orchestrator keys
   `<projection>.<workflow-id>.footer-rendered` (the shapes differ by
   design; the sensor consumes each persona's documented contract —
   founder/designer's lives in their `session-handoff.md` runbooks per
   ADR-0043 §2).

A stale or missing projection degrades to a **bare** `turn-complete`
notification — never a wrong workflow claim. For the manually-published
personas (founder/designer) an `archive_gate` of `blocked` usually means
the completion contract's `publish-needed` state, which the frozen 8-field
projection cannot distinguish from a genuine blocker — so their
`workflow-terminal` events omit the opt-in `headline` token on `blocked`
rather than overclaim (map-or-omit).

### The Stop sensor's finality classifier (ADR-0047 §2/§3/§9)

At a **bare** Stop (no fresh terminal projection), the sensor classifies
interim vs final from **structural evidence only** and emits exactly one
signal class (§3 no-duplicate default — dedupe cannot enforce this, the
producer rule does):

| # | Evidence | Reading |
|---|---|---|
| 1 | `payload.background_tasks` (Stop input, Claude ≥ 2.1.145; shape probed live on 2.1.216) | well-formed array = observable; **any resident entry ⇒ interim** (completed tasks were observed *removed* from the list, and no terminal status token was ever observed surviving in it — residents read not-terminal, never a guessed token set) |
| 2 | `payload.session_crons` (same) | well-formed array = observable; **non-empty ⇒ interim** (a scheduled session cron resumes the session by itself) |
| 3 | Peer-run ledgers of all four personas (canonical + the engineer/orchestrator legacy homes) | `running`/`cancel_requested` with a recorded PID answering `process.kill(pid, 0)` ⇒ live; PID-less `queued`/`spawning` inside the ledger's own 60 s stale-grace ⇒ live; **any live handle ⇒ interim** |
| 4 | Neither payload field observable | **no promotion** — the bare `turn-complete` exactly as pre-ADR-0047 |

**Final** — and therefore `response-needed` with the `your-turn` headline —
requires ALL of: at least one payload field observable **and well-formed**
(a present-but-null/scalar/malformed field is *unobservable*, never
"empty"), no interim evidence from any row, and a **complete** row-3 scan
(every home readable, every handle well-formed and non-future-skewed, no
per-persona cap or wall-clock budget exhaustion, no ambiguous dual-home
state). Any incomplete scan blocks promotion — a live handle hiding beyond
a cap must not produce a false final. Classifier errors of any kind degrade
to `turn-complete` (fail-closed observer, ADR-0040 §7).

Honest blind spots (accepted, conservative-direction — these suppress
`response-needed`, never fabricate it): peer-run handles carry no session
identity, so row 3 is **repo-scoped** (a live peer run from a different
session in the same repo reads interim); the classifier never runs the
ledger's `ps` fingerprint verifier (no spawn on the hot path), so a PID
recycled by an unrelated process reads live ⇒ interim; and hosts below
2.1.145 never promote (row 4). Repo-scoped row-3 false negatives are
accepted behavior, not classifier defects. The classifier never opens
`transcript_path` (ADR-0044 Alt E stands).

The whole path sits behind the **dedicated released-runtime floor**
`RESPONSE_SIGNAL_MIN_RUNTIME_VERSION` (`0.84.0` — ADR-0047 §8 Release A,
declared in `data/runtime-floors.json` as `floors.response_signal`; the
fourth floor, never shared with the notify/publisher/entry gates). Below
it the sensor takes the pre-ADR-0047 bare path — `turn-complete`, no
classifier work, no headline — and the emit seam re-checks the same floor
(`emitEvent({ minVersion })`) so a cache swap cannot hand the kind to a
pre-contract runtime. Keep the ADR-0047 §8 **dual-kind window** open
(`notify_kinds` including both `turn-complete` and `response-needed`, or
unset) until both producers are verified upgraded.

Headline producers (ADR-0047 §4, the narrow ADR-0041 §3a amendment):
`response-needed` ⇒ `your-turn` and `approval` ⇒ `needs-approval` are
**total** maps — the kind/matcher IS the structural signal, so map-or-omit
is preserved upstream (an uncertain classification never produces the kind;
the host's `permission_prompt` matcher involves no inference). The
`idle_prompt` path and the (now interim-only) `turn-complete` stay
headline-free. Headlines remain egress-display fields behind the §3a
default-OFF opt-in.

### The Stop sensor's session-capture spawn (ADR-0044 §2)

Since the ADR-0044 amendment the Stop sensor runs in three explicit stages:
**shared evidence collection** (payload, repo root, the per-persona
projection reads above) → **capture spawn** → **notification**. The capture
stage shells out to the runtime's `context.mjs publish-session` with fixed
argv — `--repo-root` (the same payload-`cwd` resolution the sensor already
performs), `--host claude`, a clamped optional `--session-id`, and
`--workflow-evidence fresh` only when the projection read observed a fresh
terminal projection (an absent flag is recorded as `none` publisher-side).
Each stage sits in its own failure boundary, ordered so that:

- notification eligibility short-circuits (missing `session_id`/`prompt_id`,
  no terminal event, notify errors) **never skip the capture spawn**, and
- capture failure (or a hung publisher, killed at its one-slot timeout)
  **never skips notification**.

The sensor stays policy-free: the `session_capture` opt-in gate (shipped
default `off`), fingerprint no-op, lock, and atomic publication are all
evaluated inside the runtime publisher (ADR-0044 §3). Capture is
repo-scoped — a non-git `cwd` produces nothing on either stage.

**Triple capability floors** (ADR-0044 §2 + ADR-0045 §12 — the three gates
never share a constant): the notify emit seam stays gated at
`MIN_RUNTIME_VERSION` (`0.71.0`, the first runtime release shipping
`notify.mjs`), the capture spawn at `PUBLISH_SESSION_MIN_RUNTIME_VERSION`
(`0.82.0`, the first **released** runtime shipping `publish-session`,
recorded by the ADR-0044 §Status S4a release-proof gate), and the entry
spawn at `ENTRY_BRIEF_MIN_RUNTIME_VERSION` (`0.83.0`, the first **released**
runtime shipping `entry-brief`, recorded by the ADR-0045 §Status S8a
release-proof gate). Below its own floor each spawn skips silently while the
other capabilities keep working; when a floor passes but the resolved
runtime root lacks `scripts/context.mjs` (capability drift), that spawn
no-ops equally silently without disabling anything else. The plugin ships
the floors as a **declaration file** for the runtime-side readiness
diagnosis (session-capture-contract §13 + §18; `entry_brief` is the §18
additive sibling key — a floors file without it is the honest
pre-entry-sensor state, never malformed):

```
data/runtime-floors.json
  { "schema": "attention-runtime-floors-1.0",
    "floors": { "publish_session": "0.82.0", "entry_brief": "0.83.0",
                "response_signal": "0.84.0" } }
```

Each declared spawn-gate constant and its declaration key must agree
byte-for-byte — `tests/plugin-shape/test-attention-plugin.mjs` pins the
pairs, alongside the plain-`X.Y.Z` released-floor rule (the notify floor
stays code-pinned only; the declaration file carries the two
runtime-diagnosed keys). Prerelease semantics: the DECLARATION rule is
aligned on both sides (this file must carry clean released `X.Y.Z` values,
and the runtime-side diagnosis refuses anything else), and the GATE
comparators agree in strictness — the sensors' strict `versionGte` and the
runtime diagnosis's shared `semverCompare` (runtime `lib/semver.mjs`,
prerelease tie-break) both hold an equal-core prerelease
(`0.83.0-beta.1`) below the floor (the S9 runtime-owned follow-up, closed).
A prerelease-versioned runtime install still does not occur under
release-please (plain `X.Y.Z` only), so the case stays theoretical on both
sides.

### Stop hot-path budget (contract values)

The Stop hook's worst-case latency is a stated contract
(`scripts/lib/sensor.mjs`, test-pinned), not an accident of defaults:

| Constant | Value | Meaning |
|---|---|---|
| `EMIT_SLOT_MS` | 12 s | one emission slot: the 8 s egress network budget + node-startup/preflight headroom |
| `TERMINAL_BATCH_DEADLINE_MS` | 24 s | terminal-notification batching: at most two FULL slots, full-slot-or-nothing (ADR-0043 §3) |
| `PUBLISH_SESSION_TIMEOUT_MS` | 12 s | the capture spawn's own slot — bounded git probes + local IO, no network |
| `STOP_HOT_PATH_BUDGET_MS` | 36 s | aggregate worst case: one capture slot + the two-slot notification deadline |
| `PEER_SCAN_PER_PERSONA_CAP` | 1024 | ADR-0047 §2 row-3 bound: handles scanned per persona (newest-first when over; exhaustion blocks promotion, never a false final) |
| `PEER_SCAN_BUDGET_MS` | 1 s | ADR-0047 §2 row-3 wall-clock cutoff — runs INSIDE the bare path's single emission slot; the classifier adds **no slot** to the 36 s aggregate and spawns nothing (`process.kill(pid, 0)` only) |

A publisher or emitter that overruns its slot is killed — **SIGKILL**,
mirroring the entry-brief spawn's kill bound (SIGTERM is trappable: a
trapped child would ride past the slot to the host's own hook timeout) —
and the event/capture is lost — the ADR-0040 §7 fail-closed choice (never a
blocked host; the previous turn's slot remains the session handoff).

### The SessionStart entry sensor (ADR-0045 §7)

`adapters/claude/hooks/session-start.mjs` is the entry-brief rollout's one
hook surface: it resolves the repo root from the **payload-carried** cwd
(no process-cwd fallback — this surface injects into model context, so
malformed/empty hook input degrades to injecting nothing; non-git cwd ⇒
silent no-op), shells the runtime's `context.mjs entry-brief` with fixed
argv (`--repo-root <resolved> --host claude --surface session-start-hook`),
and relays **at most one marker-paired line**
(`[agentic-entry-brief] {…} [/agentic-entry-brief]`) into model context via
the hook's documented stdout channel. Discovery is **capability-neutral**
(`resolveNewestRuntimePluginRoot`: manifest identity, no `notify.mjs`
filter — a runtime build carrying only the arbiter is still discoverable),
then the entry floor and the executor-existence probe gate that ONE newest
root with no re-descent to an older build — the exact dispatcher shape the
§18 readiness diagnosis mirrors. Every arbitration/precedence/gate decision
is arbiter-side (ADR-0045 §1); the user-scope-only `entry_brief` key
(default `off`) is evaluated inside the executor, so the sensor stays
policy-free — the gate-off spawn is the accepted cost shape
(session-capture-contract §15.3: 1 git spawn + 2 config reads, zero state
reads).

This sensor is the **scoped ADR-0040 §2.2 sensor-output exception**: stdout
carries exactly the one brief line or nothing; every notify-pipeline sensor
remains stdout-silent by the original invariant. The relay sits behind a
**validation boundary** (`sensor.mjs validateEntryBriefStdout`, dispatched
by `spawnEntryBrief`):

- **bounded buffer** — `spawnSync` `maxBuffer` 64 KiB; overflow kills the
  child and suppresses;
- **successful child exit** — no spawn error, no signal, exit status 0 (a
  conforming hook-grade executor exits 0 even for its no-line
  dispositions); the kill signal is **SIGKILL** (SIGTERM is trappable — a
  misbehaving child could otherwise ride to the host hook timeout);
- **exactly one marker-paired line** — one trailing LF permitted, nothing
  before or after, each marker occurring exactly once; empty stdout is the
  normal gate-off no-op;
- **a schema-declaring JSON payload** — the wrapped content must parse as
  a plain JSON object with `schema: "runtime-entry-brief-1.0"`, so a
  nonconforming executor cannot turn the relay into an arbitrary
  context-injection channel;
- **no extra output, no control characters (incl. U+2028/U+2029/U+FFFD),
  byte-capped** — a line over the contract's 4096-byte hook-line cap, a
  control character, or any second line is suppressed, never trimmed and
  never relayed.

The marker requirement doubles as the `"continue": false` defense: a
marker-paired line can never parse as a bare JSON hook response, so the
sensor cannot be steered into the one structured output that halts Claude
entirely (probed matrix, failure-isolation row); a marker-*wrapped*
`{"continue": false}` is inert data and additionally fails the schema
check.

**Probe gate** (ADR-0045 §7/§12, S9 gate policy): registration is valid only
while the version-bound SessionStart matrix verdict in
`plugins/runtime/docs/host-parity-baseline.md` holds for the installed CLI —
`matcher: "startup"` fires exactly once per fresh session, injects stdout
into context, is non-blocking on failure, and honors the explicit per-hook
`timeout` (seconds). Probed PASS on `2.1.214` (2026-07-18), re-validated
live on `2.1.215` (2026-07-20). On a failed or stale re-validation the hook
surface stays unshipped; the CLI + dashboard surfaces ship regardless.

### SessionStart budget (contract values)

Synchronous SessionStart handlers delay session entry until they finish
(probed matrix), so the entry sensor's latency is a stated contract
(`scripts/lib/sensor.mjs`, test-pinned):

| Constant | Value | Meaning |
|---|---|---|
| `ENTRY_BRIEF_TIMEOUT_MS` | 12 s | the executor spawn's **kill bound** (SIGKILL), not a completion guarantee — the runtime's ≤5 sequential bounded git probes can theoretically sum past it, in which regime the spawn is killed and the brief lost; the typical warm-cache path completes in milliseconds |
| `SESSION_START_HOOK_TIMEOUT_S` | 15 s | the explicit per-hook `timeout` registered in hooks.json (seconds — the Claude unit); host-enforced ceiling over node startup + discovery + the spawn |
| `SESSION_START_BUDGET_MS` | 15 s | aggregate worst case: attention registers exactly ONE SessionStart hook, so the aggregate equals that hook's host-enforced timeout |

An executor that overruns its slot is killed and the brief line is lost —
the ADR-0040 §7 fail-closed choice (never a delayed session entry beyond
the budget; the operator still has the CLI and dashboard surfaces).

**Rollback** (ADR-0045 §12, consumer-first): set `entry_brief = "off"` in
the **user-global** config — and clear any `AGENTIC_ENTRY_BRIEF` /
`AGENTIC_ENTRY_BRIEF_EMPTY` environment values first, since env outranks
user config and a lingering `startup` env value keeps the line firing —
then remove/release the attention sensor, verify no firing, and remove the
runtime surface last. The entry side is R0: no durable entry-side
artifacts exist to clean.

## How events reach a channel

Each sensor resolves the runtime plugin root via a copied
`scripts/discover-runtime.mjs` (ADR-0039 §5 ladder: `AGENTIC_RUNTIME_ROOT`
env override → Claude cache SemVer-max → Codex fixed cache → sibling
monorepo), **version-gated to runtime ≥ 0.71.0** — the first released runtime
shipping `notify.mjs` (pinned by the ADR-0040 release-gate). A missing or
too-old runtime is a silent no-op with no stale-cache fallback. The sensor
then shells out to `notify.mjs emit` with the event JSON on stdin; the §1
pipeline (validate → kinds-filter → dedupe → quiet-hours → redact →
dispatch) runs runtime-side. The Stop sensor's capture spawn resolves the
same ladder but applies its **own higher floor** (≥ 0.82.0, above) before
shelling out to `context.mjs publish-session`; the SessionStart entry
spawn does the same with its own floor (≥ 0.83.0) and, uniquely, captures
the executor's stdout through the validation boundary instead of
discarding it.

**Notifications are off by default**: the runtime ships
`notify_channel = "none"`. Opt in via `runtime:settings` (`notify_channel`,
`notify_quiet_hours`, `notify_dedupe_ttl_seconds`, `notify_kinds`, …).
Delivery/troubleshooting history is pull-side: `runtime:dashboard` Tier 2 and
the `file-log` channel's `.agentic-plugins/state/runtime/notify/log.ndjson`.
**The entry brief is equally off by default**: the user-scope-only
`entry_brief` key ships `off` (a tracked repo value can never enable it);
opt in via `runtime:settings --entry-brief startup`, diagnosed by the §18
`entry_readiness` section in settings/doctor.

## Invariants (ADR-0040 §7)

- **Fail-closed silent everywhere**: sensors exit 0 always, never write
  stdout (hook stdout is a decision channel), and degrade to no-op on any
  failure — a notification or capture failure must never break a workflow,
  commit, or hook. The ONE scoped exception is the ADR-0045 §2.2 entry
  sensor, whose single validated marker-paired stdout line is its
  deliberate output channel; it emits nothing else, never a structured
  hook response, and stays exit-0-always.
- **Observers, not actors**: no Stop `decision` output, no host-session
  mutation, no persona-Stop ordering assumption (Claude fires all plugins'
  Stop hooks without ordering guarantees). The capture spawn relays
  observations only — every policy decision (opt-in gate, fingerprint,
  lock) is publisher-side (ADR-0044 §3).
- **Capture and notification never gate each other** (ADR-0044 §2): capture
  runs first in its own failure boundary; notification short-circuits never
  skip it, and its failure never skips them.
- **Copy-not-import** (ADR-0010 §5): the §1 contract derivations
  (repo-ident, event_id composition, subjects) live as behavior-identical
  copies in `scripts/lib/sensor.mjs`; the canonical source is the runtime's
  `lib/notify-schema.mjs`, and `tests/plugin-shape/test-attention-plugin.mjs`
  holds the parity gate.

## Codex CLI

The plugin contributes **zero plugin-owned Codex hook surface**, by both
discovery inputs current Codex actually uses (host truth, Codex 0.144.1 —
recorded in the ADR-0040 §3 amendment):

1. `.codex-plugin/plugin.json` declares **no `hooks` key**, and
2. there is **no root `hooks/hooks.json`** — Codex's default-file discovery
   loads that location regardless of command shape, which is exactly why the
   Claude registration is manifest-scoped at
   `adapters/claude/hooks/hooks.json` instead of the default path.

Non-declaration alone does NOT keep a default-location hooks file out of the
Codex `/hooks` review/trust surface; path isolation does. The `skills/`
directory remains the Codex manifest-spec placeholder per the ADR-0008
carve-out. Codex-side attention is owned natively by
`runtime:settings --notification-plan` M1 fragments (`notify=` +
`tui.notifications`), per ADR-0040 §4; the §4(c) programmable
`PermissionRequest` hook stays deferred behind its adoption trigger.

## Layout

```
plugins/attention/
├── .claude-plugin/plugin.json     # Claude manifest ("hooks" → adapters path)
├── .codex-plugin/plugin.json      # Codex manifest (no hooks key)
├── adapters/claude/hooks/         # Claude adapter surface (host-specific)
│   ├── hooks.json                 # hook registration (manifest-declared;
│   │                              #   NOT at the Codex default-discovery path)
│   ├── notification.mjs           # sensor entry scripts
│   ├── stop.mjs                   # 3-stage: shared evidence → capture → notify
│   ├── subagent-stop.mjs
│   └── session-start.mjs          # ADR-0045 §7 entry sensor (startup matcher,
│                                  #   validated single-line stdout relay)
├── data/
│   └── runtime-floors.json        # §13+§18 floor declarations (byte-for-byte
│                                  #   with the sensor spawn gates; test-pinned)
├── scripts/
│   ├── discover-runtime.mjs       # ADR-0039 §5 ladder copy; notify ≥ 0.71.0 gate
│   │                              #   + publish-session ≥ 0.82.0 + entry-brief
│   │                              #   ≥ 0.83.0 gates (triple floors)
│   └── lib/sensor.mjs             # §1 contract copies + freshness gate + emit seam
│                                  #   + capture spawn seam + entry-brief dispatch
│                                  #   seam (validation boundary) + budget values
└── skills/README.md               # Codex manifest-spec placeholder (ADR-0008 carve-out)
```
