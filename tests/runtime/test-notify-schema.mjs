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
  it('pins the ADR-0040 §1 kind enum exactly', () => {
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
    const ids = new Set(['approval', 'idle', 'turn-complete'].map(mk));
    assert.equal(ids.size, 3);
  });

  it('pins the default-status kinds to the ADR-0040 §1 three', () => {
    assert.deepEqual(
      [...KINDS_WITH_DEFAULT_STATUS],
      ['approval', 'idle', 'turn-complete'],
    );
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
