// tests/orchestrator/test-holds-capability.mjs
//
// ADR-0068 Decision 2, item 9 (impl-hold) — the rollout: this orchestrator's
// token (`state.mjs hold-capability`, `run.json` capabilities); the lanes
// capability floor needs the pinned engineer's hold-aware persona; holds turn
// on only once each host's engineer cache, probed strictly, and the launcher's
// pin are hold-aware, and a marker that cannot be read is never overwritten;
// a serial run refuses beside a hold that applies, naming its release, and
// beside a release awaiting its comparison, naming the relaunch with lanes,
// and beside a rejected release, naming a new hold and release.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const AP = join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const HR = await import(pathToFileURL(join(LIB, 'holds-records.mjs')).href);
const ACT = await import(pathToFileURL(join(LIB, 'hold-activation.mjs')).href);
const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
const ROOTS = await import(pathToFileURL(join(AP, 'roots.mjs')).href);
const DRV = await import(pathToFileURL(join(AP, 'driver.mjs')).href);

const MACRO = 'macro-plan-20261026T000000Z-ca0001';
const ENGINEER = join(REPO_ROOT, 'plugins/engineer');

async function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'holds-cap-')));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
// A fake engineer whose state.mjs prints the capability or not.
function fakeEngineer(dir, aware) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'state.mjs'), aware
    ? "if (process.argv[2] === 'hold-capability') { console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); } else process.exit(2);\n"
    : 'process.exit(2);\n');
  return dir;
}
function caches(home, { claude, codex }) {
  if (claude !== undefined) fakeEngineer(join(home, '.claude/plugins/cache/agentic-plugins/engineer', '0.33.0'), claude);
  if (codex !== undefined) fakeEngineer(join(home, '.codex/plugins/cache/agentic-plugins/engineer', '0.33.0'), codex);
}

describe('holds rollout: the tokens', () => {
  it('this orchestrator prints holds-1', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs'), 'hold-capability'], { encoding: 'utf8' });
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(JSON.parse(r.stdout), { capability: 'holds-1', protocol: 1 });
  });

  it('the lanes capability floor needs the pinned engineer\'s hold-aware persona', () => withDir((dir) => {
    const real = ROOTS.lanesCapabilityProblems({ engineer: ENGINEER }, REPO_ROOT);
    ok(!real.some((p) => /hold-aware persona/.test(p)), real.join('\n'));
    const old = join(dir, 'engineer');
    mkdirSync(join(old, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(old, 'scripts', 'state.mjs'), readFileSync(join(ENGINEER, 'scripts', 'state.mjs')));
    writeFileSync(join(old, 'scripts', 'lib', 'holds.mjs'), '// an older persona\n');
    ok(ROOTS.lanesCapabilityProblems({ engineer: old }, REPO_ROOT).some((p) => /hold-aware persona/.test(p)));
  }));

  it('a run with lanes records holds-1 in run.json and its lock entry; a serial run records none', () => {
    const src = readFileSync(join(AP, 'driver.mjs'), 'utf8');
    ok(/capabilities: lanes >= 2 \? \[HOLDS_CAPABILITY\] : \[\],/.test(src));
    ok(/token_digest: tokenDigest\(token\), capabilities: run\.capabilities, lanes \};/.test(src));
  });
});

describe('holds rollout: activation', () => {
  it('turns on only once both hosts\' caches and the pin are hold-aware, naming what to install or move', () => withDir((dir) => {
    const home = join(dir, 'home');
    const main = join(dir, 'main');
    mkdirSync(main, { recursive: true });
    const env = { HOME: home, PATH: process.env.PATH };
    let a = ACT.activateHolds({ mainRoot: main, macroId: MACRO, pinnedEngineerRoot: ENGINEER, env, home, writtenBy: 't' });
    strictEqual(a.ok, false);
    ok(a.problems.some((p) => /^Claude Code: no engineer is installed/.test(p)), a.problems.join('\n'));
    ok(a.problems.some((p) => /^Codex CLI: no engineer is installed/.test(p)));
    caches(home, { claude: true, codex: false });
    a = ACT.activateHolds({ mainRoot: main, macroId: MACRO, pinnedEngineerRoot: ENGINEER, env, home, writtenBy: 't' });
    deepStrictEqual(a.problems.length, 1);
    ok(/^Codex CLI: .* is not hold-aware/.test(a.problems[0]), a.problems[0]);
    caches(home, { codex: true });
    a = ACT.activateHolds({ mainRoot: main, macroId: MACRO, pinnedEngineerRoot: fakeEngineer(join(dir, 'pin'), false), env, home, writtenBy: 't' });
    ok(a.problems.length === 1 && /pinned engineer.*AGENTIC_ENGINEER_ROOT/.test(a.problems[0]), a.problems.join('\n'));
    strictEqual(HR.readActivation(main, MACRO).state, 'inactive', 'nothing written while any refuses');
    a = ACT.activateHolds({ mainRoot: main, macroId: MACRO, pinnedEngineerRoot: ENGINEER, env, home, writtenBy: 't' });
    deepStrictEqual(a, { ok: true, written: true });
    strictEqual(HR.readActivation(main, MACRO).state, 'active');
  }));

  it('probes each host strictly: an environment override or the other host\'s cache does not stand in', () => withDir((dir) => {
    const home = join(dir, 'home');
    caches(home, { claude: true });
    const env = { HOME: home, PATH: process.env.PATH, AGENTIC_ENGINEER_ROOT: ENGINEER, CODEX_HOME: join(dir, 'empty-codex') };
    const p = ACT.holdActivationProblems({ pinnedEngineerRoot: ENGINEER, env, home });
    deepStrictEqual(p.map((x) => x.split(':')[0]), ['Codex CLI']);
  }));

  it('a marker that cannot be read is never overwritten', () => withDir((dir) => {
    const main = join(dir, 'main');
    mkdirSync(join(HR.holdsDir(main, MACRO)), { recursive: true });
    writeFileSync(HR.protocolPath(main, MACRO), '{broken');
    const a = ACT.activateHolds({ mainRoot: main, macroId: MACRO, pinnedEngineerRoot: ENGINEER, env: process.env, writtenBy: 't' });
    strictEqual(a.ok, false);
    strictEqual(readFileSync(HR.protocolPath(main, MACRO), 'utf8'), '{broken');
  }));
});

describe('holds rollout: a serial run refuses beside a hold', () => {
  it('names each hold that applies, with its release, and passes a released one', () => withDir(async (dir) => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env: { ...process.env, GIT_DIR: undefined } });
    const view = { macro: { fm: { plan: { subtasks: [{ id: 'S', status: 'in_progress' }] } } } };
    deepStrictEqual(DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env }), []);
    const h = await OPS.setHold({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', branch: 'feat/s' });
    const p = DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env });
    strictEqual(p.length, 1);
    ok(p[0].includes(`S: pending (hold ${h.hold_id})`) && p[0].includes(`agentic-autopilot release S --macro ${MACRO} --hold ${h.hold_id}`), p[0]);
    await OPS.releaseHold({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', holdId: h.hold_id, stateRoots: [repo], basisOf: async () => null });
    deepStrictEqual(DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env }), [], 'a withdrawn hold applies no more');
    writeFileSync(HR.recordPath(repo, MACRO, 'holds', 'S'), '{');
    ok(/S: unreadable.*--discard-unreadable/.test(DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env })[0]));
  }));

  it('refuses beside a release awaiting its comparison, which only a run with lanes makes, naming the relaunch', () => withDir(async (dir) => {
    const repo = join(dir, 'repo');
    const lane = join(dir, 'lane');
    mkdirSync(repo);
    mkdirSync(lane);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env: { ...process.env, GIT_DIR: undefined } });
    const view = { macro: { fm: { plan: { subtasks: [{ id: 'S', status: 'in_progress' }] } } } };
    const h = await OPS.setHold({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', branch: 'feat/s', lane });
    strictEqual((await OPS.completeHandoff({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', stateRoots: [repo] })).state, 'held');
    const basis = { fingerprint_version: 3, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null };
    const rel = await OPS.releaseHold({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', holdId: h.hold_id, stateRoots: [repo], basisOf: async () => basis, keptParkId: () => null });
    strictEqual(rel.state, 'released-uncompared');
    const p = DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env });
    strictEqual(p.length, 1, p.join('\n'));
    ok(p[0].includes(`S: released-uncompared (hold ${h.hold_id})`) && /a serial run does not compare releases\. Run with lanes/.test(p[0]) && p[0].includes('--lanes'), p[0]);
    // Compared equal, its park not ended yet: still the lanes run's to finish.
    const file = HR.recordPath(repo, MACRO, 'releases', 'S');
    const r = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify({ ...r, state: 'consumed', compared_at: new Date().toISOString() })}\n`);
    ok(/S: consumed \(hold /.test(DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env })[0] ?? ''), 'a consumption whose park has not ended');
    writeFileSync(file, `${JSON.stringify({ ...r, state: 'consumed', compared_at: new Date().toISOString(), park_ended: true })}\n`);
    deepStrictEqual(DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env }), [], 'a finished consumption applies no more');
  }));

  it('refuses beside a rejected release that keeps no park, naming a new hold and release', () => withDir(async (dir) => {
    const repo = join(dir, 'repo');
    const lane = join(dir, 'lane');
    mkdirSync(repo);
    mkdirSync(lane);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env: { ...process.env, GIT_DIR: undefined } });
    const view = { macro: { fm: { plan: { subtasks: [{ id: 'S', status: 'in_progress' }] } } } };
    const h = await OPS.setHold({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', branch: 'feat/s', lane });
    strictEqual((await OPS.completeHandoff({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', stateRoots: [repo] })).state, 'held');
    const basis = { fingerprint_version: 3, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null };
    await OPS.releaseHold({ mainRoot: repo, macroId: MACRO, subtaskId: 'S', holdId: h.hold_id, stateRoots: [repo], basisOf: async () => basis, keptParkId: () => null });
    // Rejected, its park never written (a crash between the two): no kept
    // park stands in for the release's own refusal.
    const file = HR.recordPath(repo, MACRO, 'releases', 'S');
    const r = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify({ ...r, state: 'rejected', compared_at: new Date().toISOString() })}\n`);
    strictEqual(OPS.holdGate({ mainRoot: repo, macroId: MACRO, subtaskId: 'S' }) !== null, true, 'the driver\'s gate refuses the lane');
    const p = DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view, env: process.env });
    strictEqual(p.length, 1, p.join('\n'));
    ok(p[0].includes(`S: rejected (hold ${h.hold_id})`) && /a serial run does not step it\. Hold it and release it again/.test(p[0])
      && p[0].includes(`agentic-autopilot hold S --macro ${MACRO}`), p[0]);
    // Its subtask gone from the plan, or completed: no new hold could be set
    // on it, so it holds back no serial run (as a kept park of it does not).
    for (const subtasks of [[{ id: 'T', status: 'pending' }], [{ id: 'S', status: 'completed' }]]) {
      deepStrictEqual(DRV.serialRefusal({ repoRoot: repo, macroId: MACRO, view: { macro: { fm: { plan: { subtasks } } } }, env: process.env }), [], JSON.stringify(subtasks));
    }
  }));
});
