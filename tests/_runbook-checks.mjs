// Per-document runbook checks, shared by the gates that sweep the committed
// runbooks and by checks that run over a runbook assembled in memory
// (ADR-0066 Stage 2a).
//
// Four gates checked runbook markdown by reading the committed files
// themselves, so none of their rules could run over text that is not on disk
// yet — the runbook the next `sync:persona-pipeline -- --write` would write.
// Each rule now lives here as a pure function of the document TEXT and a
// label for its messages, and the gates call it once per document:
//
//   completion-output contract   tests/plugin-shape/test-completion-output-contract.mjs
//   archive-timing annotations   tests/scripts/test-set-terminal-archive-timing.mjs
//   plugin-root resolver         tests/plugin-shape/test-headless-safe-runbooks.mjs
//   args-file transport pins     tests/plugin-shape/test-args-file-transport.mjs
//
// What stays with each gate: its corpus walk, its floors and its non-vacuity
// guards, and the account of why its rule exists. A function here only
// reports what it finds in one document — it asserts nothing, so zero findings
// over a document that has no sites is a pass a caller must refuse itself
// (each returns a site count, or the sites it checked, for that). Messages are
// the ones the gates printed before the move, with `label` where they named
// the file.
//
// No file I/O and no test registration. Not discovered by `node --test` (the
// leading underscore matches none of its patterns); gated by
// tests/scripts/test-runbook-checks.mjs, which shows each rule finding its
// defect in a string.

import { substituteClaudeArguments } from './_claude-command-substitution.mjs';

// ── Completion-output contract ──────────────────────────────────────────────
// plugins/runtime/docs/completion-output-contract.md §5.3/§5.4.

/** The six keys of a completion block, in canonical order. */
export const COMPLETION_FIELD_KEYS = [
  'selected_next',
  'rejected_alternatives',
  'rationale',
  'evidence_pointers',
  'confidence',
  'next_command',
];

// Validate every `- selected_next:` anchor: the five remaining keys must
// follow on the immediately subsequent lines, in canonical order. Returns the
// conformant-site count and the violations; also returns the set of line
// indices occupied by conformant blocks (for the prose re-enumeration rule).
export function completionBlocks(text, label) {
  const lines = text.split('\n');
  const blockLines = new Set();
  const violations = [];
  let sites = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s*selected_next\s*:/.test(lines[i])) continue;
    let idx = i + 1;
    let conformant = true;
    for (const key of COMPLETION_FIELD_KEYS.slice(1)) {
      const line = lines[idx] ?? '';
      if (!new RegExp(`^\\s*-\\s*${key}\\s*:`).test(line)) {
        violations.push(
          `${label}:${i + 1} — block missing/misordered '${key}' (expected at line ${idx + 1}, got: ${JSON.stringify(line.slice(0, 60))})`,
        );
        conformant = false;
        break;
      }
      idx++;
    }
    if (conformant) {
      sites++;
      for (let j = i; j < idx; j++) blockLines.add(j);
    }
  }
  return { sites, blockLines, violations };
}

// Prose outside a conformant block that names 3+ distinct field keys within a
// 3-line window is a re-enumeration of the template (the drift vector) —
// windowed so hard-wrapped markdown prose cannot dodge the rule. `blockLines`
// is completionBlocks' set for the same text, computed here when omitted.
export function completionReenumerations(text, label, blockLines = completionBlocks(text, label).blockLines) {
  const lines = text.split('\n');
  const violations = [];
  const flagged = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (blockLines.has(i)) continue;
    const window = [];
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (!blockLines.has(j)) window.push(lines[j]);
    }
    const joined = window.join('\n');
    // A key inside a CLI flag (`--next-step-confidence`) names a flag, not the
    // field, so a hyphen before it does not count as a word boundary here.
    const distinct = COMPLETION_FIELD_KEYS.filter((key) => new RegExp(`(?<![-\\w])${key}\\b`).test(joined));
    if (distinct.length >= 3 && !flagged.has(i)) {
      violations.push(
        `${label}:${i + 1} — prose re-enumeration of ${distinct.length} template fields (${distinct.join(', ')}); point at the template block / contract section instead`,
      );
      // Skip ahead past this window so one enumeration reports once.
      for (let j = i; j < i + 3; j++) flagged.add(j);
      i += 2;
    }
  }
  return violations;
}

// ── Archive timing at every terminalization site ────────────────────────────
// tests/scripts/test-set-terminal-archive-timing.mjs says why the statement
// must sit at each site; the facts and their inversions are kept here, once.

// Each is a distinct claim a reader can act on; dropping any one restores a
// different half of the original defect. Matched by regex, not substring,
// because the same fact is written as a bash comment at an invocation
// ("EVERY turn end") and as prose in a reference ("**every turn end**").
export const REQUIRED_FACTS = [
  { re: /every turn end/i, why: 'the Claude per-turn firing is the corrected fact' },
  { re: /--terminal-marker false/, why: 'the unset window is the only escape' },
  { re: /Codex/, why: 'the Codex hook is trust-gated, so its evaluation is deferred' },
];

export const INVOCATION_LABEL = { re: /ARCHIVE TIMING/, why: 'the block must be findable by its label' };

// Vocabulary alone would let an annotation assert the opposite and still match
// every fact regex. These catch the inversions worth naming.
export const FORBIDDEN_IN_ANNOTATION = [
  /not\s+fire\s+at\s+every\s+turn/i,
  /never\s+fires?\s+at\s+every\s+turn/i,
  /fires?\s+(?:only\s+)?at\s+session\s+(?:end|close)/i,
  /Codex\s+always\s+archives/i,
  /`?--terminal-marker false`?\s+is\s+forbidden/i,
];

// A runnable invocation, as opposed to prose quoting one: a `node …state.mjs`
// command inside a fenced code block whose continuation-joined text reaches
// `set-terminal`. An `env VAR=v` prefix still counts — requiring the line to
// begin with `node` was an evasion a reviewer reproduced.
const NODE_COMMAND = /^\s*(?:(?:env|command|exec)\s+(?:\S+=\S*\s+)*)*node\s/;

function findInvocations(lines) {
  const sites = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence) continue;
    if (!NODE_COMMAND.test(lines[i])) continue;
    if (!/state\.mjs/.test(lines[i])) continue;
    let end = i;
    let joined = lines[i];
    while (/\\\s*$/.test(lines[end]) && end + 1 < lines.length) {
      end++;
      joined += ' ' + lines[end].trim();
    }
    // ADR-0063 D3 — `finish-verb` is a verb's terminal write in interactive
    // mode (set-terminal summary-complete), so it is a site too.
    if (/\b(?:set-terminal|finish-verb)\b/.test(joined)) sites.push({ line: i, joined });
  }
  return sites;
}

// The contiguous comment block directly above the invocation — no blank line
// between. Binding to this window is what makes the guard per-invocation: a
// note attached to some other site in the same file cannot reach here.
function commentBlockAbove(lines, invocationLine) {
  const block = [];
  for (let i = invocationLine - 1; i >= 0; i--) {
    if (/^\s*#/.test(lines[i])) block.unshift(lines[i]);
    else break;
  }
  return block.join('\n');
}

/** The entries of `facts` whose `re` does not match `block`. */
export function missingFacts(block, facts) {
  return facts.filter((f) => !f.re.test(block));
}

/** The set-terminal / finish-verb sites in fenced blocks, as `{ line, joined }` with a 0-based `line`. */
export function terminalInvocations(text) {
  return findInvocations(text.split(/\r?\n/));
}

/**
 * The sweep's rule for one document: the comment block directly above each
 * site carries the label and every fact, and none of the inversions.
 * `{ sites, problems }`, where `sites` is the number of invocations found.
 */
export function archiveTimingProblems(text, label) {
  const lines = text.split(/\r?\n/);
  const sites = findInvocations(lines);
  const problems = [];
  for (const site of sites) {
    const block = commentBlockAbove(lines, site.line);
    const absent = missingFacts(block, [INVOCATION_LABEL, ...REQUIRED_FACTS]);
    if (absent.length > 0) {
      problems.push(
        `${label}:${site.line + 1} — comment block above is missing ` +
          absent.map((f) => `${f.re} (${f.why})`).join(', '),
      );
    }
    for (const bad of FORBIDDEN_IN_ANNOTATION) {
      if (bad.test(block)) problems.push(`${label}:${site.line + 1} — annotation asserts the inverse: ${bad}`);
    }
  }
  return { sites: sites.length, problems };
}

// ── The plugin-root resolver (ADR-0063 S0) ──────────────────────────────────
// tests/plugin-shape/test-headless-safe-runbooks.mjs says why every command
// block that uses the plugin root opens with these lines.

/**
 * Fenced blocks as `{ lang, start, lines }`, indentation removed; `start` is
 * the 1-based line of the first body line. A fence left open at the end of the
 * text is no block; the array carries it as `unclosed` (not enumerable), or
 * `null`.
 */
export function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const fence = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    if (open === null) {
      // A backtick fence's info string holds no backtick (CommonMark): ```x``` is a code span.
      if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) open = { indent: fence[1].length, marker: fence[2], lang: fence[3].trim(), start: i + 2, lines: [] };
      return;
    }
    if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && fence[3].trim() === '') {
      blocks.push(open);
      open = null;
      return;
    }
    open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
  });
  Object.defineProperty(blocks, 'unclosed', { value: open });
  return blocks;
}

const PLUGIN_ROOT_USE = /\$\{?CLAUDE_PLUGIN_ROOT\b/;
const RUNTIME_ROOT_USE = /\$\{?RUNTIME_ROOT\b/;
const isCode = (line) => line.trim() !== '' && !line.trimStart().startsWith('#');

/** The two opening lines a command block of `plugin` must carry. */
function resolverLines(plugin) {
  const v = plugin === 'runtime' ? 'RUNTIME_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  const env = `AGENTIC_${plugin.toUpperCase()}_ROOT`;
  return [
    `${v}="\${${env}:-\${CLAUDE_PLUGIN_ROOT}}"`,
    `[ -n "$${v}" ] || ${v}="$(find ~/.claude/plugins/cache/agentic-plugins/${plugin} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"`,
  ];
}

/**
 * The opening lines a generated persona-pipeline block carries instead
 * (ADR-0066 Decision 4, PC2a DD1): the persona's name reaches the shell only
 * as a single-quoted literal, so the override is read with printenv and the
 * cache path quotes the name. Same resolution order as resolverLines.
 * engineer carries both forms while its runbooks join the regions group by
 * group (ADR-0066 Stage 3, PC3 U7).
 */
const GENERATED_RESOLVER_PLUGINS = new Set(['founder', 'designer', 'engineer']);
function generatedResolverLines(plugin) {
  const env = `AGENTIC_${plugin.toUpperCase()}_ROOT`;
  return [
    `ROOT_OVERRIDE="$(printenv '${env}' || true)"`,
    'CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"',
    resolverLines(plugin)[1].replace(`agentic-plugins/${plugin} `, `agentic-plugins/'${plugin}' `),
  ];
}

/** Every resolver form a block of `plugin` may open with. */
export function resolverForms(plugin) {
  return GENERATED_RESOLVER_PLUGINS.has(plugin) ? [resolverLines(plugin), generatedResolverLines(plugin)] : [resolverLines(plugin)];
}

/**
 * The resolver rule for one command runbook of `plugin`: every fenced block
 * that uses the plugin root opens with a whole resolver form before its first
 * use, and nothing in it reassigns the root from the retired fallbacks.
 * `{ checked, offenders }`, where `checked` names each block that uses the
 * root as `<label>:<line of its first body line>`.
 */
export function resolverProblems(text, plugin, label) {
  const checked = [];
  const offenders = [];
  for (const block of fencedBlocks(text)) {
    const uses = (l) => isCode(l) && (PLUGIN_ROOT_USE.test(l) || (plugin === 'runtime' && RUNTIME_ROOT_USE.test(l)));
    // The form the block opens with: its first line, then the rest in order.
    const opened = resolverForms(plugin).map((form) => {
      const at = block.lines.findIndex((l) => l.trim() === form[0]);
      const whole = at >= 0 && form.every((line, k) => (block.lines[at + k] ?? '').trim() === line);
      return { at, form, whole };
    }).find((o) => o.at >= 0) ?? { at: -1, form: [], whole: false };
    const own = (i) => opened.at >= 0 && i >= opened.at && i < opened.at + opened.form.length - 1;
    const firstUse = block.lines.findIndex((l, i) => !own(i) && uses(l));
    if (firstUse < 0) continue;
    checked.push(`${label}:${block.start}`);
    if (opened.at < 0 || opened.at > firstUse || !opened.whole) {
      offenders.push(`${label}:${block.start + Math.max(firstUse, 0)}: ${block.lines[firstUse].trim()}`);
    }
    // Nothing may reassign the root from the retired fallbacks.
    for (const [i, l] of block.lines.entries()) {
      if (/BASH_SOURCE/.test(l) || /CLAUDE_PLUGIN_ROOT:-\}/.test(l)) offenders.push(`${label}:${block.start + i}: ${l.trim()}`);
    }
  }
  return { checked, offenders };
}

// ── Args-file transport (ADR-0059) ──────────────────────────────────────────
// tests/plugin-shape/test-args-file-transport.mjs §6 names the runbooks that
// pass typed text by --args-file; these are the pins each of them keeps.

const MKTEMP_STEP = 'mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"';

/** A runbook creates the args directory, writes the file, and gives the CLI the file. */
export function argsFileRunbookProblems(text, label) {
  const problems = [];
  if (!text.includes(MKTEMP_STEP)) problems.push(`${label}: no mktemp step`);
  if (!text.includes('{"agentic_args": 1, "text": "…"}')) problems.push(`${label}: no file-writing step`);
  // The shell would put the typed text back on a command line, where `;`,
  // `$(…)` and `>` act on it: the file is written with the file tool. The
  // sentence that says so names the args file: a runbook also has the agent
  // write other files with the tool (its text files, ADR-0059's amendment of
  // 2026-10-10), and their sentence says nothing about this one.
  const FILE_TOOL = 'with (?:your|the) file-(?:writing|editing) tool';
  const ARGS_FILE = '(?:args\\.json|agentic_args)';
  if (!new RegExp(`${FILE_TOOL}[^.]*?${ARGS_FILE}|${ARGS_FILE}[^.]*?${FILE_TOOL}`, 'i').test(text.replace(/\s+/g, ' '))) problems.push(`${label}: the file is not written with the file-writing tool`);
  if (!text.includes('--args-file "$ARGS_DIR/args.json"')) problems.push(`${label}: the CLI is not given the file`);
  return problems;
}

// The model transcribes what Claude substituted into the body, so the text
// has to be on the page, in prose, before step 1 asks for it.
const TYPED_TEXT_SENTINEL = 'ADR0059TYPEDTEXT';

/** After Claude's argument substitution, the typed text appears in the body before the `mktemp -d` step. */
export function argsFileTypedTextProblems(text, label) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const rendered = substituteClaudeArguments(body, TYPED_TEXT_SENTINEL, { appendIfUnused: false });
  const shown = rendered.indexOf(TYPED_TEXT_SENTINEL);
  return shown >= 0 && shown < rendered.indexOf(MKTEMP_STEP) ? [] : [`${label}: the typed text is not shown before the steps`];
}

// ── Runbook CLI contracts (the standard test shape, owner decision 2026-11-09) ─
// tests/plugin-shape/test-runbook-cli-contracts.mjs says why every runbook
// call of a checked CLI is held to the CLI's own source: the CLIs declare no
// option table (state.mjs takes any --name and drops one its subcommand does
// not read), so a misspelled or stale flag in a runbook ran without a word.
// The contract is read from the source with the conventions those files keep
// (a subcommand's `case` at six spaces and its statements at eight, a
// top-level function closed by `}` at column 0). What the reading cannot
// settle is reported, never assumed: a subcommand whose flags reach code it
// cannot follow is `unsupported`, and a rule it cannot apply in full is named
// in `partial`. The shell words come in through `parse` (stripComments, words
// and readWord of tests/persona-pipeline/_verb-runbooks.mjs), so this module
// still reads no file.

const FLAG_LITERAL = /(['"])([a-z][a-z0-9-]*)\1/g;
const literals = (text) => [...text.matchAll(FLAG_LITERAL)].map((m) => m[2]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const codeLines = (lines) => lines.filter((l) => !l.trimStart().startsWith('//'));
const indentOf = (line) => line.length - line.trimStart().length;

/** A top-level function of `source`, `{ params, body }`, or null: from its line to the first `}` at column 0. */
export function topLevelFunction(source, name) {
  const lines = source.split('\n');
  const head = new RegExp(`^(?:export )?(?:async )?function ${escapeRe(name)}\\(([^)]*)\\)`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && l === '}');
  if (end < 0) return null;
  const params = head.exec(lines[at])[1].split(',').map((p) => p.trim().replace(/\s*=.*$/, '')).filter(Boolean);
  return { params, body: codeLines(lines.slice(at + 1, end)).join('\n') };
}

/** The index, among the arguments of the call `before` ends inside, of the argument that starts where `before` ends. */
function argumentIndex(before) {
  let depth = 0;
  let index = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return index;
      depth--;
    } else if (c === ',' && depth === 0) index++;
  }
  return index;
}

/**
 * The flags a code body reads from its flags object `param`:
 * `{ accepted, required, rejected, partial, helpers }`. `required` holds the
 * names of a `cliRequire(param, [...])` statement at the body's top
 * indentation (`indent` spaces); one under a condition is accepted and named
 * in `partial`. A bare `param` passed to a call is a helper call (`helpers`:
 * `{ name, index }`), and any other bare use is in `partial`. A flag read only
 * in the condition of a top-level `if` that throws is `rejected`; under
 * `!capabilityOn('<c>')` it is refused while the persona has `<c>` off
 * (`rejectedUnless`, capability to names).
 */
export function flagReads(body, param, indent = null) {
  const p = escapeRe(param);
  const accepted = new Set();
  const required = new Set();
  const rejected = new Set();
  const partial = [];
  const helpers = [];
  const rejectedUnless = new Map();
  let rest = body;
  // A refusal: `if (<condition>) throw …` or `if (<condition>) {` with a
  // throw first, at the top indentation. Its condition's reads are taken out
  // of the body and judged after the rest is read.
  const refusals = [];
  if (indent !== null) {
    const pad = ' '.repeat(indent);
    rest = rest.replace(new RegExp(`^${pad}if \\((.*)\\) (throw\\b|\\{\\n${pad}  throw\\b)`, 'gm'), (m, condition, tail) => {
      if (!new RegExp(`\\b${p}\\b`).test(condition)) return m;
      refusals.push(condition);
      return `${pad}if (true) ${tail}`;
    });
  }
  // A statement of its own at the top indentation, not one an `if` guards.
  const unconditional = (text, offset) => indent === null || new RegExp(`^ {${indent}}$`).test(text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset));
  // A list whose members each refuse the command: `for (const f of LIST) { if (f in flags) { throw`.
  rest = rest.replace(new RegExp(`for \\(const (\\w+) of (\\w+)\\) \\{\\s*if \\(\\1 in ${p}\\) \\{\\s*throw`, 'g'), (m, v, list) => {
    const decl = new RegExp(`const ${list} = \\[([^\\]]*)\\]`).exec(body);
    if (decl) for (const n of literals(decl[1])) rejected.add(n);
    else partial.push(`rejected list ${list} not found`);
    return 'throw';
  });
  // A literal list a loop reads each member of: `for (const f of ['a', 'b']) { if (f in flags && flags[f] …`.
  for (const m of [...rest.matchAll(/for \(const (\w+) of \[([^\]]*)\]\)/g)]) {
    const reads = new RegExp(`\\b${m[1]} in ${p}\\b|\\b${p}\\[${m[1]}\\]`, 'g');
    if (!reads.test(rest)) continue;
    for (const n of literals(m[2])) accepted.add(n);
    rest = rest.replace(reads, '');
  }
  rest = rest.replace(new RegExp(`\\bcliRequire\\(${p}, \\[([^\\]]*)\\]\\)`, 'g'), (m, list, offset, text) => {
    const always = unconditional(text, offset);
    for (const n of literals(list)) {
      accepted.add(n);
      if (always) required.add(n);
    }
    if (!always) partial.push(`required under a condition: ${literals(list).join(', ')}`);
    return '';
  });
  rest = rest.replace(new RegExp(`\\bcliRequire\\(${p}, (\\w+)\\)`, 'g'), (m, list) => {
    for (const re of [new RegExp(`(?:const|let) ${list} = \\[([^\\]]*)\\]`, 'g'), new RegExp(`\\b${list}\\.push\\(([^)]*)\\)`, 'g')]) {
      for (const d of body.matchAll(re)) for (const n of literals(d[1])) accepted.add(n);
    }
    partial.push(`required list ${list} built at run time`);
    return '';
  });
  rest = rest.replace(new RegExp(`\\b${p}\\[(['"])([a-z][a-z0-9-]*)\\1\\]`, 'g'), (m, q, n) => { accepted.add(n); return ''; });
  rest = rest.replace(new RegExp(`\\b${p}\\.([a-z][a-z0-9]*)\\b(?!\\s*\\()`, 'g'), (m, n) => { accepted.add(n); return ''; });
  rest = rest.replace(new RegExp(`(['"])([a-z][a-z0-9-]*)\\1 in ${p}\\b`, 'g'), (m, q, n) => { accepted.add(n); return ''; });
  rest = rest.replace(new RegExp(`\\[([^\\]]*)\\]\\s*\\.(?:some|every|filter)\\(\\(?(\\w+)\\)? => \\2 in ${p}\\)`, 'g'), (m, list) => {
    for (const n of literals(list)) accepted.add(n);
    return '';
  });
  // The accessors that read one named flag; any other call keeps the flags
  // object, so it is followed as a helper.
  rest = rest.replace(new RegExp(`\\b(cliBoolean|cliPresenceFlag)\\(${p}, (['"])([a-z][a-z0-9-]*)\\2`, 'g'), (m, fn, q, n) => { accepted.add(n); return `${fn}(`; });
  for (const m of rest.matchAll(new RegExp(`\\b${p}\\b`, 'g'))) {
    const before = rest.slice(0, m.index);
    const call = /(\w+)\(([^()]*)$/.exec(before);
    if (call && !/[{}[\]]/.test(call[2]) && /^\s*[,)]/.test(rest.slice(m.index + param.length))) {
      helpers.push({ name: call[1], index: argumentIndex(before) });
    } else {
      partial.push(`${param} used as ${JSON.stringify(rest.slice(Math.max(0, m.index - 20), m.index + param.length + 20).replace(/\s+/g, ' '))}`);
    }
  }
  for (const condition of refusals) {
    const inner = flagReads(condition, param, null);
    partial.push(...inner.partial);
    const capability = /!capabilityOn\('([a-z_]+)'\)/.exec(condition)?.[1];
    for (const n of inner.accepted) {
      if (capability) {
        if (!rejectedUnless.has(capability)) rejectedUnless.set(capability, new Set());
        rejectedUnless.get(capability).add(n);
      } else if (!accepted.has(n)) rejected.add(n);
    }
  }
  return { accepted, required, rejected, rejectedUnless, partial, helpers };
}

/** flagReads of `body`, with each helper the flags reach followed into its own top-level function in `source`. */
function flagReadsFollowed(source, body, param, indent, seen = new Set()) {
  const reads = flagReads(body, param, indent);
  const unsupported = [];
  for (const { name, index } of reads.helpers) {
    if (seen.has(name)) continue;
    seen.add(name);
    const fn = topLevelFunction(source, name);
    if (fn === null || fn.params[index] === undefined) {
      unsupported.push(`flags reach ${name}(), which is not a top-level function of the file`);
      continue;
    }
    const inner = flagReadsFollowed(source, fn.body, fn.params[index], null, seen);
    for (const n of inner.accepted) reads.accepted.add(n);
    for (const n of inner.rejected) reads.rejected.add(n);
    for (const [c, names] of inner.rejectedUnless) for (const n of names) {
      if (!reads.rejectedUnless.has(c)) reads.rejectedUnless.set(c, new Set());
      reads.rejectedUnless.get(c).add(n);
    }
    // What a helper requires is accepted; it counts as required only where
    // the case itself requires it.
    for (const n of inner.required) reads.accepted.add(n);
    if (inner.required.size > 0) reads.partial.push(`required inside ${name}(): ${[...inner.required].join(', ')}`);
    reads.partial.push(...inner.partial);
    unsupported.push(...inner.unsupported);
  }
  return { ...reads, unsupported };
}

// ── A shared case, read for one of its subcommands ──────────────────────────

const COMPARISON = /\bsubcommand ([!=])== '([a-z0-9-]+)'/g;

/** The tokens of a condition: `(`, `)`, `&&`, `||`, `!`, a subcommand comparison `{ cmp }`, or any other operand `{ atom }`. */
function conditionTokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(two); i += 2; continue; }
    if (text[i] === '(' || text[i] === ')') { out.push(text[i]); i++; continue; }
    if (text[i] === '!' && text[i + 1] !== '=') { out.push('!'); i++; continue; }
    const cmp = /^subcommand ([!=])== '([a-z0-9-]+)'/.exec(text.slice(i));
    if (cmp) { out.push({ cmp: { negated: cmp[1] === '!', sub: cmp[2] } }); i += cmp[0].length; continue; }
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (text.startsWith('&&', j) || text.startsWith('||', j))) break;
    }
    out.push({ atom: text.slice(i, j).trim() });
    i = j;
  }
  return out;
}

/** A condition's value for `sub`: true, false, or null when an operand other than the subcommand decides it. */
export function conditionFor(text, sub) {
  const tokens = conditionTokens(text);
  let k = 0;
  const or = () => {
    let v = and();
    while (tokens[k] === '||') { k++; const w = and(); v = v === true || w === true ? true : v === false && w === false ? false : null; }
    return v;
  };
  const and = () => {
    let v = unary();
    while (tokens[k] === '&&') { k++; const w = unary(); v = v === false || w === false ? false : v === true && w === true ? true : null; }
    return v;
  };
  const unary = () => {
    const t = tokens[k++];
    if (t === '!') { const v = unary(); return v === null ? null : !v; }
    if (t === '(') { const v = or(); if (tokens[k++] !== ')') throw new Error(`unbalanced condition: ${text}`); return v; }
    if (t?.cmp) return (t.cmp.sub === sub) !== t.cmp.negated;
    if (t?.atom !== undefined) return null;
    throw new Error(`unreadable condition: ${text}`);
  };
  const v = or();
  if (k !== tokens.length) throw new Error(`unreadable condition: ${text}`);
  return v;
}

/**
 * The statements of a shared case that run for `sub`: each top-level `if`
 * (at `indent` spaces) whose condition compares the subcommand is dropped when
 * false for `sub`; when true on the subcommand alone its body takes its place,
 * and a body that ends in a `return` ends the case there; otherwise it stays,
 * its comparisons replaced by their values. `{ lines, unsupported }`.
 */
export function caseLinesFor(lines, sub, indent = 8) {
  const out = [];
  const unsupported = [];
  const pad = ' '.repeat(indent);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!(line.startsWith(`${pad}if (`) && indentOf(line) === indent && /\bsubcommand [!=]==/.test(line))) { out.push(line); continue; }
    // The condition: from `if (` to its closing parenthesis, on this line.
    const open = line.indexOf('(');
    let depth = 0;
    let close = -1;
    for (let j = open; j < line.length; j++) {
      if (line[j] === '(') depth++;
      else if (line[j] === ')' && --depth === 0) { close = j; break; }
    }
    if (close < 0) { unsupported.push(`a condition on the subcommand spans lines: ${line.trim()}`); out.push(line); continue; }
    const condition = line.slice(open + 1, close);
    const after = line.slice(close + 1).trim();
    let body;
    let end = i;
    if (after === '{') {
      end = lines.findIndex((l, j) => j > i && indentOf(l) === indent && l.trim().startsWith('}'));
      if (end < 0 || lines[end].trim() !== '}') { unsupported.push(`a condition on the subcommand has an else branch or no end: ${line.trim()}`); out.push(line); continue; }
      body = lines.slice(i + 1, end).map((l) => l.slice(Math.min(2, indentOf(l))));
    } else if (after.endsWith(';')) {
      body = [`${pad}${after}`];
    } else {
      unsupported.push(`a statement under a condition on the subcommand spans lines: ${line.trim()}`);
      out.push(line);
      continue;
    }
    const value = conditionFor(condition, sub);
    const onlySubcommand = condition.replace(COMPARISON, '').replace(/[\s()!&|]/g, '') === '';
    const block = lines.slice(i + 1, end + 1);
    i = end;
    if (value === false) continue;
    const fixed = condition.replace(COMPARISON, (m, op, s) => String((s === sub) !== (op === '!')));
    if (value === true) {
      // Known true for `sub`: the body runs, and the condition's other
      // operands are still read.
      if (!onlySubcommand) out.push(`${pad}void (${fixed});`);
      out.push(...body);
      // The last statement at the body's top level: a line at that indentation
      // that does not close a bracket a statement above it opened.
      const last = body.filter((l) => l.trim() !== '' && indentOf(l) === indent && !/^[)\]}]/.test(l.trim())).at(-1);
      if (last !== undefined && /^return\b/.test(last.trim())) break;
      continue;
    }
    out.push(`${line.slice(0, open + 1)}${fixed}${line.slice(close)}`, ...block);
  }
  return { lines: out, unsupported };
}

// ── The contracts ───────────────────────────────────────────────────────────

/** Whether cliParseFlags refuses a flag with no value (true) or reads it as '' (false), from its code; throws when it shows neither or both. */
function parserValues(body) {
  const strict = /=== undefined \|\| \w+\.startsWith\('--'\)\) \{\s*\n\s*throw\b/.test(body);
  const lenient = /=== undefined \|\| \w+\.startsWith\('--'\)\) \{[\s\S]{0,400}?value = '';/.test(body);
  if (strict === lenient) throw new Error('cliParseFlags shows neither or both ways to read a flag with no value');
  return strict;
}

/**
 * The CLI contract of a state.mjs (persona or orchestrator), read from its
 * source: `{ subs, global, textFile, strictValues, presence, action }`, where
 * `subs` maps each subcommand to `{ accepted, required, rejected, capability,
 * partial, unsupported }`. Throws when the source does not keep the shape it is
 * read by, rather than return a contract that accepts nothing or everything.
 */
export function stateCliContract(source) {
  const lines = source.split('\n');
  const start = lines.indexOf('async function cliRun(subcommand, flags) {');
  if (start < 0) throw new Error('no `async function cliRun(subcommand, flags) {` line');
  const groups = [];
  let group = null;
  for (let i = start + 1; i < lines.length && lines[i] !== '}'; i++) {
    const label = /^ {6}case '([a-z0-9-]+)':(?: \{)?$/.exec(lines[i]);
    if (label) {
      if (group === null || codeLines(group.body).some((l) => l.trim() !== '')) {
        group = { subs: [], body: [] };
        groups.push(group);
      }
      group.subs.push(label[1]);
      continue;
    }
    if (/^ {6}case\b/.test(lines[i])) throw new Error(`a case label of cliRun is not read: ${lines[i].trim()}`);
    if (/^ {6}default:/.test(lines[i])) { group = null; continue; }
    if (group !== null) group.body.push(lines[i]);
  }
  if (groups.length === 0) throw new Error('cliRun has no `case` at six spaces');
  const subs = new Map();
  for (const g of groups) {
    for (const sub of g.subs) {
      const shared = g.subs.length > 1;
      const own = shared ? caseLinesFor(codeLines(g.body), sub) : { lines: codeLines(g.body), unsupported: [] };
      const body = own.lines.join('\n');
      const reads = flagReadsFollowed(source, body, 'flags', 8);
      const capability = /^ {8}if \(!capabilityOn\('([a-z_]+)'\)\) return unknownSubcommand\(subcommand\);/m.exec(body)?.[1] ?? null;
      const unsupported = [...own.unsupported, ...reads.unsupported];
      if (shared) {
        for (const l of own.lines) {
          if (/\bsubcommand\b/.test(l.replace(/unknownSubcommand\(subcommand\)/g, '')) && /\bflags\b/.test(l)) {
            unsupported.push(`the case shared by ${g.subs.join(', ')} reads flags on a line that tests the subcommand: ${l.trim()}`);
          }
        }
      }
      subs.set(sub, { accepted: reads.accepted, required: reads.required, rejected: reads.rejected, rejectedUnless: reads.rejectedUnless, capability, partial: reads.partial, unsupported });
    }
  }
  const main = topLevelFunction(source, 'cliMain');
  if (main === null) throw new Error('no top-level cliMain');
  // Read, not assigned: cliMain hands the admission action in as a flag.
  const global = new Set([...main.body.matchAll(/\bflags\[(['"])([a-z][a-z0-9-]*)\1\](?!\s*=(?!=))/g)].map((m) => m[2]));
  const textList = /^const TEXT_FILE_FLAGS = \[([^\]]*)\];$/m.exec(source);
  if (!textList) throw new Error('no `const TEXT_FILE_FLAGS = [...]` line');
  const parser = topLevelFunction(source, 'cliParseFlags');
  if (parser === null) throw new Error('no top-level cliParseFlags');
  const presence = new Map();
  const presenceFn = topLevelFunction(source, 'cliPresenceFlags');
  if (presenceFn !== null) {
    const sub = /subcommand !== '([a-z0-9-]+)'/.exec(presenceFn.body);
    if (!sub) throw new Error('cliPresenceFlags names no subcommand');
    presence.set(sub[1], new Set([...presenceFn.body.matchAll(/a === '--([a-z][a-z0-9-]*)'/g)].map((m) => m[1])));
  }
  // `admission <join|check|release>`: the subcommand that takes its action as
  // a word, the flag cliMain hands it in, and the words its case compares.
  let action = null;
  const word = /subcommand === '([a-z0-9-]+)' && args\.length > 0 && !args\[0\]\.startsWith\('--'\)/.exec(main.body);
  if (word) {
    const flag = /flags\['([a-z-]+)'\] = action;/.exec(main.body)?.[1];
    const caseBody = groups.find((g) => g.subs.includes(word[1]))?.body.join('\n');
    if (!flag || caseBody === undefined) throw new Error(`the action word of ${word[1]} reaches no flag its case reads`);
    const holder = new RegExp(`const (\\w+) = flags\\['${escapeRe(flag)}'\\];`).exec(caseBody)?.[1];
    const values = holder ? new Set([...caseBody.matchAll(new RegExp(`\\b${holder} === '([a-z-]+)'`, 'g'))].map((m) => m[1])) : new Set();
    if (values.size === 0) throw new Error(`the action words of ${word[1]} are not compared in its case`);
    action = { sub: word[1], flag, values };
  }
  return {
    subs,
    global,
    textFile: new Set(literals(textList[1])),
    strictValues: parserValues(parser.body),
    equals: /\.indexOf\('='\)/.test(parser.body),
    repeatable: new Set([...parser.body.matchAll(/name === '([a-z][a-z0-9-]*)'\) \(flags\[name\] \?\?= \[\]\)\.push/g)].map((m) => m[1])),
    presence,
    action,
  };
}

/**
 * The CLI contract of a peer-runner.mjs: `{ subs, flags, global }`, where
 * `flags` maps each flag its parser takes to `{ key, value }` (the option it
 * sets and whether a value follows), `subs` each subcommand to the flags it
 * reads, `{ accepted, required }`, and `global` the flags cliMain reads for
 * every subcommand.
 */
export function peerRunnerContract(source) {
  const parser = topLevelFunction(source, 'parseCliArgs');
  if (parser === null) throw new Error('no top-level parseCliArgs');
  const flags = new Map();
  const loop = parser.body.split('\n');
  for (let i = 0; i < loop.length; i++) {
    const labels = [];
    while (i < loop.length && /^ {6}case '--[a-z][a-z0-9-]*':$/.test(loop[i])) labels.push(/'--([a-z0-9-]+)'/.exec(loop[i++])[1]);
    if (labels.length === 0) continue;
    let set = null;
    for (; i < loop.length && !/^ {8}break;$/.test(loop[i]); i++) set ??= /^ {8}opts\.(\w+) = (.*);$/.exec(loop[i]);
    if (set === null) throw new Error(`parseCliArgs sets nothing for --${labels.join(', --')}`);
    for (const n of labels) flags.set(n, { key: set[1], value: /rest\[\+\+i\]/.test(set[2]) });
  }
  if (flags.size === 0) throw new Error('parseCliArgs takes no flag');
  // An option the parser derives from another (`opts.summary = …opts.summaryFile…`):
  // the source flag counts wherever the derived option is read.
  const derived = new Map();
  for (const m of parser.body.matchAll(/\bopts\.(\w+) = [^;\n]*\bopts\.(\w+)\b/g)) derived.set(m[2], m[1]);
  const keyFlags = (key) => [...flags].filter(([, f]) => f.key === key || derived.get(f.key) === key).map(([n]) => n);
  const run = topLevelFunction(source, 'cliRun');
  if (run === null) throw new Error('no top-level cliRun');
  const subs = new Map();
  const blocks = run.body.split(/^ {4}if \(opts\.subcommand === '/m).slice(1);
  if (blocks.length === 0) throw new Error('cliRun dispatches no subcommand');
  for (const block of blocks) {
    const name = /^([a-z0-9-]+)'\) \{/.exec(block)?.[1];
    const close = /^ {4}\}$/m.exec(block);
    if (!name || !close) throw new Error(`a subcommand block of cliRun is not read: ${block.slice(0, 40)}`);
    const body = block.slice(0, close.index);
    const accepted = new Set();
    for (const m of body.matchAll(/\bopts\.(\w+)/g)) for (const n of keyFlags(m[1])) accepted.add(n);
    const required = new Set();
    for (const m of body.matchAll(/if \((?:!opts\.(\w+)|opts\.(\w+) === undefined)\) throw/g)) {
      const key = m[1] ?? m[2];
      for (const n of keyFlags(key)) if (flags.get(n).key === key) required.add(n);
    }
    subs.set(name, { accepted, required });
  }
  const main = topLevelFunction(source, 'cliMain');
  if (main === null) throw new Error('no top-level cliMain');
  const global = new Set();
  for (const m of main.body.matchAll(/\bopts\.(\w+)/g)) for (const n of keyFlags(m[1])) global.add(n);
  return { subs, flags, global };
}

// ── The calls ───────────────────────────────────────────────────────────────

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh']);
// The root is a variable, or a `<placeholder>` a skill names it by (read here
// after placeholders became `_name_`).
const INVOCATION = /\bnode(?:\s+-[-\w=]+)*\s+"?(?:\$\{?([A-Z_]+)\}?|_([a-z][a-z-]*)_)\/scripts\/([a-z0-9-]+\.mjs)"?/g;

/**
 * Every `node "$ROOT/scripts/<script>.mjs" …` call in the shell blocks of a
 * markdown document (indented fences too), the root a variable or a
 * `<placeholder>`: `{ label, line, root, script, words, expands }` (`root` the
 * variable's name, or the placeholder with its brackets), where `words` are the call's words as the shell reads them (a word
 * that still holds a `$` expands at run time). A file-descriptor number before
 * a redirection (`2>/dev/null`) is no word, and a `<placeholder>` the reader
 * fills in is one. `parse` carries stripComments, words and readWord of
 * tests/persona-pipeline/_verb-runbooks.mjs.
 */
export function cliInvocations(text, label, parse) {
  const out = [];
  for (const { joined, lineAt } of shellCallTexts(text, parse)) {
    for (const m of joined.matchAll(INVOCATION)) {
      const at = m.index;
      const stop = {};
      const raws = parse.words(joined, at + m[0].length, stop);
      const stopAt = stop.char === '&' && joined[stop.at + 1] === '>' ? '&>' : stop.char;
      const call = {
        label,
        line: lineAt(at),
        root: m[1] ?? `<${m[2]}>`,
        script: m[3],
        words: raws.map((raw) => parse.readWord(raw, {})),
        // A `$` outside single quotes expands at run time; inside them it is text.
        expands: raws.map((raw) => raw.replace(/'[^']*'/g, '').includes('$')),
      };
      // A `<`, `>` or `&>` left where the words end is a redirection the
      // reading does not take (a process substitution, a target holding a
      // command substitution, one with no blank before it): the words after it
      // would be dropped, so the call is cut there.
      if (stopAt === '<' || stopAt === '>' || stopAt === '&>') call.cut = `the words end at a ${stopAt} the reading does not take`;
      // Words that run to the end of the block inside a quote or a `$(` never
      // closed (a quoting typo) are no call the shell would run as read: the
      // call is cut there too, not checked on what the split swallowed.
      if (stop.open) call.cut = `the words end inside an unterminated ${stop.open}`;
      out.push(call);
    }
  }
  return out;
}

// A call of a checked script read loosely: `node`, its options, and one word
// ending in /scripts/state.mjs or /scripts/peer-runner.mjs that opens with a
// root (a variable, or a placeholder, `_name_` once read).
const LOOSE_CALL = /\bnode(?:\s+-\S+)*\s+["']?(?:\$|_[a-z])\S*?\/scripts\/(state|peer-runner)\.mjs(?![\w.-])/g;

/**
 * The calls of state.mjs and peer-runner.mjs in the shell blocks of a markdown
 * document that cliInvocations does not read (a spelling its INVOCATION does
 * not take): `{ label, line, text }` each. Read on the same comment-stripped,
 * continuation-joined text as cliInvocations, call by call, so a second call
 * on a line, or one split across lines, is held to it as well. A fence left
 * open is one entry too: no reader sees the block it opens, and the fences
 * after a lost one pair up wrongly.
 */
export function cliUnscannedCalls(text, label, parse) {
  const out = [];
  const { unclosed } = fencedBlocks(text);
  if (unclosed !== null) out.push({ label, line: unclosed.start - 1, text: `a ${unclosed.marker} fence that is never closed` });
  for (const { joined, lineAt } of shellCallTexts(text, parse)) {
    const scanned = new Set([...joined.matchAll(INVOCATION)].map((m) => m.index));
    for (const m of joined.matchAll(LOOSE_CALL)) {
      if (!scanned.has(m.index)) out.push({ label, line: lineAt(m.index), text: m[0] });
    }
  }
  return out;
}

/** Each shell block's text as the call readers read it: `{ joined, lineAt(offset) }`. */
function shellCallTexts(text, parse) {
  const out = [];
  for (const block of fencedBlocks(text)) {
    if (!SHELL_LANGS.has(block.lang)) continue;
    const stripped = parse.stripComments(block.lines.join('\n'));
    const joins = [];
    const joined = stripped
      .replace(/\\\n[ \t]*/g, (m, offset) => {
        joins.push({ offset, removed: m.length - 1 });
        return ' ';
      })
      // A `<placeholder>` is one word, its `|` alternatives included.
      .replace(/<([A-Za-z][A-Za-z0-9_|.-]*)>/g, (m, inner) => `_${inner.replace(/\|/g, "_")}_`);
    const blanked = blankRedirections(joined);
    // A call's offset in `stripped`: each join before it took out its
    // backslash-newline and indentation, leaving one space.
    const lineAt = (at) => {
      let shift = 0;
      for (const j of joins) if (j.offset - shift < at) shift += j.removed;
      return block.start + stripped.slice(0, at + shift).split('\n').length - 1;
    };
    out.push({ joined: blanked, lineAt });
  }
  return out;
}

// A redirection's target: one shell word of quoted and unquoted parts that
// holds no command substitution (`$(` or a backtick), ending where the word
// ends. A target that holds one, or ends inside a word, is not taken, so the
// call's words stop at its operator (cut) and a call inside it stays readable.
const TARGET_PART = String.raw`"(?:[^"\\$\x60\n]|\\.|\$(?!\())*"|'[^'\n]*'|[^\s;&|()<>'"\\$\x60]|\$(?!\()`;
const WORD_END = String.raw`(?=[\s;&|)<>]|$)`;
const REDIRECTION = new RegExp(String.raw`(?:\d*<<<[ \t]*(?:${TARGET_PART})+${WORD_END}|\d*<<-?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z0-9_.-]+))${WORD_END}|(?:&>>|&>|\d*(?:>>|>|<))(?:&(?:\d+|-)${WORD_END}|[ \t]*(?:${TARGET_PART})+${WORD_END}))`, 'y');

/**
 * `text` with each redirection the reading takes blanked to spaces (offsets
 * kept): a heredoc's or here-string's operator and delimiter or word, and a
 * redirection with its target, each standing after a blank outside quotes. They
 * are no words of the command, and the words after them still are
 * (`2>/dev/null --x y` passes --x y). A heredoc's body is left as it is, and
 * no quote in it is read as one.
 */
function blankRedirections(text) {
  const out = text.split('');
  const stack = [{ kind: 'code', depth: 0 }];
  const heredocs = [];
  for (let i = 0; i < text.length;) {
    const top = stack[stack.length - 1];
    const c = text[i];
    if (top.kind === 'single') { if (c === "'") stack.pop(); i++; continue; }
    if (top.kind === 'double') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') stack.pop();
      else if (c === '$' && text[i + 1] === '(') { stack.push({ kind: 'subst', depth: 0 }); i += 2; continue; }
      i++;
      continue;
    }
    // Code, or a command substitution's code. At a line end, the bodies of
    // the heredocs the line opened are passed over, up to each delimiter line.
    if (c === '\n' && heredocs.length > 0) {
      i++;
      while (heredocs.length > 0 && i < text.length) {
        const e = text.indexOf('\n', i);
        const line = e === -1 ? text.slice(i) : text.slice(i, e);
        i = e === -1 ? text.length : e + 1;
        if (line.replace(/^\t+/, '') === heredocs[0]) heredocs.shift();
      }
      continue;
    }
    if (/[\d<>&]/.test(c) && /\s/.test(text[i - 1] ?? '')) {
      REDIRECTION.lastIndex = i;
      const m = REDIRECTION.exec(text);
      if (m !== null && /[<>]/.test(m[0])) {
        const delimiter = m[1] ?? m[2] ?? m[3];
        if (delimiter !== undefined) heredocs.push(delimiter);
        for (let k = i; k < i + m[0].length; k++) if (out[k] !== '\n') out[k] = ' ';
        i += m[0].length;
        continue;
      }
    }
    // A heredoc the reading does not blank (no blank before it) still has a body.
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      const h = /^<<-?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z0-9_.-]+))/.exec(text.slice(i, i + 200));
      if (h !== null) { heredocs.push(h[1] ?? h[2] ?? h[3]); i += h[0].length; continue; }
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'") stack.push({ kind: 'single' });
    else if (c === '"') stack.push({ kind: 'double' });
    else if (c === '$' && text[i + 1] === '(') { stack.push({ kind: 'subst', depth: 0 }); i += 2; continue; }
    else if (top.kind === 'subst' && c === '(') top.depth++;
    else if (top.kind === 'subst' && c === ')') { if (top.depth > 0) top.depth--; else stack.pop(); }
    i++;
  }
  return out.join('');
}

/**
 * The problems of one call against the contract of the CLI it runs:
 * `{ sub, status, problems, partial }`. `status` is `checked`, or
 * `unsupported` (reasons in `partial`) when no rule could be applied. `kind` is
 * `state` or `peer-runner`; `capabilities`, the persona's (persona.json), when
 * the CLI is a persona's state.mjs. A word expands at run time when
 * `call.expands` says so (by its value alone when the call carries none). A
 * call cliInvocations cut short (`call.cut`) is `unsupported`.
 */
export function cliCallProblems(call, kind, contract, capabilities = null) {
  const where = `${call.label}:${call.line} ${call.script}`;
  const expanding = call.words.map((w, i) => call.expands?.[i] ?? w.includes('$'));
  // Each word's literal text: readWord marks an unquoted expansion
  // `<unquoted>`, and a flag name before it (`--x=$V`) is still literal.
  const literal = call.words.map((w) => w.replace(/^<unquoted>/, ''));
  const [sub, ...rest] = literal;
  if (sub === undefined || sub.startsWith('-')) return { sub: null, status: 'checked', problems: [`${where}: no subcommand`], partial: [] };
  if (expanding[0]) return { sub, status: 'unsupported', problems: [], partial: ['the subcommand expands at run time'] };
  if (call.cut !== undefined) return { sub, status: 'unsupported', problems: [], partial: [call.cut] };
  const spec = contract.subs.get(sub);
  if (spec === undefined) return { sub, status: 'checked', problems: [`${where} ${sub}: no such subcommand`], partial: [] };
  if (spec.unsupported?.length > 0) return { sub, status: 'unsupported', problems: [], partial: [...spec.unsupported] };
  const problems = [];
  const partial = [...(spec.partial ?? [])];
  const capabilityOff = (c) => capabilities !== null && capabilities[c] !== true;
  if (kind === 'state' && spec.capability && capabilityOff(spec.capability)) {
    problems.push(`${where} ${sub}: the subcommand needs capability ${spec.capability}, which this persona has off`);
  }
  let args = rest;
  let flagsExpand = expanding.slice(1);
  const takesAction = kind === 'state' && contract.action?.sub === sub;
  const actionWord = takesAction && args[0] !== undefined && !args[0].startsWith('--');
  if (actionWord) {
    if (flagsExpand[0]) partial.push('the action word expands at run time');
    else if (!contract.action.values.has(args[0])) problems.push(`${where} ${sub}: no such action ${args[0]}`);
    args = args.slice(1);
    flagsExpand = flagsExpand.slice(1);
  }
  if (kind === 'peer-runner') partial.push('flags a peer-runner subcommand requires past cliRun are not checked');
  const given = [];
  let open = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const eq = w.indexOf('=');
    const name = w.startsWith('--') ? w.slice(2, eq === -1 ? undefined : eq) : null;
    // A word that expands where a flag stands is open, unless its flag name
    // is literal and only its `=value` expands.
    if (name === null || name.includes('$')) {
      if (flagsExpand[i] || name !== null) { open = true; continue; }
      problems.push(`${where} ${sub}: positional argument ${JSON.stringify(w)}`);
      continue;
    }
    given.push(name);
    // state.mjs's parser takes no value that opens with `--`, so there a word
    // whose literal text opens with `--` is a flag, whatever expands after it.
    // peer-runner's takes the next word whatever it holds: a word that expands
    // is its value, and only a literal `--…` word is read as the next flag.
    const next = args[i + 1];
    const hasValue = next !== undefined && (kind === 'peer-runner' ? flagsExpand[i + 1] || !next.startsWith('--') : !next.startsWith('--'));
    if (kind === 'peer-runner') {
      const f = contract.flags.get(name);
      if (eq !== -1) { problems.push(`${where} ${sub}: --${name}=… is no flag of the parser (it takes no = form)`); continue; }
      if (f === undefined) { problems.push(`${where} ${sub}: --${name} is no flag of the parser`); continue; }
      if (f.value) {
        if (hasValue) i++;
        else problems.push(`${where} ${sub}: --${name} has no value`);
      }
      if (!spec.accepted.has(name) && !contract.global.has(name)) problems.push(`${where} ${sub}: --${name} is not read by ${sub}`);
      continue;
    }
    if (eq !== -1 && !contract.equals) { problems.push(`${where} ${sub}: --${name}=… is not split by the parser (it takes no = form)`); continue; }
    const presence = contract.presence.get(sub)?.has(name) === true;
    if (!presence && eq === -1) {
      if (hasValue) i++;
      else if (contract.strictValues) problems.push(`${where} ${sub}: --${name} has no value`);
    }
    if (spec.rejected.has(name)) { problems.push(`${where} ${sub}: --${name} is refused by ${sub}`); continue; }
    const base = name.endsWith('-file') && contract.textFile.has(name.slice(0, -5)) ? name.slice(0, -5) : name;
    for (const [c, names] of spec.rejectedUnless ?? []) {
      if (names.has(base) && capabilityOff(c)) problems.push(`${where} ${sub}: --${name} is refused by ${sub} while capability ${c} is off`);
    }
    if (!presence && !spec.accepted.has(base) && !contract.global.has(base)) problems.push(`${where} ${sub}: --${name} is not read by ${sub}`);
  }
  // Each flag once (the last of two would win, or the parser refuses); a text
  // flag in one form only.
  const repeatable = contract.repeatable ?? new Set();
  for (const name of new Set(given)) {
    if (given.filter((g) => g === name).length > 1 && !repeatable.has(name)) problems.push(`${where} ${sub}: --${name} is given more than once`);
    if (kind === 'state' && contract.textFile.has(name) && given.includes(`${name}-file`)) problems.push(`${where} ${sub}: --${name} and --${name}-file are both given`);
  }
  // With no action word, the action comes from the flag cliMain hands it in
  // (`--admission-action join`), or the case runs with none and refuses.
  if (takesAction && !actionWord) {
    const at = args.findIndex((w) => w === `--${contract.action.flag}` || w.startsWith(`--${contract.action.flag}=`));
    const values = [...contract.action.values].join(', ');
    if (at === -1) {
      if (!open) problems.push(`${where} ${sub}: no action (one of ${values}), as a word after ${sub} or --${contract.action.flag}`);
    } else {
      const eq = args[at].indexOf('=');
      const value = eq === -1 ? args[at + 1] : args[at].slice(eq + 1);
      const valueExpands = eq === -1 ? flagsExpand[at + 1] : flagsExpand[at];
      // A flag with no value (a lenient parser makes it '') names no action.
      if (value === undefined || (eq === -1 && value.startsWith('--')) || value === '') problems.push(`${where} ${sub}: --${contract.action.flag} names no action (one of ${values})`);
      else if (!valueExpands && !contract.action.values.has(value)) problems.push(`${where} ${sub}: no such action ${value}`);
    }
  }
  if (open) partial.push('arguments expand at run time: required flags not checked');
  else {
    for (const r of spec.required) {
      const met = given.includes(r) || (kind === 'state' && contract.textFile.has(r) && given.includes(`${r}-file`));
      if (!met) problems.push(`${where} ${sub}: required --${r} is missing`);
    }
  }
  return { sub, status: 'checked', problems, partial };
}
