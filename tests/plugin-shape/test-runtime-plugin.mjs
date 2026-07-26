// plugins/runtime plugin-shape conformance test (ADR-0024 runtime/operator track).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/runtime');
const RELEASE_PLEASE_PR = process.env.AGENTIC_RELEASE_PLEASE_PR === '1';
const RUNTIME_COMMAND_SURFACES = [
  { name: 'bootstrap', script: 'bootstrap.mjs' },
  { name: 'compat', script: 'compat.mjs' },
  { name: 'consensus', script: 'consensus.mjs' },
  { name: 'context', script: 'context.mjs' },
  { name: 'cutover', script: 'cutover-audit.mjs' },
  { name: 'dashboard', script: 'dashboard.mjs' },
  { name: 'doctor', script: 'doctor.mjs' },
  { name: 'migrate', script: 'migrate-workflow-storage.mjs' },
  { name: 'retention', script: 'retention.mjs' },
  { name: 'settings', script: 'settings.mjs' },
  { name: 'worktree', script: 'worktree.mjs' },
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
    ok(manifest.keywords.includes('compat'));
    ok(manifest.keywords.includes('worktree'));
    ok(manifest.keywords.includes('context'));
    ok(manifest.keywords.includes('cutover'));
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
    if (RELEASE_PLEASE_PR && entry.version !== manifest.version) {
      ok(compareSemver(entry.version, manifest.version) <= 0, 'release-please PR may have catalog version lag until post-release sync');
    } else {
      strictEqual(entry.version, manifest.version, 'catalog version matches manifest');
    }
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

describe('plugins/runtime bootstrap surface', () => {
  it('ships bootstrap command, skill wrapper, agent yaml, and executable script with the §3 grammar advertised', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/bootstrap.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/bootstrap.mjs'));
    const argumentHint = command.split('\n').find((line) => line.startsWith('argument-hint:'));
    ok(argumentHint, 'commands/bootstrap.md has an argument-hint');
    // The §3 grammar, advertised: every verb and every flag the parser accepts.
    for (const verb of ['plan', 'status', 'resume', 'verify', 'abandon', 'profile export', 'profile seed']) {
      ok(argumentHint.includes(verb), `commands/bootstrap.md argument-hint advertises the '${verb}' verb`);
    }
    for (const flag of ['--bundle', '--plugins', '--profile-file', '--answers', '--format', '--run-id', '--latest', '--latest-open', '--reason', '--name', '--from-run', '--overwrite']) {
      ok(argumentHint.includes(flag), `commands/bootstrap.md argument-hint advertises ${flag}`);
    }
    ok(!argumentHint.includes('--out'), 'there is no --out (§3: writes are constrained to the authorized home)');
    // Interview pacing is the command's ONLY ownership — schema decisions live
    // in the packaged contract, and the pacing order is the contract's §Decision-8.
    ok(/diagnose/i.test(command) && /profile-seeded-default/i.test(command) && /re-probe/i.test(command), 'commands/bootstrap.md carries the interview pacing order');
    ok(/--expected-plan-hash/.test(command), 'commands/bootstrap.md presents the §1.6 plan-hash executor handoff');

    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/bootstrap/SKILL.md'), 'utf-8');
    ok(/^name:\s*bootstrap\s*$/m.test(skill));
    ok(skill.includes('machine-bootstrap-contract.md'), 'skill points at the packaged normative contract');
    ok(/never an? (second )?executor|no second executor/i.test(skill), 'skill states the no-second-executor boundary');
    ok(/read-only/i.test(skill) && skill.includes('status'), 'skill states the R0 status/verify boundary');

    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/bootstrap/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:bootstrap'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/bootstrap.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'bootstrap.mjs has executable bit');
  });

  // machine-bootstrap-contract.md §11.3 — the packaged contract is asserted BY
  // CONTENT (the footer-contract.md precedent): these tokens are the floor that
  // keeps the document from drifting while CI stays green.
  it('pins the packaged machine-bootstrap contract by content (§11.3)', async () => {
    const contract = await readFile(resolve(PLUGIN_ROOT, 'docs/machine-bootstrap-contract.md'), 'utf-8');
    for (const token of [
      'Machine Bootstrap Contract',
      'runtime:bootstrap',
      'scripts/bootstrap.mjs',
      'agentic-machine-profile-1',
      'runtime-bootstrap-run-1',
      'configured-not-verified',
      'never an input to any activation or config loader',
      'Stage 0',
      'probeMachineHostState',
    ]) {
      ok(contract.includes(token), `machine-bootstrap-contract.md contains ${JSON.stringify(token)}`);
    }
    ok(/artifact-only/i.test(contract), 'contract states the artifact-only boundary');
    ok(/machine-scoped/i.test(contract), 'contract states the machine scope');
    ok(/write-ahead/i.test(contract), 'contract states the write-ahead durability rule');
  });

  // §11.3 second half — README.md's Stage 0 block and the contract's §2 block
  // carry the SAME commands, and the in-code STAGE0_COMMANDS copy matches both,
  // so the operator-facing doc, the normative contract, and the printed
  // detection output cannot drift apart. The ROOT README is bound too (S8c):
  // ADR-0046 Context §1 names it as the drift site where the marketplace-add
  // step diverged into four mutually inconsistent forms. Each surface must
  // carry a fenced block whose ordered, comment-free command lines EQUAL the
  // exported STAGE0_COMMANDS exactly — a whole-file includes() would accept
  // reordered, duplicated, or extra commands (Plan-verify finding).
  it('keeps the README, contract §2, root README, and in-code Stage 0 command blocks identical', async () => {
    const { STAGE0_COMMANDS } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/bootstrap.mjs')).href);
    const canonical = [...STAGE0_COMMANDS.claude, ...STAGE0_COMMANDS.codex];
    strictEqual(canonical.length, 4, 'STAGE0_COMMANDS carries the four canonical commands');
    const surfaces = [
      ['contract §2', resolve(PLUGIN_ROOT, 'docs/machine-bootstrap-contract.md')],
      ['plugin README', resolve(PLUGIN_ROOT, 'README.md')],
      ['root README', resolve(REPO_ROOT, 'README.md')],
    ];
    for (const [label, path] of surfaces) {
      const text = await readFile(path, 'utf-8');
      const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) =>
        m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
      const exact = blocks.filter((commands) => {
        try { deepStrictEqual(commands, canonical); return true; } catch { return false; }
      });
      ok(exact.length >= 1, `${label} carries a fenced Stage 0 block exactly equal to STAGE0_COMMANDS (ordered, no extras)`);
    }
  });

  // ADR-0046 Context §2 — the egress env-var names appeared in ZERO markdown
  // files before the bootstrap track; the root README Stage 0 section is their
  // first consistent operator-facing home. Import EGRESS_ENV_KEYS from
  // egress-config.mjs (the code authority — PLUGIN_NAMES precedent) so a
  // rename cannot leave the README documenting dead variables, and pin the
  // ADR-0041 safety semantics that ride with the names.
  it('documents the canonical egress env-var names in the root README', async () => {
    const { EGRESS_ENV_KEYS } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/lib/egress-config.mjs')).href);
    deepStrictEqual(Object.keys(EGRESS_ENV_KEYS).sort(), ['channel', 'credential', 'recipient'], 'EGRESS_ENV_KEYS carries the three canonical roles');
    const rootReadme = await readFile(resolve(REPO_ROOT, 'README.md'), 'utf-8');
    for (const [role, name] of Object.entries(EGRESS_ENV_KEYS)) {
      ok(rootReadme.includes(name), `root README.md documents the egress ${role} env var ${name}`);
    }
    ok(/default is off/i.test(rootReadme), 'root README states the egress default-off posture');
    ok(/env-only/i.test(rootReadme), 'root README states the env-only credential rule');
  });
});

describe('plugins/runtime settings surface', () => {
  it('ships settings command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/settings.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/settings.mjs'));
    ok(/dry-run/i.test(command));
    ok(command.includes('--apply'));
    // ADR-0035 §6 hard-remove: the deleted flag must stay out of the command doc.
    ok(!command.includes('[--apply-codex-plugin-hooks]'));
    ok(command.includes('/hooks'));
    // Probe-free mode (settings-report-contract.md) is documented on every surface.
    ok(command.includes('--skip-host-cli-probes'));
    ok(command.includes('settings-report-contract.md'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/settings/SKILL.md'), 'utf-8');
    ok(/^name:\s*settings\s*$/m.test(skill));
    ok(skill.includes('Host-native Claude Code'));
    ok(skill.includes('Non-executable host-CLI install plans'));
    ok(skill.includes('--execute-plugin-management'));
    ok(!skill.includes('[--apply-codex-plugin-hooks]'));
    ok(skill.includes('/hooks'));
    ok(skill.includes('--skip-host-cli-probes'));
    ok(skill.includes('settings-report-contract.md'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/settings/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:settings'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    ok(agent.includes('--skip-host-cli-probes'));

    // ADR-0038 permission plan is discoverable on every public surface.
    // It shipped in settings.mjs but was named on none of them, while the
    // command doc already referred to "the three plan flags" — so the docs
    // counted it without ever letting a reader find it.
    //
    // Pin each flag in the FIELD a reader actually reaches, not merely somewhere
    // in the file: a whole-file `includes` passes as long as the token survives
    // anywhere, so dropping a flag from the argument-hint while leaving it in a
    // prose note would go unnoticed (Refine-verify finding).
    const PERMISSION_FLAGS = ['--permission-plan', '--permission-plan-max-files', '--permission-plan-max-file-bytes'];
    const argumentHint = command.split('\n').find((line) => line.startsWith('argument-hint:'));
    ok(argumentHint, 'commands/settings.md has an argument-hint');
    const skillInvocation = skill.split('\n').find((line) => line.includes('scripts/settings.mjs') && line.includes('--repo-root'));
    ok(skillInvocation, 'skills/settings/SKILL.md has the settings.mjs invocation line');
    const agentPrompt = agent.split('\n').find((line) => line.trim().startsWith('default_prompt:'));
    ok(agentPrompt, 'settings agent yaml has a default_prompt');
    for (const flag of PERMISSION_FLAGS) {
      ok(argumentHint.includes(`[${flag}`), `commands/settings.md argument-hint advertises ${flag}`);
      ok(skillInvocation.includes(`[${flag}`), `skills/settings/SKILL.md invocation advertises ${flag}`);
      ok(agentPrompt.includes(flag), `settings agent default_prompt advertises ${flag}`);
    }
    // The command and skill also owe a substantive note, not just a flag token.
    for (const [label, surface] of [['commands/settings.md', command], ['skills/settings/SKILL.md', skill]]) {
      ok(/never writes host config/i.test(surface), `${label} states the no-host-config-write boundary`);
      ok(surface.includes('bypassPermissions') && surface.includes('danger-full-access'), `${label} states the ADR-0038 ceiling`);
    }
  });

  // The plugin set drifted: this skill claimed four plugins, the runtime README
  // claimed four, the root README six, and the catalogs eight — with nothing
  // holding them in agreement. `PLUGIN_NAMES` is what settings and doctor
  // actually iterate, so it is the authority; every runtime-owned surface that
  // enumerates the set is pinned against it, and against both catalogs.
  it('keeps the runtime-owned plugin lists in agreement with PLUGIN_NAMES and both catalogs', async () => {
    // PLUGIN_NAMES's single definition now lives in the machine probe (the machine-
    // bootstrap seam extracted from doctor); doctor re-exports it. Read the authority
    // from its source of truth, and pin that doctor still re-exports it.
    const machineProbeSrc = await readFile(resolve(PLUGIN_ROOT, 'scripts/lib/machine-probe.mjs'), 'utf-8');
    const namesMatch = machineProbeSrc.match(/export const PLUGIN_NAMES = \[([^\]]+)\]/);
    ok(namesMatch, 'machine-probe.mjs defines PLUGIN_NAMES');
    const doctorSrc = await readFile(resolve(PLUGIN_ROOT, 'scripts/doctor.mjs'), 'utf-8');
    ok(/export \{[^}]*\bPLUGIN_NAMES\b[^}]*\}/.test(doctorSrc), 'doctor.mjs re-exports PLUGIN_NAMES for its public surface');
    const pluginNames = namesMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();

    const claudeCatalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const codexCatalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    deepStrictEqual(claudeCatalog.plugins.map((p) => p.name).sort(), pluginNames, 'Claude catalog matches PLUGIN_NAMES');
    deepStrictEqual(codexCatalog.plugins.map((p) => p.name).sort(), pluginNames, 'Codex catalog matches PLUGIN_NAMES');

    // Every runtime-owned prose surface that enumerates the set must name all of
    // them. A four-name list here is how the drift started.
    const proseSurfaces = ['skills/settings/SKILL.md', 'skills/doctor/SKILL.md', 'README.md'];
    for (const rel of proseSurfaces) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf-8');
      for (const name of pluginNames) {
        ok(text.includes(`\`${name}\``), `${rel} names the ${name} plugin`);
      }
    }
    // The ROOT README consumer inventory drifted to six names (attention and
    // designer missing) — the exact ADR-0046 Context §1 site. Pin it too (S8c).
    const rootReadme = await readFile(resolve(REPO_ROOT, 'README.md'), 'utf-8');
    for (const name of pluginNames) {
      ok(rootReadme.includes(`\`${name}\``), `root README.md names the ${name} plugin`);
    }
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/settings.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'settings.mjs has executable bit');
  });

  it('follow-ups document plugin-management boundaries plus deferred consensus/context/footer scope', async () => {
    const followUps = await readFile(resolve(PLUGIN_ROOT, 'docs/follow-ups.md'), 'utf-8');
    for (const token of ['Plugin management beyond the explicit settings executor', 'Consensus executor depth beyond the explicit boundary', 'Worktree execution beyond read-only planning', 'Context automation', 'Completion footer', 'Codex capability drift beyond the current baseline', 'Claude-vs-Codex parity drift beyond the current baseline', 'Probe-free `runtime:settings` mode']) {
      ok(followUps.includes(token), `${token} documented`);
    }
    ok(/Codex capability drift/i.test(followUps), 'Codex capability drift documented');
    ok(/Claude agent teams must not be treated as the portable cross-host team-mode substrate/i.test(followUps), 'Claude team-mode boundary documented');
  });

  // artifact-policy.md was cited by three surfaces and opened by NO test — the exact
  // drift hole machine-bootstrap-contract.md §11 names (a doc "cited by filename but
  // no test ever opens it" can drift arbitrarily while CI stays green). It is a
  // PACKAGED doc that must be correct when bootstrap ships, so pin it by content:
  // the machine-global root, each governed axis, and the constants it shares with
  // the code. The cap is asserted against the CODE's constant rather than a literal,
  // so a future cap change cannot leave the doc quietly lying.
  it('documents the machine-global artifact scope with its root, security, pointer, inventory, and retention rules', async () => {
    const policy = await readFile(resolve(PLUGIN_ROOT, 'docs/artifact-policy.md'), 'utf-8');
    for (const token of [
      '## Machine-global artifacts',
      '~/.agentic-plugins/runs/bootstrap/<run-id>/run.json',
      '~/.agentic-plugins/profiles/<name>.json',
      '~/.agentic-plugins/.locks/bootstrap.lock',
      '### Security',
      '### Pointers',
      '### Inventory',
      '### Retention',
    ]) {
      ok(policy.includes(token), `artifact-policy.md documents ${token}`);
    }
    ok(/fails? closed/i.test(policy), 'the $HOME-is-the-repo fail-closed posture is documented');
    ok(/0700/.test(policy) && /0600/.test(policy), 'the filesystem modes are documented');
    ok(/never auto-deleted/i.test(policy), 'the no-auto-delete retention posture is documented');
    ok(/retention-exempt|retention pressure/i.test(policy), 'profile retention exemption is documented');

    // Doc/code agreement, not just doc existence: the machine cap and the repo cap
    // are both stated, and the machine one matches the constant the inventory uses.
    const stateReaders = await readFile(resolve(PLUGIN_ROOT, 'scripts/lib/state-readers.mjs'), 'utf-8');
    const capMatch = stateReaders.match(/export const MACHINE_BOOTSTRAP_RETENTION_CAP = (\d+)/);
    ok(capMatch, 'state-readers.mjs defines MACHINE_BOOTSTRAP_RETENTION_CAP');
    ok(
      new RegExp(`\\b${capMatch[1]} runs`).test(policy) || new RegExp(`last \\*\\*${capMatch[1]}\\*\\*`).test(policy),
      `artifact-policy.md states the machine retention cap of ${capMatch[1]} that the code enforces`,
    );
  });

  it('documents the Codex capability baseline with source-backed host boundaries', async () => {
    const baseline = await readFile(resolve(PLUGIN_ROOT, 'docs/codex-capability-baseline.md'), 'utf-8');
    for (const token of [
      'codex-cli 0.145.0',
      'marketplaceSource',
      'https://developers.openai.com/codex/skills',
      'https://developers.openai.com/codex/plugins/build',
      'https://developers.openai.com/codex/hooks',
      'https://developers.openai.com/codex/concepts/sandboxing',
      'no longer marketplace-only',
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
      'Claude Code `2.1.220`',
      'Codex CLI\n`0.145.0`',
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

  it('keeps the host parity baseline internally consistent with its header versions', async () => {
    // Regression gate for the 2026-07-10 recovery: four earlier refreshes
    // updated the header (and appended history rows) while the Local CLI
    // evidence block stayed at 2.1.173/0.139.0. Bare header tokens cannot
    // catch that shape — this derives the header versions and requires the
    // evidence block, the newest history row, and follow-ups.md to agree.
    const baseline = await readFile(resolve(PLUGIN_ROOT, 'docs/host-parity-baseline.md'), 'utf-8');
    const header = baseline.match(/Observed on ([0-9-]+) with Claude Code `([^`]+)`, Codex CLI\s*`([^`]+)`/);
    ok(header, 'baseline header parseable by the doctor/compat regex shape');
    const [, , headerClaude, headerCodex] = header;
    ok(
      baseline.includes(`\`claude --version\` -> \`${headerClaude} (Claude Code)\``),
      `Local CLI evidence records claude --version ${headerClaude}`,
    );
    ok(
      baseline.includes(`\`codex --version\` -> \`codex-cli ${headerCodex}\``),
      `Local CLI evidence records codex --version ${headerCodex}`,
    );
    const historyRows = baseline.split('\n').filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));
    ok(historyRows.length > 0, 'version history has dated rows');
    const newestRow = historyRows[historyRows.length - 1];
    ok(
      newestRow.includes(`\`${headerClaude}\``) && newestRow.includes(`\`${headerCodex}\``),
      'newest version-history row records the header versions',
    );
    const followUps = await readFile(resolve(PLUGIN_ROOT, 'docs/follow-ups.md'), 'utf-8');
    ok(
      followUps.includes(`local Claude Code \`${headerClaude}\` and Codex CLI \`${headerCodex}\` observations`),
      'follow-ups.md current-baseline statement matches the header versions',
    );

    // Same defect class, sibling doc: the Codex capability baseline had also
    // drifted (header + evidence pinned at 0.139.0 while its own drift policy
    // requires refresh on any installed codex --version change).
    const codexBaseline = await readFile(resolve(PLUGIN_ROOT, 'docs/codex-capability-baseline.md'), 'utf-8');
    const codexHeader = codexBaseline.match(/Observed on ([0-9-]+) with Codex CLI\s*`([^`]+)`/);
    ok(codexHeader, 'codex capability baseline header parseable');
    const [, codexHeaderDate, codexHeaderVersion] = codexHeader;
    // Both baselines observe the same installed codex; a host-parity refresh
    // that leaves the capability doc behind (or vice versa) must go RED here,
    // not survive on each doc's self-consistency alone.
    strictEqual(
      codexHeaderVersion,
      headerCodex,
      'codex-capability and host-parity baselines record the same Codex version',
    );
    ok(
      codexBaseline.includes(`\`codex --version\` -> \`codex-cli ${codexHeaderVersion}\``),
      `codex capability Local CLI evidence records codex --version ${codexHeaderVersion}`,
    );
    ok(
      codexBaseline.includes(`Local CLI evidence (re-observed ${codexHeaderDate} on \`${codexHeaderVersion}\`)`),
      'codex capability evidence heading carries the header date and version',
    );
    ok(
      followUps.includes(`local CLI \`${codexHeaderVersion}\` observations`),
      'follow-ups.md codex-capability statement matches that header version',
    );
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

describe('plugins/runtime compat surface', () => {
  it('ships compat command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/compat.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/compat.mjs'));
    ok(command.includes('release-note'));
    ok(command.includes('does not fetch release-note URLs by default'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/compat/SKILL.md'), 'utf-8');
    ok(/^name:\s*compat\s*$/m.test(skill));
    ok(skill.includes('No automatic URL fetch'));
    ok(skill.includes('No host-native config writes'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/compat/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:compat'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/compat.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'compat.mjs has executable bit');
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

describe('plugins/runtime cutover surface', () => {
  it('ships cutover command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/cutover.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/cutover-audit.mjs'));
    ok(/read-only/i.test(command));
    ok(command.includes('cutover-ready-candidate'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/cutover/SKILL.md'), 'utf-8');
    ok(/^name:\s*cutover\s*$/m.test(skill));
    ok(skill.includes('No automatic final cutover declaration'));
    ok(skill.includes('No inference that omcc-dev is inactive'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/cutover/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:cutover'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/cutover-audit.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'cutover-audit.mjs has executable bit');
  });
});

describe('plugins/runtime dashboard surface', () => {
  it('ships dashboard command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/dashboard.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/dashboard.mjs'));
    ok(/read-only/i.test(command));
    ok(command.includes('never probes host CLIs'));
    ok(command.includes('--watch'));
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/dashboard/SKILL.md'), 'utf-8');
    ok(/^name:\s*dashboard\s*$/m.test(skill));
    ok(skill.includes('No host CLI probing'));
    ok(skill.includes('No state mutation'));
    ok(skill.includes('No unbounded loops'));
    const agent = await readFile(resolve(PLUGIN_ROOT, 'skills/dashboard/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:dashboard'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/dashboard.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'dashboard.mjs has executable bit');
  });
});

describe('plugins/runtime footer helper', () => {
  it('ships footer helper and pointer-only contract docs', async () => {
    const contract = await readFile(resolve(PLUGIN_ROOT, 'docs/footer-contract.md'), 'utf-8');
    ok(contract.includes('Completion Footer Contract'));
    ok(/advisory/i.test(contract));
    ok(/pointer-only/i.test(contract));
    ok(contract.includes('completion state'));
    ok(contract.includes('review-needed'));
    ok(contract.includes('closed'));
    ok(contract.includes('scripts/footer.mjs'));
    const script = await readFile(resolve(PLUGIN_ROOT, 'scripts/footer.mjs'), 'utf-8');
    ok(script.includes('Runtime completion footer (advisory)'));
    ok(script.includes('completion_state'));
    ok(script.includes('context-run-id'));
    ok(script.includes('does not mutate host session context'));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/footer.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'footer.mjs has executable bit');
  });
});

describe('plugins/runtime session-capture foundation (ADR-0044 S2)', () => {
  // session-capture-contract.md §11 — the packaged contract is asserted BY
  // CONTENT (the machine-bootstrap-contract §11.3 / footer-contract precedent):
  // these tokens are the floor that keeps the document from drifting while CI
  // stays green.
  it('pins the packaged session-capture contract by content (§11)', async () => {
    const contract = await readFile(resolve(PLUGIN_ROOT, 'docs/session-capture-contract.md'), 'utf-8');
    for (const token of [
      'Session Capture Contract',
      'runtime-session-capture-1.0',
      'runtime-session-entry-1.0',
      'runtime-session-note-1.0',
      'session_capture',
      'publish-session',
      'slot.json',
      'entry.json',
      'note.json',
      'commit record',
      'fp1:',
      'last-writer-wins',
      'never suppressed on',
      'unknown, never clean',
      '4096',
      '300 s',
      '60 s',
      '24 h',
      '160',
      'O_EXCL',
      'UTF-8 bytes',
      'stop-hook',
      'loadSessionConfig',
      // §13 (ADR-0044 S4): the dynamically-read publisher-floor declaration
      // and the half-enabled readiness states the diagnosis surfaces.
      'data/runtime-floors.json',
      'attention-runtime-floors-1.0',
      'publish_session',
      'attention-missing',
      'attention-disabled',
      'publisher-sensor-not-shipped',
      'floor-declaration-malformed',
      'runtime-below-publisher-floor',
      'safe-mode-hooks-disabled',
      'CLAUDE_CODE_SAFE_MODE',
      // §14-§17 (ADR-0045 S7b): the entry-side extension — schema id, gate
      // keys and env channel, dispositions, marker pair, linkage token, and
      // the entry-side staleness threshold.
      'runtime-entry-brief-1.0',
      'entry-brief',
      'entry_brief_empty',
      'AGENTIC_ENTRY_BRIEF',
      'user-scope-only',
      'owner-choice-required',
      'no-branch-context',
      'indeterminate',
      '[agentic-entry-brief]',
      'linkageToken',
      '7 d',
      'aliased-to-user',
    ]) {
      ok(contract.includes(token), `session-capture-contract.md contains ${JSON.stringify(token)}`);
    }
    ok(/fail-closed/i.test(contract), 'contract states the fail-closed consumer rule');
    ok(/untrusted\s+quoted\s+data/i.test(contract), 'contract states the untrusted-data rule');
    // Whitespace-tolerant: markdown reflows can split the phrase across lines
    // or emphasis markers without weakening the stated rule.
    ok(/no\s+imperative[\s*]+field/i.test(contract), 'contract states the no-imperative-field rule');
  });

  // The three schemas the contract names must actually be packaged — a doc
  // pointing at an unpackaged schema is exactly the "cited by filename but
  // not shipped" drift hole the packaged-contract vehicle exists to close.
  it('packages the session-capture and entry-brief schemas the contract names', async () => {
    for (const file of [
      'data/schemas/runtime-session-capture-1.0.json',
      'data/schemas/runtime-session-entry-1.0.json',
      'data/schemas/runtime-session-note-1.0.json',
      'data/schemas/runtime-entry-brief-1.0.json',
    ]) {
      const schema = await readJSON(resolve(PLUGIN_ROOT, file));
      strictEqual(schema.additionalProperties, false, `${file} follows the closed-schema rule`);
      ok(Array.isArray(schema.required) && schema.required.includes('schema'), `${file} requires its schema id`);
    }
  });
});

describe('plugins/runtime repo documentation freshness', () => {
  // The freshness assertions are split by WHAT MAKES THEM TRUE, because
  // the two halves have different remedies and bundling them made every
  // release produce one indistinguishable red:
  //
  //   derivable      — true the moment release-please cuts the version.
  //                    Remedy: `npm run sync:docs`.
  //   proof-coupled  — true only once a doctor proof has been re-recorded
  //                    under the new install. Remedy: actually re-record.
  //                    No script may write these; see
  //                    scripts/sync-doc-versions.mjs.
  const loadDocs = async () => ({
    manifest: await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json')),
    readme: await readFile(resolve(REPO_ROOT, 'README.md'), 'utf-8'),
    architecture: await readFile(resolve(REPO_ROOT, 'docs/ARCHITECTURE.md'), 'utf-8'),
    development: await readFile(resolve(REPO_ROOT, 'docs/DEVELOPMENT.md'), 'utf-8'),
    scorecard: await readFile(resolve(REPO_ROOT, 'docs/assurance/omcc-cutover-scorecard.md'), 'utf-8'),
  });

  const SYNC_REMEDY = 'run `npm run sync:docs` (these tokens are derived from .release-please-manifest.json)';
  const PROOF_REMEDY = 'the installed-state proof has not been re-recorded for the shipped version — install the release on both hosts, then run runtime:doctor with the three --execute-* proofs and --record. No script may write this token';

  it('keeps the derivable runtime-version tokens aligned with the manifest', async () => {
    const { manifest, architecture, development, scorecard } = await loadDocs();
    const currentRuntimeToken = `plugin-runtime\` v${manifest.version}`;
    const runtimeReleaseTag = `plugin-runtime-v${manifest.version}`;

    if (RELEASE_PLEASE_PR) {
      ok(/plugin-runtime` v\d+\.\d+\.\d+/.test(architecture), 'ARCHITECTURE.md documents a runtime version');
      ok(/plugin-runtime` v\d+\.\d+\.\d+/.test(development), 'DEVELOPMENT.md documents a runtime version');
      ok(/`plugin-runtime-v\d+\.\d+\.\d+`/.test(scorecard), 'omcc cutover scorecard documents a runtime release tag');
    } else {
      ok(architecture.includes(currentRuntimeToken), `ARCHITECTURE.md documents the current runtime version — ${SYNC_REMEDY}`);
      ok(development.includes(currentRuntimeToken), `DEVELOPMENT.md documents the current runtime version — ${SYNC_REMEDY}`);
      ok(scorecard.includes(runtimeReleaseTag), `omcc cutover scorecard documents the current runtime release tag — ${SYNC_REMEDY}`);
    }

    ok(!architecture.includes('plugin-runtime` v0.12.0'), 'ARCHITECTURE.md must not describe runtime as v0.12.0');
    ok(!development.includes('plugin-runtime` v0.12.0'), 'DEVELOPMENT.md must not describe runtime as v0.12.0');

    const scorecardRuntimeTags = [...scorecard.matchAll(/`plugin-runtime-v([^`]+)`/g)].map((match) => match[1]);
    ok(scorecardRuntimeTags.length > 0, 'omcc cutover scorecard includes runtime release tags');

    // Authoritative current-state statements ("as of `plugin-runtime` vX")
    // must all name the current manifest version. Superseded records use the
    // record/re-recorded phrasing instead, so this pattern only matches
    // current-state prose — the defect class a stale "As of v0.84.0" overview
    // survived two releases on, because the existence checks above are
    // satisfied by ANY current token elsewhere in the file.
    // Normalize blockquote hard-wraps ("As of\n> `plugin-runtime` ...") so the
    // line-wrapped DEVELOPMENT.md overview site is matched too, not only the
    // contiguous statements.
    const asOfCorpus = `${architecture}\n${development}`.replace(/\n> /g, ' ');
    const asOfVersions = [...asOfCorpus.matchAll(/[Aa]s of `plugin-runtime` v(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    ok(asOfVersions.length > 0, 'authoritative "as of plugin-runtime v" statements exist in the stage docs');

    if (RELEASE_PLEASE_PR) {
      ok(scorecardRuntimeTags.every((version) => compareSemver(version, manifest.version) <= 0), 'release-please PR may have scorecard release tags lag until installed-state proof is recorded');
      ok(asOfVersions.every((version) => compareSemver(version, manifest.version) <= 0), 'release-please PR may have "as of" statements lag until installed-state proof is recorded');
    } else {
      deepStrictEqual([...new Set(scorecardRuntimeTags)], [manifest.version], `omcc cutover scorecard runtime release tags match the current manifest — ${SYNC_REMEDY}`);
      deepStrictEqual([...new Set(asOfVersions)], [manifest.version], `every authoritative "as of plugin-runtime v" statement matches the current manifest — ${SYNC_REMEDY}`);
    }
  });

  it('keeps the installed-state proof recorded for the shipped runtime version', async () => {
    const { manifest, development, scorecard } = await loadDocs();
    const developmentLatestRuntimeProofToken = `Latest installed proof: \`plugin-runtime\` \`${manifest.version}\``;
    const scorecardRuntimeToken = `\`plugin-runtime\` \`${manifest.version}\``;

    if (RELEASE_PLEASE_PR) {
      ok(/Latest installed proof: `plugin-runtime` `\d+\.\d+\.\d+`/.test(development), 'DEVELOPMENT.md ADR-0012 tracking documents installed runtime proof version');
      ok(/`plugin-runtime` `\d+\.\d+\.\d+`/.test(scorecard), 'omcc cutover scorecard documents installed runtime proof version');
    } else {
      ok(development.includes(developmentLatestRuntimeProofToken), `DEVELOPMENT.md ADR-0012 tracking documents the current installed runtime proof version — ${PROOF_REMEDY}`);
      ok(scorecard.includes(scorecardRuntimeToken), `omcc cutover scorecard documents the current installed runtime proof version — ${PROOF_REMEDY}`);
    }

    ok(!scorecard.includes('latest dogfood evidence'), 'omcc cutover scorecard must leave latest dogfood state to runtime cutover artifacts');

    const scorecardRuntimeVersions = [...scorecard.matchAll(/`plugin-runtime` `([^`]+)`/g)].map((match) => match[1]);
    ok(scorecardRuntimeVersions.length > 0, 'omcc cutover scorecard includes runtime proof versions');

    if (RELEASE_PLEASE_PR) {
      ok(scorecardRuntimeVersions.every((version) => compareSemver(version, manifest.version) <= 0), 'release-please PR may have scorecard proof versions lag until installed-state proof is recorded');
    } else {
      deepStrictEqual([...new Set(scorecardRuntimeVersions)], [manifest.version], `omcc cutover scorecard runtime proof versions match the current manifest — ${PROOF_REMEDY}`);
    }
  });

  it('keeps the README describing the shipped runtime surfaces', async () => {
    const { readme } = await loadDocs();
    for (const token of [
      'runtime:doctor',
      'runtime:settings',
      'runtime:consensus',
      'runtime:compat',
      'runtime:worktree',
      'runtime:context',
      'runtime:cutover',
      'workflow-storage migration',
      'completion footer',
    ]) {
      ok(readme.includes(token), `README.md documents ${token}`);
    }

    ok(!readme.includes('### Coming next'), 'README.md should not list shipped runtime surfaces as coming next');
    ok(!readme.includes('Runtime dynamic consensus, context hygiene, and completion footer'), 'README.md must not carry stale ADR-0024 follow-up wording');
  });

  // cutover-audit.mjs accepts only single-line `| Rn | ... |` rows; a wrapped
  // requirement row silently drops out of the live audit (R3 spanned 40+
  // physical lines and the audit reported 11 rows while the scorecard intended
  // 12 — Plan-verify finding). Pin the exact ID set as single-line rows.
  it('keeps every scorecard requirement row single-line so the cutover audit sees all twelve', async () => {
    const scorecard = await readFile(resolve(REPO_ROOT, 'docs/assurance/omcc-cutover-scorecard.md'), 'utf-8');
    const rows = scorecard.split('\n')
      .filter((line) => line.startsWith('| R') && line.trim().endsWith('|'))
      .map((line) => line.split('|'))
      .filter((parts) => /^R\d+[ab]?$/.test((parts[1] ?? '').trim()));
    for (const parts of rows) {
      // 5 table columns → exactly 7 split parts; a wrapped or stub row loses
      // cells and silently drops out of the live cutover audit.
      strictEqual(parts.length, 7, `requirement row ${parts[1].trim()} carries all five cells on one line`);
    }
    deepStrictEqual([...new Set(rows.map((parts) => parts[1].trim()))].sort(),
      ['R1', 'R10', 'R11', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7a', 'R7b', 'R8', 'R9'],
      'all twelve requirement rows are single-line audit-parseable');
  });
});
