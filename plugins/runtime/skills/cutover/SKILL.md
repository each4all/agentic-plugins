---
name: cutover
description: "omcc cutover readiness audit and explicit dogfood evidence recorder. Use when the user wants ADR-0012, scorecard, host parity, installed-version, compat, consensus/context, footer, one-week dogfood, and omcc-dev activity evidence summarized without declaring final cutover."
---

# Cutover Audit (runtime framework primitive)

`runtime:cutover` aggregates cutover evidence without mutating host state.
Audit mode is read-only unless the operator explicitly passes runtime doctor
proof execution flags. `record` mode writes only explicit cutover evidence
artifacts under `.agentic-plugins/runs/cutover/`. It can report
`cutover-ready-candidate`, but final omcc archival/removal requires explicit
user declaration per ADR-0007.

The report should make the strengthened candidate gate and separate final gate
visible. `cutover-ready-candidate` means the evidence threshold passed; it is
not final cutover because ADR-0007 still requires an explicit user declaration.
When the result is not ready, preserve the unresolved ADR-0012 condition
numbers, unresolved scorecard row IDs with their requirement/gate summary, and
legacy pattern-map gaps in the user-facing output instead of collapsing them to
a generic `partial` status.
Observed experience-parity follow-ups should also preserve the source host and
host-native commands, so manual Codex `/hooks` review or equivalent operator
work is actionable from the cutover report itself. Preserve the operator
verification checklist in user-facing summaries when it is present; it names the
active manual checks, command, pass condition, fail condition, and post-check
commands for Codex `/hooks`, dogfood records, and final owner declaration.
When the operator asks for final-readiness evidence, pass `--completion-audit`
so the output includes the prompt-to-artifact checklist across requirements,
ADR conditions, runtime commands, evidence artifacts, candidate/final gates, and
weak or missing evidence, plus ADR-0012 transition advice for condition 3/4
promotion blockers.

## When invoked by command (`/runtime:cutover` or `$runtime:cutover`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--max-artifact-age-hours <n>] [--completion-audit] [--permission-proof] [--execute-permission-proof] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--footer-state <state>] [--omcc-dev-active yes|no|unknown]
```

3. Present the report as readiness evidence only.
   - Do not claim final cutover unless the user explicitly declares it.
   - Treat unknown footer state or omcc-dev activity as not verified.
   - Readiness keys on **assurance**, not on exact host-version equality
     (ADR-0053 §Decision 4). Three checks carry it, and their repairs differ:
     - `host_parity_assurance` — is this host pair covered by accepted human
       review? `unassured` is not a defect to fix; it resolves only when a
       release carries a grant naming this pair (§Decision 5).
     - `assurance_runtime_floor` — do **both hosts'** installed runtimes meet
       the ADR-0054 §Decision 5 minimum? A cache-only listing, unknown
       enablement, a disabled package or an unparseable version all block, and
       each host is judged independently.
     - `latest_compat_snapshot` — is the newest recorded compat run intact,
       assured, and describing *this* machine? A malformed historical artifact
       blocks the whole collection, and a run that observed a different host
       pair does not count as evidence about this one.
   - `host_parity_baseline` (exactness) is now reported under `observations`
     and does **not** gate. A stale or drifted baseline beside a covered grant
     is visible and no longer blocking — say so rather than presenting it as a
     blocker.
   - Never present assurance as something the audit can grant. It reports
     membership in a human-authored grant and can neither create nor widen one.
   - Use proof execution flags only when the operator wants current
     peer/workflow evidence; they invoke the same bounded executors as
     `runtime:doctor` and do not relax host permissions or trust hooks.
   - If a matching `runtime:doctor --record` artifact exists, doctor may report
     `recorded_doctor_proof.status=reusable`; cutover can then use that
     version-matched proof evidence without re-running peers.

## When recording daily dogfood evidence

Run only when the operator explicitly wants to record the current cutover
evidence:

```bash
node "<runtime-plugin-root>/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" record --footer-state <state> --omcc-dev-active yes|no|unknown [--dogfood-date YYYY-MM-DD] [--footer-reason "..."] [--omcc-dev-note "..."]
```

This writes a sanitized artifact under `.agentic-plugins/runs/cutover/` and a
`latest.json` pointer. Do not infer `--omcc-dev-active no`; record it only when
the current work really avoided `omcc-dev`.

## Scope

The audit reads:

- `docs/DEVELOPMENT.md` ADR-0012 condition matrix;
- `docs/assurance/omcc-cutover-scorecard.md` requirement statuses;
- `docs/assurance/omcc-legacy-pattern-map.md` D1-D20 disposition statuses;
- observed Claude/Codex runtime experience parity from `runtime:doctor`;
  matching recorded doctor proof artifacts can satisfy the proof-only criteria;
- `plugins/runtime/docs/host-parity-baseline.md`;
- `.release-please-manifest.json` plus runtime doctor plugin install/cache evidence;
- latest runtime compat, consensus, and context artifacts;
- forward-looking one-week omcc-dev-free dogfood evidence from recorded
  cutover artifacts;
- latest recorded or explicit operator-provided footer state/reason and omcc-dev activity evidence.
- optional `--completion-audit` prompt-to-artifact checklist that maps
  requirements, ADR conditions, runtime command surfaces, artifacts, gates, and
  weak/missing evidence, including ADR-0012 transition advice for condition 3/4
  promotion blockers.

The dogfood window starts at the first accepted no-omcc-dev evidence record
after the candidate point. Elapsed dates without records are reported as
`missing`; future dates still needed are reported as `remaining`. Do not ask the
operator to backfill dates before the candidate point.

## Boundaries

- No plugin install/update/uninstall.
- Audit mode: no host config, auth, permission, sandbox, hook trust, git, or
  artifact mutation. Proof execution flags can run bounded peer/workflow
  commands but do not mutate host trust or relax permissions.
- Record mode: writes only explicit cutover evidence artifacts.
- No automatic final cutover declaration.
- No inference that omcc-dev is inactive without explicit evidence.
