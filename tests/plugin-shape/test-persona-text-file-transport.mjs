// Persona text-file transport (C130, ADR-0059's amendment of 2026-10-10).
//
// WHY THIS EXISTS. A runbook block that has the agent splice text it wrote —
// or copied from a peer or the user — into shell source runs that text: a
// backtick or `$(…)` in a phase note ran as a command, and the quoted heredoc
// the persona finalize blocks used ended at a line reading its delimiter and
// ran the rest (measured 2026-10-10, bash and zsh). The amendment's rule:
// such text reaches the CLI as a file the agent writes with its file-writing
// tool, and the block passes `--<name>-file`. This file keeps the class out of
// the three persona plugins and their canonical sources:
//
//   commands  plugins/<persona>/commands/*.md, the Claude runbooks
//   skills    plugins/<persona>/core/skills/**/*.md, the Codex skill bodies
//             and the references
//   regions   persona-pipeline/regions/*.md, the templates they render from
//   manifest  persona-pipeline/manifest.json, the prose values a region
//             substitutes
//   agents    plugins/<persona>/core/skills/**/agents/openai.yaml
//
// The rules:
//
//   R1  In a shell fence: no heredoc; no assignment of agent text to the
//       variables the retired forms used; no placeholder assigned to a
//       variable outside PLACEHOLDER_VARS (the agent's directories, enums,
//       and a path a program printed), so a user's path or words never
//       become shell source; no free-text flag given an inline value unless
//       that value is one of ALLOWED_INLINE (fixed literals, an enum
//       placeholder, and the expansion of what a program printed), each of
//       which must still occur, and no text or file flag with its value
//       glued on by `=`; NEXT_ACTION assigned only fixed literals (no
//       placeholder, `$` or backtick); no shell writer (`printf`, `echo`,
//       `cat`, `tee`), indented or not, that sends a placeholder the agent
//       fills to a file, which is the file tool's job; every text file
//       flag's value quoted, so a directory with a space in its name still
//       names one file.
//   R2  In prose, a manifest value or an agent's default prompt: no
//       free-text flag followed by a placeholder or quoted text — the -file
//       form is named instead. `--prompt-text "..."` is the user's command
//       grammar (an argument hint, an entry path, an intake bullet, a
//       default prompt) and stays in prose; R1 keeps it out of every block.
//   R3  A block that reads the agent's files opens with the TEXT_DIR
//       placeholder line, never checks them with `[ -s ]`, which passes a
//       file holding only a newline that the scripts refuse as empty, and
//       its own section (the text from the nearest heading above it) names
//       the private directory step, the file-writing tool and each file the
//       block reads. That a block checks its files at all, and by which
//       rule, is the runbook contracts' to hold.
//
// Each rule is checked to bite: a violation planted in a copy of one real
// document is reported, by file, rule and text, for each corpus class and
// for each sub-rule above (R2 in the prose of each Markdown class, too).
// tests/persona-pipeline/test-runbook-contracts.mjs and
// test-verb-runbook-runs.mjs run the blocks with hostile files; this file
// reads the text.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PERSONAS = ['designer', 'engineer', 'founder'];
const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

/** Every file under `dir`, recursively. */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** The corpus: `[class, label, text]`, one entry per document or manifest value. */
function corpus() {
  const out = [];
  for (const persona of PERSONAS) {
    const root = join(REPO_ROOT, 'plugins', persona);
    for (const f of walk(join(root, 'commands')).filter((p) => p.endsWith('.md'))) out.push(['commands', rel(f), readFileSync(f, 'utf8')]);
    for (const f of walk(join(root, 'core'))) {
      if (f.endsWith('.md')) out.push(['skills', rel(f), readFileSync(f, 'utf8')]);
      else if (f.endsWith('/agents/openai.yaml')) out.push(['agents', rel(f), readFileSync(f, 'utf8')]);
    }
  }
  for (const f of walk(join(REPO_ROOT, 'persona-pipeline', 'regions')).filter((p) => p.endsWith('.md'))) out.push(['regions', rel(f), readFileSync(f, 'utf8')]);
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'persona-pipeline', 'manifest.json'), 'utf8'));
  for (const region of manifest.regions) {
    for (const [name, sub] of Object.entries(region.substitutions ?? {})) {
      if (typeof sub.value === 'string') out.push(['manifest', `persona-pipeline/manifest.json#${region.id}.${name}`, sub.value]);
    }
  }
  return out;
}

const SHELL = /^(bash|sh|zsh|shell)$/;

/** Fenced blocks as `{ shell, start, text }` (start: 1-based first body line), and the prose between them. */
function split(text) {
  const blocks = [];
  const prose = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    const fence = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (fence) open = { indent: fence[1].length, marker: fence[2], info: fence[3].trim(), start: i + 2, lines: [] };
      else prose.push(line);
      return;
    }
    if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && fence[3].trim() === '') {
      blocks.push({ shell: SHELL.test(open.info), start: open.start, text: open.lines.join('\n') });
      open = null;
      return;
    }
    open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
  });
  return { blocks, prose: prose.join('\n') };
}

/**
 * The words of a shell block as the shell splits them, comments dropped, each
 * `{ raw, line }` with its quotes kept; a heredoc operator is its own word.
 * A command substitution's words are words too, each listed where it starts
 * (after the word that holds it), so a flag inside
 * `ACTIVE="$(node … create --x "…")"` is followed by its own value, and a
 * value holding a substitution follows its flag. A quoted string may span
 * lines (peer-now's note does).
 */
function shellWords(block) {
  const words = [];
  let line = 1;
  let i = 0;
  // A double-quoted string from block[i] (the quote), its command
  // substitutions lexed as code; returns the index after the closing quote.
  const double = () => {
    i++;
    while (i < block.length && block[i] !== '"') {
      if (block[i] === '\\') { i += 2; continue; }
      if (block[i] === '\n') line++;
      if (block[i] === '$' && block[i + 1] === '(') { i += 2; code(true); continue; }
      i++;
    }
    i++;
  };
  // Code until the end, or until the `)` that closes a substitution.
  const code = (inSubst) => {
    let cur = null;
    let depth = 0;
    // A word is listed when it starts; its raw text grows as it is read.
    const flush = () => { cur = null; };
    while (i < block.length) {
      const c = block[i];
      if (c === '\n') { flush(); line++; i++; continue; }
      if (c === ' ' || c === '\t') { flush(); i++; continue; }
      if (c === '#' && cur === null) { while (i < block.length && block[i] !== '\n') i++; continue; }
      if (c === '\\' && block[i + 1] === '\n') { flush(); line++; i += 2; continue; }
      if (c === ')' && inSubst && depth === 0) { flush(); i++; return; }
      if (c === '<' && block[i + 1] === '<' && block[i + 2] !== '<') { flush(); words.push({ raw: '<<', line }); i += 2; continue; }
      if (cur === null) { cur = { raw: '', line }; words.push(cur); }
      const from = i;
      if (c === "'") {
        i = block.indexOf("'", i + 1);
        i = i < 0 ? block.length : i + 1;
        line += (block.slice(from, i).match(/\n/g) ?? []).length;
      } else if (c === '"') {
        double();
      } else if (c === '$' && block[i + 1] === '(') {
        i += 2;
        code(true);
      } else {
        if (c === '(') depth++;
        if (c === ')') depth--;
        i++;
      }
      cur.raw += block.slice(from, i);
    }
    flush();
  };
  code(false);
  return words;
}

// The flags whose value is free text: since the amendment each has a -file twin.
const TEXT_FLAGS = ['--phase-note', '--summary', '--next-action', '--original-request', '--resolution', '--decision', '--architecture', '--subject', '--subject-pkg', '--prompt-text'];
// The file flags a block passes the agent's files with, and the prompt's.
const FILE_FLAGS = ['--phase-note-file', '--summary-file', '--next-action-file', '--original-request-file', '--resolution-file', '--subject-file', '--subject-pkg-file', '--prompt-file'];
// The variables the retired forms carried agent text in.
const TEXT_VARS = /^(NOTE|SUMMARY|RESOLUTION|OWNER_RESOLUTION|APPROVED_SUBJECT|SUBJECT|PROMPT_ARG|PROMPT_TEXT|REQUEST)=/;
// The variables a block may have the agent fill from a placeholder: the
// directories it created with mktemp, enums it validated, and a workflow path
// a program printed. ARCHIVE_WORKFLOW_ID, the user's `archive <workflow-id>`,
// predates C130 and stays until resolve-workflow takes the id from a file.
const PLACEHOLDER_VARS = new Set(['TEXT_DIR', 'ARGS_DIR', 'PEER', 'CONVERGED', 'AGENTIC_DESIGNER_PROFILE', 'WORKFLOW', 'ARCHIVE_WORKFLOW_ID']);

// The inline values a block may give a free-text flag: fixed literals, an
// enum placeholder (the profile), the expansion of a literal assigned in the
// block, and what a program printed. `<P>` stands for the persona's name.
const ALLOWED_INLINE = [
  ['--next-action', '"Run ${VERB} skill"'],
  ['--next-action', '"Run Phase 1 discover+frame+decide composite"'],
  ['--next-action', '"$NEXT_ACTION"'],
  ['--next-action', '"Owner decision, after a bounded consensus round: $PROPOSED"'],
  ['--next-action', '"Commit the confirmed staging set with /${PERSONA}:commit"'],
  ['--next-action', "'Commit the refined change; the recurring finding is deferred'"],
  ['--next-action', "'The recurring finding is deferred; the owner saves and commits the refined artifact'"],
  // decide's Owner selection: the declared next action, a literal the
  // generator escapes (ADR-0066 Decision 4), and its template.
  ['--next-action', '{{next_action}}'],
  ['--next-action', "'Compose the artifact for the chosen direction'"],
  ['--next-action', "'Compose the flows/specs for the chosen direction (/designer:compose)'"],
  ['--next-action', "'Compose the planning artifact for the chosen direction'"],
  // engineer's authored start: each phase's fixed next action.
  ['--next-action', '"Generate option candidates and gather supporting evidence"'],
  ['--next-action', '"Frame options across 5 perspectives"'],
  ['--next-action', '"Recommend direction and obtain user approval"'],
  ['--next-action', '"Map current codebase state and integration points"'],
  ['--next-action', '"Produce plan artifact"'],
  ['--next-action', '"Verify plan completeness and feasibility"'],
  ['--next-action', '"RED-GREEN-REFACTOR loop per planned task"'],
  ['--next-action', '"Multi-perspective code review + Codex working-tree review"'],
  ['--next-action', '"Address findings; converge or escalate same-finding recurrence"'],
  ['--phase-note', '"Resumed from prior verb."'],
  ['--phase-note', '"Resumed from prior verb. Profile=<...>."'],
  // peer-now's note: the run's ids and the head of the peer's stdout, which
  // the block reads from the run ledger (a program's output, not re-read).
  ['--phase-note', '"peer: $PEER\nrun_id: $RUN_ID\nhandle: $HANDLE_PATH\nprompt-mode: verbatim\n\n### Response\n\n$(head -c 4000 "$STDOUT_PATH")"'],
];
const allowedKey = (flag, value) => `${flag} ${value}`;
const ALLOWED = new Set(ALLOWED_INLINE.map(([f, v]) => allowedKey(f, v)));

// A free-text flag followed, in prose, by a placeholder or quoted text.
const PROSE_TEXT_FLAG = new RegExp(`(?<![\\w-])(${TEXT_FLAGS.filter((f) => f !== '--prompt-text').join('|')})(?![\\w-])(?:=|\\s+)(?:["'][^"'\\n]*["']|<[^>\\n]*>)`, 'g');
// The private-directory step and the TEXT_DIR line a reading block opens with.
const MKTEMP_STEP = 'mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"';
const TEXT_DIR_LINE = /^TEXT_DIR='<[^'>]+>'$/;

/** The offset of the last Markdown heading outside a fence (a shell comment is none), or 0. */
function lastHeading(text) {
  let at = 0;
  let offset = 0;
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : (f[1][0] === fence ? null : fence);
    else if (fence === null && /^#{1,6} /.test(line)) at = offset;
    offset += line.length + 1;
  }
  return at;
}

/** The rule violations of one corpus entry, each `<label>:<line>: <rule> — <text>`. */
function violations(kind, label, text) {
  const out = [];
  const stats = { blocks: 0, files: 0, inline: [] };
  const persona = PERSONAS.find((p) => label.startsWith(`plugins/${p}/`));
  const norm = (s) => (persona ? s.split(`'${persona}'`).join('<P>') : s);
  const { blocks, prose } = kind === 'manifest' || kind === 'agents' ? { blocks: [], prose: text } : split(text);
  for (const block of blocks.filter((b) => b.shell)) {
    stats.blocks++;
    const words = shellWords(block.text);
    const at = (w) => `${label}:${block.start + w.line - 1}`;
    words.forEach((w, k) => {
      if (w.raw === '<<') out.push(`${at(w)}: R1 heredoc — ${words[k + 1]?.raw ?? ''}`);
      if (TEXT_VARS.test(w.raw)) out.push(`${at(w)}: R1 agent text assigned — ${w.raw}`);
      const filled = /^([A-Z_][A-Z0-9_]*)=(['"])<[^'"]*\2$/.exec(w.raw);
      if (filled && !PLACEHOLDER_VARS.has(filled[1])) out.push(`${at(w)}: R1 placeholder assigned — ${w.raw}`);
      // `${PERSONA}` is the one expansion a fixed next action holds.
      if (/^NEXT_ACTION=/.test(w.raw) && !/^NEXT_ACTION=(?:'[^'<]*'|"[^"<`$]*"|\{\{next_action\}\})$/.test(w.raw.replace(/\$\{PERSONA\}/g, 'P'))) {
        out.push(`${at(w)}: R1 NEXT_ACTION assigned more than a fixed literal — ${w.raw}`);
      }
      // A value glued on by `=` is one word with its flag: the checks below,
      // which read the next word, would never see it.
      const glued = /^(--[\w-]+)=/.exec(w.raw);
      if (glued && (TEXT_FLAGS.includes(glued[1]) || FILE_FLAGS.includes(glued[1]))) out.push(`${at(w)}: R1 glued value — ${w.raw}`);
      if (TEXT_FLAGS.includes(w.raw)) {
        const value = words[k + 1]?.raw ?? '';
        if (w.raw === '--prompt-text' || !ALLOWED.has(allowedKey(w.raw, norm(value)))) out.push(`${at(w)}: R1 inline text — ${w.raw} ${value}`);
        else stats.inline.push(allowedKey(w.raw, norm(value)));
      }
      if (/^\$PROMPT_ARG\b|^\$\{PROMPT_ARG/.test(w.raw)) out.push(`${at(w)}: R1 unquoted prompt argument — ${w.raw}`);
      if (FILE_FLAGS.includes(w.raw)) {
        stats.files++;
        const value = words[k + 1]?.raw ?? '';
        if (!/^"\$[A-Z_{]/.test(value)) out.push(`${at(w)}: R1 unquoted file — ${w.raw} ${value}`);
      }
    });
    // R1: a shell writer that sends an agent placeholder to a file — the
    // retired splice again, through a file the shell wrote.
    const logical = block.text.replace(/\\\n[ \t]*/g, ' ').split('\n').filter((l) => !/^\s*#/.test(l));
    for (const l of logical) {
      if (/(^\s*|[;&|(]\s*)(printf|echo|cat|tee)\b/.test(l) && /["']<[^<>'"]*[A-Za-z][^<>'"]*>/.test(l) && (/(^|[^&>0-9])>>?\s*["']?[$/\w]/.test(l) || /\|\s*tee\b/.test(l))) {
        out.push(`${label}:${block.start}: R1 agent text written by the shell — ${l.trim()}`);
      }
    }
    // R3: a block that reads the agent's files names their directory first
    // (a comment that names a file form is no read).
    const reads = [...new Set(words.flatMap((w) => [...w.raw.matchAll(/"\$TEXT_DIR\/([\w.-]+)"/g)].map((m) => m[1])))];
    if (reads.length > 0) {
      // A template's capability tags render to nothing; engineer's start
      // bootstrap names its args directory first, in a branch of its own.
      const first = block.text.split('\n').find((l) => !/^\{\{[#^/]capability\b[^}]*\}\}$/.test(l) && !/^ARGS_DIR='<[^'>]+>'$/.test(l)) ?? '';
      if (!TEXT_DIR_LINE.test(first)) out.push(`${label}:${block.start}: R3 the block reads TEXT_DIR but does not open with its line — ${first}`);
      // `[ -s ]` passes a file holding only a newline, which every script
      // refuses as empty: a later script would refuse after an earlier wrote.
      for (const l of logical.filter((x) => /\[ -s /.test(x))) out.push(`${label}:${block.start}: R3 a [ -s ] check passes a blank file — ${l.trim()}`);
      // Its own section: from the nearest heading above it (a template has
      // none of its own: the whole template is the section).
      const preceding = text.slice(0, text.indexOf(block.text));
      const section = preceding.slice(lastHeading(preceding)).replace(/\s+/g, ' ');
      if (!section.includes(MKTEMP_STEP) || !/with (?:your|its|the) file-writing tool/i.test(section)) out.push(`${label}:${block.start}: R3 no mktemp step or file-writing step in the block's section`);
      for (const name of reads.filter((n) => n !== '$TEXT_FILE' && !section.includes(`\`${n}\``))) out.push(`${label}:${block.start}: R3 the section never names ${name}, which the block reads`);
    }
  }
  for (const m of prose.matchAll(PROSE_TEXT_FLAG)) {
    const line = prose.slice(0, m.index).split('\n').length;
    out.push(`${label}:${line}: R2 a text flag with its text — ${m[0]}`);
  }
  return { out, stats };
}

describe('persona text-file transport (C130, ADR-0059 amendment of 2026-10-10)', () => {
  const docs = corpus();

  it('the corpus reaches every class, in every persona (guards a vacuous pass)', () => {
    const counts = Object.fromEntries(['commands', 'skills', 'regions', 'manifest', 'agents'].map((k) => [k, docs.filter(([c]) => c === k).length]));
    for (const [k, n] of Object.entries(counts)) ok(n > 0, `${k}: ${n} documents`);
    for (const persona of PERSONAS) {
      for (const kind of ['commands', 'skills', 'agents']) ok(docs.some(([c, l]) => c === kind && l.startsWith(`plugins/${persona}/`)), `${persona}: ${kind}`);
      ok(docs.some(([, l]) => l === `plugins/${persona}/core/skills/peer-now/agents/openai.yaml`), `${persona}: the peer-now agent`);
    }
  });

  it('no block splices agent text into shell source, no prose names a text flag with its text, and every reading block opens with its directory (R1–R3)', () => {
    const all = docs.map(([kind, label, text]) => violations(kind, label, text));
    deepStrictEqual(all.flatMap((v) => v.out), []);
    // Non-vacuous by identity: the blocks were read, the file flags found in
    // each class that has blocks, and every allowed inline value still occurs
    // (a stale entry would let a reworded value through unseen).
    const blocks = all.reduce((n, v) => n + v.stats.blocks, 0);
    const files = all.reduce((n, v) => n + v.stats.files, 0);
    ok(blocks > 300, `only ${blocks} shell blocks read`);
    ok(files > 150, `only ${files} file flags read`);
    const used = new Set(all.flatMap((v) => v.stats.inline));
    deepStrictEqual(ALLOWED_INLINE.map(([f, v]) => allowedKey(f, v)).filter((k) => !used.has(k)), [], 'every allowed inline value occurs');
  });

  // Each rule bites in each class: a violation planted in a copy of a real
  // document is reported by its file, rule and text.
  describe('a planted violation is reported, per corpus class and rule', () => {
    const doc = (label) => {
      const found = docs.find(([, l]) => l === label);
      ok(found, label);
      return found;
    };
    const planted = (label, from, to, expected) => {
      const [kind, , text] = doc(label);
      // Contract: the case's own edit site — absent, the plant lands nowhere and proves nothing.
      strictEqual(text.split(from).length - 1, 1, `${label} holds ${JSON.stringify(from)} once`);
      deepStrictEqual(violations(kind, label, text).out, [], `${label} is clean before the plant`);
      const got = violations(kind, label, text.replace(from, () => to)).out;
      ok(got.some((v) => v.startsWith(`${label}:`) && v.includes(expected)), `${label}: expected ${JSON.stringify(expected)} in ${JSON.stringify(got)}`);
    };
    it('commands: a phase note given inline, a heredoc, an unquoted file', () => {
      planted('plugins/founder/commands/compose.md', '--phase-note-file "$TEXT_DIR/note.md"', '--phase-note "<the phase note above, filled in>"', 'R1 inline text — --phase-note "<the phase note above, filled in>"');
      planted('plugins/designer/commands/decide.md', 'grep -q \'[^[:space:]]\' "$TEXT_DIR/resolution.txt" 2>/dev/null ||', "IFS= read -r -d '' RESOLUTION <<'OWNER_RESOLUTION' || true\n<Owner selection: the direction>\nOWNER_RESOLUTION\ngrep -q '[^[:space:]]' \"$TEXT_DIR/resolution.txt\" 2>/dev/null ||", "R1 heredoc — 'OWNER_RESOLUTION'");
      planted('plugins/engineer/commands/checkpoint.md', '--summary-file "$TEXT_DIR/summary.txt"', '--summary-file $TEXT_DIR/summary.txt', 'R1 unquoted file — --summary-file $TEXT_DIR/summary.txt');
      planted('plugins/engineer/commands/compose.md', '--next-action "Run ${VERB} skill" --event resumed', '--next-action "Run ${VERB} skill now" --event resumed', 'R1 inline text — --next-action "Run ${VERB} skill now"');
    });
    it('skills: a Codex block with a placeholder subject, a prompt spliced unquoted', () => {
      planted('plugins/engineer/core/skills/commit/SKILL.md', '  --suggested-subjects\n', "  --subject '<confirmed subject>'\n", "R1 inline text — --subject '<confirmed subject>'");
      planted('plugins/founder/core/skills/peer-now/SKILL.md', '--prompt-file "$PROMPT_FILE" --output-format text', '$PROMPT_ARG --output-format text', 'R1 unquoted prompt argument — $PROMPT_ARG');
    });
    it('skills and commands: a placeholder the shell writes to the file, a dispatch whose section lost its steps', () => {
      planted('plugins/designer/core/skills/frame/SKILL.md', 'PROMPT_FILE="$TEXT_DIR/prompt.xml"\n', 'PROMPT_FILE="$TEXT_DIR/prompt.xml"\nprintf \'%s\\n\' "<the Frame XML prompt>" > "$PROMPT_FILE"\n', 'R1 agent text written by the shell — printf \'%s\\n\' "<the Frame XML prompt>" > "$PROMPT_FILE"');
      const [kind, label, text] = doc('plugins/founder/commands/compose.md');
      const steps = text.slice(text.indexOf('The prompt reaches the runner as a file the block never builds'), text.indexOf("```bash\nTEXT_DIR='<directory from step 1>'\nROOT_OVERRIDE", text.indexOf('The prompt reaches the runner')));
      ok(steps.includes('mktemp -d') && steps.includes('`prompt.xml`'), 'the dispatch steps');
      // The bootstrap's steps, earlier in the runbook, name the same step and tool: only the
      // section's own text may count for the dispatch.
      const got = violations(kind, label, text.replace(steps, () => '')).out;
      ok(got.some((v) => v.includes('R3 no mktemp step or file-writing step in the block\'s section')), JSON.stringify(got));
    });

    it('regions: an assignment of agent text, a block that reads TEXT_DIR without its line', () => {
      planted('persona-pipeline/regions/checkpoint-set.md', 'grep -q \'[^[:space:]]\' "$TEXT_DIR/summary.txt" 2>/dev/null ||', "SUMMARY='<the summary>'\ngrep -q '[^[:space:]]' \"$TEXT_DIR/summary.txt\" 2>/dev/null ||", "R1 agent text assigned — SUMMARY='<the summary>'");
      planted('persona-pipeline/regions/verb-dispatch.md', "TEXT_DIR='<directory from step 1>'\n", '', 'R3 the block reads TEXT_DIR but does not open with its line');
    });

    // Each sub-rule of R1 and R3 bites on its own (the critique of C130 S2
    // turned each off in a copy of this file, and every test still passed).
    it('R1: a user\'s path as a placeholder, a NEXT_ACTION that runs a command, a value glued to its flag', () => {
      planted('persona-pipeline/regions/peer-now-dispatch.md', 'PROMPT_FILE="$TEXT_DIR/prompt.xml"\n', "PROMPT_FILE='<the prompt file>'\n", "R1 placeholder assigned — PROMPT_FILE='<the prompt file>'");
      planted('persona-pipeline/regions/refine-owner-decision.md', "NEXT_ACTION='Fix the recurring finding in this refine, then re-critique'", 'NEXT_ACTION="$(touch pwned)"', 'R1 NEXT_ACTION assigned more than a fixed literal — NEXT_ACTION="$(touch pwned)"');
      planted('plugins/founder/commands/compose.md', '--phase-note-file "$TEXT_DIR/note.md"', '--phase-note="<note $(touch pwned)>"', 'R1 glued value — --phase-note="<note $(touch pwned)>"');
      planted('plugins/engineer/commands/checkpoint.md', '--summary-file "$TEXT_DIR/summary.txt"', '--summary-file="$TEXT_DIR/summary.txt"', 'R1 glued value — --summary-file="$TEXT_DIR/summary.txt"');
    });
    it('R1: a shell writer indented, through tee, or with an uppercase placeholder', () => {
      const site = 'PROMPT_FILE="$TEXT_DIR/prompt.xml"\n';
      for (const [writer, expected] of [
        ['  printf \'%s\\n\' "<the Frame XML prompt>" > "$PROMPT_FILE"\n', 'R1 agent text written by the shell — printf \'%s\\n\' "<the Frame XML prompt>" > "$PROMPT_FILE"'],
        ['printf \'%s\\n\' "<the Frame XML prompt>" | tee "$PROMPT_FILE"\n', 'R1 agent text written by the shell — printf \'%s\\n\' "<the Frame XML prompt>" | tee "$PROMPT_FILE"'],
        ['echo "<THE FRAME XML PROMPT>" > "$PROMPT_FILE"\n', 'R1 agent text written by the shell — echo "<THE FRAME XML PROMPT>" > "$PROMPT_FILE"'],
      ]) planted('plugins/designer/core/skills/frame/SKILL.md', site, `${site}${writer}`, expected);
    });
    it('R3: a [ -s ] check, a section that never names a file the block reads', () => {
      planted('persona-pipeline/regions/checkpoint-set.md', 'grep -q \'[^[:space:]]\' "$TEXT_DIR/summary.txt" 2>/dev/null ||', '[ -s "$TEXT_DIR/summary.txt" ] ||', 'R3 a [ -s ] check passes a blank file — [ -s "$TEXT_DIR/summary.txt" ] ||');
      planted('persona-pipeline/regions/checkpoint-set.md', 'create `summary.txt` in that', 'create the summary file in that', 'R3 the section never names summary.txt, which the block reads');
    });
    it('R2: a text flag with its text in the prose of a command, a skill and a region', () => {
      planted('plugins/founder/commands/compose.md', 'Then run the block with `TEXT_DIR` set to that directory, `RUN_ID` to the run', 'Then run the block with `--summary "<the résumé>"`, `TEXT_DIR` set to that directory, `RUN_ID` to the run', 'R2 a text flag with its text — --summary "<the résumé>"');
      planted('plugins/engineer/core/skills/refine/SKILL.md', '**Core principle**: do not modify code', '**Core principle**: never pass `--resolution "<the ruling>"`; do not modify code', 'R2 a text flag with its text — --resolution "<the ruling>"');
      planted('persona-pipeline/regions/verb-finalize.md', 'Then run the block with `TEXT_DIR` set to that directory, `RUN_ID` to the run', 'Then run the block with `--next-action <the next step>`, `TEXT_DIR` set to that directory, `RUN_ID` to the run', 'R2 a text flag with its text — --next-action <the next step>');
    });
    it('manifest: a prose value that names a text flag with its text', () => {
      planted('persona-pipeline/manifest.json#critique-finalize.owner_gates', "--resolution-file <the ruling's file>", '--resolution "<the ruling>"', 'R2 a text flag with its text — --resolution "<the ruling>"');
    });
    it('agents: a default prompt that names a text flag with its text', () => {
      planted('plugins/engineer/core/skills/peer-now/agents/openai.yaml', 'never spliced into a command)', 'never spliced into a command; then --next-action "<the next step>")', 'R2 a text flag with its text — --next-action "<the next step>"');
    });
    it('the user\'s --prompt-text grammar stays in prose, and never reaches a block', () => {
      const [kind, label, text] = doc('plugins/designer/commands/peer-now.md');
      ok(text.includes('argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)'), 'the argument hint names the user grammar');
      deepStrictEqual(violations(kind, label, text).out, [], 'prose may name it');
      const block = '```bash\nnode x.mjs run --prompt-text "hello"\n```\n';
      ok(violations(kind, label, `${text}\n${block}`).out.some((v) => v.includes('R1 inline text — --prompt-text "hello"')), 'a block may not');
    });
  });
});
