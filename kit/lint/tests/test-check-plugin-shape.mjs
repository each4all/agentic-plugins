// kit/lint/check-plugin-shape.mjs conformance test.
//
// Spawns the lint script against several fixtures and asserts exit codes
// + relevant stderr substrings. Run via:
//   node --test kit/lint/tests/test-check-plugin-shape.mjs

import { after, describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const LINT_SCRIPT = resolve(REPO_ROOT, 'kit/lint/check-plugin-shape.mjs');
const FIXTURES = resolve(REPO_ROOT, 'kit/lint/tests/fixtures');

function runLint(targetPath) {
  return new Promise((resolveP) => {
    const child = spawn('node', [LINT_SCRIPT, targetPath], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => resolveP({ code, stdout, stderr }));
  });
}

describe('kit/lint/check-plugin-shape', () => {
  it('exits 0 on a valid plugin (plugins/companions)', async () => {
    const result = await runLint(resolve(REPO_ROOT, 'plugins/companions'));
    strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
    ok(result.stdout.includes('shape OK'));
  });

  it('exits 1 when the Claude manifest is missing', async () => {
    const result = await runLint(resolve(FIXTURES, 'missing-claude'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('.claude-plugin/plugin.json: missing'));
  });

  it('exits 1 when the Codex manifest is missing', async () => {
    const result = await runLint(resolve(FIXTURES, 'missing-codex'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('.codex-plugin/plugin.json: missing'));
  });

  it('exits 1 when manifest names disagree across hosts', async () => {
    const result = await runLint(resolve(FIXTURES, 'name-mismatch'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('manifest name mismatch'));
  });

  it('exits 0 on a valid hook-only plugin fixture (ADR-0040 §3 category)', async () => {
    const result = await runLint(resolve(FIXTURES, 'hook-only-valid'));
    strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
    ok(result.stdout.includes('shape OK'));
  });

  it('exits 0 on the real hook-only plugin (plugins/attention)', async () => {
    const result = await runLint(resolve(REPO_ROOT, 'plugins/attention'));
    strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
    ok(result.stdout.includes('shape OK'));
  });

  it('exits 1 when hooks/hooks.json is not parseable JSON', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-bad-json'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('hooks/hooks.json:'), `stderr=${result.stderr}`);
  });

  it('exits 1 when hooks/hooks.json top-level hooks key has the wrong shape', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-bad-structure'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('"hooks" must be an object mapping event names'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 1 when a hook command target does not exist in the plugin (declared custom path)', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-missing-target'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('command target "adapters/claude/hooks/missing-sensor.mjs" does not exist'),
      `stderr=${result.stderr}`,
    );
    // Diagnostics must carry the real declared relative path, not a
    // hardcoded hooks/hooks.json label.
    ok(
      result.stderr.includes('adapters/claude/hooks/hooks.json:'),
      `stderr must label the declared path; stderr=${result.stderr}`,
    );
  });

  it('exits 1 when the Claude manifest declares a hooks path that does not exist', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-declared-missing'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('declared hooks path "./adapters/claude/hooks/hooks.json" does not exist'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 1 when a ./-prefixed declared hooks path escapes the plugin directory', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-escaping-path'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('escapes the plugin directory'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 1 when a hook command references no ${CLAUDE_PLUGIN_ROOT} target', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-no-root-command'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('must reference at least one ${CLAUDE_PLUGIN_ROOT}'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 2 with no arguments', async () => {
    const result = await new Promise((resolveP) => {
      const child = spawn('node', [LINT_SCRIPT], { cwd: REPO_ROOT });
      let stderr = '';
      child.stderr.on('data', (b) => (stderr += b.toString()));
      child.on('close', (code) => resolveP({ code, stderr }));
    });
    strictEqual(result.code, 2);
    ok(result.stderr.includes('Usage:'));
  });

  it('exits 2 when target is not a directory', async () => {
    const result = await runLint(resolve(REPO_ROOT, 'package.json'));
    strictEqual(result.code, 2);
  });
});

// Declared-hooks value-shape matrix (manifest `hooks` key semantics).
// Claude Code accepts string | array | inline object; the agentic-plugins
// canonical shape is file-backed JSON (ADR-0006), so the linter accepts
// string paths and string arrays, and rejects inline objects explicitly.
describe('kit/lint/check-plugin-shape — declared hooks value shapes', () => {
  const VALID_HOOKS_BODY = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/noop.mjs"' },
          ],
        },
      ],
    },
  }, null, 2);

  const tempDirs = [];
  after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  // Build a throwaway plugin dir. `hooksValue` lands verbatim in the Claude
  // manifest; `files` maps plugin-relative paths to contents.
  async function makePlugin({ hooksValue, files = {} } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'kit-lint-hooks-shape-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await mkdir(join(dir, '.codex-plugin'), { recursive: true });
    const claude = { name: 'fixture-shape-matrix', version: '0.0.1', description: 'matrix' };
    if (hooksValue !== undefined) claude.hooks = hooksValue;
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(claude, null, 2));
    await writeFile(
      join(dir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'fixture-shape-matrix', version: '0.0.1', description: 'matrix' }, null, 2),
    );
    await mkdir(join(dir, 'adapters', 'claude', 'hooks'), { recursive: true });
    const noop = join(dir, 'adapters', 'claude', 'hooks', 'noop.mjs');
    await writeFile(noop, '#!/usr/bin/env node\n');
    await chmod(noop, 0o755);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(resolve(abs, '..'), { recursive: true });
      await writeFile(abs, content);
    }
    return dir;
  }

  it('accepts a valid string array of declared hook files', async () => {
    const dir = await makePlugin({
      hooksValue: ['./adapters/claude/hooks/hooks.json', './adapters/claude/hooks/extra.json'],
      files: {
        'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY,
        'adapters/claude/hooks/extra.json': VALID_HOOKS_BODY,
      },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('rejects an array whose later entry does not exist', async () => {
    const dir = await makePlugin({
      hooksValue: ['./adapters/claude/hooks/hooks.json', './adapters/claude/hooks/absent.json'],
      files: { 'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('declared hooks path "./adapters/claude/hooks/absent.json" does not exist'), `stderr=${result.stderr}`);
  });

  it('rejects a mixed array with an indexed diagnostic (no silent filtering)', async () => {
    const dir = await makePlugin({
      hooksValue: ['./adapters/claude/hooks/hooks.json', { hooks: {} }],
      files: { 'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('hooks[1]'), `stderr=${result.stderr}`);
  });

  it('rejects an empty declared array', async () => {
    const dir = await makePlugin({ hooksValue: [] });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('hooks must not be an empty array'), `stderr=${result.stderr}`);
  });

  it('rejects an inline hooks object with the file-backed policy message', async () => {
    const dir = await makePlugin({ hooksValue: { hooks: {} } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('inline hooks config is not supported by the agentic-plugins file-backed shape'),
      `stderr=${result.stderr}`,
    );
  });

  it('rejects a declared path without the ./ prefix', async () => {
    const dir = await makePlugin({
      hooksValue: 'adapters/claude/hooks/hooks.json',
      files: { 'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('must start with "./"'), `stderr=${result.stderr}`);
  });

  it('rejects a declared path without the .json suffix', async () => {
    const dir = await makePlugin({
      hooksValue: './adapters/claude/hooks/hooks.config',
      files: { 'adapters/claude/hooks/hooks.config': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('must end with ".json"'), `stderr=${result.stderr}`);
  });

  it('rejects duplicate canonical paths within the declared array', async () => {
    const dir = await makePlugin({
      hooksValue: ['./adapters/claude/hooks/hooks.json', './adapters/claude/hooks/../hooks/hooks.json'],
      files: { 'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('duplicate declared hooks path'), `stderr=${result.stderr}`);
  });

  it('rejects a manifest redeclaring the root default hooks/hooks.json', async () => {
    const dir = await makePlugin({
      hooksValue: './hooks/hooks.json',
      files: { 'hooks/hooks.json': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('redeclares the default hooks/hooks.json'), `stderr=${result.stderr}`);
  });

  it('still validates a malformed root default alongside a valid declared path', async () => {
    const dir = await makePlugin({
      hooksValue: './adapters/claude/hooks/hooks.json',
      files: {
        'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY,
        'hooks/hooks.json': '{ not json',
      },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('hooks/hooks.json:'), `stderr=${result.stderr}`);
  });

  it('rejects a declared path with backslash separators', async () => {
    const dir = await makePlugin({
      hooksValue: './adapters\\claude\\hooks\\hooks.json',
      files: { 'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('must use POSIX separators'), `stderr=${result.stderr}`);
  });

  // Physical containment: lexical checks pass (the symlink LIVES inside the
  // plugin) but realpath resolves outside — must be rejected, not linted as
  // in-plugin content.
  it('rejects a declared hooks file that is a symlink to outside the plugin', async () => {
    const dir = await makePlugin({ hooksValue: './adapters/claude/hooks/linked.json' });
    const outside = await mkdtemp(join(tmpdir(), 'kit-lint-outside-'));
    tempDirs.push(outside);
    await writeFile(join(outside, 'real-hooks.json'), VALID_HOOKS_BODY);
    await symlink(join(outside, 'real-hooks.json'), join(dir, 'adapters', 'claude', 'hooks', 'linked.json'));
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('resolves outside the plugin directory (symlink)'),
      `stderr=${result.stderr}`,
    );
  });

  it('rejects a command target that is a symlink to outside the plugin', async () => {
    const dir = await makePlugin({
      hooksValue: './adapters/claude/hooks/hooks.json',
      files: {
        'adapters/claude/hooks/hooks.json': JSON.stringify({
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/linked.mjs"' }] },
            ],
          },
        }, null, 2),
      },
    });
    const outside = await mkdtemp(join(tmpdir(), 'kit-lint-outside-'));
    tempDirs.push(outside);
    await writeFile(join(outside, 'real-sensor.mjs'), '#!/usr/bin/env node\n');
    await symlink(join(outside, 'real-sensor.mjs'), join(dir, 'adapters', 'claude', 'hooks', 'linked.mjs'));
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('command target "adapters/claude/hooks/linked.mjs" resolves outside the plugin directory (symlink)'),
      `stderr=${result.stderr}`,
    );
  });

  it('detects a duplicate by real file identity when one declared entry symlinks another', async () => {
    const dir = await makePlugin({
      hooksValue: ['./adapters/claude/hooks/hooks.json', './adapters/claude/hooks/alias.json'],
      files: { 'adapters/claude/hooks/hooks.json': VALID_HOOKS_BODY },
    });
    await symlink(
      join(dir, 'adapters', 'claude', 'hooks', 'hooks.json'),
      join(dir, 'adapters', 'claude', 'hooks', 'alias.json'),
    );
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('duplicate declared hooks path'), `stderr=${result.stderr}`);
  });

  it('detects root-default redeclaration through a symlink alias', async () => {
    const dir = await makePlugin({
      hooksValue: './adapters/claude/hooks/alias.json',
      files: { 'hooks/hooks.json': VALID_HOOKS_BODY },
    });
    await symlink(
      join(dir, 'hooks', 'hooks.json'),
      join(dir, 'adapters', 'claude', 'hooks', 'alias.json'),
    );
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('redeclares the default hooks/hooks.json'), `stderr=${result.stderr}`);
  });
});

// Skill frontmatter conformance — mirrors Codex's bundled
// skills/.system/skill-creator/scripts/quick_validate.py. The boundary
// cases (exactly 1024 vs 1025, and an escaped scalar whose raw text is
// longer than its decoded value) are what prove the linter measures the
// same decoded string Codex's yaml.safe_load would, rather than a raw
// line length that happens to agree on the current files.
describe('kit/lint/check-plugin-shape — skill frontmatter', () => {
  const tempDirs = [];
  after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  // `skills` maps a path relative to `root` (default 'skills') to its full
  // file content, so each test writes exactly the bytes under test.
  // `declaredSkills` sets the Codex manifest's skills path; keep it distinct
  // from the conventional 'skills' root when testing declared-root discovery,
  // or conventional discovery alone satisfies the test.
  async function makeSkillPlugin({ skills = {}, declaredSkills, root = 'skills' } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'kit-lint-skill-fm-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await mkdir(join(dir, '.codex-plugin'), { recursive: true });
    const manifest = { name: 'fixture-skill-fm', version: '0.0.1', description: 'skill frontmatter fixture' };
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
    await writeFile(
      join(dir, '.codex-plugin', 'plugin.json'),
      JSON.stringify(declaredSkills ? { ...manifest, skills: declaredSkills } : manifest, null, 2),
    );
    for (const [rel, content] of Object.entries(skills)) {
      const abs = join(dir, root, rel);
      await mkdir(resolve(abs, '..'), { recursive: true });
      await writeFile(abs, content);
    }
    return dir;
  }

  const skillFile = (name, description) => `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`;

  it('accepts a conformant skill', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'A conformant demo skill.') } });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('accepts a description of exactly 1024 characters', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1024)) } });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `1024 must be allowed; stderr=${result.stderr}`);
  });

  it('rejects a description of exactly 1025 characters and reports the true length', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1025)) } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('description is too long (1025 characters, maximum is 1024)'),
      `stderr=${result.stderr}`,
    );
  });

  it('measures the decoded scalar, not the raw line, for an escaped description', async () => {
    // `\"` is two raw characters and one decoded character. Ten of them plus
    // 1014 filler decode to exactly 1024 while the raw value is 1034, so a
    // linter measuring raw text rejects what Codex accepts.
    const decodedTail = '\\"'.repeat(10);
    const raw = 'x'.repeat(1014) + decodedTail;
    strictEqual(raw.length, 1034, 'raw value must exceed the cap for this test to mean anything');
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', raw) } });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `decoded length is 1024 and must pass; stderr=${result.stderr}`);
  });

  it('rejects the same escaped description one decoded character over the cap', async () => {
    const raw = 'x'.repeat(1015) + '\\"'.repeat(10);
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', raw) } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('description is too long (1025 characters'),
      `stderr=${result.stderr}`,
    );
  });

  it('counts code points, not UTF-16 units, so an emoji costs one character', async () => {
    // Python's len() counts 1024 here; JavaScript's .length counts 1025
    // because the emoji is a surrogate pair. Codex accepts this file.
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1023) + '\u{1F600}') },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `code-point length is 1024 and must pass; stderr=${result.stderr}`);
  });

  it('strips like Python, leaving a trailing U+FEFF counted', async () => {
    // JavaScript's trim() removes U+FEFF and would measure 1024; Python's
    // strip() does not, so quick_validate.py sees 1025 and rejects.
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1024) + '﻿') },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('description is too long (1025 characters'), `stderr=${result.stderr}`);
  });

  it('rejects a description containing a less-than sign', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'Use for investigate <topic> requests.') } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('description cannot contain angle brackets'), `stderr=${result.stderr}`);
  });

  it('rejects a description containing a greater-than sign', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'Resolution order is env > user-global.') } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('description cannot contain angle brackets'), `stderr=${result.stderr}`);
  });

  it('rejects an unexpected frontmatter key', async () => {
    const body = '---\nname: demo\ndescription: "Fine."\nargument-hint: "(topic)"\n---\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('unexpected frontmatter key(s): argument-hint'), `stderr=${result.stderr}`);
  });

  it('allows a structured metadata mapping', async () => {
    const body = '---\nname: demo\ndescription: "Fine."\nmetadata:\n  owner: platform\n  tier: "1"\n---\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `metadata is an allowed key; stderr=${result.stderr}`);
  });

  it('rejects a missing description', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': '---\nname: demo\n---\n' } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('missing "description" in frontmatter'), `stderr=${result.stderr}`);
  });

  it('rejects a missing name', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': '---\ndescription: "Fine."\n---\n' } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('missing "name" in frontmatter'), `stderr=${result.stderr}`);
  });

  it('rejects a name that is not hyphen-case', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('My_Skill', 'Fine.') } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('must be hyphen-case'), `stderr=${result.stderr}`);
  });

  it('rejects a name with consecutive hyphens', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo--skill', 'Fine.') } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('consecutive hyphens'), `stderr=${result.stderr}`);
  });

  it('rejects a name longer than 64 characters', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('a'.repeat(65), 'Fine.') } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('name is too long (65 characters'), `stderr=${result.stderr}`);
  });

  it('accepts CRLF frontmatter, as the bundled validator does', async () => {
    // quick_validate.py loads through Path.read_text(), whose universal-newline
    // translation removes CR before its `^---\n` regex runs — verified by
    // running that validator against a CRLF fixture. Rejecting CRLF here would
    // fail a file Codex accepts.
    const body = '---\r\nname: demo\r\ndescription: "Fine."\r\n---\r\n\r\n# demo\r\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `CRLF is valid for Codex; stderr=${result.stderr}`);
  });

  it('still measures a CRLF file against the cap', async () => {
    const body = `---\r\nname: demo\r\ndescription: "${'x'.repeat(1025)}"\r\n---\r\n`;
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('description is too long (1025 characters'), `stderr=${result.stderr}`);
  });

  // PyYAML resolves these plain scalars to non-strings, and quick_validate.py
  // rejects each with "must be a string". Reading them as strings is the
  // permissive direction: the gate would pass a skill Codex refuses to load.
  for (const [label, value, kind] of [
    ['an empty value', '', 'null'],
    ['an explicit null', 'null', 'null'],
    ['a tilde null', '~', 'null'],
    ['an integer', '123', 'an integer'],
    ['a boolean', 'true', 'a boolean'],
    ['a YAML 1.1 boolean', 'no', 'a boolean'],
    ['a float', '1.5', 'a float'],
    ['a date', '2026-08-03', 'a timestamp'],
  ]) {
    it(`rejects ${label} as a description`, async () => {
      const dir = await makeSkillPlugin({
        skills: { 'demo/SKILL.md': `---\nname: demo\ndescription: ${value}\n---\n` },
      });
      const result = await runLint(dir);
      strictEqual(result.code, 1, `stderr=${result.stderr}`);
      ok(
        result.stderr.includes(`YAML reads this unquoted value as ${kind}`),
        `expected ${kind}; stderr=${result.stderr}`,
      );
    });
  }

  it('rejects an alias that hides an over-cap description', async () => {
    // The alias text is five characters, but PyYAML resolves it to the
    // anchored 1025-character value and quick_validate.py rejects the file.
    const body = `---\nname: demo\nlicense: &long "${'x'.repeat(1025)}"\ndescription: *long\n---\n`;
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1, `stderr=${result.stderr}`);
    ok(result.stderr.includes('YAML structure indicator'), `stderr=${result.stderr}`);
  });

  it('rejects a plain description that opens a nested mapping', async () => {
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': '---\nname: demo\ndescription: foo: bar\n---\n' },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('a nested mapping'), `stderr=${result.stderr}`);
  });

  it('rejects content after a closing quote', async () => {
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': '---\nname: demo\ndescription: "Fine." trailing\n---\n' },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('after the closing quote'), `stderr=${result.stderr}`);
  });

  it('accepts a comment after a closing quote', async () => {
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': '---\nname: demo\ndescription: "Fine." # note\n---\n' },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('accepts an unquoted plain description that YAML reads as a string', async () => {
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': '---\nname: demo\ndescription: Gathers evidence and reports it.\n---\n' },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `plain strings stay valid; stderr=${result.stderr}`);
  });

  it('accepts a quoted frontmatter key', async () => {
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': '---\n"name": demo\ndescription: "Fine."\n---\n' },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `PyYAML reads "name" as name; stderr=${result.stderr}`);
  });

  it('fails closed when a skills subtree cannot be read', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'Fine.') } });
    const locked = join(dir, 'skills', 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'SKILL.md'), skillFile('locked', 'Fine.'));
    await chmod(locked, 0o000);
    try {
      const result = await runLint(dir);
      strictEqual(result.code, 1, `an unreadable subtree must not lint clean; stderr=${result.stderr}`);
      ok(result.stderr.includes('skills scan:'), `stderr=${result.stderr}`);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('fails closed on a block-scalar description rather than guessing', async () => {
    // No continuation line, so the multi-line guard cannot fire and this
    // isolates the block-scalar branch. Asserting the generic "not measurable"
    // text instead would pass on either branch — it did, and the mutation that
    // deleted this check survived.
    const body = '---\nname: demo\ndescription: |\n---\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('block scalar (| or >)'), `stderr=${result.stderr}`);
  });

  it('fails closed on a description that spans lines', async () => {
    const body = '---\nname: demo\ndescription: |\n  A block scalar description.\n---\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('spans multiple lines'), `stderr=${result.stderr}`);
  });

  it('ignores a shared directory that carries no SKILL.md', async () => {
    const dir = await makeSkillPlugin({
      skills: {
        'demo/SKILL.md': skillFile('demo', 'Fine.'),
        '_shared/references/notes.md': '# not a skill\n',
      },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `_shared/ is not a skill; stderr=${result.stderr}`);
  });

  it('finds a defective skill nested below the skills root', async () => {
    const dir = await makeSkillPlugin({
      skills: {
        'demo/SKILL.md': skillFile('demo', 'Fine.'),
        'group/nested/SKILL.md': skillFile('nested', 'x'.repeat(1100)),
      },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('group/nested/SKILL.md'), `stderr=${result.stderr}`);
  });

  it('scans a declared skills root that is not the conventional one', async () => {
    // The declared root must differ from 'skills/', or conventional discovery
    // alone satisfies this and the test passes with declared-root scanning
    // removed entirely — which is exactly how it read before.
    const dir = await makeSkillPlugin({
      declaredSkills: './custom-skills/',
      root: 'custom-skills',
      skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(2000)) },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('custom-skills/demo/SKILL.md'), `stderr=${result.stderr}`);
    ok(result.stderr.includes('description is too long (2000 characters'), `stderr=${result.stderr}`);
  });

  it('rejects a declared skills root that escapes the plugin', async () => {
    const dir = await makeSkillPlugin({
      declaredSkills: '../outside-skills/',
      skills: { 'demo/SKILL.md': skillFile('demo', 'Fine.') },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('escapes the plugin directory'), `stderr=${result.stderr}`);
  });

  it('labels the offending skill by its plugin-relative path', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1100)) } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('skills/demo/SKILL.md:'), `stderr=${result.stderr}`);
  });
  const result_includes = (r, needle) => r.stderr.includes(needle);

  // --- Skill agent manifest (agents/openai.yaml) ---------------------------
  //
  // Codex reads a skill's invocation policy from this file, not from SKILL.md.
  // The repository shipped one manifest (runtime:cutover) whose
  // `allow_implicit_invocation` sat at the top level instead of inside
  // `policy` — the only place Codex reads it — so the skill stayed implicitly
  // invocable while appearing to opt out, and it was the one packaged skill of
  // 55 that a Codex session listed. The text-level
  // /allow_implicit_invocation:\s*false/ assertions in tests/plugin-shape
  // passed throughout, because the string is present at either nesting.
  //
  // Every expectation below was derived by running BOTH implementations over
  // the same fixture and comparing the verdicts, not by reading the rules and
  // predicting. The harness is kit/lint/tests/differential-vs-codex.py; at the
  // time of writing it reported 38 of 38 cases in agreement. Re-run it against
  // a new Codex release rather than trusting these expectations to still hold.
  const agentFile = (body) => body;
  const validAgent = [
    'interface:',
    '  display_name: "Demo"',
    '  short_description: "A demo skill"',
    '  default_prompt: "Use $demo:demo to do the thing."',
    '',
    'policy:',
    '  allow_implicit_invocation: false',
    '',
  ].join('\n');
  const withAgent = (yaml, extra = {}) => ({
    'demo/SKILL.md': skillFile('demo', 'A demo skill.'),
    'demo/agents/openai.yaml': agentFile(yaml),
    ...extra,
  });

  it('accepts a conformant agent manifest', async () => {
    const dir = await makeSkillPlugin({ skills: withAgent(validAgent) });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('accepts a skill that ships no agent manifest', async () => {
    // Deliberate: presence is the caller's gate, and Codex's validator is only
    // reached for a manifest that exists. This pins the choice.
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': skillFile('demo', 'A demo skill with no agent manifest.') },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('rejects allow_implicit_invocation at the top level instead of under policy', async () => {
    // The exact shape that shipped in runtime:cutover.
    const dir = await makeSkillPlugin({
      skills: withAgent(
        ['display_name: Demo', 'description: A demo skill.', 'allow_implicit_invocation: false', ''].join('\n'),
      ),
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('field `allow_implicit_invocation` is not accepted by plugin validation'),
      `the misplaced policy key must be named; stderr=${result.stderr}`,
    );
    ok(result.stderr.includes('field `interface` must be an object'), `stderr=${result.stderr}`);
  });

  it('rejects a policy key whose colon has no separating space', async () => {
    // `allow_implicit_invocation:false` is ONE plain scalar to YAML, so
    // `policy` holds a string and Codex rejects it — while the text-level
    // regex in tests/plugin-shape still matches. This is the same
    // looks-opted-out-but-is-not defect in a different spelling.
    const dir = await makeSkillPlugin({
      skills: withAgent(validAgent.replace('allow_implicit_invocation: false', 'allow_implicit_invocation:false')),
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('a mapping key needs a space after its colon'), `stderr=${result.stderr}`);
  });

  it('rejects an unknown interface key', async () => {
    const dir = await makeSkillPlugin({
      skills: withAgent(validAgent.replace('  default_prompt:', '  prompt:')),
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('field `interface.prompt` is not accepted by plugin validation'),
      `stderr=${result.stderr}`,
    );
  });

  it('rejects an empty required interface field', async () => {
    const dir = await makeSkillPlugin({ skills: withAgent(validAgent.replace('"A demo skill"', '""')) });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('field `interface.short_description` must be non-empty'), `stderr=${result.stderr}`);
  });

  it('rejects an empty default_prompt but accepts an absent one', async () => {
    const empty = await runLint(
      await makeSkillPlugin({ skills: withAgent(validAgent.replace('"Use $demo:demo to do the thing."', '""')) }),
    );
    strictEqual(empty.code, 1);
    ok(result_includes(empty, 'field `interface.default_prompt` must be non-empty'), `stderr=${empty.stderr}`);
    const absent = await runLint(
      await makeSkillPlugin({
        skills: withAgent(validAgent.replace('  default_prompt: "Use $demo:demo to do the thing."\n', '')),
      }),
    );
    strictEqual(absent.code, 0, `an absent optional field is not an error; stderr=${absent.stderr}`);
  });

  it('rejects a dependencies sequence and accepts a tools mapping', async () => {
    // Codex requires `dependencies` to be a mapping whose only key is `tools`.
    // An earlier revision of this check treated the subtree as opaque and
    // accepted a sequence; the differential run caught it.
    const seq = await runLint(
      await makeSkillPlugin({ skills: withAgent(`${validAgent}\ndependencies:\n  - some-package\n`) }),
    );
    strictEqual(seq.code, 1);
    ok(result_includes(seq, 'field `dependencies` must be an object'), `stderr=${seq.stderr}`);
    const bad = await runLint(
      await makeSkillPlugin({ skills: withAgent(`${validAgent}\ndependencies:\n  packages: "x"\n`) }),
    );
    strictEqual(bad.code, 1);
    ok(result_includes(bad, 'field `dependencies.packages` is not accepted'), `stderr=${bad.stderr}`);
    const good = await runLint(
      await makeSkillPlugin({ skills: withAgent(`${validAgent}\ndependencies:\n  tools: "x"\n`) }),
    );
    strictEqual(good.code, 0, `stderr=${good.stderr}`);
  });

  it('rejects an icon path that names no file, escapes the plugin, or is absolute', async () => {
    for (const [value, expected] of [
      ['"missing.png"', 'points to a missing file'],
      ['"../../../etc/passwd"', 'must stay inside the plugin archive'],
      ['"/etc/passwd"', 'must stay inside the plugin archive'],
      ['""', 'must be a non-empty relative path'],
    ]) {
      const dir = await makeSkillPlugin({
        skills: withAgent(validAgent.replace('policy:', `  icon_small: ${value}\n\npolicy:`)),
      });
      const result = await runLint(dir);
      strictEqual(result.code, 1, `${value} must be rejected; stderr=${result.stderr}`);
      ok(result_includes(result, expected), `${value}: stderr=${result.stderr}`);
    }
  });

  it('accepts an icon path that names a real file inside the plugin', async () => {
    const dir = await makeSkillPlugin({
      skills: withAgent(validAgent.replace('policy:', '  icon_small: "icon.png"\n\npolicy:'), {
        'demo/icon.png': 'not really a png',
      }),
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('reads booleans the way YAML does, not by spelling', async () => {
    for (const literal of ['False', 'yes', 'off']) {
      const dir = await makeSkillPlugin({
        skills: withAgent(validAgent.replace('allow_implicit_invocation: false', `allow_implicit_invocation: ${literal}`)),
      });
      const result = await runLint(dir);
      strictEqual(result.code, 0, `${literal} is a YAML boolean; stderr=${result.stderr}`);
    }
    const quoted = await runLint(
      await makeSkillPlugin({
        skills: withAgent(validAgent.replace('allow_implicit_invocation: false', 'allow_implicit_invocation: "false"')),
      }),
    );
    strictEqual(quoted.code, 1);
    ok(result_includes(quoted, 'field `policy.allow_implicit_invocation` must be a boolean'), `stderr=${quoted.stderr}`);
  });

  it('accepts comments, including one trailing a boolean', async () => {
    const dir = await makeSkillPlugin({
      skills: withAgent(
        `# leading comment\n${validAgent.replace('allow_implicit_invocation: false', 'allow_implicit_invocation: false # explicit only')}`,
      ),
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `stderr=${result.stderr}`);
  });

  it('rejects a block scalar in a measured interface field rather than guessing at it', async () => {
    const dir = await makeSkillPlugin({
      skills: withAgent(
        ['interface:', '  display_name: "Demo"', '  short_description: |', '    two', '    lines', ''].join('\n'),
      ),
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result_includes(result, 'block scalar (| or >) is not measurable by this check'), `stderr=${result.stderr}`);
  });

  it('checks a second manifest that shares a symlinked SKILL.md', async () => {
    // The frontmatter scan deduplicates SKILL.md by real path. Keying the
    // manifest check off that set would skip the second skill's own manifest.
    const dir = await makeSkillPlugin({
      skills: {
        'one/SKILL.md': skillFile('one', 'First demo skill.'),
        'one/agents/openai.yaml': agentFile(validAgent),
        'two/agents/openai.yaml': agentFile('allow_implicit_invocation: false\n'),
      },
    });
    await symlink(join(dir, 'skills/one/SKILL.md'), join(dir, 'skills/two/SKILL.md'));
    const result = await runLint(dir);
    strictEqual(result.code, 1, `the second manifest must still be checked; stderr=${result.stderr}`);
    ok(result_includes(result, 'skills/two/agents/openai.yaml'), `stderr=${result.stderr}`);
  });

});
