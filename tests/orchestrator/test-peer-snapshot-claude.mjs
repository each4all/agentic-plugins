// C163 D2b — a claude peer runs in a snapshot of the checkout, never the live
// tree, through the orchestrator's peer-runner.mjs and dispatch-peer.mjs, as a
// codex peer has since C96 (tests/orchestrator/test-peer-snapshot.mjs covers
// the codex peer and what the orchestrator keeps of its own). The cases are
// the persona suite's, tests/persona-pipeline/_peer-snapshot-claude-cases.mjs,
// run against the orchestrator's copies.

// C142 O-F2 — this process's judgments read the suites' listing too.
import '../persona-pipeline/_peer-snapshot-listing.mjs';

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanEnv } from '../persona-pipeline/_peer-snapshot-fixtures.mjs';
import { claudePeerCases } from '../persona-pipeline/_peer-snapshot-claude-cases.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORCH = (rel) => join(REPO_ROOT, 'plugins/orchestrator', rel);
const runnerPath = ORCH('scripts/peer-runner.mjs');
const dispatchPath = ORCH('scripts/dispatch-peer.mjs');
const { EVIDENCE_BOUNDARY } = await import(pathToFileURL(ORCH('scripts/lib/evidence-boundary.mjs')).href);

claudePeerCases({
  label: 'orchestrator',
  runner: await import(pathToFileURL(runnerPath).href),
  dispatcher: await import(pathToFileURL(dispatchPath).href),
  runnerPath,
  dispatchPath,
  evidenceBoundary: EVIDENCE_BOUNDARY,
  env: cleanEnv(),
});
