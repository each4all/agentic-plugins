// Mutation spec — do the post-sync dispatch tests (docket C58) catch the
// defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/post-sync-dispatch.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The dispatch step runs only inside the release
// job, after a release, on GitHub. Nothing in a pull request's CI executes it,
// and its first live run is the next release. A green suite proves nothing
// about it; deleting each rule and watching a named test fail does.
//
// Groups: S the script's classification, C its CLI, W the release-please.yml
// wiring, L the completeness of the dispatched set.

const T = 'tests/scripts/test-dispatch-post-sync-ci.mjs';
const SCRIPT = 'scripts/dispatch-post-sync-ci.mjs';
const WORKFLOW = '.github/workflows/release-please.yml';

export const TESTS = [T];

export const MUTATIONS = [
  // ---- S: what a run is recorded as validating --------------------------------
  {
    id: 'S1', file: SCRIPT,
    from: 'fields: { ref, return_run_details: true },',
    to: 'fields: { ref },',
    why: 'the dispatch no longer asks for the run id, so the endpoint answers 204 and nothing is recorded',
  },
  {
    id: 'S2', file: SCRIPT,
    from: "if (cmp?.status === 'ahead') {",
    to: 'if (true) {',
    why: 'a run on a behind or diverged head is accepted as validating the sync',
  },
  {
    id: 'S3', file: SCRIPT,
    from: "return { ...result, outcome: 'compare-failed', detail: message(err) };",
    to: "return { ...result, ok: true, outcome: 'advanced', detail: '' };",
    why: 'an ancestry check that could not be made passes',
  },
  {
    id: 'S4', file: SCRIPT,
    from: "return { ...result, outcome: 'dispatch-failed', detail: message(err) };",
    to: 'throw err;',
    why: 'one failed dispatch stops the rest',
  },
  {
    id: 'S5', file: SCRIPT,
    from: 'if (!Number.isInteger(runId)) {',
    to: 'if (false) {',
    why: 'a dispatch answered without a run id is not reported as unrecorded',
  },
  {
    id: 'S6', file: SCRIPT,
    from: "if (result.headSha === expectSha) return { ...result, ok: true, outcome: 'validated' };",
    to: 'void 0;',
    why: 'an exact match is sent through the ancestry check instead of being recorded as the intended sha',
  },
  {
    id: 'S8', file: SCRIPT,
    from: 'for (let attempt = 0; attempt <= runReadDelaysMs.length; attempt += 1) {',
    to: 'for (let attempt = 0; attempt < 1; attempt += 1) {',
    why: 'a run that is not readable at once fails the release job instead of being read again',
  },
  {
    id: 'S9', file: SCRIPT,
    from: 'text = `run ${r.runId} validates ${r.headSha}, ${r.detail}',
    to: 'text = `run ${r.runId} validates ${short(r.headSha)}, ${r.detail}',
    why: 'when main advanced, the commit a run validated is recorded only as an abbreviation',
  },
  {
    id: 'S7', file: SCRIPT,
    from: "{ level: 'info', text: `These runs validate post-sync main, not the release commit, whose own run read the catalogs before the sync.` },",
    to: '',
    why: 'the report stops saying which commit the runs validate',
  },

  // ---- C: the CLI --------------------------------------------------------------
  {
    id: 'C1', file: SCRIPT,
    from: "args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);",
    to: "args.push('-f', `${k}=${v}`);",
    why: 'return_run_details is sent as the string "true", not a boolean',
  },
  {
    id: 'C2', file: SCRIPT,
    from: 'process.exit(summary.ok ? 0 : 1);',
    to: 'process.exit(0);',
    why: 'a failed check leaves the step green',
  },
  {
    id: 'C4', file: SCRIPT,
    from: ": (String(err.stderr ?? '').trim().split('\\n').filter(Boolean).join(' / ') || message(err));",
    to: ': message(err);',
    why: "a refused dispatch reports only gh's command line, not GitHub's reason",
  },
  {
    id: 'C5', file: SCRIPT,
    from: 'maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs,',
    to: 'maxBuffer: 64 * 1024 * 1024,',
    why: 'a gh call that never answers holds the step until the job times out',
  },
  {
    id: 'C6', file: SCRIPT,
    from: '`::${level}::${escapeData(text)}`',
    to: '`::${level}::${text}`',
    why: 'annotation text is not escaped',
  },
  {
    id: 'C3', file: SCRIPT,
    from: "if (!SHA.test(values['expect-sha'] ?? '')) usage(",
    to: 'if (false) usage(',
    why: 'a short or missing sha is dispatched against instead of refused',
  },

  // ---- W: the release job wiring ----------------------------------------------
  {
    id: 'W2', file: WORKFLOW,
    from: '  actions: write\n',
    to: '',
    why: 'the job token cannot create a dispatch',
  },
  {
    id: 'W3', file: WORKFLOW,
    from: 'EXPECT="$(git rev-parse --verify refs/remotes/origin/main)"',
    to: 'EXPECT="$(git rev-parse HEAD)"',
    why: 'the expected sha is read from local HEAD, not from the ref only a successful push moves (equivalent on every path that reaches the step today, since a rejected push skips it; the test pins the source)',
  },
  {
    id: 'W4', file: WORKFLOW,
    from: '            git push\n            echo "pushed=true" >> "$GITHUB_OUTPUT"\n          else\n            echo "No marketplace',
    to: '            echo "pushed=true" >> "$GITHUB_OUTPUT"\n            git push\n          else\n            echo "No marketplace',
    why: 'a rejected catalog push is recorded as pushed',
  },
  {
    id: 'W5', file: WORKFLOW,
    from: " || (github.event_name == 'workflow_dispatch' && steps.catalog-push.outcome == 'success')",
    to: '',
    why: 'the manual repair path cannot re-dispatch when there is nothing new to push',
  },
  {
    id: 'W8', file: WORKFLOW,
    from: '      # Docket C58. The catalog push above uses GITHUB_TOKEN',
    to: '      - name: A step between the push and the dispatch\n        run: true\n\n      # Docket C58. The catalog push above uses GITHUB_TOKEN',
    why: 'a step between the catalog push and the dispatch could fail after the commit landed, and the implicit success() would then cost that commit its run',
  },
  {
    id: 'W6', file: WORKFLOW,
    from: '          GH_TOKEN: ${{ github.token }}\n',
    to: '',
    why: 'gh runs unauthenticated',
  },

  // ---- L: the dispatched set --------------------------------------------------
  {
    id: 'L1', file: SCRIPT,
    from: "  'validate.yml',\n",
    to: '',
    why: 'a workflow a normal push would start is left out of the post-sync runs',
  },
];
