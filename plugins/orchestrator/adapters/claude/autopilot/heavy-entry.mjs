// plugins/orchestrator/adapters/claude/autopilot/heavy-entry.mjs
//
// ADR-0068 Decision 6, item 4 — the wrapper (`agentic-autopilot heavy`) as the
// driver starts it for a verification check (verify-run.mjs): the same
// runHeavy, its words, signals and exit status, from an entry that loads the
// wrapper's library alone rather than the autopilot CLI with its driver, so
// each check starts no more code than the wrapper runs.

import { runHeavy } from '../../../scripts/lib/heavy-run.mjs';

runHeavy(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`heavy: ${e?.stack ?? e}\n`);
  process.exitCode = 125;
});
