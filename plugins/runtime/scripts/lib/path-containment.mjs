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
// Deliberately ZERO-dependency (node:path only). It is imported by egress-config,
// which notify.mjs loads on every emit — the notify path must not drag a reader
// closure in to ask a five-line question. That is the same constraint
// runtime-config.mjs states for itself.
//
// NOT unified with plugins/image's private copy: that is a different plugin, and
// ADR-0010 §5 bans cross-plugin imports. Its duplication is the architecture, not
// an oversight.

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
// through a differently-cased spelling. Every current caller derives its paths from
// one source (homedir(), the resolved repo root) rather than from operator-typed
// case variants, so the spellings agree in practice. Fixing it properly means
// asking the filesystem (realpath + dev/ino), not lowercasing — which would break
// case-sensitive volumes. When a caller appears that cannot guarantee its spelling,
// that is the trigger, and this is now the ONE place to do it.
export function isUnder(child, parent) {
  if (!parent) return false;
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}
