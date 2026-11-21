// C180 part 2, C48 (ADR-0066 D1): every CLI entry guard outside tests is
// isCliEntry(import.meta.url), imported from its own package's copy of
// persona-pipeline/files/scripts/lib/cli-entry.mjs (scripts/ from the
// re-export in scripts/lib/cli-entry.mjs). The guards this replaced compared
// import.meta.url with `file://${argv[1]}` (silent exit 0 through a symlink or
// under a name that needs URL escaping), resolve(argv[1]) with the module's
// path (silent through a symlink), or realpaths alone, which an import cycle
// defeats under --preserve-symlinks-main: orchestrator state.mjs set-terminal
// imports session-handoff.mjs, which imports state.mjs again by its real
// path, and the CLI ran twice (measured 2026-11-21: two paths, two history
// entries). isCliEntry lets the first instance of a file claim the entry.
//
// One exception, by file and exact line: the autopilot launcher template is
// installed as a lone executable with no sibling to import (its own comment
// says so), so it keeps an inline guard comparing both sides canonical.
//
// The scan walks the filesystem, not `git ls-files`: an untracked new guard is
// what this should catch, and the mutation harness runs it in a copy with no
// .git. The behaviour half runs every CLI the scan finds, outside the persona
// plugins (tests/persona-pipeline/test-cli-entry-guard.mjs runs theirs), from
// the repository, from a copy under a directory whose name needs URL escaping,
// through a file symlink, and through a directory symlink kept in
// import.meta.url, and compares the outputs: a guard that misses its entry
// prints nothing, and one that lets the CLI run twice prints twice.

import { describe, it, before } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileTmpDirs, tmpDir } from '../_tmp.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = 'persona-pipeline/files/scripts/lib/cli-entry.mjs';
const CODE = /\.(?:mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['tests', 'fixtures', 'node_modules', '.git', 'mutation-specs', 'vendor']);
const PERSONAS = ['engineer', 'designer', 'founder'];

// The one inline guard the rule allows: the file, and its line exactly.
const ALLOWED_INLINE = new Map([
  [
    'plugins/orchestrator/adapters/claude/autopilot/launcher.template.mjs',
    '  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }',
  ],
]);

/** The package a repository path belongs to: what an import may not leave. */
function packageOf(rel) {
  const [top, second] = rel.split('/');
  if (top === 'plugins') return `plugins/${second}`;
  return top;
}

/** The copies of the canonical helper an entry may import, by package. */
const COPY_OF = new Map([
  ['persona-pipeline', SOURCE],
  ['scripts', 'scripts/lib/cli-entry.mjs'],
  ['companions', 'companions/cli-entry.mjs'],
  ['plugins/companions', 'plugins/companions/scripts/cli-entry.mjs'],
  ...['runtime', 'image', 'orchestrator', 'attention', ...PERSONAS]
    .map((p) => [`plugins/${p}`, `plugins/${p}/scripts/lib/cli-entry.mjs`]),
]);

function productionCode(root = REPO_ROOT) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child);
      } else if (entry.isFile() && CODE.test(entry.name)) {
        out.push(child);
      }
    }
  };
  for (const top of ['companions', 'plugins', 'persona-pipeline', 'scripts', 'kit']) walk(top);
  return out.sort();
}

const isComment = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/**
 * Whether a code line is an entry guard of a form other than isCliEntry: a
 * comparison of argv[1] with the module (as a URL, a path or a realpath), a
 * realpath of argv[1], a comparison with import.meta.url or with the module's
 * own path, or Node's import.meta.main / CommonJS require.main.
 */
function isOtherGuard(line) {
  if (isComment(line)) return false;
  const compares = /[!=]==/.test(line);
  if (/realpathSync\(\s*(?:process\.)?argv\[1\]/.test(line)) return true;
  if (/\bargv\[1\]/.test(line) && compares && /import\.meta|fileURLToPath|pathToFileURL|\bSELF\b/.test(line)) return true;
  if (/import\.meta\.url\s*[!=]==|[!=]==\s*import\.meta\.url\b/.test(line)) return true;
  if (compares && /fileURLToPath\(import\.meta\.url\)/.test(line)) return true;
  if (/\bimport\.meta\.main\b|\brequire\.main\s*[!=]==/.test(line)) return true;
  return false;
}

/** Every finding of the rule in the tree at `root`, and the entries that pass. */
function scan(root = REPO_ROOT) {
  const findings = [];
  const entries = [];
  const allowedSeen = [];
  // Every file with an entry guard of any form: the behaviour half runs these,
  // so a guard put back in an old form is still run, and fails there too.
  const guarded = new Set();
  for (const rel of productionCode(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!isOtherGuard(line)) return;
      if (ALLOWED_INLINE.get(rel) === line) {
        allowedSeen.push(rel);
        return;
      }
      findings.push(`${rel}:${i + 1}: an entry guard other than isCliEntry(import.meta.url): ${line.trim()}`);
      guarded.add(rel);
    });
    const calls = lines.some((line) => !isComment(line) && /\bisCliEntry\(import\.meta\.url\)/.test(line));
    const binding = text.match(/^import \{[^}]*\bisCliEntry\b[^}]*\} from ['"]([^'"]+)['"];?$/m);
    if (!calls && !binding) continue;
    if (calls) guarded.add(rel);
    if (!calls) {
      findings.push(`${rel}: imports isCliEntry but never calls isCliEntry(import.meta.url)`);
      continue;
    }
    if (!binding) {
      findings.push(`${rel}: calls isCliEntry(import.meta.url) without importing it from its package's copy`);
      continue;
    }
    const target = relative(root, resolve(root, dirname(rel), binding[1])).split(sep).join('/');
    const pkg = packageOf(rel);
    const expected = COPY_OF.get(pkg);
    if (target !== expected) {
      findings.push(`${rel}: imports isCliEntry from ${target}; its package (${pkg}) has ${expected ?? 'no copy'}`);
      continue;
    }
    entries.push(rel);
  }
  return { findings, entries, allowedSeen, guarded: [...guarded].sort() };
}

describe('every CLI entry guard is the canonical isCliEntry (C180, C48)', () => {
  it('the detector recognizes each guard form it replaced, and not isCliEntry or a comment', () => {
    for (const old of [
      'if (import.meta.url === `file://${process.argv[1]}`) {',
      'const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
      '  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
      'if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {',
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {",
      '    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
      "const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';",
      'if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {',
      '  try { return realpathSync(process.argv[1]) === realpathSync(SELF); } catch { return false; }',
      'if (import.meta.main) {',
      'if (require.main === module) {',
    ]) ok(isOtherGuard(old), `not recognized: ${old}`);
    for (const fine of [
      'if (isCliEntry(import.meta.url)) {',
      '// import.meta.url === `file://${process.argv[1]}`, compared a URL with a path:',
      "  \"import(require('node:url').pathToFileURL(process.argv[1]).href).catch(() => {})\" +",
      'const SELF = fileURLToPath(import.meta.url);',
    ]) strictEqual(isOtherGuard(fine), false, `recognized wrongly: ${fine}`);
  });

  it('no production file guards its CLI any other way, and each isCliEntry comes from its package\'s copy', () => {
    const { findings, entries, allowedSeen } = scan();
    strictEqual(findings.join('\n'), '', 'entry guards outside the rule');
    // Identity, not a count: the scan reached an entry of every package the
    // rule covers, and the one allowed inline guard where it is.
    for (const rel of [
      'plugins/runtime/scripts/doctor.mjs',
      'plugins/runtime/scripts/retention.mjs',
      'plugins/image/scripts/compose-dispatch.mjs',
      'plugins/orchestrator/scripts/state.mjs',
      'plugins/orchestrator/scripts/session-handoff.mjs',
      'plugins/orchestrator/adapters/claude/autopilot/cli.mjs',
      'plugins/attention/scripts/discover-runtime.mjs',
      'companions/codex-companion.mjs',
      'plugins/companions/scripts/discover-peer.mjs',
      'plugins/engineer/scripts/state.mjs',
      'persona-pipeline/files/scripts/state.mjs',
      'scripts/shard-tests.mjs',
      'scripts/mutation-harness.mjs',
    ]) ok(entries.includes(rel), `${rel} is an isCliEntry entry the scan found`);
    deepStrictEqual(allowedSeen, [...ALLOWED_INLINE.keys()], 'the allowed inline guard is where the rule names it, once');
  });

  it('a simulated Windows argv never makes a module the entry, and never throws', async () => {
    const { isCliEntry } = await import(pathToFileURL(join(REPO_ROOT, SOURCE)).href);
    const self = pathToFileURL(join(REPO_ROOT, SOURCE)).href;
    strictEqual(isCliEntry(self, 'C:\\Users\\dev\\plugins\\runtime\\scripts\\doctor.mjs'), false);
    strictEqual(isCliEntry('file:///C:/Users/dev/plugins/runtime/scripts/doctor.mjs', 'C:\\Users\\dev\\plugins\\runtime\\scripts\\doctor.mjs'), false);
    strictEqual(isCliEntry(self, undefined), false);
    strictEqual(isCliEntry(self, ''), false);
  });
});

// The behaviour half: every entry outside the persona plugins, with the
// arguments its run takes. Most answer --help; a tool that reads its first
// argument as a path or a spec gets one that fails fast, the same way from any
// spelling. Every run has an empty working directory of its own.
const ARGS = new Map([
  ['scripts/mutation-harness.mjs', ['--cli-entry-probe']],
  ['scripts/validate-artifacts.mjs', ['./no-such-repository']],
]);

function behaviourEntries() {
  return scan().guarded.filter((rel) => {
    const pkg = packageOf(rel);
    return pkg !== 'persona-pipeline' && !PERSONAS.some((p) => pkg === `plugins/${p}`);
  });
}

const shared = fileTmpDirs();

describe('each CLI acts exactly once from any spelling of its path (C180, C48)', () => {
  const entries = behaviourEntries();
  const tops = [...new Set(entries.map(packageOf)), 'persona-pipeline'];
  let escaped;
  let dirLink;
  let fileLinks;
  let cwd;
  before(() => {
    const base = shared('cli-entry-');
    escaped = join(base, 'space home #홈');
    for (const top of tops) cpSync(join(REPO_ROOT, top), join(escaped, top), { recursive: true });
    cpSync(join(REPO_ROOT, 'package.json'), join(escaped, 'package.json'));
    // A repository tool may import a shared test helper (replay-args-file-corpus
    // imports tests/_args-file-replay.mjs): the top-level helpers go along.
    mkdirSync(join(escaped, 'tests'));
    for (const name of readdirSync(join(REPO_ROOT, 'tests'))) {
      if (/^_.*\.mjs$/.test(name)) cpSync(join(REPO_ROOT, 'tests', name), join(escaped, 'tests', name));
    }
    dirLink = join(base, 'install-link');
    symlinkSync(escaped, dirLink, 'dir');
    fileLinks = join(base, 'file-links');
    mkdirSync(fileLinks);
    cwd = join(base, 'cwd');
    mkdirSync(cwd);
  });

  it('runs a CLI of every covered package, not an empty list', () => {
    for (const pkg of ['plugins/runtime', 'plugins/image', 'plugins/orchestrator', 'plugins/attention', 'companions', 'plugins/companions', 'scripts']) {
      ok(entries.some((rel) => packageOf(rel) === pkg), `an entry of ${pkg} is run`);
    }
  });

  const spellings = (root) => {
    const real = realpathSync(root);
    return [...new Set([pathToFileURL(real).href, pathToFileURL(root).href, `file://${real}`, `file://${root}`, real, root])]
      .sort((a, b) => b.length - a.length);
  };
  const run = (root, rel, { script = join(root, rel), nodeArgs = [] } = {}) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTIC_') || key.startsWith('NODE_TEST')) delete env[key];
    const r = spawnSync(process.execPath, [...nodeArgs, script, ...(ARGS.get(rel) ?? ['--help'])],
      { cwd, env, encoding: 'utf8', input: '', timeout: 60_000 });
    let out = `${r.stdout}\n--stderr--\n${r.stderr}`;
    for (const s of spellings(root)) out = out.split(s).join('<ROOT>');
    return { status: r.status, signal: r.signal, out };
  };

  for (const rel of entries) {
    it(`${rel}: the same run from the repository, an escaped path, a file symlink and a kept directory symlink`, () => {
      const reference = run(REPO_ROOT, rel);
      strictEqual(reference.signal, null, `${rel} was stopped by ${reference.signal}`);
      ok(reference.out.replace('--stderr--', '').trim().length > 0, `${rel}: the reference run prints something to compare`);
      deepStrictEqual(run(escaped, rel), reference, `${rel}: a path needing URL escaping (a space, '#', Hangul)`);
      const link = join(fileLinks, rel.split('/').join('__'));
      if (!existsSync(link)) symlinkSync(join(escaped, rel), link, 'file');
      deepStrictEqual(run(escaped, rel, { script: link }), reference, `${rel}: a loose file symlink`);
      deepStrictEqual(run(dirLink, rel, { nodeArgs: ['--preserve-symlinks-main'] }), reference,
        `${rel}: a directory symlink kept in import.meta.url (--preserve-symlinks-main)`);
    });

    it(`${rel}: an import of the module runs no CLI`, () => {
      const env = { ...process.env, CLI_ENTRY_MODULE: pathToFileURL(join(REPO_ROOT, rel)).href };
      for (const key of Object.keys(env)) if (key.startsWith('AGENTIC_') || key.startsWith('NODE_TEST')) delete env[key];
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        'await import(process.env.CLI_ENTRY_MODULE); process.stdout.write("IMPORTED")'],
      { cwd, env, encoding: 'utf8', input: '', timeout: 60_000 });
      deepStrictEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: 'IMPORTED', stderr: '' },
        `${rel}: importing it printed, exited or failed as a CLI would`);
    });
  }
});

describe('orchestrator state.mjs writes once under --preserve-symlinks-main (C48)', () => {
  it('set-terminal through a symlinked plugin directory prints one path and records one update', (t) => {
    const base = tmpDir(t, 'orch-once-');
    const env = { ...process.env, HOME: join(base, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTIC_') || key.startsWith('NODE_TEST')) delete env[key];
    mkdirSync(env.HOME);
    const repo = join(base, 'repo');
    mkdirSync(repo);
    const git = (...a) => spawnSync('git', a, { cwd: repo, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'chore: init');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const link = join(base, 'plugin');
    symlinkSync(join(REPO_ROOT, 'plugins/orchestrator'), link, 'dir');
    const state = (...a) => spawnSync(process.execPath, ['--preserve-symlinks-main', join(link, 'scripts/state.mjs'), ...a],
      { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
    const created = state('create', '--repo-root', repo, '--verb', 'plan', '--host', 'claude',
      '--git-baseline-branch', 'main', '--git-baseline-head', head);
    strictEqual(created.status, 0, created.stderr);
    const workflow = created.stdout.trim();
    strictEqual(workflow.split('\n').length, 1, `create printed ${workflow.split('\n').length} paths`);
    const updates = () => (readFileSync(workflow, 'utf8').match(/event: "updated"/g) ?? []).length;
    const before = updates();
    const done = state('set-terminal', '--workflow-path', workflow, '--host', 'claude', '--terminal-phase', 'finalized');
    strictEqual(done.status, 0, done.stderr);
    deepStrictEqual(done.stdout.trim().split('\n'), [workflow], 'set-terminal printed its path once');
    strictEqual(updates() - before, 1, 'set-terminal recorded one update');
  });
});
