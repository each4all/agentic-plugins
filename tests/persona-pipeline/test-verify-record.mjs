// scripts/state.mjs — the persona's half of ADR-0068 Decision 5
// (`verify-record-cli`): the request a step records with the next step
// `verify`, and the batches of results the driver records against it.
//
// Covers, for every persona the pipeline generates state.mjs into:
//   - the wire form: two flat JSON scalars that round-trip, the cross-key
//     rules the parser holds, records of a later release (a higher `v`)
//     carried as written and refused only by the verify commands, and a
//     reader without the keys carrying them byte for byte once the next step
//     is no longer `verify`;
//   - finish-verb --next-step-kind verify: refused interactively, on Codex,
//     for a persona with dispatch_target off, with each part of the offer
//     missing or malformed, with no declaration at the baseline, from another
//     repository or branch, for a path argument that is not a file of the
//     tree, not in the alphabet or begins with `-`; and by every other writer;
//     accepted under the offer, a retry keeping the id and recorded_at, a new
//     request dropping the old results into `previous`, another kind dropping
//     both keys, Phase 0's clear keeping them and ending what may be written;
//     a stale attempt (an older step, a step of an earlier run, or a step
//     whose request was taken up, answered or dropped) refused through the
//     attempt mark, which outlives the request and which every write of the
//     handoff under the offer is held to and moves on, whatever its kind;
//     a request recorded only by the workflow holding it (a moved record does
//     not read); a confidence-only retry a new request; a check resolving to a word longer than a batch
//     runs refused; the declaration read with no replace ref and no
//     inherited GIT_* variable; a hand-written request with an option for an
//     argument refused by the parser;
//   - the driver's commands: each refusal and invariant, identical replays as
//     no-ops (after the end too) and different records refused, two processes
//     recording one result, the byte budget (a continuation after a cut, and
//     a chain of them at the boundary, included), evidence against applies,
//     the recorder of each result, and
//     verify-pass handing `done` to the commit surface's close;
//   - a batch is the request's: its worker checks run the request's commands
//     as the declaration it names resolves them; a first batch continues
//     nothing, and a later one only the latest batch, cut short (only a
//     stopped check, or none yet, is cut short); a continuation on the same
//     tree and commands carries the passed results it goes on from, and
//     retention keeps only the batch it continues;
//   - every id a record holds is a string before it is matched (an array,
//     nested to any depth, is refused at each id field);
//   - a step's late write is held to the handoff it last left (the next step,
//     the phase, the verb, the terminal marker, the owner gate, the pending
//     peer runs, the request and its results) and to its generation: any
//     change since, by any writer, makes it record nothing, even one undone
//     since (A to B and back to A, the owner's or a newer run's). The driver's
//     batch start, restart and pass, mid-batch or after the pass; the owner's
//     Phase 0 clear, append, finish-verb or set-terminal; a later step's write
//     that sets no next step (Phase 7's begin-commit and commit-complete); a
//     run's whose driver numbers no step (an earlier release), which orders
//     runs both ways and records its run on its first write, one that changes
//     nothing included; and a writer that does not know the mark (an older
//     release), each handoff key edited alone, a gate replaced, the verb
//     changed in the same phase and a pending run included. Every write of an
//     earlier step or run is refused, one that changes nothing included (a
//     next action, a critique-run marker, a gate, a begin-commit, a pending
//     run). The step's own consecutive writes are taken, its peer run's
//     dispatch and settle included, and a write that leaves the handoff alone
//     moves no generation and stales nothing. The one limit, earlier
//     releases: an A to B and back to A by a writer that keeps no generation
//     is not seen;
//   - every write of a workflow is held at its lock, no writer listed: an
//     earlier step's delayed checkpoint, manifest entry, snapshot, writeback
//     marker, detach and archive record nothing, and the step's own after
//     another writer's change neither; a newer run's first checkpoint records
//     its mark. The driver numbers every step, offered verification or not,
//     so a step of a run that offers none is bound to the handoff it left:
//     Codex's sequence (the step's refine, the owner's done, the step's
//     delayed commit) records nothing, and the operator's recovery (a gate
//     cleared while the run is live; a note alone changes no handoff) leaves
//     the run's next step free to write. A step with no number writes nothing beside a
//     numbered step of its own run, and no step of any run writes beside a
//     later release's record;
//   - a workflow an interactive verb left with the terminal marker, resumed
//     into a non-terminal phase, records a request (the phase says whether it
//     is terminal), and one still in its terminal phase does not;
//   - verify-batch-restart sets aside each record the driver cannot trust (a
//     foreign batch cut short, ended or open, a carried result, a result in
//     its own batch, a batch dated 2099, a record over the budget), and the
//     request runs whole; a stale or evicted replay records nothing;
//   - a write beside the workflow moves the mark on before it lands: a
//     non-document critique-scope that moves a ledger aside, and a task file
//     whose publication fails, leave the mark on their step; a creation is
//     admitted against the workflows archived on its branch (an owner's A to
//     B and back to A included), reading the frontmatter of a record whose
//     first read opens an LF one, up to the parser's close delimiter (a FIFO
//     there refuses it at once, such a record's long body is never read
//     whole, a CRLF record or a note is read whole, and a mark at any line
//     start in it counts, with no branch read from its body; a U+2028 or
//     U+2029 starts no line; a record swapped between the two reads is
//     judged alone, and every descriptor is closed), and commits only
//     while it holds every creation lock it took (a reclaimed repository lock
//     under shared creation, beside its one-lock control); an archive whose
//     source lock was reclaimed,
//     or whose bytes changed, refuses and leaves both files as they are, at
//     its mark write and at its destination's publication too (a change made
//     after its first check is never overwritten, and no stale archive is
//     left when it is stopped before it could take one back);
//   - the fixtures' git runs with no inherited GIT_* variable: a planted
//     GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE reach no other repository;
//     and their owner writes run with no inherited AGENTIC_* variable: under a
//     planted autopilot session the owner-write probe passes, and fails in the
//     control that keeps it.
//
// The tests read no AGENTIC_* variable of their own: every inherited one is
// dropped at load (./_drop-session.mjs), so a run with `node --test` from an
// autopilot step tests the fixtures, as `npm test` does. Every inherited
// GIT_* variable is dropped from process.env at load, as
// tests/orchestrator/fixtures/autopilot-repo.mjs does: the state helpers this
// process calls in place run git with it.
//
// Run via `npm test -- tests/persona-pipeline/test-verify-record.mjs`.

import { PLANTED_SESSION, runPlanted } from './_drop-session.mjs';
import { after, describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { personaInfo, personasFor, REPO_ROOT } from './_personas.mjs';

const RUN = 'autopilot-20261020T010203Z-abcdef';
// The module object the state helpers' named imports are bound to: a test
// that injects a change at one of their reads or writes replaces a function
// here and calls syncBuiltinESMExports, then puts it back.
const fsp = createRequire(import.meta.url)('node:fs/promises');
const DECLARATION = readFileSync(join(REPO_ROOT, '.agentic-plugins/verify-checks.json'), 'utf8');
const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);
const REQ = Object.freeze({
  checks: [{ kind: 'test', args: { files: ['tests/a.mjs'] } }, { kind: 'lint-plugin-shape' }],
  on_pass: { kind: 'commit', confidence: 'HIGH' },
  confidence: 'HIGH',
});
const iso = (s) => `2026-10-20T01:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}Z`;

// No inherited GIT_* variable (a hook's GIT_DIR, GIT_WORK_TREE or
// GIT_INDEX_FILE) reaches git: `-C` does not override GIT_DIR, so a fixture
// would commit into the caller's repository. The fixtures' own git drops them
// at each call too, so one planted later reaches nothing.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() }).trim();

async function makeRepo({ declaration = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-record-'));
  git(dir, 'init', '-q', '-b', 'feat/x');
  await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
  for (const f of ['tests/a.mjs', 'tests/b.mjs', 'scripts/mutation-specs/s.mjs']) {
    await mkdir(join(dir, f, '..'), { recursive: true });
    await writeFile(join(dir, f), '// fixture\n');
  }
  if (declaration) {
    await mkdir(join(dir, '.agentic-plugins'), { recursive: true });
    await writeFile(join(dir, '.agentic-plugins/verify-checks.json'), DECLARATION);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

for (const persona of personasFor('scripts/state.mjs')) {
  const P = personaInfo(persona);
  const STATE_PATH = P.path('scripts/state.mjs');
  const S = await import(pathToFileURL(STATE_PATH).href);
  const V = await import(pathToFileURL(P.path('scripts/lib/verify.mjs')).href);
  const decl = V.parseDeclaration(DECLARATION);
  const offered = P.capabilities.dispatch_target === true;
  const offerEnv = (sha, extra = {}) => ({ AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_AUTOPILOT_STEP: '3', ...extra });

  const repos = [];
  after(() => Promise.all(repos.map((d) => rm(d, { recursive: true, force: true }))));
  async function withWorkflow(fn, opts) {
    const { dir, sha } = await makeRepo(opts);
    repos.push(dir);
    const { filePath } = await S.createWorkflow({
      repoRoot: dir, verb: 'compose', host: 'claude',
      gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' },
      originalRequest: 'verify record', currentPhase: 'phase-0-bootstrap',
    });
    return fn({ wf: filePath, dir, sha });
  }

  const finish = (wf, dir, sha, input = REQ, { env = offerEnv(sha), now, host = 'claude', cwd = dir } = {}) => S.finishVerb({
    workflowPath: wf, host, nextAction: 'Verify the change',
    nextStep: { kind: 'verify', confidence: input.confidence ?? 'HIGH' }, verifyRequest: input, env, cwd, now,
  });

  const argvOf = (checks) => checks.map((c) => V.resolveCheck(decl, c));
  function startInput(request, { batch = 'b1', tree = T1, continues = null, extra = [], extraKind = 'test', at = iso(0), checks: given } = {}) {
    const checks = given ?? [
      ...argvOf(request.checks).map((argv, i) => ({ index: i, kind: request.checks[i].kind, origin: 'worker', argv })),
      ...extra.map((argv, j) => ({ index: request.checks.length + j, kind: extraKind, origin: 'driver', argv })),
    ];
    return {
      batch_id: batch, run_id: RUN, continues, tree_start: tree,
      declaration_commit: request.baseline, declaration_digest: decl.digest,
      checks, checks_digest: V.checksDigest(checks.map((c) => c.argv)), started_at: at,
    };
  }
  const passed = (index, at = iso(10 + index)) => ({ index, outcome: 'passed', exit: 0, signal: null, duration_ms: 5, failing_tests: [], failing_tests_more: 0, log: `verify/b/${index}.log`, ended_at: at });
  const failed = (index, names = ['suite > it fails']) => ({ ...passed(index), outcome: 'failed', exit: 1, failing_tests: names });
  const stopped = (index) => ({ ...passed(index), outcome: 'stopped', exit: null, signal: 'SIGTERM' });
  const ended = (end, { tree = T1, cause = null, at = iso(50) } = {}) => ({ tree_end: tree, end, cause, ended_at: at });

  const read = async (wf) => (await S.readWorkflow(wf)).frontmatter;
  const ids = (wf) => read(wf).then((fm) => ({ request: fm.verify_request?.id, kind: fm.next_step_kind }));
  // The attempt mark, its handoff digest and generation read as `current`:
  // whether the record still holds the handoff the step it names last left, at
  // the generation it left it.
  const markOf = async (wf) => {
    const fm = await read(wf);
    ok('verify_attempt' in fm, 'the workflow holds an attempt mark');
    const { handoff, generation, ...mark } = fm.verify_attempt;
    const now = V.handoffState(fm);
    return { ...mark, current: handoff === now.digest && generation === now.generation };
  };

  async function batch(wf, id, { results = [], end = null, ...start } = {}) {
    const fm = await read(wf);
    await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, input: startInput(fm.verify_request, { batch: id, ...start }) });
    for (const r of results) await S.recordResult({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, batchId: id, input: r });
    if (end) await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, batchId: id, input: end });
    return fm.verify_request.id;
  }

  describe(`${persona}: next step verify is written only where a driver will run it (Decision 5, item 11)`, () => {
    it('every reader accepts the kind', () => {
      ok(S.VALID_NEXT_STEP_KINDS.has('verify'));
    });

    if (!offered) {
      it('a persona with dispatch_target off is never offered verification, so it never writes verify', async () => {
        await withWorkflow(async ({ wf, dir, sha }) => {
          const before = await readFile(wf, 'utf8');
          await rejects(finish(wf, dir, sha), /next step verify is refused: missing .*not an autopilot dispatch target/);
          strictEqual(S.verifyOffer({ env: offerEnv(sha), cwd: dir }).on, false);
          strictEqual(await readFile(wf, 'utf8'), before);
        });
      });
      return;
    }

    it('refused interactively, on Codex, and with each part of the offer missing or malformed, writing nothing', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const before = await readFile(wf, 'utf8');
        const cases = [
          [{}, /missing an autopilot run/],
          [{ AGENTIC_AUTOPILOT: 'autopilot-x', AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_AUTOPILOT_STEP: '3' }, /missing an autopilot run/],
          [offerEnv(sha, { AGENTIC_AUTOPILOT_VERIFY: undefined }), /AGENTIC_AUTOPILOT_VERIFY.*does not offer verification/],
          [offerEnv(sha, { AGENTIC_AUTOPILOT_VERIFY: sha.slice(1) }), /AGENTIC_AUTOPILOT_VERIFY/],
          [offerEnv(sha, { AGENTIC_AUTOPILOT_VERIFY: sha.toUpperCase() }), /AGENTIC_AUTOPILOT_VERIFY/],
          [offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: undefined }), /AGENTIC_AUTOPILOT_STEP/],
          [offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '0' }), /AGENTIC_AUTOPILOT_STEP/],
          [offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '3x' }), /AGENTIC_AUTOPILOT_STEP/],
          [offerEnv('f'.repeat(40)), /declaration \(\.agentic-plugins\/verify-checks\.json\) at f{40}/],
        ];
        for (const [env, pattern] of cases) {
          const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
          await rejects(finish(wf, dir, sha, REQ, { env: clean }), pattern, JSON.stringify(env));
        }
        await rejects(finish(wf, dir, sha, REQ, { host: 'codex' }), /Claude-only/);
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('the offer is off on Codex, and for a commit that is not 40 hex, with every other part of it present', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        // Control: the full offer is on.
        strictEqual(S.verifyOffer({ env: offerEnv(sha), cwd: dir }).on, true);
        // Each input below is one git resolves, or a run no other rule
        // refuses: only the offer's own check turns it off.
        strictEqual(S.verifyOffer({ env: offerEnv(sha), host: 'codex', cwd: dir }).on, false);
        strictEqual(S.verifyOffer({ env: offerEnv(sha.slice(0, 12)), cwd: dir }).on, false);
        strictEqual(S.verifyOffer({ env: offerEnv('HEAD'), cwd: dir }).on, false);
        ok(git(dir, 'show', `${sha.slice(0, 12)}:.agentic-plugins/verify-checks.json`).includes('agentic-verify-checks-1.0'), 'git reads the declaration at the short commit');
        strictEqual(S.verifyAttemptOf({ env: offerEnv(sha), host: 'codex' }), null);
        // A run whose offer is malformed offers none, and its steps are
        // numbered all the same: the driver numbers every step it starts. A
        // driver of an earlier release numbers none.
        deepStrictEqual(S.verifyAttemptOf({ env: offerEnv(sha.slice(0, 12)) }), { run_id: RUN, step: 3 });
        deepStrictEqual(S.verifyAttemptOf({ env: { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '3' } }), { run_id: RUN, step: 3 });
        deepStrictEqual(S.verifyAttemptOf({ env: { AGENTIC_AUTOPILOT: RUN } }), { run_id: RUN });
        deepStrictEqual(S.verifyAttemptOf({ env: offerEnv(sha) }), { run_id: RUN, step: 3 });
      });
    });

    it('refused with no declaration at the run\'s baseline commit', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await rejects(finish(wf, dir, sha), /declaration \(\.agentic-plugins\/verify-checks\.json\) at [0-9a-f]{40}/);
      }, { declaration: false });
    });

    it('refused from another repository, and from a checkout on another branch', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const other = await makeRepo();
        repos.push(other.dir);
        // The offer names the other repository's own commit, so its
        // declaration reads there and only the checkout rule refuses.
        await rejects(finish(wf, dir, sha, REQ, { cwd: other.dir, env: offerEnv(other.sha) }), /is not a checkout of the repository that holds/);
        const lane = join(other.dir, '..', `${persona}-lane-${Date.now()}`);
        repos.push(lane);
        git(dir, 'worktree', 'add', '-q', '-b', 'feat/y', lane);
        await rejects(finish(wf, dir, sha, REQ, { cwd: lane }), /is on "feat\/y", not the workflow's branch "feat\/x"/);
      });
    });

    it('refused for an argument that is not a file of the tree, not in the alphabet, or begins with -', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const before = await readFile(wf, 'utf8');
        const withFile = (f) => ({ ...REQ, checks: [{ kind: 'test', args: { files: [f] } }] });
        await rejects(finish(wf, dir, sha, withFile('tests/gone.mjs')), /names no file in the tested tree/);
        await rejects(finish(wf, dir, sha, withFile('tests/a;b.mjs')), /outside \[A-Za-z0-9\._\/-\]/);
        await rejects(finish(wf, dir, sha, withFile('-tests/a.mjs')), /begins with -/);
        await rejects(finish(wf, dir, sha, { ...REQ, checks: [{ kind: 'rm-rf' }] }), /check kind "rm-rf" is not declared/);
        await rejects(finish(wf, dir, sha, { ...REQ, on_pass: { kind: 'verify', confidence: 'HIGH' } }), /on_pass\.kind is not one of verb, commit, done/);
        await rejects(finish(wf, dir, sha, { ...REQ, on_pass: { kind: 'owner-decision', confidence: 'HIGH' } }), /on_pass\.kind/);
        // An uncommitted, untracked file of the tree counts.
        await writeFile(join(dir, 'tests/new.mjs'), '// new\n');
        await finish(wf, dir, sha, withFile('tests/new.mjs'));
        ok(before !== await readFile(wf, 'utf8'));
      });
    });

    it('refused by every other writer: append, set-terminal and awaiting-owner-clear', async () => {
      await withWorkflow(async ({ wf }) => {
        const ns = { kind: 'verify', confidence: 'HIGH' };
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: ns }), /written only by finish-verb --verify-request-file/);
        await rejects(S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', nextStep: ns }), /written only by finish-verb/);
        await S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', anchor: 'routing' });
        await rejects(S.clearAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', nextStep: ns, env: {} }), /written only by finish-verb/);
        // And a request goes with verify only.
        await rejects(S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'x', nextStep: { kind: 'commit', confidence: 'HIGH' }, verifyRequest: REQ, env: {} }), /a request file goes with the next step verify/);
        await rejects(S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'x', nextStep: ns, env: {} }), /takes the request as --verify-request-file/);
      });
    });

    it('refused while an owner gate is set or a peer ensemble is pending', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', anchor: 'routing' });
        await rejects(finish(wf, dir, sha), /owner gate scope-routing is set/);
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'compose', ensemble_type: 'plan-verify', run_id: 'r1', started_at: '2026-10-20T01:00:00Z' });
        await rejects(finish(wf, dir, sha), /a peer ensemble is still pending \(r1\)/);
      });
    });

    it('accepted under the offer: the request, bound to the run, step, baseline and declaration, with the next step verify', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const r = await finish(wf, dir, sha, REQ, { now: new Date('2026-10-20T01:00:00Z') });
        strictEqual(r.terminal, false);
        const fm = await read(wf);
        strictEqual(fm.next_step_kind, 'verify');
        strictEqual(fm.next_step_confidence, 'HIGH');
        ok(!('next_step_verb' in fm));
        ok(fm.terminal_marker !== true);
        strictEqual(fm.host_history.at(-1).event, 'updated');
        const q = fm.verify_request;
        deepStrictEqual(
          { run: q.run_id, step: q.step, baseline: q.baseline, decl: q.declaration_digest, wf: q.workflow_id, at: q.recorded_at, previous: q.previous },
          { run: RUN, step: 3, baseline: sha, decl: decl.digest, wf: fm.workflow_id, at: '2026-10-20T01:00:00Z', previous: null },
        );
        deepStrictEqual(q.checks, [{ kind: 'test', args: { files: ['tests/a.mjs'] } }, { kind: 'lint-plugin-shape', args: {} }]);
        strictEqual(q.id, V.requestId(q));
        ok(!('verify_results' in fm));
      });
    });

    it('the CLI: finish-verb --verify-request-file, refused without the offer, writing nothing', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const file = join(dir, '..', `${persona}-${Date.now()}-req.json`);
        repos.push(file);
        await writeFile(file, JSON.stringify(REQ));
        const args = ['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Verify',
          '--next-step-kind', 'verify', '--next-step-confidence', 'HIGH', '--verify-request-file', file];
        const plain = spawnSync(process.execPath, [STATE_PATH, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env } });
        strictEqual(plain.status, 1);
        ok(plain.stderr.includes('next step verify is refused'), plain.stderr);
        const ok1 = spawnSync(process.execPath, [STATE_PATH, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...offerEnv(sha) } });
        strictEqual(ok1.status, 0, ok1.stderr);
        strictEqual((await read(wf)).next_step_kind, 'verify');
        const cap = spawnSync(process.execPath, [STATE_PATH, 'verify-capability'], { encoding: 'utf8' });
        deepStrictEqual(JSON.parse(cap.stdout), { capability: 'verify-record-1', slot_types: ['path', 'id'], declaration: '.agentic-plugins/verify-checks.json' });
      });
    });
  });

  if (!offered) continue;

  describe(`${persona}: the request's identity and replacement (Decision 5, item 7)`, () => {
    it('a retry of the same request keeps its id and recorded_at', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha, REQ, { now: new Date('2026-10-20T01:00:00Z') });
        const first = (await read(wf)).verify_request;
        const r = await finish(wf, dir, sha, REQ, { now: new Date('2026-10-20T02:00:00Z') });
        strictEqual(r.retried, true);
        deepStrictEqual((await read(wf)).verify_request, first);
      });
    });

    it('a stale attempt records nothing: an older step, or the same step once its request was taken up or answered', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const at = (n) => ({ env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: String(n) }) });
        await finish(wf, dir, sha, REQ, at(3));
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        // The same step's late retry after the verb's Phase 0 took it up: the
        // handoff it left is gone, whatever the request.
        const cleared = await readFile(wf, 'utf8');
        await rejects(finish(wf, dir, sha, REQ, at(3)), /the handoff changed since step 3 last wrote it/);
        strictEqual(await readFile(wf, 'utf8'), cleared, 'the driver\'s writes stay closed');
        const other = { ...REQ, checks: [{ kind: 'test', args: { files: ['tests/b.mjs'] } }] };
        await rejects(finish(wf, dir, sha, other, at(3)), /the handoff changed since step 3 last wrote it/);
        await finish(wf, dir, sha, other, at(5));
        const five = (await read(wf)).verify_request;
        await rejects(finish(wf, dir, sha, REQ, at(3)), /step 3 is older than step 5, which last wrote the handoff: a stale attempt records nothing/);
        deepStrictEqual((await read(wf)).verify_request, five);
        // A step may change its mind while its request is pending.
        await finish(wf, dir, sha, REQ, at(5));
        ok((await read(wf)).verify_request.id !== five.id);
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [passed(0), passed(1)], end: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' });
        await rejects(finish(wf, dir, sha), /the handoff changed since step 3 last wrote it/);
        strictEqual((await read(wf)).next_step_kind, 'commit');
      });
      // The request gone (a verb ended with another next step), the mark
      // still refuses its late retry, and an older step's.
      await withWorkflow(async ({ wf, dir, sha }) => {
        const at = (n) => ({ env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: String(n) }) });
        await finish(wf, dir, sha, REQ, at(4));
        await S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env: { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '5' }, cwd: dir });
        const dropped = await readFile(wf, 'utf8');
        // Step 5, which the run does not offer verification, wrote that next
        // step: the mark moves on to it, with no request.
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 5, requested: false, current: true });
        await rejects(finish(wf, dir, sha, REQ, at(4)), /step 4 is older than step 5/);
        await rejects(finish(wf, dir, sha, REQ, at(2)), /step 2 is older than step 5/);
        strictEqual(await readFile(wf, 'utf8'), dropped, 'the commit handoff stands');
        // A later step, and a new run's first step, record requests of their own.
        await finish(wf, dir, sha, REQ, at(6));
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        await finish(wf, dir, sha, REQ, { env: offerEnv(sha, { AGENTIC_AUTOPILOT: 'autopilot-20261021T000000Z-fedcba', AGENTIC_AUTOPILOT_STEP: '1' }) });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: 'autopilot-20261021T000000Z-fedcba', step: 1, requested: true, current: true });
      });
    });

    it('every write of the next step under the offer is held to the mark: a stale verb ending with another kind, a stale Phase 0, and a verify write after a later handoff', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const env = (n) => offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: String(n) });
        const commit = (n) => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env: env(n), cwd: dir });
        await finish(wf, dir, sha, REQ, { env: env(5) });
        await batch(wf, 'b1', { results: [passed(0)] });
        const five = await readFile(wf, 'utf8');
        // A replayed step 3 that ends with commit, its Phase 0, and its
        // terminal write: none deletes step 5's request and results.
        await rejects(commit(3), /step 3 is older than step 5, which last wrote the handoff/);
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: env(3) }), /step 3 is older than step 5/);
        await rejects(S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', nextStep: { kind: 'done', confidence: 'HIGH' }, env: env(3) }), /step 3 is older than step 5/);
        strictEqual(await readFile(wf, 'utf8'), five, 'step 5\'s request and results stand');
        // Step 7 ends with commit: the mark moves on, with no request.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: env(7) });
        await commit(7);
        const seven = await readFile(wf, 'utf8');
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 7, requested: false, current: true });
        strictEqual((await read(wf)).next_step_kind, 'commit');
        // A delayed verify write of step 6, which never recorded a request,
        // does not replace step 7's commit handoff.
        await rejects(finish(wf, dir, sha, REQ, { env: env(6) }), /step 6 is older than step 7, which last wrote the handoff/);
        strictEqual(await readFile(wf, 'utf8'), seven, 'the commit handoff stands');
        // A step that cleared its own next step at Phase 0 records a request.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: env(8) });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 8, requested: false, current: true });
        await finish(wf, dir, sha, REQ, { env: env(8) });
        deepStrictEqual([(await read(wf)).next_step_kind, (await read(wf)).verify_attempt.requested], ['verify', true]);
        // Outside any run a write is not held to the mark and does not move
        // it on: the record no longer holds step 8's handoff.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: {} });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 8, requested: true, current: false });
        // A step that recorded a request, then ended with commit, stays the
        // step that recorded one: its late retry is refused.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: env(9) });
        await finish(wf, dir, sha, REQ, { env: env(9) });
        await commit(9);
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 9, requested: true, current: true });
        await rejects(finish(wf, dir, sha, REQ, { env: env(9) }), /step 9's request was dropped by a verb that ended with another next step since/);
      });
    });

    it('a replaced run: a write of an earlier run is stale, a later run\'s is not, and two runs of one second are not ordered', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const RUN_B = 'autopilot-20261021T000000Z-bbbbbb';
        const env = (run, n) => offerEnv(sha, { AGENTIC_AUTOPILOT: run, AGENTIC_AUTOPILOT_STEP: String(n) });
        await finish(wf, dir, sha, REQ, { env: env(RUN, 9) });
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: env(RUN_B, 1) });
        await finish(wf, dir, sha, REQ, { env: env(RUN_B, 1) });
        const b = await readFile(wf, 'utf8');
        strictEqual((await read(wf)).verify_request.run_id, RUN_B);
        // Run A's step 9 is later in its run, but its run is the earlier one.
        await rejects(finish(wf, dir, sha, REQ, { env: env(RUN, 9) }), new RegExp(`step 9 of ${RUN} is older than step 1 of ${RUN_B}`));
        await rejects(S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env: env(RUN, 10), cwd: dir }), /is older than step 1 of/);
        await rejects(finish(wf, dir, sha, REQ, { env: env('autopilot-20261021T000000Z-cccccc', 1) }), /started in the same second: their order cannot be told/);
        strictEqual(await readFile(wf, 'utf8'), b, 'run B\'s request stands');
        // A later run's step goes on.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: env('autopilot-20261022T000000Z-dddddd', 1) });
        strictEqual((await read(wf)).verify_attempt.run_id, 'autopilot-20261022T000000Z-dddddd');
      });
      deepStrictEqual(
        [V.compareAttempts({ run_id: RUN, step: 2 }, { run_id: RUN, step: 3 }), V.compareAttempts({ run_id: RUN, step: 3 }, { run_id: RUN, step: 3 }),
          V.compareAttempts({ run_id: 'autopilot-20261021T000000Z-bbbbbb', step: 1 }, { run_id: RUN, step: 9 })],
        [-1, 0, 1],
      );
    });

    it('a retry that changes only the confidence is a new request, and the next step\'s confidence is the request\'s', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha, REQ);
        const first = (await read(wf)).verify_request;
        // The same step, before the driver takes the request up: only the
        // confidence differs.
        const r = await finish(wf, dir, sha, { ...REQ, confidence: 'LOW' });
        strictEqual(r.retried, false);
        const fm = await read(wf);
        ok(fm.verify_request.id !== first.id, 'the confidence is part of what the id binds');
        deepStrictEqual([fm.verify_request.confidence, fm.next_step_confidence], ['LOW', 'LOW']);
        // Once the driver took it up, a later step's new request drops its results.
        await batch(wf, 'b1', { results: [passed(0)] });
        await finish(wf, dir, sha, { ...REQ, confidence: 'LOW', on_pass: { kind: 'done', confidence: 'HIGH' } }, { env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) });
        ok(!('verify_results' in await read(wf)), 'the old request\'s results go with it');
        // The parser holds the two together.
        const text = await readFile(wf, 'utf8');
        throws(() => S.parseWorkflowFile(text.replace('next_step_confidence: "LOW"', 'next_step_confidence: "HIGH"')), /next_step_confidence HIGH is not the confidence of request [0-9a-f]{16} \(LOW\)/);
      });
    });

    it('a request revived after Phase 0\'s clear, by any writer but the offer\'s finish-verb, is refused', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        const cleared = await readFile(wf, 'utf8');
        const ns = { kind: 'verify', confidence: 'HIGH' };
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: ns }), /written only by finish-verb/);
        await rejects(S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', terminalMarker: false, nextStep: ns }), /written only by finish-verb/);
        strictEqual(await readFile(wf, 'utf8'), cleared, 'the driver\'s writes stay closed');
      });
    });

    it('a request whose check would resolve to a word longer than a batch runs is refused at the write', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const before = await readFile(wf, 'utf8');
        const ids9 = Array.from({ length: 9 }, (_, i) => `${i}${'x'.repeat(63)}`);
        const mutate = (list) => ({ ...REQ, checks: [{ kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs', ids: list } }] });
        await rejects(finish(wf, dir, sha, mutate(ids9)), /resolves to a word of 584 characters, more than the 512 a batch runs/);
        strictEqual(await readFile(wf, 'utf8'), before);
        // Seven fit (454 characters), and the batch starts.
        await finish(wf, dir, sha, mutate(ids9.slice(0, 7)));
        await batch(wf, 'b1');
      });
    });

    it('the declaration is read without replace refs or an inherited git environment', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const widened = JSON.parse(DECLARATION);
        widened.kinds.evil = { ...widened.kinds['lint-plugin-shape'] };
        await writeFile(join(dir, '.agentic-plugins/verify-checks.json'), JSON.stringify(widened));
        git(dir, 'commit', '-q', '-am', 'widen');
        const sha2 = git(dir, 'rev-parse', 'HEAD');
        git(dir, 'replace', sha, sha2);
        // Control: git itself now shows the widened declaration at the baseline.
        ok(git(dir, 'show', `${sha}:.agentic-plugins/verify-checks.json`).includes('"evil"'));
        const evil = { ...REQ, checks: [{ kind: 'evil' }] };
        await rejects(finish(wf, dir, sha, evil), /check kind "evil" is not declared/);
        // And at the commit that does declare it, the same request is taken.
        await finish(wf, dir, sha2, evil, { env: offerEnv(sha2) });
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        // Another repository with other content, so no commit of it is the
        // baseline, and a read sent there finds no declaration.
        const other = await makeRepo({ declaration: false });
        repos.push(other.dir);
        ok(other.sha !== sha);
        const file = join(dir, '..', `${persona}-${Date.now()}-gitdir-req.json`);
        repos.push(file);
        await writeFile(file, JSON.stringify(REQ));
        const r = spawnSync(process.execPath, [STATE_PATH, 'finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Verify',
          '--next-step-kind', 'verify', '--next-step-confidence', 'HIGH', '--verify-request-file', file],
        { cwd: dir, encoding: 'utf8', env: { ...process.env, ...offerEnv(sha), GIT_DIR: join(other.dir, '.git') } });
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await read(wf)).verify_request.baseline, sha);
      });
    });

    it('a new request deletes the old results, which are never read as its own, and keeps the old last batch as previous', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const oldId = await batch(wf, 'b1', { results: [passed(0), failed(1)], end: ended('failed') });
        const oldDigest = (await read(wf)).verify_results.batches[0].checks_digest;
        // The verb resumes (its Phase 0 clears the next step) and records again.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        await finish(wf, dir, sha, { ...REQ, checks: [{ kind: 'test', args: { files: ['tests/b.mjs'] } }] }, { env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '5' }) });
        const fm = await read(wf);
        ok(fm.verify_request.id !== oldId);
        ok(!('verify_results' in fm));
        deepStrictEqual(fm.verify_request.previous, { request_id: oldId, checks_digest: oldDigest, tree_start: T1, tree_end: T1, end: 'failed' });
        const view = await S.readVerifyResults({ workflowPath: wf });
        deepStrictEqual(view.batches, []);
        // The old request's driver can no longer write.
        await rejects(S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: oldId, input: startInput(fm.verify_request, { batch: 'b9' }) }), /the pending request is [0-9a-f]{16}, not [0-9a-f]{16}: a newer request replaced it/);
      });
    });

    it('a request with no ended batch passes on the previous it carried', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [failed(0)], end: ended('failed') });
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        await finish(wf, dir, sha, REQ, { env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '5' }) });
        const carried = (await read(wf)).verify_request.previous;
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        await finish(wf, dir, sha, REQ, { env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '7' }) });
        deepStrictEqual((await read(wf)).verify_request.previous, carried);
      });
    });

    it('another next step drops the request and its results; Phase 0\'s clear keeps them readable and unwritable', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [passed(0)] });
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true });
        const fm = await read(wf);
        ok('verify_request' in fm && 'verify_results' in fm, 'kept for the verb that reads them');
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(1) }), /no request is pending on this workflow/);
        await rejects(S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' }), /no request is pending/);
        await S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env: { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '4' }, cwd: dir });
        const after2 = await read(wf);
        ok(!('verify_request' in after2) && !('verify_results' in after2));
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 4, requested: false, current: true }, 'the attempt mark outlives the request');
        strictEqual(after2.next_step_kind, 'commit');
      });
    });
  });

  describe(`${persona}: the wire form (two flat JSON scalars)`, () => {
    it('round-trips, one line each, after every other key', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0), passed(1)], end: ended('passed') });
        const text = await readFile(wf, 'utf8');
        const fmLines = text.slice(0, text.indexOf('\n---\n')).split('\n');
        deepStrictEqual(fmLines.slice(-2).map((l) => l.slice(0, l.indexOf(':'))), ['verify_request', 'verify_results']);
        const { frontmatter, body } = S.parseWorkflowFile(text);
        const block = (t) => t.slice(0, t.indexOf('\n---\n') + 5);
        strictEqual(block(S.assembleWorkflowFile(frontmatter, body)), block(text));
        strictEqual(frontmatter.verify_results.batches[0].end, 'passed');
      });
    });

    it('the parser refuses what does not hold together', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0)] });
        const text = await readFile(wf, 'utf8');
        const { frontmatter } = S.parseWorkflowFile(text);
        const line = (key, value) => `${key}: ${JSON.stringify(JSON.stringify(value))}`;
        const swap = (key, value) => text.replace(new RegExp(`^${key}: .*$`, 'm'), value === undefined ? '' : line(key, value));
        throws(() => S.parseWorkflowFile(swap('verify_request', undefined).replace(/^verify_results: .*$/m, '')), /next_step_kind verify needs verify_request/);
        throws(() => S.parseWorkflowFile(swap('verify_results', { ...frontmatter.verify_results, request_id: '0'.repeat(16) })), /results are never read as another request's/);
        throws(() => S.parseWorkflowFile(swap('verify_request', undefined).replace('next_step_kind: "verify"', 'next_step_kind: "commit"')), /verify_results are for request/);
        throws(() => S.parseWorkflowFile(swap('verify_request', { ...frontmatter.verify_request, answered_by: 'b1' })), /already answered/);
        throws(() => S.parseWorkflowFile(swap('verify_request', { ...frontmatter.verify_request, step: 4 })), /does not match what it binds/);
        const mark = (over) => ({ v: 1, run_id: RUN, step: 3, requested: true, handoff: 'c'.repeat(64), generation: 1, ...over });
        // While the request is pending, a mark of its step records it, and a
        // later step's mark (Phase 7 entered again past it) reads.
        throws(() => S.parseWorkflowFile(swap('verify_attempt', mark({ requested: false }))), /verify_attempt \(autopilot-\S+ step 3\) names the step of verify_request/);
        throws(() => S.parseWorkflowFile(swap('verify_attempt', undefined)), /verify_attempt \(none\) is older than verify_request/);
        throws(() => S.parseWorkflowFile(swap('verify_attempt', mark({ step: 2 }))), /verify_attempt \(autopilot-\S+ step 2\) is older than verify_request/);
        S.parseWorkflowFile(swap('verify_attempt', mark({ step: 9, requested: false })));
        throws(() => S.parseWorkflowFile(swap('verify_attempt', mark({ step: 0 }))), /verify_attempt\.step is not a positive integer/);
        throws(() => S.parseWorkflowFile(swap('verify_attempt', { run_id: RUN, step: 3 })), /verify_attempt\.v is not 1/);
        // The mark binds its step to a handoff digest, and to nothing else.
        const { handoff: _h, ...noHandoff } = mark({});
        throws(() => S.parseWorkflowFile(swap('verify_attempt', noHandoff)), /verify_attempt\.handoff is not a digest/);
        throws(() => S.parseWorkflowFile(swap('verify_attempt', mark({ handoff: 'C'.repeat(64) }))), /verify_attempt\.handoff is not a digest/);
        throws(() => S.parseWorkflowFile(swap('verify_attempt', mark({ taken: true }))), /verify_attempt: unknown field "taken"/);
        // And to that handoff's generation, a whole number, as the stored
        // generation is.
        const { generation: _g, ...noGeneration } = mark({});
        for (const g of [undefined, -1, 1.5, '1']) {
          throws(() => S.parseWorkflowFile(swap('verify_attempt', g === undefined ? noGeneration : mark({ generation: g }))), /verify_attempt\.generation is not a whole number/);
        }
        const gen = (over) => ({ v: 1, generation: 2, handoff: 'c'.repeat(64), ...over });
        S.parseWorkflowFile(swap('verify_handoff', gen({})));
        for (const g of [-1, 1.5, '2']) throws(() => S.parseWorkflowFile(swap('verify_handoff', gen({ generation: g }))), /verify_handoff\.generation is not a whole number/);
        throws(() => S.parseWorkflowFile(swap('verify_handoff', gen({ handoff: 'x' }))), /verify_handoff\.handoff is not a digest/);
        throws(() => S.parseWorkflowFile(swap('verify_handoff', gen({ v: 0 }))), /verify_handoff\.v is not 1/);
        throws(() => S.parseWorkflowFile(swap('verify_handoff', gen({ step: 3 }))), /verify_handoff: unknown field "step"/);
        // A record moved from another workflow does not read here: its
        // request names the workflow that recorded it, and its results are
        // that request's (MAJOR 3 of the fifth critique).
        const moved = text.replace(/^workflow_id: .*$/m, () => `workflow_id: "compose-20261020T000000Z-0a0a0a"`);
        ok(moved !== text, 'the containing workflow_id was replaced');
        throws(() => S.parseWorkflowFile(moved), new RegExp(`verify_request is workflow ${frontmatter.workflow_id}'s, not compose-20261020T000000Z-0a0a0a's, the workflow holding it`));
        // And a request whose own workflow_id names another workflow, its id
        // computed for that one, does not read either.
        const elsewhere = { ...frontmatter.verify_request, workflow_id: 'not-this-workflow' };
        throws(() => S.parseWorkflowFile(swap('verify_request', { ...elsewhere, id: V.requestId(elsewhere) }).replace(/^verify_results: .*$/m, '')), /verify_request is workflow not-this-workflow's, not/);
        // Beside another next step, a mark older than the request is refused,
        // and a later one (the step that took it up) is read.
        const notPending = (t) => t.replace('next_step_kind: "verify"', 'next_step_kind: "commit"');
        throws(() => S.parseWorkflowFile(notPending(swap('verify_attempt', mark({ step: 2 })))), /verify_attempt \(autopilot-\S+ step 2\) is older than verify_request/);
        S.parseWorkflowFile(notPending(swap('verify_attempt', mark({ step: 4, requested: false }))));
        throws(() => S.parseWorkflowFile(text.replace(/^verify_results: .*$/m, 'verify_results: "{not json"')), /verify_results is not JSON/);
        const twoOpen = { ...frontmatter.verify_results, batches: [...frontmatter.verify_results.batches, { ...frontmatter.verify_results.batches[0], batch_id: 'b2', results: [] }] };
        throws(() => S.parseWorkflowFile(swap('verify_results', twoOpen)), /more than one open batch/);
        // A hand-written request with an option for an argument, its id
        // computed correctly, is refused all the same (and the driver checks
        // again: lib/verify.mjs header).
        const handWritten = (args) => {
          const q = { ...frontmatter.verify_request, checks: [{ kind: 'test', args }] };
          return { ...q, id: V.requestId(q) };
        };
        const noResults = (t) => t.replace(/^verify_results: .*$/m, '');
        throws(() => S.parseWorkflowFile(noResults(swap('verify_request', handWritten({ files: ['--require=/tmp/evil.js'] })))), /checks\[0\]\.args slot files value "--require=\/tmp\/evil\.js" is neither a path nor an id/);
        throws(() => S.parseWorkflowFile(noResults(swap('verify_request', handWritten({ files: 'a b' })))), /is neither a path nor an id/);
        throws(() => S.parseWorkflowFile(noResults(swap('verify_request', handWritten({ 'Bad Slot': ['tests/a.mjs'] })))), /names no slot/);
        // Control: the same hand-written form with a path is read.
        S.parseWorkflowFile(noResults(swap('verify_request', handWritten({ files: ['tests/b.mjs'] }))));
        // A later batch that does not continue the one before it, cut short.
        const ended1 = { ...frontmatter.verify_results.batches[0], ...ended('failed'), results: [failed(0)] };
        const follows = { ...frontmatter.verify_results, batches: [ended1, { ...frontmatter.verify_results.batches[0], batch_id: 'b2', continues: 'b1', results: [] }] };
        throws(() => S.parseWorkflowFile(swap('verify_results', follows)), /batches\[1\] follows batch b1 \(ended failed\) without continuing it cut short/);
      });
    });

    it('a record a later release wrote (a higher v) is carried as written, and only the verify commands refuse it', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0)] });
        const text = await readFile(wf, 'utf8');
        const { frontmatter } = S.parseWorkflowFile(text);
        const line = (key, value) => `${key}: ${JSON.stringify(JSON.stringify(value))}`;
        const put = (t, key, value) => t.replace(new RegExp(`^${key}: .*$`, 'm'), line(key, value));
        // A field, an on_pass kind and an outcome this release does not know.
        const newer = {
          verify_attempt: { ...frontmatter.verify_attempt, v: 2, lane: 'L1' },
          verify_handoff: { ...frontmatter.verify_handoff, v: 2, lanes: 1 },
          verify_request: { ...frontmatter.verify_request, v: 2, priority: 'high', on_pass: { kind: 'merge' } },
          verify_results: { ...frontmatter.verify_results, v: 2, batches: [{ ...frontmatter.verify_results.batches[0], results: [{ index: 0, outcome: 'flaky' }] }] },
        };
        let later = text;
        for (const [k, v] of Object.entries(newer)) later = put(later, k, v);
        // Control: the same records under v 1 are refused, so only the
        // version carries them.
        for (const [k, v] of Object.entries(newer)) throws(() => S.parseWorkflowFile(put(later, k, { ...v, v: 1 })), new RegExp(`${k}|the result|outcome`));
        // A v that is no whole number above 1 is malformed.
        for (const v of [0, '2', 1.5]) throws(() => S.parseWorkflowFile(put(later, 'verify_request', { ...frontmatter.verify_request, v })), /verify_request\.v is not 1/);
        await writeFile(wf, later);
        strictEqual((await read(wf)).verify_request.v, 2, 'the workflow reads');
        const verifyLines = (t) => t.slice(0, t.indexOf('\n---\n')).split('\n').filter((l) => l.startsWith('verify_'));
        await S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'later release', event: 'updated' });
        deepStrictEqual(verifyLines(await readFile(wf, 'utf8')), verifyLines(later), 'another write carries them as written');
        const id = frontmatter.verify_request.id;
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(1) }), /verify_attempt \(v 2\), verify_handoff \(v 2\), verify_request \(v 2\), verify_results \(v 2\) was written by a later release than this one, which writes v 1/);
        await rejects(S.readVerifyResults({ workflowPath: wf }), /written by a later release/);
        await rejects(finish(wf, dir, sha), /written by a later release/);
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) }), /verify_attempt \(v 2\) was written by a later release/);
        // Every write under a run is held to the mark, which this release
        // cannot read: a step the run does not offer verification, and a step
        // of an earlier driver that numbers none, write nothing beside it.
        const held = await readFile(wf, 'utf8');
        for (const env of [{ AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '4' }, { AGENTIC_AUTOPILOT: RUN }, { AGENTIC_AUTOPILOT: 'autopilot-20261021T000000Z-bbbbbb' }]) {
          await rejects(S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env, cwd: dir }), /verify_attempt \(v 2\) was written by a later release/, JSON.stringify(env));
          await rejects(S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env }), /verify_attempt \(v 2\) was written by a later release/, JSON.stringify(env));
        }
        strictEqual(await readFile(wf, 'utf8'), held);
        // Outside any run a verb's own next step goes on: it drops the
        // request and its results, and carries the mark.
        await S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env: {}, cwd: dir });
        const after2 = await read(wf);
        ok(!('verify_request' in after2) && !('verify_results' in after2));
        deepStrictEqual(after2.verify_attempt, newer.verify_attempt);
        deepStrictEqual(after2.verify_handoff, newer.verify_handoff, 'the later generation is carried as written');
      });
      // A later release's generation beside this release's mark: no step of
      // any run writes beside it, and an owner's write goes on.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const { frontmatter } = S.parseWorkflowFile(await readFile(wf, 'utf8'));
        const text = putLine(await readFile(wf, 'utf8'), 'verify_handoff', { ...frontmatter.verify_handoff, v: 2 });
        await writeFile(wf, text);
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) }), /verify_handoff \(v 2\) was written by a later release/);
        strictEqual(await readFile(wf, 'utf8'), text);
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: { AGENTIC_AUTOPILOT: 'autopilot-20261021T000000Z-bbbbbb' } }), /verify_handoff \(v 2\) was written by a later release/);
        strictEqual(await readFile(wf, 'utf8'), text);
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: {} });
        strictEqual((await read(wf)).verify_handoff.v, 2);
      });
      // And a later release's mark beside this release's generation, alone.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const { frontmatter } = S.parseWorkflowFile(await readFile(wf, 'utf8'));
        const text = putLine(await readFile(wf, 'utf8'), 'verify_attempt', { ...frontmatter.verify_attempt, v: 2 });
        await writeFile(wf, text);
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) }), /verify_attempt \(v 2\) was written by a later release/);
        strictEqual(await readFile(wf, 'utf8'), text);
      });
      // A driver's write this release could otherwise take into a later
      // release's record is refused all the same.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1');
        const { frontmatter } = S.parseWorkflowFile(await readFile(wf, 'utf8'));
        const text = (await readFile(wf, 'utf8')).replace(/^verify_results: .*$/m, `verify_results: ${JSON.stringify(JSON.stringify({ ...frontmatter.verify_results, v: 2 }))}`);
        await writeFile(wf, text);
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: frontmatter.verify_request.id, batchId: 'b1', input: passed(0) }), /verify_results \(v 2\) was written by a later release/);
        strictEqual(await readFile(wf, 'utf8'), text);
      });
    });

    it('a reader that does not know the keys carries them byte for byte once the next step is no longer verify', async () => {
      const readerDir = await mkdtemp(join(tmpdir(), `${persona}-reader-unverified-`));
      repos.push(readerDir);
      const src = await readFile(STATE_PATH, 'utf8');
      const keyLine = '  order.push(...VERIFY_KEYS);\n';
      const kinds = "new Set(['verb', 'commit', 'owner-decision', 'done', 'verify'])";
      // Contract: the rewrite below builds the older reader; if either line
      // drifts, the "older reader" silently knows the keys or the kind.
      strictEqual(src.split(keyLine).length, 2);
      strictEqual(src.split(kinds).length, 2);
      const scripts = join(readerDir, 'scripts');
      await mkdir(join(scripts, 'lib'), { recursive: true });
      await mkdir(join(readerDir, '.claude-plugin'));
      await writeFile(join(scripts, 'state.mjs'), src.replace(keyLine, '').replace(kinds, "new Set(['verb', 'commit', 'owner-decision', 'done'])"));
      await copyFile(P.path('scripts/validate-commit.mjs'), join(scripts, 'validate-commit.mjs'));
      for (const lib of ['cli-entry.mjs', 'persona.mjs', 'state-root.mjs', 'review-scope.mjs', 'peer-snapshot.mjs', 'process-identity.mjs', 'verify.mjs']) {
        await copyFile(P.path(`scripts/lib/${lib}`), join(scripts, 'lib', lib));
      }
      await copyFile(P.path('persona.json'), join(readerDir, 'persona.json'));
      await copyFile(P.path('.claude-plugin/plugin.json'), join(readerDir, '.claude-plugin', 'plugin.json'));
      const old = await import(pathToFileURL(join(scripts, 'state.mjs')).href);
      const block = (text) => text.slice(0, text.indexOf('\n---\n') + 5);
      const tail = (text) => block(text).trimEnd().split('\n').slice(-3, -1);

      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        // While the next step is verify, the older reader refuses the file
        // (the window Decision 5, item 11 names).
        throws(() => old.parseWorkflowFile(readFileSync(wf, 'utf8')), /next_step_kind must be one of verb, commit, owner-decision, done/);
        const id = await batch(wf, 'b1', { results: [passed(0), passed(1)], end: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' });
        const written = await readFile(wf, 'utf8');
        const parsed = old.parseWorkflowFile(written);
        deepStrictEqual((parsed.frontmatter[old.FORWARD_COMPAT_UNKNOWNS] ?? []).map((e) => e.key).slice(-2), ['verify_request', 'verify_results']);
        strictEqual(block(old.assembleWorkflowFile(parsed.frontmatter, parsed.body)), block(written));
        await old.appendPhase({ workflowPath: wf, host: 'codex', phaseLabel: 'older reader', event: 'updated' });
        const rewritten = await readFile(wf, 'utf8');
        deepStrictEqual(tail(rewritten), tail(written));
        // Every verify write recorded an event the older reader knows.
        ok((await read(wf)).host_history.every((h) => ['created', 'updated', 'snapshot', 'resumed', 'archived', 'checkpointed'].includes(h.event)));
      });
    });
  });

  describe(`${persona}: the driver's records (Decision 5, items 5 to 7)`, () => {
    it('a batch start: digest recomputed, worker checks the request\'s in order, indexes in order, one open batch, a first batch that continues nothing', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const id = fm.verify_request.id;
        const start = (input) => S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: id, input });
        const good = startInput(fm.verify_request, { extra: [['npm', 'test', '--', 'tests/b.mjs']] });
        await rejects(start({ ...good, checks_digest: 'c'.repeat(64) }), /checks_digest is not the digest of the batch's argv list/);
        const swapped = [good.checks[1], good.checks[0], good.checks[2]].map((c, i) => ({ ...c, index: i }));
        await rejects(start(startInput(fm.verify_request, { checks: swapped })), /are not the request's \(test, lint-plugin-shape\), in order/);
        const dropped = [good.checks[0], { ...good.checks[2], index: 1 }];
        await rejects(start(startInput(fm.verify_request, { checks: dropped })), /never drops one/);
        await rejects(start({ ...good, checks: good.checks.map((c, i) => ({ ...c, index: i === 1 ? 2 : i })) }), /checks\[1\]\.index is not 1/);
        await rejects(start(startInput(fm.verify_request, { continues: 'b0' })), /continues b0, but request [0-9a-f]{16} has no batch yet/);
        await rejects(start({ ...good, run_id: 'not-a-run' }), /run_id is not an autopilot run id/);
        await rejects(S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: '0'.repeat(16), input: good }), /not 0{16}/);
        strictEqual((await start(good)).recorded, true);
        await rejects(start(startInput(fm.verify_request, { batch: 'b2', at: iso(5) })), /batch b1 is still open/);
      });
    });

    it('results: in index order, never after a check that did not pass, the failing names cleaned, only for a failure', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1');
        const put = (input) => S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input });
        await rejects(put(passed(1)), /the next result of batch b1 is index 0 \(got 1\)/);
        await rejects(put({ ...passed(0), failing_tests: ['x'] }), /only a failed check names failing tests/);
        await rejects(put({ ...passed(0), exit: 1 }), /a passed check exited 0/);
        await rejects(put({ ...failed(0), log: '../escape.log' }), /log has an empty, \. or \.\. segment/);
        await rejects(put({ ...failed(0), failing_tests: Array.from({ length: 21 }, () => 'x') }), /at most 20 names/);
        await rejects(put({ ...failed(0), failing_tests: ['x'.repeat(201)] }), /1 to 200 characters/);
        await put({ ...failed(0), failing_tests: ['a\nb\u001b[31mc\u0007'] });
        strictEqual((await read(wf)).verify_results.batches[0].results[0].failing_tests[0], 'ab[31mc');
        await rejects(put(passed(1)), /stopped at check 0 \(failed\); no later check runs/);
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b7', input: passed(0) }), /no batch b7/);
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [{ ...passed(0), outcome: 'timeout', exit: null, signal: 'SIGTERM' }] });
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(1) }), /stopped at check 0 \(timeout\)/);
      });
    });

    it('ends that contradict their batch are refused', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [passed(0)] });
        const end = (input) => S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input });
        await rejects(end(ended('passed')), /a passed batch has every check passed/);
        await rejects(end(ended('failed')), /a failed batch ends at a failed check/);
        await rejects(end(ended('no-evidence', { tree: null, cause: 'timeout' })), /tree_end null\) ends no-evidence, cause tree-unreadable/);
        await rejects(end(ended('cut-short', { tree: T2, cause: 'stop' })), /whose tree changed ends no-evidence, cause tree-changed/);
        await rejects(end(ended('cut-short', { cause: 'timeout' })), /names its cause \(stop, hold, drain, driver-end\)/);
        await rejects(end(ended('no-evidence', { cause: 'tree-changed' })), /names a tree that did not change/);
        await rejects(end(ended('no-evidence')), /ends at a check with no evidence of its own/);
        await end(ended('cut-short', { cause: 'hold' }));
        strictEqual((await read(wf)).verify_results.batches[0].end, 'cut-short');
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [passed(0), passed(1)] });
        await rejects(S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('passed', { tree: T2 }) }), /whose tree changed/);
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('no-evidence', { tree: T2, cause: 'tree-changed' }) });
        await rejects(S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' }), /ended no-evidence, not passed/);
      });
    });

    it('an identical replay is a no-op, after the end too; a different record is refused, never overwritten', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const id = fm.verify_request.id;
        const s1 = startInput(fm.verify_request);
        await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: id, input: s1 });
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(0) });
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(1) });
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' });
        const done = await readFile(wf, 'utf8');
        deepStrictEqual(await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: id, input: s1 }), { unchanged: true });
        deepStrictEqual(await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(0) }), { unchanged: true });
        deepStrictEqual(await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('passed') }), { unchanged: true });
        deepStrictEqual(await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' }), { unchanged: true });
        strictEqual(await readFile(wf, 'utf8'), done, 'a replay writes nothing');
        await rejects(S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: id, input: { ...s1, tree_start: T2 } }), /already recorded with another start/);
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: { ...passed(0), duration_ms: 6 } }), /already has a result; a result is never overwritten/);
        await rejects(S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('passed', { at: iso(59) }) }), /has already ended \(passed\)/);
        strictEqual(await readFile(wf, 'utf8'), done);
      });
    });

    it('two processes recording the same result leave one record', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1');
        const file = join(dir, '..', `${persona}-${Date.now()}-result.json`);
        repos.push(file);
        await writeFile(file, JSON.stringify(passed(0)));
        const args = [STATE_PATH, 'verify-result', '--workflow-path', wf, '--host', 'claude', '--request-id', id, '--batch-id', 'b1', '--input-file', file];
        const runOne = () => new Promise((resolveRun) => {
          const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => { out += d; });
          child.stderr.on('data', (d) => { err += d; });
          child.on('close', (code) => resolveRun({ code, out: out.trim(), err }));
        });
        const both = await Promise.all([runOne(), runOne()]);
        deepStrictEqual(both.map((r) => r.code), [0, 0], both.map((r) => r.err).join('\n'));
        deepStrictEqual(both.map((r) => r.out).sort(), ['{"recorded":true}', '{"unchanged":true}']);
        strictEqual((await read(wf)).verify_results.batches[0].results.length, 1);
      });
    });

    it('a start whose worst-case results would not fit the budget is refused', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const long = (n) => ['npm', 'test', '--', ...Array.from({ length: 4 }, (_, k) => `tests/${String(n * 10 + k).padStart(4, '0')}${'x'.repeat(480)}.mjs`)];
        const extra = Array.from({ length: 100 }, (_, n) => long(n));
        await rejects(
          S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, input: startInput(fm.verify_request, { extra }) }),
          /results could take \d+ bytes, more than the 196608 a workflow keeps/,
        );
        await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, input: startInput(fm.verify_request, { extra: extra.slice(0, 10) }) });
      });
    });

    it('a start that would fit, but whose continuation after a cut would not, is refused; one that fits both is taken up again', async () => {
      const paths = (n) => Array.from({ length: n }, (_, k) => `tests/${String(k).padStart(4, '0')}${'y'.repeat(234)}.mjs`);
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const big = startInput(fm.verify_request, { extra: [['npm', 'test', '--', ...paths(400)]] });
        // Control: alone, the batch's worst results fit the budget.
        const alone = V.scalarBytes('verify_results', { v: 1, request_id: fm.verify_request.id, batches: [{ ...big, results: [] }] });
        ok(alone < V.MAX_RESULTS_BYTES, String(alone));
        await rejects(S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, input: big }), /results could take \d+ bytes, more than the 196608/);
        const id = await batch(wf, 'b1', { extra: [['npm', 'test', '--', ...paths(150)]], results: [passed(0)], end: ended('cut-short', { cause: 'stop' }), at: iso(1) });
        await batch(wf, 'b2', { continues: 'b1', extra: [['npm', 'test', '--', ...paths(150)]], at: iso(2) });
        strictEqual((await read(wf)).verify_request.id, id);
        deepStrictEqual((await read(wf)).verify_results.batches.map((b) => [b.batch_id, b.results.length]), [['b1', 1], ['b2', 1]]);
      });
    });

    it('a chain of continuations at the budget boundary: each link admitted is taken up again, whatever ids and check kinds the links carry, and records its widest results', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const requestId = fm.verify_request.id;
        // 64-character batch ids: the widest a link can carry.
        const idOf = (k) => `${k}${'c'.repeat(63)}`;
        const words = (n) => [...Array.from({ length: Math.floor(n / 500) }, () => 'p'.repeat(500)), ...(n % 500 ? ['p'.repeat(n % 500)] : [])];
        // Later links name the driver's check by the widest kind: the same
        // commands, so the same checks digest, and nothing is run again.
        const startAt = (n, k, continues) => startInput(fm.verify_request, { batch: idOf(k), continues, extra: [['npm', 'test', '--', ...words(n)]], extraKind: k === 1 ? 'test' : `k${'k'.repeat(63)}`, at: iso(k) });
        // The largest padding the reserve admits for a first batch, which
        // continues nothing.
        const empty = { v: 1, request_id: requestId, batches: [] };
        let lo = 1;
        let hi = 200_000;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (V.worstCaseBytes(empty, startAt(mid, 1, null)) <= V.MAX_RESULTS_BYTES) lo = mid; else hi = mid - 1;
        }
        // Control: one character more and the first batch is refused.
        await rejects(S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId, input: startAt(lo + 1, 1, null) }), /results could take \d+ bytes, more than the 196608/);
        let prev = null;
        for (let k = 1; k <= 4; k += 1) {
          await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId, input: startAt(lo, k, prev) });
          if (k === 1) await S.recordResult({ workflowPath: wf, host: 'claude', requestId, batchId: idOf(k), input: passed(0) });
          await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId, batchId: idOf(k), input: ended('cut-short', { cause: 'stop' }) });
          prev = idOf(k);
        }
        deepStrictEqual((await read(wf)).verify_results.batches.map((b) => [b.batch_id, b.results.length]), [[idOf(3), 1], [idOf(4), 1]]);
        // The last link records the widest results it can: a check that
        // could not start (exit null, the longest signal), then a failure
        // naming the most tests at their widest, and its end.
        await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId, input: startAt(lo, 5, prev) });
        const id5 = idOf(5);
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId, batchId: id5, input: { ...passed(1), log: 'l'.repeat(256), duration_ms: 7 * 24 * 3600 * 1000 } });
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId, batchId: id5, input: { ...failed(2, Array.from({ length: 20 }, () => '"'.repeat(200))), exit: null, signal: 'SIGABCDEFGHIJKL', log: 'l'.repeat(256), failing_tests_more: Number.MAX_SAFE_INTEGER, duration_ms: 7 * 24 * 3600 * 1000 } });
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId, batchId: id5, input: ended('failed') });
        strictEqual((await read(wf)).verify_results.batches.at(-1).end, 'failed');
      });
    });

    it('across five interruptions a continuation carries the passed results it goes on from, and retention keeps only the batch it continues', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        let prev = null;
        for (let k = 1; k <= 5; k += 1) {
          await batch(wf, `c${k}`, { continues: prev, results: k === 1 ? [passed(0)] : [], end: ended('cut-short', { cause: 'stop' }), at: iso(10 + k) });
          prev = `c${k}`;
        }
        await batch(wf, 'c6', { continues: prev, at: iso(20) });
        const res = (await read(wf)).verify_results;
        deepStrictEqual(res.batches.map((b) => b.batch_id), ['c5', 'c6']);
        // c1's passed result reached c6 through every continuation, naming the
        // batch and run that recorded it, though c1 itself is evicted.
        deepStrictEqual(res.batches[1].results, [{ ...passed(0), carried_from: { batch_id: 'c1', run_id: RUN } }]);
      });
    });

    it('a stale start (earlier than the latest batch) is refused', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b2', { results: [passed(0)], end: ended('cut-short', { cause: 'drain' }), at: iso(9) });
        await rejects(batch(wf, 'b1', { continues: 'b2', at: iso(1) }), /starts before batch b2, the latest: a stale start/);
      });
    });
  });

  describe(`${persona}: a batch is the request's, and follows only a batch cut short (Decision 5, items 4 and 7)`, () => {
    it('the worker checks run the request\'s commands, resolved with the declaration the batch names', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const start = (input) => S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, input });
        const good = startInput(fm.verify_request);
        // The same kinds, another file: the request asked for tests/a.mjs.
        const other = good.checks.map((c, i) => (i === 0 ? { ...c, argv: ['npm', 'test', '--', 'tests/b.mjs'] } : c));
        await rejects(start(startInput(fm.verify_request, { checks: other })), /worker check 0 runs \["npm","test","--","tests\/b\.mjs"\], not the request's check 0, \["npm","test","--","tests\/a\.mjs"\]/);
        await rejects(start({ ...good, declaration_digest: 'c'.repeat(64) }), /the declaration at [0-9a-f]{40} has digest [0-9a-f]{64}, not the batch's c{64}/);
        await rejects(start({ ...good, declaration_commit: 'f'.repeat(40) }), /the persona cannot read the repository's declaration .* at f{40}/);
        await rejects(start({ ...good, batch_id: 1 }), /batch_id is not 1 to 64 characters/);
        const before = await readFile(wf, 'utf8');
        strictEqual((await start(good)).recorded, true);
        ok(before !== await readFile(wf, 'utf8'));
      });
    });

    it('a continuation on the same tree goes on from its first check that did not pass; on another tree it runs whole', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [passed(0), stopped(1)], end: ended('cut-short', { cause: 'hold' }), at: iso(1) });
        await batch(wf, 'b2', { continues: 'b1', at: iso(2) });
        let res = (await read(wf)).verify_results;
        deepStrictEqual(res.batches[1].results, [{ ...passed(0), carried_from: { batch_id: 'b1', run_id: RUN } }]);
        // It records from check 1 on, and passes with every check passed.
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b2', input: passed(0) }), /already has a result/);
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b2', input: passed(1) });
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b2', input: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b2' });
        strictEqual((await read(wf)).next_step_kind, 'commit');
        const view = await S.readVerifyResults({ workflowPath: wf, treeDigest: T1 });
        deepStrictEqual(view.batches[1].checks.map((c) => [c.evidence, c.applies, c.result.carried_from ?? null]), [[true, true, { batch_id: 'b1', run_id: RUN }], [true, true, null]]);
        // Each result names the batch and run that recorded it, the pair
        // verify-exec holds against its own ledger (lib/verify.mjs header).
        deepStrictEqual(view.batches[1].checks.map((c) => c.recorded_by), [{ batch_id: 'b1', run_id: RUN }, { batch_id: 'b2', run_id: RUN }]);
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0)], end: ended('cut-short', { cause: 'stop' }), at: iso(1) });
        await batch(wf, 'b2', { continues: 'b1', tree: T2, at: iso(2) });
        deepStrictEqual((await read(wf)).verify_results.batches[1].results, [], 'another tree: nothing carried');
        const id = (await read(wf)).verify_request.id;
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b2', input: passed(0) });
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b2', input: ended('cut-short', { tree: T2, cause: 'stop' }) });
        // b2 passed check 0 on T2; b3, on T2 too, runs other commands (a driver addition).
        await batch(wf, 'b3', { continues: 'b2', tree: T2, extra: [['npm', 'test', '--', 'tests/b.mjs']], at: iso(3) });
        deepStrictEqual((await read(wf)).verify_results.batches[1].results, [], 'other commands: nothing carried');
      });
    });

    it('only a stopped check, or none yet, is cut short; a timeout, a refusal or a check that could not start ends no-evidence', async () => {
      for (const outcome of ['timeout', 'refused', 'not-started', 'not-reached']) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          await finish(wf, dir, sha);
          const id = await batch(wf, 'b1', { results: [{ ...passed(0), outcome, exit: null }] });
          await rejects(S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('cut-short', { cause: 'stop' }) }), new RegExp(`ended ${outcome} ended no-evidence, not cut short`));
        });
      }
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0), stopped(1)], end: ended('cut-short', { cause: 'driver-end' }) });
        strictEqual((await read(wf)).verify_results.batches[0].end, 'cut-short');
      });
    });

    it('nothing follows a batch that passed, failed or ended with no evidence; a continuation names the latest batch', async () => {
      const ends = {
        passed: { results: () => [passed(0), passed(1)], end: ended('passed') },
        failed: { results: () => [failed(0)], end: ended('failed') },
        'no-evidence': { results: () => [{ ...passed(0), outcome: 'timeout', exit: null, signal: 'SIGTERM' }], end: ended('no-evidence', { cause: 'timeout' }) },
      };
      for (const [name, e] of Object.entries(ends)) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          await finish(wf, dir, sha);
          await batch(wf, 'b1', { results: e.results(), end: e.end, at: iso(1) });
          await rejects(batch(wf, 'b2', { continues: 'b1', at: iso(2) }), new RegExp(`batch b1, the request's latest, ended ${name}: only a batch cut short is taken up again`));
          await rejects(batch(wf, 'b2', { at: iso(2) }), /only a batch cut short is taken up again/);
        });
      }
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await rejects(batch(wf, 'b1', { continues: 'b0' }), /continues b0, but request [0-9a-f]{16} has no batch yet/);
        await batch(wf, 'b1', { results: [passed(0)], end: ended('cut-short', { cause: 'stop' }), at: iso(1) });
        await rejects(batch(wf, 'b2', { at: iso(2) }), /continues nothing, not b1, the request's latest batch, cut short/);
        await batch(wf, 'b2', { continues: 'b1', end: ended('cut-short', { cause: 'stop' }), at: iso(2) });
        await rejects(batch(wf, 'b3', { continues: 'b1', at: iso(3) }), /continues b1, not b2/);
      });
    });
  });

  describe(`${persona}: reading the results, and the handoff of a passing batch`, () => {
    it('evidence is historical; applies says whether it is about the given tree', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0), passed(1)], end: ended('no-evidence', { tree: T2, cause: 'tree-changed' }), at: iso(1) });
        const plain = await S.readVerifyResults({ workflowPath: wf });
        strictEqual(plain.pending, true);
        deepStrictEqual(plain.batches.map((b) => b.checks.map((c) => [c.evidence, c.applies])), [[[false, null], [false, null]]]);
        const named = await S.readVerifyResults({ workflowPath: wf, treeDigest: T1 });
        deepStrictEqual(named.batches[0].checks.map((c) => c.applies), [false, false]);
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'b1', { results: [passed(0), failed(1)], end: ended('failed'), at: iso(2) });
        const plain = await S.readVerifyResults({ workflowPath: wf });
        deepStrictEqual(plain.batches.map((b) => b.checks.map((c) => [c.evidence, c.applies])), [[[true, null], [true, null]]]);
        const same = await S.readVerifyResults({ workflowPath: wf, treeDigest: T1 });
        deepStrictEqual(same.batches[0].checks.map((c) => c.applies), [true, true]);
        const other = await S.readVerifyResults({ workflowPath: wf, treeDigest: T2 });
        deepStrictEqual(other.batches[0].checks.map((c) => c.applies), [false, false]);
        await rejects(S.readVerifyResults({ workflowPath: wf, treeDigest: 'nope' }), /--tree-digest is not a 64-hex digest/);
      });
    });

    it('verify-pass: only the latest batch, ended passed; it publishes on_pass, and done reaches the commit surface\'s close', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha, { ...REQ, on_pass: { kind: 'done', confidence: 'HIGH' } });
        const id = await batch(wf, 'b1', { results: [passed(0)], end: ended('cut-short', { cause: 'stop' }), at: iso(1) });
        await batch(wf, 'b3', { continues: 'b1', results: [passed(1)], end: ended('passed'), at: iso(3) });
        await rejects(S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' }), /is not request [0-9a-f]{16}'s latest batch/);
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b3' });
        const fm = await read(wf);
        deepStrictEqual([fm.next_step_kind, fm.next_step_confidence, fm.verify_request.answered_by], ['done', 'HIGH', 'b3']);
        await rejects(S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' }), /was answered by batch b3, not b1/);
        if (P.capabilities.commit_surface) {
          const { classifyNoChanges } = await import(pathToFileURL(P.path('scripts/phase7-commit.mjs')).href);
          strictEqual(classifyNoChanges({ repoRoot: dir, frontmatter: fm, manifestPaths: [] }).path, 'close');
        }
      });
    });

    it('verify-pass with a verb: the verb and its confidence', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha, { ...REQ, on_pass: { kind: 'verb', verb: 'critique', confidence: 'MEDIUM' } });
        const id = await batch(wf, 'b1', { results: [passed(0), passed(1)], end: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' });
        const fm = await read(wf);
        deepStrictEqual([fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence], ['verb', 'critique', 'MEDIUM']);
        deepStrictEqual(await ids(wf), { request: id, kind: 'verb' });
      });
    });
  });

  const line = (key, value) => `${key}: ${JSON.stringify(JSON.stringify(value))}`;
  const putLine = (text, key, value) => text.replace(new RegExp(`^${key}: .*$`, 'm'), () => line(key, value));

  describe(`${persona}: every id a record holds is a string before it is matched`, () => {
    const nest = (v, depth) => (depth === 0 ? v : [nest(v, depth - 1)]);
    const DEPTHS = [1, 2, 50];
    const verbs = new Set(['critique']);

    it('an array, or one nested to any depth, at each id field of each record is refused, where the string it holds is taken', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const req = (await read(wf)).verify_request;
        const start = startInput(req, { continues: 'b0' });
        const carried = { ...passed(0), carried_from: { batch_id: 'b0', run_id: RUN } };
        const prev = { request_id: '0'.repeat(16), checks_digest: T1, tree_start: T1, tree_end: T1, end: 'failed' };
        const rebound = (over) => { const q = { ...req, ...over }; return { ...q, id: V.requestId(q) }; };
        const results = { v: 1, request_id: req.id, batches: [] };
        // [record field, the check, a builder from the field's value]
        const cases = [
          ...['batch_id', 'run_id', 'continues', 'tree_start', 'declaration_commit', 'declaration_digest'].map((k) => [`batch start ${k}`, V.parseBatchStart, (v) => ({ ...start, [k]: v }), start[k]]),
          ['batch start checks[0].kind', V.parseBatchStart, (v) => ({ ...start, checks: start.checks.map((c, i) => (i === 0 ? { ...c, kind: v } : c)) }), start.checks[0].kind],
          ['carried_from.batch_id', (r) => V.parseResult(r, { stored: true }), (v) => ({ ...carried, carried_from: { ...carried.carried_from, batch_id: v } }), 'b0'],
          ['carried_from.run_id', (r) => V.parseResult(r, { stored: true }), (v) => ({ ...carried, carried_from: { ...carried.carried_from, run_id: v } }), RUN],
          ['result log', (r) => V.parseResult(r), (v) => ({ ...passed(0), log: v }), 'verify/b/0.log'],
          ['end tree_end', V.parseEnd, (v) => ({ ...ended('passed'), tree_end: v }), T1],
          ['verify_attempt.run_id', V.validateStoredAttempt, (v) => ({ v: 1, run_id: v, step: 3, requested: true, handoff: T1, generation: 1 }), RUN],
          ...['run_id', 'baseline', 'declaration_digest', 'workflow_id'].map((k) => [`verify_request.${k}`, (r) => V.validateStoredRequest(r, { verbs }), (v) => rebound({ [k]: v }), req[k]]),
          ['verify_request.answered_by', (r) => V.validateStoredRequest(r, { verbs }), (v) => rebound({ answered_by: v }), 'b1'],
          ...Object.keys(prev).filter((k) => k !== 'end').map((k) => [`verify_request.previous.${k}`, (r) => V.validateStoredRequest(r, { verbs }), (v) => rebound({ previous: { ...prev, [k]: v } }), prev[k]]),
          ['verify_results.request_id', V.validateStoredResults, (v) => ({ ...results, request_id: v }), req.id],
        ];
        for (const [name, check, build, good] of cases) {
          // Control: the string itself is taken, so only its type refuses the array.
          check(build(good));
          for (const depth of DEPTHS) throws(() => check(build(nest(good, depth))), /is not|carried_from/, `${name} nested ${depth}`);
        }
      });
    });

    it('a batch start whose run id is an array nested 2,500 deep is refused, so the size reserve holds', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const req = (await read(wf)).verify_request;
        const before = await readFile(wf, 'utf8');
        await rejects(S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: req.id, input: { ...startInput(req), run_id: nest(RUN, 2500) } }), /run_id is not an autopilot run id/);
        strictEqual(await readFile(wf, 'utf8'), before);
        // And a hand-written record holding one does not read.
        await batch(wf, 'b1', { results: [passed(0)] });
        const text = await readFile(wf, 'utf8');
        const { frontmatter } = S.parseWorkflowFile(text);
        const handWritten = { ...frontmatter.verify_results, batches: [{ ...frontmatter.verify_results.batches[0], run_id: [RUN] }] };
        throws(() => S.parseWorkflowFile(putLine(text, 'verify_results', handWritten)), /run_id is not an autopilot run id/);
      });
    });
  });

  describe(`${persona}: a late write of a step is held to the handoff it last left`, () => {
    // Each write a step can make of the handoff, from step 3.
    const lateWrites = (wf, dir, sha) => {
      const env = offerEnv(sha);
      return [
        ['finish-verb with another kind', () => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Refine', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env, cwd: dir })],
        ['finish-verb with the same request', () => finish(wf, dir, sha)],
        ['append with a next step', () => S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'commit', confidence: 'HIGH' }, env })],
        ['append clearing the next step (Phase 0)', () => S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env })],
        ['set-terminal with a next step', () => S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', terminalMarker: false, nextStep: { kind: 'done', confidence: 'HIGH' }, env })],
      ];
    };
    const STALE = /the handoff changed since step 3 last wrote it/;
    const commitStep = (wf, dir, env) => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Commit', nextStep: { kind: 'commit', confidence: 'HIGH' }, env, cwd: dir });
    const refineStep = (wf, dir, env) => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Refine', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env, cwd: dir });
    // A writer from a release before this one: it edits the handoff and
    // carries verify_attempt and verify_handoff as written, so it moves no
    // generation.
    const olderWrite = async (wf, edit) => {
      const text = await readFile(wf, 'utf8');
      const { frontmatter, body } = S.parseWorkflowFile(text);
      const mark = frontmatter.verify_attempt;
      edit(frontmatter);
      const kept = text.match(/^verify_handoff: .*$/m)[0];
      const out = S.assembleWorkflowFile(frontmatter, body).replace(/^verify_handoff: .*$/m, () => kept);
      await writeFile(wf, out);
      return mark;
    };
    const generationOf = async (wf) => (await read(wf)).verify_handoff.generation;

    it("the driver's batch start and pass: mid-batch and after the pass, a late finish-verb, append or set-terminal of the requesting step records nothing", async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'b1', { results: [passed(0)] });
        // The batch start leaves the mark as it was: the record no longer
        // holds the handoff step 3 left.
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: true, current: false });
        const mid = await readFile(wf, 'utf8');
        for (const [name, write] of lateWrites(wf, dir, sha)) {
          await rejects(write(), STALE, name);
        }
        strictEqual(await readFile(wf, 'utf8'), mid, 'the batch and its results stand');
        // A late write of the step that leaves the handoff as it found it (a
        // note) is held to the mark all the same: it records nothing.
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Late note', phaseNote: 'A note only.', env: offerEnv(sha) }), STALE);
        strictEqual(await readFile(wf, 'utf8'), mid, 'the late note is not appended');
        // The driver goes on, and passes the batch.
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: passed(1) });
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1', input: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'b1' });
        const passedText = await readFile(wf, 'utf8');
        for (const [name, write] of lateWrites(wf, dir, sha)) {
          await rejects(write(), STALE, name);
        }
        strictEqual(await readFile(wf, 'utf8'), passedText, 'the pass, its request and its results stand');
        const fm = await read(wf);
        deepStrictEqual([fm.next_step_kind, fm.verify_request.answered_by, fm.verify_results.batches[0].end], ['commit', 'b1', 'passed']);
        // Control: the next step's writes are fresh, and move the mark on.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 4, requested: false, current: true });
      });
    });

    it("a later step's write that sets no next step stales it: Phase 7's begin-commit, then commit-complete", async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        // Step 3 ends with commit under the offer.
        await commitStep(wf, dir, offerEnv(sha));
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: false, current: true });
        // Step 4, the commit surface, which the run does not offer
        // verification: the driver numbers it all the same, and its Phase 7
        // begins, moving the phase alone, and the mark on to step 4.
        const step4 = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '4' };
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: step4 });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 4, requested: false, current: true });
        const OLDER = /step 3 is older than step 4, which last wrote the handoff/;
        const begun = await readFile(wf, 'utf8');
        for (const [name, write] of lateWrites(wf, dir, sha)) {
          await rejects(write(), OLDER, `after begin-commit: ${name}`);
        }
        strictEqual(await readFile(wf, 'utf8'), begun);
        // Phase 7 lands: commit-complete with the terminal marker, no next step.
        await S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'commit-complete', env: step4 });
        const committed = await readFile(wf, 'utf8');
        for (const [name, write] of lateWrites(wf, dir, sha)) {
          await rejects(write(), OLDER, `after commit-complete: ${name}`);
        }
        strictEqual(await readFile(wf, 'utf8'), committed, 'the committed workflow stays committed');
        const fm = await read(wf);
        deepStrictEqual([fm.current_phase, fm.terminal_marker, fm.next_step_kind], ['commit-complete', true, 'commit']);
      });
      // A step of a driver that numbers none (an earlier release) cannot be
      // ordered against step 3 of its own run: it writes nothing.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await commitStep(wf, dir, offerEnv(sha));
        const three = await readFile(wf, 'utf8');
        await rejects(S.beginCommit({ workflowPath: wf, host: 'claude', env: { AGENTIC_AUTOPILOT: RUN } }), /a step of autopilot-\S+ that carries no number cannot be ordered against step 3 of its own run/);
        strictEqual(await readFile(wf, 'utf8'), three);
      });
    });

    it("an owner's set-terminal with no next step stales it", async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await refineStep(wf, dir, offerEnv(sha));
        await S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', env: {} });
        const owners = await readFile(wf, 'utf8');
        for (const [name, write] of lateWrites(wf, dir, sha)) {
          await rejects(write(), STALE, name);
        }
        strictEqual(await readFile(wf, 'utf8'), owners, "the owner's terminal write stands");
      });
    });

    it("a run that offers no verification orders runs: its write stales an older run's step, and is stale over a newer run's", async () => {
      const NEW = 'autopilot-20261021T000000Z-bbbbbb';
      // An older offering run's step, then a newer run that offers none.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: { AGENTIC_AUTOPILOT: NEW } });
        await commitStep(wf, dir, { AGENTIC_AUTOPILOT: NEW });
        // The mark orders runs only now: the newer run's, with no step.
        const { current: _c, ...moved } = await markOf(wf);
        deepStrictEqual(moved, { v: 1, run_id: NEW, requested: false });
        const newer = await readFile(wf, 'utf8');
        const old = (n) => offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: String(n) });
        // The older run's delayed step 3, its later step 4, and a step of it
        // that offers nothing: each is older than the newer run.
        await rejects(finish(wf, dir, sha, REQ, { env: old(3) }), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}, which last wrote the handoff`));
        await rejects(refineStep(wf, dir, old(4)), new RegExp(`step 4 of ${RUN} is older than a step of ${NEW}`));
        await rejects(refineStep(wf, dir, { AGENTIC_AUTOPILOT: RUN }), new RegExp(`a step of ${RUN} is older than a step of ${NEW}`));
        strictEqual(await readFile(wf, 'utf8'), newer, "the newer run's handoff stands");
        // The newer run's own steps go on, offering or not.
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: { AGENTIC_AUTOPILOT: NEW } });
        await S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: offerEnv(sha, { AGENTIC_AUTOPILOT: NEW, AGENTIC_AUTOPILOT_STEP: '2' }) });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: NEW, step: 2, requested: false, current: true });
      });
      // A newer offering run's request, then an older run that offers none.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha, REQ, { env: offerEnv(sha, { AGENTIC_AUTOPILOT: NEW, AGENTIC_AUTOPILOT_STEP: '1' }) });
        const requested = await readFile(wf, 'utf8');
        await rejects(commitStep(wf, dir, { AGENTIC_AUTOPILOT: RUN }), new RegExp(`a step of ${RUN} is older than step 1 of ${NEW}, which last wrote the handoff`));
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: { AGENTIC_AUTOPILOT: RUN } }), new RegExp(`a step of ${RUN} is older than step 1 of ${NEW}`));
        strictEqual(await readFile(wf, 'utf8'), requested, "the newer run's request stands");
      });
      // No mark yet: a newer run that offers none commits, and an older
      // offering run's delayed step does not reopen the commit.
      await withWorkflow(async ({ wf, dir, sha }) => {
        const step = { AGENTIC_AUTOPILOT: NEW };
        await commitStep(wf, dir, step);
        const { current: _c, ...first } = await markOf(wf);
        deepStrictEqual(first, { v: 1, run_id: NEW, requested: false }, "the run's first write records its run");
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: step });
        await S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'commit-complete', env: step });
        const committed = await readFile(wf, 'utf8');
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-0-resume', clearNextStep: true, env: offerEnv(sha) }), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}`));
        await rejects(refineStep(wf, dir, offerEnv(sha)), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}`));
        strictEqual(await readFile(wf, 'utf8'), committed, 'the commit stands');
      });
    });

    it('a change undone by writers of this release stales it all the same: each change moves the generation on (F2)', async () => {
      // The owner, outside any run, which leaves the mark where it is: Phase 0
      // clears the next step, and the verb proposes refine again from the same
      // phase. The handoff is back where step 3 left it, two generations on.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: offerEnv(sha) });
        const left = await read(wf);
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-0-resume', clearNextStep: true, env: {} });
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: {} });
        const back = await read(wf);
        strictEqual(V.handoffDigest(back), V.handoffDigest(left), 'the handoff is the one step 3 left');
        strictEqual(back.verify_handoff.generation, left.verify_handoff.generation + 2);
        deepStrictEqual(back.verify_attempt, left.verify_attempt, 'the mark stays on step 3');
        const owners = await readFile(wf, 'utf8');
        await rejects(commitStep(wf, dir, offerEnv(sha)), STALE);
        strictEqual(await readFile(wf, 'utf8'), owners, "the owner's proposal stands");
        // Control: a write that changes nothing moves no generation.
        await S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Owner note', phaseNote: 'A note only.', env: {} });
        strictEqual(await generationOf(wf), back.verify_handoff.generation);
      });
      // Codex's sequence, with this release's writers: a newer run's Phase 0
      // clears the step's refine, and the newer run proposes refine again from
      // the same phase. The older step's delayed commit does not replace it.
      await withWorkflow(async ({ wf, dir, sha }) => {
        const NEW = 'autopilot-20261021T000000Z-bbbbbb';
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: offerEnv(sha) });
        const left = await read(wf);
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-0-resume', clearNextStep: true, env: { AGENTIC_AUTOPILOT: NEW } });
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: { AGENTIC_AUTOPILOT: NEW } });
        strictEqual(V.handoffDigest(await read(wf)), V.handoffDigest(left));
        const newer = await readFile(wf, 'utf8');
        await rejects(commitStep(wf, dir, offerEnv(sha)), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}`));
        strictEqual(await readFile(wf, 'utf8'), newer, "the newer run's proposal stands");
      });
    });

    it('mixed versions: an A to B and back to A by a writer that keeps no generation (an earlier release) is not seen', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await refineStep(wf, dir, offerEnv(sha));
        const gen = await generationOf(wf);
        await olderWrite(wf, (fm) => { delete fm.next_step_verb; fm.next_step_kind = 'commit'; });
        // While changed, the digest sees it.
        await rejects(refineStep(wf, dir, offerEnv(sha)), STALE, 'while changed');
        await olderWrite(wf, (fm) => { fm.next_step_kind = 'verb'; fm.next_step_verb = 'refine'; });
        strictEqual(await generationOf(wf), gen, 'the earlier release moved no generation');
        // Undone, it is not seen: the late write lands on the state step 3
        // left (lib/verify.mjs header). The limit ends once both hosts run
        // this release.
        await commitStep(wf, dir, offerEnv(sha));
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: false, current: true });
      });
    });

    it('every write of a step is held to the mark, one that changes nothing included: an earlier step or run is stale outright (MAJOR 1)', async () => {
      const at = (sha, n) => offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: String(n) });
      // Step 5 resumes into critique and proposes refine. Step 3's delayed
      // writes, each leaving the handoff as it finds it or not, record nothing.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'critique', currentPhase: 'phase-0-resume', clearNextStep: true, env: at(sha, 5) });
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextAction: 'Refine', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: at(sha, 5) });
        const step5 = await readFile(wf, 'utf8');
        const OLDER = /step 3 is older than step 5, which last wrote the handoff/;
        const late = [
          ['a stale next action and verb', () => S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'critique', nextAction: 'Stale', env: at(sha, 3) })],
          ['a critique-run marker', () => S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'critique', phaseLabel: 'Phase 1: Critique (synthesized)', phaseNote: 'Stale.', env: at(sha, 3) })],
          ['a scope-routing gate', () => S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', anchor: 'routing-recommendation', env: at(sha, 3) })],
          ['an older begin-commit', () => S.beginCommit({ workflowPath: wf, host: 'claude', env: at(sha, 3) })],
          ['a pending run', () => S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'critique', run_id: 'critique-late', env: at(sha, 3) })],
        ];
        for (const [name, write] of late) await rejects(write(), OLDER, name);
        strictEqual(await readFile(wf, 'utf8'), step5, "step 5's handoff and notes stand");
      });
      // Step 4 begins Phase 7; step 5 begins it again, which changes nothing
      // and moves the mark on all the same. Step 4's delayed commit-complete
      // and step 3's begin-commit record nothing.
      await withWorkflow(async ({ wf, sha }) => {
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: at(sha, 4) });
        const gen = await generationOf(wf);
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: at(sha, 5) });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 5, requested: false, current: true });
        strictEqual(await generationOf(wf), gen, 'a write that changes nothing moves no generation');
        const step5 = await readFile(wf, 'utf8');
        await rejects(S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'commit-complete', env: at(sha, 4) }), /step 4 is older than step 5/);
        await rejects(S.beginCommit({ workflowPath: wf, host: 'claude', env: at(sha, 3) }), /step 3 is older than step 5/);
        strictEqual(await readFile(wf, 'utf8'), step5);
        // Control: step 5's own write that changes nothing is taken, and
        // leaves the mark as it was.
        const mark = (await read(wf)).verify_attempt;
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: at(sha, 5) });
        deepStrictEqual((await read(wf)).verify_attempt, mark);
      });
    });

    it("a run that offers no verification records its run on its first write, one that changes nothing included (F1)", async () => {
      const NEW = 'autopilot-20261021T000000Z-bbbbbb';
      // An older offering run's step begins Phase 7; a newer run that offers
      // none begins it again. The older step's delayed commit-complete records
      // nothing.
      await withWorkflow(async ({ wf, sha }) => {
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: offerEnv(sha) });
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: { AGENTIC_AUTOPILOT: NEW } });
        const { current: _c, ...moved } = await markOf(wf);
        deepStrictEqual(moved, { v: 1, run_id: NEW, requested: false });
        const newer = await readFile(wf, 'utf8');
        await rejects(S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'commit-complete', env: offerEnv(sha) }), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}`));
        strictEqual(await readFile(wf, 'utf8'), newer);
      });
      // No mark yet: the workflow is already in Phase 7 (the owner began it),
      // and the newer run's first begin-commit changes nothing. It records its
      // run all the same.
      await withWorkflow(async ({ wf, sha }) => {
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: {} });
        ok(!('verify_attempt' in (await read(wf))), "the owner's write records no mark");
        await S.beginCommit({ workflowPath: wf, host: 'claude', env: { AGENTIC_AUTOPILOT: NEW } });
        const { current: _c, ...first } = await markOf(wf);
        deepStrictEqual(first, { v: 1, run_id: NEW, requested: false });
        await rejects(S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'commit-complete', env: offerEnv(sha) }), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}`));
      });
    });

    it('a gate replaced, a verb changed in the same phase, or a pending run, each by a writer that keeps no generation, stales it (MAJOR 2)', async () => {
      // The step stops on a gate; an older writer replaces it.
      await withWorkflow(async ({ wf, sha }) => {
        await S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', anchor: 'routing-recommendation', env: offerEnv(sha) });
        // Control: the step's own later write is taken.
        await S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Routing recommendation', phaseNote: 'Owner: route it.', env: offerEnv(sha) });
        await olderWrite(wf, (fm) => { fm.awaiting_owner_gate = 'pr-handling'; });
        const older = await readFile(wf, 'utf8');
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, env: offerEnv(sha) }), STALE);
        strictEqual(await readFile(wf, 'utf8'), older, "the older writer's gate stands");
      });
    });

    it('a writer that does not know the mark (an older release) stales it: each handoff key changed alone, the mark carried as written', async () => {
      // Each edit such a writer makes, leaving verify_attempt as it is, after
      // the step's write it follows: one key each, the kind from a handoff
      // with no verb.
      const edits = [
        ['next_step_kind', (fm) => { fm.next_step_kind = 'done'; }, commitStep],
        ['next_step_verb', (fm) => { fm.next_step_verb = 'critique'; }, refineStep],
        ['next_step_confidence', (fm) => { fm.next_step_confidence = 'LOW'; }, refineStep],
        ['current_phase', (fm) => { fm.current_phase = 'phase-1-elsewhere'; }, refineStep],
        ['terminal_marker', (fm) => { fm.terminal_marker = true; }, refineStep],
        ['verb, in the same phase', (fm) => { fm.verb = 'critique'; }, refineStep],
        ['pending_ensemble', (fm) => { fm.pending_ensemble = [{ phase: 'compose', ensemble_type: 'critique', run_id: 'critique-x', started_at: iso(0) }]; },
          // finish-verb refuses a pending run before the mark: an append.
          (wf, _dir, env) => S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env })],
      ];
      for (const [key, edit, step] of edits) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          await step(wf, dir, offerEnv(sha));
          // Control: before the change, the step's own retry is taken.
          await step(wf, dir, offerEnv(sha));
          const gen = await generationOf(wf);
          const mark = await olderWrite(wf, edit);
          const older = await readFile(wf, 'utf8');
          deepStrictEqual((await read(wf)).verify_attempt, mark, `${key}: the mark is carried as written`);
          strictEqual(await generationOf(wf), gen, `${key}: no generation moved, so only the digest sees it`);
          await rejects(step(wf, dir, offerEnv(sha)), STALE, key);
          strictEqual(await readFile(wf, 'utf8'), older, `${key}: the older writer's handoff stands`);
        });
      }
      // The request alone: its recorded_at, which its id does not bind.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        strictEqual((await finish(wf, dir, sha)).retried, true, "control: the step's own retry is taken");
        await olderWrite(wf, (fm) => { fm.verify_request = { ...fm.verify_request, recorded_at: '2026-10-20T09:09:09Z' }; });
        const older = await readFile(wf, 'utf8');
        await rejects(finish(wf, dir, sha), STALE);
        strictEqual(await readFile(wf, 'utf8'), older);
      });
    });

    it("the step's own consecutive writes are taken, each moving the mark's handoff on", async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const env = offerEnv(sha);
        const writes = [
          ['Phase 0 clear', () => S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-0-resume', clearNextStep: true, env })],
          ['append with a next step', () => S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-1-compose', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env })],
          ['its peer run dispatched', () => S.recordPendingEnsemble({ workflowPath: wf, phase: 'compose', ensemble_type: 'compose', run_id: 'compose-own', env })],
          ['its peer run settled', () => S.commitEnsemble({ workflowPath: wf, phase: 'compose', ensemble_type: 'compose', run_id: 'compose-own', verdict: 'resolved', summary: 'Settled.', env })],
          ['finish-verb with another kind', () => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Critique', nextStep: { kind: 'verb', verb: 'critique', confidence: 'MEDIUM' }, env, cwd: dir })],
          ['finish-verb with a request', () => finish(wf, dir, sha)],
          ['the same request again', () => finish(wf, dir, sha)],
          ['finish-verb with commit', () => commitStep(wf, dir, env)],
          ['set-terminal with a next step', () => S.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', terminalMarker: false, nextStep: { kind: 'done', confidence: 'HIGH' }, env })],
        ];
        for (const [i, [name, write]] of writes.entries()) {
          await write();
          deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: i >= 5, current: true }, name);
        }
      });
    });

    it("after the owner's Phase 0 clear and finish, before uptake, a late write of the requesting step records nothing", async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        // The owner, in an interactive session: Phase 0's clear, then the verb
        // ends with the next verb critique (terminal, interactively).
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-0-resume', clearNextStep: true, env: {} });
        await S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Critique', nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: {}, cwd: dir });
        const owners = await readFile(wf, 'utf8');
        const fm = await read(wf);
        deepStrictEqual([fm.next_step_kind, fm.next_step_verb, fm.terminal_marker], ['verb', 'critique', true]);
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: true, current: false });
        for (const [name, write] of lateWrites(wf, dir, sha)) {
          // Each, the late request included, by the handoff it no longer
          // finds, before anything else is checked.
          await rejects(write(), STALE, name);
        }
        strictEqual(await readFile(wf, 'utf8'), owners, "the owner's next step and terminal marker stand");
      });
    });

    it("each kind of the owner's write stales it alone: a Phase 0 clear, an append, a finish-verb", async () => {
      const owner = (wf, dir) => [
        ['Phase 0 clear', () => S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: {} })],
        ['append with a next step', () => S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: {} })],
        ['finish-verb', () => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Critique', nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: {}, cwd: dir })],
      ];
      for (let i = 0; i < 3; i++) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          // A step that recorded no request: its own late writes are what
          // only the mark refuses.
          await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: offerEnv(sha) });
          // Control: before the owner writes, the step's own retry is fresh.
          await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, env: offerEnv(sha) });
          const [name, write] = owner(wf, dir)[i];
          await write();
          const owners = await readFile(wf, 'utf8');
          deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: false, current: false }, name);
          for (const [late, lateWrite] of lateWrites(wf, dir, sha)) {
            if (late === 'finish-verb with the same request') continue;
            await rejects(lateWrite(), STALE, `${name}, then ${late}`);
          }
          strictEqual(await readFile(wf, 'utf8'), owners, `${name}: the owner's write stands`);
        });
      }
    });

    it('a numbered step of its own run that offers no verification moves the mark on; a step with no number writes nothing beside a numbered one', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const requested = await readFile(wf, 'utf8');
        // A step of a driver that numbers none, in the same run.
        await rejects(commitStep(wf, dir, { AGENTIC_AUTOPILOT: RUN }), /that carries no number cannot be ordered against step 3 of its own run/);
        strictEqual(await readFile(wf, 'utf8'), requested);
        // This driver's step 4, which the run does not offer verification.
        await commitStep(wf, dir, { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '4' });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 4, requested: false, current: true });
        const four = await readFile(wf, 'utf8');
        await rejects(lateWrites(wf, dir, sha)[2][1](), /step 3 is older than step 4/);
        strictEqual(await readFile(wf, 'utf8'), four);
      });
    });

    it("a later step's write past a pending request is taken, and the request's step is then older (Refine-verify of the seventh refine)", async () => {
      const NEW = 'autopilot-20261021T000000Z-bbbbbb';
      for (const [name, later, older, late] of [
        ['step 4 begins Phase 7 again', (wf, sha) => S.beginCommit({ workflowPath: wf, host: 'claude', env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) }), /step 3 is older than step 4/],
        ['a newer run that offers none begins it again', (wf) => S.beginCommit({ workflowPath: wf, host: 'claude', env: { AGENTIC_AUTOPILOT: NEW } }), new RegExp(`step 3 of ${RUN} is older than a step of ${NEW}`)],
        // A request is refused under a gate before the mark: step 3's late
        // append stands for its late writes there.
        ['step 4 sets a gate', (wf, sha) => S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', anchor: 'routing-recommendation', env: offerEnv(sha, { AGENTIC_AUTOPILOT_STEP: '4' }) }), /step 3 is older than step 4/,
          (wf, sha) => S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Late', phaseNote: 'Late.', env: offerEnv(sha) })],
      ]) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          // Step 3, in Phase 7, records a request: pending, its step the mark's.
          await S.beginCommit({ workflowPath: wf, host: 'claude', env: offerEnv(sha) });
          await finish(wf, dir, sha);
          await later(wf, sha);
          const fm = await read(wf);
          strictEqual(fm.next_step_kind, 'verify', `${name}: the request is still pending`);
          strictEqual(fm.verify_attempt.requested, false, `${name}: the mark moved on past it`);
          const text = await readFile(wf, 'utf8');
          await rejects(late ? late(wf, sha) : finish(wf, dir, sha), older, `${name}: a late write of step 3`);
          strictEqual(await readFile(wf, 'utf8'), text);
        });
      }
    });

    it('the ensemble CLI takes the caller\'s host: on Codex an inherited offer is no attempt of its own', async () => {
      const cli = (dir, env, ...args) => spawnSync(process.execPath, [STATE_PATH, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
      for (const host of ['codex', 'claude']) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          await refineStep(wf, dir, offerEnv(sha));
          const pending = cli(dir, offerEnv(sha), 'ensemble-pending', '--workflow-path', wf, '--phase', 'refine', '--ensemble-type', 'refine-verify', '--run-id', 'rv-1', '--host', host);
          strictEqual(pending.status, 0, pending.stderr);
          strictEqual((await markOf(wf)).current, host === 'claude', `${host}: the dispatch alone`);
          const settled = cli(dir, offerEnv(sha), 'ensemble-commit', '--workflow-path', wf, '--run-id', 'rv-1', '--phase', 'refine', '--ensemble-type', 'refine-verify', '--verdict', 'resolved', '--summary', 'Settled.', '--host', host);
          strictEqual(settled.status, 0, settled.stderr);
          // On Codex the writes are not step 3's, so they stale it; on Claude
          // they are step 3's own, and move its mark.
          deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: false, current: host === 'claude' }, host);
          if (host === 'codex') await rejects(commitStep(wf, dir, offerEnv(sha)), STALE);
          else await commitStep(wf, dir, offerEnv(sha));
        });
      }
      await withWorkflow(async ({ wf, dir }) => {
        const bad = cli(dir, {}, 'ensemble-pending', '--workflow-path', wf, '--phase', 'refine', '--ensemble-type', 'refine-verify', '--run-id', 'rv-1', '--host', 'other');
        ok(bad.status !== 0 && /Invalid host: other/.test(bad.stderr), bad.stderr);
      });
    });

    it('a write that leaves the handoff alone stales nothing', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Owner note', phaseNote: 'A note only.', env: {} });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: true, current: true });
        // So the step's own retry, before uptake, is still fresh.
        strictEqual((await finish(wf, dir, sha)).retried, true);
      });
    });
  });

  describe(`${persona}: every write of a workflow is held at its lock, and the driver's step number is the step's attempt`, () => {
    // A step of this release's driver, numbered whether or not the run offers
    // verification (it offers none here).
    const at = (n, run = RUN) => ({ AGENTIC_AUTOPILOT: run, AGENTIC_AUTOPILOT_STEP: String(n) });
    const STALE3 = /the handoff changed since step 3 last wrote it/;
    const refine = { kind: 'verb', verb: 'refine', confidence: 'HIGH' };
    const finishWith = (wf, dir, nextStep, env) => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Next', nextStep, env, cwd: dir });
    // Each kind of writer that is not a verb's own handoff write, as a step
    // makes it: none is listed anywhere, the lock holds them all.
    const writers = (wf, dir, env) => [
      ['a checkpoint', () => S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env })],
      ['a manifest entry (the staging set)', () => S.recordComposedFile({ workflowPath: wf, path: 'tests/a.mjs', op: 'edit', env })],
      ['a snapshot', () => S.snapshot({ workflowPath: wf, host: 'claude', trigger: 'stop', env })],
      ['the parent writeback marker', () => S.setParentWritebackMarker({ workflowPath: wf, host: 'claude', at: iso(9), env })],
      ['a detach (Codex\'s stale archive)', () => S.detachArchive({ workflowPath: wf, host: 'claude', repoRoot: dir, env })],
      ['an archive', () => S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env })],
    ];

    it("an earlier step's delayed write of any kind records nothing, and the active workflow stays where it is", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextStep: refine, env: at(5) });
        const five = await readFile(wf, 'utf8');
        for (const [name, write] of writers(wf, dir, at(3))) {
          await rejects(write(), /step 3 is older than step 5, which last wrote the handoff/, name);
          strictEqual(await readFile(wf, 'utf8'), five, `${name}: the workflow stays as step 5 left it, active`);
        }
        // Control: step 5's own checkpoint is taken.
        await S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Step 5.', env: at(5) });
        strictEqual((await read(wf)).latest_checkpoint.summary, 'Step 5.');
      });
    });

    it("the step's delayed write after another writer changed the handoff records nothing, whatever its kind", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-2-presented', nextStep: refine, env: at(3) });
        // The owner, outside any run: the next step is done.
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: { kind: 'done', confidence: 'HIGH' }, env: {} });
        const owners = await readFile(wf, 'utf8');
        for (const [name, write] of writers(wf, dir, at(3))) {
          await rejects(write(), STALE3, name);
          strictEqual(await readFile(wf, 'utf8'), owners, `${name}: the owner's handoff stands`);
        }
      });
    });

    it("a newer run's first checkpoint records its mark, so an older run's delayed write is then stale", async () => {
      const NEW = 'autopilot-20261021T000000Z-bbbbbb';
      for (const newer of [at(1, NEW), { AGENTIC_AUTOPILOT: NEW }]) {
        // After an older run's step, and on a workflow with no mark yet.
        for (const before of [true, false]) {
          await withWorkflow(async ({ wf, dir }) => {
            if (before) await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
            await S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Newer run.', env: newer });
            const { current: _c, ...mark } = await markOf(wf);
            deepStrictEqual(mark, { v: 1, run_id: NEW, ...(newer.AGENTIC_AUTOPILOT_STEP ? { step: 1 } : {}), requested: false }, JSON.stringify({ newer, before }));
            const text = await readFile(wf, 'utf8');
            await rejects(finishWith(wf, dir, { kind: 'commit', confidence: 'HIGH' }, at(3)), new RegExp(`step 3 of ${RUN} is older than`));
            strictEqual(await readFile(wf, 'utf8'), text);
          });
        }
      }
    });

    it("Codex's sequence: run R's step writes refine, the owner writes done, R's delayed write of that step tries commit and records nothing", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        // R's step 3, which the run does not offer verification.
        await finishWith(wf, dir, refine, at(3));
        // The owner, in an interactive session.
        await finishWith(wf, dir, { kind: 'done', confidence: 'HIGH' }, {});
        const owners = await readFile(wf, 'utf8');
        await rejects(finishWith(wf, dir, { kind: 'commit', confidence: 'HIGH' }, at(3)), STALE3);
        strictEqual(await readFile(wf, 'utf8'), owners, "the owner's done stands");
        strictEqual((await read(wf)).next_step_kind, 'done');
      });
    });

    it("the operator's recovery: a gate cleared while the run is live (a note beside it changes no handoff); the step that left the gate is stale, the run's next step writes", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        // Step 3 stops on a gate.
        await S.appendPhase({
          workflowPath: wf, host: 'claude', phaseLabel: 'Routing recommendation', phaseNote: 'Owner: route it.',
          nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' }, env: at(3),
        });
        // The operator, outside the run: clears the gate, and appends a note,
        // which alone would stale no step (it is outside the handoff).
        await S.clearAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', nextStep: refine, resolution: 'Route it to refine.', env: {} });
        await S.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Operator note', phaseNote: 'Picked up again.', env: {} });
        const operators = await readFile(wf, 'utf8');
        // Step 3's delayed write records nothing.
        await rejects(S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', anchor: 'routing-recommendation', env: at(3) }), STALE3);
        await rejects(finishWith(wf, dir, { kind: 'commit', confidence: 'HIGH' }, at(3)), STALE3);
        strictEqual(await readFile(wf, 'utf8'), operators, "the operator's clear and note stand");
        // The run picks the lane up again: step 4 starts after the change, at
        // its Phase 0, and writes.
        await S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'refine', currentPhase: 'phase-0-resume', clearNextStep: true, phaseLabel: 'Phase 0: Resume into refine', env: at(4) });
        await finishWith(wf, dir, { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, at(4));
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 4, requested: false, current: true });
        // And step 3, older than step 4 now, still records nothing.
        await rejects(S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env: at(3) }), /step 3 is older than step 4/);
      });
    });

    it("a workflow created under a numbered step records that step's mark: the creating step's delayed write after the owner's done records nothing (Refine-verify F1)", async () => {
      const { dir } = await makeRepo();
      repos.push(dir);
      const { filePath: wf } = await S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude', env: at(3),
        gitBaseline: { branch: 'feat/x', head: git(dir, 'rev-parse', 'HEAD'), status_digest: '' },
        originalRequest: 'created by step 3', currentPhase: 'phase-0-bootstrap',
      });
      deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: false, current: true }, 'the creation is the step\'s first write');
      await finishWith(wf, dir, { kind: 'done', confidence: 'HIGH' }, {});
      const owners = await readFile(wf, 'utf8');
      await rejects(finishWith(wf, dir, { kind: 'commit', confidence: 'HIGH' }, at(3)), STALE3);
      strictEqual(await readFile(wf, 'utf8'), owners, "the owner's done stands");
      // Control: created outside any run, the workflow holds no mark.
      const { dir: d2 } = await makeRepo();
      repos.push(d2);
      const { filePath: plain } = await S.createWorkflow({
        repoRoot: d2, verb: 'compose', host: 'claude', env: {},
        gitBaseline: { branch: 'feat/x', head: git(d2, 'rev-parse', 'HEAD'), status_digest: '' },
        originalRequest: 'created by the owner', currentPhase: 'phase-0-bootstrap',
      });
      ok(!('verify_attempt' in (await read(plain))));
    });

    it('a write beside the workflow, its first of the step, moves the mark on: a consensus task file of step 5 makes step 3 older', async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        // The owner settles a conflict, which the consensus task file needs.
        await S.commitEnsemble({ workflowPath: wf, run_id: 'critique-c1', phase: 'critique', ensemble_type: 'critique', verdict: 'conflict', summary: 'Conflict.', env: {} });
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(4) });
        // Step 5's first write is the task file beside the workflow.
        await S.writeConsensusTask({ workflowPath: wf, runId: 'critique-c1', text: 'Item 1.', host: 'claude', env: at(5) });
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 5, requested: false, current: true });
        await rejects(S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env: at(4) }), /step 4 is older than step 5/);
        // Its own next write is taken.
        await finishWith(wf, dir, { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, at(5));
      });
    });

    it("the manifest and review-ledger commands take the caller's host: on Codex an inherited run is no attempt of its own (Refine-verify F2)", async () => {
      const cli = (dir, env, ...args) => spawnSync(process.execPath, [STATE_PATH, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(5) });
        for (const [args, name] of [
          [['record-composed-file', '--workflow-path', wf, '--path', 'tests/a.mjs', '--op', 'edit'], 'record-composed-file'],
          [['record-refine-file', '--workflow-path', wf, '--path', 'tests/a.mjs', '--op', 'edit'], 'record-refine-file'],
          [['critique-scope', '--workflow-path', wf, '--repo-root', dir], 'critique-scope'],
        ]) {
          const codex = cli(dir, at(3), ...args, '--host', 'codex');
          strictEqual(codex.status, 0, `${name} --host codex: ${codex.stderr}`);
          const claude = cli(dir, at(3), ...args, '--host', 'claude');
          ok(claude.status !== 0 && /step 3 is older than step 5/.test(claude.stderr), `${name} --host claude: ${claude.stderr}`);
        }
        const bad = cli(dir, {}, 'record-composed-file', '--workflow-path', wf, '--path', 'tests/a.mjs', '--op', 'edit', '--host', 'other');
        ok(bad.status !== 0 && /Invalid host: other/.test(bad.stderr), bad.stderr);
      });
    });

    it('the lock admits nothing for a file not there yet, and nothing with hold off (an archive destination)', async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(5) });
        // Control: an older step is refused at the lock, before the writer runs.
        let ran = false;
        await rejects(S.withFileLock(wf, async () => { ran = true; }, { env: at(3) }), /step 3 is older than step 5/);
        strictEqual(ran, false, 'the writer never ran');
        strictEqual(await S.withFileLock(wf, async ({ held }) => held, { env: at(3), hold: false }), null);
        strictEqual(await S.withFileLock(join(dir, 'not-yet.md'), async ({ held }) => held, { env: at(3) }), null);
        // Outside any run nothing is admitted either.
        strictEqual(await S.withFileLock(wf, async ({ held }) => held, { env: {} }), null);
      });
    });

    it("a non-document critique-scope that moves a ledger aside, its step's first write, moves the mark on before the move (eighth critique MAJOR 1)", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        // A ledger a document critique left, which this non-document critique moves aside.
        const ledger = join(dirname(dirname(wf)), 'reviews', `${(await read(wf)).workflow_id}.json`);
        await mkdir(dirname(ledger), { recursive: true });
        await writeFile(ledger, '{}\n');
        const scope = await S.openCritiqueScope({ workflowPath: wf, repoRoot: dir, env: at(4), host: 'claude' });
        strictEqual(scope.recorded, false);
        ok(typeof scope.ledger_moved_aside === 'string', 'the ledger was moved aside');
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 4, requested: false, current: true });
        const four = await readFile(wf, 'utf8');
        for (const [name, write] of writers(wf, dir, at(3))) {
          await rejects(write(), /step 3 is older than step 4/, name);
          strictEqual(await readFile(wf, 'utf8'), four, name);
        }
      });
    });

    it('a side write that fails after its step moved the mark on leaves the mark on that step, and the step before it stays refused (eighth critique MAJOR 2)', async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        await S.commitEnsemble({ workflowPath: wf, run_id: 'critique-c1', phase: 'critique', ensemble_type: 'critique', verdict: 'conflict', summary: 'Conflict.', env: {} });
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(4) });
        // The task file cannot be published: a file stands where its directory goes.
        const consensus = join(dirname(dirname(wf)), 'consensus');
        await writeFile(consensus, 'not a directory\n');
        await rejects(S.writeConsensusTask({ workflowPath: wf, runId: 'critique-c1', text: 'Item 1.', host: 'claude', env: at(5) }), /EEXIST|ENOTDIR/);
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 5, requested: false, current: true }, 'the mark moved on before the side write');
        const five = await readFile(wf, 'utf8');
        await rejects(S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env: at(4) }), /step 4 is older than step 5/);
        strictEqual(await readFile(wf, 'utf8'), five);
        // Control: once the directory can be made, step 5 publishes its task.
        await rm(consensus);
        await S.writeConsensusTask({ workflowPath: wf, runId: 'critique-c1', text: 'Item 1.', host: 'claude', env: at(5) });
        // A task that is refused before it is published moves no mark.
        await rejects(S.writeConsensusTask({ workflowPath: wf, runId: 'critique-none', text: 'Item 1.', host: 'claude', env: at(6) }), /no ensemble result/);
        strictEqual((await markOf(wf)).step, 5);
      });
    });

    it('a creation is admitted against the workflows archived on its branch: an older step or run creates nothing after a newer step archived (eighth critique MAJOR 3)', async () => {
      const OLDER = 'autopilot-20261019T000000Z-aaaaaa';
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archived = await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: at(4) });
        strictEqual(archived.archived, true);
        const create = (env, branch = 'feat/x') => S.createWorkflow({
          repoRoot: dir, verb: 'compose', host: 'claude', env,
          gitBaseline: { branch, head: sha, status_digest: '' }, originalRequest: 'late', currentPhase: 'phase-0-bootstrap',
        });
        await rejects(create(at(3)), /step 3 is older than step 4, which last wrote .*, archived on branch feat\/x/);
        await rejects(create(at(7, OLDER)), /older than step 4 of/);
        strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, 'the branch holds no fresh workflow');
        // Control: another branch is not held to it, nor is the owner, nor a later step.
        const other = await create(at(3), 'feat/y');
        await S.archiveWorkflow({ workflowPath: other.filePath, host: 'claude', repoRoot: dir, env: {} });
        const later = await create(at(5));
        deepStrictEqual(await markOf(later.filePath), { v: 1, run_id: RUN, step: 5, requested: false, current: true });
      });
    });

    it("an archive whose source lock was reclaimed, and the file rewritten, refuses and leaves both files as they are (eighth critique MAJOR 4)", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const newer = `${(await readFile(wf, 'utf8')).trimEnd()}\n\nNewer state, written by the writer that reclaimed the lock.\n`;
        const archiveDirectory = join(dir, 'archive-out');
        // The reclaim, injected where the archive has read the source under its
        // lock: another writer's token, then that writer's newer bytes.
        const recheck = () => {
          writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer');
          writeFileSync(wf, newer);
          return [];
        };
        await rejects(S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, recheck, env: at(3) }), /was reclaimed as stale by another writer, or the file changed/);
        strictEqual(await readFile(wf, 'utf8'), newer, 'the active workflow holds the newer state');
        deepStrictEqual(readdirSync(archiveDirectory), [], 'nothing was archived');
        await rm(`${wf}.lock`, { force: true });
        // Control: with the lock its own, the archive goes ahead.
        strictEqual((await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, env: {} })).archived, true);
      });
    });

    it("an archive whose source lock was reclaimed once it checked the lock, before it wrote the destination, publishes nothing and leaves the active workflow as it is (eighth critique MAJOR 4)", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const newer = `${(await readFile(wf, 'utf8')).trimEnd()}\n\nNewer state, written by the writer that reclaimed the lock.\n`;
        const archiveDirectory = join(dir, 'archive-out');
        await mkdir(archiveDirectory, { recursive: true });
        // An earlier archive of the same name, so the destination is chosen
        // with a stamp: the archive reads its clock a second time there, after
        // its first check and before the destination is written, and the
        // reclaim is injected at that read.
        const earlier = join(archiveDirectory, wf.split('/').pop());
        writeFileSync(earlier, 'An earlier archive.\n');
        let reads = 0;
        const now = {
          valueOf() {
            reads += 1;
            if (reads === 2) {
              writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer');
              writeFileSync(wf, newer);
            }
            return Date.parse('2026-10-23T08:00:00Z');
          },
        };
        await rejects(S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, now, env: at(3) }), /was reclaimed as stale by another writer, or the file changed/);
        ok(reads >= 2, 'the reclaim was injected between the checks');
        strictEqual(await readFile(wf, 'utf8'), newer, 'the active workflow holds the newer state');
        deepStrictEqual(readdirSync(archiveDirectory), [earlier.split('/').pop()], 'no destination was published');
      });
    });

    for (const [what, reclaim] of [
      ['its lock token only', (wf) => writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer')],
      ['its bytes only', (wf) => writeFileSync(wf, `${readFileSync(wf, 'utf8').trimEnd()}\n\nNewer state, written under the same lock.\n`)],
    ]) {
      it(`an archive refuses when the source changed ${what} once it read it (stillHeld checks the lock and the bytes)`, async () => {
        await withWorkflow(async ({ wf, dir }) => {
          await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
          const archiveDirectory = join(dir, 'archive-out');
          let left = null;
          const recheck = () => {
            reclaim(wf);
            left = readFileSync(wf, 'utf8');
            return [];
          };
          await rejects(S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, recheck, env: at(3) }), /was reclaimed as stale by another writer, or the file changed/);
          strictEqual(await readFile(wf, 'utf8'), left, 'the active workflow is left as it is');
          deepStrictEqual(readdirSync(archiveDirectory), [], 'nothing was archived');
          await rm(`${wf}.lock`, { force: true });
        });
      });
    }

    // Refine-verify F1 (2026-10-23): the archive's admission lands in the
    // active file before the destination, so a failure or a kill before the
    // source is removed leaves the archiving step's mark, never the earlier one.
    it('an archive under a run that fails to remove its source leaves its own mark in the active file, and the earlier step refused (refine-verify F1)', { skip: process.getuid?.() === 0 && 'root ignores the directory mode the failure is injected with' }, async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archiveDirectory = join(dir, 'archive-out');
        await mkdir(archiveDirectory, { recursive: true });
        // An earlier archive of the same name, so the archive reads its clock a
        // second time once the destination is chosen: the source directory is
        // made read-only there, and removing the source fails.
        writeFileSync(join(archiveDirectory, wf.split('/').pop()), 'An earlier archive.\n');
        let reads = 0;
        const now = {
          valueOf() {
            reads += 1;
            if (reads === 2) chmodSync(dirname(wf), 0o500);
            return Date.parse('2026-10-23T08:00:00Z');
          },
        };
        try {
          await rejects(S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, now, env: at(4) }), /EACCES|EPERM/);
        } finally {
          chmodSync(dirname(wf), 0o700);
        }
        await rm(`${wf}.lock`, { force: true });
        strictEqual((await markOf(wf)).step, 4, 'the active file holds the archiving step mark');
        ok((await read(wf)).host_history.every((h) => h.event !== 'archived'), 'a workflow still active records no archive');
        await rejects(S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env: at(3) }), /step 3 is older than step 4/);
      });
    });

    // Refine-verify F2 (2026-10-23): a ledger move checks the lock immediately
    // before it, so a step whose lock was reclaimed after its mark moved on
    // never moves away the ledger the new owner published.
    it('a ledger move whose lock was reclaimed after the mark moved on moves nothing (refine-verify F2)', async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const ledger = join(dirname(dirname(wf)), 'reviews', `${(await read(wf)).workflow_id}.json`);
        await mkdir(dirname(ledger), { recursive: true });
        await writeFile(ledger, '{}\n');
        // The reclaim, injected at the clock read that names the moved ledger,
        // once step 4's mark is in the workflow: another writer's token, then
        // that writer's newer ledger.
        const realNow = Date.now;
        let fired = false;
        Date.now = () => {
          if (!fired && /step\\?"\s*:\s*4\b/.test(readFileSync(wf, 'utf8'))) {
            fired = true;
            writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer');
            writeFileSync(ledger, '{"newer": true}\n');
          }
          return realNow();
        };
        try {
          await rejects(S.openCritiqueScope({ workflowPath: wf, repoRoot: dir, env: at(4), host: 'claude' }), /reclaimed/);
        } finally {
          Date.now = realNow;
        }
        ok(fired, 'the reclaim was injected after the mark moved on');
        strictEqual(await readFile(ledger, 'utf8'), '{"newer": true}\n', 'the newer ledger stays current');
        await rm(`${wf}.lock`, { force: true });
      });
    });

    // Refine-verify F3 (2026-10-23): a creation holds the step its archived
    // record's mark names to the handoff it left, as admitAttempt does.
    it('the step a mark names creates nothing once the handoff it left changed and the workflow was archived (refine-verify F3)', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-9-owner', env: {} });
        await rejects(S.setCheckpoint({ workflowPath: wf, host: 'claude', summary: 'Late.', env: at(3) }), /the handoff changed since step 3/);
        strictEqual((await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: {} })).archived, true);
        const create = (env) => S.createWorkflow({
          repoRoot: dir, verb: 'compose', host: 'claude', env,
          gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: 'late', currentPhase: 'phase-0-bootstrap',
        });
        await rejects(create(at(3)), /changed since step 3 last wrote it/);
        strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null);
        // Control: the next step creates.
        await create(at(4));
      });
    });

    // The same rule through the generation: the owner moves the phase away
    // and back, so the archived record holds the handoff step 3 left, at a
    // later generation.
    it('the step a mark names creates nothing after the owner changed the handoff and changed it back before the archive (refine-verify F3, A to B and back to A)', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const before = V.handoffState(await read(wf));
        const phase = (await read(wf)).current_phase;
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-9-owner', env: {} });
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: phase, env: {} });
        const archived = await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: {} });
        strictEqual(archived.archived, true);
        const after = V.handoffState((await S.readWorkflow(archived.to)).frontmatter);
        strictEqual(after.digest, before.digest, 'the archived record holds the handoff step 3 left');
        strictEqual(after.generation, before.generation + 2, 'at a later generation');
        const create = (env) => S.createWorkflow({
          repoRoot: dir, verb: 'compose', host: 'claude', env,
          gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: 'late', currentPhase: 'phase-0-bootstrap',
        });
        await rejects(create(at(3)), /changed since step 3 last wrote it/);
        // Control: the next step creates.
        await create(at(4));
      });
    });

    // A function of fs/promises replaced while `body` runs, where the state
    // helpers' named imports read it, then put back.
    const patched = async (patches, body) => {
      const saved = Object.fromEntries(Object.keys(patches).map((k) => [k, fsp[k]]));
      for (const [k, make] of Object.entries(patches)) fsp[k] = make(saved[k]);
      syncBuiltinESMExports();
      try {
        return await body();
      } finally {
        Object.assign(fsp, saved);
        syncBuiltinESMExports();
      }
    };

    // Refine-verify N1 (2026-10-24): the archive's mark write commits only
    // over the bytes the archive read, checked at its commit, not before it.
    it("an archive's mark write keeps a change made under the same lock once the archive checked the bytes: nothing is overwritten or archived away (refine-verify N1)", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archiveDirectory = join(dir, 'archive-out');
        const edit = '\nAn edit under the same lock, once the archive checked the bytes.\n';
        let armed = false;
        let injected = false;
        // Once the gate passed, the archive's first read of the source is its
        // first check: the edit lands after that read, before step 4's mark is
        // written, and the lock token stays the archive's.
        await patched({
          readFile: (readFile0) => async (path, ...rest) => {
            const text = await readFile0(path, ...rest);
            if (armed && !injected && String(path) === wf) {
              injected = true;
              writeFileSync(wf, `${text}${edit}`);
            }
            return text;
          },
        }, () => rejects(
          S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, recheck: () => { armed = true; return []; }, env: at(4) }),
          /was reclaimed as stale by another writer, or the file changed/,
        ));
        ok(injected, 'the edit landed after the first check');
        ok((await readFile(wf, 'utf8')).endsWith(edit), 'the active workflow keeps the edit');
        strictEqual((await markOf(wf)).step, 3, 'the refused mark write moved no mark');
        deepStrictEqual(readdirSync(archiveDirectory), [], 'nothing was archived');
      });
    });

    // Refine-verify N2 (2026-10-24): the destination is published only while
    // the source's lock and bytes are still the archive's, at the commit.
    it('an archive whose source was reclaimed before it published its destination publishes nothing, even when it is stopped before it could take one back (refine-verify N2)', async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archiveDirectory = join(dir, 'archive-out');
        const destinationLock = join(archiveDirectory, `${wf.split('/').pop()}.lock`);
        let newer = null;
        // The reclaim, injected when the archive takes the destination's lock,
        // once step 4's mark is in the active file: another writer's token,
        // then that writer's newer bytes.
        // An archive stopped after a publication (a kill) never takes the
        // destination back: its removal fails here.
        await patched({
          open: (open0) => async (path, ...rest) => {
            if (newer === null && String(path) === destinationLock) {
              writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer');
              newer = `${readFileSync(wf, 'utf8').trimEnd()}\n\nNewer state, written by the writer that reclaimed the lock.\n`;
              writeFileSync(wf, newer);
            }
            return open0(path, ...rest);
          },
          unlink: (unlink0) => async (path) => {
            if (String(path).startsWith(`${archiveDirectory}/`) && String(path).endsWith('.md')) {
              throw Object.assign(new Error('the archive was stopped'), { code: 'EINTR' });
            }
            return unlink0(path);
          },
        }, () => rejects(
          S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, env: at(4) }),
          /was reclaimed as stale by another writer, or the file changed/,
        ));
        ok(newer !== null, 'the reclaim was injected before the publication');
        strictEqual(await readFile(wf, 'utf8'), newer, 'the active workflow holds the newer state');
        deepStrictEqual(readdirSync(archiveDirectory).filter((n) => n.endsWith('.md')), [], 'no older archive stands beside it');
        await rm(`${wf}.lock`, { force: true });
      });
    });

    // The check's place (Refine-verify of N1 and N2, 2026-10-24): at the
    // commit, after the write's bytes are on disk, not before the write.
    it("an archive's mark write checks the source once its own bytes are written: a change made while the mark was being written is kept (refine-verify N1, the check's place)", async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archiveDirectory = join(dir, 'archive-out');
        const edit = '\nAn edit under the same lock, while the mark was being written.\n';
        let armed = false;
        let injected = false;
        // The edit lands when the mark's temporary file is closed, its bytes
        // written and synced, before the rename.
        await patched({
          open: (open0) => async (path, ...rest) => {
            const handle = await open0(path, ...rest);
            if (armed && !injected && String(path).startsWith(`${wf}.`) && String(path).endsWith('.tmp')) {
              const close0 = handle.close.bind(handle);
              handle.close = async () => {
                await close0();
                injected = true;
                writeFileSync(wf, `${readFileSync(wf, 'utf8')}${edit}`);
              };
            }
            return handle;
          },
        }, () => rejects(
          S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, recheck: () => { armed = true; return []; }, env: at(4) }),
          /was reclaimed as stale by another writer, or the file changed/,
        ));
        ok(injected, 'the edit landed once the mark was written');
        ok((await readFile(wf, 'utf8')).endsWith(edit), 'the active workflow keeps the edit');
        strictEqual((await markOf(wf)).step, 3, 'the refused mark write moved no mark');
        deepStrictEqual(readdirSync(archiveDirectory), [], 'nothing was archived');
      });
    });

    // Eighth critique MAJOR 4, after the publication: the check before the
    // source is removed is the one that sees a reclaim once the destination
    // is published, and takes the destination back.
    it('an archive whose source lock was reclaimed once it published its destination takes the destination back and leaves the active workflow as it is (eighth critique MAJOR 4, after the publication)', async () => {
      await withWorkflow(async ({ wf, dir }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archiveDirectory = join(dir, 'archive-out');
        let newer = null;
        // The reclaim, injected once the destination's rename returned:
        // another writer's token, then that writer's newer bytes.
        await patched({
          rename: (rename0) => async (from, to) => {
            await rename0(from, to);
            if (newer === null && String(to).startsWith(`${archiveDirectory}/`) && String(to).endsWith('.md')) {
              writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer');
              newer = `${readFileSync(wf, 'utf8').trimEnd()}\n\nNewer state, written by the writer that reclaimed the lock.\n`;
              writeFileSync(wf, newer);
            }
          },
        }, () => rejects(
          S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, archiveDirectory, env: at(4) }),
          /was reclaimed as stale by another writer, or the file changed/,
        ));
        ok(newer !== null, 'the reclaim was injected after the publication');
        strictEqual(await readFile(wf, 'utf8'), newer, 'the active workflow holds the newer state');
        deepStrictEqual(readdirSync(archiveDirectory).filter((n) => n.endsWith('.md')), [], 'the destination was taken back');
        await rm(`${wf}.lock`, { force: true });
      });
    });

    // Refine-verify F2 at the two moves of a document critique's ledger: one
    // that cannot be read, and one a critique ran past without recording.
    for (const route of ['unreadable', 'unrecorded-critique']) {
      it(`a document critique's ledger move (${route}) whose lock was reclaimed after the mark moved on moves nothing (refine-verify F2)`, async () => {
        await withWorkflow(async ({ wf, dir }) => {
          await mkdir(join(dir, 'docs'), { recursive: true });
          await writeFile(join(dir, 'docs/plan.md'), '# Plan\n\nA document deliverable.\n');
          const ledger = join(dirname(dirname(wf)), 'reviews', `${(await read(wf)).workflow_id}.json`);
          if (route === 'unreadable') {
            await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
            await mkdir(dirname(ledger), { recursive: true });
            await writeFile(ledger, '{}\n');
          } else {
            await S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'critique', env: at(3) });
            const opened = await S.openCritiqueScope({ workflowPath: wf, repoRoot: dir, env: at(3), host: 'claude' });
            strictEqual(opened.recorded, true);
            await S.closeCritiqueScope({ workflowPath: wf, repoRoot: dir, ledgerId: opened.ledger, generation: opened.generation, input: { findings: [] }, env: at(3), host: 'claude' });
            // Two critiques the ledger never recorded.
            for (let i = 0; i < 2; i++) await S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'critique', env: at(3) });
          }
          // The new owner's ledger: one that cannot be read either, or the
          // recorded one written again.
          const kept = route === 'unreadable' ? '{"newer": true}\n' : await readFile(ledger, 'utf8');
          const realNow = Date.now;
          let fired = false;
          Date.now = () => {
            if (!fired && /step\\?"\s*:\s*4\b/.test(readFileSync(wf, 'utf8'))) {
              fired = true;
              writeFileSync(`${wf}.lock`, 'reclaimed-by-another-writer');
              writeFileSync(ledger, kept);
            }
            return realNow();
          };
          try {
            await rejects(S.openCritiqueScope({ workflowPath: wf, repoRoot: dir, env: at(4), host: 'claude' }), /reclaimed/);
          } finally {
            Date.now = realNow;
          }
          ok(fired, 'the reclaim was injected after the mark moved on');
          strictEqual(await readFile(ledger, 'utf8'), kept, 'the newer ledger stays current');
          await rm(`${wf}.lock`, { force: true });
          // Control: with the lock its own, the next step moves the ledger aside
          // on the same route.
          const moved = await S.openCritiqueScope({ workflowPath: wf, repoRoot: dir, env: at(5), host: 'claude' });
          ok(String(moved.ledger_moved_aside).includes(route === 'unreadable' ? '.unreadable-' : '.superseded-'), JSON.stringify(moved));
        });
      });
    }

    // Ninth critique MAJOR 1 (2026-10-24): with shared creation on and the
    // record written to a home other than the repository's, a creation holds
    // two creation locks, and commits only while it holds both, checked at its
    // commit. The reclaim is injected once the step's temporary file is opened
    // in the home it writes: another writer takes the repository's lock, and
    // step 4 creates and archives on the branch, before step 3 commits.
    for (const shared of [true, false]) {
      it(`a creation whose repository creation lock was reclaimed before its commit publishes nothing (ninth critique MAJOR 1${shared ? ', two locks' : ', control: one lock'})`, async () => {
        const made = await makeRepo();
        repos.push(made.dir);
        // The paths the state helpers write, resolved (a temporary directory
        // can sit behind a link).
        const dir = realpathSync(made.dir);
        const { sha } = made;
        const lane = `${dir}-lane`;
        repos.push(lane);
        git(dir, 'worktree', 'add', '-q', '-b', 'feat/lane', lane);
        await mkdir(join(dir, '.agentic-plugins/state'), { recursive: true });
        await writeFile(join(dir, '.agentic-plugins/state/shared-creation.json'), JSON.stringify({
          schema: 'agentic-shared-creation-1.0', enabled: true, enabled_at: '2026-10-08T00:00:00Z', versions: {},
        }));
        const repositoryLock = join(dir, S.creationLockRel());
        // Shared: step 3 writes the lane's home, under the repository's lock
        // and the lane's. Control: it writes the repository's, under that one
        // lock, which the injection reclaims.
        const target = shared ? lane : dir;
        const home = `${join(target, P.workflowDirRel)}/`;
        const create = (env, repoRoot, request) => S.createWorkflow({
          repoRoot, verb: 'compose', host: 'claude', env,
          gitBaseline: { branch: 'feat/lane', head: sha, status_digest: '' }, originalRequest: request, currentPhase: 'phase-0-bootstrap',
        });
        let fired = false;
        let archived = null;
        // Injected once step 3's bytes are written, as its temporary file is
        // synced: a check made before the write would miss it (refine-verify
        // F4).
        await patched({
          open: (open0) => async (path, ...rest) => {
            const handle = await open0(path, ...rest);
            if (!fired && String(path).startsWith(home) && String(path).endsWith('.tmp')) {
              const sync0 = handle.sync.bind(handle);
              handle.sync = async () => {
                await sync0();
                fired = true;
                writeFileSync(repositoryLock, 'reclaimed-by-another-writer');
                await rm(repositoryLock);
                const four = await create(at(4), dir, 'step 4');
                archived = await S.archiveWorkflow({ workflowPath: four.filePath, host: 'claude', repoRoot: dir, env: at(4) });
              };
            }
            return handle;
          },
        }, () => rejects(create({ ...at(3), AGENTIC_STATE_BASE: target }, lane, 'step 3'), /atomicWrite: ownership mismatch on \S*\.creation-lock immediately before commit/));
        ok(fired, 'the reclaim was injected at step 3\'s commit');
        strictEqual(archived?.archived, true, 'step 4 created and archived on the branch');
        deepStrictEqual(readdirSync(home).filter((n) => n.endsWith('.md')), [], 'no stale active workflow is published');
      });
    }

    // Ninth critique MAJOR 2 (2026-10-24): the archive scan reads each record
    // as the workflows home's reader does, through its frontmatter only, from
    // a regular file opened without blocking.
    it('a FIFO named as an archived workflow refuses a creation under a run at once, and is never waited on (ninth critique MAJOR 2)', async () => {
      const { dir, sha } = await makeRepo();
      repos.push(dir);
      const archive = S.archiveDir(dir);
      await mkdir(archive, { recursive: true });
      const fifo = join(archive, 'junk.md');
      execFileSync('mkfifo', [fifo]);
      const create = (env, branch = 'feat/x') => S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude', env,
        gitBaseline: { branch, head: sha, status_digest: '' }, originalRequest: 'beside a fifo', currentPhase: 'phase-0-bootstrap',
      });
      let timer;
      const outcome = await Promise.race([
        create(at(4)).then(() => 'created', (err) => err),
        new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), 3000); }),
      ]);
      clearTimeout(timer);
      // A reader still waiting on the FIFO is let go, so the run can end.
      if (outcome === 'hung') {
        try { closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); } catch {}
      }
      ok(outcome instanceof Error, `the creation is refused, not ${outcome}`);
      ok(/the archived workflow \S*junk\.md\S* is not a regular file/.test(outcome.message), outcome.message);
      strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, 'nothing was created');
      // Control: with no run, the archive is not scanned, and the creation goes
      // through beside the FIFO.
      await create({}, 'feat/y');
      // Control: a directory named as a record holds no mark, and is passed
      // over under a run, as before.
      await rm(fifo);
      await mkdir(join(archive, 'dir.md'));
      const four = await create(at(4));
      strictEqual((await markOf(four.filePath)).step, 4);
    });

    it('the archive scan reads no body: a marked record padded with a long body still refuses an older step, and no byte of it is read whole (ninth critique MAJOR 2)', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine, env: at(3) });
        const archived = await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: at(4) });
        strictEqual(archived.archived, true);
        appendFileSync(archived.to, Buffer.alloc(4 * 1024 * 1024, 'x'));
        const archive = `${dirname(archived.to)}/`;
        let whole = 0;
        // A whole read through a descriptor counts too (refine-verify R3 of the
        // owner's 2026-10-25 ruling): each descriptor opened on an archived
        // record is tracked until it is closed.
        const archiveFds = new Set();
        const count = (path, value) => {
          if (typeof path === 'number' ? archiveFds.has(path) : String(path).startsWith(archive)) whole += Buffer.byteLength(value ?? '');
          return value;
        };
        const fsSync = createRequire(import.meta.url)('node:fs');
        const readFileSync0 = fsSync.readFileSync;
        const openSync0 = fsSync.openSync;
        const closeSync0 = fsSync.closeSync;
        fsSync.readFileSync = (path, ...rest) => count(path, readFileSync0(path, ...rest));
        fsSync.openSync = (path, ...rest) => {
          const fd = openSync0(path, ...rest);
          if (String(path).startsWith(archive)) archiveFds.add(fd);
          return fd;
        };
        fsSync.closeSync = (fd) => {
          archiveFds.delete(fd);
          return closeSync0(fd);
        };
        try {
          await patched({
            readFile: (readFile0) => async (path, ...rest) => count(path, await readFile0(path, ...rest)),
          }, () => rejects(S.createWorkflow({
            repoRoot: dir, verb: 'compose', host: 'claude', env: at(3),
            gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: 'late', currentPhase: 'phase-0-bootstrap',
          }), /step 3 is older than step 4, which last wrote .*, archived on branch feat\/x/));
        } finally {
          fsSync.readFileSync = readFileSync0;
          fsSync.openSync = openSync0;
          fsSync.closeSync = closeSync0;
          syncBuiltinESMExports();
        }
        strictEqual(whole, 0, 'the scan read the mark, and no record whole');
      });
    });

    // Refine-verify F1 (2026-10-24) and the tenth critique's MAJOR 1
    // (2026-10-25): the frontmatter reader reads one chunk of a record that
    // opens no LF frontmatter, so a CRLF record's mark past it is never seen
    // there; such a record is read whole and judged on that text, invalid
    // UTF-8 included, never on a rebuilt guess of whether the read was whole.
    it("a CRLF archived record whose mark lies past the head reader's first chunk is read whole and refuses an older step, invalid UTF-8 too; read as LF it refuses by its mark (refine-verify F1, tenth critique MAJOR 1)", async () => {
      const { dir, sha } = await makeRepo();
      repos.push(dir);
      const create = (env, request = 'late') => S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude', env,
        gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: request, currentPhase: 'phase-0-bootstrap',
      });
      const four = await create(at(4), 'r'.repeat(70 * 1024));
      const archived = await S.archiveWorkflow({ workflowPath: four.filePath, host: 'claude', repoRoot: dir, env: at(4) });
      strictEqual(archived.archived, true);
      const lf = await readFile(archived.to, 'utf8');
      const crlf = lf.replace(/\n/g, '\r\n');
      ok(Buffer.byteLength(crlf.slice(0, crlf.indexOf('verify_attempt:'))) > 64 * 1024, 'the mark lies past the first chunk');
      await writeFile(archived.to, crlf);
      await rejects(create(at(3)), /records an attempt mark that cannot be read/);
      strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, 'nothing was created');
      // Invalid UTF-8 (each such byte decodes to a 3-byte U+FFFD, so decoded
      // text outgrows the record) refuses the same way.
      const bytes = Buffer.from(crlf, 'utf8');
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x72 && bytes[i + 1] === 0x72) bytes[i] = 0xe9;
      await writeFile(archived.to, bytes);
      await rejects(create(at(3)), /records an attempt mark that cannot be read/);
      strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, 'nothing was created (invalid UTF-8)');
      // Control: the same record as LF is read through its mark.
      await writeFile(archived.to, lf);
      await rejects(create(at(3)), /step 3 is older than step 4, which last wrote .*, archived on branch feat\/x/);
      // Control: a long record read whole that holds no mark (past the first
      // chunk) is passed over.
      await writeFile(join(dirname(archived.to), 'notes.md'), 'Notes kept beside the archive.\r\n'.repeat(4000));
      strictEqual((await markOf((await create(at(5))).filePath)).step, 5);
    });

    // Refine-verify R1 of the owner's 2026-10-25 ruling: the mark scan took
    // the first line that opens with "---" for the frontmatter's close, so a
    // mark after such a line passed as unmarked.
    it('a line that merely opens with --- closes no frontmatter: a mark after it refuses an older step, in an LF record, a long CRLF one and one behind a preamble (refine-verify R1 of the 2026-10-25 ruling)', async () => {
      const { dir, sha } = await makeRepo();
      repos.push(dir);
      const create = (env, request = 'late') => S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude', env,
        gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: request, currentPhase: 'phase-0-bootstrap',
      });
      const four = await create(at(4), 'r'.repeat(70 * 1024));
      const archived = await S.archiveWorkflow({ workflowPath: four.filePath, host: 'claude', repoRoot: dir, env: at(4) });
      strictEqual(archived.archived, true);
      const lf = await readFile(archived.to, 'utf8');
      ok(lf.split('\nverify_attempt:').length === 2, 'the record holds its mark once');
      const forged = lf.replace('\nverify_attempt:', '\n---extra: value\nverify_attempt:');
      for (const [label, text, refusal] of [
        ['LF', forged, /step 3 is older than step 4, which last wrote .*, archived on branch feat\/x/],
        ['CRLF', forged.replace(/\n/g, '\r\n'), /records an attempt mark that cannot be read/],
        ['preamble', `note\n${lf}`, /records an attempt mark that cannot be read/],
      ]) {
        await writeFile(archived.to, text);
        await rejects(create(at(3)), refusal, label);
        strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, `nothing was created (${label})`);
      }
      // Control: the record as written refuses by its mark, and a newer step
      // is admitted beside it.
      await writeFile(archived.to, lf);
      await rejects(create(at(3)), /step 3 is older than step 4, which last wrote .*, archived on branch feat\/x/);
      strictEqual((await markOf((await create(at(5))).filePath)).step, 5);
    });

    // The eleventh critique's MAJOR 1 (2026-10-25): the mark scan took a line
    // start after U+2028 or U+2029 (the `m` flag's), where the parser splits
    // on "\n" only, so a request holding one before "verify_attempt:" faked a
    // mark, and every later creation under a run on the branch threw.
    it('a U+2028 or U+2029 before verify_attempt: in a request fakes no mark: the record is passed over, and so is such a note (eleventh critique MAJOR 1)', async () => {
      const { dir, sha } = await makeRepo();
      repos.push(dir);
      const create = (env, request = 'late') => S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude', env,
        gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: request, currentPhase: 'phase-0-bootstrap',
      });
      for (const sep of [' ', ' ']) {
        // Created and archived by the owner, with no run: the record holds no
        // mark, only the request's text.
        const unmarked = await create({}, `Review${sep}verify_attempt: text`);
        const archived = await S.archiveWorkflow({ workflowPath: unmarked.filePath, host: 'claude', repoRoot: dir, env: {} });
        strictEqual(archived.archived, true);
        ok((await readFile(archived.to, 'utf8')).includes(`${sep}verify_attempt:`), 'the record holds the separator raw before the text');
        const made = await create(at(4));
        strictEqual((await markOf(made.filePath)).step, 4, `a creation under a run is admitted beside it (${JSON.stringify(sep)})`);
        await S.archiveWorkflow({ workflowPath: made.filePath, host: 'claude', repoRoot: dir, env: at(4) });
      }
      // A note that opens no frontmatter, read whole: a separator starts no
      // line there either, so it is passed over.
      const note = join(S.archiveDir(dir), 'notes.md');
      await writeFile(note, 'Kept verify_attempt: x\n');
      const five = await create(at(5));
      strictEqual((await markOf(five.filePath)).step, 5);
      await S.archiveWorkflow({ workflowPath: five.filePath, host: 'claude', repoRoot: dir, env: at(5) });
      // Control: the same note with the mark at a line start counts it, and
      // refuses, since the parser cannot read it.
      await writeFile(note, 'Kept\nverify_attempt: x\n');
      await rejects(create(at(6)), /records an attempt mark that cannot be read/);
    });

    // The eleventh critique's MAJOR 3 (2026-10-25), an uncommon case with a
    // one-line fix: in a record read whole (a BOM, a preamble), the branch
    // extractor took the real close line for the frontmatter's open and read a
    // branch from the body, so a newer mark on this branch was passed over.
    it('a branch named in the body of a record that opens no LF frontmatter exempts nothing: a BOM or preamble record refuses an older step (eleventh critique MAJOR 3)', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const archived = await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: at(4) });
        strictEqual(archived.archived, true);
        const lf = `${await readFile(archived.to, 'utf8')}\n### A phase note\n\ngit_baseline:\n  branch: feat/y\n`;
        const create = (env) => S.createWorkflow({
          repoRoot: dir, verb: 'compose', host: 'claude', env,
          gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: 'late', currentPhase: 'phase-0-bootstrap',
        });
        for (const [label, text] of [['BOM', `﻿${lf}`], ['preamble', `note\n${lf}`]]) {
          await writeFile(archived.to, text);
          await rejects(create(at(3)), /records an attempt mark that cannot be read/, label);
          strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, `nothing was created (${label})`);
        }
        // Control: the record as LF, the same body included, refuses by its mark.
        await writeFile(archived.to, lf);
        await rejects(create(at(3)), /step 3 is older than step 4, which last wrote .*, archived on branch feat\/x/);
      });
    });

    // The eleventh critique's MAJOR 2 (2026-10-25): the whole read of a record
    // the head reader cannot bound opens it a second time, and what it finds
    // there is judged alone. Each guard of that read is pinned by swapping the
    // record between the two opens: it opens without blocking, refuses what is
    // not a regular file, closes its descriptor, and replaces the head.
    it('a record swapped between the head read and the whole read is judged alone: a FIFO refuses at once, an LF record is read as one, and every descriptor is closed (eleventh critique MAJOR 2)', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        const archived = await S.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: at(4) });
        strictEqual(archived.archived, true);
        const record = archived.to;
        const lf = await readFile(record, 'utf8');
        const crlf = lf.replace(/\n/g, '\r\n');
        const create = (env) => S.createWorkflow({
          repoRoot: dir, verb: 'compose', host: 'claude', env,
          gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: 'swapped', currentPhase: 'phase-0-bootstrap',
        });
        const fsSync = createRequire(import.meta.url)('node:fs');
        const openSync0 = fsSync.openSync;
        const closeSync0 = fsSync.closeSync;
        // Runs `fn` with `swap` made just before the second open of the
        // record; reports whether that open asked to block (it is opened
        // without blocking all the same, so a FIFO never hangs the test) and
        // the descriptors on the record still open after it.
        const swapped = async (swap, fn) => {
          let opens = 0;
          let blocking = null;
          const fds = new Set();
          fsSync.openSync = (path, flags, ...rest) => {
            if (String(path) !== record) return openSync0(path, flags, ...rest);
            opens += 1;
            if (opens === 2) {
              swap();
              blocking = typeof flags !== 'number' || (flags & fsConstants.O_NONBLOCK) === 0;
              if (blocking) flags = (typeof flags === 'number' ? flags : fsConstants.O_RDONLY) | fsConstants.O_NONBLOCK;
            }
            const fd = openSync0(path, flags, ...rest);
            fds.add(fd);
            return fd;
          };
          fsSync.closeSync = (fd) => {
            fds.delete(fd);
            return closeSync0(fd);
          };
          syncBuiltinESMExports();
          try {
            await fn();
          } finally {
            fsSync.openSync = openSync0;
            fsSync.closeSync = closeSync0;
            syncBuiltinESMExports();
            for (const fd of fds) try { closeSync0(fd); } catch {}
          }
          return { opens, blocking, open: fds.size };
        };
        // A FIFO swapped in: refused at once, from a descriptor opened without
        // blocking, and closed.
        await writeFile(record, crlf);
        const fifo = await swapped(() => { rmSync(record); execFileSync('mkfifo', [record]); }, () => rejects(create(at(5)), /the archived workflow \S* is not a regular file/));
        deepStrictEqual(fifo, { opens: 2, blocking: false, open: 0 }, 'the whole read opened without blocking, and closed');
        strictEqual(await S.findActiveWorkflowByBranch(dir, 'feat/x'), null, 'nothing was created beside the FIFO');
        // Control: the CRLF record left in place refuses, its mark unreadable.
        rmSync(record);
        await writeFile(record, crlf);
        const kept = await swapped(() => {}, () => rejects(create(at(5)), /records an attempt mark that cannot be read/));
        deepStrictEqual(kept, { opens: 2, blocking: false, open: 0 });
        // An LF record swapped in is judged as that record alone, not joined to
        // the head read before it: step 5 is admitted beside step 4's mark.
        const lfSwap = await swapped(() => writeFileSync(record, lf), async () => {
          strictEqual((await markOf((await create(at(5))).filePath)).step, 5);
        });
        deepStrictEqual(lfSwap, { opens: 2, blocking: false, open: 0 });
      });
    });

    it('a creation on Codex under an inherited run records no mark: autopilot is a Claude run (the creation host)', async () => {
      const { dir } = await makeRepo();
      repos.push(dir);
      const { filePath } = await S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'codex', env: at(3),
        gitBaseline: { branch: 'feat/x', head: git(dir, 'rev-parse', 'HEAD'), status_digest: '' },
        originalRequest: 'created on codex', currentPhase: 'phase-0-bootstrap',
      });
      ok(!('verify_attempt' in (await read(filePath))));
    });

    it('an owner write in this process records no attempt mark (no AGENTIC_* variable is inherited)', async () => {
      await withWorkflow(async ({ wf }) => {
        await S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: refine });
        ok(!('verify_attempt' in (await read(wf))));
      });
    });
  });

  describe(`${persona}: a resumed workflow records a request (the phase says whether it is terminal)`, () => {
    it('after an interactive finish and a Phase 0 resume under the offer, the request is recorded and the marker turned off', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'Critique', nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: {}, cwd: dir });
        strictEqual((await read(wf)).terminal_marker, true);
        // Control: still in its terminal phase, the workflow records no request.
        await rejects(finish(wf, dir, sha), /the workflow is terminal \(summary-complete\)/);
        await S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'critique', currentPhase: 'phase-0-resume', clearNextStep: true, env: offerEnv(sha) });
        const fm0 = await read(wf);
        deepStrictEqual([fm0.current_phase, fm0.terminal_marker], ['phase-0-resume', true], 'Phase 0 keeps the marker');
        await finish(wf, dir, sha);
        const fm = await read(wf);
        deepStrictEqual([fm.next_step_kind, fm.terminal_marker, typeof fm.verify_request?.id], ['verify', false, 'string']);
      });
    });
  });

  describe(`${persona}: verify-batch-restart sets aside a record the driver does not hold`, () => {
    const restart = (wf, requestId, input, replaces) => S.recordBatchRestart({ workflowPath: wf, host: 'claude', requestId, replaces, input });
    const digestOf = async (wf) => (await S.readVerifyResults({ workflowPath: wf })).results_digest;
    // After a restart the request runs whole: the record holds the one clean
    // batch, which records every check, ends passed and takes on_pass.
    async function restartsAndPasses(wf, at = iso(30)) {
      const fm = await read(wf);
      const id = fm.verify_request.id;
      strictEqual((await restart(wf, id, startInput(fm.verify_request, { batch: 'r1', at }), await digestOf(wf))).recorded, true);
      deepStrictEqual((await read(wf)).verify_results.batches.map((b) => [b.batch_id, b.continues, b.results.length]), [['r1', null, 0]]);
      for (const r of [passed(0), passed(1)]) await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'r1', input: r });
      await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'r1', input: ended('passed') });
      await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'r1' });
      deepStrictEqual([(await read(wf)).next_step_kind, (await read(wf)).verify_request.answered_by], ['commit', 'r1']);
    }
    const rerun0 = (wf, id, batchId) => S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId, input: passed(0) });

    it('each record the driver cannot trust is set aside, and the check it blocked runs: a batch cut short, a carried result, an ended batch, an open batch, a result in its own batch', async () => {
      // 1. Another writer's batch, cut short after a pass of check 0: a
      // continuation carries check 0, and running it again is refused.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'f1', { results: [passed(0)], end: ended('cut-short', { cause: 'stop' }), at: iso(1) });
        await rejects(batch(wf, 'd1', { at: iso(2) }), /continues nothing, not f1/);
        await batch(wf, 'd1', { continues: 'f1', at: iso(2) });
        await rejects(rerun0(wf, id, 'd1'), /already has a result/);
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'd1', input: ended('cut-short', { cause: 'driver-end' }) });
        await restartsAndPasses(wf);
      });
      // 2. The driver's own batch, cut short, carrying another writer's result.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'f1', { results: [passed(0)], end: ended('cut-short', { cause: 'stop' }), at: iso(1) });
        await batch(wf, 'd0', { continues: 'f1', end: ended('cut-short', { cause: 'stop' }), at: iso(2) });
        await batch(wf, 'd1', { continues: 'd0', at: iso(3) });
        deepStrictEqual((await read(wf)).verify_results.batches[1].results.map((r) => r.carried_from), [{ batch_id: 'f1', run_id: RUN }]);
        await rejects(rerun0(wf, id, 'd1'), /already has a result/);
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'd1', input: ended('cut-short', { cause: 'driver-end' }) });
        await restartsAndPasses(wf);
      });
      // 3. Another writer's batch that ended: nothing follows it.
      const ends = {
        passed: { results: () => [passed(0), passed(1)], end: ended('passed') },
        failed: { results: () => [failed(0)], end: ended('failed') },
        'no-evidence': { results: () => [{ ...passed(0), outcome: 'timeout', exit: null, signal: 'SIGTERM' }], end: ended('no-evidence', { cause: 'timeout' }) },
      };
      for (const [name, e] of Object.entries(ends)) {
        await withWorkflow(async ({ wf, dir, sha }) => {
          await finish(wf, dir, sha);
          await batch(wf, 'f1', { results: e.results(), end: e.end, at: iso(1) });
          await rejects(batch(wf, 'd1', { at: iso(2) }), new RegExp(`ended ${name}: only a batch cut short is taken up again`));
          await restartsAndPasses(wf);
        });
      }
      // 4. Another writer's open batch: no batch starts beside it.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'f1', { results: [passed(0)], at: iso(1) });
        await rejects(batch(wf, 'd1', { at: iso(2) }), /batch f1 is still open/);
        await restartsAndPasses(wf);
      });
      // 5. Another writer's result in the driver's own open batch.
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const id = await batch(wf, 'd0', { results: [passed(0)], at: iso(1) });
        await rejects(S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'd0', input: { ...passed(0), duration_ms: 9 } }), /already has a result/);
        await restartsAndPasses(wf);
      });
    });

    it('a batch dated 2099 and a record over the budget block every ordinary start, and neither blocks a restart', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        await batch(wf, 'f1', { results: [passed(0)], end: ended('cut-short', { cause: 'stop', at: '2099-01-01T00:01:00Z' }), at: '2099-01-01T00:00:00Z' });
        await rejects(batch(wf, 'd1', { continues: 'f1', at: iso(2) }), /a stale start/);
        await restartsAndPasses(wf, iso(2));
      });
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const req = (await read(wf)).verify_request;
        // A hand-written batch, cut short, near the budget on its own: the
        // stored record holds it, though no start would have admitted it.
        const word = (n, k) => `tests/${String(n * 10 + k).padStart(4, '0')}${'z'.repeat(480)}.mjs`;
        const checks = Array.from({ length: 90 }, (_, n) => ({ index: n, kind: 'test', origin: 'driver', argv: ['npm', 'test', '--', ...Array.from({ length: 4 }, (_, k) => word(n, k))] }));
        const big = {
          batch_id: 'f1', run_id: RUN, continues: null, tree_start: T1, declaration_commit: req.baseline, declaration_digest: decl.digest,
          checks, checks_digest: V.checksDigest(checks.map((c) => c.argv)), started_at: iso(1), results: [], ...ended('cut-short', { cause: 'stop' }),
        };
        const record = { v: 1, request_id: req.id, batches: [big] };
        const size = V.scalarBytes('verify_results', record);
        ok(size > 150_000 && size < V.MAX_RESULTS_BYTES, String(size));
        const text = await readFile(wf, 'utf8');
        await writeFile(wf, text.replace(/^(verify_request: .*)$/m, (l) => `${l}\n${line('verify_results', record)}`));
        strictEqual((await read(wf)).verify_results.batches[0].batch_id, 'f1');
        await rejects(batch(wf, 'd1', { continues: 'f1', at: iso(2) }), /results could take \d+ bytes, more than the 196608/);
        await restartsAndPasses(wf, iso(2));
      });
    });

    it('a restart stales the requesting step\'s attempt, for a record the persona did not see start', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        deepStrictEqual(await markOf(wf), { v: 1, run_id: RUN, step: 3, requested: true, current: true });
        await restart(wf, fm.verify_request.id, startInput(fm.verify_request, { batch: 'r1' }), null);
        const restarted = await readFile(wf, 'utf8');
        await rejects(S.appendPhase({ workflowPath: wf, host: 'claude', clearNextStep: true, env: offerEnv(sha) }), /the handoff changed since step 3 last wrote it/);
        strictEqual(await readFile(wf, 'utf8'), restarted);
      });
    });

    it('a restart names the record it sets aside: a stale one, and a replay after its batch was evicted, record nothing; an identical replay is a no-op', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const id = fm.verify_request.id;
        strictEqual(await digestOf(wf), null);
        const r1 = startInput(fm.verify_request, { batch: 'r1', at: iso(1) });
        await rejects(restart(wf, id, r1, 'a'.repeat(64)), /the stored results are none, not a{64}, the record this restart sets aside: a stale restart/);
        await rejects(restart(wf, id, r1, 'nope'), /replaces is not the 64-hex digest/);
        await rejects(restart(wf, id, { ...r1, continues: 'b0' }, null), /a restart continues nothing/);
        const other = r1.checks.map((c, i) => (i === 0 ? { ...c, argv: ['npm', 'test', '--', 'tests/b.mjs'] } : c));
        await rejects(restart(wf, id, startInput(fm.verify_request, { batch: 'r1', checks: other }), null), /worker check 0 runs/);
        strictEqual((await restart(wf, id, r1, null)).recorded, true);
        const d1 = await digestOf(wf);
        strictEqual(d1, V.sha256(JSON.stringify((await read(wf)).verify_results)));
        // An identical replay writes nothing; another start under its id is refused.
        const afterR1 = await readFile(wf, 'utf8');
        deepStrictEqual(await restart(wf, id, r1, null), { unchanged: true });
        strictEqual(await readFile(wf, 'utf8'), afterR1);
        await rejects(restart(wf, id, { ...r1, tree_start: T2 }, null), /batch r1 is already recorded with another start/);
        // The record moved on since the driver read it: stale.
        await rerun0(wf, id, 'r1');
        await rejects(restart(wf, id, startInput(fm.verify_request, { batch: 'r2', at: iso(2) }), d1), /a stale restart records nothing/);
        // r1 cut short and continued twice: retention evicts r1, and a delayed
        // replay of its restart erases nothing.
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'r1', input: ended('cut-short', { cause: 'stop' }) });
        await batch(wf, 'c2', { continues: 'r1', end: ended('cut-short', { cause: 'stop' }), at: iso(3) });
        await batch(wf, 'c3', { continues: 'c2', at: iso(4) });
        deepStrictEqual((await read(wf)).verify_results.batches.map((b) => b.batch_id), ['c2', 'c3']);
        const later = await readFile(wf, 'utf8');
        await rejects(restart(wf, id, r1, null), /the stored results are [0-9a-f]{64}, not none/);
        strictEqual(await readFile(wf, 'utf8'), later);
        // Once the request is answered, nothing restarts it.
        await S.recordResult({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'c3', input: passed(1) });
        await S.recordBatchEnd({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'c3', input: ended('passed') });
        await S.recordPass({ workflowPath: wf, host: 'claude', requestId: id, batchId: 'c3' });
        await rejects(restart(wf, id, startInput(fm.verify_request, { batch: 'r9', at: iso(9) }), await digestOf(wf)), /no request is pending/);
      });
    });

    it('the CLI: verify-batch-restart takes --replaces, none when there are no results', async () => {
      await withWorkflow(async ({ wf, dir, sha }) => {
        await finish(wf, dir, sha);
        const fm = await read(wf);
        const file = join(dir, '..', `${persona}-${Date.now()}-restart.json`);
        repos.push(file);
        await writeFile(file, JSON.stringify(startInput(fm.verify_request, { batch: 'r1' })));
        const cli = (...more) => spawnSync(process.execPath, [STATE_PATH, 'verify-batch-restart', '--workflow-path', wf, '--host', 'claude', '--request-id', fm.verify_request.id, '--input-file', file, ...more], { cwd: dir, encoding: 'utf8' });
        const missing = cli();
        ok(missing.status !== 0 && /--replaces/.test(missing.stderr), missing.stderr);
        const r = cli('--replaces', 'none');
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual(JSON.parse(r.stdout), { recorded: true });
        const again = cli('--replaces', 'none');
        deepStrictEqual(JSON.parse(again.stdout), { unchanged: true });
      });
    });
  });
}

describe("the fixtures' git reaches no other repository", () => {
  it('a planted GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE have no effect on a fixture', async () => {
    const victim = await makeRepo({ declaration: false });
    const plain = await mkdtemp(join(tmpdir(), 'verify-record-plain-'));
    const planted = { GIT_DIR: join(victim.dir, '.git'), GIT_WORK_TREE: victim.dir, GIT_INDEX_FILE: join(victim.dir, '.git', 'index') };
    try {
      // Control: a git that inherits them works in the victim, whatever -C says.
      strictEqual(execFileSync('git', ['-C', plain, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, ...planted } }).trim(), victim.sha);
      Object.assign(process.env, planted);
      let fixture;
      try {
        fixture = await makeRepo();
      } finally {
        for (const k of Object.keys(planted)) delete process.env[k];
      }
      strictEqual(git(victim.dir, 'rev-parse', 'HEAD'), victim.sha, "the victim's HEAD did not move");
      strictEqual(git(victim.dir, 'rev-list', '--count', 'HEAD'), '1');
      strictEqual(git(fixture.dir, 'rev-parse', 'HEAD'), fixture.sha, 'the fixture holds its own commit');
      ok(git(fixture.dir, 'ls-files').includes('.agentic-plugins/verify-checks.json'));
      await rm(fixture.dir, { recursive: true, force: true });
    } finally {
      await rm(victim.dir, { recursive: true, force: true });
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('the fixtures write as the owner: no inherited AGENTIC_* variable reaches them', () => {
  it('under a planted autopilot session the owner-write probe passes in every persona, and fails without the drop (control)', () => {
    const file = fileURLToPath(import.meta.url);
    const probe = 'an owner write in this process records no attempt mark';
    // The probe runs in each persona that offers the verify next step.
    const personas = personasFor('scripts/state.mjs').filter((p) => personaInfo(p).capabilities.dispatch_target === true).length;
    ok(personas > 0);
    const planted = runPlanted(file, probe);
    strictEqual(planted.status, 0, planted.out);
    deepStrictEqual([planted.pass, planted.fail], [personas, 0], planted.out);
    const control = runPlanted(file, probe, { control: true });
    strictEqual(control.status, 1, control.out);
    deepStrictEqual([control.pass, control.fail], [0, personas], control.out);
    ok(Object.keys(PLANTED_SESSION).every((k) => !(k in process.env)), 'this process holds none of them');
  });
});
