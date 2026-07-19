# ADR-0040: Operator situational awareness — attention notifications and state dashboard

## Status

Accepted

**§3's attention charter widened by
[ADR-0044](0044-session-generic-handoff-capture.md) §2 (2026-07-18)** — from
"notification sensors" to *host-lifecycle sensors feeding allowlisted
runtime-owned executors* (today: `notify.mjs emit` and `context.mjs
publish-session`). The widening is bounded: attention remains hook-only (no
skills, verbs, or state), remains Claude-manifest-scoped with zero Codex hook
surface (the two-part invariant stands), and the capture spawn gets its own
publisher capability floor, separate from the notify floor — the two gates
never share a constant, and the publisher floor is pinned only after the
runtime release shipping `publish-session` exists.

<!--
Relates to ADR-0024 (runtime operator control plane — doctor/settings/
context scope this ADR extends), ADR-0030/0035 §6 (context on Codex hook
enablement/trust mechanics; keeping runtime hook-free is THIS ADR's own
placement decision), ADR-0031/0039 (session-handoff projection + footer
sidecar — the payload substrate and the `discoverRuntimePluginRoot`
resolver pattern the attention sensors copy), ADR-0035 (execution
boundary — the §4 permanent ceiling that shapes the channel model; this
ADR is the governing ADR for the fixed-argv notification dispatch and
notify-state retention it adds, per Decision §2, without touching §4),
ADR-0010 §6 (plugin-boundary trigger evaluation for `plugins/attention`,
per Decision §3), ADR-0008 (script-only plugin-shape precedent the
hook-only shape mirrors), and ADR-0038 (M1 fragment-plan precedent the
Codex notification plans reuse). Implementation follows as a separate
`orchestrator:plan` multi-slice macro; this document is the design
record.
-->

## Context

agentic-plugins has grown a complete *pull*-side operator surface —
`runtime:doctor` diagnosis, `runtime:context` handoff, the ADR-0039
completion footer, workflow/peer-run/consensus ledgers under
`.agentic-plugins/` — but has **zero push-side machinery**: a repo-wide
scan (2026-07-02) found no notification code anywhere (`grep
osascript|terminal-notifier|node-notifier|notify-send` over all `*.mjs` =
0 hits), and no aggregate state view: the operator reconstructs "what
needs me now" by re-running doctor and reading ledger files.

The operating pattern that makes this a real gap: multiple concurrent
sessions and background peer runs (engineer peer-runs ≈ 90 ledger dirs,
orchestrator macros, consensus rounds). The moments that need operator
attention are (1) a host is **waiting on approval**, (2) a turn /
workflow / peer run **reached a terminal state**, and (3) **operator
health degraded** (baseline/doctor freshness, stale non-terminal peer
runs). Today all three are invisible unless the operator is watching the
terminal.

Evidence gathered in the design workflow (`investigate-20260702T062300Z-f22a86`,
local 3-probe fan-out + independent Codex explore peer + Codex
plan-verify peer, all findings source-verified):

**Claude host (docs-verified, code.claude.com/docs/en/hooks.md +
plugins-reference.md + statusline.md):**

- `Notification`, `Stop`, and `SubagentStop` are all **plugin-registrable**
  hook events (a plugin's `hooks/hooks.json` may register them).
- The `Notification` payload carries `notification_type`
  (`permission_prompt`, `idle_prompt`, `auth_success`, elicitation
  variants) and `message`, and supports **matcher filtering on
  `notification_type`** — a sensor can target permission prompts
  precisely. Notification hooks are fire-and-forget (no decision
  control).
- All hook events share the documented **common input fields** —
  `session_id`, `prompt_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name` (plus `agent_id`/`agent_type`
  where an agent is involved; SubagentStop matcher-filters on agent
  type). Stop-**specific** extra input fields are not reliably
  documented (the public schema section is truncated); the sensor
  design below therefore depends only on common fields — `Stop` has
  **no matcher**, fires on every turn end for every plugin, with no
  cross-plugin ordering guarantee.
- The main `statusLine` is **not plugin-bundlable** — it is a user
  `settings.json` key only (plugins may bundle `subagentStatusLine`, not
  `statusLine`). Any future statusline adapter is therefore an M1
  fragment plan, not a bundled component.

**Codex host (source-verified at `codex-cli 0.142.5`, tag
`rust-v0.142.5`):**

- `notify` is a single top-level `Option<Vec<String>>` config key
  (`config_toml.rs:214`); a programmatic write is a **full replace**
  (single-key clobber). The project-local `.codex/config.toml` layer
  **denylists** `notify` (silently stripped, `loader/mod.rs:62-74`), and
  `[profiles.*]` tables reject it — a plan must target the user layer
  `~/.codex/config.toml`.
- The notify payload enum has **exactly one variant**:
  `agent-turn-complete` (`legacy_notify.rs:13-26`; the internal
  `HookEvent` enum has only `AfterAgent`). **`notify=` cannot deliver
  approval-time attention** — it fires only after a turn completes,
  which is precisely when a turn blocked on an approval prompt has *not*
  completed. Payload is one appended argv argument, kebab-case JSON,
  including an undocumented `client` field and a nullable
  `last-assistant-message`.
- `tui.notifications` **does** cover approval prompts: the TUI emits
  `approval-requested` (exec/patch approval + MCP elicitation coalesce to
  it, priority over turn-complete) via OSC 9 / BEL. Default **on**,
  default condition `unfocused`, TUI-only, no external program, no
  payload.
- The Codex lifecycle-hooks `PermissionRequest` event runs when Codex is
  about to ask for approval and **may decline to decide** (the normal
  prompt continues) — the only *programmable* approval-time channel, but
  it is a Codex hook: shipping it means `/hooks` review/trust burden.

**Existing assets to build on (repo-verified):**

- The ADR-0031/0039 sidecar writes a durable projection to
  `.agentic-plugins/state/<persona>/last-session-handoff.json`
  (`workflow_kind/id/path`, `phase`, `next_action`, `archive_gate`,
  `routing_recommendation`, optional `checkpoint`) — written even when
  stderr is discarded. Engineer + orchestrator emit it on terminal
  paths; **founder does not** (no `emitTerminalHandoffSidecar`, no
  `discover-runtime.mjs`; ADR-0039 §7 deferred founder with an
  onboarding recipe).
- `doctor.mjs` already owns persona-generic read primitives
  (`inspectWorkflowNamespace`, `scanPeerRuns`, `inspectConsensusRuns`,
  `inspectCompatRuns`, `inspectRuntimeArtifactInventory`) — but they are
  **private** (not exported), and `inspectWorkflowLedgers`
  (doctor.mjs:2095) deliberately enumerates only engineer+orchestrator
  (test-doctor.mjs:13 records founder ledger health as a doctor
  non-goal).
- The three persona `peer-runner.mjs` copies are semantic siblings
  (copy-not-import per ADR-0010 §5): terminal transitions live in
  `runPeer`'s final `updateHandle` (engineer ~663-683) and in sweep's
  `reconcileOne` (envelope-present / orphaned) + retention prune;
  `TERMINAL_STATUSES = {completed, failed, cancelled, orphaned, pruned}`.
  Orchestrator additionally has a **pre-ledger failure path**
  (peer-runner.mjs:530: companion resolution fails before any handle is
  written).
- The engineer projection header (`session-handoff.mjs:5`) fixes the
  dependency direction: personas compute their own bounded projection and
  pass it INTO the runtime seam; *"runtime never shell-reads engineer
  state"* (inversion-of-control, L3 → L1 per ADR-0010). Doctor's
  read-only diagnostic scanning of persona ledgers is a separate,
  established surface.
- ADR-0035 §4 permanent ceiling (flag-independent): runtime **MUST NOT**
  "run an arbitrary/string command executor, `shell: true`, `sh -c`, or
  user-supplied argv". This directly constrains the notification channel
  model (surfaced by the Codex plan-verify peer; resolved in Decision
  §2).
- `scripts/validate-artifacts.mjs` REQUIRED_IGNORES already covers
  `.agentic-plugins/runs/` and `.agentic-plugins/state/` — notification
  dedupe/ledger state fits under the existing ignore policy.

Placement was evaluated in the design workflow's Phase 1 across the
9-axis registry (new lean L2 owning both features; two new plugins;
full runtime absorption including hooks; the hybrid), with an
independent Codex brainstorm peer converging on the same hybrid. The
user approved: **P4 hybrid**, dashboard content Tier 1+2, single ADR,
and (at the plan gate) the **built-in allowlisted channel model**.

## Decision

Ship operator situational awareness as **two features on one shared
eventing substrate**, placed per the P4 hybrid:

| Component | Owner | Why here |
|---|---|---|
| Notification emitter core + config + dedupe + channels | `plugins/runtime` (stays hook-free) | Operator control plane (ADR-0024); reuses settings/artifact machinery; no new Codex `/hooks` burden on runtime releases |
| `runtime:dashboard` aggregate view | `plugins/runtime` | Sits next to doctor, reuses its read layer |
| Claude hook sensors (`Notification`/`Stop`/`SubagentStop`) | **new tiny hook-only `plugins/attention`** | Hook-bearing surface isolated in a plugin that rarely releases |
| Codex-side attention | native host config via M1 plans (no new Codex hooks at v1) | `notify=` + `tui.notifications` evidence above |
| Peer-run terminal self-sensor | each persona's `peer-runner.mjs` | The transition happens inside persona code; no hook exists there |

### 1. Event schema and cross-surface dedupe contract (first, before any sensor)

A single notification event shape shared by all producers:

```json
{
  "event_id": "<repo-ident>:<kind>:<subject-id>:<status>",
  "source": "attention-claude | peer-runner-<persona> | <future>",
  "kind": "approval | idle | turn-complete | subagent-complete | workflow-terminal | peer-run-terminal | health",
  "title": "...",
  "body": "...",
  "urgency": "urgent | normal",
  "refs": { "workflow_id": "...", "run_id": "...", "path": "..." }
}
```

- **The dedupe key deliberately excludes `source`** (source is metadata
  for display/filtering only): two producers observing the same subject
  moment must build the **same** `event_id` — repo identity, event kind,
  subject id, status — or dedupe cannot work. The concrete case this
  covers: a peer run's terminal transition is emitted both by `runPeer`'s
  live final `updateHandle` and by a later sweep `reconcileOne` pass
  (§5) — same kind (`peer-run-terminal`), same subject (`run_id`), same
  status ⇒ one notification. The repo-identity component keeps two
  repos' identical run ids from colliding.
- **Kind/subject mapping is part of this contract** (not sensor
  discretion): `Notification/permission_prompt` → `approval`, subject =
  `session:<session_id>:<content-hash>` where `<content-hash>` is a
  short hash of the notification `message` text — **two different
  approval prompts in one session must NOT dedupe against each other**
  (a session-only subject plus the TTL window would silently drop the
  second prompt, defeating the core approval-attention goal); only a
  re-fire of the *same* prompt dedupes. `Notification/idle_prompt` →
  `idle`, subject = `session:<session_id>` (one idle nudge per session
  per TTL is the desired behavior, so no content hash);
  `Stop` with an active terminal workflow (fresh projection, §3) →
  `workflow-terminal`, subject = `workflow_id`; `Stop` otherwise (the
  bare case — Stop fires on every turn end) → `turn-complete`, subject
  = `session:<session_id>:<prompt_id>` (both are **documented common
  input fields** present on every hook event, so the bare case never
  lacks a subject and no Stop-specific payload field is relied on);
  `SubagentStop` → `subagent-complete`, subject = `agent_id`; peer-run
  self-sensors (§5) → `peer-run-terminal`, subject = `run_id`. `health`
  is reserved for future producers (see Consequences — v1 has no
  push-side health producer).
- Dedupe is TTL-windowed and **atomic**: a claim file created with an
  exclusive primitive (`O_EXCL`/`mkdir`) under
  `.agentic-plugins/state/runtime/notify/` (covered by the existing
  artifact ignore policy). Concurrent producers race safely; the loser
  exits silently.
- The schema + dedupe contract is the **first implementation slice**;
  every sensor depends on it (retrofit is unsafe).

### 2. Runtime notification emitter core (`plugins/runtime/scripts/notify.mjs`)

- `notify.mjs emit` consumes an event JSON (stdin or `--event-file`) and
  is the **only** component that touches channels. It consumes **only
  the payload it is handed** — the emitter never reads persona state
  itself, preserving the `session-handoff.mjs:5` inversion-of-control
  contract (sensors read their own domain and pass bounded fields in).
- Pipeline: validate → dedupe claim (§1) → quiet-hours gate → redact →
  channel dispatch. Every failure path is **fail-closed silent**: exit 0
  always, nothing on stdout ever (stdout is load-bearing on completion
  paths per ADR-0039), at most one stderr diagnostic line.
- **Channels are a built-in allowlist** (user-approved at the plan gate;
  resolves the ADR-0035 §4 conflict the plan-verify peer surfaced):
  - `none` — default; unconfigured = no-op (conservative default),
  - `macos-osascript` — fixed argv template only: a **fixed `-e`
    AppleScript program that reads `on run argv`**, with all payload
    text passed as **trailing argv items** — payload never appears
    inside the AppleScript source (escaping into the `-e` expression
    would still be code interpolation, the classic osascript trap; the
    redaction rule "payload text is data, never command/format
    material" applies to the AppleScript layer too),
  - `file-log` — NDJSON append under
    `.agentic-plugins/state/runtime/notify/log.ndjson` (bounded
    rotation), which doubles as the dashboard's notification-history
    source.

  A **user-supplied argv channel is explicitly deferred**: adopting it
  requires a **future ADR that amends ADR-0035 §4 head-on and decides
  by effect whether agentic-plugins may ship it at all** (the ADR-0038
  §6 shape — the outcome may be "forbid"); the conditions sketched here
  (config-key-sourced argv, no shell, sanitized env, fire-and-forget
  only) are **candidate hard-conditions for that ADR, not a
  pre-negotiated boundary**. Non-macOS desktop channels (`notify-send`,
  Windows toast) land either as further fixed-argv allowlist entries
  (no amendment needed) or with that future ADR.

  > **Update ([ADR-0041](0041-cross-machine-notification-egress.md), 2026-07-06):**
  > the "future ADR that amends ADR-0035 §4 head-on and decides by effect" has
  > landed — but for a **different effect domain** than the local desktop channel
  > above. ADR-0041 decides **network egress** (a `notify.mjs` channel POSTing
  > enumerated metadata to a fixed SaaS host) and **accepts** it as the bounded
  > tier **E1** (§4 amended head-on). The **local user-supplied-argv desktop
  > channel** described here is a *separate* effect and remains deferred under this
  > paragraph; ADR-0041 sets the effect-not-ownership precedent (per ADR-0038 §6)
  > it will be measured against. One E1 channel now serves **both** hosts (Claude
  > attention sensors + the Codex `notify=` shuttle).
- Spawn contract (macos-osascript): no shell, `stdio: 'ignore'`,
  `detached` + `unref()`, sanitized minimal env, fire-and-forget — a
  missing/slow/failing binary never blocks or fails the calling hook.
- **ADR-0035 tier classification and enforcement.** ADR-0035 §2
  explicitly reserves the extension path this ADR exercises: *"A new
  mutation domain … is forbidden until a **new** ADR adds a
  specifically scoped executor for it."* ADR-0040 is that new ADR for
  the notification-emit domain — the **§4 ceiling is untouched**, and
  the §3 invariants are **narrowly amended for this one surface**
  (stated explicitly below, not waived silently):
  - The emitter is an **M1 surface with one bounded extension**: writes
    stay inside agentic-plugins-owned state
    (`.agentic-plugins/state/runtime/notify/`), plus **fixed-argv
    notification dispatch** — spawning a repo-owned, fixed argv
    template (`macos-osascript`) with payload only as argument values.
    This is a non-companion external-process execution that no ADR-0035
    tier previously enumerated; this ADR authorizes exactly this
    fixed-template shape and nothing broader (the §4 ceiling on
    arbitrary/user-supplied argv is untouched).
  - **Retention authorization**: TTL-expired dedupe claim files and
    `log.ndjson` rotation are routine deletions of runtime-owned notify
    state, authorized by this ADR (the ADR-0035 §4 no-delete bullet's
    exemption model — a deliberate, ADR-gated owned-state maintenance,
    like the migration exemption).
  - **§3 invariant amendment, scoped to the notification-emit
    executor only** (every other executor remains bound by §3 as
    written): invariant 1 (dry-run default + explicit action-specific
    *flag*) is amended to **explicit action-specific *config key***
    — `notify_channel = "none"` is the shipped default, so the
    hook-auto-invoked emitter mutates nothing until the operator
    opts in by setting a channel; a flag is the wrong shape for a
    surface invoked by hooks rather than by the operator's hand.
    Invariant 5 (finite timeout) is amended for the
    detached+`unref()` fire-and-forget child (an unref'd child cannot
    be awaited or killed) — accepted because the allowlisted binaries
    are local, prompt-returning, and their failure is inconsequential
    by design. Invariant 8 (semantic failure classification +
    surfaced recovery) is amended to fail-closed silent on the emit
    path — recovery guidance surfaces on the pull side instead
    (dashboard Tier 2 / `file-log`), never on the load-bearing
    completion path.
  - When ADR-0035's planned allowlist registry / AST guard over
    child-process primitives lands, the notification dispatch registers
    its fixed templates there.
- Quiet hours: `HH:MM-HH:MM` local-time window with explicit timezone
  key, cross-midnight supported; `urgency: "urgent"` (approval events)
  **bypasses quiet hours by default** (configurable off) — suppressing
  approval prompts is the one thing quiet hours must not silently do.
- Redaction: field allowlist **plus** content hardening — length caps
  per field, control-character stripping, and injection-safe rendering
  (payload text is data, never command/format material). `next_action`/
  `checkpoint`/hook `message` fields can contain arbitrary user text.
- Config: new flat keys in `.agentic-plugins/config.toml` via the
  existing parser — requires extending `CONFIG_KEYS` (settings.mjs:32;
  the parser silently drops unknown keys at settings.mjs:364) **and
  generalizing the settings plan/apply pipeline** beyond its current
  model/effort shape (the largest settings-side lift; its own slice):

  ```
  notify_channel                    = "none" | "macos-osascript" | "file-log"
  notify_quiet_hours                = "22:00-08:00"      # optional
  notify_quiet_hours_tz             = "Asia/Seoul"       # optional, default local
  notify_dedupe_ttl_seconds         = "300"
  notify_urgent_bypass_quiet_hours  = "true" | "false"   # default true
  notify_kinds                      = "approval,peer-run-terminal,..."  # optional filter
  ```

### 3. `plugins/attention` — tiny hook-only Claude sensor plugin

- **Layer and shape**: attention is a **Layer 1 framework primitive**
  (ADR-0010 §1) with a new admissible plugin shape — **hook-only** —
  formalized here the way ADR-0008 §(a) formalized the script-only
  library shape for `plugins/companions` (whose qualifier explicitly
  excludes hook-bearing plugins, so attention is its sibling exception,
  not an instance of it). It ships hooks + sensor scripts only: no
  skills, no verbs, no state machinery. It is deliberately **not** an
  L2/L3 plugin (ADR-0010 §2 requires those to expose the six verb
  skills). kit-lint / plugin-shape tests gain a hook-only category for
  it (already reflected in Consequences).
- **ADR-0010 §6 plugin-boundary evaluation** (the repo records this
  explicitly in both directions — ADR-0037 spawned via Trigger 2;
  Stage 2 Deliverable B absorbed discovery into companions at 0/3
  triggers): attention fires **Trigger 2 — distinct operational/trust
  profile**. A Codex-discoverable hook-bearing surface carries the Codex
  `/hooks` review/trust burden on every release of whatever plugin hosts it and
  auto-executes on host lifecycle events; isolating it in a minimal,
  rarely-releasing plugin is the point of the P4 hybrid (absorbing the
  sensors into runtime or a persona would attach that burden to
  frequently-releasing packages — Alternatives P3). Cohesion with
  runtime is preserved through the subprocess seam (§2), not
  co-location.
- The Claude hook registration (since the 2026-07-11 amendment a
  `.claude-plugin/plugin.json`-declared `adapters/claude/hooks/hooks.json`;
  originally the root `hooks/hooks.json`) registers:
  - `Notification` with a `notification_type` matcher —
    `permission_prompt` (urgent) and `idle_prompt` (normal) at v1,
  - `Stop` (workflow/turn terminal; no matcher exists),
  - `SubagentStop` (normal; `agent_type` matcher available for tuning).
- Each sensor resolves the runtime root via a **copied
  `discover-runtime.mjs`** (ADR-0039 §5 ladder: env override → Claude
  cache SemVer-max → Codex fixed cache → sibling monorepo;
  `MIN_RUNTIME_VERSION` set to the first runtime version shipping
  `notify.mjs`; missing/too-old ⇒ silent no-op, no stale fallback) and
  shells out to `notify.mjs emit`.
- Sensors are **self-contained observers**: Claude fires all plugins'
  Stop hooks without ordering guarantees, so the sensor never assumes a
  persona Stop hook ran first. State enrichment reads
  `last-session-handoff.json` **with a freshness check** (workflow-id
  consistency + mtime bound + the `.footer-rendered` marker); a stale or
  missing projection degrades to a bare notification (host payload
  fields only), never a wrong one. Founder consequently gets bare Stop
  notifications (it writes no sidecar today) — its richer coverage comes
  from §5.
- All sensors: exit 0 always, nothing on stdout, no Stop `decision`
  output (pure observation, never blocks stopping).
- **No Codex hook surface in attention at v1** — the Codex `/hooks`
  review/trust burden is avoided until §4's deferred path is triggered.
  *(Corrected mechanism, Amendment 2026-07-11: non-declaration alone does
  NOT achieve this on current Codex — its default-file discovery loads a
  root `hooks/hooks.json` regardless of command shape. The invariant is
  therefore two-part: no `.codex-plugin/plugin.json` `hooks` key AND no
  root default file; the Claude registration lives at the
  manifest-declared adapters path instead.)*

### 4. Codex channel — M1 fragment plans (evidence-refined)

`runtime:settings --notification-plan` emits, per the ADR-0038 M1
precedent (fragment render + settings artifact; **never** a host-config
write):

- **(a) turn-complete** → a `notify=` fragment for the **user layer
  `~/.codex/config.toml` only** (the project layer strips the key;
  profile tables reject it). The plan **must read-check** any existing
  `notify` value first: the key is a full-replace single key, so when a
  user notifier already exists the plan offers a **wrapper-chaining
  script** (invoke prior notifier + ours) — this wrapper path is an
  acceptance criterion of the implementation, not an optional note.
  **Receiver constraint** (a future implementer hits this immediately):
  the fragment's command **must not point into a version-pinned plugin
  cache path** — Claude's cache is per-version, so a pinned path goes
  stale on every runtime upgrade, and unlike the §3 sensors a static
  config value has no re-discovery opportunity. The plan therefore
  ships a **thin receiver shuttle script** alongside the fragment
  (installed by the user at a stable home location, e.g.
  `~/.agentic-plugins/bin/`), which internally re-resolves the current
  runtime root per the §3 discovery ladder and delegates to
  `notify.mjs emit`; the fragment invokes the shuttle via
  `/usr/bin/env node` (a Node-on-PATH requirement the plan states
  explicitly, consistent with doctor's existing bare-`node` hook
  portability diagnostics). Receiver input contract: payload arrives as
  the last argv argument, kebab-case JSON, `client` field tolerated,
  `last-assistant-message` nullable.
- **(b) approval-requested** → a `tui.notifications` fragment
  (`notifications = ["approval-requested", "agent-turn-complete"]`),
  with limitations documented in the plan text: TUI-only (not
  `codex exec`), default-`unfocused` condition, OSC 9/BEL delivery is
  terminal-emulator-dependent, no external program, no payload.
- **(c) `PermissionRequest` lifecycle hook — deferred.** It is the only
  programmable approval-time channel (decision-optional: a hook that
  returns no decision leaves the normal prompt intact), but shipping it
  means attention gains a Codex-manifest-declared (or default-discovered)
  hook surface and every attention release re-enters `/hooks`
  review/trust. Adoption trigger: real-world evidence that
  `tui.notifications` is insufficient for approval attention (e.g., the
  operator works primarily unfocused-terminal-out-of-sight or via
  `codex exec`).

### 5. Peer-run terminal self-sensor (in each persona's `peer-runner.mjs`)

- Authored **once**, applied to all three persona copies as
  copy-not-import (ADR-0010 §5). The copies are semantic siblings, not
  byte-identical files — each application is a per-persona patch with
  its own test, not a blind file copy.
- Emit points — **all terminal transitions, not just the final
  `updateHandle` block**: `runPeer`'s final `updateHandle` (live
  terminal transition); **each copy's missing-companion early return**
  (engineer peer-runner.mjs:566-573 and founder ~:545 write a `failed`
  handle and return *before* the final block — a literal
  final-block-only implementation would miss every `peer_cli_not_found`
  notification); **orchestrator's pre-ledger failure path**
  (peer-runner.mjs:530 — companion missing, `failed` returned with no
  handle written at all; the self-sensor emits directly from that early
  return); and sweep `reconcileOne`'s envelope-present and orphaned
  transitions. **`pruned` transitions are skipped** (retention cleanup
  of runs whose terminal state was already notified; a prune-time
  notification has no attention value and the payload is being
  deleted).
- Events flow to the runtime emitter through the same copied
  `discover-runtime.mjs` + `notify.mjs emit` path with `event_id` per §1
  (persona + repo + run_id + status), fail-closed silent.
- Founder is included from day one — its peer-runner is a full sibling,
  which partially compensates founder's missing sidecar (§3).

### 6. `runtime:dashboard` (`plugins/runtime/scripts/dashboard.mjs`)

- **Prerequisite slice**: extract doctor's private readers
  (`inspectWorkflowNamespace`, `scanPeerRuns`, `inspectConsensusRuns`,
  `inspectCompatRuns`, `inspectRuntimeArtifactInventory`) into a
  runtime-internal shared lib (runtime-internal import is allowed; the
  ADR-0010 §5 ban is cross-plugin). Doctor behavior is unchanged.
- **Tier 1 — agentic state**: active workflows for **all three
  personas** (dashboard calls the persona-generic
  `inspectWorkflowNamespace` with `plugin:'founder'` directly, leaving
  doctor's `{engineer, orchestrator}` `inspectWorkflowLedgers` contract
  and test-doctor.mjs:13's deliberate non-goal untouched), peer runs
  with stale/non-terminal emphasis, orchestrator macro subtask progress,
  consensus run states.
- **Tier 2 — operator health**: doctor/compat/baseline freshness,
  settings + Codex hook-attestation recency, artifact-inventory
  attention items, and the `file-log` channel's recent notifications
  (§2) when configured. (Notify state lives under
  `.agentic-plugins/state/runtime/notify/`, not `runs/`, so doctor's
  `runs/`-scanning artifact inventory needs no new family registration;
  the dashboard reads the notify log as its own direct source.)
- Output: text snapshot (default) + `--format json`; `--watch` re-renders
  from **filesystem reads only** (never re-probes host CLIs — that is
  doctor's job), bounded poll interval (default 2s, floor 1s), explicit
  exit. R0 read-only per the doctor precedent (ADR-0035).
- **Tier 3 (host-generic widgets) and Tier 4 (Claude statusline adapter)
  stay deferred.** Evidence recorded: `statusLine` is not
  plugin-bundlable, so a future Tier 4 is an M1 settings-fragment plan
  (the user pastes the statusLine command into their own
  `settings.json`), mirroring §4's shape.

### 7. Boundaries and invariants

- **ADR-0035 §4 unchanged.** The built-in channel allowlist keeps every
  spawned argv fixed and repo-owned; the custom-argv channel is deferred
  behind a narrow future amendment (§2).
- **R0/M1 only**: no host-config writes anywhere (Codex plans are
  fragments + artifacts); the emitter mutates only
  agentic-plugins-owned state under `.agentic-plugins/state/runtime/notify/`.
- **Fail-closed silent everywhere**: sensors and emitter exit 0 always,
  never write stdout, degrade to no-op on any failure (missing runtime,
  malformed payload, dead channel binary) — a notification failure must
  never break a workflow, commit, or hook.
- **Observers, not actors**: no Stop `decision` output, no host-session
  mutation, no unbounded loops (`--watch` has an explicit exit and a
  bounded interval).

## Consequences

**Positive**:

- Approval-waiting and terminal transitions become **push-visible**
  (Claude natively; Codex once the operator applies the §4 M1 plans,
  within `tui.notifications`' documented limits); **health degradation
  stays pull-side** but collapses from "re-run doctor + read ledgers"
  to one `runtime:dashboard` Tier 2 view (`kind: health` is reserved in
  §1 for a future push producer). The dashboard covers founder, whose
  workflow/peer-run ledgers no runtime workflow-ledger reader covers
  today (doctor's plugin *inventory* already recognizes founder;
  `inspectWorkflowLedgers` does not).
- Runtime stays hook-free — **this ADR's own placement decision**
  (ADR-0030 / 0035 §6 supply the context on Codex hook
  enablement/trust mechanics, not the decision): the Codex `/hooks`
  re-attestation burden is **zero at v1** — achieved by **path
  isolation**, not by mere non-declaration (Amendment 2026-07-11: current
  Codex default-file discovery loads a root `hooks/hooks.json` regardless
  of manifests, so attention's Claude registration is manifest-scoped
  under `adapters/claude/`) — and, when §4c triggers, confined to the
  rarely-releasing attention plugin instead of every runtime release.
- The `file-log` channel + dashboard Tier 2 close the loop: notification
  history is itself operator-visible state.
- The event schema/dedupe contract (§1) is reusable by any future
  producer (consensus rounds, compat drift alerts) without re-design.

**Negative**:

- A new package: `plugins/attention` must be registered in
  `release-please-config.json` + `.release-please-manifest.json`, both
  marketplace catalogs, both host manifests, README/CHANGELOG,
  plugin-shape tests (new hook-only category, §3), and kit lint — plus
  ADR-0016 commit-splitting discipline for every cross-package change.
  Ship-time doc updates: the AGENTS.md repo tree, the
  `docs/ARCHITECTURE.md` layer table, and the `plugins/README.md`
  shipped-plugins rows. Conventionally-named test files are picked up
  automatically by `npm test`/full-tests (ADR-0033); only scoped
  filters like `test:plugin-shape` need explicit inclusion.
- The settings plan/apply pipeline must be generalized beyond its
  model/effort shape before notification config lands (the largest
  single lift outside the emitter itself).
- v1 desktop coverage is macOS-only (`macos-osascript`); Linux/Windows
  desktop channels arrive either as further fixed-argv allowlist entries
  or with the deferred custom-argv amendment.
- Implementation has hard ordering: schema/dedupe → settings
  generalization → emitter (runtime release fixes
  `MIN_RUNTIME_VERSION`) → reader extraction → attention / self-sensors
  / dashboard.

**Neutral**:

- Implementation ships later as an `orchestrator:plan` multi-slice macro
  (sketch: ① event schema + emitter core, ② settings keys +
  plan-pipeline generalization, ③ doctor reader extraction,
  ④ dashboard, ⑤ attention plugin, ⑥ peer-run self-sensor ×3,
  ⑦ `--notification-plan`, ⑧ cross-host acceptance).
- `context.mjs` `VALID_WORKFLOW_KINDS` stays `{engineer, orchestrator}`:
  founder's dashboard visibility comes from direct namespace scanning,
  not from onboarding founder into the projection seam (that remains
  ADR-0039 §7's separate recipe).
- Notification payloads reuse projection/footer fields **by reference**
  (reading the sidecar file in sensors); the projection schema itself is
  not extended (runtime rejects unknown projection keys,
  context.mjs:901).

## Alternatives Considered

- **P1 — one new lean L2 plugin owning notifications + dashboard**:
  rejected. It would duplicate runtime's config parsing, artifact
  conventions, and ledger readers, and put a second operator surface
  next to doctor — fragmenting the ADR-0024 control plane.
- **P2 — two new plugins (notification, dashboard)**: rejected; the same
  duplication twice plus double package overhead, for components that
  share one eventing substrate.
- **P3 — runtime absorbs everything including hooks**: rejected. A
  hook-bearing runtime would enter Codex `/hooks` review/trust for
  every **Codex-hook-bearing** release — at v1 (Claude hooks only) the
  cost is optionality (per the 2026-07-11 amendment, "Claude hooks only"
  avoids the Codex burden only via path isolation, not by mere
  non-declaration), but the moment §4c triggers, a
  frequently-releasing runtime would carry the re-attestation burden on
  every release; isolating the hook surface in attention buys that
  §4c-future cheaply. (Runtime shipping no hooks today is status quo;
  keeping it hook-free is this ADR's decision — see Consequences.)
- **P5 — adopt the Codex `PermissionRequest` hook now**: rejected for
  v1 (the `/hooks` burden lands immediately for one event); recorded as
  the deferred programmable approval channel with an explicit adoption
  trigger (Decision §4c).
- **User-supplied argv notification channel at v1**: rejected — it is
  verbatim inside ADR-0035 §4's flag-independent "MUST NOT" (arbitrary /
  user-supplied argv execution). Deferred behind a narrow amendment
  (Decision §2), keeping the testable ceiling intact.
- **Claude statusline adapter at v1 (Tier 4)**: rejected — `statusLine`
  is not plugin-bundlable (user settings only), so the deliverable would
  be an M1 fragment plan for a cosmetic surface while the CLI dashboard
  covers the same content cross-host; deferred with the evidence
  recorded.
- **Polling watcher daemon instead of hook sensors** (a background
  process tailing ledgers): rejected — agentic-plugins ships no
  daemons/services; hooks + in-process self-sensors cover the same
  moments with zero resident footprint, and `--watch` remains an
  explicit, bounded foreground mode.

## Amendment (2026-07-11): §3 packaging mechanism corrected — relocation out of Codex default discovery

Host truth disproved the §3 packaging **mechanism** (not the decision):
"no Codex hooks by non-declaration" assumed Codex only reads hooks a
`.codex-plugin/plugin.json` declares. Observed on codex-cli 0.144.1
(recorded in `plugins/runtime/docs/codex-capability-baseline.md`
§ hooks.state observations): Codex **default-file discovery is
command-shape-blind** — it loaded attention's root `hooks/hooks.json`
despite the absent manifest key and the all-Claude-adapter commands,
surfaced `stop`/`subagent_stop` in `/hooks`, and recorded the operator's
trust. The burden §3 meant to avoid was therefore being paid anyway, for
hooks with no assured Codex execution semantics, and `runtime:doctor`
(PR #543) honestly gated `lifecycle_hook_continuity` at `partial`
(`command-warnings=attention`, experience parity 95%).

Correction (owner decision 2026-07-11, of the three tracked options —
declare in the Codex manifest / portable wrappers + Codex-payload-aware
sensors / restructure): **restructure by relocation**.

- `plugins/attention/hooks/hooks.json` moved to
  `plugins/attention/adapters/claude/hooks/hooks.json` (content
  unchanged; commands stay `${CLAUDE_PLUGIN_ROOT}`-rooted), declared via
  the Claude manifest `hooks` key — the documented plugin-manifest
  component-path mechanism.
- The corrected invariant is **two-part**: no `.codex-plugin/plugin.json`
  `hooks` key **and** no root default `hooks/hooks.json`. Zero Codex
  burden is achieved by **path isolation**, not non-declaration.
- The §4 event-ownership decision **stands unchanged**: Codex-side
  attention remains the native `notify=` / `tui.notifications` M1
  fragment plans, and §4(c) stays deferred behind its adoption trigger.
  (The rejected alternative — adopting the sibling
  `adapters/codex/hooks/` pattern with real Codex sensors — would have
  duplicated §4(a)'s turn-complete ownership: the shuttle's
  `codex-turn:<id>` subjects and the Stop sensor's
  `session:<sid>:<pid>` subjects cannot dedupe against each other, and
  it would fire §4(c)'s door without its trigger evidence.)
- Runtime never mutates the operator's stale pre-relocation
  `[hooks.state]` trust rows; retained rows are displayed as
  display-only `unexpected_agentic_entries` (whether the host retains or
  prunes them across upgrades is unobserved — either outcome is host
  behavior to record, not runtime's to perform).
- Residual host-evolution risk is accepted and pinned: if a future Codex
  broadens discovery (e.g., reads Claude-manifest component paths), the
  absence regression tests pin their host premise
  (`codex-cli 0.144.1`, `status=ready`) and the compat baseline-drift
  process re-opens this posture rather than silently re-laundering it.
- Effective-surface note: doctor's source→installed-cache fallback keeps
  the pre-relocation cache surface visible (honestly) until the released
  attention version is installed; the parity-100% claim belongs to the
  post-release install proof, not the source relocation.
