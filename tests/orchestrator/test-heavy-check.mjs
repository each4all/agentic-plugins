// tests/orchestrator/test-heavy-check.mjs
//
// ADR-0023, amendments of 2026-11-22 and 2026-11-24, the harness bullet (C154)
// — an autopilot verification check's record and what it lets go
// (plugins/orchestrator/scripts/lib/heavy-check.mjs), with verify-run's
// retainer and scratch's check-directory judgment over it. Small: files in a
// temporary directory, and the ownership's groups judged through a seam (no
// process, no user manager).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const C = await import(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/heavy-check.mjs'));
const VR = await import(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs'));
const S = await import(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/scratch.mjs'));
const { ownershipGroups } = await import(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/heavy-lock.mjs'));

const TOKEN = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const RUN = 'autopilot-20261125T010000Z-a1b2c3';
const never = () => { throw new Error('the ownership\'s groups were read'); };
const none = () => [];

// A lock directory with a groups directory, a check's directory, and a
// record naming the ownership of `token`.
function layout(t, { entries = [], ownership = true } = {}) {
  const dir = tmpDir(t, 'heavy-check-');
  const common = join(dir, 'common');
  mkdirSync(common);
  const lockPath = join(common, 'mutation-harness.lock');
  const check = join(dir, 'root', 'v4-0');
  mkdirSync(join(check, 'mutation-run-x', 'M1'), { recursive: true });
  for (const { token = TOKEN, name, entry } of entries) {
    mkdirSync(join(`${lockPath}.groups`, token), { recursive: true });
    writeFileSync(join(`${lockPath}.groups`, token, name), typeof entry === 'string' ? entry : JSON.stringify(entry));
  }
  const recordFile = join(dir, 'checks', '4-0.json');
  mkdirSync(dirname(recordFile));
  C.writeCheckRecord(recordFile, { check: { batch_id: 'b', index: 0, kind: 'mutate' }, runsHarness: true });
  if (ownership) C.recordOwnership(recordFile, { lockPath, token: TOKEN });
  return { dir, lockPath, check, recordFile };
}
const copyOf = (p) => {
  const st = statSync(p, { bigint: true });
  return { path: p, dev: String(st.dev), ino: String(st.ino) };
};

describe('heavy-check: the record', () => {
  it('is written before the scratch with no ownership; the harness adds its ownership with the lock directory\'s device and inode', (t) => {
    const { lockPath, recordFile } = layout(t, { ownership: false });
    deepStrictEqual(C.readCheckRecord(recordFile).record.ownership, null);
    C.recordOwnership(recordFile, { lockPath, token: TOKEN });
    const rec = C.readCheckRecord(recordFile).record;
    const st = statSync(dirname(lockPath), { bigint: true });
    deepStrictEqual(rec.ownership, { lock_path: lockPath, token: TOKEN, lock_dir: { dev: String(st.dev), ino: String(st.ino) } });
    deepStrictEqual([rec.runs_harness, rec.check.kind], [true, 'mutate']);
  });

  it('a record that is missing, malformed or names a partial ownership does not read; the harness refuses to write into one', (t) => {
    const { dir, lockPath, recordFile } = layout(t);
    match(C.readCheckRecord(join(dir, 'nope.json')).problem, /is missing$/);
    writeFileSync(recordFile, '{"schema":"x"}');
    match(C.readCheckRecord(recordFile).problem, /is not a check record/);
    throws(() => C.recordOwnership(recordFile, { lockPath, token: TOKEN }), /is not a check record/);
    writeFileSync(recordFile, JSON.stringify({ schema: C.CHECK_RECORD_SCHEMA, check: {}, runs_harness: true, ownership: { lock_path: lockPath, token: 'nope' } }));
    match(C.readCheckRecord(recordFile).problem, /ownership that does not read whole/);
    // Incomplete or contradictory: no check, no ownership field, an ownership on a check that runs no harness.
    writeFileSync(recordFile, JSON.stringify({ schema: C.CHECK_RECORD_SCHEMA, runs_harness: false, ownership: null }));
    match(C.readCheckRecord(recordFile).problem, /is not a check record/);
    writeFileSync(recordFile, JSON.stringify({ schema: C.CHECK_RECORD_SCHEMA, check: {}, runs_harness: false }));
    match(C.readCheckRecord(recordFile).problem, /is not a check record/);
    writeFileSync(recordFile, JSON.stringify({ schema: C.CHECK_RECORD_SCHEMA, check: {}, runs_harness: false, ownership: { lock_path: lockPath, token: TOKEN, lock_dir: { dev: '1', ino: '2' } } }));
    match(C.readCheckRecord(recordFile).problem, /check that runs no harness/);
  });
});

describe('heavy-check: what a record lets go (checkHolds)', () => {
  it('a record that names no harness, or the harness and no ownership, consults nothing', (t) => {
    const { dir, check } = layout(t);
    const plain = join(dir, 'checks', '4-1.json');
    C.writeCheckRecord(plain, { check: {}, runsHarness: false });
    strictEqual(C.checkHolds({ recordFile: plain, dirs: [check], groups: never }), null);
    const harnessOnly = join(dir, 'checks', '4-2.json');
    C.writeCheckRecord(harnessOnly, { check: {}, runsHarness: true });
    strictEqual(C.checkHolds({ recordFile: harnessOnly, dirs: [check], groups: never }), null);
  });

  it('a missing record keeps the directory where records are required, and only there; a malformed one keeps it always', (t) => {
    const { dir, check, recordFile } = layout(t);
    match(C.checkHolds({ recordFile: join(dir, 'gone.json'), dirs: [check] }), /is missing/);
    strictEqual(C.checkHolds({ recordFile: join(dir, 'gone.json'), dirs: [check], required: false }), null);
    writeFileSync(recordFile, 'not json');
    match(C.checkHolds({ recordFile, dirs: [check], required: false }), /does not read/);
  });

  it('an ownership that reads absent was retired: no groups directory, or no directory of its token', (t) => {
    const a = layout(t);
    strictEqual(C.checkHolds({ recordFile: a.recordFile, dirs: [a.check], groups: never }), null, 'no groups directory');
    const b = layout(t, { entries: [{ token: OTHER, name: '7-x.json', entry: { pgid: 7 } }] });
    strictEqual(C.checkHolds({ recordFile: b.recordFile, dirs: [b.check], groups: never }), null, 'only another token\'s ownership');
  });

  it('an ownership with entries is judged through its groups: a row (a group that runs, a scope not read gone) keeps the directory', (t) => {
    const { recordFile, check, lockPath } = layout(t, { entries: [{ name: '7-x.json', entry: { pgid: 7 } }] });
    const seen = [];
    const held = (p, token, { scopes }) => { seen.push([p, token, typeof scopes?.pass]); return [{ pgid: 7, name: '7-x.json', scope: { state: 'populated', unit: 'agentic-h.scope' } }]; };
    match(C.checkHolds({ recordFile, dirs: [check], groups: held, scopes: { pass: () => [] } }), /7 \(its scope agentic-h\.scope is populated; the owner may stop it with systemctl --user stop agentic-h\.scope\)/);
    deepStrictEqual(seen, [[lockPath, TOKEN, 'function']]);
    strictEqual(C.checkHolds({ recordFile, dirs: [check], groups: none }), null, 'control: no row lets it go');
  });

  it('a heavy-work entry naming a copy inside the directory keeps it, under its name or the .removing- name; a copy elsewhere does not', (t) => {
    const probe = layout(t);
    const copy = copyOf(join(probe.check, 'mutation-run-x', 'M1'));
    const { recordFile, check } = layout(t, { entries: [{ token: OTHER, name: '8-y.json', entry: { pgid: 8, copy } }] });
    // Its own layout's check is another directory: the copy is not inside it.
    strictEqual(C.checkHolds({ recordFile, dirs: [check], groups: none }), null);
    const own = layout(t);
    const mine = copyOf(join(own.check, 'mutation-run-x', 'M1'));
    mkdirSync(join(`${own.lockPath}.groups`, OTHER), { recursive: true });
    writeFileSync(join(`${own.lockPath}.groups`, OTHER, '9-z.json'), JSON.stringify({ pgid: 9, copy: mine }));
    match(C.checkHolds({ recordFile: own.recordFile, dirs: [own.check], groups: none }), /names a copy inside it/);
    const removing = join(dirname(own.check), '.removing-v4-0');
    renameSync(own.check, removing);
    deepStrictEqual(C.checkDirNames(removing), [own.check, removing]);
    match(C.checkHolds({ recordFile: own.recordFile, dirs: C.checkDirNames(removing), groups: none }), /names a copy inside it/);
  });

  it('a copy whose lookup fails other than by absence keeps the directory', (t) => {
    if (process.getuid?.() === 0) { t.skip('root reads through any mode'); return; }
    const own = layout(t);
    const mine = copyOf(join(own.check, 'mutation-run-x', 'M1'));
    mkdirSync(join(`${own.lockPath}.groups`, OTHER), { recursive: true });
    writeFileSync(join(`${own.lockPath}.groups`, OTHER, '9-z.json'), JSON.stringify({ pgid: 9, copy: mine }));
    chmodSync(join(own.check, 'mutation-run-x'), 0o000);
    try {
        match(C.checkHolds({ recordFile: own.recordFile, dirs: [own.check], groups: none }), /cannot be read \(the copy .* cannot be read \(EACCES\)\)/);
    } finally {
      chmodSync(join(own.check, 'mutation-run-x'), 0o755);
    }
  });

  it('a lock directory that is not the recorded one (another inode) keeps the directory', (t) => {
    const { recordFile, check, lockPath } = layout(t);
    renameSync(dirname(lockPath), `${dirname(lockPath)}.old`);
    mkdirSync(dirname(lockPath));
    match(C.checkHolds({ recordFile, dirs: [check], groups: none }), /is not the one its record names/);
  });

  it('reads pinned to the lock directory\'s mount: a mount over the groups directory, an ownership directory or an entry, or one placed during the judgment, keeps the directory', (t) => {
    if (process.platform !== 'linux') { t.skip('the pinned reading is Linux\'s'); return; }
    const { recordFile, check, lockPath } = layout(t, { entries: [{ name: '7-x.json', entry: { pgid: 7 } }] });
    // The mount ids a fake reports: the real one, unless the descriptor's path
    // is `over` (a mount placed there).
    const mountOver = (over) => (fd) => {
      const real = C.fdMountId(fd);
      return readlinkSync(`/proc/self/fd/${fd}`) === over ? `${real}9` : real;
    };
    strictEqual(C.checkHolds({ recordFile, dirs: [check], groups: none, mountOf: mountOver(null) }), null, 'control: one mount lets it go');
    for (const over of [`${lockPath}.groups`, join(`${lockPath}.groups`, TOKEN), join(`${lockPath}.groups`, TOKEN, '7-x.json')]) {
      match(C.checkHolds({ recordFile, dirs: [check], groups: none, mountOf: mountOver(over) }), /a mount is placed over/, over);
    }
    match(C.checkHolds({ recordFile, dirs: [check], groups: none, mountOf: () => null }), /the mount of .* cannot be read/);
    // The groups are judged on the entries read pinned, and an entry read
    // again (its group ended, it had no scope) is read pinned too: a mount
    // placed over the ownership directory by then holds it.
    let placed = false;
    const mountOf = (fd) => (placed ? mountOver(join(`${lockPath}.groups`, TOKEN))(fd) : C.fdMountId(fd));
    let given = null;
    const judged = (p, token, o) => {
      given = o.entries.map((e) => [e.name, e.entry?.pgid]);
      placed = true;
      return ownershipGroups(p, token, o);
    };
    match(C.checkHolds({ recordFile, dirs: [check], groups: judged, mountOf }), /7 \(its scope is withheld: entry-reread/);
    deepStrictEqual(given, [['7-x.json', 7]], 'the pinned entries are judged');
    // An absent ownership read under a mount over the groups directory is no
    // retirement.
    const a = layout(t, { entries: [{ token: OTHER, name: '8-y.json', entry: { pgid: 8 } }] });
    match(C.checkHolds({ recordFile: a.recordFile, dirs: [a.check], groups: never, mountOf: mountOver(`${a.lockPath}.groups`) }), /a mount is placed over/);
  });

  it('a kernel older than 5.14 (fdinfo with mnt_id: and no ino:) reads the mount by its id alone; an ino: naming another inode, or no mnt_id:, reads none (C154 F1)', (t) => {
    if (process.platform !== 'linux') { t.skip('the pinned reading is Linux\'s'); return; }
    const { recordFile, check } = layout(t, { entries: [{ name: '7-x.json', entry: { pgid: 7 } }] });
    // Built from this kernel's fdinfo whichever format it writes: `old` with
    // no ino: line, `withIno` with one naming the inode given.
    const real = (n) => readFileSync(`/proc/self/fdinfo/${n}`, 'utf8');
    const old = (n) => real(n).replace(/^ino:.*\n/gm, '');
    const withIno = (inode) => (n) => `${old(n)}ino:\t${inode}\n`;
    const fd = openSync(dirname(recordFile), 'r');
    try {
      ok(!/^ino:/m.test(old(fd)), 'control: the fake has no ino: line');
      const id = C.fdMountId(fd);
      ok(id !== null && /^\d+$/.test(id), 'control: the real fdinfo reads');
      strictEqual(C.fdMountId(fd, { readInfo: old }), id, 'no ino: line: the mount id alone');
      const inode = statSync(dirname(recordFile), { bigint: true }).ino;
      strictEqual(C.fdMountId(fd, { readInfo: withIno(inode) }), id, 'control: an ino: naming the descriptor\'s inode reads');
      strictEqual(C.fdMountId(fd, { readInfo: withIno(inode + 1n) }), null, 'another inode');
      strictEqual(C.fdMountId(fd, { readInfo: (n) => old(n).replace(/^mnt_id:.*\n/m, '') }), null, 'no mnt_id:');
    } finally {
      closeSync(fd);
    }
    // The whole check on such a kernel lets a drained ownership go, as on a newer one.
    strictEqual(C.checkHolds({ recordFile, dirs: [check], groups: none, mountOf: (n) => C.fdMountId(n, { readInfo: old }) }), null);
  });

  it('a groups directory that is no directory, or a judgment that throws, keeps the directory', (t) => {
    const { recordFile, check, lockPath } = layout(t);
    writeFileSync(`${lockPath}.groups`, 'x');
    match(C.checkHolds({ recordFile, dirs: [check], groups: none }), /cannot be read .*is not a directory/);
    const b = layout(t, { entries: [{ name: '7-x.json', entry: { pgid: 7 } }] });
    match(C.checkHolds({ recordFile: b.recordFile, dirs: [b.check], groups: () => { throw new Error('boom'); } }), /cannot be read \(boom\)/);
  });
});

describe('verify-run: the harness retainer and the record\'s environment', () => {
  it('reads the record again until it lets go, with one collector; past its wait it answers why', async () => {
    let calls = 0;
    const scopesSeen = new Set();
    const holds = ({ scopes }) => { scopesSeen.add(scopes); calls += 1; return calls < 3 ? 'held' : null; };
    strictEqual(await VR.harnessRetainer({ recordFile: 'r', dirs: [], waitMs: 5000, pollMs: 10, holds, collector: () => ({}) })(), null);
    deepStrictEqual([calls, scopesSeen.size], [3, 1]);
    const stuck = VR.harnessRetainer({ recordFile: 'r', dirs: [], waitMs: 50, pollMs: 10, holds: () => 'still held', collector: () => ({}) });
    strictEqual(await stuck(), 'still held');
  });

  it('only a check that runs the harness gets its record in the environment; no check inherits the variable', () => {
    const base = { PATH: '/bin', [C.CHECK_RECORD_ENV]: '/elsewhere/record.json' };
    deepStrictEqual(VR.checkRunEnv(base, { tmpDir: '/t/v1-0', recordFile: '/run/checks/1-0.json', runsHarness: true }),
      { PATH: '/bin', TMPDIR: '/t/v1-0', [C.CHECK_RECORD_ENV]: '/run/checks/1-0.json' });
    deepStrictEqual(VR.checkRunEnv(base, { tmpDir: '/t/v1-1', recordFile: '/run/checks/1-1.json', runsHarness: false }),
      { PATH: '/bin', TMPDIR: '/t/v1-1' }, 'a test check runs without it, whatever the base holds');
    deepStrictEqual(VR.checkRunEnv(base, {}), { PATH: '/bin' });
    strictEqual(base[C.CHECK_RECORD_ENV], '/elsewhere/record.json', 'the base is not changed');
    ok(VR.CHECK_SCRUB.includes(C.CHECK_RECORD_ENV));
    strictEqual(VR.checkEnvOf(base)[C.CHECK_RECORD_ENV], undefined, 'a worker\'s variable never reaches a check');
  });
});

describe('scratch: a check directory and its record (checkDirKept)', () => {
  const marker = (repo, records = true) => ({ repo, ...(records ? { check_records: true } : {}) });
  it('finds the record in the run\'s directory by the check\'s name, its .removing- name included', () => {
    const asked = [];
    const holds = (o) => { asked.push(o); return 'held'; };
    strictEqual(S.checkDirKept('/b/agentic-ap/x/v12-3', { runId: RUN, marker: marker('/repo') }, { holds }), 'held');
    strictEqual(S.checkDirKept('/b/agentic-ap/x/.removing-v12-3.77.1', { runId: RUN, marker: marker('/repo') }, { holds }), 'held');
    deepStrictEqual(asked.map((o) => [o.recordFile, o.dirs, o.required]), [
      [`/repo/.agentic-plugins/runs/autopilot/${RUN}/checks/12-3.json`, ['/b/agentic-ap/x/v12-3'], true],
      [`/repo/.agentic-plugins/runs/autopilot/${RUN}/checks/12-3.json`, ['/b/agentic-ap/x/v12-3', '/b/agentic-ap/x/.removing-v12-3.77.1'], true],
    ]);
    strictEqual(S.checkDirKept('/b/agentic-ap/x/s2', { runId: RUN, marker: marker('/repo') }, { holds }), null, 'a step\'s is no check\'s');
  });

  it('an earlier release\'s root (no check_records) with no record sweeps as before; a marked root with no repository keeps it', () => {
    strictEqual(S.checkDirKept('/b/agentic-ap/x/v1-0', { runId: RUN, marker: marker('/nowhere-repo', false) }, { holds: never }), null);
    match(S.checkDirKept('/b/agentic-ap/x/v1-0', { runId: RUN, marker: { check_records: true } }, { holds: never }), /names no repository/);
  });
});
