#!/usr/bin/env node
// plugins/engineer/scripts/parent-writeback.mjs
//
// ADR-0019 PR-C — engineer-local parent-writeback helper. Engineer's
// runStopArchive calls this after a successful archive when the
// frontmatter has `parent_workflow` + `originating_subtask` set, to
// dispatch a single-subtask update against the orchestrator macro
// workflow. The helper is engineer-local for now (ADR-0010 §6 trigger 1
// requires 2+ consumers before promotion to L1); generic interface so a
// future designer (or other L3) becoming the second consumer can promote
// it with minimal change.
//
// Responsibilities:
//   1. Resolve the orchestrator plugin root (env override → Claude cache
//      multi-version SemVer → Codex cache single fixed → monorepo
//      sibling). Pattern mirrors `dispatch-peer.mjs`'s companion
//      discovery — same env-then-cache-then-repo ladder.
//   2. Resolve the parent workflow file path under canonical
//      `<repoRoot>/.agentic-plugins/state/orchestrator/workflows/<parent>.md`
//      or legacy `<repoRoot>/.claude/agentic-orchestrator/workflows/<parent>.md`.
//      Apply the ADR-0019 §4 step 3 archive-fallback rule when the
//      parent has already been moved to `archive/` (skip + stderr
//      warning, do NOT throw — host stop lifecycle must not be blocked).
//   3. Spawn the orchestrator state.mjs `subtask-update` CLI per
//      PR-C0's public surface. PR-C0 does all the atomic work
//      (primary mutation, unblock pass, auto-terminal pass, ownership
//      checks) under its own parent per-file lock — §6 lock-order is
//      naturally satisfied because the engineer side already released
//      every workflow + directory lock when archiveWorkflow's callbacks
//      exited before this helper is called.
//
// Failure semantics: every error path returns
// `{ok: false, skipped?: true, reason: '...', stderr?: '...'}` and
// writes a one-line diagnostic to the caller-supplied stderr stream.
// We never throw past the caller — a parent-writeback failure must
// not roll back the engineer archive (which already succeeded) and
// must not break the host's Stop lifecycle. Manual reconciliation is
// available through `/orchestrator:done` (ADR-0019 §4 backup path,
// PR-D scope).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

const ENV_OVERRIDE = 'AGENTIC_ORCHESTRATOR_ROOT';

// orchestrator-side path constants — kept literal here rather than
// imported so engineer does NOT take an import dependency on
// orchestrator (ADR-0010 §5 cross-plugin import policy). If
// orchestrator ever changes its `WORKFLOW_DIR_REL` / `ARCHIVE_DIR_REL`
// these literals must be updated in lockstep — there are tests that
// exercise the spawn path end-to-end and will fail loudly on drift.
const ORCH_WORKFLOW_DIR_RELS = [
  '.agentic-plugins/state/orchestrator/workflows',
  '.claude/agentic-orchestrator/workflows',
];
const ORCH_ARCHIVE_DIR_RELS = [
  '.agentic-plugins/state/orchestrator/archive',
  '.claude/agentic-orchestrator/archive',
];

async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function semverCompare(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function cacheBases(home) {
  return {
    claude: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'orchestrator'),
    codex: join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'orchestrator'),
  };
}

/**
 * Resolve the orchestrator plugin root directory containing
 * `scripts/state.mjs`. Tries:
 *   1. `AGENTIC_ORCHESTRATOR_ROOT` env override
 *   2. Claude cache layout (multi-version; pick latest valid SemVer
 *      whose plugin.json `name` is "orchestrator" and whose
 *      scripts/state.mjs exists)
 *   3. Codex cache layout (single fixed path; verify scripts/state.mjs
 *      exists)
 *   4. Sibling fallback — derive engineer's own plugin root from
 *      `import.meta.url` (this file at `<engineer-root>/scripts/...`)
 *      and look for `<engineer-root>/../orchestrator/scripts/state.mjs`.
 *      Mirrors `plugins/engineer/scripts/dispatch-peer.mjs`'s
 *      `findCompanionsRootWithDiscovery` repo-fallback shape. This
 *      branch fires in monorepo dev (`<repo>/plugins/engineer/scripts/`
 *      → `<repo>/plugins/orchestrator/`) and in Codex's single-fixed-path
 *      cache (`<…>/plugins/engineer/scripts/` →
 *      `<…>/plugins/orchestrator/`). It does NOT depend on any
 *      caller-supplied repoRoot (the caller's repoRoot is the user's
 *      target project, NOT the engineer plugin checkout — passing it
 *      here would let the lookup leak into unrelated trees).
 * Returns the absolute path on first hit, `null` if nothing resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url] — `import.meta.url` of
 *   this module. Tests inject a temp path to redirect the sibling
 *   fallback at a controlled directory.
 * @returns {Promise<?string>}
 */
export async function discoverOrchestratorPluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  // 1. Env override — must be absolute + scripts/state.mjs must exist.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (!isAbsolute(overrideRoot)) {
      // Mirror dispatch-peer.mjs: absolute-only env values. Best-effort:
      // surface as not-found rather than throwing (callers handle null).
      return null;
    }
    if (await fileExists(join(overrideRoot, 'scripts', 'state.mjs'))) {
      return overrideRoot;
    }
    return null;
  }

  const { claude: claudeBase, codex: codexBase } = cacheBases(home);

  // 2. Claude cache — multi-version walk. Pick the highest SemVer that
  // has a valid plugin.json (name=orchestrator) AND scripts/state.mjs.
  if (await dirExists(claudeBase)) {
    let entries = [];
    try {
      entries = await readdir(claudeBase, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const versionRoot = join(claudeBase, entry.name);
      const manifestFile = join(versionRoot, '.claude-plugin', 'plugin.json');
      let manifest;
      try {
        manifest = JSON.parse(await fsReadFile(manifestFile, 'utf8'));
      } catch {
        continue;
      }
      if (manifest?.name !== 'orchestrator') continue;
      const statePath = join(versionRoot, 'scripts', 'state.mjs');
      if (!(await fileExists(statePath))) continue;
      candidates.push({
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        root: versionRoot,
      });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => semverCompare(b.version, a.version));
      return candidates[0].root;
    }
  }

  // 3. Codex cache — single fixed path.
  if ((await dirExists(codexBase))
      && (await fileExists(join(codexBase, 'scripts', 'state.mjs')))) {
    return codexBase;
  }

  // 4. Sibling fallback. Derive engineer's own plugin root from this
  // file's location and look one level up + over for the orchestrator
  // peer. Works in both monorepo dev and Codex's single-fixed-path
  // cache (the Claude cache hits step 2 first, so this branch is
  // effectively monorepo + Codex). Never use the caller's repoRoot —
  // that's the user's target project, not the engineer plugin root.
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    let here;
    try {
      here = fileURLToPath(selfUrl);
    } catch {
      here = null;
    }
    if (here) {
      // here = <engineer-root>/scripts/parent-writeback.mjs
      // dirname(here) = <engineer-root>/scripts
      // resolve(..., '..', '..', 'orchestrator') = sibling orchestrator
      const sibling = resolve(dirname(here), '..', '..', 'orchestrator');
      if (await fileExists(join(sibling, 'scripts', 'state.mjs'))) {
        return sibling;
      }
    }
  }

  return null;
}

function orchWorkflowDirs(repoRoot) {
  return ORCH_WORKFLOW_DIR_RELS.map((rel) => join(repoRoot, rel));
}

function orchArchiveDirs(repoRoot) {
  return ORCH_ARCHIVE_DIR_RELS.map((rel) => join(repoRoot, rel));
}

function parentFileBasename(parentWorkflowId) {
  return `${parentWorkflowId}.md`;
}

/**
 * Dispatch a single-subtask update against the orchestrator macro
 * workflow identified by `parentWorkflowId`, marking
 * `originatingSubtaskId` completed with the engineer terminal
 * commit/timestamp/workflow-id payload.
 *
 * Internally spawns `orchestrator/scripts/state.mjs subtask-update`
 * (PR-C0 public CLI) so all atomic mutation logic (precondition skip,
 * unblock pass, auto-terminal pass, single-writer ownership) stays
 * inside orchestrator — engineer here is a thin wrapper.
 *
 * Failure modes — none throw past the caller:
 *   - parent file missing from workflows/ but present in archive/ →
 *     `{ok:false, skipped:true, reason:'parent-archived'}`
 *   - parent file missing from BOTH workflows/ and archive/ →
 *     `{ok:false, skipped:true, reason:'parent-not-found'}`
 *   - orchestrator plugin root unresolved →
 *     `{ok:false, skipped:true, reason:'orchestrator-root-not-found'}`
 *   - state.mjs CLI exits non-zero →
 *     `{ok:false, reason:'cli-failed', stderr, exitCode}`
 *   - PR-C0 precondition skip (deferred/abandoned subtask) → envelope
 *     surfaces `{skipped: true, skipReason: '...'}`; the helper still
 *     returns `{ok:true, envelope}`. The skip is informational —
 *     archive lifecycle is unaffected.
 *
 * @param {object}  args
 * @param {string}  args.repoRoot — absolute path to the repo whose
 *   canonical or legacy orchestrator state tree holds the parent workflow
 * @param {string}  args.parentWorkflowId
 * @param {string}  args.originatingSubtaskId
 * @param {string}  args.engineerWorkflowId — owner id (must match the
 *   `engineer_workflow_id` already recorded on the subtask, if set)
 * @param {string}  args.commit — terminal commit SHA on the engineer
 *   workflow's branch
 * @param {string}  args.closedAt — ISO-8601 UTC timestamp
 * @param {string}  args.host — 'claude' | 'codex'
 * @param {?string} [args.orchestratorRoot] — explicit override; when
 *   omitted, `discoverOrchestratorPluginRoot` runs with
 *   `discoverOpts`. Tests pass this directly to avoid relying on
 *   the runtime cache layout.
 * @param {object}  [args.discoverOpts] — forwarded to
 *   `discoverOrchestratorPluginRoot` when `orchestratorRoot` is not
 *   supplied
 * @param {NodeJS.WriteStream|{write:(s:string)=>void}} [args.stderr=process.stderr]
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, envelope?: object, stderr?: string, exitCode?: number}>}
 */
export async function writebackParent({
  repoRoot,
  parentWorkflowId,
  originatingSubtaskId,
  engineerWorkflowId,
  commit,
  closedAt,
  host,
  orchestratorRoot = null,
  discoverOpts = undefined,
  stderr = process.stderr,
}) {
  // ---------------------------------------------------------------------------
  // Argument validation — fail loudly on misuse from the engineer side
  // (these are programmer-error cases, not best-effort skips).
  function requireString(name, value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`writebackParent: ${name} must be a non-empty string`);
    }
  }
  requireString('repoRoot', repoRoot);
  requireString('parentWorkflowId', parentWorkflowId);
  requireString('originatingSubtaskId', originatingSubtaskId);
  requireString('engineerWorkflowId', engineerWorkflowId);
  requireString('commit', commit);
  requireString('closedAt', closedAt);
  requireString('host', host);

  // Reject any parent_workflow id that is not a basename-shaped
  // single path component. An id like `../archive/<other>` would
  // otherwise let `join()` resolve outside the orchestrator
  // workflows/ home and bypass the archive-fallback
  // detection below — an attacker (or a corrupted frontmatter) could
  // redirect the writeback at an arbitrary file. orchestrator-
  // generated ids are always basename-shaped (`<verb>-<isoCompact>-
  // <rand>`); rejecting non-basename input is forward-compatible with
  // future id-shape changes while closing the traversal hole.
  if (
    basename(parentWorkflowId) !== parentWorkflowId
    || parentWorkflowId.includes('..')
    || parentWorkflowId.startsWith('.')
    || parentWorkflowId.includes('\0')
  ) {
    stderr.write(
      `engineer/parent-writeback: WARN invalid parent_workflow id ` +
      `${JSON.stringify(parentWorkflowId)} — must be a basename-shaped ` +
      `single path component (no '/', '\\\\', '..', leading '.', or NUL). ` +
      `Skipping writeback to avoid path traversal; reconcile manually if ` +
      `the linkage is legitimate.\n`,
    );
    return { ok: false, skipped: true, reason: 'parent-id-invalid' };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — resolve parent file path. Check canonical then legacy
  // workflows/ first; on miss fall back to both archive/ homes. The
  // ADR-0019 §4 step 3 rule says: if the parent is in archive/, emit
  // a stderr warning and skip without touching the frozen state.
  let resolvedParentPath = null;
  for (const dir of orchWorkflowDirs(repoRoot)) {
    const candidatePath = join(dir, parentFileBasename(parentWorkflowId));
    if (await fileExists(candidatePath)) {
      resolvedParentPath = candidatePath;
      break;
    }
  }
  if (!resolvedParentPath) {
    // Check archive/ — best-effort exact-name match. ADR-0019 §4 step
    // 3 only requires us to detect the archived case and skip; the
    // helper does not need to do anything with the archived file.
    let archived = false;
    for (const dir of orchArchiveDirs(repoRoot)) {
      const archivedExact = join(dir, parentFileBasename(parentWorkflowId));
      archived = await fileExists(archivedExact);
      if (archived) break;
      // archiveWorkflow appends `-<isoCompact>-<rand>.md` on collision —
      // scan archive/ for any file whose name starts with the workflow id.
      try {
        const archiveEntries = await readdir(dir);
        archived = archiveEntries.some((name) => name.startsWith(parentWorkflowId));
        if (archived) break;
      } catch {
        // archive dir absent → not archived
      }
    }
    if (archived) {
      stderr.write(
        `engineer/parent-writeback: parent_workflow=${parentWorkflowId} is in archive/ — ` +
        `skipping completion writeback (orchestrator macro already finalized; archive fallback per ADR-0019 §4 step 3)\n`,
      );
      return { ok: false, skipped: true, reason: 'parent-archived' };
    }
    stderr.write(
      `engineer/parent-writeback: WARN dangling parent linkage — ` +
      `parent_workflow=${parentWorkflowId} was set on this engineer workflow but the ` +
      `file does NOT exist in either canonical or legacy orchestrator workflow/archive homes ` +
      `(possible data integrity issue — orchestrator workflow may have been ` +
      `manually deleted or never existed). Skipping writeback; reconcile via ` +
      `/orchestrator:done if the parent is recoverable.\n`,
    );
    return { ok: false, skipped: true, reason: 'parent-not-found' };
  }

  // ---------------------------------------------------------------------------
  // Step 2 — resolve orchestrator plugin root for the CLI spawn.
  let root = orchestratorRoot;
  if (typeof root !== 'string' || root.length === 0) {
    root = await discoverOrchestratorPluginRoot(discoverOpts ?? {
      env: process.env,
      home: homedir(),
      repoRoot,
    });
  }
  if (!root) {
    stderr.write(
      `engineer/parent-writeback: orchestrator plugin root not found ` +
      `(checked ${ENV_OVERRIDE}, Claude cache, Codex cache, monorepo sibling) — ` +
      `skipping writeback (manual reconciliation via /orchestrator:done)\n`,
    );
    return { ok: false, skipped: true, reason: 'orchestrator-root-not-found' };
  }
  const cliPath = join(root, 'scripts', 'state.mjs');
  if (!(await fileExists(cliPath))) {
    stderr.write(
      `engineer/parent-writeback: orchestrator scripts/state.mjs not found at ${cliPath} — ` +
      `skipping writeback\n`,
    );
    return { ok: false, skipped: true, reason: 'orchestrator-cli-missing' };
  }

  // ---------------------------------------------------------------------------
  // Step 3 — spawn PR-C0 CLI. Single-pass invocation; PR-C0 does all
  // the lifecycle work atomically under its own parent per-file lock.
  // §6 lock-order: engineer-side locks are already released by the
  // time runStopArchive calls this helper (archiveWorkflow's
  // withDirectoryLock + withFileLock callbacks both exited).
  // Encode every value as `--flag=value` (equals form). orchestrator's
  // cliParseFlags supports both `--flag value` and `--flag=value`, but
  // the space-separated form mis-parses values that start with `--`
  // (the parser would treat the value as the next flag and leave the
  // current flag's value empty). `subtask-id`, `engineer-workflow-id`,
  // and `commit` are caller-supplied strings whose shape is governed
  // by upstream validators that do NOT forbid a `--` prefix today —
  // equals form prevents the argv-injection edge case independent of
  // those validator gaps.
  const args = [
    cliPath,
    'subtask-update',
    `--workflow-path=${resolvedParentPath}`,
    `--host=${host}`,
    `--subtask-id=${originatingSubtaskId}`,
    `--status=completed`,
    `--engineer-workflow-id=${engineerWorkflowId}`,
    `--commit=${commit}`,
    `--closed-at=${closedAt}`,
    `--event=updated`,
  ];

  try {
    const { stdout, stderr: cliStderr } = await execFileAsync(
      process.execPath,
      args,
      // 30s upper bound defends against a stale parent-file lock held
      // by a crashed peer — the parent-writeback path must not hang the
      // host Stop lifecycle. Per orchestrator's acquireLock budget
      // (RETRY_BACKOFF_MAX_MS = 5_000ms) the normal completion time is
      // well under a second; a multi-second timeout indicates the lock
      // is genuinely stuck.
      { encoding: 'utf8', timeout: 30_000 },
    );
    // PR-C0 may emit informational warnings on stderr (e.g.,
    // precondition-skip diagnostics for deferred/abandoned subtasks).
    // Surface them on our stderr so the user sees the full chain.
    if (cliStderr && cliStderr.length > 0) {
      stderr.write(`engineer/parent-writeback (orchestrator stderr): ${cliStderr}`);
    }
    let envelope;
    try {
      envelope = JSON.parse(stdout.trim());
    } catch (err) {
      stderr.write(
        `engineer/parent-writeback: failed to parse orchestrator CLI JSON envelope ` +
        `(stdout=${JSON.stringify(stdout)}): ${err.message}\n`,
      );
      return { ok: false, reason: 'cli-parse-failed', stderr: cliStderr };
    }
    return { ok: true, envelope };
  } catch (err) {
    // execFile rejection categories:
    //  - timeout: err.killed === true (Node killed the child after the
    //    `timeout` option elapsed). Surfaced as a distinct reason so
    //    the user can diagnose stale-lock vs. genuine CLI failure.
    //  - non-zero exit: err.code is the numeric exit code.
    //  - spawn failure (ENOENT etc.): err.code is the libuv string
    //    code; we coerce to null for the numeric exitCode field.
    const cliStderr = err.stderr ?? '';
    if (err.killed === true) {
      stderr.write(
        `engineer/parent-writeback: orchestrator CLI timed out (30s) — ` +
        `parent per-file lock likely stuck from a crashed peer. ` +
        `Reconcile via /orchestrator:done after manually releasing ` +
        `<repo>/.agentic-plugins/state/orchestrator/workflows/${parentWorkflowId}.md.lock ` +
        `or the legacy .claude equivalent.\n`,
      );
      return { ok: false, reason: 'cli-timeout', stderr: cliStderr };
    }
    const exitCode = typeof err.code === 'number' ? err.code : null;
    stderr.write(
      `engineer/parent-writeback: orchestrator CLI exited ${exitCode ?? err.code}: ` +
      `${cliStderr.trim() || err.message}\n`,
    );
    return { ok: false, reason: 'cli-failed', stderr: cliStderr, exitCode };
  }
}
