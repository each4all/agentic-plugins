// Reference contracts over the persona pipeline's shared references.
//
// A reference runs nothing: an agent reads it and follows what it says. This
// family checks each persona's committed documents, and the same documents
// assembled from the templates (what the next `--write` would produce), for:
//
//   - structure: nothing left unrendered in a region-bearing reference, and
//     every in-plugin citation resolves inside the same plugin with its
//     `§ <heading>` naming a heading the target holds (kit/lint resolves
//     neither a bare sibling name nor a §);
//   - the instructions that change what an agent runs: the commands, flags,
//     gate and next-step values it passes, the order of its calls, and where
//     it stops or hands off, bound where they can be to the generated
//     scripts that accept them;
//   - capability honesty: under every legal capability combination, a
//     persona gets no command, script, gate or path its declaration lacks.
//
// Which personas each reference holds generated regions for is pinned below;
// a contract about a reference a persona does not hold is skipped for it,
// with the reason. Each text assertion carries a comment naming its consumer
// and the defect it rejects, and each is bound to its documents with a
// nonzero count, so a contract that matches nothing fails instead of passing.

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
const ORCHESTRATION = `${REFS}/orchestration.md`;
const GATE_SENTENCE = 'pass an explicit privacy gate before BOTH web search AND peer-host dispatch';
// The ensemble protocol's regions that state a peer privacy policy, held by
// exactly the personas that declare one.
const PRIVACY_REGIONS = ['ensemble-launch-privacy', 'ensemble-privacy-contract', 'ensemble-privacy-intro', 'ensemble-privacy-bidirectional'];
// The brief ensemble's, likewise.
const BRIEF_PRIVACY_REGIONS = ['brief-ensemble-launch-privacy', 'brief-ensemble-privacy-bidirectional'];

/** A step's section: from its heading to the next heading of level 1-3. */
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

/** Whether the manifest gives `persona` generated regions in `rel`. */
const enrolled = (persona, rel) => MANIFEST.regions.some((r) => r.dest === rel && r.personas.includes(persona));

/**
 * The investigate brief profile, read from the declaration directly, not
 * through the derived field: the declared one, else the default profile.
 */
const briefProfile = (persona) => { const v = declaration(persona).verbs.investigate; return v.brief_profile ?? v.default_profile; };
/** The investigate brief reference of a kind (`ensemble`, `spec`) the declaration names. */
const briefRef = (persona, kind) => `core/skills/investigate/references/${briefProfile(persona)}-${kind}.md`;

/**
 * The node:test options of a contract about `rels`: skipped, with the reason,
 * while `persona` holds no generated regions in one of them.
 */
function holding(persona, ...rels) {
  const missing = rels.filter((rel) => !enrolled(persona, rel));
  return missing.length === 0
    ? {}
    : { skip: `${persona} holds no generated regions in ${missing.join(', ')}` };
}

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
 * the heading plus prose and passes.
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
 * squashed across line breaks and stripped of quotes and backticks. A path
 * that is a Markdown link's text (`` [`x.md`](…) ``) carries the `§` after
 * the link, and a quoted name may follow the `§` with no space (`§"…"`).
 */
function citations(text) {
  const out = [];
  const re = /`([^`\n]*\.md)(?:\s+§\s+([^`]+))?`(?=(?:\]\([^)\s]*\))?\s*§(?:\s+|(?=["“'‘]))([\s\S]{1,240})|)/g;
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
 * What a persona's own state.mjs accepts: the owner gates it can set, the
 * next-step kinds finish-verb records, and its pre-migration home. The
 * documents are checked against the code that refuses or records, never
 * against a list restated here. Run with AGENTIC_* scrubbed, so the caller's
 * environment cannot change the answer.
 */
function stateFacts(persona) {
  const url = pathToFileURL(join(pluginRoot(persona), 'scripts/state.mjs')).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify({ settable: [...m.settableOwnerGates()].sort(), kinds: [...m.VALID_NEXT_STEP_KINDS].sort(), legacyDir: m.legacyStateDirRel() }));`,
  ], { encoding: 'utf8', env });
  return JSON.parse(out);
}

/** The code cells of one column of a Markdown table's rows (header and rule excluded). */
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

describe('reference contracts: which personas each reference holds generated regions for', () => {
  it('the manifest enrolls each persona in each shared reference these contracts read', () => {
    // Contract: the sync generates each region into exactly these personas'
    // copies — a dropped enrollment would skip that persona's contracts below
    // (`holding`) instead of failing them.
    deepStrictEqual(PERSONAS, ['designer', 'engineer', 'founder']);
    const dests = [...new Set(MANIFEST.regions.map((r) => r.dest).filter((d) => d.includes('/references/')))].sort();
    deepStrictEqual(Object.fromEntries(dests.map((d) => [d, MANIFEST.personas.filter((p) => enrolled(p, d))])), {
      [CONTRACT]: ['designer', 'engineer', 'founder'],
      [ENSEMBLE]: ['designer', 'engineer', 'founder'],
      [ORCHESTRATION]: ['designer', 'engineer', 'founder'],
      [PROTOCOL]: ['designer', 'engineer', 'founder'],
      [HANDOFF]: ['designer', 'engineer', 'founder'],
      'core/skills/investigate/references/business-brief-ensemble.md': ['founder'],
      'core/skills/investigate/references/business-brief-spec.md': ['founder'],
      'core/skills/investigate/references/cited-brief-ensemble.md': ['engineer'],
      'core/skills/investigate/references/cited-brief-spec.md': ['engineer'],
      'core/skills/investigate/references/design-brief-ensemble.md': ['designer'],
      'core/skills/investigate/references/design-brief-spec.md': ['designer'],
      [OUTPUT_RULES]: ['designer', 'engineer', 'founder'],
    });
  });
});

for (const persona of PERSONAS) {
  const caps = declaration(persona).capabilities;

  describe(`${persona}: reference contracts`, () => {
    for (const [label, docs] of corpora(persona)) {
      it(`${label}: nothing left unrendered in a region-bearing reference`, () => {
        const refs = [...docs.keys()].filter((rel) => rel.startsWith(`${REFS}/`) && enrolled(persona, rel));
        // Every reference the manifest enrolls the persona in ships, with
        // regions (the enrollment table above names them).
        deepStrictEqual(refs.sort(), [...new Set(MANIFEST.regions.filter((r) => r.dest.startsWith(`${REFS}/`) && r.personas.includes(persona)).map((r) => r.dest))].sort());
        ok(refs.includes(HANDOFF), `${persona} ships ${HANDOFF} with regions`);
        // Contract: the agent reading a reference — a `{{` left behind is a
        // template tag the sync never rendered, an instruction with a hole in it.
        for (const rel of refs) ok(!docs.get(rel).includes('{{'), `${rel}: unrendered "{{"`);
      });

      it(`${label}: every in-plugin citation resolves, and its § names a heading of the target`, (t) => {
        // Contract: the agent following a citation — a file the plugin does
        // not ship, or a § no heading of the target holds, sends it to nothing.
        const { failures, loose, counted, sections } = checkCitations(persona, docs);
        deepStrictEqual(failures, []);
        // Floors: the extraction must keep reaching the corpus it was
        // calibrated on (founder 159 in-plugin citations, 38 with a §;
        // designer 201, 67; engineer 266, 104), so a broken extractor cannot
        // pass by finding nothing.
        const floor = { founder: [140, 34], designer: [180, 60], engineer: [240, 90] }[persona] ?? [100, 30];
        ok(counted >= floor[0], `${persona}: only ${counted} citations extracted`);
        ok(sections >= floor[1], `${persona}: only ${sections} § citations extracted`);
        if (loose.length > 0) t.diagnostic(`looser § matches (parenthetical suffix not cited): ${loose.join('; ')}`);
      });

      it(`${label}: the capability text agrees with the declaration`, holding(persona, CONTRACT), () => {
        const contract = docs.get(CONTRACT);
        // Contract: the agent filling a proposal block — each `selected_next`
        // option maps to a `finish-verb --next-step-kind` value (the closed
        // kinds, whatever commit_surface says); any other option, or a literal
        // in place of the placeholder, is a next step the terminal write
        // cannot record.
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
        const proposal = squash(region(contract, 'routing-proposal'));
        if (caps.commit_surface) {
          // Contract: the agent handing off — with a commit surface, `commit`
          // and `done` both take `/<persona>:commit` as the next command (done
          // closes the workflow through it); "none" for done leaves it open.
          ok(proposal.includes(`for \`commit\`, \`/${persona}:commit\` / \`$${persona}:commit\``), 'commit takes the commit command');
          ok(proposal.includes('for `done`, the same command'), 'done takes the commit command too');
          // Contract: the same agent — a denial of the commit command it has
          // would keep it from running that command.
          ok(!proposal.includes('There is no `/'), 'a commit-surface persona does not deny its commit command');
        } else {
          // Contract: the agent handing off — with commit_surface off there is
          // no commit command, so only the contract may name it (to deny it);
          // any other mention routes the agent to a command that does not exist.
          deepStrictEqual(commitMentions, [CONTRACT], `only the contract may name /${persona}:commit, to say there is none`);
          // Contract: the same agent — without a commit command, `commit`
          // hands off to the owner and `done` to no command at all.
          ok(proposal.includes("for `commit`, the owner's save and commit"), 'commit hands off to the owner');
          ok(proposal.includes('for `done`, none;'), 'done takes no command');
        }
        if (!caps.dispatch_target) {
          const orchestratorRow = squash(region(contract, 'routing-routes')).match(/\| `orchestrator:plan` \|[^|]*\|/)?.[0] ?? '';
          ok(orchestratorRow, 'the routes table holds the orchestrator row');
          // Contract: the agent routing a multi-deliverable request — the
          // orchestrator dispatches into engineer only, so this persona's
          // deliverable runs through its own start command; a row without it
          // claims a dispatch route the persona lacks.
          ok(orchestratorRow.includes(`runs through \`/${persona}:start\``), orchestratorRow);
        }
      });

      it(`${label}: the owner-gates and next-step tables agree with this persona's state.mjs (PC2b DD8)`, holding(persona, CONTRACT), () => {
        const facts = stateFacts(persona);
        const contract = docs.get(CONTRACT);
        // Contract: the agent ending a verb on an owner judgment passes the
        // table's gate to `finish-verb --owner-gate` — a gate this persona's
        // state.mjs refuses fails the write, and a missing one leaves the agent
        // no gate to set.
        const gateRows = tableColumn(region(contract, 'routing-owner-gates'), 0).filter((c) => c !== 'gate');
        ok(facts.settable.length >= 3, `${persona}: only ${facts.settable.length} settable gates read from state.mjs`);
        deepStrictEqual([...gateRows].sort(), facts.settable, 'the table lists exactly the gates this persona can set');
        // Contract: the agent maps `selected_next` through this table to
        // `finish-verb --next-step-kind` — a kind finish-verb does not accept
        // fails the terminal write, a missing one leaves a next step unmapped.
        const kindRows = tableColumn(region(contract, 'routing-proposal'), 1).filter((c) => c !== 'next_step_kind');
        deepStrictEqual([...kindRows].sort(), facts.kinds, 'the closed-enum table maps onto exactly the kinds finish-verb accepts');
      });

      it(`${label}: the skills and the runbooks name finish-verb as the terminal write (PC2b DD8)`, holding(persona, CONTRACT), () => {
        const vocabulary = ['verb', 'commit', 'done', 'owner decision'];
        const verbs = ['compose', 'frame', 'decide', 'critique', 'refine', 'investigate', 'start'];
        for (const verb of verbs) {
          const rel = `core/skills/${verb}/SKILL.md`;
          const text = docs.get(rel);
          ok(text, rel);
          // Contract: the agent finishing a verb — its terminal write is
          // `state.mjs finish-verb`, which records the next step; a skill
          // without it leaves the agent to write the terminal state another way.
          ok(/\bfinish-verb\b/.test(text), `${rel}: names finish-verb`);
          // Contract: the same agent — `set-terminal` is named only as the
          // marker-clearing escape, or, where a commit surface makes the Phase 7
          // driver start's terminal write, as the driver's own write; any other
          // mention is a direct set-terminal step that skips the next-step record.
          const driver = verb === 'start' && caps.commit_surface;
          for (const m of text.matchAll(/([^\n]{0,24})set-terminal(.{0,20})/gs)) {
            const escape = m[2].startsWith("'s full flag set");
            const byDriver = driver && (/writes `?$/.test(m[1]) || /gate, and $/.test(m[1]));
            ok(escape || byDriver, `${rel}: names set-terminal outside the clearing escape${driver ? " and the driver's own write" : ''}: "${squash(m[0])}"`);
          }
          // Contract: the agent filling the skill's proposal — it offers the
          // runbook's whole closed vocabulary; a narrower one hides next steps
          // finish-verb records.
          for (const m of text.matchAll(/^[ \t]*- selected_next:[ \t]*<([^>\n]+)>/gm)) {
            deepStrictEqual(m[1].split('|').map((s) => s.trim()), vocabulary, `${rel}: the proposal offers the runbook's closed vocabulary`);
          }
        }
        const owned = { decide: 'decide-conflict', refine: 'recurring-finding' };
        for (const [verb, gate] of Object.entries(owned)) {
          // Contract: the agent ending decide or refine on an owner judgment
          // stops on this gate; without it the verb makes a terminal write
          // over a judgment the owner never made.
          ok(squash(docs.get(`core/skills/${verb}/SKILL.md`)).includes(`ends with the \`${gate}\` owner gate`), `${verb}: ends with its gate`);
        }
        const settling = [...docs].filter(([rel, text]) => rel.startsWith('commands/') && /peer-runner\.mjs" settle \\/.test(text));
        strictEqual(settling.length, 6, `${persona}: the six verb runbooks settle`);
        for (const [rel, text] of settling) {
          // Contract: the agent settling an ensemble passes `VERDICT` to
          // `peer-runner.mjs settle` — settle cannot tell an answer of
          // structural shell from a real one, so without this the agent records
          // a peer verdict for a peer that said nothing.
          ok(squash(text).includes('so set `VERDICT` to `degraded`'), `${rel}: a structurally empty answer settles degraded`);
        }
      });

      it(`${label}: the presentation protocol keeps an autopilot step from asking, under dispatch_target only`, holding(persona, PROTOCOL), () => {
        const protocol = docs.get(PROTOCOL);
        if (caps.dispatch_target) {
          const offer = squash(region(protocol, 'presentation-offer'));
          const rules = squash(region(protocol, 'presentation-rules'));
          // Contract: the agent at a presentation point under an autopilot run
          // presents in batch before the review question — no one answers it,
          // so asking stalls the unattended step.
          const batch = offer.indexOf('do not offer the choice: present in batch');
          ok(batch >= 0 && batch < offer.indexOf('How would you like to review this?'), 'the autopilot rule precedes the offer');
          // Contract: the same agent at a confirmation proceeds instead of
          // asking, and stops the step with its owner gate for a genuine owner
          // judgment.
          ok(rules.includes('proceed with X instead of asking'), 'the confirmation proceeds under a run');
          ok(rules.includes('it stops the step with its owner gate'), 'an owner judgment stops the step');
        } else {
          // Contract: a persona with dispatch_target off is never driven by
          // autopilot — an autopilot rule there sends the agent to a run mode
          // (and an `autopilot-mode.md`) it does not have.
          ok(!/autopilot/i.test(protocol), `${persona} declares dispatch_target off: no autopilot sentence`);
        }
      });

      it(`${label}: the session handoff's recipe and rollback name this persona's own resume and legacy slot`, holding(persona, HANDOFF), () => {
        const recipe = region(docs.get(HANDOFF), 'handoff-recipe');
        const block = recipe.slice(recipe.indexOf('```bash'), recipe.indexOf('```\n', recipe.indexOf('```bash') + 7));
        // Contract: the agent running the projection recipe routes to this
        // persona's resume through a literal PERSONA; another persona's name in
        // the block projects or routes the wrong persona's state.
        ok(block.includes(`PERSONA='${persona}'`) && block.includes('--routing "/${PERSONA}:resume"'), 'the recipe routes to this persona through a literal PERSONA');
        strictEqual(block.split(persona).length - 1, 1, 'the shell block names the persona only in its PERSONA literal');
        // Contract: the operator rolling the persona back removes the slots
        // the note names — with legacy_homes on, a legacy-home repository keeps
        // a pre-rollback handoff unless the note names the legacy slot too.
        const legacy = `.claude/agentic-${persona}/`;
        strictEqual(squash(recipe).includes(`and the pre-migration slot's \`${legacy}last-session-handoff.json*\``), caps.legacy_homes, 'the rollback removes the legacy slot exactly when legacy_homes is on');
        strictEqual(stateFacts(persona).legacyDir, legacy.slice(0, -1), 'the legacy home the note names is the one state.mjs resolves');
      });

      it(`${label}: the output-file rules name the brief file and output root the declaration implies (RD7)`, holding(persona, OUTPUT_RULES), () => {
        const text = docs.get(OUTPUT_RULES);
        const decl = declaration(persona);
        // Read from the declaration directly, not through the derived fields.
        const files = mdFiles((decl.verbs.investigate.artifact ?? []).join('\n'));
        strictEqual(files.length, 1, 'the declared artifact names one brief file');
        const env = decl.verbs.investigate.output_root_env ?? `${persona.toUpperCase().replace(/-/g, '_')}_OUTPUT_ROOT`;
        const generated = ['output-rules-intro', 'output-rules-layout', 'output-rules-files'].map((id) => region(text, id)).join('\n');
        // Contract: the agent saving the brief writes the file the rules name,
        // which must be the one the investigate verb declares as its artifact
        // — any other `*_brief.md` name saves a brief the verb never reports.
        const named = new Set([...generated.matchAll(/\b[a-z]+_brief\.md\b/g)].map((m) => m[0]));
        deepStrictEqual([...named], [files[0]], 'the rules name the declared brief file, and no other');
        // Contract: the agent resolving the output root reads this variable —
        // a wrong name ignores the owner's override.
        ok(generated.includes(`\`${env}\``), `the rules name ${env}`);
      });

      it(`${label}: the output-file rules sanitize the slug, sandbox the root and gate an existing directory (RD7)`, holding(persona, OUTPUT_RULES), () => {
        const generated = ['output-rules-intro', 'output-rules-layout', 'output-rules-files'].map((id) => region(docs.get(OUTPUT_RULES), id)).join('\n');
        // Contract: the agent computing the save path follows these steps —
        // each one dropped lets a topic string escape the output root, collide
        // with another brief, or overwrite one without asking.
        for (const [what, re] of [
          ['traversal rejection on the raw input first', /1\.\s+\*\*Traversal rejection \(raw input\)\*\*: if the raw topic string contains[\s\S]{0,120}two or more consecutive dots/],
          ['step 2, lowercase', /2\.\s+\*\*Lowercase\*\*/],
          ['step 3, the forbidden characters', /3\.\s+\*\*Strip filesystem-forbidden characters\*\*[\s\S]{0,120}`:`,\s*`\*`,\s*`\?`/],
          ['step 4, whitespace to `_`', /4\.\s+\*\*Normalize whitespace\*\*[\s\S]{0,120}collapse to single `_`/],
          ['step 5, CJK kept', /5\.\s+\*\*Allowed character class\*\*[\s\S]{0,200}CJK characters/],
          ['step 6, 15 code points', /6\.\s+\*\*Truncate at 15 Unicode code points\*\*/],
          ['step 7, the trailing `_`', /7\.\s+\*\*Remove trailing `_`\*\*/],
          ['an absolute root, a tilde rejected', /\*\*Absolute path required\*\*: relative paths and tilde-prefixed paths\s+are rejected/],
          ['a fallback to ./output/', /falls back to\s+`\.\/output\/`/],
          ['the root created on use', /\*\*Auto-create on use\*\*[\s\S]{0,200}created with `mkdir -p`/],
          ['the sandbox after symlink resolution', /\*\*Sandbox enforcement\*\*[\s\S]{0,200}resolves\s+outside the root after symlink resolution is rejected before the file\s+is written/],
          ['three outcomes', /1\. \*\*Overwrite\*\*[\s\S]*2\. \*\*Distinct directory\*\*[\s\S]*3\. \*\*Abort\*\*/],
          ['the distinct directory by default', /Default if the user does not respond: option 2 \(distinct directory\)/],
        ]) ok(re.test(generated), `the rules state ${what}`);
      });

      it(`${label}: the lens's default size keeps a profile preset where the persona has one`, holding(persona, CONTRACT), () => {
        const lens = squash(region(docs.get(CONTRACT), 'routing-lens'));
        const fence = /```bash\n([\s\S]*?)```/.exec(region(docs.get(CONTRACT), 'routing-lens'))?.[1] ?? '';
        const call = fence.split('\n').find((l) => l.includes('decide-registry.mjs" resolve')) ?? '';
        if (caps.profile_presets) {
          // Contract: the agent resolving the lens — an explicit `--size`
          // overrides the profile's preset, so a `--size=minor` default drops it.
          ok(!lens.includes('uses `--size=minor`'), 'no default --size=minor that would drop the profile');
          // Contract: the agent runs the illustrated call — run here against the
          // persona's own registry: the variable it sets is the one the
          // resolver reads, and with no --size every profile keeps its preset.
          const variable = /^PROFILE_VAR='([A-Z_]+)'$/m.exec(fence)?.[1];
          ok(variable && call.startsWith('env "${PROFILE_VAR}=<profile>" node ') && !call.includes('--size'), call);
          const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AGENTIC_/.test(k)));
          for (const [profile, preset] of Object.entries(declaration(persona).decide.profile_presets)) {
            const out = execFileSync(process.execPath, [join(pluginRoot(persona), 'scripts', 'decide-registry.mjs'), 'resolve'], { env: { ...env, [variable]: profile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            strictEqual(JSON.parse(out).preset_id, preset, `profile ${profile} resolves ${preset} through ${variable}`);
          }
          // Contract: the same, for the skills' own lens calls — none resolves
          // with a --size that would drop the profile.
          for (const [rel, text] of docs) {
            if (rel.endsWith('/SKILL.md')) ok(!/decide-registry\.mjs resolve --size/.test(squash(text)), `${rel}: no lens call with --size`);
          }
        } else {
          // Contract: the agent resolving the lens with no profile preset passes
          // `--size`, minor by default; the illustrated call takes the size and
          // no profile variable.
          ok(lens.includes('uses `--size=minor`'), 'default minor');
          ok(call.startsWith('node ') && call.includes('resolve --size=<minor|standard|major>') && !fence.includes('PROFILE_VAR'), call);
        }
      });

      it(`${label}: the preflight's owner archive command is one this persona's resume takes`, holding(persona, CONTRACT), () => {
        const policy = squash(region(docs.get(CONTRACT), 'routing-preflight-policy'));
        // Contract: the owner archiving a stale workflow runs the command the
        // preflight names — this persona's resume, whose argument hint must
        // take `archive`.
        ok(policy.includes(`\`/${persona}:resume archive\``), 'the owner archive through resume is named');
        ok(/archive \[<?workflow-id>?\]/.test(readFileSync(join(pluginRoot(persona), 'commands', 'resume.md'), 'utf8')), "this persona's resume takes archive");
      });

      it(`${label}: the ensemble Launch gates the declared privacy scope before any dispatch, and claims no gate without one (RD5, PC3b U5c)`, holding(persona, ENSEMBLE), () => {
        const text = docs.get(ENSEMBLE);
        const launch = squash(stepSection(text, /^### Step 1: Launch$/m) ?? '');
        // The Launch step's dispatch call, the anchor the order checks compare to.
        const dispatch = launch.indexOf('`../../../../scripts/peer-runner.mjs run`');
        ok(dispatch > 0, 'the Launch step names the dispatch');
        // Contract: the sync renders the privacy regions into exactly the
        // personas that declare a peer policy (`peer`) — enrolling another one
        // stops it at a gate for a policy it does not have.
        const peer = declaration(persona).peer;
        const held = MANIFEST.regions.filter((r) => r.dest === ENSEMBLE && r.personas.includes(persona)).map((r) => r.id);
        deepStrictEqual(held.filter((id) => PRIVACY_REGIONS.includes(id)), peer ? PRIVACY_REGIONS : [], 'the privacy regions follow the declared peer policy');
        if (!peer) {
          // Contract: the agent dispatching for a persona with no peer policy —
          // a privacy gate or genericization step stops it to ask about a
          // policy it does not have, and stalls an unattended run.
          ok(held.length >= 17, `${persona}: only ${held.length} ensemble regions`);
          for (const id of held) ok(!/privacy gate|genericiz/i.test(region(text, id)), `${id} claims a privacy gate ${persona} does not declare`);
          ok(!/privacy gate|genericiz/i.test(launch), 'the Launch step claims no privacy gate');
          return;
        }
        // Contract: the agent dispatching for a persona with a peer policy
        // stops at the gate for the declared scope before the dispatch call; a
        // gate after it, or none, sends unredacted material to the peer.
        const gate = launch.indexOf(`${squash(peer.privacy_scope)} ${GATE_SENTENCE}.`);
        ok(gate > 0 && gate < dispatch, 'the Launch step gates the declared privacy scope before the dispatch step');
        if (/screenshot/i.test(peer.privacy_scope)) {
          // Contract: the same, for screenshots — the gate covers them before
          // the dispatch call.
          const at = launch.indexOf('**Screenshots are sensitive by default**');
          ok(at >= 0 && at < dispatch, 'the screenshot sentence precedes the dispatch step');
        }
      });

      it(`${label}: the ensemble Collect reads the runner result before any envelope, in the runner's own terms (RV10)`, holding(persona, ENSEMBLE), () => {
        const collect = squash(region(docs.get(ENSEMBLE), 'ensemble-collect'));
        // Contract: the agent collecting a peer run reads the runner's JSON
        // first and takes the null-envelope branch before reading the envelope
        // — reading `envelope_path` first reads a file the runner may not have
        // written.
        const runnerAt = collect.indexOf('Read the peer-runner JSON first');
        const envelopeAt = collect.indexOf('`envelope_path` for the parsed companion envelope');
        ok(runnerAt >= 0 && envelopeAt >= 0, 'both reads are named');
        ok(runnerAt < envelopeAt, 'the runner result is read before the envelope');
        const nullAt = collect.indexOf('When `envelope_path` is null there is no envelope to read');
        ok(nullAt >= 0 && nullAt < envelopeAt, 'the no-envelope branch comes before the envelope read');
        // Contract: the fields and values the agent branches on are the ones
        // peer-runner.mjs writes — a name the runner never writes is a branch
        // the agent can never take.
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

      it(`${label}: the peer-now skill omits exactly the accounting flags its dispatch omits, and the dispatch passes --run-id`, () => {
        const skill = docs.get('core/skills/peer-now/SKILL.md');
        // Contract: the agent dispatching peer-now leaves out the flags the
        // skill lists — listing --run-id there drops the ledger key the
        // runner's status and cancel address the run by.
        const named = /omits the three ensemble-accounting flags (?:\(([^)]*)\)|— ([^—]*) —)/.exec(squash(skill));
        const omitted = named?.[1] ?? named?.[2];
        ok(omitted, 'the peer-now skill names the flags it omits');
        deepStrictEqual(omitted.match(/--[a-z-]+/g), ['--workflow-path', '--phase', '--ensemble-type'], `the peer-now skill names exactly the three accounting flags as omitted: ${omitted}`);
        // Contract: the dispatch call itself passes --run-id and none of the
        // three accounting flags, which would record peer-now as an ensemble.
        const dispatch = region(skill, 'peer-now-dispatch');
        ok(/--run-id "\$RUN_ID" --kind peer-now/.test(dispatch), 'the peer-now dispatch passes --run-id');
        for (const flag of ['--workflow-path', '--phase', '--ensemble-type']) ok(!dispatch.includes(flag), `the peer-now dispatch omits ${flag}`);
      });

      it(`${label}: the brief ensemble gates before dispatch and collects the runner result first, as the investigate runbook dispatches (RD8, RV10)`, holding(persona, briefRef(persona, 'ensemble')), () => {
        const decl = declaration(persona);
        const brief = docs.get(briefRef(persona, 'ensemble'));
        ok(brief, 'the brief ensemble is named by the declared brief profile');
        const launch = squash(stepSection(brief, /^### Step 1: Launch\b.*$/m) ?? '');
        const dispatch = launch.indexOf("`peer-runner.mjs run` resolves the peer-companion");
        ok(dispatch > 0, 'the Launch step names the dispatch');
        // Contract: the agent stops at a privacy gate before the brief's
        // dispatch call (engineer's is its cited-brief Step 1, in its own
        // words) — a gate after it sends unredacted research to the peer.
        const gateAt = launch.search(/privacy gate/);
        ok(gateAt >= 0 && gateAt < dispatch, 'a privacy gate precedes the dispatch step');
        // Contract: the sync renders the brief privacy regions into exactly the
        // personas that declare a peer policy.
        const held = MANIFEST.regions.filter((r) => r.dest === briefRef(persona, 'ensemble') && r.personas.includes(persona)).map((r) => r.id);
        deepStrictEqual(held.filter((id) => BRIEF_PRIVACY_REGIONS.includes(id)), decl.peer ? BRIEF_PRIVACY_REGIONS : [], 'the brief privacy regions follow the declared peer policy');
        if (decl.peer) {
          // Contract: with a peer policy, the gate covers the declared scope,
          // web search and the peer dispatch alike, before the dispatch call.
          const gate = launch.indexOf(`${squash(decl.peer.privacy_scope)} ${GATE_SENTENCE}`);
          ok(gate > 0 && gate < dispatch, 'the gate states the declared privacy scope before the dispatch step');
        } else {
          // Contract: without one, no shared region claims a gate or a
          // genericization step the persona does not declare.
          ok(held.length >= 16, `${persona}: only ${held.length} brief ensemble regions`);
          for (const id of held) ok(!/privacy gate|genericiz/i.test(region(brief, id)), `${id} claims a privacy gate ${persona} does not declare`);
        }
        if (/screenshot/i.test(decl.peer?.privacy_scope ?? '')) {
          // Contract: screenshots are gated before the dispatch call too.
          const at = launch.indexOf('**Screenshots are sensitive by default**');
          ok(at >= 0 && at < dispatch, 'the screenshot sentence precedes the dispatch step');
        }
        // Contract: the agent reads the runner's JSON first, takes the
        // null-envelope branch next, and reads the envelope last.
        const collect = squash(region(brief, 'brief-ensemble-collect'));
        const runnerAt = collect.indexOf('Read the peer-runner JSON first');
        const envelopeAt = collect.indexOf('`envelope_path` for the parsed companion envelope');
        ok(runnerAt >= 0 && runnerAt < envelopeAt, 'the runner result is read before the envelope');
        const nullAt = collect.indexOf('When `envelope_path` is null there is no envelope to read');
        ok(nullAt > runnerAt && nullAt < envelopeAt, 'the no-envelope branch comes between the runner result and the envelope read');
        // Contract: the investigate runbook's dispatch, which the brief
        // describes, runs through the runner, keeps its JSON result and passes
        // the declared ensemble type.
        const run = docs.get('commands/investigate.md');
        ok(run.includes('scripts/peer-runner.mjs" run') && run.includes('> "$PROMPT_FILE.run.json"'), 'the investigate runbook dispatches through the runner and keeps its JSON result');
        ok(run.includes(`ENSEMBLE_TYPE='${decl.verbs.investigate.ensemble_type}'\n`) && run.includes('--ensemble-type "$ENSEMBLE_TYPE" --run-id'), 'under the declared ensemble type');
      });

      it(`${label}: the brief recovery inspects the run before a retry, in the runner's terms (RV11)`, holding(persona, briefRef(persona, 'ensemble')), () => {
        const state = squash(region(docs.get(briefRef(persona, 'ensemble')), 'brief-ensemble-state'));
        // Contract: the agent recovering a dispatch a compaction orphaned runs
        // `peer-runner.mjs status` before any retry, and a retry takes a fresh
        // run id — the runner refuses the old one.
        const inspect = state.indexOf('`peer-runner.mjs status --run-id <run_id> --json`');
        const retry = state.indexOf('A retry takes a fresh run id');
        ok(inspect >= 0, 'the recovery inspects the run');
        ok(retry > inspect, 'a retry, with a fresh run id, comes only after the inspection');
        // Contract: nothing ahead of the inspection sends the agent to dispatch
        // again, and nothing says a dispatch may reuse the old run id: told the
        // runner is idempotent on `run_id`, the agent re-dispatches before
        // inspecting, under an id the runner refuses.
        // An instruction, not the word: "must re-dispatch" or a sentence that
        // opens with it; "do not re-dispatch" passes.
        ok(!/\b(?:must|should|needs? to|will|then)\s+re-?dispatch|(?:^|[.:;!]\s+)re-?dispatch/i.test(state.slice(0, inspect)), 'no re-dispatch ahead of the inspection');
        ok(!/idempotent on `run_id`|reuses? the (previous|same|old) run id/i.test(state), 'no dispatch reuses the old run id');
        // Contract: the inspection branches on the status fields the runner
        // reports, and settles a finished run with no new dispatch.
        for (const branch of ['`live: true`', '`derived_status: completed_uncommitted`', 'read `paths.envelope`', '(`peer-runner.mjs settle --run-id <run_id>`), with no new dispatch']) {
          ok(state.indexOf(branch) > inspect && state.indexOf(branch) < retry, `the inspection branches: ${branch}`);
        }
        // Contract: the old attempt is cancelled while still live, then settled
        // through the runner from its ledger, never committed by hand with
        // `state.mjs ensemble-commit` and a verdict the agent picks. settle
        // refuses a live run, so without the cancel the agent is left holding
        // an orphaned pending entry it cannot settle.
        ok(state.includes('cancel the old run if it is still live, then settle it with `peer-runner.mjs settle --run-id <old run_id>`'), 'a live old run is cancelled, then its pending entry is settled from its ledger');
        ok(!/state\.mjs ensemble-commit/.test(state), 'the recovery commits nothing by hand');
        // Contract: the fields the inspection branches on, and the refusal the
        // fresh run id avoids, are the runner's own.
        const runner = readFileSync(join(pluginRoot(persona), 'scripts', 'peer-runner.mjs'), 'utf8');
        ok(runner.includes("return 'completed_uncommitted';") && /derived_status: derived,\s+live,/.test(runner), 'the runner status reports derived_status and live');
        ok(runner.includes('envelope: await exists(paths.envelope) ? paths.envelope : null,'), 'the runner status reports paths.envelope');
        ok(runner.includes('peer-run ledger already exists for run_id'), 'the runner refuses an existing run id');
      });

      it(`${label}: the brief ensemble's failure handling settles each attempt, passes degraded for an empty answer and never blocks the save`, holding(persona, briefRef(persona, 'ensemble')), () => {
        const failure = squash(region(docs.get(briefRef(persona, 'ensemble')), 'brief-ensemble-failure'));
        // Contract: on a peer failure the agent settles the attempt through the
        // runner, passes `degraded` for an answer of structural shell (settle
        // cannot tell it from a real one), and saves the brief local-only
        // rather than stopping.
        for (const instruction of ['(`peer-runner.mjs settle`)', 'pass `degraded` as the synthesis verdict', 'Ensemble failure NEVER blocks save.']) {
          ok(failure.includes(instruction), `the brief failure handling: ${instruction}`);
        }
      });

      it(`${label}: the orchestration failure handling stops to ask on a failed local analysis and never blocks on a peer failure`, holding(persona, ORCHESTRATION), () => {
        const local = squash(region(docs.get(ORCHESTRATION), 'orchestration-failure'));
        // Contract: the agent whose local analysis failed stops to ask the user
        // (retry or proceed) instead of synthesizing without it, and a peer
        // failure never stops the workflow.
        ok(local.includes('ask retry-or-proceed'), 'a failed local analysis stops to ask');
        ok(local.includes('never blocks the workflow'), 'a peer failure never blocks');
      });

      it(`${label}: the protocol's collect step and each failure action settle the attempt from its run ledger (RV5)`, holding(persona, ENSEMBLE), () => {
        const doc = docs.get(ENSEMBLE);
        const collect = squash(region(doc, 'ensemble-collect'));
        // Contract: the agent finishing an ensemble runs `peer-runner.mjs
        // settle` whatever the run did, and passes `degraded` for an answer of
        // structural shell, which settle cannot tell from a real one.
        ok(collect.includes('the finalize settles the attempt from its run ledger (`peer-runner.mjs settle`)'), collect);
        ok(collect.includes('the synthesis verdict is `degraded`'), collect);
        // Contract: on each peer failure the agent proceeds without the peer
        // (it does not stop the verb) and settles the attempt instead of
        // skipping it by hand.
        for (const [id, instructions] of [
          ['ensemble-failure-unavailable', ['Proceed with orchestrator-only analysis', '(`peer-runner.mjs settle`)']],
          ['ensemble-failure-error', ['Proceed orchestrator-only', 'settling the attempt']],
          ['ensemble-failure-empty', ['pass `degraded` as the synthesis verdict']],
        ]) {
          const text = squash(region(doc, id));
          for (const instruction of instructions) ok(text.includes(instruction), `${id}: ${instruction}`);
        }
      });

      it(`${label}: the protocol's autopilot wait and commit-command exclusion follow the declaration, and no runner hides behind a shell \`&\` (RV12, PC3b U5c)`, holding(persona, ENSEMBLE), () => {
        const doc = docs.get(ENSEMBLE);
        // Contract: the agent backgrounding the peer runner keeps it in the
        // foreground of the host's background task — behind a shell `&` the
        // host can neither track it nor notify the agent when it exits.
        ok(squash(region(doc, 'ensemble-launch')).includes('never behind a shell `&`'), 'the Launch keeps the runner out of a shell &');
        const collect = squash(region(doc, 'ensemble-collect'));
        // Contract: the agent waiting on a peer under autopilot waits for the
        // host's notification (never sleep-polls) and, re-invoked, settles and
        // makes the verb's last write before it reports — rendered with
        // dispatch_target on only, since autopilot drives no other persona.
        for (const instruction of ['never sleep-poll a file', 'on the notification, finish Synthesize, settle the attempt']) {
          strictEqual(collect.includes(instruction), Boolean(caps.dispatch_target), `dispatch_target ${caps.dispatch_target}: ${instruction}`);
        }
        strictEqual(/autopilot/i.test(collect), Boolean(caps.dispatch_target), 'the Collect step names autopilot exactly with dispatch_target on');
        // Contract: the agent running the commit command dispatches no peer —
        // the exclusion is listed exactly when the persona has that command.
        const when = squash(region(doc, 'ensemble-when-applies'));
        strictEqual(when.includes(`- The commit command (\`/${persona}:commit\`)`), Boolean(caps.commit_surface), `commit_surface ${caps.commit_surface}: the commit command's exclusion`);
        strictEqual(docs.has('commands/commit.md'), Boolean(caps.commit_surface), 'the commit command ships exactly with commit_surface on');
        if (caps.commit_surface) {
          // Contract: neither the commit runbook, its skill nor its Phase 7
          // driver calls the peer runner or dispatcher.
          const surfaces = [docs.get('commands/commit.md'), docs.get('core/skills/commit/SKILL.md'), readFileSync(join(pluginRoot(persona), 'scripts', 'phase7-commit.mjs'), 'utf8')];
          for (const text of surfaces) ok(text && !/peer-runner\.mjs|dispatch-peer\.mjs|--kind ensemble/.test(text), 'the commit surface dispatches no peer');
        }
      });

      it(`${label}: no runbook guards ensemble-commit on shell variables, and the protocol says settle decides from the run ledger instead (D2, PC2b U5b)`, holding(persona, ENSEMBLE), () => {
        // Contract: the agent running a verb's finalize — no runbook guards
        // the settle on shell variables, which do not survive from one runbook
        // block to the next, so such a guard skips it.
        const guarded = [...docs]
          .filter(([rel, text]) => rel.startsWith('commands/') && /^\s*if \[ -n "\$\{RUN_ID:-\}" \]/m.test(text))
          .map(([rel]) => rel)
          .sort();
        deepStrictEqual(guarded, []);
        // Contract: every verb runbook's finalize runs `peer-runner.mjs settle`.
        const settles = [...docs].filter(([rel, text]) => rel.startsWith('commands/') && /peer-runner\.mjs" settle \\/.test(text)).map(([rel]) => rel).sort();
        deepStrictEqual(settles, ['commands/compose.md', 'commands/critique.md', 'commands/decide.md', 'commands/frame.md', 'commands/investigate.md', 'commands/refine.md'], 'every verb finalize settles');
        // Contract: the agent reading State Bookkeeping (sliced by its heading)
        // runs settle with the dispatch's run id, empty when no run launched,
        // before the verb's last write, and passes `degraded` for an answer of
        // structural shell.
        const section = squash(stepSection(docs.get(ENSEMBLE), /^### State Bookkeeping$/m) ?? '');
        ok(section.includes("A verb's finalize runs `../../../../scripts/peer-runner.mjs settle` with the run id its dispatch generated (empty when no run launched) before its last write"), section);
        ok(section.includes('its verdict is then `degraded`'), 'an answer of structural shell is settled degraded');
      });
    }
  });
}

// The handoff templates rendered over every legal capability combination
// (dispatch_target needs commit_surface; the sync refuses the reverse), so a
// claim placed under the wrong capability shows even where no persona's
// declaration renders it today: engineer has the three on, founder and
// designer have them off. Each claim names a command, script, state, path or
// capability denial; the presence side keeps the absence side from passing on
// a claim that drifted away.
describe('reference contracts: the handoff templates keep each claim under its capability, in every legal combination (PC3b U5a)', () => {
  const regions = ['handoff-wiring', 'handoff-recipe'].map((id) => MANIFEST.regions.find((r) => r.id === id));
  const base = declaration('engineer');
  for (const dispatch of [false, true]) {
    for (const commit of [false, true]) {
      for (const legacy of [false, true]) {
        if (dispatch && !commit) continue;
        it(`dispatch_target ${dispatch}, commit_surface ${commit}, legacy_homes ${legacy}`, () => {
          const decl = { ...base, capabilities: { ...base.capabilities, dispatch_target: dispatch, commit_surface: commit, legacy_homes: legacy } };
          const out = regions.map((r) => renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', r.template), 'utf8'), {
            declaration: renderingDeclaration(decl), substitutions: r.substitutions ?? {}, label: r.template,
          })).join('\n');
          const flat = squash(out);
          ok(!out.includes('{{'), 'nothing left unrendered');
          // Contract: the agent reading the handoff — the autopilot run and
          // `/orchestrator:done` exist only for a dispatch target, the Phase 7
          // driver, the commit command and its `close-complete` phase only for
          // a commit surface; rendered elsewhere they route it to what the
          // persona lacks.
          for (const re of [/autopilot run/i, /\/orchestrator:done/]) strictEqual(re.test(out), dispatch, `${re}: dispatch_target on only`);
          for (const re of [/Phase 7/, /:commit`/, /close-complete/]) strictEqual(re.test(out), commit, `${re}: commit_surface on only`);
          // Contract: the same agent — `publish-needed` and "does not
          // auto-commit" hand the commit to the owner, false where a commit
          // command exists.
          for (const re of [/→ \*\*`publish-needed`\*\*/, /does not auto-commit/]) strictEqual(re.test(flat), !commit, `${re}: commit_surface off only`);
          // Contract: the legacy home path, and the denials of each capability,
          // render exactly where the capability is on (or off).
          strictEqual(/\.claude\/agentic-engineer/.test(flat), legacy, 'the legacy home: legacy_homes on only');
          strictEqual(flat.includes('declares `legacy_homes` off'), !legacy, 'the legacy_homes off claim');
          strictEqual(flat.includes('declares `dispatch_target` off'), !dispatch, 'the dispatch_target off claim');
        });
      }
    }
  }
});

// The routing templates rendered under every legal capability combination,
// as the handoff templates are above.
describe('reference contracts: the routing templates keep each claim under its capability, in every legal combination (PC3b U5b)', () => {
  const regions = MANIFEST.regions.filter((r) => r.dest === CONTRACT && r.personas.includes('engineer'));
  const base = declaration('engineer');
  // The rendering below must keep reaching every routing region.
  it('renders the twelve routing regions', () => strictEqual(regions.length, 12));
  for (const dispatch of [false, true]) {
    for (const commit of [false, true]) {
      for (const legacy of [false, true]) {
        if (dispatch && !commit) continue;
        it(`dispatch_target ${dispatch}, commit_surface ${commit}, legacy_homes ${legacy}`, () => {
          const decl = { ...base, capabilities: { ...base.capabilities, dispatch_target: dispatch, commit_surface: commit, legacy_homes: legacy } };
          const out = regions.map((r) => renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', r.template), 'utf8'), {
            declaration: renderingDeclaration(decl), substitutions: r.substitutions ?? {}, label: r.template,
          })).join('\n');
          const flat = squash(out);
          ok(!out.includes('{{'), 'nothing left unrendered');
          // Contract: the agent routing and gating — the `pr-handling` gate and
          // the orchestrator's dispatch into the persona exist only with a
          // dispatch target; elsewhere the agent sets a gate state.mjs refuses
          // or routes into a dispatch that never comes.
          for (const claim of ['| `pr-handling` |']) strictEqual(flat.includes(claim), dispatch, `${claim}: dispatch_target on only`);
          for (const claim of ['declares `dispatch_target` off', 'dispatches its subtasks into engineer only']) strictEqual(flat.includes(claim), !dispatch, `${claim}: dispatch_target off only`);
          // Contract: the same agent — the `staging-set` gate, the Phase 7
          // driver and the start route to a commit exist only with a commit
          // surface, and the commit command's denial only without one.
          for (const claim of ['| `staging-set` |', "no-changes close (`phase7-commit.mjs`)", 'to commit on the current branch', 'lifecycle commits at its Phase 7 instead']) strictEqual(flat.includes(claim), commit, `${claim}: commit_surface on only`);
          for (const claim of ['There is no `/', 'declares `commit_surface` off', 'to its saved artifact', '`publish-needed`']) strictEqual(flat.includes(claim), !commit, `${claim}: commit_surface off only`);
          // Contract: the legacy home path renders with legacy_homes on only.
          strictEqual(flat.includes('.claude/agentic-engineer/'), legacy, 'the legacy home: legacy_homes on only');
        });
      }
    }
  }
});

// The presentation and orchestration templates under every legal combination,
// region by region: with the autopilot paragraphs taken out, each renders
// exactly what it renders with every capability off (so no shared text hides
// under a capability), and those paragraphs render with dispatch_target on
// only, one in the offer and one in the rules. AUTOPILOT slices a paragraph
// out by its lead-in.
describe('reference contracts: the presentation and orchestration templates name autopilot under dispatch_target only, in every legal combination (PC3b U5b)', () => {
  const regions = MANIFEST.regions.filter((r) => (r.dest === PROTOCOL || r.dest === ORCHESTRATION) && r.personas.includes('engineer'));
  const base = declaration('engineer');
  const render = (caps) => Object.fromEntries(regions.map((r) => [r.id, renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', r.template), 'utf8'), {
    declaration: renderingDeclaration({ ...base, capabilities: { ...base.capabilities, ...caps } }), substitutions: r.substitutions ?? {}, label: r.template,
  })]));
  const AUTOPILOT = /^\*\*Autopilot mode \(ADR-0063, Claude only\):\*\*[^]*?\n\n/gm;
  const neutral = render({ dispatch_target: false, commit_surface: false, legacy_homes: false });
  it('renders the five presentation and two orchestration regions, none empty', () => {
    strictEqual(regions.length, 7);
    for (const [id, text] of Object.entries(neutral)) ok(text.trim().length > 0, `${id}: renders empty with every capability off`);
  });
  for (const dispatch of [false, true]) {
    for (const commit of [false, true]) {
      for (const legacy of [false, true]) {
        if (dispatch && !commit) continue;
        it(`dispatch_target ${dispatch}, commit_surface ${commit}, legacy_homes ${legacy}`, () => {
          const out = render({ dispatch_target: dispatch, commit_surface: commit, legacy_homes: legacy });
          for (const [id, text] of Object.entries(out)) {
            ok(!text.includes('{{'), `${id}: nothing left unrendered`);
            // Contract: the agent presenting — an autopilot rule (present in
            // batch, proceed without asking) reaches only a persona autopilot
            // drives; anywhere else it skips a question a person would answer.
            const autopilot = text.match(AUTOPILOT) ?? [];
            strictEqual(autopilot.length, dispatch && ['presentation-offer', 'presentation-rules'].includes(id) ? 1 : 0, `${id}: autopilot paragraphs`);
            strictEqual(text.replace(AUTOPILOT, ''), neutral[id], `${id}: the same text as with every capability off, the autopilot paragraph aside`);
            ok(/autopilot/i.test(text.replace(AUTOPILOT, '')) === false, `${id}: autopilot named outside its paragraph`);
          }
        });
      }
    }
  }
});

// The ensemble templates engineer holds, under every legal combination,
// region by region, as the presentation templates are above: with the Collect
// step's autopilot paragraph and the commit command's exclusion taken out
// (AUTOPILOT and COMMIT slice them out by their lead-ins), each renders what
// it renders with every capability off; the paragraph renders with
// dispatch_target on only, the exclusion with commit_surface on only, and no
// region claims a privacy gate for a persona that declares no peer policy.
describe('reference contracts: the ensemble templates keep each claim under its capability, in every legal combination (PC3b U5c)', () => {
  const regions = MANIFEST.regions.filter((r) => r.dest === ENSEMBLE && r.personas.includes('engineer'));
  const base = declaration('engineer');
  const render = (caps) => Object.fromEntries(regions.map((r) => [r.id, renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', r.template), 'utf8'), {
    declaration: renderingDeclaration({ ...base, capabilities: { ...base.capabilities, ...caps } }), substitutions: r.substitutions ?? {}, label: r.template,
  })]));
  const AUTOPILOT = /\n\n {3}\*\*Autopilot \(ADR-0063, Claude only\):\*\*[^]*?\n\n(?=2\. )/g;
  const COMMIT = /^- The commit command \(`\/engineer:commit`\)[^]*?\n(?=- )/gm;
  const neutral = render({ dispatch_target: false, commit_surface: false, legacy_homes: false });
  it('renders the seventeen ensemble regions engineer holds, none empty', () => {
    strictEqual(regions.length, 17);
    deepStrictEqual(regions.filter((r) => PRIVACY_REGIONS.includes(r.id)), []);
    for (const [id, text] of Object.entries(neutral)) ok(text.trim().length > 0, `${id}: renders empty with every capability off`);
  });
  for (const dispatch of [false, true]) {
    for (const commit of [false, true]) {
      for (const legacy of [false, true]) {
        if (dispatch && !commit) continue;
        it(`dispatch_target ${dispatch}, commit_surface ${commit}, legacy_homes ${legacy}`, () => {
          const out = render({ dispatch_target: dispatch, commit_surface: commit, legacy_homes: legacy });
          for (const [id, text] of Object.entries(out)) {
            ok(!text.includes('{{'), `${id}: nothing left unrendered`);
            // Contract: the agent dispatching a peer — the autopilot wait
            // reaches only a persona autopilot drives, the commit command's
            // exclusion only one with that command, and no region stops it at
            // a privacy gate it declares no policy for.
            strictEqual((text.match(AUTOPILOT) ?? []).length, dispatch && id === 'ensemble-collect' ? 1 : 0, `${id}: autopilot paragraphs`);
            strictEqual((text.match(COMMIT) ?? []).length, commit && id === 'ensemble-when-applies' ? 1 : 0, `${id}: commit-command exclusions`);
            const rest = text.replace(AUTOPILOT, '\n').replace(COMMIT, '');
            strictEqual(rest, neutral[id], `${id}: the same text as with every capability off, those two aside`);
            ok(!/autopilot|:commit`/i.test(rest), `${id}: autopilot or the commit command named outside its block`);
            ok(!/privacy gate|genericiz/i.test(text), `${id}: a privacy gate engineer does not declare`);
          }
        });
      }
    }
  }
});

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

  it('reads the § after a Markdown-link citation, quoted with no space (PC3b U5c)', () => {
    const docs = new Map([
      [`${REFS}/a.md`, 'See [`b.md`](./b.md)\n§"Missing heading") and [`b.md`](./b.md) §"State Bookkeeping").\n'],
      [`${REFS}/b.md`, '# B\n\n### State Bookkeeping\n'],
    ]);
    const { failures, sections } = checkCitations('founder', docs);
    strictEqual(sections, 2);
    strictEqual(failures.length, 1, failures.join('\n'));
    ok(failures[0].includes('§ Missing heading'), failures[0]);
  });

  it('exempts only the declared brief file by its whole name, never a name it contains', () => {
    const docs = new Map([[`${REFS}/a.md`, 'Saved as `business_brief.md`; see `brief.md`.\n']]);
    const { failures } = checkCitations('founder', docs);
    deepStrictEqual(failures.map((f) => f.split(': cites ')[1].split(',')[0]), ['brief.md']);
  });
});
