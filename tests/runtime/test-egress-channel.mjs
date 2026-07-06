// Tests for the ADR-0041 §2b/§2f/§3/§5 Telegram egress channel helper lib
// (plugins/runtime/scripts/lib/egress-channel.mjs) — the network-free half of
// the E1 channel slice. These are pure-function unit tests; the runEmit-level
// integration (pinned request via fetchImpl, claim finalization, throttle,
// attempt-mirror) lives in tests/runtime/test-notify.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EGRESS_KIND_CAP,
  EGRESS_MAX_BODY_BYTES,
  EGRESS_TEXT_CAP,
  buildEgressPayload,
  buildTelegramSendBody,
  classifyTelegramError,
  classifyTelegramResult,
  mapActivationReasonToOutcome,
  renderEgressText,
  scrubSecrets,
  validateTelegramChatId,
  validateTelegramToken,
} from '../../plugins/runtime/scripts/lib/egress-channel.mjs';
import { EGRESS_OUTCOMES } from '../../plugins/runtime/scripts/lib/egress-semantics.mjs';
import { ROUTING_FIELD_CAPS } from '../../plugins/runtime/scripts/lib/notify-schema.mjs';

// ---------------------------------------------------------------------------
// buildEgressPayload — §2f/§3 enumerated allowlist ONLY
// ---------------------------------------------------------------------------

describe('egress buildEgressPayload (§2f/§3)', () => {
  const fullEvent = {
    event_id: 'repo:approval:host-mba:session:s1:aaaa:fired',
    source: 'attention-claude',
    kind: 'approval',
    title: 'Approval needed',
    body: 'sensitive body',
    message: 'sensitive message',
    urgency: 'urgent',
    hostname: 'mba',
    topic: 'repo:main',
    session_hint: 'sess12',
    next_action: 'do the thing',
    refs: { workflow_id: 'wf-1', phase: 'phase-3', path: '/secret/p', run_id: 'r1' },
  };

  it('emits ONLY the enumerated §3 fields (kind + routing + workflow projection)', () => {
    const payload = buildEgressPayload(fullEvent);
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['hostname', 'kind', 'phase', 'session_hint', 'topic', 'workflow_id'],
    );
  });

  it('NEVER carries title / body / message / next_action / event_id / source / urgency / refs.path / refs.run_id', () => {
    const payload = buildEgressPayload(fullEvent);
    for (const forbidden of ['title', 'body', 'message', 'next_action', 'event_id', 'source', 'urgency', 'path', 'run_id']) {
      assert.ok(!(forbidden in payload), `${forbidden} must be excluded from the egress payload`);
    }
  });

  it('a minimal (older-producer) event with no routing fields yields just { kind }', () => {
    const payload = buildEgressPayload({ kind: 'turn-complete' });
    assert.deepEqual(payload, { kind: 'turn-complete' });
  });

  it('caps each field and strips control characters', () => {
    const payload = buildEgressPayload({
      kind: 'approval',
      hostname: 'h'.repeat(ROUTING_FIELD_CAPS.hostname + 20),
      topic: 'a\tb\nc',
      session_hint: 's'.repeat(100),
    });
    assert.equal(payload.hostname.length, ROUTING_FIELD_CAPS.hostname);
    assert.equal(payload.topic, 'a b c');
    assert.equal(payload.session_hint.length, ROUTING_FIELD_CAPS.session_hint);
    assert.ok(payload.kind.length <= EGRESS_KIND_CAP);
  });

  it('ignores non-string or empty enumerated values', () => {
    const payload = buildEgressPayload({ kind: 'idle', hostname: '', topic: 42, refs: { workflow_id: null } });
    assert.deepEqual(payload, { kind: 'idle' });
  });

  it('tolerates a missing/invalid refs object', () => {
    assert.deepEqual(buildEgressPayload({ kind: 'idle', refs: null }), { kind: 'idle' });
    assert.deepEqual(buildEgressPayload({ kind: 'idle', refs: ['x'] }), { kind: 'idle' });
  });
});

// ---------------------------------------------------------------------------
// scrubSecrets — §5 defense-in-depth
// ---------------------------------------------------------------------------

describe('egress scrubSecrets (§5)', () => {
  it('redacts a credential-bearing URL', () => {
    const out = scrubSecrets('see https://user:hunter2pw@host.example/path now');
    assert.ok(!out.includes('hunter2pw'));
    assert.match(out, /https:\/\/\[redacted\]@host\.example/);
  });

  it('redacts a bearer token', () => {
    const out = scrubSecrets('Authorization: Bearer abcDEF123456ghiJKL');
    assert.ok(!out.includes('abcDEF123456ghiJKL'));
    assert.match(out, /bearer \[redacted\]/i);
  });

  it('redacts a Telegram-bot-token shape', () => {
    const out = scrubSecrets('token 123456789:AAA_bbbCCCdddEEEfffGGGhhhIII here');
    assert.ok(!out.includes('123456789:AAA'));
    assert.match(out, /\[redacted\]/);
  });

  it('redacts common provider key prefixes incl. AWS AKIA and ASIA (temporary)', () => {
    for (const key of ['sk-abcdef1234567890ABCDEF', 'ghp_abcdefghijklmnop1234', 'AKIAABCDEFGHIJKLMNOP', 'ASIAIOSFODNN7EXAMPLE']) {
      assert.match(scrubSecrets(`k=${key}`), /\[redacted\]/, `${key} should be redacted`);
      assert.ok(!scrubSecrets(`k=${key}`).includes(key), `${key} must not survive`);
    }
  });

  it('leaves ordinary short text untouched', () => {
    assert.equal(scrubSecrets('approval · @mba · repo:main'), 'approval · @mba · repo:main');
  });

  it('does NOT redact structured routing ids (a long workflow_id / session hash is not a secret)', () => {
    // The bare "long high-entropy run" rule was deliberately dropped: session_hint
    // (a §4 hash, cap 32) and a long workflow_id (cap 128) are the routing fields
    // the notification exists to show, and are indistinguishable from a raw secret
    // by length. A `{32,}` rule would eat them.
    const wf = 'investigate-20260705T124630Z-53da47c9f1';
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    assert.equal(scrubSecrets(`wf ${wf} · ${hash}`), `wf ${wf} · ${hash}`);
  });

  it('is null/undefined-safe', () => {
    assert.equal(scrubSecrets(undefined), '');
    assert.equal(scrubSecrets(null), '');
  });
});

// ---------------------------------------------------------------------------
// renderEgressText — plain text, enumerated only
// ---------------------------------------------------------------------------

describe('egress renderEgressText', () => {
  it('renders a terse enumerated line', () => {
    const text = renderEgressText({
      kind: 'approval', hostname: 'mba', topic: 'repo:main', workflow_id: 'wf-1', phase: 'p3', session_hint: 's12',
    });
    assert.equal(text, 'approval · @mba · repo:main · wf wf-1/p3 · s12');
  });

  it('omits absent fields and falls back to a kind label', () => {
    assert.equal(renderEgressText({ kind: 'idle' }), 'idle');
    assert.equal(renderEgressText({}), 'event');
  });

  it('renders workflow_id without phase when phase is absent', () => {
    assert.equal(renderEgressText({ kind: 'workflow-terminal', workflow_id: 'wf-9' }), 'workflow-terminal · wf wf-9');
  });

  it('caps the rendered text', () => {
    const text = renderEgressText({ kind: 'approval', topic: 'x'.repeat(EGRESS_TEXT_CAP + 500) });
    assert.ok(text.length <= EGRESS_TEXT_CAP);
  });
});

// ---------------------------------------------------------------------------
// buildTelegramSendBody — fixed keys, no parse_mode, body cap
// ---------------------------------------------------------------------------

describe('egress buildTelegramSendBody (§2b/§4)', () => {
  it('builds { chat_id, text } with NO parse_mode', () => {
    const { ok, body } = buildTelegramSendBody({ chatId: '-100', text: 'hi' });
    assert.equal(ok, true);
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed).sort(), ['chat_id', 'text']);
    assert.ok(!('parse_mode' in parsed));
  });

  it('resolves BODY_CAP for an over-cap body (never a send of unbounded size)', () => {
    const { ok, body, outcome } = buildTelegramSendBody({ chatId: '-100', text: 'x'.repeat(EGRESS_MAX_BODY_BYTES + 10) });
    assert.equal(ok, false);
    assert.equal(body, null);
    assert.equal(outcome, EGRESS_OUTCOMES.BODY_CAP);
  });
});

// ---------------------------------------------------------------------------
// validateTelegramToken / validateTelegramChatId — §2b shape validation
// ---------------------------------------------------------------------------

describe('egress shape validation (§2b)', () => {
  it('accepts a well-shaped bot token, rejects malformed/injection-y ones', () => {
    assert.equal(validateTelegramToken('123456789:AAA_bbbCCCdddEEEfffGGGhhh'), true);
    for (const bad of ['', 'nope', '123:short', 'abc:defghijklmnopqrstuvwx', '123456789:has/slash-in-it-xxxxxxxxxxxxxxxx', undefined, 42]) {
      assert.equal(validateTelegramToken(bad), false, `${bad} must be rejected`);
    }
  });

  it('accepts a numeric or @username chat-id, rejects path-injection-y ones', () => {
    for (const good of ['-1001234567890', '42', '@my_channel']) {
      assert.equal(validateTelegramChatId(good), true, `${good} must be accepted`);
    }
    for (const bad of ['', 'x/y', '@ab', 'not a chat', undefined]) {
      assert.equal(validateTelegramChatId(bad), false, `${bad} must be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

describe('egress outcome classification', () => {
  it('classifyTelegramResult maps http/telegram booleans to outcomes', () => {
    assert.equal(classifyTelegramResult({ httpOk: true, telegramOk: true }), EGRESS_OUTCOMES.DISPATCHED);
    assert.equal(classifyTelegramResult({ httpOk: true, telegramOk: false }), EGRESS_OUTCOMES.PROVIDER_REJECTED);
    assert.equal(classifyTelegramResult({ httpOk: false, telegramOk: true }), EGRESS_OUTCOMES.PROVIDER_ERROR);
  });

  it('classifyTelegramError distinguishes timeout / redirect / provider', () => {
    assert.equal(classifyTelegramError({ name: 'TimeoutError' }), EGRESS_OUTCOMES.TIMEOUT);
    assert.equal(classifyTelegramError({ name: 'AbortError' }), EGRESS_OUTCOMES.TIMEOUT);
    // ADR-0041 §2d: a native node:https socket timeout is `code: 'ETIMEDOUT'` (name 'Error').
    assert.equal(classifyTelegramError({ code: 'ETIMEDOUT' }), EGRESS_OUTCOMES.TIMEOUT);
    // A connection refusal/unreachable stays a provider error (not a timeout).
    assert.equal(classifyTelegramError({ code: 'ECONNREFUSED' }), EGRESS_OUTCOMES.PROVIDER_ERROR);
    assert.equal(classifyTelegramError(new TypeError('fetch failed: redirect count exceeded')), EGRESS_OUTCOMES.REDIRECT_ERROR);
    assert.equal(classifyTelegramError(new TypeError('getaddrinfo ENOTFOUND')), EGRESS_OUTCOMES.PROVIDER_ERROR);
    assert.equal(classifyTelegramError(undefined), EGRESS_OUTCOMES.PROVIDER_ERROR);
  });

  it('mapActivationReasonToOutcome maps loadEgressActivation reasons', () => {
    assert.equal(mapActivationReasonToOutcome('missing-credential'), EGRESS_OUTCOMES.MISSING_TOKEN);
    assert.equal(mapActivationReasonToOutcome('missing-recipient'), EGRESS_OUTCOMES.MISSING_RECIPIENT);
    assert.equal(mapActivationReasonToOutcome('unknown-egress-channel'), EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION);
    assert.equal(mapActivationReasonToOutcome('credential-collision'), EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION);
    assert.equal(mapActivationReasonToOutcome('anything-else'), EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION);
  });
});
