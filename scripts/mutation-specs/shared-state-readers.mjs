// Mutation spec — do the ADR-0067 RR tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/shared-state-readers.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Every one of these rules fails quietly. A
// reader that never looks under the default state root just reports "no
// workflow" from a linked worktree; a pointer spelled against the checkout
// reaches the arbiter as `../…` and is nulled without a word; two copies of
// one workflow read as one; a slot read from the main worktree relays another
// session's handoff. A green suite proves nothing about these; deleting each
// rule and watching a named test fail does. One mutation per new test at
// least (the macro's acceptance asks for each test to be checked once).

const T = 'tests/runtime/test-shared-state-readers.mjs';
const ROOT = 'plugins/runtime/scripts/lib/state-root.mjs';
const READERS = 'plugins/runtime/scripts/lib/entry-brief-readers.mjs';
const STATE_READERS = 'plugins/runtime/scripts/lib/state-readers.mjs';
const DASHBOARD = 'plugins/runtime/scripts/dashboard.mjs';
const CHECK = 'scripts/check-state-collisions.mjs';

export const TESTS = [T];

export const MUTATIONS = [
  {
    id: 'R1', file: ROOT,
    from: "  if (common && path.basename(common) === '.git') return path.dirname(common);",
    to: '  void common;',
    why: 'the default state root is always the checkout, so a linked worktree never reads the main worktree',
    killed_by: /is the main worktree from a linked worktree/,
  },
  {
    id: 'R2', file: ROOT,
    from: "  if (common && path.basename(common) === '.git') return path.dirname(common);",
    to: '  if (common) return path.dirname(common);',
    why: 'a common dir under another name (a bare repository) makes its parent the state root',
    killed_by: /common dir is not named \.git/,
  },
  {
    id: 'E1', file: READERS,
    from: '  const stateRoots = await stateReadSet(repoRoot);',
    to: '  const stateRoots = checkoutOnlyReadSet(repoRoot);',
    why: 'the entry brief reads the checkout alone and misses a workflow stored under the main worktree',
    killed_by: /finds a workflow stored under the main worktree and one stored in the linked worktree/,
  },
  {
    id: 'E2', file: READERS,
    from: '      occurrences.push({ home, identity, link, pointer: toPointer(home.stateRoot, path) });',
    to: '      occurrences.push({ home, identity, link, pointer: toPointer(repoRoot, path) });',
    why: 'a workflow pointer is spelled against the checkout (`../main/…`), and the arbiter nulls it',
    killed_by: /renders a pointer into the main worktree through the arbiter hardening/,
  },
  {
    id: 'E3', file: READERS,
    from: "  if (matches.size > 1) return indeterminate(base, 'cross-root-ambiguity');",
    to: '  void 0;',
    why: 'two workflows for one branch across the two roots are not ambiguity, and the reader picks one',
    killed_by: /reports two files for one branch across the roots/,
  },
  {
    id: 'E4', file: READERS,
    from: '  if (match !== null && match.rawId !== null && filesById.get(match.rawId).size > 1) {',
    to: '  if (false) {',
    why: "this branch's workflow id held by a second file is read as one workflow",
    killed_by: /reports two files for one branch across the roots, or one workflow id in two files/,
  },
  {
    // The identity a file is known by is its spelling, not its device and
    // inode: one file reached through both roots is two files.
    id: 'E5', file: READERS,
    from: '  const identity = real;',
    to: '  const identity = path;',
    why: 'the same physical file reached through both roots counts twice, as a duplicate',
    killed_by: /counts the same physical file reached through both roots once/,
  },
  {
    // The code-review verify of C122 (run plan-verify-20261012T223540Z-15fdd7f6):
    // a file is known by its real path, as the owners count files.
    id: 'H1', file: READERS,
    from: '  const identity = real;',
    to: '  const identity = identityOf(checked);',
    why: 'two hard-linked names count as one workflow, where the owner refuses two files, so the brief leads a resume that fails',
    killed_by: /counts two hard-linked names as two files, as the owner does/,
  },
  {
    id: 'E6', file: READERS,
    from: '  for (let attempt = 0; attempt < caps.MAX_SCAN_ATTEMPTS; attempt++) {',
    to: '  for (let attempt = 0; attempt < 1; attempt++) {',
    why: 'a file archived between the listing and its read degrades the source at once',
    killed_by: /lists a workflows directory again when a listed file vanishes/,
  },
  {
    id: 'E7', file: STATE_READERS,
    from: '    if (!vanished || attempt >= WORKFLOW_SCAN_ATTEMPTS) return scan;',
    to: '    return scan;',
    why: 'the dashboard and doctor scan reports a vanished file blocked without listing again',
    killed_by: /lists a workflows directory again when a listed file vanishes/,
  },
  {
    id: 'E8', file: READERS,
    from: '  for (const { root } of personaHomes(checkoutOnlyReadSet(repoRoot), persona)) {',
    to: '  for (const { root } of personaHomes(await stateReadSet(repoRoot), persona)) {',
    why: "the handoff slot is read from the main worktree, another session's handoff (W9)",
    killed_by: /keeps the handoff slots and the session capture the checkout's own/,
  },
  {
    id: 'D1', file: DASHBOARD,
    from: '    const dir = file.dir ?? workflows.dir;',
    to: '    const dir = workflows.dir;',
    why: "the dashboard looks for a main-worktree macro in the checkout's directory and drops it",
    killed_by: /the dashboard lists a workflow and a macro stored under the main worktree/,
  },
  {
    id: 'D2', file: STATE_READERS,
    from: '  for (const { location, root: stateRoot } of stateRoots ?? await stateReadSet(repoRoot)) {',
    to: '  for (const { location, root: stateRoot } of stateRoots ?? (await stateReadSet(repoRoot)).slice(-1)) {',
    why: "doctor's ledgers read the checkout alone",
    killed_by: /doctor reads both roots into its ledgers/,
  },
  {
    id: 'D3', file: STATE_READERS,
    from: "    merged.status = 'ambiguous';",
    to: '    void 0;',
    why: 'one workflow id in two files leaves the ledger storage reading as healthy',
    killed_by: /names both files of an ambiguity/,
  },
  {
    id: 'C1', file: CHECK,
    from: '          if (group.length < 2) continue;',
    to: '          if (group.length < 3) continue;',
    why: 'the collision check reports no pair, and the install goes ahead over one',
    killed_by: /lists a branch key held in the main worktree and in a linked worktree/,
  },
  // The refine-verify peer's findings (run refine-verify-20261008T054623Z-daee2c).
  {
    id: 'P1', file: ROOT,
    from: '    gitDir = fs.realpathSync(gitDir);',
    to: '    void 0;',
    why: "commondir is resolved from a symlinked gitdir's spelling and names an unrelated directory",
    killed_by: /reads commondir from the physical git dir/,
  },
  {
    id: 'P2', file: READERS,
    from: '  if (match !== null && filesByPointer.get(match.summary.pointer).size > 1) {',
    to: '  if (false) {',
    why: "the reader emits a pointer that, resolved default-root-first, names another workflow's file",
    killed_by: /one pointer spelling naming a different file under each root/,
  },
  {
    id: 'P3', file: READERS,
    from: "    if (macrosByBranch.get(integrationBranch).size > 1) return indeterminate(base, 'duplicate-active-macros');",
    to: '    void integrationBranch;',
    why: 'a bridge leads orchestrator:next while a second macro holds its integration branch',
    killed_by: /a second macro on the bridged macro's integration branch/,
  },
  {
    id: 'P4', file: STATE_READERS,
    from: '  const ambiguities = findWorkflowAmbiguities(await locatedWorkflowFiles(locations, ({ canonical, legacy }) => [canonical, legacy]));',
    to: '  const ambiguities = findWorkflowAmbiguities(await locatedWorkflowFiles(locations, ({ selected }) => [selected]));',
    why: 'a collision in a home not selected for display goes unreported',
    killed_by: /checks every home, not only the one selected for display/,
  },
  {
    id: 'P5', file: STATE_READERS,
    from: "  branch: { over: 'files', keyOf: (entry) => entry.keys.branch },",
    to: "  branch: { over: 'files', keyOf: (entry) => entry.file.branch },",
    why: 'two branches that redact alike are reported as one branch held twice',
    killed_by: /compares raw values/,
  },
  {
    id: 'P6', file: CHECK,
    from: '    if (listingFailed(scan)) unlisted.push(scan.dir);',
    to: '    void scan;',
    why: 'a workflows directory that cannot be listed passes the check as empty',
    killed_by: /lists a branch key held in the main worktree and in a linked worktree/,
  },
  {
    id: 'C2', file: CHECK,
    from: "          if (ownRoot && (file.status !== 'available' || !file.branch)) {",
    to: "          if (ownRoot && file.status !== 'available') {",
    why: 'a workflow file with no readable branch passes the check, and the readers then degrade on it',
    killed_by: /lists a branch key held in the main worktree and in a linked worktree/,
  },
  // The second refine's recurring findings (run refine-verify-20261008T060204Z-8fa648):
  // an alias's pointer spelling dropped with the deduplicated record, and an
  // unlistable directory in the read set read as no state.
  {
    id: 'A1', file: READERS,
    from: [
      '  // second file under the same spelling is a pair (Decision 1(c)).',
      '  for (const { pointer, identity } of scan.occurrences) addTo(filesByPointer, pointer, identity);',
    ].join('\n'),
    to: [
      '  // second file under the same spelling is a pair (Decision 1(c)).',
      '  for (const { pointer, identity } of scan.occurrences.filter((o, i, all) => all.findIndex((p) => p.identity === o.identity) === i)) addTo(filesByPointer, pointer, identity);',
    ].join('\n'),
    why: "the persona reader indexes only a file's first spelling, so an alias's spelling naming another workflow goes unseen",
    killed_by: /counts the spelling of an alias: a lane file under a symlinked main home's spelling is ambiguity/,
  },
  {
    id: 'A2', file: READERS,
    from: [
      '  // Every spelling is indexed, as in the persona reader.',
      '  for (const { pointer, identity } of scan.occurrences) addTo(filesByPointer, pointer, identity);',
    ].join('\n'),
    to: [
      '  // Every spelling is indexed, as in the persona reader.',
      '  for (const { pointer, identity } of scan.occurrences.filter((o, i, all) => all.findIndex((p) => p.identity === o.identity) === i)) addTo(filesByPointer, pointer, identity);',
    ].join('\n'),
    why: "the macro reader indexes only a file's first spelling, and a bridge leads with a pointer that names another macro",
    killed_by: /counts the spelling of an alias: a lane file under a symlinked main home's spelling is ambiguity/,
  },
  // The third refine's verify (run refine-verify-20261008T115943Z-5648e5): the
  // physical-file dedupe must not merge two homes of one state root, which the
  // owners' lookups refuse.
  {
    id: 'W1', file: READERS,
    from: "  if (homes === 'two-homes') return indeterminate(base, 'dual-home-ambiguity');",
    to: '  void homes;',
    why: 'the persona reader leads with a workflow under a legacy home aliasing the canonical one, which the owner refuses',
    killed_by: /keeps a legacy home aliasing the canonical home of one state root dual-home ambiguity/,
  },
  {
    id: 'W2', file: READERS,
    from: "    if (homeAmbiguity(scan.occurrences, new Set([identity])) !== null) return indeterminate(base, 'dual-home-ambiguity');",
    to: '    void identity;',
    why: 'the macro reader leads, or bridges, with a macro under a legacy home aliasing the canonical one, which the owner refuses',
    killed_by: /keeps a legacy home aliasing the canonical home of one state root dual-home ambiguity/,
  },
  // C122 plan-verify (run plan-verify-20261012T215901Z-186b72b, R6): two
  // homes are judged per state root before a file reached through both roots
  // counts once. Judged after, a lane whose both homes alias the main home
  // reads as one file, where the owner refuses the lane.
  {
    id: 'R6', file: READERS,
    from: '  for (const { home, identity } of occurrences) {',
    to: '  for (const { home, identity } of occurrences.filter((o, i, all) => all.findIndex((p) => p.identity === o.identity) === i)) {',
    why: 'dual-home is judged after the cross-root dedupe, and a lane holding one main file under both its homes reads ok',
    killed_by: /judges two homes per state root before deduplicating across roots/,
  },
  {
    id: 'A3', file: STATE_READERS,
    from: "  pointer: { over: 'spellings', keyOf: (entry) => entry.pointer },",
    to: "  pointer: { over: 'files', keyOf: (entry) => entry.pointer },",
    why: "doctor and the dashboard group pointers over deduplicated files, and miss an alias's spelling naming another file",
    killed_by: /counts the spelling of an alias, as the entry brief does/,
  },
  {
    id: 'A4', file: STATE_READERS,
    from: '      if (!group.has(entry.identity)) group.set(entry.identity, entry);',
    to: '      group.set(Symbol(\'listing\'), entry);',
    why: 'one file listed under one spelling through both roots is reported as two files',
    killed_by: /counts the same physical file reached through both roots once/,
  },
  {
    id: 'A5', file: CHECK,
    from: "        for (const file of key === 'pointer' ? spellings : files) {",
    to: '        for (const file of files) {',
    why: "the collision check groups pointers over deduplicated files, and passes an alias's spelling naming another file",
    killed_by: /lists a lane file under the spelling of a symlinked main home as a pointer collision/,
  },
  {
    id: 'A6', file: CHECK,
    from: '          if (!group.has(file.real)) group.set(file.real, file);',
    to: "          group.set(Symbol('listing'), file);",
    why: 'the collision check reports one file listed under one spelling through both roots as a pair',
    killed_by: /lists a lane file under the spelling of a symlinked main home as a pointer collision/,
  },
  {
    id: 'U1', file: STATE_READERS,
    from: "  if (unlisted.length > 0 || scans.some((scan) => scan.status === 'blocked')) return 'blocked';",
    to: "  if (scans.some((scan) => scan.status === 'blocked')) return 'blocked';",
    why: "an unlistable directory in the read set leaves the ledger, and doctor's continuity criterion, healthy",
    killed_by: /blocks the ledger on a directory of any home in the read set that exists and cannot be listed/,
  },
  {
    id: 'U2', file: STATE_READERS,
    from: '    for (const home of [canonical, legacy]) {',
    to: '    for (const home of [canonical]) {',
    why: 'an unlistable directory in a home not selected for display goes unreported',
    killed_by: /blocks the ledger on a directory of any home in the read set that exists and cannot be listed/,
  },
  {
    id: 'U3', file: STATE_READERS,
    from: "  return scan.status === 'missing' && Boolean(scan.error) && scan.error !== 'ENOENT';",
    to: "  return scan.status === 'missing';",
    why: 'an absent directory (ENOENT, no state) blocks the ledger',
    killed_by: /blocks the ledger on a directory of any home in the read set that exists and cannot be listed/,
  },
  {
    id: 'U4', file: STATE_READERS,
    from: '  const unlisted = unlistedHomes(locations, (home) => home.peer_runs);',
    to: '  const unlisted = [];',
    why: 'an unlistable peer-run ledger directory in the read set reads as no runs',
    killed_by: /blocks the ledger on a directory of any home in the read set that exists and cannot be listed/,
  },
];
