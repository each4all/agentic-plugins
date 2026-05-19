// Tests for plugins/engineer/scripts/decide-registry.mjs — reader,
// 18-row failure matrix, §1.5 precedence ladder, §5.6
// ResolvedDecisionContext shape + freeze granularity.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadRegistry, resolvePreset } from "../../plugins/engineer/scripts/decide-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "plugins", "engineer", "scripts", "decide-registry.mjs");
const REGISTRY_PATH = resolve(REPO_ROOT, "plugins", "engineer", "skills", "decide", "references", "decision-axes.yml");

function tmpYaml(content) {
  const dir = mkdtempSync(join(tmpdir(), "decide-reg-"));
  const path = join(dir, "decision-axes.yml");
  writeFileSync(path, content, "utf8");
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Minimal valid registry used as a baseline for negative-fixture tests.
const VALID_MIN = `schema: "1.0"
presets:
  default:
    description: "Default"
    axes:
      - id: "essence"
        labels:
          en: "Essence"
          ko: "본질"
        question: "Does this solve the fundamental problem?"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "Foundation"
          ko: "근본"
        question: "Is this architecturally sound?"
        role: "decisive"
      - id: "practical-fit"
        labels:
          en: "Practical Fit"
          ko: "실용성"
        question: "Best for this project's constraints?"
        role: "supporting"
`;

// =====================
// Happy path
// =====================

test("loadRegistry: default real registry loads cleanly", () => {
  const { registry, diagnostics, fallbackTriggered } = loadRegistry();
  assert.equal(fallbackTriggered, false);
  assert.deepEqual(diagnostics, []);
  assert.equal(registry.schema, "1.0");
  assert.deepEqual(Object.keys(registry.presets).sort(), ["default", "nine-axis"]);
  assert.equal(registry.presets.default.axes.length, 5);
  assert.equal(registry.presets["nine-axis"].axes.length, 9);
});

test("loadRegistry: 9-axis canonical content matches user matrix exactly", () => {
  const { registry } = loadRegistry();
  const ids = registry.presets["nine-axis"].axes.map((a) => a.id);
  assert.deepEqual(ids, [
    "standards", "recommendation", "canonical-precedent",
    "essence", "foundation", "extensibility",
    "maintainability", "maturation", "practical-fit",
  ]);
  // Korean labels per memory canonical mapping.
  const ko = Object.fromEntries(
    registry.presets["nine-axis"].axes.map((a) => [a.id, a.labels.ko]),
  );
  assert.equal(ko.standards, "표준");
  assert.equal(ko.recommendation, "권장");
  assert.equal(ko["canonical-precedent"], "정석");
  assert.equal(ko.essence, "본질");
  assert.equal(ko.foundation, "근본");
  assert.equal(ko.extensibility, "확장");
  assert.equal(ko.maintainability, "유지보수");
  assert.equal(ko.maturation, "고도화");
  assert.equal(ko["practical-fit"], "실용성");
  // §1.3 invariant: essence + foundation are decisive in nine-axis.
  const decisive = registry.presets["nine-axis"].axes.filter((a) => a.role === "decisive").map((a) => a.id);
  assert.deepEqual(decisive.sort(), ["essence", "foundation"]);
});

// =====================
// §1.6 failure-mode matrix — 18 rows
// =====================

test("Row 1 — file missing → fallback + stderr line", () => {
  const { registry, diagnostics, fallbackTriggered } = loadRegistry({ path: "/nonexistent/path/decision-axes.yml" });
  assert.equal(fallbackTriggered, true);
  assert.equal(registry, null);
  assert.ok(diagnostics.some((d) => /missing/.test(d)));
});

test("Row 2 — file permission/IO error → fallback", () => {
  const { dir, path, cleanup } = tmpYaml(VALID_MIN);
  try {
    chmodSync(path, 0o000);
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    // Skip on platforms where root reads through chmod (CI containers).
    if (!fallbackTriggered) return;
    assert.ok(diagnostics.some((d) => /read failed/.test(d)));
  } finally {
    try { chmodSync(path, 0o644); } catch {}
    cleanup();
  }
});

test("Row 3 — YAML parse error → fallback", () => {
  const { path, cleanup } = tmpYaml(`schema: "1.0"\npresets:\n\tdefault:\n`);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /YAML parse failed/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 4 — unknown top-level key → fallback", () => {
  // VALID_MIN provides a parse-clean baseline; we inject a top-level
  // `extra_key` line to trigger the unknown-key check that runs after
  // parse + schema-version validation.
  const yaml = `schema: "1.0"
extra_key: "oops"
${VALID_MIN.split("\n").slice(1).join("\n")}`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /unknown key "extra_key"/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 5 — missing presets map → fallback", () => {
  const { path, cleanup } = tmpYaml(`schema: "1.0"\n`);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /no presets map/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 6 — empty presets map → fallback", () => {
  // `presets:` with no children parses to null in block YAML; our parser
  // does not support flow-style `presets: {}`. Both manifestations route
  // to fallback with a "presets is not a map" or "no presets" diagnostic.
  const { path, cleanup } = tmpYaml(`schema: "1.0"\npresets:\n`);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /presets/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 7 — malformed preset (non-map) → preset skipped, fallback if none survive", () => {
  // The preset is a scalar instead of a map.
  const { path, cleanup } = tmpYaml(`schema: "1.0"\npresets:\n  default: "not-a-map"\n`);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /not a map/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 8 — malformed axes (non-list) → preset skipped", () => {
  const { path, cleanup } = tmpYaml(`schema: "1.0"\npresets:\n  default:\n    axes: "not-a-list"\n`);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /not a list/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 9 — missing required axis field (no labels.en) → preset skipped", () => {
  const yaml = `schema: "1.0"
presets:
  default:
    axes:
      - id: "essence"
        question: "x"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "Foundation"
        question: "y"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /missing labels.en/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 10 — invalid role value → preset skipped", () => {
  const yaml = VALID_MIN.replace(`role: "decisive"`, `role: "kingmaker"`);
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /invalid role/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 11 — invalid axis-id shape → preset skipped", () => {
  const yaml = VALID_MIN.replace(`id: "essence"`, `id: "ESSENCE_BAD"`);
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /invalid axis-id shape/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 12 — invalid preset-id shape → that preset skipped, others kept", () => {
  // Two presets under ONE `presets:` block: "BadId" (uppercase, invalid)
  // and "default" (valid). Validator should skip BadId and keep default.
  const yaml = `schema: "1.0"
presets:
  BadId:
    description: "x"
    axes:
      - id: "essence"
        labels:
          en: "x"
          ko: "x"
        question: "y"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "x"
          ko: "x"
        question: "y"
        role: "decisive"
  default:
    description: "default"
    axes:
      - id: "essence"
        labels:
          en: "Essence"
          ko: "본질"
        question: "Does this solve the fundamental problem?"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "Foundation"
          ko: "근본"
        question: "Is this architecturally sound?"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { registry, diagnostics } = loadRegistry({ path });
    // Other preset(s) survive; registry is non-null.
    assert.ok(registry, "registry should be non-null when at least one preset survives validation");
    assert.ok(diagnostics.some((d) => /preset-id "BadId" has invalid shape/.test(d)));
    assert.ok("default" in registry.presets);
    assert.ok(!("BadId" in registry.presets));
  } finally {
    cleanup();
  }
});

test("Row 13 — unknown preset id requested → fallback to default with diagnostic", () => {
  const { context, diagnostics, fallbackTriggered } = resolvePreset({
    path: REGISTRY_PATH,
    presetId: "nonexistent",
  });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "default");
  assert.ok(diagnostics.some((d) => /unknown preset id "nonexistent"/.test(d)));
});

test("Row 14 — empty axes list → preset skipped", () => {
  const yaml = `schema: "1.0"
presets:
  default:
    axes:
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /axes (list is empty|is not a list)/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 15 — duplicate axis id within preset → preset skipped", () => {
  const yaml = `schema: "1.0"
presets:
  default:
    axes:
      - id: "essence"
        labels:
          en: "E1"
        question: "q1"
        role: "decisive"
      - id: "essence"
        labels:
          en: "E2"
        question: "q2"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /duplicate axis id "essence"/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 16 — duplicate preset-id key in YAML → parser rejects via duplicate map key", () => {
  const yaml = `schema: "1.0"
presets:
  default:
    axes:
      - id: "essence"
        labels:
          en: "E"
        question: "q"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "F"
        question: "q"
        role: "decisive"
  default:
    axes:
      - id: "other"
        labels:
          en: "O"
        question: "q"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /duplicate map key/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 17 — decisive-axis count < 2 → preset skipped", () => {
  const yaml = `schema: "1.0"
presets:
  default:
    axes:
      - id: "essence"
        labels:
          en: "E"
        question: "q"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "F"
        question: "q"
        role: "supporting"
      - id: "practical-fit"
        labels:
          en: "PF"
        question: "q"
        role: "supporting"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /decisive-axis count is 1/.test(d)));
  } finally {
    cleanup();
  }
});

test("Row 18 (peer P-18) — missing/unsupported schema value → fallback", () => {
  const yaml = `schema: "2.0"
presets:
  default:
    axes:
      - id: "essence"
        labels:
          en: "E"
        question: "q"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "F"
        question: "q"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /schema is "2.0"/.test(d)));
  } finally {
    cleanup();
  }
});

// =====================
// Weight-agnosticism (peer P-7)
// =====================

test("Weight-agnosticism: nested `weight` field on axis → unknown key error or ignored gracefully", () => {
  // The parser is strict on duplicate keys but tolerant of unknown axis
  // fields (axes have a fixed required set; extras don't fail parse).
  // Validation in PR4 may tighten this, but PR2 MUST not bake in any
  // weight semantics. Here we assert that a `weight` field on an axis
  // does NOT influence resolution behavior.
  const yaml = `schema: "1.0"
presets:
  default:
    axes:
      - id: "essence"
        labels:
          en: "E"
        question: "q"
        role: "decisive"
        weight: "0.5"
      - id: "foundation"
        labels:
          en: "F"
        question: "q"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { registry, fallbackTriggered } = loadRegistry({ path });
    // The unknown-extras policy is forgiving — parser tolerates them.
    // What we care about: PR2's reader does NOT thread axis.weight to
    // context.weights — that map starts empty regardless.
    assert.equal(fallbackTriggered, false);
    const { context } = resolvePreset({ path });
    assert.deepEqual(context.weights, {});
  } finally {
    cleanup();
  }
});

test("Weight-agnosticism: top-level `weights:` map → unknown top-level key → fallback", () => {
  const yaml = `schema: "1.0"
weights:
  essence: 2
presets:
  default:
    axes:
      - id: "essence"
        labels:
          en: "E"
        question: "q"
        role: "decisive"
      - id: "foundation"
        labels:
          en: "F"
        question: "q"
        role: "decisive"
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /unknown key "weights"/.test(d)));
  } finally {
    cleanup();
  }
});

// =====================
// §1.5 precedence ladder
// =====================

test("§1.5(1) explicit --preset wins outright", () => {
  const { context } = resolvePreset({ presetId: "nine-axis" });
  assert.equal(context.preset_id, "nine-axis");
  assert.equal(context.axes.length, 9);
});

test("§1.5(2) explicit --size implies preset", () => {
  // --size=major → nine-axis
  const { context: c1 } = resolvePreset({ sizeExplicit: true, sizeValue: "major" });
  assert.equal(c1.preset_id, "nine-axis");
  // --size=standard → default
  const { context: c2 } = resolvePreset({ sizeExplicit: true, sizeValue: "standard" });
  assert.equal(c2.preset_id, "default");
});

test("§1.5 precedence: --preset wins over --size implication", () => {
  const { context } = resolvePreset({ presetId: "default", sizeExplicit: true, sizeValue: "major" });
  assert.equal(context.preset_id, "default");
});

test("§1.5(4) default → default preset when no flags", () => {
  const { context } = resolvePreset({});
  assert.equal(context.preset_id, "default");
});

test("§1.5: sizeExplicit=false does NOT imply preset (only explicit fires)", () => {
  // sizeExplicit=false even with sizeValue should fall through to default.
  const { context } = resolvePreset({ sizeExplicit: false, sizeValue: "major" });
  assert.equal(context.preset_id, "default");
});

// =====================
// §5.6 ResolvedDecisionContext shape + freeze granularity (peer P-13)
// =====================

test("§5.6 context shape: PR2 fields populated, reserved slots writable", () => {
  const { context } = resolvePreset({ body: "should we use X or Y?" });
  assert.equal(context.body, "should we use X or Y?");
  assert.equal(typeof context.preset_id, "string");
  assert.ok(Array.isArray(context.axes));
  assert.equal(context.size, "standard");
  assert.equal(context.size_explicit, false);
  assert.deepEqual(context.weights, {});
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(context.resolved_at));
});

test("§5.6 freeze granularity: axes frozen; size/weights writable (PR3/PR4 ownership)", () => {
  const { context } = resolvePreset({});
  // axes array is frozen
  assert.equal(Object.isFrozen(context.axes), true);
  assert.throws(() => context.axes.push({}), /Cannot add property|not extensible/);
  // each axis descriptor is frozen
  assert.equal(Object.isFrozen(context.axes[0]), true);
  assert.throws(() => { context.axes[0].id = "tampered"; }, /Cannot assign to read only|read.only/);
  // labels are frozen
  assert.equal(Object.isFrozen(context.axes[0].labels), true);
  // size + size_explicit + weights are WRITABLE — PR3/PR4 populate later
  context.size = "minor"; assert.equal(context.size, "minor");
  context.size_explicit = true; assert.equal(context.size_explicit, true);
  context.weights = { essence: 2 }; assert.deepEqual(context.weights, { essence: 2 });
});

// =====================
// CLI surface (peer P-19) — stdout JSON-only, stderr diagnostics
// =====================

test("CLI: resolve → stdout is valid JSON; stderr empty on happy path", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "default");
  assert.equal(parsed.axes.length, 5);
});

test("CLI: resolve --preset=nine-axis → 9 axes", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--preset=nine-axis"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "nine-axis");
  assert.equal(parsed.axes.length, 9);
});

test("CLI: unknown preset → stdout still valid JSON; stderr carries diagnostic", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--preset=nonexistent"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes("unknown preset id"));
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "default");
});

// =====================
// Module-relative path (peer P-20) — works when launched outside repo root
// =====================

test("loadRegistry: default path resolves via module-relative URL (works regardless of cwd)", () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpdir()); // outside repo
    const { registry, fallbackTriggered } = loadRegistry();
    assert.equal(fallbackTriggered, false);
    assert.equal(registry.schema, "1.0");
  } finally {
    process.chdir(originalCwd);
  }
});

// =====================
// Regression cases from critique findings (peer SUGGESTION rows + the 6 MAJOR fixes)
// =====================

test("regression (peer M3): --preset=constructor does NOT resolve via Object.prototype.constructor", () => {
  // Without Object.hasOwn guard, registry.presets["constructor"] returns
  // Object.prototype.constructor (a function), which is truthy and would
  // skip the unknown-preset fallback.
  const { context, fallbackTriggered, diagnostics } = resolvePreset({ presetId: "constructor" });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "default");
  assert.ok(diagnostics.some((d) => /unknown preset id "constructor"/.test(d)));
});

test('regression (peer M3): --preset=toString does NOT resolve via Object.prototype.toString', () => {
  const { context, fallbackTriggered } = resolvePreset({ presetId: "toString" });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "default");
});

test("regression (peer M4): top-level __proto__: key in YAML is rejected at parse-time", () => {
  const yaml = `schema: "1.0"
__proto__:
  pollution: "attempted"
presets:
  default:
    axes: []
`;
  const { path, cleanup } = tmpYaml(yaml);
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    // Parser rejects with reserved-key error → routed to "YAML parse failed".
    assert.ok(diagnostics.some((d) => /YAML parse failed.*reserved map key/.test(d)),
      `expected reserved-key diagnostic; got: ${diagnostics.join(" | ")}`);
  } finally {
    cleanup();
  }
});

test("regression (peer M5): CLI --size=bogus halts with exit 2 (§2.3(4))", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--size=bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(/--size=bogus not in/.test(r.stderr),
    `expected --size whitelist error; got: ${r.stderr}`);
});

test("regression (peer M5): CLI unknown flag halts with exit 2", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--bogus=value"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(/unknown flag|unrecognized flag/.test(r.stderr));
});

test("regression (peer M2): body propagates through CLI -- separator into context.body", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--preset=default", "--", "should", "we", "use", "X?"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.body, "should we use X?");
  assert.equal(ctx.preset_id, "default");
});

test("regression: --preset= with empty value falls back to default (graceful)", () => {
  // --preset= is the literal flag with empty value. parseArgs treats it
  // as a valid flag with value=""; the reader then sees presetId === ""
  // which is falsy and falls through to the default ladder.
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--preset="], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "default");
});
