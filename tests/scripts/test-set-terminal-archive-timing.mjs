// Guard test for the archive-timing statement at every terminalization site.
//
// The runbooks used to say the Stop hook archives "once the user commits and
// closes the session". It does not: on Claude the Stop hook fires at EVERY turn
// end, so a terminal write puts the workflow in front of the archive gates at
// the end of THAT turn. A reader who believed the old sentence would set the
// marker expecting a later, deliberate close, and lose the workflow one turn
// later; the escape (`--terminal-marker false`) is open only until that Stop
// fires, needs set-terminal's full flag set, and was documented nowhere.
//
// Invariants:
//   (i)   Every runnable `state.mjs set-terminal` invocation in a plugin runbook
//         carries the statement in the comment block IMMEDIATELY above it —
//         bound per invocation, not per file, so one annotated site cannot
//         vouch for an unannotated sibling.
//   (ii)  The two paths that reach the same terminal state WITHOUT a
//         `set-terminal` call — `/orchestrator:next` and `/orchestrator:done`,
//         which terminalize through `subtask-update`'s auto-terminal pass —
//         carry it too. No sweep can discover these, so they are pinned by
//         identity; that is the one enumerated list here, and it exists because
//         the fact is undecidable from the text, not to save effort.
//   (iii) The statement names all three load-bearing facts, and does not carry
//         their inversions.
//   (iv)  The disproved claim is absent across every markdown file in the repo,
//         not just the runbooks.
//   (v)   Every persona/capability shared reference carries the canonical
//         section — discovered, so orchestrator's cannot be forgotten again.
//
// Known limits, stated rather than papered over: (a) the fact regexes test
// vocabulary, and the inversion list catches only the phrasings enumerated in
// FORBIDDEN_IN_ANNOTATION — a sufficiently creative rewording that means the
// opposite would still pass; (b) the repo-wide sweep exempts lines carrying an
// `amended` marker, because ADR body text is deliberately preserved as written
// with an inline correction pointer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// Each is a distinct claim a reader can act on; dropping any one restores a
// different half of the original defect. Matched by regex, not substring,
// because the same fact is written as a bash comment at an invocation
// ("EVERY turn end") and as prose in a reference ("**every turn end**").
const REQUIRED_FACTS = [
  { re: /every turn end/i, why: 'the Claude per-turn firing is the corrected fact' },
  { re: /--terminal-marker false/, why: 'the unset window is the only escape' },
  { re: /Codex/, why: 'the Codex hook is trust-gated, so its evaluation is deferred' },
];

const INVOCATION_LABEL = { re: /ARCHIVE TIMING/, why: 'the block must be findable by its label' };

// Vocabulary alone would let an annotation assert the opposite and still match
// every fact regex. These catch the inversions worth naming.
const FORBIDDEN_IN_ANNOTATION = [
  /not\s+fire\s+at\s+every\s+turn/i,
  /never\s+fires?\s+at\s+every\s+turn/i,
  /fires?\s+(?:only\s+)?at\s+session\s+(?:end|close)/i,
  /Codex\s+always\s+archives/i,
  /`?--terminal-marker false`?\s+is\s+forbidden/i,
];

// The disproved claim, and the shapes it takes elsewhere in the repo.
const DISPROVED_CLAIMS = [
  /closes the session/i,
  /Stop[^.\n]{0,60}\bat session end\b/i,
  /Stop[^.\n]{0,60}\bend-of-session\b/i,
];
// ADR body text is preserved as written and corrected by an inline pointer.
const AMENDED_MARKER = /amended|Amendment/;

// Paths that reach terminal state without a literal `set-terminal` invocation:
// `subtask-update`'s auto-terminal pass marks the macro. Undiscoverable by
// sweep — pinned by identity.
const IMPLICIT_TERMINAL_PATHS = [
  'plugins/orchestrator/commands/next.md',
  'plugins/orchestrator/commands/done.md',
  'plugins/orchestrator/skills/next/SKILL.md',
  'plugins/orchestrator/skills/done/SKILL.md',
];

// Measured floor when this guard landed. Sites may only grow.
const MIN_INVOCATIONS = 26;
const PLUGINS_WITH_INVOCATIONS = ['engineer', 'designer', 'founder', 'orchestrator'];
const MIN_SHARED_REFERENCES = 4;

function walkMarkdown(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

// Runbook corpus: every markdown file under a plugin's commands/ or skills/.
// Scripts, adapters and CHANGELOGs are out of scope — implementation and
// history, not instructions an agent follows.
function runbookFiles() {
  const out = [];
  for (const plugin of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    for (const sub of ['commands', 'skills']) {
      out.push(...walkMarkdown(path.join(PLUGINS_DIR, plugin.name, sub)));
    }
  }
  return out.sort();
}

// Every markdown file that teaches, anywhere in the repo. CHANGELOGs are
// generated release history and are excluded.
function allMarkdown() {
  const out = [
    ...walkMarkdown(path.join(REPO_ROOT, 'docs')),
    ...walkMarkdown(PLUGINS_DIR),
    ...walkMarkdown(path.join(REPO_ROOT, 'companions')),
    ...walkMarkdown(path.join(REPO_ROOT, 'kit')),
    ...fs.readdirSync(REPO_ROOT).filter((f) => f.endsWith('.md')).map((f) => path.join(REPO_ROOT, f)),
  ];
  return out.filter((f) => !path.basename(f).startsWith('CHANGELOG')).sort();
}

function sharedReferences() {
  const out = [];
  for (const plugin of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const p = path.join(PLUGINS_DIR, plugin.name, 'skills/_shared/references/session-handoff.md');
    if (fs.existsSync(p)) out.push(p);
  }
  return out.sort();
}

// A runnable invocation, as opposed to prose quoting one: a `node …state.mjs`
// command inside a fenced code block whose continuation-joined text reaches
// `set-terminal`. An `env VAR=v` prefix still counts — requiring the line to
// begin with `node` was an evasion a reviewer reproduced.
const NODE_COMMAND = /^\s*(?:(?:env|command|exec)\s+(?:\S+=\S*\s+)*)*node\s/;

function findInvocations(lines) {
  const sites = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence) continue;
    if (!NODE_COMMAND.test(lines[i])) continue;
    if (!/state\.mjs/.test(lines[i])) continue;
    let end = i;
    let joined = lines[i];
    while (/\\\s*$/.test(lines[end]) && end + 1 < lines.length) {
      end++;
      joined += ' ' + lines[end].trim();
    }
    if (/\bset-terminal\b/.test(joined)) sites.push({ line: i, joined });
  }
  return sites;
}

// The contiguous comment block directly above the invocation — no blank line
// between. Binding to this window is what makes the guard per-invocation: a
// note attached to some other site in the same file cannot reach here.
function commentBlockAbove(lines, invocationLine) {
  const block = [];
  for (let i = invocationLine - 1; i >= 0; i--) {
    if (/^\s*#/.test(lines[i])) block.unshift(lines[i]);
    else break;
  }
  return block.join('\n');
}

function missingFacts(block, facts) {
  return facts.filter((f) => !f.re.test(block));
}

test('every set-terminal invocation states when the Stop hook evaluates the gates', () => {
  const files = runbookFiles();
  assert.ok(files.length > 0, 'runbook sweep found no markdown — the corpus paths moved');

  const problems = [];
  const pluginsSeen = new Set();
  let total = 0;

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const site of findInvocations(lines)) {
      total++;
      pluginsSeen.add(rel.split(path.sep)[1]);
      const block = commentBlockAbove(lines, site.line);
      const absent = missingFacts(block, [INVOCATION_LABEL, ...REQUIRED_FACTS]);
      if (absent.length > 0) {
        problems.push(
          `${rel}:${site.line + 1} — comment block above is missing ` +
            absent.map((f) => `${f.re} (${f.why})`).join(', '),
        );
      }
      for (const bad of FORBIDDEN_IN_ANNOTATION) {
        if (bad.test(block)) problems.push(`${rel}:${site.line + 1} — annotation asserts the inverse: ${bad}`);
      }
    }
  }

  // Non-vacuity: a matcher that silently stops matching must fail, not pass.
  assert.ok(
    total >= MIN_INVOCATIONS,
    `found only ${total} set-terminal invocations, expected >= ${MIN_INVOCATIONS} — ` +
      'the detector regressed, or invocations were removed without lowering the floor',
  );
  for (const plugin of PLUGINS_WITH_INVOCATIONS) {
    assert.ok(
      pluginsSeen.has(plugin),
      `no set-terminal invocation detected under plugins/${plugin} — detector regressed`,
    );
  }

  assert.deepEqual(problems, [], `unannotated set-terminal invocations:\n  ${problems.join('\n  ')}`);
});

test('the implicit auto-terminal paths carry the statement too', () => {
  const problems = [];
  for (const rel of IMPLICIT_TERMINAL_PATHS) {
    const full = path.join(REPO_ROOT, rel);
    assert.ok(fs.existsSync(full), `${rel} is missing — the pinned path moved`);
    const text = fs.readFileSync(full, 'utf8');
    if (!/ARCHIVE TIMING/.test(text)) {
      problems.push(`${rel} — terminalizes via subtask-update's auto-terminal pass but says nothing about when`);
      continue;
    }
    for (const f of missingFacts(text, REQUIRED_FACTS)) {
      problems.push(`${rel} — ARCHIVE TIMING note omits ${f.re} (${f.why})`);
    }
  }
  assert.deepEqual(problems, [], `implicit terminal paths:\n  ${problems.join('\n  ')}`);
});

test('no markdown in the repo still teaches session-end archiving', () => {
  const offenders = [];
  for (const file of allMarkdown()) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (AMENDED_MARKER.test(line)) return; // preserved-as-written, pointer attached
      for (const claim of DISPROVED_CLAIMS) {
        if (claim.test(line)) offenders.push(`${rel}:${i + 1} — ${claim} — ${line.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepEqual(
    offenders, [],
    'Stop fires at every turn end, not at session close — these lines still claim otherwise:\n  ' +
      offenders.join('\n  '),
  );
});

// Slice out one `## `-level section, bounded by the NEXT `## ` heading. Reading
// to end-of-file instead would let any later section — these references all have
// a "## Codex hook parity" one — satisfy the facts below, and the check would
// pass on an empty archive-timing section.
function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

test('every shared reference carries the canonical archive-timing section', () => {
  const refs = sharedReferences();
  assert.ok(
    refs.length >= MIN_SHARED_REFERENCES,
    `discovered only ${refs.length} shared references, expected >= ${MIN_SHARED_REFERENCES}`,
  );
  for (const full of refs) {
    const rel = path.relative(REPO_ROOT, full);
    const body = section(fs.readFileSync(full, 'utf8'), '## Archive timing');
    assert.ok(body, `${rel} lacks the "## Archive timing" section`);
    for (const f of missingFacts(body, REQUIRED_FACTS)) {
      assert.fail(`${rel} archive-timing section omits ${f.re} (${f.why})`);
    }
    assert.match(
      body, /evaluated|evaluation/,
      `${rel} must say the gates are EVALUATED at turn end — archival follows only if they pass`,
    );
  }
});
