// plugins/orchestrator/adapters/claude/autopilot/roots.mjs
//
// ADR-0063 D5 — the plugin roots a run's workers use, resolved once by the
// driver and exported to every worker as AGENTIC_{ORCHESTRATOR,ENGINEER,
// RUNTIME}_ROOT, which the runbooks prefer over anything else (S0).
//
//   - engineer, runtime: orchestrator's own ADR-0061 ladder (env override →
//     the caller's install cache → sibling checkout). A root found only in the
//     Codex cache is refused: a Claude worker loads Claude's install, and its
//     hooks would run other code than its runbook scripts.
//   - orchestrator: AGENTIC_ORCHESTRATOR_ROOT, else the plugin this file runs
//     from, so the policy and the state CLIs it reads are one release.
//
// Before a run starts, two checks refuse roots the run cannot use:
//
//   - the capability floor: source probes for the surfaces the run depends on
//     (S0 root env, S2 approval, S3+S4 autopilot verbs and /engineer:commit,
//     S6 approval gate, ADR-0062 landing). The released engineer 0.23.0
//     scripts fail a verb's Phase 0 before any write (ADR-0063 S3+S4 note), so
//     the driver refuses them up front instead of halting on the first step.
//   - the frozen-input guard: a root inside the repository being driven would
//     change under the run, because a step switches that checkout's branch.
//
// The versions pinned here are compared before every step (`version-drift`).

import { spawnSync } from 'node:child_process';
import { realpathSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateEngineerPluginRoot, preflightEngineerCapability } from '../../../scripts/discover-engineer.mjs';
import { locateRuntimePluginRoot } from '../../../scripts/discover-runtime.mjs';

export const PLUGINS = Object.freeze(['orchestrator', 'engineer', 'runtime']);
export const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The file each plugin's root must carry, as its resolver checks it: the
// orchestrator override below, discover-engineer.mjs's ladder (state.mjs) and
// discover-runtime.mjs's (footer.mjs; runtime has no state.mjs).
export const ROOT_MARKERS = Object.freeze({ orchestrator: 'scripts/state.mjs', engineer: 'scripts/state.mjs', runtime: 'scripts/footer.mjs' });

const canonical = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

export function pluginVersion(root) {
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
      if (typeof parsed.version === 'string') return parsed.version;
    } catch { /* next */ }
  }
  return null;
}

function fromLadder(name, located) {
  if (!located.root) return { problem: `${name}: ${located.reason ?? 'not found'}` };
  if (located.source === 'codex-cache') {
    return { problem: `${name} is installed only for Codex (${located.root}); install it for Claude Code — a Claude worker loads Claude's install` };
  }
  return { root: located.root, source: located.source };
}

/**
 * @returns {Promise<{roots: Record<string,string>, versions: Record<string,?string>,
 *   sources: Record<string,string>, problems: string[]}>}
 */
export async function resolveRoots({ env = process.env, home = homedir(), selfRoot = SELF_ROOT } = {}) {
  const roots = {};
  const sources = {};
  const problems = [];

  const override = env.AGENTIC_ORCHESTRATOR_ROOT;
  if (typeof override === 'string' && override.length > 0) {
    if (isAbsolute(override) && existsSync(join(override, ROOT_MARKERS.orchestrator))) {
      roots.orchestrator = canonical(override);
      sources.orchestrator = 'env';
    } else {
      problems.push(`orchestrator: AGENTIC_ORCHESTRATOR_ROOT=${override} is not an absolute orchestrator root with scripts/state.mjs`);
    }
  } else {
    roots.orchestrator = canonical(selfRoot);
    sources.orchestrator = 'self';
  }

  for (const [name, locate] of [['engineer', locateEngineerPluginRoot], ['runtime', locateRuntimePluginRoot]]) {
    const r = fromLadder(name, await locate({ env, home }));
    if (r.problem) problems.push(r.problem);
    else { roots[name] = r.root; sources[name] = r.source; }
  }

  const versions = Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, pluginVersion(v)]));
  return { roots, versions, sources, problems };
}

const read = (p) => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

// Each probe names the surface, where it lives, and the release that ships it.
const PROBES = Object.freeze({
  orchestrator: [
    ['scripts/state.mjs', "'next-ready'", 'next-ready'],
    ['scripts/state.mjs', "'plan-approve'", 'plan approval (S2, orchestrator 0.15.0)'],
    ['scripts/state.mjs', "'approval-gate'", 'the /orchestrator:next approval gate (S6, orchestrator 0.16.0)'],
    ['scripts/state.mjs', "'resolve-landing'", 'landing resolution (ADR-0062, orchestrator 0.14.0)'],
    ['scripts/state.mjs', "case 'admission'", 'the admission entries the runbooks join (ADR-0067 Decision 4, item 5, SR)'],
    ['commands/next.md', 'approval-gate', 'the gated /orchestrator:next runbook (S6, orchestrator 0.16.0)'],
    ['commands/next.md', '${AGENTIC_ORCHESTRATOR_ROOT:-', 'runbooks that honor AGENTIC_ORCHESTRATOR_ROOT (S0)'],
    ['commands/done.md', '--no-commit', '/orchestrator:done --no-commit (ADR-0062)'],
  ],
  engineer: [
    ['scripts/state.mjs', "'autopilot-preflight'", 'autopilot-preflight (S3+S4, engineer 0.24.0)'],
    ['scripts/state.mjs', "'finish-verb'", 'finish-verb (S3+S4, engineer 0.24.0)'],
    ['scripts/phase7-commit.mjs', "'autopilot'", 'phase7-commit --mode autopilot (S3+S4, engineer 0.24.0)'],
    ['commands/commit.md', '/engineer:commit', 'the /engineer:commit command (S3+S4, engineer 0.24.0)'],
    ['commands/compose.md', '${AGENTIC_ENGINEER_ROOT:-', 'runbooks that honor AGENTIC_ENGINEER_ROOT (S0)'],
  ],
  runtime: [
    ['scripts/context.mjs', "'entry-brief'", 'runtime:context entry-brief (ADR-0045)'],
  ],
});

/** Problems with the surfaces a run needs; an empty list means the floor holds. */
export async function capabilityProblems(roots) {
  const problems = [];
  for (const plugin of PLUGINS) {
    const root = roots[plugin];
    if (!root) continue;
    for (const [file, token, what] of PROBES[plugin]) {
      const text = read(join(root, file));
      if (text === null) problems.push(`${plugin} at ${root} has no ${file}, so it lacks ${what}`);
      else if (!text.includes(token)) problems.push(`${plugin} at ${root} lacks ${what} (${file})`);
    }
  }
  if (roots.engineer) {
    const pre = await preflightEngineerCapability(roots.engineer);
    if (!pre.ok) problems.push(`engineer at ${roots.engineer}: ${pre.reason}`);
  }
  return problems;
}

// The report `state-root` prints (orchestrator's and engineer's
// lib/state-root.mjs, STATE_ROOT_REPORT_SCHEMA).
const STATE_ROOT_REPORT = 'agentic-state-root-1.0';

/**
 * ADR-0067 Decision 6 — the capability floor lanes add to S8's, the same two
 * ways, never read from version numbers:
 *   - the pinned engineer and orchestrator `state.mjs` answer
 *     `state-root --repo-root <checkout>` (run, SR);
 *   - the pinned engineer's `create` accepts `--parent-workflow-path` (token, PL);
 *   - the pinned runtime's entry brief reads the shared state root (RR). The
 *     brief RR shipped prints no field naming the root it read, so this one
 *     is a token too: its reader takes the read set (`stateReadSet`).
 * Problems; an empty list means the floor holds.
 */
export function lanesCapabilityProblems(roots, checkout, { env = process.env } = {}) {
  const problems = [];
  for (const plugin of ['orchestrator', 'engineer']) {
    const root = roots[plugin];
    if (!root) continue;
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'state.mjs'), 'state-root', '--repo-root', checkout], {
      cwd: checkout, env, encoding: 'utf8', timeout: 30_000,
    });
    let report = null;
    try { report = JSON.parse((r.stdout ?? '').trim()); } catch { /* not JSON */ }
    if (r.status !== 0 || report?.schema !== STATE_ROOT_REPORT || !Array.isArray(report?.read_set)) {
      problems.push(`${plugin} at ${root} does not answer state-root --repo-root (ADR-0067 SR), which lanes need`);
    }
  }
  const tokens = [
    ['engineer', 'scripts/state.mjs', 'parent-workflow-path', 'create --parent-workflow-path (ADR-0067 PL)'],
    ['runtime', 'scripts/lib/entry-brief-readers.mjs', 'stateReadSet', 'an entry brief that reads the shared state root (ADR-0067 RR)'],
  ];
  for (const [plugin, file, token, what] of tokens) {
    const root = roots[plugin];
    if (!root) continue;
    const text = read(join(root, file));
    if (text === null || !text.includes(token)) problems.push(`${plugin} at ${root} lacks ${what} (${file}), which lanes need`);
  }
  return problems;
}

const isWithin = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * A root inside the repository the run drives changes under the run: a step
 * switches that checkout's branch (`/orchestrator:next`), and the runbooks
 * would then run another branch's scripts. On a directory marketplace the
 * command text points into the marketplace checkout, so driving that
 * checkout itself reaches this.
 */
export function frozenInputProblems(roots, repoRoot) {
  const repo = canonical(repoRoot);
  return Object.entries(roots)
    .filter(([, root]) => isWithin(canonical(root), repo))
    .map(([plugin, root]) =>
      `${plugin} root ${root} is inside the repository this run drives; a step switches its branch, which would ` +
        `change the scripts mid-run. Pin AGENTIC_${plugin.toUpperCase()}_ROOT to an install or to a snapshot worktree ` +
        '(git worktree add --detach <dir> <commit>) outside it.');
}

/** What changed between the pinned roots/versions and a fresh resolution. */
export function driftOf(pinned, current) {
  const changes = [];
  for (const plugin of PLUGINS) {
    const a = pinned.roots[plugin];
    const b = current.roots[plugin];
    const va = pinned.versions[plugin];
    const vb = current.versions[plugin];
    if (a !== b || va !== vb) changes.push(`${plugin} ${va ?? '?'} (${a ?? 'none'}) -> ${vb ?? '?'} (${b ?? 'none'})`);
  }
  return changes;
}
