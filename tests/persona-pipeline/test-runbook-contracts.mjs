// Runbook contracts over the persona command runbooks' generated regions.
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
//     `--write` would produce).
//
// What they hold: the shell blocks' calls, flags, order and `|| exit` stops
// (read from the text, and run with `node` stubbed), and the few agent
// instructions outside the blocks that change what the agent runs — the
// privacy gate before a dispatch, routing between blocks, the owner gates
// and their anchors, the per-profile ensemble type. Each assertion is bound
// to its call site, with a nonzero count, so a contract that matches nothing
// fails instead of passing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  parseRegions,
  regionBody,
  renderTemplate,
  renderingDeclaration,
  replaceRegionBodies,
} from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, pluginRoot } from './_personas.mjs';
import { FIXTURE, characterize } from './_verb-runbooks.mjs';
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
// ADR-0067 Decision 8 — the verbs whose finalize renders the consensus
// variant, each with its conflict gate; compose, frame and refine keep the
// plain finalize and never propose a consensus round.
const CONFLICT_GATES = { decide: 'decide-conflict', critique: 'peer-conflict', investigate: 'peer-conflict' };
const PROPOSED_ROUND = '/runtime:consensus plan --task-file /s/consensus/w.r.md --peers claude,codex --max-rounds 2';
// The calls a finalize block makes on a verdict other than conflict: the find
// (R4, C75: the block finds the workflow itself), then its writes, settle first
// (R4 G1: the one judge of the run refuses before anything is written); the
// consensus variant reads the recorded verdict before the note (R4 J2, J4).
// The calls before settle: the consensus variant reads this phase's last
// recorded result there (R4 K2: a conflict no gate names holds any other verdict).
const preSettle = (verb) => (Object.hasOwn(CONFLICT_GATES, verb) ? ['find-active', 'read'] : ['find-active']);
const typicalLog = (verb) => (Object.hasOwn(CONFLICT_GATES, verb) ? [...preSettle(verb), 'settle', 'ensemble-verdict', 'append', 'finish-verb'] : ['find-active', 'settle', 'append', 'finish-verb']);
// R4 (C75): a finalize block's head lines, filled the way the agent fills
// them — the dispatch's directory (here a directory of its own inside the
// text directory, into which the test writes the runner's result and the
// run's handle; empty when no run launched; the run's own ledger directory
// when a run launched and its directory is gone, R4 J1) and the synthesis
// verdict. Nothing else reaches the block from an earlier one.
const DISPATCH_DIR_LINE = "DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'";
const VERDICT_LINE = "VERDICT='<the synthesis verdict>'";
// R4 K3: the last write's confidence, and, where the verb waits for
// convergence, the step that resolves what is still open, set at the top and
// checked before the first write (`null` leaves a line unfilled).
const CONFIDENCE_LINE = "CONFIDENCE='<HIGH|MEDIUM|LOW>'";
const RESOLVE_LINE = "RESOLVE_VERB='<refine|decide|investigate — the next step that resolves the flagged item, when not converged>'";
// ADR-0068 Decision 2, item 7: with dispatch_target on, the operation
// directory Phase 0 printed; empty here, no operation (its runs:
// test-verb-runbook-runs.mjs, test-persona-operation-lifecycle.mjs).
const OP_DIR_LINE = "OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'";
// A gate resolution's blocks take the one this run's Phase 0 printed, or none;
// filled with `value` (empty: none, so the block opens its own).
const GATE_OP_DIR_RE = /^OP_DIR='<the operation directory Phase 0 of this run printed as OP_DIR; empty when it printed none or the finalize of this (verb|refine) already ran>'$/m;
const gateOpDir = (block, value = '') => block.replace(GATE_OP_DIR_RE, () => `OP_DIR='${value}'`);
function finalizeAs(block, { launched = true, verdict = 'agreed', dir = '"$TEXT_DIR/dispatch"', confidence = 'HIGH', resolve = 'refine' } = {}) {
  ok(block.includes(`${DISPATCH_DIR_LINE}\n${VERDICT_LINE}\n${CONFIDENCE_LINE}\n`), 'the finalize names the dispatch directory, the verdict and the confidence');
  const value = launched ? `DISPATCH_DIR=${dir}` : "DISPATCH_DIR=''";
  let s = block.replace(DISPATCH_DIR_LINE, () => value).replace(VERDICT_LINE, () => `VERDICT='${verdict}'`);
  if (confidence !== null) s = s.replace(CONFIDENCE_LINE, () => `CONFIDENCE='${confidence}'`);
  if (resolve !== null) s = s.replace(RESOLVE_LINE, () => `RESOLVE_VERB='${resolve}'`);
  return s.replace(OP_DIR_LINE, () => "OP_DIR=''");
}
/**
 * The runner's result a dispatch left in its directory, and the run's handle,
 * naming the workflow it ran for (FOUND unless `workflow` says otherwise).
 */
const runResult = (runId = 'r', { workflow = '/w/active.md', handle = true } = {}) => ({
  'dispatch/prompt.xml.run.json': `${JSON.stringify({ ok: true, run_id: runId, status: 'completed', handle_path: 'agentic text.x/run/handle.json' })}\n`,
  ...(handle ? { 'run/handle.json': `${JSON.stringify({ run_id: runId, kind: 'ensemble', workflow_path: workflow })}\n` } : {}),
});
// The workflow find-active prints, and values an earlier block may have left
// in a shell, which a fresh-shell block never reads.
const FOUND = '/w/active.md';
const STALE = "ACTIVE='/w/stale.md'; RUN_ID='stale'; VERDICT='stale'; CONTESTED_FILE='/nonexistent'\n";
/**
 * Two blocks the way separate Bash calls run them, each in a subshell of its
 * own, sharing one directory: the second reads only what the first wrote there.
 */
const inTurn = (first, second) => `${TEXT_DIR_LINE}\nSHARED="$TEXT_DIR"\n(\n${first.replace(TEXT_DIR_LINE, () => 'TEXT_DIR="$SHARED"')}\n) || exit $?\n(\n${second.replace(TEXT_DIR_LINE, () => 'TEXT_DIR="$SHARED"')}\n)\n`;
// The runbooks whose finalize sits under a generated finalize heading, after
// every extension their slots hold (PC2a3 QD7, QD8).
const HEADING_DESTS = ['commands/critique.md', 'commands/refine.md'];
// start: its Phase 0, bootstrap (the clean-baseline gate) and workflow_type
// read, its phase-boundary rules and its terminal block are generated; the
// lifecycle list stays authored. engineer's joined in PC3b U2.
const START = 'commands/start.md';
// The commit surface's runbook (PC3b U4): enrolled exactly where commit_surface
// is on.
const COMMIT = 'commands/commit.md';

// The instructions an extension's authored text holds that change what the
// agent runs: designer's archetype rides on the resolve call as an
// environment prefix decide-registry.mjs reads, and the bounded loop and an
// unverified visual re-critique set the CONVERGED the finalize block reads.
const EXTENSION_ANCHORS = {
  'start-archetype': ['AGENTIC_DESIGNER_PROFILE="<general|ui|flow|cta|content>" \\'],
  'refine-convergence-bound': ['STOP looping: set `CONVERGED=no`', 'visual re-critique **UNVERIFIED**, set `CONVERGED=no`'],
};

/** Each extension's authored text is not empty, and holds its slot's operative instructions. */
function checkExtensionTexts(exts) {
  for (const ext of exts) {
    // Contract: the sync places each extension marker in its slot — a marker
    // left without the text it stands for would pass that check empty.
    ok(ext.text.trim().length > 0, `extension ${ext.id} holds no text`);
    // Contract: the agent running the block — without the archetype prefix the
    // resolve call loses the L4 preset; without CONVERGED=no an unbounded or
    // unverified loop reads as converged and the finalize closes the workflow.
    for (const sentence of EXTENSION_ANCHORS[ext.id] ?? []) strictEqual(sentenceAt(ext.text, sentence).length, 1, `${ext.id}: ${sentence}`);
  }
}

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
// dispatch: the prohibition, generated in the privacy-gate region, and
// designer's screenshot sentence, authored right after the regions.
// investigate's gate covers web search as well as the peer, so it words both
// differently. They are what limits the text an agent passes to WebSearch,
// WebFetch or the peer prompt; no block can enforce them.
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

// A verb whose persona declares terminal_requires_convergence renders
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

// ADR-0059's amendment of 2026-10-10: the texts an agent writes with its file
// tool before a block, one file each, in the directory the block's first line
// names. A block holds the placeholder line; the test fills it, as the agent
// does, with the directory it wrote the files into.
const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
// What the agent writes when a case names nothing else: each file ends with
// one newline, as the file-writing tool leaves it.
const DEFAULT_TEXTS = Object.freeze({
  'note.md': 'n\n',
  'summary.txt': 's\n',
  'next-action.txt': 'the next action\n',
  'request.txt': 'the request\n',
  'resolution.txt': 'the resolution\n',
  'subject.txt': 'feat(x): the subject\n',
  'prompt.xml': '<prompt/>\n',
});
// The flags whose file the stub reads back, as the scripts would.
const TEXT_FILE_FLAGS = ['--phase-note-file', '--next-action-file', '--summary-file', '--original-request-file', '--resolution-file', '--subject-file', '--prompt-file'];
// What a hostile text would leave behind if a shell read it.
const SIDE_EFFECTS = ['pwned', 'pwned2', 'injected'];
// The finalize's check of each file, by every reader's rule: strict UTF-8, no
// NUL byte, text left once blanks are trimmed (settle's rule for the summary).
const FINALIZE_CHECK = 'node -e \'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\\0")||t.trim()===""?1:0)\' "$TEXT_DIR/$TEXT_FILE"';
// The files a script would refuse (`null` leaves one unwritten).
const REFUSED_TEXTS = [
  ['left unwritten', null], ['holding a newline only', '\n'], ['holding blanks', ' \t\n\n'],
  ['holding a BOM and a newline', '\uFEFF\n'], ['holding a no-break space', '\u00A0\n'],
  ['holding a NUL byte', Buffer.from('a\0b\n')], ['holding bytes that are not UTF-8', Buffer.from([0xff, 0x0a])],
];

// A block runs in well under a second. A run still going after this long is
// stopped, so a test the runner timed out does not leave its child running
// beside the suite's next test, and its directory is still removed.
const CHILD_TIMEOUT_MS = 60000;
// How long a stopped run's group has after each signal (see spawnAsync).
const KILL_GRACE_MS = 1000;
// spawnSync's default maxBuffer: a block that prints more fails, as it did.
const CHILD_MAX_BUFFER = 1024 * 1024;

/**
 * What `spawnSync(command, args, { ...options, encoding: 'utf8' })` returns
 * (`status`, `stdout`, `stderr`), without holding the event loop: stdin is
 * closed at once, as spawnSync closes it with no input.
 *
 * The child leads a process group of its own (`detached`). The run is stopped
 * past `timeoutMs` (it then resolves with status null) or once a stream holds
 * more than `maxBuffer` bytes (it then rejects, as spawnSync's ENOBUFS, the
 * error carrying the output kept as `output`). Stopping closes both streams,
 * so nothing more is read or kept, and signals the whole group: on a timeout
 * SIGTERM, then SIGKILL KILL_GRACE_MS later; on an overflow SIGKILL. The run
 * settles once the child has exited and its group is empty, and at most
 * 2 × KILL_GRACE_MS after the stop, so neither a descendant holding a stream
 * open nor one that ignores SIGTERM can keep it waiting. A process that left
 * the group (a session of its own) is not signalled; it only loses the
 * streams.
 */
function spawnAsync(command, args, options = {}, { timeoutMs = CHILD_TIMEOUT_MS, maxBuffer = CHILD_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true });
    const out = { stdout: '', stderr: '' };
    // What stopped the run: 'timeout', or the overflow error.
    let stopped = null;
    let exited = false;
    let settled = false;
    let poll;
    const timer = setTimeout(() => stop('timeout', 'SIGTERM'), timeoutMs);
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      finish();
    };
    // `kill(-pgid)`; ESRCH (the group is empty) and a child that never
    // started (no pid) are not errors here.
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return false;
      }
    };
    const stop = (reason, signal) => {
      if (stopped !== null || settled) return;
      stopped = reason;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      signalGroup(signal);
      const at = Date.now();
      let killed = signal === 'SIGKILL';
      poll = setInterval(() => {
        const waited = Date.now() - at;
        if (!killed && waited >= KILL_GRACE_MS) {
          signalGroup('SIGKILL');
          killed = true;
        }
        if ((exited && !signalGroup(0)) || waited >= 2 * KILL_GRACE_MS) {
          settle(() => (stopped instanceof Error ? reject(stopped) : resolve({ status: null, ...out })));
        }
      }, 20);
    };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8').on('data', (chunk) => {
        out[name] += chunk;
        if (Buffer.byteLength(out[name]) > maxBuffer) {
          stop(Object.assign(new Error(`${command}: ${name} exceeded ${maxBuffer} bytes (ENOBUFS)`), { output: out }), 'SIGKILL');
        }
      });
    }
    child.on('error', (error) => settle(() => reject(error)));
    child.on('exit', () => { exited = true; });
    child.on('close', (status) => {
      if (stopped === null) settle(() => resolve({ status, ...out }));
    });
    child.stdin.end();
  });
}

/**
 * Run a runbook block with `node` stubbed: the stub logs each script
 * subcommand, keeps the phase note it was handed (`--phase-note`, or the file
 * `--phase-note-file` names) and the contents of every text file a call
 * names (`texts`, `[flag, content]` in call order), fails `append` when
 * asked to, answers `find-active` with `active` and `findStatus`, and
 * answers decide's `resolve` with `resolveStatus`, keeping the file it was
 * given and printing a context on stdout and a diagnostic on stderr. The
 * agent's files (`DEFAULT_TEXTS`, `note` as `note.md`, then `texts`, where
 * `null` leaves a file unwritten) go into a directory whose name holds a
 * space, which the block's TEXT_DIR line is set to, and peer-now's prompt
 * file and peer lines likewise; `after` is appended to the block.
 *
 * Asynchronous, so the per-runbook suites can run side by side (C135): each
 * call has its own directory, and the block its own environment, so no two
 * runs share a path or a variable.
 */
async function runBlock(shell, block, persona, { note = null, texts = {}, failAppend = false, active = '', findStatus = 0, resolveStatus = 0, after = '', baseline = '', baselineStatus = 0, readOutput = '{}', readStatus = 0, preflightStatus = 0, settleStatus = 0, clearStatus = 0, argsText = null, diag = '', diagStatus = 0, phase7Status = 0, recorded = '', proposed = PROPOSED_ROUND, taskStatus = 0, newRunId = null, newRunIdStatus = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'pc2a2b-finalize.'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'root'));
    // Phase 0 reads the branch: a repository of its own, on a branch.
    strictEqual((await spawnAsync('git', ['init', '-q', '-b', 'pc2a2b', dir])).status, 0, 'git init');
    const textDir = join(dir, 'agentic text.x');
    mkdirSync(textDir);
    const files = { ...DEFAULT_TEXTS, ...(note === null ? {} : { 'note.md': `${note}\n` }), ...texts };
    for (const [name, content] of Object.entries(files)) {
      if (content === null) continue;
      mkdirSync(dirname(join(textDir, name)), { recursive: true });
      writeFileSync(join(textDir, name), content);
    }
    writeFileSync(join(dir, 'bin', 'node'), [
      '#!/bin/sh',
      // An inline script (start's JSON reads) runs on the real node.
      'if [ "$1" = -e ]; then exec "$STUB_REAL_NODE" "$@"; fi',
      // Each text file a call names, read back as the script would read it.
      `prev=; for a in "$@"; do case "$prev" in ${TEXT_FILE_FLAGS.join('|')}) { printf '%s\\n' "$prev"; cat "$a"; printf '\\036\\n'; } >> "$STUB_TEXTS";; esac; prev="$a"; done`,
      // start's args file is read by the real extractor (PC3b U2); the Phase 7
      // driver is a script without a subcommand, logged by its mode.
      'case "$1" in */start-args.mjs) printf \'start-args\\n\' >> "$STUB_LOG"; shift; exec "$STUB_REAL_NODE" "$STUB_START_ARGS" "$@";; esac',
      'case "$1" in */phase7-commit.mjs) printf \'phase7 %s\\n\' "$3" >> "$STUB_LOG"; printf \'%s\' "$*" | tr \'\\n\' \' \' >> "$STUB_ARGV"; printf \'\\n\' >> "$STUB_ARGV"; exit "$STUB_PHASE7_RC";; esac',
      'printf \'%s\\n\' "$2" >> "$STUB_LOG"',
      // R4 (C119, C26): the run id comes from this persona's own allocator,
      // peer-runner.mjs new-run-id, unless the test gives what it prints.
      'if [ "$2" = new-run-id ]; then printf \'%s\' "$*" | tr \'\\n\' \' \' >> "$STUB_ARGV"; printf \'\\n\' >> "$STUB_ARGV"; if [ -n "${STUB_NEW_RUN_ID+set}" ]; then printf \'%s\' "$STUB_NEW_RUN_ID"; exit "$STUB_NEW_RUN_ID_RC"; fi; shift; exec "$STUB_REAL_NODE" "$STUB_PEER_RUNNER" "$@"; fi',
      'printf \'%s\' "$*" | tr \'\\n\' \' \' >> "$STUB_ARGV"; printf \'\\n\' >> "$STUB_ARGV"',
      'if [ "$2" = find-active ]; then printf \'%s\\n\' "$STUB_ACTIVE"; exit "$STUB_FIND_RC"; fi',
      // A run prints its result, with the run id it was given (R4: a finalize
      // reads the id from the result the dispatch left).
      'if [ "$2" = run ]; then rid=; wf=; prev=; for a in "$@"; do if [ "$prev" = --run-id ]; then rid="$a"; fi; if [ "$prev" = --workflow-path ]; then wf="$a"; fi; prev="$a"; done; hp="$PWD/handle-$rid.json"; printf \'{"run_id":"%s","workflow_path":"%s"}\\n\' "$rid" "$wf" > "$hp"; printf \'{"ok":true,"run_id":"%s","handle_path":"%s"}\\n\' "$rid" "$hp"; exit 0; fi',
      'if [ "$2" = autopilot-preflight ]; then exit "$STUB_PREFLIGHT_RC"; fi',
      'if [ "$2" = settle ]; then exit "$STUB_SETTLE_RC"; fi',
      // ADR-0067 Decision 8: the verdict a settle recorded, and the round a
      // task file proposes.
      'if [ "$2" = ensemble-verdict ]; then printf \'%s\\n\' "$STUB_RECORDED"; exit 0; fi',
      'if [ "$2" = consensus-task ]; then printf \'%s\\n\' "$STUB_PROPOSED"; exit "$STUB_TASK_RC"; fi',
      'if [ "$2" = awaiting-owner-clear ]; then exit "$STUB_CLEAR_RC"; fi',
      'if [ "$2" = check-clean-baseline ]; then printf \'%s\' "$STUB_BASELINE"; exit "$STUB_BASELINE_RC"; fi',
      'if [ "$2" = diagnose-redundancy ]; then printf \'%s\' "$STUB_DIAG"; exit "$STUB_DIAG_RC"; fi',
      'if [ "$2" = read ]; then printf \'%s\' "$STUB_READ"; exit "$STUB_READ_RC"; fi',
      'if [ "$2" = create ]; then printf \'%s\\n\' "$STUB_CREATED"; exit 0; fi',
      'if [ "$2" = resolve ]; then printf \'%s\\n\' "$4" > "$STUB_ARGS"; printf \'%s\\n\' "$STUB_CONTEXT"; printf \'%s\\n\' "$STUB_DIAGNOSTIC" >&2; exit "$STUB_RESOLVE_RC"; fi',
      'if [ "$2" = append ]; then',
      '  while [ $# -gt 0 ]; do if [ "$1" = --phase-note ]; then printf \'%s\' "$2" > "$STUB_NOTE"; elif [ "$1" = --phase-note-file ]; then cat "$2" > "$STUB_NOTE"; fi; shift; done',
      '  if [ -n "$STUB_FAIL_APPEND" ]; then exit 7; fi',
      'fi',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    let script = block.replace(TEXT_DIR_LINE, () => `TEXT_DIR='${textDir}'`)
      .replace("PEER='<claude|codex, from --peer>'", () => "PEER='codex'");
    // A start block that reads an args file gets one, as the runbook's steps
    // write it (PC3b U2).
    if (argsText !== null) {
      mkdirSync(join(dir, 'start-args'));
      writeFileSync(join(dir, 'start-args', 'args.json'), JSON.stringify({ agentic_args: 1, text: argsText }));
      script = script.replace("ARGS_DIR='<directory from step 1>'", () => `ARGS_DIR='${join(dir, 'start-args')}'`);
    }
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
      STUB_TEXTS: join(dir, 'texts'),
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
      STUB_RECORDED: recorded,
      STUB_PROPOSED: proposed,
      STUB_TASK_RC: String(taskStatus),
      STUB_CLEAR_RC: String(clearStatus),
      STUB_DIAG: diag,
      STUB_DIAG_RC: String(diagStatus),
      STUB_PHASE7_RC: String(phase7Status),
      STUB_START_ARGS: join(pluginRoot(persona), 'scripts', 'start-args.mjs'),
      STUB_PEER_RUNNER: join(pluginRoot(persona), 'scripts', 'peer-runner.mjs'),
      ...(newRunId === null ? {} : { STUB_NEW_RUN_ID: newRunId }),
      STUB_NEW_RUN_ID_RC: String(newRunIdStatus),
      STUB_CONTEXT: RESOLVER_CONTEXT,
      STUB_DIAGNOSTIC: RESOLVER_DIAGNOSTIC,
      ...(failAppend ? { STUB_FAIL_APPEND: '1' } : {}),
    };
    const r = await spawnAsync(shell, ['-c', script], { cwd: dir, env });
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
    const textsRead = (read('texts') ?? '').split('\x1e\n').filter(Boolean).map((chunk) => [chunk.slice(0, chunk.indexOf('\n')), chunk.slice(chunk.indexOf('\n') + 1)]);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: (read('log') ?? '').split('\n').filter(Boolean), argv: (read('argv') ?? '').split('\n').filter(Boolean), note: read('note'), out: read('out'), args: read('args'), texts: textsRead, textDir, sideEffects: SIDE_EFFECTS.filter((f) => existsSync(join(dir, f))) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Contract: a stopped run settles in bounded time and leaves no process of its
// group behind, even one that holds the output open and ignores SIGTERM; past
// the output cap nothing more is kept, even while a process that left the
// group still writes.
describe("the block runner's child helper stops a run whole", () => {
  /** Whether process `pid` still runs after up to `ms` of waiting for it to go. */
  async function stillRunning(pid, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
    }
    return true;
  }

  it('settles past its time limit and kills its group, a background process holding stdout and ignoring SIGTERM included', async () => {
    const timeoutMs = 300;
    const started = Date.now();
    const r = await spawnAsync('sh', ['-c', `(trap '' TERM; exec sleep 30) & echo "$!"`], {}, { timeoutMs });
    const elapsed = Date.now() - started;
    const pid = Number(r.stdout.trim());
    try {
      strictEqual(r.status, null, 'a stopped run has no exit status');
      ok(pid > 0, `the sleeper's pid on stdout: ${JSON.stringify(r.stdout)}`);
      ok(elapsed < timeoutMs + 2 * KILL_GRACE_MS + 1000, `settled ${elapsed} ms after the start`);
      strictEqual(await stillRunning(pid, 3000), false, 'the sleeper was killed with its group');
    } finally {
      if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('keeps no output past its cap, while a writer that left the group still writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-async.'));
    const maxBuffer = 64 * 1024;
    // A writer in a session of its own, which the group's SIGKILL misses: it
    // records its pid, writes 8 MiB on the run's stdout, then marks that it
    // finished.
    const writer = "require('fs').writeFileSync(process.argv[2],String(process.pid));const c='x'.repeat(65536);let n=0;const w=()=>{while(n<128){n++;if(!process.stdout.write(c))return process.stdout.once('drain',w)}require('fs').writeFileSync(process.argv[1],'')};w()";
    const launcher = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},process.argv[1],process.argv[2]],{detached:true,stdio:['ignore','inherit','ignore']}).unref()`;
    let pid = 0;
    try {
      const error = await spawnAsync(process.execPath, ['-e', launcher, join(dir, 'finished'), join(dir, 'pid')], {}, { maxBuffer }).then(() => null, (e) => e);
      ok(error?.output, `the run rejected with the output it kept: ${error}`);
      pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      // Its stdout closed, the writer stops on EPIPE; it has its time either way.
      await stillRunning(pid, 5000);
      const kept = Buffer.byteLength(error.output.stdout);
      ok(kept > maxBuffer && kept <= maxBuffer + 65536, `${kept} bytes kept`);
      strictEqual(existsSync(join(dir, 'finished')), false, 'the writer lost its stdout before it wrote 8 MiB');
    } finally {
      if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

// Text a phase note may hold that a shell would read if it were spliced into
// a command: quotes, an expansion, a command substitution, a backtick, an
// apostrophe, the persona's own skill mention, a trailing backslash, a line
// reading as the retired heredoc's delimiter with a command after it, a
// leading `--`, a CRLF line end, non-ASCII text and a blank line at the end.
const HOSTILE_NOTE = [
  '### Artifact',
  '',
  'He said "go"; it\'s $HOME and $(touch pwned) and `touch pwned2`',
  '- next_command:          /founder:frame … or $founder:frame for a verb',
  'ends with a backslash \\',
  'PHASE_NOTE',
  'printf INJECTED > injected',
  '--looks-like-a-flag',
  'a CRLF line\r',
  '비ASCII: é ✓',
  '',
].join('\n');
// A summary and a next action as hostile, each on one line.
const HOSTILE_SUMMARY = '--agreed: "A" $(touch pwned) `touch pwned2` it\'s \\ done';
const HOSTILE_NEXT = 'Critique "it" — $(touch pwned) or `touch pwned2`; it\'s /founder:critique';

// The convergent finalize is a variant of the plain one, not a second copy
// that can drift: the plain template with the convergence paragraph before
// the last-write paragraph, and its terminal write, comment and call,
// indented in the then branch of the fail-closed check. The variant's own
// lines (the paragraph, the check, the else branch) are bound by the refine
// finalize, start terminal and Owner decision runs. The anchors below only
// slice the two templates for the rebuild.
// Contract: the sync renders the variant for a persona that waits for
// convergence — a shared line that drifts (a dropped `|| exit $?`) changes
// what that persona's terminal block runs while the plain one stays right.
describe('each convergent variant is its plain template plus the convergence check, nothing else', () => {
  const LAST = 'The last write, `finish-verb`, records';
  const TERMINAL_COMMENT = '# ADR-0029 §1 / completion-output contract §2';
  // R4 (C133): the finalize asks for the not-converged next action in its
  // step 2, before the block runs, as lines of its own after the shared ones.
  const FINALIZE_STEP2 = ['   scripts remove; nothing deletes the files.\n', '\n   When the re-critique did not converge (below), `next-action.txt` holds the\n   flagged item and the next step that resolves it.\n'];
  // R4 K3: the convergence and the resolving step are set at the top of the
  // block, with the other values, and the resolving step is checked with the
  // confidence, before the first write.
  const FINALIZE_TOP = ["CONFIDENCE='<HIGH|MEDIUM|LOW>'\n", "# The convergence, fail-closed: shell state does not survive between Bash\n# calls, so an unset CONVERGED reads as not converged, never as success.\n# Assign it here, from the re-critique verdict, and, not converged, the next\n# step that resolves the flagged item.\nCONVERGED=\"<yes|no — from the re-critique verdict; unset means no>\"\nRESOLVE_VERB='<refine|decide|investigate — the next step that resolves the flagged item, when not converged>'\n"];
  const FINALIZE_CHECKS = ["the last write records; nothing was written.\" >&2; exit 1 ;;\nesac\n", "# Not converged, the last write records RESOLVE_VERB as the next step: checked\n# here as well.\nif [ \"${CONVERGED:-no}\" != \"yes\" ]; then\n  case \"$RESOLVE_VERB\" in\n    refine|decide|investigate) ;;\n    *) echo \"✗ CONVERGED is not yes, and RESOLVE_VERB is not refine, decide or investigate, the next step that resolves the flagged item; nothing was written.\" >&2; exit 1 ;;\n  esac\nfi\n"];
  // [plain, variant, the variant's paragraph opening, the paragraph the
  // convergence paragraph precedes, where the plain terminal part opens, and
  // the variant's own lines elsewhere: [the plain line they follow, the lines]]
  const PAIRS = [
    ['verb-finalize.md', 'verb-finalize-convergent.md', 'This verb closes only once it converged', LAST, (plain) => plain.indexOf(TERMINAL_COMMENT), [FINALIZE_STEP2, FINALIZE_TOP, FINALIZE_CHECKS]],
    ['start-terminal.md', 'start-terminal-convergent.md', 'This lifecycle closes only once Phase 4 converged', LAST, (plain) => plain.indexOf(TERMINAL_COMMENT)],
    // The deferral's clear and terminal write: the Defer block's second clear.
    ['refine-owner-decision.md', 'refine-owner-decision-convergent.md', 'This refine closes only once it converged', '**Fix now.**', (plain) => plain.lastIndexOf('node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \\\n')],
  ];
  for (const [plainName, variantName, opening, before, terminalFrom, own = []] of PAIRS) {
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
      let rebuilt = plain.replace(before, () => `${para}${before}`).replace(terminal, () => `${variant.slice(headAt, thenEnd)}${indented}${elseBranch}`);
      for (const [after, lines] of own) {
        strictEqual(plain.split(after).length - 1, 1, `the plain line the variant's own lines follow: ${after}`);
        rebuilt = rebuilt.replace(after, () => `${after}${lines}`);
      }
      strictEqual(variant, rebuilt);
    });
  }
});

// The consensus finalize (ADR-0067 Decision 8) is a variant of the plain one
// as well: the conflict paragraph before the last-write paragraph, the
// recorded-verdict check (its mismatch stops and the conflict's task file)
// between the settle and the note (R4 J2, J4), and the plain terminal write,
// comment and call, indented in the first branch of a check on the recorded
// verdict, the conflict gate in the other. Its own lines are bound by the
// conflict run.
// Contract: the sync renders it for decide, critique and investigate — a
// shared line that drifts changes what those verbs' last write runs while
// compose, frame and refine stay right.
describe('the consensus variant is the plain finalize plus the conflict branch, nothing else', () => {
  const read = (rel) => readFileSync(join(REPO_ROOT, 'persona-pipeline', rel), 'utf8');
  it('verb-finalize-consensus.md: rebuilt from verb-finalize.md and the variant\'s own lines, it is byte for byte the variant', () => {
    const plain = read('regions/verb-finalize.md');
    const variant = read('regions/verb-finalize-consensus.md');
    const LAST = 'The last write, `finish-verb`, records';
    const opening = 'A synthesis verdict of `conflict` ends this verb on its conflict gate';
    const para = variant.slice(variant.indexOf(opening), variant.indexOf(LAST));
    ok(variant.indexOf(opening) >= 0 && para.endsWith('.\n\n'), 'the conflict paragraph, right before the last-write paragraph');
    const terminalAt = plain.indexOf('# ADR-0029 §1 / completion-output contract §2');
    const terminal = plain.slice(terminalAt, plain.indexOf('# The owner-decision form, for an owner gate'));
    ok(terminalAt > 0 && /\nnode "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" finish-verb \\\n/.test(terminal), 'the plain terminal write, comment and call');
    const indented = terminal.replace(/^(?=.)/gm, '  ');
    // The recorded-verdict check, between the settle and the note.
    const APPEND = 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \\\n';
    strictEqual(plain.split(APPEND).length - 1, 1, 'the plain note append');
    const headAt = variant.indexOf('# ADR-0067 Decision 8 — the verdict the settle above recorded');
    const checkEnd = variant.indexOf('\nfi\n\n', headAt) + '\nfi\n\n'.length;
    ok(headAt > 0 && variant.slice(checkEnd).startsWith(APPEND), 'the recorded-verdict check, right before the note');
    const check = variant.slice(headAt, checkEnd);
    const FIRST = 'if [ "$RECORDED" != conflict ]; then\n';
    const firstAt = variant.indexOf(FIRST, checkEnd);
    const thenEnd = firstAt + FIRST.length;
    ok(firstAt > checkEnd, 'the branch on the recorded verdict, after the note');
    strictEqual(variant.slice(thenEnd, thenEnd + indented.length), indented, 'the first branch is the plain terminal write, indented');
    const restAt = thenEnd + indented.length;
    const rest = variant.slice(restAt, variant.indexOf('\nfi\n', restAt) + '\nfi\n'.length);
    ok(rest.startsWith('else\n'), 'the conflict gate follows');
    // R4: a conflict's contested.md is checked with the other texts, before any
    // write — the variant's own lines right after the plain check loop.
    const LOOP_END = 'done\n\n# ADR-0066 PC2b — settle the ensemble attempt from its ledger';
    const precheckAt = variant.indexOf('# The contested items a conflict ends on');
    // R4 K1, K2, L1, L2: then the run id this variant's later steps read, and
    // every result this phase recorded with the gate, up to settle.
    const precheck = variant.slice(precheckAt, variant.indexOf('\n\n# ADR-0066 PC2b', precheckAt) + 1);
    ok(precheckAt > 0 && precheck.includes('"$TEXT_DIR/contested.md"') && precheck.includes('state.mjs" read --workflow-path "$ACTIVE"'), 'the contested.md check, the run-id checks and the last result read');
    strictEqual(plain.split(LOOP_END).length - 1, 1, 'the plain check loop, then settle');
    const rebuilt = plain.replace(LAST, () => `${para}${LAST}`).replace(APPEND, () => `${check}${APPEND}`).replace(terminal, () => `${FIRST}${indented}${rest}`)
      .replace(LOOP_END, () => LOOP_END.replace('done\n', () => `done\n${precheck}`));
    strictEqual(variant, rebuilt);
  });
  it('the manifest renders it into exactly decide, critique and investigate, each with its conflict gate', () => {
    const regions = JSON.parse(read('manifest.json')).regions.filter((r) => /^[a-z]+-finalize$/.test(r.id));
    const variant = Object.fromEntries(regions.filter((r) => r.template === 'regions/verb-finalize-consensus.md')
      .map((r) => [r.id.replace('-finalize', ''), [r.substitutions.conflict_gate?.value, r.substitutions.conflict_gate_word?.value]]));
    deepStrictEqual(variant, Object.fromEntries(Object.entries(CONFLICT_GATES).map(([v, g]) => [v, [g, g]])));
  });
});

// The runbooks whose regions every persona is enrolled into (commit.md follows
// commit_surface instead).
const ENGINEER_JOINED = new Set(['commands/checkpoint.md', 'commands/peer-now.md', 'commands/resume.md', 'commands/frame.md', 'commands/compose.md', 'commands/decide.md', 'commands/critique.md', 'commands/refine.md', 'commands/investigate.md', 'commands/start.md']);

// The suites below, one per persona, runbook and document, run side by side,
// as many at a time as the machine has cores; the tests inside each run one
// after another, so a test's time is its own work, not a share of every
// suite's (C135: run one after another, the file took 19 minutes).
describe('runbook regions: the contracts hold for every enrolled persona', { concurrency: availableParallelism() }, () => {
  it('the contracts reach the region files they are about (guards a vacuous pass)', () => {
    for (const dest of ['commands/checkpoint.md', 'commands/resume.md', 'commands/peer-now.md', ...PIPELINE_VERB_DESTS, START]) {
      ok(covered(dest), `${dest} has no generated region`);
      deepStrictEqual([...FILES.get(dest)].sort(), ENGINEER_JOINED.has(dest) ? ['designer', 'engineer', 'founder'] : ['designer', 'founder'], `${dest}: enrolled personas`);
    }
    const commitOn = ['designer', 'engineer', 'founder'].filter((p) => declaration(p).capabilities?.commit_surface === true);
    ok(covered(COMMIT) && commitOn.length > 0, `${COMMIT} has no generated region`);
    deepStrictEqual([...FILES.get(COMMIT)].sort(), commitOn, `${COMMIT}: enrolled personas`);
    deepStrictEqual([...FILES.keys()].sort(), [...ENGINEER_JOINED, COMMIT].sort(), 'every runbook with regions is one the contracts name');
  });

  for (const [dest, personas] of FILES) {
    for (const persona of [...personas].sort()) {
      for (const [which] of documents(persona, dest)) {
        describe(`${persona}/${dest} (${which})`, { concurrency: false }, () => {
          const text = new Map(documents(persona, dest)).get(which);
          const env = renderingDeclaration(declaration(persona)).derived.root_env;

          it('every shell block opens with this persona\'s resolver, and nothing is left unrendered', () => {
            const blocks = shellBlocks(text).filter((b) => /CLAUDE_PLUGIN_ROOT/.test(b.text));
            ok(blocks.length > 0, 'no shell block uses the plugin root');
            for (const b of blocks) {
              const lines = b.text.split('\n');
              // The directories and values the agent fills in come first: the
              // args or text directory, peer-now's peer and prompt file, and a
              // finalize's dispatch directory, synthesis verdict and confidence,
              // and where the verb waits for convergence its convergence, with the
              // comment saying how it is filled, and its resolving step (R4, K3),
              // and with dispatch_target on the operation directory Phase 0
              // printed (ADR-0068 Decision 2, item 7).
              let at = 0;
              while (/^(ARGS_DIR|TEXT_DIR|DISPATCH_DIR|READ_DIR|VERDICT|CONFIDENCE|RESOLVE_VERB|PEER|PROMPT_FILE|OP_DIR)='<[^'>]+>'$|^CONVERGED="<[^">]+>"$|^# /.test(lines[at] ?? '')) at++;
              // Contract: the agent running a block in a fresh shell — without the
              // persona's own override and cache path the block runs another
              // plugin's scripts, or none. A block nested in a list item is indented.
              strictEqual(lines[at].trim(), `ROOT_OVERRIDE="$(printenv '${env}' || true)"`, `${persona}: block at line ${b.start + 1}`);
              ok(lines[at + 2].includes(`agentic-plugins/'${persona}' -mindepth`), `${persona}: cache path at line ${b.start + 1}`);
            }
            // Contract: the agent running a block — an unrendered {{placeholder}} is run as text.
            ok(!text.includes('{{'), 'a placeholder survived the render');
          });

          // The repository-wide runbook gates read committed files; their rules
          // run here on both documents, so the next --write cannot break them.
          // Contract: the resolver rule as above; the completion block's six
          // fields and next_command are the hand-off the completion-output
          // contract fixes; the archive-timing note above each terminal write
          // names --terminal-marker false, the only way to keep the workflow open.
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
              // The consensus variant's conflict branch (ADR-0067 Decision 8) records
              // its gate with one more finish-verb, which carries the note too.
              deepStrictEqual([timing.sites, timing.problems], [(['commands/decide.md', 'commands/refine.md'].includes(dest) ? 2 : 1) + (Object.hasOwn(CONFLICT_GATES, verbOf(dest)) ? 1 : 0), []], 'each terminal write carries its archive-timing note');
            }
          });

          // Contract: the host's background task runs the runner in its
          // foreground, and collection waits for its exit notification — a
          // shell `&` detaches the runner and the host never reports it done.
          it('no dispatch detaches: the runner command ends without a shell &', () => {
            const runs = shellBlocks(text).filter((b) => /peer-runner\.mjs" run\b/.test(b.text));
            if (PIPELINE_VERB_DESTS.includes(dest) || dest === 'commands/peer-now.md') ok(runs.length > 0, 'the dispatch block');
            for (const b of runs) {
              const code = logical(b.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
              const command = code.split('\n').find((l) => /peer-runner\.mjs" run\b/.test(l));
              ok(!/(^|[^&])&\s*$/.test(command), `${persona}: the runner command at line ${b.start + 1} detaches: ${command}`);
            }
          });

          // Contract: the companion peer path has no image channel — an `--image`
          // flag on a runner call is refused, or would send image bytes off the host.
          it('no shell block passes an image to the peer (the companion path has no image channel)', () => {
            const runs = shellSites(text, /peer-runner\.mjs" run/);
            if (dest === 'commands/peer-now.md') strictEqual(runs.length, 1, 'peer-now dispatches once');
            strictEqual(shellSites(text, /--image\b/).length, 0, `${persona}: --image in a shell block`);
          });

          if (dest === 'commands/checkpoint.md') {
            // Contract: the agent running /checkpoint — a checkpoint-set on any
            // other path than the $ACTIVE find-active printed writes the wrong workflow.
            it('the checkpoint is written to the workflow find-active found, after finding it', () => {
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active /m);
              const set = shellSites(text, /state\.mjs" checkpoint-set \\\n\s+--workflow-path "\$ACTIVE" /);
              strictEqual(find.length, 1, 'find-active sites');
              strictEqual(set.length, 1, 'checkpoint-set sites on $ACTIVE');
              ok(find[0] < set[0], 'find-active precedes checkpoint-set');
            });

            // Contract (ADR-0059, amendment of 2026-10-10): the agent passing the
            // summary the user typed — it reaches state.mjs as the file the agent
            // wrote, and a summary left unwritten stops the block before the write.
            it('the checkpoint summary is a file the agent wrote, read as written', async () => {
              const block = shellBlocks(region(text, 'checkpoint-set')).find((b) => b.text.includes('checkpoint-set'));
              ok(block.text.startsWith(`${TEXT_DIR_LINE}\n`), 'the block names the text directory first');
              ok(!/--summary "|SUMMARY=/.test(block.text), 'no inline summary');
              const summary = { 'summary.txt': "it's \"done\": $(touch pwned) `touch pwned2`\n" };
              // R4 (C75): a fresh shell — the block finds the workflow itself,
              // and an ACTIVE an earlier block left is not what it writes.
              for (const shell of SHELLS) {
                const r = await runBlock(shell, `ACTIVE='/w/stale.md'\n${block.text}`, persona, { texts: summary, active: '/w/active.md' });
                deepStrictEqual([r.status, r.log], [0, ['find-active', 'checkpoint-set']], `${shell}: ${r.stderr}`);
                ok(r.argv[1].includes(` --workflow-path /w/active.md --host claude --summary-file ${r.textDir}/summary.txt`), r.argv[1]);
                deepStrictEqual([r.texts, r.sideEffects], [[['--summary-file', summary['summary.txt']]], []], shell);
              }
              const unwritten = await runBlock('bash', block.text, persona, { texts: { 'summary.txt': null }, active: '/w/active.md' });
              deepStrictEqual([unwritten.status, unwritten.log], [1, ['find-active']], 'nothing written');
              for (const [why, find] of [['no workflow found', { active: '' }], ['a failed find', { active: '', findStatus: 3 }]]) {
                const none = await runBlock('bash', `ACTIVE='/w/stale.md'\n${block.text}`, persona, find);
                deepStrictEqual([none.status, none.log], [find.findStatus ?? 1, ['find-active']], `${why}: nothing written`);
              }
            });
          }

          if (dest === 'commands/resume.md') {
            // Contract: the agent running /resume — the read and the resumed
            // marker must target the workflow find-active found, in that order.
            it('resume finds, reads, then marks the same workflow; archive acts on the one it resolved', () => {
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active --repo-root/m);
              const read = shellSites(text, /state\.mjs" read --workflow-path "\$ACTIVE"/);
              const mark = shellSites(text, /state\.mjs" append \\\n\s+--workflow-path "\$ACTIVE" [^\n]*\\\n(?:[^\n]*\\\n)+\s+--event resumed/);
              const archive = shellSites(text, /state\.mjs" archive \\\n\s+--workflow-path "\$WORKFLOW" /);
              deepStrictEqual([find.length, read.length, mark.length, archive.length], [1, 1, 1, 1], 'site counts');
              ok(find[0] < read[0] && read[0] < mark[0], 'find-active, read, append in that order');
              ok(mark[0] < archive[0], 'the archive mode follows the resume mode');
            });

            // Contract: the agent running the marker block — a resumed event over a
            // baseline whose commit object is gone breaks host_history fidelity.
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
              // Contract (ADR-0059, amendment of 2026-10-10): the drift summary is
              // the agent's text — a file it wrote, checked before the append.
              ok(code.startsWith(`${TEXT_DIR_LINE}\n`), 'the block names the text directory first');
              const check = code.indexOf('grep -q \'[^[:space:]]\' "$TEXT_DIR/note.md" 2>/dev/null ||', otherwise);
              ok(check > otherwise && check < append && code.includes('--phase-label "Resume" --phase-note-file "$TEXT_DIR/note.md" \\'), code);
              ok(!/--phase-note "/.test(code), 'no inline note');
              ok(text.includes(`Re-entered via /${persona}:resume; drift=<clean|dirty>. <one-paragraph diff summary, or 'no changes since baseline'>\n`), 'the note scaffold names this persona\'s resume');
            });

            // R4 (C110, C75): the read lands whole in a directory of this
            // resume's own, its status checked; the drift report and the marker
            // read it from there, each in a fresh shell. A shared /tmp name let
            // a failed read leave another session's baseline for the marker.
            it('resume read, drift report and marker, run: a checked read into the resume\'s own directory, read again by each later block in its own shell; a failed read stops, and concurrent resumes keep apart (R4)', async () => {
              const read = shellBlocks(region(text, 'resume-read')).find((b) => b.text.includes(' read --workflow-path "$ACTIVE"'));
              const mark = shellBlocks(region(text, 'resume-marker')).find((b) => b.text.includes('--event resumed'));
              // engineer's drift report is an authored block after the read.
              const drift = shellBlocks(text).find((b) => b.text.includes('DRIFT=clean'));
              ok(read && mark, 'the read and marker blocks');
              // The read's directory (machine data) apart from the marker's note.
              const READ_LINE = /^READ_DIR='<[^'>]+>'$/m;
              for (const b of [read, mark, drift].filter(Boolean)) {
                ok(READ_LINE.test(b.text.split('\n').slice(0, 2).join('\n')), 'the block names the read\'s directory at its head');
                ok(!b.text.includes('/tmp/'), `no shared /tmp path: ${b.text}`);
              }
              ok(read.text.includes('>"$READ_DIR/read.json.part" \\\n  || {') && read.text.includes('mv -f "$READ_DIR/read.json.part" "$READ_DIR/read.json" || exit 1'), 'the read is checked, and lands whole');
              // Each block in a subshell of its own, the way separate Bash calls
              // run them: nothing but the directory passes between them.
              const own = (b) => `(\n${b.text.replace(TEXT_DIR_LINE, () => 'TEXT_DIR="$SHARED"').replace(READ_LINE, () => 'READ_DIR="$SHARED"')}\n)`;
              const commit = 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base || exit 9';
              const script = (blocks, sep = ' || exit $?\n') => `${TEXT_DIR_LINE}\nSHARED="$TEXT_DIR"\n${commit}\n${blocks.map(own).join(sep)}\n`;
              const baseline = (head, id = 'a') => JSON.stringify({ workflow_id: id, workflow_type: 'verb-chain', git_baseline: { branch: 'pc2a2b', head, status_digest: '' } });
              for (const shell of SHELLS) {
                const r = await runBlock(shell, script([read, ...(drift ? [drift] : []), mark]), persona, { active: '/w/a.md', readOutput: baseline('HEAD') });
                deepStrictEqual([r.status, r.log], [0, ['find-active', 'read', 'find-active', 'append']], `${shell}: ${r.stderr}`);
                ok(r.stdout.includes('workflow: /w/a.md\nbaseline: branch=pc2a2b head=HEAD status_digest=\n'), `${shell}: the read prints what it read: ${r.stdout}`);
                if (drift) ok(r.stdout.includes('commits since baseline:'), `${shell}: the drift report read the baseline again: ${r.stdout}`);
                ok(r.argv[3].includes(' append --workflow-path /w/a.md ') && r.argv[3].includes(' --event resumed'), r.argv[3]);
                // A read that fails, even after printing JSON, leaves no read.json:
                // the marker run after it stops, and appends nothing.
                const failed = await runBlock(shell, script([read, mark], ' ; '), persona, { active: '/w/a.md', readOutput: baseline('HEAD'), readStatus: 3 });
                deepStrictEqual([failed.status, failed.log], [1, ['find-active', 'read', 'find-active']], `${shell}: ${failed.stderr}`);
                ok(failed.stderr.includes('state.mjs read failed for /w/a.md') && failed.stderr.includes('read.json in READ_DIR ('), failed.stderr);
              }
              // A read that is not JSON stops the read block itself.
              const garbled = await runBlock('bash', script([read]), persona, { active: '/w/a.md', readOutput: 'not json' });
              deepStrictEqual([garbled.status, garbled.log], [1, ['find-active', 'read']], garbled.stderr);
              // Two resumes at once, each with its own directory: each marker
              // judges its own baseline (an unavailable one appends nothing).
              const [one, two] = await Promise.all([
                runBlock('bash', script([read, mark]), persona, { active: '/w/one.md', readOutput: baseline('HEAD', 'one') }),
                runBlock('bash', script([read, mark]), persona, { active: '/w/two.md', readOutput: baseline('0000000000000000000000000000000000000000', 'two') }),
              ]);
              deepStrictEqual([one.status, one.log, two.status, two.log], [0, ['find-active', 'read', 'find-active', 'append'], 0, ['find-active', 'read', 'find-active']], `${one.stderr}${two.stderr}`);
              ok(one.argv[3].includes(' --workflow-path /w/one.md ') && two.stdout.includes('resume marker NOT appended'), `${one.argv[3]} ${two.stdout}`);
              // The read of another workflow (the branch's workflow changed
              // between the blocks) gives the marker no baseline: it stops.
              const other = await runBlock('bash', script([read, mark]), persona, { active: '/w/a.md', readOutput: baseline('HEAD', 'b') });
              deepStrictEqual([other.status, other.log], [1, ['find-active', 'read', 'find-active']], other.stderr);
              ok(other.stderr.includes('the read of another workflow than /w/a.md'), other.stderr);
              // A read run again in the same directory that fails leaves no
              // earlier read.json for the marker.
              const retry = `${TEXT_DIR_LINE}\nSHARED="$TEXT_DIR"\n${commit}\n${own(read)}\n${own(read).replace('(\n', () => '(\nSTUB_READ_RC=3; export STUB_READ_RC\n')} ; ${own(mark)}\n`;
              const stale = await runBlock('bash', retry, persona, { active: '/w/a.md', readOutput: baseline('HEAD') });
              deepStrictEqual([stale.status, stale.log], [1, ['find-active', 'read', 'find-active', 'read', 'find-active']], stale.stderr);
              ok(stale.stderr.includes('read.json in READ_DIR ('), stale.stderr);
              // So does a retry whose lookup fails before the read: the block
              // empties read.json first, removing nothing (R4 G5; H2: no rm runs
              // in a runbook block).
              ok(!/\brm\b/.test(read.text), 'the read removes nothing');
              for (const shell of SHELLS) {
                const lost = `${TEXT_DIR_LINE}\nSHARED="$TEXT_DIR"\n${commit}\n${own(read)}\n${own(read).replace('(\n', () => '(\nSTUB_ACTIVE=; export STUB_ACTIVE\n')} ; ${own(mark)}\n`;
                const r = await runBlock(shell, lost, persona, { active: '/w/a.md', readOutput: baseline('HEAD') });
                deepStrictEqual([r.status, r.log], [1, ['find-active', 'read', 'find-active', 'find-active']], `${shell}: ${r.stderr}`);
                ok(r.stderr.includes('read.json in READ_DIR ('), `${shell}: ${r.stderr}`);
              }
              // A READ_DIR left unfilled stops the read before anything runs,
              // and says so (R4 G6).
              for (const shell of SHELLS) {
                const unfilled = await runBlock(shell, `${TEXT_DIR_LINE}\n${commit}\n(\n${read.text}\n)\n`, persona, { active: '/w/a.md', readOutput: baseline('HEAD') });
                deepStrictEqual([unfilled.status, unfilled.log], [1, []], `${shell}: ${unfilled.stderr}`);
                ok(unfilled.stderr.includes('READ_DIR (<') && unfilled.stderr.includes('set it to the directory step 1 created'), `${shell}: ${unfilled.stderr}`);
              }
            });

            it('resume takes no argument or archive with an optional workflow id, and an argument starting with archive is routed to archive mode', () => {
              // Contract: Claude Code reads argument-hint from the command frontmatter
              // and offers it on completion — without archive the archive mode is hidden.
              ok(/^argument-hint: .*\barchive \[<workflow-id>\]/m.test(frontmatterOf(text)), 'the argument hint offers archive [<workflow-id>]');
              // Contract: the agent running /resume — this routing is what sends an
              // `archive` argument to the archive block instead of the resume blocks.
              const phase0 = squash(between(text, '<!-- pipeline:end plugin-root -->', '<!-- pipeline:begin resume-locate -->'));
              ok(phase0.includes('Starts with `archive` (case-insensitive)') && /\barchive mode\b/i.test(phase0), phase0);
            });

            it('after find-active, resume branches on its exit status and output: no active workflow, a single path, a per-branch duplicate', () => {
              // Contract: the agent running /resume — the locate block does not stop
              // on find-active's status, so these branches are what stop it on no
              // workflow or a per-branch duplicate before the read.
              const branches = squash(between(text, '<!-- pipeline:end resume-locate -->', '<!-- pipeline:begin resume-read -->'));
              for (const branch of ['Exit 0, empty stdout', 'Exit 0, single path', 'Exit 1, per-branch duplicate']) ok(branches.includes(branch), `${branch}: ${branches}`);
            });
          }

          if (dest === 'commands/peer-now.md') {
            // A persona that declares a peer policy gates the prompt before it
            // leaves the host; engineer declares none and has no gate.
            it('the privacy gate precedes the dispatch, which is synchronous, and the note goes to the workflow found', () => {
              const gate = text.indexOf('PRIVACY GATE:');
              const run = shellSites(text, /peer-runner\.mjs" run/);
              // Contract: the agent writing the --prompt-text it dispatches — a gate
              // after the dispatch block lets the verbatim, ungenericized prompt leave the host.
              if (declaration(persona).peer) {
                ok(gate >= 0, 'the privacy prohibition is present');
                ok(gate < run[0], 'the privacy prohibition precedes the dispatch block');
              } else {
                strictEqual(gate, -1, 'no privacy prohibition without a declared peer policy');
              }
              // Contract: the agent running the dispatch and note blocks — a status read
              // late reads as success, and a note without find-active's own code
              // lands on no workflow when the branch has duplicates.
              strictEqual(shellSites(text, /> "\$RUN_JSON" 2> "\$RUN_ERR"\nRUN_RC=\$\?/).length, 1, 'the runner\'s exit code is read right after it');
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active --repo-root "\$REPO_ROOT" 2>\/tmp\/[^\n]*-find\.err\)"\nFIND_RC=\$\?$/m);
              const note = shellSites(text, /state\.mjs" append \\\n\s+--workflow-path "\$ACTIVE" /);
              deepStrictEqual([find.length, note.length], [1, 1], 'site counts: find-active keeps its exit code, so a per-branch duplicate is told apart from no workflow');
              ok(run[0] < find[0] && find[0] < note[0], 'dispatch, find-active, append in that order');
            });

            it('peer-now takes --peer and exactly one of the two prompt forms', () => {
              // Contract: Claude Code reads argument-hint from the command frontmatter.
              ok(/^argument-hint: --peer <claude\|codex> \(--prompt-text "\.\.\." \| --prompt-file <path>\)$/m.test(frontmatterOf(text)), frontmatterOf(text));
            });

            it('dispatch, run: the run id is a peer-now- id, surfaced on stderr before the runner call, which keys the run with it', async () => {
              // The region's first block is the mktemp step; the dispatch is the runner's.
              const block = shellBlocks(region(text, 'peer-now-dispatch')).find((b) => b.text.includes('/scripts/peer-runner.mjs" run'));
              ok(block, 'the dispatch block');
              // Contract: the agent collecting the run — the id is printed before the
              // runner call, so a dispatch that never returns still names its run.
              ok(block.text.indexOf('echo "peer-now run_id=$RUN_ID" >&2') >= 0 && block.text.indexOf('echo "peer-now run_id=$RUN_ID" >&2') < block.text.indexOf('peer-runner.mjs" run'), 'the run id is surfaced before the runner call');
              const r = await runBlock('bash', block.text, persona, { texts: { 'prompt.xml': 'He said "go"; $(touch pwned) `touch pwned2`\n' }, after: '\nprintf "RECORDED=%s" "$(cat "$TEXT_DIR/prompt.xml.run-id")"' });
              strictEqual(r.status, 0, r.stderr);
              const id = /^peer-now run_id=(peer-now-\d{8}T\d{6}Z-[0-9a-f]{6})$/m.exec(r.stderr)?.[1];
              ok(id, `a peer-now run id on stderr: ${r.stderr}`);
              // R4 (C119): and in the dispatch's directory, where a status or
              // cancel in a shell of its own reads it.
              ok(r.stdout.endsWith(`RECORDED=${id}`), `the run id the dispatch recorded: ${r.stdout}`);
              // R4 (C119, C26): the id is the one this persona's allocator printed,
              // then one runner call keyed with it.
              // With dispatch_target on, the dispatch finds the workflow the
              // consultation is for first (ADR-0068 Decision 2, item 7): none
              // here, so no operation opens.
              const dispatchOn = declaration(persona).capabilities.dispatch_target === true;
              deepStrictEqual(r.log, dispatchOn ? ['new-run-id', 'find-active', 'run'] : ['new-run-id', 'run'], 'the allocation, then one runner call');
              ok(r.argv[0].trimEnd().endsWith(' new-run-id --prefix peer-now'), r.argv[0]);
              const runArgv = r.argv[r.log.indexOf('run')];
              for (const part of [` --run-id ${id} `, ' --kind peer-now ', ' --peer codex ', ` --prompt-file ${r.textDir}/prompt.xml `, ' --output-format text ']) ok(runArgv.includes(part), `${part}: ${runArgv}`);
              for (const shell of SHELLS) {
                for (const [why, alloc] of [['a refused prefix', { newRunId: '', newRunIdStatus: 2 }], ['an empty id', { newRunId: '' }]]) {
                  const unallocated = await runBlock(shell, block.text, persona, { texts: { 'prompt.xml': 'hi\n' }, ...alloc });
                  deepStrictEqual([unallocated.status, unallocated.log], [1, ['new-run-id']], `${shell}, ${why}: nothing dispatched: ${unallocated.stderr}`);
                  ok(unallocated.stderr.includes('new-run-id allocated no run id') && !unallocated.stderr.includes('peer-now run_id='), `${shell}, ${why}: ${unallocated.stderr}`);
                }
              }
              // Contract (ADR-0059, amendment of 2026-10-10): the agent forwarding
              // a --prompt-text — it reaches the runner as the file the agent wrote,
              // never as an argument the shell splits or runs.
              deepStrictEqual([r.texts, r.sideEffects], [[['--prompt-file', 'He said "go"; $(touch pwned) `touch pwned2`\n']], []], 'the prompt file, read as written');
              ok(!/--prompt-text|PROMPT_ARG/.test(block.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), 'no inline prompt form in the block');
              // A --prompt-file's path is the user's text too: its text is
              // written to prompt.xml, and no path reaches the block.
              ok(block.text.startsWith(`${TEXT_DIR_LINE}\n`), 'the block names the text directory first');
              deepStrictEqual(block.text.match(/^PROMPT_FILE=.*$/gm), ['PROMPT_FILE="$TEXT_DIR/prompt.xml"'], 'the prompt is the agent\'s prompt.xml, never a path the agent pastes');
              ok(squash(region(text, 'peer-now-dispatch').split('```bash\nTEXT_DIR=')[0]).includes('write the prompt there as `prompt.xml`: the `--prompt-text`, or the text of the `--prompt-file`, which you read with your file-reading tool.'), 'the step writes either form to prompt.xml');
              // R4 (C75): the runner's result goes beside the prompt, where the
              // note step finds it in a shell of its own.
              deepStrictEqual([block.text.match(/^RUN_JSON=.*$/gm), block.text.match(/^RUN_ERR=.*$/gm)], [['RUN_JSON="$TEXT_DIR/prompt.xml.run.json"'], ['RUN_ERR="$TEXT_DIR/prompt.xml.err"']], 'the result and its stderr in the dispatch\'s directory');
              for (const [how, content] of [['left unwritten', null], ['blank', ' \n\n']]) {
                const stopped = await runBlock('bash', block.text, persona, { texts: { 'prompt.xml': content } });
                // The allocation before the check writes nothing (R4, C119).
                deepStrictEqual([stopped.status, stopped.log], [1, ['new-run-id']], `a prompt ${how}: nothing dispatched`);
                ok(stopped.stderr.includes('prompt.xml in TEXT_DIR (') && stopped.stderr.includes('is missing or blank'), stopped.stderr);
              }
              // R4 J3: the runner's exit status is the block's own, so a failed
              // consultation stops the agent where it sees it, before the note
              // (the runner here a shell function, which a block's `node` finds
              // before the stub on PATH).
              const failing = 'node() { if [ "$2" = run ]; then printf \'{"ok":false,"run_id":"x","error_kind":"peer_cli_not_found"}\\n\'; return 3; fi; command node "$@"; }\n';
              for (const shell of SHELLS) {
                const failed = await runBlock(shell, `${failing}${block.text}`, persona, { texts: { 'prompt.xml': 'hi\n' } });
                strictEqual(failed.status, 3, `${shell}: ${failed.stderr}`);
                ok(failed.stderr.includes('failed (exit 3, peer_cli_not_found)') && failed.stderr.includes('No note is appended for it.'), `${shell}: ${failed.stderr}`);
              }
            });

            // R4 (C119): engineer's authored status and cancel controls read the
            // run id the dispatch recorded, in a shell of their own.
            if (/peer-runner\.mjs" status \\/.test(text)) it('status and cancel, run: in a fresh shell, each names the run id the dispatch recorded; with none recorded, neither runs', async () => {
              const block = shellBlocks(text).find((b) => b.text.includes('/scripts/peer-runner.mjs" status'));
              const LINE = "TEXT_DIR='<the directory the dispatch ran with>'";
              ok(block.text.startsWith(`${LINE}\n`), 'the block names the dispatch\'s directory first');
              const controls = `${TEXT_DIR_LINE}\n${block.text.replace(LINE, () => 'TEXT_DIR="$TEXT_DIR"')}`;
              for (const shell of SHELLS) {
                const r = await runBlock(shell, `RUN_ID='peer-now-stale'\n${controls}`, persona, { texts: { 'prompt.xml.run-id': 'peer-now-20261019T000000Z-0a0b0c' } });
                deepStrictEqual([r.status, r.log], [0, ['status', 'cancel']], `${shell}: ${r.stderr}`);
                for (const a of r.argv) ok(`${a} `.includes(' --run-id peer-now-20261019T000000Z-0a0b0c '), `${shell}: ${a}`);
                for (const [why, texts] of [['no record', {}], ['an empty record', { 'prompt.xml.run-id': '' }]]) {
                  const none = await runBlock(shell, `RUN_ID='peer-now-stale'\n${controls}`, persona, { texts });
                  deepStrictEqual([none.status, none.log], [1, []], `${shell}, ${why}: ${none.stderr}`);
                }
              }
            });

            it('after find-active, peer-now branches three ways (standalone, a single path, a per-branch duplicate sent to this persona\'s resume), and the note, run, is a [Peer] phase note on that workflow that leaves the phase alone', async () => {
              const branches = squash(between(text, '<!-- pipeline:end peer-now-locate -->', '<!-- pipeline:begin peer-now-note -->'));
              // Contract: the agent running /peer-now — the note block runs only on a
              // single path; a duplicate is handed off to this persona's resume.
              ok(/\bstandalone\b/i.test(branches) && /\bsingle path\b/i.test(branches) && /\bper-branch duplicate\b/i.test(branches), branches);
              ok(branches.includes(`/${persona}:resume`), 'the duplicate branch points at this persona\'s resume');
              const [block] = shellBlocks(region(text, 'peer-now-note'));
              ok(block, 'the note block');
              const DISPATCH_LINE = "DISPATCH_DIR='<the directory the dispatch ran with>'";
              ok(block.text.startsWith(`${DISPATCH_LINE}\n`), 'the block names the dispatch\'s directory first');
              // The dispatch's directory, filled as the agent fills it: here the
              // directory the test writes the run's result into.
              const note = `${TEXT_DIR_LINE}\n${block.text.replace(DISPATCH_LINE, () => 'DISPATCH_DIR="$TEXT_DIR"')}`;
              // R4 (C75): a fresh shell — the run comes from the result the
              // runner wrote in the dispatch's directory, and its peer from the
              // run's handle; the workflow is found again. Values an earlier
              // block left in the shell are not what it records.
              const stale = ["ACTIVE='/w/stale.md'", "PEER='claude'", "RUN_ID='peer-now-stale'", "HANDLE_PATH='/h/stale.json'", 'STDOUT_PATH=/nonexistent'].join('\n');
              const run = (fields) => ({
                'prompt.xml.run.json': JSON.stringify({ ok: true, run_id: 'peer-now-x', handle_path: 'agentic text.x/handle.json', stdout_path: 'agentic text.x/stdout.log', ...fields }),
                'handle.json': JSON.stringify({ run_id: 'peer-now-x', peer_host: 'codex' }),
                'stdout.log': 'the peer said hi',
              });
              for (const shell of SHELLS) {
                const r = await runBlock(shell, `${stale}\n${note}`, persona, { active: '/w/active.md', texts: run({}) });
                strictEqual(r.status, 0, `${shell}: ${r.stderr}`);
                deepStrictEqual(r.log, ['find-active', 'append'], `${shell}: one append`);
                for (const part of [' --workflow-path /w/active.md ', ' --phase-label [Peer] codex consultation ']) ok(r.argv[1].includes(part), `${shell}: ${part}: ${r.argv[1]}`);
                ok(r.argv[1].trimEnd().endsWith(' --event updated'), r.argv[1]);
                ok(!/ --(current-phase|next-action|verb|clear-next-step) /.test(r.argv[1]), `the note leaves the phase alone: ${r.argv[1]}`);
                strictEqual(r.note, 'peer: codex\nrun_id: peer-now-x\nhandle: agentic text.x/handle.json\nprompt-mode: verbatim\n\n### Response\n\nthe peer said hi', shell);
              }
              // No result, a result naming no run, or a handle it cannot read:
              // nothing is written.
              for (const [why, texts] of [['no result', { ...run({}), 'prompt.xml.run.json': null }], ['a result still empty', { ...run({}), 'prompt.xml.run.json': '' }], ['no run id', run({ run_id: '' })], ['no handle', { ...run({}), 'handle.json': null }]]) {
                const r = await runBlock('bash', `${stale}\n${note}`, persona, { active: '/w/active.md', texts });
                deepStrictEqual([r.status, r.log], [1, ['find-active']], `${why}: ${r.stderr}`);
              }
              // R4 J3: a consultation that failed gets no note, whatever paths its
              // result names: only ok true, read from the result, lets it through.
              for (const shell of SHELLS) {
                for (const [why, fields, says] of [
                  ['ok false', { ok: false, status: 'failed', error_kind: 'peer_cli_not_found' }, 'did not succeed (peer_cli_not_found;'],
                  ['ok missing', { ok: undefined, status: 'cancelled' }, 'did not succeed (cancelled;'],
                  ['ok the string true', { ok: 'true' }, 'did not succeed (not ok;'],
                ]) {
                  const r = await runBlock(shell, `${stale}\n${note}`, persona, { active: '/w/active.md', texts: run(fields) });
                  deepStrictEqual([r.status, r.log], [1, ['find-active']], `${shell}, ${why}: ${r.stderr}`);
                  ok(r.stderr.includes(says) && r.stderr.includes('no note is appended for a failed consultation'), `${shell}, ${why}: ${r.stderr}`);
                  strictEqual(r.note, null, `${shell}, ${why}: no note`);
                }
              }
              const none = await runBlock('bash', `${stale}\n${note}`, persona, { active: '', texts: run({}) });
              deepStrictEqual([none.status, none.log], [1, ['find-active']], `no workflow found: ${none.stderr}`);
            });
          }

          if (dest === COMMIT) {
            // The commit surface's runbook. Every block resolves the workflow
            // itself (a shell variable does not outlive a Bash call). The region
            // ids, which the sync reads, are what each case slices its block by.
            const only = (id) => {
              const found = shellBlocks(region(text, id));
              strictEqual(found.length, 1, `${persona}/commit: one block in ${id}`);
              return found[0].text;
            };
            const dispatch = declaration(persona).capabilities.dispatch_target === true;

            it('commit Phase 0, run: find-active, a checked read and the /start refusal precede the commit preflight on $ACTIVE; each failure stops the block before the preflight (PC3b U4)', async () => {
              const block = only('commit-phase-0');
              const cases = [
                // [find output, find exit, read output, read exit, preflight exit] → [exit, calls]
                ['/w/a.md', 0, '{"workflow_type":"verb-chain"}', 0, 0, 0, ['find-active', 'read', 'autopilot-preflight']],
                ['/w/a.md', 0, '{}', 0, 0, 0, ['find-active', 'read', 'autopilot-preflight']],
                ['/w/a.md', 0, '{"workflow_type":"start"}', 0, 0, 1, ['find-active', 'read']],
                // A read that fails stops with its status, whatever it printed.
                ['/w/a.md', 0, '{"workflow_type":"verb-chain"}', 3, 0, 3, ['find-active', 'read']],
                ['/w/a.md', 0, 'not json', 0, 0, 1, ['find-active', 'read']],
                ['/w/a.md', 0, '{}', 0, 4, 4, ['find-active', 'read', 'autopilot-preflight']],
                ['', 0, '{}', 0, 0, 1, ['find-active']],
                ['/w/a.md', 5, '{}', 0, 0, 5, ['find-active']],
              ];
              for (const [active, findStatus, readOutput, readStatus, preflightStatus, status, log] of cases) {
                const what = `${JSON.stringify([active, findStatus, readOutput, readStatus, preflightStatus])}`;
                const r = await runBlock('bash', block, persona, { active, findStatus, readOutput, readStatus, preflightStatus });
                deepStrictEqual([r.status, r.log], [status, log], `${what}: ${r.stderr}`);
                if (log.includes('read')) ok(r.argv[1].endsWith(' read --workflow-path /w/a.md'), `${what}: the read targets the found workflow: ${r.argv[1]}`);
                if (log.includes('autopilot-preflight')) ok(/ autopilot-preflight --workflow-path \/w\/a\.md --host \S+ --surface commit$/.test(r.argv[2]), `${what}: the commit surface's preflight on $ACTIVE: ${r.argv[2]}`);
                if (status === 0) strictEqual(r.stdout, 'Workflow: /w/a.md\n', what);
              }
              const start = await runBlock('bash', block, persona, { active: '/w/a.md', readOutput: '{"workflow_type":"start"}' });
              ok(start.stderr.includes(`is an /${persona}:start workflow; its own Phase 7 commits it`), start.stderr);
              const none = await runBlock('bash', block, persona, { active: '' });
              ok(none.stderr.includes(`No active ${persona} workflow on pc2a2b — nothing for /${persona}:commit to commit or close.`), none.stderr);
            });

            it('commit staging clear, run: one write on the workflow found — the gate, the next step commit and its next action; a refused clear stops the block (PC3b U4)', async () => {
              const block = only('commit-staging-clear');
              const r = await runBlock('bash', block, persona, { active: '/w/a.md', after: '\nprintf ran > out\n' });
              deepStrictEqual([r.status, r.log, r.out], [0, ['find-active', 'awaiting-owner-clear'], 'ran'], r.stderr);
              for (const part of [' --workflow-path /w/a.md ', ' --gate staging-set ', ` --next-action Commit the confirmed staging set with /${persona}:commit `, ' --next-step-kind commit --next-step-confidence HIGH']) {
                ok(r.argv[1].includes(part), `${part}: ${r.argv[1]}`);
              }
              const refused = await runBlock('bash', block, persona, { active: '/w/a.md', clearStatus: 6, after: '\nprintf ran > out\n' });
              deepStrictEqual([refused.status, refused.out], [6, null], 'a refused clear stops the block');
              const none = await runBlock('bash', block, persona, { active: '' });
              deepStrictEqual([none.status, none.log], [1, ['find-active']], 'no workflow, no write');
            });

            it('commit driver blocks, run: each finds the workflow, hands it to the driver in its own mode, propagates the driver\'s exit, and never reaches the driver without one; the autopilot block exactly where dispatch_target is on, with no bypass flag (PC3b U4)', async () => {
              // Contract: the sync renders the autopilot block by dispatch_target — a
              // persona without it must not be handed a --mode autopilot call.
              strictEqual(parseRegions(text).regions.some((x) => x.id === 'commit-autopilot'), dispatch, 'the autopilot region');
              const modes = [['commit-plan', 'plan'], ['commit-execute', 'execute'], ['commit-close', 'close'], ...(dispatch ? [['commit-autopilot', 'autopilot']] : [])];
              for (const [id, mode] of modes) {
                const block = only(id);
                const r = await runBlock('bash', block, persona, { active: '/w/a.md' });
                deepStrictEqual([r.status, r.log], [0, ['find-active', `phase7 ${mode}`]], `${id}: ${r.stderr}`);
                ok(r.argv[1].includes(` --mode ${mode} --workflow-path /w/a.md --repo-root /`), `${id}: ${r.argv[1]}`);
                strictEqual((await runBlock('bash', block, persona, { active: '/w/a.md', phase7Status: 3 })).status, 3, `${id}: the driver's exit`);
                deepStrictEqual((await runBlock('bash', block, persona, { active: '' })).log, ['find-active'], `${id}: no workflow, no driver`);
                if (mode === 'autopilot') {
                  const tokens = r.argv[1].split(' ');
                  for (const flag of ['--confirm-non-interactive', '--non-interactive', '--include-extra', '--accept-current-tree', '--subject', '--subject-pkg', '--subject-file', '--subject-pkg-file', '--suggested-subjects']) ok(!tokens.includes(flag), `the autopilot block passes ${flag}`);
                  // Contract: the agent running the autopilot block — reading
                  // ACCEPT_CURRENT_TREE there would bypass the owner's staging-set confirmation.
                  ok(!block.includes('ACCEPT_CURRENT_TREE'), 'the autopilot block reads no accept bypass');
                }
              }
            });
          }

          if (dest === START) {
            const blocks = shellBlocks(text);
            const blockWith = (re) => {
              const found = blocks.filter((b) => re.test(b.text));
              strictEqual(found.length, 1, `${persona}/start: one block matches ${re}`);
              return found[0];
            };
            // With commit_surface on, the bootstrap reads an args file
            // (the description, an optional --base-branch), runs the redundancy
            // probe first, and the lifecycle's one terminal write is the Phase 7
            // driver; off, the request is the placeholder and the terminal write
            // is finish-verb kind commit.
            const commits = declaration(persona).capabilities.commit_surface === true;
            const terminalBlock = () => (commits ? blockWith(/phase7-commit\.mjs" \\\n\s+--mode plan/) : blockWith(/state\.mjs" finish-verb \\/));
            const FEATURE_TEXT = `Fix it's "A"; $(id) > f --base-branch 'feat/x'`;

            // Contract: the sync renders one terminal variant by commit_surface and
            // the declared convergence — two of them would hand the agent two
            // terminal writes, or one the persona's capabilities do not take.
            it('the terminal region is the one variant the declaration selects, and hands the next deliverable to after the archive', () => {
              const id = commits ? 'start-commit' : convergent(persona, 'start') ? 'start-terminal-convergent' : 'start-terminal';
              strictEqual(parseRegions(text).regions.filter((r) => r.id === id).length, 1, `the selected terminal variant ${id}`);
              for (const other of ['start-commit', 'start-terminal', 'start-terminal-convergent'].filter((x) => x !== id)) {
                strictEqual(parseRegions(text).regions.filter((r) => r.id === other).length, 0, `only the terminal variant the declaration selects, not ${other}`);
              }
              // Contract: the hand-off to the next deliverable, where the owner
              // commits — the terminal workflow stays on the branch until the Stop
              // hook archives it, and a `/<persona>:start` there resumes it instead
              // of bootstrapping, so the next deliverable waits for the archive or
              // takes another branch.
              if (!commits) {
                const terminal = squash(region(text, id));
                ok(terminal.includes(`until then \`/${persona}:start\` on this branch finds it and resumes it, so start the next deliverable after the archive, or on another branch`), `${persona}/start: the next deliverable waits for the archive, or takes another branch`);
              }
            });

            it('start Phase 0 runs autopilot-preflight on $ACTIVE after the find guard and before the baseline check or any write; a refusal stops the block (PC2b DD5)', async () => {
              const block = blockWith(/^[ \t]+find-active --repo-root "\$REPO_ROOT"\)"$/m);
              // Contract: the agent running /start under autopilot — a preflight that
              // does not stop the block, or runs after a write, lets a step cross an owner gate.
              ok(/node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" autopilot-preflight --workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" \|\| exit \$\?$/m.test(logical(block.text)), logical(block.text));
              const pre = shellSites(text, /state\.mjs" autopilot-preflight/);
              const later = shellSites(text, /(state\.mjs" (check-clean-baseline|diagnose-redundancy|create|append|set-terminal|finish-verb)|phase7-commit\.mjs")/);
              strictEqual(pre.length, 1, 'one preflight');
              ok(later.length > 0 && later.every((w) => pre[0] < w), 'before the baseline check and every write');
              const refused = await runBlock('bash', block.text, persona, { active: '', preflightStatus: 4, after: '\nprintf ran > out\n' });
              deepStrictEqual([refused.status, refused.out, refused.log], [4, null, ['find-active', 'autopilot-preflight']]);
            });

            // ADR-0067 Decision 8, item 3 — a new request beside an active
            // workflow: the resume region's second block asks the runtime
            // planner for a worktree, from the args file, and writes nothing.
            it('start resume, a new request: the worktree block reads the request from its args file and writes nothing', async () => {
              const block = blockWith(/discover-runtime\.mjs" worktree-plan --repo-root "\$REPO_ROOT" \\\n\s+--args-file /).text;
              ok(block.startsWith(`${ARGS_DIR_LINE}\n`), block);
              const r = await runBlock('bash', block, persona, { argsText: 'Another deliverable' });
              strictEqual(r.status, 0, r.stderr);
              deepStrictEqual(r.log, ['worktree-plan']);
              ok(/ worktree-plan --repo-root \/\S+ --args-file \/\S+\/start-args\/args\.json --host claude --format text$/.test(r.argv[0].trimEnd()), r.argv[0]);
              const resume = squash(region(text, 'start-resume'));
              ok(resume.includes('When the arguments above are a new request that does not belong to the active workflow'), `${persona}/start: the request decides between resume and worktree`);
              ok(resume.includes('the ordinary resume is the selection: run the first block'), `${persona}/start: the ordinary resume stays`);
            });

            it('start bootstrap, run: only a clean or accepted baseline creates the workflow (investigate, workflow_type start); any other status, or a failed check, stops before any write', async () => {
              const block = blockWith(/state\.mjs" check-clean-baseline /).text;
              const reads = commits ? ['start-args'] : [];
              const cases = [
                ['{"status":"clean"}', 0, 0],
                ['{"status":"accepted"}', 0, 0],
                ['{"status":"dirty","categories":{"modified":["a.md"],"staged":[],"untracked":[]}}', 0, 1],
                ['{}', 0, 1],
                ['{"status":""}', 0, 1],
                ['{"status":"unknown"}', 0, 1],
                ['not json', 0, 1],
                ['', 4, 4],
                // A failed check stops even when it printed a clean status.
                ['{"status":"clean"}', 4, 4],
              ];
              for (const [baseline, baselineStatus, status] of cases) {
                const r = await runBlock('bash', block, persona, { baseline, baselineStatus, argsText: commits ? FEATURE_TEXT : null, after: '\nprintf \'%s\' "$ACTIVE" > out\n' });
                const what = `${JSON.stringify(baseline)} (check exit ${baselineStatus})`;
                strictEqual(r.status, status, `${what}: ${r.stderr}`);
                const check = r.argv[0];
                // The check takes the accept bypass as a flag (PC3b U2).
                ok(check.includes(' check-clean-baseline --repo-root ') && check.trimEnd().endsWith(' --accept-current-tree false'), `${what}: ${check}`);
                if (status === 0) {
                  deepStrictEqual(r.log, [...reads, 'check-clean-baseline', 'create'], what);
                  ok(r.argv[1].includes(' --verb investigate --workflow-type start ') && r.argv[1].includes(` --persona ${persona} `), `${what}: the start workflow, for ${persona}`);
                  // The block sets the repository and branch itself (a fresh shell has neither).
                  ok(/ --repo-root \/\S+( |$)/.test(r.argv[0]) && / --repo-root \/\S+ /.test(r.argv[1]), `${what}: an absolute repository root`);
                  ok(r.argv[1].includes(' --git-baseline-branch pc2a2b '), `${what}: the branch the shell is on`);
                  // ADR-0059, amendment of 2026-10-10: the request reaches create
                  // as a file. With commit_surface the description the args file
                  // held, the embedded --base-branch removed and nothing in it
                  // run, written by the block to a file of its own; without it the
                  // request the agent wrote.
                  ok(/ --original-request-file \/\S+ --current-phase /.test(r.argv[1].replace(r.textDir, '/text')), `${what}: the request file: ${r.argv[1]}`);
                  ok(!/ --original-request /.test(r.argv[1]), `${what}: no inline request: ${r.argv[1]}`);
                  if (commits) deepStrictEqual(r.texts, [['--original-request-file', `Fix it's "A"; $(id) > f\n`]], `${what}: the description`);
                  else {
                    ok(r.argv[1].includes(` --original-request-file ${r.textDir}/request.txt `), `${what}: the request the agent wrote: ${r.argv[1]}`);
                    deepStrictEqual(r.texts, [['--original-request-file', 'the request\n']], `${what}: the request`);
                  }
                  strictEqual(r.out, '/w/created.md', `${what}: $ACTIVE holds the workflow create printed`);
                } else if (baseline.startsWith('{"status":"dirty"')) {
                  // ADR-0067 Decision 8, item 3: the dirty refusal asks the
                  // runtime planner for a worktree first, which writes nothing;
                  // without commit_surface the request is in no shell variable,
                  // and the refusal names the worktree block instead.
                  deepStrictEqual(r.log, [...reads, 'check-clean-baseline', ...(commits ? ['worktree-plan'] : [])], `${what}: nothing written`);
                } else {
                  deepStrictEqual(r.log, [...reads, 'check-clean-baseline'], `${what}: nothing written`);
                }
                if (baseline.startsWith('{"status":"dirty"')) {
                  ok(r.stderr.includes(`/${persona}:start gates a clean baseline`), 'the dirty message names the persona');
                  // The worktree for this request comes first: with
                  // commit_surface the description the args file held and its
                  // base; off, the request placeholder the create takes too.
                  const plan = r.argv.find((a) => a.includes('/scripts/discover-runtime.mjs worktree-plan '));
                  if (commits) {
                    ok(plan && / --repo-root \/\S+ /.test(plan) && plan.trimEnd().endsWith(' --host claude --format text'), `${what}: ${plan}`);
                    ok(plan.includes(` --task Fix it's "A"; $(id) > f --base `), `${what}: the request: ${plan}`);
                  } else {
                    strictEqual(plan, undefined, `${what}: no request reaches a command line`);
                    ok(r.stderr.includes('→ Proposed: a new worktree first, which leaves this checkout\'s changes where they are: run the worktree block (the active-workflow section) with the request in an args file'), `${what}: ${r.stderr}`);
                  }
                  ok(r.stderr.includes('Or resolve it here, then re-run:') && !r.stderr.includes('• worktree:'), `${what}: the worktree is not one option among the resolutions: ${r.stderr}`);
                  // commit_surface: the categories, and the sweep-into-commit
                  // resolution (ADR-0028 §Layer-1).
                  for (const part of ['"modified": [', "• accept: set ACCEPT_CURRENT_TREE=1 to sweep the current tree into the workflow's commit"]) strictEqual(r.stderr.includes(part), commits, `${part}: ${r.stderr}`);
                }
              }
              // ACCEPT_CURRENT_TREE=1 set in the block, unexported, still reaches the check.
              const accepted = await runBlock('bash', `ACCEPT_CURRENT_TREE=1\n${block}`, persona, { baseline: '{"status":"accepted"}', argsText: commits ? FEATURE_TEXT : null });
              strictEqual(accepted.status, 0, accepted.stderr);
              ok(accepted.argv[0].trimEnd().endsWith(' --accept-current-tree true'), accepted.argv[0]);
              if (commits) {
                // An args file outside the grammar stops the block before any write.
                const refused = await runBlock('bash', block, persona, { baseline: '{"status":"clean"}', argsText: '' });
                deepStrictEqual([refused.status, refused.log], [2, ['start-args']], refused.stderr);
              } else {
                // A request the agent did not write stops the block before create;
                // the AGENTIC_TOPIC a dispatcher exports is program data the block
                // writes to a private directory of its own (so a dispatched run
                // needs no agent file, its TEXT_DIR line left as it is) and records
                // instead, a leading -- included.
                const unwritten = await runBlock('bash', block, persona, { baseline: '{"status":"clean"}', texts: { 'request.txt': null } });
                deepStrictEqual([unwritten.status, unwritten.log], [1, ['check-clean-baseline']], unwritten.stderr);
                const topic = await runBlock('bash', `AGENTIC_TOPIC='--from the macro: it'\\''s "x" $(touch pwned)'\n${block.replace(TEXT_DIR_LINE, () => "TEXT_DIR='<never filled>'")}`, persona, { baseline: '{"status":"clean"}', texts: { 'request.txt': null } });
                strictEqual(topic.status, 0, topic.stderr);
                ok(/ --original-request-file \/\S*\/agentic-text\.[A-Za-z0-9]+\/topic\.txt /.test(topic.argv[1]), topic.argv[1]);
                deepStrictEqual([topic.texts, topic.sideEffects], [[['--original-request-file', `--from the macro: it's "x" $(touch pwned)\n`]], []]);
              }
            });

            if (commits) {
              it('start redundancy probe (commit_surface), run: it reads the base branch from its args file, writes nothing, pauses on a finding, and never stops on a failed probe (ADR-0020 §Sub-decision 7)', async () => {
                const block = blockWith(/state\.mjs" diagnose-redundancy /).text;
                // Contract: the test fills this ARGS_DIR line to run the block, and the
                // agent fills it with the directory it wrote — typed text never reaches the shell.
                ok(block.startsWith("ARGS_DIR='<directory from step 1>'\n"), 'the probe reads an args file of its own');
                const cases = [
                  ['{"status":"redundancy","scanned":{"git_present":true},"evidence":{"commits":["abc"]},"recommended_action":"review"}', 0, ['⚠ Redundancy detected on branch', '"commits": [', '- proceed:', '- abort:', '→ PAUSED: put the evidence to the user and wait for proceed or abort.']],
                  ['{"status":"clear","scanned":{"git_present":true}}', 0, []],
                  ['{"status":"clear","scanned":{"git_present":false}}', 0, ['git is not on PATH']],
                  ['{"status":"clear","scanned":{"base_resolution_failed":true}}', 0, ["Base branch 'feat/x' did not resolve"]],
                  ['', 3, []],
                ];
                for (const [diag, diagStatus, says] of cases) {
                  const r = await runBlock('bash', block, persona, { diag, diagStatus, argsText: FEATURE_TEXT });
                  const what = `${JSON.stringify(diag)} (exit ${diagStatus})`;
                  strictEqual(r.status, 0, `${what}: ${r.stderr}`);
                  deepStrictEqual(r.log, ['start-args', 'diagnose-redundancy'], `${what}: nothing written`);
                  ok(r.argv[0].includes(' --base-branch feat/x'), `${what}: the base the args file named: ${r.argv[0]}`);
                  for (const part of says) ok(r.stdout.includes(part), `${what}: ${part}: ${r.stdout}`);
                  strictEqual(r.stdout.includes('PAUSED'), diag.startsWith('{"status":"redundancy"'), `${what}: the pause only on a finding`);
                  if (diagStatus !== 0) ok(r.stderr.includes('diagnose-redundancy failed (exit 3)'), r.stderr);
                }
                const refused = await runBlock('bash', block, persona, { argsText: '' });
                deepStrictEqual([refused.status, refused.log], [2, ['start-args']], 'an args file outside the grammar stops the probe');
                // Contract: the agent running /start — the probe block always exits 0,
                // so only these instructions stop it on abort, keep it from archiving,
                // and send the bootstrap a fresh args file.
                const prose = squash(between(text, blockWith(/state\.mjs" diagnose-redundancy /).text, blockWith(/state\.mjs" check-clean-baseline /).text));
                ok(prose.includes('never archives on redundancy') && prose.includes('Abort stops here, with nothing written.'), prose);
                ok(prose.includes('run the bootstrap block with a new args file'), prose);
              });
            }

            it('start resume, run: a start workflow is written — its next step cleared, its position kept; any other workflow, or a failed read, stops the block unwritten (PC2b RV4, PC3b U2)', async () => {
              const block = blockWith(/state\.mjs" read --workflow-path "\$ACTIVE"/).text;
              const cases = [
                ['{"workflow_type":"start"}', 0, 'start'],
                ['{"workflow_type":"verb-chain"}', 0, 'verb-chain'],
                ['{}', 0, 'verb-chain'],
                ['', 0, 'verb-chain'],
                ['{not json', 0, 'verb-chain'],
                // A failed read stops with its status, whatever it printed.
                ['', 3, null],
                ['{"workflow_type":"start"}', 3, null],
              ];
              // R4 (C75): a fresh shell — the block finds the workflow itself; an
              // ACTIVE an earlier block left is not the one it reads or writes.
              const stale = "ACTIVE='/w/stale.md'\n";
              for (const [readOutput, readStatus, expected] of cases) {
                const r = await runBlock('bash', `${stale}${block}`, persona, { active: '/w/active.md', readOutput, readStatus, after: '\nprintf \'%s\' "$WF_TYPE" > out\n' });
                const what = `${JSON.stringify(readOutput)} (exit ${readStatus})`;
                ok(r.argv[1].includes(' --workflow-path /w/active.md'), 'the workflow the block found');
                if (expected === null) {
                  deepStrictEqual([r.status, r.out, r.log], [3, null, ['find-active', 'read']], `${what}: stopped with the read's status`);
                  continue;
                }
                if (expected !== 'start') {
                  deepStrictEqual([r.status, r.out, r.log], [1, null, ['find-active', 'read']], `${what}: refused, only the read`);
                  ok(r.stderr.includes(`workflow_type=${expected}, not start: /${persona}:start does not take a single-verb workflow into its lifecycle`) && r.stderr.includes(`/${persona}:resume archive`), r.stderr);
                  continue;
                }
                strictEqual(r.out, 'start', what);
                deepStrictEqual(r.log, ['find-active', 'read', 'append'], 'a start workflow: the find, the read, then the clear');
                ok(r.argv[2].includes(' --workflow-path /w/active.md ') && r.argv[2].includes(' --clear-next-step true '), r.argv[2]);
                ok(!/--(current-phase|next-action|verb|phase-label|phase-note) /.test(r.argv[2]), `the position is kept: ${r.argv[2]}`);
              }
              const failed = await runBlock('bash', `${stale}${block}`, persona, { active: '/w/active.md', readOutput: '{"workflow_type":"start"}', failAppend: true, after: '\nprintf ran > out\n' });
              deepStrictEqual([failed.status, failed.out], [7, null], 'a failed clear stops the block with its status');
              for (const [why, find] of [['no workflow found', { active: '' }], ['a failed find', { active: '', findStatus: 3 }]]) {
                const none = await runBlock('bash', `${stale}${block}`, persona, { ...find, readOutput: '{"workflow_type":"start"}', after: '\nprintf ran > out\n' });
                deepStrictEqual([none.status, none.out, none.log], [find.findStatus ?? 1, null, ['find-active']], `${why}: nothing read or written`);
              }
            });

            // The lifecycle's terminal write is finish-verb kind commit (the owner
            // saves and commits); a persona that waits for convergence makes it
            // only once Phase 4 converged, and otherwise records the next step,
            // turning an inherited marker off.
            if (!commits) it('start terminal, run: finish-verb kind commit, only once converged where the persona waits for it (fail-closed); otherwise a non-terminal append with the next step (PC2b U5c)', async () => {
              const block = blockWith(/state\.mjs" finish-verb \\/).text;
              const waits = convergent(persona, 'start');
              // Contract: the test sets this CONVERGED line to run each case, and the
              // agent fills it from Phase 4 — a block without it never closes, or always does.
              strictEqual(CONVERGED_LINE.test(block), waits, 'the block assigns CONVERGED exactly where the persona waits for convergence');
              const cases = waits
                ? [['yes', 'finish-verb'], ['no', 'append'], [UNSET, 'append'], ['<yes|no>', 'append'], [null, 'append']]
                : [[null, 'finish-verb']];
              for (const [value, last] of cases) {
                const script = value === null ? block : converged(block, persona, 'start', value);
                // R4 (C75): a fresh shell — the block finds the workflow itself.
                const r = await runBlock('bash', `ACTIVE='/w/stale.md'\n${script}`, persona, { active: '/w/active.md' });
                const label = `CONVERGED ${value === null ? 'as committed' : value === UNSET ? 'unset' : JSON.stringify(value)}`;
                strictEqual(r.status, 0, `${label}: ${r.stderr}`);
                deepStrictEqual(r.log, ['find-active', last], label);
                ok(r.argv[1].includes(' --workflow-path /w/active.md '), `${label}: the workflow the block found`);
                // ADR-0059, amendment of 2026-10-10: the next action is the file
                // the agent wrote, whichever write it reaches.
                ok(r.argv[1].includes(` --next-action-file ${r.textDir}/next-action.txt `) && !/ --next-action /.test(r.argv[1]), `${label}: the next action's file: ${r.argv[1]}`);
                deepStrictEqual(r.texts, [['--next-action-file', 'the next action\n']], label);
                if (last === 'finish-verb') {
                  ok(r.argv[1].trimEnd().endsWith(' --next-step-kind commit --next-step-confidence <HIGH|MEDIUM|LOW>'), `${label}: kind commit: ${r.argv[1]}`);
                } else {
                  for (const part of [' --next-step-kind verb --next-step-verb <refine|decide|investigate> ', ' --clear-terminal-marker true ', ' --event updated']) ok(r.argv[1].includes(part), `${label}: ${part}: ${r.argv[1]}`);
                  ok(!/ --(current-phase|phase-note|verb) /.test(r.argv[1]), `${label}: the position is kept: ${r.argv[1]}`);
                  ok(/PAUSED/.test(r.stderr), `${label}: the pause is reported`);
                }
              }
              // A next action the agent did not write stops the block before any write.
              const closing = waits ? converged(block, persona, 'start', 'yes') : block;
              const unwritten = await runBlock('bash', closing, persona, { active: '/w/active.md', texts: { 'next-action.txt': null } });
              deepStrictEqual([unwritten.status, unwritten.log], [1, ['find-active']], unwritten.stderr);
              // No workflow found, or a failed find: nothing written.
              for (const [why, find] of [['no workflow found', { active: '' }], ['a failed find', { active: '', findStatus: 3 }]]) {
                const none = await runBlock('bash', `ACTIVE='/w/stale.md'\n${closing}`, persona, find);
                deepStrictEqual([none.status, none.log], [find.findStatus ?? 1, ['find-active']], `${why}: ${none.stderr}`);
              }
              // Contract: the agent writing next-action.txt — its scaffold holds the
              // lifecycle's declared default, which the footer shows.
              strictEqual(text.split(`\n   \`\`\`text\n   ${declaration(persona).verbs.start.next_action}\n   \`\`\`\n`).length - 1, 1, 'the declared next action, in the next-action.txt scaffold');
            });

            // The Phase 7 commit, two blocks — plan (writes nothing), then execute
            // with the subject the user confirmed — and no finish-verb anywhere
            // in the lifecycle's blocks.
            if (commits) it('start commit (commit_surface), run: plan, then execute with the confirmed subject, each on $ACTIVE in the repository; a failure stops its block with its status; no finish-verb (PC3b U2)', async () => {
              const plan = blockWith(/phase7-commit\.mjs" \\\n\s+--mode plan/).text;
              const execute = blockWith(/phase7-commit\.mjs" \\\n\s+--mode execute/).text;
              // Contract: the agent running Phase 7 — execute before plan commits a
              // subject nobody confirmed; a finish-verb or set-terminal in a block
              // closes the lifecycle beside the driver's own terminal write.
              ok(text.indexOf(plan) < text.indexOf(execute), 'plan before execute');
              strictEqual(shellSites(text, /state\.mjs" (finish-verb|set-terminal)\b/).length, 0, 'the driver writes set-terminal; no block does');
              const p = await runBlock('bash', `ACTIVE='/w/active.md'\n${plan}`, persona, { after: '\nprintf ran > out\n' });
              deepStrictEqual([p.status, p.log, p.out], [0, ['phase7 plan'], 'ran'], p.stderr);
              ok(/ --mode plan --workflow-path \/w\/active\.md --repo-root \/\S+ --host claude/.test(p.argv[0]), p.argv[0]);
              const pFailed = await runBlock('bash', `ACTIVE='/w/active.md'\n${plan}`, persona, { phase7Status: 5, after: '\nprintf ran > out\n' });
              deepStrictEqual([pFailed.status, pFailed.out], [5, null], 'a failed plan stops its block');
              // Contract (ADR-0059, amendment of 2026-10-10): the agent passing the
              // subject the user confirmed — it reaches the driver as the file the
              // agent wrote (the test fills the TEXT_DIR line, as the agent does),
              // never as shell text.
              ok(execute.startsWith(`${TEXT_DIR_LINE}\n`), 'the execute block names the text directory first');
              ok(!/APPROVED_SUBJECT|--subject "|--subject '/.test(execute), 'no inline subject in the block');
              const approved = execute;
              const subject = { 'subject.txt': "feat(x): it's \"done\" $(touch pwned)\n" };
              const e = await runBlock('bash', `ACTIVE='/w/active.md'\n${approved}`, persona, { texts: subject, after: '\nprintf ran > out\n' });
              deepStrictEqual([e.status, e.log, e.out], [0, ['phase7 execute'], 'ran'], e.stderr);
              ok(e.argv[0].includes(` --mode execute --workflow-path /w/active.md --repo-root `) && e.argv[0].includes(` --host claude --subject-file ${e.textDir}/subject.txt --confirm-non-interactive`), e.argv[0]);
              deepStrictEqual([e.texts, e.sideEffects], [[['--subject-file', subject['subject.txt']]], []], 'the subject file, read as written');
              const eFailed = await runBlock('bash', `ACTIVE='/w/active.md'\n${approved}`, persona, { phase7Status: 6, after: '\nprintf ran > out\n' });
              deepStrictEqual([eFailed.status, eFailed.out], [6, null], 'a failed execute stops its block, the workflow left open');
              // Plan-verify peer (MAJOR): a fresh shell has no ACTIVE; each
              // block then binds the workflow find-active names on this branch,
              // and stops before the driver when there is none.
              for (const [name, block, mode] of [['plan', plan, 'plan'], ['execute', approved, 'execute']]) {
                const fresh = await runBlock('bash', block, persona, { active: '/w/found.md', after: '\nprintf ran > out\n' });
                deepStrictEqual([fresh.status, fresh.log, fresh.out], [0, ['find-active', `phase7 ${mode}`], 'ran'], `${name}: ${fresh.stderr}`);
                ok(fresh.argv[1].includes(' --workflow-path /w/found.md '), `${name}: the workflow find-active named: ${fresh.argv[1]}`);
                const none = await runBlock('bash', block, persona, { active: '', after: '\nprintf ran > out\n' });
                deepStrictEqual([none.status, none.log, none.out], [1, ['find-active'], null], `${name}: no workflow, no driver: ${none.stderr}`);
                const failed = await runBlock('bash', block, persona, { active: '/w/found.md', findStatus: 5, after: '\nprintf ran > out\n' });
                deepStrictEqual([failed.status, failed.log], [5, ['find-active']], `${name}: a failed find stops the block`);
              }
              // Contract: the agent running Phase 7 — execute's set-terminal is
              // archived at this turn's end, so the decision to keep the workflow
              // open must come before the execute block, not after it.
              const timing = text.indexOf('ARCHIVE TIMING — decide before running execute mode.');
              ok(timing > text.indexOf(plan) && timing < text.indexOf(execute), 'the archive-timing rule between plan and execute');
            });

            // Contract: the agent running the lifecycle's web search and peer
            // dispatches — a gate stated after the phases dispatch, or missing,
            // lets ungenericized text or a screenshot leave the host.
            it('start privacy: the prohibition precedes the phase boundaries (where the phases dispatch), the no-image rule follows that paragraph and precedes the terminal write; designer\'s screenshot sentence precedes the phase boundaries', () => {
              const prohibition = sentenceAt(text, PROHIBITION.start);
              // A persona that declares no peer policy (engineer) has no gate.
              if (!declaration(persona).peer) {
                deepStrictEqual([prohibition.length, sentenceAt(text, NO_IMAGE).length, text.includes('PRIVACY GATE:')], [0, 0, false]);
                return;
              }
              const lifecycle = text.indexOf('<!-- pipeline:begin start-phase-boundary -->');
              ok(lifecycle > 0, 'the phase-boundary region');
              strictEqual(prohibition.length, 1, 'the prohibition sentence');
              ok(prohibition[0] < lifecycle, 'before the phase boundaries');
              const noImage = sentenceAt(text, NO_IMAGE);
              strictEqual(noImage.length, declaration(persona).peer.images === false ? 1 : 0, 'the no-image rule, exactly where images are off');
              const boundaryEnd = text.indexOf('<!-- pipeline:end start-phase-boundary -->');
              const terminalAt = text.indexOf(terminalBlock().text);
              ok(boundaryEnd > 0 && noImage.every((at) => boundaryEnd < at && at < terminalAt), 'the no-image rule after the phase-boundary paragraph, before the terminal write');
              if (persona === 'designer') {
                const screenshot = sentenceAt(text, SCREENSHOT.start);
                strictEqual(screenshot.length, 1, 'the screenshot sentence');
                ok(screenshot[0] < lifecycle, 'the screenshot sentence before the phase boundaries');
              }
            });

            // Contract: the agent running the lifecycle — these are the only places
            // it is told which state and settle calls to make at a phase boundary
            // (test-start-lifecycle.mjs runs them against the real scripts), and
            // that a verb's own finish-verb never runs inside the lifecycle.
            it('start lifecycle: each phase boundary writes state and dispatches its ensemble, settles each attempt by run id, records and clears owner gates, and never runs a verb\'s finish-verb, before the terminal block', () => {
              const boundary = squash(region(text, 'start-phase-boundary'));
              ok(boundary.includes('Each phase boundary writes state via `state.mjs append --verb <verb> --current-phase <phase> --next-action-file <file> --event updated`'), 'the state write at each boundary');
              // Contract (ADR-0059, amendment of 2026-10-10): the agent writing at a
              // boundary — every text a write carries is a file it wrote.
              ok(boundary.includes('Every text a write carries (a phase note, a next action, a summary, an owner\'s decision) reaches `state.mjs` and `peer-runner.mjs` as a file: write it with the file-writing tool'), 'the boundary writes take files');
              ok(boundary.includes('and dispatches the per-phase peer ensemble'), 'the per-phase ensemble');
              for (const rule of [
                '`peer-runner.mjs settle --phase <verb> --run-id <that attempt\'s run id>`',
                'dispatches under a new run id and settles each attempt',
                '(`finish-verb`) never runs inside the lifecycle',
                '`state.mjs awaiting-owner-set --gate <gate> --anchor <anchor>`',
                '`state.mjs awaiting-owner-clear --gate <gate> --resolution-file <the owner\'s decision> --next-step-kind verb --next-step-verb <the next phase\'s verb> --next-step-confidence HIGH --next-action-file <the next phase\'s action>`',
              ]) ok(boundary.includes(rule), rule);
              // Contract: the same agent — the order and stop point: an attempt
              // settled after the next phase starts is lost to it, and a gate
              // cleared without waiting takes the owner's decision.
              ok(boundary.includes('(empty when no run launched) and its `--summary-file`, before the next phase'), 'settle precedes the next phase');
              ok(boundary.includes('leaves the workflow open, and pause. Once the owner decides, clear it with'), 'an owner gate pauses until the owner decides');
              ok(text.indexOf('<!-- pipeline:end start-phase-boundary -->') < text.indexOf(terminalBlock().text), 'the rules precede the terminal block they name');
            });

            it('start: the terminal write follows every extension, and each extension holds the instructions its slot exists for', () => {
              const exts = extensionTexts(text);
              const slots = MANIFEST.extension_points.filter((e) => e.dest === dest && e.personas.includes(persona)).map((e) => e.id);
              // Contract: the sync reads the extension markers against the
              // manifest's slots — one marker per slot this persona owns.
              deepStrictEqual(exts.map((e) => e.id).sort(), [...slots].sort(), 'one marker per slot this persona owns');
              const terminal = terminalBlock();
              // Contract: the agent running the lifecycle — an extension after the
              // terminal write is read once the workflow is already closed.
              for (const ext of exts) ok(ext.line < terminal.start, `extension ${ext.id} precedes the terminal write`);
              checkExtensionTexts(exts);
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

            it('Phase 0 stops on a detached HEAD before it finds the workflow into $ACTIVE, and exits on a failed find', () => {
              const block = blockWith(/^[ \t]+find-active --repo-root "\$REPO_ROOT"\)"$/m);
              const lines = block.text.split('\n');
              // Contract: the agent running Phase 0 — workflows are keyed by branch,
              // so the block stops on a detached HEAD before find-active, and stops
              // with find-active's own status when it fails.
              const guard = lines.indexOf('if [ -z "$GIT_BRANCH" ]; then');
              const findLine = lines.findIndex((l) => /^ACTIVE="\$\(node /.test(l));
              ok(guard >= 0 && guard < findLine && lines.slice(guard, findLine).some((l) => /^\s+exit 1$/.test(l)), 'the detached-HEAD guard exits before find-active');
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" \\\n\s+find-active --repo-root "\$REPO_ROOT"\)"\nFIND_RC=\$\?\nif \[ "\$FIND_RC" -ne 0 \]; then\n[^\n]*\n\s+exit "\$FIND_RC"\nfi$/m);
              strictEqual(find.length, 1, 'find-active, then its status read and exited with');
            });

            it('Phase 0 runs autopilot-preflight on $ACTIVE right after the find guard, before any write, and a refusal stops the block (PC2b DD5)', async () => {
              const block = blockWith(/^[ \t]+find-active --repo-root "\$REPO_ROOT"\)"$/m);
              // Contract: the agent running the verb under autopilot — a preflight
              // that does not stop the block, or runs after a write, lets a step
              // cross an owner gate or write before the refusal.
              ok(/\nfi\n(#[^\n]*\n)*node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" autopilot-preflight --workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" \|\| exit \$\?$/.test(logical(block.text)), logical(block.text));
              const pre = shellSites(text, /state\.mjs" autopilot-preflight/);
              const writes = shellSites(text, /state\.mjs" (create|append|set-terminal|finish-verb|ensemble-commit)\b/);
              strictEqual(pre.length, 1, 'one preflight');
              ok(writes.length > 0 && writes.every((w) => pre[0] < w), 'before every write');
              const refused = await runBlock('bash', block.text, persona, { active: '/w/active.md', preflightStatus: 4, after: '\nprintf ran > out\n' });
              deepStrictEqual([refused.status, refused.out, refused.log], [4, null, ['find-active', 'autopilot-preflight']]);
              const passed = await runBlock('bash', block.text, persona, { active: '/w/active.md', after: '\nprintf ran > out\n' });
              deepStrictEqual([passed.status, passed.out], [0, 'ran'], passed.stderr);
              ok(passed.argv[1].includes(' --workflow-path /w/active.md '), passed.argv[1]);
            });

            it('the resume append clears the next step the previous verb recorded (PC2b DD5)', () => {
              // Contract: the agent running the resume block — without
              // --clear-next-step the previous verb's next step survives into this
              // verb, and without || exit a failed append goes on.
              ok(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--current-phase phase-0-resume --clear-next-step true [^\n]*--event resumed \|\| exit \$\?$/m.test(logical(blockWith(/--event resumed/).text)), logical(blockWith(/--event resumed/).text));
            });

            it('Phase 0, run: $ACTIVE holds what find-active printed, and a failed find stops the block with its status', async () => {
              const block = blockWith(/^[ \t]+find-active --repo-root "\$REPO_ROOT"\)"$/m).text;
              const after = '\nprintf \'%s\' "$ACTIVE" > out\n';
              const found = await runBlock('bash', block, persona, { active: '/w/active.md', after });
              strictEqual(found.status, 0, found.stderr);
              strictEqual(found.out, '/w/active.md');
              const failed = await runBlock('bash', block, persona, { active: '', findStatus: 5, after });
              strictEqual(failed.status, 5, failed.stderr);
              strictEqual(failed.out, null, 'nothing after the guard ran');
            });

            // Contract: the agent running the verb — these authored lines choose
            // between the bootstrap block and the resume block; swapped, a found
            // workflow is bootstrapped over.
            it('the authored conditions route an empty $ACTIVE to the bootstrap and a found one to the resume', () => {
              const lines = text.split('\n');
              const before = (id) => {
                const at = lines.indexOf(`<!-- pipeline:begin ${verb}-${id} -->`);
                ok(at > 1, `region ${verb}-${id}`);
                strictEqual(lines[at - 1], '', `a blank line before ${verb}-${id}`);
                return lines[at - 2];
              };
              ok(/^Empty `\$ACTIVE` → bootstrap\b/.test(before('bootstrap')), before('bootstrap'));
              ok(/^Non-empty `\$ACTIVE` → append-on-resume\b/.test(before('resume')), before('resume'));
            });

            // Contract: the agent running the bootstrap or resume block — a write
            // that is not on $ACTIVE, or does not stop the block when it fails,
            // lets the verb run on with no workflow or the wrong one.
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

            // Contract: the agent running the dispatch and finalize — the note
            // before settle writes before the one judge of the run can refuse
            // (R4 G1), finish-verb before settle closes the workflow with its
            // attempt unsettled, and a write that does not stop the block does
            // either.
            if (VERB_DESTS.includes(dest)) it('the dispatch, settle, the note and finish-verb run in that order on $ACTIVE; each write stops the block when it fails (PC2b DD6/DD7, R4 G1)', () => {
              const run = shellSites(text, /peer-runner\.mjs" run \\/);
              const finalize = blockWith(/peer-runner\.mjs" settle \\/);
              const code = logical(finalize.text);
              const at = (re) => { const m = re.exec(code); ok(m, `${key}: ${re}`); return m.index; };
              const repo = at(/^REPO_ROOT="\$\(git rev-parse --show-toplevel\)" \|\| exit 1$/m);
              const note = at(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--phase-note-file "\$TEXT_DIR\/note\.md" [^\n]*--next-action-file "\$TEXT_DIR\/next-action\.txt" --event updated \|\| exit \$\?$/m);
              const settle = at(new RegExp(`^node "\\$CLAUDE_PLUGIN_ROOT/scripts/peer-runner\\.mjs" settle --repo-root "\\$REPO_ROOT" --workflow-path "\\$ACTIVE" --host "\\$\\{AGENTIC_HOST:-claude\\}" --phase '${verb}' --run-id "\\$RUN_ID" --verdict "\\$VERDICT" --summary-file "\\$TEXT_DIR/summary\\.txt" \\|\\| exit \\$\\?$`, 'm'));
              // Indented inside the convergence check in the convergent variant.
              const terminal = at(/^[ \t]*node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" finish-verb --workflow-path "\$ACTIVE" [^\n]*--next-action-file "\$TEXT_DIR\/next-action\.txt" --next-step-kind verb --next-step-verb '[a-z]+' --next-step-confidence "\$CONFIDENCE" \|\| exit \$\?$/m);
              strictEqual(run.length, 1, 'one dispatch');
              ok(run[0] < shellSites(text, /^for TEXT_FILE in note\.md summary\.txt next-action\.txt; do$/m)[0], 'the dispatch precedes the finalize block');
              ok(repo < settle && settle < note && note < terminal, 'REPO_ROOT, settle, append, finish-verb in that order');
              strictEqual(shellSites(text, /state\.mjs" (set-terminal|ensemble-commit)\b/).length, 0, 'no set-terminal or ensemble-commit runs beside them');
              // Contract: the agent ending on an owner gate runs this commented form
              // in place of the typical finish — its flags record the gate in one write.
              // With dispatch_target on, the form closes the verb's operation too.
              const ownerForm = [
                '# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \\',
                '#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \\',
                ...(declaration(persona).capabilities.dispatch_target === true ? ['#   --operation-dir "$OP_DIR" \\'] : []),
                '#   --next-action-file "$TEXT_DIR/next-action.txt" \\',
                '#   --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \\',
                "#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?",
              ].join('\n');
              ok(`${finalize.text.replace(/\n$/, '')}`.endsWith(`\n${ownerForm}`), 'the commented owner-decision form ends the block');
              // Contract: the --owner-gate and --owner-gate-anchor values that form
              // takes, which state.mjs validates — the gates this verb may end with,
              // each with its anchor, between the last-write paragraph and the block.
              const gates = squash(text.slice(text.indexOf('<!-- pipeline:begin ' + verb + '-finalize'), text.indexOf(finalize.text)));
              ok(/- `scope-routing` \([^)]*anchor `routing-recommendation`\)/.test(gates), gates);
              strictEqual(/- `decide-conflict` \([^)]*anchor `ensemble-synthesis`\)/.test(gates), verb === 'decide', 'decide-conflict exactly in decide');
              strictEqual(/- `peer-conflict` \([^)]*anchor `ensemble-synthesis`\)/.test(gates), verb === 'critique' || verb === 'investigate', 'peer-conflict exactly in critique and investigate');
              strictEqual(/- `recurring-finding` \([^)]*anchor `recurring-finding`\)/.test(gates), verb === 'refine', 'recurring-finding exactly in refine');
            });

            // Contract (ADR-0067 Decision 8): the agent ending decide, critique or
            // investigate on a synthesis verdict of conflict — the block writes the
            // contested items as the consensus task file and records the conflict
            // gate with the run id, branching on the verdict the settle recorded;
            // without it the verb closes over a conflict, or proposes a round for a
            // run that recorded none.
            if (Object.hasOwn(CONFLICT_GATES, verb)) it('the finalize, run: a recorded conflict writes the task file, then the note and the conflict gate with the run id; a disagreeing verdict, or a task file refused, stops before the note, and the retry appends it once (ADR-0067 Decision 8, R4 J2, J4)', async () => {
              const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
              const gate = CONFLICT_GATES[verb];
              // The contested items come from the peers' positions: they reach
              // consensus-task as a file the agent wrote, never as shell source,
              // where a line reading as a delimiter would end a heredoc and run the
              // rest as commands.
              ok(!/<<\s*'?CONTESTED|<the contested items/.test(block), 'the block holds no contested items of its own');
              // R4: the contested items are contested.md in the text directory,
              // and the run id the dispatch's result; nothing from the shell.
              const CONTESTED = 'C1: keep "A" or $(touch pwned) `B`\nCONTESTED_ITEMS\nPHASE_NOTE\n';
              const CONFLICT_LOG = ['find-active', 'read', 'settle', 'ensemble-verdict', 'consensus-task', 'append', 'finish-verb'];
              const run = (verdict, opts, items = CONTESTED) => runBlock('bash', `${STALE}${finalizeAs(block, { verdict })}`, persona, { note: 'n', active: FOUND, ...opts, texts: { ...runResult(), 'contested.md': items } });
              const conflict = await run('conflict', { recorded: 'conflict' });
              strictEqual(conflict.status, 0, conflict.stderr);
              deepStrictEqual(conflict.log, CONFLICT_LOG);
              ok(conflict.argv[conflict.log.indexOf('ensemble-verdict')].includes(' ensemble-verdict --workflow-path /w/active.md --run-id r'), conflict.argv.join('\n'));
              ok(conflict.argv[conflict.log.indexOf('consensus-task')].includes(` consensus-task --workflow-path /w/active.md --host claude --run-id r --text-file ${conflict.textDir}/contested.md`), `the contested items reach consensus-task as the file the agent wrote: ${conflict.argv[3]}`);
              deepStrictEqual(conflict.sideEffects, [], 'nothing in the contested items ran');
              for (const part of [
                ` --next-action Owner decision, after a bounded consensus round: ${PROPOSED_ROUND} `,
                ' --next-step-kind owner-decision --next-step-confidence HIGH ',
                ` --owner-gate ${gate} --owner-gate-anchor ensemble-synthesis --owner-gate-run-id r`,
              ]) ok(conflict.argv[conflict.log.indexOf('finish-verb')].includes(part), `${part}: ${conflict.argv.join('\n')}`);
              ok(conflict.stderr.includes(`→ Proposed, for the owner to run before deciding: ${PROPOSED_ROUND}`), conflict.stderr);
              // Every other recorded verdict, and none, takes the typical last write.
              for (const recorded of ['', 'agreed', 'concerns', 'failed', 'degraded']) {
                const typical = await run(recorded === 'failed' || recorded === 'degraded' || recorded === '' ? 'agreed' : recorded, { recorded });
                deepStrictEqual([typical.status, typical.log], [0, typicalLog(verb)], `recorded ${recorded || 'nothing'}: the typical last write`);
                ok(!typical.argv.some((a) => a.includes('--owner-gate')), 'no gate');
              }
              // The recorded verdict and VERDICT disagree: the settle is the only
              // write, before the note (R4 J2, J4: a retry appends the note once,
              // and never a note stating a verdict the settle refused), and the
              // message names a value the agent can set: the recorded verdict, or,
              // for a conflict with no run named, the run's directory.
              for (const [verdict, recorded, runDir, says, next] of [
                ['concerns', 'conflict', true, 'Run r is recorded with the verdict conflict (an earlier run of this block settled it), but VERDICT is concerns: a recorded conflict ends on its gate. Set VERDICT to conflict, write contested.md, and run this block again with the same DISPATCH_DIR.', 'conflict'],
                ['conflict', 'failed', true, 'VERDICT is conflict, but run r is recorded with failed: a consensus round needs a recorded conflict. Set VERDICT to failed, rewrite the synthesis heading of note.md to that verdict, and run this block again', 'failed'],
                ['conflict', 'degraded', true, 'VERDICT is conflict, but run r is recorded with degraded: a consensus round needs a recorded conflict. Set VERDICT to degraded, rewrite the synthesis heading of note.md to that verdict, and run this block again', 'degraded'],
                ['conflict', '', false, 'VERDICT is conflict, but DISPATCH_DIR names no run, so no conflict is recorded for a consensus round. Set DISPATCH_DIR to the directory the dispatch block ran with, or to the run\'s ledger directory when that is gone', null],
              ]) {
                const how = runDir ? { verdict } : { verdict, launched: false };
                const mismatch = await runBlock('bash', `${STALE}${finalizeAs(block, how)}`, persona, { note: 'n', active: FOUND, recorded, texts: { ...runResult(), 'contested.md': CONTESTED } });
                deepStrictEqual([mismatch.status, mismatch.log], [1, ['find-active', 'read', 'settle', 'ensemble-verdict']], `VERDICT ${verdict}, recorded ${recorded || 'nothing'}: ${mismatch.stderr}`);
                ok(mismatch.stderr.includes(`✗ ${says}`), mismatch.stderr);
                strictEqual(mismatch.note, null, 'no phase note');
                if (next === null) continue;
                const again = await run(next, { recorded });
                deepStrictEqual([again.status, again.log], [0, recorded === 'conflict' ? CONFLICT_LOG : typicalLog(verb)], `the recovery for recorded ${recorded}`);
              }
              // A conflict without its contested items stops before any write
              // (R4: checked with the other texts), not after the settle.
              for (const [how, items] of [['left unwritten', null], ['blank', ' \n\n'], ['a BOM only', '\uFEFF\n']]) {
                const unnamed = await run('conflict', { recorded: 'conflict' }, items);
                deepStrictEqual([unnamed.status, unnamed.log], [1, ['find-active']], `contested.md ${how}: nothing written`);
                ok(unnamed.stderr.includes('✗ contested.md in TEXT_DIR (') && unnamed.stderr.includes('a conflict needs the contested items'), unnamed.stderr);
              }
              // A task file refused: no note and no gate, and the message names
              // the retry, which (its settle recording nothing more) appends the
              // note once (R4 J4).
              const refusedTask = await run('conflict', { recorded: 'conflict', taskStatus: 3 });
              deepStrictEqual([refusedTask.status, refusedTask.log], [1, ['find-active', 'read', 'settle', 'ensemble-verdict', 'consensus-task']], 'a refused task file records no note and no gate');
              strictEqual(refusedTask.note, null, 'no phase note');
              ok(refusedTask.stderr.includes('✗ The consensus task file for run r was not written; the phase note and the gate were not recorded. Run this block again with the same TEXT_DIR and DISPATCH_DIR'), refusedTask.stderr);
            });

            // Contract: compose, frame and refine never propose a consensus round —
            // their finalize holds no conflict branch (ADR-0067 Decision 8).
            if (VERB_DESTS.includes(dest) && !Object.hasOwn(CONFLICT_GATES, verb)) it('the finalize has no conflict branch: no consensus task, no verdict read, no gate run id (ADR-0067 Decision 8)', async () => {
              const block = blockWith(/peer-runner\.mjs" settle \\/).text;
              for (const marker of ['consensus-task', 'ensemble-verdict', '--owner-gate-run-id', 'CONTESTED_FILE', 'runtime:consensus']) {
                ok(!block.includes(marker), `${marker} in ${verb}'s finalize`);
              }
              const region = text.slice(text.indexOf(`<!-- pipeline:begin ${verb}-finalize`), text.indexOf(`<!-- pipeline:end ${verb}-finalize`));
              ok(region.length > 0 && !/consensus round|peer-conflict/.test(region), `${verb}'s finalize region proposes no consensus round`);
              const conflict = await runBlock('bash', `${STALE}${finalizeAs(converged(block, persona, verb), { verdict: 'conflict' })}`, persona, { note: 'n', recorded: 'conflict', active: FOUND, texts: runResult() });
              deepStrictEqual([conflict.status, conflict.log], [0, typicalLog(verb)], 'a conflict verdict takes the typical last write');
            });

            // R4 G1: settle is the block's first write, so its refusal (a run of
            // another phase or workflow, one still live, or an attempt the empty
            // id would hide) leaves the workflow as it was: no note, no phase.
            if (VERB_DESTS.includes(dest)) it('the finalize, run: settle is the first write, so its refusal stops the block before any write, with its status (PC2b DD6, R4 G1)', async () => {
              const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
              const passed = await runBlock('bash', `${STALE}${finalizeAs(block)}`, persona, { note: 'n', active: FOUND, texts: runResult() });
              strictEqual(passed.status, 0, passed.stderr);
              deepStrictEqual(passed.log, typicalLog(verb));
              ok(passed.argv[passed.log.indexOf('settle')].includes(` --run-id r --verdict agreed --summary-file ${passed.textDir}/summary.txt`), passed.argv[passed.log.indexOf('settle')]);
              deepStrictEqual(passed.texts.map(([flag]) => flag), ['--summary-file', '--phase-note-file', '--next-action-file', '--next-action-file'], 'settle, the append and the last write each read their file');
              ok(passed.argv.slice(1).every((a) => `${a} `.includes(' --workflow-path /w/active.md ')), 'every call after the find targets the workflow it found');
              // A run the result names, refused by settle: nothing is written.
              const named = await runBlock('bash', finalizeAs(block), persona, { note: 'n', active: FOUND, texts: runResult(), settleStatus: 1 });
              deepStrictEqual([named.status, named.log], [1, [...preSettle(verb), 'settle']], 'a refused settle of the named run writes nothing');
              ok(named.argv[named.log.indexOf('settle')].includes(' --run-id r --verdict agreed '), named.argv[named.log.indexOf('settle')]);
              // No run launched: an empty DISPATCH_DIR is the empty id, which
              // settle judges (it refuses one that would hide an attempt the
              // ledger holds); the block reads no pending entry for it (R4 H1).
              const refused = await runBlock('bash', finalizeAs(block, { launched: false }), persona, { note: 'n', active: FOUND, settleStatus: 1, readOutput: JSON.stringify({ pending_ensemble: [{ phase: verb, run_id: 'pending' }] }) });
              deepStrictEqual([refused.status, refused.log], [1, [...preSettle(verb), 'settle']], 'a refused settle of the empty id writes nothing');
              ok(refused.argv[refused.log.indexOf('settle')].includes(' --run-id  --verdict agreed '), `no run launched, the empty id: ${refused.argv[refused.log.indexOf('settle')]}`);
            });

            // R4 K3: every value the last write takes is checked before settle,
            // the first write — a confidence left unfilled or not HIGH, MEDIUM or
            // LOW and, where the verb waits for convergence, a resolving step left
            // unfilled when it did not converge stop the block before any write,
            // so no retry appends the phase note a second time over them.
            if (VERB_DESTS.includes(dest)) it('the finalize, run: a confidence, or where the verb waits for convergence a resolving step, that the last write would refuse stops the block before any write (R4 K3)', async () => {
              const block = blockWith(/peer-runner\.mjs" settle \\/).text;
              ok(block.includes('#   --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \\\n'), 'the owner-decision form records the confidence checked at the top');
              strictEqual(block.split('"<HIGH|MEDIUM|LOW>"').length - 1, 0, 'no write carries a confidence of its own');
              for (const confidence of [null, 'high', 'HIGH ', '', 'NONE']) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(converged(block, persona, verb), { confidence })}`, persona, { note: 'n', active: FOUND, texts: runResult() });
                deepStrictEqual([r.status, r.log], [1, ['find-active']], `confidence ${JSON.stringify(confidence)}: nothing written: ${r.stderr}`);
                ok(r.stderr.includes("✗ CONFIDENCE is not HIGH, MEDIUM or LOW, the proposal's confidence the last write records; nothing was written."), r.stderr);
              }
              for (const confidence of ['HIGH', 'MEDIUM', 'LOW']) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(converged(block, persona, verb), { confidence })}`, persona, { note: 'n', active: FOUND, texts: runResult() });
                deepStrictEqual([r.status, r.log], [0, typicalLog(verb)], `confidence ${confidence}: ${r.stderr}`);
                ok(r.argv[r.log.indexOf('finish-verb')].includes(` --next-step-confidence ${confidence}`), r.argv.join('\n'));
              }
              if (!convergent(persona, verb)) {
                ok(!block.includes('RESOLVE_VERB'), 'a verb that does not wait for convergence has no resolving step');
                return;
              }
              for (const value of ['no', UNSET, '<yes|no>']) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(converged(block, persona, verb, value), { resolve: null })}`, persona, { note: 'n', active: FOUND, texts: runResult() });
                deepStrictEqual([r.status, r.log], [1, ['find-active']], `CONVERGED ${String(value)}, the resolving step unfilled: nothing written: ${r.stderr}`);
                ok(r.stderr.includes('✗ CONVERGED is not yes, and RESOLVE_VERB is not refine, decide or investigate'), r.stderr);
              }
              for (const resolve of ['decide', 'investigate']) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(converged(block, persona, verb, 'no'), { resolve })}`, persona, { note: 'n', active: FOUND, texts: runResult() });
                deepStrictEqual([r.status, r.log], [0, ['find-active', 'settle', 'append', 'append']], `not converged, ${resolve}: ${r.stderr}`);
                ok(r.argv[3].includes(` --next-step-kind verb --next-step-verb ${resolve} --next-step-confidence HIGH `), r.argv[3]);
              }
              // Converged, the resolving step is not read.
              const yes = await runBlock('bash', `${STALE}${finalizeAs(converged(block, persona, verb, 'yes'), { resolve: null })}`, persona, { note: 'n', active: FOUND, texts: runResult() });
              deepStrictEqual([yes.status, yes.log], [0, typicalLog(verb)], yes.stderr);
            });

            // R4 K2, L1, L2 (the owner's J2 ruling and its Fix now of
            // 2026-10-19): the conflict itself holds the phase, read from the
            // workflow before settle, every result of the phase, not only the
            // last. A recorded conflict with no owner ruling (this verb's
            // conflict gate pending and naming it, or its retired task file)
            // holds every finish but its own run finalized as a conflict: any
            // other verdict, the empty id, a later run as a conflict (L1), and
            // a later result recorded since (S8) cannot hide it. While this
            // verb's conflict gate is pending, only the gate's own run as a
            // conflict passes (L2: a new run cannot close the verb beside the
            // gate). A run id left without its gate, or another gate, is no
            // gate; a conflict whose id could never name a gate is the owner's;
            // a read that fails or prints no workflow stops the block.
            if (Object.hasOwn(CONFLICT_GATES, verb)) it('the finalize, run: a recorded conflict no gate names holds any other verdict before any write, the empty id included; a pending conflict gate holds all but its own run as a conflict; a retired task file releases it; a failed read stops the block (R4 K2, L1, L2)', async () => {
              const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
              const row = (run_id, verdict, phase = verb) => ({ phase, ensemble_type: 'fixture', run_id, verdict, summary: 's', completed_at: '2026-10-18T00:00:00Z' });
              const wf = (results, extra = {}) => JSON.stringify({ workflow_id: 'w', ensemble_results: results, ...extra });
              const OPEN = [row('r0', 'agreed'), row('r1', 'conflict')];
              const GATED = (runId = 'r1') => wf(OPEN, { awaiting_owner_gate: CONFLICT_GATES[verb], ...(runId === null ? {} : { awaiting_owner_run_id: runId }) });
              const HELD = "✗ Run r1 is recorded in this phase with the verdict conflict, and no owner ruling names it: a recorded conflict ends on its gate, so only that run, finalized with VERDICT conflict, can finish the verb";
              const FIRST = 'Finalize that run first: set DISPATCH_DIR to its directory, or to its ledger directory when that is gone, VERDICT to conflict';
              const GATE = "✗ This verb's conflict gate is pending for run r1: until the owner rules on it, only that run, finalized again with VERDICT conflict, can run this block";
              const CONTESTED = { 'contested.md': 'C1\n' };
              const CONFLICT_LOG = ['find-active', 'read', 'settle', 'ensemble-verdict', 'consensus-task', 'append', 'finish-verb'];
              // A workflow under the text directory, so its state home's
              // consensus/ can hold a task file (the read finds it beside it).
              const LOCAL = 'agentic text.x/state/workflows/w.md';
              const RETIRED = { 'state/consensus/w.r1.resolved.md': 'C1\n' };
              const stopped = async (shells, why, how, opts, says) => {
                for (const shell of shells) {
                  const r = await runBlock(shell, `${STALE}${finalizeAs(block, how)}`, persona, { note: 'n', active: FOUND, readOutput: wf(OPEN), ...opts });
                  deepStrictEqual([r.status, r.log], [1, ['find-active', 'read']], `${shell}, ${why}: nothing written: ${r.stderr}`);
                  for (const said of says) ok(r.stderr.includes(said), `${shell}, ${why}: ${r.stderr}`);
                  ok(r.argv[1].includes(` read --workflow-path ${opts.active ?? FOUND}`), r.argv[1]);
                }
              };
              // No gate pending: the conflict holds every finish but its own run.
              const held = [
                ['no run named', { launched: false }, {}, SHELLS],
                ['no run named, concerns', { launched: false, verdict: 'concerns' }, {}],
                ['the conflict run itself, agreed', {}, { texts: runResult('r1') }],
                ['a later run, agreed', {}, { texts: runResult('r2') }],
                // L1: another run finalized as a conflict is not the held run.
                ['a later run as a conflict', { verdict: 'conflict' }, { recorded: 'failed', texts: { ...runResult('r2'), ...CONTESTED } }, SHELLS],
                // S8: a result recorded since (a run settled by hand) hides nothing.
                ['a later result recorded since', { launched: false }, { readOutput: wf([...OPEN, row('r2', 'agreed')]) }, SHELLS],
                ['a later run settled failed, then that run as a conflict', { verdict: 'conflict' }, { recorded: 'failed', readOutput: wf([...OPEN, row('r2', 'failed')]), texts: { ...runResult('r2'), ...CONTESTED } }],
                ['a task file written but never retired', { launched: false }, { active: LOCAL, texts: { 'state/consensus/w.r1.md': 'C1\n' } }],
                // The run id kept without its gate (an older writer), or a gate
                // of another kind naming it: no conflict gate is set.
                ['a run id left without its gate', { launched: false }, { readOutput: wf(OPEN, { awaiting_owner_run_id: 'r1' }) }],
                ['another gate naming the run', { launched: false }, { readOutput: wf(OPEN, { awaiting_owner_gate: 'recurring-finding', awaiting_owner_run_id: 'r1' }) }],
              ];
              for (const [why, how, opts, shells = ['bash']] of held) await stopped(shells, why, how, opts, [HELD, FIRST]);
              // L1: the message names the run it refused.
              await stopped(['bash'], 'the refused run named', { verdict: 'conflict' }, { texts: { ...runResult('r2'), ...CONTESTED } }, ["not VERDICT conflict for run 'r2'"]);
              // The earliest conflict with no ruling is named; any held run, as
              // a conflict, ends on its own gate.
              const two = wf([row('r1', 'conflict'), row('r2', 'conflict')]);
              await stopped(['bash'], 'two conflicts, no run named', { launched: false }, { readOutput: two }, [HELD]);
              for (const [why, opts] of [
                ['the conflict itself, finalized as one', { texts: { ...runResult('r1'), ...CONTESTED } }],
                ['either of two conflicts', { readOutput: two, texts: { ...runResult('r2'), ...CONTESTED } }],
                ['a new conflict, none held', { readOutput: wf([row('r0', 'agreed')]), texts: { ...runResult('r2'), ...CONTESTED } }],
                // The gate's own run, finalized again as a conflict: settle
                // records nothing more, and the gate is written again.
                ['the gate\'s own run as a conflict', { readOutput: GATED(), texts: { ...runResult('r1'), ...CONTESTED } }],
              ]) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, { verdict: 'conflict' })}`, persona, { note: 'n', active: FOUND, recorded: 'conflict', readOutput: wf(OPEN), ...opts });
                deepStrictEqual([r.status, r.log], [0, CONFLICT_LOG], `${why}: ${r.stderr}`);
              }
              // L2: while this verb's conflict gate is pending, it holds every
              // finish but its own run as a conflict, a new run's included.
              for (const [why, how, opts, shells = ['bash']] of [
                ['a new run, agreed, beside the gate', {}, { texts: runResult('r2') }, SHELLS],
                ['no run named, beside the gate', { launched: false }, {}],
                ['the gate\'s own run, agreed', {}, { texts: runResult('r1') }],
                ['a new run as a conflict, beside the gate', { verdict: 'conflict' }, { texts: { ...runResult('r2'), ...CONTESTED } }],
                ['the gate\'s run retired, the gate still pending', { launched: false }, { active: LOCAL, texts: RETIRED }],
              ]) await stopped(shells, why, how, { readOutput: GATED(), ...opts }, [GATE, 'The owner resolves the gate first; nothing was written.']);
              for (const [why, how, opts] of [
                ['a pending gate naming no run', { verdict: 'conflict' }, { texts: { ...runResult('r1'), ...CONTESTED } }],
                ['a pending gate naming no run, no run named, as a conflict', { launched: false, verdict: 'conflict' }, { texts: CONTESTED }],
              ]) await stopped(['bash'], why, how, { readOutput: GATED(null), ...opts }, ["✗ This verb's conflict gate is pending and names no run: until the owner rules on it, no run of this block can finish the verb."]);
              const released = [
                ['its task file retired', wf(OPEN), { active: LOCAL, texts: RETIRED }],
                ['its task file retired, a later result since', wf([...OPEN, row('r2', 'agreed')]), { active: LOCAL, texts: RETIRED }],
                ["another phase's conflict", wf([row('r0', 'agreed'), row('r1', 'conflict', 'elsewhere')]), {}],
                ["another gate naming the run, its task file retired", wf(OPEN, { awaiting_owner_gate: 'recurring-finding', awaiting_owner_run_id: 'r1' }), { active: LOCAL, texts: RETIRED }],
                ['no results', wf([]), {}],
              ];
              for (const [why, readOutput, opts] of released) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, { launched: false })}`, persona, { note: 'n', active: FOUND, readOutput, ...opts });
                deepStrictEqual([r.status, r.log], [0, typicalLog(verb)], `${why}: ${r.stderr}`);
              }
              // A conflict whose id could never name a gate (a run settled by
              // hand under such an id) is held too, and named the owner's: no
              // run of the block can end it on its gate. Its retired-looking
              // task file names nothing, and a later result hides nothing.
              const LEGACY = ["✗ Run legacy:run is recorded in this phase with the verdict conflict, and no owner ruling names it", 'so no run of this block can end it on its gate: the conflict is the owner\'s to decide, outside this block.'];
              for (const [why, opts, shells = ['bash']] of [
                ['a conflict whose id names no gate', {}, SHELLS],
                ['beside a file named as its retired task', { active: LOCAL, texts: { 'state/consensus/w.legacy:run.resolved.md': 'C1\n' } }],
                ['a later result recorded since', { readOutput: wf([row('r0', 'agreed'), row('legacy:run', 'conflict'), row('r2', 'agreed')]) }],
              ]) await stopped(shells, why, { launched: false }, { readOutput: wf([row('r0', 'agreed'), row('legacy:run', 'conflict')]), ...opts }, LEGACY);
              for (const [why, opts, says] of [
                ['a failed read', { readStatus: 3 }, '✗ Could not read the results recorded on /w/active.md; nothing was written.'],
                ['a read printing no JSON', { readOutput: 'not json' }, '✗ The read of /w/active.md printed no workflow; nothing was written.'],
                ['a read printing null', { readOutput: 'null' }, '✗ The read of /w/active.md printed no workflow; nothing was written.'],
              ]) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, { launched: false })}`, persona, { note: 'n', active: FOUND, ...opts });
                deepStrictEqual([r.status, r.log], [1, ['find-active', 'read']], `${why}: nothing written: ${r.stderr}`);
                ok(r.stderr.includes(says), `${why}: ${r.stderr}`);
              }
            });

            // R4 G2, H1, J1: an empty DISPATCH_DIR is "no run launched", the
            // empty id, whatever the workflow holds pending (settle refuses one
            // that would hide an attempt), so a local-only finalize never settles
            // a run its synthesis did not read. A launched run whose dispatch
            // directory is gone is named by its own ledger directory, the one
            // holding the envelope the synthesis read: its handle binds it to the
            // workflow as a dispatch's does. The block reads no pending entry, and
            // a ledger of another workflow (J1: A's run finalized on branch B,
            // whose workflow is the one found) stops it before any write.
            if (VERB_DESTS.includes(dest)) it('the finalize, run: an empty DISPATCH_DIR is the empty id even beside a pending run; a run ledger directory settles its own run, bound to the workflow by its handle; nothing is chosen from pending entries (R4 G2, H1, J1)', async () => {
              const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
              const id = `${verb}-20261017T000000Z-0a0b0c`;
              const row = (runId = id, phase = verb) => ({ phase, ensemble_type: 'fixture', run_id: runId, started_at: '2026-10-17T00:00:00Z' });
              const runs = (pending) => JSON.stringify({ workflow_id: 'w', pending_ensemble: pending, ensemble_results: [] });
              const rest = typicalLog(verb).slice(1);
              const LEDGER = `"$TEXT_DIR/peer-runs/${id}"`;
              const ledger = (runId = id, { workflow = FOUND, at = id, handle } = {}) => ({
                [`peer-runs/${at}/handle.json`]: handle ?? `${JSON.stringify({ run_id: runId, kind: 'ensemble', phase: verb, workflow_path: workflow })}\n`,
                [`peer-runs/${at}/envelope.json`]: '{}\n',
              });
              for (const shell of SHELLS) {
                const local = await runBlock(shell, `${STALE}${finalizeAs(block, { launched: false })}`, persona, { note: 'n', active: FOUND, readOutput: runs([row()]) });
                deepStrictEqual([local.status, local.log], [0, ['find-active', ...rest]], `${shell}, no run launched: ${local.stderr}`);
                ok(local.argv[local.log.indexOf('settle')].includes(' --run-id  --verdict agreed '), `${shell}: the empty id, never the pending run: ${local.argv[local.log.indexOf('settle')]}`);
                // The ledger's own run, read from its handle; with another run
                // pending, no pending entry is read or taken.
                const r = await runBlock(shell, `${STALE}${finalizeAs(block, { dir: LEDGER })}`, persona, { note: 'n', active: FOUND, readOutput: runs([row('other')]), texts: ledger() });
                deepStrictEqual([r.status, r.log], [0, ['find-active', ...rest]], `${shell}: ${r.stderr}`);
                ok(r.argv[r.log.indexOf('settle')].includes(` --run-id ${id} --verdict agreed `), `${shell}: the ledger's run is settled: ${r.argv[r.log.indexOf('settle')]}`);
                // J1: A's run, named by its ledger on B, while B's own run is
                // pending there: refused, and nothing is written to B's workflow.
                const foreign = await runBlock(shell, `${STALE}${finalizeAs(block, { dir: LEDGER })}`, persona, { note: 'n', active: FOUND, readOutput: runs([row('b-run')]), texts: ledger(id, { workflow: '/w/a.md' }) });
                deepStrictEqual([foreign.status, foreign.log], [1, ['find-active']], `${shell}, a ledger of another workflow: ${foreign.stderr}`);
                ok(foreign.stderr.includes('its handle names another workflow, or none (a peer-now or manual run, dispatched for no workflow); nothing was written'), `${shell}: ${foreign.stderr}`);
              }
              // R4 K1: the block's run-id rule is the runner's, so every run the
              // runner launched can be finalized: an id with a ":", a ".", a
              // leading "-" or past 128 characters settles on the plain and
              // convergent finalizes and on the consensus variant's typical path.
              // The consensus variant alone refuses, before any write, an id
              // opening with "--" (its verdict read takes it as a flag) and, with
              // VERDICT conflict, one that cannot name a task file or a gate
              // (state.mjs isSafeConsensusRunId), never after settle.
              const consensus = Object.hasOwn(CONFLICT_GATES, verb);
              for (const odd of ['legacy:run', '-x', '--x', '.x', 'a.b', `a${'b'.repeat(128)}`]) {
                const at = `"$TEXT_DIR/peer-runs/${odd}"`;
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, { dir: at })}`, persona, { note: 'n', active: FOUND, texts: ledger(odd, { at: odd }) });
                if (consensus && odd.startsWith('--')) {
                  deepStrictEqual([r.status, r.log], [1, ['find-active']], `${odd}: nothing written: ${r.stderr}`);
                  ok(r.stderr.includes("opens with '--', which state.mjs reads as a flag; nothing was written"), `${odd}: ${r.stderr}`);
                  continue;
                }
                deepStrictEqual([r.status, r.log], [0, ['find-active', ...rest]], `${odd}: settled: ${r.stderr}`);
                ok(r.argv[r.log.indexOf('settle')].includes(` --run-id ${odd} --verdict agreed `), `${odd}: ${r.argv.join('\n')}`);
                if (!consensus) continue;
                const c = await runBlock('bash', `${STALE}${finalizeAs(block, { dir: at, verdict: 'conflict' })}`, persona, { note: 'n', active: FOUND, recorded: 'conflict', texts: { ...ledger(odd, { at: odd }), 'contested.md': 'C1\n' } });
                deepStrictEqual([c.status, c.log], [1, ['find-active']], `${odd}, a conflict: nothing written: ${c.stderr}`);
                ok(c.stderr.includes(`VERDICT is conflict, but run id '${odd}' cannot name a consensus task file or a gate`), `${odd}: ${c.stderr}`);
              }
              const longest = `a${'b_-'.repeat(42)}c`;
              strictEqual(longest.length, 128);
              const edge = await runBlock('bash', `${STALE}${finalizeAs(block, { dir: `"$TEXT_DIR/peer-runs/${longest}"` })}`, persona, { note: 'n', active: FOUND, texts: ledger(longest, { at: longest }) });
              deepStrictEqual([edge.status, edge.log], [0, ['find-active', ...rest]], `128 characters: ${edge.stderr}`);
              ok(edge.argv[edge.log.indexOf('settle')].includes(` --run-id ${longest} --verdict agreed `), edge.argv[edge.log.indexOf('settle')]);
              // `gone` stands for nothing: a directory with no result, refused,
              // with the ledger directory named as the way to settle the run.
              const word = await runBlock('bash', `${STALE}${finalizeAs(block, { dir: 'gone' })}`, persona, { note: 'n', active: FOUND, readOutput: runs([row()]) });
              deepStrictEqual([word.status, word.log], [1, ['find-active']], `gone: ${word.stderr}`);
              ok(word.stderr.includes("set it to the run's ledger directory, the one holding the envelope.json the synthesis read"), word.stderr);
              for (const [why, texts, dir, says] of [
                ['a ledger handle that is not JSON', ledger(id, { handle: '{"run_id":' }), LEDGER, "cannot be read as that run's"],
                ['a ledger handle of another run', ledger('other'), LEDGER, "cannot be read as that run's"],
                ['a ledger handle that is a directory', { [`peer-runs/${id}/handle.json/x`]: 'y\n' }, LEDGER, "cannot be read as that run's"],
                ['a ledger handle naming no workflow', ledger(id, { handle: `${JSON.stringify({ run_id: id, kind: 'ensemble', phase: verb })}\n` }), LEDGER, 'its handle names another workflow'],
                ['a ledger directory whose name is no run id', ledger('a..b', { at: 'a..b' }), '"$TEXT_DIR/peer-runs/a..b"', 'and DISPATCH_DIR is no run ledger directory'],
              ]) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, { dir })}`, persona, { note: 'n', active: FOUND, texts });
                deepStrictEqual([r.status, r.log], [1, ['find-active']], `${why}: nothing written: ${r.stderr}`);
                ok(r.stderr.includes(says), `${why}: ${r.stderr}`);
              }
              // A retry: the block keeps the run it settles in TEXT_DIR
              // (finalize-run.json) before settle, on every path (R4 H1, M1):
              // the ledger's run, the dispatch's run, and the empty id.
              const kept = (runId = id, workflow = FOUND, phase = verb) => `${JSON.stringify({ run_id: runId, workflow_path: workflow, phase })}\n`;
              const KEPT = '\nprintf \'KEPT:%s\' "$(cat "$TEXT_DIR/finalize-run.json")"';
              for (const [why, how, opts, runId] of [
                ['the run ledger directory, its run', { dir: LEDGER }, { texts: ledger() }, id],
                ['a dispatch directory, its run', {}, { texts: runResult('r') }, 'r'],
                ['no run launched, the empty id', { launched: false }, {}, ''],
              ]) {
                const first = await runBlock('bash', `${STALE}${finalizeAs(block, how)}`, persona, { note: 'n', active: FOUND, ...opts, after: KEPT });
                strictEqual(first.status, 0, `${why}: ${first.stderr}`);
                ok(first.argv[first.log.indexOf('settle')].includes(` --run-id ${runId} --verdict agreed `), `${why}: ${first.argv.join('\n')}`);
                deepStrictEqual(JSON.parse(first.stdout.slice(first.stdout.indexOf('KEPT:') + 5)), { run_id: runId, workflow_path: FOUND, phase: verb }, `${why}: the run settled is kept`);
              }
              // The same run named again passes on every path, the ledger
              // directory of the run a dispatch directory named first included
              // (that directory gone between the two); a run kept that differs
              // from the one named now, the empty id included, stops the block,
              // before any write (R4 H1: nothing overrides the run a finalize
              // already took; M3: a reused TEXT_DIR is refused).
              const same = [
                ['the run ledger directory, its run kept', { dir: LEDGER }, { texts: { ...ledger(), 'finalize-run.json': kept() } }, id],
                ['a dispatch directory, its run kept', {}, { texts: { ...runResult('r'), 'finalize-run.json': kept('r') } }, 'r'],
                ['no run launched, the empty id kept', { launched: false }, { texts: { 'finalize-run.json': kept('') } }, ''],
              ];
              for (const [why, how, opts, runId] of same) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, how)}`, persona, { note: 'n', active: FOUND, ...opts, after: KEPT });
                strictEqual(r.status, 0, `${why}: ${r.stderr}`);
                ok(r.argv[r.log.indexOf('settle')].includes(` --run-id ${runId} --verdict agreed `), `${why}: ${r.argv.join('\n')}`);
                strictEqual(JSON.parse(r.stdout.slice(r.stdout.indexOf('KEPT:') + 5)).run_id, runId, `${why}: the run settled is the one kept`);
              }
              const differs = [
                ['the run ledger directory, another run kept', { dir: LEDGER }, { texts: { ...ledger(), 'finalize-run.json': kept('older') } }, `keeps run 'older', not '${id}'`],
                ['a dispatch directory naming another run than the one kept', {}, { texts: { ...runResult('r'), 'finalize-run.json': kept(id) } }, `keeps run '${id}', not 'r'`],
                ['no run launched, a run kept', { launched: false }, { texts: { 'finalize-run.json': kept() } }, `keeps run '${id}', not ''`],
                // The empty id binds too: a local-only finalize's TEXT_DIR, reused
                // for a run launched later, would give that run its synthesis.
                ['a dispatch directory, the empty id kept', {}, { texts: { ...runResult('r'), 'finalize-run.json': kept('') } }, "keeps run '', not 'r'"],
                ['the run ledger directory, the empty id kept', { dir: LEDGER }, { texts: { ...ledger(), 'finalize-run.json': kept('') } }, `keeps run '', not '${id}'`],
              ];
              for (const [why, how, opts, says] of differs) {
                const r = await runBlock('bash', `${STALE}${finalizeAs(block, how)}`, persona, { note: 'n', active: FOUND, ...opts });
                deepStrictEqual([r.status, r.log], [1, ['find-active']], `${why}: nothing written: ${r.stderr}`);
                ok(r.stderr.includes(says), `${why}: ${r.stderr}`);
              }
              const foreign = 'is malformed or names another workflow or phase than this one of /w/active.md; nothing was written';
              for (const [why, texts] of [
                ['a kept run of another workflow', { 'finalize-run.json': kept(id, '/w/other.md') }],
                ['a kept run of another phase', { 'finalize-run.json': kept(id, FOUND, 'elsewhere') }],
                ['a record that is not JSON', { 'finalize-run.json': '{"run_id":' }],
                ['a record with a malformed run id', { 'finalize-run.json': kept('\n') }],
                ['a record that is a directory', { 'finalize-run.json/x': 'y\n' }],
              ]) {
                for (const [how, opts] of [[{ dir: LEDGER }, { texts: ledger() }], [{ launched: false }, {}]]) {
                  const r = await runBlock('bash', `${STALE}${finalizeAs(block, how)}`, persona, { note: 'n', active: FOUND, ...opts, texts: { ...(opts.texts ?? {}), ...texts } });
                  deepStrictEqual([r.status, r.log], [1, ['find-active']], `${why}, ${JSON.stringify(how)}: nothing written: ${r.stderr}`);
                  ok(r.stderr.includes(foreign), `${why}: ${r.stderr}`);
                }
              }
              // A record that cannot be written (a link to a directory that does
              // not exist reads as absent, and the write through it fails).
              const unkept = await runBlock('bash', `${STALE}${finalizeAs(block, { dir: LEDGER }).replace('case "$VERDICT" in', () => 'ln -s "$TEXT_DIR/missing/run.json" "$TEXT_DIR/finalize-run.json"\ncase "$VERDICT" in')}`, persona, { note: 'n', active: FOUND, texts: ledger() });
              deepStrictEqual([unkept.status, unkept.log], [1, ['find-active']], `a run that cannot be kept: nothing written: ${unkept.stderr}`);
              ok(unkept.stderr.includes('Could not keep the run in TEXT_DIR ('), unkept.stderr);
            });

            // R4 (C75): each block runs in a shell of its own. The finalize finds
            // the workflow, and reads the run id from the result the runner wrote
            // in the dispatch's directory — never a value an earlier block left —
            // and keeps an empty id (no run launched) apart from a result missing
            // or unreadable, which stops it before any write. (A result left
            // empty, and a handle gone, take the run the dispatch recorded: the
            // case after this one; an empty DISPATCH_DIR is the empty id, and a
            // run's own ledger directory names it when the dispatch's is gone,
            // R4 J1.)
            if (VERB_DESTS.includes(dest)) it('the finalize, run: in a fresh shell it finds the workflow and reads the run id from the dispatch\'s result; a result missing, unreadable or naming no run, a handle of another workflow or unreadable, a verdict or directory left unfilled, or no workflow stops it before any write (R4)', async () => {
              const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
              for (const shell of SHELLS) {
                const r = await runBlock(shell, `${STALE}${finalizeAs(block)}`, persona, { note: 'n', active: FOUND, texts: runResult(`${verb}-20261017T000000Z-0a0b0c`) });
                deepStrictEqual([r.status, r.log], [0, typicalLog(verb)], `${shell}: ${r.stderr}`);
                ok(r.argv[r.log.indexOf('settle')].includes(` settle --repo-root `) && r.argv[r.log.indexOf('settle')].includes(` --workflow-path /w/active.md `) && r.argv[r.log.indexOf('settle')].includes(` --run-id ${verb}-20261017T000000Z-0a0b0c --verdict agreed `), `${shell}: ${r.argv.join('\n')}`);
              }
              const filled = (verdict = true, dir = true) => {
                let s = block;
                if (dir) s = s.replace(DISPATCH_DIR_LINE, () => 'DISPATCH_DIR="$TEXT_DIR/dispatch"');
                if (verdict) s = s.replace(VERDICT_LINE, () => "VERDICT='agreed'");
                return s.replace(CONFIDENCE_LINE, () => "CONFIDENCE='HIGH'").replace(OP_DIR_LINE, () => "OP_DIR=''");
              };
              const result = (content) => ({ ...runResult(), 'dispatch/prompt.xml.run.json': content });
              const cases = [
                ['no result in the dispatch directory', filled(), { texts: result(null) }, 1, 'prompt.xml.run.json in DISPATCH_DIR ('],
                ['a result that is not JSON', filled(), { texts: result('{"run_id":') }, 1, 'prompt.xml.run.json in DISPATCH_DIR ('],
                ['a result naming no run', filled(), { texts: result('{"ok":false,"run_id":""}\n') }, 1, 'prompt.xml.run.json in DISPATCH_DIR ('],
                // A run id the shell would strip to nothing is no empty id.
                ['a run id of a newline only', filled(), { texts: result('{"run_id":"\\n","handle_path":"agentic text.x/run/handle.json"}\n') }, 1, 'names no well-formed run id'],
                ['a run whose handle names another workflow', filled(), { texts: runResult('r', { workflow: '/w/other.md' }) }, 1, 'its handle names another workflow'],
                // F1: a handle that cannot be read is told apart from one naming
                // another workflow; a handle gone is the next case's.
                ['a run whose handle is not JSON', filled(), { texts: { ...runResult('r', { handle: false }), 'run/handle.json': '{"run_id":' } }, 1, 'cannot be read as that run\'s'],
                ['a run whose handle is another run\'s', filled(), { texts: { ...runResult('r', { handle: false }), 'run/handle.json': '{"run_id":"s","workflow_path":"/w/active.md"}\n' } }, 1, 'cannot be read as that run\'s'],
                ['the dispatch directory left unfilled', filled(true, false), { texts: runResult() }, 1, 'prompt.xml.run.json in DISPATCH_DIR (<'],
                ['the verdict left unfilled', filled(false), { texts: runResult() }, 1, '✗ VERDICT is not set to the synthesis verdict'],
                ['no workflow found', filled(), { active: '', texts: runResult() }, 1, `✗ No active ${persona} workflow on this branch`],
                ['a failed find', filled(), { active: '', findStatus: 3, texts: runResult() }, 3, ''],
              ];
              for (const [why, script, opts, status, says] of cases) {
                const r = await runBlock('bash', `${STALE}${script}`, persona, { note: 'n', active: FOUND, ...opts });
                deepStrictEqual([r.status, r.log], [status, ['find-active']], `${why}: nothing written: ${r.stderr}`);
                ok(r.stderr.includes(says), `${why}: ${r.stderr}`);
              }
            });

            // R4 F1: a runner that ended without writing its result (killed, or
            // stopped by an error after the launch) leaves the result empty, and a
            // ledger pruned since leaves the result's handle gone. The run is then
            // the one the dispatch recorded before the launch
            // (prompt.xml.dispatch.json), for the workflow found only; settle, the
            // block's first write, judges it from the ledger (R4 G1: a run still
            // live, of another workflow or phase, or never launched, it refuses
            // before anything is written).
            if (VERB_DESTS.includes(dest)) it('the finalize, run: a result left empty or a handle gone takes the run the dispatch recorded, for the workflow found only, and settle judges it before any write (R4 F1, G1)', async () => {
              const block = finalizeAs(converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb));
              const id = `${verb}-20261017T000000Z-0a0b0c`;
              const record = (runId = id, workflow = FOUND) => `${JSON.stringify({ run_id: runId, workflow_path: workflow })}\n`;
              const empty = (rec = record()) => ({ ...runResult(id), 'dispatch/prompt.xml.run.json': '', 'dispatch/prompt.xml.dispatch.json': rec });
              const gone = (rec = record()) => ({ ...runResult(id, { handle: false }), 'dispatch/prompt.xml.dispatch.json': rec });
              const settled = (r) => ok(r.argv[r.log.indexOf('settle')].includes(` --run-id ${id} --verdict agreed `), r.argv.join('\n'));
              const go = [
                ['a result left empty', { texts: empty() }],
                ['a whitespace-only result', { texts: { ...empty(), 'dispatch/prompt.xml.run.json': ' \n' } }],
                ['a handle gone, the dispatch\'s own run', { texts: gone() }],
              ];
              for (const shell of SHELLS) {
                for (const [why, opts] of go) {
                  const r = await runBlock(shell, `${STALE}${block}`, persona, { note: 'n', active: FOUND, ...opts });
                  deepStrictEqual([r.status, r.log], [0, typicalLog(verb)], `${shell}, ${why}: ${r.stderr}`);
                  settled(r);
                }
              }
              // settle refuses the recorded run (still live, of another phase, or
              // with no ledger and not pending): nothing is written.
              const refused = await runBlock('bash', `${STALE}${block}`, persona, { note: 'n', active: FOUND, texts: empty(), settleStatus: 1 });
              deepStrictEqual([refused.status, refused.log], [1, [...preSettle(verb), 'settle']], `a refused settle writes nothing: ${refused.stderr}`);
              settled(refused);
              const missing = 'prompt.xml.dispatch.json there is missing, malformed or names another run';
              const stops = [
                ['no dispatch record', { texts: empty(null) }, missing],
                ['a dispatch record that is not JSON', { texts: empty('{"run_id":') }, missing],
                ['a dispatch record with a malformed run id', { texts: empty(record('\n')) }, missing],
                ['a handle gone and the record naming another run', { texts: gone(record('another')) }, missing],
                ['a dispatch for another workflow', { texts: empty(record(id, '/w/other.md')) }, 'was dispatched for another workflow than /w/active.md'],
              ];
              for (const [why, opts, says] of stops) {
                const r = await runBlock('bash', `${STALE}${block}`, persona, { note: 'n', active: FOUND, ...opts });
                deepStrictEqual([r.status, r.log], [1, ['find-active']], `${why}: nothing written: ${r.stderr}`);
                ok(r.stderr.includes(says), `${why}: ${r.stderr}`);
              }
              // settle alone judges the run: the block inspects no ledger of its own.
              ok(!/peer-runner\.mjs" (sweep|status)\b/.test(block), 'no sweep or status in the finalize');
            });

            // R4 (C75): the dispatch and the resume append each run in a shell of
            // their own too: each finds the workflow; an ACTIVE an earlier block
            // left is not the one they use, and with none found nothing is
            // dispatched or written.
            if (VERB_DESTS.includes(dest)) it('the dispatch and the resume append, run: each finds the workflow in a fresh shell; none found, nothing is dispatched or written (R4)', async () => {
              const dispatch = blockWith(/peer-runner\.mjs" run \\/).text;
              const resume = blockWith(/--event resumed/).text;
              for (const shell of SHELLS) {
                const sent = await runBlock(shell, `${STALE}${dispatch}`, persona, { active: FOUND, after: '\nprintf "RECORD=%s" "$(cat "$TEXT_DIR/prompt.xml.dispatch.json")"' });
                deepStrictEqual([sent.status, sent.log], [0, ['find-active', 'new-run-id', 'run']], `${shell}: ${sent.stderr}`);
                // R4 (C119, C26): the run id is the one this persona's allocator
                // printed for the block's ensemble type, in every shell (zsh read
                // the arithmetic it replaces with other precedence).
                const type = FIXTURE.expected_ensemble_types[persona][verb];
                ok(sent.argv[1].trimEnd().endsWith(` new-run-id --prefix ${type}`), `${shell}: ${sent.argv[1]}`);
                const allocated = new RegExp(`^ --run-id (${type}-\\d{8}T\\d{6}Z-[0-9a-f]{6}) $`);
                ok(allocated.test(/ --run-id \S+ /.exec(`${sent.argv[2]} `)?.[0] ?? ''), `${shell}: an allocated ${type} run id: ${sent.argv[2]}`);
                // R4 F1: the dispatch records, before the launch, the run it launches
                // and the workflow it found, for a finalize whose runner left no result.
                const rec = JSON.parse(/RECORD=(.*)$/s.exec(sent.stdout)[1]);
                ok(rec.workflow_path === FOUND && `${sent.argv[2]} `.includes(` --run-id ${rec.run_id} `), `${shell}: ${sent.stdout}`);
                ok(sent.argv[2].includes(' --workflow-path /w/active.md ') && / --repo-root \/\S+ /.test(sent.argv[2]), `${shell}: the dispatch on the workflow it found, in the repository: ${sent.argv[2]}`);
                // An allocation that fails, or that prints nothing, stops the block
                // before the dispatch, with the stale RUN_ID unused.
                for (const [why, alloc] of [['a refused prefix', { newRunId: '', newRunIdStatus: 2 }], ['an empty id', { newRunId: '' }]]) {
                  const unallocated = await runBlock(shell, `${STALE}${dispatch}`, persona, { active: FOUND, ...alloc });
                  deepStrictEqual([unallocated.status, unallocated.log], [1, ['find-active', 'new-run-id']], `${shell}, ${why}: ${unallocated.stderr}`);
                  ok(unallocated.stderr.includes('new-run-id allocated no run id'), `${shell}, ${why}: ${unallocated.stderr}`);
                }
                const resumed = await runBlock(shell, `${STALE}${resume}`, persona, { active: FOUND });
                deepStrictEqual([resumed.status, resumed.log], [0, ['find-active', 'append']], `${shell}: ${resumed.stderr}`);
                ok(resumed.argv[1].includes(' --workflow-path /w/active.md '), `${shell}: ${resumed.argv[1]}`);
              }
              for (const [name, block] of [['the dispatch', dispatch], ['the resume append', resume]]) {
                for (const [why, find] of [['no workflow found', { active: '' }], ['a failed find', { active: '', findStatus: 3 }]]) {
                  const none = await runBlock('bash', `${STALE}${block}`, persona, find);
                  deepStrictEqual([none.status, none.log], [find.findStatus ?? 1, ['find-active']], `${name}, ${why}: ${none.stderr}`);
                }
              }
            });

            // Contract: the arguments the agent passes, read from the blocks as the
            // shell reads them — a wrong --persona, --verb, --phase or
            // --ensemble-type writes or dispatches as another persona or verb.
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
              // ADR-0059, amendment of 2026-10-10: the prompt is the file the
              // agent wrote, never a path the block allocates and the agent fills.
              deepStrictEqual(got.mktemp_templates, []);
              strictEqual(one('peer-runner.mjs', 'run').get('--prompt-file'), '$PROMPT_FILE');
              strictEqual(blockWith(/peer-runner\.mjs" run \\/).text.split('PROMPT_FILE="$TEXT_DIR/prompt.xml"').length - 1, 1, 'the prompt file is the agent\'s prompt.xml');
            });

            // Contract (ADR-0059, amendment of 2026-10-10): the agent running the
            // finalize — the note, the summary and the next action reach the
            // scripts as files it wrote with its file tool, never as shell
            // source; a block that read a heredoc or assigned the text would run
            // a line of it. The test fills the TEXT_DIR line to run the block.
            if (VERB_DESTS.includes(dest)) it('the finalize passes the note, the summary and the next action as files the agent wrote, checked before any write', () => {
              const finalize = blockWith(/peer-runner\.mjs" settle \\/);
              const lines = finalize.text.split('\n');
              strictEqual(lines[0], TEXT_DIR_LINE, 'the block names the text directory first');
              const check = lines.indexOf('for TEXT_FILE in note.md summary.txt next-action.txt; do');
              ok(check > 0 && lines[check + 1].startsWith(`  ${FINALIZE_CHECK} || { `) && /exit 1; \}$/.test(lines[check + 1]) && lines[check + 2] === 'done', 'each file is held to every reader\'s rule');
              ok(lines.findIndex((l) => /state\.mjs" append \\$/.test(l)) > check + 2, 'the check precedes the first write');
              // No text of the agent's is shell source in the block.
              // The conflict branch's next action expands what consensus-task printed:
              // program output, not the agent's text.
              ok(!/<<\s*-?\s*'?[A-Z_]+'?|\bNOTE=|\bSUMMARY=|--phase-note "|--summary "|--next-action ['"](?!Owner decision, after a bounded consensus round: \$PROPOSED")/.test(finalize.text), 'no heredoc, assignment or inline text');
              // The steps before the block: a private directory, and the files
              // written with the file tool.
              const region = text.slice(text.indexOf(`<!-- pipeline:begin ${verb}-finalize`), text.indexOf(finalize.text));
              ok(region.includes('mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"'), 'the mktemp step');
              ok(squash(region).includes('With your file-writing tool, not the shell, create in that directory `note.md`, the phase note above filled in; `summary.txt`, a one-line résumé of its breakdown; and `next-action.txt`'), 'the file-writing step');
              ok(!/PHASE_NOTE|heredoc/.test(region), 'no heredoc rule left');
            });

            // Contract: the agent writing the peer prompt (and investigate's web
            // queries) — a gate missing, or stated after the dispatch block, lets
            // ungenericized text or a screenshot leave the host. A persona that
            // declares no peer policy (engineer) has no gate and no no-image rule.
            it('privacy: the prohibition sentence precedes the dispatch; the no-image rule where images are off; designer\'s screenshot sentence too; no --image', () => {
              const run = shellSites(text, /peer-runner\.mjs" run \\/);
              const prohibition = sentenceAt(text, PROHIBITION[verb] ?? PROHIBITION.other);
              const noImage = sentenceAt(text, NO_IMAGE);
              const peer = declaration(persona).peer;
              strictEqual(prohibition.length, peer ? 1 : 0, 'the prohibition sentence, exactly where a peer policy is declared');
              ok(prohibition.every((at) => at < run[0]), 'the prohibition precedes the dispatch block');
              strictEqual(noImage.length, peer?.images === false ? 1 : 0, 'the no-image rule, exactly where images are off');
              ok(noImage.every((at) => at < run[0]), 'the no-image rule precedes the dispatch block');
              if (persona === 'designer') {
                const screenshot = sentenceAt(text, SCREENSHOT[verb] ?? SCREENSHOT.other);
                strictEqual(screenshot.length, 1, 'the screenshot sentence');
                ok(screenshot[0] < run[0], 'the screenshot sentence precedes the dispatch block');
              }
              strictEqual(shellSites(text, /--image\b/).length, 0);
            });

            if (verb === 'decide') {
              it('Phase 0.5: between the resume and the dispatch, the resolver reads the args file the agent wrote, and either failure stops the block', async () => {
                const block = blockWith(/decide-registry\.mjs" resolve /);
                const lines = block.text.split('\n');
                // Contract: the agent running Phase 0.5 — the typed arguments reach
                // the resolver only through the args file named on the first line
                // (the test fills it to run the block), its status read right after,
                // between the resume and the dispatch.
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
                const passed = await runBlock('bash', script, persona, { after });
                strictEqual(passed.status, 0, passed.stderr);
                deepStrictEqual(passed.log, ['resolve']);
                strictEqual(passed.args, '/agentic-args.x/args.json\n', 'the file the agent wrote');
                strictEqual(passed.out, 'reached');
                // The skill body reads the context from the block's output.
                strictEqual(passed.stdout, `${RESOLVER_CONTEXT}\n`, 'the context reaches the block\'s stdout');
                ok(passed.stderr.includes(RESOLVER_DIAGNOSTIC), 'the diagnostics reach the block\'s stderr');
                for (const status of [2, 3]) {
                  const failed = await runBlock('bash', script, persona, { resolveStatus: status, after });
                  strictEqual(failed.status, 1, `resolver exit ${status}: ${failed.stderr}`);
                  strictEqual(failed.out, null, `resolver exit ${status}: nothing after the guard ran`);
                }
              });

              it('Phase 0.5: the args-file pins hold, and an unknown or empty --preset resolves as the declaration says (measured)', () => {
                const label = `${persona}/${dest} (${which})`;
                // Contract: args-file transport — the agent writes the typed text to
                // a file the resolver reads, never splicing it into the command line.
                deepStrictEqual(argsFileRunbookProblems(text, label), []);
                deepStrictEqual(argsFileTypedTextProblems(text, label), []);
                const fallback = declaration(persona).decide.fallback.preset_id;
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

            // A critique's dispatch is generated; the agent sets its type by
            // profile in the block, and settle reads it from the ledger. founder's
            // adversarial profile is red-team, engineer's full-codebase (with or
            // without a sub-focus).
            const ADVERSARIAL = {
              founder: {
                profile: 'red-team',
                prose: "for `--profile=red-team`, set `ENSEMBLE_TYPE='adversarial-scan'`",
              },
              engineer: {
                profile: 'full-codebase',
                prose: "for `--profile=full-codebase`, with or without a sub-focus, set `ENSEMBLE_TYPE='adversarial-scan'`",
              },
            };
            if (verb === 'critique' && Object.hasOwn(ADVERSARIAL, persona)) it(`${persona} critique, instantiated per profile: ${ADVERSARIAL[persona].profile} dispatches adversarial-scan; default, unknown and missing review; settle names the same run (QD5, RV14)`, async () => {
              const adv = ADVERSARIAL[persona];
              const dispatch = blockWith(/peer-runner\.mjs" run \\/).text;
              const finalize = blockWith(/peer-runner\.mjs" settle \\/).text;
              const TYPE_LINE = /^ENSEMBLE_TYPE='review'$/m;
              // Contract: the test edits this TYPE line to run each profile, and the
              // dispatch must pass the type the block assigned.
              ok(TYPE_LINE.test(dispatch), 'the block assigns review, the default profile\'s type');
              ok(/^ {2}--ensemble-type "\$ENSEMBLE_TYPE" --run-id "\$RUN_ID" \\$/m.test(dispatch), 'the dispatch names the type the block assigned, once');
              // Contract: the agent running the dispatch — this instruction, before
              // the block, is the only thing that changes the type for the profile.
              strictEqual(sentenceAt(text, adv.prose).length, 1, 'the prose says when to change it');
              const flat = text.replace(/\s+/g, ' ');
              ok(flat.indexOf(adv.prose) < flat.indexOf('peer-runner.mjs" run'), 'the prose comes before the block it changes');
              for (const [profile, expected] of [['default', 'review'], [adv.profile, 'adversarial-scan'], ['unknown', 'review'], ['missing', 'review']]) {
                const script = profile === adv.profile ? dispatch.replace(TYPE_LINE, "ENSEMBLE_TYPE='adversarial-scan'") : dispatch;
                // R4: the dispatch and the finalize each in a shell of its own;
                // the finalize reads the run from the result the runner wrote.
                const r = await runBlock('bash', `${STALE}${inTurn(script, finalizeAs(finalize, { verdict: 'sound', dir: '"$SHARED"' }))}`, persona, { note: 'n', active: FOUND });
                strictEqual(r.status, 0, r.stderr);
                const sent = r.argv.filter((a) => / run /.test(a));
                ok(sent.length === 1 && sent[0].includes(` --ensemble-type ${expected} `) && sent[0].includes(' --workflow-path /w/active.md '), `${profile}: the dispatch names ${expected}: ${sent}`);
                const id = / --run-id (\S+)/.exec(sent[0])?.[1] ?? '';
                ok(id.startsWith(`${expected}-`), `${profile}: the run id carries ${expected}: ${id}`);
                ok(r.argv.find((a) => / settle /.test(a)).includes(` --phase critique --run-id ${id} `), `${profile}: settle names the run the dispatch started`);
              }
            });

            // engineer's investigate, as its critique: the block assigns the
            // analysis profile's type, and the prose sets the root-cause or
            // cited-brief type there by profile; settle reads the type from the
            // ledger.
            const PROFILED_INVESTIGATE = {
              engineer: {
                base: 'investigate',
                profiles: {
                  'root-cause': "for `--profile=root-cause`, set `ENSEMBLE_TYPE='root-cause'`",
                  'cited-brief': "for `--profile=cited-brief`, set `ENSEMBLE_TYPE='cited-brief'`",
                },
              },
            };
            if (verb === 'investigate' && Object.hasOwn(PROFILED_INVESTIGATE, persona)) it(`${persona} investigate, instantiated per profile: root-cause and cited-brief dispatch their own type; analysis, unknown and missing investigate; settle names the same run (PC3 U7)`, async () => {
              const spec = PROFILED_INVESTIGATE[persona];
              const dispatch = blockWith(/peer-runner\.mjs" run \\/).text;
              const finalize = blockWith(/peer-runner\.mjs" settle \\/).text;
              const TYPE_LINE = new RegExp(`^ENSEMBLE_TYPE='${spec.base}'$`, 'm');
              // Contract: the test edits this TYPE line to run each profile, and the
              // dispatch must pass the type the block assigned.
              ok(TYPE_LINE.test(dispatch), 'the block assigns the default profile\'s type');
              ok(/^ {2}--ensemble-type "\$ENSEMBLE_TYPE" --run-id "\$RUN_ID" \\$/m.test(dispatch), 'the dispatch names the type the block assigned, once');
              // Contract: the agent running the dispatch — these instructions, before
              // the block, are the only thing that changes the type for each profile.
              const flat = text.replace(/\s+/g, ' ');
              for (const prose of Object.values(spec.profiles)) {
                strictEqual(sentenceAt(text, prose).length, 1, `the prose says when to change it: ${prose}`);
                ok(flat.indexOf(prose) < flat.indexOf('peer-runner.mjs" run'), 'the prose comes before the block it changes');
              }
              const cases = [['analysis', spec.base], ...Object.keys(spec.profiles).map((p) => [p, p]), ['unknown', spec.base], ['missing', spec.base]];
              for (const [profile, expected] of cases) {
                const script = Object.hasOwn(spec.profiles, profile) ? dispatch.replace(TYPE_LINE, `ENSEMBLE_TYPE='${expected}'`) : dispatch;
                // R4: the dispatch and the finalize each in a shell of its own;
                // the finalize reads the run from the result the runner wrote.
                const r = await runBlock('bash', `${STALE}${inTurn(script, finalizeAs(finalize, { verdict: 'agreed', dir: '"$SHARED"' }))}`, persona, { note: 'n', active: FOUND });
                strictEqual(r.status, 0, r.stderr);
                const sent = r.argv.filter((a) => / run /.test(a));
                ok(sent.length === 1 && sent[0].includes(` --ensemble-type ${expected} `) && sent[0].includes(' --workflow-path /w/active.md '), `${profile}: the dispatch names ${expected}: ${sent}`);
                const id = / --run-id (\S+)/.exec(sent[0])?.[1] ?? '';
                ok(id.startsWith(`${expected}-`), `${profile}: the run id carries ${expected}: ${id}`);
                ok(r.argv.find((a) => / settle /.test(a)).includes(` --phase investigate --run-id ${id} `), `${profile}: settle names the run the dispatch started`);
              }
            });

            // A stop inside the lifecycle is an exit, not just a message: a write placed after the block is never
            // reached there, and is reached where the block falls through.
            const AFTER = '\nnode "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append --workflow-path "$ACTIVE" --host claude';
            if (verb === 'decide') it('Owner selection, run: it finds the workflow, clears decide-conflict with the resolution and the next step, then finishes the verb; a failed find or clear, or no workflow, stops the block (PC2b DD7)', async () => {
              const asCommitted = blockWith(/state\.mjs" awaiting-owner-clear \\/).text;
              // Contract: the agent resolving the gate — the clear comes after the
              // finalize whose owner-decision form records it.
              ok(text.indexOf(asCommitted) > text.indexOf('<!-- pipeline:end decide-finalize -->'), 'after Phase 2, whose owner-decision form records the gate');
              const dispatchTarget = declaration(persona).capabilities.dispatch_target === true;
              strictEqual(GATE_OP_DIR_RE.test(asCommitted), dispatchTarget, 'the block takes the operation directory exactly where the persona has operations');
              const block = gateOpDir(asCommitted);
              const CHAIN = { active: '/w/active.md', readOutput: '{"workflow_type":"verb-chain"}' };
              const r = await runBlock('bash', block, persona, CHAIN);
              strictEqual(r.status, 0, r.stderr);
              deepStrictEqual(r.log, ['find-active', 'read', 'awaiting-owner-clear', 'finish-verb']);
              // ADR-0068 Decision 2, item 7: with no directory from Phase 0 the
              // clear opens the resolution's operation in one the block makes, and
              // the finish-verb closes it there; given Phase 0's, the clear
              // continues it. Run as committed, the block stops before any write.
              if (dispatchTarget) {
                const made = / --operation-dir (\S+) --open-operation gate /.exec(r.argv[2])?.[1];
                ok(made && r.argv[3].includes(` --operation-dir ${made} `), `one operation across the clear and the finish: ${r.argv[2]} / ${r.argv[3]}`);
                const carried = await runBlock('bash', gateOpDir(asCommitted, '/op/phase0'), persona, CHAIN);
                deepStrictEqual(carried.log, ['find-active', 'read', 'awaiting-owner-clear', 'finish-verb']);
                ok(carried.argv[2].includes(' --operation-dir /op/phase0 ') && !carried.argv[2].includes('--open-operation'), carried.argv[2]);
                ok(carried.argv[3].includes(' --operation-dir /op/phase0 '), carried.argv[3]);
                const unfilled = await runBlock('bash', asCommitted, persona, CHAIN);
                deepStrictEqual([unfilled.status, unfilled.log], [1, ['find-active', 'read']], 'an unfilled OP_DIR stops the block before any write');
              }
              for (const part of [' --workflow-path /w/active.md ', ' --gate decide-conflict ', ` --resolution-file ${r.textDir}/resolution.txt `, ' --next-step-kind verb --next-step-verb compose --next-step-confidence HIGH']) ok(r.argv[2].includes(part), `${part}: ${r.argv[2]}`);
              deepStrictEqual(r.texts, [['--resolution-file', 'the resolution\n']], 'the resolution the agent wrote');
              ok(r.argv[3].includes(' --workflow-path /w/active.md ') && r.argv[3].includes(' --next-step-kind verb --next-step-verb compose --next-step-confidence HIGH'), r.argv[3]);
              // PC3b U1 (PC3 step-7 peer finding 2): the clear replaces the
              // gate's next action with the one the verb then finishes with.
              const declaredNext = declaration(persona).verbs.decide.next_action;
              ok(r.argv[2].includes(` --next-action ${declaredNext} `), r.argv[2]);
              ok(r.argv[3].includes(` --next-action ${declaredNext} `), r.argv[3]);
              // Review of code step 6, then ADR-0059's amendment of 2026-10-10: a
              // resolution with quotes, an expansion, a backtick and a line that
              // read as the old heredoc's delimiter reaches state.mjs whole.
              const hostile = "keep the team's \"existing\" `nav` $HOME $(touch pwned)\nOWNER_RESOLUTION\ntouch injected\n";
              const quoted = await runBlock('bash', block, persona, { ...CHAIN, texts: { 'resolution.txt': hostile } });
              strictEqual(quoted.status, 0, quoted.stderr);
              deepStrictEqual([quoted.texts, quoted.sideEffects], [[['--resolution-file', hostile]], []]);
              const unwritten = await runBlock('bash', block, persona, { ...CHAIN, texts: { 'resolution.txt': null } });
              deepStrictEqual([unwritten.status, unwritten.log], [1, ['find-active', 'read']], 'a resolution left unwritten stops the block before any write');
              // A gate met inside a start lifecycle: cleared, and the lifecycle resumes; no verb terminal write.
              const lifecycle = await runBlock('bash', block, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([lifecycle.status, lifecycle.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'inside start: no finish-verb');
              ok(lifecycle.stderr.includes(`Resume the lifecycle with /${persona}:start`), lifecycle.stderr);
              // PC3b U1 (PC3 step-7 peer findings 2 and 3): inside the lifecycle
              // the clear names the resume as the next action and records no
              // next step, since the lifecycle owns its phase order (compose
              // follows decide in one persona's lifecycle, explore in another's).
              ok(lifecycle.argv[2].includes(` --next-action Resume /${persona}:start: the lifecycle continues after decide with the selected direction --clear-next-step true`), lifecycle.argv[2]);
              ok(!/ --next-step-(kind|verb|confidence) /.test(lifecycle.argv[2]), `no next step inside the lifecycle: ${lifecycle.argv[2]}`);
              ok(!lifecycle.argv[2].includes('--operation-dir'), `inside start, with none from Phase 0, the clear is its own one-write operation: ${lifecycle.argv[2]}`);
              if (dispatchTarget) {
                // Given Phase 0's directory inside start, where no finish-verb
                // follows, the clear closes that operation.
                const carriedStart = await runBlock('bash', gateOpDir(asCommitted, '/op/phase0'), persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
                deepStrictEqual(carriedStart.log, ['find-active', 'read', 'awaiting-owner-clear']);
                ok(carriedStart.argv[2].includes(' --operation-dir /op/phase0 --close-operation true '), carriedStart.argv[2]);
              }
              const stopped = await runBlock('bash', block + AFTER, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([stopped.status, stopped.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'inside start the block exits: nothing after it runs');
              const unread = await runBlock('bash', block, persona, { active: '/w/active.md', readOutput: '', readStatus: 5 });
              deepStrictEqual([unread.status, unread.log], [1, ['find-active', 'read']], 'an unreadable type stops the block before any write');
              // A read that fails after printing a parsable type also stops it.
              const failedRead = await runBlock('bash', block, persona, { active: '/w/active.md', readOutput: '{"workflow_type":"verb-chain"}', readStatus: 5 });
              deepStrictEqual([failedRead.status, failedRead.log], [1, ['find-active', 'read']], 'a failed read stops the block, whatever it printed');
              const failed = await runBlock('bash', block, persona, { ...CHAIN, clearStatus: 3 });
              deepStrictEqual([failed.status, failed.log], [3, ['find-active', 'read', 'awaiting-owner-clear']], 'a refused clear stops the block');
              const none = await runBlock('bash', block, persona, { active: '' });
              deepStrictEqual([none.status, none.log], [1, ['find-active']], 'no workflow: nothing written');
              ok(none.stderr.includes(`✗ No active ${persona} workflow on this branch.`), none.stderr);
              const lost = await runBlock('bash', block, persona, { active: '/w/active.md', findStatus: 4 });
              deepStrictEqual([lost.status, lost.log], [4, ['find-active']], 'a failed find stops the block with its status');
            });

            if (HEADING_DESTS.includes(dest)) {
              // Contract: the agent running the verb — the terminal block comes after
              // the finalize heading and every extension (read once the workflow is
              // closed otherwise), and after the dispatch; the sync reads one marker
              // per slot this persona owns.
              it('the finalize follows the finalize heading region, every extension and the dispatch', () => {
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
              });

              it('each extension holds the instructions its slot exists for', () => {
                checkExtensionTexts(extensionTexts(text));
              });
            }

            // Run: a persona that declares refine convergent
            // closes it only once converged (fail-closed); otherwise the last
            // write records the next step, turns an inherited terminal marker
            // off and closes nothing. The other persona always closes.
            if (verb === 'refine') it('refine finalize, run: closes only once converged where the persona waits for it (fail-closed), otherwise records the next step without a terminal write and turns an inherited marker off (PC2b U5b, DD5)', async () => {
              const block = blockWith(/peer-runner\.mjs" settle \\/).text;
              const waits = convergent(persona, verb);
              // Contract: the test sets this CONVERGED line to run each case, and the
              // agent fills it from the re-critique — run untouched, the block pauses.
              strictEqual(CONVERGED_LINE.test(block), waits, 'the block assigns CONVERGED exactly where the persona waits for convergence');
              const cases = waits
                ? [['yes', 'finish-verb'], ['no', 'append'], [UNSET, 'append'], ['<yes|no>', 'append'], [null, 'append']]
                : [[null, 'finish-verb']];
              for (const [value, last] of cases) {
                const script = value === null ? block : converged(block, persona, verb, value);
                const r = await runBlock('bash', `${STALE}${finalizeAs(script, { verdict: 'resolved' })}`, persona, { note: 'n', active: FOUND, texts: runResult() });
                const label = `CONVERGED ${value === null ? 'as committed' : value === UNSET ? 'unset' : JSON.stringify(value)}`;
                strictEqual(r.status, 0, `${label}: ${r.stderr}`);
                deepStrictEqual(r.log, ['find-active', 'settle', 'append', last], label);
                ok(r.argv.slice(1).every((a) => a.includes(' --workflow-path /w/active.md ')), `${label}: every write targets the workflow the block found`);
                if (last === 'finish-verb') {
                  ok(r.argv[3].includes(' --next-step-kind verb --next-step-verb critique '), `${label}: ${r.argv[3]}`);
                } else {
                  for (const part of [' --current-phase phase-2-presented ', ` --next-action-file ${r.textDir}/next-action.txt `, ' --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH ', ' --clear-terminal-marker true ', ' --event updated']) ok(r.argv[3].includes(part), `${label}: ${part}: ${r.argv[3]}`);
                  ok(!r.argv[3].includes(' --phase-note'), `${label}: the paused write adds no second note`);
                  ok(/PAUSED/.test(r.stderr), `${label}: the pause is reported`);
                }
              }
              // A refused settle stops the block before either last write.
              const refused = await runBlock('bash', finalizeAs(converged(block, persona, verb, 'no'), { verdict: 'resolved' }), persona, { note: 'n', active: FOUND, texts: runResult(), settleStatus: 1 });
              deepStrictEqual([refused.status, refused.log], [1, ['find-active', 'settle']], 'no write after a refused settle (R4 G1: nothing at all)');
            });

            if (verb === 'refine') it('Owner decision, run: fix now clears recurring-finding with this refine next; defer clears it with commit next, then finishes the verb, where the persona waits for convergence only once converged (fail-closed); a failed find or clear, or no workflow, stops each block (PC2b U5b)', async () => {
              const committedBlocks = blocks.filter((b) => /state\.mjs" awaiting-owner-clear \\/.test(b.text)).map((b) => b.text);
              strictEqual(committedBlocks.length, 2, 'fix now and defer');
              const dispatchTarget = declaration(persona).capabilities.dispatch_target === true;
              for (const b of committedBlocks) strictEqual(GATE_OP_DIR_RE.test(b), dispatchTarget, 'each block takes the operation directory exactly where the persona has operations');
              const [fix, deferAsCommitted] = committedBlocks.map((b) => gateOpDir(b));
              const waits = convergent(persona, verb);
              // Contract: the test sets the defer block's CONVERGED line to run each
              // case; the agent fills it — without it a deferral always closes.
              strictEqual(CONVERGED_LINE.test(deferAsCommitted), waits, 'the defer block assigns CONVERGED exactly where the persona waits for convergence');
              // The shared cases run the deferral converged; the persona that
              // waits for convergence is run unconverged below.
              const defer = converged(deferAsCommitted, persona, verb);
              const finalizeEnd = `<!-- pipeline:end ${waits ? 'refine-finalize-convergent' : 'refine-finalize'} -->`;
              // Contract: the agent resolving the gate — the clear comes after the
              // finalize whose owner-decision form records it.
              ok(text.indexOf(committedBlocks[0]) > text.indexOf(finalizeEnd) && text.indexOf(finalizeEnd) > 0, 'after Phase 2, whose owner-decision form records the gate');
              const CHAIN = { active: '/w/active.md', readOutput: '{"workflow_type":"verb-chain"}' };
              const f = await runBlock('bash', fix, persona, CHAIN);
              strictEqual(f.status, 0, f.stderr);
              deepStrictEqual(f.log, ['find-active', 'read', 'awaiting-owner-clear']);
              for (const part of [' --workflow-path /w/active.md ', ' --gate recurring-finding ', ` --resolution-file ${f.textDir}/resolution.txt `, ' --next-action Fix the recurring finding in this refine, then re-critique ', ' --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH']) ok(f.argv[2].includes(part), `${part}: ${f.argv[2]}`);
              deepStrictEqual(f.texts, [['--resolution-file', 'the resolution\n']], 'the resolution the agent wrote');
              // ADR-0068 Decision 2, item 7: Fix now opens a verb operation the
              // refine's phases then carry, and prints its directory for their
              // finalize; given Phase 0's it continues that one.
              if (dispatchTarget) {
                const made = / --operation-dir (\S+) --open-operation verb /.exec(f.argv[2])?.[1];
                ok(made && f.stdout.includes(`OP_DIR=${made}`), `fix now opens and prints its operation: ${f.argv[2]} / ${f.stdout}`);
                const carried = await runBlock('bash', gateOpDir(committedBlocks[0], '/op/phase0'), persona, CHAIN);
                ok(carried.argv[2].includes(' --operation-dir /op/phase0 ') && !carried.argv[2].includes('--open-operation'), carried.argv[2]);
                const unfilled = await runBlock('bash', committedBlocks[0], persona, CHAIN);
                deepStrictEqual([unfilled.status, unfilled.log], [1, ['find-active', 'read']], 'fix now: an unfilled OP_DIR stops the block before any write');
              }
              // PC3b U1 (PC3 step-7 peer finding 1): inside a start lifecycle
              // Fix now clears the gate and stops, so this refine's own phases
              // (whose finalize is a terminal write) do not run before the
              // lifecycle's terminal step; the lifecycle's refine phase fixes it.
              const fixLifecycle = await runBlock('bash', fix, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([fixLifecycle.status, fixLifecycle.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'inside start: fix now clears and stops');
              ok(fixLifecycle.argv[2].includes(` --next-action Resume /${persona}:start: its refine phase fixes the recurring finding --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH`), fixLifecycle.argv[2]);
              ok(fixLifecycle.stderr.includes(`Resume the lifecycle with /${persona}:start`), fixLifecycle.stderr);
              const fixUnread = await runBlock('bash', fix, persona, { active: '/w/active.md', readOutput: '', readStatus: 5 });
              deepStrictEqual([fixUnread.status, fixUnread.log], [1, ['find-active', 'read']], 'fix now: an unreadable type stops the block before any write');
              // The stop is an exit: a write after the block runs on the
              // verb-chain path only.
              const fixStopped = await runBlock('bash', fix + AFTER, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([fixStopped.status, fixStopped.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'fix now inside start exits: nothing after it runs');
              const fixThrough = await runBlock('bash', fix + AFTER, persona, CHAIN);
              deepStrictEqual([fixThrough.status, fixThrough.log], [0, ['find-active', 'read', 'awaiting-owner-clear', 'append']], 'outside start the block falls through (the sentinel is reachable)');
              for (const [name, b] of [['fix now', fix], ['defer', defer]]) {
                const failedRead = await runBlock('bash', b, persona, { active: '/w/active.md', readOutput: '{"workflow_type":"verb-chain"}', readStatus: 5 });
                deepStrictEqual([failedRead.status, failedRead.log], [1, ['find-active', 'read']], `${name}: a failed read stops the block, whatever it printed`);
              }
              const d = await runBlock('bash', defer, persona, CHAIN);
              strictEqual(d.status, 0, d.stderr);
              deepStrictEqual(d.log, ['find-active', 'read', 'awaiting-owner-clear', 'finish-verb']);
              if (dispatchTarget) {
                const made = / --operation-dir (\S+) --open-operation gate /.exec(d.argv[2])?.[1];
                ok(made && d.argv[3].includes(` --operation-dir ${made} `), `defer: one operation across the clear and the finish: ${d.argv[2]} / ${d.argv[3]}`);
              }
              for (const part of [' --workflow-path /w/active.md ', ' --gate recurring-finding ', ' --next-step-kind commit --next-step-confidence HIGH']) ok(d.argv[2].includes(part), `${part}: ${d.argv[2]}`);
              // The clear's next action is the one the deferral finishes with.
              const deferNext = / --next-action (.+?) --next-step-kind commit /.exec(d.argv[3])?.[1];
              ok(deferNext && d.argv[2].includes(` --next-action ${deferNext} --next-step-kind commit `), `the clear and the finish name one next action: ${d.argv[2]}`);
              ok(d.argv[3].includes(' --workflow-path /w/active.md ') && d.argv[3].includes(' --next-step-kind commit --next-step-confidence HIGH'), d.argv[3]);
              // Review of code step 6: inside a start lifecycle the deferral is cleared and the lifecycle resumes.
              const lifecycle = await runBlock('bash', defer, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([lifecycle.status, lifecycle.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'inside start: no finish-verb');
              ok(lifecycle.argv[2].includes(` --next-action Resume /${persona}:start: the finding is deferred, and the lifecycle continues at its terminal step --next-step-kind commit `), lifecycle.argv[2]);
              const deferStopped = await runBlock('bash', defer + AFTER, persona, { ...CHAIN, readOutput: '{"workflow_type":"start"}' });
              deepStrictEqual([deferStopped.status, deferStopped.log], [0, ['find-active', 'read', 'awaiting-owner-clear']], 'defer inside start exits: nothing after it runs');
              const unread = await runBlock('bash', defer, persona, { active: '/w/active.md', readOutput: '', readStatus: 5 });
              deepStrictEqual([unread.status, unread.log], [1, ['find-active', 'read']], 'an unreadable type stops the block before any write');
              // Review of code step 6 (finding 3): deferring a finding does not
              // make a refine converge. Where the persona waits for convergence,
              // anything but CONVERGED=yes clears the gate with the next step
              // that resolves what is open, and makes no terminal write, inside
              // a start lifecycle too.
              if (waits) {
                for (const value of ['no', UNSET, '<yes|no>', null]) {
                  const label = `CONVERGED ${value === null ? 'as committed' : value === UNSET ? 'unset' : JSON.stringify(value)}`;
                  const script = value === null ? deferAsCommitted : converged(deferAsCommitted, persona, verb, value);
                  for (const type of ['verb-chain', 'start']) {
                    const paused = await runBlock('bash', script, persona, { ...CHAIN, readOutput: `{"workflow_type":"${type}"}` });
                    strictEqual(paused.status, 0, `${label}, ${type}: ${paused.stderr}`);
                    deepStrictEqual(paused.log, ['find-active', 'read', 'awaiting-owner-clear'], `${label}, ${type}: no terminal write`);
                    for (const part of [' --gate recurring-finding ', ` --next-action-file ${paused.textDir}/next-action.txt `, ' --next-step-kind verb --next-step-verb <refine|decide|investigate> --next-step-confidence <HIGH|MEDIUM|LOW>']) ok(paused.argv[2].includes(part), `${label}, ${type}: ${part}: ${paused.argv[2]}`);
                    deepStrictEqual(paused.texts, [['--resolution-file', 'the resolution\n'], ['--next-action-file', 'the next action\n']], `${label}, ${type}: both files`);
                    ok(/PAUSED \(not converged\)/.test(paused.stderr), `${label}, ${type}: the pause is reported`);
                  }
                }
                const unwrittenNext = await runBlock('bash', converged(deferAsCommitted, persona, verb, 'no'), persona, { ...CHAIN, texts: { 'next-action.txt': null } });
                deepStrictEqual([unwrittenNext.status, unwrittenNext.log], [1, ['find-active', 'read']], 'unconverged: a next action left unwritten stops the block before the clear');
                const refusedPause = await runBlock('bash', converged(deferAsCommitted, persona, verb, 'no'), persona, { ...CHAIN, clearStatus: 3 });
                deepStrictEqual([refusedPause.status, refusedPause.log], [3, ['find-active', 'read', 'awaiting-owner-clear']], 'unconverged: a refused clear stops the block');
                ok(!/PAUSED/.test(refusedPause.stderr), 'no pause is reported for a clear that did not happen');
              }
              // ADR-0059, amendment of 2026-10-10: a resolution with a quote, an
              // expansion and a line that read as the old heredoc's delimiter
              // reaches state.mjs whole, and nothing in it runs.
              const hostile = "fix it: the team's call `touch pwned2`\nOWNER_RESOLUTION\ntouch injected\n";
              const quoted = await runBlock('bash', fix, persona, { ...CHAIN, texts: { 'resolution.txt': hostile } });
              strictEqual(quoted.status, 0, quoted.stderr);
              deepStrictEqual([quoted.texts, quoted.sideEffects], [[['--resolution-file', hostile]], []]);
              for (const [name, b] of [['fix now', fix], ['defer', defer]]) {
                const unwritten = await runBlock('bash', b, persona, { ...CHAIN, texts: { 'resolution.txt': null } });
                deepStrictEqual([unwritten.status, unwritten.log], [1, ['find-active', 'read']], `${name}: a resolution left unwritten stops the block before any write`);
              }
              for (const [name, block, ran] of [['fix now', fix, ['find-active', 'read', 'awaiting-owner-clear']], ['defer', defer, ['find-active', 'read', 'awaiting-owner-clear']]]) {
                const failed = await runBlock('bash', block, persona, { ...CHAIN, clearStatus: 3 });
                deepStrictEqual([failed.status, failed.log], [3, ran], `${name}: a refused clear stops the block`);
                const none = await runBlock('bash', block, persona, { active: '' });
                deepStrictEqual([none.status, none.log], [1, ['find-active']], `${name}: no workflow, nothing written`);
                ok(none.stderr.includes(`✗ No active ${persona} workflow on this branch.`), none.stderr);
                const lost = await runBlock('bash', block, persona, { active: '/w/active.md', findStatus: 4 });
                deepStrictEqual([lost.status, lost.log], [4, ['find-active']], `${name}: a failed find stops the block with its status`);
              }
            });

            if (VERB_DESTS.includes(dest)) for (const shell of SHELLS) {
              it(`${shell}: the finalize block hands hostile texts to the scripts byte for byte and runs nothing in them; a file left unwritten or blank stops it before any write, and a failed append, after settle, before finish-verb`, async () => {
                const block = converged(blockWith(/peer-runner\.mjs" settle \\/).text, persona, verb);
                const texts = { 'note.md': `${HOSTILE_NOTE}\n`, 'summary.txt': `${HOSTILE_SUMMARY}\n`, 'next-action.txt': `${HOSTILE_NEXT}\n` };
                const ok_ = await runBlock(shell, finalizeAs(block), persona, { active: FOUND, texts: { ...texts, ...runResult() } });
                strictEqual(ok_.status, 0, ok_.stderr);
                deepStrictEqual(ok_.log, typicalLog(verb));
                strictEqual(ok_.note, texts['note.md'], 'the note reached state.mjs unread by the shell');
                deepStrictEqual(ok_.texts, [['--summary-file', texts['summary.txt']], ['--phase-note-file', texts['note.md']], ['--next-action-file', texts['next-action.txt']], ['--next-action-file', texts['next-action.txt']]], 'each script read the file the agent wrote');
                deepStrictEqual(ok_.sideEffects, [], 'nothing in the texts ran');
                ok(ok_.argv.every((a) => !a.includes('pwned') && !a.includes('INJECTED')), 'no text reached a command line');
                // A file a script would refuse stops the block like a missing
                // one: `[ -s ]` passed a newline, and a check for blanks passed a
                // BOM, a NUL byte or bytes that are not UTF-8; settle recorded the
                // run, and the append refused the note after it.
                for (const name of Object.keys(texts)) {
                  for (const [how, content] of REFUSED_TEXTS) {
                    const stopped = await runBlock(shell, finalizeAs(block), persona, { active: FOUND, texts: { ...texts, ...runResult(), [name]: content } });
                    deepStrictEqual([stopped.status, stopped.log], [1, ['find-active']], `${name} ${how}: nothing was written`);
                    ok(stopped.stderr.includes(`${name} in TEXT_DIR (`) && stopped.stderr.includes('is missing, blank or not UTF-8 text'), stopped.stderr);
                  }
                }
                const failed = await runBlock(shell, finalizeAs(block), persona, { active: FOUND, texts: { ...texts, ...runResult() }, failAppend: true });
                strictEqual(failed.status, 7, 'the block exits with the append\'s status');
                // settle has recorded the run; the block run again records nothing
                // more for it, and the append then writes the note.
                deepStrictEqual(failed.log, typicalLog(verb).slice(0, -1), 'no later write ran');
              });
            }
          }
        });
      }
    }
  }
});
