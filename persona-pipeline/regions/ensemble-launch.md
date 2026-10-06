1. Determine the ensemble point type (see *Ensemble Point Types* below).
2. **Pass the privacy gate** (see *Privacy* below) for the topic AND
   everything that will travel in the peer prompt:
   {{privacy_scope}}
   pass an explicit privacy gate before BOTH web search AND peer-host
   dispatch. Genericize before constructing the prompt.
3. Resolve the peer companion via the companion-cache discovery
   (`AGENTIC_COMPANIONS_ROOT` env override honored, per ADR-0008). If
   discovery fails, the ensemble degrades to local-only.
4. Construct the peer prompt per the type-specific template (see *Prompt
   Construction Rules*). Write it to a per-dispatch UTF-8 tempfile and
   pass it via `--prompt-file <path>` per `companions/contract.md` §2.2 —
   never as a positional argument and never inlined into a shell command,
   so the genericized prompt never crosses shell parsing, process argv,
   or `ps aux`.
5. Invoke the companion in **JSON envelope mode** through
   `../../../../scripts/peer-runner.mjs run`, which records the matching
   `pending_ensemble` row and writes raw stdout/stderr plus the parsed
   envelope under the hidden peer-run ledger. The orchestrator SHOULD
   background the call (Bash `run_in_background` on Claude; the `task`
   subcommand on Codex) so its own analysis proceeds in parallel.
6. The orchestrator proceeds immediately to its own parallel analysis.
