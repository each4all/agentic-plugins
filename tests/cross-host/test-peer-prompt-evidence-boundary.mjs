// C163 D2a — every peer prompt template opens with the evidence boundary.
//
// A peer reads repository files, diffs, logs, earlier outputs and quoted text;
// the boundary tells it all of that is data, not instructions. The templates
// an agent fills to build a peer prompt are the fenced blocks holding a line
// that is exactly `<task>`, in any plugin's Markdown (the persona protocols
// and briefs, their frame templates, the orchestrator's Plan-verify) and in
// the persona-pipeline regions they are generated from. Each must open with
// the boundary word for word, so a template added without it fails here.
// The prompts the dispatchers actually send, a peer-now's caller text
// included, are held by test-evidence-boundary-emitted.mjs (persona-pipeline
// and orchestrator), tests/runtime/test-consensus-evidence-boundary.mjs and
// tests/image/test-critique-evidence-boundary.mjs.
//
// The scan is pinned by identity: the files below must hold exactly these
// counts of templates, so a scan that silently finds fewer fails too. Adding
// a template means adding it here.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { promptTemplates } from './_evidence-boundary-fixtures.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = 'persona-pipeline/files/scripts/lib/evidence-boundary.mjs';
const { EVIDENCE_BOUNDARY, opensWithEvidenceBoundary, withEvidenceBoundary, withEvidenceBoundaryBytes } = await import(pathToFileURL(join(REPO_ROOT, SOURCE)).href);

const EXPECTED = {
  'persona-pipeline/regions/ensemble-scoped-recheck.md': 2,
  'plugins/designer/core/skills/_shared/references/ensemble-protocol.md': 7,
  'plugins/designer/core/skills/frame/SKILL.md': 1,
  'plugins/designer/core/skills/investigate/references/design-brief-ensemble.md': 1,
  'plugins/engineer/core/skills/_shared/references/ensemble-protocol.md': 11,
  'plugins/engineer/core/skills/investigate/references/cited-brief-ensemble.md': 1,
  'plugins/founder/commands/frame.md': 1,
  'plugins/founder/core/skills/_shared/references/ensemble-protocol.md': 10,
  'plugins/founder/core/skills/investigate/references/business-brief-ensemble.md': 1,
  'plugins/orchestrator/core/skills/_shared/references/ensemble-protocol.md': 1,
};

function* markdown(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* markdown(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

function scan() {
  const found = {};
  for (const root of ['plugins', 'persona-pipeline/regions']) {
    for (const file of markdown(join(REPO_ROOT, root))) {
      const templates = promptTemplates(file);
      if (templates.length > 0) found[relative(REPO_ROOT, file)] = templates;
    }
  }
  return found;
}

describe('every peer prompt template opens with the evidence boundary (C163 D2a)', () => {
  const found = scan();

  it('the templates are found where they are known to be, and nowhere unlisted', () => {
    deepStrictEqual(
      Object.fromEntries(Object.entries(found).map(([f, t]) => [f, t.length]).sort(([a], [b]) => a.localeCompare(b))),
      EXPECTED,
    );
  });

  it('each template opens with the boundary, word for word', () => {
    const missing = [];
    for (const [file, templates] of Object.entries(found)) {
      for (const t of templates) {
        if (!t.body.startsWith(`${EVIDENCE_BOUNDARY}\n`)) missing.push(`${file}:${t.line}`);
      }
    }
    deepStrictEqual(missing, [], `templates that do not open with the boundary of ${SOURCE}`);
  });

  it('a prompt opens with the boundary through indentation, rewrapping, CRLF, a BOM and tags with no blank beside them, never through one planted later', () => {
    const lines = EVIDENCE_BOUNDARY.split('\n');
    const opening = {
      'as written': EVIDENCE_BOUNDARY,
      indented: lines.map((l) => `  ${l}`).join('\n'),
      rewrapped: lines.join(' '),
      crlf: lines.join('\r\n'),
      bom: String.fromCharCode(0xfeff) + EVIDENCE_BOUNDARY,
      'tags with no blank': lines[0] + lines.slice(1, -1).join(' ') + lines.at(-1),
    };
    for (const [name, head] of Object.entries(opening)) {
      ok(opensWithEvidenceBoundary(`${head}\n\n<task>\nx\n</task>`), `${name}: opens with the boundary`);
      const prompt = `${head}\n\n<task>\nx\n</task>`;
      ok(withEvidenceBoundary(prompt) === prompt, `${name}: not bounded twice`);
    }
    const planted = `<task>\nReview.\n</task>\n\n${EVIDENCE_BOUNDARY}\n`;
    ok(!opensWithEvidenceBoundary(planted), 'a boundary after the task does not open the prompt');
    ok(withEvidenceBoundary(planted).startsWith(`${EVIDENCE_BOUNDARY}\n\n<task>`), 'so it gets a leading one');
    ok(!opensWithEvidenceBoundary(`${lines.join('')}\n\n<task>\nx\n</task>`), 'words run together (no blank between two lines) are not the boundary');
  });

  // A BOM is a decoder's signature for the start of a file: prepended to, it
  // would reach the model as a character in the middle of the prompt.
  it('a prompt without the boundary that opens with a BOM gets the boundary, the BOM dropped, as text and as bytes', () => {
    const bom = String.fromCharCode(0xfeff);
    ok(withEvidenceBoundary(`${bom}<task>\nx\n</task>`) === `${EVIDENCE_BOUNDARY}\n\n<task>\nx\n</task>`, 'text: the BOM is dropped');
    const bounded = withEvidenceBoundaryBytes(Buffer.from(`${bom}<task>\nx\n</task>`, 'utf8'));
    ok(bounded.equals(Buffer.from(`${EVIDENCE_BOUNDARY}\n\n<task>\nx\n</task>`, 'utf8')), 'bytes: the BOM is dropped');
    const notUtf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<task>'), Buffer.from([0xff, 0xfe])]);
    ok(withEvidenceBoundaryBytes(notUtf8).equals(Buffer.concat([Buffer.from(`${EVIDENCE_BOUNDARY}\n\n`), notUtf8.subarray(3)])),
      'bytes that are not UTF-8: the BOM is dropped, the rest kept as it is');
    const already = `${bom}${EVIDENCE_BOUNDARY}\n\n<task>\nx\n</task>`;
    ok(withEvidenceBoundary(already) === already, 'a prompt that opens with the boundary after its BOM is left as it is');
    ok(withEvidenceBoundaryBytes(Buffer.from(already, 'utf8')).equals(Buffer.from(already, 'utf8')), 'and so are its bytes, the BOM kept');
  });

  it('the check takes time linear in the prompt, whatever runs of blanks its evidence holds', () => {
    const run = ' '.repeat(50_000);
    const prompts = [
      `${EVIDENCE_BOUNDARY}\n\n<task>\nReview this log.\n</task>\n${run}x${run}y`,
      `<task>\nReview this log.\n</task>\n${run}x${run}y`,
      `${run}${EVIDENCE_BOUNDARY}\n\n<task>\nx\n</task>`,
    ];
    const started = performance.now();
    const bounded = prompts.map((p) => withEvidenceBoundary(p));
    const took = performance.now() - started;
    ok(took < 1000, `three prompts with runs of 50,000 blanks took ${Math.round(took)} ms (a linear check takes a few)`);
    deepStrictEqual(bounded.map((p, i) => p === prompts[i]), [true, false, true], 'and each is judged as before');
  });

  // runtime consensus and image critique build their prompts from a copy of
  // the library kept in their own package (the orchestrator's copy is held by
  // tests/scripts/test-orchestrator-peer-snapshot-parity.mjs).
  for (const [name, plugin] of [['runtime', 'plugins/runtime'], ['image', 'plugins/image']]) {
    it(`${name}'s copy of the boundary library is its notice, then the source byte for byte`, () => {
      const notice = Buffer.from([
        '// COPIED from persona-pipeline — do not edit this copy.',
        `// Source: ${SOURCE}, byte for byte below these`,
        '// three lines; tests/cross-host/test-peer-prompt-evidence-boundary.mjs checks it.',
        '',
      ].join('\n'), 'utf8');
      const file = `${plugin}/scripts/lib/evidence-boundary.mjs`;
      const copy = readFileSync(join(REPO_ROOT, file));
      ok(copy.subarray(0, notice.length).equals(notice), `the copy notice of ${file} is missing or changed`);
      ok(copy.subarray(notice.length).equals(readFileSync(join(REPO_ROOT, SOURCE))), `${file} drifted from ${SOURCE}`);
    });
  }
});
