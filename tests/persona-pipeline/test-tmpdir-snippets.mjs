// The make and the release a runbook block includes (ADR-0059 Decision 10,
// items 1 and 4; persona-pipeline/snippets/), each branch run once in bash:
// against a persona's real state.mjs, a state.mjs too old to name the
// subcommand, one that cannot be read, and a stand-in that exits as the make
// or the release would on the outcomes a real one reaches only on another
// platform or by a fault. Where the runbooks include them, the verb runbook
// files run the happy path in every shell.

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { snippetText } from '../../scripts/lib/persona-pipeline.mjs';
import { REPO_ROOT } from './_personas.mjs';
import { tmpDir } from '../_tmp.mjs';

const MAKE = snippetText('tmpdir-make');
const RELEASE = snippetText('tmpdir-release');
const ENGINEER = join(REPO_ROOT, 'plugins', 'engineer');

// A plugin root whose scripts/state.mjs is `source` (null: none at all).
function root(t, source) {
  const dir = tmpDir(t, 'snippet-root-');
  mkdirSync(join(dir, 'scripts'));
  if (source !== null) writeFileSync(join(dir, 'scripts', 'state.mjs'), source);
  return dir;
}
// A stand-in that names both subcommands and exits as STUB_RC says, printing
// STUB_OUT on standard output.
const STAND_IN = "// 'tmpdir-make' 'tmpdir-release'\nprocess.stdout.write(process.env.STUB_OUT ?? '');\nprocess.exit(Number(process.env.STUB_RC ?? 0));\n";

function run(t, pluginRoot, script, env = {}) {
  const tmp = env.TMPDIR ?? tmpDir(t, 'snippet-tmp-');
  const r = spawnSync('bash', ['-c', `CLAUDE_PLUGIN_ROOT='${pluginRoot}'\n${script}`], { encoding: 'utf8', env: { ...process.env, ...env, TMPDIR: tmp } });
  return { ...r, tmp };
}
const make = (kind, parent = '') => `MAKE_KIND='${kind}'\nMAKE_PARENT='${parent}'\n${MAKE}\nprintf '%s\\n' "$MADE_DIR"`;
const release = (path) => `echo out\nRELEASE_PATH='${path}'\n${RELEASE}\necho "status=$?"`;

test('the make, with a state.mjs that has it: a marked directory under TMPDIR, released in silence, the block output and status its own', (t) => {
  const m = run(t, ENGINEER, make('text'));
  strictEqual(m.status, 0, m.stderr);
  const dir = m.stdout.trim();
  ok(dir.startsWith(`${m.tmp}/agentic-text.`) && statSync(dir).isDirectory(), dir);
  strictEqual(m.stderr, '');
  const r = run(t, ENGINEER, release(dir), { TMPDIR: m.tmp });
  deepStrictEqual([r.status, r.stdout, r.stderr, existsSync(dir)], [0, 'out\nstatus=0\n', '', false]);
  // A nested op goes with its parent: made inside it.
  const p = run(t, ENGINEER, make('text'));
  const op = run(t, ENGINEER, make('op', p.stdout.trim()), { TMPDIR: p.tmp });
  deepStrictEqual([op.status, op.stdout.trim()], [0, `${p.stdout.trim()}/op`], op.stderr);
  // The release given nothing does nothing.
  deepStrictEqual(run(t, ENGINEER, release('')).stdout, 'out\nstatus=0\n');
});

test('the release forwards the CLI\'s one line for a directory it keeps, and says so when it cannot read the result', (t) => {
  const plain = tmpDir(t, 'snippet-unmarked-');
  const kept = run(t, ENGINEER, release(plain));
  deepStrictEqual([kept.status, kept.stdout, existsSync(plain)], [0, 'out\nstatus=0\n', true]);
  deepStrictEqual(kept.stderr.trim().split('\n').length, 1, kept.stderr);
  ok(kept.stderr.startsWith('agentic-dir release: ') && kept.stderr.includes(JSON.stringify(plain)), kept.stderr);
  // A report that does not parse, or none: one line, the result unknown.
  for (const out of ['not json', '']) {
    const u = run(t, root(t, STAND_IN), release(plain), { STUB_OUT: out, STUB_RC: '13' });
    deepStrictEqual([u.status, u.stdout, u.stderr], [0, 'out\nstatus=0\n', `agentic-dir release: the result is unknown; the directory may remain at ${plain} or at its .removing- path\n`]);
  }
});

test('an older state.mjs: the make falls back to mktemp -d, the release keeps the directory with one line; one that cannot be read stops the make', (t) => {
  const old = root(t, '// no tmpdir subcommands\n');
  const m = run(t, old, make('text'));
  strictEqual(m.status, 0, m.stderr);
  ok(m.stdout.trim().startsWith(`${m.tmp}/agentic-text.`) && existsSync(m.stdout.trim()), m.stdout);
  strictEqual(m.stderr, '');
  const r = run(t, old, release(m.stdout.trim()));
  deepStrictEqual([r.stdout, r.stderr], ['out\nstatus=0\n', `agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at ${m.stdout.trim()}\n`]);
  // A legacy nested op: mkdir in the parent.
  const p = tmpDir(t, 'snippet-legacy-');
  const op = run(t, old, make('op', p));
  deepStrictEqual([op.status, op.stdout.trim(), existsSync(join(p, 'op'))], [0, join(p, 'op'), true], op.stderr);
  const gone = run(t, root(t, null), make('text'));
  deepStrictEqual([gone.status, gone.stdout], [1, ''], gone.stderr);
  ok(gone.stderr.includes('/scripts/state.mjs; no directory was made.'), gone.stderr);
});

test('the make\'s other outcomes: unsupported falls back with a line, a legacy parent makes op the old way, an uncarriable TMPDIR and any other failure stop', (t) => {
  const stand = root(t, STAND_IN);
  const u = run(t, stand, make('op'), { STUB_RC: '3' });
  strictEqual(u.status, 0, u.stderr);
  ok(u.stdout.trim().startsWith(`${u.tmp}/agentic-op.`) && existsSync(u.stdout.trim()), u.stdout);
  strictEqual(u.stderr, `agentic-dir make: unsupported on this platform; ${u.stdout.trim()} was made with mktemp -d and will not be released\n`);
  const p = tmpDir(t, 'snippet-parent-');
  const legacy = run(t, stand, make('op', p), { STUB_RC: '4' });
  deepStrictEqual([legacy.status, legacy.stdout.trim(), legacy.stderr], [0, join(p, 'op'), '']);
  // The op already there: the fallback refuses rather than share it.
  const again = run(t, stand, make('op', p), { STUB_RC: '4' });
  deepStrictEqual([again.status, again.stdout], [1, '']);
  const path = run(t, stand, make('text'), { STUB_RC: '5' });
  deepStrictEqual([path.status, path.stdout], [1, '']);
  ok(path.stderr.includes('set TMPDIR to a path without one'), path.stderr);
  const failed = run(t, stand, make('text'), { STUB_RC: '1' });
  deepStrictEqual([failed.status, failed.stdout, failed.stderr], [1, '', '']);
  // A fallback's path is checked as the make checks its own: a TMPDIR with a
  // quote stops the block.
  const quoted = join(tmpDir(t, 'snippet-quote-'), "it's");
  mkdirSync(quoted);
  const q = run(t, root(t, '// old\n'), make('text'), { TMPDIR: quoted });
  deepStrictEqual([q.status, q.stdout], [1, '']);
  ok(q.stderr.includes('a single-quoted shell literal cannot carry'), q.stderr);
});

test('under errexit the make still falls back and the release still reports, leaving the block its status', (t) => {
  const old = run(t, root(t, '// old\n'), `set -e\n${make('text')}`);
  deepStrictEqual([old.status, old.stderr], [0, '']);
  ok(existsSync(old.stdout.trim()), old.stdout);
  const unsupported = run(t, root(t, STAND_IN), `set -e\n${make('text')}`, { STUB_RC: '3' });
  strictEqual(unsupported.status, 0, unsupported.stderr);
  const plain = tmpDir(t, 'snippet-errexit-');
  for (const [pluginRoot, env, line] of [
    [root(t, null), {}, 'cannot read'],
    [root(t, STAND_IN), { STUB_OUT: '', STUB_RC: '13' }, 'the result is unknown'],
    [ENGINEER, {}, 'the directory is kept at'],
  ]) {
    const r = run(t, pluginRoot, `set -e\n${release(plain)}`, env);
    deepStrictEqual([r.status, r.stdout], [0, 'out\nstatus=0\n'], r.stderr);
    ok(r.stderr.includes(line), r.stderr);
  }
});
