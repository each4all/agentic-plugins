import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENTRY_READER_CAPS,
  ENTRY_READER_IO,
  ENTRY_READER_REASON_CODES,
  MACRO_WORKFLOW_ID_RE,
  PERSONA_WORKFLOW_ID_RE,
  collectEntrySources,
  deriveMacroReadiness,
  linkageToken,
  readContextLedgerSource,
  readEntryCaptureSource,
  readFrontmatterHead,
  readHandoffSlotSource,
  readMacroSources,
  readOpenConsensusSource,
  readPersonaWorkflowSource,
  skippedSourcesOf,
  splitFrontmatterLines,
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

  it('degrades on an unparseable file, and reads a long body and an in-home link (C124, C122)', async () => {
    const unparseable = await makeRepo();
    await writeWorkflowFile(unparseable, { persona: 'engineer', file: 'a.md', body: 'no frontmatter at all' });
    const bad = await readPersonaWorkflowSource({ repoRoot: unparseable, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([bad.status, bad.reason], ['indeterminate', 'unparseable-workflow-frontmatter']);

    // The body is never read: its size is no reason to refuse the workflow.
    const long = await makeRepo();
    const big = personaFm({ branch: 'feat/x' }) + '#'.repeat(4 * ENTRY_READER_CAPS.MAX_FRONTMATTER_BYTES);
    await writeWorkflowFile(long, { persona: 'engineer', file: 'a.md', body: big });
    const read = await readPersonaWorkflowSource({ repoRoot: long, persona: 'engineer', branch: 'feat/x' });
    strictEqual(read.status, 'ok');
    strictEqual(read.active.workflow_id, 'compose-20260719T090000Z-abc123');

    // A link to a workflow file in its own home is that file, counted once,
    // its pointer under the plain name whichever the listing yields first.
    const linked = await makeRepo();
    const real = await writeWorkflowFile(linked, { persona: 'engineer', file: 'real.md', body: personaFm({ branch: 'feat/x' }) });
    await symlink(real, join(personaHome(linked, 'engineer'), 'workflows', 'link.md'));
    for (const first of ['link.md', 'real.md']) {
      const io = {
        ...ENTRY_READER_IO,
        listDir: async (dir, caps) => {
          const listing = await ENTRY_READER_IO.listDir(dir, caps);
          if (listing.state !== 'ok') return listing;
          return { ...listing, entries: [...listing.entries].sort((a, b) => (a.name === first ? -1 : b.name === first ? 1 : 0)) };
        },
      };
      const once = await readPersonaWorkflowSource({ repoRoot: linked, persona: 'engineer', branch: 'feat/x', io });
      strictEqual(once.status, 'ok', `listed ${first} first`);
      strictEqual(once.active.pointer, '.agentic-plugins/state/engineer/workflows/real.md', `listed ${first} first`);
    }
  });

  it('refuses a frontmatter whose close does not end within the bound, named', async () => {
    const root = await makeRepo();
    const padded = personaFm({ branch: 'feat/x' }).replace('tasks: []', `tasks: []\npad: "${'p'.repeat(ENTRY_READER_CAPS.MAX_FRONTMATTER_BYTES)}"`);
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: padded });
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([result.status, result.reason], ['indeterminate', 'frontmatter-over-read-bound']);
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

  it('reads an active macro and a different macro bridging the same branch as no pair', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'orchestrator', file: 'own.md', body: macroFm({ branch: 'feat/entry-brief-readers', subtasks: [] }) });
    await writeWorkflowFile(root, { persona: 'orchestrator', file: 'parent.md', body: macroFm({ id: 'macro-plan-20260701T000000Z-ddd444', subtasks: SUBS }) });
    const result = await readMacroSources({ repoRoot: root, branch: 'feat/entry-brief-readers' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active_on_branch.workflow_id, 'macro-plan-20260718T111223Z-ccc3c7');
    strictEqual(result.bridge.macro_id, 'macro-plan-20260701T000000Z-ddd444');
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
      MAX_FRONTMATTER_BYTES: 256 * 1024,
      FRONTMATTER_CHUNK_BYTES: 8 * 1024,
      MAX_HOME_TOTAL_BYTES: 2 * 1024 * 1024,
      MAX_SCAN_ATTEMPTS: 3,
      HANDOFF_FRESHNESS_MS: 10 * 60 * 1000,
      FUTURE_SKEW_MS: 60 * 1000,
    }));
  });
});

// ---------------------------------------------------------------------------
// C124 — a workflow `.md` is read only as far as its frontmatter closes.

// A handle over `bytes` that returns at most `maxRead` bytes per read, as a
// short read from a pipe or a network filesystem would.
function fakeHandle(bytes, { maxRead = Infinity } = {}) {
  const reads = [];
  return {
    reads,
    async read(buffer, offset, length, position) {
      const n = Math.max(0, Math.min(length, maxRead, bytes.length - position));
      bytes.copy(buffer, offset, position, position + n);
      reads.push(n);
      return { bytesRead: n, buffer };
    },
  };
}

const TINY = { ...ENTRY_READER_CAPS, MAX_FRONTMATTER_BYTES: 64, FRONTMATTER_CHUNK_BYTES: 4 };

// A frontmatter of exactly `total` bytes through the end of its close (`tail`
// is the close's line ending: '\n', '\r\n', or '' for a close at the end of
// the file).
function exactFrontmatter(total, tail = '\n') {
  const fixed = '---\nk: ""\n---'.length + tail.length;
  return `---\nk: "${'x'.repeat(total - fixed)}"\n---${tail}`;
}

async function head(text, caps = TINY, options = {}) {
  return readFrontmatterHead(fakeHandle(Buffer.from(text), options), caps);
}

describe('entry-brief readers — frontmatter-only reads (C124)', () => {
  it('finds a close split across reads, LF and CRLF, whatever the read size', async () => {
    for (const eol of ['\n', '\r\n']) {
      const text = ['---', 'k: "v"', '---', 'body body body'].join(eol);
      const through = ['---', 'k: "v"', '---', ''].join(eol);
      for (const maxRead of [1, 2, 3, Infinity]) {
        const result = await head(text, TINY, { maxRead });
        deepStrictEqual([result.state, result.text], ['ok', through], `eol=${JSON.stringify(eol)} maxRead=${maxRead}`);
      }
    }
  });

  it('accepts a close ending exactly at the bound and refuses one ending a byte past it', async () => {
    const max = TINY.MAX_FRONTMATTER_BYTES;
    strictEqual((await head(`${exactFrontmatter(max)}body`)).state, 'ok');
    deepStrictEqual(
      [(await head(`${exactFrontmatter(max + 1)}body`)).state, (await head(`${exactFrontmatter(max + 1)}body`)).reason],
      ['refused', 'frontmatter-over-read-bound'],
    );
    // CRLF: the terminator's LF is the byte past the bound.
    strictEqual((await head(`${exactFrontmatter(max, '\r\n')}body`)).state, 'ok');
    strictEqual((await head(`${exactFrontmatter(max + 1, '\r\n')}body`)).state, 'refused');
    // A close at the end of a file exactly the bound long, and one a byte longer.
    strictEqual((await head(exactFrontmatter(max, ''))).state, 'ok');
    strictEqual((await head(exactFrontmatter(max + 1, ''))).state, 'refused');
    // An unterminated frontmatter longer than the bound is over the bound.
    strictEqual((await head(`---\nk: "${'x'.repeat(2 * max)}"\n`)).reason, 'frontmatter-over-read-bound');
  });

  it('reads on after a short read: only a read of 0 bytes ends the file', async () => {
    const text = `${exactFrontmatter(40)}body`;
    const handle = fakeHandle(Buffer.from(text), { maxRead: 1 });
    const result = await readFrontmatterHead(handle, TINY);
    deepStrictEqual([result.state, result.text], ['ok', exactFrontmatter(40)]);
    ok(handle.reads.length >= 40 && handle.reads.every((n) => n <= 1));
  });

  it('decodes a character split across reads whole', async () => {
    const text = '---\nbranch: "feat/한글-ü"\n---\nbody';
    for (const maxRead of [1, 2, 5]) {
      const result = await head(text, TINY, { maxRead });
      deepStrictEqual(splitFrontmatterLines(result.text), ['branch: "feat/한글-ü"']);
    }
  });

  it('keeps the line semantics of the whole-file split: an empty frontmatter, an unterminated one, none', async () => {
    deepStrictEqual(splitFrontmatterLines((await head('---\n---\nbody ---')).text), []);
    for (const text of ['---\nk: v\n', 'k: v\n---\n', '---', '---\nk\n---\r', '', '﻿---\n---\n']) {
      strictEqual((await head(text)).state, 'unparseable', JSON.stringify(text));
    }
  });

  it('reads the lines the whole-file split reads, for every text and read size (differential)', async () => {
    const texts = [
      '---\nk: 1\n---\nbody', '---\r\nk: 1\r\n---\r\nbody', '---\nk: 1\n---\r\nbody', '---\nk: 1\n---',
      '---\n----\nk\n---\n', '---\nk\n---x\n---\n', '---\nk\n ---\n---\n', '---\nk\n---\rX\n---\n',
      '---\n---', '---\r\n---\r\n', '--- \n---\n', 'x\n---\n---\n', '---\nk\n', '---\r\r\nk\n---\n',
      '---\na\n---\nb\n---\n', `---\n${'z'.repeat(70)}\n---\n`,
    ];
    for (const text of texts) {
      for (const maxRead of [1, 3, Infinity]) {
        const result = await head(text, { ...TINY, MAX_FRONTMATTER_BYTES: 1024 }, { maxRead });
        const lines = result.state === 'ok' ? splitFrontmatterLines(result.text) : null;
        deepStrictEqual(lines, splitFrontmatterLines(text), `${JSON.stringify(text)} maxRead=${maxRead}`);
      }
    }
  });

  it('reads no further into a long body than the chunk the close lies in', async () => {
    const text = personaFm({ branch: 'feat/x' }) + '#'.repeat(1024 * 1024);
    const handle = fakeHandle(Buffer.from(text));
    const result = await readFrontmatterHead(handle);
    strictEqual(result.state, 'ok');
    strictEqual(result.bytes, ENTRY_READER_CAPS.FRONTMATTER_CHUNK_BYTES);
  });

  it('charges the home budget with bytes read: a file reached again through a link costs nothing', async () => {
    const root = await makeRepo();
    const body = personaFm({ branch: 'feat/x' });
    const real = await writeWorkflowFile(root, { persona: 'engineer', file: 'real.md', body });
    await symlink(real, join(personaHome(root, 'engineer'), 'workflows', 'alias.md'));
    const caps = { ...ENTRY_READER_CAPS, MAX_HOME_TOTAL_BYTES: Buffer.byteLength(body) + 1 };
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', caps });
    strictEqual(result.status, 'ok');
  });

  it('charges what the reads took, not the frontmatter kept: a chunk read past the close counts', async () => {
    const root = await makeRepo();
    const fm = personaFm({ branch: 'feat/x' });
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: fm + '#'.repeat(4 * ENTRY_READER_CAPS.FRONTMATTER_CHUNK_BYTES) });
    const frontmatterBytes = Buffer.byteLength(fm) - Buffer.byteLength('\nbody');
    const caps = { ...ENTRY_READER_CAPS, MAX_HOME_TOTAL_BYTES: frontmatterBytes + 64 };
    ok(caps.MAX_HOME_TOTAL_BYTES < ENTRY_READER_CAPS.FRONTMATTER_CHUNK_BYTES, 'the first read alone exceeds the budget');
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', caps });
    deepStrictEqual([result.status, result.reason], ['indeterminate', 'read-budget-exceeded']);
  });

  it('reads a file again on a relist when it was rewritten in place since its first read', async () => {
    const root = await makeRepo();
    const file = await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x', terminalLine: 'terminal_marker: false' }) });
    let listings = 0;
    const io = {
      ...ENTRY_READER_IO,
      listDir: async (dir, caps) => {
        const listing = await ENTRY_READER_IO.listDir(dir, caps);
        if (listing.state !== 'ok') return listing;
        listings++;
        if (listings === 2) {
          // The same inode, rewritten, with a later mtime.
          await writeFile(file, personaFm({ branch: 'feat/x', terminalLine: 'terminal_marker: true' }));
          await utimes(file, new Date(T0 + 5_000), new Date(T0 + 5_000));
        }
        return { ...listing, entries: listings === 1 ? [{ name: 'a.md' }, { name: 'gone.md' }] : [{ name: 'a.md' }] };
      },
    };
    await utimes(file, new Date(T0), new Date(T0));
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io });
    strictEqual(listings, 2);
    strictEqual(result.status, 'ok');
    strictEqual(result.active.terminal_marker, true, 'the relist read the rewritten file, not the first read');
  });

  it('keeps one budget across the listings of a directory: a relist does not reset it (codex review MINOR)', async () => {
    const root = await makeRepo();
    const bodies = {
      'a.md': personaFm({ id: 'compose-20260719T010000Z-aaa111', branch: 'other' }),
      'b.md': personaFm({ id: 'compose-20260719T020000Z-bbb222', branch: 'other' }),
      'd.md': personaFm({ id: 'compose-20260719T030000Z-ddd444', branch: 'feat/x' }),
    };
    for (const [file, body] of Object.entries(bodies)) await writeWorkflowFile(root, { persona: 'engineer', file, body });
    const total = Object.values(bodies).reduce((sum, body) => sum + Buffer.byteLength(body), 0);
    // The first listing names a.md, b.md and a file that is gone by its read;
    // the second names a.md, b.md and d.md. Each listing alone fits.
    let listings = 0;
    const io = {
      ...ENTRY_READER_IO,
      listDir: async (dir, caps) => {
        const listing = await ENTRY_READER_IO.listDir(dir, caps);
        if (listing.state !== 'ok') return listing;
        listings++;
        const names = listings === 1 ? ['a.md', 'b.md', 'gone.md'] : ['a.md', 'b.md', 'd.md'];
        return { ...listing, entries: names.map((name) => ({ name })) };
      },
    };
    const fits = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io, caps: { ...ENTRY_READER_CAPS, MAX_HOME_TOTAL_BYTES: total } });
    strictEqual(fits.status, 'ok', 'control: the three files fit the budget');
    strictEqual(fits.active.workflow_id, 'compose-20260719T030000Z-ddd444');
    listings = 0;
    const over = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io, caps: { ...ENTRY_READER_CAPS, MAX_HOME_TOTAL_BYTES: total - 1 } });
    deepStrictEqual([over.status, over.reason], ['indeterminate', 'read-budget-exceeded']);
  });
});

// ---------------------------------------------------------------------------
// C122 — a link is followed only into a home of its persona in the read set.

async function outsideFile(body) {
  const dir = await mkdtemp(join(tmpdir(), 'entry-brief-outside-'));
  const path = join(dir, 'outside.md');
  await writeFile(path, body);
  return path;
}

const OUTSIDE_ID = 'frame-20260719T080000Z-0ff51d';

describe('entry-brief readers — workflow links and homes (C122)', () => {
  it('refuses a link out of the state homes, named, and quotes nothing of what it names', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/other' }) });
    const target = await outsideFile(personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
    await symlink(target, join(personaHome(root, 'engineer'), 'workflows', 'out.md'));
    // Judged before the open: what lies outside is never opened (a device
    // or a FIFO there is not this reader's to touch).
    const opened = [];
    const io = { ...ENTRY_READER_IO, openReadOnly: async (path) => { opened.push(path); return ENTRY_READER_IO.openReadOnly(path); } };
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io });
    deepStrictEqual([result.status, result.reason], ['indeterminate', 'symlink-outside-state']);
    ok(!JSON.stringify(result).includes(OUTSIDE_ID));
    ok(!opened.includes(await ENTRY_READER_IO.realpath(target)), 'the outside file was opened');
  });

  it('refuses a link into another persona\'s home, and a workflows directory linked out of its home', async () => {
    const intoFounder = await makeRepo();
    const founderFile = await writeWorkflowFile(intoFounder, { persona: 'founder', file: 'f.md', body: personaFm({ persona: 'founder', branch: 'feat/x' }) });
    await mkdir(join(personaHome(intoFounder, 'engineer'), 'workflows'), { recursive: true });
    await symlink(founderFile, join(personaHome(intoFounder, 'engineer'), 'workflows', 'f.md'));
    const engineer = await readPersonaWorkflowSource({ repoRoot: intoFounder, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([engineer.status, engineer.reason], ['indeterminate', 'symlink-outside-state']);
    strictEqual((await readPersonaWorkflowSource({ repoRoot: intoFounder, persona: 'founder', branch: 'feat/x' })).status, 'ok');

    const linkedDir = await makeRepo();
    const elsewhere = await mkdtemp(join(tmpdir(), 'entry-brief-elsewhere-'));
    await writeFile(join(elsewhere, 'a.md'), personaFm({ branch: 'feat/x' }));
    await mkdir(personaHome(linkedDir, 'engineer'), { recursive: true });
    await symlink(elsewhere, join(personaHome(linkedDir, 'engineer'), 'workflows'));
    const dir = await readPersonaWorkflowSource({ repoRoot: linkedDir, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([dir.status, dir.reason], ['indeterminate', 'symlink-outside-state']);
  });

  it('accepts a home that is itself a link (the lanes layout), its pointer spelled under the home', async () => {
    const root = await makeRepo();
    const target = await mkdtemp(join(tmpdir(), 'entry-brief-home-'));
    await mkdir(join(target, 'workflows'));
    await writeFile(join(target, 'workflows', 'a.md'), personaFm({ branch: 'feat/x' }));
    await mkdir(join(root, '.agentic-plugins', 'state'), { recursive: true });
    await symlink(target, personaHome(root, 'engineer'));
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.pointer, '.agentic-plugins/state/engineer/workflows/a.md');
  });

  it('refuses a home that is another persona\'s home, for both personas', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'founder', file: 'f.md', body: personaFm({ persona: 'founder', branch: 'feat/x' }) });
    await symlink(personaHome(root, 'founder'), personaHome(root, 'designer'));
    for (const persona of ['designer', 'founder']) {
      const result = await readPersonaWorkflowSource({ repoRoot: root, persona, branch: 'feat/x' });
      deepStrictEqual([result.status, result.reason], ['indeterminate', 'home-aliases-other-persona'], persona);
    }
  });

  it('degrades on a home that exists and cannot be resolved (a link loop, a refused lookup), named', async () => {
    const loop = await makeRepo();
    await mkdir(join(loop, '.agentic-plugins', 'state'), { recursive: true });
    await symlink(personaHome(loop, 'engineer'), personaHome(loop, 'engineer'));
    const looped = await readPersonaWorkflowSource({ repoRoot: loop, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([looped.status, looped.reason], ['indeterminate', 'home-unresolvable']);

    // The home's path refused, and a directory above it refused.
    const denied = await makeRepo();
    await writeWorkflowFile(denied, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    const deniedHome = personaHome(denied, 'engineer');
    const deniedParent = join(await realpath(denied), '.agentic-plugins');
    const refuse = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    for (const io of [
      { ...ENTRY_READER_IO, realpath: async (path) => (path === deniedHome ? refuse() : ENTRY_READER_IO.realpath(path)) },
      { ...ENTRY_READER_IO, lstat: async (path, options) => (path === deniedParent ? refuse() : ENTRY_READER_IO.lstat(path, options)) },
    ]) {
      const result = await readPersonaWorkflowSource({ repoRoot: denied, persona: 'engineer', branch: 'feat/x', io });
      deepStrictEqual([result.status, result.reason], ['indeterminate', 'home-unresolvable']);
    }

    // A broken `.claude` is the legacy homes' to report: founder has none
    // (peer verify MINOR).
    const broken = await makeRepo();
    await writeWorkflowFile(broken, { persona: 'founder', file: 'f.md', body: personaFm({ persona: 'founder', branch: 'feat/x' }) });
    await symlink(join(broken, '.claude'), join(broken, '.claude'));
    strictEqual((await readPersonaWorkflowSource({ repoRoot: broken, persona: 'founder', branch: 'feat/x' })).status, 'ok');
    const engineer = await readPersonaWorkflowSource({ repoRoot: broken, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([engineer.status, engineer.reason], ['indeterminate', 'home-unresolvable']);
  });

  it('refuses a home inside another persona\'s home or holding one, in both directions (critique MAJOR)', async () => {
    // The orchestrator home linked to a directory inside the engineer home:
    // each reader would take the other's files for its own.
    const root = await makeRepo();
    const engineerFile = await writeWorkflowFile(root, { persona: 'engineer', file: 'e.md', body: personaFm({ branch: 'feat/x' }) });
    const sub = join(personaHome(root, 'engineer'), 'sub');
    await mkdir(join(sub, 'workflows'), { recursive: true });
    await symlink(sub, personaHome(root, 'orchestrator'));
    await symlink(engineerFile, join(sub, 'workflows', 'm.md'));
    const engineer = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([engineer.status, engineer.reason], ['indeterminate', 'home-aliases-other-persona']);
    const macro = await readMacroSources({ repoRoot: root, branch: 'feat/x' });
    deepStrictEqual([macro.status, macro.reason], ['indeterminate', 'home-aliases-other-persona']);

    // The engineer legacy home linked to the state directory: it holds the
    // founder home, and a link in the canonical home reaches a founder file.
    const holder = await makeRepo();
    const founderFile = await writeWorkflowFile(holder, { persona: 'founder', file: 'f.md', body: personaFm({ persona: 'founder', branch: 'feat/x' }) });
    await mkdir(join(personaHome(holder, 'engineer'), 'workflows'), { recursive: true });
    await symlink(founderFile, join(personaHome(holder, 'engineer'), 'workflows', 'e.md'));
    await mkdir(join(holder, '.claude'), { recursive: true });
    await symlink(join(holder, '.agentic-plugins', 'state'), personaHome(holder, 'engineer', 'legacy'));
    const held = await readPersonaWorkflowSource({ repoRoot: holder, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([held.status, held.reason], ['indeterminate', 'home-aliases-other-persona']);
    strictEqual((await readPersonaWorkflowSource({ repoRoot: holder, persona: 'founder', branch: 'feat/x' })).reason, 'home-aliases-other-persona');
  });

  it('refuses a home that holds a state root or its state directory, even with no other home present', async () => {
    const outside = await outsideFile(personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
    for (const target of [(root) => root, (root) => join(root, '.agentic-plugins', 'state'), () => '/']) {
      const root = await makeRepo();
      await mkdir(join(personaHome(root, 'engineer'), 'workflows'), { recursive: true });
      await symlink(outside, join(personaHome(root, 'engineer'), 'workflows', 'x.md'));
      await mkdir(join(root, '.claude'), { recursive: true });
      await symlink(target(root), personaHome(root, 'engineer', 'legacy'));
      const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
      deepStrictEqual([result.status, result.reason], ['indeterminate', 'home-encloses-state'], target(root));
      ok(!JSON.stringify(result).includes(OUTSIDE_ID));
    }
  });

  it('refuses an entry whose directory the walk cannot describe (fail closed)', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    const workflows = join(await realpath(personaHome(root, 'engineer')), 'workflows');
    const io = {
      ...ENTRY_READER_IO,
      lstat: async (path, options) => {
        if (path === workflows && options?.bigint) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return ENTRY_READER_IO.lstat(path, options);
      },
    };
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io });
    deepStrictEqual([result.status, result.reason], ['indeterminate', 'symlink-outside-state']);
  });

  it('resolves a link\'s identity as the owners do: a case variant of a name is another file to both', async (t) => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'inside.md', body: personaFm({ branch: 'feat/x' }) });
    const caseInsensitive = await realpath(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'INSIDE.md')).then(() => true, () => false);
    if (!caseInsensitive) {
      t.skip('the volume is case-sensitive: no case variant names the file');
      return;
    }
    await symlink(join(personaHome(root, 'engineer'), 'workflows', 'INSIDE.md'), join(personaHome(root, 'engineer'), 'workflows', 'alias.md'));
    const owner = await import(new URL('../../plugins/engineer/scripts/state.mjs', import.meta.url));
    await owner.findActiveWorkflowByBranch(root, 'feat/x').then(
      () => { throw new Error('the engineer owner accepted a case-variant link as the file'); },
      (error) => ok(/2 workflow files/.test(error.message), error.message),
    );
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    deepStrictEqual([result.status, result.reason], ['indeterminate', 'duplicate-active-workflows']);
  });

  it('skips a link to nothing as gone, as the owners do, and names an entry it cannot stat', async () => {
    const root = await makeRepo();
    await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    await symlink(join(root, 'nowhere.md'), join(personaHome(root, 'engineer'), 'workflows', 'dead.md'));
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x' });
    strictEqual(result.status, 'ok');
    strictEqual(result.active.workflow_id, 'compose-20260719T090000Z-abc123');

    const io = {
      ...ENTRY_READER_IO,
      lstat: async (path) => {
        if (path.endsWith('a.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return ENTRY_READER_IO.lstat(path);
      },
    };
    const denied = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io });
    deepStrictEqual([denied.status, denied.reason], ['indeterminate', 'stat-failed']);
  });

  it('never yields outside content when a path is swapped between the containment check and the open', async () => {
    // `unlisted` keeps the link's target in the home but out of `workflows/`,
    // so the link is the only name listed.
    const setup = async ({ unlisted = false } = {}) => {
      const root = await makeRepo();
      const body = personaFm({ branch: 'feat/x' });
      let inside;
      if (unlisted) {
        const dir = join(personaHome(root, 'engineer'), 'archive');
        await mkdir(dir, { recursive: true });
        inside = join(dir, 'inside.md');
        await writeFile(inside, body);
      } else {
        inside = await writeWorkflowFile(root, { persona: 'engineer', file: 'inside.md', body });
      }
      const link = join(personaHome(root, 'engineer'), 'workflows', 'link.md');
      await mkdir(join(personaHome(root, 'engineer'), 'workflows'), { recursive: true });
      await symlink(inside, link);
      const outside = await outsideFile(personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
      return { root, inside, insideReal: await realpath(inside), link, outside };
    };
    // The listing order is the filesystem's (APFS and ext4 differ), so every
    // case runs in both orders.
    const swapping = (target, swap, order) => ({
      ...ENTRY_READER_IO,
      listDir: async (dir, caps) => {
        const listing = await ENTRY_READER_IO.listDir(dir, caps);
        if (order === 'reversed' && listing.entries) listing.entries.reverse();
        return listing;
      },
      openReadOnly: async (path) => {
        if (path === target.insideReal && !target.swapped) {
          target.swapped = true;
          await swap(target);
        }
        return ENTRY_READER_IO.openReadOnly(path);
      },
    });
    const results = [];
    for (const order of ['listed', 'reversed']) {
      const read = (t, swap) => readPersonaWorkflowSource({ repoRoot: t.root, persona: 'engineer', branch: 'feat/x', io: swapping(t, swap, order) });

      // The link re-aimed outside: the checked real path is what is opened.
      // Its target is not listed: a listed target read before the link
      // would re-aim the link first, and the link then lies outside.
      const relinked = await setup({ unlisted: true });
      const a = await read(relinked, async (t) => {
        await symlink(t.outside, `${t.link}.new`);
        await rename(`${t.link}.new`, t.link);
      });
      ok(relinked.swapped, `the swap happened (${order})`);
      strictEqual(a.status, 'ok', order);
      strictEqual(a.active.workflow_id, 'compose-20260719T090000Z-abc123', order);

      // The checked file replaced by a link outside: O_NOFOLLOW refuses it.
      const replaced = await setup();
      const b = await read(replaced, async (t) => {
        await symlink(t.outside, `${t.inside}.new`);
        await rename(`${t.inside}.new`, t.inside);
      });
      deepStrictEqual([b.status, b.reason], ['indeterminate', 'symlink-refused'], order);

      // Its directory swapped for a link outside: the opened file is not the
      // one checked.
      const ancestor = await setup();
      const c = await read(ancestor, async (t) => {
        const workflows = join(personaHome(t.root, 'engineer'), 'workflows');
        const decoy = await mkdtemp(join(tmpdir(), 'entry-brief-decoy-'));
        await writeFile(join(decoy, 'inside.md'), personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
        await rename(workflows, `${workflows}.moved`);
        await symlink(decoy, workflows);
      });
      deepStrictEqual([c.status, c.reason], ['indeterminate', 'workflow-identity-changed'], order);
      results.push(a, b, c);
    }

    // Its directory swapped for a link outside right after the realpath, so
    // the file's stat already follows it (one swap, codex review MAJOR): the
    // containment walk sees the link.
    const early = await setup();
    // One entry only: a second name read after the swap would be refused on
    // its own and hide whether the first was caught.
    await rm(early.link);
    const earlyIo = {
      ...ENTRY_READER_IO,
      realpath: async (path) => {
        const real = await ENTRY_READER_IO.realpath(path);
        if (real === early.insideReal && !early.swapped) {
          early.swapped = true;
          const workflows = join(personaHome(early.root, 'engineer'), 'workflows');
          const decoy = await mkdtemp(join(tmpdir(), 'entry-brief-decoy-'));
          await writeFile(join(decoy, 'inside.md'), personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
          await rename(workflows, `${workflows}.moved`);
          await symlink(decoy, workflows);
        }
        return real;
      },
    };
    const d = await readPersonaWorkflowSource({ repoRoot: early.root, persona: 'engineer', branch: 'feat/x', io: earlyIo });
    ok(early.swapped, 'the swap happened');
    deepStrictEqual([d.status, d.reason], ['indeterminate', 'symlink-outside-state']);
    for (const result of [...results, d]) ok(!JSON.stringify(result).includes(OUTSIDE_ID));
  });

  it('judges the path again after the open: one rename that moves the checked file out is refused (critique MAJOR)', async () => {
    const setup = async () => {
      const root = await makeRepo();
      const inside = await writeWorkflowFile(root, { persona: 'engineer', file: 'inside.md', body: personaFm({ branch: 'feat/x' }) });
      return { root, insideReal: await realpath(inside), workflows: join(personaHome(root, 'engineer'), 'workflows') };
    };
    const atOpen = (t, swap, { after = false } = {}) => ({
      ...ENTRY_READER_IO,
      openReadOnly: async (path) => {
        if (path !== t.insideReal || t.swapped) return ENTRY_READER_IO.openReadOnly(path);
        t.swapped = true;
        if (after) {
          const handle = await ENTRY_READER_IO.openReadOnly(path);
          await swap(t);
          return handle;
        }
        await swap(t);
        return ENTRY_READER_IO.openReadOnly(path);
      },
    });
    const read = (t, io) => readPersonaWorkflowSource({ repoRoot: t.root, persona: 'engineer', branch: 'feat/x', io });

    // After the walk, before the open: `workflows/` moved out of every home
    // and a link left in its place, so the open reaches the checked file,
    // same inode, outside.
    const moved = await setup();
    const a = await read(moved, atOpen(moved, async (t) => {
      const away = join(await mkdtemp(join(tmpdir(), 'entry-brief-away-')), 'workflows');
      await rename(t.workflows, away);
      await symlink(away, t.workflows);
    }));
    ok(moved.swapped, 'the swap happened');
    deepStrictEqual([a.status, a.reason], ['indeterminate', 'symlink-outside-state']);

    // After the open: another file renamed over the checked name, so the
    // path no longer names the file the handle holds.
    const replaced = await setup();
    const b = await read(replaced, atOpen(replaced, async (t) => {
      await writeFile(`${t.insideReal}.new`, personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
      await rename(`${t.insideReal}.new`, t.insideReal);
    }, { after: true }));
    ok(replaced.swapped, 'the swap happened');
    deepStrictEqual([b.status, b.reason], ['indeterminate', 'workflow-identity-changed']);

    // During the second walk, after it has passed `workflows/` (peer verify):
    // the handle already holds the checked file, so a rename can only move it
    // (read where it lies, the checked file still), and another file put in
    // its place through a link fails the final identity check.
    const duringWalk = async (swap) => {
      const t = await setup();
      const workflowsReal = await realpath(t.workflows);
      let opened = false;
      const io = {
        ...ENTRY_READER_IO,
        openReadOnly: async (path) => {
          if (path === t.insideReal) opened = true;
          return ENTRY_READER_IO.openReadOnly(path);
        },
        lstat: async (path, options) => {
          const st = await ENTRY_READER_IO.lstat(path, options);
          if (opened && !t.swapped && path === workflowsReal && options?.bigint) {
            t.swapped = true;
            await swap(t);
          }
          return st;
        },
      };
      const result = await read(t, io);
      ok(t.swapped, 'the swap happened');
      return result;
    };
    const movedDuring = await duringWalk(async (t) => {
      const away = join(await mkdtemp(join(tmpdir(), 'entry-brief-away-')), 'workflows');
      await rename(t.workflows, away);
      await symlink(away, t.workflows);
    });
    deepStrictEqual([movedDuring.status, movedDuring.active?.workflow_id], ['ok', 'compose-20260719T090000Z-abc123']);
    const decoyDuring = await duringWalk(async (t) => {
      const decoy = await mkdtemp(join(tmpdir(), 'entry-brief-decoy-'));
      await writeFile(join(decoy, 'inside.md'), personaFm({ id: OUTSIDE_ID, branch: 'feat/x' }));
      await rename(t.workflows, `${t.workflows}.moved`);
      await symlink(decoy, t.workflows);
    });
    deepStrictEqual([decoyDuring.status, decoyDuring.reason], ['indeterminate', 'workflow-identity-changed']);
    for (const result of [a, b, movedDuring, decoyDuring]) ok(!JSON.stringify(result).includes(OUTSIDE_ID));
  });

  it('compares identities as bigints: two inodes past 2^53 that round alike are two files', async () => {
    const root = await makeRepo();
    const file = await writeWorkflowFile(root, { persona: 'engineer', file: 'a.md', body: personaFm({ branch: 'feat/x' }) });
    const real = await realpath(file);
    const big = 2n ** 53n;
    strictEqual(Number(big + 1n), Number(big), 'the fixture is two inodes a Number cannot tell apart');
    // The fake honors the options: asked without bigint, it answers with
    // Numbers, as Node does, so the reader must ask for bigints.
    const inode = (value, options) => (options?.bigint ? value : Number(value));
    const io = {
      ...ENTRY_READER_IO,
      stat: async (path, options) => {
        const st = await ENTRY_READER_IO.stat(path, options);
        return path === real ? { dev: st.dev, ino: inode(big + 1n, options), isFile: () => true } : st;
      },
      // After the open the path names the opened inode, so only the checked
      // and opened identities differ (peer verify: a real inode here hid a
      // Number comparison behind a different mismatch).
      lstat: async (path, options) => {
        const st = await ENTRY_READER_IO.lstat(path, options);
        return path === real ? { dev: st.dev, ino: inode(big, options), isSymbolicLink: () => false } : st;
      },
      openReadOnly: async (path) => {
        const handle = await ENTRY_READER_IO.openReadOnly(path);
        return {
          stat: async (options) => {
            const st = await handle.stat(options);
            return { dev: st.dev, ino: inode(big, options), isFile: () => st.isFile() };
          },
          read: (...args) => handle.read(...args),
          close: () => handle.close(),
        };
      },
    };
    const result = await readPersonaWorkflowSource({ repoRoot: root, persona: 'engineer', branch: 'feat/x', io });
    deepStrictEqual([result.status, result.reason], ['indeterminate', 'workflow-identity-changed']);
  });
});

// ---------------------------------------------------------------------------

describe('entry-brief readers — skipped sources and the reason registry', () => {
  it('names every reason the source degrades with in the registry, and every registry code in use', async () => {
    const source = await readFile(new URL('../../plugins/runtime/scripts/lib/entry-brief-readers.mjs', import.meta.url), 'utf8');
    const found = new Set();
    for (const call of source.matchAll(/indeterminate\(\s*\w+\s*,([^)]*)\)/g)) {
      for (const quoted of call[1].matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)) found.add(quoted[1]);
    }
    for (const field of source.matchAll(/reason:\s*'([a-z0-9-]+)'/g)) found.add(field[1]);
    ok(found.size >= 30, `the extraction found ${found.size} codes`);
    for (const code of found) ok(ENTRY_READER_REASON_CODES.has(code), `${code} is outside the registry`);
    for (const code of ENTRY_READER_REASON_CODES) {
      ok(source.split(`'${code}'`).length - 1 >= 2, `${code} is in the registry and never used`);
    }
  });

  it('carries each degraded source with its name and reason through the collector', async () => {
    const root = await makeRepo();
    const target = await outsideFile(personaFm({ branch: 'feat/x' }));
    await mkdir(join(personaHome(root, 'engineer'), 'workflows'), { recursive: true });
    await symlink(target, join(personaHome(root, 'engineer'), 'workflows', 'out.md'));
    await writeSlot(root, 'founder', slotProjection({ workflow_kind: 'designer' }), { mtimeMs: T0 - 60_000 });
    await writeEntryCapture(root, entryDoc({ origin: 'not-a-hook' }));
    const result = await collectEntrySources({ repoRoot: root, branchProbe: () => 'feat/x', now: T0 });
    deepStrictEqual(result.skipped_sources, [
      { source: 'persona-workflow', kind: 'engineer', reason: 'symlink-outside-state' },
      { source: 'handoff-slot', kind: 'founder', reason: 'slot-kind-mismatch' },
      { source: 'entry-capture', kind: null, reason: 'entry-validation-failed' },
    ]);
    strictEqual(result.sources_skipped, 3);
  });

  it('lists the sources in fixed order and withholds a reason outside the registry', () => {
    const sources = {
      personas: { designer: { status: 'indeterminate', reason: 'scan-overflow' }, engineer: { status: 'ok' } },
      macro: { status: 'indeterminate', reason: `made-up ${IMPERATIVE}` },
      handoff_slots: { orchestrator: { status: 'indeterminate', reason: 'marker-malformed' } },
      consensus_open: { status: 'indeterminate', reason: 'unreadable-directory' },
    };
    deepStrictEqual(skippedSourcesOf(sources), [
      { source: 'persona-workflow', kind: 'designer', reason: 'scan-overflow' },
      { source: 'macro', kind: 'orchestrator', reason: null },
      { source: 'handoff-slot', kind: 'orchestrator', reason: 'marker-malformed' },
      { source: 'consensus-open', kind: null, reason: 'unreadable-directory' },
    ]);
  });
});
