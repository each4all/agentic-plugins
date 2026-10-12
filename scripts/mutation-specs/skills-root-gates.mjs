// Mutation spec — the four cross-package gates that resolve a plugin's skills
// root from its Codex manifest instead of spelling `skills`.
//
// Run: node scripts/mutation-harness.mjs scripts/mutation-specs/skills-root-gates.mjs
//
// Three families, each answering a different question:
//
//   A — BOGUS ROOT. A manifest pointing somewhere wrong must make every gate
//       that reads it FAIL.
//   B — MIXED LAYOUT. A tree whose skill-bearing plugins declare BOTH roots
//       must make the gates PASS, and a defect planted under EITHER root must
//       be reported. The released tree has every skill-bearing plugin under
//       `core/skills` (only the skill-less `attention` and `companions` keep
//       the conventional root), so it is the control and shows nothing about
//       the conventional root. `mixed()` therefore moves `engineer` back to
//       `skills/` and leaves the rest under `core/skills`: each gate, and each
//       of T5's three sites, gets a defect at each root in that same tree,
//       `engineer` (which all four gates read) for the conventional root,
//       `orchestrator` or `designer` for `core/skills`.
//   C — VALUE. The relocated tree against each gate's PRE-REWRITE version.
//       Without C, B only shows the new code is self-consistent with itself.
//
// WHAT C MEASURED, and why it is the part worth keeping. Three of the four
// gates fail LOUDLY on a partial move — T5 with its own `discovered only 3
// shared references` signature, T2 with a missing required surface, T4 with an
// unreadable path. `test-host-tool-dependency-contract.mjs` does not: C3a and
// C3c show its pre-rewrite sweep PASSING on a relocated engineer while a
// `TodoWrite` planted in the moved tree goes unseen, and C3b catches that same
// defect on that same tree. C3d and C3e pair the gate as C3b pairs the defect:
// the same old sweep, with engineer moved back to `skills/`, catches that
// `TodoWrite` and passes without it, so C3a's pass is blindness to the move,
// not an old gate that is inert on today's tree. The cause is not an oversight in the old sweep but
// the tombstone `skills/` directory that ADR-0006's Amendment REQUIRES: it is
// itself enough to keep `readdir` happy, so the sweep walks a directory with no
// skills in it and reports nothing. That gate's partial-move failure mode was a
// vacuous pass, and only a paired control shows it.
//
// The pre-rewrite T3 also reads `plugins/runtime/docs/host-parity-baseline.md`,
// which ADR-0060 deleted. Without it that gate fails on the missing file, and
// C3a and C3c read KILLED for a reason that has nothing to do with the sweep
// (C94). `preRewriteG3()` restores the document from the same pinned commit, so
// the old gate runs as it ran then and the two SURVIVED verdicts measure the
// sweep again.
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
// Re-scored 2026-10-13, after C94, the mixed B family (C38) and the C3d/C3e
// control: 25/25 as-expected, each B kill and C3b's and C3d's by the test its
// `killed_by` names.

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { MutationHarnessError } from '../mutation-harness.mjs';

const G2 = 'tests/plugin-shape/test-completion-output-contract.mjs';
const G3 = 'tests/plugin-shape/test-host-tool-dependency-contract.mjs';
const G4 = 'tests/plugin-shape/test-checkpoint-reinjection-contract.mjs';
const G5 = 'tests/scripts/test-set-terminal-archive-timing.mjs';

/** Newest commit ON MAIN at which all four gates still hardcoded the segment. */
const PRE_REWRITE = 'a204201956a0b0a963fe3bab59d0bad9b6c440d4';

/** The document the pre-rewrite G3 reads, deleted since by ADR-0060. */
const G3_BASELINE = 'plugins/runtime/docs/host-parity-baseline.md';

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

/**
 * The reverse of `relocate()`: put a relocated plugin back in the conventional
 * shape, its skills under `skills/` (replacing the README tombstone there), no
 * `core/skills`, and the manifest declaring `./skills/`.
 */
function unrelocate(tools, copy, plugin) {
  const dir = join(copy, 'plugins', plugin);
  const moved = join(dir, 'core', 'skills');
  const conventional = join(dir, 'skills');
  if (!existsSync(moved)) {
    throw new MutationHarnessError(`plugins/${plugin}/core/skills does not exist — there is no relocation to reverse`);
  }
  const left = existsSync(conventional) ? readdirSync(conventional, { withFileTypes: true }) : [];
  if (left.some((entry) => entry.name !== 'README.md' || !entry.isFile())) {
    throw new MutationHarnessError(
      `plugins/${plugin}/skills holds more than its tombstone file (${left.map((e) => e.name).join(', ')}) — moving core/skills onto it would mix two trees`,
    );
  }
  rmSync(conventional, { recursive: true, force: true });
  renameSync(moved, conventional);
  if (readdirSync(join(dir, 'core')).length === 0) rmdirSync(join(dir, 'core'));
  repoint(tools, copy, plugin, './skills/');
}

/** Count the SKILL.md files under `dir`, at any depth. */
function countSkills(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countSkills(join(dir, entry.name));
    else if (entry.name === 'SKILL.md') n += 1;
  }
  return n;
}

/**
 * The B family's tree: `engineer` back at the conventional root, every other
 * skill-bearing plugin left under `core/skills`. Refused unless the result
 * really has plugins whose skills are at each root, declared and present — a
 * layout that drifted to one root would make every B verdict say nothing about
 * the other. A declaration is compared as a path (`./core/skills` and
 * `./core/skills/` name one root), not as a string.
 *
 * Run B1 with any other B case: a gate that cannot read one root at all fails
 * on the mixed tree before it reaches a planted defect, under the same test
 * name `killed_by` expects, and only B1's SURVIVED verdict tells the two apart.
 */
function mixed(tools, copy) {
  unrelocate(tools, copy, 'engineer');
  const skillsAt = { skills: [], 'core/skills': [] };
  for (const entry of readdirSync(join(copy, 'plugins'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const declared = tools.readJson(copy, `plugins/${entry.name}/.codex-plugin/plugin.json`).skills;
    if (typeof declared !== 'string') continue;
    const key = posix.normalize(declared).replace(/\/+$/, '');
    if (!Object.hasOwn(skillsAt, key)) continue;
    const root = join(copy, 'plugins', entry.name, key);
    if (existsSync(root) && countSkills(root) > 0) skillsAt[key].push(entry.name);
  }
  for (const [declared, plugins] of Object.entries(skillsAt)) {
    if (plugins.length === 0) {
      throw new MutationHarnessError(`the mixed layout has no plugin with skills at ${declared} — the B family would not test that root`);
    }
  }
}

/** Run the pre-rewrite G3, with the baseline document it reads (C94). */
function preRewriteG3(tools, copy) {
  mkdirSync(join(copy, G3_BASELINE, '..'), { recursive: true });
  tools.fileAt(copy, PRE_REWRITE, G3_BASELINE);
  tools.fileAt(copy, PRE_REWRITE, G3);
}

/** Name a withdrawn host tool in a persona's compose skill under `root`. */
function plantWithdrawnTool(tools, copy, plugin, root = 'core/skills') {
  tools.applyEdit(copy, {
    file: `plugins/${plugin}/${root}/compose/SKILL.md`,
    from: `# Compose (${plugin} persona)`,
    to: `# Compose (${plugin} persona)\n\nUse \`TodoWrite\` to track progress.`,
  });
}

// The tests that must catch each planted defect: a kill anywhere else (a crash
// on a layout the gate cannot read) would not show the defect was reported.
const IMPLICIT = /the implicit auto-terminal paths carry the statement too/;
const INVOCATIONS = /every set-terminal invocation states when the Stop hook evaluates the gates/;
const SHARED_REFS = /every shared reference carries the canonical archive-timing section/;
const NO_WITHDRAWN = /instructs no withdrawn host tool from any plugin command, skill, or agent prompt/;
const METADATA = /packaged interface metadata carries the scope in BOTH rendered fields/;

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

  // ---- B. mixed layout: the gates must read BOTH roots --------------------
  // engineer at `skills/`, orchestrator and designer at `core/skills`.
  {
    id: 'B1', tests: TESTS, expect: 'SURVIVED',
    prepare: (c, t) => mixed(t, c),
    why: 'engineer back at the conventional root, the rest under core/skills — all four gates must still pass',
  },
  {
    id: 'B2', tests: [G5], killed_by: IMPLICIT,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/orchestrator/core/skills/next/SKILL.md',
        from: 'ARCHIVE TIMING',
        to: 'ARCHIVE TIMINK',
      });
    },
    why: 'T5 site 1 (pinned implicit-terminal paths) — defect in a core/skills file must be reported',
  },
  {
    id: 'B3', tests: [G5], killed_by: INVOCATIONS,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/orchestrator/core/skills/abort/SKILL.md',
        from: 'EVERY turn end',
        to: 'a later, deliberate close',
      });
    },
    why: 'T5 site 2 (runbook walk) — a set-terminal annotation under core/skills losing a fact',
  },
  {
    id: 'B4', tests: [G5], killed_by: SHARED_REFS,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/orchestrator/core/skills/_shared/references/session-handoff.md',
        from: '## Archive timing',
        to: '## Timing notes',
      });
    },
    why: 'T5 site 3 (shared references) — the canonical section gone from a core/skills copy',
  },
  {
    id: 'B5', tests: [G2], killed_by: /^engineer: every six-field block is canonical/,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/engineer/skills/compose/SKILL.md',
        from: '- selected_next:',
        to: '- selected_nexx:',
      });
    },
    why: 'T2 — a required completion surface at the CONVENTIONAL root losing its template block',
  },
  {
    id: 'B6', tests: [G3], killed_by: NO_WITHDRAWN,
    prepare: (c, t) => { mixed(t, c); plantWithdrawnTool(t, c, 'engineer', 'skills'); },
    why: 'T3 — a withdrawn host tool named at the CONVENTIONAL root',
  },
  {
    id: 'B7', tests: [G4], killed_by: METADATA,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/engineer/skills/checkpoint/agents/openai.yaml',
        from: 'post-compact',
        to: 'next session',
      });
    },
    why: 'T4 — packaged interface metadata at the CONVENTIONAL root losing the post-compact scope',
  },
  {
    id: 'B8', tests: [G5], killed_by: IMPLICIT,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/engineer/skills/commit/SKILL.md',
        from: 'ARCHIVE TIMING',
        to: 'ARCHIVE TIMINK',
      });
    },
    why: 'T5 site 1 (pinned implicit-terminal paths) — defect in a file at the CONVENTIONAL root must be reported',
  },
  {
    id: 'B9', tests: [G2], killed_by: /^designer: every six-field block is canonical/,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/designer/core/skills/compose/SKILL.md',
        from: '- selected_next:',
        to: '- selected_nexx:',
      });
    },
    why: 'T2 — a required completion surface under core/skills losing its template block',
  },
  {
    id: 'B10', tests: [G3], killed_by: NO_WITHDRAWN,
    prepare: (c, t) => { mixed(t, c); plantWithdrawnTool(t, c, 'designer'); },
    why: 'T3 — a withdrawn host tool named under core/skills',
  },
  {
    id: 'B11', tests: [G4], killed_by: METADATA,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/designer/core/skills/checkpoint/agents/openai.yaml',
        from: 'post-compact',
        to: 'next session',
      });
    },
    why: 'T4 — packaged interface metadata under core/skills losing the post-compact scope',
  },
  {
    id: 'B12', tests: [G5], killed_by: INVOCATIONS,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/engineer/skills/_shared/references/autopilot-mode.md',
        from: 'EVERY turn end',
        to: 'a later, deliberate close',
      });
    },
    why: 'T5 site 2 (runbook walk) — a set-terminal annotation at the CONVENTIONAL root losing a fact',
  },
  {
    id: 'B13', tests: [G5], killed_by: SHARED_REFS,
    prepare: (c, t) => {
      mixed(t, c);
      t.applyEdit(c, {
        file: 'plugins/engineer/skills/_shared/references/session-handoff.md',
        from: '## Archive timing',
        to: '## Timing notes',
      });
    },
    why: 'T5 site 3 (shared references) — the canonical section gone from the CONVENTIONAL-root copy',
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
      preRewriteG3(t, c);
    },
    why: 'pre-rewrite T3 + relocated engineer + a planted TodoWrite in the MOVED tree — blind, passes',
  },
  {
    id: 'C3b', tests: [G3], killed_by: NO_WITHDRAWN,
    prepare: (c, t) => { relocate(t, c, 'engineer'); plantWithdrawnTool(t, c, 'engineer'); },
    why: 'SAME tree, SAME defect, rewritten T3 — must catch what C3a missed',
  },
  {
    id: 'C3c', tests: [G3], expect: 'SURVIVED',
    prepare: (c, t) => { relocate(t, c, 'engineer'); preRewriteG3(t, c); },
    why: 'pre-rewrite T3 + relocated engineer, no planted defect — passes while checking nothing',
  },
  // The positive control C3a needs: the SAME old gate on today's tree, with
  // engineer back where that gate looks. Without it, C3a's SURVIVED would fit
  // an old sweep that is inert on today's tree as well as one blind to the move.
  {
    id: 'C3d', tests: [G3], killed_by: NO_WITHDRAWN,
    prepare: (c, t) => {
      unrelocate(t, c, 'engineer');
      plantWithdrawnTool(t, c, 'engineer', 'skills');
      preRewriteG3(t, c);
    },
    why: 'pre-rewrite T3 + engineer at the CONVENTIONAL root + the same planted TodoWrite — the old sweep is live and catches it',
  },
  {
    id: 'C3e', tests: [G3], expect: 'SURVIVED',
    prepare: (c, t) => { unrelocate(t, c, 'engineer'); preRewriteG3(t, c); },
    why: 'C3d without the plant — the old gate passes, so C3d was killed by the defect, not by the setting',
  },
  {
    id: 'C4', tests: [G4],
    prepare: (c, t) => { relocate(t, c, 'engineer'); t.fileAt(c, PRE_REWRITE, G4); },
    why: 'pre-rewrite T4 + relocated engineer — fails loudly on the unreadable path',
  },
];
