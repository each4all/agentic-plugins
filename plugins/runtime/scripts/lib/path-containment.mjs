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

import { realpath as defaultRealpath, stat as defaultStat } from 'node:fs/promises';
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

// Resolve a package-relative asset and prove it did not leave the package.
//
// The third question this module answers, and the one `isUnder` alone cannot:
// runtime resolves several assets by joining a CONSTANT relative path onto a
// package root — the host-parity baseline, `data/plugin-set.json`,
// `data/schemas/**`. A constant relative path cannot escape lexically, so the
// old readers did no containment check at all. Measured: it escapes anyway,
// through the filesystem rather than through the string. A symlink at the leaf,
// a symlinked `docs/`, or a symlinked manifest each made a file OUTSIDE the
// package the authority for a runtime verdict, and all three resolved to
// `status: resolved` with no trace in provenance.
//
// So containment must be asked CANONICALLY, of both sides:
//
//   - The root is realpath'd too, not just the leaf. A symlinked package root
//     is the normal shape of a development checkout and of several install
//     layouts; canonicalizing only the leaf would refuse those. That control
//     case is pinned in the tests precisely because it is the over-correction
//     this function invites.
//   - `isUnder` gets canonical inputs. It already appends `sep` before the
//     prefix test, so `/x/runtime-evil` is not inside `/x/runtime` — measured,
//     because a bare `startsWith` says it is.
//
// The read then targets `canonicalPath`, not the caller's spelling. That is not
// cosmetic: re-walking the original path would re-traverse the very symlinks
// this function just resolved, so the check would guard a different read than
// the one that happens.
//
// TWO LIMITS, stated rather than papered over:
//
//   - TOCTOU. Between the realpath and the caller's read, the canonical path
//     itself can be replaced. Reading the canonical path narrows the window to
//     that single node — the intermediate symlinks are already collapsed — but
//     does not close it. Closing it needs an fd-anchored read (`openat` +
//     `O_NOFOLLOW` per component), which Node does not expose portably. The
//     threat this is proportionate to is a mis-packaged or locally-tampered
//     install, not an attacker racing a doctor run.
//   - HARDLINKS are invisible here. A hardlink inside the package to a file
//     outside it has no symlink to resolve and is genuinely inside the tree by
//     every filesystem answer available. Containment is a path predicate; it
//     cannot see a second name for the same inode.
//
// Returns one of:
//   { status: 'ok',         path, canonicalPath }
//   { status: 'missing',    path, code }   nothing is there — includes a broken symlink
//   { status: 'unreadable', path, code }   present, but the path could not be walked
//   { status: 'escaped',    path, canonicalPath }
//
// `missing` wins over `escaped` when the leaf does not exist: nothing was read,
// so there is no escape to report, only an incomplete package.
export async function resolveContained(root, relativePath, { realpath = defaultRealpath } = {}) {
  const path = resolve(root, relativePath);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { status: 'missing', path, code: 'ENOENT' }
      : { status: 'unreadable', path, code: err?.code ?? 'error' };
  }
  let canonicalPath;
  try {
    canonicalPath = await realpath(path);
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { status: 'missing', path, code: 'ENOENT' }
      : { status: 'unreadable', path, code: err?.code ?? 'error' };
  }
  if (!isUnder(canonicalPath, canonicalRoot)) {
    return { status: 'escaped', path, canonicalPath };
  }
  return { status: 'ok', path, canonicalPath };
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
