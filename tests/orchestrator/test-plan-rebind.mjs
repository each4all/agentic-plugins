// ADR-0068 Decision 8 — rebinding a dispatched subtask after an
// owner-approved change of its instructions (impl-rebind, docket C147).
//
// Each case runs on a scratch repository (fixtures/autopilot-repo.mjs) with
// this checkout's orchestrator and engineer: a child is dispatched as
// /orchestrator:next does (its dispatch selection recorded), the owner revises
// the plan and approves it, and every write that binds the child compares.
// The mutation spec scripts/mutation-specs/orchestrator-rebind.mjs names the
// defect each test exists for.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENG, ORCH, REPO_ROOT, makeRepo } from './fixtures/autopilot-repo.mjs';
import { acquireLock, joinAdmission, macroLockPath, readLockEntries, tokenDigest } from '../../plugins/orchestrator/scripts/lib/run-locks.mjs';
import { acknowledgeInRecord, deliveryNote, deriveRebindView, parseRebindRecord, REBIND_RECORD_MAX_BYTES, vouchVerdict } from '../../plugins/orchestrator/scripts/lib/rebind.mjs';
import { rebindDue } from '../../plugins/orchestrator/adapters/claude/autopilot/rebind-boundary.mjs';
import { childCopies } from '../../plugins/orchestrator/scripts/state.mjs';

const STATE = resolve(ORCH, 'scripts/state.mjs');
const OWNER = {};
const H = 'claude';

async function withRepo(fn, opts = {}) {
  const fx = await makeRepo({ subtasks: [{ id: 'A' }, { id: 'B' }], ...opts });
  try {
    return await fn(fx);
  } finally {
    fx.cleanup();
  }
}

// /orchestrator:next's effect, with the dispatch selection the child records.
async function dispatch(fx, id, { record = true } = {}) {
  const s = await fx.subtask(id);
  fx.git('switch', '-q', '--no-track', '-c', s.branch, 'refs/remotes/origin/main');
  const { filePath } = await fx.eng.createWorkflow({
    repoRoot: fx.work, verb: s.verb, host: H, profile: s.profile, originalRequest: s.topic,
    gitBaseline: { branch: s.branch, head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
    currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb',
    parentWorkflow: fx.macroId, originatingSubtask: id,
    ...(record ? { dispatchSelection: { subtask: id, branch: s.branch, verb: s.verb, profile: s.profile, topic: s.topic } } : {}),
  });
  const childId = (await fx.eng.readWorkflow(filePath)).frontmatter.workflow_id;
  await fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: id, host: H, status: 'in_progress', engineerWorkflowId: childId });
  return { path: filePath, id: childId };
}

// The dispatch a child records, as the engineer's writeback passes it.
async function expectOf(childPath) {
  const fm = (await readChild(childPath)).frontmatter;
  const d = { macro: fm.parent_workflow, subtask: fm.originating_subtask };
  if (typeof fm.dispatched_branch === 'string') {
    Object.assign(d, { branch: fm.dispatched_branch, verb: fm.dispatched_verb, profile: fm.dispatched_profile, topic: fm.dispatched_topic });
  } else {
    d.branch = fm.git_baseline.branch;
  }
  return JSON.stringify(d);
}

async function readChild(path) {
  return import(pathToFileURL(resolve(ENG, 'scripts/state.mjs')).href).then((eng) => eng.readWorkflow(path));
}

async function revise(fx, id, fields) {
  const m = await fx.readMacro();
  const subtasks = m.plan.subtasks.map((s) => (s.id === id ? { ...s, ...fields } : s));
  await fx.orch.setPlan({ workflowPath: fx.macroPath, host: H, subtasks });
}

async function approve(fx, opts = {}) {
  const { digest } = fx.orch.planRebindView({ workflowPath: fx.macroPath });
  return fx.orch.approvePlan({ workflowPath: fx.macroPath, host: H, env: OWNER, expectRebind: digest, ...opts });
}

const record = async (fx) => parseRebindRecord((await fx.readMacro()).plan_rebindings);

// The note of pending delivery `p` written into the child as a delivery
// writes it (a crash before its acknowledgement), or, with `words`, its
// heading over other words.
async function writeNote(fx, child, p, { words } = {}) {
  const { record: r } = await record(fx);
  const text = words ?? deliveryNote({ macroId: fx.macroId, subtaskId: p.subtask, approvedAt: r.approval.at, from: p.from, to: p.to, restate: p.restate === true });
  await fx.eng.appendPhase({ workflowPath: child.path, host: H, phaseLabel: `Owner instruction change (${p.delivery_id})`, phaseNote: text, event: 'updated' });
}
const macroText = (fx) => readFileSync(fx.macroPath, 'utf8');
const childText = (path) => readFileSync(path, 'utf8');

function terminal(fx, id, child, expect) {
  return fx.orch.recordEngineerTerminal({
    workflowPath: fx.macroPath, host: H, subtaskId: id, engineerWorkflowId: child.id, branchCommit: 'abc1234', expectDispatch: expect,
  });
}

function complete(fx, id, child, expect, extra = {}) {
  return fx.orch.updateSubtask({
    workflowPath: fx.macroPath, host: H, subtaskId: id, status: 'completed', engineerWorkflowId: child.id,
    commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', expectDispatch: expect, ...extra,
  });
}

// The re-attach /orchestrator:next makes, under the dispatch the child records.
function reattach(fx, child, expect) {
  return fx.orch.updateSubtask({
    workflowPath: fx.macroPath, subtaskId: 'A', host: H, status: 'in_progress', engineerWorkflowId: child.id, expectDispatch: expect,
  });
}

// The refusal of a binding write the macro's record cannot vouch for
// (lib/rebind.mjs vouchVerdict).
const notVouched = (child) => new RegExp(`${child.id} is not bound to subtask "A": what ${child.id} was last told is not known`);

// The refusal of a binding write while more than one file bears the child
// (state.mjs childCopies), `n` of them, named; `archived` offers the told
// waiver, and `same` (the files hold the same notes) names which to keep.
const copiesRefused = (child, n, { archived = false, same } = {}) => new RegExp(
  `${child.id} is not bound to subtask "A": more than one copy of ${child.id} may run \\(${n} workflow files bear its id or name: [^)]+\\), ` +
    'so which words its work answers to is not known; repair or remove the extra copies' +
    (same === undefined ? '( \\(they hold the same notes[^)]+\\))?' : ` \\(they hold the same notes, [^)]+: keep ${same} and remove the others\\)`) +
    (archived ? `, or, since ${child.id} is archived` : '\\.'));

// A workflow file whose frontmatter never opens: the claim scan skips it.
const unopenedFile = (path) => writeFileSync(path, readFileSync(path, 'utf8').replace(/^---\n/, '--x\n'));
const setStartedAt = (path, iso) => writeFileSync(path, readFileSync(path, 'utf8').replace(/^started_at: .*$/m, () => `started_at: ${JSON.stringify(iso)}`));

// Another child of `id`, created on its branch (checked out) as
// /orchestrator:next creates one and not yet bound, its start set to `startedAt`.
async function freshChild(fx, id, startedAt) {
  const s = await fx.subtask(id);
  const { filePath } = await fx.eng.createWorkflow({
    repoRoot: fx.work, verb: s.verb, host: H, profile: s.profile, originalRequest: s.topic,
    gitBaseline: { branch: s.branch, head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
    currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb',
    parentWorkflow: fx.macroId, originatingSubtask: id,
    dispatchSelection: { subtask: id, branch: s.branch, verb: s.verb, profile: s.profile, topic: s.topic },
  });
  setStartedAt(filePath, startedAt);
  return { path: filePath, id: (await fx.eng.readWorkflow(filePath)).frontmatter.workflow_id };
}

// The macro's record of rebindings made unreadable, whether or not an
// approval wrote one.
function corruptRecord(fx) {
  const parsed = fx.orch.parseWorkflowFile(readFileSync(fx.macroPath, 'utf8'));
  parsed.frontmatter.plan_rebindings = '{unreadable';
  writeFileSync(fx.macroPath, fx.orch.assembleWorkflowFile(parsed.frontmatter, parsed.body));
}

function cli(fx, args) {
  return execFileSync(process.execPath, [STATE, ...args], { encoding: 'utf8', env: fx.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8 — the C147 case', () => {
  it('a topic revised and approved while the child works: told, bound at its terminal note, accepted at done', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'do A, the owner\'s revised words' });
      // Before the approval: refused, and the refusal says why.
      await rejects(() => terminal(fx, 'A', child, expect), (err) => /\(dispatch-changed\)/.test(err.message)
        && /pending approval/.test(err.message) && /\/orchestrator:approve/.test(err.message));

      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.rebindings, 1);
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      const rec = (await record(fx)).record;
      strictEqual(rec.rebindings[0].child, child.id);
      deepStrictEqual(rec.rebindings[0].fields, ['topic']);
      deepStrictEqual(rec.pending, []);
      strictEqual(rec.told[child.id].topic, 'do A, the owner\'s revised words');
      // The child holds the note: old and new words, verbatim.
      const note = childText(child.path);
      ok(note.includes(`### Owner instruction change (${rec.told[child.id].delivery_id})`));
      ok(note.includes('```text\ndo A\n```') && note.includes('```text\ndo A, the owner\'s revised words\n```'), note);
      // Audited in the macro body.
      ok(macroText(fx).includes(`- A: ${child.id} (active, next step none recorded (phase phase-0-bootstrap)): rebound from its dispatch on topic to topic "do A, the owner's revised words" (words ${rec.rebindings[0].to_digest.slice(0, 12)}); told the change of topic by delivery ${rec.told[child.id].delivery_id}`), macroText(fx));

      const noted = await terminal(fx, 'A', child, expect);
      strictEqual(noted.noted, true);
      ok(/Rebound \(ADR-0068 Decision 8\): accepted under the approval of/.test(macroText(fx)));
      const done = await complete(fx, 'A', child, expect);
      strictEqual(done.updatedSubtask.status, 'completed');
    });
  });

  it('an archived child, approved after its commit, is bound and completed with no note', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await fx.commitAndArchive(child.path);
      const archived = child.path.replace('/workflows/', '/archive/');
      await revise(fx, 'A', { topic: 'do A, revised after the commit' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.delivery]), [['rebind', 'archived', null]]);
      strictEqual(view.rows[0].refused, undefined, 'an archived child told nothing else is not refused');
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.pendingDeliveries, 0);
      strictEqual(r.deliveries, undefined);
      ok(macroText(fx).includes('rebound from its dispatch on topic'));
      ok(!childText(archived).includes('Owner instruction change'));
      await terminal(fx, 'A', child, expect);
      strictEqual((await complete(fx, 'A', child, expect)).updatedSubtask.status, 'completed');
    });
  });

  it('the done runbook\'s owner scan and its subtask-update CLI accept the rebound child', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { profile: 'frontend' });
      await approve(fx, { engineerRoot: ENG });
      const owner = JSON.parse(cli(fx, ['owner-dispatch', '--repo-root', fx.work, '--macro-id', fx.macroId,
        '--workflow-path', fx.macroPath, '--subtask-id', 'A', '--host', H, '--engineer-workflow-id', child.id]));
      cli(fx, ['subtask-update', '--workflow-path', fx.macroPath, '--host', H, '--subtask-id', 'A', '--status', 'completed',
        '--engineer-workflow-id', owner.engineer_workflow_id, '--commit', 'def5678', '--closed-at', '2026-10-20T00:00:00Z',
        '--expect-dispatch', owner.dispatch]);
      strictEqual((await fx.subtask('A')).status, 'completed');
    });
  });
});

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8, item 6 — refused without the current approval', () => {
  it('an unapproved revision is refused dispatch-changed in every binding path', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'unapproved words' });
      for (const write of [() => terminal(fx, 'A', child, expect), () => complete(fx, 'A', child, expect),
        () => fx.orch.updateSubtask({ workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'in_progress', engineerWorkflowId: child.id, expectDispatch: expect })]) {
        await rejects(write, /\(dispatch-changed\).*No rebinding applies: the plan is pending approval/s);
      }
    });
  });

  it('a stale approval (a plan-set after it) suspends the rebinding; approving again restores it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await revise(fx, 'B', { topic: 'another subtask changed' });
      await rejects(() => terminal(fx, 'A', child, expect), /No rebinding applies: the plan is pending approval/);
      ok((await fx.readMacro()).plan_rebindings, 'the record stays, as history');
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('an approval stamp that is not the record\'s (an older approver\'s) rebinds nothing', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      // An older plan-approve writes a new time and keeps the id it does not know.
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_approval_approved_at: ".*"$/m, 'plan_approval_approved_at: "2030-01-01T00:00:00Z"'));
      await rejects(() => terminal(fx, 'A', child, expect), /belongs to an earlier approval \(stale/);
    });
  });

  it('a child the approval did not name is refused, though another child of the subtask was rebound', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const other = JSON.parse(expect);
      await rejects(() => fx.orch.recordEngineerTerminal({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: 'compose-20261020T000000Z-0ther0',
        branchCommit: 'abc1234', expectDispatch: JSON.stringify(other),
      }), /did not rebind compose-20261020T000000Z-0ther0 for A/);
      await rejects(() => fx.orch.updateSubtask({ workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'in_progress', expectDispatch: expect }),
        /names no child workflow/);
      // The same child passing another dispatch than the one the approval rebound.
      await rejects(() => terminal(fx, 'A', child, JSON.stringify({ ...other, profile: 'frontend' })),
        /rebound compose-\S+ from another dispatch than the one this write passes/);
    });
  });

  it('an archived child the approval did not name is refused, though it passes the rebound dispatch and no owner is recorded', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await fx.commitAndArchive(child.path);
      // A missed writeback: no owner check stands behind the comparison.
      writeFileSync(fx.macroPath, macroText(fx).replace(/^ {6}engineer_workflow_id: .*\n/m, ''));
      await revise(fx, 'A', { topic: 'do A, revised after the commit' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.owner]), [['rebind', 'archived', 'sole-claimant']]);
      await approve(fx, { engineerRoot: ENG });
      await rejects(() => fx.orch.recordEngineerTerminal({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: 'compose-20261020T000000Z-0ther0',
        branchCommit: 'abc1234', expectDispatch: expect,
      }), /did not rebind compose-20261020T000000Z-0ther0 for A/);
      strictEqual((await fx.subtask('A')).engineer_workflow_id, undefined, 'the other child is not bound as the owner');
      strictEqual((await terminal(fx, 'A', child, expect)).boundOwner, true);
    });
  });

  it('an active child not yet told is refused until the delivery completes', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      const r = await approve(fx);
      strictEqual(r.pendingDeliveries, 1);
      await rejects(() => terminal(fx, 'A', child, expect), /has not been told the change yet \(delivery d-[0-9a-f]{16} is pending/);
      const out = JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG]));
      deepStrictEqual(out.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The record as its macro holds it, edited in place: the approval's stamp is untouched.
  async function editRecord(fx, edit) {
    const text = macroText(fx);
    const m = /^plan_rebindings: (.*)$/m.exec(text);
    const rec = JSON.parse(JSON.parse(m[1]));
    edit(rec);
    writeFileSync(fx.macroPath, text.replace(m[0], () => `plan_rebindings: ${JSON.stringify(JSON.stringify(rec))}`));
  }

  it('a rebound active child whose record of what it was told is not the rebinding\'s words is refused', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const told = (await record(fx)).record.told[child.id];
      for (const edit of [
        (r) => { delete r.told[child.id]; },
        (r) => { r.told[child.id] = { ...told, subtask: 'B' }; },
        (r) => { r.told[child.id] = { ...told, topic: 'other words' }; },
      ]) {
        await editRecord(fx, edit);
        strictEqual((await record(fx)).status, 'readable');
        await rejects(() => terminal(fx, 'A', child, expect), /has not been told the change; approve the plan again to deliver it/);
        await editRecord(fx, (r) => { r.told[child.id] = told; });
      }
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('a changed branch, verb or subtask id is refused at every binding, and shown not rebindable', async () => {
    for (const [field, value] of [['branch', 'feat/a2'], ['verb', 'refine']]) {
      await withRepo(async (fx) => {
        const child = await dispatch(fx, 'A');
        const expect = await expectOf(child.path);
        await revise(fx, 'A', { [field]: value, topic: 'and new words' });
        const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
        deepStrictEqual(view.rows.map((r) => [r.kind, r.not_rebindable, r.delivery]), [['not-rebindable', [field], null]]);
        await approve(fx, { engineerRoot: ENG });
        strictEqual((await record(fx)).status, 'absent');
        ok(macroText(fx).includes(`not rebindable (${field} changed): its writes stay refused dispatch-changed`));
        await rejects(() => terminal(fx, 'A', child, expect), new RegExp(`a change of ${field} is not rebindable`));
        await rejects(() => complete(fx, 'A', child, expect), new RegExp(`a change of ${field} is not rebindable`));
      });
    }
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = JSON.parse(await expectOf(child.path));
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await rejects(() => terminal(fx, 'A', child, JSON.stringify({ ...expect, subtask: 'B' })), /dispatched for subtask "B".*a change of subtask is not rebindable/s);
    });
  });

  it('a child that recorded no verb, profile or topic is neither refused nor rebound on them, and shown so', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A', { record: false });
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'new words', verb: 'refine' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.not_compared, r.delivery]), [['matches', ['verb', 'profile', 'topic'], null]]);
      await approve(fx, { engineerRoot: ENG });
      ok(macroText(fx).includes('matches its dispatch; not compared on verb, profile, topic (its dispatch recorded none)'));
      strictEqual((await record(fx)).status, 'absent');
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });
});

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8, items 2 and 4 — repeated revisions and the notes', () => {
  it('A to B to C: each approval derives from the dispatch, only the latest binds, each change is told in order', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const first = (await record(fx)).record;
      await revise(fx, 'A', { topic: 'C words' });
      await approve(fx, { engineerRoot: ENG });
      const second = (await record(fx)).record;
      strictEqual(second.rebindings[0].from_digest, first.rebindings[0].from_digest, 'from is always the dispatch');
      ok(second.rebindings[0].to_digest !== first.rebindings[0].to_digest);
      const text = childText(child.path);
      const one = text.indexOf(`(${first.told[child.id].delivery_id})`);
      const two = text.indexOf(`(${second.told[child.id].delivery_id})`);
      ok(one > 0 && two > one, 'B told before C');
      ok(text.slice(two).includes('```text\nB words\n```') && text.slice(two).includes('```text\nC words\n```'));
      // Each rebinding stays in the macro body with the words it approved.
      ok(macroText(fx).includes(`rebound from its dispatch on topic to topic "B words" (words ${first.rebindings[0].to_digest.slice(0, 12)})`));
      ok(macroText(fx).includes(`rebound from its dispatch on topic to topic "C words" (words ${second.rebindings[0].to_digest.slice(0, 12)})`));
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('A to B and back to A: no rebinding, but the return is told', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await revise(fx, 'A', { topic: 'do A' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.delivery?.fields]), [['matches', ['topic']]]);
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.rebindings, 0);
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      const rec = (await record(fx)).record;
      deepStrictEqual(rec.rebindings, []);
      strictEqual(rec.told[child.id].topic, 'do A');
    });
  });

  // The owner sends subtask A back to pending, its child left active.
  const toPending = (fx) => fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: 'A', host: H, status: 'pending' });

  it('a child whose subtask went back to pending is told a return to its dispatch before a re-attach binds it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await toPending(fx);
      strictEqual((await fx.subtask('A')).status, 'pending');
      await revise(fx, 'A', { topic: 'do A' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.subtask, r.kind, r.status, r.delivery?.fields]), [['A', 'told', 'pending', ['topic']]]);
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.rebindings, 0, 'a subtask not in progress is rebound by nothing');
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      const rec = (await record(fx)).record;
      strictEqual(rec.told[child.id].topic, 'do A');
      ok(macroText(fx).includes(`- A: ${child.id} (active, next step`) && macroText(fx).includes('not in progress (pending), and rebound by nothing'));
      const text = childText(child.path);
      const note = text.slice(text.lastIndexOf('### Owner instruction change ('));
      ok(note.includes('```text\nB words\n```') && note.includes('```text\ndo A\n```'), 'the return to the dispatch is told');
      // The re-attach /orchestrator:next makes, under the matching dispatch.
      await fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: 'A', host: H, status: 'in_progress', engineerWorkflowId: child.id, expectDispatch: expect });
      strictEqual((await fx.subtask('A')).status, 'in_progress');
    });
    // The same after a record that could not be read, the child unreadable at
    // the approval that replaced it: the subtask, not in progress, is named
    // nothing, and the re-attach refuses the child until a note restates its
    // words, which the next approval that reads the child writes.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await toPending(fx);
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
      await revise(fx, 'A', { topic: 'do A' });
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^---\n/, '--x\n'));
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).unknown, [], 'a subtask not in progress is never named unknown');
      await approve(fx, { engineerRoot: ENG });
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.unknown, typeof rec.replaced_at], [undefined, 'string']);
      writeFileSync(child.path, good);
      await rejects(() => reattach(fx, child, expect), notVouched(child));
      strictEqual((await fx.subtask('A')).status, 'pending', 'the refused re-attach wrote nothing');
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.subtask, r.kind, r.delivery?.restate]), [['A', 'told', true]]);
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
      ok(/restated in full/.test(childText(child.path).slice(childText(child.path).lastIndexOf('### Owner instruction change ('))));
      await reattach(fx, child, expect);
      strictEqual((await fx.subtask('A')).status, 'in_progress');
    });
  });

  it('after an unreadable record, a subtask not in progress whose recorded child is gone is not named unknown', async () => {
    // Its child has nothing left to run: a fresh dispatch serves the subtask,
    // and a name kept for the gone child would hold that dispatch's every step.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await toPending(fx);
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
      rmSync(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).unknown, []);
      await approve(fx, { engineerRoot: ENG });
      const parsed = await record(fx);
      strictEqual(parsed.record?.unknown, undefined, 'the gone child is not named unknown');
    });
  });

  // The sequences the approval-time classifier misjudged (ADR-0068 Decision
  // 8, item 4): a child X of A is told B, A goes back to pending, the record
  // becomes unreadable, A is revised back to its dispatch, and the claim scan
  // cannot say at the approval that replaces the record whether X may still
  // run. Whatever it makes of X, X is refused at the re-attach and at the
  // terminal writeback until a note restates its words, and bound once one has.
  it('after an unreadable record, a child the record cannot vouch for is refused at the re-attach and the terminal writeback until a note restates its words', async () => {
    const archived = (path) => path.replace(/\/workflows\/([^/]+)$/, '/archive/$1');
    const unopened = unopenedFile;
    const clearOwner = async (fx, fields = {}) => {
      const m = await fx.readMacro();
      await fx.orch.setPlan({
        workflowPath: fx.macroPath, host: H,
        subtasks: m.plan.subtasks.map((s) => (s.id === 'A'
          ? { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'engineer_workflow_id')), ...fields } : s)),
      });
    };
    // Another claimant of A, archived, its file a copy of the child's under another id.
    const otherClaimant = (child, suffix) => {
      const otherId = child.id.slice(0, -6) + suffix;
      const other = archived(child.path).replace(child.id, otherId);
      mkdirSync(resolve(other, '..'), { recursive: true });
      writeFileSync(other, childText(child.path).split(child.id).join(otherId));
    };
    const variants = [
      {
        name: 'the owner cleared by the re-plan, the restating note not written yet',
        state: async (fx) => { await clearOwner(fx); },
        replaceWith: {},
        approveAgain: false,
        repair: async (fx) => {
          const out = await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER });
          deepStrictEqual(out.map((d) => [d.status, d.child]), [['delivered', fx.child.id]]);
        },
      },
      {
        // Two files bear the child: refused as such until the owner's repair.
        name: 'a readable archived copy beside an active one the scan skips',
        refusal: (child) => copiesRefused(child, 2),
        state: async (fx) => {
          mkdirSync(resolve(archived(fx.child.path), '..'), { recursive: true });
          writeFileSync(archived(fx.child.path), childText(fx.child.path));
          unopened(fx.child.path);
        },
        repair: async (fx) => { writeFileSync(fx.child.path, fx.good); rmSync(archived(fx.child.path)); },
      },
      {
        name: 'no owner, and another claimant archived beside the active child',
        state: async (fx) => { otherClaimant(fx.child, 'bbbbb1'); await clearOwner(fx); },
        // Its owner recorded as done's binding line records it (no status).
        repair: async (fx) => {
          await fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: 'A', host: H, engineerWorkflowId: fx.child.id, expectDispatch: fx.expect });
        },
      },
      {
        name: 'no owner, two readable archived claimants, and the child\'s active copy the scan skips',
        state: async (fx) => { otherClaimant(fx.child, 'bbbbb1'); otherClaimant(fx.child, 'bbbbb2'); unopened(fx.child.path); await clearOwner(fx); },
        repair: async (fx) => {
          writeFileSync(fx.child.path, fx.good);
          await fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: 'A', host: H, engineerWorkflowId: fx.child.id, expectDispatch: fx.expect });
        },
      },
      {
        name: 'the child\'s own file unparsed, the owner recorded',
        state: async (fx) => { unopened(fx.child.path); },
        // An approval of another subtask while the child still cannot be
        // read tells it nothing, and keeps the replacement: the child, once
        // readable, is still refused until a note restates its words.
        repair: async (fx) => {
          await revise(fx, 'B', { topic: 'other B words' });
          await approve(fx, { engineerRoot: ENG });
          strictEqual(typeof (await record(fx)).record.replaced_at, 'string', 'a later approval keeps the replacement');
          writeFileSync(fx.child.path, fx.good);
          await rejects(() => reattach(fx, fx.child, fx.expect), notVouched(fx.child), 'still refused after another approval');
        },
      },
    ];
    for (const v of variants) {
      await withRepo(async (fx) => {
        fx.child = await dispatch(fx, 'A');
        fx.expect = await expectOf(fx.child.path);
        await revise(fx, 'A', { topic: 'B words' });
        await approve(fx, { engineerRoot: ENG });
        await toPending(fx);
        fx.good = childText(fx.child.path);
        writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
        await revise(fx, 'A', { topic: 'do A' });
        await v.state(fx);
        deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).unknown, [], `${v.name}: named nothing`);
        await approve(fx, v.replaceWith ?? { engineerRoot: ENG });
        await rejects(() => reattach(fx, fx.child, fx.expect), (v.refusal ?? notVouched)(fx.child), v.name);
        await rejects(() => terminal(fx, 'A', fx.child, fx.expect), (v.refusal ?? notVouched)(fx.child), v.name);
        strictEqual((await fx.subtask('A')).status, 'pending', `${v.name}: the refused writes wrote nothing`);
        await v.repair(fx);
        if (v.approveAgain !== false) {
          const r = await approve(fx, { engineerRoot: ENG });
          deepStrictEqual(r.deliveries.map((d) => [d.status, d.child]), [['delivered', fx.child.id]], v.name);
        }
        strictEqual((await record(fx)).record.told[fx.child.id].topic, 'do A', v.name);
        await reattach(fx, fx.child, fx.expect);
        strictEqual((await fx.subtask('A')).status, 'in_progress', v.name);
        deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows, [], `${v.name}: a child told since is not restated again`);
        strictEqual((await terminal(fx, 'A', fx.child, fx.expect)).noted, true, v.name);
      });
    }
  });

  it('after an unreadable record, a fresh dispatch is bound and retires its subtask\'s unknown, and never waits on it', async () => {
    await withRepo(async (fx) => {
      const old = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
      // The old child cannot be read at the approval that replaces the record,
      // so its in-progress subtask is named unknown.
      unopenedFile(old.path);
      await approve(fx);
      const replaced = (await record(fx)).record;
      deepStrictEqual(replaced.unknown, ['A']);
      deepStrictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath }), { due: 'unknown' });
      // The owner gives the old child up and sends A back to pending.
      rmSync(old.path);
      const m = await fx.readMacro();
      await fx.orch.setPlan({
        workflowPath: fx.macroPath, host: H,
        subtasks: m.plan.subtasks.map((s) => (s.id === 'A'
          ? { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'engineer_workflow_id')), status: 'pending' } : s)),
      });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).unknown, ['A'], 'not retired by the look alone');
      // A fresh child, started in the second of the replacement: it may have
      // been there before it, so it is refused, and the name stays.
      const fresh = await freshChild(fx, 'A', replaced.replaced_at);
      const expect = await expectOf(fresh.path);
      await rejects(() => reattach(fx, fresh, expect), notVouched(fresh));
      deepStrictEqual((await record(fx)).record.unknown, ['A']);
      // Started a second later, it lost nothing: bound, and the name retired.
      setStartedAt(fresh.path, new Date(Date.parse(replaced.replaced_at) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
      await reattach(fx, fresh, expect);
      strictEqual((await fx.subtask('A')).engineer_workflow_id, fresh.id);
      strictEqual((await record(fx)).record.unknown, undefined);
      ok(macroText(fx).includes('Subtask A is no longer named unknown in the record of rebindings'));
      strictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath }), null, 'its steps are not held');
      strictEqual((await terminal(fx, 'A', fresh, expect)).noted, true);
    });
    // The same through the terminal writeback (a missed first writeback): it
    // binds the fresh child and retires the name.
    await withRepo(async (fx) => {
      const old = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
      unopenedFile(old.path);
      await approve(fx);
      const replaced = (await record(fx)).record;
      deepStrictEqual(replaced.unknown, ['A']);
      rmSync(old.path);
      const m = await fx.readMacro();
      await fx.orch.setPlan({
        workflowPath: fx.macroPath, host: H,
        subtasks: m.plan.subtasks.map((s) => (s.id === 'A'
          ? { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'engineer_workflow_id')), status: 'pending' } : s)),
      });
      const fresh = await freshChild(fx, 'A', new Date(Date.parse(replaced.replaced_at) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
      strictEqual((await terminal(fx, 'A', fresh, await expectOf(fresh.path))).promotedToInProgress, true);
      strictEqual((await record(fx)).record.unknown, undefined);
    });
    // The same through a re-attach that changes no field (the fresh child
    // already recorded in progress): the retirement alone is written.
    await withRepo(async (fx) => {
      const old = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
      unopenedFile(old.path);
      await approve(fx);
      const replaced = (await record(fx)).record;
      deepStrictEqual(replaced.unknown, ['A']);
      rmSync(old.path);
      const fresh = await freshChild(fx, 'A', new Date(Date.parse(replaced.replaced_at) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
      const m = await fx.readMacro();
      await fx.orch.setPlan({
        workflowPath: fx.macroPath, host: H,
        subtasks: m.plan.subtasks.map((s) => (s.id === 'A' ? { ...s, engineer_workflow_id: fresh.id } : s)),
      });
      strictEqual((await fx.subtask('A')).status, 'in_progress');
      await reattach(fx, fresh, await expectOf(fresh.path));
      strictEqual((await record(fx)).record.unknown, undefined);
      ok(macroText(fx).includes('Subtask A is no longer named unknown in the record of rebindings'));
    });
  });

  it('after an unreadable record, an in-progress child read only from its archived copy, beside an active one the scan skips, keeps its subtask unknown', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{unreadable"'));
      const archivedCopy = child.path.replace(/\/workflows\/([^/]+)$/, '/archive/$1');
      mkdirSync(resolve(archivedCopy, '..'), { recursive: true });
      writeFileSync(archivedCopy, childText(child.path));
      unopenedFile(child.path);
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual([view.rows.map((r) => r.kind), view.unknown], [['unreadable'], ['A']], 'the child may still run, so it is not taken as archived');
      await approve(fx);
      deepStrictEqual((await record(fx)).record.unknown, ['A']);
    });
  });

  it('after an unreadable record, the replacement is timed at its write, not when the approval was called', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const good = childText(child.path);
      corruptRecord(fx);
      unopenedFile(child.path);
      // An approval whose time was taken an hour before it wrote (a call held
      // up before its locks): the child started in between lost what it was
      // told all the same.
      await approve(fx, { now: new Date(Date.now() - 3600 * 1000) });
      const rec = (await record(fx)).record;
      deepStrictEqual(rec.unknown, ['A']);
      writeFileSync(child.path, good);
      const startedAt = good.match(/^started_at: "?([^"\n]*)"?$/m)[1];
      ok(Date.parse(rec.replaced_at) >= Math.floor(Date.parse(startedAt) / 1000) * 1000, `${rec.replaced_at} is not before ${startedAt}`);
      await rejects(() => reattach(fx, child, expect), notVouched(child));
      // A write that names no child binds the recorded owner, and is refused alike.
      await rejects(() => fx.orch.updateSubtask({
        workflowPath: fx.macroPath, subtaskId: 'A', host: H, status: 'in_progress', expectDispatch: expect,
      }), notVouched(child));
      await rejects(() => terminal(fx, 'A', child, expect), notVouched(child));
    });
  });

  it('after an unreadable record, an archived child keeps what it was told, and its terminal writeback is bound by it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      corruptRecord(fx);
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
      await fx.commitAndArchive(child.path);
      await revise(fx, 'B', { topic: 'other B words' });
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await record(fx)).record.told[child.id]?.topic, 'do A', 'an approval after the archive keeps it');
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The r12 Refine-verify: the archived row's refusal, judged over the record
  // the approval writes, named the comparison's sentinel time as an approval.
  it('after an unreadable record, an archived child\'s refusal names the replacing approval, never a sentinel time', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await fx.commitAndArchive(child.path);
      corruptRecord(fx);
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      ok(/what .* was last told is not known: this approval replaced an unreadable record/.test(view.rows[0]?.refused ?? ''), JSON.stringify(view.rows));
      await approve(fx);
      ok(!macroText(fx).includes('9999-12-31'), 'no sentinel time in the audit');
    });
  });

  it('a record that names a subtask unknown, or was replaced, vouches for a child only by what it was told since', async () => {
    const fm = (rec) => ({ plan_rebindings: JSON.stringify(rec) });
    const base = {
      v: 1, approval: { id: 'a'.repeat(32), at: '2026-10-20T00:00:00Z', hash: 'b'.repeat(64) },
      rebindings: [], carried: [], pending: [], told: {},
    };
    const child = 'compose-20261020T000000Z-c1c1c1';
    const current = { profile: 'p', topic: 'do A' };
    const told = (over = {}) => ({ [child]: { subtask: 'A', profile: 'p', topic: 'do A', delivery_id: 'd-0123456789abcdef', at: '2026-10-21T00:00:00Z', ...over } });
    const early = () => '2026-10-19T00:00:00Z';
    const late = () => '2026-10-22T00:00:00Z';
    const verdict = (rec, startedAt = early) => vouchVerdict({ fm: rec === undefined ? {} : fm(rec), subtaskId: 'A', current, child, startedAt });
    // Nothing lost: no record, or one never replaced naming nothing unknown.
    deepStrictEqual(verdict(undefined), { ok: true, retire: false });
    deepStrictEqual(verdict(base), { ok: true, retire: false });
    // A record that cannot be read vouches for no one.
    const unreadable = vouchVerdict({ fm: { plan_rebindings: '{x' }, subtaskId: 'A', current, child, startedAt: early });
    ok(!unreadable.ok && /is unreadable/.test(unreadable.why), unreadable.why);
    for (const rec of [{ ...base, replaced_at: '2026-10-20T00:00:00Z' }, { ...base, unknown: ['A'] }, { ...base, unknown: ['A'], replaced_at: '2026-10-20T00:00:00Z' }]) {
      const where = JSON.stringify(Object.keys(rec));
      ok(!verdict(rec).ok, `${where}: no note since`);
      deepStrictEqual(verdict({ ...rec, told: told() }), { ok: true, retire: false }, `${where}: told these words`);
      ok(!verdict({ ...rec, told: told({ subtask: 'B' }) }).ok, `${where}: told for another subtask`);
      ok(!verdict({ ...rec, told: told({ topic: 'B words' }) }).ok, `${where}: told other words`);
      ok(!verdict({ ...rec, told: told({ profile: 'q' }) }).ok, `${where}: told another profile`);
    }
    // A child started after the replacement lost nothing; one started in its
    // second, or whose start is not known, may have been there before it.
    const replaced = { ...base, replaced_at: '2026-10-20T00:00:00Z' };
    deepStrictEqual(verdict(replaced, late), { ok: true, retire: false });
    deepStrictEqual(verdict({ ...replaced, unknown: ['A'] }, late), { ok: true, retire: true });
    deepStrictEqual(verdict({ ...replaced, unknown: ['B'] }, late), { ok: true, retire: false });
    ok(!verdict(replaced, () => '2026-10-20T00:00:00Z').ok);
    ok(!verdict(replaced, () => null).ok);
    // A note since that told it other words, or one still waiting to tell
    // it, is what a child started after the replacement answers to.
    const contrary = verdict({ ...replaced, told: told({ topic: 'B words' }) }, late);
    ok(!contrary.ok && /told it other words/.test(contrary.why), contrary.why);
    const pendingNote = { delivery_id: 'd-1123456789abcdef', child, subtask: 'A', from: { profile: 'p', topic: 'B words' }, to: current };
    ok(!verdict({ ...replaced, pending: [pendingNote] }, late).ok, 'a note still waiting');
    // Named unknown with no replacement recorded: no start excuses the child.
    ok(!verdict({ ...base, unknown: ['A'] }, late).ok);
    ok(verdict({ ...base, unknown: ['B'] }).ok, 'another subtask named unknown leaves this one known');
    // The refusal names the recovery: the pending restatement, or an approval.
    const waiting = verdict({ ...replaced, pending: [{ delivery_id: 'd-fedcba9876543210', child, subtask: 'A', from: current, to: current, restate: true }] });
    ok(/delivery d-fedcba9876543210\) is pending/.test(waiting.why), waiting.why);
    ok(/Approve the plan again \(\/orchestrator:approve\)/.test(verdict(replaced).why), verdict(replaced).why);
  });

  it('a subtask not in progress whose child was never told has no row and no note', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await toPending(fx);
      await revise(fx, 'A', { topic: 'B words' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows, []);
      await approve(fx, { engineerRoot: ENG });
      ok(!childText(child.path).includes('Owner instruction change'));
    });
    // The rule itself, for an idle child the approval reads: with nothing it
    // was told, its dispatch is no baseline for a note.
    const view = deriveRebindView({
      subtasks: [{ id: 'A', status: 'pending', branch: 'feat/a', verb: 'compose', profile: 'p', topic: 'B words' }],
      children: new Map([['A', {
        status: 'found', child: 'compose-20261020T000000Z-c1c1c1', owner: 'recorded', child_state: 'active', path: '/x', next_step: 'critique',
        dispatch: { macro: 'm', subtask: 'A', branch: 'feat/a', verb: 'compose', profile: 'p', topic: 'do A' },
      }]]),
      previous: { status: 'absent' },
    });
    deepStrictEqual([view.rows, view.deliveries], [[], []]);
  });

  it('a revision it cannot rebind keeps what the child was last told, so a later return to the dispatch is still told', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await revise(fx, 'A', { branch: 'feat/a2' });
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await record(fx)).record.told[child.id].topic, 'B words');
      await revise(fx, 'A', { branch: 'feat/a', topic: 'do A' });
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
    });
  });

  // The owner the macro records, replaced by one with no file left: the
  // approval then cannot read the child (owner-missing), as with a claim entry
  // it cannot read.
  const hideOwner = (fx, child) => writeFileSync(fx.macroPath, macroText(fx)
    .replace(`engineer_workflow_id: "${child.id}"`, 'engineer_workflow_id: "compose-20261020T000000Z-g0ne00"'));
  const showOwner = (fx, child) => writeFileSync(fx.macroPath, macroText(fx)
    .replace('engineer_workflow_id: "compose-20261020T000000Z-g0ne00"', `engineer_workflow_id: "${child.id}"`));

  it('an approval that cannot read the child keeps what it was told, so a later return to the dispatch is still told', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      hideOwner(fx, child);
      await revise(fx, 'B', { topic: 'an unrelated change' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.subtask, r.kind]), [['A', 'owner-missing']]);
      deepStrictEqual(view.untouched.told, [child.id]);
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await record(fx)).record.told[child.id].topic, 'B words');
      showOwner(fx, child);
      await revise(fx, 'A', { topic: 'do A' });
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
    });
  });

  it('an approval that finds the child ambiguous keeps its pending note under its id, never told twice', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      // No owner recorded and a second claimant: the child is ambiguous until
      // the owner settles it.
      writeFileSync(fx.macroPath, macroText(fx).replace(/^ {6}engineer_workflow_id: .*\n/m, ''));
      fx.git('switch', '-q', 'main');
      const s = await fx.subtask('A');
      const second = await fx.eng.createWorkflow({
        repoRoot: fx.work, verb: s.verb, host: H, profile: s.profile, originalRequest: 'x',
        gitBaseline: { branch: 'feat/a-second', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
        parentWorkflow: fx.macroId, originatingSubtask: 'A',
      });
      await revise(fx, 'B', { topic: 'an unrelated change' });
      await approve(fx, { engineerRoot: ENG });
      strictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows[0].kind, 'ambiguous');
      deepStrictEqual((await record(fx)).record.pending.map((x) => x.delivery_id), [p.delivery_id]);
      ok(macroText(fx).includes(`- A: delivery ${p.delivery_id} to ${child.id} stays pending as it was`));
      ok(!childText(child.path).includes('Owner instruction change'), 'not told while its child is ambiguous');
      rmSync(second.filePath);
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'delivered']]);
      strictEqual(childText(child.path).split('### Owner instruction change (').length, 2);
    });
  });

  it('a child whose claim cannot be read leaves its note waiting, and the approval written reports it, never fails', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^dispatched_topic: "do A"$/m, 'dispatched_topic: "do A'));
      await revise(fx, 'B', { topic: 'an unrelated change' });
      strictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows[0].kind, 'unreadable');
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'unreadable']]);
      strictEqual((await fx.readMacro()).plan_approval_status, 'approved');
      deepStrictEqual((await record(fx)).record.pending.map((x) => x.delivery_id), [p.delivery_id]);
      writeFileSync(child.path, good);
      const again = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(again.deliveries.map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'delivered']]);
    });
  });

  it('a child whose file the claim scan skips keeps its note, written or not, until the file is repaired', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      // The note written, then a crash before its acknowledgement; then the
      // child's frontmatter is left unopened.
      await writeNote(fx, child, p);
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^---\n/, '--x\n'));
      await revise(fx, 'B', { topic: 'an unrelated change' });
      await approve(fx);
      deepStrictEqual((await record(fx)).record.pending.map((x) => x.delivery_id), [p.delivery_id]);
      writeFileSync(child.path, good);
      await revise(fx, 'A', { topic: 'do A' });
      const r = await approve(fx, { engineerRoot: ENG });
      ok(macroText(fx).includes(`- delivery ${p.delivery_id} to ${child.id} (A) found in its notes: acknowledged`));
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered'], 'the return to the dispatch is told');
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
    });
  });

  // A record with nothing left in it is removed.
  const pendingNow = async (fx) => { const r = await record(fx); return r.status === 'absent' ? [] : r.record.pending; };

  it('a note for a child that is gone, or for a subtask no longer in progress, is not kept to hold a next dispatch back', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      strictEqual((await pendingNow(fx)).length, 1);
      hideOwner(fx, child);
      await revise(fx, 'B', { topic: 'an unrelated change' });
      await approve(fx);
      deepStrictEqual(await pendingNow(fx), []);
    });
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      strictEqual((await pendingNow(fx)).length, 1);
      await fx.commitAndArchive(child.path);
      // The owner sends the subtask back to be dispatched afresh.
      writeFileSync(fx.macroPath, macroText(fx).replace(/^ {6}engineer_workflow_id: .*\n/m, '').replace(/^( +status: )"?in_progress"?$/m, '$1"pending"'));
      strictEqual((await fx.subtask('A')).status, 'pending');
      await revise(fx, 'A', { branch: 'feat/a-again' });
      await approve(fx);
      deepStrictEqual(await pendingNow(fx), []);
    });
  });

  it('B pending, then C approved: the undelivered note is superseded, and C is told from the last words told', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const b = (await record(fx)).record.pending[0];
      await revise(fx, 'A', { topic: 'C words' });
      await approve(fx);
      const [c] = (await record(fx)).record.pending;
      ok(c.delivery_id !== b.delivery_id);
      deepStrictEqual([c.from.topic, c.to.topic], ['do A', 'C words']);
      ok(macroText(fx).includes(`told the change of topic by delivery ${c.delivery_id}`));
      // Approving the same plan again keeps the delivery's id.
      await approve(fx);
      strictEqual((await record(fx)).record.pending[0].delivery_id, c.delivery_id);
      ok(!childText(child.path).includes('Owner instruction change'));
    });
  });

  it('a note already in the child (a crash before its acknowledgement) is acknowledged, never written twice', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      // The next approval finds it before it derives anything: told, not told again.
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.pendingDeliveries, 0);
      ok(macroText(fx).includes(`- delivery ${p.delivery_id} to ${child.id} (A) found in its notes: acknowledged`));
      deepStrictEqual((await record(fx)).record.pending, []);
      strictEqual(childText(child.path).split(`(${p.delivery_id})`).length, 2);
      strictEqual((await record(fx)).record.told[child.id].delivery_id, p.delivery_id);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('a heading over other words is not the note: no approval or retry acknowledges it, and the words are told', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      // An append that wrote the heading but not the words (the read-back refused it).
      await writeNote(fx, child, p, { words: 'The owner approved a change.\n\n**topic** is something else' });
      await revise(fx, 'B', { topic: 'an unrelated change' });
      await approve(fx);
      ok(!macroText(fx).includes('found in its notes: acknowledged'));
      deepStrictEqual((await record(fx)).record.pending.map((x) => x.delivery_id), [p.delivery_id]);
      await rejects(() => terminal(fx, 'A', child, expect), /has not been told the change yet/);
      const out = JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG]));
      deepStrictEqual(out.deliveries.map((d) => d.status), ['delivered']);
      ok(childText(child.path).includes('```text\nB words\n```'));
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('a note written before a concurrent plan-set is still acknowledged by its id; an unwritten one waits', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await revise(fx, 'B', { topic: 'a plan-set meanwhile' });
      let out = JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG]));
      deepStrictEqual(out.deliveries.map((d) => d.status), ['stale']);
      ok(!childText(child.path).includes('Owner instruction change'), 'unapproved words are never told');
      await writeNote(fx, child, p);
      out = JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG]));
      deepStrictEqual(out.deliveries.map((d) => d.status), ['acknowledged']);
      const rec = (await record(fx)).record;
      deepStrictEqual(rec.pending, []);
      strictEqual(rec.told[child.id].delivery_id, p.delivery_id);
    });
  });

  it('a child archived with its note pending is told nothing; approving again shows it archived and binds it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      await fx.commitAndArchive(child.path);
      const out = JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG]));
      deepStrictEqual(out.deliveries.map((d) => d.status), ['archived']);
      await rejects(() => terminal(fx, 'A', child, expect), /has not been told the change yet/);
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.pendingDeliveries, 0);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('a delivered change stays bound and told across an approval of another subtask; the child\'s next step is its own', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, { autopilot: false });
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const step = (await readChild(child.path)).frontmatter;
      deepStrictEqual([step.next_step_kind, step.next_step_verb], ['verb', 'critique']);
      await revise(fx, 'B', { topic: 'B changed' });
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.pendingDeliveries, 0);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('a completed subtask\'s rebinding is carried by later approvals, so its records still compare', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await complete(fx, 'A', child, expect);
      await revise(fx, 'B', { topic: 'B changed' });
      await approve(fx);
      const rec = (await record(fx)).record;
      deepStrictEqual(rec.carried.map((e) => [e.subtask, e.child]), [['A', child.id]]);
      ok(macroText(fx).includes(`- A (completed): the rebinding of ${child.id} is kept as recorded`));
      await fx.orch.updateSubtask({ workflowPath: fx.macroPath, host: H, subtaskId: 'A', prUrl: 'https://example.invalid/pull/9', engineerWorkflowId: child.id, expectDispatch: expect });
      // A correction of the completed subtask's words leaves the carried rebinding behind.
      const m = await fx.readMacro();
      await fx.orch.setPlan({ workflowPath: fx.macroPath, host: H, correct: true, reason: 'test', subtasks: m.plan.subtasks.map((x) => (x.id === 'A' ? { ...x, topic: 'corrected words' } : x)) });
      await approve(fx);
      await rejects(() => fx.orch.updateSubtask({ workflowPath: fx.macroPath, host: H, subtaskId: 'A', prUrl: 'https://example.invalid/pull/9', engineerWorkflowId: child.id, expectDispatch: expect }),
        /rebound compose-\S+ to other words than the subtask's now/);
    });
  });

  it('with no owner recorded (a missed writeback), the sole claimant is rebound, and its terminal note binds it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      writeFileSync(fx.macroPath, macroText(fx).replace(/^ {6}engineer_workflow_id: .*\n/m, ''));
      strictEqual((await fx.subtask('A')).engineer_workflow_id, undefined);
      await revise(fx, 'A', { topic: 'B words' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.owner]), [['rebind', 'sole-claimant']]);
      await approve(fx, { engineerRoot: ENG });
      ok(macroText(fx).includes(`${child.id} (sole claimant, no owner recorded)`));
      const r = await terminal(fx, 'A', child, expect);
      strictEqual(r.boundOwner, true);
    });
  });

  it('several claimants and no owner: none is rebound, and the view says how to recover', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      writeFileSync(fx.macroPath, macroText(fx).replace(/^ {6}engineer_workflow_id: .*\n/m, ''));
      fx.git('switch', '-q', 'main');
      const s = await fx.subtask('A');
      await fx.eng.createWorkflow({
        repoRoot: fx.work, verb: s.verb, host: H, profile: s.profile, originalRequest: 'x',
        gitBaseline: { branch: 'feat/a-second', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
        parentWorkflow: fx.macroId, originatingSubtask: 'A',
      });
      await revise(fx, 'A', { topic: 'B words' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      strictEqual(view.rows[0].kind, 'ambiguous');
      ok(/revise the plan back, record the owner/.test(view.rows[0].detail));
      await approve(fx);
      strictEqual((await record(fx)).status, 'absent');
    });
  });
});

// ---------------------------------------------------------------------------
// The told check runs at every write that binds a child, whatever the dispatch
// comparison found (refine-verify-20261022T115936Z-f47a54, the owner's ruling
// of 2026-10-22): a child dispatched under "do A" and told "B words" is not
// bound under "do A" again until a note tells it so, though its dispatch
// matches and the record was never replaced.
describe('ADR-0068 Decision 8, item 4 — the told check at every binding write', () => {
  // X dispatched under "do A", told "B words", A revised back to "do A" and
  // approved with the B-to-A note left pending (no engineer to write it).
  async function toldThenReturned(fx, { pending = false } = {}) {
    const child = await dispatch(fx, 'A');
    const expect = await expectOf(child.path);
    await revise(fx, 'A', { topic: 'B words' });
    await approve(fx, { engineerRoot: ENG });
    await revise(fx, 'A', pending ? { topic: 'do A', status: 'pending' } : { topic: 'do A' });
    await approve(fx);
    const rec = (await record(fx)).record;
    deepStrictEqual([rec.told[child.id].topic, rec.pending.map((p) => `${p.from.topic}->${p.to.topic}`), rec.replaced_at, rec.unknown],
      ['B words', ['B words->do A'], undefined, undefined], 'a readable record, never replaced');
    return { child, expect };
  }
  const notTold = (child) => new RegExp(`${child.id} is not bound to subtask "A": ${child.id} has not been told the subtask's words yet: ` +
    'a note to it \\(delivery d-[0-9a-f]{16}\\) is pending; a run delivers it at the child\'s next boundary, or state\\.mjs rebind-deliver does now');
  const toldOther = (child) => new RegExp(`${child.id} is not bound to subtask "A": ${child.id} was last told other words for subtask A ` +
    '\\(delivery d-[0-9a-f]{16}\\) than the subtask\'s now');

  it('a child in progress, its dispatch matching, is refused at the terminal writeback and at done until the note is delivered', async () => {
    await withRepo(async (fx) => {
      const { child, expect } = await toldThenReturned(fx);
      const before = macroText(fx);
      await rejects(() => terminal(fx, 'A', child, expect), notTold(child));
      await rejects(() => complete(fx, 'A', child, expect), notTold(child));
      // Completion provenance alone, with no status, is refused alike.
      await rejects(() => fx.orch.updateSubtask({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: child.id, commit: 'def5678', expectDispatch: expect,
      }), notTold(child));
      strictEqual(macroText(fx), before, 'the refused writes wrote nothing');
      const out = await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER });
      deepStrictEqual(out.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
      strictEqual((await complete(fx, 'A', child, expect)).updatedSubtask.status, 'completed');
    });
  });

  it('a child whose subtask went back to pending, its dispatch matching, is refused at the re-attach and at done until the note is delivered', async () => {
    await withRepo(async (fx) => {
      const { child, expect } = await toldThenReturned(fx, { pending: true });
      await rejects(() => reattach(fx, child, expect), notTold(child));
      await rejects(() => complete(fx, 'A', child, expect), notTold(child));
      strictEqual((await fx.subtask('A')).status, 'pending', 'the refused writes wrote nothing');
      await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER });
      await reattach(fx, child, expect);
      strictEqual((await fx.subtask('A')).status, 'in_progress');
    });
  });

  it('a child last told other words, with no note pending, is refused until the plan says them or an approval tells it the subtask\'s', async () => {
    // The plan revised back to the dispatch and not yet approved: the record
    // still holds what the child was last told.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await revise(fx, 'A', { topic: 'do A' });
      await rejects(() => terminal(fx, 'A', child, expect), toldOther(child));
      await rejects(() => terminal(fx, 'A', child, expect), /approve the plan as it stands \(\/orchestrator:approve\)/);
      // Revised back to the words it was told: the approval's rebinding binds it.
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
    // Or approved as it stands, which tells the child.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await revise(fx, 'A', { topic: 'do A' });
      await rejects(() => complete(fx, 'A', child, expect), toldOther(child));
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await complete(fx, 'A', child, expect)).updatedSubtask.status, 'completed');
    });
  });

  it('an archived child last told other words is refused at done; the told waiver with a reason completes it, and the macro records it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await fx.commitAndArchive(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await record(fx)).record.told[child.id].topic, 'B words', 'no note reaches an archived child');
      const before = macroText(fx);
      await rejects(() => complete(fx, 'A', child, expect), (err) => toldOther(child).test(err.message)
        && err.message.includes(`${child.id} is archived, so no note reaches it: /orchestrator:done --waive-dispatch with a reason`));
      const waive = (over = {}) => fx.orch.updateSubtask({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'completed', engineerWorkflowId: child.id,
        commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', expectDispatch: expect, waiveTold: true, reason: 'finished under B', ...over,
      });
      await rejects(() => waive({ reason: undefined }), /--waive-told requires a non-empty reason/);
      await rejects(() => waive({ waiveDispatch: true, expectDispatch: undefined }), /pass --waive-dispatch or --waive-told, not both/);
      await rejects(() => waive({ status: 'in_progress', commit: undefined, closedAt: undefined }), /--waive-told applies only to a completion/);
      strictEqual(macroText(fx), before, 'the refused writes wrote nothing');
      strictEqual((await waive()).updatedSubtask.status, 'completed');
      ok(macroText(fx).includes(`Told check waived (--waive-dispatch): ${child.id} is not bound to subtask "A": ${child.id} was last told other words`), macroText(fx));
      ok(macroText(fx).includes('Reason: finished under B'));
      // On a subtask already completed, the waiver binds nothing.
      await rejects(() => waive({ correct: true }), /--waive-told waives nothing: subtask "A" is already completed/);
    });
  });

  // The fourth critique's MAJOR 1 (review-20261023T140712Z-8cb614): an
  // approval that selects another owner of the subtask dropped what the first
  // child was last told, so switching back accepted it under "do A".
  it('an owner switch keeps what the first child was last told: switched back, it is refused, and the told waiver completes it', async () => {
    await withRepo(async (fx) => {
      const x = await dispatch(fx, 'A');
      const expectX = await expectOf(x.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await fx.commitAndArchive(x.path);
      await revise(fx, 'A', { topic: 'do A' });
      const y = await freshChild(fx, 'A', new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
      await revise(fx, 'A', { engineer_workflow_id: y.id });
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await record(fx)).record.told[x.id]?.topic, 'B words', 'a row deciding Y keeps what X was told');
      await revise(fx, 'A', { engineer_workflow_id: x.id });
      await fx.commitAndArchive(y.path, { file: 'other.txt' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.child, r.kind, r.child_state]), [[x.id, 'matches', 'archived']]);
      ok(/was last told other words for subtask A/.test(view.rows[0].refused ?? ''), JSON.stringify(view.rows));
      await approve(fx, { engineerRoot: ENG });
      await rejects(() => terminal(fx, 'A', x, expectX), (err) => toldOther(x).test(err.message));
      await rejects(() => complete(fx, 'A', x, expectX), (err) => toldOther(x).test(err.message));
      const done = await complete(fx, 'A', x, expectX, { waiveTold: true, reason: 'finished under B' });
      strictEqual(done.updatedSubtask.status, 'completed');
    });
  });

  // The fourth critique's MAJOR 2: an archived child the told check refuses
  // was shown and audited "rebound", and, revised back to its dispatch, was
  // not shown at all (item 2: the approval shows the refusal a row will meet).
  it('an archived child last told other words is shown refused and never audited rebound, rebound or matching its dispatch', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'W1' });
      await approve(fx, { engineerRoot: ENG });
      await fx.commitAndArchive(child.path);
      await revise(fx, 'A', { topic: 'W2' });
      const rebound = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(rebound.rows.map((r) => [r.kind, r.child_state, r.delivery]), [['rebind', 'archived', null]]);
      ok(/was last told other words for subtask A .*is archived, so no note reaches it/.test(rebound.rows[0].refused ?? ''), JSON.stringify(rebound.rows));
      await approve(fx, { engineerRoot: ENG });
      const audit = (text) => text.slice(text.lastIndexOf('### Plan approved at'));
      ok(audit(macroText(fx)).includes(`- A: ${child.id} (archived (committed, waiting to land)): refused at every write that binds it: ${child.id} was last told other words`), audit(macroText(fx)));
      ok(!audit(macroText(fx)).includes('rebound from its dispatch'), audit(macroText(fx)));
      deepStrictEqual((await record(fx)).record.rebindings.map((e) => e.child), [child.id], 'the words approved are kept for the waiver');
      await rejects(() => complete(fx, 'A', child, expect), (err) => toldOther(child).test(err.message));
      // Revised back to the words it was dispatched for: still refused, and shown.
      await revise(fx, 'A', { topic: 'do A' });
      const back = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(back.rows.map((r) => [r.kind, r.child_state]), [['matches', 'archived']]);
      ok(/was last told other words for subtask A/.test(back.rows[0].refused ?? ''), JSON.stringify(back.rows));
      await approve(fx, { engineerRoot: ENG });
      ok(audit(macroText(fx)).includes('refused at every write that binds it'), audit(macroText(fx)));
      await rejects(() => complete(fx, 'A', child, expect), (err) => toldOther(child).test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'finished under W1' })).updatedSubtask.status, 'completed');
    });
  });

  // The fourth critique's MAJOR 3: a note found in an archived copy of the
  // child acknowledged a delivery its active copy never received.
  // Under the owner's ruling D, two files bearing the child refuse it outright:
  // the owner removes the extra copy first, and the delivery then writes the
  // note to the active copy.
  it('a note found only in an archived copy is not the active copy\'s: the writes refuse while both are left, and the delivery writes it there once the archive is removed', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      writeFileSync(child.path, before);
      deepStrictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id }), { due: 'pending' });
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      const deliverNow = () => JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG])).deliveries;
      deepStrictEqual(deliverNow().map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'copies']], 'not acknowledged from the archive');
      rmSync(archived);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => notTold(child).test(err.message));
      deepStrictEqual(deliverNow().map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'delivered']]);
      ok(childText(child.path).includes(`Owner instruction change (${p.delivery_id})`), 'the active copy holds the note');
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The r12 Refine-verify (refine-verify-20261024T032828Z-f5ba2a): with the
  // fix above, a child archived in two copies, only one holding its note, was
  // read as never told, so a revision back to its dispatch dropped the note
  // and the record, and both writes accepted it under "do A".
  // Under the owner's ruling D the two archives refuse the child outright, and
  // the note one of them holds is kept told, contested.
  it('a child archived in two copies, one holding its note, is told, contested: a revision back to its dispatch is refused, and the told waiver completes it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      const legacy = join(fx.work, '.claude', 'agentic-engineer', 'archive', `${child.id}.md`);
      mkdirSync(join(legacy, '..'), { recursive: true });
      writeFileSync(legacy, before);
      rmSync(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx, { engineerRoot: ENG });
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.told[child.id]?.topic, rec.told[child.id]?.delivery_id, rec.told[child.id]?.contested, rec.pending],
        ['B words', p.delivery_id, true, []], 'the copy that holds the note is the one its work may answer to');
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      // The owner's repair leaves the copy without the note: the record kept
      // still refuses the dispatch's words.
      rmSync(archived);
      await rejects(() => complete(fx, 'A', child, expect), (err) => contested(child).test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'finished under B' })).updatedSubtask.status, 'completed');
    });
  });

  // The r12 Refine-verify: an active copy the claim scan skips (its
  // frontmatter broken) left only the archived copy, whose note acknowledged a
  // delivery the active copy, once repaired, never received.
  // Under the owner's ruling D the two files refuse the child, repaired or not,
  // until the owner removes the archive.
  it('an active copy the claim scan skips holds no note: the delivery waits, and is written there once the copy is repaired and the archive removed', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      writeFileSync(child.path, before.replace(/^---\n/, '--x\n'));
      const deliver = () => JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG])).deliveries;
      deepStrictEqual(deliver().map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'copies']]);
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.told[child.id].topic, rec.pending.map((q) => q.delivery_id)], ['B words', [p.delivery_id]], 'not acknowledged');
      writeFileSync(child.path, before);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      rmSync(archived);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => notTold(child).test(err.message));
      deepStrictEqual(deliver().map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'delivered']]);
      ok(childText(child.path).includes(`Owner instruction change (${p.delivery_id})`), 'the repaired active copy holds the note');
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The r13 Refine-verify (refine-verify-20261024T074603Z-495d66): beside an
  // unparsed active copy, the approval took the readable active copy as the
  // child, derived no note, and dropped the pending one and what it was told,
  // so once the duplicate was gone both writes accepted a child whose latest
  // note says "B words".
  it('an unparsed active copy beside a readable one makes the child unreadable to the approval: its note is kept, and both writes refuse', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const duplicate = join(fx.work, '.claude', 'agentic-engineer', 'workflows', `${child.id}.md`);
      mkdirSync(join(duplicate, '..'), { recursive: true });
      writeFileSync(duplicate, before.replace(/^---\n/, '--x\n'));
      await revise(fx, 'A', { topic: 'do A' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.subtask, r.kind, r.child]), [['A', 'unreadable', child.id]]);
      await approve(fx, { engineerRoot: ENG });
      deepStrictEqual((await record(fx)).record.pending.map((q) => q.delivery_id), [p.delivery_id], 'the note is kept');
      rmSync(duplicate);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => notTold(child).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => notTold(child).test(err.message));
    });
  });

  // The r13 Refine-verify: a child archived in two copies that disagree (one
  // holds the return to "do A", one was last told "B words") was acknowledged
  // as told "do A", so both writes accepted it under "do A", and a copy last
  // told "B words" restored as active ran under it.
  // With `unparsed`, the copy last told "B words" is one the claim scan skips.
  // Under the owner's ruling D, the two archives refuse the child outright:
  // its note is neither acknowledged nor judged copy by copy.
  const contestedCopies = async (fx, { unparsed = false } = {}) => {
    const child = await dispatch(fx, 'A');
    const expect = await expectOf(child.path);
    await revise(fx, 'A', { topic: 'B words' });
    await approve(fx, { engineerRoot: ENG });
    const toldB = childText(child.path);
    await revise(fx, 'A', { topic: 'do A' });
    await approve(fx);
    const [p] = (await record(fx)).record.pending;
    await writeNote(fx, child, p);
    const archived = child.path.replace('/workflows/', '/archive/');
    mkdirSync(join(archived, '..'), { recursive: true });
    writeFileSync(archived, childText(child.path));
    const legacy = join(fx.work, '.claude', 'agentic-engineer', 'archive', `${child.id}.md`);
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, unparsed ? toldB.replace(/^---\n/, '--x\n') : toldB);
    rmSync(child.path);
    deepStrictEqual(deliver(fx).map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'copies']]);
    deepStrictEqual((await record(fx)).record.pending.map((q) => q.delivery_id), [p.delivery_id], 'not acknowledged');
    return { child, expect, toldB, archived, legacy, p };
  };
  const deliver = (fx) => JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG])).deliveries;
  const contested = (child) => new RegExp(`${toldOther(child).source}, or its copies disagree on what it was told`);

  it('a child archived in copies that disagree is refused outright: both writes and the approval\'s row refuse it, and the told waiver completes it', async () => {
    await withRepo(async (fx) => {
      const { child, expect } = await contestedCopies(fx);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await revise(fx, 'A', { topic: 'B words' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state]), [['rebind', 'archived']]);
      ok(copiesRefused(child, 2, { archived: true }).test(`${child.id} is not bound to subtask "A": ${view.rows[0].refused}`), JSON.stringify(view.rows));
      await approve(fx, { engineerRoot: ENG });
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'its copies disagree' })).updatedSubtask.status, 'completed');
    });
  });

  it('a child archived in copies that disagree, restored as active, is refused while the copies are left; once the owner removes them, its pending note is delivered and binds it', async () => {
    await withRepo(async (fx) => {
      const { child, expect, toldB, archived, legacy, p } = await contestedCopies(fx);
      writeFileSync(child.path, toldB);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 3).test(err.message));
      rmSync(archived);
      rmSync(legacy);
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.delivery?.delivery_id]), [['matches', 'active', p.delivery_id]]);
      const approval = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(approval.deliveries.map((d) => d.status), ['delivered']);
      const told = (await record(fx)).record.told[child.id];
      deepStrictEqual([told.topic, told.contested], ['do A', undefined]);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('a contested restating note leaves its subtask unknown; a delivered one retires it', () => {
    const p = { child: 'c1', subtask: 'A', from: { profile: 'p', topic: 't' }, to: { profile: 'p', topic: 't' }, delivery_id: 'd-0123456789abcdef', restate: true };
    const fresh = () => ({ told: {}, unknown: ['A', 'B'] });
    const disputed = acknowledgeInRecord(fresh(), p, '2026-10-24T00:00:00Z', { contested: true });
    deepStrictEqual([disputed.told.c1.contested, disputed.unknown], [true, ['A', 'B']]);
    const delivered = acknowledgeInRecord(fresh(), p, '2026-10-24T00:00:00Z');
    deepStrictEqual([delivered.told.c1.contested, delivered.unknown], [undefined, ['B']]);
  });

  // The r14 Refine-verify (refine-verify-20261024T095850Z-f369aa): an archived
  // copy the claim scan skips was left out of "every copy", so a child archived
  // in a copy holding the return to "do A" and an unparsed one last told
  // "B words" was acknowledged told "do A", and once that copy was repaired
  // every binding write accepted it. Under the owner's ruling D it is a second
  // file, repaired or not.
  it('an archived copy the claim scan skips is a copy: both writes refuse while it is left, repaired or not, and the told waiver completes it', async () => {
    await withRepo(async (fx) => {
      const { child, expect, toldB, legacy } = await contestedCopies(fx, { unparsed: true });
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      writeFileSync(legacy, toldB);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'its copies disagree' })).updatedSubtask.status, 'completed');
    });
  });

  // The r14 Refine-verify: the record names the child, not a copy. A
  // restatement delivered to one copy cleared the mark; that copy was archived
  // and the stale copy last told "B words" moved to the active home, and every
  // binding write, and the run boundary, accepted it with no note. Under the
  // owner's ruling D the two files refuse it outright; once the owner removes
  // the archive, the stale copy alone is refused until the approval restates
  // the words to it.
  it('a copy swapped in after a delivery does not hold its note: every binding write refuses, the approval restates the words to it, and it binds once that note is delivered', async () => {
    await withRepo(async (fx) => {
      const { child, expect, toldB, archived, legacy } = await contestedCopies(fx);
      rmSync(legacy);
      renameSync(archived, child.path);
      deepStrictEqual(deliver(fx).map((d) => d.status), ['acknowledged'], 'one copy left, holding the note');
      const told = (await record(fx)).record.told[child.id];
      deepStrictEqual([told.topic, told.contested], ['do A', undefined]);
      strictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id }), null, 'control: the copy told is stepped');
      renameSync(child.path, archived);
      writeFileSync(child.path, toldB);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      await rejects(() => reattach(fx, child, expect), (err) => copiesRefused(child, 2).test(err.message));
      ok(copiesRefused(child, 2).test(`${child.id} is not bound to subtask "A": ${rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id })?.why}.`),
        'the run boundary refuses it');
      rmSync(archived);
      const missing = new RegExp(`${child.id} is not bound to subtask "A": a copy of ${child.id} does not hold the note that told it ` +
        `the subtask's words \\(delivery ${told.delivery_id}\\)`);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => missing.test(err.message));
      await rejects(() => reattach(fx, child, expect), (err) => missing.test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => missing.test(err.message));
      strictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id })?.due, 'refused', 'the run boundary refuses it');
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.delivery?.restate]), [['matches', 'active', true]]);
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['delivered']);
      ok(/restated in full/.test(childText(child.path).slice(childText(child.path).lastIndexOf('### Owner instruction change ('))));
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The r14 Refine-verify: with the subtask returned to pending, the approval
  // read no child, so it dropped a note the readable active copy held beside
  // an unparsed duplicate, with the record; once the duplicate was gone, every
  // binding write accepted a child whose latest note says "B words".
  it('a note dropped with its subtask back to pending, a copy holding it, is recorded told, contested: the re-attach refuses until a restatement is delivered', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const duplicate = join(fx.work, '.claude', 'agentic-engineer', 'workflows', `${child.id}.md`);
      mkdirSync(join(duplicate, '..'), { recursive: true });
      writeFileSync(duplicate, before.replace(/^---\n/, '--x\n'));
      await revise(fx, 'A', { topic: 'do A', status: 'pending' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).untouched.contested, [p.delivery_id], 'the digest binds it');
      await approve(fx, { engineerRoot: ENG });
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.told[child.id]?.topic, rec.told[child.id]?.delivery_id, rec.told[child.id]?.contested, rec.pending],
        ['B words', p.delivery_id, true, []], 'told the dropped note, contested');
      ok(macroText(fx).includes(`delivery ${p.delivery_id} to ${child.id} is dropped, but a copy of ${child.id} holds it`), 'audited');
      rmSync(duplicate);
      await rejects(() => reattach(fx, child, expect), (err) => contested(child).test(err.message));
      await rejects(() => terminal(fx, 'A', child, expect), (err) => contested(child).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => contested(child).test(err.message));
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.delivery?.restate]), [['told', 'active', true]]);
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await reattach(fx, child, expect)).updatedSubtask.status, 'in_progress');
    });
  });

  // The r15 Refine-verify (refine-verify-20261024T143445Z-02edc0), F1: a "B
  // words" note held only by an archived copy, beside an active copy restored
  // from before it, was dropped by the row that decided the child; once the B
  // copy was restored as active, every binding write accepted it.
  it('a pending note only an archived copy holds, beside a found active copy, is restated to it; the B copy swapped in is refused, restated and bound', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      writeFileSync(child.path, before);
      await revise(fx, 'A', { topic: 'do A' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.delivery?.restate]), [['matches', 'active', true]]);
      // Two files bear the child (the owner's ruling D): the restatement waits
      // until the owner removes the archive, then reaches the found copy.
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['copies']);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      const toldB = childText(archived);
      rmSync(archived);
      deepStrictEqual(deliver(fx).map((d) => d.status), ['delivered']);
      const told = (await record(fx)).record.told[child.id];
      writeFileSync(child.path, toldB);
      const missing = new RegExp(`${child.id} is not bound to subtask "A": a copy of ${child.id} does not hold the note that told it ` +
        `the subtask's words \\(delivery ${told.delivery_id}\\)`);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => missing.test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => missing.test(err.message));
      strictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id })?.due, 'refused', 'the run boundary refuses it');
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows.map((r) => [r.kind, r.child_state, r.delivery?.restate]),
        [['matches', 'active', true]]);
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // F1, the row deciding the child sends it no note: a "B words" note held only
  // by an archived copy was dropped while the subtask's branch was revised (no
  // approval rebinds a branch), so once the branch was revised back and the B
  // copy restored as active, every binding write accepted it.
  it('a pending note only an archived copy holds is kept, contested, by a row that cannot rebind: revised back, the B copy is refused until restated', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      const { branch } = await fx.subtask('A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      writeFileSync(child.path, before);
      await revise(fx, 'A', { topic: 'do A', branch: `${branch}-moved` });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual([view.rows.map((r) => [r.kind, r.delivery]), view.untouched.contested], [[['not-rebindable', null]], [p.delivery_id]]);
      await approve(fx, { engineerRoot: ENG });
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.told[child.id]?.topic, rec.told[child.id]?.contested, rec.pending], ['B words', true, []], 'told the dropped note, contested');
      await revise(fx, 'A', { branch });
      rmSync(child.path);
      renameSync(archived, child.path);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => contested(child).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => contested(child).test(err.message));
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The r15 Refine-verify, F2: a duplicate whose workflow_id never closes its
  // quote makes the claim scan throw, and the throw was read as "never told":
  // with the subtask back to pending, the approval dropped the note and the
  // record, and the re-attach accepted a child whose latest note says "B words".
  it('a claim scan that throws is partial evidence: the dropped note is recorded told, contested, and the re-attach refuses until a restatement is delivered', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const duplicate = join(fx.work, '.claude', 'agentic-engineer', 'workflows', `${child.id}.md`);
      mkdirSync(join(duplicate, '..'), { recursive: true });
      writeFileSync(duplicate, before.replace(/^workflow_id: .*$/m, 'workflow_id: "broken'));
      await revise(fx, 'A', { topic: 'do A', status: 'pending' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).untouched.contested, [p.delivery_id]);
      await approve(fx, { engineerRoot: ENG });
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.told[child.id]?.topic, rec.told[child.id]?.contested, rec.pending], ['B words', true, []], 'told the dropped note, contested');
      rmSync(duplicate);
      await rejects(() => reattach(fx, child, expect), (err) => contested(child).test(err.message));
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows.map((r) => [r.kind, r.child_state, r.delivery?.restate]),
        [['told', 'active', true]]);
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await reattach(fx, child, expect)).updatedSubtask.status, 'in_progress');
    });
  });

  // The r15 Refine-verify, F3: an unparsed archive under the archiver's
  // collision-suffixed name escaped the unparsed probe, which looked only at
  // `<id>.md`, so the delivery was acknowledged plain, told "do A".
  // Under the owner's ruling D it is a second file: the note is not
  // acknowledged, and the writes refuse it outright, repaired or not.
  it('an unparsed archive under the archiver\'s collision suffix is a copy: the note is not acknowledged, the writes refuse it, and the told waiver completes it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const toldB = childText(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const canonical = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(canonical, '..'), { recursive: true });
      writeFileSync(canonical, childText(child.path));
      writeFileSync(child.path, toldB);
      const { to } = await fx.eng.archiveWorkflow({ workflowPath: child.path, host: H, repoRoot: fx.work });
      ok(/-\d{8}T\d{6}Z-[0-9a-f]{6}\.md$/.test(to), `the archiver suffixed the colliding copy: ${to}`);
      unopenedFile(to);
      deepStrictEqual(deliver(fx).map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'copies']]);
      deepStrictEqual((await record(fx)).record.pending.map((q) => q.delivery_id), [p.delivery_id], 'not acknowledged');
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      writeFileSync(to, toldB);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'its copies disagree' })).updatedSubtask.status, 'completed');
    });
  });

  // The r15 Refine-verify, F4: an active copy last told "B words" that claims
  // another subtask was read as another workflow, so the archived claimant,
  // holding the note to "do A", vouched for it at every binding write.
  it('a file of the child that claims another subtask is a copy: the writes refuse while it is left, and bind once it is removed', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const toldB = childText(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx, { engineerRoot: ENG });
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      writeFileSync(child.path, toldB.replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'));
      // Beside the archived claimant it is a second file (the owner's ruling D).
      const conflict = copiesRefused(child, 2);
      await rejects(() => terminal(fx, 'A', child, expect), (err) => conflict.test(err.message));
      await rejects(() => reattach(fx, child, expect), (err) => conflict.test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => conflict.test(err.message));
      strictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id })?.due, 'refused', 'the run boundary refuses it');
      rmSync(child.path);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // F4, at the acknowledgement: a pending note held by the archived claimant
  // is not acknowledged while a file of the child claims another subtask.
  it('a pending note is not acknowledged while a file of the child claims another subtask', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      writeFileSync(child.path, before.replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'));
      deliver(fx);
      deepStrictEqual((await record(fx)).record.pending.map((q) => q.delivery_id), [p.delivery_id], 'not acknowledged');
      rmSync(child.path);
      deepStrictEqual(deliver(fx).map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'acknowledged']], 'control: acknowledged once it is removed');
    });
  });

  // The r15 Refine-verify, F5: an archived child refused only by the copy check
  // (its copy does not hold the note its `told` entry names) was audited
  // rebound, and its row absent from the approval.
  it('an archived child whose copy does not hold its told note is shown refused and audited refused', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'C words' });
      await approve(fx, { engineerRoot: ENG });
      const toldC = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, toldC);
      rmSync(child.path);
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.child_state, r.delivery]), [['archived', null]]);
      ok(/a copy of .* does not hold the note that told it the subtask's words, or cannot be read.* is archived, so no note reaches it/.test(view.rows[0].refused ?? ''),
        JSON.stringify(view.rows));
      await approve(fx, { engineerRoot: ENG });
      const audit = macroText(fx).slice(macroText(fx).lastIndexOf('### Plan approved at'));
      ok(audit.includes(`- A: ${child.id} (archived (committed, waiting to land)): refused at every write that binds it: a copy of ${child.id} does not hold`), audit);
      ok(!audit.includes('rebound from its dispatch'), audit);
      await rejects(() => complete(fx, 'A', child, expect), (err) => /does not hold the note that told it/.test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'its copy lost the note' })).updatedSubtask.status, 'completed');
    });
  });

  // The r15 Refine-verify's SUGGESTION: a note the approval keeps, contested,
  // changes nothing the approval shows but what it carries untouched, so the
  // digest must bind `untouched.contested`.
  it('the digest binds a dropped note recorded contested', () => {
    const p = { child: 'c1', subtask: 'A', from: { profile: 'p', topic: 'do A' }, to: { profile: 'p', topic: 'B words' }, delivery_id: 'd-0123456789abcdef' };
    const previous = { status: 'readable', record: { told: {}, pending: [p], rebindings: [], carried: [], approval: { at: '2026-10-24T00:00:00Z' } } };
    const subtasks = [{ id: 'A', status: 'pending', profile: 'p', topic: 'do A' }];
    const kept = deriveRebindView({ subtasks, children: new Map(), previous, partial: new Set([p.delivery_id]) });
    const dropped = deriveRebindView({ subtasks, children: new Map(), previous, partial: new Set() });
    deepStrictEqual([kept.untouched.contested, dropped.untouched.contested, kept.rows, dropped.rows], [[p.delivery_id], undefined, [], []]);
    ok(kept.digest !== dropped.digest, 'the digest differs only by the note kept contested');
  });

  // More than one file bearing the child refuses it outright (state.mjs
  // childCopies; the owner's ruling D on the r16 Refine-verify,
  // refine-verify-20261024T163117Z-31d121). That review found four more files
  // the copy checks did not see (A to D) and a fresh delivery acknowledged past
  // them (E); each now meets the one refusal (copiesRefused), and the owner's
  // repair is its way out.

  // A: a copy under another name, found only by the workflow id it records,
  // claiming another subtask; B: an archived copy the claim scan skips. Each
  // holds a "B words" note, and the subtask is back to pending, revised back
  // to "do A".
  it('a dropped note held by a copy the claim scan does not count is kept told, contested: refused while the copy is left, and after its removal until restated', async () => {
    const variants = [
      {
        name: 'A, a copy found only by its workflow id, claiming another subtask',
        copy: (fx) => join(fx.work, '.claude', 'agentic-engineer', 'archive', 'restored-by-hand.md'),
        text: (t) => t.replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'),
        // Its claim repaired, it is still a second file.
        repaired: (t) => t.replace(/^originating_subtask: .*$/m, 'originating_subtask: "A"'),
      },
      {
        name: 'B, an archived copy the claim scan skips',
        copy: (fx, child) => child.path.replace('/workflows/', '/archive/'),
        text: (t) => t.replace(/^---\n/, '--x\n'),
        repaired: (t) => t.replace(/^--x\n/, '---\n'),
      },
    ];
    for (const v of variants) {
      await withRepo(async (fx) => {
        const child = await dispatch(fx, 'A');
        const expect = await expectOf(child.path);
        const before = childText(child.path);
        await revise(fx, 'A', { topic: 'B words' });
        await approve(fx);
        const [p] = (await record(fx)).record.pending;
        await writeNote(fx, child, p);
        const copy = v.copy(fx, child);
        mkdirSync(join(copy, '..'), { recursive: true });
        writeFileSync(copy, v.text(childText(child.path)));
        writeFileSync(child.path, before);
        await revise(fx, 'A', { topic: 'do A', status: 'pending' });
        deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).untouched.contested, [p.delivery_id], `${v.name}: kept, contested`);
        await approve(fx, { engineerRoot: ENG });
        const rec = (await record(fx)).record;
        deepStrictEqual([rec.told[child.id]?.topic, rec.told[child.id]?.delivery_id, rec.told[child.id]?.contested, rec.pending], ['B words', p.delivery_id, true, []], v.name);
        writeFileSync(copy, v.repaired(childText(copy)));
        await rejects(() => reattach(fx, child, expect), (err) => copiesRefused(child, 2).test(err.message), v.name);
        rmSync(copy);
        await rejects(() => reattach(fx, child, expect), (err) => contested(child).test(err.message), `${v.name}: the record kept refuses it`);
        const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
        deepStrictEqual(view.rows.map((r) => [r.kind, r.child_state, r.delivery?.restate]), [['told', 'active', true]], `${v.name}: restated in full`);
        deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['delivered'], v.name);
        strictEqual((await reattach(fx, child, expect)).updatedSubtask.status, 'in_progress', v.name);
      });
    }
  });

  // C: a readable file at the child's own path, recording another workflow
  // id and last told "B words", beside the archived claimant told "do A".
  it('a file of the child\'s name under another workflow id is a copy: every binding write and the boundary refuse while it is left, and bind once it is removed', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const toldB = childText(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx, { engineerRoot: ENG });
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      renameSync(child.path, archived);
      writeFileSync(child.path, toldB.split(child.id).join(`${child.id.slice(0, -6)}ccccc1`));
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      await rejects(() => reattach(fx, child, expect), (err) => copiesRefused(child, 2).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
      ok(copiesRefused(child, 2).test(`${child.id} is not bound to subtask "A": ${rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id })?.why}.`),
        'the run boundary refuses it alike');
      rmSync(child.path);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // D: an archive the archiver suffixed twice (it suffixes the name it is
  // given), unparsed and last told "B words", beside the archived claimant.
  it('an archive suffixed twice is a copy: its note is not acknowledged, the writes refuse it, and the told waiver completes it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const toldB = childText(child.path);
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      renameSync(child.path, archived);
      writeFileSync(archived.replace(/\.md$/, '-20261024T000000Z-0a1b2c-20261025T000000Z-3d4e5f.md'), toldB.replace(/^---\n/, '--x\n'));
      deepStrictEqual(deliver(fx).map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'copies']]);
      deepStrictEqual((await record(fx)).record.pending.map((q) => q.delivery_id), [p.delivery_id], 'not acknowledged');
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2, { archived: true }).test(err.message));
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'two archived copies' })).updatedSubtask.status, 'completed');
    });
  });

  // E: an approval's fresh delivery to an active child, an archived copy of it
  // beside it, was acknowledged after reading back only the active copy.
  it('no note is delivered to a child more than one file bears: it waits, and is delivered once the extra copy is removed', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      await revise(fx, 'A', { topic: 'B words' });
      deepStrictEqual((await approve(fx, { engineerRoot: ENG })).deliveries.map((d) => d.status), ['copies']);
      ok(!childText(child.path).includes('### Owner instruction change ('), 'nothing is written to the child');
      deepStrictEqual(rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id }), { due: 'pending' });
      await rejects(() => terminal(fx, 'A', child, expect), /has not been told the change yet/);
      deepStrictEqual(deliver(fx).map((d) => d.status), ['copies'], 'nor by a delivery run later');
      rmSync(archived);
      deepStrictEqual(deliver(fx).map((d) => d.status), ['delivered']);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // F: beside an active file of its id that claims another subtask, the
  // approval showed the archived child with the told waiver, which the write
  // refuses. The waiver is offered only when no file bearing it is active.
  it('an archived child beside an active file of its id is shown refused without the told waiver, which the write refuses; with every file archived it is offered and completes', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      renameSync(child.path, archived);
      const other = join(child.path, '..', 'restored-by-hand.md');
      writeFileSync(other, childText(archived).replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'));
      await revise(fx, 'A', { topic: 'C words' });
      const refusedRow = () => {
        const { rows } = fx.orch.planRebindView({ workflowPath: fx.macroPath });
        deepStrictEqual(rows.map((r) => [r.kind, r.child_state]), [['rebind', 'archived']]);
        return `${child.id} is not bound to subtask "A": ${rows[0].refused}.`;
      };
      ok(copiesRefused(child, 2).test(refusedRow()), refusedRow());
      await approve(fx, { engineerRoot: ENG });
      await rejects(() => complete(fx, 'A', child, expect, { waiveTold: true, reason: 'anyway' }),
        (err) => copiesRefused(child, 2).test(err.message) && err.message.includes(`a file of ${child.id} is still in a workflow home`));
      renameSync(other, join(archived, '..', 'restored-by-hand.md'));
      ok(copiesRefused(child, 2, { archived: true }).test(refusedRow()), refusedRow());
      strictEqual((await complete(fx, 'A', child, expect, { waiveTold: true, reason: 'two archived copies' })).updatedSubtask.status, 'completed');
    });
  });

  // With one file left, a file of the child's id that claims another subtask
  // is refused by name (toldNoteHeld 'conflict'), not as a copy missing its note.
  it('a child whose only file claims another subtask is refused as such, and bound once the file is repaired', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'));
      const conflict = new RegExp(`${child.id} is not bound to subtask "A": a workflow file of ${child.id} claims another subtask or macro, ` +
        'so which words it answers to is not known; repair or remove that file');
      await rejects(() => terminal(fx, 'A', child, expect), (err) => conflict.test(err.message));
      writeFileSync(child.path, good);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  // The r17 Refine-verify (refine-verify-20261025T013041Z-672a1d): with no
  // record of rebindings, the run boundary returned before the told check, so
  // a run stepped a child two files bear that every binding write refuses.
  it('the run boundary refuses a child two files bear with no record of rebindings, as the writes do', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      strictEqual(parseRebindRecord((await fx.readMacro()).plan_rebindings).status, 'absent', 'no record');
      const due = async () => rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id });
      strictEqual(await due(), null, 'control: one file');
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      writeFileSync(archived, childText(child.path));
      ok(copiesRefused(child, 2).test(`${child.id} is not bound to subtask "A": ${(await due())?.why}.`), JSON.stringify(await due()));
      await rejects(() => terminal(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message));
    });
  });

  // The r17 Refine-verify: a physical file counted once kept the activity of
  // the name met first, so an archive linked into a workflow home read as
  // archived, and the told waiver completed a child that may still run.
  it('an archived file linked into a workflow home is active: the approval shows the child active', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      renameSync(child.path, archived);
      const link = join(fx.work, '.claude', 'agentic-engineer', 'workflows', `${child.id}.md`);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(archived, link);
      await revise(fx, 'A', { topic: 'B words' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows.map((r) => [r.kind, r.child_state]), [['rebind', 'active']]);
    });
  });

  it('a second file linked into a workflow home is active: an archived child beside it is refused the told waiver until the link is removed', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      const archived = child.path.replace('/workflows/', '/archive/');
      mkdirSync(join(archived, '..'), { recursive: true });
      renameSync(child.path, archived);
      const other = archived.replace(/\.md$/, '-20261024T000000Z-0a1b2c.md');
      writeFileSync(other, childText(archived).replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'));
      const link = join(fx.work, '.claude', 'agentic-engineer', 'workflows', `${child.id}.md`);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(other, link);
      const waive = () => complete(fx, 'A', child, expect, { waiveTold: true, reason: 'two archived copies' });
      await rejects(waive, (err) => copiesRefused(child, 2).test(err.message) && err.message.includes(`a file of ${child.id} is still in a workflow home`));
      rmSync(link);
      strictEqual((await waive()).updatedSubtask.status, 'completed', 'control: with no file of it active the waiver completes it');
    });
  });

  // The r17 Refine-verify: a second file appearing while a delivery wrote its
  // note was not seen, and the delivery was acknowledged. The engineer here is
  // a shim that runs the real append, then copies the child into the archive.
  it('a delivery whose child gains a second file while its note is written leaves it pending', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      const shimRoot = mkdtempSync(join(tmpdir(), 'rebind-shim-'));
      try {
        mkdirSync(join(shimRoot, 'scripts'));
        writeFileSync(join(shimRoot, 'scripts', 'state.mjs'), [
          "// TEXT_FILE_FLAGS = ['phase-note'], the engineer's, which this shim runs",
          "import { execFileSync } from 'node:child_process';",
          "import { copyFileSync, mkdirSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          `execFileSync(process.execPath, [${JSON.stringify(join(ENG, 'scripts', 'state.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
          "const path = process.argv[process.argv.indexOf('--workflow-path') + 1];",
          "const copy = path.replace('/workflows/', '/archive/');",
          'mkdirSync(dirname(copy), { recursive: true });',
          'copyFileSync(path, copy);',
          '',
        ].join('\n'));
        const out = await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: shimRoot, env: OWNER });
        deepStrictEqual(out.map((d) => [d.delivery_id, d.status]), [[p.delivery_id, 'copies']]);
        ok(childText(child.path).includes(`Owner instruction change (${p.delivery_id})`), 'the note was written');
        deepStrictEqual((await record(fx)).record.pending.map((q) => q.delivery_id), [p.delivery_id], 'not acknowledged');
      } finally {
        rmSync(shimRoot, { recursive: true, force: true });
      }
    });
  });

  // The r18 critique, MAJOR 1: the claim scan can throw where one file bears
  // the child (here a stray file claiming the subtask records no workflow
  // id), so only the scan's catch keeps the pending note as partial evidence.
  it('a claim scan that throws beside a child one file bears is partial evidence: the dropped note is recorded told, contested', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const before = childText(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const [p] = (await record(fx)).record.pending;
      await writeNote(fx, child, p);
      const stray = join(fx.work, '.claude', 'agentic-engineer', 'workflows', 'stray.md');
      mkdirSync(join(stray, '..'), { recursive: true });
      writeFileSync(stray, before.replace(/^workflow_id: .*\n/m, ''));
      strictEqual(fx.orch.childCopies(fx.work, child.id), null, 'one file bears the child');
      await revise(fx, 'A', { topic: 'do A', status: 'pending' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).untouched.contested, [p.delivery_id]);
      await approve(fx, { engineerRoot: ENG });
      const rec = (await record(fx)).record;
      deepStrictEqual([rec.told[child.id]?.topic, rec.told[child.id]?.contested, rec.pending], ['B words', true, []], 'told the dropped note, contested');
    });
  });

  // The r18 critique, MAJOR 2: the engineer's archiver writes the archive,
  // then removes the workflow file. Killed between the two, it leaves both;
  // retried, it adds a second, suffixed archive. Each state is refused, as
  // ruling D says, and the refusal names its repair: the files hold the same
  // notes, so keeping one and removing the others loses nothing.
  it('an archive killed before it removed the workflow file, then retried, leaves copies holding the same notes: the writes refuse them naming the repair, and bind once one is left', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const before = childText(child.path);
      const first = await fx.eng.archiveWorkflow({ workflowPath: child.path, host: H, repoRoot: fx.work });
      writeFileSync(child.path, before);
      const keepActive = copiesRefused(child, 2, { same: 'the one in a workflow home' });
      await rejects(() => terminal(fx, 'A', child, expect), (err) => keepActive.test(err.message) && err.message.includes(first.to) && err.message.includes(child.path));
      ok(keepActive.test(`${child.id} is not bound to subtask "A": ${rebindDue(await fx.readMacro(), 'A', { macroPath: fx.macroPath, selected: child.id })?.why}.`),
        'the run boundary names the repair alike');
      const second = await fx.eng.archiveWorkflow({ workflowPath: child.path, host: H, repoRoot: fx.work });
      ok(/-\d{8}T\d{6}Z-[0-9a-f]{6}\.md$/.test(second.to), `the retry suffixed its archive: ${second.to}`);
      ok(!existsSync(child.path), 'the retry removed the workflow file');
      await rejects(() => complete(fx, 'A', child, expect),
        (err) => copiesRefused(child, 2, { same: 'one archive', archived: true }).test(err.message));
      rmSync(second.to);
      strictEqual((await complete(fx, 'A', child, expect)).updatedSubtask.status, 'completed', 'one archive left: the child binds');
    });
  });

  // The r18 critique, L1: a physical file is one bearer whatever names it, a
  // hard link included, and a link whose target is gone bears nothing.
  it('a hard link of the child\'s file, and a link whose target is gone, are no second copy; a real copy is', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      const archive = join(child.path, '..', '..', 'archive');
      mkdirSync(archive, { recursive: true });
      linkSync(child.path, join(archive, `${child.id}.md`));
      symlinkSync(join(archive, 'gone.md'), join(archive, `${child.id}-20261024T000000Z-0a1b2c.md`));
      strictEqual(fx.orch.childCopies(fx.work, child.id), null);
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
      writeFileSync(join(archive, `${child.id}-20261025T000000Z-3d4e5f.md`), childText(child.path));
      await rejects(() => complete(fx, 'A', child, expect), (err) => copiesRefused(child, 2).test(err.message), 'control: a real copy is refused');
    });
  });

  // The r18 critique, L2: a scan that cannot be read refuses, and says why.
  it('a home the copy scan cannot read refuses the child, naming what it could not read', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      mkdirSync(join(child.path, '..', 'not-a-file.md'));
      await rejects(() => terminal(fx, 'A', child, expect),
        /more than one copy of [^ ]+ may run \(the files that may bear it cannot all be read: [^)]*not-a-file\.md is not a regular file\)/);
    });
  });

  // The r18 critique, MAJOR 2: a file moved while the scan runs (the
  // archiver's write then removal, or a move between the scan's passes) is
  // met under two names. The count is refused only once two scans agree.
  it('the copy count is the scan\'s only when it holds: a count that changes is scanned again, one that never settles is refused', () => {
    const bearer = (n, active = false) => ({ path: `/h/${n}.md`, active, identity: n });
    const run = (results) => {
      let calls = 0;
      let settled = 0;
      const out = childCopies('/root', 'c', {
        scan: () => {
          const r = results[Math.min(calls, results.length - 1)];
          calls += 1;
          if (r instanceof Error) throw r;
          return r;
        },
        settle: () => { settled += 1; },
      });
      return { out, calls, settled };
    };
    deepStrictEqual(run([[bearer('a', true), bearer('b')], [bearer('b')]]), { out: null, calls: 2, settled: 1 }, 'a move seen twice, then once');
    const stable = run([[bearer('a', true), bearer('b')], [bearer('b'), bearer('a', true)]]);
    deepStrictEqual([stable.out?.count, stable.out?.active, stable.out?.paths, stable.calls, stable.settled], [2, true, ['/h/a.md', '/h/b.md'], 2, 1]);
    const moving = run([[bearer('a'), bearer('b')], [bearer('a'), bearer('c')], [bearer('a'), bearer('d')], [bearer('a')]]);
    deepStrictEqual([moving.out?.count, moving.calls, moving.settled], [2, 3, 2], 'never settling, it is refused');
    const broken = run([new Error('boom')]);
    deepStrictEqual([broken.out?.count, broken.out?.error, broken.calls], [Infinity, 'boom', 1]);
  });

  it('the told waiver is refused for an active child, and for a child the record vouches for', async () => {
    await withRepo(async (fx) => {
      const { child, expect } = await toldThenReturned(fx);
      const waive = () => fx.orch.updateSubtask({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'completed', engineerWorkflowId: child.id,
        commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', expectDispatch: expect, waiveTold: true, reason: 'anyway',
      });
      const before = macroText(fx);
      await rejects(waive, (err) => notTold(child).test(err.message)
        && err.message.includes(`--waive-dispatch waives this check only for an archived child, and a file of ${child.id} is still in a workflow home`));
      await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER });
      const delivered = macroText(fx);
      ok(before !== delivered, 'the delivery was recorded');
      await rejects(waive, /waives nothing: the macro's record vouches for what/);
      strictEqual(macroText(fx), delivered, 'the refused waiver wrote nothing');
    });
  });

  it('a recorded owner with no file left completes under --waive-dispatch, which waives the told check too and says so', async () => {
    await withRepo(async (fx) => {
      const { child } = await toldThenReturned(fx);
      rmSync(child.path);
      await fx.orch.updateSubtask({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'completed', engineerWorkflowId: child.id,
        commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', waiveDispatch: true, reason: 'the lane was removed',
      });
      strictEqual((await fx.subtask('A')).status, 'completed');
      ok(macroText(fx).includes(`Told check waived (--waive-dispatch): ${child.id} is not bound to subtask "A": ${child.id} has not been told`), macroText(fx));
    });
  });

  // Every file of the child's name is a copy (ADR-0068 Decision 8, item 4): an
  // archive the archiver suffixed on a collision keeps the child from counting
  // as gone.
  it('--waive-dispatch is refused while an archive of the child under the archiver\'s collision suffix is left', async () => {
    await withRepo(async (fx) => {
      const { child } = await toldThenReturned(fx);
      const suffixed = child.path.replace('/workflows/', '/archive/').replace(/\.md$/, '-20261024T000000Z-0a1b2c.md');
      mkdirSync(join(suffixed, '..'), { recursive: true });
      renameSync(child.path, suffixed);
      const waive = () => fx.orch.updateSubtask({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'completed', engineerWorkflowId: child.id,
        commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', waiveDispatch: true, reason: 'the lane was removed',
      });
      await rejects(waive, (err) => /--waive-dispatch waives this check, with the dispatch's comparison, only when no file of .* is left/.test(err.message));
      rmSync(suffixed);
      strictEqual((await waive()).updatedSubtask.status, 'completed', 'control: with no file left it completes');
    });
  });

  it('done\'s binding line names the owner, and every write that accepts its work still refuses it until the note is delivered', async () => {
    await withRepo(async (fx) => {
      const { child, expect } = await toldThenReturned(fx);
      const m = await fx.readMacro();
      await fx.orch.setPlan({
        workflowPath: fx.macroPath, host: H,
        subtasks: m.plan.subtasks.map((s) => (s.id === 'A' ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'engineer_workflow_id')) : s)),
      });
      await approve(fx);
      await fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: 'A', host: H, engineerWorkflowId: child.id, expectDispatch: expect });
      strictEqual((await fx.subtask('A')).engineer_workflow_id, child.id);
      await rejects(() => terminal(fx, 'A', child, expect), notTold(child));
      await rejects(() => complete(fx, 'A', child, expect), notTold(child));
      await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER });
      strictEqual((await complete(fx, 'A', child, expect)).updatedSubtask.status, 'completed');
    });
  });

  it('a pending note of an approval the plan changed since names the approval, not a delivery, as its way out', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      await revise(fx, 'A', { topic: 'do A' });
      await rejects(() => terminal(fx, 'A', child, expect), (err) => notTold(child).test(err.message) === false
        && /has not been told the subtask's words yet: a note to it \(delivery d-[0-9a-f]{16}\) is pending; the plan changed since the approval that made it, so it is not delivered: approve the plan as it stands/.test(err.message));
      await approve(fx, { engineerRoot: ENG });
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('an archived child rebound with its note pending is completed under the told waiver, its dispatch still compared', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      await revise(fx, 'A', { topic: 'C words' });
      await approve(fx);
      await fx.commitAndArchive(child.path);
      const waive = (over = {}) => fx.orch.updateSubtask({
        workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'completed', engineerWorkflowId: child.id,
        commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', expectDispatch: expect, ...over,
      });
      await rejects(() => waive(), /has not been told the change yet/);
      strictEqual((await waive({ waiveTold: true, reason: 'finished under B' })).updatedSubtask.status, 'completed');
      ok(macroText(fx).includes(`Told check waived (--waive-dispatch): ${child.id} is not bound to subtask "A": ${child.id} has not been told`), macroText(fx));
      ok(/Rebound \(ADR-0068 Decision 8\): accepted under the approval of/.test(macroText(fx)), 'the dispatch was compared, and rebound');
    });
  });

  it('the waivers are refused for a child whose active file the scan skips beside an archived copy, and --waive-dispatch while a file of it is left', async () => {
    await withRepo(async (fx) => {
      const { child, expect } = await toldThenReturned(fx);
      const completion = { workflowPath: fx.macroPath, host: H, subtaskId: 'A', status: 'completed', engineerWorkflowId: child.id, commit: 'def5678', closedAt: '2026-10-20T00:00:00Z', reason: 'anyway' };
      // --waive-dispatch, its owner's file still there (active), waives nothing.
      const before = macroText(fx);
      await rejects(() => fx.orch.updateSubtask({ ...completion, waiveDispatch: true }), (err) => notTold(child).test(err.message)
        && err.message.includes(`--waive-dispatch waives this check, with the dispatch's comparison, only when no file of ${child.id} is left`));
      // A readable archived copy beside an active one the claim scan skips: the
      // child may still run, so it is not taken as archived.
      const archivedCopy = child.path.replace(/\/workflows\/([^/]+)$/, '/archive/$1');
      mkdirSync(resolve(archivedCopy, '..'), { recursive: true });
      writeFileSync(archivedCopy, childText(child.path));
      unopenedFile(child.path);
      await rejects(() => fx.orch.updateSubtask({ ...completion, expectDispatch: expect, waiveTold: true }),
        (err) => copiesRefused(child, 2).test(err.message) && err.message.includes(`a file of ${child.id} is still in a workflow home (it is active, or may be)`));
      // Nor is it gone while that file is left.
      await rejects(() => fx.orch.updateSubtask({ ...completion, waiveDispatch: true }), /only when no file of/);
      // An active file of the child that claims another subtask, beside the
      // archived claimant: still not archived.
      writeFileSync(child.path, childText(archivedCopy).replace(/^originating_subtask: .*$/m, 'originating_subtask: "B"'));
      await rejects(() => fx.orch.updateSubtask({ ...completion, expectDispatch: expect, waiveTold: true }), /is still in a workflow home/);
      // A file named for the child whose frontmatter names nothing: not gone.
      rmSync(archivedCopy);
      writeFileSync(child.path, '---\ncurrent_phase: phase-0-bootstrap\n---\n');
      await rejects(() => fx.orch.updateSubtask({ ...completion, waiveDispatch: true }), /only when no file of/);
      strictEqual(macroText(fx), before, 'the refused writes wrote nothing');
    });
  });

  it('the told check, read alone: a pending note or other words told for the subtask refuse; its way out names the child\'s state', async () => {
    const fm = (rec) => ({ plan_rebindings: JSON.stringify(rec) });
    const base = {
      v: 1, approval: { id: 'a'.repeat(32), at: '2026-10-20T00:00:00Z', hash: 'b'.repeat(64) },
      rebindings: [], carried: [], pending: [], told: {},
    };
    const child = 'compose-20261020T000000Z-c1c1c1';
    const current = { profile: 'p', topic: 'do A' };
    const told = (over = {}) => ({ [child]: { subtask: 'A', profile: 'p', topic: 'do A', delivery_id: 'd-0123456789abcdef', at: '2026-10-21T00:00:00Z', ...over } });
    const note = (over = {}) => ({ delivery_id: 'd-1123456789abcdef', child, subtask: 'A', from: { profile: 'p', topic: 'B words' }, to: current, ...over });
    const never = () => { throw new Error('the start is read only for a replaced record'); };
    const verdict = (rec, archived = false, startedAt = never) => vouchVerdict({ fm: fm(rec), subtaskId: 'A', current, child, startedAt, archived });
    deepStrictEqual(verdict({ ...base, told: told() }), { ok: true, retire: false }, 'told these words');
    deepStrictEqual(verdict({ ...base, told: told({ subtask: 'B', topic: 'B words' }) }), { ok: true, retire: false }, 'told for another subtask');
    const contrary = verdict({ ...base, told: told({ topic: 'B words' }) });
    ok(!contrary.ok && /was last told other words for subtask A \(delivery d-0123456789abcdef\)/.test(contrary.why), contrary.why);
    ok(!verdict({ ...base, told: told({ profile: 'q' }) }).ok, 'told another profile');
    // A contested entry binds no words, the subtask's own included.
    const disputed = verdict({ ...base, told: told({ contested: true }) });
    ok(!disputed.ok && /than the subtask's now, or its copies disagree on what it was told/.test(disputed.why), disputed.why);
    for (const rec of [{ ...base, pending: [note()] }, { ...base, told: told(), pending: [note({ from: current })] }, { ...base, told: told({ subtask: 'B' }), pending: [note()] }]) {
      const r = verdict(rec);
      ok(!r.ok && /has not been told the subtask's words yet: a note to it \(delivery d-1123456789abcdef\) is pending/.test(r.why), r.why);
    }
    // Told these words since a replacement, a note still pending: refused all the same.
    const sincePending = verdict({ ...base, replaced_at: '2026-10-20T00:00:00Z', told: told(), pending: [note({ from: current })] });
    ok(!sincePending.ok && /has not been told the subtask's words yet/.test(sincePending.why), sincePending.why);
    // The way out: a note for an active child, the waiver for an archived one.
    ok(/state\.mjs rebind-deliver does now/.test(verdict({ ...base, pending: [note()] }).why));
    const stale = vouchVerdict({ fm: fm({ ...base, pending: [note()] }), subtaskId: 'A', current, child, startedAt: never, fresh: false });
    ok(!stale.ok && /so it is not delivered: approve the plan as it stands/.test(stale.why) && !/rebind-deliver/.test(stale.why), stale.why);
    for (const rec of [{ ...base, pending: [note()] }, { ...base, told: told({ topic: 'B words' }) }, { ...base, replaced_at: '2026-10-20T00:00:00Z' }]) {
      const r = verdict(rec, true, () => null);
      ok(!r.ok && r.why.includes(`${child} is archived, so no note reaches it: /orchestrator:done --waive-dispatch`), r.why);
      ok(!/rebind-deliver|\/orchestrator:approve/.test(r.why), r.why);
    }
    const unreadable = vouchVerdict({ fm: { plan_rebindings: '{x' }, subtaskId: 'A', current, child, startedAt: never, archived: true });
    ok(unreadable.why.includes(`${child} is archived, so no note reaches it`), unreadable.why);
  });
});

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8, item 2 — the approval approves what it showed', () => {
  it('--expect-rebind is required when the view has rows, and a changed child refuses the approval', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await rejects(() => fx.orch.approvePlan({ workflowPath: fx.macroPath, host: H, env: OWNER }), /pass --expect-rebind/);
      const shown = fx.orch.planRebindView({ workflowPath: fx.macroPath }).digest;
      // The child's next step changes between the display and the approval.
      await fx.finish(child.path, { kind: 'commit', confidence: 'HIGH' });
      await rejects(() => fx.orch.approvePlan({ workflowPath: fx.macroPath, host: H, env: OWNER, expectRebind: shown }),
        /the in-progress children changed since they were shown/);
      const again = fx.orch.planRebindView({ workflowPath: fx.macroPath }).digest;
      await fx.commitAndArchive(child.path);
      await rejects(() => fx.orch.approvePlan({ workflowPath: fx.macroPath, host: H, env: OWNER, expectRebind: again }),
        /the in-progress children changed since they were shown/);
      strictEqual((await fx.readMacro()).plan_approval_status, 'pending');
    });
  });

  it('plan-hash prints the view and its digest, and the CLI approval binds to them', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      const shown = JSON.parse(cli(fx, ['plan-hash', '--workflow-path', fx.macroPath]));
      deepStrictEqual(shown.rebind_view.rows.map((r) => [r.subtask, r.kind, r.changed]), [['A', 'rebind', ['topic']]]);
      deepStrictEqual(shown.rebind_view.untouched, { told: [], pending: [] });
      const out = JSON.parse(cli(fx, ['plan-approve', '--workflow-path', fx.macroPath, '--host', H,
        '--expect-hash', shown.plan_hash, '--expect-rebind', shown.rebind_digest, '--engineer-root', ENG]));
      strictEqual(out.rebindings, 1);
      deepStrictEqual(out.deliveries.map((d) => d.status), ['delivered']);
    });
  });

  it('approving an unchanged approval again writes nothing; one with a delivery pending is re-recorded', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const id1 = (await fx.readMacro()).plan_approval_id;
      const r2 = await approve(fx);
      strictEqual(r2.noop, false);
      ok((await fx.readMacro()).plan_approval_id !== id1, 're-recorded with a fresh stamp');
      await approve(fx, { engineerRoot: ENG });
      const before = macroText(fx);
      const r4 = await approve(fx, { engineerRoot: ENG });
      strictEqual(r4.noop, true);
      strictEqual(macroText(fx), before);
    });
  });

  it('an unreadable record fails no read, binds nothing, refuses delivery, and the next approval replaces it', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const expect = await expectOf(child.path);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{not json"'));
      strictEqual((await fx.readMacro()).plan_rebindings, '{not json');
      await rejects(() => terminal(fx, 'A', child, expect), /record of rebindings \(plan_rebindings\) is unreadable/);
      await rejects(() => fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER }), /unreadable/);
      // JSON that is no record is unreadable too, never trusted.
      const saved = macroText(fx);
      writeFileSync(fx.macroPath, saved.replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{\\"v\\":1}"'));
      await rejects(() => terminal(fx, 'A', child, expect), /record of rebindings \(plan_rebindings\) is unreadable \(approval is not a stamp/);
      writeFileSync(fx.macroPath, saved);
      await approve(fx, { engineerRoot: ENG });
      ok(macroText(fx).includes('the previous record of rebindings was unreadable'));
      strictEqual((await terminal(fx, 'A', child, expect)).noted, true);
    });
  });

  it('an approval that replaces an unreadable record tells each active child its words in full, a return to its dispatch included', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{not json"'));
      // The repair the refusals name: revise back to the dispatch and approve.
      await revise(fx, 'A', { topic: 'do A' });
      const view = fx.orch.planRebindView({ workflowPath: fx.macroPath });
      deepStrictEqual(view.rows.map((r) => [r.kind, r.delivery?.restate]), [['matches', true]]);
      // Not told yet: the note waits, and the run's boundary holds the next step for it.
      await approve(fx);
      const pending = (await record(fx)).record.pending;
      deepStrictEqual(pending.map((p) => [p.child, p.restate, p.to.topic]), [[child.id, true, 'do A']]);
      ok(macroText(fx).includes('told the words it answers to now, in full, by delivery'));
      // A second approval before the note is written keeps it, under its id.
      await revise(fx, 'B', { topic: 'B changed, A untouched' });
      await approve(fx);
      deepStrictEqual((await record(fx)).record.pending.map((p) => [p.delivery_id, p.restate]), [[pending[0].delivery_id, true]]);
      // ...and so does one taken while the child's file cannot be read, which
      // carries the note as it was.
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^---\n/, '--x\n'));
      await revise(fx, 'B', { topic: 'B changed again' });
      await approve(fx);
      deepStrictEqual((await record(fx)).record.pending.map((p) => [p.delivery_id, p.restate]), [[pending[0].delivery_id, true]]);
      writeFileSync(child.path, good);
      const out = await fx.orch.deliverPendingRebindings({ workflowPath: fx.macroPath, host: H, engineerRoot: ENG, env: OWNER });
      deepStrictEqual(out.map((d) => d.status), ['delivered']);
      const text = childText(child.path);
      const note = text.slice(text.lastIndexOf(`### Owner instruction change (${pending[0].delivery_id})`));
      ok(/could not be read, so they are restated in full/.test(note), note);
      ok(note.includes('**topic** is:\n\n```text\ndo A\n```'), note);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
    });
  });

  it('what is not known after an unreadable record stays not known through approvals that cannot tell the child', async () => {
    // A revision it cannot rebind, before the restating note is written.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{not json"'));
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      await revise(fx, 'A', { branch: 'feat/a2' });
      await approve(fx);
      let rec = (await record(fx)).record;
      deepStrictEqual([rec.unknown, rec.pending.length], [['A'], 0]);
      ok(macroText(fx).includes('- A: what its child was last told is not known'));
      await revise(fx, 'A', { branch: 'feat/a' });
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      ok(/restated in full/.test(childText(child.path).slice(childText(child.path).lastIndexOf('### Owner instruction change ('))));
      rec = (await record(fx)).record;
      deepStrictEqual([rec.unknown, rec.told[child.id].topic], [undefined, 'do A']);
      strictEqual((await approve(fx)).noop, true, 'once told, an approval of the same plan writes nothing');
    });
    // A record whose restating note is pending names no subtask unknown: the
    // note alone keeps it so.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{not json"'));
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      const rec = (await record(fx)).record;
      delete rec.unknown;
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, `plan_rebindings: ${JSON.stringify(JSON.stringify(rec))}`));
      const r = await approve(fx, { engineerRoot: ENG });
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
    });
    // The child unreadable at the approval that replaces the record.
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      writeFileSync(fx.macroPath, macroText(fx).replace(/^plan_rebindings: .*$/m, 'plan_rebindings: "{not json"'));
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^---\n/, '--x\n'));
      await revise(fx, 'A', { topic: 'do A' });
      await approve(fx);
      deepStrictEqual((await record(fx)).record.unknown, ['A']);
      writeFileSync(child.path, good);
      const r = await approve(fx, { engineerRoot: ENG });
      strictEqual(r.noop, false);
      deepStrictEqual(r.deliveries.map((d) => d.status), ['delivered']);
      strictEqual((await record(fx)).record.told[child.id].topic, 'do A');
    });
  });

  it('a record over its cap refuses the approval before anything is written', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'x'.repeat(REBIND_RECORD_MAX_BYTES) });
      const before = macroText(fx);
      await rejects(() => approve(fx), /over the cap of 65536/);
      strictEqual(macroText(fx), before);
    });
  });
});

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8, item 3 — only with nothing in flight', () => {
  const lockOf = (fx) => macroLockPath(fx.work, fx.macroId);

  it('refused beside a live run\'s lock: a plan-set and an approval between two looks never pass', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      const held = await acquireLock(lockOf(fx), { record: { run_id: 'autopilot-20261020T000000Z-abcdef', pid: process.pid } });
      ok(held);
      await revise(fx, 'A', { topic: 'B words' });
      await rejects(() => approve(fx), /plan-approve: refused, nothing written: another autopilot run holds .*autopilot-20261020T000000Z-abcdef/s);
      strictEqual((await fx.readMacro()).plan_approval_status, 'pending', 'the run halts plan-unapproved at its next look');
      const gate = fx.orch.planApprovalGate({ frontmatter: await fx.readMacro(), workflowPath: fx.macroPath, host: H,
        selected: await fx.subtask('B'), env: { AGENTIC_AUTOPILOT: 'autopilot-20261020T000000Z-abcdef' } });
      deepStrictEqual([gate.verdict, gate.reason], ['refuse', 'plan-unapproved']);
    });
  });

  it('refused beside an admitted interactive /orchestrator:next, its subtask not yet in progress', async () => {
    await withRepo(async (fx) => {
      const joined = await joinAdmission({ command: 'next', checkout: fx.work, macroId: fx.macroId, host: H, env: OWNER });
      ok(joined.admissionId);
      await rejects(() => approve(fx), /an interactive session holds .*\/orchestrator:next/s);
    });
  });

  it('a killed approval leaves its entry, which the next one names with its release command', async () => {
    await withRepo(async (fx) => {
      const script = `import { joinAdmission } from ${JSON.stringify(pathToFileURL(resolve(ORCH, 'scripts/lib/run-locks.mjs')).href)};
        await joinAdmission({ command: 'approve', checkout: ${JSON.stringify(fx.work)}, macroId: ${JSON.stringify(fx.macroId)}, host: 'claude', resolveCheckout: false });
        process.stdout.write('joined\\n'); setInterval(() => {}, 1000);`;
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: fx.env, stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((ok_, fail) => { p.stdout.on('data', (d) => (String(d).includes('joined') ? ok_() : null)); p.on('exit', () => fail(new Error('exited'))); });
      p.kill('SIGKILL');
      await new Promise((r) => p.on('exit', r));
      let message = '';
      await rejects(() => approve(fx), (err) => { message = err.message; return /\/orchestrator:approve/.test(message) && /admission release/.test(message); });
      const release = message.match(/state\.mjs admission release (.*?)(?=\. An approval)/)[1].split(' ');
      cli(fx, ['admission', 'release', ...release]);
      const r = await approve(fx);
      strictEqual(r.noop, true);
    });
  });

  // An engineer whose append marks its start, then writes its note late.
  const SLOW_APPEND = `const TEXT_FILE_FLAGS = ['phase-note'];
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SLOW_STARTED, String(process.pid));
setTimeout(() => writeFileSync(process.env.SLOW_DONE, 'late'), 2500);
`;
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

  it('an approval killed while its note is written leaves an entry no one can release until that writer ends', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      const slow = mkdtempSync(join(tmpdir(), 'slow-engineer-'));
      try {
        mkdirSync(join(slow, 'scripts'));
        writeFileSync(join(slow, 'scripts/state.mjs'), SLOW_APPEND);
        const started = join(slow, 'started');
        const done = join(slow, 'done');
        const { digest } = fx.orch.planRebindView({ workflowPath: fx.macroPath });
        const p = spawn(process.execPath, [STATE, 'plan-approve', '--workflow-path', fx.macroPath, '--host', H, '--expect-rebind', digest, '--engineer-root', slow],
          { env: { ...fx.env, SLOW_STARTED: started, SLOW_DONE: done }, stdio: 'ignore' });
        for (const until = Date.now() + 20000; !existsSync(started) && Date.now() < until;) await sleep(50);
        ok(existsSync(started), 'the note\'s writer never started');
        // The process the admission records is the one that writes the note.
        const entry = readLockEntries(macroLockPath(fx.work, fx.macroId)).find((e) => e.session && e.holder?.command === 'approve');
        strictEqual(entry?.holder?.writer?.pid, Number(readFileSync(started, 'utf8')));
        p.kill('SIGKILL');
        await new Promise((r) => { p.on('exit', r); });
        let message = '';
        await rejects(() => approve(fx), (err) => { message = err.message; return /admission release/.test(message); });
        const release = message.match(/state\.mjs admission release (.*?)(?=\. An approval)/)[1].split(' ');
        let refused = null;
        try {
          cli(fx, ['admission', 'release', ...release]);
        } catch (err) {
          refused = err;
        }
        ok(refused && /the writer of an instruction note this admission started .* is still running/.test(refused.stderr), String(refused?.stderr));
        strictEqual(existsSync(done), false, 'the refusal came while the writer still ran');
        // Once the writer has ended, the entry is released, and approving works again.
        let released = false;
        for (const until = Date.now() + 20000; !released && Date.now() < until; await sleep(100)) {
          try {
            cli(fx, ['admission', 'release', ...release]);
            released = true;
          } catch { /* still running */ }
        }
        ok(released && existsSync(done));
        await approve(fx, { engineerRoot: ENG });
      } finally {
        rmSync(slow, { recursive: true, force: true });
      }
    });
  });

  it('a hold or release record refuses a rebinding approval and a delivery; a plain approval and the park records do not', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      const holds = join(fx.work, '.agentic-plugins/runs/autopilot/holds', fx.macroId);
      mkdirSync(join(holds, 'parks'), { recursive: true });
      await revise(fx, 'B', { topic: 'B changed, A untouched' });
      await approve(fx);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      writeFileSync(join(holds, 'A.json'), '{}');
      await revise(fx, 'A', { topic: 'C words' });
      await rejects(() => approve(fx), /would rebind or tell A, which is held/);
      rmSync(join(holds, 'A.json'));
      await approve(fx);
      writeFileSync(join(holds, 'A.json'), '{}');
      const out = JSON.parse(cli(fx, ['rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG]));
      deepStrictEqual(out.deliveries.map((d) => d.status), ['blocked']);
    });
  });

  it('a hold refuses an approval that only tells the held subtask, and not one that carries its note as it was', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      const holds = join(fx.work, '.agentic-plugins/runs/autopilot/holds', fx.macroId);
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx, { engineerRoot: ENG });
      // Back to the dispatch: nothing to rebind, only the return to tell.
      await revise(fx, 'A', { topic: 'do A' });
      deepStrictEqual(fx.orch.planRebindView({ workflowPath: fx.macroPath }).rows.map((r) => [r.kind, r.delivery?.fields]), [['matches', ['topic']]]);
      mkdirSync(holds, { recursive: true });
      writeFileSync(join(holds, 'A.json'), '{}');
      const before = macroText(fx);
      await rejects(() => approve(fx), /would rebind or tell A, which is held/);
      strictEqual(macroText(fx), before);
      rmSync(join(holds, 'A.json'));
      await approve(fx);
      // Its note pending and its child unreadable for now: an approval of
      // another subtask carries the note as it was, and the hold does not stop it.
      const good = childText(child.path);
      writeFileSync(child.path, good.replace(/^---\n/, '--x\n'));
      writeFileSync(join(holds, 'A.json'), '{}');
      await revise(fx, 'B', { topic: 'B changed, A untouched' });
      const r = await approve(fx);
      strictEqual(r.noop, false);
      // Its completion is held back, as every delivery is while the hold stands.
      deepStrictEqual(r.deliveries.map((d) => d.status), ['blocked']);
      strictEqual((await record(fx)).record.pending.length, 1);
      writeFileSync(child.path, good);
    });
  });
});

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8, item 4 — the note', () => {
  it('an engineer that cannot write a note from a file leaves the delivery pending, and says why', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      const old = mkdtempSync(join(tmpdir(), 'old-engineer-'));
      try {
        mkdirSync(join(old, 'scripts'));
        writeFileSync(join(old, 'scripts/state.mjs'), "const TEXT_FILE_FLAGS = ['original-request'];\n");
        const r = await approve(fx, { engineerRoot: old });
        deepStrictEqual(r.deliveries.map((d) => [d.status, /does not take append --phase-note-file/.test(d.detail)]), [['no-engineer', true]]);
        strictEqual((await record(fx)).record.pending.length, 1);
      } finally {
        rmSync(old, { recursive: true, force: true });
      }
    });
  });

  it('a note the child does not hold after the append is not acknowledged', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      const fake = mkdtempSync(join(tmpdir(), 'silent-engineer-'));
      try {
        mkdirSync(join(fake, 'scripts'));
        writeFileSync(join(fake, 'scripts/state.mjs'), "const TEXT_FILE_FLAGS = ['phase-note'];\nprocess.exit(0);\n");
        const r = await approve(fx, { engineerRoot: fake });
        deepStrictEqual(r.deliveries.map((d) => [d.status, d.detail]), [['failed', 'the child read back does not hold the note as written']]);
        strictEqual((await record(fx)).record.pending.length, 1);
      } finally {
        rmSync(fake, { recursive: true, force: true });
      }
    });
  });

  it('a run\'s delivery is on the run\'s locks while its writer lives, and off them once it exits', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const { deliverAtBoundary } = await import(pathToFileURL(resolve(ORCH, 'adapters/claude/autopilot/rebind-boundary.mjs')).href);
      const held = await acquireLock(macroLockPath(fx.work, fx.macroId), { record: { run_id: 'autopilot-20261021T000000Z-abcdef', pid: process.pid, token_digest: tokenDigest('x') } });
      const calls = [];
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const r = await deliverAtBoundary({
        roots: fx.roots, macroPath: fx.macroPath, macroId: fx.macroId, subtaskId: 'A', repoRoot: fx.work, env: fx.env,
        runId: 'autopilot-20261021T000000Z-abcdef', token: 'x', due: 'pending',
        hold: async (w) => {
          calls.push(['hold', alive(w.pid), w.fingerprint !== null && typeof w.fingerprint === 'object']);
          const g = held.addWorkerGroup(w);
          return [{ release: () => { calls.push(['release', alive(w.pid)]); g.release(); } }];
        },
      });
      held.release();
      ok(r.ok, r.detail);
      deepStrictEqual(calls, [['hold', true, true], ['release', false]]);
      ok(childText(child.path).includes('Owner instruction change ('));
    });
  });

  it('a run\'s delivery writes nothing before it is on the run\'s locks', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      const { deliverAtBoundary } = await import(pathToFileURL(resolve(ORCH, 'adapters/claude/autopilot/rebind-boundary.mjs')).href);
      const held = await acquireLock(macroLockPath(fx.work, fx.macroId), { record: { run_id: 'autopilot-20261021T000000Z-abcdef', pid: process.pid, token_digest: tokenDigest('x') } });
      let early = false;
      const r = await deliverAtBoundary({
        roots: fx.roots, macroPath: fx.macroPath, macroId: fx.macroId, subtaskId: 'A', repoRoot: fx.work, env: fx.env,
        runId: 'autopilot-20261021T000000Z-abcdef', token: 'x', due: 'pending',
        // The registration held back for longer than a delivery takes: a
        // writer that began at its spawn would write its note meanwhile.
        hold: async (w) => {
          for (const until = Date.now() + 3000; Date.now() < until && !early;) {
            early = childText(child.path).includes('Owner instruction change (');
            await new Promise((res) => setTimeout(res, 100));
          }
          const g = held.addWorkerGroup(w);
          return [{ release: () => g.release() }];
        },
      });
      held.release();
      strictEqual(early, false, 'the note was written before its writer was on the run\'s locks');
      ok(r.ok, r.detail);
      ok(childText(child.path).includes('Owner instruction change ('));
    });
  });

  it('rebind-deliver --await-start writes nothing when its stdin closes before the start line', async () => {
    await withRepo(async (fx) => {
      const child = await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      let err = null;
      try {
        execFileSync(process.execPath, [STATE, 'rebind-deliver', '--workflow-path', fx.macroPath, '--host', H, '--engineer-root', ENG, '--await-start'],
          { encoding: 'utf8', env: fx.env, input: '', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        err = e;
      }
      ok(err && /stdin closed before the line "start"/.test(err.stderr), String(err?.stderr));
      ok(!childText(child.path).includes('Owner instruction change'));
      strictEqual((await record(fx)).record.pending.length, 1);
    });
  });

  // A stand-in for the orchestrator's rebind-deliver: once started, it leaves
  // a process of its group behind (the engineer append it runs), which would
  // write after a delay, and exits at once.
  const LEAVES_A_WRITER = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let line = '';
process.stdin.setEncoding('utf8').on('data', (c) => {
  line += c;
  if (!line.includes('\\n')) return;
  const late = spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "late"), 1500)', process.env.FAKE_MARKER], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_PID, String(late.pid));
  process.stdout.write(JSON.stringify({ deliveries: [{ delivery_id: 'd-test', status: 'delivered' }] }) + '\\n');
  process.exit(0);
});
`;
  async function withLeftWriter(fn) {
    const fake = mkdtempSync(join(tmpdir(), 'left-writer-'));
    const pidFile = join(fake, 'pid');
    try {
      mkdirSync(join(fake, 'scripts'));
      writeFileSync(join(fake, 'scripts/state.mjs'), LEAVES_A_WRITER);
      const { deliverAtBoundary } = await import(pathToFileURL(resolve(ORCH, 'adapters/claude/autopilot/rebind-boundary.mjs')).href);
      const marker = join(fake, 'late');
      const deliver = (o) => deliverAtBoundary({
        roots: { orchestrator: fake, engineer: ENG }, macroPath: join(fake, 'macro.md'), macroId: 'macro', subtaskId: 'A', repoRoot: fake,
        env: { ...process.env, FAKE_MARKER: marker, FAKE_PID: pidFile }, runId: 'autopilot-20261021T000000Z-abcdef', token: 'x', due: 'pending', ...o,
      });
      return await fn({ deliver, marker, writerPid: () => Number(readFileSync(pidFile, 'utf8')) });
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone, or never started */ }
      rmSync(fake, { recursive: true, force: true });
    }
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('a run\'s delivery leaves the run\'s locks only once its group is empty: a writer the command left is ended first', async () => {
    await withLeftWriter(async ({ deliver, marker, writerPid }) => {
      const calls = [];
      const r = await deliver({ hold: async () => [{ release: () => calls.push(['release', alive(writerPid())]) }] });
      ok(r.ok, r.detail);
      deepStrictEqual(calls, [['release', false]], 'the locks were released while a process of the delivery\'s group still lived');
      await new Promise((res) => setTimeout(res, 1700));
      strictEqual(existsSync(marker), false, 'a writer of the delivery\'s group wrote after the delivery ended');
    });
  });

  it('a run\'s delivery whose group outlives SIGKILL keeps the run\'s locks and says so', async () => {
    await withLeftWriter(async ({ deliver }) => {
      const calls = [];
      const r = await deliver({
        hold: async () => [{ release: () => calls.push('release') }],
        onLingering: () => calls.push('lingering'),
        terminate: async () => 'lingering',
      });
      deepStrictEqual([r.ok, r.lingering, calls], [false, true, ['lingering']]);
      ok(/still there after SIGKILL; the run keeps its locks/.test(r.detail), r.detail);
    });
  });

  it('words holding a NUL byte refuse the approval', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B \u0000 words' });
      await rejects(() => approve(fx), /hold a NUL byte/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('ADR-0068 Decision 8, item 7 — the other readers of the macro', () => {
  it('the runtime entry brief and dashboard readers, and autopilot observe, read a macro holding a rebinding', async () => {
    await withRepo(async (fx) => {
      await dispatch(fx, 'A');
      await revise(fx, 'A', { topic: 'B words' });
      await approve(fx);
      ok((await fx.readMacro()).plan_rebindings);
      const dashboard = await import(pathToFileURL(resolve(REPO_ROOT, 'plugins/runtime/scripts/dashboard.mjs')).href);
      deepStrictEqual(dashboard.parseMacroSubtasks(macroText(fx)).map((x) => [x.id, x.status]), [['A', 'in_progress'], ['B', 'pending']]);
      const readers = await import(pathToFileURL(resolve(REPO_ROOT, 'plugins/runtime/scripts/lib/entry-brief-readers.mjs')).href);
      const brief = await readers.readMacroSources({ repoRoot: fx.work, branch: 'main' });
      ok(brief.status !== 'indeterminate', JSON.stringify(brief));
      const { observe } = await import(pathToFileURL(resolve(ORCH, 'adapters/claude/autopilot/observe.mjs')).href);
      const v = observe({ repoRoot: fx.work, roots: fx.roots, macroId: fx.macroId, fetch: false, env: fx.env });
      strictEqual(v.macroLookupError, null);
      strictEqual(typeof v.macro.fm.plan_rebindings, 'string');
    });
  });
});

describe('ADR-0068 Decision 8, item 7 — the release before this one', () => {
  const TAG = 'plugin-orchestrator-v0.27.0';

  // A mutation harness copy has no history: its case for this test supplies
  // the tagged scripts under .released/<tag> (scripts/mutation-specs/
  // orchestrator-rebind.mjs), read first.
  function released(dir) {
    const supplied = join(REPO_ROOT, '.released', TAG, 'plugins/orchestrator/scripts/state.mjs');
    if (existsSync(supplied)) return import(pathToFileURL(supplied).href);
    try {
      const tar = execFileSync('git', ['-C', REPO_ROOT, 'archive', TAG, 'plugins/orchestrator/scripts'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', dir], { input: tar });
    } catch {
      return null;
    }
    return import(pathToFileURL(join(dir, 'plugins/orchestrator/scripts/state.mjs')).href);
  }

  it('reads and rewrites a macro holding a rebinding, carrying both keys byte for byte, and never honors it', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-released-'));
    try {
      const old = await released(dir);
      if (old === null) {
        t.skip(`${TAG} is not in this clone`);
        return;
      }
      await withRepo(async (fx) => {
        const child = await dispatch(fx, 'A');
        const expect = await expectOf(child.path);
        await revise(fx, 'A', { topic: 'B words' });
        await approve(fx, { engineerRoot: ENG });
        const keys = (text) => text.match(/^plan_(approval_id|rebindings): .*$/gm);
        const lines = keys(macroText(fx));
        strictEqual(lines.length, 2);
        await old.appendPhase({ workflowPath: fx.macroPath, host: 'codex', phaseLabel: 'n', phaseNote: 'x', event: 'updated' });
        await old.updateSubtask({ workflowPath: fx.macroPath, host: 'codex', subtaskId: 'B', status: 'in_progress', engineerWorkflowId: 'compose-20261020T000000Z-b0b0b0' });
        deepStrictEqual(keys(macroText(fx)), lines);
        const fm = macroText(fx).slice(4, macroText(fx).indexOf('\n---\n')).split('\n');
        deepStrictEqual(fm.slice(-2), lines, 'still the last keys');
        await rejects(() => old.recordEngineerTerminal({ workflowPath: fx.macroPath, host: 'codex', subtaskId: 'A', engineerWorkflowId: child.id, branchCommit: 'abc1234', expectDispatch: expect }),
          /\(dispatch-changed\)/);
        strictEqual((await terminal(fx, 'A', child, expect)).noted, true, 'this release still honors it');
        // Its plan-set clears the stamp's time and hash: the rebinding is suspended.
        await old.setPlan({ workflowPath: fx.macroPath, host: 'codex', subtasks: (await fx.readMacro()).plan.subtasks });
        deepStrictEqual(keys(macroText(fx)), lines);
        await rejects(() => complete(fx, 'A', child, expect), /pending approval/);
        // Its approval of the same plan keeps the id it does not know, with a new time: not honored.
        await new Promise((r) => setTimeout(r, 1100));
        await old.approvePlan({ workflowPath: fx.macroPath, host: 'codex', env: OWNER });
        await rejects(() => complete(fx, 'A', child, expect), /belongs to an earlier approval/);
        await approve(fx, { engineerRoot: ENG });
        strictEqual((await complete(fx, 'A', child, expect)).updatedSubtask.status, 'completed');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
