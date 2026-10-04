---
name: settings
description: "Dry-run settings planner for agentic-plugins config and host readiness. Use when the user wants to inspect marketplace, plugin, and CLI readiness; plan repo-local or user-global model/effort defaults; plan the session_capture opt-in and the user-scope-only entry-brief keys; read the session_readiness and entry_readiness hook-chain diagnoses; run a probe-free filesystem-only local plan; execute allowlisted plugin install/update commands; clean up retired agentic-plugins Claude plugins; check Codex plugin-hook readiness; or record a Codex /hooks review attestation. It mutates agentic-plugins-owned config only when --apply is explicit, and runs plugin management, cleanup, or attestation only under their own explicit flags. It never writes Codex host config — hook enablement is manual per ADR-0035."
---

# Settings (runtime framework primitive)

`runtime:settings` is the ADR-0024 operator settings surface. It plans host/plugin setup and agentic-plugins config changes. Dry-run is the default.

## When invoked by command (`/runtime:settings` or `$runtime:settings`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/settings.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--session-capture off|stop-hook] [--entry-brief off|startup] [--entry-brief-empty silent|report] [--model-effort-fallback host-native] [--unset <key>[,<key>...]] [--skip-host-cli-probes] [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--expected-plan-hash <sha256>] [--execute-plugin-cleanup] [--plugin-management-host all|claude|codex] [--run-id <settings-run-id>]
```

Pass the subcommand and options above through an args file, never on the
command line (ADR-0059): text spliced into a shell line is cut at `;`,
expanded at `$(…)` and redirected at `>`. Create a directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, write `args.json` in it
with your file-editing tool, holding `{"agentic_args": 1, "text": "…"}` with
`text` set to them as a JSON string, and run:

```bash
ARGS_DIR='<directory mktemp printed>'
node "<runtime-plugin-root>/scripts/settings.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

`text` is read as shell-style words that expand nothing: quote a value that
holds spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$`
expansion, or a word-initial `#` or `~` — unquoted, each is refused with a
message. The command removes the args file and its directory once it has
read them.

3. Present the result as a settings plan, not as proof of host parity.
   - Dry-run output is the default and must be safe to run repeatedly.
   - `--skip-host-cli-probes` is the probe-free local plan (contract:
     `docs/settings-report-contract.md`): no `runDoctor`, no host-CLI
     subprocess probes — model/effort and companion directions resolve from
     the filesystem-only peer-execution context, snapshotted before any
     `--apply` write. Evidence collection is orthogonal to mutation:
     `--apply` stays allowed; the execute/attest
     flags and their exclusive modifiers (`--plugin-management-host`,
     `--plugin-management-timeout-ms`, `--run-id`, `--expected-plan-hash`) are rejected before any
     probe, config write, or artifact write. The report is discriminated
     (`report_scope=local_plan`, `host_cli_probes.status=skipped`,
     `section_presence` map, `null` probe-derived sections, qualified
     `local plan: pass|warning` text) so a narrowed report never reads as a
     clean full pass, and no `.agentic-plugins/runs/settings/` execution
     artifact is ever written in this mode.
   - `--apply` may write only `.agentic-plugins/config.toml` in the repo and/or user home.
   - `--execute-plugin-management` runs only allowlisted host-native plugin install/update/add/upgrade commands. It preflights the relevant host plugin command surface first, uses Claude's non-slash `claude plugin install/update` CLI when available, blocks unavailable CLI surfaces before execution, does not use a shell, does not print raw stdout/stderr, writes sanitized execution artifacts under `.agentic-plugins/runs/settings/<run-id>/`, and treats host "plugin surface unavailable" output as failed even when the host exits 0.
   - `--execute-plugin-cleanup` runs only `claude plugin uninstall <plugin>@agentic-plugins` commands generated from `runtime:doctor` retired/unknown `agentic-plugins` findings. It blocks unavailable Claude plugin surfaces, does not use a shell, does not print raw stdout/stderr, writes sanitized execution artifacts, and does not authorize general plugin uninstall.
   - Codex bundled plugin hooks are reported read-only: packaged hook plugins, the `plugin_hooks`/generic `hooks` status, `~/.codex/config.toml` `[hooks.state]` enabled/disabled state for expected bundled hooks, the stage-appropriate gate (generic `[features].hooks`, default on, on current Codex; a manual `[features].plugin_hooks` edit on legacy Codex < ~0.134), and the `/hooks` manual follow-up when active-session review/trust cannot be verified. Settings never writes Codex host config — the former `--apply-codex-plugin-hooks` write was removed per ADR-0035 §6. After the operator reviews/trusts hooks in Codex with `/hooks`, `--attest-codex-hook-review` records a sanitized settings artifact that doctor can use while the Codex CLI version, the hook-bearing plugin set, and the Codex-installed plugin versions still match and expected bundled hook state is not explicitly disabled.

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
- **Runtime never writes host config** — not Claude's, not Codex's, and not
  with `--apply` (which reaches only `.agentic-plugins/config.toml`). The
  plan flags that rendered fragments into agentic-plugins-owned artifacts
  left with the surfaces they planned (ADR-0057, ADR-0064), so settings
  renders no fragment artifacts. Since ADR-0057 removed the permission
  advisor, runtime offers no opinion about host permission configuration at
  all, and ADR-0038 §6's refusal to ship a permission-relaxing Guard Hook is
  carried forward as binding.
- Repo-local `.agentic-plugins/config.toml` model/effort defaults.
- User-global `~/.agentic-plugins/config.toml` model/effort defaults.
- Direction-specific companion defaults:
  - `claude_model` / `claude_effort` for Codex -> Claude.
  - `codex_model` / `codex_effort` for Claude -> Codex.
- Effective projected companion defaults after repo-local and user-global
  precedence. Warn when a lower-precedence write would not actually affect
  companion invocation.
- The ADR-0044 §3 session family (`session_capture`, and the user-scope-only
  `entry_brief` / `entry_brief_empty` of ADR-0045 §7) with per-key validation,
  effective projection over the same repo -> user precedence chain with
  shipped defaults, and warnings for shadowed requests or invalid existing
  values the consuming executor would fail closed on.
- `--unset <key>[,<key>...]` removes a runtime config key from the selected
  layer(s); it is the only way back to an unset posture. It names runtime
  config keys only. ADR-0064 retired the `notify_*` keys with the
  notification emitter: a leftover `notify_*` line is inert (the reader drops
  it), `--unset` refuses to name it and says so, and removing the line is a
  manual edit.
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
It records the Codex CLI version, the current hook-bearing plugin set, the
Codex-installed version of each covered plugin, and the review target checklist
so `runtime:doctor` can clear the manual follow-up until those change. A plugin
counts only once Codex has installed it: Codex loads hooks from the installed
package (ADR-0061 §Decision 4).

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
- No deep peer smoke or permission proof; those are `runtime:doctor`'s.
- No host-native config apply mode, authentication automation,
  sandbox/permission relaxation, or general plugin uninstall execution.
