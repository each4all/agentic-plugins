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
// §1.1 — the planner import-closure boundary
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(REPO_ROOT, 'plugins/runtime/scripts/lib');

// ADR-0057 deleted `permission-plan.mjs`, which was the ONLY module this closure
// guard was ever pointed at. The §1.1 rule it enforces — a planner must not reach
// doctor.mjs, the host-CLI probe, a subprocess, or a dynamic import — is about the
// planner LAYER, not about that one file, so the guard is RE-POINTED at the
// surviving planners rather than deleted with its first subject. Deleting it would
// have removed the repository's only instance of this check as a side effect of
// removing something else.
const CLOSURE_GUARDED_PLANNERS = ['notification-plan.mjs', 'egress-launcher-plan.mjs'];

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


describe('planner purity §1.1: planner import closure', () => {
  for (const planner of CLOSURE_GUARDED_PLANNERS) {
    it(`${planner} never reaches doctor.mjs, the host-CLI probe, or a subprocess`, async () => {
      // §1.1 forbids the bootstrap chain from inheriting doctor's reads: "the reads still
      // happen, and any future consumer of the filtered report re-inherits them".
      const closure = await localClosure(join(LIB, planner));
      // Non-vacuity: an empty closure would pass every assertion below without
      // reading a byte of the planner.
      ok(closure.size > 0, `${planner} closure is empty — the walker never read the entry`);
      for (const forbidden of ['doctor.mjs', 'machine-probe.mjs', 'settings.mjs', 'consensus.mjs']) {
        ok(
          ![...closure].some((f) => f.endsWith(`/${forbidden}`)),
          `${forbidden} must not be reachable from ${planner} — closure: ${[...closure].map((f) => f.replace(REPO_ROOT, '')).join(', ')}`,
        );
      }
      for (const path of closure) {
        const code = stripComments(await readFile(path, 'utf8'));
        ok(!/from\s+['"]node:child_process['"]/.test(code), `${path} must not import node:child_process`);
        ok(!/\bimport\s*\(/.test(code), `${path} must not use a dynamic import (it would route around this gate)`);
      }
    });
  }
});
