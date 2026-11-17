// tests/persona-pipeline/_verb-runbook-fixture.mjs
//
// The runner the verb runbook tests share (ADR-0063 S3+S4; ADR-0066 Stage 3,
// PC3b U4b): test-verb-runbook-runs.mjs, each branch and refusal once in bash;
// test-verb-runbook-runs-e2e.mjs, every verb's happy path in every installed
// shell; test-verb-runbook-killed-dispatch.mjs, the R4 F1 kill case. The
// blocks run as written against temporary repositories with the persona's
// real scripts; the texts the agent writes reach them as files in the
// directory a block's TEXT_DIR line names (ADR-0059's amendment of
// 2026-10-10), as the agent writes them.
//
// Not discovered by `node --test`: the stem starts with `_`.

import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { parseRegions, renderTemplate, renderingDeclaration, replaceRegionBodies } from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, personaInfo, personasFound } from './_personas.mjs';

export { REPO_ROOT };
export const VERBS = ['investigate', 'frame', 'compose', 'decide', 'critique', 'refine'];
// The verb each verb's finalize records next: the lifecycle's order, the same
// in every persona's template.
export const NEXT_VERB = { investigate: 'frame', frame: 'decide', compose: 'critique', decide: 'compose', critique: 'refine', refine: 'critique' };
export const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
export const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
// The review types, whose attempt a finalize records when no run launched
// (C163 A1a).
export const REVIEW_TYPES = ['review', 'plan-verify', 'refine-verify'];

export const PERSONAS = [...new Set(MANIFEST.regions.filter((r) => VERBS.some((v) => r.dest === `commands/${v}.md`)).flatMap((r) => r.personas))].sort();

/** The personas the verb regions reach are the personas on disk (guards a vacuous pass). */
export function assertPersonasReached() {
  ok(PERSONAS.length > 0, 'the verb regions reach at least one persona');
  deepStrictEqual(PERSONAS, personasFound());
  for (const persona of PERSONAS) {
    for (const verb of VERBS) {
      ok(MANIFEST.regions.some((r) => r.dest === `commands/${verb}.md` && r.personas.includes(persona)), `${persona}/${verb}`);
    }
  }
}

/** The runbook with every region body rendered fresh from its template. */
export function assembled(persona, dest, text) {
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

export function section(text, heading) {
  const start = text.indexOf(heading);
  // Contract: the blocks run are sliced by these headings — a heading gone
  // would run nothing, or the wrong section's blocks.
  ok(start >= 0, `missing ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}
export const blocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
// The blocks that write: the private-directory step before each (`mktemp -d`)
// is the agent's, not one a test runs.
export const writing = (text) => blocks(text).filter((b) => !/^\s*mktemp -d /.test(b));
// ADR-0059's amendment of 2026-10-10: the directory the agent wrote its text
// files into, named on a block's first line; the test fills it as the agent does.
export const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
// R4 (C75): the finalize's dispatch directory and synthesis verdict, which the
// agent fills; the block finds the workflow itself, and reads the run's id
// from the result the runner wrote in that directory.
export const DISPATCH_DIR_LINE = "DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'";
export const VERDICT_LINE = "VERDICT='<the synthesis verdict>'";
// R4 K3: the last write's confidence, and, where the verb closes only once it
// converged, the step that resolves what is still open — set at the top of the
// block and checked before its first write.
export const CONFIDENCE_LINE = "CONFIDENCE='<HIGH|MEDIUM|LOW>'";
export const RESOLVE_LINE = "RESOLVE_VERB='<refine|decide|investigate — the next step that resolves the flagged item, when not converged>'";
// ADR-0068 Decision 2, item 7 (N4): with dispatch_target on, the operation
// directory the Phase 0 block printed, which the agent sets in the finalize.
export const OP_DIR_LINE = "OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'";
// A gate resolution's blocks, with dispatch_target on: the directory this run's
// Phase 0 printed, or empty (the block then opens the resolution's own).
const GATE_OP_DIR_RE = /^OP_DIR='<the operation directory Phase 0 of this run printed as OP_DIR; empty when it printed none or the finalize of this (verb|refine) already ran>'$/m;
export const gateOpDir = (block) => block.replace(GATE_OP_DIR_RE, () => "OP_DIR=''");
export const MACRO = 'macro-plan-20261025T000000Z-abcdef';
export const SUBTASK = 'hold-persona';
// The `text` scaffold a runbook shows for one of the files, after the first
// sentence that names it: what the agent writes when nothing else applies.
export function scaffold(text, file) {
  const at = text.indexOf(`\`${file}\``);
  ok(at >= 0, `the runbook names ${file}`);
  const m = /\n( *)```text\n([\s\S]*?)\n\1```\n/.exec(text.slice(at));
  ok(m, `a text scaffold for ${file}`);
  return m[2].split('\n').map((l) => l.slice(m[1].length)).join('\n');
}
// Text the shell would read if it were spliced into a command: quotes, an
// expansion, a command substitution, a backtick, a line reading as the
// retired heredoc delimiters with a command after it, a leading --, non-ASCII.
export const HOSTILE = 'He said "go"; it\'s $HOME and $(touch pwned) and `touch pwned2`\nPHASE_NOTE\nOWNER_RESOLUTION\ntouch injected\n--looks-like-a-flag\n비ASCII é ✓';
export const dedent = (b) => {
  const lines = b.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind)).join('\n');
};

/** A placeholder the case fills in, checked present so the fill is never vacuous. */
export function fill(block, placeholder, value) {
  // Contract: the placeholder the agent fills before running the block —
  // absent, the run would execute the unfilled text and prove nothing.
  ok(block.includes(placeholder), `the block holds ${placeholder}`);
  return block.replaceAll(placeholder, value);
}

/**
 * The fixture of one persona: its runbooks (committed, and assembled from the
 * templates), the block runner, the repository and workflow helpers, and the
 * real runner's launch.
 */
export async function verbRunbookFixture(persona) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const PEER_RUNNER = P.path('scripts/peer-runner.mjs');
  const { readWorkflow } = await import(pathToFileURL(STATE).href);
  const ROOT_ENV = renderingDeclaration(P.declaration).derived.root_env;
  const dispatchOn = P.capabilities.dispatch_target === true;
  const commitOn = P.capabilities.commit_surface === true;
  const convergent = (verb) => P.declaration.verbs?.[verb]?.terminal_requires_convergence === true;

  const committed = Object.fromEntries(VERBS.map((v) => [v, readFileSync(P.path(`commands/${v}.md`), 'utf8')]));
  const fresh = Object.fromEntries(VERBS.map((v) => [v, assembled(persona, `commands/${v}.md`, committed[v])]));
  // [label, runbooks, whether the assembled runbooks of these verbs are the committed ones]
  const DOCUMENTS = [['committed', committed, () => false], ['assembled from the templates', fresh, (verbs) => verbs.every((v) => fresh[v] === committed[v])]];

  function runBlock(shell, dir, block, extra = {}, root = P.root) {
    const env = { ...process.env, [ROOT_ENV]: root, ...extra };
    delete env.CLAUDE_PLUGIN_ROOT;
    if (!('AGENTIC_AUTOPILOT' in extra)) delete env.AGENTIC_AUTOPILOT;
    delete env.ACCEPT_CURRENT_TREE;
    return spawnSync(shell, ['-c', block], { cwd: dir, encoding: 'utf8', env });
  }

  const state = (...args) => execFileSync('node', [STATE, ...args], { encoding: 'utf8', env: { ...process.env, AGENTIC_AUTOPILOT: '' } });

  // The files the agent writes before a block, each ending with one newline as
  // the file-writing tool leaves it, in a fresh directory whose name holds a
  // space; the block's TEXT_DIR line is filled with it. withRepo removes it.
  const TEXT_DIRS = [];
  async function withTexts(block, files) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${persona} agentic text.`)));
    TEXT_DIRS.push(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), `${content}\n`);
    return fill(block, TEXT_DIR_LINE, `TEXT_DIR='${dir}'`);
  }
  const lastTextDir = () => TEXT_DIRS[TEXT_DIRS.length - 1];

  // The dispatch's directory: the result `peer-runner run` printed, which the
  // dispatch block redirects to prompt.xml.run.json there.
  async function dispatched(run) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${persona} agentic dispatch.`)));
    TEXT_DIRS.push(dir);
    await writeFile(join(dir, 'prompt.xml.run.json'), run.stdout);
    return dir;
  }

  // The agent's fills of the finalize's head: the dispatch's directory (empty
  // when no run launched) and the verdict. With dispatch_target on, also the
  // operation directory (empty when Phase 0 printed none); with it off the
  // block has none.
  const filled = (b, runDir = '', verdict = 'agreed', opDir = '') => {
    const s = fill(fill(fill(b, DISPATCH_DIR_LINE, runDir ? `DISPATCH_DIR='${runDir}'` : "DISPATCH_DIR=''"), VERDICT_LINE, `VERDICT='${verdict}'`), CONFIDENCE_LINE, "CONFIDENCE='HIGH'");
    if (dispatchOn) return fill(s, OP_DIR_LINE, `OP_DIR='${opDir}'`);
    ok(!s.includes('OP_DIR'), 'no operation directory with dispatch_target off');
    return s;
  };

  async function withRepo(fn) {
    // realpath: the blocks resolve the repository through git, which reports
    // /private/var where mkdtemp said /var on macOS. A private area holds the
    // checkout and, beside it, the TMPDIR every block and runner here makes
    // its peer snapshots in (one inside the checkout would send them to
    // /tmp), removed together: a run a killed test left is found in its
    // fixture's area, never among the shared TMPDIR's (C142).
    const area = await realpath(await mkdtemp(join(tmpdir(), `${persona}-verb-runbook-`)));
    const dir = join(area, 'repo');
    await mkdir(dir);
    await mkdir(join(area, 'tmp'));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = join(area, 'tmp');
    try {
      const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
      git('init', '-q', '-b', 'feat/r');
      git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
      await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
      await writeFile(join(dir, 'README.md'), '# r\n');
      git('add', '.');
      git('commit', '-qm', 'chore: base', '--no-verify');
      return await fn(dir, area);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      await rm(area, { recursive: true, force: true });
      for (const text of TEXT_DIRS.splice(0)) await rm(text, { recursive: true, force: true });
    }
  }

  function createWorkflow(dir, verb, { type = null, parent = false } = {}) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const digest = execFileSync('shasum', ['-a', '256'], {
      input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
      encoding: 'utf8',
    }).trim().split(/\s+/)[0];
    return execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', verb, '--host', 'claude',
      ...(type ? ['--workflow-type', type] : []),
      ...(parent ? ['--parent-workflow', MACRO, '--originating-subtask', SUBTASK] : []),
      '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', digest,
      '--original-request', 'runbook fixture'], { encoding: 'utf8' }).trim();
  }

  const archive = (dir, wf) => state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

  // A stub companions root (AGENTIC_COMPANIONS_ROOT): the runner finds a codex
  // companion that answers at once, one that never answers, or none at all.
  // The caller removes it.
  async function stubCompanions({ missing = false, hang = false } = {}) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${persona}-companions-`)));
    await writeFile(join(dir, 'discover-peer.mjs'), missing
      ? 'export async function discoverPeerCompanion() { return { ok: false, reason: "not installed" }; }\n'
      : 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
    if (!missing) {
      await writeFile(join(dir, 'codex-companion.mjs'), hang
        // A peer that never answers (R4 F1: the runner is killed meanwhile).
        ? '#!/usr/bin/env node\nsetTimeout(() => {}, 120000);\n'
        : "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'the peer answer', exit_code: 0 }));\n");
      execFileSync('chmod', ['755', join(dir, 'codex-companion.mjs')]);
    }
    await writeFile(join(dir, 'prompt.xml'), '<task>fixture</task>\n');
    return dir;
  }

  // The dispatch, as the runbook runs it: the real runner records the pending
  // row and the ledger.
  function launch(dir, wf, verb, type, runId, companions) {
    const env = { ...process.env, AGENTIC_COMPANIONS_ROOT: companions };
    delete env.AGENTIC_AUTOPILOT;
    return spawnSync('node', [PEER_RUNNER, 'run', '--repo-root', dir, '--kind', 'ensemble',
      '--peer', 'codex', '--prompt-file', join(companions, 'prompt.xml'), '--output-format', 'json',
      '--workflow-path', wf, '--phase', verb, '--host', 'claude', '--cwd', dir,
      '--ensemble-type', type, '--run-id', runId], { cwd: dir, encoding: 'utf8', env });
  }

  // A run's status as the real runner reports it, or null while it has none.
  function statusOf(dir, runId) {
    try {
      return JSON.parse(execFileSync('node', [PEER_RUNNER, 'status', '--repo-root', dir, '--run-id', runId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      return null;
    }
  }

  /** The blocks of one verb's runbook, from the runbooks given. */
  const verbBlocks = (docs, verb) => {
    const text = docs[verb];
    const all0 = blocks(section(text, '## Phase 0')).map(dedent);
    return {
      find: all0[0],
      resume: all0.find((b) => b.includes('state.mjs" append')),
      phase2: writing(section(text, '## Phase 2 — State finalize'))[0],
      dispatch: blocks(text).find((blk) => blk.includes('peer-runner.mjs" run \\')),
      nextAction: scaffold(section(text, '## Phase 2 — State finalize'), 'next-action.txt'),
      type: /^ENSEMBLE_TYPE='([^']+)'$/m.exec(text)?.[1],
    };
  };

  // The finalize with the agent's choices made: confidence HIGH and, where
  // the verb closes only once it converged, the convergence and the step
  // that resolves what is still open; the note, the summary and the next
  // action written as files (the scaffold's default next action, unless
  // the case names another).
  const finalize = async (docs, verb, { converged = true, note = '### Ensemble synthesis: fixture', summary = 'fine', nextAction = verbBlocks(docs, verb).nextAction, runDir = '', opDir = '' } = {}) => {
    let b = filled(verbBlocks(docs, verb).phase2, runDir, 'agreed', opDir);
    b = await withTexts(b, { 'note.md': note, 'summary.txt': summary, 'next-action.txt': nextAction });
    // Contract: the agent running the finalize — the convergence step it fills
    // exists exactly where the verb waits for convergence; elsewhere it would
    // hold back the terminal write.
    if (convergent(verb)) {
      b = b.replace(/CONVERGED="<yes\|no[^"\n]*>"/, () => `CONVERGED="${converged ? 'yes' : 'no'}"`);
      ok(b.includes(`CONVERGED="${converged ? 'yes' : 'no'}"`), 'the convergence is set in the block');
      b = fill(b, RESOLVE_LINE, "RESOLVE_VERB='refine'");
    } else {
      ok(!b.includes('CONVERGED='), 'a verb that does not wait for convergence has no convergence step');
    }
    return b;
  };

  // The verb's happy path, which every runbook path keeps: the runbook's own
  // dispatch block launches the run (the real runner, a companion that
  // answers at once), and the finalize, given the directory that block ran
  // with, records the synthesis verdict, removes the pending row and makes
  // the terminal write with the verb's next step and declared action.
  async function completedFinalize(shell, dir, docs, verb, companions, vars = {}) {
    const { type, dispatch } = verbBlocks(docs, verb);
    // Contract: the dispatch's ENSEMBLE_TYPE, which the run launches under.
    ok(typeof type === 'string', 'the runbook names its ensemble type');
    ok(dispatch, 'the dispatch block');
    const wf = createWorkflow(dir, verb);
    let r = runBlock(shell, dir, await withTexts(dispatch, { 'prompt.xml': '<task>fixture</task>' }), { ...vars, AGENTIC_COMPANIONS_ROOT: companions });
    strictEqual(r.status, 0, r.stderr);
    const runDir = lastTextDir();
    const result = JSON.parse(readFileSync(join(runDir, 'prompt.xml.run.json'), 'utf8'));
    deepStrictEqual([result.status, typeof result.run_id === 'string' && result.run_id.startsWith(`${type}-`)], ['completed', true], JSON.stringify(result));
    r = runBlock(shell, dir, await finalize(docs, verb, { runDir }), vars);
    strictEqual(r.status, 0, r.stderr);
    const fm = (await readWorkflow(wf)).frontmatter;
    deepStrictEqual((fm.ensemble_results ?? []).map((e) => [e.run_id, e.verdict, e.ensemble_type]), [[result.run_id, 'agreed', type]]);
    deepStrictEqual([(fm.pending_ensemble ?? []).length, fm.current_phase, fm.terminal_marker, fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence, fm.next_action],
      [0, 'summary-complete', true, 'verb', NEXT_VERB[verb], 'HIGH', P.declaration.verbs[verb].next_action]);
    return wf;
  }

  return {
    P, STATE, PEER_RUNNER, ROOT_ENV, readWorkflow, dispatchOn, commitOn, convergent,
    committed, fresh, DOCUMENTS,
    runBlock, state, withTexts, lastTextDir, dispatched, filled, withRepo, createWorkflow, archive,
    stubCompanions, launch, statusOf, verbBlocks, finalize, completedFinalize,
  };
}
