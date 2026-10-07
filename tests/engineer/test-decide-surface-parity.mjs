// /engineer:decide — the two calls-level rules its surfaces state:
//
//   - the ResolvedDecisionContext reaches the skill body on the resolver's
//     stdout. A Bash tool call is a fresh shell, so a resolve whose output is
//     redirected into a file leaves the context at a path no later call knows
//     (ADR-0027 §4.3). Checked for every persona that ships decide.
//   - the skill's auto-activated mode dispatches no peer ensemble, so it never
//     reaches the <axis_awareness> prompt the command mode builds.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { skillsPath } from "../_helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ENGINEER_ROOT = resolve(REPO_ROOT, "plugins", "engineer");
const SKILL_PATH = skillsPath(ENGINEER_ROOT, "decide", "SKILL.md");

test("PR5 surface-parity: no persona writes the context to a file whose path a later Bash call cannot see", () => {
  for (const persona of ["engineer", "designer", "founder"]) {
    for (const rel of ["commands/decide.md", "core/skills/decide/SKILL.md"]) {
      const text = readFileSync(new URL(`../../plugins/${persona}/${rel}`, import.meta.url), "utf8");
      // Contract: the agent running decide's resolve call — output redirected
      // into a file leaves the context where the next Bash call cannot find it.
      assert.match(text, /decide-registry\.mjs" resolve/, `plugins/${persona}/${rel} runs no resolve call to check`);
      assert.doesNotMatch(text, /decide-registry\.mjs" resolve[^\n]*(\\\n[^\n]*)*>\s*"/,
        `plugins/${persona}/${rel} redirects the resolver's output into a file`);
    }
  }
});

test("PR5 surface-parity (E4 boundary): SKILL.md auto-activated section pins 'no peer ensemble dispatch'", () => {
  const skillText = readFileSync(SKILL_PATH, "utf8");
  // The section is sliced by its heading and the next one.
  const autoSection = skillText.split("## When auto-activated")[1]
    ?.split("## When invoked by command")[0] ?? "";
  assert.ok(autoSection.length > 0, "SKILL.md `## When auto-activated` section is empty");
  // Contract: the agent deciding in auto-activated mode — without this rule it
  // may launch a peer ensemble, which only the command mode records and settles.
  assert.match(autoSection, /no\s+peer\s+ensemble\s+dispatch/i,
    "auto-activated section must explicitly state 'no peer ensemble dispatch' (E4 boundary)");
});
