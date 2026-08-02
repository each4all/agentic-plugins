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
it, and the manifest write is the **sole commit point**. A crash between the two
therefore leaves an unreferenced fragment file and an unchanged manifest — the
safe direction.

**Reproduced.** A `plan` in a sandboxed home wrote 6 fragment files and recorded
5 pointers. Clearing every `fragment_pointer` and `desired` from the manifest
while leaving the files on disk — exactly the state a crash before the manifest
write produces — and then running `resume` restored all 5 pointers. The run
self-heals: the freeze predicate reads `step.fragment_pointer` from the
*manifest-restored* step, finds none, re-renders, and re-freezes.

So **creation is already crash-safe, and the transaction the follow-up asks for
already exists for it.**

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
   `<name>-<sha256[:12]>.fragment`. `writeBootstrapFragment` **already computes
   and returns `sha256`** of the exact bytes — the content address exists today
   and is simply not used in the path.
2. **A re-render is a create-and-repoint, never an overwrite.** New content
   means a new file; the manifest write swaps `fragment_pointer` (and, in the
   same atomic write, `desired` and `apply_command`). This reuses the ordering
   that create already proved safe, so **no CAS and no new transaction
   primitive is introduced**.
3. **The freeze becomes a pointer policy, not a file policy.** "Frozen" now
   means *this run does not move the pointer*. That decision is recorded in the
   manifest, under the family lock, where it is already atomic. The freeze keeps
   its original protective purpose — the expectation the operator is mid-apply
   on cannot be rebound underneath them — and loses the property that made it
   lossy, because superseded content no longer has to be destroyed to be
   replaced.
4. **Superseded fragments are retained, not deleted.** An operator holding a
   path from an earlier `status` can still read the bytes they were told to
   merge. Cleanup belongs to the existing artifact-retention family
   (`runtime:retention`), not to the render path.

### Why this resolves the three entangled rows

- **§7 invalidation outside the fixpoint.** The row's blocker is "what does
  clearing a frozen fragment mid-verb do to an operator part-way through
  applying it". Under immutability, invalidation never clears bytes — it moves a
  pointer, and the old file remains readable. The scary half of running §7
  against the final snapshot disappears, so that row can be scheduled on its own
  merits.
- **Unpinned readers / "what is a render bound to".** A content address *is* the
  identity of the rendered bytes. "Which readers produced this fragment" becomes
  a checkable property of a specific hash rather than an assertion about a
  mutable file.
- **`apply_command` points at a stripped artifact.** The row offers two ways
  out: order the fragment decision ahead of judgement, or rewrite the apply
  command after persist. The second becomes safe, because the pointer and the
  apply command move together in the one atomic manifest write.

### The rollback edge the subtask named

> a rollback that must not leave a new manifest pointing at an older frozen
> fragment

Under this model that state is **unrepresentable rather than guarded against**.
A rollback is "do not move the pointer" (or "move it back to a hash that is
still on disk"), and the pointer only ever changes inside the atomic manifest
write. There is no ordering in which a new manifest and an old fragment can be
paired, because the manifest is the only place the pairing is expressed.

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

**B is the option the follow-up row assumed was required, and it is the one this
ADR rejects.** The row concluded a CAS boundary was missing; measurement shows a
correct commit protocol is already present for creation, and CAS would exist
only to protect an in-place mutation that need not happen. Building it would add
a second commit protocol beside the manifest — and two commit protocols can
disagree, which is the class of defect this whole area keeps producing.

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
- **Superseded fragments accumulate.** Bounded by retention, not by the render
  path, which means retention must actually be taught about them.
- **Existing runs carry `<name>.fragment` pointers.** The pointer is stored, so
  old runs keep working by construction; but the *migration* must not rewrite
  those pointers, and a mixed-shape home must be readable. This wants an
  explicit compatibility test rather than an argument.
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
