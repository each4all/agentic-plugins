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
  PROFILE_SESSION_KEYS,
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
import { USER_SCOPE_ONLY_CONFIG_KEYS } from '../../plugins/runtime/scripts/lib/runtime-config.mjs';
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

// `readers` is destructured OUT of `over` before the spread. It used to ride the
// trailing `...over`, which re-overwrote the merged bundle with the caller's
// fragment — so `build({ readers: { session: … } })` produced a profile with EMPTY
// model_effort/notify/permissions and a declined egress, and every assertion about
// it ran against a document no export would ever write (code review, LOW). The
// merge computed on the same line was simply discarded.
function build(over = {}) {
  const { readers, ...rest } = over;
  return buildMachineProfile({ readers: baseReaders(readers), probe: PROBE, selection: SELECTION, runtimeVersion: '0.80.1', hostname: 'my-laptop.local', now: NOW, ...rest });
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

  it('the Stage-4 POSTURE is not exported — a coordinate block carries coordinates (§6.1.1)', async () => {
    const { CONFIG_KEY_FAMILIES } = await import('../../plugins/runtime/scripts/lib/runtime-config.mjs');
    ok(CONFIG_KEY_FAMILIES.model_effort.includes('model_effort_fallback'), 'the reader DOES read it from the same family');

    const withPosture = baseReaders();
    withPosture.modelEffort.keys.model_effort_fallback = { value: 'host-native', provenance: 'user-global' };
    const profile = build({ readers: withPosture });
    const validate = await makeValidator('agentic-machine-profile');

    // Two reasons, both measured elsewhere: every profile member is a
    // `scalarField` OBJECT and §4.1 refuses an unknown object-valued key at every
    // minor (so exporting it would make new profiles unreadable to an older
    // runtime, breaking the seed path); and the posture is a per-machine choice a
    // new machine's operator should be asked rather than handed.
    ok(!('model_effort_fallback' in profile.model_effort), 'the posture stays out of the profile');
    deepStrictEqual(
      Object.keys(profile.model_effort).sort(),
      CONFIG_KEY_FAMILIES.model_effort.filter((k) => k !== 'model_effort_fallback').sort(),
      'every OTHER key of the family is still exported',
    );
    const verdict = validate(profile);
    deepStrictEqual(verdict.errors, [], 'and the profile still validates against the closed §4.1 schema');
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

  it('a HOME path hidden in a KEY NAME is refused too — keys are a nesting depth', () => {
    // §4.2 excludes repository paths "at any nesting depth", and a key IS a nesting
    // position. `findSecretShapedValues` had always scanned keys; `findRepositoryPaths`
    // scanned values only, so a document carrying the operator's layout as a key
    // cleared both the schema and the semantic gate — defeating §4.2 for the one shape
    // it exists to catch (cross-host review).
    const profile = build();
    profile.notify = { ...profile.notify, '/Users/alice/private-repo/': 'off' };
    const verdict = assertProfileWritable(profile, { original: profile });
    strictEqual(verdict.ok, false, 'a home path in a key is a layout leak like any other');
    match(verdict.errors.join(' '), /carries a home-directory path/);
    // §3.2: the locator is an ORDINAL. A finding about a leaked path must not itself
    // publish the path — not truncated, not at all.
    match(verdict.errors.join(' '), /member\[\d+\]/);
    const joined = verdict.errors.join(' ');
    ok(!joined.includes('alice'), `no username in the diagnostic: ${joined}`);
    ok(!joined.includes('private-repo'), `no repository name in the diagnostic: ${joined}`);
    ok(!joined.includes('/Users/'), `no path fragment at all: ${joined}`);

    // CONTROL: an ordinary key on the same profile is not flagged, so the assertion
    // above is not passing merely because key scanning refuses everything.
    const control = build();
    control.notify = { ...control.notify, some_ordinary_key: 'off' };
    strictEqual(assertProfileWritable(control, { original: control }).ok, true, 'an ordinary key stays legal');
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
    // `original: profile` is the documented form when there is no pre-sanitize
    // source; `null` is refused outright, since skipping the source scan is the
    // laundering defect one argument away.
    const gate = profileWriteGate({ schemaValidate, original: profile });
    strictEqual(gate(profile).ok, false, 'the composed gate does');
  });

  it('the gate plugs into writeMachineProfile and nothing lands when it refuses', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentic-profile-'));
    const schemaValidate = await makeValidator('agentic-machine-profile');
    const bad = build();
    const gate = profileWriteGate({ schemaValidate, original: bad });

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
    const profile = canonicalProfile(build(), schema);
    const gate = profileWriteGate({ schemaValidate: await makeValidator('agentic-machine-profile'), original: profile });

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

// ---------------------------------------------------------------------------
// ADR-0048 §2.1/§4 — profile 1.1: statusline_preset forward-compat + the
// write-gate credential constant (D0.4)
// ---------------------------------------------------------------------------

describe('machine profile 1.1 — statusline_preset forward-compat (ADR-0048 §2.1)', () => {
  it('a 1.0 document (no statusline_preset) still validates under the 1.1 reader', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = build();
    profile.schema = 'agentic-machine-profile-1.0';
    delete profile.statusline_preset;
    const verdict = validate(profile);
    deepStrictEqual(verdict.errors, [], 'a pre-1.1 export is not invalidated by the additive minor');
    ok(verdict.ok);
  });

  it('a 1.1 statusline_preset under a 1.0-ERA reader is a SCALAR warning + ignored, never an error (§4.6)', async () => {
    // The real forward-compat scenario is an OLD RUNTIME (whose packaged schema
    // has no statusline_preset) reading a NEW document — reconstructed here by
    // stripping the key from a clone of the 1.1 schema and validating the 1.1
    // document against it as a 1.0 reader.
    const { validateAgainstSchema, loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const oldSchema = structuredClone(await loadSchema('agentic-machine-profile'));
    oldSchema.$id = 'agentic-machine-profile-1.0';
    delete oldSchema.properties.statusline_preset;

    const profile = build();
    profile.statusline_preset = 'agentic-6';
    const verdict = validateAgainstSchema(profile, oldSchema, { readerVersion: 'agentic-machine-profile-1.0' });
    deepStrictEqual(verdict.errors, [], `the newer-minor scalar is forgiven: ${JSON.stringify(verdict.errors)}`);
    // D1 §3.2 — the ignore is still WARNED (silence was the defect this pins),
    // but the key is located by ORDINAL rather than named: to THIS reader
    // `statusline_preset` is a key the document supplied and the schema does not
    // declare, which is the same category as any other unknown key. The minor
    // relation still crosses, as numbers.
    const warned = verdict.warnings.filter((w) => /unknown scalar key ignored/.test(w));
    strictEqual(warned.length, 1, `the ignore is WARNED, not silent: ${JSON.stringify(verdict.warnings)}`);
    match(warned[0], /\$\.member\[\d+\]/, 'located by ordinal');
    match(warned[0], /newer schema minor \(2\) than this runtime reads \(0\)/, 'and the minor relation is stated');
    ok(!warned[0].includes('statusline_preset'), 'an undeclared key is not named back at the reader');
  });

  it('the trailing scalars serialize after statusline_preset, in schema order', async () => {
    const { canonicalize, loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const schema = await loadSchema('agentic-machine-profile');
    const profile = build();
    profile.statusline_preset = 'agentic-6';
    const keys = Object.keys(canonicalize(profile, schema));
    deepStrictEqual(
      keys.slice(-4),
      ['statusline_preset', 'entry_brief', 'entry_brief_empty', 'session_capture'],
      `the trailing-scalar rule holds: ${keys.join(',')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Profile 1.2 — the session family as trailing bare scalars
// ---------------------------------------------------------------------------

describe('machine profile 1.2 — session family carriage', () => {
  const sessionReaders = (keys) => ({
    session: { family: 'session', keys, source: { scope: 'user', status: 'readable' } },
  });
  const withSession = (keys) => build({ readers: sessionReaders(keys) });
  const ALL_SET = {
    session_capture: { value: 'stop-hook', provenance: 'user-global' },
    entry_brief: { value: 'startup', provenance: 'user-global' },
    entry_brief_empty: { value: 'report', provenance: 'user-global' },
  };

  it('carries all three keys as bare scalars and validates as a real artifact', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = withSession(ALL_SET);
    strictEqual(profile.schema, 'agentic-machine-profile-1.2');
    strictEqual(profile.session_capture, 'stop-hook');
    strictEqual(profile.entry_brief, 'startup');
    strictEqual(profile.entry_brief_empty, 'report');
    // Bare scalars, NOT scalarField objects — an object would be refused by every
    // older reader at every minor, which is the whole reason for this shape.
    for (const key of PROFILE_SESSION_KEYS) strictEqual(typeof profile[key], 'string', `${key} is a bare scalar`);
    strictEqual(validate(profile).ok, true, JSON.stringify(validate(profile).errors));
  });

  it('carries EVERY member of the config family — membership, not just order', async () => {
    const { CONFIG_KEY_FAMILIES } = await import('../../plugins/runtime/scripts/lib/runtime-config.mjs');
    // The `model_effort` family already has this guard, and the session family
    // needs it for the same reason: ORDER drift is caught by the disk-order and
    // canonical-byte assertions, but MEMBERSHIP drift is not. Adding a fourth key
    // to CONFIG_KEY_FAMILIES.session would make `projectSession` read it while
    // `buildMachineProfile` silently omitted it from the profile, and without this
    // nothing would fail (code review, LOW).
    deepStrictEqual(
      [...PROFILE_SESSION_KEYS].sort(),
      [...CONFIG_KEY_FAMILIES.session].sort(),
      'PROFILE_SESSION_KEYS and the config family must name the same keys',
    );
    const profile = withSession(ALL_SET);
    deepStrictEqual(
      CONFIG_KEY_FAMILIES.session.filter((k) => k in profile).sort(),
      [...CONFIG_KEY_FAMILIES.session].sort(),
      'and every one of them reaches the built profile',
    );
  });

  it('an unset key exports null rather than being omitted', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = withSession({ ...ALL_SET, entry_brief: { value: null, provenance: null } });
    strictEqual(profile.entry_brief, null);
    ok('entry_brief' in profile, 'the key is present carrying null — absent and unset are not the same bytes');
    strictEqual(validate(profile).ok, true);
  });

  it('an out-of-domain value is REFUSED by the schema enum (the control that makes the enum load-bearing)', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = withSession(ALL_SET);
    profile.session_capture = 'bogus-mode';
    const verdict = validate(profile);
    strictEqual(verdict.ok, false, 'a closed set in code is a closed set in the schema');
    ok(verdict.errors.some((e) => /session_capture/.test(e)), JSON.stringify(verdict.errors));
  });

  it('a 1.1 document (no session keys) still validates under the 1.2 reader', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = build();
    profile.schema = 'agentic-machine-profile-1.1';
    for (const key of PROFILE_SESSION_KEYS) delete profile[key];
    const verdict = validate(profile);
    deepStrictEqual(verdict.errors, [], 'the three keys are optional, so the minor stays additive');
    ok(verdict.ok);
  });

  it('a 1.2 document under a 1.1-ERA reader is three SCALAR warnings + ignored, never an error (§4.6)', async () => {
    const { validateAgainstSchema, loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const oldSchema = structuredClone(await loadSchema('agentic-machine-profile'));
    oldSchema.$id = 'agentic-machine-profile-1.1';
    for (const key of PROFILE_SESSION_KEYS) delete oldSchema.properties[key];

    const verdict = validateAgainstSchema(withSession(ALL_SET), oldSchema, { readerVersion: 'agentic-machine-profile-1.1' });
    deepStrictEqual(verdict.errors, [], `the newer-minor scalars are forgiven: ${JSON.stringify(verdict.errors)}`);
    const warned = verdict.warnings.filter((w) => /unknown scalar key ignored/.test(w));
    strictEqual(warned.length, 3, `one warning per ignored key: ${JSON.stringify(verdict.warnings)}`);
    for (const w of warned) match(w, /newer schema minor \(2\) than this runtime reads \(1\)/);
  });

  it('a session OBJECT block would be REFUSED at every minor — the control that makes the bare-scalar shape load-bearing', async () => {
    const { validateAgainstSchema, loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const oldSchema = structuredClone(await loadSchema('agentic-machine-profile'));
    oldSchema.$id = 'agentic-machine-profile-1.1';
    for (const key of PROFILE_SESSION_KEYS) delete oldSchema.properties[key];

    // The rejected alternative, exercised rather than asserted in prose: the same
    // facts carried as ONE object key instead of three scalars.
    const objectShaped = build();
    for (const key of PROFILE_SESSION_KEYS) delete objectShaped[key];
    objectShaped.session = { session_capture: { value: 'stop-hook', scope: 'machine', provenance: 'user-global' } };
    const verdict = validateAgainstSchema(objectShaped, oldSchema, { readerVersion: 'agentic-machine-profile-1.1' });
    strictEqual(verdict.ok, false, 'an unknown OBJECT key is refused no matter how new the document claims to be');
    ok(verdict.errors.some((e) => /unknown-structural-key/.test(e)), JSON.stringify(verdict.errors));
  });

  it('1.1 and 1.2 readers produce the SAME canonical bytes — and family order would break it', async () => {
    const { canonicalize, loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const schema12 = await loadSchema('agentic-machine-profile');
    const schema11 = structuredClone(schema12);
    for (const key of PROFILE_SESSION_KEYS) delete schema11.properties[key];

    const profile = withSession(ALL_SET);
    const bytes = (schema) => JSON.stringify(canonicalize(profile, schema), null, 2);
    strictEqual(bytes(schema11), bytes(schema12), 'a 1.1 reader and a 1.2 reader agree byte-for-byte');

    // Kept as DOCUMENTATION of why the schema declares these alphabetically, and
    // labelled as such: it is NOT extra coverage. The claim here used to be that
    // "without this case the alignment above passes for a schema ordered either
    // way", and that was false — measured by deleting this block and re-running the
    // family-order mutation, which the positive assertion above still caught on its
    // own (cross-host review). The equality IS the guard; this shows the reader what
    // it is guarding against.
    const schemaFamilyOrder = structuredClone(schema11);
    for (const key of ['session_capture', 'entry_brief', 'entry_brief_empty']) {
      schemaFamilyOrder.properties[key] = schema12.properties[key];
    }
    ok(bytes(schemaFamilyOrder) !== bytes(schema11), 'family-declaration order diverges — which is what the equality above rules out');
  });

  it('1.0↔1.2 hash equality is NOT claimed — a 1.0 reader sorts statusline_preset in among them', async () => {
    const { canonicalize, loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const schema12 = await loadSchema('agentic-machine-profile');
    const schema10 = structuredClone(schema12);
    for (const key of [...PROFILE_SESSION_KEYS, 'statusline_preset']) delete schema10.properties[key];

    const profile = withSession(ALL_SET);
    profile.statusline_preset = 'agentic-6';
    const keys10 = Object.keys(canonicalize(profile, schema10));
    // The limit is inherent, so it is PINNED rather than left as a surprise: to a
    // 1.0 reader `statusline_preset` is just another unknown scalar and sorts
    // after `session_capture`. Validation and seeding still work across the gap;
    // only hash identity is scoped to 1.1↔1.2.
    deepStrictEqual(keys10.slice(-4), ['entry_brief', 'entry_brief_empty', 'session_capture', 'statusline_preset']);
    ok(JSON.stringify(canonicalize(profile, schema10)) !== JSON.stringify(canonicalize(profile, schema12)));
  });
});

describe('machine profile 1.2 — session family seeding (§4.5)', () => {
  const ALL_SET = {
    session_capture: { value: 'stop-hook', provenance: 'user-global' },
    entry_brief: { value: 'startup', provenance: 'user-global' },
    entry_brief_empty: { value: null, provenance: null },
  };

  it('proposes each SET key as a confirmation-required default, and marks the user-scope-only ones', () => {
    const profile = build({ readers: { session: { family: 'session', keys: ALL_SET, source: { scope: 'user', status: 'readable' } } } });
    const result = seedProposals({ profile, validate: seedValidate });
    strictEqual(result.ok, true, JSON.stringify(result.refused));
    const byKey = new Map(result.proposals.map((p) => [p.key, p]));

    for (const key of ['session.session_capture', 'session.entry_brief']) {
      ok(byKey.has(key), `${key} is proposed`);
      strictEqual(byKey.get(key).requires_confirmation, true, 'a proposal is never applied');
      strictEqual(byKey.get(key).applied, false);
    }
    // ADR-0045 §7 — the distinction is carried, not flattened. entry_brief may
    // never be written repo-side; session_capture legitimately may.
    strictEqual(byKey.get('session.entry_brief').user_scope_only, true);
    strictEqual(byKey.get('session.session_capture').user_scope_only, false);
    // An UNSET key is not a default worth confirming.
    ok(!byKey.has('session.entry_brief_empty'), 'a null value proposes nothing');
  });

  it('the user_scope_only label is DERIVED, and an incoming profile cannot author it', () => {
    // The forgeable version read the label off `entry`, which for four of the six
    // families is an object lifted straight out of the incoming profile. §4.6
    // forgives unknown SCALAR keys at any depth from a newer minor, so this document
    // validates while smuggling the label in (code review, MEDIUM).
    //
    // The forgery is deliberately set to the value the runtime would NOT derive:
    // `model` is not user-scope-only, so a forged `true` and a derived `false`
    // disagree. Forging `false` here would pass under either implementation and
    // pin nothing.
    const profile = build();
    profile.schema = 'agentic-machine-profile-1.9';
    profile.model_effort.model = { ...profile.model_effort.model, user_scope_only: true };

    const verdict = seedValidate(profile);
    strictEqual(verdict.ok, true, 'the document is schema-valid — the label rides the newer-minor tolerance');
    ok(verdict.warnings.some((w) => /unknown scalar key ignored/.test(w)), 'and the validator reports it as IGNORED');

    const result = seedProposals({ profile, validate: seedValidate });
    const proposed = result.proposals.find((x) => x.key === 'model_effort.model');
    strictEqual(proposed.user_scope_only, false, 'so what the validator ignored, seedProposals must not read');
  });

  it('every proposal carries the label, and it matches the runtime key list', () => {
    const profile = build({ readers: { session: { family: 'session', keys: ALL_SET, source: { scope: 'user', status: 'readable' } } } });
    const result = seedProposals({ profile, validate: seedValidate });
    ok(result.proposals.length > 0);
    for (const p of result.proposals) {
      strictEqual(typeof p.user_scope_only, 'boolean', `${p.key} carries a derived label`);
      strictEqual(
        p.user_scope_only,
        USER_SCOPE_ONLY_CONFIG_KEYS.includes(p.key.split('.').pop()),
        `${p.key} agrees with USER_SCOPE_ONLY_CONFIG_KEYS`,
      );
    }
    // And the distinction it exists for actually lands.
    const byKey = new Map(result.proposals.map((p) => [p.key, p]));
    strictEqual(byKey.get('session.entry_brief').user_scope_only, true);
    strictEqual(byKey.get('session.session_capture').user_scope_only, false);
  });

  it('a profile whose session value is out of domain is REFUSED before anything is presented (§4.5.1)', () => {
    const profile = build({ readers: { session: { family: 'session', keys: ALL_SET, source: { scope: 'user', status: 'readable' } } } });
    profile.entry_brief = 'startup-but-wrong';
    const result = seedProposals({ profile, validate: seedValidate });
    strictEqual(result.ok, false, 'an incoming profile is untrusted and validated EXACTLY');
    deepStrictEqual(result.proposals, []);
  });
});

describe('machine profile — write-gate credential constant (ADR-0048 §4 / D0.4)', () => {
  it('a present credential_env_var that is not TELEGRAM_BOT_TOKEN is refused at the write gate — the schema stays additive', async () => {
    const validate = await makeValidator('agentic-machine-profile');
    const profile = build();
    profile.egress.credential_env_var = 'MY_OTHER_TOKEN';
    // The SCHEMA accepts it (additive-minor preservation)…
    strictEqual(validate(profile).ok, true, 'the schema shape is deliberately unchanged (D0.4)');
    // …and the write gate refuses it.
    const semantic = assertProfileWritable(profile, { original: profile });
    strictEqual(semantic.ok, false);
    ok(semantic.errors.some((e) => /TELEGRAM_BOT_TOKEN/.test(e) && /write-gate constant/.test(e)), JSON.stringify(semantic.errors));
  });

  it('a null credential_env_var stays legal (a legacy/no-egress document)', () => {
    const profile = build();
    profile.egress.credential_env_var = null;
    const semantic = assertProfileWritable(profile, { original: profile });
    ok(!semantic.errors.some((e) => /write-gate constant/.test(e)), JSON.stringify(semantic.errors));
  });
});
