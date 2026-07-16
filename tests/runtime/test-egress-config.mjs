// Tests for the ADR-0041 §2c E1 egress config layer (cfg subtask): the
// fail-closed verified-ignored-local reader and the SEPARATE E1 activation
// loader.
//
// These tests are the mechanical proof the ADR-0041 §10 owner-decision gate
// depends on: they demonstrate that egress activation (notify_channel-style
// "telegram" turn-on) + recipient can be resolved ONLY from the operator
// environment or a fail-closed-verified user-home local layer, and can NEVER
// be turned on by tracked repo config — so the §10 "ignored-local activation
// mechanically proven safe in arbitrary consumer repos" condition holds and
// the tier is Accept (not Forbid → Alternative A).
//
// Design under test (see egress-config.mjs header): the honored verified-local
// layer is user-home ONLY (~/.agentic-plugins/config.local.toml), never a
// repo-local file, and the inside-repo proof is MANDATORY (a missing repoRoot
// fails closed) so repo-controlled activation is structurally impossible rather
// than merely verified-against — and no git exec runs on the emit path.
//
// Ownership (uid) is exercised by INJECTING getuid so the suite is deterministic
// on any platform (a real process.getuid is not required to run these — the
// production default path is covered by one explicitly-guarded test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EGRESS_CHANNELS,
  EGRESS_ENV_KEYS,
  EGRESS_LOCAL_KEYS,
  EGRESS_LOCAL_FILENAME,
  egressLocalConfigPath,
  parseEgressLocalToml,
  readVerifiedIgnoredLocal,
  loadEgressActivation,
  loadEgressExportConfig,
} from '../../plugins/runtime/scripts/lib/egress-config.mjs';
import { NOTIFY_CHANNELS, CONFIG_KEYS } from '../../plugins/runtime/scripts/lib/runtime-config.mjs';

const HAS_GETUID = typeof process.getuid === 'function';
// Root bypasses discretionary file permissions, so an EACCES-on-read branch
// cannot be exercised as an unprivileged operator would.
const IS_ROOT = HAS_GETUID && process.getuid() === 0;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A repoRoot the honored user-home file must be OUTSIDE of. A plain existing
// dir suffices (the reader realpath-compares; it does not require a .git).
function makeRepoRoot() {
  const root = tmpDir('egress-repo-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

// Write a user-home verified-local file and return its path. mode defaults to
// 0600 (the operator-owned, not-group/other-writable happy shape).
function writeHomeLocal(home, body, { mode = 0o600 } = {}) {
  const dir = path.join(home, '.agentic-plugins');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, EGRESS_LOCAL_FILENAME);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}

// getuid injector that makes the ownership gate pass for a real file.
function ownerOf(file) {
  return () => fs.statSync(file).uid;
}

// ---------------------------------------------------------------------------
// parseEgressLocalToml — dedicated parser, egress keys ONLY
// ---------------------------------------------------------------------------

describe('egress-config parseEgressLocalToml', () => {
  it('extracts only the egress keys, quoted or bare', () => {
    const parsed = parseEgressLocalToml(
      'egress_channel = "telegram"\negress_chat_id = 123456789\n',
    );
    assert.equal(parsed.egress_channel, 'telegram');
    assert.equal(parsed.egress_chat_id, '123456789');
  });

  it('ignores comments, section headers, and unrelated keys', () => {
    const parsed = parseEgressLocalToml(
      '# egress config\n[section]\nnotify_channel = "file-log"\nmodel = "x"\negress_channel = "telegram"\n',
    );
    assert.deepEqual(parsed, { egress_channel: 'telegram' });
    assert.equal(parsed.notify_channel, undefined);
  });

  it('is CRLF-safe (mirrors parseRuntimeConfigToml)', () => {
    const parsed = parseEgressLocalToml('egress_channel = "telegram"\r\negress_chat_id = "42"\r\n');
    assert.equal(parsed.egress_channel, 'telegram');
    assert.equal(parsed.egress_chat_id, '42');
  });

  it('drops empty values', () => {
    assert.deepEqual(parseEgressLocalToml('egress_channel = ""\n'), {});
  });
});

// ---------------------------------------------------------------------------
// readVerifiedIgnoredLocal — fail-closed verification
// ---------------------------------------------------------------------------

describe('egress-config readVerifiedIgnoredLocal', () => {
  it('reads a regular, operator-owned, tight-perms file outside the repo', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n');
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo, getuid: ownerOf(file) });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'ok');
    assert.match(res.text, /telegram/);
  });

  it('exercises the real process.getuid default path', { skip: !HAS_GETUID }, () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n');
    // No getuid injected → uses process.getuid; the file is owned by the runner.
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo });
    assert.equal(res.ok, true);
  });

  it('fails closed without a repoRoot (inside-repo proof cannot run)', () => {
    const home = tmpDir('egress-home-');
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n');
    const res = readVerifiedIgnoredLocal({ filePath: file, getuid: ownerOf(file) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'repo-root-required');
  });

  it('treats an absent file as a benign no-op (not an error)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = readVerifiedIgnoredLocal({ filePath: egressLocalConfigPath(home), repoRoot: repo });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'absent');
    assert.equal(res.text, null);
  });

  it('rejects a symlink (O_NOFOLLOW), even to a valid file', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const dir = path.join(home, '.agentic-plugins');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(home, 'real.toml');
    fs.writeFileSync(target, 'egress_channel = "telegram"\n');
    const link = path.join(dir, EGRESS_LOCAL_FILENAME);
    fs.symlinkSync(target, link);
    const res = readVerifiedIgnoredLocal({ filePath: link, repoRoot: repo, getuid: ownerOf(target) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'symlink');
  });

  it('rejects a non-regular file (directory at the path)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const dir = path.join(home, '.agentic-plugins');
    fs.mkdirSync(path.join(dir, EGRESS_LOCAL_FILENAME), { recursive: true });
    const res = readVerifiedIgnoredLocal({ filePath: path.join(dir, EGRESS_LOCAL_FILENAME), repoRoot: repo });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-regular-file');
  });

  it('rejects a group/other-writable file', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n', { mode: 0o666 });
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo, getuid: ownerOf(file) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'insecure-permissions');
  });

  it('rejects a file not owned by the operator', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n');
    const wrongUid = () => fs.statSync(file).uid + 1;
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo, getuid: wrongUid });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-operator-owned');
  });

  it('fail-closes when ownership cannot be verified (no getuid, e.g. Windows)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n');
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo, getuid: null });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ownership-unverifiable');
  });

  it('rejects a file physically inside the repo tree (repo-controlled)', () => {
    const repo = makeRepoRoot();
    const dir = path.join(repo, '.agentic-plugins');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, EGRESS_LOCAL_FILENAME);
    fs.writeFileSync(file, 'egress_channel = "telegram"\n');
    fs.chmodSync(file, 0o600);
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo, getuid: ownerOf(file) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'inside-repo');
  });

  it('fail-closes an unreadable file (EACCES)', { skip: IS_ROOT }, () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\n', { mode: 0o000 });
    const res = readVerifiedIgnoredLocal({ filePath: file, repoRoot: repo });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unreadable');
    fs.chmodSync(file, 0o600); // restore so the temp dir is cleanable
  });
});

// ---------------------------------------------------------------------------
// loadEgressActivation — the separate E1 activation loader
// ---------------------------------------------------------------------------

describe('egress-config loadEgressActivation', () => {
  it('is inactive with no env and no local file (missing-activation)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = loadEgressActivation({ repoRoot: repo, homeDir: home, env: {} });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-activation');
    assert.equal(res.credentialPresent, false);
  });

  it('a token ALONE never activates egress (§2c)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: { [EGRESS_ENV_KEYS.credential]: '123:ABCtoken' },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-activation');
    assert.equal(res.credentialPresent, true);
  });

  it('activation + token but no recipient is inactive (missing-recipient)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.channel]: 'telegram',
        [EGRESS_ENV_KEYS.credential]: '123:ABCtoken',
      },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-recipient');
  });

  it('activation + recipient but no credential is inactive (missing-credential)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.channel]: 'telegram',
        [EGRESS_ENV_KEYS.recipient]: '999',
      },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-credential');
  });

  it('activates fully from env (channel + recipient + credential)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.channel]: 'telegram',
        [EGRESS_ENV_KEYS.recipient]: '999',
        [EGRESS_ENV_KEYS.credential]: '123:ABCtoken',
      },
    });
    assert.equal(res.active, true);
    assert.equal(res.reason, 'active');
    assert.equal(res.channel, 'telegram');
    assert.equal(res.recipient, '999');
    assert.equal(res.credentialPresent, true);
    assert.equal(res.source, 'env');
  });

  it('activates from a verified-local file for channel+recipient, credential from env', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\negress_chat_id = "555"\n');
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: { [EGRESS_ENV_KEYS.credential]: '123:ABCtoken' },
      getuid: ownerOf(file),
    });
    assert.equal(res.active, true);
    assert.equal(res.channel, 'telegram');
    assert.equal(res.recipient, '555');
    assert.equal(res.source, 'verified-local');
  });

  it('env overrides the verified-local file (precedence)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const file = writeHomeLocal(home, 'egress_channel = "telegram"\negress_chat_id = "555"\n');
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.recipient]: '777',
        [EGRESS_ENV_KEYS.credential]: '123:ABCtoken',
      },
      getuid: ownerOf(file),
    });
    assert.equal(res.active, true);
    assert.equal(res.recipient, '777');
    assert.equal(res.channel, 'telegram'); // from the local file
  });

  it('rejects an unknown egress channel and never echoes its raw value', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.channel]: 'slack',
        [EGRESS_ENV_KEYS.recipient]: '999',
        [EGRESS_ENV_KEYS.credential]: '123:ABCtoken',
      },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'unknown-egress-channel');
    assert.equal(res.channel, null); // enum-safe echo only — 'slack' is not surfaced
  });

  it('refuses to activate when a resolved scalar collides with the credential (no leak)', () => {
    // Operator typo: chat-id env accidentally set to the bot token value.
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const token = '7654321:SECRET-token';
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.channel]: 'telegram',
        [EGRESS_ENV_KEYS.recipient]: token,
        [EGRESS_ENV_KEYS.credential]: token,
      },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'credential-collision');
    assert.equal(res.recipient, null);
    assert.equal(JSON.stringify(res).includes(token), false);
  });

  it('IGNORES egress keys placed in tracked repo config.toml AND user config.toml', () => {
    // The load-bearing §2c safety proof: the loader reads config.local.toml
    // only — never the loadNotifyConfig repo/user config.toml layers. Planting
    // activation in BOTH tracked layers must NOT activate egress.
    const repo = makeRepoRoot();
    fs.mkdirSync(path.join(repo, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.agentic-plugins', 'config.toml'),
      'egress_channel = "telegram"\negress_chat_id = "attacker"\n',
    );
    const home = tmpDir('egress-home-');
    fs.mkdirSync(path.join(home, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agentic-plugins', 'config.toml'),
      'egress_channel = "telegram"\negress_chat_id = "attacker"\n',
    );
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: { [EGRESS_ENV_KEYS.credential]: '123:ABCtoken' },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-activation');
  });

  it('IGNORES the dangerous notify_channel="telegram" shape in tracked config', () => {
    // Regression guard for future notify/egress coupling: even the ADR's named
    // danger shape in tracked config must never reach the egress loader.
    const repo = makeRepoRoot();
    fs.mkdirSync(path.join(repo, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.agentic-plugins', 'config.toml'),
      'notify_channel = "telegram"\negress_chat_id = "attacker"\n',
    );
    const home = tmpDir('egress-home-');
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: { [EGRESS_ENV_KEYS.credential]: '123:ABCtoken' },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-activation');
  });

  it('does NOT honor an unsafe (symlinked) verified-local file', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const dir = path.join(home, '.agentic-plugins');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(home, 'real.toml');
    fs.writeFileSync(target, 'egress_channel = "telegram"\negress_chat_id = "555"\n');
    fs.symlinkSync(target, path.join(dir, EGRESS_LOCAL_FILENAME));
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: { [EGRESS_ENV_KEYS.credential]: '123:ABCtoken' },
    });
    assert.equal(res.active, false);
    assert.equal(res.reason, 'missing-activation');
    assert.equal(res.localReason, 'symlink');
  });

  it('never returns the credential value anywhere in the result (§2b)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    const token = '7654321:SUPERSECRET-bot-token-value';
    const res = loadEgressActivation({
      repoRoot: repo,
      homeDir: home,
      env: {
        [EGRESS_ENV_KEYS.channel]: 'telegram',
        [EGRESS_ENV_KEYS.recipient]: '999',
        [EGRESS_ENV_KEYS.credential]: token,
      },
    });
    assert.equal(res.active, true);
    assert.equal(res.credentialPresent, true);
    assert.equal(JSON.stringify(res).includes(token), false);
    for (const value of Object.values(res)) {
      assert.notEqual(value, token);
    }
  });
});

// ---------------------------------------------------------------------------
// Separation invariants — E1 must never ride the shared notify_channel enum
// ---------------------------------------------------------------------------

describe('egress-config separation invariants', () => {
  it('telegram is NOT a NOTIFY_CHANNELS value (never rides the tracked enum)', () => {
    assert.equal(NOTIFY_CHANNELS.includes('telegram'), false);
  });

  it('exposes telegram only through the SEPARATE EGRESS_CHANNELS enum', () => {
    assert.deepEqual([...EGRESS_CHANNELS], ['telegram']);
  });

  it('egress keys are NOT part of the tracked CONFIG_KEYS surface', () => {
    // If they were, the settings planner would plan them into tracked
    // config.toml and echo them to artifacts (ADR-0041 §2c/§5 violation).
    assert.equal(CONFIG_KEYS.includes(EGRESS_LOCAL_KEYS.channel), false);
    assert.equal(CONFIG_KEYS.includes(EGRESS_LOCAL_KEYS.recipient), false);
  });

  it('the honored local path is user-home config.local.toml', () => {
    assert.equal(
      egressLocalConfigPath('/home/op'),
      path.join('/home/op', '.agentic-plugins', 'config.local.toml'),
    );
  });
});

// ---------------------------------------------------------------------------
// loadEgressExportConfig — the §4.4 profile export reader (credential-independent)
// ---------------------------------------------------------------------------

describe('egress-config loadEgressExportConfig', () => {
  it('surfaces channel+recipient from a verified-local file with verified-local provenance', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    writeHomeLocal(home, 'egress_channel = "telegram"\negress_chat_id = "555"\n');
    const e = loadEgressExportConfig({ repoRoot: repo, homeDir: home, env: {} });
    assert.equal(e.channel, 'telegram');
    assert.equal(e.recipient, '555');
    assert.equal(e.provenance.channel, 'verified-local');
    assert.equal(e.provenance.recipient, 'verified-local');
    // Credential-independent: the SAME facts leave loadEgressActivation inactive
    // (missing-credential), but the export reader still surfaces the routing config.
    const act = loadEgressActivation({ repoRoot: repo, homeDir: home, env: {} });
    assert.equal(act.active, false);
    assert.equal(act.reason, 'missing-credential');
    assert.equal(act.recipient, null);
  });

  it('env overrides verified-local (env-first precedence, shared with activation)', () => {
    const home = tmpDir('egress-home-');
    const repo = makeRepoRoot();
    writeHomeLocal(home, 'egress_channel = "telegram"\negress_chat_id = "555"\n');
    const e = loadEgressExportConfig({
      repoRoot: repo,
      homeDir: home,
      env: { [EGRESS_ENV_KEYS.recipient]: '999' },
    });
    assert.equal(e.recipient, '999');
    assert.equal(e.provenance.recipient, 'env');
    assert.equal(e.channel, 'telegram');
    assert.equal(e.provenance.channel, 'verified-local');
  });
});
