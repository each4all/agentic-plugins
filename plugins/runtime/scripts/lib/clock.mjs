// lib/clock.mjs — one bound for "how far into the future may a recorded
// timestamp be before it stops being evidence", and one age function that
// honours it.
//
// WHY THIS MODULE EXISTS. ST5's adversarial audit measured the same defect in
// three age computations and the already-correct treatment in a fourth:
//
//   cutover-audit.mjs  ageHoursSince      Math.max(0, now - t)  → future reads FRESH
//   dashboard.mjs      ageMinutes         Math.max(0, now - t)  → future renders "0m ago"
//   state-readers.mjs  oldest_age_minutes Math.max(0, now - t)  → future reads NEWEST
//   context.mjs        farFuture branch   bounded, correct — and its constant was private
//
// The clamp is what makes a postdated artifact maximally fresh: `Math.max(0, …)`
// turns a negative age into zero, and zero is the freshest value there is. In
// cutover that satisfied a freshness gate indefinitely (ADR-0053 §Decision 3 —
// an unreadable fact is not a fresh one).
//
// Merging is the fix rather than patching three call sites, because a fourth
// copy is how this class survives: `context.mjs` now imports the bound from
// here instead of declaring its own, so there is one number to reason about.
//
// The bound is deliberately NOT zero. Clocks drift, artifacts are written on
// one machine and read on another, and refusing a timestamp one second ahead
// would be a freshness gate that fails on correct input.

/** Contract §4 — one uniform bound for future-skew arithmetic. */
export const FUTURE_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Milliseconds elapsed since `thenMs`, or `null` when that cannot be said.
 *
 * `null` for an unparseable timestamp AND for one beyond the skew bound: both
 * are "this artifact does not establish an age", and a caller that treats null
 * as not-fresh is fail-closed for both. Within the bound a future timestamp is
 * age 0, which is the drift case and is fine.
 */
export function elapsedMsSince(nowMs, thenMs) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(thenMs)) return null;
  if (thenMs - nowMs > FUTURE_SKEW_TOLERANCE_MS) return null;
  return Math.max(0, nowMs - thenMs);
}
