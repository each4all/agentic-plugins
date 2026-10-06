Activates automatically at every command-defined phase boundary in
`/{{persona}}:*` commands. Each command file specifies which phase invokes
which ensemble point type (see *Ensemble Point Types* below).

- Claude: `/{{persona}}:<verb> …` (slash command)
- Codex: `${{persona}}:<verb> …` (skill mention; per ADR-0021
  cognitive-runbook parity, full slash-command parity is deferred to
  ADR-0013 reserved)

Does NOT apply to:
- Skills auto-activated outside any `/{{persona}}:*` command (auto-activated
  mode runs without ensemble dispatch — the lightweight in-context path).
- The three meta skills (`checkpoint` / `resume` / `peer-now`). `peer-now`
  dispatches the companion, but as a **side-channel**, not an ensemble —
  see *State Bookkeeping* below.
- Binary confirmations or progress updates within the same session.
- Internal orchestration decisions.
