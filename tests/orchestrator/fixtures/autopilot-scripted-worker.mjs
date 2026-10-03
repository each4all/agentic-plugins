// The scripted worker for tests/orchestrator/test-autopilot-driver.mjs: the
// fake `claude` (FAKE_CLAUDE_MODE=script) hands it each step's prompt, and it
// does what the runbook would, through the plugins' real state APIs and CLIs
// (the roots the driver exported), then runs the real engineer and
// orchestrator Stop hooks as the turn end would. No model is involved, so the
// test exercises the driver against the actual state contracts.
//
// FAKE_SCENARIO names a JSON file: { "<subtask>": { "next": [<next_step>…],
// "file": true|false }, "actions": { "<seq>": "noop"|"edit-plan"|"sleep"|
// "bump-engineer" } } — `next` is the next step each verb of that subtask
// records, in order; `file` makes its first verb write a file to commit.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const node = process.execPath;

export async function perform({ prompt, cwd, env }) {
  const scenario = JSON.parse(fs.readFileSync(env.FAKE_SCENARIO, 'utf8'));
  const counters = path.join(path.dirname(env.FAKE_SCENARIO), 'counters.json');
  const count = fs.existsSync(counters) ? JSON.parse(fs.readFileSync(counters, 'utf8')) : { steps: 0 };
  count.steps += 1;
  fs.writeFileSync(counters, JSON.stringify(count));
  const seq = String(count.steps);
  const ledgerCheck = path.join(path.dirname(env.FAKE_SCENARIO), `ledger-${seq}.json`);

  // D1: the spawn is on record before it starts — the session id this
  // process was given is already in a `started` line of the ledger.
  const argv = process.argv;
  const sid = argv[argv.indexOf('--session-id') + 1];
  const runsDir = path.join(cwd, '.agentic-plugins', 'runs', 'autopilot');
  const runs = fs.readdirSync(runsDir).filter((n) => n.startsWith('autopilot-')).sort();
  const steps = fs.readFileSync(path.join(runsDir, runs.at(-1), 'steps.jsonl'), 'utf8');
  // …and this worker is on the run's locks before it got its prompt.
  let registered = false;
  try {
    const lock = path.join(runsDir, 'worktree.lock');
    registered = fs.readdirSync(lock).filter((n) => /^h-.*\.json$/.test(n))
      .some((n) => JSON.parse(fs.readFileSync(path.join(lock, n), 'utf8')).worker?.pid === process.pid);
  } catch { /* no lock */ }
  fs.writeFileSync(ledgerCheck, JSON.stringify({ recorded: steps.split('\n').some((l) => l.includes('"started"') && l.includes(sid)), registered }));

  const eng = await import(path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'state.mjs'));
  const orch = await import(path.join(env.AGENTIC_ORCHESTRATOR_ROOT, 'scripts', 'state.mjs'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
  const engCli = path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'state.mjs');
  const orchCli = path.join(env.AGENTIC_ORCHESTRATOR_ROOT, 'scripts', 'state.mjs');
  const action = scenario.actions?.[seq] ?? null;

  const stopHooks = () => {
    for (const root of [env.AGENTIC_ENGINEER_ROOT, env.AGENTIC_ORCHESTRATOR_ROOT]) {
      spawnSync(node, [path.join(root, 'adapters', 'claude', 'hooks', 'stop.mjs')], { cwd, env, input: JSON.stringify({ cwd }), encoding: 'utf8' });
    }
  };
  const nextFor = (id) => {
    const s = scenario[id];
    const n = (s.taken ?? 0);
    s.taken = n + 1;
    fs.writeFileSync(env.FAKE_SCENARIO, JSON.stringify(scenario));
    return s.next[Math.min(n, s.next.length - 1)];
  };
  const verbReport = (wf, ns) => ({ outcome: 'completed', workflow: wf, next_step: ns, awaiting_owner: null, summary: 'scripted verb' });
  const plainReport = { outcome: 'completed', workflow: null, next_step: null, awaiting_owner: null, summary: 'scripted step' };

  if (action === 'noop') {
    // Change nothing, and report the state as it is — the report agrees, so
    // only the fingerprint can tell that nothing happened.
    const active = execFileSync(node, [engCli, 'find-active', '--repo-root', cwd], { env, encoding: 'utf8' }).trim();
    if (!active) return { report: plainReport };
    const fm = (await eng.readWorkflow(active)).frontmatter;
    const ns = fm.next_step_kind ? { kind: fm.next_step_kind, verb: fm.next_step_verb ?? null, confidence: fm.next_step_confidence } : null;
    return { report: verbReport(fm.workflow_id, ns) };
  }
  if (action === 'sleep') {
    await new Promise((r) => { setTimeout(r, 60_000); });
  }

  let m = /^\/orchestrator:next (\S+) --workflow=(\S+)$/.exec(prompt);
  if (m) {
    const [, id, macroId] = m;
    const macroPath = path.join(cwd, '.agentic-plugins', 'state', 'orchestrator', 'workflows', `${macroId}.md`);
    const sub = (await orch.readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);
    git('fetch', '-q', 'origin', 'main');
    git('switch', '-q', '--no-track', '-c', sub.branch, 'refs/remotes/origin/main');
    const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { env });
    const { filePath } = await eng.createWorkflow({
      repoRoot: cwd, verb: sub.verb, host: 'claude', profile: sub.profile, originalRequest: sub.topic,
      gitBaseline: { branch: sub.branch, head: git('rev-parse', 'HEAD'), status_digest: createHash('sha256').update(status).digest('hex') },
      currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: macroId, originatingSubtask: id,
    });
    const wf = (await eng.readWorkflow(filePath)).frontmatter.workflow_id;
    if (action === 'pending-sleep') {
      // As /orchestrator:next runs: the verb starts (and launches its peer)
      // before Phase 5 records the subtask in progress. The step is killed
      // in between.
      await eng.recordPendingEnsemble({ workflowPath: filePath, phase: 'compose', ensemble_type: 'plan-verify', run_id: 'plan-verify-20261001T000000Z-feed01' });
      fs.writeFileSync(path.join(path.dirname(env.FAKE_SCENARIO), 'pending-ready'), '');
      await new Promise((r) => { setTimeout(r, 60_000); });
    }
    await orch.updateSubtask({ workflowPath: macroPath, subtaskId: id, host: 'claude', status: 'in_progress', engineerWorkflowId: wf });
    if (scenario[id].file) {
      const rel = `${id.toLowerCase()}.txt`;
      fs.writeFileSync(path.join(cwd, rel), `${id}\n`);
      await eng.recordComposedFile({ workflowPath: filePath, path: rel, op: 'create' });
    }
    const ns = nextFor(id);
    await eng.finishVerb({ workflowPath: filePath, host: 'claude', nextAction: 'next', nextStep: ns });
    if (action === 'edit-plan') {
      const fm = (await orch.readWorkflow(macroPath)).frontmatter;
      await orch.setPlan({ workflowPath: macroPath, host: 'claude', subtasks: fm.plan.subtasks.map((s) => (s.id === 'B' ? { ...s, topic: `${s.topic} (edited)` } : s)) });
    }
    if (action === 'bump-engineer') {
      const manifest = path.join(env.AGENTIC_ENGINEER_ROOT, '.claude-plugin', 'plugin.json');
      const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      j.version = '99.0.0';
      fs.writeFileSync(manifest, JSON.stringify(j));
    }
    stopHooks();
    return { report: verbReport(wf, ns) };
  }

  m = /^\/engineer:([a-z]+)$/.exec(prompt);
  if (m && m[1] !== 'commit') {
    const active = execFileSync(node, [engCli, 'find-active', '--repo-root', cwd], { env, encoding: 'utf8' }).trim();
    const fm = (await eng.readWorkflow(active)).frontmatter;
    await eng.appendPhase({ workflowPath: active, host: 'claude', verb: m[1], phaseLabel: `Phase 0: Resume into ${m[1]}`, currentPhase: 'phase-0-resume', clearNextStep: true, nextAction: 'run', event: 'resumed' });
    const ns = nextFor(fm.originating_subtask);
    await eng.finishVerb({ workflowPath: active, host: 'claude', nextAction: 'next', nextStep: ns });
    stopHooks();
    return { report: verbReport(fm.workflow_id, ns) };
  }

  if (prompt === '/engineer:commit') {
    const active = execFileSync(node, [engCli, 'find-active', '--repo-root', cwd], { env, encoding: 'utf8' }).trim();
    const r = spawnSync(node, [path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'phase7-commit.mjs'), '--mode', 'autopilot',
      '--workflow-path', active, '--repo-root', cwd, '--host', 'claude'], { cwd, env, encoding: 'utf8' });
    fs.writeFileSync(path.join(path.dirname(env.FAKE_SCENARIO), `phase7-${seq}.json`), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
    stopHooks();
    return { report: plainReport };
  }

  m = /^\/orchestrator:done (\S+)( --no-commit)? --workflow=(\S+)/.exec(prompt);
  if (m) {
    const [, id, noCommit, macroId] = m;
    const macroPath = path.join(cwd, '.agentic-plugins', 'state', 'orchestrator', 'workflows', `${macroId}.md`);
    const sub = (await orch.readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (noCommit) {
      await orch.updateSubtask({ workflowPath: macroPath, subtaskId: id, host: 'claude', status: 'completed', engineerWorkflowId: sub.engineer_workflow_id, closedAt: now, expectBranch: sub.branch, reason: 'closed without a commit' });
    } else {
      git('fetch', '-q', 'origin', 'main');
      const landing = JSON.parse(spawnSync(node, [orchCli, 'resolve-landing', '--repo-root', cwd, '--workflow-path', macroPath, '--subtask-id', id], { cwd, env, encoding: 'utf8' }).stdout);
      if (!landing.ok) throw new Error(`landing refused: ${landing.reason}`);
      await orch.updateSubtask({ workflowPath: macroPath, subtaskId: id, host: 'claude', status: 'completed', engineerWorkflowId: sub.engineer_workflow_id, commit: landing.commit, prUrl: landing.pr_url, closedAt: now, expectBranch: sub.branch });
    }
    stopHooks();
    return { report: plainReport };
  }

  throw new Error(`scripted worker: no script for ${JSON.stringify(prompt)}`);
}
