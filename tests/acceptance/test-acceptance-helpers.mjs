// Gate for the acceptance suite's shared subprocess helper (tests/acceptance/_helpers.mjs).
//
// The acceptance suites drive real CLIs as black boxes. Each used to roll
// its own `spawnSync`, which left three defects that the helper closes and this
// file locks down:
//
//   I1  A liveness budget must dominate the guarded child's own bounded internal
//       waits. `settings.mjs` calls `runDoctor` unconditionally (settings.mjs:109),
//       whose `inspectCli` fan-out is 8 serial probes x 5s per host
//       (doctor.mjs:40,102-127) ~= 40s -- above the 30s budget the acceptance
//       suite gave it. A hermetic PATH removes that fan-out entirely.
//   I2  A liveness event must surface as an INFRASTRUCTURE failure, never as a
//       correctness mismatch. `spawnSync` reports a timeout as `status: null`,
//       so `strictEqual(res.status, 0, 'must succeed')` reported a timeout as a
//       phantom fail-closed regression.
//   I3  An acceptance test must not depend on binaries it does not control. CI
//       installs neither `claude` nor `codex`, so the suite was hermetic by
//       accident of the CI image; on a developer machine (which has both, by
//       definition of this framework) the same children shelled out to them.
//
// The PATH tests below plant FAKE `claude`/`codex` on `process.env.PATH` before
// asserting they are unreachable, and a control case proves the fakes really are
// reachable without the helper. Asserting ENOENT without planting them would
// false-pass on CI, where they were never present to begin with.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, throws } from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_TIMEOUT_MS,
  SpawnInfraError,
  hermeticEnv,
  resolveTimeoutMs,
  runNode,
  runNodeOk,
} from './_helpers.mjs';

// A child that reports what resolves through ITS OWN PATH and env.
const PROBE = `
import { spawnSync } from 'node:child_process';
const probe = (name) => {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return r.error ? r.error.code : r.status;
};
process.stdout.write(JSON.stringify({
  claude: probe('claude'),
  codex: probe('codex'),
  node: probe('node'),
  git: probe('git'),
  runtimeRoot: process.env.AGENTIC_RUNTIME_ROOT ?? null,
  channel: process.env.AGENTIC_NOTIFY_EGRESS_CHANNEL ?? null,
}));
`;

describe('acceptance shared spawn helper', () => {
  let fakeBin;
  let probePath;
  let savedPath;

  before(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'accept-fake-bin-'));
    for (const cli of ['claude', 'codex']) {
      const p = join(fakeBin, cli);
      writeFileSync(p, '#!/bin/sh\necho "0.0.0 (fake)"\n');
      chmodSync(p, 0o755);
    }
    probePath = join(fakeBin, 'probe.mjs');
    writeFileSync(probePath, PROBE);

    // Plant the fakes on the PARENT's PATH, so everything below proves the helper
    // SCRUBS them rather than proving they happened to be absent.
    savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${savedPath}`;
  });

  after(() => {
    process.env.PATH = savedPath;
    rmSync(fakeBin, { recursive: true, force: true });
  });

  describe('hermeticEnv', () => {
    it('control: the planted fake host CLIs ARE reachable through the ambient env', () => {
      // Without this, the ENOENT assertions below would pass vacuously on CI.
      const res = spawnSync(process.execPath, [probePath], { encoding: 'utf8' });
      strictEqual(res.status, 0, res.stderr);
      const seen = JSON.parse(res.stdout);
      strictEqual(seen.claude, 0, 'the fake claude must be executable on the ambient PATH');
      strictEqual(seen.codex, 0, 'the fake codex must be executable on the ambient PATH');
    });

    it('I3: hides claude/codex from the child while keeping node and git reachable', () => {
      const res = runNode([probePath]);
      strictEqual(res.status, 0, res.stderr);
      const seen = JSON.parse(res.stdout);
      strictEqual(seen.claude, 'ENOENT', 'claude must be unreachable from a hermetic child');
      strictEqual(seen.codex, 'ENOENT', 'codex must be unreachable from a hermetic child');
      strictEqual(seen.node, 0, 'bare `node` must still resolve (peer-runner and `/usr/bin/env node` need it)');
      strictEqual(seen.git, 0, 'bare `git` must still resolve (state.mjs probes it)');
    });

    it('scrubs ambient AGENTIC_* / TELEGRAM_* out of the child env (CI parity)', () => {
      process.env.AGENTIC_RUNTIME_ROOT = '/ambient/should/not/leak';
      process.env.AGENTIC_NOTIFY_EGRESS_CHANNEL = 'telegram';
      try {
        const seen = JSON.parse(runNode([probePath]).stdout);
        strictEqual(seen.runtimeRoot, null, 'ambient AGENTIC_RUNTIME_ROOT must not reach the child');
        strictEqual(seen.channel, null, 'ambient egress channel must not reach the child');
      } finally {
        delete process.env.AGENTIC_RUNTIME_ROOT;
        delete process.env.AGENTIC_NOTIFY_EGRESS_CHANNEL;
      }
    });

    it('an override wins over the scrub', () => {
      const env = hermeticEnv({ AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_CHAT_ID: '42' });
      strictEqual(env.AGENTIC_NOTIFY_EGRESS_CHANNEL, 'telegram');
      strictEqual(env.TELEGRAM_CHAT_ID, '42');
      strictEqual(hermeticEnv({ AGENTIC_RUNTIME_ROOT: '/pinned' }).AGENTIC_RUNTIME_ROOT, '/pinned');
    });

    it('an `undefined` override means ensure-absent, not the string "undefined"', () => {
      // `{ ...base, ...extra, TELEGRAM_BOT_TOKEN: undefined }` expresses "set these,
      // then guarantee the token is absent" — and the trailing key must win over
      // anything `extra` carried.
      const env = hermeticEnv({ TELEGRAM_CHAT_ID: 'chat', TELEGRAM_BOT_TOKEN: undefined });
      strictEqual(env.TELEGRAM_CHAT_ID, 'chat');
      ok(!('TELEGRAM_BOT_TOKEN' in env), '`undefined` must delete the key');
    });

    it('never leaks the ambient PATH, so a hermetic child cannot inherit host CLIs', () => {
      ok(!hermeticEnv().PATH.includes(fakeBin), 'the ambient PATH must be replaced, not prepended to');
      ok(hermeticEnv().PATH.endsWith(':/usr/bin:/bin'), 'system tools stay reachable');
    });
  });

  describe('I2 — a timeout is an infrastructure failure, never an assertion failure', () => {
    it('runNode throws SpawnInfraError naming ETIMEDOUT, the budget, and the argv', () => {
      let caught;
      throws(
        () => runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 500 }),
        (err) => {
          caught = err;
          return err instanceof SpawnInfraError;
        },
      );
      strictEqual(caught.code, 'ETIMEDOUT');
      strictEqual(caught.budgetMs, 500);
      ok(/ETIMEDOUT/.test(caught.message), 'the message must name ETIMEDOUT');
      ok(/500 ms/.test(caught.message), 'the message must carry the budget');
      ok(caught.message.includes('setTimeout'), 'the message must carry the argv');
      ok(/INFRASTRUCTURE/i.test(caught.message), 'the message must not read as a correctness failure');
    });

    it('a real non-zero exit is NOT an infrastructure failure — callers keep asserting status', () => {
      strictEqual(runNode(['-e', 'process.exit(3)']).status, 3);
      // A missing script is a normal node exit(1), not an infra failure.
      strictEqual(runNode([join(fakeBin, 'no-such-script.mjs')]).status, 1);
    });

    it('runNodeOk returns trimmed stdout and asserts a zero exit', () => {
      strictEqual(runNodeOk(['-e', 'process.stdout.write("  hi\\n")']), 'hi');
      throws(() => runNodeOk(['-e', 'process.exit(2)']));
    });
  });

  describe('output is bounded', () => {
    // A child that hangs by FLOODING stdout is exactly the failure class the guard
    // exists to report, so it must surface as an ENOBUFS infrastructure failure.
    const FLOOD = 'const b = "y".repeat(1 << 16); (function w() { while (process.stdout.write(b)) {} setImmediate(w); })(); setInterval(() => {}, 1000);';

    it('runNode reports a flooding child as ENOBUFS, with the process still alive', () => {
      let caught;
      throws(
        () => runNode(['-e', FLOOD], { timeoutMs: 30_000, maxBuffer: 1 << 20 }),
        (err) => { caught = err; return err instanceof SpawnInfraError; },
      );
      strictEqual(caught.code, 'ENOBUFS');
    });
  });

  describe('budget policy', () => {
    it('is a 60s liveness backstop by default', () => {
      strictEqual(DEFAULT_TIMEOUT_MS, 60_000);
      strictEqual(resolveTimeoutMs(undefined, {}), 60_000);
    });

    it('honours an explicit per-call budget over the env override', () => {
      strictEqual(resolveTimeoutMs(1234, { AGENTIC_TEST_SPAWN_TIMEOUT_MS: '9999' }), 1234);
    });

    it('honours AGENTIC_TEST_SPAWN_TIMEOUT_MS, ignoring a non-positive or unparsable value', () => {
      strictEqual(resolveTimeoutMs(undefined, { AGENTIC_TEST_SPAWN_TIMEOUT_MS: '90000' }), 90_000);
      strictEqual(resolveTimeoutMs(undefined, { AGENTIC_TEST_SPAWN_TIMEOUT_MS: '0' }), 60_000);
      strictEqual(resolveTimeoutMs(undefined, { AGENTIC_TEST_SPAWN_TIMEOUT_MS: 'soon' }), 60_000);
    });
  });
});
