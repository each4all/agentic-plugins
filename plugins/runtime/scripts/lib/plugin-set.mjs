// plugin-set.mjs — loader + semantic validator for the packaged plugin-set
// definition (machine-bootstrap-contract §1.4, ADR-0046 §3).
//
// `data/plugin-set.json` is the machine-readable source of truth for bundle
// membership, host-qualified dependency edges, per-host hook-bearing metadata,
// and minimum-version floors. It ships INSIDE the runtime plugin package so a
// `runtime:bootstrap` command invoked from an arbitrary consumer repository can
// read it (the `compat.mjs` reading `docs/host-parity-baseline.md` precedent);
// it is resolved from `import.meta.url`, never from `process.cwd()`.
//
// This module owns ONLY the definition + its validation and bundle-closure
// primitives. It does not probe the machine, does not persist, and imports
// nothing host-scoped — the plan/reducer layers (C5) compose it.
//
// The contract's §1.4 example shows a bare `soft_requires: ["<plugin>"]`; §9.1
// gives soft edges a host scope, and this schema follows §9.1 — hard AND soft
// edges share the `{ name, hosts }` shape so a host-specific soft edge is
// expressible and the validator can check both the same way.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const PLUGIN_SET_SCHEMA_VERSION = 'runtime-plugin-set-1.0';

// The five named bundles (§9). `custom` is operator-enumerated via `--plugins`
// and is NOT a fixed membership, so it is not a plugin-set bundle name.
export const BUNDLE_NAMES = Object.freeze(['base', 'engineering', 'business', 'design', 'full']);

// The two hosts the framework targets. Both, always (§8.3 — there is no
// `--hosts` flag).
export const PLUGIN_SET_HOSTS = Object.freeze(['claude', 'codex']);

// `runtime` and `companions` are mandatory in EVERY selection, including custom
// (§6.2). `base` carries both; a bundle that dropped either would define an
// unreachable terminal state (the `deep-peer-smoke` proof needs a companion
// path). Enforced here as a machine-readable invariant, not left to prose.
export const MANDATORY_PLUGINS = Object.freeze(['runtime', 'companions']);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load the packaged plugin-set definition. Resolves `data/plugin-set.json`
 * relative to this module (PLUGIN_ROOT-relative), or under an explicit
 * `pluginRoot` when provided (a consumer command that already resolved its
 * root). Never reads `process.cwd()`.
 */
export async function loadPluginSet({ pluginRoot } = {}) {
  const path = pluginRoot
    ? resolve(pluginRoot, 'data', 'plugin-set.json')
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'plugin-set.json');
  const raw = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`plugin-set.json is not valid JSON at ${path}: ${err.message}`);
  }
  return parsed;
}

/**
 * Semantic validation of a plugin-set object. Returns { ok, errors }.
 * Structural (types, enums, shapes) AND semantic (edge targets known, hosts
 * subset, acyclic hard graph, bundle membership consistent, hard-closure,
 * mandatory membership, `full` = all). A malformed definition is a runtime bug,
 * so callers should treat `ok === false` as fatal.
 */
export function validatePluginSet(pluginSet) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!isPlainObject(pluginSet)) {
    return { ok: false, errors: ['plugin-set is not an object'] };
  }
  if (pluginSet.schema !== PLUGIN_SET_SCHEMA_VERSION) {
    err(`schema must be "${PLUGIN_SET_SCHEMA_VERSION}", got ${JSON.stringify(pluginSet.schema)}`);
  }
  const cm = pluginSet.canonical_marketplace;
  if (!isPlainObject(cm) || cm.source !== 'github' || cm.repo !== 'each4all/agentic-plugins') {
    err('canonical_marketplace must be { source: "github", repo: "each4all/agentic-plugins" }');
  }
  if (!isPlainObject(pluginSet.plugins) || Object.keys(pluginSet.plugins).length === 0) {
    return { ok: false, errors: [...errors, 'plugins must be a non-empty object'] };
  }

  const names = Object.keys(pluginSet.plugins);
  const nameSet = new Set(names);

  // Per-plugin structural + edge checks.
  for (const [name, p] of Object.entries(pluginSet.plugins)) {
    if (!isPlainObject(p)) { err(`plugins.${name} is not an object`); continue; }

    // bundles
    if (!Array.isArray(p.bundles) || p.bundles.some((b) => !BUNDLE_NAMES.includes(b))) {
      err(`plugins.${name}.bundles must be a subset of ${JSON.stringify(BUNDLE_NAMES)}`);
    } else if (new Set(p.bundles).size !== p.bundles.length) {
      err(`plugins.${name}.bundles has duplicates`);
    }

    // hosts
    const hosts = p.hosts;
    if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((h) => !PLUGIN_SET_HOSTS.includes(h)) || new Set(hosts).size !== hosts.length) {
      err(`plugins.${name}.hosts must be a non-empty unique subset of ${JSON.stringify(PLUGIN_SET_HOSTS)}`);
    }
    const hostSet = new Set(Array.isArray(hosts) ? hosts : []);

    // edges — hard AND soft share { name, hosts }
    for (const kind of ['hard_requires', 'soft_requires']) {
      const edges = p[kind];
      if (!Array.isArray(edges)) { err(`plugins.${name}.${kind} must be an array`); continue; }
      for (const e of edges) {
        if (!isPlainObject(e) || typeof e.name !== 'string' || !Array.isArray(e.hosts)) {
          err(`plugins.${name}.${kind} entry must be { name, hosts }`); continue;
        }
        if (e.name === name) err(`plugins.${name}.${kind} references itself`);
        if (!nameSet.has(e.name)) err(`plugins.${name}.${kind} names unknown plugin "${e.name}"`);
        if (e.hosts.length === 0 || e.hosts.some((h) => !PLUGIN_SET_HOSTS.includes(h))) {
          err(`plugins.${name}.${kind} entry "${e.name}" has invalid hosts ${JSON.stringify(e.hosts)}`);
        }
        // An edge may only require on a host this plugin actually targets — a
        // dependency "on Codex" is meaningless if the plugin does not run there.
        for (const h of e.hosts) {
          if (!hostSet.has(h)) err(`plugins.${name}.${kind} entry "${e.name}" requires on host "${h}" that ${name} does not target`);
        }
      }
    }

    // hook_bearing
    const hb = p.hook_bearing;
    if (!isPlainObject(hb) || typeof hb.claude !== 'boolean' || typeof hb.codex !== 'boolean') {
      err(`plugins.${name}.hook_bearing must be { claude: bool, codex: bool }`);
    }

    // minimum_version
    if (p.minimum_version !== null && !(typeof p.minimum_version === 'string' && SEMVER_RE.test(p.minimum_version))) {
      err(`plugins.${name}.minimum_version must be null or a semver string, got ${JSON.stringify(p.minimum_version)}`);
    }
  }

  // Hard-edge acyclicity (a cycle would make hard-closure non-terminating).
  const cycle = findHardCycle(pluginSet.plugins);
  if (cycle) err(`hard_requires graph has a cycle: ${cycle.join(' -> ')}`);

  // Bundle membership consistency.
  for (const bundle of BUNDLE_NAMES) {
    const members = names.filter((n) => (pluginSet.plugins[n].bundles ?? []).includes(bundle));
    if (members.length === 0) err(`bundle "${bundle}" has no members`);
    // Mandatory plugins in every bundle.
    for (const m of MANDATORY_PLUGINS) {
      if (!members.includes(m)) err(`bundle "${bundle}" is missing mandatory plugin "${m}"`);
    }
    // Hard-closure: every hard edge of a member, on a host the member targets,
    // must land inside the same bundle.
    const memberSet = new Set(members);
    for (const m of members) {
      const p = pluginSet.plugins[m];
      const hostSet = new Set(p.hosts ?? []);
      for (const e of p.hard_requires ?? []) {
        const relevant = (e.hosts ?? []).some((h) => hostSet.has(h));
        if (relevant && !memberSet.has(e.name)) {
          err(`bundle "${bundle}" violates hard closure: "${m}" requires "${e.name}" but it is absent`);
        }
      }
    }
  }

  // `full` = every plugin; `base` is a subset of every other named bundle
  // (each higher bundle is "base + extras", §9).
  const fullMembers = names.filter((n) => (pluginSet.plugins[n].bundles ?? []).includes('full'));
  if (new Set(fullMembers).size !== nameSet.size) {
    err(`bundle "full" must contain every plugin (${names.length}); got ${fullMembers.length}`);
  }
  const baseMembers = new Set(names.filter((n) => (pluginSet.plugins[n].bundles ?? []).includes('base')));
  for (const bundle of ['engineering', 'business', 'design', 'full']) {
    for (const b of baseMembers) {
      if (!(pluginSet.plugins[b].bundles ?? []).includes(bundle)) {
        err(`base plugin "${b}" must also be in bundle "${bundle}" (each bundle is base + extras)`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// DFS cycle detection over the union hard-edge graph (host-agnostic — a cycle on
// any host is a cycle). Returns the offending path or null.
function findHardCycle(plugins) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(Object.keys(plugins).map((n) => [n, WHITE]));
  const stack = [];
  let found = null;

  const visit = (n) => {
    if (found) return;
    color.set(n, GRAY);
    stack.push(n);
    for (const e of plugins[n]?.hard_requires ?? []) {
      if (!color.has(e.name)) continue; // unknown target already flagged elsewhere
      if (color.get(e.name) === GRAY) {
        const from = stack.indexOf(e.name);
        found = [...stack.slice(from), e.name];
        return;
      }
      if (color.get(e.name) === WHITE) visit(e.name);
      if (found) return;
    }
    stack.pop();
    color.set(n, BLACK);
  };

  for (const n of Object.keys(plugins)) {
    if (color.get(n) === WHITE) visit(n);
    if (found) break;
  }
  return found;
}

/**
 * Resolve a NAMED bundle to its sorted member list. Throws for `custom` (which
 * is operator-enumerated, not a fixed membership) and for an unknown name.
 */
export function resolveBundle(pluginSet, bundleName) {
  if (!BUNDLE_NAMES.includes(bundleName)) {
    throw new Error(`unknown bundle "${bundleName}" (named bundles: ${BUNDLE_NAMES.join(', ')})`);
  }
  return Object.keys(pluginSet.plugins)
    .filter((n) => (pluginSet.plugins[n].bundles ?? []).includes(bundleName))
    .sort();
}

/**
 * Compute the hard-closure violations of an explicit selection (the `custom`
 * case, §9.1): every hard edge of a selected plugin, on a host the plugin
 * targets, whose target is NOT selected. Returns [] when closed. The reducer
 * (C5) re-runs this on decline; this primitive lives with the plugin-set.
 */
export function hardClosureViolations(pluginSet, selectedNames) {
  const selected = new Set(selectedNames);
  const violations = [];
  for (const name of selectedNames) {
    const p = pluginSet.plugins[name];
    if (!p) { violations.push({ plugin: name, requires: null, host: null, reason: 'unknown-plugin' }); continue; }
    const hostSet = new Set(p.hosts ?? []);
    for (const e of p.hard_requires ?? []) {
      for (const h of e.hosts ?? []) {
        if (hostSet.has(h) && !selected.has(e.name)) {
          violations.push({ plugin: name, requires: e.name, host: h, reason: 'hard-edge-unsatisfied' });
        }
      }
    }
  }
  return violations;
}

/**
 * The set of plugins REACHED BY A HARD EDGE from a retained plugin — transitively
 * (§6.2: "any plugin reached by a hard edge from a retained plugin" is never
 * declinable).
 *
 * Derived from the validated plugin-set, never accepted from a caller. Taking it as
 * an argument is the same forgery the registry-authority rule bans one level up: a
 * caller that simply forgot to compute it would be offering an ILLEGAL DECLINE —
 * `engineering` retains `orchestrator`, which hard-requires `engineer`, so an
 * un-derived set marks `engineer` declinable and the operator is invited to break
 * their own selection.
 *
 * Transitive because a hard edge's target has hard edges of its own; a one-hop walk
 * would protect the first rank and abandon the second. Cycle-safe by construction
 * (`seen`), though validatePluginSet already rejects a cyclic hard graph.
 */
export function hardRequiredClosure(pluginSet, retainedNames) {
  const required = new Set();
  const walk = (name) => {
    const p = pluginSet.plugins?.[name];
    if (!p) return;
    for (const edge of p.hard_requires ?? []) {
      if (required.has(edge.name)) continue;
      required.add(edge.name);
      walk(edge.name);
    }
  };
  for (const name of retainedNames) walk(name);
  return required;
}

/**
 * The Codex-hook-bearing members of a name list, sorted — the ONE implementation
 * of a predicate that had been written out four independent times (the step
 * registry's Stage-7 applicability, the reducer's attestation expectation, and
 * bootstrap's hook verdict and resume-time import gate).
 *
 * Four copies of one rule is four chances for a fix to land in three places. The
 * effective-selection work is exactly such a fix: every copy had to start reading
 * the RETAINED set instead of the planned one, and a copy left behind would have
 * kept demanding an attestation cover a plugin the operator refused — the same
 * unsatisfiable non-declinable step, surviving its own repair.
 *
 * Keyed on the CODEX value only: Claude trusts plugin hooks by install and exposes
 * no /hooks review flow (§6.1), so `hook_bearing.claude` is not this question.
 */
export function codexHookBearingPlugins(pluginSet, names) {
  return [...new Set(names ?? [])]
    .filter((name) => pluginSet?.plugins?.[name]?.hook_bearing?.codex === true)
    .sort();
}

/**
 * Mechanical authority equality — the plugin-set's plugin names and canonical
 * marketplace MUST equal the probe's PLUGIN_NAMES + CANONICAL_MARKETPLACE, so a
 * third silent authority cannot drift (Codex Plan-verify finding). Returns
 * { ok, errors }.
 */
export function assertPluginSetAuthority(pluginSet, { pluginNames, canonicalMarketplace }) {
  const errors = [];
  const setNames = new Set(Object.keys(pluginSet.plugins ?? {}));
  const authNames = new Set(pluginNames ?? []);
  const missing = [...authNames].filter((n) => !setNames.has(n));
  const extra = [...setNames].filter((n) => !authNames.has(n));
  if (missing.length) errors.push(`plugin-set is missing authority plugins: ${missing.join(', ')}`);
  if (extra.length) errors.push(`plugin-set has plugins absent from PLUGIN_NAMES: ${extra.join(', ')}`);
  const cm = pluginSet.canonical_marketplace ?? {};
  if (!canonicalMarketplace || cm.source !== canonicalMarketplace.source || cm.repo !== canonicalMarketplace.repo) {
    errors.push('plugin-set canonical_marketplace does not equal the probe CANONICAL_MARKETPLACE');
  }
  return { ok: errors.length === 0, errors };
}
