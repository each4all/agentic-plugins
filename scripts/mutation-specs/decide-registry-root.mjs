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
//   plugin    with registry      without registry   value assertion discriminates?
//   engineer  default / 5 axes   default / 5 axes   NO  (on a plain `resolve`)
//   designer  balanced / 7       balanced / 7       NO
//   founder   default / 6        default / 6        NO
//
// The in-code fallback MIRRORS each plugin's own file default, so comparing
// preset_id or axis count on a plain `resolve` is vacuous in all three. Two
// discriminators survive: asking for a preset id that exists ONLY in the file
// (engineer's `nine-axis`; the fallback has no such id), and the absence of the
// `registry:` diagnostic on stderr. Only the second transfers to designer and
// founder.
//
// EXTENDING THIS FOR S3-S6. Each relocation adds its own two mutations against
// that plugin's decide-registry.mjs: one leaving DEFAULT_PATH at the
// pre-relocation root, one pointing it nowhere. Both must be KILLED by that
// plugin's own registry test, and that test has to carry the stderr clause —
// for designer and founder it is the ONLY clause that can fail.
//
// Recorded result at authoring time (2026-09-21): 2/2 as-expected, with
// `CLI: the relocated registry is actually read` among the 23 tests R2 kills.

const T = 'tests/engineer/test-decide-registry.mjs';
const REG = 'plugins/engineer/scripts/decide-registry.mjs';

/** The post-relocation constant both mutations start from. */
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
];
