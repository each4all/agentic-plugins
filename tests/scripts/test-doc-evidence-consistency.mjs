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
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  EVIDENCE_DOCS,
  checkReleaseTriples,
  checkProofCitations,
  checkCommitShas,
  gitHistoryAvailable,
} from '../../scripts/check-doc-evidence.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function realDocs() {
  return EVIDENCE_DOCS.map((file) => ({ file, text: readFileSync(resolve(REPO_ROOT, file), 'utf8') }));
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
    ok(r.dateChecked >= 45, `expected the superseded history to stay covered, dateChecked=${r.dateChecked}`);
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

  it('compares the NEAREST date, not any date in the window', () => {
    // `dates.includes(embedded)` let an explicitly wrong date pass
    // whenever a correct one happened to sit elsewhere within +-80
    // characters (cross-host review finding).
    const r = checkProofCitations(REPO_ROOT, {
      docs: docsWith('planted.md', 'the 2026-07-26Z loop closed; the proof recorded on 2026-07-25Z as `doctor-20260726T014023Z-1b377b` passed.'),
    });
    ok(r.findings.some((f) => f.check === 'proof-citation-date' && /stated next to it is 2026-07-25/.test(f.detail)), JSON.stringify(r.findings));
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

describe('doc evidence — R4 commit shas', () => {
  it('finds no unresolvable or misattributed sha in the checked-in docs', () => {
    const r = checkCommitShas(REPO_ROOT, { docs: realDocs() });
    strictEqual(r.ran, true);
    strictEqual(r.findings.length, 0, r.findings.map((f) => `${f.file}: ${f.detail}`).join('\n'));
    ok(r.checked > 100, `expected the real sha corpus, checked ${r.checked}`);
  });

  it('catches a sha that does not resolve in this repository', () => {
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'release PR #642 squash `deadbee`, tag `plugin-runtime-v0.86.2`.'),
    });
    ok(r.findings.some((f) => /does not resolve/.test(f.detail)), JSON.stringify(r.findings));
  });

  it('catches a sha attributed to the wrong release', () => {
    // af620df is a 0.86.2 fix per the runtime changelog.
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'then the 0.86.1 egress hardening pair #641 `af620df` landed'),
    });
    ok(r.findings.some((f) => f.check === 'commit-sha-attribution' && /places .* in 0\.86\.2.*attributes it to 0\.86\.1/.test(f.detail)), JSON.stringify(r.findings));
  });

  it('CONTROL: the same sha attributed to its real release produces no finding', () => {
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'then the 0.86.2 egress hardening pair #641 `af620df` landed'),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
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

  it('does not mistake a 64-hex plan/attempt hash for a commit sha', () => {
    // The scorecard cites eleven 64-hex hashes in backticks, hard-wrapped
    // across lines. The 7-40 length bound is the only thing keeping them
    // out of the sha corpus, so pin it: a widened bound would turn every
    // one of them into a false "does not resolve" finding.
    const long = 'a'.repeat(64);
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', `the reviewed plan hash \`${long}\` and its wrapped form \`${long.slice(0, 49)} ${long.slice(49)}\``),
    });
    strictEqual(r.checked, 0, 'no 64-hex token is treated as a cited sha');
    strictEqual(r.findings.length, 0);
  });

  it('does not let a HOST version claim a runtime commit', () => {
    // Any whitespace-prefixed semver used to qualify as an attribution,
    // so "Codex 0.145.0 ... `af620df`" reported the runtime commit as
    // misattributed to a Codex version (round-2 cross-host review
    // finding). Candidates are now filtered to versions the runtime
    // changelog actually released.
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'observed on Codex 0.145.0 alongside `af620df`'),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('recognises the installed-state `plugin-runtime` `X` form', () => {
    // The repository's own installed-state phrasing was unrecognised, so
    // a wrong sha beside it produced no finding (round-3 cross-host
    // review finding).
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'installed `plugin-runtime` `0.86.1` carries `af620df`'),
    });
    ok(r.findings.some((f) => f.check === 'commit-sha-attribution'), JSON.stringify(r.findings));
  });

  it('does not let a host version that collides with a runtime version claim a commit', () => {
    // Filtering to released runtime versions was not enough: Codex 0.86.1
    // would be a valid runtime version too (round-3 cross-host review
    // finding).
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'observed on Codex 0.86.1 alongside `af620df`'),
    });
    strictEqual(r.findings.length, 0, JSON.stringify(r.findings));
  });

  it('recognises the canonical `plugin-runtime` vX prose form', () => {
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'as of `plugin-runtime` v0.86.1 the pair `af620df` landed'),
    });
    ok(r.findings.some((f) => f.check === 'commit-sha-attribution'), JSON.stringify(r.findings));
  });

  it('recognises a `plugin-runtime-vX` literal as the attributed version', () => {
    // The most common way these documents name a version was not matched
    // at all, because the pattern required whitespace or "(" ahead of the
    // digits (cross-host review finding). af620df is a 0.86.2 fix.
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'tag plugin-runtime-v0.86.1 shipped the pair `af620df`'),
    });
    ok(r.findings.some((f) => f.check === 'commit-sha-attribution'), `expected the tag literal to attribute, got ${r.unattributed} unattributed`);
  });

  it('treats a semicolon as a clause break, not only a period', () => {
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'the 0.86.1 loop closed; an unrelated note cites `af620df` in passing'),
    });
    strictEqual(r.findings.length, 0, `must not attribute across the semicolon: ${JSON.stringify(r.findings)}`);
    strictEqual(r.unattributed, 1);
  });

  it('leaves a sha unattributed rather than guessing across a sentence boundary', () => {
    const r = checkCommitShas(REPO_ROOT, {
      docs: docsWith('planted.md', 'The 0.86.1 loop closed. A later note cites `af620df` without naming a release.'),
    });
    strictEqual(r.findings.length, 0, 'no guess is made');
    strictEqual(r.unattributed, 1, 'and the ambiguity is counted, not hidden');
  });
});
