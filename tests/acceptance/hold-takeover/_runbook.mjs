// The runbook transport of the takeover acceptance against plugins/orchestrator
// (test-hold-takeover-orchestrator.mjs): the generated blocks of the released
// engineer's runbooks, run as an agent runs them — each in a fresh `bash`, its
// placeholders filled, the operation directory carried as the `OP_DIR` the
// Phase 0 block printed. The prototype (test-hold-takeover.mjs) keeps its own
// copy as hold-persona left it: mutation group T of hold-persona.mjs is proven
// against that file as it is. Not discovered by `node --test`: the stem starts
// with `_`.

import { ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { personaInfo } from '../../persona-pipeline/_personas.mjs';

export const E = personaInfo('engineer');
const SHELL = 'bash';

const scratch = [];
export const tempDir = (prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
};
// Barriers a test made: each is opened when the test ends, whatever it did, so
// a companion still waiting never keeps the test process alive.
const barriers = [];
export const newBarrier = () => {
  const b = join(tempDir('hold-barrier-'), 'go');
  barriers.push(b);
  return b;
};
// Blocks left running: each is awaited before the directories go, so none
// writes into a directory the cleanup removed.
const running = [];
export async function cleanupScratch() {
  for (const b of barriers.splice(0)) writeFileSync(b, '');
  await Promise.all(running.splice(0));
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function regionBlock(dest, id) {
  const text = readFileSync(E.path(dest), 'utf8');
  const begin = text.indexOf(`<!-- pipeline:begin ${id} -->`);
  const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
  ok(begin >= 0 && end > begin, `${dest} holds region ${id}`);
  const runnable = [...text.slice(begin, end).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => !/^\s*mktemp -d /.test(b));
  strictEqual(runnable.length, 1, `${id}: one block to run`);
  return runnable[0];
}
export function fill(block, pairs) {
  let out = block;
  for (const [placeholder, value] of pairs) {
    ok(out.includes(placeholder), `the block holds ${placeholder}`);
    out = out.split(placeholder).join(value);
  }
  return out;
}
export function runBlock(cwd, block, env) {
  const r = spawnSync(SHELL, ['-c', block], { cwd, encoding: 'utf8', env, timeout: 60_000 });
  ok(r.status !== null, `the block ran to its end (${r.error?.message ?? r.signal})`);
  return r;
}
// A block left running: its result once it exits.
export function startBlock(cwd, block, env) {
  const child = spawn(SHELL, ['-c', block], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((res) => { child.on('close', (status) => res({ status, stdout, stderr })); });
  running.push(done);
  return done;
}
export async function waitFor(file, ms = 30_000) {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    ok(Date.now() < until, `${file} appeared`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
}
export const opDirOf = (r) => {
  const m = /^OP_DIR=(.+)$/m.exec(r.stdout);
  ok(m, `the block printed OP_DIR:\n${r.stdout}\n${r.stderr}`);
  return m[1];
};
export const textDir = (files) => {
  const d = tempDir('hold-text-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), `${text}\n`);
  return d;
};

// compose's Phase 0 bootstrap, as /orchestrator:next's dispatch runs it.
export function bootstrap(lane, env) {
  const block = fill(regionBlock('commands/compose.md', 'compose-bootstrap'), [["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir({ 'request.txt': 'the topic' })}'`]]);
  return runBlock(lane, block, { ...env, AGENTIC_PROFILE: 'code' });
}
// A verb's Phase 0 resume (compose's unless named).
export const resumeVerb = (lane, env, verb = 'compose') => runBlock(lane, regionBlock(`commands/${verb}.md`, `${verb}-resume`), env);
// compose's ensemble dispatch, the peer launched through the real runner; left
// running, its result is `done`.
export function dispatchEnsemble(lane, env) {
  const dir = textDir({ 'prompt.xml': '<task>review</task>' });
  const done = startBlock(lane, fill(regionBlock('commands/compose.md', 'compose-dispatch'), [["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${dir}'`]]), env);
  return { done, dir };
}
// A verb's Phase 2 finalize (compose's unless named; no run launched, or the
// run dispatched from `dispatchDir`). Its finish-verb records the runbook's
// typical next step, or `next`: { verb }, { commit: true } or { gate: true }
// (OWNER_GATE scope-routing, which selects the owner-decision form).
export function finalize(lane, env, opDir, next = {}, dispatchDir = '', verb = 'compose') {
  const note = `### Ensemble skipped: ${verb} (local-only)\n\nlocal${next.gate ? '\n\n### Routing recommendation\n\nThis belongs in another subtask.' : ''}`;
  let block = fill(regionBlock(`commands/${verb}.md`, `${verb}-finalize`), [
    ["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir({ 'note.md': note, 'summary.txt': 'local only', 'next-action.txt': next.gate ? 'Owner: route it' : 'Next' })}'`],
    ["DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'", `DISPATCH_DIR='${dispatchDir}'`],
    ["VERDICT='<the synthesis verdict>'", "VERDICT='agreed'"],
    ["CONFIDENCE='<HIGH|MEDIUM|LOW>'", "CONFIDENCE='HIGH'"],
    ["OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'", `OP_DIR='${opDir}'`],
  ]);
  const typical = /--next-step-kind verb --next-step-verb '[a-z]+'( \\\n\s*--next-step-confidence "\$CONFIDENCE")/;
  ok(typical.test(block), 'the typical finish-verb');
  if (next.commit) block = block.replace(typical, '--next-step-kind commit$1');
  else if (next.gate) block = fill(block, [["OWNER_GATE=''", "OWNER_GATE='scope-routing'"]]);
  else if (next.verb) block = block.replace(typical, `--next-step-kind verb --next-step-verb '${next.verb}'$1`);
  return runBlock(lane, block, env);
}

// A companions root whose discovery answers with a companion, which the real
// peer runner launches. It answers at once, or, given `barrier`, writes
// `<barrier>.started` and answers once `<barrier>` exists.
export function fakeCompanions({ barrier = null } = {}) {
  const root = tempDir('hold-companions-');
  writeFileSync(join(root, 'discover-peer.mjs'), `
export async function discoverPeerCompanion({ peer } = {}) {
  if (peer !== 'claude' && peer !== 'codex') return { ok: false, reason: 'bad peer' };
  return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname };
}
`);
  for (const peer of ['claude', 'codex']) {
    const p = join(root, `${peer}-companion.mjs`);
    writeFileSync(p, `#!/usr/bin/env node
if (process.argv[2] !== 'task') process.exit(2);
const barrier = ${JSON.stringify(barrier)};
if (barrier) {
  const fs = await import('node:fs');
  fs.writeFileSync(barrier + '.started', '');
  const until = Date.now() + 60_000;
  while (!fs.existsSync(barrier) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}
process.stdout.write(JSON.stringify({ status: 'success', peer_host: '${peer}', peer_model: null, stdout: 'the answer', exit_code: 0 }));
`);
    chmodSync(p, 0o755);
  }
  return root;
}
