// tests/persona-pipeline/test-dispatch-selection.mjs
//
// ADR-0067 Decision 4, item 5 — the selection /orchestrator:next's Phase 1
// made, recorded on the dispatched child at its creation (dispatched_branch,
// dispatched_verb, dispatched_profile, dispatched_topic, beside the parent
// linkage), and handed back by `dispatch-selection` in the form the
// orchestrator's --expect-dispatch takes. Every path that binds the child to
// its subtask compares it (tests/orchestrator/test-engineer-terminal.mjs and
// the runbook tests); these cases hold the record itself: what create writes,
// what it refuses before the file lands, what a read accepts, and what a
// persona that is no dispatch target refuses.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { personasFor, personaInfo } from './_personas.mjs';

const HEAD = 'a'.repeat(40);
// The child processes run without the operator's agentic session (C88).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));

function withRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-selection-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const persona of personasFor('scripts/state.mjs')) {
  const P = personaInfo(persona);
  const STATE = join(P.root, 'scripts', 'state.mjs');
  const cli = (args) => spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8', env: cleanEnv() });
  const create = (root, extra, branch = 'feat/t1') => cli([
    'create', '--repo-root', root, '--verb', 'compose', '--host', 'claude', '--persona', persona,
    '--git-baseline-branch', branch, '--git-baseline-head', HEAD, '--status-digest', '',
    '--original-request', 'dispatch selection fixture', ...extra,
  ]);
  const linked = ['--parent-workflow', 'macro-plan-20261009T000000Z-aaaaaa', '--originating-subtask', 'T1'];
  const selection = (over = {}) => JSON.stringify({ subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: 'backend', topic: 'line one\nline two', ...over });
  const homeFiles = (root) => {
    const dir = join(root, '.agentic-plugins', 'state', persona, 'workflows');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  };

  if (!P.capabilities.dispatch_target) {
    // Contract: with dispatch_target off the flag is refused loudly, as the
    // parent linkage is (ADR-0066 Decision 3), and the subcommand is unknown.
    describe(`${persona}: dispatch selection (dispatch_target off)`, () => {
      it('create refuses --dispatch-selection; dispatch-selection is an unknown subcommand', () => {
        withRoot((root) => {
          const r = create(root, ['--dispatch-selection', selection()]);
          strictEqual(r.status, 1, r.stdout);
          match(r.stderr, /does not accept --dispatch-selection/);
          deepStrictEqual(homeFiles(root), []);
          const sub = cli(['dispatch-selection', '--workflow-path', join(root, 'x.md')]);
          strictEqual(sub.status, 2, sub.stderr);
        });
      });
    });
    continue;
  }

  describe(`${persona}: the dispatch selection recorded at create (ADR-0067 Decision 4, item 5)`, () => {
    it('records the four fields beside the ids, and dispatch-selection hands them back with the macro and subtask', () => {
      withRoot((root) => {
        const r = create(root, [...linked, '--dispatch-selection', selection()]);
        strictEqual(r.status, 0, r.stderr);
        const path = r.stdout.trim();
        const text = readFileSync(path, 'utf8');
        match(text, /^dispatched_branch: "feat\/t1"\ndispatched_verb: "compose"\ndispatched_profile: "backend"\ndispatched_topic: "line one\\nline two"$/m);
        const out = cli(['dispatch-selection', '--workflow-path', path]);
        strictEqual(out.status, 0, out.stderr);
        deepStrictEqual(JSON.parse(out.stdout), {
          macro: 'macro-plan-20261009T000000Z-aaaaaa', subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: 'backend', topic: 'line one\nline two',
        });
      });
    });

    it('a child without the record hands back the branch it was created on; one without a parent linkage exits 1', () => {
      withRoot((root) => {
        const legacy = create(root, linked).stdout.trim();
        ok(!/^dispatched_/m.test(readFileSync(legacy, 'utf8')));
        deepStrictEqual(JSON.parse(cli(['dispatch-selection', '--workflow-path', legacy]).stdout), {
          macro: 'macro-plan-20261009T000000Z-aaaaaa', subtask: 'T1', branch: 'feat/t1',
        });
        const plain = create(root, [], 'feat/plain').stdout.trim();
        const r = cli(['dispatch-selection', '--workflow-path', plain]);
        strictEqual(r.status, 1, r.stdout);
        match(r.stderr, /not dispatched by an orchestrator macro/);
      });
    });

    // Contract: a selection that names another subtask, branch or verb than
    // the child is created for, or that is malformed, or that comes without
    // the ids, is a dispatcher's mistake: create refuses before the file lands.
    for (const [label, extra, why] of [
      ['another subtask', [...linked, '--dispatch-selection', selection({ subtask: 'T2' })], /names subtask "T2", but this workflow is created for "T1"/],
      ['another branch', [...linked, '--dispatch-selection', selection({ branch: 'feat/t1b' })], /names branch "feat\/t1b", but this workflow is created for "feat\/t1"/],
      ['another verb', [...linked, '--dispatch-selection', selection({ verb: 'frame' })], /names verb "frame", but this workflow is created for "compose"/],
      ['an unknown key', [...linked, '--dispatch-selection', selection({ label: 'x' })], /has unknown key "label"/],
      ['a non-string field', [...linked, '--dispatch-selection', JSON.stringify({ subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: 1 })], /has a profile that is not a string/],
      ['text that is not JSON', [...linked, '--dispatch-selection', '{subtask'], /--dispatch-selection is not JSON/],
      ['no parent linkage', ['--dispatch-selection', selection()], /valid only with parent_workflow and originating_subtask/],
    ]) {
      it(`create refuses a selection with ${label}, writing nothing`, () => {
        withRoot((root) => {
          const r = create(root, extra);
          strictEqual(r.status, 1, r.stdout);
          match(r.stderr, why);
          deepStrictEqual(homeFiles(root), []);
        });
      });
    }

    // Contract: the four are one record; a file holding some of them, or an
    // empty branch, is refused on read rather than compared in part.
    it('a read refuses a partial record or an empty branch', () => {
      withRoot((root) => {
        const path = create(root, [...linked, '--dispatch-selection', selection()]).stdout.trim();
        const text = readFileSync(path, 'utf8');
        writeFileSync(path, text.replace(/^dispatched_topic: .*\n/m, ''));
        let r = cli(['read', '--workflow-path', path]);
        strictEqual(r.status, 1, r.stdout);
        match(r.stderr, /recorded together or not at all/);
        writeFileSync(path, text.replace(/^dispatched_branch: .*$/m, 'dispatched_branch: ""'));
        r = cli(['read', '--workflow-path', path]);
        strictEqual(r.status, 1, r.stdout);
        match(r.stderr, /dispatched_branch and dispatched_verb must be non-empty strings/);
      });
    });
  });
}
