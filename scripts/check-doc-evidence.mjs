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
    return { ran: false, reason: availability.reason, findings: [], checked: 0, unverifiablePrNumbers: 0, unpairedTags: 0, checkedTags: [] };
  }

  const findings = [];
  let checked = 0;
  let unverifiablePrNumbers = 0;
  // Tag mentions this extractor declined to pair with a release PR. A
  // wrong triple written tag-before-PR, or with the PR more than the
  // window away, silently drops out of `checked`; an aggregate
  // "checked > 20" assertion cannot see that (cross-host review
  // finding). Surfacing the count lets a caller notice coverage loss,
  // and the tests pin specific tags by name rather than a total.
  let unpairedTags = 0;
  const checkedTags = new Set();
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
      // Case-insensitive: the scorecard writes both "release PR #642" and
      // sentence-initial "Release PR #544", and a case-sensitive pattern
      // silently dropped the latter's triple from coverage.
      const prMatches = [...before.matchAll(/release PR \[?#(\d+)\]?/gi)];
      if (prMatches.length === 0) { unpairedTags += 1; continue; }
      const pr = prMatches.at(-1);
      // Only the span between that PR mention and this tag may supply the
      // squash, so a neighbouring release's sha can never be borrowed.
      const between = before.slice(pr.index);
      // If another runtime tag intervenes, this tag is not the one that
      // PR mention belongs to — skip rather than pair them up.
      if (/plugin-runtime-v\d+\.\d+\.\d+/.test(between)) { unpairedTags += 1; continue; }
      const squash = [...between.matchAll(/(?:squash|merge)\s+`?([0-9a-f]{7,40})`?/g)].at(-1) ?? null;
      checked += 1;
      checkedTags.add(tag);

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
      // The marketplace sync commit is the child of the release commit, so
      // the claim is checkable — and was not checked at all: swapping the
      // current sync sha for the previous release's produced zero
      // findings (round-2 cross-host review finding).
      // Bounded by the next release record so a neighbouring release's
      // sync sha cannot be borrowed (round-3 cross-host review finding).
      const afterTag = flat.slice(m.index, m.index + 200);
      const nextRecord = afterTag.slice(1).search(/release PR \[?#\d+/i);
      const syncScope = nextRecord === -1 ? afterTag : afterTag.slice(0, nextRecord + 1);
      const syncSha = [...syncScope.matchAll(/(?:marketplace )?sync(?: commit)? `?([0-9a-f]{7,40})`?/g)][0] ?? null;
      if (syncSha) {
        // DESCENDANCY plus identity, not immediate parentage. Requiring
        // `sync^ == release` is neither necessary — main can advance
        // between the release and the catalog push, putting an unrelated
        // commit in between — nor sufficient: that unrelated commit would
        // itself satisfy the parent test and pass while being the wrong
        // sha (round-3 cross-host review finding). Checking ancestry and
        // the commit's own subject pins it correctly in both directions.
        try {
          git(repoRoot, ['merge-base', '--is-ancestor', actualCommit, syncSha[1]]);
          const subject = git(repoRoot, ['log', '-1', '--format=%s', syncSha[1]]).trim();
          if (!/sync (catalog|stage doc)/i.test(subject)) {
            findings.push({
              check: 'release-triple',
              file,
              tag,
              detail: `${syncSha[1]} is cited as ${tag}'s marketplace sync, but its subject is "${subject}"`,
            });
          }
        } catch {
          findings.push({
            check: 'release-triple',
            file,
            tag,
            detail: `marketplace sync ${syncSha[1]} paired with ${tag} does not resolve, or is not a descendant of ${actualCommit}`,
          });
        }
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
  return { ran: true, reason: null, findings, checked, unverifiablePrNumbers, unpairedTags, checkedTags: [...checkedTags] };
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
  let dateChecked = 0;
  const dateSkipped = [];

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

        void y; void mo; void d;
      }
    }

    // Date agreement is checked for EVERY cited run id, not only the
    // current one. Restricting it to ids reachable from a current anchor
    // left the packed superseded history — 25 ids in one DEVELOPMENT.md
    // line, 20 in the scorecard R3 row — completely ungated, which is the
    // opposite of this module's stated motivation (cross-host review
    // finding). A superseded record whose date and id disagree is still a
    // corrupted record, and nothing else in the repo would notice.
    for (const m of allIds) {
      const [runId, y, mo, d] = m;
      const embedded = `${y}-${mo}-${d}`;
      // NEAREST date, not "any date within the window". Collecting every
      // date in +-80 characters and asking `includes()` let an
      // explicitly wrong date pass whenever a correct one happened to sit
      // elsewhere in the same window (cross-host review finding).
      // +-64, measured. Across the real corpus a date that AGREES with
      // its id sits 13-56 characters away, while the one disagreeing date
      // is an unrelated "2026-07-10 baseline refresh" 75 characters from a
      // 2026-07-09 proof id. A wider window reaches prose that is not a
      // citation at all and reports a false mismatch; a narrower one drops
      // legitimate pairs.
      const DATE_PROXIMITY = 64;
      const from = Math.max(0, m.index - DATE_PROXIMITY);
      const nearby = flat.slice(from, m.index + runId.length + DATE_PROXIMITY);
      // The trailing `Z` is optional. Requiring it meant that dropping
      // one character from a cited date removed that id from the scan
      // entirely and silently — the mutation the round-3 review used, and
      // one no count-floor could catch, since the documents legitimately
      // carry many ids with no adjacent date at all (47 of 94).
      const dates = [...nearby.matchAll(/(\d{4}-\d{2}-\d{2})Z?/g)]
        .map((x) => ({ value: x[1], distance: Math.abs((from + x.index) - m.index) }))
        .sort((a, b) => a.distance - b.distance);
      if (dates.length === 0) {
        // Not silently skipped: stripping the trailing `Z` from a cited
        // date dropped that id out of the scan entirely, and a loose
        // ">= 45" floor could not see it (round-3 cross-host review
        // finding). Report the id so the caller can assert zero.
        dateSkipped.push({ file, runId });
        continue;
      }
      dateChecked += 1;
      if (dates[0].value !== embedded) {
        findings.push({
          check: 'proof-citation-date',
          file,
          runId,
          detail: `the cited run id encodes ${embedded} but the date stated next to it is ${dates[0].value}`,
        });
      }
    }
  }
  return { ran: true, reason: null, findings, checked, dateChecked, dateSkipped };
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
    return { ran: false, reason: availability.reason, findings: [], checked: 0, unattributed: 0, reachabilityBase: null };
  }

  const findings = [];
  let checked = 0;
  let unattributed = 0;

  // sha -> version, from the runtime changelog's per-version sections.
  const changelog = readFileSync(resolve(repoRoot, RUNTIME_CHANGELOG), 'utf8');
  const shaVersion = new Map();
  const releasedVersions = new Set();
  let currentSection = null;
  for (const line of changelog.split('\n')) {
    const header = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (header) { currentSection = header[1]; releasedVersions.add(header[1]); continue; }
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
  // Reachability, not mere object existence. `cat-file` answers "is this
  // object in MY object store", which is machine-dependent and gave a
  // false green locally: docs/DEVELOPMENT.md cited `36b7ab1`, a
  // pre-squash branch commit that survives in a long-lived clone but is
  // on no remote branch, so CI's fresh clone could not resolve it. The
  // deterministic question is whether the sha is in this branch's
  // history, which is identical on every machine.
  // The base is the INTEGRATION branch, not HEAD. On a pull_request run
  // GitHub checks out the synthetic `refs/pull/N/merge` ref, whose
  // history contains the PR's own branch commits — so a document citing
  // a sha from its own branch passed CI and then dangled the moment the
  // branch was squash-merged, which is precisely the defect this check
  // exists to catch (round-2 cross-host review finding). Falling back to
  // HEAD keeps the check usable in clones without a remote, and the base
  // actually used is reported so a caller can tell which guarantee it got.
  let reachabilityBase = 'HEAD';
  for (const candidate of ['origin/main', 'main']) {
    try {
      git(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      reachabilityBase = candidate;
      break;
    } catch { /* not present in this clone; try the next */ }
  }
  const ancestorByPrefix = new Map();
  for (const full of git(repoRoot, ['rev-list', reachabilityBase]).split('\n').filter(Boolean)) {
    const prefix = full.slice(0, 7);
    if (!ancestorByPrefix.has(prefix)) ancestorByPrefix.set(prefix, full);
  }

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
      // Present in this clone but not in the branch's history: a
      // pre-squash branch commit whose branch was deleted, or an object
      // pulled in from a fork. Nobody else can resolve it, so citing it
      // by backticked sha is a dangling reference even though it looks
      // fine on the machine that wrote it.
      if (!ancestorByPrefix.has(sha.slice(0, 7))) {
        findings.push({
          check: 'commit-sha',
          file,
          sha,
          detail: `resolves in this clone but is not reachable from ${reachabilityBase} — a fresh clone or CI cannot resolve it (pre-squash branch commit?)`,
        });
        continue;
      }

      const changelogVersion = shaVersion.get(sha.slice(0, 7));
      if (!changelogVersion) continue;
      // Attribution: the nearest version literal within the same clause
      // ahead of the sha. Bounded tightly and stopping at a sentence end
      // so an unrelated version earlier in the paragraph cannot claim it.
      // Attribution looks BOTH ways and takes the nearest version
      // literal. A preceding-only search silently left
      // "`af620df` shipped in 0.86.1" unattributed (cross-host review
      // finding), and `plugin-runtime-v0.86.1` — the most common way
      // these documents name a version — was not recognised as a version
      // at all because the pattern required whitespace or "(" ahead of
      // the digits.
      //
      // Nearest, not leftmost: "the 0.85.0 loop and ADR-0048 §3 pair
      // `af620df`" has no intervening period, so a leftmost match would
      // attribute the sha to 0.85.0.
      // `plugin-runtime` v0.86.1 is the canonical prose form and was not
      // matched at all; conversely any whitespace-prefixed semver
      // qualified, so "Codex 0.145.0 ... `af620df`" falsely attributed a
      // runtime commit to a HOST version (round-2 cross-host review
      // finding). Candidates are therefore filtered to versions the
      // runtime changelog actually knows about.
      // Three accepted forms: bare, `plugin-runtime-vX`, `plugin-runtime` vX,
      // and the installed-state form `plugin-runtime` `X` — the last was
      // unrecognised, so "installed `plugin-runtime` `0.86.1` carries
      // `af620df`" produced no finding (round-3 cross-host review).
      const VERSION_LITERAL = /(?:^|[\s(]|plugin-runtime-v|plugin-runtime` v|plugin-runtime` `)(\d+\.\d+\.\d+)\b/g;
      // A HOST version that coincides with a released runtime version
      // (e.g. "Codex 0.86.1") would otherwise pass the changelog filter.
      const HOST_PREFIX = /(?:Codex|codex-cli|Claude Code|claude)\s*$/;
      // Clause separators, not just ".". "0.86.1 closed; an unrelated
      // note cites `af620df`" was being attributed across the semicolon.
      const CLAUSE_BREAK = /[.;—]\s|\s—\s/;
      // Attribution reads BACKWARD only. A forward window was tried, to
      // catch shapes like "`af620df` shipped in 0.86.1" that the
      // cross-host review raised — and measured worse on the real
      // documents: zero true positives and two false ones, because these
      // docs overwhelmingly write "<version> <description> `<sha>`, then
      // the <next version> ..." where the version AFTER a sha opens the
      // next item. It misattributed `3615dcc` (0.86.0, described only as
      // "the pre-macro activation-semantics fix" and correctly carrying
      // no version of its own) to 0.86.1, and `b984dc8` (0.86.1) to
      // 0.86.2. Staying unattributed is the honest outcome for a sha the
      // prose does not actually place.
      const before = flat.slice(Math.max(0, m.index - 160), m.index);
      const back = [...before.matchAll(VERSION_LITERAL)]
        .filter((v) => releasedVersions.has(v[1]))
        .filter((v) => !HOST_PREFIX.test(before.slice(Math.max(0, v.index - 20), v.index + 1)))
        .at(-1) ?? null;
      const attributed = back && !CLAUSE_BREAK.test(before.slice(back.index + back[0].length)) ? back : null;
      if (!attributed) { unattributed += 1; continue; }
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
  return { ran: true, reason: null, findings, checked, unattributed, reachabilityBase };
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
        r.dateChecked !== undefined ? `${r.dateChecked} id/date pair(s) incl. superseded` : null,
        r.unpairedTags ? `${r.unpairedTags} tag mention(s) not paired with a release PR` : null,
        r.reachabilityBase && r.reachabilityBase !== 'origin/main' ? `reachability base ${r.reachabilityBase} (weaker than origin/main)` : null,
        r.dateSkipped && r.dateSkipped.length ? `${r.dateSkipped.length} id(s) with no adjacent date` : null,
        r.unattributed ? `${r.unattributed} sha(s) unattributed` : null,
      ].filter(Boolean).join('; ');
      console.log(`${name}: ${r.checked} claim(s) checked, ${r.findings.length} finding(s)${extra ? ` — ${extra}` : ''}`);
      for (const f of r.findings) console.log(`  ✗ ${f.file}: ${f.detail}`);
    }
  }

  const failed = Object.values(results).some((r) => !r.ran || r.findings.length > 0);
  process.exit(failed ? 1 : 0);
}
