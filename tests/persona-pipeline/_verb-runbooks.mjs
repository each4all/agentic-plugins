// What a verb runbook does, read from its text (PC2a2 T0): the ordered script
// calls of its shell blocks with their argument values by flag, its guards,
// and the phase-note scaffold its finalize step writes. The characterization
// test compares this reading with fixtures/verb-runbooks.json, written from
// the runbooks as they stood before their blocks became generated regions, so
// a region that changes what a runbook does fails unless the change is listed.
//
// Values are read as the shell reads them, so a quoting change alone is not a
// difference: a single-quoted literal and an unquoted word read the same, and
// `${NAME}` inside double quotes expands to a literal assigned earlier in the
// same block (`NAME='compose'`).

import { strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, pluginRoot } from './_personas.mjs';

export const VERB_RUNBOOK_PERSONAS = Object.freeze(['designer', 'founder']);
export const VERB_RUNBOOK_VERBS = Object.freeze(['compose', 'decide', 'frame', 'investigate']);
export const FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/persona-pipeline/fixtures/verb-runbooks.json'), 'utf8'));

/** The fenced shell blocks of a runbook, de-indented to their fence, in order. */
export function shellBlocks(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)```(bash|sh|zsh|shell)\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let e = i + 1;
    while (e < lines.length && lines[e].trim() !== '```') e++;
    out.push({ line: i + 1, text: lines.slice(i + 1, e).map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join('\n') });
    i = e;
  }
  return out;
}

/**
 * The block with its comments removed (each comment's text, not its line
 * end), read with the shell's quoting: `'…'`, `"…"`, `$(…)` nested in either,
 * parentheses, a backslash escape, and heredoc bodies (kept verbatim). A
 * commented-out command is then no call, and a `#` inside a quoted note is no
 * comment.
 */
export function stripComments(s) {
  let out = '';
  const stack = [{ kind: 'code', depth: 0 }];
  const heredocs = [];
  let wordStart = true;
  let i = 0;
  while (i < s.length) {
    const top = stack[stack.length - 1];
    const c = s[i];
    if (top.kind === 'single') {
      out += c;
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (top.kind === 'double') {
      if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
      if (c === '"') { stack.pop(); out += c; i++; continue; }
      if (c === '$' && s[i + 1] === '(') { stack.push({ kind: 'subst', depth: 0 }); out += '$('; i += 2; wordStart = true; continue; }
      out += c;
      i++;
      continue;
    }
    // code or subst
    if (c === '\n') {
      out += c;
      i++;
      wordStart = true;
      while (heredocs.length > 0 && stack.length === 1) {
        const delim = heredocs.shift();
        while (i < s.length) {
          const e = s.indexOf('\n', i);
          const line = e === -1 ? s.slice(i) : s.slice(i, e);
          out += e === -1 ? line : `${line}\n`;
          i = e === -1 ? s.length : e + 1;
          if (line.replace(/^\t+/, '') === delim) break;
        }
      }
      continue;
    }
    if (c === '#' && wordStart) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; wordStart = false; continue; }
    if (c === "'") { stack.push({ kind: 'single' }); out += c; i++; wordStart = false; continue; }
    if (c === '"') { stack.push({ kind: 'double' }); out += c; i++; wordStart = false; continue; }
    if (c === '$' && s[i + 1] === '(') { stack.push({ kind: 'subst', depth: 0 }); out += '$('; i += 2; wordStart = true; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const h = /^<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.-]+))/.exec(s.slice(i));
      if (h) {
        heredocs.push(h[1] ?? h[2] ?? h[3]);
        out += h[0];
        i += h[0].length;
        wordStart = false;
        continue;
      }
    }
    if (c === '(') top.depth++;
    if (c === ')') {
      if (top.depth > 0) top.depth--;
      else if (top.kind === 'subst') stack.pop();
    }
    out += c;
    i++;
    wordStart = /[\s;&|()]/.test(c);
  }
  return out;
}

/**
 * Split shell words from `s` starting at `i`, stopping at an unquoted line
 * end, `)`, `>`, `<`, `|`, `;`, `&`, a comment or the end. Each word keeps its
 * raw text; quotes are resolved by readWord().
 */
function words(s, i = 0) {
  const out = [];
  let cur = '';
  let depth = 0; // $( … ) nesting outside quotes
  const flush = () => { if (cur !== '') out.push(cur); cur = ''; };
  while (i < s.length) {
    const c = s[i];
    if (depth === 0 && c === '\n') break;
    if (depth === 0 && /\s/.test(c)) { flush(); i++; continue; }
    if (depth === 0 && /[)><|;&]/.test(c)) break;
    if (depth === 0 && cur === '' && c === '#') break;
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      const end = e === -1 ? s.length : e + 1;
      cur += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let nest = 0;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { nest++; j += 2; continue; }
        if (nest > 0 && s[j] === ')') { nest--; j++; continue; }
        if (nest === 0 && s[j] === '"') break;
        j++;
      }
      cur += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '\\') { cur += s.slice(i, i + 2); i += 2; continue; }
    if (c === '$' && s[i + 1] === '(') { depth++; cur += '$('; i += 2; continue; }
    if (depth > 0 && c === ')') { depth--; cur += c; i++; continue; }
    cur += c;
    i++;
  }
  flush();
  return out;
}

/**
 * A word's value as the shell reads it, with `${NAME}` / `$NAME` from `vars`
 * expanded. An expansion outside quotes is split into words by the shell, so
 * such a value is marked `<unquoted>` — `"$NOTE"` and `$NOTE` read differently.
 */
function readWord(raw, vars) {
  const value = readWordValue(raw, vars);
  return value.unquotedExpansion ? `<unquoted>${value.text}` : value.text;
}

function readWordValue(raw, vars) {
  let unquotedExpansion = false;
  let out = '';
  const expand = (body) => body.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => (Object.hasOwn(vars, a ?? b) ? vars[a ?? b] : m));
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (c === "'") {
      const e = raw.indexOf("'", i + 1);
      out += raw.slice(i + 1, e === -1 ? raw.length : e);
      i = e === -1 ? raw.length : e + 1;
    } else if (c === '"') {
      let j = i + 1;
      let nest = 0;
      let body = '';
      while (j < raw.length) {
        if (raw[j] === '\\' && nest === 0 && '$`"\\'.includes(raw[j + 1])) { body += raw[j + 1]; j += 2; continue; }
        if (raw[j] === '$' && raw[j + 1] === '(') nest++;
        else if (nest > 0 && raw[j] === ')') nest--;
        else if (nest === 0 && raw[j] === '"') break;
        body += raw[j];
        j++;
      }
      out += expand(body);
      i = j + 1;
    } else if (c === '\\') {
      out += raw[i + 1] ?? '';
      i += 2;
    } else {
      let j = i;
      while (j < raw.length && !"'\"\\".includes(raw[j])) j++;
      const segment = raw.slice(i, j);
      const expanded = expand(segment);
      if (/\$/.test(expanded)) unquotedExpansion = true;
      out += expanded;
      i = j;
    }
  }
  return { text: out, unquotedExpansion };
}

/**
 * Literal assignments in a block (`NAME='x'`, `NAME=x`, `NAME="x"` without
 * expansions), with the offset each takes effect at, in order.
 */
function literalAssignments(block) {
  const out = [];
  let offset = 0;
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"$`\\]*"|[^\s'"$`\\;&|<>()]+)\s*$/.exec(line.trim());
    if (m) out.push({ offset, name: m[1], value: readWordValue(m[2], {}).text });
    offset += line.length + 1;
  }
  return out;
}

/** The variables assigned before `offset`, later assignments winning. */
function varsAt(assignments, offset) {
  const vars = {};
  for (const a of assignments) if (a.offset < offset) vars[a.name] = a.value;
  return vars;
}

/** The script calls of one shell block: `{ script, sub, args: [[flag, value]] }`. */
export function scriptCalls(block) {
  const joined = stripComments(block).replace(/\\\n[ \t]*/g, ' ');
  const assignments = literalAssignments(joined);
  const calls = [];
  const re = /node "\$CLAUDE_PLUGIN_ROOT\/scripts\/([a-z0-9-]+\.mjs)"/g;
  for (const m of joined.matchAll(re)) {
    const vars = varsAt(assignments, m.index);
    const ws = words(joined, m.index + m[0].length);
    const call = { script: m[1], sub: null, args: [] };
    let k = 0;
    if (ws[0] !== undefined && !ws[0].startsWith('-')) { call.sub = readWord(ws[0], vars); k = 1; }
    for (; k < ws.length; k++) {
      const w = ws[k];
      if (w.startsWith('--')) {
        const next = ws[k + 1];
        if (next !== undefined && !next.startsWith('--')) { call.args.push([w, readWord(next, vars)]); k++; } else call.args.push([w, null]);
      } else call.args.push([null, readWord(w, vars)]);
    }
    calls.push(call);
  }
  return calls;
}

/** The line a generated finalize block reads the filled-in phase note with (PC2a2 PD2). */
export const NOTE_READER = `IFS= read -r -d '' NOTE <<'PHASE_NOTE' || true`;

/**
 * The phase-note scaffold: the `NOTE="…"` literal, read as the shell reads it;
 * or, in a generated finalize region (PC2a2 PD2), the markdown fence nearest
 * above the block that reads the note from a quoted heredoc — the text the
 * agent fills in and the heredoc then carries unread.
 */
export function noteScaffold(text) {
  const m = /^NOTE=("(?:[^"\\]|\\.)*")$/m.exec(text);
  if (m) return readWord(m[1], {});
  const lines = text.split('\n');
  const reader = lines.indexOf(NOTE_READER);
  if (reader < 0) return null;
  let found = null;
  for (let i = 0; i < reader; i++) {
    if (lines[i] !== '```markdown') continue;
    let e = i + 1;
    while (e < lines.length && lines[e] !== '```') e++;
    if (e < reader) found = `${lines.slice(i + 1, e).join('\n')}\n`;
    i = e;
  }
  return found;
}

/**
 * The prefix of each `RUN_ID=` assignment, read as the shell reads it: a
 * `${NAME}` assigned a literal earlier in the block expands, so a generated
 * block's `RUN_ID="${ENSEMBLE_TYPE}-$(date …"` reads like the literal form.
 * Only a double-quoted value counts: in single quotes the `$(date …)` would
 * not run, and the id would be a literal the runner refuses (Codex review of
 * PC2a2b).
 */
function runIdPrefixes(code) {
  const assignments = literalAssignments(code);
  return [...code.matchAll(/^RUN_ID=("[^\n]*")$/gm)]
    .map((m) => /^([a-z][a-z-]*)-\$\(date /.exec(readWordValue(m[1], varsAt(assignments, m.index)).text))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * A guard as written: from the line that opens it through its closing `fi`,
 * comments and blank lines dropped, or null when the runbook has none.
 */
function guardText(code, opener) {
  const m = new RegExp(`^${opener}\\n[\\s\\S]*?^fi$`, 'm').exec(code);
  return m ? m[0].split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').join('\n') : null;
}

/** The characterization of one runbook. */
export function characterize(text) {
  const blocks = shellBlocks(text).map((b) => ({ ...b, code: stripComments(b.text) }));
  const all = blocks.map((b) => b.code).join('\n');
  return {
    calls: blocks.flatMap((b) => scriptCalls(b.text)),
    run_id_prefixes: blocks.flatMap((b) => runIdPrefixes(b.code)),
    mktemp_templates: blocks.flatMap((b) => [...b.code.matchAll(/mktemp (?:-d )?-t ((?:'[^']*'|"[^"]*"|[^\s)"'])+)/g)]
      .map((m) => readWord(m[1], varsAt(literalAssignments(b.code), m.index)))),
    guards: {
      detached_head: guardText(all, 'if \\[ -z "\\$GIT_BRANCH" \\]; then'),
      find_rc: guardText(all, 'FIND_RC=\\$\\?'),
      resolve_rc: guardText(all, 'RESOLVE_RC=\\$\\?'),
    },
    note: noteScaffold(text),
  };
}

export function runbookText(persona, verb) {
  return readFileSync(join(pluginRoot(persona), 'commands', `${verb}.md`), 'utf8');
}

/**
 * The recorded value an allowed difference names, as a getter and a setter:
 * `call:<script> <sub>:<flag>` (that call must be the only one), `guards.<name>`
 * or `note`.
 */
function locate(record, where) {
  const call = /^call:(\S+) (\S+):(--[a-z-]+)$/.exec(where);
  if (call) {
    const calls = record.calls.filter((c) => c.script === call[1] && c.sub === call[2]);
    strictEqual(calls.length, 1, `${where}: one such call`);
    const args = calls[0].args.filter(([f]) => f === call[3]);
    strictEqual(args.length, 1, `${where}: the flag once`);
    return [() => args[0][1], (v) => { args[0][1] = v; }];
  }
  const guard = /^guards\.([a-z_]+)$/.exec(where);
  if (guard && typeof record.guards[guard[1]] === 'string') return [() => record.guards[guard[1]], (v) => { record.guards[guard[1]] = v; }];
  if (where === 'note' && typeof record.note === 'string') return [() => record.note, (v) => { record.note = v; }];
  throw new Error(`allowed difference names no recorded value: ${where}`);
}

/**
 * What a runbook must do now: the recorded characterization with each change a
 * region makes on purpose applied. A difference applies only where its `from`
 * occurs exactly once, so a stale or widened entry fails instead of passing.
 * `{persona}` stands for the runbook's persona.
 */
export function expectedFor(key) {
  const expected = structuredClone(FIXTURE.runbooks[key]);
  const persona = key.split('/')[0];
  for (const d of FIXTURE.allowed_differences.filter((x) => x.runbooks.includes(key))) {
    const [get, set] = locate(expected, d.where);
    const from = d.from.split('{persona}').join(persona);
    const to = d.to.split('{persona}').join(persona);
    strictEqual(get().split(from).length - 1, 1, `${key}: allowed difference at ${d.where} finds ${JSON.stringify(from)} once`);
    set(get().replace(from, () => to));
  }
  return expected;
}
