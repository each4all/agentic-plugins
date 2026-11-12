// Mutation spec — do the landing preparation helper's tests catch the defects
// its gates exist for (ADR-0062, amendment of 2026-11-11)?
//
// Run: npm run mutate -- scripts/mutation-specs/land-prepare.mjs
//
// Each case removes one gate that fails quietly: a push over a remote someone
// else moved, CI read from an older commit, a rebase that dropped a commit, a
// ref moved under a worktree that has the branch checked out, a run inside an
// autopilot step, a dry run that acts, a push with no committed comparison
// recorded, an inherited GIT_DIR that leads the scratch rebase to the checkout,
// a lineage that forgets its earlier pairs, a push to another repository than
// the one read, a Release-As line in a pull request body.

const T_PLAN = 'tests/orchestrator/test-land-prepare-plan.mjs';
const T_CLI = 'tests/orchestrator/test-land-prepare.mjs';

const LIB = 'plugins/orchestrator/scripts/lib/land-prepare-plan.mjs';
const CLI = 'plugins/orchestrator/scripts/land-prepare.mjs';

export const TESTS = [T_PLAN, T_CLI];

export const MUTATIONS = [
  {
    id: 'L1', file: LIB, tests: [T_PLAN, T_CLI],
    from: "  return `origin's branch is at ${remote.slice(0, 12)}",
    to: "  return null; `origin's branch is at ${remote.slice(0, 12)}",
    why: 'a remote branch someone else moved is accepted, and the push replaces their commit',
  },
  {
    id: 'L2', file: LIB, tests: [T_PLAN, T_CLI],
    from: '.filter((r) => r && r.headSha === head);',
    to: '.filter((r) => r);',
    why: 'a CI run on an older commit decides the readiness of the current head',
  },
  {
    id: 'L3', file: CLI, tests: [T_CLI],
    from: "      if (problem) refuse('rebase-changed-series',",
    to: "      if (false) refuse('rebase-changed-series',",
    why: 'a rebase that dropped a commit already upstream moves the branch',
  },
  {
    id: 'L4', file: CLI, tests: [T_CLI],
    from: '      else if (field === `branch refs/heads/${branch}` && at !== null) out.push(at);',
    to: '      else if (field === `branch refs/heads/${branch}` && at !== null) void at;',
    why: 'the branch ref moves while a worktree has it checked out, leaving its index behind (both checks)',
  },
  {
    id: 'L5', file: CLI, tests: [T_CLI],
    from: "  if (typeof env.AGENTIC_AUTOPILOT === 'string' && env.AGENTIC_AUTOPILOT !== '') {",
    to: '  if (false) {',
    why: 'the helper pushes from inside an autopilot step, past the worker no-push boundary',
  },
  {
    id: 'L6', file: CLI, tests: [T_CLI],
    from: '    if (!execute) break;',
    to: '    void 0;',
    why: 'a dry run rebases, pushes and opens a pull request',
  },
  {
    id: 'L7', file: CLI, tests: [T_CLI],
    from: "      if (!r.ok || !out || out.recorded !== true || out.commit !== commit) {",
    to: "      if (!out) {",
    why: 'a committed comparison the engineer did not record still lets the branch be pushed',
  },
  {
    id: 'L8', file: CLI, tests: [T_CLI],
    from: '  for (const k of SELECTOR_VARS) delete out[k];',
    to: '  void SELECTOR_VARS;',
    why: 'an inherited GIT_DIR points the scratch rebase at the checkout',
  },
  {
    id: 'L9', file: CLI, tests: [T_CLI],
    from: 'pairs.push({ before: r.before, after: r.after });',
    to: 'pairs.splice(0, pairs.length, { before: r.before, after: r.after });',
    why: 'the lineage keeps only its last pair, so a recorded rebase whose ref move never happened makes every later run refuse remote-moved (critique F2)',
  },
  {
    id: 'L10', file: CLI, tests: [T_CLI],
    from: "    if (problem && execute) refuse('push-destination',",
    to: "    if (false) refuse('push-destination',",
    why: 'a pushurl or url rewrite sends the push to another repository than the one whose pull request and CI are read (critique F3)',
  },
  {
    id: 'L11', file: LIB, tests: [T_PLAN],
    from: '    if (RELEASE_AS_RE.test(bare)) return',
    to: '    if (false) return',
    why: 'a Release-As line in a pull request body reaches the squash message, and release-please overrides the version (critique F4)',
  },
  {
    id: 'L12', file: CLI, tests: [T_CLI],
    from: '      const text = squashText(pr);',
    to: '      const text = effectiveText(commits);',
    why: "the printed squash command takes this invocation's inputs or the commit's text instead of the pull request the owner reviewed (critique round 2, G1)",
  },
  {
    id: 'L13', file: CLI, tests: [T_CLI],
    from: '        pr = prAgain.pr;\n',
    to: '        void prAgain;\n',
    why: 'the squash text comes from the pull request as read before this run edited it, so an override passed to an open pull request misses the squash command (refine-verify of G1)',
  },
];
