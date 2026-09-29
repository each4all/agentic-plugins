// Mutation spec — do the ADR-0059 tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/args-file-transport.mjs
//
// The transport replaced a splice whose worst failure exited zero, so a green
// suite here says little on its own. Each mutation below puts one defect
// back — in the library, a CLI, a runbook or the cleanup — and names the test
// file that must notice. A library defect is written into all four package
// copies at once: a defect in one copy would be caught by the byte-identity
// check alone and would prove nothing about the behavioural tests.
//
// Groups: L the library, C the CLIs, R the runbooks, K the cleanup.

const T_ARGS = 'tests/plugin-shape/test-args-file-transport.mjs';
const T_PORT = 'tests/plugin-shape/test-runbook-shell-portability.mjs';
const T_SUB = 'tests/plugin-shape/test-command-argument-substitution.mjs';

export const TESTS = [T_ARGS, T_PORT, T_SUB];

const COPIES = ['runtime', 'engineer', 'designer', 'founder'].map((p) => `plugins/${p}/scripts/lib/args-file.mjs`);
const everyCopy = (from, to) => (copy, tools) => {
  for (const file of COPIES) tools.applyEdit(copy, { file, from, to });
};

const TRAP = `trap '{ rm -f -- "$ARGS_DIR/args.json" && rmdir -- "$ARGS_DIR"; } || echo "⚠ could not remove $ARGS_DIR" >&2' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM`;

export const MUTATIONS = [
  // ── L: the library ───────────────────────────────────────────────────────
  {
    id: 'L1', tests: [T_ARGS],
    prepare: everyCopy("    if (!word.startsWith('--')) return { flags, body: flags.length === 0 ? text : text.slice(start) };",
      "    if (!word.startsWith('--')) return { flags, body: (flags.length === 0 ? text : text.slice(start)).trimEnd() };"),
    why: 'the persona body loses its trailing whitespace — the replay and the persona tables must see it',
  },
  {
    id: 'L2', tests: [T_ARGS],
    prepare: everyCopy("    if (OPERATORS.has(c)) refuse(", "    if (false && OPERATORS.has(c)) refuse("),
    why: 'an unquoted shell operator is passed through as text instead of refused',
  },
  {
    id: 'L3', tests: [T_ARGS],
    prepare: everyCopy("  if (value.agentic_args !== ARGS_FILE_VERSION) {", "  if (false) {"),
    why: 'a file of another version is read as if it were version 1',
  },
  {
    id: 'L4', tests: [T_ARGS],
    prepare: everyCopy("  if (!value.text.isWellFormed()) fail(", "  if (false) fail("),
    why: 'a lone surrogate is accepted, and would reach a process as U+FFFD',
  },
  {
    id: 'L5', tests: [T_ARGS],
    prepare: everyCopy("        if (d === '\\\\' && i + 1 < text.length && DQ_ESCAPABLE.has(text[i + 1])) { word += text[i + 1]; i += 2; continue; }\n",
      ''),
    why: 'a backslash escape inside double quotes is kept literally — the double-quoted replay must break',
  },
  {
    id: 'L6', tests: [T_ARGS],
    prepare: everyCopy("    const cutStart = next ? words[k].start : (previous ? previous.end : 0);",
      "    const cutStart = words[k].start;"),
    why: 'a trailing --base-branch leaves the whitespace before it in the description',
  },
  {
    id: 'L7', tests: [T_ARGS],
    prepare: everyCopy("  if (at.length > 1) refuse(", "  if (false) refuse("),
    why: 'a repeated --base-branch is accepted silently',
  },
  {
    id: 'L8', tests: [T_ARGS],
    prepare: everyCopy("  if (words.some(isArgsFileToken)) fail(", "  if (false) fail("),
    why: 'an args file may name another args file',
  },
  {
    id: 'L10', tests: [T_ARGS],
    prepare: everyCopy("    if (!word.startsWith('--')) return { flags, body: flags.length === 0 ? text : text.slice(start) };",
      "    if (!word.startsWith('--')) return { flags, body: text.slice(start) };"),
    why: 'unflagged text loses its leading whitespace — the body is no longer the text byte for byte',
  },
  {
    id: 'L11', tests: [T_ARGS],
    prepare: everyCopy("    const named = version === null || typeof version !== 'object' ? shown(JSON.stringify(version)) : `of type ${Array.isArray(version) ? 'array' : 'object'}`;",
      "    const named = shown(JSON.stringify(version));"),
    why: 'a deeply nested version escapes as a RangeError instead of a refusal',
  },
  {
    id: 'L12', tests: [T_ARGS],
    prepare: everyCopy("  if (argv.length === 0 || !isArgsFileToken(argv[0])) return null;\n  const option = findArgsFileOption(argv.slice(0, argv[0] === OPTION ? 2 : 1));",
      "  const option = findArgsFileOption(argv);\n  if (!option) return null;"),
    why: 'the persona CLIs look for --args-file past `--`, so `resolve -- --args-file` stops being a body',
  },
  {
    id: 'L9', tests: [T_ARGS],
    file: COPIES[1], from: "export const ARGS_FILE_MAX_BYTES = 1024 * 1024;", to: "export const ARGS_FILE_MAX_BYTES = 1024 * 1024 * 2;",
    why: 'one package copy drifts from the others',
  },
  // ── C: the CLIs ──────────────────────────────────────────────────────────
  {
    id: 'C1', tests: [T_ARGS], file: 'plugins/engineer/scripts/decide-registry.mjs',
    from: '    if (argsFilePath !== null) argList = personaArgv(readArgsFile(argsFilePath));',
    to: '    if (argsFilePath !== null) argList = readArgsFile(argsFilePath).split(/\\s+/).filter(Boolean);',
    why: 'decide-registry word-splits the file the way the shell did',
  },
  {
    id: 'C2', tests: [T_ARGS], file: 'plugins/runtime/scripts/doctor.mjs',
    from: '    opts = parseArgs(expandArgsFile(process.argv.slice(2)));',
    to: '    opts = parseArgs(process.argv.slice(2));',
    why: 'doctor stops reading the args file',
  },
  {
    id: 'C3', tests: [T_ARGS], file: 'plugins/runtime/scripts/context.mjs',
    from: '    argv = expandArgsFile(rawArgv);',
    to: '    argv = rawArgv;',
    why: 'context stops reading the args file — the staged note must not appear',
  },
  {
    id: 'C4', tests: [T_ARGS], file: 'plugins/runtime/scripts/bootstrap.mjs',
    from: '    if (err instanceof UsageError || err instanceof ArgsFileError) {',
    to: '    if (err instanceof UsageError) {',
    why: 'bootstrap lets a malformed args file escape its usage-error path',
  },
  {
    id: 'C6', tests: [T_ARGS], file: 'plugins/designer/scripts/decide-registry.mjs',
    from: '  process.exitCode = 0;\n}', to: '  process.exit(0);\n}',
    why: 'decide-registry exits before a large context has drained into the pipe',
  },
  {
    id: 'C7', tests: [T_ARGS], file: 'plugins/runtime/scripts/context.mjs',
    from: '  classifiedArgv = argv;\n', to: '  classifiedArgv = argv;\n  argv = rawArgv;\n',
    why: 'context classifies the hook-grade shape on the unexpanded argv',
  },
  {
    id: 'C5', tests: [T_ARGS], file: 'plugins/engineer/scripts/start-args.mjs',
    from: '    const out = { base_branch: baseBranch, base_branch_explicit: baseBranchExplicit, feature };',
    to: '    const out = { base_branch: baseBranch, base_branch_explicit: baseBranchExplicit, feature: feature.trim() };',
    why: 'start-args trims the description it was handed',
  },
  {
    id: 'C8', tests: [T_ARGS],
    prepare: (copy, tools) => {
      // Both halves go back to names, so the check stays self-consistent and
      // only the collision case can tell.
      tools.applyEdit(copy, { file: T_ARGS, from: '  WRITTEN.add(path);', to: '  WRITTEN.add(name);' });
      tools.applyEdit(copy, { file: T_ARGS, from: "!WRITTEN.has(join(dir, f))", to: '!WRITTEN.has(f)' });
    },
    why: 'the side-effect check keeps names instead of paths, so a name written elsewhere excuses a stray file',
  },
  // ── R: the runbooks ──────────────────────────────────────────────────────
  {
    id: 'R1', tests: [T_SUB], file: 'plugins/runtime/commands/doctor.md',
    from: 'node "$RUNTIME_ROOT/scripts/doctor.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"',
    to: 'node "$RUNTIME_ROOT/scripts/doctor.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS',
    why: 'the doctor splice comes back — typed text reaches fenced code',
  },
  {
    id: 'R2', tests: [T_SUB], file: 'plugins/engineer/commands/investigate.md',
    from: '<profile from the arguments above — ', to: '<profile from $ARGUMENTS — ',
    why: 'a quoted placeholder carries host-substituted text into shell source again',
  },
  {
    id: 'R3', tests: [T_ARGS], file: 'plugins/runtime/core/skills/context/SKILL.md',
    from: 'node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"',
    to: 'node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" <subcommand and options>',
    why: 'the Codex mirror stops telling the model to use the args file',
  },
  {
    id: 'R4', tests: [T_ARGS], file: 'plugins/founder/commands/decide.md',
    from: '   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"', to: '   mktemp -d',
    why: 'a runbook loses its portable directory step',
  },
  {
    id: 'R5', tests: [T_ARGS], file: 'plugins/runtime/commands/doctor.md',
    from: '# Runtime - Doctor\n\n$ARGUMENTS\n', to: '# Runtime - Doctor\n',
    why: 'the typed text is no longer shown above the steps that ask the model to copy it',
  },
  // ── K: the cleanup ───────────────────────────────────────────────────────
  // Since the amendment of 2026-09-29 to ADR-0059 (f) the reader removes the
  // file and its directory; no runbook line does. Each defect below breaks the
  // removal or its ownership rule in every library copy, or puts a shell
  // cleanup back into a runbook.
  {
    id: 'K1', tests: [T_PORT], file: 'plugins/runtime/commands/doctor.md',
    from: `ARGS_DIR='<directory from step 1>'\nREPO_ROOT=`,
    to: `ARGS_DIR='<directory from step 1>'\n${TRAP}\nREPO_ROOT=`,
    why: 'a runbook installs the retired shell cleanup again',
  },
  {
    id: 'K2', tests: [T_ARGS, T_PORT],
    prepare: everyCopy("    removeReadArgsFile(path, { warn });\n", ''),
    why: 'the reader stops removing what it read — every args directory is left under the temporary directory',
  },
  {
    id: 'K3', tests: [T_ARGS],
    prepare: everyCopy("  if (!OWNED_DIRECTORY.test(basename(directory))) return 'not-owned';\n", ''),
    why: 'any directory holding an args.json is emptied, whatever its name',
  },
  {
    id: 'K4', tests: [T_ARGS],
    prepare: everyCopy("  if (parent === null || !temporaryRoots().has(parent)) return 'not-owned';\n", ''),
    why: 'an agentic-args directory anywhere — not only under the temporary directory — is emptied',
  },
  {
    id: 'K6', tests: [T_ARGS],
    prepare: everyCopy("  if (entries.length !== 1) {", "  if (false) {"),
    why: 'a directory that holds other files loses its args.json instead of being left whole',
  },
  {
    id: 'K7', tests: [T_ARGS],
    prepare: everyCopy("  if (!directoryStats.isDirectory() || !fileStats.isFile()) return 'not-owned';\n", ''),
    why: 'a symbolic link named like an owned directory is followed, and its target emptied',
  },
  {
    id: 'K8', tests: [T_ARGS, T_PORT],
    prepare: (copy, tools) => {
      everyCopy("  } finally {\n    removeReadArgsFile(path, { warn });\n  }\n  return decodeArgsFile(bytes);",
        "  } finally {}\n  const text = decodeArgsFile(bytes);\n  removeReadArgsFile(path, { warn });\n  return text;")(copy, tools);
    },
    why: 'the file is removed only when its text is valid, so a refused file is left behind',
  },
  {
    id: 'K9', tests: [T_ARGS],
    prepare: everyCopy("  const file = resolve(path);\n", "  const file = path;\n"),
    why: 'a doubled separator leaves the directory named with a trailing slash, and lstat then follows a link to it (Refine-verify finding)',
  },
  {
    id: 'K10', tests: [T_ARGS],
    prepare: everyCopy("  if (opened.dev !== fileStats.dev || opened.ino !== fileStats.ino) return 'not-owned';\n", ''),
    why: 'a .. after a link reads one file and removes another, owned one',
  },
  {
    id: 'K5', tests: [T_ARGS], file: 'plugins/engineer/commands/start.md',
    from: `FEATURE="$(printf '%s' "$START_ARGS" | jq -j .feature; printf x)"; FEATURE="\${FEATURE%x}"`,
    to: `FEATURE="$(printf '%s' "$START_ARGS" | jq -r .feature)"`,
    why: 'the start block reads FEATURE through a bare command substitution, which drops trailing newlines',
  },
];
