# plugins/attention — hook-only Claude attention sensors

Hook-only **Layer 1 framework primitive** per
[ADR-0040 §3](../../docs/adr/0040-operator-observability.md), amended by
[ADR-0044 §2](../../docs/adr/0044-session-generic-handoff-capture.md) from
"notification sensors" to **host-lifecycle sensors feeding allowlisted
runtime-owned executors** — today `notify.mjs emit` (operator notifications)
and `context.mjs publish-session` (the session-capture publisher). It ships
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
| `Stop` | — (none exists) | `workflow-terminal` when a **fresh** persona projection proves a terminal workflow, else `turn-complete` | `<workflow_id>` / `session:<session_id>:<prompt_id>` | normal |
| `SubagentStop` | — (`agent_type` available for tuning) | `subagent-complete` | `<agent_id>` | normal |

The kind/subject mapping is the ADR-0040 §1 **contract**, not sensor
discretion — the approval content-hash keeps two different approval prompts
in one session from deduping against each other; the bare-Stop subject uses
only documented common input fields (`session_id`, `prompt_id`), never a
Stop-specific payload field.

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

**Dual capability floors** (ADR-0044 §2 — the two gates never share a
constant): the notify emit seam stays gated at `MIN_RUNTIME_VERSION`
(`0.71.0`, the first runtime release shipping `notify.mjs`), while the
capture spawn is gated at `PUBLISH_SESSION_MIN_RUNTIME_VERSION` (`0.82.0`,
the first **released** runtime shipping `publish-session`, recorded by the
ADR-0044 §Status S4a release-proof gate). Below the publisher floor the
sensor skips the capture spawn silently while notifications keep working;
when the floor passes but the resolved runtime root lacks
`scripts/context.mjs` (capability drift), capture no-ops equally silently
without disabling notifications. The plugin ships the floor as a
**declaration file** for the runtime-side readiness diagnosis
(session-capture-contract §13):

```
data/runtime-floors.json
  { "schema": "attention-runtime-floors-1.0",
    "floors": { "publish_session": "0.82.0" } }
```

The sensor's spawn-gate constant and this declaration must agree
byte-for-byte — `tests/plugin-shape/test-attention-plugin.mjs` pins the
pair, alongside the plain-`X.Y.Z` released-floor rule.

### Stop hot-path budget (contract values)

The Stop hook's worst-case latency is a stated contract
(`scripts/lib/sensor.mjs`, test-pinned), not an accident of defaults:

| Constant | Value | Meaning |
|---|---|---|
| `EMIT_SLOT_MS` | 12 s | one emission slot: the 8 s egress network budget + node-startup/preflight headroom |
| `TERMINAL_BATCH_DEADLINE_MS` | 24 s | terminal-notification batching: at most two FULL slots, full-slot-or-nothing (ADR-0043 §3) |
| `PUBLISH_SESSION_TIMEOUT_MS` | 12 s | the capture spawn's own slot — bounded git probes + local IO, no network |
| `STOP_HOT_PATH_BUDGET_MS` | 36 s | aggregate worst case: one capture slot + the two-slot notification deadline |

A publisher or emitter that overruns its slot is killed and the event/capture
is lost — the ADR-0040 §7 fail-closed choice (never a blocked host; the
previous turn's slot remains the session handoff).

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
shelling out to `context.mjs publish-session`.

**Notifications are off by default**: the runtime ships
`notify_channel = "none"`. Opt in via `runtime:settings` (`notify_channel`,
`notify_quiet_hours`, `notify_dedupe_ttl_seconds`, `notify_kinds`, …).
Delivery/troubleshooting history is pull-side: `runtime:dashboard` Tier 2 and
the `file-log` channel's `.agentic-plugins/state/runtime/notify/log.ndjson`.

## Invariants (ADR-0040 §7)

- **Fail-closed silent everywhere**: sensors exit 0 always, never write
  stdout (hook stdout is a decision channel), and degrade to no-op on any
  failure — a notification or capture failure must never break a workflow,
  commit, or hook.
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
│   └── subagent-stop.mjs
├── data/
│   └── runtime-floors.json        # §13 publisher-floor declaration (byte-for-byte
│                                  #   with the sensor spawn gate; test-pinned)
├── scripts/
│   ├── discover-runtime.mjs       # ADR-0039 §5 ladder copy; notify ≥ 0.71.0 gate
│   │                              #   + publish-session ≥ 0.82.0 gate (dual floors)
│   └── lib/sensor.mjs             # §1 contract copies + freshness gate + emit seam
│                                  #   + capture spawn seam + budget contract values
└── skills/README.md               # Codex manifest-spec placeholder (ADR-0008 carve-out)
```
