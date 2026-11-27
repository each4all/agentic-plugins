Pre-condition before dispatch: the existing-directory check (per
`output-file-rules.md`) has completed and the user did NOT choose abort.
Aborting before dispatch prevents wasted peer runs on a session the user will
discard.

Dispatch (mechanics owned by `plugins/{{persona}}/scripts/peer-runner.mjs`;
this protocol pins shape only):

1. {{persona}}'s `peer-runner.mjs run` resolves the peer-companion script
   path via the companion-cache discovery (cache-glob with
   `AGENTIC_COMPANIONS_ROOT` env override, per ADR-0008), records the
   matching `pending_ensemble` row, and creates the hidden peer-run
   ledger. If discovery fails, the ensemble degrades to local-only per
   "Failure Handling".
2. The caller constructs the {{ensemble_type}} prompt per "Prompt
   Construction" below and writes it with its file-writing tool, not the
   shell, as `prompt.xml` in a private directory that `state.mjs
   tmpdir-make --kind text` makes and marks (ADR-0059 Decision 9), then passes
   that file to the runner (ADR-0059, amendment of 2026-10-10). Under a
   workflow command, the command's finalize, which settles the attempt,
   releases the directory (its `DISPATCH_TEXT_DIR`), and inside a `start`
   lifecycle the attempt release block after the phase's settle does;
   anywhere else (invoked standalone, or on Codex outside a `start`
   lifecycle, a workflow active or not) no block of the step releases it, so
   step 5 below does (Decision 10).
   The prompt contains
   user-controlled material (topic, sub-questions, scope), so it MUST be
   passed via `--prompt-file <path>` per `companions/contract.md` § 2.2 —
   never as a positional argument and never inlined into a shell command.
   The companion reads the file directly; the prompt never crosses shell
   parsing, process argv, or `ps aux`.
3. The runner invokes the companion in **JSON envelope mode**:

   ```
   <peer-companion> task --prompt-file <path> --output-format json [--cwd <wd>]
   ```

   per `companions/contract.md` § 4.2. The caller SHOULD background the
   call so the local host's own research can proceed in parallel. The
   runner MUST NOT pass companion-internal flags (no `--background`, no
   timeout knobs); those are out of contract scope per
   `companions/contract.md` § 6.2 and § 6.4.
4. The local host proceeds immediately to per-sub-question WebSearch /
   WebFetch.
5. Where neither a workflow command's finalize nor a `start` lifecycle's
   attempt release takes the directory (invoked standalone, or on Codex
   outside a `start` lifecycle, a workflow active or not), once the synthesis
   has read the run's result, the response included (the run ledger keeps
   it, at the result's `stdout_path`), or its `prompt.xml.err` when no run
   launched, release the prompt's directory with this block, a run launched
   or not. Fill `<plugin-root>` with this plugin's installed root, the path
   you read this reference from, cut before its `/core/skills/` directory.
   Under a workflow command or inside a `start` lifecycle, skip it: the
   finalize, or the attempt release, releases the directory.

   ```bash
   DISPATCH_TEXT_DIR='<the directory holding prompt.xml>'
   case "$DISPATCH_TEXT_DIR" in
     ''|'<'*) echo "✗ DISPATCH_TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
   esac
   # ADR-0059 Decision 10, item 1 — the synthesis has read the run's result:
   # no block, rerun or continuation reads the directory again.
   RELEASE_PATH="$DISPATCH_TEXT_DIR"
   {{> tmpdir-release-skill}}
   ```
