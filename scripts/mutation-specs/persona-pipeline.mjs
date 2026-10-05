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
//      text removed, each with the contract that must catch it (killed_by);
//   V  declaration format 1.1 (PC2a2) and 1.2 (PC2a3, peer): the loader's
//      reader parity with the schema, the generator's cross-field rules, the
//      declared verb fields bound to the runbooks; K, the verb runbook
//      characterization (T0); L, the engine's list values;
//   S  the extension slots (PC2a3 DD6): each slot check dropped; W, the
//      variant rule (DD2) dropped;
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
  'regions/checkpoint-set.md', 'regions/decide-resolve.md', 'regions/locate-active.md',
  'regions/peer-now-dispatch.md', 'regions/peer-now-locate.md', 'regions/peer-now-note.md',
  'regions/resume-archive.md', 'regions/resume-marker.md', 'regions/resume-read.md',
  'regions/start-bootstrap.md', 'regions/start-resume.md', 'regions/verb-bootstrap-profiled.md',
  'regions/verb-bootstrap.md', 'regions/verb-dispatch.md', 'regions/verb-finalize.md',
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

// PC2a2b: the finalize template and its ensemble-commit step, moved whole by M1/M2.
const FINALIZE = 'regions/verb-finalize.md';
// PC2a2c: decide's Phase 0.5 template and the contract that runs its block.
const RESOLVE = 'regions/decide-resolve.md';
const PHASE_05_RUN = /^Phase 0\.5: between the resume and the dispatch, the resolver reads the args file/;
const COMMIT_STEP = [
  '# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.',
  'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \\',
  '  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \\',
  '  --phase {{verb}} --ensemble-type {{ensemble_type}} --run-id "$RUN_ID" \\',
  '  --verdict "$VERDICT" --summary "$SUMMARY" \\',
  '  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  '',
  '',
].join('\n');

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

const SKILL_PRIVACY = /^the privacy gate precedes the peer step/;
const isSkill = (dest) => dest.startsWith('core/skills/');
// The privacy contract of each runbook a privacy template renders into, from
// its enrollment: start's has its own name (Codex review of PC2a3: the
// verbCaught default left critique, refine and start unrequired).
const START_PRIVACY = /^start privacy: the prohibition precedes the lifecycle/;
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
        tools.applyEdit(copy, { file: `persona-pipeline/${template}`, from: 'printenv {{root_env}} || true)', to: 'printenv {{root_env}})' });
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
      from: 'const READER_MINOR = 2;',
      to: 'const READER_MINOR = 1;',
    }),
    why: 'the loader reads as 1.1 again and forgives an unknown scalar the schema refuses at the same minor (the readers disagree)',
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
    from: 'if [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'if true; then',
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
    from: "  --phase 'compose' --ensemble-type 'plan-verify' --run-id \"$RUN_ID\" \\\n  --verdict",
    to: "  --phase 'compose' --ensemble-type 'brainstorm' --run-id \"$RUN_ID\" \\\n  --verdict",
    why: 'founder compose commits its ensemble result under another type than it dispatched (the T0 characterization must fail)',
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
    id: 'K7', tests: [T_CHAR], file: 'plugins/designer/commands/critique.md',
    from: 'if [ -n "${RUN_ID:-}" ] && [ -n "${VERDICT:-}" ]; then',
    to: 'if [ -n "${RUN_ID:-}" ]; then',
    why: 'designer critique records an ensemble result with no verdict (its D2 guard loses a condition)',
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
  {
    id: 'V8', tests: [T_VERBS], file: 'plugins/designer/commands/refine.md',
    from: '  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \\\n',
    to: '  :; else\n  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \\\n',
    why: 'designer refine\'s terminal write moves to the else branch: it runs when the re-critique did not converge',
  },
  {
    id: 'V9', tests: [T_VERBS], file: 'plugins/designer/commands/refine.md',
    from: 'if [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal --workflow-path "$ACTIVE"\nif [ "${CONVERGED:-no}" = "yes" ]; then',
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
      { from: '  --next-action {{next_action}} \\\n  --event updated\n```', to: `  --next-action {{next_action}} \\\n  --event updated\n\n${COMMIT_STEP.trimEnd()}\n\`\`\`` },
    ] }),
    killed_by: verbCaught(/^the dispatch, the note, ensemble-commit and the terminal write run in that order/),
    why: 'the terminal write runs before ensemble-commit: the workflow archives with its ensemble result still pending',
  },
  {
    id: 'M2', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, edits: [
      { from: COMMIT_STEP, to: '' },
      { from: 'nothing was written." >&2; exit 1; }\n\nnode "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \\\n', to: `nothing was written." >&2; exit 1; }\n\n${COMMIT_STEP}node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \\\n` },
    ] }),
    killed_by: verbCaught(/^the dispatch, the note, ensemble-commit and the terminal write run in that order/),
    why: 'ensemble-commit runs before the phase note is written',
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
    killed_by: [...verbCaught(/^the dispatch, the note, ensemble-commit and the terminal write run in that order/), /^bash: the finalize block hands a hostile note to state\.mjs byte for byte/],
    why: 'a failed phase-note append no longer stops the block, which goes on to commit and archive (PD6; the run case shows it)',
  },
  {
    id: 'M6', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-phase-0.md', from: '  exit "$FIND_RC"\n', to: '' }),
    killed_by: verbCaught(/^Phase 0 names the persona before its guard/),
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
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/verb-dispatch.md', from: '  --ensemble-type {{ensemble_type}} --run-id "$RUN_ID" \\\n', to: '  --ensemble-type {{ensemble_type}} --run-id "$RUN_ID" --image "$SCREENSHOT" \\\n' }),
    killed_by: templateCaught('regions/verb-dispatch.md', /^privacy: the prohibition sentence precedes the dispatch/),
    why: 'the dispatch passes a screenshot to a companion path that has no image channel',
  },
  {
    id: 'M10', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: '{{artifact}}\n\n', to: '' }),
    killed_by: verbCaught(/^the phase note: the scaffold right above the finalize block is the recorded one/),
    why: 'the phase-note scaffold loses its artifact sections',
  },
  {
    id: 'M11', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: FINALIZE, from: "NOTE <<'PHASE_NOTE' || true", to: 'NOTE <<PHASE_NOTE || true' }),
    // bash only: the suite runs the other shells only where they are installed.
    killed_by: [/^bash: the finalize block hands a hostile note to state\.mjs byte for byte/, ...verbCaught(/^the phase note: the scaffold right above the finalize block/)],
    why: 'the heredoc is unquoted: the shell expands $(…), backticks and $VARS in the note the agent wrote (the ADR-0059 class)',
  },
  {
    id: 'M12', tests: [T_CONTRACT, T_CHAR],
    prepare: (copy) => {
      const path = join(copy, 'persona-pipeline/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const subs = manifest.regions.filter((r) => r.dest === 'commands/compose.md' && r.substitutions?.ensemble_type);
      if (subs.length !== 2) throw new MutationHarnessError(`compose ensemble_type substitutions: ${subs.length}`);
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
    killed_by: [/^dash: a shell whose read has no -d stops the finalize block before any write/, ...verbCaught(/^the phase note: the scaffold right above the finalize block/)],
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
    killed_by: verbCaught(/^the phase note: the scaffold right above the finalize block/),
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
    killed_by: verbCaught(/^the phase note: the scaffold right above the finalize block is the recorded one/, ['investigate']),
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
    from: "  --ensemble-type 'reference-scan' --run-id \"$RUN_ID\" \\\n  > \"$PROMPT_FILE.run.json\"",
    to: "  --ensemble-type 'reference-scan' --run-id \"$RUN_ID\" --model gpt-x \\\n  > \"$PROMPT_FILE.run.json\"",
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
  {
    id: 'M29', tests: [T_CONTRACT],
    prepare: (copy) => {
      const path = join(copy, 'persona-pipeline/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const region = manifest.regions.find((r) => r.id === 'decide-resolve');
      if (!region) throw new MutationHarnessError('no decide-resolve region');
      region.substitutions.fallback_preset = { value: 'default', context: 'markdown' };
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      regenerate(copy);
    },
    killed_by: inSuite('designer/commands/decide.md (committed)', /^Phase 0\.5: the args-file pins hold/),
    why: 'the prose names founder\'s fallback preset for every persona: designer\'s decide says "default" while its registry falls back to "balanced"',
  },
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
    killed_by: [/^dash: a shell whose read has no -d stops the finalize block before any write/, ...verbCaught(/^the phase note: the scaffold right above the finalize block/)],
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
      // The authored finalize block moves above the second extension marker:
      // the marker stays in its slot, so only the QD8 contract can see it.
      const path = join(copy, 'plugins/designer/commands/refine.md');
      const text = readFileSync(path, 'utf8');
      const block = /\n```bash\n(?:(?!```)[\s\S])*?state\.mjs" set-terminal \\\n[\s\S]*?\n```\n/.exec(text);
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
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^the authored finalize follows the finalize heading region and every extension/)],
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
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^each extension holds the text its slot exists for/)],
    why: 'designer refine keeps the extension marker but loses the bounded-convergence text it stands for',
  },
  {
    id: 'M38', tests: [T_CONTRACT], file: 'plugins/designer/commands/refine.md',
    from: 'if [ -n "${RUN_ID:-}" ] && [ -n "${VERDICT:-}" ]; then',
    to: 'if true; then',
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^the authored finalize, run: /)],
    why: 'designer refine records an ensemble result when the peer never launched (D2 dropped), fabricating a peer run',
  },
  {
    id: 'M39', tests: [T_CONTRACT], file: 'plugins/designer/commands/refine.md',
    from: 'if [ "${CONVERGED:-no}" = "yes" ]; then',
    to: 'if [ "${CONVERGED:-yes}" = "yes" ]; then',
    killed_by: [inSuite('designer/commands/refine.md (committed)', /^the authored finalize, run: /)],
    why: 'designer refine closes the workflow when CONVERGED was never assigned (the guard fails open)',
  },
  // ---- M: critique (PC2a3 U5): designer's dispatch generated, founder's authored (QD5) ----
  {
    id: 'M40', tests: [T_CONTRACT], file: 'plugins/founder/commands/critique.md',
    from: '  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \\\n  > "$PROMPT_FILE.run.json"',
    to: '  --ensemble-type review --run-id "$RUN_ID" \\\n  > "$PROMPT_FILE.run.json"',
    killed_by: [inSuite('founder/commands/critique.md (committed)', /^founder critique, instantiated per profile/)],
    why: 'founder critique dispatches review for red-team too: the adversarial scan never reaches the peer (QD5)',
  },
  {
    id: 'M41', tests: [T_CONTRACT], file: 'plugins/founder/commands/critique.md',
    from: '--phase critique --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID"',
    to: '--phase critique --ensemble-type review --run-id "$RUN_ID"',
    killed_by: [inSuite('founder/commands/critique.md (committed)', /^founder critique, instantiated per profile/)],
    why: 'founder critique commits a red-team result under review, another type than it dispatched',
  },
  {
    id: 'M42', tests: [T_CONTRACT],
    prepare: (copy) => {
      const path = join(copy, 'plugins/designer/commands/critique.md');
      const text = readFileSync(path, 'utf8');
      const para = /\*\*Dual input \(ADR-0042 SD4\)\*\*[\s\S]*?\n\n/.exec(text);
      if (!para) throw new MutationHarnessError('designer critique: no dual-input paragraph');
      writeFileSync(path, text.replace(para[0], ''));
    },
    killed_by: [inSuite('designer/commands/critique.md (committed)', /^each extension holds the text its slot exists for/)],
    why: 'designer critique keeps its dual-input marker but loses the host-direct vision text it stands for',
  },
  {
    id: 'M43', tests: [T_CONTRACT], file: 'plugins/designer/commands/critique.md',
    from: 'if [ -n "${RUN_ID:-}" ] && [ -n "${VERDICT:-}" ]; then',
    to: 'if true; then',
    killed_by: [inSuite('designer/commands/critique.md (committed)', /^the authored finalize, run: /)],
    why: 'designer critique records an ensemble result when the peer never launched (D2 dropped)',
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
  {
    id: 'M55', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-checkpoint-host-availability.md', from: '`[{{persona}}-active-metadata]`', to: '`[{{persona}}-metadata]`' }),
    killed_by: templateCaught('regions/skill-checkpoint-host-availability.md', /^the checkpoint is written to the workflow Phase 1 found/),
    why: 'the checkpoint skill names a re-injection marker the persona\'s hook never prints',
  },
  {
    id: 'M56', tests: [T_SKILL],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/skill-start-command-intro.md', from: 'detached-HEAD guard,\nclean-baseline gate', to: 'detached-HEAD guard,\nredundancy probe, clean-baseline gate' }),
    killed_by: templateCaught('regions/skill-start-command-intro.md', /^start names only the Phase 0 steps its runbook runs/),
    why: 'start\'s skill names a redundancy probe its runbook never runs (the founder text before PC2a3)',
  },
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
  {
    id: 'M61', tests: [T_SKILL], file: 'plugins/designer/core/skills/start/SKILL.md',
    from: '**Carry the archetype inline, not as durable state.**', to: '**Carry the archetype.**',
    killed_by: inSuite('designer/core/skills/start/SKILL.md (committed)', /^each extension this persona's slots hold states the sentences it exists for/),
    why: 'designer start\'s skill keeps its archetype marker but loses the inline-carry rule it stands for',
  },
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
    killed_by: templateCaught('regions/skill-compose-state-write.md', /^compose confirms before any downstream verb/),
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
  {
    id: 'M69', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-initial-verb.md', from: 'The initial `verb` is `investigate`', to: 'The initial `verb` is `frame`' }),
    killed_by: templateCaught('regions/start-initial-verb.md', /^start lifecycle: /),
    why: 'start says its workflow begins at frame, not where the bootstrap creates it',
  },
  {
    id: 'M70', tests: [T_CONTRACT],
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: 'if [ "$BASELINE_RC" -ne 0 ]; then', to: 'if [ "$BASELINE_RC" -ne 0 ] && [ -z "$BASELINE" ]; then' }),
    killed_by: templateCaught('regions/start-bootstrap.md', /^start bootstrap, run: /),
    why: 'a failed clean-baseline check that printed a clean status creates the workflow',
  },
  {
    id: 'M71', tests: [T_CONTRACT],
    prepare: (copy) => {
      const path = join(copy, 'plugins/designer/commands/critique.md');
      const text = readFileSync(path, 'utf8');
      const heading = /<!-- pipeline:begin critique-finalize-heading -->\n[\s\S]*?<!-- pipeline:end critique-finalize-heading -->\n/.exec(text);
      const anchor = '<!-- pipeline:end critique-dispatch -->\n';
      if (!heading || !text.includes(anchor)) throw new MutationHarnessError('designer critique: no finalize heading region or dispatch end');
      const moved = text.replace(heading[0], () => '').replace(anchor, () => `${anchor}\n${heading[0]}`);
      if (moved.split(heading[0]).length !== 2) throw new MutationHarnessError('designer critique: the heading did not move whole');
      writeFileSync(path, moved);
    },
    killed_by: [inSuite('designer/commands/critique.md (committed)', /^the authored finalize follows the finalize heading region and every extension/)],
    why: 'designer critique\'s finalize heading moves above the synthesis instruction: the note would be finalized before the peer result is synthesized',
  },
  {
    id: 'M72', tests: [T_CONTRACT], file: 'plugins/designer/commands/refine.md',
    from: 'CONVERGED="<yes|no — from the re-critique verdict; unset means no>"', to: 'CONVERGED="yes"',
    killed_by: inSuite('designer/commands/refine.md (committed)', /^the authored finalize, run: /),
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
    prepare: (copy, tools) => templateDefect(copy, tools, { template: 'regions/start-bootstrap.md', from: 'REPO_ROOT="$(git rev-parse --show-toplevel)"\n', to: '' }),
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
    from: "  --terminal-marker true \\\n  --next-action 'Critique the composed planning artifact' \\\n",
    to: "  --terminal-marker true --force \\\n  --next-action 'Critique the composed planning artifact' \\\n",
    killed_by: /^the repository is clean$/,
    why: 'a hand edit inside a generated region of compose.md (the drift check must fail)',
  },

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
