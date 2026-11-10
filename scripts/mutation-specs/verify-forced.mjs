// Mutation spec — the owner's forced verification step below HIGH (C168;
// ADR-0068 implementation note 2026-11-03).
//
// Run: npm run mutate -- scripts/mutation-specs/verify-forced.mjs
//
// The owner's `--next verify` on a request below HIGH authorizes that
// request's checks and the resume of its requesting verb, bound to the
// workflow, the request id and the batches the driver's journal started for
// it. Each case below breaks one piece of that: the mark on the forced batch's
// start, the fact the driver takes from its journal, the policy's use of it,
// the binding to the request, the subtask and the chain of continuations, the
// step's own refusal, the end a record set aside makes, and the binding to
// the journal's last start that keeps a record put back from reviving it. Each names the
// test that must notice. The F cases run the step and policy file alone (well
// under a minute); the G cases need the driver or the scheduler end to end.

const T_FORCED = 'tests/orchestrator/test-autopilot-verify-forced.mjs';
const T_FDRV = 'tests/orchestrator/test-autopilot-verify-forced-driver.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';

export const TESTS = [T_FORCED, T_FDRV];

const RESUMES = /a forced MEDIUM batch that fails is journalled forced, and the next look resumes the requesting verb/;

export const MUTATIONS = [
  // ---- F: the journal, the facts, the policy and the step -------------------
  {
    id: 'F1', file: `${AP}/policy.mjs`, tests: [T_FORCED],
    from: "      if (ns.confidence !== 'HIGH' && !ownerForced) {",
    to: "      if (ns.confidence !== 'HIGH') {",
    why: 'the policy halts a forced request below HIGH low-confidence after its batch, as before C168: every batch needs another forced step',
    killed_by: [/a forced request whose batch failed or gave no evidence resumes the requesting verb/, RESUMES],
  },
  {
    id: 'F2', file: `${AP}/policy.mjs`, tests: [T_FORCED],
    from: "typeof vf?.forced?.batch_id === 'string' && vf.forced.request_id === child.verify?.request_id;",
    to: "typeof vf?.forced?.batch_id === 'string';",
    why: 'a replacement request inherits the authorization the owner gave the request it replaced',
    killed_by: /a replacement request never inherits the authorization/,
  },
  {
    id: 'F3', file: `${AP}/verify-run.mjs`, tests: [T_FORCED],
    from: '      const f = forcedAuthority(entries, { requestId: c.verify.request_id, batchId: c.verify.last_batch ?? null, subtaskId: id });',
    to: '      const f = null;',
    why: 'the driver never takes the authorization from its journal: the policy halts a forced request again after its batch',
    killed_by: RESUMES,
  },
  {
    id: 'F4', file: `${AP}/verify-run.mjs`, tests: [T_FORCED],
    from: '    ...(ownerForced ? { forced: true } : {}),',
    to: '    ...({}),',
    why: 'the forced step\'s batch start carries no mark, so nothing in the journal says the owner authorized it',
    killed_by: RESUMES,
  },
  {
    id: 'F5', file: `${AP}/verify-run.mjs`, tests: [T_FORCED],
    from: '  if (below && !ownerForced) {',
    to: '  if (false) {',
    why: 'a step that is not the owner\'s runs a request below HIGH that no forced batch covers',
    killed_by: /a step that is not the owner's, on a request below HIGH no forced batch covers, runs nothing/,
  },
  {
    id: 'F6', file: `${AP}/verify-run.mjs`, tests: [T_FORCED],
    from: "    if (p.action === 'restart') {",
    to: '    if (false) {',
    why: 'a record set aside keeps the authorization: an unforced step restarts a request below HIGH, on the first plan or on the one made after an open batch is ended',
    killed_by: [/a record set aside ends the authorization/, /an edit that makes the record one the journal does not hold \(a restart\) runs nothing/],
  },
  {
    id: 'F7', file: `${AP}/verify-journal.mjs`, tests: [T_FORCED],
    from: "    if (start.op === 'restart') return null;\n",
    to: '',
    why: 'the authorization survives a restart, which continues nothing',
    killed_by: /ends at a restart, which continues nothing/,
  },
  {
    id: 'F8', file: `${AP}/verify-journal.mjs`, tests: [T_FORCED],
    from: '    if (subtaskId !== null && start.meta?.subtask_id !== subtaskId) return null;\n',
    to: '',
    why: 'another lane\'s forced batch authorizes this lane',
    killed_by: /is never another request's, another subtask's/,
  },
  {
    id: 'F9', file: `${AP}/verify-journal.mjs`, tests: [T_FORCED],
    from: '    cur = start.payload?.continues ?? null;\n  }\n  return null;\n}',
    to: '    cur = null;\n  }\n  return null;\n}',
    why: 'a batch continuing the forced one (a continuation cut short in turn) is not covered: the next look halts it low-confidence',
    killed_by: [/names the forced batch, for it and for every batch continuing it/, /a continuation of a forced batch, cut short in turn, is still covered/],
  },
  {
    id: 'F10', file: `${AP}/verify-journal.mjs`, tests: [T_FORCED],
    from: '    if (start.meta?.forced === true) return { request_id: requestId, batch_id: cur };',
    to: '    if (start.meta?.forced !== false) return { request_id: requestId, batch_id: cur };',
    why: 'a journal written before this release, whose starts hold no mark, reads as forced',
    killed_by: /reads a journal written before this release/,
  },
  {
    id: 'F11', file: `${AP}/verify-run.mjs`, tests: [T_FORCED],
    from: "    if ((p.action === 'start' && !p.continues) || p.action === 'reuse') {",
    to: '    if (false) {',
    why: 'an unforced step starts a new batch of a request below HIGH when an edit after the end of an open batch empties the record',
    killed_by: /an edit that empties its batches \(a new batch\) runs nothing/,
  },
  {
    id: 'F12', file: `${AP}/verify-journal.mjs`, tests: [T_FORCED],
    from: '  if (!last || last.batch_id !== batchId) return null;',
    to: '  if (!last) return null;',
    why: 'a record put back to an earlier batch, after its continuation passed and was answered, revives the expired authorization',
    killed_by: [/holds only from the last batch the journal started/, /a record put back to an earlier batch after its continuation passed and was answered/],
  },
  // ---- G: the driver and the scheduler, end to end --------------------------
  {
    id: 'G1', file: `${AP}/driver.mjs`, tests: [T_FDRV],
    from: '        forced: s.forced === true,\n        requestKnown',
    to: '        forced: false,\n        requestKnown',
    why: 'the serial driver does not tell the step it is the owner\'s: the forced batch never runs',
    killed_by: /the owner's --next verify on a MEDIUM request whose batch fails resumes the requesting verb/,
  },
  {
    id: 'G2', file: `${AP}/scheduler.mjs`, tests: [T_FDRV],
    from: '      forced: s.forced === true,\n      requestKnown',
    to: '      forced: false,\n      requestKnown',
    why: 'the scheduler does not tell the step it is the owner\'s: a lane\'s forced batch never runs',
    killed_by: /`--lane A --next verify` on a MEDIUM request whose batch fails resumes the requesting verb in the lane/,
  },
  {
    id: 'G3', file: `${AP}/policy.mjs`, tests: [T_FDRV],
    from: "      if (ns.confidence !== 'HIGH' && !ownerForced) {",
    to: "      if (ns.confidence !== 'HIGH') {",
    why: 'C168 as found: after the owner\'s forced batch fails, the run halts low-confidence again instead of resuming the verb, serial and with lanes',
    killed_by: [/the owner's --next verify on a MEDIUM request whose batch fails resumes the requesting verb/, /a forced MEDIUM batch that ends with no evidence resumes/, /`--lane A --next verify` on a MEDIUM request whose batch fails resumes/],
  },
];
