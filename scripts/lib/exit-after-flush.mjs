// How the repository's own tools exit (the owner's discussion-2 decision R2,
// docket C93): process.exit() drops whatever stdout and stderr still hold, so
// each tool returns its code to its entry tail, which calls exitAfterFlush once.
//
// One implementation: this re-exports the persona pipeline's canonical source.
// The drift check holds each persona plugin's generated copy to that source,
// and tests/persona-pipeline/test-exit-after-flush.mjs tests the helper's
// behaviour in every copy; tests/scripts/test-exit-after-flush-reexport.mjs
// shows these bindings are the source's own. The
// tools here belong to no package and ship nowhere, so they import the source
// in place rather than keep a copy of their own (kit/README.md says what
// lifting kit/lint out of the repository takes).

export {
  absorbOutputErrors,
  exitAfterFlush,
  FLUSH_FALLBACK_MS,
} from '../../persona-pipeline/files/scripts/lib/cli-entry.mjs';
