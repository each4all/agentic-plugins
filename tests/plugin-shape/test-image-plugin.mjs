// plugins/image plugin-shape conformance test (ADR-0037 — scaffold slice).
//
// image is a LEAN L2 capability plugin: six cognitive verb surfaces +
// contract docs, with NO workflow-continuity machinery (no state.mjs,
// hooks, adapters, start macro, or resume/checkpoint/peer-now meta skills).
// This is the inverse of the founder/engineer L3-persona contract — the
// machinery those plugins REQUIRE, image FORBIDS. Helper scripts (e.g. a
// future dispatch-glue module under scripts/) are permitted; only the
// continuity machine is forbidden.
//
// Generation runs ONLY through Codex's integrated gpt-image tool — a
// direct-OpenAI-API-ban sentinel guards against a direct API call ever
// entering the plugin (ADR-0037 Alternative 6).
//
// Run via `node --test tests/plugin-shape/test-image-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/image');

const VERB_SKILLS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];

// image has NO omcc ancestor — these stale tokens must never appear.
const STALE_TOKENS = [/\bomcc\b/i, /\[Claude\]/, /\[Codex\]/, /CODEX_HOME/, /CLAUDE-ONLY/, /CODEX-ONLY/];

// Direct-OpenAI-API ban (ADR-0037 Alternative 6). Generation runs ONLY
// through Codex's integrated gpt-image tool — never a direct API call.
// Scan code/shell files (.mjs/.js/.sh) for actual call forms; prose
// (.md/.yaml) is exempt because the docs legitimately *describe* the ban —
// but a future code or shell helper reintroducing a direct call IS caught.
const DIRECT_API_FORMS = [
  /\bimages\s*\.\s*(generate|edit|createVariation)\s*\(/,
  /api\.openai\.com/,
  /\bnew\s+OpenAI\b/,
  /\bOPENAI_API_KEY\b/,
  /from\s+['"]openai['"]/,
  /require\(\s*['"]openai['"]\s*\)/,
];

async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
function frontmatter(text) { const m = text.match(/^---\n([\s\S]*?)\n---/); return m ? m[1] : null; }

describe('plugins/image — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON with required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'image');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
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

describe('plugins/image — Codex manifest (lean L2: skills + interface, NO hooks)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('matches Claude name/version and declares skills + interface', async () => {
    const json = await readJSON(path);
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'image');
    strictEqual(json.version, claude.version, 'host manifests must carry the same version');
    strictEqual(json.skills, './skills/');
    ok(json.interface && typeof json.interface === 'object');
    strictEqual(json.interface.displayName, 'Image');
    strictEqual(json.interface.category, 'Productivity');
    ok(Array.isArray(json.interface.defaultPrompt) && json.interface.defaultPrompt.length > 0);
  });

  it('declares NO hooks key (lean L2 — image has no workflow-continuity machinery)', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, undefined,
      'image is a lean L2 capability — the Codex manifest must NOT declare a hooks path (ADR-0037)');
  });
});

describe('plugins/image — lean shape (FORBIDS the L3 continuity machinery)', () => {
  // founder/engineer (L3 personas) REQUIRE scripts/state.mjs + hooks/ +
  // adapters/ + start/resume/checkpoint/peer-now. image is a lean L2
  // generation capability — those are FORBIDDEN (ADR-0037 lean-L2 decision,
  // peer-confirmed at plan time). Helper scripts under scripts/ are allowed;
  // only the continuity MACHINE (state.mjs, hooks, adapters, macro/meta) is not.
  const FORBIDDEN = [
    'scripts/state.mjs',
    'scripts/stop-archive.mjs',
    'scripts/session-handoff.mjs',
    'hooks',
    'hooks/hooks.json',
    'adapters',
    'skills/start',
    'skills/resume',
    'skills/checkpoint',
    'skills/peer-now',
    'commands/start.md',
    'commands/resume.md',
    'commands/checkpoint.md',
    'commands/peer-now.md',
  ];

  for (const rel of FORBIDDEN) {
    it(`has no ${rel} (lean L2 — no continuity machinery)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), false,
        `plugins/image/${rel} must NOT exist — image is a lean L2 capability (ADR-0037)`);
    });
  }
});

describe('plugins/image — six verb surfaces', () => {
  const REQUIRED = [];
  for (const v of VERB_SKILLS) {
    REQUIRED.push(`commands/${v}.md`, `skills/${v}/SKILL.md`, `skills/${v}/agents/openai.yaml`);
  }

  for (const rel of REQUIRED) {
    it(`ships ${rel}`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true, `plugins/image/${rel} must exist`);
    });
  }

  for (const verb of VERB_SKILLS) {
    it(`skills/${verb}/SKILL.md frontmatter name = ${verb}`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `skills/${verb}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${verb}\\s*$`, 'm').test(fm), `frontmatter name != "${verb}"`);
      match(fm, /description:/, 'frontmatter must carry a description');
    });

    it(`skills/${verb}/agents/openai.yaml display_name names the verb + persona`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, 'openai.yaml must declare interface.display_name');
      ok(m[1].toLowerCase().includes(verb), `display_name "${m[1]}" must name the verb "${verb}"`);
      ok(m[1].toLowerCase().includes('image'), `display_name "${m[1]}" must name the persona "image"`);
    });

    it(`commands/${verb}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${verb}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, 'frontmatter must carry a non-empty description');
    });
  }
});

describe('plugins/image — contract surfaces (docs/contracts.md)', () => {
  const SPEC = 'docs/contracts.md';

  it('exists and defines the load-bearing contract sections', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    for (const token of ['ImageBrief', 'ImageResult', 'run manifest', 'retention', 'privacy', 'gpt-image']) {
      ok(new RegExp(token, 'i').test(text), `contracts.md must mention "${token}"`);
    }
  });

  it('records the typed error taxonomy kinds', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    for (const kind of ['moderation_blocked', 'quota_exhausted', 'peer_cli_not_found', 'write_failed']) {
      ok(text.includes(kind), `contracts.md must define the error kind "${kind}"`);
    }
  });

  it('declares the lean-L2 no-machinery posture', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    match(text, /lean L2/i, 'contracts.md must declare the lean-L2 posture');
    match(text, /no.*state\.mjs|no.*workflow-continuity/i, 'contracts.md must state there is no continuity machinery');
  });
});

describe('plugins/image — direct-OpenAI-API ban (ADR-0037 Alternative 6)', () => {
  it('no code file calls the OpenAI image API directly (generation goes only through Codex)', async () => {
    const entries = await readdir(PLUGIN_ROOT, { recursive: true, withFileTypes: true });
    const offenders = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.mjs') && !ent.name.endsWith('.js') && !ent.name.endsWith('.sh')) continue;
      const parent = ent.parentPath ?? ent.path;
      const full = resolve(parent, ent.name);
      const rel = full.slice(PLUGIN_ROOT.length + 1);
      const text = await readFile(full, 'utf8');
      for (const form of DIRECT_API_FORMS) {
        if (form.test(text)) offenders.push(`${rel} :: ${form.source}`);
      }
    }
    deepStrictEqual(offenders, [],
      `image generation must run ONLY through Codex's integrated gpt-image — no direct OpenAI API calls (ADR-0037 Alternative 6):\n  ${offenders.join('\n  ')}`);
  });
});

describe('plugins/image — no stale tokens (no omcc ancestor)', () => {
  it('no omcc / [Claude] / [Codex] / *-ONLY tokens anywhere in the plugin tree', async () => {
    const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.yml']);
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
    ok(scanned >= 15, `expected to scan the image plugin tree, only saw ${scanned} files`);
  });
});

describe('plugins/image — README + CHANGELOG', () => {
  it('README points at ADR-0037', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(readme.includes('ADR-0037'), 'plugin README must point at ADR-0037');
  });

  it('CHANGELOG records the initial scaffold seed entry', async () => {
    const cl = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
    ok(cl.includes('0.1.0 (initial scaffold seed)'),
      'CHANGELOG must record the seed entry without implying a published tag');
  });
});

describe('plugins/image — Claude marketplace catalog entry', () => {
  it('exists with source/version/category aligned to the plugin', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'image');
    ok(entry, 'Claude catalog must list image');
    strictEqual(entry.source, './plugins/image');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version);
    strictEqual(entry.category, 'Productivity');
  });
});

describe('plugins/image — Codex marketplace catalog entry', () => {
  it('exists with the local-source/policy/category shape', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'image');
    ok(entry, 'Codex catalog must list image');
    deepStrictEqual(entry.source, { source: 'local', path: './plugins/image' });
    deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
    strictEqual(entry.category, 'Productivity');
    strictEqual(await exists(resolve(REPO_ROOT, entry.source.path)), true);
  });
});

describe('plugins/image — release-please wiring', () => {
  it('is tracked in .release-please-manifest.json at the manifest version', async () => {
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    const plugin = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(manifest['plugins/image'], plugin.version);
  });

  it('has a plugin-image package block with both manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages?.['plugins/image'];
    ok(pkg, 'release-please-config.json must declare the plugins/image package');
    strictEqual(pkg['package-name'], 'plugin-image');
    strictEqual(pkg.component, 'plugin-image');
    strictEqual(pkg['changelog-path'], 'CHANGELOG.md');
    const extraPaths = (pkg['extra-files'] ?? []).map((f) => f.path).sort();
    deepStrictEqual(extraPaths, ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']);
    for (const f of pkg['extra-files']) {
      strictEqual(f.type, 'json');
      strictEqual(f.jsonpath, '$.version');
    }
  });
});

describe('plugins/image — repo wiring (self-guard)', () => {
  it('is wired into the explicit package.json test:plugin-shape file list', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    ok(pkg.scripts['test:plugin-shape'].includes('tests/plugin-shape/test-image-plugin.mjs'),
      'host CI workflows run the explicit test:plugin-shape list — this file must be wired in');
  });
});
