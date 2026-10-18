// The orchestrator commands' argument grammars (ADR-0059, C134(a)).
//
// /orchestrator:next, done, abort, finalize, approve and resume used to have
// the model parse the command's argument text and type the pieces into shell
// variables (EXPLICIT_SUBTASK_ID, EXPLICIT_WORKFLOW_ID, …), so a quote, `$` or
// backquote the user typed became shell source. This module is the receiver
// that replaces that step: the model writes the argument text into an args
// file with its file-writing tool, `state.mjs command-args` reads it with the
// shared codec (args-file.mjs, used unchanged: its bytes are pinned equal
// across packages) and prints the fields below as one JSON object. The codec
// removes the args file it read, so a runbook keeps the JSON, not the args
// file, for its later blocks to reload.
//
// One grammar serves every command. A word is a maximal run of anything but
// space, tab, CR and LF (args-file.mjs's separators):
//
//   - a word starting with `--` is an option. A value option is written
//     `--name=<value>`, with a non-empty value that does not start with `-`;
//     a switch is written `--name` alone. An option given twice, an unknown
//     option, a bare value option and a switch given a value are refused;
//   - any other word is positional: the subtask id for next and done, the
//     `archive [<workflow-id>]` words for resume;
//   - an option or positional word holding a quote or backslash is refused:
//     values are bare, and quoting them would only keep the quotes;
//   - only done takes free text, the reason: it starts at the first word after
//     the subtask id that is not an option, or after a lone `--`, and runs to
//     the end of the text byte for byte. A word of the reason that names one of
//     done's options is refused, unless `--` opened the reason: written after
//     the reason began, the option would otherwise be read as reason text.
//
// The values are carried as written. Each consumer judges its own:
// resolve-workflow the workflow id, landing.mjs the pull request and the
// commit, git the branch, read-subtask the subtask id.

import { ArgsFileError, readArgsFile } from './args-file.mjs';

export const COMMAND_ARGS_VERSION = 1;

const refuse = (message) => {
  throw new ArgsFileError(`arguments: ${message}`);
};

// As args-file.mjs shows text in a message: a control character or line
// separator is shown as its code point, so it cannot forge or erase a line.
const UNSAFE_IN_MESSAGE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const shown = (text) => String(text).replace(UNSAFE_IN_MESSAGE,
  (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);

const WORKFLOW = { name: 'workflow', field: 'workflow_id', kind: 'value' };

// Each command: its options (the field each fills, value or switch), whether
// it takes a subtask id ('none', 'optional', 'required'), whether it takes a
// reason, and its usage line. resume has a grammar of its own words.
export const COMMAND_GRAMMARS = Object.freeze({
  next: {
    usage: '/orchestrator:next [<subtask-id>] [--workflow=<id>]',
    subtask: 'optional',
    options: [WORKFLOW],
  },
  done: {
    usage:
      '/orchestrator:done <subtask-id> [--pr=<n>] [--commit=<sha>] [--correct] [--no-commit] ' +
      '[--waive-dispatch] [--workflow=<id>] [--integration-branch=<branch>] [<reason>]',
    subtask: 'required',
    reason: true,
    options: [
      { name: 'pr', field: 'pr', kind: 'value' },
      { name: 'commit', field: 'commit', kind: 'value' },
      { name: 'correct', field: 'correct', kind: 'switch' },
      { name: 'no-commit', field: 'no_commit', kind: 'switch' },
      { name: 'waive-dispatch', field: 'waive_dispatch', kind: 'switch' },
      WORKFLOW,
      { name: 'integration-branch', field: 'integration_branch', kind: 'value' },
    ],
  },
  abort: { usage: '/orchestrator:abort [--workflow=<id>]', subtask: 'none', options: [WORKFLOW] },
  finalize: { usage: '/orchestrator:finalize [--workflow=<id>]', subtask: 'none', options: [WORKFLOW] },
  approve: { usage: '/orchestrator:approve [--workflow=<id>]', subtask: 'none', options: [WORKFLOW] },
  resume: { usage: '/orchestrator:resume [archive [<workflow-id>]]', subtask: 'none', options: [] },
});

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMAND_GRAMMARS));

const WORD = /[^ \t\r\n]+/g;

// The fields a command's JSON carries, every one present: '' for a value not
// given, false for a switch not given.
function emptyFields(command, grammar) {
  const fields = { agentic_command_args: COMMAND_ARGS_VERSION, command };
  if (command === 'resume') {
    fields.mode = 'resume';
    fields.workflow_id = '';
    return fields;
  }
  if (grammar.subtask !== 'none') fields.subtask_id = '';
  for (const option of grammar.options) fields[option.field] = option.kind === 'switch' ? false : '';
  if (grammar.reason) fields.reason = '';
  return fields;
}

const bareWord = (word, what) => {
  if (/["'\\]/.test(word)) refuse(`${what} ${shown(word)} holds a quote or backslash; write it bare`);
};

function parseResume(words, fields, grammar) {
  if (words.length === 0) return fields;
  const [first, second, ...more] = words.map((w) => w.text);
  if (first !== 'archive') refuse(`${shown(first)} is not a resume mode. Usage: ${grammar.usage}`);
  fields.mode = 'archive';
  if (second === undefined) return fields;
  if (second.startsWith('-')) refuse(`resume takes no options (got ${shown(second)}). Usage: ${grammar.usage}`);
  bareWord(second, 'the workflow id');
  if (more.length > 0) refuse(`resume archive takes one workflow id; ${shown(more[0])} follows it. Usage: ${grammar.usage}`);
  fields.workflow_id = second;
  return fields;
}

/**
 * The fields `text` (the argument text, exactly as typed) gives `command`,
 * one of COMMAND_NAMES. Throws ArgsFileError, naming the arguments, on text
 * the grammar refuses.
 */
export function parseCommandArguments(command, text) {
  if (!Object.hasOwn(COMMAND_GRAMMARS, command)) {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected one of ${COMMAND_NAMES.join(', ')}`);
  }
  if (typeof text !== 'string') throw new TypeError('parseCommandArguments expects the argument text as a string');
  const grammar = COMMAND_GRAMMARS[command];
  const fields = emptyFields(command, grammar);
  const words = [...text.matchAll(WORD)].map((m) => ({ start: m.index, text: m[0] }));
  if (command === 'resume') return parseResume(words, fields, grammar);

  const byName = new Map(grammar.options.map((option) => [option.name, option]));
  const given = new Set();
  let subtaskSeen = false;
  for (let k = 0; k < words.length; k += 1) {
    const word = words[k].text;
    if (word === '--') {
      if (!grammar.reason) refuse(`${command} takes no free text after '--'. Usage: ${grammar.usage}`);
      if (grammar.subtask === 'required' && !subtaskSeen) refuse(`the subtask id comes before '--'. Usage: ${grammar.usage}`);
      const next = words[k + 1];
      fields.reason = next ? text.slice(next.start) : '';
      break;
    }
    if (word.startsWith('--')) {
      bareWord(word, 'the option');
      const eq = word.indexOf('=');
      const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
      const option = byName.get(name);
      if (!option) {
        const known = grammar.options.map((o) => (o.kind === 'switch' ? `--${o.name}` : `--${o.name}=<…>`));
        refuse(`unknown option ${shown(word)}; ${command} takes ${known.length ? known.join(', ') : 'none'}. Usage: ${grammar.usage}`);
      }
      if (given.has(name)) refuse(`--${name} is given more than once`);
      given.add(name);
      if (option.kind === 'switch') {
        if (eq >= 0) refuse(`--${name} takes no value (got ${shown(word)})`);
        fields[option.field] = true;
        continue;
      }
      if (eq < 0) refuse(`write --${name}=<value>; --${name} needs its value after '='`);
      const value = word.slice(eq + 1);
      if (value === '') refuse(`--${name}= needs a value`);
      if (value.startsWith('-')) refuse(`the --${name} value ${shown(value)} starts with '-'`);
      fields[option.field] = value;
      continue;
    }
    if (word.startsWith('-')) refuse(`unknown option ${shown(word)}; options are written --name. Usage: ${grammar.usage}`);
    if (grammar.subtask !== 'none' && !subtaskSeen) {
      bareWord(word, 'the subtask id');
      fields.subtask_id = word;
      subtaskSeen = true;
      continue;
    }
    if (!grammar.reason) {
      refuse(
        grammar.subtask === 'none'
          ? `${command} takes no positional argument (got ${shown(word)}). Usage: ${grammar.usage}`
          : `${command} takes one subtask id; ${shown(word)} follows it. Usage: ${grammar.usage}`,
      );
    }
    // The reason: this word to the end of the text, byte for byte. An option
    // of this command inside it was most likely meant as an option.
    for (const later of words.slice(k)) {
      const name = later.text.startsWith('--') ? later.text.slice(2).split('=')[0] : null;
      if (name !== null && byName.has(name)) {
        refuse(`the option ${shown(later.text)} comes after the reason began; put options before the reason, or write '--' before a reason that names one`);
      }
    }
    fields.reason = text.slice(words[k].start);
    break;
  }
  if (grammar.subtask === 'required' && !subtaskSeen) refuse(`${command} needs a subtask id. Usage: ${grammar.usage}`);
  // done: --no-commit records a subtask that landed no commit, so it excludes
  // the options that name or replace one.
  if (fields.no_commit === true) {
    const clash = ['pr', 'commit', 'correct'].filter((name) => given.has(name));
    if (clash.length > 0) refuse(`--no-commit excludes ${clash.map((n) => `--${n}`).join(', ')}`);
  }
  return fields;
}

/** The fields of the args file at `path` for `command`; the codec removes a file the runbook's mktemp step made. */
export function readCommandArguments(command, path, { read = readArgsFile } = {}) {
  if (!Object.hasOwn(COMMAND_GRAMMARS, command)) {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected one of ${COMMAND_NAMES.join(', ')}`);
  }
  return parseCommandArguments(command, read(path));
}
