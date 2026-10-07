// plugins/runtime plugin-shape conformance test (ADR-0024 runtime/operator track).
//
// E1's rule (owner-approved 2026-10-05) decides what a text assertion here may
// pin: what a host or program reads (manifests, catalogs, frontmatter, the
// openai.yaml interface, the script a surface runs, schema files), or an
// instruction that changes what the agent running a runtime surface may run,
// when it stops or how it hands off. Each one says which, beside it.

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

// Markdown wraps and bolds freely; an instruction is the same instruction
// across a reflow, so the pins below match the flattened text.
const flat = (text) => text.replace(/\*\*/g, '').replace(/\s+/g, ' ');

// Every line that starts a `node "…/scripts/<file>.mjs"` invocation names
// `script`, and at least one does.
function nodeLinesRunOnly(text, script) {
  const lines = text.split('\n').filter((line) => /^\s*node "[^"]*\/scripts\//.test(line));
  return lines.length > 0 && lines.every((line) => line.includes(`/scripts/${script}"`));
}

async function surfaceText(name) {
  return {
    command: flat(await readFile(resolve(PLUGIN_ROOT, `commands/${name}.md`), 'utf-8')),
    skill: flat(await readFile(skillsPath(PLUGIN_ROOT, name, 'SKILL.md'), 'utf-8')),
  };
}

// Contract: Claude Code and Codex read these manifest fields to install, list and
// load the plugin — a missing or mistyped field breaks install or the listing.
describe('plugins/runtime manifest pair', () => {
  it('Claude manifest is valid JSON with required L1 runtime fields', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(manifest.name, 'runtime');
    ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'version is semver');
    strictEqual(typeof manifest.description, 'string');
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
    // Contract: Codex loads skills from this path — a wrong path loads none.
    strictEqual(manifest.skills, './core/skills/',
      'the Codex manifest must declare the relocated root (2026-09-18 Amendment to ADR-0006)');
    strictEqual(manifest.interface.displayName, 'Runtime');
    strictEqual(manifest.interface.developerName, 'each4all');
    strictEqual(manifest.interface.category, 'Productivity');
    deepStrictEqual(manifest.interface.capabilities, ['Read', 'Write']);
    // Contract: Codex offers defaultPrompt as starter prompts — one naming a
    // skill the plugin does not ship (a retired `$runtime:cutover`, say) starts
    // nothing.
    ok(manifest.interface.defaultPrompt.length > 0, 'defaultPrompt offers at least one prompt');
    const shipped = RUNTIME_COMMAND_SURFACES.map((surface) => surface.name);
    const named = manifest.interface.defaultPrompt.flatMap((p) => [...p.matchAll(/\$runtime:([a-z0-9-]+)/g)].map((m) => m[1]));
    ok(named.length > 0, 'the default prompts name a runtime skill');
    deepStrictEqual(named.filter((name) => !shipped.includes(name)), [], 'every $runtime:<skill> a default prompt names ships');
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
    // Contract: Claude Code lists commands/*.md and Codex loads one directory per
    // skill — a surface shipped on one host only is missing on the other.
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
      const codexToken = `$runtime:${surface.name}`;
      const command = await readFile(resolve(PLUGIN_ROOT, `commands/${surface.name}.md`), 'utf-8');
      // Contract: Claude Code reads command frontmatter — without it the command
      // loses its description and argument hint in the listing.
      ok(command.startsWith('---\n'), `${surface.name} command has frontmatter`);
      ok(/^description:\s*\S/m.test(command), `${surface.name} command has description`);
      ok(/^argument-hint:\s*/m.test(command), `${surface.name} command has argument hint`);
      // Contract: the agent running the command runs the script its `node` lines
      // name — a line naming another surface's script runs that surface instead.
      ok(command.includes(scriptRef), `${surface.name} command references ${scriptRef}`);
      ok(nodeLinesRunOnly(command, surface.script), `${surface.name} command: every node invocation runs ${scriptRef}`);

      const skill = await readFile(skillsPath(PLUGIN_ROOT, surface.name, 'SKILL.md'), 'utf-8');
      // Contract: Codex reads `name` from SKILL.md frontmatter and resolves
      // `$runtime:<name>` by it — a mismatch makes the mention resolve nothing.
      ok(new RegExp(`^name:\\s*${surface.name}\\s*$`, 'm').test(skill), `${surface.name} skill has matching name`);
      // Contract: the Codex agent runs this script — as for the command above.
      ok(skill.includes(scriptRef), `${surface.name} skill references ${scriptRef}`);
      ok(nodeLinesRunOnly(skill, surface.script), `${surface.name} skill: every node invocation runs ${scriptRef}`);

      const agent = await readFile(skillsPath(PLUGIN_ROOT, surface.name, 'agents', 'openai.yaml'), 'utf-8');
      // Contract: Codex reads openai.yaml — a default prompt that does not name its
      // own skill starts another one, and an implicit policy lets Codex run a
      // runtime command the user never asked for.
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
// Contract: the host catalogs and release-please read these entries — a wrong
// source, policy or package key leaves the plugin uninstallable or unreleased.
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

  // `PLUGIN_NAMES` is what settings and doctor iterate.
  it('PLUGIN_NAMES agrees with the Claude catalog', async () => {
    // Contract: settings and doctor iterate PLUGIN_NAMES to plan and diagnose
    // installs — a catalog plugin missing from it is never planned or checked.
    const machineProbeSrc = await readFile(resolve(PLUGIN_ROOT, 'scripts/lib/machine-probe.mjs'), 'utf-8');
    const namesMatch = machineProbeSrc.match(/export const PLUGIN_NAMES = \[([^\]]+)\]/);
    ok(namesMatch, 'machine-probe.mjs defines PLUGIN_NAMES');
    // Contract: doctor's importers read PLUGIN_NAMES from doctor.mjs — a dropped
    // re-export breaks them at import.
    const doctorSrc = await readFile(resolve(PLUGIN_ROOT, 'scripts/doctor.mjs'), 'utf-8');
    ok(/export \{[^}]*\bPLUGIN_NAMES\b[^}]*\}/.test(doctorSrc), 'doctor.mjs re-exports PLUGIN_NAMES for its public surface');
    const pluginNames = namesMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();

    const claudeCatalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    deepStrictEqual(claudeCatalog.plugins.map((p) => p.name).sort(), pluginNames, 'Claude catalog matches PLUGIN_NAMES');
    // The Codex catalog is held to the Claude one by validate-marketplace, less
    // any package whose first release it has not pinned yet (ADR-0065
    // Decision 8 rules 2, 3 and 6), so PLUGIN_NAMES reaches it through that.
  });

  // Contract: runtime:bootstrap prints STAGE0_COMMANDS for the operator to run
  // and records the marketplace command as that step's apply_command, and the
  // host CLI resolves `<owner>/<repo>` and `<plugin>@<catalog>` — a wrong
  // repository, plugin or catalog name is an install command that fails.
  it('the Stage 0 commands bootstrap presents name the published repository, plugin and catalogs', async () => {
    const { STAGE0_COMMANDS } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/bootstrap.mjs')).href);
    const { CANONICAL_MARKETPLACE } = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/lib/machine-probe.mjs')).href);
    const plugin = (await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'))).name;
    const claudeCatalog = (await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'))).name;
    const codexCatalog = (await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'))).name;
    deepStrictEqual(STAGE0_COMMANDS, {
      claude: [`claude plugin marketplace add ${CANONICAL_MARKETPLACE.repo}`, `claude plugin install ${plugin}@${claudeCatalog}`],
      codex: [`codex plugin marketplace add ${CANONICAL_MARKETPLACE.repo}`, `codex plugin add ${plugin}@${codexCatalog}`],
    });
  });
});

// The instructions the agent running each runtime surface follows: what it may
// run, what it must leave to the operator, and what it may hand to the main
// session. AGENTS.md states them for runtime as a whole ("Runtime never loops
// consensus without bound, relaxes a host's permissions, mutates a host
// session's context or Codex trust state, or puts raw peer output in the main
// session"). Each surface's own boundary is pinned below on the surface the
// agent reads, the command and the Codex skill where both carry one; the
// consensus round cap is code (consensus.mjs MAX_ROUNDS_CAP, held by
// tests/runtime/test-consensus.mjs), not an instruction.
describe('plugins/runtime agent boundaries', () => {
  it('doctor: read-only, execution proofs only on the user’s execute flag, and sanitized output', async () => {
    const { command, skill } = await surfaceText('doctor');
    // Contract: the agent running /runtime:doctor — without it the agent "fixes"
    // what doctor found: installs a plugin, edits settings, runs a login, sweeps
    // a ledger or relaxes the sandbox, none of which the user asked for.
    ok(command.includes('It is read-only: it does not install plugins, mutate settings, run authentication, sweep ledgers, or relax sandbox/permission settings.'),
      'commands/doctor.md states the read-only boundary');
    // Contract: the Codex agent running doctor — without the gate it adds the
    // execute flag itself and runs a live peer smoke the user only asked to plan.
    ok(skill.includes('`--deep-peer-smoke` remains plan-only unless the user also supplies `--execute-deep-peer-smoke`'),
      'doctor skill gates the deep peer smoke on the user’s execute flag');
    // Contract: the Codex agent relaying doctor's report — without it the agent
    // may paste account email, org id or tokens into the session.
    ok(skill.includes('Authentication output must stay sanitized'), 'doctor skill keeps authentication output sanitized');
    // Contract: the Codex agent hands host-native follow-ups to the operator —
    // without it the agent implies runtime applied them, or tries to itself.
    ok(skill.includes('surface the `Manual Follow-ups` checklist'), 'doctor skill hands manual follow-ups to the operator');
  });

  it('bootstrap: the interview order, and the operator alone applies and executes', async () => {
    const { command, skill } = await surfaceText('bootstrap');
    // Contract: the agent conducting the interview — out of order it asks before
    // the probe or confirms before re-probing.
    for (const [label, text] of [['commands/bootstrap.md', command], [`${SKILLS_REL}/bootstrap/SKILL.md`, skill]]) {
      ok(text.includes('diagnose → ask → render → apply-command → re-probe + confirm'), `${label} paces the interview in order`);
    }
    // Contract: the agent running /runtime:bootstrap — without it the agent applies
    // fragments or runs plugin management itself, a second executor.
    ok(command.includes('runs the presented `runtime:settings --execute-plugin-management --expected-plan-hash <hash>` themselves. This command never applies a fragment and never executes plugin management'),
      'commands/bootstrap.md leaves applying and plugin management to the operator');
    // Contract: the Codex agent running $runtime:bootstrap — the same boundary, and
    // proofs only on an explicit operator `execute` answer.
    ok(skill.includes('No second executor: plugin management is presented to `runtime:settings --execute-plugin-management`'),
      'bootstrap skill states the no-second-executor boundary');
    ok(skill.includes('only on an explicit operator `execute` answer'), 'bootstrap skill runs proofs only on an operator execute answer');
  });

  it('bootstrap: the argument hint advertises the grammar the parser accepts, and nothing it refuses', async () => {
    const raw = await readFile(resolve(PLUGIN_ROOT, 'commands/bootstrap.md'), 'utf-8');
    const { skill } = await surfaceText('bootstrap');
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'bootstrap/agents/openai.yaml'), 'utf-8');
    // Contract: Claude Code shows argument-hint as the arguments to type, and the
    // agent passes what was typed — a verb or flag missing or misspelled there
    // is one the user cannot find, and one the parser refuses (pinned in
    // test-bootstrap-cli.mjs) is a usage error the hint invited.
    const argumentHint = raw.split('\n').find((line) => line.startsWith('argument-hint:'));
    ok(argumentHint, 'commands/bootstrap.md has an argument-hint');
    for (const verb of ['plan', 'status', 'resume', 'verify', 'abandon']) {
      ok(argumentHint.includes(verb), `commands/bootstrap.md argument-hint advertises the '${verb}' verb`);
    }
    for (const flag of ['--bundle', '--plugins', '--answers', '--format', '--run-id', '--latest', '--latest-open', '--reason']) {
      ok(argumentHint.includes(flag), `commands/bootstrap.md argument-hint advertises ${flag}`);
    }
    ok(!argumentHint.includes('--out'), 'there is no --out (§3: writes are constrained to the authorized home)');
    ok(!/\battest\b/.test(argumentHint), 'commands/bootstrap.md argument-hint does not advertise the removed attest verb');
    // Contract: the agent and Codex read these surfaces for what to pass — ADR-0064
    // removed the profile file, the profile verbs and the receipt answer, and the
    // parser refuses each.
    for (const [label, surface] of [['commands/bootstrap.md', raw], [`${SKILLS_REL}/bootstrap/SKILL.md`, skill], ['bootstrap agent yaml', agent]]) {
      ok(!surface.includes('--profile-file'), `${label} does not advertise the removed plan --profile-file`);
      ok(!/\bprofile (export|seed)\b/.test(surface), `${label} does not advertise the removed profile verbs`);
      ok(!surface.includes('attest-receipt'), `${label} does not advertise the removed attest-receipt answer`);
    }
  });

  it('settings: never writes host config, and attests the Codex hook review only after it', async () => {
    const { command, skill } = await surfaceText('settings');
    // Contract: the agent running settings — without it the agent may edit host
    // config, credentials or permission settings to "apply" a plan. ADR-0057
    // removed the bullet that once carried this sentence and took the boundary
    // with it, which this assertion caught.
    for (const [label, text] of [['commands/settings.md', command], [`${SKILLS_REL}/settings/SKILL.md`, skill]]) {
      ok(/never writes host config/i.test(text), `${label} states the no-host-config-write boundary`);
    }
    // Contract: the Codex agent running --attest-codex-hook-review — run early, it
    // records a review the operator never made and doctor clears the follow-up.
    ok(skill.includes('Run it only after the active Codex session has opened `/hooks` and the operator has reviewed/trusted'),
      'settings skill attests the hook review only after the operator made it');
    // Contract: the Codex agent running settings — without it the agent runs the
    // host-native install guidance itself.
    ok(skill.includes('never installs the host CLIs itself'), 'settings skill leaves host-CLI installs to the operator');
    // Contract: Codex runs the settings default prompt — a misspelled flag there,
    // or one settings refuses (ADR-0057 removed --permission-plan, ADR-0035 §6
    // --apply-codex-plugin-hooks), sends the agent into a usage error.
    const agent = await readFile(skillsPath(PLUGIN_ROOT, 'settings/agents/openai.yaml'), 'utf-8');
    ok(agent.includes('--skip-host-cli-probes'), 'settings default prompt names the probe-free flag');
    for (const [label, text] of [['commands/settings.md', command], [`${SKILLS_REL}/settings/SKILL.md`, skill], ['settings agent yaml', agent]]) {
      ok(!text.includes('--permission-plan'), `${label} does not advertise the removed --permission-plan`);
      ok(!text.includes('[--apply-codex-plugin-hooks]'), `${label} does not advertise the removed --apply-codex-plugin-hooks`);
    }
  });

  it('migrate: no workflow schema conversion', async () => {
    const { skill } = await surfaceText('migrate');
    // Contract: the Codex agent running migrate — without it the agent rewrites
    // workflow files it was only meant to move.
    ok(skill.includes('No workflow schema conversion'), 'migrate skill forbids schema conversion');
    for (const script of ['migrate-workflow-storage.mjs']) {
      const scriptStat = await stat(resolve(PLUGIN_ROOT, 'scripts', script));
      ok((scriptStat.mode & 0o111) !== 0, `${script} has executable bit`);
    }
  });

  it('consensus: peers execute only through `execute --execute`, and raw output stays out of the main session', async () => {
    const { command, skill } = await surfaceText('consensus');
    // Contract: the agent running consensus — without it the agent dispatches
    // peers on plan or record, outside the explicit executor.
    ok(command.includes('Companion dispatch requires the explicit `execute --execute` boundary'), 'consensus command gates dispatch on execute --execute');
    ok(skill.includes('No peer execution except `execute --execute`'), 'consensus skill gates dispatch on execute --execute');
    // Contract: the Codex agent relaying consensus — without it raw peer output
    // lands in the main session.
    ok(skill.includes('raw peer output out of the main session'), 'consensus skill keeps raw peer output out of the main session');
  });

  it('worktree: the agent never creates worktrees itself', async () => {
    const { command, skill } = await surfaceText('worktree');
    // Contract: the agent running /runtime:worktree — without it the agent runs the
    // suggested `git worktree add` it was only meant to present.
    ok(command.includes('are not executed. Run them manually only after accepting the plan.'), 'worktree command leaves the suggested commands to the operator');
    // Contract: the Codex agent running worktree — without it the agent runs the
    // suggested `git worktree add` itself.
    ok(skill.includes('never creates branches or worktrees'), 'worktree skill never creates branches or worktrees');
    ok(skill.includes('No `git worktree add`'), 'worktree skill forbids git worktree add');
  });

  it('context: no host session mutation, and a bounded main-session output', async () => {
    const { command, skill } = await surfaceText('context');
    // Contract: the agent running context — without it the agent trims or
    // rewrites the host session context it was asked to measure.
    ok(command.includes('does not trim, rewrite, or mutate host session context'), 'context command does not mutate host session context');
    ok(skill.includes('No host session context mutation'), 'context skill does not mutate host session context');
    // Contract: what the agent hands to the main session — without it the agent
    // pastes consensus or peer raw output there.
    ok(command.includes('Main-session output is limited to context summary, risk level, artifact pointers, and recommended next-session prompt/action.'), 'context command bounds main-session output');
    ok(skill.includes('No consensus raw output or peer raw output in the main session'), 'context skill keeps raw output out of the main session');
  });

  it('dashboard: no host CLI probes, no state mutation, no unbounded loop', async () => {
    const { command, skill } = await surfaceText('dashboard');
    // Contract: the agent running dashboard — without these it spawns claude/codex
    // to fill a gap, writes under .agentic-plugins/, or watches without an exit.
    ok(command.includes('never probes host CLIs'), 'dashboard command never probes host CLIs');
    ok(skill.includes('No host CLI probing'), 'dashboard skill never probes host CLIs');
    ok(skill.includes('No state mutation'), 'dashboard skill does not mutate state');
    ok(skill.includes('No unbounded loops'), 'dashboard skill does not loop without bound');
  });
});

// Each surface's own parser, as a probe that answers whether it takes a token.
// A parser refuses a flag it does not know by naming it ("Unknown argument:
// --x", "flag --x is not part of the 'plan' grammar"), and a subcommand it does
// not know with an unknown-verb, unknown-subcommand or must-be-one-of message;
// a missing value or a conflicting flag is a different refusal. A parser that
// throws anything but a usage error (a TypeError, say) fails the test rather
// than reading as acceptance. No probe gets past argument parsing: retention
// exports only its CLI entry, which refuses an unknown subcommand or format
// before it reads anything, so its probe brackets the token with one.
const FLAG_REFUSAL = /\bunknown\b|is not part of|there is no|accepted on exactly/i;
const SUBCOMMAND_REFUSAL = /unknown (?:verb|subcommand|argument)|command must be one of|unexpected positional/i;

async function refuses(parse, token) {
  let message = '';
  try {
    const result = await parse();
    if (result && result.ok === false) message = String(result.reason);
  } catch (err) {
    if (err?.constructor !== Error && err?.constructor?.name !== 'UsageError') {
      throw new Error(`the parser threw ${err?.constructor?.name} on ${JSON.stringify(token)}, not a usage error: ${err?.message}`);
    }
    message = String(err.message);
  }
  return token.startsWith('--') ? FLAG_REFUSAL.test(message) && message.includes(token) : SUBCOMMAND_REFUSAL.test(message);
}

async function argumentProbes() {
  const script = (file) => import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts', file)).href);
  const [bootstrap, consensus, context, dashboard, doctor, migrate, workflowStorage, retention, settings, worktree] = await Promise.all([
    'bootstrap.mjs', 'consensus.mjs', 'context.mjs', 'dashboard.mjs', 'doctor.mjs',
    'migrate.mjs', 'migrate-workflow-storage.mjs', 'retention.mjs', 'settings.mjs', 'worktree.mjs',
  ].map(script));
  const alone = (parse) => (token) => refuses(() => parse([token]), token);
  return {
    // A verb first, then that verb's flags: a flag is taken if one verb takes
    // it, or on its own (`--help`).
    bootstrap: async (token) => {
      if (!(await refuses(() => bootstrap.parseBootstrapArgs([token]), token))) return false;
      if (!token.startsWith('--')) return true;
      for (const verb of ['plan', 'status', 'resume', 'verify', 'abandon']) {
        if (!(await refuses(() => bootstrap.parseBootstrapArgs([verb, token]), token))) return false;
      }
      return true;
    },
    consensus: alone(consensus.parseArgs),
    context: alone(context.parseArgs),
    dashboard: alone(dashboard.parseDashboardArgs),
    doctor: alone(doctor.parseArgs),
    // The dispatcher refuses a retired subcommand by name and hands the rest
    // of argv to the workflow-storage parser.
    migrate: async (token) => {
      const { subcommand, rest } = migrate.splitSubcommand([token]);
      if (Object.hasOwn(migrate.RETIRED_MIGRATE_SUBCOMMANDS, subcommand)) return true;
      return refuses(() => workflowStorage.parseArgs(rest), token);
    },
    retention: (token) => refuses(
      () => retention.runRetentionCli(token.startsWith('--') ? ['__probe__', token] : [token, '--format', '__probe__']),
      token,
    ),
    settings: alone(settings.parseArgs),
    worktree: alone(worktree.parseArgs),
  };
}

describe('plugins/runtime advertised arguments', () => {
  // Contract: Claude Code shows a command's argument-hint as the arguments to
  // type, and Codex runs a skill's default prompt (and the plugin's starter
  // prompts) as written; the agent passes those tokens to the surface's script.
  // A flag or subcommand there that the parser does not take — misspelled, or
  // retired — is a usage error the surface itself invited. Subcommands are read
  // from the prompts, which name one in a runnable position; a hint lists its
  // subcommands in a grammar this test does not parse.
  it('every flag a hint or default prompt names, and every subcommand a prompt names, is one its parser takes', async () => {
    const probes = await argumentProbes();
    deepStrictEqual(Object.keys(probes).sort(), RUNTIME_COMMAND_SURFACES.map((surface) => surface.name).sort(),
      'every runtime surface has a parser probe');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    for (const { name } of RUNTIME_COMMAND_SURFACES) {
      const command = await readFile(resolve(PLUGIN_ROOT, `commands/${name}.md`), 'utf-8');
      const agent = await readFile(skillsPath(PLUGIN_ROOT, name, 'agents', 'openai.yaml'), 'utf-8');
      const hint = command.split('\n').find((line) => line.startsWith('argument-hint:'));
      const prompt = agent.split('\n').find((line) => line.trimStart().startsWith('default_prompt:'));
      ok(hint && prompt, `${name}: the argument-hint and the default prompt are found`);
      // A starter prompt may name several skills; each takes the part after its token.
      const starters = manifest.interface.defaultPrompt
        .flatMap((p) => p.split('$runtime:').slice(1))
        .filter((part) => new RegExp(`^${name}\\b`).test(part))
        .map((part) => `$runtime:${part}`);
      // Whole tokens, up to the grammar's own delimiters: a pattern that stopped
      // at the first character outside [a-z0-9-] would read `--watch_count` as
      // `--watch` and probe a flag the surface never named. A prompt is a
      // sentence, so a token ending it loses the period or colon; a hint is
      // grammar, so its tokens are probed as written — stripping there would
      // repair a malformed `[--watch-count. <n>]` into the flag it misspells.
      const FLAG = /--[^\s[\]|<>"'=,;()`]+/g;
      const whole = (token) => token.replace(/[.:]+$/, '');
      const flags = new Set([
        ...[...hint.matchAll(FLAG)].map((m) => m[0]),
        ...[prompt, ...starters].flatMap((text) => [...text.matchAll(FLAG)].map((m) => whole(m[0]))),
      ]);
      const subcommands = new Set([prompt, ...starters]
        .flatMap((text) => [...text.matchAll(new RegExp(`\\$runtime:${name} ([^\\s"';,()]+)`, 'g'))].map((m) => whole(m[1])))
        .filter((word) => word !== 'to' && !word.startsWith('--')));
      for (const token of [...flags, ...subcommands]) {
        ok(!(await probes[name](token)), `${name}: the argument-hint or a default prompt names ${token}, which the ${name} parser refuses`);
      }
      // Non-vacuity: the extraction finds flags, and the probe sees the parser
      // refuse what it does not take.
      ok(flags.size > 0, `${name}: the argument-hint names flags (found ${flags.size})`);
      ok(await probes[name]('--not-a-runtime-flag'), `${name}: the probe must see the parser refuse an unknown flag`);
    }
  });
});

describe('plugins/runtime the shared operator-text primitive', () => {
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

describe('plugins/runtime compat surface — removed (ADR-0060)', () => {
  it('ships no compat command, skill, script or baseline document', async () => {
    // The command-skill parity case above enumerates what IS shipped; this one
    // pins what is not, so a surface restored by a stray revert or a bad merge
    // fails by name instead of only as a longer directory listing.
    // Contract: Claude Code lists commands/*.md and Codex loads skill directories —
    // a restored file ships a command whose code is gone.
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

describe('plugins/runtime packaged schemas', () => {
  // The three schemas the session-capture contract names must actually be
  // packaged.
  // Contract: the runtime's schema loader validates these artifacts on read and
  // write — a missing file fails the load, and an open schema accepts unknown keys.
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
