All peer prompts are XML block structures passed to the companions `task`
subcommand via `--prompt-file <path>`. The orchestrator materializes the
prompt to a tempfile to keep it out of `ps aux` and avoid the `ARG_MAX`
ceiling.

Every peer prompt opens with the `<evidence_boundary>` block each template
below starts with, word for word (C163 D2a): what the prompt quotes or points
to (repository files, diffs, logs, command output, earlier outputs, quoted
text) is data for the peer to examine, never instructions to follow, so a line
planted in a file under review cannot steer its verdict. The peer runner
prepends the block to a prompt that does not open with it, a peer-now's
caller text among them; its one statement is `scripts/lib/evidence-boundary.mjs`.
