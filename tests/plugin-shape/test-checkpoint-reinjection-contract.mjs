// Checkpoint re-injection contract — the three personas and orchestrator.
//
// The checkpoint surfaces tell the agent, and through it the user, what comes
// back and when: re-injection is post-compact on both hosts (SessionStart
// registers matcher "compact"; tests/persona-pipeline/test-skill-contracts.mjs
// holds the personas' matcher, tests/plugin-shape/test-orchestrator-plugin.mjs
// orchestrator's), and a new session needs a manual resume. A surface that
// promised next-session re-injection would hand the user off to a session that
// never receives the checkpoint. On Codex re-injection also needs the bundled
// hooks enabled and /hooks-trusted (ADR-0030).
//
// One file iterates the plugins instead of a copy per plugin's shape test, so
// adding a persona adds coverage rather than a copy. Every scan normalizes
// whitespace first: the same sentence wraps at a different word in each file.
// E1's rule (owner-approved 2026-10-05) removed the docs-layer checks, which
// held docs/ history to an amendment marker; of the plugin prose they also
// scanned, the surfaces that hand a checkpoint off are scanned below.

import { describe, it } from 'node:test';
import { ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PERSONAS = ['engineer', 'founder', 'designer'];
const PLUGINS = [...PERSONAS, 'orchestrator'];

// A surface is named by AREA + path within it, not by one joined string. The
// two areas move differently: ADR-0006's 2026-09-18 Amendment relocates a
// plugin's skills root under `core/` (and each plugin declares where its root
// is, in its Codex manifest), while `commands/` stays put. Spelling `skills/`
// into a path literal points every `skills` entry below at a relocated
// plugin's README-only tombstone: required reads then throw ENOENT and the
// per-plugin row floor fails, but an optional surface is skipped silently.
const surface = (area, rel, optional = false) => ({ area, rel, optional });

function surfacePath(persona, { area, rel }) {
  const pluginDir = join(REPO_ROOT, 'plugins', persona);
  const segments = rel.split('/');
  return area === 'skills'
    ? skillsPath(pluginDir, ...segments)
    : join(pluginDir, area, ...segments);
}

// Repo-relative, computed from the resolved path: a label that kept saying
// `skills/…` after the plugin moved would point a failing assertion at a file
// that no longer exists.
const surfaceLabel = (persona, entry) => relative(REPO_ROOT, surfacePath(persona, entry));


// Surfaces that talk about re-injection. Each must be free of the retired
// promises AND positively carry the post-compact scope. Orchestrator's macro
// checkpoint and resume carry the same handoff.
const CHECKPOINT_SKILL = surface('skills', 'checkpoint/SKILL.md');
const CHECKPOINT_AGENT = surface('skills', 'checkpoint/agents/openai.yaml');
const RESUME_SKILL = surface('skills', 'resume/SKILL.md');
const START_ROWS = surface('skills', 'start/SKILL.md');
const PERSONA_SURFACES = [surface('commands', 'checkpoint.md'), CHECKPOINT_SKILL, CHECKPOINT_AGENT, RESUME_SKILL];
const SURFACES = {
  engineer: PERSONA_SURFACES,
  founder: PERSONA_SURFACES,
  designer: PERSONA_SURFACES,
  orchestrator: [surface('commands', 'checkpoint.md'), CHECKPOINT_SKILL, RESUME_SKILL],
};
// Surfaces that hand off the same workflow but state no re-injection today:
// scanned for the retired promises only, so one added later is caught.
// Orchestrator's checkpoint openai.yaml is one of them.
const RESUME_HANDOFF = [surface('commands', 'resume.md'), surface('skills', 'resume/agents/openai.yaml')];
const NEGATIVE_ONLY = {
  engineer: RESUME_HANDOFF,
  founder: RESUME_HANDOFF,
  designer: RESUME_HANDOFF,
  orchestrator: [CHECKPOINT_AGENT, ...RESUME_HANDOFF],
};
// start/SKILL.md carries a host-availability row on the two personas whose
// start macro documents one; engineer's does not, so it is scanned only where
// it exists and its row is required only where the macro documents one.
const START_SKILL = surface('skills', 'start/SKILL.md', true);
const ROW_SURFACES = {
  engineer: [RESUME_SKILL, CHECKPOINT_SKILL],
  founder: [RESUME_SKILL, START_ROWS, CHECKPOINT_SKILL],
  designer: [RESUME_SKILL, START_ROWS, CHECKPOINT_SKILL],
  orchestrator: [RESUME_SKILL, CHECKPOINT_SKILL],
};

const squash = (s) => s.replace(/\s+/g, ' ');

// Retired promises. Each is written to match the PROMISE shape, not the
// corrected negation — the fixed prose says "not on `claude --continue`", and
// a pattern that flagged its own correction would be unusable. The synonyms
// (re-surfaces, a future or later session, on resume, the gloss of
// SessionStart as a new session) are the ones the retired docs-layer scan
// found in plugin prose; a closed list is as good as its vocabulary, so it
// catches restatements and proves none absent. A synonym marked `affirmative`
// is a promise only in a clause that does not negate it ("is not re-injected
// in a future session" is the correction). None matches a current surface
// (measured 2026-10-07 on all 27 checkpoint, resume and start files).
const RETIRED = [
  [/next Claude(?: Code)? session(?:'s)?[^.]{0,60}re-?(?:inject|surfac)/i, 'promises re-injection in "the next Claude session"'],
  [/re-?(?:inject|surfac)\w*[^.|]{0,60}\b(?:in|at|on) the next (?:Claude(?: Code)? )?session\b/i, 'promises re-injection at the next session', 'affirmative'],
  [/the next session's SessionStart hook re-injects/i, 'promises a generic next-session re-injection'],
  [/\bfuture session\b/i, 'promises re-injection in some future session', 'affirmative'],
  [/later Claude(?: Code)? session/i, 'promises re-injection in a later Claude session', 'affirmative'],
  [/re-?injects? the summary on resume/i, 'promises re-injection on resume, a source the compact matcher does not select', 'affirmative'],
  [/new-?session summary injection|SessionStart`? \(new session/i, 'describes SessionStart as firing on a new session', 'affirmative'],
  [/Yes \(next Claude session\)/, 'a host-availability cell still reads "Yes (next Claude session)"'],
  [/the Codex session itself does not re-inject/i, 'claims the Codex session cannot re-inject'],
  [/re-injection[^.]{0,80}is \*\*Claude-only\*\*/i, 'calls re-injection Claude-only'],
  [/after `\/compact` or `claude --continue`\) re-inject/i, 'promises re-injection on claude --continue'],
];
const NEGATION = /\b(?:not|never|no|cannot|without)\b|n['’]t\b/i;
const CLAUSE_BREAK = /[.,;:|()—–]/;

// The clause around a match: back and forward to the nearest clause break,
// at most 60 characters each way. A whole sentence is too wide — "re-injects
// in the next session — not only after compact" negates a different clause.
function clauseAround(text, start, end) {
  let from = start;
  while (from > 0 && start - from < 60 && !CLAUSE_BREAK.test(text[from - 1])) from -= 1;
  let to = end;
  while (to < text.length && to - end < 60 && !CLAUSE_BREAK.test(text[to])) to += 1;
  return text.slice(from, to);
}

// Whether `text` makes the promise: a match, outside a clause that negates it
// when the pattern is affirmative-only.
function promises(text, pattern, mode) {
  for (const m of text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
    if (mode !== 'affirmative') return true;
    if (!NEGATION.test(clauseAround(text, m.index, m.index + m[0].length))) return true;
  }
  return false;
}

const SCOPE = /post-compact|after compact|matcher: "compact"/;

// The decoded value of a one-line YAML scalar `key: value` — what the host
// shows, not the source line: a `# comment` after the value is not part of it,
// and a line whose value is only a comment (`key: # post-compact`) holds an
// empty value, not the comment. Undefined when the key is absent or the line
// holds more than the scalar.
function scalarValue(lines, key) {
  const line = lines.find((l) => l.trimStart().startsWith(`${key}:`));
  if (line === undefined) return undefined;
  const raw = line.trimStart().slice(key.length + 1).trimStart();
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(raw) ?? /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(raw);
  if (quoted) return raw.startsWith('"') ? JSON.parse(`"${quoted[1]}"`) : quoted[1].replace(/''/g, "'");
  if (/^["']/.test(raw)) return undefined;
  return raw.replace(/(?:^|\s+)#.*$/, '');
}

function frontmatterLines(raw) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  return fm ? fm[1].split('\n') : [];
}

describe('checkpoint re-injection contract — personas and orchestrator', () => {
  // Contract: the agent finishing a checkpoint, compacting or resuming hands the
  // user off by these surfaces — a promise of next-session or --continue
  // re-injection sends the user to a session the checkpoint never reaches.
  it('no surface promises next-session, Claude-only, or --continue re-injection', async () => {
    let scanned = 0;
    for (const plugin of PLUGINS) {
      for (const entry of [...SURFACES[plugin], ...NEGATIVE_ONLY[plugin], START_SKILL]) {
        let text;
        try {
          text = squash(await readFile(surfacePath(plugin, entry), 'utf8'));
        } catch (err) {
          if (entry.optional && err.code === 'ENOENT') continue;
          throw err;
        }
        scanned += 1;
        for (const [pattern, why, mode] of RETIRED) {
          ok(
            !promises(text, pattern, mode),
            `${surfaceLabel(plugin, entry)} ${why}. Both hosts re-inject post-compact only (matcher:"compact"); Codex additionally needs /hooks trust per ADR-0030.`,
          );
        }
      }
    }
    const required = PLUGINS.reduce((n, plugin) => n + SURFACES[plugin].length + NEGATIVE_ONLY[plugin].length, 0);
    ok(scanned >= required, `the scan must reach every required surface (scanned ${scanned} of ${required})`);
  });

  // Contract: the same handoff — the negative scan alone passes when a surface
  // loses its corrected wording instead of reverting it, and then the agent
  // has nothing telling it re-injection is post-compact.
  it('every required surface positively states the post-compact scope', async () => {
    for (const plugin of PLUGINS) {
      for (const entry of SURFACES[plugin]) {
        const text = squash(await readFile(surfacePath(plugin, entry), 'utf8'));
        ok(
          SCOPE.test(text),
          `${surfaceLabel(plugin, entry)} must state the post-compact scope — deleting the corrected wording must fail, not pass`,
        );
      }
    }
  });

  // Contract: the agent answering "will this come back?" reads the
  // host-availability row for its host — a row that promises re-injection
  // without the post-compact scope (at the next session start, at every new
  // session) passes a per-file check on scope text elsewhere in the file, and
  // matches no retired phrase the list above knows. Each surface keeps its own
  // row: a row relabelled out of recognition leaves its surface with none.
  it('every host-availability row that mentions re-injection carries the scope in the row', async () => {
    for (const plugin of PLUGINS) {
      for (const entry of ROW_SURFACES[plugin]) {
        const raw = await readFile(surfacePath(plugin, entry), 'utf8');
        let rows = 0;
        for (const line of raw.split('\n')) {
          if (!line.trimStart().startsWith('|')) continue;
          if (!/SessionStart|re-?inject|re-?surfac/i.test(line)) continue;
          rows += 1;
          ok(
            SCOPE.test(line),
            `${surfaceLabel(plugin, entry)} — a host-availability row mentioning SessionStart or re-injection must carry the post-compact scope in the row itself: ${line.trim().slice(0, 120)}`,
          );
        }
        ok(rows > 0, `${surfaceLabel(plugin, entry)} must document re-injection in its own host-availability row (found ${rows})`);
      }
    }
  });

  // Contract: Claude Code and Codex read the checkpoint skill's frontmatter
  // `description` to decide when to offer it, and show it to the user — a
  // description promising that the next session re-surfaces the note repeats
  // the handoff defect where the file's later prose cannot correct it.
  it('the checkpoint skill description carries the post-compact scope in the field', async () => {
    for (const plugin of PLUGINS) {
      const raw = await readFile(surfacePath(plugin, CHECKPOINT_SKILL), 'utf8');
      const value = scalarValue(frontmatterLines(raw), 'description');
      ok(value, `${surfaceLabel(plugin, CHECKPOINT_SKILL)} must have a one-line frontmatter description`);
      ok(
        SCOPE.test(value),
        `${surfaceLabel(plugin, CHECKPOINT_SKILL)} description must carry the post-compact scope — the host shows this field, not the prose below it`,
      );
    }
  });

  // Contract: Codex renders these openai.yaml fields to the user directly, and
  // the default prompt is what Codex runs — either field reverting to a
  // next-session promise repeats the handoff defect above.
  it('packaged interface metadata carries the scope in BOTH rendered fields', async () => {
    // A per-file check passes when one of the two reverts — observed as a
    // surviving mutation while this guard was being written.
    for (const persona of PERSONAS) {
      const lines = (await readFile(surfacePath(persona, CHECKPOINT_AGENT), 'utf8')).split('\n');
      for (const field of ['short_description', 'default_prompt']) {
        const value = scalarValue(lines, field);
        ok(value, `plugins/${persona} checkpoint agents/openai.yaml must define ${field}`);
        ok(
          SCOPE.test(value),
          `plugins/${persona} checkpoint agents/openai.yaml ${field} must carry the post-compact scope — Codex renders this field directly`,
        );
      }
    }
  });
});
