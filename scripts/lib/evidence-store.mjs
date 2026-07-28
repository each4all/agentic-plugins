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
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { checkSchemaShape, loadSchema, provenanceOf, validateInstance } from './evidence-schema.mjs';

/**
 * How the checker honours an `observed` declaration on a `proofs[]` field.
 *
 * EXTRACTORS pull the value out of the doctor artifact and compare it; the
 * artifact is JSON, so where a field has a single unambiguous counterpart
 * there is no reason to leave the transcription unchecked — an unchecked copy
 * is the defect this store exists to remove.
 *
 * POINTER_ONLY names the observed fields with no single counterpart (per-host
 * install state has none in the artifact's per-plugin structure). Those rest
 * on the run id plus the content hash, which is precisely the assurance
 * Decision 4 claims for observed fields — no more, and it is stated rather
 * than implied.
 *
 * Every `observed` field must appear in exactly one of the two. An observed
 * field in neither is a META-finding, which is what makes the declaration
 * load-bearing: reclassifying `command` to `observed` now fails the gate
 * instead of changing nothing.
 */
const PROOF_EXTRACTORS = {
  run_id: (a) => a.run_id,
  runtime_version: (a) => a.runtime_version,
  date: (a) => (typeof a.created_at === 'string' ? a.created_at.slice(0, 10) : undefined),
};
const PROOF_POINTER_ONLY = new Set(['artifact_sha256', 'installed', 'host_cli', 'readings']);

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

/**
 * Record stems present at the integration base — the floor the working tree may
 * not fall below. Returns null when the base cannot be read at all, which is a
 * fail-closed condition rather than "no floor": an unreadable base and an empty
 * base look identical from here, and only one of them is safe.
 */
export function baseRecordStems(repoRoot, base) {
  const out = gitOrNull(repoRoot, ['ls-tree', '-r', '--name-only', base, '--', `${RECORDS_DIR}/`]);
  if (out === null) return null;
  return new Set(
    out.split('\n').filter((line) => line.endsWith('.json')).map((line) => basename(line, '.json')),
  );
}

/** Records live at `<RECORDS_DIR>/<record_id>.json`. A missing directory is an empty store, not an error. */
export function loadRecords(repoRoot) {
  const dir = resolve(repoRoot, RECORDS_DIR);
  const records = [];
  const parseFindings = [];
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    // ENOENT is an empty store, which is the normal state until the first
    // release loop after the schema. Anything else is a real fault and must be
    // a FINDING rather than an exception: an uncaught throw here aborted
    // `validate:doc-evidence` before the three prose gates could report, so an
    // unreadable store directory suppressed checks that have nothing to do
    // with it (cross-host review finding).
    if (err.code === 'ENOENT') return { records: [], parseFindings: [] };
    return {
      records: [],
      parseFindings: [{ check: 'store', file: RECORDS_DIR, detail: `records directory is unreadable (${err.code}): ${err.message}` }],
    };
  }
  for (const file of entries) {
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

  // Resolve through refs/tags explicitly. `rev-parse <name>^{commit}` also
  // resolves a BRANCH of that name, so a branch could stand in for a deleted
  // tag and the whole record would pass (cross-host review finding); ADR-0049
  // §Decision 4 names `git for-each-ref` for this reason.
  const tagCommit = gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])?.trim();
  if (!tagCommit) {
    findings.push({ check: 'derived', path: `${at}.tag`, detail: `no tag \`refs/tags/${tag}\` exists in git` });
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

  const sync = entry.marketplace_sync ?? null;
  if (sync) {
    findings.push(...checkMarketplaceSync(repoRoot, tagCommit, sync, `${at}.marketplace_sync`, tag, ctx));
  } else {
    // A null sync is a CLAIM ("this release had no catalog sync"), and it is
    // checkable: if a catalog-sync commit sits in this release's window, the
    // claim is false. Leaving it unchecked would make omission a way around
    // the relation check above, the same dodge the attested-PR rule closes.
    const orphan = findSyncInWindow(repoRoot, tagCommit, ctx);
    if (orphan) {
      findings.push({
        check: 'derived',
        path: `${at}.marketplace_sync`,
        detail: `record claims ${tag} had no marketplace sync, but ${orphan} is a catalog sync in its window`,
      });
    }
  }

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
  // Omitting BOTH was the third way around this check: a derivable PR number
  // simply left unrecorded (cross-host review finding). If the subject carries
  // it, the record must carry it too. If it does not, neither field is
  // required — a commit may genuinely have no PR.
  if (derived === null && attested === null) {
    if (inSubject !== null) {
      findings.push({
        check: 'derived',
        path: `${at}.${derivedKey}`,
        detail: `${label} subject carries #${inSubject} but the record records no PR number — omission is not a third option`,
      });
    }
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
/** The catalog-sync commit in a release's window, if there is one. */
function findSyncInWindow(repoRoot, releaseCommit, ctx) {
  const log = gitOrNull(repoRoot, ['log', '--format=%H%x00%s', `${releaseCommit}..${ctx.base}`]);
  if (log === null) return null;
  // Walk oldest-first so the window closes at the NEXT release, not the last.
  for (const line of log.split('\n').filter(Boolean).reverse()) {
    const [sha, subject] = line.split('\0');
    if (ctx.releaseCommits.has(sha)) return null; // window closed before any sync
    if (/sync catalog versions/i.test(subject ?? '')) return sha;
  }
  return null;
}

function checkMarketplaceSync(repoRoot, releaseCommit, sync, at, tag, ctx) {
  const findings = [];
  if (!gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `${sync}^{commit}`])) {
    return [{ check: 'derived', path: at, detail: `marketplace sync ${sync} does not resolve` }];
  }
  // Reachability, for the same reason commit entries need it: a locally minted
  // commit parented to the release satisfies ancestry and subject while
  // existing on no remote branch (cross-host review finding).
  if (gitOrNull(repoRoot, ['merge-base', '--is-ancestor', sync, ctx.base]) === null) {
    return [{ check: 'derived', path: at, detail: `marketplace sync ${sync} is not reachable from ${ctx.base}` }];
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
export function checkProof(repoRoot, proof, at, observedFields = null) {
  const findings = [];
  const artifact = resolve(repoRoot, DOCTOR_RUNS, proof.run_id, 'doctor.json');

  // Read first and classify by errno. `existsSync` cannot tell absence from an
  // unreadable parent directory — it answers false for a real doctor.json
  // under a non-traversable directory, so a permissions fault reported as the
  // ordinary absent-in-CI case (cross-host review finding).
  let bytes;
  try {
    bytes = readFileSync(artifact);
  } catch (err) {
    if (err.code === 'ENOENT') return { findings, status: 'unverified' };
    findings.push({
      check: 'observed',
      path: `${at}.artifact_sha256`,
      detail: `artifact for ${proof.run_id} is present but unreadable (${err.code}): ${err.message}`,
    });
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

  // The hash pins the bytes; it does not pin the transcription. Compare every
  // observed field the artifact can answer for.
  let parsed = null;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    findings.push({ check: 'observed', path: at, detail: `artifact for ${proof.run_id} is not parseable JSON: ${err.message}` });
    return { findings, status: 'failed' };
  }
  for (const [field, extract] of Object.entries(PROOF_EXTRACTORS)) {
    if (observedFields && observedFields[field] !== 'observed') continue;
    if (!Object.hasOwn(proof, field)) continue;
    const fromArtifact = extract(parsed);
    if (fromArtifact !== proof[field]) {
      findings.push({
        check: 'observed',
        path: `${at}.${field}`,
        detail: `artifact says ${JSON.stringify(fromArtifact)}, record says ${JSON.stringify(proof[field])}`,
      });
    }
  }
  return { findings, status: findings.length > 0 ? 'failed' : 'verified' };
}

/**
 * The declaration must match what the checker can do with it.
 *
 * Without this the provenance classes are decoration: a field can be relabelled
 * `observed` and nothing changes. Here, relabelling puts it in neither the
 * extractor table nor the pointer-only set, and the gate says so.
 */
function checkProvenanceContract(schema) {
  const findings = [];
  const classes = provenanceOf(schema, 'proof');
  for (const [field, cls] of Object.entries(classes)) {
    if (cls !== 'observed') continue;
    if (!Object.hasOwn(PROOF_EXTRACTORS, field) && !PROOF_POINTER_ONLY.has(field)) {
      findings.push({
        check: 'provenance',
        path: `$defs.proof.properties.${field}`,
        detail: `declared \`observed\` but the checker can neither extract it from the doctor artifact nor account for it as pointer-only — add an extractor, list it pointer-only, or reclassify the field`,
      });
    }
  }
  for (const field of [...Object.keys(PROOF_EXTRACTORS), ...PROOF_POINTER_ONLY]) {
    if (classes[field] !== undefined && classes[field] !== 'observed') {
      findings.push({
        check: 'provenance',
        path: `$defs.proof.properties.${field}`,
        detail: `the checker treats this as observed evidence, but the schema declares it \`${classes[field]}\``,
      });
    }
  }
  return findings;
}

// --- structure ---------------------------------------------------------------

function pushDuplicates(findings, values, { check, label }) {
  const seen = new Set();
  for (const { value, at } of values) {
    if (seen.has(value)) findings.push({ check, path: at, detail: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}

function checkStructure(records) {
  const findings = [];
  const byId = new Map();

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

    // Deliberately NO cross-record uniqueness — not for releases, commits, or
    // proofs. An earlier draft made a release belong to exactly one record;
    // ADR-0049 Context constraint 1 says the opposite in as many words ("a
    // single release can carry several records (2026-07-20 alone carries
    // four)"), so that rule contradicted the decision it was implementing.
    // Duplicate rejection is therefore WITHIN a record, where it means an
    // authoring slip rather than a judgement about loop boundaries.

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
export function checkStore(repoRoot, opts = {}) {
  const injected = opts.records ?? null;
  const schema = loadSchema(resolve(repoRoot, SCHEMA_PATH));
  const findings = [...checkSchemaShape(schema), ...checkProvenanceContract(schema)];

  const loaded = injected ? { records: injected, parseFindings: [] } : loadRecords(repoRoot);
  findings.push(...loaded.parseFindings);

  for (const { file, data } of loaded.records) {
    findings.push(...validateInstance(data, schema, { path: file }).map((f) => ({ ...f, file })));
  }
  findings.push(...checkStructure(loaded.records));

  // FORWARD-ONLY FLOOR. Everything below this point is per-record, so with no
  // records there is nothing to check and the early return reports green — which
  // is correct for the pre-first-record state and wrong for every state after
  // it. Once a record exists, an emptied store, a record deleted by hand, and a
  // sparse loss in a bad merge all reduce to that same green. The floor is the
  // record set on the integration branch: the store is append-only by
  // construction (ADR-0049 forward-only), so anything present there and absent
  // here is a loss, whatever the working tree's count happens to be. Deriving it
  // from git rather than a committed count means it maintains itself and cannot
  // drift. Injected records are a unit-test seam with no working tree behind
  // them, so they carry no floor unless one is supplied.
  // `floor` is read by PRESENCE, not by truthiness: `null` is the meaningful
  // value baseRecordStems returns for an unreadable base, so `?? default` would
  // quietly convert the fail-closed case into "no floor" — the exact collapse
  // this check exists to prevent.
  const floorStems = Object.hasOwn(opts, 'floor')
    ? opts.floor
    : (injected ? new Set() : baseRecordStems(repoRoot, reachabilityBase(repoRoot)));
  if (floorStems === null) {
    findings.push({
      check: 'store',
      file: RECORDS_DIR,
      detail: `the integration base could not be read, so the forward-only floor could not be established; an unreadable base is indistinguishable from an empty one, and only one of those is safe (fetch the integration branch before running this check)`,
    });
  } else {
    const present = new Set(loaded.records.map((r) => r.stem));
    for (const stem of [...floorStems].sort()) {
      if (present.has(stem)) continue;
      findings.push({
        check: 'store',
        file: `${RECORDS_DIR}/${stem}.json`,
        detail: 'record exists on the integration branch but is absent from the working tree — the evidence store is forward-only, so records are never removed',
      });
    }
  }

  const proofStatus = { verified: 0, unverified: 0, failed: 0 };
  if (loaded.records.length === 0) {
    return { ran: true, reason: null, findings, records: 0, proofStatus, base: null };
  }

  // The environment check comes BEFORE the structural early return. A shallow
  // clone is a fact about the run, not about a record, and reporting only a
  // filename typo while silently skipping every git check would understate
  // what did not happen (cross-host review finding).
  const availability = historyAvailable(repoRoot);
  if (!availability.ok) {
    return { ran: false, reason: availability.reason, findings, records: loaded.records.length, proofStatus, base: null };
  }

  // Structural problems make the git-backed checks meaningless and noisy, so
  // stop before them rather than emitting cascade failures. This can only
  // under-report: the findings that triggered it still fail the run.
  if (findings.length > 0) {
    return { ran: true, reason: null, findings, records: loaded.records.length, proofStatus, base: null };
  }

  const base = reachabilityBase(repoRoot);
  // Release commits come from TAG REFS, across every package. A grep for the
  // release subject matched the commit BODY too — newly dangerous now that
  // squash bodies are PR bodies — and was blind to any release that did not
  // use the conventional subject. It also has to span all packages: an
  // attention-only release sitting between a runtime release and its sync is
  // an intervening release, and a runtime-only set cannot see it.
  const releaseCommits = new Set(
    (gitOrNull(repoRoot, ['for-each-ref', '--format=%(objectname)%00%(*objectname)', 'refs/tags/']) ?? '')
      .split('\n').filter(Boolean)
      .map((line) => { const [obj, deref] = line.split('\0'); return deref || obj; }),
  );
  const ctx = { base, releaseCommits };
  const observedFields = provenanceOf(schema, 'proof');

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
      const result = checkProof(repoRoot, proof, `${file}#proofs[${i}]`, observedFields);
      findings.push(...result.findings);
      proofStatus[result.status] += 1;
    }
  }

  return { ran: true, reason: null, findings, records: loaded.records.length, proofStatus, base };
}
