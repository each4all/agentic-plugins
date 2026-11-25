// C181 (ADR-0023 §6, amendment of 2026-11-24) — the records of a run's own
// scope: what the identity written before the word carries, the state a
// record is in, when two records agree (a teardown aside) and when a peer
// run's handle binds its scope. Pure rules: no process, no file.

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './_personas.mjs';

const S = await import(pathToFileURL(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib/scope.mjs')).href);

const BOOT = 'e55a09fa-13b3-445f-9aa0-4b51e123717f';
const CLOCK = `${BOOT}/time:[4026531834]/pid:[4026531836]`;
const UNIT = 'agentic-launch-plan-verify-20261124T114936Z-701ae6-k3j9.scope';

function identity(over = {}) {
  return {
    owner: { kind: 'peer-run', run_id: 'plan-verify-20261124T114936Z-701ae6' },
    unit: UNIT,
    invocation_id: '0123456789abcdef0123456789abcdef',
    cgroup_path: `/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`,
    cgroup_id: '18446744073709551615',
    boot_id: BOOT,
    gate: { pid: 4242, starttime: '123456', clock: CLOCK },
    supervisor: { pid: 4200, fingerprint: { kind: 'linux_proc_starttime', starttime: '123400' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: true,
    association: null,
    ...over,
  };
}
function handle(over = {}, scopeOver = {}) {
  return { run_id: 'plan-verify-20261124T114936Z-701ae6', scope: { version: 1, state: 'scoped', identity: identity(over), ...scopeOver } };
}

describe('the scope identity', () => {
  it('a whole identity has no problem, with or without an autopilot association', () => {
    deepStrictEqual(S.scopeIdentityProblems(identity()), []);
    deepStrictEqual(S.scopeIdentityProblems(identity({ association: { autopilot_run: 'autopilot-20261124T114307Z-990637', autopilot_step: '3' } })), []);
  });

  it('each written-once field is checked', () => {
    const rows = [
      ['owner', { owner: { kind: 'peer-run' } }],
      ['owner', { owner: { kind: 'other', run_id: 'x' } }],
      ['unit', { unit: 'other-prefix.scope' }],
      ['cgroup_path', { cgroup_path: `/user.slice/${UNIT}` }],
      ['cgroup_path', { cgroup_path: `/user.slice/user@1000.service/../${UNIT}` }],
      ['cgroup_path', { cgroup_path: '/user.slice/user@1000.service/other.scope' }],
      ['invocation_id', { invocation_id: 'XYZ' }],
      ['cgroup_id', { cgroup_id: 18 }],
      ['cgroup_id', { cgroup_id: '18446744073709551616' }],
      ['boot_id', { boot_id: 'nope' }],
      ['gate', { gate: { pid: 0, starttime: '1', clock: CLOCK } }],
      ['gate', { gate: { pid: 5000000, starttime: '1', clock: CLOCK } }],
      ['gate', { gate: { pid: 7, starttime: '1', clock: CLOCK.replace(BOOT, '00000000-0000-0000-0000-000000000000') } }],
      ['supervisor', { supervisor: { pid: 4200, fingerprint: { kind: 'macos_lstart_command' }, clock: CLOCK, boot_id: BOOT } }],
      ['has_snapshot', { has_snapshot: 'yes' }],
      ['association', { association: { autopilot_run: 'r' } }],
    ];
    for (const [field, over] of rows) strictEqual(S.scopeIdentityProblems(identity(over)).includes(field), true, `${field}: ${JSON.stringify(over)}`);
  });
});

describe('the state of a record', () => {
  it('names every state the readers part', () => {
    strictEqual(S.scopeRecordState({ run_id: 'x' }).state, 'legacy-missing');
    strictEqual(S.scopeRecordState({ scope: 'x' }).state, 'malformed');
    strictEqual(S.scopeRecordState({ scope: { version: 2, anything: true } }).state, 'unknown-version');
    deepStrictEqual(S.scopeRecordState({ scope: { version: 1, state: 'none', reason: 'unavailable' } }), { state: 'none', reason: 'unavailable', enclosing_unit: null });
    strictEqual(S.scopeRecordState({ scope: { version: 1, state: 'none', reason: 'inside-launcher' } }).state, 'malformed');
    strictEqual(S.scopeRecordState({ scope: { version: 1, state: 'none', reason: 'inside-launcher', enclosing_unit: UNIT } }).enclosing_unit, UNIT);
    strictEqual(S.scopeRecordState({ scope: { version: 1, state: 'none', reason: 'because' } }).state, 'malformed');
    strictEqual(S.scopeRecordState(handle({}, { state: 'abandoned' })).state, 'abandoned');
    strictEqual(S.scopeRecordState(handle()).state, 'scoped');
    strictEqual(S.scopeRecordState(handle({ unit: 'x' })).state, 'malformed');
    strictEqual(S.scopeRecordState(handle({}, { teardown: { state: 'gone' } })).state, 'malformed');
    strictEqual(S.scopeRecordState(handle({}, { teardown: { state: 'gone', at: '2026-11-24T12:00:00Z' } })).teardown.state, 'gone');
  });

  it('a teardown records the reading and its check', () => {
    deepStrictEqual(S.teardownOf({ state: 'withheld', check: 'modes' }, new Date('2026-11-24T12:00:00.123Z')), { state: 'withheld', at: '2026-11-24T12:00:00Z', check: 'modes' });
    strictEqual(S.validTeardown(S.teardownOf({ state: 'gone' })), true);
  });

  it('the outer parsers let any plain scope object pass', () => {
    strictEqual(S.scopeFieldShaped(undefined), true);
    strictEqual(S.scopeFieldShaped({ version: 9 }), true);
    strictEqual(S.scopeFieldShaped([]), false);
    strictEqual(S.scopeFieldShaped(null), false);
  });
});

describe('two records agree', () => {
  it('on the identity, in any key order, a teardown aside', () => {
    const a = handle();
    const b = { scope: { teardown: { state: 'gone', at: '2026-11-24T12:00:00Z' }, identity: Object.fromEntries(Object.entries(identity()).reverse()), state: 'scoped', version: 1 } };
    strictEqual(S.scopeRecordsAgree(a, b), true);
    strictEqual(S.scopeRecordsAgree(a, handle({ cgroup_id: '17' })), false);
    strictEqual(S.scopeRecordsAgree(a, handle({}, { state: 'abandoned' })), false);
  });
});

describe('a handle binds its scope', () => {
  it('alone where the run has no snapshot', () => {
    strictEqual(S.handleBinds(handle({ has_snapshot: false })).binds, true);
  });

  it('with a snapshot, only while the owner record exists and agrees', () => {
    const h = handle();
    deepStrictEqual(S.handleBinds(h, { outcome: 'read', record: handle() }).binds, true);
    deepStrictEqual(S.handleBinds(h, { outcome: 'absent' }), { binds: false, reason: 'owner-absent', keep: false, identity: identity() });
    deepStrictEqual(S.handleBinds(h, { outcome: 'unreadable', code: 'EACCES' }), { binds: false, reason: 'owner-unreadable', keep: true });
    deepStrictEqual(S.handleBinds(h, { outcome: 'read', record: { pid: 1 } }), { binds: false, reason: 'records-disagree', keep: true });
    strictEqual(S.handleBinds(h).reason, 'owner-unread');
  });

  it('never for a record with no whole scope, or another run\'s', () => {
    strictEqual(S.handleBinds({ run_id: 'x' }).reason, 'legacy-missing');
    deepStrictEqual(S.handleBinds({ run_id: 'x', scope: { version: 7 } }), { binds: false, reason: 'unknown-version', keep: true });
    strictEqual(S.handleBinds(handle({}, { state: 'abandoned' })).reason, 'abandoned');
    strictEqual(S.handleBinds({ ...handle({ has_snapshot: false }), run_id: 'another' }).reason, 'owner-mismatch');
  });
});
