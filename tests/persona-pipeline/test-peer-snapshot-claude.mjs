// C163 D2b — a claude peer runs in a snapshot of the checkout, never the live
// tree, through each persona's peer-runner.mjs and dispatch-peer.mjs, as a
// codex peer has since C96 (tests/persona-pipeline/test-peer-snapshot.mjs
// covers the snapshot library and the codex peer). The cases are in
// _peer-snapshot-claude-cases.mjs, shared with the orchestrator's suite; they
// run once for every persona the persona-pipeline manifest generates the
// dispatchers into (ADR-0066 Decision 5).

// C142 O-F2 — this process's judgments read the suites' listing too.
import './_peer-snapshot-listing.mjs';

import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo } from './_personas.mjs';
import { cleanEnv } from './_peer-snapshot-fixtures.mjs';
import { claudePeerCases } from './_peer-snapshot-claude-cases.mjs';

for (const persona of personasFor('scripts/lib/peer-snapshot.mjs')) {
  const P = personaInfo(persona);
  const runnerPath = P.path('scripts/peer-runner.mjs');
  const dispatchPath = P.path('scripts/dispatch-peer.mjs');
  const { EVIDENCE_BOUNDARY } = await import(pathToFileURL(P.path('scripts/lib/evidence-boundary.mjs')).href);
  claudePeerCases({
    label: persona,
    runner: await import(pathToFileURL(runnerPath).href),
    dispatcher: await import(pathToFileURL(dispatchPath).href),
    runnerPath,
    dispatchPath,
    evidenceBoundary: EVIDENCE_BOUNDARY,
    env: cleanEnv(),
  });
}
