// plugins/runtime/scripts/lib/egress-intent-wal.mjs
//
// The shared, read-only primitives of the egress intent WAL: where its
// directory lives, and how a record name drawn from it is made safe to show an
// operator. Paths and other free text go through lib/operator-text.mjs
// `safeOperatorText`, which moved there because its migrate consumers outlive
// the WAL (ADR-0064 Decision 2, item 3).
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
// the operator-text discriminator for the truncation hash. Nothing here touches
// the filesystem — identity questions belong to `path-containment.mjs`
// `sameDirectory`, which asks the filesystem because spelling cannot answer
// them.

import { join } from 'node:path';

import { discriminator } from './operator-text.mjs';

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

// The alphabet this WAL actually writes: hex fingerprints, hex owner tokens,
// and the dots that join them. A name outside it is not one of ours.
//
// A SHAPE test is not a MEMBERSHIP test — the distinction is why this exists as
// an allowlist and not as a "looks reasonable" regex.
const EGRESS_SAFE_NAME_RE = /^[0-9A-Za-z._-]{1,128}$/;

// Render a WAL record name safely.
//
// STRICTER than `safeOperatorText` (lib/operator-text.mjs) on purpose, and the
// strictness is sound rather than duplicated: a name that fails the allowlist
// above is already known not to be one of ours, so nothing is lost by
// collapsing it to printable ASCII, and the ASCII-only mapping is a strict
// SUPERSET of `isDisplayHazard` (pinned by test, so this policy can never drift
// below the shared hazard set).
//
// The defusing is SAID, not silent: silently mangling the name would leave an
// operator unable to copy the record they need to remove, which is worse than
// telling them the name is not one this WAL writes.
export function safeRecordName(name) {
  const text = String(name);
  if (EGRESS_SAFE_NAME_RE.test(text)) return text;
  const all = [...text];
  const head = all.slice(0, 96);
  const defused = head.map((ch) => (ch >= ' ' && ch <= '~' ? ch : '?')).join('');
  const notes = ['name shown defused — it carries characters this WAL never writes'];
  if (head.length < all.length) notes.push('truncated');
  // Unconditional: reaching this branch AT ALL means the rendering is lossy.
  notes.push(`sha256:${discriminator(text)}`);
  return `${defused} [${notes.join('; ')}]`;
}
