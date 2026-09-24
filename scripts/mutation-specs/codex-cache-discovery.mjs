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
// S1 (companion discovery) authored the L/B/I/P/G/T groups. S2 and S3 extend
// this spec with their own locators, and shrink the guard's PENDING list.

const T_LIB = 'tests/companions/test-discover-peer.mjs';
const T_BOOT = 'tests/companions/test-companion-bootstrap.mjs';
const T_GUARD = 'tests/plugin-shape/test-no-snapshot-locators.mjs';
const T_RUNNER = 'tests/engineer/test-peer-runner.mjs';

const LIB = 'companions/discover-peer.mjs';
const LIB_BUNDLE = 'plugins/companions/scripts/discover-peer.mjs';
const ENGINEER = 'plugins/engineer/scripts/dispatch-peer.mjs';
const ORCHESTRATOR = 'plugins/orchestrator/scripts/dispatch-peer.mjs';
const IMAGE = 'plugins/image/scripts/compose-dispatch.mjs';
const RUNNER = 'plugins/engineer/scripts/peer-runner.mjs';

export const TESTS = [T_LIB, T_BOOT, T_GUARD];

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
    id: 'G2', file: 'plugins/orchestrator/scripts/discover-engineer.mjs', tests: [T_GUARD],
    from: "'.tmp', 'marketplaces'",
    to: "'.tmpx', 'marketplaces'",
    why: 'a PENDING file stops referencing the clone but stays listed, so the list outlives the code',
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
];
