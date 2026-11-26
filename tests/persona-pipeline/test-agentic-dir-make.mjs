// ADR-0059 Decision 9, item 2 and Decision 10, items 1 and 4 (C175): the CLI
// makes a runbook's text and operation directories and marks them, and fails
// closed, printing no path, wherever the release could not prove what it made.
// In process, through the module the CLIs call; every directory is made under
// a test's own TMPDIR, passed explicitly, never under the real /tmp.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';
import {
  DIR_MARKER_FILE, DIR_MARKER_SCHEMA, MACRO_ID_RE, OPERATION_ID_RE, OPERATION_TRANSPORT_FILE,
  OPERATION_TRANSPORT_SCHEMA, SUBTASK_ID_RE, defaultSys, makeDir, validateOperationTransport,
} from '../../persona-pipeline/files/scripts/lib/agentic-dir.mjs';
import * as holds from '../../persona-pipeline/files/scripts/lib/holds.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function root(t) {
  return fs.realpathSync(tmpDir(t, 'adir-make-'));
}

function readMarker(dir) {
  return JSON.parse(fs.readFileSync(join(dir, DIR_MARKER_FILE), 'utf8'));
}

// A copy of a stat whose fields the test overrides; its methods read the
// copy's own mode.
function statWith(st, fields) {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, fields);
}

const err = (code) => Object.assign(new Error(code), { code });

describe('makeDir — a top-level directory (Decision 9, item 2)', () => {
  for (const [kind, prefix] of [['text', 'agentic-text.'], ['op', 'agentic-op.']]) {
    it(`makes an ${prefix}<suffix> directory, mode 0700, with its whole marker and no aside`, (t) => {
      const r0 = root(t);
      const made = makeDir({ kind, env: { TMPDIR: r0 } });
      strictEqual(made.ok, true, JSON.stringify(made));
      strictEqual(path.dirname(made.path), r0);
      ok(new RegExp(`^${prefix.replace('.', '\\.')}[A-Za-z0-9]{6,}$`).test(path.basename(made.path)), made.path);
      const st = fs.lstatSync(made.path, { bigint: true });
      strictEqual(st.mode & 0o777n, 0o700n);
      deepStrictEqual(fs.readdirSync(made.path), [DIR_MARKER_FILE]);
      const rst = fs.statSync(r0, { bigint: true });
      const m = readMarker(made.path);
      deepStrictEqual(m, {
        schema: DIR_MARKER_SCHEMA, kind, id: m.id, name: path.basename(made.path),
        dev: String(st.dev), ino: String(st.ino), uid: process.geteuid(), made_at: m.made_at,
        parent: { path: r0, dev: String(rst.dev), ino: String(rst.ino) },
      });
      ok(/^[0-9a-f]{32}$/.test(m.id), 'a 128-bit id');
      deepStrictEqual(made.marker, m);
    });
  }

  it('draws a fresh id and suffix for each directory', (t) => {
    const r0 = root(t);
    const a = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const b = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    ok(a.path !== b.path);
    ok(a.marker.id !== b.marker.id);
  });

  it('prints the canonical path when TMPDIR is reached through a link', (t) => {
    const r0 = root(t);
    fs.mkdirSync(join(r0, 'real'));
    fs.symlinkSync(join(r0, 'real'), join(r0, 'link'));
    const made = makeDir({ kind: 'text', env: { TMPDIR: join(r0, 'link') } });
    strictEqual(made.ok, true);
    strictEqual(path.dirname(made.path), join(r0, 'real'));
    strictEqual(readMarker(made.path).parent.path, join(r0, 'real'));
  });

  it('makes under /tmp only when TMPDIR is unset', (t) => {
    const tried = [];
    const sys = { mkdir: (p) => { tried.push(p); throw err('EACCES'); } };
    const made = makeDir({ kind: 'text', env: {}, sys });
    deepStrictEqual(made, { ok: false, reason: 'error', code: 'EACCES' });
    strictEqual(path.dirname(tried[0]), fs.realpathSync('/tmp'));
  });

  for (const [label, value] of [['empty', ''], ['relative', 'tmp'], ['missing', null], ['a file', 'FILE']]) {
    it(`fails with tmpdir-unusable for a TMPDIR that is ${label}, with no fallback and nothing made`, (t) => {
      const r0 = root(t);
      fs.writeFileSync(join(r0, 'file'), 'x');
      const TMPDIR = value === null ? join(r0, 'nope') : value === 'FILE' ? join(r0, 'file') : value;
      let mkdirs = 0;
      const made = makeDir({ kind: 'text', env: { TMPDIR }, sys: { mkdir: () => { mkdirs += 1; } } });
      strictEqual(made.ok, false);
      strictEqual(made.reason, 'tmpdir-unusable');
      strictEqual(mkdirs, 0);
      ok(!('path' in made));
    });
  }

  for (const [label, name] of [['a quote', "it's"], ['a line break', 'a\nb'], ['a tab', 'a\tb']]) {
    it(`fails with unsupported-path for a root whose canonical path holds ${label}, before any mkdir`, (t) => {
      const r0 = root(t);
      fs.mkdirSync(join(r0, name));
      const made = makeDir({ kind: 'text', env: { TMPDIR: join(r0, name) } });
      deepStrictEqual(made, { ok: false, reason: 'unsupported-path' });
      deepStrictEqual(fs.readdirSync(join(r0, name)), []);
    });
  }

  it('fails with unsupported-path for a canonical path that is not UTF-8', () => {
    const made = makeDir({ kind: 'text', env: { TMPDIR: '/x' }, sys: { realpath: () => Buffer.from([0x2f, 0xff]) } });
    deepStrictEqual(made, { ok: false, reason: 'unsupported-path' });
  });

  for (const [label, sys] of [
    ['win32', { platform: () => 'win32' }],
    ['a platform with no geteuid', { geteuid: () => undefined }],
  ]) {
    it(`fails with unsupported on ${label}, making nothing`, (t) => {
      const r0 = root(t);
      const made = makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys });
      strictEqual(made.reason, 'unsupported');
      deepStrictEqual(fs.readdirSync(r0), []);
    });
  }

  for (const [label, fields, expected] of [
    ['an inode of zero', { ino: 0n }, { ok: false, reason: 'unsupported', detail: 'stat' }],
    // A real owner mismatch is a failed proof, not a platform the mktemp
    // fallback stands in for.
    ['an owner other than the effective uid', { uid: BigInt(process.geteuid() + 1) }, { ok: false, reason: 'owner-mismatch' }],
  ]) {
    it(`fails (${expected.reason}) when stat reports ${label}, and removes the directory`, (t) => {
      const r0 = root(t);
      const sys = {
        lstat: (p) => {
          const st = defaultSys.lstat(p);
          return path.dirname(p) === r0 && path.basename(p).startsWith('agentic-text.') ? statWith(st, fields) : st;
        },
      };
      const made = makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys });
      deepStrictEqual(made, expected);
      deepStrictEqual(fs.readdirSync(r0), []);
    });
  }

  it('sets the mode to 0700 when the umask took bits from it', (t) => {
    const r0 = root(t);
    const made = makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys: { mkdir: (p) => fs.mkdirSync(p, { mode: 0 }) } });
    strictEqual(made.ok, true);
    strictEqual(fs.lstatSync(made.path).mode & 0o777, 0o700);
  });

  it('retries a suffix that is taken', (t) => {
    const r0 = root(t);
    let calls = 0;
    const sys = { mkdir: (p, mode) => { calls += 1; if (calls === 1) throw err('EEXIST'); fs.mkdirSync(p, { mode }); } };
    const made = makeDir({ kind: 'op', env: { TMPDIR: r0 }, sys });
    strictEqual(made.ok, true);
    strictEqual(calls, 2);
  });

  for (const step of ['open', 'write', 'rename']) {
    it(`prints no path and removes its aside and the directory when the marker's ${step} fails`, (t) => {
      const r0 = root(t);
      const sys = {
        [step]: (...a) => {
          if (step === 'open' && !String(a[0]).includes(DIR_MARKER_FILE)) return defaultSys.open(...a);
          if (step === 'write') { defaultSys.write(a[0], a[1].subarray(0, 3)); throw err('ENOSPC'); }
          throw err('EIO');
        },
      };
      const made = makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys });
      strictEqual(made.ok, false);
      strictEqual(made.reason, 'error');
      ok(!('path' in made));
      deepStrictEqual(fs.readdirSync(r0), []);
    });
  }

  it('cleans up when a call after the mkdir throws (the id draw), and when a write makes no progress', (t) => {
    const r0 = root(t);
    let draws = 0;
    const throwing = { randomBytes: (n) => { draws += 1; if (n === 16) throw err('EAGAIN'); return defaultSys.randomBytes(n); } };
    deepStrictEqual(makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys: throwing }), { ok: false, reason: 'error', code: 'EAGAIN' });
    ok(draws > 0);
    deepStrictEqual(fs.readdirSync(r0), []);
    const stalled = makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys: { write: () => 0 } });
    deepStrictEqual(stalled, { ok: false, reason: 'error', code: 'EIO' });
    deepStrictEqual(fs.readdirSync(r0), []);
  });

  it('opens the marker aside exclusively and without following a link', (t) => {
    const r0 = root(t);
    const flags = [];
    const sys = { open: (p, f, m) => { flags.push(f); return defaultSys.open(p, f, m); } };
    strictEqual(makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys }).ok, true);
    strictEqual(flags.length, 1);
    ok(flags[0] & fs.constants.O_EXCL);
    ok(flags[0] & fs.constants.O_NOFOLLOW);
  });

  it('names what it could not remove after a failed marker', (t) => {
    const r0 = root(t);
    const sys = { rename: () => { throw err('EIO'); }, rmdir: () => { throw err('EBUSY'); } };
    const made = makeDir({ kind: 'text', env: { TMPDIR: r0 }, sys });
    strictEqual(made.ok, false);
    strictEqual(made.left.length, 1);
    strictEqual(made.left[0].code, 'EBUSY');
  });
});

describe('makeDir — the nested op (Decision 9, item 2; Decision 10, item 4)', () => {
  it('makes op inside a marked text directory, marked with the parent\'s device and inode only', (t) => {
    const r0 = root(t);
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const op = makeDir({ kind: 'op', parent: text.path });
    strictEqual(op.ok, true, JSON.stringify(op));
    strictEqual(op.path, join(text.path, 'op'));
    deepStrictEqual(fs.readdirSync(text.path).sort(), [DIR_MARKER_FILE, 'op'].sort());
    deepStrictEqual(fs.readdirSync(op.path), [DIR_MARKER_FILE]);
    const pst = fs.lstatSync(text.path, { bigint: true });
    const m = readMarker(op.path);
    strictEqual(m.kind, 'op');
    strictEqual(m.name, 'op');
    deepStrictEqual(m.parent, { dev: String(pst.dev), ino: String(pst.ino) });
    ok(m.id !== text.marker.id);
  });

  it('leaves op empty and the parent without its aside when the marker cannot be placed', (t) => {
    const r0 = root(t);
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const op = makeDir({ kind: 'op', parent: text.path, sys: { rename: () => { throw err('EIO'); } } });
    strictEqual(op.ok, false);
    deepStrictEqual(fs.readdirSync(text.path), [DIR_MARKER_FILE]);
  });

  it('refuses a parent with no marker as parent-legacy, so the old mkdir makes a legacy op', (t) => {
    const r0 = root(t);
    const legacy = fs.mkdtempSync(join(r0, 'agentic-text.'));
    deepStrictEqual(makeDir({ kind: 'op', parent: legacy }), { ok: false, reason: 'parent-legacy' });
    deepStrictEqual(fs.readdirSync(legacy), []);
  });

  // C175 F2: macOS's TMPDIR ends in `/` and lies under a linked /var, so the
  // legacy `mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"` prints a parent
  // the canonical checks refuse; it still gets the legacy fallback.
  it('a legacy parent spelled with //, a trailing / or through a linked root is parent-legacy too', (t) => {
    const r0 = root(t);
    fs.mkdirSync(join(r0, 'private'));
    fs.symlinkSync(join(r0, 'private'), join(r0, 'var'));
    const legacy = fs.mkdtempSync(join(r0, 'private', 'agentic-text.'));
    const name = path.basename(legacy);
    for (const spelling of [`${r0}/private//${name}`, `${legacy}/`, join(r0, 'var', name), `${r0}/var//${name}`]) {
      deepStrictEqual(makeDir({ kind: 'op', parent: spelling }), { ok: false, reason: 'parent-legacy' }, spelling);
    }
    deepStrictEqual(fs.readdirSync(legacy), []);
  });

  it('a marked parent spelled another way stays parent-invalid, and a legacy-looking path that is no directory of this user is not legacy', (t) => {
    const r0 = root(t);
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const name = path.basename(text.path);
    strictEqual(makeDir({ kind: 'op', parent: `${r0}//${name}` }).reason, 'parent-invalid');
    strictEqual(makeDir({ kind: 'op', parent: `${r0}//agentic-text.gone00` }).reason, 'parent-invalid');
    fs.writeFileSync(join(r0, 'agentic-text.file00'), '');
    strictEqual(makeDir({ kind: 'op', parent: `${r0}//agentic-text.file00` }).reason, 'parent-invalid');
    const legacy = fs.mkdtempSync(join(r0, 'agentic-text.'));
    const other = (p) => statWith(fs.lstatSync(p, { bigint: true }), { uid: BigInt(process.geteuid() + 1) });
    strictEqual(makeDir({ kind: 'op', parent: `${legacy}/`, sys: { lstat: other } }).reason, 'parent-invalid');
    strictEqual(makeDir({ kind: 'op', parent: `${r0}//agentic-op.abcdef` }).reason, 'parent-invalid');
    // A link named like a text directory points elsewhere: `mktemp -d` never
    // prints one, so it never gets the fallback, however it is spelled.
    const elsewhere = join(r0, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, join(r0, 'agentic-text.link00'));
    for (const spelling of [join(r0, 'agentic-text.link00'), `${r0}/agentic-text.link00/`, `${r0}//agentic-text.link00`]) {
      strictEqual(makeDir({ kind: 'op', parent: spelling }).reason, 'parent-invalid', spelling);
    }
    deepStrictEqual(fs.readdirSync(elsewhere), []);
    const lookupFails = { lstat: (p) => { if (p.endsWith(DIR_MARKER_FILE)) throw err('EACCES'); return defaultSys.lstat(p); } };
    deepStrictEqual(makeDir({ kind: 'op', parent: `${legacy}/`, sys: lookupFails }),
      { ok: false, reason: 'parent-unreadable', detail: 'legacy-lookup', code: 'EACCES' });
  });

  it('refuses a claimed parent, by its .removing- path or by the claim of its name', (t) => {
    const r0 = root(t);
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const claimed = join(r0, `.removing-${path.basename(text.path)}`);
    fs.renameSync(text.path, claimed);
    strictEqual(makeDir({ kind: 'op', parent: claimed }).reason, 'parent-claimed');
    strictEqual(makeDir({ kind: 'op', parent: text.path }).reason, 'parent-claimed');
  });

  it('refuses a parent that is not a proven text directory', (t) => {
    const r0 = root(t);
    const topOp = makeDir({ kind: 'op', env: { TMPDIR: r0 } });
    strictEqual(makeDir({ kind: 'op', parent: topOp.path }).reason, 'parent-invalid');
    strictEqual(makeDir({ kind: 'op', parent: 'relative/agentic-text.abcdef' }).reason, 'parent-invalid');
    strictEqual(makeDir({ kind: 'op', parent: join(r0, 'agentic-text.gone00') }).reason, 'parent-invalid');
    const a = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const b = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    fs.copyFileSync(join(a.path, DIR_MARKER_FILE), join(b.path, DIR_MARKER_FILE));
    strictEqual(makeDir({ kind: 'op', parent: b.path }).reason, 'parent-invalid');
    fs.symlinkSync(r0, join(r0, 'via'));
    strictEqual(makeDir({ kind: 'op', parent: join(r0, 'via', path.basename(a.path)) }).reason, 'parent-invalid');
  });

  it('reports a parent whose marker cannot be read as parent-unreadable', (t) => {
    const r0 = root(t);
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const sys = { open: (p, ...a) => { if (p.endsWith(DIR_MARKER_FILE)) throw err('EACCES'); return defaultSys.open(p, ...a); } };
    const op = makeDir({ kind: 'op', parent: text.path, sys });
    strictEqual(op.reason, 'parent-unreadable');
    strictEqual(op.code, 'EACCES');
  });

  it('refuses a nested path a single-quoted literal cannot carry, making nothing', (t) => {
    const r0 = root(t);
    fs.mkdirSync(join(r0, "it's"));
    const realRoot = join(r0, "it's");
    // A text directory marked by hand under that root (the make refuses the
    // root itself), so only the nested make's own check stands in the way.
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    const moved = join(realRoot, path.basename(text.path));
    fs.renameSync(text.path, moved);
    const pst = fs.statSync(realRoot, { bigint: true });
    fs.writeFileSync(join(moved, DIR_MARKER_FILE), JSON.stringify({ ...text.marker, parent: { path: realRoot, dev: String(pst.dev), ino: String(pst.ino) } }));
    deepStrictEqual(makeDir({ kind: 'op', parent: moved }), { ok: false, reason: 'unsupported-path' });
    deepStrictEqual(fs.readdirSync(moved), [DIR_MARKER_FILE]);
  });

  it('refuses a second op as exists', (t) => {
    const r0 = root(t);
    const text = makeDir({ kind: 'text', env: { TMPDIR: r0 } });
    strictEqual(makeDir({ kind: 'op', parent: text.path }).ok, true);
    strictEqual(makeDir({ kind: 'op', parent: text.path }).reason, 'exists');
  });

  it('refuses a nested text directory and an unknown kind as usage', (t) => {
    strictEqual(makeDir({ kind: 'text', parent: '/x/agentic-text.abcdef' }).reason, 'usage');
    strictEqual(makeDir({ kind: 'args' }).reason, 'usage');
  });
});

describe('the transport schema has one check, which agentic-dir.mjs restates the identifier forms for', () => {
  const transport = {
    schema: OPERATION_TRANSPORT_SCHEMA, operation_id: 'op-20261126T000000Z-0123abcd', kind: 'verb',
    macro_id: 'macro-plan-20261120T224328Z-9b3901', subtask_id: 'tmpdir-cli', branch: 'feat/x',
    opened_at: '2026-11-26T00:00:00Z', workflow_id: null, state: 'closed',
  };

  it('accepts a record with or without dir_marker_id, and refuses a malformed id', () => {
    strictEqual(validateOperationTransport(transport), true);
    strictEqual(validateOperationTransport({ ...transport, dir_marker_id: 'a'.repeat(32) }), true);
    strictEqual(validateOperationTransport({ ...transport, dir_marker_id: 'A'.repeat(32) }), false);
    strictEqual(validateOperationTransport({ ...transport, dir_marker_id: null }), false);
    strictEqual(validateOperationTransport({ ...transport, state: 'gone' }), false);
    strictEqual(validateOperationTransport([]), false);
  });

  it('holds.mjs reads the transport through it', (t) => {
    const dir = tmpDir(t, 'adir-transport-');
    fs.writeFileSync(join(dir, OPERATION_TRANSPORT_FILE), JSON.stringify({ ...transport, dir_marker_id: 'b'.repeat(32) }));
    strictEqual(holds.readOperationTransport(dir).value.dir_marker_id, 'b'.repeat(32));
    fs.writeFileSync(join(dir, OPERATION_TRANSPORT_FILE), JSON.stringify({ ...transport, dir_marker_id: 7 }));
    ok(holds.readOperationTransport(dir).error);
    strictEqual(holds.OPERATION_TRANSPORT_SCHEMA, OPERATION_TRANSPORT_SCHEMA);
    strictEqual(holds.OPERATION_TRANSPORT_FILE, OPERATION_TRANSPORT_FILE);
  });

  for (const rel of ['persona-pipeline/files/scripts/lib/holds.mjs', 'plugins/orchestrator/scripts/lib/holds-records.mjs']) {
    it(`restates the identifier forms of ${rel} exactly`, () => {
      const text = fs.readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const [name, re] of [['OPERATION_ID_RE', OPERATION_ID_RE], ['MACRO_ID_RE', MACRO_ID_RE], ['SUBTASK_ID_RE', SUBTASK_ID_RE]]) {
        const m = new RegExp(`const ${name} = (/.+/);`).exec(text);
        ok(m, `${rel} declares ${name}`);
        strictEqual(m[1], String(re), `${rel} ${name}`);
      }
    });
  }
});
