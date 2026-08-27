# ADR-0054: The assurance record — one grammar, two validators, no doctor bump, and a gate that ships empty

## Status

**Superseded by [ADR-0056](0056-assurance-matcher-removal.md)** (2026-08-27). Accepted 2026-08-17. ⚠ **PARTIALLY superseded, and the boundary is load-bearing**: the exactness half of ADR-0053 (§Decision 1 strict normalized equality) is NOT superseded and remains in force. What ADR-0056 removes is the assurance verdict built beside it — ADR-0056 §Consequences states it in one line: removing assurance removes the SECOND fact at the freshness site, not the first.

## Context

[ADR-0053](0053-baseline-exactness-and-compatibility-assurance.md) decided that
the freshness site reports exactness and assurance as separate facts over an
integrity layer, and that readiness gates on assurance in every path. Its
§Decision 12 then deferred three things by name: the assurance record's schema,
whether the doctor report's `runtime-doctor-1.0` schema version bumps, and the
concrete code changes.

Three further questions turned out to be part of that same deferred set rather
than implementation detail, because each is a safety property whose answer
changes what the code must be: where §Decision 11's minimum assurance-capable
runtime floor lives, what the packaged comparator of §Decision 10 actually is,
and by what mechanism §Decision 8's "rolling back a package does not resurrect
withdrawn coverage" could hold.

This ADR answers those six. It decides shape and sequence only; it introduces no
new policy, and every rule it implements is ADR-0053's.

Everything below was measured against this repository, not argued. Where a
prediction was refuted — including four of this decision's own working
assumptions and one from the cross-host peer — the refutation is recorded rather
than quietly dropped.

### The validator can carry the shape and nothing else

A candidate `runtime-host-assurance-1.0` schema was written and run through the
real `plugins/runtime/scripts/lib/schema-validate.mjs`. It passes
`assertSupportedSchema` — the closed keyword subset is sufficient to *express*
the record. Nine structural cases behave as intended, including the one that
matters most for §Decision 7: modelling the cohort as an array of complete
`{claude, codex}` tuples makes a per-host list unrepresentable, so the Cartesian
product cannot be written down at all.

Eight semantic cases pass validation that must not be accepted:

| case | result |
| --- | --- |
| duplicate grant ids | accepted |
| `granted` and `revoked` for the same cohort | accepted |
| `supersedes` naming an id that does not exist | accepted |
| `granted` with `packages: {}` (§Decision 8 vacuous) | accepted |
| `granted` with `cohort: []` (§Decision 7 vacuous) | accepted |
| residual `consumed` + `not-applicable` (contradiction) | accepted |
| `reviewed_at` in the future | accepted |
| calendar-invalid `reviewed_at: 2026-13-45` | accepted |

This is not a gap to close in the validator. It is the same boundary
`runtime-bootstrap-run-1.2` already sits on: its header records that the schema
"deliberately leaves both `directions` and `provider_ack` optional because the
local validator has no oneOf" and that `lib/evidence-contract.mjs` is "the
fail-closed code half." `lib/plugin-set.mjs` splits the same way. The repository
has already answered this question twice.

### The forward-compat rule is decided by the schema's own `schema` pattern

`compareSchemaVersion` accepts a minor difference in either direction and rejects
a major one. But the `schema` property's own `pattern` overrides that, and the
house style pins it exactly (`^runtime-session-note-1\.0$`):

| `schema` property pattern | doc 1.1 / reader 1.0 | unknown scalar | unknown object | doc 2.0 |
| --- | --- | --- | --- | --- |
| exact pin (house style) | **reject** | — | — | reject |
| family-wide `1\.[0-9]+` | accept | accept + warn | reject | reject |

The warning is real and correctly emitted (`unknown scalar key ignored — the
document declares a newer schema minor (1) than this runtime reads (0)`); an
earlier reading of this measurement said no warning fired and was an error in
the measuring script, not in the validator.

The two rows are not equally safe *for this record*. A newer minor could add a
**narrowing** scalar — an expiry, a session cap, a stricter applicability key —
and the family-wide row ignores it while still returning a positive. That is
ADR-0053 §Decision 5's "absence of evidence is never coverage", reached by
accident. The additive-forward-compat posture that is right for bootstrap and
session artifacts is wrong here.

### Bumping the doctor report costs a permanent red on a field nothing reads

Measured against the actual corpus of 70 retained artifacts (`70` directories,
`70` readable `doctor.json`, all `runtime-doctor-artifact-1.0` outer /
`runtime-doctor-1.0` inner):

```
today                        ok=70  malformed=0   doctor_runs.status=available
report -> runtime-doctor-1.1 ok=0   malformed=70  doctor_runs.status=blocked
report -> runtime-doctor-2.0 ok=0   malformed=70  doctor_runs.status=blocked
```

Any bump, minor included, fails every retained artifact, and
`status: malformed > 0 ? 'blocked' : ...` means a fresh proof never clears it.

The severity claim that accompanied this finding did not survive checking.
`doctor_runs.status` reaches nothing: its only appearances outside its own
builder are the attachment at `doctor.mjs:438` and the artifact trim at `:6071`.
Readiness travels through `recorded_doctor_proof`, which reads
`internal_runs = runs.filter((run) => run.report)` and is repaired by one fresh
conforming proof; `dashboard.mjs` shape-checks only the *latest* artifact and
recovers the same way.

A second predicted consequence was also refuted. `retention-planner.mjs`'s
comment says it pins "EVERY validated doctor run", which would mean a bump
unpins all 70 and exposes them to `runtime:retention --execute`. The code pins
by directory-name regex alone and never reads the artifact, so the pin survives
a bump. The comment and the code disagree; the code is what runs.

So the bump's true cost is a permanently `blocked` reporting field plus the loss
of historical proof readability — and its benefit is zero, because the new fact
can carry its own version.

### The floor already has a seat

`plugins/runtime/data/plugin-set.json` carries a per-plugin `minimum_version`,
is inside `check-release-obligation.mjs`'s `PROTECTED_PATHS`, is semver-validated
by `plugin-set.mjs`, and is already enforced per host by `bootstrap.mjs`, which
resolves each installed plugin's version and compares it with
`comparePrereleaseAware`. `runtime`'s entry is currently `null`.

An earlier position here preferred declaring the floor inside the assurance
section instead, on the ground that `minimum_version` means "minimum installable
version for the bundle" and reusing it would put two meanings in one field. That
objection does not survive contact with the code: the field means "the minimum
version of this plugin that is acceptable", and "assurance-blind" is exactly a
reason a version is not acceptable once assurance is the policy. The position is
recorded as withdrawn rather than deleted.

The floor must be evaluated for **both hosts' installed runtime**, not the
executing process's. The two hosts can carry different versions, and
`cutover-audit.mjs`'s `checkPluginVersions` already reads both.

### A rollback can restore withdrawn bytes, and the existing gate permits it

The working assumption here was that §Decision 8's non-resurrection clause could
not be enforced at all, because the only durable stores runtime can write are
repo-local `.agentic-plugins/state/` and the machine-global
`~/.agentic-plugins` home, and both vanish on a fresh clone or a new machine and
can be deleted by the operator. That reasoning only considered stores *runtime
writes*, and it was refuted by cross-host review: the baseline is versioned in
git and released as tags, so the **release history itself** is a monotonic
authority that no operator action on one machine can rewrite.

What that review then found is that the existing enforcement does not use it.
`check-release-obligation.mjs` compares protected *trees* against the newest
reachable tag and states plainly that "Rolling a protected asset back is
legitimate; ... The rollback path is a forward patch carrying the restored
bytes." It proves byte promotion. It does not prove irreversible meaning, so a
forward patch may delete a revocation record and pass.

### Separate PRs do not promise one release

`.github/workflows/release-please.yml` triggers on every push to `main`. Landing
the reader and the gate as separate PRs therefore does not guarantee they ship
together — a release PR merged between them ships the reader alone.

The internal half of the atomicity question does hold: `defaultPluginRoot()`
walks `import.meta.url` to the package root, so reader, gate and baseline always
resolve from one installed package directory. Atomicity is guaranteed *within* a
tag and not at all *across* packages — which is precisely §Decision 8's subject.

### The existing comparator is unusable, for a different reason than assumed

`plugins/runtime/scripts/lib/semver.mjs` exports `semverCompare`. Measured
against real version shapes it is unsuitable, but the first stated reason —
that its strict `SEMVER_SHAPE_RE` rejects two-component versions like `2.1` —
was wrong: `semverCompare` never calls `isSemVer` and pads missing components,
so `semverCompare('2.1', '2.1.0')` is `0`. The reasons that hold are that it
returns a *difference* rather than a sign (a major component past
`Number.MAX_SAFE_INTEGER` yields a magnitude around `1e20`, where float
precision collapses distinct large versions), that it orders prerelease by
presence only and never by identifier, and that `Number.parseInt(x, 10) || 0`
silently maps unparseable text to `0`.

That sentence originally carried the twenty-digit literal it describes, and the
commit-sha gate correctly rejected it: an all-digit run of seven or more
characters is indistinguishable from an abbreviated sha, and ADR-0052's scope
note records why an "all-decimal tokens are not shas" exemption is unsafe here —
four real citations in the corpus are all-decimal, and 35 of this repository's
commits have an all-decimal seven-character abbreviation. The prose was the
defect, not the gate.

The same measurement produced the direction table this decision packages, and
one result that was not expected:

| observed | baseline | exact | core order | state |
| --- | --- | --- | --- | --- |
| `2.1.233` | `2.1.233` | true | `0` | `exact` |
| `2.1.234` | `2.1.233` | false | `+` | `ahead` |
| `2.1.232` | `2.1.233` | false | `−` | `behind` |
| `0.147.0-rc.1` | `0.147.0` | false | `0` | `same-precedence-nonexact` |
| `2.1` | `2.1.0` | false | `0` | `same-precedence-nonexact` |
| `0.147.0+build.5` | `0.147.0+build.9` | false | `0` | `same-precedence-nonexact` |
| `01.2.3` | `1.2.3` | false | `0` | `same-precedence-nonexact` |
| `banana` | `2.1.233` | false | n/a | `unparseable` |
| **`1.2.3.4`** | **`1.2.3`** | **true** | `0` | **false-exact** |

The last row is a property of `normalizeVersion`, which takes the first three
components, so a four-component observed version reports as *exactly* equal to a
three-component baseline. The module's own note says this class changes no
verdict; for the exactness verdict specifically, it does.

### The record does not fit the validator's size cap

`plugins/runtime/docs/host-parity-baseline.md` is 89,660 bytes and
`SCHEMA_MAX_BYTES` is 65,536. Validating the file would fail on size alone, so
the extracted block — not the document — is what gets validated.

## Decision

**The assurance record is one canonical JSON block inside the packaged baseline,
validated structurally by a packaged schema and semantically by a dedicated
contract module; the doctor report does not bump and carries a separately
versioned assurance result; the floor takes the existing `plugin-set.json` seat;
the gate ships live and empty before any grant exists; the comparator is
packaged with a direction vocabulary; and revocation is made irreversible by a
release-history gate rather than by runtime-written state.**

1. **Encoding — one sentinel-delimited canonical JSON block.** A
   `## Compatibility Assurance` section in
   `plugins/runtime/docs/host-parity-baseline.md` carries exactly one
   sentinel-delimited JSON block. `HEADER_RE`, `parseBaseline` and its
   `{date, claude, codex}` return shape are untouched, and every existing caller
   parses exactly what it parses today (ADR-0053 §Decision 1). The new reader
   `parseAssuranceSection` is added to the same module,
   `plugins/runtime/scripts/lib/host-parity-baseline.mjs`, because that module
   owns grammars. **The extracted block is what is validated**, never the
   document: the file is 89,660 bytes against a 65,536-byte cap. Parsing
   requires canonical serialization so a duplicate JSON key is visible rather
   than silently last-wins.

2. **Two validators, and the split is the repository's existing one.**
   `plugins/runtime/data/schemas/runtime-host-assurance-1.0.json` holds the
   structure and is registered in `PACKAGED_SCHEMA_FILES`. A new
   `plugins/runtime/scripts/lib/assurance-contract.mjs` holds everything the
   closed keyword subset provably cannot: id uniqueness, negative-wins across
   duplicate/conflicting/superseded/revoked records, exact package-set equality,
   ambiguity, vacuous grants (`cohort: []`, `packages: {}`), residual
   coherence, and calendar validity. This mirrors
   `lib/evidence-contract.mjs`, which exists for the same reason and says so.

3. **The assurance family pins its schema version exactly.** Its `schema`
   property uses an exact pattern, so a newer minor is rejected rather than
   read with unknown scalars ignored. This deliberately diverges from the
   bootstrap and session families' additive-forward-compat posture, because a
   narrowing key ignored by an older reader turns absence of evidence into
   coverage.

4. **`runtime-doctor-1.0` does not bump.** The report gains a nested,
   separately versioned `host_parity_assurance` result
   (`runtime-host-assurance-result-1.0`). A historical report carrying no
   assurance result is `legacy-unassured` — readable, never malformed, never
   covered. Bumping would blockade a reporting field that reaches nothing while
   buying no expressiveness the nested version does not already provide.

5. **The floor is `plugins.runtime.minimum_version` in `plugin-set.json`,** set
   to the first released reader version. It is enforced at
   `bootstrap.mjs`'s existing per-host floor check, in the assurance evaluator,
   and by a new hard `assurance_runtime_floor` cutover check that evaluates
   **both hosts' installed runtime**. A cache-only fallback, missing
   enablement, an unparseable version, or a disabled package blocks. The
   accepted cost is that a `0.90.x` install reads as not satisfied at bootstrap
   even for an operator who never runs cutover; that is the honest meaning of a
   floor once assurance is the policy.

6. **Rollout is atomic-with-an-empty-grant-set, in two releases.**
   - **R1** ships the reader, the semantic contract, the comparator, the floor,
     and **both** readiness gate paths, with the assurance section present and
     `grants: []`. Every host reads `unassured`, and readiness blocks. The
     negative path is therefore exercised on real machines by the real gate.
   - **R2** ships one owner-ratified grant and nothing else, exercising the
     positive path.

   A shadow-read-first rollout with a temporary interlock that suppresses
   readiness was considered and not adopted: the interlock would have to be
   built, tested and then removed to reproduce a state that an empty grant set
   produces for free, and what it exercises is a simulation of the gate rather
   than the gate. Because release-please runs on every push to `main`, R1 still
   requires an explicit embargo on merging the release PR until every intended
   runtime commit has landed.

7. **The comparator is packaged, and cohort membership never uses it.** The
   module exports `compareReleaseCore(left, right) -> -1 | 0 | 1 | null`,
   `classifyVersionRelation({observed, reviewed})` yielding
   `exact | ahead | behind | same-precedence-nonexact | unparseable`, and
   `classifyHostPairRelation(...)` adding `mixed-direction`. `ahead` means the
   observed machine is ahead of the reviewed core.
   `scripts/check-host-version-drift.mjs` drops its private `compareSemver` and
   imports these, as it already imports `extractBaselineVersions` and
   `releaseVersion`. `lib/semver.mjs` is untouched and unused here — it answers
   a different question about manifests, with a strict grammar and
   presence-only prerelease ordering.

   **Cohort membership is normalized identity equality, never precedence.**
   Direction is recorded as evidence and never promoted to coverage
   (ADR-0053 §Decision 9). The `1.2.3.4`-reports-exact-against-`1.2.3` case is
   handled in the membership path by requiring the observed token's component
   count to match, which tightens rather than relaxes exactness and so is
   consistent with §Decision 1.

8. **Revocation is irreversible by release history, with the residual stated.**
   Grants carry immutable ids; revocation and supersession are append-only
   records; a revoked grant is never un-revoked, only replaced by a new id
   carrying `reapproval_of`. A new cross-tag semantic monotonicity check
   enforces that revocation records never disappear, that ids and canonical
   record contents are immutable, and that removing a positive grant leaves a
   tombstone. This is required because `check-release-obligation.mjs` explicitly
   permits a forward patch that restores previously released protected bytes; it
   proves byte promotion, not irreversible meaning.

   **The residual limit is stated rather than papered over**: an operator who
   installs an older — but still floor-satisfying — assurance-capable runtime
   whose packaged baseline predates a revocation cannot be distinguished from
   one who never saw it, because current state `A` and history `A → B → A` are
   identical on that machine. The floor narrows this window; it does not close
   it. Closing it requires an external monotonic authority, which would reopen
   ADR-0051's packaged-copy-as-sole-authority decision, and is not proposed.

9. **Scope fence.** ADR-0053 §Decision 2's "`runtime:compat` *may* assemble
   candidate contract contacts" stays a may. Building that assembly is out of
   this decision's scope and stays a follow-up. Widening
   `cutover-audit.mjs`'s `checkPluginVersions` beyond its four packages is
   likewise a follow-up; the assurance matcher reads installed state directly
   rather than through that check, and must not reuse
   `summarizePluginStatus`, which counts a *disabled* Codex install as
   available and so cannot see §Decision 8's "is disabled".

## Consequences

**Positive**: The record is expressible in the shipped zero-dependency
validator with no new dependency and no new protected path. Seventy retained
doctor proofs stay readable and reusable. The floor lands in a seat that already
exists, is already protected, and is already enforced per host. The gate's
failing path is observed by the real gate on real machines before any positive
result is possible, without a temporary mechanism. Revocation becomes durable
through history the repository already keeps.

**Negative**: Two modules now describe one record, and a rule placed in the
wrong one is a silent hole — mitigated only by tests that drive the semantic
cases the schema provably cannot catch. A `0.90.x` runtime reads as
floor-unsatisfied at bootstrap for every operator, not only those running
cutover. Two releases means two recovery laps, and this repository has measured
that a lap lands on a `current` baseline in 3 of 12 attempts. The cross-tag
monotonicity check is new enforcement machinery with its own failure modes.

**Neutral**: The assurance family's exact schema pinning deliberately differs
from the other packaged families' forward-compat posture, so "how do packaged
schemas version here" now has two answers and the reason has to travel with
them.

## Alternatives Considered

### Shadow-read-first with a suppression interlock

R1 ships reader, matcher and reporting plus an interlock that unconditionally
prevents cutover readiness; R2 raises the floor and switches the gates. This was
the cross-host peer's recommendation and its safety argument is real: the
matcher cannot produce a positive on a real machine until it has been observed.
Not adopted because an empty grant set produces the same "no positive is
possible" state using the gate itself, so the interlock is a temporary
mechanism that must be built, tested, and then deleted in order to simulate
something the shipped code already does. Its removal in R2 is also a second
place the gate can be got wrong.

### A single atomic release carrying the first grant

Shortest path — one lap, one recovery. Rejected because the positive and
negative paths would both go live in the same moment on real machines, leaving
tests and the planned adversarial audit as the only thing standing between a
matcher defect and a false `covered`. The failure this whole plane exists to
prevent is exactly a false positive.

### Bumping `runtime-doctor-1.0` (to `1.1`, with dual reading)

Contract-honest about a report whose shape changed, and the peer's second
approach adopted it with explicit `1.0`/`1.1` dual reading. Rejected on
measurement: the shape change is additive and can carry its own version nested,
while the bump costs a permanently `blocked` `doctor_runs` collection and a
dual-reading requirement whose omission — in this repository or in any consumer
of these artifacts — silently invalidates seventy proofs. The expressive benefit
is nil.

### Declaring the floor inside the assurance section

Keeps the floor inside the already-protected baseline, needs no new path, is
self-describing, and has no bootstrap side effect. Not adopted: `plugin-set.json`
already holds exactly this kind of fact, is protected, is semver-validated, and
is already enforced per host, so this alternative would create a second kind of
floor whose value must be kept in lockstep with the first. The bootstrap side
effect that motivated it is a truthful consequence, not a defect.

### A detached record under `data/schemas/**` with a machine-global watermark

The peer's third approach: put the record in a JSON file beside the schemas,
couple it to the Markdown by hash, and add a machine-global monotonically
increasing epoch that records only negative knowledge. Rejected on
canonical-precedent and maintainability: a non-schema record inside
`data/schemas` has no precedent here, and the watermark introduces a second
mutable authority with its own corruption, sequencing, retention and
cross-machine recovery surface. It also does not close the gap it exists for —
a machine that never observed the newer epoch still cannot distinguish
`A → B → A`.

### Widening the validator with `oneOf`/`if-then-else`

Would let the schema express some cross-field rules directly. Rejected for the
reason `schema-validate.mjs`'s own header gives: the keyword list is closed so
that an unimplemented keyword is a loud error rather than a constraint that
silently does not apply, and a half-implemented combinator is worse than an
absent one. The semantic rules that matter here — uniqueness across records,
negative-wins, ambiguity — are not expressible by any of these keywords anyway.

## References

- [ADR-0053](0053-baseline-exactness-and-compatibility-assurance.md) — the
  policy this implements; §Decision 12 deferred the schema, the doctor
  schema-version question, and the code
- [ADR-0051](0051-host-parity-baseline-source.md) — packaged copy as sole
  authority; §Decision 4 one grammar, one failure vocabulary
- [ADR-0052](0052-release-obligation-enforcement.md) — release-obligation
  enforcement; §Decision 7 forward-patch rollback, which is why §Decision 8
  above needs a semantic check
- `plugins/runtime/scripts/lib/schema-validate.mjs` — the closed keyword subset,
  `PACKAGED_SCHEMA_FILES`, `SCHEMA_MAX_BYTES`, and the forward-compat minor rule
- `plugins/runtime/scripts/lib/evidence-contract.mjs` — the structural-schema /
  semantic-contract split this decision reuses, created for the same missing
  `oneOf`
- `plugins/runtime/scripts/doctor.mjs` — `inspectDoctorRuns`'s malformed
  accounting, `isDoctorArtifact`, and where `doctor_runs` attaches
- `plugins/runtime/scripts/lib/retention-planner.mjs` — the doctor pin, whose
  comment and code disagree about whether validity is required
- `plugins/runtime/data/plugin-set.json`, `plugins/runtime/scripts/bootstrap.mjs`
  — the existing per-host `minimum_version` floor seat and its enforcement
- `plugins/runtime/scripts/lib/semver.mjs` — the manifest comparator this
  decision deliberately does not reuse
- `scripts/check-release-obligation.mjs` — `PROTECTED_PATHS` and the
  forward-patch rollback allowance
- `.github/workflows/release-please.yml` — the every-push-to-main trigger behind
  the release embargo
