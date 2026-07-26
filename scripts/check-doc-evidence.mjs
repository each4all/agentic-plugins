#!/usr/bin/env node
// Read-only consistency checks over the evidence claims in the stage docs.
// Companion to scripts/sync-doc-versions.mjs: that script DERIVES the
// version tokens the freshness gate gates; this one CHECKS the claims the
// gate cannot see.
//
// Why these three, and why read-only:
//
//   The doc-freshness gate in tests/plugin-shape/test-runtime-plugin.mjs
//   compares version tokens to the manifest. It checks values in
//   isolation, never relations, and it deliberately ignores superseded
//   records (those are de-backticked precisely so they escape it). That
//   leaves two blind spots, both of which have produced real defects:
//
//     - Relations. The 0.86.1 recovery (#640) hand-bumped a tag token but
//       not the PR number and squash sha sitting beside it, leaving
//       `#630` + `82cf981` + `plugin-runtime-v0.86.1` and `#630` +
//       `1b6c569` + `plugin-runtime-v0.86.1` — two combinations that
//       never existed. Every token was individually well-formed, so the
//       gate stayed green through two releases.
//
//     - Superseded records. docs/DEVELOPMENT.md packs 25 doctor run ids
//       into one physical line and the scorecard R3 row packs 20. An
//       error introduced there is invisible to every gate, and the
//       artifacts those ids name are gitignored — so within the repo the
//       docs are the only durable record.
//
//   Both blind spots are checkable but NOT safely rewritable, which is
//   why this file only reads. See the header of sync-doc-versions.mjs for
//   why automated rewriting of run ids and dates was rejected.
//
// Usage:
//   node scripts/check-doc-evidence.mjs            # human-readable report
//   node scripts/check-doc-evidence.mjs --json
//
// Exit codes:
//   0 — no findings
//   1 — findings, or a check could not run (fail-closed)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_DOCS = [
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/assurance/omcc-cutover-scorecard.md',
];

const RUNTIME_CHANGELOG = 'plugins/runtime/CHANGELOG.md';
const DOCTOR_ID = String.raw`doctor-(\d{4})(\d{2})(\d{2})T\d{6}Z-[0-9a-f]+`;

function git(repoRoot, args, input) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', ...(input === undefined ? {} : { input }) });
}

/**
 * Is full git history (with tags) reachable?
 *
 * CI checks out at depth 1 by default, which would make every git-backed
 * check vacuously pass. This is reported so callers can FAIL rather than
 * skip — a check that silently no-ops in CI is worse than no check, since
 * it reads as coverage. `.github/workflows/full-tests.yml` sets
 * fetch-depth: 0 for exactly this reason.
 */
export function gitHistoryAvailable(repoRoot) {
  try {
    const shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim();
    if (shallow === 'true') return { ok: false, reason: 'repository is a shallow clone (fetch-depth: 0 required)' };
    const tags = git(repoRoot, ['tag', '--list', 'plugin-runtime-v*']).split('\n').filter(Boolean);
    if (tags.length === 0) return { ok: false, reason: 'no plugin-runtime-v* tags are present (fetch tags required)' };
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `git is not usable here: ${err.message}` };
  }
}

// `docs` lets tests inject mutated document text while git and the
// manifest still point at the real repository — the only way to prove a
// check bites without fabricating a throwaway git history.
function readDocs(repoRoot, docs) {
  if (docs) return docs;
  return EVIDENCE_DOCS.map((file) => ({ file, text: readFileSync(resolve(repoRoot, file), 'utf8') }));
}

// Hard wraps split nearly every claim across lines. Read-only checks can
// safely flatten newlines to spaces; nothing is written back, so no
// offset must survive.
function flatten(text) {
  return text.replace(/\n>? ?/g, ' ');
}

/**
 * R1 — release-triple relation check.
 *
 * A release triple in prose is (release PR #N, squash/merge sha, tag
 * plugin-runtime-vX[, marketplace sync sha]). The authoritative anchor is
 * the TAG, not the PR number: `git rev-parse plugin-runtime-vX` resolves
 * for every release regardless of how the PR was merged, whereas the PR
 * number only survives in the commit subject for squash merges
 * (`chore: release main (#638)`) and not for older merge-commit releases
 * (`chore: release main`, PR #106). Anchoring on the PR number produced a
 * false positive on #106 during development; anchoring on the tag does
 * not. The PR number is therefore verified opportunistically — when the
 * tagged commit's subject carries `(#N)` — and reported as
 * not-offline-verifiable otherwise instead of failing.
 */
export function checkReleaseTriples(repoRoot, { docs = null } = {}) {
  const availability = gitHistoryAvailable(repoRoot);
  if (!availability.ok) {
    return { ran: false, reason: availability.reason, findings: [], checked: 0, unverifiablePrNumbers: 0 };
  }

  const findings = [];
  let checked = 0;
  let unverifiablePrNumbers = 0;
  // One `for-each-ref` for the whole tag map. Resolving each tag with a
  // separate rev-parse + log cost two subprocesses per tag and made this
  // check dominate the suite's wall clock.
  //
  // `%(*objectname)` / `%(*contents:subject)` are the dereferenced values
  // and are empty for lightweight tags (which is what release-please
  // creates here); the non-starred fields already hold the commit in that
  // case, so prefer the starred value only when present.
  const tagCommit = new Map();
  const tagSubject = new Map();
  const refFormat = '%(refname:short)%00%(objectname:short=7)%00%(*objectname:short=7)%00%(contents:subject)%00%(*contents:subject)';
  for (const line of git(repoRoot, ['for-each-ref', `--format=${refFormat}`, 'refs/tags/plugin-runtime-v*']).split('\n').filter(Boolean)) {
    const [tag, objectSha, derefSha, subject, derefSubject] = line.split('\0');
    tagCommit.set(tag, derefSha || objectSha);
    tagSubject.set(tag, (derefSubject || subject || '').trim());
  }

  for (const { file, text } of readDocs(repoRoot, docs)) {
    const flat = flatten(text);
    // Claims are matched from the tag outward in both directions,
    // because the prose puts the squash before the tag ("squash `X`, tag
    // `Y`") in some places and after it ("cut tag `Y` with marketplace
    // sync `Z`") in others.
    for (const m of flat.matchAll(/`?plugin-runtime-v(\d+\.\d+\.\d+)`?/g)) {
      const version = m[1];
      const tag = `plugin-runtime-v${version}`;
      const before = flat.slice(Math.max(0, m.index - 400), m.index);
      // A release-triple claim is defined by a "release PR #N" mention
      // ahead of the tag; tags are also named in passing elsewhere.
      //
      // Both lookups take the LAST match, not the first. Taking the first
      // produced a false positive during development: the scorecard
      // writes "(feature PR #555 squash `cb720e7`, ...; release PR #556
      // squash `558f78a`, tag plugin-runtime-v0.79.0)", and a
      // leftmost-first search paired the tag with the FEATURE PR's squash
      // and reported a mismatch against correct prose.
      const prMatches = [...before.matchAll(/release PR \[?#(\d+)\]?/g)];
      if (prMatches.length === 0) continue;
      const pr = prMatches.at(-1);
      // Only the span between that PR mention and this tag may supply the
      // squash, so a neighbouring release's sha can never be borrowed.
      const between = before.slice(pr.index);
      // If another runtime tag intervenes, this tag is not the one that
      // PR mention belongs to — skip rather than pair them up.
      if (/plugin-runtime-v\d+\.\d+\.\d+/.test(between)) continue;
      const squash = [...between.matchAll(/(?:squash|merge)\s+`?([0-9a-f]{7,40})`?/g)].at(-1) ?? null;
      checked += 1;

      const actualCommit = tagCommit.get(tag);
      if (!actualCommit) {
        findings.push({ check: 'release-triple', file, tag, detail: `docs cite tag ${tag} but no such tag exists in git` });
        continue;
      }
      if (squash && !actualCommit.startsWith(squash[1].slice(0, 7))) {
        findings.push({
          check: 'release-triple',
          file,
          tag,
          detail: `${tag} is commit ${actualCommit}, but the docs pair it with squash/merge ${squash[1]}`,
        });
      }
      if (pr) {
        const subject = tagSubject.get(tag) ?? '';
        const actualPr = subject.match(/\(#(\d+)\)\s*$/);
        if (!actualPr) {
          unverifiablePrNumbers += 1;
        } else if (actualPr[1] !== pr[1]) {
          findings.push({
            check: 'release-triple',
            file,
            tag,
            detail: `${tag} was released by PR #${actualPr[1]} (commit ${actualCommit}), but the docs pair it with PR #${pr[1]}`,
          });
        }
      }
    }
  }
  return { ran: true, reason: null, findings, checked, unverifiablePrNumbers };
}

/**
 * R2 — proof-citation consistency.
 *
 * Two purely document-internal invariants, both of which catch a
 * half-applied recovery without needing the (gitignored) artifacts:
 *
 *   1. A cited run id encodes its own date. If the prose says
 *      "recorded on 2026-07-26Z as `doctor-20260725T020157Z-...`", either
 *      the date or the id was left behind.
 *   2. The id cited as the CURRENT record must be the newest id in that
 *      document. A recovery that bumps the version tokens but leaves the
 *      previous run id cited shows up here.
 */
export function checkProofCitations(repoRoot, { docs = null } = {}) {
  const findings = [];
  let checked = 0;

  const manifest = JSON.parse(readFileSync(resolve(repoRoot, '.release-please-manifest.json'), 'utf8'));
  const target = manifest['plugins/runtime'];

  // Identifying WHICH record is current cannot be done positionally, and
  // must not be guessed: the scorecard R3 row repeats the phrase
  // "re-recorded under the <version> install on <date> (<id>" five times
  // — once for the current record and four times for superseded ones —
  // and the only distinguishing field is the version. A first-attempt
  // implementation of this check matched all of them and reported five
  // false "stale citation" findings against correct prose.
  //
  // The reliable anchor is the repo's own de-backticking convention:
  // superseded version tokens have their backticks removed so they fall
  // out of the freshness gate, so a BACKTICKED `plugin-runtime` `<target>`
  // marks a current-state record and nothing else does.
  const CURRENT_ANCHORS = [
    new RegExp(String.raw`\`plugin-runtime\` \`${target.replace(/\./g, '\\.')}\``, 'g'),
    /Latest installed proof:/g,
  ];

  for (const { file, text } of readDocs(repoRoot, docs)) {
    const flat = flatten(text);
    const allIds = [...flat.matchAll(new RegExp(DOCTOR_ID, 'g'))];
    if (allIds.length === 0) continue;
    // Run ids sort lexicographically by their embedded timestamp, so
    // string comparison is a date comparison here.
    const newest = allIds.map((m) => m[0]).sort().at(-1);

    const seen = new Set();
    for (const anchor of CURRENT_ANCHORS) {
      for (const a of flat.matchAll(anchor)) {
        // The id the record cites is the first one after its anchor.
        const window = flat.slice(a.index, a.index + 600);
        const idMatch = window.match(new RegExp(DOCTOR_ID));
        if (!idMatch) continue;
        const [runId, y, mo, d] = idMatch;
        // Both anchors front the same record in DEVELOPMENT.md, and the
        // scorecard repeats its current version token four times over one
        // record. Same id means the same record, so dedupe by id; a
        // genuinely different cited id still gets its own check.
        if (seen.has(runId)) continue;
        seen.add(runId);
        checked += 1;

        if (runId !== newest) {
          findings.push({
            check: 'proof-citation-staleness',
            file,
            runId,
            detail: `a current-state record (anchored on ${anchor.source.includes('Latest') ? '"Latest installed proof"' : `\`plugin-runtime\` \`${target}\``}) cites ${runId}, but ${newest} is newer and also appears in this document`,
          });
        }

        // The stated date must agree with the one the id encodes. A
        // recovery that moves one and not the other lands here.
        const embedded = `${y}-${mo}-${d}`;
        const idAt = window.indexOf(runId);
        const nearby = window.slice(Math.max(0, idAt - 80), idAt + runId.length + 80);
        const dates = [...nearby.matchAll(/(\d{4}-\d{2}-\d{2})Z/g)].map((x) => x[1]);
        if (dates.length > 0 && !dates.includes(embedded)) {
          findings.push({
            check: 'proof-citation-date',
            file,
            runId,
            detail: `the cited run id encodes ${embedded} but the date(s) stated beside it are ${dates.join(', ')}`,
          });
        }
      }
    }
  }
  return { ran: true, reason: null, findings, checked };
}

/**
 * R4 — cited commit shas resolve, and version-attributed shas belong to
 * that version's changelog section.
 *
 * The existence half is unconditional. The attribution half deliberately
 * only fires when the prose puts a version literal and a sha in the same
 * clause ("the 0.86.2 Stage-8 proof-rendering pair #641 af620df"); a sha
 * that cannot be confidently attributed is counted as unattributed
 * rather than guessed at, because guessing which version a sha belongs to
 * from free prose is the same unsafe region-detection that ruled out
 * rewriting run ids.
 */
export function checkCommitShas(repoRoot, { docs = null } = {}) {
  const availability = gitHistoryAvailable(repoRoot);
  if (!availability.ok) {
    return { ran: false, reason: availability.reason, findings: [], checked: 0, unattributed: 0 };
  }

  const findings = [];
  let checked = 0;
  let unattributed = 0;

  // sha -> version, from the runtime changelog's per-version sections.
  const changelog = readFileSync(resolve(repoRoot, RUNTIME_CHANGELOG), 'utf8');
  const shaVersion = new Map();
  let currentSection = null;
  for (const line of changelog.split('\n')) {
    const header = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (header) { currentSection = header[1]; continue; }
    if (!currentSection) continue;
    for (const m of line.matchAll(/\/commit\/([0-9a-f]{7,40})/g)) {
      shaVersion.set(m[1].slice(0, 7), currentSection);
    }
  }

  const documents = readDocs(repoRoot, docs);

  // Resolve every cited sha in one `cat-file --batch-check` rather than
  // spawning git per sha; the real corpus is ~160 shas.
  //
  // The 7-40 bound is what keeps non-commit hex out: the scorecard also
  // cites 64-hex plan/attempt hashes in backticks, and those cannot
  // match because the closing backtick never lands inside the bound. A
  // backticked hex token in this length range that is NOT a commit will
  // be reported as unresolvable, which is intended — in these documents
  // such a token is either a typo or something that should not have been
  // written as a bare backticked sha.
  const allShas = [...new Set(
    documents.flatMap(({ text }) => [...flatten(text).matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1])),
  )];
  const objectType = new Map();
  if (allShas.length > 0) {
    const batch = git(repoRoot, ['cat-file', '--batch-check'], `${allShas.join('\n')}\n`);
    // Output is either "<full-sha> <type> <size>" or "<input> missing",
    // one row per input in input order. Pair by index: the echoed name
    // differs from the input for shas that resolved, so name-matching
    // would silently drop every resolved sha.
    const rows = batch.split('\n').filter(Boolean);
    if (rows.length !== allShas.length) {
      throw new Error(`git cat-file --batch-check returned ${rows.length} rows for ${allShas.length} shas; refusing to pair them up`);
    }
    rows.forEach((line, i) => {
      const type = line.split(' ')[1];
      objectType.set(allShas[i], type === undefined ? 'missing' : type);
    });
  }

  for (const { file, text } of documents) {
    const flat = flatten(text);
    for (const m of flat.matchAll(/`([0-9a-f]{7,40})`/g)) {
      const sha = m[1];
      checked += 1;
      const type = objectType.get(sha);
      if (type !== 'commit') {
        findings.push({
          check: 'commit-sha',
          file,
          sha,
          detail: type === 'missing' || type === undefined
            ? 'does not resolve to any object in this repository'
            : `resolves to a ${type}, not a commit`,
        });
        continue;
      }

      const changelogVersion = shaVersion.get(sha.slice(0, 7));
      if (!changelogVersion) continue;
      // Attribution: the nearest version literal within the same clause
      // ahead of the sha. Bounded tightly and stopping at a sentence end
      // so an unrelated version earlier in the paragraph cannot claim it.
      const before = flat.slice(Math.max(0, m.index - 160), m.index);
      // Nearest, not leftmost — the same trap R1 fell into. A sentence
      // like "the 0.85.0 loop and ADR-0048 §3 pair `af620df`" has no
      // intervening period between the earlier version and the sha, so a
      // leftmost match would attribute the sha to 0.85.0.
      const attributed = [...before.matchAll(/(?:^|[\s(])(\d+\.\d+\.\d+)\b/g)].at(-1) ?? null;
      if (!attributed) { unattributed += 1; continue; }
      // Anything past a sentence boundary is a different claim.
      if (before.slice(attributed.index + attributed[0].length).includes('. ')) { unattributed += 1; continue; }
      if (attributed[1] !== changelogVersion) {
        findings.push({
          check: 'commit-sha-attribution',
          file,
          sha,
          detail: `the changelog places ${sha} in ${changelogVersion}, but the prose attributes it to ${attributed[1]}`,
        });
      }
    }
  }
  return { ran: true, reason: null, findings, checked, unattributed };
}

export function runAllChecks(repoRoot, options = {}) {
  return {
    releaseTriples: checkReleaseTriples(repoRoot, options),
    proofCitations: checkProofCitations(repoRoot, options),
    commitShas: checkCommitShas(repoRoot, options),
  };
}

const invokedAsCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsCLI) {
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const results = runAllChecks(REPO_ROOT);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const [name, r] of Object.entries(results)) {
      if (!r.ran) {
        console.error(`${name}: COULD NOT RUN — ${r.reason}`);
        continue;
      }
      const extra = [
        r.unverifiablePrNumbers ? `${r.unverifiablePrNumbers} PR number(s) not offline-verifiable (pre-squash-merge releases)` : null,
        r.unattributed ? `${r.unattributed} sha(s) unattributed` : null,
      ].filter(Boolean).join('; ');
      console.log(`${name}: ${r.checked} claim(s) checked, ${r.findings.length} finding(s)${extra ? ` — ${extra}` : ''}`);
      for (const f of r.findings) console.log(`  ✗ ${f.file}: ${f.detail}`);
    }
  }

  const failed = Object.values(results).some((r) => !r.ran || r.findings.length > 0);
  process.exit(failed ? 1 : 0);
}
