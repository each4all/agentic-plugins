Pre-conditions before dispatch:

1. The privacy gate has passed for the topic AND the confirmed
   sub-questions. PRIVACY GATE:
   {{privacy_scope}}
   pass an explicit privacy gate before BOTH web search AND peer-host
   dispatch — see "Privacy" below and `{{brief_profile}}-spec.md` § Privacy
   Gate.
2. The existing-directory check (per `output-file-rules.md`) has
   completed and the user did NOT choose abort. Aborting before dispatch
   prevents wasted peer runs on a session the user will discard.

Dispatch (mechanics owned by `plugins/{{persona}}/scripts/peer-runner.mjs`;
this protocol pins shape only):

3. {{persona}}'s `peer-runner.mjs run` resolves the peer-companion script
   path via the companion-cache discovery (cache-glob with
   `AGENTIC_COMPANIONS_ROOT` env override, per ADR-0008), records the
   matching `pending_ensemble` row, and creates the hidden peer-run
   ledger. If discovery fails, the ensemble degrades to local-only per
   "Failure Handling".
4. The caller constructs the {{ensemble_type}} prompt per "Prompt
   Construction" below and writes it to a per-dispatch temporary file
   (UTF-8), then passes that file to the runner. The prompt contains
   user-controlled, genericized material (topic, sub-questions, scope),
   so it MUST be passed via `--prompt-file <path>` per
   `companions/contract.md` § 2.2 — never as a positional argument and
   never inlined into a shell command. The companion reads the file
   directly; the prompt never crosses shell parsing, process argv, or
   `ps aux`.
5. The runner invokes the companion in **JSON envelope mode**:

   ```
   <peer-companion> task --prompt-file <path> --output-format json [--cwd <wd>]
   ```

   per `companions/contract.md` § 4.2. The caller SHOULD background the
   call so the local host's own research can proceed in parallel. The
   runner MUST NOT pass companion-internal flags (no `--background`, no
   timeout knobs); those are out of contract scope per
   `companions/contract.md` § 6.2 and § 6.4.
6. The local host proceeds immediately to per-sub-question WebSearch /
   WebFetch.
