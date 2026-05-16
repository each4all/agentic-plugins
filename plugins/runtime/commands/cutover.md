---
description: Read-only omcc cutover readiness audit for ADR-0012 and scorecard evidence
argument-hint: "[--format text|json] [--max-artifact-age-hours <n>] [--footer-state <state>] [--omcc-dev-active yes|no|unknown]"
---

# Runtime - Cutover Audit

$ARGUMENTS

Build a read-only cutover readiness report. This command does not declare final
cutover. It can only report `cutover-ready-candidate`; ADR-0007 still requires
an explicit user declaration before omcc is archived or removed.

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
- explicit footer state evidence when supplied;
- explicit omcc-dev daily-workflow evidence when supplied.

Limits:

- No host config, auth, plugin, git, artifact, or workflow mutation.
- Unknown omcc-dev usage or missing footer evidence blocks readiness.
- This report is evidence aggregation, not the final cutover decision.
