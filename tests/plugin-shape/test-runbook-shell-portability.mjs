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
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// A Codex skill mention runs its block in a fresh shell, where nothing a Claude
// command's earlier line set exists. Measured 2026-10-17 (C78): eight runtime
// skills passed `--repo-root "$REPO_ROOT"` without defining it, so each CLI got
// `--repo-root ""`. A runtime skill shows three kinds of fenced block: a usage
// synopsis first (`[--option]` forms, not run), `$runtime:<command>` mention
// examples, and the block the agent runs. That last one is run here as written,
// by sh, bash and zsh with unset variables an error, against a stub plugin root
// that records the argv each script receives.
const RUNTIME_SKILLS = ['bootstrap', 'consensus', 'context', 'dashboard', 'doctor', 'migrate', 'retention', 'settings', 'worktree'];
const SKILL_PLUGIN_ROOT = '<runtime-plugin-root>';
const SKILL_ARGS_DIR_LINE = "ARGS_DIR='<directory mktemp printed>'";
const MENTION_LINE = /^[$/][a-z-]+:[a-z-]+(\s|$)/;

/**
 * 'synopsis', 'mention' or 'runnable', from what the block's lines are. Only
 * the first block can be the synopsis: a later block that happens to show a
 * `[-` is run like any other.
 */
function skillBlockKind(lines, index) {
  const code = lines.filter((l) => l.trim() !== '');
  if (code.length > 0 && code.every((l) => MENTION_LINE.test(l))) return 'mention';
  if (index === 0 && code.length > 0 && code.every((l) => l.startsWith(`node "${SKILL_PLUGIN_ROOT}/scripts/`)) && code.some((l) => l.includes(' [-'))) return 'synopsis';
  return 'runnable';
}

test('runtime Codex skills: each runnable block defines what it reads (C78)', async (t) => {
  const skills = RUNTIME_SKILLS.map((name) => {
    const blocks = fencedBlocks(readFileSync(join(PLUGINS_DIR, 'runtime', 'core', 'skills', name, 'SKILL.md'), 'utf8'));
    const kinds = blocks.map(skillBlockKind);
    return { name, kinds, runnable: blocks.filter((_, i) => kinds[i] === 'runnable') };
  });

  await t.test('each skill opens with a synopsis and has one runnable block, the args-file one', () => {
    // Identity, not a count: a skill whose block this no longer tells apart
    // is one the runs below would skip.
    deepStrictEqual(readdirSync(join(PLUGINS_DIR, 'runtime', 'core', 'skills')).sort(), RUNTIME_SKILLS, 'a runtime skill was added or removed; list it here');
    for (const { name, kinds, runnable } of skills) {
      strictEqual(kinds[0], 'synopsis', `${name}: the first block is not a synopsis (${kinds.join(', ')})`);
      strictEqual(runnable.length, 1, `${name}: ${runnable.length} runnable blocks (${kinds.join(', ')})`);
      strictEqual(runnable[0].find((l) => l.trim() !== ''), SKILL_ARGS_DIR_LINE, `${name}: the runnable block does not open with the ARGS_DIR line`);
    }
  });

  await t.test('a block that passes $REPO_ROOT defines it as the matching command does', () => {
    // Contract: the runtime CLI's --repo-root — the Claude command and the Codex
    // skill resolve the same repository from the same working directory.
    const readers = skills.filter(({ runnable }) => runnable[0].some((l) => l.includes('"$REPO_ROOT"')));
    deepStrictEqual(readers.map((s) => s.name), RUNTIME_SKILLS.filter((n) => n !== 'bootstrap'));
    for (const { name, runnable } of readers) {
      const command = readFileSync(join(PLUGINS_DIR, 'runtime', 'commands', `${name}.md`), 'utf8').split('\n').filter((l) => l.startsWith('REPO_ROOT='));
      strictEqual(command.length, 1, `${name}: the command defines REPO_ROOT ${command.length} times`);
      deepStrictEqual(runnable[0].filter((l) => l.startsWith('REPO_ROOT=')), command, `${name}: the skill does not define REPO_ROOT as commands/${name}.md does`);
    }
  });

  for (const shell of ['sh', 'bash', 'zsh']) {
    const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
    await t.test(`${shell} -u: the block runs, and each script gets the repository root and the args file`, { skip: available ? false : `${shell} is not installed` }, () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-c78.')));
      // Only what a fresh shell is sure to have, so `-u` stops on any variable
      // the block reads without setting; git looks no higher than the scratch
      // directory, so the plain directory below is outside every repository.
      const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? scratch, GIT_CEILING_DIRECTORIES: scratch };
      try {
        // A repository whose root differs from the working directory: a block
        // that passed `pwd`, or nothing, is told apart from one that asked git.
        // Outside a repository the block falls back to the working directory.
        const repo = join(scratch, 'repo');
        const plain = join(scratch, 'plain');
        mkdirSync(join(repo, 'sub'), { recursive: true });
        mkdirSync(plain);
        strictEqual(spawnSync('git', ['init', '-q', repo], { env }).status, 0, 'git init failed');
        const stub = join(scratch, 'runtime');
        mkdirSync(join(stub, 'scripts'), { recursive: true });
        for (const { name, runnable } of skills) {
          const block = runnable[0].join('\n');
          const script = block.match(/\/scripts\/([a-z-]+)\.mjs"/)[1];
          writeFileSync(join(stub, 'scripts', `${script}.mjs`), "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.C78_ARGV, JSON.stringify(process.argv.slice(2)));\n");
          for (const [cwd, root] of [[join(repo, 'sub'), repo], [plain, plain]]) {
            const argsDir = mkdtempSync(join(scratch, 'args.'));
            const out = join(scratch, `${name}-${shell}.json`);
            const source = `${block.replace(SKILL_ARGS_DIR_LINE, `ARGS_DIR='${argsDir}'`).split(`"${SKILL_PLUGIN_ROOT}/`).join(`"${stub}/`)}\n`;
            const r = spawnSync(shell, ['-u', '-c', source], { cwd, encoding: 'utf8', env: { ...env, C78_ARGV: out } });
            strictEqual(r.status, 0, `${shell} / ${name} in ${cwd}: status ${r.status}, stderr ${r.stderr}`);
            const argv = JSON.parse(readFileSync(out, 'utf8'));
            ok(argv.includes('--args-file'), `${shell} / ${name}: no --args-file in ${JSON.stringify(argv)}`);
            strictEqual(argv[argv.indexOf('--args-file') + 1], `${argsDir}/args.json`, `${shell} / ${name}: ${JSON.stringify(argv)}`);
            // Every runtime CLI but bootstrap's takes the repository root.
            strictEqual(argv.includes('--repo-root'), name !== 'bootstrap', `${shell} / ${name}: --repo-root in ${JSON.stringify(argv)}`);
            if (name !== 'bootstrap') {
              strictEqual(argv[argv.indexOf('--repo-root') + 1], root, `${shell} / ${name} in ${cwd}: ${JSON.stringify(argv)}`);
            }
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});

// Docket C68 — the orchestrator's JSON readers, as the runbooks spell them,
// under every shell a block may run in. Measured 2026-10-17: `echo "$X" | node`
// turned a `\n` inside a JSON string into a raw newline under zsh and macOS
// /bin/sh (xpg_echo), and JSON.parse refused it; a reader that parsed each
// stdin chunk alone returned nothing, exit 0, for a document past a pipe's
// 64 KiB; and a reader that swallowed its parse error read a malformed
// document as an empty value; and one that appended each chunk as it came
// decoded a character a chunk boundary split into two replacement characters
// (Review finding). The readers below hand the document over with printf,
// decode it as UTF-8 across chunks, read it whole, and fail on a document that
// does not parse.
test('orchestrator JSON readers (C68)', async (t) => {
  const ORCH_DIR = join(PLUGINS_DIR, 'orchestrator');
  const handoff = readFileSync(join(ORCH_DIR, 'core/skills/_shared/references/session-handoff.md'), 'utf8').split('\n');
  const next = readFileSync(join(ORCH_DIR, 'commands/next.md'), 'utf8').split('\n');
  // Contract: the lines the agent runs — renamed, they must fail here, not run nothing.
  const status = handoff.find((l) => l.startsWith('STATUS="$(printf'));
  const routing = handoff.find((l) => l.startsWith('ROUTING="$(printf'));
  const field = next.find((l) => l.startsWith('JSON_FIELD='));
  ok(status && routing && field, 'the handoff reference reads STATUS and ROUTING, and next.md has its JSON_FIELD reader');
  // Critique H6 — every JSON_FIELD reader of the orchestrator's runbooks and
  // skills is the one tested below, byte for byte: a copy that drifted (its
  // UTF-8 decoding dropped, its parse error swallowed) fails here.
  await t.test('every JSON_FIELD reader in the orchestrator is the tested one', () => {
    const copies = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.md')) {
          readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*JSON_FIELD=/.test(line)) copies.push([`${relative(ORCH_DIR, path)}:${i + 1}`, line.trim()]);
          });
        }
      }
    };
    walk(ORCH_DIR);
    // The readers the runbooks carry: next.md's own, and those of next, done
    // and peer-now on both hosts.
    for (const file of ['commands/next.md', 'commands/done.md', 'commands/peer-now.md', 'core/skills/next/SKILL.md', 'core/skills/done/SKILL.md', 'core/skills/peer-now/SKILL.md']) {
      ok(copies.some(([where]) => where.startsWith(`${file}:`)), `${file} carries a JSON_FIELD reader`);
    }
    deepStrictEqual(copies.filter(([, line]) => line !== field), [], 'each JSON_FIELD reader is the tested one');
  });
  // Two-byte characters past every 64 KiB boundary, at both parities, so a
  // boundary splits one of them in one of the two documents.
  const values = ['', 'x'].map((pad) => `/orchestrator:next line one\nline \\ two "quoted" ${pad}${'é'.repeat(40000)}`);
  for (const shell of ['sh', 'bash', 'zsh', 'dash']) {
    const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
    await t.test(`${shell}: a document with escapes, past 64 KiB, reads whole; a malformed one fails the reader`, { skip: available ? false : `${shell} is not installed` }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentic-c68.'));
      try {
       for (const value of values) {
        const file = join(dir, 'doc.json');
        writeFileSync(file, JSON.stringify({ status: 'ok', routing: value, topic: value }, null, 2));
        const read = spawnSync(shell, ['-c', [
          `HANDOFF="$(cat '${file}')"`, status, routing,
          `printf '%s' "$ROUTING" > '${dir}/routing.out'`,
          field, `JSON_KEY=topic node -e "$JSON_FIELD" < '${file}' > '${dir}/topic.out' || exit 1`,
          'printf "%s" "$STATUS"',
        ].join('\n')], { encoding: 'utf8' });
        strictEqual(read.status, 0, `${shell}: ${read.stderr}`);
        strictEqual(read.stdout, 'ok');
        strictEqual(readFileSync(join(dir, 'routing.out'), 'utf8'), value, `${shell}: ROUTING is the value, byte for byte`);
        strictEqual(readFileSync(join(dir, 'topic.out'), 'utf8'), value, `${shell}: JSON_FIELD reads the value, byte for byte`);
       }
        for (const reader of [status, `${field}\nprintf '%s' "$HANDOFF" | JSON_KEY=status node -e "$JSON_FIELD" || exit 1`]) {
          const bad = spawnSync(shell, ['-c', `HANDOFF='{"status": "ok", "routing": "cut'\n${reader}\necho READ`], { encoding: 'utf8' });
          notStrictEqual(bad.status, 0, `${shell}: a malformed document fails the reader`);
          ok(!bad.stdout.includes('READ'), `${shell}: the block stops`);
          ok(/SyntaxError/.test(bad.stderr), `${shell}: the parser's error is shown: ${bad.stderr}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
