---
name: cutover
description: "omcc cutover readiness audit and explicit dogfood evidence recorder. Use when the user wants ADR-0012, scorecard, host parity, installed-version, compat, consensus/context, footer, one-week dogfood, and omcc-dev activity evidence summarized without declaring final cutover."
---

# Cutover Audit (runtime framework primitive)

`runtime:cutover` aggregates cutover evidence without mutating host state.
Audit mode is read-only. `record` mode writes only explicit cutover evidence
artifacts under `.agentic-plugins/runs/cutover/`. It can report
`cutover-ready-candidate`, but final omcc archival/removal requires explicit
user declaration per ADR-0007.

The report should make the strengthened cutover gate visible. When the result is
not ready, preserve the unresolved ADR-0012 condition numbers, unresolved
scorecard rows, and legacy pattern-map gaps in the user-facing output instead
of collapsing them to a generic `partial` status.

## When invoked by command (`/runtime:cutover` or `$runtime:cutover`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--max-artifact-age-hours <n>] [--footer-state <state>] [--omcc-dev-active yes|no|unknown]
```

3. Present the report as readiness evidence only.
   - Do not claim final cutover unless the user explicitly declares it.
   - Treat unknown footer state or omcc-dev activity as not verified.

## When recording daily dogfood evidence

Run only when the operator explicitly wants to record the current cutover
evidence:

```bash
node "<runtime-plugin-root>/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" record --footer-state <state> --omcc-dev-active yes|no|unknown [--dogfood-date YYYY-MM-DD] [--footer-reason "..."] [--omcc-dev-note "..."]
```

This writes a sanitized artifact under `.agentic-plugins/runs/cutover/` and a
`latest.json` pointer. Do not infer `--omcc-dev-active no`; record it only when
the current work really avoided `omcc-dev`.

## Scope

The audit reads:

- `docs/DEVELOPMENT.md` ADR-0012 condition matrix;
- `docs/assurance/omcc-cutover-scorecard.md` requirement statuses;
- `docs/assurance/omcc-legacy-pattern-map.md` D1-D20 disposition statuses;
- `plugins/runtime/docs/host-parity-baseline.md`;
- `.release-please-manifest.json` plus runtime doctor plugin install/cache evidence;
- latest runtime compat, consensus, and context artifacts;
- forward-looking one-week omcc-dev-free dogfood evidence from recorded
  cutover artifacts;
- latest recorded or explicit operator-provided footer and omcc-dev activity evidence.

The dogfood window starts at the first accepted no-omcc-dev evidence record
after the candidate point. Elapsed dates without records are reported as
`missing`; future dates still needed are reported as `remaining`. Do not ask the
operator to backfill dates before the candidate point.

## Boundaries

- No plugin install/update/uninstall.
- Audit mode: no host config, auth, permission, sandbox, hook trust, git,
  artifact, or workflow mutation.
- Record mode: writes only explicit cutover evidence artifacts.
- No automatic final cutover declaration.
- No inference that omcc-dev is inactive without explicit evidence.
