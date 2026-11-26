// Guard test: no markdown in the repository still teaches session-end
// archiving (invariant (iv) of tests/scripts/test-set-terminal-archive-timing.mjs,
// which keeps the runbook invariants; this sweep was split from it, C154 F2).
//
// The runbooks used to say the Stop hook archives "once the user commits and
// closes the session". It does not: on Claude the Stop hook fires at EVERY turn
// end. The disproved claim must be absent from every markdown file that
// teaches, not just the runbooks.
//
// Why a file of its own: this sweep names the repository's documentation
// directories, so the autopilot's test selector (verify-select.mjs) selects it
// for every documentation change. Kept beside the runbook checks, it pulled
// that whole file, and everything that reaches it through mutation specs, into
// the selection of every ADR edit.
//
// Known limit, stated rather than papered over: the sweep exempts lines
// carrying an `amended` marker, because ADR body text is deliberately
// preserved as written with an inline correction pointer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

// The disproved claim, and the shapes it takes elsewhere in the repo.
const DISPROVED_CLAIMS = [
  /closes the session/i,
  /Stop[^.\n]{0,60}\bat session end\b/i,
  /Stop[^.\n]{0,60}\bend-of-session\b/i,
];
// ADR body text is preserved as written and corrected by an inline pointer.
const AMENDED_MARKER = /amended|Amendment/;

function walkMarkdown(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A genuinely absent directory is expected. Anything else — a permission
    // or I/O error — would silently empty the corpus.
    if (err?.code === 'ENOENT') return acc;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
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
  // Contract: an agent reading the repo's markdown before a terminal write —
  // the runbooks, the plugin READMEs, AGENTS.md and the ADRs a session starts
  // from — a line that still says the Stop hook archives at session end or
  // close teaches it to write the marker and expect a later, deliberate close.
  assert.deepEqual(
    offenders, [],
    'Stop fires at every turn end, not at session close — these lines still claim otherwise:\n  ' +
      offenders.join('\n  '),
  );
});
