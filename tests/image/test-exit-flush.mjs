// plugins/image CLIs end through exitAfterFlush (C93).
//
// Each CLI prints its result and used to call process.exit at once. On a pipe
// (the runbooks read these through `$(…)`) Node had not handed the whole write
// to the reader yet, and what was left past 64 KiB was dropped. The live case
// was critique-dispatch, whose result carries Codex's whole assessment. Each
// CLI now returns its exit code to one exit at its entry tail, which waits for
// stdout and stderr to flush; refusals return before any later work.
//
// The flush checks read the CLI through a real OS pipe (`… | cat`, as `$(…)`
// does), whose 64 KiB capacity is the same on Linux and macOS: Node's own
// spawn stdio is a socket pair, whose capacity depends on the platform (a
// 100,000-byte write fits in a 128 KiB socket buffer and is never cut). The
// fixture companion delivers its own envelope whole (checked first), so a
// short result is the dispatcher's truncation, not the fixture's.
//
// Run via `node --test tests/image/test-exit-flush.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXIT_FLUSH_FALLBACK_MS } from '../../plugins/image/scripts/exit-after-flush.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SCRIPTS = resolve(REPO_ROOT, 'plugins/image/scripts');
const FAKE_COMPANION = resolve(REPO_ROOT, 'tests/image/fixtures/fake-codex-companion.mjs');
const PIPE_BYTES = 65536;
// Past a pipe's 64 KiB with room to spare, and under critique's 4 MiB cap.
const BIG = 1 << 20;
// The helper cases write through Node's socket pairs: 4 MiB is past any
// socket buffer, so a write that has not been read is still pending.
const HUGE = 1 << 22;
const HELPER_URL = pathToFileURL(resolve(SCRIPTS, 'exit-after-flush.mjs')).href;

// Run a child with piped stdio and collect both streams to `close`. A kill
// timer fails a run that hangs instead of hanging the suite.
function run(args, { env = process.env, killMs = 30000 } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, killMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      res({ code, signal, timedOut, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

// Run a child with one stream, `stream`, through a real OS pipe into `cat`,
// and collect it as `text`; the other stream (stdout's stderr) is collected
// as `other`, or dropped for `stream: 'stderr'`. The child's exit status is
// written to a file, since the shell's is cat's.
function piped(args, stream, { env = process.env, killMs = 30000 } = {}) {
  const codeFile = join(mkdtempSync(join(tmpdir(), 'image-exit-code-')), 'code');
  const script = stream === 'stderr'
    ? 'f=$1; shift; { "$@" 2>&1 >/dev/null; echo $? >"$f"; } | cat'
    : 'f=$1; shift; { "$@"; echo $? >"$f"; } | cat';
  return new Promise((res) => {
    const sh = spawn('/bin/sh', ['-c', script, 'sh', codeFile, process.execPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-sh.pid, 'SIGKILL'); } catch { /* gone */ } }, killMs);
    sh.stdout.on('data', (d) => out.push(d));
    sh.stderr.on('data', (d) => err.push(d));
    sh.on('close', () => {
      clearTimeout(timer);
      const code = existsSync(codeFile) ? Number(readFileSync(codeFile, 'utf8')) : null;
      res({ code, timedOut, text: Buffer.concat(out).toString('utf8'), other: Buffer.concat(err).toString('utf8') });
    });
  });
}

// A scratch dir with an event log the discovery stub and the fixture companion
// both append to: `discovered` when discovery runs, `companion ran` when the
// companion starts.
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'image-exit-flush-'));
  const log = join(dir, 'events.log');
  writeFileSync(log, '');
  return { dir, log, events: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

// AGENTIC_COMPANIONS_ROOT points discovery at a stand-in library that records
// the call and resolves to the fixture companion (or throws, with `throws`).
function cliEnv(h, { throws = false, extra = {} } = {}) {
  const lib = join(h.dir, throws ? 'companions-throwing' : 'companions');
  mkdirSync(lib, { recursive: true });
  const body = throws
    ? 'throw new Error(\'discovery exploded\');'
    : `return { ok: true, path: ${JSON.stringify(FAKE_COMPANION)} };`;
  writeFileSync(join(lib, 'discover-peer.mjs'), [
    'import { appendFileSync } from \'node:fs\';',
    `export async function discoverPeerCompanion() { appendFileSync(${JSON.stringify(h.log)}, 'discovered\\n'); ${body} }`,
    '',
  ].join('\n'));
  return { ...process.env, AGENTIC_COMPANIONS_ROOT: lib, FAKE_IMAGE_MODE: 'opaque', FAKE_COMPANION_LOG: h.log, ...extra };
}

// A minimal PNG header (signature + IHDR), enough for critique's magic-byte
// check; the fixture companion never opens it.
function pngFile(dir) {
  const path = join(dir, 'a.png');
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(2, 8);
  ihdr.writeUInt32BE(2, 12);
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]));
  return path;
}

describe('the fixture companion delivers its envelope whole', () => {
  // Guards the regression below: were the fixture to exit before its write
  // was taken, a short critique result would measure the fixture.
  it('a critique envelope past 64 KiB arrives whole through a pipe', async () => {
    const h = harness();
    const prompt = join(h.dir, 'prompt.txt');
    writeFileSync(prompt, 'You are evaluating an image.\n');
    const r = await piped([FAKE_COMPANION, 'task', '--prompt-file', prompt, '--cwd', h.dir, '--output-format', 'json'], 'stdout',
      { env: { ...process.env, FAKE_ASSESSMENT_BYTES: String(BIG) } });
    strictEqual(r.timedOut, false);
    strictEqual(r.code, 0);
    ok(r.text.length > PIPE_BYTES, `the envelope is ${r.text.length} bytes`);
    const envelope = JSON.parse(r.text);
    strictEqual(envelope.status, 'success');
    ok(envelope.stdout.length >= BIG && envelope.stdout.endsWith('verdict: pass'));
  });
});

describe('critique-dispatch — a result past 64 KiB reaches a pipe whole', () => {
  // Contract: the result JSON carries Codex's whole assessment and is read
  // whole through a pipe. Rejects an exit that does not wait for stdout.
  it('prints the whole assessment and exits 0', async () => {
    const h = harness();
    const r = await piped([join(SCRIPTS, 'critique-dispatch.mjs'), '--image', pngFile(h.dir), '--repo-root', h.dir], 'stdout',
      { env: cliEnv(h, { extra: { FAKE_ASSESSMENT_BYTES: String(BIG) } }) });
    strictEqual(r.timedOut, false);
    ok(r.text.length > BIG, `stdout was cut to ${r.text.length} bytes`);
    strictEqual(r.code, 0, r.other);
    const result = JSON.parse(r.text);
    ok(result.assessment.length >= BIG && result.assessment.endsWith('verdict: pass'), 'the assessment is whole');
    strictEqual(result.verdict, 'pass');
    deepStrictEqual(h.events(), ['discovered', 'companion ran']);
  });
});

const cli = (name) => join(SCRIPTS, name);
const lines = (text) => text.split('\n').filter(Boolean);

describe('refusals return before any later work', () => {
  // A run directory with a manifest of two variants, the second rejected and
  // present on disk, so a prune that runs would delete it.
  function runDir() {
    const h = harness();
    const keep = join(h.dir, 'a-1.png');
    const rejected = join(h.dir, 'a-2.png');
    writeFileSync(keep, 'variant 1');
    writeFileSync(rejected, 'variant 2');
    const manifestFile = join(h.dir, 'manifest.json');
    writeFileSync(manifestFile, `${JSON.stringify({ run_id: 'image-x', images: [
      { path: keep, selected: true, rejected: false },
      { path: rejected, selected: false, rejected: true },
    ] }, null, 2)}\n`);
    return { ...h, rejected, manifestFile, bytes: readFileSync(manifestFile) };
  }

  // Contract: a malformed --select is a misuse, refused before the selection.
  // Rejects the refusal falling through (it then reads as a failed selection).
  it('variant-select: a malformed --select exits 2 and leaves the run as it was', async () => {
    const d = runDir();
    const r = await run([cli('variant-select.mjs'), '--manifest-file', d.manifestFile, '--select', 'abc', '--prune-rejected']);
    strictEqual(r.code, 2, r.stderr);
    deepStrictEqual(lines(r.stderr), ['variant-select: --select must be a non-negative integer']);
    strictEqual(r.stdout, '');
    deepStrictEqual(readFileSync(d.manifestFile), d.bytes, 'the manifest is unchanged');
    ok(existsSync(d.rejected), 'the rejected variant was not pruned');
  });

  // Contract: a selection that fails stops there. Rejects the failure falling
  // through to the prune and the rewrite, which would delete the rejected
  // variant of a selection that never happened.
  it('variant-select: an out-of-range --select exits 1 before it prunes or rewrites', async () => {
    const d = runDir();
    const r = await run([cli('variant-select.mjs'), '--manifest-file', d.manifestFile, '--select', '99', '--prune-rejected']);
    strictEqual(r.code, 1, r.stderr);
    deepStrictEqual(lines(r.stderr), ['variant-select: selectedIndex must be 0..1']);
    strictEqual(r.stdout, '');
    ok(existsSync(d.rejected), 'the rejected variant was not pruned');
    deepStrictEqual(readFileSync(d.manifestFile), d.bytes, 'the manifest is unchanged');
  });

  // Control for the two above: the same run with a valid --select prunes.
  it('control: variant-select with a valid --select prunes the rejected variant', async () => {
    const d = runDir();
    const r = await run([cli('variant-select.mjs'), '--manifest-file', d.manifestFile, '--select', '0', '--prune-rejected']);
    strictEqual(r.code, 0, r.stderr);
    deepStrictEqual(JSON.parse(r.stdout).pruned, [d.rejected]);
    ok(!existsSync(d.rejected));
  });

  // Contract: --estimate-only prints the estimate and stops. Rejects it going
  // on to read the prompt files (here one that does not exist) or to generate.
  it('refine-dispatch: --estimate-only reads no prompt file', async () => {
    const h = harness();
    const r = await run([cli('refine-dispatch.mjs'), '--estimate-only', '--quality', 'low', '--base-prompt-file', join(h.dir, 'missing.txt')], { env: cliEnv(h) });
    strictEqual(r.code, 0, r.stderr);
    strictEqual(r.stderr, '');
    deepStrictEqual(JSON.parse(r.stdout), { ok: true, estimate_only: true, cost: { estimate_usd: 0.005, tier: 'low', basis: 'gpt-image-2 approx per-image; prompt-mediated, actual billed by Codex/OpenAI' } });
    deepStrictEqual(h.events(), [], 'nothing was discovered or run');
  });

  // Contract: an unreadable file is refused even when an inline alternative
  // would let the run go on. Each case passes otherwise valid arguments, so a
  // refusal that falls through generates instead of refusing later.
  for (const [name, args] of [
    ['refine-dispatch: an unreadable --base-prompt-file', (dir) => [cli('refine-dispatch.mjs'), '--base-prompt-file', join(dir, 'missing.txt'), '--base-prompt', 'a logo', '--repo-root', dir]],
    ['refine-dispatch: an unreadable --feedback-file', (dir) => [cli('refine-dispatch.mjs'), '--base-prompt', 'a logo', '--feedback-file', join(dir, 'missing.txt'), '--feedback', 'red', '--repo-root', dir]],
    ['compose-dispatch: an unreadable --prompt-file', (dir) => [cli('compose-dispatch.mjs'), '--prompt-file', join(dir, 'missing.txt'), '--prompt', 'a logo', '--repo-root', dir, '--run-root', join(dir, 'runs')]],
    ['critique-dispatch: an unreadable --criteria-file', (dir) => [cli('critique-dispatch.mjs'), '--image', pngFile(dir), '--criteria-file', join(dir, 'missing.txt'), '--repo-root', dir]],
  ]) {
    it(`${name} exits 2 and discovers no companion`, async () => {
      const h = harness();
      const r = await run(args(h.dir), { env: cliEnv(h) });
      strictEqual(r.code, 2, r.stderr);
      strictEqual(lines(r.stderr).length, 1, `one diagnostic, got:\n${r.stderr}`);
      ok(r.stderr.includes('missing.txt'), r.stderr);
      strictEqual(r.stdout, '');
      deepStrictEqual(h.events(), [], 'nothing was discovered or run');
    });
  }

  // Contract: a refused parameter or a missing required option stops before
  // discovery. Rejects the refusal falling through to dispatch.
  for (const [name, args, diagnostic] of [
    ['compose-dispatch: --format gif', (dir) => [cli('compose-dispatch.mjs'), '--format', 'gif', '--prompt', 'a logo', '--repo-root', dir, '--run-root', join(dir, 'runs')], 'compose-dispatch: --format must be one of png|jpeg|webp'],
    ['compose-dispatch: --background purple', (dir) => [cli('compose-dispatch.mjs'), '--background', 'purple', '--prompt', 'a logo', '--repo-root', dir, '--run-root', join(dir, 'runs')], 'compose-dispatch: --background must be one of opaque|auto|transparent'],
    ['critique-dispatch: no --image', (dir) => [cli('critique-dispatch.mjs'), '--repo-root', dir], 'critique-dispatch: --image <path> is required'],
    ['brief-validate: no --brief-file', () => [cli('brief-validate.mjs')], 'brief-validate: --brief-file <path> is required'],
    ['refine-dispatch: --iteration x', (dir) => [cli('refine-dispatch.mjs'), '--iteration', 'x', '--base-prompt', 'a logo', '--repo-root', dir], 'refine-dispatch: --iteration must be a non-negative integer'],
    ['refine-dispatch: --max-iterations x', (dir) => [cli('refine-dispatch.mjs'), '--max-iterations', 'x', '--base-prompt', 'a logo', '--repo-root', dir], 'refine-dispatch: --max-iterations must be a non-negative integer'],
  ]) {
    it(`${name} exits 2 with one diagnostic and discovers no companion`, async () => {
      const h = harness();
      const r = await run(args(h.dir), { env: cliEnv(h) });
      strictEqual(r.code, 2, r.stderr);
      deepStrictEqual(lines(r.stderr), [diagnostic]);
      strictEqual(r.stdout, '');
      deepStrictEqual(h.events(), []);
    });
  }

  // Contract: brief-validate's status is the verdict. Rejects it returning 0
  // for a brief with issues.
  it('brief-validate: exits 0 for a valid brief and 1 for one with issues', async () => {
    const h = harness();
    const brief = { subject: 'a logo', output: { format: 'png', size: '1024x1024' }, success_criteria: ['a logo'] };
    const valid = join(h.dir, 'valid.json');
    const invalid = join(h.dir, 'invalid.json');
    writeFileSync(valid, JSON.stringify(brief));
    writeFileSync(invalid, JSON.stringify({ ...brief, output: { ...brief.output, size: '1000x1000' } }));
    const good = await run([cli('brief-validate.mjs'), '--brief-file', valid]);
    strictEqual(good.code, 0, good.stdout);
    strictEqual(JSON.parse(good.stdout).valid, true);
    const bad = await run([cli('brief-validate.mjs'), '--brief-file', invalid]);
    strictEqual(bad.code, 1, bad.stdout);
    strictEqual(JSON.parse(bad.stdout).valid, false);
  });

  // An unexpected rejection is reported as one line and exit 1, through the
  // same exit: discovery throwing for the three that send to Codex, and a
  // manifest whose `images` is not an array for variant-select. brief-validate
  // has the same handler, but no JSON brief makes validateBrief throw.
  for (const [name, args, diagnostic, events] of [
    ['compose-dispatch', (dir) => [cli('compose-dispatch.mjs'), '--prompt', 'a logo', '--repo-root', dir, '--run-root', join(dir, 'runs')], 'compose-dispatch: discovery exploded', ['discovered']],
    ['refine-dispatch', (dir) => [cli('refine-dispatch.mjs'), '--base-prompt', 'a logo', '--repo-root', dir], 'refine-dispatch: discovery exploded', ['discovered']],
    ['critique-dispatch', (dir) => [cli('critique-dispatch.mjs'), '--image', pngFile(dir), '--repo-root', dir], 'critique-dispatch: discovery exploded', ['discovered']],
    ['variant-select', (dir) => {
      const manifestFile = join(dir, 'manifest.json');
      writeFileSync(manifestFile, JSON.stringify({ images: 'not a list' }));
      return [cli('variant-select.mjs'), '--manifest-file', manifestFile];
    }, 'variant-select: manifest.images.findIndex is not a function', []],
  ]) {
    it(`${name}: an unexpected rejection prints one line and exits 1`, async () => {
      const h = harness();
      const r = await run(args(h.dir), { env: cliEnv(h, { throws: true }) });
      strictEqual(r.code, 1, r.stderr);
      deepStrictEqual(lines(r.stderr), [diagnostic]);
      strictEqual(r.stdout, '');
      deepStrictEqual(h.events(), events);
    });
  }
});

describe('each CLI flushes stderr past 64 KiB', () => {
  // parseArgs echoes an unknown option in its strict error, so a 100,000-byte
  // option name (under Linux's 128 KiB limit on one argument) makes a
  // diagnostic past a pipe's 64 KiB. Rejects an exit that does not wait for
  // stderr.
  const option = `--${'x'.repeat(100000)}`;
  for (const name of ['brief-validate.mjs', 'compose-dispatch.mjs', 'critique-dispatch.mjs', 'refine-dispatch.mjs', 'variant-select.mjs']) {
    it(`${name}: the whole diagnostic arrives, exit 2`, async () => {
      const r = await piped([cli(name), option], 'stderr');
      strictEqual(r.timedOut, false);
      ok(r.text.length > PIPE_BYTES, `stderr was cut to ${r.text.length} bytes`);
      ok(r.text.includes(`'${option}'`), 'the whole option name is in the diagnostic');
      strictEqual(r.code, 2);
    });
  }
});

describe('exitAfterFlush — the helper', () => {
  // Each case runs a child that imports the helper. `stdout`/`stderr` choose
  // how the parent reads the child: 'read' at once, 'never' (the reader never
  // drains), 'close' (the reader is gone before the child writes) or, for
  // stderr, 'after-stdout' (collected but paused until `afterBytes` of stdout
  // have arrived, then a pause, then resumed: the collector is attached first,
  // since Node resumes an unread stream at the child's exit and drops what it
  // reads with no listener). With a 'never' stream the run resolves on the
  // child's exit, which does not wait for an undrained pipe.
  function child(body, { stdout = 'read', stderr = 'read', afterBytes = 0, killMs = 8000 } = {}) {
    const code = `import { exitAfterFlush } from ${JSON.stringify(HELPER_URL)};\n${body}`;
    return new Promise((res) => {
      const started = Date.now();
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [];
      const err = [];
      let outBytes = 0;
      let timedOut = false;
      let exited = null;
      const timer = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, killMs);
      c.stderr.on('data', (d) => err.push(d));
      if (stderr !== 'read') c.stderr.pause();
      if (stdout === 'read') {
        c.stdout.on('data', (d) => {
          out.push(d);
          outBytes += d.length;
          if (stderr === 'after-stdout' && outBytes >= afterBytes && outBytes - d.length < afterBytes) setTimeout(() => c.stderr.resume(), 300);
        });
      }
      if (stdout === 'close') c.stdout.destroy();
      if (stderr === 'close') c.stderr.destroy();
      const undrained = stdout === 'never' || stderr === 'never';
      const done = () => {
        clearTimeout(timer);
        res({ ...exited, timedOut, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      };
      c.on('exit', (code, signal) => {
        exited = { code, signal, ms: Date.now() - started };
        if (undrained) { c.stdout.destroy(); c.stderr.destroy(); done(); }
      });
      c.on('close', () => { if (!undrained) done(); });
    });
  }

  // Rejects an exit that does not wait for both streams.
  it('stdout and stderr past 64 KiB both arrive whole, exit 0', async () => {
    const r = await child(`process.stdout.write('o'.repeat(${HUGE})); process.stderr.write('e'.repeat(${HUGE})); exitAfterFlush(0);`);
    strictEqual(r.code, 0);
    strictEqual(r.stdout.length, HUGE);
    strictEqual(r.stderr.length, HUGE);
  });

  // Rejects a code lost on the way out.
  it('a nonzero code is kept', async () => {
    const r = await child(`process.stdout.write('o'.repeat(${HUGE})); exitAfterFlush(3);`);
    strictEqual(r.code, 3);
    strictEqual(r.stdout.length, HUGE);
  });

  // Rejects waiting on stdout alone: stderr is held until stdout has arrived
  // whole, and must still arrive whole.
  it('stderr held behind stdout still arrives whole', async () => {
    const r = await child(`process.stdout.write('o'.repeat(${HUGE})); process.stderr.write('e'.repeat(${HUGE})); exitAfterFlush(0);`, { stderr: 'after-stdout', afterBytes: HUGE });
    strictEqual(r.code, 0);
    strictEqual(r.stdout.length, HUGE);
    strictEqual(r.stderr.length, HUGE, `stderr was cut to ${r.stderr.length} bytes`);
  });

  // Rejects relying on the event loop draining: a live interval would keep the
  // process alive forever.
  it('exits with a live ref\'d handle', async () => {
    const r = await child(`setInterval(() => {}, 1000); process.stdout.write('o'.repeat(${HUGE})); exitAfterFlush(5);`);
    strictEqual(r.timedOut, false);
    strictEqual(r.code, 5);
    strictEqual(r.stdout.length, HUGE);
  });

  // Rejects a missing fallback: a reader that never drains would hang it.
  it('a reader that never drains: exits with the code by the fallback', async () => {
    const r = await child(`process.stdout.write('o'.repeat(1 << 22)); exitAfterFlush(6, 300);`, { stdout: 'never' });
    strictEqual(r.timedOut, false);
    strictEqual(r.code, 6);
    ok(r.ms >= 300, `exited after ${r.ms} ms, before the fallback`);
  });

  // Rejects a missing error listener on either stream: a reader that went away
  // must end the wait with the same code, not an uncaught error. The other
  // stream is held undrained, because a write to a closed pipe calls back
  // (with EPIPE) before the stream emits 'error' (measured): were the other
  // stream already flushed, the exit would come first and no listener would
  // be needed.
  for (const [gone, held] of [['stdout', 'stderr'], ['stderr', 'stdout']]) {
    it(`a reader of ${gone} that went away: exits with the code before the fallback`, async () => {
      const r = await child(`process.${held}.write('h'.repeat(1 << 22)); process.${gone}.write('g'.repeat(1 << 22)); exitAfterFlush(4, 20000);`,
        { [gone]: 'close', [held]: 'never' });
      strictEqual(r.timedOut, false);
      strictEqual(r.code, 4);
    });
  }

  // Rejects a second call that restarts the flush with its own code.
  it('a second call while flushing is ignored', async () => {
    const r = await child(`process.stdout.write('o'.repeat(1 << 22)); exitAfterFlush(3, 300); exitAfterFlush(4, 50);`, { stdout: 'never' });
    strictEqual(r.code, 3);
  });

  // Rejects an unref'd fallback: with a write that never calls back and no
  // other handle, an unref'd timer lets the process end at once with code 0.
  it('the fallback timer is ref\'d', async () => {
    const r = await child('process.stdout.write = () => true; exitAfterFlush(3, 200);');
    strictEqual(r.code, 3);
    ok(r.ms >= 200, `exited after ${r.ms} ms`);
  });

  // Rejects a write that throws escaping as an uncaught error (exit 1).
  it('a write that throws exits with the code', async () => {
    const r = await child('process.stdout.write = () => { throw new Error(\'gone\'); }; exitAfterFlush(6, 20000);');
    strictEqual(r.timedOut, false);
    strictEqual(r.code, 6);
  });

  // Rejects another default: the fallback the helper arms when given none.
  it('the default fallback is EXIT_FLUSH_FALLBACK_MS, 10 s', async () => {
    strictEqual(EXIT_FLUSH_FALLBACK_MS, 10000);
    const r = await child([
      'import { writeSync } from \'node:fs\';',
      'const realSetTimeout = globalThis.setTimeout;',
      'let armed;',
      'globalThis.setTimeout = (fn, ms) => { armed = ms; return realSetTimeout(fn, ms); };',
      'const realExit = process.exit.bind(process);',
      'process.exit = (c) => { writeSync(2, `fallback=${armed}\\n`); realExit(c); };',
      'exitAfterFlush(0);',
    ].join('\n'));
    strictEqual(r.code, 0);
    strictEqual(r.stderr, 'fallback=10000\n');
  });
});
