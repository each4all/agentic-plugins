// plugins/orchestrator/adapters/claude/autopilot/launch-proposals.mjs
//
// ADR-0067 Decision 8, item 4 — what preview and start propose about where a
// run is launched from, two triggers, each judged on its own:
//
//   - launched on the main checkout. A serial run switches that checkout's
//     branch at each dispatch; with lanes, done and finalize run there and its
//     checks read it, so work in it halts the run (Decision 6, Policy). Either
//     way the proposal is the home-worktree setup: a worktree no one works in,
//     `<parent>/<repo>-autopilot`, created on branch `autopilot/home` (an
//     existing one is reused, found by its path whatever branch a run left it
//     on), and the start command with the plugin roots pinned to the
//     installed Claude Code cache (ADR-0063 D2).
//   - plugin roots inside the repository the run drives: the refusal and the
//     provenance checks stay (roots.mjs frozenInputProblems, driver.mjs
//     provenanceProblem); the proposal is the concrete setup: pins to the
//     installed release caches, or, for a plugin with no install, to a
//     detached snapshot worktree no run drives. Pins move the runbooks'
//     scripts only: when Claude Code loads the plugins from this checkout (a
//     directory marketplace), the provenance check still halts the first
//     step, and the proposal says the run must be driven from another
//     checkout, the home worktree when this is the main one.
//
// Each proposal is {kind: 'worktree', command, pointer} in the JSON report
// (Decision 8, item 5), built from facts checked here: paths resolved here and
// shell-quoted, versions read from manifests, the macro id against its
// alphabet, fixed templates. Display only: the driver never runs one.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { sameDirectory, worktreeHoldingBranch } from '../../../scripts/lib/state-root.mjs';
import { isPlainBranch, macroInDefaultRoot, shellQuote } from '../../../scripts/lib/worktree-proposal.mjs';
import { mainWorktreeRoot } from './ledger.mjs';
import { PLUGINS, ROOT_MARKERS, SELF_ROOT } from './roots.mjs';

export const HOME_BRANCH = 'autopilot/home';
const HOME_SLUG = 'autopilot';
const SNAPSHOT_SLUG = 'plugins-snapshot';
const ENV_OF = Object.freeze({ orchestrator: 'AGENTIC_ORCHESTRATOR_ROOT', engineer: 'AGENTIC_ENGINEER_ROOT', runtime: 'AGENTIC_RUNTIME_ROOT' });
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const canonical = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const isWithin = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const gitOut = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};

/**
 * The newest manifest-verified release of each plugin in the Claude Code
 * install cache (`~/.claude/plugins/cache/agentic-plugins/<plugin>/<version>`)
 * that carries the file its resolver checks (roots.mjs ROOT_MARKERS):
 * { [plugin]: { root, version } }, a plugin with none left out. A clean x.y.z
 * version only; a worker loads Claude's install, never Codex's.
 */
export function installedCacheRoots(home = homedir()) {
  const found = {};
  for (const plugin of PLUGINS) {
    const base = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', plugin);
    let names = [];
    try { names = readdirSync(base); } catch { continue; }
    let best = null;
    for (const name of names) {
      const root = join(base, name);
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { continue; }
      const m = SEMVER_RE.exec(String(manifest?.version ?? ''));
      if (manifest?.name !== plugin || !m || manifest.version !== name || !existsSync(join(root, ROOT_MARKERS[plugin]))) continue;
      const v = m.slice(1).map(Number);
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) {
        best = { root: canonical(root), version: manifest.version, v };
      }
    }
    if (best) found[plugin] = { root: best.root, version: best.version };
  }
  return found;
}

// `AGENTIC_..._ROOT=<root> … node <cli> start --execute [--macro <id>] [--lanes N] --repo <dir>`
function startCommand({ pins, macroId, lanes, repo }) {
  const env = PLUGINS.map((p) => `${ENV_OF[p]}=${shellQuote(pins[p])}`).join(' ');
  const cli = join(pins.orchestrator, 'adapters', 'claude', 'autopilot', 'cli.mjs');
  const args = ['start --execute'];
  if (MACRO_ID_RE.test(String(macroId ?? ''))) args.push(`--macro ${macroId}`);
  if (Number.isInteger(lanes) && lanes >= 2) args.push(`--lanes ${lanes}`);
  return `${env} node ${shellQuote(cli)} ${args.join(' ')} --repo ${shellQuote(repo)}`;
}

const pointer = (roots) => `${join(roots?.orchestrator ?? SELF_ROOT, 'README.md')}#the-home-worktree`;

/**
 * The existing home worktree: the worktree git lists at `homePath`, whatever
 * branch it has checked out (a serial run switches the home to each subtask's
 * branch and never back), else the one holding `autopilot/home` wherever it
 * is; null when git lists neither. A listed path whose directory is gone is
 * not one.
 */
function existingHome(main, homePath) {
  const listed = spawnSync('git', ['-C', main, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', timeout: 30_000 });
  if (listed.status === 0) {
    for (const field of (listed.stdout ?? '').split('\0')) {
      if (!field.startsWith('worktree ')) continue;
      const at = field.slice('worktree '.length);
      if (existsSync(at) && sameDirectory(at, homePath)) return canonical(at);
    }
  }
  const holder = worktreeHoldingBranch(main, HOME_BRANCH);
  return holder ? canonical(holder) : null;
}

/**
 * The launch on the main checkout. null when the driven checkout is not the
 * repository's main worktree; else {kind, command, pointer, detail} with
 * command null and a `detail` that says why when no setup can be named.
 */
export function mainCheckoutProposal({ repoRoot, view = null, options = {}, roots = {}, env = process.env, home = homedir() }) {
  const top = canonical(repoRoot);
  const main = canonical(mainWorktreeRoot(top));
  if (top !== main) return null;
  const lanes = Number.isInteger(options.lanes) && options.lanes >= 2 ? options.lanes : 1;
  const why = lanes >= 2
    ? `this is the main checkout, where done and finalize run and work in it halts the run (ADR-0067 Decision 6): launch lanes from a home worktree no one works in`
    : 'this is the main checkout, whose branch a serial run switches at each dispatch: launch from a home worktree no one works in';
  const proposal = { kind: 'worktree', trigger: 'main-checkout', command: null, pointer: pointer(roots), detail: why };
  const macroPath = view?.macro?.path ?? null;
  if (macroPath && !macroInDefaultRoot(top, macroPath)) {
    proposal.detail = `${why}; but the macro ${macroPath} is not in a home of the default state root, so the home worktree would not find it: the state-root cutover (docs/runbooks/state-root-cutover.md) comes first`;
    return proposal;
  }
  // The home worktree, on autopilot/home, finds no macro by its branch: the
  // start command there must name it.
  const macroId = view?.macro?.id ?? options.macro ?? null;
  if (!MACRO_ID_RE.test(String(macroId ?? ''))) {
    proposal.detail = `${why}; but no macro was found here to name, and the home worktree, on ${HOME_BRANCH}, finds none by its branch: name it with --macro <id>`;
    return proposal;
  }
  const cache = installedCacheRoots(home);
  const missing = PLUGINS.filter((p) => !cache[p]);
  if (missing.length > 0) {
    proposal.detail = `${why}; no Claude Code install of ${missing.join(', ')} to pin (install it, then preview again)`;
    return proposal;
  }
  const steps = [];
  let homePath = existingHome(main, resolve(dirname(main), `${basename(main)}-${HOME_SLUG}`));
  if (homePath) {
    proposal.detail = `${why}: the home worktree ${homePath} exists`;
  } else {
    homePath = resolve(dirname(main), `${basename(main)}-${HOME_SLUG}`);
    const git = `git -C ${shellQuote(main)}`;
    if (gitOut(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${HOME_BRANCH}`]) !== null) {
      steps.push(`${git} worktree add ${shellQuote(homePath)} ${HOME_BRANCH}`);
    } else {
      const baseline = view?.macro?.fm?.git_baseline?.branch ?? gitOut(main, ['branch', '--show-current']);
      if (!isPlainBranch(baseline)) {
        proposal.detail = `${why}; the macro's baseline branch ${JSON.stringify(baseline)} is not a plain branch name to start the home worktree from`;
        return proposal;
      }
      const remote = `refs/remotes/origin/${baseline}`;
      const base = gitOut(main, ['rev-parse', '--verify', '--quiet', remote]) !== null ? remote : `refs/heads/${baseline}`;
      if (gitOut(main, ['rev-parse', '--verify', '--quiet', base]) === null) {
        proposal.detail = `${why}; neither ${remote} nor refs/heads/${baseline} exists to start the home worktree from`;
        return proposal;
      }
      steps.push(`${git} worktree add -b ${HOME_BRANCH} ${shellQuote(homePath)} ${base}`);
    }
    if (existsSync(homePath)) proposal.detail = `${why}; ⚠ ${homePath} already exists: remove it, or give git worktree add another path`;
  }
  const pins = Object.fromEntries(PLUGINS.map((p) => [p, cache[p].root]));
  steps.push(startCommand({ pins, macroId, lanes, repo: homePath }));
  proposal.command = steps.join(' && ');
  if (typeof env.AGENTIC_STATE_BASE === 'string' && env.AGENTIC_STATE_BASE !== '') {
    proposal.detail += `; AGENTIC_STATE_BASE is set (${env.AGENTIC_STATE_BASE}): the home worktree accepts only itself, or the default state root once shared creation is on (ADR-0067 Decision 2)`;
  }
  return proposal;
}

/**
 * Plugin roots inside the repository the run drives. null when none is; else
 * {kind, command, pointer, detail, note}: every root pinned to its installed
 * cache release, or, when a root inside the repository has no install, to the
 * same directory in a detached snapshot worktree of the checkout's HEAD; the
 * note says what the pins do not move. `homeNamed`: the main-checkout
 * proposal gave its command, so the note can point at it.
 */
export function rootsInRepoProposal({ repoRoot, roots = {}, options = {}, home = homedir(), homeNamed = false }) {
  const top = canonical(repoRoot);
  const inside = PLUGINS.filter((p) => roots[p] && isWithin(canonical(roots[p]), top));
  if (inside.length === 0) return null;
  const lanes = Number.isInteger(options.lanes) && options.lanes >= 2 ? options.lanes : 1;
  const cache = installedCacheRoots(home);
  const pins = {};
  const steps = [];
  let detail;
  const main = canonical(mainWorktreeRoot(top));
  // The pins move the scripts the runbooks run, not the plugins Claude Code
  // loads; loaded from this checkout, the provenance check halts the first
  // step whatever the pins say (driver.mjs provenanceProblem). The home
  // worktree is named only when the main-checkout proposal gave its command.
  const note = 'these pins move the scripts the runbooks run, not the commands and hooks Claude Code loads: ' +
    'when it loads these plugins from this checkout (a directory marketplace here), the first step still halts, ' +
    `and the run must be driven from another checkout${homeNamed ? ': the home worktree the main-checkout proposal names' : ''}`;
  if (PLUGINS.every((p) => cache[p])) {
    for (const p of PLUGINS) pins[p] = cache[p].root;
    detail = `${inside.join(', ')} ${inside.length === 1 ? 'root is' : 'roots are'} inside the repository this run drives: pin every root to the installed release cache (${PLUGINS.map((p) => `${p} ${cache[p].version}`).join(', ')})`;
  } else {
    const head = gitOut(top, ['rev-parse', 'HEAD']);
    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) {
      return { kind: 'worktree', trigger: 'roots-in-repo', command: null, pointer: pointer(roots), detail: `${inside.join(', ')} inside the repository, and its HEAD cannot be read to snapshot` };
    }
    const snapshot = resolve(dirname(main), `${basename(main)}-${SNAPSHOT_SLUG}`);
    steps.push(`git -C ${shellQuote(top)} worktree add --detach ${shellQuote(snapshot)} ${head}`);
    for (const p of PLUGINS) {
      if (!roots[p]) continue;
      pins[p] = inside.includes(p) ? join(snapshot, relative(top, canonical(roots[p]))) : roots[p];
    }
    detail = `${inside.join(', ')} ${inside.length === 1 ? 'root is' : 'roots are'} inside the repository this run drives, and ${PLUGINS.filter((p) => !cache[p]).join(', ')} has no Claude Code install: pin to a detached snapshot worktree no run drives and no one updates`;
  }
  if (PLUGINS.some((p) => !pins[p])) {
    return { kind: 'worktree', trigger: 'roots-in-repo', command: null, pointer: pointer(roots), detail: `${detail}; but ${PLUGINS.filter((p) => !pins[p]).join(', ')} resolved to no root`, note };
  }
  steps.push(startCommand({ pins, macroId: options.macro ?? null, lanes, repo: top }));
  return { kind: 'worktree', trigger: 'roots-in-repo', command: steps.join(' && '), pointer: pointer(roots), detail, note };
}

/**
 * Both triggers, each judged on its own, in a fixed order; the roots note
 * points at the home worktree only when the main-checkout proposal gave it.
 */
export function launchProposals(a) {
  const onMain = mainCheckoutProposal(a);
  return [rootsInRepoProposal({ ...a, homeNamed: Boolean(onMain?.command) }), onMain].filter(Boolean);
}

/** The JSON report's entries (Decision 8, item 5): {kind, command, pointer}. */
export const reportEntries = (proposals) => proposals.filter((p) => p.command).map(({ kind, command, pointer: at }) => ({ kind, command, pointer: at }));

/** The lines preview and start print for each proposal. */
export function proposalLines(proposals) {
  const lines = [];
  for (const p of proposals) {
    lines.push(`→ Proposed (${p.trigger}): ${p.detail}${p.command ? ':' : '.'}`);
    if (p.command) lines.push(`    ${p.command}`);
    if (p.note) lines.push(`  (${p.note})`);
  }
  return lines;
}
