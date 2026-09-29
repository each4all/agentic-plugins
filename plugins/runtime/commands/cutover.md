---
description: omcc cutover readiness audit and explicit dogfood evidence recorder
argument-hint: "[record] [--format text|json] [--max-artifact-age-hours <n>] [--completion-audit] [--permission-proof] [--execute-permission-proof] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--footer-state <state>] [--omcc-dev-active yes|no|unknown] [--dogfood-date YYYY-MM-DD]"
---

# Runtime - Cutover

$ARGUMENTS

Build a cutover readiness report or record explicit dogfood evidence. Audit mode
is read-only. `record` mode writes only a cutover evidence artifact under
`.agentic-plugins/runs/cutover/`. This command does not declare final cutover.
It can only report `cutover-ready-candidate`; ADR-0007 still requires an
explicit user declaration before omcc is archived or removed.

The text report starts with the strengthened candidate gate and the separate
final gate. The candidate gate is the evidence threshold for
`cutover-ready-candidate`; the final gate is the explicit user declaration
required by ADR-0007 before omcc is archived or removed. When the audit is not
ready, the report prints the unresolved ADR-0012 condition numbers, unresolved
scorecard row IDs with their requirement/gate summary, and legacy pattern-map
gaps so the next work item is visible without opening the source documents
first. Observed experience-parity follow-ups retain their source host and
host-native commands, so Codex `/hooks` or equivalent manual review work is
visible directly in the cutover report. The report also includes an operator
verification checklist with the active manual checks, their command, pass
condition, fail condition, and follow-up command sequence. This keeps Codex
`/hooks`, daily dogfood records, and the final owner declaration separate from
machine-verified gates.
Pass `--completion-audit` when preparing a final or near-final cutover review;
it adds a prompt-to-artifact checklist mapping requirement rows, ADR condition
rows, runtime commands, evidence artifacts, candidate/final gates, and any
weak or missing evidence. It also includes ADR-0012 transition advice that
spells out which condition rows can remain satisfied and which evidence blocks
condition 3/4 promotion.

Audit mode is read-only unless the operator passes runtime doctor proof
execution flags. `--permission-proof`, `--deep-peer-smoke`, and
`--workflow-continuation-proof` only collect requested proof sections; the
matching `--execute-*` flags explicitly invoke the same bounded peer/workflow
executors used by `runtime:doctor`. If a prior `runtime:doctor --record`
artifact exists and its runtime, host CLI, and plugin source/cache versions
still match the current report, audit can reuse that recorded proof for the
experience-parity proof criteria without re-running peers.

The arguments above reach the command through an args file, never through
the shell (ADR-0059): typed text spliced into a command line is cut at `;`,
expanded at `$(…)` and redirected at `>`, and the damage can exit zero.
Before the block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The command reads
the text as shell-style words and expands nothing: quote a value that holds
spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$` expansion,
or a word-initial `#` or `~` to pass it as text — unquoted, each is refused
with a message rather than reinterpreted. The block's `trap` removes the
directory on every exit and keeps the command's exit status.

```bash
ARGS_DIR='<directory from step 1>'
trap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo "⚠ could not remove $ARGS_DIR" >&2' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

Checks:

- ADR-0012 condition statuses in `docs/DEVELOPMENT.md`;
- omcc replacement scorecard rows in `docs/assurance/omcc-cutover-scorecard.md`;
  a row marked `withdrawn` (R9, by ADR-0060) is reported apart from the count
  and named beside it, but only when it cites an ADR that exists under
  `docs/adr/`, is Accepted, and has a paragraph naming the row with a form of
  "withdraw"; otherwise it stays unresolved (`withdrawn-uncited` or
  `withdrawn-unverified`), and a requirement id on two rows is `duplicate-id`;
- legacy omcc-dev pattern-map rows in `docs/assurance/omcc-legacy-pattern-map.md`;
- observed Claude/Codex runtime experience parity from `runtime:doctor`;
  recorded doctor proof is accepted only when version-matched and reported as
  reusable by doctor;
- installed/cache plugin versions against `.release-please-manifest.json`;
- latest consensus and context artifacts;
- forward-looking one-week omcc-dev-free dogfood evidence from recorded
  cutover artifacts;
- latest recorded or explicit footer state and reason evidence;
- latest recorded or explicit omcc-dev daily-workflow evidence.

It does **not** check host-pair identity. ADR-0060 removed the compat freshness
check, and with it every binding between a readiness verdict and the Claude
Code / Codex CLI versions on the machine. The audit states that in its
`limits` and in a non-gating `host_pair_identity` observation (the observed
versions as facts, status `not_verified`) — an absent check is reported as
absent, never as passed, and never as a blocker nobody can clear.

With `--completion-audit`, the report also includes:

- each R1-R11/R7a/R7b scorecard row with its source document and evidence cell;
- each ADR-0012 condition row with source document and status;
- command/artifact checklist entries for `runtime:doctor`, `runtime:settings`,
  consensus/context artifacts, cutover records, footer state, omcc-dev
  activity, and the manual final owner declaration;
- ADR-0012 transition advice for condition 3/4 promotion blockers;
- a deduplicated `missing or weak` list for unresolved requirements, conditions,
  artifacts, or gates;
- an `unverified_scope` list — what the audit does not check at all, kept apart
  from `missing or weak` because no operator action clears it (today:
  `host_pair_identity`).

The operator verification checklist is emitted in normal audit output as well
as JSON. It is intentionally advisory: it does not enable hooks, mutate trust
state, record dogfood, or declare final cutover.

The dogfood window starts at the first accepted no-omcc-dev evidence record
after the candidate point. Elapsed dates without records are reported as
`missing`; future dates still needed are reported as `remaining`. The audit
does not ask operators to backfill dates before the candidate point.

Recording example:

```bash
node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" \
  --repo-root "$REPO_ROOT" \
  record \
  --footer-state next-work-available \
  --footer-reason "release/install loop complete; R4 remains open" \
  --omcc-dev-active no \
  --omcc-dev-note "runtime/git/GitHub workflow used without omcc-dev"
```

Current proof audit example:

```bash
node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" \
  --repo-root "$REPO_ROOT" \
  --permission-proof \
  --execute-permission-proof \
  --deep-peer-smoke \
  --execute-deep-peer-smoke \
  --deep-peer-smoke-timeout-ms 60000 \
  --workflow-continuation-proof \
  --execute-workflow-continuation-proof \
  --workflow-continuation-proof-timeout-ms 60000
```

Reusable proof example:

```bash
node "$RUNTIME_ROOT/scripts/doctor.mjs" \
  --repo-root "$REPO_ROOT" \
  --permission-proof --execute-permission-proof \
  --deep-peer-smoke --execute-deep-peer-smoke \
  --workflow-continuation-proof --execute-workflow-continuation-proof \
  --record

node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT"
```

Limits:

- Audit mode performs no host config, auth, plugin, git, or artifact mutation.
  Proof execution flags can invoke bounded peer/workflow commands, but they do
  not relax host permissions or trust hooks.
- Record mode writes only explicit cutover evidence artifacts under
  `.agentic-plugins/runs/cutover/`.
- Unknown omcc-dev usage or missing footer evidence blocks readiness.
- This report is evidence aggregation, not the final cutover decision.
