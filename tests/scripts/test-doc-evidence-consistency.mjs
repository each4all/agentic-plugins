// Gates the evidence claims in the stage docs (scripts/check-doc-evidence.mjs).
//
// Structure of every check below: assert the real documents are clean,
// then PLANT the defect the check exists to catch and assert it fires.
// The planted defects for the release-triple check are the two real
// combinations the 0.86.1 recovery (#640) left behind and shipped green
// through two releases. Without the planted half, "0 findings on the real
// docs" would be indistinguishable from a check that matches nothing.
//
// This file is discovered by `npm test` (full-tests.yml) and is
// deliberately NOT in the `test:plugin-shape` list: two of the three
// checks need full git history plus tags, which only full-tests.yml
// fetches (fetch-depth: 0). The availability guard fails closed rather
// than skipping, so a workflow that forgets the fetch depth turns red
// instead of silently reporting coverage it does not have.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  EVIDENCE_DOCS,
  SHA_CORPUS_DIRS,
  SHA_CORPUS_EXCLUDED_BASENAME,
  checkReleaseTriples,
  checkProofCitations,
  checkCommitShas,
  discoverShaCorpus,
  extractCitedShas,
  isShaCorpusFile,
  gitHistoryAvailable,
  runAllChecks,
} from '../../scripts/check-doc-evidence.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function realDocs() {
  return EVIDENCE_DOCS.map((file) => ({ file, text: readFileSync(resolve(REPO_ROOT, file), 'utf8') }));
}

/** One real corpus file, read from disk, unmodified. */
function realFile(file) {
  return { file, text: readFileSync(resolve(REPO_ROOT, file), 'utf8') };
}

/** Real documents with one file's text replaced by a planted fixture. */
function docsWith(file, text) {
  return [{ file, text }];
}

describe('doc evidence — git availability is fail-closed', () => {
  it('reports full history with tags on this checkout', () => {
    const availability = gitHistoryAvailable(REPO_ROOT);
    ok(availability.ok, `git history must be available for these checks: ${availability.reason}`);
  });

  it('refuses to run — rather than passing — where git history is absent', () => {
    // A depth-1 CI checkout or a non-repo directory must not read as
    // "0 findings". This is the difference between a gate and a
    // decoration.
    const bare = mkdtempSync(resolve(tmpdir(), 'doc-evidence-nogit-'));
    try {
      const availability = gitHistoryAvailable(bare);
      strictEqual(availability.ok, false);
      ok(availability.reason, 'the reason is reported');
      strictEqual(checkReleaseTriples(bare).ran, false, 'release-triple check declines to run');
      strictEqual(checkCommitShas(bare).ran, false, 'commit-sha check declines to run');
    } finally { rmSync(bare, { recursive: true, force: true }); }
  });
});

describe('doc evidence — R1 release triples', () => {
  it('finds no mis-paired release triple in the checked-in docs', () => {
    const r = checkReleaseTriples(REPO_ROOT, { docs: realDocs() });
    strictEqual(r.ran, true);
    strictEqual(r.findings.length, 0, r.findings.map((f) => `${f.file}: ${f.detail}`).join('\n'));
    ok(r.checked > 20, `expected the extractor to reach the real claims, checked ${r.checked}`);
  });

  it('catches the #640 defect shape: correct PR, wrong squash beside the tag', () => {
    // Verbatim from docs/assurance/omcc-cutover-scorecard.md before this
    // slice: 1b6c569 is v0.86.0's commit, not v0.86.1's.
    const r = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #630 `chore: release main` squash `1b6c569`, tag `plugin-runtime-v0.86.1`, marketplace sync `0eb8807`.'),
    });
    strictEqual(r.checked, 1);
    ok(r.findings.some((f) => /squash\/merge 1b6c569/.test(f.detail)), `expected a squash mismatch, got: ${JSON.stringify(r.findings)}`);
  });

  it('catches the #640 defect shape: correct squash+tag, wrong PR number', () => {
    // The other half of the same defect. 82cf981 IS v0.86.1's commit, so
    // a value-only check passes here; only the PR number is wrong, and it
    // is recoverable because the release was squash-merged.
    const r = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #630 (`chore: release main`, squash `82cf981`) cut tag `plugin-runtime-v0.86.1` with marketplace sync commit `0eb8807`.'),
    });
    strictEqual(r.checked, 1);
    ok(r.findings.some((f) => /released by PR #638.*docs pair it with PR #630/.test(f.detail)), `expected a PR-number mismatch, got: ${JSON.stringify(r.findings)}`);
  });

  it('CONTROL: the corrected triple produces no finding', () => {
    const r = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #642 `chore: release main` squash `9e2af7d`, tag `plugin-runtime-v0.86.2`, marketplace sync `668c325`.'),
    });
    strictEqual(r.checked, 1);
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('does not pair a tag with a neighbouring release PR\'s squash', () => {
    // The real scorecard sentence that produced a false positive from a
    // leftmost-first extractor. cb720e7 belongs to feature PR #555;
    // 558f78a is v0.79.0's release commit.
    const r = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'on the then-installed runtime 0.79.0 (feature PR #555 squash `cb720e7`, behind ADR authoring PR #553; release PR #556 squash `558f78a`, tag plugin-runtime-v0.79.0 — backticks deliberately omitted).'),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('tolerates a pre-squash-merge release whose PR number is not in the commit subject', () => {
    // PR #106 released v0.5.0 through a merge commit whose subject is
    // bare `chore: release main`. The PR number is unverifiable offline
    // and must be counted, not reported as a defect.
    const r = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR [#106](https://github.com/each4all/agentic-plugins/pull/106) released `plugin-runtime` v0.5.0, with tag `plugin-runtime-v0.5.0` and marketplace sync commit `ba4f5ff`.'),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
    strictEqual(r.unverifiablePrNumbers, 1);
  });

  it('names the tags it actually paired, so a silently dropped claim is visible', () => {
    // An aggregate "checked > 20" cannot notice one claim falling out of
    // the extractor's window (cross-host review finding). Pin the recent
    // releases by name, and surface the count of tag mentions the
    // extractor declined to pair so coverage loss is reportable rather
    // than invisible.
    const r = checkReleaseTriples(REPO_ROOT, { docs: realDocs() });
    // Tags that genuinely carry a release triple in the current docs.
    // 0.86.0/0.86.1 are deliberately absent: their records were absorbed
    // in place by the later recovery PRs, which is the repo's editorial
    // pattern for same-loop patch releases.
    for (const tag of ['plugin-runtime-v0.86.2', 'plugin-runtime-v0.85.0', 'plugin-runtime-v0.82.0', 'plugin-runtime-v0.78.1']) {
      ok(r.checkedTags.includes(tag), `${tag} must be paired with its release PR, got: ${r.checkedTags.join(', ')}`);
    }
    ok(typeof r.unpairedTags === 'number', 'unpaired tag mentions are counted, not hidden');
  });

  it('relates the marketplace sync sha to the release commit', () => {
    // The sync sha was carried in the prose but never checked against
    // anything, so swapping it for the previous release's produced zero
    // findings (round-2 cross-host review finding). It is the child of
    // the release commit, so the relation is verifiable.
    const bad = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #642 squash `9e2af7d`, tag `plugin-runtime-v0.86.2`, marketplace sync `0eb8807`.'),
    });
    ok(bad.findings.some((f) => /marketplace sync 0eb8807/.test(f.detail)), JSON.stringify(bad.findings));

    const good = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #642 squash `9e2af7d`, tag `plugin-runtime-v0.86.2`, marketplace sync `668c325`.'),
    });
    strictEqual(good.findings.length, 0, JSON.stringify(good.findings));
  });

  it('catches a tag that does not exist at all', () => {
    const r = checkReleaseTriples(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #642 squash `9e2af7d`, tag `plugin-runtime-v9.99.9`.'),
    });
    ok(r.findings.some((f) => /no such tag exists/.test(f.detail)), JSON.stringify(r.findings));
  });
});

describe('doc evidence — R2 proof citations', () => {
  it('finds no stale or self-contradicting proof citation in the checked-in docs', () => {
    const r = checkProofCitations(REPO_ROOT, { docs: realDocs() });
    strictEqual(r.ran, true);
    strictEqual(r.findings.length, 0, r.findings.map((f) => `${f.file}: ${f.detail}`).join('\n'));
    ok(r.checked > 0, 'the current-record anchor still matches the real documents');
    // Pin the id/date coverage floor. Without it, a doc edit that strips
    // the `Z` from the dates beside superseded ids would silently drop
    // them from the check and stay green (round-2 cross-host review
    // finding); the count fell from 47 to 46 in that experiment.
    // Phrase-bound pairs, not proximity pairs. Every construction the
    // docs use to bind a date to a run id is exact-matched, so the count
    // is a real coverage figure rather than a window artefact.
    ok(r.dateChecked >= 30, `expected the superseded history to stay covered, dateChecked=${r.dateChecked}`);
  });

  it('catches a current record left citing the previous run id', () => {
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', [
        'Latest installed proof: `plugin-runtime` `0.86.2` carries the proof re-recorded on 2026-07-25Z as `doctor-20260725T020157Z-61e7d6`.',
        'A superseded note mentions `doctor-20260726T014023Z-1b377b` elsewhere in the file.',
      ].join(' ')),
    });
    ok(r.findings.some((f) => f.check === 'proof-citation-staleness'), JSON.stringify(r.findings));
  });

  it('catches a date bumped without its run id', () => {
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'Latest installed proof: `plugin-runtime` `0.86.2` carries the proof re-recorded on 2026-07-26Z as `doctor-20260725T020157Z-61e7d6`.'),
    });
    ok(r.findings.some((f) => f.check === 'proof-citation-date'), JSON.stringify(r.findings));
  });

  it('CONTROL: a coherent current record produces no finding', () => {
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'Latest installed proof: `plugin-runtime` `0.86.2` carries the proof re-recorded on 2026-07-26Z as `doctor-20260726T014023Z-1b377b`.'),
    });
    strictEqual(r.checked, 1, 'the anchor fired on this fixture');
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('checks id/date agreement on SUPERSEDED records too, not only the current one', () => {
    // Restricting the date check to ids reachable from a current anchor
    // left the packed history ungated — 25 ids in one DEVELOPMENT.md line
    // and 20 in the scorecard R3 row — which is the opposite of this
    // module's stated motivation (cross-host review finding).
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', [
        'Installed `plugin-runtime` `0.86.2` carries the proof recorded on 2026-07-26Z as `doctor-20260726T014023Z-1b377b`.',
        'This supersedes the record re-recorded on 2026-07-23Z as doctor-20260722T012908Z-472538.',
      ].join(' ')),
    });
    ok(r.findings.some((f) => f.check === 'proof-citation-date' && f.runId.startsWith('doctor-20260722')), JSON.stringify(r.findings));
  });

  it('binds dates by citation phrase, so proximity cannot create or hide a finding', () => {
    // Proximity was abandoned on measurement: taking each id's nearest
    // date anywhere in the document, agreeing pairs sit at 13-56, 86,
    // 127, ... 707 characters and disagreeing ones at 75, 162, ... 927 —
    // they interleave from 75 onward, so NO threshold separates them
    // (round-4 cross-host review finding). An earlier +-64 bound came
    // from a biased sample measured inside an +-80 window.
    const inPhrase = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'the 2026-07-26Z loop closed; the proof recorded on 2026-07-25Z as `doctor-20260726T014023Z-1b377b` passed.'),
    });
    ok(inPhrase.findings.some((f) => f.check === 'proof-citation-date'), JSON.stringify(inPhrase.findings));

    // Real prose from the scorecard: the date belongs to a baseline
    // refresh 75 characters away, not to the proof.
    const outOfPhrase = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'the `baseline` `stale` caveat that the 2026-07-10 baseline refresh later closed), the prior 0.77.1-native proof (`doctor-20260709T141930Z-515ebf`, parity `ready`).'),
    });
    strictEqual(outOfPhrase.findings.length, 0, JSON.stringify(outOfPhrase.findings));
  });

  it('still catches an id/date mismatch when the date has no trailing Z', () => {
    // Requiring the `Z` meant dropping one character removed the id from
    // the scan entirely and silently; no count floor could see it,
    // because the documents legitimately carry many ids with no adjacent
    // date at all (round-3 cross-host review finding).
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'recorded on 2026-07-25 as `doctor-20260726T014023Z-1b377b`.'),
    });
    ok(r.findings.some((f) => f.check === 'proof-citation-date'), JSON.stringify(r.findings));
  });

  it('does not reach past a citation to borrow an unrelated nearby date', () => {
    // The real scorecard writes "the 2026-07-10 baseline refresh later
    // closed), the prior 0.77.1-native proof (`doctor-20260709…`)" — the
    // date belongs to a baseline refresh, not the proof. Measured: dates
    // that agree sit 13-56 characters out, this one sits 75.
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'the `baseline` `stale` caveat that the 2026-07-10 baseline refresh later closed), the prior 0.77.1-native proof (`doctor-20260709T141930Z-515ebf`, parity `ready`).'),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('does not mistake a superseded record for the current one', () => {
    // The scorecard R3 row repeats "re-recorded under the <version>
    // install on <date> (<id>" five times, once current and four times
    // superseded. Only the backticked current version token marks the
    // live record; a first implementation of this check matched all five
    // and reported four false stale citations.
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', [
        'Installed `plugin-runtime` `0.86.2` carries the proof re-recorded under the 0.86.2 install on 2026-07-26Z (doctor-20260726T014023Z-1b377b, overall pass).',
        'This supersedes the 0.85.0-native record re-recorded under the 0.85.0 install on 2026-07-22Z (doctor-20260722T012908Z-472538) and the 0.82.0-native record re-recorded under the 0.82.0 install on 2026-07-19Z (doctor-20260719T071752Z-6392f1).',
      ].join(' ')),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });
});

// The extractor is tested directly, by SHAPE, rather than only through a
// check's aggregate counts. An aggregate cannot tell a rule that stopped
// matching from a document that stopped saying it — which is how the
// shipped rule silently dropped nine real citations, six of them from a
// document that was already in scope.
//
// Every negative fixture below is a class that was MEASURED in this
// repository, not a hypothetical. The count beside each is what a
// superset sweep found before the rule existed.
describe('doc evidence — the sha extractor', () => {
  const POSITIVE = [
    ['backticked', 'squash `9e2af7d` landed', ['9e2af7d']],
    ['bare after a PR number', 'the pair #641 af620df shipped', ['af620df']],
    // The two the ADR corpus was blocked on.
    ['inside double quotes', 'the recurrence class of ADR-0016 §"28b5eb8 incident".', ['28b5eb8']],
    ['closing a longer code span', 'a host version (`Codex 0.145.0 … af620df`); filtering', ['af620df']],
    ['opening a longer code span', 'the surface that commit `dba7e1a feat(runtime): report consensus` added', ['dba7e1a']],
    // Six of the nine were in the scorecard, already gated, in this shape.
    ['slash-separated list', '§7 commits 123e9a0/e9d5a1c/1a3c5c6/0bdbdd5; release PR #616', ['123e9a0', 'e9d5a1c', '1a3c5c6', '0bdbdd5']],
    ['a markdown list item', '- af620df landed on main', ['af620df']],
    ['a commit URL in THIS repository', 'https://github.com/each4all/agentic-plugins/commit/af620df', ['af620df']],
    ['split across a hard wrap', 'the squash\n`9e2af7d` closed it', ['9e2af7d']],
    // The digest mask must not eat a LIST of shas. A first version masked
    // any hex-and-whitespace code span over 40 hex characters, so these
    // two fixtures extracted nothing at all (cross-host review finding).
    ['several shas in one code span', 'commits `deadbee badcafe decafed cabbace fadfade beeface`',
      ['deadbee', 'badcafe', 'decafed', 'cabbace', 'fadfade', 'beeface']],
    ['two full shas in one code span', 'range `af620df40d54f385f933923ad0004a3962babb33 2d6a66793a16234ebc58d2b94690797f6002eacf`',
      ['af620df40d54f385f933923ad0004a3962babb33', '2d6a66793a16234ebc58d2b94690797f6002eacf']],
    ['ours, beside an external link', 'unlike https://github.com/other/repo/commit/1111111, ours is `af620df`', ['af620df']],
  ];

  for (const [label, text, expected] of POSITIVE) {
    it(`extracts a citation ${label}`, () => {
      deepStrictEqual(extractCitedShas(text), expected);
    });
  }

  const NEGATIVE = [
    // 25 occurrences across the ADRs: the English word "feedback" opens
    // with seven hex characters, so a boundary rule that ignores letters
    // turns every one of them into a "does not resolve" finding.
    ['the word "feedback"', 'per memory `feedback_decision_methodology_quality_axes`, apply critique/feedback'],
    ['the word "succeeded"', 'When the list probe succeeded, the list is the source of truth'],
    // 51 occurrences: the date half of a run id is eight hex-valid digits.
    ['a run id date component', 'run `investigate-20260505T120000Z-a3b7c2`'],
    // 15 occurrences — the class behind the remembered "15 of 71
    // unresolved" reading, which was never a set of dangling citations.
    ['a run id hex suffix', 'Plan-verify (run_id `plan-verify-20260526T012732Z-1a205273`) raised G2'],
    ['a run id with no verb prefix', 'ensemble AGREED, run_id `20260512T061534Z-cdb584`'],
    ['a hyphenated proof subject', 'on their phone (subject `egress-proof-5f00461ebdc9`) and the receipt'],
    ['a bare hyphenated proof subject', 'receipt (subject egress-proof-5f00461ebdc9) attested separately'],
    // Elided digests: 63119f47 and 23882a3a are hex runs in range, and
    // the ellipsis is what says they are fragments.
    ['an elided digest', 'Read-only plan (`plan_hash sha256:63119f47…4131a`, `scan_complete: true`)'],
    ['a doubly elided digest', 'recomputed `…23882a3a…` | No cited local evidence'],
    // A commit in ANOTHER repository. It is a real citation, but not a
    // claim about this repository's history, so resolving it locally is
    // meaningless: it would be reported unresolvable unless it happened to
    // collide with a local object, in which case it would pass for the
    // wrong reason (cross-host review finding). Being qualified by a
    // different owner/repo IS the exception grammar — no reviewed
    // allowlist has to be kept current.
    ['a commit URL in another repository', 'fixed upstream in https://github.com/openai/codex/commit/deadbee1234'],
    ['a commit URL in another org', 'see https://github.com/anthropics/claude-code/commit/1234567 for context'],
  ];

  for (const [label, text] of NEGATIVE) {
    it(`does not extract ${label}`, () => {
      deepStrictEqual(extractCitedShas(text), []);
    });
  }

  it('does not extract a 64-hex content digest, wrapped or not', () => {
    // The scorecard and DEVELOPMENT.md carry nine of these (whole-tree and
    // packaged-baseline hashes), five of them distinct — the count was six
    // when this was written and drifts with every recovery, so it is a
    // measurement of the corpus, not a bound this test enforces. All nine
    // are unwrapped today; the wrapped form is covered because one reflow
    // would produce it, and this is its only exercise.
    const long = 'a'.repeat(64);
    deepStrictEqual(extractCitedShas(`the reviewed plan hash \`${long}\``), []);
    deepStrictEqual(extractCitedShas(`its wrapped form \`${long.slice(0, 49)}\n${long.slice(49)}\``), []);
  });

  it('keeps a real citation that merely sits near an ellipsis', () => {
    // The elision rule is immediate adjacency, not proximity: ADR-0049
    // writes `Codex 0.145.0 … af620df`, where a space separates the
    // ellipsis from a genuine citation. A proximity rule would drop it,
    // which is the false negative this whole slice exists to close.
    deepStrictEqual(extractCitedShas('(`Codex 0.145.0 … af620df`)'), ['af620df']);
  });

  it('does not treat all-decimal tokens as a class to be excluded', () => {
    // Tempting, because `position 987654321` in plugins/runtime/docs reads
    // as a false positive. Measured, it is unsafe: 4 of the 442 citations
    // in this corpus are all-decimal, and 35 of the repository's 918
    // commits have an all-decimal 7-character abbreviation. The corpus
    // boundary excludes that document instead — see discoverShaCorpus.
    deepStrictEqual(extractCitedShas('squash `1424051` closed it'), ['1424051']);
  });
});

describe('doc evidence — the sha corpus is discovered, not enumerated', () => {
  it('reaches the ADR corpus, by file identity rather than a count', () => {
    // A count floor cannot notice a discovery rule that stopped finding a
    // directory: the total would fall, but so does a total when prose is
    // edited. Pin the files whose citations this slice brought into
    // scope, and one already-gated file so a regression to the old
    // enumeration is visible too.
    const corpus = discoverShaCorpus(REPO_ROOT);
    for (const file of [
      'docs/adr/0028-engineer-phase7-commit-automation.md',
      'docs/adr/0049-evidence-as-data.md',
      // Superseded records get no file-level exemption. ADR-0014 was
      // superseded for its timeline portion and still cites 28b5eb8 and
      // 944fd4e; a citation does not stop needing to resolve because the
      // decision around it was revised.
      'docs/adr/0014-plugins-research-deprecation.md',
      'docs/assurance/runtime-consensus-dogfood-2026-05-29.md',
      'AGENTS.md',
      ...EVIDENCE_DOCS,
    ]) {
      ok(corpus.includes(file), `${file} must be in the sha corpus`);
    }
  });

  it('excludes the packages, where the generated changelogs live', () => {
    const corpus = discoverShaCorpus(REPO_ROOT);
    strictEqual(
      corpus.filter((f) => f.startsWith('plugins/') || f.startsWith('companions/')).length, 0,
      'package docs are out of scope — admitting them would force an unsafe all-decimal rule',
    );
    strictEqual(
      corpus.filter((f) => f.endsWith(SHA_CORPUS_EXCLUDED_BASENAME)).length, 0,
      'no generated changelog is in the corpus',
    );
    // Nothing nested outside the declared roots.
    for (const file of corpus) {
      ok(!file.includes('/') || SHA_CORPUS_DIRS.some((d) => file.startsWith(`${d}/`)), `${file} is outside the declared roots`);
    }
  });

  it('excludes a changelog by NAME, not only by where the nine happen to sit', () => {
    // The assertion above is vacuous on today's tree and mutation testing
    // proved it: all nine changelogs are under `plugins/` or
    // `companions/`, so the directory rule alone satisfies it and deleting
    // the basename clause changed nothing. The clause is only verifiable
    // against a path that WOULD otherwise be in scope.
    strictEqual(isShaCorpusFile('CHANGELOG.md'), false, 'a root changelog is generated content, not evidence prose');
    strictEqual(isShaCorpusFile('docs/CHANGELOG.md'), false);
    strictEqual(isShaCorpusFile('docs/adr/CHANGELOG.md'), false);
    // Controls: the clause must key on the whole basename, and must not
    // swallow a document that merely mentions the word.
    strictEqual(isShaCorpusFile('docs/CHANGELOG-policy.md'), true);
    strictEqual(isShaCorpusFile('docs/adr/0016-cross-package-commit-splitting.md'), true);
    strictEqual(isShaCorpusFile('AGENTS.md'), true);
    strictEqual(isShaCorpusFile('plugins/runtime/docs/follow-ups.md'), false);
    strictEqual(isShaCorpusFile('docs/adr/README'), false, 'only markdown is scanned');
  });

  it('is deterministic and sorted', () => {
    const a = discoverShaCorpus(REPO_ROOT);
    deepStrictEqual(a, discoverShaCorpus(REPO_ROOT));
    deepStrictEqual(a, [...a].sort());
    ok(a.length > 50, `expected the docs tree, got ${a.length} file(s)`);
  });

  it('actually reads those files — a planted sha in a real ADR is caught', () => {
    // Corpus membership alone proves nothing: the file could be listed and
    // never read. Plant a dangling sha into the REAL text of an ADR this
    // slice brought into scope, and require the finding to name that file.
    const file = 'docs/adr/0028-engineer-phase7-commit-automation.md';
    const real = realFile(file);
    const clean = checkCommitShas(REPO_ROOT, { docs: [real] });
    strictEqual(clean.findings.length, 0, JSON.stringify(clean.findings));
    ok(clean.checked >= 3, `the real ADR must contribute citations, checked ${clean.checked}`);

    const planted = checkCommitShas(REPO_ROOT, {
      docs: [{ file, text: `${real.text}\n\nA fabricated citation \`deadbee\` sits here.\n` }],
    });
    ok(
      planted.findings.some((f) => f.file === file && f.sha === 'deadbee' && /does not resolve/.test(f.detail)),
      JSON.stringify(planted.findings),
    );
  });

  it('checks the quote-wrapped citation the old extractor could not see', () => {
    // The end-to-end version of the extractor unit test: 28b5eb8 is a real
    // reachable commit cited inside quotes in ADR-0028, and the shipped
    // rule required a delimiter from a closed set that quotes are not in.
    const r = checkCommitShas(REPO_ROOT, {
      docs: [realFile('docs/adr/0028-engineer-phase7-commit-automation.md')],
    });
    ok(r.corpusFiles.includes('docs/adr/0028-engineer-phase7-commit-automation.md'));
    strictEqual(r.findings.length, 0);
    const shas = extractCitedShas(realFile('docs/adr/0028-engineer-phase7-commit-automation.md').text);
    ok(shas.includes('28b5eb8'), `expected 28b5eb8 among ${shas.join(', ')}`);
  });

  it('refuses to run when a discovered file is in the index but not on disk', () => {
    // Discovery reads the INDEX, so `rm doc.md` without `git rm` names a
    // file that cannot be opened — a state the enumerated list could not
    // reach. Skipping it silently would read as coverage; a bare ENOENT
    // would read as a crash. It is neither, so it reports as not-run.
    //
    // Built as a real repository rather than an injected fixture, because
    // the injected path never calls the reader at all — the defect only
    // exists on the discovery path.
    strictEqual(checkCommitShas(REPO_ROOT).ran, true, 'sanity: the real tree is intact');

    const tmp = mkdtempSync(resolve(tmpdir(), 'doc-evidence-missing-'));
    const run = (...args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
    try {
      run('init', '-q', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'test');
      mkdirSync(resolve(tmp, 'docs'), { recursive: true });
      writeFileSync(resolve(tmp, 'docs/present.md'), 'nothing cited here\n');
      writeFileSync(resolve(tmp, 'docs/vanishes.md'), 'a doc that will be removed\n');
      run('add', '-A');
      run('commit', '-qm', 'seed');
      run('tag', 'plugin-runtime-v0.0.1');

      const intact = checkCommitShas(tmp);
      strictEqual(intact.ran, true, `control: an intact tree runs — ${intact.reason}`);
      ok(intact.corpusFiles.includes('docs/vanishes.md'));

      // Remove from the working tree only; the index still lists it.
      rmSync(resolve(tmp, 'docs/vanishes.md'));
      const missing = checkCommitShas(tmp);
      strictEqual(missing.ran, false, 'a file the index names but the tree lacks must stop the check');
      ok(/could not be read/.test(missing.reason ?? ''), missing.reason);
      strictEqual(missing.findings.length, 0, 'a tree mid-edit is not a dangling citation');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('reports the corpus it used, so a silent discovery failure is visible', () => {
    const r = checkCommitShas(REPO_ROOT);
    ok(Array.isArray(r.corpusFiles), 'the corpus is reported');
    ok(r.corpusFiles.length > 50, `expected the docs tree, got ${r.corpusFiles.length}`);
    ok(r.corpusFiles.includes('docs/adr/0049-evidence-as-data.md'));
  });
});

describe('doc evidence — R4 commit shas', () => {
  it('finds no unresolvable or misattributed sha in the checked-in docs', () => {
    const r = checkCommitShas(REPO_ROOT, { docs: realDocs() });
    strictEqual(r.ran, true);
    strictEqual(r.findings.length, 0, r.findings.map((f) => `${f.file}: ${f.detail}`).join('\n'));
    // Backticked AND bare citations. Twelve shas appear only in the bare
    // "#641 af620df" form, and widening the scan to reach them
    // immediately surfaced a second dangling citation (round-5).
    ok(r.checked > 200, `expected the widened sha corpus, checked ${r.checked}`);
  });

  it('finds no unresolvable sha anywhere in the DISCOVERED corpus', () => {
    // The stage-doc assertion above is now the narrow case. This is the
    // one AGENTS.md's promise is actually about.
    const r = checkCommitShas(REPO_ROOT);
    strictEqual(r.ran, true);
    strictEqual(r.findings.length, 0, r.findings.map((f) => `${f.file}: ${f.detail}`).join('\n'));
    ok(r.checked > 400, `expected the discovered corpus, checked ${r.checked}`);
  });

  it('catches a sha that does not resolve in this repository', () => {
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #642 squash `deadbee`, tag `plugin-runtime-v0.86.2`.'),
    });
    ok(r.findings.some((f) => /does not resolve/.test(f.detail)), JSON.stringify(r.findings));
  });



  it('judges reachability from the integration branch, not the PR checkout', () => {
    // On a pull_request run the checkout is GitHub's synthetic merge ref,
    // whose history CONTAINS the PR's own branch commits — so a document
    // citing its own branch sha would pass CI and dangle the moment the
    // branch was squash-merged, which is exactly what this check exists
    // to prevent (round-2 cross-host review finding).
    const r = checkCommitShas(REPO_ROOT);
    ok(['origin/main', 'main'].includes(r.reachabilityBase),
      `expected an integration-branch base, got ${r.reachabilityBase}`);
  });

  it('catches a sha that resolves in this clone but is not in the branch history', () => {
    // The defect this check was rewritten for. `36b7ab1` was a
    // pre-squash branch commit from Stage 2 Deliverable D; it survives in
    // a long-lived clone but is on no branch, so CI's fresh checkout
    // could not resolve it — the first implementation asked "is this
    // object in my store", which is machine-dependent and gave a false
    // green locally while CI went red. The predicate is now reachability
    // from HEAD, which is identical on every machine: this test therefore
    // fails the same way in both places.
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'drove the Phase 6 resolve commit `36b7ab1`.'),
    });
    strictEqual(r.checked, 1);
    strictEqual(r.findings.length, 1, JSON.stringify(r.findings));
    ok(/not reachable from|does not resolve/.test(r.findings[0].detail), r.findings[0].detail);
  });

  it('CONTROL: the squash commit that carries that work is accepted', () => {
    // Proves the check above fails for the stated reason and not because
    // the extractor missed the fixture shape.
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'the work landed on main as `af12326`.'),
    });
    strictEqual(r.checked, 1);
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('judges reachability on the whole cited sha, not a 7-character prefix', () => {
    // The defect: reachability used to index the branch history by the
    // first seven characters and look citations up the same way, so a full
    // 40-character citation of an UNREACHABLE commit passed whenever its
    // first seven characters matched a reachable one.
    //
    // This repository has no such pair — 0 seven-character collisions
    // across all 918 commits on every ref — so the fixture is built rather
    // than found. A first version of this test declined to build one,
    // reasoning that a collision costs 16^7 objects; that is the cost of
    // hitting a CHOSEN prefix. Finding ANY colliding pair is a birthday
    // search, and it lands in ~26k objects and tens of milliseconds
    // (cross-host review finding — the claim was measured, not argued).
    //
    // The search is seeded from a counter so the pair is identical on
    // every run, and the assertion is two-sided: the reachable member must
    // pass and the unreachable one must fail, which is exactly what the
    // prefix index could not distinguish.
    const tmp = mkdtempSync(resolve(tmpdir(), 'doc-evidence-collision-'));
    const run = (...args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' }).trim();
    const write = (body) => execFileSync('git', ['-C', tmp, 'hash-object', '-w', '-t', 'commit', '--stdin'], { encoding: 'utf8', input: body }).trim();
    try {
      run('init', '-q', '-b', 'main');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'test');
      const tree = run('hash-object', '-w', '-t', 'tree', '--stdin', '--literally');

      const body = (n) => `tree ${tree}\nauthor t <t@e.invalid> ${1000000 + n} +0000\ncommitter t <t@e.invalid> ${1000000 + n} +0000\n\ncommit ${n}\n`;
      const seen = new Map();
      let pair = null;
      for (let n = 0; n < 500000 && !pair; n += 1) {
        const id = createHash('sha1').update(`commit ${Buffer.byteLength(body(n))}\0`).update(body(n)).digest('hex');
        const prefix = id.slice(0, 7);
        if (seen.has(prefix)) pair = [seen.get(prefix), { id, n }];
        else seen.set(prefix, { id, n });
      }
      ok(pair, 'a 7-character collision must be found within the budget');
      const [reachable, orphan] = pair;
      strictEqual(reachable.id.slice(0, 7), orphan.id.slice(0, 7), 'the pair collides on seven characters');
      ok(reachable.id !== orphan.id, 'and differs beyond them');

      strictEqual(write(body(reachable.n)), reachable.id, 'git agrees with the computed object id');
      strictEqual(write(body(orphan.n)), orphan.id);
      // Only one of them gets a ref. The other is a loose object: it
      // resolves through cat-file and is reachable from nothing.
      run('update-ref', 'refs/heads/main', reachable.id);
      run('tag', 'plugin-runtime-v0.0.1', reachable.id);

      const good = checkCommitShas(tmp, { docs: docsWith('planted.md', `landed as \`${reachable.id}\`.`) });
      strictEqual(good.ran, true, good.reason);
      strictEqual(good.checked, 1);
      strictEqual(good.findings.length, 0, `the reachable member must pass: ${JSON.stringify(good.findings)}`);

      const bad = checkCommitShas(tmp, { docs: docsWith('planted.md', `landed as \`${orphan.id}\`.`) });
      strictEqual(bad.checked, 1);
      ok(
        bad.findings.some((f) => /not reachable from/.test(f.detail)),
        `the orphan shares its 7-character prefix with a reachable commit and must still fail: ${JSON.stringify(bad.findings)}`,
      );

      // The abbreviation both of them share is genuinely ambiguous, and
      // git says so rather than silently picking one.
      const short = checkCommitShas(tmp, { docs: docsWith('planted.md', `landed as \`${reachable.id.slice(0, 7)}\`.`) });
      ok(short.findings.some((f) => /ambiguous/.test(f.detail)), JSON.stringify(short.findings));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('refuses to run where no integration branch exists', () => {
    // The HEAD fallback this replaced made the check pass on exactly the
    // branch-local citation it exists to reject: in a feature-only clone
    // the base silently became HEAD, whose history contains the branch, so
    // a pre-squash sha resolved AND read as reachable while the CLI still
    // exited 0 (cross-host review finding).
    const tmp = mkdtempSync(resolve(tmpdir(), 'doc-evidence-nobase-'));
    const run = (...args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' }).trim();
    try {
      run('init', '-q', '-b', 'feature-only');
      run('config', 'user.email', 'test@example.invalid');
      run('config', 'user.name', 'test');
      writeFileSync(resolve(tmp, 'seed.md'), 'seed\n');
      run('add', '-A');
      run('commit', '-qm', 'seed');
      run('tag', 'plugin-runtime-v0.0.1');
      const head = run('rev-parse', 'HEAD');

      const r = checkCommitShas(tmp, { docs: docsWith('planted.md', `landed as \`${head}\`.`) });
      strictEqual(r.ran, false, 'without origin/main or main the question cannot be answered');
      ok(/neither origin\/main nor main/.test(r.reason ?? ''), r.reason);

      // CONTROL: the same repository with an integration branch runs, and
      // the same citation is then genuinely reachable.
      run('branch', 'main');
      const withBase = checkCommitShas(tmp, { docs: docsWith('planted.md', `landed as \`${head}\`.`) });
      strictEqual(withBase.ran, true, withBase.reason);
      strictEqual(withBase.reachabilityBase, 'main');
      strictEqual(withBase.findings.length, 0, JSON.stringify(withBase.findings));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('does not mistake a 64-hex plan/attempt hash for a commit sha', () => {
    // The corpus cites six 64-hex hashes in backticks — four in the
    // scorecard, two in DEVELOPMENT.md. The 7-40 length bound plus the
    // alphanumeric-neighbour rule are what keep them out of the sha
    // corpus, so pin it: widening either would turn every one of them into
    // a false "does not resolve" finding. (The count read "eleven" before
    // it was measured — cross-host review finding.)
    const long = 'a'.repeat(64);
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', `the reviewed plan hash \`${long}\` and its wrapped form \`${long.slice(0, 49)} ${long.slice(49)}\``),
    });
    strictEqual(r.checked, 0, 'no 64-hex token is treated as a cited sha');
    strictEqual(r.findings.length, 0);
  });

  // The composite is what `npm run validate:doc-evidence` and the release
  // workflow actually run, and until now nothing asserted its shape: dropping
  // the ADR-0049 store from it, or reducing the exit decision to the three
  // prose keys, left every test green (cross-host review finding).
  describe('runAllChecks — the composite gate', () => {
    it('carries the three prose checks AND the evidence store', () => {
      const results = runAllChecks(REPO_ROOT);
      deepStrictEqual(
        Object.keys(results).sort(),
        ['commitShas', 'evidenceStore', 'proofCitations', 'releaseTriples'],
        'a check silently dropped from the composite is a gate that stopped running',
      );
      for (const [name, r] of Object.entries(results)) {
        ok(typeof r.ran === 'boolean', `${name} must report whether it ran`);
        ok(Array.isArray(r.findings), `${name} must report findings`);
        ok(typeof r.checked === 'number', `${name} must report a checked count the CLI can render`);
      }
    });

    it('is clean on the real repository', () => {
      const results = runAllChecks(REPO_ROOT);
      for (const [name, r] of Object.entries(results)) {
        ok(r.ran, `${name} could not run: ${r.reason}`);
        deepStrictEqual(r.findings, [], `${name} has findings`);
      }
    });

    it('adding the store did not change what the prose checks report', () => {
      // The store is an ADDITIONAL check, not a replacement — ADR-0049
      // Decision 5 keeps the prose hand-written and keeps its gates. If the
      // composite ever diverged from the standalone functions, one of the two
      // is not the gate anyone thinks it is.
      const results = runAllChecks(REPO_ROOT);
      deepStrictEqual(results.releaseTriples, checkReleaseTriples(REPO_ROOT));
      deepStrictEqual(results.proofCitations, checkProofCitations(REPO_ROOT));
      deepStrictEqual(results.commitShas, checkCommitShas(REPO_ROOT));
    });
  });
});
