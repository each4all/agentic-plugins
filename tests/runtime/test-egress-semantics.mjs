// tests/runtime/test-egress-semantics.mjs
//
// ADR-0041 §6/§7 egress semantics: the network-free core. Covers the outcome
// taxonomy, the config/credential fingerprint (config-fix bypass), the failure
// throttle (exponential backoff), the attempt-mirror record shape, and the
// claim-finalization orchestration. All state is minted per-test with mkdtemp;
// time is injected via `now`; nothing here touches the network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claimDedupe, releaseClaim, notifyDedupeDir } from '../../plugins/runtime/scripts/lib/notify-schema.mjs';
import {
  EGRESS_OUTCOMES,
  EGRESS_STATUSES,
  classifyEgressOutcome,
  egressConfigFingerprint,
  egressThrottleKey,
  egressThrottleDir,
  checkEgressThrottle,
  recordEgressFailure,
  clearEgressThrottle,
  sweepEgressThrottles,
  inspectEgressThrottles,
  buildEgressMirrorRecord,
  shouldAttemptEgress,
  suppressThrottledEgress,
  finalizeEgressAttempt,
  clearEgressThrottlesForEvent,
  egressEventHash,
  EGRESS_THROTTLE_BASE_MS,
} from '../../plugins/runtime/scripts/lib/egress-semantics.mjs';

const T0 = Date.UTC(2026, 6, 5, 12, 0, 0);
const SERVICE = 'telegram';

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-sem-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

function dirs(root) {
  return { dedupeDir: notifyDedupeDir(root), throttleDir: egressThrottleDir(root) };
}

// A claim to finalize — returns { eventId, ownerToken, claimPath }.
function preClaim(dedupeDir, { eventId = 'repo-x:approval:session:s1:aaaa:fired', now = T0 } = {}) {
  const res = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now });
  assert.equal(res.claimed, true);
  return { eventId, ownerToken: res.ownerToken, claimPath: res.claimPath };
}

// ── Taxonomy ──

describe('egress outcome taxonomy', () => {
  it('classifies all 10 outcomes to valid dispositions', () => {
    const outcomes = Object.values(EGRESS_OUTCOMES);
    assert.equal(outcomes.length, 10);
    for (const outcome of outcomes) {
      const spec = classifyEgressOutcome(outcome);
      assert.equal(spec.outcome, outcome);
      assert.ok(EGRESS_STATUSES.includes(spec.egressStatus), `${outcome} status`);
      assert.ok(['promote', 'release'].includes(spec.claim), `${outcome} claim`);
      assert.ok(['record', 'clear', 'none'].includes(spec.throttle), `${outcome} throttle`);
    }
  });

  it('maps each outcome to its ADR-0041 §7 disposition', () => {
    const expected = {
      dispatched: { egressStatus: 'dispatched', claim: 'promote', throttle: 'clear' },
      'quiet-hours': { egressStatus: 'suppressed', claim: 'promote', throttle: 'none' },
      'body-cap': { egressStatus: 'failed', claim: 'promote', throttle: 'none' },
      'missing-token': { egressStatus: 'suppressed', claim: 'release', throttle: 'record' },
      'missing-recipient': { egressStatus: 'suppressed', claim: 'release', throttle: 'record' },
      'invalid-local-activation': { egressStatus: 'suppressed', claim: 'release', throttle: 'record' },
      'provider-error': { egressStatus: 'failed', claim: 'release', throttle: 'record' },
      'provider-rejected': { egressStatus: 'failed', claim: 'release', throttle: 'record' },
      timeout: { egressStatus: 'failed', claim: 'release', throttle: 'record' },
      'redirect-error': { egressStatus: 'failed', claim: 'release', throttle: 'record' },
    };
    for (const [outcome, spec] of Object.entries(expected)) {
      const got = classifyEgressOutcome(outcome);
      assert.equal(got.egressStatus, spec.egressStatus, `${outcome} egressStatus`);
      assert.equal(got.claim, spec.claim, `${outcome} claim`);
      assert.equal(got.throttle, spec.throttle, `${outcome} throttle`);
    }
  });

  it('rejects an unknown outcome (the taxonomy is closed)', () => {
    assert.throws(() => classifyEgressOutcome('made-up'), /unknown egress outcome/);
  });
});

// ── Config fingerprint (config-fix bypass) ──

describe('egress config fingerprint', () => {
  it('is deterministic and 16 hex chars', () => {
    const a = egressConfigFingerprint({ channel: 'telegram', recipient: '123', token: 'abc' });
    const b = egressConfigFingerprint({ channel: 'telegram', recipient: '123', token: 'abc' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('changes when the token is added, changed, or the recipient/channel changes', () => {
    const base = egressConfigFingerprint({ channel: 'telegram', recipient: '123', token: '' });
    assert.notEqual(base, egressConfigFingerprint({ channel: 'telegram', recipient: '123', token: '999:XYZ' }));
    assert.notEqual(
      egressConfigFingerprint({ channel: 'telegram', recipient: '123', token: 'A' }),
      egressConfigFingerprint({ channel: 'telegram', recipient: '123', token: 'B' }),
    );
    assert.notEqual(base, egressConfigFingerprint({ channel: 'telegram', recipient: '456', token: '' }));
  });

  it('never embeds the raw token (§2b)', () => {
    const token = '123456789:AAHsuperSECRETtokenVALUE';
    const fp = egressConfigFingerprint({ channel: 'telegram', recipient: '999', token });
    assert.ok(!fp.includes('SECRET'));
    assert.ok(!fp.includes(token));
  });
});

describe('egress throttle key', () => {
  it('is 32 hex chars and requires non-empty inputs', () => {
    const key = egressThrottleKey({ eventId: 'e1', service: SERVICE, fingerprint: 'fp' });
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.throws(() => egressThrottleKey({ eventId: '', service: SERVICE, fingerprint: 'fp' }), /eventId/);
    assert.throws(() => egressThrottleKey({ eventId: 'e', service: '', fingerprint: 'fp' }), /service/);
    assert.throws(() => egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: '' }), /fingerprint/);
  });

  it('differs when the fingerprint differs (this is the config-fix bypass mechanism)', () => {
    const k1 = egressThrottleKey({ eventId: 'e1', service: SERVICE, fingerprint: 'fp-no-token' });
    const k2 = egressThrottleKey({ eventId: 'e1', service: SERVICE, fingerprint: 'fp-with-token' });
    assert.notEqual(k1, k2);
  });
});

// ── Failure throttle (exponential backoff) ──

describe('egress failure throttle', () => {
  it('an absent record is not throttled', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const key = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: 'fp' });
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 }).throttled, false);
  });

  it('gates within the cooldown and re-opens after it', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const key = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: 'fp' });
    recordEgressFailure({ throttleDir, key, now: T0, baseMs: 60_000, maxMs: 3_600_000 });
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 + 30_000 }).throttled, true);
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 + 60_001 }).throttled, false);
  });

  it('backs off exponentially and caps at maxMs', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const key = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: 'fp' });
    const r1 = recordEgressFailure({ throttleDir, key, now: T0, baseMs: 100, maxMs: 250 });
    assert.equal(r1.failure_count, 1);
    assert.equal(r1.cooldown_ms, 100);
    const r2 = recordEgressFailure({ throttleDir, key, now: T0 + 100, baseMs: 100, maxMs: 250 });
    assert.equal(r2.failure_count, 2);
    assert.equal(r2.cooldown_ms, 200);
    const r3 = recordEgressFailure({ throttleDir, key, now: T0 + 300, baseMs: 100, maxMs: 250 });
    assert.equal(r3.failure_count, 3);
    assert.equal(r3.cooldown_ms, 250, 'capped at maxMs');
    const r4 = recordEgressFailure({ throttleDir, key, now: T0 + 600, baseMs: 100, maxMs: 250 });
    assert.equal(r4.cooldown_ms, 250, 'stays capped');
  });

  it('persists no token-derived material (only the hashed key + capped context)', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const fp = egressConfigFingerprint({ channel: 'telegram', recipient: '999', token: '123:SECRETVALUE' });
    const key = egressThrottleKey({ eventId: 'evt', service: SERVICE, fingerprint: fp });
    recordEgressFailure({ throttleDir, key, now: T0, eventId: 'evt', service: SERVICE });
    const raw = fs.readFileSync(path.join(throttleDir, `${key}.throttle`), 'utf8');
    assert.ok(!raw.includes('SECRETVALUE'));
    assert.ok(!raw.includes('123:SECRET'));
  });

  it('clear wipes the cooldown', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const key = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: 'fp' });
    recordEgressFailure({ throttleDir, key, now: T0 });
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 }).throttled, true);
    assert.equal(clearEgressThrottle({ throttleDir, key }).cleared, true);
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 }).throttled, false);
    assert.equal(clearEgressThrottle({ throttleDir, key }).cleared, false, 'clearing an absent key is a no-op');
  });

  it('config-fix bypass: a fixed fingerprint is not gated by the old record', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const fpBroken = egressConfigFingerprint({ channel: 'telegram', recipient: '9', token: '' });
    const fpFixed = egressConfigFingerprint({ channel: 'telegram', recipient: '9', token: 'now-set' });
    const keyBroken = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: fpBroken });
    const keyFixed = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: fpFixed });
    recordEgressFailure({ throttleDir, key: keyBroken, now: T0, baseMs: 3_600_000 });
    assert.equal(checkEgressThrottle({ throttleDir, key: keyBroken, now: T0 + 1000 }).throttled, true);
    assert.equal(checkEgressThrottle({ throttleDir, key: keyFixed, now: T0 + 1000 }).throttled, false);
  });

  it('sweeps records idle past maxAge, keeps recent ones', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const oldKey = egressThrottleKey({ eventId: 'old', service: SERVICE, fingerprint: 'fp1' });
    const freshKey = egressThrottleKey({ eventId: 'fresh', service: SERVICE, fingerprint: 'fp2' });
    recordEgressFailure({ throttleDir, key: oldKey, now: T0, baseMs: 100 }); // retry_at = T0+100
    recordEgressFailure({ throttleDir, key: freshKey, now: T0 + 10_000, baseMs: 100 }); // retry_at = T0+10100
    const swept = sweepEgressThrottles({ throttleDir, now: T0 + 10_200, maxAgeMs: 5_000 });
    assert.equal(swept.swept, 1);
    assert.equal(swept.remaining, 1);
    assert.ok(!fs.existsSync(path.join(throttleDir, `${oldKey}.throttle`)));
    assert.ok(fs.existsSync(path.join(throttleDir, `${freshKey}.throttle`)));
  });

  it('inspect rollup counts active throttles + earliest retry', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    assert.deepEqual(inspectEgressThrottles({ throttleDir, now: T0 }), {
      total: 0, active: 0, next_retry_at: null, unreadable: 0,
    });
    const kA = egressThrottleKey({ eventId: 'a', service: SERVICE, fingerprint: 'fpA' });
    const kB = egressThrottleKey({ eventId: 'b', service: SERVICE, fingerprint: 'fpB' });
    recordEgressFailure({ throttleDir, key: kA, now: T0, baseMs: 60_000 }); // retry T0+60s
    recordEgressFailure({ throttleDir, key: kB, now: T0, baseMs: 120_000 }); // retry T0+120s
    const insp = inspectEgressThrottles({ throttleDir, now: T0 + 1000 });
    assert.equal(insp.total, 2);
    assert.equal(insp.active, 2);
    assert.equal(insp.next_retry_at, new Date(T0 + 60_000).toISOString());
    // after A's cooldown lapses, only B is active
    const later = inspectEgressThrottles({ throttleDir, now: T0 + 61_000 });
    assert.equal(later.active, 1);
  });
});

// ── Attempt-mirror record ──

describe('egress attempt-mirror record', () => {
  it('builds an ENUMERATED record (§3) — egress overlay + capped routing, NO free text', () => {
    const event = {
      event_id: 'repo-x:approval:session:s1:aaaa:fired',
      kind: 'approval',
      urgency: 'urgent',
      title: 'a leaked secret 123:ABCDEF might live here',
      body: 'transcript tail with a token',
      hostname: 'boxA',
      topic: 'agentic-plugins:main',
      session_hint: 'sess-hash',
    };
    const mirror = buildEgressMirrorRecord({ event, service: SERVICE, egressStatus: 'failed', outcome: 'timeout', now: T0 });
    assert.equal(mirror.egress_channel, 'telegram');
    assert.equal(mirror.egress_status, 'failed');
    assert.equal(mirror.egress_outcome, 'timeout');
    assert.equal(mirror.egress_phase, 'outcome');
    assert.equal(mirror.event_id, event.event_id);
    assert.equal(mirror.kind, 'approval');
    assert.equal(mirror.urgency, 'urgent');
    assert.equal(mirror.hostname, 'boxA');
    assert.equal(mirror.topic, 'agentic-plugins:main');
    assert.equal(mirror.session_hint, 'sess-hash');
    assert.ok(mirror.ts, 'carries a timestamp');
    // §2b/§8 — NO local free text is spread into the egress artifact.
    assert.ok(!('title' in mirror), 'no title free text');
    assert.ok(!('body' in mirror), 'no body free text');
    assert.ok(!JSON.stringify(mirror).includes('leaked secret'), 'no free-text leak');
  });

  it('omits routing fields absent from the event', () => {
    const mirror = buildEgressMirrorRecord({ event: { kind: 'idle' }, service: SERVICE, egressStatus: 'dispatched', outcome: 'dispatched', now: T0 });
    assert.ok(!('hostname' in mirror));
    assert.ok(!('topic' in mirror));
    assert.ok(!('session_hint' in mirror));
  });

  it('control-strips enumerated + routing values', () => {
    const mirror = buildEgressMirrorRecord({
      event: { hostname: 'box\n\tA', kind: 'app\rroval' },
      service: 'tele\ngram',
      egressStatus: 'failed',
      outcome: 'time\rout',
      now: T0,
    });
    assert.equal(mirror.egress_channel, 'tele gram');
    assert.equal(mirror.egress_outcome, 'time out');
    assert.equal(mirror.hostname, 'box A');
    assert.equal(mirror.kind, 'app roval');
  });

  it('rejects an out-of-enum egress status and a missing service', () => {
    assert.throws(() => buildEgressMirrorRecord({ event: {}, service: SERVICE, egressStatus: 'nope', outcome: 'x' }), /egressStatus must be one of/);
    assert.throws(() => buildEgressMirrorRecord({ event: {}, service: '', egressStatus: 'failed', outcome: 'x' }), /service/);
  });
});

// ── Orchestration + ADR-0041 §7 required scenarios ──

describe('egress finalization (claim finalization + throttle) — ADR-0041 §7', () => {
  it('a successful dispatch promotes the claim and clears any throttle', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const { eventId, ownerToken, claimPath } = preClaim(dedupeDir);
    const fingerprint = 'fp';
    // pre-existing throttle from an earlier failure (records id_hash so the
    // by-event clear on success can find it — the finalize path always passes
    // eventId/service).
    const key = egressThrottleKey({ eventId, service: SERVICE, fingerprint });
    recordEgressFailure({ throttleDir, key, now: T0, eventId, service: SERVICE });
    const res = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken,
      outcome: EGRESS_OUTCOMES.DISPATCHED, service: SERVICE, fingerprint, now: T0 + 1000,
    });
    assert.equal(res.egressStatus, 'dispatched');
    assert.equal(res.claim.promoted, true);
    assert.ok(fs.existsSync(claimPath), 'promoted claim persists');
    assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).finalized, 'promoted');
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 + 1000 }).throttled, false, 'throttle cleared on success');
  });

  it('a missing token releases the claim and records a throttle (retry after fix)', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const { eventId, ownerToken, claimPath } = preClaim(dedupeDir);
    const res = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken,
      outcome: EGRESS_OUTCOMES.MISSING_TOKEN, service: SERVICE, fingerprint: 'fp-no-token', now: T0,
    });
    assert.equal(res.egressStatus, 'suppressed');
    assert.equal(res.claim.released, true);
    assert.ok(!fs.existsSync(claimPath), 'claim released so a fixed config re-fires');
    assert.equal(res.throttle.failure_count, 1);
  });

  it('a timeout releases the claim and records a throttle', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const { eventId, ownerToken, claimPath } = preClaim(dedupeDir);
    const res = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken,
      outcome: EGRESS_OUTCOMES.TIMEOUT, service: SERVICE, fingerprint: 'fp', now: T0,
    });
    assert.equal(res.egressStatus, 'failed');
    assert.equal(res.claim.released, true);
    assert.ok(!fs.existsSync(claimPath));
    assert.equal(res.throttle.failure_count, 1);
  });

  it('repeated provider failure engages the throttle so the next event does not re-dispatch', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const eventId = 'repo-x:turn-complete:session:s9:p1:fired';
    const fingerprint = 'fp';
    // first attempt fails
    const c1 = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now: T0 });
    finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken: c1.ownerToken,
      outcome: EGRESS_OUTCOMES.PROVIDER_ERROR, service: SERVICE, fingerprint, now: T0, baseMs: 60_000,
    });
    // next identical event, shortly after: throttle gate says do not attempt
    const gate = shouldAttemptEgress({ throttleDir, eventId, service: SERVICE, fingerprint, now: T0 + 5_000 });
    assert.equal(gate.attempt, false);
    assert.equal(gate.throttled, true);
    assert.equal(gate.failureCount, 1);
  });

  it('later success within the TTL promotes cleanly after an earlier failure released the slot', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const eventId = 'repo-x:approval:session:s1:bbbb:fired';
    const fingerprint = 'fp';
    // fail: release + throttle
    const c1 = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now: T0 });
    finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken: c1.ownerToken,
      outcome: EGRESS_OUTCOMES.PROVIDER_ERROR, service: SERVICE, fingerprint, now: T0, baseMs: 100,
    });
    // cooldown lapses; re-claim succeeds because the slot was released
    const c2 = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now: T0 + 200 });
    assert.equal(c2.claimed, true, 'slot free to re-claim after release');
    const res = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken: c2.ownerToken,
      outcome: EGRESS_OUTCOMES.DISPATCHED, service: SERVICE, fingerprint, now: T0 + 200,
    });
    assert.equal(res.claim.promoted, true);
    const key = egressThrottleKey({ eventId, service: SERVICE, fingerprint });
    assert.equal(checkEgressThrottle({ throttleDir, key, now: T0 + 200 }).throttled, false, 'throttle cleared by the eventual success');
  });

  it('config-fix bypass end to end: a fixed fingerprint attempts even while the old one is in cooldown', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const eventId = 'repo-x:idle:session:s2:fired';
    const fpBroken = egressConfigFingerprint({ channel: 'telegram', recipient: '9', token: '' });
    const fpFixed = egressConfigFingerprint({ channel: 'telegram', recipient: '9', token: 'set-now' });
    const c1 = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now: T0 });
    finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken: c1.ownerToken,
      outcome: EGRESS_OUTCOMES.MISSING_TOKEN, service: SERVICE, fingerprint: fpBroken, now: T0, baseMs: 3_600_000,
    });
    assert.equal(shouldAttemptEgress({ throttleDir, eventId, service: SERVICE, fingerprint: fpBroken, now: T0 + 1000 }).attempt, false, 'broken config still gated');
    assert.equal(shouldAttemptEgress({ throttleDir, eventId, service: SERVICE, fingerprint: fpFixed, now: T0 + 1000 }).attempt, true, 'fixed config bypasses immediately');
  });

  it('quiet-hours promotes (burns the TTL per ADR-0040) and leaves the throttle untouched', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const { eventId, ownerToken, claimPath } = preClaim(dedupeDir);
    const res = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken,
      outcome: EGRESS_OUTCOMES.QUIET_HOURS, service: SERVICE, fingerprint: 'fp', now: T0,
    });
    assert.equal(res.egressStatus, 'suppressed');
    assert.equal(res.claim.promoted, true);
    assert.ok(fs.existsSync(claimPath));
    assert.equal(res.throttle, null, 'quiet-hours does not touch the throttle');
  });

  it('finalize with no owner token skips the claim step (outcome resolved before a claim)', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const res = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId: 'e', ownerToken: null,
      outcome: EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION, service: SERVICE, fingerprint: 'fp', now: T0,
    });
    assert.equal(res.claim.skipped, true);
    assert.equal(res.throttle.failure_count, 1, 'throttle still records');
  });

  it('exposes the default backoff base constant', () => {
    assert.equal(EGRESS_THROTTLE_BASE_MS, 60_000);
  });
});

// Hardening from the Codex Plan-verify ensemble (plan-verify-20260705T102502Z).
describe('egress peer-review hardening (ADR-0041 §6/§7)', () => {
  it('suppressThrottledEgress releases the owned claim and signals no mirror', () => {
    const root = makeRepo();
    const { dedupeDir } = dirs(root);
    const { eventId, ownerToken, claimPath } = preClaim(dedupeDir);
    const res = suppressThrottledEgress({ dedupeDir, eventId, ownerToken });
    assert.equal(res.egressStatus, 'suppressed');
    assert.equal(res.mirror, false);
    assert.equal(res.claim.released, true);
    assert.ok(!fs.existsSync(claimPath), 'throttled event frees the slot for post-cooldown retry');
  });

  it('suppressThrottledEgress with no owner token is a safe no-op', () => {
    const root = makeRepo();
    const { dedupeDir } = dirs(root);
    const res = suppressThrottledEgress({ dedupeDir, eventId: 'e', ownerToken: null });
    assert.equal(res.mirror, false);
    assert.equal(res.claim.skipped, true);
  });

  it('clearEgressThrottlesForEvent wipes every fingerprint record for the event/service', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const eventId = 'repo-x:approval:session:s1:aaaa:fired';
    const kOld = egressThrottleKey({ eventId, service: SERVICE, fingerprint: 'fp-broken' });
    const kNew = egressThrottleKey({ eventId, service: SERVICE, fingerprint: 'fp-fixed' });
    const kOther = egressThrottleKey({ eventId: 'other', service: SERVICE, fingerprint: 'fp' });
    recordEgressFailure({ throttleDir, key: kOld, now: T0, eventId, service: SERVICE });
    recordEgressFailure({ throttleDir, key: kNew, now: T0, eventId, service: SERVICE });
    recordEgressFailure({ throttleDir, key: kOther, now: T0, eventId: 'other', service: SERVICE });
    const res = clearEgressThrottlesForEvent({ throttleDir, eventId, service: SERVICE });
    assert.equal(res.cleared, 2, 'both fingerprints for the event cleared');
    assert.ok(!fs.existsSync(path.join(throttleDir, `${kOld}.throttle`)));
    assert.ok(!fs.existsSync(path.join(throttleDir, `${kNew}.throttle`)));
    assert.ok(fs.existsSync(path.join(throttleDir, `${kOther}.throttle`)), 'a different event is untouched');
  });

  it('a success clears the orphaned old-fingerprint throttle (dashboard no longer shows it active)', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    const eventId = 'repo-x:idle:session:s2:fired';
    const fpBroken = egressConfigFingerprint({ channel: 'telegram', recipient: '9', token: '' });
    const fpFixed = egressConfigFingerprint({ channel: 'telegram', recipient: '9', token: 'set' });
    const c1 = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now: T0 });
    finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken: c1.ownerToken,
      outcome: EGRESS_OUTCOMES.MISSING_TOKEN, service: SERVICE, fingerprint: fpBroken, now: T0, baseMs: 3_600_000,
    });
    assert.equal(inspectEgressThrottles({ throttleDir, now: T0 + 1000 }).active, 1);
    const c2 = claimDedupe({ dedupeDir, eventId, ttlSeconds: 300, now: T0 + 2000 });
    finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken: c2.ownerToken,
      outcome: EGRESS_OUTCOMES.DISPATCHED, service: SERVICE, fingerprint: fpFixed, now: T0 + 2000,
    });
    assert.equal(inspectEgressThrottles({ throttleDir, now: T0 + 2000 }).active, 0, 'orphaned old-fingerprint throttle cleared on success');
  });

  it('the throttle artifact stores a non-reversible id_hash, never the raw event_id or 32-hex key', () => {
    const root = makeRepo();
    const { throttleDir } = dirs(root);
    const eventId = 'repo-secret:approval:session:UNIQUEMARKER:fired';
    const key = egressThrottleKey({ eventId, service: SERVICE, fingerprint: 'fp' });
    const rec = recordEgressFailure({ throttleDir, key, now: T0, eventId, service: SERVICE });
    assert.equal(rec.id_hash, egressEventHash(eventId, SERVICE));
    const raw = fs.readFileSync(path.join(throttleDir, `${key}.throttle`), 'utf8');
    assert.ok(!raw.includes('UNIQUEMARKER'), 'raw event_id not persisted');
    assert.ok(!raw.includes(key), '32-hex key not duplicated in the body');
  });

  it('finalization is fail-closed on the hook path — fs errors are data, not throws', () => {
    const root = makeRepo();
    const { dedupeDir, throttleDir } = dirs(root);
    // Make the throttle dir path a FILE so mkdir/write fails.
    fs.mkdirSync(path.dirname(throttleDir), { recursive: true });
    fs.writeFileSync(throttleDir, 'not a dir');
    const key = egressThrottleKey({ eventId: 'e', service: SERVICE, fingerprint: 'fp' });
    const rec = recordEgressFailure({ throttleDir, key, now: T0, eventId: 'e', service: SERVICE });
    assert.equal(rec.persisted, false, 'unpersisted throttle reported as data');
    // Make the dedupe dir a FILE so the finalization lock cannot be taken.
    fs.rmSync(dedupeDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dedupeDir), { recursive: true });
    fs.writeFileSync(dedupeDir, 'not a dir');
    const rel = releaseClaim({ dedupeDir, eventId: 'e', ownerToken: 'tok' });
    assert.equal(rel.released, false);
    assert.match(rel.reason, /^(error:|no-claim)/);
  });
});
