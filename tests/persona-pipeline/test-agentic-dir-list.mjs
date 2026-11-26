// ADR-0059 Decision 10, item 6 (C175): the listing reads the root and changes
// nothing; the owner's run releases only marked directories the listing judged
// releasable, holding no kept file and old enough, through the full proof,
// claim-only, one at a time, after stating its precondition. In process,
// through the module the CLIs call; every directory lives under a test's own
// TMPDIR.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';

import { tmpDir } from '../_tmp.mjs';
import {
  DEFAULT_AGE_DAYS, KEEP_NAMES, OPERATION_TRANSPORT_FILE, OPERATION_TRANSPORT_SCHEMA,
  defaultSys, executeAbandoned, executePrecondition, listDirs, makeDir, newestMtimeMs, parseAgeDays, releaseDir, repeatedFlags, tmpdirArgProblem,
} from '../../persona-pipeline/files/scripts/lib/agentic-dir.mjs';

const DAY = 86_400_000;
const err = (code) => Object.assign(new Error(code), { code });
const root = (t) => fs.realpathSync(tmpDir(t, 'adir-list-'));
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const claimedOf = (p) => join(path.dirname(p), `.removing-${path.basename(p)}`);

function make(r0, kind = 'text') {
  const made = makeDir({ kind, env: { TMPDIR: r0 } });
  ok(made.ok, JSON.stringify(made));
  return made;
}

// Set every entry's and the directory's times (entries first: writing them
// would move the directory's own time), one level into a nested op.
function age(dir, when) {
  const t = new Date(when);
  for (const n of fs.readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'op' && fs.lstatSync(p).isDirectory()) age(p, when);
    else fs.lutimesSync(p, t, t);
  }
  fs.utimesSync(dir, t, t);
}

function transport(fields = {}) {
  return {
    schema: OPERATION_TRANSPORT_SCHEMA, operation_id: 'op-20261126T000000Z-0123abcd', kind: 'verb',
    macro_id: 'macro-plan-20261120T224328Z-9b3901', subtask_id: 'tmpdir-cli', branch: 'feat/x',
    opened_at: '2026-11-26T00:00:00Z', workflow_id: null, state: 'closed', ...fields,
  };
}

// Every path under `dir`, with its type and modification time.
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = join(d, n);
      const st = fs.lstatSync(p, { bigint: true });
      out.push(`${path.relative(dir, p)} ${st.mode} ${st.mtimeNs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

const byName = (entries) => Object.fromEntries(entries.map((e) => [e.name, e]));

describe('listDirs — the listing (Decision 10, item 6)', () => {
  it('names every entry of a top-level kind\'s form with its state, and changes nothing', (t) => {
    const r0 = root(t);
    const good = make(r0);
    const kept = make(r0);
    fs.writeFileSync(join(kept.path, 'dispatch-mark.json'), '{}');
    const open = make(r0, 'op');
    fs.writeFileSync(join(open.path, OPERATION_TRANSPORT_FILE), JSON.stringify(transport({ state: 'open', dir_marker_id: open.marker.id })));
    fs.mkdirSync(join(r0, 'agentic-text.Legacy1'), { mode: 0o700 });
    fs.mkdirSync(join(r0, '.removing-agentic-op.Claim12'), { mode: 0o700 });
    fs.symlinkSync(good.path, join(r0, 'agentic-text.Linked1'));
    fs.mkdirSync(join(r0, 'agentic-args.Other12'));
    fs.mkdirSync(join(r0, 'unrelated'));
    const before = snapshot(r0);
    const l = listDirs({ env: { TMPDIR: r0 } });
    deepStrictEqual(snapshot(r0), before);
    strictEqual(l.ok, true);
    strictEqual(l.root, r0);
    const e = byName(l.entries);
    deepStrictEqual(Object.keys(e).sort(), [
      '.removing-agentic-op.Claim12', 'agentic-text.Legacy1', 'agentic-text.Linked1',
      path.basename(good.path), path.basename(kept.path), path.basename(open.path),
    ].sort());
    strictEqual(e[path.basename(good.path)].state, 'releasable');
    deepStrictEqual(e[path.basename(good.path)].keeps, []);
    strictEqual(e[path.basename(kept.path)].state, 'releasable');
    deepStrictEqual(e[path.basename(kept.path)].keeps, ['dispatch-mark.json']);
    deepStrictEqual([e[path.basename(open.path)].state, e[path.basename(open.path)].reason], ['refused', 'operation-not-closed']);
    strictEqual(e['agentic-text.Legacy1'].state, 'unmarked');
    strictEqual(e['.removing-agentic-op.Claim12'].state, 'claimed');
    deepStrictEqual([e['agentic-text.Linked1'].state, e['agentic-text.Linked1'].reason], ['refused', 'symlink']);
    for (const x of l.entries) ok(typeof x.newest_mtime === 'string' && Number.isFinite(x.newest_mtime_ms), x.name);
  });

  it('takes the newest modification among the directory, its entries and its nested op\'s', (t) => {
    const r0 = root(t);
    const text = make(r0);
    const op = makeDir({ kind: 'op', parent: text.path });
    fs.writeFileSync(join(op.path, 'prompt.xml'), 'p');
    age(text.path, Date.parse('2026-01-01T00:00:00Z'));
    const fresh = new Date('2026-06-01T00:00:00Z');
    fs.utimesSync(join(op.path, 'prompt.xml'), fresh, fresh);
    strictEqual(newestMtimeMs(text.path), fresh.getTime());
  });

  it('gives no time, so never old enough, when an entry cannot be read', (t) => {
    const r0 = root(t);
    const text = make(r0);
    fs.writeFileSync(join(text.path, 'note.md'), 'n');
    const sys = { lstat: (p) => { if (p.endsWith('/note.md')) throw err('EACCES'); return defaultSys.lstat(p); } };
    strictEqual(newestMtimeMs(text.path, sys), null);
    const e = listDirs({ env: { TMPDIR: r0 }, sys }).entries[0];
    strictEqual(e.newest_mtime, null);
  });

  it('refuses a root it cannot use, and a platform the proof means nothing on', (t) => {
    deepStrictEqual(listDirs({ env: { TMPDIR: 'relative' } }), { ok: false, reason: 'tmpdir-unusable' });
    deepStrictEqual(listDirs({ env: { TMPDIR: '' } }), { ok: false, reason: 'tmpdir-unusable' });
    strictEqual(listDirs({ env: { TMPDIR: join(root(t), 'missing') } }).reason, 'tmpdir-unusable');
    deepStrictEqual(listDirs({ env: { TMPDIR: '/tmp' }, sys: { platform: () => 'win32' } }), { ok: false, reason: 'unsupported', detail: 'win32' });
  });
});

describe('executeAbandoned — the owner\'s run (Decision 10, item 6)', () => {
  const old = Date.parse('2026-11-01T00:00:00Z');
  const now = new Date('2026-11-26T00:00:00Z');

  it('releases old, releasable directories with no kept file; skips everything else and leaves it as it was', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'note.md'), 'n');
    age(a.path, old);
    const young = make(r0);
    age(young.path, now.getTime() - DAY);
    const kept = make(r0);
    fs.writeFileSync(join(kept.path, 'admission'), 'id');
    age(kept.path, old);
    const open = make(r0, 'op');
    fs.writeFileSync(join(open.path, OPERATION_TRANSPORT_FILE), JSON.stringify(transport({ state: 'open', dir_marker_id: open.marker.id })));
    age(open.path, old);
    fs.mkdirSync(join(r0, 'agentic-op.Legacy1'), { mode: 0o700 });
    fs.mkdirSync(join(r0, '.removing-agentic-text.Claim12'), { mode: 0o700 });
    const run = executeAbandoned({ env: { TMPDIR: r0 }, now });
    strictEqual(run.ok, true);
    strictEqual(run.age_days, DEFAULT_AGE_DAYS);
    const r = byName(run.results);
    deepStrictEqual([r[path.basename(a.path)].action, r[path.basename(a.path)].report.outcome], ['released', 'removed']);
    ok(!there(a.path));
    deepStrictEqual([r[path.basename(young.path)].action, r[path.basename(young.path)].skip], ['skipped', 'young']);
    deepStrictEqual([r[path.basename(kept.path)].action, r[path.basename(kept.path)].skip], ['skipped', 'kept-file']);
    deepStrictEqual([r[path.basename(open.path)].action, r[path.basename(open.path)].skip], ['skipped', 'refused']);
    deepStrictEqual([r['agentic-op.Legacy1'].skip, r['.removing-agentic-text.Claim12'].skip], ['unmarked', 'claimed']);
    for (const p of [young.path, kept.path, open.path, join(r0, 'agentic-op.Legacy1'), join(r0, '.removing-agentic-text.Claim12')]) ok(there(p), p);
  });

  it('age 0 selects any age; a negative or fractional age is a usage error', (t) => {
    const r0 = root(t);
    const a = make(r0);
    strictEqual(executeAbandoned({ env: { TMPDIR: r0 }, ageDays: 0 }).results[0].report.outcome, 'removed');
    deepStrictEqual(executeAbandoned({ env: { TMPDIR: r0 }, ageDays: -1 }), { ok: false, reason: 'usage' });
    deepStrictEqual(executeAbandoned({ env: { TMPDIR: r0 }, ageDays: 1.5 }), { ok: false, reason: 'usage' });
    ok(!there(a.path));
  });

  it('states its precondition once the root is read and before the first release', (t) => {
    const r0 = root(t);
    make(r0);
    const order = [];
    const sys = { rename: (a, b) => { order.push('rename'); return defaultSys.rename(a, b); } };
    executeAbandoned({ env: { TMPDIR: r0 }, ageDays: 0, sys, onStart: (rt) => order.push(`start ${rt}`) });
    deepStrictEqual(order, [`start ${r0}`, 'rename']);
    const text = executePrecondition(r0, 7);
    ok(text.includes(JSON.stringify(r0)) && text.includes('7 days'));
    for (const word of ['/orchestrator:next', 'admission', 'persona operation', 'peer run', 'other run of --execute']) ok(text.includes(word), word);
  });

  it('is not ok when a release it made did not succeed, and goes on to the next', (t) => {
    const r0 = root(t);
    const a = make(r0);
    const b = make(r0);
    const first = [a.path, b.path].sort()[0];
    const sys = { mkdir: (p, m) => { if (p === claimedOf(first)) throw err('EACCES'); return defaultSys.mkdir(p, m); } };
    const run = executeAbandoned({ env: { TMPDIR: r0 }, ageDays: 0, sys });
    strictEqual(run.ok, false);
    deepStrictEqual(run.results.map((x) => x.report.outcome), ['error', 'removed']);
    ok(there(first));
  });

  it('passes a root it cannot use through as the listing\'s failure, releasing nothing', () => {
    deepStrictEqual(executeAbandoned({ env: { TMPDIR: 'relative' } }), { ok: false, reason: 'tmpdir-unusable' });
  });
});

describe('releaseDir with the owner\'s options — claim-only, checked again at the claim', () => {
  // A day after the directories these tests make, so an age of 0 holds.
  const owner = (minAgeMs = 0) => ({ keepNames: KEEP_NAMES, minAgeMs, now: new Date(Date.now() + DAY) });

  it('skips a directory whose .removing- name is there, before the claim, and never finishes one', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.mkdirSync(claimedOf(a.path), { mode: 0o700 });
    deepStrictEqual(releaseDir(a.path, { owner: owner() }), { outcome: 'skipped', path: a.path, reason: 'claimed', removing_path: claimedOf(a.path) });
    ok(there(a.path));
    const b = make(r0);
    fs.renameSync(b.path, claimedOf(b.path));
    deepStrictEqual(releaseDir(b.path, { owner: owner() }), { outcome: 'skipped', path: b.path, reason: 'claimed', removing_path: claimedOf(b.path) });
    ok(there(claimedOf(b.path)));
    strictEqual(releaseDir(claimedOf(b.path), { owner: owner() }).outcome, 'skipped');
    ok(there(claimedOf(b.path)));
  });

  it('a placeholder made between its check and the claim is skipped, not a failed release, and nothing changes', (t) => {
    const r0 = root(t);
    const a = make(r0);
    let raced = false;
    const sys = {
      mkdir: (p, m) => {
        if (!raced && p === claimedOf(a.path)) { raced = true; defaultSys.mkdir(p, m); }
        return defaultSys.mkdir(p, m);
      },
    };
    deepStrictEqual(releaseDir(a.path, { owner: owner(), sys }), { outcome: 'skipped', path: a.path, reason: 'claimed', removing_path: claimedOf(a.path) });
    ok(there(a.path) && fs.readdirSync(claimedOf(a.path)).length === 0);
    // Without the owner's options the same race is contention.
    const b = make(r0);
    fs.mkdirSync(claimedOf(b.path), { mode: 0o700 });
    strictEqual(releaseDir(b.path).outcome, 'contention');
  });

  it('a kept file in the removal\'s own listing stops it before anything is unlinked, and the directory is put back', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'note.md'), 'n');
    // The contents check is the first listing of the claimed directory, the
    // removal's the second: the kept file appears between them.
    let listings = 0;
    const sys = {
      readdir: (p) => {
        if (p === claimedOf(a.path) && ++listings === 2) fs.writeFileSync(join(p, 'admission'), 'id');
        return defaultSys.readdir(p);
      },
    };
    deepStrictEqual(releaseDir(a.path, { owner: owner(), sys }), { outcome: 'refused', reason: 'kept-file', entry: 'admission', path: a.path });
    ok(there(join(a.path, 'note.md')) && there(join(a.path, 'admission')) && !there(claimedOf(a.path)));
  });

  it('a kept file that appears while the removal unlinks is never unlinked: the release ends partial', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'note.md'), 'n');
    const sys = {
      unlink: (p) => {
        defaultSys.unlink(p);
        if (p === join(claimedOf(a.path), 'note.md')) fs.writeFileSync(join(claimedOf(a.path), 'admission'), 'id');
      },
    };
    const r = releaseDir(a.path, { owner: owner(), sys });
    deepStrictEqual([r.outcome, r.marker_remains, r.found], ['partial', true, ['admission']]);
    ok(there(join(claimedOf(a.path), 'admission')));
  });

  it('a kept file, even a dangling link, written after the listing skips the directory before the claim', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.symlinkSync(join(r0, 'nothing'), join(a.path, 'admission'));
    deepStrictEqual(releaseDir(a.path, { owner: owner() }), { outcome: 'skipped', path: a.path, reason: 'kept-file', entry: 'admission' });
    ok(there(a.path) && !there(claimedOf(a.path)));
  });

  it('a write after the listing that makes it younger than the age skips it; an unreadable time does too', (t) => {
    const r0 = root(t);
    const a = make(r0);
    strictEqual(releaseDir(a.path, { owner: { keepNames: KEEP_NAMES, minAgeMs: DAY, now: new Date() } }).reason, 'young');
    // Before the claim only the age walk looks up an ordinary entry.
    fs.writeFileSync(join(a.path, 'note.md'), 'n');
    const sys = { lstat: (p) => { if (p === join(a.path, 'note.md')) throw err('EIO'); return defaultSys.lstat(p); } };
    deepStrictEqual(releaseDir(a.path, { owner: owner(), sys }), { outcome: 'skipped', path: a.path, reason: 'age-unknown' });
    ok(there(join(a.path, 'note.md')) && !there(claimedOf(a.path)));
  });

  it('a kept file written after the claim stops the removal, and the directory is put back', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'note.md'), 'n');
    const sys = {
      rename: (from, to) => {
        defaultSys.rename(from, to);
        if (to === claimedOf(a.path)) fs.writeFileSync(join(to, 'dispatch-mark.json'), '{}');
      },
    };
    deepStrictEqual(releaseDir(a.path, { owner: owner(), sys }), { outcome: 'refused', reason: 'kept-file', entry: 'dispatch-mark.json', path: a.path });
    ok(there(join(a.path, 'note.md')) && there(join(a.path, 'dispatch-mark.json')) && !there(claimedOf(a.path)));
  });

  it('without the owner\'s options a kept file is an ordinary entry: the plain release removes it', (t) => {
    const r0 = root(t);
    const a = make(r0);
    fs.writeFileSync(join(a.path, 'dispatch-mark.json'), '{}');
    strictEqual(releaseDir(a.path).outcome, 'removed');
  });
});

describe('the CLIs\' argument helpers', () => {
  it('parseAgeDays: the default, whole days 0 to 36500, nothing else', () => {
    strictEqual(parseAgeDays(undefined), DEFAULT_AGE_DAYS);
    deepStrictEqual(['0', '7', '36500'].map(parseAgeDays), [0, 7, 36500]);
    for (const bad of ['', '-1', '1.5', '07', '36501', '1e3', ' 7', 'seven']) strictEqual(parseAgeDays(bad), null, bad);
  });

  it('repeatedFlags: by name, in both spellings', () => {
    deepStrictEqual(repeatedFlags(['--path', 'a']), []);
    deepStrictEqual(repeatedFlags(['--path', 'a', '--path', 'b']), ['path']);
    deepStrictEqual(repeatedFlags(['--execute=true', '--execute']), ['execute']);
    deepStrictEqual(repeatedFlags(['--kind', '--kind']), ['kind']);
  });

  it('tmpdirArgProblem: on the raw words, a flag the subcommand does not take, an empty --name=, a repeat', () => {
    strictEqual(tmpdirArgProblem('tmpdir-make', ['--kind', 'op', '--parent', '/x']), null);
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute', 'true', '--age-days', '3']), null);
    strictEqual(tmpdirArgProblem('tmpdir-make', ['--kind', 'text', '--summary-file', '/etc/passwd']), 'tmpdir-make: unexpected flag --summary-file');
    strictEqual(tmpdirArgProblem('tmpdir-release', ['--path', '/x', '--__proto__', 'y']), 'tmpdir-release: unexpected flag --__proto__');
    strictEqual(tmpdirArgProblem('tmpdir-release', ['--path', '/x', '--repo-root', '.']), 'tmpdir-release: unexpected flag --repo-root');
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute=']), 'tmpdir-list: --execute needs a value');
    strictEqual(tmpdirArgProblem('tmpdir-release', ['--path', '/a', '--path=/b']), 'tmpdir-release: --path is given more than once');
    strictEqual(tmpdirArgProblem('tmpdir-other', ['--anything']), null);
    // C175 F3: a bare flag, a non-boolean --execute and a stray word.
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute']), 'tmpdir-list: --execute needs a value');
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute', '--age-days', '1']), 'tmpdir-list: --execute needs a value');
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute', '']), 'tmpdir-list: --execute takes true or false (got "")');
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute', 'on']), 'tmpdir-list: --execute takes true or false (got "on")');
    // The persona parser has no --name=value form, so neither CLI takes it.
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute=true']), 'tmpdir-list: --execute=<value> is not taken; give the value as its own word (--execute <value>)');
    strictEqual(tmpdirArgProblem('tmpdir-release', ['--path=/x']), 'tmpdir-release: --path=<value> is not taken; give the value as its own word (--path <value>)');
    strictEqual(tmpdirArgProblem('tmpdir-list', ['--execute', 'false']), null);
    strictEqual(tmpdirArgProblem('tmpdir-release', ['--path', '']), null);
    strictEqual(tmpdirArgProblem('tmpdir-release', ['/x']), 'tmpdir-release: unexpected argument "/x"');
    strictEqual(tmpdirArgProblem('tmpdir-make', ['--kind', 'op', '--parent']), 'tmpdir-make: --parent needs a value');
    strictEqual(tmpdirArgProblem('constructor', ['--x']), null);
  });
});
