#!/usr/bin/env node
// plugins/image/scripts/variant-select.mjs (ADR-0037)
//
// Record a variant selection in an ImageResult run manifest (selected/rejected)
// and optionally prune rejected variant files. Retention is audit-by-default;
// cleanup is EXPLICIT and run-dir-scoped (contracts.md §7). Pure functions +
// a CLI. No image generation, no image API call here.
//
// Cleanup safety (peer-reviewed): prune deletes ONLY a generated image variant
// (png/jpeg/webp) that is rejected AND not selected, AND only when its REAL
// path (symlinks resolved) is inside the REAL run dir — so a symlinked parent
// component cannot escape, and run artifacts (manifest.json / brief.json /
// prompt.txt) are never touched.

import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { parseArgs } from 'node:util';

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp)$/i;

export function selectVariant(manifest, selectedIndex) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.images)) {
    throw new Error('manifest.images must be an array');
  }
  const n = manifest.images.length;
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= n) {
    throw new Error(`selectedIndex must be 0..${n - 1}`);
  }
  const images = manifest.images.map((img, i) => ({ ...img, selected: i === selectedIndex, rejected: i !== selectedIndex }));
  return { ...manifest, images };
}

// A prunable entry: a rejected, non-selected, image-extension variant.
function isPrunableVariant(img) {
  return !!img && img.rejected === true && img.selected !== true && typeof img.path === 'string' && IMAGE_EXT_RE.test(img.path);
}

export function rejectedPaths(manifest) {
  if (!manifest || !Array.isArray(manifest.images)) return [];
  return manifest.images.filter(isPrunableVariant).map((img) => img.path);
}

// Explicit prune of rejected variant files. runDir is MANDATORY (scope cannot
// be disabled). Returns the paths actually pruned; marks them in the manifest.
export function pruneRejected(manifest, { runDir, unlink = unlinkSync } = {}) {
  if (!runDir) throw new Error('pruneRejected requires runDir (run-dir scope is mandatory)');
  let realRoot;
  try { realRoot = realpathSync(resolve(runDir)); } catch { return []; } // run dir gone → nothing to prune
  const pruned = [];
  for (const img of (manifest && Array.isArray(manifest.images) ? manifest.images : [])) {
    if (!isPrunableVariant(img)) continue;
    const p = resolve(img.path);
    if (!existsSync(p)) continue;
    let lst;
    try { lst = lstatSync(p); } catch { continue; }
    if (!lst.isFile()) continue; // refuse a symlink/dir as the final component
    let realP;
    try { realP = realpathSync(p); } catch { continue; }
    // realpath scope: defeats a symlinked PARENT component escaping the run dir
    if (!(realP === realRoot || realP.startsWith(realRoot + sep))) continue;
    try { unlink(p); img.pruned = true; pruned.push(p); } catch { /* best-effort */ }
  }
  return pruned;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        'manifest-file': { type: 'string' },
        select: { type: 'string' },
        'prune-rejected': { type: 'boolean' },
      },
      strict: true,
    });
  } catch (err) { console.error(`variant-select: ${err.message}`); process.exit(2); }
  const v = parsed.values;
  if (!v['manifest-file']) { console.error('variant-select: --manifest-file <path> is required'); process.exit(2); }
  let manifest;
  try { manifest = JSON.parse(readFileSync(v['manifest-file'], 'utf8')); } catch (err) {
    console.error(`variant-select: cannot read/parse manifest: ${err.message}`); process.exit(2);
  }
  if (v.select != null) {
    if (!/^\d+$/.test(v.select)) { console.error('variant-select: --select must be a non-negative integer'); process.exit(2); }
    try { manifest = selectVariant(manifest, Number(v.select)); } catch (err) { console.error(`variant-select: ${err.message}`); process.exit(1); }
  }
  let pruned = [];
  if (v['prune-rejected']) pruned = pruneRejected(manifest, { runDir: dirname(resolve(v['manifest-file'])) });
  try { writeFileSync(v['manifest-file'], `${JSON.stringify(manifest, null, 2)}\n`); } catch (err) {
    console.error(`variant-select: cannot write manifest: ${err.message}`); process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, selected: manifest.images.findIndex((i) => i && i.selected), pruned }, null, 2));
  process.exit(0);
}
