// plugins/orchestrator plugin-shape conformance test.
//
// Checks what a host, a release tool or an agent reads from the plugin's
// committed files:
//   - both manifests (Claude + Codex), the two marketplace catalogs and the
//     release-please registration
//   - the Claude and Codex hooks.json routing, and the scripts and hooks they
//     run (present, executable)
//   - SKILL.md and command frontmatter, and the agents/openai.yaml fields
//     Codex reads
//   - the calls, flags and paths the Codex skill mirrors and the commands tell
//     the agent to run
//   - the Claude-only autopilot adapter's shape and import boundary
//
// The tests/orchestrator/ suite covers state.mjs, dispatch-peer.mjs,
// peer-runner.mjs, hook behavior, and the runbook blocks it runs.
//
// Run via `node --test tests/plugin-shape/test-orchestrator-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');

// Where this plugin's skills actually live, read from its own Codex manifest
// rather than assumed. `resolveSkillsRoot` throws on a broken declaration
// rather than falling back, so this file fails loudly at load instead of
// pointing every path below at a directory nothing writes to. A manifest with
// no `skills` key does fall back, to the README-only `skills/`; the skill
// checks below fail.
const SKILLS_REL = relative(PLUGIN_ROOT, resolveSkillsRoot(PLUGIN_ROOT)).split(sep).join('/');

const VERBS = ['plan'];
const ALIAS_VERBS = ['audit'];
// Orchestrator dispatch commands: slash-command runbooks (same-host dispatch
// + manual backup), not 6-verb persona commands (those live in engineer).
const DISPATCH_COMMANDS = ['next', 'done'];
const LIFECYCLE_COMMANDS = ['finalize', 'abort'];
const META_COMMANDS = ['resume', 'checkpoint', 'peer-now', 'approve'];
// Claude adapter commands with no Codex skill mirror.
const CLAUDE_ONLY_COMMANDS = ['autopilot'];
const DISPATCH_AND_LIFECYCLE_SKILLS = [...DISPATCH_COMMANDS, ...LIFECYCLE_COMMANDS];
const ALL_COMMANDS = [...VERBS, ...ALIAS_VERBS, ...DISPATCH_COMMANDS, ...LIFECYCLE_COMMANDS, ...META_COMMANDS, ...CLAUDE_ONLY_COMMANDS];
const SHARED_REFS = ['ensemble-protocol.md', 'presentation-protocol.md', 'session-handoff.md'];
const HOST_SHARED_SCRIPTS = ['state.mjs', 'dispatch-peer.mjs', 'peer-runner.mjs', 'stop-archive.mjs'];
const CLAUDE_HOOKS = ['_shared.mjs', 'session-start.mjs', 'pre-compact.mjs', 'stop.mjs'];
const CODEX_HOOK_HELPERS = ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs', 'run-node-hook.sh', 'hooks.json'];

async function readJSON(path) {
  const text = await readFile(path, 'utf-8');
  return JSON.parse(text);
}

// Contract: Claude Code and Codex read these manifest fields to install, list and
// load the plugin — a missing or mistyped field breaks install or the listing.
describe('plugins/orchestrator manifest pair', () => {
  it('Claude manifest is valid JSON with required fields', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(manifest.name, 'orchestrator');
    strictEqual(typeof manifest.version, 'string');
    ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'version is semver');
    strictEqual(typeof manifest.description, 'string');
    ok(manifest.description.length > 20, 'description is substantive');
    strictEqual(typeof manifest.license, 'string');
    ok(Array.isArray(manifest.keywords), 'keywords array');
    ok(manifest.keywords.includes('orchestrator'));
    ok(manifest.keywords.includes('plan-verify'));
  });

  it('Codex manifest is valid JSON with required fields and skills/interface', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(manifest.name, 'orchestrator');
    strictEqual(typeof manifest.version, 'string');
    strictEqual(typeof manifest.description, 'string');
    // Contract: Codex loads skills and hooks from these paths — a wrong path loads none.
    strictEqual(manifest.skills, './core/skills/',
      'the Codex manifest must declare the relocated root — typeof alone passes on the pre-relocation value');
    strictEqual(manifest.hooks, './adapters/codex/hooks/hooks.json');
    ok(manifest.skills.endsWith('/'), 'skills path is directory-shaped');
    ok(manifest.interface, 'interface block present');
    strictEqual(typeof manifest.interface.displayName, 'string');
    strictEqual(typeof manifest.interface.shortDescription, 'string');
    strictEqual(typeof manifest.interface.longDescription, 'string');
    strictEqual(manifest.interface.developerName, 'each4all');
    strictEqual(manifest.interface.category, 'Productivity');
    ok(Array.isArray(manifest.interface.capabilities));
    ok(Array.isArray(manifest.interface.defaultPrompt));
    ok(manifest.interface.defaultPrompt.length > 0);
  });

  // Their versions are validate-versions' to check (ADR-0065 Decision 8 rule 6).
  it('Claude and Codex manifests share name + description', async () => {
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const codex = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(claude.name, codex.name);
    strictEqual(claude.description, codex.description);
    strictEqual(claude.license, codex.license);
    deepStrictEqual(claude.keywords, codex.keywords);
  });
});

// Whether the Codex catalog lists this package, and at which pin, and the
// Claude catalog's version are validate-marketplace's and validate-versions'
// to check (ADR-0065 Decision 8 rule 6). The release job's sync writes them
// after the release commit, so a test reading them would turn that commit
// red; a first release has no Codex entry until the sync adds it.
// Contract: the host catalogs and release-please read these entries — a wrong
// source, policy or package key leaves the plugin uninstallable or unreleased.
describe('plugins/orchestrator marketplace registration', () => {
  it('Claude marketplace catalog has an orchestrator entry for the package directory', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'orchestrator');
    ok(entry, 'orchestrator entry present in Claude catalog');
    strictEqual(entry.source, './plugins/orchestrator');
    strictEqual(entry.category, 'Productivity');
  });

  it('Codex marketplace catalog entry carries the published policy and category', async (t) => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'orchestrator');
    if (entry === undefined) return t.skip('no Codex entry yet; validate-marketplace decides whether one is due');
    strictEqual(entry.policy.installation, 'AVAILABLE');
    strictEqual(entry.policy.authentication, 'ON_USE');
    strictEqual(entry.category, 'Productivity');
  });

  it('release-please manifest tracks orchestrator', async () => {
    // Its version's agreement with the plugin manifests is validate-versions' to
    // check (ADR-0065 Decision 8 rule 6); this pins that release-please tracks it.
    const releasePleaseManifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(typeof releasePleaseManifest['plugins/orchestrator'], 'string');
  });

  it('release-please-config tracks orchestrator with extra-files for both manifests', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages['plugins/orchestrator'];
    ok(pkg, 'orchestrator package configured');
    strictEqual(pkg['package-name'], 'plugin-orchestrator');
    strictEqual(pkg['component'], 'plugin-orchestrator');
    strictEqual(pkg['changelog-path'], 'CHANGELOG.md');
    ok(Array.isArray(pkg['extra-files']));
    const paths = pkg['extra-files'].map((f) => f.path);
    ok(paths.includes('.claude-plugin/plugin.json'));
    ok(paths.includes('.codex-plugin/plugin.json'));
  });
});

// Contract: Claude Code reads hooks/hooks.json — a missing event, matcher or
// script path means that lifecycle hook never runs.
describe('plugins/orchestrator hooks/hooks.json shape', () => {
  it('declares SessionStart (matcher compact), PreCompact, and Stop lifecycle hooks', async () => {
    const hooks = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    ok(hooks.hooks);
    ok(Array.isArray(hooks.hooks.SessionStart));
    ok(Array.isArray(hooks.hooks.PreCompact));
    ok(Array.isArray(hooks.hooks.Stop));
    const declaredEvents = Object.keys(hooks.hooks);
    deepStrictEqual(declaredEvents.sort(), ['PreCompact', 'SessionStart', 'Stop']);

    // SessionStart matcher must be 'compact'
    strictEqual(hooks.hooks.SessionStart[0].matcher, 'compact');

    // Each event's command must reference adapters/claude/hooks/<name>.mjs
    const hookCommand = (event) => hooks.hooks[event][0].hooks[0].command;
    ok(hookCommand('SessionStart').includes('adapters/claude/hooks/session-start.mjs'));
    ok(hookCommand('PreCompact').includes('adapters/claude/hooks/pre-compact.mjs'));
    ok(hookCommand('Stop').includes('adapters/claude/hooks/stop.mjs'));
  });
});

// ---------------------------------------------------------------------------
// Script / hook / skill / command presence

// Contract: the runbooks and hooks run these scripts — a missing file or a lost
// executable bit fails the call.
describe('plugins/orchestrator scripts/', () => {
  for (const script of HOST_SHARED_SCRIPTS) {
    it(`${script} exists and is executable`, async () => {
      const p = resolve(PLUGIN_ROOT, 'scripts', script);
      const st = await stat(p);
      ok(st.isFile(), `${script} is a file`);
      const isExecutable = (st.mode & 0o111) !== 0;
      ok(isExecutable, `${script} has executable bit set`);
    });
  }
});

// Contract: hooks/hooks.json runs these hook scripts — a missing file or a lost
// executable bit fails the hook.
describe('plugins/orchestrator adapters/claude/hooks/', () => {
  for (const hook of CLAUDE_HOOKS) {
    it(`${hook} exists${hook === '_shared.mjs' ? '' : ' and is executable'}`, async () => {
      const p = resolve(PLUGIN_ROOT, 'adapters/claude/hooks', hook);
      const st = await stat(p);
      ok(st.isFile(), `${hook} is a file`);
      if (hook !== '_shared.mjs') {
        const isExecutable = (st.mode & 0o111) !== 0;
        ok(isExecutable, `${hook} has executable bit set`);
      }
    });
  }
});

describe('plugins/orchestrator adapters/codex/hooks/', () => {
  // Contract: Codex reads hooks.json, which runs run-node-hook.sh and the .mjs
  // hooks — a missing file or a lost executable bit fails the hook.
  for (const file of CODEX_HOOK_HELPERS) {
    it(`${file} exists${file.endsWith('.mjs') ? ' and is executable' : ''}`, async () => {
      const p = resolve(PLUGIN_ROOT, 'adapters/codex/hooks', file);
      const st = await stat(p);
      ok(st.isFile(), `${file} is a file`);
      if (file.endsWith('.mjs')) {
        const isExecutable = (st.mode & 0o111) !== 0;
        ok(isExecutable, `${file} has executable bit set`);
      }
    });
  }

  // Contract: Codex runs these hook commands — a wrong wrapper or script path
  // means the lifecycle hook never runs.
  it('hooks.json routes lifecycle commands to Codex adapter hooks via $PLUGIN_ROOT', async () => {
    const hooks = await readJSON(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/hooks.json'));
    const hookCommand = (event) => hooks.hooks[event][0].hooks[0].command;
    strictEqual(hooks.hooks.SessionStart[0].matcher, 'compact');
    ok(hookCommand('SessionStart').startsWith('/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh"'));
    ok(hookCommand('PreCompact').startsWith('/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh"'));
    ok(hookCommand('Stop').startsWith('/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh"'));
    ok(hookCommand('SessionStart').includes('${PLUGIN_ROOT}/adapters/codex/hooks/session-start.mjs'));
    ok(hookCommand('PreCompact').includes('${PLUGIN_ROOT}/adapters/codex/hooks/pre-compact.mjs'));
    ok(hookCommand('Stop').includes('${PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs'));
  });
});

describe(`plugins/orchestrator ${SKILLS_REL}/`, () => {
  for (const verb of VERBS) {
    it(`${SKILLS_REL}/${verb}/SKILL.md exists with frontmatter name === ${verb}`, async () => {
      const skillPath = skillsPath(PLUGIN_ROOT, verb, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      // Contract: Codex reads `name` and `description` from SKILL.md frontmatter — a
      // missing block or a mismatched name hides the skill.
      ok(text.startsWith('---\n'), 'SKILL.md starts with frontmatter');
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, 'SKILL.md frontmatter is closed');
      const fm = text.slice(4, fmEnd);
      ok(new RegExp(`^name:\\s*${verb}\\s*$`, 'm').test(fm),
        `SKILL.md frontmatter name is ${verb}`);
      ok(/^description:/m.test(fm), 'SKILL.md frontmatter has description');
    });

    it(`${SKILLS_REL}/${verb}/agents/openai.yaml exists with display_name`, async () => {
      const yamlPath = skillsPath(PLUGIN_ROOT, verb, 'agents', 'openai.yaml');
      const text = await readFile(yamlPath, 'utf-8');
      // Contract: Codex reads these openai.yaml interface fields to list the skill.
      ok(/display_name:/.test(text), 'openai.yaml has display_name');
      ok(/short_description:/.test(text), 'openai.yaml has short_description');
    });
  }

  for (const ref of SHARED_REFS) {
    it(`${SKILLS_REL}/_shared/references/${ref} exists`, async () => {
      const refPath = resolve(PLUGIN_ROOT, `${SKILLS_REL}/_shared/references`, ref);
      // Contract: the commands and skills send the agent to this file by path — a
      // missing file breaks the step that reads it.
      ok((await stat(refPath)).isFile(), `${ref} is a file`);
    });
  }

  it('plan skill and ensemble protocol dispatch to the opposite host, never a hard-coded one', async () => {
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'plan/SKILL.md'), 'utf-8');
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'plan/agents/openai.yaml'), 'utf-8');
    const protocol = await readFile(skillsPath(PLUGIN_ROOT, '_shared/references/ensemble-protocol.md'), 'utf-8');
    const planDocs = `${skill}\n${protocol}`;

    // Contract: the agent running plan dispatches Plan-verify and writes the plan with
    // these calls — the peer and --host must follow the current host.
    for (const call of [
      '`peer-runner.mjs run --kind ensemble --peer <opposite-host>',
      '`state.mjs plan-set --workflow-path <path> --host <current-host>',
    ]) {
      ok(planDocs.includes(call), `orchestrator plan docs missing host-neutral call: ${call}`);
    }

    // Contract: the agent running plan — a hard-coded peer or host makes Codex
    // dispatch to itself, or record the plan as written by Claude.
    for (const pattern of [/--peer codex/, /--host claude --subtasks-json-file/]) {
      ok(!pattern.test(skill), `${SKILLS_REL}/plan/SKILL.md must not hard-code ${pattern}`);
      ok(!pattern.test(agent), `${SKILLS_REL}/plan/agents/openai.yaml must not hard-code ${pattern}`);
      ok(!pattern.test(protocol), `ensemble-protocol.md must not hard-code ${pattern}`);
    }
  });
});

describe(`plugins/orchestrator ${SKILLS_REL}/ meta skills`, () => {
  for (const meta of META_COMMANDS) {
    it(`${SKILLS_REL}/${meta}/SKILL.md exists with frontmatter name === ${meta}`, async () => {
      const skillPath = skillsPath(PLUGIN_ROOT, meta, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      // Contract: Codex reads `name` and `description` from SKILL.md frontmatter — a
      // missing block or a mismatched name hides the skill.
      ok(text.startsWith('---\n'), 'SKILL.md starts with frontmatter');
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, 'SKILL.md frontmatter is closed');
      const fm = text.slice(4, fmEnd);
      ok(new RegExp(`^name:\\s*${meta}\\s*$`, 'm').test(fm),
        `SKILL.md frontmatter name is ${meta}`);
      ok(/^description:/m.test(fm), 'SKILL.md frontmatter has description');
      // Contract: the Codex agent passes --host codex to the state CLI — without it the
      // write is recorded as a Claude write.
      ok(text.includes('--host codex'), `${meta} skill documents Codex host flag`);
    });

    it(`${SKILLS_REL}/${meta}/agents/openai.yaml exists with display_name`, async () => {
      const yamlPath = skillsPath(PLUGIN_ROOT, meta, 'agents', 'openai.yaml');
      const text = await readFile(yamlPath, 'utf-8');
      // Contract: Codex reads openai.yaml — the listing fields, an explicit-only policy,
      // and a default prompt that mentions the skill (the only way to invoke it).
      ok(/display_name:/.test(text), 'openai.yaml has display_name');
      ok(/short_description:/.test(text), 'openai.yaml has short_description');
      ok(text.includes(`$orchestrator:${meta}`), `default prompt references $orchestrator:${meta}`);
      ok(/allow_implicit_invocation:\s*false/.test(text), 'implicit invocation disabled');
    });
  }
});

describe('plugins/orchestrator dispatch + lifecycle Codex skill mirrors/', () => {
  for (const skill of DISPATCH_AND_LIFECYCLE_SKILLS) {
    it(`${SKILLS_REL}/${skill}/SKILL.md mirrors /orchestrator:${skill} for Codex`, async () => {
      const skillPath = skillsPath(PLUGIN_ROOT, skill, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      // Contract: Codex reads `name` and `description` from SKILL.md frontmatter — a
      // missing block or a mismatched name hides the skill.
      ok(text.startsWith('---\n'), 'SKILL.md starts with frontmatter');
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, 'SKILL.md frontmatter is closed');
      const fm = text.slice(4, fmEnd);
      ok(new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(fm),
        `SKILL.md frontmatter name is ${skill}`);
      ok(/^description:/m.test(fm), 'SKILL.md frontmatter has description');
      // Contract: the Codex agent follows this path to the runbook it executes, and
      // passes --host codex to the state CLI — a wrong path leaves it without the
      // steps; a missing flag records the write as Claude's.
      ok(text.includes(`commands/${skill}.md`), `${skill} skill points to canonical command runbook`);
      ok(text.includes('--host codex'), `${skill} skill documents Codex host flag`);
    });

    it(`${SKILLS_REL}/${skill}/agents/openai.yaml exists with explicit-only $orchestrator:${skill} prompt`, async () => {
      const yamlPath = skillsPath(PLUGIN_ROOT, skill, 'agents', 'openai.yaml');
      const text = await readFile(yamlPath, 'utf-8');
      // Contract: Codex reads openai.yaml — the listing fields, an explicit-only policy,
      // and a default prompt that mentions the skill (the only way to invoke it).
      ok(/display_name:/.test(text), 'openai.yaml has display_name');
      ok(/short_description:/.test(text), 'openai.yaml has short_description');
      ok(text.includes(`$orchestrator:${skill}`), `default prompt references $orchestrator:${skill}`);
      ok(/allow_implicit_invocation:\s*false/.test(text), 'implicit invocation disabled');
    });
  }

  it('next/done mirrors keep the dispatch handoff and the completion write', async () => {
    const next = await readFile(skillsPath(PLUGIN_ROOT, 'next/SKILL.md'), 'utf-8');
    // Contract: the engineer child reads these variables to link back to the macro —
    // without them the child is created unlinked and nothing records the subtask.
    ok(next.includes('AGENTIC_PARENT_WORKFLOW'), 'next documents parent workflow env');
    ok(next.includes('AGENTIC_ORIGINATING_SUBTASK'), 'next documents originating subtask env');
    // Contract: the Codex agent running $orchestrator:next — calling the verb skill
    // directly skips the engineer command's Phase 0, so no child workflow is created.
    ok(next.includes('Do not invoke `core/skills/<verb>/SKILL.md` directly'), 'next forbids bypassing engineer command Phase 0');
    // Contract: the Codex agent records the dispatch with subtask-update after create.
    ok(next.includes('subtask-update'), 'next documents post-create subtask-update');

    const done = await readFile(skillsPath(PLUGIN_ROOT, 'done/SKILL.md'), 'utf-8');
    // Contract: the Codex agent running $orchestrator:done completes the subtask with
    // this flag value.
    ok(done.includes('--status completed'), 'done documents completed subtask-update');
  });

  it('finalize/abort mirrors keep the lifecycle calls and the Codex Stop fallback helper', async () => {
    // Contract: the Codex agent running $orchestrator:finalize / :abort — the bulk
    // transition status, the child archive call, the terminal phase, and the stop
    // helper it runs when the Codex Stop hook is not loaded.
    const finalize = await readFile(skillsPath(PLUGIN_ROOT, 'finalize/SKILL.md'), 'utf-8');
    ok(finalize.includes('--to-status deferred'), 'finalize documents deferred bulk transition');
    ok(finalize.includes('detach-archive'), 'finalize documents detach-archive child path');
    ok(finalize.includes('--terminal-phase finalized'), 'finalize documents finalized terminal phase');
    ok(finalize.includes('adapters/codex/hooks/stop.mjs'), 'finalize documents Codex stop fallback helper');

    const abort = await readFile(skillsPath(PLUGIN_ROOT, 'abort/SKILL.md'), 'utf-8');
    ok(abort.includes('--to-status abandoned'), 'abort documents abandoned bulk transition');
    ok(abort.includes('detach-archive'), 'abort documents detach-archive child path');
    ok(abort.includes('--terminal-phase aborted'), 'abort documents aborted terminal phase');
    ok(abort.includes('adapters/codex/hooks/stop.mjs'), 'abort documents Codex stop fallback helper');
  });
});

describe('plugins/orchestrator commands/', () => {
  for (const cmd of ALL_COMMANDS) {
    it(`commands/${cmd}.md exists with description + argument-hint frontmatter`, async () => {
      const cmdPath = resolve(PLUGIN_ROOT, 'commands', `${cmd}.md`);
      const text = await readFile(cmdPath, 'utf-8');
      // Contract: Claude Code reads command frontmatter — description and argument-hint
      // list the command; a stray model or allowed-tools key pins the model or
      // narrows the tools the runbook needs.
      ok(text.startsWith('---\n'), `${cmd}.md starts with frontmatter`);
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, `${cmd}.md frontmatter is closed`);
      const fm = text.slice(4, fmEnd);
      ok(/^description:/m.test(fm), `${cmd}.md has description`);
      ok(/^argument-hint:/m.test(fm), `${cmd}.md has argument-hint`);
      ok(!/^model:/m.test(fm), `${cmd}.md has no model key (convention)`);
      ok(!/^allowed-tools:/m.test(fm), `${cmd}.md has no allowed-tools key (convention)`);
    });
  }

  it('/orchestrator:plan uses peer-runner.mjs for managed Plan-verify dispatch', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/plan.md'), 'utf-8');
    // Contract: the agent running /orchestrator:plan — Plan-verify goes through the
    // managed runner with the run id, and its run JSON is captured for the next step.
    ok(
      /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind ensemble[\s\S]{0,260}--run-id "\$RUN_ID"/.test(text),
      'commands/plan.md must dispatch managed Plan-verify through peer-runner.mjs run',
    );
    ok(
      /> "\$PROMPT_FILE\.run\.json"/.test(text),
      'commands/plan.md must capture peer-runner machine-readable run JSON',
    );
  });

  // Contract: the agent running /orchestrator:plan — dispatch-peer.mjs keeps no
  // peer-run ledger, so a Plan-verify it starts cannot be inspected, cancelled
  // or settled through peer-runner, and its pending entry is closed by hand.
  it('/orchestrator:plan does not route managed Plan-verify through dispatch-peer.mjs', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/plan.md'), 'utf-8');
    ok(
      !/scripts\/dispatch-peer\.mjs|dispatch-peer\.mjs"\s+\\/.test(text),
      'commands/plan.md should reserve dispatch-peer.mjs for compatibility/raw callers',
    );
  });

  it('meta command files delegate to matching skills', async () => {
    for (const meta of META_COMMANDS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${meta}.md`), 'utf-8');
      // Contract: the agent follows this path to the skill it runs — a wrong path
      // leaves the command without its steps.
      ok(text.includes(`${SKILLS_REL}/${meta}/SKILL.md`), `${meta}.md points at ${SKILLS_REL}/${meta}/SKILL.md`);
    }
  });

  it('/orchestrator:checkpoint uses checkpoint-set', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/checkpoint.md'), 'utf-8');
    // Contract: the agent running /orchestrator:checkpoint — without this call the
    // checkpoint is never written and SessionStart has nothing to re-inject.
    ok(/state\.mjs"\s+checkpoint-set/.test(text), 'checkpoint command calls checkpoint-set');
  });

  it('/orchestrator:peer-now runs peer-runner kind=peer-now with its status and cancel calls', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/peer-now.md'), 'utf-8');
    // Contract: the agent running /orchestrator:peer-now — the side-channel kind keeps
    // the run out of ensemble_results; status and cancel are the calls it controls it with.
    ok(/peer-runner\.mjs"\s+run[\s\S]{0,240}--kind peer-now/.test(text),
      'peer-now command calls peer-runner kind=peer-now');
    ok(/peer-runner\.mjs"\s+status/.test(text), 'peer-now command calls peer-runner status');
    ok(/peer-runner\.mjs"\s+cancel/.test(text), 'peer-now command calls peer-runner cancel');
  });

  it('/orchestrator:audit hands off to /orchestrator:plan', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/audit.md'), 'utf-8');
    // Contract: the agent running /orchestrator:audit — the alias expands to this plan
    // invocation, not to a verb of its own.
    ok(text.includes('/orchestrator:plan Audit follow-up'), 'audit maps to plan follow-up');
  });
});

describe('plugins/orchestrator Claude-only commands', () => {
  for (const cmd of CLAUDE_ONLY_COMMANDS) {
    it(`/orchestrator:${cmd} has no Codex skill`, async () => {
      let mirrored = true;
      try {
        await stat(resolve(PLUGIN_ROOT, SKILLS_REL, cmd));
      } catch {
        mirrored = false;
      }
      // Contract: Codex loads every directory under the skills root as a skill — a
      // mirror would offer a Claude-only command on Codex.
      strictEqual(mirrored, false, `${SKILLS_REL}/${cmd}/ must not exist: the command is a Claude adapter`);
    });
  }

  it('the autopilot adapter ships its entry and launcher executable, and the rest as modules', async () => {
    const dir = resolve(PLUGIN_ROOT, 'adapters/claude/autopilot');
    const entries = (await readdir(dir)).sort();
    deepStrictEqual(entries, ['cli.mjs', 'driver.mjs', 'landing-ready.mjs', 'launcher.template.mjs', 'ledger.mjs', 'observe.mjs', 'policy.mjs', 'roots.mjs', 'worker.mjs']);
    // Contract: the runbook and the launcher exec these files directly — without the
    // executable bit and a node shebang the exec fails.
    for (const exe of ['cli.mjs', 'launcher.template.mjs']) {
      const st = await stat(resolve(dir, exe));
      ok((st.mode & 0o111) !== 0, `${exe} is executable`);
      ok((await readFile(resolve(dir, exe), 'utf-8')).startsWith('#!/usr/bin/env node\n'), `${exe} has a node shebang`);
    }
  });

  it('the autopilot imports nothing from another plugin', async () => {
    const dir = resolve(PLUGIN_ROOT, 'adapters/claude/autopilot');
    for (const name of await readdir(dir)) {
      const text = await readFile(resolve(dir, name), 'utf-8');
      // Contract: Node resolves these specifiers in the installed plugin — a path into
      // another plugin does not exist where the plugin is installed alone.
      for (const m of text.matchAll(/^import [^;]*? from '([^']+)';$/gms)) {
        const spec = m[1];
        ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../../../scripts/'), `${name} imports ${spec}`);
      }
    }
  });
});
