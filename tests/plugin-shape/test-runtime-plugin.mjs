// plugins/runtime plugin-shape conformance test (ADR-0024 runtime/operator track).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/runtime');
const RUNTIME_COMMAND_SURFACES = [
  { name: 'consensus', script: 'consensus.mjs' },
  { name: 'context', script: 'context.mjs' },
  { name: 'doctor', script: 'doctor.mjs' },
  { name: 'migrate', script: 'migrate-workflow-storage.mjs' },
  { name: 'settings', script: 'settings.mjs' },
  { name: 'worktree', script: 'worktree.mjs' },
];

async function readJSON(path) {
  const text = await readFile(path, 'utf-8');
  return JSON.parse(text);
}

describe('plugins/runtime manifest pair', () => {
  it('Claude manifest is valid JSON with required L1 runtime fields', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(manifest.name, 'runtime');
    ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'version is semver');
    ok(manifest.description.includes('ADR-0024'), 'description cites ADR-0024');
    ok(manifest.keywords.includes('runtime'));
    ok(manifest.keywords.includes('doctor'));
    ok(manifest.keywords.includes('settings'));
    ok(manifest.keywords.includes('migration'));
    ok(manifest.keywords.includes('consensus'));
    ok(manifest.keywords.includes('worktree'));
    ok(manifest.keywords.includes('context'));
    ok(manifest.keywords.includes('footer'));
    ok(manifest.keywords.includes('L1'));
  });

  it('Codex manifest is valid JSON with skills/interface', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(manifest.name, 'runtime');
    strictEqual(manifest.skills, './skills/');
    strictEqual(manifest.interface.displayName, 'Runtime');
    strictEqual(manifest.interface.developerName, 'each4all');
    strictEqual(manifest.interface.category, 'Productivity');
    deepStrictEqual(manifest.interface.capabilities, ['Read', 'Write']);
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:doctor')));
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:settings')));
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:consensus')));
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:context')));
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

describe('plugins/runtime command-skill parity', () => {
  it('keeps Claude command wrappers and Codex skill wrappers aligned', async () => {
    const expectedNames = RUNTIME_COMMAND_SURFACES.map((surface) => surface.name).sort();
    const commandFiles = (await readdir(resolve(PLUGIN_ROOT, 'commands')))
      .filter((entry) => entry.endsWith('.md'))
      .sort();
    deepStrictEqual(commandFiles, expectedNames.map((name) => `${name}.md`));

    const skillDirs = (await readdir(resolve(PLUGIN_ROOT, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    deepStrictEqual(skillDirs, expectedNames);

    for (const surface of RUNTIME_COMMAND_SURFACES) {
      const scriptRef = `scripts/${surface.script}`;
      const slashToken = `/runtime:${surface.name}`;
      const codexToken = `$runtime:${surface.name}`;
      const command = await readFile(resolve(PLUGIN_ROOT, `commands/${surface.name}.md`), 'utf-8');
      ok(command.startsWith('---\n'), `${surface.name} command has frontmatter`);
      ok(/^description:\s*\S/m.test(command), `${surface.name} command has description`);
      ok(/^argument-hint:\s*/m.test(command), `${surface.name} command has argument hint`);
      ok(command.includes(scriptRef), `${surface.name} command references ${scriptRef}`);

      const skill = await readFile(resolve(PLUGIN_ROOT, `skills/${surface.name}/SKILL.md`), 'utf-8');
      ok(new RegExp(`^name:\\s*${surface.name}\\s*$`, 'm').test(skill), `${surface.name} skill has matching name`);
      ok(skill.includes(slashToken), `${surface.name} skill documents Claude command token`);
      ok(skill.includes(codexToken), `${surface.name} skill documents Codex command token`);
      ok(skill.includes(scriptRef), `${surface.name} skill references ${scriptRef}`);

      const agent = await readFile(resolve(PLUGIN_ROOT, `skills/${surface.name}/agents/openai.yaml`), 'utf-8');
      ok(agent.includes(codexToken), `${surface.name} agent default prompt references Codex command token`);
      ok(/allow_implicit_invocation:\s*false/.test(agent), `${surface.name} agent is explicit-only`);

      const scriptStat = await stat(resolve(PLUGIN_ROOT, scriptRef));
      ok((scriptStat.mode & 0o111) !== 0, `${surface.script} has executable bit`);
    }
  });
});

describe('plugins/runtime marketplace and release registration', () => {
  it('Claude marketplace catalog has runtime entry with matching version', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'runtime');
    ok(entry, 'runtime entry present in Claude catalog');
    strictEqual(entry.source, './plugins/runtime');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version, 'catalog version matches manifest');
    strictEqual(entry.category, 'Productivity');
  });

  it('Codex marketplace catalog has runtime entry with matching policy/source', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'runtime');
    ok(entry, 'runtime entry present in Codex catalog');
    strictEqual(entry.source.source, 'local');
    strictEqual(entry.source.path, './plugins/runtime');
    strictEqual(entry.policy.installation, 'AVAILABLE');
    strictEqual(entry.policy.authentication, 'ON_USE');
    strictEqual(entry.category, 'Productivity');
  });

  it('release-please tracks runtime with extra-files for both manifests', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const releasePleaseManifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(releasePleaseManifest['plugins/runtime'], manifest.version);
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages['plugins/runtime'];
    ok(pkg, 'runtime package configured');
    strictEqual(pkg['package-name'], 'plugin-runtime');
    strictEqual(pkg.component, 'plugin-runtime');
    strictEqual(pkg['changelog-path'], 'CHANGELOG.md');
    const paths = pkg['extra-files'].map((f) => f.path);
    ok(paths.includes('.claude-plugin/plugin.json'));
    ok(paths.includes('.codex-plugin/plugin.json'));
  });
});

describe('plugins/runtime doctor surface', () => {
  it('ships doctor command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/doctor.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/doctor.mjs'));
    ok(/read-only/i.test(command));
    ok(command.includes('--execute-deep-peer-smoke'));
    ok(command.includes('Experience Parity'));
    ok(command.includes('Manual Follow-ups'));
    ok(command.includes('/hooks'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/doctor/SKILL.md'), 'utf-8');
    ok(/^name:\s*doctor\s*$/m.test(skill));
    ok(skill.includes('Authentication output must stay sanitized'));
    ok(skill.includes('--execute-deep-peer-smoke'));
    ok(skill.includes('experience_parity'));
    ok(skill.includes('Manual Follow-ups'));
    ok(skill.includes('/hooks'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/doctor/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:doctor'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/doctor.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'doctor.mjs has executable bit');
  });
});

describe('plugins/runtime settings surface', () => {
  it('ships settings command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/settings.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/settings.mjs'));
    ok(/dry-run/i.test(command));
    ok(command.includes('--apply'));
    ok(command.includes('--apply-codex-plugin-hooks'));
    ok(command.includes('/hooks'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/settings/SKILL.md'), 'utf-8');
    ok(/^name:\s*settings\s*$/m.test(skill));
    ok(skill.includes('Host-native Claude Code'));
    ok(skill.includes('Non-executable host-CLI install plans'));
    ok(skill.includes('--execute-plugin-management'));
    ok(skill.includes('--apply-codex-plugin-hooks'));
    ok(skill.includes('/hooks'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/settings/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:settings'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/settings.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'settings.mjs has executable bit');
  });

  it('follow-ups document plugin-management boundaries plus deferred consensus/context/footer scope', async () => {
    const followUps = await readFile(resolve(PLUGIN_ROOT, 'docs/follow-ups.md'), 'utf-8');
    for (const token of ['Plugin management beyond the explicit settings executor', 'Consensus executor depth beyond the explicit boundary', 'Worktree execution beyond read-only planning', 'Context automation', 'Completion footer', 'Codex capability drift beyond the current baseline', 'Claude-vs-Codex parity drift beyond the current baseline']) {
      ok(followUps.includes(token), `${token} documented`);
    }
    ok(/Codex capability drift/i.test(followUps), 'Codex capability drift documented');
    ok(/Claude agent teams must not be treated as the portable cross-host team-mode substrate/i.test(followUps), 'Claude team-mode boundary documented');
  });

  it('documents the Codex capability baseline with source-backed host boundaries', async () => {
    const baseline = await readFile(resolve(PLUGIN_ROOT, 'docs/codex-capability-baseline.md'), 'utf-8');
    for (const token of [
      'codex-cli 0.130.0',
      'https://developers.openai.com/codex/skills',
      'https://developers.openai.com/codex/plugins/build',
      'https://developers.openai.com/codex/hooks',
      'https://developers.openai.com/codex/concepts/sandboxing',
      'marketplace-only',
      'plugin_hooks',
      'manifest hook exposure',
      'Do not claim Codex subagents run automatically',
      '--apply-codex-plugin-hooks',
      'host-parity-baseline.md',
    ]) {
      ok(baseline.includes(token), `${token} documented`);
    }
  });

  it('documents the Claude-vs-Codex host parity baseline with source-backed non-parity boundaries', async () => {
    const baseline = await readFile(resolve(PLUGIN_ROOT, 'docs/host-parity-baseline.md'), 'utf-8');
    for (const token of [
      'Claude Code `2.1.141`',
      'Codex CLI\n`0.130.0`',
      'https://developers.openai.com/codex/subagents',
      'https://developers.openai.com/codex/hooks',
      'https://code.claude.com/docs/en/plugins',
      'https://code.claude.com/docs/en/agent-teams',
      'https://code.claude.com/docs/en/hooks',
      'codex plugin marketplace add',
      'plugin_hooks',
      'manifest hook exposure',
      'Codex only spawns subagents when explicitly asked',
      'Claude agent teams are not a portable cross-host primitive',
      '.agentic-plugins/config.toml',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
      'agents.max_threads',
      'Do not collapse host-specific plugin metadata into `.agentic-plugins`',
    ]) {
      ok(baseline.includes(token), `${token} documented`);
    }
  });
});

describe('plugins/runtime migrate surface', () => {
  it('ships migrate command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/migrate.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/migrate-workflow-storage.mjs'));
    ok(/dry-run/i.test(command));
    ok(command.includes('--apply'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/migrate/SKILL.md'), 'utf-8');
    ok(/^name:\s*migrate\s*$/m.test(skill));
    ok(skill.includes('ADR-0025'));
    ok(skill.includes('No workflow schema conversion'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/migrate/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:migrate workflow-storage'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/migrate-workflow-storage.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'migrate-workflow-storage.mjs has executable bit');
  });
});

describe('plugins/runtime consensus surface', () => {
  it('ships consensus command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/consensus.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/consensus.mjs'));
    ok(command.includes('artifact'));
    ok(command.includes('execute --execute'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/consensus/SKILL.md'), 'utf-8');
    ok(/^name:\s*consensus\s*$/m.test(skill));
    ok(skill.includes('raw peer output out of the main session'));
    ok(skill.includes('No peer execution except `execute --execute`'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/consensus/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:consensus'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/consensus.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'consensus.mjs has executable bit');
  });
});

describe('plugins/runtime worktree surface', () => {
  it('ships worktree command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/worktree.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/worktree.mjs'));
    ok(/read-only/i.test(command));
    ok(command.includes('git worktree add'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/worktree/SKILL.md'), 'utf-8');
    ok(/^name:\s*worktree\s*$/m.test(skill));
    ok(skill.includes('never creates branches or worktrees'));
    ok(skill.includes('No `git worktree add`'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/worktree/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:worktree'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/worktree.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'worktree.mjs has executable bit');
  });
});

describe('plugins/runtime context surface', () => {
  it('ships context command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/context.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/context.mjs'));
    ok(command.includes('does not trim, rewrite, or mutate host session context'));
    ok(command.includes('Main-session output is limited'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/context/SKILL.md'), 'utf-8');
    ok(/^name:\s*context\s*$/m.test(skill));
    ok(skill.includes('No host session context mutation'));
    ok(skill.includes('No consensus raw output or peer raw output in the main session'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/context/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:context'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/context.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'context.mjs has executable bit');
  });
});

describe('plugins/runtime footer helper', () => {
  it('ships footer helper and pointer-only contract docs', async () => {
    const contract = await readFile(resolve(PLUGIN_ROOT, 'docs/footer-contract.md'), 'utf-8');
    ok(contract.includes('Completion Footer Contract'));
    ok(/advisory/i.test(contract));
    ok(/pointer-only/i.test(contract));
    ok(contract.includes('scripts/footer.mjs'));
    const script = await readFile(resolve(PLUGIN_ROOT, 'scripts/footer.mjs'), 'utf-8');
    ok(script.includes('Runtime completion footer (advisory)'));
    ok(script.includes('context-run-id'));
    ok(script.includes('does not mutate host session context'));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/footer.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'footer.mjs has executable bit');
  });
});

describe('plugins/runtime repo documentation freshness', () => {
  it('keeps root and stage docs aligned with the shipped runtime version and surfaces', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    const readme = await readFile(resolve(REPO_ROOT, 'README.md'), 'utf-8');
    const architecture = await readFile(resolve(REPO_ROOT, 'docs/ARCHITECTURE.md'), 'utf-8');
    const development = await readFile(resolve(REPO_ROOT, 'docs/DEVELOPMENT.md'), 'utf-8');
    const currentRuntimeToken = `plugin-runtime\` v${manifest.version}`;

    ok(architecture.includes(currentRuntimeToken), 'ARCHITECTURE.md documents the current runtime version');
    ok(development.includes(currentRuntimeToken), 'DEVELOPMENT.md documents the current runtime version');
    ok(!architecture.includes('plugin-runtime` v0.12.0'), 'ARCHITECTURE.md must not describe runtime as v0.12.0');
    ok(!development.includes('plugin-runtime` v0.12.0'), 'DEVELOPMENT.md must not describe runtime as v0.12.0');

    for (const token of [
      'runtime:doctor',
      'runtime:settings',
      'runtime:consensus',
      'runtime:worktree',
      'runtime:context',
      'workflow-storage migration',
      'completion footer',
    ]) {
      ok(readme.includes(token), `README.md documents ${token}`);
    }

    ok(!readme.includes('### Coming next'), 'README.md should not list shipped runtime surfaces as coming next');
    ok(!readme.includes('Runtime dynamic consensus, context hygiene, and completion footer'), 'README.md must not carry stale ADR-0024 follow-up wording');
  });
});
