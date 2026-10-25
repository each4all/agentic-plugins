// scripts/lib/rebind.mjs — ADR-0068 Decision 8: rebinding a dispatched
// subtask after an owner-approved change of its instructions.
//
// The record an approval keeps, and the rules over it, with no IO: state.mjs
// reads the macro and the children it names and writes, under its locks.
//
// Where it is kept (item 7). One scalar frontmatter key of the macro,
// `plan_rebindings`, whose value is one JSON string, beside a second scalar,
// `plan_approval_id`, the random id of the approval that wrote it. An older
// orchestrator carries an unknown scalar key through its forward-compat
// carrier and refuses an unknown block key, so both are scalars, and neither
// is in the plan hash. The record holds:
//   - `approval`: the stamp of the approval that wrote it, {id, at, hash}. It
//     binds only while the macro's approval carries the same three values: a
//     plan-set clears them, so its rebindings are suspended (item 6). An
//     older approver keeps the id it does not know, so its approval of the
//     identical plan within the same second is the one it cannot be told
//     apart from: the narrowing approve.md states.
//   - `rebindings`: one entry per child the approval rebound, from the digest
//     of the dispatch the child records to the digest of the words approved.
//   - `carried`: the entries of subtasks completed since, kept as recorded.
//   - `told`: per child of a subtask not completed, the words it was last
//     told, when a delivery told it (otherwise its dispatch's). An entry
//     marked `contested` was acknowledged from a child archived everywhere
//     whose copies disagree (some hold the note, some do not): the child is
//     told, and no words bind it, so every write that binds it refuses, until
//     a note an approval restates to it, once it is found active, is
//     delivered (item 4). An approval that drops a pending note some copy of
//     its child holds, though not every copy, records it told so, contested.
//     The entry counts only while every copy the child may run from holds the
//     note it names (state.mjs readVouch, at every write that binds): the
//     record names the child, not a copy.
//   - `pending`: the deliveries not yet acknowledged, with the old and new
//     words, so a note written before a concurrent plan-set is still
//     recognised and acknowledged by its id. One marked `restate` tells the
//     words in full: what its child was last told is not known, so no old
//     words are quoted.
//   - `unknown`: the subtasks whose child's last words are not known, because
//     an approval replaced a record it could not read while they were in
//     progress. Each stays named while it is in progress, until a restating
//     note to its child is acknowledged, its child is found archived, or a
//     child dispatched since is bound to it, whatever the approvals in between
//     can tell it.
//   - `replaced_at`: when an approval last replaced a record it could not
//     read. What a child dispatched by then was told is known only from a
//     `told` entry written since: every write that binds such a child checks
//     it (vouchVerdict), and every approval restates it to one it finds active.
// Text is kept only in `told` and `pending`; the rest are digests. The record
// is capped (REBIND_RECORD_MAX_BYTES).

import { createHash, randomBytes } from 'node:crypto';

export const REBIND_KEY = 'plan_rebindings';
export const APPROVAL_ID_KEY = 'plan_approval_id';
export const REBIND_RECORD_MAX_BYTES = 64 * 1024;
// The fields an approval rebinds (item 1): the words of the instructions.
export const REBINDABLE_FIELDS = Object.freeze(['profile', 'topic']);
export const CHILD_STATES = Object.freeze(['active', 'archived']);

const APPROVAL_ID_RE = /^[0-9a-f]{32}$/;
const DELIVERY_ID_RE = /^d-[0-9a-f]{16}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export const newApprovalId = () => randomBytes(16).toString('hex');
export const newDeliveryId = () => `d-${randomBytes(8).toString('hex')}`;
export const isApprovalId = (v) => typeof v === 'string' && APPROVAL_ID_RE.test(v);
export const isDeliveryId = (v) => typeof v === 'string' && DELIVERY_ID_RE.test(v);

// JSON with object keys sorted at every level, so a digest does not depend on
// the order keys were written in.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digestOf = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

// A field as the dispatch comparison reads it: absent and empty alike,
// trailing newlines dropped (state.mjs EXPECTED_SUBTASK_FIELDS).
export const fieldText = (value) => String(value || '').replace(/\n+$/, '');

// The words of an instruction, as the comparison reads them.
export const wordsOf = (source) => ({ profile: fieldText(source?.profile), topic: fieldText(source?.topic) });
export const wordsDigest = (source) => digestOf(wordsOf(source));

// The dispatch a child records, in the form --expect-dispatch takes, as the
// comparison reads it: the identity and every field it recorded.
export function dispatchDigest(dispatch) {
  const out = { macro: dispatch.macro, subtask: dispatch.subtask, branch: dispatch.branch };
  for (const field of ['verb', 'profile', 'topic']) {
    if (field in dispatch) out[field] = fieldText(dispatch[field]);
  }
  return digestOf(out);
}

// The approval stamp the macro carries now: the record binds only while it is
// its own.
export const approvalStamp = (fm) => ({
  id: fm?.[APPROVAL_ID_KEY] ?? null,
  at: fm?.plan_approval_approved_at ?? null,
  hash: fm?.plan_approval_plan_hash ?? null,
});

export function stampMatches(record, fm) {
  const now = approvalStamp(fm);
  return record.approval.id === now.id && record.approval.at === now.at && record.approval.hash === now.hash;
}

// ---------------------------------------------------------------------------
// The record's form

function fail(message) {
  throw new Error(message);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

function checkWords(words, where) {
  if (!isObject(words) || typeof words.profile !== 'string' || typeof words.topic !== 'string') {
    fail(`${where} must hold the strings profile and topic`);
  }
  for (const k of Object.keys(words)) if (k !== 'profile' && k !== 'topic') fail(`${where} has an unknown key ${k}`);
}

function checkEntry(entry, where) {
  if (!isObject(entry)) fail(`${where} is not an object`);
  if (!nonEmpty(entry.subtask) || !nonEmpty(entry.child)) fail(`${where} names no subtask or child`);
  if (!CHILD_STATES.includes(entry.child_state)) fail(`${where}.child_state is not active or archived`);
  if (!DIGEST_RE.test(entry.from_digest ?? '') || !DIGEST_RE.test(entry.to_digest ?? '')) fail(`${where} holds no digest`);
  if (!Array.isArray(entry.fields) || entry.fields.length === 0 || !entry.fields.every((f) => REBINDABLE_FIELDS.includes(f))) {
    fail(`${where}.fields must name profile or topic`);
  }
}

function checkRecord(r) {
  if (!isObject(r) || r.v !== 1) fail('not a version 1 record');
  const a = r.approval;
  if (!isObject(a) || !isApprovalId(a.id) || !nonEmpty(a.at) || !HASH_RE.test(a.hash ?? '')) fail('approval is not a stamp {id, at, hash}');
  for (const list of ['rebindings', 'carried', 'pending']) if (!Array.isArray(r[list])) fail(`${list} is not a list`);
  r.rebindings.forEach((e, i) => checkEntry(e, `rebindings[${i}]`));
  r.carried.forEach((e, i) => checkEntry(e, `carried[${i}]`));
  if (!isObject(r.told)) fail('told is not an object');
  if (r.replaced_at !== undefined && !Number.isFinite(Date.parse(r.replaced_at ?? ''))) fail('replaced_at is not a time');
  if (r.unknown !== undefined) {
    if (!Array.isArray(r.unknown) || !r.unknown.every(nonEmpty) || new Set(r.unknown).size !== r.unknown.length) {
      fail('unknown is not a list of distinct subtask ids');
    }
  }
  for (const [child, told] of Object.entries(r.told)) {
    if (!isObject(told) || !nonEmpty(told.subtask) || !isDeliveryId(told.delivery_id) || !nonEmpty(told.at)) fail(`told[${child}] is malformed`);
    checkWords({ profile: told.profile, topic: told.topic }, `told[${child}]`);
    if (told.contested !== undefined && told.contested !== true) fail(`told[${child}].contested is not true`);
  }
  const ids = new Set();
  const children = new Set();
  r.pending.forEach((p, i) => {
    if (!isObject(p) || !isDeliveryId(p.delivery_id) || !nonEmpty(p.child) || !nonEmpty(p.subtask)) fail(`pending[${i}] is malformed`);
    checkWords(p.from, `pending[${i}].from`);
    checkWords(p.to, `pending[${i}].to`);
    if (p.restate !== undefined && p.restate !== true) fail(`pending[${i}].restate is not true`);
    if (ids.has(p.delivery_id) || children.has(p.child)) fail(`pending[${i}] repeats a delivery or a child`);
    ids.add(p.delivery_id);
    children.add(p.child);
  });
}

/**
 * The record a macro carries: { status: 'absent' } when it has none,
 * { status: 'readable', record }, or { status: 'unreadable', error }. An
 * unreadable record never fails a read of the macro: the comparison binds
 * nothing from it and says so, delivery refuses, and the next approval
 * replaces it.
 */
export function parseRebindRecord(raw) {
  if (raw === undefined || raw === null) return { status: 'absent', record: null };
  try {
    if (typeof raw !== 'string') fail('the value is not a JSON string');
    const record = JSON.parse(raw);
    checkRecord(record);
    return { status: 'readable', record };
  } catch (err) {
    return { status: 'unreadable', record: null, error: err.message };
  }
}

// The scalar the macro stores, refused past the cap (measured as the line the
// serializer writes, escapes included).
export function serializeRebindRecord(record) {
  checkRecord(record);
  const text = JSON.stringify(record);
  const size = Buffer.byteLength(JSON.stringify(text), 'utf8');
  if (size > REBIND_RECORD_MAX_BYTES) {
    fail(
      `the record of this approval's rebindings would take ${size} bytes, over the cap of ${REBIND_RECORD_MAX_BYTES} ` +
        '(ADR-0068 Decision 8): the instruction text of the in-progress subtasks it tells is too long. Shorten it, ' +
        'or approve with fewer changes in flight.',
    );
  }
  return text;
}

export const isEmptyRecord = (r) => r.rebindings.length === 0 && r.carried.length === 0
  && r.pending.length === 0 && Object.keys(r.told).length === 0 && (r.unknown ?? []).length === 0
  && r.replaced_at === undefined;

/**
 * The record after the delivery `p` is acknowledged: its child told its words,
 * and, for a restating note, its subtask no longer `unknown`. A `contested`
 * acknowledgement (the child's archived copies disagree) marks the entry so it
 * binds no words, and leaves the subtask `unknown`. Mutates `record`.
 */
export function acknowledgeInRecord(record, p, nowIso, { contested = false } = {}) {
  record.told[p.child] = { subtask: p.subtask, ...wordsOf(p.to), delivery_id: p.delivery_id, at: nowIso, ...(contested ? { contested: true } : {}) };
  if (!contested && p.restate === true && Array.isArray(record.unknown)) {
    record.unknown = record.unknown.filter((id) => id !== p.subtask);
    if (record.unknown.length === 0) delete record.unknown;
  }
  return record;
}

// ---------------------------------------------------------------------------
// The comparison (item 6)

/**
 * Whether the macro's current approval rebinds `child` to the subtask as it
 * is now, for a write whose dispatch differs from it (`mismatches`, each
 * {field, message}). { ok: true, entry } or { ok: false, why }: the refusal
 * keeps dispatch-changed and adds `why`. With `waived` (done's waiver of the
 * told check, for an archived child), whether the child was told is left to
 * the vouch at the same write (vouchVerdict), which decides the waiver.
 */
export function rebindingVerdict({ fm, approval, subtaskId, current, expectDispatch, child, mismatches, waived = false }) {
  const fixed = mismatches.filter((m) => !REBINDABLE_FIELDS.includes(m.field));
  if (fixed.length > 0) {
    return { ok: false, why: `a change of ${fixed.map((m) => m.field).join(', ')} is not rebindable (ADR-0068 Decision 8, item 1)` };
  }
  if (!nonEmpty(child)) return { ok: false, why: 'the write names no child workflow, so no rebinding applies to it' };
  if (approval.status === 'pending') {
    return { ok: false, why: 'the plan is pending approval: a plan-set after an approval suspends its rebindings until the owner approves again' };
  }
  if (approval.status !== 'approved') return { ok: false, why: 'the plan has no approval, so nothing rebinds the child' };
  if (approval.hash_ok !== true) return { ok: false, why: 'the plan changed since its approval, which therefore rebinds nothing' };
  const parsed = parseRebindRecord(fm?.[REBIND_KEY]);
  if (parsed.status === 'unreadable') {
    return { ok: false, why: `the macro's record of rebindings (${REBIND_KEY}) is unreadable (${parsed.error}); approving the plan again rewrites it` };
  }
  if (parsed.status === 'absent') return { ok: false, why: 'the current approval rebinds no child' };
  const r = parsed.record;
  if (!stampMatches(r, fm)) {
    return { ok: false, why: 'the record of rebindings belongs to an earlier approval (stale: an approval from an older orchestrator came after it); approve the plan again' };
  }
  // A carried entry is a completed subtask's, accepted when it completed and
  // kept as recorded (item 1): nothing is left to tell its child.
  const live = r.rebindings.find((e) => e.subtask === subtaskId && e.child === child);
  const entry = live ?? r.carried.find((e) => e.subtask === subtaskId && e.child === child);
  if (!entry) return { ok: false, why: `the current approval did not rebind ${child} for ${subtaskId}` };
  if (entry.from_digest !== dispatchDigest(expectDispatch)) {
    return { ok: false, why: `the current approval rebound ${child} from another dispatch than the one this write passes` };
  }
  if (entry.to_digest !== wordsDigest(current)) {
    return { ok: false, why: `the current approval rebound ${child} to other words than the subtask's now` };
  }
  if (!live || waived) return { ok: true, entry, approval: r.approval };
  const waiting = r.pending.find((p) => p.child === child);
  if (waiting) {
    return {
      ok: false,
      why: `${child} has not been told the change yet (delivery ${waiting.delivery_id} is pending: a run completes it at the ` +
        `child's next boundary, or state.mjs rebind-deliver does now)`,
    };
  }
  if (entry.child_state !== 'archived') {
    const told = r.told[child];
    if (!told || told.subtask !== subtaskId || told.contested === true || wordsDigest(told) !== entry.to_digest) {
      return { ok: false, why: `${child} has not been told the change; approve the plan again to deliver it` };
    }
  }
  return { ok: true, entry, approval: r.approval };
}

// Whether `started` (a child's started_at) falls in a later second than `at`:
// both are written to the second, so a child started in the second of `at`
// may have been there before it.
export function startedAfter(started, at) {
  const s = Date.parse(started ?? '');
  const a = Date.parse(at ?? '');
  return Number.isFinite(s) && Number.isFinite(a) && Math.floor(s / 1000) > Math.floor(a / 1000);
}

// The way out of a refusal for `child` when it is archived: its work is
// finished, and no note reaches it (item 4). state.mjs readVouch names it for
// a copy that does not hold the note the record says told the child.
export const archivedExit = (child) => `${child} is archived, so no note reaches it: /orchestrator:done --waive-dispatch with a ` +
  'reason completes the subtask in its name, and the macro records the waiver; or revise the plan back to the words it was last told';

// The refusal for `child` while more than one file bears it, or the files
// that may bear it cannot all be read (`count` Infinity): which words its work
// answers to is not known, so no copy is judged (item 4). Its way out is the
// owner's repair, or, `archived` (no file bearing it in a workflow home), the
// told waiver; no revision of the plan helps. state.mjs readVouch refuses
// with it, and an approval shows an archived child's row refused with it.
// `paths` names the files, `error` why they cannot all be read, and
// `sameNotes` (every file holds the same notes, as an interrupted or retried
// archive leaves them) names the repair for that state: keep one, the file
// in a workflow home when there is one, and remove the others.
export function copiesRefusal(child, { count, archived, active = !archived, paths = [], sameNotes = false, error = null }) {
  const what = count === Infinity
    ? `the files that may bear it cannot all be read${error ? `: ${error}` : ''}`
    : `${count} workflow files bear its id or name${paths.length > 0 ? `: ${paths.join(', ')}` : ''}`;
  const repair = sameNotes
    ? ` (they hold the same notes, as an archive killed between its write and its removal of the workflow file, or retried after that, ` +
      `leaves them: keep ${active ? 'the one in a workflow home' : 'one archive'} and remove the others)`
    : '';
  return `more than one copy of ${child} may run (${what}), so which words its work answers to is not known; ` +
    `repair or remove the extra copies${repair}` + (archived
    ? `, or, since ${child} is archived and no note reaches it, /orchestrator:done --waive-dispatch with a reason completes ` +
      'the subtask in its name, and the macro records the waiver'
    : '');
}

/**
 * Whether the macro's record vouches for `child` being told the subtask's
 * words as they are now (item 4), at every write that binds it, whatever its
 * dispatch comparison found: the re-attach, the terminal writeback and done's
 * completion write. A record that cannot be read vouches for no one. A note to
 * the child still pending, or a `told` entry of this subtask with other words,
 * is what the child answers to: either refuses. A record that was replaced
 * (`replaced_at`), or that names the subtask `unknown`, lost what a child
 * dispatched by then was told: such a child is vouched for only by a `told`
 * entry of this subtask with these words, written since. A child started after
 * the replacement lost nothing, and its binding retires the subtask's
 * `unknown` (`retire`), which named the child before it. `startedAt()` reads
 * the child's started_at, only when it is needed; `archived` (the child is)
 * names the refusal's way out, as `fresh` does (the plan is approved as it
 * stands: a pending note of an approval the plan changed since is never
 * delivered, so only an approval of the plan as it stands tells the child).
 * { ok: true, retire } or { ok: false, why }.
 */
export function vouchVerdict({ fm, subtaskId, current, child, startedAt, archived = false, fresh = true }) {
  const parsed = parseRebindRecord(fm?.[REBIND_KEY]);
  if (parsed.status === 'absent') return { ok: true, retire: false };
  if (parsed.status === 'unreadable') {
    return {
      ok: false,
      why: `the macro's record of rebindings (${REBIND_KEY}) is unreadable (${parsed.error}), so it cannot say what ${child} was ` +
        `last told; ${archived ? archivedExit(child)
          : 'approve the plan again (/orchestrator:approve), which replaces it and restates the words to the child in full'}`,
    };
  }
  return vouchRecord({ r: parsed.record, subtaskId, current, child, startedAt, archived, fresh });
}

/**
 * vouchVerdict's told check over a record `r` already read: the one a binding
 * write reads, or the one an approval is about to write, whose view shows the
 * refusal each archived child's row will meet (deriveRebindView, item 2). One
 * predicate for both.
 */
export function vouchRecord({ r, subtaskId, current, child, startedAt, archived = false, fresh = true }) {
  const unknown = (r.unknown ?? []).includes(subtaskId);
  const replacedAt = r.replaced_at ?? null;
  const told = r.told[child];
  const toldThis = told !== undefined && told.subtask === subtaskId;
  // A contested entry (the child's copies disagree on what it was told) binds
  // no words, the ones it names included.
  const toldNow = toldThis && told.contested !== true && wordsDigest(told) === wordsDigest(current);
  const waiting = r.pending.find((p) => p.child === child);
  const deliver = !waiting ? ''
    : fresh
      ? `a run delivers it at the child's next boundary, or state.mjs rebind-deliver does now, and the write binds the child ` +
        'once it is delivered; or revise the plan back to the words it was last told'
      : 'the plan changed since the approval that made it, so it is not delivered: approve the plan as it stands ' +
        '(/orchestrator:approve), which tells the child the subtask\'s words, and the write binds it once that note is delivered';
  if (waiting && (toldNow || (replacedAt === null && !unknown))) {
    return {
      ok: false,
      why: `${child} has not been told the subtask's words yet: a note to it (delivery ${waiting.delivery_id}) is pending; ` +
        `${archived ? archivedExit(child) : deliver}`,
    };
  }
  if (toldNow) return { ok: true, retire: false };
  if (replacedAt === null && !unknown) {
    if (!toldThis) return { ok: true, retire: false };
    return {
      ok: false,
      why: `${child} was last told other words for subtask ${subtaskId} (delivery ${told.delivery_id}) than the subtask's now` +
        `${told.contested === true ? ', or its copies disagree on what it was told' : ''}; ` +
        `${archived ? archivedExit(child) : 'approve the plan as it stands (/orchestrator:approve), which tells it the ' +
          'subtask\'s words, and the write binds it once that note is delivered; or revise the plan back to the words it was last told'}`,
    };
  }
  // A note since the replacement that told the child other words, or one
  // still waiting to tell it, is what it answers to: no start excuses it.
  if (replacedAt !== null && !told && !waiting && startedAfter(startedAt(), replacedAt)) return { ok: true, retire: unknown };
  return {
    ok: false,
    why: `what ${child} was last told is not known: ${replacedAt === null ? 'the record'
      : replacedAt === LATER_THAN_ANY_START ? 'this approval' : `an approval at ${replacedAt}`} replaced an ` +
      `unreadable record of rebindings${unknown ? ` and names subtask ${subtaskId} unknown` : ''}, and no note since has told it ` +
      `the subtask's words now${told ? ` (its last note, delivery ${told.delivery_id}, told it other words)` : ''}. ${archived
        ? `${archivedExit(child)}`
        : waiting
          ? `The note that restates them (delivery ${waiting.delivery_id}) is pending: ${deliver}`
          : 'Approve the plan again (/orchestrator:approve) while the child can be read: it restates the words to the child ' +
            'in full, and the write binds it once that note is delivered'}`,
  };
}

// ---------------------------------------------------------------------------
// The approval's view (items 1, 2, 4)

// The replacement time an approval that replaces an unreadable record judges
// its archived rows by: it writes its own time, later than any child's start.
const LATER_THAN_ANY_START = '9999-12-31T23:59:59Z';

/**
 * What an approval of the plan as it stands would record, derived afresh from
 * each in-progress child's own dispatch, never from an earlier rebinding.
 *
 * `children` maps each in-progress subtask id, and each other subtask not
 * completed whose child may be owed a note (state.mjs rebindView says which),
 * to what state.mjs read of its child: { status: 'found', child, owner,
 * child_state, path, next_step, started_at,
 * dispatch } or { status: 'none' | 'ambiguous' | 'owner-missing' |
 * 'elsewhere' | 'unreadable', ... }. `previous` is parseRebindRecord of the
 * macro's record after reconciliation (pending deliveries already written
 * moved into told). `unparsed` holds the children owed a note whose own
 * workflow file exists but is no claim the scan can read. A found child
 * carries `told_missing` when an active copy of it does not hold the note its
 * `told` entry names, or, archived, when a copy of it does not hold it or
 * cannot show it, and `copies` ({ count, active }) when more than one file
 * bears it (state.mjs childCopies). `partial` holds the ids of pending deliveries some
 * readable copy of their child holds though reconciliation did not acknowledge
 * them, or whose copies could not be scanned; `nowIso` is the time a `told` entry recorded from one of them carries.
 *
 * Returns { rows, carried, rebindings, told, deliveries, untouched, unknown, digest }:
 * `rows` is what the approval shows and its digest binds; `deliveries` the
 * notes due, each { child, subtask, from, to, delivery_id } with the id of an
 * identical pending delivery kept (or null for a new one), and those of a
 * child no row decides carried as they were (`untouched: true`); `untouched`
 * names the children and deliveries so carried, which the digest binds too.
 * A row of an archived child whose binding writes the told check will refuse
 * carries `refused` (the refusal), and is shown even when it matches its
 * dispatch.
 */
export function deriveRebindView({ subtasks, children, previous, unparsed = new Set(), partial = new Set(), nowIso = null }) {
  const prev = previous?.status === 'readable' ? previous.record : null;
  // A record that cannot be read leaves what each in-progress subtask's child
  // was last told unknown: assuming its dispatch would leave a return to the
  // dispatch untold after a note of other words. Each such subtask is named
  // `unknown`, and its child, whenever an approval finds it active, is told
  // the words it answers to now, in full (`restate`), until that note is
  // acknowledged (acknowledgeInRecord). An approval that cannot tell it (the
  // child unreadable, or a change it cannot rebind) keeps the name while the
  // subtask is in progress.
  // A restating note pending names its subtask unknown too: the note exists
  // only because its child's last words are not known.
  // A subtask not in progress is never named: whether some child of it may
  // still run is not the approval's to guess. Its child is checked where it
  // is named, at the write that binds it (vouchVerdict), and restated below
  // whenever an approval finds it active.
  const unknownBefore = previous?.status === 'unreadable'
    ? subtasks.filter((s) => s?.status === 'in_progress').map((s) => s.id)
    : [...new Set([...(prev?.unknown ?? []), ...(prev?.pending ?? []).filter((p) => p.restate === true).map((p) => p.subtask)])];
  const unknownSet = new Set(unknownBefore);
  // Whether what child `info` was told may have been lost with a record an
  // approval replaced: this approval replaces one, or the child was there by
  // the last replacement.
  const replacing = previous?.status === 'unreadable';
  const lostWith = (info) => replacing || (nonEmpty(prev?.replaced_at) && !startedAfter(info.started_at, prev.replaced_at));
  // The subtasks whose child an approval found archived: nothing is left to tell.
  const retired = new Set();
  const rows = [];
  const rebindings = [];
  const deliveries = [];
  const told = {};
  // The children and subtasks a row of a found child decides: what it shows
  // replaces what the record held for them.
  const decidedChildren = new Set();
  const decidedSubtasks = new Set();
  // The in-progress subtasks whose child cannot be read for now: its claim
  // cannot be read, or it is ambiguous until the owner settles it.
  const unsettled = new Set();
  // The rows of archived, rebindable children, judged once the record this
  // approval writes is known (below), and those among them shown only if that
  // judgement refuses them.
  const archivedRows = [];
  const shownIfRefused = new Set();
  for (const s of subtasks) {
    if (!s || s.status === 'completed') continue;
    // A subtask not in progress for the moment is rebound by nothing (item 1),
    // but a child of it still active may be re-attached under its dispatch:
    // it is told each change of the words it was last told as an in-progress
    // child is (item 4), in a row of its own (`told`). One whose child the
    // approval did not find has no row: its words are kept below.
    const idle = s.status !== 'in_progress';
    if (idle && children.get(s.id)?.status !== 'found') continue;
    const info = children.get(s.id) ?? { status: 'none' };
    const now = { branch: s.branch ?? null, verb: s.verb ?? null, ...wordsOf(s) };
    const row = {
      subtask: s.id, kind: null, child: info.child ?? null, owner: info.owner ?? null,
      child_state: info.child_state ?? null, path: info.path ?? null, next_step: info.next_step ?? null,
      dispatch: info.dispatch ?? null, now, changed: [], not_rebindable: [], not_compared: [],
      delivery: null, detail: info.detail ?? null,
    };
    if (info.status !== 'found') {
      row.kind = info.status;
      if (info.status === 'unreadable' || info.status === 'ambiguous') unsettled.add(s.id);
      rows.push(row);
      continue;
    }
    decidedChildren.add(info.child);
    decidedSubtasks.add(s.id);
    const d = info.dispatch;
    if (d.branch !== s.branch) row.not_rebindable.push('branch');
    if (!('verb' in d)) row.not_compared.push('verb');
    else if (fieldText(d.verb) !== fieldText(s.verb)) row.not_rebindable.push('verb');
    for (const field of REBINDABLE_FIELDS) {
      if (!(field in d)) row.not_compared.push(field);
      else if (fieldText(d[field]) !== fieldText(s[field])) row.changed.push(field);
    }
    if (row.not_rebindable.length > 0) row.kind = 'not-rebindable';
    else if (idle) row.kind = 'told';
    else if (row.changed.length > 0) row.kind = 'rebind';
    else row.kind = 'matches';
    if (idle) row.status = s.status ?? null;
    if (row.kind === 'rebind') {
      rebindings.push({
        subtask: s.id, child: info.child, child_state: info.child_state,
        from_digest: dispatchDigest(d), to_digest: wordsDigest(s), fields: [...row.changed],
      });
    }
    // Item 4: an active child is told each change of the words it was last
    // told, a return to its dispatch included; an archived one has nothing
    // left to run. A child that recorded neither field, and was never told,
    // has no words to compare. What it was last told is kept whatever this
    // approval shows, so a revision it cannot rebind (a branch moved and
    // moved back) never erases the words its latest note gave it; a child
    // this approval cannot read keeps it too (below).
    // An archived child keeps it too: its terminal writeback, which the Stop
    // hook may send after the archive, is vouched for by it (vouchVerdict).
    const kept = prev?.told?.[info.child] ?? null;
    if (kept && kept.subtask === s.id) told[info.child] = kept;
    if (info.child_state !== 'active') retired.add(s.id);
    const restating = prev?.pending?.find((p) => p.restate === true && p.child === info.child && p.subtask === s.id) ?? null;
    // A child there by a replacement, and told nothing of this subtask since,
    // is restated as an unknown subtask's child is: the write that binds it
    // refuses it until then (vouchVerdict), whatever its subtask's status.
    // A child found active again after a contested acknowledgement is
    // restated in full too: no words it was told are known to bind. So is one
    // an active copy of which does not hold the note its `told` entry names
    // (`told_missing`, state.mjs rebindView): every binding write refuses it
    // until a note every copy holds is delivered (state.mjs readVouch). So is
    // one a pending note to which, for this subtask, some copy holds though
    // not every copy does (`partial`): which words it answers to is not known.
    const lost = lostWith(info) && !(kept && kept.subtask === s.id);
    const partialHere = (prev?.pending ?? []).some((p) => partial.has(p.delivery_id) && p.child === info.child && p.subtask === s.id);
    const contested = partialHere || (kept?.subtask === s.id && (kept.contested === true || info.told_missing === true));
    if (info.child_state === 'active' && row.kind !== 'not-rebindable' && (unknownSet.has(s.id) || lost || contested)) {
      const to = wordsOf(s);
      const same = restating && digestOf(wordsOf(restating.to)) === digestOf(to) ? restating : null;
      row.delivery = { fields: [...REBINDABLE_FIELDS], delivery_id: same?.delivery_id ?? null, restate: true };
      deliveries.push({ child: info.child, subtask: s.id, from: to, to, delivery_id: same?.delivery_id ?? null, restate: true });
    } else if (info.child_state === 'active' && row.kind !== 'not-rebindable') {
      const last = kept && kept.subtask === s.id
        ? wordsOf(kept)
        : (!idle && 'profile' in d && 'topic' in d ? wordsOf(d) : null);
      if (last !== null && digestOf(last) !== wordsDigest(s)) {
        const to = wordsOf(s);
        const same = prev?.pending?.find((p) => p.child === info.child && p.subtask === s.id
          && digestOf(wordsOf(p.from)) === digestOf(last) && digestOf(wordsOf(p.to)) === digestOf(to));
        const fields = REBINDABLE_FIELDS.filter((f) => last[f] !== to[f]);
        row.delivery = { fields, delivery_id: same?.delivery_id ?? null };
        deliveries.push({ child: info.child, subtask: s.id, from: last, to, delivery_id: same?.delivery_id ?? null });
      }
    }
    const shown = idle ? row.delivery !== null : (row.kind !== 'matches' || row.delivery !== null || row.not_compared.length > 0);
    // An archived child's row is shown whenever the told check will refuse
    // it, whatever else it says (item 2): a row that matches its dispatch
    // included, since the child may have been told other words since.
    const archivedRow = info.child_state === 'archived' && row.kind !== 'not-rebindable';
    if (archivedRow) archivedRows.push({ row, s, info });
    if (shown || archivedRow) {
      if (!shown) shownIfRefused.add(row);
      rows.push(row);
    }
  }
  // Item 4: a child no row decides keeps the words it was last told: its
  // claim cannot be read now, its owner is ambiguous or gone, or its subtask
  // is not in progress for the moment. Dropping them would leave a later
  // return to its dispatch untold. Only a subtask completed, or gone from the
  // plan, lets them go. A note still pending is kept, under its id, only
  // while its subtask is in progress and its child unsettled: dropped, it
  // would be told again under a new id once the child can be read; a subtask
  // not in progress, or whose child is gone, has no one to tell, and a note
  // kept for it would hold its next dispatch back. A child whose own file the
  // claim scan skips (`unparsed`: its frontmatter never closes) only looks
  // gone, and is unsettled too.
  const untouched = { told: [], pending: [] };
  if (prev) {
    for (const p of prev.pending) {
      if (unparsed.has(p.child) && subtasks.some((s) => s?.id === p.subtask && s.status === 'in_progress')) unsettled.add(p.subtask);
    }
    const open = new Set(subtasks.filter((s) => s && s.status !== 'completed').map((s) => s.id));
    const keeps = (child, subtask) => open.has(subtask) && !decidedSubtasks.has(subtask) && !decidedChildren.has(child);
    // What a child was last told outlives a row that decides another child of
    // its subtask (the owner switched): only the child's own row, or its
    // subtask completed or gone, lets it go. A pending note keeps the rule
    // above: the row deciding its subtask decides what is told now.
    const keepsTold = (child, subtask) => open.has(subtask) && !decidedChildren.has(child);
    for (const [child, t] of Object.entries(prev.told)) {
      if (keepsTold(child, t.subtask)) {
        told[child] = t;
        untouched.told.push(child);
      }
    }
    for (const p of prev.pending) {
      if (!unsettled.has(p.subtask) || !keeps(p.child, p.subtask)) continue;
      deliveries.push({
        child: p.child, subtask: p.subtask, from: p.from, to: p.to, delivery_id: p.delivery_id, untouched: true, ...(p.restate ? { restate: true } : {}),
      });
      untouched.pending.push(p.delivery_id);
    }
    // A note this approval drops (its subtask open, no note to its child now)
    // that some copy of the child holds (`partial`) is partial evidence, never
    // read as "never told": the child is told it, contested, so no words bind
    // it until a note an approval restates to it is delivered. A row that
    // decides the child but sends it no note (an archived child, or one whose
    // row cannot rebind) keeps it too: the copy that holds the note may be
    // restored. The digest binds it (`untouched.contested`).
    const toldNow = new Set(deliveries.map((d) => d.child));
    for (const p of prev.pending) {
      if (!partial.has(p.delivery_id) || untouched.pending.includes(p.delivery_id) || toldNow.has(p.child)) continue;
      if (!open.has(p.subtask)) continue;
      told[p.child] = { subtask: p.subtask, ...wordsOf(p.to), delivery_id: p.delivery_id, at: nowIso ?? prev.approval.at, contested: true };
      untouched.contested = [...(untouched.contested ?? []), p.delivery_id];
    }
  }
  // Item 1: a completed subtask is kept as recorded.
  const completed = new Set(subtasks.filter((s) => s?.status === 'completed').map((s) => s.id));
  const carried = prev ? [...prev.rebindings, ...prev.carried].filter((e) => completed.has(e.subtask)) : [];
  const stillOpen = new Set(subtasks.filter((s) => s && s.status !== 'completed').map((s) => s.id));
  const unknown = unknownBefore.filter((id) => stillOpen.has(id) && !retired.has(id)).sort();
  // Item 2: each archived child's row shows the refusal its binding writes
  // will meet, judged by their own told check (vouchRecord) over the record
  // this approval writes. No note reaches an archived child, so nothing this
  // approval delivers changes the verdict. A record replaced now is replaced
  // later than any child's start.
  const willWrite = {
    told, pending: [], ...(unknown.length > 0 ? { unknown } : {}),
    ...(replacing ? { replaced_at: LATER_THAN_ANY_START } : nonEmpty(prev?.replaced_at) ? { replaced_at: prev.replaced_at } : {}),
  };
  for (const { row, s, info } of archivedRows) {
    const v = vouchRecord({ r: willWrite, subtaskId: s.id, current: s, child: info.child, startedAt: () => info.started_at, archived: true });
    // More than one file bears the child (`copies`, state.mjs childCopies):
    // its writes refuse it whatever the record says (state.mjs readVouch).
    if (info.copies) row.refused = copiesRefusal(info.child, { ...info.copies, archived: !info.copies.active });
    else if (!v.ok) row.refused = v.why;
    // A copy that does not hold the note its `told` entry names, or cannot
    // show it (state.mjs rebindView), is refused by the writes' copy check
    // (state.mjs readVouch), which this record cannot see: shown refused too.
    else if (info.told_missing === true) {
      row.refused = `a copy of ${info.child} does not hold the note that told it the subtask's words, or cannot be read, so it may answer to other words; ${archivedExit(info.child)}`;
    }
  }
  for (let i = rows.length - 1; i >= 0; i--) if (shownIfRefused.has(rows[i]) && rows[i].refused === undefined) rows.splice(i, 1);
  const digest = digestOf({ record: previous?.status ?? 'absent', rows, carried, untouched, unknown });
  return { rows, carried, rebindings, told, deliveries, untouched, unknown, digest };
}

// The text of one field in a delivery note, fenced so no line of it is read
// as the note's own Markdown.
function fenced(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}

export const deliveryHeading = (deliveryId) => `Owner instruction change (${deliveryId})`;

/**
 * The phase note a delivery appends to the child (item 4): each changed field,
 * old and new, verbatim; for a `restate`, each field's words as they are now.
 */
export function deliveryNote({ macroId, subtaskId, approvedAt, from, to, restate = false }) {
  const intro = restate
    ? `The owner approved this workflow's instructions in macro ${macroId} (subtask ${subtaskId}, approval of ${approvedAt}; ` +
      "ADR-0068 Decision 8). The macro's record of what this workflow was last told could not be read, so they are restated " +
      'in full. The next step stays the one recorded; the work answers to the words below, whatever an earlier note said.'
    : `The owner approved a change of this workflow's instructions in macro ${macroId} (subtask ${subtaskId}, ` +
      `approval of ${approvedAt}; ADR-0068 Decision 8). The next step stays the one recorded; ` +
      'the work now answers to the new words below.';
  return `${intro}\n\n${deliveryBody({ from, to, restate })}`;
}

/**
 * The words a delivery's note gives, after its one-paragraph introduction:
 * what binds the note to the delivery, whichever approval wrote it. A note is
 * the child's only when its heading is followed by an introduction and this.
 */
export function deliveryBody({ from, to, restate = false }) {
  const norm = (t) => t.replace(/\r\n?/g, '\n');
  if (restate) return REBINDABLE_FIELDS.map((field) => `**${field}** is:\n\n${fenced(norm(to[field]))}`).join('\n\n');
  const parts = [];
  for (const field of REBINDABLE_FIELDS) {
    if (from[field] === to[field]) continue;
    parts.push(`**${field}** was:\n\n${fenced(norm(from[field]))}\n\nnow:\n\n${fenced(norm(to[field]))}`);
  }
  return parts.join('\n\n');
}

/**
 * Whether `text` (a child's workflow file, line ends normalized) holds the
 * note of delivery `p`: its heading, then one paragraph, then the words it
 * tells (deliveryBody). A heading alone, or one followed by other words, is
 * not the note: a retried delivery is acknowledged only for the words it tells.
 */
export function holdsDeliveryNote(text, p) {
  const heading = `\n### ${deliveryHeading(p.delivery_id)}\n\n`;
  const body = `${deliveryBody({ from: wordsOf(p.from ?? {}), to: wordsOf(p.to ?? {}), restate: p.restate === true })}\n`;
  for (let at = text.indexOf(heading); at !== -1; at = text.indexOf(heading, at + 1)) {
    const intro = at + heading.length;
    const end = text.indexOf('\n\n', intro);
    if (end > intro && !text.slice(intro, end).includes('\n### ') && text.startsWith(body, end + 2)) return true;
  }
  return false;
}
