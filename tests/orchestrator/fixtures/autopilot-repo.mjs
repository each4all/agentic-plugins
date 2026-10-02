// A scratch repository for the autopilot tests, built with the plugins' own
// state APIs (this checkout's): a bare `origin`, a clone on `main` that
// ignores the agentic state, an approved macro, and helpers that put engineer
// children in the states the driver reads. `gh` is a fake on PATH that answers
// `pr list` from a JSON file the test writes.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
export const ORCH = resolve(REPO_ROOT, 'plugins/orchestrator');
export const ENG = resolve(REPO_ROOT, 'plugins/engineer');
export const RUNTIME = resolve(REPO_ROOT, 'plugins/runtime');
const orch = await import(resolve(ORCH, 'scripts/state.mjs'));
const eng = await import(resolve(ENG, 'scripts/state.mjs'));

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'list') {
  let prs = [];
  try { prs = JSON.parse(fs.readFileSync(process.env.FAKE_GH_PRS, 'utf8')); } catch {}
  const head = args[args.indexOf('--head') + 1];
  process.stdout.write(JSON.stringify(prs.filter((p) => p.headRefName === head)));
  process.exit(0);
}
process.stderr.write('fake gh: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`;

/**
 * @param o.subtasks  plan subtasks ({id, branch?, blocked_by?, verb?})
 * @returns the fixture: { dir, work, origin, macroPath, macroId, env, git, ... }
 */
export async function makeRepo({ subtasks = [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }], approve = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-repo-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const env = { ...process.env, ...GIT_ENV };
  for (const k of Object.keys(env)) if (k.startsWith('AGENTIC_') || k.startsWith('CLAUDE')) delete env[k];
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  execFileSync('git', ['clone', '-q', origin, work], { env });
  writeFileSync(join(work, '.gitignore'), '.agentic-plugins/runs/\n.agentic-plugins/state/\n.agentic-plugins/tmp/\n.agentic-plugins/cache/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'chore: init');
  git('push', '-q', 'origin', 'HEAD:main');
  git('fetch', '-q', 'origin');

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const prs = join(dir, 'prs.json');
  writeFileSync(prs, '[]');
  env.PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`;
  env.FAKE_GH_PRS = prs;

  const { filePath: macroPath } = await orch.createWorkflow({
    repoRoot: work, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: git('rev-parse', 'HEAD'), status_digest: '' },
    originalRequest: 'autopilot fixture',
  });
  const plan = subtasks.map((s) => ({
    id: s.id, label: s.id, verb: s.verb ?? 'compose', profile: 'backend', topic: `do ${s.id}`,
    branch: s.branch ?? `feat/${s.id.toLowerCase()}`, blocked_by: s.blocked_by ?? [],
    status: s.status ?? ((s.blocked_by ?? []).length ? 'blocked' : 'pending'),
  }));
  await orch.setPlan({ workflowPath: macroPath, host: 'claude', subtasks: plan });
  if (approve) await orch.approvePlan({ workflowPath: macroPath, host: 'claude', env: {} });
  const macroId = (await orch.readWorkflow(macroPath)).frontmatter.workflow_id;

  const fx = {
    dir, work, origin, macroPath, macroId, env, git, prs, orch, eng,
    roots: { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    setPrs: (list) => writeFileSync(prs, JSON.stringify(list)),
    async readMacro() { return (await orch.readWorkflow(macroPath)).frontmatter; },
    subtask: async (id) => (await fx.readMacro()).plan.subtasks.find((s) => s.id === id),

    /** /orchestrator:next's effect: the branch, the child, the subtask in progress. */
    async dispatch(id, { now = new Date(), checkout = true } = {}) {
      const s = await fx.subtask(id);
      if (checkout) {
        git('switch', '-q', '--no-track', '-c', s.branch, 'refs/remotes/origin/main');
      }
      const { filePath } = await eng.createWorkflow({
        repoRoot: work, verb: s.verb, host: 'claude', profile: 'backend', originalRequest: s.topic,
        gitBaseline: { branch: s.branch, head: git('rev-parse', 'HEAD'), status_digest: '' },
        currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb',
        parentWorkflow: macroId, originatingSubtask: id, now,
      });
      const wfId = (await eng.readWorkflow(filePath)).frontmatter.workflow_id;
      await orch.updateSubtask({ workflowPath: macroPath, subtaskId: id, host: 'claude', status: 'in_progress', engineerWorkflowId: wfId });
      return { path: filePath, id: wfId };
    },

    /** A verb's last write: the next step, terminal or not. */
    async finish(childPath, nextStep, { autopilot = true, ownerGate } = {}) {
      return eng.finishVerb({
        workflowPath: childPath, host: 'claude', nextAction: 'next', nextStep, ownerGate,
        env: autopilot ? { AGENTIC_AUTOPILOT: 'autopilot-20261001T000000Z-abcdef' } : {},
      });
    },

    /** /engineer:commit and the Stop hook: a commit on the branch, then the archive. */
    async commitAndArchive(childPath, { file = 'work.txt', phase = 'commit-complete' } = {}) {
      if (phase !== 'close-complete') {
        writeFileSync(join(work, file), `${file}\n`);
        git('add', file);
        git('commit', '-q', '-m', `feat: ${file}`);
      }
      await eng.setTerminal({ workflowPath: childPath, host: 'claude', terminalPhase: phase });
      return eng.archiveWorkflow({ workflowPath: childPath, host: 'claude', repoRoot: work });
    },

    /** The owner lands a branch: a squash commit on origin/main, and gh reporting the PR merged. */
    land(id, branch, { number = 7, createdAt = new Date(Date.now() + 60_000).toISOString() } = {}) {
      const current = git('branch', '--show-current');
      git('fetch', '-q', 'origin');
      git('switch', '-q', '--detach', 'refs/remotes/origin/main');
      git('merge', '-q', '--squash', branch);
      git('commit', '-q', '-m', `feat: ${id} (#${number})`);
      const squash = git('rev-parse', 'HEAD');
      git('push', '-q', 'origin', 'HEAD:main');
      git('fetch', '-q', 'origin');
      git('switch', '-q', current);
      return {
        number, url: `https://example.invalid/pull/${number}`, state: 'MERGED', baseRefName: 'main',
        headRefName: branch, createdAt, mergeCommit: { oid: squash },
      };
    },
  };
  return fx;
}
