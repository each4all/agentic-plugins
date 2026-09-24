// Mutation spec — does anything catch a `decide-registry.mjs` DEFAULT_PATH that
// no longer points at the plugin's registry file?
//
// Run: node scripts/mutation-harness.mjs scripts/mutation-specs/decide-registry-root.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. DEFAULT_PATH is built relative to the script,
// not to the skills root, so relocating the skills tree without moving that
// constant stops finding the file — and stops silently. The CLI exits 0 and
// still prints a well-formed ResolvedDecisionContext, because a missing
// registry falls back to an in-code preset. A green suite therefore proves
// nothing on its own; only breaking the constant on purpose does.
//
// MEASURED, on a copy of each persona plugin with its skills tree removed:
//
//   plugin    with registry      without registry   plain `resolve` discriminates?
//   engineer  default / 5 axes   default / 5 axes   NO
//   designer  balanced / 7       balanced / 7       NO
//   founder   default / 6        default / 6        NO
//
// The in-code fallback MIRRORS each plugin's own file default, so a plain
// `resolve` is vacuous in all three. Asking for a preset the FILE defines and
// the fallback does not restores the signal, and every persona has one:
// engineer `--preset=nine-axis` (9 vs default/5), designer `--preset=conversion`
// (5 vs balanced/7), founder `--preset=compact` (4 vs default/6). The absence
// of the `registry:` stderr line and `registry_fallback: false` are two further
// discriminators. An earlier version of this header claimed only the stderr
// clause transferred; that came from measuring the plain `resolve` alone and a
// peer review disproved it.
//
// EXTENDED FOR S3-S6. Of the plugins those steps relocated, designer and
// founder carry a decide registry, and each has its own two mutations against
// its decide-registry.mjs (D1/D2, F1/F2); orchestrator and runtime have none.
// One leaves DEFAULT_PATH at the pre-relocation root, the other points it
// nowhere. Both must be KILLED by that plugin's own registry test, which keeps
// all three clauses with its own preset id substituted.
//
// Recorded result at authoring time (2026-09-21): 2/2 as-expected, with
// `CLI: the relocated registry is actually read` among the 23 tests E2 kills.

const T = 'tests/engineer/test-decide-registry.mjs';
const REG = 'plugins/engineer/scripts/decide-registry.mjs';
const T_DESIGNER = 'tests/designer/test-decide-registry.mjs';
const REG_DESIGNER = 'plugins/designer/scripts/decide-registry.mjs';
const T_FOUNDER = 'tests/founder/test-decide-registry.mjs';
const REG_FOUNDER = 'plugins/founder/scripts/decide-registry.mjs';

/** The post-relocation constant every mutation starts from — identical in each
 *  persona, which is why the same two mutations transfer unchanged. */
const CURRENT = 'resolve(HERE, "..", "core", "skills", "decide", "references", "decision-axes.yml")';

export const TESTS = [T];

export const MUTATIONS = [
  {
    id: 'E1', file: REG,
    from: CURRENT,
    to: 'resolve(HERE, "..", "skills", "decide", "references", "decision-axes.yml")',
    why: 'the exact relocation regression — DEFAULT_PATH left at the pre-relocation root, which is now a tombstone holding only a README',
  },
  {
    id: 'E2', file: REG,
    from: CURRENT,
    to: 'resolve(HERE, "..", "core", "skills-nope", "decide", "references", "decision-axes.yml")',
    why: 'DEFAULT_PATH points at nothing at all — the fallback must not be mistaken for a successful load',
  },

  // ---- designer (S3) ------------------------------------------------------
  // Designer is the case that proves the clause set is not over-engineered:
  // its in-code fallback mirrors its own file default, so a plain `resolve`
  // returns balanced/7 whether or not the registry was found. Only the
  // file-only preset id, its axis count, and the stderr diagnostic separate
  // them — which is exactly what its proof asserts.
  {
    id: 'D1', file: REG_DESIGNER, tests: [T_DESIGNER],
    from: CURRENT,
    to: 'resolve(HERE, "..", "skills", "decide", "references", "decision-axes.yml")',
    why: 'designer DEFAULT_PATH left at the pre-relocation root, which is now a tombstone',
  },
  {
    id: 'D2', file: REG_DESIGNER, tests: [T_DESIGNER],
    from: CURRENT,
    to: 'resolve(HERE, "..", "core", "skills-nope", "decide", "references", "decision-axes.yml")',
    why: 'designer DEFAULT_PATH points at nothing at all',
  },

  // ---- founder (S4) -------------------------------------------------------
  // Founder repeats designer's vacuity exactly: the in-code fallback is
  // preset_id "default" with 6 axes, which is also what the FILE's default
  // preset resolves to, so the two readings are identical down to the exit
  // code. `--preset=compact` (4 axes, file-only) plus the stderr and
  // `registry_fallback` clauses are what separate them. Founder's incumbent
  // `--size=minor` test already discriminates on the first two clauses, so
  // these mutations are expected to die to more than the new proof alone.
  {
    id: 'F1', file: REG_FOUNDER, tests: [T_FOUNDER],
    from: CURRENT,
    to: 'resolve(HERE, "..", "skills", "decide", "references", "decision-axes.yml")',
    why: 'founder DEFAULT_PATH left at the pre-relocation root, which is now a tombstone',
  },
  {
    id: 'F2', file: REG_FOUNDER, tests: [T_FOUNDER],
    from: CURRENT,
    to: 'resolve(HERE, "..", "core", "skills-nope", "decide", "references", "decision-axes.yml")',
    why: 'founder DEFAULT_PATH points at nothing at all',
  },
];
