// S9 completion-output contract — cross-persona template conformance +
// doc ↔ code lockstep (plugins/runtime/docs/completion-output-contract.md §5.3/§5.4).
//
// Pins:
//   1. Every `- selected_next:` block across the four personas' commands and
//      skills carries the six canonical field keys in canonical order
//      (structure is shared; placeholder text / persona gates are free slots).
//   2. Per-persona site floors — the template cannot silently disappear from a
//      persona's completion surfaces.
//   3. No surrounding-prose re-enumeration of the field list (3+ field tokens
//      on one line outside a block) in commands/skills — the enumeration drift
//      vector the single shared template removes.
//   4. The contract document itself stays in lockstep with the canonical key
//      order, the footer's completion-state enum, the provenance vocabulary,
//      and the generic-fallback marker string.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CONTRACT_DOC = join(REPO_ROOT, 'plugins/runtime/docs/completion-output-contract.md');
const FOOTER_SCRIPT = join(REPO_ROOT, 'plugins/runtime/scripts/footer.mjs');

const FIELD_KEYS = [
  'selected_next',
  'rejected_alternatives',
  'rationale',
  'evidence_pointers',
  'confidence',
  'next_command',
];

// Site floors (ratchet): observed conformant-block counts at contract time.
// Raising is free; a drop below the floor means a completion surface lost its
// template and must be deliberate (update the contract doc + this floor).
const PERSONA_FLOORS = {
  engineer: 18,
  founder: 12,
  designer: 12,
  orchestrator: 7,
};

// Required-surface manifest: each named surface file MUST exist and carry at
// least one conformant six-field block. Aggregate floors alone would let one
// required surface silently drop once counts rise elsewhere (peer finding).
const PERSONA_REQUIRED_SURFACES = {
  engineer: ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'],
  founder: ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'],
  designer: ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'],
  orchestrator: ['plan', 'next', 'done'],
};

function requiredSurfaceFiles(persona) {
  return PERSONA_REQUIRED_SURFACES[persona].flatMap((verb) => [
    join(REPO_ROOT, 'plugins', persona, 'commands', `${verb}.md`),
    join(REPO_ROOT, 'plugins', persona, 'skills', verb, 'SKILL.md'),
  ]);
}

async function listMarkdownFiles(persona) {
  const files = [];
  const commandsDir = join(REPO_ROOT, 'plugins', persona, 'commands');
  const skillsDir = join(REPO_ROOT, 'plugins', persona, 'skills');
  try {
    for (const entry of await readdir(commandsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(commandsDir, entry.name));
    }
  } catch {
    /* persona without commands */
  }
  try {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      try {
        await readFile(skillFile, 'utf8');
        files.push(skillFile);
      } catch {
        /* skill without SKILL.md */
      }
    }
  } catch {
    /* persona without skills */
  }
  return files;
}

// Validate every `- selected_next:` anchor: the five remaining keys must
// follow on the immediately subsequent lines, in canonical order. Returns the
// conformant-site count and pushes violations; also returns the set of line
// indices occupied by conformant blocks (for the prose re-enumeration rule).
function validateBlocks(content, file, violations) {
  const lines = content.split('\n');
  const blockLines = new Set();
  let sites = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s*selected_next\s*:/.test(lines[i])) continue;
    let idx = i + 1;
    let conformant = true;
    for (const key of FIELD_KEYS.slice(1)) {
      const line = lines[idx] ?? '';
      if (!new RegExp(`^\\s*-\\s*${key}\\s*:`).test(line)) {
        violations.push(
          `${file}:${i + 1} — block missing/misordered '${key}' (expected at line ${idx + 1}, got: ${JSON.stringify(line.slice(0, 60))})`,
        );
        conformant = false;
        break;
      }
      idx++;
    }
    if (conformant) {
      sites++;
      for (let j = i; j < idx; j++) blockLines.add(j);
    }
  }
  return { sites, blockLines };
}

// Prose outside a conformant block that names 3+ distinct field keys within a
// 3-line window is a re-enumeration of the template (the drift vector) —
// windowed so hard-wrapped markdown prose cannot dodge the rule.
function findReenumerations(content, file, blockLines, violations) {
  const lines = content.split('\n');
  const flagged = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (blockLines.has(i)) continue;
    const window = [];
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (!blockLines.has(j)) window.push(lines[j]);
    }
    const text = window.join('\n');
    const distinct = FIELD_KEYS.filter((key) => new RegExp(`\\b${key}\\b`).test(text));
    if (distinct.length >= 3 && !flagged.has(i)) {
      violations.push(
        `${file}:${i + 1} — prose re-enumeration of ${distinct.length} template fields (${distinct.join(', ')}); point at the template block / contract section instead`,
      );
      // Skip ahead past this window so one enumeration reports once.
      for (let j = i; j < i + 3; j++) flagged.add(j);
      i += 2;
    }
  }
}

describe('completion-output contract — cross-persona template conformance', () => {
  for (const [persona, floor] of Object.entries(PERSONA_FLOORS)) {
    it(`${persona}: every six-field block is canonical and the site floor holds`, async () => {
      const files = await listMarkdownFiles(persona);
      ok(files.length > 0, `no markdown surfaces found for ${persona}`);
      const violations = [];
      let totalSites = 0;
      const sitesByFile = new Map();
      for (const file of files) {
        const content = await readFile(file, 'utf8');
        const rel = relative(REPO_ROOT, file);
        const { sites, blockLines } = validateBlocks(content, rel, violations);
        totalSites += sites;
        sitesByFile.set(file, sites);
        findReenumerations(content, rel, blockLines, violations);
      }
      // Required-surface manifest: every named surface must exist and carry a
      // conformant block (not just contribute to the aggregate).
      for (const required of requiredSurfaceFiles(persona)) {
        const rel = relative(REPO_ROOT, required);
        if (!sitesByFile.has(required)) {
          violations.push(`${rel} — required completion surface is missing`);
        } else if ((sitesByFile.get(required) ?? 0) < 1) {
          violations.push(`${rel} — required completion surface has no conformant six-field block`);
        }
      }
      strictEqual(
        violations.length,
        0,
        `template conformance violations:\n${violations.join('\n')}`,
      );
      ok(
        totalSites >= floor,
        `${persona} has ${totalSites} conformant six-field blocks; floor is ${floor} — a completion surface lost its template`,
      );
    });
  }

  it('the contract document carries the canonical template block in key order', async () => {
    const doc = await readFile(CONTRACT_DOC, 'utf8');
    const violations = [];
    const { sites } = validateBlocks(doc, 'completion-output-contract.md', violations);
    strictEqual(violations.length, 0, violations.join('\n'));
    ok(sites >= 1, 'the contract doc must define the canonical template block');
    // Canonical order stated in one place — the doc's key list matches the
    // test's (this test file mirrors the doc; both must move together).
    let cursor = -1;
    for (const key of FIELD_KEYS) {
      const at = doc.indexOf(`- ${key}:`);
      ok(at > cursor, `contract doc lists '${key}' out of canonical order`);
      cursor = at;
    }
  });

  it('doc ↔ code lockstep: completion states, provenance vocabulary, marker string', async () => {
    const doc = await readFile(CONTRACT_DOC, 'utf8');
    const footerSource = await readFile(FOOTER_SCRIPT, 'utf8');

    // Completion-state enum from footer.mjs source (VALID_COMPLETION_STATES).
    const enumMatch = footerSource.match(/VALID_COMPLETION_STATES = new Set\(\[([^\]]+)\]/);
    ok(enumMatch, 'footer.mjs must declare VALID_COMPLETION_STATES');
    const states = [...enumMatch[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    strictEqual(states.length, 6, 'completion-state enum size changed — update the contract doc');
    for (const state of states) {
      ok(doc.includes(state), `contract doc must mention completion state '${state}'`);
    }

    // Provenance vocabulary + marker string in both doc and renderer.
    for (const tier of ['explicit', 'derived', 'generic']) {
      ok(doc.includes(tier), `contract doc must document the '${tier}' provenance tier`);
    }
    ok(doc.includes('[generic fallback]'), 'contract doc must name the generic-fallback marker');
    ok(
      footerSource.includes("' [generic fallback]'"),
      'footer.mjs renderer must use the documented marker string',
    );
    ok(
      footerSource.includes('completion.sources') || footerSource.includes('sources:'),
      'footer.mjs must emit per-field completion sources',
    );
  });
});
