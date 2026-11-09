First read the plan; it writes nothing:

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Then write each commit's subject (ADR-0028 §P6, note of 2026-11-04). A subject
reaches the driver as a file, never in the block (ADR-0059, amendment of
2026-10-10): create a private directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`, note the path it prints,
and with your file-writing tool, not the shell, write there one line ending
with one newline per entry of the plan's `commits`: `subject.txt` for a single
commit, `subject-<n>.txt` per commit when `requires_split` is true. Each is
`<type>(<scope>): <summary>`:

- the type one of the commit's `subject_rule.allowed_types` (any
  conventional type when `subject_rule` is null); between `feat` and `fix`,
  the one the change is;
- for a package commit (`package` set), the scope one of
  `subject_rule.scopes`;
- the summary your own one line on what the change does, never the topic or
  `original_request` cut short: the driver refuses that.

On a clean tree (`branch: no-changes`) write none, and leave `TEXT_DIR` empty:
the recovery and the close need no subject. Nothing deletes the files.

Writing the subjects is part of this step, and this text governs it. Where an
older instruction says the step commits with the suggested subject (the
worker's "use the suggested conventional subject", or a commit banner that says
the Autopilot block commits with the suggested subjects), follow this runbook:
the suggestion to follow is the plan's `subject_rule`, and a
`suggested_subject` whose description is the topic cut short is refused.

Then run the step, with `TEXT_DIR` set to that directory. The block passes
`subject.txt` when the directory holds it; for a split, add one
`SUBJECT_ARGS+=` line per commit where the block shows it, after
`SUBJECT_ARGS=()` (a line before it is cleared), `<n>` the 1-based
index into the plan's `commits` and the key that commit's `package` (`docs`
when it is null):

```bash
TEXT_DIR='<the directory the subjects are in>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Recovers an interrupted commit, closes a done workflow with nothing to
# commit, stops at the staging-set owner gate, or commits with the subjects in
# TEXT_DIR and --strict-cc, each subject's type and scope checked against the
# files of the commit it heads. The owner gate is also where it stops when the
# workflow did not begin on a clean tree or the index is pre-staged: only the
# owner can tell pre-existing hunks from the workflow's own. It takes no
# confirm or bypass flag and refuses outside an autopilot run, on a /start
# workflow, and while an owner gate or a peer ensemble is pending.
# The subjects in TEXT_DIR, none on a clean tree (TEXT_DIR empty): one commit's
# subject.txt when it is there.
SUBJECT_ARGS=()
if [ -n "$TEXT_DIR" ] && [ -e "$TEXT_DIR/subject.txt" ]; then
  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")
fi
# A split: one line per commit here, after the two above, each as
#   SUBJECT_ARGS+=(--subject-pkg-file '<package>'="$TEXT_DIR/subject-<n>.txt")
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode autopilot \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}" \
  "${SUBJECT_ARGS[@]}"
```

Report its JSON `action` in the Completion below. A subject that does not fit
its change, or none given where a commit is due, is refused (exit 9) with each
reason, and nothing is committed or written. Write the subject anew to its
file and run the step again: the corrected subject where the refusal gives
one; where it names the topic cut short or an empty description, it gives
none, and you write your own summary after the type and scope it names. A
subject file that cannot be read, or a subject flag that does not match the
plan's commits (a split given `--subject-file`), stops the step with exit 1 or
2 before anything is written: fix the files or the `SUBJECT_ARGS` lines and run
it again. A refusal that
names a landed commit is the owner's to reword, or to split where it touches
several packages: rewrite no history in the step (no amend, rebase or reset),
and report it, with its reason, in the step's report. A refusal with exit 10
(`review-held`) says the workflow's latest review outcome holds the commit
back (failed, degraded, unavailable, malformed or unknown), or the change is
not the one reviewed or cannot be compared with its reviews (ADR-0069), and
nothing was committed or written: the step never accepts it (`state.mjs
review-accept` and `review-binding-accept` are the owner's, and refused under
autopilot) and never reruns the review; report
the attempt and its outcome the refusal names in the step's report, with
`outcome` `needs_owner` and `awaiting_owner` null (the gate is the driver's to
report, and never stored), and stop.
Never push or open a pull request afterwards: waiting
for the landing is the owner's routine step, which the driver reads from
state, and it is not an owner gate.
