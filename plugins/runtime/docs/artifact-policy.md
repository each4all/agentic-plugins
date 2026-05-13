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
- `.agentic-plugins/tmp/` — temporary operator process byproducts.
- `.agentic-plugins/cache/` — repo-local runtime caches.
- `.agentic-plugins/*.local.toml` — local runtime config overrides.
- `.claude/` — Claude host state and current engineer/orchestrator workflow
  storage.
- `.codex/` — Codex host state.
- `output/` — legacy plugin test output.

This policy intentionally does not migrate existing `.claude/agentic-*`
workflow storage. ADR-0024 keeps that compatibility source of truth until a
separate migration ADR changes it.

## Validation

Run:

```sh
npm run validate:artifacts
```

The validator checks both `.gitignore` policy and `git check-ignore` behavior.
It also fails if generated artifact paths are already tracked in git. The
marketplace validation workflow runs the same check in CI.
