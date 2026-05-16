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
import { strictEqual, ok, match } from 'node:assert/strict';
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

  it('Phase 7 commits and sets terminal state via state.mjs set-terminal', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,200}set-terminal/.test(text),
      'Phase 7 must call state.mjs set-terminal for auto-archive (ADR-0017 §sub-5)',
    );
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
