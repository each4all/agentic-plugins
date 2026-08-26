// tests/runtime/test-bootstrap-value-grammar.mjs
//
// machine-bootstrap-contract.md §3.3 + §6.1.3 — the VALUE-carrying interview.
//
// Three layers, deliberately separate, because they fail differently:
//
//   1. the pure grammar (lib/answer-values.mjs) — parse, fold, compare;
//   2. `judgeSteps` — the §6.1.3 status matrix, with readers INJECTED so no
//      test here touches the developer's real home;
//   3. the CLI, end to end through `runBootstrap` — because a grammar that
//      parses correctly and is never WIRED still passes every unit test of
//      itself. The state transitions (decline → set, changed set → un-freeze)
//      exist only across verbs and cannot be observed at layer 1 at all.

import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT, judgeSteps, runBootstrap } from '../../plugins/runtime/scripts/bootstrap.mjs';
import { stepIds } from '../../plugins/runtime/scripts/lib/step-registry.mjs';
import {
  SET_PAYLOAD_MAX,
  UNSET,
  applyCommandFor,
  classifyAnswer,
  compareStanding,
  dualKindWarning,
  foldStandingDecisions,
  isValueStep,
  parseSetPayload,
  undecidedKeys,
  valueStepKeys,
} from '../../plugins/runtime/scripts/lib/answer-values.mjs';
import { NOTIFY_KINDS } from '../../plugins/runtime/scripts/lib/notify-schema.mjs';
import { CONFIG_KEY_FAMILIES } from '../../plugins/runtime/scripts/lib/runtime-config.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'runtime');
const NOW = Date.parse('2026-08-26T04:00:00Z');
const SESSION = stepIds.configSession();
const KINDS = stepIds.configNotifyKinds();

// ---------------------------------------------------------------------------
// 1. The pure grammar
// ---------------------------------------------------------------------------

describe('value grammar — payload parsing (§3.3)', () => {
  it('the step key sets are READ from CONFIG_KEY_FAMILIES, so a new family key joins the interview automatically', () => {
    // The property, not a snapshot: re-listing the keys here would be the
    // second copy the module exists to avoid, and would keep passing after the
    // family changed underneath it.
    deepStrictEqual([...valueStepKeys(SESSION)], [...CONFIG_KEY_FAMILIES.session]);
    deepStrictEqual([...valueStepKeys(KINDS)], ['notify_kinds']);
    strictEqual(isValueStep('config.model_effort'), false, 'the posture step owns no value keys');
  });

  it('parses a full session payload, order-independently', () => {
    const a = parseSetPayload(SESSION, 'session_capture=stop-hook;entry_brief=startup;entry_brief_empty=report');
    const b = parseSetPayload(SESSION, 'entry_brief_empty=report;session_capture=stop-hook;entry_brief=startup');
    ok(a.ok && b.ok);
    deepStrictEqual([...a.decisions].sort(), [...b.decisions].sort(), 'member order does not change the decision');
  });

  it('accepts a PARTIAL payload — an interview may be answered over several resumes', () => {
    const parsed = parseSetPayload(SESSION, 'session_capture=stop-hook');
    ok(parsed.ok);
    deepStrictEqual([...parsed.decisions], [['session_capture', 'stop-hook']]);
    deepStrictEqual(undecidedKeys(SESSION, { mode: 'set', decisions: parsed.decisions }).sort(), ['entry_brief', 'entry_brief_empty']);
  });

  it('`unset` is a legal per-key value on every key', () => {
    for (const key of valueStepKeys(SESSION)) {
      const parsed = parseSetPayload(SESSION, `${key}=${UNSET}`);
      ok(parsed.ok, `${key}=${UNSET} parses`);
      strictEqual(parsed.decisions.get(key), UNSET);
    }
    ok(parseSetPayload(KINDS, `notify_kinds=${UNSET}`).ok);
  });

  it('is ATOMIC — a duplicate key rejects the WHOLE row, so order cannot decide the answer', () => {
    const parsed = parseSetPayload(SESSION, 'entry_brief=off;entry_brief=startup');
    strictEqual(parsed.ok, false);
    strictEqual(parsed.decisions.size, 0, 'no partial decision survives a rejected row');
    match(parsed.errors.join(' '), /appears twice/);
  });

  it('rejects the other four defect shapes, each with its own diagnosis', () => {
    const cases = [
      ['', /empty payload/],
      ['session_capture', /must be <key>=<value>/],
      ['=stop-hook', /must be <key>=<value>/],
      ['session_capture=stop-hook;', /empty member/],
      ['nope=stop-hook', /unknown key/],
      ['session_capture=not-a-mode', /must be one of/],
    ];
    for (const [payload, re] of cases) {
      const parsed = parseSetPayload(SESSION, payload);
      strictEqual(parsed.ok, false, `${JSON.stringify(payload)} is refused`);
      match(parsed.errors.join(' '), re, `${JSON.stringify(payload)} names its own defect`);
    }
  });

  it('refuses an over-long payload BEFORE parsing it, and withholds the value', () => {
    const parsed = parseSetPayload(SESSION, `session_capture=${'x'.repeat(SET_PAYLOAD_MAX)}`);
    strictEqual(parsed.ok, false);
    match(parsed.errors[0], /exceeds 1024 characters/);
    ok(!parsed.errors[0].includes('xxxx'), 'the unclamped value is withheld, not echoed (D1 §3.2)');
  });

  it('a failed VALUE is never quoted back, while a MATCHED key still is', () => {
    const parsed = parseSetPayload(SESSION, 'entry_brief=SECRET-TYPO');
    strictEqual(parsed.ok, false);
    ok(!parsed.errors.join(' ').includes('SECRET-TYPO'), 'the rejected value is withheld');
    match(parsed.errors.join(' '), /entry_brief/, 'the key that matched a declared name is still named');
  });
});

describe('value grammar — the notify_kinds refusals (§3.3)', () => {
  it('refuses the enumeration of EVERY current kind, naming unset as the thing meant', () => {
    const parsed = parseSetPayload(KINDS, `notify_kinds=${NOTIFY_KINDS.join(',')}`);
    strictEqual(parsed.ok, false);
    match(parsed.errors[0], /indistinguishable from unset/);
    match(parsed.errors[0], /notify_kinds=unset/);
  });

  it('the all-kinds refusal compares by SET semantics — order and duplicates cannot walk past it', () => {
    const shuffled = [...NOTIFY_KINDS].reverse().join(',');
    const duplicated = `${NOTIFY_KINDS.join(',')},${NOTIFY_KINDS[0]},${NOTIFY_KINDS[0]}`;
    for (const payload of [shuffled, duplicated]) {
      strictEqual(parseSetPayload(KINDS, `notify_kinds=${payload}`).ok, false, `${payload.slice(0, 30)}… is still all-kinds`);
    }
  });

  it('refuses a BLANK csv — it behaves as unset while writing a byte that looks like a filter', () => {
    const parsed = parseSetPayload(KINDS, 'notify_kinds=');
    strictEqual(parsed.ok, false);
    match(parsed.errors[0], /same posture as unset/);
  });

  it('a PROPER SUBSET is accepted and normalized to a sorted set, so a reorder is not a new decision', () => {
    const a = parseSetPayload(KINDS, 'notify_kinds=idle,approval');
    const b = parseSetPayload(KINDS, 'notify_kinds=approval,idle,approval');
    ok(a.ok && b.ok);
    strictEqual(a.decisions.get('notify_kinds'), 'approval,idle');
    strictEqual(b.decisions.get('notify_kinds'), a.decisions.get('notify_kinds'), 'reorder + duplicate fold to one value');
  });

  it('an unknown kind is refused WITHOUT quoting the token parseKindsFilter would have quoted', () => {
    const parsed = parseSetPayload(KINDS, 'notify_kinds=approval,not-a-kind');
    strictEqual(parsed.ok, false);
    ok(!parsed.errors.join(' ').includes('not-a-kind'), 'the answers boundary withholds where the parser would quote');
    match(parsed.errors[0], new RegExp(NOTIFY_KINDS[0]), 'the closed set is named instead');
  });

  it('the ADR-0047 dual-kind warning is XOR — one of the pair warns, both or neither does not', () => {
    ok(dualKindWarning('approval,turn-complete'), 'turn-complete alone warns');
    ok(dualKindWarning('approval,response-needed'), 'response-needed alone warns');
    strictEqual(dualKindWarning('turn-complete,response-needed'), null, 'both = the window is open');
    strictEqual(dualKindWarning('approval,idle'), null, 'neither = not in the window at all');
    match(dualKindWarning('approval,response-needed'), /verified upgraded/, 'it names the verification a narrowing presupposes');
  });
});

describe('value grammar — the standing fold (§3.3)', () => {
  const row = (step_id, answer, at = '2026-08-26T00:00:00Z') => ({ step_id, answer, at });

  it('later rows win, and a partial payload MERGES per key rather than replacing', () => {
    const { standing } = foldStandingDecisions([
      row(SESSION, 'set:session_capture=stop-hook;entry_brief=off'),
      row(SESSION, 'set:entry_brief=startup'),
    ]);
    const entry = standing.get(SESSION);
    strictEqual(entry.mode, 'set');
    strictEqual(entry.decisions.get('entry_brief'), 'startup', 'the named key is updated');
    strictEqual(entry.decisions.get('session_capture'), 'stop-hook', 'the unnamed key is NOT un-decided');
  });

  it('a decline TOMBSTONES the accumulated decisions — a later set starts from empty', () => {
    const { standing } = foldStandingDecisions([
      row(SESSION, 'set:session_capture=stop-hook;entry_brief=off'),
      row(SESSION, 'decline'),
      row(SESSION, 'set:entry_brief=startup'),
    ]);
    const entry = standing.get(SESSION);
    strictEqual(entry.mode, 'set');
    deepStrictEqual([...entry.decisions], [['entry_brief', 'startup']], 'the pre-decline keys do not resurrect');
  });

  it('a set followed by a decline leaves the step DECLINED with no standing decisions', () => {
    const { standing } = foldStandingDecisions([
      row(SESSION, 'set:entry_brief=startup'),
      row(SESSION, 'decline'),
    ]);
    strictEqual(standing.get(SESSION).mode, 'decline');
    strictEqual(standing.get(SESSION).decisions.size, 0);
  });

  it('LEGACY PROVENANCE — a set: row on a NON-value step is a NON-EVENT, not a reported defect', () => {
    // The failure this closes: the pre-1.3 schema never constrained `answer`,
    // so arbitrary `set:...` text can already sit in a valid older manifest.
    //
    // Both halves are asserted because `parseSetPayload` ALSO refuses a
    // non-value step, so "standing stays empty" alone holds with the fold's own
    // guard deleted (measured — the mutation did not bite until this line was
    // added). What only the fold's guard gives is SILENCE: without it every
    // legacy row would be reported malformed on every verb, turning bytes that
    // were never an answer into permanent diagnostic noise.
    const { standing, malformed } = foldStandingDecisions([
      row('egress.configured', 'set:notify_kinds=approval'),
      row('config.model_effort', 'set:entry_brief=startup'),
    ]);
    strictEqual(standing.size, 0, 'no non-value step acquires a standing decision');
    deepStrictEqual(malformed, [], 'and it is not reported as a defect either — it was never an answer');
  });

  it('a MALFORMED payload on a real value step is reported and ignored — never obeyed, never thrown', () => {
    // Stored rows are not revalidated on write, so a fold that threw would
    // strand the run rather than degrade it.
    const { standing, malformed } = foldStandingDecisions([
      row(SESSION, 'set:entry_brief=nonsense'),
      row(SESSION, 'set:entry_brief=startup'),
    ]);
    strictEqual(malformed.length, 1);
    match(malformed[0], /choices\[0\]/, 'located by ordinal');
    ok(!malformed[0].includes('nonsense'), 'and the unparsed payload is withheld');
    strictEqual(standing.get(SESSION).decisions.get('entry_brief'), 'startup', 'the well-formed row still applies');
  });

  it('a schema-legal `answer: null` is skipped rather than crashing the fold', () => {
    const { standing } = foldStandingDecisions([{ step_id: SESSION, answer: null, at: '2026-08-26T00:00:00Z' }]);
    strictEqual(standing.size, 0);
  });

  it('classifyAnswer separates the prefix family from the bare four', () => {
    strictEqual(classifyAnswer('decline').kind, 'bare');
    strictEqual(classifyAnswer('set:a=b').kind, 'set');
    strictEqual(classifyAnswer('set:a=b').payload, 'a=b');
    strictEqual(classifyAnswer(null).kind, 'invalid');
  });
});

describe('value grammar — comparison and the apply command (§6.1.3)', () => {
  const entryOf = (pairs) => ({ mode: 'set', decisions: new Map(pairs) });

  it('UNSET is satisfied by physical ABSENCE only — a present BLANK is not unset', () => {
    const entry = entryOf([['notify_kinds', UNSET]]);
    strictEqual(compareStanding(KINDS, entry, () => null).mismatched.length, 0, 'absent matches unset');
    const blank = compareStanding(KINDS, entry, () => '');
    strictEqual(blank.mismatched.length, 1, 'a present blank does NOT match unset');
    strictEqual(blank.mismatched[0].got, '', 'and the blank is reported as what it is');
  });

  it('an all-unset decision needs NO apply command at all', () => {
    const entry = entryOf(valueStepKeys(SESSION).map((k) => [k, UNSET]));
    strictEqual(applyCommandFor(SESSION, entry, () => null), null, 'nothing to write means no command');
  });

  it('a partially-unset decision OMITS the unset keys rather than writing their default', () => {
    const entry = entryOf([['session_capture', 'stop-hook'], ['entry_brief', UNSET], ['entry_brief_empty', UNSET]]);
    const command = applyCommandFor(SESSION, entry, () => null);
    match(command, /--session-capture stop-hook/);
    ok(!command.includes('--entry-brief'), 'passing an unset key would write the byte the choice declined');
  });

  it('an unset key that is currently PRESENT becomes the removal operation', () => {
    const entry = entryOf([['notify_kinds', UNSET]]);
    const command = applyCommandFor(KINDS, entry, () => 'approval');
    match(command, /--unset notify_kinds/, 'the only way back to a future-open posture');
    match(command, /--target user/);
  });

  it('a key already matching contributes nothing to the command', () => {
    const entry = entryOf([['session_capture', 'stop-hook'], ['entry_brief', 'off'], ['entry_brief_empty', 'silent']]);
    const observed = { session_capture: 'stop-hook', entry_brief: 'off', entry_brief_empty: 'silent' };
    strictEqual(applyCommandFor(SESSION, entry, (k) => observed[k] ?? null), null);
  });
});

// ---------------------------------------------------------------------------
// 2. judgeSteps — the §6.1.3 status matrix, readers injected
// ---------------------------------------------------------------------------

function judgeValue({ stepId = SESSION, keys = {}, sourceStatus = 'readable', standing = new Map(), previousById = new Map(), envShadow = {} } = {}) {
  const family = {
    family: stepId === KINDS ? 'notify' : 'session',
    keys: Object.fromEntries((valueStepKeys(stepId) ?? []).map((key) => [key, { value: keys[key] ?? null, provenance: keys[key] == null ? null : 'user-global' }])),
    source: { scope: 'user', status: sourceStatus },
  };
  const steps = judgeSteps({
    expected: [{ id: stepId, stage: 4, applicable: true, declinable: true, blocked_by: [] }],
    probe: { hosts: { claude: { plugins: {} }, codex: { plugins: {} } } },
    raw: {},
    pluginSet: { plugins: {} },
    readers: stepId === KINDS ? { notify: family, sessionEnvShadow: envShadow } : { session: family, sessionEnvShadow: envShadow },
    hookVerdict: null,
    previousById,
    standing,
    now: NOW,
  });
  strictEqual(steps.length, 1);
  return steps[0];
}

const standingOf = (stepId, pairs, mode = 'set') => new Map([[stepId, { mode, decisions: new Map(pairs), at: null }]]);

describe('judgeSteps — the value-step status matrix (§6.1.3)', () => {
  it('no recorded decision is PENDING, and presents the answer grammar', () => {
    const entry = judgeValue({});
    strictEqual(entry.status, 'pending');
    match(entry.apply_command, /set:session_capture=<value\|unset>;/, 'the grammar is presented, not described');
    match(entry.recovery, /No decision is recorded/);
  });

  it('a PARTIAL decision stays pending and NAMES the undecided keys', () => {
    const entry = judgeValue({ standing: standingOf(SESSION, [['session_capture', 'stop-hook']]) });
    strictEqual(entry.status, 'pending');
    match(entry.recovery, /Still undecided: entry_brief, entry_brief_empty/);
  });

  it('a complete decision every key matches is SATISFIED', () => {
    const entry = judgeValue({
      standing: standingOf(SESSION, [['session_capture', 'stop-hook'], ['entry_brief', 'startup'], ['entry_brief_empty', 'report']]),
      keys: { session_capture: 'stop-hook', entry_brief: 'startup', entry_brief_empty: 'report' },
    });
    strictEqual(entry.status, 'satisfied');
    match(entry.observed, /session_capture=stop-hook/);
  });

  it('an ALL-UNSET decision over an empty config is satisfied — resolved by OBSERVED ABSENCE, not by assertion', () => {
    const entry = judgeValue({ standing: standingOf(SESSION, valueStepKeys(SESSION).map((k) => [k, UNSET])) });
    strictEqual(entry.status, 'satisfied');
    match(entry.observed, /<unset, observed absent>/);
  });

  it('a mismatch with NOTHING rendered yet is pending; the same mismatch with a fragment is manual-follow-up', () => {
    const standing = standingOf(KINDS, [['notify_kinds', 'approval,idle']]);
    const first = judgeValue({ stepId: KINDS, standing, keys: { notify_kinds: 'health' } });
    strictEqual(first.status, 'pending', 'no hand-off exists yet');
    match(first.apply_command, /--notify-kinds approval,idle/);

    const later = judgeValue({
      stepId: KINDS,
      standing,
      keys: { notify_kinds: 'health' },
      previousById: new Map([[KINDS, { id: KINDS, status: 'pending', fragment_pointer: 'runs/bootstrap/x/fragments/config-notify-kinds.fragment' }]]),
    });
    strictEqual(later.status, 'manual-follow-up', 'a rendered fragment IS the hand-off §6 names');
  });

  it('an UNSET decision over a present value routes to the REMOVAL command, not a hand-edit', () => {
    const entry = judgeValue({ stepId: KINDS, standing: standingOf(KINDS, [['notify_kinds', UNSET]]), keys: { notify_kinds: 'approval' } });
    match(entry.apply_command, /--unset notify_kinds/);
    match(entry.observed, /chose unset, observed approval/);
  });

  it('an UNREADABLE config is UNKNOWN — never "nothing set" (§6)', () => {
    const entry = judgeValue({ sourceStatus: 'unreadable', standing: standingOf(SESSION, valueStepKeys(SESSION).map((k) => [k, UNSET])) });
    strictEqual(entry.status, 'unknown', 'unknown is never satisfied');
    match(entry.recovery, /could not be read/);
  });

  it('ENV shadowing is SURFACED without changing the verdict — the step certifies the persisted posture', () => {
    const standing = standingOf(SESSION, [['session_capture', UNSET], ['entry_brief', UNSET], ['entry_brief_empty', UNSET]]);
    const clean = judgeValue({ standing });
    const shadowed = judgeValue({ standing, envShadow: { entry_brief: true } });
    strictEqual(clean.status, 'satisfied');
    strictEqual(shadowed.status, 'satisfied', 'an env override does not unsatisfy a persisted posture');
    ok(!clean.recovery, 'no shadow, no note');
    match(shadowed.recovery, /environment override is in force for entry_brief/);
  });

  it('a recorded DECLINE is restored over a non-satisfying observation, as for any declinable step (§6.2)', () => {
    const entry = judgeValue({
      standing: standingOf(SESSION, [], 'decline'),
      previousById: new Map([[SESSION, { id: SESSION, status: 'declined' }]]),
    });
    strictEqual(entry.status, 'declined');
  });
});

// ---------------------------------------------------------------------------
// 3. The CLI, end to end — the transitions that exist only across verbs
// ---------------------------------------------------------------------------

const okOut = (stdout) => ({ ok: true, code: 0, stdout, stderr: '' });
const missing = () => ({ ok: false, code: 127, stdout: '', stderr: 'not found' });

const MARKETPLACE_JSON = JSON.stringify({ marketplaces: [{ name: 'agentic-plugins', source: { source: 'github', repo: 'each4all/agentic-plugins' } }] });

function bareRunner() {
  return async () => missing();
}

// A HOSTED machine — both CLIs present at fixed versions, both plugins installed.
//
// Required, not decorative, for the fragment-freeze tests. On a bare machine the
// probe records NULL host versions, `boundVersionsFresh` counts a null as never
// current, and §7 invalidation therefore fires on EVERY resume and clears
// `fragment_pointer` itself — so the freeze never engages and a test written
// against a bare fixture passes no matter what the freeze code does. Measured:
// removing the un-freeze left the bare-machine test green and the hosted one red.
function hostedRunner() {
  const plugins = ['runtime', 'companions'];
  return async (name, args) => {
    const key = `${name} ${args.join(' ')}`;
    if (key === 'claude --version') return okOut('2.1.0 (Claude Code)');
    if (key === 'claude auth status') return okOut(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    if (key === 'claude plugin list') return okOut(plugins.map((n) => `${n}@agentic-plugins  v9.9.9  enabled`).join('\n'));
    if (key === 'claude plugin marketplace list --json') return okOut(MARKETPLACE_JSON);
    if (name === 'claude') return okOut('usage');
    if (key === 'codex --version') return okOut('codex-cli 0.140.0');
    if (key === 'codex login status') return okOut('Logged in using ChatGPT');
    if (key === 'codex plugin list --json') return okOut(JSON.stringify({ plugins: plugins.map((n) => ({ name: n, marketplace: 'agentic-plugins', version: '9.9.9', enabled: true })) }));
    if (key === 'codex plugin marketplace list --json') return okOut(MARKETPLACE_JSON);
    if (name === 'codex') return okOut('usage');
    return missing();
  };
}

function subprocessRunner() {
  return async (scriptPath) => (scriptPath.endsWith('settings.mjs')
    ? okOut(JSON.stringify({ plugin_management: { plan_hash: null } }))
    : okOut(JSON.stringify({})));
}

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), 'value-grammar-'));
  const home = join(root, 'home');
  const cwd = join(root, 'repo');
  await mkdir(join(home, '.agentic-plugins'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), '{}\n');
  await writeFile(join(home, '.codex', 'config.toml'), '# empty\n');
  return { root, home, cwd };
}

function boot({ argv, home, cwd, runner = bareRunner(), env = {} }) {
  return runBootstrap({
    argv,
    homeDir: home,
    cwd,
    env,
    now: NOW,
    runner,
    subprocessRunner: subprocessRunner(),
    pluginRoot: PLUGIN_ROOT,
    hostname: 'value-grammar-test',
  });
}

async function answers(home, name, rows) {
  const path = join(home, name);
  await writeFile(path, JSON.stringify(rows));
  return path;
}

const manifestOf = async (home, runId) =>
  JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8'));

const stepOf = (report, id) => report.steps.find((s) => s.id === id);

describe('bootstrap CLI — the value interview end to end (§3.3)', () => {
  it('a run carrying no decision leaves BOTH value steps unresolved — the interview is a real obligation', async () => {
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    for (const id of [SESSION, KINDS]) {
      strictEqual(stepOf(plan.report, id).status, 'pending', `${id} is owed`);
      strictEqual(stepOf(plan.report, id).stage, 4, `${id} is Stage 4`);
      strictEqual(stepOf(plan.report, id).applied_by, 'agentic-config', `${id} is applied by agentic-config, not the operator`);
    }
    ok(plan.report.completion.unsatisfied.includes(SESSION), 'and the reducer counts it unsatisfied');
  });

  it('a plan-time set: is judged in the SAME invocation — the re-judge after applyAnswers is wired', async () => {
    // The failure this closes: judgement runs BEFORE applyAnswers, so a single
    // pass judges a value step against the PREVIOUS standing decision (on plan,
    // against none) and persists a status the observation never matched.
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'unset-all.json', [
      { step_id: SESSION, answer: `set:session_capture=${UNSET};entry_brief=${UNSET};entry_brief_empty=${UNSET}` },
      { step_id: KINDS, answer: `set:notify_kinds=${UNSET}` },
    ]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    strictEqual(stepOf(plan.report, SESSION).status, 'satisfied', 'an all-unset decision over an empty config satisfies at once');
    strictEqual(stepOf(plan.report, KINDS).status, 'satisfied');
  });

  it('a satisfied UNSET decision is VISIBLE in text — the state where it worked is the state where it would vanish', async () => {
    // renderText skips satisfied CONFIG rows, so without the value_decisions
    // projection an `unset` posture leaves no trace anywhere: the config carries
    // nothing by design and the step row is suppressed.
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'unset.json', [{ step_id: KINDS, answer: `set:notify_kinds=${UNSET}` }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file], home, cwd });
    strictEqual(plan.report.steps.find((s) => s.id === KINDS).status, 'satisfied');
    ok(!plan.rendered.includes(`${KINDS}: satisfied`), 'the step loop does suppress it (the premise of this test)');
    match(plan.rendered, new RegExp(`${KINDS.replace('.', '\\.')}: set — notify_kinds=unset`), 'the decision block carries it instead');
  });

  it('the report reconstructs the value CANONICALLY rather than echoing the raw answer string', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'reorder.json', [{ step_id: KINDS, answer: 'set:notify_kinds=idle,approval,idle' }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    const row = plan.report.value_decisions.find((r) => r.step_id === KINDS);
    strictEqual(row.decisions.notify_kinds, 'approval,idle', 'normalized, not the operator string');
  });

  it('a set: over a standing DECLINE lifts it — otherwise the reducer closes the run with the new choice unapplied', async () => {
    // decline is RESTORED by judgeSteps on every re-judge and counts as
    // RESOLVED in the reducer, so without the lift the run would reduce clean
    // while the operator's value was never applied.
    const { home, cwd } = await makeHome();
    const declineFile = await answers(home, 'decline.json', [{ step_id: KINDS, answer: 'decline' }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', declineFile, '--format', 'json'], home, cwd });
    strictEqual(stepOf(plan.report, KINDS).status, 'declined', 'precondition: the decline stands');

    const setFile = await answers(home, 'set.json', [{ step_id: KINDS, answer: 'set:notify_kinds=approval,idle' }]);
    const resume = await boot({ argv: ['resume', '--latest-open', '--answers', setFile, '--format', 'json'], home, cwd });
    const after = stepOf(resume.report, KINDS);
    ok(after.status !== 'declined', `the decline is lifted (got ${after.status})`);
    match(after.apply_command, /--notify-kinds approval,idle/, 'and the new choice is what is now presented');
  });

  it('a CHANGED decision withdraws the rendered hand-off so the next render re-freezes against it', async () => {
    // composeFragments.persist returns early while a pointer is present, so
    // set:X -> set:Y would otherwise keep X's fragment and X's apply command.
    //
    // HOSTED fixture, deliberately: on a bare machine §7 version invalidation
    // clears the pointer on every resume and the freeze never engages, so the
    // assertion below would hold with the un-freeze deleted. Measured — see
    // hostedRunner's comment.
    const { home, cwd } = await makeHome();
    const runner = hostedRunner();
    const first = await answers(home, 'first.json', [{ step_id: KINDS, answer: 'set:notify_kinds=approval,idle' }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', first, '--format', 'json'], home, cwd, runner });
    const runId = plan.report.run_id;
    const rendered = stepOf(plan.report, KINDS).fragment_pointer;
    ok(rendered, 'precondition: a fragment was rendered for the first decision');
    const firstBody = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments', 'config-notify-kinds.fragment'), 'utf8'));
    deepStrictEqual(firstBody.recorded_decision, { notify_kinds: 'approval,idle' });

    const resume1 = await boot({ argv: ['resume', '--latest-open', '--format', 'json'], home, cwd, runner });
    ok(stepOf(resume1.report, KINDS).fragment_pointer, 'CONTROL: with no new answer the pointer SURVIVES the resume — the freeze is live in this fixture, which is what makes the next assertion mean anything');

    const second = await answers(home, 'second.json', [{ step_id: KINDS, answer: 'set:notify_kinds=health' }]);
    await boot({ argv: ['resume', '--latest-open', '--answers', second, '--format', 'json'], home, cwd, runner });
    const secondBody = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments', 'config-notify-kinds.fragment'), 'utf8'));
    deepStrictEqual(secondBody.recorded_decision, { notify_kinds: 'health' }, 'the frozen artifact re-rendered against the NEW decision');
  });

  it('an UNCHANGED re-answer does NOT churn the fragment — the freeze is spent only on a real change', async () => {
    // Hosted for the same reason as the test above: on a bare machine §7 clears
    // the render state every resume, so "the freeze held" is unobservable.
    const { home, cwd } = await makeHome();
    const runner = hostedRunner();
    const file = await answers(home, 'same.json', [{ step_id: KINDS, answer: 'set:notify_kinds=approval,idle' }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd, runner });
    const runId = plan.report.run_id;
    const pointerBefore = stepOf(plan.report, KINDS).fragment_pointer;
    const manifestBefore = await manifestOf(home, runId);

    const resume = await boot({ argv: ['resume', '--latest-open', '--answers', file, '--format', 'json'], home, cwd, runner });
    strictEqual(stepOf(resume.report, KINDS).fragment_pointer, pointerBefore, 'the same decision keeps the same frozen pointer');
    // The ledger still records the row — the audit log keeps every answer.
    const manifestAfter = await manifestOf(home, runId);
    strictEqual(manifestAfter.choices.length, manifestBefore.choices.length + 1, 'the re-answer IS recorded, it just changes nothing');
  });

  it('declining a SATISFIED value step records the decline — it does not fall back to "no decision recorded"', async () => {
    // applyAnswers deliberately skips a step that is already satisfied, so a
    // decline over one leaves no STATUS trace; the ledger is the only place it
    // exists. A judge that read only the status reported `pending` with "No
    // decision is recorded" over a decision that plainly was.
    const { home, cwd } = await makeHome();
    const runner = hostedRunner();
    const set = await answers(home, 'unset-first.json', [{ step_id: KINDS, answer: `set:notify_kinds=${UNSET}` }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', set, '--format', 'json'], home, cwd, runner });
    strictEqual(stepOf(plan.report, KINDS).status, 'satisfied', 'precondition: the step is satisfied');

    const decline = await answers(home, 'then-decline.json', [{ step_id: KINDS, answer: 'decline' }]);
    const resume = await boot({ argv: ['resume', '--latest-open', '--answers', decline, '--format', 'json'], home, cwd, runner });
    strictEqual(stepOf(resume.report, KINDS).status, 'declined', 'the ledger decline is authoritative');
    match(stepOf(resume.report, KINDS).observed, /left unmanaged/);
    deepStrictEqual(resume.report.value_decisions.find((r) => r.step_id === KINDS).decisions, null, 'and it carries no standing value');
  });

  it('a seeded profile value the grammar would REFUSE is flagged, not offered as a default', async () => {
    // The profile schema types notify_kinds as a bare scalar, so a valid profile
    // can carry an all-kinds enumeration. Presenting it as a confirmable default
    // would walk the operator into a refusal at the answers boundary.
    //
    // The profile is EXPORTED rather than hand-authored: a hand-written fixture
    // is a second copy of the §4 schema that drifts, and the first attempt at
    // one was rejected for six missing required keys before it tested anything.
    // HOSTED: on a bare machine the export records an EMPTY custom selection and
    // `plan --profile-file` then refuses for a reason unrelated to this subject.
    const { home, cwd } = await makeHome();
    const runner = hostedRunner();
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'notify_kinds = "approval"\n');
    await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner });
    const exported = await boot({ argv: ['profile', 'export', '--name', 'm1', '--format', 'json'], home, cwd, runner });
    strictEqual(exported.exitCode, 0, 'precondition: a real profile was written');
    await boot({ argv: ['abandon', '--latest-open', '--reason', 'test'], home, cwd, runner });

    // Patch exactly the one field under test, leaving every other byte the
    // exporter produced.
    const profilePath = join(home, '.agentic-plugins', 'profiles', 'm1.json');
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    profile.notify.notify_kinds.value = NOTIFY_KINDS.join(',');
    await writeFile(profilePath, JSON.stringify(profile, null, 2));

    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--profile-file', profilePath, '--format', 'json'], home, cwd, runner });
    // `--bundle` is explicit because a profile exported from this fixture records
    // an empty custom selection; the bundle flag outranks the seeded one
    // (`resolveSelection`), which is the ordinary operator invocation anyway.
    // The bridge itself: `plan --profile-file` now carries proposals at all.
    // Before this change it recorded only the selection and the seeded_from
    // linkage, so a profile seeded its plugin list and none of its config.
    ok(plan.report.proposals, '`plan --profile-file` is sugar for plan-then-seed, proposals included');
    const seeded = plan.report.proposals.proposals.find((p) => p.key === 'notify.notify_kinds');
    ok(seeded, 'the notify family reaches the proposal list');
    ok(seeded.refused_by_interview, 'the unanswerable value is marked');
    ok(plan.report.warnings.some((w) => /not answerable through the interview/.test(w)), 'and the operator is told');
  });

  it('a seeded profile value the grammar ACCEPTS is proposed cleanly — the control for the test above', async () => {
    const { home, cwd } = await makeHome();
    const runner = hostedRunner();
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'notify_kinds = "approval,idle"\n');
    await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner });
    await boot({ argv: ['profile', 'export', '--name', 'm2', '--format', 'json'], home, cwd, runner });
    await boot({ argv: ['abandon', '--latest-open', '--reason', 'test'], home, cwd, runner });
    const profilePath = join(home, '.agentic-plugins', 'profiles', 'm2.json');
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--profile-file', profilePath, '--format', 'json'], home, cwd, runner });
    const seeded = plan.report.proposals.proposals.find((p) => p.key === 'notify.notify_kinds');
    strictEqual(seeded.value, 'approval,idle');
    ok(!seeded.refused_by_interview, 'a legal value carries no refusal marker');
    ok(!plan.report.warnings.some((w) => /not answerable through the interview/.test(w)));
  });

  it('`accept` is refused against a value step, naming the grammar that would work', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'accept.json', [{ step_id: SESSION, answer: 'accept' }]);
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    strictEqual(result.exitCode, EXIT.INVALID);
    match(result.report.error, /carries a VALUE, so 'accept' is not the vocabulary/);
    match(result.report.error, /set:session_capture=/);
  });

  it('`set:` is refused against a step that owns no config keys', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'wrong-step.json', [{ step_id: 'egress.configured', answer: 'set:notify_kinds=approval' }]);
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    strictEqual(result.exitCode, EXIT.INVALID);
    match(result.report.error, /owns no config keys/);
  });

  it('an INVALID payload is refused at the answers boundary, before anything is recorded', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'bad.json', [{ step_id: KINDS, answer: `set:notify_kinds=${NOTIFY_KINDS.join(',')}` }]);
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    strictEqual(result.exitCode, EXIT.INVALID);
    match(result.report.error, /indistinguishable from unset/);
  });

  it('the ADR-0047 warning is recomputed from the STANDING ledger, so it survives into a later resume', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'one-sided.json', [{ step_id: KINDS, answer: 'set:notify_kinds=approval,turn-complete' }]);
    await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    // A resume carrying NO answers at all: the warning can only come from the
    // persisted ledger, never from parsing an incoming row.
    const resume = await boot({ argv: ['resume', '--latest-open', '--format', 'json'], home, cwd });
    ok(resume.report.warnings.some((w) => /dual-kind window/.test(w)), 'the warning does not vanish with the verb that produced it');
  });

  it('a set: answer is recorded as ONE atomic string — no sibling value field is written', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'atomic.json', [{ step_id: KINDS, answer: 'set:notify_kinds=approval,idle' }]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    const manifest = await manifestOf(home, plan.report.run_id);
    const row = manifest.choices.find((c) => c.step_id === KINDS);
    deepStrictEqual(Object.keys(row).sort(), ['answer', 'at', 'step_id'], 'the ledger row carries no extra key an older reader would drop');
    strictEqual(row.answer, 'set:notify_kinds=approval,idle');
  });

  it('the persisted manifest still validates against the packaged schema', async () => {
    const { home, cwd } = await makeHome();
    const file = await answers(home, 'valid.json', [
      { step_id: SESSION, answer: 'set:session_capture=stop-hook;entry_brief=startup;entry_brief_empty=report' },
    ]);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd });
    const { makeValidator } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const validate = await makeValidator('runtime-bootstrap-run', { pluginRoot: PLUGIN_ROOT });
    const verdict = validate(await manifestOf(home, plan.report.run_id));
    ok(verdict.ok, `manifest is schema-valid: ${JSON.stringify(verdict.errors ?? []).slice(0, 300)}`);
  });

  it('the schema bumped to 1.3, which is what arms the future-minor fence for the MUTATORS', async () => {
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    const manifest = await manifestOf(home, plan.report.run_id);
    strictEqual(manifest.schema, 'runtime-bootstrap-run-1.3');

    // And the fence itself: a run claiming a NEWER minor is refused by resume.
    const path = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json');
    await writeFile(path, JSON.stringify({ ...manifest, schema: 'runtime-bootstrap-run-1.9' }, null, 2));
    const resume = await boot({ argv: ['resume', '--latest-open', '--format', 'json'], home, cwd });
    strictEqual(resume.exitCode, EXIT.INVALID);
    match(resume.report.diagnostics.join(' '), /newer than this runtime/);
  });
});

describe('bootstrap CLI — the ledger capacity preflight (§3.3)', () => {
  it('refuses BEFORE any effect when the choices ledger would overflow', async () => {
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd });
    const runId = plan.report.run_id;
    const path = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
    const manifest = await manifestOf(home, runId);
    // 256 is the cap; fill it so one more row cannot land.
    manifest.choices = Array.from({ length: 256 }, () => ({ step_id: KINDS, answer: 'set:notify_kinds=approval', at: '2026-08-26T00:00:00Z' }));
    await writeFile(path, JSON.stringify(manifest, null, 2));

    const file = await answers(home, 'one-more.json', [{ step_id: KINDS, answer: 'set:notify_kinds=idle' }]);
    const resume = await boot({ argv: ['resume', '--latest-open', '--answers', file, '--format', 'json'], home, cwd });
    strictEqual(resume.exitCode, EXIT.INVALID);
    strictEqual(resume.report.reason, 'ledger-capacity');
    match(resume.report.diagnostics.join(' '), /nothing was executed, written, or rendered/);

    // The refusal is BEFORE the write, so the manifest is untouched.
    const after = await manifestOf(home, runId);
    strictEqual(after.choices.length, 256, 'the ledger is byte-for-byte what it was');
  });

  it('the preflight constant matches the packaged schema cap it is predicting', async () => {
    // A preflight bound that drifted BELOW the schema would refuse writes the
    // schema would accept; one that drifted ABOVE would let the effect run and
    // fail at persist — the exact failure the preflight exists to prevent.
    const schema = JSON.parse(await readFile(join(PLUGIN_ROOT, 'data', 'schemas', 'runtime-bootstrap-run-1.3.json'), 'utf8'));
    strictEqual(schema.properties.choices.maxItems, 256);
    strictEqual(schema.properties.history.maxItems, 256);
  });
});
