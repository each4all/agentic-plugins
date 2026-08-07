// Tests for the ADR-0048 residual (d) cross-checkout legacy egress-intent
// discovery (`runtime:migrate legacy-egress-intents`).
//
// Almost everything here runs against an INJECTED filesystem seam rather than a
// real fixture tree. That is not a convenience: the failure modes that matter
// are `EACCES`, `EPERM`, `EIO`, a directory vanishing mid-scan, and a listing
// larger than the entry cap — and a real `chmod 000` fixture SKIPS silently
// under UID 0 on CI, so a mutant that ignored `EACCES` would survive. Real-
// filesystem checks are kept as an ADDITIONAL layer at the end, never as the
// only coverage.
//
// Every negative assertion ("no removal verb appears") is paired with a CONTROL
// that proves the assertion can fail — an assertion over a branch the fixture
// never reaches is vacuously green.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHECKOUT_MARKER,
  DISCOVERY_EXIT_CODES,
  DISCOVERY_STATUS,
  GUIDANCE,
  LEGACY_EGRESS_DISCOVERY_SCHEMA,
  MAX_REPORTED_PER_BUCKET,
  discoverLegacyEgressIntents,
  renderDiscoveryJson,
  renderDiscoveryText,
  resolveDiscoveryStatus,
} from '../../plugins/runtime/scripts/lib/legacy-egress-discovery.mjs';
import {
  EGRESS_INTENT_DIR_SUFFIX,
  egressIntentDir,
  isDisplayHazard,
  safeOperatorText,
  safeRecordName,
} from '../../plugins/runtime/scripts/lib/egress-intent-wal.mjs';

// --- injected filesystem seam ----------------------------------------------

const WAL_REL = EGRESS_INTENT_DIR_SUFFIX.join('/');

// Entry kinds the seam can produce. `dir` descends; everything else does not.
function dirent(name, kind) {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink-dir' || kind === 'symlink-file',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
  };
}

class FakeFs {
  constructor() {
    this.dirs = new Map();       // path -> [{name, kind}]
    this.ids = new Map();        // path -> [dev, ino]
    this.opendirErrors = new Map();
    this.statErrors = new Map();
    this.midScanAfter = new Map(); // path -> {count, code}
    this.links = new Map();      // symlink path -> target path (for stat-follows)
    this.realpaths = new Map();
    this.yielded = new Map();    // path -> entries actually produced by the iterator
    this.identityRebind = new Map();
    this.unsafeIdentities = new Set();
    this.nextIno = 1000;
  }

  // Make `path` report a DIFFERENT identity from its Nth identity observation
  // onwards — a deterministic stand-in for a component swapped underneath.
  rebindAfter(path, afterCall, to) { this.identityRebind.set(path, { afterCall, calls: 0, to }); return this; }

  // Make `path` report dev/ino that cannot be compared exactly.
  unsafeIdentity(path) { this.unsafeIdentities.add(path); return this; }

  dir(path, entries = []) {
    this.dirs.set(path, entries);
    if (!this.ids.has(path)) this.ids.set(path, [1, this.nextIno++]);
    return this;
  }

  // Two paths that ARE one directory (a symlinked home, a case variant).
  alias(pathA, pathB) {
    this.ids.set(pathB, this.ids.get(pathA));
    if (!this.dirs.has(pathB)) this.dirs.set(pathB, this.dirs.get(pathA) ?? []);
    return this;
  }

  // A whole legacy WAL under `checkoutRoot`, with the given record entries.
  wal(checkoutRoot, records = []) {
    this.dir(`${checkoutRoot}/${EGRESS_INTENT_DIR_SUFFIX[0]}`);
    this.dir(`${checkoutRoot}/${EGRESS_INTENT_DIR_SUFFIX.slice(0, 2).join('/')}`);
    this.dir(`${checkoutRoot}/${EGRESS_INTENT_DIR_SUFFIX.slice(0, 3).join('/')}`);
    this.dir(`${checkoutRoot}/${WAL_REL}`, records);
    return this;
  }

  failOpendir(path, code) { this.opendirErrors.set(path, code); return this; }
  failStat(path, code) { this.statErrors.set(path, code); return this; }
  failMidScan(path, count, code) { this.midScanAfter.set(path, { count, code }); return this; }
  link(path, target) { this.links.set(path, target); return this; }

  get ops() {
    const self = this;
    return {
      async opendir(path) {
        const code = self.opendirErrors.get(path);
        if (code) throw Object.assign(new Error(code), { code });
        if (!self.dirs.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const entries = self.dirs.get(path);
        const mid = self.midScanAfter.get(path);
        self.yielded.set(path, 0);
        return {
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < entries.length; i += 1) {
              if (mid && i === mid.count) throw Object.assign(new Error(mid.code), { code: mid.code });
              self.yielded.set(path, i + 1);
              yield dirent(entries[i].name, entries[i].kind);
            }
          },
          async close() {},
        };
      },
      async stat(path) {
        const resolved = self.links.get(path) ?? path;
        const code = self.statErrors.get(path) ?? self.statErrors.get(resolved);
        if (code) throw Object.assign(new Error(code), { code });
        if (!self.ids.has(resolved)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const [dev, ino] = self.ids.get(resolved);
        const isDir = self.dirs.has(resolved);
        return { dev, ino, isDirectory: () => isDir, isFile: () => !isDir };
      },
      // Identity is asked for in BigInt in production so dev/ino above 2^53 stay
      // exact; the seam mirrors that so the tests exercise the real shape.
      // `identityRebind` lets a test make a path answer differently on the Nth
      // observation — the only way to provoke a TOCTOU swap deterministically.
      async statIdentity(path) {
        const rebind = self.identityRebind.get(path);
        if (rebind) {
          rebind.calls += 1;
          if (rebind.calls >= rebind.afterCall) {
            const [d, i] = rebind.to;
            return { dev: BigInt(d), ino: BigInt(i), isDirectory: () => true, isFile: () => false };
          }
        }
        const st = await this.stat(path);
        if (self.unsafeIdentities.has(self.links.get(path) ?? path)) {
          return { dev: Number.MAX_SAFE_INTEGER + 2, ino: Number.MAX_SAFE_INTEGER + 2, isDirectory: st.isDirectory, isFile: st.isFile };
        }
        return { dev: BigInt(st.dev), ino: BigInt(st.ino), isDirectory: st.isDirectory, isFile: st.isFile };
      },
      // NEVER resolves the final component — that is the whole point of walking
      // the fixed suffix with it.
      async lstat(path) {
        const code = self.statErrors.get(path);
        if (code) throw Object.assign(new Error(code), { code });
        const isLink = self.links.has(path);
        if (!isLink && !self.ids.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const isDir = !isLink && self.dirs.has(path);
        return { isDirectory: () => isDir, isSymbolicLink: () => isLink, isFile: () => !isDir && !isLink };
      },
      async realpath(path) {
        if (self.realpaths.has(path)) return self.realpaths.get(path);
        if (self.links.has(path)) return self.links.get(path);
        if (!self.ids.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return path;
      },
    };
  }
}

// A scripted clock, so the budget can be tripped at an EXACT point in the call
// sequence rather than by racing a real one. The deadline is now checked both
// between directories and inside the entry loop, and those are different
// properties that need to be provoked separately.
function scriptedClock(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const HOME = '/home/op';
const LIVE_WAL = egressIntentDir(HOME);

// Every word that could be read as "act on this by taking it away".
//
// Deliberately over-broad, and WIDER than the first cut: that one listed
// `remove` but not `removed`, so the report's own `no file is … removed by this
// command` slipped past a check that claimed no removal verb appeared at all,
// and `clear` — the verb `doctor.mjs` uses for exactly this domain — was absent.
// A cross-host review found both. If a future edit puts any of these into an
// incomplete report, the test fails and the author must justify it.
const REMOVAL_VERBS = /\b(remove[ds]?|removing|removal|delete[ds]?|deleting|deletion|unlink(ed|s)?|eras(e|ed|ing)|purg(e|ed|ing)|discard(ed|s)?|clear(ed|s|ing)?|rm|rmdir)\b/i;
// A generated shell command in ANY form. The first cut required `rm` to be
// followed by `-`, so a bare `rm /path` was invisible to it.
const SHELL_SHAPE = /(^|\s)(rm|rmdir|find|xargs|unlink)\s+\S|\$\(|`[^`]*`|\|\s*(sh|bash|zsh)\b/;

// Every run goes through a seam that TRAPS a body read. The scanner is supposed
// to touch directory metadata and Dirents only; without a trap, an
// implementation that opened and discarded every record would pass every
// assertion in this file (cross-host review). `open`/`readFile`/`readdir` are
// not part of the injected contract, so reaching for one is an escape from the
// seam, and that is what these throw on.
function trappedOps(fs) {
  const base = fs.ops;
  const trap = (name) => () => { throw new Error(`the scanner reached for ${name} — it must read no record body`); };
  return {
    ...base,
    open: trap('open'),
    readFile: trap('readFile'),
    readdir: trap('readdir'),
    createReadStream: trap('createReadStream'),
  };
}

async function run(fs, overrides = {}) {
  return discoverLegacyEgressIntents({
    homeDir: HOME,
    // The passwd-derived second reference point defaults to the same home in
    // most fixtures; the dual-home tests override it deliberately.
    passwdHome: HOME,
    host: 'test-host',
    now: new Date('2026-08-06T00:00:00Z'),
    runtimeVersion: '9.9.9',
    ops: trappedOps(fs),
    clock: () => 0,
    ...overrides,
  });
}

// --- T4: the status function, total over its INPUT --------------------------

describe('legacy-egress discovery — status is total over its input (T4)', () => {
  it('yields the reassuring status for exactly ONE input combination', () => {
    strictEqual(
      resolveDiscoveryStatus({ scanComplete: true, blocked: [], findings: [] }),
      DISCOVERY_STATUS.none,
    );
  });

  it('a complete scan WITH findings is findings_present, not incomplete', () => {
    strictEqual(
      resolveDiscoveryStatus({ scanComplete: true, blocked: [], findings: [{ dir: 'x' }] }),
      DISCOVERY_STATUS.findings,
    );
  });

  // The matrix. Each row is a malformed or contradictory input that a
  // truthiness check (`if (scanComplete)`) or a missing array check would let
  // through as clean.
  const malformed = [
    ['string "false" (truthy!)', { scanComplete: 'false', blocked: [], findings: [] }],
    ['string "true" (not === true)', { scanComplete: 'true', blocked: [], findings: [] }],
    ['undefined', { scanComplete: undefined, blocked: [], findings: [] }],
    ['null', { scanComplete: null, blocked: [], findings: [] }],
    ['number 1', { scanComplete: 1, blocked: [], findings: [] }],
    ['object', { scanComplete: {}, blocked: [], findings: [] }],
    ['blocked not an array', { scanComplete: true, blocked: {}, findings: [] }],
    ['blocked undefined', { scanComplete: true, blocked: undefined, findings: [] }],
    ['findings not an array', { scanComplete: true, blocked: [], findings: {} }],
    ['findings undefined', { scanComplete: true, blocked: [], findings: undefined }],
    ['complete=true beside a non-empty blocked', { scanComplete: true, blocked: [{ path: 'p' }], findings: [] }],
    ['no arguments at all', undefined],
    // The COUNT is a separate argument from the display list, so it gets the
    // same total-over-input treatment.
    ['blockedTotal is a string', { scanComplete: true, blocked: [], blockedTotal: '0', findings: [] }],
    ['blockedTotal is negative', { scanComplete: true, blocked: [], blockedTotal: -1, findings: [] }],
    ['blockedTotal is null', { scanComplete: true, blocked: [], blockedTotal: null, findings: [] }],
    ['blockedTotal is NaN', { scanComplete: true, blocked: [], blockedTotal: NaN, findings: [] }],
    ['blockedTotal is fractional', { scanComplete: true, blocked: [], blockedTotal: 0.5, findings: [] }],
    ['an EMPTY display list beside a non-zero count', { scanComplete: true, blocked: [], blockedTotal: 1, findings: [] }],
    // The row the first matrix was missing: an INCOMPLETE scan that also found
    // things. A rule that returned `findings_present` before testing
    // `scanComplete` would satisfy every other row here (cross-host review).
    ['incomplete scan WITH findings', { scanComplete: false, blocked: [], findings: [{ dir: 'x' }] }],
    ['blocked scan WITH findings', { scanComplete: true, blocked: [{ path: 'p' }], findings: [{ dir: 'x' }] }],
  ];
  for (const [label, input] of malformed) {
    it(`fails closed to incomplete: ${label}`, () => {
      strictEqual(resolveDiscoveryStatus(input), DISCOVERY_STATUS.incomplete);
    });
  }

  it('CONTROL — the only difference between the clean row and the contradictory one is `blocked`', () => {
    const base = { scanComplete: true, findings: [] };
    strictEqual(resolveDiscoveryStatus({ ...base, blocked: [] }), DISCOVERY_STATUS.none);
    strictEqual(resolveDiscoveryStatus({ ...base, blocked: [{ path: 'p' }] }), DISCOVERY_STATUS.incomplete);
  });
});

// --- T2: roots and physical identity ---------------------------------------

describe('legacy-egress discovery — root semantics and identity (T2)', () => {
  it('the LIVE machine-global WAL is an exclusion, never a finding', async () => {
    const fs = new FakeFs().dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }]).wal(HOME);
    const report = await run(fs);
    strictEqual(report.findings.length, 0);
    deepStrictEqual(report.exclusions, [{ path: LIVE_WAL, reason: 'current-machine-global-wal' }]);
    strictEqual(report.overall.status, DISCOVERY_STATUS.none);
  });

  it('a SYMLINKED home reaches the live WAL by a second spelling and it is still excluded', async () => {
    // The scan is rooted at the symlink; realpath lands on the physical home, so
    // the candidate path spells differently from `egressIntentDir(homeDir)` —
    // exactly the case a string comparison got wrong and shipped.
    const PHYS = '/physical/home';
    const fs = new FakeFs()
      .dir(PHYS, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(PHYS);
    fs.realpaths.set('/link/home', PHYS);
    fs.ids.set('/link/home', fs.ids.get(PHYS));
    // The live WAL as the runtime spells it, aliased onto the physical one.
    fs.dir(LIVE_WAL).alias(`${PHYS}/${WAL_REL}`, LIVE_WAL);

    const report = await run(fs, { requestedRoots: ['/link/home'] });
    strictEqual(report.findings.length, 0, 'the live fence must never be offered for review');
    strictEqual(report.exclusions.length, 1);
  });

  it('CONTROL — a PHYSICALLY DISTINCT legacy dir under the same walk stays a finding', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }, { name: 'work', kind: 'dir' }])
      .wal(HOME)
      .dir(`${HOME}/work`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/work`, [{ name: 'r1.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.exclusions.length, 1);
    strictEqual(report.findings.length, 1);
    strictEqual(report.findings[0].dir, `${HOME}/work/${WAL_REL}`);
  });

  it('nested and duplicate roots report the target once', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'work', kind: 'dir' }])
      .dir(`${HOME}/work`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/work`, [{ name: 'r1.json', kind: 'file' }]);
    const report = await run(fs, { requestedRoots: [HOME, `${HOME}/work`, HOME] });
    strictEqual(report.roots.length, 1, 'a nested root and a duplicate collapse into the outer one');
    strictEqual(report.roots[0].canonical, HOME);
    strictEqual(report.findings.length, 1);
  });

  it('an explicitly-named MISSING root is blocked, never silently clean', async () => {
    const fs = new FakeFs().dir(HOME, []);
    const report = await run(fs, { requestedRoots: ['/does/not/exist'] });
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    strictEqual(report.scan.blocked_total, 1);
    match(report.scan.blocked[0].reason, /root could not be resolved \(ENOENT\)/);
  });

  it('--root REPLACES the default home rather than adding to it', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(HOME)
      .dir('/elsewhere', []);
    const report = await run(fs, { requestedRoots: ['/elsewhere'] });
    deepStrictEqual(report.roots.map((r) => r.canonical), ['/elsewhere']);
    strictEqual(report.exclusions.length, 0, 'home was not scanned, so its WAL was never reached');
  });

  it('a root that is a FILE is blocked', async () => {
    const fs = new FakeFs().dir(HOME, []);
    fs.ids.set('/a/file', [1, 77]); // has an identity but is not in `dirs`
    const report = await run(fs, { requestedRoots: ['/a/file'] });
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked[0].reason, /not a directory/);
  });

  it('the live WAL is observed ONCE per scan, not once per candidate', async () => {
    // The narrower the window between observing the live WAL and comparing a
    // candidate against it, the less room a path has to stop and start resolving
    // to it. Re-observing per candidate re-opens exactly that. The property is
    // countable, so it is counted rather than asserted in a comment.
    const names = ['a', 'b', 'c'];
    const fs = new FakeFs().dir(HOME, names.map((n) => ({ name: n, kind: 'dir' })));
    for (const n of names) {
      fs.dir(`${HOME}/${n}`, [{ name: '.agentic-plugins', kind: 'dir' }]).wal(`${HOME}/${n}`, []);
    }
    fs.dir(LIVE_WAL);
    const base = trappedOps(fs);
    let liveWalStats = 0;
    const counting = { ...base, async stat(p) { if (p === LIVE_WAL) liveWalStats += 1; return base.stat(p); } };
    const report = await discoverLegacyEgressIntents({
      homeDir: HOME, host: 'test-host', now: new Date('2026-08-06T00:00:00Z'),
      runtimeVersion: '9.9.9', ops: counting, clock: () => 0,
    });
    strictEqual(report.findings_total, 3, 'all three candidates were examined');
    strictEqual(liveWalStats, 1, `the live WAL was observed ${liveWalStats} times for 3 candidates`);
  });

  it('a root that CANONICALIZES to / is refused, even when it was named as a symlink', async () => {
    // The refusal used to run on the spelling the operator typed, so `--root
    // <symlink to />` passed it and then walked the whole filesystem — an
    // explicit non-goal reached through a one-line symlink.
    const fs = new FakeFs().dir(HOME, []).dir('/', []);
    fs.realpaths.set('/looks/harmless', '/');
    fs.ids.set('/looks/harmless', fs.ids.get('/'));
    const report = await run(fs, { requestedRoots: ['/looks/harmless'] });
    deepStrictEqual(report.roots, [], 'nothing was scanned');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /resolves to a filesystem root/);
  });

  it('the PASSWD-derived home is a second reference point, so an overridden $HOME cannot unmask the fence', async () => {
    // Reproduced before the fix: `HOME=/tmp/x` made the real machine-global WAL
    // a finding with removal wording. `os.homedir()` follows $HOME;
    // `os.userInfo().homedir` does not, so the two disagree exactly in the case
    // that harms — and a candidate matching EITHER must be excluded.
    const REAL = '/real/home';
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'real', kind: 'dir' }])
      .dir(`${HOME}/real`, [])
      .dir(REAL, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(REAL, [{ name: 'live.json', kind: 'file' }]);
    // The scan is rooted at the REAL home, but $HOME points somewhere else.
    const report = await run(fs, { requestedRoots: [REAL], homeDir: '/overridden', passwdHome: REAL });
    strictEqual(report.findings_total, 0, 'the live fence must never be offered for review');
    strictEqual(report.exclusions.length, 1);
    strictEqual(report.live_wal.compared_against.length, 2, 'both reference points are reported');
  });

  it('an UNKNOWN live-WAL identity blocks instead of guessing either way', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'work', kind: 'dir' }])
      .dir(`${HOME}/work`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/work`, [])
      .dir(LIVE_WAL)
      .failStat(LIVE_WAL, 'EACCES');
    const report = await run(fs);
    strictEqual(report.findings.length, 0, 'not guessed as a finding');
    strictEqual(report.exclusions.length, 0, 'not guessed as an exclusion');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /could not be told apart from the live machine-global WAL/);
  });
});

// --- T3: the walker ---------------------------------------------------------

describe('legacy-egress discovery — streaming walker (T3)', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOENT']) {
    it(`an unopenable directory (${code}) is blocked and demotes the status`, async () => {
      const fs = new FakeFs()
        .dir(HOME, [{ name: 'sub', kind: 'dir' }])
        .dir(`${HOME}/sub`, [])
        .failOpendir(`${HOME}/sub`, code);
      const report = await run(fs);
      strictEqual(report.scan.blocked_total, 1);
      match(report.scan.blocked[0].reason, new RegExp(`directory could not be opened \\(${code}\\)`));
      strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    });
  }

  it('CONTROL — the same tree without the injected error is clean', async () => {
    const fs = new FakeFs().dir(HOME, [{ name: 'sub', kind: 'dir' }]).dir(`${HOME}/sub`, []);
    const report = await run(fs);
    strictEqual(report.scan.blocked_total, 0);
    strictEqual(report.overall.status, DISCOVERY_STATUS.none);
  });

  it('a listing that fails MID-SCAN is blocked, not silently truncated', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'dir' }, { name: 'c', kind: 'dir' }])
      .dir(`${HOME}/a`, []).dir(`${HOME}/b`, []).dir(`${HOME}/c`, [])
      .failMidScan(HOME, 2, 'ENOENT');
    const report = await run(fs);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /listing failed mid-scan \(ENOENT\)/);
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('the entry cap acts BEFORE the listing is materialized', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ name: `d${i}`, kind: 'dir' }));
    const fs = new FakeFs().dir(HOME, many);
    for (const e of many) fs.dir(`${HOME}/${e.name}`, []);
    const report = await run(fs, { caps: { maxEntriesPerDir: 10 } });
    // The decisive assertion: the ITERATOR was stopped, not the result filtered.
    // A `readdir` implementation would have produced all 5000 before any cap ran.
    strictEqual(fs.yielded.get(HOME), 11, 'iteration stopped one entry past the cap');
    ok(report.scan.pruned_total >= 1);
    strictEqual(report.scan.pruned_by_reason['entry-cap'], 1);
  });

  it('the depth cap prunes rather than blocks', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'a', kind: 'dir' }])
      .dir(`${HOME}/a`, [{ name: 'b', kind: 'dir' }])
      .dir(`${HOME}/a/b`, []);
    const report = await run(fs, { caps: { maxDepth: 1 } });
    strictEqual(report.scan.blocked_total, 0);
    strictEqual(report.scan.pruned_by_reason['depth-cap'], 1);
    strictEqual(report.overall.status, DISCOVERY_STATUS.none, 'a prune is a printed boundary, not a demotion');
  });

  it('a budget that expires BETWEEN directories reports the whole queued remainder', async () => {
    const children = Array.from({ length: 6 }, (_, i) => ({ name: `d${i}`, kind: 'dir' }));
    const fs = new FakeFs().dir(HOME, children);
    for (const e of children) fs.dir(`${HOME}/${e.name}`, []);
    // Call order: started, walk-top, then one per entry (6). The 9th read — the
    // walk-top check for the first child — is the first past the deadline, so
    // the root is listed in full and all six children are still queued.
    const clock = scriptedClock([0, 0, 0, 0, 0, 0, 0, 0, 999]);
    const report = await run(fs, { clock, caps: { timeBudgetMs: 15 } });
    strictEqual(report.scan.complete, false);
    strictEqual(report.scan.ended_early_because, 'time-budget');
    strictEqual(report.scan.pruned_by_reason['time-budget'], 6, 'all six queued directories are counted');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('a budget that expires INSIDE a listing names that directory as unfinished', async () => {
    // The between-directories check alone let one directory with an enormous
    // listing on a slow mount run far past the deadline while the report still
    // said the walk completed.
    const children = Array.from({ length: 6 }, (_, i) => ({ name: `d${i}`, kind: 'dir' }));
    const fs = new FakeFs().dir(HOME, children);
    for (const e of children) fs.dir(`${HOME}/${e.name}`, []);
    // The 4th read is the second entry of the root listing.
    const clock = scriptedClock([0, 0, 0, 999]);
    const report = await run(fs, { clock, caps: { timeBudgetMs: 15 } });
    strictEqual(report.scan.complete, false);
    strictEqual(report.scan.ended_early_because, 'time-budget');
    ok(report.scan.pruned.some((p) => p.path === HOME && p.reason === 'time-budget'),
      'the directory whose listing was cut short is named');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('a directory whose listing THREW is not counted as completed', async () => {
    // `dirs_completed` sitting beside a blocked entry for the same directory is
    // a statistic that contradicts the report it appears in.
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'dir' }])
      .dir(`${HOME}/a`, []).dir(`${HOME}/b`, [])
      .failMidScan(HOME, 1, 'EIO');
    const report = await run(fs);
    strictEqual(report.scan.blocked_total, 1);
    strictEqual(report.scan.stats.dirs_completed, 1, 'only the child that listed cleanly counts');
    strictEqual(report.scan.stats.dirs_scanned, 2);
  });

  it('EVERY descendant symlink is a reported boundary, and none is dereferenced', async () => {
    // An earlier cut `stat`ed each symlink to report only the directory ones.
    // That dereferences the link — it can block on the very remote mount the
    // budget exists to survive, can reach outside the scanned root, and on stat
    // FAILURE dropped the boundary from the report entirely. So no descendant
    // symlink is dereferenced and all of them are boundaries, dangling ones
    // included.
    const fs = new FakeFs()
      .dir(HOME, [
        { name: 'linked', kind: 'symlink-dir' },
        { name: 'lib.so', kind: 'symlink-file' },
        { name: 'dangling', kind: 'symlink-dir' },
      ])
      .dir('/target', [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal('/target', [{ name: 'r.json', kind: 'file' }])
      .link(`${HOME}/linked`, '/target');
    // A `stat` on any of the three would be a dereference; make it observable.
    let statted = [];
    const ops = fs.ops;
    const watched = { ...ops, async stat(p) { statted.push(p); return ops.stat(p); } };

    const report = await run(fs, { ops: watched });
    strictEqual(report.scan.not_followed_total, 3, 'file and dangling symlinks are boundaries too');
    strictEqual(report.scan.blocked_total, 0, 'a boundary is not a failure');
    strictEqual(report.findings_total, 0, 'the symlinked subtree was not enumerated');
    strictEqual(report.overall.status, DISCOVERY_STATUS.none);
    for (const name of ['linked', 'lib.so', 'dangling']) {
      strictEqual(statted.includes(`${HOME}/${name}`), false, `${name} was dereferenced`);
    }
  });

  it('a MARKER that is a symlink is a boundary, not a hit — its suffix is never resolved', async () => {
    // `stat`ing the fixed suffix under a symlinked marker resolves through it and
    // then `opendir`s outside the scanned root, while `not_followed` stayed 0.
    const fs = new FakeFs()
      .dir(HOME, [{ name: CHECKOUT_MARKER, kind: 'symlink-dir' }])
      .dir('/elsewhere', [])
      .wal('/elsewhere', [{ name: 'r.json', kind: 'file' }]);
    fs.link(`${HOME}/${CHECKOUT_MARKER}`, '/elsewhere/.agentic-plugins');
    fs.ids.set(`${HOME}/${CHECKOUT_MARKER}/runs/doctor/egress-intents`, fs.ids.get(`/elsewhere/${WAL_REL}`));
    fs.dirs.set(`${HOME}/${CHECKOUT_MARKER}/runs/doctor/egress-intents`, [{ name: 'r.json', kind: 'file' }]);

    const report = await run(fs);
    strictEqual(report.findings_total, 0, 'a symlinked marker must not reach outside the root');
    strictEqual(report.scan.not_followed_total, 1);
    strictEqual(report.overall.status, DISCOVERY_STATUS.none);
  });

  it('node_modules and .git are pruned by name', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'node_modules', kind: 'dir' }, { name: '.git', kind: 'dir' }])
      .dir(`${HOME}/node_modules`, []).dir(`${HOME}/.git`, []);
    const report = await run(fs);
    strictEqual(report.scan.pruned_by_reason['name-prune'], 2);
    strictEqual(report.scan.stats.dirs_scanned, 1, 'neither was opened');
  });

  it('an operator --skip excludes a subtree by IDENTITY, and is reported', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'mnt', kind: 'dir' }])
      .dir(`${HOME}/mnt`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/mnt`, [{ name: 'r.json', kind: 'file' }]);
    // A second spelling of the same directory — the skip must still hold.
    fs.alias(`${HOME}/mnt`, '/other/name/for/mnt');
    const report = await run(fs, { skipPaths: ['/other/name/for/mnt'] });
    strictEqual(report.findings.length, 0);
    strictEqual(report.scan.pruned_by_reason['operator-skip'], 1);
    strictEqual(report.skips.length, 1);
  });

  it('CONTROL — without the --skip the same subtree IS a finding', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'mnt', kind: 'dir' }])
      .dir(`${HOME}/mnt`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/mnt`, [{ name: 'r.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.findings.length, 1);
  });

  it('a --skip naming a ROOT itself is honored, not only its children', async () => {
    // The skip check ran inside the entry loop only, so `--root X --skip X`
    // walked X in full (reproduced before the fix).
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(HOME, [{ name: 'r.json', kind: 'file' }])
      .dir('/mnt', [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal('/mnt', [{ name: 'r.json', kind: 'file' }]);
    const report = await run(fs, { requestedRoots: ['/mnt'], skipPaths: ['/mnt'] });
    strictEqual(report.findings_total, 0);
    strictEqual(report.scan.pruned_by_reason['operator-skip'], 1);
    strictEqual(report.scan.stats.dirs_scanned, 0, 'the root was never opened');
  });

  it('roots left unwalked when the budget expires are counted, not silently dropped', async () => {
    // The loop broke out on exhaustion without recording the roots it had not
    // reached, so the report read as if those roots had simply held nothing.
    const fs = new FakeFs()
      .dir('/r1', [{ name: 'a', kind: 'dir' }])
      .dir('/r1/a', [])
      .dir('/r2', [])
      .dir('/r3', []);
    // started, walk-top(/r1), entry a, walk-top(/r1/a) ← expires here.
    const clock = scriptedClock([0, 0, 0, 999]);
    const report = await run(fs, { requestedRoots: ['/r1', '/r2', '/r3'], clock, caps: { timeBudgetMs: 15 } });
    strictEqual(report.scan.complete, false);
    const prunedPaths = report.scan.pruned.map((p) => p.path);
    ok(prunedPaths.includes('/r2'), `/r2 was never walked and must be counted: ${JSON.stringify(prunedPaths)}`);
    ok(prunedPaths.includes('/r3'), `/r3 was never walked and must be counted: ${JSON.stringify(prunedPaths)}`);
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('a --skip naming the MARKER itself is honored — the skip decision runs before the marker branch', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'repo', kind: 'dir' }])
      .dir(`${HOME}/repo`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/repo`, [{ name: 'r.json', kind: 'file' }]);
    const report = await run(fs, { skipPaths: [`${HOME}/repo/${CHECKOUT_MARKER}`] });
    strictEqual(report.findings_total, 0, 'the excluded marker must not be inspected');
    strictEqual(report.scan.pruned_by_reason['operator-skip'], 1);
  });

  it('a skip decision the filesystem will not answer BLOCKS rather than reading the subtree', async () => {
    // A skip is a read boundary the operator drew. Resolving "I could not tell"
    // to "read it" walks the subtree they excluded — which may be the sensitive
    // one, or the slow mount the flag existed for (cross-host review).
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'maybe', kind: 'dir' }, { name: 'other', kind: 'dir' }])
      .dir(`${HOME}/maybe`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/maybe`, [{ name: 'r.json', kind: 'file' }])
      .dir(`${HOME}/other`, [])
      .dir('/some/skip', []);
    fs.statErrors.set(`${HOME}/maybe`, 'EIO');
    const report = await run(fs, { skipPaths: ['/some/skip'] });
    strictEqual(report.findings_total, 0, 'the undecidable subtree was not read');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /could not be told apart from an excluded directory/);
  });

  it('the directory cap counts ATTEMPTS, so a tree of fast failures is still bounded', async () => {
    // `dirs_scanned` counts directories that OPENED, so an error-heavy tree was
    // unbounded by this cap — the cap measured the wrong quantity.
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `d${String(i).padStart(3, '0')}`, kind: 'dir' }));
    const fs = new FakeFs().dir(HOME, many);
    for (const e of many) fs.dir(`${HOME}/${e.name}`, []).failOpendir(`${HOME}/${e.name}`, 'EACCES');
    const report = await run(fs, { caps: { maxDirs: 5 } });
    strictEqual(report.scan.stats.dirs_scanned, 1, 'only the root ever opened');
    ok(report.scan.stats.dirs_attempted <= 5 + 1, `attempts must respect the cap, saw ${report.scan.stats.dirs_attempted}`);
    strictEqual(report.scan.complete, false);
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('an unresolvable --skip is BLOCKED — the scan would have walked it', async () => {
    const fs = new FakeFs().dir(HOME, []);
    const report = await run(fs, { skipPaths: ['/no/such/mount'] });
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /--skip target could not be resolved/);
  });

  it('a marker directory is never descended into', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }])
      .dir(`${HOME}/.agentic-plugins`, [{ name: 'huge', kind: 'dir' }])
      .dir(`${HOME}/.agentic-plugins/huge`, []);
    await run(fs);
    strictEqual(fs.yielded.has(`${HOME}/.agentic-plugins`), false, 'the marker subtree was never enumerated');
  });
});

// --- T5: findings model -----------------------------------------------------

describe('legacy-egress discovery — findings model (T5)', () => {
  it('the CURRENT repo legacy dir is a FINDING annotated as already fenced, not an exclusion', async () => {
    const REPO = '/home/op/repo';
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'repo', kind: 'dir' }])
      .dir(REPO, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(REPO, [{ name: 'abc.json', kind: 'file' }]);
    const report = await run(fs, { repoRoot: REPO });
    strictEqual(report.exclusions.length, 0, 'excluding it would be a FALSE clean against follow-ups.md:46');
    strictEqual(report.findings.length, 1);
    strictEqual(report.findings[0].already_fenced_by_current_doctor, true);
    strictEqual(report.overall.status, DISCOVERY_STATUS.findings);
  });

  it('CONTROL — another checkout is a finding with the annotation FALSE', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'other', kind: 'dir' }])
      .dir(`${HOME}/other`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/other`, [{ name: 'abc.json', kind: 'file' }]);
    const report = await run(fs, { repoRoot: '/home/op/repo' });
    strictEqual(report.findings[0].already_fenced_by_current_doctor, false);
  });

  // The three ways a candidate's contents can be incomplete. All of them must
  // reach the SAME place: reported as a location, and no removal instruction
  // anywhere in the output — the operator cannot have reviewed records that were
  // never listed.
  const incompleteCandidates = [
    ['unlistable (EACCES)', (fs) => fs.failOpendir(`${HOME}/x/${WAL_REL}`, 'EACCES')],
    ['vanished between discovery and listing', (fs) => fs.failOpendir(`${HOME}/x/${WAL_REL}`, 'ENOENT')],
    ['listing failed mid-scan', (fs) => fs.failMidScan(`${HOME}/x/${WAL_REL}`, 1, 'EIO')],
  ];
  for (const [label, injure] of incompleteCandidates) {
    it(`an INCOMPLETE candidate (${label}) is reported but receives NO removal instruction`, async () => {
      const fs = new FakeFs()
        .dir(HOME, [{ name: 'x', kind: 'dir' }])
        .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
        .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }, { name: 'b.json', kind: 'file' }]);
      injure(fs);
      const report = await run(fs);
      strictEqual(report.findings_total, 1, 'the LOCATION is still reported — that is what the operator needs');
      strictEqual(report.findings[0].unreadable, true);
      strictEqual(report.findings[0].record_count, null, 'unknown, never a partial count presented as whole');
      // The decisive assertions. The first cut recorded `unreadable` and stopped,
      // leaving the report at findings_present — whose guidance says "manually
      // remove the specific records you reviewed" for a directory that was never
      // listed.
      strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
      ok(report.scan.blocked_total >= 1, 'an unlistable candidate demotes the scan');
      for (const rendered of [renderDiscoveryText(report), renderDiscoveryJson(report)]) {
        strictEqual(rendered.match(REMOVAL_VERBS), null, 'a removal instruction survived an incomplete candidate');
      }
    });
  }

  it('a candidate holding a huge listing is capped on ENTRIES SEEN, not on records kept', async () => {
    // The cap measured `records.length`, so a candidate full of non-`.json`
    // entries was enumerated without bound and without a deadline ever acting.
    const junk = Array.from({ length: 500 }, (_, i) => ({ name: `junk${i}.txt`, kind: 'file' }));
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, junk);
    const report = await run(fs, { caps: { maxEntriesPerDir: 10 } });
    strictEqual(fs.yielded.get(`${HOME}/x/${WAL_REL}`), 11, 'iteration stopped one entry past the cap');
    strictEqual(report.findings[0].unreadable, true);
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('an EMPTY matching directory is reported but does NOT keep the report actionable forever', async () => {
    // It holds nothing that can be in flight, and directory-level action is
    // forbidden — so counting it as actionable meant the operator removed the
    // last record, reran, and was told findings_present about a location with
    // nothing to act on. The workflow could not converge (cross-host review).
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }, { name: 'x', kind: 'dir' }])
      .wal(HOME)
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, []);
    const report = await run(fs);
    strictEqual(report.findings[0].record_count, 0, 'a known zero, not unknown');
    strictEqual(report.findings[0].unreadable, false);
    strictEqual(report.findings_total, 1, 'the location is still reported');
    strictEqual(report.actionable_total, 0);
    strictEqual(report.overall.status, DISCOVERY_STATUS.none, 'nothing to act on means the run converges');
    strictEqual(renderDiscoveryText(report).match(REMOVAL_VERBS), null);
  });

  it('CONTROL — one record in that same directory makes it actionable again', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }, { name: 'x', kind: 'dir' }])
      .wal(HOME)
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.actionable_total, 1);
    strictEqual(report.overall.status, DISCOVERY_STATUS.findings);
  });

  it('a *.json that is a symlink / FIFO / socket / directory is NAMED, never opened', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [
        { name: 'plain.json', kind: 'file' },
        { name: 'linked.json', kind: 'symlink-file' },
        { name: 'pipe.json', kind: 'fifo' },
        { name: 'sock.json', kind: 'socket' },
        { name: 'dir.json', kind: 'dir' },
        { name: 'ignored.txt', kind: 'file' },
      ]);
    const report = await run(fs);
    deepStrictEqual(report.findings[0].records, [
      { name: 'dir.json', kind: 'directory' },
      { name: 'linked.json', kind: 'symlink' },
      { name: 'pipe.json', kind: 'fifo' },
      { name: 'plain.json', kind: 'file' },
      { name: 'sock.json', kind: 'socket' },
    ]);
    strictEqual(report.findings[0].record_count, 5, 'the non-.json entry is not a record');
  });

  it('a candidate that VANISHES between discovery and listing is reported unreadable', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }])
      .failOpendir(`${HOME}/x/${WAL_REL}`, 'ENOENT');
    const report = await run(fs);
    strictEqual(report.findings.length, 1);
    strictEqual(report.findings[0].unreadable, true);
    match(report.findings[0].unreadable_reason, /ENOENT/);
  });

  it('a candidate that changes identity BETWEEN classification and listing is refused, not reported', async () => {
    // The previous round bound the COMPARISON to a captured identity and left
    // the LISTING re-opening the pathname. A component swapped in between means
    // the records enumerated belong to a different directory than the one that
    // was cleared — possibly the live fence, printed with removal wording.
    const WAL = `${HOME}/x/${WAL_REL}`;
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }])
      // First identity observation is the real one; the post-listing check sees
      // a different inode.
      .rebindAfter(WAL, 2, [1, 999999]);
    const report = await run(fs);
    strictEqual(report.findings_total, 0, 'nothing about a directory that moved may be reported');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /changed identity between classification and listing/);
    strictEqual(renderDiscoveryText(report).match(REMOVAL_VERBS), null);
  });

  it('CONTROL — a stable candidate passes the same post-listing check', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.findings_total, 1);
    strictEqual(report.scan.blocked_total, 0);
  });

  it('a symlink at ANY component of the fixed suffix is a boundary, not a dereference', async () => {
    // The previous round made a symlinked MARKER a boundary and stopped there;
    // `runs`, `doctor` and `egress-intents` were still dereferenced. Reproduced
    // on disk: `.agentic-plugins/runs -> /outside` produced an actionable
    // finding outside the requested root with not_followed_total = 0.
    for (const depth of [1, 2, 3]) {
      const prefix = EGRESS_INTENT_DIR_SUFFIX.slice(0, depth).join('/');
      const linkPath = `${HOME}/x/${prefix}`;
      const fs = new FakeFs()
        .dir(HOME, [{ name: 'x', kind: 'dir' }])
        .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
        .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }])
        .dir('/outside', [])
        .wal('/outside', [{ name: 'leak.json', kind: 'file' }])
        .link(linkPath, `/outside/${WAL_REL}`);
      const report = await run(fs);
      strictEqual(report.findings_total, 0, `a symlink at component ${depth} was dereferenced`);
      ok(report.scan.not_followed.some((n) => n.path === linkPath), `component ${depth} was not reported as a boundary`);
    }
  });

  it('an identity the filesystem cannot report exactly is refused, never approximated', async () => {
    // dev/ino above 2^53 collapse as JavaScript Numbers, and the direction that
    // harms is a real legacy directory comparing EQUAL to the live WAL and being
    // dropped from the report.
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }])
      .unsafeIdentity(`${HOME}/x/${WAL_REL}`);
    const report = await run(fs);
    strictEqual(report.findings_total, 0);
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    match(report.scan.blocked.map((b) => b.reason).join(' '), /cannot compare exactly/);
  });

  it('a marker WITHOUT a WAL directory is not a finding', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .dir(`${HOME}/x/.agentic-plugins`, []);
    const report = await run(fs);
    strictEqual(report.findings.length, 0);
    strictEqual(report.scan.blocked_total, 0);
  });

  it('one physical directory reached by two spellings is reported once', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'dir' }])
      .dir(`${HOME}/a`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .dir(`${HOME}/b`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/a`, [{ name: 'r.json', kind: 'file' }])
      .wal(`${HOME}/b`, [{ name: 'r.json', kind: 'file' }]);
    fs.alias(`${HOME}/a/${WAL_REL}`, `${HOME}/b/${WAL_REL}`);
    const report = await run(fs);
    strictEqual(report.findings.length, 1);
  });
});

// --- T6: the guidance contract ---------------------------------------------

describe('legacy-egress discovery — guidance contract (T6)', () => {
  async function blockedReport() {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }, { name: 'y', kind: 'dir' }])
      .dir(`${HOME}/x`, [])
      .dir(`${HOME}/y`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/y`, [{ name: 'a.json', kind: 'file' }])
      .failOpendir(`${HOME}/x`, 'EACCES');
    return run(fs);
  }

  it('NO removal verb appears anywhere — text or json — while blocked is non-empty', async () => {
    const report = await blockedReport();
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    ok(report.findings.length > 0, 'the decisive shape: incomplete WITH findings');
    for (const [format, rendered] of [['text', renderDiscoveryText(report)], ['json', renderDiscoveryJson(report)]]) {
      const hit = rendered.match(REMOVAL_VERBS);
      strictEqual(hit, null, `${format} output contains a removal verb: ${hit?.[0]}`);
    }
  });

  it('CONTROL — a COMPLETE scan with findings DOES carry the removal instruction', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'y', kind: 'dir' }])
      .dir(`${HOME}/y`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/y`, [{ name: 'a.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.overall.status, DISCOVERY_STATUS.findings);
    match(renderDiscoveryText(report), REMOVAL_VERBS);
    // …and it is the reviewed-record wording, not a directory instruction.
    match(report.overall.guidance, /manually remove the specific records you reviewed/);
    match(report.overall.guidance, /directory itself is never the unit to act on/);
  });

  it('no output in ANY state emits a shell command', async () => {
    const reports = [await blockedReport()];
    const clean = new FakeFs().dir(HOME, []);
    reports.push(await run(clean));
    const withFindings = new FakeFs()
      .dir(HOME, [{ name: 'y', kind: 'dir' }])
      .dir(`${HOME}/y`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/y`, [{ name: 'a.json', kind: 'file' }]);
    reports.push(await run(withFindings));
    for (const report of reports) {
      for (const rendered of [renderDiscoveryText(report), renderDiscoveryJson(report)]) {
        strictEqual(rendered.match(SHELL_SHAPE), null, `output emitted a shell command shape in ${report.overall.status}`);
      }
    }
  });

  it('CONTROL — both detectors actually fire on the shapes they forbid', () => {
    // Without this the "no removal verb / no shell command" assertions could be
    // green because the patterns match nothing at all.
    ok(SHELL_SHAPE.test('run: rm -rf /home/op/x/.agentic-plugins'));
    ok(SHELL_SHAPE.test('run: rm /home/op/x/a.json'), 'a bare rm without a flag must be caught');
    ok(SHELL_SHAPE.test('run: $(find ~ -name "*.json")'));
    for (const phrase of ['files were removed', 'Clear the directory now', 'safe to delete', 'this deletes them', 'unlinked the record']) {
      ok(REMOVAL_VERBS.test(phrase), `the removal-verb pattern missed: ${phrase}`);
    }
  });

  it('the guidance is uniform: every finding gets the same possibly-in-flight wording', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }, { name: 'a', kind: 'dir' }, { name: 'b', kind: 'dir' }])
      .wal(HOME)                                    // the live fence exists → no caveat
      .dir(`${HOME}/a`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .dir(`${HOME}/b`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/a`, [{ name: 'a.json', kind: 'file' }])
      .wal(`${HOME}/b`, [{ name: 'b.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.findings.length, 2);
    strictEqual(report.live_wal.state, 'present');
    strictEqual(report.overall.guidance, GUIDANCE.findings, 'one guidance for all locations — not per-record classification');
  });

  it('an ABSENT live fence adds a caveat, because the exclusion may have been decided against the wrong home', async () => {
    // Reproduced before the fix: under an overridden $HOME the real fence became
    // a finding with removal wording and nothing in the report said so. The
    // second reference point stops the misclassification; this caveat is what
    // makes the remaining ambiguity visible.
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'a', kind: 'dir' }])
      .dir(`${HOME}/a`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/a`, [{ name: 'a.json', kind: 'file' }]);
    const report = await run(fs);
    strictEqual(report.live_wal.state, 'absent');
    ok(report.overall.guidance.startsWith(GUIDANCE.findings), 'the base guidance is unchanged');
    match(report.overall.guidance, /No machine-global WAL was found at the locations this scan treated as the live fence/);
    match(renderDiscoveryText(report), /Live fence \(the reference point every exclusion was decided against\)/);
  });

  it('an operator --skip is NAMED in the guidance, not buried in a combined prune total', async () => {
    // The shipped documentation recommended `--skip "$HOME/mnt"`; run verbatim
    // it returned a reassuring status while a real pre-upgrade record sat inside
    // the skipped mount, and the exclusion was one number among 41,833 routine
    // depth-cap prunes.
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }, { name: 'mnt', kind: 'dir' }])
      .wal(HOME)
      .dir(`${HOME}/mnt`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/mnt`, [{ name: 'hidden.json', kind: 'file' }]);
    const report = await run(fs, { skipPaths: [`${HOME}/mnt`] });
    strictEqual(report.overall.status, DISCOVERY_STATUS.none, 'the skip really does hide it — that is the point');
    match(report.overall.guidance, /You excluded 1 location\(s\) with --skip/);
    ok(report.residual.some((r) => /excluded by --skip and were NOT examined/.test(r)),
      'the exclusion has its own residual line, separate from routine prunes');
    // …and it must still carry no removal verb, since nothing was found.
    strictEqual(renderDiscoveryText(report).match(REMOVAL_VERBS), null);
  });
});

// --- T7: defusing -----------------------------------------------------------

describe('legacy-egress discovery — operator-facing text is defused (T7)', () => {
  const EVIL = 'evil[31m\n>>> instruction';

  it('a hostile DIRECTORY name is defused in dir, checkout_root and roots', async () => {
    const fs = new FakeFs()
      .dir(HOME, [{ name: EVIL, kind: 'dir' }])
      .dir(`${HOME}/${EVIL}`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/${EVIL}`, [{ name: 'r.json', kind: 'file' }]);
    const report = await run(fs);
    const finding = report.findings[0];
    for (const field of [finding.dir, finding.checkout_root]) {
      strictEqual(/[ -]/.test(field), false, 'a control character reached an operator-facing field');
    }
    match(finding.dir, /control characters replaced/);
    const text = renderDiscoveryText(report);
    strictEqual(text.split('\n').some((l) => l.startsWith('>>> instruction')), false, 'a forged line reached the rendered output');
  });

  it('EVERY operator-facing field is defused through the scanner, not just record names', async () => {
    // The first version of this test named roots in its title but only inspected
    // finding paths, and checked `safeRecordName` directly rather than through
    // the scanner's wiring — so returning raw roots, raw exclusions, or a raw
    // `entry.name` would all have survived it (cross-host review).
    const fs = new FakeFs()
      .dir(`/root${EVIL}`, [{ name: EVIL, kind: 'dir' }, { name: 'live', kind: 'dir' }, { name: 'bad', kind: 'dir' }])
      .dir(`/root${EVIL}/${EVIL}`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`/root${EVIL}/${EVIL}`, [{ name: `rec${EVIL}.json`, kind: 'file' }])
      .dir(`/root${EVIL}/live`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`/root${EVIL}/live`, [])
      .dir(`/root${EVIL}/bad`, [])
      .failOpendir(`/root${EVIL}/bad`, 'EACCES');
    // Make the `live` candidate the machine-global WAL, so an EXCLUSION path is
    // also produced from attacker-chosen text.
    fs.dir(LIVE_WAL).alias(`/root${EVIL}/live/${WAL_REL}`, LIVE_WAL);

    const report = await run(fs, { requestedRoots: [`/root${EVIL}`], skipPaths: [EVIL] });
    const surfaces = {
      roots: report.roots,
      skips: report.skips,
      blocked: report.scan.blocked,
      not_followed: report.scan.not_followed,
      pruned: report.scan.pruned,
      exclusions: report.exclusions,
      findings: report.findings,
      guidance: report.overall.guidance,
    };
    // Nothing anywhere in the report may carry a raw control character.
    const raw = JSON.stringify(surfaces);
    strictEqual(/\\u001[bB]|\\n/.test(raw), false, `a raw escape or newline survived: ${raw.slice(0, 200)}`);
    ok(report.exclusions.length > 0, 'the exclusion path was actually produced from hostile text');
    ok(report.findings_total > 0, 'the finding path was actually produced from hostile text');
    // …and the rendered text must not gain a forged line.
    strictEqual(renderDiscoveryText(report).split('\n').some((l) => l.startsWith('>>> instruction')), false);
  });

  it('CONTROL — an ordinary path renders EXACTLY, including non-ASCII', () => {
    strictEqual(safeOperatorText('/Users/op/작업/repo'), '/Users/op/작업/repo');
    strictEqual(safeOperatorText('/plain/path'), '/plain/path');
  });

  it('truncation carries a stable hash so two long paths do not render alike', () => {
    const a = `/x/${'a'.repeat(600)}1`;
    const b = `/x/${'a'.repeat(600)}2`;
    notStrictEqual(safeOperatorText(a), safeOperatorText(b));
    match(safeOperatorText(a), /truncated; sha256:[0-9a-f]{12}/);
    strictEqual(safeOperatorText(a), safeOperatorText(a), 'stable across calls');
  });

  it('bidi, zero-width AND Unicode line separators are hazards, not just C0 controls', () => {
    // U+2028/U+2029 are LINE and PARAGRAPH SEPARATOR: not C0, but terminals and
    // log viewers break lines on them, which is the forged-instruction hazard
    // the C0 newline entry exists to stop. They were missing (cross-host review).
    // U+061C, U+2060, U+180E and the interlinear-annotation set render as
    // nothing without being bidi controls or zero-width joiners, so two distinct
    // names look identical to the operator being asked to act on one of them.
    for (const cp of [0x202e, 0x200b, 0x2066, 0xfeff, 0x0a, 0x1b, 0x7f, 0x9b, 0x2028, 0x2029,
      0x061c, 0x2060, 0x180e, 0xfff9, 0xfffa, 0xfffb]) {
      ok(isDisplayHazard(cp), `U+${cp.toString(16).toUpperCase()} must be treated as a display hazard`);
    }
    ok(!isDisplayHazard('a'.codePointAt(0)));
    ok(!isDisplayHazard('작'.codePointAt(0)));
    match(safeOperatorText('a‮b'), /a\?b/);
    for (const sep of [' ', ' ']) {
      strictEqual(safeOperatorText(`a${sep}b`).includes(sep), false, `U+${sep.codePointAt(0).toString(16)} survived safeOperatorText`);
    }
  });

  it('defusing NEVER collapses two distinct inputs, truncated or not', () => {
    // Reproduced: `é.json` and `è.json` both rendered `?.json`, and two paths
    // differing only in a control byte both rendered `/x/a?b`. Neither was
    // truncated, so a hash attached only on truncation did not help — and the
    // guidance asks the operator to act on ONE named record.
    const shortNames = ['é.json', 'è.json'];
    const [ra, rb] = shortNames.map(safeRecordName);
    notStrictEqual(ra, rb, 'two short invalid names must not render identically');
    match(ra, /sha256:[0-9a-f]{12}/, 'a replaced character alone must attach the discriminator');

    const shortPaths = ['/x/ab', '/x/ab'];
    const [pa, pb] = shortPaths.map((p) => safeOperatorText(p));
    notStrictEqual(pa, pb, 'two short paths differing only in a control byte must not render identically');
    match(pa, /sha256:[0-9a-f]{12}/);

    // CONTROL — nothing altered means nothing appended.
    strictEqual(safeOperatorText('/plain/path'), '/plain/path');
    strictEqual(safeRecordName('abc.terminal.json'), 'abc.terminal.json');
  });

  it('safeRecordName TRUNCATION carries the same discriminating hash its sibling does', () => {
    // The record-name defuser cut at 96 characters with no discriminator, so two
    // different long invalid names sharing a prefix rendered identically — and
    // the operator is being asked to act on ONE named record.
    const prefix = `${'x'.repeat(120)}\n`;
    const a = safeRecordName(`${prefix}alpha.json`);
    const b = safeRecordName(`${prefix}beta.json`);
    notStrictEqual(a, b, 'two distinct long names must not render identically');
    match(a, /truncated; sha256:[0-9a-f]{12}/);
    strictEqual(a, safeRecordName(`${prefix}alpha.json`), 'stable across calls');
    // A short invalid name is defused WITHOUT a spurious truncation note.
    strictEqual(/truncated/.test(safeRecordName('bad\nname.json')), false);
  });

  it('safeRecordName is a strict SUPERSET of the shared hazard set', () => {
    // Anything `isDisplayHazard` flags must also be defused by the record-name
    // policy — so the two can never drift below one another.
    for (const cp of [0x1b, 0x0a, 0x202e, 0x200b, 0xfeff, 0x9b]) {
      const name = `a${String.fromCodePoint(cp)}b.json`;
      const shown = safeRecordName(name);
      strictEqual(shown.includes(String.fromCodePoint(cp)), false, `U+${cp.toString(16)} survived safeRecordName`);
      match(shown, /name shown defused/);
    }
    strictEqual(safeRecordName('abc123.terminal.json'), 'abc123.terminal.json');
  });
});

// --- T8: renderers ----------------------------------------------------------

describe('legacy-egress discovery — renderers and exit codes (T8)', () => {
  async function incompleteWithFindings() {
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }, { name: 'y', kind: 'dir' }])
      .dir(`${HOME}/x`, [])
      .dir(`${HOME}/y`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/y`, [{ name: 'a.json', kind: 'file' }])
      .failOpendir(`${HOME}/x`, 'EIO');
    return run(fs);
  }

  it('pins the report top-level keys', async () => {
    const report = await incompleteWithFindings();
    deepStrictEqual(Object.keys(report), [
      'schema_version', 'runtime_version', 'scanned_at', 'host', 'roots', 'skips',
      'scan', 'live_wal', 'exclusions', 'findings', 'findings_total',
      'actionable_total', 'overall', 'residual', 'mutation_boundary',
    ]);
    strictEqual(report.schema_version, LEGACY_EGRESS_DISCOVERY_SCHEMA);
    strictEqual(report.runtime_version, '9.9.9');
    strictEqual(report.scanned_at, '2026-08-06T00:00:00.000Z');
    strictEqual(report.host, 'test-host');
  });

  it('the decisive state — incomplete WITH findings — renders both', async () => {
    const report = await incompleteWithFindings();
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    strictEqual(report.findings.length, 1);
    const text = renderDiscoveryText(report);
    match(text, /overall: incomplete/);
    match(text, /Findings \(1; 1 hold records/);
    match(text, /blocked: 1/);
  });

  it('the mutation boundary is stated in every report', async () => {
    const report = await incompleteWithFindings();
    strictEqual(report.mutation_boundary.writes_allowed, 'none');
    match(renderDiscoveryText(report), /writes: none/);
  });

  it('exit codes map the three statuses distinctly', () => {
    strictEqual(DISCOVERY_EXIT_CODES[DISCOVERY_STATUS.none], 0);
    strictEqual(DISCOVERY_EXIT_CODES[DISCOVERY_STATUS.incomplete], 1);
    strictEqual(DISCOVERY_EXIT_CODES[DISCOVERY_STATUS.findings], 2);
    strictEqual(new Set(Object.values(DISCOVERY_EXIT_CODES)).size, 3);
  });

  it('bucket listings are bounded but their TOTALS are exact and said', async () => {
    const many = Array.from({ length: MAX_REPORTED_PER_BUCKET + 25 }, (_, i) => ({ name: `d${String(i).padStart(3, '0')}`, kind: 'dir' }));
    const fs = new FakeFs().dir(HOME, many);
    for (const e of many) fs.dir(`${HOME}/${e.name}`, []).failOpendir(`${HOME}/${e.name}`, 'EACCES');
    const report = await run(fs);
    strictEqual(report.scan.blocked_total, MAX_REPORTED_PER_BUCKET + 25);
    strictEqual(report.scan.blocked.length, MAX_REPORTED_PER_BUCKET);
    match(renderDiscoveryText(report), /… and 25 more \(listing bounded at 50; the count above is exact\)/);
    // Bounding the DISPLAY must not change the verdict.
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('findings and per-candidate record listings are bounded too, with exact counts', async () => {
    const many = Array.from({ length: MAX_REPORTED_PER_BUCKET + 5 }, (_, i) => ({ name: `c${String(i).padStart(3, '0')}`, kind: 'dir' }));
    const records = Array.from({ length: MAX_REPORTED_PER_BUCKET + 12 }, (_, i) => ({ name: `${String(i).padStart(3, '0')}.json`, kind: 'file' }));
    const fs = new FakeFs().dir(HOME, many);
    for (const e of many) {
      fs.dir(`${HOME}/${e.name}`, [{ name: '.agentic-plugins', kind: 'dir' }]).wal(`${HOME}/${e.name}`, records);
    }
    const report = await run(fs);
    strictEqual(report.findings_total, MAX_REPORTED_PER_BUCKET + 5);
    strictEqual(report.findings.length, MAX_REPORTED_PER_BUCKET);
    strictEqual(report.findings[0].record_count, MAX_REPORTED_PER_BUCKET + 12, 'the count is exact');
    strictEqual(report.findings[0].records.length, MAX_REPORTED_PER_BUCKET, 'the listing is bounded');
    const text = renderDiscoveryText(report);
    match(text, /Findings \(55; 55 hold records/);
    match(text, /… and 12 more \(listing bounded; the count above is exact\)/);
    match(text, /… and 5 more location\(s\)/);
  });

  it('the status is decided from the blocked TOTAL, never from the bounded display list', async () => {
    // With the shipped bound of 50 the two can never disagree in the dangerous
    // direction, so this property was untestable and the first guard written for
    // it was wrong without any test noticing. Setting the bound to 0 produces
    // exactly that disagreement — an empty listing beside a non-zero count — and
    // a report that called it clean would be telling the operator nothing was
    // wrong while it had failed to open a directory.
    const fs = new FakeFs()
      .dir(HOME, [{ name: 'x', kind: 'dir' }])
      .dir(`${HOME}/x`, [])
      .failOpendir(`${HOME}/x`, 'EACCES');
    const report = await run(fs, { caps: { maxReportedPerBucket: 0 } });
    deepStrictEqual(report.scan.blocked, [], 'the display list is empty at this bound');
    strictEqual(report.scan.blocked_total, 1, 'the count is exact regardless of the bound');
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
  });

  it('the status is decided from the FINDINGS total too, not from their bounded display list', async () => {
    // The zero-bound test above uses a BLOCKED fixture, so changing the status
    // call to read the bounded `findings` array instead of the full one survived
    // the whole suite (cross-host review SUGGESTION, named as a concrete
    // surviving edit). This is the findings-shaped mirror of it.
    const fs = new FakeFs()
      .dir(HOME, [{ name: '.agentic-plugins', kind: 'dir' }, { name: 'x', kind: 'dir' }])
      .wal(HOME)
      .dir(`${HOME}/x`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/x`, [{ name: 'a.json', kind: 'file' }]);
    const report = await run(fs, { caps: { maxReportedPerBucket: 0 } });
    deepStrictEqual(report.findings, [], 'the display list is empty at this bound');
    strictEqual(report.findings_total, 1, 'the count is exact regardless of the bound');
    strictEqual(report.overall.status, DISCOVERY_STATUS.findings, 'a bound must never produce a clean status');
  });

  it('a scan that examined NOTHING is not a clean answer', async () => {
    // Reproduced: `--root X --skip X` reported no_findings_in_scanned_scope with
    // complete:true, zero directories examined and exit 0.
    const fs = new FakeFs().dir(HOME, []).dir('/only', []);
    const report = await run(fs, { requestedRoots: ['/only'], skipPaths: ['/only'] });
    strictEqual(report.scan.stats.dirs_scanned, 0);
    strictEqual(report.overall.status, DISCOVERY_STATUS.incomplete);
    strictEqual(DISCOVERY_EXIT_CODES[report.overall.status], 1);
  });

  it('output ordering is deterministic across runs', async () => {
    const build = () => {
      const fs = new FakeFs().dir(HOME, [
        { name: 'c', kind: 'dir' }, { name: 'a', kind: 'dir' }, { name: 'b', kind: 'dir' },
      ]);
      for (const n of ['a', 'b', 'c']) {
        fs.dir(`${HOME}/${n}`, [{ name: '.agentic-plugins', kind: 'dir' }]).wal(`${HOME}/${n}`, []);
      }
      return fs;
    };
    const first = renderDiscoveryJson(await run(build()));
    const second = renderDiscoveryJson(await run(build()));
    strictEqual(first, second);
    const dirs = JSON.parse(first).findings.map((f) => f.dir);
    deepStrictEqual(dirs, [...dirs].sort());
  });

  it('the residual is stated in every format and ALL THREE statuses', async () => {
    // "Every status" previously meant two of the three, and checked one phrase.
    const findingsOnly = new FakeFs()
      .dir(HOME, [{ name: 'y', kind: 'dir' }])
      .dir(`${HOME}/y`, [{ name: '.agentic-plugins', kind: 'dir' }])
      .wal(`${HOME}/y`, [{ name: 'a.json', kind: 'file' }]);
    const byStatus = {
      [DISCOVERY_STATUS.incomplete]: await incompleteWithFindings(),
      [DISCOVERY_STATUS.none]: await run(new FakeFs().dir(HOME, [])),
      [DISCOVERY_STATUS.findings]: await run(findingsOnly),
    };
    deepStrictEqual(
      Object.keys(byStatus).sort(),
      Object.values(DISCOVERY_STATUS).sort(),
      'the fixture set must cover the whole status enum',
    );
    for (const [expected, report] of Object.entries(byStatus)) {
      strictEqual(report.overall.status, expected);
      for (const phrase of [
        /checkouts outside the scanned roots are not covered/,
        /time budget is cooperative/,
        /TOCTOU/,
      ]) {
        match(renderDiscoveryText(report), phrase);
        match(renderDiscoveryJson(report), phrase);
      }
    }
  });
});

// --- additional real-filesystem layer --------------------------------------

// These run against a real temp tree. They are ADDITIONAL to the injected-seam
// coverage above, never a replacement for it: a real permission fixture skips
// under UID 0, so it cannot be the only thing standing between a mutant and a
// green suite.
describe('legacy-egress discovery — real filesystem (additional layer)', () => {
  it('finds another checkout under a real root and leaves nothing behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-egress-real-'));
    const checkout = join(root, 'projects', 'other');
    await mkdir(join(checkout, ...EGRESS_INTENT_DIR_SUFFIX), { recursive: true });
    await writeFile(join(checkout, ...EGRESS_INTENT_DIR_SUFFIX, 'abc.json'), '{}');

    const report = await discoverLegacyEgressIntents({
      requestedRoots: [root],
      homeDir: '/nonexistent-home-for-this-test',
      now: new Date('2026-08-06T00:00:00Z'),
      host: 'test-host',
    });
    strictEqual(report.overall.status, DISCOVERY_STATUS.findings);
    strictEqual(report.findings.length, 1);
    deepStrictEqual(report.findings[0].records, [{ name: 'abc.json', kind: 'file' }]);
    strictEqual(report.mutation_boundary.writes_allowed, 'none');
  });

  it('an empty real root is clean, and says so without claiming machine-wide durability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-egress-empty-'));
    const report = await discoverLegacyEgressIntents({
      requestedRoots: [root],
      homeDir: '/nonexistent-home-for-this-test',
    });
    strictEqual(report.overall.status, DISCOVERY_STATUS.none);
    match(report.overall.guidance, /not a statement about the whole machine/);
  });
});
