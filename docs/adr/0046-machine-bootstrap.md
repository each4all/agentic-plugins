# ADR-0046: Machine bootstrap — `runtime:bootstrap` lifecycle command + portable machine profile

## Status

Proposed

<!--
Per AGENTS.md §ADR process and docs/adr/README.md §Process, an ADR merges as
`Proposed` and flips to `Accepted` on review. The owner approved this
*direction* on 2026-07-14 (see §Provenance); the document itself goes through
review as Proposed.

This ADR sits inside the ADR-0024 runtime/operator control-plane track and
does not modify ADR-0035's mutation-tier model or ADR-0041's §2c host-config
non-mutation invariant — it composes both. It DOES supersede one narrow thing:
the nontransactional "re-run, not rollback" execution ordering that
`settings-report-contract.md` documents as current behavior, for the
plugin-management and cleanup executors (Decision §5).

ADR-0006 (native host install, no repo-level setup executable) and ADR-0024
§Alternatives (documentation-only setup rejected) bound the solution space from
the outside; neither is reopened here.

Implementation is staged by the 2026-07-12 macro plan
(`macro-plan-20260712T022752Z-d542f5`): this ADR is subtask S7's durable
deliverable; subtask S8 implements against the companion contract at
`plugins/runtime/docs/machine-bootstrap-contract.md`.
-->

## Context

### 1. There is no single durable record of how to bring up a machine

Reconstructing today's cold start requires reading `README.md`,
`plugins/companions/README.md`, `plugins/runtime/README.md`,
`docs/ARCHITECTURE.md`, and `plugins/runtime/commands/settings.md`. The
marketplace-add step appears in four mutually inconsistent forms (CLI form in
`README.md`; slash form in two plugin READMEs and `docs/ARCHITECTURE.md`;
omitted entirely from `plugins/runtime/README.md`'s Install block). The plugin
set appears as four names in `plugins/runtime/skills/settings/SKILL.md`, six in
`README.md`, and eight in both marketplace catalogs and `doctor.mjs`
`PLUGIN_NAMES`. The drift is not incidental; nothing mechanically holds those
lists in agreement.

### 2. The egress environment variables are documented nowhere

`AGENTIC_NOTIFY_EGRESS_CHANNEL` and `TELEGRAM_CHAT_ID`
(`plugins/runtime/scripts/lib/egress-config.mjs`) appeared, before this ADR, in **zero** markdown
files in the repository — this document and its companion contract are the first. The only way an operator learns their names is to run
`runtime:settings --egress-launcher-plan`, whose output lands under
`.agentic-plugins/runs/egress-launcher/` — a gitignored path. On a machine that
does not yet have runtime installed, that is a circular dependency.

### 3. `runtime:settings` is wrong outside the source tree

Most runtime scripts resolve `repoRoot` from `--repo-root` or, failing that,
`process.cwd()`. (Not all of them are repo-anchored: `compat.mjs` derives
`PLUGIN_ROOT` from `import.meta.url` and reads its packaged baseline from there —
the one cwd-independent precedent, and the shape §11 adopts.) Invoked from an
arbitrary consumer repository, the repo-anchored paths misfire:

- `inspectCatalogs(repoRoot)` finds no marketplace catalogs, so settings emits
  `Add <name> to .claude-plugin/marketplace.json with source ./plugins/<name>`
  and its Codex twin **for all eight plugins on both hosts** — sixteen
  remediations instructing the operator to hand-edit files that do not exist,
  pointing at a `./plugins/` directory that does not exist.
- `inspectSourcePluginState(repoRoot)` returns `present: false`, so
  `sourceVersion` is `null` and the update-recommendation branch never fires.
  A consumer running a stale plugin set gets a clean report.

The failure is **asymmetric and silent**: install recommendations still work
(they are cache/list-based), so nothing signals that the other half of the
report is fabricated. The one surface that could guide a new machine is the one
surface that is wrong on a new machine.

To be precise about the blame: this is a **code defect in one branch**, not a
property of the whole command. `runtime:settings` accepts `--repo-root` and
`--target repo|user|both`, and its contract explicitly permits user-global reads
and writes. Only its **plugin source/catalog branch** is source-checkout-coupled.
Repairing that branch is a prerequisite of this work in its own right — see
Decision §3.

### 4. Runtime cannot bootstrap itself, and on Claude the first step is not even executable

The H2 plugin-management allowlist in `settings.mjs` covers
`claude plugin install|update`, `codex plugin add`, and
`codex plugin marketplace add|upgrade` — but there is **no
`claude plugin marketplace add` case**. So on the Claude side the marketplace
registration is irreducibly manual, and it necessarily precedes installing
`runtime`, which necessarily precedes any `runtime:*` command.

### 5. A repository-level installer was already rejected

[ADR-0006](0006-directory-layout-install-pattern.md) chose each host's native
plugin manager over a unified setup executable. `package.json` is `private`,
carries no `postinstall`, and its `bin` block exposes only the two companions.
There is no pre-plugin entry point, and by ADR-0006 there is not supposed to be
one.

### 6. Documentation-only setup was already rejected as an end state

[ADR-0024](0024-runtime-operator-control-plane.md) §Alternatives rejected it:
operators need a reliable status surface, not a checklist.

### 7. The multi-machine operator re-derives machine #1's choices by hand

[ADR-0041](0041-cross-machine-notification-egress.md) §8 makes egress activation
per-machine by design. `runtime:settings --egress-launcher-plan` already
pre-fills *this* machine's chat-id into the rendered runbook precisely so it can
be copied to other machines (`lib/egress-launcher-plan.mjs`, comment: *"pre-filled
when known (already-active machine → copy it to your other machines)"*). That
primitive exists, and it exists for exactly one value.

### The constraint that governs everything

[ADR-0041](0041-cross-machine-notification-egress.md) §2c: agentic-plugins never
writes host config. It renders; the operator applies. §12 gives the reason in one
line — *a launcher that wrote the activation would itself become the
egress-activation vector §2c closed.*

---

## Decision

### 1. Vehicle — a first-class `runtime:bootstrap` lifecycle command

Not a `runtime:settings` flag. Not a document alone.

`runtime:settings` is a **repo-anchored, single-shot surface** — it takes a
`--repo-root`, builds one report (executing its opt-in mutations and writing its
execution artifact along the way), and returns. It carries no lifecycle across
invocations. Machine bootstrap is a **staged,
resumable lifecycle over the machine**, with an interview, a completion reducer,
and a proof. Those are different kinds of thing, and the difference is not
cosmetic:

- A settings flag would inherit the repo anchor. Machine-setup artifacts would land
  in whichever consumer repository happened to invoke the command.
- It would require a *third* orthogonal report discriminant (source-tree vs
  consumer-machine) on top of the existing **mutation axis** (`dry_run` / `--apply`
  / `--execute-*`) and **evidence axis** (`--skip-host-cli-probes`, per
  `settings-report-contract.md` §1) — on a surface already carrying ~3,300 lines,
  ~95 functions, ~30 flags, four executors, four plan flags, and a six-way
  mutual-exclusion gate whose thrown error cites a governing document by path.
- It would couple bootstrap's completion to `settings.overall.status`, which counts
  plugin recommendations but does **not** gate pass/warn on them — a false pass by
  construction.

Command grammar (subcommand nouns, following `runtime:consensus` and
`runtime:compat`, this repository's existing lifecycle surfaces):

```
runtime:bootstrap plan | status | resume | verify
runtime:bootstrap profile export | seed
```

The exact grammar, flags, and output shapes are the contract's to define
(§11), not this ADR's.

### 2. Two-stage cold start (honest scope, ADR-0001 §5)

- **Stage 0 — pre-runtime. Document-only, host-native, irreducible.**
  Install the host CLIs → `claude plugin marketplace add each4all/agentic-plugins`
  → `claude plugin install runtime@agentic-plugins` (and the Codex equivalents).
  Runtime does not exist yet, and on Claude it could not perform the marketplace
  add even if it did (§Context 4). Stage 0 lives in `README.md` and in the
  contract's Stage 0 section. It is **not a gap to be closed later** —
  [ADR-0006](0006-directory-layout-install-pattern.md) closed it.
- **Stage 1+ — post-runtime.** `runtime:bootstrap` conducts everything else.

`runtime:bootstrap` MUST detect an unsatisfied Stage 0 and print the exact Stage 0
commands rather than failing obscurely.

### 3. Machine scope, not repo scope — this is the execution-root fix

`runtime:bootstrap` is **machine-scoped by construction**.

**The seam is a separate library, not a filtered report.** Bootstrap MUST NOT call
`runDoctor` — that function invokes `inspectSourcePluginState(repoRoot)` and
`inspectCatalogs(repoRoot)` **unconditionally**, and calling it and ignoring the
result is not the same as not consuming it: the reads still happen, and the next
consumer of the filtered report silently re-inherits them. S8 extracts
`probeMachineHostState()` into `scripts/lib/`, bootstrap calls only that, and
`runDoctor` is refactored to consume it so the two cannot drift.

*Rejected: a `scope` parameter on `runDoctor`.* Repo-derived inputs feed its plugin
matrix, hook packaging, host parity, proof reuse, attestations, model/effort
resolution, ledgers, and artifact inventory. A conditional would be pervasive and
would fail open the first time a new consumer forgot it. A separate library fails
closed by construction.

**Marketplace registration needs a probe that does not exist yet.** Doctor parses
Codex help text to detect whether the plugin subcommands exist; it never reads
either host's marketplace inventory. Both hosts expose the read
(`claude plugin marketplace list`, `codex plugin marketplace list`), and both enter
the runtime executor registry as read probes. Where a host cannot answer, the state
is `unknown` — never `satisfied`.

**Plugin-set truth is packaged, and versions are not pinned.** Bootstrap reads a
plugin-set definition **packaged inside the runtime plugin** carrying bundle
membership, hard/soft dependency edges, hook-bearing metadata, and — only where a
real incompatibility demands it — a minimum-version floor. It does **not** pin
current versions: doing so would make every independent plugin release create
runtime freshness debt. Currentness is **advisory, never a completion gate**: `complete` means installed,
enabled, and above the floor — not "newest". Its authority is the **host-registered
marketplace catalog**, read at the `installLocation` the host itself records (a
`$HOME` read, not a `process.cwd()` read). Asking the host CLI directly would not
work: `plugin list` reports no available-update field, `claude plugin update` has no
check-only mode, and the Codex catalog is versionless — a contract that gated
completion on host-reported currentness would make `complete` unreachable.
A CI test compares the packaged definition against both repository catalogs,
closing the four-vs-six-vs-eight drift in §Context 1.

**Domains.** *Machine-global*: host CLIs; marketplace registration; plugin installs;
`~/.claude/settings.json`; `~/.codex/config.toml` (honoring `$CODEX_HOME`);
`~/.agentic-plugins/config.toml`; `~/.agentic-plugins/config.local.toml`; the egress
environment variables. *Repository*: `<repo>/.agentic-plugins/config.toml` overrides
and repo-local `.claude/settings.json`. Bootstrap **diagnoses and orchestrates** the
machine-global domain and reports repository overlays as informational only — it
*owns* nothing but its own artifacts.

The repo-scoped defect in `runtime:settings` (§Context 3) is a **precondition** of
this work, not a byproduct: bootstrap cannot be correct while a surface it composes
is wrong. Repairing that branch — and pinning it with its own consumer-repo
regression, not merely a bootstrap-output assertion — is in scope for the
implementation subtask.

### 4. New mutation-domain authorization — a machine-global M1 artifact home

[ADR-0035](0035-runtime-active-execution-boundary-policy.md) §2 defines **M1** as
agentic-plugins-owned writes only. Every existing artifact family is
**repo-relative**, and `plugins/runtime/docs/artifact-policy.md` governs only
repo-relative paths.

This ADR authorizes, **within M1 and below the ADR-0035 §4 ceiling**, exactly one
new machine-global artifact home:

```
~/.agentic-plugins/runs/bootstrap/<run-id>/    run manifest + rendered fragments
~/.agentic-plugins/profiles/<name>.json        portable machine profile
```

Justification: bootstrap state is **per-machine, not per-repository**. Writing it
into whichever consumer repository happened to invoke the command is the same
category error §3 fixes. `~/.agentic-plugins/config.toml` is already an authorized
user-global agentic-plugins-owned write (`settings --apply --target user`,
ADR-0024 §5); this extends the same **ownership** to artifacts. It is a *location*
extension of M1, **not a new effect class**: no host config, no credentials, no
network, no new executor.

`plugins/runtime/docs/artifact-policy.md` MUST be extended to cover the
machine-global home, and `runtime:doctor --artifact-inventory` MUST include it.

### 5. No second executor

`runtime:bootstrap` is **artifact-only (M1)**. It MUST NOT introduce a new
plugin-management executor. Plugin install/update remains the existing **H2**
executor, reached only through `runtime:settings --execute-plugin-management` with
its exact allowlist. Bootstrap **consumes the default dry-run plan** and
**presents** the explicit command for the operator to run; it never runs it as a
side effect of planning. Any future change to that stance must satisfy ADR-0035 §5's
add-gate on its own terms.

**Corollary — a durability defect this exposes, and the narrow supersede it forces.**

In today's `runtime:settings`, the H2 plugin-management executor runs inside the
report-building path roughly two hundred lines *before* the execution artifact is
written; the retired-plugin cleanup executor has the identical ordering. If the
process dies between them, a machine mutation lands with **no durable record of it**.

Separating the plan half from the execute half is **necessary but not sufficient** —
by itself it changes nothing about ordering. The fix is **write-ahead**: persist the
`planned` intent with a plan hash *before* any action, update the record after
*each* action, finalize at the end.

This **supersedes**, narrowly, the nontransactional "re-run, not rollback" execution
ordering that `settings-report-contract.md` documents as current behavior — for the
plugin-management and cleanup executors only. ADR-0035 §3 already requires atomicity
and partial-failure recovery of M1/H2 mutation; today's ordering does not deliver it,
and bootstrap cannot honestly present an executor whose effects it may never be able
to observe.

**Plan/executor drift.** The presented `--execute-plugin-management` invocation
recomputes a fresh plan rather than consuming bootstrap's. The presented command
therefore carries the **plan hash**; the executor revalidates and, on divergence,
refuses and re-presents rather than executing a plan the operator never read.

### 6. Manual-only host config — unchanged

ADR-0041 §2c stands, verbatim. Bootstrap renders fragments and prints the apply
command; the operator applies. Bootstrap MUST NOT write `~/.claude/settings.json`,
`~/.codex/config.toml`, `~/.agentic-plugins/config.local.toml`, or any credential.
Codex `/hooks` review and trust remain an interactive operator action, recorded
only as an attestation ([ADR-0030](0030-codex-plugin-hooks-removal-stage-aware-migration.md)).

### 7. The portable machine profile — trust and secrecy boundary

The profile is a **secrets-free, enumerated snapshot of one machine's choices**,
emitted by `runtime:bootstrap profile export` and consumed by `profile seed` on
another machine.

**The load-bearing invariant:**

> The profile is an **untrusted source of interview defaults**. It is never
> configuration to apply, and it is **never an input to any activation or config
> loader**.

Concretely, `loadEgressActivation()` MUST NOT read it. A profile that could
activate egress would be exactly the vector ADR-0041 §2c closed — the same
argument §12 makes about a launcher that wrote activation.

**Enumerated content** (an allowlist, never a blob):

- the selected bundle and the exact per-host plugin set
- user-global model and effort
- `notify_*` values: channel, quiet hours + timezone, dedupe TTL, urgent bypass,
  kinds
- egress channel, recipient (chat-id), headline opt-in
- the credential's **environment-variable name** and `required: true` — never its
  value
- Claude user-global `allow` / `deny` / `ask` / `defaultMode`, sanitized
- Codex user-global `approval_policy` / `sandbox_mode`
- observed source host and plugin versions; per-value **scope** and **provenance**

**Categorically excluded**: credential and token values; any authentication
material; repository paths and Codex project-trust entries; Codex `/hooks` trust
attestations (machine- and version-bound, so never portable); caches, transcripts,
workflow state, and generated run state.

**Enforcement — all three, not one:**

1. A **fail-closed secret scrub** on write (the `assertNoSecretInArtifact()`
   round-trip pattern already used by the egress launcher): any secret-shaped
   value refuses the write.
2. A **boundary validator**: the write is refused unless every `boundary.writes_*`
   flag is `false` (the egress launcher's `isValidEgressLauncherPlanArtifact()`
   pattern).
3. A **static test** asserting that no activation or config loader reads the
   profile path.

**On seed**, runtime MUST validate the schema exactly; reject unknown and
secret-shaped fields; preserve each value's scope label; present every value as a
**default requiring confirmation**; and **re-diagnose the target machine** rather
than treating the snapshot as evidence.

### 8. Interview plus document — hybrid, and structurally forced

- **Stage 0**: static document. There is no alternative (§2).
- **Stage 1+**: interactive — *diagnose → present the profile-seeded default → ask
  → render the exact fragment → present the operator's apply command → re-probe and
  confirm*. Because application stays a user action (§6), the loop **must** pass
  through the operator: a document cannot verify, and a stateless planner cannot
  resume.
- A deterministic, non-conversational `plan --format json|text` mode MUST also
  exist, for audit, accessibility, and rerun.

**Division of labor**: the **script** owns facts, schemas, state, and the
completion reducer; the **command runbook / skill** owns conversational pacing.

### 9. Resume means re-probe. Stored completion is never evidence.

Every `resume` and `status` **re-probes live host state**. The run manifest records
*choices and history*, not *truth*. Recorded step state MUST be invalidated when
host CLI, runtime, or plugin versions change.

The completion reducer MUST read step states **directly**. It MUST NOT inherit
`settings.summary.status` (which counts plugin recommendations but does not gate
pass/warn on them) and MUST NOT rely on `plugin_management.summary.blocked` (which
is omitted from top-level completion calculations). Inheriting either produces a
**false pass** — precisely the failure this decision exists to prevent.

### 10. Completion has two terminal states

- **`complete`** requires *all* of: both host CLIs present and authenticated; both
  marketplaces registered; every plugin in the selected bundle installed/enabled or
  explicitly excluded by the operator; user-global model/effort resolving as
  intended; notification and egress configured or explicitly declined (credential
  **presence** only, never its value); every rendered host fragment observed as
  applied by a post-probe; a current Codex `/hooks` review attestation where
  hook-bearing plugins are installed; no stale or unresolved steps; **and a bounded
  cross-host execution proof** (the `runtime:doctor --execute-deep-peer-smoke` /
  `--execute-workflow-continuation-proof` family).
- **`configured-not-verified`** is the state when everything above holds *except*
  the execution proof. Bootstrap MUST report it as such and MUST NOT report
  `complete`.

(`incomplete` is the non-terminal third state — steps remain. The two *terminal*
states are the two above.)

Installed-and-authenticated is not the same as working. This repository already
keeps that distinction; bootstrap inherits it rather than blurring it.

**Which proofs, exactly.** `deep-peer-smoke` is always required — it is the only
evidence that the cross-host companion bridge works. It stays *reachable* because
`companions` is **mandatory in every selection**, including `custom`: a contract that
let `companions` be declined while requiring the smoke proof would define an
unreachable terminal state, and making the proof conditional instead would let a
machine reach `complete` having proven nothing. `workflow-continuation` is required
**iff `engineer` is in the selection** (it exercises engineer machinery; demanding it
without engineer would be unreachable). `permission` is required **iff a permission
fragment was applied**.

**Proof evidence must be machine-global.** Doctor records proofs and Codex hook
attestations repo-relative, so bootstrap run from repository B cannot discover
evidence recorded in repository A — for a *machine* bootstrap, that is a defect.
Bootstrap invokes proofs with an explicit repo-root and copies the **metadata only**
(pointer, hash, bound versions, direction results) into its machine-global run. Raw
peer output is never copied and never printed.

**One-host operators cannot reach a terminal state, and the tool says so.** The
reducer requires both hosts because the framework's value is the cross-host ensemble
and `deep-peer-smoke` is the only proof of it. Precisely: the peer host's
presence/auth/marketplace steps are **not declinable**, so a single-host machine has
unresolved steps and reduces to **`incomplete`** — not `configured-not-verified`,
which requires every expected step to be resolved. Bootstrap names the missing host
and prints its Stage 0 commands rather than looping on an unreachable gate. A narrower
single-host mode is a **non-goal with a trigger** (a real single-host operator): it
would need its own proof story and its own declinable-set rules, and inventing them
before the demand exists is how unused modes get built. Honest scope, recorded rather
than hidden (ADR-0001 §5).

### 11. Durable artifacts — an ADR **and** a plugin-packaged contract, not either/or

They are not substitutes. They live in different places and are read by different
readers.

- **This ADR** (`docs/adr/0046-machine-bootstrap.md`) carries **durable policy**:
  the vehicle, the two-stage boundary, machine-vs-repo scope, the machine-global M1
  authorization, the no-second-executor rule, the manual-only invariant, the profile
  trust boundary, and the proof model. It lives in the **source repository** and is
  read by humans.
- **`plugins/runtime/docs/machine-bootstrap-contract.md`** carries the **evolving
  schemas**: command grammar, profile schema and version, run-manifest schema, step
  and status taxonomy, resume-invalidation rules, bundle membership, the completion
  reducer, and evidence freshness. It **ships inside the plugin package**, and is
  therefore the only one of the two that a runtime command can read from an
  arbitrary working directory. `compat.mjs` reading
  `PLUGIN_ROOT/docs/host-parity-baseline.md` is the precedent;
  `cutover-audit.mjs` reading `repoRoot/docs/...` is the anti-pattern.

This mirrors ADR-0039 + `footer-contract.md` and ADR-0035 +
`settings-report-contract.md`. Field-level schema inside an immutable record
manufactures freshness debt (`settings-report-contract.md` §1) — hence the split.

**The contract MUST be content-token enforced.** `footer-contract.md` is asserted
by content in `tests/plugin-shape/test-runtime-plugin.mjs`;
`settings-report-contract.md` is asserted only by *filename citation*, and no test
ever opens it — so it can drift arbitrarily while CI stays green. The new contract
follows `footer-contract.md`, not `settings-report-contract.md`.

### 12. Bundles (dependency-grounded)

| Bundle | Plugins |
|---|---|
| `base` | `runtime`, `companions`, `attention` |
| `engineering` | `base` + `engineer`, `orchestrator` |
| `business` | `base` + `founder` |
| `design` | `base` + `designer`, `image` |
| `full` | all eight |

**No plugin manifest declares dependencies today** — the relationships are
behavioral, established by code, and the bootstrap plugin-set definition is the
first place they are written down.

Two are **hard**, and one of them is **host-qualified**:

- `orchestrator` → `engineer`, on both hosts: dispatch fails closed on an
  unresolved engineer root.
- `image` → `companions`, **on Claude only**: on Codex, image generation is
  **native** (the in-session gpt-image tool); only Claude routes through
  `codex-companion`. A universal edge here would be wrong.

The rest are **soft**: a persona without `companions` still runs but loses the peer
ensemble, and `attention` without `runtime` has no pipeline to emit into. Hard edges
are enforced per targeted host; soft edges are warned. The contract's §9.1 carries
the table and the evidence.

Promoting these edges into a declared manifest field would force a manifest-schema
decision and a multi-package rollout under ADR-0016. It is recorded as a follow-up,
**not** as implementation-subtask work.

With no seed profile, interactive mode asks which workloads apply; non-interactive
mode requires an explicit bundle. **Exact membership is versioned in the contract,
not here** — bundles will change as plugins ship, and an immutable record is the
wrong home for a list that moves.

---

## Consequences

**Positive**

- A new machine gets one entry point and one durable, **packaged** contract that the
  tool itself can read from any working directory.
- The execution-root defect is **fixed rather than inherited**: sixteen false
  remediations and a silent no-update path stop being emitted on consumer machines.
- H2 plugin management becomes **write-ahead**, so a machine mutation can no longer
  land with no durable record of it. Cleanup gets the same repair.
- The chat-id pre-fill primitive generalizes from one value to a whole machine
  profile, with three independent secrecy guards instead of one.
- `configured-not-verified` makes *"I installed it"* and *"it works"* different
  words.

**Negative**

- A tenth runtime command, with the full lockstep cost: command + skill +
  `agents/openai.yaml` + script (executable bit) + the `RUNTIME_COMMAND_SURFACES`
  exact-set gate + a new test suite + both plugin manifests + the **Claude**
  marketplace catalog (release-please owns both plugin manifests; the Claude catalog
  is synced post-release, and the Codex catalog is **deliberately versionless**) +
  the repo-root docs carrying `plugin-runtime` version tokens. S8 must not guess or
  hand-edit the next runtime version.
- The refactor is **larger than two lifts**: five planners must be split into pure
  build/render plus injected persistence, a machine probe must be extracted, a
  marketplace probe must be added, and the artifact inventory must be parameterized
  off its hardcoded repo root.
- A new machine-global artifact home to govern, secure, inventory, and retain.
- Profile schema migration becomes a standing obligation.
- **Stage 0 remains manual** — until ADR-0006 is superseded. That is a decision, not
  a technical impossibility, and it should be read as one.
- **S8 must be split before dispatch.** This is a composite-state command; the
  implementing subtask's own note requires splitting it into core/schema, public
  surface, and acceptance/docs when S7 lands one. The recommended order is: decide
  the machine-probe and plugin-set seams → repair consumer-repo `runtime:settings` →
  make H2 write-ahead → extract the pure planners and user-global-only readers →
  extend artifact policy and land the machine-global path primitives → land the
  schema validators → then the command surface, tests, and docs.

**Neutral**

- ADR-0024 §4's "settings may assist with marketplace/plugin install" stays true.
  Bootstrap **composes** those planners rather than replacing them; the flags remain.
- ADR-0035's tier model is unchanged. The machine-global home is an M1 *location*
  extension, not a new tier, and no new executor appears.

---

## Alternatives Considered

### A — `runtime:settings --machine-bootstrap-plan` (a fifth plan flag)

The strongest alternative, and the one the supporting evidence favors.
ADR-0024 §4 explicitly says settings *may assist with* marketplace-entry install,
plugin install/update, host-CLI install recommendation, and "generating host-native
commands or config edits when direct mutation would be too risky" — which is
literally this content. And `--notification-plan` (ADR-0040 §4), `--permission-plan`
(ADR-0038), and `--egress-launcher-plan` (ADR-0041 §12) are three consecutive
precedents for landing a state-aware, artifact-only, per-machine planner as a
settings flag. The egress launcher in particular is *structurally identical* to what
bootstrap generalizes.

**Rejected because those are all bounded sub-plans, and bootstrap is not.** "Settings
may assist with X" does not establish ownership of a multi-session, resumable
lifecycle with a completion reducer. Concretely, a flag would: inherit the
source-tree conflation that makes settings wrong on the target machine (§Context 3);
write machine-setup artifacts into whichever consumer repository invoked it;
require a third orthogonal report discriminant (§Decision 1); and couple bootstrap's
completion to `settings.summary.status`, which does not gate on plugin
recommendations — a false pass by construction.

The A-vs-B file-count asymmetry (roughly five files versus twelve) was **excluded
from the comparison** per the project's decision methodology, which weighs quality
axes and explicitly sets implementation effort aside.

**A becomes the better choice if** v1 is deliberately capped at a one-shot,
idempotent plan with no persistent interview, no lifecycle status, and no completion
proof.

### C — ADR and contract document only; no executable surface

Cheapest, and it does fix the documentation hole in §Context 2.

**Rejected**: ADR-0024 §Alternatives already rejected documentation-only setup as an
end state. Prose leaves the human as the state machine and the completion reducer,
cannot verify that a rendered fragment was applied, cannot resume after a partial
application, and cannot pre-fill from another machine. Documentation drift is not a
hypothetical risk here — it is already present (§Context 1). The Stage 0 document
that C proposes is *necessary*, and B includes it; C's error is treating it as
*sufficient*.

**C becomes the better choice if** the goal is explicitly a governance-only PR with
implementation deliberately deferred.

### D — a root-level installer (`npx`, shell script, or npm `postinstall`)

It would genuinely close Stage 0 — the one thing no other option can.

**Rejected on the record**: [ADR-0006](0006-directory-layout-install-pattern.md)
chose each host's native plugin manager over a unified repository-level setup
executable. It would also be the only thing in the repository that runs before a
plugin exists, it cannot operate from an arbitrary consumer repository, and
`package.json` is `private` with no `postinstall` by deliberate design. Reopening
this would require superseding ADR-0006, and nothing in the evidence warrants that.

### E — a new `bootstrap` plugin

**Rejected**: it *worsens* the self-bootstrap problem — now two plugins must be
installed before anything can guide installation — and it has no install-time
boundary distinct from runtime's. [ADR-0010](0010-plugin-boundary-policy.md) §6's
plugin-separation triggers do not fire.

---

## References

- [ADR-0001](0001-hexagonal-architecture.md) §5 — honest scope
- [ADR-0006](0006-directory-layout-install-pattern.md) — native host install; no repo-level setup executable
- [ADR-0010](0010-plugin-boundary-policy.md) §6 — plugin separation triggers
- [ADR-0024](0024-runtime-operator-control-plane.md) §4, §5, §Alternatives — runtime operator control plane
- [ADR-0030](0030-codex-plugin-hooks-removal-stage-aware-migration.md) — Codex `/hooks` review/trust attestation
- [ADR-0034](0034-codex-plugin-list-read-signal.md) — host-native installed-state read signal
- [ADR-0035](0035-runtime-active-execution-boundary-policy.md) §2 tiers, §3 invariants, §4 ceiling, §5 add-gate
- [ADR-0038](0038-runtime-permission-prompt-advisory.md) — permission plan (a settings flag precedent)
- [ADR-0039](0039-completion-footer-activation.md) — the ADR + plugin-owned-contract pairing precedent
- [ADR-0040](0040-operator-observability.md) §4 — notification plan (a settings flag precedent)
- [ADR-0041](0041-cross-machine-notification-egress.md) §2c, §8, §12 — host-config non-mutation; per-machine activation; the egress launcher
- `plugins/runtime/docs/machine-bootstrap-contract.md` — the companion schema contract
- `plugins/runtime/docs/settings-report-contract.md` §1 — the contract-doc-over-ADR precedent for field-level schema
- `plugins/runtime/docs/artifact-policy.md` — artifact families and git policy

## Provenance

Decided through the engineer nine-axis decide workflow
`decide-20260714T034907Z-cef39f` (`--preset=nine-axis --size=major`), with an
independent Codex Brainstorm ensemble `brainstorm-20260714T035236Z-2cacb3b`
(verdict `agreed`; no conflicts). Both sides converged on this option
independently. Weighted aggregate: B 2.56 / A 1.56 / C 0.89; sensitivity under
±20% per-axis weight perturbation: `flipped: false`. Decisive axes (essence,
foundation) ranked `B > A = C`; the supporting axes (recommendation, canonical
precedent) favored A — ADR-0024 §4 does say settings *may assist with* this content,
and three consecutive planner-flags precede it — and were, per ADR-0027 §1.3,
recorded as execution-plan concerns rather than allowed to downgrade the
decisive-axis winner. Owner approved the direction 2026-07-14. Orchestrator macro
`macro-plan-20260712T022752Z-d542f5`, subtask S7.

The draft was then hardened by **two** adversarial Codex Plan-verify rounds, both of
which rejected it.

Round 1 (`plan-verify-20260714T042733Z-003a53`) returned **seven blockers and twelve
factual errors**, and judged the contract not yet ready to hand to the implementing
subtask. Three of its corrections landed on claims this document had made and had
wrong: ADR-0024 never premised that `<repo>` is the source tree (the settings
consumer-repo misbehavior is a code defect in one branch, not a falsified premise);
separating plan from execute does not by itself repair durability (write-ahead does);
and the two marketplace catalogs are not in version lockstep (only Claude's carries a
version).

Round 2 (`plan-verify-20260714T051500Z-0b7c21`) reviewed the revision and rejected it
again — correctly. Its most valuable finding is one this ADR would otherwise have
shipped: the revision's currentness rule ("ask the host whether an update is
available") **is not implementable on either host** — `plugin list` exposes no
available-update field, `claude plugin update` has no check-only mode, Codex offers
only a marketplace-wide upgrade, and the Codex catalog is versionless. Under that
rule every currentness step would have reduced to `unknown` and `complete` would have
been unreachable. Currentness is now advisory, with the host-registered marketplace
catalog as its authority (Decision §3). Round 2 also caught a reachability
contradiction (`companions` declinable while the smoke proof was mandatory), a reducer
contradiction (one-host machines promised `configured-not-verified` but reducing to
`incomplete`), an R0-versus-persistence contradiction, and a self-contradicting
profile-schema rule. All are fixed.

What deliberately remains is specification work inside fixed constraints — exact JSON
Schema files, enum values, the floor table, journal field names — enumerated in the
contract's §13 so nothing is rediscovered and nothing is mistaken for an open
decision.
