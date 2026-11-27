// ADR-0059 Decision 10 — the orchestrator's checkpoint and resume runbooks
// release the text directory step 1 made once their write succeeded, and keep
// it on the path a rerun reads. Each block runs as written, in a fresh bash,
// with a directory made by state.mjs tmpdir-make (marked) in the place of its
// head line; the Codex mirror's block runs with its root placeholder filled.
// What the shell text decides is under test here (the release after the
// write's `|| exit $?`); where each release sits is held statically by
// tests/plugin-shape/test-runbook-cli-contracts.mjs.

import { test } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fencedBlocks } from '../_runbook-checks.mjs';
import { tmpDir } from '../_tmp.mjs';

const ORCH = fileURLToPath(new URL('../../plugins/orchestrator/', import.meta.url));
const { createWorkflow, readWorkflow } = await import(pathToFileURL(join(ORCH, 'scripts/state.mjs')).href);

// The one shell block of `rel` that holds `marker`.
function blockOf(rel, marker) {
  const found = fencedBlocks(readFileSync(join(ORCH, rel), 'utf8')).map((b) => b.lines.join('\n')).filter((b) => b.includes(marker));
  strictEqual(found.length, 1, `${rel}: one block holds ${marker}`);
  return found[0];
}

const fill = (block) => block.replaceAll('<plugin-root>', ORCH.replace(/\/$/, '')).replaceAll('<claude|codex>', 'codex').replaceAll('<clean|dirty>', 'clean');

// A repository on main with no macro workflow yet.
function repo(t) {
  const dir = tmpDir(t, 'orch-text-release-');
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, '.gitignore'), '.agentic-plugins/\n');
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

async function macro(t) {
  const dir = repo(t);
  const { filePath } = await createWorkflow({
    repoRoot: dir, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' }, originalRequest: 'text release fixture',
  });
  return { dir, filePath };
}

// A text directory as step 1 makes it, under a TMPDIR of the test's own.
const madeText = (t) => execFileSync(process.execPath, [join(ORCH, 'scripts/state.mjs'), 'tmpdir-make', '--kind', 'text'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmpDir(t, 'orch-text-tmp-') } }).trim();

function run(block, line, value, { cwd, env = {} }) {
  ok(block.includes(`${line}\n`), `the block holds ${line}`);
  // No ACTIVE either: each block finds its workflow itself, as a fresh shell
  // of the host's must (an exported ACTIVE would mask a block that does not).
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'ACTIVE'));
  return spawnSync('bash', ['-c', block.replace(line, () => `${line.split('=')[0]}='${value}'`)], { cwd, encoding: 'utf8', env: { ...clean, AGENTIC_ORCHESTRATOR_ROOT: ORCH, ...env } });
}

// Phase 1's lookup, the block that ends with the bare find-active call: what
// it prints is what the agent branches on.
function lookupOf(rel) {
  const found = fencedBlocks(readFileSync(join(ORCH, rel), 'utf8')).map((b) => b.lines.join('\n')).filter((b) => b.endsWith('find-active --repo-root "$REPO_ROOT"'));
  strictEqual(found.length, 1, `${rel}: one block ends with the lookup`);
  return found[0];
}

const HOSTS = [
  ['claude', 'commands/checkpoint.md', 'commands/resume.md', (b) => b],
  ['codex', 'core/skills/checkpoint/SKILL.md', 'core/skills/resume/SKILL.md', fill],
];
const STEP1 = "TEXT_DIR='<directory from step 1>'";

for (const [host, checkpointRel, resumeRel, prep] of HOSTS) {
  test(`${host} checkpoint and resume: Phase 1's lookup prints the active workflow, and prints nothing when none is found`, async (t) => {
    const { dir, filePath } = await macro(t);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'ACTIVE'));
    for (const rel of [checkpointRel, resumeRel]) {
      const block = prep(lookupOf(rel));
      const r = spawnSync('bash', ['-c', block], { cwd: dir, encoding: 'utf8', env: { ...clean, AGENTIC_ORCHESTRATOR_ROOT: ORCH } });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), filePath, `${rel}: the lookup prints the workflow it found`);
      const none = spawnSync('bash', ['-c', block], { cwd: repo(t), encoding: 'utf8', env: { ...clean, AGENTIC_ORCHESTRATOR_ROOT: ORCH } });
      strictEqual(none.status, 0, none.stderr);
      strictEqual(none.stdout.trim(), '', `${rel}: no workflow prints nothing`);
    }
  });

  test(`${host} checkpoint: a written checkpoint releases the directory; a failed write keeps it`, async (t) => {
    const { dir, filePath } = await macro(t);
    // Run alone, in a fresh shell: the block finds the workflow itself.
    const block = prep(blockOf(checkpointRel, 'checkpoint-set'));
    let text = madeText(t);
    writeFileSync(join(text, 'summary.txt'), 'a checkpoint $(touch pwned)\n');
    let r = run(block, STEP1, text, { cwd: dir });
    strictEqual(r.status, 0, r.stderr);
    ok((await readWorkflow(filePath)).frontmatter.latest_checkpoint.summary.includes('$(touch pwned)'));
    ok(!existsSync(text), 'the written checkpoint released the directory');
    ok(!existsSync(join(dir, 'pwned')));
    // No summary: the write refuses, and the directory stays for the rerun.
    text = madeText(t);
    r = run(block, STEP1, text, { cwd: dir });
    ok(r.status !== 0, 'a missing summary stops the block');
    ok(existsSync(text), 'a failed write keeps the directory');
    // No active workflow: the lookup stops the block before the write, and
    // the directory stays.
    text = madeText(t);
    writeFileSync(join(text, 'summary.txt'), 'a checkpoint\n');
    r = run(block, STEP1, text, { cwd: repo(t) });
    ok(r.status !== 0, 'no active workflow stops the block');
    ok(/No active orchestrator workflow/.test(r.stderr), r.stderr);
    ok(existsSync(text), 'a block that finds no workflow keeps the directory');
  });

  test(`${host} resume: the marker releases its directory; the archive's resolver releases its own once it printed the workflow, and keeps it on a refusal`, async (t) => {
    const { dir, filePath } = await macro(t);
    const marker = prep(blockOf(resumeRel, '--event resumed'));
    const id = filePath.split('/').pop().replace(/\.md$/, '');
    // The drift report described another macro (the branch or its workflow
    // changed since): the block stops before the write and keeps the
    // directory; with no id file, the same.
    let text = madeText(t);
    writeFileSync(join(text, 'note.md'), 'drift clean\n');
    writeFileSync(join(text, 'workflow-id.txt'), 'macro-plan-20990101T000000Z-000000\n');
    let r = run(marker, STEP1, text, { cwd: dir });
    ok(r.status !== 0, 'a drift report of another workflow stops the marker block');
    ok(/names another workflow/.test(r.stderr), r.stderr);
    ok(existsSync(text), 'a marker block over another workflow keeps the directory');
    ok(!(await readWorkflow(filePath)).body.includes('Resume: drift='), 'no marker was written');
    text = madeText(t);
    writeFileSync(join(text, 'note.md'), 'drift clean\n');
    r = run(marker, STEP1, text, { cwd: dir });
    ok(r.status !== 0, 'a missing id file stops the marker block');
    ok(existsSync(text));
    ok(!(await readWorkflow(filePath)).body.includes('Resume: drift='), 'a missing id file writes no marker');
    text = madeText(t);
    writeFileSync(join(text, 'note.md'), 'drift clean\n');
    writeFileSync(join(text, 'workflow-id.txt'), `${id}\n`);
    r = run(marker, STEP1, text, { cwd: dir });
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(text), 'the written marker released the directory');
    ok((await readWorkflow(filePath)).body.includes('Resume: drift='), 'the marker is in the workflow the block found');
    // No active workflow: the marker block stops and keeps its directory.
    text = madeText(t);
    writeFileSync(join(text, 'note.md'), 'drift clean\n');
    writeFileSync(join(text, 'workflow-id.txt'), `${id}\n`);
    r = run(marker, STEP1, text, { cwd: repo(t) });
    ok(r.status !== 0, 'no active workflow stops the marker block');
    ok(existsSync(text), 'a marker block that finds no workflow keeps the directory');
    const resolver = prep(blockOf(resumeRel, '--workflow-id-file "$ID_DIR/workflow-id.txt"'));
    const idLine = "ID_DIR='<directory from step 1>'";
    // An id no root holds: refused, the directory kept for the rerun.
    let ids = madeText(t);
    writeFileSync(join(ids, 'workflow-id.txt'), 'macro-plan-20990101T000000Z-000000\n');
    r = run(resolver, idLine, ids, { cwd: dir });
    ok(r.status !== 0, 'an id no root holds stops the block');
    ok(existsSync(ids), 'a refusal keeps the directory');
    ids = madeText(t);
    writeFileSync(join(ids, 'workflow-id.txt'), `${id}\n`);
    r = run(resolver, idLine, ids, { cwd: dir });
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes(filePath), r.stdout);
    ok(!existsSync(ids), 'the printed workflow released the directory');
  });
}
