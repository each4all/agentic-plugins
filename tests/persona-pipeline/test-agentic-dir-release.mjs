// ADR-0059 Decision 9, items 3 to 5, and Decision 10, item 4 (C175): the
// release removes a directory only on the proof that the CLI made it, claims
// it before it empties it, removes nothing recursively or through a link, and
// reports each other state by a fixed outcome and reason. In process, through
// the module the CLIs call; every directory lives under a test's own TMPDIR.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';

import { tmpDir } from '../_tmp.mjs';
import {
  DIR_MARKER_FILE, OPERATION_TRANSPORT_FILE, OPERATION_TRANSPORT_SCHEMA, RELEASE_EXIT,
  defaultSys, makeDir, releaseDir, releaseLine,
} from '../../persona-pipeline/files/scripts/lib/agentic-dir.mjs';

const err = (code) => Object.assign(new Error(code), { code });

function root(t) {
  return fs.realpathSync(tmpDir(t, 'adir-rel-'));
}

function make(r0, kind = 'text') {
  const made = makeDir({ kind, env: { TMPDIR: r0 } });
  ok(made.ok, JSON.stringify(made));
  return made;
}

const claimedOf = (p) => join(path.dirname(p), `.removing-${path.basename(p)}`);
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function transport(fields = {}) {
  return {
    schema: OPERATION_TRANSPORT_SCHEMA, operation_id: 'op-20261126T000000Z-0123abcd', kind: 'verb',
    macro_id: 'macro-plan-20261120T224328Z-9b3901', subtask_id: 'tmpdir-cli', branch: 'feat/x',
    opened_at: '2026-11-26T00:00:00Z', workflow_id: null, state: 'closed', ...fields,
  };
}

function writeTransport(dir, value) {
  fs.writeFileSync(join(dir, OPERATION_TRANSPORT_FILE), typeof value === 'string' ? value : JSON.stringify(value));
}

function statWith(st, fields) {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, fields);
}

describe('releaseDir — removed and absent (Decision 9, items 4 and 5)', () => {
  it('removes a text directory\'s files, links (never their targets) and its marked op with a bound closed transport', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.writeFileSync(join(text.path, 'note.md'), 'n');
    fs.writeFileSync(join(r0, 'outside'), 'keep');
    fs.symlinkSync(join(r0, 'outside'), join(text.path, 'link'));
    fs.symlinkSync(join(r0, 'nothing'), join(text.path, 'dangling'));
    fs.linkSync(join(r0, 'outside'), join(text.path, 'hard'));
    const op = makeDir({ kind: 'op', parent: text.path });
    fs.writeFileSync(join(op.path, 'prompt.xml'), 'p');
    writeTransport(op.path, transport({ dir_marker_id: op.marker.id }));
    const r = releaseDir(text.path);
    deepStrictEqual(r, { outcome: 'removed', path: text.path });
    strictEqual(RELEASE_EXIT[r.outcome], 0);
    ok(!there(text.path) && !there(claimedOf(text.path)));
    strictEqual(fs.readFileSync(join(r0, 'outside'), 'utf8'), 'keep');
  });

  it('removes an operation directory with no transport, and one whose closed transport names its marker id', (t) => {
    const r0 = root(t);
    const a = make(r0, 'op');
    strictEqual(releaseDir(a.path).outcome, 'removed');
    const b = make(r0, 'op');
    writeTransport(b.path, transport({ dir_marker_id: b.marker.id }));
    strictEqual(releaseDir(b.path).outcome, 'removed');
  });

  it('removes an empty op with no marker under its parent\'s proof', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.mkdirSync(join(text.path, 'op'), { mode: 0o700 });
    strictEqual(releaseDir(text.path).outcome, 'removed');
  });

  it('is idempotent: a second release, by either name, is absent', (t) => {
    const r0 = root(t);
    const text = make(r0);
    strictEqual(releaseDir(text.path).outcome, 'removed');
    deepStrictEqual(releaseDir(text.path), { outcome: 'absent', path: text.path });
    deepStrictEqual(releaseDir(claimedOf(text.path)), { outcome: 'absent', path: claimedOf(text.path), name_exists: false });
  });

  it('judges a .removing- path alone: absent there, and says whether <name> exists', (t) => {
    const r0 = root(t);
    const text = make(r0);
    deepStrictEqual(releaseDir(claimedOf(text.path)), { outcome: 'absent', path: claimedOf(text.path), name_exists: true });
    ok(there(text.path));
  });
});

describe('releaseDir — not-owned: the path, the directory and the marker (Decision 9, item 3)', () => {
  // Enumerable spies over every call the module makes, so the seam really
  // replaces each one; the check is the count, not a thrown sentinel.
  function spySys() {
    const calls = [];
    const sys = { platform: () => 'linux', geteuid: () => 1000 };
    for (const k of Object.keys(defaultSys)) if (!(k in sys)) sys[k] = (...a) => { calls.push(k); return defaultSys[k](...a); };
    return { sys, calls };
  }
  for (const p of ['relative/agentic-text.abcdef', '/a/../agentic-text.abcdef', '/a/./agentic-text.abcdef', '/a//agentic-text.abcdef',
    '/a/agentic-text.abcdef/', '/a/agentic-text.abc', '/a/agentic-args.abcdef', '/a/op', '/a/.removing-op', '']) {
    it(`refuses ${JSON.stringify(p)} as path-form with no file system call`, () => {
      const { sys, calls } = spySys();
      deepStrictEqual(releaseDir(p, { sys }), { outcome: 'not-owned', path: p, reason: 'path-form' });
      deepStrictEqual(calls, []);
    });
  }

  function expectKept(r0, p, reason) {
    const r = releaseDir(p);
    strictEqual(r.outcome, 'not-owned', JSON.stringify(r));
    strictEqual(r.reason, reason);
    ok(RELEASE_EXIT['not-owned'] > 0);
    ok(there(p), 'nothing changed');
    ok(!there(claimedOf(p)), 'no claim');
  }

  it('the spies see the calls of a path that passes the path check', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const { sys, calls } = spySys();
    releaseDir(a.path, { sys: { ...sys, geteuid: () => process.geteuid() } });
    ok(calls.includes('lstat') && calls.includes('rmdir'), calls.join(','));
  });

  it('reports a path a single-quoted literal cannot carry as unsupported, with status 0 and no call', () => {
    const { sys, calls } = spySys();
    for (const p of ["/t/it's/agentic-text.abcdef", '/t/a\nb/agentic-text.abcdef']) {
      deepStrictEqual(releaseDir(p, { sys }), { outcome: 'unsupported', path: p, reason: 'unsupported-path' });
    }
    deepStrictEqual(calls, []);
  });

  it('refuses a directory with no marker (one mktemp -d made)', (t) => {
    const r0 = root(t);
    const legacy = fs.mkdtempSync(join(r0, 'agentic-text.'));
    fs.writeFileSync(join(legacy, 'request.txt'), 'r');
    expectKept(r0, legacy, 'marker-absent');
  });

  it('refuses a marker copied into another directory', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const b = make(r0);
    fs.rmSync(join(b.path, DIR_MARKER_FILE));
    fs.copyFileSync(join(a.path, DIR_MARKER_FILE), join(b.path, DIR_MARKER_FILE));
    expectKept(r0, b.path, 'marker-name');
  });

  it('refuses a directory moved to another name or another parent', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const renamed = join(r0, 'agentic-text.Moved0');
    fs.renameSync(a.path, renamed);
    expectKept(r0, renamed, 'marker-name');
    const b = make(r0);
    fs.mkdirSync(join(r0, 'elsewhere'));
    const moved = join(r0, 'elsewhere', path.basename(b.path));
    fs.renameSync(b.path, moved);
    expectKept(r0, moved, 'marker-parent');
  });

  it('refuses a directory whose root was renamed since the make (same device and inode, another path)', (t) => {
    const r0 = root(t);
    fs.mkdirSync(join(r0, 'rootA'));
    const a = makeDir({ kind: 'text', env: { TMPDIR: join(r0, 'rootA') } });
    fs.renameSync(join(r0, 'rootA'), join(r0, 'rootB'));
    expectKept(r0, join(r0, 'rootB', path.basename(a.path)), 'marker-parent');
  });

  it('refuses a marker replaced between its lstat and its open', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const marker = join(a.path, DIR_MARKER_FILE);
    const sys = {
      fstat: (fd) => {
        const st = defaultSys.fstat(fd);
        return st.ino === fs.lstatSync(marker, { bigint: true }).ino ? statWith(st, { ino: st.ino + 1n }) : st;
      },
    };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'not-owned');
    strictEqual(r.reason, 'marker-replaced');
    ok(there(a.path));
  });

  it('refuses a marker whose recorded identity is not the directory\'s', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, DIR_MARKER_FILE), JSON.stringify({ ...a.marker, ino: '1' }));
    expectKept(r0, a.path, 'marker-identity');
  });

  it('refuses a path through a linked ancestor that resolves to the same root', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.symlinkSync(r0, join(r0, 'via'));
    const r = releaseDir(join(r0, 'via', path.basename(a.path)));
    strictEqual(r.outcome, 'not-owned');
    strictEqual(r.reason, 'parent-path');
    ok(there(a.path));
  });

  it('refuses a link where the directory is expected', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const link = join(r0, 'agentic-text.Linked');
    fs.symlinkSync(a.path, link);
    expectKept(r0, link, 'symlink');
    ok(there(join(a.path, DIR_MARKER_FILE)));
  });

  for (const [label, prep, reason] of [
    ['a marker with a second link', (d, r0) => fs.linkSync(join(d, DIR_MARKER_FILE), join(r0, 'second')), 'marker-nlink'],
    ['a marker larger than 64 KiB', (d) => fs.appendFileSync(join(d, DIR_MARKER_FILE), ' '.repeat(70 * 1024)), 'marker-size'],
    ['a marker that is a link', (d, r0) => { fs.renameSync(join(d, DIR_MARKER_FILE), join(r0, 'm')); fs.symlinkSync(join(r0, 'm'), join(d, DIR_MARKER_FILE)); }, 'marker-not-regular'],
    ['a marker that does not parse', (d) => fs.writeFileSync(join(d, DIR_MARKER_FILE), '{'), 'marker-parse'],
    ['a marker of another schema', (d) => fs.writeFileSync(join(d, DIR_MARKER_FILE), '{"schema":"x"}'), 'marker-schema'],
  ]) {
    it(`refuses ${label}`, (t) => {
      const r0 = root(t);
      const a = make(r0);
      prep(a.path, r0);
      expectKept(r0, a.path, reason);
    });
  }

  it('refuses a marker that grows past 64 KiB between its lstat and its read', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const sys = { read: (fd, buf, off, len) => { buf.fill(0x20, off, off + len); return len; } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'not-owned');
    strictEqual(r.reason, 'marker-size');
  });

  it('refuses a marker that gains a link between its lstat and its open', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const sys = { fstat: (fd) => { const st = defaultSys.fstat(fd); return st.isFile() ? statWith(st, { nlink: 2n }) : st; } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.reason, 'marker-nlink');
    ok(there(a.path));
  });

  it('opens each control file without following a link', (t) => {
    const r0 = root(t);
    const op = make(r0, 'op');
    writeTransport(op.path, transport({ dir_marker_id: op.marker.id }));
    const flags = [];
    const sys = { open: (p, f, m) => { flags.push([path.basename(p), f]); return defaultSys.open(p, f, m); } };
    strictEqual(releaseDir(op.path, { sys }).outcome, 'removed');
    ok(flags.length >= 3, JSON.stringify(flags));
    ok(flags.every(([, f]) => (f & fs.constants.O_NOFOLLOW) !== 0));
  });

  it('refuses a marker with a made_at that is no time', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, DIR_MARKER_FILE), JSON.stringify({ ...a.marker, made_at: 'later' }));
    expectKept(r0, a.path, 'marker-schema');
  });

  it('refuses a directory of another owner', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const r = releaseDir(a.path, { sys: { geteuid: () => process.geteuid() + 1 } });
    strictEqual(r.outcome, 'not-owned');
    strictEqual(r.reason, 'uid');
  });

  // The directory's own owner is the guard against a marker another user
  // forged with this uid: the effective uid and the marker stay this user's,
  // and only the directory's lstat, at either of its paths, names another.
  it('refuses a directory another user owns even with a marker naming this uid, keeping it whole', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'payload.txt'), 'p');
    const targets = new Set([a.path, claimedOf(a.path)]);
    const sys = {
      lstat: (p) => {
        const st = defaultSys.lstat(p);
        return targets.has(p) && st.isDirectory() ? statWith(st, { uid: st.uid + 1n }) : st;
      },
    };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'not-owned');
    strictEqual(r.reason, 'uid');
    ok(there(join(a.path, 'payload.txt')) && there(join(a.path, DIR_MARKER_FILE)) && !there(claimedOf(a.path)));
  });

  it('reports a marker that cannot be read as error, changing nothing', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const sys = { open: (p, ...x) => { if (p.endsWith(DIR_MARKER_FILE)) throw err('EACCES'); return defaultSys.open(p, ...x); } };
    const r = releaseDir(a.path, { sys });
    deepStrictEqual(r, { outcome: 'error', path: a.path, reason: 'marker-read', code: 'EACCES' });
    ok(there(a.path) && !there(claimedOf(a.path)));
  });

  it('gives the .removing- sibling with a not-owned <name> a late writer recreated', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.renameSync(a.path, claimedOf(a.path));
    fs.mkdirSync(a.path);
    fs.writeFileSync(join(a.path, 'late.txt'), 'x');
    deepStrictEqual(releaseDir(a.path), { outcome: 'not-owned', path: a.path, reason: 'marker-absent', removing_path: claimedOf(a.path) });
  });
});

describe('releaseDir — refused: the entries and the operation (Decision 9, item 3)', () => {
  function expectRefused(p, reason, entry) {
    const r = releaseDir(p);
    strictEqual(r.outcome, 'refused', JSON.stringify(r));
    strictEqual(r.reason, reason);
    if (entry !== undefined) strictEqual(r.entry, entry);
    strictEqual(r.path, p);
    ok(there(join(p, DIR_MARKER_FILE)), 'put back at its old name');
    ok(!there(claimedOf(p)), 'no placeholder left');
  }

  it('refuses another directory in a text directory, and any directory in an operation directory', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.mkdirSync(join(text.path, 'sub'));
    expectRefused(text.path, 'entry', 'sub');
    const op = make(r0, 'op');
    fs.mkdirSync(join(op.path, 'op'));
    expectRefused(op.path, 'entry', 'op');
  });

  it('refuses an entry whose name is not UTF-8, at the top and in op, and unlinks nothing', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'plain'), 'p');
    fs.writeFileSync(Buffer.concat([Buffer.from(`${a.path}/`), Buffer.from([0x61, 0xff])]), 'x');
    expectRefused(a.path, 'entry-name');
    ok(there(join(a.path, 'plain')));
    const b = make(r0);
    const op = makeDir({ kind: 'op', parent: b.path });
    fs.writeFileSync(Buffer.concat([Buffer.from(`${op.path}/`), Buffer.from([0xc3, 0x28])]), 'x');
    expectRefused(b.path, 'op-entry-name');
  });

  it('removes an empty op with no marker whatever its owner, on its parent\'s proof', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.mkdirSync(join(text.path, 'op'));
    const sys = { lstat: (p) => { const st = defaultSys.lstat(p); return path.basename(p) === 'op' ? statWith(st, { uid: st.uid + 1n }) : st; } };
    strictEqual(releaseDir(text.path, { sys }).outcome, 'removed');
  });

  it('refuses an op whose marker is invalid even when op cannot be listed', (t) => {
    const r0 = root(t);
    const text = make(r0);
    const op = makeDir({ kind: 'op', parent: text.path });
    fs.writeFileSync(join(op.path, DIR_MARKER_FILE), '{');
    const sys = { readdir: (p) => { if (path.basename(p) === 'op') throw err('EACCES'); return defaultSys.readdir(p); } };
    const r = releaseDir(text.path, { sys });
    strictEqual(r.outcome, 'refused');
    strictEqual(r.reason, 'op-marker-parse');
  });

  it('refuses a non-empty op with no marker (an older runbook\'s mkdir, written into)', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.mkdirSync(join(text.path, 'op'));
    fs.writeFileSync(join(text.path, 'op', 'operation.json'), '{}');
    expectRefused(text.path, 'op-unmarked');
  });

  it('refuses a directory below op, and an op whose transport is unbound', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const opA = makeDir({ kind: 'op', parent: a.path });
    fs.mkdirSync(join(opA.path, 'deeper'));
    expectRefused(a.path, 'op-entry', 'op/deeper');
    const b = make(r0);
    const opB = makeDir({ kind: 'op', parent: b.path });
    writeTransport(opB.path, transport());
    expectRefused(b.path, 'operation-unbound');
  });

  it('refuses an op whose marker names another parent', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const b = make(r0);
    const opA = makeDir({ kind: 'op', parent: a.path });
    fs.writeFileSync(join(opA.path, 'x'), 'x');
    fs.renameSync(opA.path, join(b.path, 'op'));
    expectRefused(b.path, 'op-marker-parent');
  });

  for (const [label, value, reason] of [
    ['open', (id) => transport({ state: 'open', dir_marker_id: id }), 'operation-not-closed'],
    ['opening', (id) => transport({ state: 'opening', dir_marker_id: id }), 'operation-not-closed'],
    ['closed with no marker id (an older state.mjs)', () => transport(), 'operation-unbound'],
    ['closed with another directory\'s id', () => transport({ dir_marker_id: 'c'.repeat(32) }), 'operation-unbound'],
    ['malformed', () => '{"schema":"other"}', 'operation-malformed'],
    ['not JSON', () => 'nope', 'operation-parse'],
    // holds.mjs reads with JSON.parse, which refuses a byte order mark; the
    // release must not accept what the workflow's reader refuses.
    ['a bound closed record behind a byte order mark', (id) => `\ufeff${JSON.stringify(transport({ dir_marker_id: id }))}`, 'operation-parse'],
  ]) {
    it(`refuses an operation directory whose transport is ${label}`, (t) => {
      const r0 = root(t);
      const op = make(r0, 'op');
      writeTransport(op.path, value(op.marker.id));
      expectRefused(op.path, reason);
    });
  }

  it('refuses a transport that is a link, and reports one that cannot be read as error', (t) => {
    const r0 = root(t);
    const op = make(r0, 'op');
    fs.writeFileSync(join(r0, 't.json'), JSON.stringify(transport({ dir_marker_id: op.marker.id })));
    fs.symlinkSync(join(r0, 't.json'), join(op.path, OPERATION_TRANSPORT_FILE));
    expectRefused(op.path, 'operation-not-regular');
    fs.rmSync(join(op.path, OPERATION_TRANSPORT_FILE));
    writeTransport(op.path, transport({ dir_marker_id: op.marker.id }));
    const sys = { open: (p, ...x) => { if (p.endsWith(OPERATION_TRANSPORT_FILE)) throw err('EIO'); return defaultSys.open(p, ...x); } };
    const r = releaseDir(op.path, { sys });
    deepStrictEqual(r, { outcome: 'error', path: op.path, reason: 'operation-read', code: 'EIO' });
    ok(there(join(op.path, DIR_MARKER_FILE)) && !there(claimedOf(op.path)));
  });
});

describe('releaseDir — the claim (Decision 9, item 4)', () => {
  it('meets contention when .removing-<name> is there, and changes nothing', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.mkdirSync(claimedOf(a.path));
    deepStrictEqual(releaseDir(a.path), { outcome: 'contention', path: a.path, reason: 'removing-exists', removing_path: claimedOf(a.path) });
    ok(there(join(a.path, DIR_MARKER_FILE)));
    deepStrictEqual(fs.readdirSync(claimedOf(a.path)), []);
  });

  it('reports a claim mkdir that fails other than EEXIST as error', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const r = releaseDir(a.path, { sys: { mkdir: () => { throw err('EACCES'); } } });
    deepStrictEqual(r, { outcome: 'error', path: a.path, reason: 'claim-mkdir', code: 'EACCES' });
  });

  it('removes its placeholder when the rename fails, and reports error, or contention when <name> went', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const r = releaseDir(a.path, { sys: { rename: () => { throw err('EIO'); } } });
    deepStrictEqual(r, { outcome: 'error', path: a.path, reason: 'claim-rename', code: 'EIO' });
    ok(!there(claimedOf(a.path)) && there(a.path));
    const moved = join(r0, 'moved');
    const g = releaseDir(a.path, { sys: { rename: (from) => { fs.renameSync(from, moved); throw err('ENOENT'); } } });
    deepStrictEqual(g, { outcome: 'contention', path: a.path, reason: 'gone-before-claim', code: 'ENOENT' });
    ok(!there(claimedOf(a.path)));
  });

  it('names the placeholder it could not remove after a failed rename', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const r = releaseDir(a.path, { sys: { rename: () => { throw err('EIO'); }, rmdir: () => { throw err('EBUSY'); } } });
    deepStrictEqual(r.placeholder_left, { path: claimedOf(a.path), code: 'EBUSY' });
  });

  it('reports a vanished original with a placeholder it could not remove: contention, both named', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const sys = { rename: (from) => { fs.renameSync(from, join(r0, 'moved')); throw err('ENOENT'); }, rmdir: () => { throw err('EBUSY'); } };
    const r = releaseDir(a.path, { sys });
    deepStrictEqual(r, {
      outcome: 'contention', reason: 'gone-before-claim', path: a.path, code: 'ENOENT',
      placeholder_left: { path: claimedOf(a.path), code: 'EBUSY' }, removing_path: claimedOf(a.path),
    });
    ok(!there(a.path) && there(claimedOf(a.path)));
    ok(releaseLine(r).includes('placeholder is left at'), releaseLine(r));
    ok(!releaseLine(r).includes('kept at'));
  });

  it('leaves a directory whose checks fail after its own claim at .removing-, claimed and unproven', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const claimed = claimedOf(a.path);
    const sys = {
      lstat: (p) => {
        const st = defaultSys.lstat(p);
        return p === claimed && st.isDirectory() && fs.readdirSync(p).length ? statWith(st, { uid: st.uid + 1n }) : st;
      },
    };
    deepStrictEqual(releaseDir(a.path, { sys }), { outcome: 'claimed', path: claimed, check: 'uid', not_back: 'unproven' });
    ok(there(join(claimed, DIR_MARKER_FILE)) && !there(a.path));
  });

  it('reports a marker that cannot be read after its own claim as claimed, not error', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const claimed = claimedOf(a.path);
    const sys = { open: (p, ...x) => { if (p === join(claimed, DIR_MARKER_FILE)) throw err('EIO'); return defaultSys.open(p, ...x); } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'claimed');
    strictEqual(r.check, 'marker-read');
    strictEqual(r.not_back, 'unproven');
  });

  it('keeps the failed read\'s code when an unreadable transport cannot go back', (t) => {
    const r0 = root(t);
    const op = make(r0, 'op');
    writeTransport(op.path, transport({ dir_marker_id: op.marker.id }));
    let mkdirs = 0;
    const sys = {
      open: (p, ...x) => { if (p.endsWith(OPERATION_TRANSPORT_FILE)) throw err('EIO'); return defaultSys.open(p, ...x); },
      mkdir: (p, m) => { mkdirs += 1; if (mkdirs === 2) throw err('EACCES'); defaultSys.mkdir(p, m); },
    };
    deepStrictEqual(releaseDir(op.path, { sys }), {
      outcome: 'claimed', path: claimedOf(op.path), check: 'operation-read', check_code: 'EIO', not_back: 'EACCES',
    });
    ok(!there(op.path) && there(join(claimedOf(op.path), OPERATION_TRANSPORT_FILE)));
  });

  it('says the claimed directory is gone when the recheck finds nothing', () => {
    ok(releaseLine({ outcome: 'claimed', path: '/t/.removing-agentic-text.abcdef', check: 'gone', not_back: 'unproven' }).includes('no longer at'));
  });

  it('reports claimed when a refused directory cannot go back: its name taken, or the rename failing', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.mkdirSync(join(a.path, 'sub'));
    let mkdirs = 0;
    const taken = { mkdir: (p, m) => { mkdirs += 1; if (mkdirs === 2) throw err('EEXIST'); defaultSys.mkdir(p, m); } };
    deepStrictEqual(releaseDir(a.path, { sys: taken }), { outcome: 'claimed', path: claimedOf(a.path), check: 'entry', entry: 'sub', not_back: 'name-taken' });
    fs.renameSync(claimedOf(a.path), a.path);
    let renames = 0;
    const failing = { rename: (x, y) => { renames += 1; if (renames === 2) throw err('EIO'); defaultSys.rename(x, y); } };
    deepStrictEqual(releaseDir(a.path, { sys: failing }), { outcome: 'claimed', path: claimedOf(a.path), check: 'entry', entry: 'sub', not_back: 'EIO' });
    ok(!there(a.path), 'the placeholder it could not fill is removed');
    fs.renameSync(claimedOf(a.path), a.path);
    renames = 0;
    const stuck = { ...failing, rmdir: (p) => { if (p === a.path) throw err('EBUSY'); defaultSys.rmdir(p); } };
    const r = releaseDir(a.path, { sys: stuck });
    deepStrictEqual(r.placeholder_left, { path: a.path, code: 'EBUSY' });
  });
});

describe('releaseDir — finishing a claimed directory (Decision 9, item 4)', () => {
  it('finishes a directory left at .removing-, given either name, and never renames it', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'x'), 'x');
    fs.renameSync(a.path, claimedOf(a.path));
    deepStrictEqual(releaseDir(a.path), { outcome: 'removed', path: a.path });
    const b = make(r0);
    fs.renameSync(b.path, claimedOf(b.path));
    deepStrictEqual(releaseDir(claimedOf(b.path)), { outcome: 'removed', path: claimedOf(b.path) });
  });

  it('leaves a refused claimed directory at its .removing- path', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.mkdirSync(join(a.path, 'sub'));
    fs.renameSync(a.path, claimedOf(a.path));
    deepStrictEqual(releaseDir(a.path), { outcome: 'refused', reason: 'entry', entry: 'sub', path: claimedOf(a.path), finisher: true });
    ok(there(claimedOf(a.path)) && !there(a.path));
  });

  it('reports a finisher\'s lookup that fails as error with its code', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.renameSync(a.path, claimedOf(a.path));
    const sys = { lstat: (p) => { if (p === claimedOf(a.path)) throw err('EACCES'); return defaultSys.lstat(p); } };
    deepStrictEqual(releaseDir(a.path, { sys }), { outcome: 'error', path: a.path, reason: 'lookup', code: 'EACCES' });
  });

  it('refuses a .removing- directory with no marker (a kill after the claim\'s mkdir) as not-owned', (t) => {
    const r0 = root(t);
    const p = join(r0, '.removing-agentic-text.Killed');
    fs.mkdirSync(p);
    deepStrictEqual(releaseDir(p), { outcome: 'not-owned', path: p, reason: 'marker-absent', finisher: true });
    ok(there(p));
  });
});

describe('releaseDir — partial (Decision 9, item 5)', () => {
  it('keeps the marker while an entry stays, and a later release finishes under the same proof', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'keep'), 'k');
    fs.writeFileSync(join(a.path, 'go'), 'g');
    const sys = { unlink: (p) => { if (p.endsWith('/keep')) throw err('EACCES'); defaultSys.unlink(p); } };
    const r = releaseDir(a.path, { sys });
    deepStrictEqual(r, {
      outcome: 'partial', path: claimedOf(a.path), unlinked: ['go'], gone: [], kept: [{ name: 'keep', code: 'EACCES' }],
      unlisted: false, marker_remains: true, found: ['keep'],
    });
    ok(RELEASE_EXIT.partial > 0);
    deepStrictEqual(releaseDir(a.path), { outcome: 'removed', path: a.path });
  });

  it('never descends into an op put in place of the proven one before the removal', (t) => {
    const r0 = root(t);
    const a = make(r0);
    makeDir({ kind: 'op', parent: a.path });
    const claimed = claimedOf(a.path);
    let lists = 0;
    const sys = {
      readdir: (p) => {
        if (p === claimed) {
          lists += 1;
          if (lists === 2) {
            fs.renameSync(join(claimed, 'op'), join(r0, 'old-op'));
            fs.mkdirSync(join(claimed, 'op'));
            fs.writeFileSync(join(claimed, 'op', 'other'), 'o');
          }
        }
        return defaultSys.readdir(p);
      },
    };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'partial');
    deepStrictEqual(r.kept, [{ name: 'op', code: 'ECHANGED' }]);
    strictEqual(fs.readFileSync(join(claimed, 'op', 'other'), 'utf8'), 'o');
  });

  it('keeps the marker when an entry appears at the relist', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const claimed = claimedOf(a.path);
    let lists = 0;
    const sys = { readdir: (p) => { if (p === claimed) { lists += 1; if (lists === 3) fs.writeFileSync(join(claimed, 'late'), 'l'); } return defaultSys.readdir(p); } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'partial');
    strictEqual(r.marker_remains, true);
    deepStrictEqual(r.found, ['late']);
  });

  it('reports a relist that fails as unlisted, the marker kept', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const claimed = claimedOf(a.path);
    let lists = 0;
    const sys = { readdir: (p) => { if (p === claimed) { lists += 1; if (lists === 3) throw err('EIO'); } return defaultSys.readdir(p); } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'partial');
    strictEqual(r.unlisted, true);
    strictEqual(r.marker_remains, true);
    ok(there(join(claimed, DIR_MARKER_FILE)));
  });

  it('says the marker is gone when the last rmdir fails after it', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const claimed = claimedOf(a.path);
    const sys = { rmdir: (p) => { if (p === claimed) throw err('EBUSY'); defaultSys.rmdir(p); } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'partial');
    strictEqual(r.marker_remains, false);
    strictEqual(r.code, 'EBUSY');
    deepStrictEqual(r.found, []);
    strictEqual(r.unlisted, false);
  });

  it('says so when the listing after a failed last rmdir fails too', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const claimed = claimedOf(a.path);
    let failed = false;
    const sys = {
      rmdir: (p) => { if (p === claimed) { failed = true; throw err('EBUSY'); } defaultSys.rmdir(p); },
      readdir: (p) => { if (failed && p === claimed) throw err('EIO'); return defaultSys.readdir(p); },
    };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'partial');
    strictEqual(r.marker_remains, false);
    strictEqual(r.unlisted, true);
    ok(!('found' in r));
  });

  it('reports a failure inside op as partial, the op and both markers kept', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const op = makeDir({ kind: 'op', parent: a.path });
    fs.writeFileSync(join(op.path, 'stuck'), 's');
    const sys = { unlink: (p) => { if (p.endsWith('/op/stuck')) throw err('EPERM'); defaultSys.unlink(p); } };
    const r = releaseDir(a.path, { sys });
    strictEqual(r.outcome, 'partial');
    deepStrictEqual(r.kept, [{ name: 'op/stuck', code: 'EPERM' }]);
    strictEqual(r.marker_remains, true);
    ok(there(join(claimedOf(a.path), 'op', DIR_MARKER_FILE)));
  });
});

describe('releaseDir — platforms and the report line (Decision 10, item 4)', () => {
  for (const sys of [{ platform: () => 'win32' }, { geteuid: () => undefined }]) {
    it(`reports unsupported with status 0 and changes nothing (${Object.keys(sys)[0]})`, (t) => {
      const r0 = root(t);
      const a = make(r0);
      const r = releaseDir(a.path, { sys });
      strictEqual(r.outcome, 'unsupported');
      strictEqual(RELEASE_EXIT.unsupported, 0);
      ok(there(a.path));
    });
  }

  it('gives each non-zero outcome its own status', () => {
    const codes = ['not-owned', 'refused', 'contention', 'error', 'claimed', 'partial'].map((o) => RELEASE_EXIT[o]);
    ok(codes.every((c) => Number.isInteger(c) && c > 2));
    strictEqual(new Set(codes).size, codes.length);
  });

  it('prints nothing for removed, absent and unsupported, and one escaped line otherwise, never a rerun', () => {
    for (const outcome of ['removed', 'absent', 'unsupported']) strictEqual(releaseLine({ outcome, path: '/x' }), null);
    const kept = releaseLine({ outcome: 'refused', reason: 'entry', path: '/t/agentic-text.a\nb' });
    ok(kept.includes('kept at "/t/agentic-text.a\\nb"'), kept);
    ok(!kept.includes('\n'));
    ok(releaseLine({ outcome: 'claimed', path: '/t/.removing-agentic-text.abcdef', check: 'uid' }).includes('(uid failed)'));
    ok(releaseLine({ outcome: 'partial', path: '/p', marker_remains: false }).includes('marker is gone'));
    ok(releaseLine({ outcome: 'partial', path: '/p', unlinked: [], marker_remains: true }).includes('(0 entries unlinked)'));
    ok(releaseLine({ outcome: 'partial', path: '/p', marker_remains: true }).includes('marker remains'));
    for (const o of ['not-owned', 'refused', 'contention', 'error', 'claimed', 'partial']) {
      ok(!/rerun|run (it|the release|this block) again/i.test(releaseLine({ outcome: o, path: '/p', check: 'x' })));
    }
  });
});

describe('releaseDir — what the proof of a nested op covers, and what a report names', () => {
  it('an empty op with no marker that gains a file before the removal is only rmdir\'d: the file stays, partial', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.mkdirSync(join(text.path, 'op'), { mode: 0o700 });
    // The contents check lists op empty; a file lands in it before the
    // removal reaches it.
    let written = false;
    const sys = {
      readdir: (p) => {
        const names = defaultSys.readdir(p);
        if (p === join(claimedOf(text.path), 'op') && !written) { written = true; fs.writeFileSync(join(p, 'late'), 'l'); }
        return names;
      },
    };
    const r = releaseDir(text.path, { sys });
    strictEqual(r.outcome, 'partial');
    deepStrictEqual(r.kept.map((k) => k.name), ['op']);
    ok(there(join(claimedOf(text.path), 'op', 'late')));
  });

  it('a nested rmdir that fails after the nested marker went names that marker as unlinked', (t) => {
    const r0 = root(t);
    const text = make(r0);
    const op = makeDir({ kind: 'op', parent: text.path });
    fs.writeFileSync(join(op.path, 'prompt.xml'), 'p');
    const nested = join(claimedOf(text.path), 'op');
    const sys = { rmdir: (p) => { if (p === nested) throw err('EBUSY'); return defaultSys.rmdir(p); } };
    const r = releaseDir(text.path, { sys });
    strictEqual(r.outcome, 'partial');
    deepStrictEqual(r.unlinked, ['op/prompt.xml', `op/${DIR_MARKER_FILE}`]);
    deepStrictEqual(r.kept, [{ name: 'op', code: 'EBUSY' }]);
  });

  it('a .removing- path with nothing there whose <name> cannot be looked up is an error, not absent', (t) => {
    const r0 = root(t);
    const text = make(r0);
    const sys = { lstat: (p) => { if (p === text.path) throw err('EACCES'); return defaultSys.lstat(p); } };
    const r = releaseDir(claimedOf(text.path), { sys });
    deepStrictEqual(r, { outcome: 'error', path: claimedOf(text.path), reason: 'name-lookup', code: 'EACCES' });
    strictEqual(RELEASE_EXIT[r.outcome], 13);
  });
});
