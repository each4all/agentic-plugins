// ADR-0068 Decision 5, `verify-runbooks`: the persona runbooks hand long
// checks to the driver's verification step when the run offers it, and read
// the results when they resume. The blocks run as written, in bash, against
// temporary repositories holding the repository's check declaration, with the
// persona's real scripts, for every persona whose runbooks render the verify
// form (dispatch_target on; a persona with it off renders none, which the
// first case pins).
//
// Covers:
//   - the finalize of compose, refine and critique (each finalize template:
//     the plain one and the consensus variant), on a macro's child with the
//     operation Phase 0 opened: a request in TEXT_DIR under an offering run
//     ends the verb with the next step verify and the request, the operation
//     closed and no terminal marker; with no request, the verb form; a run
//     that offers no verification, a request the last write would refuse,
//     and (consensus) a conflict verdict stop the block before any write; run
//     again with the same TEXT_DIR, a request removed, changed or added since
//     stops it before any write, the same request is taken again, and one
//     whose last write failed is recorded on the rerun; a dangling request
//     link refuses, and (critique) a conflict for a real peer run stops the
//     block before settle;
//   - the resume of a verb prints the results: a failed batch's failing test
//     and log, a passed batch's results as applying to the tree now (the
//     on_pass critique), not applying once the tree changed, nothing with no
//     request, and a warning (exit 0) for a results record a later release
//     wrote;
//   - the persona's tree digest is the driver's (lane-digest.mjs treeDigest)
//     on a tree with staged, unstaged, untracked, assume-unchanged and
//     skip-worktree changes and the driver's lock fence;
//   - the prose: under an offering run no rendered compose, refine or
//     critique runbook or skill tells the worker to run the whole suite or a
//     mutation run itself, and each points to the long-check guidance.
//
// Run via `npm test -- tests/persona-pipeline/test-verify-runbooks.mjs`.

import './_drop-session.mjs';
import { describe, it, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderingDeclaration } from '../../scripts/lib/persona-pipeline.mjs';
import { treeDigest as driverTreeDigest } from '../../plugins/orchestrator/scripts/lib/lane-digest.mjs';
import { REPO_ROOT, personaInfo, personasFor } from './_personas.mjs';

for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

const RUN = 'autopilot-20261031T010203Z-abcdef';
const MACRO = 'macro-plan-20261031T000000Z-abcdef';
const SUBTASK = 'verify-persona';
const DECLARATION = readFileSync(join(REPO_ROOT, '.agentic-plugins/verify-checks.json'), 'utf8');
const VERBS = { compose: 'critique', refine: 'critique', critique: 'refine' };
const REQ = Object.freeze({
  checks: [{ kind: 'test', args: { files: ['tests/a.mjs'] } }, { kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs', ids: ['S1'] } }],
  on_pass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' },
  confidence: 'HIGH',
});

const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
const DISPATCH_DIR_LINE = "DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'";
const VERDICT_LINE = "VERDICT='<the synthesis verdict>'";
const CONFIDENCE_LINE = "CONFIDENCE='<HIGH|MEDIUM|LOW>'";
const OP_DIR_LINE = "OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'";

function section(text, heading) {
  const start = text.indexOf(heading);
  ok(start >= 0, `missing ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}
const blocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const dedent = (b) => {
  const lines = b.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind)).join('\n');
};
function fill(block, placeholder, value) {
  ok(block.includes(placeholder), `the block holds ${placeholder}`);
  return block.replaceAll(placeholder, value);
}

const PERSONAS = personasFor('scripts/state.mjs');

describe('the verify form reaches exactly the personas with dispatch_target on (guards a vacuous pass)', () => {
  it('engineer renders it in every verb finalize; a persona with dispatch_target off renders none of it', () => {
    const on = PERSONAS.filter((p) => personaInfo(p).capabilities.dispatch_target === true);
    ok(on.includes('engineer'), 'engineer has dispatch_target on');
    for (const persona of PERSONAS) {
      const P = personaInfo(persona);
      for (const verb of Object.keys(VERBS)) {
        const text = readFileSync(P.path(`commands/${verb}.md`), 'utf8');
        const has = /--next-step-kind verify --next-step-confidence "\$CONFIDENCE"/.test(text) && text.includes('verify-request-check');
        strictEqual(has, on.includes(persona), `${persona}/${verb}`);
      }
    }
  });
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const persona of PERSONAS.filter((p) => personaInfo(p).capabilities.dispatch_target === true)) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const S = await import(pathToFileURL(STATE).href);
  const V = await import(pathToFileURL(P.path('scripts/lib/verify.mjs')).href);
  const decl = V.parseDeclaration(DECLARATION);
  const ROOT_ENV = renderingDeclaration(P.declaration).derived.root_env;
  const text = Object.fromEntries([...Object.keys(VERBS), 'decide'].map((v) => [v, readFileSync(P.path(`commands/${v}.md`), 'utf8')]));
  const resumeOf = (verb) => blocks(section(text[verb], '## Phase 0')).map(dedent).find((b) => b.includes('state.mjs" append'));
  const finalizeOf = (verb) => blocks(section(text[verb], '## Phase 2 — State finalize')).filter((b) => !/^\s*mktemp -d /.test(b))[0];

  const areas = [];
  after(() => Promise.all(areas.map((d) => rm(d, { recursive: true, force: true }))));

  async function withRepo(fn) {
    const area = await realpath(await mkdtemp(join(tmpdir(), `${persona}-verify-runbooks-`)));
    areas.push(area);
    const dir = join(area, 'repo');
    await mkdir(dir);
    git(dir, 'init', '-q', '-b', 'feat/r');
    await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n.agentic-plugins/runs/\n');
    for (const f of ['tests/a.mjs', 'scripts/mutation-specs/s.mjs', 'notes.txt']) {
      await mkdir(join(dir, f, '..'), { recursive: true });
      await writeFile(join(dir, f), '// fixture\n');
    }
    await mkdir(join(dir, '.agentic-plugins'), { recursive: true });
    await writeFile(join(dir, '.agentic-plugins/verify-checks.json'), DECLARATION);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'chore: base', '--no-verify');
    const sha = git(dir, 'rev-parse', 'HEAD');
    // The hold protocol a macro child's persona operation is published under.
    const holds = join(dir, '.agentic-plugins/runs/autopilot/holds', MACRO);
    await mkdir(holds, { recursive: true });
    await writeFile(join(holds, 'protocol.json'), JSON.stringify({ schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'test', at: '2026-10-31T00:00:00Z' }));
    const head = sha;
    const digest = execFileSync('shasum', ['-a', '256'], { input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }), encoding: 'utf8' }).trim().split(/\s+/)[0];
    const wf = execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude',
      '--parent-workflow', MACRO, '--originating-subtask', SUBTASK,
      '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', digest,
      '--original-request', 'verify runbooks fixture'], { encoding: 'utf8' }).trim();
    return fn({ dir, sha, wf, area });
  }

  const offer = (sha, step = '3') => ({ AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: step, AGENTIC_AUTOPILOT_VERIFY: sha });
  function runBlock(dir, block, extra = {}) {
    const env = { ...process.env, [ROOT_ENV]: P.root, TMPDIR: tmpdir(), ...extra };
    delete env.CLAUDE_PLUGIN_ROOT;
    return spawnSync('bash', ['-c', block], { cwd: dir, encoding: 'utf8', env });
  }
  // Phase 0's resume, as the step runs it: it opens the verb's operation on
  // the macro's child and prints its directory.
  function resume(dir, verb, env) {
    const b = resumeOf(verb).replaceAll('"<profile or empty>"', '""');
    const r = runBlock(dir, b, env);
    strictEqual(r.status, 0, r.stderr);
    const opDir = /^OP_DIR=(.+)$/m.exec(r.stdout)?.[1];
    ok(opDir, r.stdout);
    return { ...r, opDir };
  }
  async function textDir(area, files) {
    const d = await mkdtemp(join(area, 'text '));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(d, name), typeof content === 'string' ? `${content}\n` : `${JSON.stringify(content, null, 2)}\n`);
    }
    return d;
  }
  const finalize = (verb, { tdir, opDir, verdict = 'agreed' }) => fill(fill(fill(fill(fill(finalizeOf(verb), TEXT_DIR_LINE, `TEXT_DIR='${tdir}'`),
    DISPATCH_DIR_LINE, "DISPATCH_DIR=''"), VERDICT_LINE, `VERDICT='${verdict}'`), CONFIDENCE_LINE, "CONFIDENCE='HIGH'"), OP_DIR_LINE, `OP_DIR='${opDir}'`);
  const texts = (extra = {}) => ({ 'note.md': '### Ensemble synthesis: fixture', 'summary.txt': 'fine', 'next-action.txt': 'Verify the change, then critique', ...extra });
  const front = async (wf) => (await S.readWorkflow(wf)).frontmatter;

  describe(`${persona}: the finalize hands long checks to the verification step (bash, committed runbooks)`, () => {
    for (const [verb, nextVerb] of Object.entries(VERBS)) {
      it(`${verb}: a request under an offering run ends with next step verify, the request, the operation closed and no terminal marker; with none, the verb form`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
          const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
          strictEqual(r.status, 0, r.stderr);
          const fm = await front(wf);
          deepStrictEqual(
            [fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence, fm.terminal_marker === true, fm.persona_operations, fm.current_phase, fm.next_action],
            ['verify', undefined, 'HIGH', false, undefined, 'phase-2-presented', 'Verify the change, then critique'],
          );
          deepStrictEqual([fm.verify_request.checks, fm.verify_request.on_pass, fm.verify_request.run_id, fm.verify_request.step],
            [REQ.checks, REQ.on_pass, RUN, 3]);
          deepStrictEqual(JSON.parse(await readFile(join(tdir, 'finalize-verify.json'), 'utf8')).request_sha256.length, 64);
        });
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const tdir = await textDir(area, texts());
          const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
          strictEqual(r.status, 0, r.stderr);
          const fm = await front(wf);
          deepStrictEqual([fm.next_step_kind, fm.next_step_verb, 'verify_request' in fm, fm.persona_operations], ['verb', nextVerb, false, undefined]);
          deepStrictEqual(JSON.parse(await readFile(join(tdir, 'finalize-verify.json'), 'utf8')), { request_sha256: null });
        });
      });

      it(`${verb}: no offer, a request the last write would refuse, or a conflict verdict stops the block before any write`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const before = await readFile(wf, 'utf8');
          const refused = async (files, env, pattern, opts = {}) => {
            const tdir = await textDir(area, texts(files));
            const r = runBlock(dir, finalize(verb, { tdir, opDir, ...opts }), env);
            strictEqual(r.status, 1, `${pattern}: ${r.stderr}`);
            ok(pattern.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, `${pattern}: nothing was written`);
          };
          const unoffered = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '3' };
          await refused({ 'verify-request.json': REQ }, unoffered, /next step verify is refused: missing the run's offer[\s\S]*The last write would refuse verify-request\.json/);
          await refused({ 'verify-request.json': { ...REQ, checks: [{ kind: 'test', args: { files: ['tests/gone.mjs'] } }] } }, offer(sha), /names no file in the tested tree/);
          await refused({ 'verify-request.json': { ...REQ, confidence: 'MEDIUM' } }, offer(sha), /is not the request's confidence MEDIUM/);
          await refused({ 'verify-request.json': { ...REQ, checks: [{ kind: 'shell', args: {} }] } }, offer(sha), /check kind "shell" is not declared/);
          // A request entry the check cannot read (a dangling link) is not
          // the verb form: it refuses too.
          const dangling = await textDir(area, texts());
          await symlink(join(area, 'gone.json'), join(dangling, 'verify-request.json'));
          const d = runBlock(dir, finalize(verb, { tdir: dangling, opDir }), offer(sha));
          strictEqual(d.status, 1, d.stderr);
          ok(/The last write would refuse verify-request\.json/.test(d.stderr), d.stderr);
          strictEqual(await readFile(wf, 'utf8'), before, 'a dangling link: nothing was written');
          // Each finalize template: compose and refine render the plain one,
          // critique the consensus variant.
          await refused({ 'verify-request.json': REQ, 'contested.md': 'a contested item' }, offer(sha), /but VERDICT is conflict: a conflict ends on its gate and takes no request/, { verdict: 'conflict' });
        });
      });
    }

    // A step that ends on its owner's judgment takes no request: next step
    // verify would hide the gate, and the driver would run on_pass past it.
    // decide's owner selection or veto records decide-conflict under its
    // ordinary synthesis heading, so only OWNER_GATE names it.
    const withGate = (block, gate) => fill(block, "OWNER_GATE=''", `OWNER_GATE='${gate}'`);
    for (const verb of [...Object.keys(VERBS), 'decide']) {
      it(`${verb}: an owner gate (OWNER_GATE, or its note's heading) beside a request stops the block before any write`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const before = await readFile(wf, 'utf8');
          const refused = async (files, pattern, ownerGate = '') => {
            const tdir = await textDir(area, texts(files));
            const r = runBlock(dir, withGate(finalize(verb, { tdir, opDir }), ownerGate), offer(sha));
            strictEqual(r.status, 1, `${pattern}: ${r.stderr}`);
            ok(pattern.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, `${pattern}: nothing was written`);
          };
          const gate = verb === 'decide' ? 'decide-conflict' : 'pr-handling';
          await refused({ 'verify-request.json': REQ }, new RegExp(`but OWNER_GATE is ${gate}: a step that ends on its owner's judgment takes no request`), gate);
          const headings = verb === 'decide' ? [] : ['Routing recommendation', 'Outward action needed', ...(verb === 'refine' ? ['Recurring finding'] : [])];
          for (const heading of headings) {
            await refused({ 'verify-request.json': REQ, 'note.md': `### Ensemble synthesis: fixture\n\n### ${heading}\n\nOwner: the judgment` }, /records an owner gate \(its heading\), but OWNER_GATE is empty/);
          }
          // The control: the same request with no gate is taken.
          const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
          const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
          strictEqual(r.status, 0, r.stderr);
          strictEqual((await front(wf)).next_step_kind, 'verify');
        });
      });
    }

    // Naming the gate is what records it (C2-M1): OWNER_GATE selects the last
    // write's owner-decision form, so a step can neither name a gate and close
    // with the verb form, nor hold a gate's heading in its note and close
    // without naming it.
    const OWN_GATE = { compose: ['pr-handling', 'pr-handling'], refine: ['recurring-finding', 'recurring-finding'], critique: ['pr-handling', 'pr-handling'], decide: ['decide-conflict', 'ensemble-synthesis'] };
    for (const verb of [...Object.keys(VERBS), 'decide']) {
      it(`${verb}: OWNER_GATE makes the last write the owner-decision form with the gate's anchor, under autopilot and interactively; a gate the verb does not end on, or a gate's heading with OWNER_GATE empty, stops the block before any write`, async () => {
        // Its own gate under autopilot and interactively; scope-routing, the
        // gate every verb ends on, with its anchor routing-recommendation.
        const cases = [[...OWN_GATE[verb], (sha) => offer(sha)], [...OWN_GATE[verb], () => ({})], ['scope-routing', 'routing-recommendation', (sha) => offer(sha)]];
        for (const [gate, anchor, env] of cases) {
          await withRepo(async ({ dir, sha, wf, area }) => {
            const { opDir } = resume(dir, verb, env(sha));
            const tdir = await textDir(area, texts({ 'next-action.txt': 'Owner: the judgment' }));
            const r = runBlock(dir, withGate(finalize(verb, { tdir, opDir }), gate), env(sha));
            strictEqual(r.status, 0, r.stderr);
            const fm = await front(wf);
            deepStrictEqual(
              [fm.next_step_kind, fm.next_step_verb, fm.awaiting_owner_gate, fm.awaiting_owner_pointer?.endsWith(`#${anchor}`), fm.awaiting_owner_run_id, fm.terminal_marker === true, 'verify_request' in fm, fm.persona_operations, fm.next_action],
              ['owner-decision', undefined, gate, true, undefined, false, false, undefined, 'Owner: the judgment'],
            );
          });
        }
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const before = await readFile(wf, 'utf8');
          const refused = async (files, ownerGate, pattern, opts = {}) => {
            const tdir = await textDir(area, texts(files));
            const r = runBlock(dir, withGate(finalize(verb, { tdir, opDir, ...opts }), ownerGate), offer(sha));
            strictEqual(r.status, 1, `${pattern}: ${r.stderr}`);
            ok(pattern.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, `${pattern}: nothing was written`);
          };
          const foreign = verb === 'refine' ? 'decide-conflict' : 'recurring-finding';
          for (const g of [foreign, 'staging-set', 'peer-conflict', 'no-such-gate']) {
            await refused({}, g, new RegExp(`OWNER_GATE is ${g}, which is not a gate this verb ends on`));
          }
          // A heading indented by up to three spaces, or with more than one
          // space or a tab after its ###, is still one (CommonMark).
          for (const [heading, indent, sep] of [['Routing recommendation', '', ' '], ['Outward action needed', '', ' '], ['Routing recommendation', ' ', ' '], ['Outward action needed', '   ', ' '], ['Routing recommendation', '', '  '], ['Outward action needed', '', '\t']]) {
            await refused({ 'note.md': `### Ensemble synthesis: fixture\n\n${indent}###${sep}${heading}\n\nOwner: the judgment` }, '', /records an owner gate \(its heading\), but OWNER_GATE is empty/);
          }
          if (verb === 'critique' || verb === 'decide') {
            await refused({ 'contested.md': 'a contested item' }, 'scope-routing', /OWNER_GATE is scope-routing, but VERDICT is conflict/, { verdict: 'conflict' });
          }
        });
      });
    }

    // A stub companion that answers at once, and the real runner's dispatch,
    // as the runbook's dispatch block runs it: a completed run, pending on the
    // workflow until the finalize settles it, and the dispatch directory the
    // finalize reads it from.
    async function realRun({ dir, sha, wf, area, phase }) {
      const companions = join(area, 'companions');
      await mkdir(companions);
      await writeFile(join(companions, 'discover-peer.mjs'), 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
      await writeFile(join(companions, 'codex-companion.mjs'), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'the peer answer', exit_code: 0 }));\n");
      execFileSync('chmod', ['755', join(companions, 'codex-companion.mjs')]);
      await writeFile(join(companions, 'prompt.xml'), '<task>fixture</task>\n');
      const runId = `${phase}-20261031T010203Z-abcdef`;
      const env = { ...process.env, ...offer(sha), AGENTIC_COMPANIONS_ROOT: companions };
      const run = spawnSync('node', [P.path('scripts/peer-runner.mjs'), 'run', '--repo-root', dir, '--kind', 'ensemble',
        '--peer', 'codex', '--prompt-file', join(companions, 'prompt.xml'), '--output-format', 'json',
        '--workflow-path', wf, '--phase', phase, '--host', 'claude', '--cwd', dir,
        '--ensemble-type', phase, '--run-id', runId], { cwd: dir, encoding: 'utf8', env });
      strictEqual(run.status, 0, run.stderr);
      const ddir = await mkdtemp(join(area, 'dispatch '));
      await writeFile(join(ddir, 'prompt.xml.run.json'), run.stdout);
      ok((await front(wf)).pending_ensemble?.some((e) => e.run_id === runId), 'the run is pending');
      return { runId, ddir };
    }

    it('critique: a conflict verdict for a real completed peer run, with a request beside it, stops the block before settle', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'critique', offer(sha));
        const { ddir } = await realRun({ dir, sha, wf, area, phase: 'critique' });
        const before = await readFile(wf, 'utf8');
        const tdir = await textDir(area, texts({ 'verify-request.json': REQ, 'contested.md': 'a contested item' }));
        const b = finalize('critique', { tdir, opDir, verdict: 'conflict' }).replace("DISPATCH_DIR=''", () => `DISPATCH_DIR='${ddir}'`);
        const r = runBlock(dir, b, offer(sha));
        strictEqual(r.status, 1, r.stderr);
        ok(/but VERDICT is conflict: a conflict ends on its gate and takes no request/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before, 'nothing was written: the run is still pending, unsettled');
      });
    });

    // The verify form's usual case: a verb whose peer ran (Plan-verify,
    // Review, Refine-verify) ends with a request. The check sets aside the run
    // the block settles first, and only that one.
    for (const verb of Object.keys(VERBS)) {
      it(`${verb}: a real completed peer run with a non-conflict verdict and a request: settled, then the verify form records the request`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const { runId, ddir } = await realRun({ dir, sha, wf, area, phase: verb });
          const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
          const b = finalize(verb, { tdir, opDir, verdict: 'concerns' }).replace("DISPATCH_DIR=''", () => `DISPATCH_DIR='${ddir}'`);
          const r = runBlock(dir, b, offer(sha));
          strictEqual(r.status, 0, r.stderr);
          const fm = await front(wf);
          deepStrictEqual(
            [fm.next_step_kind, fm.verify_request?.checks, fm.pending_ensemble ?? [], fm.ensemble_results?.at(-1)?.run_id, fm.ensemble_results?.at(-1)?.verdict, fm.persona_operations, fm.terminal_marker === true],
            ['verify', REQ.checks, [], runId, 'concerns', undefined, false],
          );
        });
      });
    }

    it('Phase 0: the preflight banner says whether the run offers verification, the signal the long-check guidance names', async () => {
      await withRepo(async ({ dir, sha }) => {
        for (const verb of Object.keys(VERBS)) {
          const phase0 = blocks(section(text[verb], '## Phase 0')).map(dedent).find((b) => b.includes('autopilot-preflight'));
          ok(phase0, `${verb}: the Phase 0 preflight block`);
          const offered = runBlock(dir, phase0, offer(sha));
          strictEqual(offered.status, 0, offered.stderr);
          ok(offered.stdout.includes('This run offers verification:'), offered.stdout);
          const unoffered = runBlock(dir, phase0, { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '3' });
          strictEqual(unoffered.status, 0, unoffered.stderr);
          ok(unoffered.stdout.includes('This run does not offer verification:') && !unoffered.stdout.includes('This run offers verification'), unoffered.stdout);
          // A declaration the offer's commit does not hold is no offer.
          const undeclared = runBlock(dir, phase0, offer('f'.repeat(40)));
          ok(undeclared.stdout.includes('This run does not offer verification:'), undeclared.stdout);
          const interactive = runBlock(dir, phase0, {});
          strictEqual(interactive.status, 0, interactive.stderr);
          ok(!/This run (?:does not )?offers? verification/.test(interactive.stdout), interactive.stdout);
        }
      });
    });

    it('compose, run again with the same TEXT_DIR: the request removed, changed or added since stops the block before any write; the same request is taken again', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'compose', offer(sha));
        const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
        strictEqual(runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha)).status, 0);
        const after1 = await readFile(wf, 'utf8');
        const id1 = (await front(wf)).verify_request.id;
        const request = join(tdir, 'verify-request.json');
        const kept = await readFile(request, 'utf8');
        const again = () => runBlock(dir, finalize('compose', { tdir, opDir: '' }), offer(sha));
        await unlink(request);
        let r = again();
        strictEqual(r.status, 1, r.stderr);
        ok(/keeps another form than verify-request\.json there gives now/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), after1, 'removed: nothing was written');
        await writeFile(request, JSON.stringify({ ...REQ, checks: [REQ.checks[0]] }));
        r = again();
        strictEqual(r.status, 1, r.stderr);
        ok(/keeps another form/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), after1, 'changed: nothing was written');
        await writeFile(request, kept);
        r = again();
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual([(await front(wf)).verify_request.id, (await front(wf)).next_step_kind], [id1, 'verify'], 'the same request, taken again');
      });
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'compose', offer(sha));
        const tdir = await textDir(area, texts());
        // The verb form's last write refused (a stale operation directory), so
        // the agent runs the block again, now with a request.
        const first = runBlock(dir, finalize('compose', { tdir, opDir: join(area, 'no-such-op') }), offer(sha));
        ok(first.status !== 0, 'the first run failed at its last write');
        const before = await readFile(wf, 'utf8');
        await writeFile(join(tdir, 'verify-request.json'), JSON.stringify(REQ));
        const r = runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha));
        strictEqual(r.status, 1, r.stderr);
        ok(/keeps another form/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before, 'added: nothing was written');
      });
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'compose', offer(sha));
        const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
        // The verify form's own last write refused (a stale operation
        // directory) after settle and the note: run again with the same
        // TEXT_DIR and the right directory, it records the same request.
        const first = runBlock(dir, finalize('compose', { tdir, opDir: join(area, 'no-such-op') }), offer(sha));
        ok(first.status !== 0, 'the first run failed at its last write');
        strictEqual((await front(wf)).next_step_kind, undefined, 'no next step yet');
        const r = runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha));
        strictEqual(r.status, 0, r.stderr);
        const fm = await front(wf);
        deepStrictEqual([fm.next_step_kind, fm.verify_request.checks, fm.persona_operations], ['verify', REQ.checks, undefined]);
      });
    });

    // The form is kept just before settle, after every other check: a run one
    // of them stops keeps none, so the same TEXT_DIR takes a request added
    // since. compose renders the plain template, critique the consensus one
    // (whose contested check comes later still).
    for (const verb of ['compose', 'critique']) {
      it(`${verb}: a run a check before settle stops keeps no form, and the same TEXT_DIR then takes a request added since`, async () => {
        const stops = [[{ 'summary.txt': '   ' }, {}, /summary\.txt in TEXT_DIR .* is missing, blank or not UTF-8 text/]];
        if (verb === 'critique') stops.push([{}, { verdict: 'conflict' }, /contested\.md in TEXT_DIR .* is missing/]);
        for (const [files, opts, pattern] of stops) {
          await withRepo(async ({ dir, sha, wf, area }) => {
            const { opDir } = resume(dir, verb, offer(sha));
            const before = await readFile(wf, 'utf8');
            const tdir = await textDir(area, texts(files));
            const first = runBlock(dir, finalize(verb, { tdir, opDir, ...opts }), offer(sha));
            strictEqual(first.status, 1, first.stderr);
            ok(pattern.test(first.stderr), first.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, 'nothing was written');
            ok(!existsSync(join(tdir, 'finalize-verify.json')), 'no form was kept');
            await writeFile(join(tdir, 'summary.txt'), 'fine\n');
            await writeFile(join(tdir, 'verify-request.json'), JSON.stringify(REQ));
            const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
            strictEqual(r.status, 0, r.stderr);
            deepStrictEqual([(await front(wf)).next_step_kind, (await front(wf)).verify_request.checks], ['verify', REQ.checks]);
          });
        }
      });
    }
  });

  // The driver's records, as the driver writes them (owner writes: no
  // AGENTIC_* variable in this process).
  const resolved = (request) => request.checks.map((c, i) => ({ index: i, kind: c.kind, origin: 'worker', argv: V.resolveCheck(decl, c) }));
  // `added`: a check the driver added to the request's (origin driver);
  // `noLog`: the first result keeps no log.
  async function driverBatch(wf, { tree, outcome, pass = false, added = false, noLog = false }) {
    const fm = await front(wf);
    const request = fm.verify_request;
    const checks = resolved(request);
    if (added) checks.push({ index: checks.length, kind: 'test-suite', origin: 'driver', argv: V.resolveCheck(decl, { kind: 'test-suite', args: {} }) });
    await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: request.id, input: {
      batch_id: 'b1', run_id: RUN, continues: null, tree_start: tree, declaration_commit: request.baseline, declaration_digest: decl.digest,
      checks, checks_digest: V.checksDigest(checks.map((c) => c.argv)), started_at: '2026-10-31T01:00:00Z',
    } });
    const result = (index, failed) => ({
      index, outcome: failed ? 'failed' : 'passed', exit: failed ? 1 : 0, signal: null, duration_ms: 5,
      failing_tests: failed ? ['suite > the changed case fails'] : [], failing_tests_more: 0, log: noLog && index === 0 ? null : `verify/b1/${index}.log`, ended_at: '2026-10-31T01:01:00Z',
    });
    await S.recordResult({ workflowPath: wf, host: 'claude', requestId: request.id, batchId: 'b1', input: result(0, outcome === 'failed') });
    if (outcome === 'passed') await S.recordResult({ workflowPath: wf, host: 'claude', requestId: request.id, batchId: 'b1', input: result(1, false) });
    await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: request.id, batchId: 'b1', input: { tree_end: tree, end: outcome, cause: null, ended_at: '2026-10-31T01:02:00Z' } });
    if (pass) await S.recordPass({ workflowPath: wf, host: 'claude', requestId: request.id, batchId: 'b1' });
  }
  async function requested(dir, sha, area, wf) {
    const { opDir } = resume(dir, 'compose', offer(sha));
    const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
    const r = runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha));
    strictEqual(r.status, 0, r.stderr);
    strictEqual((await front(wf)).next_step_kind, 'verify');
  }

  describe(`${persona}: a verb's resume prints the results the verification step recorded`, () => {
    it('a failed batch: the resumed verb (compose) reads the failing test, its log, and that it applies to the tree now', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        await requested(dir, sha, area, wf);
        await driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        const r = resume(dir, 'compose', offer(sha, '4'));
        ok(/Verification request [0-9a-f]+ \(step 3 of run autopilot-/.test(r.stdout), r.stdout);
        ok(r.stdout.includes('- Batch b1: ended failed.'), r.stdout);
        ok(/1\. test \[worker\] npm test -- tests\/a\.mjs: failed \(exit 1\); evidence yes; applies to the tree now: yes\./.test(r.stdout), r.stdout);
        ok(r.stdout.includes('failing: suite > the changed case fails'), r.stdout);
        ok(r.stdout.includes(`log: .agentic-plugins/runs/autopilot/${RUN}/verify/b1/0.log`), r.stdout);
        ok(/2\. mutate \[worker\] npm run mutate -- scripts\/mutation-specs\/s\.mjs --only S1: not run/.test(r.stdout), r.stdout);
      });
    });

    it('a passed batch: on_pass critique reads the results as applying; once the tree changed, as not applying', async () => {
      for (const changed of [false, true]) {
        await withRepo(async ({ dir, sha, wf, area }) => {
          await requested(dir, sha, area, wf);
          await driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'passed', pass: true });
          deepStrictEqual([(await front(wf)).next_step_kind, (await front(wf)).next_step_verb], ['verb', 'critique']);
          if (changed) await writeFile(join(dir, 'tests/a.mjs'), '// edited since the batch\n');
          const r = resume(dir, 'critique', offer(sha, '4'));
          ok(/answered by batch b1, which passed/.test(r.stdout), r.stdout);
          ok(new RegExp(`1\\. test \\[worker\\] [^\\n]*: passed \\(exit 0\\); evidence yes; applies to the tree now: ${changed ? 'no' : 'yes'}\\.`).test(r.stdout), r.stdout);
        });
      }
    });

    it('the header counts the checks requested and those the driver added apart; a result with no log says so, never a path ending /null', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        await requested(dir, sha, area, wf);
        await driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed', added: true, noLog: true });
        const r = resume(dir, 'compose', offer(sha, '4'));
        ok(/\(step 3 of run [^;]+; 2 check\(s\) requested, 1 added by the driver; on_pass verb critique\)/.test(r.stdout), r.stdout);
        ok(/3\. test-suite \[driver\] /.test(r.stdout), r.stdout);
        ok(r.stdout.includes('log: none was kept for this check'), r.stdout);
        ok(!/\/null\b/.test(r.stdout), r.stdout);
      });
      await withRepo(async ({ dir, sha, wf, area }) => {
        await requested(dir, sha, area, wf);
        await driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        const r = resume(dir, 'compose', offer(sha, '4'));
        ok(/; 2 check\(s\) requested; on_pass /.test(r.stdout), r.stdout);
      });
    });

    it('verify-results reads --current-tree as true or false and refuses any other word', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        await requested(dir, sha, area, wf);
        await driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        const run = (v) => spawnSync('node', [STATE, 'verify-results', '--workflow-path', wf, '--current-tree', v], { cwd: dir, encoding: 'utf8' });
        strictEqual(JSON.parse(run('true').stdout).tree_digest, S.currentTreeDigest(dir));
        const no = run('false');
        strictEqual(no.status, 0, no.stderr);
        ok(!('tree_digest' in JSON.parse(no.stdout)), no.stdout);
        for (const word of ['yes', '1', 'TRUE']) {
          const r = run(word);
          ok(r.status !== 0, `${word}: refused`);
          ok(/--current-tree is true or false/.test(r.stderr), r.stderr);
        }
      });
    });

    it('no request: the resume prints nothing of it', async () => {
      await withRepo(async ({ dir, sha }) => {
        const r = resume(dir, 'refine', offer(sha));
        ok(!/Verification request|could not be read/.test(r.stdout + r.stderr), r.stdout + r.stderr);
      });
    });

    it('a results record a later release wrote: a warning, and the verb goes on', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        await requested(dir, sha, area, wf);
        await driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        // A later release's results record (a higher v), carried as written.
        const raw = await readFile(wf, 'utf8');
        const line = raw.match(/^verify_results: (".*")$/m);
        ok(line, 'the results scalar');
        const newer = { ...JSON.parse(JSON.parse(line[1])), v: 2 };
        await writeFile(wf, raw.replace(line[0], () => `verify_results: ${JSON.stringify(JSON.stringify(newer))}`));
        const r = resume(dir, 'refine', {});
        ok(/verify_results \(v 2\) was written by a later release/.test(r.stderr), r.stderr);
        ok(r.stderr.includes('⚠ The verification results could not be read'), r.stderr);
      });
    });
  });

  describe(`${persona}: the tree digest a result applies to is the driver's`, () => {
    it('staged, unstaged, untracked, assume-unchanged and skip-worktree changes, and the lock fence, digest alike; each change moves it', async () => {
      await withRepo(async ({ dir }) => {
        const same = () => {
          const mine = S.currentTreeDigest(dir);
          strictEqual(mine, driverTreeDigest(dir).digest);
          return mine;
        };
        const seen = new Set([same()]);
        const step = async (fn) => { await fn(); const d = same(); ok(!seen.has(d), 'the change moves the digest'); seen.add(d); };
        await step(() => writeFile(join(dir, 'tests/a.mjs'), '// unstaged\n'));
        await step(async () => { await writeFile(join(dir, 'tests/b.mjs'), '// staged\n'); git(dir, 'add', 'tests/b.mjs'); });
        await step(() => writeFile(join(dir, 'untracked.txt'), 'u\n'));
        await step(async () => { git(dir, 'update-index', '--assume-unchanged', 'notes.txt'); await writeFile(join(dir, 'notes.txt'), 'hidden\n'); });
        await step(async () => { git(dir, 'update-index', '--skip-worktree', 'scripts/mutation-specs/s.mjs'); await writeFile(join(dir, 'scripts/mutation-specs/s.mjs'), '// skipped\n'); });
        // The lock fence is the driver's bookkeeping: it moves neither.
        const before = same();
        const fence = join(dir, '.agentic-plugins/runs/autopilot/worktree.lock');
        await mkdir(join(fence, '..'), { recursive: true });
        await writeFile(fence, 'lock\n');
        git(dir, 'add', '-f', fence);
        strictEqual(same(), before, 'the lock fence moves no digest');
        ok(existsSync(fence));
      });
    });
  });
}

// The prose an LLM step follows: under an offering run the worker's own step
// runs no whole suite and no mutation run. The rendered runbooks and skills of
// compose, refine and critique route every instruction to run a suite through
// the long-check guidance.
describe('the long-check guidance (ADR-0068 Decision 5, item 1)', () => {
  const RUN_SUITE = /\b[Rr]un (?:the )?(?:relevant |full |whole )?test suite\b/;
  for (const persona of PERSONAS.filter((p) => personaInfo(p).capabilities.dispatch_target === true)) {
    const P = personaInfo(persona);
    for (const rel of ['commands/compose.md', 'commands/refine.md', 'commands/critique.md', 'core/skills/compose/SKILL.md', 'core/skills/refine/SKILL.md', 'core/skills/critique/SKILL.md']) {
      it(`${persona}/${rel}: carries the guidance, and no instruction to run the suite bypasses it`, () => {
        const t = readFileSync(P.path(rel), 'utf8');
        ok(/<!-- pipeline:begin [a-z]+-long-checks -->/.test(t), 'the long-check region');
        ok(/never wait(?:s)? for the heavy-work lock/.test(t.replace(/\s+/g, ' ')), 'under the offer, no wait for the heavy-work lock');
        ok(/agentic-autopilot heavy --/.test(t), 'interactively, the heavy-work lock wrapper');
        const outside = t.replace(/<!-- pipeline:begin [a-z]+-long-checks -->[\s\S]*?<!-- pipeline:end [a-z]+-long-checks -->/g, '');
        for (const line of outside.split('\n').filter((l) => RUN_SUITE.test(l))) {
          ok(/long[- ]checks?/i.test(line), `an instruction to run the suite that does not route through the long-check guidance: ${line.trim()}`);
        }
      });
    }
    // The verify form renders in every verb's finalize, decide, frame and
    // investigate included, which carry no guidance of their own: it points
    // at runbooks that do.
    it(`${persona}: every runbook rendering the verify form points at long-check guidance that runbook can reach`, () => {
      const commands = ['compose', 'refine', 'critique', 'decide', 'frame', 'investigate'];
      let forms = 0;
      for (const verb of commands) {
        const t = readFileSync(P.path(`commands/${verb}.md`), 'utf8');
        if (!t.includes('**The verify form**')) continue;
        forms += 1;
        const named = t.replace(/\s+/g, ' ').match(/\(§ Long checks in ([^)]*?) says which are long\)/);
        ok(named, `${verb}: the verify form names where the long-check guidance is`);
        const targets = [...named[1].matchAll(new RegExp(`\`/${persona}:([a-z]+)\``, 'g'))].map((m) => m[1]);
        ok(targets.length > 0, `${verb}: it names runbooks: ${named[1]}`);
        for (const target of targets) {
          ok(/<!-- pipeline:begin [a-z]+-long-checks -->\n### Long checks/.test(readFileSync(P.path(`commands/${target}.md`), 'utf8')), `${verb}: /${persona}:${target} carries § Long checks`);
        }
      }
      strictEqual(forms, commands.length, 'every verb renders the verify form');
    });
  }
});
