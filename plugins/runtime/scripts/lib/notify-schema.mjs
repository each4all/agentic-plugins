// ADR-0040 §1 notification event schema + cross-surface dedupe contract.
//
// Runtime-internal contract lib shared by every notification producer
// (attention hook sensors, per-persona peer-run self-sensors) and the
// notify.mjs emitter (§2, later slice). This module owns the single
// source of truth for: the kind enum, the kind/subject mapping rules,
// event_id composition, repo-ident derivation, the pipeline ORDER
// contract, the notify_kinds filter predicate, and the atomic TTL
// dedupe claim under .agentic-plugins/state/runtime/notify/.
//
// Deliberately NOT here: channels, quiet-hours evaluation, redaction,
// CLI surface — those belong to the emitter slice (§2). This file must
// stay dependency-free and side-effect-free apart from claimDedupe's
// claim-file writes.
//
// Contract invariants (ADR-0040 §1; hostname dimension added by ADR-0041 §4):
//   - the dedupe key EXCLUDES source: two producers observing the same
//     subject moment must build byte-identical event_ids. ADR-0041 §4 adds an
//     OPTIONAL hostname to the identity: producers observing the SAME moment
//     must pass hostname UNIFORMLY (all with, or all without) or they build
//     distinct ids. This is safe for the built-in producer set because the
//     attention sensor is the sole producer of the hostname-bearing kinds
//     (approval / idle / turn-complete / workflow-terminal / subagent-complete)
//     and passes hostname on every one; other producers (peer-run self-sensors,
//     the Codex shuttle) emit different kinds and never collide. A future
//     producer of an attention kind MUST also pass hostname;
//   - ONLY kinds without a natural terminal status (approval / idle /
//     turn-complete) get the FIXED default status token; for every
//     status-bearing kind an absent status throws, so distinct status
//     moments can never silently collapse into one key;
//   - the kinds filter runs BEFORE dedupe, so a disabled event never
//     consumes a TTL slot and suppresses a later enabled one;
//   - concurrent claims race safely: first-claim via O_EXCL, stale-claim
//     reclaim via an mkdir critical section with an mtime re-check —
//     two processes observing an expired claim must not double-fire.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The §1 kind enum. Order is contractual documentation, not priority.
export const NOTIFY_KINDS = Object.freeze([
  'approval',
  'idle',
  'turn-complete',
  'subagent-complete',
  'workflow-terminal',
  'peer-run-terminal',
  'health',
]);

export const URGENCY_LEVELS = Object.freeze(['urgent', 'normal']);

// ADR-0041 §4 cross-machine routing/display fields — OPTIONAL, backward-
// compatible extensions to the §1 event schema. Older producers omit them and
// validateEvent still accepts events without them (independently-versioned
// producers that resolve a newer runtime but never populate these keep
// validating). The attention sensors populate them so multi-machine → one-chat
// egress (ADR-0041) can route and display "which machine, what work, how far
// along". Per-field caps bound what a later egress channel may transmit; the
// fields are born capped at build time and re-capped at the egress boundary
// (buildEgressPayload, ADR-0041 §2f) — validateEvent checks shape only, never
// enforces the cap (mirrors the title/body contract).
export const OPTIONAL_ROUTING_FIELDS = Object.freeze(['hostname', 'topic', 'session_hint']);
export const ROUTING_FIELD_CAPS = Object.freeze({
  hostname: 64,
  topic: 120,
  session_hint: 32,
});

// The §1 pipeline ORDER contract the emitter must execute. kinds-filter
// sits BEFORE dedupe by design (see invariants above); dedupe sits
// before quiet-hours so a suppressed-by-quiet-hours event still burns
// its TTL slot exactly once rather than re-firing at window close.
export const PIPELINE_ORDER = Object.freeze([
  'validate',
  'kinds-filter',
  'dedupe',
  'quiet-hours',
  'redact',
  'dispatch',
]);

// Fixed status token for kinds without a natural terminal status.
export const DEFAULT_STATUS_TOKEN = 'fired';

// The ONLY kinds the default token applies to (ADR-0040 §1). Every
// other kind carries a real status moment (completed/failed/…), and
// silently defaulting it would collapse distinct status moments of one
// subject into a single dedupe key — so an absent status there is a
// producer bug and throws.
export const KINDS_WITH_DEFAULT_STATUS = Object.freeze([
  'approval',
  'idle',
  'turn-complete',
]);

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function shortHash(text, length) {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

// Repo identity for the event_id's first segment. Deterministic per
// repo: realpath-normalized so symlinked/trailing-slash spellings of
// one repo converge, hashed so two repos with the same basename cannot
// collide, and colon-free so the segment boundary stays parseable.
export function deriveRepoIdent(repoRoot) {
  requireNonEmptyString(repoRoot, 'repoRoot');
  const resolved = path.resolve(repoRoot);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Nonexistent path (fixtures, dry planning) — resolve-only is still
    // deterministic for a given spelling.
  }
  const base = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  return `${base}-${shortHash(real, 16)}`;
}

// ADR-0041 §4 — derive a FIXED-LENGTH, colon-free host token for weaving into
// the event_id/dedupe key. The token is a short hash of the sanitized hostname
// (mirroring deriveRepoIdent's hashing), so weaving hostname adds a BOUNDED
// ~21 chars regardless of hostname length — a long hostname can never push the
// event_id past the emitter's 256-char cap (which would silently drop the
// notification). The human-readable hostname rides in the top-level
// event.hostname display field, so the id needs no readable host substring.
// Returns null when hostname is absent or sanitizes to empty — the id then
// stays byte-identical to the pre-ADR-0041 format, so producers that pass no
// hostname are completely unaffected (the copy-not-import parity gate depends
// on this).
function hostSegment(hostname) {
  if (typeof hostname !== 'string') return null;
  const sanitized = hostname.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, ROUTING_FIELD_CAPS.hostname);
  return sanitized.length > 0 ? `host-${shortHash(sanitized, 16)}` : null;
}

// Compose <repo-ident>:<kind>:<subject>:<status>. There is deliberately
// no source parameter — accepting one here is how dedupe would break.
// subject may contain colons (session:<id>:<hash>); repoIdent and
// status may not, so the first two and the last segment stay stable.
// ADR-0041 §4 — an OPTIONAL hostname weaves a bounded, colon-free host-hash
// token into the subject region so the dedupe key is per-machine distinct
// (multi-device → one-chat fan-in). Absent hostname ⇒ subject unchanged ⇒ id
// byte-identical to the pre-ADR-0041 format. The token rides in the subject
// region (not a new leading segment) precisely so validateEvent's segment
// cross-check accepts the woven id unchanged. NOTE: prefix-encoding a hostname
// into the subject is not strictly injective against an arbitrary subject that
// itself begins with the exact `host-<16hex>:` shape — a theoretical collision
// no built-in producer can hit (attention subjects are session:… / workflow /
// agent / run ids, never `host-`-prefixed hex).
export function buildEventId({ repoIdent, kind, subject, status, hostname } = {}) {
  requireNonEmptyString(repoIdent, 'repoIdent');
  requireNonEmptyString(subject, 'subject');
  if (!NOTIFY_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${NOTIFY_KINDS.join(', ')}`);
  }
  let effectiveStatus;
  if (status === undefined || status === null || status === '') {
    if (!KINDS_WITH_DEFAULT_STATUS.includes(kind)) {
      throw new TypeError(
        `status is required for kind "${kind}" — the default token applies only to ${KINDS_WITH_DEFAULT_STATUS.join(', ')}`,
      );
    }
    effectiveStatus = DEFAULT_STATUS_TOKEN;
  } else {
    effectiveStatus = requireNonEmptyString(status, 'status');
  }
  if (repoIdent.includes(':')) {
    throw new TypeError('repoIdent must not contain a colon');
  }
  if (effectiveStatus.includes(':')) {
    throw new TypeError('status must not contain a colon');
  }
  const hostToken = hostSegment(hostname);
  const effectiveSubject = hostToken ? `${hostToken}:${subject}` : subject;
  return `${repoIdent}:${kind}:${effectiveSubject}:${effectiveStatus}`;
}

// ── Kind/subject mapping rules (§1 — contract, not sensor discretion) ──

// Notification/permission_prompt → approval. The content hash keeps two
// DIFFERENT approval prompts in one session from deduping against each
// other; only a re-fire of the same prompt text dedupes.
export function approvalSubject({ sessionId, message } = {}) {
  requireNonEmptyString(sessionId, 'sessionId');
  if (typeof message !== 'string') {
    throw new TypeError('message must be a string');
  }
  return `session:${sessionId}:${shortHash(message, 12)}`;
}

// Notification/idle_prompt → idle. Session-only subject: one idle nudge
// per session per TTL window is the desired behavior.
export function idleSubject({ sessionId } = {}) {
  requireNonEmptyString(sessionId, 'sessionId');
  return `session:${sessionId}`;
}

// Bare Stop → turn-complete. session_id and prompt_id are documented
// common input fields on every hook event, so this subject never relies
// on a Stop-specific payload field.
export function turnCompleteSubject({ sessionId, promptId } = {}) {
  requireNonEmptyString(sessionId, 'sessionId');
  requireNonEmptyString(promptId, 'promptId');
  return `session:${sessionId}:${promptId}`;
}

// Stop with a fresh terminal workflow projection → workflow-terminal.
export function workflowTerminalSubject({ workflowId } = {}) {
  return requireNonEmptyString(workflowId, 'workflowId');
}

// SubagentStop → subagent-complete.
export function subagentCompleteSubject({ agentId } = {}) {
  return requireNonEmptyString(agentId, 'agentId');
}

// Peer-run terminal self-sensors (§5) → peer-run-terminal.
export function peerRunTerminalSubject({ runId } = {}) {
  return requireNonEmptyString(runId, 'runId');
}

// ── Event shape validation ──

// Result-object validator (never throws on bad input): the emitter's
// fail-closed pipeline needs errors as data, not exceptions.
export function validateEvent(event) {
  const errors = [];
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return { ok: false, errors: ['event must be an object'] };
  }
  for (const field of ['event_id', 'source', 'title']) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!NOTIFY_KINDS.includes(event.kind)) {
    errors.push(`kind must be one of ${NOTIFY_KINDS.join(', ')}`);
  }
  if (!URGENCY_LEVELS.includes(event.urgency)) {
    errors.push(`urgency must be one of ${URGENCY_LEVELS.join(', ')}`);
  }
  if (event.body !== undefined && typeof event.body !== 'string') {
    errors.push('body must be a string when present');
  }
  // ADR-0041 §4 — OPTIONAL cross-machine routing/display fields. Absent is
  // valid (backward-compat: older producers that resolve a newer runtime but
  // never populate these keep validating). When present each must be a string;
  // caps are applied at build time and re-applied at the egress boundary, never
  // enforced here (mirrors title/body — validate checks shape, redaction/build
  // applies caps).
  for (const field of OPTIONAL_ROUTING_FIELDS) {
    if (event[field] !== undefined && typeof event[field] !== 'string') {
      errors.push(`${field} must be a string when present`);
    }
  }
  if (event.refs !== undefined) {
    if (typeof event.refs !== 'object' || event.refs === null || Array.isArray(event.refs)) {
      errors.push('refs must be an object when present');
    } else {
      for (const [key, value] of Object.entries(event.refs)) {
        if (typeof value !== 'string') {
          errors.push(`refs.${key} must be a string`);
        }
      }
    }
  }
  // Cross-check the id's segments against the §1 composition rules:
  // repoIdent and status are colon-free by contract, so segment[0] is
  // the repo ident, segment[1] the kind, the last segment the status,
  // and everything between is the (possibly colon-bearing) subject.
  // Every segment must be non-empty — `repo:approval::fired` and
  // `:approval:s:fired` are producer bugs, not valid keys. This is what
  // forces every producer through buildEventId.
  if (typeof event.event_id === 'string' && event.event_id.length > 0) {
    const segments = event.event_id.split(':');
    if (segments.length < 4) {
      errors.push('event_id must have at least 4 colon-separated segments');
    } else {
      const [repoIdent, kindSegment] = segments;
      const status = segments[segments.length - 1];
      const subject = segments.slice(2, -1).join(':');
      if (repoIdent.length === 0) {
        errors.push('event_id repo-ident segment must be non-empty');
      }
      if (NOTIFY_KINDS.includes(event.kind) && kindSegment !== event.kind) {
        errors.push(
          `event_id kind segment "${kindSegment}" disagrees with kind "${event.kind}"`,
        );
      }
      if (subject.length === 0) {
        errors.push('event_id subject segment must be non-empty');
      }
      if (status.length === 0) {
        errors.push('event_id status segment must be non-empty');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── notify_kinds filter (pipeline stage 2 — BEFORE dedupe) ──

// Parse the notify_kinds CSV config value. Unset/blank means "no
// filter" (kinds: null → everything enabled). Unknown kind names are a
// hard parse error so a typo cannot silently disable notifications.
export function parseKindsFilter(raw) {
  if (raw === undefined || raw === null) return { ok: true, kinds: null, errors: [] };
  if (typeof raw !== 'string') {
    return { ok: false, kinds: null, errors: ['notify_kinds must be a string'] };
  }
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return { ok: true, kinds: null, errors: [] };
  const errors = [];
  const kinds = new Set();
  for (const token of tokens) {
    if (NOTIFY_KINDS.includes(token)) {
      kinds.add(token);
    } else {
      errors.push(`unknown notify kind "${token}" (valid: ${NOTIFY_KINDS.join(', ')})`);
    }
  }
  if (errors.length > 0) return { ok: false, kinds: null, errors };
  return { ok: true, kinds, errors: [] };
}

export function kindEnabled(kind, kinds) {
  if (kinds === null || kinds === undefined) return true;
  return kinds.has(kind);
}

// ── Notify state layout ──

export function notifyStateDir(repoRoot) {
  requireNonEmptyString(repoRoot, 'repoRoot');
  return path.join(repoRoot, '.agentic-plugins', 'state', 'runtime', 'notify');
}

export function notifyDedupeDir(repoRoot) {
  return path.join(notifyStateDir(repoRoot), 'dedupe');
}

// ── Atomic TTL dedupe claim ──

const DEFAULT_LOCK_STALE_MS = 60_000;

function claimFileName(eventId) {
  // Hash the id for the filename: event_ids carry colons and arbitrary
  // subject text, and the claim file must be filesystem-safe on every
  // platform. The full id is kept inside the file for debuggability.
  return `${shortHash(eventId, 32)}.claim`;
}

function writeClaimExclusive(claimPath, eventId, now) {
  // O_EXCL first-claim: exactly one process can create the file.
  const fd = fs.openSync(claimPath, 'wx');
  try {
    fs.writeSync(
      fd,
      `${JSON.stringify({ event_id: eventId, claimed_at: new Date(now).toISOString() })}\n`,
    );
  } finally {
    fs.closeSync(fd);
  }
}

function statMtimeMs(targetPath) {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readLockOwner(lockDir) {
  try {
    return fs.readFileSync(path.join(lockDir, 'owner'), 'utf8');
  } catch {
    return null;
  }
}

// Claim the right to fire eventId once per TTL window. Returns
// { claimed, reclaimed, reason?, claimPath } and never throws for
// concurrency outcomes (only for caller programming errors: bad TTL,
// empty id). `now` is the caller's observation clock (injectable for
// tests); claim age is always measured against filesystem mtime, so a
// deterministic caller must age files (utimes) rather than only moving
// `now` backwards. Concurrency contract:
//   - first claim: openSync 'wx' — losers observe EEXIST;
//   - fresh claim (mtime within TTL): { claimed: false, 'duplicate' };
//   - vanished claim (stat ENOENT after EEXIST — the unlink race):
//     tolerated via a single retry of the whole attempt;
//   - expired claim: reclaim guarded by an mkdir lock (atomic across
//     processes) carrying an owner nonce, with an mtime RE-CHECK and an
//     ownership RE-CHECK inside the critical section, so two processes
//     observing the same expired claim cannot both fire;
//   - a crashed reclaimer's stale lock (older than lockStaleMs) is
//     swept, but the sweeper CONCEDES this event ('swept-stale-lock')
//     instead of reclaiming behind a possibly-live peer — sweeping and
//     firing in one call is exactly the double-fire hole (a paused
//     reclaimer past lockStaleMs would lose its mutual exclusion and
//     both would fire). The next claim call finds no lock and reclaims
//     normally, so the slot cannot wedge permanently while the loss
//     stays bounded to one already-TTL-expired notification.
export function claimDedupe({
  dedupeDir,
  eventId,
  ttlSeconds,
  now = Date.now(),
  lockStaleMs = DEFAULT_LOCK_STALE_MS,
} = {}) {
  requireNonEmptyString(dedupeDir, 'dedupeDir');
  requireNonEmptyString(eventId, 'eventId');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('ttlSeconds must be a positive finite number');
  }
  fs.mkdirSync(dedupeDir, { recursive: true });
  const claimPath = path.join(dedupeDir, claimFileName(eventId));
  const ttlMs = ttlSeconds * 1000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeClaimExclusive(claimPath, eventId, now);
      return { claimed: true, reclaimed: false, claimPath };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    const mtimeMs = statMtimeMs(claimPath);
    if (mtimeMs === null) {
      // Unlink race: the holder vanished between EEXIST and stat.
      // Single retry of the exclusive create.
      continue;
    }
    if (now - mtimeMs < ttlMs) {
      return { claimed: false, reclaimed: false, reason: 'duplicate', claimPath };
    }

    // Expired claim — enter the reclaim critical section.
    const lockDir = `${claimPath}.reclaim.lock`;
    const ownerPath = path.join(lockDir, 'owner');
    const nonce = `${process.pid}-${shortHash(`${eventId}:${now}:${Math.random()}`, 16)}`;
    let lockAcquired = false;
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, nonce);
      lockAcquired = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      // Another process holds the reclaim lock. If that lock is stale
      // (crashed reclaimer), sweep it for the NEXT caller and concede
      // this event — never sweep-and-fire in the same call (see the
      // contract note above).
      const lockMtimeMs = statMtimeMs(lockDir);
      if (lockMtimeMs !== null && now - lockMtimeMs >= lockStaleMs) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Lost the sweep race — same concession either way.
        }
        return {
          claimed: false,
          reclaimed: false,
          reason: 'swept-stale-lock',
          claimPath,
        };
      }
      return { claimed: false, reclaimed: false, reason: 'lost-reclaim-race', claimPath };
    }

    try {
      // mtime RE-CHECK inside the lock: the claim may have been
      // reclaimed and re-created fresh while we were observing.
      const recheckedMtimeMs = statMtimeMs(claimPath);
      if (recheckedMtimeMs !== null && now - recheckedMtimeMs < ttlMs) {
        return { claimed: false, reclaimed: false, reason: 'duplicate', claimPath };
      }
      // Ownership RE-CHECK just before the destructive step: if our
      // lock was swept while we ran (we paused past lockStaleMs and a
      // successor took over), mutual exclusion is gone — concede
      // rather than unlink what may be the successor's fresh claim.
      // The check-to-unlink gap that remains requires a second
      // lockStaleMs-length pause inside these few statements.
      if (readLockOwner(lockDir) !== nonce) {
        return { claimed: false, reclaimed: false, reason: 'lost-reclaim-race', claimPath };
      }
      if (recheckedMtimeMs !== null) {
        try {
          fs.unlinkSync(claimPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
          // Tolerated unlink race.
        }
      }
      try {
        writeClaimExclusive(claimPath, eventId, now);
        return { claimed: true, reclaimed: true, claimPath };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        return { claimed: false, reclaimed: false, reason: 'lost-reclaim-race', claimPath };
      }
    } finally {
      if (lockAcquired && readLockOwner(lockDir) === nonce) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best-effort lock release; a leftover lock is swept as stale.
        }
      }
    }
  }
  return { claimed: false, reclaimed: false, reason: 'lost-claim-race', claimPath };
}
