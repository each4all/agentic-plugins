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
// the splice's place (Decision 8):
//
//   - every block that reads an args file installs its cleanup before
//     anything else, so every exit path of the block runs it;
//   - the cleanup is the same single line everywhere;
//   - that line, taken from the runbooks and run by sh, bash, zsh and dash, removes
//     the directory on success, on failure, on an early exit and on a hangup,
//     interrupt or termination signal (each turned into an exit with the
//     conventional 128+n status), keeps the command's exit status in every
//     other case, and warns — still keeping the status, even under `set -e` —
//     when the file or the directory cannot be removed. A naive
//     `cmd; rm -f "$F"` would return rm's status instead. SIGKILL cannot be
//     caught; nothing here claims it.
//
// A shell that is not installed — zsh on the CI image, dash on some macOS
// machines — is reported as skipped rather than passed. The trap semantics
// these checks depend on are POSIX, which sh and bash exercise on every
// runner; all four shells were measured with the same scenarios on
// 2026-09-29 (macOS) and behaved alike.

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

// The transport's two opening lines (ADR-0059). The directory assignment's
// placeholder differs between a command runbook and a Codex skill; the trap
// line does not.
const ARGS_DIR_LINE = /^ARGS_DIR='<[^'>]+>'$/;
const TRAP_LINE = `trap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo "⚠ could not remove $ARGS_DIR" >&2' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM`;
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

test('args-file transport (ADR-0059 Decision 8)', async (t) => {
  const readers = [];
  const trapLines = new Set();
  for (const f of FILES) {
    for (const block of fencedBlocks(readFileSync(f, 'utf8'))) {
      for (const line of block) if (line.trimStart().startsWith("trap '") && line.includes('ARGS_DIR')) trapLines.add(line.trim());
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

  await t.test('every block that reads an args file installs its cleanup first', () => {
    const offenders = [];
    for (const { file, block } of readers) {
      if (ILLUSTRATIONS.has(file)) continue;
      const code = block.filter((l) => l.trim() !== '');
      if (!ARGS_DIR_LINE.test(code[0] ?? '') || code[1] !== TRAP_LINE) offenders.push(`${file}: ${JSON.stringify(code.slice(0, 2))}`);
    }
    deepStrictEqual(offenders, [], 'the trap must follow the ARGS_DIR assignment before any line that can exit');
  });

  await t.test('the cleanup is one line, the same everywhere', () => {
    deepStrictEqual([...trapLines], [TRAP_LINE]);
  });

  const shells = ['sh', 'bash', 'zsh', 'dash'];
  for (const shell of shells) {
    const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
    await t.test(`${shell}: the cleanup removes the directory on every exit and keeps the status`, { skip: available ? false : `${shell} is not installed` }, () => {
      const scenarios = [
        { name: 'success', body: 'node -e "process.exit(0)"', status: 0 },
        { name: 'the command fails', body: 'node -e "process.exit(7)"', status: 7 },
        { name: 'an early exit', body: 'exit 3\nnode -e 0', status: 3 },
        { name: 'a later command decides the status', body: 'node -e "process.exit(5)"\nRC=$?\n[ "$RC" -eq 5 ] && exit 42', status: 42 },
        { name: 'the directory cannot be removed', body: 'touch "$ARGS_DIR/extra"\nnode -e "process.exit(9)"', status: 9, stays: true },
        { name: 'the file cannot be removed, under set -e', body: 'set -e\nrm -f "$ARGS_DIR/args.json"\nmkdir "$ARGS_DIR/args.json"\nnode -e "process.exit(7)"', status: 7, stays: true },
        { name: 'a termination signal', body: 'kill -TERM $$\nsleep 5', status: 143 },
        { name: 'an interrupt', body: 'kill -INT $$\nsleep 5', status: 130 },
        { name: 'a hangup', body: 'kill -HUP $$\nsleep 5', status: 129 },
      ];
      for (const s of scenarios) {
        const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
        const cwd = mkdtempSync(join(tmpdir(), 'agentic-args-cwd.'));
        writeFileSync(join(dir, 'args.json'), '{"agentic_args":1,"text":""}\n');
        try {
          const script = `ARGS_DIR='${dir}'\n${TRAP_LINE}\n${s.body}\n`;
          const r = spawnSync(shell, ['-c', script], { cwd, encoding: 'utf8' });
          strictEqual(r.status, s.status, `${shell} / ${s.name}: status ${r.status}, stderr ${r.stderr}`);
          if (!s.stays) ok(!existsSync(join(dir, 'args.json')), `${shell} / ${s.name}: the args file survived`);
          if (s.stays) {
            ok(existsSync(dir), `${shell} / ${s.name}: the scenario did not stop the removal`);
            ok(r.stderr.includes('could not remove'), `${shell} / ${s.name}: no warning`);
          } else {
            ok(!existsSync(dir), `${shell} / ${s.name}: the directory survived`);
          }
          deepStrictEqual(readdirSync(cwd), [], `${shell} / ${s.name}: the block wrote into its working directory`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    });
  }

  await t.test('control: the naive cleanup this replaces does lose the status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
    try {
      const r = spawnSync('sh', ['-c', `node -e "process.exit(7)"; rm -rf -- '${dir}'`], { cwd: dir });
      strictEqual(r.status, 0, 'the naive form kept the status — the scenarios above would not tell the forms apart');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
