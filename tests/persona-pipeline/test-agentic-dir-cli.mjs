// ADR-0059 Decision 9 and Decision 10, items 4 and 6 (C175): the tmpdir
// subcommands of the persona state.mjs and the orchestrator's — what each
// prints on which stream and the exit status a block branches on, the flags
// refused before any file system call, and one CLI judging what the other
// made. The proof and the listing are tested in process
// (test-agentic-dir-{make,release,list}.mjs); these are the dispatchers' own
// branches. Every directory lives under a test's own TMPDIR.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIS = {
  engineer: join(REPO, 'plugins/engineer/scripts/state.mjs'),
  orchestrator: join(REPO, 'plugins/orchestrator/scripts/state.mjs'),
};

function run(cli, args, env = {}) {
  const r = spawnSync(process.execPath, [CLIS[cli], ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, cwd: REPO,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const root = (t) => fs.realpathSync(tmpDir(t, 'adir-cli-'));
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const lines = (s) => s.split('\n').filter((l) => l !== '');

for (const cli of Object.keys(CLIS)) {
  describe(`${cli} state.mjs tmpdir subcommands`, () => {
    it('make prints the path alone and exits 0; a nested make prints op inside it', (t) => {
      const r0 = root(t);
      const m = run(cli, ['tmpdir-make', '--kind', 'text'], { TMPDIR: r0 });
      strictEqual(m.status, 0, m.stderr);
      strictEqual(m.stderr, '');
      ok(/^agentic-text\.[A-Za-z0-9]{10}\n$/.test(m.stdout.slice(r0.length + 1)), m.stdout);
      const text = m.stdout.trimEnd();
      const n = run(cli, ['tmpdir-make', '--kind', 'op', '--parent', text], { TMPDIR: r0 });
      deepStrictEqual([n.status, n.stdout, n.stderr], [0, `${text}/op\n`, '']);
    });

    it('a failed make prints no path, one line on stderr, and the status its reason maps to', (t) => {
      const r0 = root(t);
      const bad = run(cli, ['tmpdir-make', '--kind', 'text'], { TMPDIR: 'relative' });
      deepStrictEqual([bad.status, bad.stdout], [1, '']);
      deepStrictEqual(lines(bad.stderr), ['agentic-dir make: tmpdir-unusable; no directory was made']);
      fs.mkdirSync(join(r0, "it's"));
      const quote = run(cli, ['tmpdir-make', '--kind', 'op'], { TMPDIR: join(r0, "it's") });
      deepStrictEqual([quote.status, quote.stdout], [5, '']);
      ok(quote.stderr.startsWith('agentic-dir make: unsupported-path'));
      fs.mkdirSync(join(r0, 'agentic-text.Legacy1'), { mode: 0o700 });
      const legacy = run(cli, ['tmpdir-make', '--kind', 'op', '--parent', join(r0, 'agentic-text.Legacy1')], { TMPDIR: r0 });
      deepStrictEqual([legacy.status, legacy.stdout], [4, '']);
      ok(legacy.stderr.startsWith('agentic-dir make: parent-legacy'));
      const kind = run(cli, ['tmpdir-make', '--kind', 'args'], { TMPDIR: r0 });
      deepStrictEqual([kind.status, kind.stdout], [2, '']);
      deepStrictEqual(fs.readdirSync(r0).sort(), ['agentic-text.Legacy1', "it's"]);
    });

    it('release prints one JSON report always, a line on stderr only for an outcome that keeps something, and its status', (t) => {
      const r0 = root(t);
      const text = run(cli, ['tmpdir-make', '--kind', 'text'], { TMPDIR: r0 }).stdout.trimEnd();
      const gone = run(cli, ['tmpdir-release', '--path', text], { TMPDIR: r0 });
      deepStrictEqual([gone.status, JSON.parse(gone.stdout), gone.stderr], [0, { outcome: 'removed', path: text }, '']);
      strictEqual(lines(gone.stdout).length, 1);
      const again = run(cli, ['tmpdir-release', '--path', text], { TMPDIR: r0 });
      deepStrictEqual([again.status, JSON.parse(again.stdout).outcome, again.stderr], [0, 'absent', '']);
      fs.mkdirSync(join(r0, 'agentic-text.Legacy1'), { mode: 0o700 });
      const legacy = run(cli, ['tmpdir-release', '--path', join(r0, 'agentic-text.Legacy1')], { TMPDIR: r0 });
      deepStrictEqual([legacy.status, JSON.parse(legacy.stdout).reason], [10, 'marker-absent']);
      deepStrictEqual(lines(legacy.stderr), [`agentic-dir release: not-owned (marker-absent); the directory is kept at ${JSON.stringify(join(r0, 'agentic-text.Legacy1'))}`]);
      const quote = run(cli, ['tmpdir-release', '--path', "/tmp/agentic-text.Ab'cdef"], { TMPDIR: r0 });
      deepStrictEqual([quote.status, JSON.parse(quote.stdout).outcome, quote.stderr], [0, 'unsupported', '']);
      ok(there(join(r0, 'agentic-text.Legacy1')));
    });

    it('list prints the listing as JSON and changes nothing; --execute true states the precondition on stderr before it acts', (t) => {
      const r0 = root(t);
      const text = run(cli, ['tmpdir-make', '--kind', 'text'], { TMPDIR: r0 }).stdout.trimEnd();
      const l = run(cli, ['tmpdir-list'], { TMPDIR: r0 });
      strictEqual(l.status, 0, l.stderr);
      const listing = JSON.parse(l.stdout);
      deepStrictEqual([listing.ok, listing.root, listing.entries.map((e) => [e.path, e.state])], [true, r0, [[text, 'releasable']]]);
      ok(there(text));
      const young = run(cli, ['tmpdir-list', '--execute', 'true'], { TMPDIR: r0 });
      strictEqual(young.status, 0, young.stderr);
      ok(young.stderr.startsWith('agentic-dir list --execute: releasing the marked directories under'));
      deepStrictEqual(JSON.parse(young.stdout).results.map((e) => [e.action, e.skip]), [['skipped', 'young']]);
      ok(there(text));
      const all = run(cli, ['tmpdir-list', '--execute', 'true', '--age-days', '0'], { TMPDIR: r0 });
      strictEqual(all.status, 0, all.stderr);
      deepStrictEqual(JSON.parse(all.stdout).results.map((e) => e.report.outcome), ['removed']);
      ok(!there(text));
    });

    it('--execute true is not ok when a release fails, and prints that release\'s line', (t) => {
      const r0 = root(t);
      const text = run(cli, ['tmpdir-make', '--kind', 'text'], { TMPDIR: r0 }).stdout.trimEnd();
      fs.chmodSync(r0, 0o500);
      const r = run(cli, ['tmpdir-list', '--execute', 'true', '--age-days', '0'], { TMPDIR: r0 });
      fs.chmodSync(r0, 0o700);
      strictEqual(r.status, 1);
      deepStrictEqual(JSON.parse(r.stdout).results.map((e) => e.report.outcome), ['error']);
      ok(r.stderr.includes(`agentic-dir release: error (claim-mkdir); the directory is kept at ${JSON.stringify(text)}`), r.stderr);
      ok(there(text));
    });

    it('refuses a repeated flag, a flag of another subcommand and a conflicting one, before any file system call', (t) => {
      const r0 = root(t);
      const cases = [
        [['tmpdir-make', '--kind', 'text', '--kind', 'op'], 2],
        [['tmpdir-release', '--path', join(r0, 'agentic-text.Abcdef'), '--path=x'], 2],
        [['tmpdir-make', '--kind', 'text', '--repo-root', r0], 2],
        [['tmpdir-make', '--kind', 'text', '--path', 'x'], 2],
        // A text-file flag of another subcommand is refused on its name, never read.
        [['tmpdir-make', '--kind', 'text', '--summary-file', join(r0, 'missing.txt')], 2],
        [['tmpdir-list', '--execute='], 2],
        // C175 F3: one reading of a bare flag, a non-boolean --execute and a
        // stray word in both CLIs, judged on the raw words.
        [['tmpdir-list', '--execute'], 2],
        [['tmpdir-list', '--execute', ''], 2],
        [['tmpdir-list', '--execute', 'yes'], 2],
        [['tmpdir-list', '--execute', '--age-days', '0'], 2],
        [['tmpdir-release', '--path'], 2],
        [['tmpdir-make', '--kind', 'op', '--parent'], 2],
        [['tmpdir-make', 'text'], 2],
        [['tmpdir-release', '--path', join(r0, 'agentic-text.Abcdef'), 'extra'], 2],
        [['tmpdir-list', '--age-days', '3'], 1],
        [['tmpdir-list', '--execute', 'true', '--age-days', '1.5'], 1],
        [['tmpdir-release'], 1],
      ];
      for (const [args, status] of cases) {
        const r = run(cli, args, { TMPDIR: r0 });
        deepStrictEqual([r.status, r.stdout], [status, ''], args.join(' '));
        strictEqual(lines(r.stderr).length, 1, args.join(' '));
        if (status === 2 && args.includes('--summary-file')) ok(r.stderr.includes('unexpected flag --summary-file'), r.stderr);
      }
      deepStrictEqual(fs.readdirSync(r0), []);
    });

    it('--execute true releases nothing when its precondition cannot be written', { skip: !fs.existsSync('/dev/full') }, (t) => {
      const r0 = root(t);
      const text = run(cli, ['tmpdir-make', '--kind', 'text'], { TMPDIR: r0 }).stdout.trimEnd();
      const full = fs.openSync('/dev/full', 'w');
      const r = spawnSync(process.execPath, [CLIS[cli], 'tmpdir-list', '--execute', 'true', '--age-days', '0'], {
        encoding: 'utf8', env: { ...process.env, TMPDIR: r0 }, cwd: REPO, stdio: ['ignore', 'pipe', full],
      });
      fs.closeSync(full);
      strictEqual(r.status, 1);
      strictEqual(r.stdout, '');
      ok(there(text));
    });
  });
}

describe('both CLIs answer every argument alike (C175 F3)', () => {
  it('an empty --path is a release report, an empty --parent a parent-invalid make, and each refusal the same status and stdout', (t) => {
    const r0 = root(t);
    const legacy = fs.mkdtempSync(join(r0, 'agentic-text.'));
    const calls = [
      ['tmpdir-release', '--path', ''],
      ['tmpdir-make', '--kind', 'op', '--parent', ''],
      ['tmpdir-make', '--kind', 'op', '--parent', `${legacy}/`],
      ['tmpdir-make', '--kind', ''],
      ['tmpdir-list', '--execute'],
      ['tmpdir-list', '--execute', 'false'],
      ['tmpdir-list', 'stray'],
      ['tmpdir-release', '--path=/x', '--path', '/y'],
      ['tmpdir-list', '--execute=false'],
      ['tmpdir-release', `--path=${join(r0, 'agentic-text.Absent')}`],
      ['tmpdir-make', '--kind=text'],
    ];
    for (const args of calls) {
      const e = run('engineer', args, { TMPDIR: r0 });
      const o = run('orchestrator', args, { TMPDIR: r0 });
      deepStrictEqual([o.status, o.stdout], [e.status, e.stdout], args.join(' '));
      strictEqual(lines(o.stderr).length, lines(e.stderr).length, args.join(' '));
    }
    const empty = run('orchestrator', ['tmpdir-release', '--path', ''], { TMPDIR: r0 });
    deepStrictEqual([empty.status, JSON.parse(empty.stdout).outcome, JSON.parse(empty.stdout).reason], [10, 'not-owned', 'path-form']);
    const parent = run('orchestrator', ['tmpdir-make', '--kind', 'op', '--parent', ''], { TMPDIR: r0 });
    deepStrictEqual([parent.status, parent.stdout], [1, '']);
    ok(parent.stderr.startsWith('agentic-dir make: parent-invalid'), parent.stderr);
    for (const args of [['tmpdir-list', '--execute=false'], ['tmpdir-make', '--kind=text']]) {
      deepStrictEqual([run('orchestrator', args, { TMPDIR: r0 }).status, run('engineer', args, { TMPDIR: r0 }).status], [2, 2], args.join(' '));
    }
    const legacyRun = run('orchestrator', ['tmpdir-make', '--kind', 'op', '--parent', `${legacy}/`], { TMPDIR: r0 });
    strictEqual(legacyRun.status, 4);
    deepStrictEqual(fs.readdirSync(legacy), []);
  });
});

describe('one CLI judges what the other made', () => {
  it('a text directory made by the engineer CLI, its op by the orchestrator\'s, listed and released by either', (t) => {
    const r0 = root(t);
    const text = run('engineer', ['tmpdir-make', '--kind', 'text'], { TMPDIR: r0 }).stdout.trimEnd();
    const op = run('orchestrator', ['tmpdir-make', '--kind', 'op', '--parent', text], { TMPDIR: r0 }).stdout.trimEnd();
    strictEqual(op, `${text}/op`);
    fs.writeFileSync(join(op, 'prompt.xml'), 'p');
    const other = run('orchestrator', ['tmpdir-make', '--kind', 'op'], { TMPDIR: r0 }).stdout.trimEnd();
    deepStrictEqual(JSON.parse(run('orchestrator', ['tmpdir-list'], { TMPDIR: r0 }).stdout).entries.map((e) => e.state), ['releasable', 'releasable']);
    deepStrictEqual(JSON.parse(run('engineer', ['tmpdir-list'], { TMPDIR: r0 }).stdout).entries.map((e) => e.state), ['releasable', 'releasable']);
    strictEqual(JSON.parse(run('orchestrator', ['tmpdir-release', '--path', text], { TMPDIR: r0 }).stdout).outcome, 'removed');
    strictEqual(JSON.parse(run('engineer', ['tmpdir-release', '--path', other], { TMPDIR: r0 }).stdout).outcome, 'removed');
    deepStrictEqual(fs.readdirSync(r0), []);
  });

  it('a made path through a linked TMPDIR is printed canonical, and the nested make refuses a claimed parent', (t) => {
    const r0 = root(t);
    fs.mkdirSync(join(r0, 'real'));
    fs.symlinkSync(join(r0, 'real'), join(r0, 'link'));
    const text = run('orchestrator', ['tmpdir-make', '--kind', 'text'], { TMPDIR: join(r0, 'link') }).stdout.trimEnd();
    ok(text.startsWith(`${join(r0, 'real')}/agentic-text.`), text);
    const claimed = join(r0, 'real', `.removing-${text.slice(text.lastIndexOf('/') + 1)}`);
    fs.renameSync(text, claimed);
    const r = run('engineer', ['tmpdir-make', '--kind', 'op', '--parent', text], { TMPDIR: r0 });
    deepStrictEqual([r.status, r.stdout], [1, '']);
    ok(r.stderr.startsWith('agentic-dir make: parent-claimed'), r.stderr);
    deepStrictEqual(fs.readdirSync(claimed), ['.agentic-dir.json']);
  });
});
