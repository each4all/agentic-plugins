// Mutation spec — do the ADR-0061 S4 writer tests catch the defects they
// exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/codex-pin-writer.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Until the owner activates the catalog
// (§Implementation manifest S5), every real release runs the writer's
// pre-activation branch, which by design does nothing to the Codex catalog.
// The activation branch and the whole post-activation branch therefore run
// for the first time on the activation dispatch itself. A green suite proves
// nothing about them; deleting each rule and watching a named test fail does.
//
// Groups: A activation, P post-activation pins, N first publication, C the
// CLI's write-then-validate, W the release-please.yml wiring.
//
// Some rules looked mutable but are equivalent by construction and are not
// listed: planCodexPins returning early on errors (syncCatalogs refuses on
// the same errors), and a tag that does not resolve (checkRelease reports it
// again). A mutation there changes nothing observable.

const T = 'tests/scripts/test-codex-pin-writer.mjs';
const WRITER = 'scripts/sync-marketplace-versions.mjs';
const WORKFLOW = '.github/workflows/release-please.yml';

export const TESTS = [T];

export const MUTATIONS = [
  // ---- A: activation — explicit, gated, all or nothing ----------------------
  {
    id: 'A1', file: WRITER,
    from: 'if (!floors.activated && !activate) {',
    to: 'if (false) {',
    why: 'an ordinary release activates the catalog without the owner\'s intent',
  },
  {
    id: 'A2', file: WRITER,
    from: 'const written = errors.length === 0 && pending && !checkOnly;',
    to: 'const written = pending && !checkOnly;',
    why: 'a refused plan still writes — the Claude catalog, and a half activation',
  },
  {
    id: 'A3', file: WRITER,
    from: 'if (t.floor === undefined) {\n        errors.push(`${entry.name} has no migration floor',
    to: 'if (false) {\n        errors.push(`${entry.name} has no migration floor',
    why: 'activation pins a package that has no floor',
  },
  {
    id: 'A4', file: WRITER,
    from: 'if (compareSemver(version, floor) < 0) return { error:',
    to: 'if (false) return { error:',
    why: 'a package below its floor is pinned',
  },
  {
    id: 'A5', file: WRITER,
    from: 'if (released.length > 0) return { error:',
    to: 'if (false) return { error:',
    why: 'a tag whose tree carries another version is pinned',
  },
  {
    id: 'A8', file: WRITER,
    from: 'const floorTag = releaseTag(name, floor);',
    to: 'const floorTag = releaseTag(name, version);',
    why: 'the plan checks the current release instead of the floor, so --check promises a write the gates reject',
  },
  {
    id: 'A6', file: WRITER,
    from: 'if (codex.activating) writeJSON(resolve(repoRoot, FLOORS_PATH), codex.floors);',
    to: 'void 0;',
    why: 'the pins land without the activated marker',
  },
  {
    id: 'A7', file: WRITER,
    from: 'const sha = resolveCommit(repoRoot, `refs/tags/${tag}`);',
    to: "const sha = resolveCommit(repoRoot, 'HEAD');",
    why: 'a pin names the current commit instead of the release commit',
  },

  // ---- P: after activation — forward only ------------------------------------
  {
    id: 'P1', file: WRITER,
    from: 'if (delta < 0) {\n        errors.push(`${name}: the manifest',
    to: 'if (false) {\n        errors.push(`${name}: the manifest',
    why: 'a pin moves down',
  },
  {
    id: 'P2', file: WRITER,
    from: '} else if (delta === 0 && t.sha !== entry.source.sha) {',
    to: '} else if (false) {',
    why: 'a force-moved tag silently re-pins the same version to new bytes',
  },
  {
    id: 'P3', file: WRITER,
    from: "if (activate && sourceKind(entry) === 'local') {",
    to: "if (sourceKind(entry) === 'local') {",
    why: 'a hand-made revert is re-pinned without the owner\'s intent',
  },
  {
    id: 'P4', file: WRITER,
    from: "if (activate && sourceKind(entry) === 'local') {",
    to: 'if (false) {',
    why: 'with the owner\'s intent a hand-made revert still cannot be repaired forward',
  },

  {
    id: 'P5', file: WRITER,
    from: 'if (t.floor === undefined) {\n            errors.push(`${name} has no migration floor',
    to: 'if (false) {\n            errors.push(`${name} has no migration floor',
    why: 'a hand-set marker becomes a way around the per-package floor',
  },

  // ---- N: first publication of a new package ---------------------------------
  {
    id: 'N1', file: WRITER,
    from: 'if (!hasReleaseTag(repoRoot, name)) {',
    to: 'if (false) {',
    why: 'an untagged package is treated as a failed release instead of exempt',
  },
  {
    id: 'N2', file: WRITER,
    from: 'const manifestText = readAt(repoRoot, t.sha, `plugins/${name}/.codex-plugin/plugin.json`);',
    to: "const manifestText = readFileSync(resolve(repoRoot, `plugins/${name}/.codex-plugin/plugin.json`), 'utf8');",
    why: 'the first entry\'s category comes from the working tree, not the release',
  },
  {
    id: 'N3', file: WRITER,
    from: 'next.plugins.splice(at === -1 ? next.plugins.length : at, 0, added);',
    to: 'next.plugins.push(added);',
    why: 'a first pin is appended instead of placed in name order',
  },
  {
    id: 'N4', file: WRITER,
    from: "if (typeof category !== 'string') {",
    to: 'if (false) {',
    why: 'a first entry is written without a category',
  },

  // ---- C: the CLI writes, then validates against HEAD ---------------------------
  {
    id: 'C1', file: WRITER,
    from: 'const failures = [...market.errors, ...versions.errors];',
    to: 'const failures = [];',
    why: 'the written catalogs are never validated before the push',
  },
  {
    id: 'C3', file: WRITER,
    from: 'console.log(`OK — both catalogs already in sync with release-please-manifest (Codex catalog ${codex.phase})`);',
    to: 'console.log(`OK — both catalogs already in sync with release-please-manifest (Codex catalog ${codex.phase})`); process.exit(0);',
    why: 'a run with nothing to write reports green on a catalog that fails the gates',
  },
  {
    id: 'C2', file: WRITER,
    from: "const market = validateMarketplace(REPO_ROOT, { base: 'HEAD' });",
    to: 'const market = validateMarketplace(REPO_ROOT, {});',
    why: 'the post-write validation compares against no baseline',
  },

  // ---- W: the release job wiring --------------------------------------------------
  {
    id: 'W1', file: WORKFLOW,
    from: "ACTIVATE_CODEX_PINS: ${{ github.event_name == 'workflow_dispatch' && inputs.activate_codex_pins && '1' || '' }}",
    to: "ACTIVATE_CODEX_PINS: ${{ inputs.activate_codex_pins && '1' || '' }}",
    why: 'the activation flag no longer requires a workflow_dispatch',
  },
  {
    id: 'W2', file: WORKFLOW,
    from: 'CATALOGS=".claude-plugin/marketplace.json .agents/plugins/marketplace.json scripts/data/codex-pin-floors.json"',
    to: 'CATALOGS=".claude-plugin/marketplace.json .agents/plugins/marketplace.json"',
    why: 'the activation commit carries the pins without the marker',
  },
  {
    id: 'W4', file: WORKFLOW,
    from: 'if [ -n "$(git status --porcelain -- $CATALOGS)" ]; then',
    to: 'if [ -n "$(git status --porcelain .claude-plugin/marketplace.json)" ]; then',
    why: 'the commit gate sees only Claude drift and drops an activation that has none',
  },
  {
    id: 'W3', file: WORKFLOW,
    from: 'run: node scripts/sync-marketplace-versions.mjs ${ACTIVATE_CODEX_PINS:+--activate}',
    to: 'run: node scripts/sync-marketplace-versions.mjs --activate',
    why: 'every release job activates',
  },
];
