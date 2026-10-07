// Runbook shell portability — what a runbook asks of the shell must hold in
// the operator's actual shell, not only in bash.
//
// WHY THIS EXISTS. Four command runbooks guarded their unquoted argument
// expansion with `set -f`. Measured 2026-09-09: that form does not set
// `noglob` under zsh —
//
//   zsh  -c 'set -f; setopt | grep -c noglob'   → 0
//   zsh  -c 'set -f;    node … A냐 B냐?'         → zsh: no matches found: B냐?
//   bash -c 'set -f;    node … A냐 B냐?'         → ["A냐","B냐?"]
//   zsh  -c 'set -o noglob; node … A냐 B냐?'     → ["A냐","B냐?"]
//
// so the guard was inert on a zsh default shell while passing every review
// in bash. The spelling assertions below still hold every runbook to the
// portable form.
//
// ADR-0059 then removed the splice the guard protected: typed text reaches a
// CLI through an args file the model writes, and no runbook line holds it. A
// guard with nothing to guard protects nothing, so this file's assertion that
// "at least one runbook still carries a globbing guard" — which would have
// blocked that change — is replaced by assertions on the transport that took
// the splice's place (Decision 8).
//
// ADR-0059 first removed the file with a shell trap at the top of each block.
// Codex's exec policy refuses that trap's `rm -f`, and an owner's
// `Bash(rm:*)` ask rule stops a runbook `rm` in Claude, so since the
// amendment of 2026-09-29 the reading CLI removes the file and its directory
// itself (lib/args-file.mjs, "Removing what was read"). The checks are now:
//
//   - every block that reads an args file opens with the ARGS_DIR assignment;
//   - no block installs a shell cleanup for it;
//   - the block, run by sh, bash, zsh and dash, leaves no directory behind
//     when the reader succeeds, when it rejects the text and when the file is
//     not valid JSON, and its status is the reader's;
//   - the one gap is stated as a test: a block that exits before the reader
//     runs leaves the directory (one small file under the temporary directory).
//
// A shell that is not installed — zsh on the CI image, dash on some macOS
// machines — is reported as skipped rather than passed.

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

/** Every markdown file shipped by any plugin. */
function runbooks(dir = PLUGINS_DIR, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) runbooks(p, acc);
    else if (entry.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// An executable line, not prose: the guard as the shell would see it.
// Anchored at line start (allowing indentation) and nothing after it, so
// a comment *mentioning* `set -f` is correctly not a hit.
const EXECUTABLE_SET_F = /^[ \t]*set [-+]f[ \t]*$/;
const NOGLOB_ON = /^[ \t]*set -o noglob[ \t]*$/;
const NOGLOB_OFF = /^[ \t]*set \+o noglob[ \t]*$/;

// The transport's opening line (ADR-0059). Its placeholder differs between a
// command runbook and a Codex skill.
const ARGS_DIR_LINE = /^ARGS_DIR='<[^'>]+>'$/;
const PASSES_ARGS_FILE = '--args-file "$ARGS_DIR/args.json"';
// A block that shows the resolve call inside the decide runbook's own block
// rather than being run on its own.
const ILLUSTRATIONS = new Set(['plugins/designer/commands/start.md']);

/** The fenced blocks of a markdown file, as arrays of lines with their indent removed. */
function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    if (open === null) {
      if (fence) open = { indent: fence[1].length, marker: fence[2], lines: [] };
      continue;
    }
    if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && fence[3].trim() === '') {
      blocks.push(open.lines);
      open = null;
      continue;
    }
    open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
  }
  return blocks;
}

const FILES = runbooks();

test('runbook shell portability', async (t) => {
  await t.test('the corpus is not empty (guards a vacuous pass)', () => {
    ok(FILES.length > 0, 'no plugin markdown was discovered at all');
  });

  await t.test('no runbook uses the bash-only `set -f` / `set +f` form', () => {
    // Contract: the operator's shell runs the block — under zsh `set -f` leaves
    // globbing on, so an unquoted `?` or `*` fails "no matches found" (above).
    const offenders = [];
    for (const f of FILES) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (EXECUTABLE_SET_F.test(line)) offenders.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
      });
    }
    strictEqual(offenders.length, 0,
      `\`set -f\`/\`set +f\` does not set noglob under zsh; use \`set -o noglob\`/\`set +o noglob\`:\n  ${offenders.join('\n  ')}`);
  });

  await t.test('every globbing guard is restored in the same file', () => {
    // Contract: the shell running the runbook — a `set -o noglob` never undone
    // leaves globbing off for every later line that shell runs.
    const unbalanced = [];
    for (const f of FILES) {
      const lines = readFileSync(f, 'utf8').split('\n');
      const on = lines.filter((l) => NOGLOB_ON.test(l)).length;
      const off = lines.filter((l) => NOGLOB_OFF.test(l)).length;
      if (on !== off) unbalanced.push(`${rel(f)}: ${on} × 'set -o noglob' vs ${off} × 'set +o noglob'`);
    }
    strictEqual(unbalanced.length, 0,
      `a runbook disables globbing without restoring it:\n  ${unbalanced.join('\n  ')}`);
  });
});

test('args-file transport (ADR-0059 Decision 8, amended 2026-09-29)', async (t) => {
  const readers = [];
  const trapLines = [];
  for (const f of FILES) {
    for (const block of fencedBlocks(readFileSync(f, 'utf8'))) {
      for (const line of block) if (/(^|[;&|\s])trap\s/.test(line) && line.includes('ARGS_DIR')) trapLines.push(`${rel(f)}: ${line.trim()}`);
      if (block.some((l) => l.includes(PASSES_ARGS_FILE))) readers.push({ file: rel(f), block });
    }
  }

  await t.test('the transport is in use (guards a vacuous pass)', () => {
    // Identity, not a count: the runbooks the splice was removed from.
    const files = new Set(readers.map((r) => r.file));
    for (const f of ['plugins/engineer/commands/start.md', 'plugins/engineer/commands/decide.md', 'plugins/runtime/commands/context.md']) {
      ok(files.has(f), `${f} does not read an args file`);
    }
  });

  await t.test('every block that reads an args file opens with the ARGS_DIR assignment', () => {
    // Contract: the agent runs the block after writing args.json into the
    // directory mktemp printed — a block that does not set ARGS_DIR first hands
    // the reader "/args.json", or a directory the model never wrote.
    const offenders = [];
    for (const { file, block } of readers) {
      if (ILLUSTRATIONS.has(file)) continue;
      const code = block.filter((l) => l.trim() !== '');
      if (!ARGS_DIR_LINE.test(code[0] ?? '')) offenders.push(`${file}: ${JSON.stringify(code[0])}`);
    }
    deepStrictEqual(offenders, [], 'the block must start by naming the directory the model wrote into');
  });

  await t.test('no block installs a shell cleanup: the reading CLI removes the file', () => {
    // Contract: Codex's exec policy and an owner's `Bash(rm:*)` ask rule — a
    // trap's `rm` makes `codex exec` refuse the block and stops a headless run.
    deepStrictEqual(trapLines, [], 'a trap here runs `rm`, which Codex refuses and an rm ask rule stops (C74)');
  });

  // The block as a runbook shows it, run by each shell: the reader removes the
  // file and the directory, on success and when it rejects what it read, and
  // the block's status is the reader's.
  const START_ARGS = join(PLUGINS_DIR, 'engineer', 'scripts', 'start-args.mjs');
  const shells = ['sh', 'bash', 'zsh', 'dash'];
  for (const shell of shells) {
    const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
    await t.test(`${shell}: the reader removes the directory and the block keeps its status`, { skip: available ? false : `${shell} is not installed` }, () => {
      const scenarios = [
        { name: 'the reader succeeds', text: '{"agentic_args":1,"text":"add a flag"}\n', status: 0 },
        { name: 'the reader rejects the text', text: '{"agentic_args":1,"text":"x --base-branch=main"}\n', status: 2 },
        { name: 'the file is not valid JSON', text: '{', status: 2 },
      ];
      for (const s of scenarios) {
        const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
        const cwd = mkdtempSync(join(tmpdir(), 'agentic-args-cwd.'));
        writeFileSync(join(dir, 'args.json'), s.text);
        try {
          const script = `ARGS_DIR='${dir}'\nnode '${START_ARGS}' --args-file "$ARGS_DIR/args.json" >/dev/null\n`;
          const r = spawnSync(shell, ['-c', script], { cwd, encoding: 'utf8' });
          strictEqual(r.status, s.status, `${shell} / ${s.name}: status ${r.status}, stderr ${r.stderr}`);
          ok(!existsSync(dir), `${shell} / ${s.name}: the directory survived`);
          deepStrictEqual(readdirSync(cwd), [], `${shell} / ${s.name}: the block wrote into its working directory`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    });
  }

  await t.test('the gap that remains: a block that exits before the reader runs leaves the directory', () => {
    // Stated, not closed (ADR-0059 (f) as amended): it holds one small file
    // under the temporary directory.
    const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
    writeFileSync(join(dir, 'args.json'), '{"agentic_args":1,"text":""}\n');
    try {
      const r = spawnSync('sh', ['-c', `ARGS_DIR='${dir}'\nexit 3\nnode '${START_ARGS}' --args-file "$ARGS_DIR/args.json"\n`], { encoding: 'utf8' });
      strictEqual(r.status, 3);
      ok(existsSync(join(dir, 'args.json')), 'the early exit removed the file, so this test no longer describes the gap');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
