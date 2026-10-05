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
| `regions/<block>.md` | The canonical region templates: a block of a runbook or a skill, rendered into each enrolled persona's authored file between its region markers. The `skill-*` templates render into `SKILL.md`. |
| `persona.schema.json` | The schema of `plugins/<persona>/persona.json`, each persona's declaration of who it is and what differs: name, deliverable noun, runtime footer floor, capabilities, decide data, from format 1.1 its verbs, and from 1.2 its peer permissions (see [The declaration](#the-declaration)). |
| `owned.json` | Generated: every plugin path the pipeline has written, per persona. It is how the write mode knows what it may replace or remove. Do not edit it. |

The canonical scripts are persona-neutral. Each reads its persona from the
plugin's own `persona.json` through `scripts/lib/persona.mjs` when it runs,
never at import. A capability a persona declares off behaves as the trimmed
copy did; a unit that carries only a capability's off path is never enrolled
into a persona that declares it on (`off_only` in the manifest).

Stage 1 (PC1) covers the scripts and hooks. engineer receives the units it
shares unchanged (the decide libraries and registry, `validate-commit`,
`dispatch-peer`, the hooks, the lib modules); its `state.mjs`,
`session-handoff.mjs`, `stop-archive.mjs`, `discover-runtime.mjs`,
`peer-runner.mjs` and capability modules stay hand-maintained until Stage 3.
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
  finalize heading and the completion-footer paragraph. A block whose
  behavior differs by persona stays authored until the settlement work
  (PC2b) generates it: the finalize
  blocks of critique and refine (designer's ensemble-commit guard and its
  convergence guard), start's terminal block, and founder's critique
  dispatch, which picks its ensemble type by profile. An authored block in a
  file that holds regions opens with the generated resolver, copied by hand,
  since a file uses one resolver form.
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
go to the peer; both personas say `false`). founder and designer
declare 1.2; engineer declares 1.0, with no verbs and no `peer`. The verb
runbooks render these values from the declaration; the terminal blocks of
`refine` and `start` are still authored, so their convergence flag is a copy
of what that block does.
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
`default_profile` is one of its `profiles` (both or neither), and every field
an enrolled unit or region reads is present. A declaration that fails one is
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
  `AGENTIC_<NAME>_ROOT`, derived from `name`; `derived.skill_privacy_spec` is
  `peer.privacy_spec` as a skill cites it, relative to its own directory.
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
(`|| exit $?`); `ensemble-commit` stays unguarded until the settlement
transitions (PC2b) give the degraded path its own step.

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
schema or a cross-field rule (its decide fallback must equal its registry
preset), and personas found on disk that differ from the manifest's.

The write mode changes nothing when a failure is not one it can repair. It
refuses a destination it does not own — present, not in `owned.json`, without
the notice — unless `--adopt` says the hand copy at that manifest destination
is to be taken over, which is how a hand-maintained copy joins the pipeline.

## Tests

`tests/persona-pipeline/` tests each canonical unit once per enrolled persona
(`personasFor(dest)` in `_personas.mjs`), the region engine on fixtures, the
declaration and its loader, the generator, the CLI entry guard, and the
off-capability, broken-declaration and isolation behavior.
`test-runbook-contracts.mjs` holds the runbook contracts (call order, the
workflow each write targets, identity against the characterization's
expected map, the phase-note transport, failure propagation, the privacy gate
before the dispatch, no image to the peer, the finalize block and decide's
resolver block run with a stubbed `node`, and the fallback decide's prose
names measured against its registry) over each persona's committed runbook
and over the runbook assembled from the templates, so a defect the drift
check cannot see still fails. Runbooks with an authored finalize have their
own family there (the block's position after every extension marker, the
extensions' anchor sentences, the guards run with each combination of
outcomes), and so does `start` (its clean-baseline admission and
`workflow_type` read run for every status). `test-skill-contracts.mjs` is the
skill family: a skill runs nothing, so it checks the text an agent acts on
(no unrendered placeholder, `<plugin-root>` in every generated block, each named
`state.mjs` subcommand exists, the Plugin root row per document, and what
each generated section says it does). `scripts/mutation-specs/persona-pipeline.mjs` puts defects into the
canonical source, regenerates them, and expects a contract test to fail; a
case's `killed_by` names the tests that must fail, by name or by path
(`suite > test`, read from the TAP records), so a run that fails only
elsewhere scores `KILLED-ELSEWHERE` (`scripts/mutation-harness.mjs`).
