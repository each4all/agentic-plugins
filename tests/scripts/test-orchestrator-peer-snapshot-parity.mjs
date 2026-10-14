// C96 — the orchestrator's copies of the peer snapshot libraries.
//
// A plugin may not import another's script (ADR-0010 §5), and the
// persona-pipeline manifest generates only into personas (ADR-0066), so
// plugins/orchestrator/scripts/lib/{peer-snapshot,process-identity}.mjs are
// copies of the persona-pipeline sources: a three-line copy notice, then the
// source byte for byte. One owner-record schema, worktree lock reason and
// reclaim rule must hold across the four plugins, since a reclaim run by any
// of them judges the others' snapshots: a copy that drifts fails here, naming
// the file.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIBS = ['peer-snapshot.mjs', 'process-identity.mjs'];

function notice(name) {
  return [
    '// COPIED from persona-pipeline — do not edit this copy.',
    `// Source: persona-pipeline/files/scripts/lib/${name}, byte for byte below these`,
    '// three lines; tests/scripts/test-orchestrator-peer-snapshot-parity.mjs checks it.',
    '',
  ].join('\n');
}

describe('orchestrator peer snapshot libraries are the persona-pipeline sources (C96)', () => {
  for (const name of LIBS) {
    it(`plugins/orchestrator/scripts/lib/${name} is its notice, then the source byte for byte`, () => {
      const source = readFileSync(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib', name));
      const copy = readFileSync(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib', name));
      const head = Buffer.from(notice(name), 'utf8');
      ok(copy.subarray(0, head.length).equals(head), `plugins/orchestrator/scripts/lib/${name}: the copy notice is missing or changed`);
      ok(
        copy.subarray(head.length).equals(source),
        `plugins/orchestrator/scripts/lib/${name} drifted from persona-pipeline/files/scripts/lib/${name}: `
          + 'edit the source, then copy it here under the notice',
      );
    });
  }

  it('the run locks and the runner judge a process by the copy\'s one definition', async () => {
    const lib = (rel) => import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts', rel)).href);
    const identity = await lib('lib/process-identity.mjs');
    const locks = await lib('lib/run-locks.mjs');
    const runner = await lib('peer-runner.mjs');
    for (const name of ['isProcessAlive', 'fingerprintsMatch']) {
      strictEqual(locks[name], identity[name], `lib/run-locks.mjs re-exports process-identity's ${name}`);
      strictEqual(runner[name], identity[name], `peer-runner.mjs re-exports process-identity's ${name}`);
    }
    strictEqual(runner.fingerprintForPid, identity.fingerprintForPid);
    strictEqual(runner.createRunCancellation, identity.createRunCancellation);
  });

  it('the orchestrator imports the copies, never a persona plugin\'s', () => {
    for (const script of ['peer-runner.mjs', 'dispatch-peer.mjs', 'lib/run-locks.mjs']) {
      const text = readFileSync(join(REPO_ROOT, 'plugins/orchestrator/scripts', script), 'utf8');
      ok(/from '\.\.?\/(lib\/)?process-identity\.mjs'/.test(text), `${script} imports the orchestrator's process-identity copy`);
      strictEqual(/from '[^']*\/(engineer|designer|founder)\//.test(text), false, `${script} imports no persona plugin`);
    }
  });
});
