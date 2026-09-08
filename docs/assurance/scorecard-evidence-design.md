# How the scorecard R-rows carry their evidence

A decision, not an implementation. It fixes the shape the twelve requirement
rows of `omcc-cutover-scorecard.md` use to carry evidence, and the assertions
that hold that shape in place. **No live document is rewritten here.** Every
number below was produced against in-memory copies through the checks' own
`{ docs }` injection seams, or against a scratch copy of the runtime scripts;
the scorecard's bytes are unchanged at the commit that carries this file.

It builds on the inventory in [`scorecard-consumer-inventory.md`](scorecard-consumer-inventory.md)
(`d49f74e`), which enumerated the consumers. This document decides what to do
about them. Measured at `69ca117`.

---

## 1. The problem, stated as a measurement

| Row | evidence cell |
|---|---:|
| R3 | **34,649 characters — one physical line** |
| R4 | 6,095 |
| R9 | 792 |
| the other nine | 276–618 |

R3 is not a summary. It is a release-by-release chronicle: 36 distinct doctor
run ids, 24 distinct `plugin-runtime` tags, 106 distinct abbreviated commit
shas, 48 pull-request references, and the phrase `re-recorded under` five
times. Every release appends to it, because a re-recorded proof has nowhere
else to go.

The cost is not cosmetic. The row is unreviewable — any edit rewrites one 34KB
line — and the constraint has already been breached once: R3 previously spanned
40+ physical lines, and the production audit silently reported **11** rows where
the scorecard intended 12.

**The root cause is that one cell holds two jobs.** It is simultaneously

- the machine-read evidence field of `runtime:cutover audit` — which wants to be
  short, single-line, stable, and *replaced* on each re-proof; and
- the durable human record of how the requirement was proven, superseded entries
  included — which wants to be long, structured, and *appended*.

Those two want opposite things. 34,649 characters is what conflating them costs
after six releases. Every design below is judged first on whether it separates
the two jobs, and only then on anything else.

---

## 2. Decision

**Each evidence cell becomes an authored, bounded claim plus a pointer to a
same-file evidence-record section. The displaced bytes stay inside the
scorecard, as soft-wrapped prose under an explicit anchor derived from the row
id.**

```
| R3 | …requirement… | <authored claim> [R3 evidence](#scorecard-r3-evidence). | satisfied | …gate… |
```

```markdown
<a name="scorecard-r3-evidence"></a>

### Evidence for R3

…the full record, soft-wrapped, superseded entries included…
```

Four properties define it, and each is enforced by an assertion in §4:

1. **Same file.** Measured, this is the only move that keeps the evidence
   visible to the enumerated corpora (§3).
2. **Bounded cell.** The whole cell fits the audit's 220-character compaction
   budget, so the reported evidence is authored rather than truncated (§3.2).
3. **Derived binding.** The anchor is computed from the row id
   (`scorecard-<id-lowercased>-evidence`), not authored independently, so cell
   and section cannot drift apart.
4. **Soft-wrapped record.** The relocated prose is wrapped. Moving a 34KB line
   intact would relocate the diff problem rather than solve it.

---

## 3. What the measurements decided

### 3.1 Same-file is the only move that preserves coverage

`check-doc-evidence.mjs` runs two **enumerated**-corpus checks over a hardcoded
three-document list, and one **discovered**-corpus check over everything under
`docs/`. Moving all twelve evidence bodies:

| variant | release triples | proof/date pairs | commit shas |
|---|---:|---:|---:|
| baseline (live) | 77 | 94 | 611 |
| **same-file projection** | **77** | **94** | **611** |
| separate file under `docs/` | 60 | 65 | 611 |

Every variant reports **zero findings**. A separate file would drop 17 release
claims and 29 date pairs with the gate green — the loss is invisible where it
would be noticed. The discovered sha check is unharmed either way, because it
follows the bytes.

This reproduces the inventory's figures independently. It also refines them: the
sha count is 611 rather than the 575 measured at `d49f74e`, because the
discovered corpus has grown since; and a separate-file move costs the sha check
nothing **only while the new file stays under `docs/`**.

### 3.2 The audit's evidence field is today a truncation artifact

`compactCell(value, 220)` compacts the **cell** for `--completion-audit`. All
**twelve** cells exceed 220 characters today, so every row's reported evidence
is a truncated prefix — never an authored summary. R3 currently reports:

> Cross-host tests cover resume and stop-archive behavior for
> engineer/orchestrator; companions exist in both directions. Installed
> plugin-runtime 0.97.1 carries the native runtime:doctor --permission-proof...

The draft this decision replaces claimed the completion-audit output would be
unaffected, on the reasoning that it already compacts. **That is false.**
Compaction reads the cell, and the cell is exactly what changes: replacing it
with a bare link makes the audit emit `See [R3 evidence](#scorecard-r3-evidence).`
Both the default JSON `evidence.requirements[].evidence_summary` — which carries
the cell *verbatim*, all 34,444 characters of it — and the compacted
completion-audit field change.

The correct reading is the reverse of the draft's worry: because all twelve
cells already truncate, a bounded authored cell is the **first** time this
output is designed rather than accidental. Prototyped claims for all twelve rows
land at 136–213 characters, inside the budget with headroom.

### 3.3 A cell that carries proof tokens must order them correctly

This constraint was not anticipated and is easy to breach. Every occurrence of
the backticked current version in an enumerated document is a *current-state
record anchor*, and `checkProofCitations` requires a doctor run id to follow it
**within 1200 characters**. A first prototype wrote the claim as
`proven by <run-id> … under <version-anchor>` and produced a
`proof-citation-missing` finding.

Measured, the constraint is about **order, not presence**:

| cell form | release | proof | date | verdict |
|---|---:|---:|---:|---|
| pointer only, no tokens | 77 | 2/0 | 94 | clean |
| run id, then version anchor | 77 | **2/1** | 94 | **finding** |
| version anchor, then run id | 77 | 2/0 | **95** | clean |
| run id only, no version anchor | 77 | 2/0 | **95** | clean |
| authored claim, no volatile tokens | 77 | 2/0 | 94 | clean |

So the authoring rule is narrow and checkable: **a cell may name the current
proof, but if it also carries the backticked version anchor, the run id must
come after it.** Naming the proof with a recognised date-citation phrase and no
version anchor is the best of these — it keeps the audit's evidence field
pointing at a real artifact and *adds* a date pair (94 → 95).

The cross-host peer independently advised avoiding release tokens in the cell
altogether. That advice is safe but stronger than the measurement requires; the
peer's underlying point — that volatile per-release facts belong in the
append-only record — is the reason the record section exists, and it applies to
the *chronicle*, not to the single current citation.

### 3.4 What the design does not disturb

- **The four sync-managed version tokens.** `sync-doc-versions.mjs` matches
  backticked `` `plugin-runtime` `X.Y.Z` `` across the whole scorecard; one of
  the four sits in R3's cell. Same-file keeps all four in range wherever they
  land. The existing convention — superseded versions are de-backticked — now
  governs the record sections too.
- **The two singly-pinned run ids.** `doctor-20260718T080955Z-6eba4e` (R3) and
  `settings-20260704T170801Z-b66656` (R4) are pinned against deletion by
  `retention-planner.mjs` scanning tracked text. They are superseded proofs, so
  they live in the record sections — still tracked, still pinned.

---

## 4. The assertions

The existing shape test is the only thing enforcing row structure, and it is
weaker than it looks. Run against six mutations of the live document, it catches
one:

| mutation | incumbent shape test | proposed suite |
|---|---|---|
| duplicate `R3` row appended | **escapes** | caught — row count 13 |
| new `R7c` row appended | **escapes** | caught — row count 13 |
| typo in R3's anchor | **escapes** | caught — derived link absent |
| R3's record section removed | **escapes** | caught — heading absent |
| R3's cell wrapped across lines | caught | caught — row count 11 |
| R3's cell pushed over budget | **escapes** | caught — cell 438 > 220 |

The incumbent misses the duplicate and the `R7c` row for two separate reasons
worth naming, because both recur: it compares a **`Set`** of ids, so a duplicate
row dedupes away before the comparison; and it re-implements the production
row regex as `/^R\d+[ab]?$/` where the audit uses `/^R\d+[a-z]?$/`, so a row the
audit accepts is invisible to the test written to guarantee the audit sees every
row. A duplicate `R3` carrying status `pending` or an empty status flips the
whole audit to `partial` and fails the readiness gate — while the shape test
stays green.

Four assertions, all mutation-verified against a green control:

- **A1 — identity.** Exactly twelve R-rows, and the id **multiset** (not a set)
  equals the expected twelve. This single assertion closes the duplicate row,
  the `R7c` row, and the wrapped row at once.
- **A2 — shape.** Five cells on one physical line, per row. The incumbent
  guarantee, retained.
- **A3 — binding.** For every row, the cell contains the anchor *derived* from
  its id, and that anchor exists in the same file with a non-empty body. Nothing
  in the repository follows a link today, so a broken link reads `satisfied`;
  deriving the expected string from the row id rather than checking that "some
  target exists" is what makes a typo and a cross-linked row both fail.
- **A4 — budget.** Every cell survives `compactCell(220)` unchanged. This is the
  assertion that makes 34KB structurally impossible rather than merely
  discouraged, and it is why the audit's evidence field becomes authored output.

Three more the cross-host peer contributed, adopted:

- **Retention preservation.** Inject a tracked-file list containing only the
  scorecard and assert the run-id pins survive the move; removing either id from
  a temporary copy must fail. Reasoning that retention is preserved is weaker
  than asserting it, and the other pins in the tree would mask a regression.
- **Production audit on real bytes.** Read the actual scorecard into
  `tests/runtime/test-cutover-audit.mjs`'s fixture repo and run the production
  audit against it. No workflow runs the live audit today, so the duplicate-row
  gate flip would reach a human before it reached CI; `node --test` discovery
  closes that without touching a workflow.
- **Migration invariants.** The 77 / 94 / 611 identities are checked once, at
  migration, through the injection seams — with a corrupted relocated triple
  observed to produce a finding. They are invariants of the move, not permanent
  floors a later release must satisfy.

**One recogniser, not two.** A1 and A2 must consume the same row reader the
production audit uses. The `[a-z]?` / `[ab]?` divergence is what re-implementation
costs; synchronising the two literals would leave the second copy free to drift
again. A small `plugins/runtime/scripts/lib/scorecard.mjs` shared by
`checkScorecardRequirements` and the tests is the shape that removes the copy —
the test keeps its own independently pinned list of the twelve expected ids, so
widening the recogniser still cannot silently widen the contract.

---

## 5. Rejected

- **A separate evidence file.** Falsified by measurement in §3.1: 17 release
  claims and 29 date pairs leave the enumerated corpora with every gate green.
- **Status quo.** No coverage loss and no new assertions, but the 34KB line is
  already a breach recovery and grows every release. It fails on the one axis
  that decides this: it does not separate the two jobs.
- **Pointer-only cells.** Bounds the cell but empties the audit's evidence field
  to a 42-character link, discarding a signal that is only just becoming useful.
  §3.2 shows the field can be made meaningful for the same edit.
- **Generating the table from per-section metadata** (peer's third approach — a
  fenced JSON record beside each section, rendered into the table, drift-checked
  the way `sync-marketplace-versions.mjs` checks the catalog). Genuinely
  attractive: it removes hand-edited duplication and makes drift mechanical. It
  is deferred rather than dismissed — it adds a schema, a renderer, and a
  regeneration step for twelve rows, and it cannot decide whether evidence
  justifies a status, which is the judgment that actually matters here. If a
  future evidence renderer lands (the question ADR-0058 opens), the table is a
  natural second projection and this decision does not obstruct it.

---

## 6. Consequences

- The runtime-side assertions only bind once `plugin-runtime` ships them.
  Installed auditors keep their current validation until then.
- The migration is a **one-time** authored edit of twelve cells, not a
  mechanical move: each claim must be written, and for proof-backed rows it must
  respect §3.3.
- The record sections make the scorecard longer, not shorter. That is intended —
  the growth moves from a place where it is unreviewable to a place where it
  diffs line by line.
- `--completion-audit` output changes for all twelve rows. This is the point,
  and it is a deliberate change to a reported surface rather than a side effect.
