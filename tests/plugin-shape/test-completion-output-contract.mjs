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
//
// Each persona's skills root is RESOLVED from that persona's own Codex manifest
// rather than spelled `skills` here. ADR-0006's 2026-09-18 Amendment moved CORE
// content under `core/`, and a relocated plugin's conventional `skills/` holds
// only a README, so a hardcoded segment is wrong in the direction that finds
// no files — which the required-surface list and the floors below then catch.
//
// The per-document rules (pins 1 and 3) live in tests/_runbook-checks.mjs, so
// they can also run over a runbook assembled in memory; this file keeps the
// corpus, the floors and the required surfaces.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';
import { COMPLETION_FIELD_KEYS, completionBlocks, completionReenumerations } from '../_runbook-checks.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const pluginDir = (persona) => join(REPO_ROOT, 'plugins', persona);
const CONTRACT_DOC = join(REPO_ROOT, 'plugins/runtime/docs/completion-output-contract.md');
const FOOTER_SCRIPT = join(REPO_ROOT, 'plugins/runtime/scripts/footer.mjs');

// Site floors (ratchet): observed conformant-block counts at contract time.
// Raising is free; a drop below the floor means a completion surface lost its
// template and must be deliberate (update the contract doc + this floor).
const PERSONA_FLOORS = {
  engineer: 20, // 18 + /engineer:commit's command and skill (ADR-0063 D3)
  founder: 12,
  designer: 12,
  orchestrator: 7,
};

// Required-surface manifest: each named surface file MUST exist and carry at
// least one conformant six-field block. Aggregate floors alone would let one
// required surface silently drop once counts rise elsewhere (peer finding).
const PERSONA_REQUIRED_SURFACES = {
  // ADR-0063 D3 — `commit`, the verb-chain commit surface, completes a
  // workflow too.
  engineer: ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine', 'commit'],
  founder: ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'],
  designer: ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'],
  orchestrator: ['plan', 'next', 'done'],
};

function requiredSurfaceFiles(persona) {
  return PERSONA_REQUIRED_SURFACES[persona].flatMap((verb) => [
    join(REPO_ROOT, 'plugins', persona, 'commands', `${verb}.md`),
    skillsPath(pluginDir(persona), verb, 'SKILL.md'),
  ]);
}

async function listMarkdownFiles(persona) {
  const files = [];
  const commandsDir = join(REPO_ROOT, 'plugins', persona, 'commands');
  // Throws a named error if the persona's declared root is missing, escapes the
  // plugin, or is not a directory — rather than handing back a path that yields
  // nothing.
  const skillsDir = resolveSkillsRoot(pluginDir(persona));
  try {
    for (const entry of await readdir(commandsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(commandsDir, entry.name));
    }
  } catch {
    /* persona without commands */
  }
  // NO catch around this readdir. The resolver has already proved the root
  // exists and is a directory, so anything that fails here is a real fault —
  // and the swallowed version turned "this persona's surfaces all vanished"
  // into a pass guarded only by floors that were measured on a populated tree.
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, 'SKILL.md');
    try {
      await readFile(skillFile, 'utf8');
      files.push(skillFile);
    } catch (err) {
      // A directory under the root that is not a skill (`_shared/`) is
      // expected. Anything other than a plain absence is not, and swallowing
      // it would drop a real surface from the sweep.
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return files;
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
        const { sites, blockLines, violations: found } = completionBlocks(content, rel);
        violations.push(...found);
        totalSites += sites;
        sitesByFile.set(file, sites);
        violations.push(...completionReenumerations(content, rel, blockLines));
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
    const { sites, violations } = completionBlocks(doc, 'completion-output-contract.md');
    strictEqual(violations.length, 0, violations.join('\n'));
    ok(sites >= 1, 'the contract doc must define the canonical template block');
    // Canonical order stated in one place — the doc's key list matches the
    // test's (the shared key list mirrors the doc; both must move together).
    let cursor = -1;
    for (const key of COMPLETION_FIELD_KEYS) {
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
