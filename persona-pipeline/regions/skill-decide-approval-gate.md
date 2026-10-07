**Wait for the user to choose a direction** — do not proceed without
explicit approval.
{{#capability dispatch_target}}

**Autopilot mode (Claude only, ADR-0063 D4 / R4):** there is no one to
choose, so do not wait. Without a CONFLICT the recommendation is the
direction: record it as the next step with the synthesis's confidence (the
driver continues only on HIGH and halts otherwise). A CONFLICT stops at the
`decide-conflict` owner gate (the command's Phase 2 owner-decision variant).
{{/capability}}
