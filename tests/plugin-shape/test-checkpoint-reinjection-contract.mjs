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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
