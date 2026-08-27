---
description: Runtime host-version compatibility snapshot, release-note gap analysis, and update planning
argument-hint: "snapshot|check|ingest-release-notes|plan [--format text|json] [--run-id <id>|--latest] [--release-notes-file <path>] [--release-notes-url <url>] [--fetch-release-notes-url] [--timeout-ms <n>]"
---

# Runtime - Compat

$ARGUMENTS

Record Claude Code and Codex CLI version snapshots under ADR-0026, compare them to the remembered runtime host-parity baseline, attach explicit release-note artifacts, require content-backed notes to cover changed host/version pairs, and plan compatibility updates. This command does not fetch release-note URLs by default, install host CLIs, mutate host config, or update plugins.

Readiness is classified as `current` (no drift), `release_notes_required`, `gap_analysis_ready` (drift, and a plan can be built), `baseline_unusable`, `snapshot_unreadable`, or `host_version_unreadable` (a host printed a version with more than three components or trailing residue, which the comparison cannot carry faithfully), while drift keeps being recorded as evidence in `drift_class`.

⚠ **There is no compatibility-assurance verdict.** ADR-0053 §Decision 4 keyed readiness on a human-granted acceptance of the host pair; [ADR-0056](../../../docs/adr/0056-assurance-matcher-removal.md) removed that layer, and `runtime:compat` reports only facts it can re-derive — exactness, drift, and release-note coverage. Nothing here answers "has a human reviewed this pair".

Artifacts from the earlier eras stay readable and are never re-interpreted. `current` meant "covered **and** drift-free" under `runtime-compat-gap-1.1` and means "drift-free" under `1.2`, so every record carries its `schema_era` and a pre-`1.2` run projects as `legacy_era` — readable history, never a current verdict. The only resolution for one is a fresh snapshot.

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
- Artifact policy is governed by `docs/adr/0026-runtime-compatibility-drift-and-release-notes.md`.
- Main-session output is limited to metadata, hashes, gaps, pointers, and update-plan summaries.
- `--release-notes-url` records a URL pointer only by default; add
  `--fetch-release-notes-url` to explicitly fetch and store URL content for
  content-backed planning.
- Changed host versions require release-note content that mentions both the
  changed host and observed version. A note for the wrong host or version stays
  a stored artifact but does not clear the gap.
- Every `plan` run also emits the ADR-0047 §5 standing notification watch
  (Codex `notify=` payload variants beyond `agent-turn-complete`; Claude
  `agent_needs_input`/`agent_completed` notification types). A release-note
  signal on a watch row adds a required review step but never wires a mapping —
  wiring needs a source-verified payload and its own follow-up decision
  (ADR-0030).
- Use this before claiming host parity after Claude Code or Codex CLI changes.
