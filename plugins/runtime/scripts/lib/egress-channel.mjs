// plugins/runtime/scripts/lib/egress-channel.mjs
//
// ADR-0041 §2b/§2f/§3/§5 Telegram egress channel — the NETWORK-FREE helper half
// of the E1 (enumerated-metadata network egress) channel slice. This module owns
// everything the pinned request needs EXCEPT the request itself:
//
//   1. buildEgressPayload (§2f/§3) — the SEPARATE egress payload builder that
//      emits ONLY the enumerated §3 progress fields (kind / topic / hostname /
//      session_hint / workflow_id / phase). It NEVER carries title, body,
//      message, refs.path, next_action free text, transcript, event_id, source,
//      or urgency — ADR-0040's title/body are for LOCAL channels only. This is
//      the mechanical guarantee behind "a notification is a trigger + context,
//      the detail is pulled by opening the session".
//   2. the §5 secret-scrub (bearer / credential-URL / key-shaped patterns,
//      lib/secret-scrub.mjs `scrubSecrets`) applied to every enumerated field
//      before its cap, as defense-in-depth. It REDUCES exposure; it is not a
//      proof (the proof is the enumerated field set + no free text in §3). The
//      rule set has no bare long-run rule, so session_hint (a hash by §4) and a
//      long workflow_id survive it.
//   3. renderEgressText / buildTelegramSendBody — the plain-text Telegram
//      message (NO parse_mode — ADR-0041 §4, so no escaping surface) and the
//      fixed { chat_id, text } sendMessage body, with a bounded body-size cap.
//   4. validateTelegramToken / validateTelegramChatId (§2b) — shape validation so
//      a malformed credential can never be interpolated into the request path and
//      a malformed recipient can never be sent.
//   5. classifyTelegramResult / classifyTelegramError / mapActivationReasonToOutcome
//      — pure maps from a (bounded) dispatch result, a caught rejection, or a
//      loadEgressActivation misconfiguration reason to an EGRESS_OUTCOMES token.
//
// Deliberately NOT here (notify.mjs, ADR-0041 §2b/§2d/§2e): the pinned global
// request call. The Node global network primitive has no import to anchor on;
// the executor guard (runtime-executor-scan global-fetch-gate) FLAGS EVERY
// reference to it in ANY runtime script and permits exactly one direct pinned
// call in the single GLOBAL_FETCH_USERS file (notify.mjs). So this module — like
// every other lib the guard scans — must contain NO such reference at all; the
// channel calls these pure helpers around notify.mjs's one pinned request. This
// module performs NO network or filesystem I/O; it is pure data transformation
// and is unit-testable in isolation (test-egress-channel.mjs).

import { EGRESS_OUTCOMES } from './egress-semantics.mjs';
import { scrubSecrets } from './secret-scrub.mjs';
import {
  OPTIONAL_ROUTING_FIELDS,
  ROUTING_FIELD_CAPS,
  OPTIONAL_HEADLINE_FIELD,
  HEADLINE_FIELD_CAP,
  isHeadlineToken,
} from './notify-schema.mjs';

// v1 egress service. EGRESS_CHANNELS (egress-config) is the enum; the pinned
// request lives in notify.mjs. A future service (ADR-0041 §9) adds its own
// pinned request + this service label; the payload builder + scrub are already
// service-agnostic.
export const TELEGRAM_SERVICE = 'telegram';

// kind cap — matches notify.mjs REDACT_FIELD_CAPS.kind / egress-semantics
// EGRESS_MIRROR_CAPS.kind so the egress body and the mirror agree.
export const EGRESS_KIND_CAP = 32;

// The Telegram sendMessage `text` field allows up to 4096 UTF-16 code units. We
// render only capped enumerated fields, so the text is inherently short; the cap
// is a defense-in-depth bound (§2b "body size capped") well under the API limit.
export const EGRESS_TEXT_CAP = 1024;
// A generous but bounded ceiling on the whole JSON body — an over-cap body
// resolves to EGRESS_OUTCOMES.BODY_CAP (a failure that is not re-thrown), never a
// send of unbounded size.
export const EGRESS_MAX_BODY_BYTES = 8192;

// The enumerated §3 workflow-projection fields (carried in event.refs). Capped
// like the routing fields; NEVER refs.path / refs.run_id (those are local-render
// / debug context, not egress trigger context).
export const EGRESS_REFS_FIELDS = Object.freeze(['workflow_id', 'phase']);
export const EGRESS_REFS_CAPS = Object.freeze({ workflow_id: 128, phase: 64 });

// C0 + DEL + C1 controls → single spaces (mirrors notify.mjs / egress-semantics
// sanitize). Built from char codes at load so the SOURCE carries neither a
// literal control byte nor a \u escape. The runtime class matches
// U+0000-U+001F (C0 controls), U+007F (DEL), and U+0080-U+009F (C1 controls).
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}`
  + `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);

// Control-strip + collapse-whitespace (NO cap). Mirrors notify.mjs sanitizeText's
// normalization half, split out so the secret-scrub can run on the FULL
// normalized value before any truncation.
function normalizeText(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalize + cap. Mirrors notify.mjs sanitizeText so an egress field renders
// identically to a local one.
function sanitize(value, cap) {
  return normalizeText(value).slice(0, cap);
}

// Normalize → SCRUB the full value → cap. The scrub MUST run before the cap: a
// credential URL or token longer than a field cap would otherwise be truncated
// (losing its `@` / marker) BEFORE scrubSecrets sees it, leaking a secret
// fragment into the egress body (peer CRITICAL — scrub was applied only to the
// already-capped rendered text). Scrubbing the normalized full value first
// redacts the secret while it is still intact, then the [redacted] result is
// capped.
function scrubCap(value, cap) {
  return scrubSecrets(normalizeText(value)).slice(0, cap);
}

// ---------------------------------------------------------------------------
// §2f / §3 — the separate egress payload builder (enumerated fields ONLY)
// ---------------------------------------------------------------------------

// Emit ONLY the §3 enumerated progress fields, each capped. A field is included
// only when the event carries a non-empty string for it — an older producer that
// omits routing fields yields a payload with just `kind` (backward-compatible).
// The set is a fixed allowlist: any event key NOT named here (title, body,
// message, refs.path, refs.run_id, next_action, transcript, event_id, source,
// urgency, …) is structurally absent from the egress body, so redaction/scrub is
// a second line, not the only line (§2f test asserts the exclusion directly).
export function buildEgressPayload(event = {}, { headlineOptIn = false } = {}) {
  // scrubCap (scrub-before-cap) on every enumerated field: even though §3 keeps
  // free text OUT of the body, an operator can fumble a credential-shaped value
  // into an enumerated field (a credential-URL topic, a token-shaped id); the
  // scrub is §5's defense-in-depth for that, and it must run before the per-field
  // cap so a cap-truncated secret cannot evade it (peer CRITICAL).
  const payload = { kind: scrubCap(event.kind, EGRESS_KIND_CAP) };
  for (const field of OPTIONAL_ROUTING_FIELDS) {
    if (typeof event[field] === 'string' && event[field].length > 0) {
      payload[field] = scrubCap(event[field], ROUTING_FIELD_CAPS[field]);
    }
  }
  const refs = event.refs && typeof event.refs === 'object' && !Array.isArray(event.refs) ? event.refs : {};
  for (const field of EGRESS_REFS_FIELDS) {
    if (typeof refs[field] === 'string' && refs[field].length > 0) {
      payload[field] = scrubCap(refs[field], EGRESS_REFS_CAPS[field]);
    }
  }
  // ADR-0041 §3a — the opt-in closed-vocabulary headline. VALIDATE-OR-DROP
  // (Guard 2): included ONLY when the operator opted in AND event.headline is an
  // EXACT closed-vocab member; an unknown/absent/whitespace-padded value is dropped,
  // never coerced. Without the opt-in it is never egressed, whatever the event
  // carries. scrubCap is uniform §5 defense-in-depth — a valid token has nothing to
  // scrub and cannot exceed its cap, but the pass runs so a future vocab change
  // cannot silently regress.
  if (headlineOptIn && isHeadlineToken(event[OPTIONAL_HEADLINE_FIELD])) {
    payload[OPTIONAL_HEADLINE_FIELD] = scrubCap(event[OPTIONAL_HEADLINE_FIELD], HEADLINE_FIELD_CAP);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Plain-text render + fixed sendMessage body (§4 no parse_mode, §2b body cap)
// ---------------------------------------------------------------------------

// Render the enumerated payload as ONE short plain-text line. Deliberately terse
// — "which machine, what work, how far along" — never free text. No parse_mode is
// used (§4), so there is no markdown/HTML escaping surface to get wrong.
export function renderEgressText(payload = {}) {
  const parts = [];
  parts.push(payload.kind || 'event');
  // ADR-0041 §3a — the opt-in status token, right after kind (it qualifies "what
  // state is this session in"). Presentational only: buildEgressPayload already
  // gated it on the opt-in + vocab membership, so a present `headline` is a valid,
  // capped token.
  if (payload.headline) parts.push(payload.headline);
  if (payload.hostname) parts.push(`@${payload.hostname}`);
  if (payload.topic) parts.push(payload.topic);
  if (payload.workflow_id) {
    parts.push(payload.phase ? `wf ${payload.workflow_id}/${payload.phase}` : `wf ${payload.workflow_id}`);
  }
  if (payload.session_hint) parts.push(payload.session_hint);
  return sanitize(parts.join(' · '), EGRESS_TEXT_CAP);
}

// Build the fixed Telegram sendMessage JSON body. Only { chat_id, text } — no
// parse_mode, no reply markup, no free-form keys. Returns { ok, body, outcome }.
// A body exceeding EGRESS_MAX_BODY_BYTES resolves to BODY_CAP (a recorded failure,
// never a send).
export function buildTelegramSendBody({ chatId, text } = {}) {
  const body = JSON.stringify({ chat_id: chatId, text });
  if (Buffer.byteLength(body, 'utf8') > EGRESS_MAX_BODY_BYTES) {
    return { ok: false, body: null, outcome: EGRESS_OUTCOMES.BODY_CAP };
  }
  return { ok: true, body, outcome: null };
}

// ---------------------------------------------------------------------------
// §2b — token / recipient shape validation
// ---------------------------------------------------------------------------

// A Telegram bot token is `<bot_id digits>:<35-char auth>` over a URL-path-safe
// alphabet ([A-Za-z0-9_-]). Validating the shape BEFORE interpolation means the
// token can only ever contribute path-safe characters to the pinned URL — no
// '/', '?', '#', ':' beyond the single separator — so raw interpolation is safe
// without percent-encoding (which Telegram would reject on the ':').
export function validateTelegramToken(token) {
  return typeof token === 'string' && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token);
}

// A Telegram chat-id is a signed integer (private/group id) or `@channelusername`
// (5-32 word chars). It rides in the JSON body (not the URL), so JSON encoding
// already neutralizes it; the shape check is defense-in-depth and rejects an
// obviously-wrong value (e.g. a fumbled token) before a pointless send.
export function validateTelegramChatId(chatId) {
  return typeof chatId === 'string' && /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId);
}

// ---------------------------------------------------------------------------
// Outcome classification (pure — no network, no network-primitive reference)
// ---------------------------------------------------------------------------

// Map a loadEgressActivation misconfiguration reason (an ENGAGED-but-not-active
// egress) to an EGRESS_OUTCOMES token. 'active' and 'missing-activation' never
// reach here (active dispatches; missing-activation is not engaged).
export function mapActivationReasonToOutcome(reason) {
  switch (reason) {
    case 'missing-credential':
      return EGRESS_OUTCOMES.MISSING_TOKEN;
    case 'missing-recipient':
      return EGRESS_OUTCOMES.MISSING_RECIPIENT;
    case 'unknown-egress-channel':
    case 'credential-collision':
    default:
      return EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION;
  }
}

// Classify a completed (bounded) request from its coarse booleans. The caller
// (notify.mjs) reads ONLY response.status (a number) and the Telegram `ok`
// boolean — never the raw response text (§3: no raw response text is egressed or
// mirrored). httpOk = 2xx; telegramOk = the parsed body's `ok === true`.
export function classifyTelegramResult({ httpOk, telegramOk } = {}) {
  if (!httpOk) return EGRESS_OUTCOMES.PROVIDER_ERROR; // 4xx/5xx
  return telegramOk ? EGRESS_OUTCOMES.DISPATCHED : EGRESS_OUTCOMES.PROVIDER_REJECTED; // 200 { ok:false }
}

// Classify a caught rejection from the bounded await. The bounded
// `AbortSignal.timeout` fires a TimeoutError/AbortError; a native node:https socket
// timeout (ADR-0041 §2d transport) surfaces instead as a system error with
// `code: 'ETIMEDOUT'` (name 'Error') — both are egress timeouts, distinct from a
// connection refusal/unreachable (ECONNREFUSED/ENETUNREACH → a provider error).
// A `redirect: 'error'` hit (the fetch test-seam) rejects with a redirect-mentioning
// error; everything else (DNS, connection reset, TLS) is a provider error. undici
// wraps the real reason as `error.cause` (the top-level message is a bland "fetch
// failed"), so both are inspected — REDIRECT_ERROR and PROVIDER_ERROR share a
// disposition, so a mislabel is cosmetic, but the checks keep the mirror's
// egress_outcome accurate.
export function classifyTelegramError(error) {
  const name = error?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError' || error?.code === 'ETIMEDOUT') return EGRESS_OUTCOMES.TIMEOUT;
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''} ${error?.cause?.name ?? ''}`;
  if (/redirect/i.test(text)) return EGRESS_OUTCOMES.REDIRECT_ERROR;
  return EGRESS_OUTCOMES.PROVIDER_ERROR;
}
