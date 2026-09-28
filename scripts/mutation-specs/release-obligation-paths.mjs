// Mutation spec — does the protected-path seam reach every comparison it must?
//
// Run: npm run mutate -- scripts/mutation-specs/release-obligation-paths.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. `classify` draws two sets and a window through
// one list, and a list that reaches only some of them fails quietly: the verdict
// is still one of the states the checker knows, and in the common case —
// supplied list equal to the live one — every mutation below is invisible. The
// seam exists for the real-history replays after ADR-0060's recovery drops the
// baseline entry, and those replays cannot run in this harness (no `.git`), so
// the synthetic file is where the seam is proven.

const T = 'tests/scripts/test-release-obligation-paths.mjs';
const CHECKER = 'scripts/check-release-obligation.mjs';

export const TESTS = [T];

export const MUTATIONS = [
  {
    id: 'S1', file: CHECKER, tests: [T],
    from: '  const entries = protectedEntries(repoRoot, head, paths);',
    to: '  const entries = protectedEntries(repoRoot, head);',
    why: 'the head set ignores the supplied list',
  },
  {
    id: 'S2', file: CHECKER, tests: [T],
    from: '  const tagEntries = protectedEntries(repoRoot, newestTag.name, paths);',
    to: '  const tagEntries = protectedEntries(repoRoot, newestTag.name);',
    why: 'the released set ignores the supplied list',
  },
  {
    id: 'S3', file: CHECKER, tests: [T],
    from: '  const inWindow = protectedChangesInWindow(repoRoot, { sinceRef: newestTag.name, ref: head, paths });',
    to: '  const inWindow = protectedChangesInWindow(repoRoot, { sinceRef: newestTag.name, ref: head });',
    why: 'the change window ignores the supplied list',
  },
  {
    id: 'S4', file: CHECKER, tests: [T],
    from: '    const pendingDigest = advance ? digestEntries(protectedEntries(repoRoot, advance, paths)) : null;',
    to: '    const pendingDigest = advance ? digestEntries(protectedEntries(repoRoot, advance)) : null;',
    why: 'the pending-release set ignores the supplied list',
  },
  {
    id: 'S5', file: CHECKER, tests: [T],
    from: '  const epochDigest = digestEntries(protectedEntries(repoRoot, epoch, paths));',
    to: '  const epochDigest = digestEntries(protectedEntries(repoRoot, epoch));',
    why: 'the epoch set ignores the supplied list',
  },
  {
    id: 'S6', file: CHECKER, tests: [T],
    from: '    protectedPaths: [...paths],',
    to: '    protectedPaths: [...PROTECTED_PATHS],',
    why: 'the report names the live list whatever list was used',
  },
  {
    id: 'S7', file: CHECKER, tests: [T],
    from: '  if (pathProblem) return fail(',
    to: '  if (false) return fail(',
    why: 'classify judges an empty list as the whole tree (found in review)',
  },
  {
    id: 'S8', file: CHECKER, tests: [T],
    from: '  if (!Array.isArray(paths) || paths.length === 0) return \'the protected path list is empty\';',
    to: '  if (!Array.isArray(paths)) return \'the protected path list is empty\';',
    why: 'an empty array passes the shared predicate, so both helpers read the whole tree',
  },
];
