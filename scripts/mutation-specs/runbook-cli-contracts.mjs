// Mutation spec — do the tests catch a runbook CLI contract check that turns
// permissive? (the standard test shape, owner decision 2026-11-09, W7 Task 2)
//
// Run: npm run mutate -- scripts/mutation-specs/runbook-cli-contracts.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The gate over the committed runbooks
// (tests/plugin-shape/test-runbook-cli-contracts.mjs) finds no problem, and a
// check that stopped looking finds none either. Each case below opens one of
// its fail-closed boundaries: a flag no subcommand reads, a subcommand whose
// flags the reading could not follow, the end of a shared case's member at
// its `return`, and the spellings of a call the readers cannot read whole (a
// call left unscanned, words cut short, a literal flag name before or inside an
// expansion, a fence left open, words ending inside an open quote or
// substitution, a code span read as a fence), and an action word left out. The rule tests
// must notice each.
//
// The release of the persona plugins' directories (ADR-0059 Decision 10) has
// boundaries of its own (C14 to C19): a directory made outside the make, a
// release before the block's last exit or a later use, one the path list
// keeps, one of a value the block read, and a release that, failing under
// errexit, ends the block with its own status; and, for the orchestrator's
// files groups (C27 to C31), a replaced EXIT trap, a release site found twice,
// and the orchestrator files leaving the gate's scope. /orchestrator:next's
// trap release (C32 to C35): a guarded release on a list that keeps the
// directory nowhere, and, in commands/next.md itself, a withdrawal that shows
// no owner taken as authorizing, a landed writeback whose cleanup failed
// exiting 0, and Phase 3b publishing over a kept mark it did not withdraw.

const T_RULES = 'tests/scripts/test-runbook-checks.mjs';
const T_GATE = 'tests/plugin-shape/test-runbook-cli-contracts.mjs';
const CHECKS = 'tests/_runbook-checks.mjs';
const WORDS = 'tests/persona-pipeline/_verb-runbooks.mjs';
const T_SNIPPETS = 'tests/persona-pipeline/test-tmpdir-snippets.mjs';
const RELEASE = 'persona-pipeline/snippets/tmpdir-release.sh';
const REFUSES = /the path list check refuses what it is for/;
const T_NEXT = 'tests/orchestrator/test-next-text-dir-release.mjs';
const NEXT_MD = 'plugins/orchestrator/commands/next.md';

export const TESTS = [T_RULES, T_GATE, T_SNIPPETS, T_NEXT];

export const MUTATIONS = [
  {
    id: 'C1', file: CHECKS, tests: [T_RULES],
    from: "    if (!presence && !spec.accepted.has(base) && !contract.global.has(base)) problems.push(`${where} ${sub}: --${name} is not read by ${sub}`);\n",
    to: '',
    why: 'a state.mjs flag the subcommand never reads passes again, the defect the check exists for',
    killed_by: [/cliCallProblems holds a state\.mjs call to its subcommand/, /catches a flag misspelled in a copy of it/],
  },
  {
    id: 'C2', file: CHECKS, tests: [T_RULES],
    from: "  if (spec.unsupported?.length > 0) return { sub, status: 'unsupported', problems: [], partial: [...spec.unsupported] };\n",
    to: '',
    why: 'a subcommand whose flags reach code the reading cannot follow is checked against the flags it did read, so its call passes or fails on a partial contract instead of being listed',
    killed_by: /cliCallProblems names what it cannot check instead of passing it/,
  },
  {
    id: 'C3', file: CHECKS, tests: [T_RULES],
    from: '      if (last !== undefined && /^return\\b/.test(last.trim())) break;\n',
    to: '',
    why: 'a shared case member whose block ends in a return is read on past it, so it accepts the flags of the members after it',
    killed_by: [/stateCliContract reads each subcommand/, /conditionFor and caseLinesFor evaluate/],
  },
  {
    id: 'C4', file: CHECKS, tests: [T_RULES],
    from: '      if (!scanned.has(m.index)) out.push({ label, line: lineAt(m.index), text: m[0] });\n',
    to: '',
    why: 'a call of a checked script in a spelling the scanner does not read (a second call on a line, one split across lines) drops out of the check unseen again',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C5', file: CHECKS, tests: [T_RULES],
    from: "  if (call.cut !== undefined) return { sub, status: 'unsupported', problems: [], partial: [call.cut] };\n",
    to: '',
    why: 'a call whose words a process substitution cut short is checked on its first words, so the flags after the cut pass unread',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C6', file: CHECKS, tests: [T_RULES],
    from: "    const hasValue = next !== undefined && (kind === 'peer-runner' ? flagsExpand[i + 1] || !next.startsWith('--') : !next.startsWith('--'));\n",
    to: "    const hasValue = next !== undefined && (flagsExpand[i + 1] || !next.startsWith('--'));\n",
    why: 'an expanding word that opens with a literal --flag is taken as the value of the state.mjs flag before it, so its own name goes unchecked',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C7', file: CHECKS, tests: [T_RULES],
    from: "  const literal = call.words.map((w) => w.replace(/^<unquoted>/, ''));\n",
    to: '  const literal = call.words;\n',
    why: 'an unquoted --name=$VALUE is counted an open argument, not a flag, so a name no subcommand reads passes as run-time arguments',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C8', file: CHECKS, tests: [T_RULES],
    from: '        if (delimiter !== undefined) heredocs.push(delimiter);\n',
    to: '',
    why: "a heredoc's body is read as shell code, so a quote in it flips the quote state and a later call's redirection blanking erases its flags",
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C9', file: CHECKS, tests: [T_RULES],
    from: "      if (!open) problems.push(`${where} ${sub}: no action (one of ${values}), as a word after ${sub} or --${contract.action.flag}`);\n",
    to: '',
    why: 'an admission call with no action word, and no --admission-action, passes, though its case then runs with no action and refuses',
    killed_by: /cliCallProblems holds a state\.mjs call to its subcommand/,
  },
  {
    id: 'C10', file: CHECKS, tests: [T_RULES],
    from: "  if (unclosed !== null) out.push({ label, line: unclosed.start - 1, text: `a ${unclosed.marker} fence that is never closed` });\n",
    to: '',
    why: 'a shell fence left open drops its block from both readers unseen, so every call in it escapes the gate',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C11', file: CHECKS, tests: [T_RULES],
    from: '      if (stop.open) call.cut = `the words end inside an unterminated ${stop.open}`;\n',
    to: '',
    why: 'a call whose words end inside an unterminated quote or $( (a quoting typo) is checked on what the split swallowed, so the flags inside the open quote pass unread',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C12', file: CHECKS, tests: [T_RULES],
    from: "      if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) open = {",
    to: '      if (fence) open = {',
    why: 'a code span at the start of a line (```bash```) opens a fence, which then never closes and hides the shell blocks after it',
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C13', file: WORDS, tests: [T_RULES],
    from: "    if (kind === '$(' && c === '(') paren++;\n",
    to: '',
    why: "a plain ( … ) inside a $( closes the substitution at its own ), so a $( left unterminated after it is read as closed and the call is checked, not cut",
    killed_by: /the call readers fail closed on the spellings they cannot read whole/,
  },
  {
    id: 'C14', file: CHECKS, tests: [T_GATE],
    from: "const legacyLine = (l) => LEGACY_MAKE_RE.test(l) && !/agentic-args\\./.test(l);",
    to: 'const legacyLine = () => false;',
    why: 'a text or operation directory made with mktemp -d again, in a block or as prose, is no longer seen, so nothing releases it',
    killed_by: REFUSES,
  },
  {
    id: 'C15', file: CHECKS, tests: [T_GATE],
    from: "      if (f.start <= lastExit) problems.push(",
    to: "      if (false) problems.push(",
    why: 'a release before the block\'s last exit passes, so a path that stops after it reruns over a released directory',
    killed_by: REFUSES,
  },
  {
    id: 'C16', file: CHECKS, tests: [T_GATE],
    from: "        if (later >= 0) problems.push(",
    to: "        if (false) problems.push(",
    why: 'a block that reads a directory after releasing it passes',
    killed_by: REFUSES,
  },
  {
    id: 'C17', file: CHECKS, tests: [T_GATE],
    from: "  for (const k of actual) if (!declared.has(k)) problems.push(",
    to: "  for (const k of actual) if (false) problems.push(",
    why: 'a release on a path the path list keeps (one a rerun or a continuation reads) passes: the list is held one way only',
    killed_by: REFUSES,
  },
  {
    id: 'C18', file: CHECKS, tests: [T_GATE],
    from: "      if (!head.has(x) && !madeAt.has(x)) problems.push(",
    to: "      if (false) problems.push(",
    why: 'a release of a value the block read (another command\'s directory, a path from a file) passes',
    killed_by: REFUSES,
  },
  {
    id: 'C20', file: CHECKS, tests: [T_GATE],
    from: "      else if (s === 'else' && stack.length > 0) stack.push(`else of ${stack.pop()}`);\n",
    to: '',
    why: 'a release moved into the else of its declared guard reads as the guard itself, so a dispatched bootstrap could release the orchestrator\'s TEXT_DIR',
    killed_by: REFUSES,
  },
  {
    id: 'C21', file: CHECKS, tests: [T_GATE],
    from: "      if (blind[f.start]) problems.push(",
    to: "      if (false) problems.push(",
    why: 'a release inside a case arm or a brace group, whose branch the path list cannot declare, passes',
    killed_by: REFUSES,
  },
  {
    id: 'C22', file: CHECKS, tests: [T_GATE],
    from: "            if (m && m[1] !== 'RELEASE_PATH' && !names.includes(m[1]) && from.test(m[2])) names.push(m[1]);\n",
    to: '',
    why: 'a variable assigned from a released directory (a file path under it) is read after the release and passes',
    killed_by: REFUSES,
  },
  // The critique of 2026-11-27 (F4-F6, F8).
  {
    id: 'C23', file: CHECKS, tests: [T_GATE],
    from: "      at = openIfs[f.start].includes('if [ \"$OWN_RC\" -ne 0 ]; then') ? 'exit-failed' : 'exit';\n",
    to: "      at = lines.slice(fn.start + 1, f.start).some((l) => l.trim() === 'if [ \"$OWN_RC\" -ne 0 ]; then') ? 'exit-failed' : 'exit';\n",
    why: 'a failing-exit guard closed before the release still reads as guarding it, so a release on every exit removes the OP_DIR the finalize reads',
    killed_by: REFUSES,
  },
  {
    id: 'C24', file: CHECKS, tests: [T_GATE],
    from: "    if (!covered.has(i) && !/^\\s*#/.test(l) && TMPDIR_CALL_RE.test(l)) problems.push(",
    to: "    if (false) problems.push(",
    why: 'a raw tmpdir-release or tmpdir-make, or a snippet copy that drifted, is no release the path list sees, and passes on a kept path',
    killed_by: REFUSES,
  },
  {
    id: 'C25', file: CHECKS, tests: [T_GATE],
    from: "      if (own === undefined && !made) problems.push(",
    to: "      if (false) problems.push(",
    why: 'a later block reading the released directory with no line of its own, a reader the list does not name, passes',
    killed_by: REFUSES,
  },
  {
    id: 'C26', file: CHECKS, tests: [T_GATE],
    from: "  return lines.flatMap((l, i) => (!covered.has(i) && /\\btmpdir-release\\b/.test(l) ? [i + 1] : []));\n",
    to: '  return [];\n',
    why: 'prose telling the agent to release a directory by hand, which ADR-0059 Decision 10, item 2 rules out, passes',
    killed_by: REFUSES,
  },
  // The orchestrator slice (2026-11-27): the files groups, checked whole, and
  // the orchestrator files' legacy makes are in scope; an EXIT trap replaced
  // after the releasing one, and a release site found twice, are refused.
  {
    id: 'C27', file: CHECKS, tests: [T_GATE],
    from: "        if (replaced !== undefined) problems.push(",
    to: "        if (false) problems.push(",
    why: 'a later EXIT trap replaces the one a release runs from, so the directory is never released, and passes',
    killed_by: REFUSES,
  },
  {
    id: 'C28', file: CHECKS, tests: [T_GATE],
    from: "        if (actual.has(key)) problems.push(",
    to: "        if (false) problems.push(",
    why: 'a release site found twice collapses into the one the list declares, so a second release passes unseen',
    killed_by: REFUSES,
  },
  {
    id: 'C29', file: T_GATE, tests: [T_GATE],
    from: "const fileProblems = (group, file, text) => [\n  ...tmpdirProblems(text, group, { snippets: SNIPPETS, label: file }),\n  ...tmpdirOrderProblems(text, group, { label: file, strict: true }),\n];",
    to: "const fileProblems = (group, file, text) => [];",
    why: "the orchestrator commands and skills are read and held to nothing: a release before the write, or a reader after it, passes",
    killed_by: /the files-group check finds a defect planted in a real orchestrator runbook/,
  },
  {
    id: 'C31', file: CHECKS, tests: [T_GATE],
    from: "      else if (own !== undefined && own === placeholder && (strict || !FRESH_PLACEHOLDER_RE.test(own))) problems.push(",
    to: "      else if (own !== undefined && own === placeholder && !FRESH_PLACEHOLDER_RE.test(own)) problems.push(",
    why: "an orchestrator block after the release that takes the same step-1 directory reads it as fresh, and passes",
    killed_by: /the files-group check finds a defect planted in a real orchestrator runbook/,
  },
  {
    id: 'C30', file: T_GATE, tests: [T_GATE],
    from: "  for (const file of files) {\n    const lines = text(file).split('\\n');",
    to: "  for (const file of []) {\n    const lines = text(file).split('\\n');",
    why: 'an orchestrator file that makes a directory the old way passes, the rollout remainder unlisted',
    killed_by: /the orchestrator scan finds a make planted outside the snippet/,
  },
  {
    id: 'C36', file: CHECKS, tests: [T_GATE],
    from: "      for (const i of unread.filter((u) => u < f.start)) problems.push(",
    to: "      for (const i of [].filter((u) => u < f.start)) problems.push(",
    why: 'a write whose `|| exit` was removed before a release passes: the write fails, the directory is released and the block ends 0',
    killed_by: /a release after a write whose failure nothing reads is refused/,
  },
  {
    id: 'C37', file: CHECKS, tests: [T_GATE],
    from: "    return /^\\s*(?:then|do)\\b/.test(rest) || /^\\s*(?:[A-Z_][A-Z0-9_]*=\\$\\?|case \"?\\$\\?\"? in|(?:if )?\\[ \"?\\$\\?)/.test(rest);",
    to: "    return true;",
    why: 'any command after a write reads as reading its status, so a bare write, a piped one or one whose || is only a comment passes before a release',
    killed_by: /a release after a write whose failure nothing reads is refused/,
  },
  {
    id: 'C32', file: CHECKS, tests: [T_GATE],
    from: "        if (rel.at === 'exit' && rel.guards.length > 0 && !(keeps && releasesOn)) problems.push(",
    to: "        if (false) problems.push(",
    why: "a trap release under a guard passes on a list that keeps the directory on no path, the exits the guard turns away undeclared",
    killed_by: /a list that keeps it nowhere is refused/,
  },
  {
    id: 'C33', file: NEXT_MD, tests: [T_NEXT],
    from: "    withdrawn|gone|unpublished|carried) MARK_OK=true ;;\n",
    to: "    withdrawn|gone|unpublished|carried|unknown|unreadable|'') MARK_OK=true ;;\n",
    why: "Phase 5 releases the text directory beside a mark whose withdrawal showed no owner, the only record of its id lost while its child may hold it",
    killed_by: /a writeback that landed beside a withdrawal that/,
  },
  {
    id: 'C34', file: NEXT_MD, tests: [T_NEXT],
    from: '  if [ "$BLOCK_RC" -eq 0 ]; then BLOCK_RC=1; fi\n',
    to: '',
    why: 'a writeback that landed with a cleanup that failed exits 0, so the leftover reads as a dispatch done',
    killed_by: /a writeback that landed beside a withdrawal that|an admission release that fails after a landed writeback/,
  },
  {
    id: 'C35', file: NEXT_MD, tests: [T_NEXT],
    from: 'if [ -f "$TEXT_DIR/dispatch-mark.json" ]; then\n  withdraw_mark\n  case "$MARK_DISPOSITION" in\n',
    to: 'if false; then\n  withdraw_mark\n  case "$MARK_DISPOSITION" in\n',
    why: "Phase 3b's rerun publishes over a kept mark it never withdrew, replacing the only record of the old operation's id",
    killed_by: /publishes over a kept mark only after a withdrawal that showed who holds it/,
  },
  {
    id: 'C19', file: RELEASE, tests: [T_SNIPPETS],
    from: '--path "$RELEASE_PATH")" || :\n',
    to: '--path "$RELEASE_PATH")"\n',
    why: 'a release that fails under errexit ends the block with its own status, so a block whose work succeeded reports a failure',
    killed_by: /under errexit the make still falls back and the release still reports/,
  },
];
