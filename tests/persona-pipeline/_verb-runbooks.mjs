// What a verb runbook does, read from its text (PC2a2 T0, PC2a3 T0'): the
// ordered script calls of its shell blocks with their argument values by flag,
// its guards, and the phase-note scaffold its finalize step writes. The characterization
// test compares this reading with fixtures/verb-runbooks.json, written from
// the runbooks as they stood before their blocks became generated regions, so
// a region that changes what a runbook does fails unless the change is listed.
//
// Values are read as the shell reads them, so a quoting change alone is not a
// difference: a single-quoted literal and an unquoted word read the same, and
// `${NAME}` inside double quotes expands to a literal assigned earlier in the
// same block (`NAME='compose'`).

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, pluginRoot } from './_personas.mjs';

// engineer's seven are recorded before its verb runbooks join the regions
// (PC3 U7: characterize before rewriting).
export const VERB_RUNBOOK_PERSONAS = Object.freeze(['designer', 'engineer', 'founder']);
// The characterized runbooks. This is not the list of runbooks whose blocks
// are generated (the contracts keep their own): critique, refine and start are
// recorded here before theirs are (PC2a3 T0').
export const VERB_RUNBOOK_VERBS = Object.freeze(['compose', 'critique', 'decide', 'frame', 'investigate', 'refine', 'start']);
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

/** The sentence a generated finalize region opens its phase-note scaffold with (PC2a2 PD2). */
export const NOTE_SCAFFOLD_LEAD = 'The phase note this step records — fill in every `<…>`.';
/** The flag a generated finalize block passes the agent's note file with (C130, ADR-0059 amendment j). */
export const NOTE_FILE_FLAG = '--phase-note-file "$TEXT_DIR/note.md"';

/**
 * The phase-note scaffold: the `NOTE="…"` literal, read as the shell reads it;
 * or, in a generated finalize region, the markdown fence the region names as
 * the note's: the first one after the line that opens with NOTE_SCAFFOLD_LEAD,
 * before the block that passes the note's file (C130: the agent writes the
 * filled-in scaffold as `note.md` with its file tool, and the block hands the
 * file to state.mjs; the PD2 quoted heredoc it replaced carried the same text).
 */
export function noteScaffold(text) {
  const m = /^NOTE=("(?:[^"\\]|\\.)*")$/m.exec(text);
  if (m) return readWord(m[1], {});
  const lines = text.split('\n');
  const lead = lines.findIndex((l) => l.startsWith(NOTE_SCAFFOLD_LEAD));
  const passes = lines.findIndex((l, i) => i > lead && l.includes(NOTE_FILE_FLAG));
  if (lead < 0 || passes < 0) return null;
  const open = lines.indexOf('```markdown', lead);
  if (open < 0 || open > passes) return null;
  let e = open + 1;
  while (e < lines.length && lines[e] !== '```') e++;
  return e < passes ? `${lines.slice(open + 1, e).join('\n')}\n` : null;
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
    // A prefix the agent picks at run time stays symbolic: engineer's
    // `${ENSEMBLE_TYPE:-review}` (PC3).
    .map((m) => /^([a-z][a-z-]*|\$\{[A-Z_]+:-[a-z][a-z-]*\})-\$\(date /.exec(readWordValue(m[1], varsAt(assignments, m.index)).text))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * A guard as written: from the line that opens it through its closing `fi`
 * (or `esac`), comments and blank lines dropped, or null when the runbook has
 * none.
 */
function guardText(code, opener, closer = 'fi') {
  const m = new RegExp(`^${opener}\\n[\\s\\S]*?^${closer}$`, 'm').exec(code);
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
      // PC2a3 T0': start's clean-baseline gate (its status, then the admitted
      // values), designer's ensemble-commit guard (D2) and its convergence
      // guard on the terminal write (DD5).
      baseline_rc: guardText(all, 'BASELINE_RC=\\$\\?'),
      baseline_status: guardText(all, 'case "\\$STATUS" in', 'esac'),
      ensemble_launched: guardText(all, 'if \\[ -n "\\$\\{RUN_ID:-\\}" \\] && \\[ -n "\\$\\{VERDICT:-\\}" \\]; then'),
      converged: guardText(all, 'if \\[ "\\$\\{CONVERGED:-no\\}" = "yes" \\]; then'),
      // PC3: engineer's start refuses a dirty baseline with an if.
      baseline_dirty: guardText(all, 'if \\[ "\\$BASELINE_STATUS" = "dirty" \\]; then'),
    },
    note: noteScaffold(text),
  };
}

export function runbookText(persona, verb) {
  return readFileSync(join(pluginRoot(persona), 'commands', `${verb}.md`), 'utf8');
}

/**
 * The index in `record.calls` of the call `<script> <sub>` names: that call
 * must be the only one, or with `#<n>` the n-th such call (a runbook appends
 * twice, on resume and with its phase note). A script called without a
 * subcommand (`start-args.mjs`, `phase7-commit.mjs`) is named without one.
 */
function locateCall(record, where, script, sub = null, nth = undefined) {
  const sites = record.calls.map((c, i) => [c, i]).filter(([c]) => c.script === script && c.sub === sub);
  if (nth === undefined) strictEqual(sites.length, 1, `${where}: one such call`);
  else strictEqual(sites.length >= Number(nth), true, `${where}: at least ${nth} such calls`);
  return sites[nth === undefined ? 0 : Number(nth) - 1][1];
}

const CALL_WHERE = /^call:([a-z0-9-]+\.mjs)(?: ([a-z-]+))?(?:#([1-9][0-9]?))?$/;
const FLAG_WHERE = /^call:([a-z0-9-]+\.mjs)(?: ([a-z-]+))?(?:#([1-9][0-9]?))?:(--[a-z-]+)$/;

/**
 * The recorded value an allowed difference names, as a getter and a setter:
 * `call:<script> <sub>[#<n>]:<flag>` (see locateCall), `guards.<name>`,
 * `note`, or `run_id_prefixes` for a runbook with one dispatch.
 */
function locate(record, where) {
  const call = FLAG_WHERE.exec(where);
  if (call) {
    const args = record.calls[locateCall(record, where, call[1], call[2] ?? null, call[3])].args.filter(([f]) => f === call[4]);
    strictEqual(args.length, 1, `${where}: the flag once`);
    return [() => args[0][1], (v) => { args[0][1] = v; }];
  }
  const guard = /^guards\.([a-z_]+)$/.exec(where);
  if (guard && typeof record.guards[guard[1]] === 'string') return [() => record.guards[guard[1]], (v) => { record.guards[guard[1]] = v; }];
  if (where === 'note' && typeof record.note === 'string') return [() => record.note, (v) => { record.note = v; }];
  // PC3 U7: a runbook with one dispatch has one run-id prefix.
  if (where === 'run_id_prefixes' && record.run_id_prefixes.length === 1) return [() => record.run_id_prefixes[0], (v) => { record.run_id_prefixes[0] = v; }];
  throw new Error(`allowed difference names no recorded value: ${where}`);
}

/** `{persona}` replaced in every string of a fixture value. */
function forPersona(value, persona) {
  if (typeof value === 'string') return value.split('{persona}').join(persona);
  if (Array.isArray(value)) return value.map((v) => forPersona(v, persona));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forPersona(v, persona)]));
  return value;
}

const callName = (c) => `${c.script} ${c.sub}`;

/**
 * The structural changes (PC2b RV7), each with a strict check of the value it
 * replaces, so a stale entry fails instead of passing:
 *
 *   insert-call   `where` names the anchor call; `from` names the call that
 *                 follows it now ('' at the end); `to`, the call inserted
 *                 between the two.
 *   add-flag      `where` names a call and the flag it does not carry yet;
 *                 `from`, the flag it goes right after (carried once); `to`,
 *                 its value (null for a bare flag).
 *   replace-call  `where` names a call; `from`, the call as it reads now
 *                 (script, sub and args, deep-equal); `to`, the call that
 *                 replaces it.
 *   null-guard    `where` names a guard; `from`, its whole text as it reads
 *                 now; `to` null, the guard gone.
 *   remove-call   `where` names a call; `from`, the call as it reads now
 *                 (deep-equal); `to` null, the call gone (PC3b: a block that
 *                 moved or merged).
 *   set-guard     `where` names a guard the runbook did not have (null);
 *                 `from` null; `to`, its whole text (PC3b: a runbook that
 *                 adopts the shared guard).
 *   file-flag     `where` names a call and the inline text flag it carries
 *                 once; `from`, that flag's value as recorded; `to`, the
 *                 `[<flag>-file, <path>]` pair that takes its place (C130,
 *                 ADR-0059 amendment j: the text moved into a file the agent
 *                 writes, which the call names).
 *   remove-mktemp `where` is `mktemp_templates`; `from`, a template the
 *                 runbook records once; `to` null, the allocation gone (C130:
 *                 the prompt is a file the agent writes, not a path the block
 *                 allocates).
 */
const STRUCTURAL = {
  'insert-call'(record, d) {
    const m = CALL_WHERE.exec(d.where);
    if (!m) throw new Error(`insert-call names no call: ${d.where}`);
    const at = locateCall(record, d.where, m[1], m[2] ?? null, m[3]);
    const next = record.calls[at + 1];
    strictEqual(next === undefined ? '' : callName(next), d.from, `${d.where}: insert-call finds ${JSON.stringify(d.from)} after it`);
    record.calls.splice(at + 1, 0, structuredClone(d.to));
  },
  'add-flag'(record, d) {
    const m = FLAG_WHERE.exec(d.where);
    if (!m) throw new Error(`add-flag names no call flag: ${d.where}`);
    const { args } = record.calls[locateCall(record, d.where, m[1], m[2] ?? null, m[3])];
    strictEqual(args.filter(([f]) => f === m[4]).length, 0, `${d.where}: add-flag finds the flag absent`);
    const after = args.map(([f], i) => [f, i]).filter(([f]) => f === d.from);
    strictEqual(after.length, 1, `${d.where}: add-flag finds ${d.from} once`);
    args.splice(after[0][1] + 1, 0, [m[4], d.to]);
  },
  'replace-call'(record, d) {
    const m = CALL_WHERE.exec(d.where);
    if (!m) throw new Error(`replace-call names no call: ${d.where}`);
    const at = locateCall(record, d.where, m[1], m[2] ?? null, m[3]);
    deepStrictEqual(record.calls[at], d.from, `${d.where}: replace-call finds the call as recorded`);
    record.calls[at] = structuredClone(d.to);
  },
  'null-guard'(record, d) {
    const m = /^guards\.([a-z_]+)$/.exec(d.where);
    if (!m || typeof record.guards[m[1]] !== 'string') throw new Error(`null-guard names no recorded guard: ${d.where}`);
    strictEqual(record.guards[m[1]], d.from, `${d.where}: null-guard finds the guard as recorded`);
    strictEqual(d.to, null, `${d.where}: null-guard sets null`);
    record.guards[m[1]] = null;
  },
  'remove-call'(record, d) {
    const m = CALL_WHERE.exec(d.where);
    if (!m) throw new Error(`remove-call names no call: ${d.where}`);
    const at = locateCall(record, d.where, m[1], m[2] ?? null, m[3]);
    deepStrictEqual(record.calls[at], d.from, `${d.where}: remove-call finds the call as recorded`);
    strictEqual(d.to, null, `${d.where}: remove-call sets null`);
    record.calls.splice(at, 1);
  },
  'file-flag'(record, d) {
    const m = FLAG_WHERE.exec(d.where);
    if (!m) throw new Error(`file-flag names no call flag: ${d.where}`);
    const { args } = record.calls[locateCall(record, d.where, m[1], m[2] ?? null, m[3])];
    const at = args.map(([f], i) => [f, i]).filter(([f]) => f === m[4]);
    strictEqual(at.length, 1, `${d.where}: file-flag finds the flag once`);
    strictEqual(args[at[0][1]][1], d.from, `${d.where}: file-flag finds the value as recorded`);
    ok(Array.isArray(d.to) && d.to.length === 2 && d.to[0] === `${m[4]}-file` && typeof d.to[1] === 'string', `${d.where}: file-flag sets [${m[4]}-file, <path>]`);
    args[at[0][1]] = [...d.to];
  },
  'remove-mktemp'(record, d) {
    strictEqual(d.where, 'mktemp_templates', 'remove-mktemp names mktemp_templates');
    const at = record.mktemp_templates.map((x, i) => [x, i]).filter(([x]) => x === d.from);
    strictEqual(at.length, 1, `remove-mktemp finds ${JSON.stringify(d.from)} once`);
    strictEqual(d.to, null, 'remove-mktemp sets null');
    record.mktemp_templates.splice(at[0][1], 1);
  },
  'set-guard'(record, d) {
    const m = /^guards\.([a-z_]+)$/.exec(d.where);
    if (!m || !Object.hasOwn(record.guards, m[1])) throw new Error(`set-guard names no recorded guard: ${d.where}`);
    strictEqual(record.guards[m[1]], null, `${d.where}: set-guard finds the guard absent`);
    strictEqual(d.from, null, `${d.where}: set-guard replaces null`);
    ok(typeof d.to === 'string' && d.to.length > 0, `${d.where}: set-guard sets a guard text`);
    record.guards[m[1]] = d.to;
  },
};

export const STRUCTURAL_OPS = Object.freeze(Object.keys(STRUCTURAL));

/**
 * One allowed difference applied to `record` (in place) for `persona`. Without
 * `op` it replaces a string inside a recorded value, where `from` occurs
 * exactly once; with `op`, a structural change (STRUCTURAL).
 */
export function applyDifference(record, difference, persona) {
  const d = forPersona(difference, persona);
  if (d.op !== undefined) {
    if (!Object.hasOwn(STRUCTURAL, d.op)) throw new Error(`unknown allowed-difference op: ${d.op}`);
    STRUCTURAL[d.op](record, d);
    return;
  }
  const [get, set] = locate(record, d.where);
  strictEqual(get().split(d.from).length - 1, 1, `allowed difference at ${d.where} finds ${JSON.stringify(d.from)} once`);
  set(get().replace(d.from, () => d.to));
}

/**
 * What a runbook must do now: the recorded characterization with each change a
 * region makes on purpose applied, in the fixture's order. A difference
 * applies only where the value it replaces reads as recorded, so a stale or
 * widened entry fails instead of passing. `{persona}` stands for the
 * runbook's persona.
 */
export function expectedFor(key) {
  const expected = structuredClone(FIXTURE.runbooks[key]);
  const persona = key.split('/')[0];
  for (const d of FIXTURE.allowed_differences.filter((x) => x.runbooks.includes(key))) applyDifference(expected, d, persona);
  return expected;
}
