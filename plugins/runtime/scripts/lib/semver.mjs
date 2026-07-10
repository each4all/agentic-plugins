// Numeric SemVer comparison, runtime-internal.
//
// Moved verbatim out of doctor.mjs so `lib/peer-execution-context.mjs` can use it
// without importing doctor.mjs (which would form a cycle). doctor.mjs and
// settings.mjs both re-import it here rather than keeping private copies.
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.

export function semverCompare(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
