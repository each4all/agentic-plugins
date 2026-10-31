// tests/orchestrator/_verify-fixtures.mjs
//
// verify-exec fixtures: a repository whose committed declaration's kinds run
// one small node script (`scripts/check.mjs <mode>`), an engineer workflow
// whose last verb recorded a request through the real persona CLI, and the
// job a verification step runs with.
//
// The script's modes: pass, fail (prints a TAP failure and a spec failure),
// hang, stubborn (ignores SIGTERM), exit127, touch (writes a file into the
// tree, then passes), env (writes its environment's AGENTIC_* names), slow
// (passes after a while). Each appends `<mode>` to $VERIFY_FIXTURE_LOG when
// it starts, so a test reads which checks ran, and in what order.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GIT_ISOLATION } from './fixtures/autopilot-repo.mjs';

export { GIT_ISOLATION };

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const AP = join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
export const ENGINEER_ROOT = join(REPO_ROOT, 'plugins/engineer');
export const RUN = 'autopilot-20261020T010203Z-abcdef';

// What the run inherited is scrubbed, and the git isolation every fixture
// carries (autopilot-repo.mjs: no system or global config, so no machine's
// hooks or signing) is put back, for this process, the persona CLIs it
// starts, and the fixture's own git.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('AGENTIC_')) delete process.env[k];
Object.assign(process.env, GIT_ISOLATION);
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), ...GIT_ISOLATION });
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() }).trim();

const CHECK = `import fs from 'node:fs';
const mode = process.argv[2];
if (process.env.VERIFY_FIXTURE_LOG) fs.appendFileSync(process.env.VERIFY_FIXTURE_LOG, mode + '\\n');
const hang = () => setInterval(() => {}, 1000);
switch (mode) {
  case 'pass': case 'pass2': case 'driver': case 'files': case 'suite': case 'selfpass': process.exit(0);
  case 'fail':
    console.log('TAP version 13');
    console.log('not ok 1 - suite > it fails');
    console.log('  ✖ another case (1.5ms)');
    process.exit(1);
  case 'hang': hang(); break;
  case 'stubborn': process.on('SIGTERM', () => {}); hang(); break;
  case 'exit127': process.exit(127);
  case 'touch': fs.writeFileSync('touched.txt', String(Date.now())); process.exit(0);
  case 'env': fs.writeFileSync(process.env.VERIFY_FIXTURE_ENV, JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('AGENTIC_')).sort())); process.exit(0);
  case 'slow': setTimeout(() => { if (process.env.VERIFY_FIXTURE_LOG) fs.appendFileSync(process.env.VERIFY_FIXTURE_LOG, 'slow-end\\n'); process.exit(0); }, Number(process.env.VERIFY_FIXTURE_SLOW_MS ?? 600)); break;
  default: process.exit(2);
}
`;

/** The check script's text, for a repository another fixture makes. */
export const CHECK_SCRIPT = CHECK;

const kind = (mode, over = {}) => ({ argv: ['node', 'scripts/check.mjs', mode], slots: [], timeout_s: 30, locks_itself: false, adds_on: [], ...over });
export const DECLARATION = JSON.stringify({
  schema: 'agentic-verify-checks-1.0',
  kinds: {
    pass: kind('pass'), pass2: kind('pass2'), driver: kind('driver'), fail: kind('fail'), hang: kind('hang', { timeout_s: 2 }),
    stubborn: kind('stubborn', { timeout_s: 2 }), exit127: kind('exit127'), touch: kind('touch'), env: kind('env'), slow: kind('slow'),
    self: kind('selfpass', { locks_itself: true }), missing: { ...kind('x'), argv: ['no-such-command-for-verify-exec'] },
    test: { ...kind('files'), argv: ['node', 'scripts/check.mjs', 'files', '{files}'], slots: [{ name: 'files', type: 'path', repeat: 'many', join: 'words', under: ['tests/'], suffix: '.mjs' }] },
    'test-suite': kind('suite'),
  },
}, null, 2);

/** A repository on branch feat/x with the declaration committed; `{ dir, sha }`. */
export function makeRepo({ declaration = DECLARATION } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-exec-'));
  git(dir, 'init', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, '.gitignore'), '.agentic-plugins/state/\n.agentic-plugins/runs/\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'scripts/check.mjs'), CHECK);
  writeFileSync(join(dir, 'tests/test-a.mjs'), '// a test\n');
  if (declaration !== null) {
    mkdirSync(join(dir, '.agentic-plugins'), { recursive: true });
    writeFileSync(join(dir, '.agentic-plugins/verify-checks.json'), declaration);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

export const S = await import(pathToFileURL(join(ENGINEER_ROOT, 'scripts/state.mjs')).href);
export const VD = await import(pathToFileURL(join(AP, 'verify-decl.mjs')).href);
export const VR = await import(pathToFileURL(join(AP, 'verify-run.mjs')).href);
export const VJ = await import(pathToFileURL(join(AP, 'verify-journal.mjs')).href);
// The tree digest the step takes (verify-ops.mjs's, without the selection).
const { treeDigest } = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/lane-digest.mjs')).href);
export const digestOf = async (lane) => treeDigest(lane).digest;

export const offerEnv = (sha, step = 3) => ({ AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_AUTOPILOT_STEP: String(step) });

/** An engineer workflow in `dir` whose compose step recorded `checks`; resolves its path. */
export async function workflowWithRequest(dir, sha, checks, { onPass = { kind: 'commit', confidence: 'HIGH' }, step = 3, verb = 'compose' } = {}) {
  const { filePath } = await S.createWorkflow({
    repoRoot: dir, verb, host: 'claude', gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' },
    originalRequest: 'verify exec', currentPhase: 'phase-0-bootstrap',
  });
  await request(filePath, dir, sha, checks, { onPass, step });
  return filePath;
}

/** The step `step` of the run records a request again (a verb that ended with verify). */
export async function request(wf, dir, sha, checks, { onPass = { kind: 'commit', confidence: 'HIGH' }, step = 3, confidence = 'HIGH' } = {}) {
  await S.finishVerb({
    workflowPath: wf, host: 'claude', nextAction: 'Verify the change', nextStep: { kind: 'verify', confidence },
    verifyRequest: { checks, on_pass: onPass, confidence }, env: offerEnv(sha, step), cwd: dir,
  });
}

/** A step's Phase 0 under the run: the verb resumes, its next step cleared. */
export async function resumeVerb(wf, { step, verb = 'compose' }) {
  await S.appendPhase({ workflowPath: wf, host: 'claude', verb, phaseLabel: 'Phase 0: Resume', phaseNote: 'resumed', currentPhase: 'phase-0-resume', clearNextStep: true, nextAction: 'Run it', event: 'resumed', env: { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: String(step) } });
}

export const readWorkflow = async (wf) => (await S.readWorkflow(wf)).frontmatter;

// A batch bound of 15 s is a backstop: a check whose own timeout never fires
// (a defect under test) ends the test, cause bound, rather than hanging it.
export const FAST = Object.freeze({ secondMs: 100, killGraceMs: 300, lingerMs: 500, pollMs: 25, batchMs: 15_000 });

/** The job of a verification step on `wf` in `dir`, with the run's directory under it. */
export function jobFor({ dir, sha, wf, seq = 4, log, envFile = null, extraEnv = {}, forcedRerun = false, verb = 'compose', runId = RUN }) {
  const decl = VD.readDeclarationAt(dir, sha).declaration;
  const runDir = join(dir, '.agentic-plugins/runs/autopilot', runId);
  mkdirSync(runDir, { recursive: true });
  const workflowId = /([^/]+)\.md$/.exec(wf)[1];
  const base = { ...process.env, VERIFY_FIXTURE_LOG: log, ...(envFile ? { VERIFY_FIXTURE_ENV: envFile } : {}), ...extraEnv };
  return {
    runId, seq, runDir, mainRoot: dir, workflowPath: wf, workflowId, lane: dir, engineerRoot: ENGINEER_ROOT,
    offer: { baseline: sha, declaration: decl }, base: sha, verb, forcedRerun,
    checkEnv: VR.checkEnvOf({ ...base, AGENTIC_AUTOPILOT: runId, AGENTIC_AUTOPILOT_TOKEN: 'secret', AGENTIC_AUTOPILOT_STEP: String(seq), AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_STATE_BASE: dir }),
    personaEnv: VR.personaEnvOf(base),
  };
}

/** No driver additions: the selection seam, the tree digest as it is. */
export const ops = (additions = []) => ({ treeDigest: digestOf, select: async () => ({ additions, tests: { files: [] } }) });

export const ran = (log) => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

export function cleanup(dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

/**
 * Run one step to its end with nothing stopping it; `register` records each
 * group. `abortWhen`: the driver's signal, once the predicate holds (polled).
 */
export async function runStep(job, { stopCause = () => null, bounds = FAST, additions = [], register = null, onWait = () => {}, abortWhen = null } = {}) {
  const groups = [];
  const v = VR.startVerify({
    job, ops: ops(additions), bounds, stopCause, onWait,
    register: register ?? (async (g) => { groups.push(g); return [{ release: () => { g.released = true; } }]; }),
  });
  let poll = null;
  if (abortWhen !== null) {
    poll = setInterval(() => {
      if (!abortWhen()) return;
      clearInterval(poll);
      v.abort('interrupted');
    }, 20);
  }
  try {
    const r = await v.done;
    return { ...r, groups };
  } finally {
    clearInterval(poll);
  }
}
