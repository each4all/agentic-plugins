# ADR-0067 history: Worktree lanes for the autopilot driver, and proposals for worktrees, lanes and consensus

This file is the record: the applied amendment cascade, amendments and
superseded text of [ADR-0067](../0067-autopilot-worktree-lanes-and-proposals.md), each as it was written. The ADR states
the current decision (ADR-0070). Records written as dated text inside the
ADR's decisions are gathered here under the date and subject they carried,
each passage under the place it stood. Links to other ADRs inside the
passages point from this directory; their text is as written.

The accepting commit (2026-10-08, #903) applied the amendment cascade below
to ADR-0063, ADR-0029, ADR-0019 and the index, as written, with
`<acceptance date>` filled in. The record is the section as it stood in the
ADR, the note of 2026-10-20 on block 7c included. Its quoted match strings
and its blocks are text to find or paste in the ADRs it amends, so their links
are as written and point from `docs/adr/`, not from this directory.

## Amendment cascade (apply verbatim on acceptance)

Each block names the exact text it replaces. `<acceptance date>` is the
date of the accepting commit (YYYY-MM-DD), the only value that commit fills
in.

**1. ADR-0063 — Status block: replace the Proposed notice (the bullet that
begins "[ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) (Proposed,"
and ends "Nothing here changes until it is accepted.") with:**

```markdown
- Amended by [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
  (<acceptance date>): R2's halt wording; D1's worktree-lanes clause; D3's
  `/orchestrator:next` row and D4's proceed rules 1, 2, 4 and 5, per lane;
  D4's gate enum, its `version-drift` and `budget` halt rows and its Lanes
  paragraph; D5's Spawn paragraph and Env; D8's ledger location, run
  directory list and Lock bullet.
```

**2. ADR-0063 R2 — replace the row with:**

```markdown
| R2 | At a genuine judgment point the run **halts**, and reports it: terminal + `halt.json` + exit code 2. Nothing starts after the halt. With parallel lanes ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6) the halt **drains**: no new lane or step starts, steps already running finish and are recorded, then every lane reports once. A subtask that waits for its PR to land is not a judgment point (D3a). |
```

**3. ADR-0063 D1 — replace the "Worktree lanes" bullet and its sub-bullets
(from "- **Worktree lanes (W1;" through "amends this clause then.") with:**

```markdown
- **Worktree lanes ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)).**
  S1 also covers, for the macro being driven and only for lanes the driver
  created (proven by the lock reason, or for an unlocked lane by an open
  removal intent that names its lane id, ADR-0067 Decision 5):
  - `git fetch --no-tags --refmap= origin +refs/heads/<baseline>:refs/remotes/origin/<baseline>`
    at the start of a run with lanes and before it creates a lane, which
    writes only that remote-tracking ref (and `FETCH_HEAD`);
  - `git worktree add --lock --reason "agentic-autopilot <macro-id> <subtask-id>"`
    under `<parent>/<repo>-lanes/<macro-id>/`. When the subtask branch is
    absent it creates it with `--no-track -b <branch>` from
    `refs/remotes/origin/<baseline>`, as `/orchestrator:next` would: the one
    branch S1 creates;
  - `git worktree lock`, `unlock` and `remove` (never `--force`) for those
    lanes.

  The lane operations above never touch a worktree the driver did not
  create. For lanes S1 grants no `git worktree prune` (prune has no path
  selector, so the owner prunes), no push, no merge, and no ref write but
  the lane fetch's (its remote-tracking ref and `FETCH_HEAD`) and a new
  lane's branch. D3a's landing fetch is unchanged. The runtime executor
  guard still forbids the operations above for runtime; the orchestrator
  adapter performs them. There is no local integration branch (ADR-0067
  L1). Interactive lane sessions (`claude --bg`) are left to a later ADR.

  In every run, serial or with lanes, S1 also covers the read-only overlap
  check `git merge-tree --write-tree` (ADR-0067 Decision 7), which writes no
  ref.
```

**3a. ADR-0063 D3 — in the `/orchestrator:next` row, replace "macro approved,
a subtask is ready, no active engineer child" with:**

```markdown
macro approved, a subtask is ready, no active engineer child (with lanes, [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6: none on that subtask, which gets its own lane)
```

**3b. ADR-0063 D4 — in the list under "**Proceed** only when **all** of the
following hold:", replace rules 1 and 2 with the first block below and rules
4 and 5 with the second. Rules 3 and 6 stay as they are.**

```markdown
1. The observer yields exactly one command from the D3 step table: one in a
   serial run, and one per lane with lanes
   ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6).
   It comes from an entry-brief `disposition=lead` with an allowlisted
   command, or from engineer `next_step`, or from next-ready.
2. No `awaiting_owner` is set on the macro or on the active engineer
   workflow (with lanes, on the lane's).
```

```markdown
4. For `/orchestrator:next` only: the working tree it runs in is clean (with
   lanes, the lane's).
5. The state fingerprint changed since the previous step: with lanes, a
   lane's fingerprint since that lane's previous step, while `/orchestrator:done`
   and `/orchestrator:finalize` keep the macro-wide one. The first iteration
   is exempt, and with lanes each lane's first step.
```

**4. ADR-0063 D4 — replace the gate enum paragraph, both of its sentences
(from "**`awaiting_owner.gate`** is a closed enum" through "mapped in DESIGN
§6.3."), with:**

```markdown
**`awaiting_owner.gate`** is a closed enum of genuine-judgment gates only:
`plan-approval`, `plan-conflict`, `scope-routing`, `decide-conflict`,
`peer-conflict` ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
Decision 8: a conflict verdict in critique or investigate),
`recurring-finding`, `staging-set`, `pr-handling`, `duplicate-workflow`. The
source of each gate is mapped in DESIGN §6.3.
```

**4a. ADR-0063 D4 — in the halt table, replace the `budget` row and the
`version-drift` row with these two rows, in the same places:**

```markdown
| `budget` | iteration, cost or time cap reached, or a rate-limit window that cannot reopen before the deadline ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 6) |
```

```markdown
| `version-drift` | installed plugin versions changed since the run started, or the content of a loaded plugin or a pinned script root did ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 8) |
```

**5. ADR-0063 D4 — replace the "Lanes (W2)" paragraph with:**

```markdown
**Lanes (W2).** Any lane halt drains the run: no new lane or step starts,
in-flight steps finish, then every lane reports once. SIGINT/SIGTERM aborts
without draining. Scheduling, the per-lane fingerprint, budgets and the
throttle: [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
Decision 6.
```

**6. ADR-0063 D5 — replace the Spawn paragraph's text before its code block
(from "**Spawn.** An argv array, never a shell string." through "is a
pipe:") with:**

```markdown
**Spawn.** An argv array, never a shell string. cwd is the checkout the step
runs in: in a serial run the driven worktree; with lanes, the subtask's lane
for dispatch, verbs and commit, and the driver's own checkout for done and
finalize
([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 5).
stdin is a pipe:
```

**6a. ADR-0063 D5 Env — insert after the plugin-roots bullet (the one ending
"`AGENTIC_RUNTIME_ROOT`."), before "- Scrubbed:":**

```markdown
- `AGENTIC_STATE_BASE=<the run's effective state root>` and
  `AGENTIC_AUTOPILOT_TOKEN=<the run's admission secret>`
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 2
  and 4). An inherited value of either is scrubbed first.
```

**7. ADR-0063 D8 — replace the first line, "Everything lives under
`<repo>/.agentic-plugins/runs/autopilot/<run-id>/`:", with:**

```markdown
A run's records live under `<repo>/.agentic-plugins/runs/autopilot/<run-id>/`
in the checkout it was launched in. The macro-scoped files live under the
main worktree's `.agentic-plugins/runs/autopilot/` instead: the lock, the
landing log, the lane removal intents and the open-run records
([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 5,
6 and 7). The run directory holds:
```

**7a. ADR-0063 D8 — insert after the `halt.json` bullet (the one that
begins "- `halt.json`: reason code"):**

```markdown
- `lanes.jsonl`: with lanes, one line per lane event — created, adopted,
  removed, kept, reconciled ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
  Decision 6).
```

**7c. ADR-0063 D8 — replace the Lock bullet (from "- **Lock.** One run per
macro:" through "The serial prototype keeps a per-repo `.lock`.") with:**

*Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md), slice 3,
accepted 2026-10-20):* the text below, applied on
acceptance, is ADR-0063 D8's Lock bullet, which now carries a dated note on
the heavy-work lock (ADR-0068 Decision 6); this block is left as applied.

```markdown
- **Lock.** One run per macro: `<main>/.agentic-plugins/runs/autopilot/locks/<macro-id>.lock`,
  with a pid + start-time fingerprint. A run also holds the worktree lock of
  every checkout it drives, `<checkout>/.agentic-plugins/runs/autopilot/worktree.lock`:
  its own, and with lanes each lane's. With lanes a run adds one entry per
  worker group in flight, so a driver that died with a lane worker alive
  still holds its locks. The interactive orchestrator commands join the
  macro lock as admission entries, live until released, and
  `/orchestrator:next` first joins the worktree lock of its checkout
  ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decisions 4
  and 6).
```

**8. ADR-0029 — Status block: replace the Proposed notice (the quote that
begins "> [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) (Proposed,"
and ends "Nothing here changes until it is accepted.") with:**

```markdown
> Amended <acceptance date> by [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
> — see the note at the end of §3.
```

**9. ADR-0029 §3 — appended after the ADR-0063 amendment block, with one
blank line between them so the two quotes stay apart:**

```markdown
> **Amendment ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)):**
> the six fields and the closed-enum projection are unchanged. On a synthesis
> verdict of `conflict` in decide, critique, investigate or orchestrator
> plan-verify, `selected_next` is the owner's decision after a bounded
> consensus round, `next_command` is `/runtime:consensus plan --task-file <the
> verb's contested-items file> --peers claude,codex --max-rounds 2`, and "the
> owner decides now" is a rejected alternative; the projection stays
> `owner-decision`, and critique and investigate record the `peer-conflict`
> gate. Orchestrator plan and approve completions may add one display-only
> line after the six fields, `lane_advice`, derived from the plan's
> dependency graph each time; it is never projected into `next_step` and
> never read by a machine.
```

**9a. ADR-0019 — Status block, after the "Codex layout re-decided" quote,
whose last line reads "> ADR-0061's S2 ships.", with one blank line between
them:**

```markdown
> **§3 amended by [ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md)
> (<acceptance date>).** A third immutable create-time linkage key,
> `parent_workflow_path`; see the amendment note in §3, after the paragraph
> on preserving the linkage fields.
```

**9b. ADR-0019 §3 — insert after the paragraph that begins "The fields are
then preserved verbatim" and whose last line reads "`/engineer:link-parent`
or similar.":**

```markdown
> **Amendment ([ADR-0067](0067-autopilot-worktree-lanes-and-proposals.md) Decision 3):**
> a child may also record `parent_workflow_path`, the absolute path of its
> macro file, immutable once set at create like the two keys above. It is
> optional (an older orchestrator exports no path). `create` requires it to
> name an existing orchestrator macro file whose `workflow_id` is
> `parent_workflow`, and refuses it otherwise. Afterwards it is a hint:
> writeback checks the same when the path names a file, refusing a file that
> fails, and takes the candidate search only when the path names no file
> (the macro moved at a cutover, or was archived). `/orchestrator:next`
> exports it as `AGENTIC_PARENT_WORKFLOW_PATH` beside the two §1 variables;
> the path alone is refused. Unlike the schema-1.1 rule below, an older engineer does not
> reject the key: schema 1.4 keeps an unknown key through its forward-compat
> carrier, provided the key is placed where the ADR-0063 S1 note requires.
```

**10. `docs/adr/README.md` — the index row's status column reads Accepted.**

## Amendment 2026-10-08 — the overlap check runs in a scratch repository

In Decision 7, after the overlap check's answers:

  Note, 2026-10-08 (the implementation's review): that holds only where no
  merge driver is configured. In the repository, merge-tree runs any driver
  the config defines and an attribute selects, which can write refs and the
  worktree, and it reads the checkout's attributes, so the answer depends on
  more than the two commits (measured on git 2.54). The check therefore runs
  in a scratch bare repository that borrows the objects and the shallow
  boundary and nothing else (`landing-ready.mjs` `scratchRepo`). Its answer
  is git's own merge of the two commits, and it writes nothing to the
  repository.

## Amendment 2026-10-13 — symlinked workflow entries (C122)

In Decision 4, item 1 (readers first), after the handoff slot bullet:

   > **Note (2026-10-13, docket C122):** the entry-brief readers take a
   > symlinked workflow entry as the file it names only when that file's
   > real path lies inside a home of the same persona in the read set,
   > judged by device and inode before the open and again after it, and
   > only when no home overlaps another persona's home or holds a state
   > directory; a link out of the state homes degrades the
   > source (`symlink-outside-state`), and a link to nothing is skipped as
   > the owners skip it. A file listed by two homes of one state root is
   > dual-home ambiguity, judged per state root before a file reached
   > through both roots counts once. The dashboard and doctor readers
   > (`state-readers.mjs`) still skip a symlinked entry. Contract:
   > `plugins/runtime/docs/session-capture-contract.md` §14.1.

## Amendment 2026-10-13 — the run clock, open-run records and peer cleanup (C105, C92, C127)

The Status section recorded it so:

- Amended 2026-10-13 by the owner's review decision C105 (recorded outside
  this repository): Decision 6's Budgets lose the elapsed time and the run
  deadline, and its Throttle waits for a reset however far off, halting only
  on a part with no reset time; the C105 follow-up under §Out of scope is
  closed by that removal. Each place keeps its text and carries a dated note.
- Amended 2026-10-13 by the owner's review decision C92 (recorded outside
  this repository): Decision 6's open-run record outlives a run whose step's
  peers are unaccounted for (a look that could not read or list them, a
  cancellation that did not go through), and the cleanup searches that step.
  Each place keeps its text and carries a dated note.

In Decision 6, Locks, the open-run record:

    - The run removes its record when it ends with every worker group
      empty: completed, halted, interrupted. *Amendment 2026-10-13 (C92):*
      unless a step's peers are unaccounted for: the look after the step
      could not read the macro, its readiness or the step's child, or after
      a failed step could not list its peers, or a peer's cancellation did
      not go through. The run then keeps its record however it ends, in a
      lane and in the serial run alike, and that step's `finished` line
      records `peers_unaccounted: true`.
    - `stop`, and every run at its start, list the records for this macro
      and judge each driver by its pid and fingerprint, as `holderAlive`
      judges a lock entry's. A dead driver's worker groups are empty by then:
      a starting run holds the macro lock, so none of them is live, and
      `stop` empties them first. For a dead one they read its ledger, where
      every `started` line without its `finished` line is an unfinished step
      (`ledger.mjs:9`, `:99`), do the cleanup above, and only then remove
      the record. *Amendment 2026-10-13 (C92):* a finished step whose line
      records `peers_unaccounted: true` is, like an unfinished step, one a
      pending peer that names no run may belong to (reported, never
      cancelled); the peers that name the run are cancelled as before, and
      that step's budget, already settled, is not counted again. Each part of the cleanup is idempotent (a step's
      reservation is settled once, by its `seq`; a cancelled peer run stays
      cancelled), so a `stop` and a starting run that meet the same record
      count nothing twice. A record whose ledger is gone (its checkout
      removed) is reported and kept; the owner deletes it once they have
      checked that run's peers.

In Decision 6, Peer cancellation:

- **Peer cancellation.** After a failed or aborted step, the driver cancels
  the runs that became pending during that step on that step's own
  subtask's engineer workflows, with their ledger in each workflow's own
  home (Decision 4, item 2).
  Today it cancels the runs that became pending during the step on any
  workflow of the macro (`driver.mjs:181-192`), which with lanes would reach
  another lane's peers.
  *Amendment 2026-10-13 (C127):* the same scope serves a step that passes
  after its host closed it on a finished report with background tasks
  pending: those runs are cancelled, then settled from their ledgers, in the
  lane's checkout and off the loop ([ADR-0063](../0063-autopilot-fresh-session-driver.md)
  D5, amendment of 2026-10-13).

In Decision 6, Budgets are reserved (the note of 2026-10-19 on the same item
is under that date):

  - A start blocked only by other steps' reservations waits for them to
    settle, then decides again. The budget is exhausted only when what is
    already *spent*, the steps already *taken* or the elapsed time leaves
    too little: a $25 run whose first step reserved $25 is not exhausted, and
    may continue once that step spends $1. *Amendment 2026-10-13 (C105):*
    the elapsed time no longer counts; what is spent and the steps taken
    decide.
  - Each worker's time is bounded by the run's deadline, as today.
    *Amendment 2026-10-13 (C105):* a run has no deadline. Each worker gets its
    whole per-step timeout, however late it starts and however long its lane
    took to prepare.

In Decision 6, Throttle:

  - **Throttled with nothing to refresh it**, that is no worker in flight
    and no started lane with a runnable step: wait until each part that
    throttles has expired, then decide again. When one has no reset time, or
    its reset falls after the run's deadline, halt `budget`, naming the
    rate-limit window. A started lane with a runnable step is not
    "nothing": it steps, and its worker brings new events.
    *Amendment 2026-10-13 (C105):* with no run deadline, a throttled new lane
    with nothing to refresh it waits for the latest reset however far off (a
    seven-day refusal, days away), slept in pieces no longer than a timer
    holds, each wake-up deciding again. Only a part with no reset time halts
    `budget`, since no wait would end. The owner ends a wait with `stop` or
    Ctrl-C.

In § Out of scope (follow-ups):

- Docket C105: a step-start guard based on recent step durations. Today the
  driver checks only `MIN_STEP_TIMEOUT_SEC` (`driver.mjs:50`).
  *Closed 2026-10-13 (C105):* the owner removed the run clock instead, and
  `MIN_STEP_TIMEOUT_SEC` with it, so no start is cut short.

## Amendment 2026-10-14 — landing readiness and its records (C128, C123)

In Decision 7, the deduplication bullet the note replaced:

- **Deduplication.** The key is (subtask id, engineer workflow id, captured
  sha). (Replaced by transitions in the note of 2026-10-14 below.)
  - A waiting subtask found unreported at run start is reported then.
  - A reported one is not repeated.
  - A new sha, such as a fix the owner pushed, is a new event.

In Decision 7, after Limits, the note with the amendments made to it the same
day:

Note, 2026-10-14 (dockets C128 and C123): readiness, and the records that
carry it.

- **Ready means up to date.** A branch is ready to land only when it contains
  `refs/remotes/origin/<baseline>` as the look fetched it, so the CI its push
  runs (`full-tests.yml`) checked the tree that lands, another lane's landing
  included. Each record carries `sync: {state, base_commit, detail, commands,
  note}` and `ready`:
  - `ready`: the look's fetch succeeded and
    `git merge-base --is-ancestor <tip> <commit>` exits 0;
  - `needs-sync`: it exits 1 in a full clone. `commands` fetch the tip into
    its ref by name (as below), merge `refs/remotes/origin/<baseline>` (the
    full name: a tag or local branch named `origin/<baseline>` would shadow
    the short one) and, when a pull
    request is open, push, with `git -C <worktree>` for the worktree that has
    the branch, or a `git switch <branch>` first when none has. The terminal
    line is `◆ landing-sync`: merge or rebase onto the tip and push;
  - `unknown`, never ready: the fetch failed, the clone is shallow and the
    answer was 1, a commit or the tip does not resolve, the check could not
    run, or the look's time ran out. The terminal line is `◆ landing-unknown`.

  Readiness is the local branch's. A branch synced here and not pushed is
  ready while its pull request's head, and the CI on it, is still behind, so
  a ready branch whose pull request is open carries the push in `commands`
  (a no-op when the pull request has the commit). The check runs in the
  scratch repository, before the overlap checks, so
  they cannot spend its time. A branch behind the last fetched tip is behind
  the newer one too, so `needs-sync` stands on a look whose fetch failed or did
  not run. A look that did not fetch (a lane's look after its step) calls
  nothing ready: what the stale tip calls up to date is held back from the
  logs, and the run's next look, which fetches, reports it. A drain takes no
  next look, so it takes one, with the fetch, before the run ends, and its
  lane report (`run.json` and `halt.json` lanes, each lane's line in
  `status`) lists what waits as that look found it. What that look could not
  read leaves no freshness standing (`scheduler.mjs` `reconcileWaiting`).
  Every look the run takes feeds the run's list of waiting lanes, by one
  rule: the first look's report, each look of the run's loop (joined before
  anything it decides can halt the run, a lane whose step is still in flight
  included), each step's own look as it settles (after an interrupt too;
  this is how a lane that committed during the drain is known), the drain's
  last look, and the look the run's end takes to judge its proposals again.
  A look that found a lane waiting gives it what its report found; one whose
  report held it back (not fetched in that look) leaves the freshness it had
  at the same commit. A look with no report of its own (the end's look for
  its proposals, a look an interrupt or an error cut off before its report)
  adds nothing to what it could not judge: each lane it finds listed keeps
  what it had (a `ready` excepted when the same look saw a lane land; see
  "A landing ends a kept ready" below), one it newly finds is `unknown`, and
  another look's report never speaks for it. A lane leaves the list only when a look reads that it
  stopped waiting: its subtask no longer in progress, its engineer workflow
  active again or closed with no commit, its pull request merged. Otherwise
  it stays listed, `unknown`: the look failed or could not read the macro,
  or the lane's engineer workflow could not be read, or its landing check
  failed or refused (`gh` unavailable, for one). A lane the look found
  waiting whose report did not complete is `unknown` too. A failed look
  observes nothing, so nothing reaches the logs: their last record stands
  until a look reads the branch again. A reader that takes a log's latest
  record for a lane as its current readiness reads the observation of an
  earlier look; the run's last word on the lane is its lane report.
- **Every end reconciles before its report.** *Amendment 2026-10-14 (the
  owner's decision on a recurring finding):* each end of a run with lanes
  builds its lane report from the run's list after the latest observation
  it holds. Every look feeds the list as it returns, before its report
  (a failed one too, below), so the end's own look for proposals, and a look an
  interrupt, an error or a retry cut off, are never lost; the report, when
  one runs for that look, then gives each lane its facts. A run that ends
  without its last
  look, interrupted (before or during the drain's look, or while a step
  settles) or stopped by an error, confirms nothing: every lane it lists is
  `unknown`, "the run ended before its last look", and the next run's first
  look reports each again. An error after the halt was recorded (while it was
  printed, for one) leaves each branch the halt lists waiting `unknown`, and
  `halt.json` is written again. A lane whose step's looks all failed
  is not known to wait, and is not listed: its step halts unverified, and
  its lane line says so. A serial run carries the same list: every halt,
  whatever its reason, lists what its looks found waiting in
  `halt.json` `waiting`, with the freshness its report found (`unknown` when
  the report did not complete). A serial run's first look, taken before its
  locks, has no report: what it finds waiting is listed `unknown` until the
  first report, so a halt before that report (the locks are held) still
  names it.
- **The rule at its chokepoints.** *Amendment 2026-10-14, later the same day
  (the owner's decision on the third recurrence of the finding above):* the
  rule lives where every look and every end pass, not at each call site.
  - Every look feeds the list as it returns, before its report: a run with
    lanes through the scheduler's `look`, a serial run through the driver's
    `look`, which its first look, its look under the locks, the look after
    each step, that look's retry and the look after a step's abandoned peers
    are settled all take. A look a later look or a retry replaces is fed
    first. A run has one list: a run with lanes' scheduler takes the one the
    driver's looks before it (before the locks, under them, the first
    report) have fed, and starts none of its own.
  - A failed look feeds the list too, the end's own look included: it reads
    nothing, so every lane the list holds becomes `unknown`, "the run's last
    look failed", until a later look's report gives it facts again.
  - Only an end builds a halt's list, after it has reconciled: a serial run's
    `finish`, for every halt, and a run with lanes' `end`, for its
    `awaiting-landing` halt (each lane's report lists the rest). Either one
    applies the interrupt rule first, so a run the owner interrupted lists
    every branch `unknown`. The `awaiting-landing` halt lists the run's list,
    not the list of the look that decided it, so a branch that landed while
    the run ended is not listed, and its count in the halt's detail may be
    higher than the list.
  - An error ends a run without its last look, so each entry becomes
    `unknown` wherever the list is recorded: the lanes in `run.json` (the
    scheduler's catch), the halt already written (`halt.json`, written
    again), or, when the run stopped before any halt and before a run with
    lanes reported its lanes, `run.json` `waiting`, which `status` prints.
- **A landing ends a kept ready.** *Amendment 2026-10-14, after the
  critique of the chokepoint form:* a look that did not fetch keeps an
  earlier look's freshness (one with no report of its own, the end's look
  for its proposals among them, and one whose report held a lane back). When
  that same look reads a landing (a subtask whose pull request merged and
  that is not yet recorded completed, whether the list held it or not, since
  its landing check may have failed until then; or a lane that waited and
  leaves recorded completed with its commit), the integration branch has
  moved past the tip every kept `ready` was judged against, so none is kept:
  each becomes `unknown`, "subtask A landed after the look that judged it
  ready, and this look did not fetch", and the next look that fetches judges
  it again. A `needs-sync` stands, with its commands: a branch behind the old
  tip is behind the new one too. A lane that stops waiting without landing
  (a new attempt, a close or a completion with no commit) moves no tip, and
  the rest keep what they had. A merged pull request that a fetched look
  already judged against, and that is still not recorded completed when a
  later look does not fetch, turns that `ready` `unknown` as well: the list
  holds no record of which landings a judgment saw, and `unknown` is the
  safe side. This is the A-lands-then-B sequence at the run's own end: A
  lands during the end's look, and B, reported ready before, is listed
  `unknown` in `halt.json` `waiting`, the halt block and its lane report.
- **The fetch names its ref.** The observer fetches
  `+refs/heads/<baseline>:refs/remotes/origin/<baseline>` with `--no-tags
  --refmap=`, as `fetchBaseline` does: under a configured mapping that does
  not cover the branch, `git fetch origin <baseline>` succeeds and leaves the
  ref stale.
- **Deduplication is by transition.** The subject is (subtask id, engineer
  workflow id), the observation (captured sha, integration branch,
  `base_commit`, state). A record is published when the latest one the
  macro's log holds for its subject observed something else, so a new sha,
  the baseline moving (another lane landed) or renamed, and a fetch that fails
  or recovers are each reported, and an observation is not reported again
  while it stays the latest one the macro's log holds for its subject. It can
  repeat otherwise: a state that changes and changes back (ready, unknown,
  ready) is reported each time; while the macro's log cannot be written,
  every look prints the block and appends `landing.jsonl` again; a driver
  that dies between the two appends reports it again. A record written
  before this note has no `sync`, so its subject is reported once more.
- **What decides readiness.** Every record keeps `event: "landing-ready"`,
  whatever its state, so a reader that tails either log reads `ready` (or
  `sync.state`), never the event name, to decide whether a branch can land.
- **A missing integration ref.** Through the observer it never reaches the
  report: `resolve-landing` answers `no_integration_ref`, an owner-choice
  halt. The report's own `unknown` covers callers that hand it a view.
- **Recording.** A failure to read or write the logs is printed once, and
  again only after a record has been written to both; an off-loop report
  takes that state in and gives it back. The run ledger's `landing.jsonl` is
  appended as the macro's log is (`ledger.mjs` `appendLine`): a torn last line
  ended first, a short write continued. `halt.json` keeps `merge_order` in
  snake case, as `landing.jsonl` does; its `waiting` entries carry `sync`,
  which `status` prints, so a run that published nothing new still shows
  each waiting branch's readiness.
- **Downgrade.** A CLI older than this note labels every record in `status`
  landing-ready, whatever its state.
- **Known limits**, recorded, not fixed:
  - a submodule moved on one side reads as a conflict to merge-tree (F2);
  - in a blob-filtered partial clone, or for objects the repository reaches
    only through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, the scratch cannot read
    what it needs, and the overlap answer is unavailable;
  - an unavailable pair is not cached, so a look checks it in both
    directions, twice.

## Amendment 2026-10-19 — lanes that keep going (ADR-0068, slice 1)

The Status section recorded it so:

- Amended 2026-10-19 by
  [ADR-0068](../0068-autopilot-lanes-that-keep-going.md) (accepted 2026-10-20): a lane
  halt parks only its lane, and the owner can hold a lane and release it.
  Decision 4 item 5, Decision 5's Creation and Removal and its
  Reconciliation rows, Decision 6's capability floor, Drain, Throttle and
  Forced resume, and §Out of scope carry dated notes.

In Decision 4, item 5 (admission entries), after "SR implements this":

   - *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
     accepted 2026-10-20):* admission's join is
     unchanged. A lane the owner holds is kept from the driver by its hold
     record, and its worktree lock carries an entry for the hold, which
     fences it from any run, an older driver included, and which
     `admission release` does not remove from that release on; the macro
     lock gets none. The person in the lane uses the persona commands,
     which join no admission, and the commands above are still refused
     beside a live run. `/orchestrator:next` refuses, from any checkout, a
     subtask held (its handoff done or pending, or its record unreadable),
     with a release no run has compared yet, or with a persona operation
     open (ADR-0068 Decision 2, items 3 to 5).

In Decision 5, Removal:

  - *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    accepted 2026-10-20):* neither Creation nor Removal
    begins for a held subtask. The driver reads the hold right before each,
    and one already begun when a hold appears runs to its end before the
    lane is handed over (ADR-0068 Decision 2, items 3 and 4).

In Decision 5, Reconciliation, after the rows:

  *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
  accepted 2026-10-20):* the holds and kept lane parks of
  the macro are read before anything else, the preparation included. A held
  subtask, its handoff done or pending, is reported as such and passed by:
  no row acts on it (no lane id written, no removal intent finished, no
  prepared dispatch, no adoption, no removal, no new lane, no halt;
  ADR-0068 Decision 2, item 11). A park an earlier run kept parks its lane
  again before any row acts on it, while the lane's fingerprint is unchanged
  (ADR-0068 Decision 1, item 3). Besides the subtask rows' rerun before each
  creation, the preparation's items for a parked lane's path and its rows
  also run mid-run for that lane alone when it is reconsidered, planned from
  the facts of the whole macro (ADR-0068 Decision 1, item 4).

In Decision 6, `--lanes N`, the capability floor:

  - *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    accepted 2026-10-20):* the floor gains a token for
    the pinned engineer's hold-aware persona, and a run records in
    `run.json` that it honours holds only when it reads holds and that
    token is present; a run without it does not start while a hold applies
    (ADR-0068 Decision 2, item 9).

In Decision 6, Drain (W2), with the bullet it qualified:

- **Drain (W2).** A halt in any lane or in a lane's creation (Decision 5),
  an invalidated plan approval, version drift, or an exhausted budget puts
  the run in `draining`:
  - no new lane starts or is created, and no lane starts a new step;
  - steps in flight run to their normal end and are verified and recorded. A
    commit that finishes still emits its landing-ready event (Decision 7),
    and a halt during the drain is recorded too;
  - when nothing is in flight, the driver writes `halt.json`, with the first
    halt as `reason` and one entry per lane, and exits 2.

  *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
  accepted 2026-10-20):* only an invalidated approval (a
  plan-changing decision included), a gate on the macro, version drift, an
  exhausted budget and the other run-wide halts drain, scoped by their
  cause. A halt that arises in a lane parks that lane, the other lanes go
  on, and the lane is judged again when its record changes or the owner
  releases it. The park is kept for the next run while the lane's
  fingerprint is unchanged, so a failure that writes nothing is never
  retried on an unchanged record. The run ends when nothing runs and
  nothing can start (ADR-0068 Decision 1).

In Decision 6, Throttle:

  - Lanes already started keep stepping: the throttle gates new lanes only,
    the owner's default.

    *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    accepted 2026-10-20):* a lane resumed after a park
    or a hold counts as a new lane: the throttle gates its first step after
    the resumption, since the capacity it left may have gone to other lanes
    (ADR-0068 Decision 1, item 4).

In Decision 6, Forced resume, with the bullet it qualified:

  - A forced step replaces only its own lane's judgment halts. The forced
    steps start first. The other lanes are then judged as usual, and a
    judgment halt that persists in one of them drains the run while the
    forced steps finish.
  - *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    accepted 2026-10-20):* a forced step resolves its
    lane's park; a judgment halt that persists in another lane parks that
    lane only, and a forced step on a held lane is refused (ADR-0068
    Decision 1, item 8).

In § Out of scope (follow-ups):

- Interactive lanes: `/orchestrator:next --parallel`, `claude --bg` lane
  sessions and cross-session messages (L2). They are the next macro, with its
  own ADR; the precedent is its main input.

  *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
  accepted 2026-10-20):* that ADR takes up the takeover of a lane by a person (hold and
  release), worked in a session of the person's own in the lane's folder;
  its later slices take up record-based messages at step boundaries (the
  driver's event file, main-to-lane instructions). `/orchestrator:next
  --parallel` stays unbuilt, the owner's decision of 2026-10-17.

## Amendment 2026-10-19 — stall detection and the driver's event file (ADR-0068, slice 2)

The Status section recorded it so:

- Amended 2026-10-19 by ADR-0068's slice 2 (accepted 2026-10-20): stall
  detection and the driver's event file. Decision 6's Budgets and Decision
  8, item 5, carry dated notes.

In Decision 6, Budgets are reserved:

    *Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    slice 2, accepted 2026-10-20):* the reservation's
    `timeoutSec` stays `--step-timeout` while the stall detector only
    records; once the owner switches it on, its default is the 8-hour
    emergency cap, and a stalled step ends earlier, settling its reservation
    as an abort does (ADR-0068 Decision 3, item 8).

In Decision 8, after item 5:

*Note 2026-10-19 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
slice 2, accepted 2026-10-20):* the driver's event file is
one more report, and carries none of these entries: a halted run's
`run-ended` line points at the halt record that holds them, and a `halt`
line met while the
run drains at the run's records as they stand (ADR-0068 Decision 4, items 2
and 3).

## Amendment 2026-10-20 — driver-run verification and the heavy-work lock (ADR-0068, slice 3)

The Status section recorded it so (its note on cascade item 7c stands in the
cascade record above):

- Amended 2026-10-20 by ADR-0068's slice 3 (accepted 2026-10-20): a
  verification step the driver runs with no LLM, and one heavy-work lock.
  Decision 6's opening, its capacity claim and its Locks, §Out of scope and
  cascade item 7c carry dated notes.

In Decision 6, `--lanes N`:

  - *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    slice 3, accepted 2026-10-20):* N counts workers.
    Beside them, serial or with lanes, the driver runs verification batches
    with no LLM, one at a time in the order their requests were recorded,
    each under the heavy-work lock; a lane whose batch waits or runs holds
    no worker slot (ADR-0068 Decision 5, item 9).

In Decision 6, Locks:

  - *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    slice 3, accepted 2026-10-20):* beside these, the
    repository's heavy-work lock, the mutation harness's
    `<git-common-dir>/mutation-harness.lock`, under which the driver's
    verification checks run. No holder of it waits for a run lock (ADR-0068
    Decision 6, item 7).

In Decision 6, with the bullet it qualified:

- **Lanes waiting to land do not hold capacity.** The cap bounds concurrent
  workers: their cost, the rate limit, a full test run each. A lane waiting
  for its merge runs nothing. The backlog is bounded by the plan and reported
  by Decision 7. The run halts `awaiting-landing` when nothing else can run,
  as today.
  *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
  slice 3, accepted 2026-10-20):* the cap no longer
  bounds full test runs: a worker hands them to the driver's verification
  step, and the heavy-work lock lets one heavy job of the repository run at
  a time among the holders that take it (with the exceptions ADR-0068
  Decision 6, item 2 states). The cap bounds the workers' cost and the rate limit; a lane
  verifying, like one waiting to land, holds no slot (ADR-0068 Decisions 5
  and 6).

In § Out of scope (follow-ups):

- A heavy-job lock, so two lanes do not run `npm test` at the same time.

  *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
  slice 3, accepted 2026-10-20):* taken up there: one
  heavy-work lock per repository, the mutation harness's file, shared by the
  driver's verification checks, the harness and a wrapper for interactive
  sessions (ADR-0068 Decision 6).

## Amendment 2026-10-20 — main-session instructions and rebinding (ADR-0068, slice 4)

The Status section recorded it so:

- Amended 2026-10-20 by ADR-0068's slice 4 (accepted 2026-10-20): the main
  session's instructions to a lane, and the rebinding of a dispatched
  subtask by an approved change of its instructions. Decision 4, item 5,
  Decision 6's Forced resume and §Out of scope carry dated notes.

In Decision 4, item 5 (admission entries):

   - `/orchestrator:plan` and `/orchestrator:approve` stay available. A
     re-plan revokes the approval, and the driver halts at its next decision
     (ADR-0063 S6 note). An approval is the owner's own act.

     *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
     slice 4, accepted 2026-10-20):* an approval that
     changes the plan joins the macro lock as an admission, so it is refused
     beside a live run of the macro or an admitted command. An approval that
     changes an in-progress subtask's topic or profile records a rebinding
     of its child, and is also refused while a persona operation is open in
     that lane, the subtask is held, or its release awaits comparison; every
     write that compares a child's dispatch also accepts a child rebound
     under the macro's current approval (an active child once it has been
     told), and a changed branch, a changed verb the child recorded, and
     any other child, stay refused (ADR-0068 Decision 8).

In Decision 6, Forced resume:

  - *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
    slice 4, accepted 2026-10-20):* a forced step on a
    lane with a pending instruction that carries a step is refused, naming
    it: the owner
    withdraws the instruction or drops the forced step (ADR-0068 Decision
    7, item 5).

In § Out of scope (follow-ups), after the interactive-lanes bullet's note of
2026-10-19:

  *Note 2026-10-20 ([ADR-0068](../0068-autopilot-lanes-that-keep-going.md),
  slice 4, accepted 2026-10-20):* main-to-lane messages
  are taken up there as instructions, records the driver applies at a
  lane's next step boundary (ADR-0068 Decision 7). Lane-to-lane notes stay
  out, the owner's decision of 2026-10-19.

## Amendment 2026-10-27 — a branch a consumed release recorded (ADR-0062)

In Decision 5, Reconciliation, after the rows:

  *Note 2026-10-27 ([ADR-0062](../0062-subtask-completion-recorded-at-landing.md)
  §Decision 2, amendment of 2026-10-27):* row 12 also reuses a branch whose
  tip a consumed release of the subtask's current hold recorded, when the
  baseline ref is an ancestor of it; its halts, row 4's and the admission's
  refusal of a prepared lane never advise discarding a branch that carries
  commits the baseline lacks, or one not shown to carry none.

## Superseded text 2026-11-17 — the Status section before the ADR-0070 migration

The Status section as it stood before the ADR moved to the ADR-0070 layout;
the Status section now holds the status only. The draft comment after it,
which keys the ADR's `path:line` citations, stays in the ADR.

Accepted (2026-10-08 — the owner accepted it explicitly at PR review, #903).
Proposed 2026-10-07.
- Asked for by the owner on 2026-10-05, at the E1 decision of macro
  `macro-plan-20261003T022443Z-139657`: keep `runtime:worktree` and
  `runtime:consensus`, run autopilot work in parallel worktree lanes, and
  have the system propose worktrees, lanes and consensus instead of waiting
  to be asked.
- Owner decisions L1–L4 taken 2026-10-07 UTC for macro
  `macro-plan-20261007T174440Z-f76033`, with the defaults told to the owner
  at the same time (§Context).
- Written as that macro's subtask AD. The other subtasks (PL, RR, LR, SR, WL,
  DL, WP, CP) implement this ADR, and each waited until the owner accepted it.
- The owner accepted it explicitly at pull-request review (#903,
  2026-10-08). The accepting commit applied
  [§Amendment cascade](#amendment-cascade-apply-verbatim-on-acceptance) and
  marked the index row Accepted.
- Amended 2026-10-13 by the owner's review decision C105 (recorded outside
  this repository): Decision 6's Budgets lose the elapsed time and the run
  deadline, and its Throttle waits for a reset however far off, halting only
  on a part with no reset time; the C105 follow-up under §Out of scope is
  closed by that removal. Each place keeps its text and carries a dated note.
- Amended 2026-10-13 by the owner's review decision C92 (recorded outside
  this repository): Decision 6's open-run record outlives a run whose step's
  peers are unaccounted for (a look that could not read or list them, a
  cancellation that did not go through), and the cleanup searches that step.
  Each place keeps its text and carries a dated note.
- Amended 2026-10-19 by
  [ADR-0068](../0068-autopilot-lanes-that-keep-going.md) (accepted 2026-10-20): a lane
  halt parks only its lane, and the owner can hold a lane and release it.
  Decision 4 item 5, Decision 5's Creation and Removal and its
  Reconciliation rows, Decision 6's capability floor, Drain, Throttle and
  Forced resume, and §Out of scope carry dated notes.
- Amended 2026-10-19 by ADR-0068's slice 2 (accepted 2026-10-20): stall
  detection and the driver's event file. Decision 6's Budgets and Decision
  8, item 5, carry dated notes.
- Amended 2026-10-20 by ADR-0068's slice 3 (accepted 2026-10-20): a
  verification step the driver runs with no LLM, and one heavy-work lock.
  Decision 6's opening, its capacity claim and its Locks, §Out of scope and
  cascade item 7c carry dated notes.
- Amended 2026-10-20 by ADR-0068's slice 4 (accepted 2026-10-20): the main
  session's instructions to a lane, and the rebinding of a dispatched
  subtask by an approved change of its instructions. Decision 4, item 5,
  Decision 6's Forced resume and §Out of scope carry dated notes.
- **On acceptance** it:
  - amends [ADR-0063](../0063-autopilot-fresh-session-driver.md): R2's halt
    wording, D1's worktree-lanes clause (the held integration-merge clause is
    dropped), D3's `/orchestrator:next` row and D4's proceed rules (per
    lane), D4's gate enum (`merge-conflict` out, `peer-conflict` in), its
    `version-drift` and `budget` halt rows and its Lanes paragraph, D5's
    Spawn paragraph and Env, and D8's ledger location, run directory list
    and Lock bullet;
  - amends [ADR-0029](../0029-entry-routing-contract-enforcement.md) §3, on the
    §1 proposal: a conflict verdict selects a bounded consensus round, and a
    display-only
    lane-advice line may follow the six proposal fields. The closed
    `next_step_kind` enum is unchanged;
  - amends [ADR-0019](../0019-cross-plugin-invocation-contract.md) §3: one more
    immutable create-time linkage key, `parent_workflow_path` (Decision 3).
- Until then the status lines it adds to ADR-0063 and ADR-0029 only announce
  the proposal. No decision text of either changes. ADR-0019 gets no status
  line before acceptance: the subtask's scope names only those two.
