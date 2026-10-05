// plugins/runtime plugin-shape conformance test (ADR-0024 runtime/operator track).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/runtime');

// Where this plugin's skills actually live, read from its own Codex manifest
// rather than assumed. The 2026-09-18 Amendment to ADR-0006 moved the root to
// core/skills/. `resolveSkillsRoot` throws on a broken declaration rather than
// falling back, so this file fails loudly at load instead of pointing every
// path below at a directory nothing writes to. A manifest with no `skills` key
// does fall back, to the README-only `skills/`; the skill checks below fail.
const SKILLS_REL = relative(PLUGIN_ROOT, resolveSkillsRoot(PLUGIN_ROOT)).split(sep).join('/');
const RUNTIME_COMMAND_SURFACES = [
  { name: 'bootstrap', script: 'bootstrap.mjs' },
  { name: 'consensus', script: 'consensus.mjs' },
  { name: 'context', script: 'context.mjs' },
  { name: 'dashboard', script: 'dashboard.mjs' },
  { name: 'doctor', script: 'doctor.mjs' },
  { name: 'migrate', script: 'migrate.mjs' },
  { name: 'retention', script: 'retention.mjs' },
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
    // ADR-0060 removed `runtime:compat`; a keyword naming it would advertise a
    // command the package no longer ships.
    ok(!manifest.keywords.includes('compat'));
    ok(manifest.keywords.includes('worktree'));
    ok(manifest.keywords.includes('context'));
    // ADR-0064 retired `runtime:cutover` for the same reason.
    ok(!manifest.keywords.includes('cutover'));
    ok(manifest.keywords.includes('footer'));
    ok(manifest.keywords.includes('L1'));
  });

  it('Codex manifest is valid JSON with skills/interface', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(manifest.name, 'runtime');
    strictEqual(manifest.skills, './core/skills/',
      'the Codex manifest must declare the relocated root (2026-09-18 Amendment to ADR-0006)');
    strictEqual(manifest.interface.displayName, 'Runtime');
    strictEqual(manifest.interface.developerName, 'each4all');
    strictEqual(manifest.interface.category, 'Productivity');
    deepStrictEqual(manifest.interface.capabilities, ['Read', 'Write']);
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:doctor')));
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:settings')));
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:consensus')));
    ok(manifest.interface.defaultPrompt.some((p) => p.includes('$runtime:context')));
  });

  // ADR-0064 §Decision 5 retired `runtime:cutover`. Beyond the keyword, the
  // shared description, the Codex interface copy and its default prompts are
  // where a manifest would still advertise it.
  it('neither manifest advertises the retired runtime:cutover', async () => {
    for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const raw = await readFile(resolve(PLUGIN_ROOT, rel), 'utf-8');
      ok(raw.includes('runtime'), `${rel} was not read`);
      ok(!/cutover/i.test(raw), `${rel} still mentions cutover`);
    }
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

describe('plugins/runtime command-skill parity', () => {
  it('keeps Claude command wrappers and Codex skill wrappers aligned', async () => {
    const expectedNames = RUNTIME_COMMAND_SURFACES.map((surface) => surface.name).sort();
    const commandFiles = (await readdir(resolve(PLUGIN_ROOT, 'commands')))
      .filter((entry) => entry.endsWith('.md'))
      .sort();
    deepStrictEqual(commandFiles, expectedNames.map((name) => `${name}.md`));

    const skillDirs = (await readdir(resolveSkillsRoot(PLUGIN_ROOT), { withFileTypes: true }))
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

      const skill = await readFile(skillsPath(PLUGIN_ROOT, surface.name, 'SKILL.md'), 'utf-8');
      ok(new RegExp(`^name:\\s*${surface.name}\\s*$`, 'm').test(skill), `${surface.name} skill has matching name`);
      ok(skill.includes(slashToken), `${surface.name} skill documents Claude command token`);
      ok(skill.includes(codexToken), `${surface.name} skill documents Codex command token`);
      ok(skill.includes(scriptRef), `${surface.name} skill references ${scriptRef}`);

      const agent = await readFile(skillsPath(PLUGIN_ROOT, surface.name, 'agents', 'openai.yaml'), 'utf-8');
      ok(agent.includes(codexToken), `${surface.name} agent default prompt references Codex command token`);
      ok(/allow_implicit_invocation:\s*false/.test(agent), `${surface.name} agent is explicit-only`);

      const scriptStat = await stat(resolve(PLUGIN_ROOT, scriptRef));
      ok((scriptStat.mode & 0o111) !== 0, `${surface.script} has executable bit`);
    }
  });
});

// Whether the Codex catalog lists this package, and at which pin, and the
// Claude catalog's version are validate-marketplace's and validate-versions'
// to check (ADR-0065 Decision 8 rule 6). The release job's sync writes them
// after the release commit, so a test reading them would turn that commit
// red; a first release has no Codex entry until the sync adds it.
describe('plugins/runtime marketplace and release registration', () => {
  it('Claude marketplace catalog has a runtime entry for the package directory', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'runtime');
    ok(entry, 'runtime entry present in Claude catalog');
    strictEqual(entry.source, './plugins/runtime');
    strictEqual(entry.category, 'Productivity');
  });

  it('Codex marketplace catalog entry carries the published policy and category', async (t) => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'runtime');
    if (entry === undefined) return t.skip('no Codex entry yet; validate-marketplace decides whether one is due');
    strictEqual(entry.policy.installation, 'AVAILABLE');
    strictEqual(entry.policy.authentication, 'ON_USE');
    strictEqual(entry.category, 'Productivity');
  });

  it('release-please tracks runtime with extra-files for both manifests', async () => {
    // Its version's agreement with the plugin manifests is validate-versions' to
    // check (ADR-0065 Decision 8 rule 6); this pins that release-please tracks it.
    const releasePleaseManifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(typeof releasePleaseManifest['plugins/runtime'], 'string');
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
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'doctor/SKILL.md'), 'utf-8');
    ok(/^name:\s*doctor\s*$/m.test(skill));
    ok(skill.includes('Authentication output must stay sanitized'));
    ok(skill.includes('--execute-deep-peer-smoke'));
    ok(skill.includes('experience_parity'));
    ok(skill.includes('Manual Follow-ups'));
    ok(skill.includes('/hooks'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'doctor/agents/openai.yaml'), 'utf-8');
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
    for (const verb of ['plan', 'status', 'resume', 'verify', 'abandon']) {
      ok(argumentHint.includes(verb), `commands/bootstrap.md argument-hint advertises the '${verb}' verb`);
    }
    for (const flag of ['--bundle', '--plugins', '--answers', '--format', '--run-id', '--latest', '--latest-open', '--reason']) {
      ok(argumentHint.includes(flag), `commands/bootstrap.md argument-hint advertises ${flag}`);
    }
    ok(!argumentHint.includes('--out'), 'there is no --out (§3: writes are constrained to the authorized home)');
    // Interview pacing is the command's ONLY ownership — schema decisions live
    // in the packaged contract, and the pacing order is the contract's §Decision-8.
    ok(/diagnose/i.test(command) && /re-probe/i.test(command), 'commands/bootstrap.md carries the interview pacing order');
    ok(/--expected-plan-hash/.test(command), 'commands/bootstrap.md presents the §1.6 plan-hash executor handoff');

    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'bootstrap/SKILL.md'), 'utf-8');
    ok(/^name:\s*bootstrap\s*$/m.test(skill));
    ok(skill.includes('machine-bootstrap-contract.md'), 'skill points at the packaged normative contract');
    ok(/never an? (second )?executor|no second executor/i.test(skill), 'skill states the no-second-executor boundary');
    ok(/read-only/i.test(skill) && skill.includes('status'), 'skill states the R0 status/verify boundary');

    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'bootstrap/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:bootstrap'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/bootstrap.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'bootstrap.mjs has executable bit');

    // ADR-0064 removed the portable machine profile (Decision 3) and the egress
    // receipt testimony (Decisions 1 and 6): neither stays advertised on a public
    // surface. The parser's refusal of each is pinned in test-bootstrap-cli.mjs.
    for (const [label, surface] of [['commands/bootstrap.md', command], [`${SKILLS_REL}/bootstrap/SKILL.md`, skill], ['bootstrap agent yaml', agent]]) {
      ok(!surface.includes('--profile-file'), `${label} no longer advertises the removed plan --profile-file`);
      ok(!/\bprofile (export|seed)\b/.test(surface), `${label} no longer advertises the removed profile verbs`);
      ok(!surface.includes('attest-receipt'), `${label} no longer advertises the removed attest-receipt answer`);
    }
    ok(!/\battest\b/.test(argumentHint), 'commands/bootstrap.md argument-hint no longer advertises the removed attest verb');
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
      'runtime-bootstrap-run-1',
      'configured-not-verified',
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

  // The root README's egress env-var test went with egress-config.mjs, the
  // code authority it imported the names from (ADR-0064 R4n2).
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
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'settings/SKILL.md'), 'utf-8');
    ok(/^name:\s*settings\s*$/m.test(skill));
    ok(skill.includes('Host-native Claude Code'));
    ok(skill.includes('Non-executable host-CLI install plans'));
    ok(skill.includes('--execute-plugin-management'));
    ok(!skill.includes('[--apply-codex-plugin-hooks]'));
    ok(skill.includes('/hooks'));
    ok(skill.includes('--skip-host-cli-probes'));
    ok(skill.includes('settings-report-contract.md'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'settings/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:settings'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    ok(agent.includes('--skip-host-cli-probes'));

    // ADR-0057 removed the permission plan and its three flags, so the
    // discoverability pins that named them went with the surfaces they pinned.
    // The two properties that block underneath them did NOT go, and are re-pointed
    // here rather than deleted with their first subject:
    //
    //   (a) the MUTATION BOUNDARY. Measured during the removal: the exact sentence
    //       "never writes host config" lived inside the `--permission-plan` bullet
    //       on both surfaces, so deleting that bullet silently took the general
    //       boundary statement with it. This assertion is what caught it.
    //   (b) the SAFETY-GRADING CEILING. `bypassPermissions` / `danger-full-access`
    //       are never proposed as a target default. That rule is a property of
    //       PROFILE SEEDING (machine-profile.mjs UNSAFE_CLAUDE_MODES), not of the
    //       advisory, so it was pinned on bootstrap's surface. ADR-0064 Decision 3
    //       removed profile seeding and its pin; the policy stands in ADR-0057 D8
    //       and ADR-0038 §6, and no runtime surface proposes a posture any more.
    for (const [label, surface] of [['commands/settings.md', command], [`${SKILLS_REL}/settings/SKILL.md`, skill]]) {
      ok(/never writes host config/i.test(surface), `${label} states the no-host-config-write boundary`);
    }
    // And the removed surface stays removed on every public surface.
    for (const [label, surface] of [['commands/settings.md', command], [`${SKILLS_REL}/settings/SKILL.md`, skill], ['settings agent yaml', agent]]) {
      ok(!surface.includes('--permission-plan'), `${label} no longer advertises the removed --permission-plan`);
    }
  });

  // The plugin set drifted: this skill claimed four plugins, the runtime README
  // claimed four, the root README six, and the catalogs eight — with nothing
  // holding them in agreement. `PLUGIN_NAMES` is what settings and doctor
  // actually iterate, so it is the authority; every runtime-owned surface that
  // enumerates the set is pinned against it, and so is the Claude catalog.
  it('keeps the runtime-owned plugin lists in agreement with PLUGIN_NAMES and the Claude catalog', async () => {
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
    deepStrictEqual(claudeCatalog.plugins.map((p) => p.name).sort(), pluginNames, 'Claude catalog matches PLUGIN_NAMES');
    // The Codex catalog is held to the Claude one by validate-marketplace, less
    // any package whose first release it has not pinned yet (ADR-0065
    // Decision 8 rules 2, 3 and 6), so PLUGIN_NAMES reaches it through that.

    // Every runtime-owned prose surface that enumerates the set must name all of
    // them. A four-name list here is how the drift started.
    const proseSurfaces = [`${SKILLS_REL}/settings/SKILL.md`, `${SKILLS_REL}/doctor/SKILL.md`, 'README.md'];
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
    for (const token of ['Plugin management beyond the explicit settings executor', 'Consensus executor depth beyond the explicit boundary', 'Worktree execution beyond read-only planning', 'Context automation', 'Completion footer', 'Probe-free `runtime:settings` mode']) {
      ok(followUps.includes(token), `${token} documented`);
    }
    // The two baseline-drift rows are CLOSED, not dropped: ADR-0060 deleted the
    // documents they asked later work to refresh first, and §Decision 7 asks for
    // a disposition per row rather than a silent removal.
    for (const title of ['Codex capability drift beyond the current baseline', 'Claude-vs-Codex parity drift beyond the current baseline']) {
      ok(followUps.includes(`- ~~${title}~~ — **RESOLVED BY REMOVAL ([ADR-0060]`), `${title} carries its ADR-0060 disposition`);
    }
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
});

describe('plugins/runtime migrate surface', () => {
  it('ships migrate command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/migrate.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/migrate.mjs'));
    ok(/dry-run/i.test(command));
    ok(command.includes('--apply'));
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'migrate/SKILL.md'), 'utf-8');
    ok(/^name:\s*migrate\s*$/m.test(skill));
    ok(skill.includes('ADR-0025'));
    ok(skill.includes('No workflow schema conversion'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'migrate/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:migrate workflow-storage'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    for (const script of ['migrate.mjs', 'migrate-workflow-storage.mjs']) {
      const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts', script));
      ok((scriptStat.mode & 0o111) !== 0, `${script} has executable bit`);
    }
  });

  // The `legacy-egress-intents` subcommand, doctor's legacy-intent blocker and
  // the egress intent WAL went with egress (ADR-0064 R4n2), and so did the
  // tests that pinned their read-only surface, quiesce wording and single WAL
  // definition. The operator-text half of that last guard stays below.

  it('the shared operator-text primitive has exactly ONE definition', async () => {
    // T1's guard. A safety fix landing on one copy while another keeps
    // shipping is the failure this repository has hit repeatedly.
    // `safeOperatorText` moved to its own module because its migrate consumers
    // outlived the egress intent WAL it was extracted beside (ADR-0064
    // Decision 2).
    const dirs = ['scripts', 'scripts/lib'];
    const home = {
      safeOperatorText: 'scripts/lib/operator-text.mjs',
    };
    const definitions = Object.fromEntries(Object.keys(home).map((symbol) => [symbol, []]));
    for (const dir of dirs) {
      const abs = resolve(PLUGIN_ROOT, dir);
      for (const name of await readdir(abs)) {
        if (!name.endsWith('.mjs')) continue;
        const source = await readFile(resolve(abs, name), 'utf-8');
        for (const symbol of Object.keys(definitions)) {
          const defined = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\s*\\(|(?:^|\\n)\\s*(?:export\\s+)?const\\s+${symbol}\\s*=`);
          if (defined.test(source)) definitions[symbol].push(`${dir}/${name}`);
        }
      }
    }
    for (const [symbol, files] of Object.entries(definitions)) {
      deepStrictEqual(files, [home[symbol]], `${symbol} must be defined once, in ${home[symbol]} (found in: ${files.join(', ') || 'nowhere'})`);
    }
  });
});

describe('plugins/runtime consensus surface', () => {
  it('ships consensus command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/consensus.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/consensus.mjs'));
    ok(command.includes('artifact'));
    ok(command.includes('execute --execute'));
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'consensus/SKILL.md'), 'utf-8');
    ok(/^name:\s*consensus\s*$/m.test(skill));
    ok(skill.includes('raw peer output out of the main session'));
    ok(skill.includes('No peer execution except `execute --execute`'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'consensus/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:consensus'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/consensus.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'consensus.mjs has executable bit');
  });
});

describe('plugins/runtime compat surface — removed (ADR-0060)', () => {
  it('ships no compat command, skill, script or baseline document', async () => {
    // The command-skill parity case above enumerates what IS shipped; this one
    // pins what is not, so a surface restored by a stray revert or a bad merge
    // fails by name instead of only as a longer directory listing.
    for (const removed of [
      'commands/compat.md',
      `${SKILLS_REL}/compat`,
      'scripts/compat.mjs',
      'scripts/lib/compat-artifacts.mjs',
      'scripts/lib/host-parity-baseline.mjs',
      'scripts/lib/host-version-probe.mjs',
      'docs/host-parity-baseline.md',
      'docs/codex-capability-baseline.md',
    ]) {
      await rejects(() => stat(resolve(PLUGIN_ROOT, removed)), /ENOENT/, `${removed} must stay removed`);
    }
  });
});

describe('plugins/runtime worktree surface', () => {
  it('ships worktree command, skill wrapper, agent yaml, and executable script', async () => {
    const command = await readFile(resolve(PLUGIN_ROOT, 'commands/worktree.md'), 'utf-8');
    ok(command.startsWith('---\n'));
    ok(command.includes('scripts/worktree.mjs'));
    ok(/read-only/i.test(command));
    ok(command.includes('git worktree add'));
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'worktree/SKILL.md'), 'utf-8');
    ok(/^name:\s*worktree\s*$/m.test(skill));
    ok(skill.includes('never creates branches or worktrees'));
    ok(skill.includes('No `git worktree add`'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'worktree/agents/openai.yaml'), 'utf-8');
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
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'context/SKILL.md'), 'utf-8');
    ok(/^name:\s*context\s*$/m.test(skill));
    ok(skill.includes('No host session context mutation'));
    ok(skill.includes('No consensus raw output or peer raw output in the main session'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'context/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('$runtime:context'));
    ok(/allow_implicit_invocation:\s*false/.test(agent));
    const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts/context.mjs'));
    ok((scriptStat.mode & 0o111) !== 0, 'context.mjs has executable bit');
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
    const skill = await readFile(skillsPath(PLUGIN_ROOT, 'dashboard/SKILL.md'), 'utf-8');
    ok(/^name:\s*dashboard\s*$/m.test(skill));
    ok(skill.includes('No host CLI probing'));
    ok(skill.includes('No state mutation'));
    ok(skill.includes('No unbounded loops'));
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'dashboard/agents/openai.yaml'), 'utf-8');
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

  // JUDGED HERE rather than deferred, because a later subtask that wanted a
  // different document shape would have had to touch a protected asset a
  // second time (ADR-0052's release obligation, superseded by ADR-0065).
  //
  // ⚠ THE ASSURANCE SECTION AND ITS SCHEMA ARE GONE (ADR-0056 §Decisions 1
  // and 5), and their absence is asserted rather than assumed. The section was
  // an author-editable free-text region inside a PROTECTED asset, and the one
  // way its removal could silently regress is a later edit re-adding it — at
  // which point the packaged baseline would carry a record no reader parses and
  // `$id` reuse would become possible.
  //
  // ⚠ THIS IS A PROSE-TOKEN CHECK, WHICH THIS FILE'S OWN NOTE WARNS ABOUT, and
  // the direction is what makes it safe here. The warning is against asserting
  // PRESENCE by substring — satisfiable by any sentence containing the phrase.
  // Asserting ABSENCE has the opposite failure mode: a false red on an innocent
  // mention, which is loud and cheap, rather than a false green on a broken
  // record. The sentinels are matched because they are the machine-readable
  // delimiters, not the human heading.
  it('the compatibility-assurance schema stays removed, and so does the baseline that carried its section', async () => {
    // ADR-0056 removed the assurance block from the packaged baseline; ADR-0060
    // then removed the baseline itself, which is the stronger form of the same
    // guarantee.
    await rejects(() => readFile(resolve(PLUGIN_ROOT, 'docs/host-parity-baseline.md'), 'utf-8'), /ENOENT/);
    await rejects(
      () => readJSON(resolve(PLUGIN_ROOT, 'data/schemas/runtime-host-assurance-1.0.json')),
      /ENOENT/,
      'the assurance schema is removed and its $id is never reused (ADR-0056 §Decision 5)',
    );
  });
});

describe('plugins/runtime repo documentation', () => {
  // The stage docs no longer restate the shipped runtime version or the
  // installed proof, so nothing here compares them with the manifest
  // (ADR-0065 Decisions 1 and 2). A shipped version is read from
  // .release-please-manifest.json, the changelogs and the release tags.
  const loadDocs = async () => ({
    readme: await readFile(resolve(REPO_ROOT, 'README.md'), 'utf-8'),
  });

  it('keeps the README describing the shipped runtime surfaces', async () => {
    const { readme } = await loadDocs();
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

    ok(!readme.includes('runtime:compat'), 'README.md must not advertise the command ADR-0060 removed');
    ok(!readme.includes('runtime:cutover'), 'README.md must not advertise the command ADR-0064 retired');
    ok(!readme.includes('### Coming next'), 'README.md should not list shipped runtime surfaces as coming next');
    ok(!readme.includes('Runtime dynamic consensus, context hygiene, and completion footer'), 'README.md must not carry stale ADR-0024 follow-up wording');
  });
});
