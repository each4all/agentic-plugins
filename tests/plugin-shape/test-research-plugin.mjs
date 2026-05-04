// plugins/research plugin-shape conformance test (C.1).
//
// RED test: every assertion below fails until plugins/research/ is
// scaffolded (G1) and content/host integration land (G2-G3). Mirrors
// test-companions-plugin.mjs structure with research-specific shape:
// skill + 3 references + Codex agents YAML + 2 adapter discovery scripts.
//
// Slug sanitization unit tests and cache-glob discovery mocks are NOT
// in this file — they live in dedicated unit tests added alongside the
// implementations they cover (planned in G2-G3).
//
// Run via `node --test tests/plugin-shape/test-research-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/research');

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
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe('plugins/research — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'research');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('has author block with name=each4all', async () => {
    const json = await readJSON(path);
    ok(json.author, 'author missing');
    strictEqual(typeof json.author, 'object');
    strictEqual(json.author.name, 'each4all');
  });
});

describe('plugins/research — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields per Codex vendored spec', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'research');
    for (const field of ['version', 'description', 'homepage', 'license']) {
      strictEqual(typeof json[field], 'string', `${field} missing or non-string`);
      ok(json[field].length > 0, `${field} empty`);
    }
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
  });

  it('has author and repository', async () => {
    const json = await readJSON(path);
    ok(json.author, 'author missing');
    ok(json.repository, 'repository missing');
  });

  it('has keywords array', async () => {
    const json = await readJSON(path);
    ok(Array.isArray(json.keywords), 'keywords not an array');
    ok(json.keywords.length > 0, 'keywords empty');
  });

  it('has skills field per Codex vendored spec (REQUIRED)', async () => {
    const json = await readJSON(path);
    strictEqual(json.skills, './skills/');
  });

  it('has interface block with research-specific values', async () => {
    const json = await readJSON(path);
    const i = json.interface;
    ok(i, 'interface block missing');
    strictEqual(typeof i.displayName, 'string');
    strictEqual(typeof i.shortDescription, 'string');
    strictEqual(typeof i.longDescription, 'string');
    strictEqual(typeof i.developerName, 'string');
    strictEqual(i.category, 'Research');
    ok(Array.isArray(i.capabilities), 'capabilities not array');
    for (const cap of ['Interactive', 'Read', 'Write']) {
      ok(i.capabilities.includes(cap), `capabilities missing "${cap}"`);
    }
  });

  it('interface.defaultPrompt is array of 1-3 entries, each ≤128 chars, with at least one mentioning $research', async () => {
    const json = await readJSON(path);
    const dp = json.interface.defaultPrompt;
    ok(Array.isArray(dp), 'defaultPrompt not array');
    ok(dp.length >= 1 && dp.length <= 3, `defaultPrompt has ${dp.length} entries (1-3 expected)`);
    for (const entry of dp) {
      strictEqual(typeof entry, 'string');
      ok(entry.length <= 128, `defaultPrompt entry exceeds 128 chars: ${entry.length}`);
    }
    ok(dp.some((p) => p.includes('$research')), 'no defaultPrompt entry mentions $research');
  });
});

describe('plugins/research — manifest cross-checks', () => {
  it('Claude and Codex manifests agree on name', async () => {
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const codex = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(claude.name, codex.name);
  });
});

describe('plugins/research — skill (skills/research/SKILL.md)', () => {
  const path = resolve(PLUGIN_ROOT, 'skills/research/SKILL.md');

  it('exists', async () => {
    ok(await exists(path), 'SKILL.md missing');
  });

  it('has frontmatter with name=research and non-empty description', async () => {
    const text = await readFile(path, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter');
    ok(/^name:\s*research\s*$/m.test(fm), 'frontmatter name != research');
    ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
  });

  it('passes stale-token audit (no omcc references, no host source-of-discovery labels)', async () => {
    const text = await readFile(path, 'utf8');
    for (const stale of ['omcc-research', '/omcc-research', 'CODEX_HOME', 'CLAUDE-ONLY', 'CODEX-ONLY']) {
      ok(!text.includes(stale), `SKILL.md leaks stale token: ${stale}`);
    }
  });
});

describe('plugins/research — references (skills/research/references/*.md)', () => {
  for (const name of ['research-brief-spec.md', 'output-file-rules.md', 'ensemble-protocol.md']) {
    it(`${name} exists`, async () => {
      const path = resolve(PLUGIN_ROOT, 'skills/research/references', name);
      ok(await exists(path), `${name} missing`);
    });
  }
});

describe('plugins/research — Codex agents YAML (skills/research/agents/openai.yaml)', () => {
  const path = resolve(PLUGIN_ROOT, 'skills/research/agents/openai.yaml');

  it('exists', async () => {
    ok(await exists(path), 'agents/openai.yaml missing');
  });

  it('has interface block with display_name=Research and default_prompt mentioning $research (Codex agents/openai.yaml schema)', async () => {
    const yaml = await readFile(path, 'utf8');
    ok(/^interface:\s*$/m.test(yaml), 'interface block missing — Codex skill loader requires display_name etc. nested under interface:');
    ok(/^\s+display_name:\s*["']?Research/m.test(yaml), 'interface.display_name missing or != Research');
    ok(/\$research/.test(yaml), 'default_prompt does not mention $research');
  });

  it('policy.allow_implicit_invocation is false (D.1 — explicit $research only)', async () => {
    const yaml = await readFile(path, 'utf8');
    ok(/^policy:\s*$/m.test(yaml), 'policy block missing');
    ok(/allow_implicit_invocation:\s*false/m.test(yaml), 'allow_implicit_invocation should be false');
  });
});

describe('plugins/research — adapter discovery scripts (adapters/<host>/scripts/discover-companion.mjs)', () => {
  for (const host of ['claude', 'codex']) {
    describe(`${host} adapter`, () => {
      const path = resolve(PLUGIN_ROOT, `adapters/${host}/scripts/discover-companion.mjs`);

      it('exists as a regular file', async () => {
        const st = await stat(path);
        ok(st.isFile(), `adapters/${host}/scripts/discover-companion.mjs is not a regular file`);
      });

      it('has the executable bit set', async () => {
        const st = await stat(path);
        ok(
          (st.mode & 0o111) !== 0,
          `adapters/${host}/scripts/discover-companion.mjs executable bit not set (mode=${(st.mode & 0o777).toString(8)})`
        );
      });
    });
  }
});
