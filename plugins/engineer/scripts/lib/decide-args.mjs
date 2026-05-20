// Argument-parser skeleton for /engineer:decide (ADR-0027 §2.3 + §2.7).
//
// Library mode only — no `import.meta.url` CLI entry. Consumers
// (commands/decide.md, decide-registry.mjs CLI) call `parseArgs(argv)`
// and act on the returned flags + body.
//
// API:
//   parseArgs(argv) -> {
//     flags: { preset?: string, size?: string, weights?: string },
//     body: string,
//     errors:   string[],   // halts when non-empty
//     warnings: string[],   // advisory only
//   }
//
// Grammar (per ADR-0027 §2.2):
//   /engineer:decide [--size=<tier>] [--preset=<id>] [--weights=<spec>] [--] <decision body>
//
// Flags registered:
//   --preset   passes through (the registry reader validates the id and
//              falls back gracefully per ADR-0027 §1.6 on unknown ids)
//   --size     active — tier whitelist {minor, standard, major}; implies a
//              preset per §1.5(2) and selects the ritual depth (per-option
//              output depth, comparison-table density, recommendation rigor)
//              consumed by `plugins/engineer/skills/decide/SKILL.md` inside
//              the four @decide:* marker regions.
//   --weights  stub — accepts the value but emits a warning that weighting
//              + sensitivity-flip semantics ship with PR4.
//
// PR4 will replace the --weights stub.

const KNOWN_FLAGS = new Set(["preset", "size", "weights"]);
const SIZE_TIERS = new Set(["minor", "standard", "major"]);

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("parseArgs expects an array of tokens");
  }

  const flags = {};
  const errors = [];
  const warnings = [];
  const repeats = {};

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
      return { flags: {}, body: "", errors, warnings };
    }

    const name = m[1];
    const value = m[2];

    if (!KNOWN_FLAGS.has(name)) {
      errors.push(
        `unknown flag "--${name}=…" — known flags: --preset, --size, --weights. Escape with -- if the body literally starts with --${name}=.`,
      );
      return { flags: {}, body: "", errors, warnings };
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
        // active: the registry reader resolves the preset
        //   --size=minor    → preset=compact (4-axis, entry-routing-guarantee)
        //   --size=standard → preset=default (5-axis)
        //   --size=major    → preset=nine-axis (9-axis)
        // and the skill body reads `context.size` to render the matching
        // per-option / comparison-table / recommendation depth per the
        // `@decide:*` marker regions in `skills/decide/SKILL.md`.
        if (!SIZE_TIERS.has(value)) {
          errors.push(
            `--size=${value} not in {minor, standard, major}`,
          );
          return { flags: {}, body: "", errors, warnings };
        }
        flags.size = value;
        break;

      case "weights":
        // PR2 stub per peer P-16. Weight grammar / normalization /
        // sensitivity-flip semantics belong to PR4; PR2 only reserves
        // the slot.
        flags.weights = value;
        warnings.push("--weights accepted; weighting + sensitivity behavior deferred to PR4");
        break;

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

  return { flags, body, errors, warnings };
}
