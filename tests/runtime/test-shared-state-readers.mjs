// ADR-0067 Decision 4, item 1 (macro subtask RR) — runtime's workflow readers
// read the read set: the default state root, where git placed the main
// worktree, then the checkout when it differs. From a linked worktree the
// entry brief, the dashboard and doctor see a workflow stored under the main
// worktree and one stored locally; pointers stay relative to the state root
// they were found under, so the arbiter's hardening renders them; the handoff
// slots and the session capture stay the checkout's own (W9).
//
// The repositories here are real: `git init` plus `git worktree add`, so the
// spawn-free state-root computation is checked against what git itself says.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENTRY_READER_CAPS,
  ENTRY_READER_IO,
  collectEntrySources,
  readEntryCaptureSource,
  readHandoffSlotSource,
  readMacroSources,
  readPersonaWorkflowSource,
} from '../../plugins/runtime/scripts/lib/entry-brief-readers.mjs';
import { arbitrateEntryBrief } from '../../plugins/runtime/scripts/lib/entry-brief-arbiter.mjs';
import {
  WORKFLOW_SCAN_ATTEMPTS,
  inspectWorkflowNamespace,
  readTextIfExists,
  scanWorkflowFiles,
} from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { defaultStateRoot, stateReadSet } from '../../plugins/runtime/scripts/lib/state-root.mjs';
import { buildDashboardReport } from '../../plugins/runtime/scripts/dashboard.mjs';
import { runDoctor } from '../../plugins/runtime/scripts/doctor.mjs';
import { readFreshProjection } from '../../plugins/attention/scripts/lib/sensor.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date();
const NOW_MS = NOW.getTime();

// The environment git runs in: nothing inherited may point it at another
// repository or index.
function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE)$/.test(key)) delete env[key];
  }
  return env;
}

function git(cwd, args) {
  const result = spawnSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
    ...args,
  ], { cwd, encoding: 'utf8', env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A main checkout and one linked worktree on `feat/lane`.
async function makeLinkedRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'shared-state-readers-')));
  const main = join(base, 'main');
  await mkdir(main);
  git(main, ['init', '-q']);
  git(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const lane = join(base, 'lane');
  git(main, ['worktree', 'add', '-q', '-b', 'feat/lane', lane]);
  return { base, main, lane };
}

function workflowsDir(root, plugin) {
  return join(root, '.agentic-plugins', 'state', plugin, 'workflows');
}

async function writeWorkflow(root, plugin, file, body) {
  const dir = workflowsDir(root, plugin);
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, body);
  return path;
}

function personaFm({ id, branch, persona = 'engineer' }) {
  return [
    '---',
    'schema: "1.3"',
    `workflow_id: ${JSON.stringify(id)}`,
    `persona: ${JSON.stringify(persona)}`,
    'verb: "compose"',
    `updated_at: ${JSON.stringify(new Date(NOW_MS - 60_000).toISOString())}`,
    'git_baseline:',
    `  branch: ${JSON.stringify(branch)}`,
    '  head: "abc1234abc1234abc1234abc1234abc1234abc12"',
    'current_phase: "phase-2-presented"',
    '---',
    '',
    'body',
  ].join('\n');
}

function macroFm({ id, subtasks, branch = 'main' }) {
  const lines = [
    '---',
    'schema: "1.2"',
    `workflow_id: ${JSON.stringify(id)}`,
    'workflow_type: "macro"',
    `updated_at: ${JSON.stringify(new Date(NOW_MS - 60_000).toISOString())}`,
    'git_baseline:',
    `  branch: ${JSON.stringify(branch)}`,
    '  head: "abc1234abc1234abc1234abc1234abc1234abc12"',
    'current_phase: "phase-3-dispatch"',
    'plan:',
    '  subtasks:',
  ];
  for (const st of subtasks) {
    lines.push(`    - id: ${JSON.stringify(st.id)}`);
    lines.push(`      branch: ${JSON.stringify(st.branch)}`);
    lines.push(`      blocked_by: []`);
    lines.push(`      status: ${JSON.stringify(st.status)}`);
  }
  lines.push('---', '', 'body');
  return lines.join('\n');
}

const ENG_MAIN = 'compose-20261008T010000Z-aaa111';
const ENG_LANE = 'refine-20261008T020000Z-bbb222';
const FOUNDER_LANE = 'frame-20261008T030000Z-ccc333';
const MACRO = 'macro-plan-20261008T000000Z-ddd444';

async function seedSlot(root, persona, workflowId) {
  const home = join(root, '.agentic-plugins', 'state', persona);
  await mkdir(home, { recursive: true });
  const slot = join(home, 'last-session-handoff.json');
  await writeFile(slot, JSON.stringify({ workflow_kind: persona, workflow_id: workflowId, workflow_path: 'x.md', phase: 'summary-complete' }));
  await utimes(slot, new Date(NOW_MS - 30_000), new Date(NOW_MS - 30_000));
  await writeFile(`${slot}.footer-rendered`, JSON.stringify({ workflow_id: workflowId, status: 'rendered', at: new Date(NOW_MS - 30_000).toISOString() }));
}

// The session-entry schema takes second-precision UTC timestamps.
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function entryDoc(branch) {
  return {
    schema: 'runtime-session-entry-1.0',
    captured_at: isoSeconds(NOW_MS - 60_000),
    origin: 'stop-hook',
    summary_source: 'staged-note',
    host: 'claude',
    branch,
    head_short: 'abc1234',
    dirty_count: 0,
    repo_recent_terminal_evidence: 'fresh',
    summary_line: 'summary',
    note_staged_at: isoSeconds(NOW_MS - 120_000),
    fingerprint: `fp1:${'a'.repeat(64)}`,
  };
}

async function seedEntryCapture(root, branch) {
  const dir = join(root, '.agentic-plugins', 'state', 'runtime', 'session-capture');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'entry.json'), JSON.stringify(entryDoc(branch)));
}

const laneBranch = async () => 'feat/lane';

// The main worktree's legacy home of `plugin` made an alias of its canonical
// home, holding `file`, and a distinct lane file listed under the same
// legacy-relative spelling. Resolved default-root-first, that spelling
// reaches the main file through the alias.
async function seedAliasedSpelling({ main, lane, plugin, file, mainBody, laneBody }) {
  await writeWorkflow(main, plugin, file, mainBody);
  await mkdir(join(main, '.claude'), { recursive: true });
  await symlink(join(main, '.agentic-plugins', 'state', plugin), join(main, '.claude', `agentic-${plugin}`));
  const laneLegacy = join(lane, '.claude', `agentic-${plugin}`, 'workflows');
  await mkdir(laneLegacy, { recursive: true });
  await writeFile(join(laneLegacy, file), laneBody);
  const spelling = `.claude/agentic-${plugin}/workflows/${file}`;
  // The fixture is the hazard: under the default state root the spelling
  // names the main file, not the lane's.
  strictEqual(await realpath(join(main, spelling)), join(workflowsDir(main, plugin), file));
  return spelling;
}

// ---------------------------------------------------------------------------

describe('ADR-0067 read set — the default state root', () => {
  it('is the main worktree from a linked worktree, as git computes it, and the checkout itself in the main one', async () => {
    const { main, lane } = await makeLinkedRepo();
    const gitSays = dirname(git(lane, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    strictEqual(await realpath(defaultStateRoot(lane)), await realpath(gitSays));
    strictEqual(defaultStateRoot(lane), main);
    deepStrictEqual(await stateReadSet(lane), [
      { location: 'default-state-root', root: main },
      { location: 'checkout', root: lane },
    ]);
    deepStrictEqual(await stateReadSet(main), [{ location: 'checkout', root: main }]);

    // A separate git dir: git places the main worktree at the git dir's parent
    // (ADR-0067 Decision 1(a)), and so does this computation.
    const base = await realpath(await mkdtemp(join(tmpdir(), 'shared-state-sep-')));
    const store = join(base, 'store');
    const checkout = join(base, 'checkout');
    await mkdir(store);
    await mkdir(checkout);
    git(checkout, ['init', '-q', '--separate-git-dir', join(store, '.git')]);
    strictEqual(defaultStateRoot(checkout), dirname(git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
    strictEqual(defaultStateRoot(checkout), store);
  });

  it('reads commondir from the physical git dir when the gitdir is reached through a symlink, as git does', async () => {
    const { base, main, lane } = await makeLinkedRepo();
    await symlink(join(main, '.git', 'worktrees'), join(base, 'worktrees-link'));
    await writeFile(join(lane, '.git'), `gitdir: ${join(base, 'worktrees-link', 'lane')}\n`);
    const gitSays = dirname(git(lane, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    strictEqual(await realpath(gitSays), main);
    strictEqual(defaultStateRoot(lane), main);
  });

  it('leaves the checkout as its own state root when the common dir is not named .git', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'shared-state-bare-')));
    const commonDir = join(base, 'repo.git');
    const gitDir = join(commonDir, 'worktrees', 'w');
    const checkout = join(base, 'w');
    await mkdir(gitDir, { recursive: true });
    await mkdir(checkout);
    await writeFile(join(checkout, '.git'), `gitdir: ${gitDir}\n`);
    await writeFile(join(gitDir, 'commondir'), '../..\n');
    strictEqual(defaultStateRoot(checkout), checkout);
    deepStrictEqual(await stateReadSet(checkout), [{ location: 'checkout', root: checkout }]);
  });
});

describe('ADR-0067 RR — the entry brief from a linked worktree', () => {
  it('finds a workflow stored under the main worktree and one stored in the linked worktree', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/lane' }));
    await writeWorkflow(lane, 'founder', 'f.md', personaFm({ id: FOUNDER_LANE, branch: 'feat/lane', persona: 'founder' }));
    const collected = await collectEntrySources({ repoRoot: lane, branchProbe: laneBranch, now: NOW_MS });
    const { engineer, founder } = collected.sources.personas;
    strictEqual(engineer.status, 'ok');
    strictEqual(engineer.active.workflow_id, ENG_MAIN);
    strictEqual(engineer.active.pointer, '.agentic-plugins/state/engineer/workflows/a.md');
    strictEqual(founder.status, 'ok');
    strictEqual(founder.active.workflow_id, FOUNDER_LANE);
    strictEqual(founder.active.pointer, '.agentic-plugins/state/founder/workflows/f.md');
  });

  it('renders a pointer into the main worktree through the arbiter hardening, resolvable in the read set', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/lane' }));
    await writeWorkflow(main, 'orchestrator', `${MACRO}.md`, macroFm({
      id: MACRO,
      subtasks: [{ id: 'S1', branch: 'feat/lane', status: 'in_progress' }],
    }));
    const collected = await collectEntrySources({ repoRoot: lane, branchProbe: laneBranch, now: NOW_MS });
    const brief = arbitrateEntryBrief({ collected, dirtyCount: 0, host: 'claude', nowMs: NOW_MS });
    strictEqual(brief.disposition, 'lead');
    strictEqual(brief.leading.id, ENG_MAIN);
    strictEqual(brief.leading.pointer, '.agentic-plugins/state/engineer/workflows/a.md');
    const bridgeRow = brief.rows.find((entry) => entry.source === 'macro-bridge');
    ok(bridgeRow, 'the macro under the main worktree bridges the lane branch');
    strictEqual(bridgeRow.pointer, `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`);
    // Decision 1(c): resolved in the lane's read set, the default state root
    // first, each pointer names the file the reader read.
    for (const pointer of [brief.leading.pointer, bridgeRow.pointer]) {
      ok(existsSync(join(main, pointer)), `${pointer} resolves under the default state root`);
      ok(!existsSync(join(lane, pointer)), `${pointer} is not a lane file`);
    }
  });

  it('reports two files for one branch across the roots, or one workflow id in two files, as ambiguity', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/lane' }));
    await writeWorkflow(lane, 'engineer', 'b.md', personaFm({ id: ENG_LANE, branch: 'feat/lane' }));
    const pair = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane' });
    strictEqual(pair.status, 'indeterminate');
    strictEqual(pair.reason, 'cross-root-ambiguity');

    // The same id copied into the lane, edited onto another branch.
    await rm(join(workflowsDir(lane, 'engineer'), 'b.md'));
    await writeWorkflow(lane, 'engineer', 'a-copy.md', personaFm({ id: ENG_MAIN, branch: 'feat/other' }));
    const copy = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane' });
    strictEqual(copy.status, 'indeterminate');
    strictEqual(copy.reason, 'duplicate-workflow-id');
  });

  it('reports one pointer spelling naming a different file under each root as ambiguity', async () => {
    const { main, lane } = await makeLinkedRepo();
    // Read default-root-first, the lane's pointer would reach the main file.
    await writeWorkflow(main, 'engineer', 'same.md', personaFm({ id: ENG_MAIN, branch: 'feat/other' }));
    await writeWorkflow(lane, 'engineer', 'same.md', personaFm({ id: ENG_LANE, branch: 'feat/lane' }));
    const source = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane' });
    strictEqual(source.status, 'indeterminate');
    strictEqual(source.reason, 'duplicate-pointer');
  });

  it('counts the spelling of an alias: a lane file under a symlinked main home\'s spelling is ambiguity', async () => {
    const { main, lane } = await makeLinkedRepo();
    await seedAliasedSpelling({
      main, lane, plugin: 'engineer', file: 'same.md',
      mainBody: personaFm({ id: ENG_MAIN, branch: 'feat/other' }),
      laneBody: personaFm({ id: ENG_LANE, branch: 'feat/lane' }),
    });
    const persona = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane' });
    strictEqual(persona.status, 'indeterminate');
    strictEqual(persona.reason, 'duplicate-pointer');

    // The macro reader, with a lane macro that bridges the lane branch.
    await seedAliasedSpelling({
      main, lane, plugin: 'orchestrator', file: 'macro.md',
      mainBody: macroFm({ id: MACRO, subtasks: [{ id: 'T1', branch: 'feat/elsewhere', status: 'pending' }] }),
      laneBody: macroFm({
        id: 'macro-plan-20261008T050000Z-eee555',
        branch: 'feat/lane-integration',
        subtasks: [{ id: 'S1', branch: 'feat/lane', status: 'in_progress' }],
      }),
    });
    const macro = await readMacroSources({ repoRoot: lane, branch: 'feat/lane' });
    strictEqual(macro.status, 'indeterminate');
    strictEqual(macro.reason, 'duplicate-pointer');

    // Neither leads: the brief never relays a pointer that names the main file.
    const collected = await collectEntrySources({ repoRoot: lane, branchProbe: laneBranch, now: NOW_MS });
    const brief = arbitrateEntryBrief({ collected, dirtyCount: 0, host: 'claude', nowMs: NOW_MS });
    strictEqual(brief.leading, null);
  });

  it('reports a second macro on the bridged macro\'s integration branch as ambiguity', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'orchestrator', `${MACRO}.md`, macroFm({
      id: MACRO,
      subtasks: [{ id: 'S1', branch: 'feat/lane', status: 'pending' }],
    }));
    await writeWorkflow(lane, 'orchestrator', 'macro-plan-20261008T050000Z-eee555.md', macroFm({
      id: 'macro-plan-20261008T050000Z-eee555',
      subtasks: [{ id: 'T1', branch: 'feat/elsewhere', status: 'pending' }],
    }));
    const source = await readMacroSources({ repoRoot: lane, branch: 'feat/lane' });
    strictEqual(source.status, 'indeterminate');
    strictEqual(source.reason, 'duplicate-active-macros');
  });

  it('counts the same physical file reached through both roots once', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/lane' }));
    // The precedent's lanes symlinked a state home into the main worktree.
    await mkdir(join(lane, '.agentic-plugins', 'state'), { recursive: true });
    await symlink(join(main, '.agentic-plugins', 'state', 'engineer'), join(lane, '.agentic-plugins', 'state', 'engineer'));
    const source = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane' });
    strictEqual(source.status, 'ok');
    strictEqual(source.active.workflow_id, ENG_MAIN);
    const namespace = await inspectWorkflowNamespace({
      repoRoot: lane, plugin: 'engineer', legacyNamespace: 'agentic-engineer', expectedPlugin: 'engineer', now: NOW, staleGraceMs: 60_000,
    });
    strictEqual(namespace.workflows.count, 1);
    strictEqual(namespace.storage.status, 'canonical');
  });

  it('keeps a legacy home aliasing the canonical home of one state root dual-home ambiguity, as the owners refuse it', async () => {
    const { main } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'main' }));
    await writeWorkflow(main, 'orchestrator', `${MACRO}.md`, macroFm({
      id: MACRO,
      subtasks: [{ id: 'S1', branch: 'feat/lane', status: 'pending' }],
    }));
    await mkdir(join(main, '.claude'), { recursive: true });
    for (const plugin of ['engineer', 'orchestrator']) {
      await symlink(join(main, '.agentic-plugins', 'state', plugin), join(main, '.claude', `agentic-${plugin}`));
    }
    // The owners' own lookups refuse the layout: the readers mirror them.
    for (const plugin of ['engineer', 'orchestrator']) {
      const owner = await import(join(REPO_ROOT, 'plugins', plugin, 'scripts', 'state.mjs'));
      await owner.findActiveWorkflowByBranch(main, 'main').then(
        () => { throw new Error(`the ${plugin} owner accepted an aliased legacy home`); },
        (error) => ok(/Ambiguous .* workflow storage/.test(error.message), error.message),
      );
    }
    const persona = await readPersonaWorkflowSource({ repoRoot: main, persona: 'engineer', branch: 'main' });
    deepStrictEqual([persona.status, persona.reason], ['indeterminate', 'dual-home-ambiguity']);
    const active = await readMacroSources({ repoRoot: main, branch: 'main' });
    deepStrictEqual([active.status, active.reason], ['indeterminate', 'duplicate-active-macros']);
    const bridge = await readMacroSources({ repoRoot: main, branch: 'feat/lane' });
    deepStrictEqual([bridge.status, bridge.reason], ['indeterminate', 'ambiguous-macro-bridge']);
  });

  it('lists a workflows directory again when a listed file vanishes, a bounded number of times', async () => {
    const { lane } = await makeLinkedRepo();
    await writeWorkflow(lane, 'engineer', 'a.md', personaFm({ id: ENG_LANE, branch: 'feat/lane' }));
    const archived = await writeWorkflow(lane, 'engineer', 'archived.md', personaFm({ id: ENG_MAIN, branch: 'feat/other' }));

    // Another checkout archives a file between the listing and its read.
    const { listDir, readFile, realpath: realpathOf } = ENTRY_READER_IO;
    let listings = 0;
    const racing = {
      listDir: async (dir, caps) => {
        if (dir === workflowsDir(lane, 'engineer')) listings++;
        return listDir(dir, caps);
      },
      readFile: async (path, max) => {
        if (path === archived && existsSync(archived)) {
          await rm(archived);
          return { state: 'absent' };
        }
        return readFile(path, max);
      },
      realpath: realpathOf,
    };
    const raced = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane', io: racing });
    strictEqual(raced.status, 'ok');
    strictEqual(raced.active.workflow_id, ENG_LANE);

    // A file that keeps vanishing still fails closed, after the last listing.
    listings = 0;
    const gone = join(workflowsDir(lane, 'engineer'), 'a.md');
    const persistent = { ...racing, readFile: async (path, max) => (path === gone ? { state: 'absent' } : readFile(path, max)) };
    const stuck = await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane', io: persistent });
    strictEqual(stuck.status, 'indeterminate');
    strictEqual(stuck.reason, 'workflow-file-vanished');
    strictEqual(listings, ENTRY_READER_CAPS.MAX_SCAN_ATTEMPTS);

    // The dashboard and doctor scan takes the same bound.
    let reads = 0;
    const once = await scanWorkflowFiles(workflowsDir(lane, 'engineer'), {
      readText: async (path) => (path === gone && reads++ === 0 ? { ok: false, path, reason: 'ENOENT' } : readTextIfExists(path)),
    });
    strictEqual(once.status, 'available');
    strictEqual(once.count, 1);
    let attempts = 0;
    const always = await scanWorkflowFiles(workflowsDir(lane, 'engineer'), {
      readText: async (path) => (path === gone ? (attempts++, { ok: false, path, reason: 'ENOENT' }) : readTextIfExists(path)),
    });
    strictEqual(always.status, 'blocked');
    strictEqual(attempts, WORKFLOW_SCAN_ATTEMPTS);
  });

  it('keeps the handoff slots and the session capture the checkout\'s own (W9)', async () => {
    const { main, lane } = await makeLinkedRepo();
    await seedSlot(main, 'engineer', ENG_MAIN);
    await seedEntryCapture(main, 'feat/lane');
    strictEqual((await readHandoffSlotSource({ repoRoot: lane, persona: 'engineer', nowMs: NOW_MS })).status, 'absent');
    strictEqual((await readEntryCaptureSource({ repoRoot: lane, branch: 'feat/lane' })).status, 'absent');
    strictEqual(readFreshProjection({ repoRoot: lane, persona: 'engineer', now: NOW_MS }), null);

    await seedSlot(lane, 'engineer', ENG_LANE);
    await seedEntryCapture(lane, 'feat/lane');
    const slot = await readHandoffSlotSource({ repoRoot: lane, persona: 'engineer', nowMs: NOW_MS });
    strictEqual(slot.status, 'ok');
    strictEqual(slot.workflow_id, ENG_LANE);
    strictEqual((await readEntryCaptureSource({ repoRoot: lane, branch: 'feat/lane' })).status, 'ok');
    strictEqual(readFreshProjection({ repoRoot: lane, persona: 'engineer', now: NOW_MS })?.workflowId, ENG_LANE);
  });
});

describe('ADR-0067 RR — the dashboard and doctor from a linked worktree', () => {
  it('the dashboard lists a workflow and a macro stored under the main worktree beside one stored locally', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/other' }));
    await writeWorkflow(lane, 'engineer', 'b.md', personaFm({ id: ENG_LANE, branch: 'feat/lane' }));
    await writeWorkflow(main, 'orchestrator', `${MACRO}.md`, macroFm({
      id: MACRO,
      subtasks: [{ id: 'S1', branch: 'feat/lane', status: 'in_progress' }],
    }));
    const home = await mkdtemp(join(tmpdir(), 'shared-state-home-'));
    const report = await buildDashboardReport({ repoRoot: lane, homeDir: home, now: NOW });
    const active = report.tier1.personas.engineer.workflows.active.map((row) => row.workflow_id).sort();
    deepStrictEqual(active, [ENG_MAIN, ENG_LANE].sort());
    strictEqual(report.tier1.macros.count, 1);
    strictEqual(report.tier1.macros.macros[0].workflow_id, MACRO);
    strictEqual(report.tier1.macros.macros[0].pointer, `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`);
  });

  it('doctor reads both roots into its ledgers, and names both files of an ambiguity', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/other' }));
    await writeWorkflow(lane, 'engineer', 'b.md', personaFm({ id: ENG_LANE, branch: 'feat/lane' }));
    const home = await mkdtemp(join(tmpdir(), 'shared-state-home-'));
    const runner = async (command) => ({
      ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false,
    });
    const report = await runDoctor({ repoRoot: lane, homeDir: home, now: NOW, runner, format: 'json' });
    const ledger = report.ledgers.engineer;
    deepStrictEqual(
      ledger.workflows.files.map(({ workflow_id, location, pointer }) => ({ workflow_id, location, pointer })),
      [
        { workflow_id: ENG_MAIN, location: 'default-state-root', pointer: '.agentic-plugins/state/engineer/workflows/a.md' },
        { workflow_id: ENG_LANE, location: 'checkout', pointer: '.agentic-plugins/state/engineer/workflows/b.md' },
      ],
    );
    strictEqual(ledger.storage.status, 'canonical');
    deepStrictEqual(ledger.storage.locations.map(({ location, status }) => [location, status]), [
      ['default-state-root', 'canonical'],
      ['checkout', 'canonical'],
    ]);

    await writeWorkflow(lane, 'engineer', 'c.md', personaFm({ id: ENG_MAIN, branch: 'feat/third' }));
    const again = await runDoctor({ repoRoot: lane, homeDir: home, now: NOW, runner, format: 'json' });
    const storage = again.ledgers.engineer.storage;
    strictEqual(storage.status, 'ambiguous');
    deepStrictEqual(storage.ambiguities, [{
      kind: 'workflow_id',
      value: ENG_MAIN,
      files: [
        { location: 'default-state-root', pointer: '.agentic-plugins/state/engineer/workflows/a.md' },
        { location: 'checkout', pointer: '.agentic-plugins/state/engineer/workflows/c.md' },
      ],
    }]);
    ok(storage.recommendation.includes('.agentic-plugins/state/engineer/workflows/c.md (checkout)'));
  });
});

describe('ADR-0067 RR — what the namespace counts as ambiguity', () => {
  const inspect = (repoRoot) => inspectWorkflowNamespace({
    repoRoot, plugin: 'engineer', legacyNamespace: 'agentic-engineer', expectedPlugin: 'engineer', now: NOW, staleGraceMs: 60_000,
  });

  it('checks every home, not only the one selected for display', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/shared' }));
    // The lane holds both homes, so its legacy home is not the displayed one.
    await writeWorkflow(lane, 'engineer', 'c.md', personaFm({ id: FOUNDER_LANE, branch: 'feat/unrelated' }));
    const legacyDir = join(lane, '.claude', 'agentic-engineer', 'workflows');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'b.md'), personaFm({ id: ENG_LANE, branch: 'feat/shared' }));
    const namespace = await inspect(lane);
    strictEqual(namespace.storage.status, 'ambiguous');
    deepStrictEqual(namespace.storage.ambiguities.map(({ kind, files }) => [kind, files.map(({ pointer }) => pointer)]), [
      ['branch', ['.agentic-plugins/state/engineer/workflows/a.md', '.claude/agentic-engineer/workflows/b.md']],
    ]);
  });

  it('compares raw values: two branches that display alike once redacted are two branches', async () => {
    const { main } = await makeLinkedRepo();
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: `feat/${'a'.repeat(40)}` }));
    await writeWorkflow(main, 'engineer', 'b.md', personaFm({ id: ENG_LANE, branch: `feat/${'b'.repeat(40)}` }));
    const namespace = await inspect(main);
    const shown = namespace.workflows.files.map(({ branch }) => branch);
    strictEqual(shown[0], shown[1], 'the fixture is two branches the report displays alike');
    deepStrictEqual(namespace.storage.ambiguities, []);
    strictEqual(namespace.storage.status, 'canonical');
  });

  it('counts the spelling of an alias, as the entry brief does', async () => {
    const { main, lane } = await makeLinkedRepo();
    const spelling = await seedAliasedSpelling({
      main, lane, plugin: 'engineer', file: 'same.md',
      mainBody: personaFm({ id: ENG_MAIN, branch: 'feat/other' }),
      laneBody: personaFm({ id: ENG_LANE, branch: 'feat/lane' }),
    });
    const namespace = await inspect(lane);
    deepStrictEqual(namespace.storage.ambiguities, [{
      kind: 'pointer',
      value: spelling,
      files: [
        { location: 'default-state-root', pointer: spelling },
        { location: 'checkout', pointer: spelling },
      ],
    }]);
    strictEqual(namespace.storage.status, 'ambiguous');
  });

  it('blocks the ledger on a directory of any home in the read set that exists and cannot be listed', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(lane, 'engineer', 'b.md', personaFm({ id: ENG_LANE, branch: 'feat/lane' }));
    await writeWorkflow(main, 'engineer', 'a.md', personaFm({ id: ENG_MAIN, branch: 'feat/other' }));
    // Absent directories (the legacy homes, both peer-run ledgers) are no state.
    const clean = await inspect(lane);
    strictEqual(clean.workflows.status, 'available');
    strictEqual(clean.peer_runs.status, 'missing');
    deepStrictEqual([clean.workflows.unlisted, clean.peer_runs.unlisted], [[], []]);

    // The main worktree's legacy `workflows/` is a regular file. That home is
    // not the one selected for display (the canonical home holds a.md), and
    // the entry brief degrades on it all the same.
    const mainLegacyWorkflows = join(main, '.claude', 'agentic-engineer', 'workflows');
    await mkdir(dirname(mainLegacyWorkflows), { recursive: true });
    await writeFile(mainLegacyWorkflows, 'not a directory');
    strictEqual((await readPersonaWorkflowSource({ repoRoot: lane, persona: 'engineer', branch: 'feat/lane' })).status, 'indeterminate');
    const holed = await inspect(lane);
    strictEqual(holed.workflows.status, 'blocked');
    deepStrictEqual(holed.workflows.unlisted, [{ location: 'default-state-root', dir: mainLegacyWorkflows, error: 'ENOTDIR' }]);
    const home = await mkdtemp(join(tmpdir(), 'shared-state-home-'));
    const runner = async (command) => ({
      ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false,
    });
    const report = await runDoctor({ repoRoot: lane, homeDir: home, now: NOW, runner, format: 'json' });
    strictEqual(report.experience_parity.criteria.find(({ id }) => id === 'workflow_continuity_storage').status, 'blocked');

    // A peer-run ledger directory that cannot be listed blocks the same way.
    await rm(mainLegacyWorkflows);
    const mainPeerRuns = join(main, '.agentic-plugins', 'state', 'engineer', 'peer-runs');
    await writeFile(mainPeerRuns, 'not a directory');
    const runs = await inspect(lane);
    strictEqual(runs.workflows.status, 'available');
    strictEqual(runs.peer_runs.status, 'blocked');
    deepStrictEqual(runs.peer_runs.unlisted, [{ location: 'default-state-root', dir: mainPeerRuns, error: 'ENOTDIR' }]);
  });
});

describe('the RR collision check (scripts/check-state-collisions.mjs)', () => {
  it('lists a branch key held in the main worktree and in a linked worktree, and passes once one is gone', async () => {
    const { main, lane } = await makeLinkedRepo();
    await writeWorkflow(main, 'orchestrator', `${MACRO}.md`, macroFm({ id: MACRO, subtasks: [] }));
    const laneMacro = await writeWorkflow(lane, 'orchestrator', 'macro-plan-20261008T050000Z-eee555.md', macroFm({ id: 'macro-plan-20261008T050000Z-eee555', subtasks: [] }));
    const run = () => spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-state-collisions.mjs'), '--repo', lane, '--format', 'json'], { encoding: 'utf8', env: gitEnv() });

    const found = run();
    strictEqual(found.status, 1, found.stderr);
    const report = JSON.parse(found.stdout);
    strictEqual(report.default_state_root, main);
    deepStrictEqual(report.collisions.map(({ checkout, plugin, key, value }) => ({ checkout, plugin, key, value })), [
      { checkout: lane, plugin: 'orchestrator', key: 'branch', value: 'main' },
    ]);
    deepStrictEqual(report.collisions[0].files.map(({ location }) => location), ['default-state-root', 'checkout']);

    await rm(laneMacro);
    const clean = run();
    strictEqual(clean.status, 0, clean.stdout + clean.stderr);
    deepStrictEqual(JSON.parse(clean.stdout).collisions, []);

    // A file whose branch cannot be read degrades the readers as a pair does.
    const branchless = await writeWorkflow(lane, 'engineer', 'nobranch.md', '---\nschema: "1.3"\nworkflow_id: "compose-20261008T060000Z-fff666"\n---\n');
    const unread = run();
    strictEqual(unread.status, 1, unread.stdout + unread.stderr);
    deepStrictEqual(JSON.parse(unread.stdout).unreadable, [{ checkout: lane, plugin: 'engineer', path: branchless }]);

    // A `workflows/` directory that cannot be listed leaves a hole in the
    // inventory, which is not a clean result.
    await rm(branchless);
    const founderWorkflows = workflowsDir(lane, 'founder');
    await mkdir(dirname(founderWorkflows), { recursive: true });
    await writeFile(founderWorkflows, 'not a directory');
    const holed = run();
    strictEqual(holed.status, 1, holed.stdout + holed.stderr);
    deepStrictEqual(JSON.parse(holed.stdout).unreadable, [{ checkout: lane, plugin: 'founder', path: founderWorkflows }]);
  });

  it('lists a lane file under the spelling of a symlinked main home as a pointer collision', async () => {
    const { main, lane } = await makeLinkedRepo();
    const spelling = await seedAliasedSpelling({
      main, lane, plugin: 'engineer', file: 'same.md',
      mainBody: personaFm({ id: ENG_MAIN, branch: 'feat/other' }),
      laneBody: personaFm({ id: ENG_LANE, branch: 'feat/lane' }),
    });
    // The lane's canonical home is the main one through a symlink, as the
    // precedent's lanes had it: one file listed twice under one spelling is
    // no pair.
    await mkdir(join(lane, '.agentic-plugins', 'state'), { recursive: true });
    await symlink(join(main, '.agentic-plugins', 'state', 'engineer'), join(lane, '.agentic-plugins', 'state', 'engineer'));
    const found = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-state-collisions.mjs'), '--repo', lane, '--format', 'json'], { encoding: 'utf8', env: gitEnv() });
    strictEqual(found.status, 1, found.stdout + found.stderr);
    const report = JSON.parse(found.stdout);
    deepStrictEqual(report.collisions, [{
      checkout: lane,
      plugin: 'engineer',
      key: 'pointer',
      value: spelling,
      files: [
        { path: join(main, spelling), location: 'default-state-root' },
        { path: join(lane, spelling), location: 'checkout' },
      ],
    }]);
    deepStrictEqual(report.unreadable, []);
  });
});
