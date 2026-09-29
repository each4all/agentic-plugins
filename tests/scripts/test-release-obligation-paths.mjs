// The protected-path seam in scripts/check-release-obligation.mjs (ADR-0060).
//
// `classify` compares two protected SETS — the one at the evaluated ref and the
// one the newest release tag carries — and both are drawn through ONE list. The
// real-history replays in test-release-obligation.mjs need that list to be the
// one of their time: the counterexample they replay (`16b1833`) changed only the
// host-parity baseline, and ADR-0060's release recovery removed the baseline
// entry from the live list. `classify` therefore takes the list as `paths`.
//
// These cases live in their own file, and every one of them builds its own
// repository, for a reason worth keeping: the mutation harness scores a test
// file inside an archive with no `.git`, where the real-history replays cannot
// run at all. A seam proven only by those replays could never be mutation-
// checked, so the seam is proven here, where it can.
//
// Each case pins one place the list must reach. A digest computed through the
// default list while its partner used the supplied one would compare two sets
// drawn through two lists, which is to say nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { classify, protectedChangesInWindow, protectedEntries, PROTECTED_PATHS } from '../../scripts/check-release-obligation.mjs';

// A file that is NOT under the live protected list, so only a supplied list can
// make it protected. The live list's own members keep the set non-empty.
const EXTRA = 'plugins/runtime/docs/retired-asset.md';
const PLUGIN_SET = 'plugins/runtime/data/plugin-set.json';
const SCHEMA = 'plugins/runtime/data/schemas/runtime-thing-1.0.json';
const WITH_EXTRA = Object.freeze([...PROTECTED_PATHS, EXTRA]);

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

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

/** v1.0.0, tagged, carrying the live protected files plus EXTRA. */
function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-obligation-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  write(dir, PLUGIN_SET, '{"plugins":["runtime"]}\n');
  write(dir, SCHEMA, '{"$id":"runtime-thing-1.0"}\n');
  write(dir, EXTRA, 'retired\n');
  setVersion(dir, '1.0.0');
  const epoch = commit(dir, 'chore: scaffold');
  git(dir, ['tag', 'plugin-runtime-v1.0.0']);
  return { dir, epoch };
}

test('CONTROL: the scaffold is fulfilled through either list', (t) => {
  const { dir, epoch } = makeRepo(t);
  assert.equal(classify(dir, { epoch }).state, 'fulfilled');
  assert.equal(classify(dir, { epoch, paths: WITH_EXTRA }).state, 'fulfilled');
});

test('a change visible only through the supplied list is debt through that list, and only that list', (t) => {
  // The shape of the 16b1833 replay once the live list stops naming the file it
  // changed: the same commit, judged through two lists, gets two verdicts.
  const { dir, epoch } = makeRepo(t);
  write(dir, EXTRA, 'retired, then edited\n');
  const sha = commit(dir, 'docs(runtime): edit the retired asset');

  const live = classify(dir, { epoch });
  assert.equal(live.state, 'fulfilled', 'the live list does not name the file, so it sees no change');

  const then = classify(dir, { epoch, paths: WITH_EXTRA });
  assert.equal(then.state, 'outstanding_debt');
  assert.ok(then.protectedFiles.includes(EXTRA), 'the head set was drawn through the supplied list');
  // The change window is the third place the list must reach: pinned by
  // identity, so a window drawn through the live list (empty here) fails it.
  assert.deepEqual(then.inScopeChanges.map((c) => c.sha), [sha]);
  // And the report says which list it used, so a replay cannot be mistaken for
  // a verdict about the live configuration.
  assert.deepEqual(then.protectedPaths, [...WITH_EXTRA]);
  assert.deepEqual(live.protectedPaths, [...PROTECTED_PATHS]);
});

test('the pending-release digest is drawn through the supplied list', (t) => {
  // A release commit advanced the manifest, so the pending tag will be cut AT
  // it. A change that landed BEFORE that commit will ship with the tag, so it
  // is in flight — which is decided by comparing the tree at the release
  // commit against HEAD. Drawn through the live list on one side and the
  // supplied list on the other, the two sets would differ by EXTRA alone and a
  // change the pending tag carries would read as debt.
  const { dir, epoch } = makeRepo(t);
  write(dir, EXTRA, 'edited before the release commit\n');
  commit(dir, 'docs(runtime): edit the retired asset');
  setVersion(dir, '1.1.0');
  commit(dir, 'chore: release main');

  assert.equal(classify(dir, { epoch, paths: WITH_EXTRA }).state, 'release_in_flight');

  // CONTROL: a change landing AFTER the release commit is not carried by the
  // pending tag, and the same list must say so.
  write(dir, EXTRA, 'edited after the release commit\n');
  commit(dir, 'docs(runtime): edit the retired asset after the release commit');
  const after = classify(dir, { epoch, paths: WITH_EXTRA });
  assert.equal(after.state, 'outstanding_debt');
  assert.match(after.detail, /moved again after it/);
});

test('the epoch digest is drawn through the supplied list', (t) => {
  // Grandfathering compares the tree at the epoch against HEAD. Here the
  // divergence from the tag already existed AT the epoch and nothing has moved
  // since, so it is grandfathered — but only if the epoch set is drawn through
  // the same list as the head set. Drawn through the live list, the two sets
  // would differ by EXTRA alone and the amnesty would read as live debt.
  const { dir } = makeRepo(t);
  write(dir, EXTRA, 'diverged before adoption\n');
  const epoch = commit(dir, 'docs(runtime): diverge before the rule was adopted');

  const then = classify(dir, { epoch, paths: WITH_EXTRA });
  assert.equal(then.state, 'pre_epoch_divergence');
  assert.equal(then.failing, false);

  // CONTROL: one more change after the epoch spends the amnesty.
  write(dir, EXTRA, 'moved again after adoption\n');
  commit(dir, 'docs(runtime): move after adoption');
  assert.equal(classify(dir, { epoch, paths: WITH_EXTRA }).state, 'outstanding_debt');
});

test('an empty or malformed path list is refused, never read as the whole tree', (t) => {
  // Found in the ADR-0060 review. With no pathspec after `--`, `ls-tree -r`
  // lists every file and `rev-list` walks every commit, so an empty list judged
  // the whole repository as protected and reported a verdict about it.
  const { dir, epoch } = makeRepo(t);
  // Make the whole-tree reading produce DEBT, so a missing refusal cannot pass
  // by accident: a file outside every protected path changes after the tag.
  write(dir, 'README.md', 'outside every protected path\n');
  commit(dir, 'docs: touch a file nobody protects');

  for (const paths of [[], [''], ['  '], 'plugins/runtime/data', [PLUGIN_SET, null]]) {
    const r = classify(dir, { epoch, paths });
    assert.equal(r.ran, false, `refused: ${JSON.stringify(paths)}`);
    assert.equal(r.state, null);
    assert.match(r.reason, /protected path list/);
  }
  assert.throws(() => protectedEntries(dir, 'HEAD', []), /protected path list is empty/);
  assert.throws(() => protectedChangesInWindow(dir, { sinceRef: 'plugin-runtime-v1.0.0', ref: 'HEAD', paths: [] }), /protected path list is empty/);

  // CONTROL: the same repository through the live list is fulfilled — the
  // change above touched nothing protected — so the refusal is about the list.
  assert.equal(classify(dir, { epoch }).state, 'fulfilled');
});
