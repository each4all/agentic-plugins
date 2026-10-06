All peer prompts are XML block structures passed to the companions `task`
subcommand via `--prompt-file <path>`. The orchestrator materializes the
prompt to a tempfile to keep it out of `ps aux` and avoid the `ARG_MAX`
ceiling.
