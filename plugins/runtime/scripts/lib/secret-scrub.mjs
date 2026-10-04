// lib/secret-scrub.mjs — redact FORMATTED secrets from a string.
//
// Moved verbatim out of lib/egress-channel.mjs (ADR-0064 Decision 2, item 2),
// where it was the ADR-0041 §5 egress scrub. Its surviving consumer is
// lib/bootstrap-artifacts.mjs, whose fragment and proof writers refuse any text
// the scrub would change (ADR-0048 §4 scrub-before-write, fail-closed).
//
// This is a different rule set from lib/sanitize.mjs `redactSecrets`, and the
// two are not interchangeable: the writers here compare the scrubbed text to
// the original, so changing the rules changes what they refuse.

// Redact FORMATTED secrets — bearer tokens, credential-bearing URLs, and
// recognized key shapes. This is NOT a proof that no secret escapes; it
// reduces the residual risk of a secret-FORMATTED value reaching a written or
// sent text.
//
// Deliberately NO bare "long high-entropy run" rule: structured ids such as a
// session hash or a long workflow id (`investigate-<ts>-<hash>`) are
// indistinguishable from a raw secret by length alone, so a `{32,}` rule would
// redact the very ids a record exists to carry. The structured rules below key
// on distinguishing markers (scheme://, bearer, <digits>:, sk-/ghp-/AKIA
// prefixes) a hash/id does not carry. Order matters: URL credentials first (so
// user:pass@ is caught before another rule fragments it).
export function scrubSecrets(text) {
  let out = String(text ?? '');
  // scheme://user:secret@host → scheme://[redacted]@host
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  // Authorization: Bearer <token> / bearer <token>
  out = out.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer [redacted]');
  // Telegram-bot-token shape <digits>:<20+ base64ish>.
  out = out.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, '[redacted]');
  // Common provider key prefixes (sk-, pk-, ghp_, xoxb-, …) + a long run.
  out = out.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, '[redacted]');
  // AWS access-key ids: AKIA (long-term) AND ASIA (temporary/session) — the
  // repo's other sanitizers cover both, so this scrub must too (peer MAJOR).
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g, '[redacted]');
  return out;
}
