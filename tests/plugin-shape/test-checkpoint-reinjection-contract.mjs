// Checkpoint re-injection contract — cross-persona.
//
// Three personas ship the same claim about when a checkpoint summary comes
// back, and all three had it wrong in the same way: the prose promised
// re-injection "in the next Claude session" while every manifest registers
// SessionStart with matcher "compact". Re-injection is post-compact on BOTH
// hosts, and on Codex it additionally needs the bundled hooks enabled and
// /hooks-trusted (ADR-0030).
//
// This file exists instead of a copy of the guard in each persona's shape
// test. Three copies of a claim guarded by three copies of a check is the
// same one-of-N-copies defect moved into the tests: whoever updates one
// persona would have to remember to update three assertions. Iterating the
// personas here means adding a persona adds coverage rather than a copy.
//
// Traps this closes, each observed rather than imagined:
//   - Line-based scanning MISSES wrapped copies. The same sentence wraps at a
//     different word in each file; a raw grep found some copies and not
//     others, twice, while the fix was being written. Every scan normalizes
//     whitespace first.
//   - A negative-only guard passes when the corrected wording is deleted
//     outright, so each surface must also positively state the scope.
//   - A per-FILE positive check passes when one of two claims in the same
//     file reverts. The packaged interface metadata carries the claim in two
//     fields that Codex renders directly, so it is asserted per field.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PERSONAS = ['engineer', 'founder', 'designer'];

// Surfaces that talk about re-injection. Each must be free of the retired
// promises AND positively carry the post-compact scope.
const SURFACES = [
  'commands/checkpoint.md',
  'skills/checkpoint/SKILL.md',
  'skills/checkpoint/agents/openai.yaml',
  'skills/resume/SKILL.md',
];
// start/SKILL.md carries a host-availability row on the two personas whose
// start macro documents one; engineer's does not, so it is checked only where
// the row exists rather than being required everywhere.
const OPTIONAL_SURFACES = ['skills/start/SKILL.md'];

const squash = (s) => s.replace(/\s+/g, ' ');

// Retired promises. Each is written to match the PROMISE shape, not the
// corrected negation — the fixed prose says "not on `claude --continue`", and
// a pattern that flagged its own correction would be unusable.
const RETIRED = [
  [/next Claude(?: Code)? session(?:'s)?[^.]{0,60}re-inject/i, 'promises re-injection in "the next Claude session"'],
  [/the next session's SessionStart hook re-injects/i, 'promises a generic next-session re-injection'],
  [/Yes \(next Claude session\)/, 'a host-availability cell still reads "Yes (next Claude session)"'],
  [/the Codex session itself does not re-inject/i, 'claims the Codex session cannot re-inject'],
  [/re-injection[^.]{0,80}is \*\*Claude-only\*\*/i, 'calls re-injection Claude-only'],
  [/after `\/compact` or `claude --continue`\) re-inject/i, 'promises re-injection on claude --continue'],
];

const SCOPE = /post-compact|after compact|matcher: "compact"/;

describe('checkpoint re-injection contract — cross-persona', () => {
  it('every persona registers SessionStart with matcher "compact" on both hosts', async () => {
    // Read the matcher rather than restating it: if a hook changes, the prose
    // guards below become wrong, and this is what makes that fail loudly.
    let checked = 0;
    for (const persona of PERSONAS) {
      for (const rel of ['hooks/hooks.json', 'adapters/codex/hooks/hooks.json']) {
        const raw = await readFile(resolve(REPO_ROOT, 'plugins', persona, rel), 'utf8');
        const sessionStart = JSON.parse(raw).hooks?.SessionStart ?? [];
        ok(
          sessionStart.length > 0,
          `plugins/${persona}/${rel} must register SessionStart — the post-compact prose describes a hook that must exist`,
        );
        ok(
          sessionStart.every((row) => row.matcher === 'compact'),
          `plugins/${persona}/${rel} SessionStart must stay matcher:"compact"; changing it makes every persona's re-injection prose wrong`,
        );
        checked += 1;
      }
    }
    strictEqual(checked, PERSONAS.length * 2, 'both hook manifests must be read for every persona');
  });

  it('no persona surface promises next-session, Claude-only, or --continue re-injection', async () => {
    let scanned = 0;
    for (const persona of PERSONAS) {
      for (const rel of [...SURFACES, ...OPTIONAL_SURFACES]) {
        let text;
        try {
          text = squash(await readFile(resolve(REPO_ROOT, 'plugins', persona, rel), 'utf8'));
        } catch (err) {
          if (OPTIONAL_SURFACES.includes(rel) && err.code === 'ENOENT') continue;
          throw err;
        }
        scanned += 1;
        for (const [pattern, why] of RETIRED) {
          ok(
            !pattern.test(text),
            `plugins/${persona}/${rel} ${why}. Both hosts re-inject post-compact only (matcher:"compact"); Codex additionally needs /hooks trust per ADR-0030.`,
          );
        }
      }
    }
    ok(scanned >= PERSONAS.length * SURFACES.length, `the scan must reach every required surface (scanned ${scanned})`);
  });

  it('every required surface positively states the post-compact scope', async () => {
    // Counterpart to the negative guard: forbidding phrases alone would pass
    // if a persona deleted its corrected wording rather than reverting it.
    for (const persona of PERSONAS) {
      for (const rel of SURFACES) {
        const text = squash(await readFile(resolve(REPO_ROOT, 'plugins', persona, rel), 'utf8'));
        ok(
          SCOPE.test(text),
          `plugins/${persona}/${rel} must state the post-compact scope — deleting the corrected wording must fail, not pass`,
        );
      }
    }
  });

  it('every host-availability ROW that mentions re-injection carries the scope', async () => {
    // A per-FILE positive check passes when the row reverts and some other
    // line in the same file still mentions compact — observed: mutation N4
    // survived exactly that way, because the file's frontmatter description
    // satisfied the file-level check. Bind to the table row itself.
    const ROW_FILES = ['skills/resume/SKILL.md', 'skills/start/SKILL.md', 'skills/checkpoint/SKILL.md'];
    for (const persona of PERSONAS) {
      let rows = 0;
      for (const rel of ROW_FILES) {
        let raw;
        try {
          raw = await readFile(resolve(REPO_ROOT, 'plugins', persona, rel), 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        for (const line of raw.split('\n')) {
          if (!line.trimStart().startsWith('|')) continue;
          if (!/SessionStart re-injection/.test(line)) continue;
          rows += 1;
          ok(
            SCOPE.test(line),
            `plugins/${persona}/${rel} — a host-availability row mentioning SessionStart re-injection must carry the post-compact scope in the ROW itself, not merely somewhere in the file: ${line.trim().slice(0, 120)}`,
          );
        }
      }
      ok(rows > 0, `plugins/${persona} must document re-injection in at least one host-availability row (found ${rows})`);
    }
  });

  it('packaged interface metadata carries the scope in BOTH rendered fields', async () => {
    // Codex renders short_description and default_prompt directly to users.
    // A per-file check passes when one of the two reverts — observed as a
    // surviving mutation while this guard was being written.
    for (const persona of PERSONAS) {
      const raw = await readFile(
        resolve(REPO_ROOT, 'plugins', persona, 'skills/checkpoint/agents/openai.yaml'),
        'utf8',
      );
      for (const field of ['short_description', 'default_prompt']) {
        const line = raw.split('\n').find((l) => l.trimStart().startsWith(`${field}:`));
        ok(line, `plugins/${persona} checkpoint agents/openai.yaml must define ${field}`);
        ok(
          SCOPE.test(line),
          `plugins/${persona} checkpoint agents/openai.yaml ${field} must carry the post-compact scope — Codex renders this field directly`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Docs layer — a PAIRING check, deliberately not the guard above.
//
// The persona guard forbids the retired phrasing. Applied to docs/ that rule
// would demand deleting sentences from Accepted ADRs, which is the opposite of
// what an ADR is for: "Codex SessionStart re-injection does not exist" was TRUE
// when ADR-0022 shipped on 2026-05-12, three days before `a881eb7` landed the
// Codex hooks. The record of what was known then has to survive.
//
// So the docs rule is: the claim may stand, but it may not stand UNMARKED. An
// occurrence must sit in a block that also carries the amendment pointer, or
// inside the OWNER's dated amendment entry (which is itself the correction).
// A newly written unmarked claim fails.
//
// Bypasses a cross-host review found in the first version, each now closed and
// each mutation-tested, because a guard believed to be tight is worse than none:
//   - Heading text was never scanned at all: `### Codex has no SessionStart
//     re-injection` was skipped by the same branch that tracked sections.
//   - `## Amendments` exempted everything after it forever, since an H3 did not
//     end the section. The exemption is now bounded to the dated entry.
//   - A four-space-indented list item did not start a block, so a nested claim
//     inherited an unrelated parent's marker.
//   - YAML frontmatter was one block, letting unrelated keys supply both marker
//     halves.
//   - The prefilter was case-sensitive, so `sessionstart` escaped.
//   - Only docs/ and root Markdown were scanned, while the live false claims
//     were in plugins/ — which is how three persona frontmatter descriptions
//     kept promising "a future session" after being declared corrected.
// ---------------------------------------------------------------------------

const AMENDMENT_OWNER = 'docs/adr/0022-engineer-meta-skill-category.md';
// The one entry allowed to quote what it retires. Bounding the exemption to a
// single dated heading, rather than to the whole section, is what stops the
// owner file from becoming a place where any claim can be parked.
const OWNER_EXEMPT_ENTRY = '2026-08-08 — SessionStart re-injection: what this ADR says about both hosts';

// The historical claims. Written to match the CLAIM, never its correction —
// the amendments say "not Claude-only" and "never the next session", and a
// pattern that flagged the correction it demands would be unusable.
const HISTORICAL = [
  [/Codex has no SessionStart/i, 'says Codex has no SessionStart'],
  [/Codex SessionStart re-?injection does not exist/i, 'says Codex re-injection does not exist'],
  [/Codex does not have a SessionStart/i, 'says Codex has no SessionStart hook'],
  [/SessionStart` hook \(Claude only\)/i, 'calls the SessionStart hook Claude-only'],
  [/\bno SessionStart re-?injection/i, 'asserts an absence of SessionStart re-injection'],
  [/next Claude(?: Code)? session/i, 'promises re-injection in the next Claude session'],
  [/next session's SessionStart/i, 'promises a generic next-session re-injection'],
  [/new-?session summary injection/i, 'describes SessionStart as new-session injection'],
  // Added after ADR-0011 §4 was found by reading, not scanning: a hook-contract
  // table glossed SessionStart as "(new session begins)". None of the patterns
  // above reach a gloss in parentheses.
  [/SessionStart`? \(new session/i, 'glosses SessionStart as firing on a new session'],
  // Added after a cross-host review found all three personas still promising
  // this in their frontmatter `description`, months after the prose below it was
  // corrected. The list above had no synonym for "next session", so a closed
  // pattern list is exactly as good as its authors' vocabulary — treat it as
  // catching restatements, never as proof that none remain.
  [/\bfuture session\b/i, 'promises re-injection in some future session'],
  [/later Claude(?: Code)? session/i, 'promises re-injection in a later Claude session'],
  [/re-?injects? the summary on resume/i, 'promises re-injection on resume, a source the compact matcher does not select'],
];

// Both halves required, and they must be NEAR each other. Requiring only that
// both appear somewhere in the block let an unrelated `#amendments` link, or a
// pair of unrelated YAML keys, bless a false claim.
const MARKER_WORD = /\bamended\b/i;
const MARKER_LINK = /#amendments/i;
const MARKER_SPAN = 400;

// The files a working scan must still be able to see. Pinning identities beats
// pinning a count: a count is satisfiable anywhere, so it cannot tell "the scan
// reaches ADR-0011" from "someone added eight occurrences to one file".
const KNOWN_SITES = [
  ['docs/adr/0010-plugin-boundary-policy.md', 'the ADR-0022 cascade example'],
  ['docs/adr/0011-workflow-continuity-storage.md', 'the §4 hook table and the §5 sentence'],
  ['docs/adr/0017-stage25-continuity-and-schema-roadmap.md', 'the "on resume" schema note'],
  ['docs/adr/0022-engineer-meta-skill-category.md', 'the host-availability matrix'],
  ['docs/adr/0039-completion-footer-activation.md', 'the founder deferral list'],
  ['docs/DEVELOPMENT.md', 'the Stage 2 four-hook bullet'],
];

// Sites where the claim is made by OMISSION — an inventory that lists three
// Claude hooks and one Codex hook, a sentence that calls the set "a single small
// hook". Every word is true and the passage is not, so no phrase pattern can
// reach them; ADR-0012 has no other claim and is therefore invisible to the scan
// entirely. They are pinned by snippet instead, which is weaker (a rewrite drops
// out of the pin) but is the honest limit rather than a pretended one.
const OMISSION_SITES = [
  ['docs/adr/0012-omcc-removal-preconditions.md',
    'Codex Stop helper', 'the continuity-hooks inventory'],
  ['docs/adr/0011-workflow-continuity-storage.md',
    'Both adapters install a single small hook', 'the §4 preamble'],
  ['docs/adr/0011-workflow-continuity-storage.md',
    'no PreCompact equivalent per', 'the §Context host split'],
  ['docs/adr/0011-workflow-continuity-storage.md',
    '| Codex CLI | `Stop` (session end)', 'the §4 table row that is the whole Codex column'],
];

function isMarked(text) {
  for (const m of text.matchAll(new RegExp(MARKER_WORD.source, 'gi'))) {
    const window = text.slice(m.index, m.index + MARKER_SPAN);
    if (MARKER_LINK.test(window)) return true;
  }
  return false;
}

// docs/ AND plugins/ AND root. The first version scanned only docs/, which is
// why it reported a clean repo while three shipped persona descriptions still
// promised "a future session". CHANGELOGs are excluded: they are an append-only
// record of commit subjects and cannot be amended in place.
const SCAN_ROOTS = ['docs', 'plugins', 'kit', 'companions'];
const SCAN_EXT = /\.(md|markdown|ya?ml)$/i;

async function collectDocs() {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
      } else if (SCAN_EXT.test(entry.name) && entry.name !== 'CHANGELOG.md') {
        out.push(relative(REPO_ROOT, full));
      }
    }
  };
  for (const root of SCAN_ROOTS) await walk(resolve(REPO_ROOT, root));
  for (const entry of await readdir(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && SCAN_EXT.test(entry.name)) out.push(entry.name);
  }
  return out.sort();
}

// Blocks, not lines and not files. Lines miss wrapped sentences — the trap the
// persona guard already records. Whole files are too coarse in the other
// direction: one marker anywhere would cover an unmarked claim elsewhere, which
// is the per-FILE failure mode observed on mutation N4. A table row and a list
// item each bind on their own.
function blocksOf(text) {
  const blocks = [];
  let section = '';
  let entry = '';
  let buffer = [];
  let inFrontmatter = false;
  const push = (t) => { if (t.trim()) blocks.push({ text: t, section, entry }); };
  const flush = () => { push(squash(buffer.join(' '))); buffer = []; };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // YAML frontmatter: each key is its own block. Treating the whole fence as
    // one block let an unrelated `status: amended` and a `#amendments` anchor in
    // some other key authorize a false `description:`.
    if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (line.trim() === '---') { flush(); inFrontmatter = false; continue; }
      if (/^\S.*:/.test(line) || /^\s{0,4}\S.*:\s/.test(line)) flush();
      buffer.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // The heading TEXT is a block of its own. Skipping it — as the first
      // version did — meant `### Codex has no SessionStart re-injection` was
      // never scanned at all.
      if (heading[1].length === 2) { section = heading[2].trim(); entry = ''; }
      if (heading[1].length >= 3) entry = heading[2].trim();
      push(squash(heading[2]));
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    if (line.trimStart().startsWith('|')) { flush(); push(squash(line)); continue; }
    // Any list item at any depth starts a block. Bounding this to three spaces
    // let a four-space-nested claim ride on its parent's marker.
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) flush();
    buffer.push(line);
  }
  flush();
  return blocks;
}

describe('checkpoint re-injection contract — docs layer', () => {
  it('every historical claim is marked, or sits in the owner amendment entry', async () => {
    let encountered = 0;
    const reached = new Set();
    for (const rel of await collectDocs()) {
      const raw = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      // Case-insensitive: the previous prefilter let `sessionstart` through, and
      // "re-surfaced" claims never contain the word at all.
      if (!/sessionstart|re-?inject|re-?surfac/i.test(raw)) continue;
      for (const { text, section, entry } of blocksOf(raw)) {
        const hit = HISTORICAL.find(([pattern]) => pattern.test(text));
        if (!hit) continue;
        // Exempt exactly one dated entry in one file: the correction quoting
        // what it retires. Two earlier, looser versions of this line each
        // excused a live claim — first every `## Amendments` (ADR-0010 keeps its
        // cascade history there), then the owner's whole section (an H3 does not
        // end a section, so everything appended after it inherited the pass).
        if (rel === AMENDMENT_OWNER && section === 'Amendments' && entry === OWNER_EXEMPT_ENTRY) continue;
        encountered += 1;
        reached.add(rel);
        ok(
          isMarked(text),
          `${rel} — a block ${hit[1]} without an amendment pointer beside it. `
          + 'Do not delete the sentence: add *(amended <date> — see [Amendments](...#amendments))* '
          + `next to it, and record the correction in ${AMENDMENT_OWNER}. `
          + `Block: ${text.slice(0, 160)}`,
        );
      }
    }
    // Non-vacuity, pinned by IDENTITY rather than by count. A broken scan
    // reports zero findings and passes silently — the failure this file exists
    // to prevent — and a bare count is satisfiable by adding N unrelated
    // occurrences, so it proves reach into no particular file.
    for (const [rel, why] of KNOWN_SITES) {
      ok(reached.has(rel), `the scan no longer reaches ${rel} (${why}); a marked site must stay visible to the scan`);
    }
    ok(encountered >= KNOWN_SITES.length, `expected at least one claim per known site (encountered ${encountered})`);
  });

  it('omission-shaped sites, which no pattern can reach, still carry their marker', async () => {
    for (const [rel, snippet, why] of OMISSION_SITES) {
      const raw = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      const owning = blocksOf(raw).filter((b) => b.text.includes(squash(snippet)));
      ok(
        owning.length > 0,
        `${rel} no longer contains the pinned passage for ${why} (${snippet.slice(0, 50)}…). `
        + 'If it was rewritten rather than marked, update this pin; if it was deleted, drop the entry.',
      );
      for (const block of owning) {
        ok(
          isMarked(block.text),
          `${rel} — ${why} asserts the Codex gap by omission and lost its amendment pointer. `
          + 'A phrase scan cannot re-find this one, so the pointer is the only thing holding it.',
        );
      }
    }
  });

  it('the amendment those pointers target exists and still carries the correction', async () => {
    // Without this, deleting the Amendments entry leaves every inline pointer
    // dangling and the pairing check above still passes.
    const raw = await readFile(resolve(REPO_ROOT, AMENDMENT_OWNER), 'utf8');
    const amendments = raw.split(/^## /m).find((s) => s.startsWith('Amendments'));
    ok(amendments, `${AMENDMENT_OWNER} must keep its ## Amendments section — the inline pointers target it`);
    const squashed = squash(amendments);
    for (const [needle, why] of [
      ['2026-08-08', 'the dated entry'],
      ['post-compact', 'what re-injection actually is on both hosts'],
      ['ADR-0030', 'the condition Codex re-injection carries'],
      ['a881eb7', 'the commit that falsified the Codex claim'],
      ['af12326', 'the commit proving the next-session claim was never true'],
    ]) {
      ok(squashed.includes(needle), `${AMENDMENT_OWNER} §Amendments must retain ${needle} — ${why}`);
    }
  });

  it('a self-pointing marker resolves inside its own file', async () => {
    for (const rel of await collectDocs()) {
      const raw = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      if (!/\]\(#amendments\)/.test(raw)) continue;
      ok(
        /^## Amendments\s*$/m.test(raw),
        `${rel} links to (#amendments) but has no ## Amendments section of its own — either point at ${AMENDMENT_OWNER} or add the section`,
      );
    }
  });
});
