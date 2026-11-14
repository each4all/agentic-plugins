// Gate for tests/_runbook-checks.mjs — the per-document runbook checks the
// sweeping gates share with checks over runbooks assembled in memory
// (ADR-0066 Stage 2a).
//
// The gates that call these helpers prove the committed corpus passes. They
// cannot show that a helper still detects anything once it takes a string,
// because a check that matches nothing passes there too. So each helper runs
// here three ways: on a small document that passes, on the same document with
// its defect, and on a committed runbook read from disk — whole, where it must
// report nothing over a nonzero number of sites, and then broken in a copy of
// its text (never on disk), where it must report the defect.

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLETION_FIELD_KEYS,
  archiveTimingProblems,
  argsFileRunbookProblems,
  argsFileTypedTextProblems,
  caseLinesFor,
  cliCallProblems,
  cliInvocations,
  cliUnscannedCalls,
  completionBlocks,
  completionReenumerations,
  conditionFor,
  peerRunnerContract,
  resolverForms,
  resolverProblems,
  stateCliContract,
  terminalInvocations,
} from '../_runbook-checks.mjs';
import { readWord, stripComments, words } from '../persona-pipeline/_verb-runbooks.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** `text` with the first `from` replaced; refuses an anchor that is not there, so a drifted one cannot pass as a defect that went unseen. */
function broken(text, from, to) {
  ok(text.includes(from), `anchor not found: ${JSON.stringify(from)}`);
  return text.replace(from, () => to);
}

// The committed runbook every rule but the args-file pins applies to.
const COMPOSE = 'plugins/founder/commands/compose.md';

// ── Completion-output contract ──────────────────────────────────────────────

const BLOCK = COMPLETION_FIELD_KEYS.map((key) => `- ${key}: <${key}>`);

test('completionBlocks counts a canonical block and reports a misordered one', () => {
  const passing = completionBlocks(['# Done', '', ...BLOCK, ''].join('\n'), 'doc.md');
  deepStrictEqual([passing.sites, passing.violations, [...passing.blockLines]], [1, [], [2, 3, 4, 5, 6, 7]]);

  const swapped = [...BLOCK];
  [swapped[2], swapped[4]] = [swapped[4], swapped[2]];
  const failing = completionBlocks(['# Done', '', ...swapped, ''].join('\n'), 'doc.md');
  deepStrictEqual([failing.sites, failing.violations], [0, [
    `doc.md:3 — block missing/misordered 'rationale' (expected at line 5, got: "- confidence: <confidence>")`,
  ]]);
});

test('completionReenumerations reports prose that lists the fields, and not the block itself', () => {
  const text = [...BLOCK, '', 'Fill in selected_next, rationale and confidence.', ''].join('\n');
  const { blockLines } = completionBlocks(text, 'doc.md');
  deepStrictEqual(completionReenumerations([...BLOCK, ''].join('\n'), 'doc.md'), []);
  deepStrictEqual(completionReenumerations(text, 'doc.md', blockLines), [
    'doc.md:7 — prose re-enumeration of 3 template fields (selected_next, rationale, confidence); point at the template block / contract section instead',
  ]);
  // Omitting blockLines computes the same set; an empty one counts the block as prose.
  deepStrictEqual(completionReenumerations(text, 'doc.md'), completionReenumerations(text, 'doc.md', blockLines));
  ok(completionReenumerations([...BLOCK, ''].join('\n'), 'doc.md', new Set()).length > 0, 'the block went unseen as prose');
});

test('completionReenumerations: a key inside a CLI flag is no field mention, the bare word still is (PC2b)', () => {
  const flag = ['  --next-action \'<compact selected_next + why + next_command>\' \\', '  --next-step-kind verb \\', '  --next-step-confidence HIGH', ''].join('\n');
  deepStrictEqual(completionReenumerations(flag, 'doc.md'), []);
  const word = flag.replace('--next-step-confidence HIGH', 'the confidence HIGH');
  deepStrictEqual(completionReenumerations(word, 'doc.md'), [
    'doc.md:1 — prose re-enumeration of 3 template fields (selected_next, confidence, next_command); point at the template block / contract section instead',
  ]);
});

// Contract: tests/plugin-shape/test-completion-output-contract.mjs runs both
// helpers over every runbook, and the agent emits its handoff proposal from the
// six-key block they check (completion-output contract §4.1) — a helper that
// finds no block in a real runbook, or misses a misspelt key, lets that gate
// pass a block the agent fills with a field missing; the re-enumeration check
// keeps a second, drifting list of the fields out of the prose around it.
test('the completion checks pass a committed runbook and catch a block broken in a copy of it', () => {
  const text = read(COMPOSE);
  const whole = completionBlocks(text, COMPOSE);
  ok(whole.sites > 0, `${COMPOSE}: no completion block found`);
  deepStrictEqual(whole.violations, []);
  deepStrictEqual(completionReenumerations(text, COMPOSE, whole.blockLines), []);

  const misspelt = completionBlocks(broken(text, '- rationale:', '- rationel:'), COMPOSE);
  strictEqual(misspelt.sites, whole.sites - 1);
  strictEqual(misspelt.violations.length, 1);
  ok(misspelt.violations[0].includes("block missing/misordered 'rationale'"), misspelt.violations[0]);
});

// ── Archive timing ──────────────────────────────────────────────────────────

const ANNOTATION = [
  '# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end; clear it',
  '# with `--terminal-marker false` before then. On Codex the hook is',
  '# trust-gated, so its evaluation is deferred.',
];
const INVOCATION = ['node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \\', '  --workflow-path "$ACTIVE"'];
const fenced = (...lines) => ['```bash', ...lines, '```', ''].join('\n');

test('terminalInvocations finds the runnable sites in fenced blocks, and not prose quoting one', () => {
  const text = [
    'node "$R/scripts/state.mjs" set-terminal is run below:',
    fenced(...ANNOTATION, ...INVOCATION, 'env X=1 node "$R/scripts/state.mjs" finish-verb', 'node "$R/scripts/state.mjs" read'),
  ].join('\n');
  deepStrictEqual(terminalInvocations(text), [
    { line: 5, joined: 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \\ --workflow-path "$ACTIVE"' },
    { line: 7, joined: 'env X=1 node "$R/scripts/state.mjs" finish-verb' },
  ]);
});

test('archiveTimingProblems binds the facts to the comment block directly above each site', () => {
  deepStrictEqual(archiveTimingProblems(fenced(...ANNOTATION, ...INVOCATION), 'doc.md'), { sites: 1, problems: [] });

  // A blank line detaches the note: the site is unannotated.
  const detached = archiveTimingProblems(fenced(...ANNOTATION, '', ...INVOCATION), 'doc.md');
  strictEqual(detached.sites, 1);
  deepStrictEqual(detached.problems, [
    'doc.md:6 — comment block above is missing /ARCHIVE TIMING/ (the block must be findable by its label), '
      + '/every turn end/i (the Claude per-turn firing is the corrected fact), '
      + '/--terminal-marker false/ (the unset window is the only escape), '
      + '/Codex/ (the Codex hook is trust-gated, so its evaluation is deferred)',
  ]);

  // Every fact present, and the inverse asserted alongside.
  deepStrictEqual(
    archiveTimingProblems(fenced(...ANNOTATION, '# The hook does not fire at every turn end.', ...INVOCATION), 'doc.md').problems,
    ['doc.md:6 — annotation asserts the inverse: /not\\s+fire\\s+at\\s+every\\s+turn/i'],
  );
});

// Contract: tests/scripts/test-set-terminal-archive-timing.mjs runs this helper
// over every runbook, for the agent about to make a terminal write — a helper
// that finds no site in a real runbook, or misses a dropped fact, passes a note
// that no longer says the Stop hook fires at every turn end.
test('archiveTimingProblems passes a committed runbook and catches a fact removed in a copy of it', () => {
  const text = read(COMPOSE);
  const whole = archiveTimingProblems(text, COMPOSE);
  ok(whole.sites > 0, `${COMPOSE}: no set-terminal invocation found`);
  deepStrictEqual(whole.problems, []);

  const after = archiveTimingProblems(broken(text, 'EVERY turn end', 'a later, deliberate close'), COMPOSE);
  strictEqual(after.sites, whole.sites);
  strictEqual(after.problems.length, 1);
  ok(after.problems[0].includes('/every turn end/i'), after.problems[0]);
});

// ── The plugin-root resolver ────────────────────────────────────────────────

test('resolverProblems wants a whole resolver before the first use of the root', () => {
  const [opening] = resolverForms('image');
  const use = 'node "$CLAUDE_PLUGIN_ROOT/scripts/x.mjs"';
  const doc = (...lines) => `# Doc\n\n${fenced(...lines)}`;

  deepStrictEqual(resolverProblems(doc(...opening, use), 'image', 'doc.md'), { checked: ['doc.md:4'], offenders: [] });
  // A block that never uses the root is not checked at all.
  deepStrictEqual(resolverProblems(doc('echo hi'), 'image', 'doc.md'), { checked: [], offenders: [] });

  deepStrictEqual(resolverProblems(doc(use, ...opening), 'image', 'doc.md').offenders, [`doc.md:4: ${use}`]);
  deepStrictEqual(resolverProblems(doc(opening[0], use), 'image', 'doc.md').offenders, [`doc.md:5: ${use}`]);
  // Another plugin's resolver is no resolver.
  deepStrictEqual(resolverProblems(doc(...resolverForms('engineer')[0], use), 'image', 'doc.md').offenders.length, 1);
  const fallback = 'CLAUDE_PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"';
  deepStrictEqual(resolverProblems(doc(...opening, fallback, use), 'image', 'doc.md').offenders, [`doc.md:6: ${fallback}`]);
});

test('resolverProblems accepts both founder forms, and the runtime variable', () => {
  const use = 'node "$CLAUDE_PLUGIN_ROOT/scripts/x.mjs"';
  for (const form of resolverForms('founder')) {
    deepStrictEqual(resolverProblems(fenced(...form, use), 'founder', 'doc.md'), { checked: ['doc.md:2'], offenders: [] });
  }
  const runtimeUse = 'node "$RUNTIME_ROOT/scripts/doctor.mjs"';
  deepStrictEqual(resolverProblems(fenced(...resolverForms('runtime')[0], runtimeUse), 'runtime', 'doc.md').offenders, []);
  deepStrictEqual(resolverProblems(fenced(runtimeUse), 'runtime', 'doc.md').offenders, [`doc.md:2: ${runtimeUse}`]);
});

// Contract: tests/plugin-shape/test-headless-safe-runbooks.mjs runs this helper
// over every command runbook; the agent runs each block, and its resolver lines
// set the plugin root a headless `claude -p` Bash call lacks (ADR-0063 S0) — a
// helper blind to a removed resolver passes a block that runs
// `node "/scripts/…"` with an empty root.
test('resolverProblems passes a committed runbook and catches a resolver removed in a copy of it', () => {
  const text = read(COMPOSE);
  const whole = resolverProblems(text, 'founder', COMPOSE);
  ok(whole.checked.length > 0, `${COMPOSE}: no block uses the plugin root`);
  deepStrictEqual(whole.offenders, []);

  // The runbook may open its blocks with the authored or the generated form
  // (founder's verb runbooks hold generated regions, ADR-0066).
  const form = resolverForms('founder').find((f) => text.includes(`${f[0]}\n`));
  ok(form, `${COMPOSE}: opens with no known resolver form`);
  const after = resolverProblems(broken(text, `${form[0]}\n`, ''), 'founder', COMPOSE);
  strictEqual(after.checked.length, whole.checked.length);
  strictEqual(after.offenders.length, 1);
});

// ── Args-file transport ─────────────────────────────────────────────────────

const ARGS_RUNBOOK = [
  '---',
  'description: x',
  '---',
  '# Doc',
  '',
  '$ARGUMENTS',
  '',
  '1. Run `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`.',
  '2. With your file-writing tool, not the shell, write `{"agentic_args": 1, "text": "…"}` into `args.json` there.',
  '3. Run `node cli.mjs --args-file "$ARGS_DIR/args.json"`.',
  '',
].join('\n');

test('argsFileRunbookProblems names each missing step', () => {
  deepStrictEqual(argsFileRunbookProblems(ARGS_RUNBOOK, 'doc.md'), []);
  deepStrictEqual(argsFileRunbookProblems(broken(ARGS_RUNBOOK, '"text": "…"', '"text": "x"'), 'doc.md'), ['doc.md: no file-writing step']);
  deepStrictEqual(argsFileRunbookProblems(broken(ARGS_RUNBOOK, 'With your file-writing tool, not the shell', 'With the shell, not your file-writing tool'), 'doc.md'), ['doc.md: the file is not written with the file-writing tool']);
  deepStrictEqual(argsFileRunbookProblems('# Doc\n', 'doc.md'), [
    'doc.md: no mktemp step',
    'doc.md: no file-writing step',
    'doc.md: the file is not written with the file-writing tool',
    'doc.md: the CLI is not given the file',
  ]);
});

test('argsFileTypedTextProblems wants the substituted text above the mktemp step', () => {
  deepStrictEqual(argsFileTypedTextProblems(ARGS_RUNBOOK, 'doc.md'), []);
  const message = ['doc.md: the typed text is not shown before the steps'];
  deepStrictEqual(argsFileTypedTextProblems(broken(ARGS_RUNBOOK, '$ARGUMENTS\n', ''), 'doc.md'), message);
  // Shown, but only after the step that copies it.
  deepStrictEqual(argsFileTypedTextProblems(`${broken(ARGS_RUNBOOK, '$ARGUMENTS\n', '')}\n$ARGUMENTS\n`, 'doc.md'), message);
  // Frontmatter is not the page the model reads.
  deepStrictEqual(argsFileTypedTextProblems(broken(broken(ARGS_RUNBOOK, '$ARGUMENTS\n', ''), 'description: x', 'description: $ARGUMENTS'), 'doc.md'), message);
});

// Contract: tests/plugin-shape/test-args-file-transport.mjs runs these pins over
// the args-file runbooks (ADR-0059), which the agent follows to hand typed text
// to a CLI — without the mktemp/write/--args-file steps, or with the text not
// shown above them, the agent has no file to pass the CLI or nothing to write
// into it.
test('the args-file checks pass a committed runbook and catch each pin broken in a copy of it', () => {
  const DECIDE = 'plugins/founder/commands/decide.md';
  const decide = read(DECIDE);
  deepStrictEqual(argsFileRunbookProblems(decide, DECIDE), []);
  deepStrictEqual(argsFileTypedTextProblems(decide, DECIDE), []);

  deepStrictEqual(
    argsFileRunbookProblems(broken(decide, '--args-file "$ARGS_DIR/args.json"', '"$ARGS_DIR/args.json"'), DECIDE),
    [`${DECIDE}: the CLI is not given the file`],
  );
  deepStrictEqual(
    // The args file's own sentence: decide's text files have a sentence of
    // their own that names the file-writing tool (ADR-0059's amendment of
    // 2026-10-10), which must not stand in for it.
    argsFileRunbookProblems(broken(decide, 'With your file-writing tool, not the shell, create `args.json`', 'With the shell, not your file-writing tool, create `args.json`'), DECIDE),
    [`${DECIDE}: the file is not written with the file-writing tool`],
  );
  deepStrictEqual(argsFileTypedTextProblems(broken(decide, '\n$ARGUMENTS\n', '\n'), DECIDE), [`${DECIDE}: the typed text is not shown before the steps`]);
});

// ── Runbook CLI contracts ───────────────────────────────────────────────────
// Contract: tests/plugin-shape/test-runbook-cli-contracts.mjs runs these over
// every runbook call of the checked CLIs. Here each reading and each rule runs
// on a source or call written for it, and once over a committed runbook.

const PARSE = { stripComments, words, readWord };

// A state.mjs in the shape stateCliContract reads: the cases of cliRun at six
// spaces, top-level helpers closed at column 0.
const STATE_SOURCE = [
  "const TEXT_FILE_FLAGS = ['summary'];",
  'function cliParseFlags(argv) {',
  "  if (val === undefined || val.startsWith('--')) {",
  '    throw new Error(`Missing value for flag --${name}`);',
  '  }',
  "  if (name === 'tag') (flags[name] ??= []).push(val);",
  '}',
  'function cliPresenceFlags(subcommand, rest) {',
  "  if (subcommand !== 'toggle') return { rest, presence: {} };",
  "  if (a === '--on') presence.on = true;",
  '}',
  'function cliMain(argv) {',
  "  const action = subcommand === 'lane' && args.length > 0 && !args[0].startsWith('--') ? args[0] : undefined;",
  "  if (action !== undefined) flags['lane-action'] = action;",
  "  if (flags['repo-root']) return 0;",
  '}',
  'function cliTarget(f) {',
  "  return f['target'] ?? f.fallback;",
  '}',
  'async function cliRun(subcommand, flags) {',
  '  try {',
  '    switch (subcommand) {',
  "      case 'write': {",
  "        cliRequire(flags, ['workflow-path', 'summary']);",
  "        if (flags.mode === 'x') cliRequire(flags, ['extra']);",
  "        const IMMUTABLE = ['id'];",
  '        for (const f of IMMUTABLE) {',
  '          if (f in flags) {',
  "            throw new Error('immutable');",
  '          }',
  '        }',
  '        return use(cliTarget(flags));',
  '      }',
  "      case 'pick':",
  "      case 'drop': {",
  "        cliRequire(flags, ['workflow-path']);",
  "        if (subcommand === 'drop') {",
  "          cliRequire(flags, ['reason']);",
  "          return drop(flags['reason']);",
  '        }',
  "        return pick(flags['choice']);",
  '      }',
  "      case 'lane': {",
  "        const laneAction = flags['lane-action'];",
  "        if (laneAction === 'join') return 0;",
  "        if (laneAction === 'leave') return 0;",
  '        return 1;',
  '      }',
  "      case 'toggle': {",
  "        if (!capabilityOn('toggles')) return unknownSubcommand(subcommand);",
  "        cliRequire(flags, ['repo-root']);",
  '        return 0;',
  '      }',
  '      default:',
  '        return 2;',
  '    }',
  '  } catch {}',
  '}',
  '',
].join('\n');

test('stateCliContract reads each subcommand: accepted, required, refused, followed into a helper, per member of a shared case', () => {
  const c = stateCliContract(STATE_SOURCE);
  const write = c.subs.get('write');
  deepStrictEqual([...write.required].sort(), ['summary', 'workflow-path']);
  ok(write.accepted.has('extra') && write.accepted.has('mode'), 'a flag read under a condition is accepted');
  deepStrictEqual(write.partial, ['required under a condition: extra']);
  deepStrictEqual([...write.rejected], ['id']);
  ok(write.accepted.has('target') && write.accepted.has('fallback'), 'the helper the flags reach is followed');
  // The shared case, per member: drop's block ends in a return, so pick's
  // flag is not drop's; pick never runs drop's block.
  deepStrictEqual([...c.subs.get('drop').accepted].sort(), ['reason', 'workflow-path']);
  deepStrictEqual([...c.subs.get('drop').required].sort(), ['reason', 'workflow-path']);
  deepStrictEqual([...c.subs.get('pick').accepted].sort(), ['choice', 'workflow-path']);
  deepStrictEqual(c.subs.get('toggle').capability, 'toggles');
  deepStrictEqual([c.strictValues, [...c.textFile], [...c.global].sort(), [...c.presence.get('toggle')]], [true, ['summary'], ['repo-root'], ['on']]);
  deepStrictEqual([c.action.sub, c.action.flag, [...c.action.values]], ['lane', 'lane-action', ['join', 'leave']]);
});

test('stateCliContract refuses a source it cannot read, and marks flags it cannot follow unsupported', () => {
  throws(() => stateCliContract(STATE_SOURCE.replace('async function cliRun(subcommand, flags) {', 'async function run(sub, flags) {')), /no `async function cliRun/);
  throws(() => stateCliContract(STATE_SOURCE.replace("const TEXT_FILE_FLAGS = ['summary'];", '')), /TEXT_FILE_FLAGS/);
  const lost = stateCliContract(STATE_SOURCE.replace('return use(cliTarget(flags));', 'return use(elsewhere(flags));'));
  deepStrictEqual(lost.subs.get('write').unsupported, ['flags reach elsewhere(), which is not a top-level function of the file']);
  const spread = stateCliContract(STATE_SOURCE.replace("return pick(flags['choice']);", "return pick({ ...flags });"));
  ok(spread.subs.get('pick').partial.some((r) => r.startsWith('flags used as')), 'a spread of the flags is named, not taken as nothing read');
  const branching = stateCliContract(STATE_SOURCE.replace("return pick(flags['choice']);", "return subcommand === 'pick' ? pick(flags['choice']) : 0;"));
  ok(branching.subs.get('pick').unsupported.some((r) => r.includes('reads flags on a line that tests the subcommand')));
});

test('conditionFor and caseLinesFor evaluate a condition on the subcommand, leaving other operands open', () => {
  deepStrictEqual(
    ['a', 'b', 'c'].map((s) => conditionFor("(subcommand === 'a' || subcommand === 'b') && flags['x']", s)),
    [null, null, false],
  );
  deepStrictEqual(['a', 'b'].map((s) => conditionFor("subcommand !== 'a'", s)), [false, true]);
  const lines = ["        if (subcommand === 'a' && flags.x) {", '          go();', '        }', "        if (subcommand === 'b') return 0;", '        after();'];
  deepStrictEqual(caseLinesFor(lines, 'a').lines, ["        if (true && flags.x) {", '          go();', '        }', '        after();']);
  deepStrictEqual(caseLinesFor(lines, 'b').lines, ['        return 0;']);
  deepStrictEqual(caseLinesFor(["        if (subcommand === 'a') {", '          x();', '        } else {', '          y();', '        }'], 'a').unsupported.length, 1);
});

const call = (words, extra = {}) => ({ label: 'doc.md', line: 3, root: 'CLAUDE_PLUGIN_ROOT', script: 'state.mjs', words, ...extra });

test('cliCallProblems holds a state.mjs call to its subcommand: name, flags read, value, required, refused, capability', () => {
  const c = stateCliContract(STATE_SOURCE);
  const ok1 = cliCallProblems(call(['write', '--workflow-path', '/w', '--summary-file', '/s', '--target', 't']), 'state', c);
  deepStrictEqual([ok1.status, ok1.problems], ['checked', []]);
  deepStrictEqual(cliCallProblems(call(['writ', '--workflow-path', '/w']), 'state', c).problems, ['doc.md:3 state.mjs writ: no such subcommand']);
  deepStrictEqual(cliCallProblems(call(['write', '--workflow-path', '/w', '--summary', 's', '--targte', 't']), 'state', c).problems, ['doc.md:3 state.mjs write: --targte is not read by write']);
  deepStrictEqual(cliCallProblems(call(['write', '--workflow-path', '/w']), 'state', c).problems, ['doc.md:3 state.mjs write: required --summary is missing']);
  deepStrictEqual(cliCallProblems(call(['write', '--workflow-path', '/w', '--summary', 's', '--id', '1']), 'state', c).problems, ['doc.md:3 state.mjs write: --id is refused by write']);
  deepStrictEqual(cliCallProblems(call(['write', '--summary', 's', '--workflow-path']), 'state', c).problems, ['doc.md:3 state.mjs write: --workflow-path has no value']);
  deepStrictEqual(cliCallProblems(call(['write', '--workflow-path', '/w', '--summary', 's', 'stray']), 'state', c).problems, ['doc.md:3 state.mjs write: positional argument "stray"']);
  deepStrictEqual(cliCallProblems(call(['drop', '--workflow-path', '/w', '--choice', 'c']), 'state', c).problems, [
    'doc.md:3 state.mjs drop: --choice is not read by drop',
    'doc.md:3 state.mjs drop: required --reason is missing',
  ]);
  deepStrictEqual(cliCallProblems(call(['toggle', '--repo-root', '/r', '--on']), 'state', c, { toggles: false }).problems, ['doc.md:3 state.mjs toggle: the subcommand needs capability toggles, which this persona has off']);
  deepStrictEqual(cliCallProblems(call(['toggle', '--repo-root', '/r', '--on']), 'state', c, { toggles: true }).problems, []);
  deepStrictEqual(cliCallProblems(call(['lane', 'jump']), 'state', c).problems, ['doc.md:3 state.mjs lane: no such action jump']);
  deepStrictEqual(cliCallProblems(call(['lane', 'join']), 'state', c).problems, []);
  // No action word: the case would run with none and refuse, unless the flag
  // cliMain hands the action in names one (critique of 2026-11-14, round 2).
  deepStrictEqual(cliCallProblems(call(['lane', '--repo-root', '/r']), 'state', c).problems, ['doc.md:3 state.mjs lane: no action (one of join, leave), as a word after lane or --lane-action']);
  deepStrictEqual(cliCallProblems(call(['lane', '--lane-action', 'join']), 'state', c).problems, []);
  deepStrictEqual(cliCallProblems(call(['lane', '--lane-action', 'jump']), 'state', c).problems, ['doc.md:3 state.mjs lane: no such action jump']);
  deepStrictEqual(cliCallProblems(call(['lane', '--lane-action', '$A'], { expands: [false, false, true] }), 'state', c).problems, []);
  // A valueless action flag names none, under a lenient parser too.
  const lenient = { ...c, strictValues: false };
  deepStrictEqual(cliCallProblems(call(['lane', '--repo-root', '/r', '--lane-action']), 'state', lenient).problems, ['doc.md:3 state.mjs lane: --lane-action names no action (one of join, leave)']);
});

test('cliCallProblems names what it cannot check instead of passing it', () => {
  const c = stateCliContract(STATE_SOURCE);
  const open = cliCallProblems(call(['write', '--workflow-path', '/w', '$@']), 'state', c);
  deepStrictEqual([open.status, open.problems, open.partial], ['checked', [], ['required under a condition: extra', 'arguments expand at run time: required flags not checked']]);
  deepStrictEqual(cliCallProblems(call(['$SUB', '--workflow-path', '/w']), 'state', c).status, 'unsupported');
  const lost = stateCliContract(STATE_SOURCE.replace('return use(cliTarget(flags));', 'return use(elsewhere(flags));'));
  deepStrictEqual(cliCallProblems(call(['write', '--workflow-path', '/w', '--summary', 's']), 'state', lost).status, 'unsupported');
});

const RUNNER_SOURCE = [
  'function parseCliArgs(argv) {',
  '  const [subcommand, ...rest] = argv;',
  '  for (let i = 0; i < rest.length; i++) {',
  '    switch (rest[i]) {',
  "      case '--repo-root':",
  '        opts.repoRoot = rest[++i];',
  '        break;',
  "      case '--run-id':",
  '        opts.runId = rest[++i];',
  '        break;',
  "      case '--summary-file':",
  '        opts.summaryFile = rest[++i];',
  '        break;',
  "      case '--json':",
  '        opts.json = true;',
  '        break;',
  '    }',
  '  }',
  "  if (Object.hasOwn(opts, 'summaryFile')) opts.summary = read(opts.summaryFile);",
  '  return opts;',
  '}',
  'async function cliMain(argv) {',
  '  return run(opts.repoRoot);',
  '}',
  'async function cliRun(opts) {',
  '  try {',
  "    if (opts.subcommand === 'status') {",
  "      if (!opts.runId) throw new Error('--run-id is required');",
  '      return show(opts.runId, opts.json);',
  '    }',
  '',
  "    if (opts.subcommand === 'settle') {",
  '      return settle(opts.summary);',
  '    }',
  '  } catch {}',
  '}',
  '',
].join('\n');

test('peerRunnerContract and cliCallProblems hold a peer-runner call to its parser and its subcommand', () => {
  const c = peerRunnerContract(RUNNER_SOURCE);
  deepStrictEqual([...c.subs.get('status').required], ['run-id']);
  ok(c.subs.get('settle').accepted.has('summary-file'), 'a flag the parser derives an option from counts where the option is read');
  const runner = (words) => call(words, { script: 'peer-runner.mjs' });
  deepStrictEqual(cliCallProblems(runner(['status', '--run-id', 'r', '--json', '--repo-root', '/r']), 'peer-runner', c).problems, []);
  deepStrictEqual(cliCallProblems(runner(['status', '--json']), 'peer-runner', c).problems, ['doc.md:3 peer-runner.mjs status: required --run-id is missing']);
  deepStrictEqual(cliCallProblems(runner(['status', '--run-id', 'r', '--verbose']), 'peer-runner', c).problems, ['doc.md:3 peer-runner.mjs status: --verbose is no flag of the parser']);
  deepStrictEqual(cliCallProblems(runner(['settle', '--run-id', 'r']), 'peer-runner', c).problems, ['doc.md:3 peer-runner.mjs settle: --run-id is not read by settle']);
  deepStrictEqual(cliCallProblems(runner(['status', '--run-id']), 'peer-runner', c).problems, ['doc.md:3 peer-runner.mjs status: --run-id has no value']);
});

test('cliInvocations reads each call of a shell block as the shell reads it, with its line', () => {
  const doc = [
    '# Doc',
    '',
    '  ```bash',
    '  # node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" commented-out',
    '  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT" 2>/dev/null)"',
    '  node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" append \\',
    "    --workflow-path \"$ACTIVE\" --gate <gate> # a note",
    '  ```',
    '',
    '```text',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" prose',
    '```',
    '',
  ].join('\n');
  deepStrictEqual(cliInvocations(doc, 'doc.md', PARSE).map((c) => [c.line, c.root, c.script, c.words]), [
    [5, 'CLAUDE_PLUGIN_ROOT', 'state.mjs', ['find-active', '--repo-root', '$REPO_ROOT']],
    [6, 'ORCH_PLUGIN_ROOT', 'state.mjs', ['append', '--workflow-path', '$ACTIVE', '--gate', '_gate_']],
  ]);
});

test('the CLI contract check passes a committed runbook and catches a flag misspelled in a copy of it', () => {
  const COMPOSE_ENGINEER = 'plugins/engineer/commands/compose.md';
  const contract = stateCliContract(read('plugins/engineer/scripts/state.mjs'));
  const capabilities = JSON.parse(read('plugins/engineer/persona.json')).capabilities;
  const check = (text) => cliInvocations(text, COMPOSE_ENGINEER, PARSE)
    .filter((c) => c.script === 'state.mjs')
    .flatMap((c) => cliCallProblems(c, 'state', contract, capabilities).problems);
  const text = read(COMPOSE_ENGINEER);
  ok(cliInvocations(text, COMPOSE_ENGINEER, PARSE).filter((c) => c.script === 'state.mjs').length >= 5, 'the runbook has state.mjs calls');
  deepStrictEqual(check(text), []);
  const problems = check(broken(text, '--next-step-kind verb --next-step-verb', '--next-step-kind verb --next-stepverb'));
  deepStrictEqual(problems.length, 1);
  ok(/state\.mjs finish-verb: --next-stepverb is not read by finish-verb$/.test(problems[0]), problems[0]);
});

test('cliInvocations keeps the words after a redirection, reads a placeholder root, and a single-quoted $ as text', () => {
  const doc = [
    '```bash',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp 2>/dev/null --bogus x',
    'node --no-warnings "<plugin-root>/scripts/state.mjs" read --host <claude|codex> \'$literal\'',
    '```',
    '',
  ].join('\n');
  deepStrictEqual(cliInvocations(doc, 'doc.md', PARSE).map((c) => [c.root, c.words, c.expands]), [
    ['CLAUDE_PLUGIN_ROOT', ['find-active', '--repo-root', '/tmp', '--bogus', 'x'], [false, false, false, false, false]],
    ['<plugin-root>', ['read', '--host', '_claude_codex_', '$literal'], [false, false, false, false]],
  ]);
});

test('the call readers fail closed on the spellings they cannot read whole (critique of 2026-11-14)', () => {
  const c = stateCliContract(STATE_SOURCE);
  const doc = (...lines) => ['```bash', ...lines, '```', ''].join('\n');
  // A second call on a line, in a spelling INVOCATION does not take, and one
  // split across lines, are each found unscanned, call by call.
  const second = doc('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp; node "$CLAUDE_PLUGIN_ROOT"/scripts/state.mjs nonexistent --bogus x');
  deepStrictEqual(cliInvocations(second, 'doc.md', PARSE).length, 1);
  deepStrictEqual(cliUnscannedCalls(second, 'doc.md', PARSE).map((u) => [u.line, u.text]), [[2, 'node "$CLAUDE_PLUGIN_ROOT"/scripts/state.mjs']]);
  deepStrictEqual(cliUnscannedCalls(doc('node \\', '  "$CLAUDE_PLUGIN_ROOT"/scripts/peer-runner.mjs run'), 'doc.md', PARSE).map((u) => u.line), [2]);
  deepStrictEqual(cliUnscannedCalls(doc('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read; node "<plugin-root>/scripts/peer-runner.mjs" status', '# node "$X"/scripts/state.mjs'), 'doc.md', PARSE), []);
  // A heredoc's operator is passed over; a process substitution cuts the call,
  // which is unsupported rather than checked on its first words.
  const [heredoc, procSub] = cliInvocations(doc(
    "node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" write --workflow-path /w <<'EOF' --bogus x",
    'EOF',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" write --workflow-path /w --summary s > >(cat) --bogus x',
  ), 'doc.md', PARSE);
  deepStrictEqual(heredoc.words, ['write', '--workflow-path', '/w', '--bogus', 'x']);
  ok(cliCallProblems(heredoc, 'state', c).problems.includes('doc.md:2 state.mjs write: --bogus is not read by write'));
  const cut = cliCallProblems(procSub, 'state', c);
  deepStrictEqual([cut.status, cut.problems, cut.partial], ['unsupported', [], ['the words end at a > the reading does not take']]);
  // A redirection is taken only outside quotes, and only with a whole target
  // that holds no command substitution: otherwise the call is cut there, and a
  // call inside the target stays readable (refine-verify of 2026-11-14).
  const redirected = (line) => cliInvocations(doc(line), 'doc.md', PARSE).map((x) => [x.words, x.cut ?? null]);
  const cutAt = (ch) => `the words end at a ${ch} the reading does not take`;
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root <<< $(pwd) --bogus x'), [[['find-active', '--repo-root'], cutAt('<')]]);
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /r > $(mktemp) --bogus x'), [[['find-active', '--repo-root', '/r'], cutAt('>')]]);
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "a <<\'b" --bogus "c\' "'), [[['find-active', '--repo-root', "a <<'b", '--bogus', "c' "], null]]);
  deepStrictEqual(redirected('cat <<< "$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" nonexistent --bogus x)"'), [[['nonexistent', '--bogus', 'x'], null]]);
  deepStrictEqual(redirected('cat < "$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" nonexistent --bogus x)"'), [[['nonexistent', '--bogus', 'x'], null]]);
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --x "$F" 2>/dev/null >> "$OUT".log <<< "$TEXT" --y z'), [[['read', '--x', '$F', '--y', 'z'], null]]);
  // A heredoc's body is passed over: a quote in it opens nothing, and a call
  // in an unquoted body stays readable. `&>` and `&>>` are redirections too.
  const block = (...lines) => cliInvocations(doc(...lines), 'doc.md', PARSE).map((x) => [x.words, x.cut ?? null]);
  deepStrictEqual(block("cat <<'EOF'", '"', 'EOF', 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "a <<\'b" --bogus "c\' "'), [[['find-active', '--repo-root', "a <<'b", '--bogus', "c' "], null]]);
  deepStrictEqual(block("cat <<'EOF'", '"', 'EOF', 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp 2>/dev/null'), [[['find-active', '--repo-root', '/tmp'], null]]);
  deepStrictEqual(block('cat <<EOF', '> \'$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" nonexistent --bogus x)\'', 'EOF'), [[['nonexistent', '--bogus', 'x'], null]]);
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp &>/dev/null --bogus x'), [[['find-active', '--repo-root', '/tmp', '--bogus', 'x'], null]]);
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp &>$(x) --bogus x'), [[['find-active', '--repo-root', '/tmp'], cutAt('&>')]]);
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp &>> "$L" --bogus x'), [[['find-active', '--repo-root', '/tmp', '--bogus', 'x'], null]]);
  // `&>` takes no descriptor number: the digit before it is a word of the
  // call, and the `&>` it touches is not taken, so the call is cut there.
  deepStrictEqual(redirected('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root /tmp 2&>/dev/null'), [[['find-active', '--repo-root', '/tmp', '2'], cutAt('&>')]]);
  // A long target that is refused is refused (TARGET_PART's alternatives are
  // disjoint, so the regex does not backtrack exponentially; a pool file
  // bounds no real time).
  deepStrictEqual(redirected(`node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read > /tmp/${'a'.repeat(60)}-$(date +%s).log`), [[['read'], cutAt('>')]]);
  // A shell fence left open hides its block from both readers, so it is
  // reported as unscanned, with the line of the fence (critique round 2).
  const unclosed = ['# Doc', '', '```bash', 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --bogus', ''].join('\n');
  deepStrictEqual(cliInvocations(unclosed, 'doc.md', PARSE), []);
  deepStrictEqual(cliUnscannedCalls(unclosed, 'doc.md', PARSE).map((u) => [u.line, u.text]), [[3, 'a ``` fence that is never closed']]);
  deepStrictEqual(cliUnscannedCalls(doc('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read'), 'doc.md', PARSE), []);
  deepStrictEqual(cliUnscannedCalls('```bash```\nnode "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read\n', 'doc.md', PARSE), [], 'a backtick in the info string makes no fence');
  // Words that end inside an unterminated quote or `$(` cut the call, which is
  // unsupported rather than checked on what the split swallowed (critique
  // round 3); a quote or substitution closed on a later line is read whole.
  const openEnd = (kind) => `the words end inside an unterminated ${kind}`;
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "/tmp --bogus x'), [[['find-active', '--repo-root', '/tmp --bogus x'], openEnd('quote')]]);
  deepStrictEqual(block("node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" find-active --repo-root '/tmp --bogus x"), [[['find-active', '--repo-root', '/tmp --bogus x'], openEnd('quote')]]);
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$(pwd --bogus x').map(([, cut]) => cut), [openEnd('quote')]);
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root $(pwd --bogus x').map(([, cut]) => cut), [openEnd('substitution')]);
  const typo = cliCallProblems(cliInvocations(doc('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "/tmp --bogus x'), 'doc.md', PARSE)[0], 'state', c);
  deepStrictEqual([typo.status, typo.problems, typo.partial], ['unsupported', [], [openEnd('quote')]]);
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" write --workflow-path /w --summary "a', 'b" --next "$(printf', 'x)"'), [[['write', '--workflow-path', '/w', '--summary', 'a\nb', '--next', '$(printf\nx)'], null]]);
  // The closing is read with the shell's nesting (refine-verify of the same
  // round): a quoted `)` or a plain `( … )` inside a `$(` closes nothing, a
  // quote inside it opens its own, and a backtick is a construct of its own.
  const cutOf = (line) => block(line).map(([, cut]) => cut);
  deepStrictEqual(cutOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$(printf ")"'), [openEnd('quote')]);
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$(printf "%s" ")")" --bogus x').map(([w]) => w.at(-1)), ['x']);
  deepStrictEqual(cutOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root $( (pwd)'), [openEnd('substitution')]);
  deepStrictEqual(cutOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "`pwd"'), [openEnd('quote')]);
  deepStrictEqual(cutOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root `pwd --bogus x'), [openEnd('backtick')]);
  deepStrictEqual(cutOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root `printf "`'), [openEnd('backtick')]);
  deepStrictEqual(cutOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root `printf $(pwd`'), [openEnd('backtick')]);
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "`printf \'%s\' "x"`" --bogus x').map(([w, cut]) => [w.at(-1), cut]), [['x', null]]);
  deepStrictEqual(block('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$(', "  printf '%s' '$('", ')" --bogus x').map(([w, cut]) => [w.at(-1), cut]), [['x', null]]);
  // An unquoted `--x=$V` names its flag literally; an expanding word whose
  // literal text opens with `--` is a flag, not the value before it.
  const eq = { ...c, equals: true };
  const [read] = cliInvocations(doc('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" write --workflow-path /w --summary s --bogus=$VALUE'), 'doc.md', PARSE);
  deepStrictEqual(read.words.at(-1), '<unquoted>--bogus=$VALUE');
  const unquoted = cliCallProblems({ ...read, line: 3 }, 'state', eq);
  deepStrictEqual([unquoted.problems, unquoted.partial], [['doc.md:3 state.mjs write: --bogus is not read by write'], ['required under a condition: extra']]);
  const flagAsValue = cliCallProblems(call(['write', '--summary', 's', '--workflow-path', '--bogus=$VALUE'], { expands: [false, false, false, false, true] }), 'state', eq);
  deepStrictEqual(flagAsValue.problems, ['doc.md:3 state.mjs write: --workflow-path has no value', 'doc.md:3 state.mjs write: --bogus is not read by write']);
  // peer-runner's parser takes an expanding next word as the value, whatever
  // its literal text opens with.
  const runnerC = peerRunnerContract(RUNNER_SOURCE);
  const runnerCall = (words, expands) => call(words, { script: 'peer-runner.mjs', expands });
  deepStrictEqual(cliCallProblems(runnerCall(['settle', '--summary-file', '--note=$VALUE'], [false, false, true]), 'peer-runner', runnerC).problems, []);
  deepStrictEqual(cliCallProblems(runnerCall(['status', '--run-id', '--json'], [false, false, false]), 'peer-runner', runnerC).problems, ['doc.md:3 peer-runner.mjs status: --run-id has no value']);
});

test('stateCliContract: a flag read only to refuse it is refused, under a capability while it is off', () => {
  const source = STATE_SOURCE.replace("        return use(cliTarget(flags));",
    "        if ('legacy' in flags) throw new Error('gone');\n        if (!capabilityOn('links') && flags.parent !== undefined) {\n          throw new Error('no links');\n        }\n        return use(cliTarget(flags), flags.parent);");
  const c = stateCliContract(source);
  const write = c.subs.get('write');
  ok(write.rejected.has('legacy') && !write.accepted.has('legacy'), 'a flag only a refusal reads is refused');
  ok(write.accepted.has('parent') && write.rejectedUnless.get('links').has('parent'));
  const base = ['write', '--workflow-path', '/w', '--summary', 's'];
  deepStrictEqual(cliCallProblems(call([...base, '--legacy', '1']), 'state', c).problems, ['doc.md:3 state.mjs write: --legacy is refused by write']);
  deepStrictEqual(cliCallProblems(call([...base, '--parent', 'p']), 'state', c, { links: false }).problems, ['doc.md:3 state.mjs write: --parent is refused by write while capability links is off']);
  deepStrictEqual(cliCallProblems(call([...base, '--parent', 'p']), 'state', c, { links: true }).problems, []);
});

test('stateCliContract reads the shapes that would widen a contract, or refuses them', () => {
  // A member's block whose return spans lines still ends the member.
  const multi = stateCliContract(STATE_SOURCE.replace("          return drop(flags['reason']);", "          return drop(\n            flags['reason'],\n          );"));
  deepStrictEqual([...multi.subs.get('drop').accepted].sort(), ['reason', 'workflow-path']);
  // A label the reader does not take is refused, not folded into the case above it.
  throws(() => stateCliContract(STATE_SOURCE.replace("      case 'toggle': {", '      case "toggle": {')), /a case label of cliRun is not read/);
  // A double-quoted list is read like a single-quoted one.
  deepStrictEqual([...stateCliContract(STATE_SOURCE.replace("cliRequire(flags, ['repo-root']);", 'cliRequire(flags, ["repo-root"]);')).subs.get('toggle').required], ['repo-root']);
  // Only the named accessors read a flag by name; another call is a helper to follow.
  deepStrictEqual(stateCliContract(STATE_SOURCE.replace('return use(cliTarget(flags));', "return external(flags, 'zz');")).subs.get('write').unsupported, ['flags reach external(), which is not a top-level function of the file']);
  // How the parser reads a flag with no value is read from its code.
  throws(() => stateCliContract(STATE_SOURCE.replace('    throw new Error(`Missing value for flag --${name}`);', '    return;')), /neither or both/);
});

test('cliCallProblems refuses the = form a parser does not split, a repeated flag, and both forms of a text flag', () => {
  const c = stateCliContract(STATE_SOURCE);
  const base = ['write', '--workflow-path', '/w'];
  deepStrictEqual(cliCallProblems(call([...base, '--summary=s']), 'state', c).problems, ['doc.md:3 state.mjs write: --summary=… is not split by the parser (it takes no = form)']);
  deepStrictEqual(cliCallProblems(call([...base, '--summary', 's', '--tag', 'a', '--tag', 'b']), 'state', c).problems, Array(2).fill('doc.md:3 state.mjs write: --tag is not read by write'));
  deepStrictEqual(c.repeatable, new Set(['tag']));
  deepStrictEqual(cliCallProblems(call([...base, '--summary', 's', '--summary', 't']), 'state', c).problems, ['doc.md:3 state.mjs write: --summary is given more than once']);
  deepStrictEqual(cliCallProblems(call([...base, '--summary', 's', '--summary-file', '/f']), 'state', c).problems, ['doc.md:3 state.mjs write: --summary and --summary-file are both given']);
  // A literal flag name whose value expands is still checked by name.
  deepStrictEqual(cliCallProblems(call(['write', '--workflow-pth=$W', '--summary', 's'], { expands: [false, true, false, false] }), 'state', c).problems.length, 2);
});
