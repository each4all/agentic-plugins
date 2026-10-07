// S9 completion-output contract — cross-persona template conformance
// (plugins/runtime/docs/completion-output-contract.md §5.3).
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
//
// The contract document itself is not checked: no program reads it, and
// footer.mjs's completion states, generic-fallback marker and per-field
// sources are rendered and asserted by tests/runtime/test-footer.mjs and
// tests/runtime/test-footer-completion-provenance.mjs.
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
import { completionBlocks, completionReenumerations } from '../_runbook-checks.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const pluginDir = (persona) => join(REPO_ROOT, 'plugins', persona);

// Site floors (ratchet): observed conformant-block counts at contract time.
// Raising is free; a drop below the floor means a completion surface lost its
// template and must be deliberate (lower this floor in the same change).
// Contract: the agents finishing these surfaces — the floor is how a block
// that vanished from a surface outside the required list below is noticed.
const PERSONA_FLOORS = {
  // 18 + /engineer:commit's command and skill (ADR-0063 D3), less one per
  // verb runbook that joined the persona pipeline (PC3 U7: frame, compose,
  // decide, critique, refine, investigate), whose Completion points at the phase note's
  // block instead of restating it (the pipeline's one-block-per-runbook
  // contract); the required-surface manifest below still needs a block in
  // each.
  engineer: 14,
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
        // Contract: the agent completing a verb or macro step hands off by
        // filling this six-field block — a block with a field missing or out of
        // order drops the next step, its rationale or the command to run, and a
        // prose list of the fields beside it gives the agent a second, drifting
        // field list.
        const { sites, blockLines, violations: found } = completionBlocks(content, rel);
        violations.push(...found);
        totalSites += sites;
        sitesByFile.set(file, sites);
        violations.push(...completionReenumerations(content, rel, blockLines));
      }
      // Required-surface manifest: every named surface must exist and carry a
      // conformant block (not just contribute to the aggregate).
      // Contract: the agent finishing one of these surfaces — a surface that
      // lost its block ends the run with no hand-off for the owner or the next
      // session to act on.
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
});
