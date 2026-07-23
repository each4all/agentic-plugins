# Machine Bootstrap Contract — `runtime:bootstrap`

Normative schema and behavior contract for `runtime:bootstrap`: the
machine-scoped, artifact-only lifecycle that takes a machine from a bare host to
a proven agentic-plugins install.

Decided 2026-07-14 (macro `macro-plan-20260712T022752Z-d542f5` subtask S7; engineer
workflow `decide-20260714T034907Z-cef39f`; Codex Brainstorm ensemble
`brainstorm-20260714T035236Z-2cacb3b`, verdict `agreed`). Two adversarial Codex
Plan-verify rounds shaped it: `plan-verify-20260714T042733Z-003a53` rejected the first
draft with seven blockers, and `plan-verify-20260714T051500Z-0b7c21` rejected the
second — catching, among other things, that the currentness rule the second draft
chose is **not implementable on either host**. Every seam either round named as
under-decided is decided below; §13 lists what deliberately remains as specification
work.

Durable **policy** lives in
[ADR-0046](../../../docs/adr/0046-machine-bootstrap.md). This document owns
everything that **moves**: command grammar, schemas, taxonomies, seams, bundle
membership, and the completion reducer. Splitting them follows
[`settings-report-contract.md`](settings-report-contract.md) §1 — field-level
schema inside an immutable record manufactures freshness debt.

This document **ships inside the runtime plugin package**. That is load-bearing:
a runtime command invoked from an arbitrary consumer repository can read
`PLUGIN_ROOT/docs/…` (precedent: `scripts/compat.mjs` reading
`docs/host-parity-baseline.md`) but cannot read `repoRoot/docs/…` (anti-pattern:
`scripts/cutover-audit.mjs`). The ADR is for humans in the source tree; this
contract is for the tool on the operator's machine.

Line references to other files are anchors observed at decision time and may
drift; **the contract text governs**.

---

## 1. Scope and boundaries

`runtime:bootstrap` is:

- **machine-scoped** — it reasons about the operator's machine (`$HOME`, the host
  CLIs, installed plugins), never about the agentic-plugins source tree.
- **artifact-only (M1)** — it writes only agentic-plugins-owned artifacts under
  the machine-global home in §10. It never writes host config, never writes a
  credential, and never performs a network request **itself** (S8b errata: the
  Stage-8 proofs it delegates to `runtime:doctor`'s explicit `--execute-*`
  executors invoke networked host agents — that network effect belongs to the
  doctor executor the operator explicitly approved, not to bootstrap, whose own
  process and artifacts stay network-free; the manifest's
  `boundary.performs_network_request: false` declares bootstrap's own conduct).
- **non-executing** — it introduces **no new executor**. Plugin install/update
  remains the existing H2 executor reached through
  `runtime:settings --execute-plugin-management`. Bootstrap consumes the
  **default dry-run** plan and *presents* the command for the operator to run.
- **render-and-confirm** — every host-config change is emitted as a fragment plus
  an apply command. **The operator applies. Bootstrap re-probes.**

### 1.1 The machine-probe seam — `probeMachineHostState()`, not `runDoctor`

**Decision.** Bootstrap MUST NOT call `runDoctor`. `runDoctor` invokes
`inspectSourcePluginState(repoRoot)` and `inspectCatalogs(repoRoot)`
**unconditionally**, and also reads repo settings runs, doctor proofs, ledgers,
consensus runs, compat runs, model/effort overlays, and baseline data. Calling it
and filtering the report afterwards does **not** satisfy "must not consume" — the
reads still happen, and any future consumer of the filtered report re-inherits
them.

Instead, S8 MUST extract a pure machine probe:

```
scripts/lib/machine-probe.mjs
  export async function probeMachineHostState({ homeDir, codexHome, env, cwd, runner, timeoutMs })
```

**The extraction boundary is narrow and exact.** Move *only* these, which depend
on nothing but `$HOME` / `$CODEX_HOME` / the host CLIs:

| In the probe | Source |
|---|---|
| host CLI presence, version, auth | host CLI invocation |
| installed-plugin rows per host — `id`, `version`, `scope`, `enabled` | `claude plugin list --json`, `codex plugin list --json` (ADR-0034 list-authority) |
| **marketplace registration + source identity** | §1.2 — a **new** probe |
| Codex feature surface + **observed** hook config | host CLI help; `$CODEX_HOME/config.toml` |
| plugin cache state | `$HOME` reads |

**Stays in `runDoctor`, unchanged**: source/catalog enrichment, *expected* hook
targets, host-parity scoring, proof reuse, settings attestation reading, ledger
and artifact inventory. Those legitimately depend on repo state, and lifting them
would break the consumers that need them. Doctor keeps its report; it simply
sources the machine half from the probe.

Three normative details the signature exists to pin:

- `cwd` MUST be **neutral** — the probe never runs a host CLI inside the caller's
  repository, because a repo-local plugin scope would otherwise leak into a
  machine answer. Today's doctor probes run in `repoRoot`.
- `codexHome` MUST honor `$CODEX_HOME`. Today's cache and hook reads hardcode
  `~/.codex`.
- Output MUST be credential-scrubbed before it reaches any artifact.

`runDoctor` MUST be refactored to consume `probeMachineHostState()` for its machine
half, so there is **one** implementation rather than two that drift.

**Rejected: adding a `scope` parameter to `runDoctor`.** Repo-derived inputs feed
its plugin matrix, hook packaging, host parity, proof reuse, settings attestations,
model/effort resolution, ledgers, and artifact inventory. A conditional would be
pervasive and would fail open the first time a new consumer forgot it. A separate
library fails closed by construction.

**The sixteen false remediations do not come from doctor.** Doctor honestly
reports `marketplace: { claude: null, codex: null }` outside the source tree. They
come from the marketplace-registration branch of `buildPluginPlans` in
`scripts/settings.mjs`, which turns that honest `null` into `Add <name> to
.claude-plugin/marketplace.json with source ./plugins/<name>` — advice meaningful
only inside the source checkout. **Repairing that branch is S8 work in its own
right** (§11 pins a direct `runSettings` consumer-repo regression), not merely a
thing bootstrap avoids.

### 1.2 The marketplace-registration probe — new, and host-native

Doctor does **not** probe marketplace inventory today; it parses Codex help text to
detect *whether the plugin subcommands exist*. Marketplace registration needs its
own read, and both hosts expose one:

| Host | Command | Returns |
|---|---|---|
| Claude | `claude plugin marketplace list --json` | `[{ name, source: "github"\|"directory", repo\|path, installLocation }]` |
| Codex | `codex plugin marketplace list` | configured marketplace sources + roots |

Both are **read-only argv** and MUST be registered as read probes in
`tests/plugin-shape/runtime-executor-registry.mjs`.

**Match on source identity, not on the name.** A marketplace merely *named*
`agentic-plugins` proves nothing: it could point at a fork, a stale local
directory, or a different project. The step is `satisfied` only when the entry's
**source identity** matches the expected canonical source
(`{ source: "github", repo: "each4all/agentic-plugins" }`). A `directory` source is
accepted but reported explicitly — it is the shape a *contributor's* machine has,
and silently treating it as equivalent to the canonical remote is how a developer
checkout gets mistaken for a consumer install.

Claude additionally persists the same information at
`~/.claude/plugins/known_marketplaces.json` (`source`, `installLocation`,
`lastUpdated`). Either read is acceptable; the CLI is the supported one.

If a host CLI does not support the subcommand, or the source identity cannot be
established, the step status is **`unknown`** — never `satisfied` — and it is
surfaced as `manual-follow-up` with the exact registration command. Absence of
evidence is never evidence of registration.

### 1.3 Planner composition requires purity — five extractions, not two lifts

The existing planners **combine computation with unconditional repo-relative
persistence**, so bootstrap cannot compose them as they stand without writing
artifacts into whichever consumer repository invoked it. Each MUST be split into a
**pure build/render** function and a **separate persist** call whose target is
injected:

| Planner | Today | Required |
|---|---|---|
| notification | `lib/notification-plan.mjs` — builds *and* persists repo-relative | pure build + injected persist |
| egress launcher | `lib/egress-launcher-plan.mjs` — builds *and* persists repo-relative | pure build + injected persist |
| permission (Claude **and** Codex) | private to `scripts/settings.mjs`, persists repo-relative | lift to `lib/`, pure build + injected persist |
| `readClaudePermissionConfig` | private to `scripts/settings.mjs`; unions repo + repo-local + user into flat sets, **losing per-rule provenance** | lift to `lib/`, **and add a user-global-only read** (§4.4) |
| plugin-management **plan half** | private to `scripts/settings.mjs`; also classifies recommendations it does not compute | lift to `lib/`, separated from the execute half, fed by §1.4 |

Bootstrap persists **only** under its machine-global run (§10).

**Resolved (S8a1 → S8a3).** All five rows are extracted; the *Today* column above
records the pre-extraction state, not the tree. Where each planner lives now:

| Planner | Gather | Pure build | Injected persist |
|---|---|---|---|
| notification | `gatherCodexNotificationInputs` | `buildCodexNotificationPlanSection` | `writeNotificationPlanArtifact` |
| egress launcher | `gatherEgressLauncherInputs` | `buildEgressLauncherPlanSection` | `writeEgressLauncherPlanArtifact` |
| permission (both hosts) | `gatherPermissionPlanInputs` | `buildPermissionPlanSection` | `writePermissionAdvisoryArtifact` |
| `readClaudePermissionConfig` | `lib/permission-config.mjs` | — | — (user-global-only reads: `lib/profile-readers.mjs` `readUserGlobalClaudePermission` / `readUserGlobalCodexPermission`, §4.4) |
| plugin-management plan half | `lib/plugin-management-plan.mjs` | — | — (execute half stays in `scripts/settings.mjs`) |

Two S8a3 findings worth carrying forward, because a consumer that assumes otherwise
will be wrong:

1. **No pure build takes a `repoRoot`** — including the permission builder, whose old
   parameter was a pure string stamped into a `[projects."…"]` header. The point is
   capability, not referential purity: a builder that accepts a repo root can grow a
   repo-relative read later. The Codex trust target is passed inside `gathered` as an
   explicit `{ applicable, path }` pair. A caller with no project context sets
   `applicable: false` and gets no `[projects]` entry — passing a null path instead
   renders a `[projects."null"]` header, because the TOML renderer stringifies whatever
   it receives.
2. **Purity is a property of the build FUNCTION, not of the import graph.** These
   closures legitimately contain filesystem modules — the usage learner reads records
   synchronously, and `version.mjs` reads manifests at module initialization. The
   promise a caller may rely on is: synchronous, deterministic for identical
   `gathered` + injected clock/run-id, writes nothing, holds no repository capability,
   and never reaches `doctor.mjs`. `tests/runtime/test-planner-purity.mjs` is the gate.

The permission planner's **failure boundary** is narrower than it looks and is
preserved deliberately: only usage-record enumeration degrades to the dual `blocked`
plan. The learner, both host-config reads, artifact construction and persistence
propagate. Bootstrap must not wrap the gatherer in a catch that converts a real fault
into a serene "blocked" report.

### 1.4 Plugin selection input and version policy

`buildPluginManagementPlan` does not compute machine recommendations — it
*classifies* recommendations produced by `buildPluginPlans`, which consumes source
manifests and repo catalogs. Neither exists on a consumer machine. Bootstrap
therefore needs its own input, and the version question has a trap on both sides:
name-only data cannot detect a stale install, while pinning every plugin's current
version inside runtime makes **every** independent plugin release create runtime
freshness debt.

**Decision — the packaged definition carries membership and floors. Currentness is
advisory, and its authority is the host's registered marketplace catalog.**

```
plugins/runtime/data/plugin-set.json     (packaged; PLUGIN_ROOT-relative)
{
  "schema": "runtime-plugin-set-1.0",
  "canonical_marketplace": { "source": "github", "repo": "each4all/agentic-plugins" },
  "plugins": {
    "<name>": {
      "bundles": ["base", "engineering"],
      "hosts": ["claude", "codex"],
      "hard_requires": [{ "name": "<plugin>", "hosts": ["claude"] }],
      "soft_requires": [{ "name": "<plugin>", "hosts": ["claude", "codex"] }],
      "hook_bearing": { "claude": true, "codex": false },
      "minimum_version": "<semver|null>"
    }
  }
}
```

**`hook_bearing` is per-host, not a boolean, and is derived from *effective host
registration*** — a manifest-declared hook path **or** the host's default-discovery of
the root `hooks/hooks.json` (the dual-source rule `kit/lint` validates and `doctor`'s
`bundled_plugins` uses — *not* bare manifest-key presence). By that rule: `attention` is
**Claude-only** (its `.claude-plugin/plugin.json` declares `adapters/claude/hooks/`, and
it declares nothing on Codex); `engineer`, `orchestrator`, `founder`, and `designer` are
**hook-bearing on both hosts** — Claude via their root `hooks/hooks.json`
(`SessionStart`/`PreCompact`/`Stop`) and Codex via their `.codex-plugin/plugin.json`
`hooks` key; `runtime`, `companions`, and `image` bear none. A scalar would either invent
a false Codex `/hooks` requirement or hide a plugin's Claude hook metadata. **Stage 7 is
the Codex `/hooks` review + trust, so it keys off the `hook_bearing.codex` value** — an
earlier draft said "the Claude value", which was a host-flip error: the Claude value
drives no completion step because Claude trusts plugin hooks by install and has no
`/hooks` flow. A field recording only manifest-key presence would encode false host truth
and must be named `manifest_declares_hooks`, never `hook_bearing`.

**`minimum_version` is a correctness floor, never an update target** (the ADR-0043
discovery-floor precedent). It is `null` unless a real incompatibility forces one.
Known floors at decision time — S8 verifies and completes this list:

| Plugin | Floor | Why |
|---|---|---|
| `companions` | `0.3.0` | first version shipping `scripts/discover-peer.mjs`, which every persona's ensemble resolves through |
| `engineer` | `0.7.0` | the ADR-0019 parent-linkage minimum that `orchestrator`'s dispatch preflight already enforces |

### 1.4.1 Currentness authority — and why it is advisory

The obvious rule ("ask the host whether an update is available") **does not work**:
`claude plugin list --json` returns `id, version, scope, enabled, installPath,
installedAt, lastUpdated` — there is **no** `latestVersion` or `updateAvailable`
field; `claude plugin update` has no check-only mode; Codex offers only a
marketplace-wide `upgrade`; and the **Codex marketplace catalog carries no per-entry
version at all** (it is deliberately versionless). A contract that gated completion
on host-reported currentness would render every currentness step `unknown` and make
`complete` unreachable. That is a real trap, and this contract does not fall into it.

**Authority.** The host records each registered marketplace with a resolved
`installLocation` (`~/.claude/plugins/known_marketplaces.json`, and the same fields
from `claude plugin marketplace list --json`). The marketplace catalog **at that
location** carries per-plugin versions. Bootstrap reads it there. This is
machine-scoped — it is resolved from `$HOME` and from the operator's own
registration, never from `process.cwd()` — which is exactly what the source-manifest
path could not be.

**Advisory, not a gate.** `complete` requires **installed + enabled + satisfies the
floor**. It does **not** require "newest". A machine one patch behind is
bootstrapped; keeping it current is `runtime:settings --execute-plugin-management`'s
job, and `runtime:compat`'s. Currentness is reported — `current` / `stale` /
`unknown`, with the catalog's own `lastUpdated` shown so the operator can see
whether the *catalog* is stale — and it never blocks a terminal state. Where the
host cannot answer (Codex), it is `unknown`, and `unknown` currentness is not a
failure.

This is also the fix for `runtime:settings`'s silent no-update path: its
`sourceVersion` must come from the **registered marketplace catalog**, not from
`repoRoot/plugins/<name>/.claude-plugin/plugin.json`. §11 pins that regression
independently of bootstrap.

A CI test (source-tree only) compares `plugin-set.json` against both marketplace
catalogs, closing the drift that currently shows the plugin set as four names in
`skills/settings/SKILL.md`, six in `README.md`, and eight in the catalogs and
`doctor.mjs`.

### 1.5 Write-ahead is the durability fix — separating plan from execute is not

Splitting `buildPluginManagementPlan` into halves changes **nothing** about
durability by itself. Today the H2 executor runs during report construction, and
the execution artifact is written only after the completed report; the retired-
plugin cleanup executor has the identical defect. If the process dies between
them, a machine mutation lands with **no durable record of it**.

**Decision — H2 execution MUST be write-ahead:**

1. persist the `planned` intent, including a **plan hash**, *before* any action;
2. append a **journal entry** after **each** action;
3. finalize at the end.

This **supersedes** the nontransactional "re-run, not rollback" ordering that
[`settings-report-contract.md`](settings-report-contract.md) documents as current
behavior, for the plugin-management and cleanup executors. ADR-0046 §5 carries the
policy.

**It cannot be bolted on — the settings execution artifact needs a protocol
change**, and S8 must land all four parts together:

1. **Nonterminal statuses.** The execution artifact today emits only terminal
   `completed` / `failed`. It gains `planned` and `in-progress`, and a per-action
   `journal[]` of `{ action, host, status, started_at, finished_at, exit_code }`.
2. **Schema minor bump.** The execution-artifact schema version moves; the probe-
   boundary suite pins the current one, so the pin moves in lockstep.
3. **Reader migration — the load-bearing one.** Doctor currently treats an
   execution record with zero failures as *available*. A `planned` or `in-progress`
   record has zero failures **and has not finished**. Without the reader change, the
   write-ahead record would be read as a **successful** run — turning a durability
   fix into a false-success bug. Doctor MUST treat any nonterminal record as
   not-available, and surface it as an interrupted run with recovery guidance.
4. **Cleanup too.** The retired-plugin cleanup executor has the identical ordering
   and gets the identical treatment. Fixing only plugin-management leaves the same
   hole one function over.

An interrupted run is **resumable, not rolled back**: the journal names what
landed, bootstrap re-probes, and the remaining actions are re-planned. Nothing is
ever auto-uninstalled (§10.3).

**Concrete shape (shipped by S8a1, `runtime:settings`).** The execution artifact
schema moved `runtime-settings-execution-artifact-1.1` → `-1.2`. The added fields:

| Field | Shape |
|---|---|
| `status` | `planned` \| `in-progress` \| `completed` \| `failed` \| `refused` (was only `completed`/`failed`) |
| `terminal` | boolean — `false` for `planned`/`in-progress` (the reader's not-available signal) |
| `plan_hash` | the §1.6 sha256 over the mode-invariant executable-action set |
| `planned_actions[]` | the durable intent, each `{ area, host, plugin, action, command, args }` — written before any action |
| `journal[]` | one entry per executed action: `{ area, id, action, host, plugin, status, started_at, finished_at, exit_code }` |

The `planned` record (with `plan_hash` + `planned_actions`) is written **before**
the first action; each action appends a `journal[]` entry and re-persists as
`in-progress`; finalize rewrites the terminal record. Every write is atomic
(sibling temp + rename), so a crash never leaves a torn record. Doctor and the
dashboard both key off `terminal === false` (or a nonterminal `status`) to read an
interrupted run as **not available** / an attention item — the reader migration
that stops write-ahead from becoming a false-success bug.

### 1.6 Plan/executor drift

Bootstrap *presents* `runtime:settings --execute-plugin-management`, and that
invocation **recomputes a fresh plan** rather than consuming bootstrap's. Actions
can change between the operator reading the plan and running it.

**Decision.** The presented command carries the **plan hash**. The executor
revalidates against it and, on divergence, refuses and re-presents rather than
executing a plan the operator never saw. Bootstrap re-probes after execution and
reconciles observed against planned; any divergence is reported, never silently
absorbed.

---

## 2. Stage model

### Stage 0 — pre-runtime. Document-only, host-native, irreducible.

Runtime does not exist yet, and on Claude the marketplace registration is not in
the H2 allowlist at all — there is no `claude plugin marketplace add` case. Stage 0
therefore cannot be executed or guided by runtime, and
[ADR-0006](../../../docs/adr/0006-directory-layout-install-pattern.md) rejected the
repository-level installer that could. It is manual **until ADR-0006 is
superseded** — a decision, not a technical impossibility.

```sh
# Claude Code
claude plugin marketplace add each4all/agentic-plugins
claude plugin install runtime@agentic-plugins

# Codex CLI
codex plugin marketplace add each4all/agentic-plugins
codex plugin add runtime@agentic-plugins
```

`codex plugin add` writes `[plugins."<name>@agentic-plugins"] enabled = true` into
`~/.codex/config.toml` **itself** (host-truth recorded in ADR-0035 against Codex
`0.137.0`). A manual `enabled = true` edit is therefore a **failed-post-probe
fallback**, offered only when the post-probe finds the plugin disabled — not an
unconditional instruction, which is what earlier docs imply.

`runtime:bootstrap` MUST detect an unsatisfied Stage 0 **for the peer host** and
print these exact commands. It cannot detect its own Stage 0: if it is running,
its own install is satisfied by definition — but **not** its marketplace
registration, which can be removed after install and MUST still be probed (§1.2).

`README.md` carries the same block. §11 pins that they agree.

### Stage 1+ — post-runtime. Conducted by `runtime:bootstrap`.

| Stage | Step group | Applied by |
|---|---|---|
| 1 | peer host CLI present + authenticated | operator (host-native) |
| 2 | marketplace registered, both hosts | operator (Claude) / H2 (Codex) |
| 3 | selected bundle installed + enabled | H2 via `settings --execute-plugin-management`, **presented** |
| 4 | model / effort defaults | `settings --apply --target user` (agentic-plugins-owned) |
| 5 | operator observability + egress (ADR-0048 §1 — renamed from "notification + egress"; no stage inserted, nothing renumbered) | operator applies the rendered fragments |
| 6 | permission posture, **both hosts** — Claude `~/.claude/settings.json` **and** Codex `approval_policy` / `sandbox_mode` (ADR-0038 requires first-class plans for both) | operator applies the rendered fragments |
| 7 | Codex `/hooks` review + trust | operator (interactive TUI), then attestation |
| 8 | execution proof (§8) | `runtime:doctor --execute-*` |

---

## 3. Command grammar

```
runtime:bootstrap plan     [--bundle <id>] [--plugins <csv>] [--profile-file <path>]
                           [--answers <path>] [--format text|json]
runtime:bootstrap status   [--run-id <id> | --latest | --latest-open] [--format text|json]
runtime:bootstrap resume   [--run-id <id> | --latest-open] [--answers <path>]
                           [--format text|json]
runtime:bootstrap verify   [--run-id <id> | --latest] [--format text|json]
runtime:bootstrap attest   [--run-id <id> | --latest] [--format text|json]
runtime:bootstrap abandon  (--run-id <id> | --latest-open) [--reason <text>]
runtime:bootstrap profile export [--name <id>] [--from-run <id>] [--overwrite]
runtime:bootstrap profile seed   --profile-file <path> [--run-id <id> | --latest-open]
```

- **Run selection** follows the semantics [`footer-contract.md`](footer-contract.md)
  already established: `--run-id` is explicit; `--latest` is the newest run;
  `--latest-open` is the newest non-terminal run. They are mutually exclusive.
- `plan` starts a run. `--bundle custom` REQUIRES `--plugins <csv>`.
- `status` / `verify` are **R0** — they re-probe, compute invalidation
  **in memory**, and report. They write nothing. `resume` is **M1** — it re-probes,
  **persists** the invalidation stamps and any new step transitions, and continues
  the interview. Invalidation (§7) is therefore *computed* by the read-only verbs
  and *persisted* only by `resume`; an R0 verb that wrote a stamp would not be R0.
- **`verify` does not run proofs — it re-judges the recorded ones (errata).** The
  verb's name invites the opposite reading, and §8.2's proof recording (a
  `runtime:doctor --record` invocation plus the machine-global metadata copy) is
  unambiguously a **write**. Wiring it under `verify` would make the contract's own
  R0 claim false. So, explicitly:
  - `verify` reads the run's already-recorded proof metadata, recomputes each
    proof's `status` against the **current** probe's bound versions (§8.1), and
    reports `passed` / `failed` / `stale` / `not-applicable` / `absent`. A proof
    that was never recorded is `absent` — `verify` reports it and exits `10`
    (`configured-not-verified`); it never records one to make itself pass.
  - `resume` is the **only** verb that executes Stage 8: it invokes
    `runtime:doctor --record` with the relevant `--execute-*` flag and an explicit
    repo-root, then copies the proof metadata into the run's `proof/` directory
    (§8.2). The Codex `/hooks` attestation is carried on the same verb, the same
    way.
  This is why the two verbs exist separately: `resume` **produces** evidence,
  `verify` **judges** it, and a machine can be re-judged as often as the operator
  likes without re-running a single peer smoke.
- With **no run**, `status` and `verify` report `no-active-run` and exit `30`; they
  never synthesize one.
- **`attest` is the post-terminal receipt door (ADR-0048 §3 / D0.1).** A
  successful final proof send terminalizes the run, after which `resume` refuses
  it — so the owner's after-the-fact phone-receipt testimony needs a verb of its
  own. `attest` requires a recorded `egress-provider-ack` that still re-judges
  `passed`, assembles the receipt record (surface `owner-phone`, the ack's
  synthetic `attempt_hash`, the stored ack file's own sha256 as
  `provider_proof_artifact_hash`, and a time — no free text, no device
  identifier), and persists it through the proof writer's one
  `postTerminalWritable` exception. It never touches the manifest — steps,
  proofs, status, and the stored completion are inviolate — and it refuses an
  `abandoned` run (an escape hatch is not a completed bootstrap anyone can
  testify about) and any run whose schema is not the current one (receipt is
  1.2 vocabulary; an open legacy run migrates via `resume` first). Submitting
  `execute` and `attest-receipt` against the ack step in ONE answers file
  resolves to one effective action (last-wins), so executing and testifying in
  the same resume is structurally impossible — testimony is always about a
  PRE-EXISTING acked attempt.
- `abandon` closes an open run (`status: abandoned`) so a new `plan` can start. A
  crashed or unwanted run MUST be recoverable without hand-editing the artifact
  home — otherwise one interrupted run blocks the machine forever. `abandon` never
  reverses anything the operator already applied (§10.3).
- `--format json` is a complete, non-conversational rendering. **Deterministic**
  means: given the same probe result and the same run, the JSON is byte-identical
  except for the fields explicitly marked volatile (`run_id`, `started_at`,
  `updated_at`, `probed_at`). The interview is never required to reach a plan.
- `profile export` exports the **live probe** unless `--from-run` names a run. With
  no run, `selection.bundle` is `custom` and `selection.desired` is **the observed
  installed set** — which is, empirically, exactly what this machine chose;
  `excluded` is empty. There is **no `--out`**: writes are constrained to the
  authorized home (§10). Overwriting an existing profile name requires
  `--overwrite`.
- `profile seed` seeds the *interview defaults* of a run — the run named by
  `--run-id` / `--latest-open`, else the newest open run; with no open run it exits
  `30`. `plan --profile-file` is sugar for `plan` immediately followed by `seed`.
  Neither applies anything.
- **Both hosts, always.** There is no `--hosts` flag. See §8.3.
- The **script** (`scripts/bootstrap.mjs`) owns facts, schemas, state, and the
  completion reducer. The command runbook and skill own conversational pacing only —
  no schema decision lives in **command or skill markdown**. (This document is where
  schema decisions live; that is its purpose.)
- **Interview answers reach the script through a JSON answers file**
  (`--answers <path>`), never through prose and never through free-form flags. The
  file is the run's `choices[]` in serialized form, so a conversational run and a
  scripted run take the same path and a run is **replayable** from its own manifest.
  Prose-to-flag translation by the skill would be unauditable and untestable.
  `--answers` is accepted on exactly the two **interview** verbs — `plan` and
  `resume` — and on no other. `status`, `verify`, and `abandon` conduct no
  interview, and `profile seed` takes a *profile* (`--profile-file`, which seeds
  **defaults**), not *answers* (which record decisions); accepting answers there
  would let a seed silently decide a step it is only allowed to pre-fill (§4.5.4).
  An answer whose `step_id` is not an expected step of the run is rejected (exit
  `40`) rather than recorded, so a stale answers file cannot smuggle a step into a
  manifest the registry never derived (§6.1). The answer vocabulary is exactly
  four values (S8b errata fixed the shape-without-values gap; ADR-0048 §3 added
  the fourth): **`decline`** marks a declinable step declined (a non-declinable
  target is exit `40`, and a plugin decline re-runs the §9.1 closure over the
  retained set); **`accept`** records the operator's go-ahead without changing
  step state (steps are promoted only by post-probes, §6); **`execute`** —
  meaningful on `proof.*` steps under `resume` only — is the explicit approval
  that lets `resume` run that proof through `runtime:doctor --record`;
  **`attest-receipt`** — valid against `proof.egress-provider-ack` only, and
  never under `plan` (no ack can exist yet, so there is nothing to testify
  about) — records the owner's phone-receipt testimony intent, audit-logged in
  `choices[]` like every other answer. Duplicate answers for one step apply in
  file order and every one is recorded in `choices[]`, keeping the run
  replayable from its own manifest — and consumers read the per-step
  **EFFECTIVE** action (the last one), never the raw rows: the raw-filter
  shape executed an `execute` a later row had declined (ADR-0048 §3 repair).
- **Run terminalization is asymmetric** (S8b errata — closing on the reduction
  alone made Stage 8 unreachable): `resume` closes a run as `complete` when the
  reducer says so, and as `configured-not-verified` **only when every required
  proof was explicitly declined** (§6.2 — nothing is left for `resume` to
  produce). Any other reduction leaves `status: open` — a machine whose CONFIG
  just resolved still needs an open run for the `resume` that records its
  proofs — while the verb's **exit code** always reports the reduction (§3.1),
  so "reduces to configured-not-verified" and "the run file is closed" are
  deliberately different claims.

### 3.1 Exit codes

| Code | Meaning |
|---|---|
| 0 | `complete` |
| 10 | `configured-not-verified` |
| 20 | `incomplete` (steps remain) |
| 30 | `no-active-run` (for `status` / `resume` / `verify`) |
| 40 | invalid input (bad bundle, broken closure, schema rejection, path violation) |
| 50 | `legacy-historical` — a TERMINAL run under an older schema minor: the stored record was shown verbatim and **nothing was re-probed or re-certified** (ADR-0048 §1). Exit 0 would claim a current completion nobody re-proved, which is exactly the overclaim this code exists to prevent |
| 1 | unexpected error |

---

## 4. Machine profile schema (`agentic-machine-profile-1`)

A **secrets-free, enumerated snapshot of one machine's choices**, written by
`profile export`, consumed by `profile seed`.

> **The load-bearing invariant.** The profile is an **untrusted source of interview
> defaults**. It is never configuration to apply, and it is **never an input to any
> activation or config loader**. `loadEgressActivation()` MUST NOT read it. A
> profile that could activate egress would be exactly the vector ADR-0041 §2c
> closed.

### 4.0 `notify_channel` is not an egress channel — do not merge them

`NOTIFY_CHANNELS` is `none | macos-osascript | file-log`. **`telegram` is not a
`notify_channel` value and must never become one.** Egress activation lives in a
*separate* axis (`egress.channel`, sourced only from
`AGENTIC_NOTIFY_EGRESS_CHANNEL` or the fail-closed-verified
`~/.agentic-plugins/config.local.toml`), precisely so that tracked configuration
can never activate egress — ADR-0041 §2c states the rule in exactly these terms.

The profile carries the two as **separate objects**, and `profile seed` MUST NOT
map one onto the other. Validation rejects a profile whose `notify.notify_channel`
carries an egress channel.

### 4.1 Schema

```jsonc
{
  "schema": "agentic-machine-profile-1.1",
  "exported_at": "<iso-8601-utc>",
  "boundary": {
    "writes_host_config": false,
    "writes_credential": false,
    "writes_config_local_toml": false,
    "performs_network_request": false
  },
  "source": {
    "hostname_hash": "<sha256 prefix — never the raw hostname>",
    "runtime_version": "<semver>",
    "claude_cli_version": "<semver|null>",
    "codex_cli_version": "<semver|null>"
  },
  "selection": {
    "bundle": "base|engineering|business|design|full|custom",
    "desired": ["<plugin>"],
    "excluded": ["<plugin>"],
    "observed": {
      "claude": [{ "name": "<plugin>", "version": "<semver|null>", "state": "installed|missing|unknown" }],
      "codex":  [{ "name": "<plugin>", "version": "<semver|null>", "state": "installed|disabled|missing|unknown" }]
    }
  },
  "model_effort": {
    "model":        { "value": "<id|null>", "scope": "machine", "provenance": "<source>" },
    "effort":       { "value": "<id|null>", "scope": "machine", "provenance": "<source>" },
    "claude_model": { "value": "<id|null>", "scope": "machine", "provenance": "<source>" },
    "claude_effort":{ "value": "<id|null>", "scope": "machine", "provenance": "<source>" },
    "codex_model":  { "value": "<id|null>", "scope": "machine", "provenance": "<source>" },
    "codex_effort": { "value": "<id|null>", "scope": "machine", "provenance": "<source>" }
  },
  "notify": {
    "notify_channel":                   { "value": "none|macos-osascript|file-log", "scope": "machine", "provenance": "<source>" },
    "notify_quiet_hours":               { "value": "<spec|null>", "scope": "machine", "provenance": "<source>" },
    "notify_quiet_hours_tz":            { "value": "<tz|null>",   "scope": "machine", "provenance": "<source>" },
    "notify_dedupe_ttl_seconds":        { "value": "300",         "scope": "machine", "provenance": "<source>" },
    "notify_urgent_bypass_quiet_hours": { "value": "false",       "scope": "machine", "provenance": "<source>" },
    "notify_kinds":                     { "value": "<csv|null>",  "scope": "machine", "provenance": "<source>" }
  },
  "egress": {
    "declined":            false,
    "channel":             { "value": "<channel|null>", "scope": "machine", "provenance": "<source>" },
    "recipient":           { "value": "<chat-id|null>", "scope": "machine", "provenance": "<source>" },
    "headline_opt_in":     { "value": false,            "scope": "machine", "provenance": "<source>" },
    "credential_env_var":  "TELEGRAM_BOT_TOKEN",
    "credential_required": true
  },
  "permissions": {
    "claude": { "allow": ["<sanitized rule>"], "ask": ["<sanitized rule>"], "deny": ["<sanitized rule>"],
                "defaultMode": "<mode|null>", "scope": "machine", "provenance": "user-global" },
    "codex":  { "approval_policy": "<policy|null>", "sandbox_mode": "<mode|null>",
                "scope": "machine", "provenance": "user-global" }
  }
}
```

Rules:

- `notify_dedupe_ttl_seconds` MUST be a **positive integer** string — the existing
  validator rejects `0`. Every `notify_*` value uses the validator's own accepted
  form; the profile does not invent a second encoding.
- `credential_required` is `true` **only when** `egress.declined === false` **and**
  `egress.channel.value !== null`. A declined egress carries `channel: null` and
  `credential_required: false`.
- `egress.recipient` is validated against the same shape check the launcher uses;
  a value failing it is exported as `null` with a diagnostic, never as a
  placeholder that could be mistaken for real.
- **Closed schema, with one precisely-scoped exception.** Unknown **object** keys
  fail validation at any depth, always. Unknown **scalar** keys fail too — *unless*
  the file's `schema` minor is **greater** than the reader's, in which case they are
  ignored with a warning. A same-or-older minor has no excuse for an unknown key, so
  it is rejected. This is the forward-compat posture engineer's state reader already
  uses, and it is why the schema string carries a **minor** (`-1.0`) rather than a
  bare major.
- **Canonical order** for serialization is the key order above; values are
  canonicalized before hashing.
- **Bounded**: the artifact is capped at **64 KiB**; `permissions.claude.*` rule
  arrays are capped at **256 entries each** and sanitized through
  `lib/permission-sanitize.mjs`. A profile exceeding a cap is refused, not
  truncated — a silently truncated permission list is a security artifact, not a
  convenience.

### 4.2 Categorically excluded — never present, at any nesting depth

- credential and token values (only the **environment-variable name** and a
  `required` boolean)
- any authentication material, session token, or API key
- **repository paths** and Codex **project-trust** entries
- Codex `/hooks` trust attestations — machine- and version-bound, never portable
- caches, transcripts, workflow state, generated run state
- the raw hostname (a hash prefix only)

### 4.3 Write-side enforcement — three guards, not one

1. **Fail-closed secret scrub.** A `scrubSecrets` round-trip; **any** secret-shaped
   value refuses the write. (Pattern: `assertNoSecretInArtifact()` in
   `lib/egress-launcher-plan.mjs`.)
2. **Boundary validator.** The write is refused unless **every** `boundary.*` flag
   is `false` — including `performs_network_request`, not merely the `writes_*`
   trio. The `boundary` object is therefore **part of the schema**, not an
   afterthought.
3. **Static loader test.** No activation or config loader — `lib/egress-config.mjs`
   in particular — reads the profile path. Assert statically; a runtime assertion
   passes vacuously.

Secret-pattern matching alone is insufficient: it does not remove repository paths
or an unsafe permission posture. §4.2 and §4.5 carry those.

### 4.4 Export reads **user-global only** — this is a correctness rule, not a preference

Today's readers would **promote repository policy into a portable machine
profile**:

- model/effort resolution **prefers repo config over user config**;
- `readClaudePermissionConfig` **unions** repo, repo-local, and user rules into
  flat sets, losing per-rule provenance.

Labelling that result `scope: "machine"` would silently export one project's
policy as another machine's global default.

**Decision.** `profile export` MUST use **user-global-only readers** (§1.3 adds
them). Repository-effective values MAY be reported as informational overlays in
`plan` / `status` output; they are **never** written into the profile and never
relabelled. Every profile value carries `provenance`, and a value whose provenance
is not user-global is not exportable.

### 4.5 Seed-side rules

On `profile seed`, runtime MUST:

1. validate the schema **exactly**; reject unknown fields, secret-shaped values,
   and any `boundary.writes_* !== false`;
2. preserve each value's `scope` label — a machine value never becomes a repo
   override, and a repo override is never promoted to machine-global;
3. **safety-grade before presenting.** A source machine's `bypassPermissions`,
   `approval_policy = "never"`, or `danger-full-access` MUST NOT be presented as a
   default. The target's safe recommendation wins, and the profile's value is shown
   as a labelled note. This is ADR-0038's safety-graded rule; "present every value
   as a default" is subordinate to it;
4. present every remaining value as a **default requiring confirmation** — never
   apply one;
5. **re-diagnose the target machine** and treat live state, not the snapshot, as
   evidence (§7);
6. write nothing to host config.

The chat-id pre-fills; the token never does — generalizing the egress launcher's
existing behavior from one value to the whole profile.

#### Profile 1.1 (ADR-0048 §2.1 / §4 realization)

- **`statusline_preset`** — the adopted statusline item set, carried as an
  OPTIONAL trailing **scalar** preset id (the owner-adopted six-item set is
  `agentic-6`). A bare string on purpose, twice over: §4.6 lets a 1.0 reader
  ignore an unknown *scalar* with a warning (an object would refuse the whole
  document — the nested/custom shape is exactly §2.1's named major-bump case),
  and canonicalization serializes unknown keys after known ones, so appending it
  LAST keeps a 1.0 reader's canonical hash aligned with a 1.1 reader's over the
  same document. The id names a policy; the canonical ordered item definition
  belongs to the statusline adapter, never inline here. It is a DECLARATION the
  export carries, never an observation inferred from host config. Validator
  warnings from the ignored-scalar path SURFACE in the consuming verb's
  report — an invisible warning is a forward-compat rule nobody exercises.
- **`credential_env_var` is a WRITE-GATE constant, not a schema `const`
  (ADR-0048 §4, realization decision D0.4).** The ADR asks for a schema
  constant; a JSON `const` in a minor would invalidate legal 1.0 documents
  carrying `null` or another name — a direct §4.6 additive violation — so the
  schema shape stays `["string","null"]` and the pinning lives in
  `assertProfileWritable` on every write/seed path: a present name other than
  `TELEGRAM_BOT_TOKEN` is refused at the gate. The ADR's goal (no arbitrary
  credential env var can enter the recorded contract) is enforced at the write
  boundary; the difference from the ADR's literal wording is deliberate and
  owner-approved (2026-07-23).

### 4.6 Schema migration

`schema` carries **major.minor**. An **unknown major** is rejected with a diagnostic
naming the runtime version that understands it — never silently downgraded, never
partially read.

Minors are forward-compatible in exactly the way §4.1 states, and no other way: a
reader meeting a **greater** minor ignores unknown *scalar* additions and warns;
unknown *object* keys still fail; a reader meeting a **same-or-older** minor rejects
any unknown key at all. Downgrade is never attempted.

---

## 5. Run manifest schema (`runtime-bootstrap-run-1`)

```jsonc
{
  "schema": "runtime-bootstrap-run-1.2",
  "run_id": "<run-id>",
  "started_at": "<iso-8601-utc>",
  "updated_at": "<iso-8601-utc>",
  "status": "open|complete|configured-not-verified|abandoned",
  "selection": { "bundle": "<id>", "desired": ["<plugin>"], "excluded": ["<plugin>"] },
  "seeded_from": { "profile_id": "<name>", "profile_hash": "<sha256>" },
  "choices": [ { "step_id": "<id>", "answer": "<value>", "at": "<iso-8601-utc>" } ],
  "history": [ { "step_id": "<id>", "from": "<status>", "to": "<status>", "reason": "<why>", "at": "<iso-8601-utc>" } ],
  "probe": {
    "probed_at": "<iso-8601-utc>",
    "runtime_version": "<semver>",
    "hosts": {
      "claude": { "cli_version": "<semver|null>", "auth": "available|unauthenticated|unknown|sandbox_limited",
                  "marketplace": "registered|missing|unknown",
                  "plugins": { "<name>": { "version": "<semver|null>", "state": "installed|missing|unknown" } } },
      "codex":  { "cli_version": "<semver|null>", "auth": "available|unauthenticated|unknown|sandbox_limited",
                  "marketplace": "registered|missing|unknown",
                  "plugins": { "<name>": { "version": "<semver|null>", "state": "installed|disabled|missing|unknown" } },
                  "hook_state": {                                             // 1.1 (S8a5); structurally optional
                    "observation": "available|missing|unreadable",
                    "disabled_expected": [
                      { "plugin": "<name>", "hooks_path": "<path|null>", "event": "<event|null>",
                        "group_index": "<index|null>", "hook_index": "<index|null>" }
                    ]
                  } }
    }
  },
  "plan_hash": "<sha256 of the canonical planned action set>",
  "steps": [
    {
      "id": "<step-id>",
      "stage": 1,
      "status": "satisfied|pending|blocked|manual-follow-up|declined|unknown|not-applicable",
      "declinable": false,
      "blocked_by": ["<step-id>"],
      "applied_by": "operator|h2-executor|agentic-config|null",
      "desired": "<value|null>",
      "observed": "<value|null>",
      "observed_at": "<iso-8601-utc|null>",
      "fragment_pointer": "<path|null>",
      "apply_command": "<string|null>",
      "fragment_applied": false,
      "failure_class": "<class|null>",
      "retryable": false,
      "recovery": "<operator guidance|null>",
      "invalidated": { "at": "<iso-8601-utc>", "reason": "<version-drift|manual-reset>" }
    }
  ],
  "completion": {
    "state": "complete|configured-not-verified|incomplete",
    "unsatisfied": ["<step-id>"],
    "missing_steps": ["<step-id>"],
    "proofs": [
      { "kind": "deep-peer-smoke|workflow-continuation|permission",
        "status": "passed|failed|stale|not-applicable|absent",
        "directions": {
          "claude->codex": { "status": "passed|failed|blocked|absent", "ran_at": "<iso-8601-utc|null>" },
          "codex->claude": { "status": "passed|failed|blocked|absent", "ran_at": "<iso-8601-utc|null>" }
        },
        "artifact_pointer": "<path|null>",
        "artifact_hash": "<sha256|null>",
        "bound_versions": {
          "runtime": "<semver>", "claude": "<semver|null>", "codex": "<semver|null>",
          "plugins": { "claude": { "<name>": "<semver>" }, "codex": { "<name>": "<semver>" } }
        },
        "ran_at": "<iso-8601-utc|null>" }
    ],
    "hook_attestation": {
      "status": "attested|stale|absent|not-applicable",
      "attested_plugins": ["<name>"],
      "bound_versions": { "codex": "<semver|null>", "plugins": { "codex": { "<name>": "<semver>" } } },
      "artifact_pointer": "<path|null>",
      "artifact_hash": "<sha256|null>",
      "attested_at": "<iso-8601-utc|null>"
    }
  },
  "boundary": {
    "writes_host_config": false,
    "writes_credential": false,
    "writes_config_local_toml": false,
    "performs_network_request": false
  },
  "limits": ["<one line per enforced limit>"]
}
```

`boundary.*` MUST all be `false`; the artifact validator refuses the write
otherwise. Per-host plugin state is **nested under the host** — a flat map would
collapse a Claude/Codex version divergence and could retain a proof bound to the
wrong one.

`seeded_from` records a **profile id and hash**, never a filesystem path (a path
can itself reveal operator layout).

Four shapes are load-bearing and agree with §8 / §8.1:

- **`probe.hosts.<h>.auth` is an enum**, not a boolean — `available` / `unauthenticated`
  / `unknown` / `sandbox_limited` — because the machine probe (`probeMachineHostState`,
  §1.1) genuinely distinguishes them; a boolean would collapse "not authenticated" into
  "unknown" and let a `sandbox_limited` read masquerade as authenticated.
- **The RECORDED proof's `directions` is a per-direction result map**, not a list of
  direction names (§8.1). A proof's `status` is the **aggregate recomputed from the
  kind's evidence member** — `directions`, or `provider_ack` for
  `egress-provider-ack` (1.2, ADR-0048 §3) — never trusted from storage: a smoke
  that passed `claude->codex` and failed `codex->claude` is `failed`, and a schema
  that could only say `directions: [...]` could not express it. Two shapes exist
  and must not be conflated (the 1.1-era text conflated them, and re-judgement
  read the wrong one — the false-demotion repair): the **recorded** proof lives in
  `proof/<kind>.json` and keeps its evidence member; the **reduced**
  `completion.proofs[]` entry collapses that evidence into `status` + `reasons`
  and carries no `directions` at all. Re-judgement (status/verify/resume) reads
  the RECORDED files back — validated, byte-rehashed — and the manifest's
  completion is a cached reduction over them, never the re-judgement source.
  The 1.2 kind discriminator is enforced in code (lib/evidence-contract.mjs, one
  table for importer/writer/reader/reducer): directional kinds require
  `directions` and forbid `provider_ack`; `egress-provider-ack` the reverse;
  unknown kind, both members, neither member, filename/embedded-kind mismatch,
  and duplicate kinds are refused fail-closed — the schema deliberately leaves
  both members optional because the §4.1 validator has no `oneOf`.
- **`bound_versions.plugins` is per-host** (`{ claude: {…}, codex: {…} }`) and binds
  **every** selected plugin version, not only runtime + the two CLIs (§8.1). Freshness
  compares exact key **sets and values**; a missing or null required version never counts
  as current. `hook_attestation` carries its own Codex-bound versions + the exact retained
  Codex-hook-bearing plugin set, and stales on a Codex CLI change, a hook-plugin
  add/remove/version change, or a disabled expected hook — at the **individual-handler
  grain** (S8a5): `probe.hosts.codex.hook_state.disabled_expected` lists every expected
  handler explicitly `enabled = false` in Codex `[hooks.state]`, so a disabled handler
  beside an enabled sibling for the same (plugin, path, event) still stales the claim.
  The plugin-level `plugins.<name>.state` check alone missed exactly that case.
  `hook_state` is structurally optional (a 1.0 probe validates) but **semantically
  required** for a current applicable attestation: a probe without an
  `observation: available` hook_state cannot support a current claim — the reducer
  stales it, and resume-means-re-probe (§7) supplies the evidence on the next run.
  Absence of an `enabled` key in `[hooks.state]` means ENABLED (verified on codex-cli
  0.142.5); only an explicit `false` is disabled evidence.
- **`steps[].fragment_applied`** marks that *this run rendered a fragment and a post-probe
  observed the operator applying it* — distinct from a pre-existing matching config. The
  §8.1 `permission` proof is required **iff** a `permission.*.applied` step carries
  `fragment_applied: true`, so a machine whose permissions already matched does not trip
  a proof it never needed.

---

## 6. Step and status taxonomy

| Status | Meaning | Counts toward completion? |
|---|---|---|
| `satisfied` | A post-probe **observed** the desired state on this machine. | yes |
| `declined` | The operator explicitly opted out, and the step is in the declinable set (§6.2). | yes |
| `not-applicable` | The step cannot apply to this selection (e.g. workflow-continuation proof with no `engineer` in the bundle). | yes |
| `pending` | Not yet done; nothing blocks it. | no |
| `blocked` | A predecessor or external condition prevents it. | no |
| `manual-follow-up` | Rendered and handed to the operator; awaiting their action and the confirming re-probe. | no |
| `unknown` | The probe could not determine the state (host lacks the read; legacy CLI). | **no** — unknown is never satisfied |

`satisfied` is reserved for **observed** state. A step is never `satisfied` because
the operator said they applied it, because a previous run recorded it, or because a
fragment was rendered. **Only a post-probe promotes a step.**

### 6.1 The expected-step registry — omission must not pass

The reducer walks an **exact expected-step set** derived from the selection, not
merely the `steps[]` array present in the manifest. A step that is *absent* is
counted in `missing_steps[]` and **blocks completion**. Without this, a manifest that
simply omits a required step passes the reducer — the exact false-pass this command
exists to prevent. The registry is therefore enumerated here, not left to S8:

| step id | stage | applicability | declinable |
|---|---|---|---|
| `host.claude.present` | 1 | always | no |
| `host.claude.authenticated` | 1 | always | no |
| `host.codex.present` | 1 | always | no |
| `host.codex.authenticated` | 1 | always | no |
| `marketplace.claude.registered` | 2 | always | no |
| `marketplace.codex.registered` | 2 | always | no |
| `plugin.<name>.claude.installed` | 3 | per plugin in the selection targeting Claude | only if the plugin is optional (§6.2) |
| `plugin.<name>.codex.installed` | 3 | per plugin in the selection targeting Codex | only if the plugin is optional (§6.2) |
| `plugin.<name>.codex.enabled` | 3 | per plugin in the selection targeting Codex | follows `.installed` |
| `config.model_effort` | 4 | always | no |
| `notify.configured` | 5 | always | **yes** |
| `notify.codex.configured` | 5 | always | **yes** |
| `egress.configured` | 5 | always | **yes** |
| `permission.claude.applied` | 6 | always | **yes** |
| `permission.codex.applied` | 6 | always | **yes** |
| `hooks.codex.attested` | 7 | iff any selected plugin has `hook_bearing.codex` | no (but `not-applicable` when no Codex hook-bearing plugin is selected) |
| `proof.deep-peer-smoke` | 8 | always | **yes** (declining caps at `configured-not-verified`) |
| `proof.workflow-continuation` | 8 | iff `engineer` ∈ selection | **yes** (same cap) |
| `proof.permission` | 8 | iff a `permission.*.applied` step carries `fragment_applied: true` | **yes** (same cap) |
| `proof.egress-provider-ack` | 8 | iff the operator opted in (any recorded answer against the step, or the step already in `steps[]`) — ADR-0048 §3/D0.2 | **yes** (same cap) |

`notify.configured` keeps meaning exactly the LOCAL runtime notification policy
(`~/.agentic-plugins/config.toml` notify family); `notify.codex.configured`
observes the Codex-side wiring as an **EXACT probe** (notify-axis slice):
`satisfied` means the merged `notify =` argv in `$CODEX_HOME/config.toml`
EQUALS the canonical argv this machine's rendered fragment carries — the
shuttle, or the chain script in wrapper-chain mode — element-wise
(`expectedCodexNotifyArgv` is the one source both the fragment renderer and
this probe consume, so they cannot drift; the argv is per-OS: POSIX
`/usr/bin/env node <receiver>`, win32 the render machine's own node executable
path). A present, parseable, non-empty argv that is NOT the canonical wiring
judges `manual-follow-up` — some other notifier is wired, and runtime never
auto-chains an existing notifier, so reconciling it (re-render the plan for its
wrapper-chaining offer, or decline the step) is an operator decision.
`notify = []` runs nothing and a present-but-unparseable value is a config the
host will not run — both judge `pending`; an unreadable config judges
`unknown`. The rendered Codex notify fragment attaches to the Codex step,
whose judge re-observes it (ADR-0048 §1 split — the pre-split judge only ever
read the local config, so the merge was presented but never re-observed).

**`blocked_by` edges** (the column §5's `steps[].blocked_by` serializes; enumerated here
because §5 referenced them and this table did not define them — S8a2 C4). Each step is
blocked by its *structural* predecessors only — the things without which the step cannot
be attempted at all, never a mere stage ordering:

| step | blocked_by |
|---|---|
| `host.<h>.present` | — (nothing; the root of every chain) |
| `host.<h>.authenticated` | `host.<h>.present` |
| `marketplace.<h>.registered` | `host.<h>.present` |
| `plugin.<name>.<h>.installed` | `marketplace.<h>.registered` |
| `plugin.<name>.codex.enabled` | `plugin.<name>.codex.installed` |
| `config.model_effort` | — (agentic-plugins' own config; no host needed) |
| `notify.configured`, `egress.configured` | — (same) |
| `notify.codex.configured` | `host.codex.present` (a Codex-side config needs the Codex CLI — the permission-step precedent) |
| `permission.<h>.applied` | `host.<h>.present` |
| `hooks.codex.attested` | every selected Codex-hook-bearing plugin's `.codex.installed` **and** `.codex.enabled` |
| `proof.deep-peer-smoke` | both hosts' `.authenticated`, plus `companions` `.installed` on both and `.enabled` on Codex |
| `proof.workflow-continuation` | `engineer`'s `.installed` on both hosts and `.enabled` on Codex |
| `proof.permission` | every applicable `permission.<h>.applied` |
| `proof.egress-provider-ack` | `egress.configured` (an ack over an unconfigured egress channel is unreachable by construction) |

An empty `blocked_by` is written **explicitly** (`[]`), never omitted: an absent edge list
and "this step has no predecessors" must not be the same byte. The graph is acyclic, and
the registry — not `run.steps[]` — is the authority for stage, applicability, declinable,
and these edges. A manifest's copy is operator-editable data; trusting it would let an
edited file grant itself a stage or drop a blocker.

`hook_bearing` is per-host (§1.4), derived from effective registration. `attention` is
Claude-only; `engineer`, `orchestrator`, `founder`, and `designer` bear Codex hooks
(their `.codex-plugin/plugin.json` declares them) **and** Claude hooks (their root
`hooks/hooks.json`). So `hooks.codex.attested` is **applicable** — `pending` until a
post-probe observes the attestation — for every bundle carrying a persona (`engineering`,
`business`, `design`, `full`), and `not-applicable` only for `base`
(`runtime`+`companions`+`attention`, none Codex-hook-bearing). The step keys off
`hook_bearing.codex`; the Claude hook values drive no step, because Claude trusts plugin
hooks by install and exposes no `/hooks` review flow.

### 6.2 The declinable set is narrow

**Not declinable, ever**: host CLI presence and authentication; marketplace
registration; `runtime`; **`companions`**; and any plugin reached by a hard edge from
a retained plugin.

**`companions` is mandatory in every selection, including `custom`.** It is not
merely a member of `base` — a `custom` selection may not omit it. The reason is
structural: `proof.deep-peer-smoke` is the only evidence that the cross-host bridge
works, and it is unreachable without a companion path (doctor itself blocks the proof
when none exists). A contract that let `companions` be declined while requiring the
smoke proof would define an unreachable terminal state. Making the *proof* conditional
instead would be worse: it would let a machine reach `complete` having proven nothing.

**Declinable**: optional plugins (any plugin not reached by a hard edge from a
retained plugin, and not `runtime` or `companions`); notification; egress; the
permission fragments; and the execution proofs — declining a proof caps the run at
`configured-not-verified` and **never** grants `complete`.

Declining a plugin creates a **new effective `custom` selection** and **re-runs hard
dependency closure** (§9.1). Declining `companions` while retaining `image` on Claude
is therefore rejected twice over — once by the closure, once by the mandatory rule.

---

## 7. Resume and invalidation

**Resume means re-probe.** Every `plan`, `status`, `resume`, and `verify` re-probes
live host state. The run manifest records **choices and history**, never **truth**.

Recorded step state MUST be invalidated — reset to `pending`, `invalidated` stamped
with a reason — when any of these changed since `probe.probed_at`:

- the runtime plugin version
- either host CLI version
- any installed plugin version in the selection

A step "satisfied" against Codex `0.136` says nothing about `0.140`; hook trust in
particular is version-bound (ADR-0030).

**Schema-minor migration (1.2, ADR-0048 §1).** `resume` is the one M1 verb, so it
is where the minor moves:

- an OPEN run under an **older** minor migrates **additively** on resume: the
  registry-new steps join `steps[]` through the ordinary reprobe (expected
  derives from the current registry; prior state carries per step id), the new
  fragments render, and the persist stamps the current schema string with a
  history row naming the migration — never a silent rewrite;
- a TERMINAL run under an older minor is **immutable historical evidence**:
  `status`/`verify` present the stored completion verbatim with
  `historical`/`not_recertified` markers and exit `50` (§3.1), re-probe nothing,
  re-read no proof file, and re-certify nothing against the current registry —
  the operator starts a fresh `plan` for current evidence;
- a run under a **newer** minor refuses `resume` outright: this runtime would
  persist a document it only half-understands, silently shedding additions a
  newer runtime recorded (§4.6: downgrade is never attempted). R0 verbs may
  still read it under the §4.1 scalar tolerance.

**History-cap boundary (schema `history` maxItems 256).** A valid legacy run
sitting exactly at the cap cannot take the migration history row: the update
fails schema validation and is refused fail-closed rather than trimming rows —
`history` is the replay record, and silently dropping its oldest entries to make
room would forge the very account it exists to keep. The escape is the ordinary
one: `abandon` the run and start a fresh `plan`. (A run with 256 history rows is
a pathological artifact, not an operating state.)

**Two reducer traps, both load-bearing** — they are why this is a command and not a
settings flag:

1. The reducer MUST NOT inherit `settings.overall.status`. That summary counts
   plugin recommendations but does **not** gate pass/warn on them; only failures
   enter its status condition. Inheriting it reports a pass while plugins are
   missing.
2. The reducer MUST NOT rely on `plugin_management.summary.blocked`, which is
   **omitted** from top-level completion calculations. It inspects blocked / manual
   / follow-up / unknown step states **directly**.

---

## 8. Completion reducer

Partition the expected steps by stage: **CONFIG** = the Stage 1–7 steps; **PROOF** =
the Stage 8 proof steps. The two terminal states differ *only* on PROOF; both require
every CONFIG step resolved.

```
complete  ⟺  missing_steps = ∅
          ∧  every CONFIG (Stage 1–7) step ∈ {satisfied, declined, not-applicable}
          ∧  every required proof (§8.1) is `passed` at the current bound versions

configured-not-verified
          ⟺  missing_steps = ∅
          ∧  every CONFIG (Stage 1–7) step ∈ {satisfied, declined, not-applicable}
          ∧  NOT every required proof is `passed`
             (a required proof is absent / failed / stale / declined)

incomplete
          ⟺  otherwise
             (a CONFIG step is pending / blocked / manual-follow-up / unknown,
              or a required step is missing)
```

`missing_steps` counts an omitted **CONFIG** step (§6.1); a machine missing a host has a
`pending` Stage-1 CONFIG step and so reduces to `incomplete` (§8.3), never
`configured-not-verified`.

> **Why the CONFIG/PROOF partition (errata).** An earlier formula required *every
> expected step* — proof steps included — to be `∈ {satisfied, declined, not-applicable}`
> for **both** terminal states. But the Stage 8 proof steps (`proof.deep-peer-smoke`
> etc.) are themselves expected steps (§6.1); an absent or failed proof leaves that
> expected step unresolved, so the shared clause failed and the reducer fell through to
> `incomplete` — making `configured-not-verified` **unreachable** and test #14
> (§11.2) impossible. Evaluating PROOF steps separately from CONFIG steps is what makes
> "I installed it" and "it works" different terminal states, as §Decision-10 (ADR-0046)
> requires. A declined proof caps at `configured-not-verified` (§6.2); it never grants
> `complete`.

**Invalid evidence caps at `incomplete` (1.2 amendment, ADR-0048 §3).** Duplicate
records claiming one kind are REJECTED, never chosen between: the read boundary
(`readBootstrapProofRecords`) refuses the whole read all-or-nothing, and the
reducer — defense-in-depth for direct library callers — reduces the duplicated
kind to `failed` with the duplication named AND caps `state` at `incomplete`
regardless of whether the duplicated proof was required. A duplicated
non-required proof is still an evidence-integrity violation, not a pass.

**The receipt attestation verdict (1.2, ADR-0048 §3 / D0.1).** The reducer
carries `completion.egress_receipt_attestation` — the recomputed verdict over the
recorded owner testimony — ONLY when the run has anything to say about it
(testimony recorded, or the egress proof opted in); every other run keeps the
exact 1.1 completion shape. `attested` requires the linked `egress-provider-ack`
to still re-judge `passed` at current bound versions, the receipt's
`provider_proof_artifact_hash` to equal the stored ack file's own sha256
(byte-rehashed at read-back), and the `attempt_hash` to match by equality. Any
drift — ack stale/failed, replaced file, different attempt — is `stale` with the
reason named; testimony never silently vanishes into `not-applicable` on drift
(removal is a staleness fact about recorded testimony, not a retraction of it).
Presentation derives the **`delivery-attested`** label from ack `passed` +
verdict `attested`; the generic completion `state` is never redefined by receipt.

### 8.1 Which proofs are required

| Proof | Required when | Why |
|---|---|---|
| `deep-peer-smoke` | **always** | It is the only proof that the cross-host companion bridge actually works. It is always *applicable* because `companions` is mandatory in every selection (§6.2) — that rule exists precisely to keep this proof reachable. |
| `workflow-continuation` | **iff `engineer` ∈ selection** | It exercises engineer machinery. Requiring it with no engineer installed would be unreachable. |
| `permission` | **iff a permission fragment was applied** in stage 6 | It proves companion invocation under the newly applied host permission defaults. |
| `egress-provider-ack` | **iff the operator opted in** (§6.1 — any recorded answer against the step, or the step already in `steps[]`) | ADR-0048 §3: it proves exactly that the pinned provider request returned HTTP 2xx + `{ok:true}` — deliberately not named "dispatch" or "delivery". Requiring it unrequested would make every non-egress machine unable to complete. |

The `egress-provider-ack` freshness additionally binds the **sanitized activation
fingerprint** by EQUALITY — a domain-separated sha256 over channel + recipient +
the credential env var NAME (lib/evidence-contract.mjs owns the derivation;
nothing credential-value-derived may enter a persisted fingerprint). A removed or
changed activation stales the proof; it never becomes `not-applicable`.
**Documented limit**: credential ROTATION is invisible to this fingerprint by
design (folding the value in would persist a value-derived hash, which §4/ADR-0048
forbids) — a rotated token surfaces as the executor's next real attempt failing,
not as staleness. The "contract version" the proof binds is realized as the run
schema id (`runtime-bootstrap-run-1.2`) plus the runtime semver already in
`bound_versions` — the contract document ships inside the runtime package, so the
runtime version pins it; no separate field exists.

A proof is `stale` — and does **not** satisfy `complete` — when its `bound_versions`
do not match the current probe. **`bound_versions` binds the plugin versions too**,
not only runtime and the two CLIs: doctor's own proof-reuse check compares every
plugin version, and a proof recorded against `companions@0.3.0` says nothing about
`companions@0.5.0`.

The proof record stores **per-direction results**, not a list of direction names: a
smoke that succeeded `claude→codex` and failed `codex→claude` is not a passing proof,
and a schema that can only say `directions: [...]` cannot express that.

### 8.2 Proof evidence is machine-global, because doctor's is not

Doctor records proofs and Codex hook attestations **repo-relative**. Bootstrap run
from repository B therefore cannot discover evidence recorded in repository A —
which for a *machine* bootstrap is a defect, not a nuance.

**Decision.** Bootstrap invokes `runtime:doctor --record` with the relevant
`--execute-*` flag and an **explicit repo-root**, then copies the proof's **metadata
only** — artifact pointer, hash, `bound_versions` (runtime + both CLIs + every
selected plugin version), and **per-direction results** — into
`~/.agentic-plugins/runs/bootstrap/<run-id>/proof/`. Raw peer output is never copied
and never printed. The Codex `/hooks` attestation is carried the same way, as a
`hook_attestation` record with its own bound versions — it is an operator claim, and
a claim made against Codex `0.137` does not survive an upgrade.

**Under `resume`, and only `resume` (§3 errata).** Both halves of that decision —
the `--record` invocation and the metadata copy — are writes, so they belong to the
one **M1** verb. `verify` re-judges what `resume` recorded and records nothing
itself; `status` likewise. Read this section's "Bootstrap invokes" as "`resume`
invokes": an implementation that reached for `--record` from `verify` because the
name fit would break the R0 guarantee §3 makes, and test #33 (§11.2) pins that it
does not. Note that test #8's byte-identical assertion covers **host config** only;
it would stay green while `verify` wrote a proof into the run's own directory, which
is exactly why #33 is a separate obligation rather than a corollary.

**The workflow-continuation proof needs a second input, and today it does not have
one.** It resolves engineer under `repoRoot/plugins/engineer/...` *before* creating
its temporary proof repository — so pointing it at an ephemeral scratch root does not
work: there is no `plugins/engineer` there. S8 MUST separate the two roots:

- an **installed-tool root** — where the engineer plugin actually lives (the host
  plugin cache), resolved the way `discover-engineer.mjs` already does it;
- a **proof workspace** — the ephemeral repository the proof runs *in*.

Without that split, the workflow proof is source-tree-only, and a *machine* bootstrap
that can only be verified inside one particular checkout is not a machine bootstrap.
The permission and deep-peer-smoke proofs already run against ephemeral temp repos and
need no change.

**Resolved (S8a1).** `runtime:doctor`'s workflow-continuation proof now resolves the
installed-tool root through a runtime-owned `resolveInstalledEngineerRoot` (env
override `AGENTIC_ENGINEER_ROOT` → Claude cache SemVer-max → Codex fixed cache →
sibling monorepo — a **private** copy of the discover-engineer.mjs ladder, since
ADR-0010 §5 forbids importing across plugins). It deliberately does **not** consult
`repoRoot`, so pointing doctor at an ephemeral scratch root now works; the proof
workspace remains the `mkdtemp` temp repo, and each executed direction reports
`installed_tool_root` + `tool_root_source` distinct from that workspace. Engineer
installed nowhere resolves to `null` and the direction is `blocked` with recovery
guidance, never a silent source-tree assumption.

### 8.3 One-host operators — a documented limitation, stated exactly

The reducer requires **both** hosts, because the framework's value is the cross-host
peer ensemble and `deep-peer-smoke` is the only evidence it works.

Be precise about what that means, because the obvious phrasing is wrong: the
`host.<peer>.present` / `.authenticated` / `marketplace.<peer>.registered` steps are
**not declinable** (§6.2), so a machine missing a host has `pending` steps and the
reducer returns **`incomplete`** — *not* `configured-not-verified`, which requires
every expected step to be resolved. A contract that promised
`configured-not-verified` here would contradict its own reducer.

So: a single-host machine reports **`incomplete`**, and bootstrap names the missing
host and prints its Stage 0 commands rather than looping on an unreachable gate.
There is no `--hosts` flag; both hosts are the contract.

**Trigger for revisiting**: a real single-host operator. A narrower single-host mode
would need its own proof story and its own declinable-set rules, and inventing them
before the demand exists is how unused modes get built. This is honest scope
(ADR-0001 §5), recorded rather than hidden.

---

## 9. Bundle membership

| Bundle | Plugins |
|---|---|
| `base` | `runtime`, `companions`, `attention` |
| `engineering` | `base` + `engineer`, `orchestrator` |
| `business` | `base` + `founder` |
| `design` | `base` + `designer`, `image` |
| `full` | all eight |
| `custom` | operator-enumerated via `--plugins`; MUST satisfy §9.1 |

Membership is mirrored by the packaged `plugin-set.json` (§1.4), which is the
machine-readable source of truth; §11 pins that the two agree.

### 9.1 Dependency closure — behavioral, and host-qualified

**No plugin manifest declares dependencies.** None of the eight
`.claude-plugin/plugin.json` files carries a dependency field. The relationships
below are **behavioral, established by code**, and this table is the first place
they are written down.

| Relationship | Kind | Hosts | Why |
|---|---|---|---|
| `orchestrator` → `engineer` | **hard** | both | `/orchestrator:next` resolves engineer through `discover-engineer.mjs` and exits `engineer plugin not found` **before any dispatch**. |
| `image` → `companions` | **hard** | **Claude only** | On **Codex** image generation is **native** (the in-session gpt-image tool). On **Claude** the only path is `codex-companion`. Host-qualified, not universal. |
| `engineer` / `orchestrator` / `founder` / `designer` → `companions` | **soft** | both | Ensemble dispatch degrades gracefully to local-only with a stderr warning. The persona still works — it loses the peer ensemble, which is its always-max core. |
| `attention` → `runtime` | **soft** | both | Attention resolves the runtime root through a copied `discover-runtime.mjs` ladder; with no runtime there is no pipeline to emit into, so the sensors are inert. |

Rules:

- A selection MUST satisfy every **hard** edge **for every host it targets**. A
  violating `custom` selection is **rejected** (exit 40), naming the missing plugin
  and the host.
- **Soft** edges are never rejected, but bootstrap MUST **warn**: a persona without
  `companions` is a materially degraded install; `attention` without `runtime` emits
  nothing.
- This is why `base` carries `companions`: every bundle above `base` has a persona.
- Declining a plugin re-runs this closure (§6.2).

Promoting these edges to a declared manifest field is **out of scope for S8** — it
would force a manifest-schema decision and a multi-package rollout under ADR-0016.
Recorded here as a follow-up, not a requirement.

---

## 10. Artifact family, locations, and filesystem policy

```
~/.agentic-plugins/runs/bootstrap/<run-id>/run.json       run manifest (§5)
~/.agentic-plugins/runs/bootstrap/<run-id>/fragments/     rendered host-config fragments
~/.agentic-plugins/runs/bootstrap/<run-id>/proof/         proof metadata (§8.2)
~/.agentic-plugins/runs/bootstrap/latest.json             pointer to the newest run
~/.agentic-plugins/profiles/<name>.json                   portable machine profile (§4)
```

**Machine-global, not repo-relative.** Authorized by
[ADR-0046](../../../docs/adr/0046-machine-bootstrap.md) §4 as an M1 *location*
extension — same ownership as the already-authorized user-global
`~/.agentic-plugins/config.toml`, no new effect class.

### 10.1 The existing inventory does not reach this home

`inspectRuntimeArtifactInventory` hardcodes `join(repoRoot, '.agentic-plugins',
'runs')`. **Registering `bootstrap` in `RUNTIME_ARTIFACT_FAMILIES` alone will not
inventory the machine-global home.** S8 MUST parameterize the inventory root and
extend [`artifact-policy.md`](artifact-policy.md), whose current scope is
repo-relative and gitignore-specific, with a machine-global section covering root,
security, pointer, inventory, and retention.

### 10.2 Filesystem policy (ADR-0035 §3 requires atomicity and recovery)

- Directories `0700`, files `0600`, where the platform supports it.
- **Atomic** temp-file + rename for every write.
- **Concurrency limit, stated honestly (ADR-0048 realization decision, owner-
  approved 2026-07-23).** The manifest writers serialize under the family lock,
  and resume's transactional order (persist → re-read authoritative bytes →
  reduce → manifest update) closes the single-session crash windows — but there
  is NO cross-process CAS over the evidence set: two resumes racing the same
  open run can interleave an evidence write between one another's read-back and
  manifest update, and each will persist a reduction over the bytes it saw.
  Full run-scoped locking/CAS is deliberately out of this slice's scope (it
  becomes materially riskier only once the egress executor gives a proof a
  network side effect — the trigger for a dedicated slice); until then, one
  resume at a time per machine is the operating assumption, and `abandon` +
  fresh `plan` is the recovery when concurrent resumes were run anyway.
- **Symlink refusal** and **canonical containment**: resolve the real path and
  assert it is under `~/.agentic-plugins/`. This is why `profile export --out` does
  not exist, and why `--name` is validated against a strict charset (no `/`, no
  `\`, no `..`, no leading `.`, no NUL).
- **`$HOME` is the current repository** (some devcontainers): **fail closed** with a
  diagnostic. The egress config's verified-ignored-local reader already establishes
  this fail-closed posture; bootstrap does not invent a softer one.
- **`$CODEX_HOME`** is honored wherever it is set; `~/.codex` is the default, not a
  hardcode.
- **A family-wide creation/index lock, not a per-run lock.** A per-run lock cannot
  serialize the thing that actually races: two processes each allocating a *different*
  run id and then both writing `latest.json`. The lock is taken on the `bootstrap/`
  family for run creation, open-run discovery, and `latest.json` writes. Profile
  writes take it too, so `--overwrite` cannot interleave with a concurrent read.
- **Stale locks are recoverable.** A lock whose owning pid is gone, or whose age
  exceeds a bound, is broken with a reported diagnostic — never silently, and never by
  the operator hand-deleting files.
- `latest.json` is written atomically; a corrupted or orphaned pointer is recovered by
  scanning run directories, and the recovery is reported.
- **Retention**: the last N runs (default 10) are kept; older run directories are
  reported as retention pressure, **never auto-deleted**. **Profiles are never
  auto-deleted.**
- **Concurrency**: a second `plan` while a run is open is rejected, naming the open
  run's id. The operator continues it (`resume --latest-open`) or closes it
  (`abandon`). Because a crashed run leaves an open run behind, `abandon` is not a
  convenience — without it, one interrupted run would block the machine permanently.

### 10.3 Rollback

Patch forward. Bootstrap **never** auto-deletes artifacts, auto-uninstalls plugins,
or reverses operator host-config edits. An H2 partial failure re-probes and resumes
the remaining actions (which the §1.5 write-ahead record makes possible). For
operator-applied fragments, bootstrap renders backup/verify/manual-revert guidance
alongside the apply command.

**Schema migration is patch-forward too (1.2, ADR-0048 §1).** Once a run has been
resumed under a newer runtime — its schema stamped to the newer minor, new
structural evidence recorded — an older runtime will refuse to resume it (§7
future-minor rule) and there is no downgrade path: the older reader cannot even
represent what the newer one recorded, and stripping it would be silent evidence
destruction. The recovery is the same as every other stuck run: `abandon` it and
start a fresh `plan` under whichever runtime the machine is staying on. This
section governs host edits and artifacts; it never promised schema downgrade,
and now says so.

---

## 11. Test obligations (S8)

The contract is worthless if nothing holds it. `settings-report-contract.md` is
cited by filename but **no test ever opens it**, so it can drift arbitrarily while
CI stays green. This contract follows [`footer-contract.md`](footer-contract.md),
which is asserted **by content** — and goes further, because content tokens prove a
file exists, not that its schemas agree with the code.

### 11.1 Executable agreement, not prose tokens

Ship the schemas as **data**, and test the data:

- `plugins/runtime/data/plugin-set.json` (§1.4) — bundles, hard/soft edges,
  hook-bearing, floors.
- JSON Schema for `agentic-machine-profile-1` and `runtime-bootstrap-run-1`.

Tests MUST validate **real artifacts** against those schemas, and MUST assert the
prose tables in §9 and §6 agree with `plugin-set.json` and the step registry. Prose
tokens (§11.3) remain as a floor, not as the enforcement.

### 11.2 `tests/runtime/test-bootstrap.mjs`

**1.2 additions (ADR-0048, realized by the bootstrap-contract-vnext slice).** The
following obligations join the pins below, spread across
`test-bootstrap.mjs` / `test-bootstrap-cli.mjs` / `test-completion-reducer.mjs` /
`test-machine-profile.mjs` / `test-step-registry.mjs`:

- **False-demotion regression**: a passed proof stays `passed` across repeated
  verify/resume — re-judgement reads the RECORDED proof/ files back, never the
  reduced completion cache (mutation-verified: restoring the cache read turns
  the test red).
- **Writer gates**: proof validation is mandatory and internal (no injectable
  validator to forget); unknown evidence kind, kind-discriminator violations,
  terminal-run writes (except the D0.1 receipt into a completed run — and never
  into an abandoned one) are each refused.
- **Read boundaries**: a schema-invalid manifest cannot prove itself terminal
  (scan), cannot be selected for reduction (selectRun), cannot be updated
  (previous-invalid), and CAN still be abandoned into a valid tombstone.
- **Duplicate evidence**: rejected at the read boundary all-or-nothing, and the
  reducer caps at `incomplete` independent of requiredness.
- **Receipt lifecycle**: attest refuses no-ack / abandoned / legacy-schema; a
  recorded receipt re-judges attested/stale on ack drift, file replacement, and
  attempt mismatch; `delivery-attested` renders without redefining `complete`.
- **Migration**: an open 1.1 run resumes into a 1.2 stamp + history row +
  injected registry-new steps + rendered fragments; a terminal 1.1 run answers
  exit 50 with `historical`/`not_recertified` and stays byte-identical; a
  future-minor run refuses resume.
- **Answers**: effective-action last-wins (execute-then-decline does not
  execute); `attest-receipt` is refused under plan and against any other step.
- **Profile 1.1**: every legal 1.0 document validates; a 1.1 `statusline_preset`
  under a 1.0-era reader warns-and-ignores (and the warning SURFACES); the
  canonical hash keeps the trailing-scalar alignment; the write gate refuses a
  non-`TELEGRAM_BOT_TOKEN` name while the schema stays additive (D0.4).

1. **Seam** — bootstrap never calls `inspectCatalogs` / `inspectSourcePluginState`.
   Assert at the **seam** (injected-call spy, or a poisoned catalog whose content
   would visibly corrupt the output if read), not by filtering output. An
   output-only assertion cannot distinguish "did not read" from "read and filtered".
2. **Consumer-repo correctness** — invoked from a temp repo that is not the source
   tree, bootstrap emits **zero** remediations referencing
   `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, or
   `./plugins/<name>`.
3. **`runSettings` consumer-repo regression** (separate from bootstrap) — the
   sixteen false catalog remediations are gone **and** stale-update detection works
   outside the source tree.
4. **Profile round-trip** — export → seed reproduces every enumerated field with its
   `scope` and `provenance` intact.
5. **User-global-only export** — a repo config supplying model/effort/notify/
   permission values does **not** appear in the exported profile (§4.4).
6. **Secret fail-close** — a token-shaped value refuses the write; any
   `boundary.writes_* === true` refuses the write.
7. **Loader isolation** — statically, no activation or config loader reads the
   profile path.
8. **No host-config write** — after `plan` + `seed` + `verify`,
   `~/.claude/settings.json`, `~/.codex/config.toml`, and
   `~/.agentic-plugins/config.local.toml` are **byte-identical**. (Pattern:
   `tests/runtime/test-permission-acceptance.mjs`.)
9. **No executor** — `plan` never invokes a plugin-management command.
10. **Write-ahead** — kill the runner after the first H2 action; the durable record
    already names the action. (Today it would not.)
11. **False-pass pins** — a missing plugin, a `blocked` plugin-management step, an
    **omitted expected step**, and an `unknown` marketplace state each fail to reach
    `complete`.
12. **Illegal decline** — declining `companions` while retaining `image` on Claude is
    rejected; declining a host CLI step is rejected.
13. **Freshness invalidation** — a recorded `satisfied` step with a stale version set
    is re-probed, not trusted.
14. **Proof semantics** — an otherwise-complete machine with no passing
    `deep-peer-smoke` reports `configured-not-verified`; a proof bound to older
    versions reports `stale`; `workflow-continuation` is `not-applicable` with no
    engineer.
15. **Per-host divergence** — different plugin versions on Claude and Codex are both
    represented and neither is collapsed.
16. **Path security** — `--name ../../x`, a symlinked profile target, and `$HOME`
    equal to the repo root are each rejected.
17. **Concurrency** — a second `plan` with a run open is rejected; a corrupted
    `latest.json` is recovered.
18. **Schema migration** — an unknown profile major is rejected with a diagnostic; an
    additive minor is accepted.
19. **Bundle closure** — a `custom` selection omitting a hard dependency is rejected,
    naming the plugin and the host.
20. **Catalog consistency** (source-tree only) — `plugin-set.json` matches both
    marketplace catalogs.
21. **Released-package execution** — the installed plugin runs from a consumer repo.
22. **Wrong-direction proof** — a smoke that passed `claude→codex` but failed
    `codex→claude` is **not** a passing proof.
23. **Plugin-version proof drift** — a proof bound to an older `companions` version is
    `stale` after an upgrade.
24. **Hook-attestation handoff** — the attestation is carried with its bound versions
    and goes `stale` on a Codex upgrade.
25. **Plan-hash refusal** — the executor refuses a plan whose hash diverged from the
    one bootstrap presented.
26. **Cleanup write-ahead interruption** — the retired-plugin cleanup executor, killed
    mid-action, leaves a durable record naming what landed.
27. **Nonterminal settings-reader behavior** — doctor treats a `planned` /
    `in-progress` execution record as **not available**, never as a success. (Today a
    zero-failure record reads as available; this is the pin that stops write-ahead from
    becoming a false-success bug.)
28. **Family-lock race** — two concurrent `plan` invocations do not both create a run,
    and `latest.json` is never orphaned. A stale lock is broken with a diagnostic.
29. **Abandonment** — a crashed open run is closable with `abandon`, and a new `plan`
    then succeeds.
30. **Profile overwrite** — writing an existing profile name without `--overwrite` is
    refused.
31. **Claude has no disabled state** — `plugin.<name>.claude.installed` never expects an
    `enabled` field that Claude does not report; only Codex carries `disabled`.
32. **Machine-global inventory + retention** — the `bootstrap` family is inventoried at
    the machine-global home (not the repo home) and retention pressure is reported
    without deletion.
33. **R0 verbs write nothing at all** (§3 errata) — with a run open, `status` and
    `verify` each leave the **entire artifact home** byte-identical: the run
    manifest, `latest.json`, the `proof/` directory, and the family lock file. Assert
    over a recursive digest of `~/.agentic-plugins/`, not over host config — test #8
    would stay green while `verify` recorded a proof into the run's own directory.
    Includes the negative half: `verify` against a run with no recorded proof reports
    that proof `absent` and exits `10`; it never invokes `runtime:doctor --record` to
    manufacture one. Assert the non-invocation at the **seam** (injected runner spy),
    per #1 — an output-only check cannot distinguish "did not record" from "recorded
    and did not print".
34. **`--answers` is refused off the interview verbs** (§3 errata) — `--answers` on
    `status` / `verify` / `abandon` / `profile export` / `profile seed` exits `40`
    rather than being silently ignored, and an answers file naming a `step_id` that
    is not an expected step of the run exits `40` rather than recording it.

### 11.3 `tests/plugin-shape/test-runtime-plugin.mjs`

Assert this document contains at minimum: `Machine Bootstrap Contract`,
`runtime:bootstrap`, `scripts/bootstrap.mjs`, `agentic-machine-profile-1`,
`runtime-bootstrap-run-1`, `configured-not-verified`,
`never an input to any activation or config loader`, `Stage 0`, `probeMachineHostState`,
`/artifact-only/i`, `/machine-scoped/i`, `/write-ahead/i`.

Also assert `README.md`'s Stage 0 block and §2's Stage 0 block carry the same
commands.

---

## 12. Non-goals

- **Closing Stage 0.** Manual until ADR-0006 is superseded (§2).
- **Writing host config.** Never, under any flag. ADR-0041 §2c is not negotiable.
- **A new plugin-management executor.** Bootstrap presents; `runtime:settings
  --execute-plugin-management` executes (§1).
- **Proving Codex `/hooks` trust.** Runtime cannot query it non-interactively; an
  attestation records an operator claim, not host truth (ADR-0030).
- **Installing host CLIs.** Recommended, never executed.
- **Single-host mode.** Documented limitation with a named trigger (§8.3).
- **Declared manifest dependencies.** Recorded as a follow-up (§9.1), not S8 work.
- **Repo-scoped setup.** Repository overlays are reported, never managed.
- **A cross-machine sync service.** The profile is a file the operator carries. No
  daemon, no fetch, no push.
- **Promoting the profile to config.** A *trusted* machine config would be a
  different artifact with a different ADR — not this one relaxed.

---

## 13. Open items — scoped to the S8 core/schema subtask

These are **specification work, not open decisions**. The policy, the shape, and the
constraints are fixed above; what remains is filling in exact values inside those
constraints. They are enumerated so S8 does not have to rediscover them, and so that
nobody mistakes "the contract did not say" for "the contract left it open".

| Item | Constrained by |
|---|---|
| Exact JSON Schema files for `agentic-machine-profile-1.1` (1.0 + trailing `statusline_preset` scalar, ADR-0048 §2.1), `runtime-bootstrap-run-1.2` (1.1 + the egress evidence vocabulary, ADR-0048 §3), `runtime-plugin-set-1.0` | §4, §5, §1.4 — including the closed-schema rule, the caps, and the canonical key order. Ship as data (§11.1); S8a2 C4. |
| ~~Exact permission-mode enums per host~~ | **Resolved (S8a2 C0).** The **stored** enum carries whatever each host accepts, unsafe values included, because §4.5.3 shows a source machine's value as a labelled note — it must have a field to live in. Safety grading is a **present/seed-side** rule, not a second schema field: never *present* Claude `bypassPermissions`, Codex `approval_policy = "never"`, or `sandbox_mode = "danger-full-access"` as a default. Presentable Claude `defaultMode`: `default` / `acceptEdits` / `plan`. Presentable Codex `approval_policy`: `untrusted` / `on-request` / `on-failure`; `sandbox_mode`: `read-only` / `workspace-write`. |
| The complete `minimum_version` floor table | §1.4 — two are known (`companions` 0.3.0, `engineer` 0.7.0); S8a2 C1 verifies the rest against the plugins' own changelogs. Compare **prerelease-aware** with SemVer §11 identifier ranking (numeric identifiers as JS numbers, lossy only above 2^53; beyond the shared `semverCompare`, whose prerelease tie-break ranks a release above its own prereleases but never identifiers against each other); an unknown installed version with a non-null floor stays **unresolved**, never "installed". |
| ~~The write-ahead journal's exact transition table and the settings-artifact schema minor~~ | **Resolved (S8a1)** — §1.5 "Concrete shape" specifies the fields; artifact schema is `runtime-settings-execution-artifact-1.3` (S8a4 added the `codex_hook_review` canonical `bound_versions`/`attested_plugins`), statuses `planned → in-progress → completed/failed/refused` |
| ~~The `probeMachineHostState()` return schema~~ | **Resolved (S8a2 C0)** — §5 `probe.hosts.<h>` pins the serialization: `cli_version`, `auth` enum (`available` / `unauthenticated` / `unknown` / `sandbox_limited`), `marketplace`, and the per-host nested `plugins` map. |
| ~~Codex `plugin marketplace list` output parsing (it is not JSON today)~~ | **Resolved (S8a2 C0)** — parse the human-readable output to the marketplace **source identity**; the step is `satisfied` only on `{ source: "github", repo: "each4all/agentic-plugins" }`, a `directory`/`local` source is accepted-but-flagged, and a parse failure or absent subcommand is `unknown`, never `satisfied` (§1.2). The parse *implementation* is S8a2 C2; the rule is fixed here. |
| ~~Stale-lock age bound and retention `N`~~ | **Resolved (S8a2 C0)** — retention `N` = **10** runs; a lock is stale when its owning pid is gone (`kill(pid, 0)` → `ESRCH`; `EPERM` means it exists) **or** its age exceeds **10 minutes**, broken only after an owner-token recheck (never check-then-unlink) and with a reported diagnostic (§10.2). |

Two contract **corrections** landed with S8a2 C0 (they were errors, not open items — recorded so the change is auditable):
- **`hook_bearing`** (§1.4, §6.1): derived from *effective* registration (manifest hook path **or** root `hooks/hooks.json`), so `engineer`/`orchestrator`/`founder`/`designer` are hook-bearing on **both** hosts; `hooks.codex.attested` is **applicable** for every persona bundle; and Stage 7 keys off the **codex** value (an earlier "keys off the Claude value" was host-flipped).
- **Reducer §8**: partitioned CONFIG (Stage 1–7) from PROOF (Stage 8) so `configured-not-verified` is reachable — the prior single "every expected step resolved" clause made it unreachable (test #14 impossible), since proof steps are themselves expected steps.

Two further contract **corrections** landed with S8b (again errors, not open items —
both were found by writing the public surface against this text and discovering it
did not say what the implementation had to do):

- **§3 grammar — `--answers`**: the prose mandated the answers file as the *only*
  route for interview answers, but the grammar block listed it on **no verb at
  all**, so the normative shape of the surface disagreed with the normative rule
  three paragraphs below it. It is now on `plan` and `resume` — the two interview
  verbs — and explicitly on no other, with the seed-vs-answers distinction and the
  unexpected-`step_id` rejection stated rather than left to be inferred.
- **§3 / §8.2 — which verb records a proof**: §3 declared `status`/`verify` **R0**
  and §8.2 mandated a `runtime:doctor --record` invocation plus a metadata copy
  without naming the verb that performs them. Since "verify" is the verb whose name
  fits, the two sections contradicted: the natural implementation would have made
  the R0 claim false on its first release. Proof **production** is now `resume`
  (M1) exclusively; `verify` **judges** recorded evidence and reports `absent`
  rather than manufacturing it.

Three further corrections landed with the S8b public surface itself (the same
pattern: found by implementing against the text):

- **§1 — "never performs a network request"** now carries the qualifier the
  Stage-8 delegation always implied: bootstrap's own process and artifacts are
  network-free, while the doctor executors it presents (and, under `resume`, an
  explicit `execute` answer invokes) run networked host agents. Without the
  qualifier the sentence contradicted §8.2 on its first live proof.
- **§3 — the answer vocabulary** (`decline` / `accept` / `execute`, last-wins
  duplicates, closure re-run on plugin decline) is now normative. The answers
  file's shape was specified; its values were left to be invented, which is
  exactly what §13's closing rule exists to prevent.
- **§3 — run terminalization** is now explicit and asymmetric: `complete`
  closes; `configured-not-verified` closes only on an all-required-proofs
  declined run; everything else stays `open` so `resume` can still produce the
  missing proofs. The naive "copy the reduction into `status`" implementation
  closed the run at the exact moment Stage 8 became reachable, making the
  proofs unreachable instead.

One S8b scope note, recorded rather than absorbed (§1.6): the presented
`--expected-plan-hash` seals `runtime:settings`' **machine-wide** plan — every
plugin it manages plus cleanup actions — not a selection-scoped subset;
bootstrap therefore surfaces settings' own action summary alongside its
selection view. A selection-scoped executor would need a settings-side plan
filter; that is settings work with its own regression, not bootstrap glue.

Anything **not** on this list, and not decided above, is a gap in this contract —
report it rather than inventing a policy.
