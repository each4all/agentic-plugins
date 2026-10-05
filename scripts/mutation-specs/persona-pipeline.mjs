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
//   V  declaration format 1.1 (PC2a2): the loader's reader parity with the
//      schema, the generator's cross-field rules, the declared verb fields
//      bound to the runbooks; K, the verb runbook characterization (T0); L,
//      the engine's list values;
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
function templateDefect(copy, tools, { template, from, to, only = null }) {
  const keep = {};
  for (const persona of regionPersonas(template)) {
    if (only === null || persona === only) continue;
    for (const dest of regionDests(template)) keep[join('plugins', persona, dest)] = readFileSync(join(copy, 'plugins', persona, dest), 'utf8');
  }
  const source = join(copy, 'persona-pipeline', template);
  const canonical = readFileSync(source, 'utf8');
  tools.applyEdit(copy, { file: `persona-pipeline/${template}`, from, to });
  regenerate(copy);
  for (const [rel, text] of Object.entries(keep)) writeFileSync(join(copy, rel), text);
  // With `only`, the template goes back too: every other persona's committed
  // and assembled runbook is then clean, so a kill names `only` (Codex review).
  if (only !== null) writeFileSync(source, canonical);
}

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
      for (const template of [...new Set(MANIFEST.regions.map((r) => r.template))].filter((t) => t !== 'regions/plugin-root.md')) {
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
      from: 'const READER_MINOR = 1;',
      to: 'const READER_MINOR = 0;',
    }),
    why: 'the loader reads as 1.0 again and forgives an unknown scalar the schema refuses at the same minor (the readers disagree)',
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
    from: '  --phase compose --ensemble-type plan-verify --run-id "$RUN_ID" \\\n  --verdict',
    to: '  --phase compose --ensemble-type brainstorm --run-id "$RUN_ID" \\\n  --verdict',
    why: 'founder compose commits its ensemble result under another type than it dispatched (the T0 characterization must fail)',
  },
  {
    id: 'K2', tests: [T_CHAR], file: 'plugins/designer/commands/frame.md', expect: 'SURVIVED',
    from: '--persona designer \\',
    to: "--persona 'designer' \\",
    why: 'a quoting change alone (Decision 4 renders persona values as single-quoted literals) is not a difference the characterization reports',
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
