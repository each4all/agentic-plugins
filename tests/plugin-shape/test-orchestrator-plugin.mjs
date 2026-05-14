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
//   - 1 Codex adapter manual stop helper (Codex CLI exposes host-level
//     hooks, but no plugin-local automatic hook packaging is verified — Codex Stop is
//     declared as a script file but NOT registered in hooks/hooks.json)
//   - 1 Claude hooks manifest (hooks/hooks.json) declaring SessionStart,
//     PreCompact, and Stop only
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

const VERBS = ['plan'];
const ALIAS_VERBS = ['audit'];
// ADR-0019 PR-D — orchestrator dispatch commands. `next` and `done`
// are slash-command runbooks (same-host dispatch + manual backup);
// they are NOT 6-verb persona commands (those live in engineer).
const DISPATCH_COMMANDS = ['next', 'done'];
const META_COMMANDS = ['resume', 'checkpoint', 'peer-now'];
const ALL_COMMANDS = [...VERBS, ...ALIAS_VERBS, ...DISPATCH_COMMANDS, ...META_COMMANDS];
const SHARED_REFS = ['ensemble-protocol.md', 'presentation-protocol.md'];
const HOST_SHARED_SCRIPTS = ['state.mjs', 'dispatch-peer.mjs', 'peer-runner.mjs', 'stop-archive.mjs'];
const CLAUDE_HOOKS = ['_shared.mjs', 'session-start.mjs', 'pre-compact.mjs', 'stop.mjs'];
const CODEX_HOOK_HELPERS = ['stop.mjs', 'README.md'];

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
    strictEqual(entry.version, manifest.version, 'catalog version matches manifest');
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
  it('declares SessionStart (matcher compact), PreCompact, Stop only — no Codex hook events', async () => {
    const hooks = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    ok(hooks.hooks);
    ok(Array.isArray(hooks.hooks.SessionStart));
    ok(Array.isArray(hooks.hooks.PreCompact));
    ok(Array.isArray(hooks.hooks.Stop));
    // Only Claude lifecycle events declared — no Codex plugin-local automatic
    // hook packaging is verified.
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
    // Codex hook scope wording must remain explicit (not stale)
    ok(/no plugin-local automatic hook packaging/i.test(readme),
      'README uses corrected Codex hook scope wording');
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

  it('/orchestrator:checkpoint uses checkpoint-set and documents Codex manual hook honesty', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/checkpoint.md'), 'utf-8');
    ok(/state\.mjs"\s+checkpoint-set/.test(text), 'checkpoint command calls checkpoint-set');
    ok(text.includes('latest_checkpoint'), 'checkpoint command documents latest_checkpoint');
    ok(/Codex CLI\s+has no plugin-local automatic SessionStart hook today/i.test(text),
      'checkpoint command documents Codex hook limit');
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

  it('completion commands append the runtime completion footer contract', async () => {
    for (const cmd of ['plan', 'next', 'done', 'finalize', 'abort']) {
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
