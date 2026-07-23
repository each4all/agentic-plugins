// tests/runtime/test-bootstrap.mjs — machine-bootstrap-contract.md §11.2.
//
// S8a2 C3 owns the STORAGE obligations of that list: #16 path security (the
// machine-global half), #28 family-lock race, #29 abandonment, #30 profile
// overwrite, #32 machine-global inventory + retention. The rest arrive with the
// schemas (C4) and the profile/reducer engines (C5).
//
// Every test runs against an INJECTED temp home. Nothing here may read the
// developer's real ~/.agentic-plugins — a suite that passed only because the
// machine it ran on happened to be empty would be hermetic by accident, not by
// construction.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { chmod, link, mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm, readdir, utimes } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOOTSTRAP_RETENTION_CAP,
  LOCK_STALE_MS,
  abandonBootstrapRun,
  acquireBootstrapFamilyLock,
  bootstrapFamilyRoot,
  bootstrapLatestFile,
  bootstrapLockFile,
  bootstrapRunManifestFile,
  createBootstrapRun,
  isValidProfileName,
  listMachineProfiles,
  makeBootstrapRunId,
  profileFile,
  readBootstrapLatest,
  readMachineProfile,
  repairBootstrapLatest,
  reportBootstrapRetention,
  resolveMachineArtifactHome,
  scanBootstrapRuns,
  selectBlockingRuns,
  validateBootstrapRunId,
  validateProfileName,
  writeBootstrapFragment,
  writeBootstrapProof,
  writeMachineProfile,
} from '../../plugins/runtime/scripts/lib/bootstrap-artifacts.mjs';
import { inspectRuntimeArtifactInventory, machinePointer } from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { isUnder } from '../../plugins/runtime/scripts/lib/path-containment.mjs';
import { makeValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const NOW = new Date('2026-07-17T09:00:00Z');
const RUNTIME_SCRIPTS = new URL('../../plugins/runtime/scripts/', import.meta.url).pathname;

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-bootstrap-'));
  return dir;
}

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-repo-'));
  return dir;
}

function baseManifest() {
  return {
    schema: 'runtime-bootstrap-run-1.0',
    selection: { bundle: 'base', desired: ['runtime', 'companions'], excluded: [] },
    steps: [],
    boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
  };
}

async function seedRun(homeDir, runId, overrides = {}) {
  const dir = join(bootstrapFamilyRoot(homeDir), runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), `${JSON.stringify({ ...baseManifest(), run_id: runId, status: 'complete', started_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides }, null, 2)}\n`);
  return dir;
}

describe('runtime bootstrap artifacts — ids and names', () => {
  it('run ids follow the family idiom and reject traversal shapes', () => {
    const id = makeBootstrapRunId(NOW);
    match(id, /^bootstrap-20260717T090000Z-[0-9a-f]{6}$/);
    strictEqual(validateBootstrapRunId(id), id);
    for (const bad of ['bootstrap-../../x', '../../etc', 'bootstrap-2026-07-17T09:00:00Z-abc', 'consensus-20260717T090000Z-abcdef', '']) {
      let threw = false;
      try { validateBootstrapRunId(bad); } catch { threw = true; }
      ok(threw, `rejects run id '${bad}'`);
    }
  });

  // #16 (name half) — the charset is an allowlist, so an encoding its author never
  // met still lands outside it.
  it('profile names reject traversal, separators, leading dots, and NUL', () => {
    for (const good of ['work', 'macbook-pro', 'machine_1', 'a.b-c_d', 'A1']) {
      ok(isValidProfileName(good), `accepts '${good}'`);
    }
    for (const bad of ['../../x', 'a/b', 'a\\b', '..', '.hidden', 'a\0b', '', 'x'.repeat(65), '-leading', '_leading']) {
      ok(!isValidProfileName(bad), `rejects ${JSON.stringify(bad)}`);
      let threw = false;
      try { validateProfileName(bad); } catch { threw = true; }
      ok(threw, `validateProfileName throws on ${JSON.stringify(bad)}`);
    }
  });
});

describe('runtime path containment — one authority', () => {
  it('both security gates import the shared predicate; neither keeps a private copy', async () => {
    const PRIVATE_COPY = /function isUnder\s*\(/;
    for (const rel of ['lib/bootstrap-artifacts.mjs', 'lib/egress-config.mjs']) {
      const src = await readFile(join(RUNTIME_SCRIPTS, rel), 'utf8');
      ok(/from '\.\/path-containment\.mjs'/.test(src), `${rel} imports the shared containment predicate`);
      ok(!PRIVATE_COPY.test(src), `${rel} does not define a private isUnder — a second copy is the mirror`);
    }
  });

  it('containment answers what it says', () => {
    ok(isUnder('/a/b', '/a'), 'a child is under its parent');
    ok(isUnder('/a', '/a'), 'a path is under itself');
    ok(!isUnder('/ab', '/a'), 'a name PREFIX is not containment');
    ok(!isUnder('/a', '/a/b'), 'a parent is not under its child');
    ok(!isUnder('/a/b', null), 'a null parent contains nothing');
    ok(isUnder('/a/b/../c', '/a'), 'traversal normalizes before comparing');
    ok(!isUnder('/a/../b', '/a'), 'and traversal OUT is not containment');
  });
});

describe('runtime bootstrap artifacts — security gates (#16)', () => {
  it('fails closed when $HOME is the repository', async () => {
    const repoRoot = await tempRepo();
    const result = await resolveMachineArtifactHome({ homeDir: repoRoot, repoRoot });
    strictEqual(result.ok, false);
    strictEqual(result.reason, 'home-is-repo');
    match(result.diagnostic, /INSIDE the current repository/);
    strictEqual(result.root, null);
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('fails closed when the home resolves under the repo by symlink, not only lexically', async () => {
    const repoRoot = await tempRepo();
    const homeDir = await tempHome();
    // ~/.agentic-plugins -> <repo>/inside : lexically outside, canonically inside.
    await mkdir(join(repoRoot, 'inside'), { recursive: true });
    await symlink(join(repoRoot, 'inside'), join(homeDir, '.agentic-plugins'));
    const result = await resolveMachineArtifactHome({ homeDir, repoRoot });
    strictEqual(result.ok, false, 'a canonically-inside-repo home is refused');
    strictEqual(result.reason, 'home-is-repo');
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('fails closed when repoRoot is omitted, and allows an explicit null', async () => {
    const homeDir = await tempHome();
    const omitted = await resolveMachineArtifactHome({ homeDir });
    strictEqual(omitted.ok, false);
    strictEqual(omitted.reason, 'repo-root-required');

    const explicit = await resolveMachineArtifactHome({ homeDir, repoRoot: null });
    strictEqual(explicit.ok, true, 'an explicit null asserts no repository context');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('a normal home outside the repo resolves, and a symlinked home is not itself a finding', async () => {
    const repoRoot = await tempRepo();
    const homeDir = await tempHome();
    const result = await resolveMachineArtifactHome({ homeDir, repoRoot });
    strictEqual(result.ok, true);
    ok(result.root.endsWith('.agentic-plugins'));
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: every realpath failure was read as "does not exist", so the
  // canonicaliser climbed past an unreadable component and re-appended a lexical
  // tail — an EACCES could therefore hide that the home resolves inside the repo.
  // An unanswered safety question must fail CLOSED, not resolve to "fine".
  it('a canonicalization failure fails CLOSED rather than reading as absent', async () => {
    const repoRoot = await tempRepo();
    const homeDir = await tempHome();
    // A symlink LOOP: realpath answers ELOOP, which is neither "here" nor "absent".
    await symlink(join(homeDir, '.agentic-plugins'), join(homeDir, '.agentic-plugins'));

    const result = await resolveMachineArtifactHome({ homeDir, repoRoot });
    strictEqual(result.ok, false, 'refuses rather than proceeding on an unresolvable home');
    strictEqual(result.reason, 'canonicalization-failed');
    match(result.diagnostic, /cannot prove the home is outside the repository/);
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('diagnostics carry no absolute home path either — only pointers were sanitized before', async () => {
    const homeDir = await tempHome();
    const elsewhere = await mkdtemp(join(tmpdir(), 'agentic-elsewhere-'));
    await mkdir(join(homeDir, '.agentic-plugins'), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, join(homeDir, '.agentic-plugins', 'profiles'));

    const result = await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: { a: 1 }, now: NOW });
    strictEqual(result.written, false);
    ok(!result.diagnostics.join(' ').includes(homeDir), 'the refusal names the path home-relatively');
    match(result.diagnostics[0], /~\/\.agentic-plugins/);
    await rm(homeDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('refuses a symlinked path COMPONENT, not just a symlinked leaf', async () => {
    const homeDir = await tempHome();
    const elsewhere = await mkdtemp(join(tmpdir(), 'agentic-elsewhere-'));
    // Redirect the whole runs/ subtree out of the home: a leaf-only check would
    // happily write through it.
    await mkdir(join(homeDir, '.agentic-plugins'), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, join(homeDir, '.agentic-plugins', 'runs'));

    const result = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(result.created, false, 'the write is refused');
    strictEqual(result.reason, 'symlinked-component');
    match(result.diagnostics[0], /symlinked path component/);
    const leaked = await readdir(elsewhere);
    deepStrictEqual(leaked, [], 'nothing was written through the symlink');
    await rm(homeDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('creates directories 0700 and files 0600', async () => {
    const homeDir = await tempHome();
    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(created.created, true);

    const runStat = await stat(join(bootstrapFamilyRoot(homeDir), created.run_id));
    strictEqual(runStat.mode & 0o777, 0o700, 'run directory is 0700');
    const manifestStat = await stat(bootstrapRunManifestFile(homeDir, created.run_id));
    strictEqual(manifestStat.mode & 0o777, 0o600, 'run.json is 0600');
    const latestStat = await stat(bootstrapLatestFile(homeDir));
    strictEqual(latestStat.mode & 0o777, 0o600, 'latest.json is 0600');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('pointers are home-relative, never absolute (no operator layout in an artifact)', async () => {
    const homeDir = await tempHome();
    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    match(created.pointer, /^~\/\.agentic-plugins\/runs\/bootstrap\/bootstrap-/);
    ok(!created.pointer.includes(homeDir), 'the real home path does not appear in the pointer');

    const latest = JSON.parse(await readFile(bootstrapLatestFile(homeDir), 'utf8'));
    match(latest.run_pointer, /^~\/\.agentic-plugins\//);
    ok(!JSON.stringify(latest).includes(homeDir), 'latest.json carries no absolute home path');
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — family lock (#28)', () => {
  it('two concurrent creates do not both create a run, and latest.json is never orphaned', async () => {
    const homeDir = await tempHome();
    const [a, b] = await Promise.all([
      createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() }),
      createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() }),
    ]);

    const created = [a, b].filter((r) => r.created);
    const rejected = [a, b].filter((r) => !r.created);
    strictEqual(created.length, 1, 'exactly one create wins');
    strictEqual(rejected.length, 1, 'the other is rejected');
    strictEqual(rejected[0].reason, 'run-open', 'rejected because a run is already open');
    ok(rejected[0].blocking.some((run) => run.run_id === created[0].run_id), 'the rejection NAMES the open run');
    match(rejected[0].diagnostics[0], /abandon bootstrap-/, 'and points at the recovery');

    const scan = await scanBootstrapRuns({ homeDir });
    strictEqual(scan.runs.length, 1, 'exactly one run directory exists');
    const latest = await readBootstrapLatest({ homeDir });
    strictEqual(latest.status, 'ok');
    strictEqual(latest.run_id, created[0].run_id, 'latest points at the run that exists');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('a held, fresh lock is reported — never silently stolen', async () => {
    const homeDir = await tempHome();
    const held = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW });
    strictEqual(held.ok, true);

    const second = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW, attempts: 2, retryDelayMs: 1 });
    strictEqual(second.ok, false);
    strictEqual(second.reason, 'lock-held');
    match(second.diagnostics[0], /Do not delete the lock by hand/);
    strictEqual(second.holder.pid, process.pid);

    await held.handle.release();
    const third = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW });
    strictEqual(third.ok, true, 'the lock is acquirable once released');
    await third.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('breaks a lock whose owning pid is gone, with a reported diagnostic', async () => {
    const homeDir = await tempHome();
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(bootstrapLockFile(homeDir), `${JSON.stringify({ owner_token: 'deadbeef', pid: 999_999, acquired_at: NOW.toISOString() })}\n`, { mode: 0o600 });

    const lock = await acquireBootstrapFamilyLock({
      homeDir,
      repoRoot: null,
      now: NOW,
      isPidAlive: (pid) => pid !== 999_999,
    });
    strictEqual(lock.ok, true, 'the stale lock is reclaimed');
    ok(lock.diagnostics.some((d) => /Reclaimed a stale bootstrap family lock/.test(d) && /pid 999999 is gone/.test(d)), 'the break is reported, naming why');
    await lock.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('breaks a lock past the age bound even when its pid still exists', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ owner_token: 'abc123', pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    // Age is the FILE's, judged against the real clock. Both terms come from the
    // filesystem's timeline, so the way to make a lock old is to make the file old.
    const ancient = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(lockPath, ancient, ancient);

    const lock = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW, isPidAlive: () => true });
    strictEqual(lock.ok, true);
    ok(lock.diagnostics.some((d) => /exceeds the 600s bound/.test(d)), 'the age reason is reported');
    await lock.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  // The two clocks must never cross: `now` stamps artifacts, the real clock decides
  // staleness. When they were the same value, a test clock a few hours ahead of the
  // machine made every fresh lock read as hours old — so two concurrent processes
  // broke each other's LIVE locks and both proceeded.
  it('an artifact clock far from real time does not make a fresh lock stale', async () => {
    const homeDir = await tempHome();
    const farFuture = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const held = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: farFuture });
    strictEqual(held.ok, true);

    const second = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: farFuture, attempts: 1, isPidAlive: () => true });
    strictEqual(second.ok, false, 'the fresh lock is NOT stale, whatever the artifact clock says');
    strictEqual(second.reason, 'lock-held');
    await held.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('does NOT break a young lock whose pid liveness is unknowable', async () => {
    const homeDir = await tempHome();
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(bootstrapLockFile(homeDir), `${JSON.stringify({ owner_token: 'abc123', pid: 4242, acquired_at: NOW.toISOString() })}\n`, { mode: 0o600 });

    // EPERM = the process exists but belongs to another user. "I could not tell"
    // must never read as "safe to break someone's lock".
    const lock = await acquireBootstrapFamilyLock({
      homeDir,
      repoRoot: null,
      now: NOW,
      attempts: 1,
      isPidAlive: (pid) => { strictEqual(pid, 4242); return true; },
    });
    strictEqual(lock.ok, false);
    strictEqual(lock.reason, 'lock-held');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('an unparseable lock is reclaimed on AGE only, never instantly', async () => {
    const homeDir = await tempHome();
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(bootstrapLockFile(homeDir), 'not json at all', { mode: 0o600 });

    // Fresh corruption: a live holder must not be evicted because a byte flipped.
    const young = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW, attempts: 1 });
    strictEqual(young.ok, false, 'a freshly-written unparseable lock is left alone');
    strictEqual(young.reason, 'lock-held');

    // Same file, aged past the bound on the filesystem's own clock.
    const ancient = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(bootstrapLockFile(homeDir), ancient, ancient);
    const old = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null });
    strictEqual(old.ok, true, 'past the bound it is reclaimable');
    await old.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  // The tokenless-break race, in the small. A breaker that judged a CORRUPT lock has
  // no token to recheck; if the recheck is skipped on that ground, the breaker
  // deletes whatever it grabbed. Here the corrupt lock is replaced by a live one
  // between the judgement and the break — the break must notice by file IDENTITY and
  // concede, or two processes end up believing they hold the family lock.
  it('a stale break that grabs a DIFFERENT file than it judged concedes and restores it', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    // A lock with NO owner_token — so the token half of the recheck has nothing to
    // compare and passes vacuously, leaving file identity as the only guard. Old
    // enough to be judged stale on age.
    const ancient = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await writeFile(lockPath, `${JSON.stringify({ pid: 4242, acquired_at: ancient.toISOString() })}\n`, { mode: 0o600 });

    // Swap a LIVE lock in at the same name, after the judgement and before the
    // break. unlink-then-write, not truncate-in-place: the point is a DIFFERENT
    // inode, which is what the recheck must notice.
    let swapped = false;
    const isPidAlive = () => {
      if (!swapped) {
        swapped = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, `${JSON.stringify({ owner_token: 'fresh-holder', pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
      }
      return false; // the judged pid is "gone" → the break proceeds
    };

    const result = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, attempts: 1, isPidAlive });
    strictEqual(result.ok, false, 'the breaker must NOT take a lock it never judged');
    const survivor = JSON.parse(await readFile(lockPath, 'utf8'));
    strictEqual(survivor.owner_token, 'fresh-holder', "the live holder's lock was restored, not deleted");
    await rm(homeDir, { recursive: true, force: true });
  });

  // `acquired_at` is metadata the lock carries about itself; the mtime is what the
  // kernel observed. A corrupt — or forged-future — timestamp in the body must not
  // decide anything: as the age authority it could evict a live holder the instant a
  // byte flipped, or (set to year 9999) make the lock permanently unbreakable.
  it('a lock with a malformed or future acquired_at is aged by file mtime, which the body cannot forge', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ owner_token: 'live', pid: process.pid, acquired_at: 'not-a-date' })}\n`, { mode: 0o600 });

    const young = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, attempts: 1, isPidAlive: () => true });
    strictEqual(young.ok, false, 'a freshly-written lock with a bad date is NOT stale');
    strictEqual(young.reason, 'lock-held');

    // A body claiming the year 9999 must not buy immortality: with acquired_at as the
    // authority the age goes permanently negative and NOBODY could ever reclaim it.
    await writeFile(lockPath, `${JSON.stringify({ owner_token: 'live', pid: process.pid, acquired_at: '9999-01-01T00:00:00.000Z' })}\n`, { mode: 0o600 });
    const ancient = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(lockPath, ancient, ancient);
    const old = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, isPidAlive: () => true });
    strictEqual(old.ok, true, 'an OLD file mtime makes it reclaimable regardless of what the body claims');
    ok(old.diagnostics.some((d) => /exceeds the 600s bound/.test(d)), 'the age reason is reported');
    await old.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: an unreadable lock returned "not stale" with no metadata, so a
  // single `chmod 000` built a lock nobody could ever break — the permanent block
  // §10.2 exists to forbid. Identity and mtime survive an unreadable body; the break
  // needs exactly those two facts.
  it('an UNREADABLE lock is still reclaimable — a chmod must not wedge the machine forever', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ owner_token: 'x', pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    await chmod(lockPath, 0o000);
    const ancient = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(lockPath, ancient, ancient);

    try {
      const lock = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null });
      strictEqual(lock.ok, true, 'an old unreadable lock is reclaimed, not obeyed forever');
      await lock.handle.release();
    } finally {
      await chmod(lockPath, 0o600).catch(() => {});
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  // The other half of the same permanent-block class: moving the age authority to the
  // mtime defeats a forged BODY, but a pid-less lock dated in the future would then
  // block until that date. Metadata that cannot be true is unusable, not obeyed.
  it('a pid-less lock dated implausibly in the future is reclaimable, not permanent', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, 'corrupt — no pid to probe', { mode: 0o600 });
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    await utimes(lockPath, farFuture, farFuture);

    const lock = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null });
    strictEqual(lock.ok, true, 'the family is not blocked until the year on the file');
    ok(lock.diagnostics.some((d) => /implausibly far in the future/.test(d)), 'and the reason is reported');
    await lock.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('a LIVE-pid lock is never broken by a future mtime — the pid is the better evidence', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${JSON.stringify({ owner_token: 'live', pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    await utimes(lockPath, farFuture, farFuture);

    const lock = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, attempts: 1, isPidAlive: () => true });
    strictEqual(lock.ok, false, 'a backwards clock jump must not evict a running holder');
    strictEqual(lock.reason, 'lock-held');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('an untrusted lock body never reaches the caller or a diagnostic verbatim', async () => {
    const homeDir = await tempHome();
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    // A body is just bytes at a path: its `pid` can be a string carrying a home path.
    await writeFile(bootstrapLockFile(homeDir), `${JSON.stringify({ owner_token: 'x', pid: `${homeDir}/secret`, acquired_at: 'garbage', extra: `${homeDir}/leak` })}\n`, { mode: 0o600 });

    const lock = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, attempts: 1 });
    strictEqual(lock.ok, false);
    deepStrictEqual(lock.holder, { pid: null, acquired_at: null }, 'only validated fields survive');
    ok(!JSON.stringify(lock).includes(homeDir), 'nothing from the body leaks into the result or diagnostics');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('release is token-keyed: a dispossessed holder never destroys the new lock', async () => {
    const homeDir = await tempHome();
    const first = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW });
    strictEqual(first.ok, true);

    // Simulate the break: a second holder replaces the lock file under us.
    await writeFile(bootstrapLockFile(homeDir), `${JSON.stringify({ owner_token: 'someone-else', pid: process.pid, acquired_at: NOW.toISOString() })}\n`, { mode: 0o600 });
    strictEqual(await first.handle.assertOwned(), false, 'the handle knows it was dispossessed');

    const released = await first.handle.release();
    strictEqual(released.released, false);
    strictEqual(released.reason, 'not-owner');
    const survivor = JSON.parse(await readFile(bootstrapLockFile(homeDir), 'utf8'));
    strictEqual(survivor.owner_token, 'someone-else', "the new holder's lock survived");
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — latest.json recovery', () => {
  it('recovers a corrupted pointer by scanning, and reports it — without writing (R0)', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await seedRun(homeDir, runId);
    await writeFile(bootstrapLatestFile(homeDir), '{ truncated', { mode: 0o600 });

    const latest = await readBootstrapLatest({ homeDir });
    strictEqual(latest.status, 'recovered');
    strictEqual(latest.pointer_state, 'malformed');
    strictEqual(latest.run_id, runId);
    strictEqual(latest.recovery_source, 'scan');
    match(latest.diagnostics[0], /recovered by scanning run directories/);

    const onDisk = await readFile(bootstrapLatestFile(homeDir), 'utf8');
    strictEqual(onDisk, '{ truncated', 'the read path did NOT write — doctor calls it');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('recovers an ORPHANED pointer (names a run that no longer exists)', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await seedRun(homeDir, runId);
    await writeFile(bootstrapLatestFile(homeDir), `${JSON.stringify({ run_id: 'bootstrap-20200101T000000Z-aaaaaa' })}\n`, { mode: 0o600 });

    const latest = await readBootstrapLatest({ homeDir });
    strictEqual(latest.status, 'recovered');
    strictEqual(latest.pointer_state, 'orphaned');
    strictEqual(latest.run_id, runId);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('repairBootstrapLatest persists the recovery under the lock', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await seedRun(homeDir, runId);
    await writeFile(bootstrapLatestFile(homeDir), '{ truncated', { mode: 0o600 });

    const repair = await repairBootstrapLatest({ homeDir, repoRoot: null, now: NOW });
    strictEqual(repair.repaired, true, 'the result is unwrapped like every other mutating entry point');
    strictEqual(repair.run_id, runId);
    const persisted = JSON.parse(await readFile(bootstrapLatestFile(homeDir), 'utf8'));
    strictEqual(persisted.run_id, runId);
    strictEqual(persisted.status, 'complete');

    const after = await readBootstrapLatest({ homeDir });
    strictEqual(after.status, 'ok', 'the pointer reads clean afterwards');
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: a blocked scan fell through to recover(), which reported `empty`
  // with no diagnostic — claiming the family is empty when we could not read it —
  // and could call a perfectly valid pointer `orphaned` because the scan that would
  // have confirmed its run failed. "I could not look" is not "nothing is there".
  it('a blocked scan reports blocked — never empty, never orphaned', async () => {
    const homeDir = await tempHome();
    const family = bootstrapFamilyRoot(homeDir);
    await mkdir(family, { recursive: true, mode: 0o700 });
    await writeFile(bootstrapLatestFile(homeDir), '{ truncated', { mode: 0o600 });
    await chmod(family, 0o000);
    try {
      const latest = await readBootstrapLatest({ homeDir });
      strictEqual(latest.status, 'blocked');
      strictEqual(latest.recovered, false, 'nothing is claimed to be recovered');
      match(latest.diagnostics[0], /cannot be resolved or recovered/);
    } finally {
      await chmod(family, 0o700);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('an empty family reports missing/empty rather than inventing a run', async () => {
    const homeDir = await tempHome();
    const latest = await readBootstrapLatest({ homeDir });
    strictEqual(latest.status, 'missing');
    strictEqual(latest.run_id, null);
    strictEqual(latest.recovered, false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('a foreign directory cannot sort itself newest', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await seedRun(homeDir, runId);
    await mkdir(join(bootstrapFamilyRoot(homeDir), 'zzz-not-a-run'), { recursive: true });

    const scan = await scanBootstrapRuns({ homeDir });
    deepStrictEqual(scan.runs.map((r) => r.run_id), [runId]);
    deepStrictEqual(scan.foreign, ['zzz-not-a-run']);
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — abandonment (#29)', () => {
  it('a crashed open run is closable, and a new plan then succeeds', async () => {
    const homeDir = await tempHome();
    const first = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(first.created, true);

    // The crash: the run stays open forever with nobody to finish it.
    const blocked = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(blocked.created, false);
    strictEqual(blocked.reason, 'run-open');

    const abandoned = await abandonBootstrapRun({ homeDir, repoRoot: null, runId: first.run_id, now: NOW, reason: 'interrupted' });
    strictEqual(abandoned.abandoned, true);
    strictEqual(abandoned.status, 'abandoned');

    const manifest = JSON.parse(await readFile(bootstrapRunManifestFile(homeDir, first.run_id), 'utf8'));
    strictEqual(manifest.status, 'abandoned');
    deepStrictEqual(manifest.history.at(-1), { step_id: null, from: 'open', to: 'abandoned', reason: 'interrupted', at: NOW.toISOString() });

    const second = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(second.created, true, 'the machine is unblocked');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('abandon is idempotent on a terminal run — it never rewrites a real completion', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await seedRun(homeDir, runId, { status: 'complete' });

    const result = await abandonBootstrapRun({ homeDir, repoRoot: null, runId, now: NOW });
    strictEqual(result.abandoned, false);
    strictEqual(result.reason, 'already-terminal');
    strictEqual(result.status, 'complete');
    const manifest = JSON.parse(await readFile(bootstrapRunManifestFile(homeDir, runId), 'utf8'));
    strictEqual(manifest.status, 'complete', 'the completion record is intact');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('an unreadable manifest blocks a plan but is still closable by id', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    const dir = join(bootstrapFamilyRoot(homeDir), runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), '{ corrupt');

    const scan = await scanBootstrapRuns({ homeDir });
    strictEqual(selectBlockingRuns(scan.runs).length, 1, 'unreadable blocks — never read as not-open');
    const blocked = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(blocked.created, false);
    match(blocked.diagnostics[0], /unreadable manifest/);

    const abandoned = await abandonBootstrapRun({ homeDir, repoRoot: null, runId, now: NOW });
    strictEqual(abandoned.abandoned, true, 'closable by id — the id comes from the directory name');
    strictEqual(abandoned.recovered_unreadable, true);
    // The recovery tombstone must ITSELF validate against the packaged run schema
    // (peer finding, S8a5): it previously omitted the required selection/boundary, so
    // recovering one unreadable manifest wrote the next record every schema-aware
    // reader rejects.
    const tombstone = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
    const validate = await makeValidator('runtime-bootstrap-run');
    const verdict = validate(tombstone);
    strictEqual(verdict.ok, true, `the replacement record conforms to the run schema: ${verdict.errors.join('; ')}`);
    strictEqual(tombstone.schema, 'runtime-bootstrap-run-1.2');
    const next = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(next.created, true);
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: `{}` is valid JSON, so manifest_status is 'ok' and an
  // is-it-open test answers "not open" — and a second plan was created against a run
  // nobody can prove finished. The predicate must be "not PROVEN terminal".
  it('a run whose manifest carries no recognized status blocks — it is not proven terminal', async () => {
    const homeDir = await tempHome();
    for (const [label, body] of [['empty object', {}], ['unknown status', { status: 'half-done' }]]) {
      const runId = makeBootstrapRunId(NOW);
      const dir = join(bootstrapFamilyRoot(homeDir), runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'run.json'), `${JSON.stringify(body)}\n`);

      const scan = await scanBootstrapRuns({ homeDir });
      const blocking = selectBlockingRuns(scan.runs);
      ok(blocking.some((r) => r.run_id === runId), `${label} blocks a new plan`);

      const blocked = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
      strictEqual(blocked.created, false, `${label} is not read as closed`);
      match(blocked.diagnostics.join(' '), /no recognized status/, `${label} is named honestly`);

      await abandonBootstrapRun({ homeDir, repoRoot: null, runId, now: NOW });
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: the open-run scan only blocks NON-terminal runs, so a caller
  // supplying the run_id of an existing COMPLETE run sailed past it and the atomic
  // write replaced that run's manifest — destroying a retained run, which is the
  // auto-deletion §10.2 forbids outright.
  it('a caller-supplied run id can never overwrite a retained run', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    // `limits` is the schema-valid marker slot: the seeded manifest must stay
    // schema-valid, because a schema-INVALID one is (correctly) not proven
    // terminal any more and would trip the open-run refusal before the
    // id-collision guard this test exists to exercise.
    await seedRun(homeDir, runId, { status: 'complete', limits: ['precious'] });

    const collide = await createBootstrapRun({
      homeDir,
      repoRoot: null,
      now: NOW,
      manifest: { ...baseManifest(), run_id: runId },
    });
    strictEqual(collide.created, false, 'the collision is refused');
    strictEqual(collide.reason, 'run-id-exists');
    match(collide.diagnostics[0], /refusing to overwrite a retained run/);

    const survivor = JSON.parse(await readFile(bootstrapRunManifestFile(homeDir, runId), 'utf8'));
    strictEqual(survivor.status, 'complete', 'the retained run is intact');
    deepStrictEqual(survivor.limits, ['precious'], 'and its body was never rewritten');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('abandoning a run that does not exist reports rather than throws', async () => {
    const homeDir = await tempHome();
    const result = await abandonBootstrapRun({ homeDir, repoRoot: null, runId: makeBootstrapRunId(NOW), now: NOW });
    strictEqual(result.abandoned, false);
    strictEqual(result.reason, 'run-missing');
    await rm(homeDir, { recursive: true, force: true });
  });

  // The create that died between mkdir and the manifest rename. This run BLOCKS new
  // plans, so if abandon called it 'run-missing' (a directory with no manifest looks
  // exactly like no run at all through readJsonSafe alone) the machine would be
  // blocked by a run its own recovery command refused to touch — the permanent block
  // §10.2 exists to prevent.
  it('a run directory with NO manifest blocks a plan and is still closable', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await mkdir(join(bootstrapFamilyRoot(homeDir), runId), { recursive: true });

    const blocked = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(blocked.created, false, 'a manifest-less run directory blocks');
    strictEqual(blocked.reason, 'run-open');

    const abandoned = await abandonBootstrapRun({ homeDir, repoRoot: null, runId, now: NOW });
    strictEqual(abandoned.abandoned, true, 'and abandon can still close it');
    strictEqual(abandoned.recovered_unreadable, true);

    const next = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(next.created, true, 'the machine is unblocked');
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — profile store (#30)', () => {
  it('refuses an existing name without --overwrite, and replaces with it', async () => {
    const homeDir = await tempHome();
    const profile = { schema: 'agentic-machine-profile-1.0', name: 'work' };

    const first = await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile, now: NOW });
    strictEqual(first.written, true);
    strictEqual(first.replaced, false);

    const refused = await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: { ...profile, changed: true }, now: NOW });
    strictEqual(refused.written, false, '#30 — an existing profile is not implicitly replaced');
    strictEqual(refused.reason, 'exists');
    match(refused.diagnostics[0], /Re-run with --overwrite/);
    const untouched = JSON.parse(await readFile(profileFile(homeDir, 'work'), 'utf8'));
    ok(!('changed' in untouched), 'the refused write left the file alone');

    const replaced = await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: { ...profile, changed: true }, overwrite: true, now: NOW });
    strictEqual(replaced.written, true);
    strictEqual(replaced.replaced, true);
    const after = JSON.parse(await readFile(profileFile(homeDir, 'work'), 'utf8'));
    strictEqual(after.changed, true);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('profiles are 0600 and round-trip by name', async () => {
    const homeDir = await tempHome();
    const profile = { schema: 'agentic-machine-profile-1.0', model: 'opus' };
    await writeMachineProfile({ homeDir, repoRoot: null, name: 'laptop', profile, now: NOW });

    const fileStat = await stat(profileFile(homeDir, 'laptop'));
    strictEqual(fileStat.mode & 0o777, 0o600);
    const read = await readMachineProfile({ homeDir, name: 'laptop' });
    strictEqual(read.status, 'available');
    deepStrictEqual(read.profile, profile);
    match(read.pointer, /^~\/\.agentic-plugins\/profiles\/laptop\.json$/);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('an injected validator can refuse a write, and nothing lands', async () => {
    const homeDir = await tempHome();
    const result = await writeMachineProfile({
      homeDir,
      repoRoot: null,
      name: 'bad',
      profile: { secret: 'sk-live-nope' },
      validate: () => ({ ok: false, errors: ['profile carries a token-shaped value'] }),
      now: NOW,
    });
    strictEqual(result.written, false);
    strictEqual(result.reason, 'invalid-profile');
    deepStrictEqual(result.diagnostics, ['profile carries a token-shaped value']);
    const read = await readMachineProfile({ homeDir, name: 'bad' });
    strictEqual(read.status, 'missing', 'the refused profile was never written');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('lists profiles by name only, ignoring foreign files', async () => {
    const homeDir = await tempHome();
    for (const name of ['work', 'home']) {
      await writeMachineProfile({ homeDir, repoRoot: null, name, profile: { schema: 'agentic-machine-profile-1.0' }, now: NOW });
    }
    await writeFile(join(homeDir, '.agentic-plugins', 'profiles', 'notes.txt'), 'ignored');

    const listed = await listMachineProfiles({ homeDir });
    deepStrictEqual(listed.profiles.map((p) => p.name), ['home', 'work']);
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — fragment + proof writers', () => {
  it('a fragment write returns metadata (pointer/hash/bytes), and the body stays on disk', async () => {
    const homeDir = await tempHome();
    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    const result = await writeBootstrapFragment({ homeDir, repoRoot: null, runId: created.run_id, name: 'codex-notify', content: 'notify = ["x"]\n' });

    strictEqual(result.ok, true);
    match(result.fragment.pointer, /^~\/\.agentic-plugins\/runs\/bootstrap\/bootstrap-.*\/fragments\/codex-notify\.fragment$/);
    strictEqual(result.fragment.bytes, 15);
    match(result.fragment.sha256, /^[0-9a-f]{64}$/);
    ok(!('content' in result.fragment), 'the metadata carries no body');
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: these writers' `mkdir -p` created <family>/<run-id>/fragments/ for
  // ANY well-formed id, and a manifest-less run directory blocks every subsequent
  // plan. One caller typo would wedge the machine behind a run that never existed.
  it('writing into a run that does not exist is refused — it never fabricates a blocker', async () => {
    const homeDir = await tempHome();
    const ghost = makeBootstrapRunId(NOW);

    const fragment = await writeBootstrapFragment({ homeDir, repoRoot: null, runId: ghost, name: 'x', content: '{}' });
    strictEqual(fragment.ok, false);
    strictEqual(fragment.reason, 'run-missing');
    const proof = await writeBootstrapProof({ homeDir, repoRoot: null, runId: ghost, kind: 'permission', record: {} });
    strictEqual(proof.ok, false);
    strictEqual(proof.reason, 'run-missing');

    // The decisive part: no directory was conjured, so a real plan still runs.
    const scan = await scanBootstrapRuns({ homeDir });
    strictEqual(scan.runs.length, 0, 'no run directory was fabricated');
    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(created.created, true, 'the machine is not blocked by a ghost run');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('an unserializable manifest is refused before anything is reserved', async () => {
    const homeDir = await tempHome();
    const circular = { schema: 'runtime-bootstrap-run-1.0', steps: [] };
    circular.self = circular;

    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: circular });
    strictEqual(created.created, false, 'reported, not thrown');
    strictEqual(created.reason, 'unserializable');
    const scan = await scanBootstrapRuns({ homeDir });
    strictEqual(scan.runs.length, 0, 'and no reserved directory is stranded behind it');
    const next = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    strictEqual(next.created, true, 'the machine is not blocked');
    await rm(homeDir, { recursive: true, force: true });
  });

  // ADR-0048 §3 — validation is MANDATORY and internal now: there is no
  // injectable `validate` to forget, so an incomplete record is refused by the
  // writer itself, and only a kind the evidence contract knows can become a
  // proof file at all.
  it('a proof write validates internally — a full record lands, an invalid or unknown-kind one is refused', async () => {
    const homeDir = await tempHome();
    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
    const record = {
      kind: 'deep-peer-smoke',
      status: 'passed',
      directions: {
        'claude->codex': { status: 'passed', ran_at: NOW.toISOString() },
        'codex->claude': { status: 'passed', ran_at: NOW.toISOString() },
      },
      artifact_pointer: null,
      artifact_hash: null,
      bound_versions: { runtime: '0.85.0', claude: null, codex: null, plugins: { claude: {}, codex: {} } },
      ran_at: NOW.toISOString(),
    };

    const good = await writeBootstrapProof({ homeDir, repoRoot: null, runId: created.run_id, kind: 'deep-peer-smoke', record });
    strictEqual(good.ok, true, `a schema-valid record persists: ${good.diagnostics.join('; ')}`);
    match(good.proof.pointer, /\/proof\/deep-peer-smoke\.json$/);

    // The old escape hatch — an empty record — is refused with no validator injected.
    const bad = await writeBootstrapProof({ homeDir, repoRoot: null, runId: created.run_id, kind: 'permission', record: {} });
    strictEqual(bad.ok, false);
    strictEqual(bad.reason, 'invalid-proof');

    // A kind outside the evidence contract never becomes a file, however valid its body.
    const alien = await writeBootstrapProof({ homeDir, repoRoot: null, runId: created.run_id, kind: 'novel-proof', record });
    strictEqual(alien.ok, false);
    strictEqual(alien.reason, 'unknown-evidence-kind');

    // The kind discriminator is enforced at the writer too: a directional record
    // filed under a different directional kind contradicts its embedded kind.
    const mismatch = await writeBootstrapProof({ homeDir, repoRoot: null, runId: created.run_id, kind: 'workflow-continuation', record });
    strictEqual(mismatch.ok, false);
    strictEqual(mismatch.reason, 'invalid-proof');
    await rm(homeDir, { recursive: true, force: true });
  });

  // ADR-0048 §3 / D0.1 — evidence lands only in an OPEN run; the single
  // exception is the owner receipt attestation into a reducer-terminal run.
  it('the proof writer refuses a terminal run, except the receipt attestation into a completed one', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(NOW);
    await seedRun(homeDir, runId, { status: 'complete' });

    const record = {
      kind: 'deep-peer-smoke',
      status: 'passed',
      directions: {
        'claude->codex': { status: 'passed', ran_at: NOW.toISOString() },
        'codex->claude': { status: 'passed', ran_at: NOW.toISOString() },
      },
      artifact_pointer: null,
      artifact_hash: null,
      bound_versions: { runtime: '0.85.0', claude: null, codex: null, plugins: { claude: {}, codex: {} } },
      ran_at: NOW.toISOString(),
    };
    const refused = await writeBootstrapProof({ homeDir, repoRoot: null, runId, kind: 'deep-peer-smoke', record });
    strictEqual(refused.ok, false);
    strictEqual(refused.reason, 'run-not-open');

    const receipt = {
      surface: 'owner-phone',
      attested_at: NOW.toISOString(),
      attempt_hash: 'a'.repeat(64),
      provider_proof_artifact_hash: 'c'.repeat(64),
    };
    const attested = await writeBootstrapProof({ homeDir, repoRoot: null, runId, kind: 'egress-receipt-attestation', record: receipt });
    strictEqual(attested.ok, true, `the D0.1 receipt append is the one allowed post-terminal write: ${attested.diagnostics.join('; ')}`);

    // Never into an abandoned run — an abandoned run is an escape hatch, not a
    // completed bootstrap anyone can testify about.
    const abandonedId = makeBootstrapRunId(new Date(NOW.getTime() + 1000));
    await seedRun(homeDir, abandonedId, { status: 'abandoned' });
    const refusedReceipt = await writeBootstrapProof({ homeDir, repoRoot: null, runId: abandonedId, kind: 'egress-receipt-attestation', record: receipt });
    strictEqual(refusedReceipt.ok, false);
    strictEqual(refusedReceipt.reason, 'run-not-open');
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — machine-global inventory + retention (#32)', () => {
  it('inventories the bootstrap family at the MACHINE home, not the repo home', async () => {
    const homeDir = await tempHome();
    const repoRoot = await tempRepo();
    // A same-named family in the repo, with different contents: an inventory that
    // resolved the machine family against repoRoot would report THIS.
    await mkdir(join(repoRoot, '.agentic-plugins', 'runs', 'bootstrap', 'decoy'), { recursive: true });
    await writeFile(join(repoRoot, '.agentic-plugins', 'runs', 'bootstrap', 'decoy', 'run.json'), '{}');
    await seedRun(homeDir, makeBootstrapRunId(NOW));

    const inventory = await inspectRuntimeArtifactInventory({ repoRoot, now: NOW, retentionCap: 20, maxBytes: 50 * 1024 * 1024, homeDir });

    ok(inventory.machine, 'the machine scope is present when a homeDir is injected');
    strictEqual(inventory.machine.scope, 'machine');
    strictEqual(inventory.machine.root, '~/.agentic-plugins', 'the scope root is home-relative, never absolute');
    strictEqual(inventory.machine.families.bootstrap.run_count, 1, 'one run at the machine home');
    strictEqual(inventory.machine.families.bootstrap.pointer, '~/.agentic-plugins/runs/bootstrap');
    strictEqual(inventory.machine.families.bootstrap.root, '~/.agentic-plugins/runs/bootstrap', 'family roots are home-relative too');
    // The repo scope still sees its own decoy family — the two are not merged.
    strictEqual(inventory.families.bootstrap.run_count, 1);
    match(inventory.families.bootstrap.pointer, /^\.agentic-plugins\/runs\/bootstrap$/);
    await rm(homeDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('omitting homeDir leaves the repo-scope shape byte-identical (no machine key)', async () => {
    const repoRoot = await tempRepo();
    await mkdir(join(repoRoot, '.agentic-plugins', 'runs', 'doctor'), { recursive: true });
    const without = await inspectRuntimeArtifactInventory({ repoRoot, now: NOW, retentionCap: 20, maxBytes: 1024 });
    ok(!('machine' in without), 'no machine key without an injected home');
    strictEqual(without.status, 'empty');
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('reports retention pressure past 10 runs WITHOUT deleting anything', async () => {
    const homeDir = await tempHome();
    strictEqual(BOOTSTRAP_RETENTION_CAP, 10, 'the contract §13 cap is 10');
    for (let i = 0; i < 12; i += 1) {
      const stamp = new Date(NOW.getTime() + i * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      await seedRun(homeDir, `bootstrap-${stamp}-${String(i).padStart(6, '0')}`);
    }

    const retention = await reportBootstrapRetention({ homeDir });
    strictEqual(retention.status, 'needs_attention');
    strictEqual(retention.run_count, 12);
    strictEqual(retention.over_cap, 2);
    strictEqual(retention.pressure.length, 2);
    match(retention.diagnostics[0], /runtime never deletes them/);

    const stillThere = await scanBootstrapRuns({ homeDir });
    strictEqual(stillThere.runs.length, 12, 'nothing was deleted');

    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 50 * 1024 * 1024, homeDir });
    const attention = inventory.machine.attention.find((a) => a.family === 'bootstrap');
    ok(attention, 'the inventory reports the same pressure');
    strictEqual(attention.kind, 'run_count_exceeds_cap');
    strictEqual(attention.limit, 10, 'against the MACHINE cap of 10, not the repo cap of 20');
    strictEqual(attention.observed, 12);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('profiles are retention-exempt — no pressure at any count', async () => {
    const homeDir = await tempHome();
    for (let i = 0; i < 30; i += 1) {
      await writeMachineProfile({ homeDir, repoRoot: null, name: `machine${i}`, profile: { schema: 'agentic-machine-profile-1.0' }, now: NOW });
    }
    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 50 * 1024 * 1024, homeDir });

    strictEqual(inventory.machine.families.profiles.file_count, 30);
    deepStrictEqual(inventory.machine.families.profiles.attention, [], '30 profiles is not a diagnosis runtime gets to make');
    deepStrictEqual(inventory.machine.policy.retention_exempt, ['profiles']);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('the machine scope does not invent families from unknown children', async () => {
    const homeDir = await tempHome();
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true });
    await mkdir(join(homeDir, '.agentic-plugins', 'something-else'), { recursive: true });
    await writeFile(join(homeDir, '.agentic-plugins', 'config.toml'), 'model = "opus"\n');

    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 1024, homeDir });
    deepStrictEqual(Object.keys(inventory.machine.families).sort(), ['bootstrap', 'profiles'], 'membership is closed by contract §10');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('the lock lives outside runs/, so it never makes an empty family read as available', async () => {
    const homeDir = await tempHome();
    const lock = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, now: NOW });
    strictEqual(lock.ok, true);

    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 1024, homeDir });
    strictEqual(inventory.machine.families.bootstrap.status, 'missing', 'a held lock is not an artifact');
    strictEqual(inventory.machine.families.bootstrap.file_count, 0);
    await lock.handle.release();
    await rm(homeDir, { recursive: true, force: true });
  });

  // Peer finding: profiles were exempted from RUN-COUNT pressure but not from BYTE
  // pressure, so one large profile still earned "remove obsolete generated
  // artifacts" — advice to delete the operator input the exemption protects. The
  // original test passed only because it used the 50MB default.
  it('profiles are exempt from BYTE pressure too, not only run-count pressure', async () => {
    const homeDir = await tempHome();
    await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: { schema: 'agentic-machine-profile-1.0' }, now: NOW });

    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 1, homeDir });
    deepStrictEqual(inventory.machine.families.profiles.attention, [], 'a profile over the byte cap is still not pressure');
    strictEqual(inventory.machine.families.profiles.status, 'available');
    // The bootstrap family, by contrast, is NOT exempt — the same byte cap bites.
    await seedRun(homeDir, makeBootstrapRunId(NOW));
    const withRun = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 1, homeDir });
    ok(withRun.machine.families.bootstrap.attention.some((a) => a.kind === 'bytes_exceed_cap'), 'bootstrap runs are not exempt');
    await rm(homeDir, { recursive: true, force: true });
  });

  // The MIRROR of the inventory leak: `machine.root` was fixed, and the same raw
  // absolute root survived on the exported readers next door. Assert over EVERY
  // public reader at once, so the next one added has to answer this too.
  it('no exported reader returns an absolute home path in any field', async () => {
    const homeDir = await tempHome();
    await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: { schema: 'agentic-machine-profile-1.0' }, now: NOW });
    const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });

    const readers = {
      scanBootstrapRuns: await scanBootstrapRuns({ homeDir }),
      listMachineProfiles: await listMachineProfiles({ homeDir }),
      readBootstrapLatest: await readBootstrapLatest({ homeDir }),
      reportBootstrapRetention: await reportBootstrapRetention({ homeDir }),
      readMachineProfile: await readMachineProfile({ homeDir, name: 'work' }),
      createBootstrapRun: created,
      abandonBootstrapRun: await abandonBootstrapRun({ homeDir, repoRoot: null, runId: created.run_id, now: NOW }),
    };
    for (const [name, value] of Object.entries(readers)) {
      ok(!JSON.stringify(value).includes(homeDir), `${name} leaks no absolute home path`);
    }
    // And the projection is applied ONCE — a double-applied pointer degrades to the
    // refusal token, which would be a silent loss of the path the operator needs.
    strictEqual(readers.scanBootstrapRuns.root, '~/.agentic-plugins/runs/bootstrap');
    strictEqual(readers.listMachineProfiles.root, '~/.agentic-plugins/profiles');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('no absolute home path reaches ANY field of the machine inventory (doctor persists this)', async () => {
    const homeDir = await tempHome();
    await seedRun(homeDir, makeBootstrapRunId(NOW));
    await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: { schema: 'agentic-machine-profile-1.0' }, now: NOW });
    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 50 * 1024 * 1024, homeDir });

    // Serialize the WHOLE scope: sanitizing the field a reader looks at while the
    // artifact stores the raw one is the failure mode, so assert over every field.
    ok(!JSON.stringify(inventory.machine).includes(homeDir), 'the operator home appears nowhere in the machine scope');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('a write failure is REPORTED, never thrown at the caller', async () => {
    const homeDir = await tempHome();
    // A read-only family root: the operator-environment failure class (full disk,
    // revoked permission, read-only home) this module promises to report as data.
    const family = bootstrapFamilyRoot(homeDir);
    await mkdir(family, { recursive: true, mode: 0o700 });
    await chmod(family, 0o500);
    try {
      const created = await createBootstrapRun({ homeDir, repoRoot: null, now: NOW, manifest: baseManifest() });
      strictEqual(created.created, false, 'reported, not thrown');
      strictEqual(created.reason, 'write-failed');
      match(created.diagnostics[0], /Could not (write|create)/);
    } finally {
      await chmod(family, 0o700);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  // The module claims it never throws for an operator-environment condition. That
  // claim was false in several places (a clockless repair hit `new Date(undefined)`
  // → RangeError; an unreadable component propagated EACCES). A promise a module
  // makes about itself is worth exactly what its tests hold.
  it('omitting the clock entirely does not throw', async () => {
    const homeDir = await tempHome();
    const runId = makeBootstrapRunId(new Date());
    const dir = join(bootstrapFamilyRoot(homeDir), runId);
    await mkdir(dir, { recursive: true });
    // A run with NO updated_at — the field the repair path used to date the pointer.
    await writeFile(join(dir, 'run.json'), `${JSON.stringify({ run_id: runId, status: 'complete' })}\n`);
    await writeFile(bootstrapLatestFile(homeDir), '{ truncated', { mode: 0o600 });

    const repair = await repairBootstrapLatest({ homeDir, repoRoot: null });
    strictEqual(repair.repaired, true, 'no clock injected, no crash');
    const persisted = JSON.parse(await readFile(bootstrapLatestFile(homeDir), 'utf8'));
    strictEqual(persisted.run_id, runId);
    ok(Number.isFinite(Date.parse(persisted.updated_at)), 'and it dated the pointer with a real timestamp');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('an unreadable path component refuses instead of propagating EACCES', async () => {
    const homeDir = await tempHome();
    const runsDir = join(homeDir, '.agentic-plugins', 'runs');
    await mkdir(runsDir, { recursive: true, mode: 0o700 });
    await chmod(runsDir, 0o000);
    try {
      const result = await writeBootstrapFragment({ homeDir, repoRoot: null, runId: makeBootstrapRunId(NOW), name: 'x', content: '{}' });
      strictEqual(result.ok, false, 'reported, not thrown');
      ok(['stat-failed', 'write-failed', 'canonicalization-failed'].includes(result.reason), `fail-closed reason, got ${result.reason}`);
    } finally {
      await chmod(runsDir, 0o700);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('machine pointers in the inventory carry no absolute home path', async () => {
    const homeDir = await tempHome();
    await seedRun(homeDir, makeBootstrapRunId(NOW));
    const inventory = await inspectRuntimeArtifactInventory({ repoRoot: await tempRepo(), now: NOW, retentionCap: 20, maxBytes: 50 * 1024 * 1024, homeDir });

    for (const family of Object.values(inventory.machine.families)) {
      match(family.pointer, /^~\/\.agentic-plugins\//);
      ok(!family.pointer.includes(homeDir));
    }
    strictEqual(machinePointer(homeDir, join(homeDir, '.agentic-plugins', 'runs')), '~/.agentic-plugins/runs');
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime bootstrap artifacts — file identity survives inode reuse', () => {
  // CI (Linux) found this and macOS could not: unlink frees an inode number and the very
  // next create can REUSE it, so a lock released and immediately recreated lands on the
  // inode a slow breaker judged — a dev/ino-only recheck then waves a LIVE holder's lock
  // through as "the same file I judged", deletes it, and leaves two holders. APFS does
  // not recycle as eagerly, which is precisely why the platform difference WAS the bug
  // report.
  //
  // Reproducing it by unlink+create would only fail on filesystems that happen to
  // recycle — a test that passes locally for a reason the platform chose. So the
  // condition is FORCED instead: a second hard link lets the swap rewrite the very same
  // inode, giving "same dev/ino, different lock" deterministically everywhere.
  it('a lock rewritten on the SAME dev/ino is not mistaken for the one that was judged', async () => {
    const homeDir = await tempHome();
    const lockPath = bootstrapLockFile(homeDir);
    const alias = `${lockPath}.alias`;
    await mkdir(join(homeDir, '.agentic-plugins', '.locks'), { recursive: true, mode: 0o700 });
    const ancient = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await writeFile(lockPath, `${JSON.stringify({ pid: 4242, acquired_at: ancient.toISOString() })}\n`, { mode: 0o600 });
    await link(lockPath, alias);
    await utimes(lockPath, ancient, ancient);
    const judged = await stat(lockPath);

    let swapped = false;
    const isPidAlive = () => {
      if (!swapped) {
        swapped = true;
        // Written THROUGH the alias: lockPath keeps its dev/ino, and gets a live
        // holder's bytes and a fresh mtime.
        writeFileSync(alias, `${JSON.stringify({ owner_token: 'fresh-holder', pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
      }
      return false; // the judged pid is "gone", so the break proceeds
    };

    const live = await stat(lockPath).catch(() => null);
    const result = await acquireBootstrapFamilyLock({ homeDir, repoRoot: null, attempts: 1, isPidAlive });

    strictEqual(result.ok, false, 'the breaker must not take a lock it never judged');
    ok(result.diagnostics.some((d) => /re-acquired while a stale break was in flight/.test(d)), 'it CONCEDED — the identity check noticed, rather than reclaiming');
    ok(!result.diagnostics.some((d) => /Reclaimed a stale/.test(d)), 'and did not report a reclaim it must not have performed');
    const survivor = JSON.parse(await readFile(lockPath, 'utf8'));
    strictEqual(survivor.owner_token, 'fresh-holder', "the live holder's lock survived");
    // The premise the test rests on: the inode really is unchanged, so dev/ino alone
    // could not have told these two locks apart.
    strictEqual((await stat(lockPath)).ino, judged.ino, 'same inode throughout — identity had to come from elsewhere');
    ok(live);
    await rm(homeDir, { recursive: true, force: true });
  });
});
