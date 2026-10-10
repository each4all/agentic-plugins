# ADR-0066: Persona pipeline — one canonical source, generated into each persona plugin

## Status

Accepted (2026-10-05 — the owner accepted it explicitly at PR review, #879).
Written for macro subtask PC0 (`macro-plan-20261003T022443Z-139657`) from
the owner's selection at E1 (`decide-20261005T015832Z-7931cf`). The
implementation subtask PC1 implements Stage 1.

Supersession is atomic with acceptance (the ADR-0056 §Decision 9 rule). The
proposal added a "Proposed to be superseded" line to ADR-0036 and ADR-0042,
for Sub-decision 7 only. The acceptance commit replaced those lines and
applied §Amendment cascade.

A cross-host Plan-verify review (Codex, run
`plan-verify-20261005T090052Z-13bf69`) checked the draft against the
repository and reran its measurements. Each of its findings was checked against
the repository before it was applied. It corrected D4 and the history counts,
added the runtime footer floor (V18), and added the rules for the
declaration loader, for capabilities that are off, for the region grammar and
substitution, for ensemble settlement, and for mixed versions.

## Context

### The owner's direction

The owner's selection at E1 (2026-10-05): the persona plugins are one shared
pipeline plus persona content. Copying the pipeline by hand is not acceptable.
A common core is approved because it is the canonical structure: the ADR-0010
layer model, a common core with explicit variation points, and generation with
a drift check where installs must stay standalone, as `sync:companions`
already does for the companion bundle (ADR-0008 §(d)).

This ADR settles how. It inventories, by measurement, what the three persona
plugins share and where they differ, and records the drift the copies have
already accumulated.

### How it was measured

Measured on `f2cadb35` (`main`, 2026-10-05), over `plugins/engineer`,
`plugins/founder` and `plugins/designer`.

- **Normalization.** Each file is compared after the three persona names, in
  all three casings, are replaced by one token. A second pass also replaces
  every `ADR-NNNN` number, since each persona was chartered by a different
  ADR. The tables below use the second pass unless they say otherwise.
- **Code** is compared by line with `diff`, counting `<` and `>` lines, so one
  changed line counts as 2. "Code-only" also drops comment lines and trailing
  `//` comments.
- **Words.** A whole file, code included, is split into one word per line and
  compared with ordinary `diff`. The figure is the share of the larger file's
  words outside the common part `diff` finds. It measures how far two files are
  apart, not how much of either is persona content: drift and reordering count
  too. An exact longest-common-subsequence count, run by the cross-host review,
  moves a few figures by 1 to 5 points (the largest: `start/SKILL.md` F~E, 74%
  → 69%).
- **Runbook pipelines** are compared two ways: as the ordered list of
  `node "$CLAUDE_PLUGIN_ROOT/scripts/<script>.mjs" <subcommand>` calls, and as
  the runbook's bash blocks with comment lines removed.

The measuring scripts are measurement, not tooling. They are recorded in the
PC0 workflow note and are not added to the repository. F~D is founder against
designer, and F~E is founder against engineer.

### Inventory 1 — scripts and hooks

| File | engineer | founder | designer | F~D | F~E | F~E code-only |
|---|---:|---:|---:|---:|---:|---:|
| `hooks/hooks.json` | 35 | 35 | 35 | 0 | 0 | 0 |
| `adapters/claude/hooks/_shared.mjs` | 96 | 96 | 96 | 0 | 0 | 0 |
| `adapters/claude/hooks/pre-compact.mjs` | 42 | 42 | 42 | 0 | 0 | 0 |
| `adapters/claude/hooks/session-start.mjs` | 124 | 132 | 132 | 4 | 32 | 0 |
| `adapters/claude/hooks/stop.mjs` | 81 | 85 | 85 | 2 | 14 | 0 |
| `adapters/codex/hooks/hooks.json` | 35 | 35 | 35 | 0 | 0 | 0 |
| `adapters/codex/hooks/README.md` | 39 | 39 | 39 | 0 | 0 | 0 |
| `adapters/codex/hooks/run-node-hook.sh` | 56 | 56 | 56 | 0 | 0 | 0 |
| `adapters/codex/hooks/_shared.mjs` | — | — | 101 | — | — | — |
| `adapters/codex/hooks/pre-compact.mjs` | 39 | 39 | 39 | 2 | 0 | 0 |
| `adapters/codex/hooks/session-start.mjs` | 93 | 97 | 97 | 6 | 18 | 0 |
| `adapters/codex/hooks/stop.mjs` | 143 | 145 | 145 | 2 | 12 | 0 |
| `scripts/lib/args-file.mjs` | 487 | 487 | 487 | 0 | 0 | 0 |
| `scripts/lib/yaml-mini.mjs` | 415 | 415 | 415 | 0 | 0 | 0 |
| `scripts/lib/decide-sensitivity.mjs` | 201 | 201 | 201 | 0 | 0 | 0 |
| `scripts/lib/decide-args.mjs` | 196 | 198 | 198 | 10 | 10 | 0 |
| `scripts/lib/decide-weights.mjs` | 103 | 104 | 104 | 4 | 5 | 0 |
| `scripts/lib/decide-scores.mjs` | 190 | 191 | 190 | 13 | 19 | 5 |
| `scripts/validate-commit.mjs` | 259 | 259 | 259 | 0 | 2 | 0 |
| `scripts/dispatch-peer.mjs` | 872 | 859 | 859 | 0 | 15 | 10 |
| `scripts/decide-registry.mjs` | 437 | 463 | 568 | 171 | 46 | 20 |
| `scripts/peer-runner.mjs` | 1,311 | 1,290 | 1,290 | 2 | 37 | 33 |
| `scripts/discover-runtime.mjs` | 499 | 526 | 526 | 2 | 167 | 46 |
| `scripts/stop-archive.mjs` | 413 | 338 | 338 | 6 | 159 | 59 |
| `scripts/session-handoff.mjs` | 743 | 871 | 871 | 10 | 438 | 144 |
| `scripts/state.mjs` | 4,546 | 3,534 | 3,534 | 46 | 1,322 | 852 |
| engineer only: `parent-writeback.mjs`, `phase7-commit.mjs`, `start-args.mjs` | 640 + 1,941 + 56 | — | — | — | — | — |
| engineer only: `adapters/claude/agents/*.md` (4 subagents) | 192 | — | — | — | — | — |

**founder against designer.** The 25 files the two share under `scripts/`,
`adapters/` and `hooks/` hold 10,537 and 10,641 lines, and differ by 280 diff
lines. Every one of them is accounted for:

- 198 are decide data, designer's profile-selection code, and their
  commentary. `decide-registry.mjs` (171) carries each persona's in-code
  fallback axes and its size-to-preset map. It also carries designer's L4
  profile-to-preset map with the code that applies it (precedence, the
  silent-drop warning, two fallback branches), and founder's veto-gate
  rationale. The three `lib/decide-*` modules (27) differ in comments and in
  the axis named by an example.
- 76 are ADR section citations: "SD5" against "SD7", "Non-Goal 3" against
  "Non-Goal 2", "S3" against "S4".
- 2 are one user-facing noun: `session-handoff.mjs` asks the user to save "the
  business deliverable" in founder and "the design deliverable" in designer.
- 4 are one structural difference: founder's Codex hooks import their helpers
  from the Claude adapter (`../../claude/hooks/_shared.mjs`), while designer
  carries a Codex-local `_shared.mjs` (101 lines), so its Codex adapter never
  reaches into the Claude adapter's tree.

With comments removed, 88 lines differ: decide data and designer's
profile-selection code, user-facing strings that cite the persona's ADR or name
its deliverable, and the Codex helper import. Outside decide, founder and
designer run the same code.

One more variation sits in the resolver's constants, not in the diff counts:
the oldest runtime whose footer each persona accepts. engineer requires
`0.63.0` and founder and designer `0.79.0`, because earlier runtimes reject
their workflow kinds (`discover-runtime.mjs` `MIN_RUNTIME_VERSION`, ADR-0043
§4).

**founder against engineer.** The scripts hold 9,736 and 13,309 lines. The
files they share differ by 2,220 diff lines, and engineer has 2,637 lines of
scripts founder does not have. `state.mjs` accounts for 1,322 of the 2,220.
Its diff hunks were sorted into families by the identifiers they touch, each
hunk counted once, in the first family it matches:

| `state.mjs` hunk family | Diff lines |
|---|---:|
| ADR-0063 autopilot, closed-enum next step, owner gates (`autopilot-preflight`, `finish-verb`, `awaiting-owner-*`) | 777 |
| ADR-0019 orchestrator linkage and ADR-0028 §P10 parent write-back | 369 |
| ADR-0025 legacy dual-home readers | 53 |
| Phase 7 commit and `detach-archive` (ADR-0028, ADR-0062) | 25 |
| #812 canonical-path CLI entry guard | 17 |
| Other | 81 |
| **Total** | **1,322** |

engineer's `state.mjs` subcommands are a superset of founder's. It adds
`autopilot-preflight`, `finish-verb`, `awaiting-owner-set`,
`awaiting-owner-clear`, `set-parent-writeback-marker`,
`clear-parent-writeback-marker` and `detach-archive`, and founder has no
subcommand engineer lacks. The other shared files diverge in both directions;
see D4 and D7 below. With comments removed, every hook file engineer shares
with founder is identical, and so are `validate-commit.mjs`, `decide-args.mjs`
and `decide-weights.mjs`. `decide-scores.mjs` differs by 5 code lines:
engineer's copy hard-codes the `practical-fit` axis as the first tie-break,
which is persona data written into code.

### Inventory 2 — command runbooks

| Command | Script calls E / F / D | F == D call list | Bash code F~D | Bash code F~E | Words F~D | Words F~E |
|---|---|---|---:|---:|---:|---:|
| `checkpoint` | 2 / 2 / 2 | yes | 2 | 0 | 8% | 22% |
| `compose` | 8 / 7 / 7 | yes | 19 | 50 | 20% | 52% |
| `critique` | 8 / 7 / 7 | yes | 42 | 62 | 38% | 51% |
| `decide` | 13 / 8 / 8 | yes | 12 | 67 | 10% | 55% |
| `frame` | 8 / 7 / 7 | yes | 17 | 56 | 16% | 44% |
| `investigate` | 8 / 7 / 7 | yes | 18 | 55 | 13% | 45% |
| `peer-now` | 5 / 3 / 3 | yes | 4 | 45 | 21% | 60% |
| `refine` | 14 / 7 / 7 | yes | 44 | 80 | 46% | 63% |
| `resume` | 5 / 4 / 4 | yes | 4 | 101 | 11% | 73% |
| `start` | 21 / 5 / 6 | no | 23 | 248 | 38% | 86% |
| engineer only: `commit` (13 calls), `audit` (alias of `critique --profile=full-codebase`) | | | | | | |

- founder and designer make the same script calls in the same order in 9 of 10
  runbooks. In `start`, designer adds one call:
  `AGENTIC_DESIGNER_PROFILE=… decide-registry.mjs resolve`
  (`plugins/designer/commands/start.md:152-153`), which resolves the decision
  preset for the L4 design archetype. The archetype is passed inline to that
  one call and not exported, so no stale value leaks into a later block.
- engineer's `compose`, `critique`, `frame` and `investigate` make founder's
  calls with two changes: `autopilot-preflight` after `find-active`, and
  `finish-verb` where founder calls `set-terminal`. engineer's `decide` and
  `refine` add the owner-gate calls on top. `resume` and `start` differ in
  substance: engineer's `start` is the full lifecycle with Phase 7 commit.
- Where founder's and designer's bash blocks differ (2 to 44 lines a command),
  the difference is persona content written inside pipeline blocks — the
  default profile, the original-request placeholder, the artifact description
  in the phase-note template, the rationale gate, the evidence pointers and the
  next-action text — plus two behavior differences: designer's ensemble-commit
  guard (D2) and designer's refine convergence gate, which writes the terminal
  marker only when the re-critique converged
  (`plugins/designer/commands/refine.md:274`).

### Inventory 3 — shared references and skills prose

| File | Words E / F / D | F~D | F~E |
|---|---|---:|---:|
| `_shared/references/ensemble-protocol.md` | 4,445 / 4,783 / 5,723 | 41% | 55% |
| `_shared/references/orchestration.md` | 1,419 / 1,361 / 2,469 | 61% | 61% |
| `_shared/references/session-handoff.md` | 1,170 / 2,055 / 2,114 | 4% | 59% |
| `investigate/references/output-file-rules.md` | 944 / 919 / 930 | 6% | 17% |
| `decide/references/decision-axes.yml` | 535 / 741 / 1,470 | 74% | 78% |
| `SKILL.md` of the ten shared skills | — | 6% to 70% | 10% to 74% |

- The references mix pipeline text with persona text: ensemble lenses, the
  privacy gate, designer's no-image peer rule, Task Profile fields. Neither a
  whole-file copy nor a whole-file split fits them.
- founder and designer ship none of engineer's `presentation-protocol.md`,
  `entry-routing-contract.md`, `autopilot-mode.md` and `agent-taxonomy.md`.
- Each `SKILL.md` is mostly persona prose, but it also carries pipeline
  paragraphs: the session-level handoff preflight, the multi-axis lens, the
  Layer 2 commit-manifest recording, and the autopilot note.

### Inventory 4 — tests

| Suite | Files | Lines |
|---|---:|---:|
| `tests/engineer/` | 36 | 19,762 |
| `tests/founder/` | 16 | 8,638 |
| `tests/designer/` | 16 | 8,863 |
| `tests/plugin-shape/test-{engineer,founder,designer}-plugin.mjs` | 3 | 1,824 / 846 / 2,092 |

Fifteen of the sixteen founder and designer test files pair up and differ by 0
to 58 normalized lines. Seven of them are identical. The sixteenth pair,
`test-decide-registry.mjs` (345 and 569 lines, 516 diff lines), tests persona
data. The designer suite is a mirror of the founder suite, maintained by hand.

### Inventory 5 — state schema and workflow files in use

- founder and designer write schema `1.3`. engineer writes `1.4`, which adds
  the six optional flat `next_step_*` and `awaiting_owner_*` scalars of
  ADR-0063 D6.
- Every reader accepts any `1.x` (ADR-0028 §Forward-compat), and mutation
  helpers never change the schema a file has on disk.
- Checked 2026-10-05:
  - founder's `1.3` `state.mjs` reads and appends to a `1.4` file that carries
    `next_step_*`, and keeps both the schema and the keys;
  - engineer's `1.4` writers keep a `1.3` file at `1.3`
    (`tests/engineer/test-state-schema-14.mjs:375`).
- Persona workflow files on the owner's machine under `~/Workspace`: 5 (3
  founder, 2 designer; 2 active, 3 archived), all at schema `1.3`.

### Inventory 6 — how changes travel today

From 2026-08-06 to 2026-10-05:

- Every founder commit that changed a script has a designer twin with the same
  subject once the persona name is normalized: 10 of 10.
- Over all founder and designer commits, release commits excluded, there are
  18 distinct changes. 15 were made as two commits, one per persona; one
  commit touched both plugins; two touched designer alone.

The paired commits are evidence of repeated maintenance; matching subjects
alone do not show how each edit was made. No script syncs the copies. The only whole-file parity checks are
the byte-equality of `lib/args-file.mjs` across five packages
(`tests/plugin-shape/test-args-file-transport.mjs`) and the peer-runner spawn
section.

### Drift found

Hand copies have already drifted. Each item below is a defect or a missing
feature that one canonical source would not have allowed.

- **D1 — the canonical-path CLI entry guard reached half of the CLIs.** #812
  (`4b5ad750`) replaced the
  ``import.meta.url === `file://${process.argv[1]}` `` guard, which exits 0
  without running when the script path is a symlink or contains a space, `#`
  or non-ASCII characters, with a `realpathSync` comparison. It changed
  engineer's `state.mjs` (now `:4525`) and `dispatch-peer.mjs` (`:803`).
  - founder's and designer's port of #812 (`09a64356` and its designer twin)
    took the resolver change but not the guard. They still use the old guard
    in `state.mjs:3519` and `dispatch-peer.mjs:796`.
  - `peer-runner.mjs` keeps it in all three personas (engineer `:1308`,
    founder and designer `:1287`), and so does engineer's
    `phase7-commit.mjs:1928`. The runbooks run each of these CLIs by path.
  - Three guard forms are in use: `realpathSync`, `pathToFileURL`
    (`session-handoff.mjs`, `decide-registry.mjs`), and the template string.
- **D2 — the ensemble-commit guard is in two runbooks.** designer's
  `critique.md:227` and `refine.md:251` skip `ensemble-commit` when the peer
  never launched, because of the privacy gate or an unavailable companion. In
  the guard's own words, recording a blank result "would fabricate a peer run
  that never happened". founder's runbooks call `ensemble-commit`
  unconditionally, and so do designer's other four ensemble runbooks.
  engineer's call it unconditionally with `|| exit $?`.
  - The guard is not right as it stands either. `peer-runner.mjs` records the
    `pending_ensemble` entry before it resolves the companion
    (`plugins/designer/scripts/peer-runner.mjs:558-560`). When the companion
    is missing, the run fails with `peer_cli_not_found` and the entry stays.
    Skipping `ensemble-commit` then leaves it pending. A privacy skip, which
    never launches the runner, and a failed attempt need different
    transitions.
- **D3 — ADR-0063's pipeline features never left engineer.** By file count in
  engineer: `autopilot-preflight` 10, `finish-verb` 15,
  `awaiting-owner-clear` 6, `awaiting-owner-set` 1, the `decide-conflict` gate
  4. In founder and designer: 0 each.
- **D4 — `session-handoff.mjs` drifted both ways.**
  - founder and designer (ADR-0043 S3/S4, 2026-07-13) render the footer from
    an immutable per-process projection snapshot, and claim the footer render
    by origin (primary or backstop). engineer has neither.
  - engineer (#847, ADR-0063) names a next action for a pending owner gate
    (`awaiting_owner`) and for an interrupted no-changes close. founder and
    designer have neither.
  - Not drift: engineer's `projectionFileForWorkflow` picks the canonical or
    the legacy storage home for the one `last-session-handoff.json` slot; it
    belongs to `legacy_homes`. founder and designer map a blocked archive gate
    to an owner-publish next action because they never commit; that belongs to
    `commit_surface` being off (Decision 3). The slot's file name is a
    contract runtime and attention read, and stays.
- **D5 — the Codex hook helpers live in two places.** See founder against
  designer above.
- **D6 — a dangling reference.** founder's and designer's
  `_shared/references/session-handoff.md:8` cite
  `entry-routing-contract.md § Session-Level Continue-vs-Fresh Preflight`, a
  file neither plugin ships. A standalone install cannot resolve it.
- **D7 — `discover-runtime.mjs` evolved in parallel.** founder's and
  designer's resolver takes the capability file as a parameter (ADR-0043 §2).
  Its second consumer, the ADR-0040 §5 peer-run notification, was removed by
  ADR-0064, so the footer is the only value left. engineer's resolver is fixed
  to the footer.

### Forces

- **No runtime import across plugins** (ADR-0010 §5). Each plugin carries its
  own copy and runs alone.
- **Standalone install.** Each persona installs alone from either marketplace.
  Claude Code installs the plugin directory as committed. Codex installs it
  from the release commit its catalog pins (ADR-0061). Neither host runs a
  build step, so whatever a plugin runs must be committed inside its
  directory.
- **Release routing** (ADR-0016). A commit is routed to every package whose
  path it touches.
- **engineer is in live use.** It is the orchestrator's dispatch target
  (ADR-0019) and the autopilot's subject (ADR-0063). The macro that writes this
  ADR is driven through it.

## Decision

### Decision 1 — One canonical source, at the repository root

The persona pipeline has one source: a new root directory,
`persona-pipeline/`. It sits outside every `release-please-config.json`
package path, so it is exempt from release routing like `kit/` and `scripts/`
(ADR-0016 §Exemption). Nothing in it is loaded at runtime. It is source, and
each persona plugin receives its own generated copy (Decision 4).

| Kind | Canonical unit | What the plugin receives |
|---|---|---|
| Scripts and `scripts/lib/` | whole file | a copy: the canonical file plus the generated notice, the same bytes in every persona |
| Hook adapters for both hosts, and `hooks/hooks.json` | whole file | a copy, as above |
| Pipeline blocks of the command runbooks — their bash blocks and the pipeline prose around them | block | a generated region, rendered from the persona's declaration |
| Shared protocol references (`ensemble-protocol.md`, `session-handoff.md`, `orchestration.md`, `presentation-protocol.md`, `entry-routing-contract.md`) | block; every one of them names its persona or carries persona text (`entry-routing-contract.md` names engineer 32 times) | generated regions, or a whole file rendered from the declaration when no persona prose is left |
| Pipeline paragraphs inside `SKILL.md` | block | a generated region |
| Capability modules (Decision 3) | whole file or block | generated only into personas that declare the capability |

`persona-pipeline/manifest.json` lists every canonical unit and, for each
stage, the personas it is generated into (the enrollment matrix). It also
records the generated paths the pipeline owns. The generator, the drift check
and the parametrized tests all read it.

The canonical scripts are persona-neutral. They read the persona's identity
and data from the persona's own declaration (Decision 2). Code is never
templated: every persona runs the same bytes.

`scripts/lib/args-file.mjs` is not a canonical unit. Five packages carry it,
orchestrator and runtime among them, and
`tests/plugin-shape/test-args-file-transport.mjs` already holds the five
copies byte-equal. It keeps that check and gets no header.

### Decision 2 — Persona content is declared, in the persona's own plugin

Each persona declares itself in `plugins/<persona>/persona.json`, plain JSON
validated against `persona-pipeline/persona.schema.json`. The scripts read it
at runtime from their own plugin, which is a read inside one plugin and not a
cross-plugin import. It holds data only:

- **Identity:** the persona name. The state directory, the peer-run
  self-sensor source, the re-injection marker and the command prefix are
  derived from it. The deliverable noun used in user-facing messages.
- **Profiles:** the L4 profiles, and each verb's default profile and
  original-request placeholder.
- **Decide:** the in-code fallback preset, which must equal the registry's
  preset of that name and is checked; the size-to-preset map; the L4
  profile-to-preset map, where absent means the ADR-0027 §1.5(3) slot stays
  reserved; and an optional tie-break axis.
- **Artifact templates per verb:** the artifact description in the phase-note
  template, the rationale gate, the evidence pointers, the default next
  action.
- **Peer policy:** the privacy gate, and whether images may go to the peer.
- **Runtime footer floor:** the oldest runtime whose footer the persona
  accepts (today engineer `0.63.0`, founder and designer `0.79.0`). No stage
  of this ADR raises engineer's floor. A missing or older runtime keeps
  degrading to no footer.
- **Verb parameters** that change how a pipeline block behaves, e.g.
  `verbs.refine.terminal_requires_convergence`.
- **Capabilities** (Decision 3).

**How the scripts read it.**

- The loader finds `persona.json` relative to its own module
  (`import.meta.url`), never relative to the working directory or a
  repository checkout. An installed plugin has no repository.
- The declaration carries a format version. The loader checks the format
  version and checks that the declared name matches the plugin the file sits
  in.
- When the declaration is missing, malformed or of an unknown format, every
  command that writes state refuses with an error. It never falls back to
  another persona's paths. Hooks stay non-fatal, as they are today (ADR-0011
  §4), and do nothing.
- The tests run a generated plugin directory on its own: copied out of the
  repository, from an unrelated working directory, under a symlinked path and
  a path with a space, `#` and non-ASCII characters.

Authored in the plugin, not declared, and not generated:

- the persona prose of each `SKILL.md`;
- the persona sections of the persona references (`business-brief-*`,
  `design-brief-*`, `cited-brief-*`, `quality-criteria.md`). Their shared
  sections, on peer dispatch, collection, degradation, failure handling and
  workflow bookkeeping, repeat the ensemble protocol. Those sections become
  generated regions, or they are replaced by a pointer to the canonical
  protocol. `output-file-rules.md` (6% apart between founder and designer) is
  a generated region candidate on the same rule;
- `decision-axes.yml`, which stays the axis source of truth (ADR-0027);
- the Codex `agents/openai.yaml` metadata, the host manifests, the README and
  the CHANGELOG.

**Persona-specific steps are extensions.** An extension is authored text in a
runbook or `SKILL.md`, outside every generated region, at an extension point
the canonical skeleton names. An extension adds steps. It never changes a
pipeline block: when a persona needs a block to behave differently, the
canonical block takes a declared parameter. The extensions measured today:

- designer's post-code render and vision re-critique loop (`critique`,
  `refine`);
- designer's `start` call that passes the L4 archetype to the resolver;
- engineer's subagent roster (`adapters/claude/agents/`, 4 files);
- engineer's `audit` alias.

designer's refine convergence gate changes the terminal block, so it becomes
the declared parameter named above, not an extension.

The variation points, measured and mapped:

| # | Variation point | Today | Under this ADR |
|---|---|---|---|
| V1 | Persona identity: name, state directory, self-sensor source, re-injection marker, command prefix | literals throughout every script and hook | `name`; the rest derived |
| V2 | Deliverable noun in messages | `session-handoff.mjs`: "business deliverable" / "design deliverable" | `deliverable_noun` |
| V3 | Decision axes and presets | `decision-axes.yml` (E 132, F 111, D 217 lines) | authored, unchanged |
| V4 | In-code fallback preset | `DEFAULT_FALLBACK`: E `default` (5 axes), F `default` (6), D `balanced` (7) | `decide.fallback`, checked against V3 |
| V5 | Size-to-preset map | E compact / default / nine-axis; F compact / default / default; D balanced ×3 | `decide.size_presets` |
| V6 | L4 profile-to-preset map | designer only (`PROFILE_PRESET_MAP` and the code that applies it) | `decide.profile_presets`, with the `profile_presets` capability |
| V7 | Veto-gate flag on an axis | founder and designer accept `gate`; engineer does not | pipeline: always accepted |
| V8 | Tie-break order | engineer hard-codes `practical-fit` first | `decide.tie_break` |
| V9 | Profiles, default profile and placeholder per verb | literals inside runbook bash blocks | `profiles`, `verbs.<verb>.*` |
| V10 | Artifact template per verb | literals inside the phase-note template and next-action strings | `verbs.<verb>.*` |
| V11 | Peer policy | privacy gate (mentioned in E 4, F 21, D 23 files); designer's no-image rule | `peer.*` |
| V12 | Refine terminal behavior | designer writes the terminal marker only on convergence | `verbs.refine.terminal_requires_convergence` |
| V13 | Persona-specific steps | the four extensions above | extensions |
| V14 | Machinery only some personas have | engineer: dispatch linkage, commit surface, legacy homes | capabilities (Decision 3) |
| V15 | Skills prose | `SKILL.md`, 6% to 70% apart | authored; pipeline paragraphs become generated regions |
| V16 | Codex skill metadata | `agents/openai.yaml`, 2 to 6 lines apart | authored |
| V17 | ADR citations in shared code | 76 F~D lines of persona-ADR section numbers | the canonical text cites this ADR and the capability |
| V18 | Runtime footer floor | `MIN_RUNTIME_VERSION`: E `0.63.0`, F and D `0.79.0` | `runtime_footer_floor` |

### Decision 3 — Capabilities replace trims

When personas legitimately differ in machinery, the difference is a declared
capability, not a trimmed copy. The canonical source carries the code once, and
the declaration switches it on.

**A capability that is off behaves as today's trimmed copy, on every surface:**

- **CLI.** Its subcommands and flags are refused (no `--parent-workflow`, no
  `detach-archive`).
- **Readers.** Frontmatter keys the capability owns stay opaque data,
  carried through by the forward-compat carrier as founder and designer do
  today for the parent-linkage keys. One global known-key table must not
  start validating or acting on them.
- **Imports.** Shared code never imports a capability module statically. A
  module that is not generated into a persona cannot be reached from its code.
- **Hooks.** Nothing beyond what today's copy does: no parent write-back, no
  legacy-home read, no commit.
- **Environment.** Variables that switch a capability are ignored when it is
  off (see autopilot below).

Negative tests prove each of these for every off setting. The schema check
rejects combinations the code does not support, such as `profile_presets` on
without a `decide.profile_presets` map.

| Capability | What it covers | engineer | founder | designer |
|---|---|---|---|---|
| `dispatch_target` | ADR-0019 parent linkage, `parent-writeback.mjs`, `detach-archive`, `autopilot-mode.md` | on | off (ADR-0036 Non-Goal 3) | off (ADR-0042 Non-Goal 2) |
| `commit_surface` | `phase7-commit.mjs`, `/commit`, the commit phase of `start`; when off, the owner-publish next action for a blocked archive gate | on | off (owner publishes; ADR-0036 SD5) | off |
| `legacy_homes` | the ADR-0025 legacy dual-home readers | on | off | off |
| `profile_presets` | decide §1.5(3) profile-to-preset resolution, and `start` passing the archetype to it | off | off | on |

Every other machinery difference measured above is pipeline and reaches every
persona:

- **`finish-verb` and the closed-enum next step.** When `commit_surface` is
  off, kind `commit` means the owner publishes the deliverable: its
  `next_command` is the owner's action, and nothing runs it. Kind `done`
  closes as these personas close today: `summary-complete` and the terminal
  marker, archived once HEAD moves past the baseline.
- **The owner gates** (`awaiting-owner-*`, `decide-conflict`), with every path
  that enforces them (Decision 9, Stage 2).
- **`autopilot-preflight`.** Interactively it shows a pending owner gate. Its
  autopilot behavior turns on only when `AGENTIC_AUTOPILOT` names a run and
  the persona has `dispatch_target` on and runs on Claude. On any other
  persona an inherited `AGENTIC_AUTOPILOT` is ignored, with one line saying
  so, and the verb runs interactively. Otherwise an inherited value would
  suppress the terminal write and leave the workflow waiting for a
  `/commit` that persona does not have.
- **Ensemble settlement** (D2), with three transitions instead of a guard on
  shell variables:
  - never launched (the privacy gate or local-only): no runner and no pending
    entry, so `ensemble-commit` does not run, and the phase note records the
    skip;
  - launched but failed (for example `peer_cli_not_found`): the pending entry
    is settled by `ensemble-commit` with a `failed` verdict that records the
    ledger's `error_kind`, never a peer verdict (the verdict is a free string
    today);
  - completed: as today.

  The runbook decides between them from the runner's ledger result, not from
  whether `RUN_ID` is set. State writes keep `|| exit $?`.
- **The canonical-path entry guard on every CLI** (D1).
- **One Codex hook-helper module** in `scripts/lib/`, imported by both
  adapters, so neither adapter reaches into the other (D5).
- **Both lines of the `session-handoff.mjs` improvements** (D4).
- **`presentation-protocol.md` and `entry-routing-contract.md`**, which also
  resolves D6. Both are engineer's today. `entry-routing-contract.md` sends
  `commit` and `done` to `/engineer:commit` and lists engineer's decide
  presets, and `presentation-protocol.md` points at `autopilot-mode.md`. Their
  persona text and capability text become generated regions rendered per
  persona before any persona other than engineer receives them.

This ADR gives no persona a capability it lacks today; designer's
`profile_presets` is what designer already does. Making founder or designer an
orchestrator dispatch target is a declaration change plus the ADR its
Non-Goal asks for.

### Decision 4 — Distribution by generation, with a drift check

`scripts/sync-persona-pipeline.mjs` follows the `sync-companion-bundles.mjs`
shape. Without arguments it checks, and with `--write` it writes; the npm
script is `sync:persona-pipeline`.

- **Generated files** carry a notice that names the canonical path, says the
  file is generated and edited in `persona-pipeline/`, and gives the write
  command, `npm run sync:persona-pipeline -- --write`. The notice carries no
  version or hash, so regenerating an unchanged source changes nothing. Where
  it goes depends on the format: in a script, after the shebang; in Markdown,
  after the frontmatter; JSON carries none, and the manifest records its
  provenance. Executable modes are kept.
- **Generated regions** sit between `<!-- pipeline:begin <id> -->` and
  `<!-- pipeline:end <id> -->`. Extension points are
  `<!-- pipeline:extension <id> -->`. The grammar is strict:
  - a marker stands on its own line, outside any code fence, and marker-like
    text inside a fence is not a marker;
  - each begin has exactly one matching end, and regions never nest;
  - an id appears once per file;
  - extension points sit only where the manifest declares them, with the
    number of extensions each slot allows.
- **Rendering** substitutes declared fields and includes or omits whole blocks
  by capability. Templates hold no other logic.
  - Every substitution has a declared context. A value that lands in a shell
    block is emitted as a single-quoted literal with its quotes escaped, or is
    passed through an args file. It is never spliced into shell text where
    `$()`, backticks or a newline could change what runs.

    *Note 2026-10-10:* this covers the values the generator substitutes:
    declared fields, escaped once by the renderer. It does not cover text an
    agent fills into a template's placeholder when it runs the block, such as
    a phase note, a summary, a next action, an owner's resolution or a
    request. No renderer sees that text, so no escaping can protect it.
    [ADR-0059's amendment of 2026-10-10](0059-runbook-argument-transport.md#amendment-2026-10-10--text-an-agent-authors-reaches-the-cli-as-a-file-item-j)
    decides that it reaches the CLI as a file the agent writes with its
    file-writing tool (`--<name>-file`). The CLIs read that file from the
    amendment's change on; the persona runbooks and pipeline regions still
    splice the text until a later change moves them to it. A declared value
    that the agent would edit into prose belongs in a Markdown scaffold for
    that file, not in a shell context.
  - An unresolved placeholder fails the render.
  - Tests render values with quotes, `$()`, backticks, newlines and
    non-ASCII characters, and check them without running them.
- **Owned outputs.** The manifest lists every path the pipeline owns. When a
  capability is turned off or a destination is renamed, the check reports the
  owned file left behind. The write mode removes only owned files and refuses
  when ownership is unclear. It never touches authored content.

The check fails when:

1. a generated file or region differs from what the canonical source renders
   for that persona;
2. a runbook or `SKILL.md` lacks a required region, or holds the regions out
   of the canonical order;
3. a region or extension id is unknown to the manifest, or the region grammar
   is broken;
4. an owned output exists that the manifest no longer generates;
5. a declaration fails its schema, or its decide fallback differs from its
   registry;
6. the personas found differ from the personas the manifest names. This is
   checked by identity, not by count.

On any failure the write mode leaves authored text as it was.

The check guarantees mechanical structure only. It cannot tell whether
authored prose around an intact region tells an agent to skip or repeat that
region. That is a review matter, and so are the semantics of extensions.

It runs in `validate.yml` with the other non-test checks (ADR-0033). PC1's
acceptance is a test showing that it fails on a hand edit to a generated file
and to a generated region. The region engine is proven on fixtures in Stage 1.
Production runbooks gain regions in Stage 2.

ADR-0010 §5 holds. Every plugin carries its own complete copy, nothing is
imported across plugins at runtime, and each plugin installs and runs alone on
both hosts. The copies are committed because neither host builds a plugin at
install.

### Decision 5 — One test suite, parametrized over personas

`tests/persona-pipeline/` tests each canonical unit once for every persona the
manifest's enrollment matrix generates it into, at the current stage. It
asserts that the personas it finds are the manifest's personas.

- **Capability tests** run for the personas that turn the capability on.
  Negative tests run for the personas that leave it off (Decision 3).
- **Persona-content tests** stay in `tests/<persona>/`: decide presets, axes,
  profile maps, the persona references. A test that only restates a
  declaration becomes a data-driven case.
- **The mirrored founder and designer suites** move module by module as each
  module joins the canonical source (Inventory 4), so they collapse into one.
- **engineer's suite** (36 files) checks every capability-on path. It moves
  in Stage 3.
- **Contracts stay tested.** Drift equality replaces only the assertions that
  check one copy against another. If the canonical template lost the privacy
  gate or wrote the terminal marker before collecting the peer, every
  generated copy would still match. The assertions that check ordering, the
  privacy and no-image rules, failure propagation, owner-gate resolution and
  convergence therefore stay, and run against the canonical template and the
  generated output. The existing autopilot runbook tests are of this kind. A
  mutation acceptance case puts a defect in a canonical template, regenerates
  it into every target, and expects a contract test to fail.
- **Same-stage updates.** Tests that pin a physical trim become behavioral.
  "designer never imports `parent-writeback.mjs`" becomes "designer never
  writes parent linkage, and its parent keys stay opaque". Fixtures,
  plugin-shape checks and mutation specs whose subject moves (e.g.
  `scripts/mutation-specs/off-branch-archive.mjs`) change in the same stage
  that moves the subject.
- **Text checks.** The prose pins outside generated regions stay with C1–C3,
  whose sizing follows PC1.

### Decision 6 — engineer joins, in the order the measurement sets

engineer runs the same pipeline, so it joins the canonical source. Its files
fall into three measured classes:

1. **Identical, or different only in comments, data or the drift fix itself.**
   - Identical: `hooks.json` (both), `run-node-hook.sh`, the Codex hooks
     README, the Claude `_shared.mjs`, `pre-compact.mjs` (both hosts),
     `yaml-mini.mjs`, `decide-sensitivity.mjs`. (`args-file.mjs` is identical
     too, but it stays outside the canonical source; see Decision 1.)
   - Comments only: the stop and session-start hooks of both hosts,
     `validate-commit.mjs`, `decide-args.mjs`, `decide-weights.mjs`.
   - Data or the fix: `decide-scores.mjs` (the hard-coded tie-break, V8),
     `decide-registry.mjs` (V4, V5, V7), `dispatch-peer.mjs` (D1, which
     engineer already has).
2. **Diverged by capability and by drift in both directions.**
   - `state.mjs`, `session-handoff.mjs`, `stop-archive.mjs` (126 of its 159
     diff lines are dispatch linkage), `discover-runtime.mjs`, and
     `peer-runner.mjs` (32 of 37 are legacy homes).
   - All of engineer's runbooks.
3. **Capability modules.** `parent-writeback.mjs`, `phase7-commit.mjs`,
   `start-args.mjs`, the `commit` runbook.

Class 1 is generated for engineer in the first stage, together with founder
and designer. Classes 2 and 3 converge in the third stage, after the canonical
code has gained the ADR-0063 features in the second stage. engineer does not
join all at once because class 2 is the machinery the orchestrator and the
autopilot drive. Moving it means the canonical code must carry every
capability-on path engineer's suite checks, which is the largest single piece
of this ADR. Leaving engineer out indefinitely is rejected: a hand copy beside
a generated one is the defect this ADR removes, and D1 and D4 are exactly that
defect.

The `orchestrator` plugin carries its own copies of some of the same modules.
`peer-runner.mjs` and `discover-runtime.mjs` are 44 and 16 diff lines from
engineer's, but its `state.mjs` is a different state machine. orchestrator is
an L2 capability, not a persona, and stays out of this ADR's scope.

### Decision 7 — State schema alignment

- **One schema version.** The canonical `state.mjs` has one schema version for
  every persona. founder and designer move from emitting `1.3` to emitting
  `1.4` when they receive the ADR-0063 features (Stage 2). The keys a
  capability adds stay optional, and only a persona with the capability on
  writes them.
- **No migration of existing files.** This is measured, not assumed
  (Inventory 5): every reader accepts any `1.x`, mutation helpers keep a file
  at the schema it has on disk, and the `1.4` keys are validated per key, so a
  `1.3` file may carry them. The five persona workflow files on the owner's
  machine keep working as they are. A new file is written at `1.4`.
- **Older readers: the bytes survive, the behavior does not.** An older
  installed founder or designer meeting a `1.4` file keeps the new keys in its
  forward-compat carrier, as the check in Inventory 5 confirmed. It does not
  act on them.
  - Its archive evaluator ignores `awaiting_owner_*`. The cross-host review
    reproduced it in memory: with a terminal marker and HEAD moved, the old
    evaluator archived, and engineer's gate-aware evaluator refused with
    `awaiting_owner`.
  - An older writer leaves `next_step_*` untouched, so after it runs those
    keys can be stale. The next new verb's Phase 0 clears them, as engineer's
    `--clear-next-step` already does.
- **Mixed versions are not supported on an active gated workflow.** While a
  founder or designer workflow carries an owner gate, every host that touches
  it must run a Stage 2 or later version. A Codex install follows its
  release pin (ADR-0061), so the Stage 2 release reaches both hosts through
  the ordinary release and pin. Recovery goes forward only, by a fixing
  release, never by moving a pin back (ADR-0061). A compatibility test drives
  the previous released founder code against a `1.4` gated file and records
  what it does.
- **A breaking change** to the shared schema follows the versioning policy.
  It is MAJOR, and it is MAJOR for every persona that receives it.

### Decision 8 — Release and versioning

- **Versions stay independent.** Each persona stays its own release-please
  package, with its own version, changelog and catalog entries. No lockstep is
  introduced.
- **A pipeline change releases every persona whose generated files it
  changes**, each with the same changelog entry. A persona-content change
  releases only that persona.
- **Commit splitting** (ADR-0016) is unchanged: one commit per package, each
  staging its own generated copies. The `persona-pipeline/` source, which is
  exempt, rides with the first. The pull request lands with a rebase merge so
  the per-package commits survive (AGENTS.md §Merge hygiene). The drift check
  holds at the head CI runs on. A commit in the middle of the stack may fail
  it, and nothing builds from those commits.
- **Commit types per stage.**
  - Stage 1 is `fix` for all three.
    - founder and designer get D1.
    - engineer gets the D1 repair in `peer-runner.mjs` and
      `phase7-commit.mjs`. Those files stay hand copies until Stage 3, but the
      repair does not wait.
    - engineer's class 1 files also start reading `persona.json`, and its
      registry starts accepting the optional `gate` key. engineer's reader
      checks only top-level keys today, so its own registry behaves the same.
    - A `refactor` would not release, and the Codex install would stay on the
      older pin.
  - Stage 2 is `feat` for founder and designer (the ADR-0063 features, schema
    `1.4`), with D2 as a `fix`.
  - Stage 3 is `fix` or `feat` for engineer (D4, D7), and for whatever reaches
    founder and designer through it.
- **Codex.** Every release advances the Codex pin as usual (ADR-0061).
  Nothing about pins changes.

### Decision 9 — Implementation in three stages

Each stage lands alone, with npm test, `lint:plugin-shape`, the validators and
the drift check green.

1. **Stage 1 — scripts and hooks.**
   - Create `persona-pipeline/` with the scripts and hooks founder and
     designer share (Inventory 1), made persona-neutral, with the manifest and
     its enrollment matrix.
   - Add the declaration schema and loader (Decision 2), and the founder and
     designer declarations.
   - Add the generator and drift check, with the region engine proven on
     fixtures.
   - Add the parametrized suite for these modules, including the
     generated-plugin isolation tests and the off-capability negative tests.
   - Fix D1 on every CLI (engineer's hand copies included; Decision 8) and D5.
   - Generate engineer's class 1 files, with engineer's declaration limited to
     what they read.
   - Expected size: about 10.5k canonical lines replace two copies, and about
     8k mirrored test lines collapse into one suite.
2. **Stage 2 — runbooks, shared references and the ADR-0063 features, for
   founder and designer.**
   - Write the pipeline blocks, and put generated regions into the production
     runbooks, `SKILL.md` files and references, including the shared sections
     of the brief references (Decision 2).
   - Port the owner gates whole, before any founder or designer command can
     set one:
     - parsing and atomic set and clear;
     - archive refusal both on Stop and in the off-branch sweep (engineer's
       `stop-archive.mjs:88` and `:325`; founder and designer have neither);
     - Phase 0 next-step invalidation, and the runbooks that resolve a gate;
     - the handoff's next action for a pending gate (D4).
   - Port `finish-verb` and `autopilot-preflight` with the activation rule of
     Decision 3, so founder and designer emit schema `1.4`.
   - Replace the ensemble guard with the three settlement transitions in every
     ensemble runbook (D2, Decision 3).
   - Ship `presentation-protocol.md` and `entry-routing-contract.md`,
     rendered per persona (D6).
   - Add the mixed-version compatibility test (Decision 7).
3. **Stage 3 — engineer converges.**
   - Make the capability modules canonical.
   - Merge both lines of `session-handoff.mjs` (D4) and of
     `discover-runtime.mjs` (D7).
   - Generate engineer's class 2 and 3 files and runbooks, and move engineer's
     suite into the parametrized suite.

PC1, as planned, implements Stage 1 only, and then stops so that the owner can
re-plan Stages 2 and 3 into the macro. PC1's own topic asks for exactly that
stop.

### Decision 10 — What this changes in earlier ADRs

- **ADR-0036 Sub-decision 7 and ADR-0042 Sub-decision 7 are superseded.**
  Both decided that the persona copies and trims engineer's machinery by hand.
  That is no longer operatively accurate: the copy is generated from
  `persona-pipeline/`, and a trim is a capability that is off. Their
  Non-Goals stand, including that neither persona is an orchestrator dispatch
  target. ADR-0036 SD7 left the extraction to "its own fresh ADR evaluated
  against §6 trigger 1". This is that ADR, and it decides on a shared source,
  not an L1 plugin.
- **ADR-0010 is amended, not superseded.** Its §1 table and §6 trigger 1
  sketch a shared workflow runtime as a future L1 plugin. Sharing at the source
  level creates no plugin and no runtime dependency, so §6 does not fire, and
  §5 holds.
- **ADR-0029's copy-not-import rule holds as written.** The copy is now
  generated.

## Amendment cascade (apply verbatim on acceptance; applied 2026-10-05)

`<date>` is the acceptance date.

**1. ADR-0036 — Status** (replaces the "Proposed to be superseded" line this
ADR's change added; the rest of the Status section stays):

```markdown
**Superseded by [ADR-0066](0066-persona-pipeline-canonical-source.md)** (<date>) —
Sub-decision 7 only. founder's workflow machinery is generated from
`persona-pipeline/`, not copied and trimmed by hand from engineer; what
Sub-decision 7 trimmed is a capability founder declares off. The Non-Goals,
including Non-Goal 3 (no orchestrator→founder dispatch), stand.
```

**2. ADR-0042 — Status** (replaces the "Proposed to be superseded" line):

```markdown
**Superseded by [ADR-0066](0066-persona-pipeline-canonical-source.md)** (<date>) —
Sub-decision 7 only. designer's workflow machinery is generated from
`persona-pipeline/`, not copied and trimmed by hand; what Sub-decision 7
trimmed is a capability designer declares off. The Non-Goals, including
Non-Goal 2 (no orchestrator→designer dispatch), stand.
```

**3. ADR-0010 — a new entry at the end of §Amendments:**

```markdown
### <date> — the persona pipeline is shared at the source (per ADR-0066)

The persona plugins' workflow machinery (scripts, hooks, the pipeline blocks of
the runbooks, the shared protocol references) has one canonical source,
`persona-pipeline/` at the repository root, generated into each persona plugin
with a drift check. This is not the L1 workflow runtime the §1 table sketches:
it is a source shared at authoring time, so no plugin is added, §6 trigger 1
does not fire, and §5 holds — each plugin carries its own complete copy and
nothing is imported across plugins at runtime.
```

**4. README index:** row 0066 becomes `Accepted`. Rows 0036 and 0042 gain
`Superseded by [ADR-0066](0066-persona-pipeline-canonical-source.md) —
Sub-decision 7 only`.

## Consequences

**Positive**

- A pipeline fix is made once and reaches every persona. A fix like #812 can
  no longer stop at one plugin, because the drift check fails until every
  generated copy matches.
- The variation points are named and declared (V1–V18), so a persona's
  difference is visible in one file instead of being spread as edits through
  ten runbooks and twenty scripts.
- founder and designer receive the drifted fixes (D1, D2, D6) and engineer's
  ADR-0063 features. engineer receives founder's and designer's ADR-0043
  improvements (D4). The D2 guard becomes a settlement that also clears a
  failed attempt's pending entry.
- About 8k mirrored test lines collapse into one parametrized suite.
- A fourth persona starts from a declaration and its persona content, not
  from a copy of ~10k lines.
- Each plugin still installs and runs alone on both hosts.

**Negative**

- A pipeline change releases every persona it touches. Commits split per
  package and land with a rebase merge. Middle commits of the stack may fail
  the drift check.
- Runbooks and some `SKILL.md` files carry region markers, which an agent
  reading the runbook also reads.
- The generator, the declaration schema and loader, the region grammar and
  the off-capability rules are new code and new tests to maintain.
- The scripts gain a runtime read of `persona.json`. A broken declaration
  stops every state write of that persona, by design.
- The drift check proves structure, not meaning. Contract tests and review
  still carry the pipeline's correctness.
- Older founder and designer installs ignore owner gates. Mixed versions on a
  gated workflow are unsupported (Decision 7).
- Until Stage 3, engineer's class 2 files stay a hand copy next to the
  canonical source. A pipeline fix in that window is made twice, as it is
  today.
- Three stages, each a release of two or three packages.

**Neutral**

- Shared scripts read the persona from data, not literals. The state
  directory, self-sensor source and re-injection marker keep their current
  values.
- founder and designer emit schema `1.4`. Existing `1.3` files are not
  rewritten.
- The orchestrator's copies of shared modules are out of scope.

## Alternatives Considered

**A. Keep the copies; add a parity test and parametrize the tests.** This was
E1's local recommendation, option (b): one parametrized suite, a
normalized-equality check between founder's and designer's shared scripts, and
a port of #812's guard. It removes the mirrored tests, but authoring stays
twofold. The parity check detects drift after someone has edited both copies;
it does not prevent it. The runbooks, where D2 and D3 live, are outside it.
The owner rejected hand copying.

**B. Generate designer from founder.** E1's option (c), modelled on
`sync:companions`. One persona becomes the source of another, so persona
content (decide data, deliverable noun, artifact templates) must be patched
after copying or hidden in the source persona. The variation points stay
implicit, and engineer stays outside.

**C. Make one persona, engineer, the canonical source.** engineer's code
carries its own persona data (V4, V5, V8) and capabilities that two of three
personas must not run. A persona-neutral source with declared data makes the
same code serve all three. Taking one persona as the source would make that
persona's content the default for the others.

**D. An L1 plugin that the personas import or call.** An import breaks ADR-0010
§5 and SemVer independence. A subprocess call to an installed L1 plugin keeps
§5 but breaks standalone install: a persona would not run without the L1
plugin at a compatible version, on both hosts, under ADR-0061 pins.
`plugins/runtime` deliberately did not absorb this machinery (ADR-0036 SD7).

**E. A package or build step that assembles each plugin at install.** Neither
host runs a build when it installs a plugin. Claude Code serves the directory
as committed, and Codex installs the pinned release commit. The built output
would have to be committed anyway, which is generation with an extra
toolchain.

**F. Whole-file templates for the runbooks, filled from persona fragment
files.** This enforces the skeleton by construction. But it splits each
runbook's persona prose into fragments that are read apart from their
context. founder's and designer's runbooks are 8% to 46% apart by word, and
most of that sits outside the bash blocks, which differ by 2 to 44 lines.
Generated regions in authored files keep the prose where it is read and
edited, and the drift check enforces the skeleton through region order.

**G. engineer joins all at once, in Stage 1.** This would move the machinery
the live macro runs on together with the founder and designer change, in one
slice. Measured, class 2 is the bulk of the work and the part with the most
risk, and Stage 1 does not need it.

**H. engineer converges later, without a stage in this ADR.** Rejected under
Decision 6: the hand copy that remains is where D1 and D4 happened.

## References

- E1 decision and owner selection: `decide-20261005T015832Z-7931cf`; macro
  `macro-plan-20261003T022443Z-139657`, subtasks PC0 and PC1.
- [ADR-0008](0008-companion-distribution-model.md) §(d) — the
  `sync-companion-bundles.mjs` precedent: a canonical source, byte-identical
  bundles, a drift detector by default.
- [ADR-0010](0010-plugin-boundary-policy.md) §1, §5, §6 — layers, no
  cross-plugin import, separation triggers.
- [ADR-0016](0016-cross-package-commit-splitting.md) — release routing and
  commit splitting.
- [ADR-0019](0019-cross-plugin-invocation-contract.md) — orchestrator →
  engineer dispatch, the `dispatch_target` capability.
- [ADR-0025](0025-workflow-storage-migration.md) — the legacy homes behind
  `legacy_homes`.
- [ADR-0027](0027-decide-skill-multi-axis-evolution.md) — the decide registry
  and §1.5 resolution order.
- [ADR-0028](0028-engineer-phase7-commit-automation.md) — Phase 7, schema
  1.2/1.3 and forward-compat reading.
- [ADR-0029](0029-entry-routing-contract-enforcement.md) — copy, not import.
- [ADR-0033](0033-ci-full-test-suite-coverage.md) — `validate.yml` as the
  home of non-test checks.
- [ADR-0036](0036-founder-persona-business-planning.md) SD5, SD7, Non-Goal 3
  and [ADR-0042](0042-designer-persona-design-ux-workbench.md) SD6, SD7,
  Non-Goal 2.
- [ADR-0043](0043-founder-designer-footer-enablement.md) — the founder and
  designer session-handoff line (D4).
- [ADR-0056](0056-assurance-matcher-removal.md) §Decision 9 — supersession
  atomic with acceptance.
- [ADR-0061](0061-codex-installs-pinned-to-release-commits.md) — Codex
  installs from pinned release commits.
- [ADR-0063](0063-autopilot-fresh-session-driver.md) D3, D4, D6 — `finish-verb`,
  the autopilot preflight, schema 1.4.
- #812 (`4b5ad750`) — the canonical-path CLI entry guard.
