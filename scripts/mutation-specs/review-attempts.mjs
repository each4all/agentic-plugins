// Mutation spec — do the review-attempt tests catch a review attempt recorded
// with the wrong outcome, or not at all (C163 A1a)?
//
// Run: npm run mutate -- scripts/mutation-specs/review-attempts.mjs
//
// Every review attempt keeps one outcome in the workflow's `review_attempts`
// scalar (ADR-0023, implementation note of 2026-11-05). The defects go into
// the canonical source (persona-pipeline/files/scripts/, regenerated into
// every persona, the way a real edit travels) or the orchestrator's hand copy:
//
//   O  the outcome mapping: each of passed, concerns, conflict, unavailable,
//      malformed, degraded (an empty answer, or the synthesis's verdict) and
//      failed mapped to another;
//   N  a review that never launched: not recorded, recorded as another
//      outcome, recorded again on a rerun (or through another spelling of
//      the path), or not recorded when no reason was given; a run whose
//      prompt cannot be read leaving no attempt;
//   S  superseded: the replacement dropped;
//   T  the tree: the snapshot's tree not copied from the handle, or dropped
//      for a snapshot of an unborn branch;
//   H  the history: registration dropped, the byte cap shrunk below 25
//      full-size attempts, an open attempt or a legacy row read as passed, a corrupt
//      document that throws, or that a closing commit replaces, a document
//      begun after earlier reviews, or when a full results list holds none
//      (by the writer or by the reader), that claims to be complete; a gap a
//      reader saw withdrawn (H9-H14: the reader's own missing-outcome, rows an
//      older writer pruned unseen, by the reader or by the next write, the
//      watermark never moved, never begun, or refusing a long run id);
//   W  a repeat commit backfilling an outcome (for a legacy row, or over an
//      older writer's result on an open attempt), a commit with only a verdict
//      (no run evidence) recording one, the ensemble-commit CLI leaving its
//      review attempt open (W13) or closing one whose run has a ledger
//      (W14), a gap lost with its pruned
//      row (by a review commit, by a commit of another type, or by the write
//      that appends and prunes it, or with an attempt the document refuses), a document
//      begun for a workflow with no review, a superseded attempt dropping its
//      tree, a supersede that recorded nothing reporting success, open
//      attempts past the byte cap, a closed attempt closed again taking the
//      later outcome (W12);
//   N7, N8 the /start lifecycle's empty-id settle naming no review (Claude's
//      command, and the shared skill Codex's $start follows);
//   N9-N17 a Codex verb skill's settle naming no reason for a review that
//      never launched, settling no launched run, dispatching with no
//      --kind ensemble, taking a type outside its verb's review types, a
//      reason settle does not know, a verdict settle does not map or one
//      with no run launched, or a placeholder left unfilled or misjudged;
//   N18-N23 a looping refine: the skill's pass settle settling no run, or
//      taking a word a refine synthesis does not use, the Claude refine
//      command no longer naming the pass settle, the pass settle recording
//      no attempt for a pass that launched no run, passing a fixed verdict
//      for its own, or taking a pass with neither a run nor a reason;
//   N24-N26 one attempt per review: the /start lifecycle settling a looping
//      refine's earlier passes beside the pass settle, and a Codex verb
//      skill's settle or a Claude finalize keying a review that never
//      launched by the checkout, so a later one merges into the first;
//   F1 a critique finalize recording a never-launched adversarial-scan as review;
//   G1 the finalize's type check taking a type the runner refuses;
//   M  the orchestrator's plan-verify recorded passed whatever its run did:
//      every outcome passed, the verdict taken when no ledger is there or a
//      completed answer is empty, a run registered by its pending row or by
//      its attempt alone, its ledger gone, read as never launched, a ledger
//      missed through a linked directory, a repeat closing an open attempt, a
//      commit of another type losing a gap, a failed run taking the verdict, a
//      ledger of another type or phase taken for this attempt's, the tree of a
//      run's snapshot dropped or
//      misread, a completed run whose envelope is gone or torn taking the
//      verdict.
//
// Each case names the test that must catch it (killed_by): the library copy
// in the orchestrator also differs from the source after a canonical edit, so
// the mirror test fails beside it, and a kill must come from the contract.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { MutationHarnessError } from '../mutation-harness.mjs';

const T_RA = 'tests/persona-pipeline/test-review-attempts.mjs';
const T_ORCH = 'tests/orchestrator/test-state.mjs';
// Runs every verb's finalize block in three shells: a long file, so its case
// (F1) goes in a verification check of its own.
const T_RV = 'tests/persona-pipeline/test-verb-runbook-runs.mjs';

export const TESTS = [T_RA];

function regenerate(copy) {
  try {
    execFileSync(process.execPath, [join(copy, 'scripts/sync-persona-pipeline.mjs'), '--write'], { cwd: copy, stdio: 'pipe' });
  } catch (err) {
    throw new MutationHarnessError(`regeneration failed in the copy: ${err.stderr?.toString() || err.message}`);
  }
}

// Edit a canonical file (under persona-pipeline/files/scripts/) and regenerate every persona's copy.
const canonical = (file, from, to) => (copy, tools) => {
  tools.applyEdit(copy, { file: `persona-pipeline/files/scripts/${file}`, from, to });
  regenerate(copy);
};

const LIB = 'lib/review-attempts.mjs';

export const MUTATIONS = [
  // ---- O: the outcome mapping -------------------------------------------------
  {
    id: 'O1', tests: [T_RA],
    prepare: canonical(LIB, "  if (PASSED_VERDICTS.has(verdict)) return { outcome: 'passed', reason: null };\n", ''),
    killed_by: /a completed run with verdict agreed: passed, the raw verdict kept$/,
    why: 'a usable review with verdict agreed is recorded failed (unrecognized), not passed',
  },
  {
    id: 'O2', tests: [T_RA],
    prepare: canonical(LIB, "  if (verdict === 'concerns') return { outcome: 'concerns', reason: null };\n", ''),
    killed_by: /a completed run with verdict concerns: concerns, the raw verdict kept$/,
    why: 'a review with concerns is recorded failed, not concerns',
  },
  {
    id: 'O3', tests: [T_RA],
    prepare: canonical(LIB, "  if (verdict === 'conflict') return { outcome: 'conflict', reason: null };\n", "  if (verdict === 'conflict') return { outcome: 'concerns', reason: null };\n"),
    killed_by: /a completed run with verdict conflict: conflict, the raw verdict kept$/,
    why: 'a conflict is recorded as concerns',
  },
  {
    id: 'O4', tests: [T_RA],
    prepare: canonical(LIB, "    if (UNAVAILABLE_KINDS.has(error_kind)) return { outcome: 'unavailable', reason: why };\n", ''),
    killed_by: /a missing peer CLI: unavailable \(the legacy row still says failed\)$/,
    why: 'a peer that could not be found or run is recorded failed, not unavailable',
  },
  {
    id: 'O5', tests: [T_RA],
    prepare: canonical(LIB, "    if (MALFORMED_KINDS.has(error_kind)) return { outcome: 'malformed', reason: why };\n", ''),
    killed_by: /an envelope that does not parse: malformed$/,
    why: 'an envelope that cannot be parsed is recorded failed, not malformed',
  },
  {
    id: 'O6', tests: [T_RA],
    prepare: canonical(LIB, "  if (answer === 'empty' || answer === 'unreadable') return { outcome: 'degraded', reason: `answer-${answer}` };\n", ''),
    killed_by: /an empty answer: degraded$/,
    why: 'a completed run with an empty answer is not recorded degraded',
  },
  {
    id: 'O7', tests: [T_RA],
    prepare: canonical(LIB, "    return { outcome: 'failed', reason: why };\n", "    return { outcome: 'degraded', reason: why };\n"),
    killed_by: /a run that failed otherwise: failed with its error kind/,
    why: 'a run that failed is recorded degraded',
  },
  // ---- N: a review that never launched -------------------------------------------
  {
    id: 'N1', tests: [T_RA],
    prepare: canonical('peer-runner.mjs', "  if (!isReviewType(ensembleType)) return {};\n", "  if (ensembleType) return {};\n"),
    killed_by: /is recorded with its reason, once per finalize, and adds no legacy row or pending entry$/,
    why: 'a review that never launched leaves no attempt, as before A1a',
  },
  {
    id: 'N2', tests: [T_RA],
    prepare: canonical(LIB, "  'peer-unavailable': 'unavailable',\n", "  'peer-unavailable': 'skipped',\n"),
    killed_by: /a peer that was never found: unavailable, through the CLI$/,
    why: 'a peer never found is recorded skipped, not unavailable',
  },
  {
    id: 'N3', tests: [T_RA],
    prepare: canonical('peer-runner.mjs', ".update([physical(workflowPath), phase, ensembleType, physical(attemptKey)].join('\\0'))", ".update([physical(workflowPath), phase, ensembleType, physical(attemptKey), randomBytes(4).toString('hex')].join('\\0'))"),
    killed_by: /is recorded with its reason, once per finalize, and adds no legacy row or pending entry$/,
    why: 'a rerun of the same finalize records the never-launched review a second time',
  },
  {
    id: 'N4', tests: [T_RA],
    prepare: canonical('peer-runner.mjs', "  const reason = given ? noRunReason : 'unspecified';\n", "  const reason = given ? noRunReason : undefined;\n"),
    killed_by: /a review with no reason given is recorded skipped, reason unspecified/,
    why: 'a review that never launched, with no reason given, leaves no attempt (a skipped attempt needs its reason), as before A1a',
  },
  // ---- S: superseded -------------------------------------------------------------
  {
    id: 'S1', tests: [T_RA],
    prepare: canonical('state.mjs', "      superseded_by: supersededBy, tree: null, tree_reason: 'superseded', recorded_at: nowIso,\n", "      tree: null, tree_reason: 'superseded', recorded_at: nowIso,\n"),
    killed_by: /an open attempt replaced by another reads superseded, with its replacement/,
    why: 'a superseded attempt without its replacement is refused by the document check, so it is never recorded',
  },
  // ---- T: the tree ----------------------------------------------------------------
  {
    id: 'T1', tests: [T_RA],
    prepare: canonical('peer-runner.mjs', "    error_kind: handle.error_kind ?? null,\n    ...treeOf(handle),\n", "    error_kind: handle.error_kind ?? null,\n    tree: null, tree_reason: 'no-snapshot',\n"),
    killed_by: /the tree its snapshot held, not the checkout now$/,
    why: 'the tree the peer saw is not copied from its snapshot record',
  },
  {
    id: 'T2', tests: [T_RA],
    prepare: canonical(LIB, "  if (s.isolation === 'snapshot' && (hash(s.head) || hash(s.index_tree) || hash(s.worktree_tree))) {\n", "  if (s.isolation === 'snapshot' && hash(s.head)) {\n"),
    killed_by: /a snapshot of an unborn branch keeps its trees, with no head, through the real runner$/,
    why: 'a snapshot of an unborn branch, which isolated the peer and took its trees, is recorded with no tree, not-isolated',
  },
  // ---- H: the history ---------------------------------------------------------------
  {
    id: 'H1', tests: [T_RA],
    prepare: canonical('state.mjs', "    stageReviewAttempt(frontmatter, {\n      id: run_id, phase, type: ensemble_type, state: 'open', run_id, registered_at: nowIso,\n    });\n", ''),
    killed_by: /a review run is open \(unknown\) from its dispatch until settled/,
    why: 'a review is not registered at dispatch, so one that never settles leaves nothing',
  },
  {
    id: 'H2', tests: [T_RA],
    prepare: canonical(LIB, 'export const REVIEW_ATTEMPTS_MAX_BYTES = 32768;\n', 'export const REVIEW_ATTEMPTS_MAX_BYTES = 8192;\n'),
    killed_by: /past 20 results, every attempt is kept and the history stays complete$/,
    why: 'a byte cap that holds about 18 full-size attempts (a run id, its registration, its tree) truncates the history before the 20-row results cap would',
  },
  {
    id: 'H3', tests: [T_RA],
    prepare: canonical(LIB, "    legacy.push({ run_id: r.run_id, phase: r.phase, ensemble_type: r.ensemble_type, verdict: r.verdict, outcome: UNKNOWN_OUTCOME });\n",
      "    legacy.push({ run_id: r.run_id, phase: r.phase, ensemble_type: r.ensemble_type, verdict: r.verdict, outcome: r.verdict === 'agreed' ? 'passed' : UNKNOWN_OUTCOME });\n"),
    killed_by: /a review result with no attempt reads unknown, never passed, and the history incomplete$/,
    why: 'an old review result with verdict agreed reads passed with no recorded outcome',
  },
  {
    id: 'H4', tests: [T_RA],
    prepare: canonical(LIB, '    return { ...a, outcome: open ? UNKNOWN_OUTCOME : a.outcome };\n', "    return { ...a, outcome: a.outcome ?? 'passed' };\n"),
    killed_by: /a review run is open \(unknown\) from its dispatch until settled/,
    why: 'an attempt that never closed reads passed',
  },
  {
    id: 'H5', tests: [T_RA],
    prepare: canonical(LIB, "    return { state: 'unreadable', doc: null, diagnostic: `${REVIEW_ATTEMPTS_KEY} is not JSON (${err.message})` };\n", '    throw err;\n'),
    killed_by: /a corrupt or later-version document leaves the workflow readable, reads unknown, and is never rewritten$/,
    why: 'a corrupt document makes the reader throw instead of reading unknown',
  },
  {
    id: 'H6', tests: [T_RA],
    prepare: canonical(LIB, '  const before = rows.some(isReviewRow) || rows.length >= cap;\n', '  const before = rows.some(isReviewRow);\n'),
    killed_by: /a document begun when the full results list holds no review is incomplete from the start$/,
    why: 'a document begun when the full results list holds no review (earlier reviews pruned by other commits) claims a complete history, and no other reason marks it',
  },
  {
    id: 'H7', tests: [T_RA],
    prepare: canonical(LIB, "  if (decoded.state === 'later-version' || decoded.state === 'unreadable') {\n", "  if (decoded.state === 'later-version') {\n"),
    killed_by: /a corrupt or later-version document leaves the workflow readable, reads unknown, and is never rewritten$/,
    why: 'a commit that closes an attempt replaces a corrupt document with a fresh one, losing the history it held',
  },
  {
    id: 'H8', tests: [T_RA],
    prepare: canonical(LIB, "  if (decoded.state === 'absent' && (results.some(isReviewRow) || results.length >= cap)) reasons.add('pre-instrumentation');\n", "  if (decoded.state === 'absent' && results.some(isReviewRow)) reasons.add('pre-instrumentation');\n"),
    killed_by: /a document begun when the full results list holds no review is incomplete from the start$/,
    why: 'with no document, a full results list that holds no review reads as a complete history, though earlier reviews may have been pruned',
  },
  {
    id: 'O8', tests: [T_RA],
    prepare: canonical(LIB, "  if (verdict === 'degraded') return { outcome: 'degraded', reason: 'verdict-degraded' };\n", ''),
    killed_by: /a completed run the synthesis judged unusable \(verdict degraded\): degraded, verdict-degraded$/,
    why: 'a completed run whose answer the synthesis judged unusable (the runbooks pass verdict degraded) is recorded failed, unrecognized-verdict',
  },
  {
    id: 'N8', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-start-command-intro.md', from: '--no-run-reason <peer-unavailable|local-only|privacy-gate|owner-skip>\n--attempt-key <a new text directory for that settle>`, so the workflow records\n', to: '`, so the workflow records\n' });
      regenerate(copy);
    },
    killed_by: /the shared skill Codex's \$start follows names it too$/,
    why: "the shared skill Codex's $start follows names no reason or key on a review phase's empty-id settle, so a review it never ran is recorded with none, or not at all",
  },
  {
    id: 'N5', tests: [T_RA],
    prepare: canonical('peer-runner.mjs', ".update([physical(workflowPath), phase, ensembleType, physical(attemptKey)].join('\\0'))", ".update([workflowPath, phase, ensembleType, physical(attemptKey)].join('\\0'))"),
    killed_by: /a rerun of the same finalize through a linked directory names the same attempt$/,
    why: 'another spelling of the workflow path records the never-launched review twice',
  },
  {
    id: 'N6', tests: [T_RA],
    prepare: canonical('peer-runner.mjs', "      if (failed.kind === 'ensemble' && typeof failed.workflow_path === 'string' && isReviewType(failed.ensemble_type)) {\n", "      if (false) {\n"),
    killed_by: /a run whose prompt cannot be read records its attempt failed, prompt_unreadable$/,
    why: 'a run that fails before its pending row leaves no attempt when no finalize settles it',
  },
  // ---- W: what a writer must not make up, and must not lose ------------------------------
  {
    id: 'W1', tests: [T_RA],
    prepare: canonical('state.mjs', '    if (!alreadyCommitted && isReviewType(ensemble_type) && review) {\n', '    if (isReviewType(ensemble_type) && review) {\n'),
    killed_by: /a repeat commit of a legacy result makes no outcome of its own: the row stays unknown$/,
    why: 'a repeat commit of a legacy row backfills an outcome the row never had',
  },
  {
    id: 'W2', tests: [T_RA],
    prepare: canonical(LIB, "  if (rows.some((r) => isReviewRow(r) && !known.has(r.run_id))) add.push('missing-outcome');\n", ''),
    killed_by: /a gap the results showed outlives the row once it is pruned$/,
    why: 'a gap seen in the results is lost with the pruned row, and the history claims complete',
  },
  {
    id: 'W3', tests: [T_RA],
    prepare: canonical(LIB, "    if (record.state === 'closed' && existing.state === 'closed' && existing.outcome === 'superseded'\n", "    if (record.state === 'closed' && existing.state === 'closed' && existing.outcome === 'never'\n"),
    killed_by: /a superseded attempt keeps its outcome and takes the tree its settlement read$/,
    why: 'a superseded attempt drops the tree its settlement read from the snapshot',
  },
  {
    id: 'W4', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/files/scripts/state.mjs', from: "  if (!isReviewAttemptId(supersededBy)) throw new Error(`supersedeReviewAttempt: ${JSON.stringify(supersededBy)} is not an attempt id`);\n", to: '' });
      tools.applyEdit(copy, { file: 'persona-pipeline/files/scripts/state.mjs', from: "    if (!out.recorded) throw new Error(`supersedeReviewAttempt: ${attemptId} was not recorded superseded (${out.diagnostic ?? 'the document cannot be written'})`);\n", to: '' });
      regenerate(copy);
    },
    killed_by: /a supersede naming no attempt id fails, and the attempt stays open$/,
    why: 'a supersede that recorded nothing reports success',
  },
  {
    id: 'W5', tests: [T_RA],
    prepare: canonical(LIB, '    if (i === -1) i = 0;\n', '    if (i === -1) break;\n'),
    killed_by: /past the byte cap with only open attempts, the oldest open ones go too, said so$/,
    why: 'open attempts grow the document past its byte cap',
  },
  {
    id: 'W6', tests: [T_RA],
    prepare: canonical('state.mjs', '    if (!alreadyCommitted && isReviewType(ensemble_type) && review) {\n', '    if ((!alreadyCommitted || pending.some((e) => e.run_id === run_id)) && isReviewType(ensemble_type) && review) {\n'),
    killed_by: /a repeat over an older writer's result leaves the open attempt unknown, never passed, and says legacy-writer$/,
    why: "a repeat commit closes an attempt an older writer settled from that writer's verdict, so a legacy verdict reads passed",
  },
  {
    id: 'W7', tests: [T_RA],
    prepare: canonical('state.mjs', "      stageReviewAttempt(frontmatter, { id: run_id, phase, type: ensemble_type, state: 'gaps' }, prunes);\n", "      if (isReviewType(ensemble_type)) stageReviewAttempt(frontmatter, { id: run_id, phase, type: ensemble_type, state: 'gaps' }, prunes);\n"),
    killed_by: /a commit of a type that is no review records the gaps of the review rows its prune drops$/,
    why: 'commits of another type prune a review row with no attempt and leave the history claiming complete',
  },
  {
    id: 'W8', tests: [T_RA],
    prepare: canonical(LIB, '  if (!decoded.doc && !(Array.isArray(listed) && listed.some(isReviewRow))) return { changed: false, raw };\n', ''),
    killed_by: /with no document, non-review commits begin one only when a review row is there to lose$/,
    why: 'every commit of a workflow that never held a review writes a review document',
  },
  {
    id: 'W9', tests: [T_RA],
    // The caller's verdict made into the evidence, so the close runs as it
    // would with a review (no crash on a null one), and records passed.
    prepare: canonical('state.mjs', '    if (!alreadyCommitted && isReviewType(ensemble_type) && review) {\n',
      "    if (!alreadyCommitted && isReviewType(ensemble_type) && (review ??= { outcome: { agreed: 'passed', resolved: 'passed', pass: 'passed' }[verdict] ?? verdict })) {\n"),
    killed_by: /a commit with only a verdict \(an in-process caller with no run evidence\) records no outcome: the row reads unknown, never passed$/,
    why: "a commit with only the caller's verdict (no run evidence) records passed",
  },
  {
    id: 'W10', tests: [T_RA],
    prepare: canonical('state.mjs', '    const prunes = { listed: next, cap };\n', '    const prunes = { listed: existing, cap };\n'),
    killed_by: /a review row appended and pruned in the same write still leaves its gap$/,
    why: 'a row the write appends and prunes at once (an older completed_at) leaves no gap, and the history claims complete',
  },
  {
    id: 'F1', tests: [T_RV],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/verb-finalize-consensus.md', from: '  set -- --ensemble-type "$ATTEMPT_TYPE" --no-run-reason', to: "  set -- --ensemble-type 'review' --no-run-reason" });
      regenerate(copy);
    },
    killed_by: /critique's finalize: completed → the synthesis verdict/,
    why: "a critique whose dispatch would have run adversarial-scan (an audit, a red-team) records the review that never launched as review",
  },
  {
    id: 'W11', tests: [T_RA],
    prepare: canonical('state.mjs', "    const gaps = observeReviewGaps(frontmatter[REVIEW_ATTEMPTS_KEY], frontmatter.ensemble_results, { cap, listed });\n    out = { recorded: false, changed: gaps.changed, raw: gaps.raw, kept: null, diagnostic: err.message };\n",
      "    out = { recorded: false, changed: false, kept: null, diagnostic: err.message };\n"),
    killed_by: /an attempt the document refuses still leaves the gap of its pruned row$/,
    why: 'an attempt the document refuses (a run id past 160 characters) takes the gap of its pruned row with it',
  },
  {
    id: 'G1', tests: [T_RV],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/verb-finalize-consensus.md', from: "  ''|[!abcdefghijklmnopqrstuvwxyz]*|*[!abcdefghijklmnopqrstuvwxyz-]*|", to: "  ''|*[!abcdefghijklmnopqrstuvwxyz-]*|" });
      regenerate(copy);
    },
    killed_by: /critique's finalize: completed → the synthesis verdict/,
    why: 'a type the runner refuses (a leading hyphen) passes the finalize check and fails later, at settle, after the block kept its run',
  },
  {
    id: 'N7', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/start-phase-boundary.md', from: '  type> --no-run-reason <peer-unavailable|local-only|privacy-gate|owner-skip>\n', to: '  type>\n' });
      regenerate(copy);
    },
    killed_by: /names the review that never launched on its empty-id settle$/,
    why: "the /start lifecycle's empty-id settle names no reason, so a review it never ran is recorded with none",
  },
  // ---- M: the orchestrator's hand copy -------------------------------------------------
  {
    id: 'M1', tests: [T_ORCH],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: "        outcome: mapped.outcome, verdict, reason: mapped.reason ?? undefined,\n",
    to: "        outcome: 'passed', verdict, reason: mapped.reason ?? undefined,\n",
    killed_by: /a plan-verify attempt is registered open, then closed with its outcome; past the cap it is kept$/,
    why: "the orchestrator records every plan-verify passed, a failed one included",
  },
  {
    id: 'M2', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: "        mapped = registered ? { outcome: 'failed', reason: 'ledger_missing' } : { outcome: 'unavailable', reason: 'no-ledger' };\n",
    to: '        mapped = outcomeOf({ verdict });\n',
    killed_by: /a run that found no peer records unavailable, though the commit says pass$/,
    why: "the orchestrator takes the local synthesis's pass for the outcome of a run that found no peer",
  },
  {
    id: 'M3', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '          : { status, answer: ledgerAnswer(ledger.dir, handle), verdict });\n',
    to: '          : { status, verdict });\n',
    killed_by: /a run that completed with an empty answer records degraded, though the commit says pass$/,
    why: 'a completed run whose answer was empty records the local pass',
  },
  {
    id: 'M4', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '        const registered = pending.some((e) => e.run_id === run_id)\n',
    to: '        const registered = false && pending.some((e) => e.run_id === run_id)\n',
    killed_by: /a run registered by its pending row alone, its ledger gone, records failed, ledger_missing$/,
    why: "a run an older writer registered by its pending row alone, whose ledger is gone, reads as one that never launched",
  },
  {
    id: 'M7', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '          || (doc?.attempts ?? []).some((a) => (a.run_id ?? a.id) === run_id);\n',
    to: '          || false;\n',
    killed_by: /a run registered by its open attempt alone, its ledger gone, records failed, ledger_missing$/,
    why: 'a run registered by its open attempt, its pending row and ledger gone, reads as one that never launched',
  },
  {
    id: 'M8', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '  const homes = [...new Set([dirname(dirname(resolvePath(workflowPath))), dirname(dirname(real))])];\n',
    to: '  const homes = [dirname(dirname(resolvePath(workflowPath)))];\n',
    killed_by: /a run launched and committed through a linked directory reads the ledger beside the real file$/,
    why: 'a macro path through a linked directory misses the ledger the runner wrote, and a completed run reads failed',
  },
  {
    id: 'M5', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '    if (!alreadyCommitted && isReviewType(ensemble_type)) {\n',
    to: '    if ((!alreadyCommitted || pending.some((e) => e.run_id === run_id)) && isReviewType(ensemble_type)) {\n',
    killed_by: /a repeat over an older writer's result leaves the open attempt unknown, and says legacy-writer$/,
    why: "the orchestrator closes an attempt an older writer settled from that writer's verdict",
  },
  {
    id: 'M6', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '    } else {\n      const out = observeReviewGaps(frontmatter[REVIEW_ATTEMPTS_KEY], frontmatter.ensemble_results, prunes);\n',
    to: '    } else if (isReviewType(ensemble_type)) {\n      const out = observeReviewGaps(frontmatter[REVIEW_ATTEMPTS_KEY], frontmatter.ensemble_results, prunes);\n',
    killed_by: /a macro commit of a type that is no review records the gaps of the review rows its prune drops$/,
    why: "the orchestrator's commits of another type prune a review row with no attempt and leave the history claiming complete",
  },
  {
    id: 'M9', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '          ? { status, error_kind: handle.error_kind ?? null }\n',
    to: '          ? { verdict }\n',
    killed_by: /a run that failed records how it ended, though the commit says pass$/,
    why: "a plan-verify run that failed (malformed, cancelled, unavailable) records the plan's pass",
  },
  {
    id: 'M10', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '      const mismatch = found !== null && (found.phase !== phase || found.ensemble_type !== ensemble_type);\n',
    to: '      const mismatch = found !== null && (found.phase !== phase);\n',
    killed_by: /a completed run of another type or phase records failed, ledger-mismatch, though the commit says pass$/,
    why: "a completed run of another ensemble type, committed as the plan's plan-verify, records passed",
  },
  {
    id: 'M11', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '      const mismatch = found !== null && (found.phase !== phase || found.ensemble_type !== ensemble_type);\n',
    to: '      const mismatch = found !== null && (found.ensemble_type !== ensemble_type);\n',
    killed_by: /a completed run of another type or phase records failed, ledger-mismatch, though the commit says pass$/,
    why: "a completed plan-verify run of another phase, committed as this phase's, records passed",
  },
  {
    id: 'M12', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: "    const gaps = observeReviewGaps(frontmatter[REVIEW_ATTEMPTS_KEY], frontmatter.ensemble_results, { cap, listed });\n    out = { recorded: false, changed: gaps.changed, raw: gaps.raw, diagnostic: err.message };\n",
    to: "    out = { recorded: false, changed: false, diagnostic: err.message };\n",
    killed_by: /a macro attempt the document refuses still leaves the gap of its pruned row$/,
    why: "the orchestrator's refused attempt takes the gap of its pruned row with it",
  },
  {
    id: 'M13', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: '        tree = treeOf(handle);\n',
    to: "        tree = { tree: null, tree_reason: 'not-isolated' };\n",
    killed_by: /a run in a checkout keeps the tree its snapshot held$/,
    why: 'a plan-verify run the runner isolated in a snapshot is recorded with no tree, not-isolated',
  },
  {
    id: 'M14', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/lib/review-attempts.mjs',
    from: '        worktree_tree: hash(s.worktree_tree) ? s.worktree_tree : null,\n',
    to: '        worktree_tree: hash(s.index_tree) ? s.index_tree : null,\n',
    killed_by: /a run in a checkout keeps the tree its snapshot held$/,
    why: "a plan-verify attempt records a worktree tree other than the one its peer's snapshot held",
  },
  {
    id: 'M15', tests: [T_RA],
    file: 'plugins/orchestrator/scripts/state.mjs',
    from: "  if (answer === null) return 'unreadable';\n",
    to: '  if (answer === null) return null;\n',
    killed_by: /a completed run whose envelope is gone records degraded, answer-unreadable, though the commit says pass$/,
    why: "a completed plan-verify run whose envelope is gone or torn records the plan's local pass as passed",
  },
  // ---- H9-H14: a gap a reader saw, never withdrawn -------------------------------
  {
    id: 'H9', tests: [T_RA],
    prepare: canonical(LIB, "    if (decoded.state === 'ok') reasons.add('missing-outcome');\n", ''),
    killed_by: /a review row an older writer added beside the document reads missing-outcome to a reader, before any write records it$/,
    why: "the reader says nothing of a review row an older writer settled beside the document, so the history reads complete until a writer of this version sees the row",
  },
  {
    id: 'H10', tests: [T_RA],
    prepare: canonical(LIB, "  if (decoded.state === 'ok' && prunedUnseen(decoded.doc, results, cap)) reasons.add('pruned-unseen');\n", ''),
    killed_by: /a gap a reader saw is never withdrawn when an older writer prunes its row unseen$/,
    why: 'once an older writer prunes the review row a reader saw as missing, the reader reads the history complete again',
  },
  {
    id: 'H11', tests: [T_RA],
    prepare: canonical(LIB, "  if (prunedUnseen(doc, results, cap)) add.push('pruned-unseen');\n", ''),
    killed_by: /a gap a reader saw is never withdrawn when an older writer prunes its row unseen$/,
    why: 'the next write of this version moves its watermark past the rows an older writer pruned unseen without keeping the gap, so the history reads complete after it',
  },
  {
    id: 'H12', tests: [T_RA],
    prepare: canonical(LIB, '  if (seen !== (doc.seen ?? null)) {\n', '  if (false) {\n'),
    killed_by: /past 20 results, every attempt is kept and the history stays complete$/,
    why: "a write that never moves its watermark takes its own writers' prunes for rows pruned unseen, and a complete history reads incomplete",
  },
  {
    id: 'H13', tests: [T_RA],
    prepare: canonical(LIB, '  return seen === null ? doc : { ...doc, seen };\n', '  return doc;\n'),
    killed_by: /a document begun when the full results list holds no review is incomplete from the start$/,
    why: 'a document begun on a full results list records no watermark, so its first write takes the list it found for rows pruned unseen',
  },
  // ---- N9–N17: the Codex verb skills settle their review --------------------------
  {
    id: 'N9', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: '    --ensemble-type "$ENSEMBLE_TYPE" --no-run-reason "$NO_RUN_REASON" \\\n', to: '    --ensemble-type "$ENSEMBLE_TYPE" \\\n' });
      regenerate(copy);
    },
    killed_by: /\$refine with no run launched records the review that never ran, once$/,
    why: "a Codex verb skill's settle of a review that never launched passes no reason, so a peer that was unavailable is recorded skipped, unspecified",
  },
  {
    id: 'N10', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: '--phase {{phase}} --run-id "$RUN_ID"', to: "--phase {{phase}} --run-id ''" });
      regenerate(copy);
    },
    killed_by: /\$refine with a run launched settles it from its ledger$/,
    why: 'a Codex verb skill settles no launched run, so its attempt stays open and reads unknown',
  },
  {
    id: 'N11', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: '`--kind ensemble --workflow-path <the active workflow>', to: '`--workflow-path <the active workflow>' });
      regenerate(copy);
    },
    killed_by: /\$refine with a run launched settles it from its ledger$/,
    why: "a Codex verb skill's dispatch flags leave the runner's default manual kind, so no attempt is registered and settle refuses the run",
  },
  {
    id: 'N12', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: '  {{review_type}}|{{review_type_other}}) ;;\n', to: '  *) ;;\n' });
      regenerate(copy);
    },
    killed_by: /a type outside the verb's review types, or an unknown reason, stops the block before any write; the other type records$/,
    why: "a Codex verb skill's settle takes a type outside its verb's review types, which settle records nothing for, and the block reports success",
  },
  {
    id: 'N13', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: "  ''|peer-unavailable|local-only|privacy-gate|owner-skip) ;;\n  *) echo \"✗ NO_RUN_REASON is not peer-unavailable, local-only, privacy-gate or owner-skip (empty when a run launched); nothing was settled.\" >&2; exit 1 ;;\n", to: "  *) ;;\n" });
      regenerate(copy);
    },
    killed_by: /a type outside the verb's review types, or an unknown reason, stops the block before any write; the other type records$/,
    why: "a Codex verb skill's settle passes a reason settle does not know, so the block's own check no longer names the fault before the write",
  },
  {
    id: 'N14', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: '    agreed|resolved|concerns|regression|conflict|degraded) ;;\n', to: '    *) ;;\n' });
      regenerate(copy);
    },
    killed_by: /a verdict settle does not map, a verdict with no run, or a value left unfilled stops the block before any write$/,
    why: "a Codex verb skill's settle passes a launched run's verdict settle does not map (AGREED, looks good, the placeholder), so a clean review is recorded failed (unrecognized-verdict) and the block exits 0",
  },
  {
    id: 'N15', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: "elif [ -n \"$VERDICT\" ]; then\n  echo \"✗ VERDICT is set, but DISPATCH_DIR is empty (no run launched, so there is no verdict): empty one or set the other; nothing was settled.\" >&2\n  exit 1\nfi\n", to: 'fi\n' });
      regenerate(copy);
    },
    killed_by: /a verdict settle does not map, a verdict with no run, or a value left unfilled stops the block before any write$/,
    why: "a Codex verb skill's settle given a verdict with DISPATCH_DIR empty records a review that never launched, though the agent synthesized a run it forgot to name",
  },
  {
    id: 'N16', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: "  case \"$FILLED\" in\n    '<'*) echo", to: "  case \"$FILLED\" in\n    '<never>'*) echo" });
      regenerate(copy);
    },
    killed_by: /a verdict settle does not map, a verdict with no run, or a value left unfilled stops the block before any write$/,
    why: "a Codex verb skill's settle with TEXT_DIR left as its placeholder records a review that never launched under the placeholder's attempt key, exit 0; with DISPATCH_DIR left as its placeholder it fails later, at the run-id read, not on the unfilled value",
  },
  {
    id: 'N17', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: "  case \"$FILLED\" in\n    '<'*) echo", to: "  case \"$FILLED\" in\n    *'<'*) echo" });
      regenerate(copy);
    },
    killed_by: /a verdict settle does not map, a verdict with no run, or a value left unfilled stops the block before any write$/,
    why: "a Codex verb skill's settle takes any \"<\" for a placeholder, so a real text directory holding one (a TMPDIR with \"<\" in it) is refused and the review is never recorded",
  },
  {
    id: 'H14', tests: [T_RA],
    prepare: canonical(LIB, '  return best !== null && resultRunId(best.run_id) ? best.run_id : null;\n', '  return best !== null && safeId(best.run_id) ? best.run_id : null;\n'),
    killed_by: /a run id past 160 characters as the newest row is a watermark like any other: no pruned-unseen$/,
    why: 'a newest row whose run id the runner accepts but the attempt document cannot hold leaves no watermark, so a full list of writes of this version reads pruned-unseen',
  },
  // ---- W12: the first outcome kept ---------------------------------------------
  {
    id: 'W12', tests: [T_RA],
    prepare: canonical(LIB, "    } else if (record.state === 'open' || existing.state === 'closed') {\n", "    } else if (record.state === 'open') {\n"),
    killed_by: /a closed attempt keeps its first outcome when the same id is closed again with another$/,
    why: 'a second closing write of an attempt already closed overwrites its outcome, so a rerun of a review that never launched (another reason, the same text directory) replaces the first outcome',
  },
  // ---- N18–N20: a looping refine settles each pass --------------------------------
  {
    id: 'N18', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-refine-pass-settle.md', from: '  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \\\n    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id "$RUN_ID"', to: '  : node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \\\n    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id "$RUN_ID"' });
      regenerate(copy);
    },
    killed_by: /a looping refine settles each pass: every attempt closes with its own outcome, and no pending row is left$/,
    why: "the refine skill's pass settle settles no run, so an earlier pass's attempt stays open (unknown) with its pending row, and a later settle naming no run is refused",
  },
  {
    id: 'N19', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-refine-pass-settle.md', from: '    resolved|concerns|regression|conflict|degraded) ;;\n', to: '    *) ;;\n' });
      regenerate(copy);
    },
    killed_by: /the pass settle refuses another host, a word a refine synthesis does not use, a reason settle does not know, a verdict with no run or a reason beside one, or a value left unfilled or empty, before any write$/,
    why: "the refine skill's pass settle passes any verdict, so agreed (no refine word) records a pass passed and AGREED records it failed (unrecognized-verdict), both with exit 0",
  },
  {
    id: 'N20', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'plugins/engineer/commands/refine.md', from: "and that pass's run is settled before the next pass, with the pass settle\nblock of", to: 'and the finalize settles them, with the\nblock of' });
    },
    killed_by: /the refine command tells a looping refine to settle each pass with the skill's pass settle$/,
    why: 'the Claude refine command no longer tells a looping refine to settle each pass, so a Claude agent settles only the last pass in its finalize and the earlier attempts stay open',
  },
  {
    id: 'N21', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-refine-pass-settle.md', from: '  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \\\n    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id \'\'', to: '  : node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \\\n    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id \'\'' });
      regenerate(copy);
    },
    killed_by: /a looping refine records a pass that launched no run: each pass one attempt, and the history reads complete$/,
    why: "the refine skill's pass settle records nothing for a pass that launched no run (the peer not found, the privacy gate), so only the last pass's attempt is in the history, which still reads complete",
  },
  {
    id: 'N22', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-refine-pass-settle.md', from: '    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?\n', to: '    --verdict concerns --summary-file "$TEXT_DIR/summary.txt" || exit $?\n' });
      regenerate(copy);
    },
    killed_by: /a looping refine settles each pass: every attempt closes with its own outcome, and no pending row is left$/,
    why: "the refine skill's pass settle passes a fixed word for the pass's verdict, so every earlier pass records concerns whatever its synthesis said (a regression's raw verdict lost)",
  },
  {
    id: 'N23', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-refine-pass-settle.md', from: '  [ -n "$NO_RUN_REASON" ] || { echo "✗ DISPATCH_DIR and NO_RUN_REASON are both empty: a pass that launched no run names why; nothing was settled." >&2; exit 1; }\n', to: '' });
      regenerate(copy);
    },
    killed_by: /the pass settle refuses another host, a word a refine synthesis does not use, a reason settle does not know, a verdict with no run or a reason beside one, or a value left unfilled or empty, before any write$/,
    why: "the refine skill's pass settle takes a pass with neither a run nor a reason (DISPATCH_DIR left empty by mistake), so, with no run pending, it records a made-up skipped (unspecified) attempt with exit 0 instead of naming the missing run",
  },
  // ---- N24–N26, W13: one attempt per review, whoever settles it ------------------
  {
    id: 'N24', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/start-phase-boundary.md', from: "  or not, as the loop goes back, so the refine phase settles here the last\n  pass's attempt only.", to: '  or not, as the loop goes back, and the refine phase settles each attempt.' });
      regenerate(copy);
    },
    killed_by: /leaves a looping refine's earlier passes to the refine skill's pass settle, on both hosts$/,
    why: "the /start lifecycle tells its refine phase to settle every pass beside the refine skill's pass settle, so a pass that launched no run is recorded twice under two attempt keys",
  },
  {
    id: 'N25', tests: [T_RA],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/regions/skill-review-settle.md', from: '    --attempt-key "$TEXT_DIR" || exit $?\n', to: '    --attempt-key "$REPO_ROOT" || exit $?\n' });
      regenerate(copy);
    },
    killed_by: /\$refine with no run launched records the review that never ran, once$/,
    why: "a Codex verb skill's settle keys a review that never launched by the checkout, not its text directory, so a later review of the verb that never launched either takes the first one's id and is dropped with exit 0",
  },
  {
    id: 'N26', tests: [T_RV],
    prepare: (copy, tools) => {
      for (const region of ['verb-finalize.md', 'verb-finalize-consensus.md', 'verb-finalize-convergent.md']) {
        tools.applyEdit(copy, { file: `persona-pipeline/regions/${region}`, from: '--no-run-reason "$NO_RUN_REASON" --attempt-key "$TEXT_DIR"', to: '--no-run-reason "$NO_RUN_REASON" --attempt-key "$REPO_ROOT"' });
      }
      regenerate(copy);
    },
    killed_by: /'s finalize: completed → the synthesis verdict/,
    why: "the Claude finalize keys a review that never launched by the checkout, not its text directory, so a later review of the verb in the same workflow that never launched either takes the first one's id and is dropped with exit 0",
  },
  {
    id: 'W13', tests: [T_RA],
    prepare: canonical('state.mjs', '          review: VERDICT_ONLY_REVIEW,\n', ''),
    killed_by: /the ensemble-commit CLI closes a review attempt failed \(verdict-only\), never passed, and a later settle keeps it$/,
    why: 'the ensemble-commit CLI, the remedy the autopilot halt names for a pending ensemble, leaves the review attempt open for good, reading unknown, with an older writer (legacy-writer) blamed',
  },
  {
    id: 'W14', tests: [T_RA],
    prepare: canonical('state.mjs', '          if (found) {\n', '          if (found && false) {\n'),
    killed_by: /the ensemble-commit CLI refuses a review whose run has a ledger, and settle then records the ledger's outcome$/,
    why: "the ensemble-commit CLI closes a review whose run has a ledger failed (verdict-only), so the outcome the ledger shows (a peer not found, a completed review's concerns) is hidden for good",
  },
];
