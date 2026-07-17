import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gatherCodexNotificationInputs,
  buildCodexNotificationPlanSection,
} from '../../plugins/runtime/scripts/lib/notification-plan.mjs';
import {
  gatherEgressLauncherInputs,
  buildEgressLauncherPlanSection,
} from '../../plugins/runtime/scripts/lib/egress-launcher-plan.mjs';
import {
  gatherPermissionPlanInputs,
  buildPermissionPlanSection,
} from '../../plugins/runtime/scripts/lib/permission-plan.mjs';

// machine-bootstrap-contract.md §1.3 — the planners are split into gather (I/O) /
// deterministic build (injected clock+run-id+templates, no I/O) / persist. These
// tests pin the build layer: it is SYNCHRONOUS (a Promise would betray hidden I/O),
// it never persists (no repoRoot in its signature — it cannot write a consumer-repo
// artifact), and identical gathered facts + injected clock/run-id → identical output.

const NOW = new Date('2026-07-16T12:00:00.000Z');

describe('planner purity §1.3: notification build layer', () => {
  it('is synchronous, deterministic, and honors the injected run-id (no persist)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'planner-purity-notif-'));
    const gathered = await gatherCodexNotificationInputs({ homeDir: home, env: {} });

    // Synchronous return (not a Promise) → the build layer does no async I/O.
    const built = buildCodexNotificationPlanSection({ gathered, now: NOW, runId: 'notification-20260716T120000Z-abc123' });
    ok(built && typeof built.then !== 'function', 'build layer returns synchronously');
    strictEqual(built.artifactBody.run_id, 'notification-20260716T120000Z-abc123', 'injected run-id flows into the artifact');
    strictEqual(built.artifactBody.created_at, NOW.toISOString(), 'injected clock flows into created_at');

    // Determinism: same gathered + same clock + same run-id → byte-identical output.
    const again = buildCodexNotificationPlanSection({ gathered, now: NOW, runId: 'notification-20260716T120000Z-abc123' });
    deepStrictEqual(again.artifactBody, built.artifactBody);
    deepStrictEqual(again.section, built.section);

    // The build layer wrote nothing under home (no persist happened).
    const entries = await readdir(home);
    ok(!entries.includes('.agentic-plugins'), 'build layer never created a repo-relative artifact tree');
  });

  it('renders from injected templates (no plugin-receivers disk read in the build layer)', async () => {
    // Hand-built gathered with sentinel templates carrying the real placeholders:
    // the build layer must substitute into the INJECTED text, proving it never
    // reads the plugin-shipped receiver files itself.
    const gathered = {
      read: { ok: false, reason: 'ENOENT' },
      codexHomeSource: 'default ~/.codex',
      templates: {
        shuttle: "SENTINEL-SHUTTLE '__AGENTIC_MIN_RUNTIME_VERSION__' END",
        chain: 'unused',
      },
      installPaths: { shuttle: '/home/op/.agentic-plugins/bin/shuttle.mjs', chain: '/home/op/.agentic-plugins/bin/chain.mjs' },
    };
    const built = buildCodexNotificationPlanSection({ gathered, now: NOW, runId: 'notification-20260716T120000Z-abc123', runtimeVersion: '9.9.9' });
    ok(built.artifactBody.scripts.shuttle.content.startsWith('SENTINEL-SHUTTLE'), 'rendered from the injected template');
    ok(built.artifactBody.scripts.shuttle.content.includes('"9.9.9"'), 'substituted the injected runtime version');
  });
});

describe('planner purity §1.3: egress-launcher build layer', () => {
  it('is synchronous, deterministic, and honors the injected run-id (no persist)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'planner-purity-egress-'));
    const repo = await mkdtemp(join(tmpdir(), 'planner-purity-egress-repo-'));
    const gathered = await gatherEgressLauncherInputs({ repoRoot: repo, homeDir: home, env: {} });

    const built = buildEgressLauncherPlanSection({ gathered, host: 'claude', now: NOW, runId: 'egress-launcher-20260716T120000Z-abc123' });
    ok(built && typeof built.then !== 'function', 'build layer returns synchronously');
    strictEqual(built.artifactBody.run_id, 'egress-launcher-20260716T120000Z-abc123');
    strictEqual(built.artifactBody.created_at, NOW.toISOString());

    const again = buildEgressLauncherPlanSection({ gathered, host: 'claude', now: NOW, runId: 'egress-launcher-20260716T120000Z-abc123' });
    deepStrictEqual(again.artifactBody, built.artifactBody);
    deepStrictEqual(again.section, built.section);

    const entries = await readdir(home);
    ok(!entries.includes('.agentic-plugins'), 'build layer never created a repo-relative artifact tree');
  });
});

// ---------------------------------------------------------------------------
// §1.3 row 3 — the permission planner
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(REPO_ROOT, 'plugins/runtime/scripts/lib');
const PERMISSION_PLAN = join(LIB, 'permission-plan.mjs');
const RUN_ID = 'permission-20260716T120000Z-abc123';

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Semicolon-agnostic (the test-consensus-probe-boundary.mjs precedent — Codex found a
// semicolonless import slipping past the first version of that gate).
function parseImports(code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) out.push(m[2]);
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

async function localClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const code = stripComments(await readFile(path, 'utf8'));
    for (const spec of parseImports(code)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}

async function seedPermissionInputs({ home, repo, codexApproval = false }) {
  await mkdir(join(home, '.claude', 'projects', 'p'), { recursive: true });
  await mkdir(join(repo, '.claude'), { recursive: true });
  const rollouts = join(home, '.codex', 'sessions', '2026');
  await mkdir(rollouts, { recursive: true });
  if (codexApproval) {
    // A REAL approval event, parsed by the real learner: without it `approvalSeen` is
    // undefined and every project-trust assertion below passes vacuously — green
    // because the branch is never reached, not because the guard works.
    await writeFile(
      join(rollouts, 'rollout-trust.jsonl'),
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'c1', command: ['bash', '-lc', 'docker ps'] } })}\n`,
    );
  }
}

describe('planner purity §1.3: permission build layer', () => {
  it('is synchronous, deterministic, and honors the injected run-id + clock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'planner-purity-perm-'));
    const repo = await mkdtemp(join(tmpdir(), 'planner-purity-perm-repo-'));
    await seedPermissionInputs({ home, repo });
    const gathered = await gatherPermissionPlanInputs({
      repoRoot: repo, homeDir: home, env: {}, maxFiles: 10, maxFileBytes: 4096,
    });

    // Synchronous return (not a Promise) → the build layer does no async I/O.
    const built = buildPermissionPlanSection({ gathered, now: NOW, runId: RUN_ID });
    ok(built && typeof built.then !== 'function', 'build layer returns synchronously');
    strictEqual(built.artifact.run_id, RUN_ID, 'injected run-id flows into the artifact');
    strictEqual(built.artifact.created_at, NOW.toISOString(), 'injected clock flows into created_at');

    // Determinism: same gathered + same clock + same run-id → identical output.
    const again = buildPermissionPlanSection({ gathered, now: NOW, runId: RUN_ID });
    deepStrictEqual(again.artifact, built.artifact);
    deepStrictEqual(again.claude, built.claude);
    deepStrictEqual(again.codex, built.codex);

    // The build layer wrote nothing (no persist happened).
    for (const dir of [home, repo]) {
      const entries = await readdir(dir);
      ok(!entries.includes('.agentic-plugins'), `build layer never created an artifact tree under ${dir}`);
    }
  });

  it('takes no repoRoot — the builder holds no repository capability at all', () => {
    // The structural half of §1.3: a builder that ACCEPTS a repo root is one that can
    // grow a repo-relative read later. Assert the parameter is absent from the
    // destructured signature rather than merely unused. Slice the WHOLE parameter list
    // (to the paren that closes the one opening it) — stopping at the first `{` would
    // stop at the destructuring brace and read no parameter names at all.
    const src = buildPermissionPlanSection.toString();
    const open = src.indexOf('(');
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    const signature = src.slice(open, close + 1);
    ok(/gathered/.test(signature), `sanity: the slice must actually contain the parameter list, got: ${signature}`);
    ok(!/repoRoot/.test(signature), `build layer signature must not name repoRoot: ${signature}`);
  });

  it('recommends no project trust when the caller has no project context', async () => {
    // Bootstrap composes this planner machine-globally (§1.1). `applicable: false` must
    // produce NO [projects] entry — never a [projects."null"] header from a stringified
    // null path.
    const home = await mkdtemp(join(tmpdir(), 'planner-purity-perm-noproj-'));
    const repo = await mkdtemp(join(tmpdir(), 'planner-purity-perm-noproj-repo-'));
    await seedPermissionInputs({ home, repo, codexApproval: true });

    // Control: WITH project context the recommendation fires — proving the assertions
    // below are refusing a reachable branch rather than sitting on an unreachable one.
    const withProject = await gatherPermissionPlanInputs({
      repoRoot: repo, homeDir: home, env: {}, maxFiles: 10, maxFileBytes: 4096,
    });
    const control = buildPermissionPlanSection({ gathered: withProject, now: NOW, runId: RUN_ID });
    ok(control.codex.recommended.project_trust !== null, 'control: a project context DOES yield a trust recommendation');
    ok(/\[projects\./.test(control.codex.fragment_text), 'control: the [projects] header IS rendered');

    const gathered = await gatherPermissionPlanInputs({
      repoRoot: repo, homeDir: home, env: {}, maxFiles: 10, maxFileBytes: 4096,
      projectTrust: { applicable: false, path: null },
    });
    const built = buildPermissionPlanSection({ gathered, now: NOW, runId: RUN_ID });
    strictEqual(built.codex.recommended.project_trust, null, 'no project trust without project context');
    ok(!/\[projects\./.test(built.codex.fragment_text ?? ''), 'no [projects] header is rendered');
    ok(!/null/.test(built.codex.fragment_text ?? ''), 'a null path never reaches the fragment text');
    // The posture recommendations still fire — dropping project trust must not silently
    // drop the rest of the Codex plan.
    ok(built.codex.recommended.approval_policy !== null, 'the approval-policy posture is still recommended');
  });

  it('renders the dual blocked plan when the record scan fails, and persists nothing', () => {
    // Only the scan degrades to `blocked` — and on that path there is no artifact to
    // write, so the sections carry their own written:false marker.
    const built = buildPermissionPlanSection({
      gathered: { scanError: 'EACCES', maxFiles: 10, projectTrust: { applicable: true, path: '/repo' } },
      now: NOW,
      runId: RUN_ID,
    });
    strictEqual(built.artifact, null, 'nothing to persist on the blocked path');
    for (const host of ['claude', 'codex']) {
      strictEqual(built[host].status, 'blocked');
      strictEqual(built[host].error, 'EACCES');
      strictEqual(built[host].artifact.written, false);
    }
  });
});

describe('planner purity §1.3: permission planner import closure', () => {
  it('never reaches doctor.mjs, the host-CLI probe, or a subprocess', async () => {
    // §1.1 forbids the bootstrap chain from inheriting doctor's reads: "the reads still
    // happen, and any future consumer of the filtered report re-inherits them".
    const closure = await localClosure(PERMISSION_PLAN);
    for (const forbidden of ['doctor.mjs', 'machine-probe.mjs', 'settings.mjs', 'consensus.mjs']) {
      ok(
        ![...closure].some((p) => p.endsWith(`/${forbidden}`)),
        `${forbidden} must not be reachable from permission-plan.mjs — closure: ${[...closure].map((p) => p.replace(REPO_ROOT, '')).join(', ')}`,
      );
    }
    for (const path of closure) {
      const code = stripComments(await readFile(path, 'utf8'));
      ok(!/from\s+['"]node:child_process['"]/.test(code), `${path} must not import node:child_process`);
      ok(!/\bimport\s*\(/.test(code), `${path} must not use a dynamic import (it would route around this gate)`);
    }
  });
});
