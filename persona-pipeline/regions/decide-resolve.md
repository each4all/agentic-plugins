Parse the arguments into flags + body and resolve the preset from
`core/skills/decide/references/decision-axes.yml`. The block prints the
resulting `ResolvedDecisionContext` JSON on stdout, and the skill body reads
it from that output. Nothing is written to disk: the context stays in the
session for the duration of the command (ADR-0027 §4.3), and no later Bash
call has to find a file whose path lived only in an earlier call's shell.

The CLI reuses `scripts/lib/decide-args.mjs` internally so the same flag
grammar applies: unknown flags, invalid `--size=<tier>` values, or
malformed `--weights=<spec>` (non-numeric/negative/exponent weight,
uppercase or duplicate axis-id, empty spec, whitespace) produce a parser
error and exit 2 (we halt). `--preset=<id>` is passed through by the parser
(not shape-validated there) and semantically resolved by the registry per
ADR-0027 §1.6 graceful-degradation — an unknown preset id triggers
`context.registry_fallback = true` + fall-back to the
`{{fallback_preset}}` preset with a diagnostic (no halt), while an empty one
counts as no `--preset` at all. The body — everything after the flags, byte
for byte — is threaded into `context.body`.

The arguments above reach the resolver through an args file, never
through the shell (ADR-0059): typed text spliced into a command line is cut
at `;`, expanded at `$(…)` and redirected at `>`, and the damage can exit
zero. Before the block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The resolver reads
leading `--key=value` flags and takes the rest, byte for byte, as the
decision body — a lone `--` ends the flags, and nothing in the body is
quoted, expanded or split. The command removes the args file and its
directory once it has read them.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# stdout: the ResolvedDecisionContext JSON. stderr: the resolver's warnings
# and diagnostics, shown as they are written.
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --args-file "$ARGS_DIR/args.json"
RESOLVE_RC=$?

if [ "$RESOLVE_RC" -eq 2 ]; then
  echo "✗ decide-registry rejected the argument list — fix the invocation and rerun." >&2
  exit 1
elif [ "$RESOLVE_RC" -ne 0 ]; then
  echo "✗ decide-registry failed with exit $RESOLVE_RC; see diagnostics above." >&2
  exit 1
fi
```
