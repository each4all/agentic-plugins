// tests/runtime/test-bootstrap-judge.mjs — judgeSteps unit coverage for the
// egress.configured observation (egress-portability subtask; ADR-0048 §4 /
// ADR-0041 §2c).
//
// WHY THIS FILE EXISTS: egress.configured used to be judged from the
// CREDENTIAL-INDEPENDENT §4.4 export reader (readers.egress.channel != null →
// satisfied) — so a machine with only AGENTIC_NOTIFY_EGRESS_CHANNEL=telegram
// (no recipient, no token: a configuration that egresses NOTHING) reported the
// step as satisfied. That channel-only false-pass is pinned here against the
// ACTIVATION descriptor semantics: the step is satisfied ONLY when
// loadEgressActivation (the named E1 checker) reports active — channel +
// recipient + credential presence together, token-alone and channel-alone
// both inert.
//
// judgeSteps is a pure exported function; readers are INJECTED, so no test
// here touches the developer's real environment or home.

import { describe, it } from 'node:test';
import { doesNotMatch, match, ok, strictEqual } from 'node:assert/strict';

import { judgeSteps } from '../../plugins/runtime/scripts/bootstrap.mjs';
import { stepIds } from '../../plugins/runtime/scripts/lib/step-registry.mjs';
import { EGRESS_ENV_KEYS } from '../../plugins/runtime/scripts/lib/egress-config.mjs';

const NOW = new Date('2026-07-23T00:00:00Z');
const CHAT_ID = '8468724389';

// Minimal judgeSteps harness: one expected egress step, inert probe surfaces.
// The egress observation reads ONLY readers.egressActivation, so everything
// else stays at its smallest well-formed shape.
function judgeEgress({ egressActivation, readers = {}, previousById = new Map() } = {}) {
  const steps = judgeSteps({
    expected: [{ id: stepIds.egressConfigured(), stage: 5, applicable: true, declinable: true, blocked_by: [] }],
    probe: { hosts: { claude: { plugins: {} }, codex: { plugins: {} } } },
    raw: {},
    pluginSet: { plugins: {} },
    readers: { egressActivation, ...readers },
    hookVerdict: null,
    previousById,
    now: NOW,
  });
  strictEqual(steps.length, 1);
  return steps[0];
}

// Descriptor shapes mirror loadEgressActivation's contract (never hand-drift
// them beyond what test-egress-config.mjs proves the loader emits).
function activeDescriptor(overrides = {}) {
  return {
    active: true,
    reason: 'active',
    channel: 'telegram',
    recipient: CHAT_ID,
    credentialPresent: true,
    channelSource: 'env',
    recipientSource: 'env',
    source: 'env',
    localReason: 'absent',
    localLayerSupported: true,
    ...overrides,
  };
}

function inactiveDescriptor(reason, overrides = {}) {
  return {
    active: false,
    reason,
    channel: reason === 'missing-activation' || reason === 'unknown-egress-channel' ? null : 'telegram',
    recipient: null,
    credentialPresent: reason === 'missing-recipient',
    channelSource: reason === 'missing-activation' ? null : 'env',
    recipientSource: null,
    source: null,
    localReason: 'absent',
    localLayerSupported: true,
    ...overrides,
  };
}

describe('judgeSteps egress.configured — activation semantics (channel-only false-pass regression)', () => {
  it('channel alone is NOT satisfied — the historical false-pass (missing-credential) stays pending', () => {
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('missing-credential') });
    strictEqual(entry.status, 'pending');
    match(entry.observed, /missing-credential/);
    ok(entry.recovery, 'pending carries an actionable recovery');
  });

  it('channel + credential without a recipient stays pending (missing-recipient)', () => {
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('missing-recipient') });
    strictEqual(entry.status, 'pending');
    match(entry.observed, /missing-recipient/);
  });

  it('a credential collision refuses satisfaction (credential-collision)', () => {
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('credential-collision') });
    strictEqual(entry.status, 'pending');
    match(entry.observed, /credential-collision/);
  });

  it('the legacy export-reader shape alone (readers.egress.channel) no longer satisfies the step', () => {
    // A caller passing ONLY the credential-independent export reader — the
    // pre-fix judgement input — must observe pending, not satisfied.
    const entry = judgeEgress({
      egressActivation: undefined,
      readers: { egress: { channel: 'telegram', recipient: null, credential_present: false } },
    });
    strictEqual(entry.status, 'pending');
    match(entry.observed, /missing-activation/);
  });

  it('full activation (channel + recipient + credential presence) is satisfied — with PRESENCE-ONLY observation', () => {
    const entry = judgeEgress({ egressActivation: activeDescriptor() });
    strictEqual(entry.status, 'satisfied');
    match(entry.observed, /channel=telegram/);
    // §5 sanitize discipline: the recipient VALUE never rides into run
    // artifacts — presence markers only.
    doesNotMatch(entry.observed, new RegExp(CHAT_ID));
    match(entry.observed, /recipient=set/);
    match(entry.observed, /credential=present/);
  });

  it('recovery names the credential env key as a placeholder procedure, never asking for the value (ADR-0048 §4)', () => {
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('missing-credential') });
    match(entry.recovery, new RegExp(EGRESS_ENV_KEYS.credential));
    match(entry.recovery, /yourself|own shell|local shell/i);
  });

  it('recovery stays valid without a rendered fragment — it names the always-available settings runbook (Codex review: resume renders no fragments)', () => {
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('missing-credential') });
    match(entry.recovery, /runtime:settings --egress-launcher-plan/);
  });

  it('localLayerSupported=false (e.g. Windows) appends the env-only hint to recovery', () => {
    const entry = judgeEgress({
      egressActivation: inactiveDescriptor('missing-credential', {
        localReason: 'ownership-unverifiable',
        localLayerSupported: false,
      }),
    });
    strictEqual(entry.status, 'pending');
    match(entry.recovery, /env-only/i);
    match(entry.recovery, /never honored/i);
  });

  it('localLayerSupported=true keeps recovery free of the machine-specific env-only hint', () => {
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('missing-credential') });
    doesNotMatch(entry.recovery, /never honored/i);
  });

  it('a recorded decline survives while inactive (declinable step, §6.2)', () => {
    const prev = new Map([[stepIds.egressConfigured(), { status: 'declined' }]]);
    const entry = judgeEgress({ egressActivation: inactiveDescriptor('missing-activation'), previousById: prev });
    strictEqual(entry.status, 'declined');
  });

  it('observed activation beats a recorded decline (satisfied wins, §6.2)', () => {
    const prev = new Map([[stepIds.egressConfigured(), { status: 'declined' }]]);
    const entry = judgeEgress({ egressActivation: activeDescriptor(), previousById: prev });
    strictEqual(entry.status, 'satisfied');
  });
});

// ---------------------------------------------------------------------------
// notify.codex.configured — the EXACT wiring probe (notify-axis slice,
// ADR-0048 §1). Satisfied means the merged `notify =` argv EQUALS the
// canonical argv the rendered fragment carries (shuttle, or the chain script
// in wrapper-chain mode) — presence alone was the vnext base observation and
// is deliberately no longer enough.
// ---------------------------------------------------------------------------

import { expectedCodexNotifyArgv } from '../../plugins/runtime/scripts/lib/notification-plan.mjs';

const SHUTTLE = '/home/op/.agentic-plugins/bin/codex-notify-shuttle.mjs';
const CHAIN = '/home/op/.agentic-plugins/bin/codex-notify-chain.mjs';

function judgeCodexNotify(codexNotify) {
  const steps = judgeSteps({
    expected: [{ id: stepIds.notifyCodexConfigured(), stage: 5, applicable: true, declinable: true, blocked_by: [stepIds.hostPresent('codex')] }],
    probe: { hosts: { claude: { plugins: {} }, codex: { plugins: {} } } },
    raw: {},
    pluginSet: { plugins: {} },
    readers: { codexNotify },
    hookVerdict: null,
    previousById: new Map(),
    now: NOW,
  });
  strictEqual(steps.length, 1);
  return steps[0];
}

const EXPECTED = [
  expectedCodexNotifyArgv({ receiverPath: SHUTTLE, platform: 'linux' }),
  expectedCodexNotifyArgv({ receiverPath: CHAIN, platform: 'linux' }),
];

describe('judgeSteps notify.codex.configured — exact canonical-wiring probe (ADR-0048 §1)', () => {
  it('the canonical shuttle argv satisfies — and the observation says it matched, not merely existed', () => {
    const step = judgeCodexNotify({ readable: true, present: true, argv: [...EXPECTED[0]], expected: EXPECTED });
    strictEqual(step.status, 'satisfied');
    match(step.observed, /matches the canonical receiver wiring/);
  });

  it('the chain argv is equally canonical — wrapper-chain mode is not a downgrade', () => {
    const step = judgeCodexNotify({ readable: true, present: true, argv: [...EXPECTED[1]], expected: EXPECTED });
    strictEqual(step.status, 'satisfied');
  });

  it('a present non-canonical notifier is manual-follow-up, never satisfied and never silently pending', () => {
    const step = judgeCodexNotify({ readable: true, present: true, argv: ['/usr/bin/env', 'node', '/opt/other-notifier.mjs'], expected: EXPECTED });
    strictEqual(step.status, 'manual-follow-up');
    match(step.recovery, /never auto-chains/);
  });

  it('a same-length argv differing in ONE element does not match — equality is element-wise', () => {
    const drifted = [...EXPECTED[0]];
    drifted[drifted.length - 1] = '/home/op/.agentic-plugins/bin/renamed.mjs';
    const step = judgeCodexNotify({ readable: true, present: true, argv: drifted, expected: EXPECTED });
    strictEqual(step.status, 'manual-follow-up');
  });

  it('empty argv and unparseable values stay pending; a missing key stays pending; an unreadable config is unknown', () => {
    strictEqual(judgeCodexNotify({ readable: true, present: true, argv: [], expected: EXPECTED }).status, 'pending');
    strictEqual(judgeCodexNotify({ readable: true, present: true, argv: null, expected: EXPECTED }).status, 'pending');
    strictEqual(judgeCodexNotify({ readable: true, present: false, argv: null, expected: EXPECTED }).status, 'pending');
    strictEqual(judgeCodexNotify({ readable: false, present: false, argv: null, expected: EXPECTED }).status, 'unknown');
  });
});

describe('expectedCodexNotifyArgv — the per-OS canonical argv single source', () => {
  it('POSIX keeps /usr/bin/env node <receiver> — the form already merged on live machines', () => {
    for (const platform of ['linux', 'darwin']) {
      const argv = expectedCodexNotifyArgv({ receiverPath: SHUTTLE, platform, execPath: '/ignored/node' });
      strictEqual(argv[0], '/usr/bin/env');
      strictEqual(argv[1], 'node');
      strictEqual(argv[2], SHUTTLE);
    }
  });

  it('win32 interpolates the render machine\'s own node executable — /usr/bin/env does not exist there', () => {
    const argv = expectedCodexNotifyArgv({ receiverPath: 'C:\\Users\\op\\.agentic-plugins\\bin\\codex-notify-shuttle.mjs', platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' });
    strictEqual(argv.length, 2);
    strictEqual(argv[0], 'C:\\Program Files\\nodejs\\node.exe');
    strictEqual(argv[1], 'C:\\Users\\op\\.agentic-plugins\\bin\\codex-notify-shuttle.mjs');
  });
});

describe('judgeSteps notify.codex.configured — MODE BINDING via the persisted desired argv (Refine-verify peer)', () => {
  // The peer reproduced: a wrapper-chain plan whose operator wrongly merged
  // the DIRECT shuttle fragment certified `satisfied` — the third-party
  // notifier the chain existed to preserve silently vanished, positively
  // certified. Once a fragment is rendered, the step's `desired` binds the
  // probe to THAT plan's argv; the other canonical form no longer satisfies.
  function judgeWithDesired({ argv, desired }) {
    const steps = judgeSteps({
      expected: [{ id: stepIds.notifyCodexConfigured(), stage: 5, applicable: true, declinable: true, blocked_by: [stepIds.hostPresent('codex')] }],
      probe: { hosts: { claude: { plugins: {} }, codex: { plugins: {} } } },
      raw: {},
      pluginSet: { plugins: {} },
      readers: { codexNotify: { readable: true, present: true, argv, expected: EXPECTED } },
      hookVerdict: null,
      previousById: new Map([[stepIds.notifyCodexConfigured(), { id: stepIds.notifyCodexConfigured(), status: 'pending', desired }]]),
      now: NOW,
    });
    return steps[0];
  }

  it('a wrapper-chain plan merged as the direct shuttle is manual-follow-up — the exact peer reproduction', () => {
    const step = judgeWithDesired({ argv: [...EXPECTED[0]], desired: JSON.stringify(EXPECTED[1]) });
    strictEqual(step.status, 'manual-follow-up', 'the plan asked for the chain; merging the shuttle dropped the preserved notifier');
  });

  it('the plan-bound argv itself still satisfies, and the desired seat survives the judged entry', () => {
    const step = judgeWithDesired({ argv: [...EXPECTED[1]], desired: JSON.stringify(EXPECTED[1]) });
    strictEqual(step.status, 'satisfied');
    strictEqual(step.desired, JSON.stringify(EXPECTED[1]), 'desired is carried forward for the next resume');
  });

  it('an unparseable desired FAILS CLOSED to manual-follow-up (statusline peer G7 — the broad-set fallback silently widened the match)', () => {
    const step = judgeWithDesired({ argv: [...EXPECTED[0]], desired: '{not json' });
    strictEqual(step.status, 'manual-follow-up');
    match(step.recovery, /could not be trusted/);
  });
});
