import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCodexPermissionConfigToml,
  readClaudePermissionConfig,
  readCodexPermissionConfig,
} from '../../plugins/runtime/scripts/lib/permission-config.mjs';

// The UNION readers lifted verbatim from settings.mjs (§1.3 extraction 4). These
// lock the union behavior — deliberately the OPPOSITE of the §4.4 user-global
// readers — so the two never get conflated: the planner unions repo+user, the
// profile export reads user only.

async function makeRepoHome() {
  const repo = await mkdtemp(join(tmpdir(), 'perm-config-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'perm-config-home-'));
  return { repo, home };
}
async function writeJsonAt(path, obj) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

describe('permission-config readClaudePermissionConfig (union)', () => {
  it('UNIONS repo + repo-local + user allow/deny/ask (the planner gather half)', async () => {
    const { repo, home } = await makeRepoHome();
    await writeJsonAt(join(repo, '.claude', 'settings.json'), { permissions: { allow: ['Bash(git)'] } });
    await writeJsonAt(join(repo, '.claude', 'settings.local.json'), { permissions: { deny: ['Bash(rm)'] } });
    await writeJsonAt(join(home, '.claude', 'settings.json'), { permissions: { allow: ['WebFetch(domain:x)'], ask: ['Bash(curl)'] } });
    const cfg = await readClaudePermissionConfig({ repoRoot: repo, homeDir: home });
    // repo AND user allow entries are unioned — this is exactly what §4.4 forbids for a profile.
    ok(cfg.allow.has('Bash(git)') && cfg.allow.has('WebFetch(domain:x)'));
    ok(cfg.deny.has('Bash(rm)'));
    ok(cfg.ask.has('Bash(curl)'));
  });

  it('resolves defaultMode repo-local > repo > user', async () => {
    const { repo, home } = await makeRepoHome();
    await writeJsonAt(join(repo, '.claude', 'settings.json'), { permissions: { defaultMode: 'plan' } });
    await writeJsonAt(join(repo, '.claude', 'settings.local.json'), { permissions: { defaultMode: 'acceptEdits' } });
    await writeJsonAt(join(home, '.claude', 'settings.json'), { permissions: { defaultMode: 'default' } });
    const cfg = await readClaudePermissionConfig({ repoRoot: repo, homeDir: home });
    strictEqual(cfg.defaultMode, 'acceptEdits');
  });

  it('classifies a malformed file as malformed (invalid_json semantics preserved through the lift)', async () => {
    const { repo, home } = await makeRepoHome();
    await writeJsonAt(join(home, '.claude', 'settings.json'), '{ not json');
    const cfg = await readClaudePermissionConfig({ repoRoot: repo, homeDir: home });
    const userSource = cfg.sources.find((s) => s.scope === 'user');
    strictEqual(userSource.status, 'malformed');
  });
});

describe('permission-config readCodexPermissionConfig', () => {
  it('reads user config + derives repo-keyed projectTrusted', async () => {
    const { repo, home } = await makeRepoHome();
    await writeJsonAt(join(home, '.codex', 'config.toml'),
      `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[projects."${repo}"]\ntrust_level = "trusted"\n`);
    const cfg = await readCodexPermissionConfig({ homeDir: home, env: {}, repoRoot: repo });
    strictEqual(cfg.approvalPolicy, 'on-request');
    strictEqual(cfg.sandboxMode, 'workspace-write');
    strictEqual(cfg.projectTrusted, true, 'projectTrusted is keyed on THIS repoRoot (the profile export drops it)');
  });

  it('parser extracts trusted projects and top-level posture', () => {
    const parsed = parseCodexPermissionConfigToml('approval_policy = "never"\n[projects."/a"]\ntrust_level = "trusted"\n');
    strictEqual(parsed.approvalPolicy, 'never');
    ok(parsed.trustedProjects.has('/a'));
  });
});
