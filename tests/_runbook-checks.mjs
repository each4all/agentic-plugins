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

/** Fenced blocks as `{ lang, start, lines }`, indentation removed; `start` is the 1-based line of the first body line. */
export function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const fence = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    if (open === null) {
      if (fence) open = { indent: fence[1].length, marker: fence[2], lang: fence[3].trim(), start: i + 2, lines: [] };
      return;
    }
    if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && fence[3].trim() === '') {
      blocks.push(open);
      open = null;
      return;
    }
    open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
  });
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

