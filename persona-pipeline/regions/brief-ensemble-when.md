Activates inside the {{brief_profile}} profile's command-invoked mode (Step
1 end through Step 3 entry) when invoked as:

- Claude: `/{{persona}}:investigate --profile={{brief_profile}} <topic>` (slash command)
- Codex: `${{persona}}:investigate {{brief_profile}} <topic>` (skill mention; per
  ADR-0021 cognitive-runbook parity, full slash-command parity is
  deferred to ADR-0013 reserved)

Does NOT apply to: auto-activated {{brief_profile}} outside command-invoked
mode; inline cross-references from other {{persona}} skills (`frame`,
`decide`, `compose`, `refine`, `critique`); binary confirmations or
progress updates within the same session.
