// plugins/orchestrator/scripts/state.mjs — ADR-0063 D6 schema 1.2: the flat
// plan_approval_* and awaiting_owner_* scalars, the plan hash, and the
// approval surface.
//
// Covers:
//   - schema 1.2 emit; a fresh macro carries none of the six keys (absent = null)
//   - computePlanHash: the canonical form, order sensitivity, which fields it
//     covers, and that a written plan hashes like the plan that was written
//   - round-trip of every new key, and the enum / format / co-presence
//     rejections at the parser
//   - plan-set returns the plan to pending approval, revoking an approval and
//     replacing a plan-conflict gate; a conflict verdict opens plan-conflict
//     in the same write; a refused plan-set changes nothing
//   - every approval transition waits for the macro's lock
//   - awaiting-owner-set / -clear on the macro gates, including the one
//     escalation (plan-approval → plan-conflict) and clearing back to
//     plan-approval
//   - plan-approve: expect-hash, the refusals, the no-op re-approval, a
//     legacy macro, a stale approval
//   - the whole transition sequence through the CLI, with every intermediate
//     file re-read under the invariants
//   - next-ready reports approval on every shape; plan-hash
//   - progress writes (subtask-update) leave an approval standing
//   - isAutopilotRun: on only for a well-formed run id
//
// The 1.1-era reader round-trip lives in test-state-schema-forward-compat.mjs.
//
// Run via `node --test tests/orchestrator/test-state-schema-12.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, throws, rejects, deepStrictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  VALID_MACRO_OWNER_GATES,
  createWorkflow,
  readWorkflow,
  withFileLock,
  parseWorkflowFile,
  assembleWorkflowFile,
  setPlan,
  updateSubtask,
  recordEngineerTerminal,
  bulkSubtaskStatus,
  setMacroTerminal,
  computePlanHash,
  planApprovalState,
  approvePlan,
  setAwaitingOwner,
  clearAwaitingOwner,
  isAutopilotRun,
} = await import(STATE_MJS);

const NEW_KEYS = [
  'plan_approval_status',
  'plan_approval_approved_at',
  'plan_approval_plan_hash',
  'awaiting_owner_gate',
  'awaiting_owner_since',
  'awaiting_owner_pointer',
];
const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const HASH_A = 'a'.repeat(64);
const CONFLICT_POINTER = (filePath) =>
  `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#ensemble-synthesis`;
const PLAN_POINTER = (filePath) =>
  `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#macro-plan`;

// No env handed to the code under test may carry an AGENTIC_AUTOPILOT from
// whoever runs the suite (an autopilot worker would), or every owner action
// below would be refused.
function ownerEnv(extra = {}, base = process.env) {
  const env = { ...base };
  delete env.AGENTIC_AUTOPILOT;
  return { ...env, ...extra };
}

function runCli(args, { env = ownerEnv() } = {}) {
  return spawnSync(process.execPath, [STATE_MJS, ...args], { encoding: 'utf8', env });
}

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-schema12-${name}-`));
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASELINE = {
  branch: 'main',
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
};

const st = (id, extra = {}) => ({
  id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status: 'pending', ...extra,
});

async function newMacro(repoRoot) {
  const { filePath } = await createWorkflow({
    repoRoot, verb: 'plan', host: 'claude',
    gitBaseline: BASELINE, originalRequest: 'schema 1.2',
  });
  return filePath;
}

async function plannedMacro(repoRoot, subtasks = [st('A'), st('B', { blocked_by: ['A'], status: 'blocked' })]) {
  const filePath = await newMacro(repoRoot);
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  return filePath;
}

async function fm(filePath) {
  return (await readWorkflow(filePath)).frontmatter;
}

const newKeysOf = (frontmatter) =>
  Object.fromEntries(NEW_KEYS.filter((k) => k in frontmatter).map((k) => [k, frontmatter[k]]));

// A minimal valid 1.2 macro frontmatter for parser tests.
function baseFrontmatter(extra = {}) {
  return {
    schema: '1.2',
    workflow_id: 'macro-plan-20260930T000000Z-abcdef',
    workflow_type: 'macro',
    original_request: 'parser',
    started_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:00:00Z',
    repo_root: '/tmp/x',
    git_baseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    current_phase: 'phase-2-presented',
    next_action: '',
    plan: { subtasks: [st('A')] },
    host_history: [{ host: 'claude', at: '2026-09-30T00:00:00Z', event: 'created' }],
    ...extra,
  };
}

const PENDING = {
  plan_approval_status: 'pending',
  awaiting_owner_gate: 'plan-approval',
  awaiting_owner_since: '2026-09-30T01:00:00Z',
  awaiting_owner_pointer: '.agentic-plugins/state/orchestrator/workflows/m.md#macro-plan',
};
const APPROVED = {
  plan_approval_status: 'approved',
  plan_approval_approved_at: '2026-09-30T02:00:00Z',
  plan_approval_plan_hash: HASH_A,
};

// Serialize without validation (the serializer does not validate the new
// keys), then parse: the parser is the gate under test.
function parseWith(extra) {
  const text = assembleWorkflowFile(baseFrontmatter(extra), '# t\n');
  return parseWorkflowFile(text);
}

describe('schema 1.2 emit', () => {
  it('new macros are created at 1.2 and carry none of the six keys', async () => {
    strictEqual(SCHEMA_VERSION, '1.2');
    await withTmpRepo('emit', async (root) => {
      const filePath = await newMacro(root);
      const frontmatter = await fm(filePath);
      strictEqual(frontmatter.schema, '1.2');
      deepStrictEqual(newKeysOf(frontmatter), {});
      deepStrictEqual(planApprovalState(frontmatter), { status: 'absent', hash_ok: null });
    });
  });

  it('the macro gates are exactly plan-approval and plan-conflict', () => {
    deepStrictEqual([...VALID_MACRO_OWNER_GATES].sort(), ['plan-approval', 'plan-conflict']);
  });
});

describe('computePlanHash', () => {
  it('is sha256 over sorted-key, whitespace-free JSON of the projected subtasks', () => {
    // Written out by hand: keys sorted, no spaces, progress fields dropped.
    const canonical =
      '[{"blocked_by":[],"branch":"feat/a","id":"A","label":"first","verb":"compose"},' +
      '{"blocked_by":["A"],"branch":"feat/b","id":"B","profile":"backend","topic":"t \\"q\\"","verb":"refine"}]';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const hash = computePlanHash([
      { status: 'completed', verb: 'compose', id: 'A', branch: 'feat/a', blocked_by: [], label: 'first',
        engineer_workflow_id: 'compose-x', commit: 'abc', pr_url: 'https://x/pull/1', closed_at: '2026-09-30T00:00:00Z' },
      { topic: 't "q"', profile: 'backend', id: 'B', verb: 'refine', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
    ]);
    strictEqual(hash, expected);
    ok(/^[0-9a-f]{64}$/.test(hash));
  });

  it('is order-sensitive over subtasks and over blocked_by', () => {
    const a = st('A');
    const b = st('B');
    notStrictEqual(computePlanHash([a, b]), computePlanHash([b, a]));
    notStrictEqual(
      computePlanHash([st('C', { blocked_by: ['A', 'B'] })]),
      computePlanHash([st('C', { blocked_by: ['B', 'A'] })]),
    );
  });

  it('ignores progress fields and key order; null reads as absent', () => {
    const base = computePlanHash([st('A')]);
    strictEqual(computePlanHash([st('A', {
      status: 'in_progress', engineer_workflow_id: 'compose-1', commit: 'c', pr_url: 'u', closed_at: 'z',
    })]), base);
    strictEqual(computePlanHash([{ status: 'pending', blocked_by: [], branch: 'feat/a', verb: 'compose', id: 'A' }]), base);
    strictEqual(computePlanHash([st('A', { label: null, profile: undefined, topic: null })]), base);
  });

  it('changes when any covered field changes', () => {
    const base = computePlanHash([st('A')]);
    for (const [key, value] of [
      ['id', 'Z'], ['label', 'x'], ['branch', 'feat/z'], ['blocked_by', ['Q']],
      ['verb', 'refine'], ['profile', 'backend'], ['topic', 'x'],
    ]) {
      notStrictEqual(computePlanHash([st('A', { [key]: value })]), base, `${key} must be covered`);
    }
    notStrictEqual(computePlanHash([st('A', { label: '' })]), base, 'an empty label is written, so it is covered');
  });

  it('rejects a non-array and a non-object subtask', () => {
    throws(() => computePlanHash(null), /must be an array/);
    throws(() => computePlanHash(['A']), /subtasks\[0\] must be an object/);
  });

  it('a written plan hashes like the plan that was written', async () => {
    await withTmpRepo('hash-roundtrip', async (root) => {
      const subtasks = [
        st('A', { label: 'first', topic: 'a topic, with "quotes"', profile: null }),
        st('B', { blocked_by: ['A'], status: 'blocked', profile: 'backend' }),
      ];
      const filePath = await plannedMacro(root, subtasks);
      strictEqual(computePlanHash((await fm(filePath)).plan.subtasks), computePlanHash(subtasks));
    });
  });
});

describe('parser — the six keys', () => {
  it('round-trips a pending and an approved state', () => {
    for (const extra of [PENDING, APPROVED]) {
      const parsed = parseWith(extra);
      deepStrictEqual(newKeysOf(parsed.frontmatter), extra);
      const again = parseWorkflowFile(assembleWorkflowFile(parsed.frontmatter, parsed.body));
      deepStrictEqual(newKeysOf(again.frontmatter), extra);
    }
  });

  it('places the keys at the tail, after terminal_marker, in order', () => {
    const text = assembleWorkflowFile(baseFrontmatter({ terminal_marker: false, ...PENDING }), '# t\n');
    const keys = text.split('\n---\n')[0].split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    deepStrictEqual(keys.slice(-5), ['terminal_marker', 'plan_approval_status', 'awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer']);
    const approvedText = assembleWorkflowFile(baseFrontmatter({ terminal_marker: false, ...APPROVED }), '# t\n');
    const approvedKeys = approvedText.split('\n---\n')[0].split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    deepStrictEqual(approvedKeys.slice(-4), ['terminal_marker', 'plan_approval_status', 'plan_approval_approved_at', 'plan_approval_plan_hash']);
  });

  const REJECTIONS = [
    ['unknown status', { ...PENDING, plan_approval_status: 'rejected' }, /plan_approval_status must be one of/],
    ['approved without approved_at', { plan_approval_status: 'approved', plan_approval_plan_hash: HASH_A }, /plan_approval_approved_at must be present exactly when/],
    ['approved without plan_hash', { plan_approval_status: 'approved', plan_approval_approved_at: '2026-09-30T02:00:00Z' }, /plan_approval_plan_hash must be present exactly when/],
    ['pending with a hash', { ...PENDING, plan_approval_plan_hash: HASH_A }, /plan_approval_plan_hash must be present exactly when/],
    ['pending with approved_at', { ...PENDING, plan_approval_approved_at: '2026-09-30T02:00:00Z' }, /plan_approval_approved_at must be present exactly when/],
    ['approved_at without status', { plan_approval_approved_at: '2026-09-30T02:00:00Z' }, /plan_approval_approved_at must be present exactly when/],
    ['uppercase hash', { ...APPROVED, plan_approval_plan_hash: 'A'.repeat(64) }, /64 lowercase hex/],
    ['short hash', { ...APPROVED, plan_approval_plan_hash: 'a'.repeat(63) }, /64 lowercase hex/],
    ['approved_at with millis', { ...APPROVED, plan_approval_approved_at: '2026-09-30T02:00:00.000Z' }, /plan_approval_approved_at must be an ISO-8601/],
    ['impossible approved_at', { ...APPROVED, plan_approval_approved_at: '2026-02-30T02:00:00Z' }, /plan_approval_approved_at must be an ISO-8601/],
    ['partial awaiting_owner', { plan_approval_status: 'pending', awaiting_owner_gate: 'plan-approval', awaiting_owner_since: '2026-09-30T01:00:00Z' }, /present all or none/],
    ['engineer gate on the macro', { ...PENDING, awaiting_owner_gate: 'decide-conflict' }, /awaiting_owner_gate must be one of plan-approval, plan-conflict/],
    ['bad since', { ...PENDING, awaiting_owner_since: 'yesterday' }, /awaiting_owner_since must be an ISO-8601/],
    ['absolute pointer', { ...PENDING, awaiting_owner_pointer: '/abs/m.md#macro-plan' }, /awaiting_owner_pointer must be a repo-relative/],
    ['pointer with ..', { ...PENDING, awaiting_owner_pointer: 'a/../m.md#macro-plan' }, /awaiting_owner_pointer must be a repo-relative/],
    ['pointer without anchor', { ...PENDING, awaiting_owner_pointer: 'a/m.md' }, /awaiting_owner_pointer must be a repo-relative/],
    ['pointer with a space', { ...PENDING, awaiting_owner_pointer: 'a/m m.md#x' }, /awaiting_owner_pointer must be a repo-relative/],
    ['pending without a gate', { plan_approval_status: 'pending' }, /a pending plan waits on awaiting_owner_gate/],
    ['a gate on an approved plan', { ...APPROVED, awaiting_owner_gate: 'plan-approval', awaiting_owner_since: '2026-09-30T01:00:00Z', awaiting_owner_pointer: 'a.md#b' }, /a pending plan waits on awaiting_owner_gate/],
    ['a gate without a status', { awaiting_owner_gate: 'plan-conflict', awaiting_owner_since: '2026-09-30T01:00:00Z', awaiting_owner_pointer: 'a.md#b' }, /a pending plan waits on awaiting_owner_gate/],
  ];
  for (const [name, extra, pattern] of REJECTIONS) {
    it(`rejects ${name}`, () => {
      throws(() => parseWith(extra), pattern);
    });
  }
});

describe('plan-set returns the plan to pending approval', () => {
  it('a first plan-set opens the plan-approval gate, pointing at the plan', async () => {
    await withTmpRepo('planset-first', async (root) => {
      const filePath = await newMacro(root);
      const now = new Date('2026-09-30T03:04:05Z');
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')], now });
      deepStrictEqual(newKeysOf(await fm(filePath)), {
        plan_approval_status: 'pending',
        awaiting_owner_gate: 'plan-approval',
        awaiting_owner_since: '2026-09-30T03:04:05Z',
        awaiting_owner_pointer: PLAN_POINTER(filePath),
      });
      const body = await readFile(filePath, 'utf8');
      ok(body.includes('Plan approval: pending (awaiting_owner_gate=plan-approval).\n'));
    });
  });

  it('revokes an approval, and says so', async () => {
    await withTmpRepo('planset-revoke', async (root) => {
      const filePath = await plannedMacro(root);
      const { planHash } = await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv(), now: new Date('2026-09-30T04:00:00Z') });
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A'), st('C')], now: new Date('2026-09-30T05:00:00Z') });
      const after = await fm(filePath);
      deepStrictEqual(newKeysOf(after), {
        plan_approval_status: 'pending',
        awaiting_owner_gate: 'plan-approval',
        awaiting_owner_since: '2026-09-30T05:00:00Z',
        awaiting_owner_pointer: PLAN_POINTER(filePath),
      });
      const text = await readFile(filePath, 'utf8');
      ok(text.includes(`Revoked the approval of 2026-09-30T04:00:00Z (hash ${planHash.slice(0, 12)}).`));
    });
  });

  it('revokes even when the covered fields are unchanged — any plan write needs a new approval', async () => {
    await withTmpRepo('planset-same', async (root) => {
      const subtasks = [st('A')];
      const filePath = await plannedMacro(root, subtasks);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
      strictEqual((await fm(filePath)).plan_approval_status, 'pending');
    });
  });

  it('replaces a plan-conflict gate', async () => {
    await withTmpRepo('planset-conflict', async (root) => {
      const filePath = await plannedMacro(root);
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath), since: '2026-09-30T06:00:00Z' });
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')] });
      const after = await fm(filePath);
      strictEqual(after.awaiting_owner_gate, 'plan-approval');
      strictEqual(after.awaiting_owner_pointer, PLAN_POINTER(filePath));
      ok((await readFile(filePath, 'utf8')).includes('Replaced the plan-conflict gate set at 2026-09-30T06:00:00Z.'));
    });
  });

  it('a refused plan-set (terminal macro) leaves the approval as it was', async () => {
    await withTmpRepo('planset-terminal', async (root) => {
      const filePath = await plannedMacro(root);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'finalized' });
      const before = await readFile(filePath, 'utf8');
      await rejects(() => setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('Z')] }), /terminal macro is not revised/);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('keeps a 1.1 file at schema 1.1 when it gains the keys', async () => {
    await withTmpRepo('planset-11', async (root) => {
      const filePath = await newMacro(root);
      const raw = await readFile(filePath, 'utf8');
      const downgraded = raw.replace(/^schema: "1\.2"$/m, 'schema: "1.1"');
      ok(downgraded !== raw);
      await writeFile(filePath, downgraded);
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')] });
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      const after = await fm(filePath);
      strictEqual(after.schema, '1.1');
      strictEqual(after.plan_approval_status, 'approved');
    });
  });

  it('a conflict verdict opens plan-conflict in the same write, and the plan is never approvable', async () => {
    await withTmpRepo('planset-verdict', async (root) => {
      const filePath = await newMacro(root);
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')], verdict: 'conflict', now: new Date('2026-09-30T03:30:00Z') });
      deepStrictEqual(newKeysOf(await fm(filePath)), {
        plan_approval_status: 'pending',
        awaiting_owner_gate: 'plan-conflict',
        awaiting_owner_since: '2026-09-30T03:30:00Z',
        awaiting_owner_pointer: CONFLICT_POINTER(filePath),
      });
      ok((await readFile(filePath, 'utf8')).includes('Plan approval: pending (awaiting_owner_gate=plan-conflict: the Plan-verify ensemble reported a conflict).'));
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() }), /Plan-verify ensemble reported a conflict/);
      // The revision the owner writes next is verified again; its verdict decides.
      for (const verdict of ['pass', 'concerns', undefined]) {
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')], verdict: 'conflict' });
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')], verdict });
        strictEqual((await fm(filePath)).awaiting_owner_gate, 'plan-approval', String(verdict));
      }
    });
  });

  it('refuses an unknown verdict before touching the file', async () => {
    await withTmpRepo('planset-bad-verdict', async (root) => {
      const filePath = await plannedMacro(root);
      const before = await readFile(filePath, 'utf8');
      for (const verdict of ['agree', '', 'CONFLICT']) {
        await rejects(() => setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')], verdict }), /verdict must be one of pass, concerns, conflict/);
      }
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('points into the legacy home for a legacy macro', async () => {
    await withTmpRepo('planset-legacy', async (root) => {
      const legacyDir = join(root, '.claude/agentic-orchestrator/workflows');
      await mkdir(legacyDir, { recursive: true });
      const id = 'macro-plan-20260930T000000Z-abcdef';
      const filePath = join(legacyDir, `${id}.md`);
      await writeFile(filePath, assembleWorkflowFile(baseFrontmatter({ workflow_id: id, repo_root: root, plan: { subtasks: [] } }), '# legacy\n'));
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')] });
      strictEqual((await fm(filePath)).awaiting_owner_pointer, `.claude/agentic-orchestrator/workflows/${id}.md#macro-plan`);
    });
  });
});

describe('awaiting-owner-set / -clear on the macro', () => {
  it('raises plan-approval to plan-conflict, and re-setting it replaces pointer and since', async () => {
    await withTmpRepo('set-escalate', async (root) => {
      const filePath = await plannedMacro(root);
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath), now: new Date('2026-09-30T07:00:00Z') });
      let after = await fm(filePath);
      strictEqual(after.awaiting_owner_gate, 'plan-conflict');
      strictEqual(after.awaiting_owner_since, '2026-09-30T07:00:00Z');
      strictEqual(after.plan_approval_status, 'pending');
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: 'x/y.md#z', since: '2026-09-30T08:00:00Z' });
      after = await fm(filePath);
      strictEqual(after.awaiting_owner_pointer, 'x/y.md#z');
      strictEqual(after.awaiting_owner_since, '2026-09-30T08:00:00Z');
    });
  });

  it('re-setting plan-approval replaces its pointer; plan-approval is not set over plan-conflict', async () => {
    await withTmpRepo('set-same', async (root) => {
      const filePath = await plannedMacro(root);
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-approval', pointer: 'p/q.md#r', since: '2026-09-30T09:00:00Z' });
      strictEqual((await fm(filePath)).awaiting_owner_pointer, 'p/q.md#r');
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath) });
      const before = await readFile(filePath, 'utf8');
      await rejects(
        () => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-approval', pointer: 'p/q.md#r' }),
        /owner gate plan-conflict is set on this macro; plan-approval is not set over it/,
      );
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('is refused on a plan that is not pending: absent, or approved', async () => {
    await withTmpRepo('set-not-pending', async (root) => {
      const bare = await newMacro(root);
      await rejects(
        () => setAwaitingOwner({ workflowPath: bare, host: 'claude', gate: 'plan-conflict', pointer: 'a.md#b' }),
        /plan_approval_status is absent/,
      );
    });
    await withTmpRepo('set-approved', async (root) => {
      const filePath = await plannedMacro(root);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      for (const gate of ['plan-approval', 'plan-conflict']) {
        await rejects(
          () => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate, pointer: 'a.md#b' }),
          /plan_approval_status is approved/,
        );
      }
    });
  });

  it('refuses an engineer gate and a bad pointer before touching the file', async () => {
    await withTmpRepo('set-invalid', async (root) => {
      const filePath = await plannedMacro(root);
      const before = await readFile(filePath, 'utf8');
      await rejects(() => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'decide-conflict', pointer: 'a.md#b' }), /must be one of plan-approval, plan-conflict/);
      await rejects(() => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: '/abs.md#b' }), /repo-relative/);
      await rejects(() => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: 'a.md#b', since: '2026-09-30' }), /ISO-8601/);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('clearing plan-conflict returns the plan to plan-approval and records the resolution', async () => {
    await withTmpRepo('clear-conflict', async (root) => {
      const filePath = await plannedMacro(root);
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath), since: '2026-09-30T10:00:00Z' });
      await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: ownerEnv(), now: new Date('2026-09-30T11:00:00Z') });
      deepStrictEqual(newKeysOf(await fm(filePath)), {
        plan_approval_status: 'pending',
        awaiting_owner_gate: 'plan-approval',
        awaiting_owner_since: '2026-09-30T11:00:00Z',
        awaiting_owner_pointer: PLAN_POINTER(filePath),
      });
      const text = await readFile(filePath, 'utf8');
      ok(text.includes('### Owner gate resolved: plan-conflict at 2026-09-30T11:00:00Z\n\n'));
      ok(text.includes(`Cleared awaiting_owner (since 2026-09-30T10:00:00Z, pointer ${CONFLICT_POINTER(filePath)}).`));
    });
  });

  it('refuses to clear plan-approval, a gate that is not set, and a gate that is not the one set', async () => {
    await withTmpRepo('clear-refusals', async (root) => {
      const filePath = await plannedMacro(root);
      const before = await readFile(filePath, 'utf8');
      await rejects(() => clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-approval', env: ownerEnv() }), /resolved by approving the plan/);
      await rejects(() => clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: ownerEnv() }), /the owner gate set on this macro is plan-approval, not plan-conflict/);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
    await withTmpRepo('clear-none', async (root) => {
      const bare = await newMacro(root);
      await rejects(() => clearAwaitingOwner({ workflowPath: bare, host: 'claude', gate: 'plan-conflict', env: ownerEnv() }), /no owner gate is set on this macro/);
    });
  });

  it('refuses to clear under an autopilot run, and a malformed AGENTIC_AUTOPILOT is not one', async () => {
    await withTmpRepo('clear-autopilot', async (root) => {
      const filePath = await plannedMacro(root);
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath) });
      const before = await readFile(filePath, 'utf8');
      await rejects(
        () => clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: ownerEnv({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }) }),
        /refused under autopilot/,
      );
      strictEqual(await readFile(filePath, 'utf8'), before);
      await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: ownerEnv({ AGENTIC_AUTOPILOT: 'yes' }) });
      strictEqual((await fm(filePath)).awaiting_owner_gate, 'plan-approval');
    });
  });
});

describe('plan-approve', () => {
  it('approves the plan as read, records the hash and time, removes the gate and notes it', async () => {
    await withTmpRepo('approve', async (root) => {
      const filePath = await plannedMacro(root);
      const expected = computePlanHash((await fm(filePath)).plan.subtasks);
      const r = await approvePlan({ workflowPath: filePath, host: 'claude', expectHash: expected, env: ownerEnv(), now: new Date('2026-09-30T12:00:00Z') });
      strictEqual(r.planHash, expected);
      strictEqual(r.noop, false);
      const after = await fm(filePath);
      deepStrictEqual(newKeysOf(after), {
        plan_approval_status: 'approved',
        plan_approval_approved_at: '2026-09-30T12:00:00Z',
        plan_approval_plan_hash: expected,
      });
      deepStrictEqual(planApprovalState(after), { status: 'approved', hash_ok: true });
      const text = await readFile(filePath, 'utf8');
      ok(text.includes(`### Plan approved at 2026-09-30T12:00:00Z (hash ${expected.slice(0, 12)})\n\n2 subtasks: A, B.`));
      strictEqual(after.host_history.at(-1).event, 'updated');
    });
  });

  it('refuses a mismatched or malformed --expect-hash without writing', async () => {
    await withTmpRepo('approve-expect', async (root) => {
      const filePath = await plannedMacro(root);
      const before = await readFile(filePath, 'utf8');
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', expectHash: HASH_A, env: ownerEnv() }), /the plan changed since it was shown/);
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', expectHash: 'abc', env: ownerEnv() }), /64 lowercase hex/);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('refuses under autopilot, while plan-conflict is set, on an empty plan and on a terminal macro', async () => {
    await withTmpRepo('approve-refusals', async (root) => {
      const filePath = await plannedMacro(root);
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }) }), /refused under autopilot/);
      await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath) });
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() }), /Plan-verify ensemble reported a conflict/);
      await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: ownerEnv() });
      await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() }), /this macro is terminal/);
    });
    await withTmpRepo('approve-empty', async (root) => {
      const filePath = await plannedMacro(root, []);
      await rejects(() => approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() }), /no subtasks to approve/);
    });
  });

  it('approving the same hash again writes nothing', async () => {
    await withTmpRepo('approve-noop', async (root) => {
      const filePath = await plannedMacro(root);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      const before = await readFile(filePath, 'utf8');
      const r = await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      strictEqual(r.noop, true);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('re-approves a stale approval (a hash that no longer matches) and notes what it replaced', async () => {
    await withTmpRepo('approve-stale', async (root) => {
      const filePath = await plannedMacro(root);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv(), now: new Date('2026-09-30T13:00:00Z') });
      // A writer that does not know the keys (a 1.1 orchestrator) changed the
      // plan and carried the approval through.
      const raw = await readFile(filePath, 'utf8');
      const stale = raw.replace(/^plan_approval_plan_hash: ".*"$/m, `plan_approval_plan_hash: "${HASH_A}"`);
      ok(stale !== raw);
      await writeFile(filePath, stale);
      deepStrictEqual(planApprovalState(await fm(filePath)), { status: 'approved', hash_ok: false });
      const r = await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv(), now: new Date('2026-09-30T14:00:00Z') });
      strictEqual(r.noop, false);
      deepStrictEqual(planApprovalState(await fm(filePath)), { status: 'approved', hash_ok: true });
      ok((await readFile(filePath, 'utf8')).includes(`Replaces the approval of 2026-09-30T13:00:00Z (hash ${HASH_A.slice(0, 12)})`));
    });
  });

  it('approves a macro no 1.2 writer has planned', async () => {
    await withTmpRepo('approve-legacy', async (root) => {
      const filePath = await newMacro(root);
      const raw = await readFile(filePath, 'utf8');
      // A plan written by a 1.1 orchestrator: subtasks, no approval keys.
      const parsed = parseWorkflowFile(raw);
      parsed.frontmatter.plan = { subtasks: [st('A')] };
      await writeFile(filePath, assembleWorkflowFile(parsed.frontmatter, parsed.body));
      deepStrictEqual(planApprovalState(await fm(filePath)), { status: 'absent', hash_ok: null });
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      deepStrictEqual(planApprovalState(await fm(filePath)), { status: 'approved', hash_ok: true });
    });
  });

  it('progress writes leave an approval standing', async () => {
    await withTmpRepo('approve-progress', async (root) => {
      const filePath = await plannedMacro(root);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      await updateSubtask({ workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'in_progress', engineerWorkflowId: 'compose-20260930T000000Z-aaaaaa' });
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'completed',
        engineerWorkflowId: 'compose-20260930T000000Z-aaaaaa', commit: 'abc1234', closedAt: '2026-09-30T15:00:00Z',
      });
      const after = await fm(filePath);
      strictEqual(after.plan.subtasks[1].status, 'pending', 'B was unblocked');
      deepStrictEqual(planApprovalState(after), { status: 'approved', hash_ok: true });

      // The engineer terminal note, and finalize's bulk transition.
      const approvedKeys = newKeysOf(after);
      const r = await recordEngineerTerminal({
        workflowPath: filePath, host: 'claude', subtaskId: 'B',
        engineerWorkflowId: 'refine-20260930T000000Z-eeeeee', branchCommit: 'def5678',
      });
      ok(!r.skipped, 'the note was written');
      deepStrictEqual(newKeysOf(await fm(filePath)), approvedKeys);
      const bulk = await bulkSubtaskStatus({ workflowPath: filePath, host: 'claude', fromStatuses: ['in_progress'], toStatus: 'deferred' });
      deepStrictEqual(bulk.transitionedIds, ['B']);
      deepStrictEqual(newKeysOf(await fm(filePath)), approvedKeys);
    });
  });
});

describe('every approval transition waits for the macro lock', () => {
  // Hold the macro's lock, start the transition, and check that nothing is
  // written until the lock is released. A transition that skipped the lock
  // would have written while it was held.
  async function whileLocked(filePath, start) {
    let pending;
    let during;
    await withFileLock(filePath, async () => {
      pending = start();
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      during = await readFile(filePath, 'utf8');
    });
    await pending;
    return during;
  }

  it('plan-approve', async () => {
    await withTmpRepo('lock-approve', async (root) => {
      const filePath = await plannedMacro(root);
      const before = await readFile(filePath, 'utf8');
      const during = await whileLocked(filePath, () => approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() }));
      strictEqual(during, before);
      strictEqual((await fm(filePath)).plan_approval_status, 'approved');
    });
  });

  it('awaiting-owner-set and awaiting-owner-clear', async () => {
    await withTmpRepo('lock-gates', async (root) => {
      const filePath = await plannedMacro(root);
      let before = await readFile(filePath, 'utf8');
      let during = await whileLocked(filePath, () => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', pointer: CONFLICT_POINTER(filePath) }));
      strictEqual(during, before);
      strictEqual((await fm(filePath)).awaiting_owner_gate, 'plan-conflict');
      before = await readFile(filePath, 'utf8');
      during = await whileLocked(filePath, () => clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: ownerEnv() }));
      strictEqual(during, before);
      strictEqual((await fm(filePath)).awaiting_owner_gate, 'plan-approval');
    });
  });
});

describe('the whole transition sequence, through the CLI', () => {
  it('plan-set → plan-conflict → approve refused → clear → approve → plan-set → approve', async () => {
    await withTmpRepo('sequence', async (root) => {
      const filePath = await newMacro(root);
      const subtasksFile = join(root, 'subtasks.json');
      await writeFile(subtasksFile, JSON.stringify([st('A'), st('B', { blocked_by: ['A'], status: 'blocked' })]));
      const states = [];
      const step = async (args, { status = 0, env } = {}) => {
        const r = runCli(args, env ? { env } : undefined);
        strictEqual(r.status, status, `${args[0]} exit ${r.status}: ${r.stderr}`);
        // Every intermediate file parses: the invariants hold at each step.
        const frontmatter = parseWorkflowFile(await readFile(filePath, 'utf8')).frontmatter;
        states.push([args[0], frontmatter.plan_approval_status, frontmatter.awaiting_owner_gate ?? null]);
        return r;
      };
      const wp = ['--workflow-path', filePath, '--host', 'claude'];

      await step(['plan-set', ...wp, '--subtasks-json-file', subtasksFile]);
      await step(['awaiting-owner-set', ...wp, '--gate', 'plan-conflict', '--pointer', CONFLICT_POINTER(filePath)]);
      let r = await step(['plan-approve', ...wp], { status: 1 });
      ok(r.stderr.includes('Plan-verify ensemble reported a conflict'));
      r = await step(['awaiting-owner-clear', ...wp, '--gate', 'plan-conflict'], { status: 1, env: ownerEnv({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }) });
      ok(r.stderr.includes('refused under autopilot'));
      await step(['awaiting-owner-clear', ...wp, '--gate', 'plan-conflict']);
      const shown = JSON.parse((await step(['plan-hash', '--workflow-path', filePath])).stdout);
      r = await step(['plan-approve', ...wp, '--expect-hash', shown.plan_hash]);
      deepStrictEqual(Object.keys(JSON.parse(r.stdout)).sort(), ['approved_at', 'plan_hash', 'workflowPath']);
      strictEqual(JSON.parse(r.stdout).plan_hash, shown.plan_hash);
      r = await step(['plan-approve', ...wp, '--expect-hash', shown.plan_hash]);
      strictEqual(JSON.parse(r.stdout).noop, true);
      await writeFile(subtasksFile, JSON.stringify([st('A'), st('B', { blocked_by: ['A'], status: 'blocked', topic: 'revised' })]));
      await step(['plan-set', ...wp, '--subtasks-json-file', subtasksFile]);
      r = await step(['plan-approve', ...wp, '--expect-hash', shown.plan_hash], { status: 1 });
      ok(r.stderr.includes('the plan changed since it was shown'));
      await step(['plan-approve', ...wp]);

      deepStrictEqual(states, [
        ['plan-set', 'pending', 'plan-approval'],
        ['awaiting-owner-set', 'pending', 'plan-conflict'],
        ['plan-approve', 'pending', 'plan-conflict'],
        ['awaiting-owner-clear', 'pending', 'plan-conflict'],
        ['awaiting-owner-clear', 'pending', 'plan-approval'],
        ['plan-hash', 'pending', 'plan-approval'],
        ['plan-approve', 'approved', null],
        ['plan-approve', 'approved', null],
        ['plan-set', 'pending', 'plan-approval'],
        ['plan-approve', 'pending', 'plan-approval'],
        ['plan-approve', 'approved', null],
      ]);
    });
  });

  it('plan-set --verdict conflict holds the plan at plan-conflict; an empty --verdict is refused', async () => {
    await withTmpRepo('cli-verdict', async (root) => {
      const filePath = await newMacro(root);
      const subtasksFile = join(root, 'subtasks.json');
      await writeFile(subtasksFile, JSON.stringify([st('A')]));
      const wp = ['--workflow-path', filePath, '--host', 'claude', '--subtasks-json-file', subtasksFile];
      let r = runCli(['plan-set', ...wp, '--verdict', 'conflict']);
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await fm(filePath)).awaiting_owner_gate, 'plan-conflict');
      r = runCli(['plan-approve', '--workflow-path', filePath, '--host', 'claude']);
      strictEqual(r.status, 1);
      const before = await readFile(filePath, 'utf8');
      r = runCli(['plan-set', ...wp, '--verdict', '']);
      strictEqual(r.status, 1);
      ok(r.stderr.includes('verdict must be one of'), r.stderr);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('plan-approve under autopilot exits 1 and writes nothing', async () => {
    await withTmpRepo('cli-autopilot', async (root) => {
      const filePath = await plannedMacro(root);
      const before = await readFile(filePath, 'utf8');
      const r = runCli(['plan-approve', '--workflow-path', filePath, '--host', 'claude'], { env: ownerEnv({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }) });
      strictEqual(r.status, 1);
      ok(r.stderr.includes('refused under autopilot'));
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });
});

describe('next-ready and plan-hash report approval', () => {
  const nextReady = (filePath) => {
    const r = runCli(['next-ready', '--workflow-path', filePath]);
    strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  it('on every shape: empty_plan, ready, in_progress_or_blocked, all_terminal', async () => {
    await withTmpRepo('nr-shapes', async (root) => {
      const filePath = await newMacro(root);
      let out = nextReady(filePath);
      strictEqual(out.reason, 'empty_plan');
      deepStrictEqual(out.approval, { status: 'absent', hash_ok: null });

      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A')] });
      out = nextReady(filePath);
      strictEqual(out.ready.id, 'A');
      deepStrictEqual(out.approval, { status: 'pending', hash_ok: null });

      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      await updateSubtask({ workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'in_progress', engineerWorkflowId: 'compose-20260930T000000Z-bbbbbb' });
      out = nextReady(filePath);
      strictEqual(out.reason, 'in_progress_or_blocked');
      deepStrictEqual(out.approval, { status: 'approved', hash_ok: true });

      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'completed',
        engineerWorkflowId: 'compose-20260930T000000Z-bbbbbb', commit: 'abc1234', closedAt: '2026-09-30T16:00:00Z',
      });
      out = nextReady(filePath);
      strictEqual(out.reason, 'all_terminal');
      deepStrictEqual(out.approval, { status: 'approved', hash_ok: true });
    });
  });

  it('reports hash_ok false when the approved hash no longer matches the plan', async () => {
    await withTmpRepo('nr-mismatch', async (root) => {
      const filePath = await plannedMacro(root);
      await approvePlan({ workflowPath: filePath, host: 'claude', env: ownerEnv() });
      const raw = await readFile(filePath, 'utf8');
      await writeFile(filePath, raw.replace(/^plan_approval_plan_hash: ".*"$/m, `plan_approval_plan_hash: "${HASH_A}"`));
      deepStrictEqual(nextReady(filePath).approval, { status: 'approved', hash_ok: false });
    });
  });

  it('plan-hash prints the hash, the projection it covers, and the approval state', async () => {
    await withTmpRepo('plan-hash', async (root) => {
      const filePath = await plannedMacro(root, [st('A', { label: 'first', status: 'in_progress', engineer_workflow_id: 'compose-20260930T000000Z-cccccc' })]);
      const r = runCli(['plan-hash', '--workflow-path', filePath]);
      strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      strictEqual(out.plan_hash, computePlanHash((await fm(filePath)).plan.subtasks));
      deepStrictEqual(out.subtasks, [{ id: 'A', label: 'first', branch: 'feat/a', blocked_by: [], verb: 'compose' }]);
      deepStrictEqual(out.approval, { status: 'pending', hash_ok: null });
      strictEqual(out.approved_at, null);
      strictEqual(out.awaiting_owner_gate, 'plan-approval');
      strictEqual(out.awaiting_owner_pointer, PLAN_POINTER(filePath));
    });
  });
});

describe('test controls', () => {
  it('the owner env drops an AGENTIC_AUTOPILOT the runner carries', () => {
    const planted = { PATH: '/usr/bin', AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
    const env = ownerEnv({}, planted);
    strictEqual('AGENTIC_AUTOPILOT' in env, false);
    strictEqual(env.PATH, '/usr/bin');
    strictEqual(ownerEnv({ AGENTIC_AUTOPILOT: 'x' }, planted).AGENTIC_AUTOPILOT, 'x');
  });
});

describe('isAutopilotRun', () => {
  it('is on only for a well-formed run id', () => {
    strictEqual(isAutopilotRun({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }), true);
    for (const value of [undefined, '', '1', 'true', 'autopilot', `${AUTOPILOT_RUN_ID}x`, ` ${AUTOPILOT_RUN_ID}`,
      'autopilot-20260930T010203Z-ABCDEF', 'autopilot-20260930T0102Z-abcdef']) {
      strictEqual(isAutopilotRun({ AGENTIC_AUTOPILOT: value }), false, JSON.stringify(value));
    }
    strictEqual(isAutopilotRun({}), false);
    strictEqual(isAutopilotRun(undefined), false);
  });
});
