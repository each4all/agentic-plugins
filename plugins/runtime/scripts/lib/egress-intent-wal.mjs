// plugins/runtime/scripts/lib/egress-intent-wal.mjs
//
// The shared, read-only primitives of the egress intent WAL: where its
// directory lives, and how a name or a path drawn from it is made safe to show
// an operator.
//
// Extracted because a SECOND reader is arriving (`runtime:migrate
// legacy-egress-intents`, ADR-0048 residual (d)) and both readers are
// safety-critical. This repo has now been bitten three times in one session by
// the same shape — a fix landing on one of two copies while the other kept
// shipping the defect — and the lesson recorded from it is that merging is the
// fix, not duplicating with care. `doctor.mjs` already carried the mirror
// internally: it built the machine-global directory from a helper at its
// line 3422 and then spelled the SAME four components inline at its line 3919
// for the repo-scoped legacy one. Those were one path shape written twice, and
// the day the layout changes only one of them would move.
//
// Deliberately zero-syscall and dependency-light: `node:path` for joining and
// `node:crypto` for the truncation hash. Nothing here touches the filesystem —
// identity questions belong to `path-containment.mjs` `sameDirectory`, which
// asks the filesystem because spelling cannot answer them.

import { createHash } from 'node:crypto';
import { join } from 'node:path';

// The intent WAL's location RELATIVE to a root. Exported as components rather
// than as a joined string because the discovery scanner needs to `stat` exactly
// this suffix under a candidate root without enumerating anything below it — a
// full-depth walk was measured at depth 5 = 81k dirs / 14.9s and did not finish
// at depth 8, so the scan hunts the `.agentic-plugins` marker and then checks
// this fixed remainder.
export const EGRESS_INTENT_DIR_SUFFIX = Object.freeze(['.agentic-plugins', 'runs', 'doctor', 'egress-intents']);

// The WAL directory under `root`.
//
// Two roots reach this in production and they mean different things:
//   homedir()  the MACHINE-GLOBAL WAL — the live fence (ADR-0048 gap 2), so a
//              bootstrap run resumed from a different checkout still sees a
//              prior attempt.
//   repoRoot   a PRE-UPGRADE, repo-scoped WAL left by the older runtime.
//
// The function does not know which it was handed, and must not: deciding
// whether two of these are the same directory is `sameDirectory`'s job, by
// dev/ino, never by comparing the strings this function returns.
export function egressIntentDir(root) {
  return join(root, ...EGRESS_INTENT_DIR_SUFFIX);
}

// --- operator-facing text safety -------------------------------------------

// The characters that can forge or corrupt an operator-facing line, as a single
// predicate both defusing policies below are built on.
//
// This is the merge point. The two policies are deliberately different — one is
// an allowlist over the alphabet this WAL writes, the other passes ordinary
// text through — and the hazard they must BOTH keep out is the thing that would
// otherwise be learned twice and fixed once.
//
//   C0 / DEL / C1   a newline plus an ANSI escape forges an instruction line in
//                   a blocker message; this is the injection the modern WAL scan
//                   already fences and the legacy branch had left open.
//   bidi overrides  U+202E and friends reorder a rendered path, so a name can be
//                   displayed as something the operator did not agree to remove.
//   zero-width      invisible characters make two distinct paths render alike.
export function isDisplayHazard(codePoint) {
  return (codePoint <= 0x1f)                        // C0 controls (incl. \n, \r, ESC)
    || codePoint === 0x7f                            // DEL
    || (codePoint >= 0x80 && codePoint <= 0x9f)      // C1 controls
    || codePoint === 0x200b || codePoint === 0x200c  // ZWSP / ZWNJ
    || codePoint === 0x200d || codePoint === 0xfeff  // ZWJ / BOM
    || (codePoint >= 0x200e && codePoint <= 0x200f)  // LRM / RLM
    || (codePoint >= 0x202a && codePoint <= 0x202e)  // bidi embedding/override
    || (codePoint >= 0x2066 && codePoint <= 0x2069)  // bidi isolates
    // U+2028/U+2029 are LINE and PARAGRAPH SEPARATOR. They are not C0, so the
    // list above missed them (cross-host review), and terminals and log viewers
    // break lines on them — which is the whole forged-instruction hazard the C0
    // newline entry exists to stop.
    || codePoint === 0x2028 || codePoint === 0x2029;
}

// The alphabet this WAL actually writes: hex fingerprints, hex owner tokens,
// and the dots that join them. A name outside it is not one of ours.
//
// A SHAPE test is not a MEMBERSHIP test — the distinction is why this exists as
// an allowlist and not as a "looks reasonable" regex.
const EGRESS_SAFE_NAME_RE = /^[0-9A-Za-z._-]{1,128}$/;

// Render a WAL record name safely.
//
// STRICTER than `safeOperatorText` on purpose, and the strictness is sound
// rather than duplicated: a name that fails the allowlist above is already
// known not to be one of ours, so nothing is lost by collapsing it to printable
// ASCII, and the ASCII-only mapping is a strict SUPERSET of `isDisplayHazard`
// (pinned by test, so this policy can never drift below the shared hazard set).
//
// The defusing is SAID, not silent: silently mangling the name would leave an
// operator unable to copy the record they need to remove, which is worse than
// telling them the name is not one this WAL writes.
export function safeRecordName(name) {
  const text = String(name);
  if (EGRESS_SAFE_NAME_RE.test(text)) return text;
  const head = [...text].slice(0, 96);
  const defused = head.map((ch) => (ch >= ' ' && ch <= '~' ? ch : '?')).join('');
  // TRUNCATION NEEDS THE HASH TOO. This branch cut at 96 characters with no
  // discriminator, so two different long names sharing a 96-character prefix
  // rendered identically — and the operator is being asked to act on ONE named
  // record. `safeOperatorText` already carried the hash; this copy did not,
  // which is the same one-of-two-copies-learned-it shape that made merging the
  // hazard predicate worthwhile in the first place.
  const truncated = head.length < [...text].length;
  const digest = truncated ? `; truncated, sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}` : '';
  return `${defused} [name shown defused — it carries characters this WAL never writes${digest}]`;
}

// How much of a path is shown before it is truncated.
//
// Set against `PATH_MAX` (1024 on darwin) rather than picked round: a real path
// must render EXACTLY or the operator cannot act on it, and an earlier 200-char
// bound truncated an ordinary nested path mid-component in the first end-to-end
// run. The bound still exists because the text this defuses is not always a
// path — it is whatever an attacker who can create a directory chose.
export const OPERATOR_TEXT_MAX = 512;

// Render arbitrary operator-facing text (a directory, a checkout root, a
// requested root, a blocked path) safely.
//
// The earlier cut of this work defused record NAMES only. That was the wrong
// boundary: `dir`, `checkout_root`, the roots the operator passed, exclusions
// and blocked paths are every bit as attacker-controlled — anyone who can
// create a directory under a scanned root chooses that text.
//
// Ordinary text passes through EXACTLY, including non-ASCII letters: a path
// under `~/작업` must render as itself or the operator cannot act on it. Only
// the hazard classes are replaced, and only they.
//
// Truncation carries a stable short hash of the FULL original, so two long
// paths sharing a prefix do not render identically — an operator told to review
// "the records under <path>" must be able to tell two candidates apart.
export function safeOperatorText(text, { maxLength = OPERATOR_TEXT_MAX } = {}) {
  const raw = String(text);
  let defused = '';
  let replaced = false;
  for (const ch of raw) {
    if (isDisplayHazard(ch.codePointAt(0))) {
      defused += '?';
      replaced = true;
    } else {
      defused += ch;
    }
  }
  const notes = [];
  if (replaced) notes.push('control characters replaced');
  let shown = defused;
  if ([...defused].length > maxLength) {
    shown = [...defused].slice(0, maxLength).join('');
    const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
    notes.push(`truncated, sha256:${digest}`);
  }
  return notes.length > 0 ? `${shown} [${notes.join('; ')}]` : shown;
}
