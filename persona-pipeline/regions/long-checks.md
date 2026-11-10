### Long checks (ADR-0068 Decision 5)

Sort the checks a change needs by the work they are expected to take:

- **Quick:** a few test files the change touches, expected to finish within
  minutes. Run them in the step, as always, and get them green first.
- **Long:** the whole test suite, a broad `npm test` (a directory, a glob,
  many files), any test file known to run long, and every mutation run
  (`npm run mutate`, and `npm run mutate:static` over every spec).

Where a long check runs depends on the session:

- **Under an autopilot run that offers verification** (Phase 0's preflight
  banner ends `This run offers verification`): run no long check in the
  step, and never wait for the heavy-work lock there — a wait on a lock is
  quiet and idle, which the driver judges stalled. Hand the long checks to the driver instead, with the finalize's
  verify form (`verify-request.json`): it runs them with no LLM after the step
  ends, and the step that follows reads their results, which Phase 0 prints.
  Failing tests named there are the evidence to work from; a check that ended
  with no evidence (a timeout, one cut short or never reached) says nothing
  about the code. What a request names depends on the step that follows it
  (ADR-0068 Decision 5, amendment of 2026-11-10):
  - **An intermediate request** (its `on_pass` is a verb, as after composing
    or refining): name only the test files the change touches. Do not name
    the whole suite, a broad `npm test` or a broad mutation set: the driver
    adds the small and medium tests the change selects, and the large ones
    wait for the final run. Name mutation cases only when the change touches
    gate or fail-closed code (a check that refuses, a guard, a bound), and
    then only those cases. A step with no test file to name names the
    cheapest declared check its change triggers.
  - **The final request** (its `on_pass` is `commit` or `done`): name the
    whole suite, the `test-suite` check, when the repository declares it. Its
    pass is the evidence the commit needs, and it holds only for the tree it
    ran on: after any later edit, regeneration, commit or rebase the driver
    asks for it again, and resumes a verb that asks for the commit without it.
  - **One batch runs at most 6 case ids of mutation in all**, the request's
    and the driver's together: a request over that is refused before any
    write.

  Recording the same checks again on an unchanged tree after they passed
  runs nothing: the driver reuses the pass once. A second time, or after one
  failed, it halts the lane `no-progress`: change the code first (the owner
  reruns a flaky check with `--next verify`).
- **Under an autopilot run that does not offer it** (the banner ends `This
  run does not offer verification`): in the step, as before.
- **Interactively:** run a long check under the repository's heavy-work lock,
  so it does not run beside another session's heavy work:
  `agentic-autopilot heavy -- <command>` (or `node <orchestrator plugin
  root>/adapters/claude/autopilot/cli.mjs heavy -- <command>`). A command that
  takes the lock itself, as the mutation harness does (`locks_itself` in
  `.agentic-plugins/verify-checks.json`), runs directly: the wrapper refuses
  it. With no orchestrator installed, run the check directly.
