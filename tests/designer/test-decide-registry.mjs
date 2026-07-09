// Tests for plugins/designer/scripts/decide-registry.mjs — the designer:decide
// registry reader (ADR-0042 SD3 design/UX decision axes on the ADR-0027
// portable registry schema, copy-not-import per ADR-0029).
//
// Scope: this suite exercises the designer-LOCAL divergences — the real
// design registry (balanced + conversion/experience/clarity presets; 사용성
// usability the COMMON decisive axis; the single 접근성 accessibility veto
// gate), the designer size→preset map (no compact tier — every size resolves
// balanced), the in-code DEFAULT_FALLBACK design axes (kept in lockstep with
// the balanced preset), and the `gate` flag's yaml-mini string-coercion
// handling + validation. The shared §1.6 graceful-degradation resolver logic
// itself is exercised in depth by the engineer suite this reader descends
// from; here we confirm a representative slice still holds against designer's
// real file + axis set.
//
// Run via `node --test tests/designer/test-decide-registry.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadRegistry, resolvePreset, PROFILE_PRESET_MAP } from "../../plugins/designer/scripts/decide-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "plugins", "designer", "scripts", "decide-registry.mjs");

const COMMON_DECISIVE = "usability"; // decisive in EVERY preset (ADR-0042 SD3)
const GATE = "accessibility";        // the single veto gate
const PRESETS = ["balanced", "clarity", "conversion", "experience"];
const BALANCED_AXES = [
  "usability", "consistency", "conversion",
  "desirability", "content-clarity", "feasibility",
  "accessibility",
];

function writeRegistry(body) {
  const dir = mkdtempSync(join(tmpdir(), "designer-decide-registry-"));
  const path = join(dir, "decision-axes.yml");
  writeFileSync(path, body, "utf8");
  return { dir, path };
}

// ---------- Real designer registry (design/UX axes) ----------

test("loadRegistry: real designer registry loads cleanly with the four presets", () => {
  const { registry, diagnostics, fallbackTriggered } = loadRegistry({});
  assert.equal(fallbackTriggered, false);
  assert.deepEqual(diagnostics, []);
  assert.ok(registry);
  assert.deepEqual(Object.keys(registry.presets).sort(), PRESETS);
});

test("balanced preset is the 7-axis design matrix in document order", () => {
  const { registry } = loadRegistry({});
  const ids = registry.presets.balanced.axes.map((a) => a.id);
  assert.deepEqual(ids, BALANCED_AXES);
});

test("balanced preset carries ko labels for every design axis", () => {
  const { registry } = loadRegistry({});
  const ko = Object.fromEntries(registry.presets.balanced.axes.map((a) => [a.id, a.labels.ko]));
  assert.equal(ko["usability"], "사용성");
  assert.equal(ko["consistency"], "일관성");
  assert.equal(ko["conversion"], "전환");
  assert.equal(ko["desirability"], "매력도");
  assert.equal(ko["content-clarity"], "명확성");
  assert.equal(ko["feasibility"], "구현가능성");
  assert.equal(ko["accessibility"], "접근성");
});

// decisive 불변식 (ADR-0042 SD3 / ADR-0027 §1.3): unlike founder, designer
// presets do NOT share one fixed decisive pair — usability is the COMMON
// decisive axis, and the second decisive axis is archetype-specific.
test("§1.3 invariant: every preset declares >= 2 decisive axes and usability is decisive in all", () => {
  const { registry } = loadRegistry({});
  for (const pid of Object.keys(registry.presets)) {
    const decisive = registry.presets[pid].axes.filter((a) => a.role === "decisive").map((a) => a.id);
    assert.ok(decisive.length >= 2, `preset ${pid} must declare >= 2 decisive axes (got ${decisive.length})`);
    assert.ok(decisive.includes(COMMON_DECISIVE), `preset ${pid} must carry usability as a decisive axis (the common-decisive axis)`);
  }
});

test("each archetype preset carries the expected second decisive axis", () => {
  const { registry } = loadRegistry({});
  const secondDecisive = (pid) =>
    registry.presets[pid].axes.filter((a) => a.role === "decisive").map((a) => a.id).filter((id) => id !== COMMON_DECISIVE);
  assert.deepEqual(secondDecisive("balanced"), ["consistency"]);
  assert.deepEqual(secondDecisive("conversion"), ["conversion"]);
  assert.deepEqual(secondDecisive("experience"), ["desirability"]);
  assert.deepEqual(secondDecisive("clarity"), ["content-clarity"]);
});

// gate field — accessibility is the SINGLE veto gate in every preset
test("accessibility is the single veto gate in every preset (gate:true boolean); no other axis is a gate", () => {
  const { registry } = loadRegistry({});
  for (const pid of Object.keys(registry.presets)) {
    for (const a of registry.presets[pid].axes) {
      assert.equal(typeof a.gate, "boolean", `${pid}.${a.id} gate must be a real boolean (yaml-mini coerces scalars to strings)`);
      const expected = a.id === GATE;
      assert.equal(a.gate, expected, `${pid}.${a.id} gate=${a.gate}, expected ${expected}`);
    }
    const gates = registry.presets[pid].axes.filter((a) => a.gate).map((a) => a.id);
    assert.deepEqual(gates, [GATE], `preset ${pid} must have exactly one gate: accessibility`);
  }
});

test("archetype presets are 5-axis focused subsets (2 decisive + 2 supporting + accessibility gate)", () => {
  const { registry } = loadRegistry({});
  for (const pid of ["conversion", "experience", "clarity"]) {
    assert.equal(registry.presets[pid].axes.length, 5, `${pid} must be a 5-axis focused preset`);
    const gates = registry.presets[pid].axes.filter((a) => a.gate).map((a) => a.id);
    assert.deepEqual(gates, [GATE], `${pid} must keep the accessibility gate`);
  }
});

// ---------- size → preset map (designer has no compact tier) ----------

test("size map: every tier resolves balanced (designer has no compact tier)", () => {
  assert.equal(resolvePreset({ sizeExplicit: true, sizeValue: "minor" }).context.preset_id, "balanced");
  assert.equal(resolvePreset({ sizeExplicit: true, sizeValue: "standard" }).context.preset_id, "balanced");
  const major = resolvePreset({ sizeExplicit: true, sizeValue: "major" });
  assert.equal(major.context.preset_id, "balanced");
  assert.equal(major.context.registry_fallback, false);
  // The resolved size tier is still carried on the context (drives rendering depth).
  assert.equal(major.context.size, "major");
});

test("explicit --preset=conversion wins over --size; accessibility gate survives onto the resolved context", () => {
  const { context } = resolvePreset({ presetId: "conversion", sizeExplicit: true, sizeValue: "standard" });
  assert.equal(context.preset_id, "conversion");
  assert.equal(context.size, "standard"); // size retained on context even though preset won
  assert.equal(context.axes.length, 5);
  const acc = context.axes.find((a) => a.id === "accessibility");
  assert.equal(acc.gate, true);
});

// ---------- in-code DEFAULT_FALLBACK is the balanced design matrix ----------

test("ENOENT registry → in-code fallback is the designer balanced matrix (not founder/engineer axes)", () => {
  const { context, fallbackTriggered } = resolvePreset({ path: "/nonexistent/decision-axes.yml" });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "balanced");
  assert.deepEqual(context.axes.map((a) => a.id), BALANCED_AXES);
  const decisive = context.axes.filter((a) => a.role === "decisive").map((a) => a.id).sort();
  assert.deepEqual(decisive, ["consistency", "usability"]);
  // fallback axes also carry real-boolean gate flags so context shape matches the registry path
  assert.equal(context.axes.find((a) => a.id === "accessibility").gate, true);
  assert.equal(context.axes.find((a) => a.id === "usability").gate, false);
});

test("DEFAULT_FALLBACK is kept in lockstep with the balanced preset (ids/roles/gates)", () => {
  const { registry } = loadRegistry({});
  const shape = (axes) => axes.map((a) => ({ id: a.id, role: a.role, gate: a.gate }));
  const balanced = shape(registry.presets.balanced.axes);
  const fallback = shape(resolvePreset({ path: "/nonexistent/x.yml" }).context.axes);
  assert.deepEqual(fallback, balanced, "DEFAULT_FALLBACK must mirror the balanced preset — keep the two in lockstep");
});

// ---------- gate validation + representative §1.6 failure modes ----------

const MIN_VALID = `schema: "1.0"
presets:
  balanced:
    axes:
      - id: "usability"
        labels:
          en: "Usability"
          ko: "사용성"
        question: "Can users accomplish the task?"
        role: "decisive"
      - id: "consistency"
        labels:
          en: "Consistency"
          ko: "일관성"
        question: "Does it cohere with the design system?"
        role: "decisive"
      - id: "accessibility"
        labels:
          en: "Accessibility"
          ko: "접근성"
        question: "Does it clear WCAG A/AA?"
        role: "supporting"
        gate: true
`;

test("a synthetic registry with gate: true (string-coerced by yaml-mini) maps to boolean true", () => {
  const { path, dir } = writeRegistry(MIN_VALID);
  try {
    const { registry, fallbackTriggered } = loadRegistry({ path });
    assert.equal(fallbackTriggered, false);
    const acc = registry.presets.balanced.axes.find((a) => a.id === "accessibility");
    assert.equal(acc.gate, true);
    assert.equal(typeof acc.gate, "boolean");
    const usability = registry.presets.balanced.axes.find((a) => a.id === "usability");
    assert.equal(usability.gate, false, "axes without an explicit gate default to false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed gate value (not true/false) skips the preset and falls back", () => {
  const body = MIN_VALID.replace("gate: true", 'gate: "maybe"');
  const { path, dir } = writeRegistry(body);
  try {
    const { registry, diagnostics, fallbackTriggered } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.equal(registry, null);
    assert.ok(
      diagnostics.some((d) => /gate must be true or false/.test(d)),
      `expected a gate-validation diagnostic; got: ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a preset with fewer than 2 decisive axes is skipped (§1.3 invariant)", () => {
  // Flip consistency decisive→supporting, leaving usability the only decisive axis.
  const body = MIN_VALID.replace(
    'question: "Does it cohere with the design system?"\n        role: "decisive"',
    'question: "Does it cohere with the design system?"\n        role: "supporting"',
  );
  const { path, dir } = writeRegistry(body);
  try {
    const { diagnostics, fallbackTriggered } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(
      diagnostics.some((d) => /decisive-axis count|must be >= 2/.test(d)),
      `expected a decisive-count diagnostic; got: ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown --preset id falls back to balanced with a diagnostic (graceful degradation)", () => {
  const { context, diagnostics, fallbackTriggered } = resolvePreset({ presetId: "made-up-preset" });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "balanced");
  assert.ok(diagnostics.some((d) => /unknown preset id "made-up-preset"/.test(d)));
});

test("schema !== \"1.0\" falls back", () => {
  const { path, dir } = writeRegistry(MIN_VALID.replace('schema: "1.0"', 'schema: "9.9"'));
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /schema is "9.9"/.test(d)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- weights threading over design axes ----------

test("--weights threads normalized per-axis weights over the balanced axes; unmentioned axes fill to 1.0", () => {
  const { context } = resolvePreset({ weights: "usability:3", weightsExplicit: true });
  assert.equal(context.weights["usability"], 3);
  assert.equal(context.weights["consistency"], 1);
  assert.equal(context.weights["accessibility"], 1);
  assert.equal(context.weights_explicit, true);
});

test("--weights over the conversion preset normalizes across exactly the 5 conversion axes", () => {
  const { context } = resolvePreset({
    presetId: "conversion",
    weights: "conversion:2,accessibility:0",
    weightsExplicit: true,
  });
  assert.equal(context.preset_id, "conversion");
  assert.deepEqual(
    Object.keys(context.weights).sort(),
    ["accessibility", "consistency", "content-clarity", "conversion", "usability"],
    "conversion weights map covers exactly the 5 conversion axes, not the 7-axis balanced set",
  );
  assert.equal(context.weights["conversion"], 2);
  assert.equal(context.weights["accessibility"], 0); // a zero-weight gate axis is allowed
  assert.equal(context.weights["usability"], 1); // unmentioned → 1.0
});

test("--weights naming an axis absent from the conversion preset drops it with a diagnostic", () => {
  const { context, diagnostics } = resolvePreset({
    presetId: "conversion",
    weights: "desirability:3", // present in balanced, ABSENT in conversion
    weightsExplicit: true,
  });
  assert.equal(context.preset_id, "conversion");
  assert.ok(
    !Object.hasOwn(context.weights, "desirability"),
    "desirability is not a conversion axis → must be dropped",
  );
  assert.ok(
    diagnostics.some((d) => /desirability.*not in resolved preset|dropped/.test(d)),
    `expected a drop diagnostic; got ${JSON.stringify(diagnostics)}`,
  );
});

test("no --weights → empty sentinel map + weights_explicit false (backward-compat)", () => {
  const { context } = resolvePreset({ body: "x" });
  assert.deepEqual(context.weights, {});
  assert.equal(context.weights_explicit, false);
});

// ---------- CLI surface ----------

// PR6 wired the L4 archetype through AGENTIC_DESIGNER_PROFILE (ADR-0027
// §1.5(3) profile-override slot). Every CLI test must therefore pin that
// variable, or an operator who exports it in their own shell would see these
// assertions resolve a different preset. Empty string == unset (the CLI
// trims and treats blank as absent).
const CLI_ENV = { ...process.env, AGENTIC_DESIGNER_PROFILE: "" };

test("CLI: resolve (default) → 7 design axes JSON on stdout, exit 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--", "bottom tab bar vs hamburger nav"], { encoding: "utf8", env: CLI_ENV });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "balanced");
  assert.equal(parsed.axes.length, 7);
  assert.equal(parsed.body, "bottom tab bar vs hamburger nav");
});

test("CLI: resolve --preset=experience → 5 axes", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--preset=experience", "--", "x"], { encoding: "utf8", env: CLI_ENV });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "experience");
  assert.equal(parsed.axes.length, 5);
});

test("CLI: resolve --size=minor → balanced (7 axes, no compact tier)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--size=minor", "--", "x"], { encoding: "utf8", env: CLI_ENV });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "balanced");
  assert.equal(parsed.axes.length, 7);
  assert.equal(parsed.size, "minor");
});

test("CLI: invalid flag → exit 2 (parser halt)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--bogus=1"], { encoding: "utf8", env: CLI_ENV });
  assert.equal(r.status, 2);
});

// ---------- §1.5(3) L4 profile override (ADR-0042 SD6, wired at PR6) ----------

test("PROFILE_PRESET_MAP: every L4 profile resolves to a preset the registry defines", () => {
  const { registry } = loadRegistry({});
  for (const [profile, presetId] of Object.entries(PROFILE_PRESET_MAP)) {
    assert.ok(
      Object.hasOwn(registry.presets, presetId),
      `L4 profile "${profile}" maps to preset "${presetId}", which decision-axes.yml does not define`,
    );
  }
});

test("PROFILE_PRESET_MAP: the SD6 archetype map is exactly general/flow/ui/cta/content", () => {
  assert.deepEqual(PROFILE_PRESET_MAP, {
    general: "balanced",
    flow: "balanced",
    ui: "experience",
    cta: "conversion",
    content: "clarity",
  });
});

test("profileOverride resolves the mapped preset; general is a no-op equal to the default", () => {
  assert.equal(resolvePreset({ profileOverride: "cta" }).context.preset_id, "conversion");
  assert.equal(resolvePreset({ profileOverride: "ui" }).context.preset_id, "experience");
  assert.equal(resolvePreset({ profileOverride: "content" }).context.preset_id, "clarity");
  assert.equal(resolvePreset({ profileOverride: "flow" }).context.preset_id, "balanced");

  const general = resolvePreset({ profileOverride: "general" });
  assert.equal(general.context.preset_id, "balanced");
  assert.equal(general.context.registry_fallback, false);
  assert.deepEqual(general.context.axes.map((a) => a.id), resolvePreset({}).context.axes.map((a) => a.id));
});

test("profileOverride keeps the accessibility veto gate on every mapped preset", () => {
  for (const profile of Object.keys(PROFILE_PRESET_MAP)) {
    const { context } = resolvePreset({ profileOverride: profile });
    const gates = context.axes.filter((a) => a.gate).map((a) => a.id);
    assert.deepEqual(gates, [GATE], `profile ${profile} must keep the single accessibility veto gate`);
  }
});

// §1.5 precedence: an explicit flag the user typed always outranks the ambient
// L4 profile. The profile only fires at slot (3), i.e. when neither --preset
// nor --size was given.
test("§1.5 precedence: explicit --preset outranks the L4 profile", () => {
  const { context } = resolvePreset({ presetId: "clarity", profileOverride: "cta" });
  assert.equal(context.preset_id, "clarity");
  assert.equal(context.registry_fallback, false);
});

test("§1.5 precedence: explicit --size outranks the L4 profile (size implies balanced)", () => {
  const { context } = resolvePreset({ sizeExplicit: true, sizeValue: "major", profileOverride: "cta" });
  assert.equal(context.preset_id, "balanced");
  assert.equal(context.size, "major");
  assert.equal(context.registry_fallback, false);
});

test("unknown L4 profile degrades to balanced + registry_fallback=true (suppresses axis_awareness)", () => {
  const { context, diagnostics, fallbackTriggered } = resolvePreset({ profileOverride: "brand" });
  assert.equal(context.preset_id, "balanced");
  assert.equal(fallbackTriggered, true);
  assert.equal(context.registry_fallback, true);
  assert.ok(
    diagnostics.some((d) => d.includes('unknown L4 profile "brand"')),
    `expected an unknown-profile diagnostic, got ${JSON.stringify(diagnostics)}`,
  );
});

test("prototype-chain profile ids are not resolvable (Object.hasOwn guard)", () => {
  for (const evil of ["constructor", "toString", "__proto__"]) {
    const { context, fallbackTriggered } = resolvePreset({ profileOverride: evil });
    assert.equal(context.preset_id, "balanced", `profile "${evil}" must not resolve through the prototype chain`);
    assert.equal(fallbackTriggered, true);
  }
});

test("an UNSET profile is not a degraded path — no fallback, no diagnostic", () => {
  const { context, diagnostics, fallbackTriggered } = resolvePreset({ body: "x" });
  assert.equal(context.preset_id, "balanced");
  assert.equal(fallbackTriggered, false);
  assert.deepEqual(diagnostics, []);
  assert.equal(context.registry_fallback, false);
});

// ---------- CLI: the profile arrives through the environment, not the grammar ----------

test("CLI: AGENTIC_DESIGNER_PROFILE=cta → conversion preset (no grammar change)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--", "x"], {
    encoding: "utf8",
    env: { ...process.env, AGENTIC_DESIGNER_PROFILE: "cta" },
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "conversion");
  assert.equal(parsed.registry_fallback, false);
});

test("CLI: --preset=balanced outranks AGENTIC_DESIGNER_PROFILE=cta", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--preset=balanced", "--", "x"], {
    encoding: "utf8",
    env: { ...process.env, AGENTIC_DESIGNER_PROFILE: "cta" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).preset_id, "balanced");
});

test("CLI: blank AGENTIC_DESIGNER_PROFILE is treated as unset (no unknown-profile diagnostic)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--", "x"], {
    encoding: "utf8",
    env: { ...process.env, AGENTIC_DESIGNER_PROFILE: "   " },
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "balanced");
  assert.equal(parsed.registry_fallback, false);
  assert.ok(!/unknown L4 profile/.test(r.stderr), `blank profile must not emit a diagnostic; got: ${r.stderr}`);
});

test("CLI: `--profile=<id>` is NOT a decide flag — the ADR-0027 §2.2 grammar is unchanged (exit 2)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--profile=cta"], { encoding: "utf8", env: CLI_ENV });
  assert.equal(r.status, 2, "the L4 archetype must not leak into the decide argument grammar");
});

// Observability: a preset that arrived from ambient environment rather than a
// typed flag must be visible on stderr — the §5.6 context carries no
// chosen-source field, so diagnostics are the only provenance channel.

test("profile-implied resolution emits a provenance diagnostic when it changes the outcome", () => {
  const { diagnostics } = resolvePreset({ profileOverride: "cta" });
  assert.ok(
    diagnostics.some((d) => /L4 profile "cta".*resolved preset "conversion"/.test(d)),
    `expected a provenance diagnostic, got ${JSON.stringify(diagnostics)}`,
  );
});

test("profile-implied resolution stays silent when it does not change the outcome (general/flow -> balanced)", () => {
  for (const profile of ["general", "flow"]) {
    const { diagnostics, context } = resolvePreset({ profileOverride: profile });
    assert.equal(context.preset_id, "balanced");
    assert.deepEqual(diagnostics, [], `profile ${profile} resolves the default preset and must not emit noise`);
  }
});

// The silent-drop trap: designer's size→preset map is degenerate, so an
// explicit --size consumes §1.5(2) and the archetype never fires. Correct per
// the ladder, but it must not be silent.
test("explicit --size that drops a non-default L4 profile emits a warning diagnostic", () => {
  const { context, diagnostics } = resolvePreset({
    sizeExplicit: true, sizeValue: "minor", profileOverride: "cta",
  });
  assert.equal(context.preset_id, "balanced");
  assert.ok(
    diagnostics.some((d) => /--size=minor.*outranks the L4 profile "cta".*NOT applied/.test(d)),
    `expected a size-outranks-profile diagnostic, got ${JSON.stringify(diagnostics)}`,
  );
});

test("explicit --size does NOT warn when the L4 profile would have resolved the same preset", () => {
  for (const profile of ["general", "flow"]) {
    const { diagnostics } = resolvePreset({ sizeExplicit: true, sizeValue: "major", profileOverride: profile });
    assert.deepEqual(diagnostics, [], `profile ${profile} maps to balanced; --size=major drops nothing`);
  }
});

test("explicit --size does not warn when no L4 profile is set", () => {
  const { diagnostics } = resolvePreset({ sizeExplicit: true, sizeValue: "minor" });
  assert.deepEqual(diagnostics, []);
});

test("an unknown L4 profile is never reported as a silently-dropped archetype", () => {
  const { diagnostics } = resolvePreset({ sizeExplicit: true, sizeValue: "minor", profileOverride: "brand" });
  assert.ok(!diagnostics.some((d) => /outranks the L4 profile/.test(d)),
    "an unmapped profile has no preset to drop; do not claim one was discarded");
});

test("CLI: --size with an ambient non-default profile surfaces the drop on stderr", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--size=minor", "--", "x"], {
    encoding: "utf8",
    env: { ...process.env, AGENTIC_DESIGNER_PROFILE: "cta" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).preset_id, "balanced");
  assert.match(r.stderr, /outranks the L4 profile "cta"/);
});
