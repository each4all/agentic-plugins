// ADR-0067 Decision 4, item 4 (SR, unit U8a): the operator cutover's plan,
// move and verify, `state.mjs cutover --plan | --move | --verify`
// (plugins/orchestrator/scripts/lib/cutover.mjs).
//
// Real git repositories: a main checkout, the autopilot home worktree `home`
// (on autopilot/home) holding a macro in its own state, as the macro that
// drives this subtask does, and a third worktree `other`. The macro's child
// workflows are created with engineer's own state script.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const ENG_STATE = join(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const FOUNDER_STATE = join(REPO_ROOT, 'plugins/founder/scripts/state.mjs');
const ORCH_HOME = '.agentic-plugins/state/orchestrator';
const ENG_HOME = '.agentic-plugins/state/engineer';
const FOUNDER_HOME = '.agentic-plugins/state/founder';
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MACRO_RUN = 'plan-verify-20261008T000001Z-bbbbbb';
const CHILD_RUN = 'plan-verify-20261008T000002Z-cccccc';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const node = (script, args, cwd = undefined) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: cleanEnv(), cwd });
const orch = (args, cwd = undefined) => node(ORCH_STATE, args, cwd);
const eng = (args) => node(ENG_STATE, args);
const must = (r) => {
  strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const cutover = (checkout, mode) => {
  const r = orch(['cutover', '--repo-root', checkout, `--${mode}`]);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* left null: the assertion names stderr */
  }
  return { ...r, json };
};
const codes = (result) => (result.json?.refusals ?? []).map((x) => x.code);
const cutoverAsync = (checkout, mode) => new Promise((resolve) => {
  const child = spawn(process.execPath, [ORCH_STATE, 'cutover', '--repo-root', checkout, `--${mode}`], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stderr }));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Wait until `cond` holds, up to `ms` (inside acquireLock's 5 s budget), so a
// loaded machine waits for the move to reach the lock instead of failing or
// passing by timing.
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(25);
  }
  return true;
};
const manifestIn = (main) => {
  try {
    const dir = join(main, '.agentic-plugins/runs/cutover');
    const [name] = readdirSync(dir).filter((n) => n.endsWith('.json'));
    return name ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null;
  } catch {
    return null;
  }
};
const notStrictEqualPath = (a, b) => ok(a !== b, `${a} is not ${b}`);

function ledger(root, home, runId) {
  const d = join(root, home, 'peer-runs', runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'handle.json'), JSON.stringify({ run_id: runId, status: 'completed' }));
  return d;
}

function engCreate(r, checkout, branch, parent = true) {
  return must(eng([
    'create', '--repo-root', checkout, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
    '--git-baseline-branch', branch, '--git-baseline-head', r.head, '--status-digest', DIGEST,
    '--original-request', 'cutover fixture child',
    ...(parent ? ['--parent-workflow', r.macroId, '--originating-subtask', 'T1'] : []),
  ]));
}

// A macro in `macroAt`'s own home with one finished ensemble, an active
// child and an archived child in `childAt`, each with its ledger, and a
// workflow of no macro beside them.
function setup({ macroAt = 'home', childAt = 'home', ledgers = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cutover-')));
  const main = join(dir, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'add', 'README.md');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'autopilot/home', join(dir, 'home'));
  git(main, 'worktree', 'add', '-q', '-b', 'feat/other', join(dir, 'other'));
  const r = {
    dir,
    main: realpathSync(main),
    home: realpathSync(join(dir, 'home')),
    other: realpathSync(join(dir, 'other')),
    head: git(main, 'rev-parse', 'HEAD'),
  };
  const macroRoot = r[macroAt];
  const childRoot = r[childAt];
  r.macro = must(orch([
    'create', '--repo-root', macroRoot, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', 'main', '--git-baseline-head', r.head, '--status-digest', DIGEST,
    '--original-request', 'cutover fixture macro',
  ]));
  r.macroId = basename(r.macro, '.md');
  const subtasks = join(dir, 'subtasks.json');
  writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' }]));
  must(orch(['plan-set', '--workflow-path', r.macro, '--host', 'claude', '--subtasks-json-file', subtasks]));
  must(orch(['ensemble-pending', '--workflow-path', r.macro, '--phase', 'plan', '--ensemble-type', 'plan-verify', '--run-id', MACRO_RUN]));
  must(orch(['ensemble-commit', '--workflow-path', r.macro, '--phase', 'plan', '--ensemble-type', 'plan-verify', '--run-id', MACRO_RUN, '--verdict', 'agreed', '--summary', 'ok']));
  r.macroLedger = ledgers ? ledger(macroRoot, ORCH_HOME, MACRO_RUN) : null;

  const childBranch = childAt === 'home' ? 'autopilot/home' : 'feat/other';
  r.child = engCreate(r, childRoot, childBranch);
  r.childId = basename(r.child, '.md');
  must(eng(['ensemble-pending', '--workflow-path', r.child, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', CHILD_RUN]));
  must(eng(['ensemble-commit', '--workflow-path', r.child, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', CHILD_RUN, '--verdict', 'agreed', '--summary', 'ok']));
  r.childLedger = ledgers ? ledger(childRoot, ENG_HOME, CHILD_RUN) : null;

  const old = engCreate(r, childRoot, 'feat/old');
  mkdirSync(join(childRoot, ENG_HOME, 'archive'), { recursive: true });
  r.archived = join(childRoot, ENG_HOME, 'archive', basename(old));
  renameSync(old, r.archived);
  r.unrelated = engCreate(r, childRoot, 'feat/unrelated', false);
  r.macroRoot = macroRoot;
  r.childRoot = childRoot;
  return r;
}

// Every file under the three checkouts' .agentic-plugins and .claude, with a
// digest of its content: what a read-only command must leave as it was.
function snapshotState(r) {
  const out = [];
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(r.dir, p)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  for (const root of [r.main, r.home, r.other]) {
    walk(join(root, '.agentic-plugins'));
    walk(join(root, '.claude'));
  }
  return out;
}

const dest = (r, home, dir, name) => join(r.main, home, dir, name);

// A macro on feat/<name> with one subtask (feat/<name>1) and an active child
// of it, created in `at`'s own homes: before the switch as any create there,
// after it as a session whose AGENTIC_STATE_BASE names that checkout.
function macroWithChild(r, at, name, { base = false } = {}) {
  const env = base ? { ...cleanEnv(), AGENTIC_STATE_BASE: at } : cleanEnv();
  const run = (script, args) => must(spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env }));
  const macro = run(ORCH_STATE, [
    'create', '--repo-root', at, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', `feat/${name}`, '--git-baseline-head', r.head, '--status-digest', DIGEST,
    '--original-request', `cutover fixture macro ${name}`,
  ]);
  const macroId = basename(macro, '.md');
  const subtasks = join(r.dir, `subtasks-${name}.json`);
  writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: `feat/${name}1`, blocked_by: [], status: 'pending' }]));
  run(ORCH_STATE, ['plan-set', '--workflow-path', macro, '--host', 'claude', '--subtasks-json-file', subtasks]);
  const child = run(ENG_STATE, [
    'create', '--repo-root', at, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
    '--git-baseline-branch', `feat/${name}1`, '--git-baseline-head', r.head, '--status-digest', DIGEST,
    '--original-request', `cutover fixture child ${name}`, '--parent-workflow', macroId, '--originating-subtask', 'T1',
  ]);
  ok(macro.startsWith(join(at, ORCH_HOME)) && child.startsWith(join(at, ENG_HOME)), `in ${at}'s own homes: ${macro}, ${child}`);
  return { macro, macroId, child };
}

// The macro ids the passing macro-resolves checks name, each with the
// checkouts it resolved from, sorted.
const resolvedFrom = (verified) => {
  const out = {};
  for (const c of verified.json.checks.filter((x) => x.id === 'macro-resolves' && x.ok)) {
    const [, id, at] = /^(\S+) from (.*?): /.exec(c.detail);
    (out[id] ??= []).push(at);
  }
  for (const id of Object.keys(out)) out[id].sort();
  return out;
};

describe('state.mjs cutover (ADR-0067 Decision 4, item 4)', () => {
  it("plan lists a linked worktree's macro, its children active and archived, and their ledgers, and changes nothing", () => {
    const r = setup();
    try {
      const before = snapshotState(r);
      const plan = cutover(r.main, 'plan');
      strictEqual(plan.status, 0, plan.stderr);
      strictEqual(plan.json.ok, true);
      deepStrictEqual(plan.json.refusals, []);
      deepStrictEqual(plan.json.pairs.map((p) => [p.kind, p.plugin, p.source, p.destination]), [
        ['peer-run', 'engineer', r.childLedger, dest(r, ENG_HOME, 'peer-runs', CHILD_RUN)],
        ['peer-run', 'orchestrator', r.macroLedger, dest(r, ORCH_HOME, 'peer-runs', MACRO_RUN)],
        ['archive', 'engineer', r.archived, dest(r, ENG_HOME, 'archive', basename(r.archived))],
        ['workflow', 'engineer', r.child, dest(r, ENG_HOME, 'workflows', basename(r.child))],
        ['workflow', 'orchestrator', r.macro, dest(r, ORCH_HOME, 'workflows', basename(r.macro))],
      ]);
      ok(plan.json.pairs.every((p) => p.source_checkout === r.home), 'each pair names the checkout it came from');
      ok(!plan.json.pairs.some((p) => p.source === r.unrelated), 'a workflow of no macro stays');
      deepStrictEqual(snapshotState(r), before, 'plan is read-only');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("a linked worktree's child of a macro already in the main checkout moves; the macro stays", () => {
    const r = setup({ macroAt: 'main', childAt: 'other' });
    try {
      const plan = cutover(r.main, 'plan');
      strictEqual(plan.status, 0, plan.stderr);
      deepStrictEqual(plan.json.pairs.map((p) => [p.kind, p.source]), [
        ['peer-run', r.childLedger],
        ['archive', r.archived],
        ['workflow', r.child],
      ]);
      // The same once that macro is archived in the main checkout.
      mkdirSync(join(r.main, ORCH_HOME, 'archive'), { recursive: true });
      renameSync(r.macro, join(r.main, ORCH_HOME, 'archive', basename(r.macro)));
      deepStrictEqual(cutover(r.main, 'plan').json.pairs.map((p) => p.source), [r.childLedger, r.archived, r.child]);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('move renames every pair into the default state root; enable and verify pass, and every checkout resolves the macro there', () => {
    const r = setup();
    try {
      const macroText = readFileSync(r.macro, 'utf8');
      const childText = readFileSync(r.child, 'utf8');
      const moved = cutover(r.main, 'move');
      strictEqual(moved.status, 0, moved.stderr);
      strictEqual(moved.json.ok, true);
      const macroDest = dest(r, ORCH_HOME, 'workflows', basename(r.macro));
      const childDest = dest(r, ENG_HOME, 'workflows', basename(r.child));
      for (const source of [r.macro, r.child, r.archived, r.macroLedger, r.childLedger]) ok(!existsSync(source), `${source} moved`);
      strictEqual(readFileSync(macroDest, 'utf8'), macroText, 'moved, not rewritten');
      strictEqual(readFileSync(childDest, 'utf8'), childText);
      ok(existsSync(join(dest(r, ENG_HOME, 'peer-runs', CHILD_RUN), 'handle.json')));
      ok(existsSync(r.unrelated), 'a workflow of no macro stays');
      const manifest = JSON.parse(readFileSync(moved.json.manifest, 'utf8'));
      ok(moved.json.manifest.startsWith(join(r.main, '.agentic-plugins/runs/cutover/')), moved.json.manifest);
      strictEqual(manifest.pairs.length, 5);
      deepStrictEqual(manifest.moved.map((m) => m.source), manifest.pairs.map((p) => p.source));
      strictEqual(manifest.inventory, null);

      const notYet = cutover(r.main, 'verify');
      strictEqual(notYet.status, 1, 'the switch is still off');
      ok(notYet.json.checks.some((c) => c.id === 'shared-creation-on' && !c.ok));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      const closed = JSON.parse(readFileSync(moved.json.manifest, 'utf8'));
      ok(closed.inventory.workflow_ids.includes(r.macroId), 'enable appends the inventory to this manifest');
      const verified = cutover(r.main, 'verify');
      strictEqual(verified.status, 0, verified.stderr);
      ok(verified.json.checks.filter((c) => c.id === 'macro-resolves').length === 3, 'from all three checkouts');
      deepStrictEqual(verified.json.checks.filter((c) => c.id === 'find-macro').map((c) => [c.ok, c.detail]),
        [r.main, r.home, r.other].map((at) => [true, `subtask branch feat/t1 from ${at}: ${dest(r, ORCH_HOME, 'workflows', basename(r.macro))}`]), 'by its subtask branch too, from every checkout');
      for (const at of [r.main, r.home, r.other]) {
        strictEqual(must(orch(['resolve-workflow', '--repo-root', at, '--workflow-id', r.macroId])), macroDest);
      }
      strictEqual(must(orch(['find-active', '--repo-root', r.home, '--branch', 'main'])), macroDest);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a rerun continues an interrupted move: a pair not yet renamed is moved, one renamed but not recorded is recorded', () => {
    const r = setup();
    try {
      const moved = cutover(r.main, 'move');
      strictEqual(moved.status, 0, moved.stderr);
      const file = moved.json.manifest;
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const macroPair = doc.pairs.find((p) => p.plugin === 'orchestrator' && p.kind === 'workflow');
      const childPair = doc.pairs.find((p) => p.plugin === 'engineer' && p.kind === 'workflow');
      // Killed before the macro's rename, and after the child's rename but
      // before its record.
      renameSync(macroPair.destination, macroPair.source);
      doc.moved = doc.moved.filter((m) => m.source !== macroPair.source && m.source !== childPair.source);
      writeFileSync(file, JSON.stringify(doc));
      // The open manifest is continued only from the main checkout.
      const elsewhere = cutover(r.home, 'move');
      strictEqual(elsewhere.status, 1);
      deepStrictEqual(codes(elsewhere), ['attestation-failed']);
      ok(existsSync(macroPair.source));
      const again = cutover(r.main, 'move');
      strictEqual(again.status, 0, again.stderr);
      strictEqual(again.json.manifest, file, 'the open manifest is continued');
      strictEqual(again.json.resumed, true);
      deepStrictEqual(again.json.moved, [macroPair.source]);
      ok(!existsSync(macroPair.source) && existsSync(macroPair.destination));
      const after = JSON.parse(readFileSync(file, 'utf8'));
      deepStrictEqual(after.moved.map((m) => m.source).sort(), doc.pairs.map((p) => p.source).sort(), 'each pair recorded once');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  // The SR refine's Refine-verify (MINOR): no pair is left at its source, so
  // the rerun plans again, but the manifest's record of the last pair is
  // written first.
  it("a move killed after its last rename, before that pair's record: the rerun records it in that manifest, then plans again", () => {
    const r = setup();
    try {
      const moved = cutover(r.main, 'move');
      strictEqual(moved.status, 0, moved.stderr);
      const file = moved.json.manifest;
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const last = doc.moved.at(-1).source;
      doc.moved = doc.moved.slice(0, -1);
      writeFileSync(file, JSON.stringify(doc));
      const again = cutover(r.main, 'move');
      strictEqual(again.status, 0, again.stderr);
      deepStrictEqual([again.json.resumed, again.json.manifest, again.json.moved], [false, null, []], 'nothing at a source: it planned again, and found nothing to move');
      const after = JSON.parse(readFileSync(file, 'utf8'));
      deepStrictEqual(after.moved.map((m) => m.source).sort(), doc.pairs.map((p) => p.source).sort(), 'each pair recorded once');
      ok(after.moved.some((m) => m.source === last), 'the last pair recorded');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a rerun refuses a pair found at both ends or at neither, and moves nothing', () => {
    const r = setup();
    try {
      const moved = cutover(r.main, 'move');
      strictEqual(moved.status, 0, moved.stderr);
      const doc = JSON.parse(readFileSync(moved.json.manifest, 'utf8'));
      const macroPair = doc.pairs.find((p) => p.plugin === 'orchestrator' && p.kind === 'workflow');
      const archivePair = doc.pairs.find((p) => p.kind === 'archive');
      const childPair = doc.pairs.find((p) => p.plugin === 'engineer' && p.kind === 'workflow');
      copyFileSync(macroPair.destination, macroPair.source);
      renameSync(childPair.destination, childPair.source);
      const before = snapshotState(r);
      const copied = cutover(r.main, 'move');
      strictEqual(copied.status, 1);
      deepStrictEqual(codes(copied), ['pair-copied']);
      ok(existsSync(childPair.source), 'nothing moved, not even a pair that could');
      deepStrictEqual(snapshotState(r), before);
      rmSync(macroPair.source);
      rmSync(archivePair.destination);
      const lost = cutover(r.main, 'move');
      strictEqual(lost.status, 1);
      deepStrictEqual(codes(lost), ['pair-lost']);
      ok(existsSync(childPair.source));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('refuses outside the main checkout', () => {
    const r = setup();
    try {
      const before = snapshotState(r);
      for (const mode of ['plan', 'move']) {
        const refused = cutover(r.home, mode);
        strictEqual(refused.status, 1, mode);
        ok(codes(refused).includes('attestation-failed'), `${mode}: ${refused.stderr}`);
      }
      deepStrictEqual(snapshotState(r), before);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('refuses a branch key held by a second active workflow, a pending ensemble, an existing destination, and a legacy home', () => {
    const cases = [
      ['branch-key', (r) => {
        // An older script's second workflow on the child's branch, in the
        // main checkout: today's create refuses it, so it is written as one.
        const twin = 'compose-20261008T000003Z-dddddd';
        const text = readFileSync(r.child, 'utf8').replaceAll(r.childId, twin);
        mkdirSync(join(r.main, ENG_HOME, 'workflows'), { recursive: true });
        writeFileSync(join(r.main, ENG_HOME, 'workflows', `${twin}.md`), text);
      }],
      ['pending-ensemble', (r) => {
        must(eng(['ensemble-pending', '--workflow-path', r.child, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'plan-verify-20261008T000004Z-eeeeee']));
      }],
      ['name-exists', (r) => {
        mkdirSync(join(r.main, ENG_HOME, 'archive'), { recursive: true });
        writeFileSync(join(r.main, ENG_HOME, 'archive', basename(r.archived)), 'x');
      }],
      ['source-legacy-home', (r) => {
        const legacy = join(r.home, '.claude/agentic-orchestrator/workflows');
        mkdirSync(legacy, { recursive: true });
        renameSync(r.macro, join(legacy, basename(r.macro)));
      }],
      ['destination-legacy-home', (r) => {
        mkdirSync(join(r.main, '.claude/agentic-engineer/workflows'), { recursive: true });
        writeFileSync(join(r.main, '.claude/agentic-engineer/workflows/compose-20261008T000005Z-ffffff.md'), '---\nworkflow_id: "x"\n---\n');
      }],
    ];
    for (const [code, arrange] of cases) {
      const r = setup();
      try {
        arrange(r);
        const plan = cutover(r.main, 'plan');
        strictEqual(plan.status, 1, code);
        ok(codes(plan).includes(code), `${code}: ${JSON.stringify(plan.json?.refusals)}`);
        const before = snapshotState(r);
        const move = cutover(r.main, 'move');
        strictEqual(move.status, 1, code);
        ok(codes(move).includes(code), code);
        deepStrictEqual(snapshotState(r), before, `${code}: a refused move writes nothing, no manifest either`);
        ok(!existsSync(join(r.main, '.agentic-plugins/runs/cutover')), code);
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    }
  });

  it('verify fails when a source path comes back, or a linked worktree holds an active child of a moved macro', () => {
    const r = setup();
    try {
      must(orch(['cutover', '--repo-root', r.main, '--move']));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      strictEqual(cutover(r.main, 'verify').status, 0);
      const peerDest = dest(r, ORCH_HOME, 'peer-runs', MACRO_RUN);
      mkdirSync(r.macroLedger, { recursive: true });
      copyFileSync(join(peerDest, 'handle.json'), join(r.macroLedger, 'handle.json'));
      const back = cutover(r.main, 'verify');
      strictEqual(back.status, 1);
      deepStrictEqual(back.json.checks.filter((c) => !c.ok).map((c) => c.id), ['sources-absent']);
      rmSync(r.macroLedger, { recursive: true });
      // A copy of the macro at its source: the home worktree's read set holds
      // it twice, and its lookups refuse.
      copyFileSync(dest(r, ORCH_HOME, 'workflows', basename(r.macro)), r.macro);
      const twice = cutover(r.main, 'verify');
      strictEqual(twice.status, 1);
      deepStrictEqual([...new Set(twice.json.checks.filter((c) => !c.ok).map((c) => c.id))].sort(), ['find-macro', 'macro-resolves', 'sources-absent']);
      match(twice.stderr, new RegExp(`macro-resolves: ${r.macroId} from ${r.home}: .*Ambiguous`));
      rmSync(r.macro);
      strictEqual(cutover(r.main, 'verify').status, 0);
      // An older persona in the linked worktree dispatches a child into its
      // own home after the switch: today's create would place it beside the
      // macro, so it is written where the older one would put it.
      const stray = join(r.other, ENG_HOME, 'workflows', 'compose-20261008T000006Z-aaaaaa.md');
      mkdirSync(dirname(stray), { recursive: true });
      writeFileSync(stray, readFileSync(dest(r, ENG_HOME, 'workflows', basename(r.child)), 'utf8').replaceAll(r.childId, 'compose-20261008T000006Z-aaaaaa').replace('branch: "autopilot/home"', 'branch: "feat/other"'));
      const strayed = cutover(r.main, 'verify');
      strictEqual(strayed.status, 1);
      deepStrictEqual(strayed.json.checks.filter((c) => !c.ok).map((c) => c.id), ['no-stray-children']);
      match(strayed.stderr, /no-stray-children: .*compose-20261008T000006Z-aaaaaa/);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("moves a workflow under its write lock, and a ledger or an archived file under the destination home's creation lock", async () => {
    const r = setup();
    try {
      // A writer holds the macro: everything else moves, the macro waits.
      const macroLock = `${r.macro}.lock`;
      writeFileSync(macroLock, 'held-by-a-writer');
      const pending = cutoverAsync(r.main, 'move');
      ok(await waitFor(() => !existsSync(r.child)), 'the child moved');
      await sleep(500);
      ok(existsSync(r.macro), 'the macro waits for its write lock');
      rmSync(macroLock);
      const done = await pending;
      strictEqual(done.status, 0, done.stderr);
      ok(!existsSync(r.macro));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
    const s = setup();
    try {
      // A create or an archive holds the engineer home of the main checkout:
      // its first ledger waits.
      const creationLock = join(s.main, ENG_HOME, '.creation-lock');
      mkdirSync(dirname(creationLock), { recursive: true });
      writeFileSync(creationLock, 'held-by-a-create');
      const pending = cutoverAsync(s.main, 'move');
      ok(await waitFor(() => manifestIn(s.main) !== null), 'the manifest is written before the first rename');
      await sleep(800);
      ok(existsSync(s.childLedger), 'the ledger waits for the creation lock');
      ok(existsSync(s.archived) && existsSync(s.child) && existsSync(s.macro), 'and nothing after it moved');
      const early = manifestIn(s.main);
      strictEqual(early.pairs.length, 5);
      deepStrictEqual(early.moved, []);
      rmSync(creationLock);
      const done = await pending;
      strictEqual(done.status, 0, done.stderr);
      ok(!existsSync(s.childLedger) && !existsSync(s.archived));
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
    // The source home's creation lock, the linked worktree's, is taken too.
    const u = setup();
    try {
      const sourceLock = join(u.home, ENG_HOME, '.creation-lock');
      writeFileSync(sourceLock, 'held-by-an-archive');
      const pending = cutoverAsync(u.main, 'move');
      ok(await waitFor(() => manifestIn(u.main) !== null));
      await sleep(800);
      ok(existsSync(u.childLedger), "the ledger waits for its source home's creation lock");
      rmSync(sourceLock);
      strictEqual((await pending).status, 0);
    } finally {
      rmSync(u.dir, { recursive: true, force: true });
    }
    // An archived file, with no ledger before it, waits for the creation lock.
    const v = setup({ ledgers: false });
    try {
      const creationLock = join(v.main, ENG_HOME, '.creation-lock');
      mkdirSync(dirname(creationLock), { recursive: true });
      writeFileSync(creationLock, 'held-by-a-create');
      const pending = cutoverAsync(v.main, 'move');
      ok(await waitFor(() => manifestIn(v.main) !== null));
      await sleep(800);
      ok(existsSync(v.archived), 'the archived file waits for the creation lock');
      rmSync(creationLock);
      strictEqual((await pending).status, 0);
      ok(!existsSync(v.archived));
    } finally {
      rmSync(v.dir, { recursive: true, force: true });
    }
  });

  it('refuses a --repo-root left without its value, rather than act in the working directory', () => {
    const r = setup();
    try {
      for (const mode of ['plan', 'move', 'verify']) {
        const refused = orch(['cutover', '--repo-root', `--${mode}`], r.main);
        strictEqual(refused.status, 1, mode);
        match(refused.stderr, /--repo-root needs a value/);
      }
      ok(existsSync(r.macro) && existsSync(r.child));
      ok(!existsSync(join(r.main, '.agentic-plugins/runs/cutover')));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('verifies from the home worktree too, and still verifies a move whose enable was interrupted and rerun', async () => {
    const r = setup();
    try {
      const moved = cutover(r.main, 'move');
      strictEqual(moved.status, 0, moved.stderr);
      // A permission error after enable closed the move's manifest and before
      // it wrote the switch; the rerun writes a manifest of its own.
      const lib = await import(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/state-root.mjs'));
      const rename = nodeFs.renameSync;
      nodeFs.renameSync = (from, to) => {
        if (String(to).endsWith('shared-creation.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return rename(from, to);
      };
      try {
        let thrown = null;
        try {
          lib.enableSharedCreation({ checkout: r.main, versions: { orchestrator: 'test' } });
        } catch (error) {
          thrown = error;
        }
        strictEqual(thrown?.code, 'EACCES');
      } finally {
        nodeFs.renameSync = rename;
      }
      ok(JSON.parse(readFileSync(moved.json.manifest, 'utf8')).inventory, "the move's manifest is closed");
      // The rerun names its manifest in a later second than the move's, so
      // the inventory-only one is the newest by name (two of one second sort
      // by their random suffix).
      const movedAt = Date.parse(JSON.parse(readFileSync(moved.json.manifest, 'utf8')).created_at);
      ok(await waitFor(() => Date.now() >= movedAt + 1000, 2500), 'a second has passed since the move');
      const rerun = JSON.parse(must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}'])));
      ok(rerun.manifest !== moved.json.manifest, 'the rerun wrote a manifest of its own');
      ok(basename(rerun.manifest) > basename(moved.json.manifest), 'the inventory-only manifest is the newest');
      for (const at of [r.main, r.home]) {
        const verified = cutover(at, 'verify');
        strictEqual(verified.status, 0, `${at}: ${verified.stderr}`);
        strictEqual(verified.json.checks.filter((c) => c.id === 'macro-resolves').length, 3, at);
        strictEqual(verified.json.checks.filter((c) => c.id === 'find-macro').length, 3, at);
        ok(verified.json.checks.some((c) => c.id === 'next-ready' && c.ok), at);
        match(verified.json.checks.find((c) => c.id === 'sources-absent').detail, /none of the 5 source paths/);
      }
      // A stray child in the home worktree's own home, seen from there too.
      const stray = join(r.home, ENG_HOME, 'workflows', 'compose-20261008T000010Z-bbbbbb.md');
      writeFileSync(stray, readFileSync(dest(r, ENG_HOME, 'workflows', basename(r.child)), 'utf8').replaceAll(r.childId, 'compose-20261008T000010Z-bbbbbb'));
      for (const at of [r.main, r.home]) {
        const strayed = cutover(at, 'verify');
        strictEqual(strayed.status, 1, at);
        deepStrictEqual(strayed.json.checks.filter((c) => !c.ok).map((c) => c.id), ['no-stray-children'], at);
      }
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a rerun after the move finished, before the switch, plans again and moves a macro that came into a linked worktree since', () => {
    const r = setup();
    try {
      const first = cutover(r.main, 'move');
      strictEqual(first.status, 0, first.stderr);
      const b = macroWithChild(r, r.other, 'b');
      const second = cutover(r.main, 'move');
      strictEqual(second.status, 0, second.stderr);
      notStrictEqualPath(second.json.manifest, first.json.manifest);
      strictEqual(second.json.resumed, false);
      deepStrictEqual([...second.json.moved].sort(), [b.child, b.macro].sort());
      ok(existsSync(dest(r, ORCH_HOME, 'workflows', basename(b.macro))) && existsSync(dest(r, ENG_HOME, 'workflows', basename(b.child))));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      const verified = cutover(r.main, 'verify');
      strictEqual(verified.status, 0, verified.stderr);
      deepStrictEqual([...verified.json.manifests].sort(), [first.json.manifest, second.json.manifest].sort(), 'verify reads both manifests');
      deepStrictEqual(resolvedFrom(verified), { [r.macroId]: [r.main, r.home, r.other].sort(), [b.macroId]: [r.main, r.home, r.other].sort() });
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('after the switch, each later --move plans again: a macro and its child kept in a linked worktree\'s own home move under a manifest of their own', () => {
    const r = setup();
    try {
      const first = cutover(r.main, 'move');
      strictEqual(first.status, 0, first.stderr);
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      const b = macroWithChild(r, r.other, 'b', { base: true });
      const second = cutover(r.main, 'move');
      strictEqual(second.status, 0, second.stderr);
      deepStrictEqual([...second.json.moved].sort(), [b.child, b.macro].sort());
      // The switch is on, so enable never closes the second manifest: a third
      // move must not take it as one to continue.
      const c = macroWithChild(r, r.home, 'c', { base: true });
      const third = cutover(r.main, 'move');
      strictEqual(third.status, 0, third.stderr);
      ok(![first.json.manifest, second.json.manifest].includes(third.json.manifest), third.json.manifest);
      strictEqual(third.json.resumed, false);
      deepStrictEqual([...third.json.moved].sort(), [c.child, c.macro].sort());
      for (const p of [b.macro, b.child, c.macro, c.child]) ok(!existsSync(p), `${p} moved`);
      const verified = cutover(r.main, 'verify');
      strictEqual(verified.status, 0, verified.stderr);
      deepStrictEqual([...verified.json.manifests].sort(), [first.json.manifest, second.json.manifest, third.json.manifest].sort(), 'verify reads every manifest');
      deepStrictEqual(resolvedFrom(verified), Object.fromEntries([r.macroId, b.macroId, c.macroId].map((id) => [id, [r.main, r.home, r.other].sort()])));
      // Nothing new: the rerun plans, finds nothing and writes no manifest.
      const idle = cutover(r.main, 'move');
      strictEqual(idle.status, 0, idle.stderr);
      strictEqual(idle.json.manifest, null);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('verify judges a moved macro archived since by its Stop where it is now, the default state root\'s archive', async () => {
    const r = setup();
    try {
      must(orch(['cutover', '--repo-root', r.main, '--move']));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      const macroDest = dest(r, ORCH_HOME, 'workflows', basename(r.macro));
      // The macro finishes from the home worktree: its child archived, the
      // subtask settled, the macro finalized; the next Stop there archives it.
      must(eng(['detach-archive', '--workflow-path', dest(r, ENG_HOME, 'workflows', basename(r.child)), '--host', 'claude', '--repo-root', r.home]));
      must(orch(['bulk-subtask-status', '--workflow-path', macroDest, '--host', 'claude',
        '--from-statuses', 'pending,blocked,in_progress', '--to-status', 'deferred'], r.home));
      must(orch(['set-terminal', '--workflow-path', macroDest, '--host', 'claude', '--terminal-phase', 'finalized',
        '--terminal-marker', 'true', '--next-action', 'archive'], r.home));
      const { runMacroStopArchiveAll } = await import(join(REPO_ROOT, 'plugins/orchestrator/scripts/stop-archive.mjs'));
      let stopErr = '';
      await runMacroStopArchiveAll({ repoRoot: r.home, host: 'claude', stderr: { write: (s) => { stopErr += s; } } });
      const archived = dest(r, ORCH_HOME, 'archive', basename(r.macro));
      ok(existsSync(archived) && !existsSync(macroDest), `the Stop archives it under the default state root: ${stopErr}`);
      const verified = cutover(r.main, 'verify');
      strictEqual(verified.status, 0, verified.stderr);
      deepStrictEqual(verified.json.checks.filter((c) => c.id === 'macro-archived').map((c) => [c.ok, c.detail]),
        [r.main, r.home, r.other].map((at) => [true, `${r.macroId} from ${at}: archived at ${archived}`]));
      ok(!verified.json.checks.some((c) => ['macro-resolves', 'next-ready', 'find-macro'].includes(c.id)), 'an archived macro is not looked up as an active one');
      // A stale active copy that a linked worktree's own home still holds.
      const stale = join(r.other, ORCH_HOME, 'workflows', basename(r.macro));
      mkdirSync(dirname(stale), { recursive: true });
      copyFileSync(archived, stale);
      const copied = cutover(r.main, 'verify');
      strictEqual(copied.status, 1);
      deepStrictEqual(copied.json.checks.filter((c) => !c.ok).map((c) => c.detail), [`${r.macroId} from ${r.other}: active at ${stale}`]);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('verify fails when a moved macro\'s plan is one next-ready cannot work from', () => {
    const r = setup();
    try {
      must(orch(['cutover', '--repo-root', r.main, '--move']));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      const macroDest = dest(r, ORCH_HOME, 'workflows', basename(r.macro));
      strictEqual(cutover(r.main, 'verify').status, 0);
      const text = readFileSync(macroDest, 'utf8');
      // An older orchestrator's schema 1.0 plan, which next-ready refuses.
      writeFileSync(macroDest, text.replace(/^schema: "[^"]*"$/m, 'schema: "1.0"'));
      strictEqual(orch(['next-ready', '--workflow-path', macroDest]).status, 1, 'next-ready refuses it');
      const legacy = cutover(r.main, 'verify');
      strictEqual(legacy.status, 1);
      deepStrictEqual(legacy.json.checks.filter((c) => !c.ok).map((c) => c.id), ['next-ready']);
      match(legacy.stderr, /next-ready: .*schema 1\.0/);
      // A subtask waiting on an id the plan does not hold would never become
      // ready: the parse refuses the plan, and so does every lookup that reads it.
      writeFileSync(macroDest, text.replace('blocked_by: []', 'blocked_by: ["T0"]'));
      strictEqual(orch(['next-ready', '--workflow-path', macroDest]).status, 1, 'next-ready refuses it');
      const dangling = cutover(r.main, 'verify');
      strictEqual(dangling.status, 1);
      ok(dangling.json.checks.some((c) => c.id === 'next-ready' && !c.ok), dangling.stderr);
      match(dangling.stderr, /next-ready: .*blocked_by references unknown subtask id "T0"/);
      writeFileSync(macroDest, text);
      strictEqual(cutover(r.main, 'verify').status, 0);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a linked worktree added after the cutover reaches the moved macro and its child', () => {
    const r = setup();
    try {
      must(orch(['cutover', '--repo-root', r.main, '--move']));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
      git(r.main, 'worktree', 'add', '-q', '-b', 'feat/late', join(r.dir, 'late'));
      const late = realpathSync(join(r.dir, 'late'));
      const macroDest = dest(r, ORCH_HOME, 'workflows', basename(r.macro));
      strictEqual(must(orch(['resolve-workflow', '--repo-root', late, '--workflow-id', r.macroId], late)), macroDest);
      strictEqual(must(orch(['find-macro', '--repo-root', late, '--subtask-branch', 'feat/t1'], late)), macroDest);
      strictEqual(must(orch(['find-active', '--repo-root', late, '--branch', 'main'], late)), macroDest);
      strictEqual(must(eng(['find-active', '--repo-root', late, '--branch', 'autopilot/home'])), dest(r, ENG_HOME, 'workflows', basename(r.child)));
      for (const at of [r.main, late]) {
        const verified = cutover(at, 'verify');
        strictEqual(verified.status, 0, `${at}: ${verified.stderr}`);
        deepStrictEqual(resolvedFrom(verified), { [r.macroId]: [r.main, r.home, r.other, late].sort() }, at);
      }
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  describe('rollback', () => {
    const rollback = (checkout, mode) => {
      const res = orch(['cutover', '--repo-root', checkout, '--rollback', `--${mode}`]);
      let json = null;
      try {
        json = JSON.parse(res.stdout);
      } catch {
        /* left null */
      }
      return { ...res, json };
    };
    const switchState = (r) => JSON.parse(must(orch(['state-root', '--repo-root', r.main]))).shared_creation.state;
    const cutoverAndEnable = (r) => {
      must(orch(['cutover', '--repo-root', r.main, '--move']));
      must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
    };

    it("sends each moved record back to its checkout and one created after the switch to its own; the main checkout's records stay; the switch goes off", () => {
      const r = setup();
      try {
        const mainOwn = engCreate(r, r.main, 'feat/main-own', false);
        // Created in `other`, then moved into the main checkout by hand before
        // the cutover: its repo_root names `other`, but it lived in main.
        const handMade = engCreate(r, r.other, 'feat/hand', false);
        const handMoved = join(r.main, ENG_HOME, 'workflows', basename(handMade));
        renameSync(handMade, handMoved);
        cutoverAndEnable(r);
        const after = engCreate(r, r.other, 'feat/after', false);
        ok(after.startsWith(join(r.main, ENG_HOME)), `created under the default state root: ${after}`);
        // Another persona's record, created in `other` after the switch, goes
        // back there too.
        const founderAfter = must(node(FOUNDER_STATE, [
          'create', '--repo-root', r.other, '--verb', 'compose', '--host', 'claude', '--persona', 'founder',
          '--git-baseline-branch', 'feat/founder', '--git-baseline-head', r.head, '--status-digest', DIGEST,
          '--original-request', 'cutover fixture founder record',
        ]));
        ok(founderAfter.startsWith(join(r.main, FOUNDER_HOME)), `created under the default state root: ${founderAfter}`);
        const plan = rollback(r.main, 'plan');
        strictEqual(plan.status, 0, plan.stderr);
        const back = Object.fromEntries(plan.json.pairs.map((p) => [p.source, p.destination]));
        strictEqual(back[dest(r, ORCH_HOME, 'workflows', basename(r.macro))], r.macro);
        strictEqual(back[dest(r, ENG_HOME, 'workflows', basename(r.child))], r.child);
        strictEqual(back[dest(r, ENG_HOME, 'archive', basename(r.archived))], r.archived);
        strictEqual(back[dest(r, ENG_HOME, 'peer-runs', CHILD_RUN)], r.childLedger);
        strictEqual(back[dest(r, ORCH_HOME, 'peer-runs', MACRO_RUN)], r.macroLedger);
        strictEqual(back[after], join(r.other, ENG_HOME, 'workflows', basename(after)));
        strictEqual(back[founderAfter], join(r.other, FOUNDER_HOME, 'workflows', basename(founderAfter)));
        strictEqual(back[mainOwn], undefined, "the main checkout's own record stays");
        strictEqual(back[handMoved], undefined, 'a record the inventory holds stays, whatever its repo_root says');
        strictEqual(switchState(r), 'on', 'plan is read-only');

        const moved = rollback(r.main, 'move');
        strictEqual(moved.status, 0, moved.stderr);
        for (const p of [r.macro, r.child, r.archived, r.childLedger, r.macroLedger, mainOwn, handMoved]) ok(existsSync(p), p);
        ok(existsSync(join(r.other, ENG_HOME, 'workflows', basename(after))));
        ok(!existsSync(after));
        ok(existsSync(join(r.other, FOUNDER_HOME, 'workflows', basename(founderAfter))));
        ok(!existsSync(founderAfter));
        strictEqual(switchState(r), 'off');
        const doc = JSON.parse(readFileSync(moved.json.manifest, 'utf8'));
        strictEqual(doc.kind, 'rollback');
        ok(doc.completed_at);
        strictEqual(must(orch(['resolve-workflow', '--repo-root', r.home, '--workflow-id', r.macroId])), r.macro);
        // A second cutover plans afresh, moves under a manifest of its own, and
        // verifies without the reversed ones.
        const again = cutover(r.main, 'plan');
        strictEqual(again.status, 0, again.stderr);
        ok(again.json.pairs.some((p) => p.source === r.macro));
        ok(doc.cutover_manifests.length > 0, 'the rollback names the cutovers it reversed');
        const second = cutover(r.main, 'move');
        strictEqual(second.status, 0, second.stderr);
        ok(!doc.cutover_manifests.includes(second.json.manifest), 'the second cutover writes a manifest of its own');
        must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}']));
        const verified = cutover(r.main, 'verify');
        strictEqual(verified.status, 0, verified.stderr);
        ok(verified.json.manifests.includes(second.json.manifest));
        deepStrictEqual(verified.json.manifests.filter((m) => doc.cutover_manifests.includes(m)), [], 'verify reads no reversed manifest');
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it("is refused, leaving the switch on, when a record's checkout is gone or lanes have run", () => {
      const r = setup();
      try {
        cutoverAndEnable(r);
        engCreate(r, r.other, 'feat/after', false);
        git(r.main, 'worktree', 'remove', '--force', r.other);
        const before = snapshotState({ ...r, other: r.main });
        for (const mode of ['plan', 'move']) {
          const refused = rollback(r.main, mode);
          strictEqual(refused.status, 1, mode);
          ok(codes(refused).includes('checkout-gone'), `${mode}: ${refused.stderr}`);
        }
        strictEqual(switchState(r), 'on');
        deepStrictEqual(snapshotState({ ...r, other: r.main }), before, 'nothing moved, no manifest written');
        const switchFile = join(r.main, '.agentic-plugins/state/shared-creation.json');
        const record = JSON.parse(readFileSync(switchFile, 'utf8'));
        writeFileSync(switchFile, JSON.stringify({ ...record, lanes_first_run_at: '2026-10-09T00:00:00Z' }));
        const lanes = rollback(r.main, 'plan');
        ok(codes(lanes).includes('lanes-have-run'), lanes.stderr);
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('refuses while an active macro and a child it still needs would end in two checkouts', () => {
      const r = setup();
      try {
        cutoverAndEnable(r);
        // A child dispatched from `other` after the switch is created beside
        // its macro, and names `other` as its repo_root.
        const late = engCreate(r, r.other, 'feat/other');
        ok(late.startsWith(join(r.main, ENG_HOME)), late);
        const refused = rollback(r.main, 'plan');
        strictEqual(refused.status, 1);
        deepStrictEqual(codes(refused), ['macro-child-split']);
        match(refused.stderr, new RegExp(`${r.macroId} would end in ${r.home} and its child ${basename(late, '.md')}`));
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('counts an archived child as still needed only while a subtask not yet settled names it', () => {
      const r = setup();
      try {
        cutoverAndEnable(r);
        const named = engCreate(r, r.other, 'feat/other');
        const namedId = basename(named, '.md');
        must(orch(['subtask-update', '--workflow-path', dest(r, ORCH_HOME, 'workflows', basename(r.macro)), '--host', 'claude',
          '--subtask-id', 'T1', '--status', 'in_progress', '--engineer-workflow-id', namedId]));
        must(eng(['detach-archive', '--workflow-path', named, '--host', 'claude', '--repo-root', r.main]));
        const free = engCreate(r, r.other, 'feat/other');
        must(eng(['detach-archive', '--workflow-path', free, '--host', 'claude', '--repo-root', r.main]));
        const refused = rollback(r.main, 'plan');
        strictEqual(refused.status, 1);
        deepStrictEqual(codes(refused), ['macro-child-split']);
        ok(refused.stderr.includes(`its child ${namedId}`), refused.stderr);
        ok(!refused.stderr.includes(basename(free, '.md')), 'an archived child no subtask awaits moves as found');
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('closes a cutover it reversed before the switch: enable then starts a manifest of its own', () => {
      const r = setup();
      try {
        const moved = cutover(r.main, 'move');
        strictEqual(moved.status, 0, moved.stderr);
        const back = rollback(r.main, 'move');
        strictEqual(back.status, 0, back.stderr);
        ok(existsSync(r.macro) && existsSync(r.child));
        const reversed = JSON.parse(readFileSync(moved.json.manifest, 'utf8'));
        ok(reversed.rolled_back_at, 'the cutover is marked rolled back');
        const enabled = JSON.parse(must(orch(['shared-creation', '--repo-root', r.main, '--enable', '--versions', '{"orchestrator":"test"}'])));
        notStrictEqualPath(enabled.manifest, moved.json.manifest);
        strictEqual(JSON.parse(readFileSync(moved.json.manifest, 'utf8')).inventory, null, 'the reversed cutover took no inventory');
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('reverses a cutover interrupted before step 5 from its manifest, each moved pair swapped', () => {
      const r = setup();
      try {
        const moved = cutover(r.main, 'move');
        strictEqual(moved.status, 0, moved.stderr);
        const file = moved.json.manifest;
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        const macroPair = doc.pairs.find((p) => p.plugin === 'orchestrator' && p.kind === 'workflow');
        // Killed before the macro's rename: every other pair has moved.
        renameSync(macroPair.destination, macroPair.source);
        doc.moved = doc.moved.filter((m) => m.source !== macroPair.source);
        writeFileSync(file, JSON.stringify(doc));
        const plan = rollback(r.main, 'plan');
        strictEqual(plan.status, 0, plan.stderr);
        const back = Object.fromEntries(plan.json.pairs.map((p) => [p.source, p.destination]));
        const swapped = Object.fromEntries(doc.pairs.filter((p) => p !== macroPair).map((p) => [p.destination, p.source]));
        strictEqual(Object.keys(swapped).length, 4, 'two ledgers, the archived file and the child moved');
        deepStrictEqual(back, swapped, 'each moved pair goes back to its source; the macro, never moved, stays');
        const undone = rollback(r.main, 'move');
        strictEqual(undone.status, 0, undone.stderr);
        for (const p of doc.pairs) {
          ok(existsSync(p.source), p.source);
          ok(!existsSync(p.destination), p.destination);
        }
        ok(JSON.parse(readFileSync(file, 'utf8')).rolled_back_at, 'the interrupted cutover is marked rolled back');
        strictEqual(must(orch(['resolve-workflow', '--repo-root', r.home, '--workflow-id', r.macroId])), r.macro);
        // A later cutover starts a manifest of its own rather than continue it.
        const fresh = cutover(r.main, 'move');
        strictEqual(fresh.status, 0, fresh.stderr);
        notStrictEqualPath(fresh.json.manifest, file);
        strictEqual(fresh.json.resumed, false);
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it("refuses, leaving the switch on, a destination whose other home holds state and a ledger an interrupted prune claimed", async () => {
      const { claimName } = await import(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/state-root.mjs'));
      const r = setup();
      try {
        // A workflow of no macro that an older tool left in `other`'s legacy home.
        engCreate(r, r.other, 'feat/legacy', false);
        mkdirSync(join(r.other, '.claude'), { recursive: true });
        renameSync(join(r.other, ENG_HOME), join(r.other, '.claude/agentic-engineer'));
        cutoverAndEnable(r);
        const after = engCreate(r, r.other, 'feat/after', false);
        ok(after.startsWith(join(r.main, ENG_HOME)), after);
        for (const mode of ['plan', 'move']) {
          const refused = rollback(r.main, mode);
          strictEqual(refused.status, 1, mode);
          deepStrictEqual(codes(refused), ['destination-two-homes'], `${mode}: ${refused.stderr}`);
          match(refused.stderr, /runtime:migrate/);
        }
        strictEqual(switchState(r), 'on');
        // Migrated (here: the legacy home removed), the plan passes; a prune
        // killed after claiming the child's ledger then refuses it.
        rmSync(join(r.other, '.claude'), { recursive: true, force: true });
        strictEqual(rollback(r.main, 'plan').status, 0);
        const ledgerAtRoot = dest(r, ENG_HOME, 'peer-runs', CHILD_RUN);
        renameSync(ledgerAtRoot, join(dirname(ledgerAtRoot), claimName(CHILD_RUN)));
        for (const mode of ['plan', 'move']) {
          const claimed = rollback(r.main, mode);
          strictEqual(claimed.status, 1, mode);
          deepStrictEqual(codes(claimed), ['ledger-claimed'], `${mode}: ${claimed.stderr}`);
        }
        strictEqual(switchState(r), 'on');
        ok(existsSync(dest(r, ENG_HOME, 'workflows', basename(r.child))), 'nothing moved');
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });

    it('a rerun continues an interrupted rollback under its own manifest', { skip: process.getuid?.() === 0 && 'root writes through permissions' }, () => {
      const r = setup();
      const blocked = join(r.home, ORCH_HOME, 'workflows');
      const rollbacks = () => readdirSync(join(r.main, '.agentic-plugins/runs/cutover'))
        .map((n) => JSON.parse(readFileSync(join(r.main, '.agentic-plugins/runs/cutover', n), 'utf8')))
        .filter((d) => d.kind === 'rollback');
      try {
        cutoverAndEnable(r);
        // A permission error at the macro's rename, the last pair: the
        // ledgers, the archived file and the child have gone back.
        chmodSync(blocked, 0o500);
        let first;
        try {
          first = rollback(r.main, 'move');
        } finally {
          chmodSync(blocked, 0o700);
        }
        strictEqual(first.status, 1);
        match(first.stderr, /EACCES|permission denied/i);
        ok(existsSync(r.child) && existsSync(r.childLedger) && existsSync(r.archived), 'the pairs before it went back');
        ok(!existsSync(r.macro));
        strictEqual(switchState(r), 'off');
        strictEqual(rollbacks().length, 1);
        const again = rollback(r.main, 'move');
        strictEqual(again.status, 0, again.stderr);
        strictEqual(again.json.resumed, true);
        deepStrictEqual(again.json.moved, [dest(r, ORCH_HOME, 'workflows', basename(r.macro))]);
        ok(existsSync(r.macro));
        const [doc] = rollbacks();
        strictEqual(rollbacks().length, 1, 'the open rollback is continued, not planned again');
        ok(doc.completed_at);
        deepStrictEqual(doc.moved.map((m) => m.source).sort(), doc.pairs.map((p) => p.source).sort(), 'each pair recorded once');
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    });
  });

  // docs/runbooks/state-root-cutover.md, "Two active workflows on one branch".
  it('the repair for two active workflows on one branch clears the readers\' ambiguity, each way the runbook gives', async () => {
    const r = setup();
    try {
      // An older script's twin of the child, in the main checkout.
      const twinOf = (file, id, at) => {
        const twin = join(at, ENG_HOME, 'workflows', `${id}.md`);
        mkdirSync(dirname(twin), { recursive: true });
        writeFileSync(twin, readFileSync(file, 'utf8').replaceAll(basename(file, '.md'), id));
        return twin;
      };
      const ambiguous = () => {
        const found = eng(['find-active', '--repo-root', r.home, '--branch', 'autopilot/home']);
        return found.status === 1 && /Ambiguous engineer workflow storage: 2 active workflows/.test(found.stderr);
      };
      const inMain = twinOf(r.child, 'compose-20261008T000007Z-aaaaaa', r.main);
      ok(ambiguous(), 'the pair is seen from the linked worktree');
      // Writers refuse the linked worktree's copy from every checkout.
      for (const at of [r.main, r.home]) {
        const refused = eng(['detach-archive', '--workflow-path', r.child, '--host', 'claude', '--repo-root', at]);
        strictEqual(refused.status, 1, at);
      }
      // Keep the linked worktree's: archive the main checkout's from the main checkout.
      must(eng(['detach-archive', '--workflow-path', inMain, '--host', 'claude', '--repo-root', r.main]));
      ok(!ambiguous());
      strictEqual(must(eng(['find-active', '--repo-root', r.home, '--branch', 'autopilot/home'])), r.child);
      // Keep the main checkout's: with the repository quiet, rename the
      // linked worktree's copy into its own home's archive.
      const again = twinOf(r.child, 'compose-20261008T000008Z-bbbbbb', r.main);
      ok(ambiguous());
      const archive = join(r.home, ENG_HOME, 'archive');
      mkdirSync(archive, { recursive: true });
      renameSync(r.child, join(archive, basename(r.child)));
      ok(!ambiguous());
      strictEqual(must(eng(['find-active', '--repo-root', r.home, '--branch', 'autopilot/home'])), again);
      // Two linked worktrees: from the main checkout, either copy is written.
      const inOther = twinOf(again, 'compose-20261008T000009Z-cccccc', r.other);
      renameSync(again, join(r.home, ENG_HOME, 'workflows', basename(again)));
      const plan = cutover(r.main, 'plan');
      ok(codes(plan).includes('branch-key'), 'the cutover plan finds the pair');
      must(eng(['detach-archive', '--workflow-path', inOther, '--host', 'claude', '--repo-root', r.main]));
      ok(!codes(cutover(r.main, 'plan')).includes('branch-key'));
      // Two linked worktrees holding macros on one integration branch: the
      // copy not kept is finalized in its own worktree, and archived by the
      // next Stop there.
      const twinId = 'macro-plan-20261008T000011Z-dddddd';
      const twin = join(r.other, ORCH_HOME, 'workflows', `${twinId}.md`);
      mkdirSync(dirname(twin), { recursive: true });
      writeFileSync(twin, readFileSync(r.macro, 'utf8').replaceAll(r.macroId, twinId));
      ok(codes(cutover(r.main, 'plan')).includes('branch-key'), 'the cutover plan finds the macros');
      strictEqual(orch(['resolve-workflow', '--repo-root', r.main, '--workflow-id', twinId], r.main).status, 3, 'the main checkout resolves neither');
      const terminal = ['set-terminal', '--workflow-path', twin, '--host', 'claude', '--terminal-phase', 'finalized', '--terminal-marker', 'true', '--next-action', 'archive'];
      const fromHome = orch(terminal, r.home);
      strictEqual(fromHome.status, 1, 'the other linked worktree sees both and refuses');
      match(fromHome.stderr, /2 active workflows on branch "main"/);
      strictEqual(must(orch(['resolve-workflow', '--repo-root', r.other, '--workflow-id', twinId], r.other)), twin);
      // finalize's two macro writes, Phase 1's then Phase 3's.
      must(orch(['bulk-subtask-status', '--workflow-path', twin, '--host', 'claude',
        '--from-statuses', 'pending,blocked,in_progress', '--to-status', 'deferred'], r.other));
      must(orch(terminal, r.other));
      const { runMacroStopArchiveAll } = await import(join(REPO_ROOT, 'plugins/orchestrator/scripts/stop-archive.mjs'));
      let stopErr = '';
      await runMacroStopArchiveAll({ repoRoot: r.other, host: 'claude', stderr: { write: (s) => { stopErr += s; } } });
      ok(existsSync(join(r.other, ORCH_HOME, 'archive', `${twinId}.md`)), `the Stop in that worktree archives it: ${stopErr}`);
      ok(!codes(cutover(r.main, 'plan')).includes('branch-key'));
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('takes exactly one mode', () => {
    const r = orch(['cutover', '--repo-root', REPO_ROOT, '--plan', '--move']);
    strictEqual(r.status, 1);
    match(r.stderr, /exactly one of --plan, --move and --verify/);
  });
});
