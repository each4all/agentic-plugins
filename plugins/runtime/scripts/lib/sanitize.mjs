// Generic value sanitization for runtime reports and artifacts (ADR-0057 §Decision 3).
//
// Line normalization, secret redaction, and the `sanitizeValue` composition of
// the two. Every runtime surface that emits an observed value into a report,
// an artifact, or a portable machine profile passes it through here first.
//
// This module was the generic half of `lib/permission-sanitize.mjs`. It was
// named for the permission advisor because that was its first consumer, but
// the name outlived the relationship: ADR-0057 removed the advisor and
// measured seven non-advisor importers of these four functions
// (`dashboard`, `doctor`, `settings`, `state-readers`, `machine-probe`,
// `machine-profile`, `legacy-assurance-reader`) against three advisor ones.
// The advisor-only half — `tokenizeCommand`, `stripEnvAssignments`,
// `generalizeCommand` — had exactly two consumers, both deleted with the
// advisor, and went with them.
//
// `data/schemas/agentic-machine-profile-1.3.json` names this module
// NORMATIVELY as the sanitizer the profile's permission arrays pass through,
// so the path is a contract, not an implementation detail.
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
// The CREDENTIAL half of `redactSecrets`, as a predicate.
//
// `redactSecrets` deliberately rewrites two classes: credentials (url userinfo,
// provider tokens, AWS keys, `password=`, bearer) and things merely PII- or
// digest-shaped (an email address, any 32+ hex run — which is every git sha, image
// digest and dashless UUID). For SANITIZING they are alike: neither belongs in an
// exported artifact verbatim.
//
// For REFUSING they are not, and conflating them was a measured regression. The
// profile write gate refuses when a raw source value is secret-shaped, on the
// documented principle that a token must not be quietly laundered — but under the
// union predicate a permission rule mentioning `git show <40-hex>` or
// `--author=someone@example.com` became a hard refusal the operator could only clear
// by editing host config, while the sanitizer's redaction became unreachable for
// exactly the class it was written to clean.
//
// So: refuse on this predicate, sanitize the rest.
export function hasCredentialShape(value) {
  const text = String(value ?? '');
  return CREDENTIAL_PATTERNS.some((re) => re.test(text));
}

const CREDENTIAL_PATTERNS = Object.freeze([
  /([a-z][a-z0-9+.-]*):\/\/[^/@\s]+@/i,
  /\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_=:-]{12,}\b/,
  /\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{12,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /(password)\s*[=:]\s*\S+/i,
  /bearer\s+[\w.+=~/-]+/i,
]);

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
