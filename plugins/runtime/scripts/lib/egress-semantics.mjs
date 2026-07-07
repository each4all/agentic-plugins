// plugins/runtime/scripts/lib/egress-semantics.mjs
//
// ADR-0041 §6/§7 egress SEMANTICS — the network-free core of the E1
// cross-machine notification egress channel. This module owns:
//
//   1. the egress outcome TAXONOMY (§7) — the fixed set of things that can
//      happen to an egress attempt, each mapped to a (claim, throttle,
//      egress_status) disposition;
//   2. the claim-FINALIZATION orchestration (§7) over notify-schema's
//      promoteClaim/releaseClaim — success promotes the pre-claim (it owns the
//      TTL), failure releases ONLY the owned claim so a fixed config re-fires;
//   3. the failure THROTTLE (§7) — an exponential-backoff cooldown keyed by
//      (event + service + config/credential fingerprint) that stops a
//      persistently-failing provider from re-dispatching on every repeated
//      event, and is BYPASSED automatically the moment the operator fixes
//      config/credential (the fingerprint — and therefore the key — changes);
//   4. the attempt-MIRROR record shape + timing (§6) — a single sanitized
//      file-log row per finalized attempt carrying egress_channel /
//      egress_status so runtime:dashboard reflects reality (including
//      missing-token / failed / suppressed attempts) without the network step
//      blocking or hiding outcomes.
//
// Deliberately NOT here (channel slice, ADR-0041 §5/§2b/§2d/§2e): the pinned
// Telegram fetch, buildEgressPayload, the egress secret-scrub, and the actual
// file-log write. This module never sees a token/recipient in the clear — it
// consumes only a one-way config fingerprint — so nothing here can leak one.
// It imports notify-schema (the dedupe home) but NEVER notify.mjs (the
// emitter), so it stays a pure, side-effect-scoped, independently unit-testable
// library; the channel wires these primitives into the emit pipeline.
//
// Attempt-mirror timing decision (peer Edge4 — pre-attempt+outcome rows vs a
// single post-outcome row): a SINGLE post-outcome row. The §2e bounded await
// guarantees an outcome (a hung network resolves to `timeout` → failed) before
// the row is written, so a second pre-attempt row would only double the
// file-log volume and complicate the dashboard's "recent notifications" pairing
// for no added reality — the one row already carries dispatched/suppressed/
// failed. A process SIGKILL mid-await is the only gap (no row); it is out of
// scope for the bounded hook path and no worse than today's local channels.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  notifyStateDir,
  promoteClaim,
  releaseClaim,
  OPTIONAL_ROUTING_FIELDS,
  ROUTING_FIELD_CAPS,
  OPTIONAL_HEADLINE_FIELD,
  HEADLINE_FIELD_CAP,
  isHeadlineToken,
} from './notify-schema.mjs';

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

// Control-strip + collapse-whitespace, an OPTIONAL secret-scrub, then cap.
// Mirrors notify.mjs's sanitizeText so mirror-record fields render identically to
// local-channel fields. `scrub` (default identity) MUST run before the cap: a
// secret longer than the field cap would otherwise be truncated (losing its
// `@`/marker) before the scrub sees it, leaking a fragment into the mirror
// artifact (peer CRITICAL). notify.mjs injects the egress secret-scrub for the
// event-derived fields; the control fields (service/status enums) keep identity.
function sanitizeToken(value, cap, scrub = (s) => s) {
  const normalized = String(value ?? '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return scrub(normalized).slice(0, cap);
}

// Join key components with a single NUL delimiter (injective — no component
// can contain NUL) for the identity hashes below. Centralized here via a char
// code so the delimiter is defined once, never a fragile inline control-char
// escape scattered across call sites.
const EGRESS_KEY_DELIM = String.fromCharCode(0);
function egressJoin(...parts) {
  return parts.map((part) => String(part ?? '')).join(EGRESS_KEY_DELIM);
}

// ---------------------------------------------------------------------------
// §7 outcome taxonomy
// ---------------------------------------------------------------------------

// The fixed set of egress attempt outcomes. Every dispatch (or pre-dispatch
// gate) the channel can reach resolves to exactly one of these.
export const EGRESS_OUTCOMES = Object.freeze({
  DISPATCHED: 'dispatched',
  QUIET_HOURS: 'quiet-hours',
  BODY_CAP: 'body-cap',
  MISSING_TOKEN: 'missing-token',
  MISSING_RECIPIENT: 'missing-recipient',
  INVALID_LOCAL_ACTIVATION: 'invalid-local-activation',
  PROVIDER_ERROR: 'provider-error', // provider 4xx/5xx
  PROVIDER_REJECTED: 'provider-rejected', // Telegram { ok: false }
  TIMEOUT: 'timeout',
  REDIRECT_ERROR: 'redirect-error',
});

// The §6 mirror status enum — the coarse, dashboard-facing rollup of an
// outcome. (The fine-grained outcome rides alongside as egress_outcome.)
export const EGRESS_STATUSES = Object.freeze(['dispatched', 'suppressed', 'failed']);

// Outcome → disposition. Three independent axes:
//   - egressStatus: the §6 coarse status written to the mirror.
//   - claim:  'promote' keeps the pre-claim (it owns the dedupe TTL) — used for
//             success AND for the intentional local suppressions that ADR-0040
//             says still burn a slot (quiet-hours), plus body-cap (retrying an
//             identical over-cap event is pointless). 'release' frees the slot
//             so the next identical event re-attempts — used for every failure
//             the operator can FIX (missing token/recipient, provider/timeout/
//             redirect errors), honoring §7's "a failed dispatch must not
//             consume the success TTL".
//   - throttle: 'record' engages the backoff cooldown (stops a repeated event
//             from re-dispatching against a persistent failure); 'clear' wipes
//             any prior cooldown on success; 'none' leaves the cooldown state
//             untouched (a time-window suppression, or a per-event content cap,
//             is not provider trouble).
const OUTCOME_TABLE = Object.freeze({
  [EGRESS_OUTCOMES.DISPATCHED]: { egressStatus: 'dispatched', claim: 'promote', throttle: 'clear' },
  [EGRESS_OUTCOMES.QUIET_HOURS]: { egressStatus: 'suppressed', claim: 'promote', throttle: 'none' },
  [EGRESS_OUTCOMES.BODY_CAP]: { egressStatus: 'failed', claim: 'promote', throttle: 'none' },
  [EGRESS_OUTCOMES.MISSING_TOKEN]: { egressStatus: 'suppressed', claim: 'release', throttle: 'record' },
  [EGRESS_OUTCOMES.MISSING_RECIPIENT]: { egressStatus: 'suppressed', claim: 'release', throttle: 'record' },
  [EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION]: { egressStatus: 'suppressed', claim: 'release', throttle: 'record' },
  [EGRESS_OUTCOMES.PROVIDER_ERROR]: { egressStatus: 'failed', claim: 'release', throttle: 'record' },
  [EGRESS_OUTCOMES.PROVIDER_REJECTED]: { egressStatus: 'failed', claim: 'release', throttle: 'record' },
  [EGRESS_OUTCOMES.TIMEOUT]: { egressStatus: 'failed', claim: 'release', throttle: 'record' },
  [EGRESS_OUTCOMES.REDIRECT_ERROR]: { egressStatus: 'failed', claim: 'release', throttle: 'record' },
});

// Resolve an outcome to its disposition. Unknown outcome throws — the channel
// must not invent a status; the taxonomy is closed.
export function classifyEgressOutcome(outcome) {
  const spec = OUTCOME_TABLE[outcome];
  if (!spec) {
    throw new TypeError(
      `unknown egress outcome "${outcome}" (valid: ${Object.keys(OUTCOME_TABLE).join(', ')})`,
    );
  }
  return { outcome, ...spec };
}

// ---------------------------------------------------------------------------
// §7 config/credential fingerprint + throttle key
// ---------------------------------------------------------------------------

// A one-way digest of the activation triple. It NEVER returns or stores the raw
// token/recipient: the 16-hex output is not reversible and not token-shaped
// (§2b), so it is safe to fold into a persisted throttle key. A change to ANY
// component — the operator sets a missing token, swaps the chat-id, flips the
// channel — yields a different fingerprint, hence a different throttle key,
// hence an automatic bypass of any in-cooldown throttle (§7 config-fix bypass).
export function egressConfigFingerprint({ channel = '', recipient = '', token = '' } = {}) {
  const material = egressJoin(channel, recipient, token);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

// Filesystem-safe composite throttle key. Folds in the fingerprint so a fixed
// config mints a new key with no record → bypass.
export function egressThrottleKey({ eventId, service, fingerprint } = {}) {
  requireNonEmptyString(eventId, 'eventId');
  requireNonEmptyString(service, 'service');
  requireNonEmptyString(fingerprint, 'fingerprint');
  return createHash('sha256')
    .update(egressJoin(eventId, service, fingerprint))
    .digest('hex')
    .slice(0, 32);
}

// A non-reversible (event + service) identity — WITHOUT the fingerprint — used
// to clear EVERY throttle for this event/service on success, whatever config
// fingerprint each was recorded under. That wipes the orphaned old-fingerprint
// record a config fix leaves behind (peer MINOR: else the dashboard counts it
// active until it ages out). It also replaces the raw event_id in the throttle
// artifact (peer MAJOR: a malformed producer could park token-shaped material
// in a syntactically-valid event_id). 16 hex is below the repo's 32-hex
// "secret-shaped" redaction threshold, so persisting it is safe.
export function egressEventHash(eventId, service) {
  requireNonEmptyString(eventId, 'eventId');
  requireNonEmptyString(service, 'service');
  return createHash('sha256').update(egressJoin(eventId, service)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// §7 failure throttle (exponential backoff, config-fix bypass)
// ---------------------------------------------------------------------------

export const EGRESS_THROTTLE_BASE_MS = 60_000; // first cooldown after a failure
export const EGRESS_THROTTLE_MAX_MS = 3_600_000; // backoff ceiling (1h)
export const EGRESS_THROTTLE_SWEEP_AGE_MS = 24 * 3_600_000; // reap records idle > 24h

export function egressThrottleDir(repoRoot) {
  return path.join(notifyStateDir(repoRoot), 'egress-throttle');
}

function throttleFilePath(throttleDir, key) {
  return path.join(throttleDir, `${key}.throttle`);
}

function readThrottle(filePath) {
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
    return record;
  } catch {
    return null;
  }
}

// Read-only cooldown check. Absent/corrupt/lapsed record ⇒ not throttled.
export function checkEgressThrottle({ throttleDir, key, now = Date.now() } = {}) {
  requireNonEmptyString(throttleDir, 'throttleDir');
  requireNonEmptyString(key, 'key');
  const record = readThrottle(throttleFilePath(throttleDir, key));
  if (record === null) return { throttled: false, retryAtMs: null, failureCount: 0 };
  const retryAtMs = Number(record.retry_at_ms);
  const failureCount = Number(record.failure_count) || 0;
  if (!Number.isFinite(retryAtMs)) return { throttled: false, retryAtMs: null, failureCount };
  return { throttled: now < retryAtMs, retryAtMs, failureCount };
}

// Engage / extend the cooldown after a failed attempt. Exponential backoff
// base·2^(n-1), capped at maxMs. Persists ONLY non-secret material: a
// non-reversible (event+service) id_hash (never the raw event_id — a malformed
// producer could park token-shaped text in a syntactically-valid one) plus the
// public service name. The 32-hex throttle key stays in the FILENAME, never the
// record body (the body must carry no 32-hex "secret-shaped" string). Fail-
// closed on the hook path: an fs failure is reported via persisted:false, never
// thrown — an unpersisted throttle just means the next event re-attempts, the
// safe direction for a storm-suppressant.
export function recordEgressFailure({
  throttleDir,
  key,
  now = Date.now(),
  eventId = null,
  service = null,
  baseMs = EGRESS_THROTTLE_BASE_MS,
  maxMs = EGRESS_THROTTLE_MAX_MS,
} = {}) {
  requireNonEmptyString(throttleDir, 'throttleDir');
  requireNonEmptyString(key, 'key');
  const filePath = throttleFilePath(throttleDir, key);
  const prior = readThrottle(filePath);
  const failureCount = (Number(prior?.failure_count) || 0) + 1;
  // 2^(n-1) overflows to Infinity for large n; Math.min pins it to maxMs.
  const cooldownMs = Math.min(baseMs * 2 ** (failureCount - 1), maxMs);
  const record = {
    id_hash: eventId && service ? egressEventHash(eventId, service) : null,
    service: service ? sanitizeToken(service, 64) : null,
    first_failed_at: prior?.first_failed_at ?? new Date(now).toISOString(),
    last_failed_at: new Date(now).toISOString(),
    failure_count: failureCount,
    cooldown_ms: cooldownMs,
    retry_at_ms: now + cooldownMs,
    retry_at: new Date(now + cooldownMs).toISOString(),
  };
  try {
    fs.mkdirSync(throttleDir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);
    record.persisted = true;
  } catch (error) {
    record.persisted = false;
    record.error = error?.code ?? error?.message ?? 'write-failed';
  }
  return record;
}

// Wipe the cooldown for a single key. Fail-closed: an fs error is data, never a
// throw.
export function clearEgressThrottle({ throttleDir, key } = {}) {
  requireNonEmptyString(throttleDir, 'throttleDir');
  requireNonEmptyString(key, 'key');
  try {
    fs.unlinkSync(throttleFilePath(throttleDir, key));
    return { cleared: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { cleared: false, reason: 'absent' };
    return { cleared: false, reason: `error:${error?.code ?? 'unlink-failed'}` };
  }
}

// Clear EVERY throttle for an (event + service), whatever config fingerprint
// each was recorded under — called on a successful dispatch so a config fix's
// success also wipes the orphaned old-fingerprint record (peer MINOR: else the
// dashboard counts it active until it ages out), not just the current key.
// Matches on the stored id_hash; fail-closed.
export function clearEgressThrottlesForEvent({ throttleDir, eventId, service } = {}) {
  requireNonEmptyString(throttleDir, 'throttleDir');
  requireNonEmptyString(eventId, 'eventId');
  requireNonEmptyString(service, 'service');
  const idHash = egressEventHash(eventId, service);
  let names;
  try {
    names = fs.readdirSync(throttleDir);
  } catch {
    return { cleared: 0 };
  }
  let cleared = 0;
  for (const name of names) {
    if (!name.endsWith('.throttle')) continue;
    const filePath = path.join(throttleDir, name);
    const record = readThrottle(filePath);
    if (record && record.id_hash === idHash) {
      try {
        fs.unlinkSync(filePath);
        cleared += 1;
      } catch {
        // best effort — a leftover record ages out via sweepEgressThrottles
      }
    }
  }
  return { cleared };
}

// Reap throttle records whose cooldown lapsed long ago — a config fix orphans
// the old-fingerprint record (a new key is used going forward), so without a
// sweep those files would accumulate one-per-config-change. Bounded retention.
export function sweepEgressThrottles({
  throttleDir,
  now = Date.now(),
  maxAgeMs = EGRESS_THROTTLE_SWEEP_AGE_MS,
} = {}) {
  let names;
  try {
    names = fs.readdirSync(throttleDir);
  } catch {
    return { swept: 0, remaining: 0 };
  }
  let swept = 0;
  let remaining = 0;
  for (const name of names) {
    if (!name.endsWith('.throttle')) continue;
    const filePath = path.join(throttleDir, name);
    const record = readThrottle(filePath);
    const retryAtMs = Number(record?.retry_at_ms);
    if (Number.isFinite(retryAtMs) && now - retryAtMs >= maxAgeMs) {
      try {
        fs.unlinkSync(filePath);
        swept += 1;
      } catch {
        remaining += 1;
      }
    } else {
      remaining += 1;
    }
  }
  return { swept, remaining };
}

// Dashboard/health rollup (§6): how many egress throttles exist and how many
// are actively gating (now < retry_at), plus the earliest upcoming retry.
export function inspectEgressThrottles({ throttleDir, now = Date.now() } = {}) {
  const result = { total: 0, active: 0, next_retry_at: null, unreadable: 0 };
  let names;
  try {
    names = fs.readdirSync(throttleDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return result;
    result.unreadable += 1;
    return result;
  }
  let earliest = null;
  for (const name of names) {
    if (!name.endsWith('.throttle')) continue;
    result.total += 1;
    const record = readThrottle(path.join(throttleDir, name));
    if (record === null) {
      result.unreadable += 1;
      continue;
    }
    const retryAtMs = Number(record.retry_at_ms);
    if (Number.isFinite(retryAtMs) && now < retryAtMs) {
      result.active += 1;
      if (earliest === null || retryAtMs < earliest) earliest = retryAtMs;
    }
  }
  result.next_retry_at = earliest === null ? null : new Date(earliest).toISOString();
  return result;
}

// ---------------------------------------------------------------------------
// §6 attempt-mirror record shape
// ---------------------------------------------------------------------------

// The mirror is a single post-outcome row (see the timing decision in the
// module header). The channel writes it to the SAME file-log the local channels
// use (notify.mjs appendFileLog). It is built from the ENUMERATED event fields
// ONLY (§3) — deliberately NOT by spreading the local redacted record: local
// title/body free text is cap+control-stripped but NOT secret-scrubbed, so
// spreading it could persist a token-shaped value into an egress artifact (peer
// MAJOR, §2b). The enumerated set (kind + routing/context) is the same "which
// machine, what work, how far along" trigger §3 egresses; the detail is pulled
// by opening the session, never carried in the mirror.
export const EGRESS_MIRROR_PHASE = 'outcome';
export const EGRESS_MIRROR_CAPS = Object.freeze({ event_id: 256, kind: 32, urgency: 16 });
export const EGRESS_RECORD_FIELDS = Object.freeze([
  'egress_channel',
  'egress_status',
  'egress_outcome',
  'egress_phase',
]);

export function buildEgressMirrorRecord({
  event = {},
  service,
  egressStatus,
  outcome,
  now = Date.now(),
  scrub = (s) => s,
  headlineOptIn = false,
} = {}) {
  requireNonEmptyString(service, 'service');
  if (!EGRESS_STATUSES.includes(egressStatus)) {
    throw new TypeError(`egressStatus must be one of ${EGRESS_STATUSES.join(', ')}`);
  }
  // `scrub` runs before each cap on the EVENT-DERIVED fields (event_id / kind /
  // urgency / routing) — the ones a malformed producer could load with a
  // credential-shaped value; the control fields (service/status enums) carry no
  // secret and keep identity. notify.mjs injects the egress secret-scrub.
  const mirror = {
    ts: new Date(now).toISOString(),
    event_id: sanitizeToken(event.event_id, EGRESS_MIRROR_CAPS.event_id, scrub),
    kind: sanitizeToken(event.kind, EGRESS_MIRROR_CAPS.kind, scrub),
    urgency: sanitizeToken(event.urgency, EGRESS_MIRROR_CAPS.urgency, scrub),
    egress_channel: sanitizeToken(service, 64),
    egress_status: egressStatus,
    egress_outcome: sanitizeToken(outcome, 64),
    egress_phase: EGRESS_MIRROR_PHASE,
  };
  // Capped routing/context fields when the event carries them (which machine /
  // repo:branch / session) — the only non-enumerated data the dashboard needs.
  for (const field of OPTIONAL_ROUTING_FIELDS) {
    if (typeof event[field] === 'string' && event[field].length > 0) {
      mirror[field] = sanitizeToken(event[field], ROUTING_FIELD_CAPS[field], scrub);
    }
  }
  // ADR-0041 §3a — the opt-in closed-vocabulary headline, mirrored with the SAME
  // validate-or-drop guard as buildEgressPayload (Guard 2) so the attempt-mirror
  // and the egress body agree (the parity a producer/runtime drift test asserts).
  // sanitizeToken(scrub) is uniform §5 defense-in-depth; a valid vocab token has
  // nothing to scrub and cannot exceed its cap.
  if (headlineOptIn && isHeadlineToken(event[OPTIONAL_HEADLINE_FIELD])) {
    mirror[OPTIONAL_HEADLINE_FIELD] = sanitizeToken(event[OPTIONAL_HEADLINE_FIELD], HEADLINE_FIELD_CAP, scrub);
  }
  return mirror;
}

// ---------------------------------------------------------------------------
// Orchestration (network-free) — the channel calls these around its dispatch
// ---------------------------------------------------------------------------

// Pre-dispatch gate: after the pipeline pre-claim, ask whether the throttle
// currently permits an attempt. When it does not, the channel releases the
// owned pre-claim (so the retry after cooldown is not itself deduped) and
// writes NO mirror row (a per-event cooldown must not spam the file-log — the
// dashboard surfaces active throttles from inspectEgressThrottles instead).
export function shouldAttemptEgress({
  throttleDir,
  eventId,
  service,
  fingerprint,
  now = Date.now(),
} = {}) {
  const key = egressThrottleKey({ eventId, service, fingerprint });
  const throttle = checkEgressThrottle({ throttleDir, key, now });
  return {
    attempt: !throttle.throttled,
    throttled: throttle.throttled,
    throttleKey: key,
    retryAtMs: throttle.retryAtMs,
    failureCount: throttle.failureCount,
  };
}

// The throttled-suppress path made a single explicit call (peer MAJOR:
// shouldAttemptEgress alone cannot release the claim — it has no dedupeDir /
// ownerToken — so a caller that forgot the release would let the pipeline
// pre-claim stand for the full dedupe TTL and suppress the retry after cooldown
// or config fix). Frees the owned pre-claim so the post-cooldown retry re-fires,
// and signals mirror:false — a per-event cooldown must NOT spam the file-log;
// the dashboard surfaces active throttles from inspectEgressThrottles instead.
export function suppressThrottledEgress({ dedupeDir, eventId, ownerToken, now = Date.now() } = {}) {
  let claim = { skipped: true, reason: 'no-owner-token' };
  if (typeof ownerToken === 'string' && ownerToken.length > 0) {
    claim = releaseClaim({ dedupeDir, eventId, ownerToken, now });
  }
  return { egressStatus: 'suppressed', outcome: 'throttled', mirror: false, claim };
}

// Post-dispatch finalization: classify the outcome, finalize the claim
// (promote/release the owned claim), and update the throttle (record backoff /
// clear on success / leave untouched). Returns the resolved egressStatus so the
// channel can build the mirror record. Robust to a missing ownerToken (an
// outcome resolved before a claim existed) — the claim step is then skipped.
export function finalizeEgressAttempt({
  dedupeDir,
  throttleDir,
  eventId,
  ownerToken,
  outcome,
  service,
  fingerprint,
  now = Date.now(),
  baseMs = EGRESS_THROTTLE_BASE_MS,
  maxMs = EGRESS_THROTTLE_MAX_MS,
} = {}) {
  const spec = classifyEgressOutcome(outcome);

  // 1. Claim finalization (only when this attempt owned a claim). promote/
  //    release are fail-closed (never throw) and reclaim-lock-serialized.
  let claim = { skipped: true, reason: 'no-owner-token' };
  if (typeof ownerToken === 'string' && ownerToken.length > 0) {
    claim = spec.claim === 'promote'
      ? promoteClaim({ dedupeDir, eventId, ownerToken, now })
      : releaseClaim({ dedupeDir, eventId, ownerToken, now });
  }

  // 2. Failure throttle.
  const key = egressThrottleKey({ eventId, service, fingerprint });
  let throttle = null;
  if (spec.throttle === 'record') {
    throttle = recordEgressFailure({ throttleDir, key, now, eventId, service, baseMs, maxMs });
  } else if (spec.throttle === 'clear') {
    // Clear by (event+service), not just this key, so a success following a
    // config fix also wipes the orphaned old-fingerprint record (peer MINOR).
    clearEgressThrottlesForEvent({ throttleDir, eventId, service });
  }

  return { outcome, egressStatus: spec.egressStatus, claim, throttle, throttleKey: key };
}
