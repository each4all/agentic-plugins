# Region-engine fixture (ADR-0066 Decision 4)

A miniature repository the persona-pipeline tests copy to a temporary directory
and run `scripts/sync-persona-pipeline.mjs --root <copy>` against. Two personas,
`alpha` (capability `dispatch_target` on) and `beta` (all off), one generated
script, one generated JSON file (alpha only), and an authored runbook,
`plugins/<persona>/commands/run.md`, holding two generated regions and one
extension slot (both personas own it, between `intro` and `finalize`, exactly
one marker). alpha declares format 1.2 with `peer.images: false`, so it is
enrolled in the `no-image` variant region; beta stays 1.0 without `peer`, outside
the variant rule. The region bodies in the committed runbooks are deliberately
stale: the tests regenerate them. Nothing here is loaded by a plugin.
