# ADR-0069: The change a review is bound to

## Status

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

## Context

**The defect.** Nothing binds a review to the change it reviewed. A change
edited after its critique commits, and lands, under the old verdict:

- No `patch-id`, digest or tree comparison runs between a review and a
  commit anywhere in the commit path (Phase 7) or the completion path
  (`resolve-landing`, `/orchestrator:done`).
- The review ledger of the persona plugins' `scripts/lib/review-scope.mjs`
  (C120; ADR-0063, amendment of 2026-10-14) records the tree each critique
  reviewed, but only
  to scope the next critique of a *document* deliverable; a code deliverable
  has no ledger, and nothing reads the ledger's tree at commit.
- A1a (ADR-0023, implementation note of 2026-11-05) records, per review
  attempt, the trees the peer's snapshot saw (`head`, `index_tree`,
  `worktree_tree`, from the run's handle). It records no base, so it cannot
  say which change those trees hold, and no rule compares them with what was
  committed. A1a records; it enforces nothing, and nothing reads its trees
  yet. The planned A1b gate (a later subtask of the same macro) is to read
  the latest review outcome whatever tree it saw, conservatively, until this
  ADR's binding narrows it.

**What a review sees.** A review-type ensemble (`review`,
`adversarial-scan`, `plan-verify`, `refine-verify`) runs its peer in a
snapshot of the checkout (ADR-0023, amendments of 2026-10-13 and
2026-10-14, C96; a claude peer too since the implementation note of
2026-11-05, C163 D2b). The snapshot's
`worktree_tree` is `git write-tree` of the checkout's non-ignored working
tree through a temporary index, with the state homes removed
(the persona plugins' `scripts/lib/peer-snapshot.mjs`, `capture`). That
tree is the reviewed *result*. A change is a result relative to a *base*, and a review's verdict
is about the change, so the result tree alone does not identify what was
reviewed.

**What existing digests measure.** The verification digest
(`state.mjs currentTreeDigest`, the orchestrator's `lane-digest.mjs`
`treeDigest`, version 1) includes HEAD on purpose: a verification result
applies only to the exact tree it ran on. It therefore changes across a
rebase, a squash or an amend, all of which keep a reviewed change intact.
The workflow content digest is about the workflow file, not the code.

**What the owner asked for.** Decide by prototype and measurement, not
prediction: a peer's earlier probe found two Python patches differing only
in meaningful indentation (`None` against `0`) with the same
`git patch-id --stable`. Cover meaningful whitespace, binaries, modes,
renames, submodules, scoped-review coverage and a changed integration base.

## Decision

### Decision 1 — the change identity a review records

A review records, with its attempt, the identity of the change it reviewed:

1. **`v`**, the projection version, `1`. A reader compares only identities
   of a version it knows; any other is not comparable.
2. **`object_format`**, the repository's (`git rev-parse
   --show-object-format`: `sha1` or `sha256`). Identities of different
   object formats are not comparable.
3. **`base`**: the integration base the change is measured from, as the
   commit and its tree, with the branch to land on and where that branch
   came from. The base is the merge base, at capture time, of the
   captured HEAD (the snapshot's, or the checkout capture's, item 4) and the
   remote-tracking ref of the branch to land on
   (`refs/remotes/origin/<branch>`, the ref the landing resolver checks,
   `plugins/orchestrator/scripts/landing.mjs`; the local branch
   `refs/heads/<branch>` only where the repository has no `origin` remote).
   The branch is taken, first that applies, from:
   1. an explicit argument naming it;
   2. the parent macro's `git_baseline.branch`, for a workflow a macro
      dispatched (its `parent_workflow_path`, ADR-0067 Decision 3), which is
      the integration branch `resolve-landing` uses
      (`plugins/orchestrator/scripts/state.mjs`, `resolve-landing`);
   3. the repository's default branch, the branch `refs/remotes/origin/HEAD`
      points to. A repository with no `origin` remote, or one whose
      `origin/HEAD` is not set, has no default branch here: no local branch
      is guessed as the default, and with no argument and no macro there is
      no branch to land on (no identity, below).

   The workflow's own `git_baseline.branch` is the working branch, not the
   one to land on, and a lane's `lane.json` records no base, so neither is
   a source. The record keeps the branch and its source (`argument`,
   `macro` or `default`): a stacked or non-default target that fell back
   to the default branch is visible, never silent. The base is the merge
   base and not HEAD, so that the change reviewed on a branch with earlier
   commits is the same change a squash or rebase merge lands.

   **A stale ref.** A ref stale on one side only (the review's or the
   commit's) can make the two manifests start from different bases; it
   need not, since a branch that never took in the newer commits has the
   same merge base with the stale ref as with the fresh one (measured, P7: a
   branch on B, `main` moved independently to B′, merge base B against
   either; a branch that merged B′ gets B′ from the fresh ref only). When the
   bases do differ, the manifests can
   still be equal, when the bases differ only on paths neither side touches
   (a rebase over a base that moved other files, the rule's own "same
   change"), and they differ when the bases differ on a touched path. The
   same stale ref on both sides
   can say "the same" where the landing differs: a review from B to R, then
   `main` moves to B′ editing a touched file, the branch is rebased onto B′
   and the reviewed content restored; against the stale ref both manifests
   run from B and are equal, while the real transition from B′ is not
   (measured, § Measurements, P6). The committed comparison is therefore
   provisional; the landed comparison, which starts from the landing's own
   parent and uses no ref (Decision 2), is the one that holds. A2b reads
   the ref after a fetch where it can.

   When `git merge-base --all` gives more than one best base (a criss-cross
   history), no base is chosen: the identity is not recorded (below), and a
   committed change in the same state is not comparable. `git merge-base`
   without `--all` prints one of them, chosen by git's traversal, not by
   anything the change is, and the manifests from the two bases touch
   different paths for one result tree (measured, P2; the order of the
   arguments did not change the base printed). The refusal is for the
   computations that use a merge base, the review's and the committed one;
   the landed interval starts from the landing's parent and needs none.
4. **`result_tree`**: the reviewed result, the tree the review saw, never
   the checkout at settlement; **`source`**, which capture it came from;
   and **`captured_at`**, the UTC time of that capture (amended 2026-11-09:
   recorded, and ordering nothing; Decision 3 orders reviews by their position in
   the workflow's ledger):
   - `snapshot`: when the peer launched in a snapshot, the snapshot's
     `worktree_tree`, the tree the peer saw. The review's local half, and
     the subject the dispatching verb collected (item 6), read the live
     checkout, which is that tree only while nothing edits it. A verb can
     edit while its own review runs (the first refine of this ADR edited it
     while its refine-verify peer ran), and a person can edit by hand. The
     identity stays the snapshot's either way, so a binding holds only what
     the peer saw; that the local half and the collected subject may have
     read another tree is a limit.

     The snapshot is a writable worktree, and a peer can change it while it
     reviews (resetting, reformatting or regenerating a file; the codex
     peer's habit of reverting a working tree is why the snapshot exists).
     The launch tree is the tree the peer saw only while the snapshot is
     unchanged, so the runner captures the snapshot again, with the same
     capture, after the peer's process group has stopped and before it
     removes the snapshot (the `finally` of `peer-runner.mjs` `run`, which
     today removes it unchecked), and records that tree with the launch
     one. The identity is recorded only when the two are equal; when they
     differ, or the second capture fails, the review records no identity
     (below). A change the peer made and undid before it ended is not
     seen; that is a limit.
   - `checkout`: when no peer launched (unavailable, local-only by design,
     the privacy gate, or the owner's skip), a capture of the checkout
     taken where the snapshot would have been, with the same capture
     (`captureWorkingTree` of the persona plugins'
     `scripts/lib/peer-snapshot.mjs`, which C120 already takes for
     documents), so the tree the local
     reviewers read has an identity too. Whether such a review counts (its
     outcome is `unavailable` or `skipped`, A1a) is Decision 3's; the
     identity only says what it saw.
5. **`manifest`**: the per-path transition list from base tree to result
   tree, exactly as

   ```text
   git diff-tree -r -z --raw --no-renames --full-index --ignore-submodules=none <base tree> <result tree>
   ```

   prints it: for each touched path, its old and new mode, old and new object
   id, and status (`A`, `D`, `M`, `T`), with rename and copy detection off (a
   rename is a delete and an add), in the path order git prints, run with no
   inherited `GIT_*` variable, and with every entry under the paths the
   snapshot removes (`SNAPSHOT_EXCLUDED_PATHSPECS` of the persona plugins'
   `scripts/lib/peer-snapshot.mjs`, the state homes) dropped.
   `--ignore-submodules=none` is required: without it `diff-tree` honours
   `submodule.<name>.ignore` from the repository's configuration or
   `.gitmodules`, for a path `.gitmodules` maps to that name, and with `all`
   a changed pin prints nothing, so two pins would read as the same change
   (corrected 2026-11-08: this also named `diff.ignoreSubmodules`, which
   `diff-tree` does not honour, P1; the decision is unchanged); scrubbing the
   `GIT_*` variables does not remove configuration (measured, P1; Phase 7's
   staging guard passes the same option). The same projection, that filter
   included, computes every manifest a review is compared with
   (Decision 2): unfiltered, a tracked file under a state home reads as
   deleted in the reviewed manifest and is absent from the committed one
   (measured, P3, through the real capture). The list is recorded, not only
   its digest: the snapshot's trees are referenced by nothing, so `git gc`
   may prune them, and scoped coverage (below) compares entries path by
   path. A2b may keep a long list beside the workflow with its sha256 in the
   attempt; the identity is the list. (Corrected 2026-11-08 and 2026-11-09: A2b keeps no list beside the workflow,
   nor each review's list: the record keeps, per path, the entry the latest
   counting review saw, and a record past its cap makes the change not
   comparable; Decision 3.)
6. **`coverage`**: the paths the dispatching verb actually put in the
   reviewer's subject, recorded with the attempt by that verb when it
   dispatches, as two path sets, either of which may be empty: **`shown`**,
   every path the subject showed, and **`covered`**, those of them it showed
   at the content the result tree holds (the exclusion below). The label
   `full` is recorded only when `covered` holds every path the identity's
   manifest (item 5) touches, so that the reviewer was given the whole
   change from the integration base. `full` is a label, never a widening:
   the review covers `covered` and no other path, so a path the exclusion
   below left out stays uncovered however whole the rest is. Decision 2
   makes one further use of it, which vouches for no content the reviewer
   did not see: a later `full` review of the same workflow answers, as
   untouched, for an earlier review's path that is not in its `shown` at
   all (§ A path a later whole review no longer shows).
   Coverage is never derived from the review's type, the workflow's
   baseline, its commit manifest or the identity's manifest; a review whose
   dispatch recorded no subject covers no path. What each dispatch puts in
   its subject is its own contract, and the record follows it, for example:
   - a critique of the pending change (`critique` Step 1, single
     commit-pending review): the paths of the staged and unstaged hunks
     and of the untracked files it embedded;
   - a critique of the entire branch (`critique` Step 1): the paths of the
     `git diff <base>...HEAD` it embedded, and of any untracked file it
     embedded besides;
   - a refine-verify in full mode (C120 `verify.mode: full`, or no ledger):
     the paths of the applied patch its prompt carries;
   - a scoped critique or refine-verify (C120 `verify.mode: scoped`): the
     paths of its passages, a deleted passage's path included;
   - a plan-verify, or compose's `review`, of code or of an artifact in the
     tree: the paths of the diff or the written files it embedded (§
     Plan-verify of the ensemble protocol), never the whole commit manifest;
   - a plan-verify of a plan held outside the tree (the phase notes): the
     empty set, so it vouches for no code, even code already in the tree it
     saw;
   - an adversarial scan (`adversarial-scan`): the files its dispatch
     collected in scope.

   A path is covered at the content the result tree holds for it, so the
   subject must have shown that content: a path the subject showed at other
   content is in `shown` and left out of `covered`. A critique of the
   entire branch shows the committed `HEAD`, so a path that was also dirty
   in the checkout at capture is not in its `covered`; the pending change's
   staged and unstaged hunks together show the working content, so its
   paths are.

   `full` is not C120's own "full" (a full critique of a document, measured
   from the workflow's baseline): a critique of the pending change on a
   branch whose earlier commits touch a path outside the pending subject is
   not `full` here, however whole it is there; when every path the earlier
   commits touch is in the pending subject too, its `covered` can hold the
   whole manifest, and it is. A path in the subject that the change leaves untouched is covered
   too: the reviewer saw it at its base content, so a later edit to it is a
   different change. Coverage is per path, so a scoped review of some
   passages of a file covers that file. Which passages a scoped critique
   reviews, and what it may leave open, stay the scoped mode's own contract
   (ADR-0063, amendment of 2026-10-14).

A review records **no identity**, with the reason, and is then unbound
(what an unbound review may vouch for is Decision 3's): when no capture
exists (the peer ran with no snapshot or its capture failed, A1a's
`tree_reason`, or, with no peer, the checkout capture failed); when the
snapshot changed under the peer, or could not be captured again at its end
(item 4); when no
single integration base resolves (an unborn branch, no branch to land on,
several best merge bases); when the manifest holds a path that is not UTF-8 text,
which the record cannot keep as itself; or when the capture holds index entries
marked assume-unchanged or skip-worktree. The capture lists those entries (`capture` of the persona
plugins' `scripts/lib/peer-snapshot.mjs` returns them, `captureWorkingTree`
as `flagged`), but a peer snapshot's record on the run's handle keeps only
its trees, so A2b records the lists from the capture itself. The peer saw
the snapshot's materialized tree, so the refusal is not that its tree is
wrong: the review's local half and Phase 7's staging (`git add -A`) do not
see edits under those flags, so the identity would describe a tree that
neither the local reviewers nor the commit can be held to. A sparse
checkout marks every path outside its cone skip-worktree, so a review in
one never binds; that is a limit.

The identity applies to every review type and deliverable alike: a code
change as well as a document, on the command-managed and the Codex skill
paths.

The identity is of git objects: each blob is the content as git stores it,
after the checkout's clean filters and end-of-line conversion, whether an
attribute or `core.autocrlf` asks for it. Two working files that git stores
as one blob are one content: CRLF and LF under `text eol=lf`, and with no
attribute under `core.autocrlf=input`, captured as one tree (measured, P4,
through the real capture). The CRLF and LF difference the local harness
measured (W4, with no user configuration) is a difference only where no
such conversion applies.

### Decision 2 — which differences count as the same change

**The rule.** A committed or landed change is the same change as the one
reviewed when its per-path transition manifest is equal to the reviewed
one: every touched path goes from the same before-object to the same
after-object, with the same modes, rename detection off, and no path is
touched on one side only. The committed or landed manifest is computed with
the same command against that change's own base:

- **committed** (Phase 7): from the merge base of the commit and the branch
  to land on, to the tree after the workflow's last commit. The branch is
  resolved again at commit with Decision 1's precedence (item 3), and a
  review is compared only when the branch it recorded is that branch: a
  review whose recorded branch differs (an argument given at review and
  absent at commit, a macro that changed its integration branch) is not
  comparable, never compared from another base. Several commits of one
  workflow (the per-package split AGENTS.md requires) are one change; what
  a partial series may claim before its last commit is Decision 3's.
- **landed** (completion path): from the tree the landing started from (the
  first parent of a merge or squash commit, or the parent of the first
  commit of a rebased series) to the tree after it. For a rebase merge the
  series' start comes from evidence of the landing itself (the forge's
  record of the pull request's base and its landed commits), never from
  walking back from the last commit by the branch's commit count: a rebase
  can drop a commit already integrated, so the count reaches past the
  landing's start into `main` (measured, P5), and comparing the last commit
  alone misses the earlier packages (P5b). A landing whose
  interval cannot be identified from such evidence is not comparable.
  Today's landing resolver reads the terminal merge commit only
  (`plugins/orchestrator/scripts/landing.mjs`); A2b adds the start, and
  names the record it reads, with a fixture. The probes here saved a local
  commit as the start (P5, P5b) and read no forge; GitHub's list of a pull
  request's commits names the head branch's commits, not the commits the
  rebase landed, so it is not that evidence on its own.

**Files the review saw and the commit leaves out.** The reviewed result
tree holds every non-ignored file of the checkout, while Phase 7 commits
the changed paths of the workflow's commit manifest, and another changed
path only when it is opted in (`phase7-commit.mjs --include-extra`, or the
owner at the `staging-set` gate). A file outside it that was dirty or
untracked when the review captured, and stays uncommitted, is a path the
reviewed manifest touches and the committed one does not: the change reads
as different whenever the review's coverage includes that path, as `full`
coverage does, and a critique of the pending change, whose subject embeds
untracked files. That is intended. The
committed change lacks content the reviewer saw, which the reviewed code
may have used, and the rule does not guess which leftover files are
unrelated. The review binds when the file is committed with the change, or
when it is removed or set aside before the review; once it is removed
after, a later review whose `covered` holds the path at its absence (a
patch or pending change showing the removal) answers for it as any covering
review does, and with no such review a later `full` review of the same
workflow that no longer shows it answers for it in the earlier review's
place (§ A path a later whole review no longer shows, below). The
dropped paths are named in the comparison, so A2b can report them when it
refuses.

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

(Amended 2026-11-09 by the owner's instruction, Decision 3 § Whose reviews and
§ After the merge: the composition reads the committing workflow's reviews
alone, an interval holding another workflow's commit, or a commit naming none,
is not comparable, and the landed comparison reads no review, comparing the
landed manifest with the committed comparison's. The rest of this section, to
§ The same change, records the member rule as it was accepted; it is no longer
applied.)

**The reviews it reads.** The composition reads the reviews of the
workflows that make up the compared change, its *members*, and of no other
workflow:

- the workflow whose change is compared (at a commit, the committing
  workflow; at a landing, the child workflow of the subtask it completes);
- every workflow, of any persona, active or archived, that made a commit
  in the change's interval, named by the `Workflow-ID` trailer Phase 7
  writes as the last line of each commit message it makes
  (`phase7-commit.mjs`, `composeBody`).

The committed comparison takes its members from the commits between its
base and the workflow's last commit, and records them with its result,
keyed by that commit. The landed comparison reads the committed comparison
recorded for the head of what landed, the last branch commit the landing
took in (the pull request's head commit, named by the same landing evidence
as the interval's start), whichever workflow made it, found through that
commit's own `Workflow-ID` trailer (the branch's commits keep their
messages even when the landing rewrites them), or by the record keyed by
its sha when the commit object is gone with a deleted branch. It takes that record's
members, and adds any workflow a landed commit still names: a squash merge
writes one commit whose message is the pull request's, so the trailers can
be gone from `main` (measured, P8: none of the last 200 commits of this
repository's `main` carries one). Its members hold every workflow with a
commit in the interval, since that commit's interval runs from the same
base through every earlier commit of the branch: a workflow that committed
after the subtask's child closed (a fix after the pull request's review)
made the head, and the child is a member through its own commits. A landing
whose head commit names no workflow, or whose workflow recorded no
committed comparison for that commit (a commit made after the last Phase 7
commit, by hand or by a tool that writes no trailer), is not comparable.

Every member's reviews answer under the whole rule, the paths only they
touched included (the files a commit leaves out, above), whatever base each
recorded: a rebase, even onto a sibling commit with an identical tree,
keeps the reviews of the change it moved. A review whose identity is not
comparable (items 1 and 2 of Decision 1) is not read. So a second workflow
on a branch an earlier workflow committed to binds only under both
workflows' obligations: the earlier workflow is a member through its
commits, its reviews answer for its paths, a path it reviewed and left out
of its commit included, and moving work to another workflow erases no
reviewed path. A workflow whose change already landed is no member of a
later change on a branch name used again: its commits are in the later
change's base (a merge landing, or a rebase that fast-forwarded the
branch's own commits), or are no ancestors of the later change at all (a
squash landing, or a rebase that rewrote them, with the branch cut again
from `main`), never in the interval; the same holds for work abandoned
before it made a commit. A branch kept after a squash or rewriting rebase
landing, not cut again, still holds the landed workflow's original commits
in its interval, so that workflow stays a member: its paths, already in
`main`, are untouched by the landed change while its reviews touched them,
and the landing is not vouched for (a limit that fails closed).

A commit with no trailer (made by hand, or reworded or squashed locally so
that the trailer is gone) names no member. Its paths must still be covered
by a member's review or they fail, but this limit does not fail closed: the
workflow it belonged to drops out of the pool with its obligations, so a
path that workflow reviewed and left out of its commit is no longer
compared. Reproduced by the refine-verify peer: W1 reviews `app.cjs` and an
untracked `helper.cjs`, commits only `app.cjs` by hand without the trailer;
W2 reviews `app.cjs` and `readme.md` and commits `readme.md`; only W2 is a
member, its entries match, and the change is vouched for while a clean
checkout fails to load the helper. Membership is only as complete as the
trailers in the interval; a hand commit made for a workflow carries its
trailer (as Phase 7's recovery path expects), and what an interval with a
commit naming no workflow may claim is Decision 3's.

A review missing from the pool does not leave its paths to fail: a path
only it touched (a reviewed-only path the commit left out) is touched by no
review that is read and by neither manifest, so the composition never sees
it, and the obligation is gone. Reproduced by the critique peer: R1 covers
`app.cjs` and an untracked `helper.cjs` it requires, later reviews cover
only `app.cjs`, A1a's compaction drops R1, and both comparisons vouch for a
change whose clean checkout fails to load the helper; with R1 kept the
change is refused. So an incomplete history makes the change not
comparable, failing closed: a member workflow that cannot be read (its file
deleted, its `Workflow-ID` naming no workflow in the state root, active or
archived), and a member whose review record its reader calls incomplete
(`coverage.history_incomplete` of A1a's `projectReviewOutcomes` in the
persona plugins' `scripts/lib/review-attempts.mjs`: among its reasons, the
attempts dropped at the size cap, `truncation`, reviews that predate the
document, `pre-instrumentation`, results rows pruned unseen, and a document
it cannot read). How records from before A1a are read is A2b's. The
manifests Decision 1 adds to each attempt make the size cap easier to
reach, so A2b keeps a long manifest beside the workflow (item 5) and sizes
the record so that an ordinary workflow's history stays whole. Which of the
reviews read count (their outcome, whether superseded) is Decision 3's.

**The same change** — these differences do not count:

- commit metadata: message, author, committer, dates, parents, signatures
  (the identity is unchanged; a message rewritten so that a `Workflow-ID`
  trailer is gone changes which reviews the comparison reads, § The
  reviews it reads; since 2026-11-09 such a commit makes the change
  `not-comparable`, Decision 3 § Whose reviews);
- how the change is committed or landed: one commit or several, amend,
  squash merge, rebase merge, merge commit;
- the reviewed working-tree capture against the commit that records the
  same bytes;
- a base that moved only on paths the change does not touch: a rebase or
  squash onto a newer `main` that changed other files stays the same change;
- a rebase onto another commit whose tree is identical.

**A different change** — any of these counts:

- any byte of a touched path's after-content as git stores it: meaningful
  or trailing whitespace, indentation, tabs against spaces, CRLF against LF
  (where no end-of-line conversion makes them one blob), a binary byte;
- a mode (`100644` against `100755`) or a type (file, symlink, submodule);
- a path renamed to another name, added to the change or dropped from it;
- a submodule pinned to another commit (its gitlink object id);
- the before-content of a touched path: the integration base changed a file
  the change also touches, anywhere in it, even outside the change's hunks,
  or the landing reverts the base's edit to such a file.

**Not compared.** The content of base paths the change does not touch:
their cross-file effects on the change (a moved base that breaks a reviewed
call) are left to the landing's CI on the merged tree. A submodule's
content beyond its gitlink (dirty nested files, a deinitialized
submodule). Untracked ignored files, which neither the snapshot nor a commit
holds (a tracked file that matches `.gitignore` stays tracked, and is
captured and compared). The paths the snapshot removes (the state homes),
dropped from every manifest by the one projection of Decision 1.

**Base and result trees are kept.** The record holds `base` and
`result_tree` beside the manifest, so a reader can name "the same change on
a moved base" (equal manifest, another base tree) apart from "the unchanged
change" (equal base and result trees), and a later decision can tighten the
rule to equal endpoint trees without a new record.

### Decision 3 — enforcement and the owner's override (slice 2, Proposed)

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

**The comparison has four results**, for a commit and for a landing alike:
`same`; `different`, with the paths; `not-comparable`, with the reason; and
`no-reviews`, when the workflow holds no review that counts.

**Which reviews count.** A review answers for a path only when it ran and its
answer was usable: its outcome is `passed`, `concerns` or `conflict`. A skip of
any reason, an unavailable peer and a failed, degraded or malformed run answer for
nothing. That holds for a review with a `checkout` identity too (Decision 1, item
4): its identity is on record, and a skip's reason is the worker's claim, which
settle never checks, so a worker could otherwise launder an edit by claiming a
local-only skip. A workflow whose reviews never ran reads `no-reviews`, and the
outcome gate alone speaks for it, as A1b reads it.

**Whose reviews.** The committing workflow's, and no other's. An interval (the
commits from the merge base to HEAD) holding a commit whose `Workflow-ID` trailer
names another workflow, or that names none, is `not-comparable`
(`commit-of-other-workflow:<sha>:<id>`, `commit-without-workflow:<sha>`), whatever
the reviews say. The one exception is a merge whose other parents all lie in the
base (the branch to land on merged into the branch: GitHub's "Update branch", or
the merge this repository allows): it brings in only history the interval starts
from, and is left out; what its resolution changed is in the manifest, and a
review must answer for it.

**No base, and no review of its own.** A workflow with no review reads
`no-reviews` even when no base resolves, unless a commit no remote holds names
another workflow: with no interval, it can be neither read nor ruled out, so the
change is `not-comparable`. In a repository with no `origin` that is the branch's
whole history, which fails closed.

**The order of reviews** is their position in the workflow's own ledger
(`review_attempts`, appended under the state lock as each attempt registers, or is
recorded closed when it never launched), never a time. A review's `captured_at`
(Decision 1, item 4) is recorded and orders nothing.

**The record** is bounded by the paths, not by the number of reviews. When a
review's outcome is recorded, settle applies what it saw to the workflow's
`review_bindings` (Decision 4):

- a counting review writes, for each path it covered, the entry it saw there (none
  for a path it saw untouched): the record keeps, per path, the entry the latest
  counting review that covered it saw;
- a `full` one (Decision 1, item 6) also answers as untouched for a path an
  earlier review saw touched and its own subject did not show at all (Decision 2
  § A path a later whole review no longer shows);
- a counting review settled after any counting review listed later than it was
  applied, whichever paths each covered, is not applied, and is unbound
  (`settled-out-of-order`): its answers can no longer be placed;
- a review that does not count writes what it saw on the paths it covered to a
  second table, where a later-listed one has not, for the outcome gate's
  narrowing (below);
- a record that cannot fit its cap keeps only its committed comparisons and says
  it is truncated: the workflow's change is then `not-comparable`
  (`bindings-truncated`), for good.

A change is `same` when every path it touches, and every path the record answers
touched, has from the record the change's entry (a path untouched on both sides is
equal); a path the record does not answer is uncovered, and either failure is
`different`. A path answered by a review that cannot answer for this change (one
whose identity reads unbound now, below) is `not-comparable`
(`answer-unusable:<path>:<id>:<why>`).

**Which reviews may vouch.** A review with no identity (a record before this
release, a peer that changed its snapshot, several merge bases, a flagged index
entry, one settled out of order) is *unbound*, and an identity of another version,
another object format or another branch to land on reads the same, as does a
review whose dispatch recorded no subject: what it showed is not known, where an
empty subject is a record that it showed nothing (a plan held outside the tree).
An unbound review vouches for no path. It also holds obligations nobody can read,
so a change with one is `not-comparable` (`unbound-review:<id>:<why>`), unless a
later `full` review of the workflow, by ledger position, saw the whole change after
it. A review history its reader calls incomplete (`coverage.history_incomplete` of
A1a's `projectReviewOutcomes`: attempts dropped at the size cap, reviews that
predate the document, results rows pruned unseen, a document it cannot read) is
`not-comparable` (`history-incomplete:<reasons>`), and so is a `review_bindings`
document of a later version or one that cannot be read.

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

**At Phase 7**, on every path that lands a commit (execute, autopilot, the
recovery of a commit begun); a close lands nothing:

| | autopilot | interactive |
|---|---|---|
| `same`, `no-reviews` | commits | commits |
| `different` | refused, exit 10 `review-held` | refused, exit 10 `review-binding-mismatch`, re-routed to `/<persona>:critique` |
| `not-comparable` | refused, as `different` | warns and commits: it proves nothing either way (but `repository-mismatch` is refused, added 2026-11-08) |

The plan names the comparison (`review_binding`) before the user decides. A1b's
interactive warning stays a warning for an outcome; a change shown to differ is
refused, since the user otherwise commits what the review did not see with its
verdict still on record.

**Under autopilot no look compares.** The comparison is Phase 7's alone: the
driver's looks never run it, so the main checkout's look neither runs anything in a
lane's worktree nor touches a lane's index. Each look reads the review record as
it is: the outcome gate as A1b reads it, unnarrowed, and the committed comparison
Phase 7 recorded. A refusal at Phase 7 ends its step (nothing written), the step's
report needs the owner, and the lane halts `owner-choice` with that report,
which carries the refusal and its two ways on. The owner's acceptance of the
change is part of the lane's fingerprint once given, so it picks the parked lane
up.

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

**The owner's override.** `state.mjs review-binding-accept` records the owner's
acceptance of a change its reviews do not vouch for: the change's digest, the
state it compared, the owner's note. It covers that change and that state only:
an edit moves the digest and makes it stale. It is refused under an autopilot run,
like every owner write, and when the change compares `same` or `no-reviews`. It is
a scalar of its own, so A1b's acceptance of an attempt keeps its meaning.

**After the merge.** What landed is a fact, so nothing here undoes it. The landed
comparison reads no review: it compares the manifest of what landed (Decision 2,
from the landing's start, with no ref) with the manifest of the committed
comparison the subtask's child workflow recorded for the head of what landed.

- Equal: the landing is the change committed, and reads what the commit read,
  `same` or `no-reviews`. A commit Phase 7 recorded `different` (a pre-commit hook
  rewrote it after admission) lands `different`, unless the owner accepted that
  change before its commit (the record says so, `accepted`); then, like a commit
  that compared `not-comparable`, it lands `not-comparable`
  (`committed-<state>:<reason>`).
- Unequal: `different`, with the paths whose entries differ when the committed
  trees can still be read. `/orchestrator:done` does not record the subtask, and
  the autopilot policy halts `owner-choice`, until the owner says what follows
  with `--accept-landed-change` and a reason, which the macro records. The write
  refuses it under an autopilot run, as it refuses every owner write.
- No evidence of the start, no head, no child workflow, a child that cannot be
  found as one file (`workflow-<not-found|ambiguous|unreadable>:<id>`), or no
  committed comparison recorded for the head (a commit made on the branch after
  Phase 7: a review-comment fixup, a suggestion accepted on the forge, a
  force-push): `not-comparable`, and the subtask is recorded with a line in the
  macro saying why. Refusing it would strand a landing that may be right.
- Before the merge, the landing report shows the committed comparison as
  provisional, and never blocks: `landing-ready` stays advisory, and only the
  completion path reads what landed.

**The landing's evidence.** The interval's start comes from GitHub's record of
which pull request introduced each commit
(`GET /repos/{owner}/{repo}/commits/{sha}/pulls`), walked back along first
parents from the merge commit: the first commit it does not attribute to the
pull request is where the landing started. So a squash and a rebase read alike,
and a rebase that dropped a commit walks no further than it landed. A merge
commit needs no forge: its first parent is the start, its second the head. The
head is the pull request's `headRefOid`. A start that is not an ancestor of the
landing is refused. Anything less is `not-comparable`
(`no-landing-evidence:<why>`), which is where a landing on a non-default branch
ends, since the endpoint names only open pull requests there. **Not measured:**
the step that wrote this may not call `gh`, so this rests on GitHub's
documentation and a fixture standing for its answer. A first real landing should
check it: an answer that does not match reads `not-comparable`, never `same`.

### Decision 4 — records written before this release, and a rollback (slice 2, Proposed)

**Records stay apart.** What ties a review to a change lives in its own
frontmatter scalar, `review_bindings`, beside `review_attempts` and not in it.
`reviewAttemptsProblem` refuses an unknown field, so an identity inside an
attempt would make every older reader call the whole record unreadable, which
reads `unknown` and holds every commit, and refuses every later write. Apart, the
attempts document is byte for byte what A1a defined. `review_bindings` holds, per
attempt, its identity without the manifest list (the list's digest instead) and
whether its subject was full, partial or absent; the per-path tables of Decision 3;
the committed comparisons, keyed by commit; and the truncation mark.

**A record before this release** holds attempts and no `review_bindings`. Each of
its counting attempts is unbound (`no-identity-recorded`), never matching, so a
workflow in flight at the upgrade reads `not-comparable`: under autopilot it
halts for a new review or the owner's acceptance, and interactively it warns. A
legacy results row or an incomplete history reads `not-comparable` as Decision 3
says. No migration infers an identity: nothing says what such a review saw.

**A rollback to an older reader.** An older persona carries both new scalars
through its forward-compat carrier, byte for byte, and reads its outcomes under
A1b's conservative gate, so it binds nothing and refuses nothing it would not
have refused before. Reviews it records have no binding, so after a return to
this release they read unbound, never matching, and a comparison it did not
record is absent, which a landing reads as `not-comparable`. An older orchestrator
ignores `landed_review` and records the landing as it did. A newer engineer behind
an older orchestrator is held by Phase 7 alone, as any orchestrator now is: the
policy reports the refusal as the step's need of the owner. A document of a later
version is not read: its workflow's change is `not-comparable`.

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

## Consequences

**Positive**

- A review is about a definite change, and an edit after it, of any byte,
  mode, path or pin, is a different change: the C163 defect is closed once
  A2b compares the identity on every commit and completion path.
- The identity is git's content-addressed plumbing, independent of diff
  presentation (renderer, configuration, rename heuristics) and of commit
  history, so a squash or rebase merge keeps the review it had.
- A rebase onto a `main` that moved other files keeps the review. In this
  repository that is expected to be common, though no sample was counted:
  a macro's lanes are cut from one `main` and land one after another, each
  onto a `main` the earlier ones moved, and release commits land between.
  Endpoint-tree equality would demand a new critique for each such landing.
- A scoped re-critique composes with the full critique it follows, path by
  path, so the C120 scoped mode (documents today) needs no new full critique
  to stay bound after a refine.

**Negative**

- Cross-file effects of a moved base are not reviewed: a base change in a
  file the change does not touch can still break the reviewed change. The
  landing's CI on the merged tree is the only check, and a defect of that
  kind that CI misses lands under the review. The recorded endpoint trees
  let a later decision tighten this.
- Path-level coverage is coarser than what a reviewer read: a scoped
  review of one passage, or a review given only some hunks of a file (a
  critique of the pending change of a file an earlier commit of the branch
  also changed), vouches for the file's whole transition from the base at
  the reviewed content.
- The record keeps, per path, the latest counting review's entry and the
  latest failing review's (each about 270 bytes for a path of 60 characters,
  measured), and per review only a small record without its manifest, so it grows
  with the paths reviewed, not with a manifest per review: some 490 such paths fit
  its 128 KiB, or some 240 when failing reviews saw them all too. A larger change is
  not comparable for good (`bindings-truncated`), and needs the owner's acceptance.
- A file left dirty or untracked in the checkout during a review whose
  coverage includes it (a `full` review, or a critique of the pending
  change, which embeds untracked files), and not committed with the
  change, keeps that review from binding until it is committed, or removed
  and then covered at its absence by a later review, or left out of a later
  `full` review of the same workflow. A file removed after its review that
  no later subject shows removed, in a workflow that runs no later `full`
  review, keeps the change from binding.
- Coverage is only as exact as each dispatch's record of its subject (its
  `shown` and `covered`): a verb that records no subject leaves its reviews
  covering nothing, and every verb that dispatches a review records one
  (A2b). A landing whose head has no committed comparison, recorded by the
  subtask's child for that sha, is not comparable; so an amend or local rebase
  of the branch head after its last committed comparison needs that comparison
  recorded again (Phase 7's recovery path for an existing commit,
  `phase7-commit.mjs`), even when its manifest is unchanged. A rewrite the forge
  makes at landing does not, since the landing evidence names the original head.
  The record is keyed by the sha, so a head whose commit object is gone with its
  deleted branch is still found.
- A workflow whose review record is incomplete (attempts dropped at A1a's size
  cap, reviews from before A1a, a document that cannot be read) is not
  comparable; that fails closed.
- A review whose peer changed its snapshot, or whose snapshot could not be
  captured again at the end, records no identity, so a peer that edits the
  tree it reviews leaves its review unbound; a change it made and undid
  before ending is not seen.
- The interval is read through the `Workflow-ID` trailer (amended
  2026-11-09): a commit of another workflow, or of none (made by hand, or
  reworded or squashed locally), makes the change not comparable. So a second
  workflow on a branch an earlier one committed to never binds before the
  earlier commits land (autopilot halts, interactive warns), and neither does a
  branch kept after a squash or rewriting rebase landing without being cut
  again. A hand commit made for a workflow carries its trailer, as Phase 7's
  recovery path expects.
- A review in a sparse checkout, or with any assume-unchanged entry, never
  binds.
- The committed comparison rests on the branch ref: the same stale ref at
  review and at commit can call a change the same that the landing
  compares as different. The landed comparison decides.
- Submodule content beyond the gitlink is outside the identity: a dirty or
  uninitialized submodule is not seen.
- (Slice 2) A subject is the dispatching worker's statement of what it put in the
  prompt, and nothing checks the prompt against it: a worker that overstates
  `covered` vouches for what the reviewer did not see. Deriving it from the prompt
  would be a parser of free text; the record at least makes the claim specific and
  auditable.
- (Slice 2) A rebase or an amend of the branch head after its last Phase 7 commit
  leaves no comparison for the new head, so its landing reads `not-comparable`
  until `review-binding-record` runs. It is recorded, not refused, and it is routine
  in this repository, where a landing often follows a rewrite of a subject or a
  rebase onto a sibling's landing.
- (Slice 2) A pre-commit hook that rewrites the change is not seen at admission; the
  comparison recorded after the commit then reads `different`, Phase 7 warns, and the
  landing decides. An edit made while Phase 7 commits, between its admission and its
  `git add`, is the same case (added 2026-11-08): the admission holds no lock over
  the working tree. So are two rarer arrangements the refine-verify of 2026-11-08
  measured (F1, F2): a path pre-staged under a clean filter whose output has changed
  since (the projection re-reads every file through the filter, `git add` keeps an
  entry whose stat data still matches), and a split series that stages the deletion
  of a `.gitattributes` an earlier package's files depend on (Phase 7 commits that
  package with the attribute still in the index). Phase 7 then records `different`
  after the commit, and the landing decides.
- (Slice 2) A landing resolved in the moment its workflow is being archived can read
  the active file and its new archive at once, which differ, and so reads
  `workflow-ambiguous`, not comparable, where a moment later it reads what the
  archive holds (refine-verify of 2026-11-08, F6). The landing's not comparable
  goes on, with the reason recorded, so a difference can be missed in that window;
  a workflow is archived at its commit step's end, long before its pull request
  lands, so the window is not one an ordinary run meets. Likewise a copy replaced
  between the lookup's identity check and its read can be taken for the copy it
  replaced, read once where it is now two (measured with a controlled
  interleaving, refine-verify of 2026-11-08, third pass); the next lookup reads
  it.
- (Slice 2) The first review after the upgrade is what binds, so a workflow in flight
  needs one new review, or the owner's acceptance.
- (Slice 2) The landing's child workflow is looked up in the caller's state read
  set. With shared creation off, a linked worktree keeps its workflows in its own
  state root, so a landing resolved from the main checkout does not find a
  workflow that lives only in a linked one: it reads `not-comparable`
  (`workflow-not-found`) and `done` records it with a line, where the linked
  checkout would read `different`. It does not claim `same`. This is a special
  arrangement (shared creation is the default here), left as a limit by the
  owner's rule for rare cases; complete the subtask from the checkout that holds
  the workflow (critique of 2026-11-07, MAJOR 6).
- (Slice 2, 2026-11-09) The simplification halts where `same` was provable, by
  the owner's choice (Decision 3, its opening note): a counting review settled
  after one listed later than it is unbound until a later full review; two
  reviews of one workflow that overlap are ordered by registration, not by when
  each read the tree; an answer from a review measured from another branch to
  land on keeps the change not comparable once a later full review shows that
  path without covering it.
- (Slice 2, 2026-11-09) Under autopilot no look compares, so a change its
  reviews do not vouch for spends one commit step before Phase 7 refuses it, and
  the look reads the outcome gate unnarrowed: a failure of another change holds
  the lane where Phase 7 would pass over it, until the owner accepts it or a new
  review runs. The narrowing reads only the latest failing review of each path,
  so an earlier failure whose paths a later one covered stays read.
- (Slice 2, 2026-11-09) A landing whose head has no committed comparison (a
  review-comment fixup after Phase 7) is not comparable and recorded with its
  line, even when the fixup edited a reviewed path: the macro's line is the only
  sign. Review such a fixup before the landing, or record its comparison with
  `review-binding-record` after a review.
- (Slice 2, known limits of the critique of 2026-11-09, left as limits by the
  owner's convergence rule of that date; each is rare, fails closed, or costs only
  a false halt or a message):
  - Past its byte cap the record keeps every committed comparison (up to 32)
    without bounding their failure lists by bytes, so very long failure lists can
    still outgrow what the frontmatter readers allow (reproduced synthetically:
    334,189 bytes against 131,072). Bounding the comparison details by bytes too
    would close it.
  - The outcome gate narrows on `different` too, so once the owner gives
    `review-binding-accept`, a failed review of an in-between tree no longer holds
    and is not shown (reproduced: R1 passed, R2 failed, a third edit committed).
  - `--landing-branch` is not refused under autopilot: a worker passing its own
    pushed branch narrows the interval Phase 7 checks (inferred; no runbook passes
    the flag, and the landing comparison still reads `different`).
  - Two causes leave a change unbound until a later full review (one whose
    subject lists every path of its manifest): a review settled out of order, and
    a peer that writes an untracked file into its snapshot. Neither ever passes:
    the change reads `not-comparable`, which halts under autopilot and warns
    interactively.
  - The agent lists a review's subject paths by hand: an untracked file it misses
    reads `uncovered`, then `different`, and the commit goes back to critique or
    the lane halts, naming the path (a false halt).
  - The engineer and `gh` timeouts inside the landing comparison can add up past
    the main look's 120-second `resolve-landing` budget on a slow network, turning
    a `not-comparable` into a landing error that halts the lane.

**Neutral**

- `review-scope.mjs`'s ledger trees, A1a's attempt trees and the
  verification digest keep their own purposes; none is reused as the
  identity, and the verification digest keeps HEAD.
- A review with no identity is unbound; how unbound and legacy reviews are
  read, the enforcement, and the owner's override are Decisions 3 and 4.

## Alternatives Considered

- **`git patch-id --stable` against the base.** Rejected by measurement:
  14 of 19; whitespace normalization makes meaningful indentation, tabs,
  CRLF and reformatting collide (W1, W3 to W5, and the peer's indentation
  case), it misses a base edit outside the hunks (I2), and it changes with
  diff configuration and with rename rendering.
- **`git patch-id --verbatim`.** 18 of 19: it misses a base edit to a
  touched file outside the hunks (I2), and it changes with
  `diff.noprefix`, `color.diff` and `diff.context`.
- **The result tree alone.** 16 of 19: a rebase or squash onto a newer
  `main` reads as a different change (I1, I3), and the same result from a
  different before-image reads as the same (I4, and the peer's case).
- **The verification digest (tree and HEAD).** It includes HEAD, so every
  commit around the same tree reads as a different change: committing the
  reviewed bytes, rewording a message, a rebase, a squash (the peer's D).
  The local model with the base commit in place of HEAD still fails I1 and
  I3 (17 of 19).
- **A digest of `git diff --binary`.** 19 of 19 on content, but it changes
  with `diff.noprefix` and `color.diff`, so two machines, or one machine
  after a configuration change, disagree about one change.
- **The post-image set** (each touched path's after-content only). 18 of
  19: a landing that silently reverts the base's edit to a touched file
  reads as the same change (I4).
- **The snapshot's content projection.** It misses a changed before-image
  and erases a submodule pin (peer harness).
- **Equal base and result trees** (the peer's position). It never claims a
  reviewed change on a base it did not see, but it would force a new
  critique whenever `main` moved between critique and landing, which this
  repository's lanes make common (not counted; § Consequences). The owner chose the per-path rule and kept
  both trees in the record, so this rule stays available to a later
  decision without a new record.
- **Rename detection on.** Its result depends on a similarity threshold and
  configuration, and the peer measured different patch-ids for the same
  endpoints under two rename settings; a rename is a delete and an add.

Built and removed by the owner's instruction of 2026-11-09 (Decision 3), each
for `not-comparable` with a named reason; the cost of each removal is a halt where
`same` was provable:

- **The reviews of every workflow with a commit in the interval** (members named
  by `Workflow-ID` trailers, found in every state home, recorded at commit for the
  landing). A trailer missing from one commit dropped its workflow's obligations
  silently. (The rules for a workflow file found twice stay: the landing's lookup
  of its one child workflow uses them.) Cost: a
  second workflow on a branch does not bind until the first one's commits land.
- **Ordering by capture time**, the snapshot's read of the working tree, with the
  captures of one checkout serialized by a lock file so that the times ordered the
  reads. Two overlapping captures could not be ordered by any one instant, and the
  lock had stale-lock and timeout cases of its own. Cost: reviews settled out of
  their ledger order are unbound until a later full review.
- **Each review's manifest, compacted at the cap, with the obligations of the
  dropped records tracked** (a dropped review lifted by a later full review, and a
  path it could have answered not comparable unless a review covered it strictly
  after). Its rule took five critiques to state. Cost: a change past the per-path
  record's cap is not comparable for good.
- **A landing with no committed comparison for its head recovered from the nearest
  recorded ancestor's members, and the known reviews asked whether a path they
  answer for differs** (a partial `different`). A path no known review covered
  could be another workflow's. Cost: such a landing reads not comparable, and is
  recorded with its line.
- **The autopilot look comparing each child, in the lane's worktree for a lane,
  through a copy of its index.** It ran beside the lane's worker, whose `git add`
  then failed on the index lock, and needed the lane's identity checked before and
  after. Cost: a refused change spends one commit step, and a failure of another
  change holds a lane Phase 7 would let.
