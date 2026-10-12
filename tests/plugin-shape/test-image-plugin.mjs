// plugins/image plugin-shape conformance.
//
// image is a lean L2 capability: six verb surfaces and no workflow-continuity
// machinery. This file checks the surfaces the hosts and release tooling read
// (both plugin manifests; each verb's command, SKILL.md and agents/openai.yaml
// fields; the catalog and release-please entries), that the continuity
// machinery the L3 personas carry is absent, the two agent instructions that
// bound what generation may run and how a failure is handled, the disclosure
// each verb that sends the request to Codex makes before it does, and that no
// code file calls the OpenAI image API directly.
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

describe('plugins/image — send disclosure (docs/contracts.md §9)', () => {
  // On the Claude host, compose, refine and critique send the request to Codex,
  // a service of another provider (ADR-0037 Decision 5, amended 2026-10-12).
  // The guarantee that the user learns this lives in the code that sends: the
  // dispatch helpers write the disclosure immediately before they spawn the
  // companion, and record it (tests/image/test-send-disclosure.mjs orders the
  // two). Each surface repeats it as the instruction the agent follows, naming
  // what is sent; this checks the sentence is there, not where it falls in the
  // markdown, which is the model's to follow and no scanner can decide.
  // investigate, frame and decide send nothing to Codex.
  const DISCLOSURES = {
    compose: 'the prompt text goes to Codex (OpenAI), which runs in the repository and can read files there',
    refine: 'the base prompt and the feedback go to Codex (OpenAI), which runs in the repository and can read files there',
    critique: 'the image and the criteria go to Codex (OpenAI), which reads the image by its path, runs in the repository and can read files there',
  };
  const surfaces = (verb) => [
    [`commands/${verb}.md`, resolve(PLUGIN_ROOT, 'commands', `${verb}.md`)],
    [`${SKILLS_REL}/${verb}/SKILL.md`, skillsPath(PLUGIN_ROOT, verb, 'SKILL.md')],
  ];
  const flat = (text) => text.replace(/\*/g, '').replace(/\s+/g, ' ');

  // Contract: the agent running a verb on Claude reads its command and its
  // SKILL.md, and tells the user what goes to Codex (OpenAI) and that Codex
  // can read the repository, asking no confirmation. Rejects, on each of the
  // six surfaces, the disclosure deleted or reworded so it no longer names
  // what is sent, its §9 pointer dropped, and a confirmation asked instead.
  for (const [verb, words] of Object.entries(DISCLOSURES)) {
    for (const [rel, abs] of surfaces(verb)) {
      it(`${rel} tells the user what goes to Codex`, async () => {
        const text = flat(await readFile(abs, 'utf8'));
        ok(text.includes(words), `${rel} must say that ${words}`);
        match(text, /`docs\/contracts\.md` §(?:\d+, §?)*9\b/, `${rel}: the disclosure must point at docs/contracts.md §9`);
        match(text, /\bask no confirmation\b/, `${rel}: the disclosure must say that no confirmation is asked`);
      });
    }
  }

  // Contract: the verbs that disclose nothing send nothing — rejects a
  // dispatch helper or the companion named on investigate's, frame's or
  // decide's command or skill, where no disclosure precedes it.
  for (const verb of VERB_SKILLS.filter((v) => !(v in DISCLOSURES))) {
    it(`${verb}'s command and skill send nothing to Codex`, async () => {
      for (const [rel, abs] of surfaces(verb)) {
        ok(!/(?:compose|refine|critique)-dispatch\.mjs|codex-companion/.test(await readFile(abs, 'utf8')), `${rel} names a sender to Codex without a disclosure`);
      }
    });
  }

  // Contract: the gate the disclosure replaced is gone from every verb's
  // command, skill and agent card — rejects a leftover instruction to
  // genericize, which would have the agent rewrite the user's request where
  // §9 says Codex receives it as the user wrote it.
  it('no verb surface tells the agent to genericize the request', async () => {
    const offenders = [];
    for (const verb of VERB_SKILLS) {
      for (const [rel, abs] of [...surfaces(verb), [`${SKILLS_REL}/${verb}/agents/openai.yaml`, skillsPath(PLUGIN_ROOT, verb, 'agents/openai.yaml')]]) {
        if (/genericiz/i.test(await readFile(abs, 'utf8'))) offenders.push(rel);
      }
    }
    deepStrictEqual(offenders, [], 'the privacy gate was replaced by the send disclosure (docs/contracts.md §9)');
  });

  // Contract: every disclosure above points the agent at docs/contracts.md §9
  // for who sends what, that the helpers disclose before they send, and that
  // no confirmation is asked. Rejects the section deleted or renumbered, which
  // leaves every pointer resolving to nothing, a verb dropped from it, the
  // helper's disclosure moved after the spawn, the repository access left
  // out, and a confirmation or a genericizing step put back.
  it('docs/contracts.md §9 holds the disclosure the surfaces point at', async () => {
    const text = (await readFile(resolve(PLUGIN_ROOT, 'docs/contracts.md'), 'utf8')).replace(/\*/g, '');
    const section = text.split(/^## /m).find((s) => /^9\.\s/.test(s));
    ok(section, 'docs/contracts.md must keep the §9 the surfaces cite');
    const body = flat(section);
    match(body, /^9\. Send disclosure /);
    match(body, /On the Claude host, `image:compose`, `image:refine` and `image:critique` send the request to Codex/);
    match(body, /so Codex can read files there as well/);
    match(body, /Immediately before it spawns the companion, the helper writes one line to stderr naming what it sends, that it goes to Codex \(OpenAI\), and the directory Codex runs in\./);
    match(body, /It asks no confirmation, and the request is not genericized/);
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
