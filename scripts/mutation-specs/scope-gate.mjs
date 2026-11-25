// Mutation spec — does the snapshot removal gate's test catch the defects it
// exists for? (ADR-0023 §6, amendment of 2026-11-24, C181: what is kept while
// a scope is not read gone)
//
// Run: npm run mutate -- scripts/mutation-specs/scope-gate.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The gate is fail-closed code: each of its
// refusals keeps a snapshot a process outside the companion's group may still
// use, and a refusal that stops refusing removes that tree under it with no
// test going red unless a row shows the snapshot kept. The edits go to the
// persona-pipeline source, which the test imports.

const T_GATE = 'tests/persona-pipeline/test-snapshot-scope-gate.mjs';
const LIB = 'persona-pipeline/files/scripts/lib/peer-snapshot.mjs';

export const TESTS = [T_GATE];

export const MUTATIONS = [
  {
    id: 'G1', file: LIB, tests: [T_GATE],
    from: "  if (reading?.state === 'gone') return { pass: true, why: 'scope-gone' };\n",
    to: "  return { pass: true, why: 'scope-gone' };\n",
    why: 'a snapshot whose scope reads unproven, emptied, withheld or refused is removed',
    killed_by: /is kept whole on a reading of/,
  },
  {
    id: 'G2', file: LIB, tests: [T_GATE],
    from: "  if (owner.outcome === 'unreadable') return { pass: false, why: 'owner-unreadable' };\n",
    to: '',
    why: 'a snapshot whose owner record cannot be read (a permission, an I/O error) is removed as one with no scope',
    killed_by: /a lookup that fails otherwise|cannot be read is kept past the TTL/,
  },
  {
    id: 'G3', file: LIB, tests: [T_GATE],
    from: "      if ((await lookupPath(tree)) !== 'absent') return { pass: false, why: 'owner-absent-tree-left' };\n",
    to: '',
    why: 'a snapshot whose owner record is absent while its tree is left is removed',
    killed_by: /absent while the tree is left|absent while its tree is left/,
  },
  {
    id: 'G4', file: LIB, tests: [T_GATE],
    from: "  if (scope.state !== 'scoped') return { pass: false, why: `scope-${scope.state}` };\n",
    to: '',
    why: 'a scope of an unknown version, or one this release does not parse, is read as a scoped identity',
    killed_by: /a scope of a version this reader does not know|a scope this release does not parse/,
  },
  {
    id: 'G5', file: LIB, tests: [T_GATE],
    from: "  if (readGoneHere(scope.identity)) return { pass: true, why: 'scope-gone' };\n",
    to: '',
    why: 'a scope this process already read gone is read again at the removal, and a remover with no reader of its own keeps it for ever',
    killed_by: /once this process read the scope gone earlier/,
  },
  {
    id: 'G6', file: LIB, tests: [T_GATE],
    from: "    return { pass: false, why: 'owner-changed' };\n",
    to: "    // owner-changed ignored\n",
    why: 'a removal proceeds on a verdict made on another owner record than the one the gate reads (one that gained a scope, or turned malformed, since)',
    killed_by: /since the verdict is kept|since a verdict made on a whole one is kept|after a verdict made on none is kept/,
  },
];
