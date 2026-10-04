// Generic value sanitization for runtime reports and artifacts (ADR-0057 §Decision 3).
//
// Line normalization, secret redaction, and the `sanitizeValue` composition of
// the two. Every runtime surface that emits an observed value into a report or
// an artifact passes it through here first.
//
// This module was the generic half of `lib/permission-sanitize.mjs`. It was
// named for the permission advisor because that was its first consumer, but
// the name outlived the relationship: ADR-0057 removed the advisor and
// measured seven non-advisor importers of these four functions
// (`dashboard`, `doctor`, `settings`, `state-readers`, `machine-probe`,
// `machine-profile`, `legacy-assurance-reader`) against three advisor ones.
// The advisor-only half — `tokenizeCommand`, `stripEnvAssignments`,
// `generalizeCommand` — had exactly two consumers, both deleted with the
// advisor, and went with them. `machine-profile` and its secret gate,
// `hasCredentialShape`, went with the portable machine profile (ADR-0064
// Decision 3).
//
// Invariant carried forward from ADR-0035 §6: a secret-shaped token is
// redacted from any retained value.

// Collapse every C0 control char (codepoint 0x00-0x1f) and DEL (0x7f) to
// a space, then squeeze whitespace. Implemented via charCodeAt rather
// than a regex character class so the control range is unambiguous in
// source. This settings-grade width keeps the unified helper at least as
// strict as both prior copies. Nullish coerces to "".
export function singleLine(value) {
  const text = String(value ?? '');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code <= 0x1f || code === 0x7f ? ' ' : text[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Redact secret-shaped tokens. The credential-URL rule runs first so the
// embedded user:pass is gone before the email rule can match the host
// half; password=/bearer rules use a capture group to keep the harmless
// key name while dropping the secret value.
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/([a-z][a-z0-9+.-]*):\/\/[^/@\s]+@/gi, '$1://<redacted>@')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_=:-]{12,}\b/g, '<redacted-token>')
    .replace(/\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{12,}\b/g, '<redacted-token>')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted-aws-key>')
    .replace(/(password)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/bearer\s+[\w.+=~/-]+/gi, 'Bearer <redacted>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted-hex>');
}

// singleLine then redactSecrets. Returns null for nullish so callers can
// drop the field rather than emit an empty string (pointer-safe).
export function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  return redactSecrets(singleLine(String(value)));
}
