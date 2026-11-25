// C181 (ADR-0023 §6, amendment of 2026-11-24) — the reader of a run's own
// scope, through the system seam: the /proc anchor and the pinned lookups
// (a mount over a path component, or over /proc, is refused, and a lookup
// that finds nothing is gone only while the anchors hold), the readings
// (gone, emptied, unproven, withheld), the checks a kill needs and the
// kill, and the supervisor proven gone. A fake Linux stands in for the system,
// so each refusal is shown in one process; one live row reads this machine.

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './_personas.mjs';

const LIB = join(REPO_ROOT, 'persona-pipeline/files/scripts/lib');
const R = await import(pathToFileURL(join(LIB, 'scope-reader.mjs')).href);

const BOOT = 'e55a09fa-13b3-445f-9aa0-4b51e123717f';
const OTHER_BOOT = '11111111-2222-3333-4444-555555555555';
const TIME_NS = 'time:[4026531834]';
const PID_NS = 'pid:[4026531836]';
const CLOCK = `${BOOT}/${TIME_NS}/${PID_NS}`;
const UID = 1000;
const MANAGER = `/user.slice/user-${UID}.slice/user@${UID}.service`;
const UNIT = 'agentic-launch-run-1-k3j9.scope';
const SCOPE = `${MANAGER}/app.slice/${UNIT}`;
const ME = 777;
const MANAGER_PID = 900;
const GATE = { pid: 4242, starttime: '5000' };
const PROC = { dev: 24n, mnt: '26' };
const CG = { dev: 30n, mnt: '35' };

const MOUNTINFO = [
  '26 31 0:24 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw',
  '35 25 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:10 - cgroup2 cgroup2 rw,nsdelegate',
].join('\n');

function stat(pid, start) {
  return `${pid} (x) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`;
}

// A fake Linux: paths to nodes, descriptors to paths, and what the reader
// asks of systemctl, getconf and a signal-0 probe.
function fakeLinux(edit = () => {}) {
  let ino = 1000n;
  const nodes = new Map();
  const put = (path, node) => nodes.set(path, { ino: ino++, mode: 0o444, ...node });
  const procDir = (p) => put(p, { dir: true, ...PROC, fstype: 0x9fa0 });
  const procFile = (p, text) => put(p, { text, ...PROC });
  const cgDir = (p, extra = {}) => put(`/sys/fs/cgroup${p}`, { dir: true, ...CG, fstype: 0x63677270, mode: 0o555, ...extra });
  const cgFile = (p, text, extra = {}) => put(`/sys/fs/cgroup${p}`, { text, ...CG, ...extra });

  procDir('/proc');
  procDir('/proc/self');
  procFile('/proc/self/mountinfo', MOUNTINFO);
  put('/proc/self/ns/pid', { link: PID_NS, ...PROC });
  put('/proc/self/ns/time', { link: TIME_NS, ...PROC });
  put('/proc/self/ns/cgroup', { link: 'cgroup:[4026531835]', ...PROC });
  for (const d of ['/proc/sys', '/proc/sys/kernel', '/proc/sys/kernel/random']) procDir(d);
  procFile('/proc/sys/kernel/random/boot_id', `${BOOT}\n`);
  procFile('/proc/uptime', '100.00 50.00\n'); // 10000 ticks at 100 Hz
  procDir(`/proc/${MANAGER_PID}`);
  put(`/proc/${MANAGER_PID}/ns/pid`, { link: PID_NS, ...PROC });
  put(`/proc/${MANAGER_PID}/ns/cgroup`, { link: 'cgroup:[4026531835]', ...PROC });
  procFile(`/proc/${MANAGER_PID}/cgroup`, `0::${MANAGER}/init.scope\n`);
  procDir(`/proc/${GATE.pid}`);
  procFile(`/proc/${GATE.pid}/stat`, stat(GATE.pid, GATE.starttime));
  procDir('/proc/4300');
  procFile('/proc/4300/stat', stat(4300, '6000'));

  put('/sys/fs/cgroup', { dir: true, ...CG, fstype: 0x63677270 });
  let path = '';
  for (const part of SCOPE.split('/').slice(1)) {
    path += `/${part}`;
    cgDir(path);
  }
  cgFile(`${MANAGER}/cgroup.kill`, '', { mode: 0o200 });
  const scopeNode = nodes.get(`/sys/fs/cgroup${SCOPE}`);
  scopeNode.ino = 18446744073709551615n;
  cgFile(`${SCOPE}/cgroup.events`, 'populated 1\nfrozen 0\n');
  cgFile(`${SCOPE}/cgroup.procs`, `${GATE.pid}\n4300\n`);
  cgFile(`${SCOPE}/cgroup.threads`, `${GATE.pid}\n4300\n`);
  cgFile(`${SCOPE}/cgroup.type`, 'domain\n');
  const kills = [];
  cgFile(`${SCOPE}/cgroup.kill`, '', { mode: 0o200, onWrite: (t) => kills.push(t) });

  const units = { [UNIT]: { InvocationID: '0123456789abcdef0123456789abcdef', ControlGroup: SCOPE } };
  const alive = new Map([[ME, 'alive']]);
  const fds = new Map();
  let nextFd = 10;
  let clock = 0;

  const resolve = (p) => {
    let path = String(p);
    for (;;) {
      const m = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(path);
      if (!m) break;
      if (!fds.has(Number(m[1]))) throw Object.assign(new Error('EBADF'), { code: 'ENOENT' });
      path = fds.get(Number(m[1])) + (m[2] ?? '');
    }
    return path.replace(new RegExp(`^/proc/${ME}(?=/|$)`), '/proc/self');
  };
  const lookup = (p) => {
    const path = resolve(p);
    const fdinfo = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(path);
    if (fdinfo) {
      const target = fds.get(Number(fdinfo[1]));
      if (target === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const n = nodes.get(target);
      return { path, node: { ...PROC, ino: 1n, text: `pos:\t0\nflags:\t02300000\nmnt_id:\t${n.mnt}\nino:\t${n.ino}\n` } };
    }
    const node = nodes.get(path);
    if (!node) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    return { path, node };
  };

  const system = {
    platform: 'linux',
    pid: ME,
    uid: () => UID,
    release: () => '6.8.0-139-generic',
    machine: () => 'x86_64',
    open(p, flags) {
      const { path, node } = lookup(p);
      if (node.openError) throw Object.assign(new Error(node.openError), { code: node.openError });
      if ((flags & 0o200000) && !node.dir) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      const fd = nextFd++;
      fds.set(fd, path.startsWith('/proc/self/fdinfo/') ? `@fdinfo:${path}` : path);
      if (path.startsWith('/proc/self/fdinfo/')) nodes.set(`@fdinfo:${path}`, node);
      return fd;
    },
    close(fd) {
      fds.delete(fd);
    },
    fstat(fd) {
      const n = nodes.get(fds.get(fd));
      return { dev: n.dev, ino: n.ino, mode: n.mode, directory: Boolean(n.dir) };
    },
    read(fd) {
      return nodes.get(fds.get(fd)).text;
    },
    write(fd, text) {
      const n = nodes.get(fds.get(fd));
      if (n.writeError) throw Object.assign(new Error(n.writeError), { code: n.writeError });
      n.onWrite?.(text);
    },
    fchmod(fd, mode) {
      const n = nodes.get(fds.get(fd));
      if (n.chmodError) throw Object.assign(new Error(n.chmodError), { code: n.chmodError });
      n.mode = mode;
    },
    statfsType: (p) => lookup(p).node.fstype,
    readlink(p) {
      if (p === '/proc/self') return String(ME);
      return lookup(p).node.link;
    },
    readdir(p) {
      const dir = resolve(p);
      return [...nodes.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
        .map((k) => ({ name: k.slice(dir.length + 1), directory: Boolean(nodes.get(k).dir) }));
    },
    kill0: (pid) => alive.get(pid) ?? 'ESRCH',
    run(cmd, args) {
      if (cmd === 'getconf') return { status: 0, stdout: '100\n' };
      if (cmd !== 'systemctl') return { status: 1, stdout: '' };
      const props = args.filter((a, i) => args[i - 1] === '-p');
      let source;
      if (args[0] === '--user' && args[2] === '-p') source = { ControlGroup: MANAGER };
      else if (args[0] === 'show') source = { MainPID: String(MANAGER_PID) };
      else source = units[args[2]];
      if (!source) return { status: 1, stdout: '' };
      return { status: 0, stdout: props.map((p) => `${p}=${source[p] ?? ''}`).join('\n') + '\n' };
    },
    now: () => clock,
    advance: (ms) => (clock += ms),
  };
  const fake = { system, nodes, kills, units, alive, fds, cgPath: (p) => `/sys/fs/cgroup${p}` };
  edit(fake);
  return fake;
}

function identity(over = {}) {
  return {
    owner: { kind: 'peer-run', run_id: 'run-1' },
    unit: UNIT,
    invocation_id: '0123456789abcdef0123456789abcdef',
    cgroup_path: SCOPE,
    cgroup_id: '18446744073709551615',
    boot_id: BOOT,
    gate: { ...GATE, clock: CLOCK },
    supervisor: { pid: 4200, fingerprint: { kind: 'linux_proc_starttime', starttime: '4000' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: false,
    association: null,
    ...over,
  };
}

function reader(fake) {
  const r = R.attestReader({ system: fake.system, cgroupPath: SCOPE });
  strictEqual(r.ok, true, `attest: ${r.check}`);
  return r;
}

describe('the /proc anchor (T0)', () => {
  it('opens /proc once, checks it, and reads the boot pinned', () => {
    const fake = fakeLinux();
    const a = R.openProcAnchor(fake.system);
    strictEqual(a.ok, true);
    strictEqual(a.mntId, '26');
    strictEqual(R.readBootId(fake.system, a), BOOT);
    strictEqual(R.readClock(fake.system, a, BOOT), CLOCK);
  });

  it('refuses a /proc that is not a procfs, not the reader\'s, or covered at its own directory', () => {
    strictEqual(R.openProcAnchor(fakeLinux((f) => { f.nodes.get('/proc').fstype = 0x01021994; }).system).check, 'proc-type');
    strictEqual(R.openProcAnchor({ ...fakeLinux().system, pid: 1 }).check, 'proc-not-own');
    const covered = fakeLinux((f) => { f.nodes.get('/proc/self/mountinfo').text = `${MOUNTINFO}\n90 26 0:50 / /proc/${ME} rw - tmpfs tmpfs rw`; });
    strictEqual(R.openProcAnchor(covered.system).check, 'proc-self-covered');
    const otherId = fakeLinux((f) => { f.nodes.get('/proc').mnt = '27'; });
    strictEqual(R.openProcAnchor(otherId.system).check, 'proc-mount-id');
  });

  it('refuses a boot id behind a mount over a directory on its way', () => {
    const fake = fakeLinux((f) => { f.nodes.get('/proc/sys').mnt = '80'; });
    const a = R.openProcAnchor(fake.system);
    strictEqual(R.readBootId(fake.system, a), null);
    strictEqual(R.attestReader({ system: fake.system }).check, 'boot-id');
  });

  it('a lookup that finds nothing is no reading of gone once the anchor moved', () => {
    const fake = fakeLinux();
    const r = reader(fake);
    fake.nodes.delete(fake.cgPath(SCOPE));
    // The /proc anchor's descriptor reads another mount after the lookup.
    const real = fake.system.open;
    let opened = 0;
    fake.system.open = (p, flags) => {
      if (p.endsWith(`/self/fdinfo/${r.anchor.fd}`) && opened++ >= 0) fake.nodes.get('/proc').mnt = '99';
      return real(p, flags);
    };
    deepStrictEqual(R.observeScope(r, identity()), { state: 'withheld', check: 'anchor-moved' });
  });
});

describe('attesting a reader', () => {
  it('passes on a host that holds every check', () => {
    const r = reader(fakeLinux());
    strictEqual(r.managerCgroup, MANAGER);
    strictEqual(r.bootId, BOOT);
    R.closeReader(r);
  });

  it('withholds where a check fails', () => {
    const rows = [
      ['platform', (f) => { f.system.platform = 'darwin'; }],
      ['kernel', (f) => { f.system.release = () => '5.10.0'; }],
      ['user-manager', (f) => { const run = f.system.run; f.system.run = (c, a, t) => (a[0] === '--user' && a[2] === '-p' ? { status: 0, stdout: 'ControlGroup=/init.scope\n' } : run(c, a, t)); }],
      ['manager-namespace', (f) => { f.nodes.get(`/proc/${MANAGER_PID}/ns/pid`).link = 'pid:[1]'; }],
      ['manager-cgroup', (f) => { f.nodes.get(`/proc/${MANAGER_PID}/cgroup`).text = '0::/elsewhere\n'; }],
      ['hierarchy', (f) => { f.nodes.get('/proc/self/mountinfo').text = MOUNTINFO.replace(' / /sys/fs/cgroup', ' /sub /sys/fs/cgroup'); }],
      ['mount-on-path', (f) => { f.nodes.get('/proc/self/mountinfo').text = `${MOUNTINFO}\n91 35 0:51 / /sys/fs/cgroup/user.slice rw - tmpfs tmpfs rw`; }],
      ['no-cgroup-kill', (f) => { f.nodes.delete(f.cgPath(`${MANAGER}/cgroup.kill`)); }],
      ['check-timeout', (f) => { const run = f.system.run; f.system.run = (c, a, t) => { f.system.advance(5000); return run(c, a, t); }; }],
    ];
    for (const [check, edit] of rows) strictEqual(R.attestReader({ system: fakeLinux(edit).system, cgroupPath: SCOPE }).check, check, check);
  });
});

describe('reading a scope (T2)', () => {
  it('reads it unproven while populated, emptied at populated 0', () => {
    const fake = fakeLinux();
    const r = reader(fake);
    deepStrictEqual(R.observeScope(r, identity()), { state: 'unproven' });
    fake.nodes.get(fake.cgPath(`${SCOPE}/cgroup.events`)).text = 'populated 0\nfrozen 0\n';
    deepStrictEqual(R.observeScope(r, identity()), { state: 'emptied' });
  });

  it('reads it gone under another boot, at a path that holds nothing, or a cgroup of another id', () => {
    const fake = fakeLinux();
    const r = reader(fake);
    deepStrictEqual(R.observeScope(r, identity({ boot_id: OTHER_BOOT, gate: { ...GATE, clock: CLOCK.replace(BOOT, OTHER_BOOT) }, supervisor: { ...identity().supervisor, boot_id: OTHER_BOOT, clock: CLOCK.replace(BOOT, OTHER_BOOT) } })), { state: 'gone', check: 'other-boot' });
    deepStrictEqual(R.observeScope(r, identity({ cgroup_id: '17' })), { state: 'gone' });
    fake.nodes.delete(fake.cgPath(SCOPE));
    deepStrictEqual(R.observeScope(r, identity()), { state: 'gone' });
  });

  it('a cgroup that lost its cgroup.events while its path still holds it is not gone', () => {
    const fake = fakeLinux((f) => f.nodes.delete(f.cgPath(`${SCOPE}/cgroup.events`)));
    deepStrictEqual(R.observeScope(reader(fake), identity()), { state: 'unproven', check: 'events-missing' });
  });

  it('a mount over a component of the path, or over cgroup.events alone, is refused, never gone', () => {
    const over = fakeLinux((f) => { f.nodes.get(f.cgPath(`${MANAGER}/app.slice`)).mnt = '91'; });
    deepStrictEqual(R.observeScope(reader(over), identity()), { state: 'withheld', check: 'mount-crossed' });
    const file = fakeLinux((f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.events`)).mnt = '92'; });
    deepStrictEqual(R.observeScope(reader(file), identity()), { state: 'withheld', check: 'mount-crossed' });
    const perm = fakeLinux((f) => { f.nodes.get(f.cgPath(`${MANAGER}/app.slice`)).openError = 'EACCES'; });
    deepStrictEqual(R.observeScope(reader(perm), identity()), { state: 'withheld', check: 'lookup-EACCES' });
  });
});

describe('a kill (T2)', () => {
  const closed = (f) => {
    f.nodes.get(f.cgPath(SCOPE)).mode = 0o555;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).mode = 0o444;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.threads`)).mode = 0o444;
  };

  it('is written through the checked directory when every check holds', () => {
    const fake = fakeLinux(closed);
    const r = reader(fake);
    const auth = R.authorizeKill(r, identity());
    strictEqual(auth.ok, true, auth.check);
    deepStrictEqual(R.writeKill(r, auth), { state: 'written' });
    deepStrictEqual(fake.kills, ['1']);
  });

  it('is withheld where a check fails, and nothing is written', () => {
    const rows = [
      ['manager-identity', (f) => { f.units[UNIT].InvocationID = 'ffffffffffffffffffffffffffffffff'; }],
      ['manager-unit', (f) => { delete f.units[UNIT]; }],
      ['modes', (f) => { f.nodes.get(f.cgPath(SCOPE)).mode = 0o755; }],
      ['modes', (f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).mode = 0o644; }],
      ['not-leaf', (f) => { f.nodes.set(f.cgPath(`${SCOPE}/sub`), { dir: true, ...CG, ino: 5n, mode: 0o555 }); }],
      ['member-start', (f) => { f.nodes.get('/proc/4300/stat').text = stat(4300, GATE.starttime); }],
      ['member-start', (f) => { f.nodes.get('/proc/4300/stat').text = stat(4300, '20000'); }],
      ['member-start', (f) => { f.nodes.get('/proc/4300/stat').text = 'garbage'; }],
      ['clock', (f) => { f.nodes.get('/proc/self/ns/time').link = 'time:[1]'; }],
    ];
    for (const [check, edit] of rows) {
      const fake = fakeLinux((f) => { closed(f); edit(f); });
      const r = R.attestReader({ system: fake.system, cgroupPath: SCOPE });
      const auth = r.ok ? R.authorizeKill(r, identity()) : r;
      strictEqual(auth.ok, false, check);
      strictEqual(auth.check, check, check);
      deepStrictEqual(fake.kills, [], check);
    }
  });

  it('a member gone between the two reads names no member; the gate, by its start, is no other member', () => {
    const fake = fakeLinux((f) => { closed(f); f.nodes.delete('/proc/4300/stat'); });
    strictEqual(R.authorizeKill(reader(fake), identity()).ok, true);
    const reused = fakeLinux((f) => { closed(f); f.nodes.get(`/proc/${GATE.pid}/stat`).text = stat(GATE.pid, '3000'); });
    strictEqual(R.authorizeKill(reader(reused), identity()).check, 'member-start');
  });

  it('a member whose start cannot be read grants nothing: a miss the probe contradicts, a /proc that may hide, pid 0', () => {
    const rows = [
      // The stat misses but the pid answers a signal-0 probe: a member the reader cannot see.
      ['probe-alive', (f) => { f.nodes.delete('/proc/4300/stat'); f.alive.set(4300, 'alive'); }],
      ['probe-eperm', (f) => { f.nodes.delete('/proc/4300/stat'); f.alive.set(4300, 'EPERM'); }],
      // The stat misses under a /proc that may hide processes: ESRCH alone proves nothing there.
      ['hidepid', (f) => { f.nodes.delete('/proc/4300/stat'); f.nodes.get('/proc/self/mountinfo').text = MOUNTINFO.replace('proc proc rw', 'proc proc rw,hidepid=2'); }],
      // A member in a pid namespace the reader does not see is listed as 0.
      // Signal 0 to pid 0 probes the caller's own group (alive on Linux), so
      // the row also asserts 0 is refused before any lookup or probe.
      ['pid-0', (f) => { const p = f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)); p.text = `0\n${p.text}`; f.alive.set(0, 'alive'); }],
    ];
    for (const [name, edit] of rows) {
      const fake = fakeLinux((f) => { closed(f); edit(f); });
      const probed = [];
      const kill0 = fake.system.kill0;
      fake.system.kill0 = (pid) => { probed.push(pid); return kill0(pid); };
      const auth = R.authorizeKill(reader(fake), identity());
      strictEqual(auth.ok, false, name);
      strictEqual(auth.check, 'member-start', name);
      deepStrictEqual(fake.kills, [], name);
      strictEqual(probed.includes(0), false, `${name}: pid 0 probed`);
    }
  });

  it('a write the kernel refuses is recorded refused', () => {
    const fake = fakeLinux((f) => { closed(f); f.nodes.get(f.cgPath(`${SCOPE}/cgroup.kill`)).writeError = 'EPERM'; });
    const r = reader(fake);
    deepStrictEqual(R.writeKill(r, R.authorizeKill(r, identity())), { state: 'refused', check: 'EPERM' });
  });

  it('a scope already gone grants no kill and reads gone', () => {
    const fake = fakeLinux((f) => { closed(f); f.nodes.delete(f.cgPath(SCOPE)); });
    deepStrictEqual(R.authorizeKill(reader(fake), identity()), { ok: false, state: 'gone' });
  });
});

describe('one invocation\'s ender (C181, readers\' budget)', () => {
  const closed = (f) => {
    f.nodes.get(f.cgPath(SCOPE)).mode = 0o555;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).mode = 0o444;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.threads`)).mode = 0o444;
  };

  it('writes a scope\'s kill once and reads it once, however many paths meet it', () => {
    const fake = fakeLinux(closed);
    const e = R.createScopeEnder({ system: fake.system });
    deepStrictEqual(e.kill(identity()), { state: 'written' });
    deepStrictEqual(e.kill(identity()), { state: 'written' });
    deepStrictEqual(fake.kills, ['1'], 'one write');
    const first = e.read(identity());
    strictEqual(first.state, 'unproven');
    fake.nodes.delete(fake.cgPath(SCOPE));
    strictEqual(e.read(identity()), first, 'no second reading');
  });

  it('a withheld kill is the teardown while the scope is not read gone; a reading of gone stands over it', () => {
    const open = fakeLinux((f) => { f.nodes.get(f.cgPath(SCOPE)).mode = 0o755; });
    const e = R.createScopeEnder({ system: open.system });
    deepStrictEqual(e.kill(identity()), { state: 'withheld', check: 'modes' });
    deepStrictEqual(e.read(identity()), { state: 'withheld', check: 'modes' });
    deepStrictEqual(open.kills, []);
    const gone = fakeLinux();
    const g = R.createScopeEnder({ system: gone.system });
    g.kill(identity());
    gone.nodes.delete(gone.cgPath(SCOPE));
    strictEqual(g.read(identity()).state, 'gone');
    strictEqual(R.readGoneHere(identity()), true, 'the gate sees this process\'s reading');
  });

  it('a read alone, for a handle with no authority, writes no kill', () => {
    const fake = fakeLinux(closed);
    strictEqual(R.createScopeEnder({ system: fake.system }).read(identity()).state, 'unproven');
    deepStrictEqual(fake.kills, []);
  });
});

describe('a new scope before the word (T4)', () => {
  // The scope as the gate leaves it before the runner reads it: open to
  // entry, the gate its only member.
  const fresh = (edit = () => {}) => fakeLinux((f) => {
    f.nodes.get(f.cgPath(SCOPE)).mode = 0o755;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).mode = 0o644;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.threads`)).mode = 0o644;
    f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).text = `${GATE.pid}\n`;
    edit(f);
  });

  it('reads the gate\'s cgroup and start through the anchor', () => {
    const fake = fakeLinux((f) => {
      f.nodes.set(`/proc/${GATE.pid}/cgroup`, { ino: 5n, mode: 0o444, text: `0::${SCOPE}\n`, ...PROC });
    });
    const r = reader(fake);
    strictEqual(R.readCgroupOf(fake.system, r.anchor, GATE.pid), SCOPE);
    strictEqual(R.readStart(fake.system, r.anchor, GATE.pid), GATE.starttime);
    strictEqual(R.readCgroupOf(fake.system, r.anchor, 4300), null);
  });

  it('takes a domain leaf holding the gate alone, whose cgroup.kill opens, with its 64-bit id', () => {
    const fake = fresh();
    deepStrictEqual(R.inspectNewScope(reader(fake), { path: SCOPE, gatePid: GATE.pid }), { ok: true, cgroupId: '18446744073709551615' });
    strictEqual(fake.kills.length, 0);
  });

  it('refuses a scope holding another member, a cgroup below it, another type, or no cgroup.kill', () => {
    const rows = [
      ['gate-placement', (f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).text = `${GATE.pid}\n4300\n`; }],
      ['gate-placement', (f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).text = '4300\n'; }],
      ['gate-placement', (f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.procs`)).text = ''; }],
      ['not-leaf', (f) => { f.nodes.set(f.cgPath(`${SCOPE}/sub`), { ino: 7n, mode: 0o755, dir: true, ...CG }); }],
      ['cgroup-type', (f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.type`)).text = 'threaded\n'; }],
      ['no-cgroup-kill', (f) => { f.nodes.delete(f.cgPath(`${SCOPE}/cgroup.kill`)); }],
      ['scope-missing', (f) => { f.nodes.delete(f.cgPath(SCOPE)); }],
    ];
    for (const [check, edit] of rows) {
      const fake = fresh(edit);
      deepStrictEqual(R.inspectNewScope(reader(fake), { path: SCOPE, gatePid: GATE.pid }), { ok: false, state: 'withheld', check }, check);
    }
  });

  it('the recheck before the word takes the closed scope only, of the recorded id', () => {
    const fake = fresh();
    const r = reader(fake);
    const id = '18446744073709551615';
    deepStrictEqual(R.inspectNewScope(r, { path: SCOPE, gatePid: GATE.pid, closed: { cgroupId: id } }), { ok: false, state: 'withheld', check: 'close-modes' });
    deepStrictEqual(R.closeNewScope(r, { path: SCOPE, cgroupId: id }), { ok: true });
    deepStrictEqual(R.inspectNewScope(r, { path: SCOPE, gatePid: GATE.pid, closed: { cgroupId: id } }), { ok: true, cgroupId: id });
    deepStrictEqual(R.inspectNewScope(r, { path: SCOPE, gatePid: GATE.pid, closed: { cgroupId: '42' } }), { ok: false, state: 'withheld', check: 'cgroup-id' });
    fake.nodes.get(fake.cgPath(`${SCOPE}/cgroup.threads`)).mode = 0o644;
    deepStrictEqual(R.inspectNewScope(r, { path: SCOPE, gatePid: GATE.pid, closed: { cgroupId: id } }), { ok: false, state: 'withheld', check: 'close-modes' });
    fake.nodes.get(fake.cgPath(`${SCOPE}/cgroup.threads`)).mode = 0o444;
    fake.nodes.get(fake.cgPath(`${SCOPE}/cgroup.procs`)).text = `${GATE.pid}\n4300\n`;
    deepStrictEqual(R.inspectNewScope(r, { path: SCOPE, gatePid: GATE.pid, closed: { cgroupId: id } }), { ok: false, state: 'withheld', check: 'gate-placement' });
  });

  it('a kernel whose ino_t is narrower than 64 bits attests no reader', () => {
    strictEqual(R.attestReader({ system: { ...fakeLinux().system, machine: () => 'armv7l' }, cgroupPath: SCOPE }).check, 'ino-width');
  });

  it('closes the scope to entry: no write permission on its cgroup.procs, cgroup.threads or directory', () => {
    const fake = fresh();
    deepStrictEqual(R.closeNewScope(reader(fake), { path: SCOPE, cgroupId: '18446744073709551615' }), { ok: true });
    for (const p of [SCOPE, `${SCOPE}/cgroup.procs`, `${SCOPE}/cgroup.threads`]) strictEqual(fake.nodes.get(fake.cgPath(p)).mode & 0o222, 0, p);
    // The kill's own check then reads the scope closed.
    strictEqual(R.authorizeKill(reader(fake), identity()).ok, true);
  });

  it('refuses to close a directory of another id, or one whose mode it cannot take off', () => {
    const other = fresh();
    deepStrictEqual(R.closeNewScope(reader(other), { path: SCOPE, cgroupId: '42' }), { ok: false, state: 'withheld', check: 'cgroup-id' });
    strictEqual(other.nodes.get(other.cgPath(`${SCOPE}/cgroup.procs`)).mode, 0o644);
    const stuck = fresh((f) => { f.nodes.get(f.cgPath(`${SCOPE}/cgroup.threads`)).chmodError = 'EPERM'; });
    deepStrictEqual(R.closeNewScope(reader(stuck), { path: SCOPE, cgroupId: '18446744073709551615' }), { ok: false, state: 'withheld', check: 'close-modes' });
  });
});

describe('a supervisor proven gone (T2)', () => {
  const sup = (over = {}) => ({ pid: 4200, fingerprint: { kind: 'linux_proc_starttime', starttime: '4000' }, clock: CLOCK, boot_id: BOOT, ...over });
  const withSup = (start) => (f) => {
    f.nodes.set('/proc/4200', { dir: true, ...PROC, ino: 6n });
    f.nodes.set('/proc/4200/stat', { text: stat(4200, start), ...PROC, ino: 7n, mode: 0o444 });
    f.alive.set(4200, 'alive');
  };

  it('a record that is not whole grants nothing, never gone', () => {
    deepStrictEqual(R.supervisorGone(sup({ pid: 0 }), { system: fakeLinux().system }), { gone: false, grants: false, check: 'record' });
    deepStrictEqual(R.supervisorGone(sup({ fingerprint: { kind: 'none' } }), { system: fakeLinux().system }), { gone: false, grants: false, check: 'record' });
  });

  it('is gone under another boot, by another start, or by ESRCH', () => {
    const other = CLOCK.replace(BOOT, OTHER_BOOT);
    deepStrictEqual(R.supervisorGone(sup({ boot_id: OTHER_BOOT, clock: other }), { system: fakeLinux().system }), { gone: true, check: 'other-boot' });
    deepStrictEqual(R.supervisorGone(sup(), { system: fakeLinux(withSup('4001')).system }), { gone: true, check: 'other-start' });
    deepStrictEqual(R.supervisorGone(sup(), { system: fakeLinux().system }), { gone: true, check: 'esrch' });
  });

  it('is not gone while alive, from another clock, a /proc that may hide, or a miss the probe contradicts', () => {
    deepStrictEqual(R.supervisorGone(sup(), { system: fakeLinux(withSup('4000')).system }), { gone: false, check: 'alive' });
    deepStrictEqual(R.supervisorGone(sup({ clock: `${BOOT}/${TIME_NS}/pid:[9]` }), { system: fakeLinux().system }), { gone: false, check: 'clock' });
    const hides = fakeLinux((f) => { f.nodes.get('/proc/self/mountinfo').text = MOUNTINFO.replace('proc proc rw', 'proc proc rw,hidepid=2'); });
    deepStrictEqual(R.supervisorGone(sup(), { system: hides.system }), { gone: false, check: 'proc-hides' });
    const miss = fakeLinux((f) => f.alive.set(4200, 'alive'));
    deepStrictEqual(R.supervisorGone(sup(), { system: miss.system }), { gone: false, check: 'proc-miss' });
    const noBoot = fakeLinux((f) => { f.nodes.get('/proc/sys/kernel/random/boot_id').text = 'x'; });
    deepStrictEqual(R.supervisorGone(sup(), { system: noBoot.system }), { gone: false, check: 'boot-id' });
  });
});

describe('this machine', () => {
  it('a Linux reader reads its own boot and clock through the anchor as clockDomain reads them', { skip: process.platform !== 'linux' && 'Linux only' }, async () => {
    const P = await import(pathToFileURL(join(LIB, 'process-identity.mjs')).href);
    const a = R.openProcAnchor();
    strictEqual(a.ok, true, a.check);
    try {
      const boot = R.readBootId(R.SYSTEM, a);
      strictEqual(R.readClock(R.SYSTEM, a, boot), await P.clockDomain());
    } finally {
      R.SYSTEM.close(a.fd);
    }
  });
});
