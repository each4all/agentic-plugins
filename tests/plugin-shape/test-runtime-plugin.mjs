// plugins/runtime plugin-shape conformance test (ADR-0024 runtime/operator track).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/runtime');

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
    ok(manifest.keywords.includes('consensus'));
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
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/doctor/SKILL.md'), 'utf-8');
    ok(/^name:\s*doctor\s*$/m.test(skill));
    ok(skill.includes('Authentication output must stay sanitized'));
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
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/settings/SKILL.md'), 'utf-8');
    ok(/^name:\s*settings\s*$/m.test(skill));
    ok(skill.includes('Host-native Claude Code'));
    ok(skill.includes('automatic plugin install/update apply mode'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/settings/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:settings'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/settings.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'settings.mjs has executable bit');
  });

  it('follow-ups document deferred automatic consensus execution/settings/context automation/footer scope', async () => {
    const followUps = await readFile(resolve(PLUGIN_ROOT, 'docs/follow-ups.md'), 'utf-8');
    for (const token of ['Automatic plugin install/update apply mode', 'Automatic peer execution for consensus', 'Context automation', 'Completion footer']) {
      ok(followUps.includes(token), `${token} documented`);
    }
    ok(/Codex manual-hook/i.test(followUps), 'Codex manual-hook honesty documented');
  });
});

describe('plugins/runtime consensus surface', () => {
  it('ships consensus command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/consensus.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/consensus.mjs'));
    ok(command.includes('artifact'));
    ok(command.includes('does not execute peer agents'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/consensus/SKILL.md'), 'utf-8');
    ok(/^name:\s*consensus\s*$/m.test(skill));
    ok(skill.includes('raw peer output out of the main session'));
    ok(skill.includes('No direct peer execution'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/consensus/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:consensus'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/consensus.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'consensus.mjs has executable bit');
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
