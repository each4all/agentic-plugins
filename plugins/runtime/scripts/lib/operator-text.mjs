// lib/operator-text.mjs — make attacker-chosen text safe to show an operator.
//
// Moved verbatim out of lib/egress-intent-wal.mjs (ADR-0064 Decision 2, item 3):
// `migrate.mjs` and `migrate-workflow-storage.mjs` render their argument errors
// through `safeOperatorText` and outlive the egress intent WAL. The WAL's
// stricter record-name policy, `safeRecordName`, stays with the WAL and shares
// `discriminator` from here.
//
// Deliberately zero-syscall: `node:crypto` for the truncation hash and nothing
// else.

import { createHash } from 'node:crypto';

// The characters that can forge or corrupt an operator-facing line, as a single
// predicate every defusing policy is built on.
//
// This is the merge point. The policies are deliberately different — the WAL's
// record-name policy is an allowlist over the alphabet it writes, this module's
// passes ordinary text through — and the hazard they must ALL keep out is the
// thing that would otherwise be learned twice and fixed once.
//
//   C0 / DEL / C1   a newline plus an ANSI escape forges an instruction line in
//                   a blocker message; this is the injection the modern WAL scan
//                   already fences and the legacy branch had left open.
//   bidi overrides  U+202E and friends reorder a rendered path, so a name can be
//                   displayed as something the operator did not agree to remove.
//   zero-width      invisible characters make two distinct paths render alike.
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

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
    || codePoint === 0x2028 || codePoint === 0x2029  // LINE / PARAGRAPH SEPARATOR
    // …every character Unicode itself calls DEFAULT-IGNORABLE: it renders as
    // nothing, so two distinct names look identical to the operator being asked
    // to act on one of them. This replaces a hand-written list that review had
    // already grown twice and a third round still found holes in — a list a
    // reviewer must extend is not a predicate; the property is, and Unicode
    // maintains it.
    || DEFAULT_IGNORABLE.test(String.fromCodePoint(codePoint))
    // …AND the interlinear-annotation set, which the property does NOT contain
    // (measured: `\p{Default_Ignorable_Code_Point}` is false for U+FFF9-FFFB).
    // Swapping the list for the property alone would have SHRUNK coverage — the
    // general rule did not subsume the specific one, so both stay and the
    // exception says why.
    || (codePoint >= 0xfff9 && codePoint <= 0xfffb);
}

// A short, stable discriminator for the ORIGINAL text.
//
// This is the whole reason defusing can be safe. The moment a character is
// replaced or a tail is cut, the rendered string no longer identifies one
// object: `é.json` and `è.json` both rendered `?.json`, and two paths differing
// only in a control byte both rendered the same — while the guidance asks the
// operator to act on ONE named record (reproduced, cross-host review). Attaching
// the hash whenever ANYTHING was altered restores the property the alteration
// destroyed.
export function discriminator(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
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
    notes.push('truncated');
  }
  // The hash rides on ANY alteration, not only truncation — see `discriminator`.
  // Without it, two locations differing only in a replaced byte render alike and
  // the operator cannot tell which one the guidance is about.
  if (notes.length > 0) notes.push(`sha256:${discriminator(raw)}`);
  return notes.length > 0 ? `${shown} [${notes.join('; ')}]` : shown;
}
