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
advisory being removed.
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

1. `generalizeCommand` keys a pattern on the **first token** of the observed
   line, so the compound `cd X && rm -rf Y` generalizes to `cd *`.
2. `gradeCommand` grades the **whole line**, so it correctly sees
   `rm-recursive-force` in it.
3. `aggregateObservations` folds grades within a pattern with
   `prev.grade = worstGrade(prev.grade, grade)`
   (`permission-usage-learner.mjs:405`).

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

**Auto mode does not cause this, and the distinction matters.** Auto mode
explains the *empty allow set*: the learner did produce 4 `allow`-graded rules,
and all 4 were absorbed as `already_allowed_count` because the operator's 218
standing allow rules already govern them — the planner correctly declines to
re-recommend what is already permitted. It does not explain the deny set, which
would appear on a `default`-mode machine with the same transcripts. The two
defects are independent, and the follow-up ledger already carries the first half
of the second: `plugins/runtime/docs/follow-ups.md` rows 42 and 43 record
"safety grade vs. wildcard generalization" and "grader vs. pattern-emitter
divergence on a path-shaped program". This ADR does not fix them. It records
that the layer they sit in is no longer worth repairing.

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

The accurate claim is narrower and still load-bearing: `proof.permission` is the
only **live, on-host** evidence that a companion invocation *actually ran* under
the host's own permission policy with nothing injected. The static guard proves
runtime cannot contain a relaxation primitive; only the proof observes a real
session not using one. Neither substitutes for the other, and the proof survives
this removal.

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
in the parity baseline and skill prose, ADR-0035's boundary language, and
`plugins/attention`'s `Notification/permission_prompt` matcher — which is a
**hook event name**, not advisor machinery, and must not be touched.

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
  cross-host plan call (`:20`, `:2741`), the two mutation-boundary strings
  (`:625`, `:626`), the usage line (`:2816`), and the
  `parseCodexPermissionConfigToml` re-export (`:47`, which stays — Decision 4)
- `bootstrap.mjs` — Stage 6 (`:1897`–`:1908`), the applied-state derivation
  (`:1023`, `:2317`–`:2327`), the two re-derivation sites (`:2747`, `:2827`),
  the `--from-run` reconstructions (`:3344`, `:3777`–`:3839`), and the two
  advisor imports (`:138`, `:139`)
- `state-readers.mjs` — the `permission` entry in
  `RUNTIME_ARTIFACT_FAMILIES` (`:161`) and its comment (`:154`–`:155`)
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
`tests/runtime/fixtures/usage-records/**` (210 lines, 6 files) go with the
learner. `test-settings.mjs`, `test-doctor.mjs`, `test-bootstrap.mjs` and
`test-bootstrap-cli.mjs` lose their permission-section cases.

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
its contract has to say what now governs it. This file is **not** a protected
path under ADR-0052, so these edits add no release-obligation debt beyond the two
protected paths named in Consequences. `docs/artifact-policy.md` needs two narrower edits, not a
section removal: `:147`'s family list keeps `permission` per Decision 7, and
`:130`'s sanitization rule — which is illustrated *by* the advisory — is
re-illustrated from a surviving consumer rather than deleted, because the rule
outlives its example.

### Decision 3 — `permission-sanitize.mjs` survives whole, and is renamed with a compatibility re-export

It has eight non-advisor consumers and a normative citation in a protected
schema. It stays, and the ADR states the rename explicitly because the file's
name is the only thing about it that is advisor-flavoured: it becomes
`lib/sanitize.mjs`, with `lib/permission-sanitize.mjs` retained as a
re-exporting shim so the protected schema's `:270` description — which names the
old path — does not have to change in the same release that removes the
advisor. `advisor-impl` retires the shim and updates the schema description in a
**separate, later** release, because editing that file is a protected-path
change and coupling it to this one doubles the debt window for no benefit.

If `advisor-impl` measures the rename as not worth its cost, keeping the current
name is an acceptable outcome — but it must then say so, rather than leaving the
question unasked.

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
structurally a sibling of. Both prove the companion bridge works; this one
additionally proves runtime added no relaxation flags to get there.

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
  and `retention` continue to see, count, age and garbage-collect it under the
  ADR-0047 §7 policy unchanged.
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

- **Rows 42 and 43 are `resolved by removal`** — both describe
  `gradeCommand`/`generalizeCommand` divergence inside modules Decision 1
  deletes.
- **Row 45 `splits`.** It reports `skills/settings/SKILL.md`'s frontmatter
  `description` exceeding Codex's 1,024-character skill-creator cap, noting the
  field was already ~1.6k *before* the advisor clause pushed it to ~1.8k.
  Removing the clause shrinks it and does **not** clear the cap. The row
  survives with a smaller number.

The **severity-poisoning mechanism measured in §Context is not filed as a new
row.** It is resolved by removal, and recording it as a follow-up would imply
somebody should fix it.

### Decision 10 — Amendments to accepted ADRs

Two accepted ADRs normatively prescribe surfaces this ADR removes. Both are
amended in place by `advisor-impl`, in the same commit that flips this ADR to
`Accepted` — the [ADR-0056](0056-assurance-matcher-removal.md) §Decision 9 rule
that an accepted ADR must never point at a proposed one applies here too.

- **[ADR-0046](0046-machine-bootstrap.md) §"Which proofs, exactly"** states
  "`permission` is required **iff a permission fragment was applied**". That is
  precisely the coupling Decision 5 removes. The clause is amended to state the
  proof's new applicability and its independent justification.
  ADR-0046's §Alternatives citation of `--permission-plan` as a settings-flag
  precedent is **left alone**: it records what was true when the alternative was
  weighed.
- **[ADR-0048](0048-bootstrap-observability.md) §1** justifies the per-host
  statusline split "(mirroring the `permission.<host>.applied` split — a single
  combined step could false-pass after only one host is configured)". The
  **analogy loses its referent; the decision it justifies does not change.**
  The parenthetical is amended to state the reasoning directly instead of by
  reference. The statusline steps stay per-host. ADR-0048's §D1 rejection text
  is left alone as historical.

### Decision 11 — This ADR is docs-only; `advisor-impl` implements it

Two-stage, matching ADR-0056: `Proposed` here, `Accepted` on merge.
Implementation, the residual triage, the schema decisions of Decisions 5 and 6,
and the two amendments all land in the `advisor-impl` subtask.

## Consequences

**Nothing recommends a permission configuration any more, and that is the
point.** The host decides dynamically, the operator sets the danger gate, and
runtime reports what it observes without proposing a change. Runtime keeps the
one permission fact it can actually establish — that it relaxed nothing — and
stops asserting one it could not.

**Prompt-reduction is no longer an agentic-plugins capability.** ADR-0038's user
goal ("provide a capability that reduces prompts") is now met by the host on
Claude. On **Codex** it is met by nothing: Codex has `approval_policy` /
`sandbox_mode` but no dynamic per-call decision mode, so a Codex operator loses
the advisor and gains no host replacement. That is a real regression and it is
named rather than hidden — mitigated only by the measurement that the Codex half
already recommended `count: 0` on this machine, and by ADR-0038 §Context's own
finding that the companion path does not prompt.

**`advisor-impl` will put `main` into release-obligation debt, and two protected
paths are involved**: `plugins/runtime/data/schemas/**` (Decisions 5 and 6) and
`plugins/runtime/docs/host-parity-baseline.md` (Decision 6). Both are PROTECTED
PATHS under ADR-0052, so `validate:release-obligation` fails from the moment
`advisor-impl` merges until a release carrying it is tagged. That red is the
intended signal. `plugins/runtime/data/plugin-set.json` is **not** touched — the
advisor declares no floor — which is one protected path fewer than ADR-0056's
removal.

**This is a BREAKING change to `plugins/runtime`.** Two documented CLI flags
disappear (`--permission-diagnosis`, `--permission-plan`, plus their `-max-files`
/ `-max-file-bytes` companions), a bootstrap stage disappears, and report fields
`permission_diagnosis`, `permission_plan` and `permission_plan_codex` leave the
doctor and settings artifacts. `advisor-impl` carries the `BREAKING CHANGE:`
footer.

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

**Keep the advisor but scope it to Codex.** Rejected, though it is the one
option with a live regression behind it (Consequences, paragraph 2). The Codex
half is not independently healthy: it shares `permission-usage-sources.mjs`,
`permission-usage-learner.mjs` (`parseCodexRollout`) and
`permission-advisor-core.mjs` with the Claude half, so scoping to Codex keeps
essentially the whole library to serve a plan that produced `count: 0`. If Codex
prompt fatigue becomes a measured problem, it deserves an advisor designed
against Codex's actual approval model, not the Claude allowlist model wearing a
`renderCodexConfigToml` hat.

**Delete `proof.permission` along with Stage 6.** Rejected on measurement. The
proof takes no advisor input and is the only executable evidence for ADR-0035
§4's no-relaxation invariant. Deleting it would remove a boundary guarantee as a
side effect of removing an advisory — exactly the "resolved by removal" error
ADR-0056 §Decision 7 built the `splits` category to prevent.

**Delete `permissions.claude.defaultMode` from the machine profile.** Rejected.
The field is host-configuration reproduction, not advice; a profile that cannot
record the operator's permission mode is a worse reproduction vehicle, and the
defect measured in §Context is that the enum is *too narrow*, not that the field
is unwanted.

**Leave ADR-0038 accepted and mark only the implementation removed.** Rejected.
ADR-0038's §Context root cause and its §1/§2 decisions describe a capability
that will not exist. An accepted ADR describing shipped surfaces that are gone is
the exact failure this repository's supersession discipline exists to prevent.
