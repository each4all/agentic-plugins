### Long checks (ADR-0068 Decision 5)

Sort the checks a change needs by the work they are expected to take:

- **Quick:** a few test files the change touches, expected to finish within
  minutes. Run them in the step, as always, and get them green first.
- **Long:** the whole test suite, a broad `npm test` (a directory, a glob,
  many files), any test file known to run long, and every mutation run
  (`npm run mutate`, and `npm run mutate:static` over every spec).

Where a long check runs depends on the session. The rules are in the skill
this command follows, `core/skills/{{skill}}/SKILL.md` § Long checks: what a
verify request names by the step that follows it, the cap on mutation cases,
the repeat rule, and the commands the lock wrapper refuses. In short:

- **Under an autopilot run that offers verification** (Phase 0's preflight
  banner ends `This run offers verification`): run no long check in the
  step, and never wait for the heavy-work lock there. Hand the long checks to
  the driver with the finalize's verify form (`verify-request.json`).
- **Under an autopilot run that does not offer it** (the banner ends `This
  run does not offer verification`): in the step, as before.
- **Interactively:** run a long check under the repository's heavy-work lock,
  `agentic-autopilot heavy -- <command>`; directly when the command takes the
  lock itself (the wrapper refuses it) or no orchestrator is installed.
