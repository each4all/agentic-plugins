// tests/persona-pipeline/_verify-runbook-fixture.mjs
//
// ADR-0068 Decision 5, `verify-runbooks` — what the verify-runbook tests share
// (test-verify-runbooks.mjs, the branches and refusals each run once in bash;
// test-verify-runbooks-e2e.mjs, one happy path per runbook rendering the verify
// form, in every shell; test-verify-results.mjs, the rules the CLI applies, in
// process). The runbook blocks run as written, against temporary repositories
// holding the repository's check declaration, with the persona's real scripts.
//
// Every repository lives in a directory of its own, removed when the file's
// tests end (tests/_tmp.mjs fileTmpDirs, which each test file takes), beside
// a scratch directory the blocks' own `mktemp -d` writes into (their TMPDIR):
// the operation and text directories a runbook leaves by design stay outside
// the test file's TMPDIR and go with the repository.
//
// Not discovered by `node --test`: the stem starts with `_`.

import './_drop-session.mjs';
import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderingDeclaration } from '../../scripts/lib/persona-pipeline.mjs';
import { REPO_ROOT, personaInfo, personasFor } from './_personas.mjs';

for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

export const RUN = 'autopilot-20261031T010203Z-abcdef';
export const MACRO = 'macro-plan-20261031T000000Z-abcdef';
export const SUBTASK = 'verify-persona';
export const DECLARATION = readFileSync(join(REPO_ROOT, '.agentic-plugins/verify-checks.json'), 'utf8');
// The verbs with long-check guidance, and the verb each one's verb form names.
export const VERBS = Object.freeze({ compose: 'critique', refine: 'critique', critique: 'refine' });
// Every runbook rendering the verify form.
export const VERIFY_FORM_VERBS = Object.freeze(['compose', 'refine', 'critique', 'decide', 'frame', 'investigate']);
export const REQ = Object.freeze({
  checks: [{ kind: 'test', args: { files: ['tests/a.mjs'] } }, { kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs', ids: ['S1'] } }],
  on_pass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' },
  confidence: 'HIGH',
});

export const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
export const DISPATCH_DIR_LINE = "DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'";
export const VERDICT_LINE = "VERDICT='<the synthesis verdict>'";
export const CONFIDENCE_LINE = "CONFIDENCE='<HIGH|MEDIUM|LOW>'";
export const OP_DIR_LINE = "OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'";

export function section(text, heading) {
  const start = text.indexOf(heading);
  ok(start >= 0, `missing ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}
export const blocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
export const dedent = (b) => {
  const lines = b.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind)).join('\n');
};
export function fill(block, placeholder, value) {
  ok(block.includes(placeholder), `the block holds ${placeholder}`);
  return block.replaceAll(placeholder, value);
}
export const withGate = (block, gate) => fill(block, "OWNER_GATE=''", `OWNER_GATE='${gate}'`);

export const PERSONAS = personasFor('scripts/state.mjs');
export const VERIFY_PERSONAS = PERSONAS.filter((p) => personaInfo(p).capabilities.dispatch_target === true);

/** Each shell the runbooks may run in, with whether it is installed here. */
export const SHELLS = ['bash', 'zsh'].map((sh) => [sh, spawnSync(sh, ['-c', 'true']).status === 0]);

export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * The fixture of one persona, its repositories made with `tmpDirs`: the
 * function tests/_tmp.mjs fileTmpDirs returns, which the test file takes at
 * its top level before any test is declared and before any top-level await
 * (a later call registers its removal after the run has begun). `shell` is
 * the shell the runbook blocks run in, `bash` unless a suite sets another.
 */
export async function verifyFixture(persona, tmpDirs) {
  ok(typeof tmpDirs === 'function', 'verifyFixture takes the file\'s fileTmpDirs()');
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const S = await import(pathToFileURL(STATE).href);
  const V = await import(pathToFileURL(P.path('scripts/lib/verify.mjs')).href);
  const decl = V.parseDeclaration(DECLARATION);
  const ROOT_ENV = renderingDeclaration(P.declaration).derived.root_env;
  const text = Object.fromEntries(VERIFY_FORM_VERBS.map((v) => [v, readFileSync(P.path(`commands/${v}.md`), 'utf8')]));
  const fx = { persona, P, STATE, S, V, decl, text, shell: 'bash' };

  // The scratch directory a repository's blocks and scripts make their
  // temporary directories in: beside it, never in the test file's TMPDIR.
  const scratch = (dir) => join(dirname(dir), 'tmp');

  /** A repository on a branch, with the declaration and a macro child workflow. */
  fx.withRepo = async (fn) => {
    const area = realpathSync(tmpDirs(`${persona}-verify-runbooks-`));
    const dir = join(area, 'repo');
    await mkdir(dir);
    await mkdir(scratch(dir));
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
    const digest = execFileSync('shasum', ['-a', '256'], { input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }), encoding: 'utf8' }).trim().split(/\s+/)[0];
    const { filePath: wf } = await S.createWorkflow({
      repoRoot: dir, verb: 'compose', host: 'claude',
      parentWorkflow: MACRO, originatingSubtask: SUBTASK,
      gitBaseline: { branch: 'feat/r', head: sha, status_digest: digest },
      originalRequest: 'verify runbooks fixture', currentPhase: 'phase-0',
    });
    return fn({ dir, sha, wf, area });
  };

  fx.offer = (sha, step = '3') => ({ AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: step, AGENTIC_AUTOPILOT_VERIFY: sha });
  fx.runBlock = (dir, block, extra = {}) => {
    const env = { ...process.env, [ROOT_ENV]: P.root, TMPDIR: scratch(dir), ...extra };
    delete env.CLAUDE_PLUGIN_ROOT;
    return spawnSync(fx.shell, ['-c', block], { cwd: dir, encoding: 'utf8', env });
  };

  fx.phase0Of = (verb) => {
    const b = blocks(section(text[verb], '## Phase 0')).map(dedent).find((x) => x.includes('autopilot-preflight'));
    ok(b, `${verb}: the Phase 0 preflight block`);
    return b;
  };
  const resumeOf = (verb) => blocks(section(text[verb], '## Phase 0')).map(dedent).find((b) => b.includes('state.mjs" append'));
  const finalizeOf = (verb) => blocks(section(text[verb], '## Phase 2 — State finalize')).filter((b) => !/^\s*(?:mktemp -d |# Step 1: a private text directory)/.test(b))[0];

  // Phase 0's resume, as the step runs it: it opens the verb's operation on
  // the macro's child and prints its directory.
  fx.resume = (dir, verb, env) => {
    const b = resumeOf(verb).replaceAll('"<profile or empty>"', '""');
    const r = fx.runBlock(dir, b, env);
    strictEqual(r.status, 0, r.stderr);
    const opDir = /^OP_DIR=(.+)$/m.exec(r.stdout)?.[1];
    ok(opDir, r.stdout);
    return { ...r, opDir };
  };
  fx.textDir = async (area, files) => {
    const d = await mkdtemp(join(area, 'text '));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(d, name), typeof content === 'string' ? `${content}\n` : `${JSON.stringify(content, null, 2)}\n`);
    }
    return d;
  };
  fx.finalize = (verb, { tdir, opDir, verdict = 'agreed' }) => fill(fill(fill(fill(fill(finalizeOf(verb), TEXT_DIR_LINE, `TEXT_DIR='${tdir}'`),
    DISPATCH_DIR_LINE, "DISPATCH_DIR=''").replace("DISPATCH_TEXT_DIR='<the directory the dispatch block ran with, a run launched or not; empty when no dispatch block ran>'", () => "DISPATCH_TEXT_DIR=''"), VERDICT_LINE, `VERDICT='${verdict}'`), CONFIDENCE_LINE, "CONFIDENCE='HIGH'"), OP_DIR_LINE, `OP_DIR='${opDir}'`);
  fx.texts = (extra = {}) => ({ 'note.md': '### Ensemble synthesis: fixture', 'summary.txt': 'fine', 'next-action.txt': 'Verify the change, then critique', ...extra });
  fx.front = async (wf) => (await S.readWorkflow(wf)).frontmatter;

  // A stub companion that answers at once, and the real runner's dispatch,
  // as the runbook's dispatch block runs it: a completed run, pending on the
  // workflow until the finalize settles it, and the dispatch directory the
  // finalize reads it from.
  fx.realRun = async ({ dir, sha, wf, area, phase }) => {
    const companions = join(area, 'companions');
    await mkdir(companions);
    await writeFile(join(companions, 'discover-peer.mjs'), 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
    await writeFile(join(companions, 'codex-companion.mjs'), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'the peer answer', exit_code: 0 }));\n");
    execFileSync('chmod', ['755', join(companions, 'codex-companion.mjs')]);
    await writeFile(join(companions, 'prompt.xml'), '<task>fixture</task>\n');
    const runId = `${phase}-20261031T010203Z-abcdef`;
    const env = { ...process.env, ...fx.offer(sha), AGENTIC_COMPANIONS_ROOT: companions, TMPDIR: scratch(dir) };
    const run = spawnSync('node', [P.path('scripts/peer-runner.mjs'), 'run', '--repo-root', dir, '--kind', 'ensemble',
      '--peer', 'codex', '--prompt-file', join(companions, 'prompt.xml'), '--output-format', 'json',
      '--workflow-path', wf, '--phase', phase, '--host', 'claude', '--cwd', dir,
      '--ensemble-type', phase, '--run-id', runId], { cwd: dir, encoding: 'utf8', env });
    strictEqual(run.status, 0, run.stderr);
    const ddir = await mkdtemp(join(area, 'dispatch '));
    await writeFile(join(ddir, 'prompt.xml.run.json'), run.stdout);
    ok((await fx.front(wf)).pending_ensemble?.some((e) => e.run_id === runId), 'the run is pending');
    return { runId, ddir };
  };

  /**
   * The request a verb's verify form records, written in process as its last
   * write (finish-verb) writes it under the offer: the setup of a case that
   * tests what is read back, not the finalize.
   */
  fx.requestInProcess = async ({ dir, sha, wf }, request = REQ) => {
    await S.finishVerb({
      workflowPath: wf, host: 'claude', nextAction: 'Verify the change, then critique',
      nextStep: { kind: 'verify', confidence: request.confidence }, verifyRequest: request, env: fx.offer(sha), cwd: dir,
    });
    strictEqual((await fx.front(wf)).next_step_kind, 'verify');
  };

  // The driver's records, as the driver writes them (owner writes: no
  // AGENTIC_* variable in this process). `added`: a check the driver added to
  // the request's (origin driver); `noLog`: the first result keeps no log.
  const resolved = (request) => request.checks.map((c, i) => ({ index: i, kind: c.kind, origin: 'worker', argv: V.resolveCheck(decl, c) }));
  fx.driverBatch = async (wf, { tree, outcome, pass = false, added = false, noLog = false }) => {
    const fm = await fx.front(wf);
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
  };

  return fx;
}
