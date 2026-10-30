// plugins/orchestrator/adapters/claude/autopilot/verify-ops.mjs
//
// ADR-0068 Decision 5, items 4 and 5 (verify-exec) — the two reads a
// verification step makes of a lane besides the persona's record: its tree
// digest (Decision 2's, lib/lane-digest.mjs) and the checks the driver adds
// (verify-select.mjs). A serial run calls them in its own process; a run with
// lanes runs them off its loop (offloop.mjs's verifyTree and verifySelect),
// so the supervision of the workers in flight never waits on them. The step
// itself (verify-run.mjs) takes them as `ops`.

import { treeDigest } from '../../../scripts/lib/lane-digest.mjs';
import { collectChanges, diskReader, gitReader, selectChecks } from './verify-select.mjs';

export const DEFAULT_OPS = Object.freeze({
  treeDigest: async (lane) => treeDigest(lane).digest,
  select: async ({ lane, base, requested, declaration }) => selectChecks({
    tree: diskReader(lane), base: gitReader({ cwd: lane, commit: base }), changes: collectChanges({ cwd: lane, base }), requested, declaration,
  }),
});
