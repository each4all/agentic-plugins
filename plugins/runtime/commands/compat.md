---
description: Runtime host-version compatibility snapshot, release-note gap analysis, and update planning
argument-hint: "snapshot|check|ingest-release-notes|plan [--format text|json] [--run-id <id>|--latest] [--release-notes-file <path>] [--release-notes-url <url>] [--fetch-release-notes-url] [--timeout-ms <n>]"
---

# Runtime - Compat

$ARGUMENTS

Record Claude Code and Codex CLI version snapshots, compare them to the remembered runtime host-parity baseline, attach explicit release-note artifacts, require content-backed notes to cover changed host/version pairs, and plan compatibility updates. This command does not fetch release-note URLs by default, install host CLIs, mutate host config, or update plugins.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/compat.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Examples:

```bash
/runtime:compat snapshot
/runtime:compat check --latest
/runtime:compat ingest-release-notes --latest --release-notes-file /tmp/claude-code-release-notes.md
/runtime:compat ingest-release-notes --latest --release-notes-url https://example.com/release-notes --fetch-release-notes-url
/runtime:compat plan --latest
```

Notes:

- Snapshot artifacts live under `.agentic-plugins/runs/compat/<run-id>/`.
- Main-session output is limited to metadata, hashes, gaps, pointers, and update-plan summaries.
- `--release-notes-url` records a URL pointer only by default; add
  `--fetch-release-notes-url` to explicitly fetch and store URL content for
  content-backed planning.
- Changed host versions require release-note content that mentions both the
  changed host and observed version. A note for the wrong host or version stays
  a stored artifact but does not clear the gap.
- Use this before claiming host parity after Claude Code or Codex CLI changes.
