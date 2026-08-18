---
name: compat
description: "Runtime compatibility snapshot and release-note gap planner for Claude Code / Codex CLI drift. Use when the user wants to remember host versions, compare them to the runtime baseline, ingest explicit release notes, or plan compatibility updates without mutating host config."
---

# Compat (runtime framework primitive)

`runtime:compat` records host-version truth for Claude Code and Codex CLI under ADR-0026, attaches explicit release-note artifacts, requires changed host/version coverage from content-backed release notes, and creates compatibility update plans. It is artifact-first and does not install, update, authenticate, or mutate host settings.

## When invoked by command (`/runtime:compat` or `$runtime:compat`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/compat.mjs" --repo-root "$REPO_ROOT" snapshot [--format text|json] [--timeout-ms <n>]
node "<runtime-plugin-root>/scripts/compat.mjs" --repo-root "$REPO_ROOT" check (--run-id <id>|--latest) [--format text|json]
node "<runtime-plugin-root>/scripts/compat.mjs" --repo-root "$REPO_ROOT" ingest-release-notes (--run-id <id>|--latest) --release-notes-file <path>
node "<runtime-plugin-root>/scripts/compat.mjs" --repo-root "$REPO_ROOT" ingest-release-notes (--run-id <id>|--latest) --release-notes-url <url> [--fetch-release-notes-url] [--timeout-ms <n>]
node "<runtime-plugin-root>/scripts/compat.mjs" --repo-root "$REPO_ROOT" plan (--run-id <id>|--latest) [--format text|json]
```

3. Present the returned artifact pointers and next steps.
   - Treat `release_notes_required` as a blocker for detailed compatibility planning.
   - Treat a missing changed-host/version coverage row as still requiring release
     notes, even when another content-backed note was stored.
   - Readiness keys on **assurance**, not on exact version equality (ADR-0053
     §Decision 4). Drift is still recorded as evidence — a non-exact host stays
     visibly `drifted` in `drift_class` — but the readiness status is:
     - `current` — no drift, and a human grant covers this host pair.
     - `assured` — drift is present, and a human grant covers this pair anyway.
       No action; the drift stays visible.
     - `unassured` — no grant names this pair. Assurance is granted by review,
       never by a version match, an upgrade, or elapsed time (§Decision 5), so
       the only resolution is a release that carries a grant.
     - `assurance_blocked` — integrity: the packaged record, the plugin set, the
       host probe, or the recorded verdict could not be read. Surface the stored
       `next_steps` line; it names the specific repair.
     - `legacy_unassured` — the run predates the assurance record. It can never
       be re-checked into coverage; take a **fresh** snapshot.
   - Never describe `runtime:compat` as granting assurance. It evaluates
     membership in a human-authored grant and cannot create or widen one.
   - Do not fetch URLs unless `--fetch-release-notes-url` is explicitly present.
   - Do not mutate Claude/Codex config, auth, sandbox, approvals, or plugin installs from this surface.

## Scope

Compat reports:

- local `claude --version` and `codex --version` observations;
- selected help-surface hashes and byte counts, not raw help bodies;
- remembered host-parity baseline versions from runtime docs;
- release-please plugin versions from the current repo;
- release-note artifact pointers;
- the governing ADR-0026 policy block;
- host-version drift classification;
- affected compatibility surfaces inferred from release-note content;
- the ADR-0047 §5 standing notification watch — seeded rows for Codex
  `notify=` payload variants beyond `agent-turn-complete` and the Claude
  `agent_needs_input`/`agent_completed` notification types, emitted on every
  `plan` run (drift or not) with release-note signal annotations;
- a non-mutating compatibility update plan.

## Boundaries

- No host CLI install, update, or authentication.
- No host-native config writes.
- No plugin install/update execution.
- No automatic URL fetch; URL content fetch requires `--fetch-release-notes-url`.
- No raw command help output in the main session.
- No claim that a plan proves parity; it only identifies update work.
- A notification-watch signal never wires a mapping: a hit is a planning row
  only, and a newly observed variant needs a source-verified payload plus its
  own follow-up decision (ADR-0047 §5, ADR-0030) before any shuttle or sensor
  change.

## Examples

```bash
$runtime:compat snapshot
$runtime:compat check --latest
$runtime:compat ingest-release-notes --latest --release-notes-file /tmp/codex-release-notes.md
$runtime:compat ingest-release-notes --latest --release-notes-url https://example.com/codex-release-notes --fetch-release-notes-url
$runtime:compat plan --latest
```
