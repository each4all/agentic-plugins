---
description: Dry-run runtime settings planner for agentic-plugins config, host/plugin readiness, companion model/effort defaults, ADR-0044 session_capture opt-in planning and session-capture readiness diagnosis, ADR-0045 entry-brief hook-chain readiness diagnosis, read-only Codex plugin-hook readiness, Codex hook-review attestation, explicit plugin-management execution artifacts, and retired plugin cleanup
argument-hint: "[--format text|json] [--target repo|user|both] [--model <id>] [--effort <level>] [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>] [--session-capture off|stop-hook] [--entry-brief off|startup] [--entry-brief-empty silent|report] [--model-effort-fallback host-native] [--unset <key>[,<key>...]] [--skip-host-cli-probes] [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--expected-plan-hash <sha256>] [--execute-plugin-cleanup] [--plugin-management-host all|claude|codex] [--run-id <settings-run-id>]"
---

# Runtime - Settings

$ARGUMENTS

Run the runtime settings planner. It is dry-run by default. Config mutation is allowed only with `--apply`, and apply mode writes only agentic-plugins-owned config files:

- The `receivers` / `receiver_reinstall` sections report what is installed at
  `~/.agentic-plugins/bin` and, when a receiver is a previously released shape,
  offer the re-install as a PLAN — runtime never writes into the install
  directory. A `foreign` or symlinked path is named for manual review instead:
  runtime does not overwrite a file it did not render. The rollback guidance is
  explicit about a consequence of the delegating-shim change (ADR-0048 §2 as
  amended): restoring a backup of a SELF-CONTAINED copy fully reverts behaviour,
  but restoring a backup of a DELEGATING shim does not — its behaviour comes
  from whichever runtime plugin resolves at the time, so a behavioural rollback
  means rolling the runtime back too.
- `<repo>/.agentic-plugins/config.toml`
- `~/.agentic-plugins/config.toml`

The arguments above reach the command through an args file, never through
the shell (ADR-0059): typed text spliced into a command line is cut at `;`,
expanded at `$(…)` and redirected at `>`, and the damage can exit zero.
Before the block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The command reads
the text as shell-style words and expands nothing: quote a value that holds
spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$` expansion,
or a word-initial `#` or `~` to pass it as text — unquoted, each is refused
with a message rather than reinterpreted. The command removes the args file
and its directory once it has read them.

```bash
ARGS_DIR='<directory from step 1>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$RUNTIME_ROOT" ] || RUNTIME_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/runtime -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"

node "$RUNTIME_ROOT/scripts/settings.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

Notes:

- `--model` and `--effort` plan shared runtime defaults.
- `--claude-model`, `--claude-effort`, `--codex-model`, and `--codex-effort` plan direction-specific companion defaults that still flow through `companions/contract.md` `--model` and `--effort`.
- Output includes the projected effective companion model/effort after repo/user config precedence is applied. Settings warns when a lower-precedence target is shadowed by an existing repo-local or direction-specific setting.
- `--session-capture`, `--entry-brief`, and `--entry-brief-empty` plan the ADR-0044 §3 session family in the same config files with per-key validation (a typo is a parse error, never a silent drop); `entry_brief`/`entry_brief_empty` are user-scope-only (ADR-0045 §7), so the repo target refuses them. Output includes a `Session capture` section with the effective projection over repo/user precedence and shipped defaults (`session_capture = "off"` keeps the hook-invoked publisher from writing anything until the operator opts in); settings warns when a requested key is shadowed or when any stored config value — effective or shadowed — is invalid (the consuming executor fail-closes on invalid values). The value differ plans adds/updates only; **`--unset <key>[,<key>...]` is the removal operation** and the only way back to an unset posture — a written key otherwise stays written, and an absent key is a posture of its own (an undeclared `model_effort_fallback`, a repo layer that defers to user-global). `--unset` deletes **every** assignment line for the key (the read parser is last-value-wins, so a surviving duplicate would resurrect it) and reports how many went; a key that is already absent stages nothing rather than a no-op write. A key may be written or removed in one invocation, never both. Removal is deliberately **not** filtered by the ADR-0045 §7 user-scope-only rule that blocks writing `entry_brief`/`entry_brief_empty` repo-side: that rule exists so a tracked repo value cannot *activate* a session-shaping key, and deleting one can only ever deactivate — refusing would leave the very byte the rule prevents sitting in the file with no tool able to remove it. `--unset` names runtime config keys only. ADR-0064 retired the `notify_*` keys with the notification emitter: a leftover `notify_*` line is inert (the reader drops it), `--unset` refuses to name it and says why, and removing the line is a manual edit.
- `--skip-host-cli-probes` runs the probe-free local plan per [`docs/settings-report-contract.md`](../docs/settings-report-contract.md): no `runDoctor`, no host-CLI subprocess probes (model/effort + companion directions resolve from the filesystem-only peer-execution context, snapshotted before any `--apply` write). It is an **evidence-collection** axis orthogonal to the mutation axis — `--apply` stays allowed, while `--execute-plugin-management`, `--execute-plugin-cleanup`, `--attest-codex-hook-review`, `--plugin-management-host`, `--plugin-management-timeout-ms`, `--run-id`, and `--expected-plan-hash` are rejected before any probe, config write, or artifact write. The report carries `report_scope=local_plan`, `host_cli_probes.status=skipped`, and a `section_presence` map; probe-derived sections are `null` (never empty/zero); text output marks skipped sections "not evaluated" and qualifies the overall line as `local plan: pass|warning` — a narrowed report never reads as a clean full pass. This mode never writes a `.agentic-plugins/runs/settings/<run-id>/` execution artifact.
- Missing Claude Code or Codex CLI is reported as a non-executable host-CLI install plan. Settings gives host-native installation guidance but does not install host CLIs.
- `--expected-plan-hash <sha256>` pairs with the executors (§1.6 machine-bootstrap-contract.md drift guard): the executor recomputes the plan, refuses on hash divergence, and re-presents instead of executing a plan the operator never saw. `runtime:bootstrap plan` reads the dry-run `plugin_management.plan_hash` and presents this flag on the executor command it hands the operator.
- Plugin install/update is dry-run unless `--execute-plugin-management` is supplied. Settings preflights the relevant host plugin command surface first. Claude uses the non-slash `claude plugin install/update` CLI when available, while the slash `/plugin` probe is reported only as observed host asymmetry. The executor runs only allowlisted host-native plugin commands as argv arrays, omits raw stdout/stderr, writes sanitized artifacts under `.agentic-plugins/runs/settings/<run-id>/`, and can be scoped with `--plugin-management-host`. A zero exit code is not treated as success when a host reports that its plugin command surface is unavailable.
- Retired/unknown Claude plugin cleanup is dry-run unless `--execute-plugin-cleanup` is supplied. That executor runs only `claude plugin uninstall <plugin>@agentic-plugins` commands generated from `runtime:doctor` retired/unknown `agentic-plugins` findings; it does not expose general plugin uninstall or arbitrary host command execution. Unavailable surfaces, cleanup that still needs manual handling, and Codex packaged hook review/trust gaps produce a manual follow-up checklist for host-native commands.
- Codex temporary marketplace cache is reported separately from the per-plugin install cache. When the marketplace cache is current but the plugin is not installed, on the Codex `0.137.0`+ per-plugin surface settings emits an **executable** `codex plugin add <plugin>@agentic-plugins` recommendation (ADR-0035 §5/§6, H2) run only behind `--execute-plugin-management` — policy-gated at execute time (a `codex plugin list --available --json` pre-flight requires `installPolicy = AVAILABLE` and a non-`ON_INSTALL`/non-unknown `authPolicy`, else it is blocked), post-verified via `codex plugin list --json`, with fixed argv that excludes `-c`/`--config`/`--enable`/`--disable` and no Codex trust-state mutation. On older Codex (`0.130`–`0.136`) the surface stays marketplace-only and the recommendation stays manual.
- **Runtime never writes host config.** Host-native Claude and Codex configuration, authentication, secrets, and sandbox/permission settings are never written by this command, even with `--apply` — `--apply` reaches only `.agentic-plugins/config.toml`. Settings renders no fragment artifacts any more: the plan flags that did left with the surfaces they planned (ADR-0057, ADR-0064). Runtime also offers no opinion about host permission configuration any more: ADR-0057 removed the permission advisor, and ADR-0038 §6's refusal to ship a permission-relaxing Guard Hook is carried forward as binding.
- Settings includes a read-only `Codex Plugin Hooks` report. It reports bundled hook packaging and the stage-appropriate gate: generic `[features].hooks` (default on) on current Codex, or the legacy `[features].plugin_hooks` flag on Codex < ~0.134, which the operator enables manually if needed. Settings never writes Codex host config — the former `--apply-codex-plugin-hooks` write executor was removed per ADR-0035 §6. Hook trust/review remains manual in Codex with `/hooks`, which settings surfaces as a manual follow-up once plugin hooks are packaged and enabled. Settings prints and records a per-plugin review target checklist with hook file path, events, handler count, hook commands, and portability warnings, so the operator can compare it to the active `/hooks` view before attesting. It also reports `~/.codex/config.toml` `[hooks.state]` entries for expected bundled hooks that are explicitly disabled. `/hooks` `Installed` counts are packaging evidence only; `Active=0` output, disabled hook state, and `Trust: New hook - review required` are not enough to record attestation. Settings also carries doctor warnings for Codex-exposed hook commands that still point at Claude adapter paths or rely on a bare `node` command that may not exist in the hook runner PATH; Codex-provided `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` compatibility aliases are tracked separately but are not warnings by themselves. After reviewing/trusting hooks in the active Codex session, `--attest-codex-hook-review` records a sanitized operator attestation artifact that `runtime:doctor` can use to clear that follow-up while the Codex CLI version, the hook-bearing plugin set, and the Codex-installed plugin versions still match; attestation is blocked while expected bundled hook entries remain explicitly disabled.
