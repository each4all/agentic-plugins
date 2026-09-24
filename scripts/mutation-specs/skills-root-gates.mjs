// Mutation spec — the four cross-package gates that resolve a plugin's skills
// root from its Codex manifest instead of spelling `skills`.
//
// Run: node scripts/mutation-harness.mjs scripts/mutation-specs/skills-root-gates.mjs
//
// Three families, each answering a different question:
//
//   A — BOGUS ROOT. A manifest pointing somewhere wrong must make every gate
//       that reads it FAIL.
//   B — REAL RELOCATION. A plugin actually moved to `core/skills` must make the
//       gates PASS, and a defect planted INSIDE the moved root must be
//       reported. Since S1-S6 landed, `relocate()` finds both of its plugins
//       already moved and changes nothing, so a B run sees the released
//       layout: every skill-bearing plugin under `core/skills`, and only the
//       skill-less `attention` and `companions` at the conventional root. The
//       family therefore no longer puts a skill-bearing plugin at the
//       conventional root.
//   C — VALUE. The same relocation against each gate's PRE-REWRITE version.
//       Without C, B only shows the new code is self-consistent with itself.
//
// WHAT C MEASURED, and why it is the part worth keeping. Three of the four
// gates fail LOUDLY on a partial move — T5 with its own `discovered only 3
// shared references` signature, T2 with a missing required surface, T4 with an
// unreadable path. `test-host-tool-dependency-contract.mjs` does not: C3a and
// C3c show its pre-rewrite sweep PASSING on a relocated engineer while a
// `TodoWrite` planted in the moved tree goes unseen, and C3b catches that same
// defect on that same tree. The cause is not an oversight in the old sweep but
// the tombstone `skills/` directory that ADR-0006's Amendment REQUIRES: it is
// itself enough to keep `readdir` happy, so the sweep walks a directory with no
// skills in it and reports nothing. That gate's partial-move failure mode was a
// vacuous pass, and only a paired control shows it.
//
// The C baseline is pinned by FULL sha, never by a branch name and never by a
// short sha (which cannot be widened back). Two properties are needed, and the
// second is easy to miss: the commit must predate the rewrite, AND it must be
// reachable from `main`.
//
// The first pin chosen here satisfied only the former. `062f619` was the tip of
// the branch that introduced this spec, and the squash merge that landed it
// left that commit on no branch but the merged one — measured after the fact:
// in a fresh clone it was reachable from exactly one ref,
// `origin/refactor/skills-core-prep`. Deleting a merged branch is routine
// cleanup, and it would have taken family C with it.
//
// `a204201` is `main`'s tip immediately before that merge, so it is permanent
// history, and the four gate files are byte-identical there to what the
// original pin named (compared by blob sha, not by inspection). Re-pinning
// changes nothing about what C measures.
//
// A shallow clone still cannot run family C; the harness says so rather than
// scoring it.
//
// Recorded result at authoring time (2026-09-19): 17/17 as-expected.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const G2 = 'tests/plugin-shape/test-completion-output-contract.mjs';
const G3 = 'tests/plugin-shape/test-host-tool-dependency-contract.mjs';
const G4 = 'tests/plugin-shape/test-checkpoint-reinjection-contract.mjs';
const G5 = 'tests/scripts/test-set-terminal-archive-timing.mjs';

/** Newest commit ON MAIN at which all four gates still hardcoded the segment. */
const PRE_REWRITE = 'a204201956a0b0a963fe3bab59d0bad9b6c440d4';

export const TESTS = [G2, G3, G4, G5];

function repoint(tools, copy, plugin, value) {
  const file = `plugins/${plugin}/.codex-plugin/plugin.json`;
  const manifest = tools.readJson(copy, file);
  manifest.skills = value;
  tools.writeJson(copy, file, manifest);
}

/**
 * Put a plugin in the post-relocation shape: skills under `core/skills`, the
 * manifest declaring it, and a README tombstone at the conventional path (whose
 * absence re-enables plugin-root SKILL.md discovery — measured, and enforced by
 * kit/lint).
 *
 * Idempotent on purpose: since S1-S6 landed, the plugin is ALREADY relocated
 * in the tree, and this spec has to keep running rather than failing on a
 * move it cannot repeat.
 */
function relocate(tools, copy, plugin) {
  const dir = join(copy, 'plugins', plugin);
  const target = join(dir, 'core', 'skills');
  if (!existsSync(target)) {
    mkdirSync(join(dir, 'core'), { recursive: true });
    renameSync(join(dir, 'skills'), target);
  }
  mkdirSync(join(dir, 'skills'), { recursive: true });
  const tombstone = join(dir, 'skills', 'README.md');
  if (!existsSync(tombstone)) {
    writeFileSync(
      tombstone,
      '# Relocated\n\nSee the ADR-0006 2026-09-18 Amendment. No SKILL.md, no symlink.\n',
      'utf8',
    );
  }
  repoint(tools, copy, plugin, './core/skills/');
}

/** Name a withdrawn host tool inside a plugin's MOVED skills tree. */
function plantWithdrawnTool(tools, copy, plugin) {
  tools.applyEdit(copy, {
    file: `plugins/${plugin}/core/skills/compose/SKILL.md`,
    from: '# Compose (engineer persona)',
    to: '# Compose (engineer persona)\n\nUse `TodoWrite` to track progress.',
  });
}

export const MUTATIONS = [
  // ---- A. bogus root ------------------------------------------------------
  {
    id: 'A1', tests: TESTS,
    prepare: (c, t) => repoint(t, c, 'engineer', './core/skills-nonexistent/'),
    why: 'engineer declares a root that does not exist — every gate reading it must fail',
  },
  {
    id: 'A2', tests: [G2, G3, G4],
    prepare: (c, t) => repoint(t, c, 'engineer', './commands/'),
    why: 'engineer declares a real directory holding no skills',
  },
  {
    id: 'A3', tests: [G5],
    prepare: (c, t) => repoint(t, c, 'orchestrator', './commands/'),
    why: 'orchestrator declares a real directory holding no skills',
  },
  {
    id: 'A4', tests: TESTS,
    prepare: (c, t) => repoint(t, c, 'designer', '../engineer/skills/'),
    why: 'designer declares a root outside its own plugin',
  },

  // ---- B. real relocation: the gates must FOLLOW the move -----------------
  {
    id: 'B1', tests: TESTS, expect: 'SURVIVED',
    prepare: (c, t) => { relocate(t, c, 'orchestrator'); relocate(t, c, 'engineer'); },
    why: 'orchestrator + engineer relocated (the released layout) — all four gates must still pass',
  },
  {
    id: 'B2', tests: [G5],
    prepare: (c, t) => {
      relocate(t, c, 'orchestrator');
      t.applyEdit(c, {
        file: 'plugins/orchestrator/core/skills/next/SKILL.md',
        from: 'ARCHIVE TIMING',
        to: 'ARCHIVE TIMINK',
      });
    },
    why: 'T5 site 1 (pinned implicit-terminal paths) — defect in the MOVED file must be reported',
  },
  {
    id: 'B3', tests: [G5],
    prepare: (c, t) => {
      relocate(t, c, 'orchestrator');
      t.applyEdit(c, {
        file: 'plugins/orchestrator/core/skills/abort/SKILL.md',
        from: 'EVERY turn end',
        to: 'a later, deliberate close',
      });
    },
    why: 'T5 site 2 (runbook walk) — a set-terminal annotation under the MOVED root losing a fact',
  },
  {
    id: 'B4', tests: [G5],
    prepare: (c, t) => {
      relocate(t, c, 'orchestrator');
      t.applyEdit(c, {
        file: 'plugins/orchestrator/core/skills/_shared/references/session-handoff.md',
        from: '## Archive timing',
        to: '## Timing notes',
      });
    },
    why: 'T5 site 3 (shared references) — the canonical section gone from the MOVED copy',
  },
  {
    id: 'B5', tests: [G2],
    prepare: (c, t) => {
      relocate(t, c, 'engineer');
      t.applyEdit(c, {
        file: 'plugins/engineer/core/skills/compose/SKILL.md',
        from: '- selected_next:',
        to: '- selected_nexx:',
      });
    },
    why: 'T2 — a required completion surface under the MOVED root losing its template block',
  },
  {
    id: 'B6', tests: [G3],
    prepare: (c, t) => { relocate(t, c, 'engineer'); plantWithdrawnTool(t, c, 'engineer'); },
    why: 'T3 — a withdrawn host tool named inside the MOVED tree',
  },
  {
    id: 'B7', tests: [G4],
    prepare: (c, t) => {
      relocate(t, c, 'engineer');
      t.applyEdit(c, {
        file: 'plugins/engineer/core/skills/checkpoint/agents/openai.yaml',
        from: 'post-compact',
        to: 'next session',
      });
    },
    why: 'T4 — packaged interface metadata under the MOVED root losing the post-compact scope',
  },

  // ---- C. value: what the pre-rewrite gate did on the same tree -----------
  {
    id: 'C1', tests: [G5],
    prepare: (c, t) => { relocate(t, c, 'orchestrator'); t.fileAt(c, PRE_REWRITE, G5); },
    why: 'pre-rewrite T5 + relocated orchestrator — shared-reference coverage falls below its floor',
  },
  {
    id: 'C2', tests: [G2],
    prepare: (c, t) => { relocate(t, c, 'engineer'); t.fileAt(c, PRE_REWRITE, G2); },
    why: 'pre-rewrite T2 + relocated engineer — fails loudly on the missing required surface',
  },
  {
    id: 'C3a', tests: [G3], expect: 'SURVIVED',
    prepare: (c, t) => {
      relocate(t, c, 'engineer');
      plantWithdrawnTool(t, c, 'engineer');
      t.fileAt(c, PRE_REWRITE, G3);
    },
    why: 'pre-rewrite T3 + relocated engineer + a planted TodoWrite in the MOVED tree — blind, passes',
  },
  {
    id: 'C3b', tests: [G3],
    prepare: (c, t) => { relocate(t, c, 'engineer'); plantWithdrawnTool(t, c, 'engineer'); },
    why: 'SAME tree, SAME defect, rewritten T3 — must catch what C3a missed',
  },
  {
    id: 'C3c', tests: [G3], expect: 'SURVIVED',
    prepare: (c, t) => { relocate(t, c, 'engineer'); t.fileAt(c, PRE_REWRITE, G3); },
    why: 'pre-rewrite T3 + relocated engineer, no planted defect — passes while checking nothing',
  },
  {
    id: 'C4', tests: [G4],
    prepare: (c, t) => { relocate(t, c, 'engineer'); t.fileAt(c, PRE_REWRITE, G4); },
    why: 'pre-rewrite T4 + relocated engineer — fails loudly on the unreadable path',
  },
];
