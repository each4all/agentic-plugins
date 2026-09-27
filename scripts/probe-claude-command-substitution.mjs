#!/usr/bin/env node
// Re-measure what Claude Code does to a plugin command body's arguments.
//
//   node scripts/probe-claude-command-substitution.mjs [--write]
//
// tests/fixtures/claude-command-substitution.json records what one Claude
// Code version handed the model for each argument string, and
// tests/_claude-command-substitution.mjs reproduces it. Nothing in the suite
// notices when a newer Claude does it differently — the fixture is a record,
// not a watch. This script repeats the measurement: it loads the fixture's
// probe commands as a scratch plugin, types each recorded argument string
// after them (`claude -p --plugin-dir`, hooks disabled, no tools, a small
// model), reads the expanded body back from the session transcript, and
// reports every cell that differs. With --write it replaces the fixture with
// what it measured, under the version that measured it; the port and its gate
// must then agree with the new record before anything relies on it.
//
// Manual only: every cell is one model call on the operator's account. The
// transcripts it creates, and the project directory Claude files them under
// (named after this script's temporary working directory), are removed again,
// also when a call fails. Run it when a runbook misbehaves in a way the port
// did not predict, or before relying on a token form the fixture does not
// cover (add the cell to the fixture's bodies first).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../tests/fixtures/claude-command-substitution.json', import.meta.url));
const PLUGIN = 'substitution-probe';

// Where Claude keeps transcripts: the child inherits CLAUDE_CONFIG_DIR.
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

function transcriptOf(sessionId) {
  if (!existsSync(PROJECTS)) return null;
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The expanded probe body and the Claude Code version that wrote the
 * transcript. Only the command expansion counts — the user message Claude
 * marks as meta — and only with both markers, so neither the model's reply
 * nor a cut-off body can pass as a measurement.
 */
function readTranscript(transcript) {
  let version = null;
  for (const line of readFileSync(transcript, 'utf8').split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    version ??= entry.version ?? null;
    if (entry.type !== 'user' || entry.isMeta !== true) continue;
    const content = entry.message?.content;
    const texts = typeof content === 'string' ? [content] : (content ?? []).map((c) => c?.text ?? '');
    for (const t of texts) {
      const begin = t.indexOf('PROBE-BEGIN\n');
      const end = t.indexOf('\nPROBE-END', begin);
      if (begin >= 0 && end >= 0) return { version, expanded: t.slice(begin + 'PROBE-BEGIN\n'.length, end) };
    }
  }
  throw new Error(`${transcript} holds no complete command expansion`);
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'claude-substitution-probe-'));
const pluginDir = join(root, 'plugin');
mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
mkdirSync(join(pluginDir, 'commands'));
writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '0.0.0' }));
for (const [name, { argument_names: names, body }] of Object.entries(fixture.commands)) {
  const frontmatter = ['description: substitution probe', ...(names.length ? [`arguments: [${names.join(', ')}]`] : [])];
  writeFileSync(join(pluginDir, 'commands', `${name}.md`),
    `---\n${frontmatter.join('\n')}\n---\nReply with the single word OK. Do not use any tools.\n\nPROBE-BEGIN\n${body}\nPROBE-END\n`);
}

let version = null;
const cells = [];
let differ = 0;
const projectDirs = new Set();
try {
  for (const cell of fixture.cells) {
    const prompt = `/${PLUGIN}:${cell.command}${cell.args === '' ? '' : ` ${cell.args}`}`;
    // Chosen here, so the transcript can be found and removed however the call ends.
    const sessionId = randomUUID();
    try {
      const r = spawnSync('claude', [
        '-p', '--model', 'haiku', '--plugin-dir', pluginDir, '--settings', '{"disableAllHooks":true}',
        '--session-id', sessionId, '--tools', '', '--output-format', 'json', prompt,
      ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) throw new Error(`claude exited ${r.status} for ${JSON.stringify(cell.args)}: ${r.stderr}`);
      const transcript = transcriptOf(sessionId);
      if (!transcript) throw new Error(`no transcript for session ${sessionId} under ${PROJECTS}`);
      const measured = readTranscript(transcript);
      const { expanded } = measured;
      version ??= measured.version;
      cells.push({ ...cell, expanded });
      const same = expanded === cell.expanded;
      if (!same) differ += 1;
      process.stdout.write(`${same ? 'same   ' : 'DIFFERS'} /${cell.command} ${JSON.stringify(cell.args)}\n`);
      if (!same) process.stdout.write(`  recorded: ${JSON.stringify(cell.expanded)}\n  measured: ${JSON.stringify(expanded)}\n`);
    } finally {
      const transcript = transcriptOf(sessionId);
      if (transcript) {
        projectDirs.add(dirname(transcript));
        rmSync(transcript, { force: true });
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  // Claude names a project directory after the working directory; the random
  // suffix of this run's temporary root makes the one it created ours alone.
  for (const dir of projectDirs) {
    if (basename(dir).endsWith(basename(root))) rmSync(dir, { recursive: true, force: true });
  }
}

process.stdout.write(`\n${differ} of ${cells.length} cells differ from the ${fixture.claude_version} record (measured on ${version}).\n`);
if (process.argv.includes('--write')) {
  writeFileSync(FIXTURE, `${JSON.stringify({
    ...fixture, claude_version: version, measured_at: new Date().toISOString().slice(0, 10), cells,
  }, null, 2)}\n`);
  process.stdout.write(`wrote ${FIXTURE}\n`);
}
process.exitCode = differ === 0 ? 0 : 1;
