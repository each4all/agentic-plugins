# plugins/attention — hook-only Claude attention sensors

Hook-only **Layer 1 framework primitive** per
[ADR-0040 §3](../../docs/adr/0040-operator-observability.md): tiny Claude
Code lifecycle-hook sensors that push "this needs the operator now" moments
into the runtime notification pipeline. It ships **hooks + sensor scripts
only** — no skills, no verbs, no state machinery — the hook-bearing sibling
of the [ADR-0008](../../docs/adr/0008-companion-distribution-model.md)
script-only library shape, isolated in its own rarely-releasing plugin so the
hook review/trust burden never attaches to frequently-releasing packages
(ADR-0010 §6 Trigger 2).

## What it registers (Claude Code, `hooks/hooks.json`)

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
persona (engineer, orchestrator):

1. **workflow-id consistency** — the projection's `workflow_id` must match
   the `.footer-rendered` marker's, and the marker must record
   `status: "rendered"` (a `claimed` marker is a render in flight, not a
   completed terminal presentation);
2. **mtime bound** — the projection must be recent
   (`HANDOFF_FRESHNESS_MS`, 10 minutes), so a lingering one-shot projection
   stops re-classifying later turns;
3. **per-persona marker shape** — engineer keys
   `<projection>.footer-rendered`; orchestrator keys
   `<projection>.<workflow-id>.footer-rendered` (the shapes differ by
   design; the sensor mirrors both).

A stale or missing projection degrades to a **bare** `turn-complete`
notification — never a wrong workflow claim. Founder writes no sidecar at v1
and therefore stays bare-Stop-only (its richer coverage comes from the
ADR-0040 §5 peer-run self-sensors).

## How events reach a channel

Each sensor resolves the runtime plugin root via a copied
`scripts/discover-runtime.mjs` (ADR-0039 §5 ladder: `AGENTIC_RUNTIME_ROOT`
env override → Claude cache SemVer-max → Codex fixed cache → sibling
monorepo), **version-gated to runtime ≥ 0.71.0** — the first released runtime
shipping `notify.mjs` (pinned by the ADR-0040 release-gate). A missing or
too-old runtime is a silent no-op with no stale-cache fallback. The sensor
then shells out to `notify.mjs emit` with the event JSON on stdin; the §1
pipeline (validate → kinds-filter → dedupe → quiet-hours → redact →
dispatch) runs runtime-side.

**Notifications are off by default**: the runtime ships
`notify_channel = "none"`. Opt in via `runtime:settings` (`notify_channel`,
`notify_quiet_hours`, `notify_dedupe_ttl_seconds`, `notify_kinds`, …).
Delivery/troubleshooting history is pull-side: `runtime:dashboard` Tier 2 and
the `file-log` channel's `.agentic-plugins/state/runtime/notify/log.ndjson`.

## Invariants (ADR-0040 §7)

- **Fail-closed silent everywhere**: sensors exit 0 always, never write
  stdout (hook stdout is a decision channel), and degrade to no-op on any
  failure — a notification failure must never break a workflow, commit, or
  hook.
- **Observers, not actors**: no Stop `decision` output, no host-session
  mutation, no persona-Stop ordering assumption (Claude fires all plugins'
  Stop hooks without ordering guarantees).
- **Copy-not-import** (ADR-0010 §5): the §1 contract derivations
  (repo-ident, event_id composition, subjects) live as behavior-identical
  copies in `scripts/lib/sensor.mjs`; the canonical source is the runtime's
  `lib/notify-schema.mjs`, and `tests/plugin-shape/test-attention-plugin.mjs`
  holds the parity gate.

## Codex CLI at v1

**No Codex `hooks.json` ships in this plugin** — the entire Codex `/hooks`
review/trust burden is avoided until ADR-0040 §4c's deferred
`PermissionRequest` path is triggered. Installing `attention` on Codex is
inert (the `skills/` directory is the Codex manifest-spec placeholder per
the ADR-0008 carve-out). Codex-side attention is planned natively through
`runtime:settings --notification-plan` M1 fragments (`notify=` +
`tui.notifications`), per ADR-0040 §4.

## Layout

```
plugins/attention/
├── .claude-plugin/plugin.json     # Claude manifest
├── .codex-plugin/plugin.json      # Codex manifest (inert at v1)
├── hooks/hooks.json               # Claude hook registration (adapter surface)
├── adapters/claude/hooks/         # sensor entry scripts (host-specific)
│   ├── notification.mjs
│   ├── stop.mjs
│   └── subagent-stop.mjs
├── scripts/
│   ├── discover-runtime.mjs       # ADR-0039 §5 ladder copy, ≥ 0.71.0 gate
│   └── lib/sensor.mjs             # §1 contract copies + freshness gate + emit seam
└── skills/README.md               # Codex manifest-spec placeholder (ADR-0008 carve-out)
```
