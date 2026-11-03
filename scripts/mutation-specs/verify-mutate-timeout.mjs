// Mutation spec — do the tests catch a mutate check that loses its harness
// timeout, or one sized past its own bound? (C170; ADR-0068 Decision 5,
// items 3 and 9)
//
// Run: npm run mutate -- scripts/mutation-specs/verify-mutate-timeout.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The driver runs the declared mutate argv with
// no model in the loop. Without a `--timeout` in it the harness falls back to
// its 900 s default, and a spec whose control runs longer ends TIMEOUT, no
// verdict, on every driver run: a green suite said nothing about that, since
// no test resolved the repository's own mutate check down to the harness's
// options. Each case below breaks the transport, the value or the sizing
// rule AGENTS.md states, and names the test that must notice.

const T_TIMEOUT = 'tests/orchestrator/test-autopilot-verify-mutate-timeout.mjs';
const T_DECL = 'tests/persona-pipeline/test-verify-declaration.mjs';

const DECLARATION = '.agentic-plugins/verify-checks.json';
const ARGV = '"argv": ["npm", "run", "mutate", "--", "{spec}", "--only", "{ids}", "--timeout", "1800"],';

export const TESTS = [T_TIMEOUT, T_DECL];

const TRANSPORT = /both parsers resolve one argv, and the harness reads the declared timeout from it/;
const SIZING = /the control and the cases AGENTS\.md allows, with its margin, fit the check and the batch/;

export const MUTATIONS = [
  {
    id: 'T1', file: DECLARATION, tests: [T_TIMEOUT, T_DECL],
    from: ARGV,
    to: '"argv": ["npm", "run", "mutate", "--", "{spec}", "--only", "{ids}"],',
    why: 'the mutate check passes no --timeout, so every driver run of it falls back to the harness default of 900 s (C170 as found)',
    killed_by: [TRANSPORT, /every kind, by words and by comma joins/],
  },
  {
    id: 'T2', file: DECLARATION, tests: [T_TIMEOUT],
    from: ARGV,
    to: '"argv": ["npm", "run", "mutate", "--", "{spec}", "--only", "{ids}", "--timeout", "900"],',
    why: 'the declared timeout is the default it was meant to raise: a control past 900 s still ends TIMEOUT',
    killed_by: TRANSPORT,
  },
  {
    id: 'T3', file: DECLARATION, tests: [T_TIMEOUT],
    from: ARGV,
    to: '"argv": ["npm", "run", "mutate", "--timeout", "1800", "--", "{spec}", "--only", "{ids}"],',
    why: 'the timeout stands before npm\'s --, so npm takes it as its own option and the harness never sees it',
    killed_by: TRANSPORT,
  },
  {
    id: 'T4', file: DECLARATION, tests: [T_TIMEOUT],
    from: '"timeout_s": 14400,',
    to: '"timeout_s": 12600,',
    why: 'the check\'s bound shrinks under the control and six cases at 1800 s each, with the margin: the last cases are never reached',
    killed_by: SIZING,
  },
  {
    id: 'T5', file: 'AGENTS.md', tests: [T_TIMEOUT],
    from: '**one `mutate` check names at most 6 case ids**',
    to: '**one `mutate` check names at most 7 case ids**',
    why: 'the worker rule allows more cases than the check\'s bound holds at the per-run timeout',
    killed_by: SIZING,
  },
];
