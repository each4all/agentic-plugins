# Heavy-work lock fixtures

`harness-a739c10d/` holds the mutation harness as it was before the heavy-work
lock (ADR-0068 Decision 6) took over its lock: `scripts/mutation-harness.mjs`
and the `scripts/lib/session-env.mjs` it imports, byte for byte, at commit
`a739c10d1cd2022a4bb65a3ebbd3974c154f353b`. It stands for every older harness
copy on a branch cut before this release, whose lock code is the same from
`7badfe23bd486a2c43007d02f26496374a729f48` on.

`tests/orchestrator/test-heavy-lock-compat.mjs` runs it against holders and
waiters of this release, and checks the bytes against that commit when the
repository's history is at hand (a mutation copy has none; it still runs the
compatibility tests). Edit nothing here: replace the files from that commit.
