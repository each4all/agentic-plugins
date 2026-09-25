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
//   1. Resolve the orchestrator plugin root (env override → the install
//      cache of the host engineer runs from → the other host's cache, only
//      when the first has no orchestrator installed, and reported →
//      monorepo sibling, only when engineer runs from a checkout). Every
//      cache is versioned and manifest-verified; the Codex marketplace clone
//      (~/.codex/.tmp/marketplaces/…) tracks the repository's main branch
//      and is never a candidate (ADR-0061 §Decision 3).
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
import { realpathSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, basename, relative } from 'node:path';
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

// Codex honors $CODEX_HOME for everything it writes, including the plugin
// cache; an unset or empty value means ~/.codex.
function codexHomeDir(env, home) {
  const value = env.CODEX_HOME;
  return typeof value === 'string' && value.length > 0 ? resolve(value) : join(home, '.codex');
}

function hostLayout(env, home) {
  const codexHome = codexHomeDir(env, home);
  return {
    claude: {
      // The trees a host installs into and clones marketplaces into. Code
      // under them is that host's, never a checkout. Only these trees: a
      // checkout elsewhere under the host's home is still a checkout.
      roots: [
        join(home, '.claude', 'plugins', 'cache'),
        join(home, '.claude', 'plugins', 'marketplaces'),
      ],
      base: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'orchestrator'),
      manifest: join('.claude-plugin', 'plugin.json'),
    },
    codex: {
      roots: [
        join(codexHome, 'plugins', 'cache'),
        join(codexHome, '.tmp', 'marketplaces'),
      ],
      base: join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'orchestrator'),
      manifest: join('.codex-plugin', 'plugin.json'),
    },
  };
}

// Canonical form: the nearest existing ancestor is realpath'd and the rest
// re-appended, so a symlinked prefix (macOS /var -> /private/var, a symlinked
// ~/.codex) compares equal on both sides even when the tail does not exist.
// Every root this module returns is canonical too: the CLIs a root leads to
// compare argv[1] with Node's canonical module path, and silently do nothing
// when a symlink makes the two differ.
function realOrResolved(path) {
  let head = resolve(path);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function selfPathOf(selfUrl) {
  if (typeof selfUrl !== 'string' || selfUrl.length === 0) return null;
  try {
    return fileURLToPath(selfUrl);
  } catch {
    return null;
  }
}

// The length of the most specific root in `roots` that holds `path`, compared
// both as spelled and canonically (so a path reached through a symlink, or a
// tree symlinked elsewhere, still counts); 0 when none holds it. A symlink
// below a root is not followed: the canonical comparison covers a root that is
// itself a link or sits under one.
function ownership(path, roots) {
  const spelled = resolve(path);
  const canonical = realOrResolved(path);
  let best = 0;
  for (const root of roots) {
    const spelledRoot = resolve(root);
    const canonicalRoot = realOrResolved(root);
    if (isWithin(spelled, spelledRoot)) best = Math.max(best, spelledRoot.length);
    if (isWithin(canonical, canonicalRoot)) best = Math.max(best, canonicalRoot.length);
  }
  return best;
}

// 'codex' | 'claude' when this file sits in that host's install cache or a
// marketplace clone, else null (a checkout). When both hosts' trees hold it
// (one cache relocated inside the other's), the more specific root wins.
function callerHostOf(selfPath, hosts) {
  if (!selfPath) return null;
  const codex = ownership(selfPath, hosts.codex.roots);
  const claude = ownership(selfPath, hosts.claude.roots);
  if (codex === 0 && claude === 0) return null;
  return codex >= claude ? 'codex' : 'claude';
}

/**
 * The orchestrator install in one host cache: `{ state: 'absent' }` when no
 * manifest-verified orchestrator is there, `{ state: 'unusable', version }`
 * when one is but none carries scripts/state.mjs, else `{ state: 'ok', root,
 * version }` for the newest that does.
 */
async function newestOrchestratorInstall({ base, manifest }) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { state: 'absent' };
  }
  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionRoot = join(base, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await fsReadFile(join(versionRoot, manifest), 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.name !== 'orchestrator') continue;
    installed.push({
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      root: versionRoot,
      capable: await fileExists(join(versionRoot, 'scripts', 'state.mjs')),
    });
  }
  if (installed.length === 0) return { state: 'absent' };
  installed.sort((a, b) => semverCompare(b.version, a.version));
  const capable = installed.find((c) => c.capable);
  if (!capable) return { state: 'unusable', version: installed[0].version };
  return { state: 'ok', root: capable.root, version: capable.version };
}

/**
 * Resolve the orchestrator plugin root directory containing
 * `scripts/state.mjs`, and report where it came from. Tries:
 *   1. `AGENTIC_ORCHESTRATOR_ROOT` env override (absolute, with
 *      scripts/state.mjs); it never falls through
 *   2. the install cache of the host engineer itself runs from, then the
 *      other host's cache only when the first has no orchestrator installed
 *      (Claude first for a checkout caller). An orchestrator installed on the
 *      caller's host without scripts/state.mjs is a failure, not a reason to
 *      cross hosts.
 *   3. Sibling fallback, only when engineer runs from a checkout — derive
 *      engineer's own plugin root from `import.meta.url` (this file at
 *      `<engineer-root>/scripts/...`) and look for
 *      `<engineer-root>/../orchestrator/scripts/state.mjs`. It does NOT
 *      depend on any caller-supplied repoRoot (the caller's repoRoot is the
 *      user's target project, NOT the engineer plugin checkout — passing it
 *      here would let the lookup leak into unrelated trees).
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url] — `import.meta.url` of
 *   this module. Tests inject a temp path to redirect the sibling
 *   fallback at a controlled directory.
 * @returns {Promise<{root: ?string, source: ?string, host: ?string,
 *   callerHost: string, crossHostFallback: boolean, version?: string,
 *   reason?: string}>} `source` is 'env', 'claude-cache', 'codex-cache',
 *   'sibling', or null when nothing resolved; `callerHost` is 'codex',
 *   'claude' or 'checkout'.
 */
export async function locateOrchestratorPluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  const hosts = hostLayout(env, home);
  const selfPath = selfPathOf(selfUrl);
  const caller = callerHostOf(selfPath, hosts);
  const callerHost = caller ?? 'checkout';

  // 1. Env override — must be absolute + scripts/state.mjs must exist.
  // Best-effort: surface as not-found rather than throwing (callers handle
  // null).
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (isAbsolute(overrideRoot) && (await fileExists(join(overrideRoot, 'scripts', 'state.mjs')))) {
      return { root: realOrResolved(overrideRoot), source: 'env', host: null, callerHost, crossHostFallback: false };
    }
    return {
      root: null,
      source: 'env',
      host: null,
      callerHost,
      crossHostFallback: false,
      reason: `${ENV_OVERRIDE}=${overrideRoot} is not an absolute orchestrator root with scripts/state.mjs`,
    };
  }

  // 2. Install caches, the caller's own host first.
  const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const host of order) {
    const install = await newestOrchestratorInstall(hosts[host]);
    if (install.state === 'absent') continue;
    const provenance = {
      source: `${host}-cache`,
      host,
      callerHost,
      crossHostFallback: caller !== null && host !== caller,
    };
    if (install.state === 'unusable') {
      return {
        root: null,
        ...provenance,
        reason: `orchestrator ${install.version} in ${hosts[host].base} ships no scripts/state.mjs`,
      };
    }
    return { root: realOrResolved(install.root), ...provenance, version: install.version };
  }

  // 3. Sibling checkout — <engineer-root>/scripts/parent-writeback.mjs →
  // <engineer-root>/../orchestrator. Never the caller's repoRoot.
  if (caller === null && selfPath) {
    const sibling = resolve(dirname(selfPath), '..', '..', 'orchestrator');
    // A sibling that resolves into an install cache or a marketplace clone is
    // not a checkout.
    const hostTrees = [...hosts.codex.roots, ...hosts.claude.roots];
    if (ownership(sibling, hostTrees) === 0 && (await fileExists(join(sibling, 'scripts', 'state.mjs')))) {
      return { root: realOrResolved(sibling), source: 'sibling', host: null, callerHost, crossHostFallback: false };
    }
  }

  return {
    root: null,
    source: null,
    host: null,
    callerHost,
    crossHostFallback: false,
    reason: 'orchestrator plugin is not installed in the Claude or Codex plugin cache',
  };
}

/**
 * `locateOrchestratorPluginRoot` without the provenance: the absolute root,
 * or `null` if nothing resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @returns {Promise<?string>}
 */
export async function discoverOrchestratorPluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  return (await locateOrchestratorPluginRoot({ env, home, selfUrl })).root;
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
    const located = await locateOrchestratorPluginRoot(discoverOpts ?? {
      env: process.env,
      home: homedir(),
    });
    root = located.root;
    if (!root) {
      stderr.write(
        `engineer/parent-writeback: orchestrator plugin root not found ` +
        `(${located.reason ?? 'no candidate resolved'}) — ` +
        `skipping writeback (manual reconciliation via /orchestrator:done)\n`,
      );
      return { ok: false, skipped: true, reason: 'orchestrator-root-not-found' };
    }
    if (located.crossHostFallback) {
      // ADR-0061 §Decision 4: once the catalog pins are active, a Codex
      // install holds a release commit and the other host's copy does not, so
      // the fallback is reported rather than taken silently.
      stderr.write(
        `engineer/parent-writeback: orchestrator resolved from the ${located.host} plugin cache ` +
        `because the ${located.callerHost} cache has no orchestrator installed\n`,
      );
    }
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
