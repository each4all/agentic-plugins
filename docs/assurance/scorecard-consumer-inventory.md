# Consumers of the scorecard R-rows

An inventory, not a proposal. It exists because a later decision has to choose
how the `omcc-cutover-scorecard.md` requirement rows carry their evidence, and
that decision is only as good as the list of things that read them.

Measured at `2cb9637` on branch `test/scorecard-consumer-inventory`, which
carries no commits of its own at the time of measurement. **No live document was
modified**: every experiment ran against in-memory copies through the checks'
own injection seams, or against throwaway clones. The scorecard's content digest
was identical before and after, and a cross-host peer independently reported the
same digest.

Throughout, two moves are distinguished:

- **same-file** — the evidence bytes move elsewhere inside the scorecard and the
  cell becomes a link.
- **separate-file** — the evidence bytes move to a new tracked markdown file
  under `docs/` and the cell becomes a link.

The classification that matters is not BREAKS. It is **SILENTLY CHANGES
OUTPUT**: a consumer that keeps passing while measuring less.

---

## 1. What reads an R-row

| Consumer | Reads | Shape assumed | same-file | separate-file |
|---|---|---|---|---|
| `plugins/runtime/scripts/cutover-audit.mjs:521` | The only production R-row parser | Positional cells over the **whole document**; accepts **three or more** cells and reads 0–4 | SILENTLY CHANGES OUTPUT | SILENTLY CHANGES OUTPUT |
| `scripts/check-doc-evidence.mjs:353` — release triples | Enumerated 3-document corpus | Flattened regex; no notion of rows | UNAFFECTED | **SILENTLY CHANGES OUTPUT** |
| `scripts/check-doc-evidence.mjs:517` — proof/date | Enumerated 3-document corpus | Anchor phrases + exact citation forms | UNAFFECTED | **SILENTLY CHANGES OUTPUT** |
| `scripts/check-doc-evidence.mjs:660` — commit shas | **Discovered** corpus via `git ls-files` | Token extraction, deduplicated | UNAFFECTED | UNAFFECTED — it follows the bytes |
| `scripts/sync-doc-versions.mjs:131` | Whole-file, path-specific rule | Backticked `plugin-runtime` version tokens | UNAFFECTED | **SILENTLY CHANGES OUTPUT** |
| `plugins/runtime/scripts/lib/retention-planner.mjs` | Every tracked text file | Run-id tokens; **never names the scorecard** | UNAFFECTED | Live risk — see §4 |
| `tests/plugin-shape/test-runtime-plugin.mjs:1044` | Live scorecard | One physical line, exactly five cells, expected id set | UNAFFECTED unless the link contains a pipe | same |
| `tests/scripts/test-doc-evidence-consistency.mjs:81,180,188` | Live enumerated corpus | Aggregate floors only | UNAFFECTED | **stays green while coverage drops** — see §3 |
| `tests/runtime/test-cutover-audit.mjs` | Synthetic fixtures | Twelve five-cell rows | UNAFFECTED — cannot see live behaviour | same |

A path sweep finds the scorecard named in **16 tracked files**. Only the rows
above read its *content*; the remainder are prose references, navigation links,
a workflow staging list, and test fixtures.

---

## 2. The enumerated / discovered asymmetry

The two corpora in `check-doc-evidence.mjs` respond to the same edit in opposite
directions. Measured through the checks' own `{ docs }` injection seam:

| | release triples | proof/date pairs | commit shas |
|---|---:|---:|---:|
| baseline | 77 | 94 | 575 |
| same-file move | 77 | 94 | 575 |
| separate-file move | **60** | **69** | 575 |

The discovered check follows the bytes into the new file and is unharmed. The
enumerated checks do not, and lose coverage. **Both report zero findings in every
variant** — the loss is invisible at the gate.

Two refinements the prior reading did not carry:

- The **R3 row alone** accounts for the entire triple loss and most of the date
  loss. Moving R3 gives 60 / 69; adding R4 gives 60 / 65; moving all twelve rows
  costs nothing further. The exposure is concentrated in one cell, not spread
  across the table.
- `94` is the `dateChecked` count. The primary current-proof `checked` count is
  `2` and is unchanged by any variant, so a summary that reports "proof coverage
  94 → 69" is describing the superseded-history counter, not current-proof
  verification.

---

## 3. Why the tests would not notice

`tests/scripts/test-doc-evidence-consistency.mjs` asserts floors, not values:

| Assertion | Floor | separate-file reading | Result |
|---|---|---|---|
| `r.checked > 20` (release) | > 20 | 60 | passes |
| `r.checked > 0` (current proof) | > 0 | 2 | passes |
| `r.dateChecked >= 30` | ≥ 30 | 69 | passes |

So a separate-file move drops release coverage by 17 claims and date coverage by
25 pairs **with the whole suite green**. The file says as much about itself at
line 135: an aggregate `checked > 20` "cannot notice one claim falling out".

`sync-doc-versions.mjs`'s scorecard rule matches four backticked version tokens
today. Exactly one of them sits inside the R3 evidence cell, so a separate-file
move silently reduces the rule to three managed occurrences. Nothing asserts a
match count, so no test fails.

---

## 4. The consumer that names no path

`retention-planner.mjs` scans every git-tracked text file for run-id tokens and
pins the artifacts it finds. It never mentions the scorecard, so a path grep
does not reveal it — and it is a real consumer of R-row evidence content.

The R-row evidence cells carry **54 unique run-id tokens**: 38 doctor, 10
settings, 5 compat, 1 bootstrap.

Of those, **two are pinned by the scorecard and by nothing else** in the tracked
tree:

| Run id | Row |
|---|---|
| `doctor-20260718T080955Z-6eba4e` | R3 |
| `settings-20260704T170801Z-b66656` | R4 |

Both artifacts exist on the authoring machine today. If their evidence cells
moved anywhere untracked, retention would stop pinning them and they would
become deletion candidates. A move to a *tracked* file under `docs/` keeps the
pin, because the scan is tracked-file-wide rather than path-specific.

This is the one finding where the two independent sweeps disagreed. The
cross-host peer reported 53 tokens and that all of them also occur elsewhere;
re-measuring found 54 — its family list omitted `bootstrap` — and found the two
above occurring nowhere else. The disagreement is recorded rather than smoothed
over, because it is the difference between a latent risk and a live one.

---

## 5. Shape, links, and duplicates

**What enforces the five-cell single-line shape.** Not the production parser:
`cutover-audit.mjs` accepts three or more cells and reads positions 0–4. The
only enforcement is `tests/plugin-shape/test-runtime-plugin.mjs:1044`, which
requires one physical line, exactly five cells, and the expected id set. It
accepts a link-bearing cell; it fails if the link contains a pipe or the row
wraps.

The two R-row patterns also diverge: the audit accepts `R\d+[a-z]?` while the
shape test pins `R\d+[ab]?`. A row keyed `R7c` would enter the live audit and be
invisible to the test that exists to guarantee the audit sees every row.

**Nothing follows a link.** No consumer resolves an anchor or dereferences a
cell. Replacing R3's evidence cell with a link leaves the audit reporting
`satisfied` with a 22-character evidence value. A **broken link still reads
satisfied**. Searches found no markdown AST, link checker, or anchor validation
anywhere in the repository.

**A duplicate R-keyed row is picked up.** `parseMarkdownRows` scans the entire
document with no section scoping, so a same-file detail section containing a
literal `| R3 | … |` row becomes a thirteenth requirement:

| Injected row | Audit result |
|---|---|
| duplicate R3, status `satisfied` | 13 rows, still `satisfied` — silently double-counted |
| duplicate R3, status `pending` | 13 rows, **`partial` — the readiness gate fails** |
| duplicate R3, empty status cell | 13 rows, **`partial` — the readiness gate fails** |

In all three the shape test still passes, because it compares a `Set` of ids and
asserts no row count. A prose heading such as `### R3 evidence` is safe; a
literal table row is not.

No CI workflow runs the live cutover audit against the real scorecard — CI runs
the structural shape test plus synthetic parser fixtures — so none of the three
rows above would be caught before a human ran the audit.

---

## 6. Edges of the sweep

Searched and **not** found: a second production R-row parser; any section-scoped
parser; any uniqueness or row-count check; any consumer that follows or
validates a cell link; an alternate path, environment override, or packaged copy
of the scorecard; and any exact coverage floor pinning today's release or date
counts.

Both sweeps agreed the scorecard path appears in 16 tracked files. Remaining
matches elsewhere in the checkout are gitignored workflow and peer-run
artifacts, plus one inactive host-settings backup — recorded copies of the
pathname, not executable consumers.
