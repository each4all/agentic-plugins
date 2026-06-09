// Runtime executor allowlist registry — the data half of the ADR-0035 §4
// active-execution boundary guard.
//
// ADR-0035 §4 ("Permanent ceiling") requires that "every executor action MUST
// appear in an allowlist registry; an AST/registry-based plugin-shape test
// (over the child-process / fs / network primitives, not a raw grep) MUST
// reject forbidden patterns ... that appear outside that registry."
//
// This module is the registry. `runtime-executor-scan.mjs` is the scanner that
// reads it; `test-runtime-executor-guard.mjs` is the plugin-shape test that
// runs the scanner over `plugins/runtime/scripts/**/*.mjs` and asserts
// conformance. Adding a new runtime executor (ADR-0035 §5 add-gate) means
// adding its entry here — until then the conformance test fails closed.
//
// Scope (approved Phase 1/3): the HARD gate is runtime-only. fs-mutation path
// scoping, a repo-wide advisory sweep, and full argv taint-tracking are
// explicit follow-ups (see plugins/runtime/docs/follow-ups.md), not v1.
//
// Every entry below is justified against an observed source site so the
// registry never grows looser than the code it describes.

// ---------------------------------------------------------------------------
// Capability imports
// ---------------------------------------------------------------------------

// Node modules whose import grants a process/network capability. A runtime
// script importing any of these MUST be a CAPABILITY_IMPORTERS entry, or the
// import-gate fails closed (catches a new file gaining raw exec/network reach).
export const WATCHED_CAPABILITY_MODULES = [
  'node:child_process', 'child_process',
  'node:http', 'http',
  'node:https', 'https',
  'node:http2', 'http2',
  'node:net', 'net',
  'node:tls', 'tls',
  'node:dgram', 'dgram',
  'node:dns', 'dns', 'node:dns/promises',
];

// The only runtime scripts permitted to import a capability module, and which
// primitives each may bind. Observed via `rg "from 'node:child_process'"` and
// the compat.mjs http/https import.
export const CAPABILITY_IMPORTERS = {
  // doctor.mjs:315 runCommand → spawn(command, args, {stdio}) — the shared exec
  // wrapper every other runtime executor reuses. Tier M1/H2 per ADR-0035 §2.
  'doctor.mjs': { modules: ['node:child_process'], primitives: ['spawn'] },
  // migrate-workflow-storage.mjs:678 defaultRunner → spawn('git', [...]) for a
  // read-only `git status` probe during dry-run. Tier M1.
  'migrate-workflow-storage.mjs': { modules: ['node:child_process'], primitives: ['spawn'] },
  // source-snapshot.mjs:109 execFile('git', ['-C', root, ...readArgs]) — git
  // read snapshot (rev-parse / status). Tier R0/M1.
  'source-snapshot.mjs': { modules: ['node:child_process'], primitives: ['execFile'] },
  // compat.mjs:615 client.get(...) where client = http|https — release-note URL
  // fetch, https?:// validated and flag-gated. Tier M1. Only GET is allowed; a
  // network member call other than `.get(` in this file fails the network-gate.
  'compat.mjs': { modules: ['node:http', 'node:https'], primitives: ['get'] },
};

// Raw child_process primitives. Any of these called in a file that is not a
// CAPABILITY_IMPORTERS entry → fail closed.
export const RAW_PROCESS_PRIMITIVES = [
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'execFileAsync',
];

// Network primitive member calls (on an http/https/net binding). Only compat.mjs
// is a network CAPABILITY_IMPORTERS entry, so these are allowed only there.
export const NETWORK_PRIMITIVES = ['get', 'request', 'connect', 'createConnection', 'createServer'];

// ---------------------------------------------------------------------------
// Command origin (what binary is launched)
// ---------------------------------------------------------------------------

// Call names that originate or forward a command. Raw primitives plus the
// doctor.runCommand re-export chain (runner is the injected default) plus the
// per-file git wrappers and the settings command builder.
export const EXEC_CALL_NAMES = [
  ...RAW_PROCESS_PRIMITIVES,
  'runCommand', 'runner', 'runGit', 'execGit', 'defaultRunner', 'commandSpec',
];

// The only binaries runtime may launch as a literal command.
export const ALLOWED_COMMAND_LITERALS = ['claude', 'codex', 'git'];

// Node itself, used to run agentic-plugins-owned scripts (engineer state.mjs,
// companions) inside ephemeral temp repos. Recognised as a member expression
// `process.execPath`; argv[0] is a script path, never a host-CLI verb, so Layer
// B's host-CLI verb allowlist does not apply to these calls.
export const NODE_COMMAND_SENTINEL = 'process.execPath';

// Command tokens that are identifiers (not literals) but human-verified safe,
// per file. doctor.mjs inspectCli `runner(name, ...)` loops name over
// {claude, codex}. A `runCommand`/`spawn` with any OTHER bare identifier as its
// command fails the command-gate.
export const ALLOWED_COMMAND_VARIABLES = {
  'doctor.mjs': ['name'], // inspectCli(name, …) loops name over {claude, codex}
  'compat.mjs': ['host'], // observeHost(host, …) probes host versions over {claude, codex}
};

// Exec wrappers whose first positional is a passthrough parameter; the raw
// spawn/exec inside them uses that param, and the param's safety is enforced at
// the wrapper's CALL sites instead. doctor.runCommand(command,...) and
// migrate.defaultRunner(command,...) are the two.
export const EXEC_PASSTHROUGH_FNS = {
  'doctor.mjs': [{ fn: 'runCommand', param: 'command' }],
  'migrate-workflow-storage.mjs': [{ fn: 'defaultRunner', param: 'command' }],
};

// Wrappers that hardcode their command internally, so their call sites pass only
// argv. runGit (worktree.mjs) and execGit (source-snapshot.mjs) both wrap git.
export const COMMAND_HARDCODING_WRAPPERS = {
  runGit: 'git',
  execGit: 'git',
};

// Raw-primitive sites that FORWARD an already-validated argv parameter (a spread
// of a wrapper's args), so their argv is validated at the wrapper's call sites
// instead. source-snapshot.mjs execFile('git', ['-C', repoRoot, ...args]) is the
// implementation of execGit(repoRoot, args) — the literal subcommand is checked
// at each execGit(...) call. A NEW spread-argv primitive elsewhere is not exempt.
// `forwardsArgv`: the EXACT argv expression (whitespace-insensitive) the wrapper
// forwards. The site is exempt ONLY when its argv matches one of these exactly —
// a direct `callee('git', ['push', ...args])` does NOT match and is still gated
// (Codex review MAJOR #2: substring matching was too loose).
// `param` is the forwarded wrapper parameter. The exemption additionally
// requires that this identifier has NO local `const/let/var` definition in the
// file — so `const args = ['push']; runner('git', args)` is NOT exempt (it is a
// local literal, not the parameter), closing the exact-site gap (Codex re-review).
// `wrapper` is the enclosing forwarding function; the exemption applies ONLY to
// a forwarded call physically INSIDE that function body (scope-anchored, not
// file-wide), so a planted `const args = ['push']; runner('git', args)` elsewhere
// is never exempt and an unrelated `const args = ['status']` cannot break the
// real exemption (Codex re-review false-positive).
export const ARGV_FORWARDING_SITES = [
  {
    file: 'source-snapshot.mjs',
    callee: 'execFile',
    wrapper: 'execGit',
    forwardsArgv: ["['-C', repoRoot, ...args]"],
    justification: 'execGit implementation: execFile("git", ["-C", repoRoot, ...args]); validated at execGit call sites',
  },
  {
    file: 'worktree.mjs',
    callee: 'runner',
    wrapper: 'runGit',
    forwardsArgv: ['args'],
    justification: 'runGit implementation: runner("git", args); validated at runGit call sites',
  },
];

// Registered dynamic-argv projection sites: the command/argv are member
// expressions whose values flow from a separately-validated builder, so the
// call site itself is exempt from the literal command-gate. settings.mjs runs
// `runner(plan.argv.command, plan.argv.args)` where plan.argv comes from
// buildPluginCommand → commandSpec('claude'|'codex', <template>), which IS
// verb-path validated at its commandSpec sites.
export const ALLOWED_DYNAMIC_PROJECTIONS = [
  {
    file: 'settings.mjs',
    callee: 'runner',
    commandExpr: 'plan.argv.command',
    justification: 'argv flows from buildPluginCommand→commandSpec (validated at commandSpec sites)',
  },
];

// Call sites that pass host-CLI argv as inline object properties. doctor.mjs
// calls inspectCli('claude'|'codex', { versionArgs:[…], authArgs:[…], … }): the
// command is positional arg 0, and every array-literal property of the options
// object (arg 1) is argv to validate against that command. (There is no
// CLI_PROBES variable — the probe arrays are inline at the call.)
export const PROBE_CONFIGS = {
  'doctor.mjs': [
    { callee: 'inspectCli', commandArgIndex: 0, optionsArgIndex: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Argv verb-path allowlist (Layer B)
// ---------------------------------------------------------------------------

// Per host-CLI, the allowed argv "verb-paths". Matching (see scan.mjs):
//   - a literal token must equal the argv token at that position;
//   - '*' matches exactly one variable target token (plugin name, ref, path);
//   - '...' (only as the final entry token) matches zero or more trailing
//     tokens, none of which may be in DANGEROUS_ARGV_TOKENS.
// An argv whose verb-path matches no entry for its command fails closed. This
// is what distinguishes `codex login status` (read probe, allowed) from a bare
// `codex login` (auth mutation, rejected) — the gap plan-verify surfaced.
export const ARGV_VERB_ALLOWLIST = {
  // doctor CLI_PROBES.claude + settings buildPluginCommand(claude) + retired cleanup.
  claude: [
    ['--version'], ['--help'],
    ['auth', 'status'],
    ['plugin', '--help'], ['plugin', 'list'], ['/plugin', 'list'],
    ['plugin', 'install', '*'],
    ['plugin', 'update', '*'],
    // 'plugin uninstall' is NOT a general verb here — it is governed solely by
    // ALLOWED_DESTRUCTIVE_TEMPLATES (the single §4 retired-cleanup exception).
  ],
  // doctor CLI_PROBES.codex + settings buildPluginCommand(codex).
  codex: [
    ['--version'], ['--help'],
    ['exec', '--help'],
    ['features', 'list'],
    ['login', 'status'],
    ['plugin', '--help'], ['plugin', 'list'], ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', '--help'],
    ['plugin', 'marketplace', 'add', '*'],
    ['plugin', 'marketplace', 'upgrade', '*'],
  ],
  // source-snapshot execGit + worktree runGit + migrate + doctor temp-repo init.
  // All read-only except `init` (ephemeral temp repo). `worktree` is restricted
  // to the read-only `list` subcommand — `worktree add/remove/prune` are NOT
  // here (line 190's `worktree add` is a manual recommendation object, never
  // executed). A `git push`/`config`/`clean` would fail closed.
  git: [
    ['--version'],
    ['rev-parse', '...'],
    ['status', '...'],
    ['show-ref', '--verify', '*'],
    ['worktree', 'list', '...'],
    ['init', '-q', '-b', '*'],
  ],
};

// Argv tokens that are NEVER legitimate in a runtime-built host-CLI argv array
// (auth mutation, sandbox/approval relaxation, hook-trust, session mutation,
// destructive verbs, Codex per-plugin config flags excluded by ADR-0035 §6).
// Checked against collected host-CLI argv arrays ONLY — never against prose,
// regex literals, or identifiers (those legitimately mention `--sandbox`,
// `remove`, etc.). Defense-in-depth behind the positive verb-path allowlist.
export const DANGEROUS_ARGV_TOKENS = [
  'login', 'logout', // bare auth flow (NOTE: 'login status' read probe is allowed by verb-path; bare 'login' as a sole/first verb is not)
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-approvals',
  '--dangerously-skip-permissions',
  '--yolo',
  '--sandbox', 'danger-full-access',
  'trust',
  'resume', 'fork', 'compact',
  'prune',
];

// Tokens from DANGEROUS_ARGV_TOKENS that ARE legitimate as a NON-leading token
// in a specific allowed verb-path (so the denylist does not contradict the
// allowlist). 'login' is allowed only in the exact ['login','status'] codex
// probe; 'logout' has no allowed path; everything else stays fully denied.
export const DANGEROUS_ARGV_EXCEPTIONS = [
  { command: 'codex', verbPath: ['login', 'status'] },
];

// ---------------------------------------------------------------------------
// The single permitted destructive (uninstall) executor — ADR-0035 §4
// ---------------------------------------------------------------------------

// "a general uninstall/remove/prune/delete ... only the ADR-approved,
// doctor-detected retired-plugin cleanup may exist." settings.mjs:559
// commandSpec('claude', ['plugin','uninstall', `${plugin}@agentic-plugins`]).
export const ALLOWED_DESTRUCTIVE_TEMPLATES = [
  {
    file: 'settings.mjs',
    command: 'claude',
    verb: 'uninstall',
    targetSuffix: '@agentic-plugins',
    justification: 'retired/unknown agentic-plugins plugin cleanup (ADR-0035 §2 H2, §4 sole uninstall)',
  },
];

// ---------------------------------------------------------------------------
// The single permitted process-kill — ADR-0035 §4
// ---------------------------------------------------------------------------

// "runtime MAY terminate a child it spawned to enforce a finite timeout, and
// nothing else." doctor.mjs:328 child.kill('SIGTERM') inside runCommand's
// timeout timer. Any other `.kill(` / `process.kill(` / SIGKILL fails closed.
export const ALLOWED_KILL_SITES = [
  {
    file: 'doctor.mjs',
    receiver: 'child', // the spawn() return bound in runCommand
    signal: 'SIGTERM',
    form: "child.kill('SIGTERM')",
    justification: 'SIGTERM on self-spawned child to enforce runCommand timeout (ADR-0035 §4)',
  },
];

// The runtime scripts the guard scans. Anything matching plugins/runtime/scripts
// recursively; listed explicitly so a deleted/renamed executor is visible.
export const RUNTIME_SCRIPT_GLOB_ROOT = 'plugins/runtime/scripts';
