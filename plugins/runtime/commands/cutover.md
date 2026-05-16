---
description: omcc cutover readiness audit and explicit dogfood evidence recorder
argument-hint: "[record] [--format text|json] [--max-artifact-age-hours <n>] [--footer-state <state>] [--omcc-dev-active yes|no|unknown] [--dogfood-date YYYY-MM-DD]"
---

# Runtime - Cutover

$ARGUMENTS

Build a cutover readiness report or record explicit dogfood evidence. Audit mode
is read-only. `record` mode writes only a cutover evidence artifact under
`.agentic-plugins/runs/cutover/`. This command does not declare final cutover.
It can only report `cutover-ready-candidate`; ADR-0007 still requires an
explicit user declaration before omcc is archived or removed.

The text report starts with the strengthened cutover gate and, when the audit
is not ready, prints the unresolved ADR-0012 condition numbers, unresolved
scorecard rows, and legacy pattern-map gaps so the next work item is visible
without opening the source documents first.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Checks:

- ADR-0012 condition statuses in `docs/DEVELOPMENT.md`;
- omcc replacement scorecard rows in `docs/assurance/omcc-cutover-scorecard.md`;
- legacy omcc-dev pattern-map rows in `docs/assurance/omcc-legacy-pattern-map.md`;
- host parity baseline freshness against current `runtime:doctor` evidence;
- installed/cache plugin versions against `.release-please-manifest.json`;
- latest compat, consensus, and context artifacts;
- one-week omcc-dev-free dogfood evidence from recorded cutover artifacts;
- latest recorded or explicit footer state evidence;
- latest recorded or explicit omcc-dev daily-workflow evidence.

Recording example:

```bash
node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" \
  --repo-root "$REPO_ROOT" \
  record \
  --footer-state next-work-available \
  --footer-reason "release/install loop complete; R4 remains open" \
  --omcc-dev-active no \
  --omcc-dev-note "runtime/git/GitHub workflow used without omcc-dev"
```

Limits:

- Audit mode performs no host config, auth, plugin, git, artifact, or workflow
  mutation.
- Record mode writes only explicit cutover evidence artifacts under
  `.agentic-plugins/runs/cutover/`.
- Unknown omcc-dev usage or missing footer evidence blocks readiness.
- This report is evidence aggregation, not the final cutover decision.
