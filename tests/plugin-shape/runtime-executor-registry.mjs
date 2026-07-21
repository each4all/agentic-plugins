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
  // node:module grants createRequire, which re-opens synchronous `require()` of ANY
  // capability module (`createRequire(import.meta.url)('node:https')`) — a load path the
  // import-gate's static import/dynamic-import detection cannot see. Watching it fails
  // closed on that bypass (Codex plan-verify CRITICAL). No runtime script imports it.
  'node:module', 'module',
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
  // bootstrap.mjs defaultRunner → spawn(name, args, {stdio}) — the injected
  // probe runner for probeMachineHostState (name loops over {claude, codex} in
  // machine-probe's inspectCli) plus the node-subprocess runner for the settings
  // DRY-RUN plan-hash read and the §8.2 `doctor --record` proof delegation
  // (resume-only, explicit-answer-gated). Tier M1 per ADR-0046 §4; bootstrap
  // itself executes no plugin management (no second executor, ADR-0046 §5).
  'bootstrap.mjs': { modules: ['node:child_process'], primitives: ['spawn'] },
  // source-snapshot.mjs:109 execFile('git', ['-C', root, ...readArgs]) — git
  // read snapshot (rev-parse / status). Tier R0/M1.
  'source-snapshot.mjs': { modules: ['node:child_process'], primitives: ['execFile'] },
  // compat.mjs:615 client.get(...) where client = http|https — release-note URL
  // fetch, https?:// validated and flag-gated. Tier M1. Only GET is allowed; a
  // network member call other than `.get(` in this file fails the network-gate.
  'compat.mjs': { modules: ['node:http', 'node:https'], primitives: ['get'] },
  // notify.mjs dispatchOsascript → spawn('/usr/bin/osascript', <fixed argv>) —
  // the ADR-0040 §2 notification-emit executor. The ONLY non-companion
  // external-process execution outside the host-CLI/git wrappers; ADR-0040
  // authorizes exactly the fixed-template shape pinned in
  // ARGV_VERB_ALLOWLIST['/usr/bin/osascript'] below and nothing broader
  // (§4 ceiling untouched; §3 invariants 1/5/8 narrowly amended for this one
  // surface — config-key gating via notify_channel=none default, detached+
  // unref fire-and-forget, fail-closed silent emit path).
  'notify.mjs': { modules: ['node:child_process'], primitives: ['spawn'] },
  // retention-planner.mjs defaultGitTrackedFiles → execFile('git', ['-C', repoRoot,
  // 'ls-files', '-z']) — the ADR-0047 §7 read-only tracked-file enumeration for the
  // citation pin scan. Tier R0: read-only, injectable (tests pass gitTrackedFiles
  // and never spawn), single fixed verb-path pinned in ARGV_VERB_ALLOWLIST.git.
  'retention-planner.mjs': { modules: ['node:child_process'], primitives: ['execFile'] },
};

// Raw child_process primitives. Any of these called in a file that is not a
// CAPABILITY_IMPORTERS entry → fail closed.
export const RAW_PROCESS_PRIMITIVES = [
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'execFileAsync',
];

// Network primitive member calls (on an http/https/net binding). Only compat.mjs
// is a network CAPABILITY_IMPORTERS entry, so these are allowed only there.
// `fetch` is included so a `binding.fetch(` member call inside a network-importer
// is also gated; the GLOBAL `fetch` (a bare call with no import to anchor on) is
// handled separately by the global-fetch-gate (ADR-0041 §2d).
export const NETWORK_PRIMITIVES = ['get', 'request', 'connect', 'createConnection', 'createServer', 'fetch'];

// ---------------------------------------------------------------------------
// Global fetch (ADR-0041 §2d E1 egress) — a NON-import-anchored network capability
// ---------------------------------------------------------------------------

// `fetch` is a runtime GLOBAL (Node built-in): there is no import to anchor the
// import/network gates on, so a bare `fetch(...)` or any indirection slips past
// every import-anchored gate above. The global-fetch-gate
// (runtime-executor-scan.mjs) is deliberately FAIL-CLOSED — it flags EVERY
// reference to `fetch` (bare/member/computed/aliased/`.call`/Reflect/shadowing)
// in a runtime script and permits ONLY a direct pinned `fetch(url, init)` call
// in a GLOBAL_FETCH_USERS entry. It is a CI tripwire + defense-in-depth, NOT a
// sound sandbox: a determined author could still obfuscate past a token scanner
// (e.g. `globalThis['fet'+'ch']`, a string-concatenated or UNICODE-ESCAPED
// identifier in USE position, deep reflection, or `eval`) or edit this registry,
// so the SOUND behavioral validation of the pinned request is the `channel`
// slice's fetchImpl-injection
// [residual boundary] Escaped identifiers in IMPORT and MODULE-SPECIFIER position
// ARE caught (a clean statement-anchored check exists there); an escaped identifier
// in an arbitrary USE position (`https.request(...)`) is the documented
// deliberate-obfuscation residual — a general static check would false-positive on
// legitimate `\u`-bearing regex character classes (the `/[\u0000-\u001F]/` control
// scrub in notify.mjs itself), so §2b behavioral validation is the sound check.
// unit test (ADR-0041 §2b — it observes the actual URL/method/redirect/timeout
// fetch received). This gate's job is to catch accidental / review-visible fetch
// additions and to fail closed on anything it cannot recognize as the exact
// pinned shape. (Codex review: the previous recognize-safe-forms design was
// fail-OPEN — many indirections evaded it. Now inverted to flag-everything.)

// The ONLY runtime scripts permitted to call the global `fetch`, each with the
// pinned-request conformance spec its ONE direct call must satisfy. As of the
// ADR-0041 §2d transport fix ([impl-transport], ratified 2026-07-06) this is
// EMPTY: the E1 egress transport was swapped from a global `fetch` to an in-process
// `node:https` request (undici silently failed to deliver on the owner's
// IPv6-broken host — see PINNED_HTTPS_USERS below), so no runtime script uses the
// global `fetch` and none is registered here. The global-fetch-gate stays active
// as a fail-closed tripwire: it now rejects ANY `fetch` reference in EVERY runtime
// script (registry never looser than code — an entry for a fetch that no longer
// exists would authorize a re-added fetch that the swap deliberately removed).
//
// Spec fields (retained for a FUTURE fetch user, if any) — a registered file may
// reference `fetch` ONLY as the callee of a DIRECT `fetch(url, init)` call (no
// member/computed/alias/`.call`/shadow — all rejected), taking EXACTLY two args:
//   - `endpointPrefix` / `endpointSuffix`: the URL is a lone string/template
//     literal (no `&&`/`||`/ternary/concatenation — the value must equal the
//     text) that STARTS WITH endpointPrefix and ENDS WITH endpointSuffix, pinning
//     the full host+path shape (token interpolated only in between) — ADR-0041 §2b;
//   - `method` / `redirect`: the init object's top-level `method`/`redirect`
//     properties must be exactly these string literals (parsed as real object
//     keys, never a token buried in a nested string); redirect:'error' is what
//     makes host-pinning egress-bounding (fetch follows redirects by default);
//   - `requireTimeout`: the init object must set a bounded timeout (a `signal`
//     of `AbortSignal.timeout(...)` or a numeric `timeout`) so a slow/hung
//     endpoint cannot wedge the hook path (§2e).
//   - `maxCalls`: the max number of direct pinned fetch calls the file may make.
export const GLOBAL_FETCH_USERS = {};

// ---------------------------------------------------------------------------
// Pinned in-process HTTPS egress (ADR-0041 §2d node:https transport) — an
// IMPORT-ANCHORED network capability scoped to the pinned request
// ---------------------------------------------------------------------------

// The E1 egress transport was originally a global `fetch` (GLOBAL_FETCH_USERS
// above). The [decide-transport] fix (ADR-0041 §2d, ratified 2026-07-06) swaps it
// to an in-process `node:https` request: the bundled `fetch` (undici) does not
// fast-fail a dead IPv6 SYN on the owner's IPv6-broken host and times out, whereas
// `node:https` with an explicit IPv4 family delivers. ADR-0041 §2d authorizes this
// as "a network CAPABILITY_IMPORTER for notify.mjs scoped to the pinned request";
// `curl` stays OUT of ALLOWED_COMMAND_LITERALS (no external-process egress).
//
// This registry is that scoped capability. Unlike CAPABILITY_IMPORTERS (whose
// `modules` are drift-checked to require an actual `import` — so a node:https entry
// there could not land before the impl slice adds the import), PINNED_HTTPS_USERS is
// NOT drift-checked and is INERT until the import + call actually appear: it grants
// nothing on its own (registry never looser than code), so it lands in the guard
// slice — the ADR-0041 §11 keystone, scanner-gate-before-use — BEFORE the impl slice
// adds the transport, exactly as GLOBAL_FETCH_USERS was registered before the fetch.
//
// Being registered here does two things, both enforced by the pinned-https-gate and
// the import-gate (runtime-executor-scan.mjs):
//   1. authorizes the file to `import <binding> from 'node:https'` (import-gate honors
//      a PINNED_HTTPS_USERS entry as it honors a CAPABILITY_IMPORTERS entry); and
//   2. obligates EVERY use of that binding to be the single pinned request — a direct
//      `<binding>.request(url, options)` whose url is the pinned host+endpoint literal,
//      method POST, with a bounded timeout — and rejects every other shape (a non-POST,
//      a non-allowlisted origin, a missing timeout, an indirect/aliased/computed/`.call`
//      request, any OTHER https member method, or a SECOND request call).
//
// Spec fields (parallel to GLOBAL_FETCH_USERS; see validatePinnedHttpsRequest):
//   - `module`: the capability module this file may import for the pinned request
//     (v1: 'node:https'); the import-gate honors ONLY this module for this file.
//   - `endpointPrefix` / `endpointSuffix`: the request URL must be a lone string/
//     template literal that STARTS WITH endpointPrefix and ENDS WITH endpointSuffix,
//     pinning `https://api.telegram.org/bot<TOKEN>/sendMessage` (token interpolated
//     only in between) — ADR-0041 §2b.
//   - `method`: the options object's top-level `method` must be exactly this literal.
//   - `requireTimeout`: the options must bound the request — either
//     `signal: AbortSignal.timeout(<…>)` (fetch-parity auto-abort) or a `timeout:`
//     option set to a positive value — so a hung endpoint cannot wedge the hook path
//     (§2e). Note: `node:https.request` does NOT follow redirects (unlike `fetch`), so
//     there is no `redirect` key to pin; redirect-FOLLOWING would require a SECOND
//     request to a Location, which `maxCalls` forbids.
//   - `maxCalls`: the max number of direct pinned request calls the file may make
//     (v1: 1). The IPv4-preferred→fallback retry (ADR-0041 §2d) must therefore be a
//     loop around a SINGLE `<binding>.request(...)` call site (varying only the
//     non-pinned `family` option), never a second call site — which both keeps the
//     egress bound and structurally reflects "a written body is never retried".
export const PINNED_HTTPS_USERS = {
  'notify.mjs': {
    module: 'node:https',
    endpointPrefix: 'https://api.telegram.org/bot',
    endpointSuffix: '/sendMessage',
    method: 'POST',
    requireTimeout: true,
    maxCalls: 1,
  },
};

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

// The only binaries runtime may launch as a literal command. The osascript
// entry is deliberately the ABSOLUTE path: it pins the system binary (no PATH
// resolution surface) for the ADR-0040 §2 fixed-argv notification dispatch.
export const ALLOWED_COMMAND_LITERALS = ['claude', 'codex', 'git', '/usr/bin/osascript'];

// Node itself, used to run agentic-plugins-owned scripts (engineer state.mjs,
// companions) inside ephemeral temp repos. Recognised as a member expression
// `process.execPath`; argv[0] is a script path, never a host-CLI verb, so Layer
// B's host-CLI verb allowlist does not apply to these calls.
export const NODE_COMMAND_SENTINEL = 'process.execPath';

// Command tokens that are identifiers (not literals) but human-verified safe,
// per file. lib/machine-probe.mjs inspectCli `runner(name, ...)` loops name over
// {claude, codex} (extracted from doctor.mjs for the machine-bootstrap probe seam).
// A `runCommand`/`spawn` with any OTHER bare identifier as its command fails the
// command-gate.
export const ALLOWED_COMMAND_VARIABLES = {
  'machine-probe.mjs': ['name'], // inspectCli(name, …) loops name over {claude, codex}
  'compat.mjs': ['host'], // observeHost(host, …) probes host versions over {claude, codex}
};

// Exec wrappers whose first positional is a passthrough parameter; the raw
// spawn/exec inside them uses that param, and the param's safety is enforced at
// the wrapper's CALL sites instead. doctor.runCommand(command,...) and
// migrate.defaultRunner(command,...) are the two.
export const EXEC_PASSTHROUGH_FNS = {
  'doctor.mjs': [{ fn: 'runCommand', param: 'command' }],
  'migrate-workflow-storage.mjs': [{ fn: 'defaultRunner', param: 'command' }],
  // bootstrap.defaultRunner(name, …) is the injected machine-probe runner (name
  // loops over {claude, codex} inside machine-probe's inspectCli) and the base
  // of defaultSubprocessRunner(scriptPath, …) → defaultRunner(process.execPath,
  // [scriptPath, …]) for the settings dry-run + doctor --record delegations.
  'bootstrap.mjs': [{ fn: 'defaultRunner', param: 'name' }],
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

// Call sites that pass host-CLI argv as inline object properties. lib/machine-probe.mjs
// (the machine-bootstrap probe seam, extracted from doctor.mjs) calls
// inspectCli('claude'|'codex', { versionArgs:[…], authArgs:[…], … }): the command is
// positional arg 0, and every array-literal property of the options object (arg 1) is
// argv to validate against that command. (There is no CLI_PROBES variable — the probe
// arrays are inline at the call.)
export const PROBE_CONFIGS = {
  'machine-probe.mjs': [
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
    // machine-probe.mjs §1.2 marketplace-registration read probe. json-native on Claude
    // (contract §1.2); read-only, source-identity match, never a mutation.
    ['plugin', 'marketplace', 'list', '--json'],
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
    ['plugin', 'list', '--available', '--json'], // C pre-flight policy probe (ADR-0035 §6)
    ['plugin', 'add', '*'], // C: codex plugin add <name>@agentic-plugins (ADR-0035 §5/§6, H2 install)
    ['plugin', 'marketplace', '--help'],
    // machine-probe.mjs §1.2 marketplace-registration read probe: prefer --json
    // (host-parity-baseline: source identity as of 0.139.0), text fallback for an older
    // Codex without --json. Both read-only, source-identity match, never a mutation.
    ['plugin', 'marketplace', 'list'], ['plugin', 'marketplace', 'list', '--json'],
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
    // observeSessionGitFacts branch probe — the session-capture-contract.md §6
    // NORMATIVE branch observation for the ADR-0044 publisher (read-only;
    // detached HEAD ⇒ empty output). Exactly this two-token form; a bare
    // `git branch` (list) or any mutating branch subcommand still fails.
    ['branch', '--show-current'],
    // observeSessionGitFacts porcelain probe with optional index locks
    // DISABLED: a plain `git status` may refresh and write .git/index —
    // outside the publisher's declared session-capture write authority
    // (ADR-0035 M1; plan-verify peer). Exactly this leading global flag.
    ['--no-optional-locks', 'status', '...'],
    ['show-ref', '--verify', '*'],
    ['worktree', 'list', '...'],
    ['init', '-q', '-b', '*'],
    // retention-planner.mjs defaultGitTrackedFiles — the ADR-0047 §7 citation
    // pin scan's read-only tracked-file enumeration. `ls-files` never mutates;
    // `-z` is NUL-delimited output. Exact four-token literal (repoRoot → '*').
    ['-C', '*', 'ls-files', '-z'],
  ],
  // notify.mjs macos-osascript channel (ADR-0040 §2): ONE verb-path pinning
  // the FIXED AppleScript program byte-for-byte, arity-locked. The program
  // reads `on run argv`; the two trailing '*' are the title/body payload —
  // data positions only, never program material (interpolating payload into
  // an -e expression is the classic osascript injection and normalizes to a
  // '*' program token here, which fails this exact-literal path). Any change
  // to the program text or arity fails closed until re-registered.
  '/usr/bin/osascript': [
    ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '*', '*'],
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
  // Codex config-injection / feature-toggle flags — ADR-0035 §6 requires the
  // `codex plugin add`/`list` argv template to EXCLUDE these (they could write
  // arbitrary config or toggle features = H3 escalation). None appear in any
  // current runtime host-CLI argv (git uses `-C`, not `-c`).
  '-c', '--config', '--enable', '--disable',
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
// doctor-detected retired-plugin cleanup may exist." The retired-cleanup command
// template moved with buildPluginCleanupCommand out of settings.mjs into the pure
// plan-half lib (machine-bootstrap-contract.md §1.3 extraction 5):
// lib/plugin-management-plan.mjs commandSpec('claude', ['plugin','uninstall',
// `${plugin}@agentic-plugins`]). The executor that runs it (executePluginCleanupPlans
// → runner) stays in settings.mjs (ALLOWED_DYNAMIC_PROJECTIONS above).
export const ALLOWED_DESTRUCTIVE_TEMPLATES = [
  {
    file: 'plugin-management-plan.mjs',
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
  {
    file: 'bootstrap.mjs',
    receiver: 'child', // the spawn() return bound in defaultRunner
    signal: 'SIGTERM',
    form: "child.kill('SIGTERM')",
    justification: 'SIGTERM on self-spawned child to enforce the bootstrap probe/subprocess runner timeout (ADR-0035 §4, ADR-0046 §4)',
  },
];

// ---------------------------------------------------------------------------
// Signal-0 liveness probes — NOT kills, and deliberately a separate list
// ---------------------------------------------------------------------------

// `process.kill(pid, 0)` sends NO signal. POSIX defines signal 0 as an
// existence/permission check: ESRCH means the process is gone, EPERM means it
// exists under another uid. It cannot terminate, stop, or signal anything — the
// only thing it shares with a kill is the function name, which is a Node/POSIX
// spelling accident.
//
// This is a SEPARATE list from ALLOWED_KILL_SITES, not an entry in it, because the
// two authorize different things: a kill site authorizes terminating a process,
// this authorizes asking whether one exists. Folding the probe into the kill list
// would make "runtime may terminate a child it spawned, and nothing else" quietly
// untrue, and the next reader of that list would have to re-derive which entries
// actually kill.
//
// The form is pinned exactly — `process.kill(<ident>, 0)`. A literal `0` second
// argument is the whole exemption; `process.kill(pid, sig)` where sig is a variable
// is NOT covered and still fails, because a variable could hold 'SIGKILL'.
export const ALLOWED_PID_LIVENESS_SITES = [
  {
    file: 'bootstrap-artifacts.mjs',
    form: 'process.kill(pid, 0)',
    justification:
      'stale family-lock reclaim needs to know whether the owning pid is gone; machine-bootstrap-contract.md §13 fixes this exact probe (ESRCH ⇒ gone, EPERM ⇒ exists) as the staleness rule, alongside the 10-minute age bound (ADR-0035 §4 — a liveness read, not a mutation)',
  },
];

// ---------------------------------------------------------------------------
// Filesystem mutation modeling (ADR-0044 S3b — the ADR-0035 §5 registry
// extension the publish-session add-gate requires)
// ---------------------------------------------------------------------------

// Until this section, the guard modeled process/network/kill reach only and
// the registry header explicitly deferred "fs-mutation path scoping". The
// publish-session executor introduces new mutation primitives (O_EXCL lock
// creation, bounded temp writes, rename publication, scoped sweep deletion),
// so the registry now models the filesystem mutation surface: WHICH runtime
// script may import/call WHICH mutating fs primitive, the write-open shape
// (read-only or O_EXCL-create — overwrite/append opens bypass the temp+rename
// atomicity discipline), pinned recursive removals, and each file's declared
// write roots. Read-only fs use (readFile/readdir/lstat/stat/realpath/access)
// stays ungated. This is a token-level model, not a path-flow analysis —
// state-root declarations are drift-checked against the source's literal
// path segments, and the behavioral truth stays with each executor's tests
// (KEEP-ZERO-DEP: no AST dependency).

export const WATCHED_FS_MODULES = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'];

// Mutating primitives (async + callback/sync twins, plus the fd-anchored
// forms — plan-verify peer: `write`/`writev`/`ftruncate` were omitted).
// `open`/`openSync` are watched because they can create/truncate; the
// fs-open-gate then constrains every call site to read-only or
// O_EXCL-create shapes — which also bounds FileHandle methods (a handle
// opened read-only cannot write, so handle.writeFile is covered by the
// open-shape gate rather than name-anchored detection).
export const FS_MUTATION_PRIMITIVES = [
  'writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'mkdir', 'mkdtemp',
  'open', 'copyFile', 'cp', 'link', 'symlink', 'truncate', 'chmod', 'chown', 'lchmod',
  'lchown', 'utimes', 'lutimes', 'createWriteStream', 'watch',
  'write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes',
  'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync',
  'mkdirSync', 'mkdtempSync', 'openSync', 'copyFileSync', 'cpSync', 'linkSync',
  'symlinkSync', 'truncateSync', 'chmodSync', 'chownSync', 'utimesSync',
  'writeSync', 'writevSync', 'ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync',
];

// The only runtime scripts permitted to import/call mutating fs primitives,
// with the exact primitive set each may bind and the write roots it declares.
// `stateRoots` is the documented write surface, drift-checked segment-wise
// against the file's source (registry never looser than the code): a
// `HOME:`-prefixed root lives under ~/.agentic-plugins (machine-global,
// bootstrap-only per ADR-0046), `os-tmpdir` marks self-created mkdtemp
// scratch. Justifications cite the observed source sites.
export const FS_MUTATION_USERS = {
  // compat run artifacts + release-note copies under runs/compat.
  'compat.mjs': {
    primitives: ['copyFile', 'mkdir', 'writeFile'],
    stateRoots: ['.agentic-plugins/runs/compat'],
    justification: 'compat snapshot/check/plan artifacts (runs/compat) incl. release-note copyFile',
  },
  // consensus run artifacts (task/prompt/raw/synthesis/decision files).
  'consensus.mjs': {
    primitives: ['mkdir', 'writeFile'],
    stateRoots: ['.agentic-plugins/runs/consensus'],
    justification: 'ADR-0024 consensus run artifacts under runs/consensus',
  },
  // context capture ledger + ADR-0044 session-capture slot (note staging,
  // publish-session slot/entry + O_EXCL lock + bounded sweep).
  'context.mjs': {
    primitives: ['mkdir', 'open', 'rename', 'rm', 'writeFile'],
    stateRoots: ['.agentic-plugins/runs/context', '.agentic-plugins/state/runtime/session-capture'],
    justification: 'context run ledger (runs/context) + ADR-0044 slot home: temp+rename writes, wx lock, own-temp sweep and note --clear removals (ADR-0044 §3 deletion grant)',
  },
  'cutover-audit.mjs': {
    primitives: ['mkdir', 'writeFile'],
    stateRoots: ['.agentic-plugins/runs/cutover'],
    justification: 'cutover audit artifacts under runs/cutover (incl. latest.json)',
  },
  // doctor run artifacts + ephemeral temp-repo probes (mkdtemp under the OS
  // tmpdir, recursively removed — the pinned recursive-removal site below).
  'doctor.mjs': {
    primitives: ['mkdir', 'mkdtemp', 'rm', 'writeFile'],
    stateRoots: ['.agentic-plugins/runs/doctor', 'os-tmpdir'],
    justification: 'doctor run artifacts + self-created mkdtemp temp-repo teardown',
  },
  // ADR-0045 S7a entry-brief read layer: `open` is imported ONLY for
  // read-only TOCTOU-safe handle reads (O_RDONLY|O_NOFOLLOW|O_NONBLOCK +
  // fstat-on-handle + bounded read — the lstat→readFile pair it replaces was
  // swappable between check and read). No write flag is ever passed and no
  // state root is mutated; the module stays R0.
  'entry-brief-readers.mjs': {
    primitives: ['open'],
    stateRoots: [],
    justification: 'R0 entry-brief reader: read-only O_NOFOLLOW handle opens for TOCTOU-safe bounded reads; never a write flag, no mutation',
  },
  'retention-planner.mjs': {
    primitives: ['open'],
    stateRoots: [],
    justification: "R0 retention planner: readBoundedRegularFile opens latest/live/cross-artifact pin sources read-only ('r') with an fstat-on-handle regular-file re-check for TOCTOU-safe bounded reads; never a write flag, no mutation (the fs-open-gate pins it read-only)",
  },
  'migrate-workflow-storage.mjs': {
    primitives: ['mkdir', 'rename', 'rm', 'writeFile'],
    stateRoots: ['.agentic-plugins/state'],
    justification: 'ADR-0025 explicit workflow-storage migration: legacy→canonical renames, non-recursive collision removal, migration receipt',
  },
  // notify emit path: file-log channel append + rotation, dedupe lock dirs.
  'notify.mjs': {
    primitives: ['appendFileSync', 'renameSync', 'rmSync', 'mkdirSync'],
    stateRoots: ['.agentic-plugins/state/runtime/notify'],
    justification: 'ADR-0040 notify-owned state: log.ndjson append/rotate + reclaim-lock removal',
  },
  'settings.mjs': {
    primitives: ['mkdir', 'rename', 'writeFile'],
    stateRoots: ['.agentic-plugins/config.toml', 'HOME:.agentic-plugins/config.toml', '.agentic-plugins/runs/settings'],
    justification: 'explicit --apply config.toml upsert (repo + user-global) and settings run artifacts',
  },
  // lib/ (basename-keyed like every other registry table)
  'bootstrap-artifacts.mjs': {
    primitives: ['link', 'mkdir', 'open', 'rename', 'rmdir', 'unlink', 'writeFile'],
    stateRoots: ['HOME:.agentic-plugins'],
    justification: 'ADR-0046 machine-global bootstrap run/profile artifacts: temp+rename writes, hardlink family locks, bounded lock/temp cleanup',
  },
  'egress-config.mjs': {
    primitives: ['openSync'],
    stateRoots: [],
    justification: 'read-only O_RDONLY|O_NOFOLLOW credential open (no write flags) — registered because openSync is a watched primitive; the fs-open-gate pins it read-only',
  },
  'egress-launcher-plan.mjs': {
    primitives: ['mkdir', 'writeFile', 'rename'],
    stateRoots: ['.agentic-plugins/runs'],
    justification: 'ADR-0041 §12 egress launcher plan artifacts (temp+rename) under runs/',
  },
  'egress-semantics.mjs': {
    primitives: ['writeFileSync', 'unlinkSync', 'mkdirSync'],
    stateRoots: ['.agentic-plugins/state/runtime/notify/egress-throttle'],
    justification: 'egress throttle records under the notify state home + their bounded expiry removal',
  },
  'notification-plan.mjs': {
    primitives: ['mkdir', 'writeFile', 'rename'],
    stateRoots: ['.agentic-plugins/runs'],
    justification: 'ADR-0040 §4 notification-channel plan artifacts (temp+rename) under runs/',
  },
  'notify-schema.mjs': {
    primitives: ['writeFileSync', 'writeSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'openSync', 'utimesSync', 'renameSync'],
    stateRoots: ['.agentic-plugins/state/runtime/notify'],
    justification: 'ADR-0040 §1 dedupe claims: wx exclusive create + fd writeSync of the claim record, mkdir reclaim locks + their removal, claim touch/expiry (the bounded retention-deletion grant); ADR-0047 §6 renameSync for capture-verified stale-lock tombstoning and the wx-temp+rename sweep cursor',
  },
  'permission-artifacts.mjs': {
    primitives: ['mkdir', 'writeFile', 'rename'],
    stateRoots: ['.agentic-plugins/runs'],
    justification: 'ADR-0038 permission plan artifacts (temp+rename) under runs/',
  },
};

// The only recursive removals runtime may perform, pinned to the exact
// callee + first-argument identifier (the ALLOWED_KILL_SITES shape). A
// recursive:true removal anywhere else — or with any other target — fails
// closed: recursive deletion is the highest-blast-radius fs primitive and
// every legitimate site removes something the same file provably created.
export const ALLOWED_RECURSIVE_REMOVALS = {
  'doctor.mjs': [
    { callee: 'rm', target: 'tempRepo', justification: 'teardown of the self-created mkdtemp temp repo used for workflow-continuation proofs' },
  ],
  'notify.mjs': [
    { callee: 'rmSync', target: 'lockDir', justification: 'own dedupe reclaim-lock dir removal (ADR-0040 §1 bounded retention deletion)' },
  ],
  'notify-schema.mjs': [
    { callee: 'rmSync', target: 'lockDir', justification: 'own dedupe reclaim-lock dir removal in the claim lifecycle (ADR-0040 §1)' },
    { callee: 'rmSync', target: 'tombstone', justification: 'ADR-0047 §6 capture-verified stale-lock removal: rm acts only on the atomically-renamed nonce-unique tombstone (never the live lock path), plus leaked-tombstone GC (isLockStale-gated, name-shape-pinned, per-entry contained)' },
  ],
};

// The runtime scripts the guard scans. Anything matching plugins/runtime/scripts
// recursively; listed explicitly so a deleted/renamed executor is visible.
export const RUNTIME_SCRIPT_GLOB_ROOT = 'plugins/runtime/scripts';
