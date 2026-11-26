// Mutation spec — do the agentic-dir tests catch the defects they exist for?
// (ADR-0059 Decisions 9 and 10, C175: the CLI that makes, marks and releases
// a runbook's text and operation directories)
//
// Run: npm run mutate -- scripts/mutation-specs/agentic-dir.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The release is fail-closed code that removes
// files: each of its checks is the only thing between a name and a removal,
// and a check that stops refusing removes a directory the CLI never made (a
// moved one, another owner's, one a link reaches, one still in use) with no
// test going red unless a row shows the directory kept. The withdrawal's
// `unknown` is the same kind of guard for a dispatch mark (Decision 10, item
// 1). The edits to the library go to the persona-pipeline source, which the
// tests import; the withdrawal's to the orchestrator's hold-ops.
//
// A verification batch runs at most 6 case ids in all (AGENTS.md, `mutate`):
// hand the cases over in checks of 6 or fewer.

const T_REL = 'tests/persona-pipeline/test-agentic-dir-release.mjs';
const T_HOLDS = 'tests/orchestrator/test-next-holds.mjs';

const LIB = 'persona-pipeline/files/scripts/lib/agentic-dir.mjs';
const OPS = 'plugins/orchestrator/scripts/lib/hold-ops.mjs';

export const TESTS = [T_REL, T_HOLDS];

export const MUTATIONS = [
  {
    id: 'D1', file: LIB, tests: [T_REL],
    from: "    if (mp.path !== parent.path) return 'marker-parent';\n",
    to: "    if (false) return 'marker-parent';\n",
    why: "a directory whose root was renamed since the make (same device and inode, another path) passes the marker's parent check",
    killed_by: /refuses a directory whose root was renamed since the make/,
  },
  {
    id: 'D2', file: LIB, tests: [T_REL],
    from: "    if (fst.nlink !== 1n) return { invalid: 'nlink' };\n",
    to: "    if (false) return { invalid: 'nlink' };\n",
    why: 'a marker that gains a hard link between its lstat and its open is read as the directory\'s own',
    killed_by: /refuses a marker that gains a link between its lstat and its open/,
  },
  {
    id: 'D3', file: LIB, tests: [T_REL],
    from: "  if (t.dir_marker_id !== markerId) return { outcome: 'refused', reason: 'operation-unbound' };\n",
    to: '',
    why: "a closed transport copied from another directory, or written by an older state.mjs, authorizes the removal of this one",
    killed_by: /refuses an operation directory whose transport is closed with (no marker id|another directory's id)/,
  },
  {
    id: 'D4', file: LIB, tests: [T_REL],
    from: "  if (st.uid !== BigInt(euid)) return { outcome: 'not-owned', reason: 'uid' };\n",
    to: '',
    why: "a directory another user owns is released on a marker that user forged with this uid (the marker's own uid check passes it)",
    killed_by: /refuses a directory another user owns even with a marker naming this uid, keeping it whole/,
  },
  {
    id: 'D5', file: LIB, tests: [T_REL],
    from: "    sys.mkdir(claimedPath, 0o700);\n  } catch (err) {\n    if (codeOf(err) === 'EEXIST') {",
    to: "    try { sys.mkdir(claimedPath, 0o700); } catch (e) { if (codeOf(e) !== 'EEXIST') throw e; }\n  } catch (err) {\n    if (codeOf(err) === 'EEXIST') {",
    why: "the claim is not exclusive: a release meets another claimant's empty .removing- placeholder, renames onto it and empties the directory under the other's claim",
    killed_by: /meets contention when \.removing-<name> is there, and changes nothing/,
  },
  {
    id: 'D6', file: LIB, tests: [T_REL],
    from: "    return { stop: { outcome: 'refused', reason: 'entry', entry } };\n",
    to: '    continue;\n',
    why: 'a directory inside a text directory (or any inside an operation directory) passes the entries check, so the release unlinks around it',
    killed_by: /refuses another directory in a text directory, and any directory in an operation directory/,
  },
  {
    id: 'D8', file: LIB, tests: [T_REL],
    from: "  if (t.state !== 'closed') return { outcome: 'refused', reason: 'operation-not-closed' };\n",
    to: '',
    why: 'an operation directory whose bound operation is still open (or opening) is released under the session that runs it',
    killed_by: /refuses an operation directory whose transport is (open|opening)$/,
  },
  {
    id: 'D9', file: LIB, tests: [T_REL],
    from: "  if (marker.dev !== String(st.dev) || marker.ino !== String(st.ino)) return 'marker-identity';\n",
    to: '',
    why: "a marker whose recorded device and inode are not the directory's authorizes its release",
    killed_by: /refuses a marker whose recorded identity is not the directory's/,
  },
  {
    id: 'D7', file: OPS, tests: [T_HOLDS],
    from: '    if (carried.unreadable) {\n',
    to: '    if (false) {\n',
    why: 'a child that cannot be read is taken to carry nothing: the mark it may carry is withdrawn, and its operation runs on with no record',
    killed_by: /unknown: a child that cannot be read keeps the mark/,
  },
];
