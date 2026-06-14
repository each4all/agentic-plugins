// Weights normalization for /founder:decide (ADR-0027 §5.6 + PR4 Task 2).
//
// Library mode only — pure function, no I/O. Consumers (decide-registry.mjs
// resolvePreset) pass the parsed `--weights` spec + resolved axes; this
// module returns a per-axis numeric map keyed by axis-id in document order.
//
// API:
//   normalizeWeights({ rawSpec, axes, weightsExplicit }) -> {
//     weights:     Record<string, number>,   // {} = uniform sentinel
//     diagnostics: string[],                 // unknown-axis drops, etc.
//   }
//
// Sentinel semantics (ADR-0027 §5.6 + peer G3):
//   `weights === {}` (empty Record) means "no --weights flag passed";
//   downstream score aggregation treats this as uniform 1.0 weights.
//   Empty `{}` is the only ambiguity-free signal of "user didn't ask
//   for weighting" — we never emit `{market-attractiveness: 1, ...}` to mean
//   uniform because that would look identical to an explicit
//   `--weights=market-attractiveness:1`.
//
// Fill rule (peer G6):
//   When `weightsExplicit === true`, every axis in `axes[]` appears in the
//   output map. Axes mentioned in `rawSpec` get the parsed value; unmentioned
//   axes get `1.0`. Unknown axis-ids (in `rawSpec` but not in `axes[]`) are
//   dropped with one diagnostic per occurrence.
//
// Fallback-axis-aware (peer G5):
//   The normalizer is path-agnostic — caller passes whichever axes were
//   resolved (registry preset OR DEFAULT_FALLBACK). Both paths produce
//   the same shape of output.

function parseSpec(rawSpec) {
  // Caller (parser) already validated shape via WEIGHT_SPEC_RE; this is
  // a pure split. Defensive against undefined.
  //
  // Peer M2 refine: WEIGHT_SPEC_RE accepts arbitrarily long digit strings
  // because `[1-9][0-9]*` is unbounded. `Number()` on a 400+ digit decimal
  // returns `Infinity`, which would poison `aggregateOption`'s Σ math
  // (Infinity × anything = Infinity, breaking the comparison ladder).
  // The shape check passes but the magnitude check belongs here, where
  // we have the coerced Number value. Non-finite weights are returned
  // as a sentinel `null` and surfaced as a diagnostic by `normalizeWeights`
  // below — they do NOT halt parsing (parser already accepted the shape),
  // they degrade gracefully like an unknown axis.
  const out = Object.create(null);
  if (!rawSpec) return out;
  for (const pair of rawSpec.split(",")) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx < 0) continue; // unreachable post-validation
    const axisId = pair.slice(0, colonIdx);
    const weightStr = pair.slice(colonIdx + 1);
    const n = Number(weightStr);
    out[axisId] = Number.isFinite(n) ? n : null; // null = "magnitude rejected post-parse"
  }
  return out;
}

export function normalizeWeights({ rawSpec, axes, weightsExplicit } = {}) {
  // Uniform sentinel: flag absent → empty map. Ignore rawSpec when the
  // parser did not see an explicit --weights= flag (peer G3 defensive).
  if (!weightsExplicit) {
    // PR4 refine C2 — frozen sentinel (caller-side mutation prevention)
    return { weights: Object.freeze({}), diagnostics: [] };
  }

  const diagnostics = [];
  const knownIds = new Set((axes ?? []).map((a) => a.id));
  const specMap = parseSpec(rawSpec);

  // Drop unknown axis-ids; one diagnostic per drop.
  for (const id of Object.keys(specMap)) {
    if (!knownIds.has(id)) {
      diagnostics.push(`weight axis-id "${id}" not in resolved preset — dropped`);
      delete specMap[id];
      continue;
    }
    // Peer M2 refine: parseSpec marks magnitude-rejected weights as null
    // (Number(huge-decimal) === Infinity). Drop them with a distinct
    // diagnostic — the axis is known but the weight value is unusable.
    if (specMap[id] === null) {
      diagnostics.push(`weight for axis "${id}" is not a finite number (likely overflow) — dropped, axis falls back to 1.0`);
      delete specMap[id];
    }
  }

  // Empty axes edge: nothing to fill. Unknown drops above already recorded
  // their own diagnostics; do not add another generic one.
  if (!axes || axes.length === 0) {
    return { weights: Object.freeze({}), diagnostics };
  }

  // Fill per axis in document order. Object insertion order preserves the
  // axes[] order in V8 / SpiderMonkey for string keys.
  const weights = {};
  for (const axis of axes) {
    weights[axis.id] = Object.hasOwn(specMap, axis.id) ? specMap[axis.id] : 1.0;
  }
  // PR4 refine C2 — freeze canonical output. Caller (decide-registry.mjs)
  // hands the map straight into the ResolvedDecisionContext; downstream
  // (decide-scores, decide-sensitivity, SKILL.md JSON consumers) treat it
  // as read-only. Freeze brings this in line with DEFAULT_FALLBACK + axes
  // freeze granularity (decide-registry.mjs:42-50).
  return { weights: Object.freeze(weights), diagnostics };
}
