1. Determine the ensemble point type (see *Ensemble Point Types* below).
2. Resolve the peer companion via the companion-cache discovery
   (`AGENTIC_COMPANIONS_ROOT` env override honored, per ADR-0008). If
   discovery fails, the ensemble degrades to local-only.
3. Construct the peer prompt per the type-specific template (see *Prompt
   Construction Rules*). Write it with your file-writing tool, not the
   shell, as `prompt.xml` in a private text directory that
   `state.mjs tmpdir-make --kind text` makes and marks, as the runbook's
   dispatch step does (ADR-0059 Decision 9), and pass that file
   via `--prompt-file <path>` per `companions/contract.md` §2.2 — never as
   a positional argument and never inlined into a shell command, so the
   prompt never crosses shell parsing, process argv, or `ps aux` (ADR-0059,
   amendment of 2026-10-10).
4. Invoke the companion in **JSON envelope mode** through
   `../../../../scripts/peer-runner.mjs run`, which records the matching
   `pending_ensemble` row and writes raw stdout/stderr plus the parsed
   envelope under the hidden peer-run ledger. The orchestrator SHOULD
   background the call (Bash `run_in_background` on Claude; the `task`
   subcommand on Codex) so its own analysis proceeds in parallel. The
   runner runs in the foreground of that background task, never behind a
   shell `&`, which would detach it where the host can neither track it
   nor notify you when it exits. For a review type, write beside the prompt
   what you put in the reviewer's subject, `subject.json`
   (`{"shown": [...], "covered": [...]}`, repository-relative paths; `covered`
   are those shown at the content the working tree holds now), and pass it with
   `--subject-file`: a review with no subject vouches for nothing (ADR-0069).
   The directory's last reader releases it once its write succeeded
   (ADR-0059 Decision 10): a command's finalize (its `DISPATCH_TEXT_DIR`), a
   skill's own settle block (critique's and refine's), or, inside a `start`
   lifecycle, the attempt release block that runs after each attempt's
   settle; a step that stops keeps it for its rerun. Where none of those
   runs, release it with this block once the synthesis has read the run's
   result, the response and `prompt.xml.err` included (the run ledger keeps
   the response, at the result's `stdout_path`), a run launched or not: a
   skill invoked on its own, and, on Codex outside a `start` lifecycle, a
   verb skill with no settle block of its own (decide, frame, investigate's
   profiles), whether a workflow is active or not. Fill `<plugin-root>` with
   this plugin's installed root, the path you read this reference from, cut
   before its `/core/skills/` directory:

   ```bash
   DISPATCH_TEXT_DIR='<the directory holding prompt.xml, which no finalize, settle or start release block takes>'
   case "$DISPATCH_TEXT_DIR" in
     ''|'<'*) echo "✗ DISPATCH_TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
   esac
   # ADR-0059 Decision 10, item 1 — the synthesis has read the run's result:
   # no block, rerun or continuation reads the directory again.
   RELEASE_PATH="$DISPATCH_TEXT_DIR"
   {{> tmpdir-release-skill}}
   ```

   The peer, claude or codex, never works in the checkout: the runner
   gives it a snapshot of HEAD plus the working tree and the index
   (untracked files included, ignored files such as `node_modules` left
   out) in a temporary worktree, and removes the snapshot when the run
   ends, so you may keep editing while it runs. Its HEAD is detached at
   the branch's commit, so name files repo-relatively and a review base by
   its commit id, never by a branch it would read as of the snapshot. The
   runner rewrites the checkout's absolute paths in the prompt to the
   snapshot's (C96; ADR-0023, amendment of 2026-10-13; a claude peer since
   C163 D2b, implementation note of 2026-11-05).
5. The orchestrator proceeds immediately to its own parallel analysis.
