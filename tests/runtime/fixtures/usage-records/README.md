# Usage-record fixtures (ADR-0038 permission advisor)

Synthetic, sanitized sample usage records for the **usage-learner** (the
ADR-0038 §2 "C engine"). These exercise the cross-host record readers that
extract the commands/tools which triggered permission prompts, generalize
them to patterns, and count "seen N times".

The authoritative format reference these fixtures encode is
[`plugins/runtime/docs/usage-records-source-map.md`](../../../../plugins/runtime/docs/usage-records-source-map.md).
The machine-readable oracle is [`manifest.json`](./manifest.json).

## Privacy

Every record here is **synthetic**. Secret-shaped tokens (`sk-ant-…`,
`ghp_…`, `AKIA…`, credential URLs, `password=…`) are deliberately fake —
they carry an `EXAMPLEONLY` / `EXAMPLE` marker and exist only to prove the
redaction path strips them. No real secret, path, repository content, or
transcript text appears in any fixture (ADR-0038 §5).

## Files

| File | Host | Status | Purpose |
|------|------|--------|---------|
| `claude-session-readable.jsonl` | claude | readable | All four Claude causes + allow/ask/deny grades + a user-rejected command |
| `claude-secret-redaction.jsonl` | claude | readable | Secret-shaped args must never reach a pattern/rule |
| `claude-malformed.jsonl` | claude | malformed | Truncated/non-JSON lines amid valid ones; partial extraction + recovery |
| `codex-session-readable.jsonl` | codex | readable | `codex.approval-requested` + `codex.sandbox-blocked`, argv-array command forms |
| `codex-malformed.jsonl` | codex | malformed | Unparseable line **and** valid line with non-JSON `arguments` |
| `manifest.json` | — | — | Ground-truth oracle (expected pattern/grade/cause per observation) |

## The four-status taxonomy

The loader classifies each **source path** before parsing:

- **readable** — exists, readable, ≥1 parseable record. The `*-readable.jsonl`
  fixtures.
- **missing** — path absent → status `missing`, zero observations, fall back to
  the conservative known-safe baseline (ADR-0038 §2). Represented as a
  *filesystem state*, not a committed file: a test points the loader at a
  non-existent path.
- **permission-denied** — path present but unreadable (`EACCES`, e.g. mode
  `000`) → status `permission-denied`, zero observations, baseline fallback.
  Also a filesystem state: a test `chmod 000`s a copy of a readable fixture
  (mirroring the repo's existing `seedRepo`/`seedHome` tmpdir test style) and
  asserts the loader degrades instead of throwing. Committing a mode-000 file
  is intentionally avoided — git does not preserve it portably and CI checkouts
  would re-read it as readable.
- **malformed** — readable but contains lines that are not valid JSON, or valid
  lines whose embedded tool `arguments` are not valid JSON. The loader skips the
  unparseable units and continues. The `*-malformed.jsonl` fixtures.

`missing` and `permission-denied` are deliberately **not** committed as files
because they are properties of the *path*, not of file *content*. `manifest.json`
lists them under `statuses` so the learner's tests assert all four.

## How a test consumes these

```js
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
for (const fx of manifest.fixtures) {
  // load fx.file, run the learner, assert observations match fx.observations
  // (expected_pattern/expected_grade were computed from the shipped advisor-core)
}
```

The `expected_pattern` / `expected_grade` values are computed from
`plugins/runtime/scripts/lib/permission-sanitize.mjs` (`generalizeCommand`) and
`permission-advisor-core.mjs` (`gradeCommand`) — the shipped grader, not
hand-authored — so the fixtures stay locked to advisor-core behavior.
