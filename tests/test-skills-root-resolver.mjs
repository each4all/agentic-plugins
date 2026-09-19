// Gate for `tests/_helpers.mjs`'s `resolveSkillsRoot` / `skillsPath`.
//
// The helper is what four cross-package gates will call instead of spelling a
// `skills` path segment themselves, so its failure semantics ARE those gates'
// failure semantics. The property that matters is not "it returns a path" but
// "it returns the declared path, and every other outcome is a named throw" —
// a helper that fell back to the convention on a malformed manifest would make
// all four gates pass vacuously through the exact partial-move window
// ADR-0006's Amendment opens.
//
// Assertions bind to `err.code`, not to message text: the codes are the stable
// contract the consumers and the mutation harness read, messages are prose.
//
// Coverage note, stated rather than implied: every branch of the helper is
// exercised below EXCEPT `skills-realpath-failed`. That branch is reachable
// only if `realpathSync` fails on a path `statSync` just resolved — a race, not
// a state a fixture can construct. It is kept because an unnamed throw from a
// gate helper is worse than a named one, and it is named here so nobody reads
// the green suite as proof that it works.

import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSkillsRoot, skillsPath, SkillsRootError } from './_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

// Plugins that legitimately package zero skills: ADR-0008 script-only library
// (companions) and the hook-only framework primitive (attention). Both keep a
// skills/ directory holding only README.md.
const SKILL_LESS_PLUGINS = new Set(['attention', 'companions']);

// ---------------------------------------------------------------------------
// Fixture builder. Each fixture is a throwaway tmp tree holding ONE synthetic
// plugin directory plus, where a test needs an escape target, a sibling
// directory outside it.

let fixtureRoots = [];

function makeFixture({ manifest, dirs = [], files = {}, links = {}, siblings = [] }) {
  const tmp = mkdtempSync(join(tmpdir(), 'skills-root-'));
  fixtureRoots.push(tmp);
  for (const sibling of siblings) mkdirSync(join(tmp, sibling), { recursive: true });
  const pluginDir = join(tmp, 'plugin');
  mkdirSync(pluginDir, { recursive: true });

  if (manifest !== undefined) {
    mkdirSync(join(pluginDir, '.codex-plugin'), { recursive: true });
    const manifestPath = join(pluginDir, '.codex-plugin/plugin.json');
    if (manifest === 'DIRECTORY') mkdirSync(manifestPath, { recursive: true });
    else if (typeof manifest === 'string') writeFileSync(manifestPath, manifest, 'utf8');
    else writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  for (const dir of dirs) mkdirSync(join(pluginDir, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(pluginDir, rel, '..'), { recursive: true });
    writeFileSync(join(pluginDir, rel), content, 'utf8');
  }
  // `target` is interpreted relative to the TMP root, not the plugin, so a test
  // can point a link at something outside the plugin.
  for (const [rel, target] of Object.entries(links)) {
    symlinkSync(join(tmp, target), join(pluginDir, rel));
  }
  return { tmp, pluginDir };
}

function cleanupFixtures() {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots = [];
}

/** Assert the call throws a SkillsRootError carrying exactly `code`. */
function throwsCode(fn, code, label) {
  throws(
    fn,
    (err) => {
      ok(err instanceof SkillsRootError, `${label}: expected SkillsRootError, got ${err?.name}: ${err?.message}`);
      strictEqual(err.code, code, `${label}: expected code '${code}', got '${err.code}' (${err.message})`);
      return true;
    },
    label,
  );
}

const MANIFEST = (skills) => (skills === undefined ? { name: 'fx', version: '0.0.0', description: 'd' } : { name: 'fx', version: '0.0.0', description: 'd', skills });

// ---------------------------------------------------------------------------

describe('resolveSkillsRoot — the declared root wins', () => {
  it('returns the manifest-declared root even when the conventional one also exists', () => {
    // The decisive case. A relocated plugin keeps a tombstone `skills/`
    // directory (measured: deleting it re-enables plugin-root SKILL.md
    // discovery), so "the conventional path exists" must NOT be enough to win.
    const { pluginDir } = makeFixture({
      manifest: MANIFEST('./core/skills/'),
      dirs: ['core/skills/frame', 'skills'],
      files: {
        'core/skills/frame/SKILL.md': '# frame\n',
        'skills/README.md': 'tombstone\n',
      },
    });
    strictEqual(resolveSkillsRoot(pluginDir), join(pluginDir, 'core/skills'));
    cleanupFixtures();
  });

  it('treats the four conventional spellings as the same root', () => {
    for (const spelling of ['skills', './skills', './skills/', './skills/.']) {
      const { pluginDir } = makeFixture({ manifest: MANIFEST(spelling), dirs: ['skills'] });
      strictEqual(
        resolveSkillsRoot(pluginDir),
        join(pluginDir, 'skills'),
        `spelling ${JSON.stringify(spelling)} must resolve to the conventional root`,
      );
    }
    cleanupFixtures();
  });

  it('accepts a symlinked root that stays inside the plugin', () => {
    const { pluginDir } = makeFixture({
      manifest: MANIFEST('./link'),
      dirs: ['core/skills'],
      links: { link: 'plugin/core/skills' },
    });
    strictEqual(resolveSkillsRoot(pluginDir), join(pluginDir, 'link'));
    cleanupFixtures();
  });
});

describe('resolveSkillsRoot — the convention is reached by ONE path', () => {
  it('falls back to skills/ when a well-formed manifest has no skills key', () => {
    const { pluginDir } = makeFixture({
      manifest: MANIFEST(undefined),
      dirs: ['skills/frame', 'core/skills'],
    });
    strictEqual(resolveSkillsRoot(pluginDir), join(pluginDir, 'skills'));
    cleanupFixtures();
  });

  it('does not fall back when the absent-key plugin has no skills/ directory', () => {
    // The fallback is a spelling, not a permission to return nothing: the
    // consumers read files under this path, and "resolves to nothing" is the
    // vacuous pass the whole helper exists to prevent.
    const { pluginDir } = makeFixture({ manifest: MANIFEST(undefined), dirs: ['core/skills'] });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-missing', 'absent key + no skills/');
    cleanupFixtures();
  });

  it('refuses null, which is the shape someone writes when they mean absent', () => {
    const { pluginDir } = makeFixture({ manifest: MANIFEST(null), dirs: ['skills'] });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-null', 'skills: null');
    cleanupFixtures();
  });
});

describe('resolveSkillsRoot — malformed skills declarations are named failures', () => {
  it('refuses a non-string skills value of every JSON shape', () => {
    const cases = [
      [3, 'number'],
      [0, 'zero'],
      [['./skills/'], 'array'],
      [[], 'empty array'],
      [{ path: './skills/' }, 'object'],
      [true, 'boolean true'],
      [false, 'boolean false'],
    ];
    for (const [value, label] of cases) {
      const { pluginDir } = makeFixture({ manifest: MANIFEST(value), dirs: ['skills'] });
      throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-not-string', `skills: ${label}`);
    }
    cleanupFixtures();
  });

  it('refuses an empty or whitespace-only declaration', () => {
    for (const value of ['', '   ', '\t', '\n']) {
      const { pluginDir } = makeFixture({ manifest: MANIFEST(value), dirs: ['skills'] });
      throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-empty', `skills: ${JSON.stringify(value)}`);
    }
    cleanupFixtures();
  });

  it('refuses a root outside the plugin — traversal, absolute, and the plugin itself', () => {
    const outside = [
      ['../outside', 'parent traversal'],
      ['../../outside', 'double traversal'],
      ['/etc', 'absolute'],
      ['.', 'the plugin directory itself'],
      ['./', 'the plugin directory, trailing slash'],
    ];
    for (const [value, label] of outside) {
      const { pluginDir } = makeFixture({
        manifest: MANIFEST(value),
        dirs: ['skills'],
        siblings: ['outside'],
      });
      throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-outside-plugin', `skills: ${label}`);
    }
    cleanupFixtures();
  });

  it('refuses a symlinked root that escapes the plugin', () => {
    // Lexically the link is inside the plugin and `statSync` follows it to a
    // real directory, so only the realpath gate catches this.
    const { pluginDir } = makeFixture({
      manifest: MANIFEST('./link'),
      siblings: ['outside'],
      links: { link: 'outside' },
    });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-outside-plugin-symlink', 'escaping link');
    cleanupFixtures();
  });

  it('refuses a root that does not exist, including a dangling link', () => {
    const missing = makeFixture({ manifest: MANIFEST('./core/skills/'), dirs: ['skills'] });
    throwsCode(() => resolveSkillsRoot(missing.pluginDir), 'skills-missing', 'declared but absent');

    const dangling = makeFixture({
      manifest: MANIFEST('./link'),
      dirs: ['skills'],
      links: { link: 'plugin/nowhere' },
    });
    throwsCode(() => resolveSkillsRoot(dangling.pluginDir), 'skills-missing', 'dangling link');
    cleanupFixtures();
  });

  it('refuses a root that exists but is not a directory', () => {
    const { pluginDir } = makeFixture({
      manifest: MANIFEST('./core/skills.md'),
      dirs: ['skills'],
      files: { 'core/skills.md': '# not a directory\n' },
    });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-not-directory', 'file as root');
    cleanupFixtures();
  });

  it('names a stat failure that is not a plain absence', () => {
    // A path whose parent is a file yields ENOTDIR, not ENOENT — a different
    // fact, and the helper must not flatten it into "missing".
    const { pluginDir } = makeFixture({
      manifest: MANIFEST('./core/skills.md/inner'),
      dirs: ['skills'],
      files: { 'core/skills.md': '# not a directory\n' },
    });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'skills-stat-failed', 'ENOTDIR on the root path');
    cleanupFixtures();
  });
});

describe('resolveSkillsRoot — malformed manifests are named failures', () => {
  it('refuses a missing Codex manifest rather than assuming the convention', () => {
    const { pluginDir } = makeFixture({ manifest: undefined, dirs: ['skills'] });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'manifest-missing', 'no manifest');
    cleanupFixtures();
  });

  it('refuses an unreadable manifest', () => {
    const { pluginDir } = makeFixture({ manifest: 'DIRECTORY', dirs: ['skills'] });
    throwsCode(() => resolveSkillsRoot(pluginDir), 'manifest-unreadable', 'manifest is a directory');
    cleanupFixtures();
  });

  it('refuses a manifest that is not valid JSON', () => {
    for (const raw of ['', 'not json', '{ "skills": }', '{ "skills": "./skills/",  }']) {
      const { pluginDir } = makeFixture({ manifest: raw, dirs: ['skills'] });
      throwsCode(() => resolveSkillsRoot(pluginDir), 'manifest-invalid-json', `raw ${JSON.stringify(raw)}`);
    }
    cleanupFixtures();
  });

  it('refuses a manifest whose top level is not an object', () => {
    for (const raw of ['[]', '["./skills/"]', '"./skills/"', '3', 'null', 'true']) {
      const { pluginDir } = makeFixture({ manifest: raw, dirs: ['skills'] });
      throwsCode(() => resolveSkillsRoot(pluginDir), 'manifest-not-object', `raw ${raw}`);
    }
    cleanupFixtures();
  });
});

describe('resolveSkillsRoot — argument contract', () => {
  it('refuses a plugin directory that is not a non-empty string', () => {
    for (const value of [undefined, null, '', 3, [], {}, false]) {
      throwsCode(() => resolveSkillsRoot(value), 'invalid-plugin-dir', `pluginDir ${describeArg(value)}`);
    }
  });

  it('accepts a cwd-relative plugin directory', () => {
    strictEqual(
      resolveSkillsRoot(join(PLUGINS_DIR, 'engineer')),
      resolveSkillsRoot(resolve(PLUGINS_DIR, 'engineer')),
    );
  });
});

function describeArg(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return `${typeof value} ${JSON.stringify(value)}`;
}

describe('skillsPath', () => {
  it('joins segments onto the resolved root', () => {
    const { pluginDir } = makeFixture({
      manifest: MANIFEST('./core/skills/'),
      dirs: ['core/skills/frame', 'skills'],
    });
    strictEqual(
      skillsPath(pluginDir, 'frame', 'SKILL.md'),
      join(pluginDir, 'core/skills/frame/SKILL.md'),
    );
    strictEqual(skillsPath(pluginDir), join(pluginDir, 'core/skills'));
    cleanupFixtures();
  });

  it('propagates the resolver failure rather than returning a joined guess', () => {
    const { pluginDir } = makeFixture({ manifest: MANIFEST(null), dirs: ['skills'] });
    throwsCode(() => skillsPath(pluginDir, 'frame', 'SKILL.md'), 'skills-null', 'skillsPath on a bad manifest');
    cleanupFixtures();
  });
});

describe('resolveSkillsRoot — against the real repository', () => {
  it('resolves every plugin to the directory that actually holds its skills', () => {
    const plugins = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    ok(plugins.length >= 8, `the sweep found ${plugins.length} plugin directories; at least 8 exist`);

    let withSkills = 0;
    for (const plugin of plugins) {
      const pluginDir = join(PLUGINS_DIR, plugin);
      const root = resolveSkillsRoot(pluginDir);
      ok(statSync(root).isDirectory(), `${plugin}: resolved root ${root} must be a directory`);

      // Cross-check against the manifest read independently of the helper: the
      // resolved root is the one Codex itself would use.
      const manifest = JSON.parse(readFileSync(join(pluginDir, '.codex-plugin/plugin.json'), 'utf8'));
      strictEqual(
        root,
        resolve(pluginDir, manifest.skills ?? 'skills'),
        `${plugin}: resolved root must be the manifest's declared root`,
      );

      // Content check, and the reason this test is not a tautology: the root
      // must hold the plugin's skills, so a manifest pointing at some other
      // real-but-empty directory fails here rather than passing quietly.
      const skillDirs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => {
          try {
            return statSync(join(root, entry.name, 'SKILL.md')).isFile();
          } catch {
            return false;
          }
        });
      if (SKILL_LESS_PLUGINS.has(plugin)) {
        strictEqual(
          skillDirs.length,
          0,
          `${plugin} is a script-only/hook-only plugin; it must package no skills`,
        );
      } else {
        ok(skillDirs.length > 0, `${plugin}: resolved root ${root} holds no SKILL.md — wrong root`);
        withSkills += 1;
      }
    }
    // Two assertions, because either alone is weak: the equality alone stays
    // true if someone widens SKILL_LESS_PLUGINS until nothing is checked, and
    // the floor alone stays true if a plugin quietly moves into the exempt set.
    ok(
      withSkills >= 6,
      `only ${withSkills} plugins were checked for skill content; six package skills today — `
        + 'a drop means the exempt set was widened rather than the roots fixed',
    );
    strictEqual(
      withSkills,
      plugins.length - SKILL_LESS_PLUGINS.size,
      'every skill-bearing plugin must have contributed — a zero here is the vacuous pass this check exists to prevent',
    );
  });

  it('the helper module is not itself picked up as a test file', () => {
    // `node --test` discovery would run `_helpers.mjs` as a suite with zero
    // tests if the stem ever matched; the name is load-bearing.
    const stem = basename(fileURLToPath(new URL('./_helpers.mjs', import.meta.url)), '.mjs');
    ok(
      !/^test$|^test-|[-_.]test$/.test(stem),
      `the helper stem ${JSON.stringify(stem)} must not match node --test discovery patterns`,
    );
  });
});
