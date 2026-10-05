Inspect the argument string (the full text after `/{{persona}}:resume` on
Claude, or after `${{persona}}:resume` on Codex):

- **Empty** → *resume mode* (default). Continue with Phase 1.
- **Starts with `archive` (case-insensitive)** → *archive mode*. Continue
  with Phase 3.
- **Anything else** → reject with a one-line usage hint and stop. `resume`
  accepts only the empty form or `archive [<id>]`.
