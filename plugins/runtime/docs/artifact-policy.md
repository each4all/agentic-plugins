# Runtime Artifact Policy

`plugins/runtime` owns new runtime/operator configuration and artifacts under
`.agentic-plugins`, but not every path under that directory has the same git
policy.

## Trackable

- `.agentic-plugins/config.toml` may be committed when a repo intentionally
  wants shared runtime defaults such as model/effort preferences.
- Source docs, scripts, manifests, and tests remain in their normal tracked
  locations under `plugins/`, `scripts/`, `tests/`, `.github/`, and the
  marketplace catalog directories.

## Ignored

The following paths are generated local byproducts and must stay ignored:

- `.agentic-plugins/runs/` — runtime context, consensus, doctor, and future
  run artifacts.
- `.agentic-plugins/state/` — workflow files, archives, peer-run ledgers,
  locks, and migration manifests.
- `.agentic-plugins/tmp/` — temporary operator process byproducts.
- `.agentic-plugins/cache/` — repo-local runtime caches.
- `.agentic-plugins/*.local.toml` — local runtime config overrides.
- `.claude/` — Claude host state and legacy engineer/orchestrator workflow
  storage.
- `.codex/` — Codex host state.
- `output/` — legacy plugin test output.

This policy makes `.agentic-plugins/state/` safe as an ignored generated
state home for canonical workflow writers and the explicit ADR-0025 migration
manifest. Existing `.claude/agentic-*` workflow storage remains a legacy
compatibility home until the operator runs `runtime:migrate workflow-storage
--apply`.

## Validation

Run:

```sh
npm run validate:artifacts
```

The validator checks both `.gitignore` policy and `git check-ignore` behavior.
It also fails if generated artifact paths are already tracked in git. The
marketplace validation workflow runs the same check in CI.
