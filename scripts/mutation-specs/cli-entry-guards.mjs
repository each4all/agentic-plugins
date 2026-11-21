// Mutation spec — do the tests catch a CLI entry guard that is not the
// canonical isCliEntry, a copy of the helper that drifts, or a companions
// directory missing the helper its companions import? (C180 part 2, C48)
//
// Run: npm run mutate -- scripts/mutation-specs/cli-entry-guards.mjs
//
// The static rule (tests/plugin-shape/test-cli-entry-guards.mjs) and the
// behaviour it stands for are separate claims, so the guard cases name both:
// C1 puts back the URL comparison the runtime CLIs had (silent through an
// escaped path), and C2 the inline realpath guard the orchestrator had, which
// an import cycle defeats under --preserve-symlinks-main (state.mjs
// set-terminal ran twice). C3 drifts a copy only the parity test holds. C4-C6
// are the sibling rule: discovery, its override diagnosis, and runtime's own
// companion preflight. Six cases, which one `mutate` check runs (AGENTS.md).

const T_GUARDS = 'tests/plugin-shape/test-cli-entry-guards.mjs';
const T_PARITY = 'tests/scripts/test-orchestrator-peer-snapshot-parity.mjs';
const T_DISCOVER = 'tests/companions/test-discover-peer.mjs';
const T_CONTEXT = 'tests/runtime/test-peer-execution-context.mjs';

export const TESTS = [T_GUARDS, T_PARITY, T_DISCOVER, T_CONTEXT];

export const MUTATIONS = [
  {
    id: 'C1', file: 'plugins/runtime/scripts/doctor.mjs', tests: [T_GUARDS],
    from: 'if (isCliEntry(import.meta.url)) {',
    to: 'if (import.meta.url === `file://${process.argv[1]}`) {',
    why: 'runtime doctor compares a URL with a path again, so it exits 0 having done nothing from an escaped path or a symlink',
    killed_by: [/no production file guards its CLI any other way/, /plugins\/runtime\/scripts\/doctor\.mjs: the same run from the repository/],
  },
  {
    id: 'C2', file: 'plugins/orchestrator/scripts/state.mjs', tests: [T_GUARDS],
    from: 'if (isCliEntry(import.meta.url)) {',
    to: 'if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {',
    why: 'orchestrator state.mjs compares realpaths with no first-instance claim, so the instance session-handoff re-imports runs the CLI a second time under --preserve-symlinks-main',
    killed_by: [/no production file guards its CLI any other way/, /set-terminal through a symlinked plugin directory prints one path and records one update/],
  },
  {
    id: 'C3', file: 'plugins/runtime/scripts/lib/cli-entry.mjs', tests: [T_PARITY],
    from: '  if (claims.has(self)) return false;\n',
    to: '',
    why: "runtime's copy of the helper drops the claim, drifting from the source while every guard still reads isCliEntry",
    killed_by: /plugins\/runtime\/scripts\/lib\/cli-entry\.mjs is its notice, then the cli-entry source byte for byte/,
  },
  {
    id: 'C4', file: 'companions/discover-peer.mjs', tests: [T_DISCOVER],
    from: '  if (await missingSibling(companionPath)) return false;\n',
    to: '',
    why: 'discovery picks a newest install missing cli-entry.mjs, whose companion cannot load, over an older complete one',
    killed_by: /a newest install missing cli-entry\.mjs is skipped for an older complete one/,
  },
  {
    id: 'C5', file: 'companions/discover-peer.mjs', tests: [T_DISCOVER],
    from: '    if (sibling) {\n',
    to: '    if (false) {\n',
    why: 'an override directory missing cli-entry.mjs is accepted, and the companion fails to load later with no diagnosis',
    killed_by: /an override directory with the new companions but no cli-entry\.mjs is refused, naming it/,
  },
  {
    id: 'C6', file: 'plugins/runtime/scripts/lib/peer-execution-context.mjs', tests: [T_CONTEXT],
    from: '  const usable = compatible && missingSibling === null;\n',
    to: '  const usable = compatible;\n',
    why: 'runtime reports a companion missing the cli-entry.mjs it imports as available',
    killed_by: /a companion missing the cli-entry\.mjs it imports is blocked, naming it/,
  },
];
