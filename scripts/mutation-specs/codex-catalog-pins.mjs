// Mutation spec — do the ADR-0061 §Decision 2 gate tests catch the defects
// they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/codex-catalog-pins.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Until activation (§Implementation manifest S5)
// the real catalog is all-local, so every pin rule, the untagged exemption and
// the monotonic-pin comparison see nothing in this repository. A validator
// that had lost any of them would pass CI unchanged, and the first input to
// reach the missing rule would be the activation commit itself. The fixture
// tests carry those states instead; this spec proves each rule is load-bearing
// by deleting it and watching a named test fail.
//
// Groups: P phase, S pin shape, H history, L release-PR lag, F migration
// floors, E the untagged exemption, B the baseline, V validate-versions,
// G the CLI entry guards, X the plugin-shape helper.

const T = 'tests/scripts/test-codex-catalog-pins.mjs';
const T_HELPER = 'tests/plugin-shape/test-codex-catalog-source.mjs';

const VM = 'scripts/validate-marketplace.mjs';
const VV = 'scripts/validate-versions.mjs';
const LIB = 'scripts/lib/codex-catalog-pins.mjs';
const HELPER = 'tests/plugin-shape/codex-catalog-source.mjs';

export const TESTS = [T];

export const MUTATIONS = [
  // ---- P: phase ------------------------------------------------------------
  {
    id: 'P1', file: VM,
    from: 'if (locals.length > 0 && pinnedAny) {',
    to: 'if (false) {',
    why: 'a catalog mixing local and pinned entries is accepted',
  },
  {
    id: 'P2', file: VM,
    from: 'if (activated === false && pinnedAny) {',
    to: 'if (false) {',
    why: 'pins are accepted without the activated marker',
  },
  {
    id: 'P3', file: VM,
    from: 'if (activated === true && !pinnedAny) {',
    to: 'if (false) {',
    why: 'the activated marker is accepted with no pins',
  },

  // ---- S: pin shape (always) -----------------------------------------------
  {
    id: 'S1', file: LIB,
    from: 'const SHA = /^[0-9a-f]{40}$/;',
    to: 'const SHA = /^[0-9a-fA-F]{7,40}$/;',
    why: 'an uppercase or abbreviated sha passes the shape check',
  },
  {
    id: 'S2', file: LIB,
    from: 'else if (m[1] !== name) errors.push(',
    to: 'else if (false) errors.push(',
    why: 'a ref naming another plugin is accepted',
  },
  {
    id: 'S3', file: LIB,
    from: "if (source.url !== './') {",
    to: 'if (false) {',
    why: 'a network url is accepted, reintroducing a clone with no timeout',
  },
  {
    id: 'S4', file: LIB,
    from: 'if (source.path !== `plugins/${name}`) {',
    to: 'if (false) {',
    why: "a pin may point at another package's path",
  },
  {
    id: 'S5', file: LIB,
    from: "if (keys.join(',') !== PIN_KEYS.join(',')) {",
    to: 'if (false) {',
    why: 'extra or missing source keys are accepted',
  },

  // ---- H: history -----------------------------------------------------------
  {
    id: 'H1', file: LIB,
    from: 'const tagCommit = resolveCommit(repoRoot, `refs/tags/${tag}`);',
    to: "const tagCommit = gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])?.trim() || null;",
    why: 'the tag is not peeled, so an annotated tag compares by its object id',
  },
  {
    id: 'H2', file: LIB,
    from: '} else if (sha !== null && tagCommit !== sha) {',
    to: '} else if (false) {',
    why: 'a sha other than the tag commit is accepted',
  },
  {
    id: 'H3', file: LIB,
    from: 'if (manifest.version !== version) {',
    to: 'if (false) {',
    why: 'the tree at the sha may carry a different package version',
  },
  {
    id: 'H4', file: VM,
    from: "if (history.ok && typeof entry.source.sha === 'string') {",
    to: 'if (false) {',
    why: 'pins are validated structurally only',
  },
  {
    id: 'H5', file: LIB,
    from: "if (shallow === 'true') return",
    to: 'if (false) return',
    why: 'a shallow clone is treated as full history',
  },
  {
    id: 'H6', file: LIB,
    from: 'if (tags.length === 0) return',
    to: 'if (false) return',
    why: 'a checkout without tags reports pin defects instead of missing evidence',
  },

  // ---- L: release-PR lag ------------------------------------------------------
  {
    id: 'L1', file: VM,
    from: 'for (const e of shape.errors) errors.push(`${at}: ${e}`);',
    to: 'for (const e of shape.errors) (allowVersionLag ? warnings : errors).push(`${at}: ${e}`);',
    why: 'the release-PR allowance excuses a malformed pin',
  },
  {
    id: 'L2', file: VM,
    from: 'if (delta > 0) {',
    to: 'if (delta > 0 && !allowVersionLag) {',
    why: 'the release-PR allowance excuses a pin ahead of the package',
  },
  {
    id: 'L3', file: VM,
    from: 'if (allowVersionLag) warnings.push(`${message} (allowed release-please PR lag)`);',
    to: 'if (true) warnings.push(`${message} (allowed release-please PR lag)`);',
    why: 'a trailing pin is allowed outside the release-PR window',
  },

  // ---- F: migration floors ------------------------------------------------------
  {
    id: 'F1', file: VM,
    from: 'if (floor !== undefined && compareSemver(shape.version, floor) < 0) {',
    to: 'if (false) {',
    why: 'a pin below its migration floor is accepted after activation',
  },
  {
    id: 'F2', file: VM,
    from: 'for (const e of checkRelease(repoRoot, { name, version: floor })) errors.push(',
    to: 'for (const e of []) errors.push(',
    why: 'a floor need not name a real release',
  },
  {
    id: 'F3', file: VM,
    from: 'if (!(name in floorData.floors) && hasReleaseTag(repoRoot, name)) {',
    to: 'if (false) {',
    why: 'a released package may lack a floor before activation',
  },
  {
    id: 'F4', file: VM,
    from: 'errors.push(`${FLOORS_PATH}: floor for "${name}" names no plugins/* release-please package`);',
    to: 'void 0;',
    why: 'a floor may name a package that does not exist',
  },

  // ---- E: the untagged exemption -------------------------------------------------
  {
    id: 'E1', file: LIB,
    from: 'return m !== null && m[1] === name;',
    to: 'return false;',
    why: "the exemption never ends at the package's first release",
  },
  {
    id: 'E2', file: VM,
    from: 'if (activated === true && history.ok && !hasReleaseTag(repoRoot, name)) {',
    to: 'if (history.ok && !hasReleaseTag(repoRoot, name)) {',
    why: 'the exemption also applies before activation',
  },

  // ---- B: monotonic pin against the baseline ----------------------------------------
  {
    id: 'B1', file: VM,
    from: 'errors.push(`${CODEX_PATH} (${name}): pin moves from ${was} to ${now.version} — a pin never moves to a lower version`);',
    to: 'void 0;',
    why: 'a pin may move to a lower version',
  },
  {
    id: 'B2', file: VM,
    from: '} else if (delta === 0 && now.sha !== baseEntry.source.sha) {',
    to: '} else if (false) {',
    why: 'an unchanged version may change its sha (a force-moved tag)',
  },
  {
    id: 'B3', file: VM,
    from: 'if (baseFloors.activated === true && activated !== true) {',
    to: 'if (false) {',
    why: 'activation may be reverted',
  },
  {
    id: 'B4', file: VM,
    from: "if (headEntry && sourceKind(headEntry) === 'local') {",
    to: 'if (false) {',
    why: 'a pinned entry may revert to local without a named error',
  },

  // ---- V: validate-versions -------------------------------------------------------------
  {
    id: 'V1', file: VV,
    from: 'catalogDrift(`${at}: pinned version',
    to: 'void (`${at}: pinned version',
    why: 'Codex pin drift against the manifest goes unreported',
  },
  {
    id: 'V2', file: VV,
    from: 'if (delta > 0) {',
    to: 'if (delta > 0 && !allowMarketplaceLag) {',
    why: 'the release-PR allowance excuses a pin ahead of the manifest',
  },
  {
    id: 'V3', file: VV,
    from: 'for (const e of shapeErrors) errors.push(`${at}: ${e}`);',
    to: 'for (const e of shapeErrors) (allowMarketplaceLag ? warnings : errors).push(`${at}: ${e}`);',
    why: 'the release-PR allowance excuses a malformed pin in validate-versions',
  },

  // ---- G: CLI entry guards ----------------------------------------------------------------
  {
    id: 'G1', file: VM,
    from: 'return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
    to: 'return resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
    why: 'validate-marketplace does nothing and exits 0 when invoked through a link',
  },
  {
    id: 'G2', file: VV,
    from: 'return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
    to: 'return resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
    why: 'validate-versions does nothing and exits 0 when invoked through a link',
  },

  // ---- X: the plugin-shape helper -----------------------------------------------------------
  {
    id: 'X1', file: HELPER, tests: [T_HELPER],
    from: 'if (!phaseActivated) {',
    to: 'if (true) {',
    why: 'the helper asserts the local shape after activation too',
  },
  {
    id: 'X2', file: HELPER, tests: [T_HELPER],
    from: 'deepStrictEqual(entry.source, { source: \'local\', path: `./plugins/${name}` },',
    to: 'deepStrictEqual({ source: \'local\', path: `./plugins/${name}` }, { source: \'local\', path: `./plugins/${name}` },',
    why: 'the helper accepts any source before activation',
  },
  {
    id: 'X3', file: HELPER, tests: [T_HELPER],
    from: "strictEqual(source.url, './', 'a pin materializes from the marketplace snapshot, never the network');",
    to: 'void 0;',
    why: 'the helper accepts a network url after activation',
  },
  {
    id: 'X4', file: HELPER, tests: [T_HELPER],
    from: 'if (allowLag) ok(delta <= 0,',
    to: 'if (allowLag) ok(true,',
    why: 'the helper lets a pin lead the package in a release-please PR',
  },
];
