// Argument-parser skeleton for /designer:decide (ADR-0027 §2.3 + §2.7).
//
// Library mode only — no `import.meta.url` CLI entry. Consumers
// (commands/decide.md, decide-registry.mjs CLI) call `parseArgs(argv)`
// and act on the returned flags + body.
//
// API:
//   parseArgs(argv) -> {
//     flags: { preset?: string, size?: string, weights?: string },
//     body: string,
//     errors:           string[],   // halts when non-empty
//     warnings:         string[],   // advisory only
//     weightsExplicit:  boolean,    // peer G3: avoid `weights !== {}` object-identity bug
//   }
//
// `weightsExplicit` is a top-level result field (not a `flags.*` entry) so
// callers that compare `r.flags === {}` for "no flags" semantics are not
// broken by the explicit-flag-presence signal.
//
// **API asymmetry note (peer A5 refine)**: `weightsExplicit` lives at the
// top level while `--size` / `--preset` explicit-presence is detected via
// `parsed.flags.size !== undefined` (caller-side check in
// decide-registry.mjs). This asymmetry is intentional — peer G3 required
// the weights signal to be observable WITHOUT inspecting the `weights`
// map's identity (`weights !== {}` would be an object-identity trap).
// Future maintainers SHOULD NOT (a) move `weightsExplicit` under `flags`
// (would break the `r.flags === {}` assertion at test line ~11) or
// (b) add parallel `sizeExplicit` / `presetExplicit` top-level fields
// absent a concrete consumer demand. Symmetric explicit-presence tracking,
// if ever needed, deserves an ADR amendment.
//
// Grammar (per ADR-0027 §2.2):
//   /designer:decide [--size=<tier>] [--preset=<id>] [--weights=<spec>] [--] <decision body>
//
// Flags registered:
//   --preset   passes through (the registry reader validates the id and
//              falls back gracefully per ADR-0027 §1.6 on unknown ids)
//   --size     active — tier whitelist {minor, standard, major}; implies a
//              preset per §1.5(2) and selects the ritual depth (per-option
//              output depth, comparison-table density, recommendation rigor)
//              consumed by `plugins/designer/skills/decide/SKILL.md` inside
//              the four @decide:* marker regions.
//   --weights  active (PR4) — strict comma-separated `axis-id:weight` pairs.
//              Shape: axis-id matches registry pattern `[a-z][a-z0-9-]*`;
//              weight is a non-negative finite decimal (no exponent, no
//              whitespace, no NaN/Infinity). Per-spec duplicate axis-id
//              halts. Empty spec halts. Normalization, uniform-sentinel
//              expansion, and per-axis missing-fill happen downstream
//              (`scripts/lib/decide-weights.mjs`).

const KNOWN_FLAGS = new Set(["preset", "size", "weights"]);
const SIZE_TIERS = new Set(["minor", "standard", "major"]);

// ADR-0027 §2.2 + peer G6 + PR4 RED test matrix.
//   - axis-id: registry shape [a-z][a-z0-9-]* (matches decide-registry.mjs:24)
//   - weight: non-negative finite decimal; integer or integer.fraction;
//     no exponent (peer G6 — `1e3` rejected), no NaN/Infinity (alpha
//     rejected by the digit-only branch), no negative (no leading `-`).
//   - pairs: comma-joined; no leading/trailing comma; no internal whitespace.
const WEIGHT_SPEC_RE = /^[a-z][a-z0-9-]*:(0|[1-9][0-9]*)(\.[0-9]+)?(,[a-z][a-z0-9-]*:(0|[1-9][0-9]*)(\.[0-9]+)?)*$/;

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("parseArgs expects an array of tokens");
  }

  const flags = {};
  const errors = [];
  const warnings = [];
  const repeats = {};
  // Top-level explicit-presence signal for --weights (peer G3 fix).
  // True when the user passed --weights=… (regardless of whether validation
  // accepted the spec); false when the flag was absent. Downstream
  // normalization keys off this to decide between sentinel `{}` (uniform)
  // and the parsed map.
  let weightsExplicit = false;

  let bodyStart = -1;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // §2.3(6): `--` is the hard separator — everything after is body.
    if (token === "--") {
      bodyStart = i + 1;
      break;
    }

    // §2.3(1): flags must appear before the body. The first non-flag,
    // non-`--` token starts the body and everything else (including
    // later --foo tokens) is body content.
    if (!token.startsWith("--")) {
      bodyStart = i;
      break;
    }

    // §2.3(2): `--key=value` form only — no `--key value`.
    const m = token.match(/^--([a-z][a-z0-9-]*)=(.*)$/);
    if (!m) {
      // §2.3(3): unknown / malformed flag → error + halt.
      errors.push(
        `unrecognized flag "${token}" — flags must use --key=value form; known flags: --preset, --size, --weights. Escape with -- if the body literally starts with -- text.`,
      );
      return { flags: {}, body: "", errors, warnings, weightsExplicit };
    }

    const name = m[1];
    const value = m[2];

    if (!KNOWN_FLAGS.has(name)) {
      errors.push(
        `unknown flag "--${name}=…" — known flags: --preset, --size, --weights. Escape with -- if the body literally starts with --${name}=.`,
      );
      return { flags: {}, body: "", errors, warnings, weightsExplicit };
    }

    // §2.3(5): repeat detection.
    repeats[name] = (repeats[name] ?? 0) + 1;
    if (repeats[name] > 1) {
      warnings.push(`flag --${name} appeared ${repeats[name]} times; last value wins ("${value}")`);
    }

    // Per-flag handling.
    switch (name) {
      case "preset":
        flags.preset = value;
        // Shape-only check; the registry reader does semantic validation
        // (unknown preset id → graceful-degradation fallback per §1.6).
        break;

      case "size":
        // ADR-0027 §1.5(2) preset implication + ritual depth. Both are
        // active: the registry reader resolves the preset (designer map,
        // ADR-0042 SD3 — no compact tier; designer's matrix IS the 7-axis
        // `balanced` preset):
        //   --size=minor    → preset=balanced (7-axis, terse depth)
        //   --size=standard → preset=balanced (7-axis, standard depth)
        //   --size=major    → preset=balanced (7-axis, rendered at major depth)
        // and the skill body reads `context.size` to render the matching
        // per-option / comparison-table / recommendation depth per the
        // `@decide:*` marker regions in `skills/decide/SKILL.md`.
        if (!SIZE_TIERS.has(value)) {
          errors.push(
            `--size=${value} not in {minor, standard, major}`,
          );
          return { flags: {}, body: "", errors, warnings, weightsExplicit };
        }
        flags.size = value;
        break;

      case "weights": {
        // ADR-0027 §2.2 + PR4. Strict shape validation: see WEIGHT_SPEC_RE
        // above. Per-spec duplicate axis-id rejected explicitly (regex
        // cannot express uniqueness across captures). The top-level
        // `weightsExplicit` signal is set ONLY after the spec passes
        // ALL validation gates (peer L2.4 refine — pre-validation
        // assignment leaked "user attempted --weights" as if validated).
        // Normalization, uniform-sentinel expansion, missing-axis fill,
        // unknown-axis drop, and post-parse magnitude drop (Number()
        // coercion to Infinity for unbounded-digit strings — peer M2
        // refine) all happen downstream in
        // `scripts/lib/decide-weights.mjs` via graceful library-side
        // degradation rather than parser-level halt.
        if (!WEIGHT_SPEC_RE.test(value)) {
          errors.push(
            `--weights=${value} invalid — expected comma-separated axis-id:weight pairs (non-negative finite decimal in canonical form: no leading zero, no leading or trailing dot, no exponent, no whitespace; axis-id matches [a-z][a-z0-9-]*).`,
          );
          return { flags: {}, body: "", errors, warnings, weightsExplicit };
        }
        const seenAxes = new Set();
        for (const pair of value.split(",")) {
          const axisId = pair.split(":")[0];
          if (seenAxes.has(axisId)) {
            errors.push(`--weights=${value} invalid — duplicate axis id "${axisId}" in spec.`);
            return { flags: {}, body: "", errors, warnings, weightsExplicit };
          }
          seenAxes.add(axisId);
        }
        // All validation gates passed — record explicit-presence.
        weightsExplicit = true;
        flags.weights = value;
        break;
      }

      default:
        // Unreachable — KNOWN_FLAGS gate above blocks anything else.
        break;
    }
  }

  // §2.3(1): body is everything from bodyStart onward, joined with spaces.
  let body = "";
  if (bodyStart >= 0 && bodyStart < argv.length) {
    body = argv.slice(bodyStart).join(" ");
  }

  return { flags, body, errors, warnings, weightsExplicit };
}
