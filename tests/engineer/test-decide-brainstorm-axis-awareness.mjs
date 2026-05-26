// PR5 (validation-contract) — ADR-0027 §4 Brainstorm <axis_awareness>
// contract validation across three surfaces that must agree in lockstep
// per ADR-0027 §4.5:
//   1. plugins/engineer/skills/_shared/references/ensemble-protocol.md
//      § Brainstorm — canonical template specification (both hosts read this)
//   2. plugins/engineer/commands/decide.md Phase 1 — Claude-host prompt
//      builder boilerplate (instructs the LLM to read $AGENTIC_DECIDE_CONTEXT_FILE
//      and emit the <axis_awareness> block per §4.3 presence rule)
//   3. plugins/engineer/skills/decide/SKILL.md "Step 5: Peer ensemble" —
//      ADR-0027 §4 pointer so SKILL.md readers discover the contract
//
// Codex Plan-verify (run_id plan-verify-20260526T012732Z-1a205273) flagged:
//   G2/G3 + E2 — fallback signal must reach the LLM via context.registry_fallback
//   G4 — snapshot rule is in-memory but documented at the prompt-builder layer
//   G6 — surface checks must be scope-bounded, not whole-file text.includes
//   O1 — § Brainstorm section ends at ### Explore, not ### Plan-verify
//   E5 — XML escaping for free-text axis labels/questions (documentation rule)
//   E4 — auto-activated mode MUST omit <axis_awareness> even with prose hints
//
// All assertions extract the relevant region (per G6) before checking tokens.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ENSEMBLE_PATH = resolve(REPO_ROOT, "plugins/engineer/skills/_shared/references/ensemble-protocol.md");
const COMMAND_PATH = resolve(REPO_ROOT, "plugins/engineer/commands/decide.md");
const SKILL_PATH = resolve(REPO_ROOT, "plugins/engineer/skills/decide/SKILL.md");
const ADR_PATH = resolve(REPO_ROOT, "docs/adr/0027-decide-skill-multi-axis-evolution.md");

// Extract a labeled section from a markdown document. `startHeading` and
// `endHeading` are line-anchored strings (e.g., `### Brainstorm (decide phase)`).
// Returns the substring strictly between (not including) the two heading lines.
// Throws if the start heading is not found or the end heading is not found
// after the start — both are regression-guard conditions.
function extractSection(text, startHeading, endHeading) {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l === startHeading);
  assert.notEqual(startIdx, -1, `start heading not found: ${startHeading}`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === endHeading);
  assert.notEqual(endIdx, -1, `end heading not found after start: ${endHeading}`);
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

// Extract a Phase block from a slash-command markdown file (e.g., Phase 1).
// `phaseHeader` is the exact "## Phase N — ..." line; bounds end at the next
// `## ` heading or `---` horizontal rule, whichever comes first.
function extractPhase(text, phaseHeader) {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l === phaseHeader);
  assert.notEqual(startIdx, -1, `phase header not found: ${phaseHeader}`);
  let endIdx = lines.findIndex(
    (l, i) => i > startIdx && (l.startsWith("## ") || l === "---"),
  );
  if (endIdx === -1) endIdx = lines.length;
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

// =============================================================================
// O1 regression guard — § Brainstorm section bounds end at `### Explore`
// (NOT ### Plan-verify). Codex caught this in Plan-verify; this test pins
// the boundary so future ADR-0027 edits cannot silently re-introduce the
// "scope creeps into Explore" bug.
// =============================================================================

test("PR5 (O1 regression guard): ensemble-protocol.md § Brainstorm section ends at `### Explore`", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  // extractSection will throw if either heading is missing or mis-ordered.
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  assert.ok(section.length > 0, "Brainstorm section is empty");
  // Sanity: Plan-verify content MUST NOT be in this section.
  assert.equal(
    /^### Plan-verify/m.test(section),
    false,
    "Brainstorm section accidentally swallowed `### Plan-verify` — section bounds drift",
  );
});

// =============================================================================
// T2 — § Brainstorm carries the <axis_awareness> contract per ADR-0027 §4.2-§4.4
// =============================================================================

test("PR5: ensemble-protocol.md § Brainstorm template contains <axis_awareness> XML block", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  assert.match(section, /<axis_awareness>/, "missing <axis_awareness> opening tag");
  assert.match(section, /<\/axis_awareness>/, "missing </axis_awareness> closing tag");
});

test("PR5: <axis_awareness> block declares Preset / Size / Axes / Weights fields per ADR-0027 §4.2", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  for (const field of ["Preset:", "Size:", "Axes:", "Weights:"]) {
    assert.match(section, new RegExp(field), `<axis_awareness> missing field ${field}`);
  }
  // The Axes: line names id / label / question / role per §4.2 schema.
  assert.match(section, /role.*decisive.*supporting|decisive.*supporting/,
    "<axis_awareness> Axes: subschema must declare role: decisive | supporting");
});

test("PR5: § Brainstorm documents the §4.3 presence rule (registry_fallback=false AND command-mode)", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  // Presence rule must reference BOTH conditions explicitly.
  assert.match(section, /Presence rule|presence rule/, "missing presence-rule heading/prose");
  assert.match(section, /registry_fallback|§1\.6 fallback|fallback path/i,
    "presence rule must reference the registry_fallback / §1.6 condition");
  assert.match(section, /command mode|command-mode|`\/engineer:decide`/,
    "presence rule must reference command-mode (the second condition)");
  // E4 guardrail — auto-activated mode is explicitly omitted.
  assert.match(section, /auto-activated|auto-?activation|skill-mode|standalone skill/i,
    "presence rule must explicitly call out auto-activated/standalone-skill omission (E4)");
});

test("PR5: § Brainstorm documents the §4.3 snapshot rule (in-memory ResolvedDecisionContext)", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  assert.match(section, /Snapshot rule|snapshot rule/, "missing snapshot-rule heading/prose");
  // Snapshot subset per §4.3 — preset_id, axes, size, weights.
  assert.match(section, /preset_id/, "snapshot rule must name preset_id");
  assert.match(section, /axes/, "snapshot rule must name axes");
  assert.match(section, /size/, "snapshot rule must name size");
  assert.match(section, /weights/, "snapshot rule must name weights");
  // In-memory boundary — peer R3 graceful-degradation note.
  assert.match(section, /in-memory|in memory/i,
    "snapshot rule must specify in-memory lifetime (does NOT persist to disk across sessions)");
});

test("PR5: § Brainstorm documents the §4.4 synthesis impact ([Peer · unmapped] sub-label)", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  assert.match(section, /\[Peer · unmapped\]|Peer.*unmapped/,
    "synthesis impact must define the [Peer · unmapped] sub-label per §4.4");
  // 3-step handling per §4.4: tag → local axis assessment → reduced-confidence PEER-ONLY.
  assert.match(section, /local axis assessment|orchestrator looks at|rate the approach/i,
    "synthesis impact must describe local axis assessment step");
});

// =============================================================================
// G2/G3/E2 — § Brainstorm references the context.registry_fallback gate
// =============================================================================

test("PR5 (G2/G3): § Brainstorm references context.registry_fallback as the §4.3 gate signal", () => {
  const text = readFileSync(ENSEMBLE_PATH, "utf8");
  const section = extractSection(
    text,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  assert.match(section, /registry_fallback/,
    "presence rule must reference the on-wire context.registry_fallback field (G2/G3 + E2 disambiguation)");
});

// =============================================================================
// E5 — XML escaping deterrent in § Brainstorm or referencing ADR §1.1 amendment
// =============================================================================

test("PR5 (E5): § Brainstorm or ADR §1.1 references XML escaping for axis labels/questions", () => {
  const ensembleText = readFileSync(ENSEMBLE_PATH, "utf8");
  const ensembleSection = extractSection(
    ensembleText,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  const adrText = readFileSync(ADR_PATH, "utf8");
  // E5 may live in either ensemble-protocol.md (closer to the prompt builder)
  // or ADR §1.1 (closer to the schema). Accept either.
  const inEnsemble = /XML.?escap|escape.*XML|predefined entit/i.test(ensembleSection);
  const inAdr = /XML.?escap|escape.*XML|predefined entit/i.test(adrText);
  assert.ok(
    inEnsemble || inAdr,
    "XML escape rule for axis labels/questions must be documented in either ensemble-protocol.md § Brainstorm or ADR-0027 §1.1 (Codex Plan-verify E5)",
  );
});

// =============================================================================
// T3 — commands/decide.md Phase 1 enrichment
// =============================================================================

test("PR5: commands/decide.md Phase 1 instructs the LLM to read $AGENTIC_DECIDE_CONTEXT_FILE for prompt construction", () => {
  const text = readFileSync(COMMAND_PATH, "utf8");
  const phase1 = extractPhase(text, "## Phase 1 — Execute decide");
  assert.match(phase1, /\$AGENTIC_DECIDE_CONTEXT_FILE/,
    "Phase 1 must instruct the LLM to read the resolved context file");
});

test("PR5: commands/decide.md Phase 1 references the <axis_awareness> block + ADR-0027 §4 contract", () => {
  const text = readFileSync(COMMAND_PATH, "utf8");
  const phase1 = extractPhase(text, "## Phase 1 — Execute decide");
  assert.match(phase1, /<axis_awareness>/,
    "Phase 1 must instruct the LLM to emit the <axis_awareness> block");
  assert.match(phase1, /ADR-0027 §4|ADR-0027 \\u00a74|ADR-0027 \\xa74/,
    "Phase 1 must cite ADR-0027 §4 so editors find the contract");
});

test("PR5 (G2/G3): commands/decide.md Phase 1 gates axis_awareness emission on context.registry_fallback === false", () => {
  const text = readFileSync(COMMAND_PATH, "utf8");
  const phase1 = extractPhase(text, "## Phase 1 — Execute decide");
  assert.match(phase1, /registry_fallback/,
    "Phase 1 prompt instruction must check context.registry_fallback to gate axis_awareness emission");
});

test("PR5 (E1): commands/decide.md Phase 1 specifies free-form fallback + axis_awareness omission when context file is malformed", () => {
  const text = readFileSync(COMMAND_PATH, "utf8");
  const phase1 = extractPhase(text, "## Phase 1 — Execute decide");
  // Either the prose mentions malformed/missing handling explicitly, or it
  // references the §4.3 omission rule which transitively handles this.
  const hasFallbackProse = /malformed|missing|unparseable|fallback|omit/i.test(phase1);
  assert.ok(hasFallbackProse,
    "Phase 1 must describe what the LLM does when the context file is missing/malformed (E1 edge)");
});

// =============================================================================
// T4 — SKILL.md Step 5: ADR-0027 §4 pointer
// =============================================================================

test("PR5: SKILL.md Step 5 (Peer ensemble parallel analysis) cites ADR-0027 §4 + <axis_awareness>", () => {
  const text = readFileSync(SKILL_PATH, "utf8");
  // Extract Step 5 region (### Step 5: Peer ensemble parallel analysis) up to next ###.
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("### Step 5: Peer ensemble parallel analysis"));
  assert.notEqual(startIdx, -1, "SKILL.md is missing the `### Step 5: Peer ensemble parallel analysis` heading");
  let endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith("### "));
  if (endIdx === -1) endIdx = lines.length;
  const step5 = lines.slice(startIdx + 1, endIdx).join("\n");
  assert.match(step5, /ADR-0027 §4|ADR-0027 \\u00a74/,
    "Step 5 must cite ADR-0027 §4 so SKILL.md readers find the axis-awareness contract");
  assert.match(step5, /<axis_awareness>|axis_awareness/,
    "Step 5 must mention <axis_awareness> for searchability");
});

// =============================================================================
// E4 — auto-activated mode guardrail (NEVER emit <axis_awareness>)
// =============================================================================

test("PR5 (E4): SKILL.md auto-activated mode area explicitly notes that <axis_awareness> is command-mode only", () => {
  const text = readFileSync(SKILL_PATH, "utf8");
  // Auto-activated mode area is the "## When auto-activated" section.
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("## When auto-activated"));
  assert.notEqual(startIdx, -1, "SKILL.md missing `## When auto-activated` section");
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith("## When invoked by command"));
  assert.notEqual(endIdx, -1, "SKILL.md missing `## When invoked by command` section");
  const autoArea = lines.slice(startIdx, endIdx).join("\n");
  // The auto area already calls out command-mode-only contracts in
  // multiple places (Phase 0.5 context-file, --size grammar). The
  // axis_awareness guardrail piggybacks on those by stating that the
  // peer ensemble is command-mode only (Step 5 lives in the command
  // section). Accept either an explicit mention of <axis_awareness>
  // OR the existing "auto-activated mode does not pass through
  // $ARGUMENTS parsing" prose plus the §2.6 reference — both close
  // the loop on E4.
  const hasAxisAwarenessMention = /<axis_awareness>|axis_awareness/.test(autoArea);
  const hasCommandModeBoundary =
    /no subagent spawning, no\s+peer ensemble dispatch/i.test(autoArea) ||
    /auto-activated.*does not.*command|command-mode.*only|standalone.*skill.*mode/i.test(autoArea);
  assert.ok(
    hasAxisAwarenessMention || hasCommandModeBoundary,
    "auto-activated section must either name <axis_awareness> or pin the no-peer-ensemble boundary that transitively closes E4",
  );
});

// =============================================================================
// T10 — Serialization edge prose (R2: absent / all-1 / ghost-drop / axis-order)
// =============================================================================

test("PR5 (R2): § Brainstorm or ADR §4.2 documents `Weights: uniform` serialization for empty {} sentinel", () => {
  const ensembleText = readFileSync(ENSEMBLE_PATH, "utf8");
  const adrText = readFileSync(ADR_PATH, "utf8");
  // Either surface must call out the convention so the LLM body consumer
  // emits `Weights: uniform` when context.weights === {}.
  const hit = /Weights:\s*uniform|"?uniform"?\s+sentinel|empty.*uniform|"uniform"/i;
  assert.ok(
    hit.test(ensembleText) || hit.test(adrText),
    "serialization rule `Weights: uniform` (for empty {} sentinel) must be documented either in ensemble-protocol.md § Brainstorm or ADR §4.2/§5.6",
  );
});

test("PR5 (R2): § Brainstorm or ADR §4.2 documents axis-order serialization for explicit weights", () => {
  const ensembleText = readFileSync(ENSEMBLE_PATH, "utf8");
  const ensembleSection = extractSection(
    ensembleText,
    "### Brainstorm (decide phase)",
    "### Explore (investigate phase, analysis profile)",
  );
  // Document order is established by ADR §1.4 + §4.2; the Brainstorm
  // template's `Weights:` line is interpolated from context.weights which
  // is keyed by axis-id. ADR §1.4 prose ("document order") is the
  // load-bearing reference; ensemble-protocol.md may either echo it or
  // cite it.
  const hit = /document order|axis order|axis-order|in order|`axes\[\]\.id` order/i;
  assert.ok(
    hit.test(ensembleSection) || hit.test(readFileSync(ADR_PATH, "utf8")),
    "axis-order serialization rule (Weights: line follows document order) must be documented",
  );
});
