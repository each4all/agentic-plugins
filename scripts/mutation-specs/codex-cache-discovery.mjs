// Mutation spec — do the ADR-0061 §Decision 3 discovery tests catch the
// defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/codex-cache-discovery.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Every one of these defects fails quietly: a
// ladder that probes the wrong host first, reads the marketplace clone, or
// crosses hosts after an install failed still returns a working companion on
// most machines, because the caches usually agree with each other and with
// the clone. Only once ADR-0061 activates do the clone and the cache hold
// different trees, and by then a silent regression runs unreleased code. So a
// green suite proves nothing here; breaking each rule on purpose does.
//
// S1 (companion discovery) authored the L/B/I/P/G/T groups. S2 (sibling
// resolvers) added R/C/X/D and G3. S3 emptied the guard's PENDING list,
// retargeted G2 at a receiver the guard now covers, and added V (the
// home-rendered receivers), Y (ADR-0061 §Decision 4's content identity), H
// (doctor), M (plan and settings) and Z (bootstrap and cutover, review round 3).

const T_LIB = 'tests/companions/test-discover-peer.mjs';
const T_BOOT = 'tests/companions/test-companion-bootstrap.mjs';
const T_GUARD = 'tests/plugin-shape/test-no-snapshot-locators.mjs';
const T_RUNNER = 'tests/engineer/test-peer-runner.mjs';
const T_SIBLINGS = 'tests/plugin-shape/test-installed-sibling-resolvers.mjs';
const T_WRITEBACK = 'tests/engineer/test-parent-writeback.mjs';
const T_PEC = 'tests/runtime/test-peer-execution-context.mjs';
const T_CONSENSUS = 'tests/runtime/test-consensus.mjs';
const T_DOCTOR = 'tests/runtime/test-doctor.mjs';
const T_ROOT_DOCS = 'tests/plugin-shape/test-codex-plugin-root-contract.mjs';
const T_NOTIFY = 'tests/runtime/test-notification-plan.mjs';
const T_STATUSLINE = 'tests/runtime/test-statusline-plan.mjs';
const T_INVENTORY = 'tests/runtime/test-receiver-inventory.mjs';
const T_IDENTITY = 'tests/runtime/test-codex-install-identity.mjs';
const T_SETTINGS = 'tests/runtime/test-settings.mjs';
const T_PLAN = 'tests/runtime/test-plugin-management-plan.mjs';
const T_CUTOVER = 'tests/runtime/test-cutover-audit.mjs';
const T_BOOTSTRAP = 'tests/runtime/test-bootstrap-cli.mjs';

const LIB = 'companions/discover-peer.mjs';
const LIB_BUNDLE = 'plugins/companions/scripts/discover-peer.mjs';
const ENGINEER = 'plugins/engineer/scripts/dispatch-peer.mjs';
const ORCHESTRATOR = 'plugins/orchestrator/scripts/dispatch-peer.mjs';
const IMAGE = 'plugins/image/scripts/compose-dispatch.mjs';
const RUNNER = 'plugins/engineer/scripts/peer-runner.mjs';
const ENG_RUNTIME = 'plugins/engineer/scripts/discover-runtime.mjs';
const PEC = 'plugins/runtime/scripts/lib/peer-execution-context.mjs';
const SHUTTLE = 'plugins/runtime/receivers/codex-notify-shuttle.mjs';
const STATUSLINE = 'plugins/runtime/receivers/agentic-statusline.mjs';
const PROBE = 'plugins/runtime/scripts/lib/machine-probe.mjs';
const IDENTITY = 'plugins/runtime/scripts/lib/codex-install-identity.mjs';
const DOCTOR = 'plugins/runtime/scripts/doctor.mjs';
const PLAN = 'plugins/runtime/scripts/lib/plugin-management-plan.mjs';
const SETTINGS = 'plugins/runtime/scripts/settings.mjs';
const ORDER = "const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];";
const ORDER_FIXED = "const order = ['claude', 'codex'];";

export const TESTS = [T_LIB, T_BOOT, T_GUARD, T_SIBLINGS, T_WRITEBACK, T_PEC, T_ROOT_DOCS, T_NOTIFY, T_STATUSLINE, T_INVENTORY, T_IDENTITY, T_DOCTOR, T_SETTINGS, T_PLAN, T_CUTOVER, T_BOOTSTRAP];

export const MUTATIONS = [
  // ---- L: the canonical library ------------------------------------------
  {
    id: 'L1', file: LIB, tests: [T_LIB],
    from: "cacheBase: join(codexHomeDir({ env, home }), 'plugins', 'cache', 'agentic-plugins', 'companions'),",
    to: "cacheBase: join(codexHomeDir({ env, home }), '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions'),",
    why: 'the Codex default reverts to the marketplace clone',
  },
  {
    id: 'L2', file: LIB, tests: [T_LIB],
    from: "return typeof value === 'string' && value.length > 0 ? resolve(value) : join(home, '.codex');",
    to: "return join(home, '.codex');",
    why: 'CODEX_HOME is ignored and ~/.codex is assumed',
  },
  {
    id: 'L3', file: LIB_BUNDLE, tests: [T_LIB],
    from: "export function codexHomeDir(",
    to: "// drifted\nexport function codexHomeDir(",
    why: 'the bundled copy drifts from the canonical library',
  },

  // ---- B: a consumer bootstrap (engineer's copy; orchestrator for its own rung)
  {
    id: 'B1', file: ENGINEER, tests: [T_BOOT],
    from: "const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];",
    to: "const order = ['claude', 'codex'];",
    why: 'a Codex-installed caller probes the Claude cache first (the pre-ADR-0061 order)',
  },
  {
    id: 'B2', file: ENGINEER, tests: [T_BOOT],
    from: '      crossHostFallback: caller !== null && host !== caller,\n      ...(result.ok',
    to: '      crossHostFallback: false,\n      ...(result.ok',
    why: 'a cross-host fallback is taken silently, so no diagnostic can report it',
  },
  {
    id: 'B3', file: ENGINEER, tests: [T_BOOT],
    from: "      manifestPath: caches[host].manifest,\n    });\n",
    to: "      manifestPath: caches[host].manifest,\n    });\n    if (!result.ok) continue;\n",
    why: 'an installed but unusable companion crosses to the other host instead of failing closed',
  },
  {
    id: 'B4', file: ENGINEER, tests: [T_BOOT],
    from: "if (isWithin(self, realOrResolved(caches.codex.root))) return 'codex';",
    to: "if (self.includes('/.codex/')) return 'codex';",
    why: "the caller host is guessed from a '/.codex/' path segment instead of the resolved CODEX_HOME",
  },
  {
    id: 'B5', file: ENGINEER, tests: [T_BOOT],
    from: "  return {\n    path: null,\n    source: null,",
    to: "  { const f = join(resolve(dirname(selfPath), '..', '..', 'companions'), 'scripts', 'discover-peer.mjs');\n"
      + "    if (await fileExists(f)) { const { discoverPeerCompanion } = await import(f); const r = await discoverPeerCompanion({ peer, env, home });\n"
      + "      return { path: r.ok ? r.path : null, source: 'repository', host: null, callerHost, crossHostFallback: false }; } }\n"
      + "  return {\n    path: null,\n    source: null,",
    why: 'an implicit repository rung returns, running whatever library the checkout holds with its own defaults',
  },
  {
    id: 'B6', file: ENGINEER, tests: [T_BOOT],
    from: '      return join(realpathSync(head), ...tail.reverse());',
    to: '      return join(resolve(head), ...tail.reverse());',
    why: 'containment ignores symlinks, so a symlinked CODEX_HOME hides a Codex-installed caller',
  },
  {
    id: 'B8', file: ENGINEER, tests: [T_BOOT],
    from: "    if (install.state === 'absent') continue;\n    if (install.state === 'no-library') {",
    to: "    if (install.state !== 'ok') continue;\n    if (install.state === 'no-library') {",
    why: 'an installed companions plugin with no discovery library is treated as absent and the caller crosses hosts',
  },

  {
    id: 'B10', file: ENGINEER, tests: [T_BOOT],
    from: '      path: result.ok ? realOrResolved(result.path) : null,\n      source: \`${host}-cache\`,',
    to: '      path: result.ok ? result.path : null,\n      source: \`${host}-cache\`,',
    why: 'a companion is returned through a symlinked CODEX_HOME spelling, which its CLI entry guard ignores silently',
  },
  {
    id: 'B9', file: ENGINEER, tests: [T_BOOT],
    from: "await import(pathToFileURL(join(install.root, 'scripts', 'discover-peer.mjs')).href);",
    to: "await import(join(install.root, 'scripts', 'discover-peer.mjs'));",
    why: "the library is imported by bare path, so a '#' in CODEX_HOME reads as a URL fragment",
  },

  // ---- I: image's scripts-dir locator -------------------------------------
  {
    id: 'I1', file: IMAGE, tests: [T_BOOT],
    from: "for (const host of callerHost === 'codex' ? ['codex', 'claude'] : ['claude', 'codex']) {",
    to: "for (const host of ['claude', 'codex']) {",
    why: 'image ignores which host it is installed on',
  },
  {
    id: 'I2', file: IMAGE, tests: [T_BOOT],
    from: "return JSON.parse(readFileSync(join(base, name, manifestRel), 'utf8')).name === 'companions';",
    to: "JSON.parse(readFileSync(join(base, name, manifestRel), 'utf8')); return true;",
    why: 'image accepts a cache directory whose manifest is not the companions plugin',
  },

  {
    id: 'I3', file: IMAGE, tests: [T_BOOT],
    from: "        cacheBase: located.cacheBase,\n",
    to: "",
    why: "image resolves the companion from the library's own default instead of the cache it chose",
  },
  {
    id: 'I4', file: IMAGE, tests: [T_BOOT],
    from: "    if (install.state === 'absent') continue;",
    to: "    if (install.state !== 'ok') continue;",
    why: 'image crosses hosts when the installed companions plugin has no discovery library',
  },

  {
    id: 'I6', file: IMAGE, tests: [T_BOOT],
    from: '  return result.ok ? realOrResolved(result.path) : null;',
    to: '  return result.ok ? result.path : null;',
    why: 'image returns the companion through a symlinked CODEX_HOME spelling',
  },
  {
    id: 'I5', file: IMAGE, tests: [T_BOOT],
    from: "  if (located.callerHost && located.host !== located.callerHost) {",
    to: "  if (false) {",
    why: 'image takes a cross-host fallback silently',
  },

  // ---- P: the ledger records provenance -----------------------------------
  {
    id: 'P1', file: RUNNER, tests: [T_RUNNER],
    from: '        h.companion = companionRecord(companion);\n',
    to: '',
    why: 'a failed resolution leaves no record of which candidate was tried',
  },
  {
    id: 'P2', file: RUNNER, tests: [T_RUNNER],
    from: "      h.status = 'spawning';\n      h.companion = companionRecord(companion);\n",
    to: "      h.status = 'spawning';\n",
    why: 'a successful run leaves no provenance (only the failure path records it)',
  },

  {
    id: 'P3', file: ENGINEER, tests: [T_BOOT],
    from: "  if (companion.crossHostFallback) {",
    to: "  if (false) {",
    why: 'a raw dispatch takes a cross-host fallback silently',
  },

  // ---- G: the repository-wide guard ---------------------------------------
  {
    id: 'G1', file: ENGINEER, tests: [T_GUARD],
    from: "const ENV_OVERRIDE = 'AGENTIC_COMPANIONS_ROOT';",
    to: "const ENV_OVERRIDE = 'AGENTIC_COMPANIONS_ROOT';\nconst CLONE = ['.tmp', 'marketplaces'];",
    why: 'a new clone reference appears in a file that S1 cleared',
  },
  {
    id: 'G2', file: SHUTTLE, tests: [T_GUARD, T_NOTIFY],
    from: "    path.join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'runtime'),",
    to: "    path.join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime'),",
    why: "the notify shuttle's Codex rung reverts to the marketplace clone",
  },
  {
    id: 'G3', file: ENG_RUNTIME, tests: [T_GUARD],
    from: "const ENV_OVERRIDE = 'AGENTIC_RUNTIME_ROOT';",
    to: "const ENV_OVERRIDE = 'AGENTIC_RUNTIME_ROOT';\nconst CLONE = ['.tmp', 'marketplaces'];",
    why: 'a clone reference returns to a resolver S2 moved off it',
  },

  // ---- R: the runtime ladder (engineer's discover-runtime copy) -----------
  {
    id: 'R1', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "base: join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'runtime'),",
    to: "base: join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime'),",
    why: 'the Codex candidate reverts to the marketplace clone',
  },
  {
    id: 'R2', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: ORDER, to: ORDER_FIXED,
    why: 'a Codex-installed caller probes the Claude cache first',
  },
  {
    id: 'R3', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: '      crossHostFallback: caller !== null && host !== caller,\n',
    to: '      crossHostFallback: false,\n',
    why: 'a cross-host fallback is taken without being marked',
  },
  {
    id: 'R4', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "    if (install.state === 'absent') continue;",
    to: "    if (install.state !== 'ok') continue;",
    why: 'a runtime installed without the capability crosses to the other host instead of failing closed',
  },
  {
    id: 'R5', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: '  if (caller === null && selfPath) {',
    to: '  if (selfPath) {',
    expect: 'SURVIVED',
    // Equivalent under the current code, deliberately: an installed caller's
    // sibling (<cache>/<caller>/<seek>, or a clone's plugins/<seek>) always
    // lies in a host tree, so the sibling host-tree check refuses it anyway.
    // The caller condition states the rule; R14 shows the sibling check bites
    // on its own, for a checkout caller whose sibling links into the clone.
    why: 'an installed caller reaches the sibling rung (still refused by the host-tree check)',
  },
  {
    id: 'R6', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: '  const codex = ownership(selfPath, hosts.codex.roots);',
    to: "  const codex = selfPath.includes('/.codex/') ? 1 : 0;",
    why: "the caller host is guessed from a '/.codex/' path segment instead of the resolved CODEX_HOME",
  },
  {
    id: 'R7', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "        join(codexHome, '.tmp', 'marketplaces'),\n",
    to: '',
    why: 'the marketplace clone stops counting as Codex-owned, so its caller is a checkout and takes the clone\'s sibling',
  },
  {
    id: 'R12', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: '    if (isWithin(canonical, canonicalRoot)) best = Math.max(best, canonicalRoot.length);\n',
    to: '',
    why: 'host trees are compared only as spelled, so a cache or clone symlinked elsewhere is missed',
  },
  {
    id: 'R13', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: '    return { root: realOrResolved(install.root), ...provenance',
    to: '    return { root: install.root, ...provenance',
    why: 'a cache root is returned through its symlink spelling, which the CLI entry guards reject silently',
  },
  {
    id: 'R14', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "    if (ownership(sibling, hostTrees) === 0 && (await fileExists(join(sibling, 'scripts', 'footer.mjs')))) {",
    to: "    if (await fileExists(join(sibling, 'scripts', 'footer.mjs'))) {",
    why: 'a checkout sibling that is a symlink into the marketplace clone is accepted',
  },
  {
    id: 'R17', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "  return codex >= claude ? 'codex' : 'claude';",
    to: "  return codex > 0 ? 'codex' : 'claude';",
    why: "overlapping trees go to Codex whenever Codex's tree holds the caller, not to the more specific root",
  },
  {
    id: 'R18', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "      roots: [\n        join(home, '.claude', 'plugins', 'cache'),",
    to: "      roots: [\n        join(home, '.claude'),\n        join(home, '.claude', 'plugins', 'cache'),",
    why: 'the whole Claude home counts as installed, so a checkout under it loses its sibling',
  },
  {
    id: 'R15', file: 'plugins/orchestrator/scripts/discover-engineer.mjs', tests: [T_SIBLINGS],
    from: '    return { root: realOrResolved(install.root), ...provenance',
    to: '    return { root: install.root, ...provenance',
    why: 'discover-engineer hands the runbook a symlinked root whose state.mjs then does nothing',
  },
  {
    id: 'R16', file: 'plugins/runtime/scripts/doctor.mjs', tests: [T_SIBLINGS],
    from: '    return { root: realOrResolvedPath(install.root), ...provenance',
    to: '    return { root: install.root, ...provenance',
    why: "doctor's workflow proof runs engineer through a symlinked root",
  },
  {
    id: 'R8', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "  return typeof value === 'string' && value.length > 0 ? resolve(value) : join(home, '.codex');",
    to: "  return join(home, '.codex');",
    why: 'CODEX_HOME is ignored and ~/.codex is assumed',
  },
  {
    id: 'R9', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "    if (parsed?.name !== 'runtime') continue;\n",
    to: '',
    why: "a cache directory holding another plugin's manifest is accepted",
  },
  {
    id: 'R10', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: '  if (!located.root || !located.crossHostFallback) return;',
    to: '  return;',
    why: 'a cross-host fallback is taken silently',
  },
  {
    id: 'R11', file: ENG_RUNTIME, tests: [T_SIBLINGS],
    from: "      manifest: join('.codex-plugin', 'plugin.json'),",
    to: "      manifest: join('.claude-plugin', 'plugin.json'),",
    why: 'the Codex cache is read through the Claude manifest layout',
  },

  // ---- C: every other copy is exercised, not stood in for ------------------
  ...[
    'plugins/orchestrator/scripts/discover-runtime.mjs',
    'plugins/founder/scripts/discover-runtime.mjs',
    'plugins/designer/scripts/discover-runtime.mjs',
    'plugins/attention/scripts/discover-runtime.mjs',
    'plugins/orchestrator/scripts/discover-engineer.mjs',
    'plugins/engineer/scripts/parent-writeback.mjs',
    'plugins/runtime/scripts/doctor.mjs',
  ].map((file, i) => ({
    id: `C${i + 1}`, file, tests: [T_SIBLINGS],
    from: ORDER, to: ORDER_FIXED,
    why: `${file} ignores which host it is installed on`,
  })),
  {
    id: 'C8', file: 'plugins/attention/scripts/discover-runtime.mjs', tests: [T_SIBLINGS],
    from: '    capabilityRel: null,\n',
    to: "    capabilityRel: join('scripts', 'notify.mjs'),\n",
    why: "attention's entry-brief resolver starts filtering by notify.mjs instead of manifest identity",
  },
  {
    id: 'C9', file: 'plugins/founder/scripts/discover-runtime.mjs', tests: [T_SIBLINGS],
    from: '      capable: await fileExists(join(versionRoot, capabilityRel)),',
    to: "      capable: await fileExists(join(versionRoot, 'scripts', 'footer.mjs')),",
    why: "founder's notify ladder filters on the footer capability",
  },
  {
    id: 'C10', file: 'plugins/orchestrator/scripts/discover-engineer.mjs', tests: [T_SIBLINGS],
    from: '  if (located.root && located.crossHostFallback) {',
    to: '  if (false) {',
    why: 'discover-engineer takes a cross-host fallback silently',
  },
  {
    id: 'C11', file: 'plugins/engineer/scripts/parent-writeback.mjs', tests: [T_WRITEBACK],
    from: '    if (located.crossHostFallback) {',
    to: '    if (false) {',
    why: 'the parent writeback takes a cross-host fallback silently',
  },

  // ---- E: CLI entry guards on the paths the resolvers hand out ------------
  ...[
    'plugins/orchestrator/scripts/state.mjs',
    'plugins/engineer/scripts/state.mjs',
    'plugins/engineer/scripts/dispatch-peer.mjs',
    'plugins/runtime/scripts/notify.mjs',
    'plugins/engineer/scripts/discover-runtime.mjs',
    'plugins/orchestrator/scripts/discover-engineer.mjs',
  ].map((file, i) => ({
    id: `E${i + 1}`, file, tests: [T_SIBLINGS],
    from: 'if (invokedAsCli()) {',
    to: 'if (import.meta.url === `file://${process.argv[1]}`) {',
    why: `${file} compares argv[1] as spelled again, so it does nothing from an escaped path or a symlink`,
  })),

  {
    id: 'E7', file: 'plugins/engineer/scripts/state.mjs', tests: [T_SIBLINGS],
    from: '    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
    to: '    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);',
    why: 'only argv[1] is canonicalized, so --preserve-symlinks-main leaves the CLI silent through a symlink',
  },

  // ---- X: runtime's peer-execution context --------------------------------
  {
    id: 'X1', file: PEC, tests: [T_PEC],
    from: 'companionsOverride.length > 0 ? companionsOverride : null;',
    to: "companionsOverride.length > 0 ? companionsOverride : join(repoRoot, 'companions');",
    why: "the repository's source tree becomes an implicit candidate again (caught by the seam's own test)",
  },
  {
    id: 'X1c', file: PEC, tests: [T_CONSENSUS],
    from: 'companionsOverride.length > 0 ? companionsOverride : null;',
    to: "companionsOverride.length > 0 ? companionsOverride : join(repoRoot, 'companions');",
    why: "the repository's source tree becomes an implicit candidate again (caught by consensus's own test)",
  },
  {
    id: 'X1d', file: PEC, tests: [T_DOCTOR],
    from: 'companionsOverride.length > 0 ? companionsOverride : null;',
    to: "companionsOverride.length > 0 ? companionsOverride : join(repoRoot, 'companions');",
    why: "the repository's source tree becomes an implicit candidate again (caught by doctor's own test)",
  },
  {
    id: 'X2', file: 'plugins/runtime/scripts/consensus.mjs', tests: [T_CONSENSUS],
    from: '    companionsOverride: env.AGENTIC_COMPANIONS_ROOT ?? null,\n',
    to: '',
    why: 'consensus drops the development override',
  },
  {
    id: 'X3', file: 'plugins/runtime/scripts/doctor.mjs', tests: [T_DOCTOR],
    from: '    companionsOverride: env.AGENTIC_COMPANIONS_ROOT ?? null,\n',
    to: '',
    why: 'doctor drops the development override',
  },
  {
    id: 'X4', file: PEC, tests: [T_PEC],
    from: "    if (!manifest.ok || manifest.json?.name !== 'companions') continue;",
    to: '    if (!manifest.ok) continue;',
    why: "a cache directory holding another plugin's manifest is accepted",
  },
  {
    id: 'X5', file: PEC, tests: [T_PEC],
    from: '  if (!isAbsolute(override)) {',
    to: '  if (false) {',
    why: 'a relative override is resolved against the working directory',
  },
  {
    id: 'X6', file: PEC, tests: [T_PEC],
    from: '    const path = candidate.invalid ? candidate.path : await realpath(candidate.path).catch(() => candidate.path);',
    to: '    const path = candidate.path;',
    why: 'a companion selected through a symlink spelling, which its CLI entry guard ignores silently',
  },

  // ---- D: the Codex plugin-root cells ---------------------------------------
  {
    id: 'D1', file: 'plugins/orchestrator/core/skills/done/SKILL.md', tests: [T_ROOT_DOCS],
    from: '| `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill',
    to: '| `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | Codex marketplace install path for `plugins/orchestrator`. For a mentioned `orchestrator` skill',
    why: 'an orchestrator row regains the "Codex marketplace install path" wording',
  },
  {
    id: 'D2', file: 'plugins/designer/core/skills/start/SKILL.md', tests: [T_ROOT_DOCS],
    from: "is the marketplace checkout, which tracks the repository's `main` branch, not that copy.",
    to: 'is the marketplace checkout Codex installs from, not that copy.',
    why: 'one persona cell says again that Codex installs from the checkout',
  },
  // ---- T: the stale-token rules, narrowed for code only ---------------------
  // S1 let founder's and image's .mjs honor CODEX_HOME (Decision 3 requires
  // it). The prose half of each rule must still bite.
  {
    id: 'T1', file: 'plugins/founder/README.md', tests: ['tests/plugin-shape/test-founder-plugin.mjs'],
    from: '# founder — new-business planning workbench (L3 persona)',
    to: '# founder — new-business planning workbench (L3 persona)\n\nSet CODEX_HOME to point discovery elsewhere.',
    why: 'founder prose regains the omcc-era CODEX_HOME discovery label',
  },
  {
    id: 'T2', file: 'plugins/image/README.md', tests: ['tests/plugin-shape/test-image-plugin.mjs'],
    from: '# image — cross-host image generation capability (ADR-0037)',
    to: '# image — cross-host image generation capability (ADR-0037)\n\nSet CODEX_HOME to point discovery elsewhere.',
    why: 'image prose regains the omcc-era CODEX_HOME discovery label',
  },

  // ---- V: the home-rendered receivers (S3) ----------------------------------
  {
    id: 'V1', file: SHUTTLE, tests: [T_NOTIFY],
    from: "  if (codex.state === 'ok') return { root: canonical(codex.root), version: codex.version, crossHost: false };",
    to: "  if (false) return { root: canonical(codex.root), version: codex.version, crossHost: false };",
    why: 'the Codex notify shuttle never takes the Codex install cache',
  },
  {
    id: 'V2', file: SHUTTLE, tests: [T_NOTIFY],
    from: "    if (!manifest || manifest.name !== 'runtime') continue;",
    to: '    if (!manifest) continue;',
    why: 'the shuttle accepts a cache directory whose manifest names another plugin',
  },
  {
    id: 'V3', file: SHUTTLE, tests: [T_NOTIFY],
    from: "  if (codex.state === 'unusable') {",
    to: '  if (false) {',
    why: 'a Codex runtime without notify.mjs crosses to the Claude cache instead of failing closed',
  },
  {
    id: 'V4', file: SHUTTLE, tests: [T_NOTIFY],
    from: '  if (resolved.crossHost) {',
    to: '  if (false) {',
    why: 'the shuttle takes the Claude cache silently',
  },
  {
    id: 'V5', file: SHUTTLE, tests: [T_NOTIFY],
    from: '  const runtimeVersion = resolved.version;',
    to: '  const runtimeVersion = readManifestVersion(runtimeRoot);',
    why: "the floor is judged on the other host's manifest, not the one the selection read",
  },
  {
    id: 'V6', file: SHUTTLE, tests: [T_NOTIFY],
    from: "  if (codex.state === 'ok') return { root: canonical(codex.root),",
    to: "  if (codex.state === 'ok') return { root: codex.root,",
    why: 'a root reached through a symlinked CODEX_HOME is returned in its link spelling',
  },
  {
    id: 'V7', file: STATUSLINE, tests: [T_STATUSLINE, T_GUARD],
    from: "    path.join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'runtime'),",
    to: "    path.join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime'),",
    why: "the statusline's Codex rung reverts to the marketplace clone",
  },
  {
    id: 'V8', file: STATUSLINE, tests: [T_STATUSLINE],
    from: '  const version = resolved.version;',
    to: '  const version = readManifestVersion(root);',
    why: "the statusline judges the floor on the other host's manifest",
  },
  {
    id: 'V9', file: STATUSLINE, tests: [T_STATUSLINE],
    from: "      if (!manifest || manifest.name !== 'runtime') continue;",
    to: '      if (!manifest) continue;',
    why: 'the statusline accepts a cache directory whose manifest names another plugin',
  },
  {
    id: 'V10', file: 'plugins/runtime/data/released-receiver-shapes.json', tests: [T_INVENTORY],
    from: ',\n      "046631eed57a2fb084e8b4ddd6e1e4eda524cf122d5de18146f19d99fa161b90": "plugin-runtime-v0.92.0 … v0.97.4"',
    to: '',
    why: 'the outgoing v1 statusline is not registered, so an installed one reads as foreign, not legacy',
  },

  // ---- Y: Decision 4's content identity (S3) ---------------------------------
  {
    id: 'Y1', file: PROBE, tests: [T_IDENTITY],
    from: '      identity = await verifyPinnedTree({ runner, env, cwd, timeoutMs, snapshotRoot, target, installRoot: installed.cache_path });',
    to: "      identity = { verified: true, status: 'verified', reason: null };",
    why: 'a matching version is taken as content identity',
  },
  {
    id: 'Y2', file: IDENTITY, tests: [T_IDENTITY],
    from: '    else if (actual.mode !== entry.mode) modeDiffering.push(path);',
    to: '',
    why: 'a lost executable bit is not divergence',
  },
  {
    id: 'Y3', file: IDENTITY, tests: [T_IDENTITY],
    from: '  const extra = [...installed.keys()].filter((path) => !pinned.has(path));',
    to: '  const extra = [];',
    why: 'a file the release does not have is not divergence',
  },
  {
    id: 'Y4', file: PROBE, tests: [T_IDENTITY],
    from: "    if (GIT_REDIRECT_ENV.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\\d+$/.test(key)) delete out[key];",
    to: '    if (false) delete out[key];',
    why: "a caller's GIT_DIR redirects the identity read to another repository",
  },
  {
    id: 'Y5', file: PROBE, tests: [T_IDENTITY],
    from: "  return { ...out, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };",
    to: '  return out;',
    why: 'the identity read may follow replace refs or fetch over the network',
  },
  {
    id: 'Y6', file: IDENTITY, tests: [T_IDENTITY],
    from: '  const order = comparePrereleaseAware(installed.version, target.version);',
    to: "  const order = comparePrereleaseAware(installed.version.split('-')[0], target.version.split('-')[0]);",
    why: 'a prerelease pin advance reads as the same version',
  },
  {
    id: 'Y7', file: IDENTITY, tests: [T_IDENTITY],
    from: '  if (sha === null || !SHA_RE.test(sha)) {',
    to: '  if (sha === null) {',
    why: 'a malformed sha is accepted as a pin',
  },

  // ---- H: doctor (S3) --------------------------------------------------------
  {
    id: 'H1', file: DOCTOR, tests: [T_DOCTOR],
    from: '      : installedDir\n        ? cache\n',
    to: "      : installedDir\n        ? (cache.status !== 'not_packaged' ? cache : buildCodexHookLocation({ manifestHooks: plugin.source?.codex_manifest?.hooks, manifestHooksFile: plugin.source?.codex_manifest_hooks_file, defaultHooksFile: plugin.source?.codex_default_hooks_file, origin: 'source' }))\n",
    why: 'a hookless installed package falls through to the source hooks',
  },
  {
    id: 'H2', file: DOCTOR, tests: [T_DOCTOR],
    from: '    const effective = !codexPackageInstalled(plugin)\n',
    to: '    const effective = false\n',
    why: 'a plugin Codex has not installed still contributes hooks',
  },
  {
    id: 'H3', file: DOCTOR, tests: [T_DOCTOR],
    from: 'function resolveHookPluginVersion(plugin) {\n',
    to: 'function resolveHookPluginVersion(plugin) {\n  if (plugin?.source?.claude_manifest?.version) return plugin.source.claude_manifest.version;\n',
    why: 'the hook review target names the source version, not the installed one',
  },
  {
    id: 'H4', file: DOCTOR, tests: [T_IDENTITY],
    from: '  issues.push(...inspectCodexInstallIdentityParity(codexInstallSummary));',
    to: '',
    why: 'the three facts never reach host parity',
  },
  {
    id: 'H5', file: DOCTOR, tests: [T_DOCTOR],
    from: "    const predicted = sibling?.cache?.codex?.status === 'available'",
    to: '    const predicted = false',
    why: 'a sibling installed on Codex is predicted to cross hosts anyway',
  },
  {
    id: 'H6', file: DOCTOR, tests: [T_DOCTOR],
    from: "    for (const key of ['source', 'claude_cache', 'codex_installed', 'codex_content']) {",
    to: "    for (const key of ['source', 'claude_cache', 'codex_installed']) {",
    why: 'a recorded proof ignores a change of installed bytes under the same version',
  },
  {
    id: 'H7', file: DOCTOR, tests: [T_DOCTOR],
    from: "    if (current.codex_content?.startsWith('mismatch@')) {",
    to: '    if (false) {',
    why: 'a proof is reused against bytes known to differ from the pin',
  },

  // ---- M: plan and settings (S3) --------------------------------------------
  {
    id: 'M1', file: PLAN, tests: [T_SETTINGS, T_PLAN],
    from: "      action: 'repair-codex-install',\n      executed: false,\n      command: null,\n      argv: null,\n      executable: false,",
    to: "      action: 'repair-codex-install',\n      executed: false,\n      command: null,\n      argv: null,\n      executable: true,",
    why: 'a repair Codex cannot run from a marketplace upgrade is offered as executable',
  },
  {
    id: 'M2', file: PLAN, tests: [T_SETTINGS],
    from: '  const codexAvailable = Boolean(codexTmpVersion) || catalogListsCodexEntry;',
    to: '  const codexAvailable = Boolean(codexTmpVersion);',
    why: 'a plugin the pinned catalog lists reads as unavailable without a clone directory',
  },
  {
    id: 'M3', file: SETTINGS, tests: [T_SETTINGS],
    from: '      version: resolveCodexInstalledPluginVersion(plugins?.[pluginName]).version ?? null,',
    to: '      version: plugins?.[pluginName]?.installed_version ?? plugins?.[pluginName]?.source_version ?? null,',
    why: 'the Codex review target borrows a Claude or source version',
  },

  // ---- S3 review round 1 (Codex): the fixes each get a mutation ------------
  {
    id: 'Y8', file: IDENTITY, tests: [T_IDENTITY],
    from: '  const named = (Array.isArray(versions) ? versions : []).find((entry) => entry.version_dir === version) ?? null;',
    to: '  const named = (Array.isArray(versions) ? versions : []).find((entry) => entry.manifest_version === version) ?? null;',
    why: 'a retained directory under another name that declares the version is hashed instead of the one Codex serves',
  },
  {
    id: 'Y9', file: IDENTITY, tests: [T_IDENTITY],
    from: '  return { tree, stable: sameFingerprint(before, after) };',
    to: '  return { tree, stable: true };',
    why: 'a tree replaced while it is hashed is still certified',
  },
  {
    id: 'H8', file: DOCTOR, tests: [T_DOCTOR],
    from: '  return selectInstalledCacheDir(versions, version).dir;',
    to: '  return selectInstalledCacheDir(versions, version).dir ?? plugin?.cache?.codex?.latest ?? null;',
    why: "a listed version with no cache directory borrows another version's hooks",
  },
  {
    id: 'M4', file: PLAN, tests: [T_PLAN],
    from: "        ? `Codex has ${name} ${codexInstalledFactVersion ?? 'installed'} below",
    to: "        ? `Codex has ${name} ${codexVersion ?? 'installed'} below",
    why: "the repair names the newest retained cache's version, not the one the verdict used",
  },
  {
    id: 'M5', file: PLAN, tests: [T_PLAN],
    from: '  if (codexRepair.length > 0) {',
    to: '  if (false) {',
    why: 'a due repair never reaches the manual follow-ups aggregate',
  },
  {
    id: 'V11', file: SHUTTLE, tests: [T_NOTIFY],
    from: '  if (diagnosed) return;\n',
    to: '',
    why: 'a cross-host note and a failed spawn make two stderr lines',
  },

  // ---- S3 review round 2 (Codex) -------------------------------------------
  {
    id: 'Y10', file: IDENTITY, tests: [T_IDENTITY],
    from: "        out.set(relPath, { mode: (info.mode & 0o100) !== 0 ? '100755' : '100644', oid: gitBlobId(await readFile(path)) });",
    to: "        out.set(relPath, { mode: (info.mode & 0o111) !== 0 ? '100755' : '100644', oid: gitBlobId(await readFile(path)) });",
    why: 'a file only group or other may execute reads as executable, unlike git',
  },
  {
    id: 'Y11', file: IDENTITY, tests: [T_IDENTITY],
    from: '  if (named.manifest_version !== version) {',
    to: '  if (false) {',
    why: 'the directory named by the version is hashed even when its manifest declares another',
  },
  {
    id: 'H9', file: DOCTOR, tests: [T_DOCTOR, T_SETTINGS],
    from: "        : { ...buildCodexHookLocation({ origin: 'install_cache_unavailable' }), status: 'install_unreadable' };",
    to: "        : buildCodexHookLocation({ origin: 'install_cache_unavailable' });",
    why: 'unreadable installed hooks read as no hooks, so the rest attests as complete',
  },
  {
    id: 'H10', file: DOCTOR, tests: [T_DOCTOR],
    from: '  if ((codexPluginHooks?.summary?.install_unreadable_plugins ?? []).length > 0) {',
    to: '  if (false) {',
    why: "an attestation of the readable hooks reads current while an installed plugin's hooks cannot be read",
  },
  {
    id: 'H11', file: DOCTOR, tests: [T_DOCTOR],
    from: "    if (codexInstall?.catalog_target?.status === 'pinned'",
    to: '    if (false',
    why: 'two unverified reads of a pinned install keep a proof reusable',
  },
  {
    id: 'M6', file: PLAN, tests: [T_PLAN],
    from: '    // either way, and enabling it would load bytes that are not the pinned release.\n    if (codexRepair) {',
    to: '    // either way, and enabling it would load bytes that are not the pinned release.\n    if (false) {',
    why: 'a disabled install behind its pin gets only the enable follow-up',
  },

  // ---- S3 review round 3 (Codex) -------------------------------------------
  {
    id: 'Z1', file: 'plugins/runtime/scripts/bootstrap.mjs', tests: [T_IDENTITY],
    from: "        state = 'unknown';\n",
    to: '',
    why: 'bootstrap credits an installed plugin with no cache directory for its version as installed',
  },
  {
    id: 'H12', file: DOCTOR, tests: [T_DOCTOR],
    from: "      && ['installed', 'disabled'].includes(codexInstall.installed?.status)\n",
    to: "      && ['installed', 'disabled'].includes(codexInstall.installed?.status)\n      && codexInstall.installed?.version\n",
    why: 'a pinned install whose list row carries no version keeps an unverified proof reusable',
  },
  {
    id: 'Z2', file: 'plugins/runtime/scripts/cutover-audit.mjs', tests: [T_CUTOVER],
    from: '    codexRepair.length > 0\n',
    to: '    false\n',
    why: 'cutover sends a Codex install at another version to an executor that cannot repair it',
  },

  // ---- S3 review round 4 (Codex) -------------------------------------------
  {
    id: 'Z3', file: 'plugins/runtime/scripts/bootstrap.mjs', tests: [T_IDENTITY],
    from: "          recovery: host === 'codex'\n",
    to: '          recovery: false\n',
    why: 'a Codex install below its floor is sent to a per-plugin update Codex does not have',
  },
  {
    id: 'Z4', file: 'plugins/runtime/scripts/bootstrap.mjs', tests: [T_IDENTITY],
    from: "      if (host === 'codex' && entry?.state === 'unknown' && entry.version) return { status: 'unknown', recovery: unreadableCodexInstallRecovery(name, entry.version) };\n",
    to: '',
    why: 'an unreadable Codex install reads unknown with no remedy named',
  },
  {
    id: 'Z6', file: 'plugins/runtime/scripts/bootstrap.mjs', tests: [T_BOOTSTRAP],
    from: '    ...(manualRepairs.length > 0 ? { manual_actions: manualRepairs } : {}),\n',
    to: '',
    why: 'bootstrap presents no remedy for an unreadable Codex install',
  },

  // ---- S3 review round 5 (Codex) -------------------------------------------
  {
    id: 'Y12', file: IDENTITY, tests: [T_IDENTITY],
    from: "    if (path.includes('\\uFFFD')) return unverifiedIdentity('a path could not be decoded losslessly, so it cannot be compared');\n",
    to: '',
    why: 'two different file names that decode to the same replacement character compare equal',
  },
  {
    id: 'V12', file: SHUTTLE, tests: [T_NOTIFY],
    from: '  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {\n',
    to: '  return 0;\n  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {\n',
    why: 'the shuttle treats every prerelease of a core as equal',
  },
  {
    id: 'V13', file: STATUSLINE, tests: [T_STATUSLINE],
    from: '  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {\n',
    to: '  return 0;\n  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {\n',
    why: 'the statusline treats every prerelease of a core as equal',
  },
  {
    id: 'Z7', file: 'plugins/runtime/scripts/bootstrap.mjs', tests: [T_IDENTITY],
    from: "  if (pinSatisfiesFloor && ['behind', 'content-mismatch'].includes(install?.currentness)) {",
    to: '  if (false) {',
    why: 'a Codex install that failed to materialize a floor-satisfying pin is sent to a refresh that changes nothing',
  },
  {
    id: 'Z8', file: 'plugins/runtime/scripts/cutover-audit.mjs', tests: [T_CUTOVER],
    from: "  if (unreadableHooks.length > 0) {\n    items.push({",
    to: "  if (false) {\n    items.push({",
    why: 'cutover asks for a hook review settings will refuse to attest, with no restore step first',
  },

  // ---- S3 review round 6 (Codex) -------------------------------------------
  {
    id: 'Y13', file: IDENTITY, tests: [T_IDENTITY],
    from: "        out.set(relPath, { mode: '120000', oid: gitBlobId(await readlink(path, { encoding: 'buffer' })) });",
    to: "        out.set(relPath, { mode: '120000', oid: gitBlobId(Buffer.from(await readlink(path))) });",
    why: 'a symlink target is decoded before it is hashed, so targets that decode alike collide',
  },
  {
    id: 'Y14', file: IDENTITY, tests: [T_IDENTITY],
    from: '  const refVersion = ref !== null && ref.startsWith(refPrefix) ? ref.slice(refPrefix.length) : null;',
    to: "  const refVersion = ref !== null && ref.startsWith(refPrefix) ? ref.slice(ref.lastIndexOf('-v') + 2) : null;",
    why: 'a version containing -v is split at the last -v and the pin reads as malformed',
  },
  {
    id: 'Z9', file: 'plugins/runtime/scripts/cutover-audit.mjs', tests: [T_CUTOVER],
    from: '  const codexRepair = codexWrongVersion.filter((entry) => entry.codex_catalog_target === entry.expected);',
    to: '  const codexRepair = codexWrongVersion;',
    why: 'cutover sends an install behind a pin that also trails the release to a reinstall that lands the older pin',
  },

  // ---- S3 review round 7 (Codex) -------------------------------------------
  {
    id: 'Y15', file: PROBE, tests: [T_IDENTITY],
    from: '    return comparePrereleaseAware(vb, va) ?? semverCompare(vb, va);',
    to: '    return semverCompare(vb, va);',
    why: 'a list-unavailable probe reads an older retained prerelease as the install',
  },
];
