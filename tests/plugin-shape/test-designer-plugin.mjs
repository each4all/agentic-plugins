// plugins/designer plugin-shape conformance test.
//
// Checks what a host, a release tool, a script or an agent reads from the
// plugin's committed files:
//   - both manifests, the Claude catalog entry and the release-please
//     registration
//   - the Claude and Codex hooks.json routing, and the scripts and hooks they
//     run (present, executable, importing one helper module)
//   - SKILL.md and command frontmatter, and the agents/openai.yaml field Codex
//     lists each skill by
//   - the decide engine: the 7-axis registry, its fallback and the L4 profile
//     map, run rather than read
//   - the non-dispatch boundary (ADR-0042 Non-Goal 2) and the image boundary
//     (no generation API in code; generated imagery is handed to image:compose)
//   - the instructions that change what the agent runs, with which arguments
//     and when it stops, where the persona-pipeline suite does not hold them
//
// tests/persona-pipeline/ holds the generated runbook, skill and reference
// contracts for every persona, designer included (privacy gate before each
// dispatch, CONVERGED-guarded terminal writes, the start lifecycle, peer-now,
// citation resolution). This file does not restate them.
//
// Run via `node --test tests/plugin-shape/test-designer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/designer');

// Where this plugin's skills actually live, read from its own Codex manifest
// rather than assumed. `resolveSkillsRoot` throws on a broken declaration
// rather than falling back, so this file fails loudly at load instead of
// pointing every path below at a directory nothing writes to. A manifest with
// no `skills` key does fall back, to the README-only `skills/`; the skill
// checks below fail.
const SKILLS_REL = relative(PLUGIN_ROOT, resolveSkillsRoot(PLUGIN_ROOT)).split(sep).join('/');

// The privacy-gate sentence the persona declares (persona.json peer) and the
// screenshot rule designer adds to it (ADR-0042 SD4). Checked
// whitespace-normalized so markdown line-wrapping does not break the match.
const PRIVACY_SENTINEL =
  'pass an explicit privacy gate before BOTH web search AND peer-host dispatch';
const SCREENSHOT_SENTINEL = 'screenshots are sensitive by default';

const ALL_VERB_SKILLS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const META_SKILLS = ['checkpoint', 'resume', 'peer-now'];
const START_AND_META = ['start', ...META_SKILLS];
const ALL_SKILLS = [...ALL_VERB_SKILLS, ...START_AND_META];
const ALL_COMMANDS = ALL_SKILLS;

// ADR-0042 SD6 — the L4 archetype → SD3 decision-preset map. Duplicated here on
// purpose: the test declares the contract and decide-registry.mjs must match it,
// so a silent edit to the map's single source of truth fails loudly.
const EXPECTED_PROFILE_PRESET_MAP = {
  general: 'balanced',
  flow: 'balanced',
  ui: 'experience',
  cta: 'conversion',
  content: 'clarity',
};

// ADR-0042 SD5 — designer composes the image L2 capability and never implements
// generation. Mirrors the plugins/image direct-OpenAI-API-ban sentinel
// (ADR-0037 Alternative 6): prose (.md/.yaml) legitimately describes the ban,
// so only code/shell files are scanned for actual call forms.
const DIRECT_API_FORMS = [
  /\bimages\s*\.\s*(generate|edit|createVariation)\s*\(/,
  /api\.openai\.com/,
  /\bnew\s+OpenAI\b/,
  /\bOPENAI_API_KEY\b/,
  /from\s+['"]openai['"]/,
  /require\(\s*['"]openai['"]\s*\)/,
];

// Shell and process.env READS of the parent-linkage env (prose mentions in
// backticks stay legal).
const PARENT_LINKAGE_READS = [
  /\$\{?AGENTIC_PARENT_WORKFLOW/,
  /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
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

async function decideRegistry() {
  return import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
}

// A convergence loop's bound and what the agent does past it, as one
// instruction: the cap, then, in the sentence after it, the stop and the
// pause ("stop and pause", "STOP: pause", "STOP looping: set `CONVERGED=no`,
// PAUSE"). A bare /hard cap/ also matches the refine skill's anti-pattern
// bullet, and a bare /stop/ matches "do not stop" or "stop only after
// convergence", so neither held the instruction.
const BOUND_THEN_STOP = /\(default 2(?: passes)?, hard cap 3\)[.;] if findings (?:still )?do not converge\b[\s\S]{0,160}?(?<!\bnot )\bstop(?: and|:| looping:) (?:set `CONVERGED=no`, )?pause\b/gi;

function boundThenStop(text) {
  return [...normalizeWhitespace(text.replaceAll('**', '')).matchAll(BOUND_THEN_STOP)].map((m) => m[0]);
}

// Contract: Claude Code reads .claude-plugin/plugin.json to install and list the
// plugin — a missing or mistyped field breaks install or the listing.
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
// what it loads, `interface` is what it lists; a wrong path loads nothing.
describe('plugins/designer — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  // Its version is validate-versions' to check (ADR-0065 Decision 8 rule 6).
  it('parses as JSON with the required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'designer');
    strictEqual(typeof json.description, 'string');
  });

  it('declares the hooks and skills paths and the interface block', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json');
    strictEqual(json.skills, './core/skills/');
    ok(json.interface && typeof json.interface === 'object', 'the Codex manifest must carry an interface block');
    strictEqual(json.interface.displayName, 'Designer');
    strictEqual(json.interface.category, 'Development',
      'the Codex interface category must match the designer marketplace category (Development)');
    ok(Array.isArray(json.interface.defaultPrompt) && json.interface.defaultPrompt.length > 0,
      'the Codex interface must carry a non-empty defaultPrompt list');
  });

  // Contract: Codex offers defaultPrompt entries as starter prompts — an entry
  // naming a skill the plugin does not ship sends the user to nothing.
  it('every $designer:<skill> a defaultPrompt names is a shipped skill', async () => {
    const json = await readJSON(path);
    // The whole token: `$designer:compose2` must read as compose2, not compose.
    const named = [...json.interface.defaultPrompt.join('\n').matchAll(/\$designer:([\w-]+)/g)].map((m) => m[1]);
    ok(named.length > 0, 'the defaultPrompt entries must name at least one $designer: skill');
    for (const skill of named) {
      ok(ALL_SKILLS.includes(skill), `defaultPrompt names $designer:${skill}, which the plugin does not ship`);
    }
  });
});

describe('plugins/designer — scripts, hooks and their routing', () => {
  // Contract: the runbooks and hooks run these files by path, and the scripts
  // import the generated lib modules — a missing file fails the call.
  const REQUIRED_MACHINERY = [
    'scripts/state.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/discover-runtime.mjs',
    'scripts/decide-registry.mjs',
    // ADR-0066 — the declaration and the generated lib modules every script reads.
    'persona.json',
    'scripts/lib/persona.mjs',
    'scripts/lib/cli-entry.mjs',
    'scripts/lib/hook-helpers.mjs',
    'scripts/lib/decide-args.mjs',
    'scripts/lib/decide-weights.mjs',
    'scripts/lib/decide-scores.mjs',
    'scripts/lib/decide-sensitivity.mjs',
    'scripts/lib/yaml-mini.mjs',
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

  // Every machinery script, used by the non-dispatch scans below so the guard
  // cannot pass vacuously on a hand-picked subset.
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
    'scripts/lib/hook-helpers.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
  ];

  for (const rel of REQUIRED_MACHINERY) {
    it(`ships ${rel}`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true, `plugins/designer/${rel} must exist`);
    });
  }

  // Contract: the hooks.json commands and the runbooks execute these files — a
  // cleared executable bit fails the hook or the call.
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

  // Contract: Claude Code reads hooks/hooks.json and runs each command — a
  // missing event never fires, and another persona's path runs its code.
  it('the Claude hooks.json wires the three events with no cross-persona path leakage', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
    const s = JSON.stringify(manifest);
    ok(!s.includes('engineer'), 'no engineer path may leak into the designer Claude hooks.json');
    ok(!/founder/i.test(s), 'no founder path may leak into the designer Claude hooks.json');
  });

  // Contract: Codex reads adapters/codex/hooks/hooks.json and runs each command
  // under ${PLUGIN_ROOT} — CLAUDE_PLUGIN_ROOT is unset there, so a command
  // naming it, or the Claude adapter tree, fails on Codex.
  it('the Codex hooks.json wires the three events through run-node-hook.sh + ${PLUGIN_ROOT}, no cross-persona/host leakage', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/hooks.json'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
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
    ok(!/founder/i.test(s), 'no founder path may leak into the designer Codex hooks.json');
  });

  // Contract: Node resolves each Codex hook's imports — an import from the
  // Claude adapter tree couples the Codex hooks to files Codex never needs.
  it('the Codex hook source files never import from the Claude adapter tree', async () => {
    const CODEX_HOOK_SOURCES = [
      'scripts/lib/hook-helpers.mjs',
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

  // ADR-0042 Non-Goal 2 — designer is not an orchestrator dispatch target.
  // Contract: Node loads these modules — a static import of parent-writeback
  // (generated only where the dispatch_target capability is on) breaks the
  // plugin; the behavior is pinned by tests/persona-pipeline/test-stop-archive.mjs
  // "no parent writeback ever".
  it('the machinery never imports parent-writeback, and ships no parent-writeback or phase7-commit module', async () => {
    for (const rel of [...ALL_SCRIPTS, ...ALL_HOOK_SCRIPTS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/^\s*import\s[^\n(]*from\s*['"][^'"]*parent-writeback/m.test(text),
        `${rel} must not import parent-writeback machinery statically`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/parent-writeback.mjs')), false,
      'plugins/designer must not ship a parent-writeback module at all (non-dispatch)');
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/phase7-commit.mjs')), false,
      'plugins/designer must not ship a phase7-commit driver (non-dispatch — no dispatch-linked auto-commit)');
  });

  // Contract: the scripts and hooks run with the caller's environment — a read
  // of the parent-linkage variables would bind a designer workflow to a macro
  // that never dispatched it (ADR-0042 Non-Goal 2).
  it('the machinery performs no parent-linkage env read (shell or process.env)', async () => {
    const FORBIDDEN_READS = [
      ...PARENT_LINKAGE_READS,
      /process\.env\.AGENTIC_PARENT_WORKFLOW/,
      /process\.env\.AGENTIC_ORIGINATING_SUBTASK/,
    ];
    for (const rel of [...ALL_SCRIPTS, ...ALL_HOOK_SCRIPTS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of FORBIDDEN_READS) {
        ok(!re.test(text), `${rel} must not read ${re} — designer is not an orchestrator dispatch target`);
      }
    }
  });
});

describe('plugins/designer — commands and skills the hosts load', () => {
  // Contract: Claude Code loads commands/<name>.md as /designer:<name>, Codex
  // loads <skills-root>/<name>/SKILL.md and its agents/openai.yaml, and the
  // skills read their references by path — a missing file is a missing
  // command, skill or rule.
  const REQUIRED_SURFACES = [
    ...ALL_COMMANDS.map((c) => `commands/${c}.md`),
    ...ALL_SKILLS.flatMap((s) => [`${SKILLS_REL}/${s}/SKILL.md`, `${SKILLS_REL}/${s}/agents/openai.yaml`]),
    `${SKILLS_REL}/_shared/references/orchestration.md`,
    `${SKILLS_REL}/_shared/references/ensemble-protocol.md`,
    `${SKILLS_REL}/_shared/references/session-handoff.md`,
    `${SKILLS_REL}/_shared/references/entry-routing-contract.md`,
    `${SKILLS_REL}/investigate/references/design-brief-spec.md`,
    `${SKILLS_REL}/investigate/references/design-brief-ensemble.md`,
    `${SKILLS_REL}/investigate/references/output-file-rules.md`,
    `${SKILLS_REL}/critique/references/quality-criteria.md`,
    // decide-registry.mjs resolves the registry at ../core/skills/decide/references/.
    `${SKILLS_REL}/decide/references/decision-axes.yml`,
  ];

  for (const rel of REQUIRED_SURFACES) {
    it(`ships ${rel}`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true, `plugins/designer/${rel} must exist`);
    });
  }

  for (const skill of ALL_SKILLS) {
    // Contract: Codex reads the SKILL.md frontmatter `name` and `description` —
    // a name that differs from the folder, or none, misnames or drops the skill.
    it(`${SKILLS_REL}/${skill}/SKILL.md frontmatter name = ${skill}, with a description`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, skill, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `${SKILLS_REL}/${skill}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(fm),
        `${SKILLS_REL}/${skill}/SKILL.md frontmatter name != "${skill}"`);
      match(fm, /description:/, `${SKILLS_REL}/${skill}/SKILL.md frontmatter must carry a description`);
    });

    // Contract: Codex lists the skill by agents/openai.yaml interface.display_name
    // — a missing name lists it unnamed.
    it(`${SKILLS_REL}/${skill}/agents/openai.yaml display_name names the skill + persona`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, skill, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `${SKILLS_REL}/${skill}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(skill), `openai.yaml display_name "${m[1]}" must name "${skill}"`);
      ok(m[1].toLowerCase().includes('designer'), `openai.yaml display_name "${m[1]}" must name the persona "designer"`);
    });
  }

  for (const command of ALL_COMMANDS) {
    // Contract: Claude Code shows the command frontmatter `description` in its
    // command list — an empty one lists the command with no purpose.
    it(`commands/${command}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${command}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${command}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, `commands/${command}.md frontmatter must carry a non-empty description`);
    });
  }

  // Contract: the agent running a designer command or skill runs its shell
  // blocks — a read of the parent-linkage variables would bind the workflow to a
  // macro that never dispatched it (ADR-0042 Non-Goal 2), and start must never
  // reach the orchestrator's writeback.
  it('no command, skill or shared reference shell-reads the parent-linkage env, and start runs no orchestrator writeback', async () => {
    const files = [
      ...ALL_COMMANDS.map((c) => `commands/${c}.md`),
      ...ALL_SKILLS.map((s) => `${SKILLS_REL}/${s}/SKILL.md`),
      `${SKILLS_REL}/_shared/references/orchestration.md`,
      `${SKILLS_REL}/_shared/references/ensemble-protocol.md`,
    ];
    for (const rel of files) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const form of PARENT_LINKAGE_READS) {
        ok(!form.test(text), `${rel} must not shell-read ${form} — designer is non-dispatch (ADR-0042 Non-Goal 2)`);
      }
    }
    const start = await readFile(resolve(PLUGIN_ROOT, 'commands/start.md'), 'utf8');
    ok(!/parent-writeback|subtask-update/.test(start),
      'commands/start.md must never invoke orchestrator dispatch/writeback machinery');
  });

  // Contract: the Codex agent running a start or meta skill passes --host codex
  // to state.mjs — without it the write is recorded as Claude's.
  for (const skill of START_AND_META) {
    it(`${SKILLS_REL}/${skill}/SKILL.md runs state.mjs with --host codex`, async () => {
      const text = await readFile(skillsPath(PLUGIN_ROOT, skill, 'SKILL.md'), 'utf8');
      ok(/--host codex/.test(text), `${SKILLS_REL}/${skill}/SKILL.md must pass --host codex`);
    });
  }

  // Contract: the agent runs every `state.mjs <subcommand>` a start or meta skill
  // names — a subcommand the CLI does not implement fails the call.
  it('every state.mjs subcommand a start or meta skill names exists', async () => {
    const usage = await readFile(resolve(PLUGIN_ROOT, 'scripts/state.mjs'), 'utf8');
    const implemented = new Set([...usage.matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]));
    ok(implemented.size >= 10, `expected to parse the state.mjs subcommand switch (got ${implemented.size})`);
    let named = 0;
    for (const skill of START_AND_META) {
      const text = await readFile(skillsPath(PLUGIN_ROOT, skill, 'SKILL.md'), 'utf8');
      for (const m of text.matchAll(/state\.mjs\s+([a-z][a-z-]+)/g)) {
        const sub = m[1];
        named += 1;
        ok(implemented.has(sub),
          `${SKILLS_REL}/${skill}/SKILL.md names \`state.mjs ${sub}\`, which scripts/state.mjs does not implement`);
      }
    }
    ok(named >= 6, `the start and meta skills must actually name state.mjs operations (found ${named})`);
  });
});

describe('plugins/designer — decide engine (ADR-0042 SD3/SD6)', () => {
  // Contract: decide-registry.mjs parses decision-axes.yml — a registry that
  // does not load falls back silently to the default preset.
  it('the decide registry loads cleanly (no fallback) with the four design presets', async () => {
    const mod = await decideRegistry();
    const { registry, fallbackTriggered } = mod.loadRegistry({});
    strictEqual(fallbackTriggered, false, 'the real designer registry must load without fallback');
    deepStrictEqual(Object.keys(registry.presets).sort(), ['balanced', 'clarity', 'conversion', 'experience']);
  });

  it('7-axis balanced preset (SD3): usability common-decisive, accessibility the single veto gate, >=2 decisive, axis id "accessibility" NOT "a11y"', async () => {
    const mod = await decideRegistry();
    const { registry } = mod.loadRegistry({});
    strictEqual(registry.presets.balanced.axes.length, 7, 'balanced is the 7-axis matrix');
    for (const pid of Object.keys(registry.presets)) {
      const axes = registry.presets[pid].axes;
      const decisive = axes.filter((a) => a.role === 'decisive').map((a) => a.id);
      ok(decisive.length >= 2, `preset ${pid} must declare >= 2 decisive axes (${decisive.length})`);
      ok(decisive.includes('usability'), `preset ${pid} must carry usability as a decisive axis (common-decisive)`);
      const gates = axes.filter((a) => a.gate).map((a) => a.id);
      deepStrictEqual(gates, ['accessibility'], `preset ${pid} must have exactly one veto gate: accessibility`);
      const acc = axes.find((a) => a.id === 'accessibility');
      strictEqual(acc.role, 'supporting', 'accessibility is role:supporting + gate:true (portable-reader-compatible)');
      ok(!axes.some((a) => a.id === 'a11y'),
        `preset ${pid} must NOT define an "a11y" axis id — a11y is only a profile-flag alias mapped to the accessibility axis`);
    }
  });

  it('the registry defines exactly the seven SD3 axis ids, and the archetype presets trim to five', async () => {
    const mod = await decideRegistry();
    const { registry } = mod.loadRegistry({});
    const axisIds = new Set(Object.values(registry.presets).flatMap((p) => p.axes.map((a) => a.id)));
    deepStrictEqual([...axisIds].sort(),
      ['accessibility', 'consistency', 'content-clarity', 'conversion', 'desirability', 'feasibility', 'usability'],
      'the critique lenses and the decide axes share these seven ids');
    const counts = Object.fromEntries(Object.entries(registry.presets).map(([id, p]) => [id, p.axes.length]));
    deepStrictEqual(counts, { balanced: 7, conversion: 5, experience: 5, clarity: 5 },
      'the shipped axis counts are 7/5/5/5 — if this changes, ADR-0042 SD3\'s table must change with it');
  });

  it('DEFAULT_FALLBACK mirrors the balanced preset (lockstep) — ENOENT resolves to balanced', async () => {
    const mod = await decideRegistry();
    const { registry } = mod.loadRegistry({});
    const shape = (axes) => axes.map((a) => ({ id: a.id, role: a.role, gate: a.gate }));
    const balanced = shape(registry.presets.balanced.axes);
    const fb = mod.resolvePreset({ path: '/nonexistent/decision-axes.yml' });
    strictEqual(fb.fallbackTriggered, true);
    strictEqual(fb.context.preset_id, 'balanced');
    deepStrictEqual(shape(fb.context.axes), balanced,
      'DEFAULT_FALLBACK must mirror the balanced preset — keep the two in lockstep');
  });

  it('every registry preset is a defined map with a description and a non-empty axis list', async () => {
    const mod = await decideRegistry();
    const { registry } = mod.loadRegistry({});
    for (const pid of Object.keys(registry.presets)) {
      const p = registry.presets[pid];
      strictEqual(typeof p.description, 'string');
      ok(p.description.length > 0, `preset ${pid} must carry a description`);
      ok(Array.isArray(p.axes) && p.axes.length > 0, `preset ${pid} must carry a non-empty axis list`);
    }
  });

  it('every L4 profile resolves to a preset the SD3 registry defines, with the veto gate intact', async () => {
    const mod = await decideRegistry();
    const { registry } = mod.loadRegistry({});
    const map = mod.profilePresetMap();
    ok(map, 'decide-registry.mjs must expose the declared L4 map (the §1.5(3) profile slot; profile_presets on)');
    deepStrictEqual({ ...map }, EXPECTED_PROFILE_PRESET_MAP,
      'the shipped L4 profile → preset map must match the ADR-0042 SD6 contract');
    for (const [profile, presetId] of Object.entries(map)) {
      ok(Object.hasOwn(registry.presets, presetId),
        `L4 profile "${profile}" maps to preset "${presetId}", which decision-axes.yml does not define`);
      const { context, fallbackTriggered } = mod.resolvePreset({ profileOverride: profile });
      strictEqual(fallbackTriggered, false, `resolving L4 profile "${profile}" must not trigger the registry fallback`);
      strictEqual(context.preset_id, presetId, `L4 profile "${profile}" must resolve preset "${presetId}"`);
      deepStrictEqual(context.axes.filter((a) => a.gate).map((a) => a.id), ['accessibility'],
        `L4 profile "${profile}" must keep accessibility as the single veto gate`);
    }
  });

  it('the resolver reports an archetype that changed the preset, and an explicit --size that dropped it', async () => {
    const mod = await decideRegistry();
    const viaProfile = mod.resolvePreset({ profileOverride: 'cta' });
    ok(viaProfile.diagnostics.some((d) => d.includes('L4 profile "cta" (AGENTIC_DESIGNER_PROFILE) resolved preset "conversion"')),
      'decide-registry.mjs must emit a provenance diagnostic when an archetype changes the resolved preset');
    const viaSize = mod.resolvePreset({ profileOverride: 'cta', sizeExplicit: true, sizeValue: 'minor' });
    ok(viaSize.diagnostics.some((d) => d.includes('outranks the L4 profile')),
      'decide-registry.mjs must warn when an explicit --size silently drops the archetype');
  });

  // The L4 archetype is ambient context (AGENTIC_DESIGNER_PROFILE), never a
  // decide flag: decide's grammar rejects --profile.
  it('decide\'s argument parser rejects --profile and accepts its own flags', async () => {
    const { parseArgs } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/lib/decide-args.mjs')).href);
    ok(parseArgs(['--profile=cta']).errors.length > 0, '--profile=<x> must be an unknown decide flag');
    deepStrictEqual(parseArgs(['--size=minor']).errors, [], '--size is a decide flag');
  });
});

describe('plugins/designer — what the runbooks run, with which arguments', () => {
  // Contract: state.mjs create/append record --profile as the workflow's skill
  // profile — investigate, compose and critique carry one (create forwards
  // AGENTIC_PROFILE; compose and critique keep it on resume); frame, decide,
  // refine and start are single-mode, so a --profile there records a profile
  // the verb does not have.
  const FORWARDS = { investigate: { create: true, resume: false }, compose: { create: true, resume: true }, critique: { create: true, resume: true } };
  for (const command of ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine', 'start']) {
    it(`commands/${command}.md ${FORWARDS[command] ? 'forwards' : 'passes no'} --profile`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${command}.md`), 'utf8');
      const spec = FORWARDS[command];
      if (!spec) {
        ok(!/--profile(=|\s+["'$])/.test(text), `commands/${command}.md must not pass a --profile flag in any form`);
        return;
      }
      ok(/state\.mjs" create[\s\S]*?--profile\s+"\$\{?AGENTIC_PROFILE/.test(text),
        `commands/${command}.md create path must forward --profile from AGENTIC_PROFILE`);
      if (spec.resume) {
        ok(/--profile\s+"<profile/.test(text), `commands/${command}.md append/resume path must carry --profile`);
      }
    });
  }

  // Repo-wide, non-vacuous: collect every peer-runner dispatch block across the
  // designer surface (start.md delegates and dispatches none of its own, so a
  // per-file `if (dispatch)` guard would pass vacuously there).
  // Contract: the agent runs these dispatch blocks — `--image` would send image
  // bytes down a companion path that has no image channel (persona.json
  // peer.images false), and each verb's block names the ensemble type the run
  // ledger and settle record.
  it('no designer surface dispatches the peer with --image, and each verb command dispatches its own ensemble type', async () => {
    const DISPATCH_RE = /node "[^"]*peer-runner\.mjs" run[\s\S]*?(?:\n\n|&\n)/g;
    const surfaces = [
      ...ALL_COMMANDS.map((c) => `commands/${c}.md`),
      ...ALL_SKILLS.map((s) => `${SKILLS_REL}/${s}/SKILL.md`),
    ];
    // A generated runbook region assigns the type as a single-quoted literal
    // (ADR-0066 Decision 4) and the runner names it through ENSEMBLE_TYPE
    // (PC2b U5a), so a site may name the variable: it reads the assignment.
    const TYPE_RE = /--ensemble-type\s+(?:'?([a-z-]+)'?|"\$ENSEMBLE_TYPE")/g;
    const ASSIGNED_RE = /^ENSEMBLE_TYPE='([a-z-]+)'$/gm;
    const COMMAND_TYPES = {
      investigate: 'reference-scan', frame: 'frame', decide: 'brainstorm',
      compose: 'plan-verify', critique: 'review', refine: 'refine-verify',
    };
    let blocks = 0;
    const withImage = [];
    for (const rel of surfaces) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      const own = [];
      const assigned = [...text.matchAll(ASSIGNED_RE)].map((a) => a[1]);
      for (const m of text.matchAll(DISPATCH_RE)) {
        blocks += 1;
        if (/--image/.test(m[0])) withImage.push(rel);
        for (const t of m[0].matchAll(TYPE_RE)) own.push(...(t[1] ? [t[1]] : assigned));
      }
      const verb = /^commands\/([a-z-]+)\.md$/.exec(rel)?.[1];
      if (Object.hasOwn(COMMAND_TYPES, verb)) {
        deepStrictEqual([...new Set(own)], [COMMAND_TYPES[verb]], `${rel}: the ensemble type its peer-runner dispatch names`);
      }
    }
    ok(blocks >= 6, `expected the shipped peer-runner dispatch blocks to be found (got ${blocks}) — the scan must not pass vacuously`);
    deepStrictEqual(withImage, [],
      `the companion peer path has no image channel — these dispatches pass --image: ${withImage.join(', ')}`);
  });

  // Contract: the agent judging a screen on Codex runs `codex exec --image` on
  // the active host — vision is host-direct, never a peer capability; without the
  // named call the Codex-side critique has no way to see the screen.
  it('critique names the host-direct vision call on Codex', async () => {
    for (const rel of [`${SKILLS_REL}/critique/SKILL.md`, 'commands/critique.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /codex exec --image/, `${rel} must name codex exec --image as the host-direct vision call`);
    }
  });

  // Contract: the agent writing a web search query or a peer prompt stops at the
  // privacy gate first (ADR-0042 SD4) — a surface without it lets proprietary UI
  // or a screenshot leave the host. The persona-pipeline suite holds the gate in
  // the verb and start runbooks, the critique/refine/start skills and the shared
  // ensemble references; these are the surfaces it does not cover.
  it('the privacy gate and the screenshot rule reach the dispatching surfaces the pipeline suite does not cover', async () => {
    const decl = await readJSON(resolve(PLUGIN_ROOT, 'persona.json'));
    const surfaces = [
      `${SKILLS_REL}/investigate/SKILL.md`,
      `${SKILLS_REL}/frame/SKILL.md`,
      `${SKILLS_REL}/decide/SKILL.md`,
      `${SKILLS_REL}/compose/SKILL.md`,
      `${SKILLS_REL}/peer-now/SKILL.md`,
      'commands/peer-now.md',
      // the spec every gate cites (persona.json peer.privacy_spec)
      decl.peer.privacy_spec,
    ];
    for (const rel of surfaces) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL), `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
      ok(text.toLowerCase().includes(SCREENSHOT_SENTINEL),
        `${rel} must carry the "screenshots are sensitive by default" rule (ADR-0042 SD4)`);
    }
  });

  // Contract: the agent running investigate — WebSearch covers the four
  // URL-bearing tiers; user research is supplied locally, so searching for it
  // sends the product's own research topic out.
  it('investigate scopes web search to the four URL-bearing tiers, never user research', async () => {
    const text = await readFile(skillsPath(PLUGIN_ROOT, 'investigate/SKILL.md'), 'utf8');
    match(text, /four URL-bearing tiers/i,
      'investigate SKILL must scope WebSearch to the four URL-bearing tiers, excluding user-research');
    match(text, /never web-searched|not web-searched/i,
      'investigate SKILL must state user-research is a local-only supplied stream, never web-searched');
  });

  // Contract: the agent producing generated imagery hands it to image:compose
  // (ADR-0042 SD5, ADR-0037 Alternative 6) — without the handoff it generates
  // the image itself or calls an image API directly.
  it('the composing surfaces hand generated imagery to image:compose and never generate it', async () => {
    for (const rel of [`${SKILLS_REL}/start/SKILL.md`, 'commands/start.md', `${SKILLS_REL}/compose/SKILL.md`, 'commands/compose.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /image:compose/, `${rel} must name the image:compose handoff for generated imagery`);
      match(text, /never (drawn|draws|implements|implement|re-implements)/i,
        `${rel} must state designer never generates imagery itself`);
    }
  });

  // Contract: no designer code calls an image generation API — the plugin
  // composes the image L2 capability (ADR-0042 SD5, ADR-0037 Alternative 6).
  it('no designer code file calls an image generation API (direct-OpenAI-API-ban sentinel)', async () => {
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
      `designer composes the image L2 capability and never implements generation — no direct image-API calls:\n  ${offenders.join('\n  ')}`);
  });

  it('the verb and start commands and skills leave the completion footer to the terminal write', async () => {
    const surfaces = [
      ...[...ALL_VERB_SKILLS, 'start'].map((name) => `commands/${name}.md`),
      ...[...ALL_VERB_SKILLS, 'start'].map((name) => `${SKILLS_REL}/${name}/SKILL.md`),
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

  // Contract: the agent following the session-handoff runbook resolves the paths
  // it names inside the installed designer plugin — a path into another plugin
  // (engineer's contract, above all) breaks where that plugin is not installed
  // beside it (ADR-0010 §5). Rejects a path that lands in a sibling as
  // plugins/<sibling>/ or ../<sibling>/ (plugins/designer/../<sibling>/
  // included), with `.` segments and repeated slashes removed.
  it('the session-handoff runbook reaches no other plugin by path', async () => {
    // `.` segments and repeated slashes removed first, so a path that only
    // spells the step into a sibling differently is read as the same step.
    const text = (await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/session-handoff.md'), 'utf8'))
      .replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');
    const siblings = (await readdir(resolve(REPO_ROOT, 'plugins'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== 'designer').map((d) => d.name);
    ok(siblings.includes('engineer') && siblings.length >= 5, `expected the sibling plugins to be listed (got ${siblings.join(', ')})`);
    const crossPlugin = new RegExp(`(?:^|[^\\w.-])(?:plugins/|(?:\\.\\./)+)(?:${siblings.join('|')})/`, 'm');
    const hit = crossPlugin.exec(text);
    ok(!hit, `the runbook must not reach another plugin by path: ${hit?.[0]}`);
  });

  // Contract: whoever rolls the footer path back follows this order and cleanup
  // — runtime first leaves persona sidecars firing into a runtime that rejects
  // them, and a cleanup without the wildcard leaves the rendered-marker
  // tombstone, so a re-enable surfaces a pre-rollback handoff as current. The
  // note is the generated handoff-recipe region (persona-pipeline/regions/
  // handoff-recipe.md), so a template change reaches every persona and fails here.
  it('the session-handoff rollback note keeps its order and its wildcard cleanup', async () => {
    const text = await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/session-handoff.md'), 'utf8');
    ok(/personas first, runtime second/.test(text), 'the rollback order must stay personas first, runtime second');
    ok(text.includes('.agentic-plugins/state/designer/last-session-handoff.json*'),
      'the rollback cleanup must name the wildcard covering the projection and its marker');
  });
});

describe('plugins/designer — when the agent stops (gates and convergence)', () => {
  // Contract: the agent running the start lifecycle stops for the user's
  // approval of the direction and of the spec, caps its Phase 4 refine loop and
  // stops past the cap, and runs no frontend build — without these it composes
  // a direction nobody chose, loops without bound, or runs a build it does not
  // own. The skill (Codex's runbook) states the cap and the STOP in one
  // instruction; the command's lifecycle list states the cap and the pause.
  // Rejects "loop until findings converge" in place of either.
  it('the start SKILL waits for approval of the direction, then the spec, and bounds its refine loop without a build', async () => {
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'start/SKILL.md'), 'utf8');
    match(skill, /Do not proceed to Phase 2 until the user approves a direction/i,
      'start SKILL must gate Phase 2 on direction approval');
    match(skill, /Do not proceed to Phase 3 until the user approves the spec/i,
      'start SKILL must gate Phase 3 on spec approval');
    strictEqual(boundThenStop(skill).length, 1,
      'start SKILL must cap the Phase 4 loop (default 2 passes, hard cap 3) and STOP when findings do not converge');
    ok(/does (\*\*)?not(\*\*)? run the (frontend )?build/i.test(normalizeWhitespace(skill).replaceAll('**', '')),
      'start SKILL must state designer does not run the frontend build (the re-render is host-supplied)');
    const cmd = normalizeWhitespace((await readFile(resolve(PLUGIN_ROOT, 'commands/start.md'), 'utf8')).replaceAll('**', ''));
    match(cmd, /\(default 2 passes, hard cap 3\)[\s\S]{0,400}?Non-convergence pauses and routes to the owner/,
      'commands/start.md must cap the Phase 4 loop and pause on non-convergence');
  });

  // Contract: the agent recommending a direction reads the accessibility gate
  // verdict — CANDIDATE-FAIL vetoes it, and CONDITIONAL may be recommended only
  // with its remediation named as a blocking precondition. Rejects a veto
  // dropped (a barrier-bearing direction is approved) and a CONDITIONAL
  // recommended with no precondition (its remediation never blocks the build).
  it('the start approval gate offers the four gate verdicts, makes a CONDITIONAL remediation blocking and keeps CANDIDATE-FAIL a veto', async () => {
    const start = normalizeWhitespace((await readFile(skillsPath(PLUGIN_ROOT, 'start/SKILL.md'), 'utf8')).replaceAll('**', ''));
    match(start, /PASS \/ CONDITIONAL \/ CANDIDATE-FAIL \/ UNKNOWN/,
      'the direction-approval prompt must carry the same four verdicts the peer contract offers');
    match(start, /A CONDITIONAL direction may be recommended, but only with its remediation named as a blocking precondition\b/,
      'the start macro must recommend a CONDITIONAL direction only with its remediation as a blocking precondition');
    match(start, /A CANDIDATE-FAIL direction vetoes/,
      'the start macro must keep CANDIDATE-FAIL as a veto');
  });

  // Contract: the decide synthesis maps the Brainstorm peer's gate verdict —
  // the peer must be offered CONDITIONAL, a peer CONDITIONAL adds its
  // remediation to the direction's preconditions, and a disagreement resolves
  // to the stricter verdict. Rejects a peer PASS overriding a local barrier,
  // and a peer CONDITIONAL whose remediation is dropped from the preconditions.
  it('the Brainstorm peer contract offers CONDITIONAL, maps it to preconditions, and a gate disagreement keeps the stricter verdict', async () => {
    const proto = normalizeWhitespace((await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/ensemble-protocol.md'), 'utf8')).replaceAll('**', ''));
    match(proto, /gate verdict for the direction: PASS \/ CONDITIONAL \/ CANDIDATE-FAIL \/ UNKNOWN/,
      'Brainstorm structured_output_contract must offer the peer a CONDITIONAL verdict');
    match(proto, /a peer `CONDITIONAL` adds its named remediation to the direction's preconditions \(it does not veto\)/,
      'synthesis must add a peer CONDITIONAL\'s remediation to the direction\'s preconditions');
    match(proto, /the stricter verdict holds/,
      'synthesis must resolve a gate-verdict disagreement toward the stricter verdict');
  });

  // Contract: the agent writing decide's recommendation applies the
  // accessibility veto itself — recommendByAggregate is advisory, so only this
  // instruction keeps a FAIL direction out of the recommendation. Rejects an
  // edit that lets a weight (accessibility:0 included) waive the veto.
  it('decide applies the accessibility veto regardless of any weight', async () => {
    const skill = normalizeWhitespace((await readFile(skillsPath(PLUGIN_ROOT, 'decide/SKILL.md'), 'utf8')).replaceAll('**', ''));
    match(skill, /A gate FAIL vetoes regardless of the aggregate/,
      'decide SKILL must state that a gate FAIL vetoes regardless of the aggregate');
    match(skill, /no weight \(including `accessibility:0`\) can remove, soften, or strengthen the veto/,
      'decide SKILL must state that no weight value waives the veto');
  });

  // Contract: the agent at a command-mode phase boundary dispatches the peer
  // whatever the Design Task Profile's Ensemble Affinity reads (always-max).
  // Rejects "skip the peer when affinity is LOW", or "only HIGH-affinity phase
  // boundaries" dispatching, in place of these sentences: the agent then drops
  // the peer review on the decisions it rated low.
  it('Ensemble Affinity never gates the peer dispatch (always-max)', async () => {
    const orch = normalizeWhitespace((await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/orchestration.md'), 'utf8')).replaceAll('**', ''));
    match(orch, /Ensemble Affinity: LOW \/ MEDIUM \/ HIGH\. Recorded for context; NOT a dispatch gate/,
      'orchestration.md must state that Ensemble Affinity is not a dispatch gate');
    const proto = normalizeWhitespace((await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/ensemble-protocol.md'), 'utf8')).replaceAll('**', ''));
    match(proto, /Every phase boundary in `?\/designer:\*`? commands automatically dispatches the peer ensemble\. There is no `LOW` skip\./,
      'ensemble-protocol.md must dispatch the peer at every phase boundary, with no LOW skip');
  });

  // Contract: under autopilot only CRITICAL and MAJOR findings are carried into
  // refine — an unmitigated veto gate graded lower is never fixed.
  it('critique grades an unmitigated accessibility veto gate CRITICAL', async () => {
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'critique/SKILL.md'), 'utf8');
    match(skill, /unmitigated[\s\S]{0,160}?CRITICAL/i,
      'critique SKILL must state that an unmitigated accessibility veto gate is CRITICAL by definition');
  });

  // Contract: the agent running refine stops the loop after a bounded number of
  // passes, does not run the frontend build (skill and command), flags an
  // unseen re-render UNVERIFIED, and converges on PASS or CONDITIONAL but never
  // on FAIL. Without these it loops without bound, runs a build it does not
  // own, or closes on an unverified or vetoed design. The bound is pinned with
  // the stop that follows it: in the command (Claude's runbook), where the stop
  // sets CONVERGED=no, which keeps the finalize block from its terminal write
  // (test-runbook-contracts.mjs EXTENSION_ANCHORS pins only the heading and the
  // UNVERIFIED sentence); and in both of the skill's loops (Codex's runbook),
  // the in-context one and the command-mode one. Rejects "loop until findings
  // converge" in place of any of the three.
  it('refine bounds the loop, runs no build, and converges on PASS or CONDITIONAL, never FAIL', async () => {
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'refine/SKILL.md'), 'utf8');
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    strictEqual(boundThenStop(skill).length, 2,
      'refine SKILL must cap both convergence loops (default 2, hard cap 3) and stop when findings do not converge');
    strictEqual(boundThenStop(cmd).length, 1,
      'commands/refine.md must cap the loop (default 2, hard cap 3) and STOP when findings do not converge');
    match(normalizeWhitespace(cmd.replaceAll('**', '')), /\(default 2, hard cap 3\)\. If findings still do not converge[\s\S]{0,160}?STOP looping: set `CONVERGED=no`, PAUSE/,
      'commands/refine.md must set CONVERGED=no and pause when the bound is reached');
    for (const [rel, text] of [['refine SKILL', skill], ['commands/refine.md', cmd]]) {
      ok(/does (\*\*)?not(\*\*)? run the (frontend )?build/i.test(normalizeWhitespace(text)),
        `${rel} must state designer does not run the frontend build (the re-rendered screen is host-supplied)`);
    }
    match(skill, /UNVERIFIED/, 'refine SKILL must flag the vision re-critique UNVERIFIED when the re-render is unavailable');
    match(skill, /`CONDITIONAL` converges \*\*on purpose\*\*/,
      'the predicate must state that CONDITIONAL converges deliberately');
    match(skill, /What does \*\*not\*\* converge: a `FAIL` gate/,
      'the predicate must keep FAIL non-converging — the veto survives the widening');
  });

  // Contract: every surface the agent reads the convergence rule from — the
  // commands, the skills and the Codex agents/openai.yaml default_prompt Codex
  // starts the skill with — converges on a gate that is not FAIL; one that
  // requires PASS never lets a correct CONDITIONAL design converge.
  // Resolved roots, each with a floor on what it opened: a root resolving to a
  // tombstone or the wrong directory would otherwise report no offenders.
  it('no command, skill or Codex agent yaml requires a PASS gate to converge', async () => {
    const SURFACE_EXTS = ['.md', '.yaml', '.yml'];
    const SURFACE_ROOTS = [resolve(PLUGIN_ROOT, 'commands'), resolveSkillsRoot(PLUGIN_ROOT)];
    strictEqual(new Set(SURFACE_ROOTS.map(String)).size, SURFACE_ROOTS.length, 'the surface roots must be distinct');
    const offenders = [];
    for (const root of SURFACE_ROOTS) {
      let opened = 0;
      for (const ent of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!ent.isFile() || !SURFACE_EXTS.some((e) => ent.name.endsWith(e))) continue;
        const full = resolve(ent.parentPath ?? ent.path, ent.name);
        const rel = full.slice(PLUGIN_ROOT.length + 1);
        opened += 1;
        const text = await readFile(full, 'utf8');
        if (/converge[^.]{0,80}\bgate (?:PASSES|passes)\b/i.test(text)) offenders.push(`${rel} :: convergence requires gate PASS`);
        if (/gate PASS —/.test(text)) offenders.push(`${rel} :: "gate PASS —" as the clean-result example`);
      }
      ok(opened >= 10, `surface root ${root.slice(PLUGIN_ROOT.length + 1)} opened only ${opened} surface files`);
    }
    deepStrictEqual(offenders, [], `convergence must be "gate not FAIL" on every surface:\n  ${offenders.join('\n  ')}`);
  });

  // Contract: the Codex agent running the start skill carries the L4 archetype
  // into the resolve call as an inline prefix, the environment decide-registry.mjs
  // reads (the command's copy is held by test-runbook-contracts.mjs
  // EXTENSION_ANCHORS) — an export in an earlier Bash call is gone by then.
  it('the start SKILL carries the archetype inline on the resolve call', async () => {
    const text = normalizeWhitespace(await readFile(skillsPath(PLUGIN_ROOT, 'start/SKILL.md'), 'utf8'));
    match(text, /AGENTIC_DESIGNER_PROFILE="[^"]*" \\? ?node/,
      'start SKILL must show the inline-prefix form that carries the archetype into the resolve call');
  });
});

describe('plugins/designer — inert boundary (persona directories never ship)', () => {
  const FORBIDDEN_DIRS = [
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  // ADR-0006's 2026-09-18 Amendment restates these categories under `core/`, so
  // each is forbidden there too — checking the plugin root alone passes on a
  // `core/personas/` by matching nothing.
  for (const dir of FORBIDDEN_DIRS) {
    for (const rel of [dir, `core/${dir}`]) {
      it(`has no ${rel}/ directory (not part of the designer surface)`, async () => {
        strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), false,
          `plugins/designer/${rel}/ must not exist — it is not part of the designer surface`);
      });
    }
  }
});

// Whether the Codex catalog lists this package, and at which pin, and the
// Claude catalog's version are validate-marketplace's and validate-versions'
// to check (ADR-0065 Decision 8 rule 6). The release job's sync writes them
// after the release commit, so a test reading them would turn that commit
// red; a first release has no Codex entry until the sync adds it.
// Contract: Claude Code installs the plugin from the catalog entry's `source`
// — a wrong path installs nothing.
describe('plugins/designer — marketplace catalog wiring', () => {
  it('the Claude catalog carries a designer entry resolving to the plugin dir', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .claude-plugin/marketplace.json');
    strictEqual(entry.source, './plugins/designer');
  });
});

// Contract: release-please reads these entries — a missing package or
// extra-file leaves the plugin unreleased or its manifests' versions stale.
describe('plugins/designer — release-please wiring', () => {
  it('release-please-config.json declares the plugins/designer package with both-manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages['plugins/designer'];
    ok(pkg, 'release-please-config.json must declare the plugins/designer package');
    strictEqual(pkg['package-name'], 'plugin-designer');
    const paths = (pkg['extra-files'] || []).map((f) => f.path);
    ok(paths.includes('.claude-plugin/plugin.json'), 'extra-files must bump the Claude manifest version');
    ok(paths.includes('.codex-plugin/plugin.json'), 'extra-files must bump the Codex manifest version');
  });

  it('.release-please-manifest.json tracks plugins/designer', async () => {
    // Its version's agreement with the plugin manifests is validate-versions' to
    // check (ADR-0065 Decision 8 rule 6); this pins that release-please tracks it.
    const releasePleaseManifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(typeof releasePleaseManifest['plugins/designer'], 'string');
  });
});

// ADR-0066 D5 — the hook helpers live in one generated module,
// scripts/lib/hook-helpers.mjs, which both adapters import; no adapter carries
// its own copy, so neither reaches into the other's tree.
describe('plugins/designer — one hook-helper module (ADR-0066 D5)', () => {
  it('carries no adapters/*/hooks/_shared.mjs, and every hook imports scripts/lib/hook-helpers.mjs', async () => {
    for (const host of ['claude', 'codex']) {
      ok(!existsSync(resolve(PLUGIN_ROOT, `adapters/${host}/hooks/_shared.mjs`)),
        `adapters/${host}/hooks/_shared.mjs must be gone: the hooks import scripts/lib/hook-helpers.mjs`);
      for (const hook of ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs']) {
        const text = await readFile(resolve(PLUGIN_ROOT, `adapters/${host}/hooks/${hook}`), 'utf8');
        // Contract: Node resolves each hook's import — a hook importing anything
        // but the generated module runs a second, drifting copy of the helpers.
        ok(text.includes("from '../../../scripts/lib/hook-helpers.mjs'"), `adapters/${host}/hooks/${hook} must import the shared helpers`);
        ok(!text.includes('_shared.mjs'), `adapters/${host}/hooks/${hook} must not import an adapter-local helper`);
      }
    }
  });
});
