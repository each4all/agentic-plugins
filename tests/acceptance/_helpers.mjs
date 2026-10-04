// Shared subprocess helper for the acceptance suites.
//
// The acceptance files drive the real CLIs as black boxes. Doing that safely
// needs three properties that ad-hoc `spawnSync` calls do not give:
//
//   1. HERMETIC ENV. The suites already isolate HOME and CODEX_HOME but used to
//      inherit PATH, so a child could shell out to the developer's real `claude`
//      / `codex`. `settings.mjs` calls `runDoctor` unconditionally, and doctor
//      probes each host CLI up to 8 times at 5s apiece -- ~40s of ambient,
//      heavy-tailed latency inside a child the test bounds at 30s. CI installs
//      neither binary, so the suites were hermetic only by accident of the CI
//      image. `hermeticEnv` makes a local child see what a CI child sees.
//
//   2. A LIVENESS GUARD ON EVERY SPAWN. A synchronous `spawnSync` blocks the
//      event loop, so `node --test`'s `--test-timeout` cannot preempt it, and
//      node's default per-test timeout is Infinity. The `timeout` option is the
//      only bound that exists; an unguarded spawn can hang a CI job outright.
//
//   3. TIMEOUTS THAT READ AS INFRASTRUCTURE FAILURES. `spawnSync` reports a
//      timeout as `status: null` (it does not throw), so a bare
//      `strictEqual(res.status, 0, 'must succeed')` reports a slow machine as a
//      fail-closed regression. Every helper below raises `SpawnInfraError`
//      instead, carrying the reason, budget, elapsed time and argv.
//
// Not discovered by `node --test`: the stem `_helpers` matches none of Node's
// test-file patterns (`*.test`, `*-test`, `*_test`, `test-*`, `test`). It mirrors
// the co-location precedent of `tests/cross-host/_helpers.mjs`.
// Behaviour is gated by `tests/acceptance/test-acceptance-helpers.mjs`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strictEqual } from 'node:assert/strict';

/**
 * Ambient config no acceptance child needs, scrubbed from every child env.
 *
 * A child that needs an `AGENTIC_*` value receives it as an explicit override, and
 * the `TELEGRAM_*` variables are what a machine that used the egress removed by
 * ADR-0064 may still export. Scrubbing both prefixes therefore costs nothing and buys
 * CI parity: a local child sees the same empty ambient surface a CI child sees.
 */
const AMBIENT_PREFIX = /^(?:AGENTIC_|TELEGRAM_)/;

/**
 * Liveness backstop, not a performance assertion. Inside a hermetic child the
 * largest *bounded* internal wait is the handoff sidecar's two 10s `execFile`
 * renders of runtime `footer.mjs`; the `git` probes underneath are unbounded, so
 * no finite number is a derived maximum. 60s leaves headroom over the bounded
 * waits while still turning a hang into a fast, diagnosable failure.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Mirrors `spawnSync`'s own default. */
export const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Precedence: explicit per-call budget > AGENTIC_TEST_SPAWN_TIMEOUT_MS > default.
 *
 * Note that `0` does NOT mean "unbounded" here, even though native `spawnSync`
 * reads `timeout: 0` that way. The guard is not optional: an unguarded synchronous
 * spawn cannot be preempted by `node --test`, whose default per-test timeout is
 * Infinity, so a hung child would wedge the whole run.
 */
export function resolveTimeoutMs(explicitMs, env = process.env) {
  if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
  const fromEnv = Number(env.AGENTIC_TEST_SPAWN_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

let shimDir = null;

/**
 * A bin directory holding only a `node` symlink.
 *
 * Children need bare `node` on PATH -- `peer-runner.mjs` spawns `'node'`. The
 * interpreter's own directory cannot be reused for that: on a developer machine it
 * also holds `codex`, which is exactly what we are hiding.
 */
function shimBin() {
  if (shimDir) return shimDir;
  const dir = mkdtempSync(join(tmpdir(), 'accept-shim-bin-'));
  // Register cleanup BEFORE the symlink, so a symlink failure still reclaims the
  // directory; and memoize only AFTER it succeeds, so a failure cannot poison the
  // memo into handing out a bin dir with no `node` in it.
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leaked temp dir must never fail a test run.
    }
  });
  symlinkSync(process.execPath, join(dir, 'node'));
  shimDir = dir;
  return shimDir;
}

/**
 * The CI-parity child environment.
 *
 * Scrubs the *base* and applies `overrides` *afterwards* -- scrubbing the merged
 * env would strip the `AGENTIC_*` values a suite deliberately injects. An override
 * whose value is `undefined` means "ensure absent". Callers therefore pass DELTAS,
 * never `{ ...process.env, ... }`; spreading the ambient env would defeat the scrub.
 */
export function hermeticEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AMBIENT_PREFIX.test(key)) env[key] = value;
  }
  env.PATH = `${shimBin()}:/usr/bin:/bin`;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

const CLIP = 2048;
const clip = (text) => {
  const s = String(text ?? '');
  return s.length > CLIP ? `${s.slice(0, CLIP)}… (${s.length} bytes)` : s || '(empty)';
};

const HEADLINE = {
  ETIMEDOUT: 'did not complete within its liveness budget',
  ENOBUFS: 'produced more output than the buffer cap allows',
  ENOENT: 'could not be spawned',
  KILLED: 'was killed by a signal',
};

/**
 * A child hit its liveness guard, flooded its output, or failed to spawn. This is
 * never a statement about the code under test.
 */
export class SpawnInfraError extends Error {
  constructor({ argv, budgetMs, elapsedMs, code, signal, stdout, stderr }) {
    super(
      [
        `acceptance child ${HEADLINE[code] ?? 'failed'} — this is an INFRASTRUCTURE `
          + 'failure, not an assertion failure.',
        `  reason:  ${code ?? 'killed'}${signal ? ` (signal ${signal})` : ''}`,
        `  budget:  ${budgetMs} ms`,
        `  elapsed: ${elapsedMs} ms`,
        `  argv:    ${argv.join(' ')}`,
        `  stdout:  ${clip(stdout)}`,
        `  stderr:  ${clip(stderr)}`,
      ].join('\n'),
    );
    this.name = 'SpawnInfraError';
    this.code = code;
    this.signal = signal;
    this.budgetMs = budgetMs;
    this.elapsedMs = elapsedMs;
    this.argv = argv;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Reject a spawn failure or a signal death; pass a real exit code through
 * untouched so callers keep their own `strictEqual(res.status, 0, …)` assertions.
 */
function assertNoInfraFailure(res, ctx) {
  if (res.error) {
    throw new SpawnInfraError({ ...ctx, code: res.error.code ?? res.error.message, signal: res.signal, stdout: res.stdout, stderr: res.stderr });
  }
  if (res.status === null) {
    throw new SpawnInfraError({ ...ctx, code: 'KILLED', signal: res.signal, stdout: res.stdout, stderr: res.stderr });
  }
  return res;
}

const spawnOpts = (env, cwd, input, timeoutMs, maxBuffer) => ({
  encoding: 'utf8',
  env: hermeticEnv(env),
  ...(cwd ? { cwd } : {}),
  ...(input === undefined ? {} : { input }),
  timeout: timeoutMs,
  maxBuffer,
  // SIGTERM only asks. A child that traps it would hold `spawnSync` past its
  // budget, which is the one thing the guard exists to prevent. Nothing in the
  // acceptance suites asserts on a killed child's signal or partial output.
  killSignal: 'SIGKILL',
});

/** Run `node <args>` hermetically. Returns the raw spawnSync result. */
export function runNode(args, { env = {}, cwd, input, timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  const budgetMs = resolveTimeoutMs(timeoutMs);
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, args, spawnOpts(env, cwd, input, budgetMs, maxBuffer));
  return assertNoInfraFailure(res, { argv: ['node', ...args], budgetMs, elapsedMs: Date.now() - startedAt });
}

/** Run `node <args>`, require a zero exit, return trimmed stdout. */
export function runNodeOk(args, opts = {}) {
  const res = runNode(args, opts);
  strictEqual(res.status, 0, `node ${args.join(' ')} exited ${res.status}\n${res.stderr}`);
  return res.stdout.trim();
}

/** Run `git <args>`, require a zero exit, return trimmed stdout. */
export function runGit(args, { cwd, timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  const budgetMs = resolveTimeoutMs(timeoutMs);
  const startedAt = Date.now();
  const res = spawnSync('git', args, spawnOpts({}, cwd, undefined, budgetMs, maxBuffer));
  assertNoInfraFailure(res, { argv: ['git', ...args], budgetMs, elapsedMs: Date.now() - startedAt });
  strictEqual(res.status, 0, `git ${args.join(' ')} exited ${res.status}\n${res.stderr}`);
  return res.stdout.trim();
}

