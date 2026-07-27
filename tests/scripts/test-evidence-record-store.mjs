// ADR-0049 evidence store — schema, meta-check, and validator.
//
// Design note that matters more than any single case here: the derived checks
// run against the REAL repository history, with records injected rather than
// written to disk. Fabricating a throwaway git history would prove only that
// the checker agrees with the fixture generator; pointing it at this repo's
// actual tags and commits is what shows it bites. Every negative case is a
// MUTATION of a record that passes — the positive control is asserted first in
// each group, so a case cannot pass vacuously by failing for some unrelated
// reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkSchemaShape, loadSchema, validateInstance } from '../../scripts/lib/evidence-schema.mjs';
import { checkProof, checkStore, historyAvailable, SCHEMA_PATH } from '../../scripts/lib/evidence-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = loadSchema(path.resolve(REPO_ROOT, SCHEMA_PATH));

const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();

// Real facts from this repository. Resolved at run time rather than pasted, so
// the fixture cannot silently rot into an abbreviation that no longer resolves.
const RELEASE_TAG = 'plugin-runtime-v0.86.2';
const RELEASE_COMMIT = git('rev-parse', `${RELEASE_TAG}^{commit}`);   // subject: chore: release main (#642)
const SYNC_COMMIT = git('rev-parse', '668c325^{commit}');             // chore(marketplace): sync catalog versions...
const PR_IN_SUBJECT = git('rev-parse', 'b984dc8^{commit}');           // subject ends with (#637)
const NO_PR_IN_SUBJECT = git('rev-parse', 'af620df^{commit}');        // no (#N) — its PR lives only in prose
// plugin-attention-v0.6.0 and plugin-runtime-v0.83.0 are the SAME commit, which
// is why a tag-time manifest read alone is not enough (Amendment item 2).
const SHARED_COMMIT_ATTENTION_TAG = 'plugin-attention-v0.6.0';

const deep = (v) => JSON.parse(JSON.stringify(v));

function validRecord() {
  return {
    schema: 'evidence-record-1.0',
    record_id: 'loop-fixture',
    evidence_loop: { label: 'fixture loop', summary: 'A record built from real repository facts, for tests only.' },
    package_releases: [{
      package: 'plugins/runtime',
      version: '0.86.2',
      tag: RELEASE_TAG,
      release_pr: 642,
      squash: RELEASE_COMMIT,
      marketplace_sync: SYNC_COMMIT,
    }],
    feature_commits: [{ sha: PR_IN_SUBJECT, pr: 637 }],
    hardening_commits: [{ sha: NO_PR_IN_SUBJECT, pr_attested: 641 }],
    proofs: [{
      // No artifact exists for this id, so the observed check reports
      // `unverified` — the CI case, exercised deliberately.
      run_id: 'doctor-20000101T000000Z-abcdef',
      date: '2000-01-01',
      command: 'runtime:doctor --permission-proof --execute-permission-proof',
      artifact_sha256: `sha256:${'0'.repeat(64)}`,
      runtime_version: '0.86.2',
      installed: { claude: '0.86.2', codex: null },
    }],
    install_method: 'claude plugin update (host-native)',
    narrative: 'Fixture.',
    relations: [],
  };
}

const asStore = (record, stem = record.record_id) => [{ file: `records/${stem}.json`, stem, data: record }];
const run = (record, stem) => checkStore(REPO_ROOT, { records: asStore(record, stem) });
const details = (findings) => findings.map((f) => `${f.check}:${f.detail}`).join('\n');

// ---------------------------------------------------------------------------

test('the shipped schema satisfies its own meta-check', () => {
  assert.deepEqual(checkSchemaShape(SCHEMA), []);
});

test('meta-check bites on each way a schema can lose its provenance guarantee', async (t) => {
  // Control first: without it, every mutation below could be "failing" for a
  // reason that has nothing to do with the mutation.
  await t.test('control — unmutated schema is clean', () => {
    assert.deepEqual(checkSchemaShape(deep(SCHEMA)), []);
  });

  // Missing and wrong are DIFFERENT authoring mistakes and must report
  // differently. Asserting only `check === 'provenance'` let a mutation that
  // deleted the missing-branch pass, because the wrong-class branch then
  // caught `undefined` and reported it under the same check name — the test
  // read as covering a branch it never pinned.
  await t.test('a property with no x-provenance', () => {
    const s = deep(SCHEMA);
    delete s.properties.narrative['x-provenance'];
    const f = checkSchemaShape(s);
    assert.ok(
      f.some((x) => x.check === 'provenance' && x.path === '$.narrative' && x.detail === 'property declares no `x-provenance`'),
      details(f),
    );
  });

  await t.test('a provenance class outside the closed set reports differently', () => {
    const s = deep(SCHEMA);
    s.properties.narrative['x-provenance'] = 'inferred';
    const f = checkSchemaShape(s);
    const hit = f.find((x) => x.check === 'provenance' && x.path === '$.narrative');
    assert.ok(hit, details(f));
    assert.match(hit.detail, /must be one of/);
    assert.match(hit.detail, /"inferred"/);
    assert.notEqual(hit.detail, 'property declares no `x-provenance`');
  });

  await t.test('a per-loop array claiming derived membership', () => {
    const s = deep(SCHEMA);
    s.properties.feature_commits['x-provenance'] = 'derived';
    const f = checkSchemaShape(s);
    assert.ok(f.some((x) => x.path === '$.feature_commits' && /membership must be/.test(x.detail)), details(f));
  });

  await t.test('a nested (non-per-loop) array may be observed — the rule is scoped', () => {
    // Regression pin for the over-broad first cut of this rule, which forced
    // `authored` onto a proof's `readings` (which readings a doctor run
    // emitted is observed along with the run, not an editorial choice).
    const s = deep(SCHEMA);
    assert.equal(s.$defs.proof.properties.readings['x-provenance'], 'observed');
    assert.deepEqual(checkSchemaShape(s), []);
  });

  await t.test('an unsupported keyword is an error, not a skip', () => {
    const s = deep(SCHEMA);
    s.properties.narrative.minLength = 3;
    const f = checkSchemaShape(s);
    assert.ok(f.some((x) => /unsupported schema keyword/.test(x.detail)), details(f));
  });

  await t.test('a supported keyword with a malformed operand is an error too', () => {
    // An allowlist alone accepts `maxLength: "twelve"` and then enforces
    // nothing — a constraint that reads as a constraint and is not one. A
    // cross-host review demonstrated exactly that mutation surviving the suite.
    for (const [key, bad] of [['maxLength', 'twelve'], ['minItems', -1], ['enum', []], ['required', [7]], ['pattern', '[unterminated']]) {
      const s = deep(SCHEMA);
      s.properties.narrative[key] = bad;
      const f = checkSchemaShape(s);
      assert.ok(f.some((x) => x.detail.startsWith(`\`${key}\``)), `${key}: ${details(f)}`);
    }
    // And the operand check bites at validation time too: a bad maxLength must
    // not silently permit an over-long value.
    const s = deep(SCHEMA);
    s.properties.narrative.maxLength = 'twelve';
    assert.notDeepEqual(checkSchemaShape(s), []);
  });

  await t.test('membership sees through a $ref', () => {
    // Moving the array behind a definition must not evade the rule — the
    // property still is an array and still is a membership question.
    const s = deep(SCHEMA);
    s.$defs.commitList = { type: 'array', maxItems: 4, items: { $ref: '#/$defs/commitEntry' } };
    s.properties.feature_commits = { 'x-provenance': 'derived', $ref: '#/$defs/commitList' };
    const f = checkSchemaShape(s);
    assert.ok(f.some((x) => x.path === '$.feature_commits' && /membership must be/.test(x.detail)), details(f));
  });

  await t.test('an object with properties must be closed', () => {
    const s = deep(SCHEMA);
    delete s.properties.evidence_loop.additionalProperties;
    const f = checkSchemaShape(s);
    assert.ok(f.some((x) => /not closed/.test(x.detail)), details(f));
  });

  await t.test('a $ref to a missing definition', () => {
    const s = deep(SCHEMA);
    s.properties.record_id.$ref = '#/$defs/nope';
    const f = checkSchemaShape(s);
    assert.ok(f.some((x) => /not defined in \$defs/.test(x.detail)), details(f));
  });

  await t.test('an unreferenced definition', () => {
    const s = deep(SCHEMA);
    s.$defs.orphan = { type: 'string' };
    const f = checkSchemaShape(s);
    assert.ok(f.some((x) => x.path === '$defs.orphan' && /never referenced/.test(x.detail)), details(f));
  });

  await t.test('definition order does not manufacture an unreferenced finding', () => {
    // fullSha is referenced only from packageRelease/commitEntry, which sort
    // AFTER it. An order-sensitive walk reported it unreferenced.
    const s = deep(SCHEMA);
    assert.ok(Object.keys(s.$defs).indexOf('fullSha') < Object.keys(s.$defs).indexOf('packageRelease'));
    assert.deepEqual(checkSchemaShape(s).filter((x) => /never referenced/.test(x.detail)), []);
  });
});

test('instance validation enforces the closed shape', async (t) => {
  await t.test('control — the fixture record validates', () => {
    assert.deepEqual(validateInstance(validRecord(), SCHEMA), []);
  });

  await t.test('closure is enforced without an explicit properties map', () => {
    // Nesting the check under `properties` made a bare
    // `additionalProperties: false` a no-op, so a node that closed an object
    // without enumerating it accepted anything at all.
    const bare = { type: 'object', additionalProperties: false };
    assert.deepEqual(validateInstance({}, bare), []);
    const f = validateInstance({ smuggled: 1 }, bare);
    assert.ok(f.some((x) => /not allowed \(schema is closed\)/.test(x.detail)), details(f));
  });

  const cases = [
    ['an unknown top-level property', (r) => { r.extra = 1; }, /not allowed/],
    ['a missing required property', (r) => { delete r.narrative; }, /required property is missing/],
    ['the wrong schema id', (r) => { r.schema = 'evidence-record-2.0'; }, /expected const/],
    ['an abbreviated sha', (r) => { r.feature_commits[0].sha = 'b984dc8'; }, /does not match pattern/],
    ['a package outside the release-please set', (r) => { r.package_releases[0].package = 'plugins/nope'; }, /is not one of/],
    ['a relation type outside the closed set', (r) => { r.relations.push({ type: 'inspires', record_id: 'x' }); }, /is not one of/],
    ['an empty package_releases', (r) => { r.package_releases = []; }, /fewer than minItems/],
    ['a malformed proof run id', (r) => { r.proofs[0].run_id = 'doctor-nope'; }, /does not match pattern/],
    ['an unhashed artifact reference', (r) => { r.proofs[0].artifact_sha256 = 'deadbeef'; }, /does not match pattern/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const r = validRecord();
      mutate(r);
      const f = validateInstance(r, SCHEMA);
      assert.ok(f.some((x) => expected.test(x.detail)), `${name}: ${details(f)}`);
    });
  }
});

test('derived fields are checked against real git', async (t) => {
  await t.test('control — the fixture record produces no findings', () => {
    const result = run(validRecord());
    assert.equal(result.ran, true, result.reason ?? '');
    assert.deepEqual(result.findings, [], details(result.findings));
    // And the observed field was NOT silently counted as verified.
    assert.equal(result.proofStatus.unverified, 1);
    assert.equal(result.proofStatus.verified, 0);
  });

  const cases = [
    ['a squash that is not the tagged commit', (r) => { r.package_releases[0].squash = PR_IN_SUBJECT; }, /is commit .*, not/],
    ['a tag that does not exist', (r) => { r.package_releases[0].tag = 'plugin-runtime-v99.0.0'; r.package_releases[0].version = '99.0.0'; }, /no tag `refs\/tags\/plugin-runtime-v99\.0\.0` exists/],
    ['omitting a PR number the subject does carry', (r) => { delete r.package_releases[0].release_pr; }, /omission is not a third option/],
    ['a null marketplace sync when the window holds one', (r) => { r.package_releases[0].marketplace_sync = null; }, /claims .* had no marketplace sync, but/],
    ['a version the manifest did not hold at that tag', (r) => { r.package_releases[0].version = '0.86.1'; }, /manifest at .* reports/],
    ['a release_pr the commit subject contradicts', (r) => { r.package_releases[0].release_pr = 999; }, /subject says #642, record says #999/],
    ['attesting a PR number the subject does carry', (r) => { delete r.package_releases[0].release_pr; r.package_releases[0].release_pr_attested = 642; }, /attestation must not step around/],
    ['deriving a PR number the subject does not carry', (r) => { r.hardening_commits[0] = { sha: NO_PR_IN_SUBJECT, pr: 641 }; }, /carries no `\(#N\)`/],
    ['a marketplace sync that precedes its release', (r) => { r.package_releases[0].marketplace_sync = PR_IN_SUBJECT; }, /not a descendant/],
    ['a sha that does not resolve at all', (r) => { r.feature_commits[0].sha = 'f'.repeat(40); }, /does not resolve/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const r = validRecord();
      mutate(r);
      const f = run(r).findings;
      assert.ok(f.some((x) => expected.test(x.detail)), `${name}: ${details(f)}`);
    });
  }

  // The marketplace-sync check has THREE independent branches. The case above
  // only reaches the first, so the other two are forced here — a single loose
  // alternation would have let two of them go unexercised while reading as
  // covered.
  await t.test('a later release\'s sync cannot be borrowed by an earlier one', () => {
    const r = validRecord();
    r.package_releases[0] = {
      package: 'plugins/runtime',
      version: '0.86.0',
      tag: 'plugin-runtime-v0.86.0',
      release_pr_attested: 630,
      squash: git('rev-parse', 'plugin-runtime-v0.86.0^{commit}'),
      marketplace_sync: SYNC_COMMIT, // belongs to 0.86.2
    };
    const f = run(r).findings;
    assert.ok(f.some((x) => /release commit\(s\) sit between/.test(x.detail)), details(f));
  });

  await t.test('a descendant with no intervening release still must be a catalog sync', () => {
    // 0.86.2 is the newest release, so any commit after it is a descendant
    // with nothing intervening — isolating the subject branch.
    const notASync = git('rev-parse', 'a4a6053^{commit}');
    assert.doesNotMatch(git('log', '-1', '--format=%s', notASync), /sync catalog versions/i);
    const r = validRecord();
    r.package_releases[0].marketplace_sync = notASync;
    const f = run(r).findings;
    assert.ok(f.some((x) => /is cited as a marketplace sync but its subject is/.test(x.detail)), details(f));
  });

  await t.test('a sha that resolves but is unreachable from the integration branch', () => {
    // `commit-tree` mints a real commit object with no ref pointing at it —
    // the deterministic stand-in for a squash-deleted branch commit, which
    // resolves in the clone that authored it and nowhere else. Constructing it
    // is what makes this case reachable on a fresh clone too, where no such
    // commit would otherwise exist.
    const tree = git('rev-parse', 'HEAD^{tree}');
    const orphan = execFileSync('git', ['-C', REPO_ROOT, 'commit-tree', tree, '-m', 'unreferenced fixture commit'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    }).trim();
    assert.equal(git('rev-parse', '--verify', `${orphan}^{commit}`), orphan, 'the orphan must resolve');
    const r = validRecord();
    r.feature_commits[0] = { sha: orphan };
    const f = run(r).findings;
    assert.ok(f.some((x) => /resolves but is not reachable/.test(x.detail)), details(f));
  });

  await t.test('a marketplace sync must also be reachable, not merely parented to the release', () => {
    // Ancestry plus subject is not enough: a locally minted commit parented to
    // the release satisfies both while existing on no remote branch
    // (cross-host review finding). Minting one is what makes the branch
    // reachable on a fresh clone too.
    const tree = git('rev-parse', 'HEAD^{tree}');
    const fake = execFileSync('git', [
      '-C', REPO_ROOT, 'commit-tree', tree, '-p', RELEASE_COMMIT,
      '-m', 'chore(marketplace): sync catalog versions to release-please-manifest',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    }).trim();
    assert.match(git('log', '-1', '--format=%s', fake), /sync catalog versions/);
    assert.equal(git('rev-list', '--count', `${RELEASE_COMMIT}..${fake}`), '1', 'must be a descendant of the release');
    const r = validRecord();
    r.package_releases[0].marketplace_sync = fake;
    const f = run(r).findings;
    assert.ok(f.some((x) => /is not reachable from/.test(x.detail)), details(f));
  });

  await t.test('a branch cannot masquerade as a deleted tag', () => {
    // `rev-parse <name>^{commit}` resolves branches too, so before the
    // namespace fix a branch standing in for a deleted tag passed every check.
    const name = 'plugin-runtime-v99.0.0';
    execFileSync('git', ['-C', REPO_ROOT, 'branch', '-f', name, RELEASE_COMMIT]);
    try {
      assert.equal(git('rev-parse', `${name}^{commit}`), RELEASE_COMMIT, 'the branch must resolve by bare name');
      const r = validRecord();
      r.package_releases[0] = { package: 'plugins/runtime', version: '99.0.0', tag: name, release_pr_attested: 1, squash: RELEASE_COMMIT, marketplace_sync: null };
      const f = run(r).findings;
      assert.ok(f.some((x) => /no tag `refs\/tags\/plugin-runtime-v99\.0\.0` exists/.test(x.detail)), details(f));
    } finally {
      execFileSync('git', ['-C', REPO_ROOT, 'branch', '-D', name]);
    }
  });

  await t.test('fail-closed when the tag-time release config or manifest cannot answer', () => {
    // `companions-v0.1.0` predates the runtime package entirely: its release
    // config lists only `companions` and `plugins/companions`, and its
    // manifest has no `plugins/runtime` key. Real history, so these
    // fail-closed branches are exercised rather than assumed — a cross-host
    // review measured 0 of 202 current tags reaching them.
    const early = 'companions-v0.1.0';
    const r = validRecord();
    r.package_releases[0] = {
      package: 'plugins/runtime',
      version: '0.86.2',
      tag: early,
      release_pr_attested: 1,
      squash: git('rev-parse', `refs/tags/${early}^{commit}`),
      marketplace_sync: null,
    };
    const f = run(r).findings;
    assert.ok(f.some((x) => /is not a release-please package at tag/.test(x.detail)), details(f));
    assert.ok(f.some((x) => /has no manifest entry at tag/.test(x.detail)), details(f));
  });

  await t.test('the package/tag binding rejects another package\'s tag on the same commit', () => {
    // The whole reason a tag-time manifest read is not sufficient: these two
    // tags are one commit, so the manifest at either reports runtime 0.83.0.
    assert.equal(git('rev-parse', `${SHARED_COMMIT_ATTENTION_TAG}^{commit}`), git('rev-parse', 'plugin-runtime-v0.83.0^{commit}'));
    const r = validRecord();
    r.package_releases[0] = {
      package: 'plugins/runtime',
      version: '0.83.0',
      tag: SHARED_COMMIT_ATTENTION_TAG,
      release_pr_attested: 1,
      squash: git('rev-parse', `${SHARED_COMMIT_ATTENTION_TAG}^{commit}`),
      marketplace_sync: null,
    };
    const f = run(r).findings;
    assert.ok(f.some((x) => /must be tagged plugin-runtime-v0\.83\.0/.test(x.detail)), details(f));
    // Prove the manifest check alone would NOT have caught it.
    const manifestAtTag = JSON.parse(git('show', `${SHARED_COMMIT_ATTENTION_TAG}:.release-please-manifest.json`));
    assert.equal(manifestAtTag['plugins/runtime'], '0.83.0');
  });
});

test('structural rules', async (t) => {
  await t.test('control — the fixture record is structurally clean', () => {
    assert.deepEqual(run(validRecord()).findings, []);
  });

  await t.test('filename stem must equal record_id', () => {
    const f = run(validRecord(), 'other-name').findings;
    assert.ok(f.some((x) => /does not match filename stem/.test(x.detail)), details(f));
  });

  await t.test('a duplicate commit sha across the two commit arrays', () => {
    const r = validRecord();
    r.hardening_commits = [{ sha: PR_IN_SUBJECT, pr: 637 }];
    const f = run(r).findings;
    assert.ok(f.some((x) => /duplicate commit sha/.test(x.detail)), details(f));
  });

  await t.test('a duplicate proof run id', () => {
    const r = validRecord();
    r.proofs.push(deep(r.proofs[0]));
    const f = run(r).findings;
    assert.ok(f.some((x) => /duplicate proof run id/.test(x.detail)), details(f));
  });

  await t.test('a relation pointing at its own record', () => {
    const r = validRecord();
    r.relations.push({ type: 'follows', record_id: r.record_id });
    const f = run(r).findings;
    assert.ok(f.some((x) => /points at its own record/.test(x.detail)), details(f));
  });

  await t.test('a relation to a record that is not in the store', () => {
    const r = validRecord();
    r.relations.push({ type: 'supersedes', record_id: 'loop-that-does-not-exist' });
    const f = run(r).findings;
    assert.ok(f.some((x) => /is not a record in this store/.test(x.detail)), details(f));
  });

  await t.test('two records MAY cite the same release — the ADR says so explicitly', () => {
    // Context constraint 1: "a single release can carry several records
    // (2026-07-20 alone carries four)". An earlier draft enforced one owning
    // record per tag, which contradicted the decision it implemented.
    const a = validRecord();
    const b = deep(a);
    b.record_id = 'loop-fixture-two';
    const result = checkStore(REPO_ROOT, {
      records: [
        { file: 'records/loop-fixture.json', stem: 'loop-fixture', data: a },
        { file: 'records/loop-fixture-two.json', stem: 'loop-fixture-two', data: b },
      ],
    });
    assert.deepEqual(result.findings, [], details(result.findings));
  });

  await t.test('duplicate record ids across files', () => {
    const a = validRecord();
    const g = checkStore(REPO_ROOT, {
      records: [
        { file: 'records/loop-fixture.json', stem: 'loop-fixture', data: a },
        { file: 'records/copy.json', stem: 'copy', data: deep(a) },
      ],
    }).findings;
    assert.ok(g.some((x) => /is already used by/.test(x.detail)), details(g));
  });

  await t.test('a duplicate release tag WITHIN one record', () => {
    const r = validRecord();
    r.package_releases.push(deep(r.package_releases[0]));
    const f = run(r).findings;
    assert.ok(f.some((x) => /duplicate release tag/.test(x.detail)), details(f));
  });

  await t.test('a resolvable relation between two records passes', () => {
    const a = validRecord();
    const b = validRecord();
    b.record_id = 'loop-fixture-two';
    b.package_releases[0].tag = 'plugin-runtime-v0.86.1';
    b.package_releases[0].version = '0.86.1';
    b.package_releases[0].squash = git('rev-parse', 'refs/tags/plugin-runtime-v0.86.1^{commit}');
    // 0.86.1's real catalog sync. The first draft of this fixture said `null`,
    // and the null-claim check correctly rejected it — omitting a sync that
    // exists is a false claim, not an absence.
    b.package_releases[0].marketplace_sync = git('rev-parse', '0eb8807^{commit}');
    // Derived, not attested: this release's commit subject carries `(#638)`.
    // The first draft of this fixture attested it and the checker rejected it,
    // which is the attestation-must-not-dodge-a-check rule doing its job.
    b.package_releases[0].release_pr = 638;
    b.feature_commits = [];
    b.hardening_commits = [];
    b.proofs[0].run_id = 'doctor-20000101T000000Z-abcde0';
    a.relations.push({ type: 'follows', record_id: 'loop-fixture-two' });
    const result = checkStore(REPO_ROOT, {
      records: [
        { file: 'records/loop-fixture.json', stem: 'loop-fixture', data: a },
        { file: 'records/loop-fixture-two.json', stem: 'loop-fixture-two', data: b },
      ],
    });
    assert.deepEqual(result.findings, [], details(result.findings));
  });
});

test('observed fields: absent is unverified, corrupt is a failure', async (t) => {
  const proof = validRecord().proofs[0];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-observed-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runDir = path.join(tmp, '.agentic-plugins', 'runs', 'doctor', proof.run_id);

  await t.test('artifact absent → unverified, no finding', () => {
    const r = checkProof(tmp, proof, '$');
    assert.equal(r.status, 'unverified');
    assert.deepEqual(r.findings, []);
  });

  // Shaped like a real doctor artifact, because the observed fields are now
  // compared against it rather than covered by the hash alone.
  const artifactBody = (over = {}) => Buffer.from(`${JSON.stringify({
    schema_version: 'runtime-doctor-artifact-1.0',
    runtime_version: '0.86.2',
    run_id: proof.run_id,
    status: 'recorded',
    created_at: '2000-01-01T00:00:00.000Z',
    ...over,
  }, null, 2)}\n`);
  const write = (bytes) => { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, 'doctor.json'), bytes); };
  const hashed = (bytes) => ({ ...proof, artifact_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });

  await t.test('artifact present and matching → verified', () => {
    const bytes = artifactBody();
    write(bytes);
    const r = checkProof(tmp, hashed(bytes), '$');
    assert.equal(r.status, 'verified', details(r.findings));
    assert.deepEqual(r.findings, []);
  });

  await t.test('a correct hash does not excuse a wrong transcription', () => {
    // The hash pins the bytes, not the copy. Each of these artifacts hashes
    // correctly and still contradicts the record.
    for (const [field, over, recordPatch] of [
      ['runtime_version', { runtime_version: '9.9.9' }, {}],
      ['run_id', { run_id: 'doctor-20000101T000000Z-999999' }, {}],
      ['date', { created_at: '2011-11-11T00:00:00.000Z' }, {}],
    ]) {
      const bytes = artifactBody(over);
      write(bytes);
      const r = checkProof(tmp, { ...hashed(bytes), ...recordPatch }, '$');
      assert.equal(r.status, 'failed', `${field}: ${details(r.findings)}`);
      assert.ok(r.findings.some((x) => x.path === `$.${field}`), `${field}: ${details(r.findings)}`);
    }
  });

  await t.test('artifact present but mismatched → failed, NOT unverified', () => {
    // The degradation this asserts against is the dangerous one: treating a
    // mismatch as "absent" would let corruption read as the ordinary CI case.
    write(artifactBody());
    const r = checkProof(tmp, proof, '$'); // proof carries the all-zero placeholder hash
    assert.equal(r.status, 'failed');
    assert.ok(r.findings.some((x) => /hashes to/.test(x.detail)), details(r.findings));
  });

  await t.test('hashing is over exact bytes — a trailing newline changes the verdict', () => {
    const bytes = artifactBody();
    write(bytes);
    const exact = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const withNewline = `sha256:${createHash('sha256').update(Buffer.concat([bytes, Buffer.from('\n')])).digest('hex')}`;
    assert.notEqual(exact, withNewline);
    assert.equal(checkProof(tmp, { ...proof, artifact_sha256: exact }, '$').status, 'verified');
    assert.equal(checkProof(tmp, { ...proof, artifact_sha256: withNewline }, '$').status, 'failed');
  });

  await t.test('a run directory with no doctor.json is absence, not corruption', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-bare-'));
    t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
    fs.mkdirSync(path.join(bare, '.agentic-plugins', 'runs', 'doctor', proof.run_id), { recursive: true });
    assert.equal(checkProof(bare, proof, '$').status, 'unverified');
  });

  await t.test('an unreadable artifact fails instead of degrading to unverified', (sub) => {
    // existsSync answers false for a real file under a non-traversable parent,
    // so a permissions fault used to report as the ordinary absent-in-CI case.
    if (process.getuid?.() === 0) return sub.skip('root traverses regardless of mode');
    const locked = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-locked-'));
    const dir = path.join(locked, '.agentic-plugins', 'runs', 'doctor', proof.run_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'doctor.json'), artifactBody());
    fs.chmodSync(dir, 0o000);
    try {
      const r = checkProof(locked, proof, '$');
      assert.equal(r.status, 'failed', details(r.findings));
      assert.ok(r.findings.some((x) => /present but unreadable \(EACCES\)/.test(x.detail)), details(r.findings));
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(locked, { recursive: true, force: true });
    }
  });
});

test('the provenance declaration drives the gate', async (t) => {
  await t.test('control — the shipped schema satisfies the contract', () => {
    assert.deepEqual(checkStore(REPO_ROOT, { records: [] }).findings, []);
  });

  await t.test('relabelling command as observed is rejected — it has no extractor', () => {
    // The minimal defect a cross-host review found surviving the whole suite:
    // the label was decoration, so flipping it changed nothing.
    const schemaFile = path.resolve(REPO_ROOT, SCHEMA_PATH);
    const original = fs.readFileSync(schemaFile);
    try {
      const mutated = JSON.parse(original.toString('utf8'));
      mutated.$defs.proof.properties.command['x-provenance'] = 'observed';
      fs.writeFileSync(schemaFile, JSON.stringify(mutated, null, 2));
      const f = checkStore(REPO_ROOT, { records: [] }).findings;
      assert.ok(
        f.some((x) => x.check === 'provenance' && /command/.test(x.path) && /neither extract/.test(x.detail)),
        details(f),
      );
    } finally {
      fs.writeFileSync(schemaFile, original);
    }
    assert.deepEqual(checkStore(REPO_ROOT, { records: [] }).findings, [], 'schema must be restored');
  });
});

test('an environment that cannot support the checks fails closed', async (t) => {
  // Control: the real checkout DOES support them, so the negatives below are
  // not passing because the helper always says no.
  await t.test('control — this checkout is usable', () => {
    assert.equal(historyAvailable(REPO_ROOT).ok, true);
  });

  await t.test('not a git repository', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-nogit-'));
    try {
      const availability = historyAvailable(tmp);
      assert.equal(availability.ok, false);
      assert.match(availability.reason, /not usable/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('an actual shallow clone', () => {
    // A non-git directory does NOT reach the `is-shallow-repository` branch —
    // it errors out one step earlier — so the branch that CI actually hits was
    // uncovered until this case cloned for real (cross-host review finding).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-shallow-'));
    const clone = path.join(tmp, 'shallow');
    try {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', '--no-tags', `file://${REPO_ROOT}`, clone], { stdio: 'ignore' });
      assert.equal(execFileSync('git', ['-C', clone, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim(), 'true');
      const availability = historyAvailable(clone);
      assert.equal(availability.ok, false);
      assert.match(availability.reason, /shallow clone.*fetch-depth: 0/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test('an empty store passes', () => {
  const result = checkStore(REPO_ROOT, { records: [] });
  assert.equal(result.ran, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.records, 0);
});
