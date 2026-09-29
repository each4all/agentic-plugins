// Mutation spec — do the ADR-0063 S0 tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/headless-safe-runbooks.mjs
//
// S0 removed every `rm` from the plugins' runbook shell and gave every command
// block that uses the plugin root the same opening resolver. The guard that
// keeps both is a pattern match over markdown, and a pattern guard can pass
// because it matches nothing — so each mutation below puts one defect back and
// names the test that must notice. The runbook fixes S0 made on the way (the
// abort/finalize status and step-2 gate, the /done note read from stdin) get
// theirs too.
//
// Groups: H the headless rules, O the orchestrator runbook fixes.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const T_HEADLESS = 'tests/plugin-shape/test-headless-safe-runbooks.mjs';
const T_PORT = 'tests/plugin-shape/test-runbook-shell-portability.mjs';
const T_RUNBOOK = 'tests/orchestrator/test-abort-finalize-runbook.mjs';
const T_DONE = 'tests/orchestrator/test-done-runbook.mjs';
const T_PROV = 'tests/orchestrator/test-subtask-provenance.mjs';

export const TESTS = [T_HEADLESS, T_PORT, T_RUNBOOK, T_DONE, T_PROV];

const fallback = (plugin) => `[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/${plugin} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"`;
const opening = (plugin) => `CLAUDE_PLUGIN_ROOT="\${AGENTIC_${plugin.toUpperCase()}_ROOT:-\${CLAUDE_PLUGIN_ROOT}}"\n${fallback(plugin)}`;

export const MUTATIONS = [
  // ── H: the headless rules ────────────────────────────────────────────────
  {
    id: 'H1', tests: [T_HEADLESS], file: 'plugins/runtime/core/skills/doctor/SKILL.md',
    from: "ARGS_DIR='<directory mktemp printed>'\n",
    to: `ARGS_DIR='<directory mktemp printed>'\ntrap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo x >&2' EXIT\n`,
    why: 'the ADR-0059 trap comes back in a Codex skill — the form codex exec refuses (C74)',
  },
  {
    id: 'H1b', tests: [T_HEADLESS], file: 'plugins/orchestrator/commands/done.md',
    from: 'HAS_REASON=0\n',
    to: `trap 'rm -f "$NOTE_FILE"' EXIT\nHAS_REASON=0\n`,
    why: 'an rm quoted directly after the trap\'s opening quote — found only if the detector reads quotes as separators',
  },
  {
    id: 'H2', tests: [T_HEADLESS], file: 'plugins/engineer/commands/refine.md',
    from: '  echo "✗ find-active failed (exit $FIND_RC); its error is above." >&2\n  exit "$FIND_RC"\n',
    to: '  echo "✗ find-active failed (exit $FIND_RC); its error is above." >&2\n  rm -f "$FIND_ERR"\n  exit "$FIND_RC"\n',
    why: 'a direct rm returns to a command runbook — the form an rm ask rule denies headless',
  },
  {
    id: 'H3', tests: [T_HEADLESS], file: 'plugins/runtime/commands/context.md',
    from: 'RUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"\n',
    to: 'rmdir "$STALE" 2>/dev/null\nRUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"\n',
    why: 'rmdir is rm under another name',
  },
  {
    id: 'H4', tests: [T_HEADLESS], file: 'plugins/engineer/commands/refine.md',
    from: `${opening('engineer')}\nREPO_ROOT="$(git rev-parse --show-toplevel)"\n`,
    to: 'REPO_ROOT="$(git rev-parse --show-toplevel)"\n',
    why: 'a block uses the plugin root with no resolver — the model is left to find the plugin',
  },
  {
    id: 'H5', tests: [T_HEADLESS], file: 'plugins/engineer/commands/refine.md',
    from: `\`\`\`bash\n${opening('engineer')}\nPROMPT_FILE=`,
    to: `\`\`\`bash\nnode "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE"\n${opening('engineer')}\nPROMPT_FILE=`,
    why: 'the root is used before the resolver sets it',
  },
  {
    id: 'H6', tests: [T_HEADLESS], file: 'plugins/founder/commands/refine.md',
    from: 'AGENTIC_FOUNDER_ROOT', to: 'AGENTIC_ENGINEER_ROOT', count: 6,
    why: 'a founder runbook honours the engineer override — the driver would point it at the wrong plugin',
  },
  {
    id: 'H7', tests: [T_HEADLESS], file: 'plugins/designer/commands/frame.md',
    from: 'shell variable does not outlive a Bash call.',
    to: 'shell variable does not outlive a Bash call. If unset, fall back to the newest cache entry.',
    why: 'the prose that told the model to find the plugin root itself comes back',
  },
  {
    id: 'H8', tests: [T_HEADLESS], file: 'plugins/runtime/commands/context.md',
    from: 'RUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"\n',
    to: 'RUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"\nRUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n',
    why: 'the BASH_SOURCE fallback, which cannot find the plugin from the Bash tool, overrides the resolver',
  },
  {
    id: 'H9', tests: [T_HEADLESS], file: T_HEADLESS,
    from: "const RM_COMMAND = /(^|[\\s;&|(){}'\"`])\\\\?(?:[\\w.-]*\\/)*[\"']?(rm|rmdir)[\"']?(\\s|$)/;",
    to: 'const RM_COMMAND = /(^|[\\s;&|(){}])\\\\?(?:[\\w.-]*\\/)*(rm|rmdir)(\\s|$)/;',
    why: 'the detector stops reading a quote as a separator — its own cases must fail',
  },
  {
    id: 'H10', tests: [T_HEADLESS], file: 'plugins/image/commands/compose.md',
    from: `\n${fallback('image')}`, to: '',
    why: 'a block keeps the override and the host path but loses the cache fallback for a host that writes nothing',
  },
  {
    id: 'H11', tests: [T_HEADLESS], file: 'plugins/orchestrator/commands/done.md',
    from: 'HAS_REASON=0\n', to: '/bin/rm -f "$STALE_NOTE"\nHAS_REASON=0\n',
    why: 'rm spelled with its directory is still rm to a shell and to an ask rule (Refine-verify finding)',
  },
  {
    id: 'H12', tests: [T_HEADLESS],
    prepare: (copy) => {
      // Every runbook and the test's own expected line drop the release
      // filter the same way, so only the executed selection can tell.
      const filter = " | grep -E '/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'";
      const files = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) walk(path);
          else if (entry.endsWith('.md')) files.push(path);
        }
      };
      walk(join(copy, 'plugins'));
      let changed = 0;
      for (const path of files) {
        const text = readFileSync(path, 'utf8');
        if (text.includes(filter)) { writeFileSync(path, text.split(filter).join('')); changed += 1; }
      }
      const test = join(copy, T_HEADLESS);
      const source = readFileSync(test, 'utf8');
      const spelled = " | grep -E '/(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)\\\\.(0|[1-9][0-9]*)(\\\\+[0-9A-Za-z-]+(\\\\.[0-9A-Za-z-]+)*)?$'";
      if (changed < 40 || source.split(spelled).length !== 2) throw new Error(`H12 prepare matched ${changed} runbooks`);
      writeFileSync(test, source.split(spelled).join(''));
    },
    why: 'the cache fallback sorts every directory again, so a prerelease or a stray name outranks the newest release (Refine-verify finding)',
  },
  {
    id: 'H13', tests: [T_HEADLESS], file: 'plugins/orchestrator/commands/done.md',
    from: 'HAS_REASON=0\n', to: 'r\\\nm -f "$STALE_NOTE"\nHAS_REASON=0\n',
    why: 'the command word split by a backslash-newline, read line by line or joined with a space, looks like no rm (Refine-verify findings)',
  },
  {
    id: 'H14', tests: [T_HEADLESS], file: 'plugins/engineer/core/skills/checkpoint/SKILL.md',
    from: 'else from the newest release (`X.Y.Z`) under `~/.claude/plugins/cache/agentic-plugins/engineer/`',
    to: 'else from `$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)`',
    why: 'a skill describes the Claude fallback as a bare sort -V again, which ranks a prerelease above the newest release (Refine-verify finding)',
  },
  {
    id: 'H15', tests: [T_HEADLESS],
    prepare: (copy) => {
      // Every runbook and the test's own expected line accept an empty build
      // identifier again, so only the executed selection can tell.
      const strict = "(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'";
      const loose = "(\\+[0-9A-Za-z.-]+)?$'";
      const files = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) walk(path);
          else if (entry.endsWith('.md')) files.push(path);
        }
      };
      walk(join(copy, 'plugins'));
      let changed = 0;
      for (const path of files) {
        const text = readFileSync(path, 'utf8');
        if (text.includes(strict)) { writeFileSync(path, text.split(strict).join(loose)); changed += 1; }
      }
      const test = join(copy, T_HEADLESS);
      const source = readFileSync(test, 'utf8');
      const spelled = "(\\\\+[0-9A-Za-z-]+(\\\\.[0-9A-Za-z-]+)*)?$'";
      if (changed < 40 || source.split(spelled).length !== 2) throw new Error(`H15 prepare matched ${changed} runbooks`);
      writeFileSync(test, source.split(spelled).join("(\\\\+[0-9A-Za-z.-]+)?$'"));
    },
    why: 'build metadata with an empty identifier (2.0.0+build..1) counts as a release and outranks the newest real one (Refine-verify finding)',
  },
  // ── O: the orchestrator runbook fixes ────────────────────────────────────
  {
    id: 'O1', tests: [T_RUNBOOK], file: 'plugins/orchestrator/commands/abort.md',
    from: '  MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \\\n      find-active --repo-root "$REPO_ROOT")" || { RC=$?; exit "$RC"; }\n',
    to: '  if ! MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \\\n      find-active --repo-root "$REPO_ROOT")"; then\n    RC=$?\n    exit "$RC"\n  fi\n',
    why: 'the `if !` form comes back: `$?` is the negation\'s 0, so a failed find-active exits 0',
  },
  {
    id: 'O2', tests: [T_RUNBOOK], file: 'plugins/orchestrator/commands/finalize.md',
    from: '            process.exitCode = 3;\n', to: '',
    why: 'the step-2 shim reports failures but exits 0, so step 3 marks the macro terminal anyway',
  },
  {
    id: 'O3', tests: [T_RUNBOOK], file: 'plugins/orchestrator/commands/finalize.md',
    from: "    ' || STEP2_RC=$?\nfi", to: "    ' || true\nfi",
    why: 'the runbook ignores the shim\'s status — the gate reads a variable nothing sets',
  },
  {
    id: 'O4', tests: [T_PROV, T_DONE], file: 'plugins/orchestrator/scripts/state.mjs',
    from: "    const text = flags['reason-file'] === '-'\n",
    to: "    const text = flags['reason-file'] === '--'\n",
    why: '`--reason-file -` stops reading standard input, so /done loses its note',
  },
  {
    id: 'O5', tests: [T_RUNBOOK], file: 'plugins/orchestrator/commands/finalize.md',
    from: '```bash\n: "${MACRO_PATH:?Phase 0 did not run in this shell — run Phases 0–3 in one Bash invocation}"\n# ARCHIVE TIMING',
    to: '```bash\n# ARCHIVE TIMING',
    why: 'Phase 3 run in a fresh shell calls /scripts/state.mjs and prints success (Refine-verify finding)',
  },
  {
    id: 'O6', tests: [T_RUNBOOK], file: 'plugins/orchestrator/commands/finalize.md',
    from: '            process.stderr.write(`  ! failed to read ${name}: ${err.message}\\n`);\n            failures += 1;\n',
    to: '            process.stderr.write(`  ! failed to read ${name}: ${err.message}\\n`);\n',
    why: 'a child of the macro that cannot be read is skipped uncounted, and step 3 closes the macro over it (Refine-verify finding)',
  },
];
