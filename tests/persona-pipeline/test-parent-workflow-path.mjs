// ADR-0067 Decision 3 (B′): a dispatched child records its macro file's
// absolute path, `parent_workflow_path`, beside the two ADR-0019 linkage ids,
// and the writeback tries that path first. `create` checks the path names
// the macro the ids name; afterwards the path is a hint, checked again where
// it is used: a recorded path that names the wrong file is refused without
// guessing, one that names no file (the macro moved, or was archived) falls
// back to the candidates, and a second copy of the macro refuses the
// writeback. One suite per persona state.mjs is generated into (ADR-0066
// Decision 5): the key and the flag belong to dispatch_target, so a persona
// that declares it off refuses the flag.
//
// The end-to-end dispatch (next.md's prelude into the engineer bootstrap) is
// tests/orchestrator/test-next-parent-path.mjs; the Stop and Phase 7 callers
// passing the path are in test-stop-archive.mjs and test-phase7-commit.mjs;
// an older reader carrying the key, in test-state-schema-forward-compat.mjs.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';

const ORCHESTRATOR_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const ORCHESTRATOR_STATE = resolve(ORCHESTRATOR_ROOT, 'scripts/state.mjs');
const MIN_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEAD = 'a'.repeat(40);
const ORCH_WORKFLOWS_REL = '.agentic-plugins/state/orchestrator/workflows';
const ORCH_ARCHIVE_REL = '.agentic-plugins/state/orchestrator/archive';

// The child processes run without the operator's agentic session (C88).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));

const orch = (args) => execFileSync(process.execPath, [ORCHESTRATOR_STATE, ...args], { encoding: 'utf8', env: cleanEnv() }).trim();

/** A macro made by the real orchestrator CLI in `checkout`, with T1 in progress. */
function makeMacro(checkout, branch = 'main') {
  const macroPath = orch([
    'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', HEAD, '--status-digest', MIN_DIGEST,
    '--original-request', 'parent_workflow_path fixture macro',
  ]);
  const subtasks = join(checkout, `subtasks-${basename(macroPath)}.json`);
  writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'in_progress' }]));
  orch(['plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', subtasks]);
  return { macroPath, macroId: basename(macroPath, '.md') };
}

/** Two checkouts' worth of directories: `main` holds macros, `lane` the child. */
function withCheckouts(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'parent-workflow-path-'));
  try {
    const main = join(dir, 'main');
    const lane = join(dir, 'lane');
    mkdirSync(main);
    mkdirSync(lane);
    return fn({ dir, main, lane });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withCheckoutsAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'parent-workflow-path-'));
  try {
    const main = join(dir, 'main');
    const lane = join(dir, 'lane');
    mkdirSync(main);
    mkdirSync(lane);
    return await fn({ dir, main, lane });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const frontmatterOf = (text) => text.slice(0, text.indexOf('\n---\n', 4) + 5);

for (const persona of personasFor('scripts/state.mjs')) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const runState = (args) => spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8', env: cleanEnv() });
  const createArgs = (repoRoot, extra) => [
    'create', '--repo-root', repoRoot, '--verb', 'compose', '--host', 'claude',
    '--git-baseline-branch', 'feat/t1', '--git-baseline-head', HEAD, '--status-digest', MIN_DIGEST,
    '--original-request', 'B-prime child', ...extra,
  ];
  const workflowsIn = (repoRoot) => {
    const dir = join(repoRoot, P.workflowDirRel);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  };

  if (!P.capabilities.dispatch_target) {
    // Contract: state.mjs create — a persona that is no dispatch target would
    // otherwise record a macro path nothing ever writes back to.
    describe(`${persona}: --parent-workflow-path is refused (dispatch_target off)`, () => {
      it('the flag is refused, alone or with a path that names a real macro, and nothing is written', () => {
        withCheckouts(({ main, lane }) => {
          const { macroPath } = makeMacro(main);
          const r = runState(createArgs(lane, ['--parent-workflow-path', macroPath]));
          strictEqual(r.status, 1, r.stderr);
          match(r.stderr, new RegExp(`${persona} state\\.mjs create does not accept --parent-workflow-path: ${persona} is no orchestrator dispatch target`));
          deepStrictEqual(workflowsIn(lane), []);
        });
      });
    });
    continue;
  }

  const { writebackParent } = await import(pathToFileURL(P.path('scripts/parent-writeback.mjs')).href);

  // ---------------------------------------------------------------------------
  // create

  describe(`${persona}: create records parent_workflow_path (ADR-0067 Decision 3)`, () => {
    // Contract: state.mjs create and every later write — the writeback reads
    // the key from the child's frontmatter; a create that drops it, or a
    // write that loses it, sends the writeback back to the candidates.
    it('records the path beside the two ids, last in the frontmatter, and keeps it through later writes', () => {
      withCheckouts(({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const r = runState(createArgs(lane, ['--parent-workflow', macroId, '--originating-subtask', 'T1', '--parent-workflow-path', macroPath]));
        strictEqual(r.status, 0, r.stderr);
        const child = r.stdout.trim();
        const fm = frontmatterOf(readFileSync(child, 'utf8')).trimEnd().split('\n');
        // The ADR-0063 S1 rule: an older reader writes a key it does not know
        // after every key it knows, so the key sits last.
        strictEqual(fm.at(-2), `parent_workflow_path: ${JSON.stringify(macroPath)}`, fm.join('\n'));
        ok(fm.includes(`parent_workflow: ${JSON.stringify(macroId)}`) && fm.includes('originating_subtask: "T1"'), fm.join('\n'));
        strictEqual(runState(['append', '--workflow-path', child, '--host', 'codex', '--phase-note', 'a later write']).status, 0);
        strictEqual(runState(['checkpoint-set', '--workflow-path', child, '--host', 'claude', '--summary', 'kept']).status, 0);
        const read = JSON.parse(runState(['read', '--workflow-path', child]).stdout);
        strictEqual(read.parent_workflow_path, macroPath);
      });
    });

    // Contract: state.mjs create — each refusal is a child that would carry a
    // path naming something other than its macro, which the writeback then
    // refuses for good (a wrong recorded file is never repaired by guessing).
    it('refuses, writing nothing: the path without the ids, a malformed path, a path naming no file, and a file that is not that macro', () => {
      withCheckouts(({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const other = makeMacro(main, 'other');
        const home = dirname(macroPath);
        // A file at the macro's name whose frontmatter names another macro, and
        // one that is no macro at all, each in a workflows home of its own.
        const wrongIdHome = join(lane, 'wrong-id', ORCH_WORKFLOWS_REL);
        mkdirSync(wrongIdHome, { recursive: true });
        copyFileSync(other.macroPath, join(wrongIdHome, `${macroId}.md`));
        const notMacroHome = join(lane, 'not-macro', ORCH_WORKFLOWS_REL);
        mkdirSync(notMacroHome, { recursive: true });
        writeFileSync(join(notMacroHome, `${macroId}.md`), readFileSync(macroPath, 'utf8').replace('workflow_type: "macro"', 'workflow_type: "verb-chain"'));
        const archived = join(main, ORCH_ARCHIVE_REL, `${macroId}.md`);
        mkdirSync(dirname(archived), { recursive: true });
        copyFileSync(macroPath, archived);
        // A workflows home that is a symlink to that archive: well formed as
        // spelled, archived as resolved.
        const linkedHome = join(lane, 'linked', ORCH_WORKFLOWS_REL);
        mkdirSync(dirname(linkedHome), { recursive: true });
        symlinkSync(dirname(archived), linkedHome);
        // The macro's file with its workflow_id written twice, the second
        // naming another macro (the orchestrator keeps the last).
        const dupHome = join(lane, 'dup', ORCH_WORKFLOWS_REL);
        mkdirSync(dupHome, { recursive: true });
        writeFileSync(join(dupHome, `${macroId}.md`), readFileSync(macroPath, 'utf8').replace(/^(workflow_id: .*)$/m, `$1\nworkflow_id: "${other.macroId}"`));
        const ids = ['--parent-workflow', macroId, '--originating-subtask', 'T1'];
        const cases = [
          [[ '--parent-workflow-path', macroPath], /valid only with parent_workflow and originating_subtask/],
          [[...ids, '--parent-workflow-path', `main/${ORCH_WORKFLOWS_REL}/${macroId}.md`], /it is not absolute/],
          [[...ids, '--parent-workflow-path', `${home}/../workflows/${macroId}.md`], /it is not normalized/],
          [[...ids, '--parent-workflow-path', other.macroPath], new RegExp(`its file name is not ${macroId}\\.md`)],
          [[...ids, '--parent-workflow-path', archived], /it is not in an orchestrator workflows home/],
          [[...ids, '--parent-workflow-path', join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`)], /it names no file/],
          [[...ids, '--parent-workflow-path', join(wrongIdHome, `${macroId}.md`)], new RegExp(`its workflow_id is "${other.macroId}"`)],
          [[...ids, '--parent-workflow-path', join(notMacroHome, `${macroId}.md`)], /its workflow_type is "verb-chain", not "macro"/],
          [[...ids, '--parent-workflow-path', join(linkedHome, `${macroId}.md`)], /the file it resolves to, [^:]+: it is not in an orchestrator workflows home/],
          [[...ids, '--parent-workflow-path', join(dupHome, `${macroId}.md`)], /its frontmatter sets workflow_id more than once/],
        ];
        for (const [extra, why] of cases) {
          const r = runState(createArgs(lane, extra));
          strictEqual(r.status, 1, `${extra.join(' ')}: ${r.stdout}`);
          match(r.stderr, why, extra.join(' '));
          deepStrictEqual(workflowsIn(lane), [], `${extra.join(' ')}: nothing written`);
        }
      });
    });

    // Contract: an orchestrator from before ADR-0067 exports no path — its
    // dispatched children must still be created, linked by id.
    it('the ids without a path stay valid, and record no path', () => {
      withCheckouts(({ main, lane }) => {
        const { macroId } = makeMacro(main);
        const r = runState(createArgs(lane, ['--parent-workflow', macroId, '--originating-subtask', 'T1']));
        strictEqual(r.status, 0, r.stderr);
        const text = readFileSync(r.stdout.trim(), 'utf8');
        ok(!/^parent_workflow_path:/m.test(text), text);
        match(text, new RegExp(`^parent_workflow: "${macroId}"$`, 'm'));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // writeback

  const noteOf = (childId, commit) => `### engineer terminal: "T1" @ ${childId} ${commit}`;
  const CHILD_ID = 'compose-20261008T000000Z-abc123';

  async function writeback(repoRoot, macroId, parentWorkflowPath, commit = 'b'.repeat(40)) {
    const err = [];
    const result = await writebackParent({
      repoRoot,
      parentWorkflowId: macroId,
      parentWorkflowPath,
      originatingSubtaskId: 'T1',
      engineerWorkflowId: CHILD_ID,
      commit,
      host: 'claude',
      orchestratorRoot: ORCHESTRATOR_ROOT,
      stderr: { write: (s) => err.push(s) },
    });
    return { result, stderr: err.join('') };
  }

  describe(`${persona}: writebackParent tries the recorded path first (ADR-0067 Decision 3)`, () => {
    // Contract: writebackParent — the recorded path is what reaches a macro
    // kept in another checkout; without it the child's own homes are searched
    // and the note is lost.
    it('writes back through the recorded path when the candidates under repoRoot would miss', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const without = await writeback(lane, macroId, undefined, 'c'.repeat(40));
        strictEqual(without.result.reason, 'parent-not-found', 'the candidates under the lane miss the macro');
        const { result, stderr } = await writeback(lane, macroId, macroPath);
        strictEqual(result.ok, true, stderr);
        strictEqual(result.envelope.noted, true);
        ok(readFileSync(macroPath, 'utf8').includes(noteOf(CHILD_ID, 'b'.repeat(40))));
      });
    });

    // Contract: writebackParent — a recorded path that names the wrong file is
    // refused, and the candidates are not searched: guessing would note the
    // commit on whichever copy happens to sit under repoRoot.
    it('refuses a recorded path naming a file that is not the macro, or a malformed one, and does not search the candidates', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath: laneMacro, macroId } = makeMacro(lane);
        const other = makeMacro(main, 'other');
        const wrongHome = join(main, 'wrong', ORCH_WORKFLOWS_REL);
        mkdirSync(wrongHome, { recursive: true });
        const wrong = join(wrongHome, `${macroId}.md`);
        copyFileSync(other.macroPath, wrong);
        const before = readFileSync(laneMacro, 'utf8');
        for (const [path, why] of [
          [wrong, new RegExp(`is not macro ${macroId}: its workflow_id is "${other.macroId}"`)],
          [`relative/${ORCH_WORKFLOWS_REL}/${macroId}.md`, /it is not absolute/],
          [join(main, ORCH_ARCHIVE_REL, `${macroId}.md`), /it is not in an orchestrator workflows home/],
        ]) {
          const { result, stderr } = await writeback(lane, macroId, path);
          deepStrictEqual([result.ok, result.skipped, result.reason], [false, true, 'parent-path-invalid'], stderr);
          match(stderr, why);
          strictEqual(readFileSync(laneMacro, 'utf8'), before, `${path}: the candidate is untouched`);
        }
      });
    });

    // Contract: writebackParent — two files holding one macro id are two
    // writable copies (ADR-0067 Decision 4); noting either would leave the
    // other stale, so neither is written.
    it('refuses when a second file holds the macro id, the recorded path included; one file reached twice is not a second copy', async () => {
      await withCheckoutsAsync(async ({ dir, main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const copy = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(macroPath, copy);
        const before = readFileSync(macroPath, 'utf8');
        const { result, stderr } = await writeback(lane, macroId, macroPath);
        deepStrictEqual([result.ok, result.reason], [false, 'parent-ambiguous'], stderr);
        ok(stderr.includes(macroPath) && stderr.includes(copy), stderr);
        strictEqual(readFileSync(macroPath, 'utf8'), before);
        strictEqual(readFileSync(copy, 'utf8'), before);
        // The two candidate homes of one checkout count too, and so does the
        // other home of the checkout the recorded path names, though repoRoot
        // is elsewhere.
        rmSync(copy);
        const legacy = join(main, '.claude/agentic-orchestrator/workflows', `${macroId}.md`);
        mkdirSync(dirname(legacy), { recursive: true });
        copyFileSync(macroPath, legacy);
        strictEqual((await writeback(main, macroId, undefined)).result.reason, 'parent-ambiguous');
        const viaRecorded = await writeback(lane, macroId, macroPath);
        deepStrictEqual([viaRecorded.result.ok, viaRecorded.result.reason], [false, 'parent-ambiguous'], viaRecorded.stderr);
        ok(viaRecorded.stderr.includes(legacy), viaRecorded.stderr);
        strictEqual(readFileSync(macroPath, 'utf8'), before);
        rmSync(legacy);
        // The same file through a symlinked checkout is one file.
        const linked = join(dir, 'linked-main');
        symlinkSync(main, linked);
        const once = await writeback(linked, macroId, macroPath);
        strictEqual(once.result.ok, true, once.stderr);
      });
    });

    // Contract: writebackParent — a path that names no file is the macro
    // having moved (a cutover) or been archived, not a wrong file: the
    // candidates are searched, as for a child with no path.
    it('a recorded path that names no file falls back to the candidates; a macro archived in the recorded home reads as archived', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const moved = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(moved), { recursive: true });
        renameSync(macroPath, moved);
        const { result, stderr } = await writeback(lane, macroId, macroPath);
        strictEqual(result.ok, true, stderr);
        ok(readFileSync(moved, 'utf8').includes(noteOf(CHILD_ID, 'b'.repeat(40))));
        // Archived where the recorded path points: the archive-fallback skip.
        const archived = join(main, ORCH_ARCHIVE_REL, `${macroId}.md`);
        mkdirSync(dirname(archived), { recursive: true });
        renameSync(moved, archived);
        const after = await writeback(lane, macroId, macroPath, 'd'.repeat(40));
        deepStrictEqual([after.result.ok, after.result.reason], [false, 'parent-archived'], after.stderr);
      });
    });

    // Contract: writebackParent — the recorded checkout's homes are searched
    // when its path names no file: a macro moved from the legacy home to the
    // canonical one of the same checkout (runtime:migrate) is still reached.
    it('a recorded path in a legacy home reaches the macro there, and in the canonical home of the same checkout once it is migrated', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const legacy = join(main, '.claude/agentic-orchestrator/workflows', `${macroId}.md`);
        mkdirSync(dirname(legacy), { recursive: true });
        renameSync(macroPath, legacy);
        const first = await writeback(lane, macroId, legacy);
        strictEqual(first.result.ok, true, first.stderr);
        renameSync(legacy, macroPath);
        const second = await writeback(lane, macroId, legacy, 'e'.repeat(40));
        strictEqual(second.result.ok, true, second.stderr);
        ok(readFileSync(macroPath, 'utf8').includes(noteOf(CHILD_ID, 'e'.repeat(40))));
      });
    });

    // Contract: writebackParent judges the file a path resolves to — a
    // symlinked workflows home or macro file must not route the note into an
    // archived macro (ADR-0067 Decision 3: the macro found is not archived).
    it('refuses a recorded path or a candidate that resolves into archive/ through a symlink', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const archiveDir = join(main, ORCH_ARCHIVE_REL);
        mkdirSync(archiveDir, { recursive: true });
        const archived = join(archiveDir, `${macroId}.md`);
        renameSync(macroPath, archived);
        const before = readFileSync(archived, 'utf8');
        const linkedHome = join(lane, 'other', ORCH_WORKFLOWS_REL);
        mkdirSync(dirname(linkedHome), { recursive: true });
        symlinkSync(archiveDir, linkedHome);
        const viaHome = await writeback(lane, macroId, join(linkedHome, `${macroId}.md`));
        deepStrictEqual([viaHome.result.ok, viaHome.result.reason], [false, 'parent-path-invalid'], viaHome.stderr);
        match(viaHome.stderr, /the file it resolves to, [^:]+: it is not in an orchestrator workflows home/);
        const candidate = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(candidate), { recursive: true });
        symlinkSync(archived, candidate);
        const viaFile = await writeback(lane, macroId, undefined);
        deepStrictEqual([viaFile.result.ok, viaFile.result.reason], [false, 'parent-id-mismatch'], viaFile.stderr);
        strictEqual(readFileSync(archived, 'utf8'), before, 'the archived macro is untouched');
      });
    });

    // Contract: writebackParent — a recorded path that cannot be inspected is
    // not a macro that moved: falling back would note the commit on whatever
    // copy sits under repoRoot.
    it('refuses a recorded path it cannot inspect instead of searching the candidates', { skip: process.getuid?.() === 0 && 'root reads through permissions' }, async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        // A copy under repoRoot, which a fallback would write to.
        const laneCopy = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(laneCopy), { recursive: true });
        copyFileSync(macroPath, laneCopy);
        const before = readFileSync(laneCopy, 'utf8');
        chmodSync(dirname(macroPath), 0o000);
        try {
          const { result, stderr } = await writeback(lane, macroId, macroPath);
          deepStrictEqual([result.ok, result.reason], [false, 'parent-unreadable'], stderr);
          match(stderr, /cannot be judged: it cannot be inspected \(EACCES\)/);
        } finally {
          chmodSync(dirname(macroPath), 0o700);
        }
        strictEqual(readFileSync(laneCopy, 'utf8'), before, 'the candidate is untouched');
      });
    });

    // Contract: writebackParent — a file whose workflow_id is written twice
    // reads as one macro here and the other to the orchestrator, which keeps
    // the last; it is refused rather than written as a different macro.
    it('refuses a candidate whose frontmatter sets workflow_id twice', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const dup = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(dup), { recursive: true });
        writeFileSync(dup, readFileSync(macroPath, 'utf8').replace(/^(workflow_id: .*)$/m, '$1\nworkflow_id: "macro-plan-20261008T000000Z-ffffff"'));
        const { result, stderr } = await writeback(lane, macroId, undefined);
        deepStrictEqual([result.ok, result.reason], [false, 'parent-id-mismatch'], stderr);
        match(stderr, /its frontmatter sets workflow_id more than once/);
      });
    });

    // Contract: writebackParent hands the orchestrator the id it resolved the
    // file for (tests/orchestrator/test-engineer-terminal.mjs: the locked
    // re-check). Without it, a file replaced between this check and the
    // orchestrator's lock is written as whatever macro it then holds.
    it('passes the macro id to the orchestrator for its re-check under the lock', async () => {
      await withCheckoutsAsync(async ({ dir, main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const fake = join(dir, 'fake-orchestrator');
        mkdirSync(join(fake, 'scripts'), { recursive: true });
        writeFileSync(join(fake, 'scripts', 'state.mjs'), 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");\n');
        const err = [];
        const result = await writebackParent({
          repoRoot: lane, parentWorkflowId: macroId, parentWorkflowPath: macroPath, originatingSubtaskId: 'T1',
          engineerWorkflowId: CHILD_ID, commit: 'b'.repeat(40), host: 'claude', orchestratorRoot: fake,
          stderr: { write: (s) => err.push(s) },
        });
        strictEqual(result.ok, true, err.join(''));
        ok(result.envelope.argv.includes(`--expect-workflow-id=${macroId}`), JSON.stringify(result.envelope.argv));
        ok(result.envelope.argv.includes(`--workflow-path=${realpathSync(macroPath)}`), JSON.stringify(result.envelope.argv));
      });
    });

    // Contract: writebackParent hands the orchestrator the file it physically
    // is. The orchestrator locks and atomically replaces the path it is given,
    // so a symlink handed over is replaced by a copy carrying the note while
    // the macro stays unchanged: an ok writeback that forks the record
    // (ADR-0067 Decision 4).
    it('writes the macro itself when a candidate or the recorded path is a symlink to it, and leaves the link a link', async () => {
      await withCheckoutsAsync(async ({ dir, main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const candidateLink = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(candidateLink), { recursive: true });
        symlinkSync(macroPath, candidateLink);
        const viaCandidate = await writeback(lane, macroId, undefined, 'c'.repeat(40));
        strictEqual(viaCandidate.result.ok, true, viaCandidate.stderr);
        ok(lstatSync(candidateLink).isSymbolicLink(), 'the candidate is still a link');
        ok(readFileSync(macroPath, 'utf8').includes(noteOf(CHILD_ID, 'c'.repeat(40))), 'the macro holds the note');
        rmSync(candidateLink);
        const recordedLink = join(dir, 'third', ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(recordedLink), { recursive: true });
        symlinkSync(macroPath, recordedLink);
        const viaRecorded = await writeback(lane, macroId, recordedLink, 'd'.repeat(40));
        strictEqual(viaRecorded.result.ok, true, viaRecorded.stderr);
        ok(lstatSync(recordedLink).isSymbolicLink(), 'the recorded path is still a link');
        ok(readFileSync(macroPath, 'utf8').includes(noteOf(CHILD_ID, 'd'.repeat(40))), 'the macro holds the note');
      });
    });

    // Contract: writebackParent counts the recorded path by the file it
    // physically is. Spelled through a symlinked checkout, it is the same
    // file the search finds in that checkout's home, not a second copy.
    it('a recorded path spelled through a symlinked checkout is one file with the copy found in its home', async () => {
      await withCheckoutsAsync(async ({ dir, main, lane }) => {
        const { macroPath, macroId } = makeMacro(main);
        const linkedMain = join(dir, 'linked-main');
        symlinkSync(main, linkedMain);
        const { result, stderr } = await writeback(lane, macroId, join(linkedMain, ORCH_WORKFLOWS_REL, `${macroId}.md`));
        strictEqual(result.ok, true, stderr);
        ok(readFileSync(macroPath, 'utf8').includes(noteOf(CHILD_ID, 'b'.repeat(40))));
      });
    });

    // Contract: writebackParent — the id check holds on the candidate path too:
    // a file named after the macro that is another macro gets no note.
    it('refuses a candidate that is not the macro', async () => {
      await withCheckoutsAsync(async ({ main, lane }) => {
        const { macroId } = makeMacro(main);
        const other = makeMacro(main, 'other');
        const impostor = join(lane, ORCH_WORKFLOWS_REL, `${macroId}.md`);
        mkdirSync(dirname(impostor), { recursive: true });
        copyFileSync(other.macroPath, impostor);
        const before = readFileSync(impostor, 'utf8');
        const { result, stderr } = await writeback(lane, macroId, undefined);
        deepStrictEqual([result.ok, result.reason], [false, 'parent-id-mismatch'], stderr);
        strictEqual(readFileSync(impostor, 'utf8'), before);
      });
    });

    // Contract: writebackParent — an archive entry counts as this macro only
    // as `<id>.md` or `<id>-…` (archiveWorkflow's collision suffix); a macro
    // whose id merely starts with this one is another macro (the prefix match
    // ADR-0067 Decision 3 fixes).
    it('counts only `<id>.md` or `<id>-…` in archive/ as the macro archived', async () => {
      await withCheckoutsAsync(async ({ lane }) => {
        const macroId = 'macro-plan-20261008T000000Z-abc123';
        const archive = join(lane, ORCH_ARCHIVE_REL);
        mkdirSync(archive, { recursive: true });
        writeFileSync(join(archive, `${macroId}0.md`), '---\n---\n');
        strictEqual((await writeback(lane, macroId, undefined)).result.reason, 'parent-not-found');
        writeFileSync(join(archive, `${macroId}-20261008T010203Z-0a1b2c.md`), '---\n---\n');
        strictEqual((await writeback(lane, macroId, undefined)).result.reason, 'parent-archived');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // an older child

  // Contract: every child written before ADR-0067 — no path recorded; it must
  // write back exactly as before, through the candidates under repoRoot.
  describe(`${persona}: a child without parent_workflow_path (written before ADR-0067)`, () => {
    it('writes back through the candidates under repoRoot, as before', async () => {
      await withCheckoutsAsync(async ({ main }) => {
        const { macroPath, macroId } = makeMacro(main);
        const r = runState(createArgs(main, ['--parent-workflow', macroId, '--originating-subtask', 'T1']));
        strictEqual(r.status, 0, r.stderr);
        const child = JSON.parse(runState(['read', '--workflow-path', r.stdout.trim()]).stdout);
        strictEqual('parent_workflow_path' in child, false);
        const { result, stderr } = await writeback(main, macroId, child.parent_workflow_path);
        strictEqual(result.ok, true, stderr);
        ok(readFileSync(macroPath, 'utf8').includes(noteOf(CHILD_ID, 'b'.repeat(40))));
      });
    });
  });
}
