// Shared permission-advisor sanitize util (ADR-0038 §5).
//
// Pure helpers used by the runtime permission advisor (doctor diagnosis +
// settings plan). This module owns the single source of truth for line
// normalization, secret redaction, and observed-command -> pattern
// generalization, replacing the previously divergent per-file copies
// (doctor.mjs had strong token redaction; settings.mjs stripped only
// control chars). It performs NO artifact writes and NO host-config
// access — those belong to later advisor slices (permission-artifacts,
// settings-claude/codex).
//
// Invariants carried forward from ADR-0035 §3/§6:
//   - the recommended rule is a generalized PATTERN, never the verbatim
//     argument string;
//   - secret-shaped tokens are redacted from any retained value.

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

// Generalize an observed command line into a safe pattern (ADR-0038 §5).
// Keeps the program name, plus a second token ONLY when it is a bare
// subcommand identifier (e.g. `npm run`, `git commit`) — never a flag
// (`-x`) or a path/file (`script.mjs`). Every remaining argument is
// dropped to `*`, so no verbatim argument (and thus no secret-shaped
// argument) is ever retained. The result is passed through redactSecrets
// as a second line of defense in case a kept token itself looks secret.
//
// This is pure mechanism: it makes NO safety judgement about whether the
// resulting pattern is allow/deny/ask-worthy — that classification is the
// advisor-core slice's responsibility.
//
// Tools whose second token is a bare subcommand, so keeping it is safe and
// useful (`npm run`, `git commit`). For every other program the second
// token may be a positional argument — a path, a database name, a password
// — so it is dropped (Codex review MAJOR: ADR-0038 §5 "never the verbatim
// argument string"; `mysql hunter2` must generalize to `mysql *`, not
// `mysql hunter2 *`).
const SUBCOMMAND_WRAPPERS = new Set([
  'npm', 'yarn', 'pnpm', 'npx', 'bun', 'deno',
  'git', 'cargo', 'go', 'docker', 'kubectl', 'gh',
  'pip', 'poetry', 'brew', 'apt', 'make',
]);

// Strip a path prefix from a program token, keeping only the final component, so
// an absolute/relative executable path (which may carry a private directory)
// never becomes the rule pattern (e.g. `/Users/alice/bin/tool` -> `tool`). A
// bare name is returned unchanged.
function basenameProgram(token) {
  const t = String(token).replace(/\/+$/, '');
  const slash = t.lastIndexOf('/');
  return slash >= 0 ? t.slice(slash + 1) : t;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Tokenize a normalized single-line command, keeping a QUOTED run — which may
// contain spaces — as a single token.
//
// This exists because a naive `split(' ')` is not safe here. It tears
// `TOKEN="a b" npm test` into `TOKEN="a`, `b"`, `npm`, `test`. The
// env-assignment strip then removes only the assignment-shaped head, which
// PROMOTES the orphaned tail (`b"`) into the program slot — and the program
// slot is emitted verbatim into the rule pattern, the JSON report, the text
// output, and the written advisory artifact. That is a secret leak, not a
// cosmetic bug: `TOKEN="first s3cr3t" npm test` used to generalize to
// `s3cr3t" *`.
//
// Two earlier reviews each hardened one of the two independent copies of this
// tokenizer for the UNQUOTED case only (see the `Plan-verify MAJOR #2` and
// `Plan-verify local finding` comments this replaces). The duplication is what
// let the same defect survive twice, so the tokenizer now lives here once and
// `permission-advisor-core.gradeCommand` consumes it too.
//
// `unterminated` reports an unbalanced quote so callers can fail closed rather
// than emit a token whose boundary we could not determine.
export function tokenizeCommand(normalized) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (const ch of String(normalized ?? '')) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ' ') {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return { tokens, unterminated: quote !== null };
}

// Drop leading `FOO=bar` / `FOO="a b"` env-assignment prefixes so an
// env-injected secret can never survive as the kept program token.
export function stripEnvAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) i += 1;
  return tokens.slice(i);
}

export function generalizeCommand(raw) {
  const normalized = singleLine(raw);
  if (!normalized) return '';
  const { tokens: rawTokens, unterminated } = tokenizeCommand(normalized);
  // An unbalanced quote means we could not determine where the quoted value
  // ended, so we cannot prove the program token is not part of it. Fail closed:
  // callers drop an empty pattern (`permission-usage-learner` skips it,
  // `isValidRule` rejects it), so a dropped observation is strictly safer than
  // a possibly-leaking one.
  if (unterminated) return '';
  const tokens = stripEnvAssignments(rawTokens);
  if (!tokens.length) return '';
  // Basename a path-shaped program so a private path is never retained
  // (Plan-verify MINOR #6).
  const program = basenameProgram(tokens[0]);
  if (!program) return '';
  // Belt-and-braces: a real program name never carries a quote character. If
  // one survives, our tokenization lost a value boundary somewhere we did not
  // anticipate — drop the observation rather than emit it.
  if (/["']/.test(program)) return '';
  const kept = [program];
  const second = tokens[1];
  if (SUBCOMMAND_WRAPPERS.has(program) && second && /^[a-z][a-z0-9-]*$/i.test(second)) {
    kept.push(second);
  }
  const hasMore = tokens.length > kept.length;
  const pattern = kept.join(' ') + (hasMore ? ' *' : '');
  return redactSecrets(pattern);
}
