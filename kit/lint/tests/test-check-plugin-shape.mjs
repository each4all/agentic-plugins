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

  // `skills` maps a skills-relative path (e.g. 'demo/SKILL.md') to its
  // full file content, so each test writes exactly the bytes under test.
  async function makeSkillPlugin({ skills = {}, declareSkills = false } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'kit-lint-skill-fm-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await mkdir(join(dir, '.codex-plugin'), { recursive: true });
    const manifest = { name: 'fixture-skill-fm', version: '0.0.1', description: 'skill frontmatter fixture' };
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
    await writeFile(
      join(dir, '.codex-plugin', 'plugin.json'),
      JSON.stringify(declareSkills ? { ...manifest, skills: './skills/' } : manifest, null, 2),
    );
    for (const [rel, content] of Object.entries(skills)) {
      const abs = join(dir, 'skills', rel);
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
    // 1000 filler + 24 decoded characters == exactly 1024 decoded, while the
    // raw frontmatter line is longer because each \" occupies two bytes. A
    // linter measuring raw text would wrongly reject this.
    const decodedTail = '\\"aaaaaaaaaa\\" bbbbbbbb';
    const dir = await makeSkillPlugin({
      skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1002) + decodedTail) },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 0, `decoded length is 1024 and must pass; stderr=${result.stderr}`);
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

  it('rejects CRLF frontmatter with the real reason', async () => {
    const body = '---\r\nname: demo\r\ndescription: "Fine."\r\n---\r\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('CRLF line endings'), `stderr=${result.stderr}`);
  });

  it('fails closed on a block-scalar description rather than guessing', async () => {
    const body = '---\nname: demo\ndescription: |\n  A block scalar description.\n---\n';
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': body } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('not measurable by this check'), `stderr=${result.stderr}`);
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

  it('scans the manifest-declared skills root too', async () => {
    const dir = await makeSkillPlugin({
      declareSkills: true,
      skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(2000)) },
    });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('description is too long (2000 characters'), `stderr=${result.stderr}`);
  });

  it('labels the offending skill by its plugin-relative path', async () => {
    const dir = await makeSkillPlugin({ skills: { 'demo/SKILL.md': skillFile('demo', 'x'.repeat(1100)) } });
    const result = await runLint(dir);
    strictEqual(result.code, 1);
    ok(result.stderr.includes('skills/demo/SKILL.md:'), `stderr=${result.stderr}`);
  });
});
