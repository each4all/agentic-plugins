// Mutation spec — does the persona pipeline's suite catch the defects it exists
// for (ADR-0066 Decision 5)?
//
// Run: npm run mutate -- scripts/mutation-specs/persona-pipeline.mjs
//
// WHY A SPEC. Once one canonical source generates every persona's copy, a
// green suite proves two weak things at once: that the copies match the
// source (the drift check), and that the source is right. The first is
// mechanical; the second is what the contract tests carry. So the defects
// below go into the CANONICAL source and are REGENERATED, the way a real edit
// travels — never hand-applied to one copy — and a contract test must fail:
//
//   P  a canonical defect regenerated into exactly ONE persona, once per
//      persona the unit is enrolled into, so each KILLED names the persona
//      whose copy carried it (per-persona attribution);
//   A  a canonical defect regenerated into EVERY target: drift equality stays
//      clean, so only a contract test can catch it;
//   D  the drift check itself: a hand edit to a generated file, a region
//      comparison that ignores differences, a loader without its name check.
//   G  a defect in a canonical runbook region template (PC2a), regenerated
//      into every enrolled persona: the region drift check stays clean, so a
//      runbook contract test must fail;
//   M  the verb runbook regions (PC2a2b compose and frame, PC2a2c investigate
//      and decide, PC2a3 critique, refine and start) and the SKILL.md regions
//      (PC2a3 T7): a template, manifest or declaration defect, or authored
//      text removed (or, around a region, added), each with the contract that
//      must catch it (killed_by);
//   V  declaration format 1.1 (PC2a2) and 1.2 (PC2a3, peer): the loader's
//      reader parity with the schema, the generator's cross-field rules, the
//      declared verb fields bound to the runbooks; K, the verb runbook
//      characterization (T0); L, the engine's list values;
//   S  the extension slots (PC2a3 DD6): each slot check dropped; W, the
//      variant rule (DD2) dropped;
//   X  the shared-reference regions (PC2a4): a template defect regenerated
//      into founder and designer, or authored reference text broken, each with
//      the reference contract that must catch it (killed_by);
//   O  schema 1.4 read before it is written (PC2b): the per-key validation
//      and the known keys, a defect in one persona's copy or in every copy;
//   E  ensemble settlement (PC2b DD6, RV1, RV2): each rule `settle` decides
//      by, dropped or loosened;
//   N  engineer converges (PC3): a defect in a canonical capability-on path,
//      regenerated into every target, fails an engineer contract test;
//   C  a control: an innocuous canonical edit, regenerated everywhere, keeps
//      the drift check clean (expect SURVIVED).
//
// `prepare` is synchronous and runs before any declarative edit, so each case
// edits and regenerates inside it, and a failed regeneration is a harness
// error, never a verdict.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MutationHarnessError } from '../mutation-harness.mjs';

const MANIFEST = JSON.parse(readFileSync(new URL('../../persona-pipeline/manifest.json', import.meta.url), 'utf8'));
const enrolled = (dest) => MANIFEST.units.find((u) => u.dest === dest).personas;

const T_ENTRY = 'tests/persona-pipeline/test-cli-entry-guard.mjs';
const T_STOP = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_SYNC = 'tests/persona-pipeline/test-sync-persona-pipeline.mjs';
const T_REGION = 'tests/persona-pipeline/test-region-engine.mjs';
const T_DECL = 'tests/persona-pipeline/test-persona-declaration.mjs';
const T_CROSS = 'tests/persona-pipeline/test-capabilities-and-declaration.mjs';
const T_CONTRACT = 'tests/persona-pipeline/test-runbook-contracts.mjs';
const T_HEADLESS = 'tests/plugin-shape/test-headless-safe-runbooks.mjs';
const T_VERBS = 'tests/persona-pipeline/test-declaration-verbs.mjs';
const T_CHAR = 'tests/persona-pipeline/test-verb-runbook-characterization.mjs';
const T_SKILL = 'tests/persona-pipeline/test-skill-contracts.mjs';
const T_REF = 'tests/persona-pipeline/test-reference-contracts.mjs';
const T_CODEX = 'tests/plugin-shape/test-codex-plugin-root-contract.mjs';
const T_ARCH = 'tests/scripts/test-set-terminal-archive-timing.mjs';
const T_S14 = 'tests/persona-pipeline/test-state-schema-14.mjs';
const T_SETTLE = 'tests/persona-pipeline/test-peer-runner-settle.mjs';
const T_ENG_AP = 'tests/plugin-shape/test-engineer-autopilot-runbooks.mjs';
const T_ENG = 'tests/plugin-shape/test-engineer-plugin.mjs';
const T_COMMIT_RB = 'tests/persona-pipeline/test-commit-runbook.mjs';
// The verb runbooks' blocks, run for every persona (PC3b U4b: moved from
// tests/engineer/test-verb-runbook-autopilot.mjs).
const T_VERB_RB = 'tests/persona-pipeline/test-verb-runbook-runs.mjs';
// orchestration-failure.md whole (N90 wraps it in two capability blocks).
const ORCH_FAILURE = readFileSync(new URL('../../persona-pipeline/regions/orchestration-failure.md', import.meta.url), 'utf8');

export const TESTS = [T_SYNC];

function regenerate(copy) {
  try {
    execFileSync(process.execPath, [join(copy, 'scripts/sync-persona-pipeline.mjs'), '--write'], { cwd: copy, stdio: 'pipe' });
  } catch (err) {
    throw new MutationHarnessError(`regeneration failed in the copy: ${err.stderr?.toString() || err.message}`);
  }
}

/**
 * Edit the canonical source of `dest`, regenerate, then put every persona other
 * than `only` back to its pre-edit generated copy, so exactly one persona's
 * copy carries the defect. `only` null keeps it in every target.
 */
function canonicalDefect(copy, tools, { dest, from, to, only = null }) {
  const keep = {};
  for (const persona of enrolled(dest)) {
    if (only !== null && persona !== only) keep[persona] = readFileSync(join(copy, 'plugins', persona, dest), 'utf8');
  }
  tools.applyEdit(copy, { file: `persona-pipeline/files/${dest}`, from, to });
  regenerate(copy);
  for (const [persona, text] of Object.entries(keep)) writeFileSync(join(copy, 'plugins', persona, dest), text);
}

const regionPersonas = (template) => [...new Set(MANIFEST.regions.filter((r) => r.template === template).flatMap((r) => r.personas))].sort();
const regionDests = (template) => [...new Set(MANIFEST.regions.filter((r) => r.template === template).map((r) => r.dest))];

/**
 * Edit a canonical region template and regenerate it into every persona; with
 * `only`, put every other persona's region files and the template back, so
 * exactly one persona's committed runbook carries the defect.
 */
function templateDefect(copy, tools, { template, from, to, edits = [{ from, to }], only = null }) {
  const keep = {};
  for (const persona of regionPersonas(template)) {
    if (only === null || persona === only) continue;
    for (const dest of regionDests(template)) keep[join('plugins', persona, dest)] = readFileSync(join(copy, 'plugins', persona, dest), 'utf8');
  }
  const source = join(copy, 'persona-pipeline', template);
  const canonical = readFileSync(source, 'utf8');
  for (const edit of edits) tools.applyEdit(copy, { file: `persona-pipeline/${template}`, ...edit });
  regenerate(copy);
  for (const [rel, text] of Object.entries(keep)) writeFileSync(join(copy, rel), text);
  // With `only`, the template goes back too: every other persona's committed
  // and assembled runbook is then clean, so a kill names `only` (Codex review).
  if (only !== null) writeFileSync(source, canonical);
}

// The templates that open their shell blocks with the resolver, listed by name
// (G13 edits each). The list must be every such template: one the list misses
// would keep the errexit-safe form while the case reports a kill.
const RESOLVER_TEMPLATES = [
  'regions/checkpoint-set.md', 'regions/commit-autopilot.md', 'regions/commit-close.md', 'regions/commit-execute.md',
  'regions/commit-phase-0.md', 'regions/commit-plan.md', 'regions/commit-staging-clear.md', 'regions/decide-owner-selection.md', 'regions/decide-resolve.md', 'regions/locate-active.md',
  'regions/peer-now-dispatch.md', 'regions/peer-now-locate.md', 'regions/peer-now-note.md',
  'regions/refine-owner-decision.md', 'regions/refine-owner-decision-convergent.md',
  'regions/resume-archive.md', 'regions/resume-marker.md', 'regions/resume-read.md',
  'regions/start-bootstrap.md', 'regions/start-commit.md', 'regions/start-resume.md', 'regions/start-terminal.md',
  'regions/start-terminal-convergent.md', 'regions/verb-bootstrap-profiled.md',
  'regions/verb-bootstrap.md', 'regions/verb-dispatch.md', 'regions/verb-finalize.md',
  'regions/verb-finalize-convergent.md',
  'regions/verb-phase-0.md', 'regions/verb-resume-profiled.md', 'regions/verb-resume.md',
];
{
  const bearing = [...new Set(MANIFEST.regions.map((r) => r.template))]
    .filter((template) => readFileSync(new URL(`../../persona-pipeline/${template}`, import.meta.url), 'utf8').includes('printenv {{root_env}}'))
    .sort();
  if (JSON.stringify(bearing) !== JSON.stringify([...RESOLVER_TEMPLATES].sort())) {
    throw new MutationHarnessError(`RESOLVER_TEMPLATES is not the set of resolver-bearing templates: ${bearing.join(', ')}`);
  }
}

// PC2a2b: the finalize template and its settle step (PC2b DD6; ensemble-commit
// before it), moved whole by M1/M2.
const FINALIZE = 'regions/verb-finalize.md';
// PC2a2c: decide's Phase 0.5 template and the contract that runs its block.
const RESOLVE = 'regions/decide-resolve.md';
const PHASE_05_RUN = /^Phase 0\.5: between the resume and the dispatch, the resolver reads the args file/;
const COMMIT_STEP = [
  '# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,',
  '# launched and failed, completed); a refusal stops the block before the last',
  '# write, so the workflow never closes with an attempt left unsettled.',
  'node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \\',
  '  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \\',
  '  --host "${AGENTIC_HOST:-claude}" --phase {{verb}} --run-id "$RUN_ID" \\',
  '  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?',
  '',
  '',
].join('\n');
const FINALIZE_ORDER = /^the dispatch, the note, settle and finish-verb run in that order/;

// PC3b U5c: the ensemble templates' two capability blocks, whole.
const ENSEMBLE_AUTOPILOT = readFileSync(new URL('../../persona-pipeline/regions/ensemble-collect.md', import.meta.url), 'utf8').match(/\{\{#capability dispatch_target\}\}\n[^]*?\{\{\/capability\}\}\n/)?.[0];
const ENSEMBLE_COMMIT = readFileSync(new URL('../../persona-pipeline/regions/ensemble-when-applies.md', import.meta.url), 'utf8').match(/\{\{#capability commit_surface\}\}\n[^]*?\{\{\/capability\}\}\n/)?.[0];
if (!ENSEMBLE_AUTOPILOT || !ENSEMBLE_COMMIT) throw new MutationHarnessError('the ensemble templates lost a capability block the U5c mutations move');

// PC2a3: the privacy gate's two templates, and the per-verb sentence the
// manifest gives the gate (a `value` substitution), edited in place.
const PRIVACY_GATE = 'regions/verb-privacy-gate.md';
const NO_IMAGE_RULE = 'regions/verb-privacy-no-image.md';
function genericizeDefect(copy, verb, from, to, dest = `commands/${verb}.md`) {
  const path = join(copy, 'persona-pipeline/manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const sub = manifest.regions.find((r) => r.id === `${verb}-privacy-gate` && r.dest === dest)?.substitutions?.genericize;
  if (!sub || !sub.value.includes(from)) throw new MutationHarnessError(`${verb}-privacy-gate (${dest}): no genericize value holding ${JSON.stringify(from)}`);
  sub.value = sub.value.split(from).join(to);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  regenerate(copy);
}

/** The verb runbooks whose blocks are generated (PC2a2b, PC2a2c). */
const VERB_RUNBOOKS = ['compose', 'frame', 'investigate', 'decide'];

/**
 * The tests a defect in a verb template must fail: the named contract (a
 * pattern anchored at the test name's start) inside the committed runbook's
 * suite of every enrolled persona, every generated verb runbook alike —
 * matched by path, so a contract failing in one suite and an unrelated test
 * failing in another does not pass for both (Codex review of PC2a2b).
 */
const inSuite = (suite, contract) => new RegExp(
  `(?:^| > )${suite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} > ${contract.source.replace(/^\^/, '')}`,
);
const IDENTITY = /^identity: persona, verb, phase, ensemble type and run-id prefix/;
const PRIVACY = /^privacy: the prohibition sentence precedes the dispatch/;
// The finalize reads the phase note from a quoted heredoc (M11, M18, M21, M33).
const HEREDOC = /^the phase note is read from a quoted heredoc and passed as "\$NOTE" \(PD2\)$/;
const verbCaught = (contract, verbs = VERB_RUNBOOKS) => ['founder', 'designer'].flatMap((p) => verbs.map((v) => new RegExp(
  `(?:^| > )${`${p}/commands/${v}.md (committed)`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} > ${contract.source.replace(/^\^/, '')}`,
)));

/**
 * The (persona, runbook) pairs a template renders into, from its enrollment
 * (PC2a3): a designer-only dispatch template is expected to fail designer's
 * critique, not founder's, where verbCaught() would expand to both. `dests`
 * narrows a template shared by runbooks and skills to the side the contract
 * is about.
 */
const templateCaught = (template, contract, dests = () => true) => MANIFEST.regions
  .filter((r) => r.template === template && dests(r.dest))
  .flatMap((r) => r.personas.map((p) => new RegExp(
    `(?:^| > )${`${p}/${r.dest} (committed)`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} > ${contract.source.replace(/^\^/, '')}`,
  )));

// PC3b U1: the owner blocks read the workflow type with the read checked on
// its own (G68, G69 put back the pipe, whose status is the parser's).
const TYPE_READ_CHECKED = 'WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \\\n  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }\nWF_TYPE="$(printf \'%s\' "$WF_JSON" \\\n';
const TYPE_READ_PIPED = 'WF_TYPE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" \\\n';
const SKILL_PRIVACY = /^the privacy gate precedes the peer step/;
const isSkill = (dest) => dest.startsWith('core/skills/');
// PC3b U3b: the verb skills' finish paragraph and its contract.
const FINISH = 'regions/skill-verb-finish.md';
const FINISH_CONVERGENT = 'regions/skill-verb-finish-convergent.md';
const FINISH_CONTRACT = /^the finish paragraph names the handoff by capability, and its citations resolve inside the plugin$/;
// PC3b U3c: the start skill's finish region.
const START_FINISH = 'regions/skill-start-finish.md';
const START_FINISH_CONTRACT = /^the finish paragraph names the lifecycle's last write, by declaration, and its citations resolve$/;
// The privacy contract of each runbook a privacy template renders into, from
// its enrollment: start's has its own name (Codex review of PC2a3: the
// verbCaught default left critique, refine and start unrequired).
const START_PRIVACY = /^start privacy: the prohibition precedes the phase boundaries/;
const privacyCaught = (template) => [
  ...templateCaught(template, PRIVACY, (d) => d.startsWith('commands/') && d !== 'commands/start.md'),
  ...templateCaught(template, START_PRIVACY, (d) => d === 'commands/start.md'),
];

const CHECKPOINT_TARGET = {
  template: 'regions/checkpoint-set.md',
  from: '  --workflow-path "$ACTIVE" --host',
  to: '  --workflow-path "$WORKFLOW" --host',
};

const ENTRY = {
  dest: 'scripts/lib/cli-entry.mjs',
  from: '  if (entry !== self) return false;',
  to: '  if (importMetaUrl !== `file://${argv1}`) return false;',
};
const STOP_GATE = {
  dest: 'scripts/stop-archive.mjs',
  from: "    if (refState === 'present') {",
  to: '    if (false) {',
};

export const MUTATIONS = [
  // ---- P: one persona's copy carries a canonical defect ----------------------
  ...enrolled(ENTRY.dest).map((persona) => ({
    id: `P1-${persona}`, tests: [T_ENTRY],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { ...ENTRY, only: persona }),
    why: `${persona}: the CLI entry guard compares a URL with a path again (D1) — its CLIs exit 0 silently through a symlink or an escaped path`,
  })),
  ...enrolled(STOP_GATE.dest).map((persona) => ({
    id: `P2-${persona}`, tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { ...STOP_GATE, only: persona }),
    why: `${persona}: a terminal workflow on a kept branch is never swept (one stop-archive gate inverted)`,
  })),

  // ---- O: schema 1.4 read before it is written (PC2b) -------------------------------
  ...enrolled('scripts/state.mjs').map((persona) => ({
    id: `O1-${persona}`, tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "    validateEnumScalar('awaiting_owner_gate', fm.awaiting_owner_gate, VALID_WORKFLOW_OWNER_GATES);\n",
      to: '',
      only: persona,
    }),
    why: `${persona}: a workflow file carrying a macro gate, or none ADR-0063 D4 stores in a workflow, is read as gated`,
  })),
  {
    id: 'O2', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  }\n\n  validateSchema14Fields(fm);\n}\n",
      to: "  }\n}\n",
    }),
    why: 'the reader stops validating the six keys, so any value reaches the archive gate and the handoff',
  },
  {
    id: 'O3', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  'next_step_confidence',\n  'awaiting_owner_gate',\n",
      to: "  'next_step_confidence',\n",
    }),
    why: 'awaiting_owner_gate is not a known key, so the forward-compat carrier hides it from every reader',
  },
  {
    id: 'O4', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: '  if (present.length > 0 && present.length < awaiting.length) {\n',
      to: '  if (false) {\n',
    }),
    why: 'a gate without its pointer or its date is accepted, half set',
  },
  {
    id: 'O5', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  if (('next_step_verb' in fm) !== (fm.next_step_kind === 'verb')) {\n",
      to: '  if (false) {\n',
    }),
    why: 'a next step of kind commit carrying a verb, or kind verb without one, is accepted',
  },
  {
    id: 'O6', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "export const SUPPORTED_SCHEMA_VERSIONS = new Set([1, '1.1', '1.2', '1.3', '1.4']);",
      to: "export const SUPPORTED_SCHEMA_VERSIONS = new Set([1, '1.1', '1.2', '1.3']);",
    }),
    why: '"1.4" is not a version this build names as known',
  },

  ...enrolled('scripts/stop-archive.mjs').map((persona) => ({
    id: `O7-${persona}`, tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/stop-archive.mjs',
      from: "  if (frontmatter?.awaiting_owner_gate !== undefined) {\n    gateFailures.push('awaiting_owner');\n  }\n",
      to: '',
      only: persona,
    }),
    why: `${persona}: the Stop hook archives a workflow waiting on its owner once its marker is on and HEAD moved (gate 5 dropped from the evaluator)`,
  })),
  {
    id: 'O8', tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/stop-archive.mjs',
      from: "  if (frontmatter?.awaiting_owner_gate !== undefined) failures.push('awaiting_owner');\n",
      to: '',
    }),
    why: 'the off-branch sweep archives a gated workflow once its branch is deleted (gate 5 dropped from the sweep)',
  },
  // Review of code step 6 (finding 1): the gates are evaluated
  // again on the bytes archiveWorkflow reads under the file lock.
  {
    id: 'O22', tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/state.mjs', from: '      if (recheck) {\n', to: '      if (false) {\n' }),
    killed_by: [/the Stop path: an owner gate written between the gates' read and the archive keeps the workflow/, /the sweep, deleted branch: an owner gate written between/, /the sweep, kept branch: an owner gate written between/],
    why: 'archiveWorkflow moves the bytes it read under the lock without the caller\'s gates, so an owner gate written after the caller decided is archived',
  },
  {
    id: 'O23', tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/stop-archive.mjs', from: '      recheck: (locked) => evaluateStopArchive({ frontmatter: locked, headSha, headSubject }).gateFailures,\n', to: '' }),
    killed_by: /the Stop path: an owner gate written between the gates' read and the archive keeps the workflow/,
    why: 'the Stop path archives on the gates of its first read: an owner gate written before the archive takes the lock is buried',
  },
  {
    id: 'O24', tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/stop-archive.mjs', from: 'archive({ workflowPath, host, repoRoot, recheck: sweepGateFailures })', to: 'archive({ workflowPath, host, repoRoot })' }),
    killed_by: /the sweep, deleted branch: an owner gate written between/,
    why: 'the sweep archives a deleted branch\'s workflow on the gates of its first read',
  },
  {
    id: 'O25', tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/stop-archive.mjs', from: '      recheck: (locked) => evaluateStopArchive({ frontmatter: locked, headSha: tip.sha, headSubject: tip.subject }).gateFailures,\n', to: '' }),
    killed_by: /the sweep, kept branch: an owner gate written between/,
    why: 'the sweep archives a kept branch\'s workflow on the gates of its first read',
  },
  {
    id: 'O26', tests: [T_STOP],
    prepare: (copy, tools) => {
      // The recheck runs on a read made before either lock.
      tools.applyEdit(copy, { file: 'persona-pipeline/files/scripts/state.mjs', from: '  return withDirectoryLock(dirLockRoot, async () => {\n    const sourceStat = await pathStat(workflowPath);\n', to: "  const early = recheck ? recheck(parseWorkflowFile(await readFile(workflowPath, 'utf8')).frontmatter) : [];\n  if (early.length > 0) return { archived: false, reason: 'gate-not-met-under-lock', gateFailures: early, workflowPath };\n  return withDirectoryLock(dirLockRoot, async () => {\n    const sourceStat = await pathStat(workflowPath);\n" });
      tools.applyEdit(copy, { file: 'persona-pipeline/files/scripts/state.mjs', from: '      if (recheck) {\n', to: '      if (false) {\n' });
      regenerate(copy);
    },
    killed_by: /archiveWorkflow re-checks on the read it makes under the file lock: a gate written while it waits for the lock keeps the workflow$/,
    why: 'the gates are re-checked before the locks, so a gate written while the archive waits for the file lock is archived (re-review)',
  },

  ...enrolled('scripts/session-handoff.mjs').map((persona) => ({
    id: `O9-${persona}`, tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "    awaiting_owner: `Resolve the pending owner gate",
      to: "    awaiting_owner_unused: `Resolve the pending owner gate",
      only: persona,
    }),
    why: `${persona}: the handoff of a workflow waiting on its owner names no resolving surface, only the unknown-gate fallback`,
  })),

  ...enrolled('scripts/state.mjs').map((persona) => ({
    id: `O19-${persona}`, tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  assertSettableOwnerGate(ownerGate.gate);\n",
      to: '',
      only: persona,
    }),
    why: `${persona}: the setters accept every gate a reader accepts, staging-set and pr-handling included`,
  })),
  {
    id: 'O10', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  if (current !== undefined && current !== fields.awaiting_owner_gate) {\n",
      to: "  if (false) {\n",
    }),
    why: "a second owner gate replaces the first, which is lost unresolved",
  },
  {
    id: 'O11', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  Object.assign(frontmatter, fields);\n  if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;\n",
      to: "  Object.assign(frontmatter, fields);\n",
    }),
    why: "a gate set on a terminal workflow leaves its marker on, in front of the Stop hook",
  },
  {
    id: 'O12', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  if (ownerGate !== undefined) {\n    const result = await appendPhase({\n",
      to: "  if (false) {\n    const result = await appendPhase({\n",
    }),
    why: "finish-verb with an owner gate makes the terminal write and records no gate",
  },
  {
    id: 'O13', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  if (ownerGate !== undefined) {\n    const result = await appendPhase({\n",
      to: "  if (ownerGate !== undefined || isAutopilotRun()) {\n    const result = await appendPhase({\n",
    }),
    why: "an inherited AGENTIC_AUTOPILOT suppresses a verb's terminal write (the acceptance case)",
  },
  {
    id: 'O14', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  'pr-handling': 'dispatch_target',\n",
      to: "",
    }),
    why: "pr-handling, an autopilot set point, can be set by a persona with dispatch_target off",
  },
  {
    id: 'O15', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  'staging-set': 'commit_surface',\n",
      to: "",
    }),
    why: "staging-set can be set by a persona with no commit surface to resolve it",
  },
  {
    id: 'O16', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  const stderr = mode.ignored ? `${mode.reason}\\n` : '';\n",
      to: "  const stderr = '';\n",
    }),
    why: "an inherited AGENTIC_AUTOPILOT is ignored silently: nobody learns the run is interactive",
  },
  {
    id: 'O17', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "    refuse: false,\n    stdout:\n",
      to: "    refuse: mode.ignored,\n    stdout:\n",
    }),
    why: "the preflight refuses a gated workflow under an inherited AGENTIC_AUTOPILOT, the on path leaking into the off one",
  },
  {
    id: 'O18', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "          clearNextStep: cliBoolean(flags, 'clear-next-step', false),\n",
      to: "          clearNextStep: false,\n",
    }),
    why: "append ignores --clear-next-step, so a resumed verb keeps the previous verb's next step",
  },
  {
    id: 'O19', tests: [T_S14],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "          clearTerminalMarker: cliBoolean(flags, 'clear-terminal-marker', false),\n",
      to: "          clearTerminalMarker: false,\n",
    }),
    why: "append ignores --clear-terminal-marker, so a refine that did not converge keeps an earlier verb's terminal marker and the Stop hook can archive it (PC2b U5b)",
  },
  {
    id: 'O20', tests: ['tests/persona-pipeline/test-start-lifecycle.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "          gate: flags.gate,\n          nextStep: cliNextStep(flags),\n",
      to: "          gate: flags.gate,\n          nextStep: undefined,\n",
    }),
    why: "awaiting-owner-clear drops the next step the owner's decision names, so a start lifecycle resumes with no phase to continue at (PC2b RV3: the lifecycle test must fail)",
  },

  // ---- E: ensemble settlement (PC2b) -----------------------------------------------
  ...enrolled('scripts/peer-runner.mjs').map((persona) => ({
    id: `E0-${persona}`, tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "      verdict: SETTLE_FAILED_VERDICT,\n      summary: `peer run ${handle.status}: error_kind=${handle.error_kind ?? 'none'}`,\n",
      to: "      verdict: verdict ?? SETTLE_FAILED_VERDICT,\n      summary: `peer run ${handle.status}: error_kind=${handle.error_kind ?? 'none'}`,\n",
      only: persona,
    }),
    why: `${persona}: a failed run is recorded under the verdict the agent passed`,
  })),
  {
    id: 'E1', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "      verdict: SETTLE_FAILED_VERDICT,\n      summary: `peer run ${handle.status}: error_kind=${handle.error_kind ?? 'none'}`,\n",
      to: "      verdict: verdict ?? SETTLE_FAILED_VERDICT,\n      summary: `peer run ${handle.status}: error_kind=${handle.error_kind ?? 'none'}`,\n",
    }),
    why: "a failed run is recorded under the verdict the agent passed, as if the peer had answered",
  },
  {
    id: 'E2', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "    if (pending.length > 0) {\n      refuse(",
      to: "    if (false) {\n      refuse(",
    }),
    why: "an empty run id skips although a pending entry shows a run launched, leaving the entry behind",
  },
  {
    id: 'E3', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "    const open = await unsettledAttempts({ repoRoot, workflowPath: wf, phase, results });\n",
      to: "    const open = [];\n",
    }),
    why: "an empty run id skips although the ledger holds an attempt whose pending registration failed",
  },
  {
    id: 'E4', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  if (row && row.ensemble_type !== handle.ensemble_type) {\n",
      to: "  if (false) {\n",
    }),
    why: "a pending entry and a ledger of different ensemble types are settled as one attempt",
  },
  {
    id: 'E5', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  if (typeof handle.workflow_path !== 'string' || resolve(handle.workflow_path) !== wf) {\n",
      to: "  if (false) {\n",
    }),
    why: "another workflow's run is settled into this one",
  },
  {
    id: 'E6', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  if (!isTerminalStatus(handle.status)) {\n    refuse(",
      to: "  if (false) {\n    refuse(",
    }),
    why: "a live run is settled before it is collected",
  },
  {
    id: 'E7', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  if (['queued', 'spawning', 'running', 'cancel_requested'].includes(handle.status)) {\n",
      to: "  if (['spawning', 'running', 'cancel_requested'].includes(handle.status)) {\n",
    }),
    why: "a runner killed before the spawn leaves a queued run that is never shown abandoned, so its attempt can never settle",
  },
  {
    id: 'E8', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  if (answer === null || answer.trim() === '') {\n",
      to: "  if (false) {\n",
    }),
    why: "a completed run with an empty answer is recorded under the agent's verdict, a peer verdict nobody gave",
  },
  {
    id: 'E9', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  if (verdict === SETTLE_FAILED_VERDICT) refuse(",
      to: "  if (false) refuse(",
    }),
    why: "a completed run is recorded as failed, the verdict reserved for a ledger failure",
  },
  {
    id: 'E10', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "    if (oldestKept !== null && isTerminalStatus(handle.status) && Date.parse(handle.completed_at) < Date.parse(oldestKept)) continue;\n",
      to: "",
    }),
    why: "a run settled and pruned from a full results list blocks every later skip",
  },
  // Review of code step 6 (PC2b): the settle races and the retention window.
  {
    id: 'E12', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "    if (oldestKept !== null && isTerminalStatus(handle.status) && Date.parse(handle.completed_at) < Date.parse(oldestKept)) continue;\n",
      to: "    if (oldestKept !== null && Date.parse(handle.completed_at) < Date.parse(oldestKept)) continue;\n",
    }),
    expect: 'SURVIVED',
    why: 'equivalent since the re-review judges by when a run ended: a non-terminal handle carries no completed_at, so the end-time comparison alone keeps an open attempt blocking; the status check is defense in depth',
  },
  {
    id: 'E13', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "        if (!['queued', 'spawning', 'running', 'cancel_requested'].includes(h.status)) return h;\n",
      to: "",
    }),
    killed_by: /reconcile never replaces a terminal status the runner wrote after the caller read the handle \(Review of code step 6\)$/,
    why: 'reconcile writes orphaned over a terminal status the runner wrote after the read, so a finished run settles failed',
  },
  {
    id: 'E14', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "  return { ...base, settlement, verdict: keptVerdict ?? verdict };\n}",
      to: "  return { ...base, settlement, verdict };\n}",
    }),
    killed_by: /two concurrent settles of a completed run report the verdict the workflow holds \(Review of code step 6\)$/,
    why: 'the settle that lost a race reports its own verdict, which the workflow does not hold',
  },
  // Re-review of the code-step-6 fixes.
  {
    id: 'E15', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "      const next = await updateHandle(paths.handle, (h) => {\n        if (isTerminalStatus(h.status)) return h;\n        h.status = shape.ok",
      to: "      const next = await updateHandle(paths.handle, (h) => {\n        h.status = shape.ok",
    }),
    killed_by: /reconcile through an envelope never replaces a terminal status already on disk \(re-review\)$/,
    why: 'a cancel that landed after the caller read the handle is overwritten as completed when an envelope exists',
  },
  {
    id: 'E16', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: '&& Date.parse(handle.completed_at) < Date.parse(oldestKept)) continue;',
      to: "&& typeof handle.started_at === 'string' && handle.started_at < oldestKept) continue;",
    }),
    killed_by: /a full results list does not hide a run that started before its oldest entry but ended after it \(re-review\)$/,
    why: 'a run that started before the oldest kept result but ended after it is taken as settled and pruned, so an empty run id skips it',
  },
  {
    id: 'E17', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: '    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted, kept };\n',
      to: '    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted };\n',
    }),
    killed_by: [/a repeated commit returns the entry already recorded, read under its lock \(re-review\)$/, /two concurrent settles of a completed run report the verdict the workflow holds \(Review of code step 6\)$/],
    why: 'the losing settle has no recorded verdict to report, so it reports its own again',
  },
  {
    id: 'E11', tests: [T_SETTLE],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/peer-runner.mjs',
      from: "      out.push(`${entry.name} (unreadable handle)`);\n",
      to: "",
    }),
    why: "an empty run id skips beside a handle it cannot read, which could be the attempt",
  },

  // ---- A: every target carries it; drift equality cannot see it ----------------
  {
    id: 'A1', tests: [T_CROSS, T_SYNC],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'adapters/claude/hooks/stop.mjs',
      from: '  const persona = hookPersona();\n  if (!persona) return 0;\n',
      to: '  const persona = hookPersona() ?? { name: \'unknown\' };\n',
    }),
    why: 'the Claude Stop hook stops validating the declaration first and sweeps with a broken one',
  },
  {
    id: 'A2', tests: [T_CROSS],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "    if (!personaOrRefuse('state.mjs')) {\n      process.exitCode = 1;\n      return;\n    }\n",
      to: '',
    }),
    why: 'state.mjs writes without validating the declaration at entry',
  },
  {
    id: 'A3', tests: [T_DECL, T_CROSS],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  if (plugin !== d.name) {',
      to: '  if (false) {',
    }),
    why: 'the loader accepts a declaration naming another plugin',
  },

  // ---- D: the drift check ---------------------------------------------------------
  {
    id: 'D1', tests: [T_SYNC], file: 'plugins/founder/scripts/state.mjs',
    from: "import { isCliEntry } from './lib/cli-entry.mjs';",
    to: "import { isCliEntry } from './lib/cli-entry.mjs'; // hand fix",
    why: 'a hand edit to a generated copy (the drift check must fail)',
  },
  {
    id: 'D2', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (regionBody(text, region) !== bodies[region.id]) {',
    to: '        if (false) {',
    why: 'the check stops comparing region bodies, so a hand edit inside a region passes',
  },
  {
    id: 'D3', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '    } else if (isExecutable(abs) !== item.executable) {',
    to: '    } else if (false) {',
    why: 'the check stops comparing the executable bit',
  },

  // ---- R: the review findings (Codex review of PC1) stay fixed -------------------------
  {
    id: 'R1', tests: [T_ENTRY],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: ENTRY.dest,
      from: '  if (claims.has(self)) return false;\n',
      to: '',
    }),
    why: 'two instances of one file both run the CLI under --preserve-symlinks-main (set-terminal ran twice)',
  },
  {
    id: 'R2', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  const problems = structureProblems(d, minor);\n',
      to: '  const problems = [];\n',
    }),
    why: 'a schema-invalid declaration (no decide object) still authorizes writes',
  },
  {
    id: 'R3', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        const link = symlinkOnPath(root, rel);\n        if (link !== null) {\n          fatal.push(`${rel}: refused — ${link} is a symlink`);\n          continue;\n        }\n        drift.push(`${rel}: owned output the manifest no longer generates`);',
    to: '        drift.push(`${rel}: owned output the manifest no longer generates`);',
    why: 'a deletion follows a symlinked persona directory out of the tree',
  },
  {
    id: 'R4', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '  atomicWrite(ledgerPath, renderLedger(owned), false);',
    to: '  writeFileSync(ledgerPath, renderLedger(owned));',
    why: 'the ledger is written through a symlink instead of replaced atomically',
  },
  {
    id: 'R5', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '      if (regionDests.get(persona)?.has(dest)) {',
    to: '      if (false) {',
    why: 'a whole-file output that now holds regions is deleted, authored text included',
  },
  {
    id: 'R6', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (reparsed.errors.length > 0 || !sameJson(reparsed.regions.map((r) => r.id), foundIds)) {',
    to: '        if (false) {',
    why: 'a render that breaks the region grammar is written',
  },

  // ---- G (PC2b): Phase 0 preflight and the resume clear -------------------------------
  {
    id: 'G30', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-phase-0.md',
      from: "  --workflow-path \"$ACTIVE\" --host \"${AGENTIC_HOST:-claude}\" || exit $?\n```",
      to: "  --workflow-path \"$ACTIVE\" --host \"${AGENTIC_HOST:-claude}\"\n```",
    }),
    why: "Phase 0 goes on after the preflight refused (a refusal no longer stops the block)",
  },
  {
    id: 'G31', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-phase-0.md',
      from: "node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" autopilot-preflight \\\n  --workflow-path \"$ACTIVE\"",
      to: "node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" autopilot-preflight \\\n  --workflow-path \"\"",
    }),
    why: "the preflight reads no workflow, so a pending owner gate is never put to the user",
  },
  {
    id: 'G32', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-resume.md',
      from: "  --clear-next-step true \\\n",
      to: "",
    }),
    why: "frame, decide and refine resume without clearing the previous verb's next step",
  },
  {
    id: 'G33', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-resume-profiled.md',
      from: "  --clear-next-step true \\\n",
      to: "",
    }),
    why: "compose, investigate and critique resume without clearing the previous verb's next step",
  },
  {
    id: 'G34', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/start-resume.md',
      from: "if [ \"$WF_TYPE\" = start ]; then",
      to: "if true; then",
    }),
    why: "start writes a verb-chain workflow it is about to refuse",
  },
  {
    id: 'G35', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/start-resume.md',
      from: "    --clear-next-step true --event resumed || exit $?\n",
      to: "    --clear-next-step true --event resumed\n",
    }),
    why: "start's lifecycle goes on after its resume clear failed",
  },

  {
    id: 'G36', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-dispatch.md',
      from: '  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"\n```',
      to: '  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &\n```',
    }),
    why: 'the generated dispatch detaches the runner with a shell &, out of reach of the host notification collection waits for (RV9)',
  },
  {
    id: 'G37', tests: [T_CONTRACT], file: 'plugins/founder/commands/critique.md',
    from: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"\n',
    to: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &\n',
    why: "founder critique's dispatch, edited in the runbook, detaches the runner with a shell & (RV9)",
  },
  // ---- G: PC2b U4b, the compose/frame/investigate/decide finalize ------------
  {
    id: 'G38', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?\n', to: '  --verdict "$VERDICT" --summary "$SUMMARY"\n' }),
    killed_by: verbCaught(/^the finalize, run: a settle refusal stops the block before finish-verb/),
    why: 'a refused settle no longer stops the block: the workflow closes with its ensemble attempt unsettled',
  },
  {
    id: 'G39', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '--phase {{verb}} --run-id "$RUN_ID" \\\n', to: "--phase {{verb}} --run-id '' \\\n" }),
    killed_by: verbCaught(FINALIZE_ORDER),
    why: 'settle is never given the run id, so every launched attempt is refused or, without a pending row, skipped',
  },
  {
    id: 'G40', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '  --next-step-kind verb --next-step-verb {{next_verb}} \\\n', to: '' }),
    killed_by: verbCaught(FINALIZE_ORDER),
    why: 'the terminal write records no closed-enum next step (finish-verb then refuses: the block fails at its last write)',
  },
  {
    id: 'G41', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '\n{{owner_gates}}\n', to: '\n' }),
    killed_by: verbCaught(FINALIZE_ORDER),
    why: 'the finalize no longer names the owner gates its verb may end with, nor their anchors',
  },
  {
    id: 'G42', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/decide-owner-selection.md', from: '"${NEXT_STEP[@]}" || exit $?\n', to: '"${NEXT_STEP[@]}"\n' }),
    killed_by: verbCaught(/^Owner selection, run: it finds the workflow, clears decide-conflict/, ['decide']),
    why: "decide's Owner selection finishes the verb even when the gate clear was refused",
  },
  // Review of code step 6: a gate met inside a start lifecycle is resolved there.
  {
    id: 'G61', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/decide-owner-selection.md', from: '|| exit $?\nif [ "$WF_TYPE" = start ]; then', to: '|| exit $?\nif false; then' }),
    killed_by: verbCaught(/^Owner selection, run: it finds the workflow, clears decide-conflict/, ['decide']),
    why: "decide's Owner selection finishes the verb on a start workflow, closing the lifecycle before compose, critique and refine",
  },
  {
    id: 'G62', tests: [T_CONTRACT],
    prepare: (copy, tools) => {
      for (const [template, indent] of [['regions/refine-owner-decision.md', ''], ['regions/refine-owner-decision-convergent.md', '  ']]) templateDefect(copy, tools, { template, from: `--next-step-kind commit --next-step-confidence HIGH || exit $?\n${indent}if [ "$WF_TYPE" = start ]; then`, to: `--next-step-kind commit --next-step-confidence HIGH || exit $?\n${indent}if false; then` });
    },
    killed_by: verbCaught(/^Owner decision, run: fix now clears recurring-finding/, ['refine']),
    why: "refine's deferral finishes the verb on a start workflow, closing the lifecycle before its terminal step",
  },
  {
    id: 'G43', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/decide-owner-selection.md', from: '--gate decide-conflict \\\n', to: '--gate scope-routing \\\n' }),
    killed_by: verbCaught(/^Owner selection, run: it finds the workflow, clears decide-conflict/, ['decide']),
    why: "decide's Owner selection clears a gate other than the one its Phase 2 records",
  },
  {
    id: 'G44', tests: ['tests/scripts/test-runbook-checks.mjs', T_CONTRACT],
    file: 'tests/_runbook-checks.mjs',
    from: 'new RegExp(`(?<![-\\\\w])${key}\\\\b`)',
    to: 'new RegExp(`\\\\b${key}\\\\b`)',
    killed_by: [/completionReenumerations: a key inside a CLI flag is no field mention/],
    why: 'the re-enumeration rule counts a CLI flag (--next-step-confidence) as a field mention again',
  },
  {
    id: 'G45', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-proposal.md', from: "  mention; for `commit`, the owner's save and commit, which nothing here\n  runs; for `done`, none; for `owner decision`, surfacing the decision to\n  the owner rather than a command to run.", to: "  mention; for `owner decision`, surfacing the decision to the owner rather\n  than a command to run." }),
    why: 'the routing contract offers commit and done without saying what each takes when there is no commit command',
  },
  {
    id: 'G46', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/files/scripts/state.mjs', from: '          // session-handoff sidecar.\n          emitHandoff: true,\n        });\n        if (result.terminal === false) {', to: '          // session-handoff sidecar.\n          emitHandoff: false,\n        });\n        if (result.terminal === false) {' });
      regenerate(copy);
    },
    killed_by: [/CLI finish-verb renders the footer on STDERR like set-terminal/],
    why: "finish-verb's terminal write no longer fires the handoff sidecar, so the runbooks' terminal write prints no footer",
  },
  // ---- G: PC2b U5a, critique's generated finalize and founder's generated dispatch ----
  {
    id: 'G47', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-dispatch.md', from: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n', to: '  --ensemble-type {{ensemble_type}} --run-id "$RUN_ID" \\\n' }),
    // designer's plugin-shape check of the dispatch's spelling was dropped with
    // C2 (E1 rule 3): designer's types are unchanged by the defect, and the
    // founder run below is what it breaks.
    killed_by: [inSuite('founder/commands/critique.md (committed)', /^founder critique, instantiated per profile/)],
    why: 'the dispatch names its type a second time: a red-team critique that sets ENSEMBLE_TYPE still dispatches review',
  },
  {
    id: 'G48', tests: [T_CONTRACT], file: 'plugins/founder/commands/critique.md',
    from: "point type: for `--profile=red-team`, set `ENSEMBLE_TYPE='adversarial-scan'`\nin it before running it, and build the prompt from §Adversarial-scan.\n",
    to: 'point type.\n',
    killed_by: [inSuite('founder/commands/critique.md (committed)', /^founder critique, instantiated per profile/)],
    why: 'founder critique no longer says how a red-team run changes the dispatched type (RV14)',
  },
  {
    id: 'G49', tests: [T_CHAR],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/manifest.json', from: '"next_verb": {\n          "value": "refine",', to: '"next_verb": {\n          "value": "critique",' });
      regenerate(copy);
    },
    why: "critique's terminal write records itself as the next verb instead of refine",
  },
  {
    id: 'G50', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-finalize-convergent.md', from: '  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?\n', to: '  --verdict "$VERDICT" --summary "$SUMMARY"\n' }),
    killed_by: [/^verb-finalize-convergent\.md: rebuilt from verb-finalize\.md and the variant's own lines, it is byte for byte the variant$/],
    why: 'the convergent finalize drifts from the plain one in a line they share: its settle no longer stops the block (PC2b U5b)',
  },
  {
    id: 'G51', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision.md', from: '  --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH || exit $?\n', to: '  --next-step-kind verb --next-step-verb critique --next-step-confidence HIGH || exit $?\n' }),
    killed_by: templateCaught('regions/refine-owner-decision.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: "the owner's fix-now decision names a re-critique as the next step instead of the refine that fixes the finding (PC2b U5b)",
  },
  {
    id: 'G52', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision.md', from: '  --next-step-kind commit --next-step-confidence HIGH || exit $?\nif [ "$WF_TYPE" = start ]; then', to: '  --next-step-kind commit --next-step-confidence HIGH\nif [ "$WF_TYPE" = start ]; then' }),
    killed_by: templateCaught('regions/refine-owner-decision.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: 'a refused clear of the recurring-finding gate no longer stops the deferral: the verb closes with the gate still set (PC2b U5b)',
  },
  // Review of code step 6 (finding 3): where the persona waits for
  // convergence, a deferral closes the verb only once converged.
  {
    id: 'G63', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision-convergent.md', from: 'if [ "${CONVERGED:-no}" = "yes" ]; then', to: 'if [ "${CONVERGED:-yes}" != "no" ]; then' }),
    killed_by: templateCaught('regions/refine-owner-decision-convergent.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: 'an unset or unfilled CONVERGED reads as converged, so a deferral that leaves the refinement unconverged closes the verb (fail-open)',
  },
  {
    id: 'G64', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision-convergent.md', from: '    --next-step-kind verb --next-step-verb "<refine|decide|investigate>" \\\n', to: '    --next-step-kind commit \\\n' }),
    killed_by: templateCaught('regions/refine-owner-decision-convergent.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: 'an unconverged deferral records commit as the next step, offering the owner a save of an artifact that did not converge',
  },
  {
    id: 'G65', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision-convergent.md', from: '    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\n  echo "→ PAUSED', to: '    --next-step-confidence "<HIGH|MEDIUM|LOW>"\n  echo "→ PAUSED' }),
    killed_by: templateCaught('regions/refine-owner-decision-convergent.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: 'a refused clear on the unconverged path is reported as a pause, with the gate still set',
  },
  {
    id: 'G66', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision-convergent.md', from: '  --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH || exit $?\n', to: '  --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH\n' }),
    killed_by: [/^refine-owner-decision-convergent\.md: rebuilt from refine-owner-decision\.md and the variant's own lines, it is byte for byte the variant$/],
    why: 'the convergent Owner decision drifts from the plain one in a line they share: its fix-now clear no longer stops the block',
  },
  // PC3b U1, peer review of step 1: the lifecycle stop is an exit; the type
  // read is checked on its own; the unconverged deferral replaces the gate's
  // next action too.
  {
    id: 'G67', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision.md', from: 'its refine phase fixes the finding." >&2\n  exit 0\n', to: 'its refine phase fixes the finding." >&2\n' }),
    killed_by: templateCaught('regions/refine-owner-decision.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: "Fix now inside a start lifecycle prints the resume message but falls through, so whatever follows the block runs before the lifecycle resumes",
  },
  {
    id: 'G68', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision.md', edits: [{ from: TYPE_READ_CHECKED, to: TYPE_READ_PIPED, count: 2 }] }),
    killed_by: templateCaught('regions/refine-owner-decision.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: "refine's owner blocks read the workflow type through a pipe again, so a read that fails after printing a parsable type lets the clear run",
  },
  {
    id: 'G69', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/decide-owner-selection.md', from: TYPE_READ_CHECKED, to: TYPE_READ_PIPED }),
    killed_by: verbCaught(/^Owner selection, run: it finds the workflow, clears decide-conflict/, ['decide']),
    why: "decide's Owner selection reads the workflow type through a pipe again, so a read that fails after printing a parsable type lets the clear run",
  },
  {
    id: 'G70', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/refine-owner-decision-convergent.md', from: '    --resolution "$RESOLUTION" --next-action "<what the next step resolves, in a few words>" \\\n', to: '    --resolution "$RESOLUTION" \\\n' }),
    killed_by: templateCaught('regions/refine-owner-decision-convergent.md', /^Owner decision, run: fix now clears recurring-finding/),
    why: "the unconverged deferral's clear keeps the gate's \"Owner: …\" next action",
  },
  {
    id: 'G53', tests: [T_CONTRACT],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/manifest.json', from: '"value": "- `recurring-finding` (heading `### Recurring finding`, anchor\\n  `recurring-finding`): a finding an earlier refine pass on this workflow\\n  already addressed survives verification again; fixing it again is the\\n  owner\'s call, and § Owner decision below resolves it.\\n- `scope-routing`', to: '"value": "- `scope-routing`', count: 2 });
      regenerate(copy);
    },
    killed_by: ['founder', 'designer'].map((p) => inSuite(`${p}/commands/refine.md (committed)`, FINALIZE_ORDER)),
    why: "refine's finalize no longer names the recurring-finding gate it may end with, or the Owner decision that resolves it (PC2b U5b)",
  },
  {
    id: 'G54', tests: [T_CHAR],
    prepare: (copy) => {
      // founder's refine finalize only (designer's variant carries the same value).
      const path = join(copy, 'persona-pipeline/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const sub = manifest.regions.find((r) => r.id === 'refine-finalize' && r.dest === 'commands/refine.md')?.substitutions?.verdicts;
      if (!sub || sub.value !== 'resolved|concerns|regression|conflict') throw new MutationHarnessError('refine-finalize: no verdicts value to edit');
      sub.value = 'agreed|concerns|conflict';
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      regenerate(copy);
    },
    why: "founder refine's synthesis verdicts lose resolved and regression, the outcomes a refine reports (the characterization must fail)",
  },
  {
    id: 'G55', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-terminal-convergent.md', from: "    --clear-terminal-marker true --event updated || exit $?\n", to: "    --event updated || exit $?\n" }),
    killed_by: templateCaught('regions/start-terminal-convergent.md', /^start terminal, run: /),
    why: 'a lifecycle that did not converge leaves a terminal marker an earlier write left on, so the Stop hook can archive the paused workflow (PC2b U5c, RV4)',
  },
  {
    id: 'G56', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-terminal.md', from: '  --next-step-kind commit --next-step-confidence', to: '  --next-step-kind done --next-step-confidence' }),
    killed_by: templateCaught('regions/start-terminal.md', /^start terminal, run: /),
    why: "the lifecycle closes with nothing left to do, where the owner's save and commit of the deliverable remains (PC2b U5c, DD3)",
  },
  {
    id: 'G57', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-terminal-convergent.md', from: '    --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\n', to: '    --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>"\n' }),
    killed_by: [/^start-terminal-convergent\.md: rebuilt from start-terminal\.md and the variant's own lines, it is byte for byte the variant$/],
    why: "the convergent start terminal drifts from the plain one in a line they share (PC2b U5c)",
  },
  {
    id: 'G58', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-phase-boundary.md', from: "- **No phase closes the workflow.** A verb's own terminal write\n  (`finish-verb`) never runs inside the lifecycle; the lifecycle's last step\n  below makes its one terminal write.\n", to: '' }),
    killed_by: templateCaught('regions/start-phase-boundary.md', /^start lifecycle: each phase boundary writes state and dispatches its ensemble, settles each attempt by run id, records and clears owner gates, and never runs a verb's finish-verb/),
    why: "the lifecycle no longer says a verb's own terminal write never runs inside it, so a decide that finishes closes the lifecycle mid-way (PC2b RV3)",
  },
  {
    id: 'G59', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: "settled from its run ledger (`peer-runner.mjs settle`) before the next phase,\na repeated phase under a new run id.", to: 'committed when the lifecycle ends.' }),
    killed_by: templateCaught('regions/skill-start-command-intro.md', /^start's intro gives the clean-baseline gate, the handoff commands, the accept flag and the lifecycle's calls$/),
    why: "the start skill says the lifecycle commits its ensembles at the end, where each phase's attempt is settled before the next (PC2b RV3)",
  },

  // PC2b U7: the off-capability negative tests, data-driven from the declaration.
  {
    id: 'O21', tests: [T_CROSS],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/stop-archive.mjs',
      from: "  // Gate 5 (ADR-0063 D6, ADR-0066 PC2b) — no owner gate pending. A workflow\n",
      to: "  if (process.env.AGENTIC_AUTOPILOT) gateFailures.push('autopilot');\n  // Gate 5 (ADR-0063 D6, ADR-0066 PC2b) — no owner gate pending. A workflow\n",
    }),
    killed_by: /dispatch_target off: (?:no generated surface but state\.mjs reads AGENTIC_AUTOPILOT, and no runbook line expands it|the Stop hook archives the same with and without an inherited AGENTIC_AUTOPILOT)$/,
    why: 'the Stop hook acts on an inherited AGENTIC_AUTOPILOT in a persona whose dispatch_target is off, and keeps a finished workflow (PC2b U7, ADR-0066 Decision 3)',
  },
  {
    id: 'G60', tests: [T_CROSS],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-finalize.md',
      from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \\\n  --workflow-path',
      to: '[ -n "${AGENTIC_AUTOPILOT:-}" ] || node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \\\n  --workflow-path',
    }),
    killed_by: /dispatch_target off: no generated surface but state\.mjs reads AGENTIC_AUTOPILOT, and no runbook line expands it$/,
    why: "a verb's finalize skips its terminal write when AGENTIC_AUTOPILOT is inherited, in a persona that is no autopilot dispatch target (PC2b U7)",
  },

  // ---- G: runbook region templates (PC2a) --------------------------------------------
  ...regionPersonas(CHECKPOINT_TARGET.template).map((persona) => ({
    id: `G1-${persona}`, tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { ...CHECKPOINT_TARGET, only: persona }),
    why: `${persona}: checkpoint writes to a workflow other than the one find-active found`,
  })),
  {
    id: 'G2', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/peer-now-dispatch.md',
      from: '  --peer "$PEER" $PROMPT_ARG --output-format text \\\n',
      to: '  --peer "$PEER" $PROMPT_ARG --image "$SCREENSHOT" --output-format text \\\n',
    }),
    why: 'peer-now passes a screenshot to a companion path that has no image channel (the no-image rule)',
  },
  {
    id: 'G3', tests: [T_CONTRACT, T_HEADLESS],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/locate-active.md',
      from: 'ROOT_OVERRIDE="$(printenv {{root_env}} || true)"',
      to: 'ROOT_OVERRIDE="$(printenv \'AGENTIC_ENGINEER_ROOT\' || true)"',
    }),
    why: 'a generated block honours another plugin\'s override — the driver would point it at the wrong plugin',
  },
  {
    id: 'G4', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/peer-now-dispatch.md',
      from: '  > "$RUN_JSON" 2> "$RUN_ERR"\nRUN_RC=$?\n',
      to: '  > "$RUN_JSON" 2> "$RUN_ERR"\nSTARTED=1\nRUN_RC=$?\n',
    }),
    why: 'the runner\'s exit code is no longer read right after it (a failed dispatch would read as success)',
  },
  {
    id: 'G5', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/resume-marker.md',
      from: '  --event resumed\n',
      to: '  --event updated\n',
    }),
    why: 'the resume marker stops recording a resumed event',
  },
  {
    id: 'G6', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "    if (sub.context === 'shell' && where !== 'word') {",
    to: '    if (false) {',
    why: 'a shell value is spliced inside "…", where a $(…) in it would run (Decision 4 placement)',
  },
  {
    id: 'G7', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "  if (rendered.includes('{{')) {",
    to: '  if (false) {',
    why: 'a "{{" left after rendering is written into a runbook',
  },
  {
    id: 'G8', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "      if (c === '$' && line[i + 1] === \"'\" && st.kind !== 'double') { stack.push({ kind: 'ansi' }); i += 2; continue; }\n",
    to: '',
    why: "the lexer reads $'…' as '…', so after an escaped quote a shell value counts as unquoted and its $(…) runs",
  },
  {
    id: 'G9', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "      if (c === '$' && line.startsWith('((', i + 1)) { stack.push({ kind: 'arith', depth: 0 }); i += 3; continue; }\n",
    to: '',
    why: 'the lexer reads $((…)) as $(…), so a shell value in an arithmetic expansion counts as unquoted (Codex review of PC2a)',
  },
  {
    id: 'G10', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "  if (placed.length !== (text.split('{{').length - 1) || JSON.stringify(placed.map((p) => p.name)) !== JSON.stringify(matched)) {",
    to: '  if (false) {',
    why: 'a "{{" the lexer stepped over (after a backslash, across lines) is replaced without a placement check (Codex review of PC2a)',
  },
  {
    id: 'G11', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "        if (!h) { heredocs.push({ delim: null, strip: false }); i += 2; continue; }\n        const delim = h[2] ?? h[3] ?? h[4].replace(/\\\\(.)/g, '$1');\n",
    to: "        if (!h || !/^[A-Za-z_]\\w*$/.test(h[2] ?? h[3] ?? h[4])) { i += 2; continue; }\n        const delim = h[2] ?? h[3] ?? h[4];\n",
    why: 'only identifier heredoc delimiters are read, so a body under <<1 or <<\'X-1\' counts as shell code (Codex review of PC2a)',
  },
  {
    id: 'G12', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/locate-active.md',
      from: 'ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n',
      to: 'OTHER="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n',
    }),
    why: 'find-active no longer sets the $ACTIVE the later writes target (Codex review of PC2a)',
  },
  {
    id: 'G13', tests: [T_HEADLESS, T_CONTRACT],
    prepare: (copy, tools) => {
      for (const template of RESOLVER_TEMPLATES) {
        // Every resolver line of the template (refine's Owner decision has two blocks).
        const count = readFileSync(join(copy, 'persona-pipeline', template), 'utf8').split('printenv {{root_env}} || true)').length - 1;
        tools.applyEdit(copy, { file: `persona-pipeline/${template}`, from: 'printenv {{root_env}} || true)', to: 'printenv {{root_env}})', count });
      }
      regenerate(copy);
    },
    why: 'an unset override fails the resolver under errexit again (Codex review of PC2a)',
  },
  {
    id: 'D4', tests: [T_SYNC], file: 'plugins/founder/commands/checkpoint.md',
    from: '--summary "$SUMMARY"',
    to: '--summary "$SUMMARY" --force',
    why: 'a hand edit inside a generated runbook region (the PC2a acceptance: the drift check must fail)',
  },

  // ---- V: declaration format 1.1 (PC2a2 T2) and list values (T1') -------------------
  {
    id: 'V1', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: 'const READER_MINOR = 4;',
      to: 'const READER_MINOR = 3;',
    }),
    why: 'the loader reads as 1.3 again and forgives an unknown scalar the schema refuses at the same minor (the readers disagree)',
  },
  {
    id: 'V2', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '!(newer && isScalar(obj[k]))',
      to: '!newer',
    }),
    why: 'a newer minor\'s unknown object or list is forgiven, so its meaning is silently dropped (ADR-0034 §4.1)',
  },
  {
    id: 'V3', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  if (d.verbs !== undefined) verbProblems(d.verbs, unknown, no);\n',
      to: '',
    }),
    why: 'the loader stops checking verbs, so a declaration the schema rejects (a newline in a next action) authorizes writes',
  },
  {
    id: 'V4', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: '    } else if (Array.isArray(v.profiles) && !v.profiles.includes(v.default_profile)) {',
    to: '    } else if (false) {',
    why: 'a verb\'s default profile off its own profile list passes the check',
  },
  {
    id: 'V5', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '      if (cur === undefined || cur === null) {',
    to: '      if (false) {',
    why: 'a declaration lacking a field an enrolled region reads is no longer its own failure (it surfaces only as a render error)',
  },
  {
    id: 'V6', tests: [T_VERBS], file: 'plugins/designer/commands/refine.md',
    from: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"\nif [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"\nif true; then',
    why: 'designer refine closes the workflow without a converged re-critique while its declaration says it waits for one (DD5)',
  },
  {
    id: 'V7', tests: [T_VERBS], file: 'plugins/founder/persona.json',
    from: '"next_action": "Compose the planning artifact for the chosen direction"',
    to: '"next_action": "Critique the decision"',
    why: 'the declared next action drifts from what founder decide records, so a region rendering it would change the runbook',
  },
  {
    id: 'K1', tests: [T_CHAR], file: 'plugins/founder/commands/compose.md',
    from: "ENSEMBLE_TYPE='plan-verify'\n",
    to: "ENSEMBLE_TYPE='brainstorm'\n",
    why: 'founder compose dispatches its ensemble under another type than the recorded one (the T0 characterization must fail; settle reads the type from the ledger since PC2b, so the dispatch is where it is named)',
  },
  {
    id: 'K2', tests: [T_CHAR], file: 'plugins/designer/commands/frame.md', expect: 'SURVIVED',
    from: "--persona 'designer' \\",
    to: '--persona designer \\',
    why: 'a quoting change alone (the generated literal \'designer\' read as the bare word it was) is not a difference the characterization reports',
  },
  // Codex review of PC2a2: each of these passed the first version of the tests.
  {
    id: 'K3', tests: [T_CHAR], file: 'plugins/founder/commands/compose.md',
    from: '  --phase-note "$NOTE" \\\n',
    to: '  --phase-note $NOTE \\\n',
    why: 'the phase note is passed unquoted, so the shell splits it into many arguments',
  },
  {
    id: 'K4', tests: [T_CHAR], file: 'plugins/founder/commands/compose.md',
    from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \\\n',
    to: '# node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \\\n',
    why: 'the dispatch is commented out, so no peer runs',
  },
  {
    id: 'K5', tests: [T_CHAR], file: 'plugins/founder/commands/decide.md',
    from: '  exit 1\nelif [ "$RESOLVE_RC" -ne 0 ]; then',
    to: 'elif [ "$RESOLVE_RC" -ne 0 ]; then',
    why: 'founder decide goes on after the resolver rejected its arguments',
  },
  {
    id: 'K6', tests: [T_CHAR], file: 'plugins/founder/commands/decide.md',
    from: `RUN_ID="\${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"`,
    to: "RUN_ID='${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)'",
    killed_by: /^does what the fixture recorded, with the listed changes/,
    why: 'founder decide single-quotes its run id, so the date never runs and the runner refuses the literal (Codex review of PC2a2b)',
  },
  // PC2a3 T0': critique, refine and start recorded before their regions.
  {
    id: 'K7', tests: [T_CHAR], file: 'plugins/designer/commands/refine.md',
    from: '    --clear-terminal-marker true --event updated || exit $?\n',
    to: '    --event updated || exit $?\n',
    why: 'designer refine\'s paused write leaves a terminal marker an earlier verb left on (its D2 guard went with PC2b U5b; the characterization must see the write)',
  },
  {
    id: 'K8', tests: [T_CHAR], file: 'plugins/founder/commands/start.md',
    from: '  *)\n    echo "✗ clean-baseline check returned an unrecognized status (\'$STATUS\') — refusing to bootstrap (fail-closed)." >&2\n    exit 1;;\n',
    to: '',
    why: 'founder start bootstraps on any baseline status it does not recognize (the gate fails open)',
  },
  {
    id: 'K9', tests: [T_CHAR], file: 'plugins/designer/commands/start.md',
    from: 'if [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'if [ "${CONVERGED:-yes}" = "yes" ]; then',
    why: 'designer start closes the lifecycle when its convergence was never established (the guard fails open)',
  },
  // PC2b RV7: each structural allowed difference checks the value it replaces.
  {
    id: 'K10', tests: [T_CHAR], file: 'tests/persona-pipeline/_verb-runbooks.mjs',
    from: "    strictEqual(next === undefined ? '' : callName(next), d.from, `${d.where}: insert-call finds ${JSON.stringify(d.from)} after it`);\n",
    to: '',
    why: 'insert-call no longer checks the call it goes before, so an entry written against another order inserts anywhere',
  },
  {
    id: 'K11', tests: [T_CHAR], file: 'tests/persona-pipeline/_verb-runbooks.mjs',
    from: '    strictEqual(args.filter(([f]) => f === m[4]).length, 0, `${d.where}: add-flag finds the flag absent`);\n',
    to: '',
    why: 'add-flag adds a flag the call already carries, so a runbook passing it twice still matches',
  },
  {
    id: 'K12', tests: [T_CHAR], file: 'tests/persona-pipeline/_verb-runbooks.mjs',
    from: '    deepStrictEqual(record.calls[at], d.from, `${d.where}: replace-call finds the call as recorded`);\n',
    to: '',
    why: 'replace-call swaps whatever call it finds, so a stale entry absorbs an argument change nobody listed',
  },
  {
    id: 'K13', tests: [T_CHAR], file: 'tests/persona-pipeline/_verb-runbooks.mjs',
    from: '    strictEqual(record.guards[m[1]], d.from, `${d.where}: null-guard finds the guard as recorded`);\n',
    to: '',
    why: 'null-guard drops a guard without reading it, so a guard that changed before it was removed goes unseen',
  },
  {
    id: 'K14', tests: [T_CHAR], file: 'tests/persona-pipeline/_verb-runbooks.mjs',
    from: "  if (typeof value === 'string') return value.split('{persona}').join(persona);\n",
    to: "  if (typeof value === 'string') return value;\n",
    why: 'a structural entry written for {persona} is applied with the placeholder left in, so it can match neither persona',
  },
  {
    id: 'V8', tests: [T_VERBS], file: 'plugins/designer/commands/refine.md',
    from: '  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \\\n    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \\\n    --next-action \'<compact',
    to: '  :; else\n  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \\\n    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \\\n    --next-action \'<compact',
    why: 'designer refine\'s terminal write moves to the else branch: it runs when the re-critique did not converge',
  },
  {
    id: 'V9', tests: [T_VERBS], file: 'plugins/designer/commands/refine.md',
    from: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"\nif [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"\nnode "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb --workflow-path "$ACTIVE"\nif [ "${CONVERGED:-no}" = "yes" ]; then',
    why: 'designer refine gains a second, unguarded terminal write next to the guarded one',
  },
  {
    id: 'V10', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  if (Buffer.byteLength(`${JSON.stringify(d, null, 2)}\\n`, \'utf8\') > MAX_BYTES) no(`larger than ${MAX_BYTES} bytes`);\n',
      to: '',
    }),
    why: 'the loader accepts a declaration over the 64 KiB cap the schema validator refuses',
  },
  {
    id: 'V11', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: "    for (const size of ['minor', 'standard', 'major']) {",
    to: '    for (const size of Object.keys(decide.size_presets ?? {})) {',
    why: 'the generator reads a newer minor\'s ignored scalar as a preset reference and refuses the declaration',
  },
  {
    id: 'V12', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  if (d.peer !== undefined) peerProblems(d.peer, unknown, no);\n',
      to: '',
    }),
    why: 'the loader stops checking peer, so a declaration the schema rejects (images "false", an absolute privacy spec) authorizes writes',
  },
  {
    id: 'V13', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: '      failures.push(`${where}: peer.privacy_spec names ${spec}, which plugins/${persona}/ does not hold`);\n',
    to: '',
    killed_by: /^fails on a privacy spec the plugin does not hold$/,
    why: 'a privacy spec the plugin does not hold passes, so the gate cites a file that is not there',
  },

  // ---- S: extension slots (PC2a3 DD6); W: variant regions (DD2) -------------
  {
    id: 'S1', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (after && before && !(ext.line > after.end && ext.line < before.begin)) {',
    to: '        if (false) {',
    why: 'an extension marker outside its two bounding regions passes, so an extension could follow the terminal write',
  },
  {
    id: 'S2', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (!slot.personas.includes(persona)) {\n          fatal.push(',
    to: '        if (false) {\n          fatal.push(',
    why: 'a persona places a marker in a slot it does not own',
  },
  {
    id: 'S3', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (count < slot.min || count > slot.max) {',
    to: '        if (count > slot.max) {',
    why: 'a required extension (designer\'s render and vision loop) drops out silently',
  },
  {
    id: 'S4', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (count < slot.min || count > slot.max) {',
    to: '        if (count < slot.min) {',
    why: 'a slot holds more markers than it takes, each inside the bounds',
  },
  {
    id: 'S5', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: '      if (order.indexOf(ext.after) >= order.indexOf(ext.before)) {',
    to: '      if (false) {',
    why: 'a slot whose bounds are swapped is accepted, so no marker can ever sit in it (or the bounds mean nothing)',
  },
  {
    id: 'W1', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '  failures.push(...variantEnrolmentFailures({ persona, declaration: d, regions, where }));\n',
    to: '',
    why: 'a variant region\'s enrollment drifts from the declared value it follows (a persona that may send images still gets the no-image rule, or one that may not loses it)',
  },
  {
    id: 'W2', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: '    } else if (value !== equals && enrolled) {',
    to: '    } else if (value != equals && enrolled) {',
    why: 'the variant rule compares loosely, so a declared 0 enrolls a persona in a region for false',
  },
  {
    id: 'L3', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: '  if (JSON.stringify(fenceLines(rendered)) !== JSON.stringify(fenceLines(text))) {',
    to: '  if (false) {',
    why: 'a list item "```bash" closes a markdown fence and opens a shell one, so a later markdown value lands in bash',
  },
  {
    id: 'L1', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: "    if (Array.isArray(value) && sub.context === 'shell') {",
    to: '    if (false) {',
    why: 'a list reaches a shell value: its lines are spliced into a shell block unquoted',
  },
  {
    id: 'L2', tests: [T_REGION], file: 'scripts/lib/persona-pipeline.mjs',
    from: '      if (Array.isArray(value) && /[\\n\\r\\0]/.test(item)) {',
    to: '      if (false) {',
    why: 'a list item holding a line break renders as more lines than the list declares',
  },

  // ---- M: the verb runbook regions (PC2a2b T8; PC2a2c adds investigate, decide) -----
  // A canonical template defect regenerates into both personas, and each case
  // names the contract that must catch it in both (killed_by), in every verb
  // runbook the template renders into: a nonzero exit from some other test is
  // not that contract working.
  {
    id: 'M1', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, edits: [
      { from: COMMIT_STEP, to: '' },
      { from: '  --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\n# The owner-decision form', to: `  --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\n\n${COMMIT_STEP.trimEnd()}\n# The owner-decision form` },
    ] }),
    killed_by: verbCaught(FINALIZE_ORDER),
    why: 'the terminal write runs before settle: the workflow archives with its ensemble attempt still unsettled',
  },
  {
    id: 'M2', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, edits: [
      { from: COMMIT_STEP, to: '' },
      { from: 'nothing was written." >&2; exit 1; }\n\nnode "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \\\n', to: `nothing was written." >&2; exit 1; }\n\n${COMMIT_STEP}node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \\\n` },
    ] }),
    killed_by: verbCaught(FINALIZE_ORDER),
    why: 'settle runs before the phase note is written',
  },
  {
    id: 'M3', tests: [T_CONTRACT],
    prepare: (copy, tools) => {
      for (const template of ['regions/verb-bootstrap.md', 'regions/verb-bootstrap-profiled.md']) {
        tools.applyEdit(copy, { file: `persona-pipeline/${template}`, from: ' skill")" || exit $?\n', to: ' skill")"\n' });
      }
      regenerate(copy);
    },
    killed_by: verbCaught(/^bootstrap and resume write the workflow Phase 0 found/),
    why: 'a failed create no longer stops the block: the verb runs on with an empty $ACTIVE (PD6)',
  },
  {
    id: 'M4', tests: [T_CONTRACT],
    prepare: (copy, tools) => {
      for (const template of ['regions/verb-resume.md', 'regions/verb-resume-profiled.md']) {
        tools.applyEdit(copy, { file: `persona-pipeline/${template}`, from: ' --event resumed || exit $?\n', to: ' --event resumed\n' });
      }
      regenerate(copy);
    },
    killed_by: verbCaught(/^bootstrap and resume write the workflow Phase 0 found/),
    why: 'a failed resume append no longer stops the block (PD6)',
  },
  {
    id: 'M5', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '  --event updated || exit $?\n', to: '  --event updated\n' }),
    killed_by: [...verbCaught(FINALIZE_ORDER), /^bash: the finalize block hands a hostile note to state\.mjs byte for byte/],
    why: 'a failed phase-note append no longer stops the block, which goes on to commit and archive (PD6; the run case shows it)',
  },
  {
    id: 'M6', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-phase-0.md', from: '  exit "$FIND_RC"\n', to: '' }),
    killed_by: verbCaught(/^Phase 0 stops on a detached HEAD before it finds the workflow into \$ACTIVE, and exits on a failed find$/),
    why: 'a failed find-active no longer stops Phase 0',
  },
  {
    id: 'M7', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-bootstrap-profiled.md', from: '--persona {{name}} \\', to: "--persona 'founder' \\" }),
    killed_by: [inSuite('designer/commands/compose.md (committed)', IDENTITY), inSuite('designer/commands/compose.md (assembled from the templates)', IDENTITY)],
    why: 'the bootstrap names one persona for every persona: designer compose creates founder workflows',
  },
  {
    id: 'M8', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-dispatch.md', from: 'RUN_ID="${ENSEMBLE_TYPE}-$(date', to: 'RUN_ID="ensemble-$(date' }),
    killed_by: templateCaught('regions/verb-dispatch.md', /^identity: persona, verb, phase, ensemble type and run-id prefix/),
    why: 'the run id no longer carries the ensemble type the dispatch and the commit name',
  },
  {
    id: 'M9', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-dispatch.md', from: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n', to: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" --image "$SCREENSHOT" \\\n' }),
    killed_by: templateCaught('regions/verb-dispatch.md', /^privacy: the prohibition sentence precedes the dispatch/),
    why: 'the dispatch passes a screenshot to a companion path that has no image channel',
  },
  // Dropped with C1 (E1 rule 3): M10 — the phase note's wording, which no program reads (the characterization fixture records it, C3's to judge).
  {
    id: 'M11', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: "NOTE <<'PHASE_NOTE' || true", to: 'NOTE <<PHASE_NOTE || true' }),
    // bash only: the suite runs the other shells only where they are installed.
    killed_by: [/^bash: the finalize block hands a hostile note to state\.mjs byte for byte/, ...verbCaught(HEREDOC)],
    why: 'the heredoc is unquoted: the shell expands $(…), backticks and $VARS in the note the agent wrote (the ADR-0059 class)',
  },
  {
    id: 'M12', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy) => {
      const path = join(copy, 'persona-pipeline/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const subs = manifest.regions.filter((r) => r.dest === 'commands/compose.md' && r.substitutions?.ensemble_type);
      // One since PC2b U5a: the dispatch names the type, the finalize no longer does.
      if (subs.length !== 1) throw new MutationHarnessError(`compose ensemble_type substitutions: ${subs.length}`);
      for (const r of subs) r.substitutions.ensemble_type.value = 'review';
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      regenerate(copy);
    },
    killed_by: [inSuite('founder/commands/compose.md (committed)', IDENTITY), inSuite('designer/commands/compose.md (committed)', IDENTITY)],
    why: 'the manifest gives compose another ensemble type; the expected one comes from the T0 map, not the manifest',
  },
  {
    id: 'M13', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy) => {
      const path = join(copy, 'persona-pipeline/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const swap = { compose: 'frame', frame: 'compose' };
      let swapped = 0;
      for (const r of manifest.regions.filter((x) => ['commands/compose.md', 'commands/frame.md'].includes(x.dest))) {
        if (r.substitutions?.verb) { r.substitutions.verb.value = swap[r.substitutions.verb.value]; swapped++; }
      }
      if (swapped !== 8) throw new MutationHarnessError(`verb substitutions swapped: ${swapped}`);
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      regenerate(copy);
    },
    killed_by: [inSuite('founder/commands/frame.md (committed)', IDENTITY), inSuite('designer/commands/compose.md (committed)', IDENTITY)],
    why: 'compose and frame swap their verb values: each runbook runs the other verb',
  },
  // PC2a3 QD4: the prohibition and the no-image rule are generated (the
  // privacy-gate templates, the per-verb sentence a manifest value); the
  // screenshot sentences stay designer's authored text after the regions.
  {
    id: 'M14', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: PRIVACY_GATE, from: '{{genericize}}\n', to: '' }),
    killed_by: privacyCaught(PRIVACY_GATE),
    why: 'the privacy gate template drops the per-verb prohibition: no verb says the pre-genericization value never leaves the host',
  },
  {
    id: 'M35', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: NO_IMAGE_RULE, from: 'No dispatch passes `--image`:', to: 'A dispatch may pass `--image`:' }),
    killed_by: privacyCaught(NO_IMAGE_RULE),
    why: 'the no-image rule no longer forbids an image to the peer, in every persona that declares images off',
  },
  {
    id: 'M15', tests: [T_CONTRACT], file: 'plugins/designer/commands/frame.md',
    from: '**Screenshots are sensitive by default**',
    to: 'Screenshots may be shared',
    killed_by: inSuite('designer/commands/frame.md (committed)', PRIVACY),
    why: 'designer frame loses the screenshot sentence before its dispatch (authored text outside the regions)',
  },
  // The repository-wide gates' rules (T4a), run on the assembled runbook too.
  {
    id: 'M16', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the\n', to: '# On Claude the Stop hook fires when the session ends, so the\n' }),
    killed_by: verbCaught(/^the shared runbook checks hold/),
    why: 'the terminal write\'s archive-timing note says the gates wait for the session end (the disproved claim)',
  },
  {
    id: 'M17', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '- rationale:             <why best', to: '- reasoning:             <why best' }),
    killed_by: verbCaught(/^the shared runbook checks hold/),
    why: 'the phase note\'s next-action proposal loses its canonical rationale key',
  },
  // Codex review of PC2a2b: each of these passed the reviewed version of the tests.
  {
    id: 'M18', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }\n', to: '' }),
    killed_by: [/^dash: a shell whose read has no -d stops the finalize block before any write/, ...verbCaught(HEREDOC)],
    why: 'a shell whose read has no -d records an empty note and archives the workflow',
  },
  {
    id: 'M19', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-phase-0.md', from: '  exit "$FIND_RC"\nfi\n', to: '  exit "$FIND_RC"\nfi\nACTIVE=""\n' }),
    killed_by: verbCaught(/^Phase 0, run: \$ACTIVE holds what find-active printed/),
    why: 'Phase 0 discards the workflow find-active found, so every verb bootstraps a new one',
  },
  {
    id: 'M20', tests: [T_CONTRACT], file: 'plugins/founder/commands/compose.md',
    from: 'Empty `$ACTIVE` → bootstrap with verb=compose:', to: 'Non-empty `$ACTIVE` → bootstrap with verb=compose:',
    killed_by: inSuite('founder/commands/compose.md (committed)', /^the authored conditions route an empty \$ACTIVE to the bootstrap/),
    why: 'founder compose bootstraps a new workflow over the one it found (authored text outside the regions)',
  },
  {
    id: 'M21', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: 'so when the note itself holds\nsuch a line, replace both `PHASE_NOTE` delimiters with a word no line of the\nnote consists of.', to: 'so keep it short.' }),
    killed_by: verbCaught(HEREDOC),
    why: 'the agent is no longer told to rename a delimiter its note holds: such a note runs its tail as shell',
  },

  // ---- M: the investigate runbook regions (PC2a2c T8) ------------------------------
  // The template cases above now also name investigate (verbCaught). These are
  // the defects only investigate has: the ensemble type and both note labels
  // come from its declaration, and its privacy sentences are its own.
  {
    id: 'M22', tests: [T_CONTRACT, T_CHAR, T_VERBS],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'plugins/designer/persona.json', from: '"ensemble_type": "reference-scan"', to: '"ensemble_type": "research-scan"' });
      regenerate(copy);
    },
    killed_by: [inSuite('designer/commands/investigate.md (committed)', IDENTITY), /^does what the fixture recorded, with the listed changes/],
    why: 'designer declares founder\'s investigate ensemble type: dispatch, commit, run id and note all follow it, so only the T0 map catches it',
  },
  {
    id: 'M23', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy) => {
      const path = join(copy, 'persona-pipeline/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const region = manifest.regions.find((r) => r.id === 'investigate-finalize');
      if (!region) throw new MutationHarnessError('no investigate-finalize region');
      [region.substitutions.launched, region.substitutions.synthesis] = [region.substitutions.synthesis, region.substitutions.launched];
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      regenerate(copy);
    },
    killed_by: [/(?:^| > )founder\/investigate > does what the fixture recorded, with the listed changes/, /(?:^| > )designer\/investigate > does what the fixture recorded, with the listed changes/],
    why: 'investigate\'s note headings swap the ensemble type and the profile (the launch line names the brief, the synthesis the scan)',
  },
  {
    id: 'M24', tests: [T_CONTRACT],
    prepare: (copy) => genericizeDefect(copy, 'investigate', 'Genericize or remove proprietary content from the topic and sub-questions before WebSearch / WebFetch or peer dispatch; only the genericized form leaves the local host. ', ''),
    killed_by: verbCaught(PRIVACY, ['investigate']),
    why: 'investigate\'s manifest sentence loses the web-search prohibition, in both personas',
  },
  {
    id: 'M25', tests: [T_CONTRACT], file: 'plugins/designer/commands/investigate.md',
    from: '**Screenshots are sensitive by default** — a raw screenshot of a real UI is\nnever sent to web search or the peer;',
    to: 'Screenshots may be shared with the peer;',
    killed_by: inSuite('designer/commands/investigate.md (committed)', PRIVACY),
    why: 'designer investigate loses the screenshot sentence before its dispatch (authored text outside the regions)',
  },
  {
    id: 'D6', tests: [T_SYNC], file: 'plugins/designer/commands/investigate.md',
    from: "  --ensemble-type \"$ENSEMBLE_TYPE\" --run-id \"$RUN_ID\" \\\n  > \"$PROMPT_FILE.run.json\"",
    to: "  --ensemble-type \"$ENSEMBLE_TYPE\" --run-id \"$RUN_ID\" --model gpt-x \\\n  > \"$PROMPT_FILE.run.json\"",
    killed_by: /^the repository is clean$/,
    why: 'a hand edit inside a generated region of investigate.md (the drift check must fail)',
  },

  // ---- M: the decide runbook regions (PC2a2c T8) ------------------------------------
  // Phase 0.5 (decide-resolve) is decide's own region; the template cases
  // above name decide too.
  {
    id: 'M26', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: RESOLVE, from: 'fix the invocation and rerun." >&2\n  exit 1\n', to: 'fix the invocation and rerun." >&2\n' }),
    killed_by: [...verbCaught(PHASE_05_RUN, ['decide']), /^guards: detached HEAD and find-active failures exit; decide also exits on both resolver failures/],
    why: 'decide goes on to the dispatch after the resolver rejected its arguments',
  },
  {
    id: 'M27', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: RESOLVE, from: '--args-file "$ARGS_DIR/args.json"\nRESOLVE_RC=$?\n', to: '--args-file "$ARGS_DIR/args.json"\necho "resolved" >&2\nRESOLVE_RC=$?\n' }),
    killed_by: verbCaught(PHASE_05_RUN, ['decide']),
    why: 'the resolver\'s status is read after another command, so a rejected argument list reads as success',
  },
  {
    id: 'M28', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: RESOLVE, from: 'resolve --args-file "$ARGS_DIR/args.json"\n', to: 'resolve -- "$(cat "$ARGS_DIR/args.json")"\n' }),
    killed_by: verbCaught(/^Phase 0\.5: the args-file pins hold/, ['decide']),
    why: 'the resolver gets the typed text through the shell again instead of the args file (ADR-0059)',
  },
  // Dropped with C1 (E1 rule 3): M29 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'M30', tests: [T_CONTRACT],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/decide-registry.mjs', from: '    if (presetId) {\n', to: '    if (presetId !== undefined) {\n' }),
    killed_by: verbCaught(/^Phase 0\.5: the args-file pins hold/, ['decide']),
    why: 'an empty --preset= is treated as an unknown preset (flag and diagnostic), so the measured behavior no longer matches the prose',
  },
  // Codex review of PC2a2c: each of these passed the reviewed version of the tests.
  {
    id: 'M33', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '# value the shell inherited must not stand in for the note.\nunset NOTE\n', to: '# value the shell inherited must not stand in for the note.\n' }),
    killed_by: [/^dash: a shell whose read has no -d stops the finalize block before any write/, ...verbCaught(HEREDOC)],
    why: 'a NOTE the shell inherited stands in for the note a shell without read -d could not take, and is recorded and archived',
  },
  {
    id: 'M34', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: RESOLVE, from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve', to: 'exec >/dev/null\nnode "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve' }),
    killed_by: verbCaught(PHASE_05_RUN, ['decide']),
    why: 'the resolved context never reaches the block\'s output, so the skill body has nothing to read',
  },
  {
    id: 'M31', tests: [T_CONTRACT],
    prepare: (copy) => genericizeDefect(copy, 'decide', '; the pre-genericization value MUST never leave the local host.', '.'),
    killed_by: verbCaught(PRIVACY, ['decide']),
    why: 'decide\'s manifest sentence drops "MUST never leave the local host", in both personas',
  },
  {
    id: 'M32', tests: [T_CONTRACT], file: 'plugins/designer/commands/decide.md',
    from: '**Screenshots are sensitive by default** and are never sent to the peer as\nbytes',
    to: 'Screenshots may be sent to the peer as\nbytes',
    killed_by: inSuite('designer/commands/decide.md (committed)', PRIVACY),
    why: 'designer decide loses the screenshot sentence before its dispatch (authored text outside the regions)',
  },
  // ---- M: refine (PC2a3 U4): generated blocks, authored finalize, two slots ---------
  {
    id: 'M36', tests: [T_CONTRACT],
    prepare: (copy) => {
      // The finalize block moves above the second extension marker: the
      // marker stays in its slot, so only the QD8 contract can see it.
      const path = join(copy, 'plugins/designer/commands/refine.md');
      const text = readFileSync(path, 'utf8');
      const block = /\n```bash\n(?:(?!```)[\s\S])*?peer-runner\.mjs" settle \\\n[\s\S]*?\n```\n/.exec(text);
      const marker = '<!-- pipeline:extension refine-convergence-bound -->\n';
      if (!block || !text.includes(marker)) throw new MutationHarnessError('designer refine: no finalize block or marker');
      // Function replacements: the block holds `$'`, which a string
      // replacement would expand (Codex review of PC2a3: it corrupted the block,
      // so the case died on "one block" before the ordering check).
      const moved = text.replace(block[0], () => '\n').replace(marker, () => `${block[0].slice(1)}\n${marker}`);
      if (moved.split(block[0].slice(1)).length !== 2 || moved.indexOf(block[0].slice(1)) > moved.indexOf(marker)) {
        throw new MutationHarnessError('designer refine: the finalize block did not move whole above the marker');
      }
      writeFileSync(path, moved);
    },
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^the finalize follows the finalize heading region, every extension and the dispatch$/)],
    why: 'designer refine\'s terminal write moves above its convergence-bound extension: the extension now follows the terminal write',
  },
  {
    id: 'M37', tests: [T_CONTRACT],
    prepare: (copy) => {
      const path = join(copy, 'plugins/designer/commands/refine.md');
      const text = readFileSync(path, 'utf8');
      const para = /\*\*Bounded convergence \(no unbounded loop\)\.\*\*[\s\S]*?\n\n/.exec(text);
      if (!para) throw new MutationHarnessError('designer refine: no bounded-convergence paragraph');
      writeFileSync(path, text.replace(para[0], ''));
    },
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^each extension holds the instructions its slot exists for$/)],
    why: 'designer refine keeps the extension marker but loses the bounded-convergence text it stands for',
  },
  {
    id: 'M38', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-finalize-convergent.md', from: "    --clear-terminal-marker true --event updated || exit $?\n", to: "    --event updated || exit $?\n" }),
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^refine finalize, run: /)],
    why: 'a refine that did not converge leaves a terminal marker an earlier verb left on, so the Stop hook can archive the unresolved workflow (PC2b U5b, RV4)',
  },
  {
    id: 'M39', tests: [T_CONTRACT], file: 'plugins/designer/commands/refine.md',
    from: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"\nif [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"\nif [ "${CONVERGED:-yes}" = "yes" ]; then',
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^refine finalize, run: /)],
    why: 'designer refine closes the workflow when CONVERGED was never assigned (the guard fails open)',
  },
  // ---- M: critique (PC2a3 U5; PC2b U5a generates founder's dispatch and both finalizes) ----
  {
    id: 'M40', tests: [T_CONTRACT], file: 'plugins/founder/commands/critique.md',
    from: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n  > "$PROMPT_FILE.run.json"',
    to: '  --ensemble-type \'review\' --run-id "$RUN_ID" \\\n  > "$PROMPT_FILE.run.json"',
    killed_by: [inSuite('founder/commands/critique.md (committed)', /^founder critique, instantiated per profile/)],
    why: 'founder critique dispatches review for red-team too: the adversarial scan never reaches the peer (QD5)',
  },
  // M41 (founder critique committed a red-team result under another type) is
  // gone with PC2b U5a: settle names no type, it reads the ledger's.
  // Dropped with C1 (E1 rule 3): M42 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'M43', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-finalize-convergent.md', from: "  node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" append \\\n    --workflow-path \"$ACTIVE\" --host \"${AGENTIC_HOST:-claude}\" \\\n    --current-phase phase-2-presented \\\n", to: "  node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" set-terminal \\\n    --workflow-path \"$ACTIVE\" --host \"${AGENTIC_HOST:-claude}\" \\\n    --terminal-phase summary-complete \\\n" }),
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^refine finalize, run: /)],
    why: 'a refine that did not converge closes the workflow anyway: its paused write becomes a terminal write (PC2b U5b, DD5)',
  },
  // ---- M: start (PC2a3 U6): the clean-baseline bootstrap and the workflow_type read ----
  {
    id: 'M44', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: '  *)\n    echo "✗ clean-baseline check returned an unrecognized status (\'$STATUS\') — refusing to bootstrap (fail-closed)." >&2\n    exit 1;;\n', to: '' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: /),
    why: 'start bootstraps on an empty, unknown or unparsable baseline status (the wildcard rejection is gone: the gate fails open)',
  },
  {
    id: 'M45', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: '; exit "$BASELINE_RC"\n', to: '\n' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: /),
    why: 'a failed clean-baseline check no longer stops start\'s bootstrap',
  },
  {
    id: 'M46', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-resume.md', from: 'JSON.parse(s).workflow_type||"verb-chain"', to: 'JSON.parse(s).workflow_type||"start"' }),
    killed_by: templateCaught('regions/start-resume.md', /^start resume, run: /),
    why: 'a workflow without the discriminator reads as start, so start absorbs a verb-chain workflow',
  },
  {
    id: 'M47', tests: [T_CONTRACT],
    prepare: (copy) => {
      const path = join(copy, 'plugins/designer/commands/start.md');
      const text = readFileSync(path, 'utf8');
      const from = text.indexOf('**The archetype is NOT durable state');
      const to = text.indexOf('Two hazards this closes.');
      if (from < 0 || to < from) throw new MutationHarnessError('designer start: no archetype carry text');
      writeFileSync(path, text.slice(0, from) + text.slice(to));
    },
    killed_by: [inSuite('designer/commands/start.md (committed)', /^start: the terminal write follows every extension/)],
    why: 'designer start keeps its archetype marker but loses the inline AGENTIC_DESIGNER_PROFILE carry it stands for',
  },
  // ---- M: the SKILL.md regions (PC2a3 U7, T7): one group of templates at a time -----
  {
    id: 'M48', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-checkpoint-set.md', from: '  --workflow-path "$ACTIVE" --host', to: '  --workflow-path "$WORKFLOW" --host' }),
    killed_by: templateCaught('regions/skill-checkpoint-set.md', /^the checkpoint is written to the workflow Phase 1 found/),
    why: 'the checkpoint skill writes its summary to a workflow Phase 1 never found',
  },
  {
    id: 'M49', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-checkpoint-set.md', from: 'state.mjs" checkpoint-set \\', to: 'state.mjs" checkpoint-put \\' }),
    killed_by: templateCaught('regions/skill-checkpoint-set.md', /^every state\.mjs subcommand a generated section names/),
    why: 'the checkpoint skill names a state.mjs subcommand that does not exist',
  },
  {
    id: 'M50', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-checkpoint-command-resolution.md', from: 'If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. ', to: '' }),
    killed_by: templateCaught('regions/skill-checkpoint-command-resolution.md', /^the command-resolution table has one Plugin root row/),
    why: 'the Codex plugin-root cell no longer says how to recover the injected path after compaction',
  },
  {
    id: 'M51', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-peer-now-dispatch.md', from: '  > "$RUN_JSON" 2> "$RUN_ERR"\nRUN_RC=$?', to: '  > "$RUN_JSON" 2> "$RUN_ERR" &\nRUN_RC=$?' }),
    killed_by: templateCaught('regions/skill-peer-now-dispatch.md', /^the dispatch is synchronous/),
    why: 'peer-now runs the peer in the background and reads the exit code of the launch, not of the run',
  },
  {
    id: 'M52', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-peer-now-dispatch.md', from: '; stop without appending a phase note and\nexit non-zero.', to: '.' }),
    killed_by: templateCaught('regions/skill-peer-now-dispatch.md', /^the dispatch is synchronous/),
    why: 'a failed peer-now run no longer stops before the phase note',
  },
  {
    id: 'M53', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-resume-marker.md', from: 'via `state.mjs append --event resumed`', to: 'via `state.mjs append --event updated`' }),
    killed_by: templateCaught('regions/skill-resume-marker.md', /^the resume marker is a host-history append/),
    why: 'the resume skill records its marker as an ordinary update',
  },
  {
    id: 'M54', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-decide-approval-gate.md', from: '**Wait for the user to choose a direction** — do not proceed without\nexplicit approval.', to: 'Proceed with the recommended direction.' }),
    killed_by: templateCaught('regions/skill-decide-approval-gate.md', /^decide waits for the user's explicit choice/),
    why: 'decide proceeds without the user\'s choice',
  },
  // Dropped with C1 (E1 rule 3): M55, M56 — the text restated what a script does, which that script's own tests run.
  // PC2a3 U7(b): the privacy gate critique, refine and start state in SKILL.md,
  // the runbooks' template with the spec cited from the skill's directory.
  {
    id: 'M57', tests: [T_SKILL],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'scripts/lib/persona-pipeline.mjs', from: 'derived.skill_privacy_spec = `../${posix.relative(', to: 'derived.skill_privacy_spec = `${posix.relative(' });
      regenerate(copy);
    },
    killed_by: templateCaught(PRIVACY_GATE, SKILL_PRIVACY, isSkill),
    why: 'the skill privacy gate cites its spec relative to core/skills, so the path read from a skill\'s directory leads nowhere',
  },
  {
    id: 'M58', tests: [T_SKILL],
    prepare: (copy) => genericizeDefect(copy, 'critique', '; the pre-genericization value MUST never leave the local host.', '.', 'core/skills/critique/SKILL.md'),
    killed_by: [inSuite('founder/core/skills/critique/SKILL.md (committed)', SKILL_PRIVACY), inSuite('designer/core/skills/critique/SKILL.md (committed)', SKILL_PRIVACY)],
    why: 'the critique skill\'s gate no longer says the pre-genericization value never leaves the host (the manifest value)',
  },
  {
    id: 'M59', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: NO_IMAGE_RULE, from: 'No dispatch passes `--image`:', to: 'A dispatch may pass `--image`:' }),
    killed_by: templateCaught(NO_IMAGE_RULE, SKILL_PRIVACY, isSkill),
    why: 'the skills\' no-image rule no longer forbids an image to the peer',
  },
  {
    id: 'M60', tests: [T_SKILL], file: 'plugins/designer/core/skills/refine/SKILL.md',
    from: 'and is **never sent\nto the peer as inline image bytes**',
    to: 'and is **sent\nto the peer as inline image bytes**',
    killed_by: inSuite('designer/core/skills/refine/SKILL.md (committed)', SKILL_PRIVACY),
    why: 'designer refine\'s skill keeps its screenshot label but now sends the screen to the peer as bytes (authored text after the regions)',
  },
  // Codex review of PC2a3 (code step 3): each of these passed the reviewed tests.
  // Dropped with C1 (E1 rule 3): M61 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'M62', tests: [T_SYNC], file: 'plugins/designer/core/skills/start/SKILL.md',
    from: '<!-- pipeline:extension start-archetype -->\n', to: '',
    killed_by: /^the repository is clean$/,
    why: 'designer start\'s skill drops its required archetype extension (the slot takes one)',
  },
  {
    id: 'M63', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-verb-present.md', from: 'and confirm before downstream verbs.', to: 'and continue to the next verb.' }),
    killed_by: templateCaught('regions/skill-verb-present.md', /^compose confirms before any downstream verb/),
    why: 'compose no longer confirms its artifact before a downstream verb',
  },
  {
    id: 'M64', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-compose-state-write.md', from: 'This skill itself does not write workflow state.', to: 'This skill writes workflow state.' }),
    // The defect is in the commit_surface-off branch; engineer's skill records
    // its manifest itself and says so (PC3b U3, N60).
    killed_by: templateCaught('regions/skill-compose-state-write.md', /^compose confirms before any downstream verb/).filter((r) => !/engineer/.test(r.source)),
    why: 'the compose skill claims to write workflow state itself',
  },
  {
    id: 'M65', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-resume-dirty-enrichment.md', from: 'If the baseline commit object is not available, skip all four probes\nand tell the user', to: 'If the baseline commit object is not available, run the probes anyway\nand tell the user' }),
    killed_by: templateCaught('regions/skill-resume-dirty-enrichment.md', /^the resume marker is a host-history append/),
    why: 'resume runs its git probes against a baseline that is not there',
  },
  {
    id: 'M66', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-checkpoint-set.md', from: ' --summary "$SUMMARY"\n```', to: '\n```' }),
    killed_by: templateCaught('regions/skill-checkpoint-set.md', /^the checkpoint is written to the workflow Phase 1 found/),
    why: 'the checkpoint call loses the summary state.mjs requires',
  },
  {
    id: 'M67', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-peer-now-dispatch.md', from: '--run-id "$RUN_ID" --kind peer-now \\', to: '--run-id "$RUN_ID" --kind ensemble \\' }),
    killed_by: templateCaught('regions/skill-peer-now-dispatch.md', /^the dispatch is synchronous/),
    why: 'peer-now dispatches as an ensemble run, which the runner books against the workflow',
  },
  {
    id: 'M68', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-phase-boundary.md', from: 'Each phase boundary writes state via', to: 'No phase boundary writes state via' }),
    killed_by: templateCaught('regions/start-phase-boundary.md', /^start lifecycle: /),
    why: 'start stops writing state at its phase boundaries',
  },
  // Dropped with C1 (E1 rule 3): M69 — the text restated what a script does, which that script's own tests run.
  {
    id: 'M70', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: 'if [ "$BASELINE_RC" -ne 0 ]; then', to: 'if [ "$BASELINE_RC" -ne 0 ] && [ -z "$BASELINE" ]; then' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: /),
    why: 'a failed clean-baseline check that printed a clean status creates the workflow',
  },
  // Dropped with C1 (E1 rule 3): M71 — paragraph order the finalize block's own inputs already force (its note and verdict come from the synthesis).
  {
    id: 'M72', tests: [T_CONTRACT], file: 'plugins/designer/commands/refine.md',
    from: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"', to: 'CONVERGED="yes"',
    killed_by: inSuite('designer/commands/refine.md (committed)', /^refine finalize, run: /),
    why: 'designer refine\'s terminal block assigns convergence instead of taking it from the re-critique',
  },
  {
    id: 'M73', tests: [T_CONTRACT],
    prepare: (copy) => genericizeDefect(copy, 'investigate', ' If the topic cannot be genericized without losing the question, run local-only or abort at scoping.', ''),
    killed_by: verbCaught(PRIVACY, ['investigate']),
    why: 'investigate loses its fail-closed fallback when a topic cannot be genericized',
  },
  {
    id: 'M74', tests: [T_CONTRACT],
    // The bootstrap block's line (PC3b U2: the commit_surface probe block sets
    // its own, so the anchor names the PERSONA line before it).
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: 'PERSONA={{name}}\nREPO_ROOT="$(git rev-parse --show-toplevel)"\n', to: 'PERSONA={{name}}\n' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: /),
    why: 'start\'s bootstrap relies on a REPO_ROOT a fresh shell does not have',
  },
  {
    id: 'M75', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: '} else if (!statSync(real).isFile()) {', to: '} else if (false) {',
    killed_by: /^fails on a privacy spec that is a directory$/,
    why: 'the generator accepts a directory as the privacy spec',
  },
  {
    id: 'M76', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: "if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {", to: "if (inside === '') {",
    killed_by: /^fails on a privacy spec that is a link leading out of the plugin$/,
    why: 'the generator follows a privacy-spec link out of the plugin',
  },
  {
    id: 'M77', tests: [T_VERBS],
    prepare: (copy) => {
      const path = join(copy, 'plugins/designer/persona.json');
      const d = JSON.parse(readFileSync(path, 'utf8'));
      d.verbs.critique.profiles = [...d.verbs.critique.profiles, 'bogus-lens'];
      writeFileSync(path, `${JSON.stringify(d, null, 2)}\n`);
      regenerate(copy);
    },
    killed_by: /(?:^| > )designer: the declared verb fields are what the runbooks say > critique: the argument hint names the declared profiles/,
    why: 'designer declares a critique lens its runbook never offers',
  },
  {
    id: 'D7', tests: [T_SYNC], file: 'plugins/designer/commands/decide.md',
    from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --args-file "$ARGS_DIR/args.json"\n',
    to: 'node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve --args-file "$ARGS_DIR/args.json" --strict\n',
    killed_by: /^the repository is clean$/,
    why: 'a hand edit inside the generated Phase 0.5 region of decide.md (the drift check must fail)',
  },
  {
    id: 'D5', tests: [T_SYNC], file: 'plugins/founder/commands/compose.md',
    from: "  --next-step-kind verb --next-step-verb 'critique' \\\n",
    to: "  --next-step-kind verb --next-step-verb 'critique' --force \\\n",
    killed_by: /^the repository is clean$/,
    why: 'a hand edit inside a generated region of compose.md (the drift check must fail)',
  },

  // ---- X: shared-reference regions (PC2a4) ------------------------------------------
  {
    id: 'X1', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-preflight-intro.md', from: '## Session-Level Continue-vs-Fresh Preflight (ADR-0031)', to: '## Session-Level Preflight (ADR-0031)' }),
    killed_by: /every in-plugin citation resolves, and its § names a heading of the target$/,
    why: 'the contract loses the preflight heading the session handoff cites (D6)',
  },
  {
    id: 'X2', tests: [T_REF],
    // PC2b DD7: a commit_surface-off persona offers `commit` (the owner
    // publishes); the defect is a proposal that sends it to a commit command.
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-proposal.md', from: '  fixed table. A {{persona}} workflow has no commit command: `commit` means\n  the owner saves, commits or publishes the {{deliverable_noun}}, and `done`', to: '  fixed table. `commit` runs `/{{persona}}:commit`, and `done`' }),
    killed_by: /the capability text agrees with the declaration$/,
    why: 'the proposal of a persona whose commit_surface is off sends commit to a commit command it does not have',
  },
  {
    id: 'X3', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-routes.md', from: 'can be carried from idea to its saved artifact on the current branch.', to: 'can be carried from idea to commit on the current branch.' }),
    killed_by: /the routing templates keep each claim under its capability, in every legal combination \(PC3b U5b\) > dispatch_target false, commit_surface false, legacy_homes (?:true|false)$/,
    why: 'the start route promises a commit to a persona whose commit_surface is off',
  },
  {
    id: 'X4', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-routes.md', from: 'dispatches its subtasks into engineer only, so a {{deliverable_noun}} inside it runs through `/{{persona}}:start` on its own branch.', to: 'dispatches its subtasks into {{persona}}.' }),
    killed_by: /the capability text agrees with the declaration$/,
    why: 'the orchestrator row claims dispatch into a persona whose dispatch_target is off',
  },
  {
    id: 'X5', tests: [T_REF], file: 'plugins/founder/core/skills/_shared/references/entry-routing-contract.md',
    from: '§ Entry routing recommendation\n(before Phase 1)', to: '§ Entry routing advice\n(before Phase 1)',
    killed_by: /(?:^| > )committed: every in-plugin citation resolves, and its § names a heading of the target$/,
    why: 'an authored citation names a § its target does not hold',
  },
  {
    id: 'X6', tests: [T_REF], file: 'plugins/founder/core/skills/investigate/SKILL.md',
    from: '- selected_next:         <verb | commit | done | owner decision>', to: '- selected_next:         <verb | commit | done | owner decision | publish>',
    killed_by: /the capability text agrees with the declaration$/,
    why: "founder's investigate proposal offers a next step outside the closed vocabulary finish-verb records (RV5; retargeted in PC2b U6b, where commit and done joined the vocabulary)",
  },
  {
    id: 'X7', tests: [T_REF], file: 'plugins/designer/core/skills/investigate/SKILL.md',
    from: '- selected_next:         <verb | commit | done | owner decision>', to: '- selected_next:         <verb | commit | done | owner decision | merge>',
    killed_by: /the capability text agrees with the declaration$/,
    why: "designer's investigate proposal offers a next step outside the closed vocabulary finish-verb records (RV5; retargeted in PC2b U6b, where commit and done joined the vocabulary)",
  },
  // Dropped with C1 (E1 rule 3): X8, X9 — the text restated what a script does, which that script's own tests run.
  {
    id: 'X10', tests: [T_REF, T_CODEX],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-lens.md', from: 'Codex injects the mentioned skill with its absolute path, and', to: 'Codex hands the agent the mentioned skill, and' }),
    killed_by: /each pointer to the checkpoint table carries the mechanism inside its own passage, in every plugin that has one$/,
    why: 'the lens keeps a valid citation of the checkpoint table but loses where the Codex root comes from (RV9)',
  },

  // Dropped with C1 (E1 rule 3): X11, X12 — presentation pacing prose or its citation; the autopilot no-ask rule stays pinned.
  {
    id: 'X13', tests: [T_REF, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)\n', to: '' }),
    killed_by: /does what the fixture recorded, with the listed changes/,
    why: 'the finalize note drops its citation of the entry-routing contract (RV4)',
  },
  // Dropped with C1 (E1 rule 3): X14 — presentation pacing prose or its citation; the autopilot no-ask rule stays pinned.
  {
    id: 'X15', tests: [T_ARCH],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/handoff-wiring.md', from: 'The Stop hook fires at **every turn end**, so the archive gates', to: 'The Stop hook fires at **session close**, so the archive gates' }),
    killed_by: /every shared reference carries the canonical archive-timing section$/,
    why: "the handoff's archive-timing section loses the same-turn fact (RD6)",
  },
  {
    id: 'X16', tests: [T_REF], file: 'scripts/lib/persona-pipeline.mjs',
    from: ": `${briefProfile.split('-').join('_')}.md`;", to: ": briefProfile.split('-').join('_');",
    killed_by: /the output-file rules name the brief file and output root the declaration implies \(RD7\)$/,
    why: 'derived.brief_file loses its .md, so the assembled output-file rules name a file the investigate verb never writes',
  },
  {
    id: 'X17', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: '    if (named.length !== 1 || named[0] !== briefFile) {', to: '    if (false) {',
    killed_by: /fails on an investigate artifact naming another brief file$/,
    why: 'the brief_file cross-field rule is dropped (RD7)',
  },
  // Dropped with C1 (E1 rule 3): X18 — a citation's wording, past what the resolution check reads.

  {
    id: 'X19', tests: [T_REF], file: 'plugins/founder/core/skills/investigate/SKILL.md',
    from: '- selected_next:         <verb | commit | done | owner decision>', to: '- selected_next:         commit',
    killed_by: /the capability text agrees with the declaration$/,
    why: 'a proposal block offers a literal commit next step instead of the placeholder (Plan-verify of code step 1)',
  },
  {
    id: 'X20', tests: [T_REF], file: 'plugins/founder/core/skills/_shared/references/entry-routing-contract.md',
    from: '§ Entry routing recommendation\n(before Phase 1)', to: '§ Entry routing recommendation\n(nonexistent section)',
    killed_by: /(?:^| > )committed: every in-plugin citation resolves, and its § names a heading of the target$/,
    why: "a citation keeps a heading's title but names a subtitle it does not have (Plan-verify of code step 1)",
  },
  {
    id: 'X21', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-lens.md', from: 'so an incidental in-verb branch resolves\n  with no `--size` and the profile carried inline', to: 'so an incidental in-verb branch uses\n  `--size=minor` with the profile carried inline' }),
    killed_by: /the lens's default size keeps a profile preset where the persona has one$/,
    why: "the lens's default --size=minor drops designer's archetype preset (Plan-verify of code step 1)",
  },

  {
    id: 'X22', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-launch-privacy.md', from: '{{privacy_scope}}\npass an explicit privacy gate before BOTH web search AND peer-host\ndispatch. Genericize before constructing the prompt (step 3).\n', to: '{{privacy_scope}}.\nGenericize before constructing the prompt (step 3).\n' }),
    killed_by: /the ensemble Launch gates the declared privacy scope before any dispatch, and claims no gate without one \(RD5, PC3b U5c\)$/,
    why: "the ensemble Launch step loses its privacy-gate prohibition before the dispatch step (RD5)",
  },
  {
    id: 'X23', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-collect.md', from: '2. Read the peer-runner JSON first. Its', to: '2. Read `envelope_path` for the parsed companion envelope, then\n   read the peer-runner JSON first. Its' }),
    killed_by: /the ensemble Collect reads the runner result before any envelope, in the runner's own terms \(RV10\)$/,
    why: 'the Collect step reads the envelope before the runner result, which may name none (RV10)',
  },
  // Dropped with C1 (E1 rule 3): X24 — prose no program reads and no run, order, stop or hand-off depends on.
  // Dropped with C1 (E1 rule 3): X25 — the text restated what a script does, which that script's own tests run.
  {
    id: 'X26', tests: [T_REF], file: 'plugins/founder/core/skills/peer-now/SKILL.md',
    from: '(`--workflow-path /\n--phase / --ensemble-type`)', to: '(`--workflow-path /\n--phase / --ensemble-type / --run-id`)',
    killed_by: /(?:^| > )founder: reference contracts > committed: the peer-now skill omits exactly the accounting flags its dispatch omits, and the dispatch passes --run-id$/,
    why: "founder's peer-now skill lists --run-id among the flags it omits, which its dispatch passes (RV7)",
  },
  {
    id: 'X27', tests: [T_REF], file: 'plugins/designer/core/skills/_shared/references/ensemble-protocol.md',
    from: '**Screenshots are sensitive by default**: the privacy gate below covers\nevery screenshot that would inform the peer, before any dispatch.\n\n', to: '',
    killed_by: /the ensemble Launch gates the declared privacy scope before any dispatch, and claims no gate without one \(RD5, PC3b U5c\)$/,
    why: "designer's screenshot sentence no longer precedes the Launch dispatch step (RV8)",
  },

  {
    id: 'X28', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-collect.md', from: '2. Read the peer-runner JSON first. Its', to: "2. Read the JSON envelope from the companion's stdout. Its" }),
    killed_by: /the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches \(RD8, RV10\)$/,
    why: "the brief ensemble's Step 2 reverts to reading the envelope from the companion's stdout (RV10)",
  },
  // Dropped with C1 (E1 rule 3): X29 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'X30', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/orchestration-failure.md', from: "If any local analysis fails to return (timeout, error, or empty result):\nnotify the user which perspective failed, ask retry-or-proceed, follow the\nuser's decision, and if proceeding note the missing perspective in the\nsynthesis so the user knows coverage was incomplete. ", to: '' }),
    killed_by: /committed: the orchestration failure handling stops to ask on a failed local analysis and never blocks on a peer failure$/,
    why: "orchestration.md's failure handling drops the local-analysis case (RD9)",
  },
  // Dropped with C1 (E1 rule 3): X31 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    // C1 critique: re-added; the agent re-dispatches before inspecting, under
    // a run id the runner refuses (E1 rule 2).
    id: 'X32', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-state.md', from: 'Inspect that run before dispatching again:', to: 'The next session must re-dispatch (the helper is idempotent on `run_id`\nso duplicate entries do not accumulate). Inspect that run before\ndispatching again:' }),
    killed_by: /the brief recovery inspects the run before a retry, in the runner's terms \(RV11\)$/,
    why: "the brief recovery regains the false 'idempotent on run_id' claim and sends the agent to re-dispatch before it inspects the run (RV11)",
  },
  {
    id: 'X33', tests: [T_REF], file: 'plugins/designer/core/skills/investigate/references/design-brief-ensemble.md',
    from: '**Screenshots are sensitive by default** and are never sent to the peer\nas inline bytes (see "Vision boundary" above): the privacy gate below gates\nthem before any dispatch.\n\n', to: '',
    killed_by: /the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches \(RD8, RV10\)$/,
    why: "designer's brief screenshot sentence no longer precedes the dispatch step (RV8)",
  },

  {
    id: 'X34', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-collect.md', from: "not the peer's answer. When `envelope_path` is null there is no\n   envelope to read, and the run degrades to local-only: `error_kind`\n   says why —", to: "not the peer's answer. `error_kind` names a failure —" }),
    killed_by: /the ensemble Collect reads the runner result before any envelope, in the runner's own terms \(RV10\)$/,
    why: "the protocol's Collect loses the null-envelope branch (Plan-verify of code step 2)",
  },
  {
    id: 'X35', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-collect.md', from: "not the peer's answer. When `envelope_path` is null there is no\n   envelope to read, and the run degrades to local-only: `error_kind`\n   says why —", to: "not the peer's answer. `error_kind` names a failure —" }),
    killed_by: /the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches \(RD8, RV10\)$/,
    why: "the brief's Collect loses the null-envelope branch (Plan-verify of code step 2)",
  },
  {
    id: 'X36', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-state.md', from: 'A retry takes a fresh run id, since the runner refuses a `run_id` whose\nledger already exists.', to: 'A retry reuses the same run id, which the runner resumes.' }),
    killed_by: /the brief recovery inspects the run before a retry, in the runner's terms \(RV11\)$/,
    why: 'the brief recovery retries under the old run id, which the runner refuses (Plan-verify of code step 2)',
  },
  // Dropped with C1 (E1 rule 3): X37, X38 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'X39', tests: [T_REF], file: 'plugins/designer/commands/critique.md',
    from: '# ADR-0066 PC2b — settle the ensemble attempt from its ledger', to: 'if [ -n "${RUN_ID:-}" ]; then :; fi\n# ADR-0066 PC2b — settle the ensemble attempt from its ledger',
    killed_by: /no runbook guards ensemble-commit on shell variables, and the protocol says settle decides from the run ledger instead \(D2, PC2b U5b\)$/,
    why: "designer's critique guards its finalize on a shell variable again, the D2 shape settle replaced (Plan-verify of code step 2)",
  },
  {
    id: 'X40', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-peer-now-dispatch.md', from: '--run-id "$RUN_ID" --kind peer-now \\', to: '--run-id "$RUN_ID" --kind peer-now --phase peer-now \\' }),
    killed_by: /committed: the peer-now skill omits exactly the accounting flags its dispatch omits, and the dispatch passes --run-id$/,
    why: 'the peer-now dispatch passes an ensemble-accounting flag its skill says it omits (Plan-verify of code step 2)',
  },
  {
    id: 'X41', tests: [T_STOP, T_REF],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/stop-archive.mjs', from: "    if (refState !== 'absent') continue; // unknown → leave", to: '    continue; // unknown → leave' }),
    killed_by: /archives a terminal workflow whose baseline branch was deleted \(orphan\)$/,
    why: "the off-branch sweep stops archiving a deleted branch's workflow while its comment, which the preflight contract reads, still says it does (Review of code step 3)",
  },
  {
    id: 'X42', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-lens.md', from: 'env "${PROFILE_VAR}=<profile>" node "<plugin-root>/scripts/decide-registry.mjs" resolve\n', to: 'env "${PROFILE_VAR}=<profile>" node "<plugin-root>/scripts/decide-registry.mjs" resolve --size=minor\n' }),
    killed_by: /the lens's default size keeps a profile preset where the persona has one$/,
    why: "the profile persona's lens call passes a --size, which drops the profile's preset (Review of code step 3)",
  },
  {
    id: 'X43', tests: [T_REF],
    prepare: (copy, tools) => tools.applyEdit(copy, { file: 'plugins/designer/core/skills/refine/SKILL.md', from: '(the `scripts/decide-registry.mjs resolve` resolver, with the active profile in', to: '(the `scripts/decide-registry.mjs resolve --size=minor` resolver, with the active profile in' }),
    killed_by: /the lens's default size keeps a profile preset where the persona has one$/,
    why: "an authored designer skill's lens call goes back to --size=minor, against its contract (Review of code step 3)",
  },
  // Dropped with C1 (E1 rule 3): X44 — a citation's wording, past what the resolution check reads.
  // Dropped with C1 (E1 rule 3): X45 — presentation pacing prose or its citation; the autopilot no-ask rule stays pinned.
  // Dropped with C1 (E1 rule 3): X46 — the text restated what a script does, which that script's own tests run.
  {
    id: 'X47', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-state.md', from: "settled: cancel the old run if it is still live, then settle it with\n`peer-runner.mjs settle --run-id <old run_id>`, whether the step retries\nor proceeds local-only.", to: "settled: settle it with `state.mjs ensemble-commit` and a verdict that\nsays the run was abandoned, whether the step retries or proceeds\nlocal-only." }),
    killed_by: /the brief recovery inspects the run before a retry, in the runner's terms \(RV11\)$/,
    why: 'the brief recovery has the agent commit an abandoned attempt with a verdict it picks again, where settle reads it from the ledger (PC2b RV5)',
  },
  {
    id: 'X48', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-failure-unavailable.md', from: "- **Action**: Proceed with orchestrator-only analysis, silently. A run the\n  runner started settles as verdict `failed` with this `error_kind`\n  (`peer-runner.mjs settle`); with no run launched there is nothing to\n  settle.", to: "- **Action**: Skip the dispatch silently. Proceed with orchestrator-only\n  analysis." }),
    killed_by: /the protocol's collect step and each failure action settle the attempt from its run ledger \(RV5\)$/,
    why: 'the protocol tells the agent to skip an unavailable peer by hand again, leaving the attempt the runner started unsettled (PC2b RV5)',
  },
  {
    id: 'X49', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-collect.md', from: " Either way the finalize settles the attempt from its run\n   ledger (`peer-runner.mjs settle`), which records what the ledger shows:\n   verdict `failed` with its `error_kind`, `degraded` for a completed run\n   with no usable answer, or the synthesis verdict.", to: "" }),
    killed_by: /the protocol's collect step and each failure action settle the attempt from its run ledger \(RV5\)$/,
    why: 'the collect step no longer says a failed or empty run is settled from its ledger (PC2b RV5)',
  },

  // PC2b U6b (DD8): the gate and next-step tables bound to state.mjs, and
  // finish-verb named as the terminal write where an agent reads.
  {
    id: 'X50', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-owner-gates.md', from: "| `recurring-finding` | `/{{persona}}:refine`: a finding an earlier refine pass on this workflow already addressed survives verification again | `Recurring finding` · `recurring-finding` | the owner's fix-now-or-defer in `/{{persona}}:refine` (its Owner decision step clears the gate) |\n", to: '' }),
    killed_by: /the owner-gates and next-step tables agree with this persona's state\.mjs \(PC2b DD8\)$/,
    why: 'the gate table loses a gate the persona can set, so an agent meeting a recurring finding finds no heading, anchor or resolving surface for it (PC2b DD8)',
  },
  {
    id: 'X51', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-owner-gates.md', from: "`staging-set` belongs to a commit command, and {{persona}} declares\n`commit_surface` off, so `state.mjs` refuses to set it, naming the capability.\n", to: '' }),
    killed_by: /the routing templates keep each claim under its capability, in every legal combination \(PC3b U5b\) > dispatch_target false, commit_surface false, legacy_homes (?:true|false)$/,
    why: 'the contract stops saying a gate the persona cannot set is refused (PC2b DD2/DD8)',
  },
  {
    id: 'X52', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-proposal.md', from: "| `done` | `done` | absent |\n", to: '' }),
    killed_by: /the owner-gates and next-step tables agree with this persona's state\.mjs \(PC2b DD8\)$/,
    why: 'the closed-enum map drops a kind finish-verb accepts (PC2b DD8)',
  },
  {
    id: 'X53', tests: [T_REF],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { dest: 'scripts/state.mjs', from: '(gate) => !Object.hasOwn(CAPABILITY_OWNER_GATES, gate) || capabilityOn(CAPABILITY_OWNER_GATES[gate]),', to: '(gate) => true || capabilityOn(CAPABILITY_OWNER_GATES[gate]),' }),
    killed_by: /the owner-gates and next-step tables agree with this persona's state\.mjs \(PC2b DD8\)$/,
    why: 'state.mjs lets a persona set the capability gates its documents say it refuses: the table is checked against the code, not a restated list (PC2b DD8)',
  },
  // Dropped with C1 (E1 rule 3): X54, X55 — the text restated what a script does, which that script's own tests run.
  {
    id: 'X56', tests: [T_REF], file: 'plugins/founder/core/skills/refine/SKILL.md',
    from: '- selected_next:         <verb | commit | done | owner decision>',
    to: '- selected_next:         <verb | owner decision>',
    killed_by: /the skills and the runbooks name finish-verb as the terminal write \(PC2b DD8\)$/,
    why: "a verb skill's proposal offers a narrower vocabulary than its runbook records (authored text, PC2b DD8)",
  },
  {
    id: 'X57', tests: [T_REF], file: 'plugins/designer/core/skills/start/SKILL.md',
    from: 'node "<plugin-root>/scripts/state.mjs" finish-verb \\\n',
    to: 'node "<plugin-root>/scripts/state.mjs" set-terminal \\\n',
    killed_by: /the skills and the runbooks name finish-verb as the terminal write \(PC2b DD8\)$/,
    why: "designer start's skill writes the lifecycle's terminal state through set-terminal again (authored text, PC2b DD8)",
  },

  // Review of code step 6 (finding 7): settle cannot tell an answer of
  // structural shell from a real one, so the agent passes degraded.
  {
    id: 'X58', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-finalize.md', from: 'An answer that parses to nothing usable, only structural\nshell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.\n', to: '' }),
    killed_by: /the skills and the runbooks name finish-verb as the terminal write \(PC2b DD8\)$/,
    why: 'the finalize no longer says what verdict an answer of structural shell takes, so the agent records a peer verdict for a peer that said nothing',
  },
  {
    id: 'X59', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-failure-empty.md', from: ' `settle` sees\n  an empty or unreadable answer itself; an answer that parses to no\n  findings, only structural shell, reads to it like any other, so pass\n  `degraded` as the synthesis verdict then.', to: '' }),
    killed_by: /the protocol's collect step and each failure action settle the attempt from its run ledger \(RV5\)$/,
    why: "the protocol's empty-output action leaves an answer of structural shell to settle, which records the agent's verdict for it",
  },
  {
    id: 'X60', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-failure.md', from: ' `settle` sees\n  an empty or unreadable answer itself; an answer that parses to only\n  structural shell reads to it like any other, so pass `degraded` as the\n  synthesis verdict then.', to: '' }),
    killed_by: /committed: the brief ensemble's failure handling settles each attempt, passes degraded for an empty answer and never blocks the save$/,
    why: "the brief's empty-output action leaves an answer of structural shell to settle, which records the agent's verdict for it",
  },
  {
    id: 'X61', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-bookkeeping.md', from: ' An answer that parses to\n  nothing usable, only structural shell, reads to `settle` like any other:\n  the synthesis judges it, and its verdict is then `degraded`.', to: '' }),
    killed_by: /no runbook guards ensemble-commit on shell variables, and the protocol says settle decides from the run ledger instead \(D2, PC2b U5b\)$/,
    why: 'the bookkeeping section says settle alone decides degraded, hiding the answer of structural shell the synthesis must judge',
  },

  // ---- N: engineer converges (PC3) — a canonical defect regenerated into every --------
  // target fails an engineer contract test: the capability-on paths engineer runs
  // live only in the canonical source now (ADR-0066 Decision 5, Stage 3).
  {
    id: 'N1', tests: ['tests/persona-pipeline/test-autopilot-verbs.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  if (named && capabilityOn('dispatch_target') && host === 'claude') {\n",
      to: '  if (false) {\n',
    }),
    killed_by: [/^engineer: autopilot-preflight \(ADR-0063 D4\) > /, /^engineer: finish-verb \(ADR-0063 D3\) > /],
    why: 'the autopilot on path is gone: engineer runs every autopilot step interactively, so a verb closes the workflow the driver leaves open for /engineer:commit',
  },
  {
    id: 'N2', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "  const publishNeeded = !capabilityOn('commit_surface')\n",
      to: '  const publishNeeded = true\n',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > completion-flag minimum content \(completion-output contract\) > maps only-head_moved-unmet to blocked with the commit as its unblocking action/,
    why: "engineer's terminal that waits for its commit is reported as the owner's manual publish (D4)",
  },
  {
    id: 'N3', tests: ['tests/persona-pipeline/test-handoff-backstop.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '    ? [defaultProjectionFile(repoRoot), legacyProjectionFile(repoRoot)]\n',
      to: '    ? [defaultProjectionFile(repoRoot)]\n',
    }),
    killed_by: /^engineer: SessionStart handoff backstop \(ADR-0043 S3\/S4\) > re-injects \+ consumes a LEGACY-home pending handoff/,
    why: 'a pre-migration workflow\'s pending handoff is never re-surfaced (legacy_homes, D4)',
  },
  {
    id: 'N4', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "  } else if (phase === 'close-complete') {\n",
      to: "  } else if (phase === 'no-such-phase') {\n",
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > completion-flag minimum content \(completion-output contract\) > a close-complete workflow blocked on head_moved names the no-changes close/,
    why: 'an interrupted no-changes close is told to commit, though HEAD is not meant to move (D4)',
  },
  {
    id: 'N5', tests: ['tests/persona-pipeline/test-commit-surface.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/phase7-commit.mjs',
      from: '  const autopilot = autopilotActivation({ env: process.env, host: flags.host });\n',
      to: "  const autopilot = { active: /^autopilot-/.test(process.env.AGENTIC_AUTOPILOT ?? ''), reason: null };\n",
    }),
    killed_by: /^engineer: the commit driver's autopilot activation matches state's \(ADR-0066 Decision 3\) > on Codex: /,
    why: "the commit driver treats any named run as autopilot, so on Codex it refuses the execute and close that engineer's state, ignoring the run, tells the user to run",
  },
  {
    id: 'N6', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "          origin: 'primary',\n",
      to: '',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > CLI: re-running set-terminal with the same phase and next action renders the footer again$/,
    why: "the terminal write's emit is a backstop: a re-terminalization with the same phase and next action renders no footer (D4)",
  },
  {
    id: 'N7', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "          '--workflow-projection-file', snapshotFile,\n",
      to: "          '--workflow-projection-file', projectionFile,\n",
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > renders from its own snapshot: /,
    why: "the footer reads the mutable slot, so a concurrent cross-branch emit's projection mixes into this emit's footer (D4)",
  },
  {
    id: 'N8', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "        resolveRender(await deliverToStderr(textRun.stdout.endsWith('\\n') ? textRun.stdout : `${textRun.stdout}\\n`));\n",
      to: "        deliverToStderr(textRun.stdout.endsWith('\\n') ? textRun.stdout : `${textRun.stdout}\\n`);\n        resolveRender(true);\n",
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a footer whose stderr write fails after it returned counts as not rendered/,
    why: 'a footer accepted by the stream but never delivered counts as rendered, so the SessionStart nudge is suppressed (D4)',
  },
  {
    id: 'N9', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  return transition === undefined || marker.transition === undefined || marker.transition === transition;\n',
      to: '  return true;\n',
    }),
    killed_by: [
      /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a later commit-complete transition whose primary emit was missed renders at the backstop, once$/,
      /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a later close-complete transition whose primary emit was missed renders at the backstop, once$/,
    ],
    why: "the tombstone is keyed by workflow alone: a later transition whose primary emit was missed (an interrupted commit or close) never renders (D4)",
  },
  {
    id: 'N10', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "      const snapshotFile = `${projectionFile}.render-snapshot-${process.pid}-${randomBytes(6).toString('hex')}.json`;\n",
      to: '      const snapshotFile = `${projectionFile}.render-snapshot-${process.pid}.json`;\n',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > two renders in one process on one slot each render their own workflow$/,
    why: 'two renders in one process share a snapshot name, so one renders the other\'s workflow or loses its snapshot (D4)',
  },
  {
    id: 'N15', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  if (!terminalPhases().has(projection.phase)) return undefined;\n',
      to: '',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a workflow reopened with its terminal marker inherited renders no footer at the Stop backstop$/,
    why: 'every phase a reopened workflow moves through counts as a new transition, so each Stop renders a completion footer for unfinished work (D4)',
  },
  {
    id: 'N16', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "  process.stderr.on('error', () => {});\n",
      to: '',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a stderr error event after the failed write callback does not crash the emit$/,
    why: "an EPIPE on stderr after the terminal write crashes the completion that already landed (D4)",
  },
  {
    id: 'N17', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  const claimed = await withMarkerLock(markerFile, async (owns) => {\n',
      to: '  const claimed = await (async (fn) => fn(async () => true))(async (owns) => {\n',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > two overlapping emits of one later transition render it once \(the marker lock\)$/,
    why: 'two overlapping emits both read the earlier transition\'s render, both take the marker over and both render the later transition (D4)',
  },
  {
    id: 'N18', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  if (!held || Date.now() - held.mtimeMs <= MARKER_LOCK_STALE_MS) return false;\n',
      to: '  return false;\n',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a marker lock left by a dead emit is broken; /,
    why: 'a lock left by a dead emit is never broken, so no footer of that slot renders again (D4)',
  },
  {
    id: 'N19', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  if (!sameTransition(existing, transition)) return true;\n',
      to: "  if (!sameTransition(existing, transition)) return existing.status === 'rendered';\n",
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a claim left by a dead render is taken over: /,
    why: "an earlier transition's dead claim suppresses every later transition of the workflow until a SessionStart consume (D4)",
  },
  {
    id: 'N20', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  return claimIsStale(existing);\n',
      to: '  return false;\n',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a claim left by a dead render is taken over: /,
    why: 'a claim whose render died suppresses its transition until a SessionStart consume (D4)',
  },
  {
    id: 'N24', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '    if (!(await owns())) return false;\n',
      to: '',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > an emit whose lock was replaced while it held it claims nothing and removes no lock$/,
    why: 'an emit whose lock a breaker replaced still writes its claim, beside the new holder (D4)',
  },
  {
    id: 'N25', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '    if (await lockHolds(lockFile, token)) await rm(lockFile, { force: true }).catch(() => {});\n',
      to: '    await rm(lockFile, { force: true }).catch(() => {});\n',
    }),
    killed_by: /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > an emit whose lock was replaced while it held it claims nothing and removes no lock$/,
    why: "a former holder removes the lock that replaced its own, admitting a third emit (D4)",
  },
  {
    id: 'N26', tests: ['tests/persona-pipeline/test-footer-activation.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: '  return !existing || existing.claim === claim;\n',
      to: '  return !existing || existing.workflow_id !== undefined;\n',
    }),
    killed_by: [
      /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a render whose claim another attempt took over renders without touching that claim$/,
      /^engineer: completion-footer activation \(ADR-0043 S3\/S4\) > a render whose claim another attempt took over fails without touching that claim$/,
    ],
    why: "a paused render's upgrade or release overwrites the claim of the attempt that took it over (D4)",
  },
  {
    id: 'N27', tests: ['tests/persona-pipeline/test-handoff-backstop.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/session-handoff.mjs',
      from: "    if (marker && (marker.status === 'rendered' || (marker.status === 'claimed' && !claimIsStale(marker)))) return;\n",
      to: "    if (marker && marker.status === 'rendered') return;\n",
    }),
    killed_by: /consumePendingHandoff removes the one-shot file, PRESERVES a rendered tombstone, and removes a crashed claim$/,
    why: 'SessionStart removes a live claim, so a second emit renders the same transition beside it (D4)',
  },
  // engineer's verb runbooks are characterized before they join the regions
  // (PC3 U7): the independent identity and order checks bite on them too.
  {
    id: 'N21', tests: [T_CHAR],
    file: 'plugins/engineer/commands/start.md',
    from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \\\n  --mode execute \\\n  --workflow-path "$ACTIVE" \\\n',
    to: 'node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" \\\n  --mode execute \\\n  --workflow-path "$WORKFLOW" \\\n',
    killed_by: [
      /verb runbook characterization \(PC2a2 T0\) > engineer\/start > identity: /,
      /verb runbook characterization \(PC2a2 T0\) > engineer\/start > order: /,
    ],
    why: "engineer's start commits a workflow no block set, not the one find-active found",
  },
  {
    id: 'N22', tests: [T_CHAR],
    file: 'plugins/engineer/commands/critique.md',
    // PC3 U7: critique's finalize is generated; the settlement names the phase.
    from: '  --host "${AGENTIC_HOST:-claude}" --phase \'critique\' --run-id "$RUN_ID" \\\n',
    to: '  --host "${AGENTIC_HOST:-claude}" --phase \'compose\' --run-id "$RUN_ID" \\\n',
    killed_by: /verb runbook characterization \(PC2a2 T0\) > engineer\/critique > identity: /,
    why: "engineer's critique records its ensemble under another verb's phase",
  },
  {
    id: 'N23', tests: [T_CHAR],
    file: 'plugins/engineer/commands/compose.md',
    // PC3 U7: compose is generated now, its literals single-quoted.
    from: "  --next-action 'Critique the composed artifact' \\\n  --next-step-kind verb --next-step-verb 'critique' \\\n",
    to: "  --next-action 'Run compose skill' \\\n  --next-step-kind verb --next-step-verb 'critique' \\\n",
    killed_by: /verb runbook characterization \(PC2a2 T0\) > engineer\/compose > order: /,
    why: "engineer's compose closes with a next action that disagrees with the one its phase note records",
  },
  {
    // PC3b U2: engineer's start refuses a dirty baseline with the shared
    // status case now; the defect admits dirty there, in every persona.
    id: 'N28', tests: [T_CHAR, T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: '  clean|accepted) ;;  # proceed\n  dirty)\n', to: '  clean|accepted|dirty) ;;  # proceed\n  never)\n' }),
    killed_by: [
      /verb runbook characterization \(PC2a2 T0\) > engineer\/start > guards: start admits only/,
      /(?:^| > )engineer\/commands\/start\.md \(committed\) > start bootstrap, run: only a clean or accepted baseline/,
    ],
    why: "engineer's start creates its workflow over a dirty baseline",
  },
  {
    id: 'N29', tests: [T_CHAR],
    file: 'plugins/engineer/commands/critique.md',
    from: `RUN_ID="\${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"\n`,
    to: '',
    killed_by: /verb runbook characterization \(PC2a2 T0\) > engineer\/critique > identity: /,
    why: "engineer's critique dispatches with a run id no block set",
  },
  // engineer's runbooks join the regions group by group (PC3 U7): a template
  // defect regenerated into every enrolled persona fails engineer's contract.
  {
    id: 'N11', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/checkpoint-set.md',
      from: '  --workflow-path "$ACTIVE" --host',
      to: '  --workflow-path "$WORKFLOW" --host',
    }),
    killed_by: /engineer\/commands\/checkpoint\.md \(committed\) > the checkpoint is written to the workflow find-active found, after finding it$/,
    why: "engineer's checkpoint command writes to a variable no block set, not the workflow find-active found",
  },
  {
    id: 'N12', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/skill-checkpoint-set.md',
      from: '  --workflow-path "$ACTIVE" --host',
      to: '  --workflow-path "$WORKFLOW" --host',
    }),
    killed_by: /engineer\/core\/skills\/checkpoint\/SKILL\.md \(committed\) > the checkpoint is written to the workflow Phase 1 found/,
    why: "engineer's checkpoint skill (the Codex runbook) writes to a variable no step set",
  },
  {
    id: 'N13', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/peer-now-locate.md',
      from: '2>/tmp/{{name}}-peer-now-find.err)"\nFIND_RC=$?\n',
      to: '2>/dev/null)"\n',
    }),
    killed_by: /engineer\/commands\/peer-now\.md \(committed\) > the privacy gate precedes the dispatch, which is synchronous, and the note goes to the workflow found$/,
    why: "peer-now's find-active drops its exit code, so a per-branch duplicate reads as no workflow and the response is never recorded",
  },
  {
    id: 'N14', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/resume-marker.md',
      from: 'if [ -z "$BASE_HEAD_CHECK" ] || ! git cat-file -e "$BASE_HEAD_CHECK^{commit}" 2>/dev/null; then\n',
      to: 'if false; then\n',
    }),
    killed_by: /engineer\/commands\/resume\.md \(committed\) > resume appends its marker only when the baseline commit is available$/,
    why: 'resume records a resumed event over a baseline whose commit object is gone (ADR-0017 §sub-decision-1)',
  },

  // PC3 U7: engineer's frame and compose render from the verb templates; a
  // defect in a template's capability-on branch, regenerated into every
  // target, fails an engineer contract test.
  {
    id: 'N30', tests: [T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-bootstrap.md',
      from: '  --next-action "Run ${VERB} skill" \\\n  "${PARENT_ARGS[@]}")" || exit $?\n',
      to: '  --next-action "Run ${VERB} skill")" || exit $?\n',
    }),
    killed_by: /verb runbook characterization \(PC2a2 T0\) > engineer\/frame > does what the fixture recorded/,
    why: "engineer's frame bootstrap drops the parent linkage, so a subtask /orchestrator:next dispatched records no parent (ADR-0019 §3)",
  },
  {
    id: 'N31', tests: [T_ENG_AP],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-finalize.md',
      from: '/{{persona}}:commit for commit or done; the owner-decision action otherwise>\n',
      to: "the owner's save and commit for commit; none for done; the owner's decision otherwise>\n",
    }),
    killed_by: /verb runbooks — Phase 2 \(ADR-0063 D3\) > frame: the proposal templates offer done, and commit routes to \/engineer:commit$/,
    why: "engineer's proposal sends commit to the owner instead of /engineer:commit",
  },
  {
    id: 'N32', tests: [T_ENG_AP],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-finalize.md',
      from: '  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?\n',
      to: '  --verdict "$VERDICT" --summary "$SUMMARY"\n',
    }),
    killed_by: /verb runbooks — Phase 2 \(ADR-0063 D3\) > compose: every write stops the block on failure; the last write is finish-verb with the next step$/,
    why: 'a refused settlement no longer stops the block, so engineer closes the verb with its ensemble attempt unsettled',
  },
  // Dropped with C1 (E1 rule 3): N33 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  {
    id: 'N34', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-bootstrap-profiled.md',
      from: '  --next-action "Run ${VERB} skill" \\\n  "${PARENT_ARGS[@]}")" || exit $?\n',
      to: '  --next-action "Run ${VERB} skill" \\\n  "${PARENT_ARGS[@]}")"\n',
    }),
    killed_by: /engineer\/commands\/compose\.md \(committed\) > bootstrap and resume write the workflow Phase 0 found, after it, and each stops the block when it fails \(PD6\)$/,
    why: "engineer's compose bootstrap no longer stops when create fails",
  },
  {
    id: 'N35', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-finalize.md',
      from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \\\n',
      to: 'true "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \\\n',
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > frame's finalize: /,
    why: "engineer's generated finalize never settles: a completed run's verdict is not recorded and its pending row stays",
  },
  // Dropped with C1 (E1 rule 3): N36 — the phase note's wording, which no program reads (the characterization fixture records it, C3's to judge).
  {
    id: 'N37', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/decide-owner-selection.md',
      from: '|| exit $?\nif [ "$WF_TYPE" = start ]; then\n',
      to: '|| exit $?\nif [ "$WF_TYPE" = never ]; then\n',
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > decide's Owner selection stops at a refused clear/,
    why: "engineer's Owner selection inside an /engineer:start lifecycle makes the verb's terminal write, which belongs to the lifecycle",
  },
  {
    id: 'N38', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/refine-owner-decision.md',
      from: "  --next-action 'Commit the refined change; the recurring finding is deferred' \\\n",
      to: "  --next-action 'The recurring finding is deferred; the owner saves and commits the refined artifact' \\\n",
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > refine's Owner decision: each block resolves the workflow itself/,
    why: "engineer's deferral tells the owner to save and commit, while /engineer:commit is what commits there (commit_surface)",
  },
  {
    id: 'N39', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/refine-owner-decision.md',
      from: '--next-step-kind commit --next-step-confidence HIGH || exit $?\nif [ "$WF_TYPE" = start ]; then\n',
      to: '--next-step-kind commit --next-step-confidence HIGH || exit $?\nif [ "$WF_TYPE" = never ]; then\n',
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > refine's Owner decision: each block resolves the workflow itself/,
    why: "engineer's deferral inside an /engineer:start lifecycle makes the verb's terminal write, which belongs to the lifecycle",
  },
  // PC3 U7: engineer's investigate picks its ensemble type by profile, names
  // the profile in its note headings and saves its brief under declared names.
  {
    id: 'N40', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-dispatch.md',
      from: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n',
      to: '  --ensemble-type {{ensemble_type}} --run-id "$RUN_ID" \\\n',
      only: 'engineer',
    }),
    killed_by: /engineer\/commands\/investigate\.md \(committed\) > engineer investigate, instantiated per profile: /,
    why: "engineer's dispatch ignores the type the agent set for the profile, so a root-cause or cited-brief investigation dispatches as investigate",
  },
  {
    id: 'N41', tests: [T_CHAR],
    prepare: (copy) => {
      const path = join(copy, 'scripts/lib/persona-pipeline.mjs');
      const text = readFileSync(path, 'utf8');
      const from = "    derived.investigate_synthesis = 'investigate (profile=<profile>)';\n";
      if (text.split(from).length !== 2) throw new MutationHarnessError('N41 anchor');
      writeFileSync(path, text.replace(from, '    derived.investigate_synthesis = profiles[0];\n'));
      regenerate(copy);
    },
    killed_by: /verb runbook characterization \(PC2a2 T0\) > engineer\/investigate > does what the fixture recorded/,
    why: "engineer's investigate synthesis heading names the analysis profile whatever profile ran",
  },
  {
    id: 'N42', tests: [T_DECL], file: 'scripts/lib/persona-pipeline.mjs',
    from: "    derived.brief_file = typeof investigate.brief_file === 'string' ? investigate.brief_file : `${briefProfile.split('-').join('_')}.md`;\n",
    to: "    derived.brief_file = `${briefProfile.split('-').join('_')}.md`;\n",
    killed_by: /an engineer investigate artifact that does not name its declared brief file/,
    why: "engineer's declared brief file is ignored, so its brief is bound to cited_brief.md, a file it never saves",
  },
  {
    id: 'N43', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: "const DECLARATION_FAMILY = 'persona-declaration-1.4';", to: "const DECLARATION_FAMILY = 'persona-declaration-1.3';",
    killed_by: /fails on an unknown scalar in a declaration of the format the loader reads$/,
    why: "the generator reads engineer's 1.4 declaration as a newer minor and forgives an unknown key its loader refuses, so every state write would fail",
  },
  {
    id: 'N44', tests: [T_VERBS],
    prepare: (copy) => {
      const path = join(copy, 'plugins/engineer/persona.json');
      const d = JSON.parse(readFileSync(path, 'utf8'));
      if (d.verbs?.investigate?.output_root_env !== 'RESEARCH_OUTPUT_ROOT') throw new MutationHarnessError('N44 anchor');
      delete d.verbs.investigate.output_root_env;
      writeFileSync(path, `${JSON.stringify(d, null, 2)}\n`);
    },
    killed_by: /engineer: the declared verb fields are what the runbooks say > investigate: the brief file and output-root variable the declaration implies are the ones its output-file rules name/,
    why: "engineer's declaration drops its output-root variable, so its brief is bound to ENGINEER_OUTPUT_ROOT, which its output-file rules never read",
  },
  // PC3b U1 (PC3 step-7 peer findings 1-3): an owner gate met inside a start
  // lifecycle is resolved there, and its clear leaves no stale instruction.
  {
    id: 'N45', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/refine-owner-decision.md',
      from: '--next-step-kind verb --next-step-verb refine --next-step-confidence HIGH || exit $?\nif [ "$WF_TYPE" = start ]; then\n',
      to: '--next-step-kind verb --next-step-verb refine --next-step-confidence HIGH || exit $?\nif [ "$WF_TYPE" = never ]; then\n',
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > refine's Owner decision: each block resolves the workflow itself/,
    why: "engineer's Fix now inside an /engineer:start lifecycle goes on to run the refine's own phases, whose finalize makes the terminal write before the lifecycle's Phase 7",
  },
  {
    id: 'N46', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/refine-owner-decision.md',
      from: '  NEXT_ACTION="Resume /${PERSONA}:start: its refine phase fixes the recurring finding"\n',
      to: '  NEXT_ACTION=\'Fix the recurring finding in this refine, then re-critique\'\n',
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > refine's Owner decision: each block resolves the workflow itself/,
    why: "engineer's lifecycle Fix now records a next action that sends the agent into the refine's own phases instead of back to the lifecycle",
  },
  {
    id: 'N47', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/decide-owner-selection.md',
      from: '  NEXT_STEP=(--clear-next-step true)\n',
      to: '  NEXT_STEP=(--next-step-kind verb --next-step-verb compose --next-step-confidence HIGH)\n',
    }),
    killed_by: /(?:^| > )engineer: verb runbook blocks \(bash, committed\) > decide's Owner selection stops at a refused clear/,
    why: "engineer's Owner selection inside its lifecycle names compose as the next step, while engineer's lifecycle explores after decide",
  },
  {
    id: 'N48', tests: ['tests/persona-pipeline/test-state-schema-14.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: '    applyNextStepWrite(frontmatter, nextStepWrite);\n    if (nextAction !== undefined) frontmatter.next_action = nextAction;\n',
      to: '    applyNextStepWrite(frontmatter, nextStepWrite);\n',
    }),
    killed_by: /^engineer: schema 1\.4 — owner gates \(awaiting-owner-set \/ -clear\) > clear replaces the gate's next action/,
    why: "awaiting-owner-clear keeps the gate's \"Owner: …\" next action, so a block that stops after the clear leaves a stale instruction",
  },

  // ---- PC3b U2: engineer's start joins the start regions ---------------------------
  // G: a shared start template defect, regenerated into every persona.
  {
    id: 'G71', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-resume.md', from: 'then re-run /${PERSONA}:start." >&2\n  exit 1\n', to: 'then re-run /${PERSONA}:start." >&2\n' }),
    killed_by: templateCaught('regions/start-resume.md', /^start resume, run: a start workflow is written/),
    why: 'the resume prints the typed conflict and falls through, so the lifecycle runs on in a single-verb workflow (ADR-0020 §Sub-decision 4)',
  },
  {
    id: 'G72', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-resume.md', from: 'read --workflow-path "$ACTIVE")" || exit $?\n', to: 'read --workflow-path "$ACTIVE")"\n' }),
    killed_by: templateCaught('regions/start-resume.md', /^start resume, run: a start workflow is written/),
    why: 'a failed read of the active workflow no longer stops the resume: a read that printed a start type goes on to write',
  },
  {
    id: 'G73', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: ' --repo-root "$REPO_ROOT" --accept-current-tree "$ACCEPT_TREE")"\n', to: ' --repo-root "$REPO_ROOT")"\n' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: only a clean or accepted baseline/),
    why: 'the bootstrap no longer carries ACCEPT_CURRENT_TREE to the check, so a value set in the block without export accepts nothing',
  },
  {
    id: 'G74', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: 'case "${ACCEPT_CURRENT_TREE:-}" in 1)', to: 'case "$(printenv ACCEPT_CURRENT_TREE)" in 1)' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: only a clean or accepted baseline/),
    why: 'the accept bypass reads only the exported variable again, the defect the flag exists to close',
  },
  // PC3b U3: start's skill intro, a capability-off line that leaks into the
  // shared text; founder's and designer's contract fails.
  {
    id: 'G75', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: '{{#capability commit_surface}}\n   commits it (`${{persona}}:commit`),\n{{/capability}}\n', to: '   commits it (`${{persona}}:commit`),\n' }),
    killed_by: templateCaught('regions/skill-start-command-intro.md', /^start's intro gives the clean-baseline gate, the handoff commands, the accept flag and the lifecycle's calls$/).filter((r) => !/engineer/.test(r.source)),
    why: "founder's and designer's start skill tells the user to commit a workflow with a commit command they do not have",
  },
  // PC3b U3, plan-verify peer: only a start workflow resumes, and an owner
  // gate is cleared on that branch only, never on a workflow start refuses.
  {
    id: 'G76', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: '2. **Active-workflow branching.** `workflow_type` `start` → resume:', to: '2. **Active-workflow branching.** `workflow_type` `verb-chain` → resume:' }),
    killed_by: templateCaught('regions/skill-start-command-intro.md', /^the Codex entry runs the command's Phase 0 in its order$/),
    why: 'the start skill resumes a single-verb workflow into the lifecycle (the predicate the order check alone did not see)',
  },
  {
    id: 'G77', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: '   before any write: it reports a pending owner gate and writes nothing.\n', to: "   before any write: it puts a pending owner gate to the user (resolve it,\n   then clear it with the phase the lifecycle continues at and that phase's\n   `--next-action`).\n" }),
    killed_by: templateCaught('regions/skill-start-command-intro.md', /^the Codex entry runs the command's Phase 0 in its order$/),
    why: 'the start skill clears an owner gate before checking the workflow type, so a refused verb-chain workflow is written to',
  },
  // N: the commit_surface paths of the start templates, which only engineer
  // renders, and the preflight's clear recipe; an engineer contract fails.
  {
    id: 'N49', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: 'process.stdout.write(JSON.parse(s).feature))\'; printf x)"', to: 'process.stdout.write(JSON.parse(s).base_branch))\'; printf x)"' }),
    killed_by: /(?:^| > )engineer\/commands\/start\.md \(committed\) > start bootstrap, run: only a clean or accepted baseline/,
    why: "engineer's bootstrap records the base branch as the workflow's original request instead of the description",
  },
  {
    id: 'N50', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: "Proceeding without overlap detection.\" >&2\n  DIAG=''\n", to: "Proceeding without overlap detection.\" >&2\n  exit \"$DIAG_RC\"\n" }),
    killed_by: /(?:^| > )engineer\/commands\/start\.md \(committed\) > start redundancy probe \(commit_surface\), run/,
    why: 'a failed redundancy probe blocks the start, though the probe is informational (ADR-0020 §Sub-decision 7)',
  },
  {
    id: 'N51', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: '    echo "→ PAUSED: put the evidence to the user and wait for proceed or abort." ;;\n', to: '    ;;\n' }),
    killed_by: /(?:^| > )engineer\/commands\/start\.md \(committed\) > start redundancy probe \(commit_surface\), run/,
    why: 'a redundancy finding no longer pauses for the user\'s proceed or abort',
  },
  {
    id: 'N52', tests: [T_CONTRACT, 'tests/plugin-shape/test-engineer-start.mjs'],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: '    echo "    • worktree: /runtime:worktree plan  (suggests a git worktree add command once its checks pass; re-run in the new worktree)" >&2\n', to: '' }),
    killed_by: [
      /(?:^| > )engineer\/commands\/start\.md \(committed\) > start bootstrap, run: only a clean or accepted baseline/,
      /\/engineer:start — runtime:worktree routes name a subcommand the CLI accepts > the Layer 1 gate's worktree resolution/,
    ],
    why: "engineer's dirty-tree refusal drops the worktree resolution (ADR-0028 §Layer-1)",
  },
  {
    id: 'N53', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-commit.md', from: '  --mode plan \\\n  --workflow-path "$ACTIVE" \\\n  --repo-root "$REPO_ROOT" \\\n  --host "${AGENTIC_HOST:-claude}" || exit $?\n', to: '  --mode plan \\\n  --workflow-path "$ACTIVE" \\\n  --repo-root "$REPO_ROOT" \\\n  --host "${AGENTIC_HOST:-claude}"\nprintf \'%s\\n\' "plan done"\n' }),
    killed_by: /(?:^| > )engineer\/commands\/start\.md \(committed\) > start commit \(commit_surface\), run/,
    why: 'a failed Phase 7 plan no longer stops its block',
  },
  {
    id: 'N54', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-commit.md', from: '  --subject "$APPROVED_SUBJECT" \\\n', to: '' }),
    killed_by: /(?:^| > )engineer\/commands\/start\.md \(committed\) > start commit \(commit_surface\), run/,
    why: 'the Phase 7 execute commits without the subject the user confirmed',
  },
  {
    id: 'N55', tests: [T_S14, 'tests/persona-pipeline/test-autopilot-verbs.mjs'],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: '--resolution "<the owner\'s decision>" ` +\n      `--next-action "<the next step\'s action>"\\n`,',
      to: '--resolution "<the owner\'s decision>"\\n`,',
    }),
    killed_by: [
      /^engineer: autopilot-preflight — a gate inside a start lifecycle \(PC3b U2\) > interactive, a gate on a start workflow/,
      /^founder: autopilot-preflight — a gate inside a start lifecycle \(PC3b U2\) > interactive, a gate on a start workflow/,
      /^designer: autopilot-preflight — a gate inside a start lifecycle \(PC3b U2\) > interactive, a gate on a start workflow/,
    ],
    why: "the preflight's clear recipe drops the next action, so a hand clear that follows it leaves the gate's \"Owner: …\" action behind",
  },

  {
    id: 'N56', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/skill-start-command-intro.md',
      from: '   `state.mjs autopilot-preflight --workflow-path <found> --host codex`\n   before any write: ',
      to: '   ',
    }),
    killed_by: templateCaught('regions/skill-start-command-intro.md', /^the Codex entry runs the command's Phase 0 in its order$/),
    why: "the Codex start entry drops the preflight, so a pending owner gate is not put to the user before the lifecycle continues (plan-verify peer, PC3b U2; the template since U3)",
  },
  // PC3b U3: the commit_surface and dispatch_target branches of the skill
  // templates, which only engineer renders; an engineer skill contract fails.
  {
    id: 'N57', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: '   first for the **redundancy probe** (`state.mjs diagnose-redundancy\n   --repo-root <root> --base-branch <ref>`, informational — a failed probe\n   never stops; a finding is put to the user for proceed or abort, and abort\n   writes nothing), then, with a new args file, for the bootstrap: the\n', to: '   for the bootstrap: the\n' }),
    killed_by: /(?:^| > )engineer\/core\/skills\/start\/SKILL\.md \(committed\) > the Codex entry runs the command's Phase 0 in its order$/,
    why: "engineer's Codex start entry skips the redundancy probe its command runs before the bootstrap",
  },
  {
    id: 'N58', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: 'the lifecycle\'s one terminal write is the Phase 7 commit driver\n(`phase7-commit.mjs` in execute mode, which writes `set-terminal` last).', to: 'the lifecycle\'s one terminal write is `finish-verb` at the end.' }),
    killed_by: /(?:^| > )engineer\/core\/skills\/start\/SKILL\.md \(committed\) > start's intro gives the clean-baseline gate, the handoff commands, the accept flag and the lifecycle's calls$/,
    why: "engineer's start skill names finish-verb as the lifecycle's terminal write, where its lifecycle ends with the Phase 7 driver",
  },
  {
    id: 'N59', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-decide-approval-gate.md', from: 'choose, so do not wait.', to: 'choose, so wait for the owner.' }),
    killed_by: /(?:^| > )engineer\/core\/skills\/decide\/SKILL\.md \(committed\) > decide waits for the user's explicit choice before anything downstream$/,
    why: "engineer's decide skill tells an autopilot step to wait for a choice no one is there to make",
  },
  {
    id: 'N60', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-compose-state-write.md', from: "This skill itself writes no phase note or progress; its one workflow write is\nthe `code` profile's commit-manifest recording below, which keeps every file\nit writes in the workflow's `commit_manifest` for the commit.", to: 'This skill itself does not write workflow state.' }),
    killed_by: /(?:^| > )engineer\/core\/skills\/compose\/SKILL\.md \(committed\) > compose confirms before any downstream verb$/,
    why: "engineer's compose skill denies the commit-manifest write its code profile must make, so Phase 7 would see the change as extras (plan-verify peer, PC3b U3)",
  },
  {
    id: 'N61', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: ' so pass\n`--accept-current-tree` to both of its modes (the plan too, so its preview\nmatches what execute commits).', to: '.' }),
    killed_by: /(?:^| > )engineer\/core\/skills\/start\/SKILL\.md \(committed\) > start's intro gives the clean-baseline gate, the handoff commands, the accept flag and the lifecycle's calls$/,
    why: "engineer's start skill no longer tells Codex to pass the accepted tree to Phase 7 again, so the commit stages only the manifest intersection (plan-verify peer, PC3b U3)",
  },
  // PC3b U3b: the verb skills' finish paragraph (skill-verb-finish.md). G, a
  // shared defect every persona's contract fails; N, the capability-on
  // branches only engineer renders; M, the off branch and the authored text
  // around the region.
  // Dropped with C1 (E1 rule 3): G78 — the text restated what a script does, which that script's own tests run.
  // Dropped with C1 (E1 rule 3): G79 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  {
    // C1 critique: re-added; when the agent may clear the marker is an order
    // it follows, which set-terminal's own tests do not see (E1 rule 2).
    id: 'G80', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINISH, from: 'works only before\nthat Stop fires', to: 'works at any time,\nbefore or after that Stop fires' }),
    killed_by: templateCaught(FINISH, FINISH_CONTRACT),
    why: 'the skills say the terminal marker can be cleared after the same-turn Stop archived the workflow',
  },
  {
    id: 'N62', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINISH, from: 'unset, is Claude-only (ADR-0063); ignore it on Codex. Under an autopilot run', to: 'unset, applies on both hosts. Under an autopilot run' }),
    killed_by: templateCaught(FINISH, FINISH_CONTRACT).filter((r) => /engineer/.test(r.source)),
    why: "engineer's verb skills no longer tell Codex to ignore autopilot mode, which only Claude runs (ADR-0063)",
  },
  // Dropped with C1 (E1 rule 3): N63 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  {
    // PC3b U5b: engineer's routing contract holds § Owner gates now, so every
    // persona's verb skills cite it; N64 is re-aimed at the table itself.
    id: 'N64', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-owner-gates.md', from: "{{#capability commit_surface}}\n| `staging-set` |", to: "{{#capability legacy_homes}}\n| `staging-set` |" }),
    killed_by: /the routing templates keep each claim under its capability, in every legal combination \(PC3b U5b\) > dispatch_target (true|false), commit_surface (true|false), legacy_homes (true|false)$/,
    why: "the staging-set row renders under legacy_homes instead of commit_surface: no persona's table changes (engineer has both on, founder and designer both off), so only a rendering with the two apart shows the gate offered without a commit command, or missing with one",
  },
  // Dropped with C1 (E1 rule 3): M78, M79 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // Dropped with C1 (E1 rule 3): M80 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    // C1 critique: re-added; finish-verb has no convergence check, so the
    // skill's last-write instruction is the only guard (E1 rule 2).
    id: 'M81', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINISH_CONVERGENT, from: "the finalize's last write is an `append` that records the", to: "the finalize's last write is `finish-verb`, which records the" }),
    killed_by: templateCaught(FINISH_CONVERGENT, FINISH_CONTRACT),
    why: "designer's refine skill says an unconverged refine closes with finish-verb, where its command leaves the workflow open with an append",
  },
  // Dropped with C1 (E1 rule 3): M82 — wording drift between two prose variants of one template.
  // PC3b U3b, plan-verify peer: the runbook footer's detached-HEAD rule, the
  // citation check's containment and whole heading, and the replaced section.
  // Dropped with C1 (E1 rule 3): G81 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  {
    id: 'N65', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINISH, from: '`../_shared/references/entry-routing-contract.md` § Owner gates.', to: '`../../../../founder/core/skills/_shared/references/entry-routing-contract.md` § Owner gates.' }),
    killed_by: templateCaught(FINISH, FINISH_CONTRACT).filter((r) => /engineer|designer/.test(r.source)),
    why: "the verb skills cite another plugin's owner gates, which an installed engineer or designer does not ship (re-aimed in PC3b U5b, when every persona cites its routing contract)",
  },
  {
    id: 'N66', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINISH, from: '`../_shared/references/entry-routing-contract.md` § Owner gates.', to: '`../_shared/references/entry-routing-contract.md` § Owner gates_missing.' }),
    killed_by: templateCaught(FINISH, FINISH_CONTRACT),
    why: "the verb skills cite a heading their routing contract does not hold (the check read only its prefix; re-aimed in PC3b U5b)",
  },
  // Dropped with C1 (E1 rule 3): M83 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // PC3b U3c: start's footer, stated once by the runbook's terminal region and
  // the skill's finish region (skill-start-finish.md, its convergent and
  // commit variants). G, the plain templates founder renders; N, engineer's
  // commit variants; M, designer's convergent variants and authored text
  // around the regions.
  // Dropped with C1 (E1 rule 3): G82, N67, M84, M85 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // Dropped with C1 (E1 rule 3): G83 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  {
    id: 'M86', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: START_FINISH, from: '  --next-step-kind commit --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\n', to: '  --next-step-kind done --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\n' }),
    killed_by: templateCaught(START_FINISH, START_FINISH_CONTRACT),
    why: "founder's start skill shows Codex a terminal write of kind done, where the runbook records commit for the owner's save",
  },
  // Dropped with C1 (E1 rule 3): M87 — wording drift between two prose variants of one template.
  {
    id: 'N68', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-finish-commit.md', from: 'writes `set-terminal` last; no `finish-verb` runs.', to: 'writes `set-terminal` last; `finish-verb` then\nrecords the next step.' }),
    killed_by: templateCaught('regions/skill-start-finish-commit.md', START_FINISH_CONTRACT),
    why: "engineer's start skill tells Codex to run finish-verb after the Phase 7 driver already closed the workflow",
  },
  // Dropped with C1 (E1 rule 3): N69 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // Dropped with C1 (E1 rule 3): N70 — wording drift between two prose variants of one template.
  // PC3b U3c, plan-verify peer: engineer's emission sentence, a restatement
  // outside the skill region, the skill block's archive-timing annotation, and
  // when the next start bootstraps.
  // Dropped with C1 (E1 rule 3): N71 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // Dropped with C1 (E1 rule 3): M88 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  {
    id: 'M89', tests: [T_ARCH],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: START_FINISH, from: '# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the\n', to: '# On Claude the Stop hook fires at EVERY turn end, so the\n' }),
    killed_by: /^every set-terminal invocation states when the Stop hook evaluates the gates$/,
    why: "founder's start skill shows a terminal write without its archive-timing label (plan-verify peer, PC3b U3c: the first draft dropped the annotation)",
  },
  {
    id: 'G84', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: START_FINISH, from: 'session context. The workflow is then terminal, and the Stop hook archives it\nonce every archive gate passes; until then `/{{persona}}:start` on this branch\nfinds it and resumes it, so start the next deliverable after the archive, or\non another branch.', to: 'session context. The workflow is then terminal, so the next deliverable starts\na new `/{{persona}}:start`.' }),
    killed_by: templateCaught(START_FINISH, START_FINISH_CONTRACT),
    why: "founder's start skill sends the next deliverable to a new start while the terminal workflow is still on the branch, where start resumes it",
  },
  // PC3b U4: the commit surface's runbook and skill, generated for every persona
  // that declares commit_surface on.
  {
    id: 'N72', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/commit-phase-0.md', from: 'WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?\nWORKFLOW_TYPE="$(printf \'%s\' "$WF_JSON" | node -e', to: 'WORKFLOW_TYPE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" | node -e' }),
    killed_by: templateCaught('regions/commit-phase-0.md', /^commit Phase 0, run: /),
    why: "the commit's type read goes through a pipe again, whose status is the parser's: a read that fails after printing a verb-chain type reaches the preflight and the commit",
  },
  {
    id: 'N73', tests: [T_CONTRACT, T_COMMIT_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/commit-staging-clear.md', from: '  --next-action "Commit the confirmed staging set with /${PERSONA}:commit" \\\n', to: '' }),
    killed_by: [
      ...templateCaught('regions/commit-staging-clear.md', /^commit staging clear, run: /),
      /(?:^| > )engineer\/commands\/commit\.md blocks \(bash, committed\) > the staging clear writes the owner's next step and its next action/,
    ],
    why: "the staging clear keeps the gate's \"Owner: confirm the staging set\" next action, which a commit that then fails leaves standing (the PC3 step-7 stale next action, in the commit surface)",
  },
  {
    id: 'N74', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-commit-plan.md', from: 'PERSONA={{name}}\nREPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1\nACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?\n[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }\nnode "<plugin-root>/scripts/phase7-commit.mjs" --mode plan', to: 'PERSONA={{name}}\nnode "<plugin-root>/scripts/phase7-commit.mjs" --mode plan' }),
    killed_by: templateCaught('regions/skill-commit-plan.md', /^each Codex block is the command's block, with <plugin-root> for the root and <claude\|codex> for the host \(PC3b U4\)$/),
    why: "the Codex plan block drifts from the command's: it reuses a workflow an earlier shell found",
  },
  {
    id: 'N75', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/commit-autopilot.md', from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode autopilot \\\n', to: 'node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode autopilot --confirm-non-interactive \\\n' }),
    killed_by: templateCaught('regions/commit-autopilot.md', /^commit driver blocks, run: /),
    why: 'the autopilot block passes a confirm flag, the bypass of the staging-set confirmation only the owner can give',
  },
  {
    id: 'N76', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/commit-phase-0.md', from: 'continue it with /${PERSONA}:start." >&2\n  exit 1\n', to: 'continue it with /${PERSONA}:start." >&2\n' }),
    killed_by: templateCaught('regions/commit-phase-0.md', /^commit Phase 0, run: /),
    why: 'the commit takes a /start workflow, whose own Phase 7 commits it',
  },
  {
    id: 'N77', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/commit-close.md', from: 'ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?\n[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }\n# Re-checks', to: '# Re-checks' }),
    killed_by: templateCaught('regions/commit-close.md', /^commit driver blocks, run: /),
    why: 'the close block reuses a workflow an earlier shell found, and fails (or closes another) in a fresh shell',
  },
  // Dropped with C1 (E1 rule 3): N78 — the text restated what a script does, which that script's own tests run.
  // PC3b U4b: the verb runbooks' blocks run for every persona, by declaration.
  {
    id: 'G85', tests: [T_VERB_RB],
    // The template alone, not regenerated: the committed runbooks are clean.
    prepare: (copy, tools) => tools.applyEdit(copy, {
      file: 'persona-pipeline/regions/verb-finalize.md',
      from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \\\n',
      to: 'true "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \\\n',
    }),
    killed_by: [
      /(?:^| > )engineer: verb runbook blocks \(bash, assembled from the templates\) > frame's finalize: /,
      /(?:^| > )founder: verb runbook blocks \(bash, assembled from the templates\) > frame's finalize: /,
    ],
    why: 'the assembled runs are skipped although the template differs from the committed runbooks, so a finalize defect the next --write would generate passes',
  },
  {
    id: 'M90', tests: [T_VERB_RB],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "  if (named && capabilityOn('dispatch_target') && host === 'claude') {\n",
      to: "  if (named && host === 'claude') {\n",
    }),
    killed_by: [
      /(?:^| > )founder: verb runbook blocks \(bash, committed\) > Phase 0: /,
      /(?:^| > )designer: verb runbook blocks \(bash, committed\) > Phase 2 under an autopilot run: /,
    ],
    why: 'an inherited AGENTIC_AUTOPILOT makes founder and designer, which are no dispatch target, follow the autopilot rules: the banner, a refusal at a gate, a verb that never closes',
  },
  {
    id: 'M91', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/verb-finalize-convergent.md',
      from: '    --clear-terminal-marker true --event updated || exit $?\n',
      to: '    --event updated || exit $?\n',
    }),
    killed_by: /(?:^| > )designer: verb runbook blocks \(bash, committed\) > refine's finalize: /,
    why: "designer's unconverged refine keeps an earlier verb's terminal marker, so the Stop hook archives a workflow that is still open",
  },
  {
    id: 'M92', tests: [T_VERB_RB],
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/refine-owner-decision-convergent.md',
      from: 'if [ "${CONVERGED:-no}" = "yes" ]; then\n  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear',
      to: 'if true; then\n  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear',
    }),
    killed_by: /(?:^| > )designer: verb runbook blocks \(bash, committed\) > refine's Owner decision: /,
    why: "designer's Defer ends the verb with commit next although the re-critique did not converge",
  },
  // PC3b U5a: engineer's session handoff joins the handoff templates; every
  // legal capability combination keeps each claim under its capability.
  // Dropped with C1 (E1 rule 3): N79 — the text restated what a script does, which that script's own tests run.
  {
    id: 'N80', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/handoff-recipe.md', from: "{{#capability legacy_homes}}\nand the pre-migration slot's\n`.claude/agentic-{{persona}}/last-session-handoff.json*`, whether or not a\nworkflow still lives there (a pending handoff outlives its workflow)\n{{/capability}}\n", to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the session handoff's recipe and rollback name this persona's own resume and legacy slot$/,
    why: 'the rollback cleanup names only the canonical slot, and a legacy-home repository keeps a pre-rollback handoff (PC3 step-3 MINOR 7)',
  },
  {
    id: 'N81', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/handoff-recipe.md', from: "  `terminal_phase`, `no_active_children`, `awaiting_owner`) → **`blocked`**,\n", to: "  `terminal_phase`, `no_active_children`, `awaiting_owner`) → **`publish-needed`**,\n" }),
    killed_by: /the handoff templates keep each claim under its capability, in every legal combination \(PC3b U5a\) > dispatch_target true, commit_surface true, legacy_homes true$/,
    why: "the commit-surface mapping says publish-needed, which engineer's session-handoff.mjs never computes",
  },
  // Dropped with C1 (E1 rule 3): N82 — the text restated what a script does, which that script's own tests run.
  // Dropped with C1 (E1 rule 3): G86, G87 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'G88', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/handoff-wiring.md', from: '{{#capability dispatch_target}}\n  Under an autopilot run (Claude, ADR-0063)', to: '{{#capability commit_surface}}\n  Under an autopilot run (Claude, ADR-0063)' }),
    killed_by: /the handoff templates keep each claim under its capability, in every legal combination \(PC3b U5a\) > dispatch_target false, commit_surface true, legacy_homes (true|false)$/,
    why: 'the autopilot sentence sits under commit_surface, so a persona with the commit surface and no dispatch target is told of an autopilot run it cannot have (no persona renders that today)',
  },
  // PC3b U5b: engineer's routing contract joins the routing regions; each
  // capability branch it renders states what its scripts do.
  {
    id: 'N83', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-owner-gates.md', from: "{{#capability dispatch_target}}\n| `pr-handling` |", to: "{{#capability profile_presets}}\n| `pr-handling` |" }),
    killed_by: [
      /(?:^| > )engineer: reference contracts > committed: the owner-gates and next-step tables agree with this persona's state\.mjs \(PC2b DD8\)$/,
      /(?:^| > )designer: reference contracts > committed: the owner-gates and next-step tables agree with this persona's state\.mjs \(PC2b DD8\)$/,
    ],
    why: "the pr-handling row renders under profile_presets: engineer's table loses a gate its state.mjs sets, designer's gains one it refuses",
  },
  {
    id: 'N84', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-proposal.md', from: "  `/{{persona}}:start` lifecycle commits at its Phase 7 instead); for `done`,\n  the same command, which closes the workflow without a commit when there is\n  nothing to commit; for `owner decision`,", to: "  `/{{persona}}:start` lifecycle commits at its Phase 7 instead); for `done`,\n  none; for `owner decision`," }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the capability text agrees with the declaration$/,
    why: "engineer's proposal says done takes no command, where /engineer:commit closes the workflow without a commit",
  },
  {
    id: 'N85', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-preflight-policy.md', from: "{{#capability commit_surface}}\n  The commit command's no-changes close (`phase7-commit.mjs`) archives its\n  workflow itself, right after its terminal write: with nothing committed,\n  HEAD never moves past the baseline, so the Stop hook would never pass it.\n{{/capability}}\n", to: '' }),
    killed_by: /the routing templates keep each claim under its capability, in every legal combination \(PC3b U5b\) > dispatch_target (?:true|false), commit_surface true, legacy_homes (?:true|false)$/,
    why: "engineer's preflight names the Stop hook as the one automatic archive, where phase7-commit's no-changes close archives its workflow itself",
  },
  {
    id: 'N86', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/routing-preflight-policy.md', from: '{{#capability legacy_homes}}\nA workflow that still lives in the pre-migration home,', to: '{{#capability commit_surface}}\nA workflow that still lives in the pre-migration home,' }),
    killed_by: /the routing templates keep each claim under its capability, in every legal combination \(PC3b U5b\) > dispatch_target (true|false), commit_surface true, legacy_homes false$/,
    why: 'the legacy slot sentence renders under commit_surface, so a persona with the commit surface and no legacy home is told of a slot it never writes (engineer, with both on, cannot tell)',
  },
  // Dropped with C1 (E1 rule 3): G89 — prose no program reads and no run, order, stop or hand-off depends on.
  // Dropped with C1 (E1 rule 3): M93 — the text restated what a script does, which that script's own tests run.
  {
    id: 'M95', tests: [T_REF], file: 'plugins/engineer/core/skills/start/SKILL.md',
    from: 'compose, stage, commit, gate, and set-terminal in one atomic pass.\n',
    to: 'compose, stage, commit, gate, and set-terminal in one atomic pass.\nThen run `node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal --terminal-marker true`.\n',
    killed_by: /(?:^| > )engineer: reference contracts > committed: the skills and the runbooks name finish-verb as the terminal write \(PC2b DD8\)$/,
    why: "engineer's start skill adds a direct set-terminal step beside the Phase 7 driver's own write (the PC3b U5b review's in-memory probe passed the first exception)",
  },
  {
    id: 'M94', tests: [T_REF], file: 'plugins/engineer/core/skills/decide/SKILL.md',
    from: '`owner decision`, and `/engineer:decide` ends with the `decide-conflict` owner\ngate instead of a terminal write;',
    to: '`owner decision`, and `/engineer:decide` ends with a terminal write;',
    killed_by: /(?:^| > )engineer: reference contracts > committed: the skills and the runbooks name finish-verb as the terminal write \(PC2b DD8\)$/,
    why: "engineer's decide skill no longer says a choice left to the owner ends with the decide-conflict gate",
  },
  // PC3b U5b: engineer joins the presentation protocol and the orchestration
  // framework. Each autopilot sentence renders under dispatch_target only;
  // engineer's authored decide step, taxonomy row and Task Profile follow the
  // decision-item rule and name engineer alone.
  {
    id: 'N87', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/presentation-offer.md', from: "{{#capability dispatch_target}}\n**Autopilot mode (ADR-0063, Claude only):** when the command's Phase 0\npreflight printed the autopilot banner, do not offer the choice: present in\nbatch (`autopilot-mode.md`). Everything below is the interactive rule.\n\n{{/capability}}\n", to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the presentation protocol keeps an autopilot step from asking, under dispatch_target only$/,
    why: "engineer's presentation offer loses its autopilot rule, so an autopilot step asks a question no one answers",
  },
  {
    id: 'N88', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/presentation-rules.md', from: "{{#capability dispatch_target}}\n**Autopilot mode (ADR-0063, Claude only):** there is no one to answer", to: "{{^capability dispatch_target}}\n**Autopilot mode (ADR-0063, Claude only):** there is no one to answer" }),
    killed_by: [
      /(?:^| > )engineer: reference contracts > committed: the presentation protocol keeps an autopilot step from asking, under dispatch_target only$/,
      /(?:^| > )founder: reference contracts > committed: the presentation protocol keeps an autopilot step from asking, under dispatch_target only$/,
      /the presentation and orchestration templates name autopilot under dispatch_target only, in every legal combination \(PC3b U5b\) > dispatch_target false, commit_surface false, legacy_homes false$/,
    ],
    why: 'the confirmation rule for autopilot renders with dispatch_target off: founder and designer are told of runs they never take, engineer loses it',
  },
  {
    id: 'N89', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/orchestration-failure.md', only: 'engineer', from: "If any local analysis fails to return (timeout, error, or empty result):\nnotify the user which perspective failed, ask retry-or-proceed, follow the\nuser's decision, and if proceeding note the missing perspective in the\nsynthesis so the user knows coverage was incomplete. ", to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the orchestration failure handling stops to ask on a failed local analysis and never blocks on a peer failure$/,
    why: "engineer's orchestration failure handling drops the local-agent case (the template regenerated into engineer alone)",
  },
  // Dropped with C1 (E1 rule 3): M96, M97, M99, M100 — presentation pacing prose or its citation; the autopilot no-ask rule stays pinned.
  // Dropped with C1 (E1 rule 3): M98 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'N90', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/orchestration-failure.md', from: ORCH_FAILURE, to: `{{#capability dispatch_target}}\n${ORCH_FAILURE}{{/capability}}\n{{^capability commit_surface}}\n${ORCH_FAILURE}{{/capability}}\n` }),
    killed_by: /the presentation and orchestration templates name autopilot under dispatch_target only, in every legal combination \(PC3b U5b\) > dispatch_target false, commit_surface true, legacy_homes (true|false)$/,
    why: 'the failure handling renders under dispatch_target and again under commit_surface off: every persona today renders it, a persona with the commit surface and no dispatch target gets none (the review probe)',
  },
  // Dropped with C1 (E1 rule 3): X62, M103, X63, M101, M102 — presentation pacing prose or its citation; the autopilot no-ask rule stays pinned.

  // PC3b U5c: engineer joins the ensemble protocol's seventeen regions that
  // state no peer privacy policy; the privacy regions stay founder's and
  // designer's, the Launch gate among them as its own region. Each new claim
  // bites where it is keyed.
  {
    id: 'N91', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-collect.md', from: ENSEMBLE_AUTOPILOT, to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the protocol's autopilot wait and commit-command exclusion follow the declaration, and no runner hides behind a shell `&` \(RV12, PC3b U5c\)$/,
    why: "engineer's Collect step loses its autopilot wait, so an autopilot step may end its turn and file a final report before the peer's notification",
  },
  {
    id: 'N92', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-collect.md', from: ENSEMBLE_AUTOPILOT, to: ENSEMBLE_AUTOPILOT.replace('{{#capability dispatch_target}}', '{{^capability dispatch_target}}') }),
    killed_by: [
      /(?:^| > )founder: reference contracts > committed: the protocol's autopilot wait and commit-command exclusion follow the declaration, and no runner hides behind a shell `&` \(RV12, PC3b U5c\)$/,
      /the ensemble templates keep each claim under its capability, in every legal combination \(PC3b U5c\) > dispatch_target false, commit_surface false, legacy_homes false$/,
    ],
    why: 'the autopilot wait renders for the personas with no dispatch target and not for engineer',
  },
  {
    id: 'N93', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-when-applies.md', from: ENSEMBLE_COMMIT, to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the protocol's autopilot wait and commit-command exclusion follow the declaration, and no runner hides behind a shell `&` \(RV12, PC3b U5c\)$/,
    why: "engineer's protocol no longer says its commit command dispatches no peer",
  },
  {
    id: 'N94', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-when-applies.md', from: ENSEMBLE_COMMIT, to: ENSEMBLE_COMMIT.replace('{{#capability commit_surface}}', '{{^capability commit_surface}}') }),
    killed_by: [
      /(?:^| > )designer: reference contracts > committed: the protocol's autopilot wait and commit-command exclusion follow the declaration, and no runner hides behind a shell `&` \(RV12, PC3b U5c\)$/,
      /the ensemble templates keep each claim under its capability, in every legal combination \(PC3b U5c\) > dispatch_target false, commit_surface false, legacy_homes (true|false)$/,
    ],
    why: 'the commit-command exclusion renders for the personas that have no commit command',
  },
  {
    id: 'N95', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-launch.md', from: ' The\n   runner runs in the foreground of that background task, never behind a\n   shell `&`, which would detach it where the host can neither track it\n   nor notify you when it exits.', to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the protocol's autopilot wait and commit-command exclusion follow the declaration, and no runner hides behind a shell `&` \(RV12, PC3b U5c\)$/,
    why: "the Launch step no longer keeps the runner out of a shell `&` (engineer's authored ADR-0063 D5 rule, now every persona's)",
  },
  {
    id: 'G90', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-bookkeeping.md', from: '- never launched ({{skip_cause}}):\n', to: '- never launched (no dispatch ran: the privacy gate kept the verb\n  local-only):\n' }),
    killed_by: [
      /(?:^| > )engineer: reference contracts > committed: the ensemble Launch gates the declared privacy scope before any dispatch, and claims no gate without one \(RD5, PC3b U5c\)$/,
      /the ensemble templates keep each claim under its capability, in every legal combination \(PC3b U5c\) > dispatch_target true, commit_surface true, legacy_homes true$/,
    ],
    why: "State Bookkeeping tells engineer a privacy gate kept its verb local-only, a gate it does not declare (the shared text before PC3b U5c)",
  },
  {
    id: 'G91', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/ensemble-launch.md', from: '1. Determine the ensemble point type (see *Ensemble Point Types* below).\n', to: '1. Determine the ensemble point type (see *Ensemble Point Types* below).\n   **Pass the privacy gate** (see *Privacy* below) before the dispatch.\n' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the ensemble Launch gates the declared privacy scope before any dispatch, and claims no gate without one \(RD5, PC3b U5c\)$/,
    why: "the shared Launch steps claim a privacy gate again, which engineer's protocol has no Privacy section for",
  },
  {
    id: 'M104', tests: [T_REF],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/manifest.json', from: '"id": "ensemble-privacy-contract",\n      "template": "regions/ensemble-privacy-contract.md",\n      "dest": "core/skills/_shared/references/ensemble-protocol.md",\n      "personas": [\n        "designer",\n        "founder"\n      ]', to: '"id": "ensemble-privacy-contract",\n      "template": "regions/ensemble-privacy-contract.md",\n      "dest": "core/skills/_shared/references/ensemble-protocol.md",\n      "personas": [\n        "designer",\n        "engineer",\n        "founder"\n      ]' });
      tools.applyEdit(copy, { file: 'plugins/engineer/core/skills/_shared/references/ensemble-protocol.md', from: '### Do not pass --model or --effort\n', to: '<!-- pipeline:begin ensemble-privacy-contract -->\n<!-- pipeline:end ensemble-privacy-contract -->\n\n### Do not pass --model or --effort\n' });
      regenerate(copy);
    },
    killed_by: /(?:^| > )engineer: reference contracts > committed: the ensemble Launch gates the declared privacy scope before any dispatch, and claims no gate without one \(RD5, PC3b U5c\)$/,
    why: 'engineer is enrolled in the privacy-contract region, which renders without a peer policy and tells it every prompt carries a <privacy_contract> block',
  },
  {
    id: 'M105', tests: [T_REF], file: 'plugins/engineer/core/skills/peer-now/SKILL.md',
    from: '(`--workflow-path / --phase /\n--ensemble-type`)', to: '(`--workflow-path / --phase /\n--ensemble-type / --run-id`)',
    killed_by: /(?:^| > )engineer: reference contracts > committed: the peer-now skill omits exactly the accounting flags its dispatch omits, and the dispatch passes --run-id$/,
    why: "engineer's peer-now skill lists --run-id among the flags it omits again, which its dispatch passes (the drift RV7 found when engineer joined)",
  },
  {
    id: 'M106', tests: [T_REF], file: 'plugins/engineer/core/skills/_shared/references/ensemble-protocol.md',
    from: '### State Bookkeeping\n', to: '### State Bookkeeping (Stage 2.5+)\n',
    killed_by: /(?:^| > )engineer: reference contracts > committed: no runbook guards ensemble-commit on shell variables, and the protocol says settle decides from the run ledger instead \(D2, PC2b U5b\)$/,
    why: "engineer's State Bookkeeping heading takes its old suffix back, so the contracts that read the section by its heading read nothing",
  },
  {
    // PC3b U5d: the Markdown-link citation this first aimed at went with
    // engineer's authored State and Recovery text (the shared recovery cites
    // no heading); the link form stays proven by the extractor's self-test,
    // and this aims at the other form U5c taught it, a quoted § with no space.
    id: 'M107', tests: [T_REF], file: 'plugins/engineer/core/skills/investigate/references/cited-brief-spec.md',
    from: '§"CONFLICT\nhandling"', to: '§"Conflict\nledger"',
    killed_by: /(?:^| > )engineer: reference contracts > committed: every in-plugin citation resolves, and its § names a heading of the target$/,
    why: "a quoted § with no space names a heading its target does not hold (the form PC3b U5c found unread)",
  },
  // ---- PC3b U5d: engineer's investigate brief references join their regions ----------
  {
    id: 'N96', tests: [T_REF], file: 'scripts/lib/persona-pipeline.mjs',
    from: "    const briefProfile = typeof investigate.brief_profile === 'string' ? investigate.brief_profile : profile;\n",
    to: "    const briefProfile = profile;\n",
    killed_by: /(?:^| > )engineer: reference contracts > assembled from the templates: every in-plugin citation resolves, and its § names a heading of the target$/,
    why: "engineer's declared brief profile is ignored, so its brief references name analysis, a profile that saves no brief",
  },
  // Dropped with C1 (E1 rule 3): N97 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'N98', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-launch-privacy.md', from: '{{privacy_scope}}\npass an explicit privacy gate before BOTH web search AND peer-host\ndispatch', to: 'pass a privacy gate before dispatch' }),
    killed_by: /(?:^| > )founder: reference contracts > committed: the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches \(RD8, RV10\)$/,
    why: "the brief Launch's gate no longer states the declared privacy scope, or that it covers web search and the peer dispatch",
  },
  {
    id: 'G92', tests: [T_DECL], file: 'scripts/sync-persona-pipeline.mjs',
    from: "  if (Object.hasOwn(investigate, 'brief_profile') && !(Array.isArray(investigate.profiles)",
    to: "  if (false && Object.hasOwn(investigate, 'brief_profile') && !(Array.isArray(investigate.profiles)",
    killed_by: /fails on a brief profile off the investigate profiles$/,
    why: 'a brief profile investigate does not have passes the generator, so the brief references are named after a profile no command runs',
  },
  {
    id: 'G93', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: "'brief_file', 'output_root_env', 'brief_profile', 'brief_ensemble_type',\n",
      to: "'brief_file', 'output_root_env',\n",
    }),
    killed_by: /agrees with the schema where keys are patterns or items are typed: profile_presets keys, artifact items$/,
    why: "the loader does not know format 1.4's brief keys, so it refuses engineer's own declaration and every state write fails",
  },
  {
    id: 'G94', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/brief-ensemble-launch.md', from: 'Pre-condition before dispatch: the existing-directory check', to: 'Pre-condition before dispatch: the privacy gate has passed, and the existing-directory check' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches \(RD8, RV10\)$/,
    why: 'the shared brief Launch claims a privacy gate again, which engineer declares no policy for (its gate is stated by its cited-brief Step 1)',
  },
  {
    id: 'M108', tests: [T_REF],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: 'persona-pipeline/manifest.json', from: '    {\n      "id": "brief-ensemble-failure",\n      "template": "regions/brief-ensemble-failure.md",\n      "dest": "core/skills/investigate/references/cited-brief-ensemble.md",', to: '    {\n      "id": "brief-ensemble-privacy-bidirectional",\n      "template": "regions/brief-ensemble-privacy-bidirectional.md",\n      "dest": "core/skills/investigate/references/cited-brief-ensemble.md",\n      "personas": [\n        "engineer"\n      ]\n    },\n    {\n      "id": "brief-ensemble-failure",\n      "template": "regions/brief-ensemble-failure.md",\n      "dest": "core/skills/investigate/references/cited-brief-ensemble.md",' });
      tools.applyEdit(copy, { file: 'plugins/engineer/core/skills/investigate/references/cited-brief-ensemble.md', from: 'When the user declines redaction or aborts the session, do NOT\ndispatch to the peer.\n', to: 'When the user declines redaction or aborts the session, do NOT\ndispatch to the peer.\n\n<!-- pipeline:begin brief-ensemble-privacy-bidirectional -->\n<!-- pipeline:end brief-ensemble-privacy-bidirectional -->\n' });
      regenerate(copy);
    },
    killed_by: /(?:^| > )engineer: reference contracts > committed: the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches \(RD8, RV10\)$/,
    why: 'engineer is enrolled in the brief privacy region, which states a genericization discipline it does not declare',
  },
  // Dropped with C1 (E1 rule 3): M109, M110 — prose no program reads and no run, order, stop or hand-off depends on.
  {
    id: 'M111', tests: [T_REF],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/output-rules-layout.md', from: '6. **Truncate at 15 Unicode code points** (characters). One CJK\n   character is one code point.\n', to: '' }),
    killed_by: /(?:^| > )engineer: reference contracts > committed: the output-file rules sanitize the slug, sandbox the root and gate an existing directory \(RD7\)$/,
    why: 'the slug sanitization loses its truncation step (a check moved from tests/engineer/test-cited-brief.mjs)',
  },
  // Dropped with C1 (E1 rule 3): M112, M113 — prose no program reads and no run, order, stop or hand-off depends on.
  // PC3b: which ADR enabled a persona's footer is history, not a capability
  // (U5a review); the finish and terminal templates attribute it to ADR-0039
  // alone. Each G puts the capability-keyed attribution back in the form it had.
  // Dropped with C1 (E1 rule 3): G95, G96, G97 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // Dropped with C1 (E1 rule 3): G98 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // Dropped with C1 (E1 rule 3): N99, N100, N101 — the footer's wording; the sidecar and footer.mjs are tested by what they print.
  // ---- C: control -------------------------------------------------------------------
  {
    id: 'C1', tests: [T_SYNC], expect: 'SURVIVED',
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: '// scripts/state.mjs\n',
      to: '// scripts/state.mjs (regenerated by the mutation control)\n',
    }),
    why: 'an innocuous canonical edit regenerated into every target leaves the drift check clean',
  },
  {
    id: 'C2', tests: [T_SYNC, T_CONTRACT], expect: 'SURVIVED',
    prepare: (copy, tools) => templateDefect(copy, tools, {
      template: 'regions/plugin-root.md',
      from: 'shell variable does not outlive a Bash call.',
      to: 'shell variable does not outlive a Bash call (each block runs in a new shell).',
    }),
    why: 'an innocuous template edit regenerated into every runbook leaves the drift check and the contracts clean',
  },
];
