// scripts/lib/exit-after-flush.mjs — the repository's own tools exit through
// the persona pipeline's canonical exitAfterFlush (the owner's discussion-2
// decision R2, docket C93), not through a copy of their own. The helper's
// behaviour is tested once, in tests/persona-pipeline/test-exit-after-flush.mjs;
// this shows each binding the tools import is the canonical source's own, so
// that test covers it.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import * as tools from '../../scripts/lib/exit-after-flush.mjs';
import * as source from '../../persona-pipeline/files/scripts/lib/cli-entry.mjs';

describe('scripts/lib/exit-after-flush.mjs', () => {
  for (const name of ['absorbOutputErrors', 'exitAfterFlush', 'FLUSH_FALLBACK_MS']) {
    it(`re-exports the canonical ${name}`, () => {
      ok(name in source, `the canonical source exports ${name}`);
      strictEqual(tools[name], source[name]);
    });
  }
});
