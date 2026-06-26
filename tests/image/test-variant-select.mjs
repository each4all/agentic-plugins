// plugins/image variant-select functional test (ADR-0037 decide slice).
//
// Unit coverage for variant selection in an ImageResult manifest and the
// explicit, run-dir-scoped prune of rejected variants (contracts.md §7).
//
// Run via `node --test tests/image/test-variant-select.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert/strict';

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
