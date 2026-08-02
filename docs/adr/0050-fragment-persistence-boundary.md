# ADR-0050 — Fragment persistence boundary: immutable fragments, one commit point

## Status

Proposed

## Context

`runtime:bootstrap` renders **fragments** — host-config edits the operator
merges by hand — and records, on the step that owns each one, a
`fragment_pointer`, the `desired` expectation that fragment asks for, and an
`apply_command`. Since the statusline slice, `persist()` applies a
**freeze-after-first-render** rule
([`bootstrap.mjs`](../../plugins/runtime/scripts/bootstrap.mjs)):

```js
if (step.fragment_pointer && (desired === null || step.desired != null)) return;
```

The freeze is deliberate and correct in intent: re-rendering could silently
**rebind the expectation** (a changed execPath, a changed mode) under an
operator who is part-way through applying the fragment they were given.

The cost is that a frozen artifact and the run's current decisions can diverge
and stay diverged byte-for-byte. Four recorded follow-up rows sit on this one
boundary, and three of them explicitly defer to it:

- **The G7 freeze row** — a `plan → resume` transition in which the operator
  declines a key that already rode the combined `[tui]` fragment leaves the
  frozen fragment still carrying it; and a run planned with the conditional
  strip whose statusline observation later disappears re-renders the combined
  fragment while the notify artifact stays frozen with its preview — two
  `[tui]` carriers in a post-patch run. Runtime currently **names** both shapes
  in a warning rather than repairing them. A round-5 restore-rewrite was
  **withdrawn in round 6** on the grounds that "the fragment write and the
  manifest's authority withdrawal have no CAS transaction ordering them".
- **§7 invalidation sits outside the fixpoint** — the row says the remedy
  "means deciding what clearing a frozen fragment mid-verb does to an operator
  who is part-way through applying it — the same atomic/CAS question the G7
  freeze row records, so **decide the two together**".
- **Fragment-composition readers are unpinned** — "it belongs with the §7 row
  above because both are about **what a render is bound to**".
- **The notify `apply_command` can point at an artifact stripped of the failing
  half** — making it precise "means either ordering the fragment decision ahead
  of judgement or letting a step's apply command be rewritten after persist —
  both touch the same freeze-vs-decision reconciliation".

The recorded framing of the open question is: *re-render on answer-driven status
change? version-bump invalidation? explicit re-render verb? a fragment/manifest
transaction?*

### What the code actually does today (measured, not assumed)

This ADR's central claim rests on the current write ordering, so it was read out
of the code and then reproduced.

Both `plan` and `resume` call, in this order:

```
composeFragments(...)    // writes fragment FILES, mutates steps[] in memory — NO LOCK
updateBootstrapRun(...)  // writes the manifest carrying steps[]  — LOCKED, atomic
```

- `writeBootstrapFragment` writes through `writeFileAtomic` (sibling temp +
  `rename(2)` within one directory).
- `updateBootstrapRun` runs inside `withBootstrapFamilyLock` and writes the
  manifest atomically.
- The fragment write is **not** inside that lock, and no transaction spans the
  two.

That ordering is **write-ahead**: content is durable before anything references
it, and the manifest write is the **sole commit point** *for the single-writer,
process-death case*.

**Reproduced, and the reproduction's limits matter.** A `plan` in a sandboxed
home wrote 6 fragment files and recorded 5 pointers. Clearing every
`fragment_pointer` and `desired` from the manifest while leaving the files on
disk, then running `resume`, restored all 5 pointers: the freeze predicate reads
`step.fragment_pointer` from the *manifest-restored* step, finds none,
re-renders, and re-freezes.

That experiment models **process death between the fragment rename and the
manifest rename, and nothing else.** Cross-host Plan-verify identified two ways
it is narrower than "crash-safe", and both were confirmed in the code:

- **No `fsync`, so the two renames are not ordered under power loss**
  (`bootstrap-artifacts.mjs` `writeFileAtomic`: `writeFile(tmp)` then
  `rename(tmp, path)`, with neither the file nor the directory synced). The
  existing comment claims a crash "never leaves a torn `run.json`", which is
  true of a *single* file and says nothing about ordering *between* two. A
  manifest can therefore reach durable storage while the fragment it points at
  does not — and the freeze predicate tests `fragment_pointer` and `desired`
  only, never existence, so the dangling pointer is **permanent**.
- **The hand edit is not the general crash state.** `persist()` also sets
  `apply_command` and `recovery`, which clearing two fields leaves behind; a
  kill can leave `.fragment.tmp-*` or `run.json.tmp-*` siblings and a held
  `bootstrap.lock`.

So the honest premise is narrower than the one this ADR was first written on:
**creation is crash-safe against process death, not against power failure**, and
the commit-point property is a single-writer property.

### The actual defect

Fragments are written to a **name-keyed** path:

```js
const path = join(bootstrapFragmentsDir(homeDir, runId), `${name}.fragment`);
```

A re-render, a restore, or a repair with the same `name` therefore **overwrites
a file that a live manifest pointer already references**. That inverts the safe
ordering: the content under a reference changes while the reference does not
move, and there is no window in which the pair is consistent. This is precisely
why the round-6 withdrawal was right — "a restored file could land under a
still-live combined pointer when the manifest update fails" — and it is why a
CAS primitive looked necessary.

The framing to reject is that this needs a *transaction*. A transaction would be
machinery built to make **mutation in place** safe. The system already has a
correct commit protocol for **creation**. The gap is that a change is currently
expressed as a mutation instead of as a creation.

## Decision

**Fragments become immutable and content-addressed; the manifest pointer is the
only mutable thing; the manifest write remains the sole commit point.**

1. **Content-addressed filenames.** A fragment is written to
   `<name>-<sha256>.fragment` — the **full** digest (see 5).
   `writeBootstrapFragment` **already computes and returns `sha256`** of the
   exact bytes, so the content address exists today and is simply not used in
   the path.
2. **A re-render is a create-and-repoint, never an overwrite.** New content
   means a new file; the manifest write swaps `fragment_pointer` (and, in the
   same atomic write, `desired` and `apply_command`). This reuses the ordering
   create already uses, so **no new transaction primitive is introduced for the
   single-writer case** — but it does not remove the manifest-level CAS gap the
   contract already declares (see "What this does NOT buy").
3. **The freeze becomes a pointer policy, not a file policy.** "Frozen" now
   means *this run does not move the pointer*. That decision is recorded in the
   manifest, under the family lock, where it is already atomic. The freeze keeps
   its original protective purpose — the expectation the operator is mid-apply
   on cannot be rebound underneath them — and loses the property that made it
   lossy, because superseded content no longer has to be destroyed to be
   replaced.
4. **Superseded fragments are retained, not deleted.** An operator holding a
   path from an earlier `status` can still read the bytes they were told to
   merge. **Cleanup has no owner today and this ADR does not invent one**: the
   first draft handed it to `runtime:retention`, and the audit below shows that
   family covers `doctor|compat|settings` only, is repository-local, prunes
   whole runs rather than files inside one, and treats bootstrap as report-only.
   Bounding this is a named precondition of implementation, not a deferral.

5. **Publication is create-only, and the address is the full digest.** The
   first draft proposed a 12-hex (48-bit) prefix published through the same
   replacing `rename(2)`. Plan-verify showed that recreates the very hazard:
   generate two bodies sharing the prefix, commit A, publish B, and B lands on
   A's path under a live pointer. The address is the full `sha256`, and
   publication refuses an existing target unless its bytes are identical.
6. **`fsync` the fragment and its directory before the manifest write.**
   Immutability is a naming property; durability ordering is a separate one, and
   without it the power-failure window above survives the rename.

### What this does NOT buy — corrected after Plan-verify

The first draft of this ADR claimed content addressing makes CAS unnecessary and
unblocks three follow-up rows. Both claims were too strong, and the review was
right on each:

- **A manifest CAS is still needed, and the contract already says so.** §2105 of
  the machine-bootstrap contract states plainly that "there is NO cross-process
  CAS over the evidence set" and that "one resume at a time per machine is the
  operating assumption". Immutability removes *byte mutation under a live
  pointer*; it does nothing about a **stale writer committing an old pointer**.
  `resume` renders from an unlocked snapshot and its locked mutator then writes
  the captured `steps` array over the manifest it just read — so two concurrent
  invocations can still produce a newer manifest carrying an older pointer,
  which this ADR's first draft called unrepresentable. **It is representable,
  under exactly the concurrency the contract already declares out of scope.**
  This ADR therefore inherits that standing limitation rather than removing it,
  and an expected-version check on the manifest update is recorded as the
  follow-on that would close it.
- **The manifest is not the sole *operator-visible* commit point.** When
  `updateBootstrapRun` fails, `plan` pushes a warning and still returns and
  prints its locally mutated `steps` — pointers and apply commands the
  authoritative manifest never committed. Rendering must be gated on the commit
  for the "sole commit point" framing to be true of what the operator sees.
- **The three entangled rows are not resolved — one storage hazard is removed
  from under them.** Precisely: G7 keeps its trigger, sibling-ownership and
  expectation-rebind questions; §7 keeps final-snapshot invalidation *and* the
  restored-plugin exclusion, which content addressing cannot touch because a
  version that was never sampled cannot be compared; the notify `apply_command`
  row still has to *select* the real carrier. And the unpinned-readers row is
  **not** addressed at all — a content hash identifies the **output bytes**, not
  which input snapshot produced them, so "what was this render bound to" remains
  open. The first draft's claim there was simply wrong.

### Why this still helps the entangled rows

## Alternatives considered

Compared on the nine-axis matrix resolved from `decide-registry --size=major`
(decisive axes: **essence**, **foundation**). Effort is deliberately excluded.

| | A. Status quo + named warnings | B. CAS / transaction over fragment+manifest | **C. Immutable content-addressed + pointer swap** | D. Explicit re-render verb | E. Version-bump invalidation only |
|---|---|---|---|---|---|
| **본질 Essence** | ✗ names the divergence, never resolves it | ~ makes mutation safe — solves the symptom of having chosen mutation | **✓ removes the mutation that creates the hazard** | ✗ moves the decision to the operator, divergence persists until they act | ✗ only the version-drift subset; decline-driven divergence untouched |
| **근본 Foundation** | ✗ two-carrier states are reachable and permanent | ~ a second commit protocol beside the manifest, and two can disagree | **✓ one commit point, the one that already exists** | ~ sound but partial; the freeze hazard remains inside the verb | ✗ leaves §7 as the only trigger, which the row shows is itself outside the fixpoint |
| **표준 Standards** | — | ~ CAS is standard, but here it is invented in-tree | **✓ content addressing + immutable objects is the git/OCI-shaped norm** | — | — |
| **권장 Recommendation** | — | — | **✓ write-ahead + atomic reference swap is the recommended file-durability shape** | — | — |
| **정석 Canonical precedent** | — | ~ | **✓ already this repo's own pattern: proof artifacts are hash-identified** | ~ | — |
| **확장 Extensibility** | ✗ | ~ every new mutable field needs the transaction extended | **✓ any future fragment kind inherits it for free** | ~ | ✗ |
| **유지보수 Maintainability** | ✗ warnings accumulate per shape (two already) | ✗ crash-window reasoning at every call site | **✓ the invariant is "never overwrite", checkable by inspection** | ~ | ~ |
| **고도화 Maturation** | ✗ | ~ | **✓ enables diffing renders and pinning readers to a hash** | ~ | ✗ |
| **실용성 Practical fit** | ✓ costs nothing | ✗ the round-6 withdrawal is evidence this is the expensive path | **✓ `sha256` is already computed and returned; path + pointer only** | ✓ small | ✓ small |

**B is not rejected outright — it is re-scoped, and the first draft was unfair
to it.** The draft rejected CAS on the grounds that "two commit protocols can
disagree". Plan-verify pushed back and is right: the real relationship is that C
and B answer **different** questions. C removes byte mutation under a live
pointer, which is a *storage* hazard and the one the round-6 withdrawal actually
tripped on. B answers *concurrency* — a stale writer committing an old pointer —
which C does not touch and which the contract already documents as an accepted
limit (§2105: no cross-process CAS; one resume at a time is the operating
assumption).

So the shipped shape is **C now, with an expected-version check on the manifest
update recorded as the follow-on that would close B's half.** Adopting C does
not make the run more concurrency-safe than it is today, and this ADR no longer
claims it does.

**D remains available on top of C** as operator ergonomics (an explicit
"re-render now"), and is not exclusive with it. **E is a trigger, not a model**;
it is subsumed once moving a pointer is safe.

## Consequences

**Positive**

- The two recorded two-carrier `[tui]` shapes become repairable rather than
  merely nameable, and the round-6 withdrawal's stated blocker is dissolved
  rather than worked around.
- Three deferred follow-up rows are unblocked without each needing its own
  transaction story.
- The freeze keeps its protective meaning and stops being lossy.
- No new concurrency primitive enters the codebase.

**Negative / costs, stated plainly**

- **Fragment paths stop being predictable.** Anything that reconstructs a
  fragment path from `<name>` alone breaks; every reader must go through the
  manifest pointer. That is the intended direction — the manifest becomes the
  only authority — but it is a real migration surface and must be audited, not
  assumed.
- **Superseded fragments accumulate, and nothing currently bounds them.**
  `RETENTION_FAMILIES` is `doctor|compat|settings`; bootstrap retention is
  machine-global and **report-only**, and the cap counts whole RUNS, so a
  superseded fragment inside one still-open run is unreachable by it. Repeated
  re-renders in a long-lived open run grow without limit while the run cap stays
  at one. This is the single largest implementation precondition.
- **"Old runs keep working by construction" was wrong, and the audit says so.**
  The claim holds only for consumers that read the stored pointer. Two
  PRODUCTION readers reconstruct the path from a hardcoded leaf name
  (`bootstrap.mjs:1357` and `:1382`, both opening `notification-plan.fragment`),
  so a hash-named run makes them read a stale file or none. `statusline-shim`
  discards the writer's returned pointer entirely, so under content addressing
  that artifact becomes undiscoverable through the manifest-only authority this
  ADR asserts — it needs a pointer before the addressing changes. `status` /
  `verify` carry the pointer opaquely and are compatible but never verify its
  target; doctor's inventory is filename-agnostic; the settings executor renders
  its own text and does not read these paths. Roughly fifteen test sites open
  fragments by leaf name. Every one is a migration item, not a footnote.
- **The orphan-file window widens slightly**: a crash between the new-file write
  and the manifest write now leaves a hash-named file that no pointer will ever
  reference. Harmless, unbounded only in pathological retry loops, and cleaned
  by retention.

**Deliberately not decided here**

- *When* a re-render should fire (answer-driven status change vs §7 drift vs an
  explicit verb) is a policy question that this model makes safe but does not
  answer. It belongs to the §7 row, which can now be scheduled independently.
- Whether `desired` should also become content-addressed. It is small, lives in
  the manifest, and already moves atomically with the pointer.

## References

- `plugins/runtime/docs/follow-ups.md` — the G7 freeze row, the §7 invalidation
  row, the unpinned-readers row, and the notify `apply_command` row.
- `plugins/runtime/scripts/bootstrap.mjs` — `persist()`, `composeFragments`.
- `plugins/runtime/scripts/lib/bootstrap-artifacts.mjs` —
  `writeBootstrapFragment`, `writeFileAtomic`, `updateBootstrapRun`,
  `withBootstrapFamilyLock`.
- `plugins/runtime/docs/machine-bootstrap-contract.md` §7.
