// Mutation spec — do the verify-record-cli tests catch the defects they exist
// for? (ADR-0068 Decision 5, items 2, 5 to 7, 10 and 11)
//
// Run: npm run mutate -- scripts/mutation-specs/verify-record.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. A request is the one place a step's own text
// meets the driver's process table: a path check that does not run, an offer
// that is not checked, or a result that can be overwritten each fails where no
// one looks — the driver runs a check it should have refused, a step writes a
// kind no driver will take, or a failure is replaced by a pass. And on the
// orchestrator side, a refusal that drains only a lane lets another lane's
// forced step start beside a run whose footing is wrong.
//
// Groups: D the declaration and its arguments, Q the request, R the driver's
// records, A the attempt mark, the confidence and a later release's records,
// E reading the evidence, O the orchestrator.
//
// The persona tests are parametrized (ADR-0066 Stage 3): the edits go to
// engineer's generated copies, so only its cases see them.

const T_DECL = 'tests/persona-pipeline/test-verify-declaration.mjs';
const T_REC = 'tests/persona-pipeline/test-verify-record.mjs';
const T_ORCH = 'tests/orchestrator/test-autopilot-verify-refusal.mjs';
const T_DEAD = 'tests/orchestrator/test-autopilot-dead-runs.mjs';
const T_REF = 'tests/persona-pipeline/test-reference-contracts.mjs';
const T_PR = 'tests/persona-pipeline/test-peer-runner.mjs';
const T_WORK = 'tests/orchestrator/test-autopilot-worker.mjs';

const STATE = 'plugins/engineer/scripts/state.mjs';
const LIB = 'plugins/engineer/scripts/lib/verify.mjs';
const PEER = 'plugins/engineer/scripts/peer-runner.mjs';
const CONTRACT = 'plugins/engineer/core/skills/_shared/references/entry-routing-contract.md';
const AP = 'plugins/orchestrator/adapters/claude/autopilot';

export const TESTS = [T_DECL, T_REC, T_ORCH, T_PR, T_WORK];

export const MUTATIONS = [
  // ---- D: the declaration and its arguments --------------------------------
  {
    id: 'D1', file: LIB, tests: [T_DECL, T_REC],
    from: '        if (tree !== null) {',
    to: '        if (false) {',
    why: 'a path argument that names no file of the tested tree reaches the driver',
    killed_by: [/a path that names no file of the tested tree/, /refused for an argument that is not a file of the tree/],
  },
  {
    id: 'D2', file: LIB, tests: [T_DECL, T_REC],
    from: "  if (value.startsWith('-')) return 'begins with -';\n",
    to: '',
    why: 'an argument beginning with - is taken, and a command reads it as an option',
    killed_by: /a leading - is refused where no other rule would refuse it/,
  },
  {
    id: 'D3', tests: [T_DECL],
    // lstat of a link is never a regular file, so the link rule alone is
    // backed by the file rule (an equivalent mutation): both go.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: LIB, from: "  if (st.isSymbolicLink()) return 'is a symbolic link';\n", to: '' });
      applyEdit(copy, { file: LIB, from: "  if (!st.isFile()) return 'is not a regular file';\n", to: '' });
    },
    why: 'a link in the tree is followed, so a check can be pointed at any file',
    killed_by: /a symbolic link, and one whose target leaves the tree/,
  },
  {
    id: 'D3b', file: LIB, tests: [T_DECL],
    from: "  if (!st.isFile()) return 'is not a regular file';\n",
    to: '',
    why: 'a directory named like a test file is taken for one',
    killed_by: /a directory is not a file/,
  },
  {
    id: 'D4', file: LIB, tests: [T_DECL],
    from: '  if (twice !== null) fail(',
    to: '  if (false) fail(',
    why: 'a kind declared twice is silently shadowed by the second',
    killed_by: /a kind named twice/,
  },
  {
    id: 'D5', file: LIB, tests: [T_DECL],
    from: '  if (!Number.isInteger(kind.timeout_s) || kind.timeout_s < 1 || kind.timeout_s > MAX_CHECK_TIMEOUT_S) {',
    to: '  if (!Number.isInteger(kind.timeout_s) || kind.timeout_s < 1) {',
    why: 'a check may run longer than the 4 hours item 3 bounds it to',
    killed_by: /a timeout over 4 hours, or none/,
  },
  {
    id: 'D6', file: LIB, tests: [T_DECL],
    from: "    if (!kind.slots.some((s) => s.name === name)) fail(`${where}: no slot ${JSON.stringify(name)}`);",
    to: '',
    why: 'an argument no slot takes is dropped unseen — test-suite given files runs the whole suite instead',
    killed_by: /a missing slot, an extra slot/,
  },

  // ---- Q: the request ---------------------------------------------------------
  {
    id: 'Q0a', file: STATE, tests: [T_REF],
    from: "export const PROPOSAL_NEXT_STEP_KINDS = new Set([...VALID_NEXT_STEP_KINDS].filter((k) => k !== 'verify'));",
    to: 'export const PROPOSAL_NEXT_STEP_KINDS = new Set([...VALID_NEXT_STEP_KINDS]);',
    why: 'verify counts as a proposal kind, so an agent may map a selected_next onto a kind finish-verb takes only from a request file',
    killed_by: /the owner-gates and next-step tables agree with this persona's state\.mjs/,
  },
  {
    id: 'Q0b', tests: [T_REF],
    // The contract table documents verify and the proposal kinds follow it:
    // the table and the kinds agree, so only the pin that verify is no
    // proposal kind catches it.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, {
        file: STATE,
        from: "export const PROPOSAL_NEXT_STEP_KINDS = new Set([...VALID_NEXT_STEP_KINDS].filter((k) => k !== 'verify'));",
        to: 'export const PROPOSAL_NEXT_STEP_KINDS = new Set([...VALID_NEXT_STEP_KINDS]);',
      });
      applyEdit(copy, {
        file: CONTRACT,
        from: '| `done` | `done` | absent |\n',
        to: '| `done` | `done` | absent |\n| `verify` | `verify` | absent |\n',
      });
    },
    why: 'the contract offers verify as a selected_next before any runbook passes a request (ADR-0059 order)',
    killed_by: /the owner-gates and next-step tables agree with this persona's state\.mjs/,
  },
  {
    id: 'Q1', file: STATE, tests: [T_REC],
    from: '  if (!mode.active) {\n    return { on: false, missing: mode.ignored',
    to: '  if (false) {\n    return { on: false, missing: mode.ignored',
    why: 'a step on Codex, or of a persona that is no dispatch target, may write verify, and nothing would ever run it',
    killed_by: /the offer is off on Codex, and for a commit that is not 40 hex/,
  },
  {
    id: 'Q2', file: STATE, tests: [T_REC],
    from: "  if (!COMMIT_SHA_RE.test(commit)) {",
    to: '  if (false) {',
    why: 'a commit-ish that is not the run\'s 40-hex baseline (a short id, HEAD) is taken as the offer',
    killed_by: /the offer is off on Codex, and for a commit that is not 40 hex/,
  },
  {
    id: 'Q3', file: STATE, tests: [T_REC],
    from: "  if (fields.next_step_kind === 'verify' && !allowVerify) {",
    to: '  if (false) {',
    why: 'append or set-terminal writes verify again after Phase 0 took the request up, and reopens the driver\'s writes with no offer',
    killed_by: /a request revived after Phase 0's clear/,
  },
  {
    id: 'Q4', file: STATE, tests: [T_REC],
    from: "  if (branch !== frontmatter.git_baseline?.branch) {",
    to: '  if (false) {',
    why: "a request is bound to a checkout on another branch, so its tree is not the workflow's",
    killed_by: /refused from another repository, and from a checkout on another branch/,
  },
  {
    id: 'Q5', file: STATE, tests: [T_REC],
    from: "        previous: stored ? previousOf(stored, frontmatter.verify_results) : null,",
    to: '        previous: null,',
    why: "the replaced request's last batch is lost, so verify-exec cannot tell a repeat on an unchanged tree",
    killed_by: /keeps the old last batch as previous/,
  },
  {
    id: 'Q6', file: STATE, tests: [T_REC],
    from: '  if (order < 0) {',
    to: '  if (false) {',
    why: "a late retry of an older step rolls the stored request back over a newer step's",
    killed_by: /a stale attempt records nothing/,
  },
  {
    id: 'Q6b', file: STATE, tests: [T_REC],
    from: '  if (bound && request && mark.requested === true && since !== null) {',
    to: '  if (false) {',
    why: "a step that recorded a request and then ended with commit retries its request late, and writes verify again (after the verb's Phase 0 took it up, the digest refuses it all the same)",
    killed_by: /every write of the next step under the offer is held to the mark/,
  },
  {
    id: 'Q13', file: STATE, tests: [T_REC],
    from: '  if (dropVerify) for (const k of VERIFY_RECORD_KEYS) delete frontmatter[k];',
    to: '  if (dropVerify) for (const k of VERIFY_KEYS) delete frontmatter[k];',
    why: 'the attempt mark goes with the dropped request, so a late retry turns a commit handoff back into verify',
    killed_by: [/a stale attempt records nothing/, /another next step drops the request and its results/],
  },
  {
    id: 'Q15', file: STATE, tests: [T_REC],
    from: '    if (!(order <= 0) || (pending && order === 0 && mark.requested !== true)) {',
    to: '    if (false) {',
    why: 'a hand-edited mark older than the request lets an older step replace it',
    killed_by: /the parser refuses what does not hold together/,
  },
  {
    id: 'Q9', file: LIB, tests: [T_REC],
    from: '  if (long !== undefined) fail(',
    to: '  if (false) fail(',
    why: 'a request is recorded that no batch can start, its comma-joined ids longer than a word a batch runs',
    killed_by: /a request whose check would resolve to a word longer than a batch runs/,
  },
  {
    id: 'Q10', file: STATE, tests: [T_REC],
    from: "    return execFileSync('git', ['--no-replace-objects', '-C', cwd, ...args],",
    to: "    return execFileSync('git', ['-C', cwd, ...args],",
    why: 'a replace ref stands in for the baseline commit, so the step widens the declaration it is checked against',
    killed_by: /the declaration is read without replace refs or an inherited git environment/,
  },
  {
    id: 'Q11', file: STATE, tests: [T_REC],
    from: "  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));",
    to: '  const env = process.env;',
    why: 'an inherited GIT_DIR points the declaration read at another repository',
    killed_by: /the declaration is read without replace refs or an inherited git environment/,
  },
  {
    id: 'Q12', file: LIB, tests: [T_REC],
    from: '      if (pathProblem(v) !== null && idProblem(v) !== null) return',
    to: '      if (false) return',
    why: 'a hand-written request holds an option for an argument, and the parser reads it as the persona\'s own',
    killed_by: /the parser refuses what does not hold together/,
  },
  {
    id: 'Q7', file: STATE, tests: [T_REC],
    from: '  if (dropVerify) for (const k of VERIFY_RECORD_KEYS) delete frontmatter[k];\n',
    to: '',
    why: 'a verb that ends with another next step keeps a stale request and its results',
    killed_by: /another next step drops the request and its results/,
  },
  {
    id: 'Q8', file: STATE, tests: [T_REC],
    from: "  frontmatter.host_history = [...(frontmatter.host_history ?? []), { host, at: nowIso, event: 'updated' }];",
    to: "  frontmatter.host_history = [...(frontmatter.host_history ?? []), { host, at: nowIso, event: 'verify' }];",
    why: 'a verify write records an event an older reader refuses for good',
  },

  // ---- R: the driver's records -------------------------------------------------
  {
    id: 'R1', tests: [T_REC],
    // The cross-key check of the whole record (results are their request's)
    // backs the pending-request binding: both go, so a replaced request's
    // batch start is written.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: '  if (frontmatter.verify_request.id !== requestId) {', to: '  if (false) {' });
      applyEdit(copy, { file: STATE, from: "    if (!('verify_request' in fm) || fm.verify_results.request_id !== fm.verify_request.id) {", to: "    if (!('verify_request' in fm)) {" });
    },
    why: "a replaced request's driver writes into the new request's results",
    killed_by: /a new request deletes the old results/,
  },
  {
    id: 'R2', file: STATE, tests: [T_REC],
    from: "  if (frontmatter.next_step_kind !== 'verify' || frontmatter.verify_request === undefined) {",
    to: '  if (frontmatter.verify_request === undefined) {',
    why: "a delayed write lands after the requesting verb's Phase 0 took the request up",
    killed_by: /Phase 0's clear keeps them readable and unwritable/,
  },
  {
    id: 'R3', file: LIB, tests: [T_REC],
    from: '  if (checksDigest(checks.map((c) => c.argv)) !== input.checks_digest) {',
    to: '  if (false) {',
    why: "a batch's identity is whatever the driver claims, not its commands",
    killed_by: /a batch start: digest recomputed/,
  },
  {
    id: 'R4', file: STATE, tests: [T_REC],
    from: "      if (same(stored, result)) return 'unchanged';\n",
    to: '',
    why: "a driver's replay after a crash is refused, and its recovery stops",
    killed_by: [/an identical replay is a no-op/, /two processes recording the same result leave one record/],
  },
  {
    id: 'R5', file: STATE, tests: [T_REC],
    from: "      throw new Error(`check ${result.index} of batch ${batchId} already has a result; a result is never overwritten`);",
    to: "      Object.assign(stored, result);\n      return 'changed';",
    why: 'a recorded result is overwritten — a failure can become a pass',
    killed_by: /a different record is refused, never overwritten/,
  },
  {
    id: 'R6', file: STATE, tests: [T_REC],
    from: '  if (worst > MAX_RESULTS_BYTES) {',
    to: '  if (false) {',
    why: 'a batch starts whose results cannot all be written, so a later result fails on size',
    killed_by: /a start whose worst-case results would not fit the budget is refused/,
  },
  {
    id: 'R7', file: LIB, tests: [T_REC],
    from: '  return ended.length > 0 ? [ended.at(-1)] : [];',
    to: '  return ended;',
    why: 'retention evicts nothing, so a request interrupted often enough fills the budget and can no longer be taken up',
    killed_by: /retention keeps only the batch it continues/,
  },
  {
    id: 'R7b', file: LIB, tests: [T_REC],
    from: "    scalarBytes('verify_results', { ...results, batches: [link, link] }),\n",
    to: '',
    why: 'a batch is admitted whose continuation after a cut no longer fits, so the request cannot be taken up again on its tree',
    killed_by: /a start that would fit, but whose continuation after a cut would not, is refused/,
  },
  {
    id: 'R11', file: LIB, tests: [T_REC],
    from: '    if (canonicalJson(argv) !== canonicalJson(worker[i].argv)) {',
    to: '    if (false) {',
    why: "a batch that runs another file than the request's, under the same kind, answers the request",
    killed_by: /the worker checks run the request's commands/,
  },
  {
    id: 'R12', file: STATE, tests: [T_REC],
    from: '  if (read.declaration.digest !== start.declaration_digest) {',
    to: '  if (false) {',
    why: "the request's checks are resolved with another declaration than the one the batch names",
    killed_by: /the worker checks run the request's commands/,
  },
  {
    id: 'R13', file: STATE, tests: [T_REC],
    from: '    const carried = latest ? carryOver(latest, start) : [];',
    to: '    const carried = [];',
    why: 'a continuation must run again the checks that already passed on its tree (item 7: it goes on from the first that did not)',
    killed_by: [/a continuation on the same tree goes on from its first check that did not pass/, /across five interruptions a continuation carries/],
  },
  {
    id: 'R14', file: LIB, tests: [T_REC],
    from: '  if (prior.tree_start !== start.tree_start || prior.checks_digest !== start.checks_digest) return [];',
    to: '  if (prior.checks_digest !== start.checks_digest) return [];',
    why: 'results recorded on another tree are carried into a continuation, and old results take on_pass',
    killed_by: /a continuation on the same tree goes on from its first check that did not pass; on another tree it runs whole/,
  },
  {
    id: 'R15', file: LIB, tests: [T_REC],
    from: '  if (prior.tree_start !== start.tree_start || prior.checks_digest !== start.checks_digest) return [];',
    to: '  if (prior.tree_start !== start.tree_start) return [];',
    why: "results of other commands (a relaunch's newer declaration) are carried, and the request is not run again whole",
    killed_by: /a continuation on the same tree goes on from its first check that did not pass; on another tree it runs whole/,
  },
  {
    id: 'R16', file: LIB, tests: [T_REC],
    from: '    carried.push({ ...r, carried_from: r.carried_from ?? { batch_id: prior.batch_id, run_id: prior.run_id } });',
    to: '    carried.push({ ...r, carried_from: { batch_id: prior.batch_id, run_id: prior.run_id } });',
    why: "a result carried twice names the batch that carried it, not the run that recorded it, so its log is looked up in the wrong run's directory",
    killed_by: /across five interruptions a continuation carries/,
  },
  {
    id: 'R17', file: LIB, tests: [T_REC],
    from: "      if (last && last.outcome !== 'passed' && last.outcome !== 'stopped') {",
    to: '      if (false) {',
    why: 'a batch that ended at a timeout or a refused check is taken up again instead of resuming the verb',
    killed_by: /only a stopped check, or none yet, is cut short/,
  },
  {
    id: 'R18', tests: [T_REC],
    // The persona refuses a batch after an ended one twice: at the start and
    // in the whole-record validator. Both go, so the start goes through.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: "      if (latest.end !== 'cut-short') {", to: '      if (false) {' });
      applyEdit(copy, { file: LIB, from: "    if (prior.end !== 'cut-short' || b.continues !== prior.batch_id) {", to: '    if (b.continues !== prior.batch_id) {' });
    },
    why: 'a batch that passed, failed or ended with no evidence is followed by another batch instead of on_pass or the verb',
    killed_by: /nothing follows a batch that passed, failed or ended with no evidence/,
  },
  {
    id: 'R19', tests: [T_REC],
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: '      if (start.continues !== latest.batch_id) {', to: '      if (false) {' });
      applyEdit(copy, { file: LIB, from: "    if (prior.end !== 'cut-short' || b.continues !== prior.batch_id) {", to: "    if (prior.end !== 'cut-short') {" });
    },
    why: 'a continuation names an older batch than the latest, or none, and the record no longer says what it goes on from',
    killed_by: /a continuation names the latest batch/,
  },
  {
    id: 'R20', file: LIB, tests: [T_REC],
    from: "    if (prior.end !== 'cut-short' || b.continues !== prior.batch_id) {",
    to: '    if (false) {',
    why: 'a hand-edited file whose later batch follows an ended one reads as a record the driver may take up',
    killed_by: /the parser refuses what does not hold together/,
  },
  {
    id: 'R21', file: STATE, tests: [T_REC],
    from: '    if (replaces !== stored) {',
    to: '    if (false) {',
    why: 'a delayed restart, replayed after the record moved on or its batch was evicted, erases later results',
    killed_by: /a restart names the record it sets aside/,
  },
  {
    id: 'R22', file: STATE, tests: [T_REC],
    from: '    admitStart(workflowPath, request, start, empty);',
    to: '    admitStart(workflowPath, request, start, { ...empty, batches: retainBatches(ownResults(fm, requestId)?.batches ?? []) });',
    why: 'the restart sizes its batch against the record it sets aside, so an oversized foreign record blocks it as it blocks an ordinary start',
    killed_by: /a record over the budget block every ordinary start/,
  },
  {
    id: 'R23', file: STATE, tests: [T_REC],
    from: '    fm.verify_results = { ...empty, batches: [{ ...start, results: [] }] };',
    to: '    fm.verify_results = { ...empty, batches: [...retainBatches(ownResults(fm, requestId)?.batches ?? []), { ...start, results: [] }] };',
    why: 'the restart keeps the batch it should set aside, so the record a foreign writer left still decides what follows',
    killed_by: /each record the driver cannot trust is set aside/,
  },
  {
    id: 'R24', file: STATE, tests: [T_REC],
    from: '  if (start.continues !== null) {\n    throw new Error(`a restart continues nothing',
    to: '  if (false) {\n    throw new Error(`a restart continues nothing',
    why: 'a restart names a batch it continues, though it sets every earlier batch aside, and the record says it goes on from one it no longer holds',
    killed_by: /a restart names the record it sets aside/,
  },
  {
    id: 'R8', file: LIB, tests: [T_REC],
    from: "  if (last && last.outcome !== 'passed') return",
    to: '  if (false) return',
    why: 'a check is recorded after the one the batch stopped at',
    killed_by: /results: in index order, never after a check that did not pass/,
  },
  {
    id: 'R9', file: LIB, tests: [T_REC],
    from: "      if (!sameTree) return 'a passed batch ends on the tree it started on';",
    to: '',
    expect: 'SURVIVED',
    why: 'equivalent: an end on another tree is refused before the switch (it must be no-evidence, cause tree-changed)',
  },
  {
    id: 'R10', file: STATE, tests: [T_REC],
    from: "    if (latest.end !== 'passed') throw",
    to: '    if (false) throw',
    why: "a batch with no evidence hands on_pass to the next step",
    killed_by: /ends that contradict their batch are refused/,
  },

  // ---- A: the attempt mark, the confidence, later releases' records ---------
  {
    id: 'A1', file: STATE, tests: [T_REC],
    from: '  if (bound && (before.digest !== mark.handoff || before.generation !== mark.generation)) {',
    to: '  if (false) {',
    why: "a step's late write is taken after any change since its last one, so it undoes the driver's batch or pass, overwrites the owner's handoff, or rolls back an operator's recovery",
    killed_by: [/the driver's batch start and pass/, /an owner's set-terminal with no next step/, /a writer that does not know the mark/, /each kind of the owner's write stales it alone/, /a restart stales the requesting step's attempt/, /Codex's sequence/, /the step's delayed write after another writer changed the handoff/, /the operator's recovery/],
  },
  {
    id: 'A2', file: STATE, tests: [T_REC],
    from: '    handoff: frontmatter.verify_handoff.handoff, generation: frontmatter.verify_handoff.generation,',
    to: '    handoff: bound ? mark.handoff : frontmatter.verify_handoff.handoff, generation: bound ? mark.generation : frontmatter.verify_handoff.generation,',
    why: "the mark keeps the handoff of the step's first write, so the step's own second write reads as stale and a step can never write twice",
    killed_by: /the step's own consecutive writes are taken/,
  },
  {
    id: 'A3', file: STATE, tests: [T_REC],
    from: '    requested: request || (bound && mark.requested === true),\n',
    to: '    requested: request,\n',
    why: 'a step that recorded a request and then ended with commit retries its request late, and writes verify again',
    killed_by: [/every write of the next step under the offer is held to the mark/, /the step's own consecutive writes are taken/],
  },
  {
    id: 'A4', file: LIB, tests: [T_REC],
    from: '  if (a.run_id === b.run_id) {\n    return Number.isInteger',
    to: '  if (true) {\n    return Number.isInteger',
    why: "runs are ordered by step number across runs: a later run's first step is refused after an earlier run's step 9, and an earlier run's higher-numbered step replaces a later run's request",
    killed_by: /a replaced run/,
  },
  {
    id: 'A49', file: STATE, tests: [T_REC],
    from: '    const held = hold ? await admitWrite(workflowPath, { env, host }) : null;',
    to: '    const held = null;',
    why: "the hold at the lock, the one point every writer passes, is gone: every writer class takes a stale step's write, a checkpoint, a manifest entry, a snapshot, a marker, a detach and an archive as much as a next step (MAJOR 2 of the seventh critique)",
    killed_by: [/an earlier step's delayed write of any kind records nothing/, /every write of a step is held to the mark, one that changes nothing included/, /Codex's sequence/, /a replaced run/, /the lock admits nothing for a file not there yet/],
  },
  {
    id: 'A51', file: STATE, tests: [T_REC],
    from: "  const run = { run_id: env.AGENTIC_AUTOPILOT };\n  const stepText = env.AGENTIC_AUTOPILOT_STEP ?? '';\n  if (!STEP_RE.test(stepText)) return run;",
    to: "  const run = { run_id: env.AGENTIC_AUTOPILOT };\n  if (!COMMIT_SHA_RE.test(env.AGENTIC_AUTOPILOT_VERIFY ?? '')) return run;\n  const stepText = env.AGENTIC_AUTOPILOT_STEP ?? '';\n  if (!STEP_RE.test(stepText)) return run;",
    why: "a step of a run that offers no verification numbers no step, so its delayed write rolls back the owner's decision (MAJOR 1 of the seventh critique)",
    killed_by: [/the offer is off on Codex/, /Codex's sequence/, /the operator's recovery/],
  },
  {
    id: 'A17', file: STATE, tests: [T_REC],
    from: '    if (mark.step === undefined) return null;\n',
    to: '',
    why: "a step of a driver that numbers none (an earlier release) is refused in its own run once its run moved the mark, so such a run writes once",
    killed_by: /a run that offers no verification orders runs/,
  },
  {
    id: 'A50', file: STATE, tests: [T_REC],
    from: '    if (mark.step === undefined) return null;\n    throw new Error(',
    to: '    return null;\n    throw new Error(',
    why: "a step with no number is taken beside a numbered step of its own run, which it cannot be ordered against, so it undoes that step's handoff",
    killed_by: [/a step with no number writes nothing beside a numbered one/, /a later step's write that sets no next step/],
  },
  {
    id: 'A18', file: STATE, tests: [T_REC],
    from: '  const order = mark.step === undefined && attempt.run_id === mark.run_id ? 1 : compareAttempts(attempt, mark);',
    to: '  const order = compareAttempts(attempt, mark);',
    why: 'once a run that offers no verification moved the mark on, an offering step of that same run cannot be ordered against it and is refused',
    killed_by: /a run that offers no verification orders runs/,
  },
  {
    id: 'A19', file: STATE, tests: [T_REC],
    from: '  if (Number.isNaN(order)) {',
    to: '  if (false) {',
    why: 'two runs of one second are taken as ordered, and the later writer replaces the other',
    killed_by: /a replaced run/,
  },
  {
    id: 'A20', file: STATE, tests: [T_REC],
    from: '  if ((mark !== undefined && isNewerRecord(mark)) || before.generation === null) {',
    to: '  if (attempt.step !== undefined && ((mark !== undefined && isNewerRecord(mark)) || before.generation === null)) {',
    why: "a step with no number writes beside a later release's records, which it never interprets (the opaque v2 records of the seventh critique)",
    killed_by: /a record a later release wrote \(a higher v\) is carried as written/,
  },
  {
    id: 'A21', file: STATE, tests: [T_REC],
    from: "  if (current('verify_request') && fm.verify_request.workflow_id !== fm.workflow_id) {",
    to: '  if (false) {',
    why: "a request and its results moved from another workflow read as this one's evidence",
    killed_by: /the parser refuses what does not hold together/,
  },
  {
    id: 'A24', file: LIB, tests: [T_REC],
    from: '    next_step_kind: fm.next_step_kind ?? null,\n',
    to: '',
    why: "a writer that changes only the next step's kind leaves the step's late write taken",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A25', file: LIB, tests: [T_REC],
    from: '    next_step_verb: fm.next_step_verb ?? null,\n',
    to: '',
    why: "a writer that changes only the next verb leaves the step's late write taken",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A26', file: LIB, tests: [T_REC],
    from: '    next_step_confidence: fm.next_step_confidence ?? null,\n',
    to: '',
    why: "a writer that changes only the next step's confidence leaves the step's late write taken",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A27', file: LIB, tests: [T_REC],
    from: '    current_phase: fm.current_phase ?? null,\n',
    to: '',
    why: "Phase 7's begin-commit, which moves the phase alone, leaves the step's late write taken, and it reopens the commit",
    killed_by: [/a later step's write that sets no next step/, /a writer that does not know the mark/],
  },
  {
    id: 'A28', file: LIB, tests: [T_REC],
    from: '    terminal_marker: fm.terminal_marker === true,\n',
    to: '',
    why: "a writer that turns the terminal marker on, alone, leaves the step's late write taken, and it turns the marker off",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A29', file: LIB, tests: [T_REC],
    from: '    verify_request: fm.verify_request ?? null,\n',
    to: '',
    why: "a change to the request alone leaves the step's late write taken",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A30', file: LIB, tests: [T_REC],
    from: '    verify_results: fm.verify_results ?? null,\n',
    to: '',
    why: "the driver's batch start and restart, which change the results alone, leave the requesting step's late write taken, and it clears the next step mid-batch",
    killed_by: [/the driver's batch start and pass/, /a restart stales the requesting step's attempt/],
  },
  {
    id: 'A32', file: STATE, tests: [T_REC],
    from: '  if (mark !== undefined) {\n    const changed',
    to: '  if (attempt.step === undefined && mark === undefined) return;\n  if (mark !== undefined) {\n    const changed',
    why: "a step with no number records no run order while there is no mark, so an older run's delayed step reopens its commit",
    killed_by: [/a run that offers no verification orders runs/, /records its run on its first write, one that changes nothing included/, /a newer run's first checkpoint records its mark/],
  },
  {
    id: 'A33', file: STATE, tests: [T_REC],
    from: '    if (bound && !changed) return;',
    to: '    if (!changed) return;',
    why: "a later step's or run's write that changes nothing leaves the mark on the earlier step, so that step's delayed commit-complete lands over it",
    killed_by: [/every write of a step is held to the mark, one that changes nothing included/, /records its run on its first write, one that changes nothing included/],
  },
  {
    id: 'A34', file: STATE, tests: [T_REC],
    from: '  if (bound && (before.digest !== mark.handoff || before.generation !== mark.generation)) {',
    to: '  if (bound && before.digest !== mark.handoff) {',
    why: "a change undone by this release's writers (A to B and back to A) is not seen, and the step's delayed write rolls back the owner's decision (F2, MAJOR 3 of the sixth critique)",
    killed_by: /a change undone by writers of this release stales it all the same/,
  },
  {
    id: 'A35', file: STATE, tests: [T_REC],
    from: '  stampHandoff(frontmatter);\n  const fmText',
    to: '  const fmText',
    why: 'only the writes held to the mark move the generation, so an owner\'s A to B and back to A is not seen',
    killed_by: /a change undone by writers of this release stales it all the same/,
  },
  {
    id: 'A36', file: LIB, tests: [T_REC],
    from: 'generation: h.generation + 1, handoff: digest };',
    to: 'generation: h.generation, handoff: digest };',
    why: 'a change of the handoff moves no generation, so a change undone is not seen',
    killed_by: /a change undone by writers of this release stales it all the same/,
  },
  {
    id: 'A37', file: LIB, tests: [T_REC],
    from: '    verb: fm.verb ?? null,\n',
    to: '',
    why: "a same-phase change of the active verb leaves the step's late write taken, and it publishes a next step for another verb (MAJOR 2 of the sixth critique)",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A38', file: LIB, tests: [T_REC],
    from: '    ...Object.fromEntries(AWAITING_OWNER_KEYS.map((k) => [k, fm[k] ?? null])),\n',
    to: '',
    why: "a replaced owner gate leaves the step's late write taken, and it publishes over the gate (MAJOR 2 of the sixth critique)",
    killed_by: /a gate replaced, a verb changed in the same phase, or a pending run/,
  },
  {
    id: 'A39', file: LIB, tests: [T_REC],
    from: '    pending_ensemble: fm.pending_ensemble ?? null,\n',
    to: '',
    why: "a pending peer run recorded since leaves the step's late write taken",
    killed_by: /a writer that does not know the mark/,
  },
  {
    id: 'A40', file: STATE, tests: [T_REC],
    from: '    frontmatter.pending_ensemble = [...existing, entry];\n    frontmatter.updated_at = nowIso;\n    await writeWorkflow(workflowPath, frontmatter, body, ownership);\n    return { frontmatter, workflowPath };\n  }, { env, host, writer: LANE_WRITERS.plain });',
    to: '    frontmatter.pending_ensemble = [...existing, entry];\n    frontmatter.updated_at = nowIso;\n    await writeWorkflow(workflowPath, frontmatter, body, ownership);\n    return { frontmatter, workflowPath };\n  }, { writer: LANE_WRITERS.plain });',
    why: "the pending registration is admitted under this process's environment, not the step's: an earlier step's delayed dispatch records its pending run over a later step's handoff, and the step's own dispatch stales its own next write",
    killed_by: [/every write of a step is held to the mark, one that changes nothing included/, /the step's own consecutive writes are taken/],
  },
  {
    id: 'A41', file: STATE, tests: [T_REC],
    from: '    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted, kept };\n  }, { env, host, writer: LANE_WRITERS.settlement, runId: run_id });',
    to: '    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted, kept };\n  }, { writer: LANE_WRITERS.settlement, runId: run_id });',
    why: "the step's own settle is admitted as an owner's write, which moves the generation without the mark, so the step can never finish after its peer run",
    killed_by: /the step's own consecutive writes are taken/,
  },
  {
    id: 'A56', file: STATE, tests: [T_REC],
    from: '  if (attempt !== null) markAttempt(frontmatter, { attempt, before: handoffState(frontmatter), bound: false, mark: undefined });\n',
    to: '',
    why: "a workflow created under a step records no mark, so the creating step's delayed write overrides the owner's decision (F1 of the eighth refine's Refine-verify)",
    killed_by: /a workflow created under a numbered step records that step's mark/,
  },
  {
    id: 'A57', file: STATE, tests: [T_REC],
    from: '  if (!ownership?.held || ownership.held.bound) return;\n',
    to: '  return;\n',
    why: 'a write beside the workflow moves no mark, so a step whose first write is one is not bound, and an earlier step writes on over it',
    killed_by: /a write beside the workflow, its first of the step, moves the mark on/,
  },
  {
    id: 'A58', file: STATE, tests: [T_REC],
    from: "          recorded_at: flags['recorded-at'],\n          host: flags.host,\n        });\n        if (!result.skipped) {\n          process.stdout.write(`${flags['workflow-path']}\\n`);\n        }\n        return 0;\n      }\n\n      case 'record-refine-file': {",
    to: "          recorded_at: flags['recorded-at'],\n        });\n        if (!result.skipped) {\n          process.stdout.write(`${flags['workflow-path']}\\n`);\n        }\n        return 0;\n      }\n\n      case 'record-refine-file': {",
    why: 'record-composed-file --host codex is taken as Claude\'s, so a Codex write under an inherited run is held to the step\'s mark (F2 of the eighth refine\'s Refine-verify)',
    killed_by: /the manifest and review-ledger commands take the caller's host/,
  },
  {
    id: 'A59', file: STATE, tests: [T_REC],
    from: '    // Every path below moves or writes the ledger: the mark moves on first, so\n    // a step stopped between the two has already bound the attempt.\n    await markBeside(workflowPath, ownership);\n',
    to: '',
    why: "a non-document critique-scope moves the ledger aside and leaves the mark on the step before, so that step's delayed checkpoint or staging-set entry lands after it (MAJOR 1 of the eighth critique)",
    killed_by: /a non-document critique-scope that moves a ledger aside/,
  },
  {
    id: 'A60', file: STATE, tests: [T_REC],
    from: '  if (beforePublish) await beforePublish();\n  await ensureDir(paths.dir, 0o700);\n',
    to: '  await ensureDir(paths.dir, 0o700);\n',
    why: 'the task file is published with no mark moved on before it, so a failure leaves the mark on the step before, which then overwrites the newer file (MAJOR 2 of the eighth critique)',
    killed_by: /a side write that fails after its step moved the mark on/,
  },
  {
    id: 'A60b', file: STATE, tests: [T_REC],
    from: "    beforePublish: () => markBeside(args.workflowPath, ownership),\n  }), {",
    to: "    beforePublish: () => null,\n  }).then(async (written) => { await markBeside(args.workflowPath, ownership); return written; }), {",
    why: 'the task file is published before the mark moves on: a failure between the two leaves the mark on the step before (MAJOR 2 of the eighth critique)',
    killed_by: /a side write that fails after its step moved the mark on/,
  },
  {
    id: 'A61', file: STATE, tests: [T_REC],
    from: '  if (attempt !== null) await admitCreation(searched, gitBaseline.branch, attempt);\n',
    to: '',
    why: "a creation is admitted against nothing: after a newer step archived the workflow, an older step's delayed bootstrap leaves a fresh active workflow on the branch (MAJOR 3 of the eighth critique)",
    killed_by: /a creation is admitted against the workflows archived on its branch/,
  },
  {
    id: 'A62', tests: [T_REC],
    // Either branch filter alone keeps the other's work (an equivalent
    // mutation): both go.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: '        if (fmBranch !== null && fmBranch !== branch) continue;\n', to: '' });
      applyEdit(copy, { file: STATE, from: '        if (fm.git_baseline?.branch !== branch) continue;\n', to: '' });
    },
    why: "a creation is held to the marks of every branch's archived workflows, so a step creating on its own branch is refused for another branch's newer step",
    killed_by: /a creation is admitted against the workflows archived on its branch/,
  },
  {
    id: 'A63', tests: [T_REC],
    // The check before the source is removed takes the destination back, so
    // the check before the destination alone is backed by it (an equivalent
    // mutation, measured): both go.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: '      if (!(await stillHeld())) throw reclaimed();\n', to: '' });
      applyEdit(copy, { file: STATE, from: '      if (!(await stillHeld())) {\n        await unlink(destination).catch(() => {});\n        throw reclaimed();\n      }\n', to: '' });
    },
    why: 'an archive whose source lock was reclaimed archives its older bytes and deletes the newer active workflow (MAJOR 4 of the eighth critique)',
    killed_by: /an archive whose source lock was reclaimed/,
  },
  {
    id: 'A63b', file: STATE, tests: [T_REC],
    // The check before the destination alone is backed by this one (A63);
    // this one alone is not: a reclaim once the destination is published is
    // caught only here (one before the publication is the destination's
    // precommit's, refine-verify N2).
    from: '      if (!(await stillHeld())) {\n        await unlink(destination).catch(() => {});\n        throw reclaimed();\n      }\n',
    to: '',
    why: 'an archive whose source lock was reclaimed once it published its destination deletes the newer active workflow and keeps its older archive (MAJOR 4 of the eighth critique)',
    killed_by: /reclaimed once it published its destination takes the destination back/,
  },
  {
    id: 'A64', file: STATE, tests: [T_REC],
    from: '  const attempt = verifyAttemptOf({ env, host });\n  if (attempt !== null) await admitCreation(',
    to: "  const attempt = verifyAttemptOf({ env, host: 'claude' });\n  if (attempt !== null) await admitCreation(",
    why: "a creation on Codex under an inherited run is taken as the run's step and records its mark (H11 of the eighth critique)",
    killed_by: /a creation on Codex under an inherited run records no mark/,
  },
  {
    id: 'A65', file: 'tests/persona-pipeline/_drop-session.mjs', tests: [T_REC, T_PR, T_ORCH],
    from: "  for (const k of Object.keys(process.env)) if (k.startsWith('AGENTIC_')) delete process.env[k];\n",
    to: '',
    why: "a test file run from an autopilot step writes its fixtures as the step's, or under its state base (MAJOR 5 of the eighth critique)",
    killed_by: [/the owner-write probe passes in every persona/, /the pending-entry probe passes/, /the real-child probe passes/],
  },
  {
    id: 'A66', file: STATE, tests: [T_REC],
    from: '      if (ownership?.held && !ownership.held.bound) {\n        const marked = parseWorkflowFile(text);',
    to: '      if (false) {\n        const marked = parseWorkflowFile(text);',
    why: "an archive's mark lands only in the destination, so an archive that fails before removing its source leaves the earlier step's mark, and that step writes (refine-verify F1)",
    killed_by: /fails to remove its source leaves its own mark in the active file/,
  },
  {
    id: 'A67', file: STATE, tests: [T_REC],
    from: '  if (!(await holdsLock(ownership))) {\n    throw new Error(`the lock on the workflow was reclaimed',
    to: '  if (false) {\n    throw new Error(`the lock on the workflow was reclaimed',
    why: "a step whose lock was reclaimed after its mark moved on renames the newer step's review ledger aside (refine-verify F2)",
    killed_by: /a ledger move whose lock was reclaimed after the mark moved on moves nothing/,
  },
  {
    id: 'A68', file: STATE, tests: [T_REC],
    from: '        if (order === 0 && (left.digest !== mark.handoff',
    to: '        if (false && (left.digest !== mark.handoff',
    why: 'the step an archived mark names creates again after the owner changed the handoff it left (refine-verify F3)',
    killed_by: /creates nothing once the handoff it left changed and the workflow was archived/,
  },
  {
    id: 'A69', file: STATE, tests: [T_REC],
    from: "        (await holdsLock(ownership)) && (await readFile(workflowPath, 'utf8').catch(() => null)) === current;",
    to: "        (await readFile(workflowPath, 'utf8').catch(() => null)) === current;",
    why: 'an archive whose source lock alone was reclaimed archives the bytes it read and deletes the active file under the new owner',
    killed_by: /the source changed its lock token only once it read it/,
  },
  {
    id: 'A70', file: STATE, tests: [T_REC],
    from: "        (await holdsLock(ownership)) && (await readFile(workflowPath, 'utf8').catch(() => null)) === current;",
    to: '        (await holdsLock(ownership));',
    why: 'an archive whose source bytes alone changed archives its older bytes and deletes the newer ones',
    killed_by: /the source changed its bytes only once it read it/,
  },
  {
    id: 'A71', file: STATE, tests: [T_REC],
    from: '        await precommitted(() => atomicWrite(workflowPath, marking, ownership, { precommit: stillHeld }));',
    to: '        await precommitted(() => atomicWrite(workflowPath, marking, ownership));',
    why: "the archive's mark write commits on the lock token alone, so a change made under the same lock once the archive checked the bytes is overwritten from its snapshot, and the archive then passes its later checks against the bytes it wrote: the change is in neither file (refine-verify N1)",
    killed_by: /an archive's mark write keeps a change made under the same lock/,
  },
  {
    id: 'A72', file: STATE, tests: [T_REC],
    from: '        await atomicWrite(candidate, archivedBytes, { lockPath, token }, { precommit });',
    to: '        await atomicWrite(candidate, archivedBytes, { lockPath, token });',
    why: "the destination is published under its own lock only, so an archive whose source was reclaimed publishes its older bytes, and one stopped before its compensating removal leaves that stale archive beside the newer active workflow (refine-verify N2)",
    killed_by: /publishes nothing, even when it is stopped before it could take one back/,
  },
  {
    id: 'A73', file: STATE, tests: [T_REC],
    from: '        if (order === 0 && (left.digest !== mark.handoff || left.generation !== mark.generation)) {',
    to: '        if (order === 0 && left.digest !== mark.handoff) {',
    why: "a creation compares only the archived handoff's digest, so after the owner changed the handoff and changed it back the step the mark names creates again (refine-verify F3, its generation)",
    killed_by: /changed the handoff and changed it back before the archive/,
  },
  {
    id: 'A74', file: STATE, tests: [T_REC],
    from: '      reset = `${paths.file}.unreadable-${Date.now()}`;\n      await renameHeld(paths.file, reset, ownership);',
    to: '      reset = `${paths.file}.unreadable-${Date.now()}`;\n      await rename(paths.file, reset);',
    why: "a document critique whose lock was reclaimed after its mark moved on moves the new owner's ledger aside as unreadable (refine-verify F2)",
    killed_by: /ledger move \(unreadable\) whose lock was reclaimed/,
  },
  {
    id: 'A75', file: STATE, tests: [T_REC],
    from: '      reset = `${paths.file}.superseded-${Date.now()}`;\n      await renameHeld(paths.file, reset, ownership);',
    to: '      reset = `${paths.file}.superseded-${Date.now()}`;\n      await rename(paths.file, reset);',
    why: "a document critique whose lock was reclaimed after its mark moved on supersedes the new owner's ledger (refine-verify F2)",
    killed_by: /ledger move \(unrecorded-critique\) whose lock was reclaimed/,
  },
  {
    id: 'A76', tests: [T_REC],
    // The condition evaluated before the temporary file is written, and only
    // its answer read at the commit: the check made before the write that
    // the owner's ruling (2026-10-24) moves to the commit.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: "  const handle = await open(tmpPath, 'wx', 0o600);\n  try {\n    await handle.writeFile(contents, { encoding: 'utf8' });", to: "  const early = precommit ? await precommit().catch(() => false) : true;\n  const handle = await open(tmpPath, 'wx', 0o600);\n  try {\n    await handle.writeFile(contents, { encoding: 'utf8' });" });
      applyEdit(copy, { file: STATE, from: '    try { holds = (await precommit()) === true; } catch {}\n', to: '    holds = early === true;\n' });
    },
    why: "the archive's mark write checks the source before its bytes are written, so a change made while they are written is overwritten and archived away (refine-verify N1, the check's place)",
    killed_by: /a change made while the mark was being written is kept/,
  },
  {
    id: 'A77', file: STATE, tests: [T_REC],
    from: '  for (const { lockPath, token } of ownership ? [ownership, ...(ownership.outer ?? [])] : []) {',
    to: '  for (const { lockPath, token } of ownership ? [ownership] : []) {',
    why: "a write checks only the lock it names at its commit, so a creation under two creation locks commits after the repository's was reclaimed (ninth critique MAJOR 1)",
    killed_by: /reclaimed before its commit publishes nothing \(ninth critique MAJOR 1, two locks\)/,
  },
  {
    id: 'A78', file: STATE, tests: [T_REC],
    from: "    (inner) => fn({ ...inner, outer: [{ lockPath: outer.lockPath, token: outer.token }] }), { storage }), { storage: repoStorage });",
    to: '    fn, { storage }), { storage: repoStorage });',
    why: "the two-lock case hands the creation only the inner lock's ownership, as before the fix (ninth critique MAJOR 1)",
    killed_by: /reclaimed before its commit publishes nothing \(ninth critique MAJOR 1, two locks\)/,
  },
  {
    id: 'A79', file: STATE, tests: [T_REC],
    from: '    createWorkflowUnderLock({ ...args, operation }, { lockPath, token, outer, storage }),',
    to: '    createWorkflowUnderLock({ ...args, operation }, { lockPath, token, storage }),',
    why: "createWorkflow drops the outer lock on the way to the write, so its commit checks the home's lock alone (ninth critique MAJOR 1)",
    killed_by: /reclaimed before its commit publishes nothing \(ninth critique MAJOR 1, two locks\)/,
  },
  {
    id: 'A80', file: STATE, tests: [T_REC],
    from: '          text = readFrontmatterText(file);\n          // A record that opens no LF frontmatter',
    to: '          text = await readFile(file, \'utf8\');\n          // A record that opens no LF frontmatter',
    why: 'the archive scan reads each record whole with a blocking read, so a FIFO in the archive hangs a creation under the creation lock (ninth critique MAJOR 2)',
    killed_by: /a FIFO named as an archived workflow refuses a creation under a run at once/,
  },
  {
    id: 'A81', file: STATE, tests: [T_REC],
    from: '          text = readFrontmatterText(file);\n          // A record that opens no LF frontmatter',
    to: '          text = statSync(file).isFile() ? readFileSync(file, \'utf8\') : null;\n          // A record that opens no LF frontmatter',
    why: 'the scan refuses a FIFO but still reads each regular record whole, so its cost grows with the bodies of the archive (ninth critique MAJOR 2)',
    killed_by: /the archive scan reads no body/,
  },
  {
    id: 'A82', file: STATE, tests: [T_REC],
    from: '        if (text === null && statSync(file, { throwIfNoEntry: false })?.isDirectory()) continue;\n',
    to: '',
    why: 'a directory named as a record refuses every creation under a run, where it was passed over before (the control of ninth critique MAJOR 2)',
    killed_by: /a FIFO named as an archived workflow refuses a creation under a run at once/,
  },
  {
    id: 'A83', file: STATE, tests: [T_REC],
    // Prototype C's C1 (the owner's ruling of 2026-10-25): the head is judged
    // alone, with no whole read of a record the head reader cannot bound.
    from: "          if (text !== null && !text.startsWith('---\\n')) text = readRegularText(file);\n",
    to: '',
    why: "a CRLF record is judged on the head reader's first chunk alone, so its mark past that chunk fences nothing (refine-verify F1 of the M1/M2 round, tenth critique MAJOR 1)",
    killed_by: /a CRLF archived record whose mark lies past the head reader's first chunk is read whole and refuses an older step/,
  },
  {
    id: 'A85', file: STATE, tests: [T_REC],
    from: "        const end = text.startsWith('---\\n') ? text.indexOf('\\n---\\n', 4) : -1;\n",
    to: "        const end = text.indexOf('\\n---', 4);\n",
    why: 'the mark scan stops at the first line that opens with ---, so a mark after such a line passes as unmarked (refine-verify R1 of the 2026-10-25 ruling)',
    killed_by: /a line that merely opens with --- closes no frontmatter/,
  },
  {
    id: 'A86', file: STATE, tests: [T_REC],
    from: '          text = readFrontmatterText(file);\n          // A record that opens no LF frontmatter',
    to: '          text = readRegularText(file);\n          // A record that opens no LF frontmatter',
    why: 'the scan reads every regular record whole through a descriptor, which a counter of pathname reads misses (refine-verify R3 of the 2026-10-25 ruling)',
    killed_by: /the archive scan reads no body/,
  },
  {
    id: 'A87', file: STATE, tests: [T_REC],
    from: '        if (!/(?:^|\\n)verify_attempt:/.test(end < 0 ? text : text.slice(0, end))) continue;\n',
    to: '        if (!/^verify_attempt:/m.test(end < 0 ? text : text.slice(0, end))) continue;\n',
    why: 'the mark scan takes a line start after U+2028 or U+2029, which the parser does not, so a note holding one before verify_attempt: refuses every creation under a run (eleventh critique MAJOR 1)',
    killed_by: /a U\+2028 or U\+2029 before verify_attempt: in a request fakes no mark/,
  },
  {
    id: 'A88', tests: [T_REC],
    // The scan's line starts as before the fix, and no guard behind them: a
    // tool-written request fakes a mark the parser never reads.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: '        if (!/(?:^|\\n)verify_attempt:/.test(end < 0 ? text : text.slice(0, end))) continue;\n', to: '        if (!/^verify_attempt:/m.test(end < 0 ? text : text.slice(0, end))) continue;\n' });
      applyEdit(copy, { file: STATE, from: '        if (mark === undefined) continue;\n', to: '' });
    },
    why: 'a request holding U+2028 before verify_attempt: makes every creation under a run on its branch throw a TypeError (eleventh critique MAJOR 1)',
    killed_by: /a U\+2028 or U\+2029 before verify_attempt: in a request fakes no mark/,
  },
  {
    id: 'A89', file: STATE, tests: [T_REC],
    from: '        if (mark === undefined) continue;\n',
    to: '',
    expect: 'SURVIVED',
    why: "equivalent: the mark scan counts a line opening verify_attempt: only in an LF frontmatter up to the parser's close, or in a record the parse refuses, so every record parsed past it holds the key; the guard backs that rule (A88 drops both)",
  },
  {
    id: 'A90', file: STATE, tests: [T_REC],
    from: "        const fmBranch = text.startsWith('---\\n') ? extractFrontmatterBranch(text) : null;\n",
    to: '        const fmBranch = extractFrontmatterBranch(text);\n',
    why: 'in a record that opens no LF frontmatter, a branch named in its body exempts a newer mark, so a stale step is created beside it (eleventh critique MAJOR 3)',
    killed_by: /a branch named in the body of a record that opens no LF frontmatter exempts nothing/,
  },
  {
    id: 'A91', file: STATE, tests: [T_REC],
    from: "  const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));\n  try {\n    if (!fstatSync(fd).isFile()) return null;\n    return readFileSync(fd, 'utf8');",
    to: "  const fd = openSync(file, fsConstants.O_RDONLY);\n  try {\n    if (!fstatSync(fd).isFile()) return null;\n    return readFileSync(fd, 'utf8');",
    why: 'the whole read opens the record blocking, so a FIFO swapped in after the head read hangs the creation under its lock (eleventh critique MAJOR 2)',
    killed_by: /a record swapped between the head read and the whole read is judged alone/,
  },
  {
    id: 'A92', file: STATE, tests: [T_REC],
    from: "    if (!fstatSync(fd).isFile()) return null;\n    return readFileSync(fd, 'utf8');",
    to: "    return readFileSync(fd, 'utf8');",
    why: 'the whole read takes whatever it opened, so a FIFO swapped in after the head read reads as an empty record, and the creation is admitted (eleventh critique MAJOR 2)',
    killed_by: /a record swapped between the head read and the whole read is judged alone/,
  },
  {
    id: 'A93', file: STATE, tests: [T_REC],
    from: "    return readFileSync(fd, 'utf8');\n  } finally {\n    closeSync(fd);\n  }",
    to: "    return readFileSync(fd, 'utf8');\n  } finally {\n  }",
    why: 'the whole read leaves its descriptor open, one for each record it reads (eleventh critique MAJOR 2)',
    killed_by: /a record swapped between the head read and the whole read is judged alone/,
  },
  {
    id: 'A94', file: STATE, tests: [T_REC],
    from: "          if (text !== null && !text.startsWith('---\\n')) text = readRegularText(file);\n",
    to: "          if (text !== null && !text.startsWith('---\\n')) text += readRegularText(file);\n",
    why: 'the whole read is joined to the head read before it, so a record replaced between them is judged on both, and a valid one refuses (eleventh critique MAJOR 2)',
    killed_by: /a record swapped between the head read and the whole read is judged alone/,
  },
  {
    id: 'A84', tests: [T_REC],
    // The outer locks checked before the temporary file is written, the named
    // one still at the commit: a reclaim while the bytes are written is missed.
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: STATE, from: "  const handle = await open(tmpPath, 'wx', 0o600);\n  try {\n    await handle.writeFile(contents, { encoding: 'utf8' });", to: "  for (const { lockPath, token } of ownership?.outer ?? []) {\n    if ((await readFile(lockPath, 'utf8').catch(() => null)) !== token) throw new Error(`atomicWrite: ownership mismatch on ${lockPath} immediately before commit`);\n  }\n  const handle = await open(tmpPath, 'wx', 0o600);\n  try {\n    await handle.writeFile(contents, { encoding: 'utf8' });" });
      applyEdit(copy, { file: STATE, from: '  for (const { lockPath, token } of ownership ? [ownership, ...(ownership.outer ?? [])] : []) {', to: '  for (const { lockPath, token } of ownership ? [ownership] : []) {' });
    },
    why: "the outer lock is checked before the write, not at the commit, so a reclaim while the creation's bytes are written commits (refine-verify F4 of the M1/M2 round)",
    killed_by: /reclaimed before its commit publishes nothing \(ninth critique MAJOR 1, two locks\)/,
  },
  {
    id: 'A55', file: PEER, tests: [T_PR],
    from: '    const refused = await recordPendingIfEnsemble(await readHandle(paths.handle), options.env);',
    to: '    const refused = await recordPendingIfEnsemble(await readHandle(paths.handle));',
    why: "through runPeer, the pending registration reads this process's environment, not the step's, so a step's own dispatch stales its next write (MAJOR 3 of the seventh critique)",
    killed_by: /an ensemble run's pending entry is its step's own write/,
  },
  {
    id: 'A42', file: LIB, tests: [T_REC],
    from: "  if (!Number.isSafeInteger(a.generation) || a.generation < 0) fail('verify_attempt.generation is not a whole number');\n",
    to: '',
    why: 'a mark with no generation, or a malformed one, reads, and binds its step to nothing a write compares',
    killed_by: /the parser refuses what does not hold together/,
  },
  {
    id: 'A43', file: STATE, tests: [T_REC],
    from: "  if (current('verify_handoff')) validateStoredHandoff(fm.verify_handoff);\n",
    to: '',
    why: 'a malformed generation reads, and a write moves it on from whatever it holds',
    killed_by: /the parser refuses what does not hold together/,
  },
  {
    id: 'A44', file: STATE, tests: [T_REC],
    from: '  if ((mark !== undefined && isNewerRecord(mark)) || before.generation === null) {',
    to: '  if (mark !== undefined && isNewerRecord(mark)) {',
    why: "a step under the offer writes a mark beside a later release's generation, which this release cannot read",
    killed_by: /a record a later release wrote \(a higher v\) is carried as written/,
  },
  {
    id: 'A45', file: STATE, tests: [T_REC],
    from: '    if (!(order <= 0) || (pending && order === 0 && mark.requested !== true)) {',
    to: '    if (!(order <= 0) || (pending && (order !== 0 || mark.requested !== true))) {',
    why: "a later step's write past a pending request (Phase 7 entered again, a gate) is refused by the parser, so the commit recovery the driver chose for that state cannot begin",
    killed_by: /a later step's write past a pending request is taken/,
  },
  {
    id: 'A46', file: STATE, tests: [T_REC],
    from: "          started_at: flags['started-at'],\n          host: flags.host,\n",
    to: "          started_at: flags['started-at'],\n",
    why: "ensemble-pending --host codex is taken as Claude's, so an inherited offer makes the Codex dispatch the step's own and moves its mark",
    killed_by: /the ensemble CLI takes the caller's host/,
  },
  {
    id: 'A47', file: STATE, tests: [T_REC],
    from: '          cap,\n          host: flags.host,\n',
    to: '          cap,\n',
    why: "ensemble-commit --host codex is taken as Claude's, so the Codex settle is held to the step's mark and refused",
    killed_by: /the ensemble CLI takes the caller's host/,
  },
  {
    id: 'A48', file: STATE, tests: [T_REC],
    from: "        if (flags.host !== undefined) validateHost(flags.host);\n        await recordPendingEnsemble({",
    to: '        await recordPendingEnsemble({',
    why: 'a host that is neither claude nor codex is taken, and read as no autopilot host',
    killed_by: /the ensemble CLI takes the caller's host/,
  },
  {
    id: 'A31', file: T_REC, tests: [T_REC],
    from: "{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() }",
    to: "{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }",
    why: "a GIT_DIR a hook planted sends the fixtures' commits into the caller's repository while every test stays green",
    killed_by: /a planted GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE have no effect/,
  },
  {
    id: 'A5', file: LIB, tests: [T_REC],
    from: "  if (sa === null || sb === null || sa === sb) return Number.NaN;",
    to: "  if (sa === null || sb === null) return Number.NaN;\n  if (sa === sb) return 1;",
    why: 'two runs of one second are taken as ordered, so either may replace the other',
    killed_by: /a replaced run/,
  },
  {
    id: 'A6', file: LIB, tests: [T_REC],
    from: '  return sha256(canonicalJson({ workflow_id, run_id, step, baseline, declaration_digest, checks, on_pass, confidence })).slice(0, 16);',
    to: '  return sha256(canonicalJson({ workflow_id, run_id, step, baseline, declaration_digest, checks, on_pass })).slice(0, 16);',
    why: "a retry that changes only the confidence counts as unchanged, and the request's confidence and the next step's disagree",
    killed_by: /a retry that changes only the confidence is a new request/,
  },
  {
    id: 'A7', file: STATE, tests: [T_REC],
    from: "    if (current('verify_request') && fm.verify_request.confidence !== fm.next_step_confidence) {",
    to: '    if (false) {',
    why: "a file whose next step's confidence is not its request's reads, so the low-confidence halt depends on which field the driver reads",
    killed_by: /a retry that changes only the confidence is a new request/,
  },
  {
    id: 'A8', file: LIB, tests: [T_REC],
    from: "    scalarBytes('verify_results', { ...results, batches: [link, link] }),\n  );\n}",
    to: "    scalarBytes('verify_results', { ...results, batches: [filled, link] }),\n  );\n}",
    why: "the reserve uses the filled batch's own ids, so a first batch (continues null) admitted at the boundary has a second continuation that no longer fits, and the request is stuck",
    killed_by: /a chain of continuations at the budget boundary/,
  },
  {
    id: 'A13', file: LIB, tests: [T_REC],
    from: "    checks: filled.checks.map((c) => ({ ...c, kind: 'k'.repeat(64) })),\n",
    to: '',
    why: "the reserve keeps this batch's check kinds, so a continuation with the same commands that names a driver's check by a longer kind no longer fits, and the request is stuck",
    killed_by: /a chain of continuations at the budget boundary/,
  },
  {
    id: 'A14', file: LIB, tests: [T_REC],
    from: "    index, outcome: failed ? 'failed' : 'not-reached', exit: null,",
    to: "    index, outcome: failed ? 'failed' : 'not-reached', exit: 255,",
    expect: 'SURVIVED',
    why: 'equivalent for a whole batch (measured): only the check a batch stops at ends otherwise than passed, with exit 0, so the slack every other worst result keeps (a wider outcome and exit) covers the one byte null takes over 255; the reserve sizes null all the same, field by field',
  },
  {
    id: 'A15', file: LIB, tests: [T_REC],
    from: "const matches = (re, v) => typeof v === 'string' && re.test(v);",
    to: 'const matches = (re, v) => re.test(v);',
    why: 'an id nested in arrays passes as the string it prints and is stored as an array, so a continuation writes past the size reserve',
    killed_by: [/an array, or one nested to any depth, at each id field/, /a batch start whose run id is an array nested 2,500 deep/],
  },
  {
    id: 'A22', file: STATE, tests: [T_REC],
    from: '  if (terminalPhases().has(frontmatter.current_phase)) {',
    to: '  if (frontmatter.terminal_marker === true || terminalPhases().has(frontmatter.current_phase)) {',
    why: 'a workflow an interactive verb left with the terminal marker, resumed into a non-terminal phase, can never record a request',
    killed_by: /after an interactive finish and a Phase 0 resume under the offer/,
  },
  {
    id: 'A23', file: STATE, tests: [T_REC],
    from: '  if (terminalPhases().has(frontmatter.current_phase)) {',
    to: '  if (false) {',
    why: 'a workflow still in its terminal phase records a request, and the Stop hook may archive it beside a pending verify',
    killed_by: /after an interactive finish and a Phase 0 resume under the offer/,
  },
  {
    id: 'A9', file: STATE, tests: [T_REC],
    from: "  const current = (key) => key in fm && !isNewerRecord(fm[key]);",
    to: '  const current = (key) => key in fm;',
    why: "a record a later release wrote makes the workflow unreadable to this one: resume, archive and every write fail",
    killed_by: /a record a later release wrote \(a higher v\) is carried as written/,
  },
  {
    id: 'A10', file: STATE, tests: [T_REC],
    from: "    refuseNewerRecords(frontmatter, 'a driver\\'s write');\n",
    to: '',
    why: "a driver's write of this release lands in a later release's record it cannot read",
    killed_by: /a record a later release wrote \(a higher v\) is carried as written/,
  },
  {
    id: 'A11', file: STATE, tests: [T_REC],
    from: '  if ((mark !== undefined && isNewerRecord(mark)) || before.generation === null) {',
    to: '  if (before.generation === null) {',
    why: "a next step written under the offer is judged against a later release's mark this release cannot read",
    killed_by: /a record a later release wrote \(a higher v\) is carried as written/,
  },
  {
    id: 'A12', file: LIB, tests: [T_REC],
    from: '          recorded_by: result === null ? null : (result.carried_from ?? { batch_id: b.batch_id, run_id: b.run_id }),',
    to: '          recorded_by: result === null ? null : { batch_id: b.batch_id, run_id: b.run_id },',
    why: 'a carried result reads as recorded by the batch that carried it, so verify-exec looks for it in the wrong ledger entry',
    killed_by: /a continuation on the same tree goes on from its first check that did not pass/,
  },

  // ---- E: reading the evidence ------------------------------------------------
  {
    id: 'E1', file: LIB, tests: [T_REC],
    from: '    const sameTree = ended && b.tree_end !== null && b.tree_end === b.tree_start;',
    to: '    const sameTree = ended;',
    why: 'results of a batch whose tree changed read as evidence',
    killed_by: /evidence is historical; applies says whether it is about the given tree/,
  },
  {
    id: 'E2', file: LIB, tests: [T_REC],
    from: '          applies: treeDigest === null ? null : evidence && b.tree_start === treeDigest,',
    to: '          applies: treeDigest === null ? true : evidence && b.tree_start === treeDigest,',
    why: 'evidence reads as applying to a tree nobody named',
    killed_by: /evidence is historical; applies says whether it is about the given tree/,
  },
  {
    id: 'E3', file: STATE, tests: [T_REC],
    from: '    if (!(\'verify_request\' in fm) || fm.verify_results.request_id !== fm.verify_request.id) {',
    to: "    if (!('verify_request' in fm)) {",
    why: "results of another request are read as this request's",
    killed_by: /the parser refuses what does not hold together/,
  },

  // ---- O: the orchestrator ----------------------------------------------------
  {
    id: 'O1', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: '    if (c.kind === \'halt\' && c.runWide) { runWide ??= c.halt; continue; }\n',
    to: '',
    why: 'the refusal is only a lane halt: another lane\'s forced step starts beside a run whose footing is wrong',
    killed_by: /with lanes the halt is run-wide/,
  },
  {
    id: 'O2', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: "    if (ns?.kind === 'verify') {\n      const label",
    to: "    if (false) {\n      const label",
    why: 'with no refusal at all, a verify child at HIGH falls through to a commit',
    killed_by: /a serial run halts owner-choice naming the missing driver support/,
  },
  {
    id: 'O3', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: '  if (runWide) return runWide;\n',
    to: '',
    why: 'with lanes, the verify child\'s halt is collected and dropped, and the other lanes step beside it',
    killed_by: /with lanes the halt is run-wide/,
  },
  {
    id: 'O8', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: "  if (child.location === 'active') {\n    if (child.awaiting_owner?.gate) {",
    to: "  if (child.location === 'active') {\n    if (child.next_step?.kind === 'verify') return { kind: 'halt', runWide: true, halt: halt('owner-choice', verifyRefusalText(id, 'verify'), { subtaskId: id, scope: 'run' }) };\n    if (child.awaiting_owner?.gate) {",
    why: 'the verify refusal hides an owner gate, a pending peer or an interrupted commit, and its advice leads to the commit phase it then refuses',
    killed_by: /it comes after what a child needs whatever its next step/,
  },
  {
    id: 'O9', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: "pointer: pointerOf('next_step'), scope: 'run' }) };",
    to: "pointer: pointerOf('next_step') }) };",
    why: 'the run-wide halt reads as a lane\'s to a reader that tells them apart by scope',
    killed_by: /the halt is marked the run's/,
  },
  {
    id: 'O10', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: "    if (ns?.kind === 'verify') {\n      const label",
    to: "    if (child.current_phase === 'phase-7-commit' || (child.terminal_marker === true && COMMIT_SURFACE_PHASES.has(child.current_phase))) return { kind: 'active', step: { kind: 'commit', subtaskId: id, branch: child.branch, recovery: true } };\n    if (ns?.kind === 'verify') {\n      const label",
    why: 'the commit recovery comes first, so a child with a pending request and a commit begun is routed to a commit (MAJOR 4 of the seventh critique)',
    killed_by: /it comes before the commit recovery/,
  },
  {
    id: 'O4', file: `${AP}/policy.mjs`, tests: [T_ORCH],
    from: '  if (c.verify) {',
    to: '  if (false) {',
    why: "a batch's results are no change of the child: the step after a passing batch halts no-progress",
    killed_by: /recording a result, an end or the answer moves the lane fingerprint/,
  },
  {
    id: 'O5', file: `${AP}/observe.mjs`, tests: [T_ORCH],
    from: '  const res = fm.verify_results && typeof fm.verify_results === \'object\' && fm.verify_results.request_id === req.id',
    to: "  const res = fm.verify_results && typeof fm.verify_results === 'object'",
    why: "another request's results move this request's summary",
    killed_by: /results of another request count for nothing/,
  },
  {
    id: 'O5b', file: `${AP}/observe.mjs`, tests: [T_ORCH],
    from: '    verify: verifySummary(fm),\n',
    to: '',
    why: "the observer never reads a child's request, so a batch's results are no change of the lane child and the step after a pass halts no-progress",
    killed_by: /observe reads a real child's request and results into the view/,
  },
  {
    id: 'O6', file: `${AP}/worker.mjs`, tests: [T_ORCH],
    from: "  'AGENTIC_AUTOPILOT_VERIFY', 'AGENTIC_AUTOPILOT_STEP',\n",
    to: '',
    why: "an inherited offer reaches a worker of a driver that runs no batch, so its step writes verify",
    killed_by: /never reach a worker of this driver/,
  },
  {
    id: 'O11', file: `${AP}/worker.mjs`, tests: [T_ORCH, T_WORK],
    from: '  if (Number.isSafeInteger(seq) && seq > 0) env.AGENTIC_AUTOPILOT_STEP = String(seq);\n',
    to: '',
    why: "the driver's steps carry no number, so a step's delayed write cannot be told from its run's next step, and it rolls back the owner's decision",
    killed_by: [/each step gets its own number/, /sets the run, the step's number and the roots/],
  },
  {
    id: 'O12', file: `${AP}/worker.mjs`, tests: [T_WORK],
    from: 'workerEnv(env, { runId: o.runId, seq: o.seq, roots: o.roots,',
    to: 'workerEnv(env, { runId: o.runId, roots: o.roots,',
    why: 'the worker the driver starts gets no step number, whatever workerEnv does with one',
    killed_by: /sets the run, the step's number and the roots/,
  },
  {
    id: 'O7', file: `${AP}/dead-runs.mjs`, tests: [T_DEAD],
    from: "    strict.steps = strict.steps.filter((s) => s.kind !== 'verify');\n",
    to: '',
    why: "a newer driver's batch is counted as a step, and its peer attribution takes a peer for the batch's",
    killed_by: /cleaning up after a newer driver's batches/,
  },
];
