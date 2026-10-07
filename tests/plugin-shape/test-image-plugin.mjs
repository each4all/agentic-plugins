// plugins/image plugin-shape conformance.
//
// image is a lean L2 capability: six verb surfaces and no workflow-continuity
// machinery. This file checks the surfaces the hosts and release tooling read
// (both plugin manifests; each verb's command, SKILL.md and agents/openai.yaml
// fields; the catalog and release-please entries), that the continuity
// machinery the L3 personas carry is absent, the two agent instructions that
// bound what generation may run and how a failure is handled, the privacy gate
// each verb that sends something off the host stops at, and that no code file
// calls the OpenAI image API directly.
//
// Run via `node --test tests/plugin-shape/test-image-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';
import { ERROR_KINDS } from '../../plugins/image/scripts/compose-dispatch.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/image');

// Where this plugin's skills live, read from its Codex manifest's `skills` key
// rather than assumed, so the required-file and forbidden-path checks below
// probe the root the hosts load — a forbidden check against a root nothing
// writes to would pass by matching nothing. `resolveSkillsRoot` throws on a
// broken declaration, so a bad manifest fails this file at load.
const SKILLS_REL = relative(PLUGIN_ROOT, resolveSkillsRoot(PLUGIN_ROOT)).split(sep).join('/');

const VERB_SKILLS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];

// Call forms of the OpenAI image API, its SDK and its key, scanned in code and
// shell files (.mjs/.js/.sh). Markdown and YAML are not scanned: the docs state
// the ban, and the compose-skill instruction is checked on its own below.
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

  // Contract: Claude Code's plugin loader and marketplace listing read these
  // manifest fields — rejects a misnamed plugin, a non-SemVer version, or a
  // listing with no description, author, license or links.
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

  // Its version is validate-versions' to check (ADR-0065 Decision 8 rule 6).
  // Contract: Codex reads name, skills (the root it loads skills from) and
  // interface (display name, category, default prompts) — rejects a skills
  // root Codex would not find or a plugin card with no name or prompts.
  it('names the plugin and declares skills + interface', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'image');
    strictEqual(json.skills, './core/skills/');
    ok(json.interface && typeof json.interface === 'object');
    strictEqual(json.interface.displayName, 'Image');
    strictEqual(json.interface.category, 'Productivity');
    ok(Array.isArray(json.interface.defaultPrompt) && json.interface.defaultPrompt.length > 0);
  });

  // Contract: Codex registers plugin hooks from the manifest's hooks key —
  // rejects a hooks declaration on a plugin that ships no hooks.
  it('declares NO hooks key (lean L2 — image has no workflow-continuity machinery)', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, undefined,
      'image is a lean L2 capability — the Codex manifest must NOT declare a hooks path (ADR-0037)');
  });
});

describe('plugins/image — lean shape (FORBIDS the L3 continuity machinery)', () => {
  // image passes its brief and result through run manifests, not a workflow
  // state file, so the continuity machinery the L3 personas ship — state.mjs
  // and its Stop/SessionStart scripts, hooks, adapters, and the
  // start/resume/checkpoint/peer-now entries — must be absent. Helper scripts
  // under scripts/ are allowed.
  const FORBIDDEN = [
    'scripts/state.mjs',
    'scripts/stop-archive.mjs',
    'scripts/session-handoff.mjs',
    'hooks',
    'hooks/hooks.json',
    'adapters',
    'commands/start.md',
    'commands/resume.md',
    'commands/checkpoint.md',
    'commands/peer-now.md',
  ];

  // The meta-skill directories are probed under the declared skills root
  // (SKILLS_REL). That the conventional `skills/` root stays inert is
  // kit/lint's relocation gate.
  const FORBIDDEN_META_SKILLS = ['start', 'resume', 'checkpoint', 'peer-now'];

  for (const rel of FORBIDDEN) {
    it(`has no ${rel} (lean L2 — no continuity machinery)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), false,
        `plugins/image/${rel} must NOT exist — image is a lean L2 capability (ADR-0037)`);
    });
  }

  for (const name of FORBIDDEN_META_SKILLS) {
    it(`has no ${SKILLS_REL}/${name} (lean L2 — no continuity machinery)`, async () => {
      strictEqual(await exists(skillsPath(PLUGIN_ROOT, name)), false,
        `plugins/image/${SKILLS_REL}/${name} must NOT exist — image is a lean L2 capability (ADR-0037)`);
    });
  }
});

describe('plugins/image — six verb surfaces', () => {
  // Commands stay plugin-root-relative; skills resolve through the declared
  // root so the pair keeps meaning the same thing on both sides of the move.
  const REQUIRED = [];
  for (const v of VERB_SKILLS) {
    REQUIRED.push({ label: `commands/${v}.md`, abs: resolve(PLUGIN_ROOT, 'commands', `${v}.md`) });
    REQUIRED.push({ label: `${SKILLS_REL}/${v}/SKILL.md`, abs: skillsPath(PLUGIN_ROOT, v, 'SKILL.md') });
    REQUIRED.push({
      label: `${SKILLS_REL}/${v}/agents/openai.yaml`,
      abs: skillsPath(PLUGIN_ROOT, v, 'agents/openai.yaml'),
    });
  }

  for (const { label, abs } of REQUIRED) {
    it(`ships ${label}`, async () => {
      strictEqual(await exists(abs), true, `plugins/image/${label} must exist`);
    });
  }

  for (const verb of VERB_SKILLS) {
    // Contract: both hosts' skill loaders read name and description from the
    // SKILL.md frontmatter — rejects a skill that resolves under another name
    // or carries no description to route on.
    it(`${SKILLS_REL}/${verb}/SKILL.md frontmatter name = ${verb}`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, verb, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `${SKILLS_REL}/${verb}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${verb}\\s*$`, 'm').test(fm), `frontmatter name != "${verb}"`);
      match(fm, /description:/, 'frontmatter must carry a description');
    });

    // Contract: Codex shows interface.display_name from agents/openai.yaml in
    // its skill list — rejects a missing display_name or one copied from
    // another verb or persona, which makes the six skills indistinguishable.
    it(`${SKILLS_REL}/${verb}/agents/openai.yaml display_name names the verb + persona`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, verb, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, 'openai.yaml must declare interface.display_name');
      ok(m[1].toLowerCase().includes(verb), `display_name "${m[1]}" must name the verb "${verb}"`);
      ok(m[1].toLowerCase().includes('image'), `display_name "${m[1]}" must name the persona "image"`);
    });

    // Contract: Claude Code reads the command's frontmatter description for
    // its slash-command list — rejects a command with no or an empty one.
    it(`commands/${verb}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${verb}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, 'frontmatter must carry a non-empty description');
    });
  }
});

describe('plugins/image — agent instructions that bound generation', () => {
  // Contract: the agent running image:compose (Codex loads this SKILL.md;
  // Claude's commands/compose.md defers to it) — rejects an edit that drops
  // the rule, leaving the agent free to reach the OpenAI image API from the
  // shell (a key, curl, an SDK) when Codex's tool is unavailable. The code
  // scan below cannot see a call the agent types itself. The frontmatter is
  // excluded so the routing description cannot stand in for the instruction.
  it('compose skill limits generation to Codex\'s integrated gpt-image, never the OpenAI image API', async () => {
    const text = await readFile(skillsPath(PLUGIN_ROOT, 'compose', 'SKILL.md'), 'utf8');
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\*/g, '').replace(/\s+/g, ' ');
    match(body, /\bCodex.s integrated gpt-image\b/i,
      'compose SKILL.md must route generation through Codex\'s integrated gpt-image tool');
    match(body, /\bnever\b[^.]{0,40}\bOpenAI image API\b/i,
      'compose SKILL.md must forbid calling the OpenAI image API directly');
  });

  // Contract: the compose skill's error step sends the agent to the
  // docs/contracts.md error table for each kind's retry posture — rejects a
  // kind compose-dispatch can emit with no row or an empty posture, which
  // leaves the agent to guess whether to retry, stop, or hand off to refine.
  it('docs/contracts.md gives a retry posture for every error kind compose-dispatch emits', async () => {
    const lines = (await readFile(resolve(PLUGIN_ROOT, 'docs/contracts.md'), 'utf8')).split('\n');
    const header = lines.findIndex((l) => /^\|\s*kind\s*\|/.test(l));
    ok(header >= 0, 'docs/contracts.md must carry the error-kind table (header row "| kind | ... |")');
    const posture = new Map();
    for (const line of lines.slice(header + 2)) {
      if (!line.startsWith('|')) break;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const kind = cells[0]?.match(/^`([a-z_]+)`$/)?.[1];
      if (kind) posture.set(kind, cells[2] ?? '');
    }
    deepStrictEqual(ERROR_KINDS.filter((k) => !posture.get(k)), [],
      'every ERROR_KINDS entry needs a row with a retry posture in the docs/contracts.md error table');
  });
});

describe('plugins/image — privacy gate before anything leaves the host (docs/contracts.md §9)', () => {
  const flat = (text) => text.replace(/\*/g, '').replace(/\s+/g, ' ');

  // What each verb sends off the host, and the gate it stops at first: web
  // search and the Codex dispatch for investigate, the prompt for compose and
  // refine, the image file itself for critique. frame and decide send nothing.
  // Each gate names when it applies ("before ... dispatch"), except the
  // critique skill's, which names no timing and is checked for presence with
  // the confirmation a private image needs; no check here orders it against
  // the skill's dispatch.
  const GATES = {
    investigate: /genericize (?:any proprietary subject, brand, or reference asset|the subject\/brand) before (?:any )?web search or cross-host dispatch/i,
    compose: /genericize the prompt before (?:cross-host )?dispatch/i,
    refine: /genericize the revised prompt(?: \+ feedback)? before cross-host dispatch/i,
  };
  const CRITIQUE_GATES = {
    command: /the image path AND its visual contents leave the local host\. Genericize or gate non-public images before dispatch\./,
    skill: /the image path AND its visual contents leave the local host[^.]{0,40}\. Genericize or gate non-public images — never critique a private\/proprietary image off-host without explicit confirmation\./,
  };
  const surfaces = (verb) => [
    ['command', `commands/${verb}.md`, resolve(PLUGIN_ROOT, 'commands', `${verb}.md`)],
    ['skill', `${SKILLS_REL}/${verb}/SKILL.md`, skillsPath(PLUGIN_ROOT, verb, 'SKILL.md')],
  ];

  // Contract: the agent running a verb on Claude reads the command and the
  // SKILL.md (Codex reads the SKILL.md; its compose generates natively and
  // dispatches nothing) and genericizes before the web search or the Codex
  // dispatch — a surface without the gate sends a proprietary subject, brand,
  // prompt or image off the host as written. Rejects the gate sentence
  // deleted, replaced, or moved after the dispatch on any of the eight
  // surfaces, and the critique skill's confirmation dropped.
  for (const verb of [...Object.keys(GATES), 'critique']) {
    it(`${verb}'s command and skill genericize before anything leaves the host`, async () => {
      for (const [kind, rel, abs] of surfaces(verb)) {
        const gate = verb === 'critique' ? CRITIQUE_GATES[kind] : GATES[verb];
        match(flat(await readFile(abs, 'utf8')), gate, `${rel} must state the privacy gate before its web search or dispatch`);
      }
    });
  }

  // Contract: compose-dispatch.mjs builds the prompt it sends to Codex from the
  // text of the file --prompt-file names, and of a repeated flag (spaced or
  // `=`, quoted or not) the last one wins — rejects a dispatch call that
  // points it at the raw prompt rather than the genericized one, alone or
  // after it, and a second call that does.
  it('compose\'s dispatch calls pass the genericized prompt file, once', async () => {
    for (const [, rel, abs] of surfaces('compose')) {
      const lines = (await readFile(abs, 'utf8')).split('\n');
      const calls = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (!/\bnode\b.*compose-dispatch\.mjs/.test(lines[i])) continue;
        const call = [lines[i]];
        while (lines[i].trimEnd().endsWith('\\') && i + 1 < lines.length) call.push(lines[++i]);
        calls.push(call.join('\n'));
      }
      strictEqual(calls.length, 1, `${rel} makes one compose-dispatch.mjs call`);
      const values = [...calls[0].matchAll(/["']?--prompt-file["']?(?:=|\s+)["']?([^\s"']+)/g)].map((m) => m[1]);
      deepStrictEqual(values, ['<genericized-prompt-file>'],
        `${rel} must dispatch the genericized prompt file and no other:\n${calls[0]}`);
    }
  });

  // Contract: every gate above points the agent at docs/contracts.md §9 for
  // what the gate covers and when — the prompt, and for critique the image file
  // and any reference assets, genericized before dispatch. §9 is that one
  // statement, so it is pinned whole: rejects the section deleted or
  // renumbered, which leaves every pointer resolving to nothing, and any clause
  // narrowed (an asset or a verb excepted, the gate moved after dispatch).
  it('docs/contracts.md §9 holds the gate the skills point at', async () => {
    const text = (await readFile(resolve(PLUGIN_ROOT, 'docs/contracts.md'), 'utf8')).replace(/\*/g, '');
    const section = text.split(/^## /m).find((s) => /^9\.\s/.test(s));
    ok(section, 'docs/contracts.md must keep the §9 the skills cite');
    match(flat(section), /Cross-host image prompts pass an explicit privacy gate \(genericize before dispatch\) since the prompt text — and, for `image:critique`, the attached image file and any reference assets — leaves the local host for Codex\. Only the genericized form leaves the local host\./,
      '§9 must gate the prompt, and for critique the image file and any reference assets, before dispatch');
  });
});

describe('plugins/image — direct-OpenAI-API ban (ADR-0037 Alternative 6)', () => {
  // Code scan: rejects a script or shell helper in the plugin that calls the
  // OpenAI image API, imports its SDK or reads its key — generation runs only
  // through Codex.
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

describe('plugins/image — Claude marketplace catalog entry', () => {
  // Contract: Claude Code's marketplace installs the plugin from entry.source
  // — rejects a missing entry or one pointing at another directory.
  it('exists with source/category aligned to the plugin', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'image');
    ok(entry, 'Claude catalog must list image');
    strictEqual(entry.source, './plugins/image');
    strictEqual(entry.category, 'Productivity');
  });
});

// Whether the Codex catalog lists this package, and at which pin, and the
// Claude catalog's version are validate-marketplace's and validate-versions'
// to check (ADR-0065 Decision 8 rule 6). The release job's sync writes them
// after the release commit, so a test reading them would turn that commit
// red; a first release has no Codex entry until the sync adds it.
describe('plugins/image — Codex marketplace catalog entry', () => {
  // Contract: Codex reads policy.installation/authentication when offering the
  // plugin — rejects an entry that changes how it is installed or authorized.
  it('carries the published policy and category', async (t) => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'image');
    if (entry === undefined) return t.skip('no Codex entry yet; validate-marketplace decides whether one is due');
    deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
    strictEqual(entry.category, 'Productivity');
  });
});

describe('plugins/image — release-please wiring', () => {
  // Contract: release-please — rejects a package it would not version, or a
  // release that leaves either host manifest's version behind.
  it('is tracked in .release-please-manifest.json', async () => {
    // Its version's agreement with the plugin manifests is validate-versions' to
    // check (ADR-0065 Decision 8 rule 6); this pins that release-please tracks it.
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(typeof manifest['plugins/image'], 'string');
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
