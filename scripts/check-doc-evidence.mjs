#!/usr/bin/env node
// Read-only consistency checks over the repository's evidence claims.
// Companion to scripts/sync-doc-versions.mjs: that script DERIVES the
// version tokens the freshness gate gates; this one CHECKS the claims the
// gate cannot see.
//
// The checks do NOT share a corpus, and the split is the point. R1 and R2
// read RELEASE claims — triples and current-proof records — which only the
// three stage docs make, so they run on an enumerated list. R4 reads
// COMMIT CITATIONS, which any document can carry and which are checkable
// by identifier comparison alone, so it runs on a discovered corpus. They
// were one list until it was measured: pointing all three at docs/adr/**
// left R1 and R2 at `checked: 0` — vacuously green — while degrading R1's
// coverage signal, and only R4 gained anything. See EVIDENCE_DOCS and
// discoverShaCorpus for each corpus and its exclusions.
//
// Why these checks, and why read-only:
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
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkStore } from './lib/evidence-store.mjs';

/**
 * R1 + R2's corpus: the stage docs, ENUMERATED on purpose.
 *
 * These two checks verify claims about RELEASES — that a cited
 * `(release PR, squash, tag, marketplace sync)` combination existed, and
 * that the record presented as current cites the newest proof run. Only
 * these three documents make such claims. Feeding them a wider corpus
 * does not widen coverage; it was measured to do the opposite. Adding
 * `docs/adr/**` as-is left R1 at `checked: 0` while raising its
 * `unpairedTags` count from 9 to 22, and left R2 at `checked: 0` /
 * `dateChecked: 0` — a vacuous pass plus a degraded coverage signal.
 *
 * So the enumeration here is a scope statement, not the drift
 * ADR-0052 §Decision 2 warns about. R4's corpus, which genuinely should
 * grow with the repository, is discovered instead — see
 * `discoverShaCorpus`.
 */
export const EVIDENCE_DOCS = [
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/assurance/omcc-cutover-scorecard.md',
];

/**
 * R4's corpus: DISCOVERED, not enumerated (ADR-0052 §Decision 2's
 * directory-not-a-file-list rule, applied to the array that ADR named as
 * the repository's live instance of the failure).
 *
 * A cited commit sha is checkable wherever it appears, so this corpus is
 * every hand-authored markdown file that can carry one: everything under
 * `docs/` recursively, plus the repository-root files. The scope is set by
 * the DIRECTORY rule, and it decides two questions:
 *
 *   - The nine generated changelogs stay out. release-please writes those
 *     links from the commits it has just released, so they cannot dangle
 *     through an authoring error; gating them checks a tool against
 *     itself. They are also 702 of the repository's 1147 citations, so
 *     admitting them would make the changelog format — not the evidence
 *     prose — the thing this check is most sensitive to. All nine sit
 *     under `plugins/` or `companions/`, so today the directory rule alone
 *     already excludes every one of them; `SHA_CORPUS_EXCLUDED_BASENAME`
 *     covers the root or `docs/` changelog this repository does not
 *     currently have, and is stated separately because that is a different
 *     reason from "out of scope".
 *
 *   - `plugins/**` and `companions/**` authored docs stay out. Measured
 *     across the 170 authored files they carry 3 citations, and 2 of those
 *     are a prose
 *     position number (`position 987654321`) rather than a sha. Admitting
 *     them would force an "all-decimal tokens are not shas" rule, and that
 *     rule is unsafe here: 4 of the 442 real citations in this corpus are
 *     all-decimal, and 35 of the repository's 918 commits as of 2d6a667
 *     (3.8%) have an all-decimal 7-character abbreviation. The third citation (`16b1833`
 *     in `plugins/runtime/docs/host-parity-baseline.md`) is a fact
 *     `AGENTS.md` already states and this corpus therefore already gates.
 *     A future widening has to solve the decimal question first.
 *
 * Discovery goes through `git ls-files` rather than a filesystem walk so
 * the corpus is what the repository contains rather than what one working
 * tree happens to hold — the same machine-independence requirement that
 * makes reachability judge from the integration branch below.
 */
export const SHA_CORPUS_DIRS = Object.freeze(['docs']);
export const SHA_CORPUS_EXCLUDED_BASENAME = 'CHANGELOG.md';

/**
 * The membership rule, separate from the walk that applies it.
 *
 * Split out because the two clauses are not equally exercised by the real
 * tree: the basename clause removes nothing today (every changelog is
 * already outside the directory clause), so a test that asserts "no
 * changelog is in the corpus" passes whether or not that clause exists.
 * Testing the predicate on a constructed path is what makes the clause
 * verifiable rather than decorative.
 */
export function isShaCorpusFile(file) {
  if (!file.endsWith('.md')) return false;
  if (basename(file) === SHA_CORPUS_EXCLUDED_BASENAME) return false;
  return !file.includes('/') || SHA_CORPUS_DIRS.some((dir) => file.startsWith(`${dir}/`));
}

export function discoverShaCorpus(repoRoot) {
  return git(repoRoot, ['ls-files', '-z']).split('\0')
    .filter(Boolean)
    .filter(isShaCorpusFile)
    .sort();
}

const DOCTOR_ID = String.raw`doctor-(\d{4})(\d{2})(\d{2})T\d{6}Z-[0-9a-f]+`;
const ANY_DOCTOR_ID = String.raw`doctor-\d{8}T\d{6}Z-[0-9a-f]+`;
const DATE = String.raw`(\d{4}-\d{2}-\d{2})Z?`;
// A content digest that a hard wrap has SPLIT, e.g. a 64-hex whole-tree
// hash reflowed as `<49 hex> <15 hex>`. Masked so the short fragment
// cannot read as a sha. The scorecard and DEVELOPMENT.md carry six such
// digests (four and two); all six are unwrapped today, and an unwrapped
// one needs no mask because `CITED_SHA`'s alphanumeric-neighbour rule
// already rejects every window inside a run longer than 40.
//
// The shape is deliberately narrow: EXACTLY two whitespace-separated
// pieces, one of them longer than any commit sha. A first version masked
// any hex-and-whitespace code span totalling over 40 hex characters, which
// silently swallowed real citations — `` `deadbee badcafe decafed cabbace
// fadfade beeface` `` extracted nothing at all, and so did a span holding
// two full 40-character shas (cross-host review finding). Where the two
// readings are genuinely ambiguous the check now errs toward reporting: a
// false finding is loud and one edit from fixed, a silent miss is the
// failure this whole corpus change exists to close.
const WRAPPED_DIGEST_SPAN = /`\s*([0-9a-f]+)\s+([0-9a-f]+)\s*`/g;
// A commit in ANOTHER repository, cited as a repository-qualified link.
// It is a real citation, but not a claim about THIS repository's history,
// so resolving it locally is meaningless: measured, an external sha is
// reported as unresolvable unless it happens to collide with a local
// object, in which case it passes for the wrong reason (cross-host review
// finding). Masked rather than allow-listed — being qualified by a
// different owner/repo IS the exception grammar, so no reviewed list has
// to be maintained. A bare external sha with no link still fails, which is
// the intended pressure toward writing the qualified form.
const EXTERNAL_COMMIT_URL = /https?:\/\/[^\s`)\]]*?\/([^/\s]+\/[^/\s]+)\/commit\/([0-9a-f]{7,40})/g;
const THIS_REPO = 'each4all/agentic-plugins';
// A cited sha is a hex run of 7-40 characters standing on its own. Three
// neighbour classes disqualify it, and each one is a measured false
// positive rather than a precaution:
//
//   [0-9A-Za-z] either side — the run is part of a longer word or token.
//     "feedbac|k" (25 occurrences across the ADRs, because the English
//     word begins with seven hex characters), "su|cceeded", and the date
//     component of a run id, "…-20260505|T120000Z-…".
//
//   `-` on the LEFT — the run is the tail of a compound identifier: a
//     workflow or peer run id (`plan-verify-20260526T012732Z-1a205273`)
//     or a proof subject (`egress-proof-5f00461ebdc9`). This is the class
//     that produced the "15 unresolved of 71" reading recorded against
//     `docs/adr` — those 15 were run-id suffixes, not citations. Measured:
//     0 real citations in this corpus have a `-` left neighbour; 22
//     compound-identifier tails do. A markdown list item is unaffected —
//     `- af620df` puts a space, not the hyphen, next to the run.
//
//   `…` either side — the run is a deliberately elided digest, as in
//     `plan_hash sha256:63119f47…4131a` and `…23882a3a…`. Immediate
//     adjacency only, so ADR-0049's `Codex 0.145.0 … af620df` — where a
//     space separates the ellipsis from a real citation — still matches.
//     U+2026 only: the ASCII spelling `...` is NOT excluded, and that is a
//     decision rather than an oversight. Both candidate classes measure
//     zero in this corpus — no hex run sits against `...`, and no commit
//     RANGE (`16b1833^..16b1833`) is cited either — so a `..` guard would
//     trade a hypothetical false positive for a hypothetical false
//     negative on ranges, with nothing measured to prefer one. It stays
//     uncovered until one of the two actually appears.
//
// What this rule REPLACED required a delimiter from a closed set on each
// side (`^|[\s(]` before, `[\s,.;)]|$` after) or the whole code span to be
// hex. That silently dropped nine real citations, six of them in the
// already-gated scorecard: quote-wrapped (`§"28b5eb8 incident"`),
// slash-separated lists (`123e9a0/e9d5a1c/1a3c5c6/0bdbdd5`), and shas at
// either edge of a longer code span.
const CITED_SHA = /(?<![0-9A-Za-z…-])([0-9a-f]{7,40})(?![0-9A-Za-z…])/g;
// [pattern, dateComesFirst]. Closed set, exact-matched: these are the
// constructions the stage docs actually use to bind a date to a proof
// run id. Anything else mentioning a date near an id is prose, not a
// claim about that id's date.
const DATE_CITATION_PHRASES = [
  [new RegExp(String.raw`(?:re-?)?recorded on ${DATE} as \`?(${ANY_DOCTOR_ID})\`?`, 'g'), true],
  [new RegExp(String.raw`per the ${DATE} \`?(${ANY_DOCTOR_ID})\`?`, 'g'), true],
  [new RegExp(String.raw`install on ${DATE} \(\`?(${ANY_DOCTOR_ID})\`?`, 'g'), true],
  [new RegExp(String.raw`\`?(${ANY_DOCTOR_ID})\`? \(${DATE}`, 'g'), false],
  // Three further checked-in constructions the first closed set missed
  // (round-5 cross-host review finding). The set is closed by
  // construction, so it grows only when a real document form is found —
  // which is the point: exact matching converges, a window does not.
  [new RegExp(String.raw`(?:re-?)?recorded on ${DATE} \(\`?(${ANY_DOCTOR_ID})\`?`, 'g'), true],
  [new RegExp(String.raw`install \(${DATE}, \`?(${ANY_DOCTOR_ID})\`?`, 'g'), true],
  [new RegExp(String.raw`\`?(${ANY_DOCTOR_ID})\`? \(recorded ${DATE}`, 'g'), false],
];

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
function readDocs(repoRoot, docs, files) {
  if (docs) return docs;
  return files.map((file) => ({ file, text: readFileSync(resolve(repoRoot, file), 'utf8') }));
}

// Hard wraps split nearly every claim across lines. Read-only checks can
// safely flatten newlines to spaces; nothing is written back, so no
// offset must survive.
function flatten(text) {
  return text.replace(/\n>? ?/g, ' ');
}

/**
 * Every commit sha cited by a document, in order of appearance.
 *
 * Exported so the extractor can be audited directly against both its
 * positive shapes and its negative controls, rather than only through the
 * aggregate counts of a check — an aggregate cannot distinguish a rule
 * that stopped matching from a document that stopped saying it.
 */
export function extractCitedShas(text) {
  const blank = (s) => '~'.repeat(s.length);
  const flat = flatten(text)
    .replace(EXTERNAL_COMMIT_URL, (url, repo) => (repo === THIS_REPO ? url : blank(url)))
    .replace(WRAPPED_DIGEST_SPAN, (span, head, tail) => (
      // One digest split by a wrap, not a list: the pieces only make sense
      // as one token if together they exceed a commit sha and one of them
      // already does on its own.
      head.length + tail.length > 40 && Math.max(head.length, tail.length) > 40 ? blank(span) : span
    ));
  return [...flat.matchAll(CITED_SHA)].map((m) => m[1]);
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
  const releaseCommits = new Set();
  const refFormat = '%(refname:short)%00%(objectname:short=7)%00%(*objectname:short=7)%00%(contents:subject)%00%(*contents:subject)';
  for (const line of git(repoRoot, ['for-each-ref', `--format=${refFormat}`, 'refs/tags/plugin-runtime-v*']).split('\n').filter(Boolean)) {
    const [tag, objectSha, derefSha, subject, derefSubject] = line.split('\0');
    tagCommit.set(tag, derefSha || objectSha);
    tagSubject.set(tag, (derefSubject || subject || '').trim());
  }
  // Release commits for the intervening check must span EVERY package,
  // not just runtime: an attention-only release sits between runtime
  // v0.80.0 and the sync commit the docs would otherwise be allowed to
  // cite, so a runtime-only set could not see it (round-5 cross-host
  // review finding).
  for (const line of git(repoRoot, ['for-each-ref', '--format=%(objectname:short=7)%00%(*objectname:short=7)', 'refs/tags/']).split('\n').filter(Boolean)) {
    const [objectSha, derefSha] = line.split('\0');
    releaseCommits.add((derefSha || objectSha).slice(0, 7));
  }

  for (const { file, text } of readDocs(repoRoot, docs, EVIDENCE_DOCS)) {
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
          // Descendancy alone let ANY later sync commit pass — v0.86.2's
          // sync satisfied a v0.84.0 claim (round-4 cross-host review
          // finding). The sync belonging to a release is the one with no
          // other release commit between them.
          const between = git(repoRoot, ['rev-list', `${actualCommit}..${syncSha[1]}`]).split('\n').filter(Boolean);
          const intervening = between.filter((c) => releaseCommits.has(c.slice(0, 7)));
          if (intervening.length > 0) {
            findings.push({
              check: 'release-triple',
              file,
              tag,
              detail: `${syncSha[1]} is cited as ${tag}'s marketplace sync, but ${intervening.length} later release commit(s) sit between them`,
            });
            continue;
          }
          const subject = git(repoRoot, ['log', '-1', '--format=%s', syncSha[1]]).trim();
          // Catalog syncs only. Accepting "sync stage doc" would let the
          // workflow's own documentation commit masquerade as one.
          if (!/sync catalog versions/i.test(subject)) {
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

  const manifest = JSON.parse(readFileSync(resolve(repoRoot, '.release-please-manifest.json'), 'utf8'));
  const target = manifest['plugins/runtime'];

  // Identifying WHICH record is current cannot be done positionally, and
  // must not be guessed: the scorecard R3 row repeats the phrase
  // "re-recorded under the <version> install on <date> (<id>" six times
  // — once for the current record and five times for superseded ones,
  // seven across the whole document — and the only distinguishing field
  // is the version. A first-attempt implementation of this check matched
  // all of them and reported a false "stale citation" finding for every
  // one against correct prose. The count is stated without a number in
  // that sentence deliberately: it rises with each release, and a fixed
  // number in a historical claim goes stale the way these two comments
  // just did.
  //
  // The reliable anchor is the repo's own de-backticking convention:
  // superseded version tokens have their backticks removed so they fall
  // out of the freshness gate, so a BACKTICKED `plugin-runtime` `<target>`
  // marks a current-state record and nothing else does.
  const CURRENT_ANCHORS = [
    new RegExp(String.raw`\`plugin-runtime\` \`${target.replace(/\./g, '\\.')}\``, 'g'),
    /Latest installed proof:/g,
  ];

  for (const { file, text } of readDocs(repoRoot, docs, EVIDENCE_DOCS)) {
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
        // 1200, not 600: the scorecard's "The latest `plugin-runtime`
        // `X` release/install proof loop" record reaches its run id 955
        // characters later, so a 600-char window skipped that record
        // entirely (round-4 cross-host review finding). Same bound as the
        // sync script's citation window, measured from the same corpus.
        const window = flat.slice(a.index, a.index + 1200);
        const idMatch = window.match(new RegExp(DOCTOR_ID));
        if (!idMatch) {
          // Deleting the current record's citation outright used to pass:
          // the anchor found no id and the loop continued silently, while
          // the aggregate counts stayed above their floors because the
          // other document still had one (round-5 cross-host review
          // finding). A current-state anchor with no proof run id near it
          // is a missing citation.
          findings.push({
            check: 'proof-citation-missing',
            file,
            runId: null,
            detail: `a current-state record anchored on ${anchor.source.includes('Latest') ? '"Latest installed proof"' : `\`plugin-runtime\` \`${target}\``} cites no proof run id within 1200 characters`,
          });
          continue;
        }
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

    // Date agreement is bound by CITATION PHRASE, not proximity.
    //
    // Proximity cannot work here, and that is measured rather than
    // assumed: taking each id's nearest date anywhere in the document,
    // the pairs that AGREE sit at 13-56, 86, 127, 184, 192, 228, 330,
    // 448, 585, 707 characters, and the pairs that DISAGREE sit at 75,
    // 162, 195, 229, 248, 292, 407, 520, 927. They interleave from 75
    // onward, so no threshold separates them — every bound either drops a
    // legitimate pair or admits an unrelated date such as the
    // "2026-07-10 baseline refresh" that sits 75 characters from a
    // 2026-07-09 proof id. An earlier +-64 bound was derived from a
    // biased sample: distances were measured INSIDE an +-80 window, so
    // legitimate pairs beyond 80 were never observed (round-4 cross-host
    // review finding).
    //
    // The constructions that actually bind a date to an id are a closed
    // set, and exact-matching them binds 35 pairs across the real corpus
    // with zero mismatches and no distance term at all.
    for (const [pattern, dateFirst] of DATE_CITATION_PHRASES) {
      for (const m of flat.matchAll(pattern)) {
        const statedDate = dateFirst ? m[1] : m[2];
        const runId = dateFirst ? m[2] : m[1];
        const encoded = runId.match(/doctor-(\d{4})(\d{2})(\d{2})/);
        if (!encoded) continue;
        dateChecked += 1;
        const embedded = `${encoded[1]}-${encoded[2]}-${encoded[3]}`;
        if (embedded !== statedDate) {
          findings.push({
            check: 'proof-citation-date',
            file,
            runId,
            detail: `the cited run id encodes ${embedded} but the citation states ${statedDate}`,
          });
        }
      }
    }
  }
  return { ran: true, reason: null, findings, checked, dateChecked };
}

/**
 * R4 — every cited commit sha resolves and is reachable from the
 * integration branch.
 *
 * ATTRIBUTION WAS REMOVED, and the reason is worth keeping. Checking that
 * a sha belongs to the changelog version the prose places it under was
 * attempted three times across three review rounds and failed each time,
 * in a different direction:
 *
 *   - bare semver plus a sentence-boundary rule attributed a runtime
 *     commit to a HOST version ("Codex 0.145.0 ... `af620df`");
 *   - filtering candidates to released runtime versions did not help,
 *     because a host version can collide with one ("Codex CLI 0.86.1");
 *   - requiring an explicit runtime marker removed the ambiguity but also
 *     removed the check: on the real corpus it attributed 0 of 97
 *     changelog-backed shas, because these documents attribute with bare
 *     semver ("the 0.86.2 Stage-8 proof-rendering pair #641 af620df");
 *   - and with a marker present, picking the nearest one still guessed
 *     wrong on realistic prose, where an environment marker ("verified on
 *     installed plugin-runtime 0.86.2") sits closer than the subject.
 *
 * The generalisation: deciding WHICH version a sha belongs to requires
 * reading the sentence, not matching a pattern. Resolution and
 * reachability, by contrast, are identifier comparisons — they have been
 * stable under adversarial review and have caught two real dangling
 * citations. Those stay; the guess does not.
 */
export function checkCommitShas(repoRoot, { docs = null } = {}) {
  const availability = gitHistoryAvailable(repoRoot);
  if (!availability.ok) {
    return { ran: false, reason: availability.reason, findings: [], checked: 0, reachabilityBase: null, corpusFiles: [] };
  }

  const findings = [];
  let checked = 0;

  // The runtime changelog is NOT read here any more, and its absence is
  // the point. It was parsed to build a sha -> version map for the
  // attribution check, and a fail-closed guard refused to run when that
  // map came out empty. Attribution was removed; the map went unread; the
  // guard stayed. Harmless while this check covered three stage docs —
  // actively wrong now that it covers every document in `docs/` and the
  // root, because a formatting change in ONE package's generated
  // changelog would disable commit-sha checking repository-wide
  // (cross-host review finding). A guard must protect something that
  // exists.

  // The DISCOVERED corpus, not the enumerated stage-doc list — see
  // `discoverShaCorpus`. Resolution and reachability are identifier
  // comparisons, so every document that cites a sha can be held to them;
  // only R1 and R2, which read release claims, need a narrower scope.
  //
  // Discovery reads the INDEX, so it can name a file the working tree no
  // longer has — `rm doc.md` without `git rm` is enough. The enumerated
  // list could not produce that state. Report it as a check that could not
  // run rather than letting a bare ENOENT escape: the tree is mid-edit,
  // which is a different thing from a dangling citation, and skipping the
  // file silently would be the "reads as coverage" failure this module's
  // availability guard exists to avoid.
  const corpusFiles = docs ? docs.map(({ file }) => file) : discoverShaCorpus(repoRoot);
  let documents;
  try {
    documents = readDocs(repoRoot, docs, corpusFiles);
  } catch (err) {
    return {
      ran: false,
      reason: `a discovered corpus file could not be read: ${err.message}`,
      findings: [], checked: 0, reachabilityBase: null, corpusFiles,
    };
  }

  // Resolve every cited sha in one `cat-file --batch-check` rather than
  // spawning git per sha; the real corpus is ~160 unique shas.
  //
  // A hex token in the 7-40 range that is NOT a commit is reported as
  // unresolvable, which is intended — in these documents such a token is
  // either a typo or something that should not have been written as a
  // bare sha. Everything that is legitimately hex-shaped without being a
  // citation is excluded by `CITED_SHA`'s neighbour rules or the
  // `DIGEST_SPAN` mask rather than by hoping it falls outside the bound.
  const allShas = [...new Set(documents.flatMap(({ text }) => extractCitedShas(text)))];
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
  // exists to catch (round-2 cross-host review finding).
  //
  // NO HEAD FALLBACK. An earlier version fell back to HEAD when neither
  // integration ref existed, "to keep the check usable in clones without a
  // remote", and reported the weaker base so a caller could notice. The
  // CLI printed that note and still exited 0 — so in a feature-only clone
  // the check went green on exactly the branch-local citation it exists to
  // reject, which contradicts the guarantee AGENTS.md states
  // (cross-host review finding). Fail closed instead: no integration
  // branch means the question cannot be answered, not that the answer is
  // yes.
  let reachabilityBase = null;
  for (const candidate of ['origin/main', 'main']) {
    try {
      git(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      reachabilityBase = candidate;
      break;
    } catch { /* not present in this clone; try the next */ }
  }
  if (reachabilityBase === null) {
    return {
      ran: false,
      reason: 'neither origin/main nor main is present, so reachability from the integration branch cannot be judged',
      findings: [], checked: 0, reachabilityBase: null, corpusFiles,
    };
  }
  // FULL commit identity, not a 7-character prefix. The reachable set is
  // keyed by whole sha and each citation is resolved to its whole sha by
  // git before the lookup, so the characters a citation writes past the
  // seventh are compared rather than discarded. The prefix index this
  // replaced had two defects that compounded: it truncated the citation
  // to 7 characters, and it kept only the FIRST full sha per prefix, so
  // even a prefix-aware comparison would have consulted an arbitrary
  // member of a colliding pair. A full 40-character citation of an
  // unreachable commit whose first 7 characters matched a reachable one
  // therefore passed. No natural fixture exists — this repository has 0
  // seven-character collisions across the 918 commits on all refs as of
  // 2d6a667 — but a synthetic one is cheap and the test builds it: a
  // birthday search over generated commit objects finds a colliding pair
  // in ~26k objects and tens of milliseconds. An earlier revision of this
  // comment called that infeasible by citing 16^7, which is the cost of
  // hitting a CHOSEN prefix, not the cost of finding ANY collision.
  const reachableCommits = new Set(git(repoRoot, ['rev-list', reachabilityBase]).split('\n').filter(Boolean));

  const objectType = new Map();
  const resolvedSha = new Map();
  if (allShas.length > 0) {
    const batch = git(repoRoot, ['cat-file', '--batch-check'], `${allShas.join('\n')}\n`);
    // Output is "<full-sha> <type> <size>" for a resolved object, or
    // "<input> missing" / "<input> ambiguous", one row per input in input
    // order. Pair by index: the echoed name differs from the input for
    // shas that resolved, so name-matching would silently drop every
    // resolved sha.
    const rows = batch.split('\n').filter(Boolean);
    if (rows.length !== allShas.length) {
      throw new Error(`git cat-file --batch-check returned ${rows.length} rows for ${allShas.length} shas; refusing to pair them up`);
    }
    rows.forEach((line, i) => {
      const [name, type] = line.split(' ');
      objectType.set(allShas[i], type === undefined ? 'missing' : type);
      if (type === 'commit') resolvedSha.set(allShas[i], name);
    });
  }

  for (const { file, text } of documents) {
    for (const sha of extractCitedShas(text)) {
      checked += 1;
      const type = objectType.get(sha);
      if (type !== 'commit') {
        findings.push({
          check: 'commit-sha',
          file,
          sha,
          detail: type === 'missing' || type === undefined
            ? 'does not resolve to any object in this repository'
            // `cat-file --batch-check` answers "<input> ambiguous" rather
            // than a type. No abbreviation in this repository is ambiguous
            // today, but the collision fixture in the test suite produces
            // one, so this branch is exercised rather than assumed —
            // reporting it as "resolves to a undefined, not a commit"
            // would send an author looking for the wrong problem.
            : type === 'ambiguous'
              ? 'is too short to name one object — git reports it as ambiguous'
              : `resolves to a ${type}, not a commit`,
        });
        continue;
      }
      // Present in this clone but not in the branch's history: a
      // pre-squash branch commit whose branch was deleted, or an object
      // pulled in from a fork. Nobody else can resolve it, so citing it
      // by sha is a dangling reference even though it looks fine on the
      // machine that wrote it.
      if (!reachableCommits.has(resolvedSha.get(sha))) {
        findings.push({
          check: 'commit-sha',
          file,
          sha,
          detail: `resolves in this clone but is not reachable from ${reachabilityBase} — a fresh clone or CI cannot resolve it (pre-squash branch commit?)`,
        });
        continue;
      }

    }
  }
  return { ran: true, reason: null, findings, checked, reachabilityBase, corpusFiles };
}

/**
 * The three prose checks plus the ADR-0049 record store.
 *
 * The store is validated ALONGSIDE the prose gates, not instead of them. The
 * ADR is explicit that the prose stays hand-written (Decision 5) and that
 * `checkProofCitations` remains necessary precisely because of that, so the
 * three functions above are untouched by this addition — the store is a fourth
 * result key with its own findings, and its `checked` count is records rather
 * than prose claims.
 *
 * Cheap when the store is empty, which it is until the first release loop
 * after the schema: `checkStore` returns before any git work when there are no
 * records.
 */
export function runAllChecks(repoRoot, options = {}) {
  const store = checkStore(repoRoot);
  return {
    releaseTriples: checkReleaseTriples(repoRoot, options),
    proofCitations: checkProofCitations(repoRoot, options),
    commitShas: checkCommitShas(repoRoot, options),
    evidenceStore: { ...store, checked: store.records },
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
        // Corpus size, so a discovery rule that silently stopped finding
        // documents is visible in the report rather than only as a
        // suspiciously round claim count.
        r.corpusFiles ? `over ${r.corpusFiles.length} discovered file(s)` : null,
        r.reachabilityBase && r.reachabilityBase !== 'origin/main' ? `reachability base ${r.reachabilityBase} (weaker than origin/main)` : null,
        // The store reports how much of itself was actually verified. An
        // observed field whose doctor artifact is gone is `unverified`, and
        // saying so is the point — a silent green would claim more assurance
        // than CI can give (ADR-0049 Decision 4).
        r.proofStatus && (r.proofStatus.verified + r.proofStatus.unverified + r.proofStatus.failed) > 0
          ? `proofs ${r.proofStatus.verified} verified / ${r.proofStatus.unverified} unverified (artifact absent) / ${r.proofStatus.failed} failed`
          : null,
      ].filter(Boolean).join('; ');
      const unit = name === 'evidenceStore' ? 'record(s) checked' : 'claim(s) checked';
      console.log(`${name}: ${r.checked} ${unit}, ${r.findings.length} finding(s)${extra ? ` — ${extra}` : ''}`);
      for (const f of r.findings) console.log(`  ✗ ${f.path ?? f.file}: ${f.detail}`);
    }
  }

  const failed = Object.values(results).some((r) => !r.ran || r.findings.length > 0);
  process.exit(failed ? 1 : 0);
}
