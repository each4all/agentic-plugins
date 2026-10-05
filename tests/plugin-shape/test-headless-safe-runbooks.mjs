// Headless-safe runbooks (ADR-0063 S0) — two rules every plugin runbook keeps.
//
// WHY THIS EXISTS. Autopilot workers run runbooks in `claude -p` sessions, and
// two things in the runbooks' shell blocks broke them (evidence:
// docs/assurance/evidence/autopilot-probes-2026-09-24/PROBES.md).
//
//   1. `rm`. An owner's user-level `permissions.ask: ["Bash(rm:*)"]` denies a
//      matching command outright in a headless run (W2–W5, R1/R2) and prompts
//      for it in an interactive one. Measured 2026-09-29 with Claude Code
//      2.1.284: a direct `rm -f` was denied; an `rm` inside a quoted `trap`
//      string was not matched. Codex's exec policy is stricter: it parses a
//      trap's action as shell source and classifies any `rm` with a force flag
//      as dangerous, which `codex exec` refuses (docket C74; rust-v0.158.0
//      shell-command is_dangerous_command.rs + core exec_policy.rs). So no
//      fenced block in any plugin markdown may run `rm` or `rmdir` — quoted
//      or not. Temporary files are either not written (stderr passes
//      through; the decide context is printed), or removed by the program
//      that owns them (the args-file reader).
//
//   2. The plugin root. `$CLAUDE_PLUGIN_ROOT` is not set in a Bash tool call,
//      and runbooks used to tell the model to find the plugin itself; in `-p`
//      runs it guessed a version-less path or decided the plugin was absent
//      (probes B, E5, E6). Claude Code writes the plugin's path into a command
//      body where it reads the braced `${CLAUDE_PLUGIN_ROOT}` — measured with
//      a --plugin-dir probe and with this repository's directory marketplace
//      — so every command block that uses the root opens with
//
//        CLAUDE_PLUGIN_ROOT="${AGENTIC_<PLUGIN>_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
//        [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find … | sort -V | tail -1)"
//
//      (RUNTIME_ROOT in the runtime runbooks): the driver's env override, then
//      the path Claude wrote in, then the newest cached version for a host
//      that writes nothing. Read raw from disk — as /orchestrator:next reads
//      an engineer runbook — the braced form is shell expansion of the
//      variable the dispatcher exported, so the same line still works.
//
// The Codex skills (`core/skills/**/SKILL.md`) keep the root handling #808
// gave them; rule 1 covers them too.

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

/** Every markdown file shipped by any plugin. */
function markdownFiles(dir = PLUGINS_DIR, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) markdownFiles(p, acc);
    else if (entry.endsWith('.md')) acc.push(p);
  }
  return acc;
}

/** Fenced blocks as `{ lang, start, lines }`, indentation removed; `start` is the 1-based line of the first body line. */
function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const fence = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    if (open === null) {
      if (fence) open = { indent: fence[1].length, marker: fence[2], lang: fence[3].trim(), start: i + 2, lines: [] };
      return;
    }
    if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && fence[3].trim() === '') {
      blocks.push(open);
      open = null;
      return;
    }
    open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
  });
  return blocks;
}

// `rm` or `rmdir` as a command word: at a line start or after a shell
// separator, a quote or a brace — which is how it sits inside a quoted trap
// action — and followed by whitespace or the end of the line. Also spelled
// with a directory (`/bin/rm`), quoted (`"rm"`) or escaped (`\rm`). Not
// `--rm`, `confirm`, `fs.rmSync(` or `rm.mjs`. Comment lines are not code.
const RM_COMMAND = /(^|[\s;&|(){}'"`])\\?(?:[\w.-]*\/)*["']?(rm|rmdir)["']?(\s|$)/;
const runsRm = (line) => !line.trimStart().startsWith('#') && RM_COMMAND.test(line);

/**
 * A block's lines joined the way the shell joins them: a line ending in a
 * backslash continues on the next: the shell removes the backslash and the
 * newline and nothing else, so `r\\` followed by `m -f "$X"` runs `rm -f "$X"`
 * (Refine-verify findings, 2026-09-29). Each logical line keeps the index of
 * its first physical line. A comment ends at its newline.
 */
function logicalLines(lines) {
  const out = [];
  let text = null;
  let start = 0;
  lines.forEach((line, i) => {
    if (text === null) start = i;
    const continued = !line.trimStart().startsWith('#') && /\\$/.test(line);
    text = (text ?? '') + (continued ? line.slice(0, -1) : line);
    if (!continued) { out.push({ i: start, text }); text = null; }
  });
  if (text !== null) out.push({ i: start, text });
  return out;
}

const PLUGIN_ROOT_USE = /\$\{?CLAUDE_PLUGIN_ROOT\b/;
const RUNTIME_ROOT_USE = /\$\{?RUNTIME_ROOT\b/;
const isCode = (line) => line.trim() !== '' && !line.trimStart().startsWith('#');

/** The two opening lines a command block of `plugin` must carry. */
function resolverLines(plugin) {
  const v = plugin === 'runtime' ? 'RUNTIME_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  const env = `AGENTIC_${plugin.toUpperCase()}_ROOT`;
  return [
    `${v}="\${${env}:-\${CLAUDE_PLUGIN_ROOT}}"`,
    `[ -n "$${v}" ] || ${v}="$(find ~/.claude/plugins/cache/agentic-plugins/${plugin} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"`,
  ];
}

/**
 * The opening lines a generated persona-pipeline block carries instead
 * (ADR-0066 Decision 4, PC2a DD1): the persona's name reaches the shell only
 * as a single-quoted literal, so the override is read with printenv and the
 * cache path quotes the name. Same resolution order as resolverLines.
 */
const GENERATED_RESOLVER_PLUGINS = new Set(['founder', 'designer']);
function generatedResolverLines(plugin) {
  const env = `AGENTIC_${plugin.toUpperCase()}_ROOT`;
  return [
    `ROOT_OVERRIDE="$(printenv '${env}' || true)"`,
    'CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"',
    resolverLines(plugin)[1].replace(`agentic-plugins/${plugin} `, `agentic-plugins/'${plugin}' `),
  ];
}

/** Every resolver form a block of `plugin` may open with. */
function resolverForms(plugin) {
  return GENERATED_RESOLVER_PLUGINS.has(plugin) ? [resolverLines(plugin), generatedResolverLines(plugin)] : [resolverLines(plugin)];
}

const FILES = markdownFiles();
const COMMAND_FILES = FILES.filter((f) => /^plugins\/[^/]+\/commands\/[^/]+\.md$/.test(rel(f)));

test('the rm detector matches what a shell would run, and nothing else', () => {
  const hits = [
    'rm -f "$FIND_ERR"',
    '  rm -f "$X"; exit 1',
    `trap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo x >&2' EXIT`,
    `trap 'rm -f "$NOTE_FILE"' EXIT`,
    'cat "$E" >&2; rm -f "$E"; exit "$RC"',
    'x && rmdir "$D"',
    'rm',
    '/bin/rm -f "$X"',
    '/usr/bin/rmdir "$D"',
    '"rm" -f "$X"',
    "'rm' -f \"$X\"",
    '\\rm -f "$X"',
    'command rm "$X"',
    'find . -name x -exec rm {} +',
    // A word that names rm is flagged even as an argument: the guard errs
    // toward a false alarm, which a rewording clears, over a missed rm.
    "printf '%s\\n' /bin/rm",
  ];
  const misses = [
    '# rm -f is not used here',
    'docker run --rm image',
    'echo confirm the change',
    "node -e 'require(\"fs\").rmSync(p)'",
    'node "$ROOT/scripts/rm.mjs"',
    'FIRM=1',
    'node "$ROOT/scripts/rm-helper.mjs"',
    'ls /opt/x/rm.d',
  ];
  deepStrictEqual(hits.filter((l) => !runsRm(l)), [], 'a command that runs rm went undetected');
  deepStrictEqual(misses.filter(runsRm), [], 'a line that runs no rm was flagged');
});

test('no fenced block in any plugin markdown runs rm or rmdir', async (t) => {
  await t.test('the corpus is the plugins this rule is about (guards a vacuous pass)', () => {
    // Identity, not a count: files that carried rm before ADR-0063 S0.
    const names = new Set(FILES.map(rel));
    for (const f of [
      'plugins/engineer/commands/start.md',
      'plugins/orchestrator/commands/done.md',
      'plugins/runtime/core/skills/doctor/SKILL.md',
      'plugins/founder/commands/decide.md',
      'plugins/designer/core/skills/decide/SKILL.md',
    ]) ok(names.has(f), `${f} is not in the scanned corpus`);
  });

  await t.test('none does', () => {
    const offenders = [];
    for (const f of FILES) {
      for (const block of fencedBlocks(readFileSync(f, 'utf8'))) {
        logicalLines(block.lines).forEach(({ i, text }) => {
          if (runsRm(text)) offenders.push(`${rel(f)}:${block.start + i}: ${text.trim()}`);
        });
      }
    }
    deepStrictEqual(offenders, [],
      'a runbook `rm` is refused by Codex (with a force flag, even in a trap) and stopped by an rm ask rule in Claude; '
      + 'leave the file unwritten, or let the program that owns it remove it');
  });
});

test('every command block that uses the plugin root resolves it first', async (t) => {
  const checked = [];
  const offenders = [];
  for (const f of COMMAND_FILES) {
    const plugin = rel(f).split('/')[1];
    for (const block of fencedBlocks(readFileSync(f, 'utf8'))) {
      const uses = (l) => isCode(l) && (PLUGIN_ROOT_USE.test(l) || (plugin === 'runtime' && RUNTIME_ROOT_USE.test(l)));
      // The form the block opens with: its first line, then the rest in order.
      const opened = resolverForms(plugin).map((form) => {
        const at = block.lines.findIndex((l) => l.trim() === form[0]);
        const whole = at >= 0 && form.every((line, k) => (block.lines[at + k] ?? '').trim() === line);
        return { at, form, whole };
      }).find((o) => o.at >= 0) ?? { at: -1, form: [], whole: false };
      const own = (i) => opened.at >= 0 && i >= opened.at && i < opened.at + opened.form.length - 1;
      const firstUse = block.lines.findIndex((l, i) => !own(i) && uses(l));
      if (firstUse < 0) continue;
      checked.push(`${rel(f)}:${block.start}`);
      if (opened.at < 0 || opened.at > firstUse || !opened.whole) {
        offenders.push(`${rel(f)}:${block.start + Math.max(firstUse, 0)}: ${block.lines[firstUse].trim()}`);
      }
      // Nothing may reassign the root from the retired fallbacks.
      for (const [i, l] of block.lines.entries()) {
        if (/BASH_SOURCE/.test(l) || /CLAUDE_PLUGIN_ROOT:-\}/.test(l)) offenders.push(`${rel(f)}:${block.start + i}: ${l.trim()}`);
      }
    }
  }

  await t.test('the check reaches the runbooks it is about (guards a vacuous pass)', () => {
    const files = new Set(checked.map((c) => c.split(':')[0]));
    for (const f of [
      'plugins/engineer/commands/refine.md',
      'plugins/orchestrator/commands/next.md',
      'plugins/runtime/commands/doctor.md',
      'plugins/founder/commands/start.md',
      'plugins/designer/commands/decide.md',
      // generated resolver form (persona-pipeline regions, PC2a)
      'plugins/founder/commands/checkpoint.md',
      'plugins/designer/commands/peer-now.md',
      'plugins/image/commands/compose.md',
    ]) ok(files.has(f), `${f} has no block that uses the plugin root`);
  });

  await t.test('each opens with the resolver for its own plugin', () => {
    deepStrictEqual(offenders, [],
      'open the block with its plugin\'s two resolver lines (AGENTIC_<PLUGIN>_ROOT, then the braced '
      + 'CLAUDE_PLUGIN_ROOT Claude Code writes in, then the newest cached version)');
  });
});

test('a command split across lines with a backslash is read as one command', () => {
  const joined = logicalLines(['/bin/rm \\', '  -f "$X"', '# a comment \\', 'echo done', 'r\\', 'm -f "$X"']);
  deepStrictEqual(joined.map((l) => l.i), [0, 2, 3, 4]);
  ok(runsRm(joined[0].text), joined[0].text);
  // The command word itself split: the shell joins `r` and `m` with nothing between.
  strictEqual(joined[3].text, 'rm -f "$X"');
  ok(runsRm(joined[3].text), joined[3].text);
});

test('no plugin markdown picks a cached version with a bare sort -V', () => {
  // Anywhere, prose included: the skills' host tables described the Claude
  // fallback as `find … | sort -V | tail -1`, which ranks a prerelease or a
  // stray directory name above the newest release.
  const offenders = [];
  for (const f of FILES) {
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/sort -V/.test(line) && !line.includes("grep -E '/(0|[1-9][0-9]*)\\.")) offenders.push(`${rel(f)}:${i + 1}`);
    });
  }
  deepStrictEqual(offenders, []);
});

test('no command runbook tells the model to find the plugin root itself', () => {
  const RETIRED = [
    /If unset[^.]*fall\s+back/i,
    /fallback as in\s+commands\//i,
    /Fallback when unset/,
    /Fallback: discover via/,
    /If\s+unset, discover the latest/,
  ];
  const offenders = [];
  for (const f of COMMAND_FILES) {
    const text = readFileSync(f, 'utf8');
    for (const re of RETIRED) if (re.test(text)) offenders.push(`${rel(f)}: ${text.match(re)[0].replace(/\s+/g, ' ')}`);
  }
  deepStrictEqual(offenders, []);
  strictEqual(COMMAND_FILES.length > 0, true, 'no command runbook was discovered');
});

test('the resolver picks the override, then the path Claude writes in, then the newest released cached version', async (t) => {
  // Run as the shell runs it, against plugin caches that hold what `sort -V`
  // alone gets wrong: a prerelease and a stray name rank above the newest
  // release, a leading-zero name is not a version, and build metadata still
  // names a release (Refine-verify findings, 2026-09-29).
  const plugins = [...new Set(COMMAND_FILES.map((f) => rel(f).split('/')[1]))].sort();
  const caches = [
    { entries: ['0.9.0', '0.10.0', '0.10.1-rc.1', 'not-a-version', '09.99.0'], newest: '0.10.0' },
    // Build metadata names a release only when every identifier in it is non-empty.
    { entries: ['1.9.0', '1.10.0+build.1', '2.0.0+build..1', '2.0.0+.', '2.0.0+build.'], newest: '1.10.0+build.1' },
    { entries: ['not-a-version', '1.0.0-rc.1'], newest: null },
  ];
  const homes = caches.map(({ entries }) => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-root-resolver-'));
    for (const plugin of plugins) {
      for (const v of entries) mkdirSync(join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', plugin, v), { recursive: true });
    }
    return home;
  });
  try {
    for (const shell of ['sh', 'bash', 'zsh']) {
      const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
      await t.test(shell, { skip: available ? false : `${shell} is not installed` }, () => {
        for (const plugin of plugins) for (const lines of resolverForms(plugin)) {
          const first = lines.slice(0, -1).join('\n');
          const second = lines[lines.length - 1];
          const v = plugin === 'runtime' ? 'RUNTIME_ROOT' : 'CLAUDE_PLUGIN_ROOT';
          const env = `AGENTIC_${plugin.toUpperCase()}_ROOT`;
          const pick = (home, line1, extra = {}) => spawnSync(shell, ['-c', `${line1}\n${second}\nprintf '%s' "$${v}"`], {
            encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...extra },
          }).stdout;
          caches.forEach(({ entries, newest }, i) => {
            const expected = newest === null ? '' : join(homes[i], '.claude', 'plugins', 'cache', 'agentic-plugins', plugin, newest);
            strictEqual(pick(homes[i], first), expected, `${plugin}: the newest release among ${entries.join(', ')}`);
          });
          const loaded = first.replace('${CLAUDE_PLUGIN_ROOT}', '/loaded/root');
          strictEqual(pick(homes[0], loaded), '/loaded/root', `${plugin}: the path Claude wrote in`);
          strictEqual(pick(homes[0], first, { CLAUDE_PLUGIN_ROOT: '/exported/root' }), '/exported/root', `${plugin}: the root a dispatcher exported`);
          strictEqual(pick(homes[0], loaded, { [env]: '/override/root' }), '/override/root', `${plugin}: the override`);
          // Both forms agree where they could differ (PC2a DD1): an empty override is
          // no override, and an override holding a space survives whole.
          strictEqual(pick(homes[0], loaded, { [env]: '' }), '/loaded/root', `${plugin}: an empty override`);
          strictEqual(pick(homes[0], loaded, { [env]: '/over ride/root' }), '/over ride/root', `${plugin}: an override with a space`);
          // An unset override is not a failure, even under errexit (Codex review of PC2a).
          strictEqual(pick(homes[0], `set -e\n${loaded}`), '/loaded/root', `${plugin}: an unset override under set -e`);
        }
      });
    }
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});
