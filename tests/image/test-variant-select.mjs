// plugins/image variant-select functional test (ADR-0037 decide slice).
//
// Unit coverage for variant selection in an ImageResult manifest and the
// explicit, run-dir-scoped prune of rejected variants (contracts.md §7).
//
// Run via `node --test tests/image/test-variant-select.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { selectVariant, rejectedPaths, pruneRejected } from '../../plugins/image/scripts/variant-select.mjs';

const sampleManifest = () => ({
  run_id: 'image-x',
  images: [
    { path: '/runs/x/a-1.png', selected: false, rejected: false },
    { path: '/runs/x/a-2.png', selected: false, rejected: false },
    { path: '/runs/x/a-3.png', selected: false, rejected: false },
  ],
});

describe('variant-select — selectVariant', () => {
  it('marks the chosen index selected and the rest rejected', () => {
    const m = selectVariant(sampleManifest(), 1);
    strictEqual(m.images[1].selected, true);
    strictEqual(m.images[1].rejected, false);
    strictEqual(m.images[0].rejected, true);
    strictEqual(m.images[2].rejected, true);
  });
  it('throws on an out-of-range index', () => throws(() => selectVariant(sampleManifest(), 5), /0\.\.2/));
  it('throws when images is not an array', () => throws(() => selectVariant({ images: null }, 0), /must be an array/));
});

describe('variant-select — rejectedPaths', () => {
  it('lists the rejected image paths', () => {
    const m = selectVariant(sampleManifest(), 0);
    deepStrictEqual(rejectedPaths(m), ['/runs/x/a-2.png', '/runs/x/a-3.png']);
  });
});

describe('variant-select — pruneRejected (explicit, run-dir-scoped)', () => {
  it('skips rejected files that do not exist (no spurious unlink)', () => {
    const m = selectVariant(sampleManifest(), 0);
    const unlinked = [];
    const pruned = pruneRejected(m, { runDir: '/runs/x', unlink: (p) => unlinked.push(p) });
    deepStrictEqual(pruned, []); // sample paths don't exist on disk
    deepStrictEqual(unlinked, []);
  });
  it('never prunes a path outside the run dir (scope guard)', () => {
    const m = { images: [{ path: '/etc/hosts', rejected: true }] };
    const unlinked = [];
    const pruned = pruneRejected(m, { runDir: '/runs/x', unlink: (p) => unlinked.push(p) });
    deepStrictEqual(unlinked, []);
    deepStrictEqual(pruned, []);
  });
});

describe('variant-select — Codex-review hardening', () => {
  it('pruneRejected throws when runDir is missing (scope is mandatory)', () => {
    throws(() => pruneRejected({ images: [] }, {}), /requires runDir/);
  });
  it('rejectedPaths excludes selected entries and non-image artifacts', () => {
    const m = { images: [
      { path: '/runs/x/a-1.png', selected: true, rejected: true },   // inconsistent flags — not prunable
      { path: '/runs/x/brief.json', rejected: true },                 // non-image run artifact
      { path: '/runs/x/manifest.json', rejected: true },              // non-image run artifact
      { path: '/runs/x/a-2.png', rejected: true, selected: false },   // a real rejected variant
    ] };
    deepStrictEqual(rejectedPaths(m), ['/runs/x/a-2.png']);
  });
});

describe('variant-select — failed_outputs are reachable by the explicit prune (ADR-0055)', () => {
  // A retained failure lives outside images[] so it can never be selected.
  // That must not also put it outside the ONLY cleanup path — an artifact no
  // prune can reach is a leak, not a retention policy (contracts.md §7).
  const manifest = () => ({
    status: 'error',
    images: [],
    failed_outputs: [{ path: '/runs/r/a-1.png', selected: false, rejected: true }],
  });

  it('rejectedPaths reports a failed output', () => {
    deepStrictEqual(rejectedPaths(manifest()), ['/runs/r/a-1.png']);
  });

  it('control: an unmarked failed output is still not prunable', () => {
    const m = manifest();
    m.failed_outputs[0].rejected = false;
    deepStrictEqual(rejectedPaths(m), [], 'the rejected flag is what makes it reachable');
  });

  it('a selected entry is never prunable, wherever it is filed', () => {
    const m = manifest();
    m.failed_outputs[0].selected = true;
    deepStrictEqual(rejectedPaths(m), []);
  });

  it('a manifest with no failed_outputs field still works', () => {
    deepStrictEqual(rejectedPaths({ images: [] }), []);
  });

  it('pruneRejected actually DELETES a failed output', () => {
    // rejectedPaths only reports; pruneRejected is what removes the file. A
    // reporting-only test left the real deletion path unverified, and a
    // mutation that reverted it stayed green.
    const runDir = mkdtempSync(join(tmpdir(), 'image-prune-'));
    const file = join(runDir, 'a-1.png');
    writeFileSync(file, 'x');
    const m = { status: 'error', images: [], failed_outputs: [{ path: file, selected: false, rejected: true }] };
    deepStrictEqual(pruneRejected(m, { runDir }), [file]);
    strictEqual(existsSync(file), false, 'the file must be gone');
  });

  it('control: pruneRejected leaves an UNMARKED failed output alone', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'image-prune-'));
    const file = join(runDir, 'a-1.png');
    writeFileSync(file, 'x');
    const m = { status: 'error', images: [], failed_outputs: [{ path: file, selected: false, rejected: false }] };
    deepStrictEqual(pruneRejected(m, { runDir }), []);
    strictEqual(existsSync(file), true);
  });

  it('control: pruneRejected still refuses a path outside the run dir', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'image-prune-'));
    const outside = mkdtempSync(join(tmpdir(), 'image-outside-'));
    const file = join(outside, 'a-1.png');
    writeFileSync(file, 'x');
    const m = { status: 'error', images: [], failed_outputs: [{ path: file, selected: false, rejected: true }] };
    deepStrictEqual(pruneRejected(m, { runDir }), [], 'run-dir scope must still hold for the new array');
    strictEqual(existsSync(file), true);
  });
});
