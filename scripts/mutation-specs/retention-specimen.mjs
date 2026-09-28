// Mutation spec — did the retention suites survive losing their specimen family?
//
// Run: npm run mutate -- scripts/mutation-specs/retention-specimen.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. ADR-0060 removed `compat` from the retention
// registry, and compat was the family both retention suites used as their
// deletable specimen. The replacement, `settings`, is not a like-for-like swap:
// it carries a live pin of its own (a run whose terminal `settings.json` cannot
// be confirmed is kept), and that pin can make a case pass before it ever
// reaches the rule it names. Measured while migrating: three cases did exactly
// that — the capture-rename case conceded on the pin instead of the capture,
// the plan-hash key-order case compared two plans whose only differing family
// the hash no longer reads, and the byte-ceiling case kept its run because the
// run was pinned. Each mutation below removes one of those rules and names the
// case that must now fail for it.

const T_PLAN = 'tests/runtime/test-retention-planner.mjs';
const T_APPLY = 'tests/runtime/test-retention-apply.mjs';
const PLANNER = 'plugins/runtime/scripts/lib/retention-planner.mjs';
const APPLY = 'plugins/runtime/scripts/lib/retention-apply.mjs';

export const TESTS = [T_PLAN, T_APPLY];

export const MUTATIONS = [
  {
    id: 'R1', file: PLANNER, tests: [T_PLAN],
    from: '    for (const runId of Object.keys(f.pins).sort()) {',
    to: '    for (const runId of Object.keys(f.pins)) {',
    why: 'the plan hash depends on the order pins were discovered in',
  },
  {
    id: 'R2', file: PLANNER, tests: [T_PLAN],
    from: '      if (Number.isFinite(dirStat.mtimeMs)) usage.newestMtimeMs = dirStat.mtimeMs;',
    to: '      void dirStat;',
    why: 'a freshly touched run directory is aged by its files alone',
  },
  {
    id: 'R3', file: APPLY, tests: [T_APPLY],
    from: '        if (!captured || captured.isSymbolicLink() || !captured.isDirectory()) {',
    to: '        if (!captured) {',
    why: 'a run swapped to a symlink after validation is removed recursively',
  },
  {
    id: 'R4', file: APPLY, tests: [T_APPLY],
    from: '      if ((outcome.deleted.length > 0 || maxBytes === 0) && outcome.bytes + thisBytes > maxBytes) break;',
    to: '      if (outcome.deleted.length > 0 && outcome.bytes + thisBytes > maxBytes) break;',
    why: 'a zero byte ceiling still admits the first deletion',
  },
];
