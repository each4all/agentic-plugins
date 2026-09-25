#!/usr/bin/env node
// Syncs both marketplace catalogs to .release-please-manifest.json after a
// release, then validates what it wrote. Idempotent — safe to run any number
// of times; exit 0 with no changes when already in sync.
//
// Why: release-please's per-package extra-files mechanism cannot safely
// own the root marketplace.json without inadvertently coupling all
// plugin packages to commits that touch the root catalog (e.g., a
// chore commit that removes one plugin's entry would otherwise version-
// bump every other plugin via the shared extra-file). The trade-off
// chosen in this repo: release-please owns each plugin's per-package
// manifests (.claude-plugin/plugin.json + .codex-plugin/plugin.json),
// and this script syncs the root catalogs separately, post-release.
//
// Source of truth: .release-please-manifest.json
// Targets:
//   - .claude-plugin/marketplace.json $.plugins[?(name)].version
//   - .agents/plugins/marketplace.json $.plugins[?(name)].source — the
//     ADR-0061 release pin, once the Codex catalog is activated
//
// The Codex catalog, by phase (ADR-0061 Decisions 1, 2, 5 (a) and 7; the
// phase is the `activated` marker in scripts/data/codex-pin-floors.json):
//   - Before activation it is left exactly as it is. An ordinary release or a
//     repair run never touches it, so merging this writer pins nothing.
//   - --activate is the owner's explicit intent (release-please.yml's
//     workflow_dispatch input). It pins EVERY entry to its release commit and
//     sets the marker in the same write — but only when every entry's package
//     is released at its manifest version and that version meets the
//     package's migration floor. Otherwise it writes nothing at all and
//     exits 1: the catalog stays local.
//   - After activation every published package's pin follows the manifest.
//     A pin never moves to a lower version, never changes its sha for the same
//     version, and never goes back to local; each of those is an error, and
//     the rollback path is a forward release (Decision 7). A package whose
//     first release has been tagged gets its first pin; one with no tag yet
//     gets no entry (Decision 2's untagged exemption). A local entry found
//     after activation is refused, unless --activate is given, which pins it
//     forward: the owner's intent covers repairing a hand-made revert.
//
// Everything is planned before anything is written. Any error writes nothing,
// including the Claude catalog, because a half-synced pair would fail the
// validation below anyway. After writing, both catalogs are validated
// against HEAD — the catalog as it stood before this write — with the same
// gates CI runs, and a failure exits 1 so the release job does not push. A
// GITHUB_TOKEN push triggers no workflow, so nothing downstream would catch
// it. Recovery from a partial activation: docs/runbooks/codex-pin-activation.md.
//
// Usage:
//   node scripts/sync-marketplace-versions.mjs                       # apply
//   node scripts/sync-marketplace-versions.mjs --check               # dry-run
//   node scripts/sync-marketplace-versions.mjs --activate [--check]  # owner
//
// Exit codes:
//   0 — sync succeeded (no diffs OR diffs applied and validated)
//   1 — read/parse error, a refused plan, failed validation, or --check
//       found diffs
//   2 — usage error

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  parseFloors,
  readAt,
  releaseTag,
  resolveCommit,
  sourceKind,
} from './lib/codex-catalog-pins.mjs';
import { validateMarketplace } from './validate-marketplace.mjs';
import { validateVersions } from './validate-versions.mjs';

const MANIFEST_PATH = '.release-please-manifest.json';
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const CONFIG_PATH = 'release-please-config.json';

// Every Codex entry this repository has published carries this policy. A
// package's first pin takes it too; the category comes from the package itself.
const NEW_ENTRY_POLICY = Object.freeze({ installation: 'AVAILABLE', authentication: 'ON_USE' });

const writeJSON = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Sync the Claude marketplace catalog plugin versions to the
 * release-please manifest. Pure function over the filesystem rooted at
 * `repoRoot` so tests can drive it against a temp directory.
 *
 * @param {string} repoRoot — Absolute path to the repository root.
 * @param {{checkOnly?: boolean}} [options]
 * @returns {{diffs: Array<{name: string, from: string, to: string}>, written: boolean}}
 */
export function syncCatalogToManifest(repoRoot, { checkOnly = false } = {}) {
  const { catalog, diffs } = planClaudeSync(repoRoot);
  const written = diffs.length > 0 && !checkOnly;
  if (written) writeJSON(resolve(repoRoot, CLAUDE_MARKETPLACE_PATH), catalog);
  return { diffs, written };
}

function planClaudeSync(repoRoot) {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, MANIFEST_PATH), 'utf8'));
  const catalog = JSON.parse(readFileSync(resolve(repoRoot, CLAUDE_MARKETPLACE_PATH), 'utf8'));
  const entries = catalog.plugins ?? [];
  const diffs = [];

  for (const [pkgPath, expectedVersion] of Object.entries(manifest)) {
    if (!pkgPath.startsWith('plugins/')) continue;
    const pluginName = pkgPath.replace(/^plugins\//, '');
    const entry = entries.find((p) => p.name === pluginName);
    if (!entry) continue;
    if (entry.version !== expectedVersion) {
      diffs.push({ name: pluginName, from: entry.version, to: expectedVersion });
      entry.version = expectedVersion;
    }
  }
  return { catalog, diffs };
}

function pinSource(name, version, sha) {
  return { source: 'git-subdir', url: './', path: `plugins/${name}`, ref: releaseTag(name, version), sha };
}

/**
 * Plan the Codex catalog's pins (ADR-0061). Reads only; never writes.
 *
 * @returns {{phase: 'pre-activation'|'activated', activating: boolean,
 *   catalog: object, floors: object, diffs: Array<{name: string, from: string, to: string}>,
 *   notes: string[], errors: string[]}}
 */
export function planCodexPins(repoRoot, { activate = false } = {}) {
  const errors = [];
  const notes = [];
  const diffs = [];
  const read = (rel) => JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8'));

  const catalog = read(CODEX_CATALOG_PATH);
  const floorsParsed = parseFloors(readFileSync(resolve(repoRoot, FLOORS_PATH), 'utf8'));
  const empty = (phase) => ({ phase, activating: false, catalog, floors: floorsParsed.data, diffs, notes, errors });
  if (floorsParsed.data === null) {
    for (const e of floorsParsed.errors) errors.push(`${FLOORS_PATH}: ${e}`);
    return empty(null);
  }
  const floors = floorsParsed.data;
  const phase = floors.activated ? 'activated' : 'pre-activation';

  if (!floors.activated && !activate) {
    notes.push('pre-activation: the Codex catalog is left as it is (activation needs --activate)');
    return empty(phase);
  }
  if (floors.activated && activate) notes.push('already activated: --activate only pins local entries forward');

  const history = historyAvailability(repoRoot);
  if (!history.ok) {
    errors.push(`cannot pin without history: ${history.reason}`);
    return empty(phase);
  }

  const manifest = read(MANIFEST_PATH);
  const config = read(CONFIG_PATH);
  const claude = read(CLAUDE_MARKETPLACE_PATH);
  const registered = new Set(
    Object.keys(config.packages ?? {}).filter((k) => k.startsWith('plugins/')).map((k) => k.slice('plugins/'.length)),
  );

  /** The pin a published package's manifest version resolves to, or an error. */
  function target(name) {
    if (!registered.has(name)) return { error: `${name} is not a release-please package (${CONFIG_PATH})` };
    const version = manifest[`plugins/${name}`];
    if (typeof version !== 'string') return { error: `${name} has no version in ${MANIFEST_PATH}` };
    const tag = releaseTag(name, version);
    const sha = resolveCommit(repoRoot, `refs/tags/${tag}`);
    if (sha === null) return { error: `${name} is at ${version} but ${tag} does not resolve — it is not released at that version` };
    const released = checkRelease(repoRoot, { name, version, sha });
    if (released.length > 0) return { error: `${name}@${version}: ${released.join('; ')}` };
    const floor = floors.floors[name];
    if (floor !== undefined) {
      if (compareSemver(version, floor) < 0) return { error: `${name}@${version} is below its migration floor ${floor}` };
      // A floor is itself a release: the gates reject one that is not, so
      // the plan must too, or --check would promise a write that fails.
      const floorTag = releaseTag(name, floor);
      if (resolveCommit(repoRoot, `refs/tags/${floorTag}`) === null) {
        return { error: `${name}'s migration floor ${floor} is not a release (${floorTag} does not resolve) — correct the floor` };
      }
      const floorRelease = checkRelease(repoRoot, { name, version: floor });
      if (floorRelease.length > 0) return { error: `${name}'s migration floor ${floor}: ${floorRelease.join('; ')}` };
    }
    return { version, sha, floor };
  }

  const activating = !floors.activated;
  const next = structuredClone(catalog);
  const nextFloors = structuredClone(floors);

  if (activating) {
    // Decision 5 (a): every entry, all or nothing, each gated on a floor.
    for (const entry of next.plugins) {
      const t = target(entry.name);
      if (t.error) {
        errors.push(t.error);
        continue;
      }
      if (t.floor === undefined) {
        errors.push(`${entry.name} has no migration floor in ${FLOORS_PATH} — activation needs one per package`);
        continue;
      }
      const from = sourceKind(entry) === 'pinned' ? entry.source.ref : 'local';
      entry.source = pinSource(entry.name, t.version, t.sha);
      diffs.push({ name: entry.name, from, to: entry.source.ref });
    }
    nextFloors.activated = true;
  } else {
    const published = claude.plugins.map((p) => p.name).filter((name) => registered.has(name));
    for (const name of published) {
      const entry = next.plugins.find((p) => p.name === name);
      if (entry === undefined) {
        if (!hasReleaseTag(repoRoot, name)) {
          notes.push(`${name}: no release tag yet, so no Codex entry until its first release`);
          continue;
        }
        const t = target(name);
        if (t.error) {
          errors.push(t.error);
          continue;
        }
        const manifestText = readAt(repoRoot, t.sha, `plugins/${name}/.codex-plugin/plugin.json`);
        const category = manifestText === null ? undefined : JSON.parse(manifestText).interface?.category;
        if (typeof category !== 'string') {
          errors.push(`${name}: its released .codex-plugin/plugin.json declares no interface.category for its first Codex entry`);
          continue;
        }
        const added = { name, source: pinSource(name, t.version, t.sha), policy: { ...NEW_ENTRY_POLICY }, category };
        const at = next.plugins.findIndex((p) => typeof p?.name === 'string' && p.name > name);
        next.plugins.splice(at === -1 ? next.plugins.length : at, 0, added);
        diffs.push({ name, from: 'absent', to: added.source.ref });
        continue;
      }
      if (sourceKind(entry) !== 'pinned') {
        // A local entry after activation is a revert made by hand. Without the
        // owner's intent the writer refuses it; with it, the entry is pinned
        // forward to its current release — Decision 7's recovery, never a
        // step back.
        if (activate && sourceKind(entry) === 'local') {
          const t = target(name);
          if (t.error) {
            errors.push(t.error);
            continue;
          }
          // Same gate as the activation itself: a hand-set marker must not
          // become a way around Decision 5 (a)'s per-package floor.
          if (t.floor === undefined) {
            errors.push(`${name} has no migration floor in ${FLOORS_PATH} — pinning a local entry needs one, as activation does`);
            continue;
          }
          entry.source = pinSource(name, t.version, t.sha);
          diffs.push({ name, from: 'local', to: entry.source.ref });
          continue;
        }
        const kind = entry.source?.source;
        errors.push(
          `${name}: the Codex entry is ${JSON.stringify(kind)} after activation — `
            + (kind === 'local'
              ? 'a pin never goes back to local; re-run with --activate to pin it forward'
              : 'a Codex entry is a release pin; fix the source by hand'),
        );
        continue;
      }
      const current = checkPinShape(entry);
      if (current.version === null) {
        errors.push(`${name}: the current pin is malformed (${current.errors.join('; ')})`);
        continue;
      }
      const t = target(name);
      if (t.error) {
        errors.push(t.error);
        continue;
      }
      const delta = compareSemver(t.version, current.version);
      if (delta < 0) {
        errors.push(`${name}: the manifest (${t.version}) is below the pin (${current.version}) — a pin never moves down; roll back with a forward release`);
      } else if (delta === 0 && t.sha !== entry.source.sha) {
        errors.push(`${name}: ${entry.source.ref} now peels to ${t.sha.slice(0, 7)}, not the pinned ${String(entry.source.sha).slice(0, 7)} — the tag moved or the pin was written wrong; either way, release forward`);
      } else if (delta > 0) {
        const from = entry.source.ref;
        entry.source = pinSource(name, t.version, t.sha);
        diffs.push({ name, from, to: entry.source.ref });
      }
    }
  }

  if (errors.length > 0) return { ...empty(phase), activating };
  return { phase, activating, catalog: next, floors: nextFloors, diffs, notes, errors };
}

/**
 * Plan both catalogs, then write them only if nothing was refused.
 *
 * @returns {{claude: object, codex: object, written: boolean, errors: string[]}}
 */
export function syncCatalogs(repoRoot, { checkOnly = false, activate = false } = {}) {
  const claude = planClaudeSync(repoRoot);
  const codex = planCodexPins(repoRoot, { activate });
  const errors = [...codex.errors];
  const pending = claude.diffs.length + codex.diffs.length > 0;
  const written = errors.length === 0 && pending && !checkOnly;
  if (written) {
    if (claude.diffs.length > 0) writeJSON(resolve(repoRoot, CLAUDE_MARKETPLACE_PATH), claude.catalog);
    if (codex.diffs.length > 0) {
      // Pins and marker land together: the marker is written only in the
      // write that also carries the first pins.
      writeJSON(resolve(repoRoot, CODEX_CATALOG_PATH), codex.catalog);
      if (codex.activating) writeJSON(resolve(repoRoot, FLOORS_PATH), codex.floors);
    }
  }
  return { claude, codex, written, errors };
}

// CLI entry — realpath on both sides, as in validate-marketplace.mjs.
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
      options: { check: { type: 'boolean' }, activate: { type: 'boolean' } },
      strict: true,
    }));
  } catch (err) {
    console.error(`sync-marketplace-versions: ${err.message}`);
    console.error('usage: sync-marketplace-versions.mjs [--check] [--activate]');
    process.exit(2);
  }
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const checkOnly = values.check === true;

  let result;
  try {
    result = syncCatalogs(REPO_ROOT, { checkOnly, activate: values.activate === true });
  } catch (err) {
    console.error(`sync-marketplace-versions: ${err.message}`);
    process.exit(1);
  }
  const { claude, codex, errors } = result;
  for (const note of codex.notes) console.log(`  note: ${note}`);
  if (errors.length > 0) {
    console.error('sync-marketplace-versions: refused — nothing was written:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const lines = [
    ...claude.diffs.map((d) => `  - ${CLAUDE_MARKETPLACE_PATH} ${d.name}: ${d.from} → ${d.to}`),
    ...codex.diffs.map((d) => `  - ${CODEX_CATALOG_PATH} ${d.name}: ${d.from} → ${d.to}`),
  ];
  if (codex.activating && codex.diffs.length > 0) lines.push(`  - ${FLOORS_PATH}: activated false → true`);

  if (lines.length > 0 && checkOnly) {
    console.error('sync-marketplace-versions: catalog drift detected');
    for (const line of lines) console.error(line);
    process.exit(1);
  }
  if (lines.length === 0) {
    console.log(`OK — both catalogs already in sync with release-please-manifest (Codex catalog ${codex.phase})`);
  } else {
    console.log(`Synced ${lines.length} catalog change(s):`);
    for (const line of lines) console.log(line);
  }

  // Validate before EVERY successful exit, including a run that had nothing
  // to write: a repair dispatch on a catalog that is already invalid must not
  // report green. The baseline is HEAD, the catalog before this write, and the
  // gates are the ones CI runs on a pull request.
  const market = validateMarketplace(REPO_ROOT, { base: 'HEAD' });
  const versions = validateVersions(REPO_ROOT);
  const failures = [...market.errors, ...versions.errors];
  if (failures.length > 0) {
    console.error(lines.length > 0
      ? 'sync-marketplace-versions: the written catalogs FAILED validation — do not push them:'
      : 'sync-marketplace-versions: nothing to write, but the catalogs as they stand FAILED validation:');
    for (const e of failures) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`  validated: phase ${market.phase}, baseline ${market.coverage.baseline?.slice(0, 7) ?? 'not compared'}`);
}
