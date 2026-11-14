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

const T_RULES = 'tests/scripts/test-runbook-checks.mjs';
const T_GATE = 'tests/plugin-shape/test-runbook-cli-contracts.mjs';
const CHECKS = 'tests/_runbook-checks.mjs';
const WORDS = 'tests/persona-pipeline/_verb-runbooks.mjs';

export const TESTS = [T_RULES, T_GATE];

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
];
