After a document deliverable's full critique and a recorded refine, the
critique's `critique-scope` prints `mode: scoped`, and the re-check reviews
what the refine changed and the findings it targeted, not the whole document
again (C120; ADR-0063, amendment of 2026-10-14). Anything the ledger cannot
vouch for prints `mode: full` (a profile other than the default, `mode:
partial`), and the point type's own template applies.

- **Scoped review** (critique phase, `mode: scoped`):

  ```xml
  <task>
  Re-check a revised document. A full review found the findings below; a
  refine then changed the passages below to resolve the targeted ones. Judge
  each targeted finding, and review the changed passages for problems the
  change introduced. Do not review the rest of the document again.

  <scope>
  Passages (path, lines now, text now, text before):
  {passages from critique-scope}

  Targeted findings (id, severity, location, text):
  {targets with their ledger entries}

  Other open findings (id, severity, location, text):
  {open findings from critique-scope}
  </scope>
  </task>

  <structured_output_contract>
  One line per finding:
  - <id or NEW> | <resolved|unresolved, for an id> | <CRITICAL|MAJOR|MINOR|SUGGESTION> | <path:start-end> | <in|outside> | <evidence and description>
  Give every targeted id exactly one verdict, with the evidence for it. A
  problem you notice outside the passages is still reported, marked outside.
  </structured_output_contract>

  <grounding_rules>
  Every finding names its path and lines in the current text. Label
  inferences explicitly.
  </grounding_rules>
  ```

- **Scoped refine-verify** (refine phase, when `refine-record` printed
  `verify.mode: scoped`):

  ```xml
  <task>
  Verify a refine of a document. It targeted the findings below and applied
  the patch below. Judge whether each targeted finding is resolved, and
  whether the patch regressed the passages it touched.

  <scope>
  Targeted findings (id, severity, location, text):
  {targets with their ledger entries}

  Patch (working-tree diff of the refine):
  {orchestrator-collected patch}
  </scope>
  </task>

  <structured_output_contract>
  The same line format as the Scoped review: every targeted id with one
  verdict and its evidence; a new problem as NEW, in or outside the patched
  passages.
  </structured_output_contract>
  ```

- **Synthesis**: as the point type's, by ledger id. A target with no verdict,
  two verdicts or contradictory ones counts unresolved. The synthesized
  findings, with their ids, verdicts and scope, are what the critique's
  `critique-close` records; the convergence rule is the script's (`converged`,
  `carry`, `left_open`), never a judgment of the synthesis.
