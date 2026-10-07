// plugins/founder plugin-shape conformance.
//
// What the hosts and the tools read from the plugin's committed files:
//   - both manifests, the two catalog entries and the release-please package;
//   - every skill's SKILL.md frontmatter and agents/openai.yaml (6 verbs, the
//     `start` macro, the `resume` / `checkpoint` / `peer-now` meta skills), and
//     every command's frontmatter;
//   - the files those name: the scripts, the hook entrypoints (present and
//     executable), the decision registry, the references, and the module
//     every hook imports.
//
// Plus the founder instructions no shared suite pins: the privacy gates
// founder authors itself (peer-now's command gate included), refine's
// profile-less create, peer-now's synchronous dispatch, the commands' freedom
// from parent-linkage variables (founder is no orchestrator dispatch target,
// ADR-0036 Non-Goal 3), the session-handoff runbook's freedom from cross-plugin
// paths, and the completion-footer handoff.
//
// The runbook, skill and reference regions every persona shares are checked
// under tests/persona-pipeline/.
//
// Run via `node --test tests/plugin-shape/test-founder-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/founder');

// Where this plugin's skills actually live, read from its own Codex manifest
// rather than assumed. The 2026-09-18 Amendment to ADR-0006 moved the root to
// core/skills/. `resolveSkillsRoot` throws on a broken declaration rather than
// falling back, so this file fails loudly at load instead of pointing every
// path below at a directory nothing writes to. A manifest with no `skills` key
// does fall back, to the README-only `skills/`; the skill checks below fail.
const SKILLS_REL = relative(PLUGIN_ROOT, resolveSkillsRoot(PLUGIN_ROOT)).split(sep).join('/');

const VERB_SKILLS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];

// start is a lifecycle macro and resume/checkpoint/peer-now are meta skills —
// none is a cognitive verb, so they stay out of VERB_SKILLS. Each still ships a
// command, a SKILL.md and an agents/openai.yaml.
const MACRO_AND_META = ['start', 'resume', 'checkpoint', 'peer-now'];

// The decision registry founder:decide and founder:compose run, and the axes
// file it reads.
const REQUIRED_RESOLVER = [
  'scripts/decide-registry.mjs',
  'scripts/lib/yaml-mini.mjs',
  'scripts/lib/decide-args.mjs',
  'scripts/lib/decide-scores.mjs',
  'scripts/lib/decide-weights.mjs',
  'scripts/lib/decide-sensitivity.mjs',
  `${SKILLS_REL}/decide/references/decision-axes.yml`,
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

// Every `state.mjs" create` invocation in a runbook, with its backslash
// continuation lines.
function createCalls(text) {
  const lines = text.split('\n');
  const calls = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/state\.mjs" create \\$/.test(lines[i])) continue;
    const call = [lines[i]];
    while (lines[i].endsWith('\\') && i + 1 < lines.length) call.push(lines[++i]);
    calls.push(call.join('\n'));
  }
  return calls;
}

// Contract: Claude Code reads .claude-plugin/plugin.json to install and list the
// plugin — a missing name, a non-SemVer version or an empty description fails
// the install or lists the plugin blank; the publishing fields fill its listing.
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

  it('carries publishing metadata consistent with sibling plugins', async () => {
    const json = await readJSON(path);
    strictEqual(json.license, 'MIT');
    strictEqual(json.author?.name, 'each4all');
    strictEqual(typeof json.homepage, 'string');
    strictEqual(typeof json.repository, 'string');
    ok(Array.isArray(json.keywords) && json.keywords.length > 0);
  });
});

// Contract: Codex reads .codex-plugin/plugin.json — `skills` and `hooks` locate
// the skills root and the hooks manifest, `interface` drives the plugin listing;
// a wrong value loads no skills or no hooks, or fails the listing.
describe('plugins/founder — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  // Its version is validate-versions' to check (ADR-0065 Decision 8 rule 6).
  it('parses as JSON with the required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'founder');
    strictEqual(typeof json.description, 'string');
  });

  it('declares the hooks and skills paths and the interface block', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json',
      'the Codex manifest must point at the Codex hooks manifest');
    strictEqual(json.skills, './core/skills/',
      'the Codex manifest must point at the skills root');
    ok(json.interface && typeof json.interface === 'object',
      'the Codex manifest must carry an interface block');
    strictEqual(json.interface.displayName, 'Founder');
    strictEqual(json.interface.category, 'Productivity');
    ok(Array.isArray(json.interface.defaultPrompt) && json.interface.defaultPrompt.length > 0);
  });
});

describe('plugins/founder — shipped surface (machinery, verbs, decision registry, start and meta skills)', () => {
  const ABSENT_DIRS = [
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  // ADR-0006's 2026-09-18 Amendment restates these categories under `core/`, so
  // each is forbidden there too — checking the plugin root alone passes on a
  // `core/personas/` by matching nothing.
  for (const dir of ABSENT_DIRS) {
    for (const rel of [dir, `core/${dir}`]) {
      it(`has no ${rel}/ directory (not part of the founder surface)`, async () => {
        strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), false,
          `plugins/founder/${rel}/ must not exist — it is not part of the founder surface`);
      });
    }
  }

  // Contract: the runbooks and hooks run these scripts by path, every script
  // reads persona.json through scripts/lib/persona.mjs, and the two hooks
  // manifests run the hook entrypoints — a missing file fails every call.
  const REQUIRED_MACHINERY = [
    'scripts/state.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'scripts/discover-runtime.mjs',
    'persona.json',
    'scripts/lib/persona.mjs',
    'scripts/lib/cli-entry.mjs',
    'scripts/lib/hook-helpers.mjs',
    'hooks/hooks.json',
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
    it(`ships ${rel} (machinery)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is run by the runbooks or hooks and must exist`);
    });
  }

  // Contract: Claude Code loads commands/<name>.md as /founder:<name>, Codex
  // loads <skills-root>/<name>/SKILL.md and its agents/openai.yaml, and the
  // runbooks open these references by path — a missing file drops the command
  // or the skill, or fails the read.
  const REQUIRED_SURFACES = [
    'commands/investigate.md',
    'commands/frame.md',
    `${SKILLS_REL}/investigate/SKILL.md`,
    `${SKILLS_REL}/investigate/agents/openai.yaml`,
    `${SKILLS_REL}/investigate/references/business-brief-spec.md`,
    `${SKILLS_REL}/investigate/references/business-brief-ensemble.md`,
    `${SKILLS_REL}/investigate/references/output-file-rules.md`,
    `${SKILLS_REL}/frame/SKILL.md`,
    `${SKILLS_REL}/frame/agents/openai.yaml`,
    `${SKILLS_REL}/_shared/references/orchestration.md`,
    'commands/decide.md',
    'commands/compose.md',
    `${SKILLS_REL}/decide/SKILL.md`,
    `${SKILLS_REL}/decide/agents/openai.yaml`,
    `${SKILLS_REL}/compose/SKILL.md`,
    `${SKILLS_REL}/compose/agents/openai.yaml`,
    'commands/critique.md',
    'commands/refine.md',
    `${SKILLS_REL}/critique/SKILL.md`,
    `${SKILLS_REL}/critique/agents/openai.yaml`,
    `${SKILLS_REL}/refine/SKILL.md`,
    `${SKILLS_REL}/refine/agents/openai.yaml`,
    `${SKILLS_REL}/_shared/references/ensemble-protocol.md`,
    'commands/start.md',
    `${SKILLS_REL}/start/SKILL.md`,
    `${SKILLS_REL}/start/agents/openai.yaml`,
    'commands/resume.md',
    `${SKILLS_REL}/resume/SKILL.md`,
    `${SKILLS_REL}/resume/agents/openai.yaml`,
    'commands/checkpoint.md',
    `${SKILLS_REL}/checkpoint/SKILL.md`,
    `${SKILLS_REL}/checkpoint/agents/openai.yaml`,
    'commands/peer-now.md',
    `${SKILLS_REL}/peer-now/SKILL.md`,
    `${SKILLS_REL}/peer-now/agents/openai.yaml`,
    `${SKILLS_REL}/_shared/references/session-handoff.md`,
    `${SKILLS_REL}/_shared/references/entry-routing-contract.md`,
  ];

  for (const rel of REQUIRED_SURFACES) {
    it(`ships ${rel} (command, skill or reference)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is loaded by a host or read by a runbook and must exist`);
    });
  }

  // Contract: founder:decide and founder:compose run decide-registry.mjs, which
  // imports these modules and reads decision-axes.yml — a missing file fails
  // the axis resolution.
  for (const rel of REQUIRED_RESOLVER) {
    it(`ships ${rel} (decision registry)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is part of the decision registry and must exist`);
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
      'scripts/lib/hook-helpers.mjs',
      'adapters/claude/hooks/stop.mjs',
      'adapters/codex/hooks/stop.mjs',
    ];
    for (const rel of SOURCES) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      // Contract: Node resolves each static import at load — the parent step
      // sits behind dispatch_target and imports parent-writeback.mjs dynamically
      // only when it is on; founder never writes a parent note
      // (tests/persona-pipeline/test-stop-archive.mjs "no parent writeback
      // ever"). A static import fails the load of a plugin that never receives
      // the module.
      ok(!text.includes("from './parent-writeback.mjs'"),
        `${rel} must not import parent-writeback machinery statically`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/parent-writeback.mjs')), false,
      'plugins/founder must not ship a parent-writeback module at all');
  });

  it('no command shell-reads parent-linkage env (ADR-0036 Non-Goal 3)', async () => {
    // Contract: the agent running a command's shell blocks — a block that reads
    // $AGENTIC_PARENT_WORKFLOW / $AGENTIC_ORIGINATING_SUBTASK carries an
    // orchestrator's linkage into a persona that is no dispatch target (its
    // state.mjs create refuses --parent-workflow/--originating-subtask). Shell
    // reads only: the commands may name the variables in prose to say they do
    // not read them.
    const READ_FORMS = [
      /\$\{?AGENTIC_PARENT_WORKFLOW/,
      /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
    ];
    for (const name of [...VERB_SKILLS, ...MACRO_AND_META]) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
      for (const form of READ_FORMS) {
        ok(!form.test(text),
          `commands/${name}.md must not shell-read ${form} — founder is not an orchestrator dispatch target`);
      }
    }
  });
});

describe('plugins/founder — verb skill and command frontmatter', () => {
  for (const verb of VERB_SKILLS) {
    // Contract: Codex loads the skill by its frontmatter `name` and matches a
    // request against its `description` — a name that differs from the folder,
    // or no description, leaves the skill unreachable.
    it(`${SKILLS_REL}/${verb}/SKILL.md frontmatter name = ${verb} (folder ↔ frontmatter consistency)`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, verb, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `${SKILLS_REL}/${verb}/SKILL.md has no YAML frontmatter`);
      const re = new RegExp(`^name:\\s*${verb}\\s*$`, 'm');
      ok(re.test(fm), `${SKILLS_REL}/${verb}/SKILL.md frontmatter name != "${verb}"`);
      match(fm, /description:/, `${SKILLS_REL}/${verb}/SKILL.md frontmatter must carry a description`);
    });

    // Contract: Codex reads agents/openai.yaml interface.display_name — a
    // missing name lists the skill unnamed, and one that names neither the verb
    // nor the persona cannot be told apart from another persona's verb.
    it(`${SKILLS_REL}/${verb}/agents/openai.yaml display_name names the verb`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, verb, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `${SKILLS_REL}/${verb}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(verb),
        `openai.yaml display_name "${m[1]}" must name the verb "${verb}"`);
      ok(m[1].toLowerCase().includes('founder'),
        `openai.yaml display_name "${m[1]}" must name the persona "founder"`);
    });

    // Contract: Claude Code lists /founder:<verb> with its frontmatter
    // `description` — without one the command is listed blank.
    it(`commands/${verb}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${verb}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, `commands/${verb}.md frontmatter must carry a non-empty description`);
    });
  }
});

describe('plugins/founder — start and meta skill and command frontmatter', () => {
  for (const name of MACRO_AND_META) {
    // Contract: Codex loads the skill by its frontmatter `name` — a name that
    // differs from the folder leaves the skill unreachable.
    it(`${SKILLS_REL}/${name}/SKILL.md frontmatter name = ${name}`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, name, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `${SKILLS_REL}/${name}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(fm),
        `${SKILLS_REL}/${name}/SKILL.md frontmatter name != "${name}"`);
    });

    // Contract: Codex reads agents/openai.yaml interface.display_name — see the
    // verb skills above.
    it(`${SKILLS_REL}/${name}/agents/openai.yaml display_name names the skill + persona`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, name, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `${SKILLS_REL}/${name}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(name),
        `openai.yaml display_name "${m[1]}" must name the skill "${name}"`);
      ok(m[1].toLowerCase().includes('founder'),
        `openai.yaml display_name "${m[1]}" must name the persona "founder"`);
    });

    // Contract: Claude Code lists /founder:<name> with its frontmatter
    // `description` — without one the command is listed blank.
    it(`commands/${name}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${name}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, `commands/${name}.md must carry a non-empty description`);
    });
  }
});

// The privacy gates generated from the persona pipeline (the verb and start
// runbooks, the critique/refine/start skills, the ensemble protocol and the
// brief ensemble) are checked for every persona under tests/persona-pipeline/;
// these are the ones founder authors itself. peer-now's command gate is
// founder's own text, outside every generated region: the pipeline suite checks
// only where its label sits.
describe('plugins/founder — founder-authored privacy gates (ADR-0036 SD4)', () => {
  // Either wording: founder's own, or the pipeline's canonical one if the file
  // is generated later.
  const PRIVACY_GATE = /pass an explicit (?:privacy )?gate before BOTH web search AND peer-host dispatch/;
  const PROHIBITION = /\b[Tt]he pre-genericization value MUST never leave the local host/;
  const SPEC = `${SKILLS_REL}/investigate/references/business-brief-spec.md`;
  const SPEC_PROHIBITION = /Anything proprietary is genericized[\s\S]{0,200}? or removed\. Only the genericized form leaves the local host\./;

  it('the brief spec, the investigate, frame and peer-now skills and the peer-now command gate web search and peer dispatch', async () => {
    // Contract: the agent about to run a web search or dispatch the peer — it
    // stops at this gate to genericize, and the raw value never leaves the
    // host; a surface without the gate or its prohibition sends raw venture
    // material out (commands/peer-now.md sends a verbatim prompt). Rejects
    // "may be sent to the peer host as written" in place of either sentence.
    // business-brief-spec.md is also the declared privacy_spec every generated
    // gate cites (persona.json peer.privacy_spec); it words the prohibition as
    // how the gate is satisfied.
    for (const rel of [
      SPEC,
      `${SKILLS_REL}/investigate/SKILL.md`,
      `${SKILLS_REL}/frame/SKILL.md`,
      `${SKILLS_REL}/peer-now/SKILL.md`,
      'commands/peer-now.md',
    ]) {
      const text = normalizeWhitespace((await readFile(resolve(PLUGIN_ROOT, rel), 'utf8')).replaceAll('**', ''));
      ok(PRIVACY_GATE.test(text), `${rel} must state the privacy gate before web search and peer-host dispatch`);
      ok((rel === SPEC ? SPEC_PROHIBITION : PROHIBITION).test(text),
        `${rel} must state that only the genericized form leaves the local host`);
    }
  });
});

describe('plugins/founder — runbook instructions no shared suite pins', () => {
  it('refine\'s create passes no --profile (single-mode); critique\'s, the control, does', async () => {
    // Contract: state.mjs create --profile — refine is single-mode like frame
    // and decide; a forwarded --profile records whatever profile the shell
    // inherited on a workflow whose verb has none.
    const refine = createCalls(await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8'));
    strictEqual(refine.length, 1, 'commands/refine.md makes one state.mjs create call');
    ok(!/--profile\b/.test(refine[0]),
      `commands/refine.md must not pass --profile in its state.mjs create call:\n${refine[0]}`);
    // Control: the extractor reaches the flag lines of a create that passes one.
    const critique = createCalls(await readFile(resolve(PLUGIN_ROOT, 'commands/critique.md'), 'utf8'));
    ok(critique.length === 1 && /--profile\b/.test(critique[0]), 'control: critique\'s create passes --profile');
  });

  it('peer-now command runs the dispatch synchronously (no run_in_background race)', async () => {
    // Contract: the agent running /founder:peer-now — the block reads RUN_RC and
    // the response right after the runner; told to background the call, the
    // agent reads them before the runner exits and reports no answer.
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/peer-now.md'), 'utf8');
    ok(!/run_in_background:\s*true/.test(cmd),
      'commands/peer-now.md must not background the dispatch — it reads the response immediately');
  });

  // Contract: the agent following the session-handoff runbook resolves the paths
  // it names inside the installed founder plugin — a path into another plugin
  // (engineer's contract, above all) breaks where that plugin is not installed
  // beside it (ADR-0010 §5). The citation checks skip plugins/ paths and
  // kit/lint checks only that a path exists, so a runbook line pointing at
  // plugins/engineer/... would pass both in this repository. Rejects a path
  // that lands in a sibling as plugins/<sibling>/ or ../<sibling>/
  // (plugins/founder/../<sibling>/ included), with `.` segments and repeated
  // slashes removed.
  it('the session-handoff runbook reaches no other plugin by path', async () => {
    // `.` segments and repeated slashes removed first, so a path that only
    // spells the step into a sibling differently is read as the same step.
    const text = (await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/session-handoff.md'), 'utf8'))
      .replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');
    const siblings = (await readdir(resolve(REPO_ROOT, 'plugins'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== 'founder').map((d) => d.name);
    ok(siblings.includes('engineer') && siblings.length >= 5, `expected the sibling plugins to be listed (got ${siblings.join(', ')})`);
    const crossPlugin = new RegExp(`(?:^|[^\\w.-])(?:plugins/|(?:\\.\\./)+)(?:${siblings.join('|')})/`, 'm');
    const hit = crossPlugin.exec(text);
    ok(!hit, `the runbook must not reach another plugin by path: ${hit?.[0]}`);
  });

  it('the verb and start commands and skills leave the completion footer to the terminal write', async () => {
    const surfaces = [
      ...[...VERB_SKILLS, 'start'].map((name) => `commands/${name}.md`),
      ...[...VERB_SKILLS, 'start'].map((name) => `${SKILLS_REL}/${name}/SKILL.md`),
    ];
    for (const rel of surfaces) {
      const text = normalizeWhitespace((await readFile(resolve(PLUGIN_ROOT, rel), 'utf8')).replaceAll('**', ''));
      // Contract: the agent finishing a verb or the lifecycle — the terminal
      // write already prints the code-emitted footer and its session handoff
      // (ADR-0039); an agent not told so hand-composes a second footer whose
      // next step and continue-vs-fresh advice can contradict the emitted one.
      ok(/Do not hand-compose a second footer/.test(text),
        `${rel} must tell the agent not to hand-compose a second completion footer`);
    }
  });
});

// Contract: Claude Code reads the catalog entry to install the plugin — a wrong
// source installs nothing or another directory; the category files the listing.
describe('plugins/founder — Claude marketplace catalog entry', () => {
  const path = resolve(REPO_ROOT, '.claude-plugin/marketplace.json');

  it('exists with source/category aligned to the plugin', async () => {
    const catalog = await readJSON(path);
    const entry = catalog.plugins.find((p) => p.name === 'founder');
    ok(entry, 'Claude catalog must list founder');
    strictEqual(entry.source, './plugins/founder', 'the Claude entry points at the founder package directory');
    strictEqual(entry.category, 'Productivity');
  });
});

// Whether the Codex catalog lists this package, and at which pin, and the
// Claude catalog's version are validate-marketplace's and validate-versions'
// to check (ADR-0065 Decision 8 rule 6). The release job's sync writes them
// after the release commit, so a test reading them would turn that commit
// red; a first release has no Codex entry until the sync adds it.
//
// Contract: Codex reads the entry's policy and category — a different policy
// changes when the plugin installs or authenticates.
describe('plugins/founder — Codex marketplace catalog entry', () => {
  const path = resolve(REPO_ROOT, '.agents/plugins/marketplace.json');

  it('carries the published policy and category (no per-entry description in the Codex schema)', async (t) => {
    const catalog = await readJSON(path);
    const entry = catalog.plugins.find((p) => p.name === 'founder');
    if (entry === undefined) return t.skip('no Codex entry yet; validate-marketplace decides whether one is due');
    deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
    strictEqual(entry.category, 'Productivity');
  });
});

// Contract: release-please reads its manifest and config — an untracked package
// is never released, and a missing extra-file leaves that host's manifest
// version behind the release.
describe('plugins/founder — release-please wiring', () => {
  it('is tracked in .release-please-manifest.json', async () => {
    // Its version's agreement with the plugin manifests is validate-versions' to
    // check (ADR-0065 Decision 8 rule 6); this pins that release-please tracks it.
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(typeof manifest['plugins/founder'], 'string');
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

// ADR-0066 D5 — the hook helpers live in one generated module,
// scripts/lib/hook-helpers.mjs, which both adapters import; no adapter carries
// its own copy, so neither reaches into the other's tree.
describe('plugins/founder — one hook-helper module (ADR-0066 D5)', () => {
  it('carries no adapters/*/hooks/_shared.mjs, and every hook imports scripts/lib/hook-helpers.mjs', async () => {
    for (const host of ['claude', 'codex']) {
      ok(!existsSync(resolve(PLUGIN_ROOT, `adapters/${host}/hooks/_shared.mjs`)),
        `adapters/${host}/hooks/_shared.mjs must be gone: the hooks import scripts/lib/hook-helpers.mjs`);
      for (const hook of ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs']) {
        const text = await readFile(resolve(PLUGIN_ROOT, `adapters/${host}/hooks/${hook}`), 'utf8');
        // Contract: Node resolves each hook's import — a hook importing an
        // adapter-local helper, or not the shared module, loads a copy the
        // pipeline no longer generates.
        ok(text.includes("from '../../../scripts/lib/hook-helpers.mjs'"), `adapters/${host}/hooks/${hook} must import the shared helpers`);
        ok(!text.includes('_shared.mjs'), `adapters/${host}/hooks/${hook} must not import an adapter-local helper`);
      }
    }
  });
});
