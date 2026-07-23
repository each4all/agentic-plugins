// tests/runtime/test-statusline-plan.mjs — the statusline-adapter slice
// (ADR-0048 §1/§2/§2.1, macro 6/9): the one policy definition, the executable
// inline-sufficiency gate, both Claude render modes, the Codex fragment via
// the shared [tui] composer, the shim, the classification, the parser's
// status_line capture, the exact judges, the preset export rule, and the
// end-to-end plan/fragment wiring.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATUSLINE_POLICY_AGENTIC_6,
  STATUSLINE_PRESET_AGENTIC_6,
  classifyExistingClaudeStatusline,
  evaluateInlineSufficiency,
  expectedClaudeStatuslineCommand,
  expectedCodexStatusLineItems,
  renderAgenticStatuslineShim,
  renderClaudeStatuslineFragmentJson,
  renderCodexStatusLineFragmentToml,
  renderInlineClaudeCommand,
  shimTemplateRendererIds,
  statuslineShimInstallPath,
} from '../../plugins/runtime/scripts/lib/statusline-plan.mjs';
import { parseCodexNotifyConfigToml } from '../../plugins/runtime/scripts/lib/notification-plan.mjs';
import { renderCodexTuiTableToml } from '../../plugins/runtime/scripts/lib/toml.mjs';
import { judgeSteps, runBootstrap } from '../../plugins/runtime/scripts/bootstrap.mjs';
import { stepIds } from '../../plugins/runtime/scripts/lib/step-registry.mjs';

// The NORMATIVE six ids in their owner-adopted order (ADR-0048 §2.1) —
// deliberately a LITERAL, independent of the policy table, so a mutated
// policy cannot re-derive its own expectation (peer G11: expected and
// rendered both deriving from one mutated table made round-trips vacuous).
const NORMATIVE_AGENTIC_6 = [
  'model-with-reasoning',
  'git-branch',
  'pull-request-number',
  'context-used',
  'five-hour-limit',
  'weekly-limit',
];

describe('statusline policy — the one agentic-6 definition (ADR-0048 §2.1)', () => {
  it('pins the exact six ids and order against the independent normative literal', () => {
    deepStrictEqual(expectedCodexStatusLineItems(), NORMATIVE_AGENTIC_6);
    strictEqual(STATUSLINE_POLICY_AGENTIC_6.length, 6);
  });

  it('the packaged shim template renders every policy id — policy↔shim drift fails the suite, not the statusline', () => {
    const rendererIds = shimTemplateRendererIds();
    for (const id of NORMATIVE_AGENTIC_6) ok(rendererIds.includes(id), `shim renders ${id}`);
  });

  it('the Codex fragment and the probe expectation are the SAME value through the shared [tui] composer', () => {
    const fragment = renderCodexStatusLineFragmentToml();
    strictEqual(fragment, renderCodexTuiTableToml({ statusLine: NORMATIVE_AGENTIC_6 }));
    const parsed = parseCodexNotifyConfigToml(fragment);
    deepStrictEqual(parsed.tuiStatusLine.values, NORMATIVE_AGENTIC_6, 'render → parse → expect round-trips');
  });
});

describe('statusline inline-sufficiency gate — executable, fail-closed (ADR-0048 §2)', () => {
  it('agentic-6 FAILS the gate (the §2-expected outcome) with the failing conditions named', () => {
    const verdict = evaluateInlineSufficiency();
    strictEqual(verdict.sufficient, false);
    strictEqual(verdict.conditions.length, 5);
    ok(verdict.conditions.some((c) => c.id === 'reviewable-as-one-command' && !c.holds));
    ok(verdict.conditions.some((c) => c.id === 'identical-cross-shell' && !c.holds));
  });

  it('a qualifying single-item policy PASSES and renders inline; the gate refuses to inline agentic-6', () => {
    const small = [{ id: 'model-with-reasoning', claude_projection: 'model.display_name' }];
    strictEqual(evaluateInlineSufficiency(small).sufficient, true);
    const inline = renderInlineClaudeCommand(small);
    ok(inline.startsWith('node -e "'), 'double-quoted for cross-shell grouping');
    throws(() => renderInlineClaudeCommand(), /sufficiency gate/);
  });
});

describe('statusline Claude renders — command form, fragment, shim', () => {
  it('the command is forward-slash, SINGLE-quoted (literal in both shells), node-invoked', () => {
    const command = expectedClaudeStatuslineCommand({ homeDir: 'C:\\Users\\op' });
    strictEqual(command, "node 'C:/Users/op/.agentic-plugins/bin/agentic-statusline.mjs'");
    ok(!command.includes('\\'), 'Git Bash eats unquoted backslashes (host-truth §2)');
    // Double quotes interpolate in BOTH Git Bash and PowerShell (Review peer
    // BLOCKER): a $(…) in the home must stay a literal, and a home containing
    // a single quote has no cross-shell-literal form — refused fail-closed.
    const hostile = expectedClaudeStatuslineCommand({ homeDir: 'C:\\Users\\$(whoami)' });
    ok(hostile.includes("$(whoami)") && hostile.startsWith("node '"), 'substitution-shaped paths stay inert inside single quotes');
    throws(() => expectedClaudeStatuslineCommand({ homeDir: "/Users/o'brien" }), /single quote/);
  });

  it('the settings fragment carries exactly the canonical command', () => {
    const fragment = JSON.parse(renderClaudeStatuslineFragmentJson({ homeDir: '/Users/op' }));
    deepStrictEqual(fragment, { statusLine: { type: 'command', command: expectedClaudeStatuslineCommand({ homeDir: '/Users/op' }) } });
  });

  it('the shim renders with the policy items substituted exactly once, and template drift throws', () => {
    const { body, sha256 } = renderAgenticStatuslineShim();
    ok(body.includes(JSON.stringify(NORMATIVE_AGENTIC_6[0])));
    ok(!body.includes('__AGENTIC_STATUSLINE_ITEMS__'));
    match(sha256, /^[0-9a-f]{64}$/);
    throws(() => renderAgenticStatuslineShim({ template: 'no placeholder here' }), /template drift/);
  });

  it('the RENDERED shim projects a session JSON to one line, skips missing items order-preserved, sanitizes control bytes, and always exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'statusline-shim-'));
    const shimPath = join(dir, 'agentic-statusline.mjs');
    await writeFile(shimPath, renderAgenticStatuslineShim().body);
    const run = (stdin) => spawnSync(process.execPath, [shimPath], { input: stdin, encoding: 'utf8', timeout: 5000 });

    const full = run(JSON.stringify({
      model: { display_name: 'Opus 4.8' },
      effort: { level: 'high' },
      worktree: { branch: 'feat/x' },
      pr: { number: 631 },
      context_window: { used_percentage: 42.4 },
      rate_limits: { five_hour: { used_percentage: 13 }, seven_day: { used_percentage: 37.8 } },
    }));
    strictEqual(full.status, 0);
    strictEqual(full.stdout.trim(), 'Opus 4.8 high · feat/x · PR#631 · ctx 42% · 5h 13% · wk 38%');

    const partial = run(JSON.stringify({ model: { display_name: 'Opus 4.8' }, rate_limits: { seven_day: { used_percentage: 5 } } }));
    strictEqual(partial.stdout.trim(), 'Opus 4.8 · wk 5%', 'missing items skip, order preserved');

    const hostile = run(JSON.stringify({ model: { display_name: 'O\u001b[31mp\nus' }, effort: { level: 'high' } }));
    ok(!/[\u0000-\u001f]/.test(hostile.stdout.trim()), 'control/ANSI bytes never reach the terminal line');

    for (const bad of ['', '{not json', JSON.stringify({ context_window: { used_percentage: Infinity } })]) {
      const r = run(bad);
      strictEqual(r.status, 0, 'fail-closed silent: exit 0 always');
    }
  });
});

describe('statusline classification — observation, never operator choice (ADR-0048 §2)', () => {
  const expectedCommand = expectedClaudeStatuslineCommand({ homeDir: '/Users/op' });
  it('separates observation from offered resolutions across the matrix', () => {
    const cases = [
      [{ readable: true, present: false }, 'absent', []],
      [{ readable: true, present: true, type: 'command', command: expectedCommand }, 'canonical', []],
      [{ readable: true, present: true, type: 'command', command: './mine.sh' }, 'foreign-command', ['replace', 'manual-merge', 'decline']],
      [{ readable: true, present: true, type: 'static' }, 'foreign-shape', ['manual-merge', 'decline']],
      [{ readable: false }, 'unreadable', []],
    ];
    for (const [existing, observation, offered] of cases) {
      const result = classifyExistingClaudeStatusline({ existing, expectedCommand });
      strictEqual(result.observation, observation);
      deepStrictEqual(result.offered_resolutions, offered);
      ok(!JSON.stringify(result).includes('mine.sh'), 'the raw foreign command is never echoed back');
    }
  });
});

describe('statusline judges — exact canonical-configuration probes (ADR-0048 §1)', () => {
  function judge(readers) {
    return judgeSteps({
      expected: [
        { id: stepIds.statuslineConfigured('claude'), stage: 5, applicable: true, declinable: true, blocked_by: [] },
        { id: stepIds.statuslineConfigured('codex'), stage: 5, applicable: true, declinable: true, blocked_by: [] },
      ],
      probe: { hosts: { claude: { plugins: {} }, codex: { plugins: {} } } },
      raw: {}, pluginSet: { plugins: {} }, readers, hookVerdict: null, previousById: new Map(), now: new Date('2026-07-18T04:00:00Z'),
    });
  }
  const CANON_CMD = "node '/h/.agentic-plugins/bin/agentic-statusline.mjs'";

  it('canonical on both hosts satisfies — and the Claude observation carries the configured≠active caveat', () => {
    const [claude, codex] = judge({
      statuslineClaude: { readable: true, present: true, type: 'command', command: CANON_CMD, expectedCommand: CANON_CMD },
      statuslineCodex: { readable: true, present: true, items: [...NORMATIVE_AGENTIC_6], expectedItems: [...NORMATIVE_AGENTIC_6] },
    });
    strictEqual(claude.status, 'satisfied');
    match(claude.observed, /workspace trust/);
    strictEqual(codex.status, 'satisfied');
  });

  it('foreign wiring is manual-follow-up on both hosts; absent is pending; reordered items do not match', () => {
    const [claudeForeign, codexReordered] = judge({
      statuslineClaude: { readable: true, present: true, type: 'command', command: './mine.sh', expectedCommand: CANON_CMD },
      statuslineCodex: { readable: true, present: true, items: [...NORMATIVE_AGENTIC_6].reverse(), expectedItems: [...NORMATIVE_AGENTIC_6] },
    });
    strictEqual(claudeForeign.status, 'manual-follow-up');
    match(claudeForeign.recovery, /never auto-chains/);
    strictEqual(codexReordered.status, 'manual-follow-up');

    const [claudeAbsent, codexAbsent] = judge({
      statuslineClaude: { readable: true, present: false, expectedCommand: CANON_CMD },
      statuslineCodex: { readable: true, present: false, items: null, expectedItems: [...NORMATIVE_AGENTIC_6] },
    });
    strictEqual(claudeAbsent.status, 'pending');
    strictEqual(codexAbsent.status, 'pending');
    match(codexAbsent.observed, /default two items/, 'the Codex default is named, not conflated with canonical');
  });

  it('unreadable stays unknown; an EMPTY status_line is a deliberate selection (manual-follow-up); unparseable stays pending', () => {
    const [claude, codexEmpty] = judge({
      statuslineClaude: { readable: false, expectedCommand: CANON_CMD },
      statuslineCodex: { readable: true, present: true, items: [], expectedItems: [...NORMATIVE_AGENTIC_6] },
    });
    strictEqual(claude.status, 'unknown');
    strictEqual(codexEmpty.status, 'manual-follow-up', 'status_line = [] is the operator deliberately emptying it (§6.1.1)');
    const [, codexUnparseable] = judge({
      statuslineClaude: { readable: false, expectedCommand: CANON_CMD },
      statuslineCodex: { readable: true, present: true, items: null, expectedItems: [...NORMATIVE_AGENTIC_6] },
    });
    strictEqual(codexUnparseable.status, 'pending');
  });
});

describe('statusline end-to-end — plan renders fragments, desired seats, the non-gating shim artifact, and the preset export rule', () => {
  const NOW = Date.parse('2026-07-18T04:00:00Z');
  const okOut = (stdout) => ({ ok: true, exit_code: 0, error_code: null, stdout, stderr: '' });
  const missing = () => ({ ok: false, exit_code: null, error_code: 'ENOENT', stdout: '', stderr: '' });

  async function makeHome({ canonical = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'statusline-e2e-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    for (const d of ['.claude', '.codex', '.agentic-plugins']) await mkdir(join(home, d), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const claudeSettings = { permissions: { defaultMode: 'acceptEdits' } };
    if (canonical) claudeSettings.statusLine = { type: 'command', command: expectedClaudeStatuslineCommand({ homeDir: home }) };
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify(claudeSettings, null, 2)}\n`);
    await writeFile(join(home, '.codex', 'config.toml'), canonical
      ? `[tui]\nstatus_line = [${NORMATIVE_AGENTIC_6.map((id) => `"${id}"`).join(', ')}]\n`
      : '# empty\n');
    await writeFile(join(home, '.agentic-plugins', 'config.local.toml'), '# s\n');
    return { home, cwd };
  }

  const boot = ({ argv, home, cwd }) => runBootstrap({
    argv, env: {}, homeDir: home, cwd, hostname: 't', now: NOW,
    runner: async () => missing(),
    subprocessRunner: async (p) => (p.endsWith('settings.mjs') ? okOut(JSON.stringify({ plugin_management: { plan_hash: null } })) : missing()),
    pluginRoot: 'plugins/runtime',
  });

  it('plan persists both statusline fragments with frozen desired seats and the unconditional shim artifact', async () => {
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json'), 'utf8'));

    const codexStep = manifest.steps.find((s) => s.id === 'statusline.codex.configured');
    // bare host (no CLIs) → blocked on host.codex.present; the fragment and
    // desired seat still render — the plan hands the operator everything.
    strictEqual(codexStep.status, 'blocked');
    ok(codexStep.fragment_pointer, 'the [tui] fragment was persisted');
    deepStrictEqual(JSON.parse(codexStep.desired), NORMATIVE_AGENTIC_6, 'the desired seat freezes the plan expectation');

    const claudeStep = manifest.steps.find((s) => s.id === 'statusline.claude.configured');
    strictEqual(claudeStep.status, 'blocked');
    deepStrictEqual(JSON.parse(claudeStep.desired), [expectedClaudeStatuslineCommand({ homeDir: home })]);
    match(claudeStep.apply_command, /verify sha256/);

    // The Codex fragment is ONE [tui] table carrying BOTH planned keys (peer B3).
    const codexFragment = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'fragments', 'statusline-codex.fragment'), 'utf8'));
    const parsedTable = parseCodexNotifyConfigToml(codexFragment.fragment_toml);
    deepStrictEqual(parsedTable.tuiStatusLine.values, NORMATIVE_AGENTIC_6);
    ok(parsedTable.tuiNotifications.present, 'notifications rides the same single table');
    strictEqual((codexFragment.fragment_toml.match(/\[tui\]/g) ?? []).length, 1, 'exactly one [tui] header');

    // Non-gating shim artifact (peer G10): present regardless of step status.
    const shimBody = await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'fragments', 'statusline-shim.fragment'), 'utf8');
    ok(shimBody.includes('agentic-statusline.mjs — Claude Code statusLine shim'));
  });

  it('the combined fragment is the ONE [tui] source across ALL run artifacts — the notification-plan artifact carries no [tui] preview (integration pass)', async () => {
    // Both Codex steps pending → both keys ride the combined fragment. The
    // notification-plan artifact must carry the notify= wiring ONLY: its
    // builder-level [tui] preview is stripped at persist so the run never
    // hands the operator two [tui] blocks with competing guidance.
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'fragments');

    const notifyArtifact = JSON.parse(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'));
    strictEqual(notifyArtifact.fragments.tui_notifications_toml, null,
      'the notification-plan artifact must not carry its own [tui] preview beside the combined fragment');
    match(notifyArtifact.tui_note, /statusline-codex combined fragment/,
      'the strip is explained in-artifact so an operator reading only this file is routed to the one [tui] source');
    ok(notifyArtifact.fragments.notify_toml && !notifyArtifact.fragments.notify_toml.includes('[tui]'),
      'the notify= fragment stays and stays [tui]-free');

    // Sweep EVERY fragment artifact: exactly one carries a [tui] header, and
    // it is the combined statusline-codex fragment.
    const names = (await readdir(fragmentsDir)).filter((n) => n.endsWith('.fragment')).sort();
    const carriers = [];
    for (const name of names) {
      const text = await readFile(join(fragmentsDir, name), 'utf8');
      if (/\[tui\]/.test(text)) carriers.push(name);
    }
    deepStrictEqual(carriers, ['statusline-codex.fragment'],
      `the [tui] header may appear in exactly one artifact (got: ${carriers.join(', ') || 'none'} out of ${names.join(', ')})`);
  });

  it('when the statusline step cannot carry the combined fragment (declined), the notification preview stays the ONE [tui] source', async () => {
    // The combined fragment is persisted under the statusline step; a
    // declined step renders no fragment (persist() skips dead steps). An
    // unconditional strip would then leave ZERO [tui] sources and a routing
    // note pointing at a fragment that does not exist (Refine-verify peer,
    // round 2) — so the strip is conditional on the combined carrier.
    const { home, cwd } = await makeHome();
    const answersPath = join(home, 'decline-statusline.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'statusline.codex.configured', answer: 'decline' }]));
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answersPath, '--format', 'json'], home, cwd });
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'fragments');

    const notifyArtifact = JSON.parse(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'));
    ok(notifyArtifact.fragments.tui_notifications_toml && notifyArtifact.fragments.tui_notifications_toml.includes('[tui]'),
      'with no combined carrier, the builder preview must remain the tui source');
    ok(notifyArtifact.tui_note == null,
      'no routing note may point at a combined fragment that does not exist');

    const names = (await readdir(fragmentsDir)).filter((n) => n.endsWith('.fragment')).sort();
    const carriers = [];
    for (const name of names) {
      const text = await readFile(join(fragmentsDir, name), 'utf8');
      if (/\[tui\]/.test(text)) carriers.push(name);
    }
    deepStrictEqual(carriers, ['notification-plan.fragment'],
      `exactly one [tui] source, and it is the preview when the combined fragment cannot render (got: ${carriers.join(', ') || 'none'})`);
  });

  it('a satisfied→pending re-transition under VERSION DRIFT re-renders and converges to one carrier (§7 clears the freeze)', async () => {
    // In this bare-runner harness the host versions are unobservable, so §7
    // invalidation fires on every resume and clears pending/blocked steps'
    // frozen fragment fields — the notify artifact re-renders in its
    // stripped shape once the combined fragment exists, converging to ONE
    // carrier. The no-drift twin (frozen preview + warning) lives in
    // test-bootstrap-cli.mjs, where a hosted runner keeps versions stable.
    const { home, cwd } = await makeHome();
    const codexConfig = join(home, '.codex', 'config.toml');
    await writeFile(codexConfig, `[tui]\nstatus_line = [${NORMATIVE_AGENTIC_6.map((id) => `"${id}"`).join(', ')}]\n`);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    const runId = plan.report.run_id;
    strictEqual(plan.report.steps.find((s) => s.id === 'statusline.codex.configured').status, 'satisfied');
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments');
    const notifyBefore = JSON.parse(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'));
    ok(notifyBefore.fragments.tui_notifications_toml, 'the preview is the carrier while the statusline step is satisfied');

    // The observation disappears (operator reverted their config).
    await writeFile(codexConfig, '');
    await boot({ argv: ['resume', '--run-id', runId, '--format', 'json'], home, cwd });

    const carriers = [];
    for (const name of (await readdir(fragmentsDir)).filter((n) => n.endsWith('.fragment')).sort()) {
      if (/\[tui\]/.test(await readFile(join(fragmentsDir, name), 'utf8'))) carriers.push(name);
    }
    deepStrictEqual(carriers, ['statusline-codex.fragment'],
      'under drift the re-render converges: the combined fragment is the one carrier and the stripped notify artifact carries none');
  });

  it('a canonical home satisfies both steps on plan, and profile export carries the preset (owner rule: applied fragments ARE the declaration)', async () => {
    const { home, cwd } = await makeHome({ canonical: true });
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    const byId = new Map(plan.report.steps.map((s) => [s.id, s]));
    strictEqual(byId.get('statusline.claude.configured').status, 'satisfied');
    strictEqual(byId.get('statusline.codex.configured').status, 'satisfied');

    const exported = await boot({ argv: ['profile', 'export', '--name', 'sl-e2e'], home, cwd });
    const profile = JSON.parse(await readFile(join(home, '.agentic-plugins', 'profiles', 'sl-e2e.json'), 'utf8'));
    strictEqual(profile.statusline_preset, STATUSLINE_PRESET_AGENTIC_6);
    strictEqual(exported.exitCode, 0);
  });

  it('a partial home (one host canonical) exports NULL — the preset is both-hosts-or-nothing', async () => {
    const { home, cwd } = await makeHome();
    await writeFile(join(home, '.codex', 'config.toml'), `[tui]\nstatus_line = [${NORMATIVE_AGENTIC_6.map((id) => `"${id}"`).join(', ')}]\n`);
    await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    await boot({ argv: ['profile', 'export', '--name', 'sl-partial'], home, cwd });
    const profile = JSON.parse(await readFile(join(home, '.agentic-plugins', 'profiles', 'sl-partial.json'), 'utf8'));
    strictEqual(profile.statusline_preset, null);
  });
});
