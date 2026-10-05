// D1 (ADR-0066): every CLI of every persona runs when it is reached through a
// symlinked file, a symlinked directory, a path with a space, '#' and
// non-ASCII characters, and with --preserve-symlinks-main. The old guard,
// import.meta.url === `file://${process.argv[1]}`, exited 0 there having done
// nothing — #812 fixed it in two of engineer's CLIs only.
//
// "Ran" means the CLI answered --help as a CLI: output, exit 0 or 2, and no
// stack trace — a silent exit 0 is the failure this test exists for, and a
// crash is not a run. Under --preserve-symlinks-main a state write must also
// run exactly once (the review found set-terminal running twice there).

import { describe, it, before } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MANIFEST, pluginRoot } from './_personas.mjs';

const GUARD_RE = /isCliEntry\(import\.meta\.url\)|process\.argv\[1\]/;

/** Every script of the persona that has a CLI entry guard. */
function clisOf(persona) {
  const dir = join(pluginRoot(persona), 'scripts');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && GUARD_RE.test(readFileSync(join(dir, f), 'utf8')))
    .sort();
}

function ran(args, label) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTIC_') || key.startsWith('NODE_TEST')) delete env[key];
  const r = spawnSync(process.execPath, [...args, '--help'], { encoding: 'utf8', env, cwd: tmpdir(), input: '' });
  const out = r.stdout + r.stderr;
  ok(out.trim().length > 0,
    `${label}: the CLI exited ${r.status} without output — the entry guard did not recognize it as the entry point`);
  ok(r.status === 0 || r.status === 2, `${label}: exit ${r.status} is not a help/usage answer:\n${out.slice(0, 400)}`);
  ok(!/^\s+at /m.test(out) && !/\bERR_[A-Z_]+/.test(out), `${label}: crashed instead of answering:\n${out.slice(0, 400)}`);
}

for (const persona of MANIFEST.personas) {
  describe(`${persona}: a state write under --preserve-symlinks-main runs exactly once`, () => {
    it('set-terminal through a symlinked plugin directory prints one path and records one history entry', () => {
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
      for (const key of Object.keys(env)) if (key.startsWith('AGENTIC_') || key.startsWith('NODE_TEST')) delete env[key];
      const repo = mkdtempSync(join(tmpdir(), 'pp-once-'));
      const git = (...a) => spawnSync('git', a, { cwd: repo, env, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'chore: init');
      const head = git('rev-parse', 'HEAD').stdout.trim();
      const link = join(mkdtempSync(join(tmpdir(), 'pp-once-link-')), 'plugin');
      symlinkSync(pluginRoot(persona), link, 'dir');
      const state = join(link, 'scripts/state.mjs');
      const run = (...a) => spawnSync(process.execPath, ['--preserve-symlinks-main', state, ...a], { cwd: repo, env, encoding: 'utf8' });
      const created = run('create', '--repo-root', repo, '--verb', 'frame', '--host', 'claude', '--git-baseline-branch', 'main', '--git-baseline-head', head);
      strictEqual(created.status, 0, created.stderr);
      const lines = created.stdout.trim().split('\n');
      strictEqual(lines.length, 1, `create printed ${lines.length} paths`);
      const path = lines[0];
      const r = run('set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete');
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim().split('\n').length, 1, `set-terminal printed:\n${r.stdout}`);
      const updates = (readFileSync(path, 'utf8').match(/event: "updated"/g) ?? []).length;
      strictEqual(updates, 1, `one set-terminal recorded ${updates} history updates`);
    });
  });

  describe(`${persona}: every CLI runs from a non-canonical path`, () => {
    const clis = clisOf(persona);
    let scratch;
    before(() => {
      scratch = mkdtempSync(join(tmpdir(), 'pp-entry-'));
      symlinkSync(pluginRoot(persona), join(scratch, 'linked-plugin'), 'dir');
      const odd = join(scratch, 'a b#ç한', persona);
      mkdirSync(odd, { recursive: true });
      cpSync(pluginRoot(persona), odd, { recursive: true });
      mkdirSync(join(scratch, 'files'));
    });

    it('has the CLIs the plugin ships (sanity: the list is not empty)', () => {
      ok(clis.includes('state.mjs') && clis.includes('peer-runner.mjs') && clis.includes('dispatch-peer.mjs'), clis.join(', '));
    });

    for (const cli of clis) {
      it(`${cli}: through a symlinked file`, () => {
        const link = join(scratch, 'files', `link-${cli}`);
        symlinkSync(join(pluginRoot(persona), 'scripts', cli), link);
        ran([link], `${persona}/${cli} via a symlinked file`);
      });
      it(`${cli}: through a symlinked plugin directory, with and without --preserve-symlinks-main`, () => {
        const path = join(scratch, 'linked-plugin', 'scripts', cli);
        ran([path], `${persona}/${cli} via a symlinked directory`);
        ran(['--preserve-symlinks-main', path], `${persona}/${cli} with --preserve-symlinks-main`);
      });
      it(`${cli}: from a copy under a directory named with a space, '#' and non-ASCII`, () => {
        ran([join(scratch, 'a b#ç한', persona, 'scripts', cli)], `${persona}/${cli} under 'a b#ç한/'`);
      });
    }
  });
}
