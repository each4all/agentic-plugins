// Gate tests for scripts/check-release-obligation.mjs (ADR-0052).
//
// Two corpora, deliberately separated:
//
//   REAL HISTORY — the 16b1833 counterexample and its neighbours. These are
//   the only cases that prove the check bites on the defect it was built for,
//   and they are pinned at EXACTLY `16b1833^..16b1833`. A wider cumulative
//   range passes vacuously: plugin-runtime-v0.90.0 later shipped bytes
//   identical to 16b1833's, so evaluating at any later ref reports `fulfilled`
//   and proves nothing. The counterexample is only visible at its own commit.
//
//   SYNTHETIC REPOSITORIES — the diff-semantics matrix (file add/delete/
//   rename, schema-registry entry removal, revert, multi-package commit,
//   version-only release commit) and the fail-closed matrix (shallow clone,
//   no tags, drifted pathspecs, non-SemVer tag, version regression). These
//   need histories this repository does not contain, so they are built.
//
// Every exception path carries a CONTROL — a case that takes the same branch
// but must pass — because an assertion that only ever sees the failing side
// cannot distinguish a working check from one that fails on everything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify,
  protectedEntries,
  digestEntries,
  parseSemver,
  PROTECTED_PATHS,
  ADOPTION_EPOCH,
} from '../../scripts/check-release-obligation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Real history — the counterexample, at exactly its own commit
// ---------------------------------------------------------------------------

// The commit ADR-0051 §Out of scope and ADR-0052 §Context both name: a
// `docs:`-typed post-release recovery that refreshed the packaged baseline,
// routed no release, and left released and accepted bytes disagreeing for 54
// hours.
const COUNTEREXAMPLE = '16b1833c051b12220aa6d5f812c8ac2383b36c79';

test('the counterexample classifies as outstanding debt at exactly its own commit', () => {
  // Epoch is its parent, so the commit itself is the only one in scope. This
  // is the `16b1833^..16b1833` range, expressed as the check expresses it.
  const r = classify(REPO_ROOT, { ref: COUNTEREXAMPLE, epoch: `${COUNTEREXAMPLE}^` });
  assert.equal(r.ran, true, r.reason ?? '');
  assert.equal(r.state, 'outstanding_debt');
  assert.equal(r.failing, true);
  assert.equal(r.newestTag, 'plugin-runtime-v0.89.0');
  assert.equal(r.manifestVersion, '0.89.0', 'the release that preceded it left runtime at 0.89.0');
  // Non-emptiness pinned by IDENTITY, not by count: an in-scope list that
  // happened to contain some other commit would satisfy `length === 1`.
  assert.deepEqual(r.inScopeChanges.map((c) => c.sha), [COUNTEREXAMPLE]);
});

test('CONTROL — the counterexample PARENT is fulfilled, so the gate flips at that one commit', () => {
  const r = classify(REPO_ROOT, { ref: `${COUNTEREXAMPLE}^`, epoch: `${COUNTEREXAMPLE}^^` });
  assert.equal(r.ran, true, r.reason ?? '');
  assert.equal(r.state, 'fulfilled');
  assert.equal(r.failing, false);
  assert.equal(r.newestTag, 'plugin-runtime-v0.89.0');
});

test('CONTROL — a wider range hides the counterexample, which is why the range is exact', () => {
  // plugin-runtime-v0.90.0 shipped bytes identical to the counterexample's.
  // Evaluating there reports fulfilled — a test written against this ref
  // would pass with the check deleted.
  const r = classify(REPO_ROOT, { ref: 'plugin-runtime-v0.90.0', epoch: `${COUNTEREXAMPLE}^` });
  assert.equal(r.state, 'fulfilled');
  assert.equal(
    r.headDigest,
    digestEntries(protectedEntries(REPO_ROOT, COUNTEREXAMPLE)),
    'the later tag carries byte-identical protected bytes — this is what makes the wide range vacuous',
  );
});

test('a release that bumped OTHER packages does not discharge runtime debt', () => {
  // fd7ab8e is the release PR that merged between the counterexample and its
  // eventual tag: it bumped designer, engineer, founder and orchestrator and
  // left runtime at 0.89.0. A check keyed on "a release happened" would clear
  // the debt here.
  const r = classify(REPO_ROOT, { ref: 'fd7ab8e', epoch: `${COUNTEREXAMPLE}^` });
  assert.equal(r.state, 'outstanding_debt');
  assert.equal(r.newestTag, 'plugin-runtime-v0.89.0');
});

test('the adoption epoch is load-bearing — the same commit passes when it predates the epoch', () => {
  // Identical ref, default epoch. If the epoch were ignored, this would fail
  // like the first test does, and main would be red from the gate's first run.
  const r = classify(REPO_ROOT, { ref: COUNTEREXAMPLE });
  assert.equal(r.state, 'pre_epoch_divergence');
  assert.equal(r.failing, false);
  assert.deepEqual(r.inScopeChanges, []);
});

// ---------------------------------------------------------------------------
// Real history — the gate must be green where it lands
// ---------------------------------------------------------------------------

test('HEAD is not in outstanding debt', () => {
  const r = classify(REPO_ROOT, {});
  assert.equal(r.ran, true, r.reason ?? '');
  assert.equal(r.failing, false, `${r.state}: ${r.detail}`);
});

test('the adoption epoch resolves, is an ancestor of HEAD, and grandfathers nothing', () => {
  const sha = git(REPO_ROOT, ['rev-parse', '--verify', `${ADOPTION_EPOCH}^{commit}`]).trim();
  assert.equal(sha, ADOPTION_EPOCH, 'the epoch must be pinned as a full, resolvable sha');
  assert.doesNotThrow(
    () => git(REPO_ROOT, ['merge-base', '--is-ancestor', ADOPTION_EPOCH, 'HEAD']),
    'the epoch must be an ancestor of HEAD or the grandfather clause cannot be evaluated',
  );
  // The property that makes the epoch legitimate is that it sweeps nothing
  // under: at the epoch itself the released tree already matched, so no
  // pre-existing debt is being forgiven.
  //
  // A previous revision asserted instead that no protected path changed
  // between the epoch and HEAD. That is true today and becomes false forever
  // the first time a legitimate baseline refresh lands — it would have turned
  // main permanently red on exactly the change this gate exists to permit.
  const atEpoch = classify(REPO_ROOT, { ref: ADOPTION_EPOCH });
  assert.equal(atEpoch.ran, true, atEpoch.reason ?? '');
  assert.equal(atEpoch.state, 'fulfilled', 'the epoch must be a clean boundary, not a covered-up debt');
});

test('the protected pathspecs resolve to the assets ADR-0052 §Decision 2 names, by identity', () => {
  const paths = protectedEntries(REPO_ROOT, 'HEAD').map((e) => e.path);
  // Pinned by name, not by count: a count-only assertion stays green if the
  // schema directory silently stops matching and some other file starts.
  assert.ok(paths.includes('plugins/runtime/docs/host-parity-baseline.md'));
  assert.ok(paths.includes('plugins/runtime/data/plugin-set.json'));
  assert.ok(
    paths.includes('plugins/runtime/data/schemas/runtime-plugin-set-1.0.json'),
    'the directory pattern must cover the schema registered in PACKAGED_SCHEMA_FILES but loaded only by tests',
  );
  assert.ok(paths.filter((p) => p.startsWith('plugins/runtime/data/schemas/')).length >= 7);
  // Out of first scope per §Decision 3 — a different release-please package.
  assert.ok(!paths.some((p) => p.startsWith('plugins/attention/')));
});

// ---------------------------------------------------------------------------
// Synthetic repositories — diff semantics and fail-closed matrix
// ---------------------------------------------------------------------------

const BASELINE = 'plugins/runtime/docs/host-parity-baseline.md';
const PLUGIN_SET = 'plugins/runtime/data/plugin-set.json';
const SCHEMA = 'plugins/runtime/data/schemas/runtime-thing-1.0.json';

function write(dir, rel, text) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

function setVersion(dir, version) {
  write(dir, '.release-please-manifest.json', `${JSON.stringify({ 'plugins/runtime': version }, null, 2)}\n`);
  write(dir, 'plugins/runtime/.claude-plugin/plugin.json', `${JSON.stringify({ name: 'runtime', version }, null, 2)}\n`);
  write(dir, 'plugins/runtime/.codex-plugin/plugin.json', `${JSON.stringify({ name: 'runtime', version }, null, 2)}\n`);
}

function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** A repo at v1.0.0 whose tag carries the protected tree: state `fulfilled`. */
function makeRepo(t, { version = '1.0.0' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-obligation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  write(dir, BASELINE, '# baseline\nClaude Code 1.0.0\n');
  write(dir, PLUGIN_SET, '{"plugins":["runtime"]}\n');
  write(dir, SCHEMA, '{"$id":"runtime-thing-1.0"}\n');
  write(dir, 'plugins/attention/data/runtime-floors.json', '{"runtime":"1.0.0"}\n');
  write(dir, 'README.md', 'unprotected\n');
  setVersion(dir, version);
  const epoch = commit(dir, 'chore: scaffold');
  git(dir, ['tag', `plugin-runtime-v${version}`]);
  return { dir, epoch };
}

/** Bump all three version sources the way release-please's extra-files do. */
function release(dir, version, { tag = true } = {}) {
  setVersion(dir, version);
  const sha = commit(dir, `chore: release main`);
  if (tag) git(dir, ['tag', `plugin-runtime-v${version}`]);
  return sha;
}

test('synthetic baseline scaffold is fulfilled — the control every other case deviates from', (t) => {
  const { dir, epoch } = makeRepo(t);
  const r = classify(dir, { epoch });
  assert.equal(r.ran, true, r.reason ?? '');
  assert.equal(r.state, 'fulfilled');
});

test('editing a protected file without a release is outstanding debt', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nClaude Code 1.0.1\n');
  const sha = commit(dir, 'docs(runtime): refresh host-parity baseline');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt');
  assert.deepEqual(r.inScopeChanges.map((c) => c.sha), [sha]);
});

test('CONTROL — editing an UNPROTECTED file is fulfilled', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, 'README.md', 'still unprotected\n');
  write(dir, 'plugins/runtime/docs/footer-contract.md', 'operator-facing prose, not a verdict input\n');
  commit(dir, 'docs: unrelated');
  assert.equal(classify(dir, { epoch }).state, 'fulfilled');
});

test('adding a new schema is caught by the DIRECTORY pattern, with no edit to the checker', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, 'plugins/runtime/data/schemas/runtime-brand-new-2.0.json', '{"$id":"brand-new"}\n');
  commit(dir, 'feat(runtime): add a schema');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt');
  assert.ok(r.protectedFiles.includes('plugins/runtime/data/schemas/runtime-brand-new-2.0.json'));
});

test('DELETING a protected file cannot evade the check', (t) => {
  const { dir, epoch } = makeRepo(t);
  unlinkSync(path.join(dir, SCHEMA));
  commit(dir, 'refactor(runtime): drop a schema registry entry');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt', 'a set comparison sees a removal; a one-sided diff would not');
  assert.ok(!r.protectedFiles.includes(SCHEMA));
});

test('renaming a protected file OUT of the protected set is caught as a removal', (t) => {
  const { dir, epoch } = makeRepo(t);
  renameSync(path.join(dir, BASELINE), path.join(dir, 'plugins/runtime/docs/host-parity-baseline-v2.md'));
  commit(dir, 'refactor(runtime): rename the baseline');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt');
  assert.ok(!r.protectedFiles.includes(BASELINE), 'the old path leaves the set, which is what moves the digest');
});

test('renaming a protected file WITHIN a protected directory is caught, though the bytes are identical', (t) => {
  // The strictly harder rename, and the one the pathspecs cannot catch by
  // set membership: both names are inside `data/schemas`, so the file count
  // and every blob id are unchanged. Only the PATH component of the digest
  // sees it. Schemas are loaded by filename (PACKAGED_SCHEMA_FILES), so a
  // silent rename changes what the runtime resolves while shipping the same
  // bytes — an evasion, not a cosmetic edit.
  const { dir, epoch } = makeRepo(t);
  const before = protectedEntries(dir, 'HEAD');
  renameSync(path.join(dir, SCHEMA), path.join(dir, 'plugins/runtime/data/schemas/runtime-thing-2.0.json'));
  commit(dir, 'refactor(runtime): rename a schema in place');
  const after = protectedEntries(dir, 'HEAD');
  assert.equal(after.length, before.length, 'same file count — a count- or blob-only digest would miss this');
  assert.deepEqual(
    after.map((e) => e.object).sort(),
    before.map((e) => e.object).sort(),
    'same blob ids — only the path differs',
  );
  assert.equal(classify(dir, { epoch }).state, 'outstanding_debt');
});

test('a MODE change on a protected file is caught, though path and bytes are identical', (t) => {
  const { dir, epoch } = makeRepo(t);
  chmodSync(path.join(dir, SCHEMA), 0o755);
  commit(dir, 'chore(runtime): make a packaged schema executable');
  const entry = protectedEntries(dir, 'HEAD').find((e) => e.path === SCHEMA);
  assert.equal(entry.mode, '100755', 'git must have recorded the mode change, or this test proves nothing');
  assert.equal(classify(dir, { epoch }).state, 'outstanding_debt');
});

test('a multi-package commit is judged on its runtime part alone', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nClaude Code 1.0.2\n');
  write(dir, 'plugins/attention/data/runtime-floors.json', '{"runtime":"9.9.9"}\n');
  commit(dir, 'chore: touch two packages');
  assert.equal(classify(dir, { epoch }).state, 'outstanding_debt');
});

test('CONTROL — a commit touching only the out-of-scope package is fulfilled', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, 'plugins/attention/data/runtime-floors.json', '{"runtime":"9.9.9"}\n');
  commit(dir, 'feat(plugin/attention): move the runtime floor');
  assert.equal(
    classify(dir, { epoch }).state,
    'fulfilled',
    'runtime-floors.json is a genuine verdict input but a different package — ADR-0052 §Decision 3 defers it',
  );
});

test('a release that ships the bytes discharges the debt — no actor bypass involved', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nClaude Code 1.0.3\n');
  commit(dir, 'docs(runtime): refresh baseline');
  assert.equal(classify(dir, { epoch }).state, 'outstanding_debt');
  release(dir, '1.1.0');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'fulfilled');
  assert.equal(r.newestTag, 'plugin-runtime-v1.1.0');
});

test('coalescing is free — one tag discharges several protected changes', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nfirst\n');
  commit(dir, 'docs(runtime): refresh once');
  write(dir, BASELINE, '# baseline\nsecond\n');
  write(dir, PLUGIN_SET, '{"plugins":["runtime","attention"]}\n');
  commit(dir, 'docs(runtime): refresh again');
  // Identity, not count: a list that returned the newest sha twice satisfies
  // `length === 2`.
  assert.deepEqual(
    classify(dir, { epoch }).inScopeChanges.map((c) => c.subject).sort(),
    ['docs(runtime): refresh again', 'docs(runtime): refresh once'],
  );
  release(dir, '1.1.0');
  assert.equal(classify(dir, { epoch }).state, 'fulfilled');
});

test('the protected set covers data/schemas but not the rest of data/', (t) => {
  // Broadening the pathspec to all of `plugins/runtime/data` survives every
  // real-repo assertion, because that directory happens to hold nothing else
  // today. A fixture that puts a file there is the only thing that kills it.
  const { dir, epoch } = makeRepo(t);
  write(dir, 'plugins/runtime/data/usage-notes.md', 'not a verdict input\n');
  commit(dir, 'docs(runtime): add a non-schema file under data/');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'fulfilled', 'only data/schemas is protected, not all of data/');
  assert.ok(!r.protectedFiles.includes('plugins/runtime/data/usage-notes.md'));
});

test('a version-only release commit changes nothing when there is no debt', (t) => {
  const { dir, epoch } = makeRepo(t);
  release(dir, '1.1.0');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'fulfilled');
  assert.equal(r.manifestVersion, '1.1.0');
});

test('reverting a released protected change re-opens the obligation', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nchanged\n');
  commit(dir, 'docs(runtime): refresh');
  release(dir, '1.1.0');
  write(dir, BASELINE, '# baseline\nClaude Code 1.0.0\n'); // back to the v1.0.0 bytes
  commit(dir, 'revert: restore the previous baseline');
  const r = classify(dir, { epoch });
  assert.equal(
    r.state,
    'outstanding_debt',
    'the restored bytes differ from what the newest tag ships, so they owe a release of their own',
  );
});

test('a manifest bump without its tag is release_in_flight, and passes', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nrefreshed\n');
  commit(dir, 'docs(runtime): refresh');
  release(dir, '1.1.0', { tag: false });
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'release_in_flight');
  assert.equal(r.failing, false);
  assert.equal(r.newestTag, 'plugin-runtime-v1.0.0');
});

test('a protected change landing inside the in-flight window is debt immediately, not once the tag appears', (t) => {
  const { dir, epoch } = makeRepo(t);
  release(dir, '1.1.0', { tag: false });
  write(dir, BASELINE, '# baseline\nlanded after the release commit\n');
  const late = commit(dir, 'docs(runtime): refresh during the window');
  // The pending tag is cut at the release commit, so it provably will not
  // carry these bytes. Waiting for the tag to reveal that would mask the debt
  // for as long as the tag stays uncut — indefinitely if the release workflow
  // fails, which is how an earlier revision behaved.
  const during = classify(dir, { epoch });
  assert.equal(during.state, 'outstanding_debt');
  assert.equal(during.failing, true);
  assert.ok(during.inScopeChanges.some((c) => c.sha === late));
  // Cutting the tag at the release commit changes the reason, not the verdict.
  git(dir, ['tag', 'plugin-runtime-v1.1.0', git(dir, ['rev-parse', 'HEAD^']).trim()]);
  assert.equal(classify(dir, { epoch }).state, 'outstanding_debt');
});

test('in-flight does not mask a stacked release that never gets tagged', (t) => {
  // The peer's false-green history: debt accrues, a version bump lands with no
  // tag, then the tree moves again. An unconditional `versionDelta > 0` pass
  // returned exit 0 here forever while released bytes were two changes behind.
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nY\n');
  commit(dir, 'docs(runtime): refresh — debt opens');
  release(dir, '2.0.0', { tag: false });
  write(dir, BASELINE, '# baseline\nZ\n');
  commit(dir, 'docs(runtime): refresh again, still no tag');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt');
  assert.equal(r.failing, true);
});

test('CONTROL — an ordinary in-flight release still passes', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nrefreshed\n');
  commit(dir, 'docs(runtime): refresh');
  release(dir, '1.1.0', { tag: false });
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'release_in_flight', 'the pending tag WILL carry these bytes — this must not fail');
  assert.equal(r.failing, false);
});

test('CONTROL — divergence that already existed at adoption IS grandfathered', (t) => {
  // The clause the epoch exists for: the gate lands on a repository that is
  // already diverged. Without this the first run would be red for a state
  // nobody created after the rule.
  const { dir } = makeRepo(t);
  write(dir, BASELINE, '# baseline\ndiverged before the rule existed\n');
  const epoch = commit(dir, 'docs(runtime): pre-adoption refresh');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'pre_epoch_divergence');
  assert.equal(r.failing, false);
  assert.notEqual(r.headDigest, r.tagDigest, 'there must be real divergence, or this proves nothing');
});

test('the amnesty is spent once a release goes by without discharging it', (t) => {
  const { dir } = makeRepo(t);
  write(dir, BASELINE, '# baseline\ndiverged before the rule existed\n');
  const epoch = commit(dir, 'docs(runtime): pre-adoption refresh');
  assert.equal(classify(dir, { epoch }).state, 'pre_epoch_divergence');
  // A release is cut that does NOT carry the accepted bytes (it reverts them),
  // so the tree still differs — but the anchor moved, so this is no longer the
  // divergence that was forgiven.
  write(dir, BASELINE, '# baseline\nClaude Code 1.0.0\n');
  release(dir, '1.1.0');
  write(dir, BASELINE, '# baseline\ndiverged before the rule existed\n');
  commit(dir, 'docs(runtime): put it back');
  const r = classify(dir, { epoch });
  assert.equal(r.headDigest, digestEntries(protectedEntries(dir, epoch)), 'the tree matches the epoch again');
  assert.equal(r.state, 'outstanding_debt', 'but a release has been cut since, so the amnesty no longer applies');
});

test('a merge that first introduces a protected change after adoption is not grandfathered', (t) => {
  // Reproduced defect: the side branch forks BEFORE the epoch, so its commit
  // is not an epoch descendant; the merge is TREESAME to it for the protected
  // path, so path-limited rev-list omits the merge under git's default history
  // simplification. Deciding scope by walking that list grandfathered bytes
  // that entered the integration branch after adoption. Scope is now decided
  // by comparing trees, which no simplification rule can perturb.
  const { dir } = makeRepo(t);
  git(dir, ['switch', '-q', '-c', 'side']);
  write(dir, BASELINE, '# baseline\nY\n');
  const side = commit(dir, 'side: protected change authored before adoption');
  git(dir, ['switch', '-q', 'main']);
  write(dir, 'README.md', 'epoch lands after the side commit\n');
  const epoch = commit(dir, 'chore: adoption epoch');
  git(dir, ['merge', '-q', '--no-ff', 'side', '-m', 'Merge side branch']);
  const merge = git(dir, ['rev-parse', 'HEAD']).trim();

  // Pin the simplification itself, so this test keeps proving what it claims
  // even if git's default behaviour changes.
  const simplified = git(dir, ['rev-list', 'plugin-runtime-v1.0.0..HEAD', '--', BASELINE]).split('\n').filter(Boolean);
  assert.ok(!simplified.includes(merge), 'default rev-list must omit the merge, or this fixture proves nothing');
  assert.ok(simplified.includes(side));
  assert.throws(
    () => git(dir, ['merge-base', '--is-ancestor', epoch, side]),
    'the side commit must NOT descend from the epoch, or the old filter would have caught it anyway',
  );

  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt');
  assert.equal(r.failing, true);
  // The report still names the introducing merge, via --show-pulls.
  assert.ok(r.inScopeChanges.some((c) => c.sha === merge), 'the report must name the merge that introduced it');
});

test('a version that DECREASED fails closed — rollback is a forward patch, never a version reuse', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nchanged\n');
  commit(dir, 'docs(runtime): refresh');
  release(dir, '1.1.0');
  write(dir, BASELINE, '# baseline\nrolled back\n');
  setVersion(dir, '1.0.0'); // the wrong way to roll back
  commit(dir, 'revert: roll the version back too');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'version_regression');
  assert.equal(r.failing, true);
  assert.match(r.detail, /FORWARD patch/);
});

test('a version decrease is caught even when the protected tree did NOT move', (t) => {
  // The discriminating case. With the regression check sitting behind the
  // digest comparison, an unchanged tree short-circuits to `fulfilled` and the
  // regression branch is unreachable — the fixture above passed only because
  // it happened to move the tree as well.
  const { dir, epoch } = makeRepo(t);
  release(dir, '2.0.0');
  setVersion(dir, '1.0.0');
  commit(dir, 'chore: lower the version, protected tree untouched');
  const r = classify(dir, { epoch });
  assert.equal(r.headDigest, r.tagDigest, 'the trees must match, or this is just the previous test again');
  assert.equal(r.state, 'version_regression');
  assert.equal(r.failing, true);
});

test('a tag whose commit declares a different version fails closed', (t) => {
  // Without this, tagging any commit `plugin-runtime-v<higher>` discharges
  // every outstanding obligation: the digest at that tag is the debt's own
  // tree, so it compares equal and reports fulfilled.
  const { dir, epoch } = makeRepo(t);
  write(dir, BASELINE, '# baseline\nunreleased\n');
  const debt = commit(dir, 'docs(runtime): refresh, no release');
  assert.equal(classify(dir, { epoch }).state, 'outstanding_debt');
  git(dir, ['tag', 'plugin-runtime-v2.0.0', debt]); // fabricated: the commit still says 1.0.0
  const r = classify(dir, { epoch });
  assert.equal(r.ran, false, 'a fabricated tag must not be accepted as the release anchor');
  assert.match(r.reason, /moved or fabricated/);
});

test('a tag carrying no protected files fails closed rather than matching nothing', (t) => {
  const { dir } = makeRepo(t);
  git(dir, ['tag', '-d', 'plugin-runtime-v1.0.0']);
  git(dir, ['rm', '-r', '-q', 'plugins/runtime/docs', 'plugins/runtime/data']);
  const empty = commit(dir, 'refactor: remove every protected asset');
  git(dir, ['tag', 'plugin-runtime-v1.0.0']);
  write(dir, BASELINE, '# baseline\nreintroduced\n');
  commit(dir, 'docs(runtime): reintroduce the baseline, unreleased');
  const r = classify(dir, { epoch: empty });
  assert.equal(r.ran, false);
  assert.match(r.reason, /carries no files/);
});

test('a tag that exists but is not REACHABLE fails closed', (t) => {
  // Distinct from "no tags at all", which stops earlier in gitHistoryAvailable
  // — so that fixture never reached this branch. Here a runtime tag exists
  // globally, on an unmerged branch, which is exactly what `--merged` is for.
  const { dir, epoch } = makeRepo(t);
  git(dir, ['switch', '-q', '-c', 'unmerged']);
  write(dir, 'README.md', 'side\n');
  commit(dir, 'chore: side branch');
  git(dir, ['tag', 'plugin-runtime-v9.0.0']);
  git(dir, ['switch', '-q', 'main']);
  git(dir, ['tag', '-d', 'plugin-runtime-v1.0.0']);
  const r = classify(dir, { epoch });
  assert.equal(r.ran, false);
  assert.match(r.reason, /reachable/);
});

test('a release tagged only on an unmerged branch does not discharge debt on main', (t) => {
  const { dir, epoch } = makeRepo(t);
  git(dir, ['switch', '-q', '-c', 'side']);
  write(dir, BASELINE, '# baseline\nY\n');
  commit(dir, 'docs(runtime): refresh on a side branch');
  release(dir, '1.1.0');
  git(dir, ['switch', '-q', 'main']);
  write(dir, BASELINE, '# baseline\nZ\n');
  commit(dir, 'docs(runtime): a different refresh on main');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'outstanding_debt');
  assert.equal(r.newestTag, 'plugin-runtime-v1.0.0', 'the side-branch tag must not be selected');
});

test('a half-applied bump fails closed — manifests are read as evidence, never as a trigger', (t) => {
  const { dir, epoch } = makeRepo(t);
  write(dir, '.release-please-manifest.json', `${JSON.stringify({ 'plugins/runtime': '1.1.0' }, null, 2)}\n`);
  commit(dir, 'chore: bump only the release-please manifest');
  const r = classify(dir, { epoch });
  assert.equal(r.state, 'manifest_disagreement');
  assert.equal(r.failing, true);
});

test('each host manifest is checked individually, not just against the root one', (t) => {
  // Dropping either host from the agreement set survives the fixture above,
  // because the root manifest disagrees with whichever host remains. Bump the
  // root AND one host so only the omitted host is out of step.
  for (const stale of ['.claude-plugin', '.codex-plugin']) {
    const fresh = stale === '.claude-plugin' ? '.codex-plugin' : '.claude-plugin';
    const { dir, epoch } = makeRepo(t);
    write(dir, '.release-please-manifest.json', `${JSON.stringify({ 'plugins/runtime': '1.1.0' })}\n`);
    write(dir, `plugins/runtime/${fresh}/plugin.json`, `${JSON.stringify({ name: 'runtime', version: '1.1.0' })}\n`);
    commit(dir, `chore: bump everything except ${stale}`);
    const r = classify(dir, { epoch });
    assert.equal(r.state, 'manifest_disagreement', `a stale ${stale} manifest must be caught`);
  }
});

test('a shallow clone fails closed rather than passing vacuously', (t) => {
  const { dir } = makeRepo(t);
  const shallow = mkdtempSync(path.join(tmpdir(), 'release-obligation-shallow-'));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { encoding: 'utf8' });
  const r = classify(shallow, {});
  assert.equal(r.ran, false);
  assert.match(r.reason, /shallow/);
});

test('a repository with no runtime tags fails closed', (t) => {
  const { dir, epoch } = makeRepo(t);
  git(dir, ['tag', '-d', 'plugin-runtime-v1.0.0']);
  const r = classify(dir, { epoch });
  assert.equal(r.ran, false);
  assert.match(r.reason, /tags/);
});

test('drifted pathspecs fail closed instead of comparing two empty sets', (t) => {
  const { dir, epoch } = makeRepo(t);
  // Simulate the whole protected area moving without this file being updated.
  git(dir, ['rm', '-r', '-q', 'plugins/runtime/docs', 'plugins/runtime/data']);
  commit(dir, 'refactor(runtime): relocate the packaged assets');
  const r = classify(dir, { epoch });
  assert.equal(r.ran, false, 'an empty protected set compares equal at every ref — a permanent vacuous green');
  assert.match(r.reason, /drifted|deleted/);
});

test('a non-SemVer runtime tag fails closed rather than silently re-ranking "newest"', (t) => {
  const { dir, epoch } = makeRepo(t);
  git(dir, ['tag', 'plugin-runtime-v2.0.0-rc.1']);
  const r = classify(dir, { epoch });
  assert.equal(r.ran, false);
  assert.match(r.reason, /plain X\.Y\.Z/);
});

test('an unresolvable ref or epoch fails closed', (t) => {
  const { dir, epoch } = makeRepo(t);
  assert.equal(classify(dir, { ref: 'deadbee', epoch }).ran, false);
  assert.equal(classify(dir, { epoch: 'deadbee' }).ran, false);
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-release-obligation.mjs');
const runCli = (args) => execFileSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

test('the CLI exits 1 on debt and 0 on a fulfilled ref', () => {
  assert.match(runCli(['--ref', `${COUNTEREXAMPLE}^`, '--epoch', `${COUNTEREXAMPLE}^^`]), /fulfilled/);

  assert.throws(
    () => runCli(['--ref', COUNTEREXAMPLE, '--epoch', `${COUNTEREXAMPLE}^`]),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stdout, /outstanding_debt/);
      return true;
    },
  );
});

test('the CLI exits 1 when the check COULD NOT RUN, not just when it finds debt', () => {
  // `result.failing ? 1 : 0` leaves every fail-closed path exiting 0 — the
  // silent-no-op shape this whole family of gates exists to avoid.
  assert.throws(
    () => runCli(['--ref', 'definitely-not-a-ref']),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /COULD NOT RUN/);
      return true;
    },
  );
});

test('the CLI refuses a flag given without a value instead of auditing HEAD', () => {
  assert.throws(
    () => runCli(['--ref']),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /--ref requires a value/);
      return true;
    },
  );
  assert.throws(
    () => runCli(['--ref', '--json']),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /--ref requires a value/);
      return true;
    },
  );
});

test('--json emits the classification as data', () => {
  const out = runCli(['--ref', `${COUNTEREXAMPLE}^`, '--epoch', `${COUNTEREXAMPLE}^^`, '--json']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.state, 'fulfilled');
  assert.equal(parsed.newestTag, 'plugin-runtime-v0.89.0');
});

test('SemVer parsing rejects leading zeroes', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('0.90.1'), [0, 90, 1]);
  assert.equal(parseSemver('01.0.0'), null, 'leading zeroes are not SemVer and must not compare equal to 1.0.0');
  assert.equal(parseSemver('1.0'), null);
  assert.equal(parseSemver('1.0.0-rc.1'), null);
});
