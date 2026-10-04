---
name: migrate
description: "Explicit ADR-0025 workflow storage migration planner. Use to dry-run or apply migration from legacy .claude/agentic-* workflow homes into .agentic-plugins/state."
---

# Migrate (runtime framework primitive)

One subcommand:

- `runtime:migrate workflow-storage` (the default) — the ADR-0025 operator
  migration surface. Plans or applies the path migration from legacy
  `.claude/agentic-*` homes to `.agentic-plugins/state/<plugin>`.

`runtime:migrate legacy-egress-intents`, the read-only discovery of
pre-upgrade egress intent WALs (ADR-0048 residual (d)), went with the egress
subsystem (ADR-0064 Decision 1). The command refuses that name, exit 1, and
runs nothing; relay the refusal and do not suggest a substitute.

## When invoked by command (`/runtime:migrate` or `$runtime:migrate`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/migrate.mjs" --repo-root "$REPO_ROOT" workflow-storage [--format text|json] [--plugin all|engineer|orchestrator] [--apply]
```

Pass the subcommand and options above through an args file, never on the
command line (ADR-0059): text spliced into a shell line is cut at `;`,
expanded at `$(…)` and redirected at `>`. Create a directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, write `args.json` in it
with your file-editing tool, holding `{"agentic_args": 1, "text": "…"}` with
`text` set to them as a JSON string, and run:

```bash
ARGS_DIR='<directory mktemp printed>'
node "<runtime-plugin-root>/scripts/migrate.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

`text` is read as shell-style words that expand nothing: quote a value that
holds spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$`
expansion, or a word-initial `#` or `~` — unquoted, each is refused with a
message. The command removes the args file and its directory once it has
read them.

`scripts/migrate-workflow-storage.mjs` remains a working direct entry
point for the workflow-storage half.

3. Present the result as an operator migration report.
   - Dry-run is the default and must be safe to run repeatedly.
   - `--plugin all` is for inventory. If multiple namespaces are ready,
     apply one namespace at a time.
   - `--apply` may move only generated local state from `.claude/agentic-*`
     to `.agentic-plugins/state/<plugin>`.
   - Blocked output should be treated as a stop condition; do not manually
     move files around it in the main session.

## Scope

Migration reports:

- which plugin namespaces exist in legacy and canonical homes;
- active workflow counts by branch;
- archive counts;
- peer-run counts and non-terminal peer-run counts;
- lock files that block migration;
- ambiguity when canonical state already exists;
- exact source and destination paths;
- tracked worktree dirtiness as non-blocking operator awareness.

## Apply Boundary

Apply mode is explicit-only:

```bash
$runtime:migrate workflow-storage --plugin engineer --apply
```

Allowed writes:

- rename `.claude/agentic-engineer` to `.agentic-plugins/state/engineer`;
- rename `.claude/agentic-orchestrator` to `.agentic-plugins/state/orchestrator`;
- write `.agentic-plugins/state/migrations/workflow-storage-v1.json`.

Forbidden writes:

- tracked source files;
- host-native Claude Code or Codex CLI config;
- authentication state or secrets;
- sandbox or permission settings;
- workflow schema or peer-run handle rewrites.

## Out of Scope

- No automatic migration during engineer/orchestrator/runtime command execution.
- No workflow schema conversion.
- No peer-run ledger pruning, cancellation, or sweeping.
- No host plugin install/update or authentication mutation.
