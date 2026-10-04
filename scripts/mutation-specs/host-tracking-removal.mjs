// Mutation spec — does ADR-0060's removal say what it no longer checks?
//
// Run: npm run mutate -- scripts/mutation-specs/host-tracking-removal.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. A removal is judged by what is left behind, and
// every rule below fails quietly:
//
//   - doctor and dashboard could stop reading one retained doctor era, which
//     blocks the whole collection with no operator path back;
//   - the recomposed parity criterion could lose a row of its matrix.
//
// Groups: D doctor, B the dashboard reader, G the executor guard's network-gate
// (no real runtime script is a network importer since compat.mjs went, so its
// cases run against an injected registry — and must still bite).
//
// D1 and B1 drop the LAST readable pair — the era doctor now writes. ADR-0064
// R4n2 moved that era from 1.3 to 1.4 (Decision 7), so both anchors moved with
// it; 1.3 is now a retained older era, as 1.2 is for D2.
//
// The C group (the cutover audit's "host-pair identity is not verified"
// statement) and the W group (its withdrawn scorecard row) went with
// `cutover-audit.mjs` when ADR-0064 §Decision 5 retired `runtime:cutover`:
// the rules they guarded have no code left to break.

const T_DOC = 'tests/runtime/test-doctor.mjs';
const T_DUAL = 'tests/runtime/test-doctor-schema-dual-read.mjs';
const T_GUARD = 'tests/plugin-shape/test-runtime-executor-guard.mjs';

const DOCTOR = 'plugins/runtime/scripts/doctor.mjs';
const DASHBOARD = 'plugins/runtime/scripts/dashboard.mjs';
const SCAN = 'tests/plugin-shape/runtime-executor-scan.mjs';

export const TESTS = [T_DOC, T_DUAL, T_GUARD];

export const MUTATIONS = [
  // ---- D: doctor's schema and the recomposed criterion ---------------------
  {
    id: 'D1', file: DOCTOR, tests: [T_DOC],
    from: "  Object.freeze({ artifact: 'runtime-doctor-artifact-1.4', report: 'runtime-doctor-1.4' }),\n]);\nfunction isReadableDoctorSchemaPair(",
    to: ']);\nfunction isReadableDoctorSchemaPair(',
    why: 'doctor stops reading the era it now writes',
  },
  {
    id: 'D2', file: DOCTOR, tests: [T_DOC],
    from: "  Object.freeze({ artifact: 'runtime-doctor-artifact-1.2', report: 'runtime-doctor-1.2' }),\n  // 1.3 — ADR-0060",
    to: '  // 1.3 — ADR-0060',
    why: 'doctor stops reading the previous era — every retained 1.2 artifact turns malformed',
  },
  {
    id: 'D3', file: DOCTOR, tests: [T_DOC],
    from: "    status: missing ? 'partial' : 'satisfied',",
    to: "    status: 'satisfied',",
    why: 'a missing collection no longer lowers the handoff criterion',
  },
  {
    id: 'D4', file: DOCTOR, tests: [T_DOC],
    from: "  if (settingsRuns.status === 'blocked' || consensusRuns.status === 'blocked') {",
    to: "  if (consensusRuns.status === 'blocked') {",
    why: 'a malformed settings artifact no longer blocks the handoff criterion',
  },
  {
    id: 'D6', file: DOCTOR, tests: [T_DOC],
    from: "  if (settingsRuns.status === 'blocked' || consensusRuns.status === 'blocked') {",
    to: "  if (settingsRuns.status === 'blocked') {",
    why: 'a blocked consensus collection no longer blocks the handoff criterion (the mirror of D4, found in review)',
  },
  {
    id: 'D7', file: DOCTOR, tests: [T_DOC],
    from: "  const missing = [settingsRuns.status, consensusRuns.status].some((value) => value === 'missing');",
    to: "  const missing = [settingsRuns.status, consensusRuns.status].every((value) => value === 'missing');",
    why: 'the criterion reads partial only when BOTH collections are missing',
  },
  {
    id: 'D5', file: DOCTOR, tests: [T_DOC],
    from: "    schema_version: 'runtime-experience-parity-1.2',",
    to: "    schema_version: 'runtime-experience-parity-1.1',",
    why: 'the recomposed criterion is scored under the old version',
  },
  // ---- B: the dashboard reader pins independently --------------------------
  {
    id: 'B1', file: DASHBOARD, tests: [T_DUAL],
    from: "  Object.freeze({ artifact: 'runtime-doctor-artifact-1.4', report: 'runtime-doctor-1.4' }),\n]);",
    to: ']);',
    why: 'the dashboard stops reading the era doctor now writes',
  },
  // ---- G: the network-gate still bites without a real importer ---------------
  {
    id: 'G1', file: SCAN, tests: [T_GUARD],
    from: "  if (isImporter && importerSpec.modules.some((m) => m === 'node:http' || m === 'node:https' || m === 'node:net' || m === 'node:http2')) {",
    to: '  if (false) {',
    why: 'the network-gate never runs',
  },
];
