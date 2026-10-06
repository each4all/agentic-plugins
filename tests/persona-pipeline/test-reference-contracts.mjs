// Reference contracts over the persona pipeline's shared references
// (ADR-0066 Decision 5, PC2a4 RD3).
//
// A reference runs nothing: an agent reads it and follows what it says, so
// this family checks the text, over each persona's committed documents and
// over the same documents assembled from the templates (what the next
// `--write` would produce):
//
//   - nothing left unrendered in a region-bearing reference;
//   - every in-plugin citation an agent follows resolves inside the same
//     plugin, and the `§ <heading>` after it names a heading the target
//     holds (a dangling file or § is how D6 and founder's peer-now § went
//     unnoticed: kit/lint resolves neither a bare sibling name nor a §);
//   - the capability text agrees with the declaration (no commit route for a
//     persona whose `commit_surface` is off, no dispatch claim for one whose
//     `dispatch_target` is off);
//   - the shared facts a reference region states agree with the generated
//     scripts that do the work (the preflight's projection slot and the
//     off-branch sweep, PC2a4 RV1).
//
// Each assertion is bound to its documents with a nonzero count, so a
// contract that matches nothing fails instead of passing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseRegions,
  regionBody,
  renderTemplate,
  renderingDeclaration,
  replaceRegionBodies,
} from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, pluginRoot } from './_personas.mjs';

const REFS = 'core/skills/_shared/references';
const CONTRACT = `${REFS}/entry-routing-contract.md`;
const PROTOCOL = `${REFS}/presentation-protocol.md`;
const HANDOFF = `${REFS}/session-handoff.md`;
const OUTPUT_RULES = 'core/skills/investigate/references/output-file-rules.md';
const ENSEMBLE = `${REFS}/ensemble-protocol.md`;
const GATE_SENTENCE = 'pass an explicit privacy gate before BOTH web search AND peer-host dispatch';
const PROTOCOL_CITE = 'Follow the Presentation Mode Protocol (`../_shared/references/presentation-protocol.md`) before presenting';

// The Present step of each verb skill, per invocation mode (PC2a4 RV6): the
// auto-activated site and the command-invoked one are counted apart, and
// `region` names the generated region a command site sits in. decide's
// command mode runs the auto-activated steps (its `decide-steps` region), so
// its one site serves both.
const PRESENT_SITES = {
  compose: { auto: /^### Step 4: Present and confirm$/m, command: /^### Step 5: Present$/m, region: 'compose-present' },
  frame: { auto: /^### Step 3: Present and confirm$/m, command: /^### Step 5: Present$/m, region: 'frame-present' },
  decide: { auto: /^### Step 4: Recommend$/m, command: null },
  critique: { auto: /^### Step \d: Synthesize$/m, command: /^### Step 6: Present$/m },
  refine: { auto: /^### Step 4: Present the result$/m, command: /^### Step 5: Synthesize/m },
  investigate: { auto: /^### Step 4: Synthesize and present \(auto mode\)$/m, command: /^### Step 5: Present$/m },
};

/** A skill's text for one invocation mode: from its `## When …` heading to the next `## ` heading. */
function modeText(text, mode) {
  const open = mode === 'auto' ? /^## When auto-activated/m : /^## When invoked by command/m;
  const at = text.search(open);
  if (at === -1) return null;
  const rest = text.slice(at);
  const end = rest.slice(3).search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end + 3);
}

/** A step's section inside a mode: from its heading to the next heading of level 1-3. */
function stepSection(text, heading) {
  const m = heading.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^#{1,3} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The personas the manifest gives a region-bearing shared reference. */
function referencePersonas() {
  const out = new Set();
  for (const r of MANIFEST.regions) if (r.dest.startsWith(`${REFS}/`)) for (const p of r.personas) out.add(p);
  return [...out].sort();
}
const PERSONAS = referencePersonas();

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(posix.normalize(full.slice(base.length + 1).split('\\').join('/')));
  }
  return out;
}

/** Every command, skill and reference a persona ships: plugin-relative path → text. */
function corpus(persona) {
  const root = pluginRoot(persona);
  const map = new Map();
  for (const sub of ['commands', 'core/skills']) {
    for (const rel of walk(join(root, sub))) map.set(`${sub}/${rel}`, readFileSync(join(root, sub, rel), 'utf8'));
  }
  return map;
}

function assemble(persona, dest, text) {
  const parsed = parseRegions(text, dest);
  deepStrictEqual(parsed.errors, [], `${persona}/${dest}: region grammar`);
  const bodies = {};
  for (const region of MANIFEST.regions.filter((r) => r.dest === dest && r.personas.includes(persona))) {
    const rendered = renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', region.template), 'utf8'), {
      declaration: renderingDeclaration(declaration(persona)),
      substitutions: region.substitutions ?? {},
      label: region.template,
    });
    bodies[region.id] = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
  }
  return replaceRegionBodies(text, parsed.regions, bodies);
}

/**
 * The persona's corpus twice: as committed, and with every region-bearing
 * document assembled from the templates. The assembled pass resolves its
 * citations against the assembled targets, never a target read from disk.
 */
function corpora(persona) {
  const committed = corpus(persona);
  const assembled = new Map();
  for (const [rel, text] of committed) {
    const enrolled = MANIFEST.regions.some((r) => r.dest === rel && r.personas.includes(persona));
    assembled.set(rel, enrolled ? assemble(persona, rel, text) : text);
  }
  return [['committed', committed], ['assembled from the templates', assembled]];
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
/** The whole `*.md` file names of a text: a name ends where a path or name character cannot follow. */
const mdFiles = (text) => [...text.matchAll(/(?<![\w.\/-])[\w.-]+\.md(?![\w.\/-])/g)].map((m) => m[0]);
const plain = (s) => squash(s.replace(/[`"“”‘’'*]/g, ''));

/**
 * The names a citation may carry that are not in-plugin documents: repository
 * paths outside the plugin (listed, not required to resolve), placeholders,
 * and the persona's own output file (an artifact the investigate verb writes,
 * named by its declaration), which is a file name, not a citation.
 */
function notACitation(persona, target) {
  if (/[<>…*$]/.test(target) || target === '.md') return 'placeholder';
  if (/^(docs|plugins|companions|tests|kit|scripts|persona-pipeline)\//.test(target)) return 'repository';
  const artifact = (declaration(persona).verbs?.investigate?.artifact ?? []).join('\n');
  if (!target.includes('/') && mdFiles(artifact).includes(target)) return 'output file';
  return null;
}

/**
 * Resolve a cited path from the citing document (both plugin-relative), or
 * null. The rules, in order: `./` and `../` from the citing directory;
 * `core/…` and `commands/…` from the plugin root; any other path from the
 * citing directory, then the citing skill's directory, then `core/skills/`;
 * a bare `SKILL.md` is the citing file's own skill; any other bare name is a
 * sibling of the citing file, then of `_shared/references/`, then of the
 * citing skill's `references/`. Last, a name (bare or `references/<name>`)
 * the rules above miss resolves to the one skill whose `references/` holds
 * it, when exactly one does: the shared references name the investigate
 * skill's brief references that way ("investigate's self-contained
 * `references/business-brief-ensemble.md`").
 */
function resolveCitation(docs, from, target) {
  const dir = posix.dirname(from);
  const skill = /^core\/skills\/[^/]+/.exec(from)?.[0] ?? null;
  const tries = [];
  if (target.startsWith('./') || target.startsWith('../')) tries.push(posix.join(dir, target));
  else if (/^(core|commands)\//.test(target)) tries.push(target);
  else if (target.includes('/')) {
    tries.push(posix.join(dir, target));
    if (skill) tries.push(posix.join(skill, target));
    tries.push(posix.join('core/skills', target));
  } else if (target === 'SKILL.md') {
    if (skill) tries.push(`${skill}/SKILL.md`);
  } else {
    tries.push(posix.join(dir, target), posix.join(REFS, target));
    if (skill) tries.push(posix.join(skill, 'references', target));
  }
  const found = tries.map((t) => posix.normalize(t)).find((t) => docs.has(t));
  if (found) return found;
  const name = /^(?:references\/)?([^/]+)$/.exec(target)?.[1];
  if (!name) return null;
  const owners = [...docs.keys()].filter((rel) => new RegExp(`^core/skills/[^/]+/references/${name.replace(/[.]/g, '\\.')}$`).test(rel));
  return owners.length === 1 ? owners[0] : null;
}

function headings(text) {
  let fence = false;
  const out = [];
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
      if (m) out.push(plain(m[1]));
    }
  }
  return out;
}

/**
 * The names a § may cite a heading by: its whole text, or its title — the text
 * before a ` — ` or `: ` subtitle, or before a trailing parenthetical (the
 * looser forms, reported). "Archive timing" names `## Archive timing — Claude
 * same-turn Stop vs Codex`; "State Bookkeeping" names `### State Bookkeeping
 * (Stage 2.5+)`.
 */
function headingNames(h) {
  const names = new Map([[h, null]]);
  for (const [cut, sep] of [[/ — /, ' —'], [/: /, ':'], [/ \(/, ' (']]) {
    const i = h.search(cut);
    if (i > 0) names.set(h.slice(0, i).trim(), sep);
  }
  return [...names];
}

/**
 * The § text starts with the name and ends it at a word boundary ("Step 1"
 * never names "Step 10"). A title cut from a longer heading must not go on
 * with the subtitle it was cut at: "Step 3: A missing step" names no
 * "Step 3: Present and confirm", and "Entry routing recommendation
 * (nonexistent)" no "(before Phase 1)".
 *
 * Limit: after a heading's whole text, the prose may go on with the same
 * separators (`§ Source Type Taxonomy: standards-heuristics, …`, `§ Design
 * Task Profile (the shared …)`, `§ Active Next-Action Proposal — derived
 * …`; 17 such sites in designer alone), so a § that adds a subtitle the
 * heading never had ("Routing Recommendation: Missing subsection") reads as
 * the heading plus prose and passes. A site where that matters is pinned
 * whole by its own contract (start's routing pointer below).
 */
function citesName(section, name, sep = null) {
  if (!section.startsWith(name)) return false;
  const rest = section.slice(name.length);
  if (rest.length > 0 && /[\p{L}\p{N}_-]/u.test(rest[0])) return false;
  return sep === null || !rest.startsWith(sep);
}

/**
 * Every citation of a document: a backticked `*.md` path, with the `§`
 * name after it (or inside the same backticks, the older form), the name
 * squashed across line breaks and stripped of quotes and backticks.
 */
function citations(text) {
  const out = [];
  const re = /`([^`\n]*\.md)(?:\s+§\s+([^`]+))?`(?=\s*§\s+([\s\S]{1,240})|)/g;
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split('\n').length;
    const section = m[2] ?? m[3] ?? null;
    out.push({ target: m[1].replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, ''), section: section === null ? null : plain(section), line });
  }
  return out;
}

/**
 * Check every citation of a corpus (plugin-relative path → text). Returns
 * `{ failures, loose, counted }`: a failure names the citing site; a loose
 * match is a § that matched a heading only without its parenthetical suffix.
 */
export function checkCitations(persona, docs) {
  const failures = [];
  const loose = [];
  let counted = 0;
  let sections = 0;
  for (const [from, text] of docs) {
    for (const c of citations(text)) {
      if (notACitation(persona, c.target)) continue;
      counted += 1;
      const target = resolveCitation(docs, from, c.target);
      if (!target) {
        failures.push(`${from}:${c.line}: cites ${c.target}, which plugins/${persona}/ does not hold`);
        continue;
      }
      if (c.section === null) continue;
      sections += 1;
      let best = null;
      for (const h of headings(docs.get(target))) {
        for (const [name, sep] of headingNames(h)) {
          if (!citesName(c.section, name, sep)) continue;
          const loose = name !== h;
          if (!best || (best.loose && !loose) || (best.loose === loose && name.length > best.name.length)) best = { text: h, name, loose };
        }
      }
      if (!best) failures.push(`${from}:${c.line}: cites ${c.target} § ${c.section.slice(0, 60)}…, which names no heading of ${target}`);
      else if (best.loose) loose.push(`${from}:${c.line} → ${target} § ${best.text}`);
    }
  }
  return { failures, loose, counted, sections };
}

/**
 * What a persona's own state.mjs holds about next steps and owner gates (PC2b
 * DD8): the documents are checked against the code that refuses or records,
 * never against a list restated here. Run with AGENTIC_* scrubbed, so the
 * caller's environment cannot change the answer.
 */
function stateFacts(persona) {
  const url = pathToFileURL(join(pluginRoot(persona), 'scripts/state.mjs')).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify({ settable: [...m.settableOwnerGates()].sort(), all: [...m.VALID_WORKFLOW_OWNER_GATES].sort(), kinds: [...m.VALID_NEXT_STEP_KINDS].sort() }));`,
  ], { encoding: 'utf8', env });
  return JSON.parse(out);
}

/** The first-column code cells of a Markdown table's rows (header and rule excluded). */
const tableColumn = (text, col) => [...text.matchAll(/^\|(.*)\|[ \t]*$/gm)]
  .map((m) => m[1].split('|').map((c) => c.trim()))
  .filter((cells) => !cells.every((c) => /^-+$/.test(c)))
  .map((cells) => /^`([^`]+)`$/.exec(cells[col] ?? '')?.[1])
  .filter(Boolean);

/** A region's body by id; fails when the document does not hold it once. */
function region(text, id) {
  const found = parseRegions(text).regions.filter((r) => r.id === id);
  strictEqual(found.length, 1, `region ${id}`);
  return regionBody(text, found[0]);
}

describe('reference contracts: the shared references hold generated regions for founder and designer', () => {
  it('the family reaches founder and designer', () => {
    deepStrictEqual(PERSONAS, ['designer', 'founder']);
  });
});

for (const persona of PERSONAS) {
  const caps = declaration(persona).capabilities;

  describe(`${persona}: reference contracts`, () => {
    for (const [label, docs] of corpora(persona)) {
      it(`${label}: nothing left unrendered in a region-bearing reference`, () => {
        const refs = [...docs.keys()].filter((rel) => rel.startsWith(`${REFS}/`) && MANIFEST.regions.some((r) => r.dest === rel && r.personas.includes(persona)));
        ok(refs.includes(CONTRACT), `${persona} ships ${CONTRACT} with regions`);
        ok(refs.includes(PROTOCOL), `${persona} ships ${PROTOCOL} with regions`);
        ok(refs.includes(ENSEMBLE), `${persona} ships ${ENSEMBLE} with regions`);
        for (const rel of refs) ok(!docs.get(rel).includes('{{'), `${rel}: unrendered "{{"`);
      });

      it(`${label}: every in-plugin citation resolves, and its § names a heading of the target`, (t) => {
        const { failures, loose, counted, sections } = checkCitations(persona, docs);
        deepStrictEqual(failures, []);
        // Floors: the extraction must keep reaching the corpus it was
        // calibrated on (PC2a4 U1: founder 159 in-plugin citations, 38 with a
        // §; designer 201, 67), so a broken extractor cannot pass by finding
        // nothing.
        const floor = { founder: [140, 34], designer: [180, 60] }[persona] ?? [100, 30];
        ok(counted >= floor[0], `${persona}: only ${counted} citations extracted`);
        ok(sections >= floor[1], `${persona}: only ${sections} § citations extracted`);
        if (loose.length > 0) t.diagnostic(`looser § matches (parenthetical suffix not cited): ${loose.join('; ')}`);
      });

      it(`${label}: the session handoff cites this persona's own preflight section (D6)`, () => {
        const cites = citations(docs.get(`${REFS}/session-handoff.md`)).filter((c) => c.target.endsWith('entry-routing-contract.md'));
        strictEqual(cites.length, 1);
        strictEqual(resolveCitation(docs, `${REFS}/session-handoff.md`, cites[0].target), CONTRACT);
        ok(cites[0].section.startsWith('Session-Level Continue-vs-Fresh Preflight'), cites[0].section);
        ok(squash(docs.get(`${REFS}/session-handoff.md`)).includes(`live in ${persona}'s own \`entry-routing-contract.md\` § Session-Level Continue-vs-Fresh Preflight`), 'the handoff names its own persona\'s contract, not engineer\'s');
      });

      it(`${label}: the capability text agrees with the declaration`, () => {
        const contract = docs.get(CONTRACT);
        // PC2b DD7: the closed next-step kinds finish-verb records, whatever
        // commit_surface says; off, `commit` means the owner publishes.
        const allowed = ['verb', 'commit', 'owner decision', 'done'];
        let blocks = 0;
        for (const [rel, text] of docs) {
          for (const m of text.matchAll(/^[ \t]*- selected_next:[ \t]*(.*)$/gm)) {
            blocks += 1;
            const options = /^<([^>\n]+)>$/.exec(m[1].trim())?.[1];
            ok(options, `${rel}: a proposal block's selected_next is "${m[1].trim()}", not the <…> placeholder of the allowed vocabulary`);
            for (const option of options.split('|').map((s) => s.trim())) {
              ok(allowed.includes(option), `${rel}: a proposal offers selected_next "${option}", which ${persona}'s contract does not allow (${allowed.join(' | ')})`);
            }
          }
        }
        ok(blocks >= 6, `${persona}: only ${blocks} proposal blocks found`);
        const commitMentions = [...docs].flatMap(([rel, text]) => [...text.matchAll(new RegExp(`[/$]${persona}:commit\\b`, 'g'))].map(() => rel));
        const proposal = region(contract, 'routing-proposal');
        const startRow = squash(region(contract, 'routing-routes')).match(new RegExp(`\\| \`${persona}:start\` \\|[^|]*\\|`))?.[0] ?? '';
        ok(startRow, 'the routes table holds the start row');
        if (caps.commit_surface) {
          ok(startRow.includes('to commit'), startRow);
        } else {
          deepStrictEqual(commitMentions, [CONTRACT], `only the contract may name /${persona}:commit, to say there is none`);
          ok(squash(proposal).includes(`There is no \`/${persona}:commit\`.`), 'the proposal says there is no commit command');
          ok(squash(proposal).includes(`A ${persona} workflow has no commit command: \`commit\` means the owner saves, commits or publishes`), 'the proposal says what `commit` means without a commit command');
          ok(squash(proposal).includes("for `commit`, the owner's save and commit, which nothing here runs; for `done`, none;"), 'the next command each closed kind takes');
          ok(startRow.includes('to its saved artifact'), startRow);
        }
        const orchestratorRow = squash(region(contract, 'routing-routes')).match(/\| `orchestrator:plan` \|[^|]*\|/)?.[0] ?? '';
        ok(orchestratorRow, 'the routes table holds the orchestrator row');
        if (!caps.dispatch_target) {
          ok(orchestratorRow.includes('dispatches its subtasks into engineer only'), orchestratorRow);
          ok(orchestratorRow.includes(`runs through \`/${persona}:start\``), orchestratorRow);
        }
      });


      it(`${label}: the owner-gates and next-step tables agree with this persona's state.mjs (PC2b DD8)`, () => {
        const facts = stateFacts(persona);
        const contract = docs.get(CONTRACT);
        const gates = squash(region(contract, 'routing-owner-gates'));
        const gateRows = tableColumn(region(contract, 'routing-owner-gates'), 0).filter((c) => c !== 'gate');
        ok(facts.settable.length >= 3, `${persona}: only ${facts.settable.length} settable gates read from state.mjs`);
        deepStrictEqual([...gateRows].sort(), facts.settable, 'the table lists exactly the gates this persona can set');
        for (const gate of facts.all.filter((g) => !facts.settable.includes(g))) {
          ok(new RegExp(`\`${gate}\` belongs to [^.]*, so \`state\\.mjs\` refuses to set it, naming the capability`).test(gates), `the contract says ${gate} is refused here`);
        }
        ok(gates.includes('Reading a workflow file, `state.mjs` accepts all five gate names'), 'readers accept every gate name');
        strictEqual(facts.all.length, 5);
        const kindRows = tableColumn(region(contract, 'routing-proposal'), 1).filter((c) => c !== 'next_step_kind');
        deepStrictEqual([...kindRows].sort(), facts.kinds, 'the closed-enum table maps onto exactly the kinds finish-verb accepts');
      });

      it(`${label}: the skills and the handoff name finish-verb as the terminal write (PC2b DD8)`, () => {
        const vocabulary = ['verb', 'commit', 'done', 'owner decision'];
        const verbs = ['compose', 'frame', 'decide', 'critique', 'refine', 'investigate', 'start'];
        for (const verb of verbs) {
          const rel = `core/skills/${verb}/SKILL.md`;
          const text = docs.get(rel);
          ok(text, rel);
          ok(/\bfinish-verb\b/.test(text), `${rel}: names finish-verb`);
          // set-terminal survives only as the marker-clearing escape.
          for (const m of text.matchAll(/set-terminal(.{0,20})/gs)) {
            ok(m[1].startsWith("'s full flag set"), `${rel}: names set-terminal outside the clearing escape: "${squash(m[0])}"`);
          }
          for (const m of text.matchAll(/^[ \t]*- selected_next:[ \t]*<([^>\n]+)>/gm)) {
            deepStrictEqual(m[1].split('|').map((s) => s.trim()), vocabulary, `${rel}: the proposal offers the runbook's closed vocabulary`);
          }
        }
        const owned = { decide: 'decide-conflict', refine: 'recurring-finding' };
        for (const [verb, gate] of Object.entries(owned)) {
          const text = squash(docs.get(`core/skills/${verb}/SKILL.md`));
          ok(text.includes(`ends with the \`${gate}\` owner gate instead of a terminal write`), `${verb}: names its gate`);
          ok(text.includes('`../_shared/references/entry-routing-contract.md` § Owner gates'), `${verb}: cites the gate table`);
        }
        const wiring = squash(region(docs.get(HANDOFF), 'handoff-wiring'));
        ok(wiring.includes('the terminal mutation (`state.mjs finish-verb`, the production completion entry point'), 'the handoff names finish-verb as the entry point');
        ok(wiring.includes('no active children, no owner gate pending'), 'the archive gates include gate 5');
        ok(wiring.includes('A `finish-verb` that records an owner gate is not a terminal write and emits nothing'), 'a gated finish-verb emits no footer');
        ok(squash(region(docs.get(HANDOFF), 'handoff-recipe')).includes('runs the same `finish-verb` CLI'), 'the Codex parity names finish-verb');
        ok(squash(docs.get(CONTRACT)).includes('write (`state.mjs finish-verb`) fires the handoff sidecar'), 'the preflight wiring names finish-verb');
        let skips = 0;
        for (const [rel, text] of docs) {
          if (!rel.startsWith('commands/')) continue;
          ok(!/companion unavailable/.test(text), `${rel}: a missing companion is a launched run, never a skip`);
          for (const m of text.matchAll(/### Ensemble skipped: [a-z-]+(?: \(profile=<profile>\))? \(([^)\n]*)\)`/g)) {
            skips += 1;
            strictEqual(m[1], 'privacy gate', `${rel}: the skip heading names the one reason no run launches`);
          }
        }
        ok(skips >= 6, `${persona}: only ${skips} skip headings found`);
        // Review of code step 6 (finding 7): settle cannot tell an answer of
        // structural shell from a real one, so every finalize that settles
        // tells the agent to pass degraded for it.
        const settling = [...docs].filter(([rel, text]) => rel.startsWith('commands/') && /peer-runner\.mjs" settle \\/.test(text));
        strictEqual(settling.length, 6, `${persona}: the six verb runbooks settle`);
        for (const [rel, text] of settling) {
          ok(squash(text).includes('An answer that parses to nothing usable, only structural shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.'), `${rel}: a structurally empty answer settles degraded`);
        }
      });

      it(`${label}: the presentation protocol ships whole, with the decision item as its unit (RV3)`, () => {
        const protocol = docs.get(PROTOCOL);
        ok(protocol, `${persona} ships ${PROTOCOL}`);
        ok(!protocol.includes('{{'), 'nothing left unrendered');
        const exclusions = squash(region(protocol, 'presentation-exclusions'));
        ok(exclusions.includes('one decision with its compared directions'), 'one decision with its directions is a single-item presentation');
        const rules = squash(region(protocol, 'presentation-rules'));
        ok(rules.includes('so this is a single-item presentation and the protocol does not split it'), 'Example 1 is presented whole');
        ok(!/per-option segments \+ 1 aggregate|\[1\/4\]/.test(rules), "Example 1 does not revert to engineer's per-option segments");
        // Example 1 keeps the order decide's output format sets: the
        // directions, then the comparison table after all of them.
        const analyses = rules.indexOf("1. Each direction's full analysis");
        const table = rules.indexOf('2. The multi-perspective comparison table, after all directions');
        ok(analyses >= 0 && table > analyses && rules.indexOf('3. The recommendation block') > table, 'Example 1 orders the directions, the table, then the recommendation');
        ok(squash(docs.get('core/skills/decide/SKILL.md')).includes('REQUIRED output format — after all directions:'), "decide's output format puts the table after all directions");
        ok(rules.includes('compare the branches with the compact multi-axis lens of `entry-routing-contract.md` § Surfacing the multi-axis lens from a non-decide verb'), 'the interaction rule surfaces the lens');
        ok(!rules.includes('run the full decide skill'), 'the interaction rule does not run the full decide inline');
        ok(rules.includes('every confirmation and approval gate a verb states still applies'), 'the protocol changes delivery only');
        const taxonomy = protocol.slice(protocol.indexOf('### Decision item taxonomy by content type'), protocol.indexOf('<!-- pipeline:begin presentation-rules -->'));
        ok(taxonomy.includes('| Direction comparison (decide) | One decision with its compared directions |'), 'the decide row is one decision with its compared directions');
        ok(!/autopilot/i.test(protocol), 'the autopilot sentences wait for PC2b');
      });

      it(`${label}: every verb skill's Present step follows the protocol, in each invocation mode (RV6)`, () => {
        let sites = 0;
        for (const [verb, site] of Object.entries(PRESENT_SITES)) {
          const rel = `core/skills/${verb}/SKILL.md`;
          const text = docs.get(rel);
          for (const mode of ['auto', 'command']) {
            const body = modeText(text, mode);
            ok(body, `${rel}: ${mode} mode section`);
            if (site[mode] === null) {
              ok(squash(region(text, `${verb}-steps`)).includes('Follow the auto-activated steps above'), `${rel}: command mode runs the auto-activated steps`);
              continue;
            }
            const section = stepSection(body, site[mode]);
            ok(section !== null, `${rel}: ${mode} mode has its Present step ${site[mode]}`);
            ok(squash(section).includes(PROTOCOL_CITE), `${rel}: the ${mode} Present step cites the presentation protocol`);
            if (mode === 'command' && site.region) ok(squash(region(text, site.region)).includes(PROTOCOL_CITE), `${rel}: the citation sits in the generated ${site.region} region`);
            sites += 1;
          }
        }
        strictEqual(sites, 11, 'eleven Present sites');
        ok(!/no\s+separate formal presentation protocol/.test(docs.get('core/skills/investigate/SKILL.md')), 'investigate no longer says the persona ships no protocol');
      });

      it(`${label}: the finalize note and the start routing cite the persona's own contract`, () => {
        for (const verb of ['compose', 'frame', 'investigate', 'decide']) {
          const text = docs.get(`commands/${verb}.md`);
          ok(text.includes('### Active next-action proposal\n\n(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)\n- selected_next:'), `commands/${verb}.md: the finalize note cites the contract right after its heading`);
        }
        const start = docs.get('core/skills/start/SKILL.md');
        const routing = stepSection(start, /^### Entry routing recommendation \(before Phase 1\)$/m);
        // Pinned whole: the citation check reads "§ Routing Recommendation:
        // <anything>" as the heading plus prose (its documented limit).
        ok(routing && squash(routing).includes('`../_shared/references/entry-routing-contract.md` § Routing Recommendation and the sections after it):'), 'start points at the contract § Routing Recommendation');
      });

      it(`${label}: the session handoff's capability and floor text agree with the declaration (RD6)`, () => {
        const text = docs.get(HANDOFF);
        const wiring = squash(region(text, 'handoff-wiring'));
        const decl = declaration(persona);
        ok(wiring.includes(`discovery floors at **${decl.runtime_footer_floor}** here`), 'the discovery floor is the declared runtime footer floor');
        if (!caps.dispatch_target) ok(wiring.includes(`${persona} declares \`dispatch_target\` off, so it carries no orchestrator parent`), 'no parent writeback for a dispatch_target-off persona');
        else ok(!wiring.includes('declares `dispatch_target` off'), 'a dispatch_target-on persona claims no off path');
        // Each claim renders only under the capability it states, so a
        // persona that turns the capability on never reads it.
        strictEqual(wiring.includes(`(${persona} declares \`legacy_homes\` off: canonical home only)`), !caps.legacy_homes, 'the projection slot states legacy_homes off exactly when it is off');
        strictEqual(wiring.includes(`\`/${persona}:start\` does not auto-commit`), !caps.commit_surface, 'start does not auto-commit exactly when commit_surface is off');
        const template = readFileSync(join(REPO_ROOT, 'persona-pipeline', 'regions', 'handoff-wiring.md'), 'utf8');
        for (const [claim, capability] of [['declares `legacy_homes` off', 'legacy_homes'], ['does not auto-commit', 'commit_surface']]) {
          const at = template.indexOf(claim);
          const open = template.lastIndexOf(`{{^capability ${capability}}}`, at);
          ok(at > 0 && open >= 0 && template.indexOf('{{/capability}}', open) > at, `the template states "${claim}" only under {{^capability ${capability}}}`);
        }
        ok(wiring.includes("The single-workflow marker shares the same LWW family"), 'the marker race is stated (true for every persona: the scripts are one source)');
        ok(!/ADR-00(36|42)\b/.test(wiring), 'the shared wiring cites capabilities, not a persona ADR');
        const recipe = region(text, 'handoff-recipe');
        const block = recipe.slice(recipe.indexOf('```bash'), recipe.indexOf('```\n', recipe.indexOf('```bash') + 7));
        ok(block.includes(`PERSONA='${persona}'`) && block.includes('--routing "/${PERSONA}:resume"'), 'the recipe routes to this persona through a literal PERSONA');
        strictEqual(block.split(persona).length - 1, 1, 'the shell block names the persona only in its PERSONA literal');
      });

      it(`${label}: the output-file rules name the brief file and output root the declaration implies (RD7)`, () => {
        const text = docs.get(OUTPUT_RULES);
        const decl = declaration(persona);
        // Read from the declaration directly, not through the derived fields.
        const files = mdFiles((decl.verbs.investigate.artifact ?? []).join('\n'));
        strictEqual(files.length, 1, 'the declared artifact names one brief file');
        const env = `${persona.toUpperCase().replace(/-/g, '_')}_OUTPUT_ROOT`;
        const generated = ['output-rules-intro', 'output-rules-layout', 'output-rules-files'].map((id) => region(text, id)).join('\n');
        ok(squash(generated).includes(`The brief file is **always** named \`${files[0]}\`.`), `the rules name ${files[0]}`);
        ok(generated.includes(`## Output root override (\`${env}\`)`), `the rules name ${env}`);
        ok(generated.includes(`Each ${decl.verbs.investigate.default_profile} is saved to its own per-topic directory`), 'the rules name the declared profile');
        const named = new Set([...generated.matchAll(/\b[a-z]+_brief\.md\b/g)].map((m) => m[0]));
        deepStrictEqual([...named], [files[0]], 'no other brief file name');
        ok(!/\bprevious (business|design)\b/.test(generated), 'the brief noun is unified');
      });

      it(`${label}: the lens's default size keeps a profile preset where the persona has one`, () => {
        const lens = squash(region(docs.get(CONTRACT), 'routing-lens'));
        const fence = /```bash\n([\s\S]*?)```/.exec(region(docs.get(CONTRACT), 'routing-lens'))?.[1] ?? '';
        const call = fence.split('\n').find((l) => l.includes('decide-registry.mjs" resolve')) ?? '';
        if (caps.profile_presets) {
          ok(lens.includes('an incidental in-verb branch resolves with no `--size` and the profile carried inline'), 'a profile-preset persona resolves without --size');
          ok(!lens.includes('uses `--size=minor`'), 'no default --size=minor that would drop the profile');
          // The illustrated call, run against the persona's own registry: the
          // variable it sets is the one the resolver reads, and with no
          // --size every profile keeps its preset.
          const variable = /^PROFILE_VAR='([A-Z_]+)'$/m.exec(fence)?.[1];
          ok(variable && call.startsWith('env "${PROFILE_VAR}=<profile>" node ') && !call.includes('--size'), call);
          const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AGENTIC_/.test(k)));
          for (const [profile, preset] of Object.entries(declaration(persona).decide.profile_presets)) {
            const out = execFileSync(process.execPath, [join(pluginRoot(persona), 'scripts', 'decide-registry.mjs'), 'resolve'], { env: { ...env, [variable]: profile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            strictEqual(JSON.parse(out).preset_id, preset, `profile ${profile} resolves ${preset} through ${variable}`);
          }
          // The skills' own lens sections agree: none resolves with a --size
          // that would drop the profile.
          for (const [rel, text] of docs) {
            if (rel.endsWith('/SKILL.md')) ok(!/decide-registry\.mjs resolve --size/.test(squash(text)), `${rel}: no lens call with --size`);
          }
        } else {
          ok(lens.includes('An incidental in-verb branch uses `--size=minor`'), 'default minor');
          ok(call.startsWith('node ') && call.includes('resolve --size=<minor|standard|major>') && !fence.includes('PROFILE_VAR'), call);
        }
      });

      it(`${label}: the preflight states what the generated scripts do (RV1)`, () => {
        const contract = docs.get(CONTRACT);
        const policy = squash(region(contract, 'routing-preflight-policy'));
        const slot = `.agentic-plugins/state/${persona}/last-session-handoff.json`;
        ok(policy.includes(`\`${slot}\``), 'the preflight names the projection slot');
        ok(policy.includes('clears a stale projection'), 'the preflight says a failed emit clears a stale projection');
        ok(policy.includes('archives a terminal workflow whose branch was deleted with no HEAD-movement gate'), 'the preflight states the off-branch sweep');
        for (const retired of ['never written to a second state-like artifact', 'only via the Stop hook after a real commit', 'only after a real commit']) {
          ok(!policy.includes(retired), `the preflight restores engineer's "${retired}", false for the generated scripts`);
        }
        const handoff = readFileSync(join(pluginRoot(persona), 'scripts', 'session-handoff.mjs'), 'utf8');
        ok(/resolve\(workflowDir\(repoRoot\), '\.\.', 'last-session-handoff\.json'\)/.test(handoff), 'the generated sidecar writes the slot the preflight names');
        ok(/if \(result\.status !== 'ok' \|\| !result\.projection\) \{\s*await clearStaleProjection\(target\);/.test(handoff), 'the generated sidecar clears a stale projection when it cannot project');
        const stop = readFileSync(join(pluginRoot(persona), 'scripts', 'stop-archive.mjs'), 'utf8');
        // A text check: the sweep's own comment states the rule the preflight
        // repeats. The behavior is test-stop-archive.mjs's orphan-sweep case
        // (mutation X41 turns the guard off and that case must fail).
        ok(stop.includes("`'absent'` (deleted): archived with no head_moved gate"), "the generated sweep's comment states the deleted-branch rule the preflight repeats");
      });

      it(`${label}: the ensemble Launch passes the privacy gate before any dispatch (RD5)`, () => {
        const text = docs.get(ENSEMBLE);
        const launch = squash(stepSection(text, /^### Step 1: Launch$/m) ?? '');
        const dispatch = launch.indexOf('`../../../../scripts/peer-runner.mjs run`');
        ok(dispatch > 0, 'the Launch step names the dispatch');
        const gate = launch.indexOf(`${squash(declaration(persona).peer.privacy_scope)} ${GATE_SENTENCE}.`);
        ok(gate > 0 && gate < dispatch, 'the Launch step gates the declared privacy scope before the dispatch step');
        ok(squash(region(text, 'ensemble-privacy-intro')).includes(`${GATE_SENTENCE}**`), 'the Privacy section states the gate');
        // A persona whose declared scope covers screenshots says, before the
        // dispatch step, that they are sensitive by default (designer's
        // authored sentence, kept ahead of the generated list, RV8).
        if (/screenshot/i.test(declaration(persona).peer.privacy_scope)) {
          const at = launch.indexOf('**Screenshots are sensitive by default**');
          ok(at >= 0 && at < dispatch, 'the screenshot sentence precedes the dispatch step');
        }
      });

      it(`${label}: the ensemble Collect reads the runner result before any envelope, in the runner's own terms (RV10)`, () => {
        const collect = squash(region(docs.get(ENSEMBLE), 'ensemble-collect'));
        const runnerAt = collect.indexOf('Read the peer-runner JSON first');
        const envelopeAt = collect.indexOf('`envelope_path` for the parsed companion envelope');
        ok(runnerAt >= 0 && envelopeAt >= 0, 'both reads are named');
        ok(runnerAt < envelopeAt, 'the runner result is read before the envelope');
        const nullAt = collect.indexOf('When `envelope_path` is null there is no envelope to read');
        ok(nullAt >= 0 && nullAt < envelopeAt, 'the no-envelope branch comes before the envelope read');
        const runner = readFileSync(join(pluginRoot(persona), 'scripts', 'peer-runner.mjs'), 'utf8');
        ok(/envelope_path: await exists\(paths\.envelope\) \? paths\.envelope : null,/.test(runner), 'the runner reports a null envelope_path when it wrote none');
        for (const kind of ['peer_cli_not_found', 'envelope_parse_error', 'envelope_shape_invalid']) {
          ok(collect.includes(`\`${kind}\``) || collect.includes(`error_kind: ${kind}\``), `the Collect step names ${kind}`);
          ok(new RegExp(`(?:error_kind = |errorKind: )'${kind}'`).test(runner), `the runner assigns error_kind ${kind}`);
        }
        const terminal = /TERMINAL_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(runner)?.[1] ?? '';
        for (const status of ['completed', 'failed', 'cancelled']) {
          ok(collect.includes(`\`${status}\``) && terminal.includes(`'${status}'`), `the runner status ${status} is named and terminal`);
        }
      });

      it(`${label}: State Bookkeeping excludes peer-now, and the peer-now skill agrees (RV7)`, () => {
        const section = squash(stepSection(docs.get(ENSEMBLE), /^### State Bookkeeping$/m) ?? '');
        ok(section.includes('**`peer-now` is structurally excluded** from `ensemble_results`'), 'the exclusion is stated');
        ok(section.includes('It **does** pass `--run-id`, which is the peer-run **ledger** key'), 'the run id is the ledger key');
        const skill = docs.get('core/skills/peer-now/SKILL.md');
        const named = /omits the three ensemble-accounting flags (?:\(([^)]*)\)|— ([^—]*) —)/.exec(squash(skill));
        const omitted = named?.[1] ?? named?.[2];
        ok(omitted, 'the peer-now skill names the flags it omits');
        deepStrictEqual(omitted.match(/--[a-z-]+/g), ['--workflow-path', '--phase', '--ensemble-type'], `the peer-now skill names exactly the three accounting flags as omitted: ${omitted}`);
        const dispatch = region(skill, 'peer-now-dispatch');
        ok(/--run-id "\$RUN_ID" --kind peer-now/.test(dispatch), 'the peer-now dispatch passes --run-id');
        for (const flag of ['--workflow-path', '--phase', '--ensemble-type']) ok(!dispatch.includes(flag), `the peer-now dispatch omits ${flag}`);
        const runner = readFileSync(join(pluginRoot(persona), 'scripts', 'peer-runner.mjs'), 'utf8');
        ok(runner.includes("if (handle.kind !== 'ensemble') return;"), 'the runner registers a pending row only for an ensemble');
      });

      it(`${label}: the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches (RD8, RV10)`, () => {
        const decl = declaration(persona);
        const brief = docs.get(`core/skills/investigate/references/${decl.verbs.investigate.default_profile}-ensemble.md`);
        ok(brief, 'the brief ensemble is named by the declared brief profile');
        const launch = squash(stepSection(brief, /^### Step 1: Launch\b.*$/m) ?? '');
        const dispatch = launch.indexOf("`peer-runner.mjs run` resolves the peer-companion");
        ok(dispatch > 0, 'the Launch step names the dispatch');
        const gate = launch.indexOf(`${squash(decl.peer.privacy_scope)} ${GATE_SENTENCE}`);
        ok(gate > 0 && gate < dispatch, 'the pre-conditions gate the declared privacy scope before the dispatch step');
        if (/screenshot/i.test(decl.peer.privacy_scope)) {
          const at = launch.indexOf('**Screenshots are sensitive by default**');
          ok(at >= 0 && at < dispatch, 'the screenshot sentence precedes the dispatch step');
        }
        const collect = squash(region(brief, 'brief-ensemble-collect'));
        const runnerAt = collect.indexOf('Read the peer-runner JSON first');
        const envelopeAt = collect.indexOf('`envelope_path` for the parsed companion envelope');
        ok(runnerAt >= 0 && runnerAt < envelopeAt, 'the runner result is read before the envelope');
        const nullAt = collect.indexOf('When `envelope_path` is null there is no envelope to read');
        ok(nullAt > runnerAt && nullAt < envelopeAt, 'the no-envelope branch comes between the runner result and the envelope read');
        ok(!/from the companion's stdout/.test(collect), "the envelope is not read from the companion's stdout");
        // The investigate runbook's generated dispatch is what the brief
        // describes: the runner writes its JSON result, under the declared
        // ensemble type.
        const run = docs.get('commands/investigate.md');
        ok(run.includes('scripts/peer-runner.mjs" run') && run.includes('> "$PROMPT_FILE.run.json"'), 'the investigate runbook dispatches through the runner and keeps its JSON result');
        ok(run.includes(`ENSEMBLE_TYPE='${decl.verbs.investigate.ensemble_type}'\n`) && run.includes('--ensemble-type "$ENSEMBLE_TYPE" --run-id'), 'under the declared ensemble type');
      });

      it(`${label}: the brief recovery inspects the run before a retry, in the runner's terms (RV11)`, () => {
        const decl = declaration(persona);
        const state = squash(region(docs.get(`core/skills/investigate/references/${decl.verbs.investigate.default_profile}-ensemble.md`), 'brief-ensemble-state'));
        const inspect = state.indexOf('Inspect that run before dispatching again: `peer-runner.mjs status --run-id <run_id> --json`');
        const retry = state.indexOf('A retry takes a fresh run id, since the runner refuses a `run_id` whose ledger already exists.');
        ok(inspect >= 0, 'the recovery inspects the run');
        ok(retry > inspect, 'a retry, with a fresh run id, comes only after the inspection');
        for (const branch of ['- `live: true` — the companion is still running', '- `derived_status: completed_uncommitted` — the companion finished', 'read `paths.envelope` as Step 2 item 3 reads `envelope_path`', 'with no new dispatch']) {
          ok(state.indexOf(branch) > inspect && state.indexOf(branch) < retry, `the inspection branches: ${branch}`);
        }
        // PC2b RV5: the old attempt is settled from its ledger, never with a
        // verdict the agent picks.
        ok(state.includes('cancel the old run if it is still live, then settle it with `peer-runner.mjs settle --run-id <old run_id>`, whether the step retries or proceeds local-only. The ledger decides what that records (verdict `failed` with its `error_kind` for a run that ended without a usable answer), never a verdict the agent picks'), 'the old pending entry is settled from its ledger');
        ok(state.includes('settle it in the finalize (`peer-runner.mjs settle --run-id <run_id>`), with no new dispatch'), 'a finished run is settled, not committed by hand');
        for (const retired of [/idempotent on `run_id`/, /reuses? the (previous|same) run id/i, /sees both the in-flight phase note/, /at each protocol step/, /state\.mjs ensemble-commit/, /abandoned/]) {
          ok(!retired.test(state), `the recovery does not say ${retired}`);
        }
        const runner = readFileSync(join(pluginRoot(persona), 'scripts', 'peer-runner.mjs'), 'utf8');
        ok(runner.includes("return 'completed_uncommitted';") && /derived_status: derived,\s+live,/.test(runner), 'the runner status reports derived_status and live');
        ok(runner.includes('envelope: await exists(paths.envelope) ? paths.envelope : null,'), 'the runner status reports paths.envelope');
        ok(runner.includes('peer-run ledger already exists for run_id'), 'the runner refuses an existing run id');
      });

      it(`${label}: the brief spec's label policy names the declared ensemble type and brief ensemble (RD8)`, () => {
        const decl = declaration(persona);
        const profile = decl.verbs.investigate.default_profile;
        const policy = squash(region(docs.get(`core/skills/investigate/references/${profile}-spec.md`), 'brief-spec-label-policy'));
        ok(policy.includes(`When \`${persona}:investigate --profile=${profile}\` runs in command-mode, the bidirectional ${decl.verbs.investigate.ensemble_type} ensemble (per \`${profile}-ensemble.md\`)`), policy.slice(0, 160));
        for (const rule of [
          'No host-named markers anywhere in the brief — none of `[Local]`, `[Peer]`, `[Both]`, or any host-specific equivalent.',
          'Numeric `[N]` citations remain the only labeling format in Findings and Sources.',
          `they are remapped to capture-order numbering by Citation Remapping (canonical rule in \`${profile}-ensemble.md\`)`,
          'communicated only in the user-facing completion summary that follows the save, never inside the brief artifact.',
        ]) ok(policy.includes(rule), `the label policy states: ${rule}`);
        ok(squash(region(docs.get(`core/skills/investigate/references/${profile}-spec.md`), 'brief-spec-citations')).includes('### Access Date ISO format `YYYY-MM-DD`.'), 'the citation conventions keep the access date');
      });

      it(`${label}: the failure handling sections keep every case (RD8, RD9)`, () => {
        const decl = declaration(persona);
        const failure = region(docs.get(`core/skills/investigate/references/${decl.verbs.investigate.default_profile}-ensemble.md`), 'brief-ensemble-failure');
        const cases = [...failure.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
        deepStrictEqual(cases, [
          'Peer host CLI unavailable, not installed, or unauthenticated',
          'Peer timeout or runtime error',
          'Peer returns empty output',
          'Peer returns malformed partial output',
          'Peer returns PEER-ONLY claim with no source URL',
          'Graceful degradation principle',
        ]);
        const sections = Object.fromEntries(failure.split(/^### /m).slice(1).map((s) => [s.slice(0, s.indexOf('\n')), squash(s.slice(s.indexOf('\n')))]));
        for (const [name, action] of Object.entries({
          // PC2b RV5: each failure is settled from the run ledger, never skipped by hand.
          'Peer host CLI unavailable, not installed, or unauthenticated': 'Action: Proceed with local-only research, silently. A run the runner started settles as verdict `failed` with this `error_kind` (`peer-runner.mjs settle`); with no run launched there is nothing to settle.',
          'Peer timeout or runtime error': 'Action: Proceed local-only; settling the attempt records verdict `failed` with the ledger\'s `error_kind`.',
          // Review of code step 6 (finding 7): settle cannot tell an answer of
          // structural shell from a real one, so the agent passes degraded.
          'Peer returns empty output': 'Action: Treat as if the peer was unavailable. Proceed local-only; settling the completed attempt records verdict `degraded`. `settle` sees an empty or unreadable answer itself; an answer that parses to only structural shell reads to it like any other, so pass `degraded` as the synthesis verdict then.',
          'Peer returns malformed partial output': 'Discard claims with unverifiable or empty source URLs.',
          'Peer returns PEER-ONLY claim with no source URL': 'Discard the claim. Do NOT add it to Open Questions',
          'Graceful degradation principle': 'Ensemble failure NEVER blocks save.',
        })) ok(sections[name]?.includes(action), `${name}: ${action}`);
        const orchestration = docs.get(`${REFS}/orchestration.md`);
        const local = squash(region(orchestration, 'orchestration-failure'));
        ok(/^#{2,3} Failure handling$/m.test(orchestration.slice(0, orchestration.indexOf('<!-- pipeline:begin orchestration-failure -->'))), 'under its Failure handling heading');
        for (const fact of ['notify the user which perspective failed, ask retry-or-proceed', 'note the missing perspective in the synthesis', 'Peer ensemble failures are handled separately per the ensemble contract — graceful degradation, never blocks the workflow.']) {
          ok(local.includes(fact), `orchestration failure handling: ${fact}`);
        }
      });

      // PC2b RV5: every agent-facing failure path follows the settle policy:
      // nothing is skipped or committed by hand.
      it(`${label}: the protocol's collect step and each failure action settle the attempt from its run ledger (RV5)`, () => {
        const doc = docs.get(ENSEMBLE);
        const collect = squash(region(doc, 'ensemble-collect'));
        ok(collect.includes('Either way the finalize settles the attempt from its run ledger (`peer-runner.mjs settle`), which records what the ledger shows: verdict `failed` with its `error_kind`, `degraded` for a completed run with no usable answer, or the synthesis verdict. The ledger shows an empty or unreadable answer; for one that parses to nothing usable, only structural shell, the synthesis verdict is `degraded`.'), collect);
        for (const [id, action] of [
          ['ensemble-failure-unavailable', '- **Action**: Proceed with orchestrator-only analysis, silently. A run the runner started settles as verdict `failed` with this `error_kind` (`peer-runner.mjs settle`); with no run launched there is nothing to settle.'],
          ['ensemble-failure-error', '- **Action**: Proceed orchestrator-only; settling the attempt records verdict `failed` with the ledger\'s `error_kind`.'],
          ['ensemble-failure-empty', 'A completed run with no usable answer at all settles as verdict `degraded`. `settle` sees an empty or unreadable answer itself; an answer that parses to no findings, only structural shell, reads to it like any other, so pass `degraded` as the synthesis verdict then.'],
        ]) {
          const text = squash(region(doc, id));
          ok(text.includes(action), `${id}: ${text}`);
          ok(!/Skip the dispatch|Record the failure mode internally/.test(text), `${id}: no hand skip`);
        }
      });

      it(`${label}: no runbook guards ensemble-commit on shell variables, and the protocol says settle decides from the run ledger instead (D2, PC2b U5b)`, () => {
        const section = squash(stepSection(docs.get(ENSEMBLE), /^### State Bookkeeping$/m) ?? '');
        // D2 is fixed at its source: every finalize settles the attempt from
        // its run ledger (peer-runner.mjs settle), so no runbook keeps a
        // shell guard on RUN_ID and VERDICT, and the protocol no longer tells
        // the agent to skip ensemble-commit by hand.
        const guarded = [...docs]
          .filter(([rel, text]) => rel.startsWith('commands/') && /^\s*if \[ -n "\$\{RUN_ID:-\}" \]/m.test(text))
          .map(([rel]) => rel)
          .sort();
        deepStrictEqual(guarded, []);
        strictEqual(section.includes('**Do not record an ensemble that never ran.**'), false, 'the hand-skip sentence is gone');
        const settles = [...docs].filter(([rel, text]) => rel.startsWith('commands/') && /peer-runner\.mjs" settle \\/.test(text)).map(([rel]) => rel).sort();
        deepStrictEqual(settles, ['commands/compose.md', 'commands/critique.md', 'commands/decide.md', 'commands/frame.md', 'commands/investigate.md', 'commands/refine.md'], 'every verb finalize settles');
        for (const fact of [
          '**Each attempt is settled from its run ledger.** A verb\'s finalize runs `../../../../scripts/peer-runner.mjs settle` with the run id its dispatch generated (empty when no run launched) before its last write, and the ledger, not the agent, decides what the workflow records:',
          '- never launched (no dispatch ran: the privacy gate kept the verb local-only): nothing, and the phase note\'s first heading reads `### Ensemble skipped: …`;',
          '- launched, then failed, cancelled or abandoned: an `ensemble_results` entry with verdict `failed` and the ledger\'s `error_kind` in its summary;',
          '- completed: the synthesis verdict, or `degraded` when the answer was empty or unreadable (the synthesis is then local-only). An answer that parses to nothing usable, only structural shell, reads to `settle` like any other: the synthesis judges it, and its verdict is then `degraded`.',
          '`settle` refuses while the run is still live (collect it first), and when an empty run id would hide a run that launched for the same workflow and phase.',
        ]) ok(section.includes(fact), fact);
      });
    }
  });
}

describe('reference contracts: the citation check catches what it exists for', () => {
  it('fails a bare sibling the plugin does not ship (the D6 form)', () => {
    const docs = new Map([[`${REFS}/session-handoff.md`, 'live in the engineer plugin\'s\n`entry-routing-contract.md § Session-Level Continue-vs-Fresh Preflight\n(ADR-0031)` (the single source)\n']]);
    const { failures } = checkCitations('founder', docs);
    strictEqual(failures.length, 1);
    ok(failures[0].includes('cites entry-routing-contract.md, which plugins/founder/ does not hold'), failures[0]);
  });

  it('fails a § the target does not hold, and accepts the one it does', () => {
    const docs = new Map([
      [`${REFS}/a.md`, 'See `b.md` § Missing heading.\nSee `b.md` § Present heading, and `./b.md` § State Bookkeeping.\n'],
      [`${REFS}/b.md`, '# B\n\n## Present heading\n\n### State Bookkeeping (Stage 2.5+)\n'],
    ]);
    const { failures, loose } = checkCitations('founder', docs);
    strictEqual(failures.length, 1);
    ok(failures[0].includes('names no heading'), failures[0]);
    strictEqual(loose.length, 1);
  });

  it('fails a title that goes on with a subtitle the heading does not have, and accepts quoted names', () => {
    const docs = new Map([
      [`${REFS}/a.md`, "See `b.md` § Step 3: A missing step.\nSee `b.md` § Entry routing (nonexistent).\nSee `b.md` § 'Step 3: Present and confirm', `b.md` § ‘Entry routing’ and `b.md` § Step 3 below.\n"],
      [`${REFS}/b.md`, '# B\n\n### Step 3: Present and confirm\n\n### Entry routing (before Phase 1)\n'],
    ]);
    const { failures } = checkCitations('founder', docs);
    strictEqual(failures.length, 2, failures.join('\n'));
    ok(failures[0].includes('§ Step 3: A missing step') && failures[1].includes('§ Entry routing (nonexistent)'), failures.join('\n'));
  });

  it('exempts only the declared brief file by its whole name, never a name it contains', () => {
    const docs = new Map([[`${REFS}/a.md`, 'Saved as `business_brief.md`; see `brief.md`.\n']]);
    const { failures } = checkCitations('founder', docs);
    deepStrictEqual(failures.map((f) => f.split(': cites ')[1].split(',')[0]), ['brief.md']);
  });
});
