// Mutation spec — does ADR-0060's removal say what it no longer checks?
//
// Run: npm run mutate -- scripts/mutation-specs/host-tracking-removal.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. A removal is judged by what is left behind, and
// every rule below fails quietly:
//
//   - the cutover audit could drop its "host-pair identity is not verified"
//     statement and still report `cutover-ready-candidate`, which would then read
//     as a verdict about the hosts in use (ADR-0060 §Decision 3: an absent check
//     must not read as a passing one);
//   - the statement could become a blocker no operator can clear, or a pass;
//   - a failed version probe's stderr could be reported as an observed version;
//   - doctor and dashboard could stop reading one retained doctor era, which
//     blocks the whole collection with no operator path back;
//   - the recomposed parity criterion could lose a row of its matrix.
//
// Groups: C cutover, D doctor, B the dashboard reader, G the executor guard's
// network-gate (no real runtime script is a network importer since compat.mjs
// went, so its cases run against an injected registry — and must still bite).

const T_CUT = 'tests/runtime/test-cutover-audit.mjs';
const T_DOC = 'tests/runtime/test-doctor.mjs';
const T_DUAL = 'tests/runtime/test-doctor-schema-dual-read.mjs';
const T_GUARD = 'tests/plugin-shape/test-runtime-executor-guard.mjs';

const CUTOVER = 'plugins/runtime/scripts/cutover-audit.mjs';
const DOCTOR = 'plugins/runtime/scripts/doctor.mjs';
const DASHBOARD = 'plugins/runtime/scripts/dashboard.mjs';
const SCAN = 'tests/plugin-shape/runtime-executor-scan.mjs';

export const TESTS = [T_CUT, T_DOC, T_DUAL, T_GUARD];

export const MUTATIONS = [
  // ---- C: the audit states what it does not verify -------------------------
  {
    id: 'C1', file: CUTOVER, tests: [T_CUT],
    from: '      HOST_PAIR_IDENTITY_LIMIT,\n',
    to: '',
    why: 'the audit stops saying host-pair identity is not verified',
  },
  {
    id: 'C2', file: CUTOVER, tests: [T_CUT],
    from: "    status: 'not_verified',\n",
    to: "    status: 'satisfied',\n",
    why: 'the absent check reads as a passing one',
  },
  {
    id: 'C3', file: CUTOVER, tests: [T_CUT],
    from: "      .filter((entry) => entry.status === 'not_verified')",
    to: '      .filter(() => false)',
    why: 'the completion audit drops the unverified scope',
  },
  {
    id: 'C4', file: CUTOVER, tests: [T_CUT],
    from: "      version: probe === 'available' && typeof version?.text === 'string' && version.text.length > 0 ? version.text : null,",
    to: "      version: typeof version?.text === 'string' && version.text.length > 0 ? version.text : null,",
    why: "a failed probe's error text is reported as an observed version",
  },
  {
    id: 'C5', file: CUTOVER, tests: [T_CUT],
    from: "  return !CHECK_PASS.has(status) && status !== 'manual';",
    to: '  return true;',
    why: 'a passing check is listed as something to remediate',
  },
  {
    id: 'C6', file: CUTOVER, tests: [T_CUT],
    from: '  const observations = [observeHostPairIdentity(doctor)];',
    to: '  const observations = [];',
    why: 'the identity observation disappears from the report',
  },
  // ---- D: doctor's schema and the recomposed criterion ---------------------
  {
    id: 'D1', file: DOCTOR, tests: [T_DOC],
    from: "  Object.freeze({ artifact: 'runtime-doctor-artifact-1.3', report: 'runtime-doctor-1.3' }),\n]);\nfunction isReadableDoctorSchemaPair(",
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
  // ---- W: a withdrawn scorecard row (R9, by owner decision) -----------------
  {
    id: 'W1', file: CUTOVER, tests: [T_CUT],
    from: "  const active = statuses.filter((row) => row.status !== 'withdrawn');",
    to: '  const active = statuses;',
    why: 'a withdrawn row counts as unresolved and holds readiness on work nobody can do',
  },
  {
    id: 'W2', file: CUTOVER, tests: [T_CUT],
    from: '    } else if (!adrWithdrawsRequirement(text, requirement)) {',
    to: '    } else if (false) {',
    why: 'any accepted ADR mention withdraws any row (cross-host refine-verify MAJOR)',
  },
  {
    id: 'W3', file: CUTOVER, tests: [T_CUT],
    from: "  return withdrawn.length ? `; withdrawn=${withdrawn.map((row) => row.requirement).join(', ')}` : '';",
    to: "  return '';",
    why: 'the count reads 100% without saying its denominator shrank',
  },
  {
    id: 'W4', file: CUTOVER, tests: [T_CUT],
    from: "  if (cited.length === 0) return { status: 'withdrawn-uncited', decision: null, problem: 'the row cites no ADR' };",
    to: '',
    why: 'an uncited withdrawal is not named as uncited',
  },
  {
    id: 'W5', file: CUTOVER, tests: [T_CUT],
    from: '    } else if (!adrStatusIsAccepted(text)) {',
    to: '    } else if (false) {',
    why: 'a proposed ADR withdraws a requirement',
  },
  {
    id: 'W6', file: CUTOVER, tests: [T_CUT],
    from: "      .filter((row) => row.status !== 'satisfied' && row.status !== 'withdrawn')",
    to: "      .filter((row) => row.status !== 'satisfied')",
    why: 'a verified withdrawal is listed as a blocker beside a ready verdict (cross-host refine-verify MAJOR)',
  },
  {
    id: 'W7', file: CUTOVER, tests: [T_CUT],
    from: '    if (idCounts.get(row[0]) > 1) {',
    to: '    if (false) {',
    why: 'a duplicated requirement id counts in two places',
  },
  {
    id: 'W8', file: CUTOVER, tests: [T_CUT],
    from: "    status: active.length === 0 ? 'missing' : unresolved.length === 0 ? 'satisfied' : 'partial',",
    to: "    status: rows.length === 0 ? 'missing' : unresolved.length === 0 ? 'satisfied' : 'partial',",
    why: 'a scorecard whose every row is withdrawn reads satisfied',
  },
  // ---- B: the dashboard reader pins independently --------------------------
  {
    id: 'B1', file: DASHBOARD, tests: [T_DUAL],
    from: "  Object.freeze({ artifact: 'runtime-doctor-artifact-1.3', report: 'runtime-doctor-1.3' }),\n]);",
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
