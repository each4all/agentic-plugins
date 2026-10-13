1. Determine the ensemble point type (see *Ensemble Point Types* below).
2. Resolve the peer companion via the companion-cache discovery
   (`AGENTIC_COMPANIONS_ROOT` env override honored, per ADR-0008). If
   discovery fails, the ensemble degrades to local-only.
3. Construct the peer prompt per the type-specific template (see *Prompt
   Construction Rules*). Write it with your file-writing tool, not the
   shell, as `prompt.xml` in a private directory
   (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`), and pass that file
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
   nor notify you when it exits.

   A codex peer never works in the checkout: the runner gives it a
   snapshot of HEAD plus the working tree and the index (untracked files
   included, ignored files such as `node_modules` left out) in a temporary
   worktree, and removes the snapshot when the run ends, so you may keep
   editing while it runs. Its HEAD is detached at the branch's commit, so
   name files repo-relatively and a review base by its commit id, never by
   a branch it would read as of the snapshot. The runner rewrites the
   checkout's absolute paths in the prompt to the snapshot's (C96;
   ADR-0023, amendment of 2026-10-13).
5. The orchestrator proceeds immediately to its own parallel analysis.
