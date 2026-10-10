// Mutation spec — do the proposal tests catch the defects they exist for?
// (ADR-0067 Decision 8, items 2, 3 and 4: the lane advice at plan and
// approve, a worktree first at a persona start and at /orchestrator:next, and
// the autopilot launch's home-worktree setup)
//
// Run: npm run mutate -- scripts/mutation-specs/worktree-lane-proposals.mjs
//
// Each proposal is display only, so a broken one fails quietly: a command the
// autopilot would refuse shown as runnable, a worktree that cannot find its
// macro, a path a shell splits, a proposal on a checkout where none applies,
// or one that never reaches the screen. Each mutation breaks one rule and
// names the test that must notice.
//
// Groups: L the lane advice, W the /orchestrator:next worktree, P the launch
// proposals, R the runbooks that print them, G the persona start.

const TL = 'tests/orchestrator/test-lane-advice.mjs';
const TW = 'tests/orchestrator/test-worktree-proposal.mjs';
const TP = 'tests/orchestrator/test-autopilot-launch-proposals.mjs';
const TC = 'tests/orchestrator/test-autopilot-cli.mjs';
const TA = 'tests/orchestrator/test-approve-runbook.mjs';
const TE = 'tests/plugin-shape/test-engineer-start.mjs';
const TD = 'tests/persona-pipeline/test-discover-runtime-worktree.mjs';
const TDRV = 'tests/orchestrator/test-autopilot-driver.mjs';
const TRC = 'tests/persona-pipeline/test-runbook-contracts.mjs';

const LIB = 'plugins/orchestrator/scripts/lib';
const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const ADVICE = `${LIB}/lane-advice.mjs`;
const WT = `${LIB}/worktree-proposal.mjs`;
const LAUNCH = `${AP}/launch-proposals.mjs`;

export const TESTS = [TL, TW, TP, TC, TA, TE, TD, TDRV, TRC];

export const MUTATIONS = [
  // ---- L: the lane advice ---------------------------------------------------
  {
    id: 'L1', file: ADVICE, tests: [TL],
    from: "  } else if (sharedCreation !== 'on') {",
    to: '  } else if (false) {',
    why: 'the command is shown while shared creation is off, where the autopilot refuses lanes',
    killed_by: [/the command is withheld, and the line names the cutover/, /the cutover first while shared creation is off/],
  },
  {
    id: 'L2', file: ADVICE, tests: [TL],
    from: '  } else if (!macroUnderDefaultRoot) {',
    to: '  } else if (false) {',
    why: "the command is shown for a macro in a linked worktree's own home, which no lane reads",
    killed_by: [/the command is withheld, and the line names the cutover/, /linked worktree's own home gets no command/],
  },
  {
    id: 'L3', file: ADVICE, tests: [TL],
    from: '  const upTo = Math.min(cap, width);',
    to: '  const upTo = width;',
    why: 'the advice names as many lanes as the widest ready set, past the owner\'s default',
    killed_by: /never names more lanes than the cap/,
  },
  {
    id: 'L4', file: ADVICE, tests: [TL],
    from: "    if (!s || s.status === 'deferred' || s.status === 'abandoned' || seen.has(id)) return false;",
    to: '    if (!s || seen.has(id)) return false;',
    why: 'a subtask behind a deferred one counts as runnable, so the advice promises steps that never run',
    killed_by: /a subtask behind a deferred, abandoned or missing one never runs/,
  },
  {
    id: 'L5', file: ADVICE, tests: [TL],
    from: '  if (best === 1) return { show: false };',
    to: '',
    why: 'a chain, which two lanes do not shorten, is advised to run in lanes',
    killed_by: /a chain, where two lanes shorten nothing, gives no advice/,
  },

  // ---- W: the /orchestrator:next worktree -----------------------------------
  {
    id: 'W1', file: WT, tests: [TW],
    from: "  return SHARED_HOMES.filter((h) => h.plugin === 'orchestrator').some((h) => isWithin(real, realOr(path.join(root, h.rel))));",
    to: '  return true;',
    why: "a worktree is proposed for a macro in a linked worktree's own home, which the new worktree would not find",
    killed_by: /a macro in a linked worktree's own home: no worktree, and the cutover named/,
  },
  {
    id: 'W2', file: WT, tests: [TW],
    from: "    if (holder && realOr(holder) === realOr(top)) {\n      return { proposed: false, reason: `${branch} is checked out in this checkout, so its changes",
    to: "    if (false) {\n      return { proposed: false, reason: `${branch} is checked out in this checkout, so its changes",
    why: 'with the subtask branch checked out here, the proposal sends the user back to this same checkout',
    killed_by: /held by this checkout: no worktree helps/,
  },
  {
    id: 'W3', file: WT, tests: [TW],
    from: "  return /^[A-Za-z0-9_./:@=+-]+$/.test(text) ? text : `'${text.replaceAll(\"'\", \"'\\\\''\")}'`;",
    to: '  return text;',
    why: 'a path with a space or an apostrophe goes into the command unquoted, and the shell splits it',
    killed_by: /a checkout path with a space and an apostrophe is quoted/,
  },
  {
    id: 'W4', file: WT, tests: [TW],
    from: '`${git} worktree add --no-track -b ${branch} ${shellQuote(where)} refs/remotes/origin/${baseline}`',
    to: '`${git} worktree add -b ${branch} ${shellQuote(where)} refs/remotes/origin/${baseline}`',
    why: 'the new branch tracks the integration branch, which next.md never sets up',
    killed_by: /with origin: the fetch first, then --no-track/,
  },
  {
    id: 'W5', file: WT, tests: [TW],
    from: "  if (status === 'in_progress' && isPlainBranch(branch)) {",
    to: '  if (false) {',
    why: "an in-progress subtask's own branch held here gets \"no worktree helps\", and the ordinary resume of its workflow is never selected (M5)",
    killed_by: [/held by this checkout with the subtask in progress: the ordinary resume/, /reads the subtask's status: in progress on the branch held here, the resume/],
  },
  {
    id: 'W7', file: WT, tests: [TW],
    from: "  if (status === 'in_progress' && isPlainBranch(branch)) {",
    to: "  if (status === 'in_progress' && isPlainBranch(branch) && macroInDefaultRoot(top, macroPath)) {",
    why: "the resume here waits on the macro's visibility from other worktrees, which continuing in this checkout does not need, so a macro in a linked worktree's own home loses it (M5)",
    killed_by: /the resume here needs no other worktree/,
  },
  {
    id: 'W6', file: 'plugins/orchestrator/scripts/state.mjs', tests: [TW],
    from: '          subtaskId: subtask.id, branch: subtask.branch, baseline: frontmatter?.git_baseline?.branch, status: subtask.status, host,',
    to: '          subtaskId: subtask.id, branch: subtask.branch, baseline: frontmatter?.git_baseline?.branch, host,',
    why: "the CLI never hands over the subtask's status, so the runbook never selects the resume (M5)",
    killed_by: /reads the subtask's status: in progress on the branch held here, the resume/,
  },

  // ---- P: the launch proposals ----------------------------------------------
  {
    id: 'P1', file: LAUNCH, tests: [TP, TC],
    from: '  if (top !== main) return null;',
    to: '',
    why: 'a run launched from a linked worktree is told to move to a home worktree it may already be',
    killed_by: [/absent from a linked worktree/, /from a linked worktree it proposes none/],
  },
  {
    id: 'P2', file: LAUNCH, tests: [TP],
    from: '  const inside = PLUGINS.filter((p) => roots[p] && isWithin(canonical(roots[p]), top));',
    to: '  const inside = PLUGINS.filter((p) => roots[p]);',
    why: 'roots outside the repository are treated as inside it, and a setup is proposed for no refusal',
    killed_by: /absent when every root lies outside the repository/,
  },
  {
    id: 'P3', file: LAUNCH, tests: [TP],
    from: "  let homePath = existingHome(main, resolve(dirname(main), `${basename(main)}-${HOME_SLUG}`));",
    to: '  let homePath = null;',
    why: 'an existing home worktree is not reused: the proposal adds a second checkout at its path, which git refuses',
    killed_by: /launched on the main checkout, serial/,
  },
  {
    id: 'P4', file: `${AP}/cli.mjs`, tests: [TC],
    from: '    for (const line of proposalLines(proposals)) out(line);',
    to: '',
    why: 'preview computes the proposals but never prints them',
    killed_by: /preview on the main checkout proposes the home worktree/,
  },
  {
    id: 'P5', file: `${AP}/driver.mjs`, tests: [TC],
    from: '    for (const line of proposalLines(proposals)) err(line);',
    to: '',
    why: 'start refuses roots inside the repository with no setup to fix it',
    killed_by: /start refuses an engineer root inside the repository, with the pinned setup/,
  },
  {
    id: 'P6', file: `${AP}/roots.mjs`, tests: [TP, TC],
    from: "export const ROOT_MARKERS = Object.freeze({ orchestrator: 'scripts/state.mjs', engineer: 'scripts/state.mjs', runtime: 'scripts/footer.mjs' });",
    to: "export const ROOT_MARKERS = Object.freeze({ orchestrator: 'scripts/state.mjs', engineer: 'scripts/state.mjs', runtime: 'scripts/state.mjs' });",
    why: 'runtime is looked for by a file it does not ship, so a real install never yields a pinned setup (C1)',
    killed_by: [/the installed cache: the newest manifest-verified release carrying its resolver's file/, /preview on the main checkout proposes the home worktree/],
  },
  {
    id: 'P7', file: LAUNCH, tests: [TP],
    from: '      if (existsSync(at) && sameDirectory(at, homePath)) return canonical(at);',
    to: '',
    why: 'a home worktree a serial run left on a subtask branch is not found, and the proposal adds a worktree at its occupied path (M4)',
    killed_by: /launched on the main checkout, serial/,
  },
  {
    id: 'P8', file: LAUNCH, tests: [TP, TC],
    from: '    if (p.note) lines.push(`  (${p.note})`);',
    to: '',
    why: 'the pinned setup is shown as if the pins alone fixed a directory marketplace in this checkout (M3)',
    killed_by: [/roots inside the repository, with every plugin installed/, /start refuses an engineer root inside the repository/],
  },
  {
    id: 'P9', file: `${AP}/driver.mjs`, tests: [TC],
    from: '      ? launchProposals({ repoRoot, view: refusedView, options: { ...options, lanes }, roots: pre.roots.roots, env, home: env.HOME || homedir() })',
    to: "      ? launchProposals({ repoRoot, view: refusedView, options: { ...options, lanes }, roots: pre.roots.roots, env, home: env.HOME || homedir() }).filter((p) => p.trigger !== 'main-checkout')",
    why: "start's refusal judges only the roots trigger, and never names the home worktree a directory marketplace here leaves runnable (M3)",
    killed_by: /start refuses an engineer root inside the repository, with the pinned setup and, on the main checkout, the home worktree/,
  },
  {
    id: 'P11', file: `${AP}/driver.mjs`, tests: [TC],
    from: '        refusedView = observe({ repoRoot, roots: pre.roots.roots, macroId: options.macro ?? null, fetch: false, env });',
    to: '        refusedView = null;',
    why: "start's refusal looks no macro up, so a run started without --macro gets a home command with none, which the home cannot find by its branch",
    killed_by: /start refuses an engineer root inside the repository, with the pinned setup and, on the main checkout, the home worktree/,
  },
  {
    id: 'P12', file: LAUNCH, tests: [TP],
    from: "  if (!MACRO_ID_RE.test(String(macroId ?? ''))) {",
    to: '  if (false) {',
    why: 'a home command naming no macro is shown as runnable, and the home worktree, on autopilot/home, finds none',
    killed_by: /names no command without a macro to name/,
  },
  {
    id: 'P13', file: LAUNCH, tests: [TP],
    from: '  return [rootsInRepoProposal({ ...a, homeNamed: Boolean(onMain?.command) }), onMain].filter(Boolean);',
    to: '  return [rootsInRepoProposal({ ...a, homeNamed: true }), onMain].filter(Boolean);',
    why: 'the roots note points at a home-worktree command the main-checkout proposal did not give (no macro, no install)',
    killed_by: /roots inside the repository, with every plugin installed/,
  },
  {
    id: 'P10', file: `${AP}/driver.mjs`, tests: [TDRV],
    from: '  for (const line of proposalLines(onMain ? [onMain] : [])) out(line);',
    to: '',
    why: 'start on the main checkout computes the home-worktree proposal and never prints it',
    killed_by: /on the main checkout, start proposes the home worktree pinned to the installed cache, then runs/,
  },

  // ---- R: the runbooks that print them --------------------------------------
  {
    id: 'R1', file: 'plugins/orchestrator/commands/next.md', tests: [TW],
    from: '    --host claude --format text >&2 || true',
    to: '    --host claude --format text >/dev/null || true',
    why: "next.md's dirty refusal never shows the worktree",
    killed_by: /next\.md's Phase 2 refuses a dirty tree with the worktree first/,
  },
  {
    id: 'R2', file: 'plugins/orchestrator/commands/plan.md', tests: [TA],
    from: '  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --format line',
    to: '  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --format line >/dev/null',
    why: "plan's Phase 2 computes the lane advice and drops it",
    killed_by: /plan's Phase 2 prints the line for side-by-side subtasks/,
  },
  {
    id: 'R3', file: 'plugins/orchestrator/commands/approve.md', tests: [TA],
    from: '  --workflow-path "$MACRO_PATH" --repo-root "$REPO_ROOT" --format line',
    to: '  --workflow-path "$MACRO_PATH" --repo-root "$REPO_ROOT" --format line >/dev/null',
    why: 'approve drops the lane advice',
    killed_by: /approve prints the line after the approval/,
  },

  // ---- G: the persona start -------------------------------------------------
  {
    id: 'G1', file: 'plugins/engineer/commands/start.md', tests: [TE],
    from: '      --task "$FEATURE" --base "$BASE_BRANCH" --host "${AGENTIC_HOST:-claude}" --format text >&2',
    to: '      --task "$FEATURE" --host "${AGENTIC_HOST:-claude}" --format text >&2',
    why: "the dirty refusal plans the worktree from origin/main whatever the request's --base-branch",
    killed_by: /the Layer 1 gate selects a worktree first/,
  },
  {
    id: 'G2', file: 'plugins/engineer/scripts/discover-runtime.mjs', tests: [TD],
    from: '  if (report.recommendation.blocked) return { command: null, reason: `runtime:worktree plan is blocked: ${report.recommendation.reason}` };',
    to: '',
    why: "a blocked plan's reason (an existing branch, an occupied path) is lost: the line blames the planner's output instead",
    killed_by: /engineer: discover-runtime\.mjs worktree-plan > names the reason, with no command, when the planner blocks/,
  },
  {
    id: 'G3', file: 'plugins/engineer/scripts/discover-runtime.mjs', tests: [TD],
    from: "  return /^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : `'${text.replaceAll(\"'\", \"'\\\\''\")}'`;",
    to: '  return text;',
    why: 'a typed base reaches the pasted command unquoted, and a shell runs what it holds (M1)',
    killed_by: /engineer: discover-runtime\.mjs worktree-plan > quotes every word of the command from the planner's argv/,
  },
  {
    id: 'G4', file: 'plugins/founder/scripts/discover-runtime.mjs', tests: [TD],
    from: "        if (capabilityOn('commit_surface')) {",
    to: '        if (true) {',
    why: "engineer's --base-branch grammar is applied to a founder request, which its start takes whole",
    killed_by: /founder: discover-runtime\.mjs worktree-plan > reads the request from an args file in the start's own grammar/,
  },
  {
    id: 'G5', file: 'plugins/founder/commands/start.md', tests: [TRC],
    from: '    echo "→ Proposed: a new worktree first, which leaves this checkout\'s changes where they are: run the worktree block (the active-workflow section) with the request in an args file; it prints the git worktree add command." >&2',
    to: '    node "$CLAUDE_PLUGIN_ROOT/scripts/discover-runtime.mjs" worktree-plan --repo-root "$REPO_ROOT" --task "${AGENTIC_TOPIC:-<the original request described above>}" --format text >&2',
    why: "the founder bootstrap's dirty refusal puts the typed request back into shell source (M2)",
    killed_by: /founder\/commands\/start\.md \(committed\) > start bootstrap, run: only a clean or accepted baseline creates the workflow/,
  },
  {
    id: 'G6', file: 'plugins/engineer/core/skills/start/SKILL.md', tests: [TE],
    from: '--args-file <path> --host codex --format text` prints the runtime:worktree',
    to: '--task <the description> --host codex --format text` prints the runtime:worktree',
    why: 'the Codex sequence passes the description on a command line, which ADR-0059 forbids (M2)',
    killed_by: /the Layer 1 gate selects a worktree first/,
  },
];
