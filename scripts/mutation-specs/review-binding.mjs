// Mutation spec — do the review-binding tests catch the defects they exist for?
// (C163 A2b; ADR-0069)
//
// Run: npm run mutate -- scripts/mutation-specs/review-binding.mjs
//
// Every rule here fails open and quietly: a change edited after its critique
// commits and lands under the old verdict, and nothing says so. Each mutation
// removes one rule and names the tests that must notice. The persona mutations
// edit the engineer's generated copies, which the tests import (ADR-0066); the
// policy's read the orchestrator's.
//
// Groups: R the rule as the owner's instruction of 2026-11-09 simplified it (the
// record, which reviews count, unbound reviews, the interval), D the record's
// shape, I the identity and its capture, P Phase 7, N the narrowing, A the
// owner's acceptance, L the landing and the policy, S the subject in the
// runbooks.

const T_P = 'tests/persona-pipeline/test-review-binding.mjs';
const T_O = 'tests/orchestrator/test-review-binding-landing.mjs';
const T_D = 'tests/orchestrator/test-done-runbook.mjs';
const T_RV = 'tests/persona-pipeline/test-verb-runbook-runs.mjs';
const T_CA = 'tests/orchestrator/test-command-args.mjs';
const T_POL = 'tests/orchestrator/test-autopilot-policy.mjs';

const LIB = 'plugins/engineer/scripts/lib/review-attempts.mjs';
const CI = 'plugins/engineer/scripts/lib/change-identity.mjs';
const STATE = 'plugins/engineer/scripts/state.mjs';
const PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const RUNNER = 'plugins/engineer/scripts/peer-runner.mjs';
const LANDING = 'plugins/orchestrator/scripts/landing.mjs';
const POLICY = 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs';
const DONE = 'plugins/orchestrator/commands/done.md';
const ORCH_STATE = 'plugins/orchestrator/scripts/state.mjs';
const ARGS = 'plugins/orchestrator/scripts/lib/command-args.mjs';

export const TESTS = [T_P, T_O];

const T_ONE_FULL = /one full review of the same change vouches; any byte of one path does not/;
const T_UNCOVERED = /a path no review covers fails, and so does a path dropped from the change/;
const T_CLEAN_REBASE = /a clean rebase onto a main that moved other files is the same change; a main that edited a touched file is not/;
const T_SCOPED = /a scoped review composes with the full one before it, path by path; the latest in the ledger answers/;
const T_ORDER = /a review settled after a later-listed one is unbound, and only a later full review lifts it/;
const T_CLEAR = /a path a later full review no longer shows answers as untouched/;
const T_COUNTS = /which outcomes count: passed, concerns and conflict answer/;
const T_UNBOUND = /an unbound counting review is not comparable until a later full review lifts it/;
const T_INCOMPLETE = /an incomplete history, an unreadable record or a later version is not comparable/;
const T_ANSWER_UNUSABLE = /a path answered by a review that cannot answer for this change is not comparable/;
const T_BOUNDED = /the record is bounded by the paths: past its cap it is truncated, and the change is not comparable/;
const T_NARROW = /a failure the record shows to be of another change is passed over; one it cannot show stays read/;
const T_DIGEST = /a file name with a line break does not make two manifests one digest/;
const T_COMP_VALID = /a malformed record is unreadable: an unknown field, an answer naming no attempt, a state no comparison has/;
const T_OLD = /an old record \(no identity\) reads unbound, never matching: autopilot refuses, interactive warns and commits/;
const T_EDIT = /an edit after review: the plan says so, autopilot refuses \(exit 10\) and interactive refuses, nothing written/;
const T_UNCHANGED = /an unchanged change commits, and records the comparison keyed by its commit/;
const T_PARTIAL = /a partial multi-package commit claims nothing; its recovery binds the whole series/;
const T_RECOVERY = /the recovery of a commit that is not the change reviewed is refused too/;
const T_LEFT_OUT = /a partial series whose reviewed package is left out is refused before its first commit/;
const T_UNNAMED = /a commit in the interval naming no workflow makes it not comparable/;
const T_FOREIGN = /a commit of another workflow in the interval makes it not comparable; its reviews are not read/;
const T_NO_BASE = /with no base resolved, another workflow's commit on the branch makes it not comparable/;
const T_STAGED_MODE = /the projection keeps a staged mode core.filemode cannot read/;
const T_EXTRA_ACCEPT = /a commit with an extra path: the refusal names it, and the owner's acceptance is of that change/;
const T_LANDED_UNNAMED = /a commit that was not comparable is still not comparable once landed, with the reason/;
const T_LANDED_START = /a start after the landing is refused/;
const T_LANDED_COMMITTED_DIFF = /a commit recorded different lands different, unless the owner accepted it before its commit/;
const T_ACCEPT_WAKES = /the owner's acceptance of a refused change moves the lane fingerprint, and nothing moves it before/;
const T_LANDED_NO_RECORD = /a head with no committed comparison is not comparable/;
const T_SETTLE_RACE = /settle waits for the runner's second capture/;
const T_SUBMODULE = /an untouched snapshot with an unstaged submodule update binds/;
const T_ACCEPT = /the owner's acceptance lets the change, for this change only; under autopilot it is refused/;
const T_SNAP_EDIT = /a peer that changes its snapshot records no identity, and vouches for nothing/;
const T_NO_SUBJECT = /a dispatch with no subject is unbound/;
const T_EMPTY_SUBJECT = /an empty subject is a record: it covers no path/;
const T_NO_RUN = /a review that never launched records the checkout, and answers for no path/;
const T_BIND_RUN = /a peer that leaves its snapshot alone binds, with its subject/;
const T_BASES = /several best merge bases, an unborn branch and flagged index entries record no identity/;
const T_MANIFEST = /the manifest ignores diff settings, shows a pinned submodule whatever its ignore setting/;
const T_RENAME = /a rename is a delete and an add; a mode is a difference/;
const T_LANDED_DIFF = /what landed differs from what was committed: different, naming the path/;
const T_LANDED_SERIES = /a rebased series compares from its start, so the earlier package is seen/;
const T_LANDED_NONE = /with no evidence of the start, no head, no child, or no comparison recorded for the head, it is not comparable/;
const T_STALE = /a stale ref on both sides that calls it the same at commit is different once landed/;
const T_EV_MERGE = /a merge commit starts at its first parent, its second parent the head/;
const T_EV_REBASE = /a rebase that dropped a commit walks only what it landed/;
const T_EV_NONE = /with no evidence the start is null/;
const T_RESOLVE = /a squash of the committed change reads same; an edit after it landed reads different/;
const T_LANDED_POLICY = /what landed differing halts for the owner before done; not comparable goes on; the same goes on/;
const T_REPORT = /the report keeps the provisional comparison before the merge apart/;
const T_DONE = /a landing that differs is refused; --accept-landed-change with a reason records it/;
const T_DONE_NC = /a landing that cannot be compared is recorded, and the macro says why/;

const T_SUBJECT = (verb) => new RegExp(`${verb}: subject\\.json reaches the review's record`);
const T_NO_COUNT = /a failure no counting review answers keeps holding/;
const T_BOM = /a leading U\+FEFF is part of a path, never stripped/;
const T_MERGE_BASE = /a merge of the branch to land on into the branch names no workflow/;
const T_SPLIT = /a per-package split is judged whole at admission/;
const T_ZSH = /passes the subject file as words of its own/;
const T_ENV_FILTER = /a filter only the environment gives git reaches the projection as it reaches the commit/;
const T_PARITY = /the projection is the tree the commit holds: a staged deletion, a new file, a filtered file, an edit/;
const T_FLAGS = /a flagged path is not projected: assume-unchanged or skip-worktree reads not comparable/;
const T_IGNORED = /a manifest naming an ignored file: the acceptance and Phase 7 judge the one staging set/;
const T_SERIES_STOP = /Phase 7's own series stopped part way records no comparison; its rerun records the whole/;
const T_AMBIGUOUS = /a workflow whose active and archived copies differ is no one workflow/;
const T_SUBMODULE_PARITY = /a submodule set to ignore=all: the projection stages its move as Phase 7 does/;
const T_REPO_SELECT = /a repository the environment selects that is not the checkout reads not comparable/;
const T_SUFFIXED = /an archived copy under a suffixed name is a copy too/;
const T_ARGS_REFUSE = /refuses what it cannot read as written, naming why/;
const T_DONE_POST = /a done must complete the subtask; a finalize must archive the macro/;
const T_OVERRIDES_AUTOPILOT = /the owner's overrides are refused under an autopilot run, and the acceptance needs a reason and a commit/;
const T_NO_RUN_SUBJECT_PROSE = /tells the agent to write the subject in TEXT_DIR, where the block reads it/;

export const MUTATIONS = [
  // ---- The rule as the owner's instruction of 2026-11-09 simplified it ------------
  {
    id: 'R1', file: LIB, tests: [T_P],
    from: "    if (entry !== (changeOf.get(path) ?? null)) failures.push({ path, why: 'differs', by: [by] });\n",
    to: '',
    why: 'any transition reads as reviewed: an edit after review is vouched for',
    killed_by: [T_ONE_FULL, T_EDIT],
  },
  {
    // The post-image set ADR-0069 rejects: each path's new mode and object
    // compared, the old mode and object (the before-image) dropped.
    id: 'R18', file: LIB, tests: [T_P],
    from: "    if (entry !== (changeOf.get(path) ?? null)) failures.push({ path, why: 'differs', by: [by] });\n",
    to: "    const post = (e) => (e === null ? null : `${e.split(' ')[1]} ${e.split(' ')[3]}${e.slice(e.indexOf('\\t'))}`);\n    if (post(entry) !== post(changeOf.get(path) ?? null)) failures.push({ path, why: 'differs', by: [by] });\n",
    why: 'the before-image is not compared: a rebase onto a main that edited a touched file reads as the change reviewed',
    killed_by: [T_CLEAN_REBASE],
  },
  {
    id: 'R2', file: LIB, tests: [T_P],
    from: '  for (const [p, [entry]] of Object.entries(doc.answers)) if (entry !== null) paths.add(p);\n',
    to: '',
    why: 'a path a review touched and the change dropped is never compared: a file removed after its review reads as the change reviewed',
    killed_by: [T_UNCOVERED],
  },
  {
    id: 'R3', file: LIB, tests: [T_P],
    from: '        for (const p of covered) answers[p] = [entries.get(p) ?? null, attemptId];\n',
    to: '        for (const p of covered) if (!answers[p]) answers[p] = [entries.get(p) ?? null, attemptId];\n',
    why: 'the first review of a path answers for it, not the latest: an edit an earlier review saw outvotes the re-review of it',
    killed_by: [T_SCOPED],
  },
  {
    id: 'R4', file: LIB, tests: [T_P],
    from: '          for (const [p, [entry]] of Object.entries(answers)) if (entry !== null && !shown.has(p)) answers[p] = [null, attemptId];\n',
    to: '',
    why: 'a later full review no longer answers for a path it did not show: a file written and then removed keeps the change from binding',
    killed_by: [T_CLEAR],
  },
  {
    id: 'R5', file: LIB, tests: [T_P],
    from: '          const shown = new Set([...(coverage.shown ?? []), ...covered]);\n',
    to: '          const shown = new Set(covered);\n',
    why: 'a path the full review showed at other content is cleared as untouched: content no reviewer saw is vouched for',
    killed_by: [T_CLEAR],
  },
  {
    id: 'R6', file: LIB, tests: [T_P],
    from: '  const full = manifest !== null && coverage !== null && [...entries.keys()].every((p) => covered.has(p));\n',
    to: '  const full = manifest !== null && coverage !== null && [...entries.keys()].some((p) => covered.has(p));\n',
    why: 'a review given part of the change counts as full: it clears and lifts what it never saw',
    killed_by: [T_CLEAR],
  },
  {
    id: 'R7', file: LIB, tests: [T_P],
    from: '      if (laterApplied) {\n',
    to: '      if (false) {\n',
    why: "a review settled after a later-listed one overwrites the later one's answers: an older view of a path answers for it",
    killed_by: [T_ORDER],
  },
  {
    id: 'R8', file: LIB, tests: [T_P],
    from: "  const fulls = counting.filter((a) => why(a.id) === null && recOf(a.id).coverage === 'full').map((a) => position.get(a.id));\n",
    to: "  const fulls = counting.filter((a) => why(a.id) === null && recOf(a.id).coverage !== null).map((a) => position.get(a.id));\n",
    why: 'a partial review lifts an unbound one: obligations nobody can read are dropped by a review that never saw the whole change',
    killed_by: [T_ORDER],
  },
  {
    id: 'R9', file: LIB, tests: [T_P],
    from: '    if (w !== null && !fulls.some((p) => p > position.get(a.id))) return nc(`unbound-review:${a.id}:${w}`);\n',
    to: '    if (w !== null && fulls.length === 0) return nc(`unbound-review:${a.id}:${w}`);\n',
    why: 'a full review listed before an unbound one lifts it: a review that saw the change before the unbound one vouches for what came after',
    killed_by: [T_UNBOUND],
  },
  {
    id: 'R10', file: LIB, tests: [T_P],
    from: "  if (branch && rec.identity.base?.branch !== branch) return `other-landing-branch:${rec.identity.base?.branch ?? 'none'}`;\n",
    to: '',
    why: 'a review measured from another branch to land on is compared as if from this one',
    killed_by: [T_UNBOUND, T_ANSWER_UNUSABLE],
  },
  {
    id: 'R11', file: LIB, tests: [T_P],
    from: "  if (rec.coverage === null || rec.coverage === undefined) return 'no-subject';\n",
    to: '',
    why: 'a review whose dispatch recorded no subject counts as bound: what it showed is not known',
    killed_by: [T_UNBOUND, T_NO_SUBJECT],
  },
  {
    id: 'R12', file: LIB, tests: [T_P],
    from: '    if (w !== null) return nc(`answer-unusable:${path}:${by}:${w}`);\n',
    to: '',
    why: "an answer from a review that cannot answer for this change (another branch) is read as this change's",
    killed_by: [T_ANSWER_UNUSABLE],
  },
  {
    id: 'R13', file: LIB, tests: [T_P],
    from: "  if (view.coverage.reasons.length > 0) return nc(`history-incomplete:${view.coverage.reasons.join(',')}`);\n",
    to: '',
    why: 'a review history with attempts dropped or unread is compared as whole',
    killed_by: [T_INCOMPLETE],
  },
  {
    id: 'R14', file: LIB, tests: [T_P],
    from: "  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') <= maxBytes) return doc;\n",
    to: '  return doc;\n',
    why: 'a record past its cap is written whole: the frontmatter outgrows what readers allow',
    killed_by: [T_BOUNDED],
  },
  {
    id: 'R15', file: LIB, tests: [T_P],
    from: "  if (doc.truncated) return nc('bindings-truncated');\n",
    to: '',
    why: 'a truncated record is compared as if its answers were whole',
    killed_by: [T_BOUNDED],
  },
  {
    id: 'R16', file: CI, tests: [T_P],
    from: '  if (foreign) {\n',
    to: '  if (false) {\n',
    why: "a commit of another workflow, or of none, in the interval is compared with this workflow's reviews alone",
    killed_by: [T_UNNAMED, T_FOREIGN],
  },
  {
    id: 'R17', file: CI, tests: [T_P],
    from: '  const foreign = commits.find((c) => c.workflow !== workflowId);\n',
    to: '  const foreign = commits.find((c) => c.workflow === null);\n',
    why: "another workflow's commit in the interval is taken for this workflow's",
    killed_by: [T_FOREIGN],
  },
  {
    id: 'L40', file: CI, tests: [T_P],
    from: "  if (record.state === 'different' && record.accepted !== true) {\n",
    to: '  if (false) {\n',
    why: 'a commit Phase 7 found different after it (a pre-commit hook) lands as merely not comparable, and done records it with no owner',
    killed_by: [T_LANDED_COMMITTED_DIFF],
  },
  {
    id: 'L41', file: POLICY, tests: [T_O],
    from: "  if (ba) tuple.push(['review-binding-acceptance', ba.manifest_sha256 ?? null, ba.state ?? null, ba.accepted_at ?? null, ba.unreadable === true]);\n",
    to: '',
    why: "the owner's acceptance of a change Phase 7 refused moves nothing the park watches: the lane stays parked until a relaunch",
    killed_by: [T_ACCEPT_WAKES],
  },
  // ---- The narrowing, from what the record shows ---------------------------------
  {
    id: 'N1', file: LIB, tests: [T_P],
    from: '    if (!changeOf.has(path) || entry === changeOf.get(path)) continue;\n',
    to: '    if (entry === changeOf.get(path)) continue;\n',
    why: 'a failure is taken for another change on a path the change does not touch (an untracked file it held), and stops holding (CRITICAL 1)',
    killed_by: [T_NARROW],
  },
  {
    id: 'N2', file: LIB, tests: [T_P],
    from: "    if (unboundWhy(Object.hasOwn(doc.attempts, by) ? doc.attempts[by] : undefined, { branch, objectFormat }) === null) out.add(by);\n",
    to: '    out.add(by);\n',
    why: 'a failure measured from another branch is taken for another change, and stops holding',
    killed_by: [T_NARROW],
  },
  {
    id: 'N3', file: LIB, tests: [T_P],
    from: '      for (const p of covered) if (!seen[p] || before(seen[p][1])) seen[p] = [entries.get(p) ?? null, attemptId];\n',
    to: '      for (const p of covered) if (!seen[p]) seen[p] = [entries.get(p) ?? null, attemptId];\n',
    why: "an earlier failure's view of a path stands for a later failure's: the later one is judged by what the earlier saw",
    killed_by: [T_NARROW],
  },
  // ---- The landing ----------------------------------------------------------------
  {
    id: 'L2', file: CI, tests: [T_P],
    from: '  if (record.manifest_sha256 !== fields.manifest_sha256) {\n',
    to: '  if (false) {\n',
    why: 'what landed is never compared with what was committed: an edit after the commit lands as the change compared',
    killed_by: [T_LANDED_DIFF, T_STALE],
  },
  {
    id: 'L3', file: CI, tests: [T_P],
    from: "  if (record.state === 'same' || record.state === 'no-reviews') return out({ state: record.state, ...fields });\n",
    to: "  return out({ state: 'same', ...fields });\n",
    why: 'a commit that compared not comparable lands as the same change',
    killed_by: [T_LANDED_UNNAMED],
  },
  {
    id: 'L8', file: CI, tests: [T_P],
    from: "    const failures = committed ? differingPaths(committed, entries).map((path) => ({ path, why: 'landed', by: [head.slice(0, 12)] })) : [];\n",
    to: '    const failures = [];\n',
    why: 'a landing that differs names no path: the owner is asked to accept it blind',
    killed_by: [T_LANDED_DIFF],
  },
  {
    id: 'L9', file: CI, tests: [T_P],
    from: "  if (record === null || typeof record.manifest_sha256 !== 'string') return out({ state: 'not-comparable', reason: `no-committed-comparison:${head.slice(0, 12)}`, ...fields });\n",
    to: "  if (record === null || typeof record.manifest_sha256 !== 'string') return out({ state: 'same', ...fields });\n",
    why: 'a head with no committed comparison (a fixup after Phase 7) lands as the same change',
    killed_by: [T_LANDED_NONE, T_LANDED_NO_RECORD],
  },
  // ---- C: the composition rule ----------------------------------------------------
  {
    id: 'C2', file: LIB, tests: [T_P],
    from: "      failures.push({ path, why: 'uncovered', by: [] });\n",
    to: '',
    why: 'a path no review covers passes: a review of one file vouches for the whole change',
    killed_by: [T_UNCOVERED, T_EMPTY_SUBJECT],
  },
  // ---- D: which reviews count, and the unbound ---------------------------------------
  {
    id: 'D1', file: LIB, tests: [T_P],
    from: "export const COUNTING_REVIEW_OUTCOMES = Object.freeze(['passed', 'concerns', 'conflict']);",
    to: "export const COUNTING_REVIEW_OUTCOMES = Object.freeze(['passed', 'concerns', 'conflict', 'skipped']);",
    why: 'a skip answers for a path: a worker launders an edit by claiming a local-only review',
    killed_by: [T_NO_RUN, T_COUNTS],
  },
  // ---- I: the identity and its capture -----------------------------------------------
  {
    id: 'I1', file: CI, tests: [T_P],
    from: "'--no-renames', '--full-index', '--ignore-submodules=none', baseTree",
    to: "'--no-renames', '--full-index', baseTree",
    why: 'a repository set to ignore a submodule shows no pin move, so two pins read as the same change',
    killed_by: [T_MANIFEST],
  },
  {
    id: 'I2', file: CI, tests: [T_P],
    from: "'--raw', '--no-renames', '--full-index',",
    to: "'--raw', '-M', '--full-index',",
    why: 'rename detection: a rename reads by similarity, and the result depends on configuration',
    killed_by: [T_RENAME],
  },
  {
    id: 'I3', file: CI, tests: [T_P],
    from: "  if (bases.length > 1) return { base: null, reason: 'several-merge-bases' };\n",
    to: '',
    why: "one of several merge bases is picked by git's traversal, and the manifest depends on which",
    killed_by: [T_BASES],
  },
  {
    id: 'I4', file: CI, tests: [T_P],
    from: "  if (flagged.length > 0) return none('index-flags');\n",
    to: '',
    why: 'edits under assume-unchanged are in no capture, and the review still binds',
    killed_by: [T_BASES],
  },
  {
    id: 'I5', file: CI, tests: [T_P],
    from: "  if (s.end_tree !== s.worktree_tree) return none('snapshot-changed');\n",
    to: '',
    why: 'a peer that rewrote its snapshot reviewed something else, and the launch tree still binds',
    killed_by: [T_SNAP_EDIT],
  },
  {
    id: 'I6', file: CI, tests: [T_P],
    from: "    if (!isExcludedFromManifest(path)) entries.push(`${meta}\\t${path}`);\n",
    to: '    entries.push(`${meta}\\t${path}`);\n',
    why: 'the state homes enter the manifest, so a tracked file there reads deleted in every review (ADR-0069 P3)',
    killed_by: [T_MANIFEST],
  },
  {
    id: 'I7', file: RUNNER, tests: [T_P],
    from: "      const ended = options.kind === 'ensemble' && isReviewType(options.ensembleType) ? await endCapture(snapshot, options.env) : {};\n",
    to: '      const ended = {};\n',
    why: 'no second capture: every run reads as not recaptured, so no review ever binds',
    killed_by: [T_BIND_RUN, T_SNAP_EDIT],
  },
  {
    id: 'I8', file: RUNNER, tests: [T_P],
    from: "        if (binding?.subject) h.subject = binding.subject;\n",
    to: '',
    why: 'the subject never reaches the handle: every review covers no path',
    killed_by: [T_BIND_RUN],
  },
  // ---- P: Phase 7 -------------------------------------------------------------------
  {
    id: 'P1', file: PHASE7, tests: [T_P],
    from: "  const binding = await reviewBindingCheck({ workflowPath, repoRoot, frontmatter, paths, argument: flags['landing-branch'] ?? null });\n  const extras = paths.filter((p) => !manifestPathsOf(frontmatter).includes(p));\n  // A comparison that holds with no acceptance key names a cause to clear\n  // first: until it is, neither acceptance can be given (refine-verify of\n  // 2026-11-08, third pass).\n  const noKey = binding.held && typeof binding.acceptance_key !== 'string' ? reviewBindingHoldText(binding, { workflowPath, extras }) : null;\n  const held = noKey ?? reviewHoldText(await reviewGateCheck({ workflowPath, repoRoot, frontmatter, binding }), { workflowPath })\n    ?? reviewBindingHoldText(binding, { workflowPath, extras });\n",
    to: "  const held = reviewHoldText(await reviewGateCheck({ workflowPath, repoRoot }), { workflowPath });\n",
    why: 'autopilot compares nothing: the defect itself, an edit after review commits under the old verdict',
    killed_by: [T_EDIT, T_OLD],
  },
  {
    id: 'P2', file: PHASE7, tests: [T_P],
    from: "  if (binding.state === 'different') {\n    stderr.write(\n",
    to: "  if (false) {\n    stderr.write(\n",
    why: 'interactively a change shown to differ only warns',
    killed_by: [T_EDIT],
  },
  {
    id: 'P3', file: PHASE7, tests: [T_P],
    from: "    workflowPath, repoRoot, stderr, flags, paths: shape.commits.flatMap((c) => c.files), enforce: enforceSubjects,\n",
    to: "    workflowPath, repoRoot, stderr, flags, paths: [], enforce: enforceSubjects,\n",
    why: 'the admission compares HEAD, not what the series will hold: a first commit reads as the whole change',
    killed_by: [T_UNCHANGED],
  },
  {
    id: 'P4', file: PHASE7, tests: [T_P],
    from: "      const recovering = await reviewAdmission({ workflowPath, repoRoot, stderr, flags, paths: [], enforce: enforceSubjects });\n      if (recovering) return recovering;\n",
    to: '',
    why: 'the recovery path lands commits with no comparison at its admission',
    killed_by: [T_RECOVERY],
  },
  {
    id: 'P5', file: PHASE7, tests: [T_P],
    from: "    const recorded = await recordCommittedComparison({\n      workflowPath, repoRoot, argument: flags['landing-branch'] ?? null, host: flags.host, writer: 'operation',\n    });\n",
    to: "    const recorded = { recorded: false };\n",
    why: 'no comparison is recorded: every landing reads not comparable',
    killed_by: [T_UNCHANGED, T_PARTIAL, T_LANDED_DIFF],
  },
  {
    id: 'P8', file: CI, tests: [T_P],
    from: "  const resultTree = tree ?? treeOf(repoRoot, head);\n",
    to: '  const resultTree = treeOf(repoRoot, head);\n',
    why: 'the projection is ignored, so every plan and admission compares HEAD instead of the change',
    // Not T_EDIT: HEAD lacks the reviewed edit too, so it still reads different
    // and refuses (measured by the plan-verify peer).
    killed_by: [T_LEFT_OUT],
  },
  {
    id: 'P9', file: CI, tests: [T_P],
    from: "    if (alone && !othersUnlanded(repoRoot, workflowId)) return out({ state: 'no-reviews', ...extra });\n",
    to: "    if (alone) return out({ state: 'no-reviews', ...extra });\n",
    why: "with no base, a workflow with no review of its own commits over another's reviewed commits",
    killed_by: [T_NO_BASE],
  },
  {
    id: 'P10', file: CI, tests: [T_P],
    from: "      if (entries.length > 0 && !on(['update-index', '-z', '--index-info'], `${entries.join('\\0')}\\0`).ok) return none('projection-failed');\n",
    to: '',
    why: 'the projection loses a staged mode under core.filemode=false: admission reads same, and the commit is not what was reviewed',
    killed_by: [T_STAGED_MODE],
  },
  {
    id: 'P11', file: LIB, tests: [T_P],
    from: "  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');\n",
    to: "  return createHash('sha256').update(entries.join('\\n'), 'utf8').digest('hex');\n",
    why: 'a file name with a line break makes two manifests one digest, and an acceptance covers the other',
    killed_by: [T_DIGEST],
  },
  // The interactive refusal: under autopilot `--include-extra` is refused before
  // the admission, and a recovery passes no paths, so heldReviewRefusal's
  // `extras` is always empty there and dropping it is an equivalent mutation
  // (a probe of the plan-verify peer, run plan-verify-20261107T211518Z-4fb6de).
  {
    id: 'P12', file: 'plugins/engineer/scripts/phase7-commit.mjs', tests: [T_P],
    from: "  const hold = reviewBindingHoldText(binding, { workflowPath, extras });\n",
    to: "  const hold = reviewBindingHoldText(binding, { workflowPath });\n",
    why: 'the refusal names an acceptance of the manifest alone, which answers nothing to accept',
    killed_by: [T_EXTRA_ACCEPT],
  },
  // ---- A: the owner's acceptance ------------------------------------------------------
  {
    id: 'A1', file: LIB, tests: [T_P],
    from: '  return decoded.doc.manifest_sha256 === key && decoded.doc.state === comparison.state;\n',
    to: '  return decoded.doc.state === comparison.state;\n',
    why: 'an acceptance covers every later edit',
    killed_by: [T_ACCEPT],
  },
  {
    id: 'A2', file: STATE, tests: [T_P],
    from: "    throw new Error(`review-binding-accept: refused under an autopilot run (AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}); only the owner accepts a change its reviews do not vouch for (ADR-0069 Decision 3)`);\n",
    to: '    void env;\n',
    why: 'a worker clears the hold on its own commit',
    killed_by: [T_ACCEPT],
  },
  {
    id: 'A3', file: STATE, tests: [T_P],
    from: '  return commitStagingSet({ repoRoot, frontmatter, includeExtras: extras });\n',
    to: '  return commitStagingSet({ repoRoot, frontmatter, includeExtras: [] });\n',
    why: 'the acceptance compares the manifest alone, so a commit with an extra path cannot be accepted',
    killed_by: [T_EXTRA_ACCEPT],
  },
  // ---- L: the landing and the policy ---------------------------------------------------
  {
    id: 'L1', file: CI, tests: [T_P],
    from: "  const { entries, reason } = manifestBetween(repoRoot, startTree, landedTree);\n",
    to: "  const { entries, reason } = manifestBetween(repoRoot, treeOf(repoRoot, `${commit}~1`) ?? startTree, landedTree);\n",
    why: 'the last commit alone is compared: a rebased series misses its earlier packages (ADR-0069 P5b)',
    killed_by: [T_LANDED_SERIES],
  },
  {
    id: 'L15', file: CI, tests: [T_P],
    from: "  if (!git(repoRoot, ['merge-base', '--is-ancestor', start, commit]).ok || ",
    to: '  if (',
    why: 'a start after the landing measures something else, and a landing with an unreviewed file reads same',
    killed_by: [T_LANDED_START],
  },
  {
    id: 'I9', file: RUNNER, tests: [T_P],
    from: "  if (await endCapturePending(handle)) {\n",
    to: '  if (false) {\n',
    why: 'settled while the runner is finishing, a review that changed nothing is recorded unbound for good',
    killed_by: [T_SETTLE_RACE],
  },
  {
    id: 'I10', file: 'plugins/engineer/scripts/lib/peer-snapshot.mjs', tests: [T_P],
    from: "    await gitOk(snapshot.root, ['read-tree', snapshot.worktree_tree], 'worktree-unreadable', { env, indexFile: index });\n",
    to: "    await gitOk(snapshot.root, ['read-tree', 'HEAD'], 'worktree-unreadable', { env, indexFile: index });\n",
    why: 'a submodule moved and not staged reads as moved back, so an untouched snapshot reads changed and the lane halts',
    killed_by: [T_SUBMODULE],
  },
  {
    id: 'L4', file: LANDING, tests: [T_O],
    from: "  if (parents.length >= 2) return { start: parents[0], head: head ?? parents[1], evidence: 'merge-commit' };\n",
    to: "  if (parents.length >= 2) return { start: parents[1], head: head ?? parents[1], evidence: 'merge-commit' };\n",
    why: "a merge landing is measured from the branch's tip, so it reads as no change at all",
    killed_by: [T_EV_MERGE],
  },
  {
    id: 'L5', file: LANDING, tests: [T_O],
    from: "    if (!numbers.some((n) => String(n) === String(prNumber))) {\n",
    to: "    if (i > 0) {\n",
    why: 'the walk stops at one commit whatever GitHub says: a rebased series reads as its last commit',
    killed_by: [T_EV_REBASE],
  },
  {
    id: 'L6', file: LANDING, tests: [T_O],
    from: "      return cur === commit ? { start: null, head, evidence: 'not-associated' } : { start: cur, head, evidence: 'pull-request-commits' };\n",
    to: "      return { start: cur, head, evidence: 'pull-request-commits' };\n",
    why: 'a commit GitHub does not attribute to this pull request starts a landing of nothing',
    killed_by: [T_EV_NONE],
  },
  {
    id: 'L7', file: LANDING, tests: [T_O],
    from: "    if (!r.ok) return { start: null, head, evidence: 'gh-unavailable' };\n",
    to: "    if (!r.ok) return { start: cur, head, evidence: 'pull-request-commits' };\n",
    why: 'a failing forge reads as evidence of the start',
    killed_by: [T_EV_NONE],
  },
  {
    id: 'L10', file: POLICY, tests: [T_O],
    from: "  if (landing.ok === true && landing.landed_review?.state === 'different') {\n",
    to: '  if (false) {\n',
    why: 'a landing that differs is recorded done with no one told',
    killed_by: [T_LANDED_POLICY],
  },
  {
    id: 'L11', file: POLICY, tests: [T_O],
    from: "    rec.comparison && rec.comparison.state !== 'same' && rec.comparison.state !== 'no-reviews'\n",
    to: '    rec.comparison\n',
    why: 'a clean comparison is reported as a warning before the merge',
    killed_by: [T_REPORT],
  },
  {
    id: 'L12', file: DONE, tests: [T_D],
    from: '  if [ "$ACCEPT_LANDED" != true ]; then\n',
    to: '  if false; then\n',
    why: 'done records a landing that differs with no word from the owner',
    killed_by: [T_DONE],
  },
  {
    id: 'L13', file: DONE, tests: [T_D],
    from: '  LANDED_NOTE="Landed change not compared with its reviews: $LANDED_WHY."\n',
    to: '  LANDED_NOTE=""\n',
    why: 'a landing no one could compare leaves no trace in the macro',
    killed_by: [T_DONE_NC],
  },
  // ---- S: the subject's way from the agent's file to the record --------------
  {
    id: 'S1', file: 'plugins/engineer/commands/critique.md', tests: [T_RV],
    from: '  set -- --subject-file "$TEXT_DIR/subject.json"\n',
    to: '  set --\n',
    why: "the dispatch never passes the subject the agent wrote, so every launched review is unbound and every autopilot commit after one halts",
    killed_by: [T_SUBJECT('critique')],
  },
  {
    id: 'S2', file: 'plugins/engineer/commands/compose.md', tests: [T_RV],
    from: 'if [ -f "$TEXT_DIR/subject.json" ] && grep -q -e "\'--subject-file\'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then\n  set -- --subject-file',
    to: 'if [ -f "$TEXT_DIR/subject.json" ]; then\n  set -- --subject-file',
    why: 'the dispatch gives an older runner a flag it refuses, so a new runbook over an old install launches nothing',
    killed_by: [T_SUBJECT('compose')],
  },
  {
    id: 'S3', file: 'plugins/engineer/commands/compose.md', tests: [T_RV],
    from: 'if [ -f "$TEXT_DIR/subject.json" ] && grep -q -e "\'--subject-file\'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then\n  set -- --subject-file',
    to: 'if grep -q -e "\'--subject-file\'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then\n  set -- --subject-file',
    why: 'a dispatch with no subject file names one anyway',
    killed_by: [T_SUBJECT('compose')],
  },
  {
    id: 'S4', file: 'plugins/engineer/commands/compose.md', tests: [T_RV],
    from: '  set -- "$@" --subject-file "$TEXT_DIR/subject.json"\n',
    to: '  :\n',
    why: "compose's finalize drops what the local reviewers read",
    killed_by: [T_SUBJECT('compose')],
  },
  {
    id: 'S5', file: 'plugins/engineer/commands/critique.md', tests: [T_RV],
    from: '  set -- "$@" --subject-file "$TEXT_DIR/subject.json"\n',
    to: '  :\n',
    why: "critique's finalize drops what the local reviewers read",
    killed_by: [T_SUBJECT('critique')],
  },
  {
    id: 'S6', file: 'plugins/engineer/commands/refine.md', tests: [T_RV],
    from: '  set -- "$@" --subject-file "$TEXT_DIR/subject.json"\n',
    to: '  :\n',
    why: "refine's finalize drops what the local reviewers read",
    killed_by: [T_SUBJECT('refine')],
  },
  // ---- the refine of 2026-11-08 (critique of 2026-11-07) ---------------------------------
  {
    id: 'N4', file: STATE, tests: [T_P],
    from: "  const otherChange = (comparison.state === 'same' || comparison.state === 'different') && Array.isArray(change)\n",
    to: '  const otherChange = Array.isArray(change)\n',
    why: 'a comparison that read no counting review narrows the gate: an edit after a failed review commits with no review at all (CRITICAL 1)',
    killed_by: [T_NO_COUNT],
  },
  {
    id: 'I11', file: CI, tests: [T_P],
    from: "const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });\n",
    to: "const UTF8 = new TextDecoder('utf-8', { fatal: true });\n",
    why: 'a leading U+FEFF is stripped: a reviewed path and another path read as one (MAJOR 2)',
    killed_by: [T_BOM],
  },
  {
    id: 'D11', file: LIB, tests: [T_P],
    from: "    if (!COMPARISON_STATES.has(rec.state)) return `comparisons[${commit}].state is not a comparison's`;\n",
    to: '',
    why: 'a committed comparison with a state no comparison has is read as one',
    killed_by: [T_COMP_VALID],
  },
  {
    id: 'P13', file: CI, tests: [T_P],
    from: "    if (named === null && parents.length > 1 && parents.slice(1).every((p) => git(repoRoot, ['merge-base', '--is-ancestor', p, from]).ok)) continue;\n",
    to: '',
    why: 'a merge of main into the branch names no workflow: every lane that updated its branch reads not comparable, and autopilot refuses it (MAJOR 5)',
    killed_by: [T_MERGE_BASE],
  },
  {
    id: 'P14', file: CI, tests: [T_P],
    from: "    if (named === null && parents.length > 1 && parents.slice(1).every((p) => git(repoRoot, ['merge-base', '--is-ancestor', p, from]).ok)) continue;\n",
    to: '    if (named === null && parents.length > 1) continue;\n',
    why: "any merge is left out: a side branch's commits, which name no workflow, take their obligations away unseen",
    killed_by: [T_MERGE_BASE],
  },
  {
    id: 'P15', file: PHASE7, tests: [T_P],
    from: '    workflowPath, repoRoot, stderr, flags, paths: shape.commits.flatMap((c) => c.files), enforce: enforceSubjects,\n',
    to: '    workflowPath, repoRoot, stderr, flags, paths: shape.commits[0].files, enforce: enforceSubjects,\n',
    why: 'admission projects the first commit of a split only: the series is not judged whole, and a reviewed package reads left out (MAJOR 9)',
    killed_by: [T_SPLIT],
  },
  {
    id: 'L19', file: ORCH_STATE, tests: [T_O],
    from: "  if (evidence.start) args.push('--start', evidence.start);\n",
    to: '',
    why: 'resolve-landing never passes the start: every landing reads not comparable (MAJOR 10)',
    killed_by: [T_RESOLVE],
  },
  {
    id: 'L20', file: ORCH_STATE, tests: [T_O],
    from: "  if (evidence.head) args.push('--head', evidence.head);\n",
    to: '',
    why: 'resolve-landing never passes the head: no committed comparison is found, and a landing that differs is not refused',
    killed_by: [T_RESOLVE],
  },
  {
    id: 'L21', file: ORCH_STATE, tests: [T_O],
    from: "  if (owner) args.push('--child-workflow', owner);\n",
    to: '',
    why: "resolve-landing never names the child: a head with no comparison loses the child's reviews, and a fixup that differs is recorded",
    killed_by: [T_RESOLVE],
  },
  {
    id: 'S7', file: 'plugins/engineer/core/skills/critique/SKILL.md', tests: [T_P],
    from: '    --subject-file "$TEXT_DIR/subject.json" \\\n',
    to: '    ${TEXT_DIR:+--subject-file "$TEXT_DIR/subject.json"} \\\n',
    why: 'the subject flag is one word under zsh: the Codex settle of a review that never launched fails with Unknown argument (MAJOR 7)',
    killed_by: [T_ZSH],
  },
  {
    id: 'S8', file: 'plugins/engineer/core/skills/refine/SKILL.md', tests: [T_P],
    from: 'reviewers read: with your file-writing tool create `subject.json` in\n  `TEXT_DIR`, beside',
    to: 'reviewers read: with your file-writing tool create `subject.json`\n  beside',
    why: "the no-run bullet no longer says where the subject goes, while the block reads it from TEXT_DIR: a Codex review that never launched records no coverage and never binds (critique of 2026-11-08, sixth pass, MAJOR 4)",
    killed_by: [T_NO_RUN_SUBJECT_PROSE],
  },
  // ---- The refine of 2026-11-08 (critique of 2026-11-08) ----------------------
  {
    id: 'P16', file: CI, tests: [T_P],
    from: '      env: indexFile === null ? process.env : { ...process.env, GIT_INDEX_FILE: indexFile },\n',
    to: '      env: gitEnv(indexFile === null ? {} : { GIT_INDEX_FILE: indexFile }),\n',
    why: "the projection stages with no GIT_* variable while Phase 7's `git add` inherits them: a clean filter given through GIT_CONFIG_COUNT reaches the commit only, admission reads same, and autopilot commits past the review (MAJOR 1)",
    killed_by: [T_ENV_FILTER],
  },
  {
    id: 'P17', file: CI, tests: [T_P],
    from: "      if (nulList(flags.stdout).some((f) => f[0] === 'S' || f[0] === 's' || (f[0] >= 'a' && f[0] <= 'z'))) return none('index-flags');\n",
    to: '',
    why: "a path flagged assume-unchanged is projected from the file, while `git add` keeps the index's content: the commit is not the tree admission judged (MAJOR 2)",
    killed_by: [T_FLAGS],
  },
  {
    id: 'P18', file: CI, tests: [T_P],
    from: "      if (deleted.size > 0 && !on(['update-index', '--force-remove', '-z', '--stdin'], `${[...deleted].join('\\0')}\\0`).ok) return none('projection-failed');\n",
    to: '',
    why: 'a staged deletion keeps its HEAD entry in the projection, though Phase 7 commits the deletion: admission judges a tree the commit does not hold (MAJOR 2)',
    killed_by: [T_PARITY],
  },
  {
    id: 'P19', file: PHASE7, tests: [T_P],
    from: '    landed.push(`${sha} ${subject}`);\n    return null;\n',
    to: "    landed.push(`${sha} ${subject}`);\n    await recordCommittedComparison({ workflowPath, repoRoot, argument: flags['landing-branch'] ?? null, host: flags.host, writer: 'operation' });\n    return null;\n",
    why: 'a comparison is recorded after each commit of a series, so one stopped part way claims a change no review saw whole (Decision 3; MAJOR 5)',
    killed_by: [T_SERIES_STOP],
  },
  {
    id: 'P21', file: STATE, tests: [T_P],
    from: '  if (!existsSync(phase7)) return [...new Set([...manifestPathsOf(frontmatter), ...extras])];\n',
    to: '  if (true) return [...new Set([...manifestPathsOf(frontmatter), ...extras])];\n',
    why: "the engineer's observer and acceptance read the manifest's list, not the staging set Phase 7 derives: an acceptance records a key Phase 7 never computes (MAJOR 3)",
    killed_by: [T_IGNORED],
  },
  {
    id: 'P22', file: PHASE7, tests: [T_P],
    from: "    const binding = await reviewBindingCheck({ workflowPath, repoRoot, frontmatter, paths: staging, argument: flags['landing-branch'] ?? null, refresh: false });\n",
    to: "    const binding = await reviewBindingCheck({ workflowPath, repoRoot, frontmatter, paths: manifestPathsOf(frontmatter), argument: flags['landing-branch'] ?? null, refresh: false });\n",
    why: "execute's review warning narrows by a comparison of the manifest's list, not of the tree it commits: a failure of another edit warns though the change is the one reviewed (MAJOR 3)",
    killed_by: [T_IGNORED],
  },
  {
    id: 'P23', file: PHASE7, tests: [T_P],
    from: '  const reviewBinding = landsNothing ? null : await reviewBindingCheck({ workflowPath, repoRoot, frontmatter, paths: stagingSet, argument: landingBranch });\n',
    to: '  const reviewBinding = landsNothing ? null : await reviewBindingCheck({ workflowPath, repoRoot, frontmatter, paths: stagingSet });\n',
    why: 'the plan ignores --landing-branch, which execute takes: it reports a comparison execute will not make (critique of 2026-11-07, MINOR)',
    killed_by: [T_UNCHANGED],
  },
  {
    id: 'A4', file: STATE, tests: [T_P],
    from: '    const paths = await commitPathsOf({ repoRoot, frontmatter, extras });\n',
    to: '    const paths = [...new Set([...manifestPathsOf(frontmatter), ...extras])];\n',
    why: "the owner's acceptance is keyed by the manifest's list, an ignored file in it, so it never matches what Phase 7 compares, and never takes (MAJOR 3)",
    killed_by: [T_IGNORED],
  },
  {
    id: 'L25', file: CI, tests: [T_P],
    from: "    if (first === null || b === null || !first.equals(b)) return { file: null, reason: 'ambiguous' };\n",
    to: '',
    why: "the first copy of a workflow found is read: an active copy with an older review hides an archived one's later review, and a landing that differs reads the same (MAJOR 4)",
    killed_by: [T_AMBIGUOUS],
  },
  // Refine-verify of 2026-11-08 (pass 1).
  {
    id: 'P24', file: CI, tests: [T_P],
    from: "    if (!sameFiles(selected, own)) return none('repository-mismatch');\n",
    to: '',
    why: 'an inherited GIT_DIR and GIT_WORK_TREE select another repository: admission compares the checkout, reads same, and Phase 7 commits in the other one (F3)',
    killed_by: [T_REPO_SELECT],
  },
  {
    id: 'P25', file: CI, tests: [T_P],
    from: "        if (submodules.length > 0 && !on(['--literal-pathspecs', 'add', '--force', '--', ...submodules]).ok) return none('projection-failed');\n",
    to: "        if (submodules.length > 0 && !on(['--literal-pathspecs', 'add', '--', ...submodules]).ok) return none('projection-failed');\n",
    why: "a submodule set to ignore=all is skipped by the projection's `git add`, which Phase 7 forces: admission judges the old pin, the commit holds the new one",
    killed_by: [T_SUBMODULE_PARITY],
  },
  {
    id: 'L26', file: CI, tests: [T_P],
    from: '      if (name.startsWith(`${workflowId}-`) && ARCHIVE_SUFFIX.test(name.slice(workflowId.length)) && namesWorkflow(join(dir, name), workflowId)) copies.push(join(dir, name));\n',
    to: '',
    why: "an archive under a suffixed name is not seen: the older canonical archive answers alone, and a landing its later review shows differs reads the same (F4)",
    killed_by: [T_SUFFIXED],
  },
  {
    id: 'A5', file: STATE, tests: [T_P],
    from: "  if (typeof check.acceptance_key !== 'string') {\n",
    to: '  if (false) {\n',
    why: 'a comparison with no key offers an acceptance that can only fail (F7)',
    killed_by: [T_FLAGS],
  },
  // Refine-verify of 2026-11-08 (pass 2).
  {
    id: 'P26', file: PHASE7, tests: [T_P],
    from: "  if (binding.reason === 'repository-mismatch') {\n",
    to: '  if (false) {\n',
    why: 'interactively a repository the environment selects is a warning: execute commits in the other repository',
    killed_by: [T_REPO_SELECT],
  },
  {
    id: 'P27', file: CI, tests: [T_P],
    from: "    const where = ['--absolute-git-dir', '--show-toplevel'];\n",
    to: "    const where = ['--absolute-git-dir'];\n",
    why: "a work tree the environment selects alone is not seen: Phase 7 stages another directory's files over the checkout's repository",
    killed_by: [T_REPO_SELECT],
  },
  {
    id: 'P28', file: CI, tests: [T_P],
    from: "    if (!sameFiles(selected, own)) return none('repository-mismatch');\n",
    to: "    if (selected.join('\\n') !== own.join('\\n')) return none('repository-mismatch');\n",
    why: 'the checkout selected under another spelling of its path reads as another repository, and every commit is refused. Killed only on a case-insensitive filesystem (macOS): elsewhere the test has no second spelling to give',
    killed_by: [T_REPO_SELECT],
  },
  {
    id: 'L27', file: CI, tests: [T_P],
    from: '      if (name.startsWith(`${workflowId}-`) && ARCHIVE_SUFFIX.test(name.slice(workflowId.length)) && namesWorkflow(join(dir, name), workflowId)) copies.push(join(dir, name));\n',
    to: '      if (name.startsWith(`${workflowId}-`) && ARCHIVE_SUFFIX.test(name.slice(workflowId.length))) copies.push(join(dir, name));\n',
    why: "another workflow's canonical archive reads as a collision copy of a shorter id it begins with",
    killed_by: [T_SUFFIXED],
  },
  // Refine-verify of 2026-11-08 (pass 3).
  {
    id: 'L28', file: CI, tests: [T_P],
    from: "  if (id.startsWith('\"')) {\n",
    to: '  if (false) {\n',
    why: "a suffixed archive whose id is quoted and escaped reads as another workflow's, so its later review is dropped and a landing that differs reads the same",
    killed_by: [T_SUFFIXED],
  },
  {
    id: 'L29', file: CI, tests: [T_P],
    from: "      return { file: null, reason: 'unreadable' };\n",
    to: '      continue;\n',
    why: 'an archive home that cannot be read is taken as holding no copy: a differing copy in it is not seen, and the lookup claims one workflow',
    killed_by: [T_SUFFIXED],
  },
  {
    id: 'P29', file: CI, tests: [T_P],
    from: "    const stdout = execFileSync('git', ['-C', repoRoot, ...args], {\n      env: indexFile === null",
    to: "    const stdout = execFileSync('git', ['-C', repoRoot, ...args], {\n      cwd: repoRoot,\n      env: indexFile === null",
    why: 'a relative checkout path is applied twice, so an ordinary commit reads repository-mismatch and is refused',
    killed_by: [T_REPO_SELECT],
  },
  {
    id: 'P30', file: PHASE7, tests: [T_P],
    from: "  const noKey = binding.held && typeof binding.acceptance_key !== 'string' ? reviewBindingHoldText(binding, { workflowPath, extras }) : null;\n",
    to: '  const noKey = null;\n',
    why: "with a failed outcome beside a tree that cannot be projected, the refusal offers review-accept, which cannot be given until the cause is cleared",
    killed_by: [T_FLAGS],
  },
  // Critique of 2026-11-08, fourth pass.
  {
    id: 'L38', file: ORCH_STATE, tests: [T_D],
    from: '  if (overrides.length > 0 && isAutopilotRun(env)) {\n',
    to: '  if (false) {\n',
    why: "an autopilot worker reruns done with --accept-landed-change (or a waiver) and a reason it wrote, and the subtask completes as if the owner had said so",
    killed_by: [T_DONE, T_OVERRIDES_AUTOPILOT],
  },
  {
    id: 'L39', file: DONE, tests: [T_D],
    from: '[ "$ACCEPT_LANDED" = true ] && UPDATE_ARGS+=(--accept-landed-change)\n',
    to: '',
    why: "done never tells the write the owner's acceptance is given, so the write cannot refuse it under an autopilot run, and a worker's acceptance completes the subtask",
    killed_by: [T_DONE],
  },
  // Refine-verify of the fourth critique's refine.
  {
    id: 'L45', file: ARGS, tests: [T_CA],
    from: "    const clash = ['pr', 'commit', 'correct', 'accept-landed-change'].filter((name) => given.has(name));\n",
    to: "    const clash = ['pr', 'commit', 'correct'].filter((name) => given.has(name));\n",
    why: "done --no-commit --accept-landed-change is read, and the no-commit write drops the acceptance unread: the owner believes an acceptance was recorded where none was (the driver's postcondition, not this exclusion, halts a worker's no-commit done)",
    killed_by: [T_ARGS_REFUSE],
  },
  {
    id: 'L46', file: POLICY, tests: [T_POL],
    from: "      if (s.kind === 'done' && st?.status === 'completed' && !st.commit) return",
    to: "      if (false) return",
    why: 'a done step a worker completed with --no-commit, recording no landing and so no comparison of it, passes as done',
    killed_by: [T_DONE_POST],
  },
  // Critique of 2026-11-08, fifth pass.
  {
    id: 'L50', file: POLICY, tests: [T_POL],
    from: '      const st = subtaskIn(after, id);\n      // A done step is dispatched for a landing',
    to: '      if (after?.macro?.archived) return null;\n      const st = subtaskIn(after, id);\n      // A done step is dispatched for a landing',
    why: "done of the macro's last subtask archives the macro, and an archived macro passes before the no-commit check: a worker's --no-commit done of the last subtask completes the run with no landing compared",
    killed_by: [T_DONE_POST],
  },
];
