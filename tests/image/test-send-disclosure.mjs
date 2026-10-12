// plugins/image send disclosure, held where the send happens (docs/contracts.md
// §9; ADR-0037 Decision 5, amended 2026-10-12).
//
// On the Claude host every send to Codex goes through compose-dispatch.mjs
// (refine-dispatch.mjs reuses it) or critique-dispatch.mjs. Each writes one
// line naming what it sends to Codex (OpenAI) immediately before it spawns the
// companion, and records the same fact in its result. A fixture companion
// stands in for codex-companion and appends to a log as it starts; the
// disclosure sink appends to the same log, so the log's order is the order of
// the two events. Paths that send nothing write and record nothing.
//
// Run via `node --test tests/image/test-send-disclosure.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../../plugins/image/scripts/compose-dispatch.mjs';
import { refine } from '../../plugins/image/scripts/refine-dispatch.mjs';
import { critique } from '../../plugins/image/scripts/critique-dispatch.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SCRIPTS = resolve(REPO_ROOT, 'plugins/image/scripts');
const FAKE_COMPANION = resolve(REPO_ROOT, 'tests/image/fixtures/fake-codex-companion.mjs');
const RAN = 'companion ran';

// A run with its own log, repo root and run root. `sink` is the disclosure's
// stderr: it appends to the log the fixture companion appends to.
function harness({ companion = FAKE_COMPANION } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'image-disclosure-'));
  const log = join(dir, 'events.log');
  writeFileSync(log, '');
  return {
    dir,
    repoRoot: dir,
    runRoot: join(dir, 'runs'),
    findCompanion: async () => companion,
    env: { ...process.env, FAKE_IMAGE_MODE: 'opaque', FAKE_COMPANION_LOG: log },
    stderr: { write: (s) => { appendFileSync(log, `disclosure: ${s}`); return true; } },
    events: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
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

// The disclosure line is written before the companion is spawned, and the
// result records the same fact.
function assertDisclosedThenRan(h, recorded, sent) {
  const events = h.events();
  strictEqual(events.length, 2, `one disclosure and one companion run, got:\n${events.join('\n')}`);
  strictEqual(events[1], RAN, 'the companion ran after the disclosure');
  ok(events[0].startsWith('disclosure: '), 'the disclosure was written before the companion ran');
  const line = events[0].slice('disclosure: '.length);
  deepStrictEqual(recorded, {
    recipient: 'Codex (OpenAI)',
    sent,
    codex_cwd: resolve(h.repoRoot),
    text: line,
  }, 'the result records what the line said');
  match(line, /to Codex \(OpenAI\), which runs in /);
  ok(line.includes(`runs in ${resolve(h.repoRoot)} and can read files there`), 'the line names where Codex runs and that it can read files there');
  for (const item of sent) ok(line.includes(item), `the line names ${item}`);
}

describe('send disclosure — compose-dispatch', () => {
  // Contract: compose discloses the prompt and the output path immediately
  // before it spawns the companion, and records it in the manifest. Rejects the
  // write moved after the spawn or dropped, and the record dropped.
  it('writes the disclosure before it spawns the companion, and records it', async () => {
    const h = harness();
    const m = await dispatch({ promptText: 'a logo', ...h });
    strictEqual(m.status, 'success');
    assertDisclosedThenRan(h, m.send_disclosure, ['the image prompt', 'the output file\'s path']);
    deepStrictEqual(JSON.parse(readFileSync(join(h.runRoot, m.run_id, 'manifest.json'), 'utf8')).send_disclosure, m.send_disclosure,
      'the manifest written to the run dir carries it too');
  });

  // Contract: a request rejected before any send discloses nothing — rejects a
  // disclosure written, or recorded, on the pre-flight path.
  it('a pre-flight rejection writes and records no disclosure', async () => {
    const h = harness();
    const m = await dispatch({ promptText: 'a logo', format: 'jpeg', background: 'transparent', ...h });
    strictEqual(m.error.kind, 'unsupported_parameters');
    deepStrictEqual(h.events(), [], 'nothing was disclosed and nothing ran');
    strictEqual(m.send_disclosure, null);
  });

  // Contract: no reachable companion, nothing sent — rejects a disclosure
  // written or recorded before discovery has found one.
  it('no reachable companion writes and records no disclosure', async () => {
    const h = harness();
    const m = await dispatch({ promptText: 'a logo', ...h, findCompanion: async () => null });
    strictEqual(m.error.kind, 'peer_cli_not_found');
    deepStrictEqual(h.events(), []);
    strictEqual(m.send_disclosure, null);
  });
});

describe('send disclosure — refine-dispatch', () => {
  // Contract: refine names the base prompt and the feedback in the disclosure
  // compose-dispatch writes before the spawn — rejects the feedback left out.
  it('names the base prompt and the feedback, before the companion runs', async () => {
    const h = harness();
    const r = await refine({ basePrompt: 'a logo', feedback: 'make it red', iteration: 1, ...h });
    strictEqual(r.ok, true);
    assertDisclosedThenRan(h, r.manifest.send_disclosure, ['the base prompt', 'the revision feedback', 'the output file\'s path']);
  });

  // Contract: --estimate-only sends nothing and so says nothing — rejects a
  // disclosure printed by the estimate.
  it('--estimate-only writes no disclosure', () => {
    const r = spawnSync('node', [join(SCRIPTS, 'refine-dispatch.mjs'), '--estimate-only', '--quality', 'low'], { encoding: 'utf8' });
    strictEqual(r.status, 0);
    ok(!/Codex \(OpenAI\)/.test(r.stderr), `the estimate printed a disclosure:\n${r.stderr}`);
    ok(!/send_disclosure/.test(r.stdout));
  });
});

describe('send disclosure — critique-dispatch', () => {
  // Contract: critique discloses the image and the criteria immediately before
  // it spawns the companion, and records it in its result. Rejects the write
  // moved after the spawn or dropped, and the record dropped.
  it('writes the disclosure before it spawns the companion, and records it', async () => {
    const h = harness();
    const r = await critique({ imagePath: pngFile(h.dir), criteria: ['a blue square'], ...h });
    strictEqual(r.ok, true);
    strictEqual(r.verdict, 'pass');
    assertDisclosedThenRan(h, r.send_disclosure, ['the image file (by its path)', 'the criteria']);
  });

  // Contract: an image critique refuses is never sent — rejects a disclosure
  // written or recorded before the file is verified.
  it('a refused image writes and records no disclosure', async () => {
    const h = harness();
    const fake = join(h.dir, 'secret.png');
    writeFileSync(fake, 'plain text, not a PNG');
    const r = await critique({ imagePath: fake, ...h });
    strictEqual(r.error.kind, 'unsupported');
    deepStrictEqual(h.events(), []);
    strictEqual(r.send_disclosure, null);
  });

  // Contract: no reachable companion, nothing sent — rejects a disclosure
  // written or recorded before discovery has found one.
  it('no reachable companion writes and records no disclosure', async () => {
    const h = harness();
    const r = await critique({ imagePath: pngFile(h.dir), ...h, findCompanion: async () => null });
    strictEqual(r.error.kind, 'peer_cli_not_found');
    deepStrictEqual(h.events(), []);
    strictEqual(r.send_disclosure, null);
  });
});

describe('send disclosure — the CLIs write it to stderr', () => {
  // The in-process tests above pass their own sink. Through the CLI the line
  // goes to the process's stderr, where the agent running the command sees it.
  // AGENTIC_COMPANIONS_ROOT points discovery at a stand-in library that
  // resolves to the fixture companion, so nothing reaches a real one.
  const cliEnv = (h) => {
    const lib = join(h.dir, 'companions');
    mkdirSync(lib);
    writeFileSync(join(lib, 'discover-peer.mjs'), `export async function discoverPeerCompanion() { return { ok: true, path: ${JSON.stringify(FAKE_COMPANION)} }; }\n`);
    return { ...h.env, AGENTIC_COMPANIONS_ROOT: lib };
  };

  // Contract: rejects the compose CLI's default sink replaced by one that
  // writes nowhere, which would leave the disclosure only in the manifest.
  it('compose-dispatch.mjs prints the disclosure on stderr', () => {
    const h = harness();
    const r = spawnSync('node', [join(SCRIPTS, 'compose-dispatch.mjs'), '--prompt', 'a logo', '--repo-root', h.repoRoot, '--run-root', h.runRoot], { encoding: 'utf8', env: cliEnv(h) });
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(h.events(), [RAN]);
    match(r.stderr, /^image: sending the image prompt and the output file's path to Codex \(OpenAI\), which runs in .+ and can read files there$/m);
  });

  // Contract: the same for critique's CLI.
  it('critique-dispatch.mjs prints the disclosure on stderr', () => {
    const h = harness();
    const r = spawnSync('node', [join(SCRIPTS, 'critique-dispatch.mjs'), '--image', pngFile(h.dir), '--repo-root', h.repoRoot], { encoding: 'utf8', env: cliEnv(h) });
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(h.events(), [RAN]);
    match(r.stderr, /^image: sending the image file \(by its path\) and the criteria to Codex \(OpenAI\), which runs in .+ and can read files there$/m);
  });
});
