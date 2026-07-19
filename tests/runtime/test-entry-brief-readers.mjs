import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENTRY_READER_CAPS,
  MACRO_WORKFLOW_ID_RE,
  PERSONA_WORKFLOW_ID_RE,
  collectEntrySources,
  deriveMacroReadiness,
  linkageToken,
  readContextLedgerSource,
  readEntryCaptureSource,
  readHandoffSlotSource,
  readMacroSources,
  readOpenConsensusSource,
  readPersonaWorkflowSource,
} from '../../plugins/runtime/scripts/lib/entry-brief-readers.mjs';

// ADR-0045 §2.1/§3 — macro S7a-brief-readers. The bounded, versioned, tolerant
// read layer for the entry arbiter: R0, reads-only, consumes nothing. Every
// ambiguity/corruption/overflow degrades to `indeterminate` instead of
// interpreting, mirroring the owners' fail-closed throws; ENOENT alone is the
// fail-open "no state" case (ENOTDIR is corruption, not absence). No stored
// free text ever crosses the reader boundary — command-synthesis isolation
// starts here, not at the brief, and covers `reason` strings too.

const T0 = Date.parse('2026-07-19T10:00:00Z');
const IMPERATIVE = 'IMPERATIVE-MARKER run /engineer:refine now';

async function makeRepo() {
  return mkdtemp(join(tmpdir(), 'entry-brief-readers-'));
}

function personaHome(root, persona, home = 'canonical') {
  return home === 'canonical'
    ? join(root, '.agentic-plugins', 'state', persona)
    : join(root, '.claude', `agentic-${persona}`);
}

async function writeWorkflowFile(root, { persona, home = 'canonical', file, body }) {
  const dir = join(personaHome(root, persona, home), 'workflows');
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, body);
  return path;
}

// Owner-shaped fixtures: string scalars are serialized via JSON.stringify
// exactly like the persona/orchestrator state writers, and the always-present
// bookkeeping keys (tasks, host_history) are included so the fixtures stay
// valid inputs for the owners' own parsers (codex review MINOR).
function personaFm({
  schema = '"1.3"',
  id = 'compose-20260719T090000Z-abc123',
  branch = 'feat/x',
  persona = 'engineer',
  terminalLine = null,
  detachedLine = null,
  parent = null,
  sub = null,
  eol = '\n',
} = {}) {
  const lines = [
    '---',
    `schema: ${schema}`,
    `workflow_id: ${JSON.stringify(id)}`,
    `persona: ${JSON.stringify(persona)}`,
    'verb: "compose"',
    'profile: "backend"',
    `original_request: ${JSON.stringify(`${IMPERATIVE} original`)}`,
    'started_at: "2026-07-19T09:00:00Z"',
    'updated_at: "2026-07-19T09:30:00Z"',
    'repo_root: "/tmp/x"',
    'git_baseline:',
    `  branch: ${JSON.stringify(branch)}`,
    '  head: "abc1234abc1234abc1234abc1234abc1234abc12"',
    '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
    'current_phase: "phase-2-presented"',
    `next_action: ${JSON.stringify(`${IMPERATIVE} next`)}`,
    'tasks: []',
    'host_history:',
    '  - host: "claude"',
    '    at: "2026-07-19T09:00:00Z"',
    '    event: "created"',
  ];
  if (terminalLine) lines.push(terminalLine);
  if (detachedLine) lines.push(detachedLine);
  if (parent) lines.push(`parent_workflow: ${JSON.stringify(parent)}`);
  if (sub) lines.push(`originating_subtask: ${JSON.stringify(sub)}`);
  lines.push('---', '', 'body');
  return lines.join(eol);
}

function macroFm({
  schema = '"1.1"',
  id = 'macro-plan-20260718T111223Z-ccc3c7',
  branch = 'main',
  subtasks = [],
  eol = '\n',
} = {}) {
  const lines = [
    '---',
    `schema: ${schema}`,
    `workflow_id: ${JSON.stringify(id)}`,
    'workflow_type: "macro"',
    `original_request: ${JSON.stringify(`${IMPERATIVE} macro`)}`,
    'started_at: "2026-07-18T11:00:00Z"',
    'updated_at: "2026-07-19T09:00:00Z"',
    'repo_root: "/tmp/x"',
    'git_baseline:',
    `  branch: ${JSON.stringify(branch)}`,
    '  head: "abc1234abc1234abc1234abc1234abc1234abc12"',
    '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
    'current_phase: "phase-2-presented"',
    `next_action: ${JSON.stringify(`${IMPERATIVE} macro-next`)}`,
    'plan:',
    '  decision: "d"',
    '  subtasks:',
  ];
  for (const st of subtasks) {
    lines.push(`    - id: ${JSON.stringify(st.id)}`);
    lines.push(`      label: ${JSON.stringify(st.label ?? 'L')}`);
    lines.push(`      branch: ${JSON.stringify(st.branch)}`);
    if (st.blockedByRaw !== undefined) lines.push(`      blocked_by: ${st.blockedByRaw}`);
    else lines.push(`      blocked_by: [${(st.blocked_by ?? []).map((d) => JSON.stringify(d)).join(', ')}]`);
    lines.push(`      status: ${JSON.stringify(st.status)}`);
    if (st.engineer_workflow_id) lines.push(`      engineer_workflow_id: ${JSON.stringify(st.engineer_workflow_id)}`);
    lines.push('      verb: "compose"');
    lines.push('      profile: "backend"');
    lines.push(`      topic: ${JSON.stringify(`${IMPERATIVE} topic`)}`);
  }
  lines.push('host_history:', '  - host: "claude"', '    at: "2026-07-18T11:00:00Z"', '    event: "created"');
  lines.push('---', '', 'body');
  return lines.join(eol);
}

async function writeSlot(root, persona, projection, { home = 'canonical', mtimeMs = T0 - 60_000, marker = null, markerName = null } = {}) {
  const dir = personaHome(root, persona, home);
  await mkdir(dir, { recursive: true });
  const projectionPath = join(dir, 'last-session-handoff.json');
  await writeFile(projectionPath, JSON.stringify(projection));
  await utimes(projectionPath, new Date(mtimeMs), new Date(mtimeMs));
  if (marker) {
    const markerPath = markerName
      ? join(dir, markerName)
      : `${projectionPath}.footer-rendered`;
    await writeFile(markerPath, typeof marker === 'string' ? marker : JSON.stringify(marker));
  }
  return projectionPath;
}

function slotProjection(overrides = {}) {
  return {
    workflow_kind: 'engineer',
    workflow_id: 'compose-20260719T090000Z-abc123',
    workflow_path: 'wf/x.md',
    phase: 'summary-complete',
    next_action: `${IMPERATIVE} slot-next`,
    archive_gate: 'blocked',
    routing_recommendation: '/engineer:resume',
    ...overrides,
  };
}

function entryDoc(overrides = {}) {
  return {
    schema: 'runtime-session-entry-1.0',
    captured_at: '2026-07-19T09:58:00Z',
    origin: 'stop-hook',
    summary_source: 'staged-note',
    host: 'claude',
    branch: 'feat/entry-brief-readers',
    head_short: 'abc1234',
    dirty_count: 0,
    repo_recent_terminal_evidence: 'fresh',
    summary_line: `${IMPERATIVE} entry-summary`,
    note_staged_at: '2026-07-19T09:57:00Z',
    fingerprint: `fp1:${'a'.repeat(64)}`,
    ...overrides,
  };
}

async function writeEntryCapture(root, doc, { fileName = 'entry.json' } = {}) {
  const dir = join(root, '.agentic-plugins', 'state', 'runtime', 'session-capture');
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, JSON.stringify(doc));
  return path;
}

async function writeRun(root, family, runId, fileName, doc) {
  const dir = join(root, '.agentic-plugins', 'runs', family, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), JSON.stringify(doc));
}

// ---------------------------------------------------------------------------

describe('entry-brief readers — persona workflow source', () => {
  it('finds the single active workflow on the branch and exposes no free text', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'engineer',
      file: 'a.md',
      body: personaFm({
        branch: 'feat/x',
        terminalLine: 'terminal_marker: true',
        detachedLine: 'parent_detached: false',
        parent: 'macro-plan-20260718T111223Z-ccc3c7',
        sub: 'S6-loc-leaf',
      }),
    });
    await writeWorkflowFile(root, { persona: 'engineer', file: 'b.md', body: personaFm({ id: 'frame-20260719T080000Z-bbb222', branch: 'other' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.workflow_id, 'compose-20260719T090000Z-abc123');
    strictEqual(result.active.workflow_id_valid, true);
    strictEqual(result.active.terminal_marker, true);
    strictEqual(result.active.parent_workflow, 'macro-plan-20260718T111223Z-ccc3c7');
    strictEqual(result.active.parent_detached, false);
    strictEqual(result.active.originating_subtask, 'S6-loc-leaf');
    ok(Number.isFinite(result.active.updated_at_ms));
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'), 'no stored free text may cross the reader boundary');
  });

  it('threads parent_detached=true so a detached child cannot pass as linked (§5.1 input)', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'engineer',
      file: 'a.md',
      body: personaFm({ branch: 'feat/x', detachedLine: 'parent_detached: true' }),
    });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.active.parent_detached, true);
  });

  it('returns active:null when no workflow matches and when the home is absent (fail-open ENOENT)', async () => {
    const root = await makeRepo();
    const absent = await readPersonaWorkflowSource({ repoRoot: root, persona: 'designer', branch: 'feat/x' });
    strictEqual(absent.status, 'ok');
    strictEqual(absent.active, null);
    await writeWorkflowFile(root, { persona: 'designer', file: 'a.md', body: personaFm({ persona: 'designer', branch: 'other' }) });
    const noMatch = await readPersonaWorkflowSource({ repoRoot: root, persona: 'designer', branch: 'feat/x' });
    strictEqual(noMatch.status, 'ok');
    strictEqual(noMatch.active, null);
  });

  it('treats a workflows path that is a regular file as corruption, not absence (ENOTDIR)', async () => {
    const root = await makeRepo();
    await mkdir(personaHome(root, 'engineer'), { recursive: true });
    await writeFile(join(personaHome(root, 'engineer'), 'workflows'), 'not a directory');
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'not-a-directory');
  });

  it('degrades to indeterminate on same-home duplicate actives (owner throw mirrored)', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    await writeWorkflowFile(root, { persona: 'engineer', file: 'b.md', body: personaFm({ id: 'frame-20260719T080000Z-bbb222', branch: 'feat/x' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'duplicate-active-workflows');
  });

  it('degrades to indeterminate on canonical+legacy dual-home actives for engineer', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    await writeWorkflowFile(root, { persona: 'engineer', home: 'legacy', file: 'b.md', body: personaFm({ id: 'frame-20260719T080000Z-bbb222', branch: 'feat/x' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'dual-home-ambiguity');
  });

  it('never probes a legacy home for founder/designer (canonical-only personas)', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'founder', home: 'legacy', file: 'a.md', body: personaFm({ persona: 'founder', branch: 'feat/x' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'founder', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active, null);
  });

  it('degrades to indeterminate on unparseable files, oversize, and symlink', async () => {
    const cases = [];
    {
      const root = await makeRepo();
      await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: 'no frontmatter at all' });
      cases.push(await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' }));
    }
    {
      const root = await makeRepo();
      const big = personaFm({ branch: 'feat/x' }) + '#'.repeat(ENTRY_READER_CAPS.MAX_FILE_BYTES + 1);
      await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: big });
      cases.push(await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' }));
    }
    {
      const root = await makeRepo();
      const real = await writeWorkflowFile(root, { persona: 'engineer', file: 'real.md', body: personaFm({ branch: 'feat/x' }) });
      await symlink(real, join(personaHome(root, 'engineer'), 'workflows', 'link.md'));
      cases.push(await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' }));
    }
    for (const result of cases) strictEqual(result.status, 'indeterminate');
  });

  it('rejects unsupported schema on the MATCHING branch without quoting the stored value', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'engineer',
      file: 'a.md',
      body: personaFm({ schema: JSON.stringify(`2.0 ${IMPERATIVE}`), branch: 'feat/x' }),
    });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'unsupported-workflow-schema');
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'), 'reasons must never quote stored values');
  });

  it('ignores schema drift on a NON-matching branch (owner parity: branch classification first)', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'drift.md', body: personaFm({ schema: '"2.0"', branch: 'other' }) });
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ id: 'frame-20260719T080000Z-bbb222', branch: 'feat/x' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.workflow_id, 'frame-20260719T080000Z-bbb222');
  });

  it('decodes owner-serialized escaped-quote branches (JSON scalar round-trip)', async () => {
    const root = await makeRepo();
    const branch = 'feat/"quote"';
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.workflow_id, 'compose-20260719T090000Z-abc123');
  });

  it('refuses a QUOTED terminal_marker instead of reading the string "true" as a boolean', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'engineer',
      file: 'a.md',
      body: personaFm({ branch: 'feat/x', terminalLine: 'terminal_marker: "true"' }),
    });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'invalid-terminal-marker');
  });

  it('parses CRLF state files (Windows-edited) identically', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x', eol: '\r\n' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.workflow_id, 'compose-20260719T090000Z-abc123');
  });

  it('degrades to indeterminate on directory-scan overflow and on home read-budget exhaustion', async () => {
    const root = await makeRepo();
    for (let i = 0; i < 4; i++) {
      await writeWorkflowFile(root, { persona: 'engineer', file: `w${i}.md`, body: personaFm({ id: `compose-2026071${i}T090000Z-abc12${i}`, branch: 'other' }) });
    }
    const overflow = await readPersonaWorkflowSource({
      repoRoot: root,
      persona: 'engineer',
      branch: 'feat/x',
      caps: { ...ENTRY_READER_CAPS, MAX_DIR_ENTRIES: 3 },
    });
    strictEqual(overflow.status, 'indeterminate');
    strictEqual(overflow.reason, 'scan-overflow');

    const budget = await readPersonaWorkflowSource({
      repoRoot: root,
      persona: 'engineer',
      branch: 'feat/x',
      caps: { ...ENTRY_READER_CAPS, MAX_HOME_TOTAL_BYTES: 512 },
    });
    strictEqual(budget.status, 'indeterminate');
    strictEqual(budget.reason, 'read-budget-exceeded');
  });

  it('flags a pattern-failed workflow id instead of trusting it', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ id: 'weird id; rm -rf', branch: 'feat/x' }) });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.workflow_id, null);
    strictEqual(result.active.workflow_id_valid, false);
  });
});

describe('entry-brief readers — linkage tokens', () => {
  it('passes safe identifiers through and derives collision-resistant tokens otherwise', () => {
    strictEqual(linkageToken('S6-loc-leaf'), 'S6-loc-leaf');
    ok(linkageToken('A?').startsWith('sha256:'));
    ok(linkageToken('A*').startsWith('sha256:'));
    ok(linkageToken('A?') !== linkageToken('A*'), 'distinct owner-valid ids must never collide');
    strictEqual(linkageToken(''), null);
    strictEqual(linkageToken(null), null);
  });
});

describe('entry-brief readers — macro readiness derivation', () => {
  it('classifies the four outcomes exactly', () => {
    strictEqual(deriveMacroReadiness([]), 'empty_plan');
    strictEqual(deriveMacroReadiness([
      { id: 'a', status: 'completed', blocked_by: [] },
      { id: 'b', status: 'deferred', blocked_by: [] },
      { id: 'c', status: 'abandoned', blocked_by: [] },
    ]), 'all_terminal');
    strictEqual(deriveMacroReadiness([
      { id: 'a', status: 'completed', blocked_by: [] },
      { id: 'b', status: 'pending', blocked_by: ['a'] },
    ]), 'ready');
    strictEqual(deriveMacroReadiness([
      { id: 'a', status: 'in_progress', blocked_by: [] },
      { id: 'b', status: 'pending', blocked_by: ['a'] },
    ]), 'in_progress_or_blocked');
  });

  it('compares dependency ids exactly — sanitizer collisions cannot fabricate readiness', () => {
    strictEqual(deriveMacroReadiness([
      { id: 'A?', status: 'completed', blocked_by: [] },
      { id: 'A*', status: 'in_progress', blocked_by: [] },
      { id: 'B', status: 'pending', blocked_by: ['A*'] },
    ]), 'in_progress_or_blocked');
  });
});

describe('entry-brief readers — macro sources', () => {
  const SUBS = [
    { id: 'S1', branch: 'feat/done', status: 'completed', blocked_by: [], engineer_workflow_id: 'compose-20260718T120000Z-aaa111' },
    { id: 'S2', branch: 'feat/entry-brief-readers', status: 'in_progress', blocked_by: ['S1'], engineer_workflow_id: 'compose-20260719T110042Z-fab793' },
    { id: 'S3', branch: 'feat/later', status: 'pending', blocked_by: ['S2'] },
  ];

  it('bridges a subtask branch to its parent macro with readiness, actionability, and linkage facts', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'orchestrator', file: 'm.md', body: macroFm({ subtasks: SUBS }) });
    const result = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active_on_branch, null);
    strictEqual(result.bridge.macro_id, 'macro-plan-20260718T111223Z-ccc3c7');
    strictEqual(result.bridge.macro_id_valid, true);
    strictEqual(result.bridge.readiness, 'in_progress_or_blocked');
    strictEqual(result.bridge.schema_actionable, true);
    strictEqual(result.bridge.subtask.id, 'S2');
    strictEqual(result.bridge.subtask.status, 'in_progress');
    strictEqual(result.bridge.subtask.engineer_workflow_id, 'compose-20260719T110042Z-fab793');
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'));
  });

  it('marks a schema-1.0 macro bridge as not dispatch-actionable (owner next-ready refuses 1.0)', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'orchestrator',
      file: 'm.md',
      body: macroFm({
        schema: '"1.0"',
        subtasks: [{ id: 'S1', branch: 'feat/entry-brief-readers', status: 'pending', blocked_by: [] }],
      }),
    });
    const result = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(result.status, 'ok');
    strictEqual(result.bridge.readiness, 'ready');
    strictEqual(result.bridge.schema_actionable, false);
  });

  it('degrades to indeterminate on a malformed blocked_by instead of defaulting it to []', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'orchestrator',
      file: 'm.md',
      body: macroFm({
        subtasks: [{ id: 'S1', branch: 'feat/entry-brief-readers', status: 'pending', blockedByRaw: 'definitely-not-a-list' }],
      }),
    });
    const result = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'malformed-macro-subtasks');
  });

  it('tokenizes non-safe subtask ids in the bridge instead of returning raw free text', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, {
      persona: 'orchestrator',
      file: 'm.md',
      body: macroFm({
        subtasks: [{ id: `S1 ${IMPERATIVE}`, branch: 'feat/entry-brief-readers', status: 'pending', blocked_by: [] }],
      }),
    });
    const result = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(result.status, 'ok');
    ok(result.bridge.subtask.id.startsWith('sha256:'));
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'));
  });

  it('reports a macro active on its own branch', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'orchestrator', file: 'm.md', body: macroFm({ branch: 'main', subtasks: SUBS }) });
    const result = await readMacroSources({ repoRoot: root, branch: 'main' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active_on_branch.workflow_id, 'macro-plan-20260718T111223Z-ccc3c7');
    strictEqual(result.bridge, null);
  });

  it('degrades to indeterminate when two macros reference the same subtask branch', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'orchestrator', file: 'm1.md', body: macroFm({ subtasks: SUBS }) });
    await writeWorkflowFile(root, {
      persona: 'orchestrator',
      file: 'm2.md',
      body: macroFm({ id: 'macro-plan-20260701T000000Z-ddd444', subtasks: SUBS }),
    });
    const result = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'ambiguous-macro-bridge');
  });

  it('degrades to indeterminate on a corrupt macro file (fail-closed mirror) and ignores archive/', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'orchestrator', file: 'bad.md', body: '---\nschema: "1.1"\nbroken' });
    const corrupt = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(corrupt.status, 'indeterminate');

    const root2 = await makeRepo();
    const archiveDir = join(personaHome(root2, 'orchestrator'), 'archive');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, 'old.md'), macroFm({ subtasks: SUBS }));
    const archived = await readMacroSources({ repoRoot: root2, branch: 'feat/entry-brief-readers' });
    strictEqual(archived.status, 'ok');
    strictEqual(archived.bridge, null);
  });
});

describe('entry-brief readers — handoff slots (dual-anchor, marker matrix)', () => {
  it('labels a fresh slot with a matching rendered marker as surfaced', async () => {
    const root = await makeRepo();
    await writeSlot(root, 'engineer', slotProjection(), {
      mtimeMs: T0 - 60_000,
      marker: { workflow_id: 'compose-20260719T090000Z-abc123', status: 'rendered', at: '2026-07-19T09:59:30Z' },
    });
    const result = await readHandoffSlotSource({ repoRoot: root, persona: 'engineer', nowMs: T0 });
    strictEqual(result.status, 'ok');
    strictEqual(result.fresh, true);
    strictEqual(result.marker, 'rendered');
    strictEqual(result.label, 'surfaced');
    strictEqual(result.workflow_id, 'compose-20260719T090000Z-abc123');
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'));
    ok(!JSON.stringify(result).includes('engineer:resume'), 'stored routing must not cross the reader');
  });

  it('labels marker-absent, claimed, and mismatched slots as pending (claimed is NOT rendered)', async () => {
    const cases = [
      { marker: null, expect: 'absent' },
      { marker: { workflow_id: 'compose-20260719T090000Z-abc123', status: 'claimed', at: '2026-07-19T09:59:30Z' }, expect: 'claimed' },
      { marker: { workflow_id: 'frame-20260101T000000Z-999999', status: 'rendered', at: '2026-07-19T09:59:30Z' }, expect: 'mismatched' },
    ];
    for (const c of cases) {
      const root = await makeRepo();
      await writeSlot(root, 'engineer', slotProjection(), { mtimeMs: T0 - 60_000, marker: c.marker });
      const result = await readHandoffSlotSource({ repoRoot: root, persona: 'engineer', nowMs: T0 });
      strictEqual(result.marker, c.expect);
      strictEqual(result.label, 'pending');
      strictEqual(result.fresh, true);
    }
  });

  it('degrades to indeterminate on a malformed marker or a non-ISO render instant (never "pending")', async () => {
    const badJson = await makeRepo();
    await writeSlot(badJson, 'engineer', slotProjection(), { mtimeMs: T0 - 60_000, marker: 'not json at all' });
    strictEqual((await readHandoffSlotSource({ repoRoot: badJson, persona: 'engineer', nowMs: T0 })).status, 'indeterminate');

    const badAt = await makeRepo();
    await writeSlot(badAt, 'engineer', slotProjection(), {
      mtimeMs: T0 - 60_000,
      marker: { workflow_id: 'compose-20260719T090000Z-abc123', status: 'rendered', at: 'July 19 2026' },
    });
    const result = await readHandoffSlotSource({ repoRoot: badAt, persona: 'engineer', nowMs: T0 });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'marker-malformed');
  });

  it('rejects a slot whose workflow_kind does not match its home persona', async () => {
    const root = await makeRepo();
    await writeSlot(root, 'engineer', slotProjection({ workflow_kind: 'founder' }), { mtimeMs: T0 - 60_000 });
    const result = await readHandoffSlotSource({ repoRoot: root, persona: 'engineer', nowMs: T0 });
    strictEqual(result.status, 'indeterminate');
    strictEqual(result.reason, 'slot-kind-mismatch');
  });

  it('rejects stale and future-skewed anchors on both sides', async () => {
    const stale = await makeRepo();
    await writeSlot(stale, 'engineer', slotProjection(), { mtimeMs: T0 - (ENTRY_READER_CAPS.HANDOFF_FRESHNESS_MS + 60_000) });
    strictEqual((await readHandoffSlotSource({ repoRoot: stale, persona: 'engineer', nowMs: T0 })).fresh, false);

    const future = await makeRepo();
    await writeSlot(future, 'engineer', slotProjection(), { mtimeMs: T0 + 120_000 });
    strictEqual((await readHandoffSlotSource({ repoRoot: future, persona: 'engineer', nowMs: T0 })).fresh, false);

    const futureMarker = await makeRepo();
    await writeSlot(futureMarker, 'engineer', slotProjection(), {
      mtimeMs: T0 - 60_000,
      marker: { workflow_id: 'compose-20260719T090000Z-abc123', status: 'rendered', at: '2026-07-19T10:05:00Z' },
    });
    const fm = await readHandoffSlotSource({ repoRoot: futureMarker, persona: 'engineer', nowMs: T0 });
    strictEqual(fm.marker, 'rendered');
    strictEqual(fm.fresh, false);
  });

  it('reads the orchestrator id-scoped marker shape', async () => {
    const root = await makeRepo();
    const wfId = 'macro-plan-20260718T111223Z-ccc3c7';
    await writeSlot(root, 'orchestrator', slotProjection({ workflow_kind: 'orchestrator', workflow_id: wfId, routing_recommendation: '/orchestrator:resume' }), {
      mtimeMs: T0 - 60_000,
      marker: { workflow_id: wfId, status: 'rendered', at: '2026-07-19T09:59:00Z' },
      markerName: `last-session-handoff.json.${wfId}.footer-rendered`,
    });
    const result = await readHandoffSlotSource({ repoRoot: root, persona: 'orchestrator', nowMs: T0 });
    strictEqual(result.marker, 'rendered');
    strictEqual(result.label, 'surfaced');
  });

  it('reports absent and malformed slots honestly', async () => {
    const root = await makeRepo();
    strictEqual((await readHandoffSlotSource({ repoRoot: root, persona: 'founder', nowMs: T0 })).status, 'absent');
    const dir = personaHome(root, 'founder');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'last-session-handoff.json'), 'not json');
    await utimes(join(dir, 'last-session-handoff.json'), new Date(T0 - 1000), new Date(T0 - 1000));
    strictEqual((await readHandoffSlotSource({ repoRoot: root, persona: 'founder', nowMs: T0 })).status, 'indeterminate');
  });
});

describe('entry-brief readers — ADR-0044 entry capture', () => {
  it('reads a valid entry.json, branch-checks it, and never exposes summary_line or the raw branch', async () => {
    const root = await makeRepo();
    await writeEntryCapture(root, entryDoc({ branch: `feat/x ${IMPERATIVE}` }));
    const match = await readEntryCaptureSource({ repoRoot: root, branch: `feat/x ${IMPERATIVE}` });
    strictEqual(match.status, 'ok');
    strictEqual(match.branch_matches, true);
    strictEqual(match.summary_source, 'staged-note');
    ok(Number.isFinite(match.captured_at_ms));
    ok(Number.isFinite(match.note_staged_at_ms));
    strictEqual('branch' in match, false, 'the stored branch string is free text and must not cross');
    ok(!JSON.stringify(match).includes('IMPERATIVE-MARKER'), 'summary_line/branch are stored free text and must not cross');
    const mismatch = await readEntryCaptureSource({ repoRoot: root, branch: 'other' });
    strictEqual(mismatch.branch_matches, false);
  });

  it('reports absent, schema-invalid, semantic-invalid, and symlinked entry files fail-closed', async () => {
    const absentRoot = await makeRepo();
    strictEqual((await readEntryCaptureSource({ repoRoot: absentRoot, branch: 'x' })).status, 'absent');

    const badSchema = await makeRepo();
    await writeEntryCapture(badSchema, entryDoc({ origin: 'not-a-hook' }));
    strictEqual((await readEntryCaptureSource({ repoRoot: badSchema, branch: 'x' })).status, 'invalid');

    const badSemantic = await makeRepo();
    await writeEntryCapture(badSemantic, entryDoc({ summary_source: 'structural' }));
    strictEqual((await readEntryCaptureSource({ repoRoot: badSemantic, branch: 'x' })).status, 'invalid');

    const linked = await makeRepo();
    const realPath = await writeEntryCapture(linked, entryDoc(), { fileName: 'entry-real.json' });
    const dir = join(linked, '.agentic-plugins', 'state', 'runtime', 'session-capture');
    await symlink(realPath, join(dir, 'entry.json'));
    const result = await readEntryCaptureSource({ repoRoot: linked, branch: 'x' });
    strictEqual(result.status, 'invalid');
  });
});

describe('entry-brief readers — row-only ledgers', () => {
  it('selects the latest context run with a deterministic lexicographic tie-break', async () => {
    const root = await makeRepo();
    await writeRun(root, 'context', 'context-20260719T090000Z-aaaaaa', 'context.json', { updated_at: '2026-07-19T09:00:00Z' });
    await writeRun(root, 'context', 'context-20260719T090000Z-bbbbbb', 'context.json', { updated_at: '2026-07-19T09:00:00Z' });
    const result = await readContextLedgerSource({ repoRoot: root, nowMs: T0 });
    strictEqual(result.status, 'ok');
    strictEqual(result.latest.run_id, 'context-20260719T090000Z-bbbbbb');
  });

  it('reports an absent context ledger', async () => {
    const root = await makeRepo();
    strictEqual((await readContextLedgerSource({ repoRoot: root, nowMs: T0 })).status, 'absent');
  });

  it('survives a literal-null document and skips it per entry (no collection abort)', async () => {
    const root = await makeRepo();
    await writeRun(root, 'context', 'context-20260719T080000Z-aaaaaa', 'context.json', null);
    await writeRun(root, 'context', 'context-20260719T090000Z-bbbbbb', 'context.json', { updated_at: '2026-07-19T09:00:00Z' });
    const result = await readContextLedgerSource({ repoRoot: root, nowMs: T0 });
    strictEqual(result.status, 'ok');
    strictEqual(result.latest.run_id, 'context-20260719T090000Z-bbbbbb');
    strictEqual(result.skipped_invalid, 1);

    const consensusRoot = await makeRepo();
    await writeRun(consensusRoot, 'consensus', 'consensus-20260719T080000Z-aaaaaa', 'manifest.json', null);
    const consensus = await readOpenConsensusSource({ repoRoot: consensusRoot, nowMs: T0 });
    strictEqual(consensus.status, 'ok');
    strictEqual(consensus.latest_open, null);
    strictEqual(consensus.skipped_invalid, 1);
  });

  it('rejects a far-future timestamp under the uniform future-skew bound', async () => {
    const root = await makeRepo();
    await writeRun(root, 'context', 'context-20260719T090000Z-aaaaaa', 'context.json', { updated_at: '2026-07-19T09:00:00Z' });
    await writeRun(root, 'context', 'context-20260719T093000Z-bbbbbb', 'context.json', { updated_at: '2026-07-19T11:00:00Z' });
    const result = await readContextLedgerSource({ repoRoot: root, nowMs: T0 });
    strictEqual(result.latest.run_id, 'context-20260719T090000Z-aaaaaa');
    strictEqual(result.skipped_invalid, 1);
  });

  it('selects the latest OPEN consensus run without exposing its raw status string', async () => {
    const root = await makeRepo();
    await writeRun(root, 'consensus', 'consensus-20260719T080000Z-aaaaaa', 'manifest.json', {
      run_id: 'consensus-20260719T080000Z-aaaaaa', status: `executed ${IMPERATIVE}`, updated_at: '2026-07-19T08:00:00Z',
    });
    await writeRun(root, 'consensus', 'consensus-20260719T090000Z-bbbbbb', 'manifest.json', {
      run_id: 'consensus-20260719T090000Z-bbbbbb', status: 'converged', updated_at: '2026-07-19T09:00:00Z',
    });
    await writeRun(root, 'consensus', 'consensus-20260719T093000Z-cccccc', 'manifest.json', {
      run_id: 'consensus-20260719T093000Z-cccccc', status: 'executed', owner_decision_pointer: 'x.json', updated_at: '2026-07-19T09:30:00Z',
    });
    const result = await readOpenConsensusSource({ repoRoot: root, nowMs: T0 });
    strictEqual(result.status, 'ok');
    strictEqual(result.latest_open.run_id, 'consensus-20260719T080000Z-aaaaaa');
    strictEqual(result.skipped_terminal, 2);
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'), 'a non-terminal manifest status is free text and must not cross');
  });

  it('returns latest_open null when every run is terminal, and absent when no ledger exists', async () => {
    const root = await makeRepo();
    await writeRun(root, 'consensus', 'consensus-20260719T090000Z-bbbbbb', 'manifest.json', {
      run_id: 'consensus-20260719T090000Z-bbbbbb', status: 'cancelled', updated_at: '2026-07-19T09:00:00Z',
    });
    const allTerminal = await readOpenConsensusSource({ repoRoot: root, nowMs: T0 });
    strictEqual(allTerminal.status, 'ok');
    strictEqual(allTerminal.latest_open, null);

    const empty = await makeRepo();
    strictEqual((await readOpenConsensusSource({ repoRoot: empty, nowMs: T0 })).status, 'absent');
  });

  it('degrades to indeterminate on ledger scan overflow', async () => {
    const root = await makeRepo();
    for (let i = 0; i < 4; i++) {
      await writeRun(root, 'context', `context-2026071${i}T090000Z-aaaaa${i}`, 'context.json', { updated_at: '2026-07-19T09:00:00Z' });
    }
    const result = await readContextLedgerSource({ repoRoot: root, nowMs: T0, caps: { ...ENTRY_READER_CAPS, MAX_DIR_ENTRIES: 3 } });
    strictEqual(result.status, 'indeterminate');
  });
});

describe('entry-brief readers — collectEntrySources (branch re-check)', () => {
  it('collects all source classes under a stable injected branch probe', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    const result = await collectEntrySources({ repoRoot: root, branchProbe: () => 'feat/x', now: T0 });
    strictEqual(result.branch.initial, 'feat/x');
    strictEqual(result.branch.final, 'feat/x');
    strictEqual(result.branch.stable, true);
    strictEqual(result.branch.state, 'branch');
    strictEqual(result.sources.personas.engineer.active.workflow_id, 'compose-20260719T090000Z-abc123');
    for (const persona of ['engineer', 'founder', 'designer']) ok(result.sources.personas[persona]);
    ok(result.sources.macro);
    for (const persona of ['engineer', 'orchestrator', 'founder', 'designer']) ok(result.sources.handoff_slots[persona]);
    ok(result.sources.entry_capture);
    ok(result.sources.context_ledger);
    ok(result.sources.consensus_open);
    ok(!JSON.stringify(result).includes('IMPERATIVE-MARKER'));
  });

  it('reports an unstable snapshot when the branch changes mid-arbitration', async () => {
    const root = await makeRepo();
    let calls = 0;
    const result = await collectEntrySources({ repoRoot: root, branchProbe: () => (calls++ === 0 ? 'feat/x' : 'feat/y'), now: T0 });
    strictEqual(result.branch.stable, false);
  });

  it('requires an explicit branchProbe — the reader is a spawn-free filesystem leaf', async () => {
    const root = await makeRepo();
    await rejects(collectEntrySources({ repoRoot: root, now: T0 }), TypeError);
  });

  it('degrades git facts on probe failure or rejection while branchless sources still collect', async () => {
    const root = await makeRepo();
    await writeSlot(root, 'engineer', slotProjection(), { mtimeMs: T0 - 60_000 });
    const failed = await collectEntrySources({ repoRoot: root, branchProbe: () => null, now: T0 });
    strictEqual(failed.branch.initial, null);
    strictEqual(failed.branch.state, 'unavailable');
    strictEqual(failed.git_available, false);
    strictEqual(failed.sources.personas.engineer.status, 'no-branch');
    strictEqual(failed.sources.handoff_slots.engineer.status, 'ok');

    const rejecting = await collectEntrySources({
      repoRoot: root,
      branchProbe: () => { throw new Error('git exploded'); },
      now: T0,
    });
    strictEqual(rejecting.branch.state, 'unavailable');
    strictEqual(rejecting.git_available, false);

    const detached = await collectEntrySources({ repoRoot: root, branchProbe: () => '', now: T0 });
    strictEqual(detached.branch.state, 'detached');
  });
});

describe('entry-brief readers — id patterns and caps', () => {
  it('pins the persona and macro id families', () => {
    ok(PERSONA_WORKFLOW_ID_RE.test('compose-20260719T101722Z-80cbf1'));
    ok(!PERSONA_WORKFLOW_ID_RE.test('macro-plan-20260718T111223Z-ccc3c7'));
    ok(!PERSONA_WORKFLOW_ID_RE.test('compose-20260719T101722Z-80cbf1; rm'));
    ok(MACRO_WORKFLOW_ID_RE.test('macro-plan-20260718T111223Z-ccc3c7'));
    ok(!MACRO_WORKFLOW_ID_RE.test('compose-20260719T101722Z-80cbf1'));
  });

  it('caps reader constants exactly as contracted', () => {
    deepStrictEqual(ENTRY_READER_CAPS, Object.freeze({
      MAX_DIR_ENTRIES: 128,
      MAX_FILE_BYTES: 256 * 1024,
      MAX_HOME_TOTAL_BYTES: 2 * 1024 * 1024,
      HANDOFF_FRESHNESS_MS: 10 * 60 * 1000,
      FUTURE_SKEW_MS: 60 * 1000,
    }));
  });
});
