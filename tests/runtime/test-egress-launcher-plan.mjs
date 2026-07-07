// ADR-0041 §12 — runtime:settings --egress-launcher-plan (first-class egress launcher).
//
// The launcher is an ARTIFACT-ONLY PLANNER: it reads the current egress
// activation state + the personal ~/.claude prototype hooks READ-ONLY and
// records a per-machine activation runbook, but writes NOTHING except the plan
// artifact under .agentic-plugins/runs/egress-launcher/. These tests prove:
//   - the state-aware MODE matrix (activate / partial / prototype-retire-only /
//     already-active) from (activation descriptor × prototype detection);
//   - prototype detection is exact-path, fail-closed, and READ-ONLY;
//   - the layout renderers never emit a real token and pre-fill the chat-id only
//     when it is known;
//   - the boundary-invariant validator refuses to write any artifact claiming a
//     write, and the scrubSecrets pass fail-closes on a secret-shaped value;
//   - NO-MUTATION: a full build changes nothing under HOME (settings.json
//     byte-identical, config.local.toml never created) and writes ONLY under
//     runs/egress-launcher/ in the repo;
//   - the credential is NEVER read into the artifact (deterministic leak scan).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  EGRESS_LAUNCHER_ARTIFACT_FAMILY,
  EGRESS_LAUNCHER_PLAN_KIND,
  EGRESS_LAUNCHER_PLAN_SCHEMA_VERSION,
  EGRESS_LAUNCHER_PLAN_LATEST_SCHEMA_VERSION,
  buildEgressLauncherPlan,
  computeEgressLauncherMode,
  detectPrototypeHooks,
  isValidEgressLauncherPlanArtifact,
  isValidEgressLauncherRunId,
  makeEgressLauncherRunId,
  renderConfigLocalTomlBlock,
  renderEnvLayoutBlock,
  renderTokenEnvLine,
  writeEgressLauncherPlanArtifact,
} from '../../plugins/runtime/scripts/lib/egress-launcher-plan.mjs';
import { CONFIG_KEYS } from '../../plugins/runtime/scripts/lib/runtime-config.mjs';
import { EGRESS_LOCAL_KEYS, EGRESS_HEADLINE_LOCAL_KEY, redactEgressCredentialFromEnv } from '../../plugins/runtime/scripts/lib/egress-config.mjs';
import { runSettings } from '../../plugins/runtime/scripts/settings.mjs';

const FAKE_TOKEN = '1234567890:AAFakeFakeFakeFakeFakeFakeFakeFakeFa'; // telegram-token SHAPE
const CHAT_ID = '8468724389';
const NOW = new Date('2026-07-07T12:40:00.000Z');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A fresh empty HOME with no ~/.claude, no ~/.agentic-plugins.
function freshHome() {
  return tmp('egl-home-');
}

// A HOME whose ~/.claude/settings.json wires N prototype hooks (+ the script).
function homeWithPrototype(hookEvents = ['Notification', 'Stop'], { unrelated = true, dropScript = true } = {}) {
  const home = tmp('egl-proto-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const protoCmd = `node ${join(home, '.claude', 'telegram-notify.mjs')}`;
  const hooks = {};
  for (const ev of hookEvents) {
    hooks[ev] = [{ matcher: '', hooks: [{ type: 'command', command: protoCmd }] }];
  }
  if (unrelated) {
    hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo unrelated-hook' }] }];
  }
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2));
  if (dropScript) writeFileSync(join(home, '.claude', 'telegram-notify.mjs'), '// prototype');
  return home;
}

function activeEnv(extra = {}) {
  return {
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_CHAT_ID: CHAT_ID,
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    ...extra,
  };
}

async function build({ env = {}, homeDir, host = 'claude' }) {
  const repoRoot = tmp('egl-repo-');
  const res = await buildEgressLauncherPlan({ repoRoot, homeDir, env, host, now: NOW });
  const artPath = join(repoRoot, res.artifact.report_pointer);
  const raw = readFileSync(artPath, 'utf8');
  return { repoRoot, res, artPath, raw, artifact: JSON.parse(raw) };
}

// Recursive relpath→sha256 map of a directory tree (missing dir → empty map).
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        out.set(relative(root, abs), createHash('sha256').update(readFileSync(abs)).digest('hex'));
      }
    }
  };
  walk(root);
  return out;
}

describe('egress-launcher-plan — mode matrix', () => {
  it('fresh machine (nothing set) → activate', async () => {
    const { res } = await build({ env: {}, homeDir: freshHome() });
    strictEqual(res.mode, 'activate');
    strictEqual(res.activation_state.active, false);
    strictEqual(res.activation_state.recipient, null); // not surfaced when inactive
  });

  it('channel+recipient set, token missing → partial', async () => {
    const env = { AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_CHAT_ID: CHAT_ID };
    const { res } = await build({ env, homeDir: freshHome() });
    strictEqual(res.mode, 'partial');
    strictEqual(res.activation_state.reason, 'missing-credential');
  });

  it('active via env, prototype absent → already-active (no-op verification plan)', async () => {
    const { res } = await build({ env: activeEnv(), homeDir: freshHome() });
    strictEqual(res.mode, 'already-active');
    strictEqual(res.activation_state.active, true);
    strictEqual(res.activation_state.recipient, CHAT_ID); // surfaced when active
    const activate = res.steps.find((s) => s.id === 'activate-egress');
    const retire = res.steps.find((s) => s.id === 'retire-prototype');
    strictEqual(activate.applicable, false);
    strictEqual(retire.applicable, false);
    ok(res.steps.find((s) => s.id === 'verify').applicable);
    ok(res.steps.find((s) => s.id === 'per-machine').applicable);
  });

  it('active AND prototype still wired → prototype-retire-only', async () => {
    const { res } = await build({ env: activeEnv(), homeDir: homeWithPrototype() });
    strictEqual(res.mode, 'prototype-retire-only');
    const retire = res.steps.find((s) => s.id === 'retire-prototype');
    strictEqual(retire.applicable, true);
    strictEqual(retire.hooks_to_remove.length, 2);
    ok(res.steps.find((s) => s.id === 'rollback').applicable);
  });

  it('computeEgressLauncherMode is pure over (activation × prototype)', () => {
    const proto0 = { match_count: 0 };
    const proto1 = { match_count: 1 };
    strictEqual(computeEgressLauncherMode({ activation: { active: true }, prototype: proto0 }), 'already-active');
    strictEqual(computeEgressLauncherMode({ activation: { active: true }, prototype: proto1 }), 'prototype-retire-only');
    strictEqual(computeEgressLauncherMode({ activation: { active: false, reason: 'missing-activation' }, prototype: proto0 }), 'activate');
    strictEqual(computeEgressLauncherMode({ activation: { active: false, reason: 'missing-recipient' }, prototype: proto0 }), 'partial');
    strictEqual(computeEgressLauncherMode({ activation: { active: false, reason: 'credential-collision' }, prototype: proto0 }), 'partial');
  });
});

describe('egress-launcher-plan — prototype detection (exact-path, read-only, fail-closed)', () => {
  it('detects prototype hooks by exact path and ignores unrelated hooks', async () => {
    const det = await detectPrototypeHooks({ homeDir: homeWithPrototype(['Notification', 'Stop']) });
    strictEqual(det.match_count, 2);
    deepStrictEqual(det.matches.map((m) => m.event).sort(), ['Notification', 'Stop']);
    ok(!det.matches.some((m) => m.command_pointer.includes('unrelated')));
    strictEqual(det.script_file_present, true);
  });

  it('tolerates an array-valued hooks and a missing settings.json (fail-closed → no matches)', async () => {
    // array-shaped hooks (observed empty [] in the wild)
    const homeArr = tmp('egl-arr-');
    mkdirSync(join(homeArr, '.claude'), { recursive: true });
    writeFileSync(join(homeArr, '.claude', 'settings.json'), JSON.stringify({ hooks: [] }));
    const arr = await detectPrototypeHooks({ homeDir: homeArr });
    strictEqual(arr.settings_present, true);
    strictEqual(arr.match_count, 0);
    // absent settings.json
    const absent = await detectPrototypeHooks({ homeDir: freshHome() });
    strictEqual(absent.settings_present, false);
    strictEqual(absent.match_count, 0);
  });

  it('unparseable settings.json fails closed without throwing', async () => {
    const home = tmp('egl-bad-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    const det = await detectPrototypeHooks({ homeDir: home });
    strictEqual(det.settings_present, true);
    strictEqual(det.parseable, false);
    strictEqual(det.match_count, 0);
  });

  it('detection leaves settings.json byte-identical (READ-ONLY)', async () => {
    const home = homeWithPrototype();
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    await detectPrototypeHooks({ homeDir: home });
    await detectPrototypeHooks({ homeDir: home });
    strictEqual(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), before);
  });
});

describe('egress-launcher-plan — layout renderers (never a real token)', () => {
  it('config.local.toml block pre-fills a known chat-id and omits the token', () => {
    const block = renderConfigLocalTomlBlock({ chatId: CHAT_ID, headlineOn: false });
    match(block, /egress_channel = "telegram"/);
    match(block, new RegExp(`egress_chat_id = "${CHAT_ID}"`));
    ok(!block.includes(FAKE_TOKEN));
    ok(!block.includes('TELEGRAM_BOT_TOKEN'));
    match(block, /# egress_headline = true/); // commented when off
  });

  it('config.local.toml block placeholders an unknown chat-id and un-comments headline when on', () => {
    const block = renderConfigLocalTomlBlock({ chatId: null, headlineOn: true });
    match(block, /egress_chat_id = "<YOUR_TELEGRAM_CHAT_ID>"/);
    match(block, /^egress_headline = true/m); // un-commented when on
  });

  it('token env line is always a literal placeholder, never a real value', () => {
    const line = renderTokenEnvLine();
    match(line, /export TELEGRAM_BOT_TOKEN="<your Telegram bot token>"/);
    ok(!line.includes(FAKE_TOKEN));
  });

  it('env-all layout carries channel+chat-id+placeholder-token', () => {
    const block = renderEnvLayoutBlock({ chatId: CHAT_ID, headlineOn: false });
    match(block, /export AGENTIC_NOTIFY_EGRESS_CHANNEL="telegram"/);
    match(block, new RegExp(`export TELEGRAM_CHAT_ID="${CHAT_ID}"`));
    ok(!block.includes(FAKE_TOKEN));
  });
});

describe('egress-launcher-plan — artifact contract + boundary invariant', () => {
  function validArtifact() {
    return {
      schema_version: EGRESS_LAUNCHER_PLAN_SCHEMA_VERSION,
      runtime_version: '9.9.9',
      kind: EGRESS_LAUNCHER_PLAN_KIND,
      run_id: makeEgressLauncherRunId(NOW),
      surface: 'settings',
      status: 'planned',
      created_at: NOW.toISOString(),
      repo_root_pointer: '.',
      host: 'claude',
      mode: 'already-active',
      activation_state: { active: true },
      prototype: { match_count: 0 },
      steps: [],
      limits: ['x'],
      boundary: {
        writes_host_config: false, writes_activation: false,
        writes_credential: false, installs_anything: false,
      },
    };
  }

  it('accepts a well-formed artifact', () => {
    ok(isValidEgressLauncherPlanArtifact(validArtifact()));
  });

  it('run-id format is validated', () => {
    ok(isValidEgressLauncherRunId(makeEgressLauncherRunId(NOW)));
    ok(!isValidEgressLauncherRunId('notification-20260707T124000Z-abcdef'));
  });

  for (const flag of ['writes_host_config', 'writes_activation', 'writes_credential', 'installs_anything']) {
    it(`rejects an artifact whose boundary.${flag} is true`, () => {
      const a = validArtifact();
      a.boundary[flag] = true;
      ok(!isValidEgressLauncherPlanArtifact(a));
    });
  }

  it('rejects unknown top-level keys, bad host, bad mode', () => {
    const a1 = validArtifact(); a1.sneaky = 1; ok(!isValidEgressLauncherPlanArtifact(a1));
    const a2 = validArtifact(); a2.host = 'auto'; ok(!isValidEgressLauncherPlanArtifact(a2));
    const a3 = validArtifact(); a3.mode = 'bogus'; ok(!isValidEgressLauncherPlanArtifact(a3));
  });

  it('writeEgressLauncherPlanArtifact rejects a malformed artifact', async () => {
    const repoRoot = tmp('egl-repo-');
    const bad = validArtifact(); bad.boundary.writes_activation = true;
    await rejects(() => writeEgressLauncherPlanArtifact({ repoRoot, artifact: bad }), /failed validation/);
  });

  it('writeEgressLauncherPlanArtifact fail-closes on a secret-shaped value (scrub gate)', async () => {
    const repoRoot = tmp('egl-repo-');
    const leaky = validArtifact();
    // Smuggle a bearer token into a surfaced field — the scrub gate must catch it.
    leaky.limits = ['Authorization: bearer sk-abcdef0123456789abcdef'];
    await rejects(() => writeEgressLauncherPlanArtifact({ repoRoot, artifact: leaky }), /secret-shaped value/);
  });
});

describe('egress-launcher-plan — artifact shape + schema', () => {
  it('writes plan.json under runs/egress-launcher/<run-id>/ and a latest.json pointer', async () => {
    const { repoRoot, res, artifact } = await build({ env: activeEnv(), homeDir: freshHome() });
    match(res.artifact.report_pointer, /^\.agentic-plugins\/runs\/egress-launcher\/egress-launcher-\d{8}T\d{6}Z-[0-9a-f]{6}\/plan\.json$/);
    ok(isValidEgressLauncherPlanArtifact(artifact));
    strictEqual(artifact.schema_version, EGRESS_LAUNCHER_PLAN_SCHEMA_VERSION);
    const latest = JSON.parse(readFileSync(join(repoRoot, res.artifact.latest_pointer), 'utf8'));
    strictEqual(latest.schema_version, EGRESS_LAUNCHER_PLAN_LATEST_SCHEMA_VERSION);
    strictEqual(latest.family ?? EGRESS_LAUNCHER_ARTIFACT_FAMILY, EGRESS_LAUNCHER_ARTIFACT_FAMILY);
    strictEqual(latest.run_id, artifact.run_id);
  });
});

describe('egress-launcher-plan — NO-MUTATION + credential leak scan', () => {
  it('a full build changes NOTHING under HOME and writes ONLY under runs/egress-launcher/', async () => {
    const home = homeWithPrototype(); // has ~/.claude/settings.json + prototype script
    const repoRoot = tmp('egl-repo-');
    const homeBefore = snapshotTree(home);
    const repoBefore = snapshotTree(repoRoot);

    await buildEgressLauncherPlan({ repoRoot, homeDir: home, env: activeEnv(), host: 'claude', now: NOW });

    // HOME is byte-identical — no config.local.toml created, settings.json untouched.
    deepStrictEqual(snapshotTree(home), homeBefore, 'HOME tree must be unchanged');
    ok(!statSyncExists(join(home, '.agentic-plugins', 'config.local.toml')), 'config.local.toml must never be created');

    // The only new repo files are under .agentic-plugins/runs/egress-launcher/.
    const repoAfter = snapshotTree(repoRoot);
    for (const key of repoAfter.keys()) {
      if (repoBefore.has(key)) continue;
      ok(
        key.startsWith(join('.agentic-plugins', 'runs', 'egress-launcher') + '/')
          || key.startsWith('.agentic-plugins/runs/egress-launcher/'),
        `unexpected write outside runs/egress-launcher: ${key}`,
      );
    }
  });

  it('the credential is NEVER read into the artifact (deterministic leak scan)', async () => {
    const { raw, artifact } = await build({ env: activeEnv(), homeDir: homeWithPrototype() });
    ok(!raw.includes(FAKE_TOKEN), 'token must be absent from artifact bytes');
    strictEqual(artifact.activation_state.credential_present, true); // presence only
    ok(!('credential' in artifact.activation_state));
    ok(!JSON.stringify(artifact).includes(FAKE_TOKEN));
  });
});

describe('egress-launcher-plan — §2c: egress keys stay OUT of runtime-config CONFIG_KEYS', () => {
  it('no egress_* activation/opt-in key is a plannable CONFIG_KEY (so --apply can never write them)', () => {
    const egressKeys = [...Object.values(EGRESS_LOCAL_KEYS), EGRESS_HEADLINE_LOCAL_KEY];
    for (const k of egressKeys) {
      ok(!CONFIG_KEYS.includes(k), `${k} must not be a runtime-config CONFIG_KEY (§2c)`);
    }
  });
});

describe('egress-launcher-plan — Codex review hardening', () => {
  it('MAJOR: redactEgressCredentialFromEnv removes only the credential, keeps other keys', () => {
    const out = redactEgressCredentialFromEnv({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID, PATH: '/x' });
    ok(!('TELEGRAM_BOT_TOKEN' in out), 'credential key removed');
    strictEqual(out.TELEGRAM_CHAT_ID, CHAT_ID); // chat-id is routing, not a secret — kept
    strictEqual(out.PATH, '/x');
  });

  it('MAJOR: runSettings never lets the credential reach a subprocess runner or the report', async () => {
    const repoRoot = tmp('egl-repo-');
    const home = freshHome();
    const seenEnvs = [];
    // Mimic Codex's reproduction: a runner that ECHOES whatever token it receives.
    // With the fix, opts.env carries no TELEGRAM_BOT_TOKEN, so it echoes nothing.
    const recordingRunner = async (_command, _args, opts = {}) => {
      const env = opts.env ?? {};
      seenEnvs.push(env);
      return { ok: false, exit_code: 0, stdout: env.TELEGRAM_BOT_TOKEN ?? '', stderr: '' };
    };
    const report = await runSettings({
      repoRoot, homeDir: home, env: activeEnv(), host: 'claude',
      egressLauncherPlan: true, runner: recordingRunner,
    });
    // The launcher STILL detects the credential as present (it read the real env).
    strictEqual(report.egress_launcher_plan.activation_state.credential_present, true);
    // But the token reaches NEITHER the report NOR any subprocess env.
    ok(!JSON.stringify(report).includes(FAKE_TOKEN), 'token absent from settings report');
    ok(seenEnvs.length > 0, 'doctor probes invoked the runner');
    for (const e of seenEnvs) {
      ok(!('TELEGRAM_BOT_TOKEN' in e), 'subprocess env must not carry the credential key');
    }
  });

  it('MINOR: an @channelusername recipient is pre-filled, not placeholdered', () => {
    const block = renderConfigLocalTomlBlock({ chatId: '@mychannel', headlineOn: false });
    match(block, /egress_chat_id = "@mychannel"/);
    ok(!block.includes('<YOUR_TELEGRAM_CHAT_ID>'));
  });

  it('MINOR: a superstring path (telegram-notify.mjs.backup) is NOT flagged as the prototype', async () => {
    const home = tmp('egl-super-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const backup = `node ${join(home, '.claude', 'telegram-notify.mjs')}.backup`;
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: backup }] }] } }));
    strictEqual((await detectPrototypeHooks({ homeDir: home })).match_count, 0);
  });

  it('MINOR: the exact prototype path WITH trailing args is still flagged (boundary fix keeps true positives)', async () => {
    const home = tmp('egl-args-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const withArgs = `node ${join(home, '.claude', 'telegram-notify.mjs')} --flag`;
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: withArgs }] }] } }));
    strictEqual((await detectPrototypeHooks({ homeDir: home })).match_count, 1);
  });

  it('MINOR: a PREFIXED absolute path (/tmp/prefix<home>/.claude/…) is NOT flagged (Codex re-review: leading boundary)', async () => {
    const home = tmp('egl-prefix-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    // The real prototype path appears only as a SUFFIX of a different absolute path.
    const prefixed = `node /tmp/prefix${join(home, '.claude', 'telegram-notify.mjs')}`;
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: prefixed }] }] } }));
    strictEqual((await detectPrototypeHooks({ homeDir: home })).match_count, 0);
  });
});

function statSyncExists(p) {
  try { statSync(p); return true; } catch { return false; }
}
