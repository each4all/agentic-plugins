// tests/orchestrator/test-autopilot-events-recipe.mjs
//
// ADR-0068 Decision 4, item 6 — the Monitor recipe in
// plugins/orchestrator/commands/autopilot.md: the pattern a session that
// narrows the reader's lines must keep matches every kind marked terminal
// and every `reader-` kind (taken from events.mjs, not retyped), run as
// written by a real shell and grep, each line passed on as it comes; the
// recipe arms Monitor at its 30-minute maximum, re-arms it from the last
// line's identity, and never from a `reader-error`'s cursor.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const E = await import(resolve(AP, 'events.mjs'));
const DOC = readFileSync(resolve(REPO_ROOT, 'plugins/orchestrator/commands/autopilot.md'), 'utf8');

// The section, and the one filter it documents (the fenced block after
// "keeps every line the pattern"): a shell command line.
const section = () => {
  const at = DOC.indexOf('## Watching a run');
  ok(at !== -1, 'commands/autopilot.md has its Watching a run section');
  const end = DOC.indexOf('\n## ', at + 1);
  return DOC.slice(at, end === -1 ? undefined : end);
};
const filter = () => {
  const m = /keeps every line the pattern[\s\S]*?```text\n([^\n]+)\n```/.exec(section());
  ok(m, 'the section documents its filter in a text block');
  return m[1];
};
// The filter run by sh, as a session pipes the reader into it: the first
// line it passes on (before its input ends, so a block-buffered grep never
// shows it), then everything it passes on once its input ends.
async function runFilter(command, first, rest) {
  const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let got = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const early = new Promise((res) => {
    const timer = setTimeout(() => res(null), 5000);
    child.stdout.on('data', (d) => {
      got += d;
      if (got.includes('\n')) { clearTimeout(timer); res(got); }
    });
  });
  child.stdin.write(`${first}\n`);
  const before = await early;
  child.stdin.end(rest.map((l) => `${l}\n`).join(''));
  const code = await new Promise((res) => { child.on('close', res); });
  return { before, all: got.split('\n').filter(Boolean), code, stderr };
}

describe('the Monitor recipe (ADR-0068 Decision 4, item 6)', () => {
  it('the documented pattern matches a line of every terminal kind and every reader- kind, as the writer and the reader print them, run as written by sh and grep, each line as it comes', async () => {
    const terminal = E.TERMINAL_KINDS.map((kind) => JSON.stringify({ schema: E.EVENT_SCHEMA, run_id: 'autopilot-20261019T090000Z-aaaaaa', seq: 3, at: '2026-10-19T09:00:00.000Z', kind, macro_id: null, subtask_id: null, terminal: true }));
    const reader = E.READER_KINDS.map((kind) => JSON.stringify({ schema: E.READER_SCHEMA, kind, at: '2026-10-19T09:00:00.000Z', cursor: 'autopilot-20261019T090000Z-aaaaaa:2' }));
    // Not every line: the pattern narrows.
    const other = JSON.stringify({ schema: E.EVENT_SCHEMA, kind: 'lane-held' });
    const [first, ...kept] = [...reader, ...terminal];
    const r = await runFilter(filter(), first, [other, ...kept]);
    strictEqual(r.stderr, '', 'the shell and grep take the command as written');
    strictEqual(r.code, 0);
    strictEqual(r.before, `${first}\n`, 'the first matching line is passed on before the input ends');
    deepStrictEqual(r.all, [first, ...kept], 'every terminal and reader- line kept, in order, and nothing else');
  });

  it('arms Monitor at its 30-minute maximum with the printed cursor, and re-arms from the last line\'s identity, across a relaunch and a restart', () => {
    const s = section();
    ok(s.includes('`timeout_ms` 1800000'), 'Monitor\'s maximum, 30 minutes');
    ok(s.includes('--after <run-id>:0 --follow'), 'armed with the cursor the run printed');
    ok(/re-arm it with the\s+cursor of the last line it received/.test(s), 're-armed from the last line');
    ok(/`cursor`/.test(s) && /`<run_id>:<seq>`/.test(s), 'an event\'s identity, or a reader line\'s cursor');
    ok(/every\s+run\s+of\s+the\s+macro\s+not\s+seen\s+end/.test(s), 'after a restart, every run not seen end');
    strictEqual((s.match(/--args-file/g) ?? []).length >= 1, true, 'through the args file (ADR-0059)');
  });

  it('the watch block, run as written, hands the session a refusal the CLI prints before the reader starts (a reused args directory): on its output, exit 1', () => {
    const m = /Run the block below with Monitor[\s\S]*?```bash\n([\s\S]*?)```/.exec(section());
    ok(m, 'the section documents the watch block');
    // A re-arm that reuses the directory the CLI removed after the first arm.
    const block = m[1].replace(/^ARGS_DIR='[^']*'$/m, `ARGS_DIR='${join(tmpdir(), 'agentic-args.gone-0000')}'`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
    const r = spawnSync('bash', ['-c', block], { encoding: 'utf8', env: { ...env, AGENTIC_HOST: 'claude', AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator') } });
    strictEqual(r.status, 1, r.stdout + r.stderr);
    ok(/args/i.test(r.stdout) && r.stdout.trim() !== '', `the refusal reaches the block's output: ${JSON.stringify(r.stdout)}`);
    strictEqual(r.stderr, '', 'nothing is left on stderr, which a Monitor does not show');
  });

  it('each re-arm takes a new args directory, and an exit 1 with no reader line is a reader-error: never the same arguments again', () => {
    const s = section().replace(/\s+/g, ' ');
    ok(/every arm, and every re-arm below, takes a new one/.test(s), 'a new args directory per arm');
    ok(/Each re-arm is steps 1 and 2 again, with a new args directory/.test(s), 'step 4 names it');
    ok(/An exit 1 with no reader line \(the CLI refused before the reader started: what it printed says why\) counts as a `reader-error`: never re-arm the same arguments/.test(s), 'an early refusal is a reader-error');
  });

  it('after a reader-error, never re-arms from its cursor: from <run-id>:0 of each run not seen end once, then the owner', () => {
    const s = section().replace(/\s+/g, ' ');
    ok(/for any cause other than a `reader-error`, re-arm it with the cursor of the last line it received/.test(s), 'the last line\'s cursor, but for a reader-error');
    ok(/After a `reader-error` \(the reader exits 1\), never re-arm from its `cursor`/.test(s), 'never from the failing cursor');
    ok(/re-arm once with `--after <run-id>:0` for every run of the macro not seen end/.test(s), 'from each run\'s start, once');
    ok(/ends in a `reader-error` too, stop re-arming and report it to the owner/.test(s), 'then the owner');
  });
});
