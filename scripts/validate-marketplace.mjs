#!/usr/bin/env node
// Validates both marketplace catalogs are well-formed and stay consistent
// across the two host-specific schemas. Run via `npm run validate:marketplace`
// or directly with `node scripts/validate-marketplace.mjs`.
//
// What this checks:
//   - both catalog files parse as JSON
//   - cross-catalog top-level `name` and `description` match (single source
//     of truth — the two catalogs surface the same project under each host's
//     marketplace conventions)
//   - per-entry: each plugin name is unique within its catalog
//   - per-entry: the same plugin-name set appears in both catalogs, except
//     that after activation a package with no release tag yet has no Codex
//     entry (ADR-0061 Decision 2); the exemption ends at its first release
//   - per-entry (Claude): `source` is the package directory
//     `plugins/<entry.name>`, whose `.claude-plugin/plugin.json` exists and
//     parses, with `name` matching the marketplace entry's `name` AND with
//     `version` matching the entry's `version` when both are present
//   - per-entry (Codex): the package's `.codex-plugin/plugin.json` parses and
//     its `name` matches the entry. A `local` entry's `source.path` must be
//     that same directory; a pinned entry must satisfy ADR-0061
//     Decision 1's shape and Decision 2's history checks (its tag resolves and
//     peels to `sha`, and the tree at `sha` carries the package at the `ref`
//     version), and its version must equal the package manifest's. A pinned
//     package must be a release-please package (release-please-config.json)
//     that tags as `plugin-<name>`
//   - the Codex catalog's phase (ADR-0061 Decision 2), read from the
//     `activated` marker in scripts/data/codex-pin-floors.json: all-local
//     before activation, all-pinned after; a mix is invalid in either phase,
//     and so is a marker without pins
//   - the migration floors (Decision 5 (a)): each names a plugins/* package;
//     a released floor is a real release of it, and after activation every
//     floor must be released; no pin is ever below its package's floor. A
//     published package's .codex-plugin/plugin.json declares
//     interface.category, which a first pin copies. Before
//     activation an unreleased floor, or a released package without one, is a
//     warning: the catalog simply stays local until the writer's gate is met
//   - with --base <rev> — the catalog on the target branch before the change —
//     no pin moves to a lower version, an unchanged version keeps its sha, a
//     published package's pin is never dropped or reverted to local, the
//     activated marker never goes back to false, a floor is never removed or
//     lowered while its package exists, and the activating change pins no
//     package without a floor. S4's writer validates its own write this way,
//     with --base HEAD before it commits. A baseline that cannot be read is
//     reported and not compared, so it cannot block the change that repairs it
//
// Release-please PRs may pass --allow-version-lag because package manifests
// are bumped before either catalog is synced after the release merge. The lag
// lets a valid pin trail the package version; it never excuses a malformed or
// mismatched pin, and never a pin ahead of the package.
//
// History is required, not optional. The floors and every pin are claims
// about tags and trees, so a shallow clone or a checkout without tags fails
// with the reason rather than passing on structure alone.
//
// What this does NOT check:
//   - schema-by-host beyond the shared minimal subset (each host validates
//     its own marketplace.json independently)
//   - the `$schema` URL in the Claude catalog (Claude's own tooling does this)
//   - that a pin names the NEWEST release (validate:versions compares pins
//     with .release-please-manifest.json)

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CODEX_CATALOG_PATH,
  FLOORS_PATH,
  checkPinShape,
  checkRelease,
  compareSemver,
  hasReleaseTag,
  historyAvailability,
  isSemver,
  parseFloors,
  readAt,
  releaseTag,
  resolveCommit,
  sourceKind,
} from './lib/codex-catalog-pins.mjs';

const CLAUDE_PATH = '.claude-plugin/marketplace.json';
const CODEX_PATH = CODEX_CATALOG_PATH;
// The package registry: AGENTS.md defines a package as a key of this file's
// `packages`, not as a line in .release-please-manifest.json, which is only
// the version ledger and can outlive a package's removal.
const CONFIG_PATH = 'release-please-config.json';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dirExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validate both catalogs rooted at `repoRoot`.
 *
 * @param {string} repoRoot
 * @param {{allowVersionLag?: boolean, base?: string|null}} [options]
 * @returns {{errors: string[], warnings: string[], phase: string|null,
 *   coverage: {structural: boolean, history: boolean, baseline: string|null},
 *   claude: object|null}}
 */
export function validateMarketplace(repoRoot, { allowVersionLag = false, base = null } = {}) {
  const errors = [];
  const warnings = [];
  const coverage = { structural: true, history: false, baseline: null };
  const result = () => ({ errors, warnings, phase, coverage, claude });
  let phase = null;
  let claude = null;

  function loadJSON(relPath, label = relPath) {
    let value;
    try {
      value = JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return null;
    }
    if (!isObject(value)) {
      errors.push(`${label}: must be a JSON object`);
      return null;
    }
    return value;
  }

  claude = loadJSON(CLAUDE_PATH);
  const codex = loadJSON(CODEX_PATH);
  if (!claude || !codex) return result();

  if (typeof claude.name !== 'string') errors.push(`${CLAUDE_PATH}: name must be string`);
  if (typeof codex.name !== 'string') errors.push(`${CODEX_PATH}: name must be string`);
  if (typeof claude.name === 'string' && typeof codex.name === 'string' && claude.name !== codex.name) {
    errors.push(`name mismatch — claude="${claude.name}" vs codex="${codex.name}"`);
  }

  if (typeof claude.description !== 'string') errors.push(`${CLAUDE_PATH}: description must be string`);
  if (typeof codex.description !== 'string') errors.push(`${CODEX_PATH}: description must be string`);
  if (typeof claude.description === 'string' && typeof codex.description === 'string' && claude.description !== codex.description) {
    errors.push(`description mismatch — claude="${claude.description}" vs codex="${codex.description}"`);
  }

  if (!Array.isArray(claude.plugins)) errors.push(`${CLAUDE_PATH}: plugins must be array`);
  if (!Array.isArray(codex.plugins)) errors.push(`${CODEX_PATH}: plugins must be array`);
  if (!Array.isArray(claude.plugins) || !Array.isArray(codex.plugins)) return result();

  const config = loadJSON(CONFIG_PATH);
  const releasePackages = new Set();
  if (config && !isObject(config.packages)) errors.push(`${CONFIG_PATH}: packages must be an object`);
  for (const [key, pkg] of Object.entries(isObject(config?.packages) ? config.packages : {})) {
    if (!key.startsWith('plugins/')) continue;
    const name = key.slice('plugins/'.length);
    releasePackages.add(name);
    if (pkg?.component !== `plugin-${name}`) {
      errors.push(
        `${CONFIG_PATH}: ${key} must tag as plugin-${name} (its component), got ${JSON.stringify(pkg?.component)} — `
          + 'a pin\'s ref is plugin-<name>-v<version>',
      );
    }
  }

  let floorsText = null;
  try {
    floorsText = readFileSync(resolve(repoRoot, FLOORS_PATH), 'utf8');
  } catch (err) {
    errors.push(`${FLOORS_PATH}: ${err.message}`);
  }
  const floorsParsed = floorsText === null ? { data: null, errors: [] } : parseFloors(floorsText);
  for (const e of floorsParsed.errors) errors.push(`${FLOORS_PATH}: ${e}`);
  const floorData = floorsParsed.data;
  const activated = floorData ? floorData.activated : null;
  if (activated !== null) phase = activated ? 'activated' : 'pre-activation';

  const history = historyAvailability(repoRoot);
  coverage.history = history.ok;
  if (!history.ok) {
    errors.push(
      `history checks could not run: ${history.reason} — ADR-0061 Decision 2 fails closed here `
        + 'rather than reporting a structural-only pass',
    );
  }

  const claudeNames = new Set();
  const codexNames = new Set();

  // Per-entry Claude validation
  for (const [i, entry] of claude.plugins.entries()) {
    if (typeof entry?.name !== 'string') {
      errors.push(`${CLAUDE_PATH}.plugins[${i}]: name must be string`);
      continue;
    }
    if (claudeNames.has(entry.name)) {
      errors.push(`${CLAUDE_PATH}: duplicate plugin name "${entry.name}"`);
    }
    claudeNames.add(entry.name);

    const pluginDir = resolve(repoRoot, 'plugins', entry.name);
    if (typeof entry.source !== 'string' || resolve(repoRoot, entry.source) !== pluginDir) {
      errors.push(
        `${CLAUDE_PATH}.plugins[${i}] (${entry.name}): source ${JSON.stringify(entry.source)} is not the package `
          + `directory plugins/${entry.name}`,
      );
    }
    if (!dirExists(pluginDir)) {
      errors.push(`${CLAUDE_PATH}.plugins[${i}] (${entry.name}): plugins/${entry.name}/ directory missing`);
      continue;
    }
    const manifestPath = resolve(pluginDir, '.claude-plugin/plugin.json');
    const manifest = loadJSON(manifestPath, `${CLAUDE_PATH}.plugins[${i}] (${entry.name}): .claude-plugin/plugin.json`);
    if (manifest && manifest.name !== entry.name) {
      errors.push(`${CLAUDE_PATH}.plugins[${i}]: catalog name "${entry.name}" != manifest name "${manifest.name}"`);
    }
    if (manifest && typeof entry.version === 'string' && typeof manifest.version === 'string' && manifest.version !== entry.version) {
      const message = `${CLAUDE_PATH}.plugins[${i}] (${entry.name}): catalog version "${entry.version}" != manifest version "${manifest.version}"`;
      if (allowVersionLag) {
        warnings.push(`${message} (allowed release-please PR lag)`);
      } else {
        errors.push(message);
      }
    }
  }

  // A package's first Codex pin takes its category from the released
  // .codex-plugin/plugin.json (ADR-0061 S4's writer). Requiring it here, for
  // every published package, catches a missing one before that first release
  // rather than after it, when only a further release could fix it.
  for (const name of claudeNames) {
    if (!releasePackages.has(name)) continue;
    const manifestPath = resolve(repoRoot, 'plugins', name, '.codex-plugin/plugin.json');
    let codexManifest;
    try {
      codexManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue; // reported with the entry that names it
    }
    if (typeof codexManifest?.interface?.category !== 'string') {
      errors.push(`plugins/${name}/.codex-plugin/plugin.json: interface.category must be a string — a first Codex pin takes its category from it`);
    }
  }

  // Per-entry Codex validation
  const locals = [];
  const pins = new Map(); // name -> { version, sha }
  for (const [i, entry] of codex.plugins.entries()) {
    if (typeof entry?.name !== 'string') {
      errors.push(`${CODEX_PATH}.plugins[${i}]: name must be string`);
      continue;
    }
    const at = `${CODEX_PATH}.plugins[${i}] (${entry.name})`;
    if (codexNames.has(entry.name)) {
      errors.push(`${CODEX_PATH}: duplicate plugin name "${entry.name}"`);
    }
    codexNames.add(entry.name);

    const kind = sourceKind(entry);
    if (kind === 'invalid') {
      errors.push(`${at}: source.source must be "local" or "git-subdir", got ${JSON.stringify(entry?.source?.source)}`);
      continue;
    }

    let pluginDir;
    if (kind === 'local') {
      locals.push(entry.name);
      const sourcePath = entry.source.path;
      if (typeof sourcePath !== 'string') {
        errors.push(`${at}: source.path must be string`);
        continue;
      }
      pluginDir = resolve(repoRoot, sourcePath);
      if (pluginDir !== resolve(repoRoot, 'plugins', entry.name)) {
        errors.push(`${at}: source.path "${sourcePath}" is not the package directory plugins/${entry.name}`);
        continue;
      }
      if (!dirExists(pluginDir)) {
        errors.push(`${at}: source.path "${sourcePath}" not a directory`);
        continue;
      }
    } else {
      pluginDir = resolve(repoRoot, 'plugins', entry.name);
    }
    const manifest = loadJSON(resolve(pluginDir, '.codex-plugin/plugin.json'), `${at}: .codex-plugin/plugin.json`);
    if (manifest && manifest.name !== entry.name) {
      errors.push(`${at}: catalog name "${entry.name}" != manifest name "${manifest.name}"`);
    }
    if (kind === 'local') continue;

    const shape = checkPinShape(entry);
    for (const e of shape.errors) errors.push(`${at}: ${e}`);
    if (!releasePackages.has(entry.name)) {
      errors.push(`${at}: pinned, but plugins/${entry.name} is not a release-please package`);
    }
    if (shape.version === null) continue;
    pins.set(entry.name, { version: shape.version, sha: entry.source.sha });

    if (manifest && typeof manifest.version === 'string') {
      const delta = compareSemver(shape.version, manifest.version);
      const message = `${at}: pinned version ${shape.version} != package version ${manifest.version}`;
      if (delta > 0) {
        errors.push(`${at}: pinned version ${shape.version} is ahead of package version ${manifest.version}`);
      } else if (delta < 0) {
        if (allowVersionLag) warnings.push(`${message} (allowed release-please PR lag)`);
        else errors.push(message);
      }
    }
    const floor = floorData?.floors[entry.name];
    if (floor !== undefined && compareSemver(shape.version, floor) < 0) {
      errors.push(`${at}: pinned version ${shape.version} is below its migration floor ${floor}`);
    }
    if (history.ok && typeof entry.source.sha === 'string') {
      for (const e of checkRelease(repoRoot, { name: entry.name, version: shape.version, sha: entry.source.sha })) {
        errors.push(`${at}: ${e}`);
      }
    }
  }

  // Phase — ADR-0061 Decision 2
  const pinnedAny = codex.plugins.some((e) => sourceKind(e) === 'pinned');
  if (locals.length > 0 && pinnedAny) {
    const pinnedNames = codex.plugins.filter((e) => sourceKind(e) === 'pinned').map((e) => e.name);
    errors.push(
      `${CODEX_PATH}: mixes local (${locals.join(', ')}) and pinned (${pinnedNames.join(', ')}) entries — `
        + 'the catalog is all-local before activation and all-pinned after',
    );
  }
  if (activated === false && pinnedAny) {
    errors.push(
      `${CODEX_PATH}: entries are pinned before activation (${FLOORS_PATH} activated is false) — `
        + 'the writer sets the marker in the same commit as the first pins',
    );
  }
  if (activated === true && !pinnedAny) {
    errors.push(`${FLOORS_PATH} says activated, but no entry is pinned — the marker and the first pins land together`);
  }

  // Migration floors — ADR-0061 Decision 5 (a)
  if (floorData) {
    for (const [name, floor] of Object.entries(floorData.floors)) {
      if (!releasePackages.has(name)) {
        errors.push(`${FLOORS_PATH}: floor for "${name}" names no plugins/* release-please package`);
        continue;
      }
      if (!history.ok) continue;
      const tag = releaseTag(name, floor);
      if (resolveCommit(repoRoot, `refs/tags/${tag}`) === null) {
        // Before activation a floor may be declared ahead of its release:
        // Decision 5 (a) keeps the catalog local until every floor is met.
        if (floorData.activated) errors.push(`${FLOORS_PATH}: floor ${name}@${floor}: tag ${tag} does not resolve — after activation every floor is a release`);
        else warnings.push(`${FLOORS_PATH}: floor ${name}@${floor} is not a release yet (no ${tag}); the writer refuses to activate until it is — correct the floor if that version will never be tagged`);
        continue;
      }
      for (const e of checkRelease(repoRoot, { name, version: floor })) errors.push(`${FLOORS_PATH}: floor ${name}@${floor}: ${e}`);
    }
    if (!floorData.activated && history.ok) {
      for (const name of releasePackages) {
        if (!(name in floorData.floors) && hasReleaseTag(repoRoot, name)) {
          warnings.push(`${FLOORS_PATH}: ${name} is released but has no migration floor; activation will need one`);
        }
      }
    }
  }

  // Cross-catalog name-set match. After activation a package with no release
  // tag yet has no Codex entry until the post-tag writer adds its first pin;
  // the exemption needs history to decide, and ends at the first release.
  if (claudeNames.size === claude.plugins.length && codexNames.size === codex.plugins.length) {
    const onlyInClaude = [];
    for (const name of claudeNames) {
      if (codexNames.has(name)) continue;
      if (activated === true && history.ok && !hasReleaseTag(repoRoot, name)) {
        warnings.push(`${name} has no Codex entry until its first release is pinned (no plugin-${name}-v* tag yet)`);
      } else {
        onlyInClaude.push(name);
      }
    }
    const onlyInCodex = [...codexNames].filter((n) => !claudeNames.has(n));
    if (onlyInClaude.length > 0) {
      errors.push(`plugins only in ${CLAUDE_PATH}: ${onlyInClaude.join(', ')}`);
    }
    if (onlyInCodex.length > 0) {
      errors.push(`plugins only in ${CODEX_PATH}: ${onlyInCodex.join(', ')}`);
    }
  }

  // Monotonic pin against the target-branch baseline
  if (base !== null) {
    const baseCommit = resolveCommit(repoRoot, base);
    if (baseCommit === null) {
      errors.push(`baseline ${base} does not resolve to a commit (fetch-depth: 0 required for --base)`);
    } else {
      const compared = compareWithBaseline(repoRoot, baseCommit, {
        codex, activated, pins, floorData, releasePackages, claudeNames,
      });
      errors.push(...compared.errors);
      warnings.push(...compared.warnings);
      if (compared.ran) coverage.baseline = baseCommit;
    }
  }

  return result();
}

/** A baseline file as an object, `null` when absent, or `{ error }` when unreadable. */
function readBaselineObject(repoRoot, commit, path) {
  const text = readAt(repoRoot, commit, path);
  if (text === null) return { value: null };
  try {
    const value = JSON.parse(text);
    return isObject(value) ? { value } : { error: 'is not a JSON object' };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * ADR-0061 Decision 2's monotonic pin, and Decision 5 (a)'s one-way
 * activation. The baseline is the catalog on the target branch before the
 * change. A `local` or absent baseline entry imposes no bound (first
 * activation, or a first pin); a pinned one bounds the head entry from below
 * and fixes its sha while the version is unchanged.
 */
function compareWithBaseline(repoRoot, baseCommit, { codex, activated, pins, floorData, releasePackages, claudeNames }) {
  const errors = [];
  const warnings = [];
  const label = `baseline ${baseCommit.slice(0, 7)}`;
  const baseCatalog = readBaselineObject(repoRoot, baseCommit, CODEX_PATH);
  const baseFloorFile = readBaselineObject(repoRoot, baseCommit, FLOORS_PATH);
  // An unreadable baseline is a defect already on the target branch, not in
  // this change, and refusing here would block the change that repairs it. It
  // is reported, and the result states that no baseline was compared.
  const unreadable = [[CODEX_PATH, baseCatalog], [FLOORS_PATH, baseFloorFile]].filter(([, r]) => r.error);
  if (unreadable.length > 0) {
    for (const [path, r] of unreadable) warnings.push(`${label}: ${path} ${r.error} — the baseline was not compared`);
    return { errors, warnings, ran: false };
  }
  const baseActivated = baseFloorFile.value?.activated === true;
  const baseFloors = isObject(baseFloorFile.value?.floors) ? baseFloorFile.value.floors : {};
  const basePlugins = Array.isArray(baseCatalog.value?.plugins) ? baseCatalog.value.plugins : [];

  if (baseActivated && activated !== true) {
    errors.push(`${FLOORS_PATH}: activated at the ${label} but not here — activation is one-way`);
  }

  // A floor stays while its package exists and never drops, so the activating
  // change cannot shed the floors it was gated on; and that change pins no
  // package without one. After activation a new package needs no floor: it
  // has no pre-migration release to guard against.
  if (floorData) {
    for (const [name, was] of Object.entries(baseFloors)) {
      if (!releasePackages.has(name) || !isSemver(was)) continue;
      const now = floorData.floors[name];
      if (now === undefined) {
        errors.push(`${FLOORS_PATH}: floor for ${name} removed against the ${label} — a floor stays while its package exists`);
      } else if (compareSemver(now, was) < 0) {
        errors.push(`${FLOORS_PATH}: floor for ${name} lowered from ${was} to ${now} against the ${label}`);
      }
    }
    if (!baseActivated && activated === true) {
      for (const entry of codex.plugins) {
        if (sourceKind(entry) !== 'pinned' || typeof entry.name !== 'string' || entry.name in floorData.floors) continue;
        errors.push(`${CODEX_PATH} (${entry.name}): the activating change pins ${entry.name} without a migration floor`);
      }
    }
  }

  const head = new Map(codex.plugins.filter((e) => typeof e?.name === 'string').map((e) => [e.name, e]));
  for (const baseEntry of basePlugins) {
    if (sourceKind(baseEntry) !== 'pinned' || typeof baseEntry.name !== 'string') continue;
    const name = baseEntry.name;
    const headEntry = head.get(name);
    if (baseActivated && headEntry === undefined && claudeNames.has(name)) {
      // Without this, a checkout missing the package's tags would re-open the
      // untagged exemption for a package that was already released.
      errors.push(`${CODEX_PATH} (${name}): pin dropped against the ${label} while the package is still published`);
      continue;
    }
    if (baseActivated && headEntry && sourceKind(headEntry) === 'local') {
      errors.push(`${CODEX_PATH} (${name}): reverted from a pin to local against the ${label}`);
      continue;
    }
    const was = checkPinShape(baseEntry).version;
    const now = pins.get(name);
    if (!now || was === null) continue;
    const delta = compareSemver(now.version, was);
    if (delta < 0) {
      errors.push(`${CODEX_PATH} (${name}): pin moves from ${was} to ${now.version} — a pin never moves to a lower version`);
    } else if (delta === 0 && now.sha !== baseEntry.source.sha) {
      errors.push(
        `${CODEX_PATH} (${name}): version ${was} re-pinned from ${String(baseEntry.source.sha).slice(0, 7)} `
          + `to ${String(now.sha).slice(0, 7)} — an unchanged version keeps its sha`,
      );
    }
  }
  return { errors, warnings, ran: true };
}

// CLI entry. Both sides are realpath'd: Node resolves the main module through
// symlinks before building import.meta.url, so comparing it with argv[1] as
// spelled makes a linked invocation exit 0 having done nothing.
function invokedAsCLI() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCLI()) {
  let values;
  try {
    ({ values } = parseArgs({
      options: { 'allow-version-lag': { type: 'boolean' }, base: { type: 'string' } },
      strict: true,
    }));
  } catch (err) {
    console.error(`validate-marketplace: ${err.message}`);
    console.error('usage: validate-marketplace.mjs [--allow-version-lag] [--base <rev>]');
    process.exit(2);
  }
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const { errors, warnings, phase, coverage, claude } = validateMarketplace(REPO_ROOT, {
    allowVersionLag: values['allow-version-lag'] === true,
    base: values.base ?? null,
  });

  if (errors.length > 0) {
    console.error('Marketplace validation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const checks = ['structural', 'history'];
  if (coverage.baseline) checks.push(`baseline ${coverage.baseline.slice(0, 7)}`);
  console.log(`OK — ${claude.plugins.length} plugin(s) in the Claude catalog, Codex catalog consistent`);
  console.log(`  phase:       ${phase}${phase === 'activated' ? ' (every Codex entry pinned)' : ' (every Codex entry local)'}`);
  console.log(`  checks:      ${checks.join(', ')}${coverage.baseline ? '' : '; baseline not compared (pass --base <rev>)'}`);
  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  console.log(`  name:        ${claude.name}`);
  console.log(`  description: ${claude.description}`);
  if (claude.plugins.length > 0) {
    console.log(`  plugins:     ${claude.plugins.map((p) => p.name).join(', ')}`);
  }
}
