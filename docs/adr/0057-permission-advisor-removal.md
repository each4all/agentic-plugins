# ADR-0057: Remove the permission-prompt advisor — the host solved the problem, and the advisor now recommends against the cure

## Status

Proposed

<!--
Supersedes ADR-0038. Amends ADR-0046 (§"Which proofs, exactly" — the
`permission` proof's applicability rule) and ADR-0048 (§1's analogy to the
`permission.<host>.applied` split). Leaves ADR-0035 §4 untouched: this ADR
removes an advisory that sat inside the R0/M1 tiers; it does not move the
ceiling, and §6's Guard-Hook deferral is carried forward verbatim rather than
dropped, because the deferral is a boundary decision and not part of the
advisory being removed. ADR-0046's `:542`-`:545` ("the flags remain") is amended
alongside its proofs clause.

A Plan-verify cross-host review returned `modify` against the first draft and
disproved six of its claims: the retention behaviour (Decision 7), the proof's
uniqueness (twice — §What is worth keeping), the sanitizer surviving whole
(Decision 3), auto mode's role in the empty allow set (§Context), the Codex
`count: 0` mitigation (§Consequences), and the completeness of the removal
manifest (Decision 2). Each refutation is recorded in place rather than silently
applied, because a removal ADR whose own evidence was wrong is the failure it
exists to prevent.
-->

## Context

[ADR-0038](0038-runtime-permission-prompt-advisory.md) shipped a
**permission-prompt advisor**: `runtime:doctor` diagnoses, read-only, which
tool calls are prompting and why (R0), and `runtime:settings --permission-plan`
emits a safety-graded host-config fragment for the operator to apply (M1),
grounded in usage records rather than guessed. Runtime never writes host
config. The design is sound within its premise, and the boundary discipline it
established — §5's sanitization rules, §6's effect-not-ownership refusal to
ship a Guard Hook — is some of the best reasoning in this repository.

The premise is what stopped being true.

**ADR-0038's root cause was allowlist catch-up.** Its evidence sentence:
"This repo's own `.claude/settings.local.json` has accreted **417 lines** of
allow rules and still prompts — evidence that reactive accumulation never
converges." The advisor exists to break that loop by proposing broad proactive
rules from observed evidence.

Measured on this machine 2026-08-27, the loop is not running any more. Claude
Code gained a permission **mode** — `auto` — that decides dynamically instead of
matching an accreting list, and this machine has been on it since 2026-08-26.
`~/.claude/settings.json` reads `permissions.defaultMode: auto` with 139 `allow`
rules and a five-rule `ask` danger gate (`rm`, `sudo`, `git push --force`,
`git push -f`, `git reset --hard`); `.claude/settings.local.json` is **85
lines**, down from the 417 ADR-0038 cited. The catch-up problem was solved by
the host, in the shape ADR-0038 itself named as the most dynamic cure and
deferred — option **B**, a component that decides per call — except the host
shipped it as a first-party mode, so no ADR-0035 §4 boundary was crossed to get
it.

`auto` is not new or exotic. It appears in the packaged host-parity baseline's
own release-note trail from `2.1.207` (observed 2026-07-11), and again at
`2.1.211` ("floors a PreToolUse `ask` under auto mode", observed 2026-07-20).
ADR-0038 §Context even listed `auto` among Claude's permission modes in
2026-06. **The advisor never modelled it.** `autoMode` appears **0 times** in
`plugins/runtime`; the only `'auto'` literals there are `--host auto`, a
host-*detection* flag and a different concept entirely.

### The measurement — the advisor run against the machine it was written for

`runtime:settings --permission-plan --format json`, runtime `0.95.0`, this
machine, 2026-08-27. Claude records: 389 found, 100 used, 7,640 observations,
93 learned rules. The plan it produced:

| Field | Value |
|---|---|
| `recommended.allow` | **`[]`** — zero rules |
| `recommended.deny` | 8, including `Bash(cd *)`, `Bash(cat *)`, `Bash(echo *)`, `Bash(git status *)`, `Bash(mkdir *)`, `Bash(cp *)`, `Bash(du *)` |
| `recommended.ask` | 82, including `Bash(git *)`, `Bash(node *)`, `Bash(ls *)`, `Bash(grep *)` |
| `recommended.default_mode` | `acceptEdits` — while `host_config.default_mode` reads `auto` |
| `conflicts` | 56 |
| `already_allowed_count` | 4 |
| Codex half (`permission_plan_codex`) | `status: baseline`, `recommended.count: 0` — nothing at all |

**Ninety recommended rules, none of them `allow`.** A capability whose stated
purpose is to reduce prompts produced, on the machine that motivated it, an
empty allow set and 90 restrictions. Applying the Claude fragment would deny
`cd`, `cat`, `echo` and `git status`, and route `git`, `node`, `ls` and `grep`
through an approval prompt — strictly *more* prompting than the machine has
today, on top of a working directory it could no longer change into.

The `ask` list also contains 13 entries that are not commands: `Bash(&& *)`,
`Bash(# *)`, `Bash(-c *)`, `Bash(-d *)`, `Bash(-p *)`, `Bash(. *)`, `Bash([ *)`,
`Bash(while *)`, `Bash(for *)`, `Bash(if *)`, `Bash(until *)`,
`Bash(digest_orig() *)`, `Bash(mk() *)` — shell operators, a comment marker, test
brackets, loop keywords, and two shell function definitions, each proposed as a
permission rule.

### Why it inverts — severity poisoning, measured

The inversion is not a grading bug. `gradeCommand` in isolation is correct:

| Command | Grade in isolation |
|---|---|
| `cat file.txt` | `allow` — "known-safe program 'cat'" |
| `echo hi` | `allow` |
| `git status` | `allow` — "read-only git subcommand" |
| `ls -la`, `grep foo`, `node x.mjs`, `du -sh .` | `allow` |
| `rm -rf /` | `deny` — signal `rm-recursive-force` |

The verdict flips in aggregation, through three steps that are each individually
defensible:

1. `generalizeCommand` (`permission-sanitize.mjs:176`–`:203`) keys a pattern on
   the **leading program token** — `basenameProgram(tokens[0])`, plus a second
   token when the program is in `SUBCOMMAND_WRAPPERS` (which is why
   `git status *` exists alongside `git *`). So the compound `cd X && rm -rf Y`
   generalizes to `cd *`.
2. `gradeCommand` grades the **whole line**, so it correctly sees
   `rm-recursive-force` in it.
3. `aggregateObservations` folds grades within a pattern with
   `prev.grade = worstGrade(prev.grade, grade)`
   (`permission-usage-learner.mjs:405`).

**Three distinct failures live here and this ADR does not conflate them**, since
an earlier draft described only the first as if it were the whole story:

| Failure | Direction | Where |
|---|---|---|
| **Severity poisoning** — worst-wins folding over a leading-token key | too **strict**: benign families denied | the three steps above |
| **Pseudo-command emission** — any leading token is accepted, including `&&`, `#`, `[`, `while`, `mk()` | neither: 13 rules that can never match a real program | `generalizeCommand` has no program-shape gate |
| **Wildcard under-grading** — one safe command's grade generalized to a `*` pattern covering unsafe siblings | too **loose**: over-broad `allow` | already recorded at `follow-ups.md:42` |

The first two are what this machine's plan exhibits. The third is the inverse
failure and is what makes "just fix the grader" harder than it looks: the two
directions pull against each other.

Net: **one dangerous compound line condemns an entire benign family.** Census
over this machine's 100 Claude transcripts (7,639 shell observations with a
non-empty generalized pattern, 84 distinct patterns):

| Pattern | n | Grade histogram | Result |
|---|---|---|---|
| `cd *` | 4,524 | ask 4,495 / deny 29 | denied |
| `cat *` | 481 | **allow 322** / ask 158 / **deny 1** | denied by one instance |
| `echo *` | 296 | allow 160 / ask 133 / deny 3 | denied |
| `git status *` | 24 | **allow 16** / ask 7 / **deny 1** | denied by one instance |
| `du *` | **1** | deny 1 | denied on a single compound observation |
| `grep *` | 496 | allow 419 / ask 77 | pushed to `ask` |
| `ls *` | 132 | allow 102 / ask 30 | pushed to `ask` |

- **18 of 84** patterns carry a stricter instance outranking benign ones.
- **1,298 of 7,639** individually-benign observations are absorbed into a
  stricter bucket.
- **2** patterns are pushed to `deny` by a *single* dangerous instance.

**Auto mode causes neither the deny set nor the empty allow set**, and an
earlier draft of this ADR got the second half wrong — it credited `auto` with
the empty allow set. Cross-host review refuted that against the control flow, and
the correction matters because it changes what the mode is evidence *of*:

- The allow / ask / deny buckets are decided entirely from the learned grade and
  the operator's standing rule buckets (`permission-plan.mjs:224`–`:290`). The
  empty allow set is caused by **the operator's 218 standing allow rules** —
  all 4 `allow`-graded rules were absorbed as `already_allowed_count` — and would
  appear identically on a `default`-mode machine with the same rules.
- `hostConfig.defaultMode` is first read at `:294`, *after* that loop, and is
  used for exactly one thing: the `acceptEdits` recommendation.

So `auto` does not distort the plan. It **exposes a stale mode vocabulary** —
one field, one wrong recommendation — while the 90 restrictions come from the
grader and the aggregation. Both defects are independent of the mode, and the
follow-up ledger already carries the first half of the second:
`plugins/runtime/docs/follow-ups.md` rows 42 and 43 record "safety grade vs.
wildcard generalization" and "grader vs. pattern-emitter divergence on a
path-shaped program". This ADR does not fix them. It records that the layer they
sit in is no longer worth repairing.

**The census is a point-in-time measurement over unfrozen input.** The
transcripts it reads are this machine's live `~/.claude/projects` tree, which
moves; no input snapshot or hash is committed, so a rerun will drift. The
numbers are evidence of the *mechanism*, which is decidable from the code, not a
reproducible constant.

### The obsolete vocabulary has leaked into a protected, non-advisor contract

`permission-plan.mjs:294` gates the mode recommendation on
`hostConfig.defaultMode === 'acceptEdits' || hostConfig.defaultMode ===
'bypassPermissions'`. Neither matches `auto`, so `modeAlreadySet` is false and
the planner recommends switching *away* from the mode the operator chose. That
is contained inside the advisor and dies with it.

What is not contained is the same vocabulary in
`plugins/runtime/data/schemas/agentic-machine-profile-1.2.json:197`:

```json
"defaultMode": { "enum": ["default", "acceptEdits", "plan", "bypassPermissions", null] }
```

Measured through the packaged validator, with both controls behaving
(`acceptEdits` → no `defaultMode` error; `nonsense-xyz` → error):

| `defaultMode` | Packaged-validator verdict |
|---|---|
| `"auto"` (this machine's real value) | **rejected by the enum** |
| `"acceptEdits"` | accepted |
| `"nonsense-xyz"` | rejected by the enum |

**The portable machine profile treats this machine's actual permission mode
exactly as it treats a nonsense string.** The schema's own description says the
stored enum "carries whatever each host accepts, unsafe values included, because
a source machine's value is shown as a labelled note and **must have a field to
live in**." For `auto`, there is no field to live in. The profile is the
vehicle for reproducing this setup on a new machine, so the consequence is not
cosmetic: a reproduction either loses the operator's chosen mode or refuses.

`plugins/runtime/docs/host-parity-baseline.md:184` carries the same gap —
"Claude exposes permission modes such as `default`, `plan`, `acceptEdits`, and
`bypassPermissions`" — with no `auto`. Both files are **PROTECTED PATHS** under
[ADR-0052](0052-release-obligation-enforcement.md).

### What is worth keeping — and one thing the plan called advisor machinery that is not

`proof.permission` reads as advisor machinery because of its name and its
Stage-6 gate. It is not. `buildPermissionProofSection` (`doctor.mjs:3398`) takes
`{requested, execute, readiness, claude, codex, companion, modelEffort,
repoRoot, env, runner, timeoutMs}` — **no advisor input of any kind**. Its
prompt asks the peer to run under the current host policy and refuse elevation,
and the section it emits records:

```
permission_policy: { host_native_default: true, relaxed_by_doctor: false, injected_flags: [] }
```

That is live evidence for **ADR-0035 §4** — runtime injects no sandbox,
approval, or permission-mode relaxation. **The scope of that claim was narrowed
during drafting and the narrowing is recorded rather than quietly applied**: an
earlier version called it "the only evidence of that invariant", which
transverse measurement refuted. `tests/plugin-shape/runtime-executor-registry.mjs`
is described in its own header as "the data half of the ADR-0035 §4
active-execution boundary guard", and with `runtime-executor-scan.mjs` it proves
*statically* that no child-process / `fs` / network primitive appears outside the
allowlist. That is real §4 evidence and it survives untouched.

**A second narrowing followed, from the same review**, and the two together are
why this paragraph is worded as carefully as it is. `proof.deep-peer-smoke`
performs the *same* live companion invocation under the same host policy
(`doctor.mjs:4720`–`:4755`), so the permission proof is not the only run that
*exercises* unrelaxed execution. What is unique is narrower: it is the only one
that **explicitly records** the fact as a claim —
`permission_policy: {host_native_default, relaxed_by_doctor, injected_flags}`
appears at `doctor.mjs:3464` and `:3616`, both inside the permission-proof path
and nowhere else, and is rendered at `:6003`.

So the accurate claim, after two corrections, is: `proof.permission` is the
**dedicated live proof that records the no-relaxation fact**. The static guard
proves runtime cannot contain a relaxation primitive; deep-peer-smoke
incidentally runs without one; only this proof asserts and records it. That is
still worth keeping, and it is a smaller claim than either earlier draft made.

What must not survive is its **coupling** to the advisor. `step-registry.mjs:315`
makes the proof `applicable` only when
`permissionFragmentApplied[host] === true`, i.e. only when the operator applied
an advisor fragment. A boundary proof gated on an advisory artifact is
backwards, and ADR-0048 §D1 already named the hazard in its own rejection
rationale ("invites false coupling to `proof.permission`"). Removing the advisor
without decoupling the proof would silently make the proof permanently
non-applicable — the ADR-0035 §4 evidence would disappear as a side effect of
deleting something else.

Two library modules are likewise not advisor-exclusive:

- **`permission-sanitize.mjs` (204 lines) is generic transport.** Measured
  consumers: `dashboard.mjs`, `doctor.mjs`, `settings.mjs`, `state-readers.mjs`,
  `machine-probe.mjs`, `machine-profile.mjs`, `assurance-result.mjs`,
  `host-assurance-facts.mjs` — **eight non-advisor importers**, plus the
  advisor's three. `agentic-machine-profile-1.2.json:270` names it *normatively*
  as the sanitizer the profile's permission arrays pass through.
- **`permission-config.mjs` (134 lines) splits.** `parseCodexPermissionConfigToml`
  is generic — `profile-readers.mjs:24` imports it, and `settings.mjs:47`
  re-exports it. `readClaudePermissionConfig` / `readCodexPermissionConfig` are
  advisor-only.

## Decision

### Decision 1 — Remove the permission advisor (ADR-0038's A + C core)

`runtime:doctor --permission-diagnosis` and
`runtime:settings --permission-plan` are removed, along with the usage learner,
the safety grader, the fragment builders, and the advisory artifact family.
Runtime no longer offers an opinion about host permission configuration.

ADR-0038 is **superseded** by this ADR.

### Decision 2 — The removal manifest is by identifier, not by the word

The word `permission` appears in **178 files** in this repository. That number
must not be used to scope the work, and this ADR states the trap explicitly
because [ADR-0056](0056-assurance-matcher-removal.md) §Decision 2 hit the same
one, and because the macro plan's own estimate (44 files, ~4,825 exclusive
lines) was derived by a different method than the one below and does not
reconcile with it — measured here, `doctor.mjs` alone carries 236 lines
mentioning the word, not the plan's 163.

The word is generic in most of its occurrences: filesystem permissions in error
strings (`bootstrap.mjs:708`, `:758`), Claude/Codex host permission *concepts*
in the parity baseline and skill prose, and ADR-0035's boundary language.

**Three surfaces are close enough in name to be deleted by accident, and none of
them is advisor machinery.** Each is named here for the same reason ADR-0056
§Decision 2 named designer's and engineer's "quality assurance":

| Surface | What it actually is |
|---|---|
| `plugins/attention` `Notification/permission_prompt` (`adapters/claude/hooks/hooks.json:5`, `notification.mjs:49`, `:59`, `sensor.mjs:143`, `:285`, README `:22`, `:122`) | a Claude **hook `notification_type` matcher**, the ADR-0040 §3 attention sensor. A different plugin, a different concept, and untouched. |
| `runtime:doctor --sandbox-permission-probe` (`doctor.mjs:130`, `:347`, `:443`, `buildSandboxPermissionProbeSection`) | a read-only preflight over CLI / auth / feature-surface / companion-script readiness. Verified: it takes `{requested, readiness}` and reads `readiness.<direction>.sandbox_permission` — **no advisor input**. Survives. |
| `runtime:doctor --permission-proof` / `--execute-permission-proof` | the ADR-0035 §4 boundary proof — Decision 5. Survives, decoupled. |

Historical evidence records, changelog entries and retained advisory artifacts
are likewise left alone: they record what was observed at the time.

**Modules removed in full**

| Module | Lines | Role |
|---|---|---|
| `plugins/runtime/scripts/lib/permission-advisor-core.mjs` | 828 | prompt causes, safety grades, `gradeCommand`, rule/fragment contracts, advisor invariants |
| `plugins/runtime/scripts/lib/permission-plan.mjs` | 591 | `buildCrossHostPermissionPlan`, `gatherPermissionPlanInputs`, `renderCodexConfigToml` |
| `plugins/runtime/scripts/lib/permission-usage-learner.mjs` | 502 | transcript/rollout parsers, `aggregateObservations`, `learnFromSources` |
| `plugins/runtime/scripts/lib/permission-artifacts.mjs` | 570 | the `permission` advisory artifact family |
| `plugins/runtime/scripts/lib/permission-usage-sources.mjs` | 123 | usage-record enumeration |

2,614 lines. **`permission-sanitize.mjs` and `permission-config.mjs` are not on
this list** — see Decisions 3 and 4.

**Consumers to rewire.** Each carries more than an import line, and the
implementation must visit every site:

- `doctor.mjs` — the `--permission-diagnosis` flags (`:148`–`:150`), the
  section builder (`:314`), the report field (`:482`),
  `permissionDiagnosisLimits` (`:2450`, `:2494`, `:2522`, `:2575`), and the
  `getPromptCause` import (`:23`)
- `settings.mjs` — the `--permission-plan` flags (`:2891`–`:2900`), the
  cross-host plan **call site** (`:463`–`:478` — an earlier draft cited `:2741`,
  which is only the comment), the import (`:20`), the two mutation-boundary
  strings (`:625`, `:626`), the usage line (`:2816`), and the
  `parseCodexPermissionConfigToml` re-export (`:47`, which stays — Decision 4)
- `bootstrap.mjs` — Stage 6 (`:1897`–`:1908`), the applied-state derivation
  (`:1023`, `:2317`–`:2327`), the two re-derivation sites (`:2747`, `:2827`),
  the `--from-run` reconstructions (`:3344`, `:3777`–`:3839`), and the two
  advisor imports (`:138`, `:139`)
- `state-readers.mjs` — the `permission` entry in
  `RUNTIME_ARTIFACT_FAMILIES` (`:161`) and its comment (`:154`–`:155`)
- **`step-registry.mjs` and `completion-reducer.mjs` — added after review, and
  the omission mattered**: `stepIds.permissionApplied` (`:75`), the Stage-6
  emission (`:259`), and the proof's `applicable` / `blocked_by` (`:315`,
  `:317`) in the registry; the `permissionFragmentApplied` reconstruction
  (`completion-reducer.mjs:772`–`:775`) and its hand-off to
  `deriveExpectedSteps` (`:783`). Decision 5 governs what replaces them.
- `notification-plan.mjs` — the two stale by-reference analogies (`:43`, `:702`)
  that cite `permission-artifacts.mjs` as the precedent for their own shape.
  These are comments, not code, but a comment pointing at a deleted module is a
  dangling reference of the same kind the amendments in Decision 10 exist to fix.

**Two public exports disappear and are BREAKING beyond the CLI flags**:
`doctor.mjs:84`–`:88` re-exports `collectUsageRecordSources`, and
`settings.mjs:48`–`:50` re-exports `renderCodexConfigToml`. Both are module
surface, not flags, and neither is covered by the flag list in Consequences.
- `tests/plugin-shape/runtime-executor-registry.mjs` — the
  `permission-artifacts.mjs` entry (`:682`–`:686`, primitives `mkdir` /
  `writeFile` / `rename` under `.agentic-plugins/runs`). This one is easy to
  miss and **fails closed if missed in either direction** — verified by
  mutation, not assumed: injecting an entry for a non-existent module makes
  `test-runtime-executor-guard.mjs:1183` fail with "should exist in the runtime
  scripts tree", so the ADR-0035 §4 guard rejects a stale allowlist entry as
  firmly as it rejects an unlisted primitive. Because Decision 7 deletes
  `permission-artifacts.mjs` whole, the entry is deleted outright — no
  replacement entry is needed, since nothing survives to write under `runs/`.

**Tests removed or reduced**: `test-permission-advisor-core.mjs` (638),
`test-permission-artifacts.mjs` (600), `test-permission-acceptance.mjs` (321),
`test-permission-usage-learner.mjs` (236), `test-permission-usage-sources.mjs`
(160) removed; `test-permission-config.mjs` (75) and `test-permission-sanitize.mjs`
(173) **survive** per Decisions 3 and 4; `test-planner-purity.mjs` (256) loses
its `permission-plan.mjs` closure assertions and keeps the rest;
`test-usage-records-fixtures.mjs` (111) and
`tests/runtime/fixtures/usage-records/**` (210 lines, **7** files — an earlier
draft said 6, omitting `claude-secret-redaction.jsonl`) go with the learner.
`test-settings.mjs`, `test-doctor.mjs`, `test-bootstrap.mjs` and
`test-bootstrap-cli.mjs` lose their permission-section cases.

**Five further test files carry Stage-6 / proof expectations and were missed by
the first draft**: `test-runtime-plugin.mjs:321`–`:345`,
`test-settings-probe-boundary.mjs:41`–`:48`, `:123`–`:132`, `:381`–`:387`,
`test-step-registry.mjs:138`–`:145`, `:209`–`:216`, `:304`–`:371`,
`test-completion-reducer.mjs:172`–`:220`, `:756`–`:827`, and
`test-effective-selection.mjs:101`–`:109`. `advisor-impl` adds one test that does
not exist today: a **`defaultMode: "auto"` control** against the Decision 6
schema, since the enum widening is exactly the kind of change that passes
vacuously without one.

**Documentation**: `plugins/runtime/docs/usage-records-source-map.md` (240
lines) is advisor-exclusive and goes. `commands/doctor.md`,
`commands/settings.md`, `commands/bootstrap.md`, the doctor / settings /
bootstrap skills, both `agents/openai.yaml` mirrors, and
`plugins/runtime/README.md` lose their advisor clauses.
`docs/settings-report-contract.md` (§flag list `:53`, the report-field row
`:226`, the dry-run-vs-artifact clause `:263`, the family erratum `:296`) loses
its advisory sections.

**`docs/machine-bootstrap-contract.md` is the largest documentation surface and
the easiest to under-scope**, so its sites are enumerated rather than described.
Beyond the planner lift tables (`:180`–`:194`), the no-`repoRoot` rule (`:200`)
and the failure-boundary section (`:215`), it carries **five normative sites**
for the step model Decision 5 changes:

| Site | What it states |
|---|---|
| `:1312`–`:1313` | the §8.1 rule that the `permission` proof is required iff a `permission.*.applied` step carries `fragment_applied: true` |
| `:1377`–`:1378` | the Stage 6 rows `permission.claude.applied` / `permission.codex.applied`, applicability "always", declinable "yes" |
| `:1382` | the `proof.permission` row, with the same fragment-gated applicability |
| `:1542` | the blocked-by table: `proof.permission` ← every applicable `permission.<h>.applied` |
| `:2007` | the prose explaining that reprobe-time promotion of `fragment_applied` feeds §6.1's applicability derivation |

Rows `:1377`–`:1378` are deleted; `:1312`–`:1313`, `:1382`, `:1542` and `:2007`
are **rewritten to the new applicability**, not deleted — the proof survives and
its contract has to say what now governs it. Cross-host review found **ten
further sites in the same file** the first enumeration missed — `:425`–`:434`,
`:616`–`:636`, `:1047`–`:1051`, `:1195`–`:1211`, `:1527`–`:1543`,
`:1799`–`:1802`, `:1982`–`:2008`, `:2185`–`:2192`, `:2819`–`:2822`,
`:2937`–`:2940` — which is itself the argument for enumerating rather than
describing. This file is **not** a protected path under ADR-0052, so these edits
add no release-obligation debt beyond the two protected paths named in
Consequences.

**Four more surfaces outside `plugins/runtime/docs/` also describe the removed
capability**, and none was in the first draft: `plugins/runtime/README.md:134`–`:139`
(alongside `:41`, `:42`, `:56`, `:57`), `settings-report-contract.md:35`–`:56`,
the packaged manifest `plugins/runtime/.codex-plugin/plugin.json:38`, and the
repository stage docs `docs/DEVELOPMENT.md:95`–`:103`, `:560` and
`docs/ARCHITECTURE.md:252`. The manifest one matters disproportionately: it is
**packaged**, so a stale description ships to both hosts. `docs/artifact-policy.md` needs two narrower edits, not a
section removal: `:147`'s family list keeps `permission` per Decision 7, and
`:130`'s sanitization rule — which is illustrated *by* the advisory — is
re-illustrated from a surviving consumer rather than deleted, because the rule
outlives its example.

### Decision 3 — `permission-sanitize.mjs` SPLITS; only its generic half survives

An earlier draft of this ADR said the module "survives whole". **Cross-host
review refuted that**, and the refutation is recorded because the draft was
internally inconsistent as a result: it simultaneously claimed the module
survives whole *and* described `generalizeCommand` as living "inside modules
Decision 1 deletes". Both cannot be true, and measurement settles which.

The file has two halves with disjoint consumers:

| Exports | Lines | Consumers | Disposition |
|---|---|---|---|
| `singleLine`, `hasCredentialShape`, `redactSecrets`, `sanitizeValue` | `:22`–`:84` | `dashboard`, `doctor`, `settings`, `state-readers`, `machine-probe`, `machine-profile`, `assurance-result`, `host-assurance-facts` — **8 non-advisor** | **survives** |
| `tokenizeCommand`, `stripEnvAssignments`, `generalizeCommand` | `:142`–`:204` | `permission-advisor-core.mjs` and `permission-usage-learner.mjs` **only** — both deleted by Decision 1 | **removed** |

The generic half — which carries the normative citation in the protected schema
at `agentic-machine-profile-1.2.json:270` — moves to `lib/sanitize.mjs`, with
`lib/permission-sanitize.mjs` retained as a re-exporting shim.
`test-permission-sanitize.mjs` is **reduced to the surviving exports**, not kept
whole; its `generalizeCommand` cases go with the function.

**The "second debt window" rationale from the earlier draft is withdrawn.** It
argued for deferring the schema's `:270` citation update to a later release to
avoid opening protected-path debt twice — but Decision 6 already edits
`agentic-machine-profile-1.2.json` at `:197` in *this* removal, so the file is in
the release either way and there is no second window to avoid. `advisor-impl`
decides the citation rename on migration scope alone: update `:270` alongside
`:197` if the shim is retired in the same release, or leave the citation
accurate against the shim if it is not.

If `advisor-impl` measures the rename as not worth its cost, keeping the current
name for the surviving half is acceptable — but it must say so, rather than
leaving the question unasked.

### Decision 4 — `permission-config.mjs` splits by consumer, not by file

`parseCodexPermissionConfigToml` and its `unescapeTomlBasic` helper are generic
Codex-config reading and stay (`profile-readers.mjs:24`, `settings.mjs:47`).
`readClaudePermissionConfig` and `readCodexPermissionConfig` exist only to feed
the planner and go with it.

The surviving half moves to `lib/codex-config.mjs`, again with a compatibility
re-export from the old path, and `test-permission-config.mjs` is reduced to the
surviving functions rather than deleted.

`settings.mjs:47`'s own re-export of `parseCodexPermissionConfigToml` is a
separate question and is left to `advisor-impl` with the measurement attached:
its only consumer is `tests/runtime/test-settings.mjs` (`:14`, `:2146`) — the
sole *production* import is `profile-readers.mjs:24`, which reaches the library
directly. A re-export kept alive only by the test that asserts it is a
reasonable thing to drop, and equally reasonable to keep as a stable surface;
what it must not be is retained by accident.

**One inconsistency is recorded here rather than fixed**, because it is real and
`advisor-impl` will meet it: the two Claude permission readers disagree on
casing. `permission-config.mjs`'s `readClaudePermissionConfig` returns
`defaultMode`; `profile-readers.mjs`'s `projectClaudePermission` returns
`default_mode`, and `machine-profile.mjs:191` reads the snake_case form. Both
are internally consistent with their own callers today — this was checked
against the tree, not assumed — so there is no live defect. Removing one reader
leaves one casing, which is the improvement; it is named so nobody "fixes" the
survivor's casing and breaks `machine-profile.mjs`.

### Decision 5 — Stage 6 goes; `proof.permission` survives, decoupled

This is the split the macro plan asked to be decided explicitly, and the two
halves resolve in opposite directions.

**Stage 6 (`permission.<host>.applied`) is removed.** Both steps mark that an
operator applied an advisor-rendered fragment. With no fragment, the step has no
referent, and a declinable step nobody can satisfy is worse than no step.

**`proof.permission` is retained and its gate is rewritten.** Its applicability
changes from "a permission fragment was applied on some host" to **always
applicable and declinable**, matching `proof.deep-peer-smoke` — the proof it is
structurally a sibling of. Both exercise the companion bridge under host policy;
this one additionally *records* that runtime added no relaxation flags.

**Applicability is not the only edge, and an earlier draft addressed only that
one.** The step carries `blocked_by: PLUGIN_SET_HOSTS.map((h) =>
stepIds.permissionApplied(h))` (`step-registry.mjs:317`), so deleting Stage 6
without replacing those edges leaves the proof blocked by steps that no longer
exist. `advisor-impl` **replaces** them rather than emptying them — the sibling
`proof.deep-peer-smoke` blocks on `hostAuthenticated` for both hosts plus the
`companions` install/enable steps (`:290`–`:294`), which is the shape a live
companion proof actually depends on, and is what this proof's edges should
become.

A second consumer reconstructs the removed input and must be rewired with it:
`completion-reducer.mjs:772`–`:775` rebuilds `permissionFragmentApplied` from the
Stage-6 rows and hands it to `deriveExpectedSteps` at `:783`. Left alone it
would compute `{claude: false, codex: false}` from absent rows and silently make
the proof non-applicable — reintroducing, through the reducer, exactly the
coupling this decision removes.

`advisor-impl` decides the **name**. The proof no longer relates to a permission
*plan*, and `permission` now reads as vestigial; but renaming it is a
`runtime-bootstrap-run` schema change on a protected path, and a rename also
invalidates the existing `proof.permission` rows in retained run manifests.
Three shapes exist and none is a default: keep the name (cheapest, mildly
misleading), rename to something like `proof.unrelaxed-execution` with a legacy
reader (honest, one more protected-path edit), or fold it into
`proof.deep-peer-smoke` as an assertion (smallest surface, loses the ability to
decline one without the other). The decision is made with the schema in front of
it, and it is published.

### Decision 6 — `defaultMode`'s enum is a host-truth question, and it is fixed, not deleted

`permissions.claude.defaultMode` in `agentic-machine-profile-1.2` is **not**
advisor machinery — the profile records host configuration for reproduction, and
would need this field if ADR-0038 had never existed. It stays, and its enum is
corrected to include `auto` (and any other mode the host currently accepts,
enumerated from the host at implementation time rather than from memory).

Because the enum lives in a protected path, this is a schema change:
`advisor-impl` states whether it is a minor bump with a dual-era reader or a
`1.3`, and names the reader behaviour for profiles written under `1.2` — which
can never contain `auto`, so nothing is reinterpreted, only newly admitted.

`machine-profile.mjs:644`'s `UNSAFE_CLAUDE_MODES` seeding note cites ADR-0038 in
its operator-facing text. The **behaviour** — do not propose a source machine's
`bypassPermissions` as a target default, show it as a labelled note — is a
safety property of profile seeding and survives; only the citation is
re-pointed at this ADR.

`plugins/runtime/docs/host-parity-baseline.md:184`'s permission-mode list is
corrected in the same release for the same reason.

### Decision 7 — Existing permission artifacts become a read-only historical inventory

`.agentic-plugins/runs/permission/**` is **not deleted**. Retained advisory runs
are evidence of what the advisor recommended when it ran, including the
inverted plan this ADR is built on.

- The `permission` family stays in `RUNTIME_ARTIFACT_FAMILIES`
  (`state-readers.mjs:161`) as a **historical, read-only** family: `dashboard`
  and the artifact inventory continue to **see, count and age** it.
- **It is not garbage-collected, and an earlier draft of this ADR said it was.**
  Cross-host review refuted that against the tree and the correction is recorded
  rather than silently applied. `RETENTION_FAMILY_REGISTRY`
  (`retention-planner.mjs:66`–`:84`) is a **frozen, closed** registry of exactly
  `doctor` / `compat` / `settings`, pinned by
  `test-retention-planner.mjs:73`–`:76`; `permission` has never been a member.
  Retained advisories are therefore inventory-visible and **retention-excluded**
  — they accumulate rather than expire. That is the status quo, and this ADR
  keeps it: widening deletion authority to a family whose producer is being
  removed would need its own ADR-0047 amendment and manifest, and deleting the
  only surviving record of what the advisor recommended is the opposite of what
  Decision 7 is for.
- **No reader survives, because none is needed.** An earlier draft of this ADR
  required reducing `permission-artifacts.mjs` to "the readers retention and
  dashboard need", in the shape ADR-0056 §Decision 5 used for
  `projectRecordedAssurance`. That obligation was **manufactured, and is
  withdrawn**: `inspectArtifactScope` (`state-readers.mjs:809`) enumerates a
  family by **directory segment** (`segments: [family]`) and never parses an
  artifact's contents, so retention and dashboard need nothing from the module.
  `permission-artifacts.mjs` is deleted whole, as Decision 2 lists. Carrying a
  legacy decoder nothing calls would be dead code justified by a false analogy —
  ADR-0056 kept `projectRecordedAssurance` because a doctor artifact's assurance
  *section* genuinely had to be decoded; here there is no analogous read.
- **The registration is documentation, not behaviour**, and the ADR says so to
  keep the reason honest. `inspectRuntimeArtifactInventory` passes
  `discoverUnknownFamilies: true`, and a discovered family is assigned
  `retentionCap: policy.run_count_cap` (`:833`) — the same cap the explicit entry
  supplies. Removing `'permission'` from the list would therefore change nothing
  observable. It stays so the family is **declared** rather than silently
  discovered, and so the comment at `:154`–`:155` can be re-pointed from ADR-0038
  to this ADR instead of deleted.
- A retained advisory is reported as historical and is **never** projected into
  a current recommendation.

### Decision 8 — ADR-0038 §6's Guard-Hook deferral is carried forward, not dropped

ADR-0038 §6 refused to ship a `PreToolUse` policy component, classified by
**effect** rather than by who flips the switch, and pinned four conditions any
future ADR must meet. That refusal is a boundary decision about ADR-0035 §4 —
independent of whether an advisory exists — and superseding ADR-0038 must not
quietly vacate it.

It is restated here as binding, unchanged in substance: agentic-plugins ships no
permission-relaxing component; revisiting that requires a separate ADR that
amends ADR-0035 §4 head-on, names a permission-relaxation tier, treats the
cross-host asymmetry as a first-order cost, and pins the conditions ADR-0038 §6
items 1–4 list.

If anything, the evidence for the refusal is now stronger: the host shipped the
dynamic decision itself, which is the outcome a Guard Hook was wanted for, and
it arrived without agentic-plugins relaxing anything.

### Decision 9 — The residual ledger migrates per finding, and is not silently closed

`plugins/runtime/docs/follow-ups.md` rows 42, 43 and 45 name advisor defects.
`advisor-impl` produces an **enumerated before/after mapping**, one entry per
row, into `resolved by removal` / `survives` / `splits`, naming this ADR on any
row closed as resolved.

Two are already known to be non-trivial and are stated so the triage is not
done by shape:

- **Rows 42 and 43 are `resolved by removal`** — both describe divergence
  between `gradeCommand` (in `permission-advisor-core.mjs`, removed by
  Decision 1) and `generalizeCommand` (in `permission-sanitize.mjs`, removed by
  **Decision 3**, not Decision 1). The first draft attributed both to Decision 1
  while simultaneously claiming the sanitizer survived whole — the two halves of
  the same contradiction Decision 3 now resolves. Both functions go; the rows
  resolve.
- **Row 45 `splits`.** It reports `skills/settings/SKILL.md`'s frontmatter
  `description` exceeding Codex's 1,024-character skill-creator cap, noting the
  field was already ~1.6k *before* the advisor clause pushed it to ~1.8k.
  Removing the clause shrinks it and does **not** clear the cap. The row
  survives with a smaller number.
- **Rows 66 and 82 were missed by the first draft** and both touch the step
  model this ADR changes. Row 66 — a decline recorded while a step was
  non-applicable becoming a sticky waiver once it applies — bears directly on
  Decision 5, since the proof's applicability is exactly what changes; whether it
  is resolved, survives, or splits depends on the `blocked_by` replacement.
  Row 82 — unpinned fragment-composition readers, whose builders re-read config
  independently of the snapshot — is half about the permission fragment and half
  about the others, so it is a **`splits`** candidate and must not be triaged
  whole.

The **severity-poisoning mechanism measured in §Context is not filed as a new
row.** It is resolved by removal, and recording it as a follow-up would imply
somebody should fix it.

### Decision 10 — Amendments to accepted ADRs, and atomic supersession

**Supersession is atomic with acceptance**, following
[ADR-0056](0056-assurance-matcher-removal.md) §Decision 9. This ADR's own PR
edits ADR-0038's Status line to read *proposed to be superseded* — and to state
what is **not** superseded, which for ADR-0038 is §6 (Decision 8). The commit
that flips this ADR to `Accepted` flips that line to `Superseded by ADR-0057` in
the same commit. An accepted ADR pointing at a proposed one, or the reverse, is a
state the index must never show.

Two further accepted ADRs normatively prescribe surfaces this ADR removes. Both
are amended in place by `advisor-impl`, in that same acceptance commit.

- **[ADR-0046](0046-machine-bootstrap.md) — two clauses, not one.**
  §"Which proofs, exactly" states "`permission` is required **iff a permission
  fragment was applied**", which is precisely the coupling Decision 5 removes;
  it is amended to state the proof's new applicability and its independent
  justification. **`:542`–`:545` is the clause the first draft missed**: it
  states that bootstrap *composes* the settings planners and that "the flags
  remain" — a present-tense claim about `--permission-plan` that stops being
  true. It is amended alongside.
  ADR-0046's §Alternatives citation of `--permission-plan` as a settings-flag
  precedent is **left alone**: it records what was true when the alternative was
  weighed, and the difference between the two — a live claim versus a historical
  one — is exactly the distinction this manifest is built on.
- **[ADR-0048](0048-bootstrap-observability.md) §1** justifies the per-host
  statusline split "(mirroring the `permission.<host>.applied` split — a single
  combined step could false-pass after only one host is configured)". The
  **analogy loses its referent; the decision it justifies does not change.**
  The parenthetical is amended to state the reasoning directly instead of by
  reference. The statusline steps stay per-host. ADR-0048's §D1 rejection text
  is left alone as historical.

### Decision 11 — Every removal here is non-additive, so each contract gets a stated era matrix

The first draft named the schema questions inside Decisions 5 and 6 and left the
rest to `advisor-impl`. Review showed that is not enough: **four contracts lose
fields**, and a field deletion is non-additive in a way a version bump alone does
not describe. ADR-0056 §Decision 5 met the same problem with an explicit matrix,
and this ADR follows it rather than re-deriving the lesson.

| Contract | Today | Loses | Reader obligation |
|---|---|---|---|
| settings report | `runtime-settings-1.25` (`settings.mjs:517`–`:590`) | `permission_plan`, `permission_plan_codex` | `settings-report-contract.md:318`–`:323` requires version lockstep — the bump and the contract edit land together |
| doctor inner report | `runtime-doctor-1.0` (`doctor.mjs:425`–`:482`) | `permission_diagnosis` | `dashboard.mjs:104`–`:109`, `:299`–`:302` **exact-pins** the version; producer and dual reader must ship in one release |
| doctor outer artifact | `1.0` | the nested section | same release as the inner bump |

> **Amendment (2026-08-27) — the two doctor rows above were measured before
> ADR-0056's `grant-impl` landed, and their CURRENT values moved.** The inner
> report is now `runtime-doctor-1.1` and the outer artifact
> `runtime-doctor-artifact-1.1`, so this ADR's bumps target `1.2` in each case
> unless the two removals coalesce into one release. Two further facts changed
> under this table rather than in it: the exact-pin is now a **matched-pair**
> check in both `doctor.mjs` and `dashboard.mjs` — `(artifact-1.0, report-1.0)`
> and `(artifact-1.1, report-1.1)` only, because a mixed tuple is a shape no
> producer emits — so `advisor-impl` extends the pair list rather than two
> independent allowlists. And the `permission-sanitize.mjs` consumer inventory in
> Decision 3 counted `assurance-result` and `host-assurance-facts` among its
> eight non-advisor importers; ADR-0056 deleted the second and reduced the first
> to `lib/legacy-assurance-reader.mjs`, which still imports `sanitizeValue`. The
> count is **seven**, and `advisor-impl` re-measures rather than trusting either
> number. Written in place because this ADR is still `Proposed`: its decisions
> are unaffected, only the tree they were measured against moved.

| bootstrap run | `runtime-bootstrap-run-1.3.json` (`:499`–`:510`, `:574`–`:576`) | stage-6 steps; `fragment_applied` loses its only defining gate | retained runs still carry both — see below |

`advisor-impl` publishes, per contract, the tokens it **writes new**, the tokens
it still **reads as historical**, and the projection between them. Three
questions are named here because they are decisions rather than mechanics:

1. **Do stages 7 and 8 keep their numbers** once stage 6 is empty? Renumbering
   invalidates every retained run manifest; leaving a gap is honest and cheap.
   The ADR's expectation is **leave the gap**, and `advisor-impl` states it.
2. **Does `fragment_applied` survive as a legacy-only field?** Its schema
   description (`:574`–`:576`) defines it *solely* through the gate Decision 5
   removes, so at minimum the description is rewritten; whether the field stays
   readable for retained runs is the decision.
3. **How are open runs that reached Stage 6 read?** Already named in
   Consequences; the matrix is where the answer is recorded.

The dashboard exact-pin is the sharpest of these. Doctor scans every retained
run, and a rejected historical artifact increments `malformed`, which blocks the
collection — the same failure mode ADR-0056 §Consequences recorded. **A producer
that lands without its dual reader turns every retained artifact into a fault.**

### Decision 12 — This ADR is docs-only; `advisor-impl` implements it

Two-stage, matching ADR-0056: `Proposed` here, `Accepted` on merge.
Implementation, the residual triage, the schema decisions of Decisions 5, 6 and
11, and the amendments of Decision 10 all land in the `advisor-impl` subtask.

## Consequences

**Nothing recommends a permission configuration any more, and that is the
point.** The host decides dynamically, the operator sets the danger gate, and
runtime reports what it observes without proposing a change. Runtime keeps the
one permission fact it can actually establish — that it relaxed nothing — and
stops asserting one it could not.

**Prompt-reduction is no longer an agentic-plugins capability, and the Codex
half of that is a real regression.** ADR-0038's user goal ("provide a capability
that reduces prompts") is now met by the host on Claude. **Codex has not made the
equivalent move**, and this was measured against the binary rather than inferred
from the baseline's silence — the packaged baseline mentions `execpolicy` zero
times, which is not evidence of absence. Probing the real Codex binary (228 MB,
the vendored `codex-darwin-arm64` path, not the launcher shim) with
known-true control tokens behaving (`approval_policy` 46, `sandbox_mode` 37,
`workspace-write` 34, `on-request` 38) finds `execpolicy` present **45 times**.

So Codex does ship a policy engine — but it is *rules-and-configuration* shaped,
the same class of thing the advisor planned for, not a per-call decision mode
like Claude's `auto`. A Codex operator therefore loses the advisor and gains no
host replacement, and unlike the Claude side the premise there has **not**
expired.

**The `count: 0` this ADR first offered as mitigation is not mitigation — it is
a second, independent defect**, and the correction is recorded because it makes
the regression *larger* in one sense and the removal case stronger in another.
Cross-host review found that `parseCodexRollout` recognizes only
`local_shell_call` and `function_call` with `name === 'shell'`
(`permission-usage-learner.mjs:239`–`:260`). Re-measured over this machine's 100
most recent rollouts — 33,009 JSONL lines — the shapes actually present are
`custom_tool_call:exec` (1,006) and `function_call:exec_command` (314), and
`function_call:shell` does not appear at all. **Recognized observations: 0.**

The Codex advisor has therefore been reading nothing on current Codex versions,
silently, for as long as that schema drift has existed — while
`permission-plan.mjs:367`–`:423` demonstrably *can* build approval / sandbox /
project-trust recommendations when given evidence (pinned by
`test-settings.mjs:2162`–`:2214`). What is lost is a path that is currently
non-functional and would need new parsers to revive.

That cuts both ways and the ADR states both. It removes the comfortable reading
that Codex was fine; and it supplies ADR-0056's own argument in a new form — a
capability whose Codex half produced **zero** observations against current
rollouts, undetected, is one nobody was relying on. The honest bound on the loss
is the remaining one: ADR-0038 §Context established that the companion path does
not prompt, so the exposure is direct interactive Codex use. If that is later
measured as a real cost, §Alternatives names the shape the answer should take —
and it is not this advisor.

**`advisor-impl` will put `main` into release-obligation debt, and two protected
paths are involved**: `plugins/runtime/data/schemas/**` (Decisions 5 and 6) and
`plugins/runtime/docs/host-parity-baseline.md` (Decision 6). Both are PROTECTED
PATHS under ADR-0052, so `validate:release-obligation` fails from the moment
`advisor-impl` merges until a release carrying it is tagged. That red is the
intended signal. `plugins/runtime/data/plugin-set.json` is **not** touched — the
advisor declares no floor — which is one protected path fewer than ADR-0056's
removal.

**This is a BREAKING change to `plugins/runtime`**, on four surfaces rather than
the two the first draft listed:

1. **CLI flags** — `--permission-diagnosis`, `--permission-plan`, plus their
   `-max-files` / `-max-file-bytes` companions.
2. **Report fields** — `permission_diagnosis`, `permission_plan`,
   `permission_plan_codex`, each a non-additive deletion under Decision 11's
   matrix.
3. **Module exports** — `doctor.mjs`'s `collectUsageRecordSources` and
   `settings.mjs`'s `renderCodexConfigToml` re-exports, and the whole
   advisor-only half of `permission-sanitize.mjs` (Decision 3).
4. **Run-manifest shape** — bootstrap Stage 6 disappears and `proof.permission`
   changes applicability and blockers.

`advisor-impl` carries the `BREAKING CHANGE:` footer and enumerates all four.

**Open runs that reached Stage 6 need a stated migration.** ADR-0048 §1 handled
its own stage change by injecting steps additively; a *removal* has no
additive form. `advisor-impl` states whether an open run's Stage-6 rows are
dropped on resume, or the run is refused and the operator re-plans. It must not
leave the reducer to decide by accident.

**One severity-poisoning defect is being deleted rather than fixed, and it may
exist elsewhere.** Worst-grade folding over a first-token-keyed generalization
is a *pattern*, not a file. `advisor-impl` checks whether any surviving
aggregation does the same thing — the honest form of the question this
repository keeps having to ask: *is there a mirror of the thing I just removed?*

**Scorecard and evidence-record claims change in post-release recovery, not in
`advisor-impl`**, per the standing merge → release → install → record order.
`runtime-recovery-2` already covers "one recovery per release"; if `grant-impl`
and `advisor-impl` release separately, each needs its own proof re-record.

**Reversal is a new decision, not a revert.** If a future host regresses to
allowlist catch-up, the answer is to design against that host's behaviour — not
to restore a grader measured to deny `cd` on the machine it was built for.

## Alternatives Considered

**Fix the advisor: teach it `auto`, and fix severity poisoning.** Rejected, and
this is the alternative that had to be taken seriously. It is buildable —
add `auto` to `modeAlreadySet`, key generalization on the *graded* program
rather than the first token, and fold with a quorum instead of worst-wins. But
it repairs a recommender whose entire recommendation on this machine was
`allow: []` and `count: 0` on the Codex side. Even fully repaired it would emit
nothing useful here, because the host already decides per call and the operator's
own rules already govern the rest. Repairing a component so it can correctly
produce no output is not a use of the effort.

**Keep the R0 diagnosis, drop the M1 plan.** Rejected. The diagnosis reports
"which tool calls are prompting and why" using the same learner, the same
generalization and the same grader — so it inherits severity poisoning intact,
and would report `cat` as a deny-graded prompt cause. A diagnosis nobody acts on
that is also wrong is worse than none. It is also the shape that leaves 828 + 502
lines standing to serve a read-only report.

**Keep the advisor but scope it to Codex.** Rejected, and the measurement that
rejects it is the one in §Context: `parseCodexRollout` recognizes **zero**
observations in current rollouts. Scoping to Codex would mean keeping
`permission-usage-sources.mjs`, `permission-usage-learner.mjs` and
`permission-advisor-core.mjs` — essentially the whole library — and then
**writing new parsers first**, because the existing ones read a rollout schema
Codex no longer emits. That is not "keep the working half"; it is "rebuild the
half that silently stopped working." If Codex prompt fatigue is later measured as
a real cost, it deserves an advisor designed against Codex's actual approval
model and current rollout schema, not the Claude allowlist model wearing a
`renderCodexConfigToml` hat.

**Delete `proof.permission` along with Stage 6.** Rejected on measurement. The
proof takes no advisor input and is the dedicated live proof that **records**
ADR-0035 §4's no-relaxation fact (`doctor.mjs:3464`, `:3616` — the only two
sites). Deleting it would remove a boundary record as a side effect of removing
an advisory — exactly the "resolved by removal" error ADR-0056 §Decision 7 built
the `splits` category to prevent. (This ADR twice over-claimed that proof's
uniqueness before review narrowed it; the narrowing is in §What is worth keeping,
and this sentence is the corrected form, not a third variant.)

**Delete `permissions.claude.defaultMode` from the machine profile.** Rejected.
The field is host-configuration reproduction, not advice; a profile that cannot
record the operator's permission mode is a worse reproduction vehicle, and the
defect measured in §Context is that the enum is *too narrow*, not that the field
is unwanted.

**Leave ADR-0038 accepted and mark only the implementation removed.** Rejected.
ADR-0038's §Context root cause and its §1/§2 decisions describe a capability
that will not exist. An accepted ADR describing shipped surfaces that are gone is
the exact failure this repository's supersession discipline exists to prevent.
