#!/usr/bin/env node
// The frozen corpus for the evidence measurement contract
// (docs/assurance/evidence/measurement-contract.md §2).
//
// The contract pins a corpus so that a typed occurrence exporter and an
// independently authored coverage manifest describe the SAME bytes. Two
// properties make that pin worth having, and both are why this file exists
// rather than a sentence in the contract:
//
//   - The manifest is NORMATIVE FOR MEMBERSHIP, not only for integrity. A
//     commit alone does not say which files are measured, and the repository
//     already carries two different answers: `check-doc-evidence.mjs` reads an
//     ENUMERATED list of three stage documents for its release and proof
//     checks and a DISCOVERED set of markdown files for its commit-sha check.
//     Measured at the pinned commit those sets carry different citation
//     counts, so two authors who each picked "the corpus" without being told
//     which one would disagree on hundreds of rows before comparing a single
//     value. The manifest therefore lists the files.
//
//   - The pin reads the COMMIT, never the working tree. The three stage
//     documents changed 52, 81 and 57 times in the 60 days before this file
//     was written, and eighteen runtime releases landed in the last thirty of
//     them. A measurement that resolved its own corpus from the checkout would
//     silently measure a different corpus on every run and in CI.
//
// Membership rules are IMPORTED from `check-doc-evidence.mjs` rather than
// restated. A second copy of a membership rule is a second rule: it agrees
// until one of them is edited, and then the disagreement is silent. The one
// thing this file does not import is the walk — `discoverShaCorpus` lists the
// index, and a pinned corpus must list a tree.
//
// Usage:
//   node scripts/evidence-corpus.mjs pin [--commit <rev>] [--out <path>]
//   node scripts/evidence-corpus.mjs verify [--manifest <path>]
//   node scripts/evidence-corpus.mjs show [--manifest <path>]
//
// Exit codes:
//   0 — manifest written, or verification found no drift
//   1 — verification failed, or the pinned commit is not available here

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVIDENCE_DOCS, isShaCorpusFile } from './check-doc-evidence.mjs';

export const MANIFEST_PATH = 'docs/assurance/evidence/measurement/corpus-manifest.json';
export const MANIFEST_SCHEMA = 'evidence-measurement-corpus-1.0';

/**
 * The corpus profiles, and why there are two rather than one.
 *
 * Collapsing them was considered and rejected on a measurement: the two
 * existing checks are not sensitive to the same documents, and forcing one
 * universe either discards the narrower check's coverage signal or admits
 * files the wider one was measured to be harmed by. The contract keeps both
 * and binds each claim family to the profile it is actually checked against
 * (contract §2.2), so a family is never compared against a corpus that does
 * not carry it.
 */
export const PROFILES = Object.freeze({
  'stage-docs': Object.freeze({
    membership: 'enumerated',
    rule: 'The three stage documents that make release and current-proof claims.',
  }),
  'discovered-md': Object.freeze({
    membership: 'discovered',
    rule: 'Every tracked markdown file at the repository root or under docs/, excluding generated changelogs (isShaCorpusFile in scripts/check-doc-evidence.mjs).',
  }),
});

/**
 * The manifest's self-digest, per contract §2.1.
 *
 * Serialisation is fixed by the contract because it is not derivable: the digest
 * is normative in three places there, and two authors asked to produce "the
 * manifest digest" would otherwise pick the blob id, a hash of the file bytes,
 * or a hash of some re-serialisation, and every comparison would end
 * `not-comparable` before measuring anything.
 */
export function manifestDigest(manifest) {
  const { digest: _omit, ...rest } = manifest;
  // Key order comes from `JSON.stringify`'s ARRAY REPLACER, not from rebuilding
  // the object with sorted keys.
  //
  // An earlier revision used `Object.fromEntries(Object.keys(v).sort()…)`, which
  // cannot express the order §2.1 requires: a JS object always enumerates
  // integer-like keys ("0", "10") first and in ascending NUMERIC order, whatever
  // order they were inserted in, so the digest would have serialised "2" before
  // "10" where the contract says "10" before "2". No key anywhere in today's
  // manifest is integer-like, so that defect could not change the digest of any
  // manifest this tool has produced — it is fixed because §2.1 states the order
  // normatively and a later profile keyed by number would silently diverge the
  // two lanes rather than fail.
  //
  // The replacer list is the sorted UNION of every key in the document. It acts
  // as a global allow-list applied in list order, so each nested object emits
  // its own subset in that same lexicographic order, and the `null, 2` indent
  // form the contract fixes is preserved exactly.
  const keys = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { keys.add(k); collect(v[k]); }
    }
  };
  collect(rest);
  return createHash('sha256')
    .update(`${JSON.stringify(rest, [...keys].sort(), 2)}\n`, 'utf8')
    .digest('hex');
}

function git(repoRoot, args, opts = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

/**
 * Is the pinned commit actually readable here?
 *
 * Fail-closed for the same reason `gitHistoryAvailable` exists next door: a
 * shallow clone would let every blob lookup miss and the whole comparison
 * would read as "no drift" when it is really "nothing was checked".
 */
export function commitAvailable(repoRoot, commit) {
  try {
    if (git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
      return { ok: false, reason: 'repository is a shallow clone (fetch-depth: 0 required)' };
    }
    git(repoRoot, ['rev-parse', '--verify', `${commit}^{commit}`]);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `commit ${commit} is not readable here: ${err.message}` };
  }
}

/**
 * Every tracked path in the commit's tree, as the tree records it.
 *
 * `ls-tree -r` walks the COMMIT. The sibling `discoverShaCorpus` walks the
 * INDEX, which is the right source for a check that gates the working tree and
 * the wrong one for a pin that must reproduce on another machine.
 */
function treeEntries(repoRoot, commit) {
  // The DEFAULT long listing (`-l`), not `--format`, and no `core.quotePath`
  // override. Which form is used is load-bearing, and the reason is narrower
  // than an earlier revision of this comment claimed.
  //
  // Measured on git 2.50.1, `--format=<multiple fields>` C-quotes and
  // octal-escapes a hostile path EVEN UNDER `-z`, so such a file arrives as the
  // literal `"docs/\355\225\234.md"`. That no longer ends in `.md`, so
  // `isShaCorpusFile` drops it, `unparsed` stays 0 (the row parsed — only its
  // value was wrong), and the profile silently loses a file while `verify`
  // prints "no drift". Fail-OPEN, and exactly the two-lanes-disagree-on-
  // membership failure this file exists to prevent.
  //
  // The earlier repair set `-c core.quotePath=false` and a comment claiming it
  // handled non-ASCII, tabs, quotes and backslashes alike. Re-measured, it
  // handles ONLY the non-ASCII class: under the same `--format` and `-z`, a
  // tab, quote, backslash or newline in a path is still C-quoted with the flag
  // set, so four of the five hostile classes stayed fail-open behind a comment
  // that said they were covered.
  //
  // The default listing quotes NONE of the five, even with `core.quotePath=true`
  // forced on, and `-l` still supplies the size the manifest records. Reading
  // the never-quoting form is preferable to decoding the quoted one: a decoder
  // would add an octal/escape parser whose own bugs would be invisible in
  // exactly the same fail-open way.
  //
  // Read as BYTES and decode fatally. Unquoting is not the same as being
  // byte-safe: a git path is a byte string, not text, and decoding the listing
  // as UTF-8 with the default lossy replacement turns an invalid byte into
  // U+FFFD. Measured, that is fail-open twice over — a lone invalid path is
  // recorded as a path that does not exist in the tree while `validateManifest
  // Shape` and `verifyManifest` both report nothing (the re-read repeats the
  // same lossy decode, so the two sides agree about a fiction), and two paths
  // differing only in their invalid byte collapse onto one string. Refusing is
  // right rather than conservative: nothing in this corpus has such a path, so
  // the choice is between a loud stop and a silently wrong pin.
  const out = git(repoRoot, ['ls-tree', '-r', '-l', '-z', commit], { encoding: 'buffer' });
  const strict = new TextDecoder('utf-8', { fatal: true });
  const records = [];
  let start = 0;
  for (let i = 0; i <= out.length; i += 1) {
    if (i === out.length || out[i] === 0) {
      if (i > start) records.push(out.subarray(start, i));
      start = i + 1;
    }
  }
  const entries = [];
  let rows = 0;
  let unparsed = 0;
  for (const record of records) {
    let line;
    try {
      line = strict.decode(record);
    } catch {
      // Name the offending bytes: the path cannot be printed, so the hex is
      // the only faithful thing to report.
      throw new Error(
        `tree row in ${commit} is not valid UTF-8 and cannot be pinned faithfully: ${record.toString('hex')}`,
      );
    }
    rows += 1;
    const m = line.match(/^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)[ \t](.*)$/s);
    if (!m) { unparsed += 1; continue; }
    const [, mode, type, blob, size, path] = m;
    if (type !== 'blob') continue;
    entries.push({ path, blob, bytes: size === '-' ? null : Number(size), mode });
  }
  // A parse that yields nothing is a parser failure, not an empty repository.
  // Without this a broken row pattern would pin ZERO files and report success,
  // and every later comparison would run against an empty corpus and agree
  // perfectly. Measured during authoring: a pattern that left a leading space
  // on every path produced exactly that.
  if (entries.length === 0) {
    throw new Error(`no blob entries parsed from ${commit}; the tree listing or its parse is broken`);
  }
  // PARTIAL failure is the dangerous case and the total one is not: a pattern
  // that stops matching SOME rows silently shrinks the discovered profile,
  // which then pins a smaller corpus that verifies against itself forever
  // after. Every row git emits must parse (cross-host review finding).
  if (unparsed > 0) {
    throw new Error(`${unparsed} of ${rows} tree row(s) from ${commit} did not parse; refusing to pin a partial corpus`);
  }
  return entries;
}

export function buildManifest(repoRoot, commit) {
  const resolved = git(repoRoot, ['rev-parse', `${commit}^{commit}`]).trim();
  const entries = treeEntries(repoRoot, resolved);
  const byPath = new Map(entries.map((e) => [e.path, e]));

  const profiles = {};
  for (const [id, spec] of Object.entries(PROFILES)) {
    const paths = spec.membership === 'enumerated'
      ? [...EVIDENCE_DOCS]
      : entries.map((e) => e.path).filter(isShaCorpusFile);
    const files = [];
    const missing = [];
    for (const path of [...paths].sort()) {
      const entry = byPath.get(path);
      if (!entry) { missing.push(path); continue; }
      files.push({ path, blob: entry.blob, bytes: entry.bytes });
    }
    if (missing.length) {
      throw new Error(`profile ${id}: ${missing.length} enumerated path(s) absent from ${resolved}: ${missing.join(', ')}`);
    }
    // Dormant for the profiles that exist today, and deliberately kept.
    // `EVIDENCE_DOCS` is a subset of `isShaCorpusFile`, so whenever the
    // enumerated profile resolves, the discovered one holds at least those
    // three files and cannot be empty — the absence check above fires first.
    // This guard is live defence only for a future profile that does not
    // overlap the enumerated set. `tests/scripts/test-evidence-corpus.mjs`
    // pins the subset relation so that reasoning is re-read rather than
    // assumed if it ever stops holding.
    if (files.length === 0) {
      throw new Error(`profile ${id} selected no files from ${resolved}; a corpus profile that matches nothing is a rule failure, not a corpus state`);
    }
    profiles[id] = { membership: spec.membership, rule: spec.rule, files };
  }

  const manifest = { schema: MANIFEST_SCHEMA, commit: resolved, generated_by: 'scripts/evidence-corpus.mjs', profiles };
  return { ...manifest, digest: manifestDigest(manifest) };
}

/**
 * Compare a stored manifest against the tree it names.
 *
 * Three drift classes are reported separately because they mean different
 * things to a measurement in flight: a MEMBERSHIP change means the two lanes
 * are no longer describing the same document set, a CONTENT change means the
 * bytes under an unchanged path moved, and an UNREADABLE commit means the
 * comparison cannot be made at all. Only the third is a reason to stop
 * without a verdict; the first two are the rebaseline trigger the contract
 * names in §8.
 */
/**
 * Structural validation, run before any comparison.
 *
 * `verifyManifest` used to go straight to the tree, which meant a manifest
 * could be structurally meaningless and still report "no drift" — measured:
 * a wrong `schema`, a missing `schema`, a duplicated path, and, worst,
 * `"commit": "HEAD"` all verified clean. A symbolic ref is not a pin at all;
 * it re-resolves on every run, so the corpus it names moves while the
 * manifest claims to have frozen it (cross-host review finding).
 */
export function validateManifestShape(manifest) {
  const findings = [];
  const at = (d) => findings.push({ kind: 'manifest', profile: null, detail: d });

  if (!manifest || typeof manifest !== 'object') { at('manifest is not an object'); return findings; }
  if (manifest.schema !== MANIFEST_SCHEMA) at(`schema is ${JSON.stringify(manifest.schema)}, expected ${JSON.stringify(MANIFEST_SCHEMA)}`);
  if (typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit)) {
    at(`commit ${JSON.stringify(manifest.commit)} is not a full 40-character object name; a symbolic or abbreviated ref is not a pin`);
  }
  const profiles = manifest.profiles;
  if (!profiles || typeof profiles !== 'object') { at('profiles is missing'); return findings; }

  if (typeof manifest.digest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.digest)) {
    at('digest is missing or is not a 64-character lowercase hex string (contract §2.1)');
  } else if (manifest.digest !== manifestDigest(manifest)) {
    at('digest does not match the manifest it accompanies');
  }

  const declared = Object.keys(PROFILES).sort();
  const present = Object.keys(profiles).sort();
  if (declared.join('\u0000') !== present.join('\u0000')) {
    at(`profiles are [${present.join(', ')}], expected exactly [${declared.join(', ')}]`);
  }

  for (const [id, spec] of Object.entries(PROFILES)) {
    const p = profiles[id];
    if (!p) continue;
    if (p.membership !== spec.membership) findings.push({ kind: 'manifest', profile: id, detail: `membership is ${JSON.stringify(p.membership)}, expected ${JSON.stringify(spec.membership)}` });
    if (p.rule !== spec.rule) findings.push({ kind: 'manifest', profile: id, detail: 'recorded rule text no longer matches the rule this build would apply' });
    if (!Array.isArray(p.files)) { findings.push({ kind: 'manifest', profile: id, detail: 'files is not an array' }); continue; }
    // The pin side already refuses an empty profile; without the same rule here
    // `show` rendered a manifest pinning zero files as valid and exited 0 — the
    // vacuity the pin-side guard exists to prevent (cross-host review finding).
    if (p.files.length === 0) findings.push({ kind: 'manifest', profile: id, detail: 'profile pins no files; a corpus that matches nothing is a rule failure, not a corpus state' });
    const seen = new Set();
    for (const f of p.files) {
      if (!f || typeof f.path !== 'string') { findings.push({ kind: 'manifest', profile: id, detail: 'a file entry has no path' }); continue; }
      if (seen.has(f.path)) findings.push({ kind: 'manifest', profile: id, path: f.path, detail: 'path appears more than once; membership must be a set' });
      seen.add(f.path);
      if (typeof f.blob !== 'string' || !/^[0-9a-f]{40}$/.test(f.blob)) findings.push({ kind: 'manifest', profile: id, path: f.path, detail: 'blob is not a full object name' });
      if (!Number.isInteger(f.bytes) || f.bytes < 0) findings.push({ kind: 'manifest', profile: id, path: f.path, detail: 'bytes is not a non-negative integer' });
    }
  }
  return findings;
}

export function verifyManifest(repoRoot, manifest) {
  const shape = validateManifestShape(manifest);
  if (shape.length > 0) return { ran: true, reason: null, findings: shape };

  const availability = commitAvailable(repoRoot, manifest.commit);
  if (!availability.ok) return { ran: false, reason: availability.reason, findings: [] };

  const fresh = buildManifest(repoRoot, manifest.commit);
  const findings = [];
  const profileIds = new Set([...Object.keys(fresh.profiles), ...Object.keys(manifest.profiles ?? {})]);

  for (const id of [...profileIds].sort()) {
    const want = manifest.profiles?.[id];
    const have = fresh.profiles[id];
    if (!want) { findings.push({ kind: 'membership', profile: id, detail: 'profile present in the tree but absent from the manifest' }); continue; }
    if (!have) { findings.push({ kind: 'membership', profile: id, detail: 'profile recorded in the manifest but no longer defined' }); continue; }

    const wantByPath = new Map(want.files.map((f) => [f.path, f]));
    const haveByPath = new Map(have.files.map((f) => [f.path, f]));
    for (const path of [...haveByPath.keys()].sort()) {
      if (!wantByPath.has(path)) findings.push({ kind: 'membership', profile: id, path, detail: 'file is in the corpus at this commit but not in the manifest' });
    }
    for (const path of [...wantByPath.keys()].sort()) {
      const w = wantByPath.get(path);
      const h = haveByPath.get(path);
      if (!h) { findings.push({ kind: 'membership', profile: id, path, detail: 'file is in the manifest but not in the corpus at this commit' }); continue; }
      if (w.blob !== h.blob) findings.push({ kind: 'content', profile: id, path, detail: `manifest records blob ${w.blob}, tree has ${h.blob}` });
      else if (w.bytes !== h.bytes) findings.push({ kind: 'content', profile: id, path, detail: `manifest records ${w.bytes} bytes, tree has ${h.bytes}` });
    }
  }
  return { ran: true, reason: null, findings };
}

function readManifest(repoRoot, path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

/**
 * Strict flag read.
 *
 * A missing VALUE is an error, not a fallback. The lenient form silently made
 * `verify --manifest` check the default manifest and `pin --commit` pin HEAD —
 * both of which look like the operator's intent being honoured and are not
 * (cross-host review finding).
 */
function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function summarize(manifest) {
  return Object.entries(manifest.profiles)
    .map(([id, p]) => `${id}: ${p.files.length} file(s), ${p.files.reduce((a, f) => a + (f.bytes ?? 0), 0)} bytes`)
    .join('\n  ');
}

export function main(argv, repoRoot = process.cwd()) {
  const command = argv[0] ?? 'verify';
  let manifestPath;
  try {
    manifestPath = flag(argv, '--manifest', MANIFEST_PATH);
  } catch (err) {
    console.error(`evidenceCorpus: ${err.message}`);
    return 1;
  }

  if (command === 'pin') {
    let commit; let out;
    try {
      commit = flag(argv, '--commit', null);
      out = flag(argv, '--out', MANIFEST_PATH);
    } catch (err) {
      console.error(`evidenceCorpus: ${err.message}`);
      return 1;
    }
    // `--commit` has NO default. A bare `pin` used to resolve HEAD and overwrite
    // the tracked manifest, after which `verify` reported "no drift" against the
    // new baseline — a rebaseline as a side effect of running a tool, which
    // contract §10.2 rule 2 forbids. The earlier fix closed only the
    // flag-present-but-valueless case and left this mirror live (cross-host
    // review finding, reproduced: 2cb9637/76 files became c1444e1/78 files).
    if (commit === null) {
      console.error('evidenceCorpus: pin requires an explicit --commit <rev>.');
      console.error('  Re-pinning is deliberate and owner-authorised (contract §10.2 rule 2); it is never a default.');
      return 1;
    }
    // The corpus is a FIXED HISTORICAL FREEZE, not a pin that tracks the
    // integration branch, and this guard is what makes that executable rather
    // than merely stated.
    //
    // Two independent reasons it must be frozen. The measurement one: the
    // exporter, the oracle and their comparison are authored days apart, and a
    // pin that followed `main` would have them measure different corpora — the
    // comparison would then be reporting drift in the repository, not in the
    // two lanes, which is the one thing it must never do. The self-reference
    // one: the normative contract and its rationale are markdown under `docs/`,
    // so `isShaCorpusFile` admits them, and re-pinning after they land would
    // pull the document that DESCRIBES the corpus into the corpus it describes,
    // making its own worked examples measurable occurrences.
    //
    // So a re-pin is an owner decision with consequences for every later lane,
    // and it has to look like one at the command line. Overwriting an existing
    // manifest requires `--rebaseline`; the first pin does not.
    const outPath = resolve(repoRoot, out);
    const rebaseline = argv.includes('--rebaseline');
    const availability = commitAvailable(repoRoot, commit);
    if (!availability.ok) { console.error(`evidenceCorpus: cannot pin — ${availability.reason}`); return 1; }
    const manifest = buildManifest(repoRoot, commit);
    // Validate what is about to be WRITTEN, not only what is later read. `pin`
    // used to hand `buildManifest` output straight to the filesystem, so a
    // manifest the read path would reject — a duplicate membership entry, say —
    // was still written and exited 0, and the operator learned about it only on
    // the next `verify` (cross-host review finding).
    //
    // DORMANT, deliberately, and stated rather than covered: with the byte
    // check above in place there is no longer an input that reaches here
    // shape-invalid. `buildManifest` throws on an empty profile before
    // returning, the duplicate-path route was only ever reachable through the
    // lossy UTF-8 decode that now refuses, and every remaining field is
    // constructed rather than parsed. Removing this block breaks no test, and
    // the sibling test 'a manifest pin cannot produce a shape-invalid manifest'
    // pins that reasoning so it is re-read rather than assumed if the builder
    // ever stops throwing first.
    const shape = validateManifestShape(manifest);
    if (shape.length > 0) {
      console.error(`evidenceCorpus: refusing to write an invalid manifest for ${commit}`);
      for (const f of shape) console.error(`  [${f.kind}] ${f.profile ?? '-'}${f.path ? ` ${f.path}` : ''}: ${f.detail}`);
      return 1;
    }
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    // Exclusive create, not check-then-write. `existsSync` followed by a
    // truncating write is a TOCTOU gap wide enough to matter here: the check and
    // the write are separated by commit validation and a full tree walk, and two
    // concurrent first pins were measured to both pass the check and both write,
    // one trial leaving unparsable interleaved JSON. `wx` makes the refusal the
    // filesystem's job, so there is no window at all.
    if (!rebaseline) {
      try {
        writeFileSync(outPath, body, { flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        console.error(`evidenceCorpus: ${out} already pins a corpus; refusing to overwrite it.`);
        console.error('  The corpus is a fixed historical freeze — later lanes compare against THIS pin.');
        console.error('  A deliberate rebaseline is `pin --commit <rev> --rebaseline` (contract §10.2 rule 2).');
        return 1;
      }
    } else {
      writeFileSync(outPath, body);
    }
    console.log(`evidenceCorpus: pinned ${manifest.commit} → ${out}\n  ${summarize(manifest)}`);
    return 0;
  }

  if (command === 'show') {
    const manifest = readManifest(repoRoot, manifestPath);
    // `show` is display-only, but a display that renders a meaningless
    // manifest without complaint is how a bad pin survives review.
    const shape = validateManifestShape(manifest);
    if (shape.length > 0) {
      console.error(`evidenceCorpus: ${manifestPath} is not a valid manifest`);
      for (const f of shape) console.error(`  [${f.kind}] ${f.profile ?? '-'}${f.path ? ` ${f.path}` : ''}: ${f.detail}`);
      return 1;
    }
    console.log(`evidenceCorpus: ${manifestPath} pins ${manifest.commit}\n  ${summarize(manifest)}`);
    return 0;
  }

  if (command === 'verify') {
    const manifest = readManifest(repoRoot, manifestPath);
    const result = verifyManifest(repoRoot, manifest);
    if (!result.ran) {
      console.error(`evidenceCorpus: NOT RUN — ${result.reason}`);
      console.error('  A corpus check that silently no-ops reads as coverage. Failing instead.');
      return 1;
    }
    if (result.findings.length === 0) {
      console.log(`evidenceCorpus: ${manifest.commit} — no drift\n  ${summarize(manifest)}`);
      return 0;
    }
    console.error(`evidenceCorpus: ${result.findings.length} drift finding(s) against ${manifest.commit}`);
    for (const f of result.findings) console.error(`  [${f.kind}] ${f.profile}${f.path ? ` ${f.path}` : ''}: ${f.detail}`);
    console.error('  Contract §10.2: a measurement in flight completes against its own pin or aborts; re-pinning is deliberate and owner-authorised. A mismatched pin is §8.2 not-comparable.');
    return 1;
  }

  console.error(`evidenceCorpus: unknown command "${command}" (expected pin | verify | show)`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => { process.exitCode = main(process.argv.slice(2)); })();
}
