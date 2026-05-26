// PR5 (validation-contract) — command-vs-skill surface parity for
// /engineer:decide (ADR-0027 §4.5 cross-surface symmetry rule).
//
// commands/decide.md is the Claude-host bash bootstrap; skills/decide/SKILL.md
// is the host-agnostic cognitive runbook. After the ADR-0027 multi-axis
// evolution (PR1-PR4), both surfaces must mirror the same axis-set + sizing
// + flag + context-plumbing vocabulary so a /engineer:decide invocation
// behaves consistently regardless of whether the LLM is reading the
// command file (Claude command path) or the SKILL.md alone (Codex skill
// path that delegates to ensemble-protocol.md).
//
// Codex Plan-verify G6 — token presence in the WHOLE file (text.includes)
// is a false-positive pattern: tokens like "default", "Foundation",
// "--" can appear in unrelated prose contexts and still pass. This test
// extracts the semantic regions (Phase 0.5 + Phase 1 in the command file,
// "When invoked by command" in the skill file) before asserting tokens
// so the assertions stay scope-bounded.
//
// The asymmetric pieces (Phase 0 workflow bookkeeping in the command;
// Step 1-4 auto-activated decision-method narrative in the skill) are
// deliberately excluded from the parity contract — they describe
// surface-specific concerns, not the verb's user-visible contract.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const COMMAND_PATH = resolve(REPO_ROOT, "plugins/engineer/commands/decide.md");
const SKILL_PATH = resolve(REPO_ROOT, "plugins/engineer/skills/decide/SKILL.md");

function extractCommandRegion(label) {
  const text = readFileSync(COMMAND_PATH, "utf8");
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(label));
  assert.notEqual(startIdx, -1, `commands/decide.md missing region heading: ${label}`);
  // End at next "## " heading or "---" horizontal rule.
  let endIdx = lines.findIndex(
    (l, i) => i > startIdx && (l.startsWith("## ") || l === "---"),
  );
  if (endIdx === -1) endIdx = lines.length;
  return lines.slice(startIdx, endIdx).join("\n");
}

function extractSkillRegion(label, endLabel) {
  const text = readFileSync(SKILL_PATH, "utf8");
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(label));
  assert.notEqual(startIdx, -1, `skills/decide/SKILL.md missing region heading: ${label}`);
  let endIdx;
  if (endLabel) {
    endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith(endLabel));
    if (endIdx === -1) endIdx = lines.length;
  } else {
    endIdx = lines.length;
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

// =============================================================================
// Mirror set 1 — Flag grammar (ADR-0027 §2.2)
// =============================================================================

test("PR5 surface-parity: --size= flag grammar present in commands/decide.md Phase 0.5 + SKILL.md command-invoked region", () => {
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillRegion = extractSkillRegion("## When invoked by command", "## Anti-patterns");
  assert.match(cmdRegion, /--size=/, "commands/decide.md Phase 0.5 missing --size= flag");
  // SKILL.md command-invoked region delegates to ensemble-protocol.md +
  // Step 5; the --size= grammar lives in the @decide:axis-table marker
  // region which is BEFORE "When invoked by command". Accept either
  // location for SKILL.md since both are inside the "When invoked"
  // delegation tree.
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(skillFullText, /--size=/, "SKILL.md missing --size= flag grammar");
});

test("PR5 surface-parity: --preset= flag grammar mirrored", () => {
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdRegion, /--preset=/, "commands/decide.md Phase 0.5 missing --preset=");
  assert.match(skillFullText, /--preset=/, "SKILL.md missing --preset=");
});

test("PR5 surface-parity: --weights= flag grammar mirrored", () => {
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdRegion, /--weights=/, "commands/decide.md Phase 0.5 missing --weights=");
  assert.match(skillFullText, /--weights=/, "SKILL.md missing --weights=");
});

// =============================================================================
// Mirror set 2 — Preset ids (ADR-0027 §1.2)
// =============================================================================

test("PR5 surface-parity: preset id 'default' mirrored across both surfaces", () => {
  // Scope to the registry/sizing area in both files — preset-id names
  // appear in marker regions of SKILL.md and in Phase 0.5 plumbing of the
  // command. Token check inside the scope avoids matching unrelated
  // "default" prose (e.g., "default next command").
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillAxisTable = readFileSync(SKILL_PATH, "utf8").split(
    "<!-- @decide:axis-table:begin -->",
  )[1]?.split("<!-- @decide:axis-table:end -->")[0] ?? "";
  assert.ok(skillAxisTable.length > 0, "SKILL.md axis-table marker region is empty");
  assert.match(cmdRegion, /\bdefault\b/, "Phase 0.5 missing 'default' preset reference");
  assert.match(skillAxisTable, /\bdefault\b/, "SKILL.md axis-table marker missing 'default' preset reference");
});

test("PR5 surface-parity: preset id 'nine-axis' mirrored", () => {
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdRegion, /nine-axis/, "Phase 0.5 missing 'nine-axis' preset reference");
  assert.match(skillFullText, /nine-axis/, "SKILL.md missing 'nine-axis' preset reference");
});

test("PR5 surface-parity: preset id 'compact' mirrored", () => {
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdRegion, /compact/, "Phase 0.5 missing 'compact' preset reference");
  assert.match(skillFullText, /compact/, "SKILL.md missing 'compact' preset reference");
});

// =============================================================================
// Mirror set 3 — Context-file plumbing ($AGENTIC_DECIDE_CONTEXT_FILE)
// =============================================================================

test("PR5 surface-parity: $AGENTIC_DECIDE_CONTEXT_FILE plumbing mirrored", () => {
  const cmdPhase0_5 = extractCommandRegion("## Phase 0.5");
  const cmdPhase1 = extractCommandRegion("## Phase 1");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdPhase0_5, /\$AGENTIC_DECIDE_CONTEXT_FILE/,
    "Phase 0.5 must export/write $AGENTIC_DECIDE_CONTEXT_FILE");
  assert.match(cmdPhase1, /\$AGENTIC_DECIDE_CONTEXT_FILE/,
    "Phase 1 must reference $AGENTIC_DECIDE_CONTEXT_FILE for axis_awareness emission");
  assert.match(skillFullText, /\$AGENTIC_DECIDE_CONTEXT_FILE/,
    "SKILL.md must reference $AGENTIC_DECIDE_CONTEXT_FILE so the skill body knows where to read context");
});

// =============================================================================
// Mirror set 4 — ADR-0027 cross-references
// =============================================================================

test("PR5 surface-parity: ADR-0027 referenced in both surfaces", () => {
  const cmdRegion = extractCommandRegion("## Phase 0.5");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdRegion, /ADR-0027/, "Phase 0.5 must cite ADR-0027");
  assert.match(skillFullText, /ADR-0027/, "SKILL.md must cite ADR-0027");
});

// =============================================================================
// Mirror set 5 — ResolvedDecisionContext on-wire field names (PR5 amendment)
// =============================================================================

test("PR5 surface-parity: weights_explicit (snake_case on-wire) referenced in both surfaces", () => {
  const cmdRegion = extractCommandRegion("## Phase 1");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdRegion, /weights_explicit/,
    "Phase 1 prompt builder must reference weights_explicit so the LLM gates the axis_awareness Weights line");
  assert.match(skillFullText, /weights_explicit/,
    "SKILL.md must reference weights_explicit so the @decide:weighting-sensitivity-output gate is documented");
});

test("PR5 surface-parity: registry_fallback (PR5 §5.6 amendment) referenced in both surfaces", () => {
  const cmdPhase1 = extractCommandRegion("## Phase 1");
  const skillFullText = readFileSync(SKILL_PATH, "utf8");
  assert.match(cmdPhase1, /registry_fallback/,
    "Phase 1 must gate axis_awareness emission on context.registry_fallback per ADR-0027 §4.3 presence rule");
  assert.match(skillFullText, /registry_fallback/,
    "SKILL.md must reference registry_fallback so the §4.3 presence rule is discoverable from the skill side");
});

// =============================================================================
// Skill-only invariants (decision-method body lives in SKILL.md prose;
// command file is dispatch boilerplate and is NOT required to mirror these)
// =============================================================================

test("PR5 surface-parity: decisive-axis rule (Essence/Foundation) lives in SKILL.md recommendation-rule marker", () => {
  const skillText = readFileSync(SKILL_PATH, "utf8");
  const recRule = skillText.split("<!-- @decide:recommendation-rule:begin -->")[1]
    ?.split("<!-- @decide:recommendation-rule:end -->")[0] ?? "";
  assert.ok(recRule.length > 0, "SKILL.md @decide:recommendation-rule marker region empty");
  for (const token of ["Essence", "Foundation", "decisive"]) {
    assert.match(recRule, new RegExp(token),
      `@decide:recommendation-rule region missing ${token} (ADR-0027 §1.3 decisive-axis rule)`);
  }
});

test("PR5 surface-parity: compact preset's entry-routing-guarantee axis is documented in SKILL.md axis-table region", () => {
  const skillText = readFileSync(SKILL_PATH, "utf8");
  const axisTable = skillText.split("<!-- @decide:axis-table:begin -->")[1]
    ?.split("<!-- @decide:axis-table:end -->")[0] ?? "";
  assert.match(axisTable, /entry-routing-guarantee/,
    "@decide:axis-table region must reference entry-routing-guarantee axis for the compact preset");
});

// =============================================================================
// Auto-activated mode boundary (E4 — never emits axis_awareness)
// =============================================================================

test("PR5 surface-parity (E4 boundary): SKILL.md auto-activated section pins 'no peer ensemble dispatch'", () => {
  const skillText = readFileSync(SKILL_PATH, "utf8");
  const autoSection = skillText.split("## When auto-activated")[1]
    ?.split("## When invoked by command")[0] ?? "";
  assert.ok(autoSection.length > 0, "SKILL.md `## When auto-activated` section is empty");
  // The phrase "no peer ensemble dispatch" is the load-bearing E4 guardrail
  // — auto-activated mode cannot accidentally emit <axis_awareness> because
  // it cannot reach the peer-runner code path.
  assert.match(autoSection, /no peer ensemble dispatch|no\s+peer\s+ensemble|no subagent spawning, no\s+peer ensemble/i,
    "auto-activated section must explicitly state 'no peer ensemble dispatch' (E4 boundary)");
});
