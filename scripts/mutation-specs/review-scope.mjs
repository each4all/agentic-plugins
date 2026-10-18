// Mutation spec — do the C120 tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/review-scope.mjs
//
// The review ledger decides when a document's critique may be scoped and when
// a critique converges; a defect there either certifies convergence the work
// did not reach or sends a document round the loop again. Each mutation puts
// one defect into every generated copy (the suite runs each persona's copy)
// and names the test file that must notice.
//
// Groups: S when a critique (or a Refine-verify) is scoped, D what is a
// document, C the close's disposition, R refuses, F falls back instead of
// stopping the verb, L where a location is, V the severity a judgment leaves,
// B the baseline.
//
// Not here: the capture's index-copy timestamps (peer-snapshot.mjs, racy git).
// Whether git trusts a stale stat depends on the second the fixture's writes
// land in, so a mutation there would be scored by the clock; the fixture that
// found it is _review-scope-suite.mjs's mixed prose and code case.

// The suite, split per persona (_review-scope-suite.mjs run by one file each).
const T = ['designer', 'engineer', 'founder'].map((p) => `tests/persona-pipeline/test-review-scope-${p}.mjs`);

const RB = 'tests/persona-pipeline/test-review-scope-runbook.mjs';

export const TESTS = [...T, RB];

const PERSONAS = ['designer', 'engineer', 'founder'];
const LIB = PERSONAS.map((p) => `plugins/${p}/scripts/lib/review-scope.mjs`);
const STATE = PERSONAS.map((p) => `plugins/${p}/scripts/state.mjs`);
const CRITIQUE = PERSONAS.map((p) => `plugins/${p}/commands/critique.md`);
const SNAPSHOT = PERSONAS.map((p) => `plugins/${p}/scripts/lib/peer-snapshot.mjs`);
const every = (files, from, to) => (copy, tools) => {
  for (const file of files) tools.applyEdit(copy, { file, from, to });
};

export const MUTATIONS = [
  // ── S: when a critique is scoped ──────────────────────────────────────────
  {
    id: 'S1', tests: T,
    prepare: every(LIB, "  if (attempt.tree_after !== current.tree) return full('tree-changed-since-the-refine-record');", ''),
    why: 'an edit after the refine record is scoped as if the refine had made it',
  },
  {
    id: 'S2', tests: T,
    prepare: every(LIB, "  if (last.head !== current.head) return full('head-moved');", ''),
    why: 'a commit since the last critique still scopes the next one',
  },
  {
    id: 'S3', tests: T,
    prepare: every(LIB, "  if (!sameSet(last.artifact, current.artifact)) return full('artifact-set-changed');", ''),
    why: 'a path added since the last critique is never reviewed',
  },
  {
    id: 'S4', tests: T,
    prepare: every(LIB, "  if (!closed.some((g) => g.mode === 'full')) return full('no-full-critique-recorded');", ''),
    why: 'a document is scoped without ever having had a full critique',
  },
  {
    id: 'S5', tests: T,
    prepare: every(LIB, "  if (current.operation) return full(`operation-in-progress:${current.operation}`);", ''),
    why: 'a merge in progress is scoped as if the tree were the refine\'s',
  },
  {
    id: 'S6', tests: T,
    prepare: every(LIB, "  if (!current.defaultProfile) return { mode: 'partial',", "  if (false) return { mode: 'partial',"),
    why: 'another review profile is scoped to the last refine',
  },
  // ── D: what is a document ─────────────────────────────────────────────────
  {
    id: 'D1', tests: T,
    prepare: every(LIB, '    if (!hasExtension(c.path, DOCUMENT_EXTENSIONS)) return', '    if (false) return'),
    why: 'prose mixed with code reads as a document',
  },
  {
    id: 'D2', tests: T,
    prepare: every(LIB, "      for (let n = h.ns; n < h.ns + h.nc; n++) if (after.has(n)) return { document: false, reason: `code-changed:${c.path}` };", ''),
    why: 'a fenced block added to a runbook reads as prose',
  },
  {
    id: 'D3', tests: T,
    prepare: every(LIB, "      for (let n = h.os; n < h.os + h.oc; n++) if (before.has(n)) return { document: false, reason: `code-changed:${c.path}` };", ''),
    why: 'a fenced block removed from a runbook reads as prose',
  },
  // ── C: the close's disposition ────────────────────────────────────────────
  {
    id: 'C1', tests: T,
    prepare: every(LIB, "      if (f.severity !== 'CRITICAL' && outsidePassages(f.location, f.scope)) disposition = 'left-open';", "      if (outsidePassages(f.location, f.scope)) disposition = 'left-open';"),
    why: 'a new CRITICAL outside the passages is left open instead of carried',
  },
  {
    id: 'C2', tests: T,
    prepare: every(LIB, '    if (overlap === true) return false;\n', ''),
    why: 'a finding the peer marks outside is left open although it sits in a changed passage',
  },
  {
    id: 'C3', tests: T,
    prepare: every(LIB, '    const single = references.length === 1 || !mustBeSingle;', '    const single = true;'),
    why: 'a target with two verdicts counts resolved',
  },
  {
    id: 'C4', tests: T,
    prepare: every(LIB, "    if (gen.mode === 'scoped') {\n      if (f.severity", "    if (true) {\n      if (f.severity"),
    why: 'a full critique leaves a MAJOR open by scope and certifies convergence',
  },
  {
    id: 'C5', tests: T,
    prepare: every(LIB, "    } else if (gen.mode === 'full' && finding.disposition !== 'resolved') {", "    } else if (finding.disposition !== 'resolved') {"),
    why: 'a scoped critique resolves a prior MAJOR the refine never targeted',
  },
  {
    id: 'C6', tests: T,
    prepare: every(LIB, '      recurring: recurringFindings(next),', '      recurring: [],'),
    why: 'a target a refine left unresolved is never recurring, so the loop goes on',
  },
  {
    id: 'C7', tests: T,
    prepare: every(LIB, "  for (const g of next.generations) if (g.state === 'open') g.state = 'abandoned';\n", ''),
    why: 'a critique a crashed run left open can still be closed after a newer one opened',
  },
  // ── R: refuses ────────────────────────────────────────────────────────────
  {
    id: 'R1', tests: T,
    prepare: every(STATE, '    if (checkout.tree !== gen.tree || checkout.head !== gen.head) {', '    if (false) {'),
    why: 'a close records findings against a tree the critique never reviewed',
  },
  {
    id: 'R2', tests: T,
    prepare: every(LIB, "    if (typeof t !== 'string' || !ids.has(t)) throw new ReviewScopeError(", "    if (false) throw new ReviewScopeError("),
    why: 'a refine records a target that names no finding',
  },
  {
    id: 'R4', tests: T,
    prepare: every(STATE, '        await rename(paths.file, superseded);\n', ''),
    why: 'a document that turned into code leaves its ledger, and refine works from findings its last critique never judged',
  },
  {
    id: 'R3', tests: T,
    // The branch is checked before the capture and again after it, so both
    // checks go.
    prepare: (copy, tools) => {
      every(STATE, '  if (early !== null && early !== expected) return onAnotherBranch(repoRoot, early);\n', '')(copy, tools);
      every(STATE, '  if (branch !== expected) return onAnotherBranch(captured.top, branch);\n', '')(copy, tools);
    },
    why: 'a checkout on another branch is held to this workflow\'s ledger',
  },
  {
    id: 'C8', tests: T,
    prepare: every(LIB, "    } else if (finding.disposition === 'left-open' && gen.mode === 'scoped' && !mustBeSingle && finding.severity !== 'CRITICAL'", "    } else if (false"),
    why: 'a left-open finding reported again outside the passages is pulled back into refine',
  },
  {
    id: 'C9', tests: T,
    // inPassages counts a location it cannot parse in scope too, so both
    // guards go.
    prepare: (copy, tools) => {
      every(LIB, "    if (typeof location !== 'string' || location.trim() === '') return false;\n", '')(copy, tools);
      every(LIB, '  if (loc === null) return true;\n', '  if (loc === null) return false;\n')(copy, tools);
    },
    why: 'a new MAJOR with no location, marked outside, is left open and lets the critique converge',
  },
  {
    id: 'C10', tests: T,
    // inPassages, not overlapsPassage: the line after it returns null there.
    prepare: every(LIB, '  if (onPath.some((p) => p.deleted || p.whole)) return true;\n  if (loc.start === null) return null;', '  if (onPath.some((p) => p.deleted)) return true;\n  if (loc.start === null) return null;'),
    why: 'a refine that left a file with no block anchors nothing, and a finding in it is left open',
  },
  {
    id: 'D4', tests: T,
    prepare: every(LIB, '  for (const n of commonmarkCodeLines(text)) code.add(n);\n', ''),
    why: 'without CommonMark, an unclosed final fence and a fence pairing reader 1 cannot see read as prose',
  },
  // ── D: the union that reads executable Markdown (the owner's M3 ruling) ──
  // Each shape in _review-scope-suite.mjs's CODE_SHAPES is the witness of one
  // of these: D4 (an unclosed final fence, inline backticks), D5 (G3, G6),
  // D8 (G4's reader-1 row), D9 (plain prose), D10 (G5's reader-1 row), D11
  // (G6, and the HTML-comment G6's reader-1 row), D12 and D13 (reader 1's
  // blank runs and neighbours; G7 is held by both, so each is checked alone),
  // D14 (a bare CR), D15 (an explicit HTML code block).
  {
    id: 'D5', tests: T,
    prepare: every(LIB, '  const code = possibleCodeLines(text);\n', '  const code = new Set();\n'),
    why: 'without reader 1, a quoted fence CommonMark closes early (G3) and indented code after a link title (G6) read as prose',
  },
  {
    id: 'D8', tests: T,
    prepare: every(LIB, '  if (fences.length > 0) for (let n = fences[0]; n <= fences.at(-1); n++) code.add(n);\n', ''),
    why: 'reader 1 pairs nothing, so without the fence range it reads the command between fences as prose',
  },
  {
    id: 'D9', tests: T,
    prepare: every(LIB, 'for (let n = fences[0]; n <= fences.at(-1); n++)', 'for (let n = fences[0]; n <= all.length; n++)'),
    why: 'the fence range runs to the end of the file, and plain prose after a closed fence reads as code (keeps 40 percent of documents)',
  },
  {
    id: 'D10', tests: T,
    prepare: every(LIB, "      if (marker === null ? start === 0 && column >= 4 : column - marker >= 5) return true;", "      if (marker === null && start === 0 && column >= 4) return true;"),
    why: 'indented code behind a quote or list marker (G5) is not read by reader 1',
  },
  {
    id: 'D11', tests: T,
    prepare: every(LIB, "      if (marker === null ? start === 0 && column >= 4 : column - marker >= 5) return true;", "      if (marker !== null && column - marker >= 5) return true;"),
    why: 'a line indented four columns, the plainest indented code, is not read by reader 1, and after a link definition title (G6) nothing reads it',
  },
  {
    id: 'D12', tests: T,
    prepare: every(LIB, '    if (blank) for (let n = indented[k] + 1; n < indented[k + 1]; n++) deep.add(n);\n', ''),
    why: 'a blank line deep in a run between two indented lines is not code',
  },
  {
    id: 'D13', tests: T,
    prepare: every(LIB, '    for (const m of [n - 1, n, n + 1]) if (m >= 1 && m <= all.length) code.add(m);', '    code.add(n);'),
    why: "an indented line's neighbours read as prose",
  },
  {
    id: 'D14', tests: T,
    prepare: every(LIB, '  if (/\\r(?!\\n)/.test(text)) return [{ start: 1, end: Math.max(1, lines(text).length) }];\n', ''),
    why: 'a bare CR shifts CommonMark\'s line numbers off git\'s, and a changed command reads as prose',
  },
  {
    id: 'D15', tests: T,
    prepare: every(LIB, "const CODE_NODE_TYPES = new Set(['code_block', 'html_block']);", "const CODE_NODE_TYPES = new Set(['code_block']);"),
    why: 'a command in an explicit HTML code block (`<pre><code>`) reads as prose, and a scoped critique can converge past it',
  },
  // The closing critique's M1 (the owner's ruling, 2026-10-15): its witness is
  // the prose edit that pulls an unchanged command into a fence.
  {
    id: 'D16', tests: T,
    prepare: every(LIB, "    if (JSON.stringify(codeBlockSequence(oldText)) !== JSON.stringify(codeBlockSequence(newText))) return { document: false, reason: `code-blocks-changed:${c.path}` };\n", ''),
    why: 'dropping a list marker pulls an unchanged command into a fence while every changed line is prose, and a scoped critique converges past a MAJOR at the command',
  },
  {
    id: 'R5', tests: T,
    prepare: every(STATE, '    if (!checkout.ok) return unrecorded(checkout.reason, { detail: checkout.message });\n', ''),
    why: 'a worktree on another branch records a refine in this workflow\'s ledger',
  },
  {
    id: 'R6', tests: T,
    prepare: every(LIB, '  ledger.generations.forEach((g, i) => {\n', '  [].forEach((g, i) => {\n'),
    why: 'a ledger with a malformed generation is used instead of moved aside',
  },
  // ── the critique's findings on C120, one defect per fix ───────────────────
  {
    id: 'S7', tests: T,
    prepare: every(LIB, "  if (last.mode === 'partial') return full('last-critique-had-another-profile');\n", ''),
    why: 'a critique with another profile is the baseline a scoped one starts from, so passages it never reviewed by the default lens are skipped',
  },
  {
    id: 'C11', tests: T,
    prepare: every(LIB, '  return ledger.findings.filter((f) => isBlocking(f) && f.targeted_by.some((a) => judgedAfter(f, a))).map((f) => f.id);', '  return ledger.findings.filter((f) => isBlocking(f) && f.targeted_by.length > 0).map((f) => f.id);'),
    why: 'a target is recurring right after its refine record, before any critique judged the fix, so a retried refine halts on a false gate',
  },
  {
    id: 'L1', tests: T,
    prepare: every(LIB, '  if (path === null) return true;\n', '  if (path === null) return false;\n'),
    why: 'a location on a path the artifact set does not hold reads as outside, and a MAJOR there is left open',
  },
  {
    id: 'L2', tests: T,
    prepare: every(LIB, '  const hits = [...known].filter((k) => p.endsWith(`/${k}`));', '  const hits = [];'),
    why: 'an absolute spelling of an artifact path cannot be placed, so a finding outside the passages is carried as if in',
  },
  {
    id: 'V1', tests: T,
    prepare: every(LIB, "      const keep = ambiguous || (gen.mode !== 'full' && BLOCKING_SEVERITIES.includes(finding.severity));", '      const keep = ambiguous;'),
    why: 'a scoped critique lowers an open MAJOR target to MINOR and reports convergence',
  },
  {
    id: 'V2', tests: T,
    prepare: every(LIB, "      const keep = ambiguous || (gen.mode !== 'full' && BLOCKING_SEVERITIES.includes(finding.severity));", '      const keep = false;'),
    why: "contradictory judgments of a target take the last one's lower severity",
  },
  {
    id: 'B1', tests: T,
    // The full-id rule and the resolution check each refuse a symbolic
    // name, so both go.
    prepare: (copy, tools) => {
      every(LIB, "  if (typeof base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) return null;", "  if (typeof base !== 'string') return null;")(copy, tools);
      every(LIB, '  return resolved === base ? base : null;', "  return resolved !== '' ? base : null;")(copy, tools);
    },
    why: 'a symbolic baseline (HEAD, a branch) is diffed against a ref that moves with the checkout',
  },
  {
    id: 'F1', tests: T,
    prepare: every(STATE, '    captured = await captureWorkingTree({ cwd: repoRoot });\n  } catch (err) {\n', '    captured = await captureWorkingTree({ cwd: repoRoot });\n  } catch (err) {\n    throw err;\n'),
    why: 'a conflicted merge aborts the critique instead of falling back to an unrecorded one',
  },
  {
    id: 'F2', tests: T,
    prepare: every(STATE, '    if (!checkout.ok && checkout.otherBranch) return unrecorded;\n', ''),
    why: "a checkout on another branch moves this workflow's ledger aside",
  },
  {
    id: 'F3', tests: T,
    prepare: every(STATE, '    if (!checkout.ok) throw new ReviewScopeError(`critique-close: ${checkout.message}`);\n', ''),
    why: 'a close from another branch is refused for the wrong reason, or not at all when the trees match',
  },
  {
    id: 'F4', tests: [RB],
    prepare: every(CRITIQUE, `  || echo '{"recorded": false, "mode": "full", "reason": "critique-scope-failed"}'`, '  || exit $?'),
    why: 'an older state.mjs without critique-scope stops every critique',
  },
  {
    id: 'F5', tests: T,
    prepare: every(STATE, "    return { ledger: false, reason: 'unreadable-ledger' };\n", '    throw err;\n'),
    why: 'an unreadable ledger fails review-status instead of reading as no ledger',
  },
  {
    id: 'S8', tests: [...T, RB],
    prepare: every(STATE, '    return { recorded: true, ...done.attempt, verify: { mode: verify.mode, reason: verify.reason } };', "    return { recorded: true, ...done.attempt, verify: { mode: 'scoped', reason: 'scoped' } };"),
    why: 'Refine-verify is scoped whenever a ledger exists, after code was added or HEAD moved',
  },
  {
    id: 'C12', tests: T,
    prepare: every(LIB, "  const judgedAfter = (f, attempt) => f.history.some((h) => h.verdict === 'unresolved' && h.generation > (after.get(attempt) ?? Infinity));", '  const judgedAfter = (f, attempt) => closedGenerations(ledger).some((g) => g.id > (after.get(attempt) ?? Infinity));'),
    why: 'a partial critique that never judged a target makes it recurring, and the refine halts on the gate',
  },
  {
    id: 'L3', tests: T,
    prepare: every(LIB, '  if (!/^(?:\\/|[A-Za-z]:\\/)/.test(p)) return null;\n', ''),
    why: 'another file whose relative path ends in an artifact path reads as that artifact, and a MAJOR there is left open',
  },
  {
    id: 'F6', tests: T,
    prepare: every(STATE, '  if (early !== null && early !== expected) return onAnotherBranch(repoRoot, early);\n', ''),
    why: "a conflicted checkout on another branch reads as unreadable, not as another branch's, and moves this workflow's ledger aside",
  },
  {
    id: 'F7', tests: [RB],
    prepare: every(CRITIQUE, `  || echo '{"closed": false, "reason": "critique-close-refused"}'`, '  || exit $?'),
    why: 'a refused close stops the critique instead of falling back to an unrecorded full one',
  },
  {
    id: 'R7', tests: T,
    prepare: every(LIB, '    && (p.deleted === true || p.whole === true ? p.start === 0 && p.end === 0 : p.start >= 1 && p.end >= p.start);', '    && true;'),
    why: 'a stored passage with a reversed range is trusted, and a MAJOR in the changed text is left open',
  },
  {
    id: 'U1', tests: T,
    prepare: every(LIB, "  if (unclosedCritique(ledger)) return full('unclosed-critique-since-the-last-close');\n", ''),
    why: 'a critique whose close refused is skipped, and the next one is scoped from the ledger that never saw its findings',
  },
  {
    id: 'U2', tests: T,
    prepare: every(STATE, "  if (unclosedCritique(ledger)) return { ledger: false, reason: 'unclosed-critique' };\n", ''),
    why: "refine works from the ledger's stale carry after a critique whose close refused",
  },
  {
    id: 'U3', tests: T,
    prepare: every(STATE, "    if (unclosedCritique(ledger)) return unrecorded('unclosed-critique');\n", ''),
    why: 'a refine after a refused close records an attempt the next critique could scope from',
  },
  {
    id: 'R8', tests: T,
    prepare: every(LIB, '      || !g.passages.every((p) => isPassage(p) && g.artifact.includes(p.path))) throw bad(', '      || !g.passages.every((p) => isPassage(p))) throw bad('),
    why: 'a stored passage on a path no artifact holds is trusted, and a MAJOR in the changed text is left open',
  },
  {
    id: 'R9', tests: T,
    prepare: every(LIB, '    if (!isObject(g) || g.id !== i + 1 ||', '    if (!isObject(g) || !Number.isInteger(g.id) ||'),
    why: 'a generation id out of order hides an unclosed critique, and the ledger is trusted again',
  },
  {
    id: 'F8', tests: [RB],
    // The prepare block's line (the close block has one too).
    prepare: every(CRITIQUE, 'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"\n# A fresh shell: the workflow is found again here, never carried from an\n# earlier block. A failure (no workflow found', 'REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1\n# A fresh shell: the workflow is found again here, never carried from an\n# earlier block. A failure (no workflow found'),
    why: 'a broken HEAD stops the critique before critique-scope can fall back',
  },
  // ── a critique the ledger never recorded, a lost tree, a replaced ledger ──
  {
    id: 'U4', tests: T,
    prepare: every(STATE, '    if (unrecordedCritique(ledger, entries, 1)) {', '    if (false) {'),
    why: 'a critique the ledger never recorded is skipped, and the next one is scoped from findings that miss its MAJOR',
  },
  {
    id: 'U5', tests: T,
    prepare: every(STATE, "  if (unrecordedCritique(ledger, entries, 0)) return { ledger: false, reason: 'unrecorded-critique' };\n", ''),
    why: "refine works from the ledger's carry, which misses an unrecorded critique's MAJOR",
  },
  {
    id: 'U6', tests: T,
    prepare: every(STATE, "    if (unrecordedCritique(ledger, entries, 0)) return unrecorded('unrecorded-critique');\n", ''),
    why: 'a refine after an unrecorded critique records an attempt the next critique could scope from',
  },
  {
    id: 'U7', tests: T,
    prepare: every(LIB, '  return last !== undefined && entries > last.critique_entries + pending;', '  return last !== undefined && entries > last.critique_entries + pending + 1;'),
    why: 'one unrecorded critique run goes unnoticed',
  },
  {
    id: 'C20', tests: T,
    prepare: every(LIB, "    const unread = ok && gen.mode === 'scoped' && !mustBeSingle", "    const unread = false && gen.mode === 'scoped' && !mustBeSingle"),
    why: 'a scoped critique resolves an untargeted MAJOR in text it never read, and converges',
  },
  {
    id: 'D7', tests: T,
    prepare: every(LIB, "export const DOCUMENT_EXTENSIONS = Object.freeze(['.md', '.markdown']);", "export const DOCUMENT_EXTENSIONS = Object.freeze(['.md', '.markdown', '.txt']);"),
    why: 'a CMakeLists.txt change reads as prose, and its MAJOR can be left open',
  },
  {
    id: 'B4', tests: T,
    prepare: every(LIB, "  const entry = git(top, ['ls-tree', '-z', '--full-tree', treeish, '--', path]);", "  const entry = gitOrNull(top, ['ls-tree', '-z', '--full-tree', treeish, '--', path]) ?? '';"),
    why: 'a pruned tree reads as an absent file, so a scoped critique gets passages it cannot show',
  },
  {
    id: 'R10', tests: T,
    prepare: every(STATE, '    if (ledger.ledger_id !== ledgerId) {', '    if (false) {'),
    why: 'a close from before a ledger reset resolves findings in the ledger that replaced it',
  },
  {
    id: 'C21', tests: T,
    prepare: every(LIB, '      && !references.every((r) => overlapsPassage(r.location, gen.passages, gen.artifact));', '      && !references.every((r) => overlapsPassage(r.location, gen.passages, gen.artifact) || overlapsPassage(finding.location, gen.passages, gen.artifact));'),
    why: "the ledger's old line, shifted by the refine, resolves an untouched finding",
  },
  {
    id: 'S9', tests: T,
    prepare: every(STATE, "        verify = { mode: 'full', reason: `passages-unreadable:", "        void { mode: 'full', reason: `passages-unreadable:"),
    why: 'Refine-verify is scoped on a tree the next critique cannot read',
  },
  // ── a re-reported left-open finding, every critique run, flagged index entries
  {
    id: 'C22', tests: T,
    prepare: every(LIB, '      && references.every((r) => outsidePassages(r.location, r.scope))) {', "      && outsidePassages(finding.location, references.at(-1).scope ?? 'outside')) {"),
    why: "a left-open MAJOR re-reported with no location, or by its last report only, is judged on the ledger's shifted line and converges",
  },
  {
    id: 'C23', tests: T,
    prepare: every(LIB, "gen.mode === 'scoped' && !mustBeSingle && finding.severity !== 'CRITICAL'", "gen.mode === 'scoped' && finding.severity !== 'CRITICAL'"),
    why: 'a left-open MAJOR the refine targeted, judged unresolved outside the passages, stays left open and the critique converges',
  },
  {
    id: 'C24', tests: T,
    prepare: every(LIB, "    else if (references === undefined && targets.has(finding.id)) {\n      finding.disposition = 'open';\n", "    else if (references === undefined && targets.has(finding.id)) {\n"),
    why: 'a left-open MAJOR the refine targeted, which the scoped critique does not judge, stays left open and the critique converges',
  },
  {
    id: 'C25', tests: T,
    prepare: every(LIB, "    else if (references === undefined && targets.has(finding.id)) {", "    else if (references === undefined && targets.has(finding.id) && finding.disposition !== 'resolved') {"),
    why: 'a resolved MAJOR a refine edits again and targets, which the scoped critique does not judge, stays resolved and the critique converges',
  },
  {
    id: 'C26', tests: T,
    prepare: every(LIB, '      && !references.every((r) => overlapsPassage(r.location, gen.passages, gen.artifact));', '      && !overlapsPassage(references.at(-1).location, gen.passages, gen.artifact);'),
    why: 'two resolved reports, one outside the passages, resolve an untargeted MAJOR when the one in a passage comes last',
  },
  {
    id: 'C27', tests: T,
    prepare: every(LIB, '    const accepted = ok && !unread;\n', "    const accepted = ok && !unread;\n    if (unread) {\n      finding.history.push({ generation: id, verdict: 'resolved-outside-passages' });\n      return;\n    }\n"),
    why: 'a resolution not taken skips the severity it reports and the left-open placement rule, and the critique converges',
  },
  {
    id: 'C28', tests: T,
    prepare: every(LIB, "    } else if (unread && finding.disposition !== 'left-open') {", '    } else if (false) {'),
    why: 'a resolved finding a scoped critique reports resolved outside the passages is reopened',
  },
  {
    id: 'S10', tests: T,
    prepare: every(STATE, "      findings: status.findings.filter((f) => f.disposition !== 'resolved' || decision.targets.includes(f.id)),", "      findings: status.findings.filter((f) => f.disposition !== 'resolved'),"),
    why: 'a resolved finding the refine targeted again reaches the reviewer with no entry to judge',
  },
  {
    id: 'S11', tests: T,
    prepare: every(LIB, "from: null, targets: outstandingTargets(ledger) };", 'from: null, targets: [] };'),
    why: "a partial critique drops the refine's targets, and a resolved one targeted again converges unreviewed",
  },
  {
    id: 'C29', tests: T,
    prepare: every(LIB, "verdict: gen.mode === 'partial' ? 'not-judged' : 'unresolved' });", "verdict: 'unresolved' });"),
    why: 'a target a partial lens did not judge counts as judged unresolved, and gates the next refine as recurring',
  },
  {
    id: 'S12', tests: T,
    prepare: every(LIB, "const TARGET_JUDGMENTS = new Set(['resolved', 'unresolved', 'not-reported']);", "const TARGET_JUDGMENTS = new Set(['resolved', 'unresolved', 'not-reported', 'not-judged']);"),
    why: "a partial critique's omission discharges a target, so the next partial critique resolves it on two verdicts",
  },
  {
    id: 'S13', tests: T,
    prepare: every(LIB, "      if (!(f.history ?? []).some((h) => h.generation > after && TARGET_JUDGMENTS.has(h.verdict))) out.push(t);", '      out.push(t);'),
    why: 'a target a critique already resolved is a target of every later partial critique',
  },
  {
    id: 'S14', tests: T,
    prepare: every(LIB, "    if (ledger.generations.some((g) => g.state === 'closed' && g.mode === 'full' && g.id > after)) continue;\n", ''),
    why: 'a resolved target a full critique did not report stays a target, and a later partial critique reopens it with no edit',
  },
  {
    id: 'U8', tests: T,
    prepare: every(STATE, "    const run = verb === 'critique' ?", '    const run = false ?'),
    why: "a lifecycle's critique phase notes no run, so the ledger hands refine a carry that misses its findings",
  },
  {
    id: 'U9', tests: T,
    prepare: every(LIB, '    else if (CRITIQUE_RESUME_RE.test(line) && all[i - 1] !== CRITIQUE_RUN_MARKER) n += 1;\n', ''),
    why: "an older release's critique, which notes the resume heading alone, goes uncounted",
  },
  {
    id: 'U10', tests: T,
    prepare: every(LIB, '    else if (CRITIQUE_RESUME_RE.test(line) && all[i - 1] !== CRITIQUE_RUN_MARKER) n += 1;', '    if (CRITIQUE_RESUME_RE.test(line)) n += 1;'),
    why: "the critique command's own run counts twice, so every critique after a refine is full",
  },
  {
    id: 'R11', tests: T,
    prepare: every(STATE, '  if (captured.flagged.length > 0) {', '  if (false) {'),
    why: 'an edit to an assume-unchanged file is left out of the tree a scoped critique converges on',
  },
  {
    id: 'R12', tests: T,
    prepare: every(SNAPSHOT, '[...new Set([...snap.assumeUnchanged, ...snap.skipWorktree])]', '[...new Set([...snap.assumeUnchanged])]'),
    why: 'an edit to a skip-worktree file is left out of the tree a scoped critique converges on',
  },
];
