#!/usr/bin/env node
// Registry reader for <persona>:decide — the ADR-0027 §1 + §5.6 portable
// registry schema, one reader for every persona (ADR-0066 Decision 1). The
// persona's own data comes from its declaration (persona.json `decide`,
// ADR-0066 V4–V8), read when the reader runs, never at import:
//   - decide.fallback       the in-code fallback preset, used when the registry
//                           file is missing, malformed or rejected; it equals
//                           the registry preset of the same id (checked by
//                           scripts/sync-persona-pipeline.mjs);
//   - decide.size_presets   the --size tier -> preset map;
//   - decide.profile_presets the L4 profile -> preset map, read only when the
//                           persona has the profile_presets capability on;
//                           otherwise the ADR-0027 §1.5(3) slot stays reserved.
// The optional per-axis `gate` veto flag is accepted for every persona (V7).
//
// Public API:
//   loadRegistry({ path?: string }) -> { registry: object|null, diagnostics: string[], fallbackTriggered: boolean }
//   resolvePreset({
//     path?: string,
//     presetId?: string,
//     sizeExplicit?: boolean,
//     sizeValue?: "minor" | "standard" | "major",
//     profileOverride?: string,        // §1.5(3) — the L4 profile (profile_presets on)
//     body?: string,                   // threaded into context.body per §5.6
//     weights?: string,                // PR4 — raw --weights=<spec> string
//     weightsExplicit?: boolean,       // PR4 — top-level parser explicit-presence signal
//   }) -> { context: ResolvedDecisionContext, diagnostics: string[], fallbackTriggered: boolean }
//   profilePresetMap() -> object|null  // §1.5(3) — L4 profile -> preset id, or null when off
//
// CLI:
//   node decide-registry.mjs resolve
//     [--preset=<id>] [--size=<tier>] [--weights=<spec>] [-- <decision body>]
//   node decide-registry.mjs resolve --args-file <path>
//     the same arguments as one text in an ADR-0059 args file; its leading
//     flags and intact body become [...flags, "--", body]
//     stdout — JSON ResolvedDecisionContext (§5.6 + PR4 amendment fields)
//     stderr — fallback diagnostics + chosen-source diagnostic (one line each)
//     exit 0 — registry resolved (with or without graceful-degradation diagnostics)
//     exit 1 — the persona declaration is missing or broken (nothing resolved)
//     exit 2 — argument-parser errors (unknown flag, invalid --size, malformed
//              --weights) per ADR-0027 §2.3(3-4)
//
//   The L4 profile is NOT a `resolve` flag: the ADR-0027 §2.2 decide grammar
//   (--preset / --size / --weights) is unchanged, and the decide verb stays
//   single-mode. With profile_presets on, the CLI reads the profile from the
//   AGENTIC_<NAME>_PROFILE environment variable (AGENTIC_DESIGNER_PROFILE for
//   designer) — the value the Task Profile recorded, passed by the persona's
//   start runbook. Unset means the default preset, so behavior is unchanged for
//   a standalone verb invocation. With profile_presets off the variable is
//   ignored.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parse as parseYaml, YamlParseError } from "./lib/yaml-mini.mjs";
import { normalizeWeights } from "./lib/decide-weights.mjs";
import { ArgsFileError, personaArgv, readArgsFile, soleArgsFilePath } from "./lib/args-file.mjs";
import { capabilityOn, loadPersona, personaName, personaOrRefuse, profileEnvVar } from "./lib/persona.mjs";
import { isCliEntry } from "./lib/cli-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(HERE, "..", "core", "skills", "decide", "references", "decision-axes.yml");

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VALID_ROLES = new Set(["decisive", "supporting"]);

// In-code fallback — the persona's decide.fallback (ADR-0066 V4), the
// LAST-RESORT preset when the registry file is missing, malformed, or rejected
// by any §1.6 failure mode. It equals the registry preset of the same id, gate
// flag included on every axis, so the fallback context shape matches the
// registry-resolved shape exactly; scripts/sync-persona-pipeline.mjs fails the
// drift check when the two differ.
let fallbackCache = null;
function fallbackPreset() {
  if (fallbackCache === null) {
    const { fallback } = loadPersona({ require: ["decide.fallback", "decide.size_presets"] }).decide;
    fallbackCache = freeze({
      preset_id: fallback.preset_id,
      axes: Object.freeze(fallback.axes.map((a) => freeze({
        id: a.id,
        labels: freeze({ en: a.labels.en, ko: a.labels.ko ?? null }),
        question: a.question,
        role: a.role,
        gate: a.gate === true,
      }))),
    });
  }
  return fallbackCache;
}

// The id of the default preset (§1.5(4)) — the fallback preset's id.
function defaultPresetId() {
  return fallbackPreset().preset_id;
}

function freeze(obj) { return Object.freeze(obj); }

// ADR-0027 §1.5(3) — the L4 profile -> decision-preset map, the persona's
// decide.profile_presets (ADR-0066 V6), present exactly when the persona has
// the profile_presets capability on (designer: its design archetypes). The
// persona's orchestration reference documents the table and its
// decision-axes.yml defines the presets; the drift check fails when a map
// value names a preset the registry does not define. Null when the capability
// is off: the §1.5(3) slot stays reserved and a profile override is ignored.
export function profilePresetMap() {
  if (!capabilityOn("profile_presets")) return null;
  return Object.freeze({ ...loadPersona({ require: ["decide.profile_presets"] }).decide.profile_presets });
}

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
    // Optional veto-gate flag (ADR-0036 SD3, ADR-0042 SD3; every persona
    // since ADR-0066 V7).
    // The ADR-0027 role enum (decisive | supporting) is unchanged; `gate`
    // is orthogonal. yaml-mini coerces every scalar to its string form
    // (see lib/yaml-mini.mjs), so a registry `gate: true` arrives as the
    // string "true"; the in-code fallback (decide.fallback) uses a real boolean.
    // Accept both spellings and reject anything else so a malformed gate
    // value triggers graceful §1.6 fallback rather than silently shipping.
    if (
      Object.hasOwn(axis, "gate") &&
      !(axis.gate === true || axis.gate === false || axis.gate === "true" || axis.gate === "false")
    ) {
      return `preset "${presetId}" axis "${axis.id}": gate must be true or false when present`;
    }
  }
  if (decisiveCount < 2) {
    return `preset "${presetId}": decisive-axis count is ${decisiveCount}, must be >= 2 (§1.3 invariant)`;
  }
  return null;
}

// Load + validate the YAML registry from `path` (defaults to the
// persona's own registry). The reader applies the §1.6 failure-mode
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
          gate: a.gate === true || a.gate === "true",   // veto-gate flag (ADR-0066 V7); yaml-mini yields string "true". default false
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
//   3. profileOverride (the L4 profile, via profilePresetMap() — only with
//      the profile_presets capability on; otherwise the slot stays reserved)
//   4. default → the fallback preset's id (decide.fallback.preset_id)
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
  // The persona's decide data (ADR-0066 V4–V6), read when resolving.
  const defaultId = defaultPresetId();
  const sizePresets = loadPersona().decide.size_presets;
  const profileMap = profilePresetMap();

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
        chosen = ownPreset(defaultId);
        chosenSource = "fallback-after-unknown-preset";
      }
    }

    // §1.5(2): explicit --size implies preset, ONLY when explicit.
    if (!chosen && sizeExplicit && sizeValue) {
      // The size map is the persona's decide.size_presets (V5). It may be
      // degenerate — designer's maps every tier to `balanced`, so `--size`
      // only sets the per-axis rendering depth (the SKILL @decide:* size-aware
      // regions). An explicit `--size` OUTRANKS the L4 profile by design: the
      // user typed the flag, the profile is ambient context.
      const map = sizePresets;
      const implied = Object.hasOwn(map, sizeValue) ? map[sizeValue] : undefined;
      const impliedPreset = implied ? ownPreset(implied) : null;
      if (impliedPreset) {
        chosen = impliedPreset;
        chosenSource = `size-implied:${sizeValue}->${implied}`;
        // Silent-drop guard. An explicit `--size` consumes §1.5(2), so the L4
        // profile at §1.5(3) never fires. That is ADR-0027-correct — an
        // explicit flag outranks ambient context — but it is invisible: a
        // designer user who set profile=cta and typed `--size=minor` gets the
        // `balanced` matrix, not the `conversion` archetype. Say so on stderr
        // rather than silently discarding the profile.
        const droppedPreset = profileMap && profileOverride && Object.hasOwn(profileMap, profileOverride)
          ? profileMap[profileOverride]
          : null;
        if (droppedPreset && droppedPreset !== implied) {
          diags.push(
            `--size=${sizeValue} implies preset "${implied}" and outranks the L4 profile ` +
            `"${profileOverride}" (preset "${droppedPreset}"), which was NOT applied ` +
            `(ADR-0027 §1.5(2) precedes §1.5(3)); drop --size to use the profile's preset`,
          );
        }
      } else if (implied) {
        diags.push(`--size=${sizeValue} implies preset "${implied}" but registry has none; falling back to default`);
        fallback = true;
        chosen = ownPreset(defaultId);
        chosenSource = "fallback-after-size-implied-missing";
      }
    }

    // §1.5(3): the L4 profile override (ADR-0042 SD6 for designer; the
    // profile_presets capability, ADR-0066 V6). With the capability off the
    // slot stays reserved: an override is recorded as a diagnostic and ignored.
    //
    // With it on, the override is reached only when the user typed neither
    // `--preset` nor `--size`, so an explicit flag always outranks ambient
    // profile context. An unknown profile, or one whose mapped preset is
    // missing from the registry, degrades gracefully to the default with a
    // diagnostic — a decision must never halt on a mistyped profile.
    //
    // Both degraded branches set `fallbackTriggered`, mirroring the
    // unknown-preset row: the selector the caller supplied did NOT resolve, so
    // the default preset_id here does not mean "the caller asked for the
    // default". That signal is what suppresses the Brainstorm
    // `<axis_awareness>` block (§4.3) — better a free-form peer than a peer
    // pinned to an axis frame the caller never chose. An UNSET profile is not a
    // degraded path at all: the guard below skips it and §1.5(4) defaults.
    if (!chosen && profileOverride && !profileMap) {
      diags.push(`profile override "${profileOverride}" provided but no consumer registered in PR2; ignored`);
    } else if (!chosen && profileOverride) {
      const mapped = Object.hasOwn(profileMap, profileOverride)
        ? profileMap[profileOverride]
        : null;
      if (!mapped) {
        diags.push(`unknown L4 profile "${profileOverride}"; known: ${Object.keys(profileMap).join(", ")}; falling back to default`);
        fallback = true;
        chosen = ownPreset(defaultId);
        chosenSource = "fallback-after-unknown-profile";
      } else {
        const mappedPreset = ownPreset(mapped);
        if (mappedPreset) {
          chosen = mappedPreset;
          chosenSource = `profile-implied:${profileOverride}->${mapped}`;
          // Provenance. The §5.6 context carries no chosen-source field (PR4
          // refine M4 dropped `_chosenSource` as off-schema), so a preset that
          // arrived from ambient environment rather than a typed flag would
          // otherwise be indistinguishable from an explicit `--preset`. Emit it
          // only when the profile actually CHANGED the outcome — a profile that
          // resolves the §1.5(4) default would be pure noise.
          if (mapped !== defaultId) {
            diags.push(`L4 profile "${profileOverride}" (${profileEnvVar()}) resolved preset "${mapped}"`);
          }
        } else {
          diags.push(`L4 profile "${profileOverride}" implies preset "${mapped}" but registry has none; falling back to default`);
          fallback = true;
          chosen = ownPreset(defaultId);
          chosenSource = "fallback-after-profile-implied-missing";
        }
      }
    }

    // §1.5(4): default fallback.
    if (!chosen) {
      chosen = ownPreset(defaultId);
      chosenSource = "default";
    }

    if (!chosen) {
      diags.push("registry has no usable default preset; falling back to in-code default");
      fallback = true;
    }
  }

  // Fallback path (registry null or no usable preset).
  const resolved = chosen ?? fallbackPreset();
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
    preset_id: resolved.preset_id ?? resolved.id ?? defaultId,
    axes: resolved.axes,                  // frozen per peer P-13
    size: sizeExplicit && sizeValue ? sizeValue : "standard",
    size_explicit: !!sizeExplicit,
    weights: weightsResult.weights,       // PR4 normalized (empty {} = uniform sentinel)
    weights_explicit: !!weightsExplicit,  // PR4 (M1 refine): LLM-observable explicit-presence signal
    resolved_at: new Date().toISOString(),
    // PR5 (validation-contract): ADR-0027 §5.6 amendment. The §4.3
    // Brainstorm `<axis_awareness>` presence rule fires only when no
    // §1.6 fallback was triggered. Without an on-wire signal,
    // preset_id=<default> is ambiguous between "user requested the default"
    // (no fallback) and "registry rejected and fell back" (fallback) —
    // exactly the disambiguation §4.3 hinges on. Surface the JS-internal
    // `fallbackTriggered` as a snake_case context field so the LLM
    // body consumer (commands/decide.md Phase 1 prompt builder) can
    // gate axis_awareness emission directly from the printed context.
    registry_fallback: !!fallback,
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

// CLI mode. Exit statuses — set through process.exitCode, never process.exit(),
// which cuts a piped stdout at 64 KiB; the context carries the body, and an
// ADR-0059 args file lets the body be up to 1 MiB:
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
      `decide-registry.mjs — ${personaName()}:decide registry reader\n` +
      "usage: node decide-registry.mjs resolve [--preset=<id>] [--size=<tier>] [--weights=<spec>] [-- <decision body>]\n" +
      "       node decide-registry.mjs resolve --args-file <path>\n",
    );
    process.exitCode = args.length === 0 ? 0 : 2;
    return;
  }

  // Reuse the shared argument-parser skeleton so the CLI honors the
  // same §2.3 grammar + --size tier whitelist + --weights validation
  // (PR4 active) as `/<persona>:decide`. (peer P-9 / M5 fix)
  const { parseArgs } = await import("./lib/decide-args.mjs");
  // ADR-0059: the runbook has the model write the argument text into an args
  // file, so no shell parses it on the way here. Its leading flags and its
  // body, byte for byte, reach the same parser as `[...flags, "--", body]`.
  let argList = args.slice(1);
  try {
    const argsFilePath = soleArgsFilePath(argList);
    if (argsFilePath !== null) argList = personaArgv(readArgsFile(argsFilePath));
  } catch (error) {
    if (!(error instanceof ArgsFileError)) throw error;
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const parsed = parseArgs(argList);

  // Surface warnings (last-wins repeats, etc.).
  for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);

  // §2.3(3-4): hard halt on parser errors.
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) process.stderr.write(`error: ${e}\n`);
    process.exitCode = 2;
    return;
  }

  // §1.5(3): the L4 profile arrives through the environment, not the decide
  // grammar (see the header note), and only with profile_presets on — with it
  // off, an inherited AGENTIC_<NAME>_PROFILE changes nothing (ADR-0066
  // Decision 3). Blank/whitespace-only is treated as unset so an
  // `export AGENTIC_DESIGNER_PROFILE=""` never reads as an unknown profile and
  // never trips the degraded path.
  const profileOverride = capabilityOn("profile_presets")
    ? (process.env[profileEnvVar()] ?? "").trim() || undefined
    : undefined;

  const { context, diagnostics } = resolvePreset({
    presetId: parsed.flags.preset,
    sizeExplicit: parsed.flags.size !== undefined,
    sizeValue: parsed.flags.size,
    profileOverride,                          // §1.5(3): the L4 profile from AGENTIC_<NAME>_PROFILE
    body: parsed.body,                        // peer M2 fix — thread body into §5.6 context
    weights: parsed.flags.weights,            // PR4: raw spec from --weights=<spec>
    weightsExplicit: parsed.weightsExplicit,  // PR4: top-level explicit-presence signal
  });
  for (const line of diagnostics) process.stderr.write(`registry: ${line}\n`);
  process.stdout.write(JSON.stringify(context, null, 2) + "\n");
  process.exitCode = 0;
}

// Run as a CLI only when this file is the entry point (ADR-0066 D1), and only
// with a valid persona declaration.
if (isCliEntry(import.meta.url)) {
  // Async IIFE per memory project_cli_entry_iife_pattern — avoids
  // top-level-await deadlock with dynamic imports.
  (async () => {
    if (!personaOrRefuse("decide-registry.mjs")) {
      process.exitCode = 1;
      return;
    }
    await main(process.argv);
  })();
}
