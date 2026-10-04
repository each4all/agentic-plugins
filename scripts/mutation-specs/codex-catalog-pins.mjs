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
// Groups: P phase, S pin shape, I path identity, R the package registry,
// H history, L the release commit's lag (ADR-0065 Decision 8), F migration
// floors, E the untagged exemption, B the baseline, N malformed input,
// V validate-versions, G the CLI entry guards, C what the CLIs pass.

const T = 'tests/scripts/test-codex-catalog-pins.mjs';
const T_STATES = 'tests/scripts/test-release-states.mjs';

const VM = 'scripts/validate-marketplace.mjs';
const VV = 'scripts/validate-versions.mjs';
const LIB = 'scripts/lib/codex-catalog-pins.mjs';

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

  // ---- I: path identity -------------------------------------------------------
  {
    id: 'I1', file: VM,
    from: "if (typeof entry.source !== 'string' || resolve(repoRoot, entry.source) !== pluginDir) {",
    to: 'if (false) {',
    why: "a Claude entry may point at another package's directory",
  },
  {
    id: 'I2', file: VM,
    from: 'if (sourcePath !== `./plugins/${entry.name}`) {',
    to: 'if (false) {',
    why: "a local Codex entry may point at another package's directory",
  },
  {
    id: 'I4', file: VM,
    from: 'if (sourcePath !== `./plugins/${entry.name}`) {',
    to: "if (resolve(repoRoot, sourcePath) !== resolve(repoRoot, 'plugins', entry.name)) {",
    why: 'a local Codex entry may spell its directory any way that resolves on the publisher\'s machine',
  },
  {
    id: 'I5', file: VM,
    from: "if (localKeys.join(',') !== 'path,source') {",
    to: 'if (false) {',
    why: 'a local Codex source may carry keys beyond {path, source}',
  },

  {
    id: 'I3', file: VM,
    from: "if (typeof codexManifest?.interface?.category !== 'string') {",
    to: 'if (false) {',
    why: 'a package reaches its first release without the category its first pin copies',
  },

  // ---- R: the package registry ---------------------------------------------------
  {
    id: 'R1', file: VM,
    from: 'if (pkg?.component !== `plugin-${name}`) {',
    to: 'if (false) {',
    why: 'a package whose tags are not plugin-<name>-v* is accepted',
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
    id: 'H7', file: LIB,
    from: 'if (manifest.name !== name) {',
    to: 'if (false) {',
    why: 'the tree at the sha may carry another plugin under this path',
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

  // ---- L: the release commit's lag — ADR-0065 Decision 8 ---------------------
  {
    id: 'L1', file: VM,
    from: 'for (const e of shape.errors) errors.push(`${at}: ${e}`);',
    to: 'for (const e of shape.errors) (lag?.bumps.has(entry.name) ? warnings : errors).push(`${at}: ${e}`);',
    why: 'the release-commit allowance excuses a malformed pin',
  },
  {
    id: 'L2', file: VM,
    from: 'if (delta > 0) {',
    to: 'if (delta > 0 && !lag?.bumps.has(entry.name)) {',
    why: 'the release-commit allowance excuses a pin ahead of the package',
  },
  {
    id: 'L3', file: LIB,
    from: 'const bump = lag?.bumps.get(name);\n  return bump !== undefined',
    to: 'const bump = lag ? { from: catalogVersion, to: packageVersion } : undefined;\n  return bump !== undefined',
    why: 'a catalog may trail on any commit, not only the one that moved the manifest (rule 1 keyed on nothing)',
  },
  {
    id: 'L4', file: LIB,
    from: '&& catalogVersion === bump.from && packageVersion === bump.to;',
    to: '&& packageVersion === bump.to;',
    why: 'a catalog may trail at any version, not exactly the one the manifest held before',
  },
  {
    id: 'L5', file: LIB,
    from: '&& isSemver(bump.from) && isSemver(bump.to) && compareSemver(bump.from, bump.to) < 0',
    to: '&& isSemver(bump.from) && isSemver(bump.to)',
    why: 'a release commit that moves a version backwards excuses a catalog ahead of the manifest',
  },
  {
    id: 'L6', file: LIB,
    from: '&& catalogVersion === bump.from && packageVersion === bump.to;',
    to: '&& catalogVersion === bump.from;',
    why: 'the allowance holds after the working tree has moved the package past the commit',
  },
  {
    id: 'L7', file: LIB,
    from: 'if (from !== to) bumps.set(',
    to: 'if (true) bumps.set(',
    why: 'every package counts as moved by every commit, so a first release that left the manifest unchanged is excused',
  },
  {
    id: 'L8', file: LIB,
    from: 'resolveCommit(repoRoot, `${commit}^1`);',
    to: 'resolveCommit(repoRoot, commit);',
    why: 'the commit is compared with itself, so the release commit is never recognised',
  },
  {
    id: 'L9', file: LIB,
    from: '      return null;\n    }\n  };',
    to: '      return {};\n    }\n  };',
    why: 'an unparsable manifest reads as empty, so every package counts as moved (a wider verdict, not the strict one)',
  },
  {
    id: 'L10', file: VM,
    from: "!hasReleaseTag(repoRoot, name, bumped ? lag.parent : 'HEAD')",
    to: "!hasReleaseTag(repoRoot, name, 'HEAD')",
    why: "a first release's commit is red once the release job cuts its tag (rule 2 lost)",
  },
  {
    id: 'L11', file: VM,
    from: "!hasReleaseTag(repoRoot, name, bumped ? lag.parent : 'HEAD')",
    to: "!hasReleaseTag(repoRoot, name, lag ? lag.parent : 'HEAD')",
    why: 'every package is judged from the first parent, so a first release that left the manifest unchanged is excused',
  },
  {
    id: 'L12', file: LIB,
    from: "['tag', '--list', `plugin-${name}-v*`, '--merged', at]",
    to: "['tag', '--list', `plugin-${name}-v*`]",
    why: 'a release cut later on another line of history changes a commit\'s verdict (rule 3 lost)',
  },
  {
    id: 'L13', file: VM,
    from: 'const lag = allowReleaseLag ? releaseLag(repoRoot) : null;',
    to: 'const lag = releaseLag(repoRoot);',
    why: "validate-marketplace's library default excuses the release commit, so the writer's validation is not strict",
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

  {
    id: 'F5', file: VM,
    from: 'errors.push(`${FLOORS_PATH}: floor for ${name} removed against',
    to: 'void (`${FLOORS_PATH}: floor for ${name} removed against',
    why: 'the activating change may shed the floors it was gated on',
  },
  {
    id: 'F6', file: VM,
    from: '} else if (compareSemver(now, was) < 0) {',
    to: '} else if (false) {',
    why: 'a floor may be lowered',
  },
  {
    id: 'F7', file: VM,
    from: 'if (!baseActivated && activated === true) {',
    to: 'if (false) {',
    why: 'the activating change may pin a package that has no floor',
  },
  {
    id: 'F8', file: VM,
    from: 'if (floorData.activated) errors.push(`${FLOORS_PATH}: floor ${name}@${floor}: tag ${tag} does not resolve',
    to: 'if (true) errors.push(`${FLOORS_PATH}: floor ${name}@${floor}: tag ${tag} does not resolve',
    why: 'a floor declared ahead of its release blocks main before activation',
  },
  {
    id: 'F9', file: VM,
    from: 'if (floorData.activated) errors.push(`${FLOORS_PATH}: floor ${name}@${floor}: tag ${tag} does not resolve',
    to: 'if (false) errors.push(`${FLOORS_PATH}: floor ${name}@${floor}: tag ${tag} does not resolve',
    why: 'after activation an unreleased floor is only a warning',
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
    from: "if (activated === true && history.ok && !hasReleaseTag(repoRoot, name, bumped ? lag.parent : 'HEAD')) {",
    to: "if (history.ok && !hasReleaseTag(repoRoot, name, bumped ? lag.parent : 'HEAD')) {",
    why: 'the exemption also applies before activation',
  },

  {
    id: 'E3', file: LIB,
    from: 'const RELEASE_TAG = new RegExp(`^plugin-(.+)-v${SEMVER_SRC}(?:[-+][0-9A-Za-z.+-]*)?$`);',
    to: 'const RELEASE_TAG = REF;',
    why: 'a pre-release does not end the exemption (the X.Y.Z narrowing fails open)',
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
    from: 'if (baseActivated && activated !== true) {',
    to: 'if (false) {',
    why: 'activation may be reverted',
  },
  {
    id: 'B4', file: VM,
    from: "if (baseActivated && headEntry && sourceKind(headEntry) === 'local') {",
    to: 'if (false) {',
    why: 'a pinned entry may revert to local without a named error',
  },
  {
    id: 'B5', file: VM,
    from: "if (baseActivated && headEntry && sourceKind(headEntry) === 'local') {",
    to: "if (headEntry && sourceKind(headEntry) === 'local') {",
    why: 'a pre-activation repair of a mis-pinned main is blocked',
  },
  {
    id: 'B6', file: VM,
    from: 'if (baseActivated && headEntry === undefined && claudeNames.has(name)) {',
    to: 'if (false) {',
    why: "a published package's pin may be dropped where its tags are missing",
  },
  {
    id: 'B7', file: VM,
    from: 'for (const [path, r] of unreadable) warnings.push(',
    to: 'for (const [path, r] of unreadable) errors.push(',
    why: 'an unreadable baseline blocks the change that repairs it',
  },

  // ---- N: malformed input -------------------------------------------------------------
  {
    id: 'N1', file: VM,
    from: 'errors.push(`${label}: must be a JSON object`);',
    to: 'void 0;',
    why: 'a catalog that is JSON null passes',
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
    to: 'if (delta > 0 && !lag?.bumps.has(pluginName)) {',
    why: 'the release-commit allowance excuses a pin ahead of the manifest',
  },
  {
    id: 'V3', file: VV,
    from: 'for (const e of shapeErrors) errors.push(`${at}: ${e}`);',
    to: 'for (const e of shapeErrors) (lag?.bumps.has(pluginName) ? warnings : errors).push(`${at}: ${e}`);',
    why: 'the release-commit allowance excuses a malformed pin in validate-versions',
  },
  {
    id: 'V4', file: VV,
    from: 'if (mayTrail(lag, name, catalogVersion, packageVersion)) {',
    to: 'if (lag !== null) {',
    why: 'validate-versions excuses any catalog drift on any commit once the allowance is on',
  },
  {
    id: 'V5', file: VV,
    from: 'const lag = allowReleaseLag ? releaseLag(repoRoot) : null;',
    to: 'const lag = releaseLag(repoRoot);',
    why: "validate-versions' library default excuses the release commit, so the writer's validation is not strict",
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

  // ---- C: what the CLIs pass — the verdict validate.yml reaches ----------------
  {
    id: 'C1', file: VM, tests: [T_STATES],
    from: '    allowReleaseLag: true,\n',
    to: '    allowReleaseLag: false,\n',
    why: 'validate-marketplace is strict on the release commit, which is red by design again',
  },
  {
    id: 'C2', file: VV, tests: [T_STATES],
    from: 'validateVersions(REPO_ROOT, { allowReleaseLag: true });',
    to: 'validateVersions(REPO_ROOT);',
    why: 'validate-versions is strict on the release commit, which is red by design again',
  },
];
