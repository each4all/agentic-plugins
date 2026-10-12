// Mutation spec — do the entry-brief reader tests catch the defects C124 and
// C122 exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/entry-brief-readers.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Each rule here fails quietly. A reader that
// reads through a link out of the state homes relays another directory's
// workflow as this branch's; a frontmatter scan that loses a close split
// across two reads, or takes a short read for the end of the file, calls a
// good workflow unparseable; a bound that is never checked reads without
// limit; a skipped source whose reason is not a registry code carries file
// text into the injected brief. A green suite proves none of this; breaking
// each rule and watching a named test fail does. The ADR-0067 read-set rules
// these readers also hold are in shared-state-readers.mjs.

const READERS_T = 'tests/runtime/test-entry-brief-readers.mjs';
const ARBITER_T = 'tests/runtime/test-entry-brief-arbiter.mjs';
const CONTEXT_T = 'tests/runtime/test-context-entry-brief.mjs';
const READERS = 'plugins/runtime/scripts/lib/entry-brief-readers.mjs';
const ARBITER = 'plugins/runtime/scripts/lib/entry-brief-arbiter.mjs';
const CONTEXT = 'plugins/runtime/scripts/context.mjs';

export const TESTS = [READERS_T];

export const MUTATIONS = [
  // C122 — containment and identity.
  {
    id: 'K1', file: READERS,
    from: "\n  if (!(await insideHomes(real, roots, io))) return { state: 'refused', reason: 'symlink-outside-state' };",
    to: '\n  void insideHomes;',
    why: 'a link out of the state homes is opened before it is judged, so a device or a FIFO outside is touched (the check after the open still refuses it)',
    killed_by: /refuses a link out of the state homes/,
  },
  {
    id: 'K22', file: READERS,
    from: "\n    if (!(await insideHomes(real, roots, io))) return { state: 'refused', reason: 'symlink-outside-state' };",
    to: '\n    void insideHomes;',
    why: 'the path is not judged again after the open, so one rename that moves the checked file out of its home, a link left in its place, is read as inside (critique MAJOR)',
    killed_by: /judges the path again after the open/,
  },
  {
    id: 'K23', file: READERS,
    from: '    if (after.isSymbolicLink() || identityOf(after) !== identityOf(opened)) {',
    to: '    if (false) {',
    why: 'after the open the path is not held to name the file the handle holds, so a file renamed over it is read as the one checked',
    killed_by: /judges the path again after the open/,
  },
  {
    id: 'K28', file: READERS,
    from: '      const found = await ancestryAt(holder, io);\n',
    to: "      const found = await ancestryAt(holder, io);\n      if (found.error) return { state: 'refused', reason: 'home-unresolvable' };\n",
    why: 'a holder that cannot be resolved degrades every persona, so a broken `.claude` hides founder\'s and designer\'s workflows, which have no legacy home',
    killed_by: /degrades on a home that exists and cannot be resolved/,
  },
  {
    id: 'K26', file: READERS,
    from: '      st = await io.lstat(dir, { bigint: true });\n    } catch {\n      return false;',
    to: '      st = await io.lstat(dir, { bigint: true });\n    } catch {\n      return true;',
    why: 'a directory the walk cannot describe counts as inside a home, so the containment fails open',
    killed_by: /refuses an entry whose directory the walk cannot describe/,
  },
  {
    id: 'K27', file: READERS,
    from: 'const realpath = promisify(realpathCallback);',
    to: 'const realpath = promisify(realpathCallback.native);',
    why: 'identities are resolved by the native resolver, which canonicalizes case where the owners\' realpathSync keeps a link\'s spelling, so a file the owners count twice is one here (critique MAJOR)',
    killed_by: /resolves a link's identity as the owners do/,
  },
  {
    id: 'K2', file: READERS,
    from: "    if (identityOf(opened) !== identityOf(checked)) return { state: 'refused', reason: 'workflow-identity-changed' };",
    to: '    void opened;',
    why: 'the file opened is not checked to be the file whose path was checked, so an ancestor swapped for a link outside yields outside content',
    killed_by: /never yields outside content when a path is swapped/,
  },
  {
    id: 'K3', file: READERS,
    from: '  return `${st.dev}:${st.ino}`;',
    to: '  return `${Number(st.dev)}:${Number(st.ino)}`;',
    why: 'identities are compared as Numbers, and two inodes past 2^53 that round alike pass as one file',
    killed_by: /compares identities as bigints/,
  },
  {
    id: 'K4', file: READERS,
    from: '      if (present.some(({ identity, chain }) => found.chain.has(identity) || chain.has(found.identity))) {',
    to: '      if (false) {',
    why: 'a home that is another persona\'s home is read as this persona\'s, and its files become this persona\'s workflows',
    killed_by: [/refuses a home that is another persona's home/, /refuses a home inside another persona's home or holding one/],
  },
  {
    id: 'K24', file: READERS,
    from: '      if (present.some(({ identity, chain }) => found.chain.has(identity) || chain.has(found.identity))) {',
    to: '      if (present.some(({ identity }) => identity === found.identity)) {',
    why: 'only an identical home counts as another persona\'s, so a home inside one, or holding one, reads that persona\'s files as its own (critique MAJOR)',
    killed_by: /refuses a home inside another persona's home or holding one/,
  },
  {
    id: 'K25', file: READERS,
    from: '      if (found.identity && present.some(({ identity }) => found.chain.has(identity))) {',
    to: '      if (false) {',
    why: 'a home linked to the state directory, the checkout or `/` holds every file under it, and a link to any of them is read as inside (critique MAJOR)',
    killed_by: /refuses a home that holds a state root or its state directory/,
  },
  {
    id: 'K5', file: READERS,
    from: "    const found = await ancestryAt(home.root, io);\n    if (found.error) return { state: 'refused', reason: 'home-unresolvable' };",
    to: "    const found = await ancestryAt(home.root, io);\n    if (found.error) continue;",
    why: 'a home that exists and cannot be resolved reads as no state, and a workflow in it goes unseen',
    killed_by: /degrades on a home that exists and cannot be resolved/,
  },
  {
    id: 'K6', file: READERS,
    from: "    return link ? { state: 'gone' } : { state: 'vanished' };",
    to: "    return { state: 'vanished' };",
    why: 'a link to nothing is taken for a file archived mid-scan, and the source degrades after the last listing instead of skipping it as the owners do',
    killed_by: /skips a link to nothing as gone/,
  },
  {
    id: 'K7', file: READERS,
    from: '  return (names.find(({ link }) => !link) ?? names[0]).pointer;',
    to: '  return names[0].pointer;',
    why: 'the pointer is the name listed first, a link\'s when the listing yields it first, not the plain name the owners keep',
    killed_by: /reads a long body and an in-home link/,
  },
  // C124 — frontmatter-only reads.
  {
    id: 'K8', file: READERS,
    from: "      if (verdict.end > max) return { state: 'refused', reason: 'frontmatter-over-read-bound', bytes: length };",
    to: '      void max;',
    why: 'a close ending past the bound is accepted, so the bound does not bound what is read',
    killed_by: /accepts a close ending exactly at the bound and refuses one ending a byte past it/,
  },
  {
    id: 'K9', file: READERS,
    from: '        searchFrom = Math.max(bodyStart, length - (CLOSE_FENCE.length - 1));',
    to: '        searchFrom = length;',
    why: 'a close that begins in one read and ends in the next is never found, and the workflow reads as unparseable',
    killed_by: /finds a close split across reads/,
  },
  {
    id: 'K10', file: READERS,
    from: ['    if (bytesRead === 0) eof = true;', '    else length += bytesRead;'].join('\n'),
    to: ['    if (bytesRead < want) eof = true;', '    length += bytesRead;'].join('\n'),
    why: 'a short read is taken for the end of the file, and a frontmatter read in pieces reads as unterminated',
    killed_by: /reads on after a short read/,
  },
  {
    id: 'K11', file: READERS,
    from: "  if (cache.has(version)) return { state: 'ok', identity, link, lines: cache.get(version), bytes: 0 };",
    to: '  void cache;',
    why: 'a file reached again through a link is read and charged again, and a home within its budget is refused',
    killed_by: /charges the home budget with bytes read/,
  },
  // The code-review verify (run plan-verify-20261012T223540Z-15fdd7f6).
  {
    id: 'K21', file: READERS,
    from: '    checked = await io.stat(real, { bigint: true });',
    to: '    checked = await io.stat(real);',
    why: 'the checked identity is read as Numbers, and two inodes past 2^53 that round alike pass as one file',
    killed_by: /compares identities as bigints/,
  },
  {
    id: 'K16', file: READERS,
    from: "    return { state: 'ok', identity, link, lines, bytes: head.bytes };",
    to: "    return { state: 'ok', identity, link, lines, bytes: head.state === 'ok' ? Buffer.byteLength(head.text) : 0 };",
    why: 'the budget is charged with the frontmatter kept, not the bytes the reads took, so it does not bound what is read',
    killed_by: /charges what the reads took, not the frontmatter kept/,
  },
  {
    id: 'K17', file: READERS,
    from: '  let dirBytes = 0;\n  for (let attempt = 0; attempt < caps.MAX_SCAN_ATTEMPTS; attempt++) {',
    to: '  for (let attempt = 0; attempt < caps.MAX_SCAN_ATTEMPTS; attempt++) {\n    let dirBytes = 0;',
    why: 'each relist starts a fresh budget while the files already read cost nothing, so a directory reads past its budget',
    killed_by: /keeps one budget across the listings of a directory/,
  },
  {
    id: 'K18', file: READERS,
    from: '  const version = `${identity}\\0${identityOf(checked)}:${checked.size}:${checked.mtimeNs}`;',
    to: '  const version = `${identity}\\0${identityOf(checked)}`;',
    why: 'a file rewritten in place between two listings is served from the first read, and the brief reports its old state',
    killed_by: /reads a file again on a relist when it was rewritten in place/,
  },
  {
    id: 'K19', file: READERS,
    from: '    if (st.isSymbolicLink()) return false;',
    to: '    void st;',
    why: 'an ancestor swapped for a link right after the realpath is walked through by its lexical parent, and outside content is read as inside',
    killed_by: /never yields outside content when a path is swapped/,
  },
  {
    id: 'K20', file: READERS,
    from: "    if (homeAmbiguity(scan.occurrences, new Set([identity])) !== null) return indeterminate(base, 'dual-home-ambiguity');",
    to: "    if (homeAmbiguity(scan.occurrences, new Set(matched.map((m) => m.identity))) !== null) return indeterminate(base, 'dual-home-ambiguity');",
    why: 'an active macro and a different macro bridging the branch are judged as a pair, and a legitimate bridge degrades',
    killed_by: /reads an active macro and a different macro bridging the same branch as no pair/,
  },
  // Skipped-source diagnostics.
  {
    id: 'K12', file: READERS,
    from: '      reason: ENTRY_READER_REASON_CODES.has(value.reason) ? value.reason : null,',
    to: '      reason: value.reason ?? null,',
    tests: [READERS_T, ARBITER_T],
    why: 'a reason outside the registry crosses into the brief, which is how file text would reach the injected line',
    killed_by: [/withholds a reason outside the registry/, /never from a list the caller passed/],
  },
  {
    id: 'K13', file: ARBITER,
    from: '  const skippedSources = skippedSourcesOf(sources);',
    to: '  const skippedSources = collected.skipped_sources ?? [];',
    tests: [ARBITER_T],
    why: 'the brief relays the list the caller passed instead of deriving it from the sources it arbitrated',
    killed_by: /never from a list the caller passed/,
  },
  {
    id: 'K14', file: ARBITER,
    from: '  if (!Array.isArray(brief.skipped_sources) || brief.skipped_sources.length !== brief.sources_skipped) {',
    to: '  if (false) {',
    tests: [ARBITER_T],
    why: 'a brief whose skipped list disagrees with its count, or has none, passes the semantic validator',
    killed_by: [/catches a count the skipped list does not match/, /catches a missing skipped list/],
  },
  {
    id: 'K15', file: CONTEXT,
    from: '      rows_dropped: candidate.rows_dropped + 1,',
    to: '      rows_dropped: candidate.rows_dropped + 1,\n      skipped_sources: [],\n      sources_skipped: 0,',
    tests: [CONTEXT_T],
    why: 'the line-cap shrink drops the skipped sources with the rows, and the emitted line hides which sources degraded',
    killed_by: /line-cap shrink drops tail rows deterministically/,
  },
];
