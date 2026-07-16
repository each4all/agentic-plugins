import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readUserGlobalModelEffort,
  readUserGlobalNotify,
  readUserGlobalClaudePermission,
  readUserGlobalCodexPermission,
  readUserGlobalEgress,
} from '../../plugins/runtime/scripts/lib/profile-readers.mjs';
import { EGRESS_ENV_KEYS } from '../../plugins/runtime/scripts/lib/egress-config.mjs';

// machine-bootstrap-contract.md §4.4 — a machine profile MUST read user-global
// config ONLY. These tests pin: no repo/repo-local value can enter the result;
// absent/malformed/unreadable are reported (not crashed); every value carries
// user-global provenance; and the egress reader is credential-independent + never
// exports a malformed or token-shaped routing value.

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'profile-readers-'));
  return home;
}
async function writeFileAt(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

describe('profile-readers §4.4: model/effort + notify (user-global runtime config)', () => {
  it('reads ONLY ~/.agentic-plugins/config.toml, carries user-global provenance', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'),
      'model = "opus"\nclaude_effort = "high"\nnotify_channel = "file-log"\n');
    const me = await readUserGlobalModelEffort({ homeDir: home });
    strictEqual(me.keys.model.value, 'opus');
    strictEqual(me.keys.model.provenance, 'user-global');
    strictEqual(me.keys.claude_effort.value, 'high');
    strictEqual(me.keys.codex_model.value, null, 'unset key → null');
    strictEqual(me.keys.codex_model.provenance, null);
    strictEqual(me.source.status, 'readable');

    const n = await readUserGlobalNotify({ homeDir: home });
    strictEqual(n.keys.notify_channel.value, 'file-log');
    strictEqual(n.keys.notify_channel.provenance, 'user-global');
    // notify reader surfaces ONLY notify keys, never model/effort.
    ok(!('model' in n.keys));
  });

  it('a repo .agentic-plugins/config.toml is structurally unreachable (reader takes only homeDir)', async () => {
    // The reader signature has no repoRoot: it CANNOT read repo config. This test
    // documents the §4.4 guarantee — a different repo value coexisting never leaks.
    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'), 'model = "user-opus"\n');
    // A repo config with a conflicting value sitting in the cwd is simply never consulted.
    const me = await readUserGlobalModelEffort({ homeDir: home });
    strictEqual(me.keys.model.value, 'user-opus');
  });

  it('absent user config → all keys null, status missing (never throws)', async () => {
    const home = await makeHome();
    const me = await readUserGlobalModelEffort({ homeDir: home });
    strictEqual(me.source.status, 'missing');
    for (const key of Object.keys(me.keys)) strictEqual(me.keys[key].value, null);
  });
});

describe('profile-readers §4.4: Claude permission (user settings.json only)', () => {
  it('reads only ~/.claude/settings.json; unions nothing; user-global provenance', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm)'], ask: ['WebFetch(domain:x)'], defaultMode: 'acceptEdits' },
    }));
    const p = await readUserGlobalClaudePermission({ homeDir: home });
    deepStrictEqual(p.allow, ['Bash(ls)']);
    deepStrictEqual(p.deny, ['Bash(rm)']);
    deepStrictEqual(p.ask, ['WebFetch(domain:x)']);
    strictEqual(p.default_mode, 'acceptEdits');
    strictEqual(p.provenance, 'user-global');
    strictEqual(p.source.status, 'readable');
  });

  it('malformed JSON → status malformed, empty buckets (never throws)', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.claude', 'settings.json'), '{ not json');
    const p = await readUserGlobalClaudePermission({ homeDir: home });
    strictEqual(p.source.status, 'malformed');
    deepStrictEqual(p.allow, []);
    strictEqual(p.default_mode, null);
  });

  it('a directory where settings.json should be → status unreadable (not missing)', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.claude', 'settings.json'), { recursive: true });
    const p = await readUserGlobalClaudePermission({ homeDir: home });
    strictEqual(p.source.status, 'unreadable');
  });

  it('absent → missing, empty buckets', async () => {
    const home = await makeHome();
    const p = await readUserGlobalClaudePermission({ homeDir: home });
    strictEqual(p.source.status, 'missing');
    deepStrictEqual(p.ask, []);
  });
});

describe('profile-readers §4.4: Codex permission (user config.toml only, NO projectTrusted)', () => {
  it('surfaces approval_policy/sandbox_mode with user-global provenance; never projectTrusted', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.codex', 'config.toml'),
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[projects."/some/repo"]\ntrust_level = "trusted"\n');
    const p = await readUserGlobalCodexPermission({ homeDir: home, env: {} });
    strictEqual(p.approval_policy, 'on-request');
    strictEqual(p.sandbox_mode, 'workspace-write');
    strictEqual(p.provenance, 'user-global');
    // The repo-keyed trust must NEVER appear in a machine profile.
    ok(!('project_trusted' in p));
    ok(!('projectTrusted' in p));
  });

  it('honors $CODEX_HOME override for the source', async () => {
    const home = await makeHome();
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'));
    await writeFileAt(join(codexHome, 'config.toml'), 'approval_policy = "untrusted"\n');
    const p = await readUserGlobalCodexPermission({ homeDir: home, env: { CODEX_HOME: codexHome } });
    strictEqual(p.approval_policy, 'untrusted');
    strictEqual(p.source.codex_home_source, 'CODEX_HOME env override');
  });

  it('absent → nulls, status missing', async () => {
    const home = await makeHome();
    const p = await readUserGlobalCodexPermission({ homeDir: home, env: {} });
    strictEqual(p.approval_policy, null);
    strictEqual(p.source.status, 'missing');
  });
});

describe('profile-readers §4.4: egress (credential-independent, secrets-free)', () => {
  it('surfaces channel+recipient from env EVEN WITHOUT the credential (unlike activation)', async () => {
    const home = await makeHome();
    const env = { [EGRESS_ENV_KEYS.channel]: 'telegram', [EGRESS_ENV_KEYS.recipient]: '123456789' };
    const e = readUserGlobalEgress({ homeDir: home, env });
    strictEqual(e.channel, 'telegram');
    strictEqual(e.recipient, '123456789', 'recipient exported even though TELEGRAM_BOT_TOKEN is absent');
    strictEqual(e.credential_present, false);
    strictEqual(e.provenance.channel, 'env');
    strictEqual(e.provenance.recipient, 'env');
  });

  it('invalid recipient → null (never exports a malformed chat-id)', async () => {
    const home = await makeHome();
    const env = { [EGRESS_ENV_KEYS.channel]: 'telegram', [EGRESS_ENV_KEYS.recipient]: 'not a chat id!!' };
    const e = readUserGlobalEgress({ homeDir: home, env });
    strictEqual(e.recipient, null);
    strictEqual(e.provenance.recipient, null);
    strictEqual(e.channel, 'telegram');
  });

  it('non-enum channel → null (never exports a token-shaped channel)', async () => {
    const home = await makeHome();
    const e = readUserGlobalEgress({ homeDir: home, env: { [EGRESS_ENV_KEYS.channel]: 'slack' } });
    strictEqual(e.channel, null);
  });

  it('collision with a present credential drops that field (secrets-free guard)', async () => {
    const home = await makeHome();
    const token = 'SECRET-BOT-TOKEN-123';
    const env = { [EGRESS_ENV_KEYS.channel]: 'telegram', [EGRESS_ENV_KEYS.recipient]: token, [EGRESS_ENV_KEYS.credential]: token };
    const e = readUserGlobalEgress({ homeDir: home, env });
    strictEqual(e.recipient, null, 'a recipient equal to the token is dropped, never exported');
    strictEqual(e.credential_present, true);
  });

  it('absent everywhere → nulls, headline false', async () => {
    const home = await makeHome();
    const e = readUserGlobalEgress({ homeDir: home, env: {} });
    strictEqual(e.channel, null);
    strictEqual(e.recipient, null);
    strictEqual(e.headline, false);
  });
});
