# Autopilot feasibility probes (2026-09-24/25)

This is the host-truth record behind
[ADR-0063](../../../adr/0063-autopilot-fresh-session-driver.md), the
owner-launched fresh-session driver. The probes ran on Claude Code 2.1.281 with
orchestrator 0.13.7, engineer 0.21.10, runtime 0.97.4, attention 0.9.0 and
companions 0.4.1 installed.
- Every probe ran in a throwaway git repository. None touched this checkout or
  the user configuration.
- The record was written in the owner's handoff package and moved here when
  ADR-0063 was proposed (2026-09-29).
- It is a measurement record, not an evidence-store record. The evidence store
  keys records by release loop (ADR-0049) and lives in
  [`../records/`](../records/); these probes belong to no release.

| file | what it is |
|---|---|
| [`PROBES.md`](PROBES.md) | The probe log: headless basics (A), plugin commands under `-p` (B), background tasks (D, D2), the permission posture (P1–P5, W1–W5, R1/R2), structured output (J1, J2), tool names (T), the full chain across fresh processes (E1–E8), and the prototype's end-to-end and halt-path runs (V0, V0b) |
| `scripts/clean-claude.sh` | Runs `claude` with the launching session's identity variables and the egress channel variable removed, like a plain terminal launch |
| `scripts/summarize.mjs` | Summarizes a `stream-json` transcript without dumping it: the init line, each system event (hook responses included), per-message usage, tool results, and the result's turns, cost and permission denials |
| `scripts/e2e-macro.sh` | The V0 end-to-end run, and the planned V1 harness: a scratch repository, a headless `/orchestrator:plan`, approval, the driver, and assertions on the end state. It needs `AUTOPILOT_BIN`, and a run costs roughly $4–6 on sonnet/medium |
| `scripts/halt-tests.sh` | The V0b halt paths N1–N8, against a repository that holds an unapproved macro. It needs `AUTOPILOT_BIN` and `AUTOPILOT_TEST_REPO` |
| `scripts/perm-prompt2.txt` | A prompt from the V1–V4 permission probes: one read-only block with an `export` and a plugin CLI call, run as written and answered ALLOWED or DENIED |

The driver the scripts drive, `prototype/autopilot.mjs`, stayed in the handoff
package. The implementation ports it into
`plugins/orchestrator/adapters/claude/autopilot/`.

## What changed after these runs

Two readings in the log no longer describe the current plugins. The log keeps
them as measured.
- **V0's end state depended on the pre-ADR-0062 completion model.** On
  orchestrator 0.13.7 the committing worker's own Stop recorded the subtask
  `completed`, which unblocked the next subtask.
  - [ADR-0062](../../../adr/0062-subtask-completion-recorded-at-landing.md)
    (orchestrator 0.14.0) records completion only when the pull request has
    merged.
  - Under it, the same run stops after the first commit, and `e2e-macro.sh`
    cannot reach finalize until it plays the owner's landing step (ADR-0063 D3a).
- **The `rm` denials.** V0 saw 7 Bash denials, all from runbook blocks that
  called `rm`.
  - [ADR-0059](../../../adr/0059-runbook-argument-transport.md) has since added
    an args-file cleanup trap that also contains `rm -f`.
  - Whether Claude Code's permission matcher sees an `rm` inside a quoted `trap`
    string was not measured. Codex's exec policy refuses it (review docket C74).

## Re-running

From a scratch git repository, with `D` set to this directory:

```bash
"$D/scripts/clean-claude.sh" -p "Reply with exactly: PONG" --model haiku \
  --output-format stream-json --verbose --include-hook-events \
  --max-budget-usd 0.5 < /dev/null > a.jsonl
node "$D/scripts/summarize.mjs" a.jsonl
```

The runs spend real API budget, and they use the plugins installed at user
scope, not this checkout.
