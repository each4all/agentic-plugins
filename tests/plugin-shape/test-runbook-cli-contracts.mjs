// Gate: every runbook call of a checked CLI names a subcommand that CLI has,
// passes only flags that subcommand reads, and passes the flags it requires
// (the standard test shape, owner decision 2026-11-09, W7 Task 2).
//
// The CLIs declare no option table: state.mjs takes any `--name` and the
// subcommand reads the ones it knows, so a misspelled, stale or misplaced flag
// in a runbook ran without a word, and only a test that executed the whole
// block could notice — when it asserted the effect. This check needs no
// process: it reads each CLI's contract from its source
// (tests/_runbook-checks.mjs: stateCliContract, peerRunnerContract) and each
// call from the runbooks' shell blocks (cliInvocations, with the shell-word
// reader of tests/persona-pipeline/_verb-runbooks.mjs), and holds one to the
// other (cliCallProblems). A runbook test that executes a block is then left
// for what only a run can show: the block's effect on the happy path.
//
// The release of the persona and orchestrator plugins' text and operation
// directories (ADR-0059 Decision 10) is held here too, by the tests at the end
// of this file: each region, and each orchestrator command or skill, the path
// list (persona-pipeline/tmpdir-paths.json) names makes and releases exactly
// what the list says, on the paths it says, after every block that reads the
// directory, and before no later block that reads it unnamed; no region or
// authored text makes one outside the make, except what the list's `pending`
// names (the rollout's remainder); no text releases one by hand (item 2), and
// no shell block calls either subcommand but through its snippet; every region
// template, and every orchestrator file, that names them is in the list.
//
// Checked: the state.mjs and peer-runner.mjs of designer, engineer, founder and
// orchestrator, called from any markdown under a plugin's commands/, core/ or
// adapters/, by a root variable or a skill's `<plugin-root>` placeholder. Other
// scripts' calls are counted, not checked. Every call of node on a checked script
// in a shell block, read loosely (cliUnscannedCalls), must be a scanned call, so,
// subject to the known limits below, a spelling the scanner does not read
// cannot drop one unseen, a second call on a line or one split across lines
// included, and a fence left open (which hides its block from both readers) is
// listed with them; a call whose words the reading cuts short (a process
// substitution, or a quote or `$(` left unterminated) is unsupported. A state.mjs subcommand that takes an action
// word (`admission join`) needs one, as the word or its flag. Known limits: a call quoted as data inside a shell block (a
// printf or heredoc of the command text) is read as a call, a false positive
// the gate shows rather than a defect it hides. Two heredoc layouts are
// misread by the preprocessing both readers share (shellCallTexts), so a call
// it erases is missed by both: (1) a plain `<<` heredoc whose body holds a
// tab-prefixed line equal to the delimiter before the real, unindented
// terminator: the readers strip the tab as for `<<-` and end the body there,
// so a quote in the rest of the body flips their quote state and can hide
// later calls; (2) a heredoc with an unquoted delimiter nested inside
// `$(...)`, whose body holds `# $(node …)` on a line: stripComments skips
// heredoc bodies at the top level only, so it cuts that line from the `#` as a
// comment, and the call on it with it. No committed runbook uses either (0 of
// 841 calls); deferred as rare layouts under the owner rule of 2026-10-25
// (owner decision 2026-11-14). Two spellings inside a `$(` are misread by
// words() too: a `case` arm's `)` closes the substitution early, so the words
// after it can be dropped, and a literal `(` in a `${VAR:-(}` opens a pair, so
// a closed call is cut (shown, not hidden). In a backtick substitution a
// backslash is read once, not through the escaping layer the backtick
// removes: an escaped quote in it (`\"'\"`, a nested `\``) can cut a closed
// call (shown), and an escaped `\$(` left open in it is not reported. No
// committed runbook uses any of these (0 of 1012 calls hold a backtick); rare
// spellings under the same rule (refine of critique round 3).
//
// For calls that survive preprocessing, never permissive: what the reading cannot settle is listed, and the lists
// are pinned here, so a new kind of gap fails until it is looked at. An
// unsupported call (no rule applied) must not exist; a partial one (a rule
// skipped, e.g. required flags behind run-time arguments) must give a reason
// this file names. Non-vacuity is by identity: named calls must be among the
// checked ones, not only a count above a floor.

import { test } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHELL_LANGS, cliCallProblems, cliInvocations, cliUnscannedCalls, fencedBlocks, peerRunnerContract, stateCliContract, tmpdirBlockReads, tmpdirHandReleaseLines, tmpdirLegacyLines, tmpdirOrderProblems, tmpdirProblems } from '../_runbook-checks.mjs';
import { readWord, stripComments, words } from '../persona-pipeline/_verb-runbooks.mjs';
import { MANIFEST, declaration } from '../persona-pipeline/_personas.mjs';
import { parseRegions, renderTemplate, renderingDeclaration, replaceRegionBodies, snippetText } from '../../scripts/lib/persona-pipeline.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PARSE = { stripComments, words, readWord };
const PLUGINS = ['designer', 'engineer', 'founder', 'orchestrator'];
const PERSONAS = ['designer', 'engineer', 'founder'];
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// The root variables a runbook names another plugin's scripts by;
// CLAUDE_PLUGIN_ROOT is the runbook's own plugin.
// A skill names the roots by placeholder: `<plugin-root>` is its own.
const ROOTS = { ORCH_PLUGIN_ROOT: 'orchestrator', ENGINEER_PLUGIN_ROOT: 'engineer', ENGINEER_ROOT: 'engineer', '<orchestrator-plugin-root>': 'orchestrator' };
const OWN_ROOTS = new Set(['CLAUDE_PLUGIN_ROOT', '<plugin-root>']);
const KINDS = { 'state.mjs': 'state', 'peer-runner.mjs': 'peer-runner' };

// The reasons a call may be checked in part. A new one fails the gate.
const PARTIAL_REASONS = new Set([
  'flags a peer-runner subcommand requires past cliRun are not checked',
  'arguments expand at run time: required flags not checked',
  'required under a condition: command, host',
  'required under a condition: admission',
]);

function corpus() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.md')) files.push(relative(REPO_ROOT, path));
    }
  };
  for (const plugin of readdirSync(join(REPO_ROOT, 'plugins')).sort()) {
    for (const part of ['commands', 'core', 'adapters']) {
      const dir = join(REPO_ROOT, 'plugins', plugin, part);
      try { statSync(dir); } catch { continue; }
      walk(dir);
    }
  }
  return files;
}

const contracts = Object.fromEntries(PLUGINS.map((p) => [p, {
  state: stateCliContract(read(`plugins/${p}/scripts/state.mjs`)),
  'peer-runner': peerRunnerContract(read(`plugins/${p}/scripts/peer-runner.mjs`)),
  capabilities: PERSONAS.includes(p) ? JSON.parse(read(`plugins/${p}/persona.json`)).capabilities : null,
}]));

function sweep() {
  const result = { files: 0, checked: [], unsupported: [], unresolved: [], problems: [], partial: new Map(), other: 0, unscanned: [] };
  for (const file of corpus()) {
    result.files++;
    const own = file.split('/')[1];
    const text = read(file);
    const calls = cliInvocations(text, file, PARSE);
    // Each call of node on a checked script, read loosely, call by call, must
    // be one the scanner read, so a spelling it does not read cannot drop a
    // call from the check unseen.
    for (const u of cliUnscannedCalls(text, file, PARSE)) result.unscanned.push(`${file}:${u.line}: ${u.text}`);
    // Each call's identity: file, CLI, subcommand (with its action word) and
    // its ordinal among the calls of that name in the file.
    const seen = new Map();
    for (const call of calls) {
      const kind = KINDS[call.script];
      if (kind === undefined) { result.other++; continue; }
      const target = OWN_ROOTS.has(call.root) ? own : ROOTS[call.root];
      if (contracts[target] === undefined) { result.unresolved.push(`${file}:${call.line} $${call.root}/scripts/${call.script}`); continue; }
      const c = contracts[target];
      const r = cliCallProblems(call, kind, c[kind], kind === 'state' ? c.capabilities : null);
      const action = c[kind].action?.sub === r.sub && call.words[1] !== undefined && !call.words[1].startsWith('-') ? ` ${call.words[1]}` : '';
      const name = `${file} ${target}:${call.script} ${r.sub}${action}`;
      seen.set(name, (seen.get(name) ?? 0) + 1);
      const identity = `${name}#${seen.get(name)}`;
      if (r.status === 'unsupported') result.unsupported.push(`${identity} (line ${call.line}): ${r.partial.join('; ')}`);
      else result.checked.push(identity);
      result.problems.push(...r.problems);
      for (const reason of r.partial) result.partial.set(reason, [...(result.partial.get(reason) ?? []), `${file}:${call.line}`]);
    }
  }
  return result;
}

const SWEEP = sweep();

test('every checked CLI call names a subcommand it has, flags it reads and the flags it requires', () => {
  deepStrictEqual(SWEEP.problems, []);
});

test('every state.mjs and peer-runner.mjs call resolves to a plugin whose contract is read, and is scanned', () => {
  deepStrictEqual(SWEEP.unresolved, []);
  deepStrictEqual(SWEEP.unscanned, []);
});

test('no call goes unchecked, and a call checked in part gives a reason this gate names', () => {
  deepStrictEqual(SWEEP.unsupported, []);
  const unnamed = [...SWEEP.partial].filter(([reason]) => !PARTIAL_REASONS.has(reason)).map(([reason, sites]) => `${reason}: ${sites.join(', ')}`);
  deepStrictEqual(unnamed, []);
});

test('the sweep reads the corpus and checks the calls it names', () => {
  ok(SWEEP.files >= 100, `only ${SWEEP.files} markdown files read`);
  ok(SWEEP.checked.length >= 700, `only ${SWEEP.checked.length} calls checked (${SWEEP.other} other scripts' calls counted)`);
  const checked = new Set(SWEEP.checked);
  const named = [];
  // Each persona verb runbook's dispatch, settle and last write.
  for (const p of PERSONAS) {
    for (const verb of ['compose', 'critique', 'decide', 'frame', 'investigate', 'refine']) {
      const file = `plugins/${p}/commands/${verb}.md`;
      named.push(`${file} ${p}:peer-runner.mjs run#1`, `${file} ${p}:peer-runner.mjs settle#1`, `${file} ${p}:state.mjs finish-verb#1`);
    }
  }
  // The dispatch's holds (ADR-0068 Decision 2), the pilot of the standard shape.
  const next = 'plugins/orchestrator/commands/next.md';
  for (const sub of ['hold-gate#1', 'hold-gate#2', 'dispatch-mark-publish#1', 'dispatch-mark-check#1', 'dispatch-mark-withdraw#1', 'dispatch-mark-withdraw#2', 'admission join#1', 'admission release#1', 'subtask-update#1']) {
    named.push(`${next} orchestrator:state.mjs ${sub}`);
  }
  named.push(`${next} engineer:state.mjs dispatch-selection#1`);
  named.push('plugins/orchestrator/core/skills/next/SKILL.md orchestrator:state.mjs dispatch-mark-check#1');
  for (const file of ['plugins/orchestrator/commands/abort.md', 'plugins/orchestrator/commands/finalize.md']) {
    named.push(`${file} orchestrator:state.mjs holds-preflight#1`, `${file} orchestrator:state.mjs holds-retire#1`);
  }
  // A skill names its root by placeholder (the Codex mirror of a command).
  named.push('plugins/engineer/core/skills/compose/SKILL.md engineer:peer-runner.mjs settle#1', 'plugins/orchestrator/core/skills/abort/SKILL.md orchestrator:state.mjs admission join#1');
  // The make and the release of a directory (ADR-0059 Decision 9): the
  // bootstrap's topic and operation directories, the finalize's release.
  for (const p of PERSONAS) {
    named.push(`plugins/${p}/commands/compose.md ${p}:state.mjs tmpdir-make#1`, `plugins/${p}/commands/compose.md ${p}:state.mjs tmpdir-release#1`);
  }
  deepStrictEqual(named.filter((id) => !checked.has(id)), []);
});

test('each contract is read whole: the subcommands the runbooks rely on, with flags', () => {
  for (const p of PLUGINS) {
    const { state, 'peer-runner': peer } = contracts[p];
    ok(state.subs.size >= 40, `${p} state.mjs: only ${state.subs.size} subcommands read`);
    for (const sub of ['find-active', 'read']) ok(state.subs.get(sub)?.accepted.has('repo-root') || state.subs.get(sub)?.accepted.has('workflow-path'), `${p} state.mjs ${sub}: no flag read`);
    // The orchestrator's runner settles nothing (its ensembles commit through state.mjs).
    const runnerSubs = ['cancel', 'new-run-id', 'run', ...(p === 'orchestrator' ? [] : ['settle']), 'status', 'sweep'];
    deepStrictEqual([...peer.subs.keys()].sort(), runnerSubs);
  }
});

// ── ADR-0059 Decision 10: the persona and orchestrator directories ──────────

const PATHS = JSON.parse(read('persona-pipeline/tmpdir-paths.json'));
// Each in a command's form and a skill's (the root spelled <plugin-root>), and
// the skill's form an orchestrator skill copies with its own root placeholder
// (<orchestrator-plugin-root>, beside the engineer's in next and done). An
// orchestrator file renders no region: it holds verbatim copies, which this
// identity check keeps equal to the snippets, so a snippet edit fails here
// until each copy follows.
const orchSkill = (name) => snippetText(name).replaceAll('<plugin-root>/', '<orchestrator-plugin-root>/');
const SNIPPETS = {
  make: [snippetText('tmpdir-make'), snippetText('tmpdir-make-skill'), orchSkill('tmpdir-make-skill')],
  release: [snippetText('tmpdir-release'), snippetText('tmpdir-release-skill'), orchSkill('tmpdir-release-skill')],
};
// The groups of rendered regions (`templates`), and of orchestrator files,
// each checked whole (`files`).
const TEMPLATE_GROUPS = PATHS.groups.filter((g) => g.templates !== undefined);
const FILE_GROUPS = PATHS.groups.filter((g) => g.files !== undefined);
const GROUPED = new Set(TEMPLATE_GROUPS.flatMap((g) => g.templates));
const GROUPED_FILES = FILE_GROUPS.flatMap((g) => g.files);
// The lines the list exempts from the make, by file and text: prose an owner
// follows outside any runbook block (the instruct note's directory).
const EXEMPT = new Set((PATHS.exempt ?? []).map((e) => `${e.file}\0${e.line}`));
// Each orchestrator file as it ships (commands, skills, references), its change log aside.
const orchestratorFiles = () => corpus().filter((f) => f.split('/')[1] === 'orchestrator' && !f.endsWith('CHANGELOG.md'));

// Each rendering of a template the list groups: [template, persona, region, text].
function renderings(templates) {
  const out = [];
  for (const region of MANIFEST.regions.filter((r) => templates.includes(r.template))) {
    for (const persona of region.personas) {
      const text = renderTemplate(read(`persona-pipeline/${region.template}`), {
        declaration: renderingDeclaration(declaration(persona)), substitutions: region.substitutions ?? {}, label: region.template,
      });
      out.push([region.template, persona, region, text]);
    }
  }
  return out;
}

// The text and operation directories made outside the make, per file: in a
// region template the list does not group, in a persona's authored text (its
// region bodies left out, which their templates answer for), and in an
// orchestrator file, read by `text` (as it ships unless a probe plants one).
function legacyMakes(text = read) {
  const found = new Set();
  const legacyIn = (text) => tmpdirLegacyLines(text, SNIPPETS).length > 0;
  for (const region of MANIFEST.regions) {
    if (!GROUPED.has(region.template) && legacyIn(read(`persona-pipeline/${region.template}`))) found.add(region.template);
  }
  for (const file of corpus().filter((f) => PERSONAS.includes(f.split('/')[1]))) {
    if (legacyIn(authoredText(file))) found.add(file);
  }
  for (const file of orchestratorLegacyMakes(orchestratorFiles(), text)) found.add(file);
  return [...found].sort();
}

// The orchestrator files of `files` that make a directory outside the make:
// each read whole (by `text`, the file as it ships unless a probe plants a
// defect), but for the lines the list exempts by identity (EXEMPT).
function orchestratorLegacyMakes(files, text = read) {
  const found = [];
  for (const file of files) {
    const lines = text(file).split('\n');
    if (tmpdirLegacyLines(text(file), SNIPPETS).some((n) => !EXEMPT.has(`${file}\0${lines[n - 1].trim()}`))) found.push(file);
  }
  return found;
}

// A persona file's authored text: its region bodies left out, which their
// templates answer for.
function authoredText(file) {
  const text = read(file);
  const parsed = parseRegions(text, file);
  return parsed.errors.length === 0 ? replaceRegionBodies(text, parsed.regions, Object.fromEntries(parsed.regions.map((r) => [r.id, '']))) : text;
}

test('each region the path list groups makes and releases what the list says, on the paths it says (ADR-0059 Decision 10)', () => {
  const problems = [];
  let seen = 0;
  for (const group of TEMPLATE_GROUPS) {
    const all = renderings(group.templates);
    ok(all.length > 0, `no region renders ${group.templates.join(', ')}`);
    for (const [template, persona, region, text] of all) {
      seen++;
      problems.push(...tmpdirProblems(text, group, { snippets: SNIPPETS, capabilities: declaration(persona).capabilities, label: `${persona} ${region.id} (${template})` }));
    }
  }
  deepStrictEqual(problems, []);
  ok(seen >= 40, `only ${seen} renderings checked`);
});

// An orchestrator file held to its group: whole, and strictly, since its
// blocks share the one directory its step 1 made (no placeholder is fresh).
const fileProblems = (group, file, text) => [
  ...tmpdirProblems(text, group, { snippets: SNIPPETS, label: file }),
  ...tmpdirOrderProblems(text, group, { label: file, strict: true }),
];

test('each orchestrator command and skill the path list groups makes and releases what the list says, after every block that reads it (ADR-0059 Decision 10)', () => {
  const problems = [];
  for (const group of FILE_GROUPS) {
    ok(group.files.length > 0, 'a files group names no file');
    for (const file of group.files) problems.push(...fileProblems(group, file, read(file)));
    // Each consumer, an optional one included, reads in one file of the group
    // at least: a pattern that matches nothing names no reader.
    for (const d of group.directories) {
      for (const c of d.consumers ?? []) {
        const re = new RegExp(group.blocks[c], 'm');
        if (!group.files.some((f) => fencedBlocks(read(f)).some((b) => SHELL_LANGS.has(b.lang) && re.test(b.lines.join('\n'))))) problems.push(`${group.files[0]}: consumer ${c} matches no block of the group's files`);
      }
    }
  }
  deepStrictEqual(problems, []);
  ok(GROUPED_FILES.length >= 10, `only ${GROUPED_FILES.length} orchestrator files grouped`);
});

test('the files-group check finds a defect planted in a real orchestrator runbook: a release before the write, a reader after the release', () => {
  const file = 'plugins/orchestrator/commands/plan.md';
  const group = FILE_GROUPS.find((g) => g.files.includes(file));
  const text = read(file);
  const write = 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \\';
  ok(text.includes(write) && text.includes('RELEASE_PATH="$TEXT_DIR"'), 'the probe finds its anchors');
  // The release moved before the ensemble commit, its last exit after it.
  const release = text.slice(text.indexOf('RELEASE_PATH="$TEXT_DIR"'), text.indexOf('```', text.indexOf('RELEASE_PATH="$TEXT_DIR"')));
  const early = text.replace(release, '').replace(write, `${release}${write}`);
  ok(fileProblems(group, file, early).some((p) => /before the block's last exit/.test(p)), 'a release before the write is refused');
  // A later block that takes the same step-1 directory reads a released one.
  const after = `${text}\n\`\`\`bash\nTEXT_DIR='<directory from step 1>'\ncat "$TEXT_DIR/note.md"\n\`\`\`\n`;
  ok(fileProblems(group, file, after).some((p) => /takes TEXT_DIR as '<directory from step 1>', the directory released there/.test(p)), 'a reader after the release is refused');
});

test("the files-group check finds a defect planted in /orchestrator:next: a trap release unguarded, one in Phase 3b's trap", () => {
  const file = 'plugins/orchestrator/commands/next.md';
  const group = FILE_GROUPS.find((g) => g.files.includes(file));
  const text = read(file);
  const { guard } = group.directories[0].release;
  ok(text.includes(guard), 'the probe finds the guard of the three results');
  // The release on every exit of Phase 5, whatever the three results.
  ok(fileProblems(group, file, text.replace(guard, 'if true; then')).some((p) => /writeback:TEXT_DIR:exit under if true; then on a path the path list keeps/.test(p)), 'an unguarded trap release is refused');
  // Phase 3b's trap releases too, whose rerun reads the directory.
  const trap = "  mark_kept\n}\ntrap 'release_admission' EXIT";
  ok(text.split(trap).length === 2, "the probe finds Phase 3b's trap");
  const release = snippetText('tmpdir-release').replace(/\n$/, '').split('\n').map((l) => `  ${l}`).join('\n');
  const early = text.replace(trap, `  mark_kept\n  RELEASE_PATH="$TEXT_DIR"\n${release}\n}\ntrap 'release_admission' EXIT`);
  ok(fileProblems(group, file, early).some((p) => /a releasing step switch:TEXT_DIR:exit on a path the path list keeps/.test(p)), "a release in Phase 3b's trap is refused");
});

// A test of its own, so the mutation that removes this refusal (C32 of
// runbook-cli-contracts) is scored by the case it removes, not by its file.
test("for /orchestrator:next's guarded trap release, a list that keeps it nowhere is refused", () => {
  const file = 'plugins/orchestrator/commands/next.md';
  const group = FILE_GROUPS.find((g) => g.files.includes(file));
  const text = read(file);
  const { guard } = group.directories[0].release;
  ok(text.includes(guard), 'the probe finds the guard of the three results');
  ok(fileProblems(group, file, text).every((p) => !/is released from an EXIT trap under/.test(p)), 'the list as declared, which keeps it on a path, passes this check');
  // The guarded release declared on a list that keeps the directory on no path.
  const releasing = { ...group, directories: [{ ...group.directories[0], paths: { 'every exit': 'release' } }] };
  ok(fileProblems(releasing, file, text).some((p) => /is released from an EXIT trap under .*, and the path list does not both keep it/.test(p)), 'a list that keeps it nowhere is refused');
});

// A release on the success path holds only when each write before it stops
// the block on failure: the last-exit rule alone passes a write whose stop was
// removed, since the block's last exit is then an earlier one (C36 of
// runbook-cli-contracts).
test('a release after a write whose failure nothing reads is refused: checkpoint-set, the peer-now note, the plan writes', () => {
  const planted = [
    ['plugins/orchestrator/commands/checkpoint.md', '--summary-file "$TEXT_DIR/summary.txt" || exit $?', '--summary-file "$TEXT_DIR/summary.txt"'],
    ['plugins/orchestrator/commands/peer-now.md', '--event updated || exit $?', '--event updated'],
    ['plugins/orchestrator/commands/plan.md', '--event updated --require-open --run-id "$RUN_ID" || exit 1', '--event updated --require-open --run-id "$RUN_ID"'],
    ['plugins/orchestrator/commands/plan.md', '--completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit 1', '--completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"'],
  ];
  for (const [file, from, to] of planted) {
    const group = FILE_GROUPS.find((g) => g.files.includes(file));
    const text = read(file);
    deepStrictEqual(text.split(from).length, 2, `${file}: the probe finds "${from}" once`);
    ok(fileProblems(group, file, text).every((p) => !/whose failure nothing reads/.test(p)), `${file}: the file as it ships passes this rule`);
    ok(fileProblems(group, file, text.replace(from, to)).some((p) => /whose failure nothing reads/.test(p)), `${file}: "${to}" with its stop removed is refused`);
  }
  // What reads a failure, and what does not, in one synthetic block each.
  const group = {
    blocks: { main: '^node .* write' },
    directories: [{ variable: 'TEXT_DIR', made: 'step', consumers: ['main'], release: { block: 'main', at: 'end' } }],
  };
  const step = ['```bash', "MAKE_KIND='text'", ...SNIPPETS.make[0].split('\n'), "printf '%s\\n' \"$MADE_DIR\"", '```'].join('\n');
  const main = (body) => [step, '```bash', "TEXT_DIR='<directory from step 1>'", 'ROOT_OVERRIDE=x', ...body, 'RELEASE_PATH="$TEXT_DIR"', ...SNIPPETS.release[0].split('\n'), '```'].join('\n');
  const w = 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" write --file "$TEXT_DIR/a"';
  const unread = (body) => tmpdirProblems(main(body), group, { snippets: SNIPPETS, label: 'x' }).filter((p) => /whose failure nothing reads/.test(p));
  for (const body of [[`${w} || exit $?`], [`${w} \\`, '  || { echo no >&2; exit 1; }'], ['RC=1', `${w} && RC=0`, '[ "$RC" -eq 0 ] || exit 1'], [w, 'RC=$?', '[ "$RC" -eq 0 ] || exit "$RC"'], [`if ! ${w}; then`, '  exit 1', 'fi'], [`OUT="$(${w})" || exit 1`], [`${w} 2>&1 || exit $?`], [`${w} --host <claude|codex> || exit $?`], [`${w} && echo written || exit 1`], ["printf '%s\\n' node installed"]]) {
    deepStrictEqual(unread(body), [], `read: ${body.join(' / ')}`);
  }
  // A handler that only logs, and a pipeline whose status is another
  // command's, let the block go on to the release.
  for (const body of [[w], [`${w} | cat`], [`${w} | cat || exit $?`], [`${w} && echo written`], [`${w} # || exit 1`], [`${w}; echo '|| exit 1'`], [`${w} || echo failed >&2`], [`${w} || { echo 'exit 1' >&2; }`], [`${w} &`]]) {
    deepStrictEqual(unread(body).length, 1, `not read: ${body.join(' / ')}`);
  }
});

test('each orchestrator file that makes or releases a directory through the snippets is in a files group, once', () => {
  const found = orchestratorFiles().filter((f) => /\btmpdir-(?:make|release)\b/.test(read(f))).sort();
  deepStrictEqual(found, [...GROUPED_FILES].sort());
  deepStrictEqual(GROUPED_FILES.filter((f, i) => GROUPED_FILES.indexOf(f) !== i), []);
});

test('in each persona runbook, a directory is released only after every block that reads it', () => {
  const problems = [];
  for (const group of TEMPLATE_GROUPS) {
    const dests = new Set(MANIFEST.regions.filter((r) => group.templates.includes(r.template)).flatMap((r) => r.personas.map((p) => `plugins/${p}/${r.dest}`)));
    for (const file of dests) {
      problems.push(...tmpdirOrderProblems(read(file), group, { capabilities: declaration(file.split('/')[1]).capabilities, label: file }));
    }
  }
  deepStrictEqual(problems, []);
});

test('no persona region or authored text makes a directory outside the make, except what the list keeps pending', () => {
  deepStrictEqual(legacyMakes(), [...PATHS.pending].sort());
});

// With `pending` empty, the scan above passes on no orchestrator file found
// as well as on every file clean: this probe plants a make in a real
// orchestrator command, so a scan that reads nothing fails here (C30 of
// runbook-cli-contracts).
test('the orchestrator scan finds a make planted outside the snippet, and the exempt line only where the list keeps it', () => {
  const file = 'plugins/orchestrator/commands/checkpoint.md';
  const exempt = (PATHS.exempt ?? [])[0];
  ok(exempt !== undefined, 'no exemption read');
  const files = [file, exempt.file];
  deepStrictEqual(orchestratorLegacyMakes(files), [], 'the files as they ship make nothing outside the snippet');
  const anchor = "TEXT_DIR='<directory from step 1>'\n";
  ok(read(file).includes(anchor), 'the probe finds its anchor');
  const planted = (line) => (f) => (f === file ? read(file).replace(anchor, `${anchor}${line}\n`) : read(f));
  const raw = planted('D="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")"');
  deepStrictEqual(orchestratorLegacyMakes(files, raw), [file], 'a raw make in a block is found');
  // Through the corpus scan the gate runs, too: the file is found beside what
  // the list keeps pending.
  deepStrictEqual(legacyMakes(raw), [...PATHS.pending, file].sort(), 'the gate\'s scan finds the planted make');
  deepStrictEqual(orchestratorLegacyMakes(files, planted(exempt.line)), [file], 'the exempt line, in another file, is no exemption');
});

test('each line the path list exempts from the make is found exactly once, where it says, and says why', () => {
  for (const e of PATHS.exempt ?? []) {
    const lines = read(e.file).split('\n');
    const at = tmpdirLegacyLines(read(e.file), SNIPPETS).filter((n) => lines[n - 1].trim() === e.line);
    deepStrictEqual(at.length, 1, `${e.file}: "${e.line}" is a make line ${at.length} times`);
    ok(typeof e.why === 'string' && e.why.length > 20, `${e.file}: no reason`);
  }
  // A make line elsewhere in the same file is no exemption.
  const e = (PATHS.exempt ?? [])[0];
  ok(e !== undefined, 'no exemption read');
  ok(!EXEMPT.has(`${e.file}\0mktemp -d "\${TMPDIR:-/tmp}/agentic-text.XXXXXX"`));
});

test('each persona file whose authored text tells the agent to make a directory is in the path list, with the step that releases it', () => {
  const found = corpus().filter((f) => PERSONAS.includes(f.split('/')[1]) && /\btmpdir-make\b/.test(authoredText(f))).sort();
  deepStrictEqual(found, PATHS.authored.map((a) => a.file).sort());
  for (const a of PATHS.authored) {
    // The releasing step: a region the file renders (region:<id>), or the
    // authored sentence that tells the agent to release.
    const region = /^region:(.+)$/.exec(a.released_by)?.[1];
    if (region) ok(read(a.file).includes(`<!-- pipeline:begin ${region} -->`), `${a.file}: no region ${region}`);
    else ok(authoredText(a.file).includes(a.released_by), `${a.file}: no authored "${a.released_by}"`);
  }
});

// Each persona and orchestrator file as it ships (commands, skills,
// references), its change log aside.
const personaFiles = () => corpus().filter((f) => [...PERSONAS, 'orchestrator'].includes(f.split('/')[1]) && !f.endsWith('CHANGELOG.md'));

test('no persona or orchestrator text tells the agent to release a directory by hand: a release is a block of the runbook (ADR-0059 Decision 10, item 2)', () => {
  const found = personaFiles().flatMap((f) => tmpdirHandReleaseLines(read(f), SNIPPETS).map((l) => `${f}:${l}`));
  deepStrictEqual(found, []);
});

test('no persona or orchestrator shell block calls tmpdir-make or tmpdir-release but through the snippets, grouped or not', () => {
  const found = [];
  for (const f of personaFiles()) {
    for (const b of fencedBlocks(read(f)).filter((x) => SHELL_LANGS.has(x.lang))) {
      for (const p of tmpdirBlockReads(b.lines.join('\n'), SNIPPETS).problems) if (/outside the make and release snippets/.test(p)) found.push(`${f} block at line ${b.start}: ${p}`);
    }
  }
  deepStrictEqual(found, []);
});

test('each region template that makes, releases or names a directory\'s CLI is in the path list', () => {
  const ungrouped = MANIFEST.regions.map((r) => r.template)
    .filter((t, i, all) => all.indexOf(t) === i && /\btmpdir-(?:make|release)\b|\{\{> tmpdir-/.test(read(`persona-pipeline/${t}`)) && !GROUPED.has(t));
  deepStrictEqual(ungrouped, []);
});

test('each directory of the path list declares its paths, releasing on one at least exactly when it names a release', () => {
  const problems = [];
  for (const group of PATHS.groups) {
    for (const d of group.directories) {
      const values = Object.values(d.paths ?? {});
      const where = `${(group.templates ?? group.files).join(', ')} ${d.variable}`;
      if (values.length === 0) { problems.push(`${where}: no paths`); continue; }
      for (const v of values) if (!/^(release|keep)(: .+)?$/s.test(v) || /^keep$/.test(v)) problems.push(`${where}: "${v}" is neither release nor keep: <reason>`);
      if (Boolean(d.release) !== values.some((v) => v.startsWith('release'))) problems.push(`${where}: its release and its paths disagree`);
    }
  }
  deepStrictEqual(problems, []);
});

test('the path list check refuses what it is for: a raw make, a release too early, of a value read, on a kept path, on the wrong branch, of another block\'s line', () => {
  const group = {
    blocks: { main: '^node .* write' },
    directories: [{ variable: 'TEXT_DIR', made: 'step', consumers: ['main'], release: { block: 'main', at: 'end' } }],
  };
  const step = ['```bash', "MAKE_KIND='text'", ...SNIPPETS.make[0].split('\n'), "printf '%s\\n' \"$MADE_DIR\"", '```'].join('\n');
  const rel = (v) => [`RELEASE_PATH="$${v}"`, ...SNIPPETS.release[0].split('\n')];
  const main = (body) => ['```bash', "TEXT_DIR='<directory from step 1>'", 'ROOT_OVERRIDE=x', ...body, '```'].join('\n');
  const write = 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" write --file "$TEXT_DIR/a" || exit $?';
  const check = (text) => tmpdirProblems(text, group, { snippets: SNIPPETS, label: 'x' });
  deepStrictEqual(check(`${step}\n${main([write, ...rel('TEXT_DIR')])}`), []);
  const cases = [
    ['a raw make', `${step}\n${main(['D="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")"', write, ...rel('TEXT_DIR')])}`, /makes a directory outside the make/],
    ['prose telling the agent to make one', `1. Create one: \`mktemp -d "\${TMPDIR:-/tmp}/agentic-text.XXXXXX"\`\n${step}\n${main([write, ...rel('TEXT_DIR')])}`, /line 1 makes a directory outside the make, or tells the agent to/],
    ['a raw nested op', `${step}\n${main(['mkdir -m 700 "$TEXT_DIR/op"', write, ...rel('TEXT_DIR')])}`, /makes a directory outside the make/],
    ['a release before a later read', `${step}\n${main([write, ...rel('TEXT_DIR'), 'cat "$TEXT_DIR/a"'])}`, /TEXT_DIR is used at line \d+, after its release/],
    ['a release before the last exit', `${step}\n${main([...rel('TEXT_DIR'), write])}`, /before the block's last exit/],
    ['a release on the failing branch', `${step}\n${main(['if ! node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" write; then', ...rel('TEXT_DIR').map((l) => `  ${l}`), '  exit 1', 'fi'])}`, /before the block's last exit/],
    ['a release of a value read', `${step}\n${main([write, 'OTHER="$(cat "$TEXT_DIR/dir")"', ...rel('OTHER')])}`, /given OTHER, which is neither a line at the head of the block nor the variable a make in it printed to/],
    ['a release on a path the list keeps', `${step}\n${main([write, ...rel('TEXT_DIR')])}`, /a releasing step main:TEXT_DIR:end on a path the path list keeps/, { ...group, directories: [{ ...group.directories[0], release: undefined }] }],
    ['a release the list declares and no step makes', `${step}\n${main([write])}`, /releases main:TEXT_DIR:end, and no releasing step does/],
    ['another command\'s line', `${step}\n${main([write, 'ORCH_TEXT_DIR="$TEXT_DIR"', ...rel('ORCH_TEXT_DIR')])}`, /given ORCH_TEXT_DIR/],
    ['a release under the inverted guard', `${step}\n${main([write, 'if [ -n "$T" ]; then', ...rel('TEXT_DIR').map((l) => `  ${l}`), 'fi'])}`, /a releasing step main:TEXT_DIR:end under if \[ -n "\$T" \]; then on a path the path list keeps/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'end', guard: 'if [ -z "$T" ]; then' } }] }],
    ['a release of a line given another value', `${step}\n${main([write, 'TEXT_DIR="$OP_DIR"', ...rel('TEXT_DIR')])}`, /TEXT_DIR, which line \d+ assigns another value/],
    ['a make spelled --directory', `${step}\n${main(['D="$(mktemp --directory)"', write, ...rel('TEXT_DIR')])}`, /makes a directory outside the make/],
    ['a second step make', `${step}\n${step}\n${main([write, ...rel('TEXT_DIR')])}`, /2 step makes print a directory, and the path list holds 1/],
    ['a release in a function no trap runs', `${step}\n${main(['f() {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', write])}`, /which no EXIT trap of the block runs/],
    // The plan-verify review of 2026-11-27: the other branch of the declared
    // guard, a case arm, a brace group, and an alias read after the release.
    ['a release in the else of the declared guard', `${step}\n${main([write, 'if [ -z "$T" ]; then', '  :', 'else', ...rel('TEXT_DIR').map((l) => `  ${l}`), 'fi'])}`, /main:TEXT_DIR:end under else of if \[ -z "\$T" \]; then on a path the path list keeps/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'end', guard: 'if [ -z "$T" ]; then' } }] }],
    ['a release in a case arm', `${step}\n${main([write, 'case "$T" in', '  never)', ...rel('TEXT_DIR').map((l) => `    ${l}`), '    ;;', 'esac'])}`, /inside a case arm, a while loop or a brace group/],
    ['a release in a brace group', `${step}\n${main([write, '[ -n "$T" ] && {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}'])}`, /inside a case arm, a while loop or a brace group/],
    ['an alias read after the release', `${step}\n${main(['ALIAS="$TEXT_DIR"', write, ...rel('TEXT_DIR'), 'cat "$ALIAS/a"'])}`, /ALIAS, assigned from TEXT_DIR, is used at line \d+, after its release/],
    // The critique of 2026-11-27: a raw call of either subcommand and a
    // snippet copy one edit away are no make or release; a failing-exit guard
    // closed before the release guards nothing; the paths agree with `at`.
    ['a raw release', `${step}\n${main([write, 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$TEXT_DIR"'])}`, /names tmpdir-make or tmpdir-release outside the make and release snippets/, { ...group, directories: [{ ...group.directories[0], release: undefined }] }],
    ['a raw make', `${main(['D="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op)"', write])}`, /names tmpdir-make or tmpdir-release outside the make and release snippets/, { ...group, directories: [] }],
    ['a release snippet copy with one edit', `${step}\n${main([write, 'RELEASE_PATH="$TEXT_DIR"', ...SNIPPETS.release[0].replace('|| :', '|| true').split('\n')])}`, /names tmpdir-make or tmpdir-release outside the make and release snippets/],
    ['a failing-exit guard closed before the release', `${step}\n${main(['OWN_RC=0', 'f() {', '  OWN_RC=$?', '  if [ "$OWN_RC" -ne 0 ]; then', '    :', '  fi', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', 'trap f EXIT', write])}`, /a releasing step main:TEXT_DIR:exit on a path the path list keeps/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'exit-failed' }, paths: { 'fails': 'release', 'succeeds': 'keep: x' } }] }],
    ['a release on every exit the paths keep somewhere', `${step}\n${main(['f() {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', 'trap f EXIT', write])}`, /released on every exit, and the path list keeps it on a path/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'exit' }, paths: { 'any exit': 'release', 'a rerun': 'keep: x' } }] }],
    ['an end release whose paths keep it nowhere', `${step}\n${main([write, ...rel('TEXT_DIR')])}`, /released on the success path only, and the path list keeps it on no path/, { ...group, directories: [{ ...group.directories[0], paths: { 'success': 'release', 'a refusal': 'release' } }] }],
    // The orchestrator slice of 2026-11-27: a later EXIT trap replaces the one
    // a release runs from; a release site found twice is refused, not
    // collapsed; a head line read after the root line is no line the agent
    // fills.
    ['an EXIT trap replaced after the releasing one', `${step}\n${main(['f() {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', 'trap f EXIT', write, "trap 'other' EXIT"])}`, /the EXIT trap that runs f\(\) \(line \d+\) is replaced at line \d+/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'exit' }, paths: { 'any exit': 'release' } }] }],
    ['a release site found twice', `${step}\n${main([write, ...rel('TEXT_DIR'), ...rel('TEXT_DIR')])}`, /the releasing step main:TEXT_DIR:end is found 2 times/],
    ['an EXIT trap replaced by signal 0', `${step}\n${main(['f() {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', 'trap f EXIT', write, 'trap : 0'])}`, /the EXIT trap that runs f\(\) \(line \d+\) is replaced at line \d+/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'exit' }, paths: { 'any exit': 'release' } }] }],
    ['a releasing trap registered only inside a function', `${step}\n${main(['f() {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', 'g() {', 'trap f EXIT', '}', write])}`, /which no EXIT trap of the block runs/, { ...group, directories: [{ ...group.directories[0], release: { block: 'main', at: 'exit' }, paths: { 'any exit': 'release' } }] }],
    ['a head line after the root line', `${step}\n${['```bash', 'CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"', "TEXT_DIR='<directory from step 1>'", write, ...rel('TEXT_DIR'), '```'].join('\n')}`, /given TEXT_DIR, which is neither a line at the head of the block/],
  ];
  // A case arm's `fi;;` closes its if: a release after the case is not inside it.
  const armed = `${step}\n${main([write, 'case "$V" in', '  a) ;;', '  b)', '    if [ -n "$W" ]; then', '      exit 1', '    fi;;', 'esac', ...rel('TEXT_DIR')])}`;
  deepStrictEqual(tmpdirProblems(armed, group, { snippets: SNIPPETS, label: 'x' }), []);
  // `trap -p EXIT` prints the trap and replaces nothing.
  const printed = `${step}\n${main(['f() {', ...rel('TEXT_DIR').map((l) => `  ${l}`), '}', 'trap f EXIT', write, 'trap -p EXIT'])}`;
  deepStrictEqual(tmpdirProblems(printed, group, { snippets: SNIPPETS, label: 'x' }).filter((p) => /is replaced/.test(p)), []);
  for (const [what, text, re, g = group] of cases) {
    const problems = tmpdirProblems(text, g, { snippets: SNIPPETS, label: 'x' });
    ok(problems.some((p) => re.test(p)), `${what}: ${JSON.stringify(problems)}`);
  }
  // Across blocks: a release in a block before one that reads the directory.
  const order = { blocks: { a: '^A$', b: '^B$' }, directories: [{ variable: 'X', consumers: ['b'], release: { block: 'a', at: 'end' } }] };
  deepStrictEqual(tmpdirOrderProblems('```bash\nA\n```\n```bash\nB\n```\n', order, {}), ['runbook: X is released in the a block before the b block reads it']);
  deepStrictEqual(tmpdirOrderProblems('```bash\nB\n```\n```bash\nA\n```\n', order, {}), []);
  // A reader the list does not name: a later block that uses the released
  // variable with no line of its own (the peer's probe of 2026-11-27), or one
  // whose line names the same, non-fresh directory; a block of its own
  // directory, or one the list runs instead of the releasing block, is no reader.
  const later = { blocks: { a: '^A$' }, directories: [{ variable: 'X', consumers: [], release: { block: 'a', at: 'end' } }] };
  const rel2 = "```bash\nX='<the directory the dispatch ran with>'\nA\n```\n";
  deepStrictEqual(tmpdirOrderProblems(`${rel2}\`\`\`bash\ncat "$X/note.md"\n\`\`\`\n`, later, {}), ['runbook: a block after the a block uses X, which it neither takes on a line of its own nor makes: the directory released there']);
  deepStrictEqual(tmpdirOrderProblems(`${rel2}\`\`\`bash\nX='<the directory the dispatch ran with>'\ncat "$X/note.md"\n\`\`\`\n`, later, {}), ["runbook: a block after the a block takes X as '<the directory the dispatch ran with>', the directory released there"]);
  deepStrictEqual(tmpdirOrderProblems(`${rel2}\`\`\`bash\nX='<directory from step 1>'\ncat "$X/note.md"\n\`\`\`\n`, later, {}), []);
  deepStrictEqual(tmpdirOrderProblems(`${rel2}\`\`\`bash\n# the release of "$X" ran above\ntrue\n\`\`\`\n`, later, {}), []);
  const instead = { blocks: { a: '^A$', b: '^B$' }, directories: [{ variable: 'X', consumers: [], release: { block: 'a', at: 'end' }, instead_of: ['b'] }] };
  deepStrictEqual(tmpdirOrderProblems(`${rel2}\`\`\`bash\nX='<the directory the dispatch ran with>'\nB\n\`\`\`\n`, instead, {}), []);
  // No prose release, and the release snippet's own lines are no prose.
  deepStrictEqual(tmpdirHandReleaseLines('Then release it with `state.mjs tmpdir-release --path <it>`.\n', SNIPPETS), [1]);
  deepStrictEqual(tmpdirHandReleaseLines(rel('X').join('\n'), SNIPPETS), []);
});
