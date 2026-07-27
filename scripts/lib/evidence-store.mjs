// ADR-0049 evidence store — record loading and validation.
//
// The store is forward-only and the prose is untouched (Decision 5), so this
// module validates ONLY what a source can back (Decision 4, as amended
// 2026-07-27):
//
//   derived           → checked against git and the release configuration,
//                       everywhere including CI.
//   observed          → checked against the doctor artifact when it is present;
//                       reported `unverified` when it is absent, because
//                       `.agentic-plugins/runs/` is gitignored and
//                       retention-pruned so CI has no artifacts. A present but
//                       unreadable or mismatched artifact FAILS — degrading
//                       that to `unverified` would let corruption read as the
//                       ordinary CI case.
//   operator-attested → never checked. `proofs[].command` and
//                       `install_method` are statements, not observations.
//   authored          → never checked. That includes MEMBERSHIP of every
//                       per-loop array: no source states which commits or
//                       releases a loop should contain, and a check that
//                       inferred it would re-create the reconstruction failure
//                       the ADR exists to stop.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { checkSchemaShape, loadSchema, validateInstance } from './evidence-schema.mjs';

export const STORE_DIR = 'docs/assurance/evidence';
export const RECORDS_DIR = `${STORE_DIR}/records`;
export const SCHEMA_PATH = `${STORE_DIR}/schema/evidence-record-1.0.json`;
const MANIFEST = '.release-please-manifest.json';
const RELEASE_CONFIG = 'release-please-config.json';
const DOCTOR_RUNS = '.agentic-plugins/runs/doctor';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOrNull(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/**
 * Full history with tags, or nothing.
 *
 * A depth-1 checkout makes every git-backed check vacuously pass, which reads
 * as coverage while asserting nothing. Callers FAIL on this rather than skip.
 */
export function historyAvailable(repoRoot) {
  const shallow = gitOrNull(repoRoot, ['rev-parse', '--is-shallow-repository']);
  if (shallow === null) return { ok: false, reason: 'git is not usable in this checkout' };
  if (shallow.trim() === 'true') {
    return { ok: false, reason: 'repository is a shallow clone — check out with fetch-depth: 0 so tags and history are present' };
  }
  const tags = gitOrNull(repoRoot, ['tag', '--list']);
  if (tags === null || tags.split('\n').filter(Boolean).length === 0) {
    return { ok: false, reason: 'no tags are present — fetch tags (fetch-depth: 0) before running this check' };
  }
  return { ok: true, reason: null };
}

/** Prefer the integration branch over HEAD; a PR merge ref contains the PR's own commits. */
export function reachabilityBase(repoRoot) {
  for (const candidate of ['origin/main', 'main']) {
    if (gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])) return candidate;
  }
  return 'HEAD';
}

/** Records live at `<RECORDS_DIR>/<record_id>.json`. A missing directory is an empty store, not an error. */
export function loadRecords(repoRoot) {
  const dir = resolve(repoRoot, RECORDS_DIR);
  if (!existsSync(dir)) return { records: [], parseFindings: [] };
  const records = [];
  const parseFindings = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) {
      parseFindings.push({ check: 'store', file: `${RECORDS_DIR}/${file}`, detail: 'non-JSON file in the records directory' });
      continue;
    }
    const path = join(dir, file);
    let data;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      parseFindings.push({ check: 'store', file: `${RECORDS_DIR}/${file}`, detail: `unparseable JSON: ${err.message}` });
      continue;
    }
    records.push({ file: `${RECORDS_DIR}/${file}`, stem: basename(file, '.json'), data });
  }
  return { records, parseFindings };
}

// --- derived: the release configuration as it stood at the tag ---------------

function readAtTag(repoRoot, tag, path) {
  const raw = gitOrNull(repoRoot, ['show', `${tag}:${path}`]);
  if (raw === null) return { ok: false, reason: `\`${path}\` is not readable at tag ${tag}` };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: `\`${path}\` at tag ${tag} is unparseable: ${err.message}` };
  }
}

/**
 * The tag a package's release MUST carry, read from the release configuration
 * AT THE TAG.
 *
 * Necessary because tags are per-package but commits are not:
 * `plugin-runtime-v0.83.0` and `plugin-attention-v0.6.0` are the same commit,
 * so the manifest read at either reports runtime 0.83.0 and a bare tag-time
 * version comparison accepts the wrong package's tag (Amendment item 2).
 * Fails closed — a missing tag, file, or key is a finding, never a skip.
 */
function expectedTag(repoRoot, tag, pkg) {
  const config = readAtTag(repoRoot, tag, RELEASE_CONFIG);
  if (!config.ok) return { ok: false, reason: config.reason };
  const entry = config.value?.packages?.[pkg];
  if (!entry) return { ok: false, reason: `\`${pkg}\` is not a release-please package at tag ${tag}` };
  const component = entry.component ?? entry['package-name'];
  if (!component) return { ok: false, reason: `\`${pkg}\` declares no component at tag ${tag}` };
  return { ok: true, component };
}

function checkPackageRelease(repoRoot, entry, at, ctx) {
  const findings = [];
  const { tag, package: pkg, version, squash } = entry;

  const tagCommit = gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`])?.trim();
  if (!tagCommit) {
    findings.push({ check: 'derived', path: `${at}.tag`, detail: `tag ${tag} does not exist in git` });
    return findings; // every other derived check on this entry is anchored to the tag
  }
  if (tagCommit !== squash) {
    findings.push({ check: 'derived', path: `${at}.squash`, detail: `tag ${tag} is commit ${tagCommit}, not ${squash}` });
  }

  const expected = expectedTag(repoRoot, tag, pkg);
  if (!expected.ok) {
    findings.push({ check: 'derived', path: `${at}.package`, detail: expected.reason });
  } else if (tag !== `${expected.component}-v${version}`) {
    findings.push({
      check: 'derived',
      path: `${at}.tag`,
      detail: `\`${pkg}\` at version ${version} must be tagged ${expected.component}-v${version}, but the record cites ${tag}`,
    });
  }

  const manifest = readAtTag(repoRoot, tag, MANIFEST);
  if (!manifest.ok) {
    findings.push({ check: 'derived', path: `${at}.version`, detail: manifest.reason });
  } else {
    const atTag = manifest.value?.[pkg];
    if (atTag === undefined) {
      findings.push({ check: 'derived', path: `${at}.version`, detail: `\`${pkg}\` has no manifest entry at tag ${tag}` });
    } else if (atTag !== version) {
      findings.push({
        check: 'derived',
        path: `${at}.version`,
        detail: `manifest at ${tag} reports \`${pkg}\` ${atTag}, record says ${version}`,
      });
    }
  }

  // PR number: derived when the tagged commit's subject carries it, attested
  // otherwise. Attestation must not be a way around a check that WOULD run.
  const subject = (gitOrNull(repoRoot, ['log', '-1', '--format=%s', tagCommit]) ?? '').trim();
  findings.push(...checkPrPair(entry, subject, at, 'release_pr', 'release_pr_attested', `release commit ${tagCommit.slice(0, 7)}`));

  const sync = entry.marketplace_sync;
  if (sync) findings.push(...checkMarketplaceSync(repoRoot, tagCommit, sync, `${at}.marketplace_sync`, tag, ctx));

  return findings;
}

/** `(#N)` at the end of a conventional commit subject. */
function prFromSubject(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

function checkPrPair(entry, subject, at, derivedKey, attestedKey, label) {
  const findings = [];
  const derived = entry[derivedKey] ?? null;
  const attested = entry[attestedKey] ?? null;
  const inSubject = prFromSubject(subject);

  if (derived !== null && attested !== null) {
    findings.push({ check: 'structure', path: `${at}.${derivedKey}`, detail: `${derivedKey} and ${attestedKey} are mutually exclusive` });
    return findings;
  }
  if (derived !== null) {
    if (inSubject === null) {
      findings.push({
        check: 'derived',
        path: `${at}.${derivedKey}`,
        detail: `${label} subject carries no \`(#N)\`, so the PR number is not derivable — record it as ${attestedKey}`,
      });
    } else if (inSubject !== derived) {
      findings.push({ check: 'derived', path: `${at}.${derivedKey}`, detail: `${label} subject says #${inSubject}, record says #${derived}` });
    }
  }
  if (attested !== null && inSubject !== null) {
    findings.push({
      check: 'structure',
      path: `${at}.${attestedKey}`,
      detail: `${label} subject does carry #${inSubject}, so this is derivable — use ${derivedKey}; attestation must not step around a check that would have run`,
    });
  }
  return findings;
}

/**
 * The sync commit belonging to a release: a descendant of it, with no other
 * release commit in between, whose own subject is a catalog sync.
 *
 * Descendancy alone lets any later sync satisfy an older claim; parentage
 * alone lets an unrelated commit that happens to sit between them pass. Both
 * failure modes were observed on the prose gate before it checked all three.
 */
function checkMarketplaceSync(repoRoot, releaseCommit, sync, at, tag, ctx) {
  const findings = [];
  if (!gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `${sync}^{commit}`])) {
    return [{ check: 'derived', path: at, detail: `marketplace sync ${sync} does not resolve` }];
  }
  if (gitOrNull(repoRoot, ['merge-base', '--is-ancestor', releaseCommit, sync]) === null) {
    return [{ check: 'derived', path: at, detail: `marketplace sync ${sync} is not a descendant of ${tag}'s release commit` }];
  }
  const between = (gitOrNull(repoRoot, ['rev-list', `${releaseCommit}..${sync}`]) ?? '').split('\n').filter(Boolean);
  const intervening = between.filter((c) => ctx.releaseCommits.has(c));
  if (intervening.length > 0) {
    findings.push({
      check: 'derived',
      path: at,
      detail: `${intervening.length} later release commit(s) sit between ${tag} and ${sync} — that sync belongs to a different release`,
    });
    return findings;
  }
  const subject = (gitOrNull(repoRoot, ['log', '-1', '--format=%s', sync]) ?? '').trim();
  if (!/sync catalog versions/i.test(subject)) {
    findings.push({ check: 'derived', path: at, detail: `${sync} is cited as a marketplace sync but its subject is "${subject}"` });
  }
  return findings;
}

function checkCommitEntry(repoRoot, entry, at, ctx) {
  const findings = [];
  const { sha } = entry;
  if (!gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])) {
    findings.push({ check: 'derived', path: `${at}.sha`, detail: `${sha} does not resolve to a commit` });
    return findings;
  }
  // Reachability, not object existence: a squash-deleted branch commit still
  // resolves in the clone that authored it and in no other.
  if (gitOrNull(repoRoot, ['merge-base', '--is-ancestor', sha, ctx.base]) === null) {
    findings.push({ check: 'derived', path: `${at}.sha`, detail: `${sha} resolves but is not reachable from ${ctx.base}` });
    return findings;
  }
  const subject = (gitOrNull(repoRoot, ['log', '-1', '--format=%s', sha]) ?? '').trim();
  findings.push(...checkPrPair(entry, subject, at, 'pr', 'pr_attested', `commit ${sha.slice(0, 7)}`));
  return findings;
}

/**
 * Observed: the doctor artifact, when this machine still has it.
 *
 * Returns a per-proof status so the caller can report how much of the store was
 * actually verified rather than implying it all was.
 */
export function checkProof(repoRoot, proof, at) {
  const findings = [];
  const artifact = resolve(repoRoot, DOCTOR_RUNS, proof.run_id, 'doctor.json');
  if (!existsSync(artifact)) {
    return { findings, status: 'unverified' };
  }
  let bytes;
  try {
    bytes = readFileSync(artifact);
  } catch (err) {
    // Present but unreadable is corruption or a permissions fault, not the
    // ordinary absent-in-CI case. Failing here is the point.
    findings.push({ check: 'observed', path: `${at}.artifact_sha256`, detail: `artifact for ${proof.run_id} exists but is unreadable: ${err.message}` });
    return { findings, status: 'failed' };
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== proof.artifact_sha256) {
    findings.push({
      check: 'observed',
      path: `${at}.artifact_sha256`,
      detail: `artifact for ${proof.run_id} hashes to ${actual}, record says ${proof.artifact_sha256}`,
    });
    return { findings, status: 'failed' };
  }
  return { findings, status: 'verified' };
}

// --- structure ---------------------------------------------------------------

function pushDuplicates(findings, values, { check, path, label }) {
  const seen = new Set();
  for (const { value, at } of values) {
    if (seen.has(value)) findings.push({ check, path: at ?? path, detail: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}

function checkStructure(records) {
  const findings = [];
  const byId = new Map();
  const tagOwner = new Map();

  for (const { file, stem, data } of records) {
    const id = data.record_id;
    if (id !== stem) {
      findings.push({ check: 'structure', path: file, detail: `record_id \`${id}\` does not match filename stem \`${stem}\`` });
    }
    if (byId.has(id)) {
      findings.push({ check: 'structure', path: file, detail: `record_id \`${id}\` is already used by ${byId.get(id)}` });
    } else {
      byId.set(id, file);
    }

    pushDuplicates(findings, (data.package_releases ?? []).map((r, i) => ({ value: r.tag, at: `${file}#package_releases[${i}]` })), { check: 'structure', label: 'release tag' });
    pushDuplicates(findings, (data.proofs ?? []).map((p, i) => ({ value: p.run_id, at: `${file}#proofs[${i}]` })), { check: 'structure', label: 'proof run id' });
    // Both commit arrays share one namespace: the same commit cannot be both a
    // feature and a hardening commit of the same loop.
    pushDuplicates(
      findings,
      [
        ...(data.feature_commits ?? []).map((c, i) => ({ value: c.sha, at: `${file}#feature_commits[${i}]` })),
        ...(data.hardening_commits ?? []).map((c, i) => ({ value: c.sha, at: `${file}#hardening_commits[${i}]` })),
      ],
      { check: 'structure', label: 'commit sha' },
    );

    // Cross-record: a release belongs to exactly one loop. Commits and proofs
    // are deliberately NOT checked across records — nothing in the ADR says a
    // commit cannot be cited by two loops, and inventing that rule here would
    // be the same over-reach as gating array completeness.
    for (const [i, rel] of (data.package_releases ?? []).entries()) {
      const owner = tagOwner.get(rel.tag);
      if (owner && owner !== file) {
        findings.push({ check: 'structure', path: `${file}#package_releases[${i}]`, detail: `release ${rel.tag} is already claimed by ${owner}` });
      } else {
        tagOwner.set(rel.tag, file);
      }
    }

    for (const [i, rel] of (data.relations ?? []).entries()) {
      if (rel.record_id === id) {
        findings.push({ check: 'structure', path: `${file}#relations[${i}]`, detail: 'relation points at its own record' });
      }
    }
  }

  // Dangling targets, once every id is known. Pre-store loops are not valid
  // targets: a typed relation to prose would be exactly the unbackable link
  // the store exists to avoid. Migration (Decision 6) is what makes them
  // addressable.
  for (const { file, data } of records) {
    for (const [i, rel] of (data.relations ?? []).entries()) {
      if (rel.record_id !== data.record_id && !byId.has(rel.record_id)) {
        findings.push({
          check: 'structure',
          path: `${file}#relations[${i}]`,
          detail: `relation target \`${rel.record_id}\` is not a record in this store`,
        });
      }
    }
  }
  return findings;
}

// --- entry point --------------------------------------------------------------

/**
 * Validate the whole store.
 *
 * `ran: false` means the environment could not support the checks (shallow
 * clone). That is reported as a failure by the CLI, not a pass.
 */
export function checkStore(repoRoot, { records: injected = null } = {}) {
  const schema = loadSchema(resolve(repoRoot, SCHEMA_PATH));
  const schemaFindings = checkSchemaShape(schema);

  const loaded = injected ? { records: injected, parseFindings: [] } : loadRecords(repoRoot);
  const findings = [...schemaFindings, ...loaded.parseFindings];

  for (const { file, data } of loaded.records) {
    findings.push(...validateInstance(data, schema, { path: file }).map((f) => ({ ...f, file })));
  }
  findings.push(...checkStructure(loaded.records));

  // Structural problems make git-backed checks meaningless (and noisy), so
  // stop before them rather than reporting cascade failures.
  const proofStatus = { verified: 0, unverified: 0, failed: 0 };
  if (findings.length > 0) {
    return { ran: true, reason: null, findings, records: loaded.records.length, proofStatus, base: null };
  }
  if (loaded.records.length === 0) {
    return { ran: true, reason: null, findings, records: 0, proofStatus, base: null };
  }

  const availability = historyAvailable(repoRoot);
  if (!availability.ok) {
    return { ran: false, reason: availability.reason, findings, records: loaded.records.length, proofStatus, base: null };
  }
  const base = reachabilityBase(repoRoot);
  const releaseCommits = new Set(
    (gitOrNull(repoRoot, ['log', '--format=%H', '--grep', '^chore: release main', base]) ?? '').split('\n').filter(Boolean),
  );
  const ctx = { base, releaseCommits };

  for (const { file, data } of loaded.records) {
    for (const [i, rel] of data.package_releases.entries()) {
      findings.push(...checkPackageRelease(repoRoot, rel, `${file}#package_releases[${i}]`, ctx));
    }
    for (const key of ['feature_commits', 'hardening_commits']) {
      for (const [i, entry] of (data[key] ?? []).entries()) {
        findings.push(...checkCommitEntry(repoRoot, entry, `${file}#${key}[${i}]`, ctx));
      }
    }
    for (const [i, proof] of data.proofs.entries()) {
      const result = checkProof(repoRoot, proof, `${file}#proofs[${i}]`);
      findings.push(...result.findings);
      proofStatus[result.status] += 1;
    }
  }

  return { ran: true, reason: null, findings, records: loaded.records.length, proofStatus, base };
}
