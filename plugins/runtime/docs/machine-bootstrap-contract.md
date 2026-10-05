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
`PLUGIN_ROOT/docs/…` (precedent at the time: `scripts/compat.mjs` reading
`docs/host-parity-baseline.md`, both since removed) but cannot read `repoRoot/docs/…` (anti-pattern at the time:
`scripts/cutover-audit.mjs`, since removed). The ADR is for humans in the source tree; this
contract is for the tool on the operator's machine.

> **Amended 2026-08-10 by [ADR-0051](../../../docs/adr/0051-host-parity-baseline-source.md)**:
> the paragraph above was an *illustration* of why this contract ships inside
> the package. For **baseline-class assets** — packaged documents a runtime
> command reads to reach a verdict — it is now **normative**: the packaged copy
> is the sole authority, and the repository copy is what gets reviewed and
> released, never a runtime read. Two corollaries follow. A change to such an
> asset obliges a runtime release, because a version-keyed updater cannot see
> content that moved under an unchanged version — measured 2026-08-09, two
> installs of runtime `0.89.0` carried different host-parity baselines for
> exactly that reason. And a reader must record content-identifying provenance,
> because `PLUGIN_ROOT` can itself be a development checkout, so the label
> "packaged" does not by itself say which bytes were read.
>
> Repository-reading scripts that are **not** runtime commands are unaffected:
> `scripts/check-host-version-drift.mjs` is CI operating on the source tree and
> keeps reading `repoRoot`, while importing the shared parser so the grammar
> stays single-sourced.

> **2026-09-28 — [ADR-0060](../../../docs/adr/0060-remove-host-version-tracking.md)**
> removed the host-parity baseline, `scripts/compat.mjs` and
> `scripts/check-host-version-drift.mjs`. The amendment above is kept as written;
> its baseline-class rule still governs the assets that remain in that class,
> `data/plugin-set.json` and `data/schemas/**`.

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
consensus runs, and model/effort overlays (and, until ADR-0060 removed them, compat
runs and baseline data). Calling it
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

### 1.3 Planner composition requires purity — extractions, not lifts

> **ADR-0057 (2026-08-28)** removed the permission planner and its host-config
> reader, so this section is **four** extractions rather than the five it shipped
> with. The composition rule itself is unchanged and still governs the survivors.
>
> **ADR-0064 Decision 3 (2026-10-04)** removed the fourth, the Codex config TOML
> parse (`parseCodexPermissionConfigToml` and the user-global-only permission
> readers), with the portable machine profile that was its last consumer. Three
> extractions remain.
>
> **ADR-0064 Decision 1 (2026-10-05, slice R4n1)** removed the notification and
> egress-launcher planners from bootstrap: it no longer imports
> `lib/notification-plan.mjs` or `lib/egress-launcher-plan.mjs` and renders neither
> plan. One extraction remains, the plugin-management plan half; the rule below
> still governs it.

The existing planners **combine computation with unconditional repo-relative
persistence**, so bootstrap cannot compose them as they stand without writing
artifacts into whichever consumer repository invoked it. Each MUST be split into a
**pure build/render** function and a **separate persist** call whose target is
injected:

| Planner | Today | Required |
|---|---|---|
| plugin-management **plan half** | private to `scripts/settings.mjs`; also classifies recommendations it does not compute | lift to `lib/`, separated from the execute half, fed by §1.4 |

Bootstrap persists **only** under its machine-global run (§10).

**Resolved (S8a1 → S8a3).** Every row was extracted; the *Today* column above
records the pre-extraction state, not the tree. Where the planner lives now:

| Planner | Gather | Pure build | Injected persist |
|---|---|---|---|
| plugin-management plan half | `lib/plugin-management-plan.mjs` | — | — (execute half stays in `scripts/settings.mjs`) |

Two S8a3 findings, kept as the rule's rationale. The builders they were measured
on are gone: the permission planner (ADR-0057, 2026-08-28) and the notification
and egress-launcher builders (ADR-0064 Decision 1, deleted in slice R4n2,
2026-10-05):

1. **No pure build takes a `repoRoot`.** The point is capability, not referential
   purity: a builder that accepts a repo root can grow a repo-relative read later. The
   permission planner passed a Codex trust target inside `gathered` as an explicit
   `{ applicable, path }` pair. A caller with no project context set
   `applicable: false` and got no `[projects]` entry — passing a null path instead
   rendered a `[projects."null"]` header, because the TOML renderer stringified
   whatever it received.
2. **Purity is a property of the build FUNCTION, not of the import graph.** These
   closures legitimately contain filesystem modules — the usage learner reads records
   synchronously, and `version.mjs` reads manifests at module initialization. The
   promise a caller may rely on is: synchronous, deterministic for identical
   `gathered` + injected clock/run-id, writes nothing, holds no repository capability,
   and never reaches `doctor.mjs`. `tests/runtime/test-planner-purity.mjs` pinned this
   for the notification and egress-launcher builders until ADR-0064 removed them; it
   now pins only the §1.1 import closure of `statusline-plan.mjs`.

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
job. Currentness is reported — `current` / `stale` /
`unknown`, with the catalog's own `lastUpdated` shown so the operator can see
whether the *catalog* is stale — and it never blocks a terminal state. Where the
host cannot answer (Codex), it is `unknown`, and `unknown` currentness is not a
failure.

*Amended 2026-09-25 ([ADR-0061](../../../docs/adr/0061-codex-installs-pinned-to-release-commits.md)
§Decision 4, implementation step S3):* the Codex half of that sentence holds until
the Codex catalog is pinned. Before ADR-0061's activation every Codex entry is a
`local` path, the catalog is still versionless, and Codex currentness stays
`unknown`. After it, each entry pins its release in `source.ref` / `source.sha`, and
runtime reports three facts per Codex plugin: the catalog target, the installed
version (list-authoritative, else the manifest-verified cache), and whether the
installed files were verified against the tree at the pinned commit. Currentness is
then `current`, `behind`, `ahead`, `content-mismatch`, `content-unverified`,
`not-installed` or `unknown`, and a matching version whose files were not verified is
never `current`. An entry that carries no pin leaves currentness `unknown`, and a
malformed pin is reported as an error; neither is ever answered from the
repository's or the marketplace clone's manifest. Currentness is
still advisory and still never a completion gate. `runtime:settings` turns a `behind`
or `content-mismatch` Codex install into a manual repair follow-up rather than an
executable marketplace upgrade, because an upgrade that finds no new marketplace
revision reinstalls nothing (ADR-0061 §Decision 7).

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
| 5 | operator observability — the statusline steps (ADR-0048 §1; ADR-0064 Decision 6 removed the notification and egress steps; the number is kept and nothing is renumbered) | operator applies the rendered fragments |
| 6 | *(empty — ADR-0057 removed the permission-posture stage with the advisor that rendered its fragments. The NUMBER is deliberately not reused and stages 7 and 8 are not renumbered: retained run manifests carry stage-6 rows, and renumbering would invalidate every one of them.)* | — |
| 7 | Codex `/hooks` review + trust | operator (interactive TUI), then attestation |
| 8 | execution proof (§8) | `runtime:doctor --execute-*` |

---

## 3. Command grammar

```
runtime:bootstrap plan     [--bundle <id>] [--plugins <csv>] [--answers <path>]
                           [--format text|json]
runtime:bootstrap status   [--run-id <id> | --latest | --latest-open] [--format text|json]
runtime:bootstrap resume   [--run-id <id> | --latest-open] [--answers <path>]
                           [--format text|json]
runtime:bootstrap verify   [--run-id <id> | --latest] [--format text|json]
runtime:bootstrap abandon  (--run-id <id> | --latest-open) [--reason <text>]
```

> **2026-10-04 — [ADR-0064](../../../docs/adr/0064-runtime-surface-reduction.md)
> Decision 3** removed the `profile export` and `profile seed` verbs and
> `plan --profile-file`, with the portable machine profile they wrote and read
> (§4). `profile` is now an unknown verb and `--profile-file` an unknown flag;
> both exit `40` like any other grammar error.

> **2026-10-05 — [ADR-0064](../../../docs/adr/0064-runtime-surface-reduction.md)
> Decisions 1 and 6 (slice R4n1)** removed bootstrap's notification and egress
> surface. The `attest` verb and the `attest-receipt` answer are gone (an unknown
> verb exits `40` with `expected: plan | status | resume | verify | abandon`). The
> Stage-4 `config.notify_kinds` step, the Stage-5 `notify.configured`,
> `notify.codex.configured` and `egress.configured` steps and the Stage-8
> `proof.egress-provider-ack` proof are gone, with their fragments, judges and
> readers, the egress delivery proof, the receipt attestation, the opt-in-proof
> warning and the ADR-0047 dual-kind warning. Probes, the settings dry-run and
> the doctor fetch now receive the caller's environment unchanged: bootstrap no
> longer scrubs an egress credential, because it no longer names one. The run
> schema is `runtime-bootstrap-run-1.5` and the `--format json` report is
> `runtime-bootstrap-report-3.0`. Runs recorded before the removal are read as
> §7 ("Runs of an earlier minor") states.

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
- **There is no post-terminal door.** `attest` recorded the owner's phone-receipt
  testimony into a run that a successful egress proof had already terminalized.
  ADR-0064 removed it with the egress proof it testified about: the proof writer
  refuses **every** write into a run that is not `open` (reason `run-not-open`).
  A stored receipt verdict in a retained run is history (§7).
- `abandon` closes an open run (`status: abandoned`) so a new `plan` can start. A
  crashed or unwanted run MUST be recoverable without hand-editing the artifact
  home — otherwise one interrupted run blocks the machine forever. `abandon` never
  reverses anything the operator already applied (§10.3).
- `--format json` is a complete, non-conversational rendering. **Deterministic**
  means: given the same probe result and the same run, the JSON is byte-identical
  except for the fields explicitly marked volatile (`run_id`, `started_at`,
  `updated_at`, `probed_at`). The interview is never required to reach a plan.
- **Stage-8 presentation is single-sourced.** The text rendering prints each
  presented proof **exactly once**, from `completion.proofs[]` — the evidence
  authority (§8) — and never a second time from the generic unresolved-step
  presentation, which is CONFIG-only. *Presented* means `required`, plus any
  proof the operator explicitly `declined` (a decline is a recorded decision and
  must not vanish because the selection stopped requiring the proof). Control
  state joins the row only where it says something the verdict cannot and the
  operator can act on — an unreachable execution path — as a labelled
  `execution:` line. A JSON consumer reads the same division: `completion.proofs[]`
  is the evidence verdict, `steps[]` is control/interview state, and neither
  restates the other's STATUS (§5). `completion.proofs[].declined` is the one
  field deliberately copied across the boundary — the reducer reads the control
  row's decline so the verdict can carry it.

  **Every free-text field reaching a rendered line is structurally neutralized
  first** — proof `reasons`, step `observed` / `recovery` / `apply_command` /
  `fragment_pointer`, warnings, diagnostics, Stage-0 text, and the
  plugin-management command. Neutralized means: every character that could end a
  line, move a terminal cursor, or reorder the display (C0, DEL, C1 — U+009B is
  CSI — the Unicode line/paragraph separators, and the BiDi marks, overrides and
  isolates) becomes a space. It does NOT mean redacted or whitespace-squeezed:
  the rendered text is runtime-authored or the operator's own file, §5's
  sanitize discipline already keeps secrets out of artifacts, and both
  transforms provably destroy real payloads — the plugin-management handoff
  carries a **64-hex plan hash** the executor matches exactly, an operator path
  may contain an email-shaped component or two consecutive spaces, and a SemVer
  build identifier may be long hex. Reason-bearing rows are additionally
  **length-bounded and fairly apportioned**, because `reasons` is schema-bounded
  by LENGTH only (64 entries × 512 chars) and by nothing else. The rule is one
  reason PER LINE under a renderer-authored label, each line independently
  bounded, the block bounded as a whole, and any remainder declared on its own
  `<label>-omitted:` line with a count — so no reason can spend another's budget
  and no omission is silent. It applies to both reason arrays on `completion`,
  the Stage-8 proofs and the Codex `/hooks` attestation. (A third, the egress
  receipt attestation's, went with that verdict in ADR-0064 R4n1, 2026-10-05.)
  It also applied to the `profile seed` proposal and note rows until that verb
  was removed (ADR-0064 Decision 3, 2026-10-04).
  The omission marker carries a DIFFERENT label from the reasons themselves;
  sharing one let a reason forge a count the renderer never made. Truncation
  cuts on a **grapheme cluster** boundary (UAX #29 via `Intl.Segmenter`), not a
  code-unit or combining-mark one: a split cluster corrupts nothing visibly and
  instead presents a different character as the recorded one. A cluster wider
  than the whole budget yields the ellipsis alone rather than a prefix of
  itself. The Stage-8 `execution:` line remains length-bounded on the old terms.
  The CONFIG rows are NOT bounded:
  operator guidance there is judge-authored, finite, and rendered whole, since
  cutting a runbook mid-sentence trades one dishonesty for another. The bounded
  `execution:` line is the one place a judge-authored recovery is capped, and it
  is capped because it shares a row with attacker-length evidence.

  The guarantee covers the **error and usage paths** too: an argument-parse
  failure interpolates the offending argument, so its rendered form is
  neutralized the same way. The JSON `error` field keeps the raw text — a JSON
  string escapes control characters, so there is no row to forge there, and a
  machine consumer needs the value it actually received.

  **Exactly one row per proof KIND.** The reducer already rejects duplicate
  evidence rather than choosing between records (§8), but a historical
  completion is never re-reduced and `proofs[]` is not unique-by-kind in the
  schema. A duplicated kind therefore renders ONE row naming the conflict and
  showing no verdict — never two rows the operator must choose between. The
  historical projection (§3.2) applies the same rule at projection time, so the
  de-duplication holds in `--format json` and not only on the rendered line.
- There is **no `--out`** on any verb: writes are constrained to the authorized
  home (§10).
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
  interview. An answer whose `step_id` is not an expected step of the run is rejected (exit
  `40`) rather than recorded, so a stale answers file cannot smuggle a step into a
  manifest the registry never derived (§6.1). The answer vocabulary is exactly
  three values (S8b errata fixed the shape-without-values gap; ADR-0048 §3 added
  a fourth, `attest-receipt`, that ADR-0064 R4n1 removed again):
  **`decline`** marks a declinable step declined (a non-declinable
  target is exit `40`, and a plugin decline re-runs the §9.1 closure over the
  retained set); **`accept`** records the operator's go-ahead without changing
  step state (steps are promoted only by post-probes, §6); **`execute`** — valid
  against `proof.*` steps only, a non-proof target being exit `40` because no
  executor could ever reach it — is the explicit approval that lets `resume` run
  that proof through `runtime:doctor --record`. Under `plan` an `execute` is
  exit `40` for **every** proof step — `resume` builds its execute set from its
  OWN answers file, so a plan-time approval would be recorded and never
  consumed. (Until ADR-0064 R4n1 one proof, the egress ack, was exempt because
  any answer against it was the opt-in the reducer read.) Duplicate answers for one step apply in
  file order and every one is recorded in `choices[]`, keeping the run
  replayable from its own manifest — and consumers read the per-step
  **EFFECTIVE** action (the last one), never the raw rows: the raw-filter
  shape executed an `execute` a later row had declined (ADR-0048 §3 repair).
  **Applicability is part of the grammar, asymmetrically.** An `accept` or
  `execute` against a step this run's selection does not apply is exit `40`: it
  leaves `declined: false`, so the §11.2 presentation filter (`required ||
  declined`) shows nothing and no verb acts on it — the operator's action would
  be absorbed and then invisible. A **`decline`** against that same step stays
  legal, because it is the one answer that IS surfaced (`not-applicable
  (declined)`); refusing the whole status would delete a
  contract-visible path in order to close an invisible one. The rule reads the DERIVED
  expectation, never the judged status: the judge writes `not-applicable` and
  then restores a prior `declined` over it for any declinable step, so a proof
  declined earlier and since made non-applicable reads `declined` and would slip
  past a status test — and did, with the executor running for a step the reducer
  simultaneously reported `required: false, status: not-applicable`. Because the rule now refuses rather than merely filters, that
  expectation must reflect what THIS verb observed. (Before ADR-0057 the
  re-derivation also covered `permission.<host>.applied` promoting to
  `fragment_applied`; with Stage 6 gone the effective selection is the only
  judgement input that can still move mid-judgement.)
  The **same rule is asked twice**, because one boundary cannot cover both
  moments. `resume`'s proof executor re-asks it against the post-narrowing
  judgement: a decline earlier in the same answers file can narrow the selection
  (§6.2) until a proof approved later in that same file no longer applies. Both
  answers were legal when given, so this is not a refusal — the executor skips
  the proof, warns, and leaves the choice recorded in `choices[]`.
- **The VALUE answer (§3.3).** One Stage-4 step (§6.1.3, `config.session`) needs
  the operator to CHOOSE a value, not merely to approve or refuse a step, so the
  vocabulary has a fourth form beside the three bare answers:

      set:<key>=<value|unset>[;<key>=<value|unset>]...

  `;` separates pairs and `=` separates key from value. (The separator is not a
  comma because the step that once took a comma-separated value, `notify_kinds`,
  needed one; ADR-0064 R4n1 removed that step and the separator stayed.)
  `unset` means "leave this key UNWRITTEN; the shipped default stands,
  **deliberately**" — a recorded decision, not an absence (§6.1.3).

  **It is ONE atomic string, and a sibling `choices[].value` field is
  forbidden.** §4.6 forgives an unknown *scalar* key when a document declares a
  newer minor, so a 1.2 reader meeting such a field would emit
  `unknown-scalar-key-ignored`, drop the value, and read `answer: "accept"` as a
  bare accept — a ledger saying the operator approved something without saying
  what. The prefix form fails an older runtime's closed-set check outright, so it
  REFUSES (exit `40`) rather than misreading. Loud beats lossy.

  **Parsing is ATOMIC**: any defect — a duplicate key, an unknown key, a missing
  `=`, an empty member, an invalid value, an over-long payload — rejects the
  whole row. A payload is order-independent by design, so accepting the good
  members of `entry_brief=off;entry_brief=startup` would make the result depend
  on member order, which is the property the `key=value` shape exists to remove.

  **Grammar refusals are symmetric.** `set:` against a step that owns no config
  keys is exit `40` (it would be recorded and read by nothing), and `accept`
  against a value step is exit `40` — `accept` means "go ahead without changing
  step state", and a value step has nothing to go ahead with, so it would record
  an answer while leaving every key undecided. Comparison of a recorded value with
  the observed one is plain string equality.

  **The STANDING decision is folded from `choices[]`, never held in
  `steps[].desired`.** §7 clears `desired` on any version drift — for satisfied,
  manual-follow-up and pending rows alike — so a routine patch bump would
  silently discard the operator's choice. A drift invalidates observations and
  rendered plans; it never invalidates a decision, which is the same rule §7
  already applies to `declined`. The fold is: rows in file order, later rows
  winning; a later partial payload **merges per key** (a row naming one key does
  not un-decide the others — `decline` is the only way to un-decide, and it
  un-decides the whole step, visibly); a `decline` tombstones the accumulated
  decisions so a later `set:` starts from empty.

  **A `set:` row is honoured only on a value step AND only when the document's
  own schema minor is at least the minor that introduced that step.** The pre-1.3
  schema never constrained `answer` vocabulary, so arbitrary `set:...` text can
  already sit in a valid older manifest — and the step-id pattern it accepted is
  the SAME one, so `config.session` is nameable there too. The weaker rule
  ("value steps did not exist before 1.3, so no legacy row can name one") holds
  only for rows an older RUNTIME writes; a run file is operator-editable data,
  which is the entire premise of the registry-authority rule. An unreadable or
  absent minor fails closed. A malformed payload, and a row refused for
  provenance, are both reported as warnings on every verb that folds the ledger —
  never obeyed, never thrown (stored rows are not revalidated on write, so a fold
  that threw would strand the run), and never silently dropped: a step whose
  recorded answer this runtime declined to honour must not report "no decision is
  recorded" while `choices[]` visibly holds one.

  **A `set:` never satisfies a step by assertion.** The decision is recorded;
  the step resolves only when a post-probe OBSERVES the machine matching it
  (§6, §6.1.3's matrix). A `set:` over a standing decline lifts the decline
  before re-judgement — otherwise the judge would restore it and the reducer,
  which counts `declined` as resolved, could close the run with the new choice
  never applied. A `set:` that CHANGES the standing decision withdraws the
  rendered hand-off so the next render re-freezes against the new decision: the
  freeze protects against silent re-binding under the operator, and a new answer
  is the operator's own explicit act — the same exception §7 makes for drift.

  **Ledger capacity is a preflight, not a late failure.** `choices` and
  `history` are both capped at 256 and nothing prunes either, because the run is
  replayable from its own manifest. A value interview makes corrections ordinary,
  so `resume` refuses an over-cap write BEFORE executing any proof — otherwise a
  resume carrying both a value answer and an `execute` would run the executor
  (a real subprocess) and only then
  fail the manifest write, leaving the effect performed and unrecorded.

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
| 50 | `legacy-historical` — a TERMINAL run under an older schema minor: the stored record was **summarized** under the §3.2 disclosure invariant and **nothing was re-probed or re-certified** (ADR-0048 §1). Exit 0 would claim a current completion nobody re-proved, which is exactly the overclaim this code exists to prevent |
| 1 | unexpected error |

### 3.2 The report disclosure boundary (D1, ratified 2026-08-02)

**The invariant.** A value crosses the **artifact → report** boundary *iff* the
packaged schema **grammar-clamps** it — an anchored `pattern`, an `enum`, a
`const`, a boolean, or a number. Everything else leaves as its **TYPE**, its
**LENGTH**, or its **ORDINAL**, never as its content.

The report schema id is `runtime-bootstrap-report-3.0`. The major moved because
a key was **removed**, not renamed, twice: the historical path's `completion` key
(2.0), and the `attest` verb's report, the live
`completion.egress_receipt_attestation` and the `egress-provider-ack` proof rows
(3.0, ADR-0064 R4n1). The report is emitted per invocation and never read back,
so the bump has no host-pair skew. The historical projection of a retained run
keeps its egress proof row and its receipt verdict summary (§7).

*Why a classification rule and not a redaction one.* A sink sanitizer was built
for this boundary and withdrawn on measurement: a generic 32+-hex rule destroyed
a legitimate 64-hex plan hash, and `--format json` stayed exposed regardless.
The root is which values are *sayable*, not which substrings look dangerous.
Binding the answer to the schema's own grammar clamping makes the test
mechanical and auditable against the schema file, and self-maintaining — a new
clamped field becomes disclosable automatically, a new `maxLength`-only field is
withheld automatically, and neither needs anyone to remember a category list.
Grammar-clamped fields such as `sha256`, `stepId`, `timestamp`, `semver` and
`pluginName` therefore keep crossing; `reasons[]`, `artifact_pointer`,
`answer`, `reason` and `limits[]` are `maxLength`-only and do not.

*Threat model.* Moderate **accidental** disclosure. The operator (or a process
running as them) writes a secret into a private `0600` artifact; the report then
travels to terminal capture, CI logs, clipboards, machine consumers, or an
agent's context. This boundary protects that artifact → stdout transition. It
does **not** defend against an adversary who already owns the account — reading
the private artifact directly is the escape hatch, and it is deliberately a file
read rather than a `--verbatim` flag, which would be pasted into automation and
put the boundary back where it started.

**(a) A validation finding** MAY carry a runtime-authored code and severity; the
EXPECTED constraint read from the trusted packaged schema (type, enum members,
const, pattern source, bounds); the OBSERVED type name and numeric metadata
(string length, member count, byte size); and a locator built **only** from the
root `$`, schema-DECLARED property names, zero-based array indices, and a
zero-based `member[n]` ordinal standing in for any document-supplied key.

It MAY NOT carry any observed scalar value or serialized fragment; any
document-supplied key name; the document's own `schema` string (report that it
did not parse, plus the expected shape); raw `JSON.parse`/exception text that can
quote input; or a hash of a withheld value — that adds equality-and-guessing
leakage without helping repair.

A finding exists *because* the observed value escaped its clamp, which is why
the observed side is a type and never a value: the slot said `enum`, the document
supplied something else, so what arrived is by definition unclamped.

**Bounds.** At most 16 errors and 16 warnings per artifact; at most 32 findings
per command report, errors first, plus one fixed overflow marker; each finding
capped at 512 UTF-8 bytes; total counts and an `omitted` boolean carried
alongside. Validation continues **internally** past the display cap, so the
ok/not-ok verdict is computed from the full counts and a suppressed finding can
never change an answer. The flood this bounds is measured: a 62,969-byte
future-minor document with 4,000 unknown scalar keys produced 4,001 warnings /
643,305 characters (~10x amplification) before the caps existed. Input is itself
bounded at 128 KiB because an over-cap proof file is skipped rather than parsed,
so the flood was amplification, not unbounded input.

**(b) A legacy terminal run** emits `legacy_completion_summary` — a freshly
**built** object, never a spread of the stored one — carrying per proof `kind`,
`status`, `required`, `declined`, `step_id`, `artifact_hash`, `ran_at` and
`reason_count`; the completion `state` enum; unsatisfied and missing counts;
hook and receipt attestation `status` + `reason_count`; plus
`source.artifact_pointer` (runtime-**derived**, home-relative — not the stored
string) and `source.json_pointer: /completion`. The raw `completion` property is
not emitted, and the name differs so a consumer cannot mistake the summary for
the record. Text and `--format json` consume this same projected object, built
upstream of the format branch, so the two cannot diverge in the field set.

`{...completion, reasons: []}` is specifically wrong: `artifact_pointer` is a
second `maxLength`-only string in the same reduced proof, and a spread forwards
whatever else the stored object happens to carry.

**(c) Two sibling paths carry the same free content and follow the same rule.**
They are named because the invariant is about the boundary, not about the
validator that happens to sit on it:

- **Proof-directory entry names.** Whoever can write into `proof/` chooses the
  filename. `<kind>.json` for a known evidence kind is a name this runtime
  defined and may be quoted; every other entry is located by a zero-based
  `entry[n]` ordinal and described by the rule it broke, with the expected
  vocabulary named so the operator can rename the file.
- **Parser and serializer messages.** A `JSON.parse` `SyntaxError` embeds a
  snippet of its input *and carries no `code`*, so an `err?.code ?? err?.message`
  fallback resolves to the quoting message exactly when the document is the
  untrusted thing. Only the numeric **position** crosses. This applies to the
  untrusted-file flag, `--answers` (the only one since ADR-0064 Decision 3 removed
  `--profile-file` on 2026-10-04), and to the run manifest read. A
  `JSON.stringify` failure likewise names the document-supplied property that
  closes a circular structure, so its message is withheld entirely.

  The position must be read from the parser's **own trailing phrase**, anchored:
  V8 emits two message families and only one carries a position, so a loose
  `/position (\d+)/` also matches inside the *quoted snippet of the input*, and a
  file whose text begins `position 987654321` reports a position it forged for
  itself. It is also **not a byte offset** — the parser counts UTF-16 code units,
  so a document containing `é` puts the byte offset one ahead of the reported
  position. Name the coordinate system rather than converting.

  A test asserting "the secret is absent" from a parser message is a trap worth
  stating: V8 truncates its quotation at ten characters, so a fixture whose
  marker sits further in passes against the unfixed code. The regression fixtures
  put the marker in the first bytes for that reason.

- **Operator answers.** `--answers` is untrusted operator-authored input on the
  same boundary. A `step_id` that MATCHED an expected step is a registry id this
  runtime declared and keeps being named; a step id that did not match, and an
  `answer` outside the closed vocabulary, are unclamped by definition and are
  located by `answers[n]` instead. Both refusals still name what was expected —
  the ids this run does have, and the three legal answers — because withholding
  those would cost the operator the only actionable part of the message while
  buying no secrecy at all.

---

## 4. Schema versioning rules (the machine profile was removed)

> **Removed 2026-10-04 by [ADR-0064](../../../docs/adr/0064-runtime-surface-reduction.md)
> Decision 3.** This section specified the portable machine profile,
> `agentic-machine-profile-1` (last minor 1.3): a secrets-free snapshot of one
> machine's choices that `profile export` wrote under
> `~/.agentic-plugins/profiles/`, and that `profile seed` and
> `plan --profile-file` read back on another machine as interview defaults. The
> verbs, the schema, the profile home and the readers only the export used were
> removed together. Bootstrap still guides a new machine stage by stage; only the
> "copy this machine" shortcut went. Profile files already written stay where
> they are, and nothing reads, lists or retention-manages them any more.
>
> The subsections that described the profile were removed with it, and git
> history holds them: §4.0 (`notify_channel` is not an egress channel), the §4.1
> schema block and its profile-only rules, §4.2 (categorical exclusions), §4.3
> (write-side guards), §4.4 (user-global-only export), §4.5 (seed-side rules),
> and the "Profile 1.1" and "Profile 1.2" notes.
>
> Two parts were never the profile's alone. The schema rules in §4.1 and the
> migration rule in §4.6 govern every packaged schema, and they keep their
> numbers because code and this document cite them by those numbers. One rule
> also outlived its section: §4.4 required the export to read **user-global
> config only**, so that one checkout's policy never became another machine's
> default. The Stage-4 judges read the user layer for the same reason, and
> §6.1.3 states it, and the code comments that cited §4.4 for that rule cite
> §6.1.3.

### 4.1 Schema rules every packaged schema obeys

These rules are not properties of any one schema. `lib/schema-validate.mjs`
applies them to every schema the runtime ships under `data/schemas/`; in this
contract that is the run manifest (§5) and the plugin set (§1.4).

- **Closed schema, with one precisely-scoped exception.** Unknown **structural**
  keys (an object or an array value) fail validation at any depth, always.
  Unknown **scalar** keys fail too — *unless* the document's `schema` minor is
  **greater** than the reader's, in which case they are ignored with a warning.
  A same-or-older minor has no excuse for an unknown key, so it is rejected.
  This is the forward-compat posture engineer's state reader already uses, and
  it is why every schema string carries a **minor** (`-1.0`) rather than a bare
  major. The warnings from the ignored-scalar path surface in the consuming
  verb's report: an invisible warning is a forward-compat rule nobody exercises.
- **Canonical order** for serialization is the order in which the schema file
  declares `properties`; keys the schema does not name follow them, sorted.
  Values are canonicalized before hashing.
- **Bounded**: a document is capped at **64 KiB**, and an array longer than its
  `maxItems` is refused, not truncated — a silently truncated record is a
  corrupted one, not a convenience.
- **A closed keyword subset.** The validator implements exactly the keywords
  the packaged schemas use and rejects a schema that uses any other. It has no
  `oneOf`, so a rule a schema cannot express — such as the §5 proof-kind
  discriminator — is enforced in code.

### 4.6 Schema migration

`schema` carries **major.minor**. An **unknown major** is rejected with a diagnostic
naming the runtime version that understands it — never silently downgraded, never
partially read.

Minors are forward-compatible in exactly the way §4.1 states, and no other way: a
reader meeting a **greater** minor ignores unknown *scalar* additions and warns;
unknown *structural* keys still fail; a reader meeting a **same-or-older** minor
rejects any unknown key at all. Downgrade is never attempted.

**Stated limit.** The tolerance is for KEYS. It never forgives an unknown VALUE of
a known key, so a newer minor that widens an enum is refused outright by an older
reader — the whole document, not just the field. The minor still bumps, for
identity rather than tolerance: one `$id` must denote exactly one accepted
language, or a historical document can no longer be re-validated against the
schema that admitted it. Value-level newer-minor tolerance is tracked in
[`follow-ups.md`](follow-ups.md).

---

## 5. Run manifest schema (`runtime-bootstrap-run-1`)

```jsonc
{
  "schema": "runtime-bootstrap-run-1.5",
  "run_id": "<run-id>",
  "started_at": "<iso-8601-utc>",
  "updated_at": "<iso-8601-utc>",
  "status": "open|complete|configured-not-verified|abandoned",
  "selection": { "bundle": "<id>", "desired": ["<plugin>"], "excluded": ["<plugin>"] },
  "seeded_from": { "profile_id": "<name>", "profile_hash": "<sha256>" },   // retained runs only; no longer written (ADR-0064 D3)
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
      { "kind": "deep-peer-smoke|workflow-continuation|permission",   // a retained run may also carry "egress-provider-ack" (retired, §7)
        "step_id": "<proof.*>",
        "status": "passed|failed|stale|not-applicable|absent",
        "reasons": ["<why this verdict, recomputed>"],
        "required": true,
        "declined": false,
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
      "reasons": ["<why this verdict, recomputed>"],
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

`seeded_from` recorded the **profile id and hash** of the machine profile a run
was seeded from, never a filesystem path (a path can itself reveal operator
layout). ADR-0064 Decision 3 removed the machine profile on 2026-10-04, and no
writer sets `seeded_from` any more. It stays valid in the packaged run schema
(`runtime-bootstrap-run-1.5`), so a retained run that carries it still reads, and
the removal needed no run-schema bump of its own.

Five shapes are load-bearing and agree with §8 / §8.1:

- **`probe.hosts.<h>.auth` is an enum**, not a boolean — `available` / `unauthenticated`
  / `unknown` / `sandbox_limited` — because the machine probe (`probeMachineHostState`,
  §1.1) genuinely distinguishes them; a boolean would collapse "not authenticated" into
  "unknown" and let a `sandbox_limited` read masquerade as authenticated.
- **The RECORDED proof's `directions` is a per-direction result map**, not a list of
  direction names (§8.1). A proof's `status` is the **aggregate recomputed from the
  kind's evidence facts** — `directions` for the directional kinds
  (until ADR-0064 R4n1 the `egress-provider-ack` kind carried a three-leg set
  instead; it is retired, §8.1); the recompute does not read `artifact_hash`, and
  byte-verification against the doctor artifact it links is the import boundary's
  job (§8.2) — never trusted from storage: a smoke
  that passed `claude->codex` and failed `codex->claude` is `failed`, and a schema
  that could only say `directions: [...]` could not express it. Two shapes exist
  and must not be conflated (the 1.1-era text conflated them, and re-judgement
  read the wrong one — the false-demotion repair): the **recorded** proof lives in
  `proof/<kind>.json` and keeps its evidence member; the **reduced**
  `completion.proofs[]` entry collapses that evidence into `status` + `reasons`
  and carries no `directions` at all. Re-judgement (status/verify/resume) reads
  the RECORDED files back — validated, byte-rehashed — and the manifest's
  completion is a cached reduction over them, never the re-judgement source.
  The kind discriminator is enforced in code (lib/evidence-contract.mjs, one
  table for importer/writer/reader/reducer): directional kinds require
  `directions` and forbid `provider_ack`; `mirror_correlated` is refused on every
  kind now that the egress kind is retired; an unknown kind (the two retired
  evidence file names are skipped, not refused, §7), a filename/embedded-kind
  mismatch and duplicate kinds are refused fail-closed — the schema deliberately leaves the retired members
  optional and valid because the §4.1 validator has no `oneOf` and a retained run
  must stay readable.
- **A Stage-8 `steps[]` row is CONTROL state, never evidence.** THREE things
  describe one proof and none substitutes for another: the `steps[]` row records
  execution **disposition** (`pending` / `blocked` / `declined` /
  `not-applicable` — is execution reachable, did the operator choose), the
  recorded `proof/<kind>.json` holds the **evidence**, and `completion.proofs[]`
  holds the recomputed **verdict**. Proof judgement never sees evidence, so the
  control row reads `pending` however the evidence reads. The two axes genuinely
  disagree — `passed` + `declined` and `stale` + `blocked` are both reachable —
  so one field could not carry both, and presenting them as peer rows misreads
  as a contradiction. It did: on the 0.86.0 live-fire run the reducer judged the
  egress ack `passed` while the step row rendered `pending`, and the operator
  read a successful real-network send as a failure. (ADR-0064 R4n1 retired that
  proof kind on 2026-10-05; the division it exposed governs the surviving
  proofs.) §8 pins the presentation
  rule that closes it.
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
- **`steps[].fragment_applied`** is **LEGACY-ONLY as of ADR-0057**. It marked that *this
  run rendered a fragment and a post-probe observed the operator applying it*, and the
  §8.1 rule read it: the `permission` proof used to be required **iff** a
  `permission.*.applied` step carried `fragment_applied: true`. Stage 6 is gone, nothing
  writes the field any more, and `proof.permission` is now unconditionally applicable
  and declinable — see §6.1 and §8.1. The field stays readable so runs planned before
  the removal are not invalidated.

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

**A Stage-8 row describes execution disposition, not evidence.** Its status
answers *is execution reachable, and did the operator choose* — `pending` /
`blocked` / `declined` / `not-applicable` — and never *what does the recorded
evidence say*. Recorded proof evidence NEVER promotes a control row to
`satisfied`: proof judgement does not read evidence at all, and §8 evaluates
Stage 8 from `completion.proofs[]` instead. The table's "counts toward
completion" column is therefore a CONFIG statement; a Stage-8 row reaches the
reducer only as the decline flag (§8), and the recomputed verdict decides the
rest. The two axes are independent by construction, so
`passed` + `declined` and `stale` + `blocked` are both ordinary states — not
contradictions to be resolved into one value.

### 6.1 The expected-step registry — omission must not pass

The reducer walks an **exact expected-step set** derived from the selection, not
merely the `steps[]` array present in the manifest. An absent **applicable CONFIG**
step (Stage 1–7) is counted in `missing_steps[]` and **blocks completion**. Without
this, a manifest that simply omits a required step passes the reducer — the exact
false-pass this command exists to prevent. The CONFIG restriction is not an
oversight: counting an omitted PROOF step here would force `incomplete` and make
`configured-not-verified` unreachable again (§8's errata), and an absent proof is
already handled by the proof clause. The registry is therefore enumerated here, not
left to S8:

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
| `config.model_effort` | 4 | always | no (see §6.1.1 — a recorded `host-native` posture satisfies it; a decline is not the vocabulary for that) |
| `config.session` | 4 | always | **yes** (see §6.1.3 — a VALUE-bearing step; `accept` is refused, `set:` or `decline`) |
| `statusline.claude.configured` | 5 | always | **yes** |
| `statusline.codex.configured` | 5 | always | **yes** |
| `hooks.codex.attested` | 7 | iff any selected plugin has `hook_bearing.codex` | no (but `not-applicable` when no Codex hook-bearing plugin is selected) |
| `proof.deep-peer-smoke` | 8 | always | **yes** (declining caps at `configured-not-verified`) |
| `proof.workflow-continuation` | 8 | iff `engineer` ∈ selection | **yes** (same cap) |
| `proof.permission` | 8 | always | **yes** (same cap) |

Stage 5 carries the two statusline steps only, and Stage 6 stays empty. Stage 8
carries `proof.deep-peer-smoke`, `proof.workflow-continuation` and
`proof.permission`.

#### 6.1.1 Stage 4 asks for a recorded POSTURE, not for a key

`config.model_effort` is satisfied by **either** of two recorded facts:

1. an explicit coordinate in user-global `~/.agentic-plugins/config.toml` —
   `model`, `effort`, or a `<peer>_`-prefixed pair — carrying a non-empty value; or
2. `model_effort_fallback = "host-native"`, which declares that leaving the
   coordinates unset is **deliberate**.

Key presence alone was the original test, and it made a machine that runs
host-default model/effort on purpose unable to ever reach `complete`. That
contradicted three things this repository had already written down: the
documented resolution order ends with `host-native default` and
`resolveOneSetting` returns exactly that for an unset coordinate; `runtime:settings`
already renders the same null as `<host-default>`; and the cutover scorecard's R5
quality contract accepts "model/effort defaults stay host-native **or**
`runtime:settings` configured". The step was asking for a key when the contract
only ever asked for a decision.

Three properties of the posture key are load-bearing:

- **It is policy metadata, never a model identity.** The peer resolver reads a
  closed key list (`[<peer>_model, model]` / `[<peer>_effort, effort]`), so the
  posture cannot reach a companion as an argument. This is why it is a separate
  key rather than a sentinel *value* in `model` — a sentinel would be handed to
  the companion verbatim.
- **It is a fallback, not a promise.** It governs only the coordinates nothing
  else resolved. Explicit command flags, a workflow override, repo config and
  user-global coordinates all still win for their own coordinate, so a declared
  posture never means "every invocation uses host defaults".
- **It is user-scope-only.** The Stage-4 judge reads user-global config
  exclusively and the peer resolver never reads the posture at all, so a
  repo-side copy would be configuration nothing consults. Repo-local model/effort
  *coordinates* stay legitimate; it is the declaration that has one home.

(A fourth property, that the posture was never exported to the portable machine
profile, went with the profile: ADR-0064 Decision 3 removed it on 2026-10-04.)

Three judgement rules follow, and each closes a hole the presence test had:

- an **unreadable** user config is `unknown`, never "nothing set" — §6's rule that
  unknown is never satisfied applies to the config read as much as to a probe;
- an **empty** value (`model = ""`) is not a coordinate. The parser deliberately
  preserves a known key with an empty value so the per-key validator can fail
  closed on it, and the presence test counted that as configured;
- an **invalid** posture value is `pending` with the valid set named. The value
  reaches the judge unvalidated — validators run on the write path — so a typo
  would otherwise satisfy the step while `runtime:settings --apply` refuses it.

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
| `statusline.<h>.configured` | `host.<h>.present` (a host-targeted config step) |
| `hooks.codex.attested` | every selected Codex-hook-bearing plugin's `.codex.installed` **and** `.codex.enabled` |
| `proof.deep-peer-smoke` | both hosts' `.authenticated`, plus `companions` `.installed` on both and `.enabled` on Codex |
| `proof.workflow-continuation` | `engineer`'s `.installed` on both hosts and `.enabled` on Codex |
| `proof.permission` | both hosts' `.authenticated`, plus `companions` `.installed` on both and `.enabled` on Codex (ADR-0057 §Decision 5 — the same edges its sibling smoke proof carries, because it makes the same live companion invocation; the removed Stage-6 edges are replaced, not emptied) |

A **Stage-8 entry is an execution anchor**, not an evidence record: it exists so an
answer (`execute` / `decline`) has something to target and so the
executor knows whether running is reachable. Its `blocked_by` edges therefore govern
EXECUTION reachability only and say nothing about evidence already recorded — a proof
whose predecessors have since broken is `blocked` for re-execution while its recorded
verdict stands on its own (§8, §5's three-shapes bullet).

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

**Retired step ids.** `lib/step-registry.mjs` keeps a `RETIRED_STEP_IDS` map, id
to the ADR that retired it, and `deriveExpectedSteps` derives none of them. They
are listed here as history, in prose and not as table rows, because the §6.1
step table is held to the registry by `tests/runtime/test-step-registry.mjs`:

- `permission.claude.applied` and `permission.codex.applied` (Stage 6) —
  ADR-0057;
- `config.notify_kinds` (Stage 4), `notify.configured`,
  `notify.codex.configured` and `egress.configured` (Stage 5), and
  `proof.egress-provider-ack` (Stage 8) — ADR-0064 Decisions 1 and 6, slice
  R4n1.

A retired id stays nameable in a retained run: the step-id pattern never
enumerated ids, so a row or a `choices[]` entry carrying one is schema-valid. A
retired id is never owed or judged by a 1.5 runtime, and never rendered as a step
of a run it judges; the historical projection of a terminal earlier-minor run
still shows the stored rows (§7). §7 states how a retained or open run that
carries one is read. An `--answers` entry
naming a retired id is exit `40`, like any step the registry did not derive
(§3).

(§6.1.2, the `notify.codex.configured` conjunction, was removed with that step by
ADR-0064 R4n1 on 2026-10-05; the number is not reused.)

### 6.1.1 The statusline steps (ADR-0048 §1/§2/§2.1)

Both steps are EXACT canonical-configuration probes over the ONE policy
definition (`lib/statusline-plan.mjs`, the owner-adopted `agentic-6` ordered
set — `model-with-reasoning · git-branch · pull-request-number · context-used ·
five-hour-limit · weekly-limit`); every renderer and probe derives from that
table, and the policy↔shim agreement test pins the shim's renderer map to it.

- **`statusline.codex.configured`** — satisfied iff `[tui].status_line` in
  `$CODEX_HOME/config.toml` EQUALS the canonical item order element-wise.
  ABSENT means Codex renders its two-item default: `pending`, named. A present
  non-canonical list is the operator's own selection: `manual-follow-up`,
  never overwritten. The rendered fragment is ONE `[tui]` table carrying the one
  runtime-planned key, `status_line` (via the shared composer in
  `lib/toml.mjs`; the fragment's `note` tells the operator to merge `status_line`
  into the ONE `[tui]` table of `$CODEX_HOME/config.toml`). Until ADR-0064 R4n1 (2026-10-05) the table carried a second
  key, `notifications`, and a run chose between this fragment and the
  notification plan's `[tui]` preview as the one presented source; with the
  notification plan no longer rendered there is one `[tui]` source and none of
  that arbitration.
- **`statusline.claude.configured`** — satisfied iff the USER-layer
  `settings.json` (`CLAUDE_CONFIG_DIR` honored; ONE shared snapshot — it served
  the permission consumer too until ADR-0057 removed it) carries
  `statusLine: { type: "command", command: <canonical> }` where the canonical
  command is `node '<home>/.agentic-plugins/bin/agentic-statusline.mjs'` —
  forward-slash, SINGLE-quoted, shell-resolved `node` (the Claude statusLine
  runs through Git Bash/PowerShell). Single quotes are
  the canonical form because double quotes interpolate in BOTH Git Bash and
  PowerShell — a home path containing `$(...)` would execute substitution and
  change the shim argv; a path that itself contains a single quote has no
  cross-shell-literal representation and is refused fail-closed
  (`expectedClaudeStatuslineCommand`). **The step means
  "canonical configuration OBSERVED", never "the statusline runs"**: workspace
  trust, `disableAllHooks`, `CLAUDE_CODE_SAFE_MODE`, and script failure still
  gate execution (host-truth §3) and no probe may relax them. A pre-existing
  statusLine is classified as an OBSERVATION (`absent | canonical |
  foreign-command | foreign-shape | unreadable`) with OFFERED resolutions
  (`replace | manual-merge | decline`) — the resolution is the operator's,
  recorded through the ordinary answers machinery; nothing is auto-chained,
  the raw foreign command is never persisted or echoed, and "manual merge"
  means keeping compatible fields (padding, refreshInterval) around ONE
  canonical command.
- **The inline sufficiency gate (§2) is executable**: five per-condition
  verdicts; the agentic-6 policy FAILS it (cross-shell identity and
  one-command reviewability), so the SHIM is the documented outcome. The shim
  is render-only (the operator installs it at `~/.agentic-plugins/bin/`),
  read-only, bounded, credential-free, network-free, non-polling, and
  order-preserving under missing data. **Owner-approved §2.1 deviation
  (2026-07-23)**: an ordinary Claude session's stdin carries no git branch
  (`worktree.branch` is worktree-session-only), so the shim runs ONE bounded
  read-only `git branch --show-current` — fixed argv, no shell, cwd validated
  from the session JSON, 1.5s timeout, capped output, scrubbed child
  environment — which stays inside the §2 shim contract (it forbids
  network/credentials/polling, not a read-only VCS query).
- **Shim delivery is NON-GATING**: the step proves settings-level
  configuration; the shim's canonical sha256 and full body are persisted in
  the fragment AND as an unconditional `statusline-shim` artifact on every
  plan/resume (a satisfied step skips fragment persistence, so the refresh
  material rides separately) — back up the old shim, install, verify the
  hash, and revert by restoring the backup. Hash equality is deliberately NOT
  a condition of the configured step.
- **The shim hash binds the installed BYTES, not the rendered BEHAVIOUR.**
  Since the shim became a delegating one (ADR-0048 §2 as amended), what it
  prints is produced by `scripts/receiver-api.mjs` in the resolved runtime
  plugin, which the shim finds at run time. Two consequences change how the
  hash and the backup may be read:
  - A plugin upgrade can change the rendered statusline **without changing the
    installed shim or its sha256**. That is the point of the shape — it is how
    a rendering fix reaches an already-installed shim — but it means hash
    equality proves the delivery was faithful, never that behaviour is
    unchanged.
  - **Restoring the backup no longer necessarily restores the old behaviour.**
    Restoring a backup that predates the delegating shape restores a
    self-contained renderer, which does revert behaviour; restoring a backup of
    a *delegating* shim reverts only the item policy, the runtime floor, and the
    required capability major — the rendering still comes from whichever runtime
    resolves at that moment. A behavioural rollback needs the runtime rolled
    back too, and the shim's floor must not exceed the runtime being rolled back
    to.
  The shim declares what it needs so a diagnosis can state the gap rather than
  infer it: its `@agentic-receiver:` marker line names the generation, its
  `MIN_RUNTIME_VERSION` the floor, and its required capability major the API
  shape. A shim whose floor or major the resolved runtime does not satisfy
  renders nothing at all — visibly empty, never silently stale.
  *Amended 2026-09-25 ([ADR-0061](../../../docs/adr/0061-codex-installs-pinned-to-release-commits.md)
  §Decision 3, implementation step S3):* the shim's runtime ladder
  (`statusline delegating-shim v2`) reads the Claude install cache, then the
  versioned Codex install cache under `$CODEX_HOME`; `v1` fell back to the Codex
  marketplace clone, which tracks `main`. The notify shuttle
  (`codex-notify delegating-shim v2`) changed the same way, Codex cache first.
  Both `v1` shapes are registered in `data/released-receiver-shapes.json`, so an
  installed `v1` reads as `legacy` until the operator re-renders it; a runtime
  release does not rewrite home copies.
  *Amended 2026-10-05 ([ADR-0064](../../../docs/adr/0064-runtime-surface-reduction.md)
  Decision 1, slice R4n2):* the notify shuttle and its chain receiver were
  removed with their templates and their `data/released-receiver-shapes.json`
  entries. The registry now holds the statusline shapes alone, and the
  inventory classifies `agentic-statusline.mjs` only, so a shuttle or chain
  file left in `~/.agentic-plugins/bin` is no longer a kind it reports
  (ADR-0064 Decision 9 leaves its removal to the operator).
- *(Removed 2026-10-04 with the portable machine profile, ADR-0064 Decision 3:)*
  an owner-approved (2026-07-23) `statusline_preset` export rule had `profile
  export` write `agentic-6` iff both hosts' statusline configuration was observed
  canonical, and `null` for one host, a decline or foreign wiring.
- **Desired-seat discipline (applies to every fragment-bearing exact probe)**:
  the plan's expectation freezes into `steps[].desired` on FIRST render and is
  never silently re-bound; §7 version invalidation clears it with the
  fragment fields; an unreadable persisted expectation judges
  `manual-follow-up` (fail-closed), never a silently widened match.

#### 6.1.3 The VALUE-bearing Stage-4 step

`config.session` is the only step whose resolution depends on a value the
operator **chooses** rather than on a fact the probe finds. (`config.notify_kinds`
was the other until ADR-0064 R4n1, 2026-10-05.) Its grammar is §3.3; this section
is what it means.

**What it certifies is the PERSISTED USER-GLOBAL POSTURE**, never the effective
value on this machine right now, and the distinction is load-bearing rather than
pedantic. `session_capture` resolves repo → user → default at
runtime, and `entry_brief` / `entry_brief_empty` resolve env → user → default
(ADR-0045 §7). So a satisfied step can coexist with a repo or env layer that
wins at runtime. That is deliberate: §1.1 keeps bootstrap off the repo-scoped
reader seam, and a machine bootstrap records the **operator's default**, not a
checkout's policy. (§4.4 stated the same rule for the machine profile's export
of these keys until ADR-0064 Decision 3 removed the profile on 2026-10-04; this
paragraph is now its home.) ENV shadowing IS surfaced on the step (env is already in hand);
repo shadowing is a named boundary, diagnosed by `runtime:doctor`, not by this
step.

**Why Stage 4 and not Stage 5.** `applied_by` is derived from the stage — 4 is
`agentic-config`, 5 is `operator` — and what writes these keys is
`runtime:settings --apply --target user`, not an operator merging a fragment
into a host file. `config.model_effort` is the precedent: a Stage-4 step that
asks for a recorded decision about agentic-plugins' own config.

**Why declinable, when `config.model_effort` beside it is not.** The posture
step asks for a decision that must EXIST: a machine has some model/effort
posture whether or not it says so. This one asks about OPTIONAL machinery whose
shipped defaults are a legitimate standing answer. `decline` is the vocabulary
for "leave this unmanaged and stop asking" — which is **not** the same as
choosing the defaults. Choosing the defaults deliberately is
`set:<key>=unset`, and the two differ in exactly the way §6.1.1 cares about: one
records a decision, the other records a refusal to decide.

**The status matrix**, in full, so `pending` and `manual-follow-up` are never
guessed at. `pending` means not done; `manual-follow-up` means a hand-off was
rendered and is awaiting action — a previously rendered fragment IS that
hand-off:

| standing decision | observation | status |
|---|---|---|
| none recorded | anything | `pending`, with the answer grammar presented |
| `decline` | anything not satisfying | `declined` (restored on every re-judge, §6.2) |
| `set:`, some keys undecided | anything | `pending`, naming the undecided keys |
| `set:`, every key matches | matches | `satisfied` |
| `set:`, a key differs, nothing rendered yet | differs | `pending` + the apply command |
| `set:`, a key differs, a fragment exists | differs | `manual-follow-up` + the apply command |
| any | user config unreadable | `unknown` (§6: unknown is never satisfied) |

**`unset` is satisfied by physical ABSENCE only.** `parseRuntimeConfigToml`
preserves a present-but-empty key, so `session_capture = ""` is a *present blank*,
not an unset key. A blank is a byte the operator still has to remove, and
`runtime:settings --unset <key>` is what removes it.

**The apply path for `unset` is a real operation, not a hand-edit.**
`runtime:settings --unset <key>[,<key>]` deletes **every** assignment line for the
key (the config parser is last-value-wins, so a surviving duplicate would
resurrect it) and reports how many lines went. Removal is deliberately **not**
filtered by the user-scope-only rule: ADR-0045 §7 forbids a tracked repo value
from *activating* a session-shaping key, and deleting one can only ever
deactivate. (The ADR-0047 §8 dual-kind warning for a one-sided `notify_kinds`
filter went with that step in ADR-0064 R4n1.)

**Concurrent resumes are still an operating assumption, and this feature raises
the stakes.** `resume` computes from an unlocked snapshot and the locked mutator
appends onto the latest `choices` while writing its own precomputed `steps` and
`completion`, so two overlapping resumes can leave a ledger containing both
answers and a judgement made against only one of them. That is pre-existing and
unchanged here, but a value interview makes it consequential rather than
cosmetic: the losing writer's DECISION survives in the ledger while the stored
verdict describes the other one. One resume at a time remains the assumption;
`status` re-folds the ledger and re-judges, so it is the way to see which
decision actually stands.

**Enabled values have functional dependencies this step does not judge.**
`session_capture = "stop-hook"` and `entry_brief = "startup"` both need an
installed, enabled attention sensor above its runtime floor before the machinery
they name actually runs. This step certifies that the POSTURE is recorded and
observed; `runtime:doctor` and `runtime:settings` own the readiness question.
Saying so is the point — a step that claimed "the machinery is on" would be
`satisfied` on a machine where nothing fires.


### 6.2 The declinable set is narrow

**Not declinable, ever**: host CLI presence and authentication; marketplace
registration; **the Stage-4 model/effort posture**; `runtime`; **`companions`**; and
any plugin reached by a hard edge from a retained plugin.

The posture step is named here because it was in neither list while §6.1's table and
the registry both said `no` — a three-way disagreement between prose, table and code.
It stays non-declinable on purpose: "I will not do this step" is the wrong sentence
for a machine that *has* chosen, and a decline would record the absence of a decision
where §6.1.1 requires the presence of one. The host-native posture is that decision,
recorded positively (§6.1.1).

**`companions` is mandatory in every selection, including `custom`.** It is not
merely a member of `base` — a `custom` selection may not omit it. The reason is
structural: `proof.deep-peer-smoke` is the only evidence that the cross-host bridge
works, and it is unreachable without a companion path (doctor itself blocks the proof
when none exists). A contract that let `companions` be declined while requiring the
smoke proof would define an unreachable terminal state. Making the *proof* conditional
instead would be worse: it would let a machine reach `complete` having proven nothing.

**Declinable**: optional plugins (any plugin not reached by a hard edge from a
retained plugin, and not `runtime` or `companions`); the statuslines; and the
execution proofs — declining a proof caps the run at
`configured-not-verified` and **never** grants `complete`.

Declining a plugin creates a **new effective `custom` selection** and **re-runs hard
dependency closure** (§9.1). Declining `companions` while retaining `image` on Claude
is therefore rejected twice over — once by the closure, once by the mandatory rule.

#### 6.2.1 The effective selection is persisted, not recomputed per consumer

"Creates a new effective selection" is a **write**, and the wording had been read as a
validation step for long enough to matter: the retained set was computed inside the
answers gate, used to reject illegal declines, and discarded. Every selection-derived
expectation kept reading the planned `desired`, so a declined plugin was refused and
demanded at once — `requiredBoundPlugins` demanded a bound version that
`currentBoundVersions` could never supply for an uninstalled plugin, staling **every**
proof forever with a reason naming a plugin the operator had refused; the
non-declinable `hooks.codex.attested` stayed owed over a refused hook plugin; and the
closure was computed over refused plugins, so declining `orchestrator` left `engineer`
protected. There was no in-run recovery: `abandon` plus a re-plan was the only escape.

The rules, stated so a reader can check an implementation against them:

- **`plan` and `resume` persist the narrowing**, in the same atomic write as the steps
  derived from it. The bundle becomes `custom` and `excluded` is recomputed, so the
  seat never names a bundle whose members `desired` no longer holds. (While the
  machine profile existed the rewrite was also load-bearing: a named bundle was
  **re-expanded** from the plugin-set when a selection was seeded into a new run,
  so a narrowed `desired` left under `design` would have been re-widened by an
  export/seed round trip. ADR-0064 Decision 3 removed the profile on 2026-10-04.)
- **`status` and `verify` derive it in memory** and cannot write (§3, R0). They present
  the stored selection verbatim, carry the retained set beside it, and warn that the
  two diverge. A run recorded before this rule existed is therefore judged correctly
  on the spot and healed by the next `resume`.
- **A HOST-scoped decline narrows the host, not the plugin.** `desired` is a flat name
  list and cannot express "on Codex but not Claude", so a plugin refused on one host
  stays selected and its refused host stops binding versions, stops being presented as
  an install candidate, and stops counting toward the Codex-hook-bearing set. The
  declined ROW is the only record of such a refusal, which is why a partial decline
  keeps its Stage-3 row while a whole-plugin decline does not. **One limit follows,
  and it is vocabulary, not a defect to fix later**: a host-scoped refusal is never
  written into the selection seat (so `status`/`verify` say exactly that rather than
  promising a resume that would repair it). A second limit, that such a refusal did
  not survive a machine-profile export/seed round trip, went with the profile
  (ADR-0064 Decision 3, 2026-10-04).
  - The install-candidate exclusion is **presentation**: the plugin-management plan
    the operator is then handed is machine-wide by construction (§1.6), so it may act
    on plugins outside this run's candidates. Bootstrap stops recommending the
    refused host's install; it does not — and cannot — fence the executor.
- **A plugin refused on every host it targets leaves the selection, at either grain.**
  An `.installed` refusal says the plugin will not be there; a Codex `.enabled` refusal
  says it will be there and switched off. Both mean it runs nothing on that host, so a
  Claude `.installed` decline plus a Codex `.enabled` one is a whole-plugin refusal —
  counting only `.installed` would leave it in `desired` while it was absent from both
  per-host sets, with binding and hooks treating it as gone and the proof registry
  treating it as present.
- **Declinability governs the host grain too.** A refusal against a mandatory plugin,
  or one still reached by a hard edge from a retained plugin, is not honoured on a
  single host any more than it is on all of them. Honouring the narrow one would be
  the same false pass through a smaller door: a hand-written
  `plugin.companions.claude.installed: declined` would drop mandatory `companions`
  from Claude version binding while `proof.deep-peer-smoke` still claimed to prove the
  bridge works.
- **Declinability is recomputed to a fixpoint**, because removing a plugin can free its
  hard-edge targets. A single pass would honour one decline and silently drop a second
  that the first had just made legal. The fixpoint is order-independent: removals only
  ever shrink the closure. It is a property of the derivation, **not** a promise that
  one answers file may chain declines — the answers gate judges each answer against the
  declinability derived *before* the file was applied, so `orchestrator` and `engineer`
  declined together is refused on the second row. Chained declines take one resume
  each; the fixpoint is what makes a manifest that already carries both reduce
  correctly.
- **The hard-edge closure is plugin-wide, not per host.** `orchestrator` declined on
  Codex alone therefore does *not* make `engineer` declinable on Codex, even though no
  retained Codex plugin requires it there. That is a **conservative** gap — it leaves
  an obligation standing rather than dropping one — and it is pre-existing: §9.1 states
  the closure per host, `hardRequiredClosure` has always computed it flat. Making it
  host-aware is tracked as a follow-up, not assumed here.
- **A decline that cannot narrow is refused, never recorded as a no-op** — a mandatory
  plugin, or one still reached by a hard edge from a retained plugin. The answers gate
  and the narrowing read ONE derivation, so a validator and the thing it validates
  cannot disagree.
- **An observation is not retractable.** A decline against an already-`satisfied` step
  is not written (§6.2's judge rule), so it does not narrow anything. Nothing is
  refused that was already observed to be true.
- **Narrowing is not reversible in-run.** Once a plugin leaves the selection its steps
  leave the expectation, so there is no step left for a later `accept` to target; the
  answer would be rejected as naming an unexpected step (§6.1). Re-planning is the
  route back, and `choices[]` keeps the audit trail either way.
- **No schema addition.** The narrowing is expressed in the existing
  `{bundle, desired, excluded}` seat. A new member would have to be an array, and
  §4.1 refuses an unknown **non-scalar** key at *every* minor — so an older runtime
  could no longer even `status` the run.

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

**A schema-minor bump adds obligations, and an OLDER READER cannot see them.**
An older runtime's `status` / `verify` on a newer-minor run derives its OWN
registry, so a step the newer minor added is simply absent from its expectation:
the report is optimistic and the exit code can read `0` while that step is
unresolved. This is the shipped, accepted behaviour of every step addition — the
1.1 → 1.2 bump added `notify.codex.configured` (a Stage-5 step ADR-0064 R4n1
retired on 2026-10-05) in the same commit and has the
identical property — and it is why the fence lives on the MUTATORS: `resume`
refuses a future minor outright (as `profile seed` did until ADR-0064 Decision 3
removed it on 2026-10-04), so an older runtime can never *close* a run under an
expectation it cannot derive. `status` and `verify` are
R0 and write nothing, so an optimistic read costs a re-run, not a state.
Stating it rather than implying it: the remedy for a stale reader is to upgrade
the runtime, not to consult its verdict.

**The post-terminal receipt window is closed.** `attest` once required the terminal
manifest to carry the EXACT current schema, so each minor bump closed the window
for runs under the previous one (the 1.2 → 1.3 bump paid that cost knowingly,
owner decision 2026-08-26). ADR-0064 R4n1 closed it for every run: there is no
`attest`, and the proof writer refuses every write into a run that is not
`open` (§3).

**Terminal runs never adopt new steps.** `resume` refuses a terminal run, so a
`complete` / `configured-not-verified` / `abandoned` run cannot take an injected
step and its completion stays HISTORICAL: it was reduced against the expectation
of its own time, and the steps a later minor adds were never part of it.
Adopting them requires a **fresh plan** — `status` and `verify` on such a run
summarize the stored completion and re-certify nothing (exit `50` for an older
minor), which is exactly why they must not be read as a current verdict.

**Step invalidation is not proof staleness, and neither substitutes for the
other.** This clause resets version-bound *observations* on the CONTROL axis
(`satisfied` / `manual-follow-up` rows, plus any render state a pending row
froze). A proof's freshness is recomputed independently, from the proof's OWN
`bound_versions`. The converse also holds: a later resume may refresh `probe` while a recorded proof
stays stale. So a Stage-8 control row is never the place a proof's staleness is
recorded, and this reset never makes a stale proof current.

**One snapshot per verb.** A resume that spawns a `runtime:doctor` child re-probes
afterwards — that child takes minutes, and judging its own freshness against the
snapshot it started from would compare a machine against itself. The trigger is
the **spawn**, not the child's outcome: a doctor run that ends in a crash,
unparseable output or an internally inconsistent section imports nothing while
having had exactly as long to let the machine move, so gating the re-probe on the
import would make the failure path the one that reports stale facts.

**A non-zero doctor exit is not a crash.** `runtime:doctor` reports its findings
through a diagnostic exit ladder (`commands/doctor.md` § Exit codes), and every
code from `10` up still writes the complete report to stdout. The importer
therefore PARSES STDOUT FIRST and reads the exit code as a classifier: a report
is usable whenever it parses to a plain object AND the exit code is one this
runtime has a report contract for. Only an absent or unparseable report — or an
exit code outside that set — is the crash case. The one code that refuses an
otherwise-usable report is `record-failed`: §8.2 links a proof to its doctor
artifact by exact-byte hash, and there is no artifact to link.

That second
snapshot then becomes the verb's ONLY account of the machine: `probe`, the raw
host facts behind it, and the user-global readers are gathered once, and
everything the verb JUDGES and REPORTS is rebuilt from that one gathering — the
judged `steps[]`, the completion reduction, the persisted manifest, the Stage-0
presentation, and the returned report. A run MUST NOT store a `probe` its own
`steps[]` were judged against a different snapshot of, or return one to a caller
that disagrees with what it persisted.

**One read per file WITHIN the reader snapshot, projected per consumer.** Two
judges reading the same file separately can observe an atomic replacement between
them and then agree about a file that no single version of satisfies. Inside the
reader gathering, Claude's `settings.json` (statusline),
`~/.agentic-plugins/config.toml` (model/effort + session) and
`$CODEX_HOME/config.toml` (statusline) are each read ONCE and projected.
(The permission projections of the first and last went with the machine profile,
their only consumer: ADR-0064 Decision 3, 2026-10-04.)

*Scoped to the gathering on purpose, because a broader claim would be false*: the
machine PROBE reads `$CODEX_HOME/config.toml` again for Codex hook state, so that
file is still sampled twice per verb across the two phases, and a replacement
between them can pair hook facts from one version with statusline facts
from another. Recorded as a follow-up; the claim above is
deliberately the narrow one the code actually keeps.

*Fragment composition is handed that same reader snapshot.* Until ADR-0064 slice
R4n1 (2026-10-05) it was not fully bound by it: the notification builder (which also
composed the Codex `[tui]` table) and the egress-launcher builder re-read their config
themselves, so a config change between the snapshot and the render could produce a
fragment built from later bytes than the rows beside it. Those builders are removed.
The statusline builders take their user configuration from the snapshot
(`readersForFragments`) alone. Besides packaged templates, they read only the
installed-receiver inventory (`inspectInstalledReceivers`), which is sampled
separately at render time.

**The expectation's own inputs move with the snapshot**, so they are re-derived
before the rebuild and the rows re-judged. Two of them:

- the **effective selection** — it is derived from `declined` step rows and
  nothing else, and §6.2 lets a satisfying observation clear a decline. A
  host-scoped refusal lives ONLY in that row (`selection.desired` is a flat name
  list and cannot express it), so an operator who installs, during the proof, a
  plugin they had refused on that host erases the evidence the exclusion rests
  on. Left un-derived, the run binds versions, judges hooks and reduces against a
  refusal its own rows no longer support, and closes `complete` over it.

This is a **re-derivation, not a reversal**: only the per-host retained set can
move here, and only wider. The retained PLUGIN set is fixed — the derivation is
asked about the already-retained set, and a judgement only ever restores declines
from prior state, never invents them — so `{bundle, desired, excluded}` is not
rewritten and no narrowing history row is written. Narrowing stays irreversible
in-run per the rules above. The operator is warned by name when it moves, and
pointed at re-planning if the refusal was the intent.

**Every verb that speaks about the machine as it is NOW converges it, not only
`resume`.** The derivation reads the STORED rows and the judge then re-observes
them, so the convergence belongs to the shared re-judgement — otherwise `status`
and `verify` are the worse half: they cannot persist a correction and a terminal
run cannot be resumed, so a completed run whose Codex-refused,
Codex-hook-bearing plugin was afterwards installed would report both its rows
`satisfied`, leave `hooks.codex.attested` `not-applicable`, and return
`complete` at exit 0 for good. `resume` converges a SECOND time after its
executor, because the machine can move again in between. The selection-scoped
hook verdict is re-derived with the selection at every point it moves: a claim
that covered the narrow set must not go on satisfying a non-declinable step it
no longer covers.

**Convergence has no exception.** `attest` was the one verb that judged against the
selection the run was REDUCED with, not a re-derived one, because its subject was a
send that had already happened. It was removed with the egress proof (ADR-0064
R4n1), so every verb that speaks about the machine converges on the current
selection.

**Stated limit.** §7 version invalidation sits OUTSIDE both convergences: it runs
once, early, against the selection as it stood before either. Two windows escape
it, and the second was found only when the first was written too narrowly here.
(i) A host CLI or plugin version that moves during a Stage-8 proof is re-judged
from the final snapshot but is not `invalidated`-stamped. (ii) A plugin that the
convergence *restores* to the selection was filtered out of the invalidation
comparison entirely — that comparison is scoped per host — so a version
transition it went through is never compared at all, and this needs no executor
to happen. In both, the frozen fragment pointer and `desired` survive
uncleared, and because the final probe becomes the stored baseline no later verb
compares across the window either. Tracked as a follow-up together with the
persistence-boundary question it shares with the fragment-freeze rule, rather
than claimed here.

**Schema-minor migration (1.2, ADR-0048 §1).** `resume` is the one M1 verb, so it
is where the minor moves:

- an OPEN run under an **older** minor migrates **additively** on resume: the
  registry-new steps join `steps[]` through the ordinary reprobe (expected
  derives from the current registry; prior state carries per step id), the new
  fragments render, and the persist stamps the current schema string with a
  history row naming the migration — never a silent rewrite (from 1.5 the
  migration also drops retired step rows; see below);
- a TERMINAL run under an older minor is **immutable historical evidence**:
  `status`/`verify` present a §3.2 **summary** of the stored completion with
  `historical`/`not_recertified` markers and exit `50` (§3.1), re-probe nothing,
  re-read no proof file, and re-certify nothing against the current registry —
  the operator starts a fresh `plan` for current evidence. Immutability is a
  property of the RECORD, which stays byte-identical; it was never a promise to
  reprint the record's free text on stdout;
- a run under a **newer** minor refuses `resume` outright: this runtime would
  persist a document it only half-understands, silently shedding additions a
  newer runtime recorded (§4.6: downgrade is never attempted). R0 verbs may
  still read it under the §4.1 scalar tolerance.

**Runs of an earlier minor, read by the 1.5 runtime (ADR-0064 Decision 7).**
Bootstrap runs are machine-scoped, and one packaged schema validates documents of
every minor. The 1.5 bump is semantic: it arms the existing refuse-newer and
legacy-terminal fences, so an older runtime cannot restore the retired rows into a
run this runtime migrated.

- **Every retired member stays schema-valid.** The retired step ids (the step-id
  pattern never enumerated them), `seeded_from`, the `egress-provider-ack` kind
  with `provider_ack` and `mirror_correlated`, the `egressReceiptAttestation`
  definition and `completion.egress_receipt_attestation` all still validate. A
  1.5 writer never writes them. Dropping them would make every retained run that
  carries one schema-invalid, and an invalid run can only be abandoned, not
  shown.
- **A terminal run of an earlier minor is history.** `status` and `verify` exit
  `50` (§3.1), re-probe and re-certify nothing, and do not read its proof files.
  The historical projection (§3.2) keeps projecting a stored `egress-provider-ack`
  proof row and a stored receipt verdict summary: it filters rows through its own
  `HISTORICAL_PROOF_KINDS` list (the live kinds plus the retired egress kind), not
  through the live `PROOF_KINDS`, so those rows are shown rather than counted
  unreadable. The text renderer prints `receipt attestation:` for a stored
  verdict on this path only.
- **An open run of an earlier minor migrates on `resume`.** The run is judged
  against the 1.5 registry, which owes none of the retired steps, so their rows
  leave `steps[]`. The migration history row (`step_id: null`, `from` the old
  schema, `to` `runtime-bootstrap-run-1.5`) names the dropped rows and their
  retiring ADRs, or says there were none. `choices[]`, `history[]` and
  `seeded_from` stay exactly as written.
- **Retired evidence files are skipped on every read of `proof/`.**
  `egress-provider-ack.json` and `egress-receipt-attestation.json` are never
  opened, validated, returned or credited; the reader reports their names in a
  separate `retired` list. The proof reader refuses any unknown kind, so without
  the skip an open run holding one could not resume. The skip is not limited to
  open runs: a migrated run that later completes is a 1.5 run, so `status` and
  `verify` read its proof directory instead of taking the historical path. The
  files stay on disk as history.
- **`abandon` stays the way out** of a run the operator does not want to finish.
  It accepts a run whose manifest no longer validates. `plan` keeps refusing to
  start while a run is open, so an operator who does not want to resume abandons
  first.
- **One resume at a time** stays an operating assumption (§10.2). The schema
  fence stops an older runtime from writing a newer manifest, but a resume already
  in flight when the other host upgrades can still write fragment and proof files
  before its manifest update is refused.

**A partially upgraded host pair.** Both hosts read the same machine-scoped
`~/.agentic-plugins/runs/bootstrap/`. While one host runs the 1.5 runtime and the
other an older one, the older runtime refuses to `resume` a 1.5 run or change its
steps (the future-minor fence, "upgrade the runtime plugin"). `abandon` is exempt
as a recovery verb: it can close a newer open run and keeps its schema string.
`status` and `verify` re-judge the run against the older registry, rebuilding a row
for every step that registry owes, so their verdict on the retired steps depends on
whatever notify and egress configuration that machine still holds — missing,
pending or satisfied. That is an obsolete, read-only judgment that ends when the
host updates. The 1.5 release is therefore installed on both hosts before either
host's bootstrap verdict is relied on. The `--format json` report is computed per
invocation and never read back, so it has no such skew.

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
              or a required CONFIG step is missing)
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

**`completion.proofs[]` is the sole proof verdict — and the sole source for
presenting one.** The reducer recomputes it from the recorded evidence on every
read, so nothing else may state what a proof currently says: not the stored
`proofs[].status` (§5), not a Stage-8 `steps[]` row (which carries the
orthogonal control axis, §6), and not a second rendered row. `verify`'s
top-level `proofs` is an exact alias of `completion.proofs` — a projection for
convenience, never a second authority. The generic unresolved-step presentation
covers CONFIG (Stage 1–7) only; Stage 8 is presented once, joined, per §3. This
is the presentation half of the same partition the errata below establishes for
the formula: CONFIG and PROOF are evaluated separately, so they must be
*reported* separately too. Rendering both axes as peer rows is what produced the
0.86.0 live-fire misread — the reducer said `passed`, the control row said
`pending`, and the operator believed the row that was not the authority.

**Invalid evidence caps at `incomplete` (1.2 amendment, ADR-0048 §3).** Duplicate
records claiming one kind are REJECTED, never chosen between: the read boundary
(`readBootstrapProofRecords`) refuses the whole read all-or-nothing, and the
reducer — defense-in-depth for direct library callers — reduces the duplicated
kind to `failed` with the duplication named AND caps `state` at `incomplete`
regardless of whether the duplicated proof was required. A duplicated
non-required proof is still an evidence-integrity violation, not a pass.

**The receipt attestation verdict was removed (ADR-0064 R4n1).** From 1.2 to 1.4 the
reducer carried `completion.egress_receipt_attestation`, a recomputed verdict over
the owner's recorded phone-receipt testimony. A 1.5 reducer never computes or
writes it: `reduceCompletion` takes `{ pluginSet, selection, steps, proofs,
hookAttestation, probe, runtimeVersion }`, and the completion shape is the 1.1
shape. A retained terminal run's stored verdict is history, shown only by the
§3.2 projection (§7).

### 8.1 Which proofs are required

| Proof | Required when | Why |
|---|---|---|
| `deep-peer-smoke` | **always** | It is the only proof that the cross-host companion bridge actually works. It is always *applicable* because `companions` is mandatory in every selection (§6.2) — that rule exists precisely to keep this proof reachable. |
| `workflow-continuation` | **iff `engineer` ∈ selection** | It exercises engineer machinery. Requiring it with no engineer installed would be unreachable. |
| `permission` | **always** | ADR-0057 §Decision 5. It is the dedicated live proof that RECORDS ADR-0035 §4's no-relaxation fact — `permission_policy: {host_native_default, relaxed_by_doctor, injected_flags}`. It used to apply only when an operator had applied an advisor fragment, which made a boundary proof conditional on an advisory artifact; with the advisor gone that gate has no referent, and merely deleting it would have made the proof permanently non-applicable. |

**The egress delivery proof was retired (ADR-0064 R4n1).** `egress-provider-ack` was
an opt-in proof (ADR-0048 §3) that a provider request returned HTTP 2xx and
`{ok:true}`. The kind, its `egressProofOptedIn` provenance rule, its activation
fingerprint binding and its executor are gone, and no operator input can make a
proof applicable any more: the three proofs above are the whole table. The kind
survives only as a retained-run vocabulary (§7): its stored rows project, and its
`proof/` file is skipped.

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

Every proof kind links the doctor artifact by its exact-byte `artifact_sha256`
(doctor's write is temp+rename atomic), so `artifact_hash` is never null on a freshly
recorded proof. Byte-verification against that artifact is the import boundary's
job.

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

*Amended 2026-09-25 ([ADR-0061](../../../docs/adr/0061-codex-installs-pinned-to-release-commits.md)
§Decision 3, implementation step S2):* the ladder above is the one S8a1 shipped. The
Codex rung is now the versioned install cache under `$CODEX_HOME`
(`<CODEX_HOME>/plugins/cache/agentic-plugins/engineer/<version>/`, manifest-verified,
newest first), never the marketplace clone. A doctor running from a Codex install
probes that cache before the Claude cache and uses the Claude cache only when Codex
has no engineer installed, recording `tool_root_cross_host_fallback`. The sibling
rung applies only when doctor itself runs from a checkout. The resolver still never
consults `repoRoot`.

*Removed 2026-10-05 ([ADR-0064](../../../docs/adr/0064-runtime-surface-reduction.md)
Decision 1, slice R4n1):* this section also specified the `egress-provider-ack`
executor, the one proof that made a real network send. It reached doctor through
`--egress-ack-proof --execute-egress-ack-proof`, was gated by
`AGENTIC_EGRESS_REAL_SMOKE=1`, and bracketed the send with an append-only
write-ahead intent record. Bootstrap's `executeProofViaDoctor` has no egress
branch, `PROOF_EXECUTE_FLAGS` and `DOCTOR_SECTION_BY_KIND` name the directional
kinds only, and bootstrap no longer forwards a doctor intent-WAL warning or
egress retry advice. Doctor's own egress proof section was removed by the next
slice (R4n2, below). Git history holds the specification of the executor and its WAL.
*Removed 2026-10-05 (slice R4n2):* doctor's `egress_ack_proof` section went
too, with `--egress-ack-proof`, `--execute-egress-ack-proof`, the
`AGENTIC_EGRESS_REAL_SMOKE` gate and the intent WAL. Records left under
`~/.agentic-plugins/runs/doctor/egress-intents/` are history that no runtime
code writes or reads ([artifact-policy.md](artifact-policy.md) §Inventory).

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
| `attention` → `runtime` | **soft** | both | Attention resolves the runtime root through a copied `discover-runtime.mjs` ladder; with no runtime there is no capture publisher or entry arbiter to spawn, so the sensors are inert. |

Rules:

- A selection MUST satisfy every **hard** edge **for every host it targets**. A
  violating `custom` selection is **rejected** (exit 40), naming the missing plugin
  and the host.
- **Soft** edges are never rejected, but bootstrap MUST **warn**: a persona without
  `companions` is a materially degraded install; `attention` without `runtime` captures
  and injects nothing.
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
```

`~/.agentic-plugins/profiles/<name>.json`, the portable machine profile's home,
left this list on 2026-10-04 with the profile (ADR-0064 Decision 3, §4). Nothing
writes, lists or retention-manages it any more.

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
  would become materially riskier only if a proof gained a non-idempotent side
  effect — the trigger for a dedicated slice); until then, one
  resume at a time per machine is the operating assumption, and `abandon` +
  fresh `plan` is the recovery when concurrent resumes were run anyway.
- **Symlink refusal** and **canonical containment**: resolve the real path and
  assert it is under `~/.agentic-plugins/`. This is why no verb takes `--out`, and
  why every file stem a writer is handed — a fragment name, a proof kind — is
  validated against a strict charset: no `/`, no `\`, no `..`, no leading `.`, no
  NUL. (The validator is `validateProfileName`; its name is left from the profile
  export's `--name`, which it also checked until ADR-0064 Decision 3 removed the
  verb on 2026-10-04.)
- **`$HOME` is the current repository** (some devcontainers): **fail closed** with a
  diagnostic. Bootstrap does not invent a softer posture.
- **`$CODEX_HOME`** is honored wherever it is set; `~/.codex` is the default, not a
  hardcode.
- **A family-wide creation/index lock, not a per-run lock.** A per-run lock cannot
  serialize the thing that actually races: two processes each allocating a *different*
  run id and then both writing `latest.json`. The lock is taken on the `bootstrap/`
  family for run creation, open-run discovery, and `latest.json` writes.
- **Stale locks are recoverable.** A lock whose owning pid is gone, or whose age
  exceeds a bound, is broken with a reported diagnostic — never silently, and never by
  the operator hand-deleting files.
- **A free lock NAME is not proof that nobody holds the family.** Both
  displacement paths — the token-keyed release and the stale break — move the
  lock RECORD aside before deciding what to do with it, and put it back when it
  turns out not to be theirs. A restore that FAILS leaves the record parked while
  the canonical name is free, and its holder still believes it holds the family.
  Acquisition therefore refuses (`lock-displaced`) rather than acquiring beside a
  parked sibling (`<lock>.release-<token>`, `<lock>.breaking-<token>`). It checks
  **twice**, and the second check is the load-bearing one:

  - **before the link**, which catches the PERSISTENT state — a failed restore,
    visible to every scan;
  - **after a successful link**, which catches the TRANSIENT one. For two
    processes to hold the family, a stale break must rename a LIVE holder's
    record aside after a contender's pre-scan and before its link — so in every
    dangerous ordering the park already exists when the link returns, and it is
    still there, because the breaker's restore can only succeed if the canonical
    name is free and the contender is now in it. An attempt that finds a park
    here gives back the lock it just took rather than run beside a holder that
    may still believe it holds the family.

  An earlier version of this rule had only the pre-scan, on the argument that a
  displacing process has already left its critical section so an acquirer
  slipping past is legitimate. That is true of the RELEASE path and **false of
  the stale break**, where the displaced holder is the live one. Measured over 60
  races: 60/60 two-holder outcomes with no check, 3/60 with the pre-scan alone,
  0/60 with both.

  A parked record is never reclaimed automatically — only an operator can tell
  "the holder is gone" from "the holder is still running" — so the refusal names
  the file and both remedies. A restore that puts the lock back but cannot drop
  its parked duplicate reports that too, because that duplicate would otherwise
  block every later run silently.
- `latest.json` is written atomically; a corrupted or orphaned pointer is recovered by
  scanning run directories, and the recovery is reported.
- **Retention**: the last N runs (default 10) are kept; older run directories are
  reported as retention pressure, **never auto-deleted**.
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
- JSON Schema for `runtime-bootstrap-run-1`. (`agentic-machine-profile-1` was
  the other until ADR-0064 Decision 3 removed it on 2026-10-04.)

Tests MUST validate **real artifacts** against those schemas, and MUST assert the
prose tables in §9 and §6 agree with `plugin-set.json` and the step registry. Prose
tokens (§11.3) remain as a floor, not as the enforcement.

### 11.2 `tests/runtime/test-bootstrap.mjs`

**1.2 additions (ADR-0048, realized by the bootstrap-contract-vnext slice).** The
following obligations join the pins below, spread across
`test-bootstrap.mjs` / `test-bootstrap-cli.mjs` / `test-completion-reducer.mjs` /
`test-step-registry.mjs`. (The "Profile 1.1" and "Profile 1.2" obligations, pinned
in `test-machine-profile.mjs`, went with the machine profile: ADR-0064 Decision 3,
2026-10-04.)

- **False-demotion regression**: a passed proof stays `passed` across repeated
  verify/resume — re-judgement reads the RECORDED proof/ files back, never the
  reduced completion cache (mutation-verified: restoring the cache read turns
  the test red).
- **Writer gates**: proof validation is mandatory and internal (no injectable
  validator to forget); unknown evidence kind, kind-discriminator violations,
  writes into any run that is not `open` (reason `run-not-open`) are each refused.
- **Read boundaries**: a schema-invalid manifest cannot prove itself terminal
  (scan), cannot be selected for reduction (selectRun), cannot be updated
  (previous-invalid), and CAN still be abandoned into a valid tombstone.
- **Duplicate evidence**: rejected at the read boundary all-or-nothing, and the
  reducer caps at `incomplete` independent of requiredness.
- **Retired evidence**: `egress-provider-ack.json` and
  `egress-receipt-attestation.json` in a run's `proof/` directory are skipped by the
  reader (named in `retired`, never opened) and an open run holding one still
  resumes; a terminal earlier-minor run's stored egress proof row and receipt
  verdict are projected by the historical path (both paths tested).
- **Migration**: an open 1.1 run resumes into the current stamp
  (`runtime-bootstrap-run-1.5`) + one history row + injected registry-new steps +
  rendered fragments, and an open 1.4 run resumes into the same 1.5 stamp whose history row names the dropped retired step rows while
  `choices[]`, `history[]` and `seeded_from` stay as written; a terminal 1.1 run answers
  exit 50 with `historical`/`not_recertified` and stays byte-identical; a
  future-minor run refuses resume.
- **Answers**: effective-action last-wins (execute-then-decline does not
  execute); `execute` is refused under plan for every proof step.
- **Stage-8 presentation** (§3, §8): the render carries exactly ONE row per
  presented proof, sourced from `completion.proofs[]`, and no Stage-8 row from
  the generic step loop. Pinned across the verdict × control matrix — the row
  states the verdict while the control status disagrees (`absent` + `blocked`);
  a decline stays visible even when the selection stops requiring the proof
  (non-required + `declined`); a `blocked` control joins as a labelled
  `execution:` line; and a report with no `steps` (historical) degrades
  to evidence-only rather than throwing. Reason text is structurally
  neutralized and bounded at the render boundary, so a `reasons` entry carrying a newline or
  a control character cannot fabricate a row (`reasons` is schema-bounded by
  LENGTH only, and its input — a Codex plugin-list version carried through as
  whatever string the host printed — is not grammar-clamped; note that
  neutralization is NOT redaction, which was tried at this boundary and withdrawn
  for eating the 64-hex plan hash). The historical path no longer contributes to
  this obligation: under §3.2 it renders from a projection whose every field was
  reconstructed against an enum, an anchored pattern, or a count, so it carries
  no free text for a control character to arrive in — and a test asserts that
  the projection withholds both free fields rather than that a sanitizer cleaned
  them. The **CONFIG** rows are pinned the
  same way, because they interpolate the same unclamped probe version one loop
  below — neutralized but NOT truncated — and so are the C1 range (U+009B is CSI, which a C0-only helper misses), and the
  BiDi overrides/isolates. The inverse is pinned too: a 64-hex plan hash, an
  email-shaped path component, a double space, and a long-hex path component all
  survive verbatim, because a redacting or whitespace-squeezing sanitizer at
  this boundary breaks the operator's copy-paste — and §3.2 keeps that inverse
  true by construction, since a grammar-clamped `sha256` is exactly the kind of
  value the disclosure invariant admits. A record whose `step_id`
  disagrees with its `kind` is labelled from the KIND and joins no control
  context — the schema validates the two independently and a historical run is
  never re-reduced, so the disagreement is not resolved in the edited record's
  favour. Every rendering rule stated here is mutation-verified:
  reverting any one piece — the loop skip, the verdict source, the filter, the
  execution join, either sanitizer, the length bound, the surrogate guard, the
  kind labelling, or the join guard — turns a named assertion red.

Obligations 4–7 and 30 tested the machine profile and went with it (ADR-0064
Decision 3, 2026-10-04). Their numbers are kept so that tests citing the others
by number stay correct.

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
4. ~~**Profile round-trip**~~ — removed with the machine profile.
5. ~~**User-global-only export**~~ — removed with the machine profile.
6. ~~**Secret fail-close**~~ — removed with the machine profile, whose write gate it
   tested. The run manifest's `boundary.*` rule (§5) is a `const: false` in its
   schema.
7. ~~**Loader isolation**~~ — removed with the machine profile.
8. **No host-config write** — after `plan` + `verify`,
   `~/.claude/settings.json`, `~/.codex/config.toml`, and
   `~/.agentic-plugins/config.local.toml` are **byte-identical**. (Pattern:
   `tests/runtime/test-bootstrap-cli.mjs`. The obligation also ran `profile seed`
   between the two until ADR-0064 Decision 3 removed it on 2026-10-04.)
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
16. **Path security** — an artifact file stem outside the §10.2 charset (`../../x`)
    and `$HOME` equal to the repo root are each rejected. (Until ADR-0064
    Decision 3 removed the profile on 2026-10-04, the obligation named the profile
    export's `--name` and a symlinked profile target.)
17. **Concurrency** — a second `plan` with a run open is rejected; a corrupted
    `latest.json` is recovered.
18. **Schema migration** — an unknown schema major is rejected with a diagnostic; an
    additive minor is accepted (§4.6).
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
30. ~~**Profile overwrite**~~ — removed with the machine profile.
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
    `status` / `verify` / `abandon` exits `40`
    rather than being silently ignored, and an answers file naming a `step_id` that
    is not an expected step of the run exits `40` rather than recording it.

### 11.3 `tests/plugin-shape/test-runtime-plugin.mjs`

Assert this document contains at minimum: `Machine Bootstrap Contract`,
`runtime:bootstrap`, `scripts/bootstrap.mjs`, `runtime-bootstrap-run-1`,
`configured-not-verified`, `Stage 0`, `probeMachineHostState`,
`/artifact-only/i`, `/machine-scoped/i`, `/write-ahead/i`. (Two profile tokens,
`agentic-machine-profile-1` and the profile's "never an input to any activation
or config loader" invariant, left the list with the profile: ADR-0064
Decision 3, 2026-10-04.)

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
- **A cross-machine sync service.** No daemon, no fetch, no push. (The portable
  machine profile, a file the operator carried between machines, was removed by
  ADR-0064 Decision 3 on 2026-10-04; so was this list's "promoting the profile to
  config" entry.)

---

## 13. Open items — scoped to the S8 core/schema subtask

These are **specification work, not open decisions**. The policy, the shape, and the
constraints are fixed above; what remains is filling in exact values inside those
constraints. They are enumerated so S8 does not have to rediscover them, and so that
nobody mistakes "the contract did not say" for "the contract left it open".

| Item | Constrained by |
|---|---|
| Exact JSON Schema files for `agentic-machine-profile-1.3` (1.2 + the ADR-0057 `defaultMode` enum widening; 1.1 was 1.0 + trailing `statusline_preset`, ADR-0048 §2.1; removed with the machine profile by ADR-0064 Decision 3, 2026-10-04), `runtime-bootstrap-run-1.3` (1.2 + the §3.3 value-answer grammar — a SEMANTIC minor: no JSON shape changed, and the bump exists to arm the future-minor mutator fence; 1.2 was 1.1 + the egress evidence vocabulary, ADR-0048 §3), `runtime-plugin-set-1.0` | §4, §5, §1.4 — including the closed-schema rule, the caps, and the canonical key order. Ship as data (§11.1); S8a2 C4. |
| ~~Exact permission-mode enums per host~~ | **Resolved (S8a2 C0).** The **stored** enum carries whatever each host accepts, unsafe values included, because §4.5.3 shows a source machine's value as a labelled note — it must have a field to live in. Safety grading is a **present/seed-side** rule, not a second schema field: never *present* Claude `bypassPermissions`, Codex `approval_policy = "never"`, or `sandbox_mode = "danger-full-access"` as a default. Presentable Claude `defaultMode`: `default` / `acceptEdits` / `plan` / `auto` / `dontAsk` (ADR-0057 §Decision 6 widened the stored enum to the host's own canonical list; neither new mode is unsafe — `dontAsk` is strictly more restrictive than `default`, and `auto` keeps a classifier in the loop rather than bypassing the check). Presentable Codex `approval_policy`: `untrusted` / `on-request` / `on-failure`; `sandbox_mode`: `read-only` / `workspace-write`. **Moot since 2026-10-04 ([ADR-0064](../../../docs/adr/0064-runtime-surface-reduction.md) Decision 3):** these enums lived only in the machine profile and went with it. The safety policy they encoded survives in ADR-0057 D8 and ADR-0038 §6: no permission-relaxing default or hook is ever shipped. |
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
