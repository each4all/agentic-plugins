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
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLETION_FIELD_KEYS,
  archiveTimingProblems,
  argsFileRunbookProblems,
  argsFileTypedTextProblems,
  completionBlocks,
  completionReenumerations,
  investigateProfilePlaceholderProblems,
  resolverForms,
  resolverProblems,
  terminalInvocations,
} from '../_runbook-checks.mjs';

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
  '2. Write `{"agentic_args": 1, "text": "…"}` into `args.json` there.',
  '3. Run `node cli.mjs --args-file "$ARGS_DIR/args.json"`.',
  '',
].join('\n');

test('argsFileRunbookProblems names each missing step', () => {
  deepStrictEqual(argsFileRunbookProblems(ARGS_RUNBOOK, 'doc.md'), []);
  deepStrictEqual(argsFileRunbookProblems(broken(ARGS_RUNBOOK, '"text": "…"', '"text": "x"'), 'doc.md'), ['doc.md: no file-writing step']);
  deepStrictEqual(argsFileRunbookProblems('# Doc\n', 'doc.md'), [
    'doc.md: no mktemp step',
    'doc.md: no file-writing step',
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

test('investigateProfilePlaceholderProblems wants the placeholder that names the arguments above', () => {
  deepStrictEqual(investigateProfilePlaceholderProblems('--profile "<profile from the arguments above — brief>"', 'doc.md'), []);
  deepStrictEqual(investigateProfilePlaceholderProblems('--profile "<profile from $ARGUMENTS — brief>"', 'doc.md'), ['doc.md']);
});

test('the args-file checks pass committed runbooks and catch each pin broken in a copy', () => {
  const DECIDE = 'plugins/founder/commands/decide.md';
  const INVESTIGATE = 'plugins/founder/commands/investigate.md';
  const decide = read(DECIDE);
  const investigate = read(INVESTIGATE);
  deepStrictEqual(argsFileRunbookProblems(decide, DECIDE), []);
  deepStrictEqual(argsFileTypedTextProblems(decide, DECIDE), []);
  deepStrictEqual(investigateProfilePlaceholderProblems(investigate, INVESTIGATE), []);

  deepStrictEqual(
    argsFileRunbookProblems(broken(decide, '--args-file "$ARGS_DIR/args.json"', '"$ARGS_DIR/args.json"'), DECIDE),
    [`${DECIDE}: the CLI is not given the file`],
  );
  deepStrictEqual(argsFileTypedTextProblems(broken(decide, '\n$ARGUMENTS\n', '\n'), DECIDE), [`${DECIDE}: the typed text is not shown before the steps`]);
  deepStrictEqual(
    investigateProfilePlaceholderProblems(broken(investigate, '<profile from the arguments above — ', '<profile from $ARGUMENTS — '), INVESTIGATE),
    [INVESTIGATE],
  );
});
