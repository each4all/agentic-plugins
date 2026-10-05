# Region-engine fixture (ADR-0066 Decision 4)

A miniature repository the persona-pipeline tests copy to a temporary directory
and run `scripts/sync-persona-pipeline.mjs --root <copy>` against. Two personas,
`alpha` (capability `dispatch_target` on) and `beta` (all off), one generated
script, one generated JSON file (alpha only), and an authored runbook,
`plugins/<persona>/commands/run.md`, holding two generated regions and one
extension point. The region bodies in the committed runbooks are deliberately
stale: the tests regenerate them. Nothing here is loaded by a plugin.
