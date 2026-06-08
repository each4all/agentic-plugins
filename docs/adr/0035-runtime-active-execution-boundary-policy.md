# ADR-0035: Runtime active-execution boundary policy

## Status

Accepted (2026-06-08, PR #400)

<!--
Refines (does not supersede) ADR-0024. ADR-0024 established
`plugins/runtime` as the operator control plane that is "read-only by
default" with mutations behind explicit opt-in flags. This ADR
formalizes the boundary those opt-in executors share into one policy and
defines the gate for adding new ones. The Decision section of ADR-0024 is
unchanged; this is an additive policy layer.
-->

## Context

ADR-0024 made `plugins/runtime` the L1 operator control plane and set
`runtime:doctor` "read-only by default," with host or config mutation
permitted only behind explicit, opt-in flags. Since then runtime has
accreted roughly ten such executors, each added by its own follow-up PR:

- `runtime:settings --apply` — writes agentic-plugins' **own**
  `.agentic-plugins/config.toml` model/effort defaults.
- `runtime:settings --execute-plugin-management` — runs allowlisted
  host-native plugin commands: Claude `claude plugin install`/`update`
  and Codex `codex plugin marketplace add`/`upgrade` (catalog-level).
- `runtime:settings --execute-plugin-cleanup` — the one permitted
  uninstall: a doctor-detected **retired** `claude plugin uninstall
  <plugin>@agentic-plugins`.
- `runtime:settings --apply-codex-plugin-hooks` — a narrow
  `~/.codex/config.toml [features].plugin_hooks` write.
- `runtime:settings --attest-codex-hook-review` — records the operator's
  completed `/hooks` review as an artifact; mutates no host state.
- `runtime:doctor --execute-permission-proof` /
  `--execute-deep-peer-smoke` / `--execute-workflow-continuation-proof` —
  companion-contract proof executors bounded to an ephemeral temp repo,
  with sanitized artifacts.
- `runtime:consensus execute --execute` /
  `cancel --confirm-no-active-process` — companion dispatch and
  artifact-only cancellation.

These executors share an **implicit** boundary: explicit flag (never
default), dry-run/plan default, exact allowlist (argv arrays, no shell
interpolation), sanitized artifacts, bounded/no-auto execution, and a set
of things that are never done (host-session mutation, Codex trust-state
mutation, general uninstall, artifact deletion, process killing,
permission relaxation). That boundary is real but lives only in code and
prose scattered across `follow-ups.md`, ADR-0024, and each executor's PR.

Two forces require a decision now:

1. **A new executor is queued.** Follow-up "C" (from ADR-0032/ADR-0034)
   wants to wire Codex `codex plugin add <plugin>@agentic-plugins` as an
   executable cache-materialization behind `--execute-plugin-management`,
   for parity with Claude `claude plugin install`. Codex install is
   currently manual-only (settings emits a non-executable
   `install-plugin-manual` recommendation, ADR-0034 §Scope follow-up).
   Adding a host-mutating executor without a written boundary policy
   would repeat the ad-hoc accretion.
2. **One existing executor is stale.** `--apply-codex-plugin-hooks`
   targets the `plugin_hooks` flag Codex removed (~0.134.0; see ADR-0030
   and the host baselines). ADR-0030 made it stage-aware (it skips the
   write on removed-stage Codex), so it is obsolete rather than actively
   harmful — but it should not be blessed as conformant policy.

The maintainer chose an **ADR-first** path: formalize the boundary, then
implement C (and revalidate the stale executor) under it. This is that
policy ADR. It does not ship C; C is its worked example.

Host-truth for C was gathered for this ADR by running `codex plugin add`
on Codex CLI `0.137.0` in an isolated temporary `HOME`: it writes
`~/.codex/config.toml [plugins."<name>@agentic-plugins"] enabled = true`,
materializes the plugin under
`~/.codex/plugins/cache/agentic-plugins/<name>/<version>`, requires a
configured marketplace snapshot, and is idempotent on repeat.

## Decision

### 1. Boundary statement

`plugins/runtime` is **read-only by default**. Any host- or
repo-mutating behavior MUST be reachable only through an explicit,
action-specific opt-in flag that runs an allowlisted executor satisfying
the invariants in §3 and never crossing the ceiling in §4. Everything not
expressly permitted by a tier (§2) and its governing ADR is forbidden.

### 2. Mutation tiers

Every runtime surface is classified into exactly one tier by **mutation
domain** (not by command):

| Tier | Domain | Existing surfaces |
|---|---|---|
| **R0** | Read-only — writes nothing (no artifact, config, or host state) | `runtime:doctor` (default, no `--record`); `runtime:worktree plan`; `runtime:context` budget check; `runtime:cutover` audit display; `runtime:consensus status`; every dry-run / plan preview. **Any mode of a command that emits a `.agentic-plugins/**` artifact is M1, not R0.** |
| **M1** | agentic-plugins-**owned** writes only — `.agentic-plugins/**` artifacts and runtime/agentic-plugins config — plus bounded companion dispatch; never host config or host installs | `settings --apply` (own config); `settings --attest-codex-hook-review`; `doctor --record`; `compat snapshot` / `check` / `plan` / `ingest-release-notes`; `context capture`; `cutover record`; `consensus plan` / `execute` / `synthesize` / `decide` / `next-round` / `record` / `cancel` (own artifacts/manifests/decisions + companion dispatch); `migrate workflow-storage --apply` (renames/moves **own** legacy state, ADR-0025); `doctor --execute-permission-proof` / `--execute-deep-peer-smoke` / `--execute-workflow-continuation-proof` (ephemeral temp repo) |
| **H2** | Host-native plugin **management** via allowlisted host CLI: install/update/materialize from a configured marketplace; idempotent | `settings --execute-plugin-management` — Claude `claude plugin install`/`update` **and** Codex `codex plugin marketplace add`/`upgrade` (catalog-level); `settings --execute-plugin-cleanup` (the one permitted uninstall — doctor-detected **retired** plugins only); **[deferred] C: Codex per-plugin `codex plugin add`** |
| **H3** | A single, named host-config key write, each justified by its own host-truth ADR | `settings --apply-codex-plugin-hooks` (**obsolete / non-conformant — see §6**) |

**There is no tier above H3 and no open-ended "extend later" tier.** A
new mutation domain (MCP/server config, auth, sandbox/approval, host
session, etc.) is forbidden until a **new** ADR adds a specifically
scoped executor for it. The ceiling (§4) is more load-bearing than the
taxonomy: the taxonomy says where existing executors sit; the ceiling
says what may never be built without a new ADR.

### 3. Per-executor invariants

Every mutating executor (M1/H2/H3) MUST:

1. Default to dry-run/plan; mutate only under its explicit
   action-specific flag.
2. Use an exact allowlist — host, command, argv template, target names,
   and marketplace/path domain are all fixed; no arbitrary input.
3. Build commands as argv arrays only; no shell interpolation,
   `shell: true`, or `sh -c`.
4. Preflight from host-native read probes where available (e.g.,
   `codex plugin list --json`, `claude plugin list`).
5. Bound execution with a finite timeout and no implicit retry loop.
6. Keep main-session output and metadata sanitized — no secrets, no raw
   stdout/stderr, no source-path dumps in the session. Raw peer/child
   output is permitted **only** inside an explicit, pointer-referenced
   artifact (e.g., `runtime:consensus` raw-output files) carrying
   pointer/hash/byte metadata; it is never inlined into the main session.
7. Post-verify with read-only probes when possible (pre/post evidence).
8. Classify failures semantically and surface manual recovery guidance.
9. Mutate no sandbox, approval, auth, trust, or active-session state
   (the §4 ceiling binds each executor individually).
10. Document its atomicity, freshness, and partial-failure recovery —
    single-namespace/idempotent apply, a re-check after apply, exact-target
    freshness evidence for host operations, and progress/confirmation state
    for long-running execution.

Each executor ships tests for: dry-run default, flag gating, allowlist
blocking, old/absent-host behavior, artifact sanitization, and failure
classes.

### 4. Permanent ceiling (testable `MUST NOT`)

Independent of any flag, runtime MUST NOT:

- run an arbitrary/string command executor, `shell: true`, `sh -c`, or
  user-supplied argv;
- mutate auth/login/token/secret/keychain state;
- relax or bypass sandbox, network, approval, or permission policy;
- mutate Codex hook **trust** state (only operator attestation
  *artifacts* are allowed);
- mutate active host session/context — no compaction, resume/fork/archive,
  session switching, or hidden host startup;
- run a general uninstall/remove/prune/delete — only the ADR-approved,
  doctor-detected **retired-plugin** cleanup may exist;
- delete artifacts as part of status/cancel/cleanup (a deliberate,
  ADR-gated owned-state migration such as `migrate workflow-storage` is
  not "cleanup" and is exempt);
- kill or signal an external or pre-existing host process — runtime MAY
  terminate a child **it spawned** to enforce a finite timeout, and
  nothing else;
- rewrite MCP/server config outside a future, explicit, ADR-gated
  executor.

**Enforcement is required as a registry plus tests, not prose — and is
planned, not yet built.** Every executor action MUST appear in an
allowlist registry; an AST/registry-based plugin-shape test (over the
child-process / `fs` / network primitives, not a raw grep) MUST reject
forbidden patterns (e.g., `shell: true`, `sh -c`, bare
uninstall/remove/prune verbs, external-process kill) that appear outside
that registry. Building this registry + guard is the first implementation
slice under this policy; until it exists the boundary is held by reviewer
attention, and the guard may land incrementally.

### 5. Add-gate for a new mutating executor

A PR adding a new executor MUST provide:

1. **Host-truth evidence** — CLI help/docs, observed behavior, exact
   mutation domain, version/stage awareness (probe command shape, do not
   version-gate).
2. **Tier classification** — which tier (§2) and why runtime owns it.
3. **Exact command spec** — argv template, allowed targets, blocked
   targets.
4. **Safety proof** — dry-run, idempotence or no-op behavior, bounded
   execution, failure recovery, and a check that it crosses no §4 line.
5. **Artifact schema** — sanitized result plus pre/post evidence.
6. **Tests** — old/absent-host path, blocked preconditions, execution
   success, semantic failure, redaction, and forbidden-set coverage.
7. **Docs** — runtime `README`/skills plus host-baseline / `follow-ups.md`
   updates.

### 6. C as the worked example, and revalidation of existing executors

**C (deferred):** Codex `codex plugin add <plugin>@agentic-plugins`
classifies as **H2** — the same domain as Claude `claude plugin install`.
Per the host-truth in §Context it is idempotent; removal stays manual or
separately ADR-gated (this ADR does not authorize `codex plugin remove` as
a general executor, so C is not "self-reversing"). Its guardrails: exact
`agentic-plugins` marketplace and known plugin names; a fixed argv template
that **excludes** Codex's `-c`/`--config`, `--enable`, and `--disable`
options; `codex plugin add` observed in `codex plugin --help` (stage-aware
probe, not version-gated); marketplace configured/current; `codex plugin
list --json` pre/post verification; require `installPolicy = AVAILABLE`;
block-or-manual when `authPolicy = ON_INSTALL` or unknown. C MUST NOT mutate Codex trust state
and does not replace `/hooks` review — `add` sets `enabled = true`, which
makes a hook-bearing plugin's hooks *eligible* in a future session, but
trust remains a separate, operator-only step. **This ADR does not
implement C;** it authorizes a follow-up PR to add it through the §5
add-gate.

**Revalidation:** existing executors are not automatically conformant.
The H3 `--apply-codex-plugin-hooks` surface is **obsolete**: Codex removed
the `plugin_hooks` flag (~0.134.0), and ADR-0030 already made the executor
stage-aware so it skips the write on removed-stage Codex and writes only on
legacy stages. It MUST NOT be grandfathered as conformant policy and should
be deprecated/migrated to the `[features].hooks` + plugin-enablement +
`/hooks` trust model (tracked in `plugins/runtime/docs/follow-ups.md`). The
remaining executors match the tier/invariant model and are conformant as
classified.

## Consequences

**Positive**: Runtime gains one explicit, testable boundary for all
mutation. New executors (C and beyond) have a concrete gate instead of
ad-hoc accretion. The ceiling becomes enforceable via a registry + static
test rather than scattered prose. Cross-host plugin-management parity
(Codex install ↔ Claude install) gets a principled home. Trust, auth,
sandbox, and session safety are reaffirmed in one place a reviewer can
cite.

**Negative**: Up-front formalization cost. Existing executors must be
revalidated, and one (`--apply-codex-plugin-hooks`) is found
non-conformant and incurs deprecation/migration work. The registry +
static-test enforcement is new infrastructure to build (it may land
incrementally, but the policy is not fully enforced until it exists).

**Neutral**: No user-facing behavior change — runtime stays read-only by
default and C stays deferred. The tier taxonomy is descriptive of the
structure that already existed implicitly; it adds a vocabulary and a
ceiling, not a new runtime capability.

## Alternatives Considered

- **Descriptive-only policy (no tiers).** Document the shared executor
  invariants and the ceiling, but skip the tier taxonomy. Rejected:
  without tiers the add-gate has no frame for "which domain, and is that
  domain even allowed," and the ceiling is harder to phrase as a closed
  set. The taxonomy is nearly free because the existing executors already
  cluster into R0/M1/H2/H3; the cost of writing it down is small and the
  clarity gain (especially the closed "no tier above H3" rule) is large.

- **Unified executor port (single abstraction).** Route every mutation
  through one executor abstraction with a uniform flag, audit schema, and
  allowlist. Rejected for now: re-platforming ~10 working executors onto
  one port is a sizable refactor that would turn a policy ADR into a
  refactor gate and delay C, i.e., premature abstraction. The registry in
  §4 captures most of the safety benefit (one allowlist, one guard test)
  without the rewrite. A unified port remains a reasonable **future** ADR
  once the tier model has proven stable across a few more executors.

- **Reverse ADR-0024 to a generally-mutating control plane.** Rejected:
  the value of runtime as an L1 primitive is that it is trustworthy and
  read-only by default; a broad mutation posture would make it a liability
  for the plugins that depend on it. The narrow, tiered, opt-in model
  preserves that trust while still allowing the specific parity executors
  (like C) that have host-truth justification.
