# persona-pipeline — the one source of the persona plugins' shared machinery

The persona plugins (`engineer`, `founder`, `designer`) run one workflow
pipeline. Its scripts and hooks have one canonical source, here, and each
persona plugin carries a generated copy (ADR-0066). Nothing in this directory
is loaded at runtime: Claude Code and Codex install a plugin directory as
committed, so every plugin keeps its own complete copy and runs alone
(ADR-0010 §5).

## What is here

| Path | What it is |
|---|---|
| `manifest.json` | Every canonical unit, its destination inside a plugin, and the personas it is generated into (the enrollment matrix). Also the region and extension-slot declarations. |
| `files/<plugin path>` | The canonical files. Each is copied whole into every enrolled persona, with a generated-file notice; its git mode is the generated mode. |
| `regions/<block>.md` | The canonical region templates: a block of a runbook, a skill or a reference, rendered into each enrolled persona's authored file between its region markers. The `skill-*` templates render into `SKILL.md`; the reference templates are named for their file (`routing-*`, `presentation-*`, `handoff-*`, `output-rules-*`, `ensemble-*`, `brief-ensemble-*`, `brief-spec-*`, `orchestration-*`). |
| `persona.schema.json` | The schema of `plugins/<persona>/persona.json`, each persona's declaration of who it is and what differs: name, deliverable noun, runtime footer floor, capabilities, decide data, from format 1.1 its verbs, and from 1.2 its peer permissions (see [The declaration](#the-declaration)). |
| `owned.json` | Generated: every plugin path the pipeline has written, per persona. It is how the write mode knows what it may replace or remove. Do not edit it. |

The canonical scripts are persona-neutral. Each reads its persona from the
plugin's own `persona.json` through `scripts/lib/persona.mjs` when it runs,
never at import. A capability a persona declares off behaves as the trimmed
copy did; a unit that carries only a capability's off path is never enrolled
into a persona that declares it on (`off_only` in the manifest), and a
capability module is enrolled into exactly the personas that declare its
capability on (`on_only`: the check fails it in a persona with the capability
off, and fails a persona with the capability on that does not receive it).

Stage 1 (PC1) covers the scripts and hooks. engineer receives the units it
shares unchanged (the decide libraries and registry, `validate-commit`,
`dispatch-peer`, the hooks, the lib modules); the rest of its scripts
converge in Stage 3 (see below).
`scripts/lib/args-file.mjs` is not a unit: five packages share it, and
`tests/plugin-shape/test-args-file-transport.mjs` keeps them byte-equal.

Stage 2a (PC2a) begins the runbook regions. founder and designer's
`checkpoint`, `resume` and `peer-now` commands hold generated regions: the
plugin-root paragraph and every shell block. Their `compose` and `frame`
(PC2a2b), `investigate` and `decide` (PC2a2c) commands hold the plugin-root
paragraph, every shell block, the phase-note scaffold and the
completion-footer paragraph, rendered from the `verb-*` templates, and
`decide` its Phase 0.5 argument resolution, rendered from
`decide-resolve.md`. The prose around them stays authored.

PC2a3 completes the verb runbooks and begins the skills:

- `critique`, `refine` and `start` hold generated regions too: the
  plugin-root paragraph, the Phase 0, bootstrap and resume blocks (critique
  with its declared profiles; start from `start-bootstrap.md` and
  `start-resume.md`), designer's critique and both personas' refine dispatch,
  start's two lifecycle paragraphs, and in critique and refine a one-line
  finalize heading and the completion-footer paragraph. The settlement work
  (PC2b) generated the blocks whose behavior differed by persona: critique's
  and refine's finalize (`verb-finalize.md`), start's terminal block
  (`start-terminal.md`), and founder's critique dispatch, where the agent
  sets the ensemble type by profile. Where a persona closes refine or start
  only once it converged (`terminal_requires_convergence`), a variant renders
  instead (`verb-finalize-convergent.md`, `start-terminal-convergent.md`):
  the plain template plus a convergence paragraph and a fail-closed check
  around the terminal write, which records the next step without closing
  when the work did not converge. A contract rebuilds each variant from its
  plain template, so the two cannot drift. refine adds a generated Owner
  decision step (`refine-owner-decision.md`, the recurring-finding gate), as
  decide adds its Owner selection (`decide-owner-selection.md`); where refine
  waits for convergence, its variant (`refine-owner-decision-convergent.md`)
  closes a deferral only once the refinement converged and otherwise clears
  the gate with the next step, since a deferred finding does not converge by
  itself. An authored
  block in a file that holds regions opens with the generated resolver,
  copied by hand, since a file uses one resolver form.
- The privacy gate is generated in all seven verb runbooks
  (`verb-privacy-gate.md`: the persona's scope and spec from `peer`, the
  verb's genericize sentence a manifest value) and followed by the no-image
  rule (`verb-privacy-no-image.md`: no image reaches the peer as bytes) for a
  persona whose declaration keeps images from the peer. designer's screenshot
  sentences, with the verified-local file path its peer may read, stay
  authored right after the regions.
- designer's own steps sit in extension slots (see [Extension
  slots](#extension-slots)): critique's dual input, refine's convergence loop
  and its bound, and start's archetype section in the runbooks, and start's
  archetype section in `SKILL.md` as well.
- In `SKILL.md`, the sections founder and designer share line for line
  (checkpoint, peer-now and resume's command resolution and steps, compose's
  presentation and state write, decide's steps and approval gate, frame's
  presentation), start's "When invoked by command" intro, and the privacy
  gate of critique, refine and start are regions, below the frontmatter and
  under an authored heading. Sections that differ by persona prose stay
  authored, designer's render-and-vision loop and archetype text with them.

PC2a4 brings the shared references in. founder and designer now ship their own
`entry-routing-contract.md` and `presentation-protocol.md` under
`core/skills/_shared/references/`, and `session-handoff.md` cites its sibling
contract's § Session-Level Continue-vs-Fresh Preflight rather than engineer's.
Their persona- and capability-neutral sections are regions: the routes, the
proposal's `selected_next` vocabulary and the orchestrator row follow
`commit_surface` and `dispatch_target`, and the lens resolves with the profile
preset where the persona has one. The persona's routes, its
Standards and Root-Cause Gate (one per verb, from the declared
`rationale_gate`), decision sizing, decisive axes and content types stay
authored. The other shared references hold regions on the text founder and
designer share: `session-handoff.md`, `ensemble-protocol.md`,
`orchestration.md` (its intro and failure handling), and in `investigate`'s
references `output-file-rules.md`, the brief ensemble, and the brief spec's
Citation Conventions and Ensemble Label Policy. A region holds whole Markdown
units, a paragraph, a whole list, a table or a fence; a list that holds one
persona line stays authored whole. A region in `entry-routing-contract.md`,
`presentation-protocol.md`, `session-handoff.md`, `output-file-rules.md` or
the brief spec may carry its section's heading, and the brief ensemble's
Failure Handling region its `###` cases; in `ensemble-protocol.md` and
`orchestration.md` every heading stays authored. The
point-type templates, designer's vision sections, the privacy bullets and the
brief spec's Privacy Gate stay authored; designer's ensemble guard and its
authored convergence sentence went in PC2b, replaced by `settle` and the
convergent variants. Every verb skill's Present step cites the persona's own protocol,
and the generated finalize note (compose, frame, investigate, decide) its own
contract. engineer's copies stay hand-written until PC3.

Stage 2b (PC2b) ports engineer's next step and owner gates (ADR-0063) to
founder and designer, through the canonical source:

- **Schema 1.4.** `state.mjs` writes new workflow files at `1.4` and keeps an
  older file's schema; it reads the six 1.4 keys (`next_step_kind`,
  `next_step_verb`, `next_step_confidence`, `awaiting_owner_gate`,
  `awaiting_owner_pointer`, `awaiting_owner_since`) and validates each on its
  own (ADR-0066 Decision 7), so no file is migrated.
- **Owner gates.** `awaiting-owner-set` and `finish-verb --owner-gate` (in
  code, `appendPhase`'s `ownerGate` too) set one gate at a time and turn an
  inherited terminal marker off; `awaiting-owner-clear` records the owner's
  resolution and the next step in one write. A persona can set `scope-routing`, `decide-conflict`
  and `recurring-finding`; `staging-set` needs `commit_surface` and
  `pr-handling` `dispatch_target`, so every setter refuses them here, naming
  the capability. The Stop hook's gate 5 (`awaiting_owner`) keeps a gated
  workflow on its branch, on a kept branch and in the off-branch sweep, and
  the session handoff names the gate's resolving surface. Each path checks
  the gates again on the bytes `archiveWorkflow` reads under the file lock
  (`recheck`), so a gate written after the first read still keeps the
  workflow; engineer receives it with its generated copy in PC3. decide's Owner
  selection and refine's Owner decision are generated steps that clear their
  gate; the routing contract's § Owner gates table lists the settable gates,
  and a contract checks it against `state.mjs`.
- **`finish-verb` and `autopilot-preflight`.** Every verb runbook's Phase 0
  runs `autopilot-preflight` before any write, a resume clears the recorded
  next step (`append --clear-next-step true`), and the last write is
  `finish-verb` with the closed-enum next step (`verb`, `commit`, `done`,
  `owner-decision`): with `commit_surface` off, `commit` means the owner
  publishes, and `commit` and `done` both close `summary-complete`. An owner
  gate makes the write non-terminal. ADR-0066 Decision 3's activation rule
  is the off path: `AGENTIC_AUTOPILOT` turns autopilot behavior on only with
  `dispatch_target` on, on Claude, so here the preflight prints one line saying
  the variable is ignored, and nothing else reads it. The on path arrives with
  engineer in PC3.
- **Settlement.** `peer-runner.mjs settle` replaces the D2 guard: it reads
  the ensemble attempt's run ledger and records nothing for a run that never
  launched, verdict `failed` with the ledger's `error_kind` for one that
  failed, was cancelled or was abandoned, and the synthesis verdict (or
  `degraded` for an empty or unreadable answer; for an answer of structural
  shell the synthesis passes `degraded` itself) for one that completed; it
  refuses while a
  run is live or when an empty run id would hide one. No dispatch detaches
  with a shell `&`: the runner runs in the foreground of a host background
  task.
- **Mixed versions** (Decision 7). A release before PC2b reads a 1.4 file and
  keeps its keys, but its Stop hook archives a gated workflow and its terminal
  write leaves a stale next step: while a workflow carries an owner gate,
  every host that touches it runs the PC2b release or later.
  `tests/persona-pipeline/test-mixed-version.mjs` records what the previous
  founder release does with a gated file.

Stage 3 converges engineer, unit by unit, each green before the next, in two
subtasks: PC3 (what follows) and PC3b (the rest, listed last):

- **Generated for engineer:** `discover-runtime.mjs` (D7: the capability file
  is a parameter and the floor is the declared `runtime_footer_floor`, which
  engineer declares `0.63.0`), `peer-runner.mjs` (with the `legacy_homes`
  on path: the pre-migration `.claude/agentic-<persona>/peer-runs` home, read
  from the home that holds the run, and `settle`), and `state.mjs` (with
  every capability on path: the `legacy_homes` dual-home storage, the
  `dispatch_target` parent linkage, its frontmatter keys, the P10 marker and
  `detach-archive`, autopilot mode on Claude, and the `commit_surface` state,
  `close-complete` in `terminalPhases()` and `beginCommit`), and
  `stop-archive.mjs` (with the `dispatch_target` parent note after a
  successful archive, on the current and on a kept branch, and the
  parent-linked orphan report; engineer gains the gate recheck under the
  file lock, so a refused archive notes nothing on the parent), and
  `session-handoff.mjs` (D4: both lines merged. engineer gains the footer
  render from an immutable per-process snapshot, the delivery-failure and
  stale-projection fail-closed paths, the origin-claimed render with the
  `rendered` tombstone that survives the SessionStart consume, single-lined
  flag values and the unknown-gate fallback beside a known gate; founder and
  designer gain the owner-gate surfaces their capabilities add. With
  `commit_surface` on a blocked gate maps to `blocked` with the commit, or the
  no-changes close for a `close-complete` workflow, as its unblocking action;
  off, to `publish-needed`. With `legacy_homes` on the one-shot slot follows
  the workflow's storage home and the SessionStart backstop reads both
  slots. engineer declares `deliverable_noun`, which the unit requires).
- **Capability modules** (`on_only`): `parent-writeback.mjs`
  (`dispatch_target`), `phase7-commit.mjs` and `start-args.mjs`
  (`commit_surface`). `phase7-commit.mjs` imports `parent-writeback.mjs` only
  when `dispatch_target` is on.
- **engineer's suite, moved so far** (Decision 5): the discover-runtime,
  peer-runner, stop-archive, session-handoff, sidecar, footer and backstop
  cases merged into their parametrized suites with capability-on cases; the
  capability modules' suites (`test-parent-writeback.mjs`,
  `test-phase7-commit.mjs`, `test-commit-surface.mjs`) and the
  capability-on state suites (`test-autopilot-verbs.mjs`,
  `test-state-schema-13.mjs`) run for the personas that declare the
  capability on; the shared ones engineer alone had (`test-checkpoint.mjs`,
  `test-ensemble-results.mjs`, `test-session-start.mjs`,
  `test-state-schema-12.mjs`, `test-state-schema-forward-compat.mjs`,
  `test-validate-commit.mjs`) run for every persona; and engineer's copies of
  the class 1 suites the parametrized suite already ran for it
  (`dispatch-peer`, `yaml-mini`, `decide-args`, `decide-scores`,
  `decide-sensitivity`, `decide-weights`) are gone, as are its
  `test-state-schema-14.mjs`, `test-peer-now.mjs` and `test-resume.mjs`,
  each assertion mapped to a parametrized case or a runbook contract. What
  stays under `tests/engineer/` is persona content (the four decide suites,
  `test-cited-brief.mjs`); `test-start-command.mjs` and
  `test-diagnose-redundancy.mjs` moved with start, and
  `test-verb-runbook-autopilot.mjs` with commit and the verb runs (PC3b,
  below).
  `scripts/mutation-specs/persona-pipeline.mjs` group N puts a defect in a
  canonical capability-on path into every target and expects an engineer
  contract test to fail.
- **engineer's runbooks, joining group by group:** `checkpoint`,
  `peer-now` and `resume` (merges: engineer's stronger paths became the
  templates), then the six verbs (`frame`, `compose`, `decide`, `critique`,
  `refine`, `investigate`). The verb templates branch on the
  capabilities: with `dispatch_target` on, the Phase 0 comment states the
  autopilot rules, the bootstrap passes the orchestrator's parent linkage
  (`PARENT_ARGS`), and the finalize and footer say what an autopilot run does
  (the next step only, no footer, `pr-handling`); with `commit_surface` on,
  `commit` and `done` route to `/<persona>:commit` and the footer maps the
  remaining commit to `blocked`. Each off path renders what founder and
  designer rendered before. engineer's finalize settles the ensemble attempt
  (`peer-runner.mjs settle`) as theirs does. decide's Owner selection and
  refine's Defer, inside a `/<persona>:start` lifecycle, clear the gate and
  stop, leaving the terminal write to the lifecycle; with `commit_surface` on
  the Defer commits with `/<persona>:commit`. critique and investigate pick
  their ensemble type by profile as founder's critique does: the block
  assigns the default profile's type and the prose has the agent set the
  other there; with several investigate profiles both note headings name the
  profile. `compose.md` keeps an authored sentence with the
  `${AGENTIC_ENGINEER_ROOT:-` spelling the orchestrator's autopilot probe
  reads, until that probe accepts the generated resolver.
- **Still hand-maintained, converged in PC3b:** engineer's `commit`
  runbook, its skills other than checkpoint, peer-now and resume, and its
  references (its `start` runbook, its skills, its `commit`, its session
  handoff, its routing contract, its presentation protocol, its
  orchestration framework, its ensemble protocol and its investigate brief
  references joined in PC3b, below). engineer's `audit` is not a pipeline unit: an
  engineer-only alias of `critique --profile=full-codebase` with no shell
  block and no shared text, it stays an authored extension (ADR-0066
  Decision 2's list).

PC3b, so far:

- **An owner gate met inside a `/<persona>:start` lifecycle is resolved
  there** (PC3's step-7 review). decide's Owner selection and refine's Fix
  now and Defer, run inside the lifecycle, clear the gate and stop, so the
  lifecycle runs the fix in its refine phase and makes its one terminal
  write; before, Fix now went on into the refine's own phases, whose finalize
  closed the workflow ahead of the lifecycle's terminal step. Inside the
  lifecycle decide's clear records no next step: the lifecycle owns its phase
  order (compose follows decide in founder's and designer's, an explore phase
  in engineer's), and its resume clears a recorded next step anyway. Every
  clear replaces the gate's `Owner: …` next action in the same write
  (`awaiting-owner-clear --next-action`; `--clear-next-step true` records no
  next step), so a block that stops after the clear leaves no stale
  instruction; so does the clear recipe `autopilot-preflight` prints for a
  pending gate.
- **engineer's `start` runbook joins the start regions** (plugin root,
  Phase 0, bootstrap, resume, initial verb, phase-boundary rules), and its
  Phase 0 gains `autopilot-preflight`, which puts a pending owner gate to the
  user before the lifecycle continues. The templates branch on
  `commit_surface`: on, the bootstrap reads the description and an optional
  `--base-branch` from an args file (`start-args.mjs`), first in a redundancy
  probe block that writes nothing and pauses on a finding for the user's
  proceed or abort (`diagnose-redundancy`, informational), then in the
  bootstrap block, whose dirty-tree refusal adds the categories and the
  worktree and sweep-into-commit resolutions; and the terminal is a region of
  its own, `start-commit.md` (`when` `capabilities.commit_surface` is
  `true`), the Phase 7 driver's plan block, then its execute block with the
  subject the user confirmed; each binds the workflow from `find-active` when
  `ACTIVE` is unset, since a shell variable does not outlive a Bash call.
  engineer's start skill states the same entry order for Codex. engineer declares `verbs.start` with its
  `request_placeholder` and no `terminal_requires_convergence`, which picks a
  `finish-verb` variant its lifecycle does not end with, so it is enrolled in
  neither `start-terminal` variant. For every persona the bootstrap passes
  `ACCEPT_CURRENT_TREE` to the check as a flag (a value set in the block
  without export reached no check before), the resume reads the workflow on
  its own (a failed read stops the block) and refuses any workflow that is
  not a start one, unwritten, with the remedies (engineer's typed conflict,
  now the template), and the phase-boundary rules name the lifecycle's last
  step as its one terminal write. engineer's phase list, its per-phase state
  writes and its entry routing stay authored. The characterization records
  the changes with two more structural operations, `remove-call` and
  `set-guard`, and names a script called without a subcommand by the script
  alone. `tests/engineer/test-start-command.mjs` moved: the blocks are run by
  the start contracts (engineer's commit_surface path too: the probe, the
  bootstrap from a real args file, the Phase 7 plan and execute),
  `evaluateCleanBaseline` to `tests/persona-pipeline/test-clean-baseline.mjs`
  and `diagnose-redundancy` to `test-diagnose-redundancy.mjs` (both
  parametrized), and the text engineer authors around the regions to
  `tests/plugin-shape/test-engineer-start.mjs`.
- **engineer's start, compose, frame and decide skills join their regions.**
  start's "When invoked by command" intro (`skill-start-command-intro.md`)
  now states the Codex entry in the command's order for every persona: the
  guard, `find-active` and `autopilot-preflight` (which only reports a
  pending owner gate) before any write; a start workflow resumes with its next
  step cleared, and only there is a reported gate put to the user and
  cleared; any other is refused unwritten, its gate included; then the
  bootstrap. With `commit_surface` on it adds the args-file intake, the
  redundancy probe, the four clean-baseline resolutions and the Phase 7
  driver as the lifecycle's one terminal write. The check names its accept
  flag (`--accept-current-tree true`), which a Codex run passes, and an
  accepted tree is passed to both Phase 7 modes again (nothing remembers it).
  compose, frame and decide take the shared Present, state-write, steps and
  approval gate regions; with `commit_surface` on compose's state write names
  the code profile's commit-manifest recording as the skill's one workflow
  write, and with `dispatch_target` on the approval gate carries the
  autopilot rule (record the recommendation as the next step; a CONFLICT
  stops at `decide-conflict`). The skill contracts run for engineer in these
  four files, the entry order among them (moved from
  `test-engineer-start.mjs`), and a persona with no peer policy holds no
  privacy region.
- **The verb skills' finish paragraph is one region.** What the invoking
  command's last write records, the footer it prints and the archive timing
  were one fact in three wordings: founder's and designer's Completion
  parenthetical (investigate's in its state write) and engineer's State-write
  paragraph with its Session-level handoff section. `skill-verb-finish.md`
  now closes the Completion section of every persona's compose, frame,
  decide, critique, refine and investigate skill: run by the verb's command,
  `finish-verb` records the closed-enum next step and, unless it ends with an
  owner gate, is terminal; inside `/<persona>:start` no phase makes that
  write; the footer is code-emitted, its completion state `blocked` with the
  commit (`commit_surface` on) or `publish-needed` (off); with `dispatch_target` on autopilot is
  Claude-only and its write prints no footer. Where refine closes only once
  it converged (designer), the variant `skill-verb-finish-convergent.md`
  opens with that rule (not converged, the workflow stays open with no
  footer: the finalize's `append`, or the deferral's `awaiting-owner-clear`,
  unless an owner gate ends it), then repeats the plain template, which a
  contract checks byte for byte; the old text called that write terminal
  too. On a detached HEAD only the branch-based preflight reports "no active
  branch context" and recommends no fresh session; the path-targeted
  terminal sidecar renders the footer as on a branch, continue-vs-fresh
  advice included, and the verb runbooks' footer paragraph
  (`verb-completion-footer.md`) and engineer's start commit say so too (they
  promised no fresh-session advice at all). The owner gates it points to
  are the routing contract's § Owner gates, or with `dispatch_target` on
  `autopilot-mode.md`'s, engineer's table until its references join. engineer's
  skills lose their copies, their citations of a `continuity-protocol.md` no
  plugin holds, and the claim that the terminal sidecar renders nothing on a
  detached HEAD (it is path-targeted and renders); refine's state write names
  its commit-manifest recording as its one workflow write. The skill contract
  checks the paragraph by capability, its citations against the persona's own
  files, its place, and that nothing outside it says the same again.
- **start's last write and its footer are stated once, in the runbook and in
  the skill.** In the runbook, the terminal region now carries the footer
  paragraph: `start-terminal.md` and its convergent variant gain it (with the
  `publish-needed` mapping; designer's unconverged append prints
  no footer), and `start-commit.md` states the same detached-HEAD rule and the
  wiring pointer. founder's and designer's authored paragraph after the region
  is gone (it promised no fresh-session advice on a detached HEAD and named
  ADR-0043 by stage); their own sentences, founder's ADR-0036 save and
  designer's artifact handoff, now open the terminal step. In the skill, a
  `start-finish` region closes the terminal step in three variants chosen as
  the runbook's terminal is: `skill-start-finish.md` (founder: the
  `finish-verb` block, its next action from the declaration as the runbook's,
  and the footer), its convergent variant (designer: the convergence rule, then
  the plain template byte for byte) and `skill-start-finish-commit.md`
  (engineer: the Phase 7 driver as the one terminal write, the footer and the
  archive timing in the plain template's words, byte for byte). engineer's
  skill loses its Phase 7 footer and archive-timing paragraphs and the
  hand-passed completion projection; the projection stays at Phase 0, where its
  detached-HEAD sentence now says the entry's guard stops first. Both texts say
  when the next start bootstraps: a terminal workflow stays on the branch until
  the Stop hook archives it (for founder and designer, once the owner's commit
  moves HEAD), and `/<persona>:start` resumes it until then. The skill block
  keeps its archive-timing annotation, and the skill footer its host-context
  boundary (advisory, pointer-only, never mutating the session). engineer's
  `session-handoff.md` § Boundaries states the detached-HEAD rule as founder's
  and designer's do.
- **The commit surface's runbook and skill are generated.** `/<persona>:commit`
  belongs to `commit_surface` (ADR-0066 Decision 3), so its regions carry
  `when` `capabilities.commit_surface` is `true` and are enrolled exactly where
  a declaration turns it on (engineer); the autopilot block alone is keyed to
  `dispatch_target` (`commit-autopilot`), and the templates' autopilot and
  macro sentences sit in `dispatch_target` blocks, so a persona with the
  commit surface and no dispatch target gets a commit without them. In the
  command (`commit-*.md`): the plugin-root paragraph, Phase 0, the autopilot
  block, the plan, the staging-set clear, the execute block with its archive
  timing, the close and the footer paragraph; the intro and the Completion
  report stay authored. In the skill (`skill-commit-*.md`): the host and
  command-resolution tables and the same five blocks, each the command's with
  `<plugin-root>` and `<claude|codex>` (a contract compares them). Two fixes
  ride along, for engineer: Phase 0 reads the workflow type with the read
  checked on its own (the pipe let a read that failed after printing a type
  reach the commit, as in PC3b's owner blocks), and the staging-set clear
  replaces the gate's `Owner: …` next action (`--next-action`), so a commit
  that fails afterwards leaves no stale instruction. The Codex Phase 0 block
  now runs the command's checks (the guard, the checked read, the `/start`
  refusal) instead of leaving them to the agent. The commit cases of
  `tests/engineer/test-verb-runbook-autopilot.mjs` moved to
  `tests/persona-pipeline/test-commit-runbook.mjs` (every persona with the
  commit surface, committed and assembled documents, bash and zsh), and the
  runbook and skill contracts gained a commit family.
- **The verb runbooks' blocks run for every persona.** The rest of
  `tests/engineer/test-verb-runbook-autopilot.mjs` (Phase 0's preflight, an
  old install, the resume clear, Phase 2, the six finalizes settled from a
  real run ledger, decide's Owner selection and refine's Owner decision) moved
  to `tests/persona-pipeline/test-verb-runbook-runs.mjs`, and the file is
  gone. Each case runs per persona and shell over the committed runbook and
  the one assembled from the templates (skipped where the two are byte-equal),
  with the persona's real scripts, and branches by declaration: under an
  autopilot run, the rules, the refusal at a gate and the non-terminal finish
  with `dispatch_target` on, the run ignored with it off; the deferral's next
  action by `commit_surface`; the convergent refine's open paths where
  `terminal_requires_convergence` is on. The old-install case runs each
  persona's newest release without the preflight, read from the tags.
- **engineer's session handoff joins the handoff regions**, the first of its
  shared references. `handoff-wiring.md` and `handoff-recipe.md` branch on
  all three capabilities: with `commit_surface` the Phase 7 driver is named
  among the writes that emit the footer (its no-changes close emits nothing:
  it archives the workflow itself), and the completion mapping is `blocked`
  with the commit (a close finishes with the commit command again), with no
  `publish-needed`; with `dispatch_target` the parent note follows the
  archive, best effort, skips a no-changes close, is sent by a Phase 7 commit
  first (P10, the Stop's note then a retry), is never written for a deleted
  branch's orphan, and an autopilot `finish-verb` emits nothing; with
  `legacy_homes` the pre-migration slot under `.claude/agentic-<persona>/` is
  named where a legacy-home workflow writes and SessionStart reads it, and the
  rollback removes it whether or not a workflow still lives there (PC3
  step-3 MINOR 7). Which ADR enabled a persona's footer is history, not a
  capability: the wiring names ADR-0039 alone, and each persona's title keeps
  its own provenance. Docket C104: the shared regions no longer compare the
  persona with engineer ("engineer's path-targeted projection", "same as
  engineer's sweep", the privacy contract's "engineer protocol"), and the
  discovery floor names `minRuntimeVersion()`, the declared floor, where it
  named a `MIN_RUNTIME_VERSION` no script has. The recommended next work is
  said to be normalized to one line, as the sidecar does. The reference
  contracts now pin which personas each reference holds regions for and skip
  a contract, with the reason, where a persona does not hold its reference
  yet; for engineer they read its whole corpus (two authored citations
  reworded) and its session handoff, each capability branch checked against
  the generated scripts, every legal capability combination rendered, and no
  shared region naming another persona.
- **engineer's routing contract joins the routing regions**: all twelve,
  with engineer's own firing points, Standards and Root-Cause Gate, decision
  sizing, decisive-axis fallback and review depth authored between them. Its
  stale preflight sentences are gone (detached HEAD as a firing exception
  only of the branch-based preflight, the projection persisted to the
  per-persona slot, archival not only after a commit). The templates gain
  what engineer's text held: with `commit_surface`, `done` runs the commit
  command, which closes without a commit, and the commit command's
  no-changes close archives its own workflow; with `legacy_homes`, the
  pre-migration projection slot. For every persona the floor says
  `confidence` persists as `next_step_confidence` (it listed it among the
  fields with no durable home), the closed-enum heading names ADR-0063 D6's
  amendment of ADR-0029 §3, the Stop hook is the automatic archive, not the
  only one (an owner archives with `resume archive`), and every verb skill's
  finish region cites the routing contract's § Owner gates (engineer's cited
  `autopilot-mode.md`, whose own gate table, already drifting, became a
  pointer plus when each gate is recorded). engineer's verb skills offer
  `done` as their runbooks do, its decide and refine skills name their owner
  gate, and its start skill's routing step is a heading that cites the
  contract; its firing points keep the context-risk trigger, agent-instructed,
  and every persona's Stop-hook backstop bullet names its checked-out-branch
  scope. The routing templates are rendered for every legal capability
  combination.
- **engineer's presentation protocol and orchestration framework join their
  regions.** Under `dispatch_target`, the protocol's offer and its
  confirmation rule carry the autopilot sentences engineer authored (present
  in batch; proceed with the recommendation, and stop with the owner gate on a
  genuine owner judgment, now citing the routing contract's § Owner gates).
  engineer takes the protocol's decision-item rule: one decide's compared
  options are one item, presented whole, where its Example 1, its taxonomy
  row and its decide skill made each option an interview item; the
  interaction rule surfaces the compact lens instead of running the full
  decide inline; its list of where the protocol applies names several open
  decisions instead of one decide's options; and its compose row presents a
  plan as one item, as its compose skill does (it made each task an item).
  For every persona Example 1's recommendation block names "any gate verdict
  its axes require" (engineer's axes declare no gate), and the orchestration
  failure handling names the three ways a local analysis fails to return.
  engineer's
  orchestration keeps its agent roster and its Task Profile, which now names
  engineer alone (it named designer as a persona still to come), under the
  shared failure heading. The reference contracts run both references for
  engineer: each Present site is one whole heading per persona, found once
  in its mode; the orchestration half of RD9 is a contract of its own; and
  both templates are rendered region by region for every legal capability
  combination, each equal to its all-off text but for the autopilot
  paragraph.
- **engineer's ensemble protocol joins its regions**: the seventeen that
  state no peer privacy policy. engineer declares none (no `peer`), so the
  four that do stay founder's and designer's, and the Launch step's privacy
  gate is now a region of its own (`ensemble-launch-privacy`), a paragraph
  before the numbered steps, which lose a number (designer's screenshot and
  vision sentences follow). Under `dispatch_target` the Collect step carries
  engineer's autopilot wait (never sleep-poll; the report taken while waiting
  is provisional), and under `commit_surface` the list of what the protocol
  does not apply to names the commit command, which dispatches no peer. For
  every persona the Launch keeps the runner out of a shell `&` (engineer's
  ADR-0063 D5 sentence), State Bookkeeping names why a run never launched from
  the declaration (`derived.ensemble_skip_cause`, as the finalize note does),
  partial coverage names the sections the peer missed, and the graceful
  degradation says the verb saves its artifact where it saves one (engineer's
  critique saves no report). engineer's authored text loses what the settle
  rule replaced or the code no longer does: the schema-version history, the
  `codex_session_id` note (`settle` records none), stale pending entries
  surfaced by `resume` (it reports none), `dispatch-peer.mjs` for
  `peer-now` (it runs `peer-runner.mjs --kind peer-now`) and the "Peer:
  not analyzed" marking; it keeps its point types, its additional and
  required prompt blocks (repository context, not genericized), its raw
  context and Plan-verify exception, and the large-change slicing. Enrolling
  it ran RV7 for engineer, which found its peer-now skill listing `--run-id`
  among the flags that opt a dispatch into `ensemble_results`; it now says
  what founder's does. The reference contracts check the privacy regions
  against the declared peer policy (none for engineer, and no enrolled region
  of its may claim a gate), the autopilot wait and the commit exclusion by
  capability with the commit surface's scripts, and the seventeen templates
  rendered region by region for every legal capability combination. The
  citation check now reads a `§` after a Markdown-link citation and a quoted
  `§` with no space; engineer's cited-brief ensemble cited the renamed
  heading that way, unread until then.
- **engineer's investigate brief references join their regions**: the
  output-file rules (all three), the brief spec (both) and the brief ensemble
  (the sixteen that state no peer privacy policy). Declaration format 1.4
  gives investigate a `brief_profile` and a `brief_ensemble_type` where they
  are not the default profile and its ensemble type (engineer: cited-brief, a
  research-scan, while its default is analysis, an investigate); the brief
  bindings read `derived.brief_profile` and `derived.brief_ensemble_type`, and
  `derived.brief_file` follows the brief profile. As in the ensemble protocol,
  the brief Launch's privacy gate is a region of its own
  (`brief-ensemble-launch-privacy`), a paragraph before the steps, which lose
  the gate step and number the dispatch 1–4; engineer's gate is its
  cited-brief Step 1's, stated in its authored text, and it holds neither
  brief privacy region. The shared text no longer says only future profiles
  write phase notes (engineer's analysis and root-cause do today), names the
  persona's own file names without a Stage-1 claim (each persona says that in
  its own words; engineer kept `research_brief.md` and `RESEARCH_OUTPUT_ROOT`
  from Stage 1), and keeps `As-of` out of the citation conventions (founder's
  and designer's sources carry it, engineer's do not). engineer's brief
  ensemble takes the shared Collect (the runner result first, where it read
  the envelope from the companion's stdout), failure handling (each attempt
  settled from its ledger, where it skipped or recorded failures by hand) and
  recovery (inspect the run before a retry, where it re-dispatched under the
  same run id). `tests/engineer/test-cited-brief.mjs` moved: what the
  generated rules guarantee to the reference contracts (RD7, for every
  persona), engineer's own text to `tests/plugin-shape/test-engineer-plugin.mjs`.
- **The code-emitted footer names ADR-0039 alone, everywhere.** As in the
  session handoff, which ADR enabled a persona's footer is history, not a
  capability: the verb skills' finish paragraph and its convergent variant, the
  verb runbooks' footer paragraph, the start skill's finish and the start
  runbook's terminal region (with their convergent variants) said "ADR-0039,
  enabled for <persona> by ADR-0043" under `commit_surface` off, or in the
  variant chosen by it. Each persona's `session-handoff.md` title keeps its
  provenance, and every paragraph points to it. The verb skills' and verb
  runbooks' sentence is now stated once, its completion state the only part
  that branches. The contracts check ADR-0039 alone for every persona, and
  every template that states the footer is rendered under every legal
  capability combination with the footer attributed to ADR-0039 alone.

## The declaration

`plugins/<persona>/persona.json` names its format, `persona-declaration-1.<minor>`.
Format 1.0 holds identity, the deliverable noun, the runtime footer floor, the
capabilities and the decide data. Format 1.1 adds `verbs`, what differs per
verb: its `profiles` and `default_profile`, the `request_placeholder` its
bootstrap describes, its `ensemble_type` where personas differ, the phase
note's `artifact` sections (a list, one item per line), the proposal's
`rationale_gate` and `evidence_pointers`, the `next_action` it records, and for
`refine` and `start` whether the terminal write waits for a converged
re-critique (`terminal_requires_convergence`). Format 1.2 adds `peer`, what
the persona lets reach the peer: `privacy_scope` (the material its privacy
gate names), `privacy_spec` (the plugin path of the spec that defines the
gate, a regular file inside the plugin) and `images` (whether image bytes may
go to the peer; both personas say `false`). Format 1.3 adds investigate's
`brief_file` and `output_root_env`, for a persona whose brief is not named
after its default profile (engineer: `research_brief.md` under
`RESEARCH_OUTPUT_ROOT`, from its cited-brief profile, while its default is
analysis). Format 1.4 adds investigate's `brief_profile` and
`brief_ensemble_type`, where the profile that saves the brief and its
ensemble's point type are not the default profile and `ensemble_type`
(engineer: cited-brief and research-scan); the brief references are named
after the brief profile. founder and designer declare 1.2; engineer declares
1.4, with the verbs whose runbooks have joined the regions (PC3) and no
`peer`, so its runbooks hold no privacy gate and its ensemble protocol no
Privacy section. The verb
runbooks render these values from the declaration, and the convergence flag
picks the variant of `refine`'s finalize and `start`'s terminal block (a
`when` on `terminal_requires_convergence`).
`tests/persona-pipeline/test-declaration-verbs.mjs` binds each declared value
to the runbook text that states it;
`tests/persona-pipeline/test-verb-runbook-characterization.mjs` records what
the seven runbooks did before their blocks moved (`fixtures/verb-runbooks.json`),
and a region changes only what the fixture's `allowed_differences` lists,
each with its reason.

Two readers read a declaration, the schema validator (the generator, the
tests) and each plugin's `scripts/lib/persona.mjs`, and they agree at every
depth: a key the format does not know is refused, except a scalar in a
declaration of a newer minor than the reader's, which is ignored; an unknown
object or list is refused at any minor. The generator adds the rules the
schema cannot state: the decide fallback equals the registry preset, a verb's
`default_profile` is one of its `profiles` (both or neither), so is
investigate's `brief_profile`, the four brief fields are investigate's alone,
investigate's `artifact` names exactly one `*.md` file and it is
`derived.brief_file`, and
every field an enrolled unit or region reads is present. A declaration that fails one is
reported as its own failure, and no region renders from it.

## Regions

A region is the text between `<!-- pipeline:begin <id> -->` and
`<!-- pipeline:end <id> -->` in an authored file. The manifest gives each
`(dest, id)` a template under `regions/`, the personas enrolled, and its
substitutions. A template holds only `{{name}}` placeholders and
`{{#capability x}}` / `{{^capability x}}` blocks (ADR-0066 Decision 4).

- A substitution reads a declaration field (`field`, a dotted path) or carries
  a literal the manifest fixes for that region (`value`, e.g. the verb a
  shared block runs for). `derived.root_env` is the persona's
  `AGENTIC_<NAME>_ROOT`, derived from `name`, and `derived.profile_env` its
  `AGENTIC_<NAME>_PROFILE`, the variable the decide resolver reads an L4
  profile from (with `profile_presets` on); `derived.skill_privacy_spec` is
  `peer.privacy_spec` as a skill cites it, relative to its own directory, and
  `derived.shared_privacy_spec` the same spec relative to
  `core/skills/_shared/references/`. `derived.brief_profile` is the
  investigate profile that saves the brief (a declared `brief_profile`, else
  `default_profile`) and `derived.brief_ensemble_type` its ensemble's point
  type (a declared `brief_ensemble_type`, else `ensemble_type`).
  `derived.brief_file` is the file the brief is saved as, a declared
  `brief_file`, else the brief profile with `-` → `_` plus `.md`, and
  `derived.output_root_env` the variable that moves it, a declared
  `output_root_env`, else `<NAME>_OUTPUT_ROOT`; all four exist only with
  `verbs.investigate.default_profile`. A
  derived field whose input is absent is absent, so a template that reads it
  fails to render.
- A region may carry `when: {field, equals}`, a variant: its `personas` must
  be exactly the manifest personas whose declaration holds `field` with that
  JSON value (`false`, `"false"` and `null` differ). A persona whose format
  lacks the field is never enrolled in it. Enrollment stays explicit data,
  checked against the declarations; a template holds no condition on it.
- Its `context` decides how the value lands. `shell`: a single-quoted
  literal, and only at an unquoted word position of a shell block, never
  inside `"…"`, `'…'`, `$'…'`, `${…}`, an arithmetic expansion, backticks, a
  comment or a heredoc, nor right after a backslash, where it would not mean
  what it says (a `$(…)` opens a fresh unquoted position, as
  in the shell). `markdown` / `text`: verbatim, and never inside a shell
  block. A persona value that a double-quoted argument needs goes through a
  shell variable set from a literal first (`PERSONA='founder'`, then
  `"${PERSONA}"`).
- A `markdown` or `text` value may be a list of strings (a verb's `artifact`):
  its placeholder stands alone on its line, and each item renders on its own
  line with that line's indentation. A `shell` value is never a list, and an
  item holding a line break fails the render. So does any value that opens or
  closes a code fence: placement is checked on the template, so a value may
  not move text into or out of a shell block.
- A value holding `{{`, a placeholder the region does not declare or the
  placement check cannot read (one spanning lines included), and any `{{`
  left after rendering fail the render.

To give a file regions, put each pair of markers, empty, where the block
goes, enroll the region in the manifest, and run the write: it fills the
bodies. The write repairs a body only; a missing marker or enrollment is an
authored fix. In a `SKILL.md`, markers sit below the frontmatter, which a
host reads only from the file's start.

### Extension slots

A persona's own step inside a pipeline file is authored text after an
extension marker, `<!-- pipeline:extension <id> -->` (ADR-0066 Decision 2).
The manifest declares each slot: its `dest`, the `personas` that own it, the
regions it sits between (`after`, `before`, both enrolled for every owner),
and how many markers it takes (`min` to `max`). The check fails a marker in a
slot the file does not declare or the persona does not own, a marker outside
its two regions, and a count outside the range, so a required step (`min` 1)
cannot drop out unnoticed. The check places markers; it does not read the
text after them. The runbook and skill contracts do: the terminal block
follows every marker, and each required extension holds the sentences it
exists for.

A verb runbook's phase note never passes through a shell string. The finalize
region shows the note's scaffold in a `markdown` fence, persona text rendered
verbatim; the agent fills it in and runs the block below it, which reads the
filled note from a quoted heredoc (`IFS= read -r -d '' NOTE <<'PHASE_NOTE' ||
true`), so a quote, `$`, backtick or backslash in it reaches `state.mjs` as
written, under bash and zsh (and macOS sh), with the heredoc's final newline.
Two limits, each stated where the agent acts: a line reading `PHASE_NOTE`
alone would end the note and run the rest as commands, so the prose has the
agent rename the delimiter when its note holds one; and a shell whose `read`
has no `-d` (dash) reads nothing, so the block clears `NOTE` before the read
(a value the shell inherited cannot stand in) and an empty note stops it
before any write. The request placeholder works the same
way: the region prose names it, and the block says
`<the original request described above>`. The bootstrap `create`, the resume
`append` and the finalize `append` stop the block when they fail
(`|| exit $?`). The finalize then runs `peer-runner.mjs settle` for the
ensemble attempt, which decides from the run ledger what the workflow
records (nothing for a run that never launched, verdict `failed` with the
ledger's `error_kind` for one that failed, the synthesis verdict or
`degraded` for one that completed) and stops the block when it refuses, and
ends with `finish-verb` (PC2b).

decide's Phase 0.5 region (`decide-resolve.md`) holds the args-file steps
(ADR-0059) and the resolver block, which opens with the `ARGS_DIR` the agent
wrote into and then the plugin root; the resolved context reaches the
block's output, and both resolver failures stop it. Its sentence on
`--preset` names the persona's `decide.fallback.preset_id`, and a contract
runs the persona's own registry to check what the sentence says: an unknown
id falls back to that preset, flagged, and an empty one counts as no
`--preset`.

## Editing

1. Edit the canonical file under `files/`, never a generated copy (each starts
   with a `GENERATED by persona-pipeline` notice; JSON files carry none and are
   listed in `owned.json`).
2. Regenerate: `npm run sync:persona-pipeline -- --write`.
3. Check: `npm run sync:persona-pipeline` exits 0 when every copy matches. CI
   runs it in `validate.yml`.
4. Commit each persona plugin's generated copies in that package's own commit
   (ADR-0016); this directory is outside every release-please package and rides
   with the first. A change that alters a persona's generated files releases
   that persona.

The check fails on a generated file or region that differs from its source
(the executable bit included), a missing or out-of-order region, an unknown
region or extension id or broken region grammar, an extension marker its
slot does not admit, a variant enrollment that disagrees with the
declarations, an owned output nothing
generates any more, a ledger that disagrees, a declaration that fails its
schema or a cross-field rule (see [The declaration](#the-declaration)), and
personas found on disk that differ from the manifest's.

The write mode changes nothing when a failure is not one it can repair. It
refuses a destination it does not own — present, not in `owned.json`, without
the notice — unless `--adopt` says the hand copy at that manifest destination
is to be taken over, which is how a hand-maintained copy joins the pipeline.

## Tests

`tests/persona-pipeline/` tests each canonical unit once per enrolled persona
(`personasFor(dest)` in `_personas.mjs`), the region engine on fixtures, the
declaration and its loader, the generator, the CLI entry guard, and the
off-capability, broken-declaration and isolation behavior (with
`dispatch_target` off, an inherited `AGENTIC_AUTOPILOT` read by nothing but
`state.mjs`), schema 1.4 and the owner gates (`test-state-schema-14.mjs`),
settlement (`test-peer-runner-settle.mjs`), the start lifecycle through the
real CLIs (`test-start-lifecycle.mjs`) and the previous founder release
against a gated file (`test-mixed-version.mjs`, which reads the release tag
and fails without it). `test-verb-runbook-runs.mjs` and
`test-commit-runbook.mjs` run the verb runbooks' and the commit surface's
blocks as written, in bash and zsh, with the persona's real scripts.
`test-runbook-contracts.mjs` holds the runbook contracts (call order, the
workflow each write targets, identity against the characterization's
expected map, the phase-note transport, failure propagation, the privacy gate
before the dispatch, no image to the peer, the finalize block and decide's
resolver block run with a stubbed `node`, and the fallback decide's prose
names measured against its registry) over each persona's committed runbook
and over the runbook assembled from the templates, so a defect the drift
check cannot see still fails. The convergent finalize of refine and start has
its own family there (the block's position after every extension marker, the
extensions' anchor sentences, the `CONVERGED` check run with each value, the
variant rebuilt from its plain template), and so does `start` (its clean-baseline admission and
`workflow_type` read run for every status). `test-skill-contracts.mjs` is the
skill family: a skill runs nothing, so it checks the text an agent acts on
(no unrendered placeholder, `<plugin-root>` in every generated block, each named
`state.mjs` subcommand exists, the Plugin root row per document, and what
each generated section says it does). `test-reference-contracts.mjs` is the
reference family, over the committed references and the ones assembled from
the templates: nothing unrendered; every in-plugin citation an agent follows
(a relative path, a `core/skills/…` path or a bare sibling name) resolves in
the same plugin, and the `§` after it names a heading the target holds; the
capability text agrees with the declaration; every Present step, the
generated finalize note and start's routing cite the persona's own documents;
and each shared fact a region states is bound to the code that does it: the
preflight to the generated scripts, the ensemble and brief collect order and
the brief recovery to `peer-runner.mjs`, the brief's dispatch and ensemble
type to the investigate runbook.
`scripts/mutation-specs/persona-pipeline.mjs` puts defects into the
canonical source, regenerates them, and expects a contract test to fail; a
case's `killed_by` names the tests that must fail, by name or by path
(`suite > test`, read from the TAP records), so a run that fails only
elsewhere scores `KILLED-ELSEWHERE` (`scripts/mutation-harness.mjs`).
