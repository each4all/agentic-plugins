// Mutation spec — do the ADR-0068 Decision 8 tests catch the defects they
// exist for? (impl-rebind, docket C147)
//
// Run: npm run mutate -- scripts/mutation-specs/orchestrator-rebind.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. A rebinding loosens the one check that keeps
// a child's work bound to the subtask it was dispatched for, so every defect
// here fails open and silently: a comparison that skips the approval's
// freshness, the child, the words or the note binds work to instructions the
// owner never approved for it, or that the child was never told; an approval
// that does not join the run lock passes between two looks of a live run; a
// delivery acknowledged without its note, or told twice, leaves the record
// and the child disagreeing. Each case names the test that must catch it.
//
// Groups: R the record, D the approval's derivation and view, A its
// admission and blockers, W its write, N the note, C the comparison, B the
// driver's boundary and the parks, V the vouch at the binding writes, K the
// runbooks.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TR = 'tests/orchestrator/test-plan-rebind.mjs';
const TA = 'tests/orchestrator/test-autopilot-rebind.mjs';
const TRB = 'tests/orchestrator/test-approve-runbook.mjs';
const TD = 'tests/orchestrator/test-done-runbook.mjs';

const STATE = 'plugins/orchestrator/scripts/state.mjs';
const LIB = 'plugins/orchestrator/scripts/lib/rebind.mjs';
const DRIVER = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const SCHED = 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs';
const POLICY = 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs';
const BOUNDARY = 'plugins/orchestrator/adapters/claude/autopilot/rebind-boundary.mjs';
const APPROVE_MD = 'plugins/orchestrator/commands/approve.md';
const DONE_MD = 'plugins/orchestrator/commands/done.md';
const DONE_SKILL = 'plugins/orchestrator/core/skills/done/SKILL.md';
const RUNLOCKS = 'plugins/orchestrator/scripts/lib/run-locks.mjs';

export const TESTS = [TR];

// The test of the release before reads it from its tag, which a harness copy
// lacks (the copy has no history): its case puts the tagged scripts where the
// test looks first, `.released/<tag>`, read from the repository this spec is in.
const SOURCE = fileURLToPath(new URL('../..', import.meta.url));
const RELEASED_TAG = 'plugin-orchestrator-v0.27.0';
function supplyReleased(copy) {
  const tar = execFileSync('git', ['-C', SOURCE, 'archive', RELEASED_TAG, 'plugins/orchestrator/scripts'], { maxBuffer: 64 * 1024 * 1024 });
  const dest = join(copy, '.released', RELEASED_TAG);
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
}

export const MUTATIONS = [
  // ---- R: the record ---------------------------------------------------------
  {
    id: 'R1', file: STATE, tests: [TR],
    from: '    lines.push(`${key}: ${yamlScalar(value)}`);',
    to: "    if (key === 'plan_rebindings') { lines.push(`${key}:`); lines.push(`  json: ${yamlScalar(value)}`); continue; }\n    lines.push(`${key}: ${yamlScalar(value)}`);",
    killed_by: [/a topic revised and approved while the child works/],
    why: 'the record is written as a block key, which no reader takes',
  },
  {
    id: 'R5', file: LIB, tests: [TR], prepare: supplyReleased,
    from: '  return record.approval.id === now.id && record.approval.at === now.at && record.approval.hash === now.hash;',
    to: '  return record.approval.id === now.id && record.approval.hash === now.hash;',
    killed_by: [/reads and rewrites a macro holding a rebinding, carrying both keys byte for byte, and never honors it/,
      /an approval stamp that is not the record's \(an older approver's\) rebinds nothing/],
    why: 'the stamp ignores its time, so the release before, approving the same plan with the id it does not know ' +
      'kept, renews a record it never read (the release before runs from the tagged tree the case supplies)',
  },
  {
    // R5's control: the tagged tree supplied, and nothing that matters
    // changed, the test of the release before runs and passes.
    id: 'R5c', file: LIB, tests: [TR], prepare: supplyReleased, expect: 'SURVIVED',
    from: '// scripts/lib/rebind.mjs — ADR-0068 Decision 8: rebinding a dispatched',
    to: '// scripts/lib/rebind.mjs: ADR-0068 Decision 8: rebinding a dispatched',
    why: 'the release before, supplied to the copy, reads and rewrites the macro as it does from its tag',
  },
  {
    id: 'R6', file: LIB, tests: [TR],
    from: "  const text = JSON.stringify(record);\n  const size = Buffer.byteLength(JSON.stringify(text), 'utf8');",
    to: "  const text = JSON.stringify(record) + ' '.repeat(300 * 1024);\n  const size = 0;",
    killed_by: [/the runtime entry brief and dashboard readers, and autopilot observe, read a macro holding a rebinding/],
    why: 'a record past the frontmatter other packages read (256 KiB), which its cap keeps it under, ' +
      'leaves the runtime entry brief unable to read the macro',
  },
  {
    id: 'R2', file: STATE, tests: [TR],
    from: '  delete frontmatter[APPROVAL_ID_KEY];\n  return setMacroGate(',
    to: '  delete frontmatter[APPROVAL_ID_KEY];\n  delete frontmatter[REBIND_KEY];\n  return setMacroGate(',
    killed_by: [/a stale approval \(a plan-set after it\) suspends the rebinding/, /a note written before a concurrent plan-set is still acknowledged/],
    why: 'a plan-set drops the record, losing the history and a pending note\'s acknowledgement',
  },
  {
    id: 'R3', file: LIB, tests: [TR],
    from: '  if (size > REBIND_RECORD_MAX_BYTES) {',
    to: '  if (false) {',
    killed_by: [/a record over its cap refuses the approval/],
    why: 'a record of any size is written into the frontmatter',
  },
  {
    id: 'R4', file: LIB, tests: [TR],
    from: "    const record = JSON.parse(raw);\n    checkRecord(record);",
    to: "    const record = JSON.parse(raw);",
    killed_by: [/an unreadable record fails no read/],
    why: 'a malformed record is trusted instead of named unreadable',
  },

  // ---- D: the approval's derivation and view ---------------------------------
  {
    id: 'D1', file: LIB, tests: [TR],
    from: '        from_digest: dispatchDigest(d), to_digest: wordsDigest(s), fields: [...row.changed],',
    to: '        from_digest: prev?.rebindings?.find((e) => e.child === info.child)?.to_digest ?? dispatchDigest(d), to_digest: wordsDigest(s), fields: [...row.changed],',
    killed_by: [/A to B to C: each approval derives from the dispatch/],
    why: 'a repeated revision is derived from the earlier rebinding, not from the child\'s own dispatch',
  },
  {
    id: 'D2', file: LIB, tests: [TR],
    from: "    else if (fieldText(d.verb) !== fieldText(s.verb)) row.not_rebindable.push('verb');",
    to: '    else if (false) {}',
    killed_by: [/a changed branch, verb or subtask id is refused at every binding/],
    why: 'a verb change is shown as rebindable',
  },
  {
    id: 'D3', file: LIB, tests: [TR],
    from: "    if (d.branch !== s.branch) row.not_rebindable.push('branch');",
    to: '',
    killed_by: [/a changed branch, verb or subtask id is refused at every binding/],
    why: 'a branch change is shown as rebindable',
  },
  {
    id: 'D4', file: LIB, tests: [TR],
    from: '      if (!(field in d)) row.not_compared.push(field);',
    to: '      if (!(field in d)) continue;',
    killed_by: [/a child that recorded no verb, profile or topic/],
    why: 'a field the child never recorded is not shown as not compared',
  },
  {
    id: 'D5', file: LIB, tests: [TR],
    from: '  const carried = prev ? [...prev.rebindings, ...prev.carried].filter((e) => completed.has(e.subtask)) : [];',
    to: '  const carried = [];',
    killed_by: [/a completed subtask's rebinding is carried by later approvals/],
    why: 'a completed subtask loses its rebinding at the next approval',
  },
  {
    id: 'D6', file: STATE, tests: [TR],
    from: "    status: 'found', child: claim.id, owner: owner ? 'recorded' : 'sole-claimant',",
    to: "    status: 'found', child: claim.id, owner: 'recorded',",
    killed_by: [/with no owner recorded \(a missed writeback\), the sole claimant is rebound/],
    why: 'a sole claimant is shown as the recorded owner',
  },
  {
    id: 'D7', file: STATE, tests: [TR],
    from: "  if (found.status === 'ambiguous') {\n    return {\n      status: 'ambiguous',\n",
    to: "  if (found.status === 'ambiguous') {\n    found = { status: 'found', claim: found.claims[0] };\n  }\n  if (false) {\n    return {\n      status: 'ambiguous',\n",
    killed_by: [/several claimants and no owner: none is rebound/],
    why: 'one of several claimants is picked and rebound',
  },

  {
    id: 'D8', file: LIB, tests: [TR],
    from: '    if (kept && kept.subtask === s.id) told[info.child] = kept;',
    to: "    if (kept && kept.subtask === s.id && row.kind !== 'not-rebindable') told[info.child] = kept;",
    killed_by: [/a revision it cannot rebind keeps what the child was last told/],
    why: 'a revision the approval cannot rebind erases the words the child was last told, so a return is never told',
  },
  {
    id: 'D9', file: LIB, tests: [TR],
    from: "    if (!('verb' in d)) row.not_compared.push('verb');",
    to: "    if (!('verb' in d)) {}",
    killed_by: [/a child that recorded no verb, profile or topic/],
    why: 'a verb the child never recorded is not shown as not compared',
  },
  {
    id: 'D10', file: STATE, tests: [TR],
    from: "  return line.length > 200 ? `${line.slice(0, 199)}…` : line;",
    to: "  return '';",
    killed_by: [/A to B to C: each approval derives from the dispatch/],
    why: 'the body keeps no trace of the words each rebinding approved',
  },
  {
    id: 'D11', file: LIB, tests: [TR],
    from: '      const last = kept && kept.subtask === s.id\n        ? wordsOf(kept)',
    to: '      const last = false\n        ? wordsOf(kept)',
    killed_by: [/A to B and back to A: no rebinding, but the return is told/],
    why: 'the words a child was last told are ignored, so a return to its dispatch is never told',
  },
  {
    id: 'D12', file: LIB, tests: [TR],
    from: '        const same = prev?.pending?.find(',
    to: '        const same = null && prev?.pending?.find(',
    killed_by: [/B pending, then C approved: the undelivered note is superseded/],
    why: 'a pending note approved again takes a new id, so the idempotency of its delivery is lost',
  },
  {
    id: 'D13', file: LIB, tests: [TR],
    from: '    if (kept && kept.subtask === s.id) told[info.child] = kept;',
    to: '',
    killed_by: [/a delivered change stays bound and told across an approval of another subtask/],
    why: 'an approval of another subtask forgets what an active child was told, and tells it the change again',
  },
  {
    id: 'D14', file: LIB, tests: [TR],
    from: '      if (keepsTold(child, t.subtask)) {',
    to: '      if (false) {',
    killed_by: [/an approval that cannot read the child keeps what it was told/],
    why: 'an approval that cannot read a child drops what it was told, so a later return to its dispatch is never told',
  },
  {
    id: 'D15', file: LIB, tests: [TR],
    from: '      if (!unsettled.has(p.subtask) || !keeps(p.child, p.subtask)) continue;',
    to: '      continue;',
    killed_by: [/an approval that finds the child ambiguous keeps its pending note under its id/,
      /a child whose claim cannot be read leaves its note waiting/],
    why: 'an approval that cannot settle a child drops its pending note, which a later approval tells under a new id',
  },
  {
    id: 'D16', file: LIB, tests: [TR],
    from: '      if (!unsettled.has(p.subtask) || !keeps(p.child, p.subtask)) continue;',
    to: '      if (!keeps(p.child, p.subtask)) continue;',
    killed_by: [/a note for a child that is gone, or for a subtask no longer in progress, is not kept/],
    why: 'a note for a child that is gone, or a subtask sent back to pending, is kept, and holds its next dispatch back',
  },
  {
    id: 'D17', file: STATE, tests: [TR],
    from: '      if (childFileUnparsed(scanRoot, p.child)) unparsed.add(p.child);',
    to: '',
    killed_by: [/a child whose file the claim scan skips keeps its note, written or not, until the file is repaired/],
    why: 'a child whose frontmatter the claim scan skips looks gone, so its note, and with it a later return, is dropped',
  },
  {
    id: 'D18', file: LIB, tests: [TR],
    from: "  const unknownBefore = previous?.status === 'unreadable'\n    ? subtasks.filter((s) => s?.status === 'in_progress').map((s) => s.id)\n",
    to: "  const unknownBefore = previous?.status === 'unreadable'\n    ? []\n",
    killed_by: [/stays not known through approvals that cannot tell the child/],
    why: 'an approval that replaces an unreadable record, unable to read an in-progress child, names nothing unknown, so a run steps the child under words it may never have been told',
  },
  {
    id: 'D20', file: LIB, tests: [TR],
    from: 'delivery_id: p.delivery_id, untouched: true, ...(p.restate ? { restate: true } : {}),',
    to: 'delivery_id: p.delivery_id, untouched: true,',
    killed_by: [/an approval that replaces an unreadable record tells each active child its words in full/],
    why: 'a restating note carried for a child that cannot be read for now loses its mark, and is written as a change from the words it restates',
  },
  {
    id: 'D21', file: LIB, tests: [TR],
    from: '  const unknown = unknownBefore.filter((id) => stillOpen.has(id) && !retired.has(id)).sort();',
    to: '  const unknown = [];',
    killed_by: [/what is not known after an unreadable record stays not known through approvals that cannot tell the child/],
    why: 'an approval that cannot tell the child (a change it cannot rebind, the child unreadable) forgets that its last words are not known, so a later return to the dispatch is never told',
  },
  {
    id: 'D22', file: LIB, tests: [TR],
    from: '    record.unknown = record.unknown.filter((id) => id !== p.subtask);\n',
    to: '',
    killed_by: [/what is not known after an unreadable record stays not known through approvals that cannot tell the child/],
    why: 'a restating note acknowledged leaves its subtask unknown, so every later approval restates it again and none is a noop',
  },
  {
    id: 'D24', file: LIB, tests: [TR],
    from: "    : [...new Set([...(prev?.unknown ?? []), ...(prev?.pending ?? []).filter((p) => p.restate === true).map((p) => p.subtask)])];",
    to: '    : (prev?.unknown ?? []);',
    killed_by: [/what is not known after an unreadable record stays not known through approvals that cannot tell the child/],
    why: 'a record whose restating note is pending but names no subtask unknown is taken as known, and the note is dropped',
  },
  {
    id: 'N8', file: STATE, tests: [TR],
    from: "    } catch (err) {\n      wait('unreadable',",
    to: "    } catch (err) {\n      throw err;\n      wait('unreadable',",
    killed_by: [/a child whose claim cannot be read leaves its note waiting, and the approval written reports it/],
    why: 'a child whose claim cannot be read fails the approval after it is written',
  },

  // ---- A: the admission and the blockers -------------------------------------
  {
    id: 'A1', file: STATE, tests: [TR],
    from: "    joined = await joinAdmission({\n      command: 'approve',",
    to: "    joined = { admissionId: '' }; if (false) await joinAdmission({\n      command: 'approve',",
    killed_by: [/refused beside a live run's lock/, /refused beside an admitted interactive \/orchestrator:next/, /a killed approval leaves its entry/],
    why: 'an approval joins no lock and passes between two looks of a live run',
  },
  {
    id: 'A2', file: STATE, tests: [TR],
    from: '  return rebindRefusals({ ...ctx, subtaskId, branch, childPaths });',
    to: '  return [];',
    killed_by: [/a hold or release record refuses a rebinding approval and a delivery/, /a pending or held subtask, or one whose release awaits its comparison, refuses/],
    why: 'a held subtask is rebound and told',
  },
  {
    // impl-hold's reader (2026-10-26) reads the records by kind, so no park
    // can count as a hold; what refuses everything now is a reader that
    // takes every state for one that applies.
    id: 'A3', file: 'plugins/orchestrator/scripts/lib/hold-ops.mjs', tests: [TR],
    from: "    default: break;\n  }\n  const hold = st.hold?.state === 'ok' ? st.hold.record : null;",
    to: "    default: if (st.state !== 'none') why.push(st.state); break;\n  }\n  const hold = st.hold?.state === 'ok' ? st.hold.record : null;",
    killed_by: [/a retired, consumed, rejected, withdrawn or orphaned hold permits rebinding again/],
    why: 'a hold that ended (retired, consumed, rejected, withdrawn, orphaned) refuses every rebinding of its subtask for good',
  },
  {
    id: 'A4', file: STATE, tests: [TR],
    from: "    if (blockers.length > 0) {\n      wait('blocked',",
    to: "    if (false) {\n      wait('blocked',",
    killed_by: [/a hold or release record refuses a rebinding approval and a delivery/],
    why: 'a delivery completes beside a hold',
  },
  {
    id: 'A5', file: STATE, tests: [TR],
    from: '      ...view.deliveries.filter((d) => !d.untouched).map((d) => d.subtask),\n    ]);',
    to: '    ]);',
    killed_by: [/a hold refuses an approval that only tells the held subtask/],
    why: 'an approval that only tells a held subtask (a return to its dispatch, which rebinds nothing) writes its note past the hold',
  },
  {
    id: 'A6', file: STATE, tests: [TR],
    from: '...view.deliveries.filter((d) => !d.untouched).map((d) => d.subtask),',
    to: '...view.deliveries.map((d) => d.subtask),',
    killed_by: [/a hold refuses an approval that only tells the held subtask, and not one that carries its note as it was/],
    why: 'a note carried unchanged, for a child no row decides, makes a hold refuse an approval of another subtask',
  },

  // ---- W: the approval's write -----------------------------------------------
  {
    id: 'W1', file: LIB, tests: [TR],
    from: "  const digest = digestOf({ record: previous?.status ?? 'absent', rows, carried, untouched, unknown });",
    to: "  const digest = digestOf({ record: previous?.status ?? 'absent', rows: rows.map(({ child_state, path, next_step, ...r }) => r), carried, untouched, unknown });",
    killed_by: [/--expect-rebind is required when the view has rows, and a changed child refuses the approval/],
    why: 'a child whose state or next step changed after the display is approved anyway',
  },
  {
    id: 'W2', file: STATE, tests: [TR],
    from: '    if (view.rows.length > 0 && expectRebind === undefined) {',
    to: '    if (false) {',
    killed_by: [/--expect-rebind is required when the view has rows/],
    why: 'an approval binds to no view it showed',
  },
  {
    id: 'W3', file: STATE, tests: [TR],
    from: '    if (unchanged) {',
    to: "    if (frontmatter.plan_approval_status === 'approved' && frontmatter.plan_approval_plan_hash === planHash) {",
    killed_by: [/approving an unchanged approval again writes nothing; one with a delivery pending is re-recorded/],
    why: 'an approval of the hash already approved is a no-op, as before, so a note pending is never re-recorded',
  },
  {
    id: 'W4', file: STATE, tests: [TR],
    from: '      if (!written) {\n',
    to: '      if (true) {\n',
    killed_by: [/a note already in the child \(a crash before its acknowledgement\)/],
    why: 'an approval does not recognise a note already written, and tells the child again',
  },

  // ---- N: the note -----------------------------------------------------------
  {
    id: 'N1', file: LIB, tests: [TR],
    from: '    if (from[field] === to[field]) continue;',
    to: '    if (true) continue;',
    killed_by: [/a topic revised and approved while the child works/],
    why: 'the note carries neither the old nor the new words',
  },
  {
    id: 'N2', file: STATE, tests: [TR],
    from: "    if (!written.includes(`\\n### ${deliveryHeading(p.delivery_id)}\\n\\n${text}\\n`)) {",
    to: '    if (false) {',
    killed_by: [/a note the child does not hold after the append is not acknowledged/],
    why: 'a delivery is acknowledged without reading the note back',
  },
  {
    id: 'N3', file: STATE, tests: [TR],
    from: '    if (found) {',
    to: '    if (false) {',
    killed_by: [/a note written before a concurrent plan-set is still acknowledged by its id/],
    why: 'a note written before a plan-set is never acknowledged',
  },
  {
    id: 'N4', file: STATE, tests: [TR],
    from: '    const idx = record.pending.findIndex((p) => p.delivery_id === deliveryId);\n    if (idx === -1) return false;',
    to: '    const idx = record.pending.findIndex((p) => p.delivery_id === deliveryId);\n    if (idx === -1 || !stampMatches(record, frontmatter)) return false;',
    killed_by: [/a note written before a concurrent plan-set is still acknowledged by its id/],
    why: 'an acknowledgement keyed by the approval stamp loses a note written before a plan-set',
  },
  {
    id: 'N5', file: STATE, tests: [TR],
    from: "    if (info.child_state !== 'active') {\n      wait('archived',",
    to: "    if (false) {\n      wait('archived',",
    killed_by: [/a child archived with its note pending is told nothing/],
    why: 'an archived child is written to',
  },
  {
    id: 'N6', file: STATE, tests: [TR],
    from: "  if (!/TEXT_FILE_FLAGS\\s*=\\s*\\[[^\\]]*'phase-note'/.test(text)) {",
    to: '  if (false) {',
    killed_by: [/an engineer that cannot write a note from a file leaves the delivery pending/],
    why: 'an engineer that cannot take the note from a file is run anyway',
  },
  {
    id: 'N7', file: STATE, tests: [TR],
    from: "      if ([d.from.profile, d.from.topic, d.to.profile, d.to.topic].some((t) => t.includes('\\0'))) {",
    to: '      if (false) {',
    killed_by: [/words holding a NUL byte refuse the approval/],
    why: 'words no note can carry are recorded',
  },

  // ---- C: the comparison -----------------------------------------------------
  {
    id: 'C1', file: STATE, tests: [TR],
    from: '  if (!verdict.ok) throw dispatchRefusal(caller, subtaskId, mismatches, verdict.why);',
    to: '  throw dispatchRefusal(caller, subtaskId, mismatches, verdict.why);',
    killed_by: [/a topic revised and approved while the child works/, /an archived child, approved after its commit/, /the done runbook's owner scan/],
    why: 'no rebinding is ever honored: the C147 case stays refused',
  },
  {
    id: 'C2', file: LIB, tests: [TR],
    from: '  if (!stampMatches(r, fm)) {',
    to: '  if (false) {',
    killed_by: [/an approval stamp that is not the record's \(an older approver's\) rebinds nothing/],
    why: 'a record written by an earlier approval binds under a later one',
  },
  {
    id: 'C3', file: LIB, tests: [TR],
    from: "  if (approval.status === 'pending') {",
    to: '  if (false) {',
    killed_by: [/an unapproved revision is refused dispatch-changed in every binding path/],
    why: 'the refusal of a pending plan does not say a plan-set suspended the rebinding',
  },
  {
    id: 'C4', file: LIB, tests: [TR],
    from: '  const live = r.rebindings.find((e) => e.subtask === subtaskId && e.child === child);',
    to: '  const live = r.rebindings.find((e) => e.subtask === subtaskId);',
    killed_by: [/a child the approval did not name is refused/, /an archived child the approval did not name is refused/],
    why: 'a rebinding of one child binds another child of the subtask: for an archived entry, which no note check ' +
      'stands behind, the other child is bound as the owner',
  },
  {
    id: 'C5', file: LIB, tests: [TR],
    from: '  if (entry.from_digest !== dispatchDigest(expectDispatch)) {',
    to: '  if (false) {',
    killed_by: [/a child the approval did not name is refused/],
    why: 'a write passing another dispatch than the rebound one is accepted',
  },
  {
    id: 'C6', file: LIB, tests: [TR],
    from: '  if (entry.to_digest !== wordsDigest(current)) {',
    to: '  if (false) {',
    killed_by: [/a completed subtask's rebinding is carried by later approvals/],
    why: 'a rebinding to other words than the subtask\'s now binds it',
  },
  {
    id: 'C7', file: LIB, tests: [TR],
    from: '  if (waiting) {',
    to: '  if (false) {',
    killed_by: [/an active child not yet told is refused until the delivery completes/],
    why: 'a child with its note pending is bound under words it was never told',
  },
  {
    id: 'C8', file: LIB, tests: [TR],
    from: '  const fixed = mismatches.filter((m) => !REBINDABLE_FIELDS.includes(m.field));',
    to: "  const fixed = mismatches.filter((m) => !REBINDABLE_FIELDS.includes(m.field) && m.field !== 'verb');",
    killed_by: [/a changed branch, verb or subtask id is refused at every binding/],
    why: 'a verb change passes the comparison\'s own check',
  },

  // ---- B: the driver's boundary and the parks --------------------------------
  {
    id: 'B1', file: DRIVER, tests: [TA],
    from: '      const due = d.step?.subtaskId\n        ? rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null })\n        : null;',
    to: '      const due = null;',
    killed_by: [/an unfinished return to the dispatched words is told before the next step/, /a note that cannot be told halts the run before the step/, /a child last told other words is not stepped \(serial\)/],
    why: 'a serial run starts the child\'s next step under the old words',
  },
  {
    id: 'B2', file: DRIVER, tests: [TA],
    from: '        view = look(view.macro.id);\n        const after = rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null });',
    to: '        const after = rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null });',
    killed_by: [/an unfinished return to the dispatched words is told before the next step/],
    why: 'the step is decided from the look taken before the note, its baseline missing it',
  },
  {
    id: 'B3', file: SCHED, tests: [TA],
    from: '    const due = id ? rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path, selected: view.children?.[id]?.workflow_id ?? null }) : null;',
    to: '    const due = null;',
    killed_by: [/the idle lane's child is told before its step while the other lane runs/, /a child last told other words is not stepped \(lanes\)/],
    why: 'a lane starts its child\'s next step under the old words',
  },
  {
    id: 'B4', file: SCHED, tests: [TA],
    from: "      if (!told.ok) return refuse({ reason: 'owner-choice', detail: told.detail, subtaskId: id });",
    to: "      if (!told.ok) return refuse({ reason: 'owner-choice', detail: told.detail });",
    killed_by: [/the idle lane's child is told before its step while the other lane runs/],
    why: 'a note that cannot be told halts the whole run instead of parking its lane',
  },
  {
    id: 'B5', file: POLICY, tests: [TA],
    from: '    ...(rebind ? { rebind } : {}),',
    to: '',
    killed_by: [/the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'a lane parked before the approval is never reconsidered',
  },
  {
    id: 'B6', file: BOUNDARY, tests: [TA],
    from: "  if (parsed.status === 'unreadable') return s?.status === 'in_progress' ? { due: 'unreadable' } : null;",
    to: "  if (parsed.status === 'unreadable') return null;",
    killed_by: [/rebindDue: pending for the subtask named/],
    why: 'a child owed a note the record cannot say runs its next step anyway',
  },

  {
    id: 'B7', file: POLICY, tests: [TA],
    from: '  return digestOf({ entries, pending, told, ...now, ...(unknown ? { unknown } : {}) });',
    to: '  return digestOf({ approval: r.approval, entries, pending, told, ...now, ...(unknown ? { unknown } : {}) });',
    killed_by: [/the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'an approval of another subtask wakes a lane parked on an unchanged failure',
  },
  {
    id: 'B8', file: POLICY, tests: [TA],
    from: 'export const PARK_FINGERPRINT_VERSION = 3;',
    to: 'export const PARK_FINGERPRINT_VERSION = 2;',
    killed_by: [/the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'a park kept by a release that did not read the record is compared, and resumes on facts it never had',
  },
  {
    id: 'B9', file: BOUNDARY, tests: [TR],
    from: '  if (hold && Number.isInteger(child.pid)) {',
    to: '  if (false) {',
    killed_by: [/a run's delivery is on the run's locks while its writer lives/],
    why: 'a driver that dies while its delivery writes leaves the writer off the locks, and an approval starts beside it',
  },
  {
    id: 'B10', file: SCHED, tests: [TA],
    from: '    const occupied = inLane ? laneBusy(id, view) : false;\n    if (occupied) {\n      holdBack(id, occupied);\n      return { ...refuse(null), again: false, busy: true };\n    }\n\n    // ADR-0068 Decision 8',
    to: '    const occupied = inLane ? laneBusy(id, view) : false;\n    if (occupied && !rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path })) {\n      holdBack(id, occupied);\n      return { ...refuse(null), again: false, busy: true };\n    }\n\n    // ADR-0068 Decision 8',
    killed_by: [/the idle lane's child is told before its step while the other lane runs/],
    why: 'a note is written into a lane with a persona operation open',
  },
  {
    id: 'B11', file: BOUNDARY, tests: [TR],
    from: "'--repo-root', repoRoot, '--await-start',",
    to: "'--repo-root', repoRoot,",
    killed_by: [/a run's delivery writes nothing before it is on the run's locks/],
    why: 'the delivery writes before the run has put it on its locks, so a driver killed then leaves a writer off them',
  },
  {
    id: 'B12', file: STATE, tests: [TR],
    from: "        if ('await-start' in flags) await awaitStartLine();\n",
    to: '',
    killed_by: [/rebind-deliver --await-start writes nothing when its stdin closes before the start line/],
    why: 'rebind-deliver begins at once, whatever the run that started it has done',
  },
  {
    id: 'B13', file: BOUNDARY, tests: [TR],
    from: '    try { teardown = await terminate(child.pid); } catch { teardown = \'lingering\'; }\n',
    to: '',
    killed_by: [/a run's delivery leaves the run's locks only once its group is empty/],
    why: 'the run\'s locks are released while a process the delivery left (its engineer append) still writes, so a later approval or delivery is let in beside it',
  },
  {
    id: 'B14', file: BOUNDARY, tests: [TR],
    from: "  if (teardown === 'lingering') return { err, stdout, stderr, lingering: true };\n",
    to: '',
    killed_by: [/a run's delivery whose group outlives SIGKILL keeps the run's locks and says so/],
    why: 'a delivery group that outlived SIGKILL is released from the run\'s locks and reported as told',
  },
  {
    id: 'B15', file: DRIVER, tests: [TA],
    from: "        if (told.lingering) return await finish('halted', { reason: 'worker-failed', detail: told.detail });\n",
    to: '',
    killed_by: [/a delivery whose group outlived SIGKILL halts the run, which keeps its locks/],
    why: 'a serial run halts on a lingering delivery group as on a note it could not tell, as the owner\'s choice',
  },
  {
    id: 'B16', file: SCHED, tests: [TA],
    from: "      if (told.lingering) return refuse({ reason: 'worker-failed', detail: told.detail, subtaskId: id, scope: 'run' });\n",
    to: '',
    killed_by: [/a lane's delivery whose group outlived SIGKILL drains the run instead of parking the lane/],
    why: 'a lane whose delivery group outlived SIGKILL is parked, and the run goes on beside a writer it could not end',
  },
  {
    id: 'B17', file: BOUNDARY, tests: [TA],
    from: "  if ((record?.unknown ?? []).includes(subtaskId)) return { due: 'unknown' };\n",
    to: '',
    killed_by: [/rebindDue: pending for the subtask named, unreadable only for one in progress/],
    why: 'a run steps a child whose last words are not known, under whatever its last note said',
  },
  {
    id: 'B18', file: POLICY, tests: [TA],
    from: '  const unknown = (r.unknown ?? []).includes(subtaskId);',
    to: '  const unknown = false;',
    killed_by: [/the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'an approval that retires a subtask\'s unknown words leaves its lane parked on the hold it no longer has',
  },

  // ---- the third critique's MAJOR 1-4 ----------------------------------------
  {
    id: 'N9', file: LIB, tests: [TR],
    from: "    if (end > intro && !text.slice(intro, end).includes('\\n### ') && text.startsWith(body, end + 2)) return true;",
    to: '    return true;',
    killed_by: [/a heading over other words is not the note/],
    why: 'a note is acknowledged by its heading alone, so a retry binds a child to words it was never told',
  },
  {
    id: 'N10', file: STATE, tests: [TR],
    from: '      if (admission?.admissionId) {',
    to: '      if (false) {',
    killed_by: [/an approval killed while its note is written leaves an entry/],
    why: 'an interactive delivery\'s append is not fenced to its admission, so a killed approver\'s note lands after a newer one',
  },
  {
    id: 'N11', file: RUNLOCKS, tests: [TR],
    from: '  return (await holderAlive({ worker: writer }, { probe })) ? writer : null;',
    to: '  return null;',
    killed_by: [/an approval killed while its note is written leaves an entry/],
    why: 'admission release removes the entry while the note\'s writer it recorded still runs',
  },
  {
    id: 'N12', file: STATE, tests: [TR],
    from: '    recordAdmissionWriter({\n      checkout: admission.stateRoot,',
    to: '    void ({\n      checkout: admission.stateRoot,',
    killed_by: [/an approval killed while its note is written leaves an entry/],
    why: 'the note\'s writer is never recorded on the admission, so nothing keeps the entry while it runs',
  },
  {
    id: 'N13', file: STATE, tests: [TR],
    from: "import(require('node:url').pathToFileURL(process.argv[1]).href)",
    to: "Promise.resolve(require('node:child_process').spawnSync(process.execPath,process.argv.slice(1),{stdio:'inherit'}))",
    killed_by: [/an approval killed while its note is written leaves an entry/],
    why: 'the gate runs the append as a child of its own, so the process the admission records is not the writer (Windows has no group to hold it)',
  },
  {
    id: 'D32', file: STATE, tests: [TR],
    from: '  if (childFileUnparsed(repoRoot, claim.id, { activeOnly: true })) {',
    to: '  if (false) {',
    killed_by: [/an in-progress child read only from its archived copy, beside an active one the scan skips, keeps its subtask unknown/],
    why: 'a readable archived copy hides an active one the scan skips, so a child that may still run is taken as archived and never told',
  },

  // ---- V: the vouch at the binding writes (item 4) --------------------------
  {
    id: 'V1', file: LIB, tests: [TR],
    from: "  if (parsed.status === 'unreadable') {\n    return {\n      ok: false,\n      why: `the macro's record of rebindings (${REBIND_KEY}) is unreadable (${parsed.error}), so it cannot say",
    to: "  if (false) {\n    return {\n      ok: false,\n      why: `the macro's record of rebindings (${REBIND_KEY}) is unreadable (${parsed.error}), so it cannot say",
    killed_by: [/vouches for a child only by what it was told since/],
    why: 'a record that cannot be read is taken to vouch for the child',
  },
  {
    id: 'V2', file: LIB, tests: [TR],
    from: '  if (replacedAt === null && !unknown) {\n    if (!toldThis) return { ok: true, retire: false };',
    to: '  if (true) {\n    if (!toldThis) return { ok: true, retire: false };',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/, /vouches for a child only by what it was told since/],
    why: 'a binding write takes every child as told, though the record was replaced or names the subtask unknown',
  },
  {
    id: 'V3', file: LIB, tests: [TR],
    from: '  const toldNow = toldThis && told.contested !== true && wordsDigest(told) === wordsDigest(current);',
    to: '  const toldNow = told !== undefined;',
    killed_by: [/vouches for a child only by what it was told since/],
    why: 'words told for another subtask, or other words, vouch for the child',
  },
  {
    id: 'V4', file: LIB, tests: [TR],
    from: '  if (toldNow) return { ok: true, retire: false };',
    to: '  if (false) return { ok: true, retire: false };',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/, /vouches for a child only by what it was told since/],
    why: 'a child a note restated is refused for ever, so the restate is no recovery',
  },
  {
    id: 'V5', file: LIB, tests: [TR],
    from: '  if (replacedAt !== null && !told && !waiting && startedAfter(startedAt(), replacedAt)) return { ok: true, retire: unknown };',
    to: '  if (replacedAt !== null && !told && !waiting) return { ok: true, retire: unknown };',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/, /vouches for a child only by what it was told since/],
    why: 'every child of a replaced record is taken as started after it, so one there by then is bound unrestated',
  },
  {
    id: 'V6', file: LIB, tests: [TR],
    from: '  if (replacedAt !== null && !told && !waiting && startedAfter(startedAt(), replacedAt)) return { ok: true, retire: unknown };',
    to: '  if (replacedAt !== null && !told && !waiting && startedAfter(startedAt(), replacedAt)) return { ok: true, retire: false };',
    killed_by: [/a fresh dispatch is bound and retires its subtask's unknown/, /vouches for a child only by what it was told since/],
    why: 'a fresh child bound after the replacement leaves its subtask unknown, so a run holds every step of it',
  },
  {
    id: 'V7', file: LIB, tests: [TR],
    from: '  return Number.isFinite(s) && Number.isFinite(a) && Math.floor(s / 1000) > Math.floor(a / 1000);',
    to: '  return Number.isFinite(s) && Number.isFinite(a) && s >= a;',
    killed_by: [/a fresh dispatch is bound and retires its subtask's unknown/, /vouches for a child only by what it was told since/],
    why: 'a child started in the second of the replacement, which may have been there before it, is taken as started after',
  },
  {
    id: 'V8', file: STATE, tests: [TR],
    from: "    const vouchNote = binds && typeof bindsChild === 'string' && bindsChild.length > 0\n      ? vouchChild(",
    to: "    const vouchNote = false\n      ? vouchChild(",
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'the re-attach binds a child the record cannot vouch for',
  },
  {
    id: 'V9', file: STATE, tests: [TR],
    from: "    const vouchNote = vouchChild('recordEngineerTerminal', {",
    to: "    const vouchNote = '' && vouchChild('recordEngineerTerminal', {",
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'the terminal writeback binds a child the record cannot vouch for',
  },
  {
    id: 'V10', file: STATE, tests: [TR],
    from: "    if (changedKeys.length === 0 && vouchNote === '') {",
    to: '    if (changedKeys.length === 0) {',
    killed_by: [/a fresh dispatch is bound and retires its subtask's unknown/],
    why: 'a re-attach that changes no field drops the retirement of its subtask\'s unknown',
  },
  {
    id: 'V11', file: STATE, tests: [TR],
    from: '  record.unknown = record.unknown.filter((id) => id !== subtaskId);\n  if (record.unknown.length === 0) delete record.unknown;\n  frontmatter[REBIND_KEY]',
    to: '  frontmatter[REBIND_KEY]',
    killed_by: [/a fresh dispatch is bound and retires its subtask's unknown/],
    why: 'the binding of a fresh child says it retires the subtask\'s unknown and keeps it',
  },
  {
    id: 'V12', file: STATE, tests: [TR],
    from: "    const replacedAt = previous.status === 'unreadable'\n      ? isoUtc(new Date(Math.max(Date.now(), now.getTime())))\n      : reconciled.record?.replaced_at;",
    to: "    const replacedAt = previous.status === 'unreadable'\n      ? undefined\n      : reconciled.record?.replaced_at;",
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'an approval that replaces an unreadable record does not say so, so a child there by then is bound unrestated',
  },
  {
    id: 'V13', file: STATE, tests: [TR],
    from: "      ? isoUtc(new Date(Math.max(Date.now(), now.getTime())))\n      : reconciled.record?.replaced_at;",
    to: "      ? isoUtc(new Date(Math.max(Date.now(), now.getTime())))\n      : undefined;",
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'a later approval that cannot tell the child forgets the replacement, so the child is bound unrestated',
  },
  {
    id: 'V14', file: STATE, tests: [TR],
    from: '    if (reconciled.record.replaced_at !== undefined) for (const s of subtasks) if (s) owed.add(s.id);\n',
    to: '',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'an approval after the replacement never reads a child of a subtask not in progress, so it is never restated and stays refused',
  },
  {
    id: 'V15', file: LIB, tests: [TR],
    from: "row.kind !== 'not-rebindable' && (unknownSet.has(s.id) || lost || contested)) {",
    to: "row.kind !== 'not-rebindable' && (unknownSet.has(s.id) || contested)) {",
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'a child of a subtask not in progress, there by a replacement, is never restated, so the re-attach refuses it with no recovery',
  },
  {
    id: 'V16', file: LIB, tests: [TR],
    from: '  const lostWith = (info) => replacing || (nonEmpty(prev?.replaced_at) && !startedAfter(info.started_at, prev.replaced_at));',
    to: '  const lostWith = (info) => replacing;',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'only the replacing approval restates a child there by then; one it could not read is never restated afterwards',
  },
  {
    id: 'V17', file: LIB, tests: [TR],
    from: '    const lost = lostWith(info) && !(kept && kept.subtask === s.id);',
    to: '    const lost = lostWith(info);',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'a child told since the replacement is restated by every approval after it',
  },
  {
    id: 'V18', file: STATE, tests: [TR],
    from: '    return file ? childStartedAt(file.path) : null;',
    to: '    return null;',
    killed_by: [/a fresh dispatch is bound and retires its subtask's unknown/],
    why: 'a fresh child\'s start is never read at its binding, so a child dispatched after the replacement is refused',
  },
  {
    id: 'V20', file: STATE, tests: [TR],
    from: '      ? isoUtc(new Date(Math.max(Date.now(), now.getTime())))',
    to: '      ? isoUtc(now)',
    killed_by: [/the replacement is timed at its write, not when the approval was called/],
    why: 'the replacement is timed when the approval was called, so a child started before its write is taken to have lost nothing',
  },
  {
    id: 'V21', file: STATE, tests: [TR],
    from: "    const bindsChild = typeof payload.engineer_workflow_id === 'string' ? payload.engineer_workflow_id : current.engineer_workflow_id;",
    to: '    const bindsChild = payload.engineer_workflow_id;',
    killed_by: [/the replacement is timed at its write, not when the approval was called/],
    why: 'a re-attach that names no child binds the recorded owner unvouched',
  },
  {
    id: 'V22', file: LIB, tests: [TR],
    from: '  if (replacedAt !== null && !told && !waiting && startedAfter(',
    to: '  if (replacedAt !== null && !waiting && startedAfter(',
    killed_by: [/vouches for a child only by what it was told since/],
    why: 'a child started after the replacement is bound though a note since told it other words',
  },
  {
    id: 'V23', file: LIB, tests: [TR],
    from: '  if (replacedAt !== null && !told && !waiting && startedAfter(',
    to: '  if (replacedAt !== null && !told && startedAfter(',
    killed_by: [/vouches for a child only by what it was told since/],
    why: 'a child started after the replacement is bound while a note to it still waits',
  },
  {
    id: 'V24', file: LIB, tests: [TR],
    from: '    const kept = prev?.told?.[info.child] ?? null;',
    to: "    const kept = info.child_state === 'active' ? prev?.told?.[info.child] : null;",
    killed_by: [/an archived child keeps what it was told, and its terminal writeback is bound by it/],
    why: 'an approval drops what an archived child was told, so its terminal writeback after the archive is refused with no recovery',
  },
  {
    id: 'V19', file: LIB, tests: [TR],
    from: '&& (r.unknown ?? []).length === 0\n  && r.replaced_at === undefined;',
    to: '&& (r.unknown ?? []).length === 0;',
    killed_by: [/refused at the re-attach and the terminal writeback until a note restates its words/],
    why: 'a record that holds only the replacement counts as empty and is dropped, so a child there by then is bound unrestated',
  },
  // The told check at every binding write, whatever the dispatch comparison
  // found (the owner's ruling of 2026-10-22).
  {
    id: 'V25', file: LIB, tests: [TR],
    from: '  if (waiting && (toldNow || (replacedAt === null && !unknown))) {',
    to: '  if (false) {',
    killed_by: [/a child in progress, its dispatch matching, is refused at the terminal writeback and at done until the note is delivered/, /a child whose subtask went back to pending, its dispatch matching, is refused at the re-attach and at done/, /the told check, read alone/],
    why: 'a child a note to which is still pending is bound under the words the note replaces, its dispatch matching',
  },
  {
    id: 'V26', file: LIB, tests: [TR],
    from: '  if (waiting && (toldNow || (replacedAt === null && !unknown))) {',
    to: '  if (waiting && (replacedAt === null && !unknown)) {',
    killed_by: [/the told check, read alone/],
    why: 'a child told these words since a replacement is bound while a later note to it still waits',
  },
  {
    id: 'V27', file: LIB, tests: [TR],
    from: '    if (!toldThis) return { ok: true, retire: false };',
    to: '    return { ok: true, retire: false };',
    killed_by: [/a child last told other words, with no note pending, is refused until the plan says them/, /an archived child last told other words is refused at done/, /the told check, read alone/],
    why: 'a child last told other words for its subtask is bound under the plan\'s, its dispatch matching',
  },
  {
    id: 'V28', file: STATE, tests: [TR],
    from: "    if ((waive === 'dispatch' && gone()) || (waive === 'told' && archived)) {",
    to: "    if (waive === 'told' && archived) {",
    killed_by: [/a recorded owner with no file left completes under --waive-dispatch, which waives the told check too/],
    why: 'an owner with no file left, which no note can reach, cannot be completed even with the waiver',
  },
  {
    id: 'V29', file: STATE, tests: [TR],
    from: "    if ((waive === 'dispatch' && gone()) || (waive === 'told' && archived)) {",
    to: "    if ((waive === 'dispatch' && gone()) || waive === 'told') {",
    killed_by: [/the told waiver is refused for an active child/],
    why: 'the waiver completes an active child, which a note can still reach, under words it was never told',
  },
  {
    id: 'V30', file: STATE, tests: [TR],
    from: "  if (waive === 'told') {\n    throw new Error(\n      `${caller}: the waiver",
    to: "  if (false) {\n    throw new Error(\n      `${caller}: the waiver",
    killed_by: [/the told waiver is refused for an active child, and for a child the record vouches for/],
    why: 'a waiver that waives nothing is recorded with its reason, as if the record could not vouch for the child',
  },
  {
    id: 'V31', file: STATE, tests: [TR],
    from: "      && (payload.status === 'in_progress' || payload.status === 'completed' || hasCompletionFields);",
    to: "      && payload.status === 'in_progress';",
    killed_by: [/a child in progress, its dispatch matching, is refused at the terminal writeback and at done until the note is delivered/, /an archived child last told other words is refused at done/],
    why: 'done completes a child that was never told the subtask\'s words',
  },
  {
    id: 'V32', file: STATE, tests: [TR],
    from: '  const archived = c !== null && c.active === false && !fileLeft({ activeOnly: true });',
    to: '  const archived = false;',
    killed_by: [/an archived child last told other words is refused at done; the told waiver with a reason completes it/],
    why: 'an archived child is told to wait for a note that never reaches it, and the waiver, its way out, is refused',
  },
  {
    id: 'V33', file: STATE, tests: [TR],
    from: '    if (waiveTold && !binds) {',
    to: '    if (false) {',
    killed_by: [/an archived child last told other words is refused at done; the told waiver with a reason completes it/],
    why: 'a waiver on a subtask already completed binds nothing and is written with its reason all the same',
  },
  {
    id: 'V34', file: STATE, tests: [TD],
    from: "          waiveTold: cliPresenceFlag(flags, 'waive-told'),\n",
    to: '',
    killed_by: [/an archived owner last told other words is refused; --waive-dispatch with a reason completes it and is recorded/],
    why: 'subtask-update drops --waive-told, so done\'s waiver for an archived owner completes nothing',
  },
  {
    id: 'V35', file: DONE_MD, tests: [TD],
    from: '  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS+=(--waive-told); fi\n',
    to: '',
    killed_by: [/an archived owner last told other words is refused; --waive-dispatch with a reason completes it and is recorded/],
    why: 'the done runbook drops --waive-dispatch once the dispatch is read, so an archived owner the record cannot vouch for is never completed',
  },
  {
    id: 'V36', file: DONE_SKILL, tests: [TD],
    from: '  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS+=(--waive-told); fi\n',
    to: '',
    killed_by: [/an archived owner last told other words is refused; --waive-dispatch with a reason completes it and is recorded/],
    why: 'the Codex done skill drops --waive-dispatch once the dispatch is read, so an archived owner the record cannot vouch for is never completed',
  },
  {
    id: 'V37', file: LIB, tests: [TR],
    from: '  if (!live || waived) return { ok: true, entry, approval: r.approval };',
    to: '  if (!live) return { ok: true, entry, approval: r.approval };',
    killed_by: [/an archived child rebound with its note pending is completed under the told waiver/],
    why: 'the rebinding\'s own delivery check refuses an archived child before the waiver is reached, so the waiver done names cannot complete it',
  },
  {
    id: 'V38', file: STATE, tests: [TR],
    from: "child: engineerWorkflowId, waived: waiveTold });",
    to: "child: engineerWorkflowId });",
    killed_by: [/an archived child rebound with its note pending is completed under the told waiver/],
    why: 'the told waiver never reaches the comparison of a rebound dispatch, so an archived child rebound with its note pending cannot be completed',
  },
  {
    id: 'V39', file: STATE, tests: [TR],
    from: "  const fresh = approval.status === 'approved' && approval.hash_ok === true;",
    to: '  const fresh = true;',
    killed_by: [/a pending note of an approval the plan changed since names the approval, not a delivery/],
    why: 'a refusal over a stale approval\'s pending note names a delivery that refuses stale',
  },
  {
    id: 'V40', file: LIB, tests: [TR],
    from: "  const deliver = !waiting ? ''\n    : fresh\n",
    to: "  const deliver = !waiting ? ''\n    : true\n",
    killed_by: [/a pending note of an approval the plan changed since names the approval, not a delivery/, /the told check, read alone/],
    why: 'the vouch ignores whether the plan changed since the note\'s approval, and names a delivery that cannot run',
  },
  {
    id: 'V41', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: '  const archived = c !== null && c.active === false && !fileLeft({ activeOnly: true });',
    to: '  const archived = c !== null && c.active === false;',
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): the waiver\'s archived test outside the copies refusal, reached only when one file bears the child, where an archived claimant leaves no file named for it in a workflow home; the defect it caught before: a readable archived copy hides an active file the scan skips, and the waiver completes a child that may still run',
  },
  {
    id: 'V42', file: STATE, tests: [TR],
    from: "    if ((waive === 'dispatch' && gone()) || (waive === 'told' && archived)) {",
    to: "    if (waive === 'dispatch' || (waive === 'told' && archived)) {",
    killed_by: [/the waivers are refused for a child whose active file the scan skips beside an archived copy, and --waive-dispatch while a file of it is left/],
    why: '--waive-dispatch waives the told check for an owner whose file is still there, active, so it completes a child a note can still reach',
  },
  {
    id: 'V43', file: DONE_MD, tests: [TD],
    from: '  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS+=(--waive-told); fi',
    to: '  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS=(--waive-told); fi',
    killed_by: [/an archived owner last told other words is refused; --waive-dispatch with a reason completes it and is recorded/],
    why: 'the done runbook\'s told waiver drops the dispatch it read, so a waived write is never compared with it',
  },
  {
    id: 'V44', file: DONE_SKILL, tests: [TD],
    from: '  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS+=(--waive-told); fi',
    to: '  if [ "$WAIVE_DISPATCH" = true ]; then DISPATCH_ARGS=(--waive-told); fi',
    killed_by: [/an archived owner last told other words is refused; --waive-dispatch with a reason completes it and is recorded/],
    why: 'the Codex done skill\'s told waiver drops the dispatch it read, so a waived write is never compared with it',
  },
  {
    id: 'V45', file: STATE, tests: [TR],
    from: "      && (payload.status === 'in_progress' || payload.status === 'completed' || hasCompletionFields);",
    to: "      && (payload.status === 'in_progress' || payload.status === 'completed');",
    killed_by: [/a child in progress, its dispatch matching, is refused at the terminal writeback and at done until the note is delivered/],
    why: 'completion provenance written with no status records a child that was never told the subtask\'s words',
  },
  {
    id: 'V46', file: STATE, tests: [TR],
    from: '          if (childCopyNames(join(root, ...home, sub), childId).length > 0) return true;\n',
    to: '          if (childCopyNames(join(root, ...home, sub), childId).length > 0) return false;\n',
    killed_by: [/the waivers are refused for a child whose active file the scan skips beside an archived copy/],
    why: 'a file of the child left in a home, whatever it holds or claims, is taken as none, so the waivers complete a child that may still run',
  },
  {
    id: 'D25', file: LIB, tests: [TR],
    from: "    if (idle && children.get(s.id)?.status !== 'found') continue;",
    to: '    if (idle) continue;',
    killed_by: [/a child whose subtask went back to pending is told a return to its dispatch/],
    why: 'a child of a subtask sent back to pending is never told a change, and a re-attach binds it under the old words',
  },
  {
    id: 'D26', file: STATE, tests: [TR],
    from: "    if (s.status !== 'in_progress' && reconciled.status !== 'unreadable' && !owed.has(s.id)) continue;",
    to: "    if (s.status !== 'in_progress') continue;",
    killed_by: [/a child whose subtask went back to pending is told a return to its dispatch/],
    why: 'the approval never reads the child of a subtask not in progress, so it is never told',
  },
  {
    id: 'D28', file: LIB, tests: [TR],
    from: "        : (!idle && 'profile' in d && 'topic' in d ? wordsOf(d) : null);",
    to: "        : ('profile' in d && 'topic' in d ? wordsOf(d) : null);",
    killed_by: [/a subtask not in progress whose child was never told has no row and no note/],
    why: 'a child never told anything is told words no approval can bind it to while its subtask is not in progress',
  },
  {
    id: 'C9', file: LIB, tests: [TR],
    from: '    if (!told || told.subtask !== subtaskId || told.contested === true || wordsDigest(told) !== entry.to_digest) {',
    to: '    if (false) {',
    killed_by: [/a rebound active child whose record of what it was told is not the rebinding's words is refused/],
    why: 'an active child is bound under a rebinding without having been told its words',
  },
  {
    id: 'C10', file: LIB, tests: [TR],
    from: '    if (!told || told.subtask !== subtaskId || told.contested === true || wordsDigest(told) !== entry.to_digest) {',
    to: '    if (!told || told.contested === true || wordsDigest(told) !== entry.to_digest) {',
    killed_by: [/a rebound active child whose record of what it was told is not the rebinding's words is refused/],
    why: 'words told for another subtask count as told for this one',
  },
  {
    id: 'C11', file: LIB, tests: [TR],
    from: '    if (!told || told.subtask !== subtaskId || told.contested === true || wordsDigest(told) !== entry.to_digest) {',
    to: '    if (!told || told.subtask !== subtaskId || told.contested === true) {',
    killed_by: [/a rebound active child whose record of what it was told is not the rebinding's words is refused/],
    why: 'a child told other words counts as told the rebinding\'s',
  },
  {
    id: 'B19', file: DRIVER, tests: [TA],
    from: '          hold: (worker) => { setWorker(worker); return [{ release: () => setWorker(null) }]; },',
    to: '          hold: null,',
    killed_by: [/an unfinished return to the dispatched words is told before the next step/],
    why: 'a serial run\'s boundary delivery runs off the run\'s locks',
  },
  {
    id: 'B20', file: SCHED, tests: [TA],
    from: '        hold: holdAt(repoRoot, id),',
    to: '        hold: null,',
    killed_by: [/the idle lane's child is told before its step while the other lane runs/],
    why: 'a lane\'s boundary delivery runs off the run\'s locks',
  },
  {
    id: 'B21', file: BOUNDARY, tests: [TA],
    from: "  return v.ok ? null : { due: 'refused', why: v.why };",
    to: '  return null;',
    killed_by: [/a child last told other words is not stepped \(serial\)/, /a child last told other words is not stepped \(lanes\)/, /rebindDue: a child last told other words is refused with the check's why/],
    why: 'a run steps a child last told other words, which the binding writes refuse: the boundary and the writes answer with two predicates again',
  },
  {
    id: 'B22', file: BOUNDARY, tests: [TA],
    from: "  if (due === 'refused') {",
    to: '  if (false) {',
    killed_by: [/rebindDue: a child last told other words is refused with the check's why/],
    why: 'a refused step is sent to rebind-deliver, which tells nothing, so the step runs under the words the check refused',
  },
  {
    id: 'B23', file: DRIVER, tests: [TA],
    from: '        ? rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null })\n        : null;',
    to: '        ? rebindDue(view.macro?.fm, d.step.subtaskId, { selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null })\n        : null;',
    killed_by: [/a child last told other words is not stepped \(serial\)/],
    why: 'a serial run asks the told check without the macro\'s path, so it cannot read the child\'s start as the writes do',
  },
  {
    id: 'B24', file: DRIVER, tests: [TA],
    from: '        const after = rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null });',
    to: '        const after = rebindDue(view.macro?.fm, d.step.subtaskId, { selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null });',
    killed_by: [/an unfinished return to the dispatched words is told before the next step/],
    why: 'the serial run\'s re-check after a delivery asks the told check without the macro\'s path',
  },
  {
    id: 'B25', file: SCHED, tests: [TA],
    from: '    const due = id ? rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path, selected: view.children?.[id]?.workflow_id ?? null }) : null;',
    to: '    const due = id ? rebindDue(view.macro?.fm, id, { selected: view.children?.[id]?.workflow_id ?? null }) : null;',
    killed_by: [/a child last told other words is not stepped \(lanes\)/],
    why: 'a lane asks the told check without the macro\'s path, so it cannot read the child\'s start as the writes do',
  },
  {
    id: 'B26', file: BOUNDARY, tests: [TA],
    from: "  if (typeof macroPath !== 'string' || macroPath === '') {",
    to: '  if (false) {',
    killed_by: [/rebindDue: a child last told other words is refused with the check's why/],
    why: 'a caller that leaves out the macro\'s path is answered, from no start, instead of refused',
  },
  {
    id: 'B27', file: STATE, tests: [TR],
    from: '  return readVouch({ frontmatter, workflowPath, subtaskId, current, child }).verdict;',
    to: '  return vouchVerdict({ fm: frontmatter, subtaskId, current, child, startedAt: () => null });',
    killed_by: [/after an unreadable record, a fresh dispatch is bound and retires its subtask's unknown, and never waits on it/],
    why: 'the boundary reads the child\'s start apart from the writes (here: none), and holds a fresh child the writes bind',
  },
  {
    id: 'B28', file: POLICY, tests: [TA],
    from: '  return digestOf({ entries, pending, told, ...now, ...(unknown ? { unknown } : {}) });',
    to: '  return digestOf({ entries, pending, told, ...(unknown ? { unknown } : {}) });',
    killed_by: [/a lane parked on the told check is picked up again when the plan is revised back to the words its child was told/, /the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'a lane parked on the told check stays parked when the plan is revised back to the words its child was told',
  },
  {
    id: 'B29', file: SCHED, tests: [TA],
    from: '    if (due && toldBefore) {',
    to: '    if (false) {',
    killed_by: [/a note reported told that the macro still holds stops the step \(lanes\), not a second delivery/],
    why: 'a lane whose note was reported told while the macro still holds it is told again, in a loop',
  },
  {
    id: 'B30', file: SCHED, tests: [TA],
    from: '      toldLanes.add(id);\n',
    to: '',
    killed_by: [/a note reported told that the macro still holds stops the step \(lanes\), not a second delivery/],
    why: 'the lane\'s delivery is not remembered, so its guard never holds the step',
  },
  {
    id: 'B31', file: DRIVER, tests: [TA],
    from: '        if (after) {\n          return await finish(\'halted\', {',
    to: '        if (false) {\n          return await finish(\'halted\', {',
    killed_by: [/a note reported told that the macro still holds stops the step \(serial\), not a second delivery/],
    why: 'a serial run whose note was reported told while the macro still holds it is told again, in a loop',
  },
  {
    id: 'B32', file: BOUNDARY, tests: [TA],
    from: "  const child = typeof owner === 'string' && owner !== '' ? owner : selected;",
    to: "  const child = typeof owner === 'string' && owner !== '' ? owner : null;",
    killed_by: [/an ownerless subtask's selected child last told other words is not stepped \(serial\)/, /an ownerless subtask's selected child last told other words is not stepped \(lanes\)/, /rebindDue: a child last told other words is refused with the check's why/],
    why: 'a subtask that records no owner is stepped without the told check, though its selected child was last told other words',
  },
  {
    id: 'B33', file: BOUNDARY, tests: [TA],
    from: "  const child = typeof owner === 'string' && owner !== '' ? owner : selected;",
    to: "  const child = typeof selected === 'string' && selected !== '' ? selected : owner;",
    killed_by: [/rebindDue: a child last told other words is refused with the check's why/],
    why: 'the boundary asks the selected child before the recorded owner, which the binding writes vouch',
  },
  {
    id: 'B34', file: DRIVER, tests: [TA],
    from: '        ? rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null })\n        : null;',
    to: '        ? rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path })\n        : null;',
    killed_by: [/an ownerless subtask's selected child last told other words is not stepped \(serial\)/],
    why: 'a serial run does not pass the child it selected, so an ownerless subtask is stepped unchecked',
  },
  {
    id: 'B35', file: DRIVER, tests: [TA],
    from: '        const after = rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path, selected: view.children?.[d.step.subtaskId]?.workflow_id ?? null });',
    to: '        const after = rebindDue(view.macro?.fm, d.step.subtaskId, { macroPath: view.macro?.path });',
    killed_by: [/a serial run asks the selected child again after a delivery, and halts when the check now refuses it/],
    why: 'the serial run\'s re-check after a delivery does not ask the child it selected',
  },
  {
    id: 'B36', file: SCHED, tests: [TA],
    from: '    const due = id ? rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path, selected: view.children?.[id]?.workflow_id ?? null }) : null;',
    to: '    const due = id ? rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path }) : null;',
    killed_by: [/an ownerless subtask's selected child last told other words is not stepped \(lanes\)/],
    why: 'a lane does not pass the child it selected, so an ownerless subtask is stepped unchecked',
  },
  {
    id: 'B37', file: STATE, tests: [TA],
    from: '  return { verdict: archived ? refused : unnamedExit(refused, { frontmatter, scanRoot, subtaskId, current, child }), archived, claim: c, fileLeft };',
    to: '  return { verdict: refused, archived, claim: c, fileLeft };',
    killed_by: [/an ownerless subtask's selected child last told other words is not stepped \(serial\)/, /an ownerless subtask's selected child last told other words is not stepped \(lanes\)/],
    why: 'a child no approval can tell (no owner, several claimants) is pointed to an approval as its way out',
  },
  {
    id: 'B38', file: STATE, tests: [TA],
    from: "  if (verdict.ok || scanRoot === null || (typeof owner === 'string' && owner !== '')) return verdict;",
    to: '  if (verdict.ok || scanRoot === null) return verdict;',
    killed_by: [/a child last told other words is not stepped \(serial\)/, /a child last told other words is not stepped \(lanes\)/],
    why: 'a recorded owner, which an approval tells, is pointed to recording the owner first',
  },
  {
    id: 'B39', file: POLICY, tests: [TA],
    from: '  const rebind = rebindFacts(view?.macro?.fm, subtaskId, { words: opts.words === true });',
    to: '  const rebind = rebindFacts(view?.macro?.fm, subtaskId, { words: true });',
    killed_by: [/the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'a plan revision of the subtask\'s words counts as the progress of a step that did nothing',
  },
  {
    id: 'B40', file: POLICY, tests: [TA],
    from: "  if (form === 'lane') return laneFingerprint(view, subtaskId, { words: true });",
    to: "  if (form === 'lane') return laneFingerprint(view, subtaskId);",
    killed_by: [/a lane parked on the told check is picked up again when the plan is revised back to the words its child was told/, /the lane fingerprint takes the record's facts only for the subtask it names/],
    why: 'a lane\'s park leaves out the subtask\'s words, so a revision back to the words its child was told never resumes it',
  },
  {
    id: 'B41', file: BOUNDARY, tests: [TA],
    from: "  if (held !== null) return `subtask ${subtaskId}'s note was told, but ${held}`;\n",
    to: '',
    killed_by: [/a hold that changed kind during the delivery names its own way out \(serial\)/, /a hold that changed kind during the delivery names its own way out \(lanes\)/],
    why: 'a hold that changed kind after its note was told is reported as a pending note, with a way out that tells nothing more',
  },
  {
    id: 'B42', file: STATE, tests: [TA],
    from: "      changed = dispatchMismatches({ frontmatter, subtaskId, current, expectDispatch: dispatch }).map((m) => m.field);\n",
    to: '',
    killed_by: [/an ownerless subtask revised to words its selected child was never dispatched for names the way out that restores them/],
    why: 'an ownerless child whose record would be refused dispatch-changed is told to record it first, a way out that fails',
  },
  {
    id: 'B43', file: STATE, tests: [TA],
    from: '  const fixed = changed.filter((f) => !REBINDABLE_FIELDS.includes(f));\n',
    to: '  const fixed = [];\n',
    killed_by: [/an ownerless subtask whose verb changed too names a way out that keeps the dispatched verb/],
    why: 'an ownerless child whose verb or branch changed is told to revise the plan again after its record, which no approval rebinds',
  },

  // ---- The fourth critique's MAJOR 1-3 (review-20261023T140712Z-8cb614) -----
  {
    id: 'D33', file: LIB, tests: [TR],
    from: '      if (keepsTold(child, t.subtask)) {',
    to: '      if (keeps(child, t.subtask)) {',
    killed_by: [/an owner switch keeps what the first child was last told/],
    why: 'an approval that selects another child of the subtask drops what the first was told, so switching back accepts it under words its latest note contradicts',
  },
  {
    id: 'D34', file: LIB, tests: [TR],
    from: '    else if (!v.ok) row.refused = v.why;\n',
    to: '    else if (false) row.refused = v.why;\n',
    killed_by: [/an archived child last told other words is shown refused and never audited rebound/, /an owner switch keeps what the first child was last told/],
    why: 'the approval shows an archived child its writes will refuse as rebound, or not at all',
  },
  {
    id: 'D35', file: LIB, tests: [TR],
    from: '    if (shown || archivedRow) {',
    to: '    if (shown) {',
    killed_by: [/an archived child last told other words is shown refused and never audited rebound/, /an owner switch keeps what the first child was last told/],
    why: 'an archived child refused, but matching its dispatch, is not shown at the approval',
  },
  {
    id: 'D36', file: LIB, tests: [TR],
    from: '    else if (!v.ok) row.refused = v.why;\n',
    to: "    else if (true) row.refused = v.ok ? 'refused' : v.why;\n",
    killed_by: [/an archived child, approved after its commit, is bound and completed with no note/],
    why: 'every archived child is shown refused, the C147 case (told nothing else) included',
  },
  {
    id: 'W5', file: STATE, tests: [TR],
    from: '    if (row.refused !== undefined) {\n',
    to: '    if (false) {\n',
    killed_by: [/an archived child last told other words is shown refused and never audited rebound/],
    why: 'the macro\'s audit records as rebound an archived child its writes refuse',
  },
  {
    id: 'N14', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: "  if (active.length > 0 || unparsedActive) return !unparsedActive && active.length > 0 && active.every(holds) ? 'all' : false;\n",
    to: "  if (active.length > 0 || unparsedActive) return claim.files.some(holds) ? 'all' : false;\n",
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): deliveryWritten runs only when one file bears the child, so "every active copy" and "some copy" are that one file; the defect it caught before: a note in an archived copy acknowledges a delivery the active copy never received',
  },
  {
    id: 'N15', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: '  const unparsedActive = childFileUnparsed(repoRoot, p.child, { activeOnly: true });\n',
    to: '  const unparsedActive = false;\n',
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): deliveryWritten runs only when one file bears the child, and an unparsed active file beside its claim would be a second; the defect it caught before: with the active copy unparsed, an archived copy acknowledges the delivery the repaired copy never received',
  },
  {
    id: 'N16', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: "  return held === 0 ? false : held === claim.files.length && !childFileUnparsed(repoRoot, p.child) ? 'all' : 'contested';\n",
    to: "  return held === claim.files.length && !childFileUnparsed(repoRoot, p.child) ? 'all' : false;\n",
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): deliveryWritten runs only when one file bears the child, so its archived copies never disagree; the defect it caught before: a child archived in copies that disagree is read as never told, so its note and its record are dropped',
  },
  {
    id: 'N17', file: LIB, tests: [TR],
    from: "      : replacedAt === LATER_THAN_ANY_START ? 'this approval' : `an approval at ${replacedAt}`} replaced an ` +",
    to: "      : `an approval at ${replacedAt}`} replaced an ` +",
    killed_by: [/an archived child's refusal names the replacing approval, never a sentinel time/],
    why: 'an approval that replaces an unreadable record shows and audits the comparison\'s sentinel time',
  },
  {
    id: 'N18', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: "  return held === 0 ? false : held === claim.files.length && !childFileUnparsed(repoRoot, p.child) ? 'all' : 'contested';\n",
    to: "  return held === 0 ? false : 'all';\n",
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): deliveryWritten runs only when one file bears the child, so its archived copies never disagree; the defect it caught before: a child archived in copies that disagree is taken as told the words of the copy that holds the note',
  },
  {
    id: 'N19', file: STATE, tests: [TR],
    from: '  if (childFileUnparsed(repoRoot, claim.id, { activeOnly: true })) {\n',
    to: '  if (active.length === 0 && childFileUnparsed(repoRoot, claim.id, { activeOnly: true })) {\n',
    killed_by: [/an unparsed active copy beside a readable one makes the child unreadable to the approval/],
    why: 'beside an unparsed active copy, the approval takes the readable one as the child and drops its pending note and what it was told',
  },
  {
    id: 'D37', file: LIB, tests: [TR],
    from: '  const toldNow = toldThis && told.contested !== true && wordsDigest(told) === wordsDigest(current);\n',
    to: '  const toldNow = toldThis && wordsDigest(told) === wordsDigest(current);\n',
    killed_by: [/the told check, read alone/],
    why: 'a contested entry binds the words it names, so both writes accept a child one of whose copies was last told other words',
  },
  {
    id: 'D38', file: LIB, tests: [TR],
    from: '...(contested ? { contested: true } : {}) };\n',
    to: '};\n',
    killed_by: [/a contested restating note leaves its subtask unknown/],
    why: 'a contested acknowledgement is recorded as plain told words, which bind',
  },
  {
    id: 'D39', file: LIB, tests: [TR],
    from: "(unknownSet.has(s.id) || lost || contested)) {\n",
    to: "(unknownSet.has(s.id) || lost)) {\n",
    killed_by: [/a dropped note held by a copy the claim scan does not count is kept told, contested/],
    why: 'a contested child found active again is told nothing, so it never binds and is never told the words',
  },
  {
    id: 'D40', file: LIB, tests: [TR],
    from: "  if (!contested && p.restate === true && Array.isArray(record.unknown)) {\n",
    to: "  if (p.restate === true && Array.isArray(record.unknown)) {\n",
    killed_by: [/a contested restating note leaves its subtask unknown/],
    why: 'a contested acknowledgement of a restating note retires its subtask\'s unknown, so a child dispatched since binds unrestated',
  },
  {
    // An equivalent mutation at every binding write: each also asks the told
    // check (vouchRecord), which refuses a contested entry whatever the
    // rebinding's own check says (the peer of refine-verify-20261024T095850Z-f369aa
    // and this run both saw it survive the whole suite). The guard is kept so
    // the rebinding never vouches alone.
    id: 'D41', file: LIB, tests: [TR], expect: 'SURVIVED',
    from: '    if (!told || told.subtask !== subtaskId || told.contested === true || wordsDigest(told) !== entry.to_digest) {',
    to: '    if (!told || told.subtask !== subtaskId || wordsDigest(told) !== entry.to_digest) {',
    why: 'the told check refuses a contested entry at every write that asks the rebinding\'s check, so removing its guard there changes no outcome',
  },
  {
    id: 'N20', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: "held === claim.files.length && !childFileUnparsed(repoRoot, p.child) ? 'all' : 'contested';\n",
    to: "held === claim.files.length ? 'all' : 'contested';\n",
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): deliveryWritten runs only when one file bears the child, and an unparsed archive beside its claim would be a second; the defect it caught before: an archived copy the claim scan skips is left out of "every copy", so a child one of whose copies was last told other words is acknowledged told the note\'s',
  },
  {
    id: 'N21', file: STATE, tests: [TR],
    from: '  if (verdict.ok && scanRoot !== null) {\n',
    to: '  if (false) {\n',
    killed_by: [/a copy swapped in after a delivery does not hold its note/],
    why: 'the record vouches for the child whatever copy it runs from, so a copy swapped in after the delivery binds with no note',
  },
  {
    id: 'N22', file: STATE, tests: [TR],
    from: "  if (active.length > 0) return active.every(holds) ? 'held' : 'missing';\n",
    to: "  if (active.length > 0) return 'held';\n",
    killed_by: [/a copy swapped in after a delivery does not hold its note/],
    why: 'an active copy without the note the record names is taken to hold it',
  },
  {
    id: 'N23', file: STATE, tests: [TR],
    from: "info.child_state === 'active' ? heldNow === 'missing' :",
    to: "info.child_state === 'active' ? false :",
    killed_by: [/a copy swapped in after a delivery does not hold its note/],
    why: 'the approval tells nothing to an active child whose copy lacks the note its binding writes refuse it for, so it never binds',
  },
  {
    id: 'D42', file: LIB, tests: [TR],
    from: '(kept.contested === true || info.told_missing === true));\n',
    to: 'kept.contested === true);\n',
    killed_by: [/a copy swapped in after a delivery does not hold its note/],
    why: 'the approval tells nothing to an active child whose copy lacks the note its binding writes refuse it for, so it never binds',
  },
  {
    id: 'N24', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: 'deliveryHeldSomewhere({ repoRoot: scanRoot, macroId, p })) partial.add(p.delivery_id);\n',
    to: 'false) partial.add(p.delivery_id);\n',
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): a note one file of the child holds is acknowledged before this reads it; held by another, the child has two files, and the copies guard marks it partial first; the defect it caught before: a note a copy of the child holds is dropped as never told, so every binding write accepts the child under the words it was dispatched for',
  },
  {
    id: 'D43', file: LIB, tests: [TR],
    from: '      told[p.child] = { subtask: p.subtask, ...wordsOf(p.to), delivery_id: p.delivery_id, at: nowIso ?? prev.approval.at, contested: true };\n',
    to: '',
    killed_by: [/a note dropped with its subtask back to pending, a copy holding it, is recorded told, contested/],
    why: 'the approval drops a note a copy of the child holds and records nothing, so every binding write accepts the child under the words it was dispatched for',
  },
  // The r15 Refine-verify (refine-verify-20261024T143445Z-02edc0): the copies
  // the copy checks could not see.
  {
    id: 'D44', file: LIB, tests: [TR],
    from: '    const contested = partialHere || (',
    to: '    const contested = (',
    killed_by: [/a pending note only an archived copy holds, beside a found active copy, is restated to it/],
    why: 'a found active child, a pending note to which only another copy holds, is told nothing, so once that copy is restored as active it binds under the note\'s other words',
  },
  {
    id: 'D45', file: LIB, tests: [TR],
    from: '      if (!open.has(p.subtask)) continue;\n',
    to: '      if (!open.has(p.subtask) || decidedChildren.has(p.child)) continue;\n',
    killed_by: [/a pending note only an archived copy holds is kept, contested, by a row that cannot rebind/],
    why: 'a row that decides the child but sends it no note drops the partial evidence, so the copy holding the note binds once restored',
  },
  {
    id: 'N25', file: STATE, tests: [TR],
    from: '          if (scanRoot !== null) partial.add(p.delivery_id);\n',
    to: '',
    killed_by: [/a claim scan that throws beside a child one file bears is partial evidence/],
    why: 'a claim scan that throws where one file bears the child (a stray claimant with no workflow id) is read as "never told", so the approval drops the note and the re-attach accepts the child under the words it was dispatched for (not equivalent under ruling D: the copies guard sees one file, the r18 critique)',
  },
  {
    id: 'N26', file: STATE, tests: [TR],
    from: String.raw`(-\\d{8}T\\d{6}Z-[0-9a-f]{6})*\\.md$`,
    to: String.raw`\\.md$`,
    killed_by: [/an unparsed archive under the archiver's collision suffix is a copy/, /--waive-dispatch is refused while an archive of the child under the archiver's collision suffix is left/],
    why: 'an archive under the archiver\'s collision suffix is no copy, so an unparsed one leaves the copies acknowledged told the note\'s words plain',
  },
  {
    id: 'N27', file: STATE, tests: [TR],
    from: '          if (childCopyNames(join(root, ...home, sub), childId).length > 0) return true;\n',
    to: '          lstatSync(join(root, ...home, sub, `${childId}.md`));\n          return true;\n',
    killed_by: [/--waive-dispatch is refused while an archive of the child under the archiver's collision suffix is left/],
    why: 'a child whose only file is a suffixed archive counts as gone, so --waive-dispatch waives the told check with a copy of it left',
  },
  {
    id: 'N28', file: STATE, tests: [TR],
    from: "  if (others.has(child)) return 'conflict';\n",
    to: '',
    killed_by: [/a child whose only file claims another subtask is refused as such/],
    why: 'a file of the child that claims another subtask is no copy, so the archived claimant vouches for a child that runs from other words',
  },
  {
    id: 'N29', file: STATE, tests: [TR], expect: 'SURVIVED',
    from: '  if (others.has(p.child)) return false;\n',
    to: '',
    why: 'equivalent under the owner\'s ruling D (more than one file bearing the child refuses it before any copy is judged): deliveryWritten runs only when one file bears the child: a file of its id claiming another subtask is then its only one, and the claim scan finds no claimant first; the defect it caught before: a note held by the archived claimant is acknowledged while a file of the child that claims another subtask may be the one that runs',
  },
  {
    id: 'N30', file: STATE, tests: [TR],
    from: "heldNow === 'missing' : heldNow !== 'held') info.told_missing",
    to: "heldNow === 'missing' : false) info.told_missing",
    killed_by: [/an archived child whose copy does not hold its told note is shown refused and audited refused/],
    why: 'an archived child whose copy lacks its told note is shown and audited as rebound, though every binding write refuses it',
  },
  {
    id: 'D46', file: LIB, tests: [TR],
    from: '    else if (info.told_missing === true) {\n',
    to: '    else if (false) {\n',
    killed_by: [/an archived child whose copy does not hold its told note is shown refused and audited refused/],
    why: 'an archived child whose copy lacks its told note is shown and audited as rebound, though every binding write refuses it',
  },
  {
    id: 'D47', file: LIB, tests: [TR],
    from: "  const digest = digestOf({ record: previous?.status ?? 'absent', rows, carried, untouched, unknown });\n",
    to: "  const digest = digestOf({ record: previous?.status ?? 'absent', rows, carried, untouched: { told: untouched.told, pending: untouched.pending }, unknown });\n",
    killed_by: [/the digest binds a dropped note recorded contested/],
    why: 'the approval binds no digest to a note it keeps contested, so an approval shown before that evidence appeared records it unseen',
  },

  // ---- More than one file bearing the child (the owner's ruling D, r16) -----
  {
    id: 'V47', file: STATE, tests: [TR],
    from: '  for (const f of engineerWorkflowFiles(repoRoot)) if (f.values.workflow_id === childId) add(f.path, f.active);\n',
    to: '',
    killed_by: [/a dropped note held by a copy the claim scan does not count is kept told, contested/],
    why: 'a copy under another name, found only by the workflow id it records, is not counted: its note is dropped and the child bound under words it was not last told',
  },
  {
    id: 'V48', file: STATE, tests: [TR],
    from: '  if (bearers.length <= 1) return null;\n',
    to: '  if (bearers.length <= 2) return null;\n',
    killed_by: [/a file of the child's name under another workflow id is a copy/, /an archive suffixed twice is a copy/],
    why: 'two files bearing the child are judged copy by copy, which six reviews in a row found blind to one of them',
  },
  {
    id: 'V49', file: STATE, tests: [TR],
    from: "    return { verdict: { ok: false, why: copiesRefusal(child, { ...copies, archived }) }, archived, claim: c, fileLeft: () => true };\n",
    to: "    if (false) return { verdict: { ok: false, why: copiesRefusal(child, { ...copies, archived }) }, archived, claim: c, fileLeft: () => true };\n",
    killed_by: [/a file of the child's name under another workflow id is a copy/],
    why: 'the binding writes and the boundary accept a child two files bear, one of them last told other words',
  },
  {
    id: 'V50', file: STATE, tests: [TR],
    from: '    const archived = c !== null && c.active === false && !copies.active;\n',
    to: '    const archived = c !== null && c.active === false;\n',
    killed_by: [/an archived child beside an active file of its id is shown refused without the told waiver/],
    why: 'the told waiver completes a child an active file of which, claiming another subtask, may still run',
  },
  {
    id: 'V51', file: STATE, tests: [TR],
    from: "  const copyName = new RegExp(`^${stem}(-\\\\d{8}T\\\\d{6}Z-[0-9a-f]{6})*\\\\.md$`);\n",
    to: "  const copyName = new RegExp(`^${stem}(-\\\\d{8}T\\\\d{6}Z-[0-9a-f]{6})?\\\\.md$`);\n",
    killed_by: [/an archive suffixed twice is a copy/],
    why: 'an archive the archiver suffixed twice is not a copy: unparsed, its note is acknowledged plain and the child bound',
  },
  {
    id: 'N31', file: STATE, tests: [TR],
    from: '      if (childCopies(scanRoot, p.child) !== null) {\n        partial.add(p.delivery_id);\n',
    to: '      if (false) {\n        partial.add(p.delivery_id);\n',
    killed_by: [/a dropped note held by a copy the claim scan does not count is kept told, contested/],
    why: 'an approval acknowledges, or drops as never told, a note to a child two files bear',
  },
  {
    id: 'N32', file: STATE, tests: [TR],
    from: "      wait('copies', `${copiesRefusal(p.child, { ...copies, archived: false })}; the note waits until then`);\n      continue;\n",
    to: "      wait('copies', `${copiesRefusal(p.child, { ...copies, archived: false })}; the note waits until then`);\n",
    killed_by: [/no note is delivered to a child more than one file bears/, /an archive suffixed twice is a copy/],
    why: 'a delivery writes and acknowledges a note to one of two files bearing the child, reading back only that one',
  },
  {
    id: 'D48', file: LIB, tests: [TR],
    from: '    if (info.copies) row.refused = copiesRefusal(info.child, { ...info.copies, archived: !info.copies.active });\n',
    to: '    if (info.copies) row.refused = copiesRefusal(info.child, { ...info.copies, archived: true });\n',
    killed_by: [/an archived child beside an active file of its id is shown refused without the told waiver/],
    why: 'the approval offers the told waiver for an archived child beside an active file of its id, which the write refuses',
  },
  // The r17 Refine-verify (refine-verify-20261025T013041Z-672a1d).
  {
    id: 'B44', file: BOUNDARY, tests: [TR],
    from: "  const record = parsed.status === 'readable' ? parsed.record : null;\n",
    to: "  if (parsed.status !== 'readable') return null;\n  const record = parsed.record;\n",
    killed_by: [/the run boundary refuses a child two files bear with no record of rebindings/],
    why: 'with no record of rebindings, a run steps a child two files bear, whose writeback every binding write then refuses',
  },
  {
    id: 'V52', file: STATE, tests: [TR],
    from: '    if (known) known.active ||= active;\n',
    to: '    if (known) void active;\n',
    killed_by: [/a second file linked into a workflow home is active/],
    why: 'a file counted once keeps the activity of the name met first, so an archive linked into a workflow home reads archived and the told waiver completes a child that may still run',
  },
  {
    id: 'V53', file: STATE, tests: [TR],
    from: "              if (known && sub === 'workflows') known.active = true;\n",
    to: '',
    killed_by: [/an archived file linked into a workflow home is active/],
    why: 'a claimant linked into a workflow home reads archived, so the approval shows a child that may still run as archived',
  },
  {
    id: 'N33', file: STATE, tests: [TR],
    from: '    if (copiesAfter !== null) {\n',
    to: '    if (false) {\n',
    killed_by: [/gains a second file while its note is written/],
    why: 'a delivery acknowledges a note to a child that a second file came to bear while the note was written',
  },
  // The r18 critique (review-20261025T073152Z-e39b3d): the archiver's own
  // move read as two copies, and the limits L1 and L2.
  {
    id: 'V54', file: STATE, tests: [TR],
    from: '    if (found === previous || attempt >= COPY_SCAN_ATTEMPTS) {\n',
    to: '    if (true) {\n',
    killed_by: [/the copy count is the scan's only when it holds/],
    why: 'one scan decides: a file met under two names while the archiver moves it, or between the scan\'s two passes, refuses every binding write and parks the lane, and an approval in that window keeps the note as partial evidence',
  },
  {
    id: 'V55', file: STATE, tests: [TR],
    from: '    if (found === previous || attempt >= COPY_SCAN_ATTEMPTS) {\n',
    to: '    if (attempt >= COPY_SCAN_ATTEMPTS && found !== previous) return null;\n    if (found === previous) {\n',
    killed_by: [/the copy count is the scan's only when it holds/],
    why: 'a count that never settles is taken as one file, so a child whose copies keep changing is judged copy by copy (fails open)',
  },
  {
    id: 'V56', file: STATE, tests: [TR],
    from: '  const { dev, ino } = statSync(path);\n  return `${dev}:${ino}`;\n',
    to: '  return realpathSync(path);\n',
    killed_by: [/a hard link of the child's file, and a link whose target is gone, are no second copy/],
    why: 'a hard link of the child\'s one file counts as a second copy, so every binding write refuses a child one file bears',
  },
  {
    id: 'V57', file: STATE, tests: [TR],
    from: "      if (err.code === 'ENOENT') return;\n      throw err;\n    }\n    const known = bearers.get(identity);\n",
    to: "      if (err.code !== 'ENOENT') throw err;\n      identity = path;\n    }\n    const known = bearers.get(identity);\n",
    killed_by: [/a hard link of the child's file, and a link whose target is gone, are no second copy/],
    why: 'a link of the child\'s name whose target is gone counts as a copy, so a child one file bears is refused',
  },
  {
    id: 'V58', file: STATE, tests: [TR],
    from: '        paths: bearers.map((b) => b.path).sort(), sameNotes: sameNotes(bearers), error: null,\n',
    to: '        paths: bearers.map((b) => b.path).sort(), sameNotes: false, error: null,\n',
    killed_by: [/an archive killed before it removed the workflow file, then retried/],
    why: 'the refusal of an interrupted or retried archive does not name its repair, which loses nothing: keep one file and remove the others',
  },
  {
    id: 'V59', file: LIB, tests: [TR],
    from: "    ? `the files that may bear it cannot all be read${error ? `: ${error}` : ''}`\n",
    to: "    ? 'the files that may bear it cannot all be read'\n",
    killed_by: [/a home the copy scan cannot read refuses the child, naming what it could not read/],
    why: 'a scan error refuses every binding write while the refusal says only that the files cannot all be read, so the owner cannot find the entry to repair',
  },

  // ---- K: the runbooks -------------------------------------------------------
  {
    id: 'K1', file: APPROVE_MD, tests: [TRB],
    from: '  --expect-hash "$PLAN_HASH" --expect-rebind "$REBIND_DIGEST" || exit 1',
    to: '  --expect-hash "$PLAN_HASH" || exit 1',
    killed_by: [/passes the shown rebind_digest as --expect-rebind/, /shows the in-progress children it rebinds and tells/],
    why: '/orchestrator:approve approves a rebinding view it did not bind to',
  },
  {
    id: 'K2', file: APPROVE_MD, tests: [TRB],
    from: 'r.delivery?(r.delivery.restate?"told its words in full":"told the change of "+r.delivery.fields.join(", ")):""',
    to: '""',
    killed_by: [/shows the in-progress children it rebinds and tells/],
    why: 'the owner is not shown which children the approval tells',
  },
  {
    id: 'K3', file: STATE, tests: [TR],
    from: "          expectRebind: flags['expect-rebind'],",
    to: '          expectRebind: undefined,',
    killed_by: [/plan-hash prints the view and its digest, and the CLI approval binds to them/],
    why: 'plan-approve drops the --expect-rebind it was given',
  },
  {
    id: 'K4', file: STATE, tests: [TR],
    from: '          rebind_digest: view.digest,',
    to: "          rebind_digest: `${view.digest.slice(1)}0`,",
    killed_by: [/plan-hash prints the view and its digest, and the CLI approval binds to them/],
    why: 'plan-hash prints a digest that is not the view\'s',
  },
  {
    // The done runbook's suite, run on its own from an agentic session
    // (an autopilot worker), ran the installed orchestrator instead of this
    // tree's: its shells inherited AGENTIC_ORCHESTRATOR_ROOT.
    id: 'K5', file: TD, tests: [TD],
    from: 'const runbookEnv = () => Object.fromEntries(Object.entries({ ...process.env, ...GIT_ENV, ...GIT_IDENTITY }).filter(([k]) => !isSessionVariable(k)));',
    to: 'const runbookEnv = () => ({ ...process.env, ...GIT_ENV, ...GIT_IDENTITY });',
    killed_by: [/the runbook shell starts without the session's inherited AGENTIC_\* variables/],
    why: 'a runbook shell inherits the session\'s plugin roots and run marker, and tests the installed plugins instead of this tree',
  },
  {
    id: 'K6', file: APPROVE_MD, tests: [TRB],
    from: '+(r.refused!==undefined?"; refused at every write that binds it: "+r.refused:"")',
    to: '',
    killed_by: [/shows an archived child last told other words refused/],
    why: '/orchestrator:approve\'s table leaves out the refusal an archived child\'s writes will meet',
  },
];
