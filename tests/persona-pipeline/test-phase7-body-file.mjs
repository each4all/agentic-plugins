// scripts/phase7-commit.mjs — the commit body the worker wrote (W8, ADR-0028
// §P1 note of 2026-11-11).
//
// `--body-file <path>` (single commit) and a repeated `--body-pkg-file
// <pkg>=<path>` (split) carry the body the commit lands with, in place of the
// one composed from the topic, the diff stat and the ensemble summary; the
// driver still appends the Workflow-ID trailer last, so the commit sha needs
// no rewrite before landing. A body is refused, not stripped, when it holds a
// trailer- or conventional-headline-shaped line, repeats the subject, is
// blank or over the cap, or (under autopilot) is the topic copied; a body
// matched to no commit is refused. Optional in this stage: with no body file
// the composed body is kept.
//
// One suite per persona the driver is generated into (ADR-0066 Decision 5).
// The `plugins/engineer` and `plugins/runtime` keys are this repository's
// release-please packages (commit-routing data), not the persona under test.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, match, throws } from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';
import { tmpDir } from '../_tmp.mjs';

const AUTOPILOT_RUN_ID = 'autopilot-20261111T010203Z-abcdef';

describe('the body-file suite reaches every persona with the commit driver (guards a vacuous pass)', () => {
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

  const { checkBodyText, normalizeBodyText, composeBody, resolveBodyFiles, pickBodiesForShape, parseFlags, BODIES } =
    await import(pathToFileURL(PHASE7_BIN).href);

  // ---------------------------------------------------------------------------
  // The rules, as pure functions.

  describe(`${persona}: checkBodyText / composeBody — the body rules`, () => {
    it('a plain body passes; normalization strips a BOM, reads CRLF as LF and trims the ends', () => {
      deepStrictEqual(checkBodyText({ body: 'Read the body from a file.\n\nThe trailer stays the driver\'s.' }), []);
      strictEqual(normalizeBodyText('﻿  a\r\nb\rc  \n\n'), 'a\nb\nc');
    });

    it('a trailer-shaped line is refused, indented or not, in any case', () => {
      for (const line of ['Workflow-ID: compose-x', '  co-authored-by: someone', 'BREAKING CHANGE: no', 'Refs: #1', 'Fixes: #2', 'Release-As: 2.0.0', '  release as: 1.0.0']) {
        const problems = checkBodyText({ body: `First line.\n${line}` });
        strictEqual(problems.length, 1, `${line}: ${problems}`);
        match(problems[0], /^line 2 is trailer-shaped/);
      }
    });

    it('a bare conventional headline line is refused; one inside prose is not', () => {
      for (const line of ['feat(engineer): another entry', 'fix: x', '  chore!: y', 'Revert: z', 'docs:', 'feat!:drop it', 'deps!: drop it', 'deps: bump', 'anything(x)!: breaking']) {
        const problems = checkBodyText({ body: `First line.\n${line}` });
        strictEqual(problems.length, 1, `${line}: ${problems}`);
        match(problems[0], /^line 2 is a conventional headline/);
      }
      deepStrictEqual(checkBodyText({ body: 'First line.\n- feat: as a list item\nThe fix: a colon later.\nNote: prose with a colon.' }), []);
    });

    it('blank, over the cap, and the subject repeated are refused', () => {
      deepStrictEqual(checkBodyText({ body: ' \n\t\n' }), ['it is blank']);
      match(checkBodyText({ body: 'x'.repeat(4001) })[0], /over the cap of 4000/);
      deepStrictEqual(checkBodyText({ body: 'x'.repeat(4000) }), []);
      // A subject that is not conventional (a lenient repository): the repeat rule
      // alone; a conventional one repeated is also a headline line.
      deepStrictEqual(checkBodyText({ body: 'Set a to 1\n\nwhy', subject: 'Set a to 1' }), ['its first line repeats the subject']);
      deepStrictEqual(checkBodyText({ body: 'Why it changes.', subject: 'fix(engineer): a' }), []);
    });

    it('with the topic given (autopilot), the topic copied or cut short is refused; a body that only mentions it is not', () => {
      const topic = 'Each landing is manual work:\nrewrite the body, rebase, push.';
      match(checkBodyText({ body: 'Each landing is manual work: rewrite the body, rebase, push.', originalRequest: topic })[0], /topic copied/);
      match(checkBodyText({ body: 'Each landing is manual', originalRequest: topic })[0], /topic copied/);
      deepStrictEqual(checkBodyText({ body: 'Phase 7 reads the body from a file.', originalRequest: topic }), []);
      // Without the topic (interactive) the rule does not apply.
      deepStrictEqual(checkBodyText({ body: 'Each landing is manual' }), []);
    });

    it('composeBody puts the intended body before the Workflow-ID trailer, and nothing of the composed body', () => {
      const body = composeBody({
        originalRequest: 'the topic', diffStat: ' a | 1 +', ensembleSummary: 'agreed', workflowId: 'compose-1', intendedBody: '\r\nWhy.\r\n\r\nHow.\r\n',
      });
      strictEqual(body, 'Why.\n\nHow.\n\nWorkflow-ID: compose-1');
      // Control: without it, the composed body as before.
      match(composeBody({ originalRequest: 'the topic', diffStat: ' a | 1 +', ensembleSummary: 'agreed', workflowId: 'compose-1' }), /^the topic\n\n```/);
      throws(() => composeBody({ workflowId: 'compose-1', intendedBody: 'Why.\nWorkflow-ID: forged' }), /intended body is refused/);
    });

    it('the composed body drops a footer line however it is indented (Release-As included)', () => {
      const body = composeBody({ originalRequest: 'the topic', diffStat: ' a | 1 +', ensembleSummary: '  Release-As: 9.0.0\n\tBREAKING CHANGE: x\nagreed', workflowId: 'compose-1' });
      ok(!/Release-As|BREAKING CHANGE/i.test(body), body);
      match(body, /agreed/);
      const lead = composeBody({ originalRequest: '  Release-As: 9.0.0\nthe topic', workflowId: 'compose-1' });
      ok(!/^Release-As/im.test(lead), lead);
      // An indented line of another key is an example, not a footer: kept.
      const example = composeBody({ originalRequest: 'the topic', ensembleSummary: 'agreed\n```yaml\n  refs: []\n  fixes: false\n```', workflowId: 'compose-1' });
      match(example, /  refs: \[\]\n  fixes: false/);
    });
  });

  describe(`${persona}: resolveBodyFiles / pickBodiesForShape — the files and their commits`, () => {
    it('reads each file, refusing a glued value, a repeated flag or package, and a body the file alone refuses', (t) => {
      const dir = tmpDir(t, 'phase7-body-files-');
      const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
      const good = file('good.txt', 'Why.\n');
      const r = resolveBodyFiles(parseFlags(['--body-file', good, '--body-pkg-file', `docs=${good}`]));
      deepStrictEqual([r[BODIES].single, [...r[BODIES].byPackage]], ['Why.', [['docs', 'Why.']]]);
      ok(!('body-file' in r) && !('body-pkg-file' in r));
      throws(() => parseFlags(['--body-file', good, '--body-file', good]), /--body-file is given more than once/);
      throws(() => resolveBodyFiles(parseFlags([`--body-file=${good}`, 'x'])), /takes its value as the next argument/);
      throws(() => resolveBodyFiles(parseFlags(['--body-pkg-file', `docs=${good}`, '--body-pkg-file', `docs=${good}`])), /more than one body/);
      throws(() => resolveBodyFiles(parseFlags(['--body-pkg-file', good])), /expects '<pkg>=<path>'/);
      throws(() => resolveBodyFiles(parseFlags(['--body-file', file('t.txt', 'Why.\nCo-Authored-By: x\n')])), /--body-file: the body is refused: line 2 is trailer-shaped/);
      throws(() => resolveBodyFiles(parseFlags(['--body-file', file('blank.txt', '\n\n')])), /the body is refused: it is blank|is empty/);
      throws(() => resolveBodyFiles(parseFlags(['--body-file', join(dir, 'missing.txt')])), /cannot read/);
      // No body flag: no bodies, and nothing else changes.
      const none = resolveBodyFiles(parseFlags(['--mode', 'plan']));
      deepStrictEqual([none[BODIES].single, none[BODIES].byPackage.size, none.mode], [null, 0, 'plan']);
    });

    it('a single commit takes --body-file, a split --body-pkg-file per commit; a mismatch is refused, a landed package noted', () => {
      const single = { commits: [{ package: 'plugins/engineer', files: ['plugins/engineer/a.mjs'] }], requiresSplit: false };
      const split = { commits: [{ package: 'plugins/engineer', files: [] }, { package: null, files: [] }], requiresSplit: true };
      const of = (s, m = []) => ({ single: s, byPackage: new Map(m) });
      deepStrictEqual(pickBodiesForShape({ shape: single, bodies: of('A') }).bodies, ['A']);
      deepStrictEqual(pickBodiesForShape({ shape: single, bodies: undefined }).bodies, [null]);
      deepStrictEqual(pickBodiesForShape({ shape: split, bodies: of(null, [['docs', 'D']]) }).bodies, [null, 'D']);
      match(pickBodiesForShape({ shape: split, bodies: of('A') }).problems[0], /--body-file is for a single commit/);
      match(pickBodiesForShape({ shape: single, bodies: of(null, [['plugins/engineer', 'A']]) }).problems[0], /names the single commit/);
      match(pickBodiesForShape({ shape: split, bodies: of(null, [['plugins/runtime', 'R']]) }).problems[0], /names no commit of this staging set/);
      const landed = pickBodiesForShape({ shape: split, bodies: of(null, [['plugins/runtime', 'R']]), landedKeys: () => new Set(['plugins/runtime']) });
      deepStrictEqual([landed.problems, landed.bodies], [[], [null, null]]);
      match(landed.notes[0], /already landed/);
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
  const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env() }).trimEnd();
  function run(cwd, args, extra = {}) {
    const r = spawnSync('node', [PHASE7_BIN, ...args], { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
  }

  function sandbox(t) {
    const dir = tmpDir(t, 'phase7-body-');
    const texts = tmpDir(t, 'phase7-body-texts-');
    execFileSync('git', ['init', '-q', '-b', 'feat/s'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'phase7-body'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'phase7-body@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    // A cleanup mode that would fold the message: --cleanup=verbatim wins.
    execFileSync('git', ['config', 'commit.cleanup', 'strip'], { cwd: dir });
    writeFileSync(join(dir, 'release-please-config.json'), readFileSync(REL_PLEASE_CFG, 'utf8'));
    writeFileSync(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
    for (const d of ['plugins/engineer', 'plugins/runtime', 'docs']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 0;\n');
    writeFileSync(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 0;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'chore: sandbox baseline', '--no-verify'], { cwd: dir });
    let n = 0;
    const text = (content) => {
      const file = join(texts, `text-${(n += 1)}.txt`);
      writeFileSync(file, content);
      return file;
    };
    return { dir, text };
  }

  function digest(dir) {
    return execFileSync('shasum', ['-a', '256'], {
      input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
      encoding: 'utf8',
    }).trim().split(/\s+/)[0];
  }

  function workflow(dir, paths, request = 'the change') {
    const wf = sh(dir, 'node', [
      STATE_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', persona,
      '--host', 'claude', '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
      '--status-digest', digest(dir), '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
      '--original-request', request,
    ]);
    for (const p of paths) sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', p, '--op', 'edit']);
    sh(dir, 'node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'commit',
      '--next-step-confidence', 'HIGH', '--event', 'updated']);
    return wf;
  }
  const workflowId = (wf) => /^workflow_id: "([^"]+)"$/m.exec(readFileSync(wf, 'utf8'))[1];
  const execute = (dir, wf, ...extra) => run(dir, ['--mode', 'execute', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--confirm-non-interactive', ...extra]);
  const auto = (dir, wf, ...extra) => run(dir, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', ...extra], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
  const messageOf = (dir, rev = 'HEAD') => sh(dir, 'git', ['log', '-1', '--format=%B', rev]);
  const snapshot = (dir, wf) => ({
    head: sh(dir, 'git', ['rev-parse', 'HEAD']),
    staged: sh(dir, 'git', ['diff', '--cached', '--name-only']),
    wf: readFileSync(wf, 'utf8'),
  });

  describe(`${persona}: execute — the commit lands with the body the file holds`, () => {
    it('subject, blank, the body verbatim (a # line kept), blank, Workflow-ID; nothing of the topic or diff stat', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs']);
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const body = 'Set a to 1, so the reader sees the new value.\n\n# not a comment\n- one point';
      const r = execute(dir, wf, '--subject-file', text('fix(engineer): set a to 1\n'), '--body-file', text(`${body}\r\n`));
      strictEqual(r.code, 0, r.stderr);
      strictEqual(messageOf(dir), `fix(engineer): set a to 1\n\n${body}\n\nWorkflow-ID: ${workflowId(wf)}`);
      ok(!/landed differs/.test(r.stderr), r.stderr);
    });

    it('a commit-msg hook that changes the message, a trailing newline included, is reported; the commit stands', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs']);
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const hook = join(dir, '.git', 'hooks', 'commit-msg');
      writeFileSync(hook, '#!/bin/sh\nprintf "\\n" >> "$1"\n', { mode: 0o755 });
      const r = execute(dir, wf, '--subject-file', text('fix(engineer): set a to 1\n'), '--body-file', text('Why.\n'));
      strictEqual(r.code, 0, r.stderr);
      match(r.stderr, /the commit message that landed differs from the one composed/);
    });

    it('control: with no body file the composed body is kept', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs'], 'the topic of the change');
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const r = execute(dir, wf, '--subject-file', text('fix(engineer): set a to 1\n'));
      strictEqual(r.code, 0, r.stderr);
      match(messageOf(dir), /^fix\(engineer\): set a to 1\n\nthe topic of the change\n\n```\n/);
    });

    it('a split takes one body per commit, each before its own trailer; a commit with no body file keeps the composed one', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs', 'plugins/runtime/b.mjs'], 'the topic');
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
      const r = execute(dir, wf,
        '--subject-pkg-file', `plugins/engineer=${text('fix(engineer): set a to 1\n')}`,
        '--subject-pkg-file', `plugins/runtime=${text('fix(runtime): set b to 1\n')}`,
        '--body-pkg-file', `plugins/engineer=${text('Why a changes.\n')}`);
      strictEqual(r.code, 0, r.stderr);
      strictEqual(messageOf(dir, 'HEAD~1'), `fix(engineer): set a to 1\n\nWhy a changes.\n\nWorkflow-ID: ${workflowId(wf)}`);
      match(messageOf(dir), /^fix\(runtime\): set b to 1\n\nthe topic\n\n```/);
    });

    it('a body that repeats the subject, or names no commit, is refused interactively too (exit 9), with nothing written', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs']);
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const before = snapshot(dir, wf);
      // A non-conventional subject, which this sandbox (no strict-cc config)
      // commits with a warning, so the repeat rule is the one that refuses.
      const subject = text('Set a to 1\n');
      for (const [extra, why] of [
        [['--body-file', text('Set a to 1\n\nWhy.\n')], /its first line repeats the subject/],
        [['--body-pkg-file', `plugins/runtime=${text('Why.\n')}`], /names no commit of this staging set/],
        [['--body-pkg-file', `plugins/engineer=${text('Why.\n')}`], /names the single commit/],
      ]) {
        const r = execute(dir, wf, '--subject-file', subject, ...extra);
        strictEqual(r.code, 9, r.stderr);
        match(r.stderr, why);
        match(r.stderr, /✗ the commit body is refused: nothing was committed and nothing was written/);
        deepStrictEqual(snapshot(dir, wf), before);
      }
    });

    it('a body the file alone refuses (a forged trailer, a headline line) stops the driver at start (exit 2), with nothing written', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs']);
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const before = snapshot(dir, wf);
      for (const [body, why] of [
        ['Why.\nWorkflow-ID: compose-forged\n', /trailer-shaped/],
        ['Why.\nfeat(runtime): a second entry\n', /conventional headline/],
      ]) {
        const r = execute(dir, wf, '--subject-file', text('fix(engineer): set a to 1\n'), '--body-file', text(body));
        strictEqual(r.code, 2, r.stderr);
        match(r.stderr, why);
        deepStrictEqual(snapshot(dir, wf), before);
      }
    });
  });

  describe(`${persona}: --mode autopilot — the worker's body`, () => {
    itDispatchOn('the topic copied as the body is refused (exit 9), nothing written; a body of the change commits', (t) => {
      const topic = 'Each landing is manual Claude work: commit-body rewrite, rebase onto main, push, PR, CI wait';
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs'], topic);
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const before = snapshot(dir, wf);
      const subject = text('fix(engineer): set a to 1\n');
      let r = auto(dir, wf, '--subject-file', subject, '--body-file', text(`${topic}\n`));
      strictEqual(r.code, 9, r.stderr);
      match(r.stderr, /topic copied/);
      deepStrictEqual(snapshot(dir, wf), before);
      r = auto(dir, wf, '--subject-file', subject, '--body-file', text('Phase 7 takes the body from a file the worker wrote.\n'));
      strictEqual(r.code, 0, r.stderr);
      strictEqual(JSON.parse(r.stdout).action, 'committed');
      strictEqual(messageOf(dir), `fix(engineer): set a to 1\n\nPhase 7 takes the body from a file the worker wrote.\n\nWorkflow-ID: ${workflowId(wf)}`);
    });

    itDispatchOn('control: without --require-body (an older runbook) a body file stays optional, and the composed body is kept without one', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs'], 'the topic');
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const r = auto(dir, wf, '--subject-file', text('fix(engineer): set a to 1\n'));
      strictEqual(r.code, 0, r.stderr);
      match(messageOf(dir), /^fix\(engineer\): set a to 1\n\nthe topic\n\n```/);
    });

    itDispatchOn('--require-body (the runbook that writes bodies) refuses a commit left without one (exit 9), nothing written; with it, the commit lands', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs'], 'the topic');
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      const before = snapshot(dir, wf);
      const subject = text('fix(engineer): set a to 1\n');
      let r = auto(dir, wf, '--require-body', '--subject-file', subject);
      strictEqual(r.code, 9, r.stderr);
      match(r.stderr, /commit 1\/1 \(package=plugins\/engineer\) has no body: pass --body-file <file>/);
      match(r.stderr, /✗ the commit body is refused: nothing was committed and nothing was written/);
      deepStrictEqual(snapshot(dir, wf), before);
      r = auto(dir, wf, '--require-body', '--subject-file', subject, '--body-file', text('Why a is 1.\n'));
      strictEqual(r.code, 0, r.stderr);
      strictEqual(messageOf(dir), `fix(engineer): set a to 1\n\nWhy a is 1.\n\nWorkflow-ID: ${workflowId(wf)}`);
    });

    itDispatchOn('--require-body on a split names each commit left without a body; with every body given, each commit carries its own', (t) => {
      const { dir, text } = sandbox(t);
      const wf = workflow(dir, ['plugins/engineer/a.mjs', 'plugins/runtime/b.mjs'], 'the topic');
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
      const before = snapshot(dir, wf);
      const subjects = [
        '--subject-pkg-file', `plugins/engineer=${text('fix(engineer): set a to 1\n')}`,
        '--subject-pkg-file', `plugins/runtime=${text('fix(runtime): set b to 1\n')}`,
      ];
      let r = auto(dir, wf, '--require-body', ...subjects, '--body-pkg-file', `plugins/engineer=${text('Why a.\n')}`);
      strictEqual(r.code, 9, r.stderr);
      match(r.stderr, /commit 2\/2 \(package=plugins\/runtime\) has no body: pass --body-pkg-file plugins\/runtime=<file>/);
      ok(!/commit 1\/2 \(package=plugins\/engineer\) has no body/.test(r.stderr), r.stderr);
      deepStrictEqual(snapshot(dir, wf), before);
      r = auto(dir, wf, '--require-body', ...subjects,
        '--body-pkg-file', `plugins/engineer=${text('Why a.\n')}`, '--body-pkg-file', `plugins/runtime=${text('Why b.\n')}`);
      strictEqual(r.code, 0, r.stderr);
      strictEqual(messageOf(dir, 'HEAD~1'), `fix(engineer): set a to 1\n\nWhy a.\n\nWorkflow-ID: ${workflowId(wf)}`);
      strictEqual(messageOf(dir), `fix(runtime): set b to 1\n\nWhy b.\n\nWorkflow-ID: ${workflowId(wf)}`);
    });

    itDispatchOn('--require-body takes none on the close: a clean tree closes the workflow', (t) => {
      const { dir } = sandbox(t);
      const wf = workflow(dir, []);
      sh(dir, 'node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'done',
        '--next-step-confidence', 'HIGH', '--event', 'updated']);
      const r = auto(dir, wf, '--require-body');
      strictEqual(r.code, 0, r.stderr);
      strictEqual(JSON.parse(r.stdout).action, 'closed');
    });
  });
}
