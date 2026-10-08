#!/usr/bin/env node
// scripts/parent-writeback.mjs
//
// A dispatch_target capability module (ADR-0066 Decision 3): generated only
// into a persona that declares dispatch_target on, and imported only when it
// is on. Messages name the persona from its declaration.
//
// ADR-0019 PR-C — engineer-local parent-writeback helper. Engineer's
// Phase 7 (P10) and its Stop hook call this when the workflow has
// `parent_workflow` + `originating_subtask` set, to tell the orchestrator
// macro that the workflow reached its terminal commit.
//
// ADR-0062 §Decision 2: this no longer completes the subtask. The terminal
// commit is on the subtask branch, and a squash or rebase merge lands a
// different commit, so /orchestrator:done records completion after the
// merge. The macro gets an ownership-binding note instead
// (`subtask-engineer-terminal`); a repeated call for the same commit is a
// no-op on the orchestrator side, so Phase 7 and the Stop hook can both
// call it. The helper is engineer-local for now (ADR-0010 §6 trigger 1
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
//   2. Resolve the parent workflow file: the child's recorded
//      `parent_workflow_path` first, when it names a file (ADR-0067
//      Decision 3), else the candidates, canonical
//      `<repoRoot>/.agentic-plugins/state/orchestrator/workflows/<parent>.md`
//      or legacy `<repoRoot>/.claude/agentic-orchestrator/workflows/<parent>.md`.
//      The file found must carry the parent's workflow id, and must be the
//      only one: a second copy refuses the writeback. The orchestrator is
//      handed the file it physically is, never a symlink to it. Apply the ADR-0019 §4
//      step 3 archive-fallback rule when the parent has already been moved to
//      `archive/` (skip + stderr warning, do NOT throw — host stop lifecycle
//      must not be blocked).
//   3. Spawn the orchestrator state.mjs `subtask-engineer-terminal` CLI
//      (ADR-0062). It checks existence, ownership and terminal states and
//      writes the note under its own parent per-file lock — §6 lock-order
//      holds because the engineer side has released its own locks before
//      this helper is called. An orchestrator from before ADR-0062 has no
//      such subcommand; that is reported as `orchestrator-too-old`.
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
import { join, isAbsolute, resolve, dirname, basename, relative, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { personaName } from './lib/persona.mjs';

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

// An archived macro keeps its name, or gains `-<isoCompact>-<rand>` when
// archiveWorkflow meets a collision. Only those two forms count: a macro whose
// id merely starts with this one is another macro.
function isArchivedName(name, parentWorkflowId) {
  return name === parentFileBasename(parentWorkflowId)
    || (name.startsWith(`${parentWorkflowId}-`) && name.endsWith('.md'));
}

/**
 * What is wrong with a recorded `parent_workflow_path` as a path, before any
 * file is read (ADR-0067 Decision 3): it must be absolute and normalized, be
 * named `<parent_workflow>.md`, and sit in an orchestrator `workflows/` home.
 * `null` when it is well formed.
 */
export function parentPathShapeProblem(path, parentWorkflowId) {
  if (typeof path !== 'string' || path.length === 0) return 'it is not a non-empty string';
  if (!isAbsolute(path)) return 'it is not absolute';
  if (normalize(path) !== path) return 'it is not normalized';
  if (basename(path) !== parentFileBasename(parentWorkflowId)) {
    return `its file name is not ${parentFileBasename(parentWorkflowId)}`;
  }
  const dir = dirname(path);
  if (!ORCH_WORKFLOW_DIR_RELS.some((rel) => dir.endsWith(`${sep}${rel.split('/').join(sep)}`))) {
    return `it is not in an orchestrator workflows home (${ORCH_WORKFLOW_DIR_RELS.join(' or ')})`;
  }
  return null;
}

// The orchestrator checkout a well-formed macro path belongs to: the
// directory its workflows home sits in.
function checkoutOfMacroPath(path) {
  const dir = dirname(path);
  for (const rel of ORCH_WORKFLOW_DIR_RELS) {
    const suffix = `${sep}${rel.split('/').join(sep)}`;
    if (dir.endsWith(suffix)) return dir.slice(0, -suffix.length);
  }
  return null;
}

/**
 * What a path names: `{ kind: 'file' }`, `{ kind: 'absent' }` (nothing there:
 * the macro moved or was archived), or `{ kind: 'unreadable', why }` — not a
 * regular file, or a stat that failed for another reason (a permission, an
 * I/O error, a symlink loop). Only absence may send the search elsewhere: a
 * target that cannot be inspected is refused, never read as missing.
 */
async function probePath(path) {
  try {
    const st = await stat(path);
    return st.isFile() ? { kind: 'file' } : { kind: 'unreadable', why: 'it is not a regular file' };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'unreadable', why: `it cannot be inspected (${err.code ?? err.message})` };
  }
}

// The two top-level scalars the identity check needs, read the way the
// orchestrator's parser reads them (plugins/orchestrator/scripts/state.mjs
// parseWorkflowFile and parseScalar): the file opens with `---\n` and the
// frontmatter closes at `\n---\n`; a key runs to the first colon and one space
// after it is dropped; a value starting with `"` is JSON, anything else is
// the text as written. Indented lines belong to nested blocks and are
// skipped. A key written twice is refused: the orchestrator keeps the last,
// and a check that read another one would approve a file it then writes as a
// different macro. `{ fields }` or `{ problem }`.
const IDENTITY_KEYS = ['workflow_id', 'workflow_type'];

function macroIdentityFields(text) {
  if (!text.startsWith('---\n')) return { problem: 'its frontmatter does not open with "---"' };
  const after = text.slice(4);
  const close = after.indexOf('\n---\n');
  if (close === -1) return { problem: 'its frontmatter does not close with "---"' };
  const fields = {};
  for (const line of after.slice(0, close).split('\n')) {
    if (line === '' || line.startsWith(' ')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    if (!IDENTITY_KEYS.includes(key)) continue;
    if (Object.hasOwn(fields, key)) return { problem: `its frontmatter sets ${key} more than once` };
    let rest = line.slice(colon + 1);
    if (rest.startsWith(' ')) rest = rest.slice(1);
    if (rest.startsWith('"')) {
      try {
        fields[key] = JSON.parse(rest);
      } catch {
        return { problem: `its ${key} is not a readable string` };
      }
    } else {
      fields[key] = rest;
    }
  }
  return { fields };
}

/**
 * Whether the existing file at `path` is the active orchestrator macro
 * `parentWorkflowId`: the file it physically is sits in an orchestrator
 * `workflows/` home under the macro's name (so a symlinked file or directory
 * cannot route the writeback into `archive/` or elsewhere), and its
 * frontmatter has that `workflow_id` and `workflow_type: macro`.
 * `{ physical }`, the file it physically is, when it is, else `{ problem }`.
 * The identity is read from `physical`, the file the writeback then hands
 * the orchestrator.
 */
async function inspectMacroFile(path, parentWorkflowId) {
  let physical;
  try {
    physical = realpathSync(path);
  } catch (err) {
    return { problem: `it cannot be resolved (${err.code ?? err.message})` };
  }
  const shape = parentPathShapeProblem(physical, parentWorkflowId);
  if (shape) return { problem: `the file it resolves to, ${physical}: ${shape}` };
  let text;
  try {
    text = await fsReadFile(physical, 'utf8');
  } catch (err) {
    return { problem: `it cannot be read (${err.code ?? err.message})` };
  }
  const { fields, problem } = macroIdentityFields(text);
  if (problem) return { problem };
  if (fields.workflow_id !== parentWorkflowId) {
    return { problem: `its workflow_id is ${JSON.stringify(fields.workflow_id ?? null)}, not ${JSON.stringify(parentWorkflowId)}` };
  }
  if (fields.workflow_type !== 'macro') {
    return { problem: `its workflow_type is ${JSON.stringify(fields.workflow_type ?? null)}, not "macro"` };
  }
  return { physical };
}

/**
 * The create-time check of `parent_workflow_path` (ADR-0067 Decision 3): the
 * path is well formed and names an existing orchestrator macro file whose
 * `workflow_id` is `parentWorkflowId`. `null` when it passes, else what is
 * wrong. The persona's `state.mjs create` calls it; the writeback runs the
 * same checks when the recorded path names a file.
 */
export async function checkParentWorkflowPath(path, parentWorkflowId) {
  const shape = parentPathShapeProblem(path, parentWorkflowId);
  if (shape) return shape;
  const probe = await probePath(path);
  if (probe.kind === 'absent') return 'it names no file';
  if (probe.kind === 'unreadable') return probe.why;
  return (await inspectMacroFile(path, parentWorkflowId)).problem ?? null;
}

// The physical file a path names, so one file reached by two spellings (a
// symlinked checkout) counts once.
function physicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Tell the orchestrator macro identified by `parentWorkflowId` that the
 * engineer workflow owning `originatingSubtaskId` reached its terminal
 * commit (ADR-0062 §Decision 2). The subtask is not completed here.
 *
 * Internally spawns `orchestrator/scripts/state.mjs
 * subtask-engineer-terminal`, so ownership, terminal-state and
 * idempotency checks stay inside orchestrator — engineer here is a thin
 * wrapper.
 *
 * Failure modes — none throw past the caller:
 *   - the recorded `parent_workflow_path` is malformed, or names a file that
 *     is not this macro → `{ok:false, skipped:true,
 *     reason:'parent-path-invalid'}`; the candidates are not searched
 *   - the recorded path or a candidate cannot be inspected (a permission,
 *     an I/O error, not a regular file) → `{ok:false, skipped:true,
 *     reason:'parent-unreadable'}`; it is never read as missing
 *   - more than one file holds the macro's id (the recorded path's, a
 *     candidate, or the other home of the recorded path's checkout) →
 *     `{ok:false, skipped:true, reason:'parent-ambiguous'}`
 *   - the one candidate found is not this macro → `{ok:false, skipped:true,
 *     reason:'parent-id-mismatch'}`
 *   - parent file missing from workflows/ but present in archive/ →
 *     `{ok:false, skipped:true, reason:'parent-archived'}`
 *   - parent file missing from BOTH workflows/ and archive/ →
 *     `{ok:false, skipped:true, reason:'parent-not-found'}`
 *   - orchestrator plugin root unresolved →
 *     `{ok:false, skipped:true, reason:'orchestrator-root-not-found'}`
 *   - the orchestrator CLI has no `subtask-engineer-terminal` (a release
 *     from before ADR-0062) → `{ok:false, reason:'orchestrator-too-old',
 *     stderr, exitCode}`
 *   - state.mjs CLI exits non-zero otherwise →
 *     `{ok:false, reason:'cli-failed', stderr, exitCode}`
 *   - subtask already completed / deferred / abandoned (or blocked) →
 *     envelope `{skipped: true, skipReason}`; a repeated call for the same
 *     commit → envelope `{noop: true}`. Both return `{ok:true, envelope}`.
 *
 * @param {object}  args
 * @param {string}  args.repoRoot — absolute path to the repo whose
 *   canonical or legacy orchestrator state tree holds the parent workflow
 * @param {string}  args.parentWorkflowId
 * @param {?string} [args.parentWorkflowPath] — the child's recorded
 *   `parent_workflow_path` (ADR-0067 Decision 3), absent on a child created
 *   without one (an older orchestrator or persona). Tried first when it
 *   names a file; otherwise the candidates under `repoRoot` are searched.
 * @param {string}  args.originatingSubtaskId
 * @param {string}  args.engineerWorkflowId — owner id (must match the
 *   `engineer_workflow_id` already recorded on the subtask, if set)
 * @param {string}  args.commit — terminal commit SHA on the engineer
 *   workflow's branch (noted on the macro, never recorded as the
 *   subtask's `commit`)
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
  parentWorkflowPath = null,
  originatingSubtaskId,
  engineerWorkflowId,
  commit,
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
  requireString('host', host);
  // A frontmatter key is absent or a non-empty string (the parser checks it),
  // so anything else here is a caller's mistake.
  if (parentWorkflowPath !== null && parentWorkflowPath !== undefined) {
    requireString('parentWorkflowPath', parentWorkflowPath);
  }

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
      `${personaName()}/parent-writeback: WARN invalid parent_workflow id ` +
      `${JSON.stringify(parentWorkflowId)} — must be a basename-shaped ` +
      `single path component (no '/', '\\\\', '..', leading '.', or NUL). ` +
      `Skipping writeback to avoid path traversal; reconcile manually if ` +
      `the linkage is legitimate.\n`,
    );
    return { ok: false, skipped: true, reason: 'parent-id-invalid' };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — resolve the parent file (ADR-0067 Decision 3). The recorded
  // path is checked as create checked it, and when it names a file it is
  // the macro or nothing: a path that names the wrong file is not repaired
  // by guessing. When no path is recorded, or the path names no file (the
  // macro moved, or was archived), the candidates are searched: canonical
  // then legacy workflows/ under repoRoot. On every path the file found must
  // carry the parent's id, and no second copy may exist. When none is found,
  // fall back to the archive/ homes: the ADR-0019 §4 step 3 rule says that
  // if the parent is in archive/, emit a stderr warning and skip without
  // touching the frozen state.
  const recordedPath = parentWorkflowPath ?? null;
  if (recordedPath !== null) {
    const shape = parentPathShapeProblem(recordedPath, parentWorkflowId);
    if (shape) {
      stderr.write(
        `${personaName()}/parent-writeback: WARN the recorded parent_workflow_path ` +
        `${JSON.stringify(recordedPath)} is not a macro path for parent_workflow=${parentWorkflowId}: ` +
        `${shape}. Skipping writeback; reconcile via /orchestrator:done.\n`,
      );
      return { ok: false, skipped: true, reason: 'parent-path-invalid' };
    }
  }
  const unreadable = (path, why) => {
    stderr.write(
      `${personaName()}/parent-writeback: WARN ${path}, where macro ${parentWorkflowId} would be, ` +
      `cannot be judged: ${why}. Skipping writeback rather than read it as missing; ` +
      `reconcile via /orchestrator:done.\n`,
    );
    return { ok: false, skipped: true, reason: 'parent-unreadable' };
  };
  const recordedProbe = recordedPath === null ? null : await probePath(recordedPath);
  if (recordedProbe?.kind === 'unreadable') return unreadable(recordedPath, recordedProbe.why);
  const recordedNamesFile = recordedProbe?.kind === 'file';
  let recordedPhysical = null;
  if (recordedNamesFile) {
    const { physical, problem } = await inspectMacroFile(recordedPath, parentWorkflowId);
    if (problem) {
      stderr.write(
        `${personaName()}/parent-writeback: WARN the recorded parent_workflow_path ${recordedPath} ` +
        `is not macro ${parentWorkflowId}: ${problem}. Skipping writeback without searching ` +
        `elsewhere (ADR-0067 Decision 3); reconcile via /orchestrator:done.\n`,
      );
      return { ok: false, skipped: true, reason: 'parent-path-invalid' };
    }
    recordedPhysical = physical;
  }
  // Every file that holds the macro's id, one entry per physical file: the
  // recorded path's, and those in the workflows homes of repoRoot and of the
  // checkout the recorded path names (its other home too: a second copy there
  // is as stale as one under repoRoot).
  const recordedCheckout = recordedPath === null ? null : checkoutOfMacroPath(recordedPath);
  const homes = [...orchWorkflowDirs(repoRoot), ...(recordedCheckout === null ? [] : orchWorkflowDirs(recordedCheckout))];
  const copies = new Map();
  if (recordedPhysical !== null) copies.set(recordedPhysical, recordedPath);
  for (const dir of homes) {
    const candidatePath = join(dir, parentFileBasename(parentWorkflowId));
    const probe = await probePath(candidatePath);
    if (probe.kind === 'absent') continue;
    if (probe.kind === 'unreadable') return unreadable(candidatePath, probe.why);
    const physical = physicalPath(candidatePath);
    if (!copies.has(physical)) copies.set(physical, candidatePath);
  }
  if (copies.size > 1) {
    stderr.write(
      `${personaName()}/parent-writeback: WARN parent_workflow=${parentWorkflowId} is held by ` +
      `${copies.size} files (${[...copies.values()].join(', ')}). Refusing the writeback rather ` +
      `than pick one (ADR-0067 Decision 3): remove the stray copy, then reconcile via ` +
      `/orchestrator:done.\n`,
    );
    return { ok: false, skipped: true, reason: 'parent-ambiguous' };
  }
  // The orchestrator is handed the physical file the identity was read from,
  // never a spelling through a symlink: it locks and atomically replaces the
  // path it is given, so a symlinked macro file would be replaced by a copy
  // while the macro stayed unchanged — a second writable copy, the fork
  // ADR-0067 Decision 4 exists to prevent.
  let resolvedParentPath = recordedPhysical;
  if (resolvedParentPath === null && copies.size === 1) {
    const [candidatePath] = copies.values();
    const { physical, problem } = await inspectMacroFile(candidatePath, parentWorkflowId);
    if (problem) {
      stderr.write(
        `${personaName()}/parent-writeback: WARN ${candidatePath} is not macro ` +
        `${parentWorkflowId}: ${problem}. Skipping writeback; reconcile via /orchestrator:done.\n`,
      );
      return { ok: false, skipped: true, reason: 'parent-id-mismatch' };
    }
    resolvedParentPath = physical;
  }
  if (!resolvedParentPath) {
    // Check archive/ — best-effort name match. ADR-0019 §4 step
    // 3 only requires us to detect the archived case and skip; the
    // helper does not need to do anything with the archived file. The
    // recorded path's own checkout is looked at too, so a macro archived in
    // another checkout reads as archived rather than dangling.
    const archiveDirs = orchArchiveDirs(repoRoot);
    if (recordedCheckout !== null) archiveDirs.push(...orchArchiveDirs(recordedCheckout));
    let archived = false;
    for (const dir of archiveDirs) {
      try {
        const archiveEntries = await readdir(dir);
        archived = archiveEntries.some((name) => isArchivedName(name, parentWorkflowId));
        if (archived) break;
      } catch {
        // archive dir absent → not archived
      }
    }
    if (archived) {
      stderr.write(
        `${personaName()}/parent-writeback: parent_workflow=${parentWorkflowId} is in archive/ — ` +
        `skipping completion writeback (orchestrator macro already finalized; archive fallback per ADR-0019 §4 step 3)\n`,
      );
      return { ok: false, skipped: true, reason: 'parent-archived' };
    }
    stderr.write(
      `${personaName()}/parent-writeback: WARN dangling parent linkage — ` +
      `parent_workflow=${parentWorkflowId} was set on this ${personaName()} workflow but the ` +
      `file does NOT exist in either canonical or legacy orchestrator workflow/archive homes ` +
      `${recordedPath === null ? '' : `nor at the recorded parent_workflow_path ${recordedPath} `}` +
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
        `${personaName()}/parent-writeback: orchestrator plugin root not found ` +
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
        `${personaName()}/parent-writeback: orchestrator resolved from the ${located.host} plugin cache ` +
        `because the ${located.callerHost} cache has no orchestrator installed\n`,
      );
    }
  }
  const cliPath = join(root, 'scripts', 'state.mjs');
  if (!(await fileExists(cliPath))) {
    stderr.write(
      `${personaName()}/parent-writeback: orchestrator scripts/state.mjs not found at ${cliPath} — ` +
      `skipping writeback\n`,
    );
    return { ok: false, skipped: true, reason: 'orchestrator-cli-missing' };
  }

  // ---------------------------------------------------------------------------
  // Step 3 — spawn the orchestrator's engineer-terminal CLI (ADR-0062).
  // Single-pass invocation; it does all its checks and the note atomically
  // under its own parent per-file lock.
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
    'subtask-engineer-terminal',
    `--workflow-path=${resolvedParentPath}`,
    `--host=${host}`,
    `--subtask-id=${originatingSubtaskId}`,
    `--engineer-workflow-id=${engineerWorkflowId}`,
    `--branch-commit=${commit}`,
    // ADR-0067 Decision 3 — the orchestrator checks the id again on the read
    // it makes under the macro's lock, with its own parser. An orchestrator
    // from before the flag ignores it, as its CLI ignores any flag it does
    // not read.
    `--expect-workflow-id=${parentWorkflowId}`,
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
    // The orchestrator may emit informational warnings on stderr (e.g.,
    // the skip diagnostic for a completed / deferred / abandoned subtask).
    // Surface them on our stderr so the user sees the full chain.
    if (cliStderr && cliStderr.length > 0) {
      stderr.write(`${personaName()}/parent-writeback (orchestrator stderr): ${cliStderr}`);
    }
    let envelope;
    try {
      envelope = JSON.parse(stdout.trim());
    } catch (err) {
      stderr.write(
        `${personaName()}/parent-writeback: failed to parse orchestrator CLI JSON envelope ` +
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
        `${personaName()}/parent-writeback: orchestrator CLI timed out (30s) — ` +
        `parent per-file lock likely stuck from a crashed peer. ` +
        `Reconcile via /orchestrator:done after manually releasing ` +
        `<repo>/.agentic-plugins/state/orchestrator/workflows/${parentWorkflowId}.md.lock ` +
        `or the legacy .claude equivalent.\n`,
      );
      return { ok: false, reason: 'cli-timeout', stderr: cliStderr };
    }
    const exitCode = typeof err.code === 'number' ? err.code : null;
    if (exitCode === 2 && /unknown subcommand: subtask-engineer-terminal/.test(cliStderr)) {
      // ADR-0062 §Decision 6: an orchestrator from before the landing-time
      // completion. Nothing is recorded, and nothing should be: the subtask
      // is completed by /orchestrator:done after the merge either way.
      stderr.write(
        `${personaName()}/parent-writeback: the orchestrator at ${root} predates ADR-0062 and has no ` +
        `subtask-engineer-terminal command; nothing was written to macro ${parentWorkflowId}. ` +
        `Update orchestrator. Subtask ${originatingSubtaskId} stays in_progress: after its pull ` +
        `request merges, record it with /orchestrator:done ${originatingSubtaskId} ` +
        `--commit=<the merge commit>.\n`,
      );
      return { ok: false, reason: 'orchestrator-too-old', stderr: cliStderr, exitCode };
    }
    stderr.write(
      `${personaName()}/parent-writeback: orchestrator CLI exited ${exitCode ?? err.code}: ` +
      `${cliStderr.trim() || err.message}\n`,
    );
    return { ok: false, reason: 'cli-failed', stderr: cliStderr, exitCode };
  }
}
