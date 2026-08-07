// plugins/runtime/scripts/lib/path-containment.mjs
//
// The ONE path-containment predicate for runtime. Two security gates ask the same
// question — "is this path inside that tree?" — and had grown two identical private
// answers: the egress config's inside-repo refusal (ADR-0041 §3) and the machine-
// bootstrap home's canonical containment (machine-bootstrap-contract.md §10.2). A
// second copy of a security predicate is a mirror waiting to happen: the day one
// copy learns something (case-insensitive filesystems are the obvious candidate —
// see below), the other keeps the old answer and keeps shipping.
//
// `isUnder` is deliberately ZERO-dependency (node:path only). It is imported by
// egress-config, which notify.mjs loads on every emit — the notify path must not
// drag a reader closure in to ask a five-line question. That is the same
// constraint runtime-config.mjs states for itself.
//
// `sameDirectory` below cannot honor that: identity is a question only the
// filesystem can answer. Measured before adding the import rather than assumed:
// egress-config.mjs already imports `node:fs` at its line 55, and it is the
// module that pulls this one onto the notify path, so `node:fs/promises` here
// adds no capability that path was not already loading. The constraint the
// original note was protecting — no reader closures, no heavy modules — still
// holds, and `isUnder` itself stays syscall-free.
//
// NOT unified with plugins/image's private copy: that is a different plugin, and
// ADR-0010 §5 bans cross-plugin imports. Its duplication is the architecture, not
// an oversight.

import { stat as defaultStat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Is `child` the same path as `parent`, or inside it?
//
// Callers pass CANONICAL paths when the answer must survive symlinks — this
// function does not realpath, because resolving inside a predicate would hide
// whether the caller had already bound its decision to a real inode, and a
// fail-closed gate needs to know that. `resolve()` here only normalizes `.`/`..`
// and relative spellings.
//
// KNOWN LIMIT, stated rather than papered over: the comparison is
// case-SENSITIVE. On a case-insensitive filesystem (macOS default, Windows)
// `/Users/x/repo` and `/users/x/repo` are the same directory but compare unequal,
// so a containment REFUSAL could be missed by a caller that reached the path
// through a differently-cased spelling. Every current caller of THIS predicate
// derives its paths from one source (homedir(), the resolved repo root) rather
// than from operator-typed case variants, so the spellings agree in practice.
//
// The trigger that note reserved has since fired for a different question —
// see `sameDirectory` below, which is where a caller that cannot guarantee its
// spelling now goes. `isUnder` stays lexical on purpose: it is on the notify
// emit path and must answer without syscalls.
export function isUnder(child, parent) {
  if (!parent) return false;
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

// Are these two paths the SAME directory? Asks the filesystem, because spelling
// cannot answer it.
//
// This exists because `doctor.mjs` decided "is the repo-scoped legacy egress WAL
// a different directory from the machine-global one?" by comparing resolved
// path strings, and got it wrong in the one direction that harms: when the two
// spellings reach the same directory, the LIVE fence was re-read as clearable
// legacy state and the operator was told to delete it. Freeing that fence is the
// duplicate-send the whole WAL exists to prevent.
//
// MEASURED, because the obvious fix is also wrong: `realpath` does NOT fold case
// on macOS. Given a real `RealDir`, `realpathSync('.../realdir')` returns
// `.../realdir` — a different string — while `stat` on both returns one dev/ino.
// So dev/ino is doing the work here and realpath would have shipped the same bug
// with more ceremony. dev/ino also subsumes symlinks and trailing separators,
// which is why neither is special-cased.
//
// Not the inode-identity hazard from the lock work: that one compared a REMEMBERED
// identity against a later file, where a deletion could hand the number to a new
// inode in between. Both directories here are live at the moment of the single
// comparison, so there is no window for reuse to open.
//
// THREE outcomes, not a boolean. A filesystem that refuses to answer (EACCES,
// EIO) must not be collapsed into "different" — that is exactly the direction
// that re-opens the resend path — nor into "same", which would silently drop a
// legitimate legacy fence. The caller is told the question is unanswered and
// decides; every current caller blocks.
//
//   { same: true }               one directory
//   { same: false }              two directories, or one of them does not exist
//   { unknown: true, reason }    the filesystem would not say
// dev/ino ABOVE 2^53 collapse when they arrive as JavaScript Numbers, and the
// direction that harms is two DISTINCT directories comparing equal — a real
// legacy fence read as the live one and skipped. Reproduced: inode 2^53 and
// 2^53+1 compared `same: true`.
//
// The identity stat therefore asks for BigInt. `identityKey` accepts a
// non-BigInt result only while it is exactly representable, and returns null
// otherwise so the caller gets `unknown` rather than a guess. The discovery
// scanner learned this first and the fix did not reach this predicate — which is
// the same one-of-two-siblings shape everything else here has been bitten by.
function identityKey(st) {
  const { dev, ino } = st;
  if (typeof dev === 'bigint' && typeof ino === 'bigint') return `${dev}:${ino}`;
  if (Number.isSafeInteger(dev) && Number.isSafeInteger(ino)) return `${dev}:${ino}`;
  return null;
}

export async function sameDirectory(a, b, { stat = defaultStat } = {}) {
  if (!a || !b) return { same: false };
  // Identical spellings need no syscall, and this keeps the common case free.
  if (resolve(a) === resolve(b)) return { same: true };
  const seen = [];
  for (const path of [a, b]) {
    try {
      seen.push(await stat(path, { bigint: true }));
    } catch (err) {
      // ENOENT is a definite answer: a directory that is not there is not the
      // directory we are asking about. Anything else means we could not look.
      if (err?.code === 'ENOENT') return { same: false };
      // `reason` embeds the RAW path, which is attacker-controlled wherever the
      // caller renders it to an operator. `code` is the same evidence without
      // that hazard, so callers that print can use it and callers that log can
      // still have the path. `doctor.mjs` printed `reason` verbatim and forged
      // operator lines were reachable through it (cross-host review).
      return {
        unknown: true,
        code: err?.code ?? 'error',
        reason: `${path} could not be inspected (${err?.code ?? 'error'})`,
      };
    }
  }
  const [ka, kb] = seen.map(identityKey);
  if (ka === null || kb === null) {
    return {
      unknown: true,
      code: 'unrepresentable-identity',
      reason: 'the filesystem reported a directory identity this runtime cannot compare exactly',
    };
  }
  return { same: ka === kb };
}
