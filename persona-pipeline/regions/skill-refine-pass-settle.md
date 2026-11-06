**Each pass settles its own run (C163 A1a).** Every refine-verify a pass
runs, or would have run, is a review attempt of its own, and the workflow
keeps one outcome per attempt (ADR-0023, implementation note of 2026-11-05).
The finalize settles the last pass's attempt only: on Claude
`/{{persona}}:refine`'s Phase 2, inside a `/{{persona}}:start` or
`${{persona}}:start` lifecycle its refine phase, and on Codex this skill's
settle step below. So when the loop goes back to Step 2, settle the pass just
done first, once its synthesis is done, with the block below, whether it
launched a run or not; leave the last pass, launched or not, to the finalize.
Left unsettled, an earlier pass's launched run stays an open attempt that
reads `unknown`, its pending row stays, and settle refuses every later settle
of phase refine that names no run; an earlier pass that launched no run (the
peer not found, the privacy gate, a local-only pass) leaves no attempt at
all. With no active {{persona}} workflow on this branch there is nothing to
settle, and the block says so.

Write the pass's one-line synthesis résumé as `summary.txt` in a new
`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"` directory with your
file-writing tool, not the shell (ADR-0059, amendment of 2026-10-10): that
directory is `TEXT_DIR`, a new one for each pass. Set `HOST` to the host you
run on, `claude` or `codex`, and fill `<plugin-root>` with this plugin's
installed root, the path you read this SKILL.md from, cut before its
`/core/skills/` directory. Then:

- a pass that launched a run: give its dispatch its own directory, as the
  dispatch step says; that directory, holding the runner's
  `prompt.xml.run.json`, is `DISPATCH_DIR`. Set `VERDICT` to the pass's
  synthesis verdict, one word: `resolved`, `concerns`, `regression` or
  `conflict`, or `degraded` when the answer parses to nothing usable or the
  run failed (settle records `failed`, `unavailable` or `malformed` from the
  ledger whatever the verdict). Leave `NO_RUN_REASON` empty.
- a pass that launched no run: `DISPATCH_DIR` and `VERDICT` empty, and
  `NO_RUN_REASON` why: `peer-unavailable` (the companion or the peer's CLI
  was not found before any run), `local-only`, `privacy-gate` (the prompt
  could not be made safe to send) or `owner-skip`. The attempt is recorded
  `unavailable` or `skipped` under an id derived from `TEXT_DIR`, so a rerun
  of the block with the same `TEXT_DIR` records it once.

A value left unfilled, an empty `TEXT_DIR`, another host, another verdict or
reason, a verdict with no run, a reason beside a run, and neither a run nor a
reason each stop the block before any write.

```bash
TEXT_DIR='<the directory holding this pass summary.txt>'
DISPATCH_DIR='<the directory this pass dispatch ran with; empty when the pass launched no run>'
VERDICT='<this pass synthesis verdict; empty when the pass launched no run>'
# Why the pass launched no run (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when it launched one.
NO_RUN_REASON=''
HOST='<claude or codex, the host you run on>'
case "$HOST" in
  claude|codex) ;;
  *) echo "✗ HOST is not claude or codex, the host you run on; nothing was settled." >&2; exit 1 ;;
esac
case "$NO_RUN_REASON" in
  ''|peer-unavailable|local-only|privacy-gate|owner-skip) ;;
  *) echo "✗ NO_RUN_REASON is not peer-unavailable, local-only, privacy-gate or owner-skip (empty when the pass launched a run); nothing was settled." >&2; exit 1 ;;
esac
# A placeholder left as written opens with "<"; a directory mktemp printed
# is an absolute path, which never does, whatever it holds further on.
case "$TEXT_DIR" in
  ''|'<'*) echo "✗ TEXT_DIR is empty or not filled in; nothing was settled." >&2; exit 1 ;;
esac
case "$DISPATCH_DIR" in
  '<'*) echo "✗ DISPATCH_DIR is not filled in (empty when the pass launched no run); nothing was settled." >&2; exit 1 ;;
esac
if [ -n "$DISPATCH_DIR" ]; then
  [ -z "$NO_RUN_REASON" ] || { echo "✗ NO_RUN_REASON is set, but DISPATCH_DIR names a run the pass launched: empty one or the other; nothing was settled." >&2; exit 1; }
  # The pass's verdict, one of the words a refine synthesis uses: another word
  # would record a clean pass failed (unrecognized-verdict).
  case "$VERDICT" in
    resolved|concerns|regression|conflict|degraded) ;;
    *) echo "✗ VERDICT is not resolved, concerns, regression, conflict or degraded, the words a refine synthesis uses; nothing was settled." >&2; exit 1 ;;
  esac
else
  [ -z "$VERDICT" ] || { echo "✗ VERDICT is set, but DISPATCH_DIR is empty (no run launched, so there is no verdict): empty one or set the other; nothing was settled." >&2; exit 1; }
  [ -n "$NO_RUN_REASON" ] || { echo "✗ DISPATCH_DIR and NO_RUN_REASON are both empty: a pass that launched no run names why; nothing was settled." >&2; exit 1; }
fi
# A fresh shell: the workflow is found again here. With none on this branch
# there is nothing to settle.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "No active workflow on this branch: no review attempt to settle." >&2; exit 0; }
if [ -n "$DISPATCH_DIR" ]; then
  # The run's id, from the result the runner wrote beside the prompt, never
  # retyped: a well-formed run id (letters, digits, ".", "_", ":", "-", no "..").
  RUN_ID="$(node -e 'const fs=require("fs"),p=require("path");let r;try{r=JSON.parse(fs.readFileSync(p.join(process.argv[1],"prompt.xml.run.json"),"utf8"))}catch{process.exit(1)}const id=r&&r.run_id;if(typeof id!=="string"||!/^[A-Za-z0-9._:-]+$/.test(id)||id.includes(".."))process.exit(1);process.stdout.write(id)' "$DISPATCH_DIR")" \
    || { echo "✗ prompt.xml.run.json in DISPATCH_DIR ($DISPATCH_DIR) names no run id (a runner killed before it wrote its result leaves it empty): settle that run by hand, peer-runner.mjs settle --repo-root <the repository root> --workflow-path <the active workflow> --phase refine --run-id <the id the dispatch passed as --run-id>. Nothing was settled." >&2; exit 1; }
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?
else
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id '' \
    --ensemble-type refine-verify --no-run-reason "$NO_RUN_REASON" \
    --attempt-key "$TEXT_DIR" || exit $?
fi
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of phase refine is pending (settle that run by its id). Once it
has recorded the attempt, running it again records nothing more. The
finalize is for the last pass only: it settles a run it names again without
harm, but a pass that launched no run, settled here and again by the
finalize from its own text directory, would be recorded twice.
