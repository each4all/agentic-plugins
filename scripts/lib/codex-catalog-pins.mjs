// Codex catalog pin rules — ADR-0061 Decision 1 (the pinned source shape) and
// Decision 2 (the states the catalog may be in), shared by
// scripts/validate-marketplace.mjs and scripts/validate-versions.mjs so the two
// gates cannot disagree about what a well-formed pin is.
//
// A pinned entry's source is
//   {"source": "git-subdir", "url": "./", "path": "plugins/<p>",
//    "ref": "plugin-<p>-v<version>", "sha": "<40-hex commit of that tag>"}
// Codex checks out `sha` and requires HEAD to equal it, so `sha` is what is
// installed; `ref` is the label a human and the diagnostics read. Nothing here
// makes the two agree except the history checks, which is why a structural
// pass alone is never reported as validation.

import { execFileSync } from 'node:child_process';

export const CODEX_CATALOG_PATH = '.agents/plugins/marketplace.json';
export const FLOORS_PATH = 'scripts/data/codex-pin-floors.json';
export const FLOORS_SCHEMA = 'codex-pin-floors-1.0';

// Plain X.Y.Z — the grammar every release tag in this repository uses, and the
// one check-release-obligation.mjs anchors on. Accepting a pre-release suffix
// would be a new decision about what a release is, not a validator detail.
const SEMVER_SRC = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const SEMVER = new RegExp(`^${SEMVER_SRC}$`);
const REF = new RegExp(`^plugin-(.+)-v(${SEMVER_SRC})$`);
const SHA = /^[0-9a-f]{40}$/;
const PIN_KEYS = ['path', 'ref', 'sha', 'source', 'url'];
const FLOOR_KEYS = new Set(['schema', 'description', 'activated', 'floors']);

export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

export function compareSemver(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function releaseTag(name, version) {
  return `plugin-${name}-v${version}`;
}

/** 'local' | 'pinned' | 'invalid' — the only two source kinds Decision 2 allows. */
export function sourceKind(entry) {
  const kind = entry?.source?.source;
  if (kind === 'local') return 'local';
  if (kind === 'git-subdir') return 'pinned';
  return 'invalid';
}

/**
 * Decision 1's shape for one pinned entry, checked without history.
 *
 * Returns the pinned version whenever `ref` parses for this entry's name, even
 * when another field is malformed, so a caller can still report drift — but a
 * caller must never let a lag allowance excuse `errors`.
 */
export function checkPinShape(entry) {
  const errors = [];
  const name = entry?.name;
  const source = entry?.source ?? {};
  const keys = Object.keys(source).sort();
  if (keys.join(',') !== PIN_KEYS.join(',')) {
    errors.push(`source keys must be exactly {${PIN_KEYS.join(', ')}}, got {${keys.join(', ')}}`);
  }
  if (source.url !== './') {
    errors.push(`source.url must be "./" (materialize from the marketplace snapshot), got ${JSON.stringify(source.url)}`);
  }
  if (source.path !== `plugins/${name}`) {
    errors.push(`source.path must be "plugins/${name}", got ${JSON.stringify(source.path)}`);
  }
  if (typeof source.sha !== 'string' || !SHA.test(source.sha)) {
    errors.push(`source.sha must be 40 lowercase hex, got ${JSON.stringify(source.sha)}`);
  }
  let version = null;
  const m = typeof source.ref === 'string' ? source.ref.match(REF) : null;
  if (!m) errors.push(`source.ref must be plugin-${name}-v<X.Y.Z>, got ${JSON.stringify(source.ref)}`);
  else if (m[1] !== name) errors.push(`source.ref names plugin "${m[1]}", not "${name}"`);
  else version = m[2];
  return { errors, version };
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitTry(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/**
 * Whether the history half of Decision 2 can run at all. A shallow clone or a
 * checkout without tags would make every "does this tag resolve" question
 * answer no, which reads as a pin defect rather than as missing evidence — so
 * both are reported as what they are, and the caller fails closed on them.
 */
export function historyAvailability(repoRoot) {
  let shallow;
  try {
    shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim();
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n')[0];
    return { ok: false, reason: `git history is not readable here (${detail})` };
  }
  if (shallow === 'true') return { ok: false, reason: 'the repository is a shallow clone (fetch-depth: 0 required)' };
  const tags = (gitTry(repoRoot, ['tag', '--list', 'plugin-*-v*']) ?? '').split('\n').filter(Boolean);
  if (tags.length === 0) return { ok: false, reason: 'no plugin-*-v* release tags are present (fetch tags required)' };
  return { ok: true, reason: null };
}

/** Whether `name` has had any release — the point Decision 2's untagged exemption ends. */
export function hasReleaseTag(repoRoot, name) {
  const tags = (gitTry(repoRoot, ['tag', '--list', `plugin-${name}-v*`]) ?? '').split('\n');
  return tags.some((t) => {
    const m = t.match(REF);
    return m !== null && m[1] === name;
  });
}

/** Resolve a revision to a commit id, or null. */
export function resolveCommit(repoRoot, rev) {
  return gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])?.trim() || null;
}

/** A file's text at a commit, or null when the path does not exist there. */
export function readAt(repoRoot, commit, path) {
  if (gitTry(repoRoot, ['cat-file', '-e', `${commit}:${path}`]) === null) return null;
  return git(repoRoot, ['show', `${commit}:${path}`]);
}

/**
 * The history half of Decision 2 for one release of one package: the tag
 * resolves; when a `sha` is pinned, it is the commit the tag PEELS to; and the
 * tree Codex would install carries the package's Codex manifest at that name
 * and version. With no `sha` (a floor), the tree checked is the tag's own.
 */
export function checkRelease(repoRoot, { name, version, sha = null }) {
  const errors = [];
  const tag = releaseTag(name, version);
  const tagCommit = resolveCommit(repoRoot, `refs/tags/${tag}`);
  if (!tagCommit) {
    errors.push(`tag ${tag} does not resolve in this repository`);
  } else if (sha !== null && tagCommit !== sha) {
    // An annotated tag's object id is 40 lowercase hex too, so the shape check
    // cannot see this; only comparing against the peel can.
    const tagObject = gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])?.trim();
    errors.push(tagObject === sha
      ? `sha ${sha} is the annotated tag object of ${tag}, not its commit ${tagCommit} — peel with ^{commit}`
      : `sha ${sha} is not the commit ${tag} peels to (${tagCommit})`);
  }
  const at = sha ?? tagCommit;
  if (at === null) return errors;
  const type = gitTry(repoRoot, ['cat-file', '-t', at])?.trim() || 'missing object';
  if (type !== 'commit') {
    errors.push(`${at} is a ${type}, not a commit`);
    return errors;
  }
  const manifestPath = `plugins/${name}/.codex-plugin/plugin.json`;
  const text = readAt(repoRoot, at, manifestPath);
  if (text === null) {
    errors.push(`the tree at ${at.slice(0, 7)} has no ${manifestPath}`);
    return errors;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    errors.push(`the tree at ${at.slice(0, 7)} has an unparsable ${manifestPath}: ${err.message}`);
    return errors;
  }
  if (manifest.name !== name) {
    errors.push(`the tree at ${at.slice(0, 7)} has ${manifestPath} named ${JSON.stringify(manifest.name)}, not "${name}"`);
  }
  if (manifest.version !== version) {
    errors.push(`the tree at ${at.slice(0, 7)} has ${manifestPath} at version ${JSON.stringify(manifest.version)}, not ${version}`);
  }
  return errors;
}

/**
 * Parse the floor data file (Decision 5 (a)). Strict: an unknown key is an
 * error, because a misspelt `activated` would otherwise read as absent — and
 * absent must never be taken to mean "not activated".
 */
export function parseFloors(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { data: null, errors: [err.message] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { data: null, errors: ['must be a JSON object'] };
  }
  for (const key of Object.keys(data)) if (!FLOOR_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  if (data.schema !== FLOORS_SCHEMA) errors.push(`schema must be "${FLOORS_SCHEMA}", got ${JSON.stringify(data.schema)}`);
  if (typeof data.activated !== 'boolean') errors.push(`activated must be a boolean, got ${JSON.stringify(data.activated)}`);
  const floors = data.floors;
  if (floors === null || typeof floors !== 'object' || Array.isArray(floors)) {
    errors.push('floors must be an object of plugin name → X.Y.Z');
  } else {
    for (const [name, version] of Object.entries(floors)) {
      if (!isSemver(version)) errors.push(`floor for "${name}" must be X.Y.Z, got ${JSON.stringify(version)}`);
    }
  }
  return { data: errors.length === 0 ? data : null, errors };
}
