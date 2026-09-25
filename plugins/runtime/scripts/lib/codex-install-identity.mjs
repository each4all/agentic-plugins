// codex-install-identity.mjs — ADR-0061 §Decision 4: for each Codex plugin,
// three facts kept apart.
//
//   1. catalog target — the version named by the catalog entry's `ref`
//      (`plugin-<p>-v<version>`) and the commit named by its `sha`;
//   2. observed installed version — `codex plugin list --json`, or the
//      manifest-verified install cache when the list is unavailable;
//   3. whether content identity was verified — the installed bytes against the
//      tree at the pinned commit.
//
// WHY THREE. A catalog `sha` does not prove installed bytes. A failed
// materialization across a version change leaves an older cache while the
// catalog names a newer target (facts 1 and 2 disagree). A failed same-version
// repair leaves divergent bytes under a matching version (facts 1 and 2 agree),
// so version agreement alone is not content identity; only fact 3 can say so,
// and a version match whose bytes were not verified is never reported current.
//
// NO FALLBACK. Before ADR-0061's activation every Codex catalog entry is
// `{"source": "local", "path": "./plugins/<p>"}` and names no version, so the
// target is `unpinned` and currentness is `unknown` — never a failure
// (ADR-0046 §1.4.1), and never the repository's or the marketplace clone's
// manifest. That fallback is exactly the comparison that would mark a correct
// pinned install stale against unreleased main. A pin that is present but
// malformed is `invalid`, an error, and also never a fallback.
//
// This module is pure apart from reading the installed cache directory
// (`hashInstalledTree`). The one git read that fact 3 needs runs in
// machine-probe.mjs, through the probe's injected runner.

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { comparePrereleaseAware } from './runtime-floor.mjs';
import { isSemVer } from './semver.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const PINNED_SOURCE_KINDS = new Set(['git-subdir', 'url']);

// How many example paths a mismatch carries per class. Enough for an operator to
// see what diverged; the counts carry the rest.
const SAMPLE_LIMIT = 5;

// Bounds on hashing one installed plugin. The largest package today is a few hundred
// files and a few megabytes; a cache far past these is not an install this check can
// vouch for, and a diagnostic must not read without limit to find that out.
export const INSTALLED_TREE_MAX_FILES = 20000;
export const INSTALLED_TREE_MAX_BYTES = 256 * 1024 * 1024;

function normalizeCatalogPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

function targetFact({ status, source_kind = null, path = null, url = null, ref = null, sha = null, version = null, reason = null }) {
  return { status, source_kind, path, url, ref, sha, version, reason };
}

/**
 * Parse one Codex catalog entry into its catalog target (fact 1).
 *
 * `pinned` — a `git-subdir` or `url` source with a 40-hex `sha`, a
 * `plugin-<name>-v<semver>` `ref` for this entry's name, and `path`
 * `plugins/<name>`; `version` is the ref's version.
 * `unpinned` — the pre-activation `local` entry; it names no version.
 * `invalid` — anything else, with the reason. Never falls back to a manifest.
 */
export function parseCodexCatalogTarget(entry) {
  const name = typeof entry?.name === 'string' ? entry.name : null;
  const source = entry?.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return targetFact({ status: 'invalid', reason: 'the entry has no source object' });
  }
  const kind = typeof source.source === 'string' ? source.source : null;
  const path = normalizeCatalogPath(source.path);
  if (kind === 'local') {
    return targetFact({ status: 'unpinned', source_kind: kind, path, reason: 'the catalog entry is a local path, which names no release' });
  }
  const url = typeof source.url === 'string' ? source.url : null;
  const ref = typeof source.ref === 'string' ? source.ref : null;
  const sha = typeof source.sha === 'string' ? source.sha : null;
  const base = { source_kind: kind, path, url, ref, sha };
  if (!PINNED_SOURCE_KINDS.has(kind)) {
    return targetFact({ status: 'invalid', ...base, reason: `unrecognized source kind ${JSON.stringify(kind)}` });
  }
  if (sha === null || !SHA_RE.test(sha)) {
    return targetFact({ status: 'invalid', ...base, reason: 'the pin has no 40-character lowercase hex sha' });
  }
  // The prefix is known — `plugin-<name>-v` — so it is stripped rather than matched: a
  // version may itself contain `-v` (`1.0.0-rc-v2`, `1.0.0+build-v2`), and a pattern
  // that splits at the last one misreads a valid pin.
  const refPrefix = `plugin-${name}-v`;
  const refVersion = ref !== null && ref.startsWith(refPrefix) ? ref.slice(refPrefix.length) : null;
  if (refVersion === null || !isSemVer(refVersion)) {
    return targetFact({ status: 'invalid', ...base, reason: `ref ${JSON.stringify(ref)} is not plugin-${name}-v<semver>` });
  }
  if (path !== `plugins/${name}`) {
    return targetFact({ status: 'invalid', ...base, reason: `path ${JSON.stringify(source.path ?? null)} is not plugins/${name}` });
  }
  return targetFact({ status: 'pinned', ...base, version: refVersion });
}

/**
 * Summarize a Codex catalog's `plugins` array: every entry's target, and the
 * catalog's pin phase — `unpinned` (all local: before activation), `pinned`
 * (every entry carries a pin, valid or not), `mixed` (both, which ADR-0061
 * §Decision 2 rejects in either phase), or `empty`.
 */
export function summarizeCodexCatalogTargets(plugins) {
  const targets = {};
  let local = 0;
  let pinIntent = 0;
  for (const entry of Array.isArray(plugins) ? plugins : []) {
    if (typeof entry?.name !== 'string') continue;
    const target = parseCodexCatalogTarget(entry);
    targets[entry.name] = target;
    if (target.source_kind === 'local') local += 1;
    else if (PINNED_SOURCE_KINDS.has(target.source_kind)) pinIntent += 1;
  }
  const pinPhase = local === 0 && pinIntent === 0
    ? 'empty'
    : local > 0 && pinIntent > 0 ? 'mixed' : pinIntent > 0 ? 'pinned' : 'unpinned';
  return { pin_phase: pinPhase, targets };
}

/**
 * Parse `git ls-tree -r -z <commit> -- <prefix>` output into a map of
 * prefix-relative path → { mode, type, oid }.
 */
export function parseLsTreeZ(stdout, prefix) {
  const entries = new Map();
  const lead = `${prefix}/`;
  for (const record of String(stdout).split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const fullPath = record.slice(tab + 1);
    if (!fullPath.startsWith(lead)) continue;
    entries.set(fullPath.slice(lead.length), { mode, type, oid });
  }
  return entries;
}

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Hash every file under an installed plugin directory as git would store it:
 * relative path (with '/') → { mode, oid }. The mode is git's: 100755 for a file
 * whose owner execute bit is set, 100644 otherwise, 120000 for a symlink, whose blob is
 * its target string (never followed). Anything else is recorded with a null oid,
 * so it can never match a tree entry.
 *
 * Throws `{ code: 'EBOUNDS' }` past INSTALLED_TREE_MAX_FILES / _BYTES.
 */
export async function hashInstalledTree(root, { maxFiles = INSTALLED_TREE_MAX_FILES, maxBytes = INSTALLED_TREE_MAX_BYTES } = {}) {
  const out = new Map();
  let bytes = 0;
  const bound = () => {
    if (out.size > maxFiles || bytes > maxBytes) {
      throw Object.assign(new Error('the install cache exceeds the inspection bounds'), { code: 'EBOUNDS' });
    }
  };
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        // The target's BYTES, as git stores them: decoding it as UTF-8 first would let two
        // different targets collide on U+FFFD.
        out.set(relPath, { mode: '120000', oid: gitBlobId(await readlink(path, { encoding: 'buffer' })) });
      } else if (info.isDirectory()) {
        await walk(path, relPath);
        continue;
      } else if (info.isFile()) {
        bytes += info.size;
        bound();
        // git's rule: the OWNER execute bit alone decides 100755 (a 0654 file is 100644).
        out.set(relPath, { mode: (info.mode & 0o100) !== 0 ? '100755' : '100644', oid: gitBlobId(await readFile(path)) });
      } else {
        out.set(relPath, { mode: null, oid: null });
      }
      bound();
    }
  };
  await walk(root, '');
  return out;
}

// Git-mode-aware fingerprint of every entry under an installed plugin, from lstat
// alone: path → mode, inode, size, mtime, ctime. The root and every directory are
// included, so a directory swapped in place (a reinstall) or an entry added or
// removed changes it. Bounded like the hash.
async function statInstalledTree(root, { maxFiles }) {
  const out = new Map();
  const record = (rel, info) => {
    out.set(rel, `${info.mode}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
    if (out.size > maxFiles * 2) {
      throw Object.assign(new Error('the install cache exceeds the inspection bounds'), { code: 'EBOUNDS' });
    }
  };
  const walk = async (dir, rel) => {
    record(rel, await lstat(dir));
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, relPath);
      else record(relPath, await lstat(path));
    }
  };
  await walk(root, '');
  return out;
}

function sameFingerprint(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * `hashInstalledTree`, and whether the tree held still while it was hashed. A
 * marketplace refresh can reinstall the directory mid-inspection — even under the
 * same version, with a byte-identical manifest — so the whole tree's lstat
 * fingerprint is taken before and after; any difference means the hash is not of one
 * install. `beforeRecheck` is a test seam run between the hash and the second
 * fingerprint.
 */
export async function hashInstalledTreeStable(root, { maxFiles = INSTALLED_TREE_MAX_FILES, maxBytes = INSTALLED_TREE_MAX_BYTES, beforeRecheck = null } = {}) {
  const before = await statInstalledTree(root, { maxFiles });
  const tree = await hashInstalledTree(root, { maxFiles, maxBytes });
  if (beforeRecheck) await beforeRecheck();
  const after = await statInstalledTree(root, { maxFiles });
  return { tree, stable: sameFingerprint(before, after) };
}

/**
 * The install-cache directory that holds `version`, from a scan's manifest-verified
 * `versions` (`{ version_dir, manifest_version, path }`). Codex installs a plugin
 * under `<version>/`, so the install IS the directory named by the version, and its
 * own manifest must declare that version. Nothing else is borrowed: a retained
 * directory under another name that happens to declare the version may hold pristine
 * release bytes beside the divergent ones Codex actually serves.
 *
 * Returns `{ dir, reason }` — `dir` null with the reason when there is no such
 * directory, or it declares a different version.
 */
export function selectInstalledCacheDir(versions, version) {
  if (typeof version !== 'string' || version.length === 0) return { dir: null, reason: 'no installed version to look up' };
  const named = (Array.isArray(versions) ? versions : []).find((entry) => entry.version_dir === version) ?? null;
  if (!named) return { dir: null, reason: `no install cache directory is named ${version}` };
  if (named.manifest_version !== version) {
    return { dir: null, reason: `the install cache directory ${version}/ declares ${named.manifest_version ?? 'no version'}` };
  }
  return { dir: named, reason: null };
}

function identityFact({ status, reason = null, compared = null, missing = [], extra = [], differing = [], modeDiffering = [] }) {
  return {
    verified: status === 'verified',
    status,
    reason,
    // The path set, each file's contents, and each file's git mode (the executable
    // bit, or a symlink) are compared.
    compared_files: compared,
    missing_count: missing.length,
    extra_count: extra.length,
    differing_count: differing.length,
    mode_differing_count: modeDiffering.length,
    missing_sample: missing.slice(0, SAMPLE_LIMIT),
    extra_sample: extra.slice(0, SAMPLE_LIMIT),
    differing_sample: differing.slice(0, SAMPLE_LIMIT),
    mode_differing_sample: modeDiffering.slice(0, SAMPLE_LIMIT),
  };
}

/** An identity that could not be checked, with why. Never a success. */
export function unverifiedIdentity(reason) {
  return identityFact({ status: 'unverified', reason });
}

/**
 * Compare the pinned tree (from `parseLsTreeZ`) with the installed tree (from
 * `hashInstalledTree`). `verified` only when the path sets are equal and every
 * entry's blob id and git mode match; otherwise `mismatch` with counts and
 * sample paths, or `unverified` when the pinned tree holds something a file copy
 * cannot reproduce (a submodule). A pinned symlink the host did not copy is a
 * missing path, which is a mismatch: the install is not the pinned tree.
 */
export function compareInstalledToPinnedTree(pinned, installed) {
  if (pinned.size === 0) return unverifiedIdentity('the pinned commit has no files at the plugin path');
  // Both sides arrive as decoded strings (git's -z stdout, readdir names). A byte that
  // is not valid UTF-8 decodes to U+FFFD, and two different names can then compare
  // equal — so a replacement character on either side leaves identity unverified
  // rather than risking a false match.
  for (const path of [...pinned.keys(), ...installed.keys()]) {
    if (path.includes('\uFFFD')) return unverifiedIdentity('a path could not be decoded losslessly, so it cannot be compared');
  }
  for (const [path, entry] of pinned) {
    if (entry.type !== 'blob') return unverifiedIdentity(`the pinned tree holds a ${entry.type} at ${path}`);
  }
  const missing = [];
  const differing = [];
  const modeDiffering = [];
  for (const [path, entry] of pinned) {
    const actual = installed.get(path);
    if (!actual) missing.push(path);
    else if (actual.oid !== entry.oid) differing.push(path);
    else if (actual.mode !== entry.mode) modeDiffering.push(path);
  }
  const extra = [...installed.keys()].filter((path) => !pinned.has(path));
  for (const list of [missing, differing, modeDiffering, extra]) list.sort();
  if (missing.length === 0 && differing.length === 0 && modeDiffering.length === 0 && extra.length === 0) {
    return identityFact({ status: 'verified', compared: pinned.size });
  }
  return identityFact({
    status: 'mismatch',
    reason: 'the installed files differ from the tree at the pinned commit',
    compared: pinned.size,
    missing,
    extra,
    differing,
    modeDiffering,
  });
}

/**
 * Currentness from the three facts. Advisory (ADR-0046 §1.4.1): `unknown` is
 * not a failure, and nothing here gates completion.
 *
 *   unknown            — no valid pin (unpinned, invalid, catalog unread)
 *   not-installed      — pinned, and Codex has no install
 *   behind / ahead     — installed version below / above the pinned version
 *   content-mismatch   — same version, bytes differ from the pinned tree
 *   content-unverified — same version, identity could not be checked
 *   current            — same version AND identity verified
 */
export function assessCodexCurrentness({ target, installed, identity }) {
  if (!target || target.status !== 'pinned') return 'unknown';
  if (!installed || installed.status === 'not_installed' || !installed.version) {
    return installed?.status === 'not_installed' ? 'not-installed' : 'unknown';
  }
  // Prerelease-ranked and strict: a malformed installed version has no order.
  const order = comparePrereleaseAware(installed.version, target.version);
  if (order === null) return 'unknown';
  if (order < 0) return 'behind';
  if (order > 0) return 'ahead';
  if (identity?.status === 'verified') return 'current';
  if (identity?.status === 'mismatch') return 'content-mismatch';
  return 'content-unverified';
}
