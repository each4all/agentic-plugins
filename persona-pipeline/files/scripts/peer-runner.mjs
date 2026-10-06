#!/usr/bin/env node
// scripts/peer-runner.mjs
//
// ADR-0023 PR-B: caller-side peer-runner supervisor primitive for a persona
// plugin, one copy for every persona that enrolls it (generated from
// persona-pipeline/, ADR-0066; it carries the legacy_homes OFF path, so the
// manifest never enrolls it into a persona with legacy homes). The persona's
// name — the peer-run home and the handle's `plugin` — is read from its
// persona.json when the code runs. This script owns operational lifecycle state around
// companion dispatch (ledger, status, cancel, sweep, retention) while
// leaving companions/contract.md v0.1.1 unchanged.
//
// PR-B intentionally does not replace verb command runbooks yet. Existing
// commands may continue to call dispatch-peer.mjs until PR-C migrates
// selected dispatch paths to this managed runner.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
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

import { resolveCompanion, validateEnvelopeShape } from './dispatch-peer.mjs';
import {
  ENSEMBLE_RESULTS_RETENTION_CAP,
  commitEnsemble,
  parseWorkflowFile,
  recordPendingEnsemble,
} from './state.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { personaName, personaOrRefuse, stateDirRel } from './lib/persona.mjs';


// ADR-0061 §Decision 4: record where the companion came from — which host
// cache, and whether a Codex-installed caller fell back to the Claude cache —
// in the ledger, so a diagnostic can report it rather than infer it.
function companionRecord(resolved) {
  return {
    path: resolved.path,
    source: resolved.source,
    host: resolved.host,
    caller_host: resolved.callerHost,
    cross_host_fallback: resolved.crossHostFallback,
    ...(resolved.reason ? { reason: resolved.reason } : {}),
  };
}

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

// legacy_homes off — canonical peer-run home only (no legacy dual-home, no
// ambiguity resolution, no migration surface).
function peerRunsDirRels() {
  return { canonical: `${stateDirRel()}/peer-runs` };
}

export function peerRunsDir(repoRoot, { home = 'canonical' } = {}) {
  const rels = peerRunsDirRels();
  const rel = Object.hasOwn(rels, home) ? rels[home] : undefined;
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

// legacy_homes off — all three resolvers collapse to the canonical home
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
  if (handle.plugin !== personaName()) {
    return { ok: false, reason: `plugin must be ${personaName()}: ${handle.plugin}` };
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
    plugin: personaName(),
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

  const dir = await mkdtemp(join(tmpdir(), `${personaName()}-peer-runner-prompt-`));
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

    const companion = await resolveCompanion(options.peer, { env: options.env });
    const companionPath = companion.path;
    if (!companionPath) {
      const failed = await updateHandle(paths.handle, (h) => {
        h.status = 'failed';
        h.completed_at = nowIso();
        h.exit_code = 3;
        h.error_kind = 'peer_cli_not_found';
        h.companion = companionRecord(companion);
      });
      return runResult(paths, failed, { ok: false, companionPath: null });
    }

    await updateHandle(paths.handle, (h) => {
      h.status = 'spawning';
      h.companion = companionRecord(companion);
    });

    const childArgs = ['task', '--prompt-file', prompt.promptFile, '--output-format', options.outputFormat];
    if (options.model) childArgs.push('--model', options.model);
    if (options.effort) childArgs.push('--effort', options.effort);
    if (options.cwd) childArgs.push('--cwd', resolve(options.cwd));

    const detached = process.platform !== 'win32';

    // Every lifecycle observer below is registered in the SAME synchronous
    // block as spawn(). An await between spawn() and these registrations
    // opens a window in which a fast-exiting companion emits 'spawn',
    // 'exit', 'close' — and its only output chunks — into zero listeners.
    // Those events are not replayed: the close wait would then never settle,
    // the event loop would drain, and node:test's keep-alive would hold the
    // process forever (the 2026-07-11 CI 30-minute-hang root cause).
    let child;
    try {
      child = spawn('node', [companionPath, ...childArgs], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
      });
    } catch (err) {
      // A synchronous spawn throw (invalid options) must still leave a
      // terminal ledger rather than a workflow stuck at `spawning`.
      await updateHandle(paths.handle, (h) => {
        h.status = 'failed';
        h.completed_at = nowIso();
        h.exit_code = null;
        h.error_kind = err.code ?? 'spawn_error';
      });
      throw err;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutStream = createWriteStream(paths.stdout, { flags: 'a', mode: 0o600 });
    const stderrStream = createWriteStream(paths.stderr, { flags: 'a', mode: 0o600 });
    // Error-aware stream completion: 'close' fires after 'finish' AND after
    // an error-triggered autoDestroy, so a ledger-write failure cannot
    // re-orphan the join below the way a lost end() callback would. The
    // first error is CAPTURED, not discarded — a run whose ledger log was
    // never persisted must finalize as failed, not report completed with
    // nonzero byte counters pointing at a missing file. The listener stays
    // attached so a repeated write-after-destroy error cannot crash the
    // process once the first one is recorded.
    let streamError = null;
    const streamDone = (stream) => {
      stream.on('error', (err) => {
        streamError ??= err;
      });
      return new Promise((resolveP) => {
        stream.once('close', resolveP);
      });
    };
    const stdoutStreamDone = streamDone(stdoutStream);
    const stderrStreamDone = streamDone(stderrStream);

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let handleUpdateChain = Promise.resolve();

    const queueHandleUpdate = (mutator) => {
      handleUpdateChain = handleUpdateChain.then(() => updateHandle(paths.handle, mutator));
      // Keep the rejection for the post-close `await handleUpdateChain`
      // while preventing an unhandled-rejection crash in the gap between
      // this enqueue and that await.
      handleUpdateChain.catch(() => {});
      return handleUpdateChain;
    };

    const queueOutputNote = (streamName, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (streamName === 'stdout') stdoutBytes += bytes;
      else stderrBytes += bytes;
      return queueHandleUpdate((h) => {
        h.stdout_bytes = stdoutBytes;
        h.stderr_bytes = stderrBytes;
        h.last_output_at = nowIso();
      });
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

    // 'error' is collected, not rejected: a failed spawn emits 'error' and
    // then 'close' (never 'spawn'), so the close barrier still settles and
    // the terminal finalize below runs on that path too.
    let childError = null;
    child.once('error', (err) => {
      childError = err;
      void queueHandleUpdate((h) => {
        h.status = 'failed';
        h.error_kind = err.code ?? 'spawn_error';
      });
    });

    // The running transition is driven by 'spawn' (success only, emitted
    // before any child output reaches 'data'): a failed spawn never records
    // `running` and never serializes an undefined pid into the handle.
    child.once('spawn', () => {
      void queueHandleUpdate(async (h) => {
        h.status = 'running';
        h.pid = child.pid;
        h.pgid = detached ? child.pid : null;
        h.process_fingerprint = await fingerprintForPid(child.pid);
      });
    });

    // Non-rejecting close barrier — the single lifecycle join point for the
    // success, kill, and spawn-failure paths alike.
    const { code, signal } = await new Promise((resolveP) => {
      child.once('close', (exitCode, exitSignal) => resolveP({ code: exitCode, signal: exitSignal }));
    });
    stdoutStream.end();
    stderrStream.end();
    await Promise.all([stdoutStreamDone, stderrStreamDone]);
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
      } else if (childError) {
        h.status = 'failed';
        h.error_kind = childError.code ?? 'spawn_error';
        // The child never ran: 'close' reports a negative errno in the exit
        // code slot on spawn failure, which is not a process exit code.
        h.exit_code = null;
      } else if (streamError) {
        // The companion may have succeeded, but its ledger log was not
        // persisted — reporting completed here would leave byte counters
        // pointing at a missing/truncated file.
        h.status = 'failed';
        h.error_kind = streamError.code ?? 'ledger_write_error';
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
} = {}) {
  const root = await resolvePeerRunsDirForSweep(repoRoot);
  const report = {
    root,
    scanned: 0,
    reconciled: [],
    // The retention PLAN, computed on every sweep. `pruned` used to be the only
    // retention field and it is written solely under `--apply`, so a preview
    // reported `pruned: []` and read as "nothing would be deleted" while the
    // very next `--apply` deleted runs. A preview that understates a
    // destructive action is worse than no preview.
    planned_prunes: [],
    // What this invocation actually DELETED. Empty on a preview because nothing
    // was deleted, not because nothing was eligible.
    pruned: [],
    // Whether the retention half ran at all. The two lists above are only
    // interpretable against it, and `sweep` is NOT a dry run in any case:
    // reconciliation runs unconditionally and rewrites handles.
    retention_applied: false,
    // Terminal runs whose `updated_at` does not parse. They are ranked by
    // nothing and deleted by nothing — a destructive default must not act on
    // data it cannot evaluate — but they are NAMED, because silently carrying
    // unmanaged runs is how a cap stops meaning anything.
    undateable: [],
    // Runs the plan named but the re-verification refused to delete, because
    // the directory no longer holds the run the plan was made about. Reported
    // rather than dropped: a plan whose deletions silently do not happen is the
    // same dishonesty as a preview whose deletions silently do.
    prune_skipped: [],
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
    const after = await reconcileOne(paths, before, { staleGraceMs, now });
    if (after.status !== before.status) {
      report.reconciled.push({ run_id: runId, from: before.status, to: after.status });
    }
    if (isTerminalStatus(after.status)) {
      terminal.push({ run_id: runId, paths, handle: after });
    }
  }

  // The plan is computed UNCONDITIONALLY; only the deletion below is gated.
  // Splitting it this way is the whole fix: preview and apply now evaluate the
  // same predicate over the same set, so they cannot disagree about what is
  // eligible.
  const cutoff = now.getTime() - retentionTtlDays * 24 * 60 * 60 * 1000;
  const dateable = [];
  for (const item of terminal) {
    const updatedMs = Date.parse(item.handle.updated_at);
    if (Number.isFinite(updatedMs)) dateable.push({ item, updatedMs });
    else report.undateable.push({ run_id: item.run_id, updated_at: item.handle.updated_at ?? null });
  }
  // Deterministic ordering. Sorting on `updated_at` alone leaves ties to the
  // engine's sort stability over readdir order, so two runs sharing a timestamp
  // could land on opposite sides of the cap between a preview and its apply —
  // exactly the drift this row is about. `run_id` breaks the tie and is unique
  // by construction.
  const byUpdatedDesc = [...dateable].sort((a, b) =>
    (b.updatedMs - a.updatedMs) || (a.item.run_id < b.item.run_id ? -1 : a.item.run_id > b.item.run_id ? 1 : 0)
  );
  const keep = new Set(byUpdatedDesc.slice(0, retentionCap).map((r) => r.item.run_id));
  for (const { item, updatedMs } of dateable) {
    const expired = updatedMs < cutoff;
    const overCap = !keep.has(item.run_id);
    if (expired || overCap) {
      report.planned_prunes.push({ run_id: item.run_id, reason: expired ? 'ttl' : 'cap' });
    }
  }

  report.retention_applied = applyRetention;
  if (applyRetention) {
    const plannedByRunId = new Map(terminal.map((item) => [item.run_id, item.paths]));
    for (const planned of report.planned_prunes) {
      const paths = plannedByRunId.get(planned.run_id);
      // RE-VERIFY IMMEDIATELY BEFORE DELETING. Computing the whole plan first
      // is what makes the preview honest, and it also widens the window between
      // deciding to delete a run and deleting it. A run id is reusable once its
      // directory is gone (`runPeer` only checks current existence), so without
      // this re-read a directory recreated as a NEW RUNNING run in that window
      // is deleted under the old run's TTL verdict — reproduced by the
      // Refine-verify peer, and the one failure here that destroys live data.
      //
      // The re-read is the claim: delete only if the handle still says what the
      // plan was made about. Anything else — unreadable, non-terminal, a
      // different run id, a timestamp that moved — means this is no longer the
      // run that was planned, and it is skipped rather than guessed at.
      let current = null;
      try {
        current = await readHandle(paths.handle);
      } catch {
        report.prune_skipped.push({ run_id: planned.run_id, reason: 'handle-unreadable' });
        continue;
      }
      if (current.run_id !== planned.run_id || !isTerminalStatus(current.status)) {
        report.prune_skipped.push({ run_id: planned.run_id, reason: 'no-longer-terminal' });
        continue;
      }
      await rm(paths.dir, { recursive: true, force: true });
      report.pruned.push(planned);
    }
  }

  return report;
}

// A non-terminal handle whose run is over: the envelope decides when there is
// one; otherwise a run whose process is gone and whose handle has not moved
// for `staleGraceMs` is orphaned. `queued` is judged by staleness alone (PC2b
// RV1): no process is recorded before the spawn, and the PID recorded after it
// is the companion's, never the runner's.
export async function reconcileOne(paths, handle, { staleGraceMs, now }) {
  if (isTerminalStatus(handle.status)) return handle;

  // Each write keeps a terminal status already on disk: the caller's handle
  // may predate one the runner or a cancel wrote (PC2b re-review).
  if (await exists(paths.envelope)) {
    try {
      const envelope = JSON.parse(await readFile(paths.envelope, 'utf8'));
      const shape = validateEnvelopeShape(envelope);
      const next = await updateHandle(paths.handle, (h) => {
        if (isTerminalStatus(h.status)) return h;
        h.status = shape.ok && envelope.status === 'success' ? 'completed' : 'failed';
        h.completed_at ??= now.toISOString();
        h.exit_code = Number.isInteger(envelope.exit_code) ? envelope.exit_code : h.exit_code;
        h.error_kind = envelope.error?.kind ?? (shape.ok ? null : 'envelope_shape_invalid');
      });
      return next;
    } catch {
      const next = await updateHandle(paths.handle, (h) => {
        if (isTerminalStatus(h.status)) return h;
        h.status = 'failed';
        h.completed_at ??= now.toISOString();
        h.error_kind = 'envelope_parse_error';
      });
      return next;
    }
  }

  if (['queued', 'spawning', 'running', 'cancel_requested'].includes(handle.status)) {
    const live = await originalProcessAliveForHandle(handle);
    const refMs = Date.parse(handle.updated_at ?? handle.started_at);
    const stale = Number.isFinite(refMs) && now.getTime() - refMs > staleGraceMs;
    if (!live && stale) {
      // The runner may have finished between the reads above and this write:
      // an envelope that appeared is reconciled as such, and the handle is
      // re-read so a terminal status the runner wrote is never replaced
      // (PC2b Review of code step 6).
      if (await exists(paths.envelope)) return reconcileOne(paths, await readHandle(paths.handle), { staleGraceMs, now });
      const next = await updateHandle(paths.handle, (h) => {
        if (!['queued', 'spawning', 'running', 'cancel_requested'].includes(h.status)) return h;
        h.status = 'orphaned';
        h.completed_at ??= now.toISOString();
        h.pid = null;
        h.pgid = null;
        h.process_fingerprint = { kind: 'none' };
        h.error_kind = 'orphaned';
      });
      return next;
    }
  }

  return handle;
}

// -----------------------------------------------------------------------------
// Ensemble settlement (ADR-0066 PC2b DD6, RV1, RV2): the one call a verb makes
// after its ensemble step, deciding from the run ledger what the workflow
// records. It replaces the D2 guard, which decided from shell variables carried
// between blocks and left a pending row behind when one was lost.
//
//   no run id, nothing attempted       → skipped: nothing is written
//   no run id, an attempt unsettled    → refused: settle names its run id
//   a run id already settled           → no-op, reported (repeat or race)
//   a run id with no ledger            → its pending row is settled failed
//                                        (error_kind=ledger_missing); with no
//                                        pending row either, refused
//   a ledger that is not this attempt  → refused: kind, workflow, phase and
//                                        ensemble type must all match
//   non-terminal                       → reconciled first (reconcileOne);
//                                        still live or too fresh → refused:
//                                        collect it first
//   failed / cancelled / orphaned      → verdict `failed`, the summary naming
//                                        the status and error_kind; the
//                                        agent's --verdict is not used
//   completed, answer empty/unreadable → verdict `degraded`: the synthesis is
//                                        local-only, no peer verdict invented
//   completed, answer usable           → the synthesis --verdict (required,
//                                        never `failed`) and --summary
//
// Every write goes through commitEnsemble, which pops the pending row and
// appends the result idempotently under the workflow file's lock, so a
// repeated or concurrent settle records one result.

export const SETTLE_FAILED_VERDICT = 'failed';
export const SETTLE_DEGRADED_VERDICT = 'degraded';

export class SettleRefusal extends Error {}

const refuse = (message) => { throw new SettleRefusal(message); };

// The answer a completed run returned: the envelope's stdout (json) or the
// stdout log (text). `null` when it cannot be read, '' when it is empty.
async function completedAnswer(paths, handle) {
  try {
    if (handle.output_format === 'json') {
      const envelope = JSON.parse(await readFile(paths.envelope, 'utf8'));
      return typeof envelope?.stdout === 'string' ? envelope.stdout : null;
    }
    return await readFile(paths.stdout, 'utf8');
  } catch {
    return null;
  }
}

// Ledger handles naming this workflow and phase as an ensemble attempt with no
// result recorded. A handle that cannot be read at all counts: it could be
// one, and an empty run id is accepted only when there is none. When the
// results list is full, a run that ended before its oldest entry may have been
// settled and pruned since, so it does not count.
async function unsettledAttempts({ repoRoot, workflowPath, phase, results }) {
  const root = await resolvePeerRunsDirForSweep(repoRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const settled = new Set(results.map((r) => r.run_id));
  const oldestKept = results.length >= ENSEMBLE_RESULTS_RETENTION_CAP
    ? results.map((r) => r.completed_at).filter((t) => typeof t === 'string').sort()[0] ?? null
    : null;
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let paths;
    try {
      paths = peerRunPaths(repoRoot, entry.name);
    } catch {
      continue;
    }
    if (!(await exists(paths.handle))) continue;
    let handle;
    try {
      handle = JSON.parse(await readFile(paths.handle, 'utf8'));
    } catch {
      out.push(`${entry.name} (unreadable handle)`);
      continue;
    }
    if (handle?.kind !== 'ensemble' || handle.phase !== phase) continue;
    if (typeof handle.workflow_path !== 'string' || resolve(handle.workflow_path) !== workflowPath) continue;
    if (settled.has(handle.run_id)) continue;
    // Ended before a full results list's oldest entry: settled and pruned. A
    // settlement comes after the run ended and the list drops its oldest entries
    // first, so a run that ended later, or never ended (settle commits only a
    // terminal run), cannot have been pruned and still blocks (PC2b Review of
    // code step 6 and its re-review).
    if (oldestKept !== null && isTerminalStatus(handle.status) && Date.parse(handle.completed_at) < Date.parse(oldestKept)) continue;
    out.push(handle.run_id);
  }
  return out;
}

/**
 * Settle one ensemble attempt of a workflow phase (see the table above).
 * Throws SettleRefusal when the ledger does not let it decide; returns
 * `{ settlement: 'skipped' | 'committed' | 'already-settled', … }` otherwise.
 */
export async function settleEnsemble({
  repoRoot = process.cwd(),
  workflowPath,
  phase,
  runId,
  verdict,
  summary,
  staleGraceMs = DEFAULT_STALE_GRACE_MS,
  now = new Date(),
} = {}) {
  for (const [flag, value] of [['--workflow-path', workflowPath], ['--phase', phase]]) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`settle: ${flag} is required`);
  }
  if (typeof runId !== 'string') throw new Error("settle: --run-id is required (pass '' when no run launched)");
  const wf = resolve(workflowPath);
  const { frontmatter } = parseWorkflowFile(await readFile(wf, 'utf8'));
  const pending = (frontmatter.pending_ensemble ?? []).filter((e) => e.phase === phase);
  const results = frontmatter.ensemble_results ?? [];

  if (runId === '') {
    if (pending.length > 0) {
      refuse(`a run launched for phase ${phase}: settle it by its run id (${pending.map((e) => e.run_id).join(', ')})`);
    }
    const open = await unsettledAttempts({ repoRoot, workflowPath: wf, phase, results });
    if (open.length > 0) {
      refuse(`an unsettled ensemble attempt for phase ${phase} is in the ledger: settle it by its run id (${open.join(', ')})`);
    }
    return { ok: true, settlement: 'skipped', run_id: null, phase };
  }

  assertSafeRunId(runId);
  const row = pending.find((e) => e.run_id === runId) ?? null;
  const done = results.find((r) => r.run_id === runId) ?? null;
  // A concurrent settle that won is reported with the verdict the workflow
  // holds, never this call's (PC2b Review of code step 6).
  let keptVerdict = null;
  const commit = async (fields) => {
    const { idempotentSkip, kept } = await commitEnsemble({
      workflowPath: wf,
      run_id: runId,
      phase,
      completed_at: isoSeconds(now),
      ...fields,
    });
    if (!idempotentSkip) return 'committed';
    // Read under the commit's lock: the workflow may be archived right after.
    keptVerdict = kept?.verdict ?? null;
    return 'already-settled';
  };

  // Settled before (a repeat, or a concurrent settle that won): report it, and
  // drop a pending row left beside the result, if any, through the same
  // idempotent commit.
  if (done) {
    if (done.phase !== phase) refuse(`run ${runId} was settled for phase ${done.phase}, not ${phase}`);
    if (row) await commit({ ensemble_type: done.ensemble_type, verdict: done.verdict, summary: done.summary });
    return { ok: true, settlement: 'already-settled', run_id: runId, phase, verdict: done.verdict };
  }

  const paths = await resolvePeerRunPathsForRead(repoRoot, runId);
  if (!(await exists(paths.handle))) {
    if (!row) refuse(`no ledger and no pending entry for run ${runId} in phase ${phase}`);
    const settlement = await commit({
      ensemble_type: row.ensemble_type,
      verdict: SETTLE_FAILED_VERDICT,
      summary: 'peer run ledger missing: error_kind=ledger_missing',
    });
    return { ok: true, settlement, run_id: runId, phase, status: null, error_kind: 'ledger_missing', verdict: keptVerdict ?? SETTLE_FAILED_VERDICT };
  }

  let handle = await readHandle(paths.handle);
  if (handle.kind !== 'ensemble') refuse(`run ${runId} is a ${handle.kind} run, not an ensemble attempt`);
  if (typeof handle.workflow_path !== 'string' || resolve(handle.workflow_path) !== wf) {
    refuse(`run ${runId} belongs to another workflow (${handle.workflow_path})`);
  }
  if (handle.phase !== phase) refuse(`run ${runId} is phase ${handle.phase}, not ${phase}`);
  if (row && row.ensemble_type !== handle.ensemble_type) {
    refuse(`run ${runId}: the pending entry's ensemble type ${row.ensemble_type} is not the ledger's ${handle.ensemble_type}`);
  }

  handle = await reconcileOne(paths, handle, { staleGraceMs, now });
  if (!isTerminalStatus(handle.status)) {
    refuse(`run ${runId} is ${handle.status} and not shown abandoned: collect it first`);
  }
  const base = { ok: true, run_id: runId, phase, status: handle.status, error_kind: handle.error_kind };
  if (handle.status !== 'completed') {
    const settlement = await commit({
      ensemble_type: handle.ensemble_type,
      verdict: SETTLE_FAILED_VERDICT,
      summary: `peer run ${handle.status}: error_kind=${handle.error_kind ?? 'none'}`,
    });
    return { ...base, settlement, verdict: keptVerdict ?? SETTLE_FAILED_VERDICT };
  }
  const answer = await completedAnswer(paths, handle);
  if (answer === null || answer.trim() === '') {
    const why = answer === null ? 'unreadable' : 'empty';
    const local = typeof summary === 'string' && summary.trim() !== '' ? `: ${singleLineSummary(summary)}` : '';
    const settlement = await commit({
      ensemble_type: handle.ensemble_type,
      verdict: SETTLE_DEGRADED_VERDICT,
      summary: `peer answer ${why}; the synthesis is local-only${local}`,
    });
    return { ...base, settlement, verdict: keptVerdict ?? SETTLE_DEGRADED_VERDICT, answer: why };
  }
  if (typeof verdict !== 'string' || verdict.trim() === '') refuse(`run ${runId} completed: settle needs the synthesis --verdict`);
  if (verdict === SETTLE_FAILED_VERDICT) refuse(`run ${runId} completed: '${SETTLE_FAILED_VERDICT}' is reserved for a run that failed`);
  if (typeof summary !== 'string' || summary.trim() === '') refuse(`run ${runId} completed: settle needs the synthesis --summary`);
  const settlement = await commit({ ensemble_type: handle.ensemble_type, verdict, summary: singleLineSummary(summary) });
  return { ...base, settlement, verdict: keptVerdict ?? verdict };
}

function singleLineSummary(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function isoSeconds(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
      case '--verdict':
        opts.verdict = rest[++i];
        break;
      case '--summary':
        opts.summary = rest[++i];
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
    'Usage: peer-runner.mjs <run|status|cancel|sweep|settle> [flags]',
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
    "  settle --workflow-path <path> --phase <p> --run-id <id|''>",
    '         [--verdict <v> --summary <s>] [--repo-root <path>] [--host claude|codex]',
    '         [--stale-grace-ms <ms>]',
    '      Record what an ensemble attempt came to, decided from its ledger:',
    "      --run-id '' when no run launched. Exit 0 settled or skipped, 1 refused.",
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

    if (opts.subcommand === 'settle') {
      if (opts.host !== undefined && !VALID_PEERS.has(opts.host)) throw new Error(`--host must be claude or codex (got ${opts.host})`);
      try {
        const result = await settleEnsemble({
          repoRoot: opts.repoRoot,
          workflowPath: opts.workflowPath,
          phase: opts.phase,
          runId: opts.runId,
          verdict: opts.verdict,
          summary: opts.summary,
          staleGraceMs: Number.isInteger(opts.staleGraceMs)
            ? opts.staleGraceMs
            : parsePositiveInt(process.env.PEER_RUN_STALE_GRACE_MS, DEFAULT_STALE_GRACE_MS),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.stderr.write(`settlement: ${result.settlement}${result.verdict ? ` (${result.verdict})` : ''}\n`);
        return 0;
      } catch (err) {
        if (!(err instanceof SettleRefusal)) throw err;
        process.stdout.write(`${JSON.stringify({ ok: false, settlement: 'refused', reason: err.message })}\n`);
        process.stderr.write(`peer-runner settle: refused: ${err.message}\n`);
        return 1;
      }
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

// Run as a CLI only when this file is the entry point (ADR-0066 D1), and only
// with a valid persona declaration: a run ledger or a pending-ensemble write
// must never land without knowing whose state it is (ADR-0066 Decision 2).
if (isCliEntry(import.meta.url)) {
  if (!personaOrRefuse('peer-runner')) process.exit(1);
  const code = await cliMain(process.argv.slice(2));
  process.exit(code);
}
