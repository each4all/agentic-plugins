#!/usr/bin/env node
// The measurements behind the association-policy decision
// (docs/assurance/evidence/measurement/association-policy.md).
//
// This exists because the decision it backs was reached three times before and
// wrong three times, and the third attempt shipped because its author measured
// the symptom being fixed rather than the property required. Every number in the
// decision record is produced here, against the frozen corpus pin, so a reader
// can re-derive it instead of trusting it — and so that a later change to the
// reader, the corpus, or the candidate rules shows up as a diff rather than as
// prose that quietly stopped being true.
//
// It is a MEASUREMENT tool, not a gate. It asserts nothing about whether the
// numbers are good; `tests/scripts/test-measure-association-policy.mjs` pins the
// ones the decision rests on.
//
// IMPORTANT — this is rationale-class, not contract-class. It reads the corpus
// and reports what is in it. The measurement contract forbids corpus
// fingerprints in normative text for a reason: the two lanes that later measure
// this corpus must not share readings of it. Neither this file nor the decision
// record it feeds is an input to those lanes.
//
// Usage:
//   node scripts/measure-association-policy.mjs [--commit <rev>] [--format text|json]

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVIDENCE_DOCS } from './check-doc-evidence.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The pin the decision was measured against. */
export const DECISION_COMMIT = 'd49f74e696bf8eb1fd1c934bd588dde305bed23d';

// Anchors and roles, recognised across ALL run kinds rather than `doctor` alone.
// Restricting to doctor was one of the inconsistencies the decision names: the
// family registry admits eight kinds while every candidate rule reasoned about
// one.
const RUN_ID = String.raw`[a-z]+-(\d{4})(\d{2})(\d{2})T\d{6}Z-[0-9a-f]+`;
const RUN_ID_BARE = /[a-z]+-\d{8}T\d{6}Z-[0-9a-f]+/g;
const ISO_DATE = String.raw`(\d{4}-\d{2}-\d{2})Z?`;
const ISO_DATE_BARE = /\d{4}-\d{2}-\d{2}Z?/g;
const PACKAGE_TAG = /plugin-[a-z-]+-v\d+\.\d+\.\d+/g;
const RUNTIME_TAG = /plugin-runtime-v\d+\.\d+\.\d+/g;

/**
 * Clause segmentation, stated because it is not neutral.
 *
 * The first version of this measurement expressed the gap as `[^.;]{0,N}` — a
 * character bound that also forbade a period INSIDE the gap. In these documents
 * that silently excluded every candidate pair spanning a version number such as
 * `0.97.0`, which is where the wrong pairings live, and produced a clean
 * separating threshold that does not exist. Splitting first and measuring the
 * gap second is what a second lane reproduced; the two methods disagree at
 * width 40 (0 false versus 1), so the segmentation is part of the measurand and
 * not an implementation detail.
 */
const CLAUSE_SPLIT = /[.!?]\s+|;/;

function docs(repoRoot, commit) {
  return EVIDENCE_DOCS.map((path) => ({
    path,
    text: execFileSync('git', ['-C', repoRoot, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    }).replace(/\s+/g, ' '),
  }));
}

/** The date a run id encodes, which is what makes a date binding falsifiable. */
const encodedDate = (m) => `${m[1]}-${m[2]}-${m[3]}`;

/**
 * M1 — how many run-id occurrences exist, by kind, and how many DISTINCT values.
 *
 * The repetition factor is the measurement that decides the whole question: if
 * each value occurs several times, then two lanes agreeing on a VALUE have not
 * agreed on an OCCURRENCE, and no value-level oracle can certify a pairing.
 */
export function anchorPopulation(corpus) {
  const kinds = {};
  const ids = new Set();
  let idOccurrences = 0;
  const runtimeTags = new Set();
  let runtimeTagOccurrences = 0;
  const packageTags = new Set();
  let packageTagOccurrences = 0;

  for (const { text } of corpus) {
    for (const m of text.matchAll(/([a-z]+)-\d{8}T\d{6}Z-[0-9a-f]+/g)) {
      kinds[m[1]] = (kinds[m[1]] ?? 0) + 1;
      idOccurrences += 1;
      ids.add(m[0]);
    }
    for (const m of text.matchAll(RUNTIME_TAG)) { runtimeTagOccurrences += 1; runtimeTags.add(m[0]); }
    for (const m of text.matchAll(PACKAGE_TAG)) { packageTagOccurrences += 1; packageTags.add(m[0]); }
  }
  return {
    kinds,
    runIdOccurrences: idOccurrences,
    runIdDistinct: ids.size,
    doctorOccurrences: kinds.doctor ?? 0,
    runtimeTagOccurrences,
    runtimeTagDistinct: runtimeTags.size,
    packageTagOccurrences,
    packageTagDistinct: packageTags.size,
  };
}

/**
 * M2 — the empirical connector inventory for the date relation.
 *
 * Grouped by the literal text between the two occurrences, so the shape of the
 * distribution is visible rather than assumed: a short head plus a long tail is
 * a different design problem from a handful of regular forms.
 */
export function connectorInventory(corpus, width = 40) {
  const forms = new Map();
  let pairs = 0;
  let punctuationOnly = 0;
  const dateFirst = new RegExp(`${ISO_DATE}([^.;]{0,${width}}?)\`?${RUN_ID}\`?`, 'g');
  const idFirst = new RegExp(`\`?${RUN_ID}\`?([^.;]{0,${width}}?)${ISO_DATE}`, 'g');
  for (const { text } of corpus) {
    for (const m of text.matchAll(dateFirst)) {
      const connector = m[2].trim();
      forms.set(`DATE [${connector}] ID`, (forms.get(`DATE [${connector}] ID`) ?? 0) + 1);
      pairs += 1;
      if (!/[A-Za-z]/.test(connector)) punctuationOnly += 1;
    }
    for (const m of text.matchAll(idFirst)) {
      const connector = m[4].trim();
      forms.set(`ID [${connector}] DATE`, (forms.get(`ID [${connector}] DATE`) ?? 0) + 1);
      pairs += 1;
      if (!/[A-Za-z]/.test(connector)) punctuationOnly += 1;
    }
  }
  const ranked = [...forms.entries()].sort((a, b) => b[1] - a[1]);
  return {
    distinctForms: ranked.length,
    pairs,
    punctuationOnly,
    // The share matters on its own: a connector with no letter in it cannot be
    // named by a LEXICAL construction, so a purely lexical closed set has a
    // ceiling on this corpus no matter how many forms it enumerates.
    punctuationShare: pairs === 0 ? 0 : punctuationOnly / pairs,
    head: ranked.slice(0, 6),
  };
}

/**
 * M3 — candidate association rules, scored for COVERAGE and for the only kind
 * of correctness a value oracle can see.
 *
 * `disagreeing` counts bindings whose stated date differs from the one the id
 * encodes. A zero here is weak evidence, not strong: it cannot see a binding
 * that attached the right value to the wrong occurrence, which the repetition
 * factor in `anchorPopulation` makes common.
 */
export function candidateRules(corpus) {
  const DOCTOR = String.raw`doctor-(\d{4})(\d{2})(\d{2})T\d{6}Z-[0-9a-f]+`;
  const incumbent = (id) => [
    [new RegExp(String.raw`(?:re-?)?recorded on ${ISO_DATE} as \`?${id}\`?`, 'g'), true],
    [new RegExp(String.raw`per the ${ISO_DATE} \`?${id}\`?`, 'g'), true],
    [new RegExp(String.raw`install on ${ISO_DATE} \(\`?${id}\`?`, 'g'), true],
    [new RegExp(String.raw`\`?${id}\`? \(${ISO_DATE}`, 'g'), false],
    [new RegExp(String.raw`(?:re-?)?recorded on ${ISO_DATE} \(\`?${id}\`?`, 'g'), true],
    [new RegExp(String.raw`install \(${ISO_DATE}, \`?${id}\`?`, 'g'), true],
    [new RegExp(String.raw`\`?${id}\`? \(recorded ${ISO_DATE}`, 'g'), false],
  ];

  const score = (patterns) => {
    let bound = 0;
    let disagreeing = 0;
    for (const { text } of corpus) {
      for (const [re, dateLeadsPattern] of patterns) {
        for (const m of text.matchAll(re)) {
          bound += 1;
          const stated = dateLeadsPattern ? m[1] : m[4];
          const encoded = dateLeadsPattern
            ? `${m[2]}-${m[3]}-${m[4]}`
            : `${m[1]}-${m[2]}-${m[3]}`;
          if (stated !== encoded) disagreeing += 1;
        }
      }
    }
    return { bound, disagreeing };
  };

  return {
    'incumbent-7-doctor-only': score(incumbent(DOCTOR)),
    'incumbent-7-all-kinds-plus-id-on-date': score([
      ...incumbent(RUN_ID),
      [new RegExp(String.raw`\`?${RUN_ID}\`? on ${ISO_DATE}`, 'g'), false],
    ]),
  };
}

/**
 * M4 — the proximity sweep, under the segmentation stated at CLAUSE_SPLIT.
 *
 * Reported as a curve rather than a threshold. The point of the curve is that
 * `bound` keeps RISING after `disagreeing` becomes non-zero: genuine bindings
 * and false ones are interleaved along the distance axis, so no width both
 * admits every claim and excludes every mention.
 */
export function proximitySweep(corpus, widths = [10, 20, 40, 80, 160, 320]) {
  const rows = [];
  for (const width of widths) {
    let bound = 0;
    let disagreeing = 0;
    let firstFalseGap = null;
    for (const { text } of corpus) {
      for (const clause of text.split(CLAUSE_SPLIT)) {
        const ids = [...clause.matchAll(new RegExp(RUN_ID, 'g'))]
          .map((m) => ({ start: m.index, end: m.index + m[0].length, encoded: encodedDate(m) }));
        if (ids.length === 0) continue;
        const dates = [...clause.matchAll(ISO_DATE_BARE)]
          .map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0].slice(0, 10) }));
        if (dates.length === 0) continue;
        for (const id of ids) {
          let nearest = null;
          let nearestGap = Infinity;
          for (const date of dates) {
            // Edge gap, not start-to-start: the distance a reader perceives is
            // between the tokens, and start-to-start makes a long token look far.
            const gap = date.start >= id.end
              ? date.start - id.end
              : (id.start >= date.end ? id.start - date.end : 0);
            if (gap < nearestGap) { nearestGap = gap; nearest = date; }
          }
          if (nearest && nearestGap <= width) {
            bound += 1;
            if (nearest.value !== id.encoded) {
              disagreeing += 1;
              if (firstFalseGap === null) firstFalseGap = nearestGap;
            }
          }
        }
      }
    }
    rows.push({ width, bound, disagreeing, firstFalseGap });
  }
  return rows;
}

/**
 * M5 — how often a clause holds more than one candidate for a role.
 *
 * Where it does, any positional rule must RANK, and ranking is the dimension
 * that produced a false result in this repository before. Reported as a
 * distribution because the shape decides whether ranking is an edge case or a
 * routine requirement.
 */
export function clauseAmbiguity(corpus) {
  let clausesWithAnchor = 0;
  let oneToOne = 0;
  let manyIdsOneDate = 0;
  let oneIdManyDates = 0;
  let manyBoth = 0;
  for (const { text } of corpus) {
    for (const clause of text.split(CLAUSE_SPLIT)) {
      const ids = [...clause.matchAll(RUN_ID_BARE)];
      if (ids.length === 0) continue;
      clausesWithAnchor += 1;
      const dates = [...clause.matchAll(ISO_DATE_BARE)];
      if (ids.length === 1 && dates.length === 1) oneToOne += 1;
      else if (ids.length > 1 && dates.length === 1) manyIdsOneDate += 1;
      else if (ids.length === 1 && dates.length > 1) oneIdManyDates += 1;
      else if (ids.length > 1 && dates.length > 1) manyBoth += 1;
    }
  }
  const ambiguous = manyIdsOneDate + oneIdManyDates + manyBoth;
  return { clausesWithAnchor, oneToOne, manyIdsOneDate, oneIdManyDates, manyBoth, ambiguous };
}

export function measure(repoRoot = REPO_ROOT, commit = DECISION_COMMIT) {
  const corpus = docs(repoRoot, commit);
  return {
    commit,
    files: corpus.map((d) => d.path),
    anchors: anchorPopulation(corpus),
    connectors: connectorInventory(corpus),
    candidates: candidateRules(corpus),
    sweep: proximitySweep(corpus),
    ambiguity: clauseAmbiguity(corpus),
  };
}

function render(r) {
  const lines = [];
  lines.push(`association-policy measurements at ${r.commit}`);
  lines.push(`  corpus: ${r.files.length} enumerated stage documents`);
  lines.push('');
  lines.push('anchor population — the repetition factor is why a value oracle cannot certify a pairing');
  lines.push(`  run ids:      ${r.anchors.runIdOccurrences} occurrences / ${r.anchors.runIdDistinct} distinct (${(r.anchors.runIdOccurrences / r.anchors.runIdDistinct).toFixed(1)}x)`);
  lines.push(`  runtime tags: ${r.anchors.runtimeTagOccurrences} occurrences / ${r.anchors.runtimeTagDistinct} distinct (${(r.anchors.runtimeTagOccurrences / r.anchors.runtimeTagDistinct).toFixed(1)}x)`);
  lines.push(`  kinds:        ${Object.entries(r.anchors.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push('');
  lines.push('date-relation connectors');
  lines.push(`  ${r.connectors.distinctForms} distinct forms over ${r.connectors.pairs} pairs`);
  lines.push(`  joined by punctuation alone: ${r.connectors.punctuationOnly} (${(100 * r.connectors.punctuationShare).toFixed(0)}%) — no lexical marker to name`);
  for (const [form, n] of r.connectors.head) lines.push(`    ${String(n).padStart(4)}  ${form}`);
  lines.push('');
  lines.push('candidate rules — coverage, and the only correctness a value oracle sees');
  for (const [id, s] of Object.entries(r.candidates)) {
    lines.push(`  ${id.padEnd(40)} bound ${String(s.bound).padStart(4)}  disagreeing ${s.disagreeing}`);
  }
  lines.push('');
  lines.push('proximity sweep — bound keeps rising after the first false pairing');
  lines.push('  width | bound | disagreeing | first false gap');
  for (const row of r.sweep) {
    lines.push(`  ${String(row.width).padStart(5)} | ${String(row.bound).padStart(5)} | ${String(row.disagreeing).padStart(11)} | ${row.firstFalseGap ?? '-'}`);
  }
  lines.push('');
  lines.push('clause ambiguity — where any positional rule must rank');
  lines.push(`  clauses holding an anchor: ${r.ambiguity.clausesWithAnchor}`);
  lines.push(`    1 id + 1 date:   ${r.ambiguity.oneToOne}`);
  lines.push(`    >1 id + 1 date:  ${r.ambiguity.manyIdsOneDate}`);
  lines.push(`    1 id + >1 date:  ${r.ambiguity.oneIdManyDates}`);
  lines.push(`    >1 id + >1 date: ${r.ambiguity.manyBoth}`);
  lines.push(`  ambiguous: ${r.ambiguity.ambiguous} of ${r.ambiguity.clausesWithAnchor} (${(100 * r.ambiguity.ambiguous / r.ambiguity.clausesWithAnchor).toFixed(0)}%)`);
  return lines.join('\n');
}

export function main(argv, repoRoot = REPO_ROOT) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    if (i === -1) return fallback;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  let commit;
  let format;
  try {
    commit = flag('--commit', DECISION_COMMIT);
    format = flag('--format', 'text');
  } catch (err) {
    console.error(`measureAssociationPolicy: ${err.message}`);
    return 1;
  }
  let result;
  try {
    result = measure(repoRoot, commit);
  } catch (err) {
    console.error(`measureAssociationPolicy: ${err.message}`);
    return 1;
  }
  console.log(format === 'json' ? JSON.stringify(result, null, 2) : render(result));
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  (async () => { process.exitCode = main(process.argv.slice(2)); })();
}
