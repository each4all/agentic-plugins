// plugins/founder plugin-shape conformance test (ADR-0036 — revised at
// PR4, the decide + compose verb-surface + decision-registry landing).
//
// Boundary history:
//   - PR1 shipped the fully-inert scaffold (manifests + README + CHANGELOG
//     + wiring only, every functional directory absent).
//   - PR2 landed scripts/ + hooks/ + adapters/ (REQUIRED below) with the
//     Codex manifest hooks key exposed; commands/ and skills/ stayed forbidden.
//   - PR3 landed the first two verb surfaces — investigate (business-brief
//     profile) and frame — so commands/ and skills/ became REQUIRED (with
//     investigate/frame entries) rather than forbidden, and the Codex
//     manifest gained the skills + interface keys.
//   - PR4 (this revision) lands the decide + compose verb surfaces and the
//     persona-local decision registry (scripts/decide-registry.mjs +
//     scripts/lib/* + skills/decide/references/decision-axes.yml, ADR-0036
//     SD3 / ADR-0027 portable schema, copied per ADR-0029). commands/ +
//     skills/ now REQUIRE decide/compose entries too. The next surface PR
//     (ADR-0036 PR5: critique + refine + the ensemble-protocol templates)
//     MUST revise this suite again.
//
// Run via `node --test tests/plugin-shape/test-founder-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/founder');

const INCUBATING_MARKER = /incubating scaffold/i;

// The PR3 privacy-gate textual sentinel (ADR-0036 SD4). The gate must be
// stated in the spec AND in the investigate prompt-guard surfaces; this
// load-bearing invariant phrase guards against silent removal. Checked
// whitespace-normalized so markdown line-wrapping does not break the match.
const PRIVACY_SENTINEL =
  'pass an explicit gate before BOTH web search AND peer-host dispatch';

// founder is the first persona with NO omcc ancestor (ADR-0036 Context):
// these stale tokens must never appear in its verb-surface files.
const STALE_TOKENS = [
  /\bomcc\b/i,
  /\[Claude\]/,
  /\[Codex\]/,
  /CODEX_HOME/,
  /CLAUDE-ONLY/,
  /CODEX-ONLY/,
];

const VERB_SKILLS = ['investigate', 'frame', 'decide', 'compose'];

// PR4 decision-registry copy (ADR-0036 SD3 / ADR-0027 portable schema,
// copied not imported per ADR-0029). These files must ship for the
// founder:decide axis resolution + founder:compose multi-axis lens.
const REQUIRED_RESOLVER = [
  'scripts/decide-registry.mjs',
  'scripts/lib/yaml-mini.mjs',
  'scripts/lib/decide-args.mjs',
  'scripts/lib/decide-scores.mjs',
  'scripts/lib/decide-weights.mjs',
  'scripts/lib/decide-sensitivity.mjs',
  'skills/decide/references/decision-axes.yml',
];

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

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

describe('plugins/founder — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON with required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'founder');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('still carries the incubating marker in its description (held until ADR-0036 PR7)', async () => {
    const json = await readJSON(path);
    ok(INCUBATING_MARKER.test(json.description),
      'Claude manifest description must keep the incubating marker until the ADR-0036 PR7 flip');
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

describe('plugins/founder — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON with required scalar fields matching the Claude manifest', async () => {
    const json = await readJSON(path);
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'founder');
    strictEqual(json.version, claude.version, 'host manifests must carry the same version');
    strictEqual(typeof json.description, 'string');
    ok(INCUBATING_MARKER.test(json.description),
      'Codex manifest description must keep the incubating marker until the ADR-0036 PR7 flip');
  });

  it('declares hooks AND the skills/interface keys (PR3 boundary — verb surfaces landed)', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json',
      'PR2 machinery hooks remain exposed in the Codex manifest');
    strictEqual(json.skills, './skills/',
      'PR3 lands the first SKILL.md surfaces — the Codex manifest must expose the skills path');
    ok(json.interface && typeof json.interface === 'object',
      'PR3 lands a verb surface — the Codex manifest must carry an interface block');
    strictEqual(json.interface.displayName, 'Founder');
    strictEqual(json.interface.category, 'Productivity');
    ok(Array.isArray(json.interface.defaultPrompt) && json.interface.defaultPrompt.length > 0);
  });
});

// Negative-boundary suite — REVISED FOR PR4 (decide + compose verb surfaces
// and the decision registry landed: commands/ + skills/ now REQUIRED with
// investigate/frame/decide/compose entries + scripts/decide-registry.mjs +
// scripts/lib/* + skills/decide/references/decision-axes.yml; the PR2
// machinery remains REQUIRED). The next surface PR (PR5: critique + refine)
// MUST revise this suite again.
describe('plugins/founder — PR4 boundary (machinery + investigate/frame/decide/compose surfaces + decision registry)', () => {
  const ABSENT_DIRS = [
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  for (const dir of ABSENT_DIRS) {
    it(`has no ${dir}/ directory (not part of the founder surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, dir)), false,
        `plugins/founder/${dir}/ must not exist — founder uses commands/ + skills/ only`);
    });
  }

  const REQUIRED_MACHINERY = [
    'scripts/state.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'hooks/hooks.json',
    'adapters/claude/hooks/_shared.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/hooks.json',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
    'adapters/codex/hooks/run-node-hook.sh',
  ];

  for (const rel of REQUIRED_MACHINERY) {
    it(`ships ${rel} (PR2 machinery)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is part of the PR2 machinery copy-trim and must exist`);
    });
  }

  // PR3 + PR4 verb surfaces — commands + skills now REQUIRED.
  const REQUIRED_SURFACES = [
    'commands/investigate.md',
    'commands/frame.md',
    'skills/investigate/SKILL.md',
    'skills/investigate/agents/openai.yaml',
    'skills/investigate/references/business-brief-spec.md',
    'skills/investigate/references/business-brief-ensemble.md',
    'skills/investigate/references/output-file-rules.md',
    'skills/frame/SKILL.md',
    'skills/frame/agents/openai.yaml',
    'skills/_shared/references/orchestration.md',
    // PR4 decide + compose surfaces
    'commands/decide.md',
    'commands/compose.md',
    'skills/decide/SKILL.md',
    'skills/decide/agents/openai.yaml',
    'skills/compose/SKILL.md',
    'skills/compose/agents/openai.yaml',
  ];

  for (const rel of REQUIRED_SURFACES) {
    it(`ships ${rel} (PR3/PR4 verb surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is part of the ADR-0036 verb surface and must exist`);
    });
  }

  // PR4 decision-registry copy (decide/compose + resolver files exist).
  for (const rel of REQUIRED_RESOLVER) {
    it(`ships ${rel} (PR4 decision registry, copied per ADR-0029)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is part of the ADR-0036 PR4 decision registry and must exist`);
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

  it('guards the no-parent-linkage contract: machinery never references parent-writeback (ADR-0036 Non-Goal 3)', async () => {
    const SOURCES = [
      'scripts/state.mjs',
      'scripts/stop-archive.mjs',
      'adapters/claude/hooks/_shared.mjs',
      'adapters/claude/hooks/stop.mjs',
      'adapters/codex/hooks/stop.mjs',
    ];
    for (const rel of SOURCES) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!text.includes("from './parent-writeback.mjs'"),
        `${rel} must not import parent-writeback machinery`);
      ok(!/writebackParent\s*\(/.test(text),
        `${rel} must not invoke writebackParent`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/parent-writeback.mjs')), false,
      'plugins/founder must not ship a parent-writeback module at all');
  });

  it('the verb commands carry no parent-linkage env reads (ADR-0036 Non-Goal 3)', async () => {
    // Guard against actual shell reads ($VAR / ${VAR}), not prose mentions:
    // the commands legitimately *document* that they do NOT read these vars
    // (backtick-quoted plain names), which must remain allowed.
    const READ_FORMS = [
      /\$\{?AGENTIC_PARENT_WORKFLOW/,
      /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
    ];
    for (const verb of VERB_SKILLS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      for (const form of READ_FORMS) {
        ok(!form.test(text),
          `commands/${verb}.md must not shell-read ${form} — founder is not an orchestrator dispatch target (ADR-0036 Non-Goal 3)`);
      }
    }
  });

  it('ships README.md with the incubating marker and the ADR-0036 pointer', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(INCUBATING_MARKER.test(readme), 'plugin README must call out incubating status');
    ok(readme.includes('ADR-0036'), 'plugin README must point at ADR-0036');
  });

  it('ships CHANGELOG.md with the initial scaffold seed entry', async () => {
    const changelog = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
    ok(changelog.includes('0.1.0 (initial scaffold seed)'),
      'CHANGELOG must record the seed entry without implying a published tag');
  });
});

describe('plugins/founder — verb surface shape (PR3/PR4)', () => {
  for (const verb of VERB_SKILLS) {
    it(`skills/${verb}/SKILL.md frontmatter name = ${verb} (folder ↔ frontmatter consistency)`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `skills/${verb}/SKILL.md has no YAML frontmatter`);
      const re = new RegExp(`^name:\\s*${verb}\\s*$`, 'm');
      ok(re.test(fm), `skills/${verb}/SKILL.md frontmatter name != "${verb}"`);
      match(fm, /description:/, `skills/${verb}/SKILL.md frontmatter must carry a description`);
    });

    it(`skills/${verb}/agents/openai.yaml display_name names the verb`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `skills/${verb}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(verb),
        `openai.yaml display_name "${m[1]}" must name the verb "${verb}"`);
      ok(m[1].toLowerCase().includes('founder'),
        `openai.yaml display_name "${m[1]}" must name the persona "founder"`);
    });

    it(`commands/${verb}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${verb}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, `commands/${verb}.md frontmatter must carry a non-empty description`);
    });
  }

  it('no stale tokens (omcc / [Claude] / [Codex] / CODEX_HOME / *-ONLY) anywhere in the plugin — founder has no omcc ancestor', async () => {
    // Codex Plan-verify (PR3) caught a vestigial omcc-dev comment in
    // scripts/stop-archive.mjs that the verb-surface-only scan missed.
    // Scan the WHOLE plugin tree so copy-trim leaks in machinery /
    // adapters / hooks are caught too (ADR-0036 Context: no omcc ancestor).
    const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.sh']);
    const entries = await readdir(PLUGIN_ROOT, { recursive: true, withFileTypes: true });
    let scanned = 0;
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const dot = ent.name.lastIndexOf('.');
      if (dot < 0 || !TEXT_EXT.has(ent.name.slice(dot))) continue;
      const parent = ent.parentPath ?? ent.path;
      const full = resolve(parent, ent.name);
      const rel = full.slice(PLUGIN_ROOT.length + 1);
      const text = await readFile(full, 'utf8');
      for (const token of STALE_TOKENS) {
        ok(!token.test(text), `${rel} contains stale token ${token}`);
      }
      scanned += 1;
    }
    ok(scanned >= 20, `expected to scan the founder plugin tree, only saw ${scanned} files`);
  });
});

describe('plugins/founder — business-brief spec contract (PR3 / ADR-0036 SD4)', () => {
  const SPEC = 'skills/investigate/references/business-brief-spec.md';

  it('declares the 5-tier business source taxonomy', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    for (const tier of [
      'official-stats',
      'research-institutional',
      'market-intelligence',
      'primary-field',
      'secondary-press',
    ]) {
      ok(text.includes(tier), `business-brief-spec.md must define the "${tier}" tier`);
    }
  });

  it('states the freshness/jurisdiction and paywalled/vendor-claim rules', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    match(text, /jurisdiction/i, 'spec must state jurisdiction tagging rules');
    match(text, /as-of/i, 'spec must state as-of freshness dating rules');
    match(text, /vendor-claim/i, 'spec must state vendor-claim citation treatment');
    match(text, /paywalled/i, 'spec must state paywalled-source citation treatment');
  });

  it('the privacy gate sentinel appears in the spec AND the investigate prompt-guard surfaces (ADR-0036 SD4)', async () => {
    // The macro plan requires the gate stated in the spec AND the
    // investigate prompt guard (command + skill). Checked
    // whitespace-normalized so line-wrapping does not break the match.
    const REQUIRED = [
      'skills/investigate/references/business-brief-spec.md',
      'commands/investigate.md',
      'skills/investigate/SKILL.md',
    ];
    for (const rel of REQUIRED) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
    }
  });

  it('the privacy gate sentinel also reaches the ensemble dispatch + frame surfaces', async () => {
    const ALSO = [
      'skills/investigate/references/business-brief-ensemble.md',
      'commands/frame.md',
      'skills/frame/SKILL.md',
    ];
    for (const rel of ALSO) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} should carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
    }
  });
});

describe('plugins/founder — Claude marketplace catalog entry', () => {
  const path = resolve(REPO_ROOT, '.claude-plugin/marketplace.json');

  it('exists with source/version/category/description aligned to the plugin', async () => {
    const catalog = await readJSON(path);
    const entry = catalog.plugins.find((p) => p.name === 'founder');
    ok(entry, 'Claude catalog must list founder');
    strictEqual(entry.source, './plugins/founder',
      'validate-marketplace does not check the Claude source path — this test covers that gap');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version);
    strictEqual(entry.category, 'Productivity');
    ok(INCUBATING_MARKER.test(entry.description),
      'Claude catalog description must keep the incubating marker until the ADR-0036 PR7 flip');
  });
});

describe('plugins/founder — Codex marketplace catalog entry', () => {
  const path = resolve(REPO_ROOT, '.agents/plugins/marketplace.json');

  it('exists with the local-source/policy/category shape (no per-entry description in the Codex schema)', async () => {
    const catalog = await readJSON(path);
    const entry = catalog.plugins.find((p) => p.name === 'founder');
    ok(entry, 'Codex catalog must list founder');
    deepStrictEqual(entry.source, { source: 'local', path: './plugins/founder' });
    deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
    strictEqual(entry.category, 'Productivity');
    strictEqual(await exists(resolve(REPO_ROOT, entry.source.path)), true,
      'Codex source.path must resolve to the plugin directory');
  });
});

describe('plugins/founder — release-please wiring', () => {
  it('is tracked in .release-please-manifest.json at the manifest version', async () => {
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    const plugin = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(manifest['plugins/founder'], plugin.version);
  });

  it('has a plugin-founder package block with both manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages?.['plugins/founder'];
    ok(pkg, 'release-please-config.json must declare the plugins/founder package');
    strictEqual(pkg['package-name'], 'plugin-founder');
    strictEqual(pkg.component, 'plugin-founder');
    strictEqual(pkg['changelog-path'], 'CHANGELOG.md');
    const extraPaths = (pkg['extra-files'] ?? []).map((f) => f.path).sort();
    deepStrictEqual(extraPaths, ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']);
    for (const f of pkg['extra-files']) {
      strictEqual(f.type, 'json');
      strictEqual(f.jsonpath, '$.version');
    }
  });
});

describe('plugins/founder — repo wiring (self-guard)', () => {
  it('is wired into the explicit package.json test:plugin-shape file list', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    ok(pkg.scripts['test:plugin-shape'].includes('tests/plugin-shape/test-founder-plugin.mjs'),
      'host CI workflows run the explicit test:plugin-shape list — this file must be wired in');
  });
});
