---
name: cutover
description: "omcc cutover readiness audit and explicit dogfood evidence recorder. Use when the user wants ADR-0012, scorecard, experience parity, installed-version, consensus/context, footer, one-week dogfood, and omcc-dev activity evidence summarized without declaring final cutover."
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

Pass the subcommand and options above through an args file, never on the
command line (ADR-0059): text spliced into a shell line is cut at `;`,
expanded at `$(…)` and redirected at `>`. Create a directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, write `args.json` in it
with your file-editing tool, holding `{"agentic_args": 1, "text": "…"}` with
`text` set to them as a JSON string, and run:

```bash
ARGS_DIR='<directory mktemp printed>'
trap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo "⚠ could not remove $ARGS_DIR" >&2' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
node "<runtime-plugin-root>/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

`text` is read as shell-style words that expand nothing: quote a value that
holds spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$`
expansion, or a word-initial `#` or `~` — unquoted, each is refused with a
message. The `trap` removes the directory on every exit and keeps the exit
status.

3. Present the report as readiness evidence only.
   - Do not claim final cutover unless the user explicitly declares it.
   - Treat unknown footer state or omcc-dev activity as not verified.
   - ⚠ **The two assurance checks are gone** (ADR-0056 §Decisions 1 and 4).
     `host_parity_assurance` and `assurance_runtime_floor` no longer exist, and
     no check answers "has a human reviewed this host pair". Never present the
     audit as able to grant, withhold, or await such a verdict.
   - ⚠ **No compatibility check remains** (ADR-0060). The compat freshness
     check (`latest_compat_snapshot`) and the baseline exactness observation
     went with `runtime:compat` and the host-parity baseline, and nothing
     replaced them: host-pair identity is **not verified**. The audit says so in
     `limits` and in the `host_pair_identity` observation (status
     `not_verified`, the observed versions as facts). When presenting a
     `cutover-ready-candidate`, say that it binds nothing to the Claude Code /
     Codex CLI versions on this machine. It is not a blocker — no action clears
     it — and it is never a pass.
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
- `docs/assurance/omcc-cutover-scorecard.md` requirement statuses; a
  `withdrawn` row (R9, by ADR-0060) is reported apart from the count only when
  it cites an Accepted ADR under `docs/adr/` whose paragraph names the row with
  a form of "withdraw"; otherwise it stays unresolved, and a requirement id on
  two rows is `duplicate-id`;
- `docs/assurance/omcc-legacy-pattern-map.md` D1-D20 disposition statuses;
- observed Claude/Codex runtime experience parity from `runtime:doctor`;
  matching recorded doctor proof artifacts can satisfy the proof-only criteria;
- `.release-please-manifest.json` plus runtime doctor plugin install/cache evidence;
- latest runtime consensus and context artifacts;
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
