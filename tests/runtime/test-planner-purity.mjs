import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
