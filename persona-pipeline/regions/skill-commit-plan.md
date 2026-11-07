```bash
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex>
```

The plan is informational: execute and close re-derive everything.

- **`branch: no-changes`** — `no_changes.path` says what a clean tree means
  here. The same classifier runs in execute and close, so it is what they
  will do:
  - `recovery`: commits carrying this workflow's `Workflow-ID:` trailer
    landed and cover the manifest, but the run that made them stopped before
    its terminal write. Phase 2 finishes it with no subject.
  - `close`: nothing was committed since the workflow began, and the last
    verb recorded `next_step_kind: done`. Confirm with the user
    ("Recommended: close without a commit. Proceed?"), then Phase 3.
  - `blocked`, with `no_changes.reason`:
    - `partial-commit` — marked commits that do not cover the manifest;
    - `unmarked-commits` — HEAD moved with no marked commit;
    - `next-step-not-done` — nothing moved, but the last verb did not say
      the work needs no commit;
    - `no-baseline` — HEAD or the baseline could not be read;
    - `git-probe-failed` / `status-not-clean` — `git status` failed, or
      still reports a change the change list does not (a staged change the
      working tree reverted): a clean tree is proven, not inferred;
    - `start-workflow` — a `/{{persona}}:start` workflow is never closed here.

    Report it and stop; nothing is written. A close never follows a commit
    of this workflow's, and a recovery never follows an empty history.
- **Otherwise** present the staging set and each
  `commits[].suggested_subject` for accept / edit / cancel, as
  `/{{persona}}:start` Phase 7 does:
  - `ask_user: true` → also confirm the staging set: the intersection only
    (default), specific `extras` opted in, or the whole working tree.
  - `requires_split: true` → the change spans release-please packages, so it
    becomes one commit per package (ADR-0016). A split needs one subject per
    commit; a single `--subject-file` is refused.
  - `subject_rule` set (the repository's release-please configuration names
    packages) → the commit's subject takes one of its `allowed_types` and, for
    a package commit, one of its `scopes`; check an edited subject against it
    before execute. Execute warns on one that does not fit, commits it as
    given, and prints the corrected subject: pass the warning and the
    corrected subject to the user (ADR-0028 §P6, note of 2026-11-04).

When the plan's `review_hold` is set, a review outcome holds this commit back:
show the user that line before asking anything. It names the attempt and the
ways on, and execute warns only as it commits, so this is where the user
decides (ADR-0028, note of 2026-11-07).
