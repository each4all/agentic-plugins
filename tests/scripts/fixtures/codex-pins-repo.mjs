// Git-backed fixture repositories for the ADR-0061 catalog gates and writer
// (tests/scripts/test-codex-catalog-pins.mjs, test-codex-pin-writer.mjs).
//
// Each fixture is a real repository with real tags: `alpha` released with a
// lightweight tag and `beta` with an annotated one, both at 1.0.0, the Codex
// catalog all-local and not activated — this repository's state before
// ADR-0061 activation. The scripts under test are copied in, so a CLI case
// runs the real entry point with the fixture as the root it derives from
// `import.meta.url`.
//
// Not discovered by `node --test`: the stem matches none of Node's test-file
// patterns.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Copied into every fixture so the CLI cases run the real entry points with
// the fixture as the root they derive from `import.meta.url`.
const SCRIPTS = [
  'scripts/validate-marketplace.mjs',
  'scripts/validate-versions.mjs',
  'scripts/sync-marketplace-versions.mjs',
  'scripts/lib/codex-catalog-pins.mjs',
];

export const CODEX = '.agents/plugins/marketplace.json';
export const CLAUDE = '.claude-plugin/marketplace.json';
export const FLOORS = 'scripts/data/codex-pin-floors.json';
export const MANIFEST = '.release-please-manifest.json';
export const CONFIG = 'release-please-config.json';

export const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

export function write(dir, rel, text) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}
export const writeJSON = (dir, rel, value) => write(dir, rel, `${JSON.stringify(value, null, 2)}\n`);
export const readJSON = (dir, rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8'));

export function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

export const peeled = (dir, tag) => git(dir, ['rev-parse', `refs/tags/${tag}^{commit}`]).trim();
export const tagObject = (dir, tag) => git(dir, ['rev-parse', `refs/tags/${tag}`]).trim();

export function tag(dir, name, { annotated = false, at = 'HEAD', force = false } = {}) {
  const args = ['tag'];
  if (force) args.push('-f');
  if (annotated) args.push('-a', '-m', name);
  git(dir, [...args, name, at]);
}

/** Set a package's version everywhere release-please and the catalog sync would. */
export function setVersion(dir, name, version) {
  writeJSON(dir, `plugins/${name}/.claude-plugin/plugin.json`, { name, version });
  writeJSON(dir, `plugins/${name}/.codex-plugin/plugin.json`, { name, version, interface: { category: 'Productivity' } });
  const manifest = readJSON(dir, MANIFEST);
  manifest[`plugins/${name}`] = version;
  writeJSON(dir, MANIFEST, manifest);
  const claude = readJSON(dir, CLAUDE);
  const entry = claude.plugins.find((p) => p.name === name);
  if (entry) entry.version = version;
  writeJSON(dir, CLAUDE, claude);
}

/** Register (or, with null, unregister) a package the way release-please-config.json does. */
export function setConfigPackage(dir, name, component = `plugin-${name}`) {
  const config = readJSON(dir, CONFIG);
  if (component === null) delete config.packages[`plugins/${name}`];
  else config.packages[`plugins/${name}`] = { 'package-name': component, component };
  writeJSON(dir, CONFIG, config);
}

export const localSource = (name) => ({ source: 'local', path: `./plugins/${name}` });

export function pinSource(dir, name, version, overrides = {}) {
  return {
    source: 'git-subdir',
    url: './',
    path: `plugins/${name}`,
    ref: `plugin-${name}-v${version}`,
    sha: peeled(dir, `plugin-${name}-v${version}`),
    ...overrides,
  };
}

export function codexEntry(name, source) {
  return { name, source, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' };
}

export function setCodexSource(dir, name, source) {
  const codex = readJSON(dir, CODEX);
  const entry = codex.plugins.find((p) => p.name === name);
  if (source === null) codex.plugins = codex.plugins.filter((p) => p.name !== name);
  else if (entry) entry.source = source;
  else codex.plugins.push(codexEntry(name, source));
  writeJSON(dir, CODEX, codex);
}

export function setFloors(dir, patch) {
  writeJSON(dir, FLOORS, { ...readJSON(dir, FLOORS), ...patch });
}

export function setFloor(dir, name, version) {
  const floors = readJSON(dir, FLOORS);
  if (version === null) delete floors.floors[name];
  else floors.floors[name] = version;
  writeJSON(dir, FLOORS, floors);
}

/**
 * Two packages at 1.0.0, released: `alpha` with a lightweight tag, `beta`
 * with an annotated one. The Codex catalog is all-local and not activated —
 * the pre-activation state this repository is in today.
 */
export function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgsign', 'false']);
  const top = { name: 'fx', description: 'fixture marketplace' };
  writeJSON(dir, MANIFEST, {});
  writeJSON(dir, CONFIG, { packages: {} });
  setConfigPackage(dir, 'alpha');
  setConfigPackage(dir, 'beta');
  writeJSON(dir, CLAUDE, {
    ...top,
    plugins: ['alpha', 'beta'].map((name) => ({ name, source: `./plugins/${name}`, version: '1.0.0' })),
  });
  writeJSON(dir, CODEX, { ...top, plugins: ['alpha', 'beta'].map((name) => codexEntry(name, localSource(name))) });
  writeJSON(dir, FLOORS, {
    schema: 'codex-pin-floors-1.0',
    activated: false,
    floors: { alpha: '1.0.0', beta: '1.0.0' },
  });
  setVersion(dir, 'alpha', '1.0.0');
  setVersion(dir, 'beta', '1.0.0');
  for (const rel of SCRIPTS) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel));
  }
  commit(dir, 'chore: scaffold');
  tag(dir, 'plugin-alpha-v1.0.0');
  tag(dir, 'plugin-beta-v1.0.0', { annotated: true });
  return dir;
}

/** Activate: every entry pinned to its current release, marker set. */
export function activate(dir, versions = { alpha: '1.0.0', beta: '1.0.0' }) {
  for (const [name, version] of Object.entries(versions)) setCodexSource(dir, name, pinSource(dir, name, version));
  setFloors(dir, { activated: true });
}

/** Cut a release of one package: bump, commit, tag. */
export function release(dir, name, version, { annotated = false } = {}) {
  setVersion(dir, name, version);
  const sha = commit(dir, `chore: release ${name} ${version}`);
  tag(dir, `plugin-${name}-v${version}`, { annotated });
  return sha;
}

/** Add a third package the way a new plugin lands: both catalogs' Claude side, manifest, dirs. */
export function addPackage(dir, name) {
  const claude = readJSON(dir, CLAUDE);
  claude.plugins.push({ name, source: `./plugins/${name}`, version: '0.1.0' });
  writeJSON(dir, CLAUDE, claude);
  setConfigPackage(dir, name);
  setVersion(dir, name, '0.1.0');
}

export function assertOk(r) {
  assert.deepEqual(r.errors, [], 'expected no errors');
}

export function assertError(r, pattern) {
  assert.ok(
    r.errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n  ${r.errors.join('\n  ') || '(none)'}`,
  );
}

export function runCli(root, script, args = []) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8' });
}
