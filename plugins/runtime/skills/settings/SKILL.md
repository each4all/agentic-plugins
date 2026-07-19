---
name: settings
description: "Dry-run runtime settings planner for agentic-plugins. Use when the user wants to inspect marketplace/plugin/CLI readiness, plan repo-local or user-global model/effort defaults, plan ADR-0040 notify_* notification keys, plan the ADR-0044 session_capture opt-in (--session-capture off|stop-hook), plan the ADR-0045 user-scope-only entry-brief keys (--entry-brief off|startup / --entry-brief-empty silent|report: repo target structurally refused, resolution env > user-global > shipped default, tracked repo values reported as ignored) and read the session_readiness section (observed-current half-enabled capture-chain diagnosis per session-capture-contract.md §13, evaluated in both report scopes), render the ADR-0038 cross-host permission plan (--permission-plan, bounded by --permission-plan-max-files / --permission-plan-max-file-bytes: safety-graded Claude + Codex fragments, artifact-only, never a host-config write), render the ADR-0040 §4 Codex notification-channel fragment plan (--notification-plan: notify=/tui.notifications fragments + receiver shuttle, artifact-only), render the ADR-0041 §12 egress launcher plan (--egress-launcher-plan: read-only activation-state + ~/.claude prototype scan → state-aware per-machine activation runbook, artifact-only; never writes host config, config.local.toml, the credential, or ~/.claude/settings.json), run a probe-free local plan (--skip-host-cli-probes: no runDoctor / host-CLI subprocess probes; filesystem-only model/effort resolution; discriminated report_scope=local_plan report per docs/settings-report-contract.md; rejects the execute/attest flags and their modifiers while --apply and the plan flags stay allowed), explicitly execute allowlisted plugin install/update commands, explicitly clean up retired agentic-plugins Claude plugins, check Codex plugin-hook readiness, or record a Codex /hooks review attestation. Mutates only agentic-plugins-owned config when --apply is explicit; runs plugin management only when --execute-plugin-management is explicit; runs retired plugin cleanup only when --execute-plugin-cleanup is explicit; records hook-review attestation only when --attest-codex-hook-review is explicit. Never writes Codex host config: the former --apply-codex-plugin-hooks plugin_hooks write was removed per ADR-0035 §6 (hook enablement is manual)."
---

# Settings (runtime framework primitive)

`runtime:settings` is the ADR-0024 operator settings surface. It plans host/plugin setup and agentic-plugins config changes. Dry-run is the default.

## When invoked by command (`/runtime:settings` or `$runtime:settings`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/settings.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--notify-channel none|macos-osascript|file-log] [--notify-quiet-hours HH:MM-HH:MM] [--notify-quiet-hours-tz <iana-tz>] [--notify-dedupe-ttl-seconds <n>] [--notify-urgent-bypass-quiet-hours true|false] [--notify-kinds <csv>] [--session-capture off|stop-hook] [--entry-brief off|startup] [--entry-brief-empty silent|report] [--permission-plan] [--permission-plan-max-files <n>] [--permission-plan-max-file-bytes <n>] [--notification-plan] [--egress-launcher-plan] [--skip-host-cli-probes] [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--expected-plan-hash <sha256>] [--execute-plugin-cleanup] [--plugin-management-host all|claude|codex] [--run-id <settings-run-id>]
```

3. Present the result as a settings plan, not as proof of host parity.
   - Dry-run output is the default and must be safe to run repeatedly.
   - `--permission-plan` is the ADR-0038 M1 **cross-host** permission plan — the
     first of the three plan flags. It reads the **same usage-record evidence
     model** as `runtime:doctor --permission-diagnosis` (which observed tool calls
     are prompt-shaped, by host x mechanism); settings re-enumerates and re-learns
     the records itself — plan builders never read doctor's output. From that
     evidence it recommends a **safety-graded** configuration for **both** hosts:
     a `.claude/settings.json` `allow` / `deny` / `ask` + `permissions.defaultMode`
     fragment (cross-referenced against the existing config — **the operator's
     standing rules outrank an observation**: a pattern already governed by an
     equal-or-**stricter** rule is never re-recommended, so the plan never emits a
     rule *weaker* than one already set; where the advisor is **stricter** than the
     existing rule — a dangerous pattern sitting in `allow` — it surfaces the
     conflict **and** still recommends the corrective rule) and a Codex
     `config.toml` `approval_policy` / `sandbox_mode` + bounded project-trust
     fragment (path resolved via `$CODEX_HOME`, defaulting to `~/.codex`). It never
     recommends `bypassPermissions`, `danger-full-access`, or approval policy
     `never` (isolated-environment notes only). Both host configs are read
     **read-only**; the plan is written solely to a sanitized,
     agentic-plugins-owned advisory artifact under
     `.agentic-plugins/runs/permission/` for the operator to apply — **runtime
     never writes host config, even with `--apply`**. Output sanitizes to ADR-0038
     §5: generalized command patterns and counts only, never verbatim arguments,
     secrets, or transcript source paths. `--permission-plan-max-files <n>` and
     `--permission-plan-max-file-bytes <n>` bound how many usage records are
     **selected per host**; directory traversal carries its own separate budget.
     One caveat before applying a fragment: generalization collapses distinct
     commands into a single wildcard, so a recommended `allow` pattern can be
     **broader** than the one safe command that produced it. Review it.
   - `--skip-host-cli-probes` is the probe-free local plan (contract:
     `docs/settings-report-contract.md`): no `runDoctor`, no host-CLI
     subprocess probes — model/effort and companion directions resolve from
     the filesystem-only peer-execution context, snapshotted before any
     `--apply` write. Evidence collection is orthogonal to mutation:
     `--apply` and the three plan flags stay allowed; the execute/attest
     flags and their exclusive modifiers (`--plugin-management-host`,
     `--plugin-management-timeout-ms`, `--run-id`) are rejected before any
     probe, config write, or artifact write. The report is discriminated
     (`report_scope=local_plan`, `host_cli_probes.status=skipped`,
     `section_presence` map, `null` probe-derived sections, qualified
     `local plan: pass|warning` text) so a narrowed report never reads as a
     clean full pass, and no `.agentic-plugins/runs/settings/` execution
     artifact is ever written in this mode.
   - `--apply` may write only `.agentic-plugins/config.toml` in the repo and/or user home.
   - `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands. It preflights the relevant host plugin command surface first, uses Claude's non-slash `claude plugin install/update` CLI when available, blocks unavailable CLI surfaces before execution, does not use a shell, does not print raw stdout/stderr, writes sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`, and treats host "plugin surface unavailable" output as failed even when the host exits 0.
   - `--execute-plugin-cleanup` runs only `claude plugin uninstall <plugin>@agentic-plugins` commands generated from `runtime:doctor` retired/unknown `agentic-plugins` findings. It blocks unavailable Claude plugin surfaces, does not use a shell, does not print raw stdout/stderr, writes sanitized execution artifacts, and does not authorize general plugin uninstall.
   - Codex bundled plugin hooks are reported read-only: packaged hook plugins, the `plugin_hooks`/generic `hooks` status, `~/.codex/config.toml` `[hooks.state]` enabled/disabled state for expected bundled hooks, the stage-appropriate gate (generic `[features].hooks`, default on, on current Codex; a manual `[features].plugin_hooks` edit on legacy Codex < ~0.134), and the `/hooks` manual follow-up when active-session review/trust cannot be verified. Settings never writes Codex host config — the former `--apply-codex-plugin-hooks` write was removed per ADR-0035 §6. After the operator reviews/trusts hooks in Codex with `/hooks`, `--attest-codex-hook-review` records a sanitized settings artifact that doctor can use while the hook-bearing plugin set and source versions still match and expected bundled hook state is not explicitly disabled.

## Scope

Settings reports and plans:

- agentic-plugins marketplace registration for every plugin in `doctor.mjs`'s
  `PLUGIN_NAMES` — `attention`, `companions`, `designer`, `engineer`, `founder`,
  `image`, `orchestrator`, and `runtime`. Settings iterates that list; an earlier
  four-name list here undercounted it. `tests/plugin-shape/test-runtime-plugin.mjs`
  now pins this list against `PLUGIN_NAMES` and both marketplace catalogs, so the
  drift cannot silently return.
- Known Claude/Codex plugin install/cache state for those plugins.
- Codex temporary marketplace cache state, reported separately from per-plugin
  install cache evidence.
- `claude` and `codex` CLI availability and versions.
- Non-executable host-CLI install plans when Claude Code or Codex CLI is
  unavailable. Settings reports host-native installation guidance but never
  installs the host CLIs itself.
- Repo-local `.agentic-plugins/config.toml` model/effort defaults.
- User-global `~/.agentic-plugins/config.toml` model/effort defaults.
- Direction-specific companion defaults:
  - `claude_model` / `claude_effort` for Codex -> Claude.
  - `codex_model` / `codex_effort` for Claude -> Codex.
- Effective projected companion defaults after repo-local and user-global
  precedence. Warn when a lower-precedence write would not actually affect
  companion invocation.
- ADR-0040 §2 notification config keys (`notify_channel`,
  `notify_quiet_hours`, `notify_quiet_hours_tz`, `notify_dedupe_ttl_seconds`,
  `notify_urgent_bypass_quiet_hours`, `notify_kinds`) with per-key validation
  (channel enum, `HH:MM-HH:MM` window, IANA timezone, positive-integer TTL,
  `"true"`/`"false"`, and kind names checked against the notify-schema lib's
  kind enum), effective projection over the same repo -> user precedence
  chain with shipped defaults (`notify_channel = "none"` keeps the emitter
  disabled until the operator opts in), and warnings for shadowed requests or
  invalid existing values the notify emitter would fail closed on.
- The ADR-0038 cross-host permission M1 plan behind `--permission-plan`: a
  safety-graded `.claude/settings.json` `allow` / `deny` / `ask` +
  `permissions.defaultMode` fragment (both host configs read **read-only**; a
  pattern the operator already governs in **any** bucket is never recommended
  into a different one; allowed-but-dangerous conflicts are surfaced) and a Codex
  `config.toml` `approval_policy` / `sandbox_mode` + bounded project-trust
  fragment (path resolved via `$CODEX_HOME`, defaulting to `~/.codex`). It uses
  the same usage-record evidence model as `runtime:doctor --permission-diagnosis`
  — settings re-enumerates the records itself and never reads doctor's output. It
  never recommends `bypassPermissions`, `danger-full-access`, or approval policy
  `never`. Rendered only into a sanitized advisory artifact under
  `.agentic-plugins/runs/permission/` for the operator to apply — **runtime never
  writes host config, even with `--apply`** — and sanitized to ADR-0038 §5
  (generalized command patterns and counts only; never verbatim arguments,
  secrets, or transcript source paths). `--permission-plan-max-files` and
  `--permission-plan-max-file-bytes` bound how many records are **selected per
  host**; directory traversal carries its own budget.
- The ADR-0040 §4 Codex notification-channel M1 plan behind
  `--notification-plan`: a `notify=` fragment for the user-layer
  `~/.codex/config.toml` only (resolved via `$CODEX_HOME`; the project layer
  denylists the key, profile tables reject it) and a `tui.notifications`
  approval fragment with its documented limits (TUI-only, default-unfocused,
  OSC 9/BEL terminal-dependent, no external program, no payload). The plan
  read-checks any existing `notify` value first — the key is a single-key
  full replace — and an existing notifier produces a wrapper-chaining plan
  (chain script preserves the prior notifier) instead of a clobber. The
  fragment invokes a rendered receiver shuttle via `/usr/bin/env node`; the
  shuttle re-resolves the runtime root per the discovery ladder on every
  invocation (never a version-pinned plugin cache path) and delegates to
  `notify.mjs emit`. Fragments and receiver scripts are rendered + recorded
  in an `.agentic-plugins/runs/notification/` plan artifact only; host
  config is never written and installing the receiver at
  `~/.agentic-plugins/bin/` is an explicit user action.
- The ADR-0041 §12 first-class egress launcher plan behind
  `--egress-launcher-plan`: a read-only read of the current egress activation
  state (`loadEgressActivation`) plus a read-only scan of the personal
  `~/.claude/settings.json` prototype hooks, computed into a state-aware mode
  (`activate` / `partial` / `prototype-retire-only` / `already-active`) and a
  per-machine activation runbook — the `~/.agentic-plugins/config.local.toml`
  content (channel + chat-id; recommended layout, env-all shown as an
  alternative), the env credential line, the exact prototype hook entries to
  remove, verify, rollback, and the per-machine repeat — recorded in an
  `.agentic-plugins/runs/egress-launcher/` plan artifact only. Host config,
  `~/.agentic-plugins/config.local.toml`, the credential, and
  `~/.claude/settings.json` are never written (ADR-0041 §2c: a launcher that
  wrote activation would be the egress-activation vector §2c closes); the
  credential value is never read (only its presence), a boundary-invariant
  validator refuses to write unless every `boundary.writes_*` flag is false, and
  a `scrubSecrets` pass fail-closes the write on any secret-shaped value. It
  emits no network effect, so it stays below the E1 ceiling; applying the plan is
  an explicit user action.
- Dry-run plugin management plans and, behind `--execute-plugin-management`,
  execution metadata, retry classification, and durable sanitized artifacts for
  allowlisted Claude/Codex plugin install/update commands.
- Dry-run retired/unknown plugin cleanup plans and, behind
  `--execute-plugin-cleanup`, execution metadata, retry classification, and
  durable sanitized artifacts for doctor-detected `agentic-plugins` Claude
  plugin cleanup commands.
- Read-only Codex plugin hook readiness: the stage-appropriate hook gate state
  and manual enablement guidance. Settings never writes Codex host config; the
  former `--apply-codex-plugin-hooks` executor was removed per ADR-0035 §6.
- Manual Codex `/hooks` follow-up when bundled plugin hooks are packaged and
  the stage-appropriate hook gate is enabled but settings cannot verify
  active-session hook review/trust state. Include the review target checklist: plugin version,
  hook file path, events, handler count, hook commands, and portability
  warnings. Include expected bundled hook entries from `~/.codex/config.toml`
  `[hooks.state]` that are explicitly disabled. Treat `/hooks` `Installed`
  counts as packaging evidence only; `Active=0` output, disabled hook state,
  and `Trust: New hook - review required` are not enough to attest. Carry
  doctor warnings for Codex-exposed commands that still point at Claude adapter
  paths or rely on a bare `node` command that may not exist in the hook runner
  PATH. Codex plugin hooks also expose
  `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as compatibility aliases, though
  `PLUGIN_ROOT`/`PLUGIN_DATA` are preferred for new Codex commands.
- Codex `/hooks` operator attestation, behind `--attest-codex-hook-review`,
  recorded only as a settings artifact. This is not host-native proof and does
  not mutate Codex trust state. Attestation is blocked while expected bundled
  hook entries remain explicitly disabled in Codex hook state.

## Apply Boundary

Config apply mode is explicit-only:

```bash
$runtime:settings --model gpt-5.4 --effort high --apply
```

Allowed writes:

- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

Plugin management execution is a separate explicit boundary:

```bash
$runtime:settings --execute-plugin-management --plugin-management-host codex
```

Allowed plugin-management commands:

- Claude plugin install/update commands generated by settings recommendations.
- Codex marketplace add/upgrade commands generated by settings recommendations.

Retired/unknown plugin cleanup execution is a separate explicit boundary:

```bash
$runtime:settings --execute-plugin-cleanup
```

Allowed plugin-cleanup commands:

- Claude plugin uninstall commands for retired/unknown `agentic-plugins`
  entries generated from `runtime:doctor` host-parity findings.

Codex plugin hook enablement is not a settings executor (ADR-0035 §6): the
former `--apply-codex-plugin-hooks` write of `~/.codex/config.toml`
`[features].plugin_hooks = true` was removed. On current Codex, plugin hooks
gate on generic `[features].hooks` (default on); on legacy Codex < ~0.134,
enable `[features].plugin_hooks` manually if needed. Then review/trust hooks
with `/hooks`; when plugin hooks are already ready, settings reports that
`/hooks` step in `Manual Follow-ups`.

Codex hook review attestation is explicit and artifact-only:

```bash
$runtime:settings --attest-codex-hook-review
```

Run it only after the active Codex session has opened `/hooks` and the operator
has reviewed/trusted every listed bundled agentic-plugins hook review target.
It records the current hook-bearing plugin set, source versions, and review
target checklist so `runtime:doctor` can clear the manual follow-up until those
change.

If Codex already has a current temporary marketplace cache but no per-plugin
install cache, report that as manual cache materialization. Codex `0.137.0`
exposes a per-plugin command surface (`codex plugin add` / `list` / `remove`)
beyond the marketplace `add` / `upgrade` / `remove`; it is not full Claude
parity (no `update` / `enable` / `disable` / `details` / `validate` / `prune`).
On this per-plugin surface a not-installed plugin's recommendation is an
**executable** `codex plugin add <plugin>@agentic-plugins` (ADR-0035 §5/§6, H2),
run only behind `--execute-plugin-management`. It is policy-gated at execute time:
a `codex plugin list --available --json` pre-flight requires `installPolicy =
AVAILABLE` and a non-`ON_INSTALL`, non-unknown `authPolicy` (else it is blocked,
not run), and a `codex plugin list --json` post-verify confirms the install (an
exit-0 add that the list does not confirm is `CODEX_INSTALL_NOT_VERIFIED`). The
fixed argv excludes `-c`/`--config`/`--enable`/`--disable`, and it never mutates
Codex trust state (`enabled ≠ trusted`; `/hooks` review stays separate). On older
Codex (`0.130`–`0.136`) the surface is marketplace-only and the recommendation
stays manual.

The executors record only status, exit code, byte counts, timing, and sanitized
error metadata. They omit raw stdout and stderr. A host command that exits 0 can
still be marked failed if its sanitized output indicates the plugin command
surface was unavailable. If the Claude `claude plugin ...` CLI surface is
unavailable before execution, retired Claude plugin cleanup remains unhandled, or
Codex packaged hooks need active-session review/trust, settings emits a manual
follow-up checklist with the host-native `claude plugin ...` or `/hooks`
commands to run from the relevant host session. A failed slash `/plugin` probe
is reported as host asymmetry but does not block execution when the non-slash
Claude plugin CLI is available.
Executed settings runs write
`.agentic-plugins/runs/settings/<run-id>/settings.json` and update
`.agentic-plugins/runs/settings/latest.json`; `runtime:doctor` reads the latest
artifact and reports failed action types plus retryability.

Forbidden writes:

- Host-native Claude Code config.
- Host-native Codex CLI config.
- Authentication state or secrets.
- Sandbox or permission relaxation.
- General plugin uninstall execution outside doctor-detected retired/unknown
  `agentic-plugins` cleanup.

## Out of Scope

- No dynamic peer consensus loop.
- No context hygiene mutation.
- No automatic completion footer mutation. The footer helper is read-only and advisory.
- No deep peer smoke or sandbox permission proof.
- No host-native config apply mode, authentication automation,
  sandbox/permission relaxation, or general plugin uninstall execution.
