// Guard meta-test for the four copied peer-runner spawn blocks.
//
// The persona plugins may not import from each other (ADR-0010 §5), so
// `plugins/{designer,engineer,founder,orchestrator}/scripts/peer-runner.mjs`
// carry copy-not-import siblings of `runPeer`'s child-lifecycle section. The
// 2026-07-11 CI-hang fix depends on a structural invariant in that section —
// every child observer ('data', 'error', 'close', 'spawn') is registered in
// the same synchronous block as spawn(), before the first await — and a
// partial re-patch of one copy would silently reintroduce the lost-event hang
// in just that persona. This test pins the four copies to byte-identical
// spawn sections (after normalizing the persona name), so any drift fails
// loudly and names the diverging file.
//
// Scope is deliberately the spawn section only (spawn() through the terminal
// updateHandle), not the whole file: the storage-policy areas above runPeer
// differ intentionally per persona (engineer keeps a legacy home; designer is
// canonical-only per ADR-0042 SD7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PERSONAS = ['designer', 'engineer', 'founder', 'orchestrator'];

const SECTION_START = '    const detached = process.platform !== \'win32\';';
const SECTION_END = '    // ADR-0040 §5: live terminal transition (completed / failed / cancelled).';

function spawnSection(persona) {
  const filePath = path.join(REPO_ROOT, 'plugins', persona, 'scripts', 'peer-runner.mjs');
  const source = fs.readFileSync(filePath, 'utf8');
  const start = source.indexOf(SECTION_START);
  assert.notEqual(start, -1, `${persona}: spawn-section start marker not found`);
  const end = source.indexOf(SECTION_END, start);
  assert.notEqual(end, -1, `${persona}: spawn-section end marker not found`);
  // Normalize the persona name so the copies compare as structure, not text.
  return source.slice(start, end).replaceAll(persona, '<persona>');
}

test('the four peer-runner spawn sections are structurally identical', () => {
  const reference = spawnSection('engineer');
  assert.ok(
    reference.includes("child.once('spawn'"),
    'engineer spawn section must register the spawn-driven running transition',
  );
  assert.ok(
    reference.includes("child.once('close'"),
    'engineer spawn section must register the close barrier',
  );
  for (const persona of PERSONAS) {
    if (persona === 'engineer') continue;
    assert.equal(
      spawnSection(persona),
      reference,
      `plugins/${persona}/scripts/peer-runner.mjs spawn section drifted from the engineer copy — `
        + 'the synchronous-registration hang fix must stay byte-identical across all four personas '
        + '(re-apply the same patch or update all four together)',
    );
  }
});
