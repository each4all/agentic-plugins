// plugins/orchestrator plugin-shape conformance test (Stage 3+ ADR-0018
// §sub-decision-1 plan-only MVP).
//
// Mirrors tests/plugin-shape/test-engineer-plugin.mjs structure with
// orchestrator-specific plan-only shape:
//   - 2 manifests (Claude + Codex)
//   - 1 verb skill (plan) × {SKILL.md, agents/openai.yaml}
//   - 2 shared references (presentation-protocol, ensemble-protocol)
//     — engineer's orchestration.md / agent-taxonomy.md are explicitly
//     engineer-internal per ADR-0010 §5 cross-plugin import ban; the
//     orchestrator MVP intentionally ships a strict subset
//   - 4 host-shared canonical scripts (state.mjs, dispatch-peer.mjs,
//     peer-runner.mjs, stop-archive.mjs)
//   - 1 verb command (plan), 2 dispatch commands (next/done),
//     finalize/abort lifecycle commands, 3 meta commands
//     (resume/checkpoint/peer-now), and an audit follow-up alias
//   - 4 Claude adapter hooks (pre-compact, stop, session-start, _shared)
//   - 3 Codex adapter hooks (session-start / pre-compact / stop) plus a
//     Node resolver wrapper and Codex-specific hook manifest
//   - 1 bundled Claude hooks manifest (hooks/hooks.json) declaring SessionStart,
//     PreCompact, and Stop. The Codex manifest's `hooks` field points at
//     adapters/codex/hooks/hooks.json.
//
// This verifies manifest + marketplace + hooks + command shape. The
// tests/orchestrator/ suite covers state.mjs, dispatch-peer.mjs,
// peer-runner.mjs, hook behavior, and command-mode flow.
//
// Run via `node --test tests/plugin-shape/test-orchestrator-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const RELEASE_PLEASE_PR = process.env.AGENTIC_RELEASE_PLEASE_PR === '1';

const VERBS = ['plan'];
const ALIAS_VERBS = ['audit'];
// ADR-0019 PR-D — orchestrator dispatch commands. `next` and `done`
// are slash-command runbooks (same-host dispatch + manual backup);
// they are NOT 6-verb persona commands (those live in engineer).
const DISPATCH_COMMANDS = ['next', 'done'];
const LIFECYCLE_COMMANDS = ['finalize', 'abort'];
const META_COMMANDS = ['resume', 'checkpoint', 'peer-now'];
const DISPATCH_AND_LIFECYCLE_SKILLS = [...DISPATCH_COMMANDS, ...LIFECYCLE_COMMANDS];
const ALL_COMMANDS = [...VERBS, ...ALIAS_VERBS, ...DISPATCH_COMMANDS, ...LIFECYCLE_COMMANDS, ...META_COMMANDS];
const SHARED_REFS = ['ensemble-protocol.md', 'presentation-protocol.md', 'session-handoff.md'];
const HOST_SHARED_SCRIPTS = ['state.mjs', 'dispatch-peer.mjs', 'peer-runner.mjs', 'stop-archive.mjs'];
const CLAUDE_HOOKS = ['_shared.mjs', 'session-start.mjs', 'pre-compact.mjs', 'stop.mjs'];
const CODEX_HOOK_HELPERS = ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs', 'run-node-hook.sh', 'hooks.json', 'README.md'];

// Stale tokens that should NEVER appear in orchestrator SKILL/commands/refs.
// Mirrors test-engineer-plugin.mjs and reflects the schema-2 ensemble
// taxonomy host-agnostic switch (LOCAL-ONLY / PEER-ONLY) — host-source
// labels (CLAUDE-ONLY / CODEX-ONLY / [Claude] / [Codex]) are forbidden.
const STALE_TOKENS = [
  'omcc-research',
  '/omcc-research',
  'CODEX_HOME',
  'CLAUDE-ONLY',
  'CODEX-ONLY',
  '[Claude]',
  '[Codex]',
];

async function readJSON(path) {
  const text = await readFile(path, 'utf-8');
  return JSON.parse(text);
}

function compareSemver(a, b) {
  const left = String(a).split('.').map((part) => Number(part));
  const right = String(b).split('.').map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

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
    strictEqual(typeof manifest.skills, 'string');
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
    ok(
      manifest.interface.longDescription.includes('Codex skills mirror plan, next, done, finalize, abort, resume, checkpoint, and peer-now'),
      'longDescription documents the Codex skill mirror surface',
    );
    ok(
      manifest.interface.longDescription.includes('.agentic-plugins/state/orchestrator/workflows/'),
      'longDescription documents the canonical ADR-0025 workflow home',
    );
    ok(
      !manifest.interface.longDescription.includes('[features].plugin_hooks = true'),
      'longDescription no longer claims the removed plugin_hooks flag as the current gate',
    );
  });

  it('Claude and Codex manifests share name + version + description', async () => {
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const codex = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(claude.name, codex.name);
    strictEqual(claude.version, codex.version);
    strictEqual(claude.description, codex.description);
    strictEqual(claude.license, codex.license);
    deepStrictEqual(claude.keywords, codex.keywords);
  });
});

describe('plugins/orchestrator marketplace registration', () => {
  it('Claude marketplace catalog has orchestrator entry with matching version', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'orchestrator');
    ok(entry, 'orchestrator entry present in Claude catalog');
    strictEqual(entry.source, './plugins/orchestrator');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    if (RELEASE_PLEASE_PR && entry.version !== manifest.version) {
      ok(compareSemver(entry.version, manifest.version) <= 0, 'release-please PR may have catalog version lag until post-release sync');
    } else {
      strictEqual(entry.version, manifest.version, 'catalog version matches manifest');
    }
    strictEqual(entry.category, 'Productivity');
  });

  it('Codex marketplace catalog has orchestrator entry with matching policy/source', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'orchestrator');
    ok(entry, 'orchestrator entry present in Codex catalog');
    strictEqual(entry.source.source, 'local');
    strictEqual(entry.source.path, './plugins/orchestrator');
    strictEqual(entry.policy.installation, 'AVAILABLE');
    strictEqual(entry.policy.authentication, 'ON_USE');
    strictEqual(entry.category, 'Productivity');
  });

  it('release-please manifest tracks orchestrator at the same version', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const releasePleaseManifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(releasePleaseManifest['plugins/orchestrator'], manifest.version);
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

describe('plugins/orchestrator README + CHANGELOG', () => {
  it('README documents the full ADR-0019 PR-A..PR-E lifecycle surface', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf-8');
    // PR-D: /next + /done.
    ok(readme.includes('/orchestrator:next'), 'README documents /orchestrator:next');
    ok(readme.includes('/orchestrator:done'), 'README documents /orchestrator:done');
    // PR-E: /finalize + /abort + macro auto-archive (no longer "deferred").
    ok(readme.includes('/orchestrator:finalize'), 'README documents /orchestrator:finalize');
    ok(readme.includes('/orchestrator:abort'), 'README documents /orchestrator:abort');
    ok(/macro.*(auto.?archive|A1.?A4)/i.test(readme),
      'README documents macro auto-archive A1-A4 gates');
    // PR-B schema 1.1.
    ok(/schema:?\s*['"]?1\.1['"]?/.test(readme), 'README documents schema 1.1');
    ok(readme.includes('macro-<verb>-<iso>-<rand>') || readme.includes('macro-&lt;verb&gt;'), 'README documents workflow_id format');
    // PR-E Stop hook now auto-archives — snapshot-only language must be retired.
    ok(!/snapshot.?only/i.test(readme),
      'README no longer documents Stop as snapshot-only (PR-E ships auto-archive)');
    // Codex hook scope wording must remain explicit and current (ADR-0030
    // stage-aware gate: generic [features].hooks, not the removed flag).
    ok(/\[features\]\.hooks/.test(readme),
      'README documents the generic Codex [features].hooks gate');
    ok(!/\[features\]\.plugin_hooks\s*=\s*true/i.test(readme),
      'README no longer claims the removed plugin_hooks flag as the current gate');
    ok(/manual fallback/i.test(readme),
      'README documents Codex fallback helper');
  });

  it('CHANGELOG exists with 0.1.0 initial entry', async () => {
    const changelog = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf-8');
    ok(changelog.includes('0.1.0'), 'CHANGELOG contains 0.1.0');
    ok(/plan-only MVP/i.test(changelog), 'CHANGELOG flags plan-only MVP');
  });
});

// ---------------------------------------------------------------------------
// Phase 5 plugin-shape boost — script / hook / skill / command presence

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
  it('README.md documents the ADR-0030 stage-aware Codex hook gate', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/README.md'), 'utf-8');
    // Current gate must be the generic [features].hooks model, and the legacy
    // plugin_hooks=true literal may appear ONLY qualified as legacy-only
    // (Codex Phase 5 review MINOR — hub README wording was previously unguarded).
    ok(/\[features\]\.hooks/.test(text), 'hub README documents the generic Codex [features].hooks gate');
    ok(/removed in Codex/i.test(text) && /legacy Codex/i.test(text),
      'hub README qualifies plugin_hooks=true as legacy-only (removed on current Codex), not the current gate');
  });
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

describe('plugins/orchestrator skills/', () => {
  for (const verb of VERBS) {
    it(`skills/${verb}/SKILL.md exists with frontmatter name === ${verb}`, async () => {
      const skillPath = resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      ok(text.startsWith('---\n'), 'SKILL.md starts with frontmatter');
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, 'SKILL.md frontmatter is closed');
      const fm = text.slice(4, fmEnd);
      ok(new RegExp(`^name:\\s*${verb}\\s*$`, 'm').test(fm),
        `SKILL.md frontmatter name is ${verb}`);
      ok(/^description:/m.test(fm), 'SKILL.md frontmatter has description');
    });

    it(`skills/${verb}/SKILL.md documents both Claude and Codex explicit entry tokens`, async () => {
      const skillPath = resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      const heading = text.match(/^## When invoked by command .+$/m)?.[0] ?? '';
      ok(heading.includes(`/orchestrator:${verb}`), `skills/${verb}/SKILL.md missing Claude /orchestrator:${verb} entry token`);
      ok(heading.includes(`$orchestrator:${verb}`), `skills/${verb}/SKILL.md missing Codex $orchestrator:${verb} entry token`);
      ok(/Claude command/i.test(heading), `skills/${verb}/SKILL.md must label the Claude command entry path`);
      ok(/Codex skill mention/i.test(heading), `skills/${verb}/SKILL.md must label the Codex skill entry path`);
    });

    it(`skills/${verb}/agents/openai.yaml exists with display_name`, async () => {
      const yamlPath = resolve(PLUGIN_ROOT, 'skills', verb, 'agents', 'openai.yaml');
      const text = await readFile(yamlPath, 'utf-8');
      ok(/display_name:/.test(text), 'openai.yaml has display_name');
      ok(/short_description:/.test(text), 'openai.yaml has short_description');
    });
  }

  for (const ref of SHARED_REFS) {
    it(`skills/_shared/references/${ref} exists`, async () => {
      const refPath = resolve(PLUGIN_ROOT, 'skills/_shared/references', ref);
      const text = await readFile(refPath, 'utf-8');
      ok(text.length > 100, `${ref} has substantive content`);
    });
  }

  it('does NOT ship engineer-internal references (orchestration.md, agent-taxonomy.md)', async () => {
    for (const banned of ['orchestration.md', 'agent-taxonomy.md']) {
      const p = resolve(PLUGIN_ROOT, 'skills/_shared/references', banned);
      let exists = true;
      try {
        await stat(p);
      } catch (err) {
        if (err.code === 'ENOENT') exists = false;
      }
      strictEqual(exists, false, `${banned} absent (engineer-internal per ADR-0010 §5)`);
    }
  });

  it('plan skill documents opposite-host peer semantics, not Codex-only command semantics', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/plan/SKILL.md'), 'utf-8');
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/plan/agents/openai.yaml'), 'utf-8');
    const protocol = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf-8');
    const planDocs = `${skill}\n${protocol}`;

    for (const phrase of [
      'Plan-verify opposite-host peer ensemble',
      '`peer-runner.mjs run --kind ensemble --peer <opposite-host>',
      '`state.mjs plan-set --workflow-path <path> --host <current-host>',
      'Claude invokes Codex; Codex invokes Claude',
      'opposite-host peer review',
      'Opposite-host peer ensemble unavailable',
      'Opposite-host peer analysis did not complete',
    ]) {
      ok(planDocs.includes(phrase), `orchestrator plan docs missing host-neutral phrase: ${phrase}`);
    }
    ok(agent.includes('opposite-host peer ensemble'), 'plan agent prompt must be host-neutral');

    for (const pattern of [
      /Plan-verify Codex/,
      /Codex peer ensemble/,
      /--peer codex/,
      /--host claude --subtasks-json-file/,
      /orchestrator and Codex/,
      /Codex surfaced/,
      /Codex peer review/,
      /Codex ensemble unavailable/,
      /configure the Codex peer/,
      /Codex peer analysis/,
    ]) {
      ok(!pattern.test(skill), `skills/plan/SKILL.md must not hard-code Codex-only plan peer wording: ${pattern}`);
      ok(!pattern.test(agent), `skills/plan/agents/openai.yaml must not hard-code Codex-only plan peer wording: ${pattern}`);
      ok(!pattern.test(protocol), `ensemble-protocol.md must not hard-code Codex-only plan peer wording: ${pattern}`);
    }
  });

  it('orchestrator README presents Plan-verify as opposite-host peer behavior', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf-8');
    const rootReadme = await readFile(resolve(REPO_ROOT, 'README.md'), 'utf-8');

    for (const phrase of [
      'Plan-verify opposite-host peer ensemble',
      'If the opposite-host companion is unavailable',
      'Plan-verify opposite-host peer ensemble inside `/orchestrator:plan`',
    ]) {
      ok(readme.includes(phrase), `orchestrator README missing host-neutral phrase: ${phrase}`);
    }

    for (const pattern of [
      /Plan-verify Codex ensemble/,
      /Plan-verify Codex peer/,
      /Codex companion is unavailable/,
      /Plan-verify Codex ensemble inside/,
    ]) {
      ok(!pattern.test(readme), `orchestrator README must not hard-code Codex-only plan peer wording: ${pattern}`);
      ok(!pattern.test(rootReadme), `root README must not hard-code Codex-only plan peer wording: ${pattern}`);
    }
  });
});

describe('plugins/orchestrator meta skills/', () => {
  for (const meta of META_COMMANDS) {
    it(`skills/${meta}/SKILL.md exists with frontmatter name === ${meta}`, async () => {
      const skillPath = resolve(PLUGIN_ROOT, 'skills', meta, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      ok(text.startsWith('---\n'), 'SKILL.md starts with frontmatter');
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, 'SKILL.md frontmatter is closed');
      const fm = text.slice(4, fmEnd);
      ok(new RegExp(`^name:\\s*${meta}\\s*$`, 'm').test(fm),
        `SKILL.md frontmatter name is ${meta}`);
      ok(/^description:/m.test(fm), 'SKILL.md frontmatter has description');
      ok(/## Host availability/.test(text), `${meta} skill documents host availability`);
      ok(text.includes('--host codex'), `${meta} skill documents Codex host flag`);
    });

    it(`skills/${meta}/agents/openai.yaml exists with display_name`, async () => {
      const yamlPath = resolve(PLUGIN_ROOT, 'skills', meta, 'agents', 'openai.yaml');
      const text = await readFile(yamlPath, 'utf-8');
      ok(/display_name:/.test(text), 'openai.yaml has display_name');
      ok(/short_description:/.test(text), 'openai.yaml has short_description');
      ok(text.includes(`$orchestrator:${meta}`), `default prompt references $orchestrator:${meta}`);
      ok(/allow_implicit_invocation:\s*false/.test(text), 'implicit invocation disabled');
    });
  }
});

describe('plugins/orchestrator dispatch + lifecycle Codex skill mirrors/', () => {
  for (const skill of DISPATCH_AND_LIFECYCLE_SKILLS) {
    it(`skills/${skill}/SKILL.md mirrors /orchestrator:${skill} for Codex`, async () => {
      const skillPath = resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      ok(text.startsWith('---\n'), 'SKILL.md starts with frontmatter');
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, 'SKILL.md frontmatter is closed');
      const fm = text.slice(4, fmEnd);
      ok(new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(fm),
        `SKILL.md frontmatter name is ${skill}`);
      ok(/^description:/m.test(fm), 'SKILL.md frontmatter has description');
      ok(text.includes('## Host availability'), `${skill} skill documents host availability`);
      ok(text.includes('## Command resolution'), `${skill} skill documents command resolution`);
      ok(text.includes(`/orchestrator:${skill}`), `${skill} skill documents Claude entry token`);
      ok(text.includes(`$orchestrator:${skill}`), `${skill} skill documents Codex entry token`);
      ok(text.includes(`commands/${skill}.md`), `${skill} skill points to canonical command runbook`);
      ok(text.includes('--host codex'), `${skill} skill documents Codex host flag`);
    });

    it(`skills/${skill}/agents/openai.yaml exists with explicit-only $orchestrator:${skill} prompt`, async () => {
      const yamlPath = resolve(PLUGIN_ROOT, 'skills', skill, 'agents', 'openai.yaml');
      const text = await readFile(yamlPath, 'utf-8');
      ok(/display_name:/.test(text), 'openai.yaml has display_name');
      ok(/short_description:/.test(text), 'openai.yaml has short_description');
      ok(text.includes(`$orchestrator:${skill}`), `default prompt references $orchestrator:${skill}`);
      ok(/allow_implicit_invocation:\s*false/.test(text), 'implicit invocation disabled');
    });
  }

  it('next/done mirrors preserve same-host dispatch and completion invariants', async () => {
    const next = await readFile(resolve(PLUGIN_ROOT, 'skills/next/SKILL.md'), 'utf-8');
    ok(next.includes('AGENTIC_PARENT_WORKFLOW'), 'next documents parent workflow env');
    ok(next.includes('AGENTIC_ORIGINATING_SUBTASK'), 'next documents originating subtask env');
    ok(next.includes('Do not invoke `skills/<verb>/SKILL.md` directly'), 'next forbids bypassing engineer command Phase 0');
    ok(next.includes('subtask-update'), 'next documents post-create subtask-update');

    const done = await readFile(resolve(PLUGIN_ROOT, 'skills/done/SKILL.md'), 'utf-8');
    ok(done.includes('engineer_workflow_id'), 'done documents engineer workflow ownership');
    ok(done.includes('refs/heads/<subtask.branch>'), 'done documents branch-tip commit resolution');
    ok(done.includes('status completed'), 'done documents completed subtask-update');
  });

  it('finalize/abort mirrors preserve lifecycle lock order plus Codex Stop hook fallback boundary', async () => {
    const finalize = await readFile(resolve(PLUGIN_ROOT, 'skills/finalize/SKILL.md'), 'utf-8');
    ok(finalize.includes('--to-status deferred'), 'finalize documents deferred bulk transition');
    ok(finalize.includes('detach-archive'), 'finalize documents detach-archive child path');
    ok(finalize.includes('--terminal-phase finalized'), 'finalize documents finalized terminal phase');
    ok(finalize.includes('[features].hooks'), 'finalize documents the generic Codex hook gate (ADR-0030)');
    ok(!finalize.includes('[features].plugin_hooks = true'), 'finalize no longer claims the removed plugin_hooks flag');
    ok(finalize.includes('/hooks` review/trust'), 'finalize documents Codex hook review/trust requirement');
    ok(finalize.includes('adapters/codex/hooks/stop.mjs'), 'finalize documents Codex stop fallback helper');

    const abort = await readFile(resolve(PLUGIN_ROOT, 'skills/abort/SKILL.md'), 'utf-8');
    ok(abort.includes('--to-status abandoned'), 'abort documents abandoned bulk transition');
    ok(abort.includes('detach-archive'), 'abort documents detach-archive child path');
    ok(abort.includes('--terminal-phase aborted'), 'abort documents aborted terminal phase');
    ok(abort.includes('[features].hooks'), 'abort documents the generic Codex hook gate (ADR-0030)');
    ok(!abort.includes('[features].plugin_hooks = true'), 'abort no longer claims the removed plugin_hooks flag');
    ok(abort.includes('/hooks` review/trust'), 'abort documents Codex hook review/trust requirement');
    ok(abort.includes('adapters/codex/hooks/stop.mjs'), 'abort documents Codex stop fallback helper');
  });
});

describe('plugins/orchestrator commands/', () => {
  for (const cmd of ALL_COMMANDS) {
    it(`commands/${cmd}.md exists with description + argument-hint frontmatter`, async () => {
      const cmdPath = resolve(PLUGIN_ROOT, 'commands', `${cmd}.md`);
      const text = await readFile(cmdPath, 'utf-8');
      ok(text.startsWith('---\n'), `${cmd}.md starts with frontmatter`);
      const fmEnd = text.indexOf('\n---\n', 4);
      ok(fmEnd > 0, `${cmd}.md frontmatter is closed`);
      const fm = text.slice(4, fmEnd);
      ok(/^description:/m.test(fm), `${cmd}.md has description`);
      ok(/^argument-hint:/m.test(fm), `${cmd}.md has argument-hint`);
      // Engineer commands convention: no model / allowed-tools keys.
      ok(!/^model:/m.test(fm), `${cmd}.md has no model key (convention)`);
      ok(!/^allowed-tools:/m.test(fm), `${cmd}.md has no allowed-tools key (convention)`);
    });
  }

  it('ships /orchestrator:finalize + /orchestrator:abort commands (ADR-0019 PR-E §5)', async () => {
    for (const required of ['finalize', 'abort']) {
      const p = resolve(PLUGIN_ROOT, 'commands', `${required}.md`);
      const st = await stat(p);
      ok(st.isFile(), `${required}.md is a file`);
    }
  });

  it('/orchestrator:plan uses peer-runner.mjs for managed Plan-verify dispatch (ADR-0023 PR-D)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/plan.md'), 'utf-8');
    ok(
      /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind ensemble[\s\S]{0,260}--run-id "\$RUN_ID"/.test(text),
      'commands/plan.md must dispatch managed Plan-verify through peer-runner.mjs run',
    );
    ok(
      /> "\$PROMPT_FILE\.run\.json"/.test(text),
      'commands/plan.md must capture peer-runner machine-readable run JSON',
    );
  });

  it('/orchestrator:plan no longer routes managed Plan-verify through dispatch-peer.mjs', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/plan.md'), 'utf-8');
    ok(
      !/scripts\/dispatch-peer\.mjs|dispatch-peer\.mjs"\s+\\/.test(text),
      'commands/plan.md should reserve dispatch-peer.mjs for compatibility/raw callers',
    );
  });

  it('meta command files delegate to matching skills and preserve orchestrator namespace', async () => {
    for (const meta of META_COMMANDS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${meta}.md`), 'utf-8');
      ok(text.includes(`skills/${meta}/SKILL.md`), `${meta}.md points at skills/${meta}/SKILL.md`);
      ok(text.includes('agentic-orchestrator'), `${meta}.md uses orchestrator workflow namespace`);
    }
  });

  it('/orchestrator:checkpoint uses checkpoint-set and documents Codex hook-gate boundary', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/checkpoint.md'), 'utf-8');
    ok(/state\.mjs"\s+checkpoint-set/.test(text), 'checkpoint command calls checkpoint-set');
    ok(text.includes('latest_checkpoint'), 'checkpoint command documents latest_checkpoint');
    ok(/\[features\]\.hooks/.test(text),
      'checkpoint command documents the generic Codex hook gate (ADR-0030)');
    ok(!/\[features\]\.plugin_hooks\s*=\s*true/.test(text),
      'checkpoint command no longer claims the removed plugin_hooks flag');
  });

  it('/orchestrator:peer-now uses peer-runner side-channel and excludes ensemble_results', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/peer-now.md'), 'utf-8');
    ok(/peer-runner\.mjs"\s+run[\s\S]{0,240}--kind peer-now/.test(text),
      'peer-now command calls peer-runner kind=peer-now');
    ok(/never writes[\s\S]{0,80}ensemble_results/i.test(text),
      'peer-now command excludes ensemble_results');
    ok(/status[\s\S]{0,120}cancel/.test(text), 'peer-now documents status/cancel controls');
  });

  it('/orchestrator:audit canonicalizes to /orchestrator:plan, not a new verb', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/audit.md'), 'utf-8');
    ok(text.includes('/orchestrator:plan Audit follow-up'), 'audit maps to plan follow-up');
    ok(text.includes('verb=plan'), 'audit preserves plan verb');
    ok(text.includes('macro-plan-'), 'audit preserves macro-plan workflow id shape');
    ok(!text.includes('macro-audit-'), 'audit must not introduce macro-audit workflow ids');
  });

  it('terminal completion commands defer to the code-emitted runtime completion footer (ADR-0039)', async () => {
    // done/finalize/abort reach the fireMacroHandoffSidecar terminal path, so
    // their footer is CODE-EMITTED (ADR-0039 §9) — the prose must defer to it,
    // not hand-compose a duplicate. Guard the new contract phrasing AND the
    // removal of the old "render the same fields manually" hand-compose line.
    for (const cmd of ['done', 'finalize', 'abort']) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${cmd}.md`), 'utf-8');
      ok(/runtime completion footer/i.test(text), `commands/${cmd}.md missing runtime footer guidance`);
      ok(/code-emitted/i.test(text), `commands/${cmd}.md must state the footer is code-emitted (ADR-0039 §9)`);
      ok(!/render the same fields manually/i.test(text), `commands/${cmd}.md must not instruct hand-composing the footer`);
      ok(/advisory/i.test(text), `commands/${cmd}.md must mark footer advisory`);
      ok(/pointer-only/i.test(text), `commands/${cmd}.md must keep footer pointer-only`);
      ok(
        /(do not\s+mutate|never\s+mutates)\s+host\s+session\s+context/i.test(text),
        `commands/${cmd}.md must forbid host session context mutation`,
      );
    }
  });

  it('non-terminal completion commands keep the hand-composed runtime completion footer contract', async () => {
    // plan/next do NOT reach the terminal sidecar path (they mark a macro/subtask
    // active, not terminal), so they still hand-compose the footer — the ADR-0039
    // §9 code-emit de-dup is scoped to the terminal surfaces (done/finalize/abort).
    for (const cmd of ['plan', 'next']) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${cmd}.md`), 'utf-8');
      ok(/runtime completion footer/i.test(text), `commands/${cmd}.md missing runtime footer guidance`);
      ok(/advisory/i.test(text), `commands/${cmd}.md must mark footer advisory`);
      ok(/pointer-only/i.test(text), `commands/${cmd}.md must keep footer pointer-only`);
      ok(/do not mutate host session\s+context/i.test(text), `commands/${cmd}.md must forbid context mutation`);
    }
  });
});

describe('plugins/orchestrator stale-token audit', () => {
  // Stale tokens (CLAUDE-ONLY / CODEX-ONLY / [Claude] / [Codex] /
  // CODEX_HOME / omcc-research) MUST NOT appear in any orchestrator doc.
  // Bodies MAY cite engineer / omcc-dev as experiential references per
  // ADR-0007.
  //
  // PR #53 SUGGESTION (e) — audit scope expansion to all orchestrator
  // docs. Engineer audit (test-engineer-plugin.mjs) covers SKILL.md +
  // shared refs only; orchestrator extends to all .md files for tighter
  // regression safety. Asymmetry is intentional and tracked in the
  // workflow record; future engineer audit expansion would re-symmetrize.
  const ALL_AUDIT_DOCS = [
    'README.md',
    'CHANGELOG.md',
    'commands/plan.md',
    'commands/next.md',     // ADR-0019 PR-D
    'commands/done.md',     // ADR-0019 PR-D
    'commands/finalize.md', // ADR-0019 PR-E
    'commands/abort.md',    // ADR-0019 PR-E
    'commands/resume.md',
    'commands/checkpoint.md',
    'commands/peer-now.md',
    'commands/audit.md',
    'skills/plan/SKILL.md',
    'skills/next/SKILL.md',
    'skills/done/SKILL.md',
    'skills/finalize/SKILL.md',
    'skills/abort/SKILL.md',
    'skills/resume/SKILL.md',
    'skills/checkpoint/SKILL.md',
    'skills/peer-now/SKILL.md',
    ...SHARED_REFS.map((ref) => `skills/_shared/references/${ref}`),
    'adapters/codex/hooks/README.md',
  ];
  for (const doc of ALL_AUDIT_DOCS) {
    it(`${doc} contains no stale tokens`, async () => {
      const docPath = resolve(PLUGIN_ROOT, doc);
      const text = await readFile(docPath, 'utf-8');
      for (const stale of STALE_TOKENS) {
        ok(!text.includes(stale), `${doc} must not contain ${stale}`);
      }
    });
  }
});

// ADR-0029 §1 — orch-next-action-shape. A macro-completion surface must replace
// the fixed lifecycle literal (e.g. always "recommend /orchestrator:next") with
// the evidence-based Active Next-Action Proposal derived from the macro state.
// Mirrors the engineer shape guard (test-engineer-plugin.mjs six-verb Active
// Next-Action Proposal checks), adapted to orchestrator's HETEROGENEOUS macro
// surfaces: the "active planning/dispatch" surfaces (plan + next, on BOTH the
// Claude command and the Codex skill mirror) carry the full six-field proposal;
// the meta guard paths (checkpoint/resume no-active-workflow) carry the compact
// meta/guard-exception pointer, not the full proposal — exactly as the engineer
// meta skills are excluded from the six-verb proposal guard. The orchestrator
// does NOT own the contract: its local wiring (session-handoff.md) cites the
// engineer canonical entry-routing-contract.md BY NAME (ADR-0010 §5 copy-not-
// import single source), so completion surfaces cite session-handoff.md.
describe('plugins/orchestrator — ADR-0029 §1 Active Next-Action Proposal (orch-next-action-shape)', () => {
  const PROPOSAL_FIELDS = [
    'selected_next',
    'rejected_alternatives',
    'rationale',
    'evidence_pointers',
    'confidence',
    'next_command',
  ];

  // Bound the field checks to the ## Completion section (up to the next ##
  // heading) so they assert presence IN the proposal, not anywhere downstream.
  const completionRegionOf = (text) => {
    const compIdx = text.indexOf('## Completion');
    if (compIdx === -1) return null;
    const afterHeading = text.slice(compIdx + '## Completion'.length);
    const nextHeadingRel = afterHeading.search(/\n##\s/);
    return nextHeadingRel === -1
      ? text.slice(compIdx)
      : text.slice(compIdx, compIdx + '## Completion'.length + nextHeadingRel);
  };

  // The FORWARD-DECISION surfaces (plan + next + done, on both hosts) — those
  // whose completion leaves a genuine "what next?" choice. plan.md additionally
  // carries the durable Phase 2 NOTE skeleton locus (the state.mjs phase note),
  // like the engineer verb commands; the Codex skills, next.md, and done.md
  // carry the single Completion locus. done is a HYBRID: its Completion hosts the
  // proposal for the subtasks-remain path AND defers to the footer on the
  // auto-terminal path — the terminal-close guard below covers the latter.
  // finalize/abort are terminal closes (footer-only) — asserted separately.
  const PROPOSAL_SURFACES = [
    { path: 'commands/plan.md', phase2: true },
    { path: 'commands/next.md', phase2: false },
    { path: 'commands/done.md', phase2: false },
    { path: 'skills/plan/SKILL.md', phase2: false },
    { path: 'skills/next/SKILL.md', phase2: false },
    { path: 'skills/done/SKILL.md', phase2: false },
  ];

  for (const surface of PROPOSAL_SURFACES) {
    it(`${surface.path} emits the Active Next-Action Proposal (all six fields, cites the contract) and drops the fixed literal`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, surface.path), 'utf-8');

      // (1) Fixed-literal anti-patterns (ADR-0029 W1) must be gone. Two targeted
      // markers — NOT a blanket ban on "/orchestrator:next", which the runbook
      // prose legitimately mentions throughout next.md / plan.md:
      //   (a) the plan.md NOTE heading "### Recommended next step"
      //   (b) the "Recommended next: `/orchestrator:…`" bare single-command form
      ok(!/###\s+Recommended next step/.test(text),
        `${surface.path} still carries the "### Recommended next step" fixed literal (ADR-0029 W1)`);
      ok(!/Recommended next:\s*`\/orchestrator:/.test(text),
        `${surface.path} still carries a "Recommended next: \`/orchestrator:…\`" fixed literal (ADR-0029 W1)`);

      // (2) The Completion section hosts the proposal.
      const completionRegion = completionRegionOf(text);
      ok(completionRegion !== null,
        `${surface.path} has no "## Completion" section to host the proposal (ADR-0029 §1)`);
      ok(/Active Next-Action Proposal/i.test(completionRegion),
        `${surface.path} Completion must reference the Active Next-Action Proposal (ADR-0029 §1)`);
      // (3) Cites the orchestrator-local contract wiring (which cites the
      // engineer canonical BY NAME — ADR-0010 §5). Assert the basename
      // session-handoff.md to stay robust to the mixed path conventions across
      // orchestrator command (skills/_shared/…) vs skill (../_shared/…) surfaces.
      ok(/session-handoff\.md/.test(completionRegion),
        `${surface.path} Completion must cite the orchestrator-local session-handoff.md contract wiring (ADR-0029 §1)`);
      for (const field of PROPOSAL_FIELDS) {
        // Require each field as a **bold** proposal field or a "- field:"
        // skeleton line — NOT a bare token. A generic sentence merely listing
        // the six field names (a stub) would pass includes() but fails this.
        ok(new RegExp(`\\*\\*${field}\\*\\*|-\\s+${field}:`).test(completionRegion),
          `${surface.path} Completion must present "${field}" as a **bold** proposal field or a "- ${field}:" skeleton line, not a bare token (ADR-0029 §1 proposal shape — prevents a token-list stub from passing)`);
      }

      // (4) plan.md's durable Phase 2 NOTE skeleton locus (before ## Completion).
      if (surface.phase2) {
        const compIdx = text.indexOf('## Completion');
        const phase2Region = text.slice(0, compIdx);
        ok(/###\s+Active next-action proposal/i.test(phase2Region),
          `${surface.path} Phase 2 NOTE must record the "### Active next-action proposal" skeleton (ADR-0029 §1)`);
        ok(/session-handoff\.md/.test(phase2Region),
          `${surface.path} Phase 2 NOTE must cite the session-handoff.md contract wiring (ADR-0029 §1)`);
        for (const field of PROPOSAL_FIELDS) {
          ok(new RegExp(`-\\s+${field}:`).test(phase2Region),
            `${surface.path} Phase 2 NOTE skeleton is missing the "- ${field}:" line (ADR-0029 §1 proposal shape)`);
        }
      }
    });
  }

  it('skills/_shared/references/session-handoff.md documents the proposal + cites the engineer canonical BY NAME (ADR-0010 §5 single source)', async () => {
    const text = await readFile(
      resolve(PLUGIN_ROOT, 'skills/_shared/references/session-handoff.md'), 'utf-8');
    ok(/Active Next-Action Proposal/.test(text),
      'session-handoff.md must document the Active Next-Action Proposal (ADR-0029)');
    ok(/entry-routing-contract\.md/.test(text),
      'session-handoff.md must cite the engineer canonical entry-routing-contract.md BY NAME (ADR-0010 §5 single source)');
    // Cited BY NAME, never imported by a cross-plugin path (ADR-0010 §5).
    ok(!/plugins\/engineer/.test(text) && !/\.\.\/\.\.\/engineer/.test(text),
      'session-handoff.md must not reach the engineer contract by a cross-plugin path — cite it by name (ADR-0010 §5)');
    for (const field of PROPOSAL_FIELDS) {
      ok(text.includes(field),
        `session-handoff.md proposal wiring is missing the "${field}" field (ADR-0029 §1)`);
    }
    // The guard exception must be documented AND enumerate the dispatch/no-child
    // guards, so their early-exit recovery-command pointers (e.g. next.md's
    // all_terminal → /orchestrator:finalize) are explicitly a compact
    // single-honest-recovery pointer, not the W1 fixed-literal anti-pattern.
    ok(/guard/i.test(text),
      'session-handoff.md must document the meta/guard exception (ADR-0029 §1)');
    ok(/all_terminal/.test(text) && /no-child/i.test(text),
      'session-handoff.md guard exception must enumerate the /orchestrator:next dispatch guards (all_terminal, …) and the /orchestrator:done no-child guard, so their recovery pointers are a documented exception rather than an unswept fixed literal (ADR-0029 §1 meta/guard exception)');
  });

  // Meta guard paths (Claude command AND Codex skill mirror): the no-active-
  // workflow branch drops the fixed single-command literal for the compact
  // meta/guard-exception pointer. These are NOT verb completions with a result —
  // like the engineer meta skills they do not carry the full six-field proposal
  // (ADR-0029 §1 meta/guard exception). The softened pointer names the two
  // honest routes (macro plan OR single-deliverable engineer:start) so it can
  // never regress to a single hardcoded command.
  for (const guard of ['commands/checkpoint.md', 'commands/resume.md',
                       'skills/checkpoint/SKILL.md', 'skills/resume/SKILL.md']) {
    it(`${guard} no-active-workflow guard uses the softened meta/guard pointer, not a fixed single command`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, guard), 'utf-8');
      ok(!/Recommended next:\s*`\/orchestrator:/.test(text),
        `${guard} still carries the fixed "Recommended next: \`/orchestrator:…\`" literal (ADR-0029 W1 meta/guard)`);
      ok(/Active Next-Action Proposal/.test(text),
        `${guard} guard should reference the session-handoff.md meta/guard exception (ADR-0029 §1)`);
      ok(/engineer:start/.test(text),
        `${guard} softened pointer must name the single-deliverable alternative route (engineer:start), proving it is not a single hardcoded command (ADR-0029 §1 meta/guard exception)`);
    });
  }

  // Terminal-close surfaces: /orchestrator:finalize + /orchestrator:abort close
  // the macro and defer their state-derived next action to the ADR-0039 footer
  // (no six-field prose — a close has no forward branch). /orchestrator:done's
  // auto-terminal path is likewise footer-driven. NONE may carry a hardcoded
  // imperative next-command literal ("Run `/orchestrator:… or wait`",
  // "### Recommended next step", "Recommended next: `/orchestrator:…`"). (done's
  // forward-decision proposal is asserted in the PROPOSAL_SURFACES loop above.)
  // NOTE: Phase-0/1 dispatch-guard early-exits (e.g. next.md's all_terminal →
  // /orchestrator:finalize) are NOT held to this rule — they are the documented
  // meta/guard exception (a compact single-honest-recovery pointer), enforced by
  // the session-handoff.md guard-enumeration assertion above, not here.
  for (const surface of ['commands/finalize.md', 'commands/abort.md', 'commands/done.md',
                         'skills/finalize/SKILL.md', 'skills/abort/SKILL.md', 'skills/done/SKILL.md']) {
    it(`${surface} carries no fixed imperative next-command literal (terminal close defers to the ADR-0039 footer)`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, surface), 'utf-8');
      ok(!/Run\s+`?\/orchestrator:\w+`?\s+or\s+wait/i.test(text),
        `${surface} still carries a "Run /orchestrator:… or wait" fixed lifecycle literal (ADR-0029 W1)`);
      ok(!/###\s+Recommended next step/.test(text),
        `${surface} still carries the "### Recommended next step" fixed literal (ADR-0029 W1)`);
      ok(!/Recommended next:\s*`\/orchestrator:/.test(text),
        `${surface} still carries a "Recommended next: \`/orchestrator:…\`" fixed literal (ADR-0029 W1)`);
    });
  }
});
