// plugins/designer plugin-shape conformance test (ADR-0042).
//
// Boundary history (this test EVOLVES with the implementation ladder,
// following the plugins/founder precedent — see test-founder-plugin.mjs):
//   - PR1 shipped the fully-INERT atomic scaffold: dual host manifests +
//     README + CHANGELOG + both marketplace catalog entries + release-please
//     wiring + package.json test-suite wiring. Every functional directory was
//     ABSENT, and the manifests + README carry the `incubating scaffold`
//     marker.
//   - PR2 (this revision) lands the copy-and-trim WORKFLOW-CONTINUITY
//     machinery (scripts/ + hooks/ + adapters/), exposing the Codex manifest
//     hooks key. Designer mirrors founder's NON-DISPATCH shape (ADR-0042
//     Non-Goal 2): it copies the six continuity scripts + the discover-runtime
//     self-sensor, but ships NO parent-writeback module and NO phase7-commit
//     driver, and the machinery never reads parent-linkage env nor invokes
//     writebackParent (founder test-founder-plugin.mjs:277 precedent). The
//     decide engine (decide-registry.mjs + scripts/lib/*) is deliberately
//     deferred to PR4 (founder ADR-0036 precedent), so this revision asserts
//     it ABSENT. The forbidden-dir list shrinks by scripts/hooks/adapters;
//     commands/ + skills/ stay forbidden until PR3+.
//   - PR3–PR6 land commands/ + skills/ (the six verb surfaces + start macro
//     + meta skills), the decide engine (PR4), and the Codex manifest
//     skills + interface keys.
//   - PR7 de-incubates: the incubating marker is removed from the manifests
//     + README, and these PRESENCE assertions flip to ABSENCE.
//
// Run via `node --test tests/plugin-shape/test-designer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/designer');

// ADR-0042 is Proposed; the persona is incubating until the PR7 dogfood
// flips it to Accepted. Until then the user-facing surfaces MUST carry
// this marker so the scaffold never reads as a shipped persona. At PR7
// these assertions flip from "must carry" to "must NOT carry" (founder
// precedent).
const INCUBATING_MARKER = /incubating scaffold/i;

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('plugins/designer — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON with required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'designer');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('carries the incubating marker (ADR-0042 Proposed — removed at PR7)', async () => {
    const json = await readJSON(path);
    ok(INCUBATING_MARKER.test(json.description),
      'Claude manifest description must carry the incubating marker until ADR-0042 is Accepted at PR7');
  });

  it('carries publishing metadata consistent with sibling plugins', async () => {
    const json = await readJSON(path);
    strictEqual(json.license, 'MIT');
    strictEqual(json.author?.name, 'each4all');
    strictEqual(typeof json.homepage, 'string');
    strictEqual(typeof json.repository, 'string');
    ok(Array.isArray(json.keywords) && json.keywords.length > 0);
  });
});

describe('plugins/designer — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON with required scalar fields matching the Claude manifest', async () => {
    const json = await readJSON(path);
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'designer');
    strictEqual(json.version, claude.version, 'host manifests must carry the same version');
    strictEqual(typeof json.description, 'string');
    ok(INCUBATING_MARKER.test(json.description),
      'Codex manifest description must carry the incubating marker until ADR-0042 is Accepted at PR7');
  });

  it('declares hooks but NOT yet skills / interface (PR2 machinery landed; verb surfaces land at PR3+)', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json',
      'PR2 machinery exposes the Codex manifest hooks path');
    ok(!('skills' in json), 'PR2 has no verb surfaces — the Codex manifest skills key lands at PR3');
    ok(!('interface' in json), 'PR2 has no verb surfaces — the Codex manifest interface block lands at PR3');
  });
});

describe('plugins/designer — PR2 machinery boundary (copy-trim continuity + hooks, non-dispatch)', () => {
  const REQUIRED_MACHINERY = [
    'scripts/state.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/discover-runtime.mjs',
    'hooks/hooks.json',
    'adapters/claude/hooks/_shared.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/hooks.json',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
    'adapters/codex/hooks/_shared.mjs',
    'adapters/codex/hooks/run-node-hook.sh',
    'adapters/codex/hooks/README.md',
  ];

  // Every machinery script the seven-file copy-trim lands, used by the
  // non-dispatch scans below so the guard cannot pass vacuously on a
  // hand-picked subset (Codex Plan-verify §Edge-cases).
  const ALL_SCRIPTS = [
    'scripts/state.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/discover-runtime.mjs',
  ];
  const ALL_HOOK_SCRIPTS = [
    'adapters/claude/hooks/_shared.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/_shared.mjs',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
  ];

  for (const rel of REQUIRED_MACHINERY) {
    it(`ships ${rel} (PR2 machinery copy-trim)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the PR2 machinery copy-trim and must exist`);
    });
  }

  it('hook entrypoints carry the executable bit', async () => {
    const HOOK_EXECUTABLES = [
      'adapters/claude/hooks/session-start.mjs',
      'adapters/claude/hooks/pre-compact.mjs',
      'adapters/claude/hooks/stop.mjs',
      'adapters/codex/hooks/session-start.mjs',
      'adapters/codex/hooks/pre-compact.mjs',
      'adapters/codex/hooks/stop.mjs',
      'adapters/codex/hooks/run-node-hook.sh',
    ];
    for (const rel of HOOK_EXECUTABLES) {
      const st = await stat(resolve(PLUGIN_ROOT, rel));
      ok(st.mode & 0o100, `${rel} must be executable (owner x bit)`);
    }
  });

  it('the seven machinery scripts carry the executable bit', async () => {
    for (const rel of ALL_SCRIPTS) {
      const st = await stat(resolve(PLUGIN_ROOT, rel));
      ok(st.mode & 0o100, `${rel} must be executable (owner x bit)`);
    }
  });

  it('the Claude hooks.json wires the three events with no cross-persona path leakage', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
    const s = JSON.stringify(manifest);
    ok(!s.includes('engineer'), 'no engineer path may leak into the designer Claude hooks.json');
    ok(!/founder/i.test(s), 'no founder path may leak into the designer Claude hooks.json (rebrand completeness)');
  });

  it('the Codex hooks.json wires the three events through run-node-hook.sh + ${PLUGIN_ROOT}, no cross-persona/host leakage', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/hooks.json'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
    // Every Codex hook command must resolve node via run-node-hook.sh under
    // ${PLUGIN_ROOT} (the portable-node pattern), and must NOT reference the
    // Claude adapter tree or ${CLAUDE_PLUGIN_ROOT} (ADR-0042 SD7 host split).
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      for (const entry of manifest.hooks[event]) {
        for (const h of entry.hooks) {
          ok(h.command.includes('adapters/codex/hooks/run-node-hook.sh'),
            `Codex ${event} hook must dispatch through run-node-hook.sh`);
          ok(h.command.includes('${PLUGIN_ROOT}'),
            `Codex ${event} hook must resolve paths under \${PLUGIN_ROOT}`);
          ok(!h.command.includes('CLAUDE_PLUGIN_ROOT'),
            `Codex ${event} hook must not reference \${CLAUDE_PLUGIN_ROOT}`);
          ok(!/adapters\/claude/.test(h.command),
            `Codex ${event} hook must not reference the Claude adapter tree`);
        }
      }
    }
    const s = JSON.stringify(manifest);
    ok(!s.includes('engineer'), 'no engineer path may leak into the designer Codex hooks.json');
    ok(!/founder/i.test(s), 'no founder path may leak into the designer Codex hooks.json (rebrand completeness)');
  });

  // ADR-0042 SD7 host-adapter split (topic: "NO Claude-adapter paths inside
  // Codex hooks"). The Codex hook SOURCE files must be self-contained: no
  // import/require reaches into the sibling Claude adapter tree.
  it('the Codex hook source files never import from the Claude adapter tree', async () => {
    const CODEX_HOOK_SOURCES = [
      'adapters/codex/hooks/_shared.mjs',
      'adapters/codex/hooks/session-start.mjs',
      'adapters/codex/hooks/pre-compact.mjs',
      'adapters/codex/hooks/stop.mjs',
    ];
    for (const rel of CODEX_HOOK_SOURCES) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/(?:import|require)\b[^\n]*adapters\/claude/.test(text),
        `${rel} must not import from adapters/claude (Codex adapter must be self-contained)`);
      ok(!/(?:import|from)\s+['"][^'"]*\/claude\/hooks\//.test(text),
        `${rel} must not reach into the Claude hooks tree`);
    }
  });

  // ADR-0042 Non-Goal 2 — designer is NOT an orchestrator dispatch target.
  // The continuity machinery must never ship or reference the parent-linkage
  // writeback path (founder test-founder-plugin.mjs:277 precedent). The guard
  // targets IMPORTS + INVOCATIONS, not prose: state.mjs legitimately DOCUMENTS
  // the trim (and defensively rejects --parent-workflow flags), so a bare
  // string mention of the removed fields must remain allowed.
  it('guards the non-dispatch contract: machinery never imports/invokes parent-writeback (ADR-0042 Non-Goal 2)', async () => {
    // Scan EVERY machinery + hook source, not a hand-picked subset, so the
    // guard cannot pass vacuously on future drift (Codex Plan-verify §Edge).
    for (const rel of [...ALL_SCRIPTS, ...ALL_HOOK_SCRIPTS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/(?:import|from|require)\b[^\n]*parent-writeback/.test(text),
        `${rel} must not import parent-writeback machinery (any relative path)`);
      ok(!/writebackParent\s*\(/.test(text),
        `${rel} must not invoke writebackParent`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/parent-writeback.mjs')), false,
      'plugins/designer must not ship a parent-writeback module at all (non-dispatch)');
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/phase7-commit.mjs')), false,
      'plugins/designer must not ship a phase7-commit driver (non-dispatch — no dispatch-linked auto-commit)');
  });

  it('the machinery performs no parent-linkage env read (shell or process.env — ADR-0042 Non-Goal 2)', async () => {
    const FORBIDDEN_READS = [
      /\$\{?AGENTIC_PARENT_WORKFLOW/,
      /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
      /process\.env\.AGENTIC_PARENT_WORKFLOW/,
      /process\.env\.AGENTIC_ORIGINATING_SUBTASK/,
    ];
    // Full machinery + hook scan (not a subset) — a bare prose mention of
    // the removed fields stays allowed (state.mjs documents/rejects the
    // flags); only a live shell/process.env READ is forbidden.
    for (const rel of [...ALL_SCRIPTS, ...ALL_HOOK_SCRIPTS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of FORBIDDEN_READS) {
        ok(!re.test(text),
          `${rel} must not read ${re} — designer is not an orchestrator dispatch target (ADR-0042 Non-Goal 2)`);
      }
    }
  });

  it('does NOT yet ship the decide engine (registry + lib land at PR4 — founder ADR-0036 precedent)', async () => {
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')), false,
      'the decide registry lands with decide+compose at PR4, not with PR2 machinery');
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/lib')), false,
      'the decide engine lib/ (decide-args/scores/weights/sensitivity/yaml-mini) lands at PR4');
  });
});

describe('plugins/designer — inert boundary (PR2: verb surfaces still absent)', () => {
  // scripts/hooks/adapters landed at PR2; commands/ + skills/ + the persona
  // dirs stay absent until PR3+ (per the boundary history at the top).
  const FORBIDDEN_DIRS = [
    'commands',
    'skills',
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  for (const dir of FORBIDDEN_DIRS) {
    it(`has no ${dir}/ directory (verb surface — lands in a later PR)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, dir)), false,
        `plugins/designer/${dir}/ must not exist until its landing PR`);
    });
  }

  it('ships README.md carrying the incubating marker AND the ADR-0042 pointer', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(INCUBATING_MARKER.test(readme),
      'plugin README must carry the incubating marker until ADR-0042 is Accepted at PR7');
    ok(/ADR-0042/.test(readme), 'plugin README must point at ADR-0042');
  });

  it('ships CHANGELOG.md with the initial scaffold seed entry', async () => {
    const changelog = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
    ok(/scaffold seed/i.test(changelog), 'CHANGELOG.md must carry the initial scaffold seed entry');
  });
});

describe('plugins/designer — marketplace catalog wiring (both hosts)', () => {
  it('the Claude catalog carries a designer entry resolving to the plugin dir at version 0.1.0', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .claude-plugin/marketplace.json');
    strictEqual(entry.source, './plugins/designer');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version,
      'Claude catalog entry version must match the manifest version');
  });

  it('the Codex catalog carries a designer entry resolving to the plugin dir', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .agents/plugins/marketplace.json');
    strictEqual(entry.source?.path, './plugins/designer');
  });
});

describe('plugins/designer — release-please + test-suite wiring', () => {
  it('release-please-config.json declares the plugins/designer package with both-manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages['plugins/designer'];
    ok(pkg, 'release-please-config.json must declare the plugins/designer package');
    strictEqual(pkg['package-name'], 'plugin-designer');
    const paths = (pkg['extra-files'] || []).map((f) => f.path);
    ok(paths.includes('.claude-plugin/plugin.json'), 'extra-files must bump the Claude manifest version');
    ok(paths.includes('.codex-plugin/plugin.json'), 'extra-files must bump the Codex manifest version');
  });

  it('.release-please-manifest.json seeds plugins/designer at 0.1.0', async () => {
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(manifest['plugins/designer'], '0.1.0');
  });

  it('package.json wires the designer shape test into test:plugin-shape', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    ok(/tests\/plugin-shape\/test-designer-plugin\.mjs/.test(pkg.scripts['test:plugin-shape']),
      'test:plugin-shape must run tests/plugin-shape/test-designer-plugin.mjs');
  });

  it('package.json wires the designer machinery unit suite into test:plugin-shape (PR2)', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    const suite = pkg.scripts['test:plugin-shape'];
    const REQUIRED_UNIT_TESTS = [
      'tests/designer/test-state.mjs',
      'tests/designer/test-dispatch-peer.mjs',
      'tests/designer/test-peer-runner.mjs',
      'tests/designer/test-session-handoff.mjs',
      'tests/designer/test-stop-archive.mjs',
      'tests/designer/test-hooks.mjs',
    ];
    for (const t of REQUIRED_UNIT_TESTS) {
      ok(suite.includes(t), `test:plugin-shape must run ${t} (PR2 machinery unit suite)`);
    }
  });
});
