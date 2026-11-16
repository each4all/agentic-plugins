# ADR-0069 history: The change a review is bound to

This file is the record: measurements, amendments, implementation notes and
superseded text of [ADR-0069](../0069-review-change-identity.md), each as it
was written. The ADR states the current decision (ADR-0070). Corrections
written as dated text inside the ADR's decisions are gathered here under
their date, each passage under the place it stood.

## Measurements

Two independent prototypes, each in throwaway repositories outside the
checkout, each with controls; git 2.54.0 (Apple Git-157), Node 24.11.1,
macOS. The scripts and raw results are kept outside the repository, with
the macro's operation records
(`~/.agentic-plugins/ops/macro-4b2055/c163-a2-review-identity/`:
`proto.mjs` and `results.md`, `attrib.mjs` and `config-attribution.txt`,
the peer's `peer/probe.mjs`, `peer/results.json`, `peer/rename-rendering.json`
(the rename-rendering case) and `peer/envelope.json` (its answer), and the
probes run
after the critiques, `probe-refine.mjs` and `probe-refine.txt`,
`probe-refine-2.mjs` and `probe-refine-2.txt`). Each harness runs its own
git calls with no user or system configuration
(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`). The digest
functions the local and peer harnesses import (`treeDigest`,
`contentProjection`, `currentTreeDigest`) build their own environment,
scrubbing every inherited `GIT_*` variable, so their git calls may read the
machine's configuration; no result here is known to depend on it, and the
configuration-sensitive results come from the harnesses' own calls.
`captureWorkingTree` (P3, P4) removes only git's repository selectors
(`GIT_DIR`, `GIT_INDEX_FILE` and the like), so it keeps the harness's empty
configuration.

**Local harness**, 19 cases; each cell says whether the candidate found the
two sides the same or different, and ✗ marks a disagreement with the
expected relation:

| case | expect | patch-id `--stable` | patch-id `--verbatim` | result tree | tree + base commit | `diff --binary` digest | per-path manifest | post-image set |
|---|---|---|---|---|---|---|---|---|
| K1 control: same edit, other commit metadata | same | same | same | same | same | same | same | same |
| K2 control: one byte edited after review | diff | diff | diff | diff | diff | diff | diff | diff |
| W1 Python meaningful indentation | diff | same ✗ | diff | diff | diff | diff | diff | diff |
| W2 Markdown trailing two spaces | diff | diff | diff | diff | diff | diff | diff | diff |
| W3 Makefile tab against spaces | diff | same ✗ | diff | diff | diff | diff | diff | diff |
| W4 CRLF against LF | diff | same ✗ | diff | diff | diff | diff | diff | diff |
| W5 whitespace-only reformat | diff | same ✗ | diff | diff | diff | diff | diff | diff |
| B1 binary, two different edits | diff | diff | diff | diff | diff | diff | diff | diff |
| M1 mode only, 644 against 755 | diff | diff | diff | diff | diff | diff | diff | diff |
| M2 mode-only change against none | diff | diff | diff | diff | diff | diff | diff | diff |
| R1 rename to another name | diff | diff | diff | diff | diff | diff | diff | diff |
| R2 control: the same rename twice | same | same | same | same | same | same | same | same |
| S1 submodule bumped to another commit | diff | diff | diff | diff | diff | diff | diff | diff |
| I1 rebase onto newer main, other files | same | same | same | diff ✗ | diff ✗ | same | same | same |
| I2 rebase onto main that edited the same file elsewhere | diff | same ✗ | same ✗ | diff | diff | diff | diff | diff |
| I3 squash merge landed on newer main | same | same | same | diff ✗ | diff ✗ | same | same | same |
| E1 commit message reworded only | same | same | same | same | same | same | same | same |
| I4 rebase that reverts main's edit to a touched file | diff | diff | diff | same ✗ | diff | diff | diff | same ✗ |
| K4 working-tree capture against its commit | same | same | same | same | same | same | same | same |
| **score** | | 14 | 18 | 16 | 17 | 19 | 19 | 18 |

**Configuration.** The same change was measured again with one user diff
setting at a time. `diff.noprefix=true` and `color.diff=always` changed both
patch-ids and the `diff --binary` digest; `diff.context=7` changed both
patch-ids; `diff.algorithm=patience`, `diff.renames=copies`,
`diff.indentHeuristic=false`, `diff.relative=true` and
`diff.mnemonicPrefix=true` changed none. The tree candidates and the
per-path manifest changed under none.

**Scoped coverage.** A full review of a change touching `f1` and `f2`,
then a scoped review covering only `f2` after `f2` was edited: the per-path
composition vouches for the committed change, a single whole-change digest
does not match the first review, and the negative control (an unreviewed
edit of `f1` after the full review) is not covered.

**Peer harness** (independent; its candidates: P patch-id `--stable`, V
patch-id `--verbatim`, T the captured working tree, D the verification
digest, C the snapshot content projection, E the base and result tree pair,
M the full per-path manifest, S the entries of one scoped path):

- Meaningful Python indentation: P same (collision), every other candidate
  different; a non-whitespace token control is different for all.
- Committing the reviewed bytes and rewording the message: all same but D,
  which includes HEAD.
- Binary, mode, rename and an edit outside a scoped review: all different
  on the full change; S same for the edits outside its path.
- Rebase and squash onto a base that changed another path: P, V, M and S
  same; T, D, C and E different. Rebased against squashed with equal
  endpoints, and a rebase onto a base with an identical tree: same for all
  but D.
- A rebase that inserted context into the reviewed file: P and V same
  (they miss it), every tree and manifest candidate different.
- The same result tree from a different before-image: T and C same (they
  miss it), P, V, E and M different.
- A submodule pinned to a different commit with identical files: C same (it
  erases the pin), the others but S different. Dirty submodule bytes with an
  unchanged gitlink, and a deinitialized submodule with an unchanged pin: P,
  V, T, E and M same; D and C different.
- Rename rendering: the same endpoints give different `patch-id --stable`
  with `--no-renames` and with `--find-renames=50%`.

The per-path manifest gave the expected relation on every case of both
harnesses: the local one's 19, and every case of the peer's as M. The local
"tree + base commit" column hashed the result tree with the *base* commit,
not the commit holding the change, so it is not the verification digest and
its "same" on K1, E1 and K4 says nothing about that digest; the peer's D is
the real digest, and it changed on every new commit around the same tree
(committing the reviewed bytes, a reworded message). The peer's E differs from M
only on the rebase and squash onto a base that moved other paths, where it
reports a different change by design: that difference is the conflict the
owner settled in Decision 2.

**Probes after the critique** (`probe-refine.mjs`, each a throwaway
repository; P3 and P4 call the real `captureWorkingTree` of
`persona-pipeline/files/scripts/lib/peer-snapshot.mjs`). Some replace
claims the earlier text took from the plan-verify peer's probes, which were
reported in its answer and not kept (run
`plan-verify-20261107T023545Z-4ee70e`); one of those claims did not hold
(P2).

- **P1 submodule ignore.** A gitlink moved between two commits: the
  prescribed `diff-tree` without the option prints the `M` entry (control);
  with `submodule.mod.ignore=all` in the repository's configuration, or in
  `.gitmodules`, it prints nothing; with `--ignore-submodules=none` it prints
  the entry again, `diff.ignoreSubmodules=all` set as well. Measured again on
  2026-11-08 (git 2.54.0), after a mutation of the manifest's option survived
  a test with no `.gitmodules`: the setting hides the entry only when
  `.gitmodules` maps the path to the name, and `diff.ignoreSubmodules=all`
  alone hides nothing, with or without the mapping.
- **P2 criss-cross.** Two best merge bases; `git merge-base` printed the
  same one of them for both argument orders (the earlier claim that the
  order selects did not hold), and the manifests from the two bases to one
  result tree touch different paths (`f`, `h` against `g`, `h`).
- **P3 state homes.** A base tracking `.agentic-plugins/state/x.json`, an
  edit of `a` captured and committed: unfiltered, the reviewed manifest
  holds `D .agentic-plugins/state/x.json` and `M a`, the committed one `M a`
  only; filtered, they are equal.
- **P4 end of line.** CRLF and LF working files captured as one tree under
  `text eol=lf`; with no attribute and no `core.autocrlf`, two trees
  (control); with no attribute and `core.autocrlf=input`, one tree.
- **P5 a rebase that drops a commit.** A branch of two commits, one already
  cherry-picked to `main`: the rebase keeps one, and walking back two
  commits from the landed tip reaches a `main` commit before the landing's
  start.
- **P5b a rebased series of two.** The last commit alone touches `pkgB/y`;
  the interval from the landing's start touches `pkgA/x` and `pkgB/y`.
- **P6 a stale ref on both sides.** The scenario of Decision 1, item 3: the
  committed manifest against the stale ref equals the reviewed one; against
  the fresh ref it does not (control), and neither does the landed one from
  the squash commit's first parent.
- **P7 a ref stale on one side** (`probe-refine-2.mjs`). A branch on B,
  `main` moved independently to B′: the merge base is B against the stale
  ref and against the fresh one. Control: once the branch merged B′, the
  fresh ref gives B′ and the stale one B.
- **P8 trailers on landed commits** (run on this repository, 2026-11-07,
  `git log -200 --format='%(trailers:key=Workflow-ID,valueonly)' origin/main`
  and the same over `--all -2000`). No commit of the last 200 on `main`
  carries a `Workflow-ID` trailer. Of the 2000 most recent commits over all
  refs, 271 carry one: 147 reachable from `main`, all older than those 200,
  and 124 not. A landed commit is therefore no reliable source of a
  change's members.

## Amendment 2026-11-08 — corrections from the critiques of 2026-11-07 and 2026-11-08

In Decision 1, item 5:

   `--ignore-submodules=none` is required: without it `diff-tree` honours
   `submodule.<name>.ignore` from the repository's configuration or
   `.gitmodules`, for a path `.gitmodules` maps to that name, and with `all`
   a changed pin prints nothing, so two pins would read as the same change
   (corrected 2026-11-08: this also named `diff.ignoreSubmodules`, which
   `diff-tree` does not honour, P1; the decision is unchanged); scrubbing the
   `GIT_*` variables does not remove configuration (measured, P1; Phase 7's
   staging guard passes the same option). The same projection, that filter

In Decision 3, A partial series claims nothing:

**A partial series claims nothing.** The comparison is made at admission, before
the series' first commit, from the tree its last commit will hold (HEAD with the
staged paths, through a temporary index), so a package left out of the commit is
seen before anything lands. The tree is projected as Phase 7 stages: the staging
set Phase 7 derives (the manifest's paths git reports changed, with the extras
opted in), each path through the same `git add`, in the same environment (added
2026-11-08, critique of 2026-11-08, MAJORs 1 to 3). The owner's acceptance projects
that same set. A comparison is recorded only for the tree after the workflow's
last commit. A series stopped part way records none, and its landing is
`not-comparable` until the recovery path records one.

In Decision 3, the table At Phase 7:

| | autopilot | interactive |
|---|---|---|
| `same`, `no-reviews` | commits | commits |
| `different` | refused, exit 10 `review-held` | refused, exit 10 `review-binding-mismatch`, re-routed to `/<persona>:critique` |
| `not-comparable` | refused, as `different` | warns and commits: it proves nothing either way (but `repository-mismatch` is refused, added 2026-11-08) |

In Decision 3, The outcome gate narrows:

**The outcome gate narrows.** A1b reads the latest outcome whatever tree it saw.
Given a comparison that read reviews which count and compared them (`same` or
`different`), Phase 7's gate passes over an attempt the record shows to be of
another change: a review that did not count is of another change when, on a path
the change touches that it is the latest such review to have covered, the entry it
saw is not the change's. A path the commit leaves out (an untracked or unstaged
file the snapshot held) says nothing either way. An attempt the record shows
nothing of (no identity; another version, object format or branch; no subject; an
earlier failure whose paths a later one covered) stays read, conservatively. A
comparison that read no counting review (`no-reviews`), or proved nothing
(`not-comparable`), narrows nothing: a failure is then all there is, and it holds
as A1b holds it. (Corrected 2026-11-08, by the critique of 2026-11-07, CRITICAL 1:
the first implementation narrowed on any comparison, `no-reviews` included, and
judged "another change" by the whole manifest's digest.)

The Consequences section keeps its own dated lines of that day.

## Amendment 2026-11-09 — the owner's simplification of the binding (Decisions 3 and 4)

The Status section recorded it so:

Decisions 3 and 4 were rewritten on 2026-11-09 by the owner's instruction to
simplify the binding (Decision 3, its opening note), which also narrows how
Decision 2's composition is applied; each place it does carries a dated note.

Decision 3 opened so:

**Rewritten 2026-11-09 by the owner's instruction** (recorded in engineer
workflow `compose-20261107T140106Z-f8c9f6`, instruction `dc58d5079a169b9b`). Six
critiques had run, and since the fourth almost every MAJOR was in a mechanism an
earlier refine had added so that more cases could read `same`; each fix opened a
new surface. The owner chose the default a review gate should have: `same` only
where it is certain, `not-comparable` everywhere else. A false halt costs one more
critique or an owner acceptance; a false pass defeats the gate. Rare arrangements
are documented limits, not code (the owner's rule of 2026-10-25). Each mechanism
this removed is in § Alternatives Considered, with its cost; where this decision
narrows Decision 2's composition, Decision 2 carries a dated note pointing here.

In Decision 1, item 4:

4. **`result_tree`**: the reviewed result, the tree the review saw, never
   the checkout at settlement; **`source`**, which capture it came from;
   and **`captured_at`**, the UTC time of that capture (amended 2026-11-09:
   recorded, and ordering nothing; Decision 3 orders reviews by their position in
   the workflow's ledger):

In Decision 1, item 5:

   its digest: the snapshot's trees are referenced by nothing, so `git gc`
   may prune them, and scoped coverage (below) compares entries path by
   path. A2b may keep a long list beside the workflow with its sha256 in the
   attempt; the identity is the list. (Corrected 2026-11-08 and 2026-11-09: A2b keeps no list beside the workflow,
   nor each review's list: the record keeps, per path, the entry the latest
   counting review saw, and a record past its cap makes the change not
   comparable; Decision 3.)

In Decision 2, Scoped coverage composes path by path:

**Scoped coverage composes path by path.** Several reviews together vouch
for a change when every path touched by the change, or touched by a counting
review on a path it covers, has, from the counting review whose coverage
includes it, an entry equal to the change's (a path untouched on both sides
is equal). Among the counting reviews whose coverage includes a path, the
latest answers for it: the one with the latest `captured_at`, the time its
result tree was captured, not when it was registered or settled, since
reviews finish out of order. Reviews tied on that time answer together, and
their entries for the path must all equal the change's. (Amended 2026-11-09,
Decision 3: the latest by position in the workflow's own ledger, so no two tie.) A path the change
touches that no counting review covers fails, as does a path whose
answering review's entry differs: either way the change is not vouched for.
A `full` review's `covered` holds every path its manifest touches, and a
path the change touches beyond it is uncovered, so with one `full` review
and no other the rule is plain manifest equality.

In Decision 2, A path a later whole review no longer shows:

**A path a later whole review no longer shows.** A path an earlier review
covered and touched, and the change no longer touches (a file compose wrote
and a plan-verify covered, then removed by a refine), keeps that review
answering for it unless a later review covers it, and a later subject
names a file that is gone only when it shows the removal (a patch or a
pending change deleting it), never when the file was untracked.
A later counting review of the same workflow answers for such a path in its
place when two things hold: the later review is `full`, so its subject held
the whole change at its capture, and the path is not in its `shown` at all.
It answers for the path as untouched, in its own place (amended 2026-11-09: by
ledger position, Decision 3): the
reviewer was given the whole change and the path was not in it, so its
content was the base's. A path the later review's subject showed, at any
content, is answered for only through its `covered` (item 6), so a path it
showed changed and left out of `covered` stays outside it, and the earlier
review still answers. A review of another workflow, or one that is not
`full`, clears nothing. When the change does touch the path, the untouched
entry differs from the change's and the change is not vouched for, so the
clearing never vouches for content no reviewer saw.

In Decision 2, before The reviews it reads:

(Amended 2026-11-09 by the owner's instruction, Decision 3 § Whose reviews and
§ After the merge: the composition reads the committing workflow's reviews
alone, an interval holding another workflow's commit, or a commit naming none,
is not comparable, and the landed comparison reads no review, comparing the
landed manifest with the committed comparison's. The rest of this section, to
§ The same change, records the member rule as it was accepted; it is no longer
applied.)

In Decision 2, The same change:

**The same change** — these differences do not count:

- commit metadata: message, author, committer, dates, parents, signatures
  (the identity is unchanged; a message rewritten so that a `Workflow-ID`
  trailer is gone changes which reviews the comparison reads, § The
  reviews it reads; since 2026-11-09 such a commit makes the change
  `not-comparable`, Decision 3 § Whose reviews);

## Implementation of slices 1 and 2 (A2b)

- `scripts/lib/change-identity.mjs` (persona-pipeline) reads git: the landing
  branch, the merge base, the manifest, the projection, the interval's commits
  and the two comparisons. `scripts/lib/review-attempts.mjs` holds the pure rule
  (`applyReviewBinding`, `compareWithBindings`, `attemptsOfOtherChange`) and the
  document.
- **The record.** `peer-runner.mjs run` captures the identity after the snapshot,
  before the peer, and captures the snapshot again after the peer's group has
  stopped, over an index of the launch tree, so a submodule the live checkout moved
  and did not stage does not read as moved back; settle records the identity only
  when the two trees are equal, and refuses a run whose runner is still between its
  terminal status and that capture. A dispatch records its subject with
  `--subject-file` (`subject.json` beside the prompt, written with the file tool,
  ADR-0059). With no run launched, settle takes the capture and the subject itself
  (`subject.json` in the finalize's text directory, on the Codex skill path too).
  The record is applied under the lock that records the attempt's outcome, against
  the ledger as it then stands. Its cap is 128 KiB, since readers allow a whole
  frontmatter 256 KiB; a workflow keeps its 32 newest committed comparisons.
- **The comparison** is recorded as `review_bindings.comparisons[<commit>]`
  (state, reason, branch, base, result tree, manifest digest), by Phase 7 after a
  last commit and by `state.mjs review-binding-record` for a commit an amend or a
  local rebase made.
- **The projection** is the tree Phase 7's staging leaves (`projectedTree`): HEAD
  read into a temporary index, each path's real index entry over it (no stat data,
  so `git add` reads every file again), a staged deletion removed, and every other
  path through `git --literal-pathspecs add` (`--force` for a submodule), in the
  process's whole environment, as Phase 7's `git add` runs; the manifest read from
  that tree still runs with no inherited `GIT_*` variable. A path flagged
  assume-unchanged or skip-worktree is not projected (`index-flags`). The staging
  set comes from one place, `commitStagingSet` in `phase7-commit.mjs`, which
  `review-binding-accept` reads too. A repository the environment selects
  (`GIT_DIR`, `GIT_WORK_TREE`) that is not the checkout, compared as files, makes
  the projection `repository-mismatch`, which Phase 7 refuses in either mode. A
  comparison with no acceptance key names the cause to clear, never an acceptance
  that could only fail.
- **The completion path.** `resolve-landing` adds `landed_review`, asked of the
  engineer through `state.mjs review-compare-landed`, since a plugin calls another
  through its CLI (ADR-0010 §5). The child's file is found in the state root,
  active or archived; copies that differ (an active and an archived one, or an
  archive under a suffixed name) are no one workflow.
- **The owner's overrides** on the completion path are refused at the write:
  `subtask-update` refuses `--accept-landed-change` and both waivers when
  `AGENTIC_AUTOPILOT` names a run, and the autopilot policy halts a done step that
  completed its subtask with no landed commit, the macro's last subtask included.
- Paths are decoded with `ignoreBOM`, so a leading U+FEFF stays part of a file
  name. The Codex settle of a review that never launched passes `--subject-file`
  as words of its own (`${TEXT_DIR:+…}` is one word under zsh).

## Superseded text 2026-11-14 — the Status section before the ADR-0070 migration

The Status section as it stood before the ADR moved to the ADR-0070
layout; the Status section now holds the status only.

Slice 1, Decisions 1 and 2: Accepted (2026-11-07: the owner accepted them
explicitly in the main session). Slice 2, Decisions 3 and 4: Proposed, with
A2b's implementation, in its own change; the owner accepts them on their own.
Decisions 3 and 4 were rewritten on 2026-11-09 by the owner's instruction to
simplify the binding (Decision 3, its opening note), which also narrows how
Decision 2's composition is applied; each place it does carries a dated note.
- Docket item C163, items A2a and A2b, of macro
  `macro-plan-20261104T045033Z-4b2055`. The number is the next free one.
- Written in two slices, one subtask each:
  - **Slice 1 (this text, A2a):** Decision 1, the change identity a review
    records, and Decision 2, which differences between a reviewed change
    and a committed or landed change count as the same change. Both rest on
    measurements taken by prototype (§ Measurements).
  - **Slice 2 (A2b):** Decision 3, enforcement and the owner's override, and
    Decision 4, how review records written before the identity existed are
    read, including a rollback to an older reader. A2b also implements
    Decisions 1 and 2 (§ Implementation of slices 1 and 2).
- Decision 1 converged between the local prototype and a Codex peer's
  independent one (engineer workflow `decide-20261107T014723Z-38653a`, run
  `brainstorm-20261107T014900Z-cfdcaa`). Decision 2 was a recorded conflict
  between the two (equal per-path manifests against equal base and result
  trees); the owner chose the middle form on 2026-11-07, which this text
  states.
