// Tests for plugins/<persona>/scripts/decide-registry.mjs — the generated copy
// of persona-pipeline/files/scripts/decide-registry.mjs, the one registry reader
// every persona runs (ADR-0066 Decision 1), run once for every persona the
// manifest generates it into (ADR-0066 Decision 5).
//
// Scope: the persona-NEUTRAL reader behavior, driven by each persona's
// declaration (persona.json `decide`, ADR-0066 V4–V8):
//   - decide.fallback       the in-code preset when the registry file is missing;
//   - decide.size_presets   the explicit --size tier -> preset map;
//   - decide.profile_presets + the profile_presets capability — the L4 profile
//                           read from AGENTIC_<NAME>_PROFILE when on, the
//                           ADR-0027 §1.5(3) reserved slot when off;
//   - the per-axis `gate` flag, a real boolean on every resolved axis (V7).
// Each persona's own registry data (its presets, axes and profile map
// contents) is pinned in tests/<persona>/test-decide-registry.mjs.

import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { personasFor, personaInfo } from "./_personas.mjs";

const UNIT = "scripts/decide-registry.mjs";
const PERSONAS = personasFor(UNIT);
const INFO = Object.fromEntries(PERSONAS.map((p) => [p, personaInfo(p)]));

// The variable the profile_presets persona reads today. An off persona must
// ignore it as well as its own AGENTIC_<NAME>_PROFILE.
const DESIGNER_PROFILE_VAR = "AGENTIC_DESIGNER_PROFILE";

// The CLI's base environment: no persona's profile variable, so an operator
// who exports one in their own shell cannot steer these runs.
function baseEnv() {
  const env = { ...process.env };
  for (const p of PERSONAS) delete env[INFO[p].profileEnvVar];
  delete env[DESIGNER_PROFILE_VAR];
  return env;
}

function runResolve(P, env, args = []) {
  return spawnSync(process.execPath, [P.path(UNIT), "resolve", ...args, "--", "x"], { encoding: "utf8", env });
}

function parseContext(r) {
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  delete parsed.resolved_at; // a timestamp; the only field two identical resolutions may differ on
  return parsed;
}

// A profile that steers a profile_presets persona away from its default preset,
// so an off persona that wrongly read it would visibly diverge.
const STEERING_PROFILE = PERSONAS
  .filter((p) => INFO[p].capabilities.profile_presets)
  .flatMap((p) => {
    const d = INFO[p].declaration.decide;
    return Object.entries(d.profile_presets).filter(([, preset]) => preset !== d.fallback.preset_id).map(([k]) => k);
  })[0];

// Non-vacuity: the on/off profile cases below discriminate only if the
// personas include both sides, and the off case needs a steering profile.
test("decide-registry: the personas cover profile_presets on and off, and a profile steers off the default", () => {
  const on = PERSONAS.map((p) => INFO[p].capabilities.profile_presets);
  assert.ok(on.includes(true), "no persona has profile_presets on");
  assert.ok(on.includes(false), "every persona has profile_presets on");
  assert.equal(typeof STEERING_PROFILE, "string", "no declared profile maps to a non-default preset");
});

const GATE_REGISTRY = `schema: "1.0"
presets:
  probe:
    axes:
      - id: "alpha"
        labels:
          en: "Alpha"
        question: "Alpha?"
        role: "decisive"
      - id: "beta"
        labels:
          en: "Beta"
        question: "Beta?"
        role: "decisive"
        gate: false
      - id: "gamma"
        labels:
          en: "Gamma"
        question: "Gamma?"
        role: "supporting"
        gate: true
`;

function withRegistry(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "persona-pipeline-decide-registry-"));
  const path = join(dir, "decision-axes.yml");
  writeFileSync(path, body, "utf8");
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const persona of PERSONAS) {
  const P = INFO[persona];
  const D = P.declaration.decide;
  const defaultId = D.fallback.preset_id;
  const { loadRegistry, resolvePreset, profilePresetMap } = await import(pathToFileURL(P.path(UNIT)).href);

  describe(`${persona}: decide-registry — persona-neutral reader behavior`, () => {
    // ---------- missing registry → the declared fallback ----------

    test("registry file missing → the context is the declaration's decide.fallback, registry_fallback true", () => {
      const loaded = loadRegistry({ path: "/nonexistent.yml" });
      assert.equal(loaded.registry, null);
      assert.equal(loaded.fallbackTriggered, true);

      const { context, diagnostics, fallbackTriggered } = resolvePreset({ path: "/nonexistent.yml" });
      assert.equal(fallbackTriggered, true);
      assert.equal(context.registry_fallback, true);
      assert.ok(
        diagnostics.some((d) => d.includes("registry file missing at /nonexistent.yml")),
        `expected a missing-file diagnostic; got ${JSON.stringify(diagnostics)}`,
      );
      assert.equal(context.preset_id, D.fallback.preset_id);
      assert.deepEqual(
        context.axes,
        D.fallback.axes.map((a) => ({
          id: a.id,
          labels: { en: a.labels.en, ko: a.labels.ko ?? null },
          question: a.question,
          role: a.role,
          gate: a.gate === true,
        })),
        "fallback axes must be the declaration's: ids, labels, questions, roles and gates, in order",
      );
    });

    // ---------- explicit --size → decide.size_presets ----------

    test("decide.size_presets covers exactly the parser's --size tiers", () => {
      assert.deepEqual(Object.keys(D.size_presets).sort(), ["major", "minor", "standard"]);
    });

    test("an explicit --size tier resolves the declaration's decide.size_presets preset", () => {
      for (const [tier, presetId] of Object.entries(D.size_presets)) {
        const { context, diagnostics, fallbackTriggered } = resolvePreset({ sizeExplicit: true, sizeValue: tier });
        assert.equal(context.preset_id, presetId, `--size=${tier}`);
        assert.equal(context.size, tier);
        assert.equal(context.size_explicit, true);
        assert.equal(fallbackTriggered, false, `--size=${tier}: ${JSON.stringify(diagnostics)}`);
        assert.equal(context.registry_fallback, false);
        assert.deepEqual(diagnostics, []);
      }
    });

    test("a --size value that was not explicit implies nothing — default preset, size standard", () => {
      for (const tier of Object.keys(D.size_presets)) {
        const { context } = resolvePreset({ sizeExplicit: false, sizeValue: tier });
        assert.equal(context.preset_id, defaultId, `implicit ${tier}`);
        assert.equal(context.size, "standard");
        assert.equal(context.size_explicit, false);
      }
    });

    // ---------- the L4 profile (profile_presets capability) ----------

    if (P.capabilities.profile_presets) {
      test("profile_presets on: profilePresetMap() equals the declaration's decide.profile_presets", () => {
        assert.deepEqual(profilePresetMap(), D.profile_presets);
      });

      test("profile_presets on: a library profileOverride resolves each declared profile's preset", () => {
        for (const [profile, presetId] of Object.entries(D.profile_presets)) {
          const { context, fallbackTriggered } = resolvePreset({ profileOverride: profile });
          assert.equal(context.preset_id, presetId, `profile ${profile}`);
          assert.equal(fallbackTriggered, false, `profile ${profile}`);
        }
      });

      test(`profile_presets on: the CLI reads ${P.profileEnvVar} and resolves the mapped preset`, () => {
        assert.ok(
          Object.values(D.profile_presets).some((presetId) => presetId !== defaultId),
          "no declared profile maps away from the default — the CLI cases below could not tell the variable was read",
        );
        for (const [profile, presetId] of Object.entries(D.profile_presets)) {
          const parsed = parseContext(runResolve(P, { ...baseEnv(), [P.profileEnvVar]: profile }));
          assert.equal(parsed.preset_id, presetId, `${P.profileEnvVar}=${profile}`);
          assert.equal(parsed.registry_fallback, false, `${P.profileEnvVar}=${profile}`);
        }
      });
    } else {
      test("profile_presets off: profilePresetMap() is null", () => {
        assert.equal(profilePresetMap(), null);
      });

      test(`profile_presets off: setting ${P.profileEnvVar} and ${DESIGNER_PROFILE_VAR} changes nothing in the CLI`, () => {
        const plain = runResolve(P, baseEnv());
        const baseline = parseContext(plain);
        assert.equal(baseline.preset_id, defaultId);
        assert.equal(baseline.registry_fallback, false);
        for (const value of [STEERING_PROFILE, "no-such-profile"]) {
          const env = { ...baseEnv(), [P.profileEnvVar]: value, [DESIGNER_PROFILE_VAR]: value };
          const r = runResolve(P, env);
          assert.deepEqual(parseContext(r), baseline, `profile variables set to "${value}" changed the context`);
          // A CLI that passed the value on would leave the reserved-slot
          // diagnostic on stderr even though the preset stays the default.
          assert.equal(r.stderr, plain.stderr, `profile variables set to "${value}" changed stderr`);
        }
      });

      test("profile_presets off: a library profileOverride keeps the ADR-0027 §1.5(3) reserved slot", () => {
        const { context, diagnostics, fallbackTriggered } = resolvePreset({ profileOverride: "x" });
        assert.deepEqual(diagnostics, ['profile override "x" provided but no consumer registered in PR2; ignored']);
        assert.equal(context.preset_id, defaultId);
        assert.equal(fallbackTriggered, false);
        assert.equal(context.registry_fallback, false);
      });
    }

    // ---------- the gate flag (V7) ----------

    test("every resolved axis carries a boolean gate (V7)", () => {
      const resolved = [];
      const { registry } = loadRegistry({});
      assert.ok(registry, "the persona's own registry must load");
      for (const preset of Object.values(registry.presets)) resolved.push([`registry preset ${preset.id}`, preset.axes]);
      resolved.push(["missing-registry fallback", resolvePreset({ path: "/nonexistent.yml" }).context.axes]);
      resolved.push(["default", resolvePreset({}).context.axes]);
      for (const tier of Object.keys(D.size_presets)) {
        resolved.push([`--size=${tier}`, resolvePreset({ sizeExplicit: true, sizeValue: tier }).context.axes]);
      }
      for (const profile of Object.keys(profilePresetMap() ?? {})) {
        resolved.push([`profile ${profile}`, resolvePreset({ profileOverride: profile }).context.axes]);
      }
      resolved.push(["CLI resolve", parseContext(runResolve(P, baseEnv())).axes]);
      for (const [label, axes] of resolved) {
        assert.ok(axes.length > 0, `${label}: no axes`);
        for (const a of axes) assert.equal(typeof a.gate, "boolean", `${label}: axis ${a.id} gate is ${JSON.stringify(a.gate)}`);
      }
    });

    test("a registry gate flag is read for every persona: gate: true (string-coerced by yaml-mini) → true, false/absent → false", () => {
      withRegistry(GATE_REGISTRY, (path) => {
        const { registry, diagnostics, fallbackTriggered } = loadRegistry({ path });
        assert.equal(fallbackTriggered, false, JSON.stringify(diagnostics));
        assert.deepEqual(
          registry.presets.probe.axes.map((a) => [a.id, a.gate]),
          [["alpha", false], ["beta", false], ["gamma", true]],
        );
      });
    });

    test("a malformed gate value (not true/false) skips the preset and falls back", () => {
      withRegistry(GATE_REGISTRY.replace("gate: true", 'gate: "maybe"'), (path) => {
        const { registry, diagnostics, fallbackTriggered } = loadRegistry({ path });
        assert.equal(fallbackTriggered, true);
        assert.equal(registry, null);
        assert.ok(
          diagnostics.some((d) => /axis "gamma": gate must be true or false when present/.test(d)),
          `expected a gate-validation diagnostic; got: ${JSON.stringify(diagnostics)}`,
        );
      });
    });
  });
}
