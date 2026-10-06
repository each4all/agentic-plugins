- archive gate `blocked` with **only `head_moved` unmet** →
  **`publish-needed`** (the deliverable awaits the owner's save/commit;
  `head_moved` is a fail-closed collapse that also covers a failed git
  probe — the wording never overclaims a single cause);
- archive gate `blocked` with any **other** gate unmet (`terminal_phase`,
  `no_active_children`) → **`blocked`**, with gate-specific unblocking
  actions;
- otherwise → **`next-work-available`**.

The reason names the projection phase (+ the failed gate tokens when
blocked); the recommended next work carries the workflow's `next_action`
verbatim; `publish-needed` and `blocked` completions always pass an
explicit `--completion-next-action` (the contract's §3.2 marker-free
floor: a {{persona}} terminal footer never renders a `[generic fallback]`
marker).

## How to compute + pass the projection (pre-work / manual preflight)

The recipe below is the **contract reference** for a *pre-work* preflight
surface; at completion the same projection is computed and handed to
`footer.mjs` automatically by `emitTerminalHandoffSidecar` via the
`discover-runtime.mjs` resolver (copy-not-import, ADR-0010 §5).

```bash
# 1. Compute the bounded projection from this persona's OWN state.
PERSONA={{name}}
HANDOFF="$(node "$CLAUDE_PLUGIN_ROOT/scripts/session-handoff.mjs" project \
  --repo-root "$REPO_ROOT" --routing "/${PERSONA}:resume")"
STATUS="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{}})')"
# Routing is always present in the result (ADR-0031 input (c)) — pass it
# standalone when there is no projection so the seam never loses it.
ROUTING="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).routing||"")}catch{}})')"

case "$STATUS" in
  ok)
    # 2. Materialize just the projection object to a temp file and pass it to
    #    the runtime seam. runtime composes context-risk × archive_gate into
    #    the continue-vs-fresh decision + next-session prompt/command.
    PROJ_FILE="$(mktemp -t "${PERSONA}-projection.XXXXXX").json"
    echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify(JSON.parse(s).projection))})' > "$PROJ_FILE"
    #   runtime:context check --risk <green|yellow|red> --workflow-projection-file "$PROJ_FILE"
    ;;
  no_active_branch_context)
    # Detached HEAD — report it, do NOT auto-recommend a fresh session
    # (ADR-0018 §sub-2). Surface: "no active branch context".
    ;;
  no_active_workflow|fail_closed)
    # No active workflow of this persona, or a corrupt state. Degrade: NO projection,
    # but routing is still available — pass it standalone so the seam keeps
    # the routing-shaped next command:
    #   runtime:context check --risk <green|yellow|red> --routing-recommendation "$ROUTING"
    ;;
esac
```

## Runtime discovery floor (ADR-0043 §4)

`discover-runtime.mjs` gates on one floor, the **footer floor**
`MIN_RUNTIME_VERSION` (gates on `scripts/footer.mjs`): the first released
runtime containing the ADR-0043 S2 enum expansion. A runtime below it would
reject `workflow_kind: {{persona}}` and render the unsupported-kind degradation
text, so discovery fail-closes instead (silent, no stale-cache fallback).

The second floor, `NOTIFY_MIN_RUNTIME_VERSION` on `scripts/notify.mjs`, served
the peer-runner's ADR-0040 §5 notification, and went with it (ADR-0064).

## Codex hook parity (diagnose + operator attestation only)

The primary emission fires **synchronously at completion** and is fully
host-symmetric: a Codex `${{persona}}:<verb>` completion runs the same
`set-terminal` CLI and renders the same footer. What is not
non-interactively provable on Codex is the *hook-borne* re-surfacing
(Stop backstop + SessionStart re-injection): those ride the packaged
hooks, which require the stage-appropriate hook gate plus a `/hooks`
review/trust — and every hook-bearing {{persona}} upgrade requires a fresh
`/hooks` re-attestation (`runtime:settings --attest-codex-hook-review`;
diagnose with `runtime:doctor`). This is the honest-scope boundary
(ADR-0001 §5): the durable state is host-shared; only the automatic
re-injection depends on the attested Codex hook state.

## Rollback note (ADR-0043 §5)

Rollback order is **personas first, runtime second**: the discovery floor
compares versions, not capabilities, so a runtime release that reverted
the four-persona seam would still satisfy `>= {{footer_floor}}` and {{persona}} sidecars
would keep firing into honest-but-silent rejection. Rolling back the
{{persona}} package alone is safe; it leaves the durable one-shot artifacts
behind — remove
`.agentic-plugins/state/{{persona}}/last-session-handoff.json*` (projection +
rendered-marker tombstone) so a later re-enable cannot surface a
pre-rollback handoff as current.

## Boundaries

- **Workflow-state read-only.** `session-handoff.mjs` only reads {{persona}}
  workflow state and runs the pure evaluator; it never archives, marks
  terminal, or mutates the workflow. Its only writes are {{persona}}'s own
  handoff artifacts — the projection slot, the render snapshot, and the
  footer-rendered marker. The runtime footer it feeds is advisory and
  pointer-only.
- **Fail-closed.** A corrupt {{persona}} state yields no projection; the seam
  degrades to context-risk + routing rather than trusting a partial
  projection.
- **No auto-fresh on detached HEAD.** The branch-based preflight reports
  "no active branch context" and never recommends a fresh session from a
  state with no branch to anchor to. The path-targeted terminal sidecar
  does not consult the branch at all — it renders normally for the exact
  workflow it was handed and stays advisory.
