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
// investigate and decide in PC2a2c), with the verb each one runs.
const VERB_DESTS = ['commands/compose.md', 'commands/frame.md', 'commands/investigate.md', 'commands/decide.md'];
// The verb runbooks whose finalize block stays authored (PC2a3 QD7, DD5): its
// behavior differs by persona until PC2b (designer's ensemble-commit guard,
// D2, and its convergence guard). Their other blocks are generated.
const AUTHORED_FINALIZE_DESTS = ['commands/critique.md', 'commands/refine.md'];
const PIPELINE_VERB_DESTS = [...VERB_DESTS, ...AUTHORED_FINALIZE_DESTS];
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

/** A region's body by id; fails when the document does not hold it once. */
function region(text, id) {
  const found = parseRegions(text).regions.filter((r) => r.id === id);
  strictEqual(found.length, 1, `region ${id}`);
  return regionBody(text, found[0]);
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
function runBlock(shell, block, persona, { note = '', failAppend = false, delimiter = null, active = '', findStatus = 0, resolveStatus = 0, inheritedNote = null, after = '', baseline = '', baselineStatus = 0, readOutput = '', readStatus = 0 }) {
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

describe('runbook regions: the contracts hold for every enrolled persona', () => {
  it('the contracts reach the region files they are about (guards a vacuous pass)', () => {
    for (const dest of ['commands/checkpoint.md', 'commands/resume.md', 'commands/peer-now.md', ...PIPELINE_VERB_DESTS, START]) {
      ok(covered(dest), `${dest} has no generated region`);
      deepStrictEqual([...FILES.get(dest)].sort(), ['designer', 'founder'], `${dest}: enrolled personas`);
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
              strictEqual(lines[at], `ROOT_OVERRIDE="$(printenv '${env}' || true)"`, `${persona}: block at line ${b.start + 1}`);
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
              deepStrictEqual([timing.sites, timing.problems], [1, []], 'the terminal write carries its archive-timing note');
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
          }

          if (dest === 'commands/peer-now.md') {
            it('the privacy gate precedes the dispatch, which is synchronous, and the note goes to the workflow found', () => {
              const gate = text.indexOf('PRIVACY GATE:');
              const run = shellSites(text, /peer-runner\.mjs" run/);
              ok(gate >= 0, 'the privacy prohibition is present');
              ok(gate < run[0], 'the privacy prohibition precedes the dispatch block');
              strictEqual(shellSites(text, /> "\$RUN_JSON" 2> "\$RUN_ERR"\nRUN_RC=\$\?/).length, 1, 'the runner\'s exit code is read right after it');
              const find = shellSites(text, /^ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active --repo-root/m);
              const note = shellSites(text, /state\.mjs" append \\\n\s+--workflow-path "\$ACTIVE" /);
              deepStrictEqual([find.length, note.length], [1, 1], 'site counts');
              ok(run[0] < find[0] && find[0] < note[0], 'dispatch, find-active, append in that order');
            });
          }

          if (dest === START) {
            const blocks = shellBlocks(text);
            const blockWith = (re) => {
              const found = blocks.filter((b) => re.test(b.text));
              strictEqual(found.length, 1, `${persona}/start: one block matches ${re}`);
              return found[0];
            };

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

            it('start resume, run: workflow_type is start only when the workflow says so; a missing, empty, malformed or failed read is verb-chain; the read writes nothing', () => {
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
                deepStrictEqual(r.log, ['read'], 'only the read');
                ok(r.argv[0].includes(' --workflow-path /w/active.md'), 'the workflow Phase 0 found');
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
              const terminalAt = text.indexOf(blockWith(/state\.mjs" set-terminal \\/).text);
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
              const bootstrap = text.indexOf('<!-- pipeline:begin start-bootstrap -->');
              ok(bootstrap > 0 && bootstrap < text.indexOf('<!-- pipeline:begin start-initial-verb -->'), 'the initial verb is stated after the bootstrap that creates the workflow');
            });

            it('start: the terminal write follows every extension, and each extension holds the text its slot exists for (QD8)', () => {
              const exts = extensionTexts(text);
              const slots = MANIFEST.extension_points.filter((e) => e.dest === dest && e.personas.includes(persona)).map((e) => e.id);
              deepStrictEqual(exts.map((e) => e.id).sort(), [...slots].sort(), 'one marker per slot this persona owns');
              const terminal = blockWith(/state\.mjs" set-terminal \\/);
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

            if (VERB_DESTS.includes(dest)) it('the dispatch, the note, ensemble-commit and the terminal write run in that order on $ACTIVE; only the note stops the block when it fails (PD6)', () => {
              const run = shellSites(text, /peer-runner\.mjs" run \\/);
              const finalize = blockWith(/state\.mjs" set-terminal \\/);
              const code = logical(finalize.text);
              const at = (re) => { const m = re.exec(code); ok(m, `${key}: ${re}`); return m.index; };
              const note = at(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--phase-note "\$NOTE" [^\n]*--event updated \|\| exit \$\?$/m);
              const commit = at(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" ensemble-commit --workflow-path "\$ACTIVE" [^\n]*--completed-at "\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)"$/m);
              const terminal = at(/^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" set-terminal --workflow-path "\$ACTIVE" [^\n]*--terminal-marker true [^\n]*--event updated$/m);
              strictEqual(run.length, 1, 'one dispatch');
              ok(run[0] < shellSites(text, /^IFS= read -r -d '' NOTE/m)[0], 'the dispatch precedes the finalize block');
              ok(note < commit && commit < terminal, 'append, ensemble-commit, set-terminal in that order');
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
              for (const [call, expected] of [[one('peer-runner.mjs', 'run'), type], [one('state.mjs', 'ensemble-commit'), FIXTURE.expected_commit_ensemble_types?.[persona]?.[verb] ?? type]]) {
                strictEqual(call.get('--phase'), verb);
                strictEqual(call.get('--ensemble-type'), expected);
              }
              deepStrictEqual(got.run_id_prefixes, [type]);
              deepStrictEqual(got.mktemp_templates, [`${persona}-${verb}-prompt.XXXXXX`]);
            });

            if (VERB_DESTS.includes(dest)) it('the phase note: the scaffold right above the finalize block is the recorded one, read from a quoted heredoc and passed as "$NOTE" (PD2)', () => {
              strictEqual(characterize(text).note, expectedFor(key).note);
              const finalize = blockWith(/state\.mjs" set-terminal \\/);
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
              strictEqual(prohibition.length, 1, 'the prohibition sentence');
              ok(prohibition[0] < run[0], 'the prohibition precedes the dispatch block');
              const noImage = sentenceAt(text, NO_IMAGE);
              strictEqual(noImage.length, declaration(persona).peer.images === false ? 1 : 0, 'the no-image rule, exactly where images are off');
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

            if (AUTHORED_FINALIZE_DESTS.includes(dest)) {
              it('the authored finalize follows the finalize heading region and every extension, and writes on $ACTIVE: the note, ensemble-commit, the terminal write (QD7, QD8)', () => {
                const lines = text.split('\n');
                const heading = lines.indexOf(`<!-- pipeline:end ${verb}-finalize-heading -->`);
                ok(heading > 0, 'the finalize heading region');
                const finalize = blockWith(/state\.mjs" set-terminal \\/);
                ok(finalize.start > heading, 'the terminal block follows the heading region');
                const exts = extensionTexts(text);
                for (const ext of exts) ok(ext.line < heading, `extension ${ext.id} precedes the finalize heading`);
                const slots = MANIFEST.extension_points.filter((e) => e.dest === dest && e.personas.includes(persona)).map((e) => e.id);
                deepStrictEqual(exts.map((e) => e.id).sort(), [...slots].sort(), 'one marker per slot this persona owns');
                const code = logical(finalize.text);
                const at = (re) => { const m = re.exec(code); ok(m, `${key}: ${re}`); return m.index; };
                const note = at(/node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" append --workflow-path "\$ACTIVE" [^\n]*--phase-note "\$NOTE" /);
                const commit = at(/node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" ensemble-commit --workflow-path "\$ACTIVE" /);
                const terminal = at(/node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" set-terminal --workflow-path "\$ACTIVE" [^\n]*--terminal-marker true /);
                ok(note < commit && commit < terminal, 'append, ensemble-commit, set-terminal in that order');
                ok(shellSites(text, /peer-runner\.mjs" run \\/)[0] < shellSites(text, /state\.mjs" set-terminal \\/)[0], 'the dispatch precedes the finalize block');
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

              // DD5 and D2, run: the variables the agent sets are substituted
              // the way it sets them, one case per combination.
              it('the authored finalize, run: designer records an ensemble only when it launched and closes only when converged (fail-closed); founder always does both', () => {
                const block = blockWith(/state\.mjs" set-terminal \\/).text;
                const CONVERGED_LINE = /^CONVERGED="[^"\n]*"$/m;
                const convergent = persona === 'designer' && verb === 'refine';
                strictEqual(CONVERGED_LINE.test(block), convergent, 'the block assigns CONVERGED exactly where it waits for convergence');
                // The assignment is a placeholder the agent fills from the
                // re-critique, never a value: run untouched, the block pauses.
                if (convergent) strictEqual(CONVERGED_LINE.exec(block)[0], 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"', 'the convergence placeholder');
                const type = FIXTURE.expected_ensemble_types[persona][verb];
                const run = ({ launched, converged }) => {
                  let script = block;
                  // converged null: the block as committed, its placeholder untouched.
                  if (convergent && converged !== null) script = script.replace(CONVERGED_LINE, () => (converged === undefined ? '' : `CONVERGED='${converged}'`));
                  const vars = launched ? `RUN_ID='${type}-x'; VERDICT='resolved'; SUMMARY='s'; ENSEMBLE_TYPE='${type}'; ` : 'unset RUN_ID VERDICT SUMMARY ENSEMBLE_TYPE; ';
                  return runBlock('bash', `ACTIVE='/w/active.md'; ${vars}\n${script}`, persona, {});
                };
                const cases = !convergent && persona === 'designer'
                  ? [
                    [{ launched: true }, ['append', 'ensemble-commit', 'set-terminal']],
                    [{ launched: false }, ['append', 'set-terminal']],
                  ]
                  : convergent
                  ? [
                    [{ launched: true, converged: 'yes' }, ['append', 'ensemble-commit', 'set-terminal']],
                    [{ launched: true, converged: 'no' }, ['append', 'ensemble-commit']],
                    [{ launched: false, converged: 'yes' }, ['append', 'set-terminal']],
                    [{ launched: false, converged: 'no' }, ['append']],
                    [{ launched: true, converged: undefined }, ['append', 'ensemble-commit']],
                    [{ launched: true, converged: '<yes|no>' }, ['append', 'ensemble-commit']],
                    [{ launched: true, converged: null }, ['append', 'ensemble-commit']],
                  ]
                  : [[{ launched: true }, ['append', 'ensemble-commit', 'set-terminal']]];
                for (const [opts, expected] of cases) {
                  const r = run(opts);
                  strictEqual(r.status, 0, `${JSON.stringify(opts)}: ${r.stderr}`);
                  deepStrictEqual(r.log, expected, JSON.stringify(opts));
                  ok(r.argv.every((a) => a.includes(' --workflow-path /w/active.md ')), `${JSON.stringify(opts)}: every write targets $ACTIVE`);
                  if (expected.includes('set-terminal')) ok(r.argv.at(-1).includes(' --terminal-marker true '), 'the terminal write marks the workflow');
                  else if (persona === 'designer') ok(/PAUSED/.test(r.stderr), `${JSON.stringify(opts)}: the pause is reported`);
                  if (expected.includes('ensemble-commit')) ok(r.argv.find((a) => / ensemble-commit /.test(a)).includes(` --ensemble-type ${type} `), 'the type the dispatch named');
                }
              });

              // QD5: founder critique's dispatch takes its type from the
              // profile, as the agent sets it in the block; stays authored.
              if (persona === 'founder' && verb === 'critique') {
                it('founder critique, instantiated per profile: red-team dispatches and commits adversarial-scan; default, unknown and missing review (QD5)', () => {
                  const dispatch = blockWith(/peer-runner\.mjs" run \\/).text;
                  const finalize = blockWith(/state\.mjs" set-terminal \\/).text;
                  const TYPE_LINE = /^ENSEMBLE_TYPE="review" {3}# ← CHANGE to "adversarial-scan" for --profile=red-team$/m;
                  ok(TYPE_LINE.test(dispatch), 'the block assigns review and says when to change it');
                  ok(/^#   default profile {4}→ review /m.test(dispatch) && /^#   --profile=red-team → adversarial-scan /m.test(dispatch), 'the mapping comment');
                  strictEqual(sentenceAt(text, 'Missing profile → default. Unknown profile → fallback to default with a one-line warning.').length, 1, 'the fallback sentence');
                  for (const [profile, expected] of [['default', 'review'], ['red-team', 'adversarial-scan'], ['unknown', 'review'], ['missing', 'review']]) {
                    // The agent changes the line for red-team only; the block
                    // runs in the foreground here (its trailing & dropped).
                    const script = (profile === 'red-team' ? dispatch.replace(TYPE_LINE, 'ENSEMBLE_TYPE="adversarial-scan"') : dispatch).replace(/ &$/m, '');
                    const sent = runBlock('bash', `ACTIVE='/w/active.md'\n${script}\nprintf '%s' "$RUN_ID" > out`, persona, {});
                    strictEqual(sent.status, 0, sent.stderr);
                    ok(sent.argv.length === 1 && sent.argv[0].includes(` --ensemble-type ${expected} `), `${profile}: the dispatch names ${expected}`);
                    ok(sent.out.startsWith(`${expected}-`), `${profile}: the run id carries ${expected}`);
                    const done = runBlock('bash', `ACTIVE='/w/active.md'; ENSEMBLE_TYPE='${expected}'; RUN_ID='${sent.out}'; VERDICT='sound'; SUMMARY='s'\n${finalize}`, persona, {});
                    ok(done.argv.find((a) => / ensemble-commit /.test(a)).includes(` --ensemble-type ${expected} --run-id ${sent.out} `), `${profile}: ensemble-commit records ${expected} under the same run id`);
                  }
                });
              }
            }

            if (VERB_DESTS.includes(dest)) for (const shell of SHELLS) {
              const finalizeCase = readsDelimited(shell)
                ? `${shell}: the finalize block hands a hostile note to state.mjs byte for byte (plus the heredoc's final newline), and a failed append stops it before ensemble-commit and the terminal write`
                : `${shell}: a shell whose read has no -d stops the finalize block before any write`;
              it(finalizeCase, () => {
                const block = blockWith(/state\.mjs" set-terminal \\/).text;
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
                deepStrictEqual(ok_.log, ['append', 'ensemble-commit', 'set-terminal']);
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
