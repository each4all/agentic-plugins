// tests/runtime/test-machine-profile.mjs — machine-bootstrap-contract.md §4;
// §11.2 tests #4 (round-trip), #5 (user-global-only), #6 (secret fail-close),
// #7 (loader isolation).
//
// The profile's load-bearing invariant is that it is an UNTRUSTED source of interview
// defaults — never configuration to apply, never an input to an activation loader. So
// the tests here are mostly about what the profile CANNOT do.

import { before, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  EGRESS_CREDENTIAL_ENV_VAR,
  UNSAFE_CLAUDE_MODES,
  assertProfileWritable,
  buildMachineProfile,
  canonicalProfile,
  findSecretShapedValues,
  hashHostname,
  profileHash,
  profileWriteGate,
  seedProposals,
} from '../../plugins/runtime/scripts/lib/machine-profile.mjs';
import { loadSchema, makeValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import {
  readUserGlobalClaudePermission,
  readUserGlobalCodexPermission,
  readUserGlobalModelEffort,
  readUserGlobalNotify,
} from '../../plugins/runtime/scripts/lib/profile-readers.mjs';
import { readMachineProfile, writeMachineProfile } from '../../plugins/runtime/scripts/lib/bootstrap-artifacts.mjs';

const NOW = new Date('2026-07-17T09:00:00Z');

// §4.5.1 — seed validates the incoming profile EXACTLY before presenting anything.
let seedValidate;
before(async () => { seedValidate = await makeValidator('agentic-machine-profile'); });
const RUNTIME_SCRIPTS = new URL('../../plugins/runtime/scripts/', import.meta.url).pathname;

function baseReaders(over = {}) {
  return {
    modelEffort: { family: 'model_effort', keys: { model: { value: 'opus', provenance: 'user-global' }, effort: { value: 'high', provenance: 'user-global' }, claude_model: { value: null, provenance: null }, claude_effort: { value: null, provenance: null }, codex_model: { value: null, provenance: null }, codex_effort: { value: null, provenance: null } } },
    notify: { family: 'notify', keys: { notify_channel: { value: 'file-log', provenance: 'user-global' }, notify_quiet_hours: { value: '22:00-08:00', provenance: 'user-global' }, notify_quiet_hours_tz: { value: 'Asia/Seoul', provenance: 'user-global' }, notify_dedupe_ttl_seconds: { value: '300', provenance: 'user-global' }, notify_urgent_bypass_quiet_hours: { value: 'true', provenance: 'user-global' }, notify_kinds: { value: null, provenance: null } } },
    claudePermission: { allow: ['Bash(ls:*)'], ask: [], deny: [], default_mode: 'acceptEdits', provenance: 'user-global' },
    codexPermission: { approval_policy: 'on-request', sandbox_mode: 'workspace-write', provenance: 'user-global' },
    egress: { channel: 'telegram', recipient: '123456789', headline: false, credential_present: true, provenance: { channel: 'env', recipient: 'env', headline: 'user-global' } },
    ...over,
  };
}

const PROBE = {
  probed_at: '2026-07-17T09:00:00Z',
  runtime_version: '0.80.1',
  hosts: {
    claude: { cli_version: '2.1.208', auth: 'available', marketplace: 'registered', plugins: { runtime: { version: '0.80.1', state: 'installed' }, companions: { version: '0.3.0', state: 'installed' } } },
    codex: { cli_version: '0.144.1', auth: 'available', marketplace: 'registered', plugins: { runtime: { version: '0.80.1', state: 'installed' }, companions: { version: '0.3.0', state: 'installed' } } },
  },
};

const SELECTION = { bundle: 'base', desired: ['runtime', 'companions'], excluded: [] };

function build(over = {}) {
  return buildMachineProfile({ readers: baseReaders(over.readers), probe: PROBE, selection: SELECTION, runtimeVersion: '0.80.1', hostname: 'my-laptop.local', now: NOW, ...over });
}

describe('runtime machine profile — build (§4.1)', () => {
  it('validates against the packaged schema as a REAL artifact', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const result = validate(build());
    strictEqual(result.ok, true, `built profile is invalid:\n  ${result.errors.join('\n  ')}`);
  });

  it('carries a hostname HASH, never the raw hostname (§4.2)', () => {
    const profile = build();
    match(profile.source.hostname_hash, /^[0-9a-f]{32}$/);
    ok(!JSON.stringify(profile).includes('my-laptop'), 'the raw hostname appears nowhere');
    strictEqual(profile.source.hostname_hash, hashHostname('my-laptop.local'));
  });

  it('carries the credential env-var NAME and a required boolean — never a value (§4.2)', () => {
    const profile = build();
    strictEqual(profile.egress.credential_env_var, EGRESS_CREDENTIAL_ENV_VAR);
    strictEqual(profile.egress.credential_required, true);
    ok(!('credential' in profile.egress), 'no credential field exists to hold a token');
  });

  it('every value carries machine scope and user-global provenance (§4.4)', () => {
    const profile = build();
    for (const family of ['model_effort', 'notify']) {
      for (const [key, entry] of Object.entries(profile[family])) {
        strictEqual(entry.scope, 'machine', `${family}.${key} is machine-scoped`);
        if (entry.value !== null) ok(entry.provenance !== null, `${family}.${key} names where it came from`);
      }
    }
    strictEqual(profile.permissions.claude.provenance, 'user-global');
    strictEqual(profile.permissions.codex.provenance, 'user-global');
  });
});

describe('runtime machine profile — the two axes stay apart (§4.0)', () => {
  it('an egress channel is NOT a notify_channel — the profile keeps them in separate objects', () => {
    const profile = build();
    strictEqual(profile.notify.notify_channel.value, 'file-log');
    strictEqual(profile.egress.channel.value, 'telegram');
    // `telegram` is not a notify_channel value and must never become one: egress
    // activation lives on its own axis precisely so tracked config cannot activate it.
    const merged = structuredClone(profile);
    merged.notify.notify_channel.value = 'telegram';
    const verdict = assertProfileWritable(merged, { original: merged });
    strictEqual(verdict.ok, false);
    match(verdict.errors.join(' '), /not a notify channel|merge the two axes/);
  });

  it('the schema itself refuses telegram as a notify_channel', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const merged = structuredClone(build());
    merged.notify.notify_channel.value = 'telegram';
    strictEqual(validate(merged).ok, false, 'structure and meaning both refuse it');
  });

  it('a declined egress carries channel: null and credential_required: false (§4.1)', () => {
    const profile = build({ readers: { egress: { channel: null, recipient: null, headline: null, credential_present: false, provenance: { channel: null, recipient: null, headline: 'user-global' } } } });
    strictEqual(profile.egress.declined, true);
    strictEqual(profile.egress.channel.value, null);
    strictEqual(profile.egress.credential_required, false);
    strictEqual(assertProfileWritable(profile, { original: profile }).ok, true);
  });

  it('credential_required is refused when it contradicts declined/channel', () => {
    for (const mutate of [
      (p) => { p.egress.credential_required = true; p.egress.declined = true; p.egress.channel.value = null; },
      (p) => { p.egress.credential_required = false; },
      (p) => { p.egress.declined = true; },
    ]) {
      const profile = build();
      mutate(profile);
      const verdict = assertProfileWritable(profile, { original: profile });
      strictEqual(verdict.ok, false, `contradiction refused: ${JSON.stringify(profile.egress.declined)}/${JSON.stringify(profile.egress.channel.value)}/${profile.egress.credential_required}`);
    }
  });
});

describe('runtime machine profile — secret fail-close (#6, §4.3 guard 1)', () => {
  it('a token-shaped value REFUSES the write — it is not quietly scrubbed away', () => {
    for (const secret of [
      'Authorization: Bearer abcDEF123456ghiJKLmnop',
      'sk-abcdefghijklmnop1234567890',
      '123456789:AAHfaKeToKeNvAlUe1234567890abcdef',
      'https://user:hunter2@example.com/hook',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      const profile = build();
      profile.model_effort.model.value = secret;
      const verdict = assertProfileWritable(profile, { original: profile });
      strictEqual(verdict.ok, false, `refuses ${secret.slice(0, 20)}…`);
      match(verdict.errors.join(' '), /secret-shaped — refusing to write/);
    }
  });

  // The ORIGINAL-input rule. Sanitizing first and checking after is a check that
  // always passes: the sanitizer already removed the thing being looked for, so the
  // guard inspects its own output and finds nothing.
  it('the scrub inspects the ORIGINAL source, so a value the sanitizer would launder still refuses', () => {
    const original = { claudePermission: { allow: ['Bash(curl -H "Authorization: Bearer abcDEF123456ghiJKL")'] } };
    const profile = build();
    // The built profile is sanitized — by itself it looks clean...
    strictEqual(findSecretShapedValues(profile).length, 0);
    // ...but the gate is handed the original too, and refuses.
    const verdict = assertProfileWritable(profile, { original });
    strictEqual(verdict.ok, false);
    match(verdict.errors.join(' '), /source value at .* is secret-shaped/);
  });

  it('findSecretShapedValues walks arrays and nesting, and names the path', () => {
    const found = findSecretShapedValues({ a: { b: ['ok', 'ghp_abcdefghijklmnopqrstuv'] } });
    deepStrictEqual(found, ['$.a.b[1]']);
  });

  // §4.2 excludes the operator's LAYOUT, not every path. `/tmp` says nothing about
  // them; `/Users/alice/...` carries their username into a file meant to travel.
  it('a HOME path is refused at any depth — including inside a permission rule', () => {
    for (const [label, mutate] of [
      ['a scalar field', (p) => { p.model_effort.effort.value = '/Users/someone/Workspace/secret-project'; }],
      // The bucket exemption used to skip exactly this — the one check §4.2 exists for.
      ['a permission allow rule', (p) => { p.permissions.claude.allow = ['Bash(cd /Users/alice/secret-repo:*)']; }],
      ['a deny rule', (p) => { p.permissions.claude.deny = ['Read(/home/bob/private/**)']; }],
      ['a tilde path', (p) => { p.permissions.claude.ask = ['Bash(cat ~/notes.md:*)']; }],
      ['a Windows path', (p) => { p.model_effort.model.value = 'C:\\Users\\alice\\model.bin'; }],
    ]) {
      const profile = build();
      mutate(profile);
      const verdict = assertProfileWritable(profile, { original: profile });
      strictEqual(verdict.ok, false, `${label} is refused`);
      match(verdict.errors.join(' '), /carries a home-directory path/);
    }
  });

  it('a SYSTEM path is not a layout leak — /tmp and /usr say nothing about the operator', () => {
    for (const rule of ['Bash(ls /tmp:*)', 'Bash(/usr/bin/git status:*)', 'Read(/opt/tools/**)']) {
      const profile = build();
      profile.permissions.claude.allow = [rule];
      strictEqual(assertProfileWritable(profile, { original: profile }).ok, true, `${rule} is ordinary`);
    }
  });

  it('an explicit homeDir catches a layout the generic patterns would miss', () => {
    const profile = build();
    profile.model_effort.effort.value = '/srv/workspaces/ci-42/checkout';
    strictEqual(assertProfileWritable(profile, { original: profile }).ok, true, 'not home-shaped on its face');
    const verdict = assertProfileWritable(profile, { original: profile, homeDir: '/srv/workspaces/ci-42' });
    strictEqual(verdict.ok, false, 'but it IS this operator’s home');
  });
});

describe('runtime machine profile — boundary (§4.3 guard 2)', () => {
  it('ANY boundary flag true refuses the write — including performs_network_request', () => {
    for (const key of ['writes_host_config', 'writes_credential', 'writes_config_local_toml', 'performs_network_request']) {
      const profile = build();
      profile.boundary[key] = true;
      const verdict = assertProfileWritable(profile, { original: profile });
      strictEqual(verdict.ok, false, `${key}: true refuses`);
      match(verdict.errors.join(' '), /every boundary flag must be false/);
    }
  });

  it('an ABSENT boundary flag refuses too — the object is part of the schema', () => {
    const profile = build();
    delete profile.boundary.performs_network_request;
    strictEqual(assertProfileWritable(profile, { original: profile }).ok, false);
  });
});

describe('runtime machine profile — the write gate composes structure AND meaning', () => {
  it('profileWriteGate refuses what the schema alone would accept', async () => {
    const schemaValidate = await makeValidator('agentic-machine-profile');
    const profile = build();
    profile.model_effort.model.value = 'sk-abcdefghijklmnop1234567890';
    // A token is a perfectly good string — the schema has no objection.
    strictEqual(schemaValidate(profile).ok, true, 'the structural layer sees nothing wrong');
    const gate = profileWriteGate({ schemaValidate, original: null });
    strictEqual(gate(profile).ok, false, 'the composed gate does');
  });

  it('the gate plugs into writeMachineProfile and nothing lands when it refuses', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentic-profile-'));
    const schemaValidate = await makeValidator('agentic-machine-profile');
    const gate = profileWriteGate({ schemaValidate, original: null });

    const bad = build();
    bad.boundary.performs_network_request = true;
    const refused = await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: bad, validate: gate, now: NOW });
    strictEqual(refused.written, false);
    strictEqual(refused.reason, 'invalid-profile');
    strictEqual((await readMachineProfile({ homeDir, name: 'work' })).status, 'missing');

    const good = await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile: build(), validate: gate, now: NOW });
    strictEqual(good.written, true, `expected a clean profile to write: ${good.diagnostics.join('; ')}`);
    await rm(homeDir, { recursive: true, force: true });
  });
});

describe('runtime machine profile — round-trip (#4)', () => {
  it('export → seed reproduces every enumerated field with scope and provenance intact', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentic-profile-'));
    const schema = await loadSchema('agentic-machine-profile');
    const gate = profileWriteGate({ schemaValidate: await makeValidator('agentic-machine-profile'), original: null });
    const profile = canonicalProfile(build(), schema);

    await writeMachineProfile({ homeDir, repoRoot: null, name: 'work', profile, validate: gate, now: NOW });
    const read = await readMachineProfile({ homeDir, name: 'work' });
    strictEqual(read.status, 'available');
    deepStrictEqual(read.profile, profile, 'the artifact round-trips byte-for-byte through the store');

    const { proposals } = seedProposals({ profile: read.profile, validate: seedValidate });
    for (const [key, entry] of Object.entries(profile.model_effort)) {
      if (entry.value === null) continue;
      const proposal = proposals.find((p) => p.key === `model_effort.${key}`);
      ok(proposal, `model_effort.${key} survives the round-trip`);
      strictEqual(proposal.value, entry.value);
      strictEqual(proposal.scope, entry.scope, 'scope is preserved (§4.5.2)');
      strictEqual(proposal.provenance, entry.provenance);
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it('canonicalization makes the hash independent of builder order (§4.1)', async () => {
    const schema = await loadSchema('agentic-machine-profile');
    const a = build();
    // Same facts, keys assembled in a different order.
    const b = Object.fromEntries(Object.entries(structuredClone(a)).reverse());
    strictEqual(profileHash(a, schema), profileHash(b, schema));
    deepStrictEqual(Object.keys(canonicalProfile(b, schema)), Object.keys(canonicalProfile(a, schema)));
  });
});

describe('runtime machine profile — user-global only (#5, §4.4)', () => {
  // The correctness rule: a repo config supplying model/effort/notify/permission values
  // must NOT appear in the exported profile. Otherwise one project's policy becomes
  // another machine's global default.
  it('a repo config supplying every family does not reach the profile', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentic-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'agentic-repo-'));

    // Repo config — loud, specific values that would be unmistakable if they leaked.
    await mkdir(join(repoRoot, '.agentic-plugins'), { recursive: true });
    await writeFile(join(repoRoot, '.agentic-plugins', 'config.toml'), 'model = "REPO-MODEL"\neffort = "REPO-EFFORT"\nnotify_channel = "macos-osascript"\n');
    await mkdir(join(repoRoot, '.claude'), { recursive: true });
    await writeFile(join(repoRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(REPO-RULE:*)'], defaultMode: 'bypassPermissions' } }));

    // User-global config — the only thing the readers may see.
    await mkdir(join(homeDir, '.agentic-plugins'), { recursive: true });
    await writeFile(join(homeDir, '.agentic-plugins', 'config.toml'), 'model = "USER-MODEL"\n');
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(USER-RULE:*)'], defaultMode: 'acceptEdits' } }));

    const readers = {
      modelEffort: await readUserGlobalModelEffort({ homeDir }),
      notify: await readUserGlobalNotify({ homeDir }),
      claudePermission: await readUserGlobalClaudePermission({ homeDir }),
      codexPermission: await readUserGlobalCodexPermission({ homeDir, env: {} }),
      egress: { channel: null, recipient: null, headline: null, credential_present: false, provenance: { channel: null, recipient: null, headline: 'user-global' } },
    };
    const profile = buildMachineProfile({ readers, probe: PROBE, selection: SELECTION, runtimeVersion: '0.80.1', hostname: 'h', now: NOW });

    const serialized = JSON.stringify(profile);
    ok(!serialized.includes('REPO-MODEL'), 'the repo model is not exported');
    ok(!serialized.includes('REPO-EFFORT'), 'the repo effort is not exported');
    ok(!serialized.includes('REPO-RULE'), 'the repo permission rule is not exported');
    ok(!serialized.includes('macos-osascript'), 'the repo notify channel is not exported');
    strictEqual(profile.model_effort.model.value, 'USER-MODEL', 'the user-global value IS');
    strictEqual(profile.permissions.claude.defaultMode, 'acceptEdits', 'and the user-global mode, not the repo bypassPermissions');
    deepStrictEqual(profile.permissions.claude.allow, ['Bash(USER-RULE:*)']);

    await rm(homeDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });
});

describe('runtime machine profile — seed safety-grading (§4.5.3)', () => {
  it('an unsafe source posture is NOT proposed as a default; it becomes a labelled note', () => {
    const profile = build();
    profile.permissions.claude.defaultMode = 'bypassPermissions';
    profile.permissions.codex.approval_policy = 'never';
    profile.permissions.codex.sandbox_mode = 'danger-full-access';

    const { proposals, notes } = seedProposals({ profile, validate: seedValidate, targetDefaults: { claudeDefaultMode: 'acceptEdits', codexApprovalPolicy: 'on-request', codexSandboxMode: 'workspace-write' } });
    for (const key of ['permissions.claude.defaultMode', 'permissions.codex.approval_policy', 'permissions.codex.sandbox_mode']) {
      ok(!proposals.some((p) => p.key === key), `${key} is not proposed`);
      const note = notes.find((n) => n.key === key);
      ok(note, `${key} is shown as a labelled note instead`);
      strictEqual(note.labelled, 'unsafe-posture-not-proposed');
      ok(note.proposed_instead !== null, 'and the target\'s safe recommendation is named');
    }
  });

  it('the STORED enum still carries the unsafe value — recording is not recommending', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = build();
    profile.permissions.claude.defaultMode = 'bypassPermissions';
    profile.permissions.codex.sandbox_mode = 'danger-full-access';
    // §4.5.3 shows a source machine's value as a labelled note — so it must have a
    // field to live in. The schema allows it; the seed side refuses to propose it.
    strictEqual(validate(profile).ok, true, 'the schema stores what the machine had');
    strictEqual(assertProfileWritable(profile, { original: profile }).ok, true);
    ok(UNSAFE_CLAUDE_MODES.includes('bypassPermissions'));
  });

  it('a SAFE posture is proposed normally', () => {
    const { proposals } = seedProposals({ profile: build(), validate: seedValidate });
    strictEqual(proposals.find((p) => p.key === 'permissions.claude.defaultMode').value, 'acceptEdits');
    strictEqual(proposals.find((p) => p.key === 'permissions.codex.approval_policy').value, 'on-request');
  });

  it('every proposal requires confirmation and applies nothing (§4.5.4/§4.5.6)', () => {
    const { proposals, boundary } = seedProposals({ profile: build(), validate: seedValidate });
    ok(proposals.length > 0);
    for (const proposal of proposals) {
      strictEqual(proposal.requires_confirmation, true, `${proposal.key} is a default requiring confirmation, never applied`);
      strictEqual(proposal.applied, false);
    }
    deepStrictEqual(boundary, { writes_host_config: false, applies_nothing: true, re_diagnoses_target: true });
  });

  it('the chat-id pre-fills; the token never does (§4.5)', () => {
    const { proposals, notes } = seedProposals({ profile: build(), validate: seedValidate });
    strictEqual(proposals.find((p) => p.key === 'egress.recipient').value, '123456789');
    ok(!proposals.some((p) => p.key.includes('credential')), 'no credential is ever proposed');
    match(notes.find((n) => n.key === 'egress.credential').note, /never carries the token — set it yourself/);
  });

  it('a declined egress proposes nothing on that axis', () => {
    const declined = build({ readers: { egress: { channel: null, recipient: null, headline: null, credential_present: false, provenance: { channel: null, recipient: null, headline: 'user-global' } } } });
    const { proposals } = seedProposals({ profile: declined, validate: seedValidate });
    ok(!proposals.some((p) => p.key.startsWith('egress.')));
  });
});

describe('runtime machine profile — loader isolation (#7, §4.3 guard 3)', () => {
  // Asserted STATICALLY. A runtime assertion inside a loader that never reads the
  // profile passes vacuously — it proves the test ran, not that the loader is clean.
  // A profile that could activate egress would be exactly the vector ADR-0041 §2c closed.
  it('no activation or config loader reads the profile path or this module', async () => {
    const LOADERS = ['lib/egress-config.mjs', 'lib/egress-channel.mjs', 'lib/egress-semantics.mjs', 'lib/runtime-config.mjs', 'lib/notify-schema.mjs', 'notify.mjs'];
    for (const rel of LOADERS) {
      const src = await readFile(resolve(RUNTIME_SCRIPTS, rel), 'utf8');
      ok(!/machine-profile\.mjs/.test(src), `${rel} does not import the profile engine`);
      ok(!/profiles\//.test(src) && !/profileFile|readMachineProfile|listMachineProfiles/.test(src), `${rel} does not reach for the profile store`);
      ok(!/agentic-machine-profile/.test(src), `${rel} does not know the profile schema exists`);
    }
  });

  it('the dependency runs the other way — the profile engine imports the loaders, never the reverse', async () => {
    const src = await readFile(resolve(RUNTIME_SCRIPTS, 'lib/machine-profile.mjs'), 'utf8');
    ok(/from '\.\/egress-channel\.mjs'/.test(src), 'the engine reuses the egress scrub');
    // And it writes nothing: no host-config path, no credential read.
    ok(!/settings\.json|config\.local\.toml|config\.toml/.test(src.replace(/\/\/[^\n]*/g, '')), 'the engine names no host-config file');
    ok(!/process\.env/.test(src), 'the engine reads no environment — its inputs are injected');
  });
});
