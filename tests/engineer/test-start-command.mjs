// plugins/engineer/commands/start.md — shape conformance tests
// (ADR-0020 §Sub-decision 1, PR 3).
//
// /engineer:start is a lifecycle macro command (not a verb, not a verb-
// level sugar alias, not a meta command — it bootstraps a new workflow).
// It sequences Phase 0~7 of the engineer lifecycle by invoking verb
// skills intra-document (NOT via recursive /engineer:<verb> slash
// commands per Codex plan-verify MAJOR #2) and updates state.mjs at
// each phase boundary so SessionStart re-injection stays current.
//
// Run via `node --test tests/engineer/test-start-command.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const COMMAND_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/commands/start.md',
);
const SKILL_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/skills/start/SKILL.md',
);
const ROUTING_CONTRACT_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/skills/_shared/references/entry-routing-contract.md',
);
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const { evaluateCleanBaseline } = await import(STATE_PATH);

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe('/engineer:start — file existence + frontmatter', () => {
  it('exists at the canonical path', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(text.length > 0, 'commands/start.md is empty');
  });

  it('frontmatter has non-empty description and argument-hint', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter');
    match(fm, /^description:\s*\S/m);
    match(fm, /^argument-hint:\s*\S/m);
  });

  it('argument-hint mentions the feature description AND --base-branch', async () => {
    // /engineer:start <feature> [--base-branch <ref>] — the base-branch
    // flag is required for stacked-branch redundancy detection per
    // Codex plan-verify MINOR #5.
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    match(fm, /--base-branch/, 'argument-hint must surface --base-branch flag');
  });
});

describe('/engineer:start — Phase 0 continuity contract (ADR-0020 §Sub-decision 4 + §Sub-decision 7)', () => {
  it('runs a detached-HEAD guard before any state.mjs invocation', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /Detached HEAD|detached HEAD|--show-current/.test(text),
      'Phase 0 must guard against detached HEAD (ADR-0018 §sub-2 branch-anchored workflows)',
    );
  });

  it('invokes state.mjs diagnose-redundancy in Phase 0 (ADR-0020 §Sub-decision 7)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,200}diagnose-redundancy/.test(text),
      'Phase 0 must invoke state.mjs diagnose-redundancy subcommand',
    );
  });

  it('surfaces redundancy evidence to user for explicit proceed/abort (NOT auto-archive)', async () => {
    // Codex plan-verify MINOR #4 — caller policy explicit. ADR-0020
    // says /engineer:start surfaces the result and asks user; never
    // auto-aborts on redundancy.
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /(proceed|abort|user decid)/i.test(text),
      'Phase 0 redundancy handling must surface proceed/abort choice (no auto-archive)',
    );
  });

  it('finds the active workflow via state.mjs find-active', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,200}find-active/.test(text),
      'Phase 0 must call state.mjs find-active',
    );
  });

  it('bootstraps a new workflow via state.mjs create with --workflow-type start', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,400}create[\s\S]{0,400}--workflow-type[\s\S]{0,40}start/.test(text),
      'Phase 0 bootstrap must call state.mjs create --workflow-type start',
    );
  });

  it('branches on workflow_type when an active workflow exists (auto-resume vs typed conflict)', async () => {
    // ADR-0020 §Sub-decision 4 — start auto-resumes own workflows;
    // verb-chain workflows surface a typed conflict.
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/workflow_type/.test(text), 'body must reference workflow_type');
    ok(
      /verb-chain[\s\S]{0,400}(conflict|exit|reject)/i.test(text)
        || /(conflict|exit|reject)[\s\S]{0,400}verb-chain/i.test(text),
      'body must describe typed-conflict branch for verb-chain active workflow',
    );
  });
});

describe('/engineer:start — Phase 1-7 sequencing (ADR-0020 §Sub-decision 2)', () => {
  it('covers all 8 phases (Phase 0 through Phase 7)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    for (const phase of ['Phase 0', 'Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'Phase 6', 'Phase 7']) {
      ok(text.includes(phase), `body missing ${phase}`);
    }
  });

  it('Phase 1 brainstorm references the composite investigate → frame → decide chain', async () => {
    // ADR-0020 §Sub-decision 2 — Phase 1 is composite.
    const text = await readFile(COMMAND_PATH, 'utf8');
    for (const verb of ['investigate', 'frame', 'decide']) {
      ok(
        text.includes(verb),
        `Phase 1 brainstorm composite must reference verb "${verb}"`,
      );
    }
  });

  it('phase-boundary state.mjs append updates verb so SessionStart sees current phase (Codex plan-verify MAJOR #1)', async () => {
    // ADR-0020 §Sub-decision 5 — workflow_type=start workflows update
    // `verb` per phase via state.mjs append --verb <phase-primary>.
    // Without this, SessionStart re-injection shows stale metadata.
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,300}append[\s\S]{0,300}--verb/.test(text),
      'phase boundaries must call state.mjs append --verb <phase-primary>',
    );
  });

  it('explicitly states intra-document execution (no recursive /engineer:<verb> slash dispatch)', async () => {
    // Codex plan-verify MAJOR #2 — the command runbook executes verb
    // skill semantics in-place via state.mjs + peer-runner.mjs;
    // it does NOT call slash commands recursively.
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /(intra-document|in-place|not.{0,30}slash|never.{0,30}slash|do not.{0,30}invoke|skill.{0,30}direct)/i.test(text),
      'body must clarify intra-document dispatch (no recursive /engineer:<verb>)',
    );
  });

  it('Phase 7 invokes the phase7-commit.mjs driver (ADR-0028 §Layer-3)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /phase7-commit\.mjs/.test(text),
      'Phase 7 must invoke phase7-commit.mjs (the driver writes set-terminal internally)',
    );
    // Driver is invoked in two steps: --mode plan first, then --mode execute.
    ok(/--mode plan/.test(text), 'Phase 7 must invoke --mode plan first');
    ok(/--mode execute/.test(text), 'Phase 7 must invoke --mode execute after user approval');
  });

  it('Phase 7 surface in SKILL.md narrates the same two-step driver flow (Codex parity)', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    ok(/phase7-commit\.mjs/.test(text), 'SKILL.md Phase 7 must reference phase7-commit.mjs');
    ok(/--mode plan/.test(text) && /--mode execute/.test(text),
       'SKILL.md must narrate the two-step plan + execute flow');
  });
});

describe('/engineer:start — entry routing and decision contract', () => {
  it('ships a shared entry-routing contract with all required route categories', async () => {
    const text = await readFile(ROUTING_CONTRACT_PATH, 'utf8');
    for (const token of [
      'engineer:start',
      'orchestrator:plan',
      'runtime:worktree',
      'runtime:*',
      'Single verb',
      'outcome, state, recovery path, and evidence',
    ]) {
      ok(text.includes(token), `routing contract missing ${token}`);
    }
  });

  it('requires concrete decision prompts with tradeoffs, risks, recommendation, confidence, and evidence', async () => {
    const text = await readFile(ROUTING_CONTRACT_PATH, 'utf8');
    for (const token of [
      'Options',
      'Tradeoffs',
      'Risks',
      'Recommendation',
      'Confidence',
      'Evidence pointers',
      'Default next command',
    ]) {
      ok(text.includes(token), `decision contract missing ${token}`);
    }
  });

  it('requires a standards and root-cause quality gate before quick implementation paths', async () => {
    const text = await readFile(ROUTING_CONTRACT_PATH, 'utf8');
    for (const token of ['source of truth', 'standard', 'root cause', 'verification evidence', 'rollback']) {
      ok(text.includes(token), `quality gate missing ${token}`);
    }
  });

  it('requires quality-first defaults for peer breadth, model effort, and review depth', async () => {
    const text = await readFile(ROUTING_CONTRACT_PATH, 'utf8');
    for (const token of [
      'Quality-First Defaults',
      'result quality, not token minimization',
      'Default peer breadth',
      'Model/effort defaults',
      'Review depth',
      'User constraints',
      'parallel-review',
    ]) {
      ok(text.includes(token), `quality-first defaults missing ${token}`);
    }
  });

  it('mirrors the routing recommendation in both Claude command and Codex skill surfaces', async () => {
    const command = await readFile(COMMAND_PATH, 'utf8');
    const skill = await readFile(SKILL_PATH, 'utf8');
    for (const text of [command, skill]) {
      ok(text.includes('Entry routing recommendation'), 'surface missing Entry routing recommendation');
      for (const token of [
        '/engineer:start',
        '$engineer:start',
        '/orchestrator:plan',
        '$orchestrator:plan',
        '/runtime:worktree plan',
        '$runtime:worktree',
        '/runtime:doctor',
        '/runtime:settings',
        '/runtime:compat',
        '/runtime:context',
        '/runtime:cutover',
        '/engineer:<verb>',
        '$engineer:<verb>',
      ]) {
        ok(text.includes(token), `surface missing ${token}`);
      }
    }
  });

  it('mirrors the decision prompt and quality-gate fields in both command and skill surfaces', async () => {
    const command = await readFile(COMMAND_PATH, 'utf8');
    const skill = await readFile(SKILL_PATH, 'utf8');
    for (const text of [command, skill]) {
      for (const token of [
        'Options',
        'Tradeoffs',
        'Risks',
        'Recommendation',
        'Confidence',
        'Evidence pointers',
        'Default next command',
        'standards',
        'root-cause',
        'verification evidence',
      ]) {
        ok(text.includes(token), `surface missing ${token}`);
      }
    }
  });

  it('mirrors quality-first defaults in both command and skill surfaces', async () => {
    const command = await readFile(COMMAND_PATH, 'utf8');
    const skill = await readFile(SKILL_PATH, 'utf8');
    for (const text of [command, skill]) {
      for (const token of [
        'Quality-first defaults',
        'best-results-over-token-minimization',
        'peer breadth',
        'model/effort defaults',
        'review depth',
        'parallel-review',
        'token saving',
      ]) {
        ok(text.includes(token), `surface missing ${token}`);
      }
    }
  });
});

describe('/engineer:start — provenance citations', () => {
  it('cites ADR-0020', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/ADR-0020/.test(text), 'body must cite ADR-0020');
  });

  it('cites ADR-0018 §sub-2 branch-anchored invariant', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/ADR-0018/.test(text), 'body must cite ADR-0018');
  });

  it('references the engineer 6-verb command pattern (precedent)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    // Either explicit list of verbs or a reference to the verb commands.
    ok(
      /(investigate.{0,200}frame.{0,200}decide|six.{0,30}verb|6.{0,30}verb)/i.test(text),
      'body must reference the six canonical verbs',
    );
  });
});

// -----------------------------------------------------------------------------
// Layer 1 — Phase 0 clean-baseline gate (ADR-0028 §Layer-1)
//
// `evaluateCleanBaseline` is the pure decision function: given the
// porcelain output and the accept-current-tree bypass flag, it returns
// {status, categories}. The CLI wrapper in state.mjs runs
// `git status --porcelain=v1` and forwards the result.

describe('evaluateCleanBaseline — pure decision function (ADR-0028 §Layer-1)', () => {
  it('returns status=clean for empty porcelain output', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: '' });
    strictEqual(r.status, 'clean');
    deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
  });

  it('classifies a modified tracked file (" M") as modified', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: ' M plugins/engineer/scripts/state.mjs\n' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.modified, ['plugins/engineer/scripts/state.mjs']);
    deepStrictEqual(r.categories.staged, []);
    deepStrictEqual(r.categories.untracked, []);
  });

  it('classifies a staged-add ("A ") as staged', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: 'A  docs/new.md\n' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.staged, ['docs/new.md']);
  });

  it('classifies a staged-modify ("M ") as staged', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: 'M  AGENTS.md\n' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.staged, ['AGENTS.md']);
  });

  it('classifies an untracked file ("??") as untracked', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: '?? scratch.txt\n' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.untracked, ['scratch.txt']);
  });

  it('excludes .agentic-plugins/state/** from all categories (workflow storage)', () => {
    // ADR-0028 §Layer-1: "tracked modifications, staged changes, or
    // untracked files **excluding** the `.agentic-plugins/state` workflow
    // storage". A workflow file change does NOT make the baseline dirty.
    const r = evaluateCleanBaseline({
      statusPorcelain:
        '?? .agentic-plugins/state/engineer/workflows/x.md\n' +
        ' M .agentic-plugins/state/engineer/workflows/y.md\n' +
        'A  .agentic-plugins/state/engineer/workflows/z.md\n',
    });
    strictEqual(r.status, 'clean');
    deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
  });

  it('preserves non-workflow-storage dirty entries alongside excluded workflow entries', () => {
    const r = evaluateCleanBaseline({
      statusPorcelain:
        ' M plugins/engineer/scripts/state.mjs\n' +
        ' M .agentic-plugins/state/engineer/workflows/x.md\n',
    });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.modified, ['plugins/engineer/scripts/state.mjs']);
  });

  it('returns status=accepted when acceptCurrentTree=true overrides a dirty tree', () => {
    // ADR-0028 §Layer-1 accept-current-tree bypass: ACCEPT_CURRENT_TREE=1
    // env-var lets the workflow sweep the current tree into its commit.
    // The categories field still surfaces what is dirty so phase7-commit.mjs
    // can act on it.
    const r = evaluateCleanBaseline({
      statusPorcelain: ' M plugins/engineer/scripts/state.mjs\n',
      acceptCurrentTree: true,
    });
    strictEqual(r.status, 'accepted');
    deepStrictEqual(r.categories.modified, ['plugins/engineer/scripts/state.mjs']);
  });

  it('returns status=clean when acceptCurrentTree=true but tree is clean (idempotent)', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: '', acceptCurrentTree: true });
    strictEqual(r.status, 'clean');
  });

  it('handles rename ("R ") porcelain entries with the renamed-to path', () => {
    // `git status --porcelain=v1` rename format: "R  old -> new"
    const r = evaluateCleanBaseline({
      statusPorcelain: 'R  old.md -> docs/renamed.md\n',
    });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.staged, ['docs/renamed.md']);
  });

  it('N4 — inside-to-inside workflow-storage rename stays clean', () => {
    // Both OLD and NEW are workflow storage → engineer's own bookkeeping
    // moving between workflows/ and archive/. Counts as clean.
    const r = evaluateCleanBaseline({
      statusPorcelain:
        'R  .agentic-plugins/state/engineer/workflows/x.md -> ' +
        '.agentic-plugins/state/engineer/archive/x.md\n',
    });
    strictEqual(r.status, 'clean');
    deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
  });

  it('N4 — outside-into-workflow-storage rename is dirty (surfaces the OLD outside path)', () => {
    // OLD is outside workflow-storage → user is moving a real source file
    // into the engineer state tree. The OLD path disappears from the
    // working tree; phase7 must surface that endpoint so the user can
    // resolve. PR3 Codex peer review MINOR N4-assert: explicit endpoint
    // check (length-only was too weak).
    const r = evaluateCleanBaseline({
      statusPorcelain:
        'R  AGENTS.md -> .agentic-plugins/state/engineer/workflows/AGENTS.md\n',
    });
    strictEqual(r.status, 'dirty');
    const allSurfaced = [...r.categories.staged, ...r.categories.modified];
    ok(
      allSurfaced.includes('AGENTS.md'),
      `rename outside→inside must surface OLD path 'AGENTS.md' (got: ${JSON.stringify(allSurfaced)})`,
    );
  });

  it('N4 — workflow-storage-into-outside rename is dirty (surfaces the NEW outside path)', () => {
    // OLD inside, NEW outside → workflow-storage content is being moved
    // out into the tracked tree. Dirty so phase7 stages or refuses.
    // PR3 N4-assert: explicit endpoint check.
    const r = evaluateCleanBaseline({
      statusPorcelain:
        'R  .agentic-plugins/state/engineer/workflows/y.md -> docs/y.md\n',
    });
    strictEqual(r.status, 'dirty');
    const allSurfaced = [...r.categories.staged, ...r.categories.modified];
    ok(
      allSurfaced.includes('docs/y.md'),
      `rename inside→outside must surface NEW path 'docs/y.md' (got: ${JSON.stringify(allSurfaced)})`,
    );
  });
});

describe('/engineer:start — Layer 1 clean-baseline gate (ADR-0028)', () => {
  it('invokes state.mjs check-clean-baseline before state.mjs create on the bootstrap path', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,200}check-clean-baseline/.test(text),
      'Phase 0 bootstrap must call state.mjs check-clean-baseline',
    );
    // Gate fires BEFORE the bootstrap state.mjs create. The verb-chain
    // typed-conflict branch also references "state.mjs create" in prose
    // so we anchor on the workflow-type=start bootstrap site explicitly.
    const gateIdx = text.indexOf('check-clean-baseline');
    const createIdx = text.indexOf('--workflow-type start');
    ok(gateIdx >= 0, 'check-clean-baseline must appear');
    ok(createIdx >= 0, '--workflow-type start bootstrap must appear');
    ok(
      gateIdx < createIdx,
      'clean-baseline gate must precede the workflow-type=start bootstrap',
    );
  });

  it('cites ADR-0028 §Layer-1 in the gate prose', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/ADR-0028/.test(text), 'Layer 1 gate must cite ADR-0028');
  });

  it('surfaces all four ADR-0028 §Layer-1 resolutions to the user', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    // The four resolutions per ADR §Layer-1: clean, stash, worktree, accept-current-tree.
    for (const resolution of ['stash', 'worktree', 'accept-current-tree', 'ACCEPT_CURRENT_TREE']) {
      ok(text.includes(resolution), `Layer 1 gate must offer ${resolution} resolution`);
    }
  });

  it('mirrors the Layer 1 gate description in the SKILL.md Codex parity surface', async () => {
    const skill = await readFile(SKILL_PATH, 'utf8');
    ok(/clean.{0,30}baseline|Layer.?1/.test(skill), 'SKILL.md must describe the Layer 1 clean-baseline gate');
    ok(/ACCEPT_CURRENT_TREE/.test(skill), 'SKILL.md must mention the ACCEPT_CURRENT_TREE bypass');
  });
});
