// What a run reports, state by state — ADR-0065 Decision 8's table, run end to
// end: the two validator CLIs as validate.yml runs them, and the catalog
// writer as the release job runs it, against a real remote.
//
// The rules themselves (which commit may trail, by how much, and when a first
// release may lack its Codex entry) are pinned case by case in
// test-codex-catalog-pins.mjs. This file asks the question the table answers:
// after a release, which runs are green, which are red, and what turns a red
// one green. A release must leave no run red by design; a run that is red
// must be the true signal that the catalogs lag and the retry dispatch is due.
//
// Every fixture starts from an activated catalog (alpha and beta released at
// 1.0.0, pinned) plus gamma, a package added at 0.1.0 and not released yet, so
// a release can carry an existing package and a first release together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CLAUDE, CODEX,
  activate, addPackage, commit, git, makeRepo, push, readJSON, releaseCommit, remote, runCli, tag, write,
} from './fixtures/codex-pins-repo.mjs';

const WRITER = 'scripts/sync-marketplace-versions.mjs';
const SYNC_SUBJECT = 'chore(marketplace): sync catalog versions to release-please-manifest';
const head = (dir) => git(dir, ['rev-parse', 'HEAD']).trim();

/** A remote whose main has the activated catalog and the unreleased gamma. */
function released(t) {
  const seed = makeRepo(t);
  activate(seed);
  commit(seed, 'chore: activate');
  addPackage(seed, 'gamma');
  commit(seed, 'feat: add gamma');
  return remote(t, seed);
}

/** release-please merges the release PR: alpha 1.1.0 and gamma's first release, 0.2.0. */
function mergeRelease(dir, { tagged = true } = {}) {
  const sha = releaseCommit(dir, { alpha: '1.1.0', gamma: '0.2.0' }, { tagged });
  assert.equal(push(dir), true);
  return sha;
}

/**
 * The verdict validate.yml reaches on `dir`'s HEAD: both CLIs, with the
 * baseline it passes for a push to main (the sha main had before the push),
 * or none for a dispatch.
 */
function ci(dir, base = null) {
  const market = runCli(dir, 'scripts/validate-marketplace.mjs', base ? ['--base', base] : []);
  const versions = runCli(dir, 'scripts/validate-versions.mjs');
  return { green: market.status === 0 && versions.status === 0, market, versions };
}

function assertGreen(r, label) {
  assert.ok(r.green, `${label} is green:\n${r.market.stdout}${r.market.stderr}\n${r.versions.stdout}${r.versions.stderr}`);
}

/** Green with no release-commit lag excused: the verdict a strict check gives. */
function assertStrictGreen(r, label) {
  assertGreen(r, label);
  assert.doesNotMatch(r.market.stdout, /the release commit's own lag/, `${label}: validate-marketplace excused no lag`);
  assert.match(r.versions.stdout, /^OK — versions in sync across/, `${label}: validate-versions excused no lag`);
}

/** Make origin refuse every push until the returned function is called. */
function refusePushes(origin) {
  const hook = path.join(origin, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "refused by the test" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return () => rmSync(hook);
}

function assertRedOnLag(r, label) {
  assert.equal(r.green, false, `${label} is red`);
  assert.match(r.market.stderr, /\(alpha\): catalog version "1\.0\.0" != manifest version "1\.1\.0"/, `${label}: the Claude catalog lags`);
  assert.match(r.market.stderr, /plugins only in \.claude-plugin\/marketplace\.json: gamma/, `${label}: gamma's first pin is missing`);
  assert.match(r.versions.stderr, /entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.1\.0"/, `${label}: the Codex pin lags`);
}

/** The release job, on a fresh checkout of main: sync, then commit and push as the workflow does. */
function releaseJob(checkout) {
  const job = checkout();
  const out = runCli(job, WRITER);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /validated: phase activated/, 'the writer validates before it reports success');
  if (git(job, ['status', '--porcelain']).trim() !== '') commit(job, SYNC_SUBJECT);
  return job;
}

function assertSynced(dir) {
  assert.equal(readJSON(dir, CLAUDE).plugins.find((p) => p.name === 'alpha').version, '1.1.0');
  const codex = readJSON(dir, CODEX).plugins;
  assert.equal(codex.find((p) => p.name === 'alpha').source.ref, 'plugin-alpha-v1.1.0');
  assert.equal(codex.find((p) => p.name === 'gamma')?.source.ref, 'plugin-gamma-v0.2.0', 'gamma got its first pin');
}

for (const tagged of [true, false]) {
  test(`the release commit on main is green, its tags ${tagged ? 'cut' : 'not cut yet'} — and so is a dispatch of validate on it`, (t) => {
    const { checkout } = released(t);
    const dir = checkout();
    const before = head(dir);
    mergeRelease(dir, { tagged });
    assertGreen(ci(dir, before), 'the release commit\'s push run');
    assertGreen(ci(dir), 'a dispatch of validate on the release commit (no baseline)');
  });
}

test('the sync commit is checked by the writer before its push, and strictly by the next push that descends from it', (t) => {
  const { checkout } = released(t);
  mergeRelease(checkout());
  const job = releaseJob(checkout);
  const releaseSha = git(job, ['rev-parse', 'HEAD^']).trim();
  assert.equal(git(job, ['log', '-1', '--format=%s']).trim(), SYNC_SUBJECT);
  assertSynced(job);
  assert.equal(push(job), true);
  // The sync commit itself gets no run (a GITHUB_TOKEN push). The next push
  // to main validates the tree that includes it, against it as the baseline.
  const person = checkout();
  const syncSha = head(person);
  assert.notEqual(syncSha, releaseSha);
  write(person, 'docs/note.md', 'next change\n');
  commit(person, 'docs: the next change on main');
  assertStrictGreen(ci(person, syncSha), 'the next push after the sync');
});

test('a manual dispatch with no new release re-runs the sync, writes nothing, and still validates', (t) => {
  const { checkout } = released(t);
  mergeRelease(checkout());
  assert.equal(push(releaseJob(checkout)), true);
  const job = checkout();
  const out = runCli(job, WRITER);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already in sync/);
  assert.match(out.stdout, /validated: phase activated/);
  assert.equal(git(job, ['status', '--porcelain']).trim(), '', 'nothing to commit, nothing to push');
});

test('a commit that lands on main while the release job runs is red until the retry dispatch; the bot\'s push is rejected', (t) => {
  const { checkout } = released(t);
  mergeRelease(checkout());
  const job = checkout(); // the release job checks out the release commit
  const person = checkout();
  const releaseSha = head(person);
  write(person, 'docs/note.md', 'landed during the release job\n');
  commit(person, 'docs: lands while the release job runs');
  assert.equal(push(person), true);
  assertRedOnLag(ci(person, releaseSha), 'the commit that landed during the release job');

  const out = runCli(job, WRITER);
  assert.equal(out.status, 0, out.stderr);
  commit(job, SYNC_SUBJECT);
  assert.equal(push(job), false, 'non-fast-forward: main moved under the job, and the push is never forced');

  // The retry path: a manual dispatch checks out the new main and syncs it.
  const retry = releaseJob(checkout);
  assertSynced(retry);
  const landed = head(checkout());
  assert.equal(push(retry), true);
  const after = checkout();
  write(after, 'docs/next.md', 'after the retry\n');
  commit(after, 'docs: the next change');
  assertGreen(ci(after, landed), 'the next push after the retry dispatch');
});

test('the tag cut, the catalog push failed: the release commit stays green, the next push is red until the retry dispatch', (t) => {
  const { origin, checkout } = released(t);
  const merged = checkout();
  const before = head(merged);
  mergeRelease(merged);
  assertGreen(ci(merged, before), 'the release commit');
  // The release job syncs, and its push fails; nothing reaches main.
  const job = checkout();
  const out = runCli(job, WRITER);
  assert.equal(out.status, 0, out.stderr);
  commit(job, SYNC_SUBJECT);
  const allowPushes = refusePushes(origin);
  assert.equal(push(job), false, 'the catalog push fails');
  allowPushes();
  // A person pushes next.
  const person = checkout();
  const releaseSha = head(person);
  assert.equal(git(person, ['log', '-1', '--format=%s']).trim(), 'chore: release main', 'main is still the release commit');
  write(person, 'docs/note.md', 'the next change\n');
  commit(person, 'docs: the next change');
  assert.equal(push(person), true);
  assertRedOnLag(ci(person, releaseSha), 'the next push');
  const retry = releaseJob(checkout);
  assertSynced(retry);
  assert.equal(push(retry), true);
  const after = checkout();
  assertGreen(ci(after), 'main after the retry dispatch');
});

// The missing tag is either a released package's next one, or a package's
// first: a first release with no tag must not pass for a package never released.
for (const [name, version] of [['beta', '1.1.0'], ['gamma', '0.2.0']]) {
  test(`a release that tagged only some packages (${name}'s tag missing): the commit is green, the writer refuses it all, and the completed release syncs`, (t) => {
    const { checkout } = released(t);
    const dir = checkout();
    const before = head(dir);
    releaseCommit(dir, { alpha: '1.1.0', [name]: version });
    tag(dir, 'plugin-alpha-v1.1.0');
    assert.equal(push(dir), true);
    assertGreen(ci(dir, before), 'the release commit, whether or not its tags exist');

    const job = checkout();
    const refused = runCli(job, WRITER);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused — nothing was written/);
    assert.match(refused.stderr, new RegExp(`${name} is at ${version.replaceAll('.', '\\.')} but plugin-${name}-v${version.replaceAll('.', '\\.')} does not resolve`));
    assert.equal(git(job, ['status', '--porcelain']).trim(), '', 'not even the Claude catalog is written');

    // The remedy: complete the missing release, then dispatch.
    const fix = checkout();
    tag(fix, `plugin-${name}-v${version}`);
    assert.equal(push(fix), true);
    const retry = releaseJob(checkout);
    const codex = readJSON(retry, CODEX).plugins;
    assert.deepEqual(['alpha', name].map((n) => codex.find((p) => p.name === n)?.source.ref), ['plugin-alpha-v1.1.0', `plugin-${name}-v${version}`]);
    assert.equal(push(retry), true);
    assertStrictGreen(ci(checkout()), 'main after the completed release is synced');
  });
}
