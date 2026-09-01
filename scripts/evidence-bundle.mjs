#!/usr/bin/env node
// The selected-blob bundle — contract §11.1's isolation, made executable.
//
// §11.1 says isolation is BY DELIVERY, not by instruction: "Telling a lane not
// to look is not isolation — a lane with ordinary repository access at the
// pinned commit can read the incumbent detector, the excluded evidence
// records, and this repository's history, all of which reveal the shape of a
// correct answer." That clause had no implementation, so every lane so far
// would have run inside the repository, which is the one place §11.1 rules out.
//
// Measured in this repository at the time this file was written, a lane with
// ordinary repository access could read all of:
//
//   - `association-policy.md` and its harness, which §11.2 names explicitly;
//   - `check-doc-evidence.mjs`, whose DATE_CITATION_PHRASES is a construction
//     inventory derived from this corpus — the incumbent detector §11.1 names;
//   - the git history, including commit bodies describing the decision;
//   - and, for an agent with project-scoped memory, notes carrying counts and
//     construction shapes read off this corpus.
//
// A fresh session closes only the last of those, and only when its working
// directory is not the repository. A bundle closes all of them, because the
// forbidden material is not there to read.
//
// WHAT GOES IN is exactly §11.2's May list and nothing else: this contract, the
// family registry, the corpus manifest, and the blobs the manifest names. The
// builder is ALLOW-LIST driven — it writes only files it enumerated from the
// manifest — so a new file in the repository cannot leak into a bundle by
// default. `verify` then asserts the converse: that the bundle contains no file
// the manifest and the May list do not account for. Both directions are needed;
// either alone is a check that can pass while the bundle is wrong.
//
// Paths are REPO-RELATIVE inside the bundle. A lane emits `path` values that
// must match the manifest verbatim (§3.2), so a bundle that re-rooted its files
// would force every lane to invent a mapping, and two lanes would invent two.
//
// Usage:
//   node scripts/evidence-bundle.mjs build --out <dir> [--manifest <path>] [--force]
//   node scripts/evidence-bundle.mjs verify --bundle <dir>
//
// Exit codes:
//   0 — bundle written, or verification found no discrepancy
//   1 — a discrepancy, a missing blob, or a refusal
//   2 — usage error

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_PATH, validateManifestShape } from './evidence-corpus.mjs';
import { CONTRACT_PATH, REGISTRY_PATH, BUNDLE_FILES, bundleDigest, canonicalSerialise } from './evidence-measurement.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_MANIFEST = 'bundle-manifest.json';
export const BUNDLE_SCHEMA = 'evidence-measurement-bundle-delivery-1.0';

/**
 * Files a bundle may contain besides the corpus blobs — §11.2's May list.
 * Deliberately a constant rather than a glob: a glob over the measurement
 * directory would have swept in `association-policy.md`, which is the exact
 * file §2.3 excludes.
 */
export const SHARED_INPUTS = Object.freeze([...BUNDLE_FILES]);

/**
 * Paths that must never appear in a bundle, checked by name as a BACKSTOP.
 *
 * The allow-list above is the actual mechanism; this list exists so that a
 * future change which widens the allow-list fails loudly on the files whose
 * exclusion is named in the contract rather than silently shipping them. A
 * denylist alone would be the closed-vocabulary guard this repository has
 * watched fail, so it is never the only check.
 */
export const NEVER_IN_BUNDLE = Object.freeze([
  'docs/assurance/evidence/measurement/association-policy.md',
  'scripts/measure-association-policy.mjs',
  'tests/scripts/test-measure-association-policy.mjs',
  'scripts/check-doc-evidence.mjs',
  'docs/assurance/evidence/measurement/authority-baseline.json',
]);

/**
 * `repoRoot` is a PARAMETER, not the module's own root.
 *
 * The first version hardcoded REPO_ROOT here while `build` took a `repoRoot`
 * option, so a build pointed at another tree read that tree's manifest and this
 * tree's blobs. In production both are the same path, which is why it looked
 * fine; a test control that pointed at a repository with no objects is what
 * exposed it, by succeeding where it should have failed.
 */
function git(repoRoot, args, opts = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 1 << 28, ...opts });
}

/** git's own object id for a blob's bytes — the manifest's integrity field. */
export function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function readManifest(repoRoot, path) {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
  // `validateManifestShape` ALREADY recomputes and compares the §2.1 digest.
  // An explicit second comparison here was written before that was checked, and
  // a mutation exercise found it: disabling it changed nothing, because the
  // shape validator fired first. A second copy of a rule is a second rule — it
  // agrees until one of them is edited — so the duplicate is gone and the
  // single check lives where the manifest's other invariants do.
  const shape = validateManifestShape(manifest);
  if (shape && shape.length > 0) {
    throw new Error(`${path} is not a well-formed corpus manifest: ${JSON.stringify(shape)}`);
  }
  return manifest;
}

/** The union of every (path, blob) the manifest names, across all profiles. */
export function bundleMembers(manifest) {
  const byPath = new Map();
  for (const [profile, v] of Object.entries(manifest.profiles ?? {})) {
    for (const f of v.files ?? []) {
      const prior = byPath.get(f.path);
      if (prior && prior.blob !== f.blob) {
        throw new Error(`manifest names ${f.path} with two different blobs (${prior.blob}, ${f.blob}); a bundle cannot deliver both`);
      }
      if (prior) { prior.profiles.push(profile); continue; }
      byPath.set(f.path, { path: f.path, blob: f.blob, bytes: f.bytes, profiles: [profile] });
    }
  }
  // Sorted HERE, once. Profile order otherwise follows the manifest's key
  // order, which nothing fixes, so two manifests listing the same corpus in a
  // different order would produce two different bundle manifests. Sorting at
  // the write site instead would leave the in-memory value order-dependent for
  // every other caller.
  for (const m of byPath.values()) m.profiles.sort();
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function build(outDir, { repoRoot = REPO_ROOT, manifestPath = MANIFEST_PATH, force = false } = {}) {
  const out = resolve(outDir);
  if (out === resolve(repoRoot)) throw new Error('refusing to build a bundle into the repository itself — the point is that the repository is not there');
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length > 0 && !force) {
      throw new Error(`${outDir} is not empty (${entries.length} entr(ies)); pass --force to replace it. A bundle built over an existing tree can carry files the manifest never named.`);
    }
    if (entries.length > 0) rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });

  const manifest = readManifest(repoRoot, manifestPath);
  const members = bundleMembers(manifest);
  const written = [];

  const writeInto = (relPath, bytes) => {
    if (NEVER_IN_BUNDLE.includes(relPath)) {
      throw new Error(`refusing to write ${relPath} into a bundle: the contract excludes it from every lane's inputs (§2.3, §11.2)`);
    }
    const dest = join(out, relPath);
    if (relative(out, dest).startsWith('..')) throw new Error(`refusing to write outside the bundle: ${relPath}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    written.push({ path: relPath, bytes: bytes.length, blob: gitBlobId(bytes) });
  };

  // 1. The corpus blobs, read from the PINNED COMMIT'S TREE rather than from
  //    the checkout — §2.1's rule, and the reason the pin is worth having.
  for (const m of members) {
    let bytes;
    try {
      bytes = git(repoRoot, ['cat-file', 'blob', m.blob]);
    } catch {
      throw new Error(`blob ${m.blob} for ${m.path} is not in this repository; the pin at ${manifest.commit} cannot be delivered`);
    }
    // The byte length is checked and the blob id is not. `git cat-file blob X`
    // cannot return bytes that hash to anything but X — the id IS the hash — so
    // a round-trip check here is unfalsifiable, and a mutation exercise
    // confirmed no test could make it fire. The length, by contrast, comes from
    // the MANIFEST and can disagree with the object, which is a real defect and
    // is caught. `verify` re-hashes the delivered files, where the bytes have
    // left git's hands and a check has something to catch.
    if (bytes.length !== m.bytes) {
      throw new Error(`${m.path}: blob ${m.blob} is ${bytes.length} bytes, the manifest says ${m.bytes}`);
    }
    writeInto(m.path, bytes);
  }

  // 2. The three shared inputs, at their repo-relative paths so that a lane
  //    recomputing the §11.3 bundle digest gets the same framing.
  for (const rel of SHARED_INPUTS) writeInto(rel, readFileSync(resolve(repoRoot, rel)));

  const seal = bundleDigest(repoRoot);
  const bundleManifest = {
    schema: BUNDLE_SCHEMA,
    contract_version: JSON.parse(readFileSync(resolve(repoRoot, REGISTRY_PATH), 'utf8')).contract_version,
    corpus_commit: manifest.commit,
    manifest_digest: manifest.digest,
    bundle_digest: seal.digest,
    shared_inputs: SHARED_INPUTS.map((p) => written.find((w) => w.path === p)),
    corpus_files: members.map((m) => ({ path: m.path, blob: m.blob, bytes: m.bytes, profiles: m.profiles })),
    note: 'Contract 11.2 May-list delivery. This directory is the whole of what a lane may read. Paths are repository-relative so a lane emits them verbatim; nothing here is a conformance example, and the absence of any file is not a statement about the corpus.',
  };
  // `canonicalSerialise`, not a hand-rolled replacer. The first version passed
  // `Object.keys(bundleManifest).sort()` as the replacer array, which is a
  // GLOBAL allow-list applied at every nesting level — so every nested object
  // lost its keys and `corpus_files` became a list of empty objects. `verify`
  // caught it immediately, with 160 findings naming `undefined`; a looser
  // verify would have reported a clean bundle over an unreadable manifest.
  writeFileSync(join(out, BUNDLE_MANIFEST), canonicalSerialise(bundleManifest), 'utf8');

  return { out, corpusFiles: members.length, sharedInputs: SHARED_INPUTS.length, bundleDigest: seal.digest, corpusCommit: manifest.commit };
}

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, acc);
    else acc.push(relative(base, full).split(sep).join('/'));
  }
  return acc;
}

export function verify(bundleDir) {
  const dir = resolve(bundleDir);
  const findings = [];
  const at = (path, detail) => findings.push({ path, detail });

  let bm;
  try {
    bm = JSON.parse(readFileSync(join(dir, BUNDLE_MANIFEST), 'utf8'));
  } catch (err) {
    return { ran: false, reason: `${BUNDLE_MANIFEST} is unreadable: ${err.message}`, findings: [], files: 0 };
  }

  const present = new Set(walk(dir));
  present.delete(BUNDLE_MANIFEST);

  // Every corpus file the manifest names, with the bytes it names.
  for (const f of bm.corpus_files ?? []) {
    if (!present.has(f.path)) { at(f.path, 'named by the bundle manifest and not present'); continue; }
    present.delete(f.path);
    const bytes = readFileSync(join(dir, f.path));
    if (bytes.length !== f.bytes) at(f.path, `is ${bytes.length} bytes, manifest says ${f.bytes}`);
    const id = gitBlobId(bytes);
    if (id !== f.blob) at(f.path, `hashes to ${id}, manifest says ${f.blob}`);
  }
  for (const s of bm.shared_inputs ?? []) {
    if (!s) { at('shared_inputs', 'a shared input is missing from the bundle manifest'); continue; }
    if (!present.has(s.path)) { at(s.path, 'shared input named and not present'); continue; }
    present.delete(s.path);
    const bytes = readFileSync(join(dir, s.path));
    const id = gitBlobId(bytes);
    if (id !== s.blob) at(s.path, `hashes to ${id}, bundle manifest says ${s.blob}`);
  }

  // The converse, and the half that actually matters for isolation: nothing
  // else is here. A bundle that carries one extra file is not a bundle.
  for (const extra of present) at(extra, 'is in the bundle and is accounted for by neither the corpus manifest nor the shared inputs (§11.1)');
  for (const forbidden of NEVER_IN_BUNDLE) {
    if (walk(dir).includes(forbidden)) at(forbidden, 'the contract excludes this file from every lane\'s inputs (§2.3, §11.2)');
  }
  if (walk(dir).some((p) => p === '.git' || p.startsWith('.git/'))) {
    at('.git', 'a bundle carrying repository history is not isolated (§11.1)');
  }

  return { ran: true, reason: null, findings, files: (bm.corpus_files ?? []).length + (bm.shared_inputs ?? []).length };
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

export function main(argv) {
  const command = argv[0];
  if (command === 'build') {
    const out = flagValue(argv, '--out');
    if (!out) { console.error('usage: evidence-bundle.mjs build --out <dir> [--manifest <path>] [--force]'); return 2; }
    try {
      const r = build(out, { manifestPath: flagValue(argv, '--manifest') ?? MANIFEST_PATH, force: argv.includes('--force') });
      console.log(`bundle: wrote ${r.out}`);
      console.log(`  ${r.corpusFiles} corpus file(s) at pin ${r.corpusCommit}`);
      console.log(`  ${r.sharedInputs} shared input(s), bundle digest ${r.bundleDigest}`);
      console.log('  nothing else. Point a lane at this directory, not at the repository (§11.1).');
      return 0;
    } catch (err) {
      console.error(`bundle: REFUSED — ${err.message}`);
      return 1;
    }
  }
  if (command === 'verify') {
    const b = flagValue(argv, '--bundle');
    if (!b) { console.error('usage: evidence-bundle.mjs verify --bundle <dir>'); return 2; }
    const r = verify(b);
    if (!r.ran) { console.error(`bundle verify: NOT RUN — ${r.reason}`); return 1; }
    console.log(`bundle verify: ${r.files} file(s) accounted for — ${r.findings.length} finding(s)`);
    for (const f of r.findings) console.error(`  ${f.path}: ${f.detail}`);
    return r.findings.length === 0 ? 0 : 1;
  }
  console.error('usage: evidence-bundle.mjs build|verify');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => { process.exitCode = main(process.argv.slice(2)); })();
}
