// Tests for lib/repo-root.mjs resolveRepoRoot, moved with the function out of
// test-notify.mjs (ADR-0064 Decision 2, item 1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRepoRoot } from '../../plugins/runtime/scripts/lib/repo-root.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A minimal repo fixture: a .git dir, the walk-up marker.
function makeRepo() {
  const root = makeTempDir('repo-root-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

describe('resolveRepoRoot', () => {
  it('prefers the explicit root over cwd discovery', () => {
    const root = makeRepo();
    const other = makeRepo();
    assert.equal(resolveRepoRoot({ cwd: other, explicit: root }), path.resolve(root));
  });

  it('walks up from cwd to the nearest .git marker', () => {
    const root = makeRepo();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(resolveRepoRoot({ cwd: nested }), fs.realpathSync(root));
  });

  it('returns null when no repo marker exists upward', () => {
    const loose = makeTempDir('repo-root-none-');
    assert.equal(resolveRepoRoot({ cwd: loose }), null);
  });
});
