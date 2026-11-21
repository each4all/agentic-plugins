// How the repository's own tools tell that they are the process entry point
// (ADR-0066 D1, C180, C48): isCliEntry compares both sides canonical, as
// paths, and lets only the first instance of a file claim the entry, so a tool
// reached through a symlink, under a directory whose name needs URL escaping,
// or with --preserve-symlinks-main runs exactly once.
//
// One implementation: this re-exports the persona pipeline's canonical source,
// as exit-after-flush.mjs does. The tools here belong to no package and ship
// nowhere, so they import the source in place rather than keep a copy of their
// own; tests/plugin-shape/test-cli-entry-guards.mjs holds every entry guard of
// the repository to this rule.

export { isCliEntry } from '../../persona-pipeline/files/scripts/lib/cli-entry.mjs';
