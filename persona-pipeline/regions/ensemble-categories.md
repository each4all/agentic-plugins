| Category   | Condition                                          | Presentation                                        |
|------------|----------------------------------------------------|-----------------------------------------------------|
| AGREED     | Both orchestrator and peer reached same conclusion | Present with elevated confidence. Label: **[Both]** |
| LOCAL-ONLY | Orchestrator found it, peer did not                | Present normally. Label: **[Local]**                |
| PEER-ONLY  | Peer found it, orchestrator did not                | Present normally. Label: **[Peer]**                 |
| CONFLICT   | Orchestrator and peer disagree                     | Present both with evidence. The owner decides       |

A CONFLICT is the owner's to decide, never the orchestrator's. In decide,
critique and investigate a synthesis verdict of `conflict` ends the verb on
its conflict gate, with a bounded consensus round proposed before the owner
decides (ADR-0067 Decision 8; `entry-routing-contract.md` § Active
Next-Action Proposal); in compose, frame and refine the CONFLICT items are
put to the user as they are.

The four names — `AGREED`, `LOCAL-ONLY`, `PEER-ONLY`, `CONFLICT` — are
the canonical public vocabulary of this protocol. Their semantics are
schema-stable: renaming or removing any of the four is a breaking
change; adding a fifth category is a non-breaking, schema-minor step.

The labels (`[Local]` / `[Peer]` / `[Both]`) are host-agnostic — they
refer to *orchestrator* and *peer*, never specifically to one named host.
This reflects bidirectional symmetry: the same synthesis produced from
either side should be structurally indistinguishable except for
capability differences.
