// Tests for the ADR-0040 §1 notification event schema + dedupe contract
// lib. Pure contract surface only — no channels, no CLI, no host config:
// kind enum, kind/subject mapping, event_id composition (source excluded,
// fixed default status token), repo-ident derivation, pipeline ORDER
// contract, notify_kinds filter parsing, and the atomic TTL dedupe claim
// (O_EXCL first-claim + race-safe stale-claim reclaim).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  NOTIFY_KINDS,
  URGENCY_LEVELS,
  PIPELINE_ORDER,
  DEFAULT_STATUS_TOKEN,
  KINDS_WITH_DEFAULT_STATUS,
  deriveRepoIdent,
  buildEventId,
  approvalSubject,
  idleSubject,
  turnCompleteSubject,
  responseNeededSubject,
  workflowTerminalSubject,
  subagentCompleteSubject,
  peerRunTerminalSubject,
  validateEvent,
  parseKindsFilter,
  kindEnabled,
  notifyStateDir,
  notifyDedupeDir,
  claimDedupe,
  promoteClaim,
  releaseClaim,
  OPTIONAL_ROUTING_FIELDS,
  ROUTING_FIELD_CAPS,
  DEFAULT_LOCK_STALE_MS,
  GC_SAFETY_MARGIN_MS,
  SWEEP_MAX_ENTRIES,
  SWEEP_MAX_DELETIONS,
  SWEEP_MAX_ELAPSED_MS,
  isClaimExpired,
  isClaimGcEligible,
  isLockStale,
  sweepExpiredClaims,
} from '../../plugins/runtime/scripts/lib/notify-schema.mjs';

const execFileAsync = promisify(execFile);
const LIB_URL = pathToFileURL(
  path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../plugins/runtime/scripts/lib/notify-schema.mjs',
  ),
).href;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function validSampleEvent(overrides = {}) {
  const repoIdent = 'repo-00000000';
  const kind = overrides.kind ?? 'peer-run-terminal';
  // Build the id from a known-good kind so an intentionally invalid
  // overrides.kind reaches validateEvent instead of throwing here.
  const idKind = NOTIFY_KINDS.includes(kind) ? kind : 'peer-run-terminal';
  const subject = overrides.__subject ?? 'ensemble-20260703T000000Z-abc123';
  const status = overrides.__status ?? 'completed';
  const event = {
    event_id: buildEventId({ repoIdent, kind: idKind, subject, status }),
    source: 'peer-runner-engineer',
    kind,
    title: 'Peer run completed',
    body: 'run finished',
    urgency: 'normal',
    refs: { run_id: subject },
    ...overrides,
  };
  delete event.__subject;
  delete event.__status;
  return event;
}

describe('notify-schema kind enum and pipeline order contract', () => {
  it('pins the ADR-0040 §1 kind enum exactly (+ ADR-0047 §1 response-needed)', () => {
    assert.deepEqual(
      [...NOTIFY_KINDS],
      [
        'approval',
        'idle',
        'turn-complete',
        'subagent-complete',
        'workflow-terminal',
        'peer-run-terminal',
        'health',
        'response-needed',
      ],
    );
    assert.ok(Object.isFrozen(NOTIFY_KINDS));
  });

  it('pins the urgency levels', () => {
    assert.deepEqual([...URGENCY_LEVELS], ['urgent', 'normal']);
  });

  it('pins the pipeline ORDER contract with kinds-filter BEFORE dedupe', () => {
    assert.deepEqual(
      [...PIPELINE_ORDER],
      ['validate', 'kinds-filter', 'dedupe', 'quiet-hours', 'redact', 'dispatch'],
    );
    assert.ok(Object.isFrozen(PIPELINE_ORDER));
    // The load-bearing ordering guarantees, asserted independently so a
    // reorder cannot slip through a wholesale list edit: a disabled kind
    // must never consume a TTL dedupe slot, and dedupe must precede the
    // quiet-hours gate.
    assert.ok(
      PIPELINE_ORDER.indexOf('kinds-filter') < PIPELINE_ORDER.indexOf('dedupe'),
    );
    assert.ok(
      PIPELINE_ORDER.indexOf('dedupe') < PIPELINE_ORDER.indexOf('quiet-hours'),
    );
  });
});

describe('notify-schema repo-ident derivation', () => {
  it('is deterministic for the same path', () => {
    const dir = tmpDir('notify-ident-');
    assert.equal(deriveRepoIdent(dir), deriveRepoIdent(dir));
  });

  it('normalizes trailing-slash path spellings to the same ident', () => {
    const dir = tmpDir('notify-ident-');
    assert.equal(deriveRepoIdent(dir), deriveRepoIdent(dir + path.sep));
  });

  it('differs across different repos', () => {
    const a = tmpDir('notify-ident-a-');
    const b = tmpDir('notify-ident-b-');
    assert.notEqual(deriveRepoIdent(a), deriveRepoIdent(b));
  });

  it('never contains a colon (event_id segment safety)', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir('notify-ident-'), 'we:ird'));
    assert.ok(!deriveRepoIdent(dir).includes(':'));
  });

  it('resolves symlinked spellings of the same repo to one ident', () => {
    const real = tmpDir('notify-ident-real-');
    const linkParent = tmpDir('notify-ident-link-');
    const link = path.join(linkParent, 'alias');
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch {
      return; // symlink-restricted environment — skip silently
    }
    assert.equal(deriveRepoIdent(real), deriveRepoIdent(link));
  });
});

describe('notify-schema event_id composition', () => {
  it('composes <repo-ident>:<kind>:<subject>:<status>', () => {
    const id = buildEventId({
      repoIdent: 'repo-abcd1234',
      kind: 'peer-run-terminal',
      subject: 'run-42',
      status: 'failed',
    });
    assert.equal(id, 'repo-abcd1234:peer-run-terminal:run-42:failed');
  });

  it('excludes source: no source input exists, so two producers converge', () => {
    const args = {
      repoIdent: 'repo-abcd1234',
      kind: 'peer-run-terminal',
      subject: 'run-42',
      status: 'completed',
    };
    // Same subject moment observed by runPeer and by a later sweep pass
    // must produce byte-identical keys.
    assert.equal(buildEventId(args), buildEventId(args));
  });

  it('applies the FIXED default status token when status is absent', () => {
    const id = buildEventId({
      repoIdent: 'repo-abcd1234',
      kind: 'approval',
      subject: 'session:s1:deadbeefdead',
    });
    assert.equal(
      id,
      `repo-abcd1234:approval:session:s1:deadbeefdead:${DEFAULT_STATUS_TOKEN}`,
    );
    // Stability: same inputs, same key, every time.
    assert.equal(
      id,
      buildEventId({
        repoIdent: 'repo-abcd1234',
        kind: 'approval',
        subject: 'session:s1:deadbeefdead',
      }),
    );
  });

  it('keeps default-status keys distinct across kinds (no collisions)', () => {
    const mk = (kind) =>
      buildEventId({ repoIdent: 'repo-abcd1234', kind, subject: 'session:s1' });
    const ids = new Set(['approval', 'idle', 'turn-complete', 'response-needed'].map(mk));
    assert.equal(ids.size, 4);
  });

  it('pins the default-status kinds to the ADR-0040 §1 three + ADR-0047 §1 response-needed', () => {
    assert.deepEqual(
      [...KINDS_WITH_DEFAULT_STATUS],
      ['approval', 'idle', 'turn-complete', 'response-needed'],
    );
  });

  it('response-needed is a first-class kind: default fired status, normal urgency, distinct dedupe identity (ADR-0047 §1)', () => {
    assert.ok(NOTIFY_KINDS.includes('response-needed'), 'enum membership');
    // Marks a moment with no natural terminal status — the fixed token applies.
    assert.equal(
      buildEventId({ repoIdent: 'repo-a', kind: 'response-needed', subject: 'session:s1:p1' }),
      'repo-a:response-needed:session:s1:p1:fired',
    );
    // Same-subject events of the two kinds keep distinct dedupe keys — the
    // narrowed turn-complete (interim) and response-needed (final) can never
    // collapse into one TTL slot.
    assert.notEqual(
      buildEventId({ repoIdent: 'repo-a', kind: 'turn-complete', subject: 'session:s1:p1' }),
      buildEventId({ repoIdent: 'repo-a', kind: 'response-needed', subject: 'session:s1:p1' }),
    );
    // Normal urgency by contract — approval stays the only urgent-by-contract kind.
    const id = buildEventId({ repoIdent: 'repo-a', kind: 'response-needed', subject: 'session:s1:p1' });
    const res = validateEvent({
      event_id: id,
      source: 'attention-stop',
      kind: 'response-needed',
      title: 'Agent is waiting on you',
      urgency: 'normal',
    });
    assert.equal(res.ok, true, res.errors?.join('; '));
  });

  it('parseKindsFilter accepts response-needed and the §8 dual-kind window', () => {
    const res = parseKindsFilter('turn-complete,response-needed');
    assert.equal(res.ok, true);
    assert.deepEqual([...res.kinds].sort(), ['response-needed', 'turn-complete']);
    assert.equal(kindEnabled('response-needed', res.kinds), true);
    assert.equal(kindEnabled('turn-complete', res.kinds), true);
    assert.equal(kindEnabled('approval', res.kinds), false);
  });

  it('requires status for status-bearing kinds (no silent collapse to the default token)', () => {
    for (const kind of NOTIFY_KINDS.filter((k) => !KINDS_WITH_DEFAULT_STATUS.includes(k))) {
      assert.throws(
        () => buildEventId({ repoIdent: 'repo-a', kind, subject: 'run-42' }),
        /status is required/,
        `${kind} without status should throw`,
      );
    }
    // With an explicit status, distinct moments stay distinct keys.
    const completed = buildEventId({
      repoIdent: 'repo-a',
      kind: 'peer-run-terminal',
      subject: 'run-42',
      status: 'completed',
    });
    const failed = buildEventId({
      repoIdent: 'repo-a',
      kind: 'peer-run-terminal',
      subject: 'run-42',
      status: 'failed',
    });
    assert.notEqual(completed, failed);
  });

  it('rejects an unknown kind', () => {
    assert.throws(
      () =>
        buildEventId({ repoIdent: 'r-1', kind: 'nope', subject: 's', status: 'x' }),
      /kind/,
    );
  });

  it('rejects colons in repoIdent and status (segment integrity)', () => {
    assert.throws(
      () =>
        buildEventId({ repoIdent: 'a:b', kind: 'idle', subject: 's', status: 'x' }),
      /colon/i,
    );
    assert.throws(
      () =>
        buildEventId({ repoIdent: 'a-b', kind: 'idle', subject: 's', status: 'x:y' }),
      /colon/i,
    );
  });

  it('rejects empty subject', () => {
    assert.throws(
      () => buildEventId({ repoIdent: 'a-b', kind: 'idle', subject: '' }),
      /subject/,
    );
  });

  it('ADR-0041 §4 — omitting hostname yields the byte-identical pre-hostname id', () => {
    const base = { repoIdent: 'repo-a', kind: 'turn-complete', subject: 'session:s1:p1' };
    assert.equal(buildEventId(base), 'repo-a:turn-complete:session:s1:p1:fired');
    // undefined / null / '' hostname are all the no-hostname case — every
    // non-hostname producer (Codex shuttle, per-persona self-sensors) is
    // completely unaffected by the extension.
    for (const hostname of [undefined, null, '']) {
      assert.equal(buildEventId({ ...base, hostname }), buildEventId(base));
    }
  });

  it('ADR-0041 §4 — a hostname weaves a colon-free host token (per-machine distinct, stable)', () => {
    const base = { repoIdent: 'repo-a', kind: 'turn-complete', subject: 'session:s1:p1' };
    const a = buildEventId({ ...base, hostname: 'mba.local' });
    const b = buildEventId({ ...base, hostname: 'server2' });
    assert.notEqual(a, b, 'two machines must build distinct ids for one moment');
    assert.equal(a, buildEventId({ ...base, hostname: 'mba.local' }), 'one machine must be stable');
    assert.notEqual(a, buildEventId(base), 'host id must differ from the no-host id');
    // The woven id still validates — the host token rides in the subject region
    // so the §1 segment cross-check accepts it unchanged.
    assert.equal(
      validateEvent({ event_id: a, source: 'x', kind: 'turn-complete', title: 't', urgency: 'normal' }).ok,
      true,
    );
  });

  it('ADR-0041 §4 — the woven host token is a bounded colon-free hash (id cannot overflow the emitter cap)', () => {
    // A colon/space-bearing hostname AND a 500-char hostname both yield the same
    // fixed-shape token, so hostname can never push the event_id past the
    // emitter's 256-char cap (Codex peer MAJOR: an unbounded token could).
    for (const hostname of ['a:b c/d', 'x'.repeat(500)]) {
      const id = buildEventId({ repoIdent: 'repo-a', kind: 'idle', subject: 'session:s1', hostname });
      const token = id.split(':')[2];
      assert.match(token, /^host-[0-9a-f]{16}$/, `token "${token}" is not a bounded 16-hex hash`);
      assert.equal(id.split(':')[1], 'idle', 'kind segment must stay at index 1');
      assert.ok(id.length < 128, `id length ${id.length} unexpectedly large`);
      assert.equal(
        validateEvent({ event_id: id, source: 'x', kind: 'idle', title: 't', urgency: 'normal' }).ok,
        true,
      );
    }
  });
});

describe('notify-schema kind/subject mapping contract', () => {
  it('approval subject embeds a content hash of the message', () => {
    const a = approvalSubject({ sessionId: 's1', message: 'Allow Bash?' });
    const b = approvalSubject({ sessionId: 's1', message: 'Allow Bash?' });
    assert.equal(a, b);
    assert.match(a, /^session:s1:[0-9a-f]{12}$/);
  });

  it('two DIFFERENT approval prompts in one session must NOT share a subject', () => {
    const a = approvalSubject({ sessionId: 's1', message: 'Allow Bash?' });
    const b = approvalSubject({ sessionId: 's1', message: 'Allow WebFetch?' });
    assert.notEqual(a, b);
  });

  it('idle subject is session-only (one nudge per session per TTL)', () => {
    assert.equal(idleSubject({ sessionId: 's1' }), 'session:s1');
  });

  it('turn-complete subject uses session + prompt (documented common fields)', () => {
    assert.equal(
      turnCompleteSubject({ sessionId: 's1', promptId: 'p9' }),
      'session:s1:p9',
    );
  });

  it('response-needed subject mirrors turn-complete: the same two documented common fields (ADR-0047 §1)', () => {
    assert.equal(
      responseNeededSubject({ sessionId: 's1', promptId: 'p9' }),
      'session:s1:p9',
    );
    // Identical subjects across the two kinds are contractual — the kind
    // segment alone keeps their event identities distinct.
    assert.equal(
      responseNeededSubject({ sessionId: 's1', promptId: 'p9' }),
      turnCompleteSubject({ sessionId: 's1', promptId: 'p9' }),
    );
  });

  it('workflow-terminal subject is the workflow id', () => {
    assert.equal(
      workflowTerminalSubject({ workflowId: 'compose-20260703T000000Z-aaaaaa' }),
      'compose-20260703T000000Z-aaaaaa',
    );
  });

  it('subagent-complete subject is the agent id', () => {
    assert.equal(subagentCompleteSubject({ agentId: 'ag-7' }), 'ag-7');
  });

  it('peer-run-terminal subject is the run id', () => {
    assert.equal(
      peerRunTerminalSubject({ runId: 'plan-verify-20260703T000000Z-cafe00' }),
      'plan-verify-20260703T000000Z-cafe00',
    );
  });

  it('subject builders reject missing identifying fields', () => {
    assert.throws(() => approvalSubject({ sessionId: '', message: 'm' }));
    assert.throws(() => approvalSubject({ sessionId: 's1', message: null }));
    assert.throws(() => idleSubject({}));
    assert.throws(() => turnCompleteSubject({ sessionId: 's1', promptId: '' }));
    assert.throws(() => workflowTerminalSubject({}));
    assert.throws(() => subagentCompleteSubject({}));
    assert.throws(() => peerRunTerminalSubject({}));
  });
});

describe('notify-schema validateEvent', () => {
  it('accepts a fully-formed event', () => {
    const res = validateEvent(validSampleEvent());
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
  });

  it('accepts an event without optional body and refs', () => {
    const event = validSampleEvent();
    delete event.body;
    delete event.refs;
    assert.equal(validateEvent(event).ok, true);
  });

  it('rejects a non-object', () => {
    assert.equal(validateEvent(null).ok, false);
    assert.equal(validateEvent('x').ok, false);
  });

  it('rejects unknown kind', () => {
    const res = validateEvent(validSampleEvent({ kind: 'mystery' }));
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /kind/.test(e)));
  });

  it('rejects missing/empty event_id, source, title', () => {
    for (const field of ['event_id', 'source', 'title']) {
      const res = validateEvent(validSampleEvent({ [field]: '' }));
      assert.equal(res.ok, false, `${field} should be required`);
    }
  });

  it('rejects invalid urgency', () => {
    assert.equal(validateEvent(validSampleEvent({ urgency: 'loud' })).ok, false);
  });

  it('rejects a kind that disagrees with the event_id kind segment', () => {
    const event = validSampleEvent();
    // Keep a syntactically valid id, but from a different kind.
    event.event_id = buildEventId({
      repoIdent: 'repo-00000000',
      kind: 'idle',
      subject: 'session:s1',
    });
    const res = validateEvent(event);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /event_id/.test(e)));
  });

  it('rejects a malformed event_id (fewer than 4 segments)', () => {
    const res = validateEvent(validSampleEvent({ event_id: 'a:b:c' }));
    assert.equal(res.ok, false);
  });

  it('rejects event_ids with empty repo-ident, subject, or status segments', () => {
    const cases = [
      ':peer-run-terminal:run-42:completed', // empty repo-ident
      'repo-a:peer-run-terminal::completed', // empty subject
      'repo-a:peer-run-terminal:run-42:', // empty status
    ];
    for (const eventId of cases) {
      const res = validateEvent(validSampleEvent({ event_id: eventId }));
      assert.equal(res.ok, false, `${JSON.stringify(eventId)} should be rejected`);
    }
  });

  it('rejects non-object refs and non-string ref values', () => {
    assert.equal(validateEvent(validSampleEvent({ refs: [] })).ok, false);
    assert.equal(validateEvent(validSampleEvent({ refs: { run_id: 7 } })).ok, false);
  });

  it('ADR-0041 §4 — accepts an event WITHOUT the optional routing fields (older-producer backward-compat)', () => {
    const event = validSampleEvent();
    for (const f of OPTIONAL_ROUTING_FIELDS) {
      assert.ok(!(f in event), `${f} should be absent by default`);
    }
    assert.equal(validateEvent(event).ok, true);
  });

  it('ADR-0041 §4 — accepts an event WITH valid optional routing fields', () => {
    const event = validSampleEvent({ hostname: 'mba.local', topic: 'repo:main', session_hint: 'abc123def456' });
    const res = validateEvent(event);
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
  });

  it('ADR-0041 §4 — rejects a non-string routing field', () => {
    for (const field of OPTIONAL_ROUTING_FIELDS) {
      const res = validateEvent(validSampleEvent({ [field]: 123 }));
      assert.equal(res.ok, false, `${field} number should be rejected`);
      assert.ok(res.errors.some((e) => e.includes(field)), `error should name ${field}`);
    }
  });

  it('ADR-0041 §4 — does NOT enforce caps at validate time (shape only, like title/body)', () => {
    // Caps are applied at build + at the egress boundary (buildEgressPayload),
    // never at validate — a long value passes shape validation.
    const event = validSampleEvent({ hostname: 'x'.repeat(ROUTING_FIELD_CAPS.hostname + 50) });
    assert.equal(validateEvent(event).ok, true);
  });

  it('ADR-0041 §4 — pins the routing field list + caps', () => {
    assert.deepEqual([...OPTIONAL_ROUTING_FIELDS], ['hostname', 'topic', 'session_hint']);
    assert.deepEqual({ ...ROUTING_FIELD_CAPS }, { hostname: 64, topic: 120, session_hint: 32 });
  });
});

describe('notify-schema notify_kinds filter', () => {
  it('unset/empty filter means all kinds enabled', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const res = parseKindsFilter(raw);
      assert.equal(res.ok, true);
      assert.equal(res.kinds, null);
    }
    assert.equal(kindEnabled('approval', null), true);
  });

  it('parses a CSV into a kind set', () => {
    const res = parseKindsFilter('approval, peer-run-terminal');
    assert.equal(res.ok, true);
    assert.deepEqual([...res.kinds].sort(), ['approval', 'peer-run-terminal']);
    assert.equal(kindEnabled('approval', res.kinds), true);
    assert.equal(kindEnabled('idle', res.kinds), false);
  });

  it('rejects unknown kinds with a diagnostic', () => {
    const res = parseKindsFilter('approval,bogus');
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /bogus/.test(e)));
  });

  it('tolerates duplicates and stray commas between valid kinds', () => {
    const res = parseKindsFilter('idle,,idle,');
    assert.equal(res.ok, true);
    assert.deepEqual([...res.kinds], ['idle']);
  });
});

describe('notify-schema state paths', () => {
  it('anchors notify state under .agentic-plugins/state/runtime/notify', () => {
    const root = '/tmp/some-repo';
    assert.equal(
      notifyStateDir(root),
      path.join(root, '.agentic-plugins', 'state', 'runtime', 'notify'),
    );
    assert.equal(notifyDedupeDir(root), path.join(notifyStateDir(root), 'dedupe'));
  });
});

describe('notify-schema dedupe claim', () => {
  const EVENT_ID = 'repo-abcd1234:peer-run-terminal:run-42:completed';

  it('first claim wins and records the event id', () => {
    const dir = tmpDir('notify-dedupe-');
    const res = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300 });
    assert.equal(res.claimed, true);
    assert.equal(res.reclaimed, false);
    const body = JSON.parse(fs.readFileSync(res.claimPath, 'utf8'));
    assert.equal(body.event_id, EVENT_ID);
  });

  it('second claim within the TTL window is a duplicate', () => {
    const dir = tmpDir('notify-dedupe-');
    assert.equal(
      claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300 }).claimed,
      true,
    );
    const res = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300 });
    assert.equal(res.claimed, false);
    assert.equal(res.reason, 'duplicate');
  });

  it('distinct event ids never contend', () => {
    const dir = tmpDir('notify-dedupe-');
    const other = 'repo-abcd1234:peer-run-terminal:run-43:completed';
    assert.equal(
      claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300 }).claimed,
      true,
    );
    assert.equal(
      claimDedupe({ dedupeDir: dir, eventId: other, ttlSeconds: 300 }).claimed,
      true,
    );
  });

  it('reclaims after TTL expiry (injected clock)', () => {
    const dir = tmpDir('notify-dedupe-');
    const t0 = Date.now();
    assert.equal(
      claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 })
        .claimed,
      true,
    );
    const res = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0 + 301_000,
    });
    assert.equal(res.claimed, true);
    assert.equal(res.reclaimed, true);
  });

  it('within-TTL rejection is based on claim mtime, not file content', () => {
    const dir = tmpDir('notify-dedupe-');
    const t0 = Date.now();
    const first = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0,
    });
    // Age the claim file on disk, then observe with a matching late clock.
    const past = new Date(t0 - 400_000);
    fs.utimesSync(first.claimPath, past, past);
    const res = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 });
    assert.equal(res.claimed, true);
    assert.equal(res.reclaimed, true);
  });

  it('tolerates the unlink race: EEXIST followed by stat ENOENT converges via single retry', () => {
    const dir = tmpDir('notify-dedupe-');
    // Exercise the REAL race path: the first exclusive create observes
    // EEXIST, then the holder's file has vanished by the time we stat.
    // A one-shot fake EEXIST on a nonexistent claim file reproduces
    // exactly that interleaving (openSync fails, statSync -> ENOENT),
    // and the single-retry attempt must then claim through the normal
    // O_EXCL path.
    const realOpenSync = fs.openSync;
    let injected = false;
    fs.openSync = (...args) => {
      if (!injected && String(args[0]).endsWith('.claim') && args[1] === 'wx') {
        injected = true;
        const error = new Error('EEXIST: injected');
        error.code = 'EEXIST';
        throw error;
      }
      return realOpenSync(...args);
    };
    try {
      const res = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300 });
      assert.equal(injected, true, 'the fake EEXIST must have been consumed');
      assert.equal(res.claimed, true);
      assert.equal(res.reclaimed, false);
    } finally {
      fs.openSync = realOpenSync;
    }
  });

  it('a stale reclaim lock is swept with concession, then the next call reclaims', () => {
    const dir = tmpDir('notify-dedupe-');
    const t0 = Date.now();
    const first = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0,
    });
    // Leave a crashed process's lock behind, aged past the stale bound.
    const lockDir = `${first.claimPath}.reclaim.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'dead-process-nonce');
    const past = new Date(t0 - 400_000);
    fs.utimesSync(lockDir, past, past);
    fs.utimesSync(first.claimPath, past, past);
    // Sweep call: cleans the stale lock but CONCEDES this event —
    // sweep-and-fire in one call is the double-fire hole (a live
    // reclaimer paused past lockStaleMs would lose mutual exclusion).
    const swept = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0,
      lockStaleMs: 60_000,
    });
    assert.equal(swept.claimed, false);
    assert.equal(swept.reason, 'swept-stale-lock');
    assert.equal(fs.existsSync(lockDir), false, 'stale lock must be gone');
    // Next call finds no lock and reclaims normally — no permanent wedge.
    const res = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0,
      lockStaleMs: 60_000,
    });
    assert.equal(res.claimed, true);
    assert.equal(res.reclaimed, true);
  });

  it('a live reclaim lock makes the observer concede without sweeping', () => {
    const dir = tmpDir('notify-dedupe-');
    const t0 = Date.now();
    const first = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0,
    });
    const lockDir = `${first.claimPath}.reclaim.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'live-peer-nonce');
    const past = new Date(t0 - 400_000);
    fs.utimesSync(first.claimPath, past, past); // claim expired, lock fresh
    const res = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0,
      lockStaleMs: 60_000,
    });
    assert.equal(res.claimed, false);
    assert.equal(res.reason, 'lost-reclaim-race');
    assert.equal(fs.existsSync(lockDir), true, 'live lock must be preserved');
  });

  it('rejects invalid ttlSeconds and empty eventId', () => {
    const dir = tmpDir('notify-dedupe-');
    assert.throws(() => claimDedupe({ dedupeDir: dir, eventId: '', ttlSeconds: 300 }));
    assert.throws(() => claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 0 }));
    assert.throws(() => claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: -5 }));
    assert.throws(() => claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: NaN }));
  });

  // The two contract-critical concurrency proofs run real child
  // processes — in-process interleaving cannot exercise O_EXCL/mkdir
  // atomicity across process boundaries.
  const RACERS = 8;
  const racerScript = `
    import { claimDedupe } from ${JSON.stringify(LIB_URL)};
    const [dir, eventId, ttl, now] = process.argv.slice(1);
    const res = claimDedupe({
      dedupeDir: dir,
      eventId,
      ttlSeconds: Number(ttl),
      now: Number(now),
    });
    process.stdout.write(JSON.stringify(res));
  `;

  async function race(dir, now) {
    const runs = await Promise.all(
      Array.from({ length: RACERS }, () =>
        execFileAsync(
          process.execPath,
          ['--input-type=module', '-e', racerScript, '--', dir, EVENT_ID, '300', String(now)],
        ),
      ),
    );
    return runs.map(({ stdout }) => JSON.parse(stdout));
  }

  it('concurrent first-claim race: exactly one process claims', async () => {
    const dir = tmpDir('notify-dedupe-race-');
    const results = await race(dir, Date.now());
    const winners = results.filter((r) => r.claimed);
    assert.equal(
      winners.length,
      1,
      `expected exactly 1 winner, got ${winners.length}: ${JSON.stringify(results)}`,
    );
  });

  it('concurrent stale-claim reclaim race: expired claim fires exactly once', async () => {
    const dir = tmpDir('notify-dedupe-race-');
    const t0 = Date.now();
    const first = claimDedupe({
      dedupeDir: dir,
      eventId: EVENT_ID,
      ttlSeconds: 300,
      now: t0 - 400_000,
    });
    assert.equal(first.claimed, true);
    const past = new Date(t0 - 400_000);
    fs.utimesSync(first.claimPath, past, past);
    const results = await race(dir, t0);
    const winners = results.filter((r) => r.claimed);
    assert.equal(
      winners.length,
      1,
      `expected exactly 1 reclaim winner, got ${winners.length}: ${JSON.stringify(results)}`,
    );
  });
});

// ADR-0041 §7 — claim finalization (owner token + promote/release). ADR-0040's
// claim stands for the full TTL regardless of outcome; E1 splits it so a failed
// egress can free the slot without burning the success TTL.
describe('notify-schema claim finalization (ADR-0041 §7)', () => {
  const EVENT_ID = 'repo-00000000:approval:session:s1:aaaa:fired';

  it('claimDedupe returns an owner token and records it in the claim file', () => {
    const dir = tmpDir('notify-finalize-');
    const res = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 1_000 });
    assert.equal(res.claimed, true);
    assert.ok(typeof res.ownerToken === 'string' && res.ownerToken.length > 0);
    const body = JSON.parse(fs.readFileSync(res.claimPath, 'utf8'));
    assert.equal(body.owner_token, res.ownerToken);
    assert.equal(body.finalized, false);
    assert.equal(body.event_id, EVENT_ID); // legacy field intact
  });

  it('honors an injected owner token (deterministic finalization)', () => {
    const dir = tmpDir('notify-finalize-');
    const res = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 1_000, ownerToken: 'fixed-token' });
    assert.equal(res.ownerToken, 'fixed-token');
    assert.equal(JSON.parse(fs.readFileSync(res.claimPath, 'utf8')).owner_token, 'fixed-token');
  });

  it('promoteClaim marks the owned claim finalized and re-pins its TTL to success time', () => {
    const dir = tmpDir('notify-finalize-');
    const t0 = 1_000_000;
    const claim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 });
    const promoteAt = t0 + 100_000;
    const prom = promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken, now: promoteAt });
    assert.equal(prom.promoted, true);
    assert.equal(JSON.parse(fs.readFileSync(claim.claimPath, 'utf8')).finalized, 'promoted');
    // TTL is now measured from promoteAt: a claim at t0+300s+1 (expired from the
    // ORIGINAL claim time) is still a live duplicate because promote re-pinned.
    const dupe = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 + 300_001 });
    assert.equal(dupe.claimed, false);
    assert.equal(dupe.reason, 'duplicate');
    // ...but past promoteAt + TTL it reclaims.
    const reclaim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: promoteAt + 300_001 });
    assert.equal(reclaim.claimed, true);
    assert.equal(reclaim.reclaimed, true);
  });

  it('releaseClaim removes the owned claim so the next identical event re-fires', () => {
    const dir = tmpDir('notify-finalize-');
    const claim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 1_000 });
    const rel = releaseClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken });
    assert.equal(rel.released, true);
    assert.ok(!fs.existsSync(claim.claimPath));
    // slot free: a re-fire well within the original TTL now claims fresh
    const again = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 2_000 });
    assert.equal(again.claimed, true);
  });

  it('promote/release act ONLY on the owned claim (a successor reclaim is untouched)', () => {
    const dir = tmpDir('notify-finalize-');
    const claim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 1_000 });
    // a non-owner cannot release or promote
    const relOther = releaseClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: 'someone-else' });
    assert.equal(relOther.released, false);
    assert.equal(relOther.reason, 'not-owner');
    assert.ok(fs.existsSync(claim.claimPath), 'non-owner release leaves the claim intact');
    const promOther = promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: 'someone-else', now: 2_000 });
    assert.equal(promOther.promoted, false);
    assert.equal(promOther.reason, 'not-owner');
  });

  it('promote/release on an absent claim are a no-op with reason no-claim', () => {
    const dir = tmpDir('notify-finalize-');
    assert.equal(promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: 't', now: 1 }).reason, 'no-claim');
    assert.equal(releaseClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: 't' }).reason, 'no-claim');
  });

  it('a within-TTL duplicate returns no owner token (nothing to finalize)', () => {
    const dir = tmpDir('notify-finalize-');
    claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 1_000 });
    const dupe = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: 1_500 });
    assert.equal(dupe.claimed, false);
    assert.equal(dupe.ownerToken ?? null, null);
  });

  it('promote/release validate their required args', () => {
    const dir = tmpDir('notify-finalize-');
    assert.throws(() => promoteClaim({ dedupeDir: dir, eventId: EVENT_ID }), /ownerToken/);
    assert.throws(() => releaseClaim({ dedupeDir: dir, eventId: '', ownerToken: 't' }), /eventId/);
  });
});

// ADR-0047 §6 — shared expiry predicates: the single boundary authority the
// claim machinery, the sweep, and the dashboard all consume.
describe('notify-schema shared expiry predicates (ADR-0047 §6)', () => {
  it('pins the implementation constants the ADR requires tests to pin', () => {
    assert.equal(DEFAULT_LOCK_STALE_MS, 60_000);
    assert.equal(GC_SAFETY_MARGIN_MS, 60_000);
    assert.equal(SWEEP_MAX_ENTRIES, 64);
    assert.equal(SWEEP_MAX_DELETIONS, 8);
    assert.equal(SWEEP_MAX_ELAPSED_MS, 100);
  });

  it('isClaimExpired uses the claimDedupe boundary: age == ttl is expired, age == ttl-1 is fresh', () => {
    assert.equal(isClaimExpired({ nowMs: 10_000, mtimeMs: 0, ttlMs: 10_000 }), true);
    assert.equal(isClaimExpired({ nowMs: 9_999, mtimeMs: 0, ttlMs: 10_000 }), false);
  });

  it('isClaimGcEligible demands TTL plus the safety margin — advisory expiry alone never deletes', () => {
    const ttlMs = 10_000;
    const atTtl = { nowMs: ttlMs, mtimeMs: 0, ttlMs };
    assert.equal(isClaimExpired(atTtl), true, 'control: advisory-expired at exactly ttl');
    assert.equal(isClaimGcEligible(atTtl), false, 'but never gc-eligible without the margin');
    assert.equal(isClaimGcEligible({ nowMs: ttlMs + GC_SAFETY_MARGIN_MS - 1, mtimeMs: 0, ttlMs }), false);
    assert.equal(isClaimGcEligible({ nowMs: ttlMs + GC_SAFETY_MARGIN_MS, mtimeMs: 0, ttlMs }), true);
  });

  it('isLockStale boundary: age == lockStaleMs is stale', () => {
    assert.equal(isLockStale({ nowMs: 60_000, mtimeMs: 0, lockStaleMs: 60_000 }), true);
    assert.equal(isLockStale({ nowMs: 59_999, mtimeMs: 0, lockStaleMs: 60_000 }), false);
  });

  it('claimDedupe agrees with the predicate at the exact boundary (age == ttl reclaims)', () => {
    const dir = tmpDir('notify-predicate-');
    const eventId = 'repo-abcd1234:idle:session:s9:fired';
    const t0 = 1_000_000;
    const first = claimDedupe({ dedupeDir: dir, eventId, ttlSeconds: 300, now: t0 });
    assert.equal(first.claimed, true);
    const stamp = new Date(t0);
    fs.utimesSync(first.claimPath, stamp, stamp);
    const atBoundary = claimDedupe({ dedupeDir: dir, eventId, ttlSeconds: 300, now: t0 + 300_000 });
    assert.equal(atBoundary.claimed, true, 'age == ttl must reclaim (>= boundary)');
    assert.equal(atBoundary.reclaimed, true);
  });
});

// ADR-0047 §6 repair — withReclaimLock's mkdir must be NON-recursive so
// EEXIST is reachable and finalization truly excludes against a concurrent
// reclaim/finalizer. Exercised through promoteClaim/releaseClaim (the lock
// helper is module-private).
describe('notify-schema withReclaimLock exclusive locking (ADR-0047 §6 repair)', () => {
  const EVENT_ID = 'repo-00000000:approval:session:s1:aaaa:fired';

  it('a live foreign reclaim lock makes promoteClaim concede — and leaves the lock intact', () => {
    const dir = tmpDir('notify-lockfix-');
    const t0 = 1_000_000;
    const claim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 });
    // Control first: with no contention, promote succeeds.
    const control = promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken, now: t0 + 1_000 });
    assert.equal(control.promoted, true, 'control: uncontended promote succeeds');

    // Force the condition: a LIVE foreign lock (fresh mtime, foreign owner)
    // already holds the critical section.
    const lockDir = `${claim.claimPath}.reclaim.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'live-foreign-nonce');
    const contended = promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken, now: t0 + 2_000 });
    assert.equal(contended.promoted, false, 'EEXIST must be observable — recursive mkdir would take the lock over');
    assert.equal(contended.reason, 'reclaim-contended');
    assert.equal(fs.existsSync(lockDir), true, 'live foreign lock must be preserved');
    assert.equal(
      fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'),
      'live-foreign-nonce',
      'the foreign owner stamp must never be overwritten',
    );
  });

  it('a live foreign reclaim lock makes releaseClaim concede without unlinking the claim', () => {
    const dir = tmpDir('notify-lockfix-');
    const t0 = 1_000_000;
    const claim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 });
    const lockDir = `${claim.claimPath}.reclaim.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'live-foreign-nonce');
    const rel = releaseClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken, now: t0 + 1_000 });
    assert.equal(rel.released, false);
    assert.equal(rel.reason, 'reclaim-contended');
    assert.equal(fs.existsSync(claim.claimPath), true, 'claim must survive a conceded release');
  });

  it('a stale foreign lock is swept for the NEXT caller: first promote concedes, second succeeds', () => {
    const dir = tmpDir('notify-lockfix-');
    const t0 = 10_000_000;
    const claim = claimDedupe({ dedupeDir: dir, eventId: EVENT_ID, ttlSeconds: 300, now: t0 });
    const lockDir = `${claim.claimPath}.reclaim.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'dead-foreign-nonce');
    const past = new Date(t0 - 120_000);
    fs.utimesSync(lockDir, past, past);
    const first = promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken, now: t0 });
    assert.equal(first.promoted, false, 'sweep-and-act in one call is forbidden');
    assert.equal(first.reason, 'reclaim-contended');
    assert.equal(fs.existsSync(lockDir), false, 'stale lock must be swept for the next caller');
    const second = promoteClaim({ dedupeDir: dir, eventId: EVENT_ID, ownerToken: claim.ownerToken, now: t0 + 1 });
    assert.equal(second.promoted, true, 'the slot must not wedge permanently');
  });
});

// ADR-0047 §6 — the bounded, fair, best-effort expired-claim sweep.
describe('notify-schema bounded expired-claim sweep (ADR-0047 §6)', () => {
  const TTL_SECONDS = 300;
  const TTL_MS = TTL_SECONDS * 1000;

  // A conforming claim file aged so that now - mtime == age.
  function seedClaim(dir, name, { now, age, body = '{"event_id":"seeded"}\n' }) {
    const claimPath = path.join(dir, name);
    fs.writeFileSync(claimPath, body);
    const stamp = new Date(now - age);
    fs.utimesSync(claimPath, stamp, stamp);
    return claimPath;
  }

  function hexName(seed) {
    // 32 lowercase hex chars from a deterministic seed.
    return `${seed.repeat(32).slice(0, 32)}.claim`;
  }

  it('deletes gc-eligible claims, keeps advisory-expired-within-margin and fresh claims', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const gc = seedClaim(dir, hexName('a'), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    const advisory = seedClaim(dir, hexName('b'), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS - 1 });
    const fresh = seedClaim(dir, hexName('c'), { now, age: 1_000 });
    const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
    assert.equal(res.swept, true);
    assert.equal(res.deleted_claims, 1);
    assert.equal(res.skipped_fresh, 2);
    assert.equal(fs.existsSync(gc), false, 'gc-eligible claim must be deleted');
    assert.equal(fs.existsSync(advisory), true, 'within-margin claim must survive (margin is the deletion bar)');
    assert.equal(fs.existsSync(fresh), true, 'fresh claim must survive');
  });

  it('never touches the excluded current-emit claim path regardless of age', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const excludedPath = seedClaim(dir, hexName('d'), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS * 10 });
    const res = sweepExpiredClaims({
      dedupeDir: dir, ttlSeconds: TTL_SECONDS, now, excludeClaimPath: excludedPath,
    });
    assert.equal(res.skipped_excluded, 1);
    assert.equal(res.deleted_claims, 0);
    assert.equal(fs.existsSync(excludedPath), true);
  });

  it('never touches non-conforming entries: foreign names, dirs, symlinks, uppercase hex, the cursor', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const old = new Date(now - TTL_MS - GC_SAFETY_MARGIN_MS * 10);
    const foreign = path.join(dir, 'claim-expired'); // the dashboard-test fixture shape
    fs.writeFileSync(foreign, 'x');
    fs.utimesSync(foreign, old, old);
    const upper = path.join(dir, `${'A'.repeat(32)}.claim`);
    fs.writeFileSync(upper, 'x');
    fs.utimesSync(upper, old, old);
    const masqueradeDir = path.join(dir, hexName('e'));
    fs.mkdirSync(masqueradeDir);
    fs.utimesSync(masqueradeDir, old, old);
    const dangling = path.join(dir, hexName('f'));
    fs.symlinkSync(path.join(dir, 'nonexistent-target'), dangling);
    const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
    assert.equal(res.deleted_claims, 0);
    assert.equal(fs.existsSync(foreign), true);
    assert.equal(fs.existsSync(upper), true);
    assert.equal(fs.existsSync(masqueradeDir), true);
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true, 'symlink must survive');
    // Cursor written by the sweep is itself a non-candidate on the next run.
    const again = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
    assert.equal(again.swept, true);
    assert.equal(fs.existsSync(path.join(dir, 'sweep.cursor')), true);
  });

  it('concedes a gc-eligible claim whose reclaim lock is LIVE — the owner wins', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const claimPath = seedClaim(dir, hexName('1'), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    const lockDir = `${claimPath}.reclaim.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), 'live-owner');
    // Lock mtime is now → live.
    const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
    assert.equal(res.conceded, 1, 'EEXIST on the lock must concede the entry');
    assert.equal(res.deleted_claims, 0);
    assert.equal(fs.existsSync(claimPath), true, 'claim owned by a live lock must survive');
    assert.equal(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'), 'live-owner');
  });

  it('removes stale reclaim-lock directories and keeps live ones', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const staleLock = path.join(dir, `${'2'.repeat(32)}.claim.reclaim.lock`);
    fs.mkdirSync(staleLock);
    const past = new Date(now - DEFAULT_LOCK_STALE_MS);
    fs.utimesSync(staleLock, past, past);
    const liveLock = path.join(dir, `${'3'.repeat(32)}.claim.reclaim.lock`);
    fs.mkdirSync(liveLock);
    fs.utimesSync(liveLock, new Date(now), new Date(now));
    const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
    assert.equal(res.swept_locks, 1);
    assert.equal(fs.existsSync(staleLock), false, 'stale orphan lock must be removed');
    assert.equal(fs.existsSync(liveLock), true, 'live lock must be preserved');
  });

  it('re-checks gc-eligibility INSIDE the lock: a claim refreshed at lock-acquire time survives', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const claimPath = seedClaim(dir, hexName('4'), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    // Simulate the reclaimer interleave deterministically (the fs.openSync
    // monkeypatch convention above): the instant the sweep acquires the lock,
    // a "reclaimer" re-creates the claim fresh. The in-lock re-check must see
    // the fresh mtime and refuse to delete; without it the sweep would
    // destroy the fresh claim — the §1 double-fire.
    const realMkdirSync = fs.mkdirSync;
    let interleaved = false;
    fs.mkdirSync = (...args) => {
      if (!interleaved && String(args[0]).endsWith('.reclaim.lock')) {
        interleaved = true;
        const stamp = new Date(now);
        fs.utimesSync(claimPath, stamp, stamp);
      }
      return realMkdirSync(...args);
    };
    try {
      const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
      assert.equal(interleaved, true, 'the interleave must have fired');
      assert.equal(res.deleted_claims, 0, 'in-lock re-check must refuse the just-refreshed claim');
      assert.equal(res.skipped_fresh, 1);
      assert.equal(fs.existsSync(claimPath), true);
    } finally {
      fs.mkdirSync = realMkdirSync;
    }
  });

  it('honors the deletion cap, the entry cap, and the wall-clock cutoff', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    for (const seed of ['1', '2', '3']) {
      seedClaim(dir, hexName(seed), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    }
    const capped = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now, maxDeletions: 1 });
    assert.equal(capped.deleted_claims, 1);
    assert.equal(capped.reason, 'deletion-cap');

    const dir2 = tmpDir('notify-sweep-');
    for (const seed of ['1', '2', '3']) {
      seedClaim(dir2, hexName(seed), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    }
    const entryCapped = sweepExpiredClaims({ dedupeDir: dir2, ttlSeconds: TTL_SECONDS, now, maxEntries: 2 });
    assert.equal(entryCapped.examined, 2);
    assert.equal(entryCapped.reason, 'entry-cap');

    const dir3 = tmpDir('notify-sweep-');
    for (const seed of ['1', '2', '3']) {
      seedClaim(dir3, hexName(seed), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    }
    // Injected elapsed clock: 0 at start, huge on the first per-entry check.
    let tick = 0;
    const cutoff = sweepExpiredClaims({
      dedupeDir: dir3, ttlSeconds: TTL_SECONDS, now,
      elapsedClock: () => (tick++ === 0 ? 0 : 10_000),
    });
    assert.equal(cutoff.reason, 'elapsed-cutoff');
    assert.ok(cutoff.examined <= 1, 'cutoff must stop the scan almost immediately');
  });

  it('converges over successive sweeps via cursor rotation — the tail is never starved', () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    const seeds = ['1', '2', '3', '4', '5', '6'];
    const paths = seeds.map((seed) => seedClaim(dir, hexName(seed), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS }));
    for (let round = 0; round < 3; round++) {
      const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now, maxDeletions: 2 });
      assert.equal(res.deleted_claims, 2, `round ${round} must delete exactly the cap`);
    }
    for (const p of paths) {
      assert.equal(fs.existsSync(p), false, `${path.basename(p)} must be gone after 3 capped sweeps`);
    }
  });

  it('reports bad args and a missing dedupe dir as data — never throws', () => {
    assert.equal(sweepExpiredClaims({ dedupeDir: '', ttlSeconds: 300 }).reason, 'bad-args:dedupeDir');
    assert.equal(sweepExpiredClaims({ dedupeDir: '/tmp/x', ttlSeconds: 0 }).reason, 'bad-args:ttlSeconds');
    const missing = sweepExpiredClaims({
      dedupeDir: path.join(tmpDir('notify-sweep-'), 'nonexistent'),
      ttlSeconds: 300,
    });
    assert.equal(missing.swept, false);
    assert.equal(missing.reason, 'no-dedupe-dir');
  });

  it('contains per-entry failures: an undeletable claim is counted, not thrown', { skip: process.getuid?.() === 0 }, () => {
    const dir = tmpDir('notify-sweep-');
    const now = 100_000_000;
    seedClaim(dir, hexName('7'), { now, age: TTL_MS + GC_SAFETY_MARGIN_MS });
    fs.chmodSync(dir, 0o500); // claim visible+statable, unlink+lock-mkdir denied
    try {
      const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: TTL_SECONDS, now });
      assert.equal(res.deleted_claims, 0);
      assert.ok(res.failures + res.conceded >= 1, 'the denied mutation must be contained as data');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  // The §6 cross-process proof: an expired claim raced by reclaimers AND
  // sweepers must fire exactly once — the sweep's lock protocol is what
  // prevents it from destroying a reclaimer's just-created fresh claim
  // (which would hand a second racer a second `claimed: true`).
  it('cross-process: claimDedupe reclaimers racing sweepers yield exactly one claimed:true', async () => {
    const dir = tmpDir('notify-sweep-race-');
    const eventId = 'repo-abcd1234:peer-run-terminal:run-99:completed';
    const t0 = Date.now();
    const first = claimDedupe({ dedupeDir: dir, eventId, ttlSeconds: TTL_SECONDS, now: t0 });
    assert.equal(first.claimed, true);
    const past = new Date(t0 - TTL_MS - GC_SAFETY_MARGIN_MS - 60_000);
    fs.utimesSync(first.claimPath, past, past);

    const claimScript = `
      import { claimDedupe } from ${JSON.stringify(LIB_URL)};
      const [dir, eventId, ttl, now] = process.argv.slice(1);
      const res = claimDedupe({ dedupeDir: dir, eventId, ttlSeconds: Number(ttl), now: Number(now) });
      process.stdout.write(JSON.stringify({ claimed: res.claimed }));
    `;
    const sweepScript = `
      import { sweepExpiredClaims } from ${JSON.stringify(LIB_URL)};
      const [dir, ttl, now] = process.argv.slice(1);
      const res = sweepExpiredClaims({ dedupeDir: dir, ttlSeconds: Number(ttl), now: Number(now) });
      process.stdout.write(JSON.stringify({ claimed: false, deleted: res.deleted_claims }));
    `;
    const runs = await Promise.all([
      ...Array.from({ length: 6 }, () =>
        execFileAsync(process.execPath, [
          '--input-type=module', '-e', claimScript, '--', dir, eventId, String(TTL_SECONDS), String(t0),
        ])),
      ...Array.from({ length: 4 }, () =>
        execFileAsync(process.execPath, [
          '--input-type=module', '-e', sweepScript, '--', dir, String(TTL_SECONDS), String(t0),
        ])),
    ]);
    const results = runs.map(({ stdout }) => JSON.parse(stdout));
    const winners = results.filter((r) => r.claimed);
    // The §1 invariant is NEVER-two (double-fire); a zero-winner moment is a
    // theoretically possible (all reclaimers overlapping one sweeper's
    // microsecond lock hold) but harmless concession round.
    assert.ok(
      winners.length <= 1,
      `double-fire: expected at most 1 claimed:true under reclaim/sweep contention, got ${winners.length}: ${JSON.stringify(results)}`,
    );
  });
});
