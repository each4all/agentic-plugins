// scripts/phase7-commit.mjs — a commit subject's type and scope checked against
// the change it commits (ADR-0028 §P6, implementation note of 2026-11-04, C163).
//
// Only in a repository whose release-please configuration names packages: a
// commit touching a package takes feat or fix and a scope naming the package
// (a change under plugins/runtime/data/ is one, named as such); a commit
// touching no package path (routing class `docs-only`) is docs when its
// content is documentation only, test when it is tests only, and chore, ci or
// refactor otherwise. With no package map nothing changes. Interactively a
// subject that does not fit is a warning with the corrected subject; under
// autopilot it is refused (exit 9) before anything is written, and the
// subjects are the commit worker's, from files, never the topic cut short.
//
// One suite per persona the module is generated into (ADR-0066 Decision 5);
// the autopilot cases need dispatch_target, which autopilot activation reads.
// The `plugins/engineer` and `plugins/runtime` keys are this repository's
// release-please packages (commit-routing data), not the persona under test.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';

const PACKAGES = ['companions', 'plugins/companions', 'plugins/engineer', 'plugins/runtime'];
const AUTOPILOT_RUN_ID = 'autopilot-20261104T010203Z-abcdef';

describe('the subject-type suite reaches every persona with the commit driver (guards a vacuous pass)', () => {
  it('names at least the engineer', () => {
    ok(personasFor('scripts/phase7-commit.mjs').includes('engineer'), personasFor('scripts/phase7-commit.mjs').join(','));
  });
});

for (const persona of personasFor('scripts/phase7-commit.mjs')) {
  const P = personaInfo(persona);
  const PHASE7_BIN = P.path('scripts/phase7-commit.mjs');
  const STATE_BIN = P.path('scripts/state.mjs');
  const itDispatchOn = P.capabilities.dispatch_target ? it : () => {};
  const REL_PLEASE_CFG = resolve(REPO_ROOT, 'release-please-config.json');

  const { changeContent, subjectRule, checkSubjectRule, inferSubject, packageScopes } =
    await import(pathToFileURL(PHASE7_BIN).href);

  // ---------------------------------------------------------------------------
  // The rule, as pure functions.

  describe(`${persona}: subjectRule / checkSubjectRule — the rule (ADR-0028 §P6, 2026-11-04)`, () => {
    it('applies only with a package map: none, or an empty one, checks nothing', () => {
      strictEqual(subjectRule({ packageKey: null, files: ['README.md'], packageMap: [] }), null);
      strictEqual(subjectRule({ packageKey: null, files: ['README.md'], packageMap: null }), null);
      deepStrictEqual(checkSubjectRule({ subject: 'feat: anything', rule: null }), { ok: true, problems: [], corrected: 'feat: anything' });
    });

    it('a package commit takes feat or fix and a scope naming the package', () => {
      const rule = subjectRule({ packageKey: 'plugins/engineer', files: ['plugins/engineer/a.mjs'], packageMap: PACKAGES });
      deepStrictEqual([rule.allowed_types, rule.scopes], [['feat', 'fix'], ['engineer', 'plugins/engineer', 'plugin/engineer']]);
      strictEqual(checkSubjectRule({ subject: 'feat(engineer): add a', rule }).ok, true);
      strictEqual(checkSubjectRule({ subject: 'fix(plugin/engineer)!: drop a', rule }).ok, true);
      const chore = checkSubjectRule({ subject: 'chore(engineer): add a', rule });
      deepStrictEqual([chore.ok, chore.corrected], [false, 'fix(engineer): add a']);
      match(chore.problems[0], /type 'chore' is not feat or fix: it touches release-please package plugins\/engineer/);
      const noScope = checkSubjectRule({ subject: 'feat: add a', rule });
      deepStrictEqual([noScope.ok, noScope.corrected], [false, 'feat(engineer): add a']);
      match(noScope.problems[0], /names no scope/);
      const other = checkSubjectRule({ subject: 'feat(runtime)!: add a', rule });
      deepStrictEqual([other.ok, other.corrected], [false, 'feat(engineer)!: add a']);
      match(other.problems[0], /scope 'runtime' does not name package plugins\/engineer/);
    });

    it('a scope that is another package\'s own is not this one\'s (companions against plugins/companions)', () => {
      deepStrictEqual(packageScopes('plugins/companions', PACKAGES), ['plugin/companions', 'plugins/companions']);
      deepStrictEqual(packageScopes('companions', PACKAGES), ['companions']);
      const rule = subjectRule({ packageKey: 'plugins/companions', files: ['plugins/companions/x.mjs'], packageMap: PACKAGES });
      strictEqual(checkSubjectRule({ subject: 'fix(companions): x', rule }).ok, false);
    });

    it('a change under plugins/runtime/data/ is named as such, and takes feat or fix', () => {
      const rule = subjectRule({ packageKey: 'plugins/runtime', files: ['plugins/runtime/data/plugin-set.json'], packageMap: PACKAGES });
      deepStrictEqual(rule.allowed_types, ['feat', 'fix']);
      match(rule.reason, /plugins\/runtime\/data\//);
      const v = checkSubjectRule({ subject: 'chore(runtime): bump the plugin set', rule });
      deepStrictEqual([v.ok, v.corrected], [false, 'fix(runtime): bump the plugin set']);
      match(v.problems[0], /plugins\/runtime\/data\/, whose assets runtime commands read from the installed plugin/);
      // Control: the same package without its data names only the package.
      ok(!/data/.test(subjectRule({ packageKey: 'plugins/runtime', files: ['plugins/runtime/b.mjs'], packageMap: PACKAGES }).reason));
    });

    it('a commit touching no package path is never feat or fix: docs, test, or chore/ci/refactor by content', () => {
      const cases = [
        [['docs/adr/0028-x.md', 'AGENTS.md'], 'documentation', ['docs']],
        [['tests/persona-pipeline/test-x.mjs', 'tests/fixtures/notes.md'], 'tests', ['test']],
        [['scripts/x.mjs', 'docs/a.md'], 'other', ['chore', 'ci', 'refactor']],
        [['.github/workflows/full-tests.yml'], 'other', ['chore', 'ci', 'refactor']],
        // Documentation is prose by its extension: a script under docs/ and a
        // .txt build input are not.
        [['docs/tools/check.mjs'], 'other', ['chore', 'ci', 'refactor']],
        [['requirements.txt', 'CMakeLists.txt'], 'other', ['chore', 'ci', 'refactor']],
      ];
      for (const [files, content, allowed] of cases) {
        strictEqual(changeContent(files), content, files.join(','));
        const rule = subjectRule({ packageKey: null, files, packageMap: PACKAGES });
        deepStrictEqual([rule.content, rule.allowed_types, rule.scopes], [content, allowed, null], files.join(','));
        match(rule.reason, /touches no release-please package path \(routing class docs-only\)/);
        for (const type of ['feat', 'fix']) {
          const v = checkSubjectRule({ subject: `${type}(adr): x`, rule });
          deepStrictEqual([v.ok, v.corrected], [false, `${allowed[0]}(adr): x`], `${type} on ${files.join(',')}`);
        }
        strictEqual(checkSubjectRule({ subject: `${allowed[0]}(anything): x`, rule }).ok, true, 'its scope is free');
      }
      // The routing class and the content are two names: docs-only routing with
      // test content is `test`, not `docs`.
      const rule = subjectRule({ packageKey: null, files: ['tests/a.mjs'], packageMap: PACKAGES });
      strictEqual(checkSubjectRule({ subject: 'docs: a', rule }).ok, false);
    });

    it('a subject that is not a conventional commit fails with no correction', () => {
      const rule = subjectRule({ packageKey: null, files: ['README.md'], packageMap: PACKAGES });
      const v = checkSubjectRule({ subject: 'update the readme', rule });
      deepStrictEqual([v.ok, v.corrected], [false, null]);
    });

    it('an empty description fails, whatever the type', () => {
      const rule = subjectRule({ packageKey: 'plugins/engineer', files: ['plugins/engineer/a.mjs'], packageMap: PACKAGES });
      const v = checkSubjectRule({ subject: 'fix(engineer):', rule });
      strictEqual(v.ok, false);
      match(v.problems.join('; '), /its description is empty/);
    });

    it('a root package (".") owns the paths no other package does: they are left unchecked', () => {
      const map = ['.', 'packages/web'];
      strictEqual(subjectRule({ packageKey: null, files: ['src/a.js'], packageMap: map }), null);
      ok(subjectRule({ packageKey: 'packages/web', files: ['packages/web/a.js'], packageMap: map }) !== null);
    });

    it('inferSubject keeps the verb\'s type where the change allows it and corrects it where not', () => {
      const fm = (verb, profile) => ({ verb, profile, original_request: 'the topic' });
      const at = (frontmatter, packageKey, files) => inferSubject({ packageKey, frontmatter, packageMap: PACKAGES, files });
      strictEqual(at(fm('compose', 'code'), 'plugins/engineer', ['plugins/engineer/a.mjs']), 'feat(engineer): the topic');
      strictEqual(at(fm('critique', ''), 'plugins/engineer', ['plugins/engineer/a.mjs']), 'fix(engineer): the topic');
      strictEqual(at(fm('compose', 'code'), null, ['docs/adr/x.md']), 'docs: the topic');
      strictEqual(at(fm('refine', ''), null, ['tests/a.mjs']), 'test: the topic');
      strictEqual(at(fm('critique', ''), null, ['scripts/x.mjs']), 'chore: the topic');
      // With no package map the verb alone decides, as before.
      strictEqual(inferSubject({ packageKey: null, frontmatter: fm('compose', 'code'), packageMap: [], files: ['README.md'] }), 'feat: the topic');
    });
  });

  // ---------------------------------------------------------------------------
  // The driver, against a sandbox repository.

  function env(extra = {}) {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (k.startsWith('AGENTIC_')) delete e[k];
    delete e.ACCEPT_CURRENT_TREE;
    return { ...e, AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator'), ...extra };
  }
  const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
  const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env() }).trimEnd();
  function run(cwd, args, extra = {}) {
    const r = spawnSync('node', [PHASE7_BIN, ...args], { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
  }

  async function withSandbox(fn, { config = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-subject-'));
    const texts = await mkdtemp(join(tmpdir(), 'phase7-subject-texts-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'feat/s'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'phase7-subject'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'phase7-subject@example.invalid'], { cwd: dir });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
      if (config) await writeFile(join(dir, 'release-please-config.json'), await readFile(REL_PLEASE_CFG, 'utf8'));
      await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
      await writeFile(join(dir, 'README.md'), '# sandbox\n');
      for (const d of ['plugins/engineer', 'plugins/runtime/data', 'docs', 'tests']) await mkdir(join(dir, d), { recursive: true });
      await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 0;\n');
      await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 0;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-qm', 'chore: sandbox baseline', '--no-verify'], { cwd: dir });
      let n = 0;
      const subject = async (text) => {
        const file = join(texts, `subject-${(n += 1)}.txt`);
        await writeFile(file, `${text}\n`);
        return file;
      };
      await fn(dir, subject);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(texts, { recursive: true, force: true });
    }
  }

  function digest(dir) {
    return execFileSync('shasum', ['-a', '256'], {
      input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
      encoding: 'utf8',
    }).trim().split(/\s+/)[0];
  }

  // A verb-chain workflow whose last verb asked for a commit, with `paths` in
  // its manifest.
  function workflow(dir, paths, { verb = 'compose', profile = 'code', request = 'the change' } = {}) {
    const wf = sh(dir, 'node', [
      STATE_BIN, 'create', '--repo-root', dir, '--verb', verb, '--profile', profile, '--persona', persona,
      '--host', 'claude', '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
      '--status-digest', digest(dir), '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
      '--original-request', request,
    ]);
    for (const p of paths) sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', p, '--op', 'edit']);
    sh(dir, 'node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'commit',
      '--next-step-confidence', 'HIGH', '--event', 'updated']);
    return wf;
  }

  const planOf = (dir, wf) => {
    const r = run(dir, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude']);
    strictEqual(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const auto = (dir, wf, ...extra) => run(dir, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', ...extra], AP);
  const execute = (dir, wf, ...extra) => run(dir, ['--mode', 'execute', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--confirm-non-interactive', ...extra]);
  const snapshot = async (dir, wf) => ({
    head: sh(dir, 'git', ['rev-parse', 'HEAD']),
    staged: sh(dir, 'git', ['diff', '--cached', '--name-only']),
    wf: await readFile(wf, 'utf8'),
  });
  const subjectOf = (dir, rev = 'HEAD') => sh(dir, 'git', ['log', '-1', '--format=%s', rev]);

  describe(`${persona}: plan mode — each commit's subject_rule, and a suggestion that meets it`, () => {
    it('a mixed change is decided by its package part; a split names each commit\'s rule', async () => {
      await withSandbox(async (dir) => {
        // single-package-with-docs: the docs fold into the package commit.
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'docs/note.md'], { verb: 'critique', profile: '' });
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'docs', 'note.md'), 'note\n');
        const p = planOf(dir, wf);
        strictEqual(p.classification, 'single-package-with-docs');
        strictEqual(p.commits.length, 1);
        deepStrictEqual([p.commits[0].subject_rule.allowed_types, p.commits[0].subject_rule.scopes[0]], [['feat', 'fix'], 'engineer']);
        // critique suggested `chore`; the package part makes it `fix`.
        strictEqual(p.commits[0].suggested_subject, 'fix(engineer): the change');
        ok(p.notes.some((n) => n.startsWith('subject_rule —')), p.notes.join('\n'));
      });
      await withSandbox(async (dir) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'plugins/runtime/b.mjs', 'docs/note.md']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
        await writeFile(join(dir, 'docs', 'note.md'), 'note\n');
        const p = planOf(dir, wf);
        strictEqual(p.classification, 'multi-package-with-docs');
        deepStrictEqual(p.commits.map((c) => [c.package, c.subject_rule.allowed_types, c.suggested_subject]), [
          ['plugins/engineer', ['feat', 'fix'], 'feat(engineer): the change'],
          ['plugins/runtime', ['feat', 'fix'], 'feat(runtime): the change'],
          [null, ['docs'], 'docs: the change'],
        ]);
      });
    });

    it('a consumer repository with no release-please configuration: no rule, the suggestion as before, and execute does not warn', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['README.md']);
        await writeFile(join(dir, 'README.md'), '# sandbox\nconsumer\n');
        const p = planOf(dir, wf);
        deepStrictEqual([p.package_map, p.commits[0].subject_rule, p.commits[0].suggested_subject], [[], null, 'feat: the change']);
        ok(!p.notes.some((n) => n.startsWith('subject_rule —')), p.notes.join('\n'));
        const r = execute(dir, wf, '--subject-file', await subject('feat: a readme line'));
        strictEqual(r.code, 0, r.stderr);
        ok(!/does not fit the change/.test(r.stderr), r.stderr);
        strictEqual(subjectOf(dir), 'feat: a readme line');
      }, { config: false });
    });
  });

  describe(`${persona}: execute — interactively a warning with the corrected subject`, () => {
    it('a feat on a documentation-only change outside every package commits as given, with the warning', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['docs/note.md']);
        await writeFile(join(dir, 'docs', 'note.md'), 'note\n');
        const r = execute(dir, wf, '--subject-file', await subject('feat(adr): record the rule'));
        strictEqual(r.code, 0, r.stderr);
        match(r.stderr, /⚠ subject "feat\(adr\): record the rule" \(commit 1\/1, package=docs\) does not fit the change it commits: type 'feat' is not docs/);
        match(r.stderr, /Corrected subject: docs\(adr\): record the rule/);
        strictEqual(subjectOf(dir), 'feat(adr): record the rule');
      });
    });

    it('a subject that fits draws no warning (control)', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['docs/note.md']);
        await writeFile(join(dir, 'docs', 'note.md'), 'note\n');
        const r = execute(dir, wf, '--subject-file', await subject('docs(adr): record the rule'));
        strictEqual(r.code, 0, r.stderr);
        ok(!/does not fit the change/.test(r.stderr), r.stderr);
      });
    });
  });

  describe(`${persona}: --mode autopilot — the worker's subject, checked, or refused with nothing written`, () => {
    itDispatchOn('a type that does not route the package, or a scope that does not name it, is refused (exit 9); the fitting subject commits', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const before = await snapshot(dir, wf);
        for (const [text, why] of [
          ['chore(engineer): set a to 1', /type 'chore' is not feat or fix/],
          ['feat(runtime): set a to 1', /scope 'runtime' does not name package plugins\/engineer/],
          ['fix: set a to 1', /names no scope/],
        ]) {
          const r = auto(dir, wf, '--subject-file', await subject(text));
          strictEqual(r.code, 9, `${text}: ${r.stderr}`);
          match(r.stderr, why);
          match(r.stderr, /✗ refused under autopilot: nothing was committed and nothing was written/);
          deepStrictEqual(await snapshot(dir, wf), before, `${text}: nothing written`);
        }
        const r = auto(dir, wf, '--subject-file', await subject('fix(engineer): set a to 1'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'committed');
        strictEqual(subjectOf(dir), 'fix(engineer): set a to 1');
      });
    });

    itDispatchOn('a change under plugins/runtime/data/ without feat or fix is refused, naming the data', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/runtime/data/plugin-set.json']);
        await writeFile(join(dir, 'plugins', 'runtime', 'data', 'plugin-set.json'), '{}\n');
        const before = await snapshot(dir, wf);
        const r = auto(dir, wf, '--subject-file', await subject('chore(runtime): refresh the plugin set'));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /plugins\/runtime\/data\//);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
    });

    itDispatchOn('no subject, or --suggested-subjects, is refused; so is a description that is the topic cut short', async () => {
      const topic = 'Macro 7 C163 A4: the commit subject is never compared with the change it commits, so every landing is retitled';
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs'], { request: topic });
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const before = await snapshot(dir, wf);
        let r = auto(dir, wf);
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /no subject was given, and the suggested one is not used here/);
        deepStrictEqual(await snapshot(dir, wf), before);
        r = auto(dir, wf, '--suggested-subjects');
        strictEqual(r.code, 2, r.stderr);
        match(r.stderr, /--suggested-subjects is refused by --mode autopilot/);
        deepStrictEqual(await snapshot(dir, wf), before);
        // The suggestion's own text, written to the file as it stands.
        const suggested = planOf(dir, wf).commits[0].suggested_subject;
        ok(suggested.endsWith('...'), suggested);
        r = auto(dir, wf, '--subject-file', await subject(suggested));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /its description is the workflow's topic cut short/);
        deepStrictEqual(await snapshot(dir, wf), before);
        // Control: the same type and scope with a summary of the change.
        r = auto(dir, wf, '--subject-file', await subject('feat(engineer): compare the commit subject with its change'));
        strictEqual(r.code, 0, r.stderr);
      });
    });

    itDispatchOn('a refusal for the topic cut short or an empty description gives no subject to copy, only the type and scope to keep', async () => {
      const topic = 'Macro 7 C163 A4: the commit subject is never compared with the change it commits, so every landing is retitled';
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs'], { request: topic });
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const before = await snapshot(dir, wf);
        const cut = planOf(dir, wf).commits[0].suggested_subject.replace(/^[^:]*: /, '');
        // A wrong type and the topic cut short: correcting the type alone
        // would keep the cut description, which is refused again (C163 F2).
        let r = auto(dir, wf, '--subject-file', await subject(`chore: ${cut}`));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /its description is the workflow's topic cut short/);
        ok(!/Corrected subject:/.test(r.stderr), r.stderr);
        match(r.stderr, /No corrected subject: its description is to be replaced, not kept\. Write 'fix\(engineer\): ' followed by your own one-line summary/);
        deepStrictEqual(await snapshot(dir, wf), before);
        r = auto(dir, wf, '--subject-file', await subject('chore(engineer):'));
        strictEqual(r.code, 9, r.stderr);
        ok(!/Corrected subject:/.test(r.stderr), r.stderr);
        match(r.stderr, /Write 'fix\(engineer\): ' followed by your own one-line summary/);
        // Control: a wrong type with a summary of its own gets the whole
        // corrected subject, which then commits.
        r = auto(dir, wf, '--subject-file', await subject('chore(engineer): set a to 1'));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /Corrected subject: fix\(engineer\): set a to 1/);
        ok(!/No corrected subject/.test(r.stderr), r.stderr);
        deepStrictEqual(await snapshot(dir, wf), before);
        r = auto(dir, wf, '--subject-file', await subject('fix(engineer): set a to 1'));
        strictEqual(r.code, 0, r.stderr);
      });
      // A scope may hold a colon: the type and scope to keep are the parsed
      // subject's, not the text before its first colon (refine-verify MINOR).
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['README.md'], { request: topic });
        await writeFile(join(dir, 'README.md'), '# sandbox\nconsumer\n');
        const cut = planOf(dir, wf).commits[0].suggested_subject.replace(/^[^:]*: /, '');
        const r = auto(dir, wf, '--subject-file', await subject(`feat(api:client)!: ${cut}`));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /Write 'feat\(api:client\)!: ' followed by your own one-line summary/);
      }, { config: false });
    });

    itDispatchOn('--lenient-cc does not loosen autopilot, and an empty summary is refused', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const before = await snapshot(dir, wf);
        let r = auto(dir, wf, '--lenient-cc', '--subject-file', await subject('change files'));
        ok(r.code !== 0, r.stderr);
        match(r.stderr, /does not match Conventional Commit format and strictCC is on/);
        deepStrictEqual(await snapshot(dir, wf), before);
        r = auto(dir, wf, '--subject-file', await subject('fix(engineer):'));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /its description is empty/);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
    });

    itDispatchOn('a mixed change is decided by its package part: docs refused, fix taken', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'docs/note.md']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'docs', 'note.md'), 'note\n');
        let r = auto(dir, wf, '--subject-file', await subject('docs(engineer): explain a'));
        strictEqual(r.code, 9, r.stderr);
        r = auto(dir, wf, '--subject-file', await subject('fix(engineer): set a and explain it'));
        strictEqual(r.code, 0, r.stderr);
        deepStrictEqual(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(), ['docs/note.md', 'plugins/engineer/a.mjs']);
      });
    });

    itDispatchOn('a split checks every commit before the first: one bad subject commits none', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'tests/test-a.mjs']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'tests', 'test-a.mjs'), 'test\n');
        // A package file and a test outside every package fold into one commit
        // (single-package-with-docs); a second package makes a split.
        sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', 'plugins/runtime/b.mjs', '--op', 'edit']);
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
        const p = planOf(dir, wf);
        deepStrictEqual(p.commits.map((c) => c.package), ['plugins/engineer', 'plugins/runtime', null]);
        deepStrictEqual(p.commits[2].subject_rule.allowed_types, ['test']);
        const before = await snapshot(dir, wf);
        const files = async (docs) => [
          '--subject-pkg-file', `plugins/engineer=${await subject('feat(engineer): set a to 1')}`,
          '--subject-pkg-file', `plugins/runtime=${await subject('fix(runtime): set b to 1')}`,
          '--subject-pkg-file', `docs=${await subject(docs)}`,
        ];
        let r = auto(dir, wf, ...(await files('chore: cover a')));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /commit 3\/3, package=docs/);
        deepStrictEqual(await snapshot(dir, wf), before, 'neither package commit landed');
        r = auto(dir, wf, ...(await files('test: cover a')));
        strictEqual(r.code, 0, r.stderr);
        deepStrictEqual(sh(dir, 'git', ['log', '-3', '--format=%s']).split('\n'), ['test: cover a', 'fix(runtime): set b to 1', 'feat(engineer): set a to 1']);
      });
    });

    itDispatchOn('a retry after a partial split checks the commits it still makes', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'plugins/runtime/b.mjs']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
        const hook = join(dir, '.git', 'hooks', 'pre-commit');
        await writeFile(hook, '#!/bin/sh\nif git diff --cached --name-only | grep -q "^plugins/runtime/"; then exit 1; fi\n');
        await chmod(hook, 0o755);
        const split = async (runtime) => [
          '--subject-pkg-file', `plugins/engineer=${await subject('feat(engineer): set a to 1')}`,
          '--subject-pkg-file', `plugins/runtime=${await subject(runtime)}`,
        ];
        let r = auto(dir, wf, ...(await split('fix(runtime): set b to 1')));
        strictEqual(r.code, 4, r.stderr);
        strictEqual(subjectOf(dir), 'feat(engineer): set a to 1', 'the first commit landed');
        await rm(hook);
        // The refused commit left its file staged, which autopilot hands to the
        // owner (the staging-set gate); unstaged, the retry runs on its own.
        sh(dir, 'git', ['reset', '-q']);
        // The retry plans the runtime commit alone.
        deepStrictEqual(planOf(dir, wf).commits.map((c) => c.package), ['plugins/runtime']);
        const before = await snapshot(dir, wf);
        r = auto(dir, wf, '--subject-file', await subject('chore(runtime): set b to 1'));
        strictEqual(r.code, 9, r.stderr);
        deepStrictEqual(await snapshot(dir, wf), before);
        r = auto(dir, wf, '--subject-file', await subject('fix(runtime): set b to 1'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(subjectOf(dir), 'fix(runtime): set b to 1');
      });
    });
  });

  describe(`${persona}: a retry checks the commits this workflow already landed`, () => {
    itDispatchOn('under autopilot an earlier landed commit whose subject does not fit refuses the retry, writing nothing', async () => {
      await withSandbox(async (dir, subject) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'plugins/runtime/b.mjs']);
        const id = wf.split('/').pop().replace(/\.md$/, '');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
        // The first package landed by an earlier attempt, under a subject that does not fit.
        execFileSync('git', ['commit', '-q', '-m', 'chore: first package', '-m', `Workflow-ID: ${id}`, '--no-verify', '--', 'plugins/engineer/a.mjs'], { cwd: dir });
        const before = await snapshot(dir, wf);
        let r = auto(dir, wf, '--subject-file', await subject('fix(runtime): set b to 1'));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /"chore: first package" \(landed commit [0-9a-f]{7}\)/);
        deepStrictEqual(await snapshot(dir, wf), before);
        // With the subject still to commit wrong too, both are reported, and the
        // landed commit's report/stop instruction ends the refusal: the worker
        // is never also told to run the step again.
        r = auto(dir, wf, '--subject-file', await subject('chore(runtime): set b to 1'));
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /"chore\(runtime\): set b to 1" \(commit 1\/1, package=plugins\/runtime\)/);
        ok(!/run the step again/.test(r.stderr), r.stderr);
        match(r.stderr, /in the step's report, and stop\.\s*$/);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
    });
  });

  describe(`${persona}: the recovery path checks the landed commits' subjects`, () => {
    async function landedByHand(dir, text) {
      const wf = workflow(dir, ['plugins/engineer/a.mjs']);
      const id = wf.split('/').pop().replace(/\.md$/, '');
      await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      execFileSync('git', ['commit', '-qam', text, '-m', `Workflow-ID: ${id}`, '--no-verify'], { cwd: dir });
      strictEqual(planOf(dir, wf).no_changes.path, 'recovery');
      return wf;
    }

    itDispatchOn('under autopilot a landed subject that does not fit is refused (exit 9), writing nothing; one that fits recovers', async () => {
      await withSandbox(async (dir) => {
        const wf = await landedByHand(dir, 'chore: set a to 1');
        const before = await snapshot(dir, wf);
        const r = auto(dir, wf);
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /\(landed commit [0-9a-f]{7}\) does not fit the change it commits/);
        // The landed commit is the owner's (the runbook's Autopilot step): the
        // headless worker is told to report it, never to rewrite history.
        match(r.stderr, /A landed commit is the owner's to reword, or to split where it touches several packages: this step rewrites no history \(no amend, rebase or reset\)\. Report each landed commit named above, with its reason, in the step's report, and stop\./);
        ok(!/Reword the landed commit|run the step again/.test(r.stderr), r.stderr);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
      await withSandbox(async (dir) => {
        const wf = await landedByHand(dir, 'fix(engineer): set a to 1');
        const r = auto(dir, wf);
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'recovered');
      });
    });

    itDispatchOn('every landed commit is checked, not only the newest, and a landed topic cut short is refused', async () => {
      await withSandbox(async (dir) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'docs/note.md']);
        const id = wf.split('/').pop().replace(/\.md$/, '');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'docs', 'note.md'), 'note\n');
        execFileSync('git', ['add', 'docs/note.md'], { cwd: dir });
        execFileSync('git', ['commit', '-q', '-m', 'feat(engineer): older and wrong', '-m', `Workflow-ID: ${id}`, '--no-verify', '--', 'docs/note.md'], { cwd: dir });
        execFileSync('git', ['commit', '-q', '-m', 'fix(engineer): newest and right', '-m', `Workflow-ID: ${id}`, '--no-verify', '--', 'plugins/engineer/a.mjs'], { cwd: dir });
        strictEqual(planOf(dir, wf).no_changes.path, 'recovery');
        const before = await snapshot(dir, wf);
        const r = auto(dir, wf);
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /"feat\(engineer\): older and wrong"/);
        ok(!/newest and right" \(landed/.test(r.stderr), r.stderr);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
      const topic = 'Macro 7 C163 A4: the commit subject is never compared with the change it commits, so every landing is retitled';
      await withSandbox(async (dir) => {
        const wf = workflow(dir, ['plugins/engineer/a.mjs'], { request: topic });
        const id = wf.split('/').pop().replace(/\.md$/, '');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const cut = planOf(dir, wf).commits[0].suggested_subject;
        execFileSync('git', ['commit', '-qam', cut, '-m', `Workflow-ID: ${id}`, '--no-verify'], { cwd: dir });
        const before = await snapshot(dir, wf);
        const r = auto(dir, wf);
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, /its description is the workflow's topic cut short/);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
    });

    it('interactively it warns with the corrected subject and recovers', async () => {
      await withSandbox(async (dir) => {
        const wf = await landedByHand(dir, 'chore: set a to 1');
        const r = execute(dir, wf);
        strictEqual(r.code, 0, r.stderr);
        match(r.stderr, /⚠ subject "chore: set a to 1" \(landed commit [0-9a-f]{7}\)/);
        match(r.stderr, /Corrected subject: fix\(engineer\): set a to 1/);
        match(await readFile(wf, 'utf8'), /current_phase:\s*"?commit-complete/);
      });
    });

    itDispatchOn('a landed commit touching several packages has no one subject: it is to be split, refused under autopilot, a warning interactively', async () => {
      async function landedAcross(dir) {
        const wf = workflow(dir, ['plugins/engineer/a.mjs', 'plugins/runtime/b.mjs']);
        const id = wf.split('/').pop().replace(/\.md$/, '');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
        execFileSync('git', ['commit', '-qam', 'fix(engineer): set a and b to 1', '-m', `Workflow-ID: ${id}`, '--no-verify'], { cwd: dir });
        strictEqual(planOf(dir, wf).no_changes.path, 'recovery');
        return wf;
      }
      const split = /"fix\(engineer\): set a and b to 1" \(landed commit [0-9a-f]{7}\) does not fit the change it commits: it touches 2 packages \(plugins\/engineer, plugins\/runtime\)[^\n]*\n  No corrected subject: no one subject fits it; it is split into one commit per package, each with its own subject\.\n/;
      await withSandbox(async (dir) => {
        const wf = await landedAcross(dir);
        const before = await snapshot(dir, wf);
        const r = auto(dir, wf);
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, split);
        ok(!/Corrected subject:/.test(r.stderr), r.stderr);
        match(r.stderr, /this step rewrites no history/);
        deepStrictEqual(await snapshot(dir, wf), before);
      });
      await withSandbox(async (dir) => {
        const wf = await landedAcross(dir);
        const r = execute(dir, wf);
        strictEqual(r.code, 0, r.stderr);
        match(r.stderr, split);
        match(r.stderr, /reword the landed commit to take the corrected subject \(keeping its Workflow-ID trailer\), or split it where it touches several packages/);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The interactive Phase 7 runbook texts (C163 critique F4): each tells the
  // agent to check an edited subject against the plan's subject_rule, and to
  // pass execute's warning and corrected subject to the user.

  describe(`${persona}: every interactive Phase 7 runbook text carries the subject rule`, () => {
    // A pipeline region by its markers, or (the Codex /start skill, whose
    // Phase 7 is the persona's own text) a heading's section.
    const texts = [
      ['commands/commit.md', 'commit-plan'],
      ['core/skills/commit/SKILL.md', 'commit-plan'],
      ['commands/start.md', 'start-commit'],
      ['core/skills/start/SKILL.md', '### Phase 7'],
    ];
    for (const [rel, id] of texts) {
      it(`${rel} § ${id}`, async () => {
        const text = await readFile(P.path(rel), 'utf8');
        const m = id.startsWith('#')
          ? new RegExp(`\\n${id}[^\\n]*\\n([\\s\\S]*?)(?=\\n### |$)`).exec(text)
          : new RegExp(`<!-- pipeline:begin ${id} -->([\\s\\S]*?)<!-- pipeline:end ${id} -->`).exec(text);
        ok(m, `${rel} holds ${id}`);
        const region = m[1].replace(/\s+/g, ' ');
        for (const needle of ['`subject_rule`', '`allowed_types`', '`scopes`', 'ADR-0028 §P6']) {
          ok(region.includes(needle), `${rel} § ${id} names ${needle}`);
        }
        match(region, /check (it|an edited subject|a subject the user edited)[^.]*before execute/, `${rel} § ${id}: the edited subject is checked before execute`);
        match(region, /prints the corrected subject: pass the warning and the corrected subject to the user/, `${rel} § ${id}: execute's warning and correction reach the user`);
      });
    }
  });
}
