#!/usr/bin/env node
// plugins/designer/scripts/peer-runner.mjs
//
// ADR-0023 PR-B: caller-side peer-runner supervisor primitive for the
// designer plugin. This script owns operational lifecycle state around
// companion dispatch (ledger, status, cancel, sweep, retention) while
// leaving companions/contract.md v0.1.1 unchanged.
//
// PR-B intentionally does not replace verb command runbooks yet. Existing
// commands may continue to call dispatch-peer.mjs until PR-C migrates
// selected dispatch paths to this managed runner.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { discoverRuntimePluginRoot, NOTIFY_MIN_RUNTIME_VERSION } from './discover-runtime.mjs';
import { resolveCompanionPath, validateEnvelopeShape } from './dispatch-peer.mjs';
import { recordPendingEnsemble } from './state.mjs';

export const HANDLE_SCHEMA_VERSION = '1.0';
export const VALID_PEERS = new Set(['claude', 'codex']);
export const VALID_KINDS = new Set(['ensemble', 'peer-now', 'manual']);
export const VALID_OUTPUT_FORMATS = new Set(['text', 'json']);
export const VALID_STATUSES = new Set([
  'queued',
  'spawning',
  'running',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
  'orphaned',
  'pruned',
]);
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned', 'pruned']);

export const DEFAULT_CANCEL_GRACE_MS = 10000;
export const DEFAULT_STALE_GRACE_MS = 60000;
export const DEFAULT_RETENTION_TTL_DAYS = 14;
export const DEFAULT_RETENTION_CAP = 200;

const HANDLE_FILE = 'handle.json';
const STDOUT_FILE = 'stdout.log';
const STDERR_FILE = 'stderr.log';
const ENVELOPE_FILE = 'envelope.json';
const PROMPT_FILE = 'prompt.xml';

// designer trim — canonical peer-run home only (ADR-0042 SD7: no legacy
// dual-home, no ambiguity resolution, no migration surface).
const PEER_RUNS_DIR_RELS = Object.freeze({
  canonical: '.agentic-plugins/state/designer/peer-runs',
});

export function peerRunsDir(repoRoot, { home = 'canonical' } = {}) {
  const rel = PEER_RUNS_DIR_RELS[home];
  if (!rel) throw new Error(`unknown peer-run state home: ${home}`);
  return join(resolve(repoRoot), rel);
}

export function peerRunDir(repoRoot, runId, opts = {}) {
  assertSafeRunId(runId);
  return join(peerRunsDir(repoRoot, opts), runId);
}

export function peerRunPaths(repoRoot, runId, opts = {}) {
  const dir = peerRunDir(repoRoot, runId, opts);
  return {
    dir,
    handle: join(dir, HANDLE_FILE),
    stdout: join(dir, STDOUT_FILE),
    stderr: join(dir, STDERR_FILE),
    envelope: join(dir, ENVELOPE_FILE),
    prompt: join(dir, PROMPT_FILE),
  };
}

// designer trim — all three resolvers collapse to the canonical home
// (no dual-home write block, read ambiguity, or sweep preference).
async function resolvePeerRunPathsForWrite(repoRoot, runId) {
  return peerRunPaths(repoRoot, runId, { home: 'canonical' });
}

async function resolvePeerRunPathsForRead(repoRoot, runId) {
  return peerRunPaths(repoRoot, runId, { home: 'canonical' });
}

async function resolvePeerRunsDirForSweep(repoRoot) {
  return peerRunsDir(repoRoot, { home: 'canonical' });
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// ADR-0040 §5 peer-run terminal self-sensor
//
// Emits ONE `peer-run-terminal` notification event for every terminal
// transition this runner itself writes: runPeer's final updateHandle, the
// missing-companion early return, cancelPeerRun's cancelled finalize, and
// sweep reconcileOne's envelope-present / orphaned reconciliations. `pruned`
// transitions are deliberately NOT emit points (retention cleanup of runs
// whose terminal state was already notified; the payload is being deleted).
// Designer is included from day one (ADR-0040 §5): its peer-runner is a full
// sibling, which partially compensates designer's missing footer sidecar.
//
// The repo-ident + event_id composition below is a copy-not-import sibling of
// the canonical contract lib (plugins/runtime/scripts/lib/notify-schema.mjs,
// ADR-0010 §5): two producers observing the same subject moment must build
// byte-identical event_ids — <repo-ident>:peer-run-terminal:<run_id>:<status>
// — or the §1 cross-surface dedupe breaks (runPeer's live emit and a later
// sweep reconcile of the same run must collapse to one notification).
//
// Fail-closed silent (ADR-0040 §7): never throws, never writes stdout or
// stderr (peer-runner stdout is a machine channel — run/status/cancel/sweep
// JSON results). A missing or too-old runtime (NOTIFY_MIN_RUNTIME_VERSION
// gate — designer's discover copy gates directly on notify.mjs, having no
// footer consumer) is a silent no-op with no stale-cache fallback.

const SELF_SENSOR_SOURCE = 'peer-runner-designer';
const SELF_SENSOR_TIMEOUT_MS = 5000;

function deriveRepoIdentForNotify(repoRoot) {
  const resolved = resolve(repoRoot);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Nonexistent path — resolve-only is still deterministic for a spelling.
  }
  const base = basename(real).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return `${base}-${hash}`;
}

export async function emitPeerRunTerminal(args) {
  try {
    // Destructure INSIDE the try: a null/garbage argument on this exported
    // helper must fail-close like every other failure, not throw at the
    // parameter-destructuring step (Codex plan-verify MINOR).
    const {
      repoRoot,
      runId,
      status,
      errorKind = null,
      workflowPath = null,
      handlePath = null,
      env = process.env,
    } = args ?? {};
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) return;
    if (typeof runId !== 'string' || runId.length === 0) return;
    // §5 pruned-skip + defensive terminal gate. Statuses are colon-free set
    // members, so the event_id's last segment stays parseable.
    if (status === 'pruned' || !TERMINAL_STATUSES.has(status)) return;
    const runtimeRoot = await discoverRuntimePluginRoot({
      env,
      minVersion: NOTIFY_MIN_RUNTIME_VERSION,
    });
    if (!runtimeRoot) return;
    const notifyPath = join(runtimeRoot, 'scripts', 'notify.mjs');
    if (!existsSync(notifyPath)) return;
    const refs = { run_id: runId };
    if (typeof workflowPath === 'string' && workflowPath.length > 0) {
      refs.workflow_id = basename(workflowPath, '.md');
    }
    if (typeof handlePath === 'string' && handlePath.length > 0) {
      refs.path = handlePath;
    }
    const event = {
      event_id: `${deriveRepoIdentForNotify(repoRoot)}:peer-run-terminal:${runId}:${status}`,
      source: SELF_SENSOR_SOURCE,
      kind: 'peer-run-terminal',
      title: `designer peer run ${status}`,
      body: errorKind ? `run ${runId} ${status} (${errorKind})` : `run ${runId} ${status}`,
      urgency: 'normal',
      refs,
    };
    spawnSync(process.execPath, [notifyPath, 'emit', '--repo-root', resolve(repoRoot)], {
      input: `${JSON.stringify(event)}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: SELF_SENSOR_TIMEOUT_MS,
      env,
    });
  } catch {
    // Fail-closed: a notification failure must never break the peer-run
    // lifecycle or leak onto the machine-channel stdout.
  }
}

export function generateRunId(kind = 'manual', now = new Date()) {
  const prefix = VALID_KINDS.has(kind) ? kind : 'manual';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${stamp}-${suffix}`;
}

export function validateHandleShape(handle) {
  if (handle === null || typeof handle !== 'object' || Array.isArray(handle)) {
    return { ok: false, reason: 'handle is not an object' };
  }
  const required = [
    'schema_version',
    'run_id',
    'plugin',
    'kind',
    'workflow_path',
    'phase',
    'ensemble_type',
    'host',
    'peer_host',
    'model',
    'effort',
    'cwd',
    'output_format',
    'status',
    'pid',
    'pgid',
    'process_fingerprint',
    'started_at',
    'updated_at',
    'completed_at',
    'last_output_at',
    'stdout_bytes',
    'stderr_bytes',
    'exit_code',
    'error_kind',
    'prompt_retained',
  ];
  for (const key of required) {
    if (!(key in handle)) {
      return { ok: false, reason: `missing required field: ${key}` };
    }
  }
  if (handle.schema_version !== HANDLE_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema_version: ${handle.schema_version}` };
  }
  if (handle.plugin !== 'designer') {
    return { ok: false, reason: `plugin must be designer: ${handle.plugin}` };
  }
  if (!VALID_KINDS.has(handle.kind)) {
    return { ok: false, reason: `invalid kind: ${handle.kind}` };
  }
  if (!VALID_PEERS.has(handle.peer_host)) {
    return { ok: false, reason: `invalid peer_host: ${handle.peer_host}` };
  }
  if (!VALID_OUTPUT_FORMATS.has(handle.output_format)) {
    return { ok: false, reason: `invalid output_format: ${handle.output_format}` };
  }
  if (!VALID_STATUSES.has(handle.status)) {
    return { ok: false, reason: `invalid status: ${handle.status}` };
  }
  if (typeof handle.process_fingerprint !== 'object' || handle.process_fingerprint === null) {
    return { ok: false, reason: 'process_fingerprint must be object' };
  }
  if (!['macos_lstart_command', 'linux_proc_starttime', 'none'].includes(handle.process_fingerprint.kind)) {
    return { ok: false, reason: `invalid process_fingerprint.kind: ${handle.process_fingerprint.kind}` };
  }
  for (const key of ['stdout_bytes', 'stderr_bytes']) {
    if (!Number.isInteger(handle[key]) || handle[key] < 0) {
      return { ok: false, reason: `${key} must be a non-negative integer` };
    }
  }
  return { ok: true };
}

export async function readHandle(handlePath) {
  const handle = JSON.parse(await readFile(handlePath, 'utf8'));
  const shape = validateHandleShape(handle);
  if (!shape.ok) {
    throw new Error(`invalid handle ${handlePath}: ${shape.reason}`);
  }
  return handle;
}

export async function writeHandle(handlePath, handle) {
  const shape = validateHandleShape(handle);
  if (!shape.ok) {
    throw new Error(`refusing to write invalid handle: ${shape.reason}`);
  }
  await mkdir(dirname(handlePath), { recursive: true, mode: 0o700 });
  const tmp = join(
    dirname(handlePath),
    `.${basename(handlePath)}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`,
  );
  await writeFile(tmp, `${JSON.stringify(handle, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, handlePath);
}

let atomicWriteCounter = 0;

async function updateHandle(handlePath, mutator) {
  const handle = await readHandle(handlePath);
  const next = await mutator(handle) ?? handle;
  next.updated_at = new Date().toISOString();
  await writeHandle(handlePath, next);
  return next;
}

async function touchPrivateFile(path) {
  const fh = await open(path, 'a', 0o600);
  await fh.close();
}

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('run_id must be a non-empty string');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(runId) || runId.includes('..') || runId.includes('/')) {
    throw new Error(`unsafe run_id: ${runId}`);
  }
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseRetentionTtlDays(value, fallback) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function makeHandle({
  runId,
  kind,
  workflowPath,
  phase,
  ensembleType,
  host,
  peer,
  model,
  effort,
  cwd,
  outputFormat,
  promptRetained,
}) {
  const at = nowIso();
  return {
    schema_version: HANDLE_SCHEMA_VERSION,
    run_id: runId,
    plugin: 'designer',
    kind,
    workflow_path: workflowPath ?? null,
    phase: phase ?? null,
    ensemble_type: ensembleType ?? null,
    host: host ?? null,
    peer_host: peer,
    model: model ?? null,
    effort: effort ?? null,
    cwd: resolve(cwd ?? process.cwd()),
    output_format: outputFormat,
    status: 'queued',
    pid: null,
    pgid: null,
    process_fingerprint: { kind: 'none' },
    started_at: at,
    updated_at: at,
    completed_at: null,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    exit_code: null,
    error_kind: null,
    prompt_retained: Boolean(promptRetained),
  };
}

function validateRunArgs(args) {
  if (!VALID_PEERS.has(args.peer)) {
    throw new Error(`--peer must be claude or codex (got ${args.peer})`);
  }
  if (!VALID_KINDS.has(args.kind)) {
    throw new Error(`--kind must be ensemble, peer-now, or manual (got ${args.kind})`);
  }
  if (!VALID_OUTPUT_FORMATS.has(args.outputFormat)) {
    throw new Error(`--output-format must be text or json (got ${args.outputFormat})`);
  }
  if (args.promptFile && args.promptText !== undefined) {
    throw new Error('Provide either --prompt-file or --prompt-text, not both.');
  }
  if (!args.promptFile && args.promptText === undefined) {
    throw new Error('Provide --prompt-file or --prompt-text.');
  }
  if (args.kind === 'ensemble') {
    for (const key of ['runId', 'workflowPath', 'phase', 'ensembleType']) {
      if (typeof args[key] !== 'string' || args[key].length === 0) {
        throw new Error(`--${camelToFlag(key)} is required for --kind ensemble`);
      }
    }
  }
  if (args.runId !== undefined) assertSafeRunId(args.runId);
}

function camelToFlag(key) {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

async function materializePrompt({ paths, promptText, promptFile, retainPrompt }) {
  if (retainPrompt) {
    if (promptFile) {
      await copyFile(promptFile, paths.prompt);
    } else {
      await writeFile(paths.prompt, promptText, { mode: 0o600 });
    }
    return { promptFile: paths.prompt, cleanup: null };
  }

  if (promptFile) {
    return { promptFile, cleanup: null };
  }

  const dir = await mkdtemp(join(tmpdir(), 'designer-peer-runner-prompt-'));
  const file = join(dir, 'prompt.xml');
  await writeFile(file, promptText, { mode: 0o600 });
  return { promptFile: file, cleanup: dir };
}

async function recordPendingIfEnsemble(handle) {
  if (handle.kind !== 'ensemble') return;
  try {
    await recordPendingEnsemble({
      workflowPath: handle.workflow_path,
      phase: handle.phase,
      ensemble_type: handle.ensemble_type,
      run_id: handle.run_id,
      started_at: handle.started_at,
    });
  } catch (err) {
    process.stderr.write(
      `peer-runner: pending registration failed (continuing): ${err.message}\n`,
    );
  }
}

export async function fingerprintForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'none' };

  if (process.platform === 'linux') {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
      const end = statText.lastIndexOf(')');
      const rest = statText.slice(end + 2).trim().split(/\s+/);
      const starttime = rest[19]; // proc_pid_stat(5): field 22 after comm/state offset.
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      return {
        kind: 'linux_proc_starttime',
        starttime,
        command: cmdline.replace(/\0/g, ' ').trim(),
      };
    } catch {
      return { kind: 'none' };
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out) return { kind: 'none' };
      const m = out.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([\s\S]*)$/);
      return {
        kind: 'macos_lstart_command',
        lstart: m ? m[1] : out,
        command: m ? m[2] : '',
      };
    } catch {
      return { kind: 'none' };
    }
  }

  return { kind: 'none' };
}

export async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function fingerprintsMatch(recorded, current) {
  if (!recorded || recorded.kind === 'none') return false;
  if (!current || current.kind !== recorded.kind) return false;
  if (recorded.kind === 'linux_proc_starttime') {
    return recorded.starttime === current.starttime;
  }
  if (recorded.kind === 'macos_lstart_command') {
    return recorded.lstart === current.lstart && recorded.command === current.command;
  }
  return false;
}

async function verifiedProcessForHandle(handle) {
  if (!Number.isInteger(handle.pid) || handle.pid <= 0) {
    return { ok: false, reason: 'no_pid' };
  }
  if (!(await isProcessAlive(handle.pid))) {
    return { ok: false, reason: 'not_running' };
  }
  const current = await fingerprintForPid(handle.pid);
  if (!fingerprintsMatch(handle.process_fingerprint, current)) {
    return { ok: false, reason: 'unsupported_unverifiable', current_fingerprint: current };
  }
  return { ok: true };
}

async function originalProcessAliveForHandle(handle) {
  if (!Number.isInteger(handle.pid) || handle.pid <= 0) return false;
  if (!(await isProcessAlive(handle.pid))) return false;
  if (handle.process_fingerprint?.kind === 'none') return true;

  const current = await fingerprintForPid(handle.pid);
  return fingerprintsMatch(handle.process_fingerprint, current);
}

async function sendSignal(handle, signal) {
  const targets = [];
  if (Number.isInteger(handle.pgid) && handle.pgid > 0) targets.push(-handle.pgid);
  if (Number.isInteger(handle.pid) && handle.pid > 0) targets.push(handle.pid);

  let delivered = false;
  let lastError = null;
  for (const target of targets) {
    try {
      process.kill(target, signal);
      delivered = true;
    } catch (err) {
      if (err?.code !== 'ESRCH') lastError = err;
    }
  }
  if (delivered || !lastError) return { ok: true, already_exited: !delivered };
  return { ok: false, reason: lastError?.code ?? lastError.message };
}

async function waitUntilExited(pid, graceMs) {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) return true;
    await new Promise((resolveP) => setTimeout(resolveP, 25));
  }
  return !(await isProcessAlive(pid));
}

async function writeEnvelopeIfValid({ paths, stdout, outputFormat }) {
  if (outputFormat !== 'json') return { envelope: null, status: null, errorKind: null };
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    return { envelope: null, status: 'failed', errorKind: 'envelope_parse_error', error: err };
  }

  const shape = validateEnvelopeShape(envelope);
  await writeFile(paths.envelope, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  if (!shape.ok) {
    return { envelope, status: 'failed', errorKind: 'envelope_shape_invalid', error: new Error(shape.reason) };
  }
  return {
    envelope,
    status: envelope.status === 'success' ? 'completed' : 'failed',
    errorKind: envelope.error?.kind ?? null,
  };
}

export async function runPeer(args) {
  const options = {
    repoRoot: process.cwd(),
    kind: 'manual',
    outputFormat: 'json',
    cwd: process.cwd(),
    env: process.env,
    retainPrompt: false,
    ...args,
  };
  validateRunArgs(options);

  const runId = options.runId ?? generateRunId(options.kind);
  assertSafeRunId(runId);
  const paths = await resolvePeerRunPathsForWrite(options.repoRoot, runId);

  if (await exists(paths.dir)) {
    throw new Error(`peer-run ledger already exists for run_id: ${runId}`);
  }
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await touchPrivateFile(paths.stdout);
  await touchPrivateFile(paths.stderr);

  const handle = makeHandle({
    runId,
    kind: options.kind,
    workflowPath: options.workflowPath ? resolve(options.workflowPath) : null,
    phase: options.phase ?? null,
    ensembleType: options.ensembleType ?? null,
    host: options.host ?? null,
    peer: options.peer,
    model: options.model,
    effort: options.effort,
    cwd: options.cwd,
    outputFormat: options.outputFormat,
    promptRetained: options.retainPrompt,
  });
  await writeHandle(paths.handle, handle);

  let promptCleanup = null;
  try {
    const prompt = await materializePrompt({
      paths,
      promptText: options.promptText,
      promptFile: options.promptFile,
      retainPrompt: options.retainPrompt,
    });
    promptCleanup = prompt.cleanup;

    await recordPendingIfEnsemble(await readHandle(paths.handle));

    const companionPath = await resolveCompanionPath(options.peer, { env: options.env });
    if (!companionPath) {
      // Terminal transition BEFORE the final block (ADR-0040 §5: a
      // final-block-only sensor would miss every peer_cli_not_found run).
      const failed = await updateHandle(paths.handle, (h) => {
        h.status = 'failed';
        h.completed_at = nowIso();
        h.exit_code = 3;
        h.error_kind = 'peer_cli_not_found';
      });
      await emitPeerRunTerminal({
        repoRoot: options.repoRoot,
        runId,
        status: failed.status,
        errorKind: failed.error_kind,
        workflowPath: failed.workflow_path,
        handlePath: paths.handle,
        env: options.env,
      });
      return runResult(paths, failed, { ok: false, companionPath: null });
    }

    await updateHandle(paths.handle, (h) => {
      h.status = 'spawning';
    });

    const childArgs = ['task', '--prompt-file', prompt.promptFile, '--output-format', options.outputFormat];
    if (options.model) childArgs.push('--model', options.model);
    if (options.effort) childArgs.push('--effort', options.effort);
    if (options.cwd) childArgs.push('--cwd', resolve(options.cwd));

    const detached = process.platform !== 'win32';
    const child = spawn('node', [companionPath, ...childArgs], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    });

    const fingerprint = await fingerprintForPid(child.pid);
    await updateHandle(paths.handle, (h) => {
      h.status = 'running';
      h.pid = child.pid;
      h.pgid = detached ? child.pid : null;
      h.process_fingerprint = fingerprint;
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutStream = createWriteStream(paths.stdout, { flags: 'a', mode: 0o600 });
    const stderrStream = createWriteStream(paths.stderr, { flags: 'a', mode: 0o600 });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let handleUpdateChain = Promise.resolve();

    const queueOutputNote = (streamName, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (streamName === 'stdout') stdoutBytes += bytes;
      else stderrBytes += bytes;
      handleUpdateChain = handleUpdateChain.then(() => updateHandle(paths.handle, (h) => {
        h.stdout_bytes = stdoutBytes;
        h.stderr_bytes = stderrBytes;
        h.last_output_at = nowIso();
      }));
      return handleUpdateChain;
    };

    const queueHandleUpdate = (mutator) => {
      handleUpdateChain = handleUpdateChain.then(() => updateHandle(paths.handle, mutator));
      return handleUpdateChain;
    };

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      stdoutStream.write(chunk);
      void queueOutputNote('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      stderrStream.write(chunk);
      void queueOutputNote('stderr', chunk);
    });

    child.once('error', (err) => {
      void queueHandleUpdate((h) => {
        h.status = 'failed';
        h.error_kind = err.code ?? 'spawn_error';
      });
    });

    const { code, signal } = await new Promise((resolveP, rejectP) => {
      child.once('error', rejectP);
      child.once('close', (exitCode, exitSignal) => resolveP({ code: exitCode, signal: exitSignal }));
    });
    await Promise.all([
      new Promise((resolveP) => stdoutStream.end(resolveP)),
      new Promise((resolveP) => stderrStream.end(resolveP)),
    ]);
    await handleUpdateChain;

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const envelopeResult = await writeEnvelopeIfValid({
      paths,
      stdout,
      outputFormat: options.outputFormat,
    });

    const latest = await readHandle(paths.handle);
    const cancelled = latest.status === 'cancel_requested' || latest.status === 'cancelled' || signal === 'SIGTERM' || signal === 'SIGKILL';
    const final = await updateHandle(paths.handle, (h) => {
      h.pid = null;
      h.pgid = null;
      h.process_fingerprint = { kind: 'none' };
      h.completed_at = nowIso();
      h.exit_code = Number.isInteger(code) ? code : null;
      if (cancelled) {
        h.status = 'cancelled';
        h.error_kind = 'cancelled';
      } else if (envelopeResult.status) {
        h.status = envelopeResult.status;
        h.error_kind = envelopeResult.errorKind;
        if (envelopeResult.errorKind && code === 0) h.exit_code = 3;
      } else if (code === 0) {
        h.status = 'completed';
        h.error_kind = null;
      } else {
        h.status = 'failed';
        h.error_kind = signal ? `signal_${signal}` : 'peer_run_error';
      }
    });

    // ADR-0040 §5: live terminal transition (completed / failed / cancelled).
    await emitPeerRunTerminal({
      repoRoot: options.repoRoot,
      runId,
      status: final.status,
      errorKind: final.error_kind,
      workflowPath: final.workflow_path,
      handlePath: paths.handle,
      env: options.env,
    });

    return runResult(paths, final, {
      ok: final.status === 'completed',
      companionPath,
      envelope: envelopeResult.envelope,
    });
  } finally {
    if (promptCleanup) {
      await rm(promptCleanup, { recursive: true, force: true });
    }
  }
}

async function runResult(paths, handle, extra = {}) {
  return {
    ok: extra.ok ?? handle.status === 'completed',
    run_id: handle.run_id,
    status: handle.status,
    exit_code: handle.exit_code,
    error_kind: handle.error_kind,
    handle_path: paths.handle,
    stdout_path: paths.stdout,
    stderr_path: paths.stderr,
    envelope_path: await exists(paths.envelope) ? paths.envelope : null,
    prompt_path: handle.prompt_retained && await exists(paths.prompt) ? paths.prompt : null,
    companion_path: extra.companionPath ?? null,
  };
}

export async function statusPeerRun({ repoRoot = process.cwd(), runId, json = true } = {}) {
  assertSafeRunId(runId);
  const paths = await resolvePeerRunPathsForRead(repoRoot, runId);
  const handle = await readHandle(paths.handle);
  const derived = await deriveStatusAnnotation(handle, paths);
  const live = Number.isInteger(handle.pid) ? await isProcessAlive(handle.pid) : false;
  const result = {
    run_id: runId,
    status: handle.status,
    derived_status: derived,
    live,
    handle,
    paths: {
      dir: paths.dir,
      handle: paths.handle,
      stdout: paths.stdout,
      stderr: paths.stderr,
      envelope: await exists(paths.envelope) ? paths.envelope : null,
      prompt: await exists(paths.prompt) ? paths.prompt : null,
    },
  };
  if (!json) {
    return `${runId}: ${derived ?? handle.status}${live ? ' (live)' : ''}`;
  }
  return result;
}

async function deriveStatusAnnotation(handle, paths) {
  if (!(await exists(paths.envelope)) || !handle.workflow_path) return null;
  try {
    const text = await readFile(handle.workflow_path, 'utf8');
    if (/pending_ensemble:/.test(text) && text.includes(`run_id: ${handle.run_id}`)) {
      return 'completed_uncommitted';
    }
  } catch {
    // Missing workflow is not a peer-runner failure.
  }
  return null;
}

export async function cancelPeerRun({
  repoRoot = process.cwd(),
  runId,
  graceMs = DEFAULT_CANCEL_GRACE_MS,
  env = process.env,
} = {}) {
  assertSafeRunId(runId);
  const paths = await resolvePeerRunPathsForRead(repoRoot, runId);
  const handle = await readHandle(paths.handle);

  if (isTerminalStatus(handle.status)) {
    return {
      ok: true,
      run_id: runId,
      status: handle.status,
      reason: 'already_terminal',
    };
  }
  if (handle.status !== 'running' && handle.status !== 'cancel_requested') {
    return {
      ok: false,
      run_id: runId,
      status: handle.status,
      reason: 'not_cancellable',
    };
  }

  const verified = await verifiedProcessForHandle(handle);
  if (!verified.ok) {
    return {
      ok: false,
      run_id: runId,
      status: handle.status,
      reason: verified.reason,
      current_fingerprint: verified.current_fingerprint,
    };
  }

  await updateHandle(paths.handle, (h) => {
    h.status = 'cancel_requested';
    h.error_kind = 'cancelled';
  });

  let latest = await readHandle(paths.handle);
  const term = await sendSignal(latest, 'SIGTERM');
  if (!term.ok) {
    return { ok: false, run_id: runId, status: latest.status, reason: term.reason };
  }

  const exited = await waitUntilExited(latest.pid, graceMs);
  if (!exited) {
    latest = await readHandle(paths.handle);
    const stillVerified = await verifiedProcessForHandle(latest);
    if (stillVerified.ok) {
      await sendSignal(latest, 'SIGKILL');
      await waitUntilExited(latest.pid, 1000);
    } else if (stillVerified.reason !== 'not_running') {
      return {
        ok: false,
        run_id: runId,
        status: latest.status,
        reason: stillVerified.reason,
        current_fingerprint: stillVerified.current_fingerprint,
      };
    }
  }

  const final = await updateHandle(paths.handle, (h) => {
    h.status = 'cancelled';
    h.completed_at ??= nowIso();
    h.exit_code ??= null;
    h.error_kind = 'cancelled';
    h.pid = null;
    h.pgid = null;
    h.process_fingerprint = { kind: 'none' };
  });

  // ADR-0040 §5: cancel's explicit cancelled finalize is a terminal
  // transition this runner writes. The §1 dedupe key (same run_id + status)
  // collapses it with runPeer's own cancelled final block when both observe
  // the same run.
  await emitPeerRunTerminal({
    repoRoot,
    runId,
    status: final.status,
    errorKind: final.error_kind,
    workflowPath: final.workflow_path,
    handlePath: paths.handle,
    env,
  });

  return {
    ok: true,
    run_id: runId,
    status: final.status,
  };
}

export async function sweepPeerRuns({
  repoRoot = process.cwd(),
  applyRetention = false,
  staleGraceMs = DEFAULT_STALE_GRACE_MS,
  retentionTtlDays = DEFAULT_RETENTION_TTL_DAYS,
  retentionCap = DEFAULT_RETENTION_CAP,
  now = new Date(),
  env = process.env,
} = {}) {
  const root = await resolvePeerRunsDirForSweep(repoRoot);
  const report = {
    root,
    scanned: 0,
    reconciled: [],
    pruned: [],
    missing: false,
  };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    report.missing = true;
    return report;
  }

  const terminal = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    let paths;
    try {
      paths = peerRunPaths(repoRoot, runId);
    } catch {
      continue;
    }
    if (!(await exists(paths.handle))) continue;
    report.scanned += 1;
    const before = await readHandle(paths.handle);
    const after = await reconcileOne(paths, before, { staleGraceMs, now, repoRoot, env });
    if (after.status !== before.status) {
      report.reconciled.push({ run_id: runId, from: before.status, to: after.status });
    }
    if (isTerminalStatus(after.status)) {
      terminal.push({ run_id: runId, paths, handle: after });
    }
  }

  if (applyRetention) {
    const cutoff = now.getTime() - retentionTtlDays * 24 * 60 * 60 * 1000;
    const byUpdatedDesc = [...terminal].sort((a, b) =>
      Date.parse(b.handle.updated_at) - Date.parse(a.handle.updated_at)
    );
    const keep = new Set(byUpdatedDesc.slice(0, retentionCap).map((r) => r.run_id));
    for (const item of terminal) {
      const updatedMs = Date.parse(item.handle.updated_at);
      const expired = Number.isFinite(updatedMs) && updatedMs < cutoff;
      const overCap = !keep.has(item.run_id);
      if (expired || overCap) {
        // ADR-0040 §5: pruned transitions are SKIPPED as emit points —
        // retention cleanup of runs whose terminal state was already
        // notified; the payload is being deleted.
        await rm(item.paths.dir, { recursive: true, force: true });
        report.pruned.push({
          run_id: item.run_id,
          reason: expired ? 'ttl' : 'cap',
        });
      }
    }
  }

  return report;
}

async function reconcileOne(paths, handle, { staleGraceMs, now, repoRoot, env }) {
  if (isTerminalStatus(handle.status)) return handle;

  // ADR-0040 §5: every reconciliation below writes a terminal transition, so
  // each branch emits the peer-run-terminal event for the status it lands on
  // (the §1 dedupe key collapses re-observations of an already-notified run).
  if (await exists(paths.envelope)) {
    try {
      const envelope = JSON.parse(await readFile(paths.envelope, 'utf8'));
      const shape = validateEnvelopeShape(envelope);
      const next = await updateHandle(paths.handle, (h) => {
        h.status = shape.ok && envelope.status === 'success' ? 'completed' : 'failed';
        h.completed_at ??= now.toISOString();
        h.exit_code = Number.isInteger(envelope.exit_code) ? envelope.exit_code : h.exit_code;
        h.error_kind = envelope.error?.kind ?? (shape.ok ? null : 'envelope_shape_invalid');
      });
      await emitPeerRunTerminal({
        repoRoot,
        runId: next.run_id,
        status: next.status,
        errorKind: next.error_kind,
        workflowPath: next.workflow_path,
        handlePath: paths.handle,
        env,
      });
      return next;
    } catch {
      const next = await updateHandle(paths.handle, (h) => {
        h.status = 'failed';
        h.completed_at ??= now.toISOString();
        h.error_kind = 'envelope_parse_error';
      });
      await emitPeerRunTerminal({
        repoRoot,
        runId: next.run_id,
        status: next.status,
        errorKind: next.error_kind,
        workflowPath: next.workflow_path,
        handlePath: paths.handle,
        env,
      });
      return next;
    }
  }

  if (['spawning', 'running', 'cancel_requested'].includes(handle.status)) {
    const live = await originalProcessAliveForHandle(handle);
    const refMs = Date.parse(handle.updated_at ?? handle.started_at);
    const stale = Number.isFinite(refMs) && now.getTime() - refMs > staleGraceMs;
    if (!live && stale) {
      const next = await updateHandle(paths.handle, (h) => {
        h.status = 'orphaned';
        h.completed_at ??= now.toISOString();
        h.pid = null;
        h.pgid = null;
        h.process_fingerprint = { kind: 'none' };
        h.error_kind = 'orphaned';
      });
      await emitPeerRunTerminal({
        repoRoot,
        runId: next.run_id,
        status: next.status,
        errorKind: next.error_kind,
        workflowPath: next.workflow_path,
        handlePath: paths.handle,
        env,
      });
      return next;
    }
  }

  return handle;
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(dir) {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return false;
  }
}

function parseCliArgs(argv) {
  const [subcommand, ...rest] = argv;
  const opts = {
    subcommand,
    outputFormat: 'json',
    kind: 'manual',
    repoRoot: process.cwd(),
    cwd: process.cwd(),
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--repo-root':
        opts.repoRoot = rest[++i];
        break;
      case '--run-id':
        opts.runId = rest[++i];
        break;
      case '--kind':
        opts.kind = rest[++i];
        break;
      case '--workflow-path':
        opts.workflowPath = rest[++i];
        break;
      case '--phase':
        opts.phase = rest[++i];
        break;
      case '--ensemble-type':
        opts.ensembleType = rest[++i];
        break;
      case '--host':
        opts.host = rest[++i];
        break;
      case '--peer':
        opts.peer = rest[++i];
        break;
      case '--prompt-file':
        opts.promptFile = rest[++i];
        break;
      case '--prompt-text':
        opts.promptText = rest[++i];
        break;
      case '--model':
        opts.model = rest[++i];
        break;
      case '--effort':
        opts.effort = rest[++i];
        break;
      case '--cwd':
        opts.cwd = rest[++i];
        break;
      case '--output-format':
        opts.outputFormat = rest[++i];
        break;
      case '--retain-prompt':
        opts.retainPrompt = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--cancel-grace-ms':
        opts.cancelGraceMs = Number.parseInt(rest[++i], 10);
        break;
      case '--stale-grace-ms':
        opts.staleGraceMs = Number.parseInt(rest[++i], 10);
        break;
      case '--retention-ttl-days':
        opts.retentionTtlDays = Number.parseFloat(rest[++i]);
        break;
      case '--retention-cap':
        opts.retentionCap = Number.parseInt(rest[++i], 10);
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'Usage: peer-runner.mjs <run|status|cancel|sweep> [flags]',
    '',
    'Subcommands:',
    '  run --peer claude|codex (--prompt-file <path>|--prompt-text <text>)',
    '      [--repo-root <path>] [--run-id <id>] [--kind ensemble|peer-now|manual]',
    '      [--workflow-path <path> --phase <p> --ensemble-type <t>]',
    '      [--host claude|codex] [--model <id>] [--effort <level>]',
    '      [--cwd <dir>] [--output-format text|json] [--retain-prompt]',
    '',
    '  status --run-id <id> [--repo-root <path>] [--json]',
    '  cancel --run-id <id> [--repo-root <path>] [--cancel-grace-ms <ms>]',
    '  sweep [--repo-root <path>] [--apply] [--stale-grace-ms <ms>]',
    '        [--retention-ttl-days <days>] [--retention-cap <n>]',
    '',
  ].join('\n'));
}

async function cliMain(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`peer-runner: ${err.message}\n`);
    return 2;
  }

  if (!opts.subcommand || opts.help) {
    printHelp();
    return 0;
  }

  try {
    if (opts.subcommand === 'run') {
      const result = await runPeer({
        repoRoot: opts.repoRoot,
        runId: opts.runId,
        kind: opts.kind,
        workflowPath: opts.workflowPath,
        phase: opts.phase,
        ensembleType: opts.ensembleType,
        host: opts.host,
        peer: opts.peer,
        promptFile: opts.promptFile,
        promptText: opts.promptText,
        model: opts.model,
        effort: opts.effort,
        cwd: opts.cwd,
        outputFormat: opts.outputFormat,
        retainPrompt: opts.retainPrompt,
        env: process.env,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : (result.exit_code ?? 1);
    }

    if (opts.subcommand === 'status') {
      if (!opts.runId) throw new Error('--run-id is required');
      const result = await statusPeerRun({
        repoRoot: opts.repoRoot,
        runId: opts.runId,
        json: opts.json ?? true,
      });
      process.stdout.write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result)}\n`);
      return 0;
    }

    if (opts.subcommand === 'cancel') {
      if (!opts.runId) throw new Error('--run-id is required');
      const result = await cancelPeerRun({
        repoRoot: opts.repoRoot,
        runId: opts.runId,
        graceMs: Number.isInteger(opts.cancelGraceMs)
          ? opts.cancelGraceMs
          : parsePositiveInt(process.env.PEER_RUN_CANCEL_GRACE_MS, DEFAULT_CANCEL_GRACE_MS),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 1;
    }

    if (opts.subcommand === 'sweep') {
      const result = await sweepPeerRuns({
        repoRoot: opts.repoRoot,
        applyRetention: Boolean(opts.apply),
        staleGraceMs: Number.isInteger(opts.staleGraceMs)
          ? opts.staleGraceMs
          : parsePositiveInt(process.env.PEER_RUN_STALE_GRACE_MS, DEFAULT_STALE_GRACE_MS),
        retentionTtlDays: Number.isFinite(opts.retentionTtlDays)
          ? opts.retentionTtlDays
          : parseRetentionTtlDays(process.env.PEER_RUN_RETENTION_TTL_DAYS, DEFAULT_RETENTION_TTL_DAYS),
        retentionCap: Number.isInteger(opts.retentionCap)
          ? opts.retentionCap
          : parsePositiveInt(process.env.PEER_RUN_RETENTION_CAP, DEFAULT_RETENTION_CAP),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }

    process.stderr.write(`peer-runner: unknown subcommand: ${opts.subcommand}\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`peer-runner ${opts.subcommand}: ${err.message}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await cliMain(process.argv.slice(2));
  process.exit(code);
}
