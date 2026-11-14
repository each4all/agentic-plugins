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

import { cliCallProblems, cliInvocations, cliUnscannedCalls, peerRunnerContract, stateCliContract } from '../_runbook-checks.mjs';
import { readWord, stripComments, words } from '../persona-pipeline/_verb-runbooks.mjs';

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
