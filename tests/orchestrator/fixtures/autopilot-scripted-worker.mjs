// The scripted worker for tests/orchestrator/test-autopilot-driver.mjs: the
// fake `claude` (FAKE_CLAUDE_MODE=script) hands it each step's prompt, and it
// does what the runbook would, through the plugins' real state APIs and CLIs
// (the roots the driver exported), then runs the real engineer and
// orchestrator Stop hooks as the turn end would. No model is involved, so the
// test exercises the driver against the actual state contracts.
//
// FAKE_SCENARIO names a JSON file: { "<subtask>": { "next": [<next_step>…],
// "file": true|false }, "actions": { "<seq>": "noop"|"edit-plan"|"sleep"|
// "bump-engineer"|"report-failed"|"pending-sleep"|"peer-sleep" } } — `next` is the next step each verb of that subtask
// records, in order; `file` makes its first verb write a file to commit:
// `<id>.txt` for true, or the path it names, holding `<id>` either way (two
// subtasks naming one path conflict).
//
// With lanes (ADR-0067 Decision 6) several workers run at once, each in its
// own checkout: `"seqFromArgv": true` keys `actions` by the run's step seq
// (the `step=<n>` the driver writes into each worker's system prompt) instead
// of a shared counter, each subtask's next-step position is kept in its own
// file, the run ledger is read from FAKE_DRIVER_CHECKOUT (the driver's
// checkout) and the macro from AGENTIC_STATE_BASE, and a dispatch into a lane
// already on its branch does not cut it again. An action may be a list, and
// takes four more forms for ordering workers: "wait:<name>" (wait, at the
// start, up to 60 s for the file <name> beside the scenario; one that runs out
// writes <name>.timeout), "stop-wait:<name>" (the same wait, once the step's
// work is done and before the Stop hooks run), "mark-start:<name>" (write it at
// the start) and "mark:<name>" (write it at the end). `"events": { "<seq>":
// [<rate_limit_info>…] }` emits those rate_limit_events into the step's stream
// before its Stop hooks run (the stream's first one, after init, is the fake's
// FAKE_RATE_LIMIT).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const node = process.execPath;

export async function perform({ prompt, cwd, env }) {
  const scenario = JSON.parse(fs.readFileSync(env.FAKE_SCENARIO, 'utf8'));
  const dir = path.dirname(env.FAKE_SCENARIO);
  const argv = process.argv;
  let seq;
  if (scenario.seqFromArgv) {
    seq = /\bstep=(\d+)\]/.exec(argv[argv.indexOf('--append-system-prompt') + 1] ?? '')?.[1];
    if (!seq) throw new Error('scripted worker: no step seq in the system prompt');
  } else {
    const counters = path.join(dir, 'counters.json');
    const count = fs.existsSync(counters) ? JSON.parse(fs.readFileSync(counters, 'utf8')) : { steps: 0 };
    count.steps += 1;
    fs.writeFileSync(counters, JSON.stringify(count));
    seq = String(count.steps);
  }
  const ledgerCheck = path.join(dir, `ledger-${seq}.json`);
  const actionList = [scenario.actions?.[seq] ?? []].flat();
  for (const a of actionList) {
    if (a.startsWith('mark-start:')) fs.writeFileSync(path.join(dir, a.slice('mark-start:'.length)), seq);
  }
  const waitFor = async (name) => {
    const file = path.join(dir, name);
    for (let i = 0; i < 1200 && !fs.existsSync(file); i += 1) await new Promise((r) => { setTimeout(r, 50); });
    // A wait that ran out is on record: the order a test set up did not happen.
    if (!fs.existsSync(file)) fs.writeFileSync(`${file}.timeout`, seq);
  };
  for (const a of actionList) {
    if (a.startsWith('wait:')) await waitFor(a.slice('wait:'.length));
  }

  // D1: the spawn is on record before it starts — the session id this
  // process was given is already in a `started` line of the ledger.
  const sid = argv[argv.indexOf('--session-id') + 1];
  const runsDir = path.join(env.FAKE_DRIVER_CHECKOUT ?? cwd, '.agentic-plugins', 'runs', 'autopilot');
  const runs = fs.readdirSync(runsDir).filter((n) => n.startsWith('autopilot-')).sort();
  const steps = fs.readFileSync(path.join(runsDir, runs.at(-1), 'steps.jsonl'), 'utf8');
  // …and this worker is on the run's locks before it got its prompt: the
  // lock of the checkout it runs in.
  let registered = false;
  try {
    const lock = path.join(cwd, '.agentic-plugins', 'runs', 'autopilot', 'worktree.lock');
    registered = fs.readdirSync(lock).filter((n) => /^h-.*\.json$/.test(n))
      .some((n) => JSON.parse(fs.readFileSync(path.join(lock, n), 'utf8')).worker?.pid === process.pid);
  } catch { /* no lock */ }
  fs.writeFileSync(ledgerCheck, JSON.stringify({ recorded: steps.split('\n').some((l) => l.includes('"started"') && l.includes(sid)), registered }));

  const eng = await import(path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'state.mjs'));
  const orch = await import(path.join(env.AGENTIC_ORCHESTRATOR_ROOT, 'scripts', 'state.mjs'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
  const engCli = path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'state.mjs');
  const orchCli = path.join(env.AGENTIC_ORCHESTRATOR_ROOT, 'scripts', 'state.mjs');
  const action = actionList.find((a) => !/^(wait|stop-wait|mark|mark-start):/.test(a)) ?? null;
  const stateBase = env.AGENTIC_STATE_BASE || cwd;
  const finish = (r) => {
    for (const a of actionList) if (a.startsWith('mark:')) fs.writeFileSync(path.join(dir, a.slice('mark:'.length)), seq);
    return r;
  };

  const stopHooks = async () => {
    for (const info of [scenario.events?.[seq] ?? []].flat()) {
      process.stdout.write(`${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'fake', session_id: 'fake' })}\n`);
    }
    for (const a of actionList) {
      if (a.startsWith('stop-wait:')) await waitFor(a.slice('stop-wait:'.length));
    }
    for (const root of [env.AGENTIC_ENGINEER_ROOT, env.AGENTIC_ORCHESTRATOR_ROOT]) {
      spawnSync(node, [path.join(root, 'adapters', 'claude', 'hooks', 'stop.mjs')], { cwd, env, input: JSON.stringify({ cwd }), encoding: 'utf8' });
    }
  };
  // Each subtask's position in its own file: lanes write theirs at once.
  const nextFor = (id) => {
    const s = scenario[id];
    const file = path.join(dir, `taken-${id}.json`);
    const n = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : 0;
    fs.writeFileSync(file, JSON.stringify(n + 1));
    return s.next[Math.min(n, s.next.length - 1)];
  };
  const verbReport = (wf, ns) => ({ outcome: 'completed', workflow: wf, next_step: ns, awaiting_owner: null, summary: 'scripted verb' });
  const plainReport = { outcome: 'completed', workflow: null, next_step: null, awaiting_owner: null, summary: 'scripted step' };

  if (action === 'noop') {
    // Change nothing, and report the state as it is — the report agrees, so
    // only the fingerprint can tell that nothing happened.
    const active = execFileSync(node, [engCli, 'find-active', '--repo-root', cwd], { env, encoding: 'utf8' }).trim();
    if (!active) return finish({ report: plainReport });
    const fm = (await eng.readWorkflow(active)).frontmatter;
    const ns = fm.next_step_kind ? { kind: fm.next_step_kind, verb: fm.next_step_verb ?? null, confidence: fm.next_step_confidence } : null;
    return finish({ report: verbReport(fm.workflow_id, ns) });
  }
  if (action === 'sleep') {
    await new Promise((r) => { setTimeout(r, 60_000); });
  }

  let m = /^\/orchestrator:next (\S+) --workflow=(\S+)$/.exec(prompt);
  if (m) {
    const [, id, macroId] = m;
    const macroPath = path.join(stateBase, '.agentic-plugins', 'state', 'orchestrator', 'workflows', `${macroId}.md`);
    const sub = (await orch.readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);
    git('fetch', '-q', 'origin', 'main');
    // A lane is already on its branch.
    if (git('branch', '--show-current') !== sub.branch) git('switch', '-q', '--no-track', '-c', sub.branch, 'refs/remotes/origin/main');
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
      if (scenario.otherLane) {
        // Another lane's subtask: its child launches a peer while this step
        // runs. Killing this step must leave that peer alone.
        const other = scenario.otherLane;
        const { filePath: otherPath } = await eng.createWorkflow({
          repoRoot: cwd, verb: 'compose', host: 'claude', profile: 'backend', originalRequest: `do ${other.id}`,
          gitBaseline: { branch: other.branch, head: git('rev-parse', 'HEAD'), status_digest: '' },
          currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: macroId, originatingSubtask: other.id,
        });
        await eng.recordPendingEnsemble({ workflowPath: otherPath, phase: 'compose', ensemble_type: 'plan-verify', run_id: 'plan-verify-20261001T000000Z-feed02' });
      }
      fs.writeFileSync(path.join(path.dirname(env.FAKE_SCENARIO), 'pending-ready'), '');
      await new Promise((r) => { setTimeout(r, 60_000); });
    }
    if (action === 'peer-sleep') {
      // The verb launches a real peer process, detached from this worker's
      // group as peer-runner's is, under a handle that names the run
      // (`autopilot_run`, ADR-0067 Decision 6) in the workflow's own peer-run
      // home; then the driver dies (the test kills it) while the step runs.
      const runner = await import(path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'peer-runner.mjs'));
      const peer = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      peer.unref();
      await new Promise((r) => { setTimeout(r, 200); });
      const peerId = 'plan-verify-20261001T000000Z-feed03';
      const at = new Date().toISOString();
      const dir = path.join(path.dirname(path.dirname(filePath)), 'peer-runs', peerId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'handle.json'), JSON.stringify({
        schema_version: '1.0', run_id: peerId, plugin: 'engineer', kind: 'ensemble', workflow_path: filePath, phase: 'compose',
        ensemble_type: 'plan-verify', host: 'claude', peer_host: 'codex', model: null, effort: null, cwd, output_format: 'json',
        status: 'running', pid: peer.pid, pgid: peer.pid, process_fingerprint: await runner.fingerprintForPid(peer.pid),
        started_at: at, updated_at: at, completed_at: null, last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
        exit_code: null, error_kind: null, prompt_retained: false, autopilot_run: env.AGENTIC_AUTOPILOT,
      }, null, 2));
      await eng.recordPendingEnsemble({ workflowPath: filePath, phase: 'compose', ensemble_type: 'plan-verify', run_id: peerId });
      fs.writeFileSync(path.join(path.dirname(env.FAKE_SCENARIO), 'peer-ready'), JSON.stringify({ peer: peer.pid, peer_run_id: peerId, handle: path.join(dir, 'handle.json'), worker: process.pid }));
      await new Promise((r) => { setTimeout(r, 60_000); });
    }
    await orch.updateSubtask({ workflowPath: macroPath, subtaskId: id, host: 'claude', status: 'in_progress', engineerWorkflowId: wf });
    if (scenario[id].file) {
      const rel = typeof scenario[id].file === 'string' ? scenario[id].file : `${id.toLowerCase()}.txt`;
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
    await stopHooks();
    return finish({ report: verbReport(wf, ns) });
  }

  m = /^\/engineer:([a-z]+)$/.exec(prompt);
  if (m && m[1] !== 'commit') {
    const active = execFileSync(node, [engCli, 'find-active', '--repo-root', cwd], { env, encoding: 'utf8' }).trim();
    const fm = (await eng.readWorkflow(active)).frontmatter;
    await eng.appendPhase({ workflowPath: active, host: 'claude', verb: m[1], phaseLabel: `Phase 0: Resume into ${m[1]}`, currentPhase: 'phase-0-resume', clearNextStep: true, nextAction: 'run', event: 'resumed' });
    const ns = nextFor(fm.originating_subtask);
    await eng.finishVerb({ workflowPath: active, host: 'claude', nextAction: 'next', nextStep: ns });
    await stopHooks();
    return finish({ report: verbReport(fm.workflow_id, ns) });
  }

  if (prompt === '/engineer:commit') {
    const active = execFileSync(node, [engCli, 'find-active', '--repo-root', cwd], { env, encoding: 'utf8' }).trim();
    const r = spawnSync(node, [path.join(env.AGENTIC_ENGINEER_ROOT, 'scripts', 'phase7-commit.mjs'), '--mode', 'autopilot',
      '--workflow-path', active, '--repo-root', cwd, '--host', 'claude'], { cwd, env, encoding: 'utf8' });
    fs.writeFileSync(path.join(path.dirname(env.FAKE_SCENARIO), `phase7-${seq}.json`), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
    await stopHooks();
    // The commit landed, but the worker reports failure (worker-failed).
    if (action === 'report-failed') return finish({ report: { ...plainReport, outcome: 'failed', summary: 'scripted failure after the commit' } });
    return finish({ report: plainReport });
  }

  m = /^\/orchestrator:done (\S+)( --no-commit)? --workflow=(\S+)/.exec(prompt);
  if (m) {
    const [, id, noCommit, macroId] = m;
    const macroPath = path.join(stateBase, '.agentic-plugins', 'state', 'orchestrator', 'workflows', `${macroId}.md`);
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
    await stopHooks();
    return finish({ report: plainReport });
  }

  throw new Error(`scripted worker: no script for ${JSON.stringify(prompt)}`);
}
