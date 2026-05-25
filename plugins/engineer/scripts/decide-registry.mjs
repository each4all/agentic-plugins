#!/usr/bin/env node
// Registry reader for engineer:decide — ADR-0027 §1 + §5.6.
//
// Public API:
//   loadRegistry({ path?: string }) -> { registry: object|null, diagnostics: string[], fallbackTriggered: boolean }
//   resolvePreset({
//     path?: string,
//     presetId?: string,
//     sizeExplicit?: boolean,
//     sizeValue?: "minor" | "standard" | "major",
//     profileOverride?: string,        // §1.5(3) reserved slot
//     body?: string,                   // threaded into context.body per §5.6
//     weights?: string,                // PR4 — raw --weights=<spec> string
//     weightsExplicit?: boolean,       // PR4 — top-level parser explicit-presence signal
//   }) -> { context: ResolvedDecisionContext, diagnostics: string[], fallbackTriggered: boolean }
//
// CLI:
//   node decide-registry.mjs resolve
//     [--preset=<id>] [--size=<tier>] [--weights=<spec>] [-- <decision body>]
//     stdout — JSON ResolvedDecisionContext (§5.6 + PR4 amendment fields)
//     stderr — fallback diagnostics + chosen-source diagnostic (one line each)
//     exit 0 — registry resolved (with or without graceful-degradation diagnostics)
//     exit 2 — argument-parser errors (unknown flag, invalid --size, malformed
//              --weights) per ADR-0027 §2.3(3-4)

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { parse as parseYaml, YamlParseError } from "./lib/yaml-mini.mjs";
import { normalizeWeights } from "./lib/decide-weights.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(HERE, "..", "skills", "decide", "references", "decision-axes.yml");

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VALID_ROLES = new Set(["decisive", "supporting"]);

// In-code fallback — mirrors the `default` preset in decision-axes.yml.
// This is the LAST-RESORT preset when the registry file is missing,
// malformed, or rejected by any §1.6 failure mode.
const DEFAULT_FALLBACK = Object.freeze({
  preset_id: "default",
  axes: Object.freeze([
    freeze({ id: "essence",       labels: freeze({ en: "Essence",       ko: "본질" }), question: "Does this solve the fundamental problem, or just a symptom?", role: "decisive" }),
    freeze({ id: "foundation",    labels: freeze({ en: "Foundation",    ko: "근본" }), question: "Is this architecturally sound as a long-term base?", role: "decisive" }),
    freeze({ id: "standards",     labels: freeze({ en: "Standards",     ko: "표준" }), question: "Does it align with industry standards and specifications?", role: "supporting" }),
    freeze({ id: "best-practice", labels: freeze({ en: "Best Practice", ko: "정석" }), question: "Is it the canonical approach recommended by authoritative sources?", role: "supporting" }),
    freeze({ id: "practical-fit", labels: freeze({ en: "Practical Fit", ko: "실용성" }), question: "Is it the best choice for this project's specific constraints?", role: "supporting" }),
  ]),
});

function freeze(obj) { return Object.freeze(obj); }

// Validate a single preset entry's shape per §1.6 schema invariants.
// Returns null on success, or a diagnostic string describing the first
// invariant violation. Does NOT throw — the reader is graceful-degradation.
function validatePreset(presetId, preset, presetDiagnostics) {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    return `preset "${presetId}": entry is not a map (schema-invalid)`;
  }
  if (!Array.isArray(preset.axes)) {
    return `preset "${presetId}": axes is not a list (schema-invalid)`;
  }
  if (preset.axes.length === 0) {
    return `preset "${presetId}": axes list is empty`;
  }
  const seenAxisIds = new Set();
  let decisiveCount = 0;
  for (let i = 0; i < preset.axes.length; i++) {
    const axis = preset.axes[i];
    if (!axis || typeof axis !== "object" || Array.isArray(axis)) {
      return `preset "${presetId}" axis[${i}]: not a map`;
    }
    if (typeof axis.id !== "string" || !ID_RE.test(axis.id)) {
      return `preset "${presetId}" axis[${i}]: invalid axis-id shape (expected [a-z][a-z0-9-]*)`;
    }
    if (seenAxisIds.has(axis.id)) {
      return `preset "${presetId}": duplicate axis id "${axis.id}"`;
    }
    seenAxisIds.add(axis.id);
    if (!axis.labels || typeof axis.labels !== "object" || typeof axis.labels.en !== "string") {
      return `preset "${presetId}" axis "${axis.id}": missing labels.en`;
    }
    if (typeof axis.question !== "string" || axis.question.length === 0) {
      return `preset "${presetId}" axis "${axis.id}": missing question`;
    }
    if (typeof axis.role !== "string" || !VALID_ROLES.has(axis.role)) {
      return `preset "${presetId}" axis "${axis.id}": invalid role "${axis.role}" (expected decisive | supporting)`;
    }
    if (axis.role === "decisive") decisiveCount++;
  }
  if (decisiveCount < 2) {
    return `preset "${presetId}": decisive-axis count is ${decisiveCount}, must be >= 2 (§1.3 invariant)`;
  }
  return null;
}

// Load + validate the YAML registry from `path` (defaults to the
// engineer-local registry). The reader applies the §1.6 failure-mode
// matrix and returns a structured result so callers (and tests) can
// inspect which diagnostics fired.
export function loadRegistry({ path } = {}) {
  const target = path ?? DEFAULT_PATH;
  const diagnostics = [];

  let text;
  try {
    text = readFileSync(target, "utf8");
  } catch (err) {
    // Row 1 (file missing) + row 2 (permission / IO) collapse to fallback.
    if (err.code === "ENOENT") {
      diagnostics.push(`registry file missing at ${target}; falling back to in-code default preset`);
    } else {
      diagnostics.push(`registry file read failed (${err.code ?? err.name}): ${target}; falling back`);
    }
    return { registry: null, diagnostics, fallbackTriggered: true };
  }

  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    // Row 3 (YAML parse error). Includes our row 16 (duplicate preset key)
    // because yaml-mini errors on duplicate map keys at the same level.
    const reason = err instanceof YamlParseError ? err.message : String(err);
    diagnostics.push(`YAML parse failed: ${reason}; falling back`);
    return { registry: null, diagnostics, fallbackTriggered: true };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push("registry top-level is not a map; falling back");
    return { registry: null, diagnostics, fallbackTriggered: true };
  }

  // Row 18 (per peer P-18): missing / unsupported schema value.
  if (parsed.schema !== "1.0") {
    diagnostics.push(`registry schema is "${parsed.schema}" (expected "1.0"); falling back`);
    return { registry: null, diagnostics, fallbackTriggered: true };
  }

  // Row 4: unknown top-level key (anything other than schema | presets).
  const KNOWN_TOP_LEVEL = new Set(["schema", "presets"]);
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      diagnostics.push(`registry top-level has unknown key "${key}"; falling back`);
      return { registry: null, diagnostics, fallbackTriggered: true };
    }
  }

  // Row 5: missing presets.
  if (!Object.prototype.hasOwnProperty.call(parsed, "presets")) {
    diagnostics.push("registry has no presets map; falling back");
    return { registry: null, diagnostics, fallbackTriggered: true };
  }
  const presetsRaw = parsed.presets;
  if (!presetsRaw || typeof presetsRaw !== "object" || Array.isArray(presetsRaw)) {
    diagnostics.push("registry presets is not a map; falling back");
    return { registry: null, diagnostics, fallbackTriggered: true };
  }
  // Row 6: empty presets.
  const presetIds = Object.keys(presetsRaw);
  if (presetIds.length === 0) {
    diagnostics.push("registry has no presets; falling back");
    return { registry: null, diagnostics, fallbackTriggered: true };
  }

  // Per-preset validation. Row 12 (invalid preset-id shape) rejects ONE
  // preset; rows 7-11, 14, 15, 17 reject ONE preset and let others stay
  // usable.
  const presets = {};
  for (const id of presetIds) {
    if (!ID_RE.test(id)) {
      diagnostics.push(`preset-id "${id}" has invalid shape; preset skipped`);
      continue;
    }
    const reason = validatePreset(id, presetsRaw[id], diagnostics);
    if (reason) {
      diagnostics.push(`${reason}; preset skipped`);
      continue;
    }
    // Freeze axes + labels per peer P-13: PR3/PR4 must not mutate axes
    // accidentally. The wrapping object's `size`/`size_explicit`/`weights`
    // slots remain writable (those are PR3/PR4-owned).
    const axes = Object.freeze(
      presetsRaw[id].axes.map((a) =>
        freeze({
          id: a.id,
          labels: freeze({ en: a.labels.en, ko: a.labels.ko ?? null }),
          question: a.question,
          role: a.role,
        }),
      ),
    );
    presets[id] = freeze({ id, description: presetsRaw[id].description ?? "", axes });
  }

  if (Object.keys(presets).length === 0) {
    diagnostics.push("no preset survived validation; falling back");
    return { registry: null, diagnostics, fallbackTriggered: true };
  }

  return {
    registry: freeze({ schema: "1.0", presets: freeze(presets) }),
    diagnostics,
    fallbackTriggered: false,
  };
}

// Resolve a preset per §1.5 precedence ladder and return the
// ResolvedDecisionContext object per §5.6.
//
// Precedence:
//   1. presetId (explicit `--preset=<id>`)
//   2. sizeExplicit && sizeValue (explicit `--size=<tier>`) → implied preset
//   3. profileOverride (reserved; no consumers ship in PR2)
//   4. default → `default` preset
//
// PR4 (Task 3): `weights` (raw spec string from --weights=<spec>) +
// `weightsExplicit` (top-level parser signal) are normalized over the
// resolved axes via `normalizeWeights(...)`. Empty-flag path → `{}` sentinel
// (uniform). Fallback paths (registry rejected, unknown preset, size-implied
// missing) all share the same normalization step — peer G5 fallback-aware
// invariant.
export function resolvePreset({
  path,
  presetId,
  sizeExplicit = false,
  sizeValue,
  profileOverride,
  body = "",
  // PR4 refine M5 — internal alias is now `rawSpec`, matching the
  // downstream `normalizeWeights({rawSpec, ...})` contract. The public
  // caller-side name remains `weights` (the raw --weights=<spec> string).
  weights: rawSpec,
  weightsExplicit = false,
} = {}) {
  const { registry, diagnostics, fallbackTriggered } = loadRegistry({ path });
  const diags = diagnostics.slice();
  let chosen = null;
  let chosenSource = "default-fallback";
  let fallback = fallbackTriggered;

  // Local helper: own-property preset lookup. Defends against
  // prototype-chain shadows like `--preset=constructor` returning
  // `Object.prototype.constructor` from a plain `{}` lookup.
  const ownPreset = (id) => (typeof id === "string" && Object.hasOwn(registry.presets, id) ? registry.presets[id] : null);

  if (registry) {
    // §1.5(1): explicit --preset wins.
    if (presetId) {
      const lookup = ownPreset(presetId);
      if (lookup) {
        chosen = lookup;
        chosenSource = "explicit-preset";
      } else {
        // Row 13: unknown preset id.
        diags.push(`unknown preset id "${presetId}"; available: ${Object.keys(registry.presets).join(", ")}; falling back to default`);
        fallback = true;
        chosen = ownPreset("default");
        chosenSource = "fallback-after-unknown-preset";
      }
    }

    // §1.5(2): explicit --size implies preset, ONLY when explicit.
    if (!chosen && sizeExplicit && sizeValue) {
      const map = { minor: "compact", standard: "default", major: "nine-axis" };
      const implied = map[sizeValue];
      const impliedPreset = implied ? ownPreset(implied) : null;
      if (impliedPreset) {
        chosen = impliedPreset;
        chosenSource = `size-implied:${sizeValue}->${implied}`;
      } else if (implied) {
        diags.push(`--size=${sizeValue} implies preset "${implied}" but registry has none; falling back to default`);
        fallback = true;
        chosen = ownPreset("default");
        chosenSource = "fallback-after-size-implied-missing";
      }
    }

    // §1.5(3): persona/profile override slot — reserved; never satisfied
    // in PR2. Recorded as a diagnostic for future visibility.
    if (!chosen && profileOverride) {
      diags.push(`profile override "${profileOverride}" provided but no consumer registered in PR2; ignored`);
    }

    // §1.5(4): default fallback.
    if (!chosen) {
      chosen = ownPreset("default");
      chosenSource = "default";
    }

    if (!chosen) {
      diags.push("registry has no usable default preset; falling back to in-code default");
      fallback = true;
    }
  }

  // Fallback path (registry null or no usable preset).
  const resolved = chosen ?? DEFAULT_FALLBACK;
  if (chosen === null) fallback = true;

  // PR4 (Task 3): normalize weights over the resolved (or fallback) axes.
  // The normalizer is path-agnostic — same shape for happy preset, unknown
  // preset fallback, malformed-registry fallback, etc. Diagnostics from
  // weight normalization (unknown axis-id drops, empty-axes edge) merge
  // into the existing diags list.
  const weightsResult = normalizeWeights({
    rawSpec,
    axes: resolved.axes,
    weightsExplicit,
  });
  for (const d of weightsResult.diagnostics) diags.push(d);

  // Construct the ResolvedDecisionContext (§5.6 + PR4 amendment).
  //
  // PR2 populated body / preset_id / axes / resolved_at; PR3 populates
  // size / size_explicit from the parser. PR4 populates weights via
  // normalizeWeights above AND adds `weights_explicit` (snake_case to
  // match `size_explicit`) so the on-wire JSON context carries the
  // explicit-presence signal — the SKILL.md gate at
  // `@decide:weighting-sensitivity-output` consumes this directly
  // (peer M1: previously `weightsExplicit` was JS-API-only, leaving
  // the LLM body consumer to infer "explicit" from `weights !== {}`,
  // the precise object-identity trap peer G3 had warded off).
  const context = {
    body: body ?? "",
    preset_id: resolved.preset_id ?? resolved.id ?? "default",
    axes: resolved.axes,                  // frozen per peer P-13
    size: sizeExplicit && sizeValue ? sizeValue : "standard",
    size_explicit: !!sizeExplicit,
    weights: weightsResult.weights,       // PR4 normalized (empty {} = uniform sentinel)
    weights_explicit: !!weightsExplicit,  // PR4 (M1 refine): LLM-observable explicit-presence signal
    resolved_at: new Date().toISOString(),
  };

  // PR4 refine M4 — the previously-undocumented `_chosenSource` field
  // leaked into the §5.6 on-wire schema (Co3 finding: ADR §5.6 lists
  // exactly the eight canonical fields above; `_chosenSource` was not
  // one of them, and the leading underscore signals "private" without
  // any actual JSON-output privacy boundary). The field is dropped.
  // Fallback events are already reported through the structured
  // diagnostics array (unknown-preset, size-implied-missing, etc.), so
  // no diagnostic visibility is lost. PR5 may re-introduce a structured
  // chosen-source surface through a §5.6 amendment if needed.
  // `chosenSource` is referenced here so the unused-variable linter
  // does not warn (the branches above assign it for future use).
  void chosenSource;

  return { context, diagnostics: diags, fallbackTriggered: fallback };
}

// CLI mode. Exits:
//   0 — registry resolved (with or without graceful-degradation diagnostics)
//   2 — argument-parser errors (unknown flag, invalid --size tier, etc.) per ADR-0027 §2.3(3-4)
//
// stdout = JSON ResolvedDecisionContext. stderr = parser warnings/errors
// + registry fallback diagnostics. Body tokens (anything after `--`) are
// threaded into `context.body` per §5.6.
async function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== "resolve") {
    process.stderr.write(
      "decide-registry.mjs — engineer:decide registry reader\n" +
      "usage: node decide-registry.mjs resolve [--preset=<id>] [--size=<tier>] [--weights=<spec>] [-- <decision body>]\n",
    );
    process.exit(args.length === 0 ? 0 : 2);
  }

  // Reuse the shared argument-parser skeleton so the CLI honors the
  // same §2.3 grammar + --size tier whitelist + --weights validation
  // (PR4 active) as `/engineer:decide`. (peer P-9 / M5 fix)
  const { parseArgs } = await import("./lib/decide-args.mjs");
  const parsed = parseArgs(args.slice(1));

  // Surface warnings (last-wins repeats, etc.).
  for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);

  // §2.3(3-4): hard halt on parser errors.
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) process.stderr.write(`error: ${e}\n`);
    process.exit(2);
  }

  const { context, diagnostics } = resolvePreset({
    presetId: parsed.flags.preset,
    sizeExplicit: parsed.flags.size !== undefined,
    sizeValue: parsed.flags.size,
    body: parsed.body,                        // peer M2 fix — thread body into §5.6 context
    weights: parsed.flags.weights,            // PR4: raw spec from --weights=<spec>
    weightsExplicit: parsed.weightsExplicit,  // PR4: top-level explicit-presence signal
  });
  for (const line of diagnostics) process.stderr.write(`registry: ${line}\n`);
  process.stdout.write(JSON.stringify(context, null, 2) + "\n");
  process.exit(0);
}

// Guard against `process.argv[1]` being undefined (e.g., the module is
// imported via `node --input-type=module -e 'import(...)'` rather than
// run directly). peer N1 fix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Async IIFE per memory project_cli_entry_iife_pattern — avoids
  // top-level-await deadlock with dynamic imports.
  (async () => { await main(process.argv); })();
}
