// plugins/orchestrator/adapters/claude/autopilot/phase-evidence.mjs
//
// C163 (ADR-0063, implementation note of 2026-11-04) — what an engineer
// workflow's phase notes show of the verbs that finished in it, read by the
// observer from the workflow file it already located: the evidence a verb
// step, and a dispatch's first verb, is judged by (policy.mjs stepEvidence).
//
// It reads the artifact, it imports nothing of the engineer (ADR-0010 §5): the
// body the engineer's `append --phase-note-file` writes, after the frontmatter.
// A verb's finalize appends one section headed
//
//   ### Phase 1: <Verb> (synthesized)
//
// (the six `--phase-label` literals of plugins/engineer/commands/*.md, held
// equal to VERB_LABELS by tests/orchestrator/test-autopilot-step-evidence.mjs),
// followed by its template's subsections (`### Ensemble synthesis …`, `###
// Ensemble skipped …`, the verb's artifact, `### Active next-action proposal`).
// Only the phase notes count: a section is a heading after the body's
// `## Phase notes` (the request quoted before it is the owner's text). A
// section runs to the next `### Phase <n>:` heading, or to the end; every
// template subsection is a `###` heading too, so no other heading ends one.
// Headings inside a fenced code block of the notes are text. The request
// before the notes is read as no markdown (its first `## Phase notes` line
// ends it), and a backtick fence opens only as CommonMark 4.5 says: its info
// string holds no backtick, so "```a``` inline" opens nothing. A fence a note
// leaves unclosed runs to the end of the body, as in CommonMark, and hides
// the sections after it: the step then halts, a limit that fails closed.
//
// The evidence is `{ body, sections, error }`: the body as read (its line
// endings normalized, its leading blank lines dropped), so the policy can tell
// that the body before a step is the start of the body after it (the body is
// append-only: appendToBody), and each section in body order as
// `{ verb, substantive, start }`:
//   - `substantive`: some subsection other than `Ensemble launched …` and
//     `Active next-action proposal` has a line of text that is not a heading
//     or a fence delimiter — the synthesis, or the verb's artifact. A
//     next-action proposal alone, or an empty code block, is not the verb's
//     work.
//   - `start`: the offset of its heading in `body`.
//
// A body that cannot be read, or holds no `## Phase notes` heading, is no
// evidence: `{ body: null, sections: null, error }`, which the policy halts
// on, never a pass and never zero sections.
//
// The limit: this proves a recorded completion, not the truth of the
// worker's analysis. A fabricated section with text passes.

import fs from 'node:fs';

export const VERB_LABELS = Object.freeze({
  investigate: 'Investigate',
  frame: 'Frame',
  decide: 'Decide',
  compose: 'Compose',
  critique: 'Critique',
  refine: 'Refine',
});

const BY_LABEL = new Map(Object.entries(VERB_LABELS).map(([verb, label]) => [label, verb]));
const PHASE_RE = /^### Phase \d+: /;
const SYNTH_RE = /^### Phase 1: ([A-Z][a-z]+) \(synthesized\)[ \t]*$/;
const SUBSECTION_RE = /^### (.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
// The rest of the line is [\s\S]*, not .*: a line may hold U+2028 or U+2029,
// which . does not match (CommonMark ends a line at a line break only).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const NOT_THE_WORK = [/^Ensemble launched\b/, /^Active next-action proposal\b/];

/** The section heading a verb's finalize writes. */
export const synthesizedHeading = (verb) => `### Phase 1: ${VERB_LABELS[verb]} (synthesized)`;

// The body after the frontmatter, as the engineer's parseWorkflowFile splits
// it, its line endings normalized and its leading blank lines dropped: writes
// of the workflow add blank lines there (a live workflow's body opens with
// many, and a scripted verb step's write moved them), which is no change of
// its notes. Null when the file has no frontmatter.
function bodyOf(text) {
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return null;
  const close = t.indexOf('\n---\n', 4);
  return close === -1 ? null : t.slice(close + 5).replace(/^\n+/, '');
}

/** The evidence of a body (exported for tests). */
export function evidenceOfBody(body) {
  const lines = body.split('\n');
  const sections = [];
  let fence = null;
  let notes = false;
  let offset = 0;
  let current = null;
  let sub = null;
  const counts = () => current !== null && sub !== null && !NOT_THE_WORK.some((re) => re.test(sub));
  const close = () => {
    if (current) sections.push(current);
    current = null;
    sub = null;
  };
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    // The request before the notes is the owner's text, read as no markdown:
    // a fence there opens nothing, so it cannot hide the notes heading.
    if (!notes) {
      if (line === '## Phase notes') notes = true;
      continue;
    }
    if (fence) {
      const m = FENCE_RE.exec(line);
      // A closing fence is followed by spaces or tabs only (CommonMark 4.5).
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^[ \t]*$/.test(m[2])) fence = null;
      else if (line.trim() !== '' && counts()) current.substantive = true;
      continue;
    }
    const f = FENCE_RE.exec(line);
    // CommonMark 4.5: the info string of a backtick fence holds no backtick,
    // so a line such as "```a``` inline" is a paragraph, not a fence.
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    if (PHASE_RE.test(line)) {
      close();
      const m = SYNTH_RE.exec(line);
      const verb = m ? BY_LABEL.get(m[1]) ?? null : null;
      if (verb) current = { verb, substantive: false, start };
      continue;
    }
    if (!current) continue;
    const s = SUBSECTION_RE.exec(line);
    if (s) { sub = s[1].trim(); continue; }
    if (HEADING_RE.test(line) || line.trim() === '') continue;
    // Text before the first subsection is the section's own, not the verb's
    // synthesis or artifact.
    if (counts()) current.substantive = true;
  }
  close();
  if (!notes) return { body: null, sections: null, error: 'its body has no "## Phase notes" heading, a format this orchestrator does not read' };
  return { body, sections, error: null };
}

/** The evidence of a workflow file: `{ body, sections, error }`. Never throws. */
export function phaseEvidence(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    return { body: null, sections: null, error: `cannot read ${file}: ${err.code ?? err.message}` };
  }
  const body = bodyOf(text);
  if (body === null) return { body: null, sections: null, error: `${file} has no frontmatter the engineer writes` };
  return evidenceOfBody(body);
}
