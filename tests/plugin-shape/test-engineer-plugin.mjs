// plugins/engineer plugin-shape conformance.
//
// What the hosts and the scripts read from the plugin's committed files:
//   - both manifests, and the two hooks manifests;
//   - every skill's SKILL.md frontmatter and agents/openai.yaml (6 verbs, the
//     `start` macro, the `resume` / `checkpoint` / `peer-now` / `commit` meta
//     skills), and every command's frontmatter (6 verbs, the `audit` alias,
//     the meta commands and `start`);
//   - the files those name: the host-shared scripts and the hook scripts
//     (present and executable), the shared references, the cited-brief
//     references, and the module every hook imports.
//
// Plus the calls an agent runs from engineer's runbooks: the Phase 0
// bootstrap's forwarding of /orchestrator:next's variables, the managed
// peer-runner calls, the audit alias's hand-off to critique, the resume drift
// block (whose probes are checked in order and which is run here), the
// decide-registry call each multi-axis lens section names, and the cited-brief
// gates that come before a web search.
//
// The runbook, skill and reference regions every persona shares are checked
// under tests/persona-pipeline/.
//
// Run via `node --test tests/plugin-shape/test-engineer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/engineer');

// Where this plugin's skills actually live, read from its own Codex manifest
// rather than assumed. `resolveSkillsRoot` throws on a broken declaration rather
// than falling back, so this file fails loudly at load instead of pointing every
// path below at a directory nothing writes to. A manifest with no `skills` key
// does fall back, to the README-only `skills/`; the skill checks below fail.
const SKILLS_REL = relative(PLUGIN_ROOT, resolveSkillsRoot(PLUGIN_ROOT)).split(sep).join('/');

const VERBS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const ALIAS_VERBS = ['audit'];
// Meta commands operate on the existing workflow rather than bootstrapping
// one. Each ships as a Claude command and as a Codex meta skill of the same
// name, so META_SKILLS is the same list.
const META_COMMANDS = ['resume', 'checkpoint', 'peer-now', 'commit'];
const META_SKILLS = META_COMMANDS;
// Lifecycle macros bootstrap a workflow and sequence the verbs; the command and
// the skill share the name.
const LIFECYCLE_MACROS = ['start'];
const MACRO_SKILLS = LIFECYCLE_MACROS;
const ALL_COMMANDS = [...VERBS, ...ALIAS_VERBS, ...META_COMMANDS, ...LIFECYCLE_MACROS];
const SHARED_REFS = [
  'presentation-protocol.md',
  'ensemble-protocol.md',
  'orchestration.md',
  'agent-taxonomy.md',
  'entry-routing-contract.md',
  'autopilot-mode.md',
];
const HOST_SHARED_SCRIPTS = ['state.mjs', 'dispatch-peer.mjs', 'peer-runner.mjs', 'stop-archive.mjs'];
// The hook helpers live in scripts/lib/hook-helpers.mjs (generated).
const CLAUDE_HOOKS = ['pre-compact.mjs', 'stop.mjs', 'session-start.mjs'];
const CODEX_HOOKS = ['pre-compact.mjs', 'stop.mjs', 'session-start.mjs', 'run-node-hook.sh', 'hooks.json', 'README.md'];

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

// Contract: Claude Code reads .claude-plugin/plugin.json to install and list the
// plugin — a missing or malformed field fails the install or hides the plugin.
describe('plugins/engineer — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'engineer');
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

  it('has keywords array including the 6 verbs', async () => {
    const json = await readJSON(path);
    ok(Array.isArray(json.keywords), 'keywords not an array');
    for (const verb of VERBS) {
      ok(json.keywords.includes(verb), `keywords missing verb "${verb}"`);
    }
  });
});

// Contract: Codex reads .codex-plugin/plugin.json — `skills` and `hooks` locate
// the skills root and the hooks manifest, `interface` drives the plugin listing;
// a wrong value loads no skills or no hooks, or fails the listing.
describe('plugins/engineer — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields per Codex vendored spec', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'engineer');
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

  it('has keywords array including the 6 verbs', async () => {
    const json = await readJSON(path);
    ok(Array.isArray(json.keywords), 'keywords not an array');
    for (const verb of VERBS) {
      ok(json.keywords.includes(verb), `keywords missing verb "${verb}"`);
    }
  });

  it('has skills field per Codex vendored spec (REQUIRED)', async () => {
    const json = await readJSON(path);
    strictEqual(json.skills, './core/skills/');
  });

  it('exposes bundled lifecycle hooks to Codex plugin metadata', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json');
  });

  it('has interface block with engineer-specific values', async () => {
    const json = await readJSON(path);
    const i = json.interface;
    ok(i, 'interface block missing');
    strictEqual(typeof i.displayName, 'string');
    strictEqual(typeof i.shortDescription, 'string');
    strictEqual(typeof i.longDescription, 'string');
    strictEqual(typeof i.developerName, 'string');
    strictEqual(i.category, 'Development');
    ok(Array.isArray(i.capabilities), 'capabilities not array');
    for (const cap of ['Interactive', 'Read', 'Write']) {
      ok(i.capabilities.includes(cap), `capabilities missing "${cap}"`);
    }
  });

  it('interface.defaultPrompt is array of 1-3 entries, each ≤128 chars, with at least one mentioning $engineer', async () => {
    const json = await readJSON(path);
    const dp = json.interface.defaultPrompt;
    ok(Array.isArray(dp), 'defaultPrompt not array');
    ok(dp.length >= 1 && dp.length <= 3, `defaultPrompt has ${dp.length} entries (1-3 expected)`);
    for (const entry of dp) {
      strictEqual(typeof entry, 'string');
      ok(entry.length <= 128, `defaultPrompt entry exceeds 128 chars: ${entry.length}`);
    }
    ok(dp.some((p) => p.includes('$engineer')), 'no defaultPrompt entry mentions $engineer');
  });
});

describe('plugins/engineer — manifest cross-checks', () => {
  // Their versions are validate-versions' to check (ADR-0065 Decision 8 rule 6).
  // Contract: both hosts and the catalogs key the plugin by `name` — manifests
  // that disagree install one package under two names.
  it('Claude and Codex manifests agree on name', async () => {
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const codex = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(claude.name, codex.name);
  });
});

// Contract: Codex loads each skill from <skills-root>/<name>/SKILL.md and reads
// `name` and `description` from its frontmatter — a missing file, a name that is
// not the folder's, or an empty description hides the skill.
describe('plugins/engineer — 6 verb skills (<skills-root>/<verb>/SKILL.md)', () => {
  for (const verb of VERBS) {
    describe(verb, () => {
      const path = skillsPath(PLUGIN_ROOT, verb, 'SKILL.md');

      it('exists', async () => {
        ok(await exists(path), `${SKILLS_REL}/${verb}/SKILL.md missing`);
      });

      it(`frontmatter name=${verb} (verb folder ↔ frontmatter consistency)`, async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, 'no YAML frontmatter');
        const re = new RegExp(`^name:\\s*${verb}\\s*$`, 'm');
        ok(re.test(fm), `${SKILLS_REL}/${verb}/SKILL.md frontmatter name != "${verb}"`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });
    });
  }
});

// The Phase 0 bootstrap block of each verb command. /orchestrator:next sets these
// variables when it dispatches a subtask; a direct invocation sets none of them.
describe('plugins/engineer — ADR-0019 PR-D Phase 0 parent-linkage env-var contract', () => {
  for (const verb of VERBS) {
    describe(verb, () => {
      const path = resolve(PLUGIN_ROOT, 'commands', `${verb}.md`);

      it('uses AGENTIC_HOST variable instead of hardcoded --host claude', async () => {
        const text = await readFile(path, 'utf8');
        // Contract: the agent running the block passes the host to state.mjs — a
        // hard-coded `--host claude` records a Codex dispatch as a Claude write.
        ok(!/--host\s+claude(?!\.\$)/m.test(text),
          `commands/${verb}.md still hardcodes --host claude`);
        ok(text.includes('--host "${AGENTIC_HOST:-claude}"'),
          `commands/${verb}.md must use --host "\${AGENTIC_HOST:-claude}"`);
      });

      it('stops when only one of AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK is set', async () => {
        const text = await readFile(path, 'utf8');
        // Contract: the agent running the bootstrap — without this stop, a
        // dispatch that set one variable creates a workflow with half a parent link.
        ok(/if \[ -z "\$\{AGENTIC_PARENT_WORKFLOW:-\}" \] \|\| \[ -z "\$\{AGENTIC_ORIGINATING_SUBTASK:-\}" \]; then\n[^\n]*\n\s*exit 1\n/.test(text),
          `commands/${verb}.md must exit when only one of the two parent variables is set`);
      });

      it('forwards --parent-workflow + --originating-subtask via PARENT_ARGS to state.mjs create', async () => {
        const text = await readFile(path, 'utf8');
        // Contract: state.mjs create records the parent link from these flags — a
        // block that drops them creates a workflow the macro never sees finish.
        ok(text.includes('--parent-workflow') && text.includes('--originating-subtask'),
          `commands/${verb}.md must forward --parent-workflow + --originating-subtask flags`);
        ok(text.includes('"${PARENT_ARGS[@]}"'),
          `commands/${verb}.md must expand "\${PARENT_ARGS[@]}" in the create CLI call`);
      });

      it('reads AGENTIC_TOPIC env var with fallback to LLM-provided original request', async () => {
        const text = await readFile(path, 'utf8');
        // Contract: state.mjs create --original-request — without the variable, a
        // dispatched subtask records the agent's wording instead of the subtask topic.
        ok(text.includes('--original-request "${AGENTIC_TOPIC:-'),
          `commands/${verb}.md --original-request must use \${AGENTIC_TOPIC:-...} env-var fallback`);
      });

      if (['investigate', 'compose', 'critique'].includes(verb)) {
        it('reads AGENTIC_PROFILE env var (verbs that accept --profile)', async () => {
          const text = await readFile(path, 'utf8');
          // Contract: state.mjs create --profile — without the variable, a
          // dispatched subtask runs the verb's default profile, not the subtask's.
          ok(text.includes('--profile "${AGENTIC_PROFILE:-'),
            `commands/${verb}.md --profile must use \${AGENTIC_PROFILE:-...} env-var fallback`);
        });
      }
    });
  }
});

// Contract: Codex reads agents/openai.yaml — `interface.display_name` and
// `default_prompt` drive the skill's listing and starter prompt, and
// `allow_implicit_invocation: false` keeps the skill explicit-only; a missing
// block or a true policy lets Codex run the skill unasked.
describe('plugins/engineer — 6 Codex agents YAML (<skills-root>/<verb>/agents/openai.yaml)', () => {
  for (const verb of VERBS) {
    describe(verb, () => {
      const path = skillsPath(PLUGIN_ROOT, verb, 'agents/openai.yaml');

      it('exists', async () => {
        ok(await exists(path), `${SKILLS_REL}/${verb}/agents/openai.yaml missing`);
      });

      it('has interface block with display_name mentioning the verb', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^interface:\s*$/m.test(yaml), 'interface block missing');
        ok(/^\s+display_name:\s*\S/m.test(yaml), 'interface.display_name missing or empty');
        // verb folder ↔ interface.display_name consistency (case-insensitive).
        const re = new RegExp(`display_name:.*${verb}`, 'i');
        ok(re.test(yaml), `interface.display_name does not mention verb "${verb}"`);
      });

      it('default_prompt mentions $engineer:<verb>', async () => {
        const yaml = await readFile(path, 'utf8');
        const re = new RegExp(`\\$engineer:${verb}`);
        ok(re.test(yaml), `default_prompt does not mention "$engineer:${verb}"`);
      });

      it('policy.allow_implicit_invocation is false (Stage 2 explicit-only invocation)', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^policy:\s*$/m.test(yaml), 'policy block missing');
        ok(
          /allow_implicit_invocation:\s*false/m.test(yaml),
          'allow_implicit_invocation should be false',
        );
      });
    });
  }
});

// Contract: Codex loads the `start` macro skill from <skills-root>/start/SKILL.md
// and reads `name` and `description` from its frontmatter — a mismatch hides it.
describe('plugins/engineer — macro skills (<skills-root>/<macro>/SKILL.md, per ADR-0021)', () => {
  for (const macro of MACRO_SKILLS) {
    describe(macro, () => {
      const path = skillsPath(PLUGIN_ROOT, macro, 'SKILL.md');

      it('exists', async () => {
        ok(await exists(path), `${SKILLS_REL}/${macro}/SKILL.md missing`);
      });

      it(`frontmatter name=${macro} (macro folder ↔ frontmatter consistency)`, async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, 'no YAML frontmatter');
        const re = new RegExp(`^name:\\s*${macro}\\s*$`, 'm');
        ok(re.test(fm), `${SKILLS_REL}/${macro}/SKILL.md frontmatter name != "${macro}"`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });
    });
  }
});

describe('plugins/engineer — start macro host-neutral peer wording', () => {
  // Contract: the agent running the start lifecycle dispatches each
  // phase-boundary ensemble to the opposite host — a hard-coded "Codex"
  // peer makes Codex, running the same skill, dispatch to itself.
  it('documents phase-boundary ensembles as opposite-host peer work, not Codex-only work', async () => {
    // Whitespace collapsed: a line break inside a phrase neither hides a
    // hard-coded host nor drops a host-neutral one.
    const text = (await readFile(skillsPath(PLUGIN_ROOT, 'start', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    for (const phrase of [
      'opposite-host `brainstorm` ensemble',
      'opposite-host `explore` ensemble',
      'opposite-host `plan-verify` ensemble',
      'opposite-host `review --scope working-tree` ensemble',
    ]) {
      ok(text.includes(phrase), `start SKILL.md missing host-neutral phrase: ${phrase}`);
    }
    for (const pattern of [
      /Codex `brainstorm` ensemble/,
      /Codex `explore` ensemble/,
      /Codex `plan-verify` ensemble/,
      /Codex receives Claude's draft plan/,
      /Codex `review --scope working-tree` ensemble/,
      /Codex re-review/,
    ]) {
      ok(!pattern.test(text), `start SKILL.md must not hard-code Codex-only peer wording: ${pattern}`);
    }
  });
});

// Contract: Codex reads agents/openai.yaml for the macro skill — see the verb
// skills' block above; a true policy lets Codex run the lifecycle unasked.
describe('plugins/engineer — macro skill Codex agents YAML (<skills-root>/<macro>/agents/openai.yaml, per ADR-0021)', () => {
  for (const macro of MACRO_SKILLS) {
    describe(macro, () => {
      const path = skillsPath(PLUGIN_ROOT, macro, 'agents/openai.yaml');

      it('exists', async () => {
        ok(await exists(path), `${SKILLS_REL}/${macro}/agents/openai.yaml missing`);
      });

      it('has interface block with display_name mentioning the macro', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^interface:\s*$/m.test(yaml), 'interface block missing');
        ok(/^\s+display_name:\s*\S/m.test(yaml), 'interface.display_name missing or empty');
        const re = new RegExp(`display_name:.*${macro}`, 'i');
        ok(re.test(yaml), `interface.display_name does not mention macro "${macro}"`);
      });

      it(`default_prompt mentions $engineer:${macro}`, async () => {
        const yaml = await readFile(path, 'utf8');
        const re = new RegExp(`\\$engineer:${macro}`);
        ok(re.test(yaml), `default_prompt does not mention "$engineer:${macro}"`);
      });

      it('policy.allow_implicit_invocation is false (Stage 2 explicit-only invocation)', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^policy:\s*$/m.test(yaml), 'policy block missing');
        ok(
          /allow_implicit_invocation:\s*false/m.test(yaml),
          'allow_implicit_invocation should be false',
        );
      });
    });
  }
});

// The meta skills (resume, checkpoint, peer-now, commit): the Codex side of the
// meta commands.
describe('plugins/engineer — meta skills (<skills-root>/<meta>/SKILL.md, per ADR-0022)', () => {
  for (const meta of META_SKILLS) {
    describe(meta, () => {
      const path = skillsPath(PLUGIN_ROOT, meta, 'SKILL.md');

      // Contract: Codex loads the skill from this path and reads `name` and
      // `description` from its frontmatter — a mismatch hides the skill.
      it('exists', async () => {
        ok(await exists(path), `${SKILLS_REL}/${meta}/SKILL.md missing`);
      });

      it(`frontmatter name=${meta} (meta folder ↔ frontmatter consistency)`, async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, 'no YAML frontmatter');
        const re = new RegExp(`^name:\\s*${meta}\\s*$`, 'm');
        ok(re.test(fm), `${SKILLS_REL}/${meta}/SKILL.md frontmatter name != "${meta}"`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });

      it('body mentions --host codex (Codex-side state.mjs flag, ADR-0022 §Decision §2)', async () => {
        const text = await readFile(path, 'utf8');
        // Contract: the Codex agent running the skill's state.mjs / phase7-commit.mjs
        // calls — without `--host codex` it records its writes as a Claude run.
        ok(
          /--host codex/.test(text),
          `${SKILLS_REL}/${meta}/SKILL.md does not document the Codex-side --host codex flag`,
        );
      });
    });
  }
});

// Contract: Codex reads agents/openai.yaml for each meta skill — see the verb
// skills' block above.
describe('plugins/engineer — meta skill Codex agents YAML (<skills-root>/<meta>/agents/openai.yaml, per ADR-0022)', () => {
  for (const meta of META_SKILLS) {
    describe(meta, () => {
      const path = skillsPath(PLUGIN_ROOT, meta, 'agents/openai.yaml');

      it('exists', async () => {
        ok(await exists(path), `${SKILLS_REL}/${meta}/agents/openai.yaml missing`);
      });

      it('has interface block with display_name mentioning the meta name', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^interface:\s*$/m.test(yaml), 'interface block missing');
        ok(/^\s+display_name:\s*\S/m.test(yaml), 'interface.display_name missing or empty');
        const re = new RegExp(`display_name:.*${meta}`, 'i');
        ok(re.test(yaml), `interface.display_name does not mention meta "${meta}"`);
      });

      it(`default_prompt mentions $engineer:${meta}`, async () => {
        const yaml = await readFile(path, 'utf8');
        const re = new RegExp(`\\$engineer:${meta}`);
        ok(re.test(yaml), `default_prompt does not mention "$engineer:${meta}"`);
      });

      it('policy.allow_implicit_invocation is false (Stage 2 explicit-only invocation)', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^policy:\s*$/m.test(yaml), 'policy block missing');
        ok(
          /allow_implicit_invocation:\s*false/m.test(yaml),
          'allow_implicit_invocation should be false',
        );
      });
    });
  }
});

// commands/<meta>.md holds the Claude-host shell blocks and points at the meta
// skill for the steps around them.
describe('plugins/engineer — meta command delegation pointer (commands/<meta>.md → <skills-root>/<meta>/SKILL.md, per ADR-0022)', () => {
  for (const meta of META_SKILLS) {
    describe(meta, () => {
      const path = resolve(PLUGIN_ROOT, 'commands', `${meta}.md`);

      it('command file references <skills-root>/<meta>/SKILL.md as the cognitive runbook source', async () => {
        const text = await readFile(path, 'utf8');
        // Contract: the agent running /engineer:<meta> opens this path for the
        // steps the command does not hold — without it the command has no runbook.
        const re = new RegExp(`${SKILLS_REL}/${meta}/SKILL\\.md`);
        ok(
          re.test(text),
          `commands/${meta}.md does not reference ${SKILLS_REL}/${meta}/SKILL.md — delegation pointer missing per ADR-0022 §Decision §2`,
        );
      });
    });
  }
});

// Contract: the skills and runbooks read these references by path — a missing
// file breaks every pointer to it.
describe('plugins/engineer — shared references (<skills-root>/_shared/references/*.md)', () => {
  for (const name of SHARED_REFS) {
    describe(name, () => {
      const path = skillsPath(PLUGIN_ROOT, '_shared/references', name);

      it('exists', async () => {
        ok(await exists(path), `${name} missing`);
      });
    });
  }
});

describe('plugins/engineer — 12 commands (commands/<verb>.md — 6 verbs + audit alias + resume/checkpoint/peer-now/commit meta + start lifecycle macro)', () => {
  // Contract: Claude Code loads each commands/<name>.md as /engineer:<name> and
  // shows its frontmatter `description` — a missing file or description drops it.
  for (const verb of ALL_COMMANDS) {
    describe(verb, () => {
      const path = resolve(PLUGIN_ROOT, 'commands', `${verb}.md`);

      it('exists', async () => {
        ok(await exists(path), `commands/${verb}.md missing`);
      });

      it('has frontmatter with non-empty description', async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, `commands/${verb}.md no YAML frontmatter`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });
    });
  }

  it('audit runs commands/critique.md with --profile=full-codebase', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/audit.md'), 'utf8');
    // Contract: the agent running /engineer:audit — without the profile it runs
    // critique's default review instead of the whole-codebase audit.
    ok(
      /`\$\{CLAUDE_PLUGIN_ROOT\}\/commands\/critique\.md` with `--profile=full-codebase/.test(text),
      'commands/audit.md must execute commands/critique.md with --profile=full-codebase',
    );
  });

  // audit is an engineer-only alias, an authored extension in ADR-0066
  // Decision 2's list, not a pipeline unit: nothing renders into it, so it must
  // hold nothing a generated region would own.
  it('audit stays an authored extension: no shell block, no pipeline marker, no manifest entry, and it executes commands/critique.md (ADR-0066 D2, PC3b)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/audit.md'), 'utf8');
    // Contract: the agent running /engineer:audit runs critique's blocks, not its
    // own; a shell block here would be a second, unchecked copy of them.
    ok(!/^\s*```(?:bash|sh|zsh)\b/m.test(text), 'commands/audit.md holds a shell block, which the resolver rule and a region would own');
    // Contract: the persona-pipeline sync reads `<!-- pipeline:` markers and the
    // manifest's dests — either here would make sync rewrite an authored file.
    ok(!text.includes('<!-- pipeline:'), 'commands/audit.md holds a pipeline marker');
    ok(text.includes('`${CLAUDE_PLUGIN_ROOT}/commands/critique.md`'), 'commands/audit.md no longer executes critique');
    const manifest = JSON.parse(await readFile(resolve(REPO_ROOT, 'persona-pipeline/manifest.json'), 'utf8'));
    const dests = [...manifest.units, ...manifest.regions, ...manifest.extension_points].map((u) => u.dest ?? '');
    ok(!dests.some((d) => d.endsWith('commands/audit.md')), 'a manifest entry targets commands/audit.md');
  });

  it('checkpoint meta command: argument-hint names the summary, and the command runs state.mjs checkpoint-set', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/checkpoint.md'), 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'commands/checkpoint.md has no YAML frontmatter');
    // Contract: Claude Code shows argument-hint as the command's usage — without
    // <summary> the user does not know the command takes one.
    ok(
      /^argument-hint:.*summary/im.test(fm),
      'commands/checkpoint.md argument-hint must advertise <summary>',
    );
    // Contract: the agent running /engineer:checkpoint — the write it makes.
    ok(
      /state\.mjs" checkpoint-set/.test(text),
      'commands/checkpoint.md must delegate to state.mjs checkpoint-set subcommand',
    );
  });

  // Contract: the agent running a verb command — a managed ensemble launched any
  // other way records no pending_ensemble row and leaves no result JSON to settle.
  it('six verb commands use peer-runner.mjs for managed ensemble dispatch (ADR-0023 PR-C)', async () => {
    for (const verb of VERBS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      ok(
        /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind ensemble[\s\S]{0,260}--run-id "\$RUN_ID"/.test(text),
        `commands/${verb}.md must dispatch managed ensembles through peer-runner.mjs run`,
      );
      ok(
        /PROMPT_FILE\.run\.json/.test(text),
        `commands/${verb}.md must capture peer-runner's machine-readable result JSON`,
      );
    }
  });

  // Contract: the agent running a verb command — dispatch-peer.mjs keeps no
  // peer-run ledger, so the ensemble it starts cannot be inspected, cancelled or
  // settled through peer-runner, and its pending entry is closed by hand.
  it('six verb commands no longer route managed ensembles through dispatch-peer.mjs', async () => {
    for (const verb of VERBS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      ok(
        !/dispatch-peer\.mjs/.test(text),
        `commands/${verb}.md should reserve dispatch-peer.mjs for compatibility/raw callers`,
      );
    }
  });

  // Contract: the agent running /engineer:peer-now — the run, and the status and
  // cancel calls that reach the same run by its run_id.
  it('peer-now runs peer-runner in text mode, with status and cancel by run_id', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/peer-now.md'), 'utf8');
    ok(
      /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind peer-now[\s\S]{0,260}--output-format text/.test(text),
      'commands/peer-now.md must use peer-runner.mjs run --kind peer-now --output-format text',
    );
    ok(
      /peer-runner\.mjs"\s+status[\s\S]{0,160}--run-id "\$RUN_ID"/.test(text) &&
        /peer-runner\.mjs"\s+cancel[\s\S]{0,160}--run-id "\$RUN_ID"/.test(text),
      'commands/peer-now.md must document status/cancel controls by peer-now run_id',
    );
  });

  it('resume\'s drift block, run: clean only when branch, HEAD and digest match (an unrecorded digest matches); dirty runs the four ADR-0018 probes in order only past the baseline guard, and always closes with the no-auto-reconcile notice', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/resume.md'), 'utf8');
    // The block this test runs, found by its `DRIFT=dirty` line.
    const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => /^\s*DRIFT=dirty$/m.test(b));
    strictEqual(blocks.length, 1, 'the drift block');
    const [block] = blocks;
    // Contract: the agent running /engineer:resume — git probes that run before
    // the baseline guard fail on an empty or missing baseline commit.
    const guarded = block.indexOf('if [ "$BASE_VALID" = true ]; then');
    ok(guarded > 0 && /\[ -z "\$BASE_HEAD" \]/.test(block.slice(0, guarded)), 'the empty-baseline guard precedes the probes');
    let at = guarded;
    for (const probe of [
      /git\s+log\s+"\$BASE_HEAD\.\.HEAD"\s+--oneline/,
      /git\s+diff\s+--stat\s+HEAD/,
      /git\s+log\s+--diff-filter=R\s+--name-status\s+"\$BASE_HEAD\.\.HEAD"/,
      /git\s+log\s+--diff-filter=D\s+--name-status\s+"\$BASE_HEAD\.\.HEAD"/,
    ]) {
      const m = probe.exec(block.slice(at));
      ok(m, `${probe}, in order, inside the guarded branch`);
      at += m.index + m[0].length;
    }

    const repo = mkdtempSync(resolve(tmpdir(), 'engineer-resume-drift-'));
    try {
      const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'baseline');
      const head = git('rev-parse', 'HEAD');
      const run = (vars) => {
        const assign = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n');
        const r = spawnSync('bash', ['-c', `${assign}\n${block}\nprintf 'DRIFT=%s\\n' "$DRIFT"`], { cwd: repo, encoding: 'utf8' });
        strictEqual(r.status, 0, r.stderr);
        return { drift: /^DRIFT=(.*)$/m.exec(r.stdout)?.[1], out: r.stdout };
      };
      const NOTICE = 'current plugin does not auto-reconcile; review and decide [resume / archive / abort]';
      const base = { CURRENT_BRANCH: 'main', BASE_BRANCH: 'main', CURRENT_HEAD: head, BASE_HEAD: head, CURRENT_DIGEST: 'd1', BASE_DIGEST: 'd1' };
      for (const [label, vars] of [['unchanged', base], ['no recorded digest', { ...base, BASE_DIGEST: '' }]]) {
        const r = run(vars);
        strictEqual(r.drift, 'clean', label);
        ok(!r.out.includes(NOTICE), `${label}: no dirty report`);
      }
      for (const [label, vars] of [['branch changed', { ...base, CURRENT_BRANCH: 'other' }], ['HEAD moved', { ...base, CURRENT_HEAD: 'f'.repeat(40) }], ['digest changed', { ...base, CURRENT_DIGEST: 'd2' }]]) {
        const r = run(vars);
        strictEqual(r.drift, 'dirty', label);
        let seen = -1;
        for (const line of ['commits since baseline:', 'working-tree diff stat (vs HEAD; untracked excluded):', 'renames since baseline:', 'deletes since baseline:', NOTICE]) {
          const next = r.out.indexOf(line);
          ok(next > seen, `${label}: ${line} in order:\n${r.out}`);
          seen = next;
        }
      }
      for (const [label, baseHead] of [['empty baseline head', ''], ['unavailable baseline commit', '0'.repeat(40)]]) {
        const r = run({ ...base, BASE_HEAD: baseHead });
        strictEqual(r.drift, 'dirty', label);
        ok(r.out.includes('✗ Invalid baseline') && !r.out.includes('commits since baseline'), `${label}: no probe runs:\n${r.out}`);
        ok(r.out.includes(NOTICE), `${label}: the notice still closes the report`);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ADR-0029 §2: a non-decide verb that reaches a genuine 2+-branch point resolves
// a sized axis set from decide-registry.mjs. Each surface's section is sliced by
// its heading, and the resolver call is checked inside it.
describe('plugins/engineer — ADR-0029 §2 cross-verb multi-axis lens (PR-C)', () => {
  const NON_DECIDE = ['investigate', 'frame', 'compose', 'critique', 'refine'];
  const SECTION_HEADING = '## Multi-axis lens at a 2+-branch point';
  // Contract: the agent surfacing a lens runs this call — without it, or without
  // --size, it hand-writes an axis list or gets the unsized default preset.
  const RESOLVE_CALL = /decide-registry\.mjs"? resolve --size=<minor\|standard\|major>/;

  // Bound a `## ` section from its heading up to the next `## ` heading (or
  // EOF), so a call downstream of the section cannot satisfy the check.
  function boundSection(text, startIdx, heading) {
    const after = text.slice(startIdx + heading.length);
    const rel = after.search(/\n##\s/);
    return rel === -1
      ? text.slice(startIdx)
      : text.slice(startIdx, startIdx + heading.length + rel);
  }

  it('the contract\'s §2 subsection runs decide-registry.mjs resolve with --size', async () => {
    const text = await readFile(
      skillsPath(PLUGIN_ROOT, '_shared/references/entry-routing-contract.md'),
      'utf8',
    );
    const HEADING = '### Surfacing the multi-axis lens from a non-decide verb';
    const idx = text.indexOf(HEADING);
    ok(idx !== -1, `entry-routing-contract.md missing the "${HEADING}" §2 mechanism subsection (ADR-0029 §2 / PR-C)`);
    const region = boundSection(text, idx, HEADING);
    ok(RESOLVE_CALL.test(region), `contract §2 subsection must run ${RESOLVE_CALL}`);
  });

  it('five non-decide verb commands run the resolver with --size in their §2 section', async () => {
    for (const verb of NON_DECIDE) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const idx = text.indexOf(SECTION_HEADING);
      ok(idx !== -1, `commands/${verb}.md missing the "${SECTION_HEADING}" §2 section (ADR-0029 §2 / PR-C)`);
      const region = boundSection(text, idx, SECTION_HEADING);
      ok(RESOLVE_CALL.test(region), `commands/${verb}.md §2 section must run ${RESOLVE_CALL}`);
    }
  });

  it('five non-decide verb skills run the resolver with --size in their §2 section', async () => {
    for (const verb of NON_DECIDE) {
      const text = await readFile(skillsPath(PLUGIN_ROOT, verb, 'SKILL.md'), 'utf8');
      const idx = text.indexOf(SECTION_HEADING);
      ok(idx !== -1, `${SKILLS_REL}/${verb}/SKILL.md missing the "${SECTION_HEADING}" §2 section (ADR-0029 §2 / PR-C host parity)`);
      const region = boundSection(text, idx, SECTION_HEADING);
      ok(RESOLVE_CALL.test(region), `${SKILLS_REL}/${verb}/SKILL.md §2 section must run ${RESOLVE_CALL}`);
    }
  });
});

// Contract: the runbooks and hooks run these scripts by path (`node <path>` or a
// direct exec) — a missing file or a cleared executable bit fails every call.
describe('plugins/engineer — 4 host-shared canonical scripts (scripts/*.mjs)', () => {
  for (const name of HOST_SHARED_SCRIPTS) {
    describe(name, () => {
      const path = resolve(PLUGIN_ROOT, 'scripts', name);

      it('exists as a regular file', async () => {
        const st = await stat(path);
        ok(st.isFile(), `scripts/${name} is not a regular file`);
      });

      it('has the executable bit set', async () => {
        const st = await stat(path);
        ok(
          (st.mode & 0o111) !== 0,
          `scripts/${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
        );
      });
    });
  }
});

// Contract: hooks/hooks.json runs these files — a missing file or a cleared
// executable bit fails the hook.
describe('plugins/engineer — Claude adapter hooks (adapters/claude/hooks/*.mjs)', () => {
  for (const name of CLAUDE_HOOKS) {
    describe(name, () => {
      const path = resolve(PLUGIN_ROOT, 'adapters/claude/hooks', name);

      it('exists as a regular file', async () => {
        const st = await stat(path);
        ok(st.isFile(), `adapters/claude/hooks/${name} is not a regular file`);
      });

      it('has the executable bit set', async () => {
        const st = await stat(path);
        ok(
          (st.mode & 0o111) !== 0,
          `adapters/claude/hooks/${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
        );
      });
    });
  }
});

describe('plugins/engineer — Codex adapter (adapters/codex/hooks/)', () => {
  // Contract: the Codex hooks manifest runs these files through
  // run-node-hook.sh — a missing file or a cleared executable bit fails the hook.
  for (const name of CODEX_HOOKS) {
    it(`${name} exists${name.endsWith('.mjs') ? ' with executable bit' : ''}`, async () => {
      const path = resolve(PLUGIN_ROOT, 'adapters/codex/hooks', name);
      const st = await stat(path);
      ok(st.isFile(), `adapters/codex/hooks/${name} not a regular file`);
      if (name.endsWith('.mjs')) {
        ok(
          (st.mode & 0o111) !== 0,
          `adapters/codex/hooks/${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
        );
      }
    });
  }

  // Contract: Codex reads adapters/codex/hooks/hooks.json and runs each command
  // with ${PLUGIN_ROOT} substituted — a command off that path or around the Node
  // resolver wrapper runs nothing, or a Node Codex cannot find.
  it('hooks.json routes lifecycle commands to Codex adapter hooks via $PLUGIN_ROOT', async () => {
    const json = await readJSON(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/hooks.json'));
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      const entry = json.hooks[event][0].hooks[0];
      strictEqual(entry.type, 'command');
      ok(
        entry.command.includes('${PLUGIN_ROOT}/adapters/codex/hooks/'),
        `${event} command does not reference $PLUGIN_ROOT Codex adapter path: ${entry.command}`,
      );
      ok(
        entry.command.startsWith('/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh"'),
        `${event} command does not route through the Node resolver wrapper: ${entry.command}`,
      );
    }
    strictEqual(json.hooks.SessionStart[0].matcher, 'compact');
  });
});

// Contract: Claude Code reads hooks/hooks.json and runs each command with
// ${CLAUDE_PLUGIN_ROOT} substituted — a missing event, a wrong matcher or a path
// off the adapter directory drops the hook or runs it at the wrong time.
describe('plugins/engineer — bundled hooks manifest (hooks/hooks.json)', () => {
  const path = resolve(PLUGIN_ROOT, 'hooks/hooks.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('declares the three Claude Code lifecycle hooks (SessionStart compact / PreCompact / Stop)', async () => {
    const json = await readJSON(path);
    ok(json.hooks, 'hooks block missing');
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      ok(Array.isArray(json.hooks[event]), `hooks.${event} not array`);
      ok(json.hooks[event].length >= 1, `hooks.${event} empty`);
    }
  });

  it('SessionStart hook uses matcher=compact (ADR-0011 §4)', async () => {
    const json = await readJSON(path);
    const ss = json.hooks.SessionStart[0];
    strictEqual(ss.matcher, 'compact', 'SessionStart matcher should be "compact"');
  });

  it('all hook commands resolve under adapters/claude/hooks/ via $CLAUDE_PLUGIN_ROOT', async () => {
    const json = await readJSON(path);
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      const entry = json.hooks[event][0].hooks[0];
      strictEqual(entry.type, 'command');
      ok(
        entry.command.includes('${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/'),
        `${event} command does not reference $CLAUDE_PLUGIN_ROOT adapter path: ${entry.command}`,
      );
    }
  });
});

// The cited-brief profile of /engineer:investigate.
describe('plugins/engineer — investigate cited-brief profile (ADR-0014 absorption)', () => {
  const SKILL_PATH = skillsPath(PLUGIN_ROOT, 'investigate/SKILL.md');
  const COMMAND_PATH = resolve(PLUGIN_ROOT, 'commands/investigate.md');
  const REFERENCES_DIR = skillsPath(PLUGIN_ROOT, 'investigate/references');
  const SPEC_PATH = resolve(REFERENCES_DIR, 'cited-brief-spec.md');
  const RULES_PATH = resolve(REFERENCES_DIR, 'output-file-rules.md');
  const ENSEMBLE_PATH = resolve(REFERENCES_DIR, 'cited-brief-ensemble.md');

  it('investigate SKILL.md frontmatter description includes cited-brief trigger phrases', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter');
    // Contract: the host matches a request against the skill's `description` to
    // pick the skill — without these phrases a research request misses it.
    ok(/cited brief/i.test(fm), 'frontmatter description missing "cited brief"');
    ok(/literature review/i.test(fm), 'frontmatter description missing "literature review"');
    ok(/리서치/.test(fm), 'frontmatter description missing "리서치"');
  });

  // Contract: the cited-brief steps read these three references by path — a
  // missing file leaves the step with no rules to follow.
  it('investigate references/ directory contains 3 absorbed contract files', async () => {
    ok(await exists(SPEC_PATH), 'references/cited-brief-spec.md missing');
    ok(await exists(RULES_PATH), 'references/output-file-rules.md missing');
    ok(await exists(ENSEMBLE_PATH), 'references/cited-brief-ensemble.md missing');
  });

  it('commands/investigate.md argument-hint includes cited-brief profile', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter on commands/investigate.md');
    // Contract: Claude Code shows argument-hint as the command's usage — without
    // cited-brief the profile cannot be found from the command line.
    ok(/cited-brief/.test(fm), 'argument-hint missing cited-brief');
  });

  it('the existing-directory check comes before any web search', async () => {
    const skill = await readFile(SKILL_PATH, 'utf8');
    // Contract: the agent running a cited brief — without this stop it runs the
    // web searches before learning the output directory already exists.
    ok(/Existing-directory check[\s\S]{0,200}BEFORE\s+running web searches/.test(skill), 'SKILL.md missing the pre-search existing-directory check');
  });

  it('the cited-brief privacy gate covers web search queries and peer dispatch', async () => {
    const skill = await readFile(SKILL_PATH, 'utf8');
    // Contract: the agent writing web search queries and the peer prompt — a gate
    // that names neither lets private identifiers leave the host in either.
    ok(/Privacy gate:[\s\S]{0,200}web search queries,[\s\S]{0,60}peer-host dispatch/.test(skill), 'SKILL.md privacy gate missing web search / peer dispatch');
  });
});

// ADR-0066 D5 — the hook helpers live in one generated module,
// scripts/lib/hook-helpers.mjs, which both adapters import; no adapter carries
// its own copy, so neither reaches into the other's tree.
describe('plugins/engineer — one hook-helper module (ADR-0066 D5)', () => {
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
