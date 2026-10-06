// Runbook contracts over the generated regions (ADR-0066 Decision 5, PC2a T4).
//
// The drift check proves that each persona's runbook regions equal what the
// canonical templates render. It cannot prove the templates are right: a
// template that read the wrong workflow, dispatched before the privacy gate
// or passed an image to the peer would regenerate into every persona and
// still match. So the contracts below run twice for every persona a region
// file is enrolled into:
//
//   - over the committed runbook (what the agent reads), and
//   - over the runbook assembled in memory from its authored text and the
//     regions rendered fresh from the canonical templates (what the next
//     `--write` would produce),
//
// and each assertion is bound to its call site, with a nonzero count, so a
// contract that matches nothing fails instead of passing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseRegions,
  regionBody,
  renderTemplate,
  renderingDeclaration,
  replaceRegionBodies,
} from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, pluginRoot } from './_personas.mjs';
import { FIXTURE, NOTE_READER, characterize, expectedFor } from './_verb-runbooks.mjs';
import {
  archiveTimingProblems,
  argsFileRunbookProblems,
  argsFileTypedTextProblems,
  completionBlocks,
  completionReenumerations,
  resolverProblems,
} from '../_runbook-checks.mjs';

/** The region files of the manifest and the personas enrolled into each. */
function regionFiles() {
  const byDest = new Map();
  for (const region of MANIFEST.regions) {
    if (!byDest.has(region.dest)) byDest.set(region.dest, new Set());
    for (const p of region.personas) byDest.get(region.dest).add(p);
  }
  return byDest;
}

/** The runbook with every region body rendered fresh from its template. */
function assembled(persona, dest, text) {
  const parsed = parseRegions(text, dest);
  deepStrictEqual(parsed.errors, [], `${persona}/${dest}: region grammar`);
  const bodies = {};
  for (const region of MANIFEST.regions.filter((r) => r.dest === dest && r.personas.includes(persona))) {
    const rendered = renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', region.template), 'utf8'), {
      declaration: renderingDeclaration(declaration(persona)),
      substitutions: region.substitutions ?? {},
      label: region.template,
    });
    bodies[region.id] = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
  }
  return replaceRegionBodies(text, parsed.regions, bodies);
}

/** The documents a contract runs over, for one persona and region file. */
function documents(persona, dest) {
  const committed = readFileSync(join(pluginRoot(persona), dest), 'utf8');
  return [
    ['committed', committed],
    ['assembled from the templates', assembled(persona, dest, committed)],
  ];
}

/** Fenced shell blocks with their line offset, as an agent reads them. */
function shellBlocks(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)```(bash|sh|zsh|shell)\s*$/.exec(lines[i]);
    if (!m) continue;
    let e = i + 1;
    while (e < lines.length && lines[e].trim() !== '```') e++;
    out.push({ start: i, end: e, text: lines.slice(i + 1, e).join('\n') });
    i = e;
  }
  return out;
}

/** The character offset of each match of `re` inside shell blocks only. */
function shellSites(text, re) {
  const lines = text.split('\n');
  const offsets = [];
  let pos = 0;
  const lineStart = lines.map((l) => { const s = pos; pos += l.length + 1; return s; });
  for (const block of shellBlocks(text)) {
    const base = lineStart[block.start + 1] ?? 0;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of block.text.matchAll(g)) offsets.push(base + m.index);
  }
  return offsets;
}

// The command runbooks only: a skill's regions (PC2a3 T7) hold no block that
// names the plugin root, so they have their own family
// (test-skill-contracts.mjs).
const FILES = new Map([...regionFiles()].filter(([dest]) => dest.startsWith('commands/')));
const covered = (dest) => FILES.has(dest);

// The verb runbooks whose blocks are generated (compose and frame in PC2a2b,
// investigate and decide in PC2a2c, critique's finalize in PC2b U5a, refine's
// in PC2b U5b, through a variant where the persona waits for convergence),
// with the verb each one runs.
const VERB_DESTS = ['commands/compose.md', 'commands/frame.md', 'commands/investigate.md', 'commands/decide.md', 'commands/critique.md', 'commands/refine.md'];
const PIPELINE_VERB_DESTS = VERB_DESTS;
// The runbooks whose finalize sits under a generated finalize heading, after
// every extension their slots hold (PC2a3 QD7, QD8).
const HEADING_DESTS = ['commands/critique.md', 'commands/refine.md'];
// start: its bootstrap (the clean-baseline gate) and its workflow_type read
// are generated; the lifecycle list and the terminal block stay authored.
const START = 'commands/start.md';

// Each extension a slot holds (QD8): the sentences its authored text must
// state, so a marker left without the text it stands for fails.
const EXTENSION_ANCHORS = {
  'start-archetype': ['Prefix the resolve invocation in the **same block** instead', 'AGENTIC_DESIGNER_PROFILE="<general|ui|flow|cta|content>" \\'],
  'critique-dual-input': ['Vision is **host-direct**: on the active host the model reads the screenshot directly'],
  'refine-convergence-loop': ['critique → refine → re-critique until findings converge.'],
  'refine-convergence-bound': ['**Bounded convergence (no unbounded loop).**', 'visual re-critique **UNVERIFIED**, set `CONVERGED=no`'],
};

/** Each extension marker, with the authored text after it up to the next marker. */
function extensionTexts(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = /^<!-- pipeline:extension ([a-z][a-z0-9._-]*) -->$/.exec(line);
    if (!m) return;
    let e = i + 1;
    while (e < lines.length && !lines[e].startsWith('<!-- pipeline:')) e++;
    out.push({ id: m[1], line: i, text: lines.slice(i + 1, e).join('\n') });
  });
  return out;
}

// decide's Phase 0.5 block names the args directory before anything else
// (tests/plugin-shape/test-runbook-shell-portability.mjs), so its resolver
// opens on the line after.
const ARGS_DIR_LINE = "ARGS_DIR='<directory from step 1>'";
const verbOf = (dest) => /^commands\/([a-z]+)\.md$/.exec(dest)[1];

// The operative privacy sentences each verb runbook states before its
// dispatch: the prohibition, generated in the privacy-gate region (PC2a3 QD4),
// and designer's screenshot sentence, authored right after the regions.
// investigate's gate covers web search as well as the peer, so it words both
// differently.
const PROHIBITION = {
  start: 'The lifecycle runs web search (Phase 1 investigate) and dispatches the peer ensemble at every phase boundary (always-max) — genericize before any external call; the pre-genericization value MUST never leave the local host.',
  critique: 'Genericize the artifact before the peer prompt; the pre-genericization value MUST never leave the local host.',
  refine: 'Genericize the revision before the peer prompt; the pre-genericization value MUST never leave the local host.',
  investigate: 'Genericize or remove proprietary content from the topic and sub-questions before WebSearch / WebFetch or peer dispatch; only the genericized form leaves the local host. If the topic cannot be genericized without losing the question, run local-only or abort at scoping. The pre-genericization value MUST never leave the local host.',
  other: 'Genericize before the peer prompt; the pre-genericization value MUST never leave the local host.',
};
// The no-image rule (QD3): a persona whose declaration keeps images from the
// peer (peer.images false) states it before every dispatch.
const NO_IMAGE = 'No dispatch passes `--image`: the companion peer path has no image channel, so an image never reaches the peer as bytes.';
const SCREENSHOT = {
  start: '**Screenshots are sensitive by default**: the rendered screen is read host-direct and never leaves the local host as bytes',
  critique: '**Screenshots are sensitive by default** and are never sent to the peer as inline image bytes',
  refine: '**Screenshots are sensitive by default** and are never sent to the peer as inline image bytes',
  investigate: '**Screenshots are sensitive by default** — a raw screenshot of a real UI is never sent to web search or the peer',
  other: '**Screenshots are sensitive by default** and are never sent to the peer as bytes',
};

/** A shell block's lines joined the way the shell joins a trailing backslash. */
const logical = (block) => block.replace(/[ \t]*\\\n[ \t]*/g, ' ');

const squash = (t) => t.replace(/\s+/g, ' ');

// PC2b U5b: a verb whose persona declares terminal_requires_convergence renders
// the convergent finalize, whose CONVERGED line is a placeholder the agent
// fills from the re-critique. `converged` sets it the way the agent would
// (UNSET drops the line); the shared cases run the finalize converged.
const CONVERGED_LINE = /^CONVERGED="[^"\n]*"$/m;
const UNSET = Symbol('unset');
const convergent = (persona, verb) => declaration(persona).verbs?.[verb]?.terminal_requires_convergence === true;
const converged = (block, persona, verb, value = 'yes') => (convergent(persona, verb)
  ? block.replace(CONVERGED_LINE, () => (value === UNSET ? '' : `CONVERGED='${value}'`))
  : block);

/** A region's body by id; fails when the document does not hold it once. */
function region(text, id) {
  const found = parseRegions(text).regions.filter((r) => r.id === id);
  strictEqual(found.length, 1, `region ${id}`);
  return regionBody(text, found[0]);
}

/** The YAML frontmatter of a runbook (without its fences); fails when there is none. */
function frontmatterOf(text) {
  const close = text.indexOf('\n---\n', 4);
  ok(text.startsWith('---\n') && close > 0, 'the runbook opens with its frontmatter');
  return text.slice(4, close);
}

/** The text between two anchors, each present once and in that order. */
function between(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  ok(start >= 0 && start === text.lastIndexOf(from), `${from}: once`);
  ok(end > start && end === text.lastIndexOf(to), `${to}: once, after ${from}`);
  return text.slice(start + from.length, end);
}

/** The offset of an operative sentence, matched across line wrapping. */
function sentenceAt(text, sentence) {
  const re = new RegExp(sentence.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  return [...text.matchAll(re)].map((m) => m.index);
}

/**
 * Run a runbook block with `node` stubbed: the stub logs each script
 * subcommand, keeps the `--phase-note` it was handed, fails `append` when
 * asked to, answers `find-active` with `active` and `findStatus`, and
 * answers decide's `resolve` with `resolveStatus`, keeping the file it was
 * given and printing a context on stdout and a diagnostic on stderr. The
 * heredoc's placeholder line is replaced by `note` first, and its delimiter
 * by `delimiter` when given; `after` is appended to the block.
 * `inheritedNote` puts a NOTE in the shell's environment beforehand.
 */
function runBlock(shell, block, persona, { note = '', failAppend = false, delimiter = null, active = '', findStatus = 0, resolveStatus = 0, inheritedNote = null, after = '', baseline = '', baselineStatus = 0, readOutput = '', readStatus = 0, preflightStatus = 0, settleStatus = 0, clearStatus = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'pc2a2b-finalize.'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'root'));
    // Phase 0 reads the branch: a repository of its own, on a branch.
    strictEqual(spawnSync('git', ['init', '-q', '-b', 'pc2a2b', dir]).status, 0, 'git init');
    writeFileSync(join(dir, 'bin', 'node'), [
      '#!/bin/sh',
      // An inline script (start's JSON reads) runs on the real node.
      'if [ "$1" = -e ]; then exec "$STUB_REAL_NODE" "$@"; fi',
      'printf \'%s\\n\' "$2" >> "$STUB_LOG"',
      'printf \'%s\' "$*" | tr \'\\n\' \' \' >> "$STUB_ARGV"; printf \'\\n\' >> "$STUB_ARGV"',
      'if [ "$2" = find-active ]; then printf \'%s\\n\' "$STUB_ACTIVE"; exit "$STUB_FIND_RC"; fi',
      'if [ "$2" = autopilot-preflight ]; then exit "$STUB_PREFLIGHT_RC"; fi',
      'if [ "$2" = settle ]; then exit "$STUB_SETTLE_RC"; fi',
      'if [ "$2" = awaiting-owner-clear ]; then exit "$STUB_CLEAR_RC"; fi',
      'if [ "$2" = check-clean-baseline ]; then printf \'%s\' "$STUB_BASELINE"; exit "$STUB_BASELINE_RC"; fi',
      'if [ "$2" = read ]; then printf \'%s\' "$STUB_READ"; exit "$STUB_READ_RC"; fi',
      'if [ "$2" = create ]; then printf \'%s\\n\' "$STUB_CREATED"; exit 0; fi',
      'if [ "$2" = resolve ]; then printf \'%s\\n\' "$4" > "$STUB_ARGS"; printf \'%s\\n\' "$STUB_CONTEXT"; printf \'%s\\n\' "$STUB_DIAGNOSTIC" >&2; exit "$STUB_RESOLVE_RC"; fi',
      'if [ "$2" = append ]; then',
      '  while [ $# -gt 0 ]; do if [ "$1" = --phase-note ]; then printf \'%s\' "$2" > "$STUB_NOTE"; fi; shift; done',
      '  if [ -n "$STUB_FAIL_APPEND" ]; then exit 7; fi',
      'fi',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    // The delimiter first, then the note, which may hold the old delimiter.
    let script = delimiter === null ? block : block.replace("<<'PHASE_NOTE'", () => `<<'${delimiter}'`).replace('\nPHASE_NOTE\n', () => `\n${delimiter}\n`);
    script = script.replace('\n<the phase note above, filled in>\n', () => `\n${note}\n`);
    script += after;
    const env = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      // mktemp -t writes under TMPDIR: keep a dispatch's files in the test's own directory.
      TMPDIR: dir,
      STUB_CREATED: '/w/created.md',
      [renderingDeclaration(declaration(persona)).derived.root_env]: join(dir, 'root'),
      STUB_LOG: join(dir, 'log'),
      STUB_ARGV: join(dir, 'argv'),
      STUB_NOTE: join(dir, 'note'),
      STUB_ACTIVE: active,
      STUB_FIND_RC: String(findStatus),
      STUB_ARGS: join(dir, 'args'),
      STUB_RESOLVE_RC: String(resolveStatus),
      STUB_REAL_NODE: process.execPath,
      STUB_BASELINE: baseline,
      STUB_BASELINE_RC: String(baselineStatus),
      STUB_READ: readOutput,
      STUB_READ_RC: String(readStatus),
      STUB_PREFLIGHT_RC: String(preflightStatus),
      STUB_SETTLE_RC: String(settleStatus),
      STUB_CLEAR_RC: String(clearStatus),
      STUB_CONTEXT: RESOLVER_CONTEXT,
      STUB_DIAGNOSTIC: RESOLVER_DIAGNOSTIC,
      ...(inheritedNote === null ? {} : { NOTE: inheritedNote }),
      ...(failAppend ? { STUB_FAIL_APPEND: '1' } : {}),
    };
    const r = spawnSync(shell, ['-c', script], { cwd: dir, env, encoding: 'utf8' });
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: (read('log') ?? '').split('\n').filter(Boolean), argv: (read('argv') ?? '').split('\n').filter(Boolean), note: read('note'), out: read('out'), args: read('args') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What the stubbed resolver prints: the skill body reads the context from the
// block's stdout, and the user sees the diagnostics on its stderr.
const RESOLVER_CONTEXT = '{"stub":"ResolvedDecisionContext"}';
const RESOLVER_DIAGNOSTIC = 'registry: stub diagnostic';

/**
 * The ResolvedDecisionContext a persona's own decide registry prints for the
 * typed `text`, passed the way the runbook passes it (an args file), with
 * the environment's AGENTIC_* settings (an L4 profile among them) left out.
 */
function resolveWith(persona, text) {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
  writeFileSync(join(dir, 'args.json'), JSON.stringify({ agentic_args: 1, text }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));
  const r = spawnSync(process.execPath, [join(pluginRoot(persona), 'scripts', 'decide-registry.mjs'), 'resolve', '--args-file', join(dir, 'args.json')], { env, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  strictEqual(r.status, 0, r.stderr);
  return { context: JSON.parse(r.stdout), stderr: r.stderr };
}

const SHELLS = ['bash', 'zsh', 'sh', 'dash'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);
// Whether a shell's read takes -d: dash's does not, and there the block must
// stop before any write instead of recording an empty note.
const readsDelimited = (shell) => spawnSync(shell, ['-c', "IFS= read -r -d '' X <<'E' || true\nx\nE\n[ -n \"$X\" ]"]).status === 0;

// Text a phase note may hold that a shell would read if it were spliced into
// a double-quoted string: quotes, an expansion, a command substitution, a
// backtick, an apostrophe, the persona's own skill mention and a trailing
// backslash.
const HOSTILE_NOTE = [
  '### Artifact',
  '',
  'He said "go"; it\'s $HOME and $(touch pwned) and `touch pwned2`',
  '- next_command:          /founder:frame … or $founder:frame for a verb',
  'ends with a backslash \\',
].join('\n');

// PC2b U5b: the convergent finalize is a variant of the plain one, not a
// second copy that can drift: the plain template with the convergence
// paragraph before the last-write paragraph, and its terminal write, comment
// and call, indented in the then branch of the fail-closed check. The
// variant's own lines (the paragraph, the check, the else branch) are bound by
// the refine finalize, start terminal and Owner decision runs.
describe('each convergent variant is its plain template plus the convergence check, nothing else (PC2b U5b, U5c, Review of code step 6)', () => {
  const LAST = 'The last write, `finish-verb`, records';
  const TERMINAL_COMMENT = '# ADR-0029 §1 / completion-output contract §2';
  // [plain, variant, the variant's paragraph opening, the paragraph the
  // convergence paragraph precedes, where the plain terminal part opens]
  const PAIRS = [
    ['verb-finalize.md', 'verb-finalize-convergent.md', 'This verb closes only once it converged', LAST, (plain) => plain.indexOf(TERMINAL_COMMENT)],
    ['start-terminal.md', 'start-terminal-convergent.md', 'This lifecycle closes only once Phase 4 converged', LAST, (plain) => plain.indexOf(TERMINAL_COMMENT)],
    // The deferral's clear and terminal write: the Defer block's second clear.
    ['refine-owner-decision.md', 'refine-owner-decision-convergent.md', 'This refine closes only once it converged', '**Fix now.**', (plain) => plain.lastIndexOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \\\n')],
  ];
  for (const [plainName, variantName, opening, before, terminalFrom] of PAIRS) {
    it(`${variantName}: rebuilt from ${plainName} and the variant's own lines, it is byte for byte the variant`, () => {
      const read = (rel) => readFileSync(join(REPO_ROOT, 'persona-pipeline', 'regions', rel), 'utf8');
      const plain = read(plainName);
      const variant = read(variantName);
      const para = variant.slice(variant.indexOf(opening), variant.indexOf(before));
      ok(variant.indexOf(opening) >= 0 && para.endsWith('.\n\n'), `the convergence paragraph, right before ${before}`);
      const terminalAt = terminalFrom(plain);
      const ownerForm = plain.indexOf('# The owner-decision form, for an owner gate');
      const terminal = plain.slice(terminalAt, ownerForm >= 0 ? ownerForm : plain.indexOf('\n```\n', terminalAt) + 1);
      ok(terminalAt > 0 && /\nnode "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" finish-verb \\\n/.test(terminal), 'the plain terminal write, comment and call');
      const indented = terminal.replace(/^(?=.)/gm, '  ');
      const THEN = 'if [ "${CONVERGED:-no}" = "yes" ]; then\n';
      const headAt = variant.indexOf('# FAIL-CLOSED:');
      const thenEnd = variant.indexOf(THEN, headAt) + THEN.length;
      ok(headAt > 0 && thenEnd > THEN.length, 'the fail-closed check');
      strictEqual(variant.slice(thenEnd, thenEnd + indented.length), indented, 'the then branch is the plain terminal write, indented');
      const elseAt = thenEnd + indented.length;
      const elseBranch = variant.slice(elseAt, variant.indexOf('\nfi\n', elseAt) + '\nfi\n'.length);
      ok(elseBranch.startsWith('else\n'), 'an else branch follows');
      const rebuilt = plain.replace(before, () => `${para}${before}`).replace(terminal, () => `${variant.slice(headAt, thenEnd)}${indented}${elseBranch}`);
      strictEqual(variant, rebuilt);
    });
  }
});

// engineer's runbooks join the regions one group at a time in Stage 3 (PC3 U7).
const ENGINEER_JOINED = new Set(['commands/checkpoint.md', 'commands/peer-now.md', 'commands/resume.md', 'commands/frame.md', 'commands/compose.md', 'commands/decide.md', 'commands/critique.md', 'commands/refine.md', 'commands/investigate.md']);

describe('runbook regions: the contracts hold for every enrolled persona', () => {
  it('the contracts reach the region files they are about (guards a vacuous pass)', () => {
    for (const dest of ['commands/checkpoint.md', 'commands/resume.md', 'commands/peer-now.md', ...PIPELINE_VERB_DESTS, START]) {
      ok(covered(dest), `${dest} has no generated region`);
      deepStrictEqual([...FILES.get(dest)].sort(), ENGINEER_JOINED.has(dest) ? ['designer', 'engineer', 'founder'] : ['designer', 'founder'], `${dest}: enrolled personas`);
    }
  });

  for (const [dest, personas] of FILES) {
    for (const persona of [...personas].sort()) {
      for (const [which] of documents(persona, dest)) {
        describe(`${persona}/${dest} (${which})`, () => {
          const text = new Map(documents(persona, dest)).get(which);
          const env = renderingDeclaration(declaration(persona)).derived.root_env;

          it('every shell block opens with this persona\'s resolver, and nothing is left unrendered', () => {
            const blocks = shellBlocks(text).filter((b) => /CLAUDE_PLUGIN_ROOT/.test(b.text));
            ok(blocks.length > 0, 'no shell block uses the plugin root');
            for (const b of blocks) {
              const lines = b.text.split('\n');
              const at = lines[0] === ARGS_DIR_LINE ? 1 : 0;
              // A block nested in a list item is indented; the code is the same.
              strictEqual(lines[at].trim(), `ROOT_OVERRIDE="$(printenv '${env}' || true)"`, `${persona}: block at line ${b.start + 1}`);
              ok(lines[at + 2].includes(`agentic-plugins/'${persona}' -mindepth`), `${persona}: cache path at line ${b.start + 1}`);
            }
            ok(!text.includes('{{'), 'a placeholder survived the render');
          });

          // The repository-wide runbook gates read committed files; their rules
          // run here on both documents, so the next --write cannot break them.
          it('the shared runbook checks hold: the resolver rule, and in a verb runbook the completion block and the archive-timing note', () => {
            const label = `${persona}/${dest} (${which})`;
            const resolver = resolverProblems(text, persona, label);
            ok(resolver.checked.length > 0, 'the resolver rule checked no block');
            deepStrictEqual(resolver.offenders, []);
            if (PIPELINE_VERB_DESTS.includes(dest)) {
              const blocks = completionBlocks(text, label);
              deepStrictEqual([blocks.sites, blocks.violations], [1, []], 'one conformant six-field block');
              deepStrictEqual(completionReenumerations(text, label, blocks.blockLines), []);
              const timing = archiveTimingProblems(text, label);
              // decide's Owner selection step (PC2b DD7) and refine's Owner
              // decision (U5b) finish the verb a second way.
              deepStrictEqual([timing.sites, timing.problems], [['commands/decide.md', 'commands/refine.md'].includes(dest) ? 2 : 1, []], 'each terminal write carries its archive-timing note');
            }
          });

          // PC2b RV9: collection waits for the host's notification that the
          // runner exited, so the runner runs in the foreground of a host
          // background task; a shell `&` would detach it from the host.
          it('no dispatch detaches: the runner command ends without a shell & (PC2b RV9)', () => {
            const runs = shellBlocks(text).filter((b) => /peer-runner\.mjs" run\b/.test(b.text));
            if (PIPELINE_VERB_DESTS.includes(dest) || dest === 'commands/peer-now.md') ok(runs.length > 0, 'the dispatch block');
            for (const b of runs) {
              const code = logical(b.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
              const command = code.split('\n').find((l) => /peer-runner\.mjs" run\b/.test(l));
              ok(!/(^|[^&])&\s*$/.test(command), `${persona}: the runner command at line ${b.start + 1} detaches: ${command}`);
            }
          });

          it('no shell block passes an image to the peer (the companion path has no image channel)', () => {
            const runs = shellSites(text, /peer-runner\.mjs" run/);
            if (dest === 'commands/peer-now.md') strictEqual(runs.length, 1, 'peer-now dispatches once');
            strictEqual(shellSites(text, /--image\b/).length, 0, `${persona}: --image in a shell block`);
          });

          if (dest === 'commands/checkpoint.md') {
            it('the checkpoint is written to the workflow find-active found, after finding it', () => {
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active /m);
              const set = shellSites(text, /state\.mjs" checkpoint-set \\\n\s+--workflow-path "\$ACTIVE" /);
              strictEqual(find.length, 1, 'find-active sites');
              strictEqual(set.length, 1, 'checkpoint-set sites on $ACTIVE');
              ok(find[0] < set[0], 'find-active precedes checkpoint-set');
            });
          }

          if (dest === 'commands/resume.md') {
            it('resume finds, reads, then marks the same workflow; archive acts on the one it resolved', () => {
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active --repo-root/m);
              const read = shellSites(text, /state\.mjs" read --workflow-path "\$ACTIVE"/);
              const mark = shellSites(text, /state\.mjs" append \\\n\s+--workflow-path "\$ACTIVE" [^\n]*\\\n[^\n]*\\\n\s+--event resumed/);
              const archive = shellSites(text, /state\.mjs" archive \\\n\s+--workflow-path "\$WORKFLOW" /);
              deepStrictEqual([find.length, read.length, mark.length, archive.length], [1, 1, 1, 1], 'site counts');
              ok(find[0] < read[0] && read[0] < mark[0], 'find-active, read, append in that order');
              ok(mark[0] < archive[0], 'the archive mode follows the resume mode');
            });

            // ADR-0017 §sub-decision-1 host_history fidelity: no resumed event
            // over a baseline whose commit object is not available.
            it('resume appends its marker only when the baseline commit is available', () => {
              const blocks = shellBlocks(text).filter((b) => /--event resumed/.test(b.text));
              strictEqual(blocks.length, 1, 'one marker block');
              const code = blocks[0].text;
              const read = code.indexOf('BASE_HEAD_CHECK="$(');
              const guard = code.indexOf('! git cat-file -e "$BASE_HEAD_CHECK^{commit}"');
              const otherwise = code.indexOf('\nelse\n', guard);
              const append = code.indexOf('state.mjs" append', otherwise);
              ok(read >= 0 && read < guard, 'the baseline head is re-read in the marker block');
              ok(guard >= 0 && otherwise > guard && append > otherwise && code.indexOf('\nfi', append) > append, code);
            });

            it('resume takes no argument or archive with an optional workflow id, and Phase 0 routes an argument starting with archive to archive mode', () => {
              ok(/^argument-hint: .*\barchive \[<workflow-id>\]/m.test(frontmatterOf(text)), 'the argument hint offers archive [<workflow-id>]');
              const phase0 = squash(between(text, '## Phase 0', '## Phase 1'));
              ok(phase0.includes('Starts with `archive` (case-insensitive)') && /\barchive mode\b/i.test(phase0), phase0);
            });

            it('after find-active, resume branches on its exit status and output: no active workflow, a single path, a per-branch duplicate', () => {
              const branches = squash(between(text, '<!-- pipeline:end resume-locate -->', '<!-- pipeline:begin resume-read -->'));
              for (const branch of ['- **Exit 0, empty stdout** →', '- **Exit 0, single path', '- **Exit 1, per-branch duplicate error']) ok(branches.includes(branch), `${branch}: ${branches}`);
              ok(branches.includes('No active workflow; nothing to resume.'), 'the no-active outcome');
            });

            it('a dirty report closes with the no-auto-reconcile notice, stated once between the drift read and the resume marker', () => {
              const notice = 'current plugin does not auto-reconcile; review and decide [resume / archive / abort]';
              strictEqual(text.split(notice).length - 1, 1, 'the notice, once');
              ok(between(text, '<!-- pipeline:end resume-read -->', '<!-- pipeline:begin resume-marker -->').includes(notice), 'between the drift read and the marker');
            });
          }

          if (dest === 'commands/peer-now.md') {
            // A persona that declares a peer policy gates the prompt before it
            // leaves the host; engineer declares none and has no gate.
            it('the privacy gate precedes the dispatch, which is synchronous, and the note goes to the workflow found', () => {
              const gate = text.indexOf('PRIVACY GATE:');
              const run = shellSites(text, /peer-runner\.mjs" run/);
              if (declaration(persona).peer) {
                ok(gate >= 0, 'the privacy prohibition is present');
                ok(gate < run[0], 'the privacy prohibition precedes the dispatch block');
              } else {
                strictEqual(gate, -1, 'no privacy prohibition without a declared peer policy');
              }
              strictEqual(shellSites(text, /> "\$RUN_JSON" 2> "\$RUN_ERR"\nRUN_RC=\$\?/).length, 1, 'the runner\'s exit code is read right after it');
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active --repo-root "\$REPO_ROOT" 2>\/tmp\/[^\n]*-find\.err\)"\nFIND_RC=\$\?$/m);
              const note = shellSites(text, /state\.mjs" append \\\n\s+--workflow-path "\$ACTIVE" /);
              deepStrictEqual([find.length, note.length], [1, 1], 'site counts: find-active keeps its exit code, so a per-branch duplicate is told apart from no workflow');
              ok(run[0] < find[0] && find[0] < note[0], 'dispatch, find-active, append in that order');
            });

            it('peer-now takes --peer and exactly one of the two prompt forms', () => {
              ok(/^argument-hint: --peer <claude\|codex> \(--prompt-text "\.\.\." \| --prompt-file <path>\)$/m.test(frontmatterOf(text)), frontmatterOf(text));
            });

            it('dispatch, run: the run id is a peer-now- id, surfaced on stderr before the runner call, which keys the run with it', () => {
              const [block] = shellBlocks(region(text, 'peer-now-dispatch'));
              ok(block, 'the dispatch block');
              ok(block.text.indexOf('echo "peer-now run_id=$RUN_ID" >&2') >= 0 && block.text.indexOf('echo "peer-now run_id=$RUN_ID" >&2') < block.text.indexOf('peer-runner.mjs" run'), 'the run id is surfaced before the runner call');
              const r = runBlock('bash', block.text, persona, {});
              strictEqual(r.status, 0, r.stderr);
              const id = /^peer-now run_id=(peer-now-\d{8}T\d{6}Z-[0-9a-f]{6})$/m.exec(r.stderr)?.[1];
              ok(id, `a peer-now run id on stderr: ${r.stderr}`);
              deepStrictEqual(r.log, ['run'], 'one runner call');
              for (const part of [` --run-id ${id} `, ' --kind peer-now ', ' --output-format text ']) ok(r.argv[0].includes(part), `${part}: ${r.argv[0]}`);
            });

            it('after find-active, peer-now branches three ways (standalone, a single path, a per-branch duplicate sent to this persona\'s resume), and the note, run, is a [Peer] phase note on that workflow that leaves the phase alone', () => {
              const branches = squash(between(text, '<!-- pipeline:end peer-now-locate -->', '<!-- pipeline:begin peer-now-note -->'));
              ok(/\bstandalone\b/i.test(branches) && /\bsingle path\b/i.test(branches) && /\bper-branch duplicate\b/i.test(branches), branches);
              ok(branches.includes(`/${persona}:resume`), 'the duplicate branch points at this persona\'s resume');
              const [block] = shellBlocks(region(text, 'peer-now-note'));
              ok(block, 'the note block');
              const setup = ["ACTIVE='/w/active.md'", "PEER='codex'", "RUN_ID='peer-now-x'", "HANDLE_PATH='/h/handle.json'", "printf 'the peer said hi' > response", 'STDOUT_PATH=response'].join('\n');
              const r = runBlock('bash', `${setup}\n${block.text}`, persona, {});
              strictEqual(r.status, 0, r.stderr);
              deepStrictEqual(r.log, ['append'], 'one append');
              for (const part of [' --workflow-path /w/active.md ', ' --phase-label [Peer] codex consultation ']) ok(r.argv[0].includes(part), `${part}: ${r.argv[0]}`);
              ok(r.argv[0].trimEnd().endsWith(' --event updated'), r.argv[0]);
              ok(!/ --(current-phase|next-action|verb|clear-next-step) /.test(r.argv[0]), `the note leaves the phase alone: ${r.argv[0]}`);
              strictEqual(r.note, 'peer: codex\nrun_id: peer-now-x\nhandle: /h/handle.json\nprompt-mode: verbatim\n\n### Response\n\nthe peer said hi');
            });
          }

          if (dest === START) {
            const blocks = shellBlocks(text);
            const blockWith = (re) => {
              const found = blocks.filter((b) => re.test(b.text));
              strictEqual(found.length, 1, `${persona}/start: one block matches ${re}`);
              return found[0];
            };

            it('start Phase 0 runs autopilot-preflight on $ACTIVE after the find guard and before the baseline check or any write; a refusal stops the block (PC2b DD5)', () => {
              const block = blockWith(/find-active --repo-root "\$REPO_ROOT"\)"$/m);
              ok(/node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" autopilot-preflight --workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" \|\| exit \$\?$/m.test(logical(block.text)), logical(block.text));
              const pre = shellSites(text, /state\.mjs" autopilot-preflight/);
              const later = shellSites(text, /state\.mjs" (check-clean-baseline|create|append|set-terminal|finish-verb)\b/);
              strictEqual(pre.length, 1, 'one preflight');
              ok(later.length > 0 && later.every((w) => pre[0] < w), 'before the baseline check and every write');
              const refused = runBlock('bash', block.text, persona, { active: '', preflightStatus: 4, after: '\nprintf ran > out\n' });
              deepStrictEqual([refused.status, refused.out, refused.log], [4, null, ['find-active', 'autopilot-preflight']]);
            });

            it('start bootstrap, run: only a clean or accepted baseline creates the workflow (investigate, workflow_type start); any other status, or a failed check, stops before any write', () => {
              const block = blockWith(/state\.mjs" check-clean-baseline /).text;
              const cases = [
                ['{"status":"clean"}', 0, 0],
                ['{"status":"accepted"}', 0, 0],
                ['{"status":"dirty"}', 0, 1],
                ['{}', 0, 1],
                ['{"status":""}', 0, 1],
                ['{"status":"unknown"}', 0, 1],
                ['not json', 0, 1],
                ['', 4, 4],
                // A failed check stops even when it printed a clean status.
                ['{"status":"clean"}', 4, 4],
              ];
              for (const [baseline, baselineStatus, status] of cases) {
                const r = runBlock('bash', block, persona, { baseline, baselineStatus, after: '\nprintf \'%s\' "$ACTIVE" > out\n' });
                const what = `${JSON.stringify(baseline)} (check exit ${baselineStatus})`;
                strictEqual(r.status, status, `${what}: ${r.stderr}`);
                if (status === 0) {
                  deepStrictEqual(r.log, ['check-clean-baseline', 'create'], what);
                  ok(r.argv[1].includes(' --verb investigate --workflow-type start ') && r.argv[1].includes(` --persona ${persona} `), `${what}: the start workflow, for ${persona}`);
                  // The block sets the repository and branch itself (a fresh shell has neither).
                  ok(/ --repo-root \/\S+( |$)/.test(r.argv[0]) && / --repo-root \/\S+ /.test(r.argv[1]), `${what}: an absolute repository root`);
                  ok(r.argv[1].includes(' --git-baseline-branch pc2a2b '), `${what}: the branch the shell is on`);
                  strictEqual(r.out, '/w/created.md', `${what}: $ACTIVE holds the workflow create printed`);
                } else {
                  deepStrictEqual(r.log, ['check-clean-baseline'], `${what}: nothing written`);
                }
                if (baseline === '{"status":"dirty"}') ok(r.stderr.includes(`/${persona}:start gates a clean baseline`), 'the dirty message names the persona');
              }
            });

            it('start resume, run: workflow_type is start only when the workflow says so; a missing, empty, malformed or failed read is verb-chain; only a start workflow is written — its next step cleared, its position kept (PC2b RV4)', () => {
              const block = blockWith(/state\.mjs" read --workflow-path "\$ACTIVE"/).text;
              const cases = [
                ['{"workflow_type":"start"}', 0, 'start'],
                ['{"workflow_type":"verb-chain"}', 0, 'verb-chain'],
                ['{}', 0, 'verb-chain'],
                ['', 0, 'verb-chain'],
                ['{not json', 0, 'verb-chain'],
                ['', 3, 'verb-chain'],
              ];
              for (const [readOutput, readStatus, expected] of cases) {
                const r = runBlock('bash', `ACTIVE='/w/active.md'\n${block}`, persona, { readOutput, readStatus, after: '\nprintf \'%s\' "$WF_TYPE" > out\n' });
                strictEqual(r.out, expected, `${JSON.stringify(readOutput)} (exit ${readStatus}): ${r.stderr}`);
                ok(r.argv[0].includes(' --workflow-path /w/active.md'), 'the workflow Phase 0 found');
                if (expected !== 'start') {
                  deepStrictEqual(r.log, ['read'], 'a verb-chain workflow: only the read');
                  continue;
                }
                deepStrictEqual(r.log, ['read', 'append'], 'a start workflow: the read, then the clear');
                ok(r.argv[1].includes(' --workflow-path /w/active.md ') && r.argv[1].includes(' --clear-next-step true '), r.argv[1]);
                ok(!/--(current-phase|next-action|verb|phase-label|phase-note) /.test(r.argv[1]), `the position is kept: ${r.argv[1]}`);
              }
              const failed = runBlock('bash', `ACTIVE='/w/active.md'\n${block}`, persona, { readOutput: '{"workflow_type":"start"}', failAppend: true, after: '\nprintf ran > out\n' });
              deepStrictEqual([failed.status, failed.out], [7, null], 'a failed clear stops the block with its status');
            });

            // PC2b U5c, DD5: the lifecycle's terminal write is finish-verb kind
            // commit (the owner saves and commits); a persona that waits for
            // convergence makes it only once Phase 4 converged, and otherwise
            // records the next step, turning an inherited marker off.
            it('start terminal, run: finish-verb kind commit, only once converged where the persona waits for it (fail-closed); otherwise a non-terminal append with the next step (PC2b U5c)', () => {
              const block = blockWith(/state\.mjs" finish-verb \\/).text;
              const waits = convergent(persona, 'start');
              strictEqual(CONVERGED_LINE.test(block), waits, 'the block assigns CONVERGED exactly where the persona waits for convergence');
              if (waits) strictEqual(CONVERGED_LINE.exec(block)[0], 'CONVERGED="<yes|no — from the Phase 4 re-critique verdict; unset means no>"', 'the convergence placeholder');
              const cases = waits
                ? [['yes', 'finish-verb'], ['no', 'append'], [UNSET, 'append'], ['<yes|no>', 'append'], [null, 'append']]
                : [[null, 'finish-verb']];
              for (const [value, last] of cases) {
                const script = value === null ? block : converged(block, persona, 'start', value);
                const r = runBlock('bash', `ACTIVE='/w/active.md'\n${script}`, persona, {});
                const label = `CONVERGED ${value === null ? 'as committed' : value === UNSET ? 'unset' : JSON.stringify(value)}`;
                strictEqual(r.status, 0, `${label}: ${r.stderr}`);
                deepStrictEqual(r.log, [last], label);
                ok(r.argv[0].includes(' --workflow-path /w/active.md '), `${label}: the workflow Phase 0 found`);
                if (last === 'finish-verb') {
                  ok(r.argv[0].includes(` --next-action ${declaration(persona).verbs.start.next_action} `), `${label}: the declared next action: ${r.argv[0]}`);
                  ok(r.argv[0].trimEnd().endsWith(' --next-step-kind commit --next-step-confidence <HIGH|MEDIUM|LOW>'), `${label}: kind commit: ${r.argv[0]}`);
                } else {
                  for (const part of [' --next-step-kind verb --next-step-verb <refine|decide|investigate> ', ' --clear-terminal-marker true ', ' --event updated']) ok(r.argv[0].includes(part), `${label}: ${part}: ${r.argv[0]}`);
                  ok(!/ --(current-phase|phase-note|verb) /.test(r.argv[0]), `${label}: the position is kept: ${r.argv[0]}`);
                  ok(/PAUSED/.test(r.stderr), `${label}: the pause is reported`);
                }
              }
            });

            it('start privacy: the prohibition precedes the lifecycle, the no-image rule follows the phase-boundary paragraph (where the phases dispatch) and precedes the terminal write; designer\'s screenshot sentence precedes the lifecycle', () => {
              const lifecycle = text.indexOf('## Entry routing + Phases 1–4 + terminal');
              ok(lifecycle > 0, 'the lifecycle section');
              const prohibition = sentenceAt(text, PROHIBITION.start);
              strictEqual(prohibition.length, 1, 'the prohibition sentence');
              ok(prohibition[0] < lifecycle, 'before the lifecycle');
              const noImage = sentenceAt(text, NO_IMAGE);
              strictEqual(noImage.length, declaration(persona).peer.images === false ? 1 : 0, 'the no-image rule, exactly where images are off');
              const boundaryEnd = text.indexOf('<!-- pipeline:end start-phase-boundary -->');
              const terminalAt = text.indexOf(blockWith(/state\.mjs" finish-verb \\/).text);
              ok(boundaryEnd > 0 && noImage.every((at) => boundaryEnd < at && at < terminalAt), 'the no-image rule after the phase-boundary paragraph, before the terminal write');
              if (persona === 'designer') {
                const screenshot = sentenceAt(text, SCREENSHOT.start);
                strictEqual(screenshot.length, 1, 'the screenshot sentence');
                ok(screenshot[0] < lifecycle, 'the screenshot sentence before the lifecycle');
              }
            });

            it('start lifecycle: the workflow begins at investigate, and each phase boundary rotates the verb, writes state and dispatches its ensemble', () => {
              const initial = squash(region(text, 'start-initial-verb'));
              ok(initial.includes('The initial `verb` is `investigate` (Phase 1a); rotate the `verb` field at each phase boundary via `state.mjs append --verb <verb>`'), 'the initial verb and its rotation');
              const boundary = squash(region(text, 'start-phase-boundary'));
              ok(boundary.includes('Each phase boundary writes state via `state.mjs append --verb <verb> --current-phase <phase> --next-action <...> --event updated`'), 'the state write at each boundary');
              ok(boundary.includes('and dispatches the per-phase peer ensemble per `core/skills/_shared/references/ensemble-protocol.md` (always-max)'), 'the per-phase ensemble');
              // PC2b RV3: the rules that hold inside the lifecycle, each run by
              // test-start-lifecycle.mjs against the real scripts.
              for (const rule of [
                '**Each ensemble attempt is settled.** After its synthesis note, settle the phase\'s attempt from its run ledger with `peer-runner.mjs settle --phase <verb> --run-id <that attempt\'s run id>` (empty when no run launched), before the next phase. A repeated phase (a second refine pass) dispatches under a new run id and settles each attempt.',
                '**No phase closes the workflow.** A verb\'s own terminal write (`finish-verb`) never runs inside the lifecycle; the Terminal block below is its one terminal write.',
                'record it after the phase note with `state.mjs awaiting-owner-set --gate <gate> --anchor <anchor>`, a write that leaves the workflow open, and pause. Once the owner decides, clear it with `state.mjs awaiting-owner-clear --gate <gate> --resolution <the owner\'s decision> --next-step-kind verb --next-step-verb <the next phase\'s verb> --next-step-confidence HIGH`, and continue at that phase. The verb\'s own resolving step (decide\'s Owner selection, refine\'s Owner decision) ends in a terminal write, so the lifecycle does not run it.',
              ]) ok(boundary.includes(rule), rule);
              ok(text.indexOf('<!-- pipeline:end start-phase-boundary -->') < text.indexOf(blockWith(/state\.mjs" finish-verb \\/).text), 'the rules precede the terminal block they name');
              const bootstrap = text.indexOf('<!-- pipeline:begin start-bootstrap -->');
              ok(bootstrap > 0 && bootstrap < text.indexOf('<!-- pipeline:begin start-initial-verb -->'), 'the initial verb is stated after the bootstrap that creates the workflow');
            });

            it('start: the terminal write follows every extension, and each extension holds the text its slot exists for (QD8)', () => {
              const exts = extensionTexts(text);
              const slots = MANIFEST.extension_points.filter((e) => e.dest === dest && e.personas.includes(persona)).map((e) => e.id);
              deepStrictEqual(exts.map((e) => e.id).sort(), [...slots].sort(), 'one marker per slot this persona owns');
              const terminal = blockWith(/state\.mjs" finish-verb \\/);
              for (const ext of exts) {
                ok(ext.line < terminal.start, `extension ${ext.id} precedes the terminal write`);
                for (const sentence of EXTENSION_ANCHORS[ext.id] ?? [null]) {
                  ok(sentence, `anchor sentences for ${ext.id}`);
                  strictEqual(sentenceAt(ext.text, sentence).length, 1, `${ext.id}: ${sentence}`);
                }
              }
            });
          }

          if (PIPELINE_VERB_DESTS.includes(dest)) {
            const verb = verbOf(dest);
            const key = `${persona}/${verb}`;
            const blocks = shellBlocks(text);
            const blockWith = (re) => {
              const found = blocks.filter((b) => re.test(b.text));
              strictEqual(found.length, 1, `${key}: one block matches ${re}`);
              return found[0];
            };

            it('Phase 0 names the persona before its guard, finds the workflow into $ACTIVE, and exits on a failed find', () => {
              const block = blockWith(/find-active --repo-root "\$REPO_ROOT"\)"$/m);
              const lines = block.text.split('\n');
              const persona_ = lines.indexOf(`PERSONA='${persona}'`);
              const guard = lines.indexOf('if [ -z "$GIT_BRANCH" ]; then');
              ok(persona_ > 0 && guard > persona_, 'PERSONA is assigned before the detached-HEAD guard');
              ok(lines.includes('  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2'), 'the guard names the persona through PERSONA');
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active --repo-root "\$REPO_ROOT"\)"\nFIND_RC=\$\?\nif \[ "\$FIND_RC" -ne 0 \]; then\n[^\n]*\n\s+exit "\$FIND_RC"\nfi$/m);
              strictEqual(find.length, 1, 'find-active, then its status read and exited with');
            });

            it('Phase 0 runs autopilot-preflight on $ACTIVE right after the find guard, before any write, and a refusal stops the block (PC2b DD5)', () => {
              const block = blockWith(/find-active --repo-root "\$REPO_ROOT"\)"$/m);
              ok(/\nfi\n(#[^\n]*\n)*node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" autopilot-preflight --workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" \|\| exit \$\?$/.test(logical(block.text)), logical(block.text));
              const pre = shellSites(text, /state\.mjs" autopilot-preflight/);
              const writes = shellSites(text, /state\.mjs" (create|append|set-terminal|finish-verb|ensemble-commit)\b/);
              strictEqual(pre.length, 1, 'one preflight');
              ok(writes.length > 0 && writes.every((w) => pre[0] < w), 'before every write');
              const refused = runBlock('bash', block.text, persona, { active: '/w/active.md', preflightStatus: 4, after: '\nprintf ran > out\n' });
              deepStrictEqual([refused.status, refused.out, refused.log], [4, null, ['find-active', 'autopilot-preflight']]);
              const passed = runBlock('bash', block.text, persona, { active: '/w/active.md', after: '\nprintf ran > out\n' });
              deepStrictEqual([passed.status, passed.out], [0, 'ran'], passed.stderr);
              ok(passed.argv[1].includes(' --workflow-path /w/active.md '), passed.argv[1]);
            });

            it('the resume append clears the next step the previous verb recorded (PC2b DD5)', () => {
              ok(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--current-phase phase-0-resume --clear-next-step true [^\n]*--event resumed \|\| exit \$\?$/m.test(logical(blockWith(/--event resumed/).text)), logical(blockWith(/--event resumed/).text));
            });

            it('Phase 0, run: $ACTIVE holds what find-active printed, and a failed find stops the block with its status', () => {
              const block = blockWith(/find-active --repo-root "\$REPO_ROOT"\)"$/m).text;
              const after = '\nprintf \'%s\' "$ACTIVE" > out\n';
              const found = runBlock('bash', block, persona, { active: '/w/active.md', after });
              strictEqual(found.status, 0, found.stderr);
              strictEqual(found.out, '/w/active.md');
              const failed = runBlock('bash', block, persona, { active: '', findStatus: 5, after });
              strictEqual(failed.status, 5, failed.stderr);
              strictEqual(failed.out, null, 'nothing after the guard ran');
            });

            it('the authored conditions route an empty $ACTIVE to the bootstrap and a found one to the resume', () => {
              const lines = text.split('\n');
              const before = (id) => {
                const at = lines.indexOf(`<!-- pipeline:begin ${verb}-${id} -->`);
                ok(at > 1, `region ${verb}-${id}`);
                strictEqual(lines[at - 1], '', `a blank line before ${verb}-${id}`);
                return lines[at - 2];
              };
              ok(new RegExp(`^Empty \`\\$ACTIVE\` → bootstrap .*verb=${verb}( \\([^)]*\\))?:$`).test(before('bootstrap')), before('bootstrap'));
              ok(/^Non-empty `\$ACTIVE` → append-on-resume( \([^)]*\))?:$/.test(before('resume')), before('resume'));
            });

            it('bootstrap and resume write the workflow Phase 0 found, after it, and each stops the block when it fails (PD6)', () => {
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active /m);
              const create = blockWith(/state\.mjs" create \\/);
              const resume = blockWith(/--event resumed/);
              ok(/^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" create [^\n]*--persona '[a-z-]+' [^\n]*\)" \|\| exit \$\?$/m.test(logical(create.text)), 'create assigns ACTIVE and exits with its status');
              ok(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--event resumed \|\| exit \$\?$/m.test(logical(resume.text)), 'the resume append writes $ACTIVE and exits with its status');
              const createAt = shellSites(text, /state\.mjs" create \\/);
              const resumeAt = shellSites(text, /--event resumed/);
              deepStrictEqual([find.length, createAt.length, resumeAt.length], [1, 1, 1], 'site counts');
              ok(find[0] < createAt[0] && createAt[0] < resumeAt[0], 'find-active, bootstrap, resume in that order');
            });

            if (VERB_DESTS.includes(dest)) it('the dispatch, the note, settle and finish-verb run in that order on $ACTIVE; each write stops the block when it fails (PC2b DD6/DD7)', () => {
              const run = shellSites(text, /peer-runner\.mjs" run \\/);
              const finalize = blockWith(/peer-runner\.mjs" settle \\/);
              const code = logical(finalize.text);
              const at = (re) => { const m = re.exec(code); ok(m, `${key}: ${re}`); return m.index; };
              const repo = at(/^REPO_ROOT="\$\(git rev-parse --show-toplevel\)" \|\| exit 1$/m);
              const note = at(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--phase-note "\$NOTE" [^\n]*--event updated \|\| exit \$\?$/m);
              const settle = at(new RegExp(`^node "\\$CLAUDE_PLUGIN_ROOT/scripts/peer-runner\\.mjs" settle --repo-root "\\$REPO_ROOT" --workflow-path "\\$ACTIVE" --host "\\$\\{AGENTIC_HOST:-claude\\}" --phase '${verb}' --run-id "\\$RUN_ID" --verdict "\\$VERDICT" --summary "\\$SUMMARY" \\|\\| exit \\$\\?$`, 'm'));
              // Indented inside the convergence check in the convergent variant.
              const terminal = at(/^[ \t]*node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" finish-verb --workflow-path "\$ACTIVE" [^\n]*--next-step-kind verb --next-step-verb '[a-z]+' --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \|\| exit \$\?$/m);
              strictEqual(run.length, 1, 'one dispatch');
              ok(run[0] < shellSites(text, /^IFS= read -r -d '' NOTE/m)[0], 'the dispatch precedes the finalize block');
              ok(repo < note && note < settle && settle < terminal, 'REPO_ROOT, append, settle, finish-verb in that order');
              strictEqual(shellSites(text, /state\.mjs" (set-terminal|ensemble-commit)\b/).length, 0, 'no set-terminal or ensemble-commit runs beside them');
              // The owner-decision form, commented under the typical finish.
              ok(/\n# node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" finish-verb \\\n#   --workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" \\\n#   --next-action '<Owner: the judgment, in a few words>' \\\n#   --next-step-kind owner-decision --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \\\n#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' \|\| exit \$\?\n```$/.test(finalize.text + '\n```'), 'the commented owner-decision form ends the block');
              // The gates the prose names for this verb, with their anchors.
              const gates = squash(text.slice(text.indexOf('The last write, `finish-verb`'), text.indexOf(finalize.text)));
              ok(gates.includes('- `scope-routing` (heading `### Routing recommendation`, anchor `routing-recommendation`)'), gates);
              strictEqual(gates.includes('- `decide-conflict` (the `Ensemble synthesis` heading, anchor `ensemble-synthesis`)'), verb === 'decide', 'decide-conflict exactly in decide');
              strictEqual(gates.includes('- `recurring-finding` (heading `### Recurring finding`, anchor `recurring-finding`)'), verb === 'refine', 'recurring-finding exactly in refine');
            });

            if (VERB_DESTS.includes(dest)) it('the finalize, run: a settle refusal stops the block before finish-verb, with its status (PC2b DD6)', () => {
              const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
              const passed = runBlock('bash', `ACTIVE='/w/active.md'; RUN_ID='r'; VERDICT='agreed'; SUMMARY='s'\n${block}`, persona, { note: 'n' });
              strictEqual(passed.status, 0, passed.stderr);
              deepStrictEqual(passed.log, ['append', 'settle', 'finish-verb']);
              ok(passed.argv[1].includes(' --run-id r --verdict agreed --summary s'), passed.argv[1]);
              ok(passed.argv.every((a) => a.includes(' --workflow-path /w/active.md ')), 'every call targets $ACTIVE');
              const refused = runBlock('bash', `ACTIVE='/w/active.md'; RUN_ID=''\n${block}`, persona, { note: 'n', settleStatus: 1 });
              deepStrictEqual([refused.status, refused.log], [1, ['append', 'settle']], 'no finish-verb after a refused settle');
            });

            it('identity: persona, verb, phase, ensemble type and run-id prefix are the expected ones (the T0 map, not the manifest)', () => {
              const got = characterize(text);
              const type = FIXTURE.expected_ensemble_types[persona][verb];
              const one = (script, sub) => {
                const calls = got.calls.filter((c) => c.script === script && c.sub === sub);
                strictEqual(calls.length, 1, `${script} ${sub}`);
                return new Map(calls[0].args);
              };
              const create = one('state.mjs', 'create');
              strictEqual(create.get('--persona'), persona);
              strictEqual(create.get('--verb'), verb);
              // PC2b DD6: a settled finalize names only the phase; settle reads
              // the type from the run ledger.
              const settled = got.calls.some((c) => c.script === 'peer-runner.mjs' && c.sub === 'settle');
              const pairs = settled
                ? [[one('peer-runner.mjs', 'run'), type]]
                : [[one('peer-runner.mjs', 'run'), type], [one('state.mjs', 'ensemble-commit'), FIXTURE.expected_commit_ensemble_types?.[persona]?.[verb] ?? type]];
              for (const [call, expected] of pairs) {
                strictEqual(call.get('--phase'), verb);
                strictEqual(call.get('--ensemble-type'), expected);
              }
              if (settled) strictEqual(one('peer-runner.mjs', 'settle').get('--phase'), verb);
              deepStrictEqual(got.run_id_prefixes, [type]);
              deepStrictEqual(got.mktemp_templates, [`${persona}-${verb}-prompt.XXXXXX`]);
            });

            if (VERB_DESTS.includes(dest)) it('the phase note: the scaffold right above the finalize block is the recorded one, read from a quoted heredoc and passed as "$NOTE" (PD2)', () => {
              strictEqual(characterize(text).note, expectedFor(key).note);
              const finalize = blockWith(/peer-runner\.mjs" settle \\/);
              const lines = finalize.text.split('\n');
              const reader = lines.indexOf(NOTE_READER);
              ok(reader > 0, 'the block reads NOTE from a quoted heredoc');
              strictEqual(lines[reader - 1], 'unset NOTE', 'NOTE is cleared right before it is read');
              deepStrictEqual(lines.slice(reader + 1, reader + 3), ['<the phase note above, filled in>', 'PHASE_NOTE'], 'the heredoc holds only the placeholder line');
              strictEqual(lines[reader + 4], '[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }', 'an empty note stops the block before any write');
              ok(lines.findIndex((l) => /state\.mjs" append \\$/.test(l)) > reader + 4, 'the guard precedes the append');
              // The delimiter rule the agent follows when its note holds the line.
              const rule = sentenceAt(text, 'so when the note itself holds such a line, replace both `PHASE_NOTE` delimiters with a word no line of the note consists of.');
              strictEqual(rule.length, 1, 'the delimiter rule');
              ok(rule[0] < shellSites(text, /^IFS= read -r -d '' NOTE/m)[0], 'the delimiter rule precedes the block');
              strictEqual(finalize.text.split('NOTE=').length - 1, 0, 'nothing else assigns NOTE');
              // The scaffold fence is the last fence before the finalize block.
              const all = text.split('\n');
              const fencesBefore = all.slice(0, finalize.start).filter((l) => /^\s*```/.test(l));
              deepStrictEqual(fencesBefore.slice(-2), ['```markdown', '```'], 'the markdown scaffold is the fence right above the block');
            });

            it('privacy: the prohibition sentence precedes the dispatch; the no-image rule where images are off; designer\'s screenshot sentence too; no --image', () => {
              const run = shellSites(text, /peer-runner\.mjs" run \\/);
              const prohibition = sentenceAt(text, PROHIBITION[verb] ?? PROHIBITION.other);
              const noImage = sentenceAt(text, NO_IMAGE);
              // A persona that declares no peer policy (engineer, PC3 U7) has
              // no privacy gate and no no-image rule, as in peer-now.
              const peer = declaration(persona).peer;
              strictEqual(prohibition.length, peer ? 1 : 0, 'the prohibition sentence, exactly where a peer policy is declared');
              ok(prohibition.every((at) => at < run[0]), 'the prohibition precedes the dispatch block');
              strictEqual(noImage.length, peer?.images === false ? 1 : 0, 'the no-image rule, exactly where images are off');
              // The never-launched note names the privacy gate only where a
              // persona has one (PC3 U7, derived.ensemble_skip_*).
              const skipped = squash(text).match(/its first heading reads `### Ensemble skipped: [^`]* \(([a-z -]+)\)` instead/);
              ok(skipped, 'the never-launched heading');
              strictEqual(skipped[1], peer ? 'privacy gate' : 'local-only', 'the skip names the privacy gate exactly where one is declared');
              ok(noImage.every((at) => at < run[0]), 'the no-image rule precedes the dispatch block');
              if (persona === 'designer') {
                const screenshot = sentenceAt(text, SCREENSHOT[verb] ?? SCREENSHOT.other);
                strictEqual(screenshot.length, 1, 'the screenshot sentence');
                ok(screenshot[0] < run[0], 'the screenshot sentence precedes the dispatch block');
              }
              strictEqual(shellSites(text, /--image\b/).length, 0);
            });

            if (verb === 'decide') {
              it('Phase 0.5: between the resume and the dispatch, the resolver reads the args file the agent wrote, and either failure stops the block', () => {
                const block = blockWith(/decide-registry\.mjs" resolve /);
                const lines = block.text.split('\n');
                strictEqual(lines[0], ARGS_DIR_LINE, 'the block names the args directory first');
                const call = lines.indexOf('node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --args-file "$ARGS_DIR/args.json"');
                ok(call > 0, 'the resolver is given the args file');
                strictEqual(lines[call + 1], 'RESOLVE_RC=$?', 'its status is read right after it');
                const resume = shellSites(text, /--event resumed/);
                const resolve = shellSites(text, /decide-registry\.mjs" resolve /);
                const run = shellSites(text, /peer-runner\.mjs" run \\/);
                deepStrictEqual([resume.length, resolve.length, run.length], [1, 1, 1], 'site counts');
                ok(resume[0] < resolve[0] && resolve[0] < run[0], 'resume, resolve, dispatch in that order');
                const script = block.text.replace(ARGS_DIR_LINE, () => "ARGS_DIR='/agentic-args.x'");
                const after = "\nprintf '%s' reached > out\n";
                const passed = runBlock('bash', script, persona, { after });
                strictEqual(passed.status, 0, passed.stderr);
                deepStrictEqual(passed.log, ['resolve']);
                strictEqual(passed.args, '/agentic-args.x/args.json\n', 'the file the agent wrote');
                strictEqual(passed.out, 'reached');
                // The skill body reads the context from the block's output.
                strictEqual(passed.stdout, `${RESOLVER_CONTEXT}\n`, 'the context reaches the block\'s stdout');
                ok(passed.stderr.includes(RESOLVER_DIAGNOSTIC), 'the diagnostics reach the block\'s stderr');
                for (const status of [2, 3]) {
                  const failed = runBlock('bash', script, persona, { resolveStatus: status, after });
                  strictEqual(failed.status, 1, `resolver exit ${status}: ${failed.stderr}`);
                  strictEqual(failed.out, null, `resolver exit ${status}: nothing after the guard ran`);
                }
              });

              it('Phase 0.5: the args-file pins hold, and the fallback the prose names is the one the registry takes (measured)', () => {
                const label = `${persona}/${dest} (${which})`;
                deepStrictEqual(argsFileRunbookProblems(text, label), []);
                deepStrictEqual(argsFileTypedTextProblems(text, label), []);
                const fallback = declaration(persona).decide.fallback.preset_id;
                const prose = sentenceAt(text, `fall-back to the \`${fallback}\` preset with a diagnostic (no halt), while an empty one counts as no \`--preset\` at all.`);
                strictEqual(prose.length, 1, 'the prose names the declared fallback preset');
                const unknown = resolveWith(persona, '--preset=no-such-preset choose a direction');
                deepStrictEqual([unknown.context.preset_id, unknown.context.registry_fallback], [fallback, true], 'an unknown preset');
                ok(/unknown preset id "no-such-preset"/.test(unknown.stderr), 'with a diagnostic');
                // An empty one is no --preset: the rest of the precedence (here
                // --size) decides, with no flag and no diagnostic of its own.
                const untimed = ({ context: { resolved_at, ...context }, stderr }) => ({ context, stderr });
                for (const rest of ['choose a direction', '--size=minor choose a direction']) {
                  deepStrictEqual(untimed(resolveWith(persona, `--preset= ${rest}`)), untimed(resolveWith(persona, rest)), `--preset= ${rest}`);
                }
              });
            }

            // QD5, RV14: founder critique's dispatch is generated; the agent sets
            // its type by profile in the block, and settle reads it from the
            // ledger. PC3 U7: engineer's critique joins the same way, its
            // adversarial profile full-codebase (with or without a sub-focus).
            const ADVERSARIAL = {
              founder: {
                profile: 'red-team',
                prose: "for `--profile=red-team`, set `ENSEMBLE_TYPE='adversarial-scan'` in it before running it, and build the prompt from §Adversarial-scan.",
                fallback: 'Missing profile → default. Unknown profile → fallback to default with a one-line warning.',
              },
              engineer: {
                profile: 'full-codebase',
                prose: "for `--profile=full-codebase`, with or without a sub-focus, set `ENSEMBLE_TYPE='adversarial-scan'` in it before running it, and build the prompt from § Adversarial-scan.",
                fallback: 'Missing profile → default (recent diff). Unknown profile → fallback to default with one-line warning.',
              },
            };
            if (verb === 'critique' && Object.hasOwn(ADVERSARIAL, persona)) it(`${persona} critique, instantiated per profile: ${ADVERSARIAL[persona].profile} dispatches adversarial-scan; default, unknown and missing review; settle names the same run (QD5, RV14)`, () => {
              const adv = ADVERSARIAL[persona];
              const dispatch = blockWith(/peer-runner\.mjs" run \\/).text;
              const finalize = blockWith(/peer-runner\.mjs" settle \\/).text;
              const TYPE_LINE = /^ENSEMBLE_TYPE='review'$/m;
              ok(TYPE_LINE.test(dispatch), 'the block assigns review, the default profile\'s type');
              ok(/^ {2}--ensemble-type "\$ENSEMBLE_TYPE" --run-id "\$RUN_ID" \\$/m.test(dispatch), 'the dispatch names the type the block assigned, once');
              strictEqual(sentenceAt(text, adv.prose).length, 1, 'the prose says when to change it');
              const flat = text.replace(/\s+/g, ' ');
              ok(flat.indexOf(adv.prose) < flat.indexOf('peer-runner.mjs" run'), 'the prose comes before the block it changes');
              strictEqual(sentenceAt(text, adv.fallback).length, 1, 'the fallback sentence');
              for (const [profile, expected] of [['default', 'review'], [adv.profile, 'adversarial-scan'], ['unknown', 'review'], ['missing', 'review']]) {
                const script = profile === adv.profile ? dispatch.replace(TYPE_LINE, "ENSEMBLE_TYPE='adversarial-scan'") : dispatch;
                const sent = runBlock('bash', `ACTIVE='/w/active.md'\n${script}\nprintf '%s' "$RUN_ID" > out`, persona, {});
                strictEqual(sent.status, 0, sent.stderr);
                ok(sent.argv.length === 1 && sent.argv[0].includes(` --ensemble-type ${expected} `), `${profile}: the dispatch names ${expected}`);
                ok(sent.out.startsWith(`${expected}-`), `${profile}: the run id carries ${expected}`);
                const done = runBlock('bash', `ACTIVE='/w/active.md'; RUN_ID='${sent.out}'; VERDICT='sound'; SUMMARY='s'\n${finalize}`, persona, { note: 'n' });
                ok(done.argv.find((a) => / settle /.test(a)).includes(` --phase critique --run-id ${sent.out} `), `${profile}: settle names the run the dispatch started`);
              }
            });

            // PC3 U7: engineer's investigate joins as its critique did: the block
            // assigns the analysis profile's type, and the prose sets the
            // root-cause or cited-brief type there by profile; settle reads the
            // type from the ledger.
            const PROFILED_INVESTIGATE = {
              engineer: {
                base: 'investigate',
                profiles: {
                  'root-cause': "for `--profile=root-cause`, set `ENSEMBLE_TYPE='root-cause'` in it before running it, and build the prompt from § Investigate;",
                  'cited-brief': "for `--profile=cited-brief`, set `ENSEMBLE_TYPE='cited-brief'` in it before running it, and build the prompt from `core/skills/investigate/references/cited-brief-ensemble.md` § Prompt Construction.",
                },
                fallback: 'Missing profile → `analysis`. Unknown profile → fallback to `analysis` with a one-line warning.',
              },
            };
            if (verb === 'investigate' && Object.hasOwn(PROFILED_INVESTIGATE, persona)) it(`${persona} investigate, instantiated per profile: root-cause and cited-brief dispatch their own type; analysis, unknown and missing investigate; settle names the same run (PC3 U7)`, () => {
              const spec = PROFILED_INVESTIGATE[persona];
              const dispatch = blockWith(/peer-runner\.mjs" run \\/).text;
              const finalize = blockWith(/peer-runner\.mjs" settle \\/).text;
              const TYPE_LINE = new RegExp(`^ENSEMBLE_TYPE='${spec.base}'$`, 'm');
              ok(TYPE_LINE.test(dispatch), 'the block assigns the default profile\'s type');
              ok(/^ {2}--ensemble-type "\$ENSEMBLE_TYPE" --run-id "\$RUN_ID" \\$/m.test(dispatch), 'the dispatch names the type the block assigned, once');
              const flat = text.replace(/\s+/g, ' ');
              for (const prose of Object.values(spec.profiles)) {
                strictEqual(sentenceAt(text, prose).length, 1, `the prose says when to change it: ${prose}`);
                ok(flat.indexOf(prose) < flat.indexOf('peer-runner.mjs" run'), 'the prose comes before the block it changes');
              }
              strictEqual(sentenceAt(text, spec.fallback).length, 1, 'the fallback sentence');
              const cases = [['analysis', spec.base], ...Object.keys(spec.profiles).map((p) => [p, p]), ['unknown', spec.base], ['missing', spec.base]];
              for (const [profile, expected] of cases) {
                const script = Object.hasOwn(spec.profiles, profile) ? dispatch.replace(TYPE_LINE, `ENSEMBLE_TYPE='${expected}'`) : dispatch;
                const sent = runBlock('bash', `ACTIVE='/w/active.md'\n${script}\nprintf '%s' "$RUN_ID" > out`, persona, {});
                strictEqual(sent.status, 0, sent.stderr);
                ok(sent.argv.length === 1 && sent.argv[0].includes(` --ensemble-type ${expected} `), `${profile}: the dispatch names ${expected}`);
                ok(sent.out.startsWith(`${expected}-`), `${profile}: the run id carries ${expected}`);
                const done = runBlock('bash', `ACTIVE='/w/active.md'; RUN_ID='${sent.out}'; VERDICT='agreed'; SUMMARY='s'\n${finalize}`, persona, { note: 'n' });
                ok(done.argv.find((a) => / settle /.test(a)).includes(` --phase investigate --run-id ${sent.out} `), `${profile}: settle names the run the dispatch started`);
              }
            });

            if (verb === 'decide') it('Owner selection, run: it finds the workflow, clears decide-conflict with the resolution and the next step, then finishes the verb; a failed find or clear, or no workflow, stops the block (PC2b DD7)', () => {
              const block = blockWith(/state\.mjs" awaiting-owner-clear \\/).text;
              ok(text.indexOf(block) > text.indexOf('<!-- pipeline:end decide-finalize -->'), 'after Phase 2, whose owner-decision form records the gate');
              const CHAIN = { active: '/w/active.md', readOutput: '{"workflow_type":"verb-chain"}' };
              const r = runBlock('bash', block, persona, CHAIN);
              strictEqual(r.status, 0, r.stderr);
              deepStrictEqual(r.log, ['find-active', 'read', 'awaiting-owner-clear', 'finish-verb']);
              for (const part of [' --workflow-path /w/active.md ', ' --gate decide-conflict ', ' --resolution <Owner selection: the direction the owner chose, and why> ', ' --next-step-kind verb --next-step-verb compose --next-step-confidence HIGH']) ok(r.argv[2].includes(part), `${part}: ${r.argv[2]}`);
              ok(r.argv[3].includes(' --workflow-path /w/active.md ') && r.argv[3].includes(' --next-step-kind verb --next-step-verb compose --next-step-confidence HIGH'), r.argv[3]);
              // Review of code step 6: a resolution with a quote reaches state.mjs whole.
              const quoted = runBlock('bash', block.replace('<Owner selection: the direction the owner chose, and why>', "keep the team's \"existing\" `nav` $HOME"), persona, CHAIN);
              strictEqual(quoted.status, 0, quoted.stderr);
              ok(quoted.argv[2].includes(" --resolution keep the team's \"existing\" `nav` $HOME "), quoted.argv[2]);
              // A gate met inside a start lifecycle: cleared, and the lifecycle resumes; no verb terminal write.
              const lifecycle = runBlock('bash', block, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([lifecycle.status, lifecycle.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'inside start: no finish-verb');
              ok(lifecycle.stderr.includes(`Resume the lifecycle with /${persona}:start`), lifecycle.stderr);
              const unread = runBlock('bash', block, persona, { active: '/w/active.md', readOutput: '', readStatus: 5 });
              deepStrictEqual([unread.status, unread.log], [1, ['find-active', 'read']], 'an unreadable type stops the block before any write');
              const failed = runBlock('bash', block, persona, { ...CHAIN, clearStatus: 3 });
              deepStrictEqual([failed.status, failed.log], [3, ['find-active', 'read', 'awaiting-owner-clear']], 'a refused clear stops the block');
              const none = runBlock('bash', block, persona, { active: '' });
              deepStrictEqual([none.status, none.log], [1, ['find-active']], 'no workflow: nothing written');
              ok(none.stderr.includes(`✗ No active ${persona} workflow on this branch.`), none.stderr);
              const lost = runBlock('bash', block, persona, { active: '/w/active.md', findStatus: 4 });
              deepStrictEqual([lost.status, lost.log], [4, ['find-active']], 'a failed find stops the block with its status');
            });

            if (HEADING_DESTS.includes(dest)) {
              it('the finalize follows the finalize heading region and every extension; the synthesis instruction sits between the dispatch and the heading (QD7, QD8)', () => {
                const lines = text.split('\n');
                const heading = lines.indexOf(`<!-- pipeline:end ${verb}-finalize-heading -->`);
                ok(heading > 0, 'the finalize heading region');
                const finalize = blockWith(/peer-runner\.mjs" settle \\/);
                ok(finalize.start > heading, 'the terminal block follows the heading region');
                const exts = extensionTexts(text);
                for (const ext of exts) ok(ext.line < heading, `extension ${ext.id} precedes the finalize heading`);
                const slots = MANIFEST.extension_points.filter((e) => e.dest === dest && e.personas.includes(persona)).map((e) => e.id);
                deepStrictEqual(exts.map((e) => e.id).sort(), [...slots].sort(), 'one marker per slot this persona owns');
                ok(shellSites(text, /peer-runner\.mjs" run \\/)[0] < shellSites(text, /peer-runner\.mjs" settle \\/)[0], 'the dispatch precedes the finalize block');
                // The agent collects and synthesizes the peer result between the
                // dispatch and the finalize (the note records the synthesis).
                const synth = sentenceAt(text, 'Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT');
                strictEqual(synth.length, 1, 'the synthesis instruction');
                const dispatchAt = text.indexOf(blockWith(/peer-runner\.mjs" run \\/).text);
                ok(dispatchAt < synth[0] && synth[0] < text.indexOf(`<!-- pipeline:begin ${verb}-finalize-heading -->`), 'the synthesis instruction sits between the dispatch and the finalize heading');
              });

              it('each extension holds the text its slot exists for (QD8)', () => {
                const exts = extensionTexts(text);
                for (const ext of exts) {
                  ok(EXTENSION_ANCHORS[ext.id], `anchor sentences for ${ext.id}`);
                  for (const sentence of EXTENSION_ANCHORS[ext.id]) strictEqual(sentenceAt(ext.text, sentence).length, 1, `${ext.id}: ${sentence}`);
                }
              });
            }

            // DD5, PC2b U5b, run: a persona that declares refine convergent
            // closes it only once converged (fail-closed); otherwise the last
            // write records the next step, turns an inherited terminal marker
            // off and closes nothing. The other persona always closes.
            if (verb === 'refine') it('refine finalize, run: closes only once converged where the persona waits for it (fail-closed), otherwise records the next step without a terminal write and turns an inherited marker off (PC2b U5b, DD5)', () => {
              const block = blockWith(/peer-runner\.mjs" settle \\/).text;
              const waits = convergent(persona, verb);
              strictEqual(CONVERGED_LINE.test(block), waits, 'the block assigns CONVERGED exactly where the persona waits for convergence');
              // A placeholder the agent fills from the re-critique, never a
              // value: run untouched, the block pauses.
              if (waits) strictEqual(CONVERGED_LINE.exec(block)[0], 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"', 'the convergence placeholder');
              const cases = waits
                ? [['yes', 'finish-verb'], ['no', 'append'], [UNSET, 'append'], ['<yes|no>', 'append'], [null, 'append']]
                : [[null, 'finish-verb']];
              for (const [value, last] of cases) {
                const script = value === null ? block : converged(block, persona, verb, value);
                const r = runBlock('bash', `ACTIVE='/w/active.md'; RUN_ID='r'; VERDICT='resolved'; SUMMARY='s'\n${script}`, persona, { note: 'n' });
                const label = `CONVERGED ${value === null ? 'as committed' : value === UNSET ? 'unset' : JSON.stringify(value)}`;
                strictEqual(r.status, 0, `${label}: ${r.stderr}`);
                deepStrictEqual(r.log, ['append', 'settle', last], label);
                ok(r.argv.every((a) => a.includes(' --workflow-path /w/active.md ')), `${label}: every write targets $ACTIVE`);
                if (last === 'finish-verb') {
                  ok(r.argv[2].includes(' --next-step-kind verb --next-step-verb critique '), `${label}: ${r.argv[2]}`);
                } else {
                  for (const part of [' --current-phase phase-2-presented ', ' --next-step-kind verb --next-step-verb <refine|decide|investigate> ', ' --clear-terminal-marker true ', ' --event updated']) ok(r.argv[2].includes(part), `${label}: ${part}: ${r.argv[2]}`);
                  ok(!r.argv[2].includes(' --phase-note '), `${label}: the paused write adds no second note`);
                  ok(/PAUSED/.test(r.stderr), `${label}: the pause is reported`);
                }
              }
              // A refused settle stops the block before either last write.
              const refused = runBlock('bash', `ACTIVE='/w/active.md'; RUN_ID='r'\n${converged(block, persona, verb, 'no')}`, persona, { note: 'n', settleStatus: 1 });
              deepStrictEqual([refused.status, refused.log], [1, ['append', 'settle']], 'no write after a refused settle');
            });

            if (verb === 'refine') it('Owner decision, run: fix now clears recurring-finding with this refine next; defer clears it with commit next, then finishes the verb, where the persona waits for convergence only once converged (fail-closed); a failed find or clear, or no workflow, stops each block (PC2b U5b)', () => {
              const found = blocks.filter((b) => /state\.mjs" awaiting-owner-clear \\/.test(b.text)).map((b) => b.text);
              strictEqual(found.length, 2, 'fix now and defer');
              const [fix, deferAsCommitted] = found;
              const waits = convergent(persona, verb);
              strictEqual(CONVERGED_LINE.test(deferAsCommitted), waits, 'the defer block assigns CONVERGED exactly where the persona waits for convergence');
              // The shared cases run the deferral converged; the persona that
              // waits for convergence is run unconverged below.
              const defer = converged(deferAsCommitted, persona, verb);
              const finalizeEnd = `<!-- pipeline:end ${waits ? 'refine-finalize-convergent' : 'refine-finalize'} -->`;
              ok(text.indexOf(fix) > text.indexOf(finalizeEnd) && text.indexOf(finalizeEnd) > 0, 'after Phase 2, whose owner-decision form records the gate');
              const f = runBlock('bash', fix, persona, { active: '/w/active.md' });
              strictEqual(f.status, 0, f.stderr);
              deepStrictEqual(f.log, ['find-active', 'awaiting-owner-clear']);
              for (const part of [' --workflow-path /w/active.md ', ' --gate recurring-finding ', ' --resolution <Owner decision: fix the finding now> ', ' --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH']) ok(f.argv[1].includes(part), `${part}: ${f.argv[1]}`);
              const CHAIN = { active: '/w/active.md', readOutput: '{"workflow_type":"verb-chain"}' };
              const d = runBlock('bash', defer, persona, CHAIN);
              strictEqual(d.status, 0, d.stderr);
              deepStrictEqual(d.log, ['find-active', 'read', 'awaiting-owner-clear', 'finish-verb']);
              for (const part of [' --workflow-path /w/active.md ', ' --gate recurring-finding ', ' --next-step-kind commit --next-step-confidence HIGH']) ok(d.argv[2].includes(part), `${part}: ${d.argv[2]}`);
              ok(d.argv[3].includes(' --workflow-path /w/active.md ') && d.argv[3].includes(' --next-step-kind commit --next-step-confidence HIGH'), d.argv[3]);
              // Review of code step 6: inside a start lifecycle the deferral is cleared and the lifecycle resumes.
              const lifecycle = runBlock('bash', defer, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([lifecycle.status, lifecycle.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'inside start: no finish-verb');
              const unread = runBlock('bash', defer, persona, { active: '/w/active.md', readOutput: '', readStatus: 5 });
              deepStrictEqual([unread.status, unread.log], [1, ['find-active', 'read']], 'an unreadable type stops the block before any write');
              // Review of code step 6 (finding 3): deferring a finding does not
              // make a refine converge. Where the persona waits for convergence,
              // anything but CONVERGED=yes clears the gate with the next step
              // that resolves what is open, and makes no terminal write, inside
              // a start lifecycle too.
              if (waits) {
                strictEqual(CONVERGED_LINE.exec(deferAsCommitted)[0], 'CONVERGED="<yes|no — from the re-critique verdict with the finding deferred; unset means no>"', 'the convergence placeholder');
                for (const value of ['no', UNSET, '<yes|no>', null]) {
                  const label = `CONVERGED ${value === null ? 'as committed' : value === UNSET ? 'unset' : JSON.stringify(value)}`;
                  const script = value === null ? deferAsCommitted : converged(deferAsCommitted, persona, verb, value);
                  for (const type of ['verb-chain', 'start']) {
                    const paused = runBlock('bash', script, persona, { ...CHAIN, readOutput: `{"workflow_type":"${type}"}` });
                    strictEqual(paused.status, 0, `${label}, ${type}: ${paused.stderr}`);
                    deepStrictEqual(paused.log, ['find-active', 'read', 'awaiting-owner-clear'], `${label}, ${type}: no terminal write`);
                    for (const part of [' --gate recurring-finding ', ' --next-step-kind verb --next-step-verb <refine|decide|investigate> --next-step-confidence <HIGH|MEDIUM|LOW>']) ok(paused.argv[2].includes(part), `${label}, ${type}: ${part}: ${paused.argv[2]}`);
                    ok(/PAUSED \(not converged\)/.test(paused.stderr), `${label}, ${type}: the pause is reported`);
                  }
                }
                const refusedPause = runBlock('bash', converged(deferAsCommitted, persona, verb, 'no'), persona, { ...CHAIN, clearStatus: 3 });
                deepStrictEqual([refusedPause.status, refusedPause.log], [3, ['find-active', 'read', 'awaiting-owner-clear']], 'unconverged: a refused clear stops the block');
                ok(!/PAUSED/.test(refusedPause.stderr), 'no pause is reported for a clear that did not happen');
              }
              const quoted = runBlock('bash', fix.replace('<Owner decision: fix the finding now>', "fix it: the team's call"), persona, CHAIN);
              strictEqual(quoted.status, 0, quoted.stderr);
              ok(quoted.argv[1].includes(" --resolution fix it: the team's call "), quoted.argv[1]);
              for (const [name, block, ran] of [['fix now', fix, ['find-active', 'awaiting-owner-clear']], ['defer', defer, ['find-active', 'read', 'awaiting-owner-clear']]]) {
                const failed = runBlock('bash', block, persona, { ...CHAIN, clearStatus: 3 });
                deepStrictEqual([failed.status, failed.log], [3, ran], `${name}: a refused clear stops the block`);
                const none = runBlock('bash', block, persona, { active: '' });
                deepStrictEqual([none.status, none.log], [1, ['find-active']], `${name}: no workflow, nothing written`);
                ok(none.stderr.includes(`✗ No active ${persona} workflow on this branch.`), none.stderr);
                const lost = runBlock('bash', block, persona, { active: '/w/active.md', findStatus: 4 });
                deepStrictEqual([lost.status, lost.log], [4, ['find-active']], `${name}: a failed find stops the block with its status`);
              }
            });

            if (VERB_DESTS.includes(dest)) for (const shell of SHELLS) {
              const finalizeCase = readsDelimited(shell)
                ? `${shell}: the finalize block hands a hostile note to state.mjs byte for byte (plus the heredoc's final newline), and a failed append stops it before settle and finish-verb`
                : `${shell}: a shell whose read has no -d stops the finalize block before any write`;
              it(finalizeCase, () => {
                const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
                if (!readsDelimited(shell)) {
                  // A NOTE the shell inherited must not stand in for the one
                  // its read could not take (Codex review of PC2a2c).
                  for (const inheritedNote of [null, 'a stale note']) {
                    const refused = runBlock(shell, block, persona, { note: HOSTILE_NOTE, inheritedNote });
                    strictEqual(refused.status, 1, refused.stderr);
                    deepStrictEqual(refused.log, [], `nothing was written (inherited NOTE: ${inheritedNote})`);
                  }
                  return;
                }
                const ok_ = runBlock(shell, block, persona, { note: HOSTILE_NOTE });
                strictEqual(ok_.status, 0, ok_.stderr);
                deepStrictEqual(ok_.log, ['append', 'settle', 'finish-verb']);
                strictEqual(ok_.note, `${HOSTILE_NOTE}\n`, 'the note reached state.mjs unread by the shell');
                const inherited = runBlock(shell, block, persona, { note: HOSTILE_NOTE, inheritedNote: 'a stale note' });
                strictEqual(inherited.note, `${HOSTILE_NOTE}\n`, 'the note read, not one the shell inherited');
                // A note that holds the delimiter line, with the delimiter
                // replaced as the prose above the block says.
                const quoting = `${HOSTILE_NOTE}\nPHASE_NOTE\nprintf INJECTED > injected`;
                const renamed = runBlock(shell, block, persona, { note: quoting, delimiter: 'NOTE_END_X' });
                strictEqual(renamed.status, 0, renamed.stderr);
                strictEqual(renamed.note, `${quoting}\n`, 'a renamed delimiter carries the delimiter line as text');
                const failed = runBlock(shell, block, persona, { note: HOSTILE_NOTE, failAppend: true });
                strictEqual(failed.status, 7, 'the block exits with the append\'s status');
                deepStrictEqual(failed.log, ['append'], 'no later write ran');
              });
            }
          }
        });
      }
    }
  }
});
