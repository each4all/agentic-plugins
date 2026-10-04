---
description: Explicit workflow storage migration from legacy .claude/agentic-* homes to .agentic-plugins/state
argument-hint: "[workflow-storage] [--plugin all|engineer|orchestrator] [--apply]"
---

# Runtime - Migrate

$ARGUMENTS

One subcommand, `workflow-storage` (the default): the ADR-0025 migration
planner, dry-run by default and mutating only with `--apply`. The read-only
`legacy-egress-intents` discovery went with the egress subsystem
(ADR-0064 Decision 1); the command refuses that name, exit 1, and runs
nothing.

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

node "$RUNTIME_ROOT/scripts/migrate.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

`--repo-root` is placed **before** `$ARGUMENTS`, so the dispatcher finds
the subcommand by name rather than by position. `scripts/migrate.mjs` is
the entry point; `scripts/migrate-workflow-storage.mjs` remains a working
direct entry point for the workflow-storage half.

## workflow-storage (default)

Apply mode moves only generated local workflow state:

- `<repo>/.claude/agentic-engineer` -> `<repo>/.agentic-plugins/state/engineer`
- `<repo>/.claude/agentic-orchestrator` -> `<repo>/.agentic-plugins/state/orchestrator`

Notes:

- Dry-run reports legacy/canonical namespace presence, workflow branch
  counts, peer-run counts, non-terminal peer runs, lock blockers, and exact
  source/destination paths.
- `--plugin all` is intended for dry-run inventory. If both engineer and
  orchestrator are ready to move, apply one namespace at a time with
  `--plugin engineer --apply` or `--plugin orchestrator --apply`.
- `--apply` refuses to run when locks, malformed workflow state, malformed
  peer-run handles, non-terminal peer runs, or existing canonical state would
  make the move ambiguous.
- Tracked worktree dirtiness is reported for operator awareness but is not a
  blocker; this command only moves gitignored generated state and writes the
  ignored migration manifest.
- The command does not rewrite workflow schemas, peer-run handle schemas,
  host-native config, authentication, secrets, sandbox, or permission settings.
