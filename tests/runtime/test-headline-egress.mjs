// tests/runtime/test-headline-egress.mjs
//
// ADR-0041 §3a — STABLE guard tests for the OPT-IN closed-vocabulary `headline`
// status token (runtime-headline subtask). These are the runtime-side guards the
// ADR promises are load-bearing:
//
//   - the field is a SEPARATE optional field, NOT a member of the unconditionally-
//     iterated OPTIONAL_ROUTING_FIELDS (Codex PEER-9);
//   - the opt-in is default-OFF, strict-boolean, and CANNOT be enabled by tracked
//     config (env or user-home verified-ignored-local only) — §2c's structural
//     impossibility extended to the format gate;
//   - the egress builders VALIDATE-OR-DROP against the closed vocab (§3a Guard 2),
//     so a producer bug / vocab drift / a crafted value is dropped, never egressed;
//   - opt-in-ALONE is inert: a set opt-in without egress activation engages no
//     egress at all;
//   - the payload body and the attempt-mirror agree (parity).
//
// The real attention-produced headline lands in producer-headline; here the source
// is a SYNTHETIC event.headline. The full deterministic leak-scan battery + one
// real path is acceptance-headline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermetic: strip any ambient egress activation + the §3a opt-in the operator's own
// dogfood shell may export, so the default-env tests are deterministic on any
// machine (mirrors test-notify.mjs's module-load scrub, extended with the new
// opt-in var so a set AGENTIC_NOTIFY_EGRESS_HEADLINE cannot flip a default-env test).
for (const k of [
  'AGENTIC_NOTIFY_EGRESS_CHANNEL',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_BOT_TOKEN',
  'AGENTIC_NOTIFY_EGRESS_HEADLINE',
]) {
  delete process.env[k];
}

import {
  OPTIONAL_ROUTING_FIELDS,
  OPTIONAL_HEADLINE_FIELD,
  HEADLINE_VOCAB,
  HEADLINE_FIELD_CAP,
  isHeadlineToken,
  validateEvent,
  notifyStateDir,
} from '../../plugins/runtime/scripts/lib/notify-schema.mjs';
import {
  buildEgressPayload,
  renderEgressText,
} from '../../plugins/runtime/scripts/lib/egress-channel.mjs';
import { buildEgressMirrorRecord } from '../../plugins/runtime/scripts/lib/egress-semantics.mjs';
import {
  parseHeadlineOptInValue,
  parseEgressLocalToml,
  loadEgressHeadlineOptIn,
  EGRESS_HEADLINE_LOCAL_KEY,
  EGRESS_LOCAL_FILENAME,
} from '../../plugins/runtime/scripts/lib/egress-config.mjs';
import { runEmit } from '../../plugins/runtime/scripts/notify.mjs';

const HAS_GETUID = typeof process.getuid === 'function';

// ---------------------------------------------------------------------------
// Fixtures (self-contained runEmit harness)
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepo({ configLines = null } = {}) {
  const root = tmpDir('headline-repo-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (configLines) {
    const dir = path.join(root, '.agentic-plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), `${configLines.join('\n')}\n`);
  }
  return root;
}

function makeHome({ localLines = null, mode = 0o600 } = {}) {
  const home = tmpDir('headline-home-');
  if (localLines) {
    const dir = path.join(home, '.agentic-plugins');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, EGRESS_LOCAL_FILENAME);
    fs.writeFileSync(file, `${localLines.join('\n')}\n`);
    fs.chmodSync(file, mode);
  }
  return home;
}

function localFilePath(home) {
  return path.join(home, '.agentic-plugins', EGRESS_LOCAL_FILENAME);
}

// getuid injector that makes the ownership gate pass for a real file.
function ownerOf(file) {
  return () => fs.statSync(file).uid;
}

// A fake token (never a real / token-shaped value in an assertion string).
const FAKE_TOKEN = `123456789:AA${'x'.repeat(33)}`;
const FAKE_CHAT = '846000000';

function egressEnv(overrides = {}) {
  return {
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_CHAT_ID: FAKE_CHAT,
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    ...overrides,
  };
}

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ ok: true }) };
  };
}

function makeEvent(overrides = {}) {
  return {
    event_id: 'repo-abc123:approval:host-mba:session:s1:aaaa:fired',
    source: 'test',
    kind: 'approval',
    title: 'Approval needed',
    urgency: 'normal',
    hostname: 'mba',
    topic: 'repo:main',
    session_hint: 'sess12',
    ...overrides,
  };
}

function readLog(repoRoot) {
  const logPath = path.join(notifyStateDir(repoRoot), 'log.ndjson');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

async function egressEmit({ repoRoot, home, event = makeEvent(), env = egressEnv(), calls = [] }) {
  return runEmit({
    eventText: JSON.stringify(event),
    repoRoot,
    homeDir: home ?? makeHome(),
    now: NOW,
    env,
    fetchImpl: fakeFetch(calls),
  });
}

// ---------------------------------------------------------------------------
// Schema (notify-schema.mjs)
// ---------------------------------------------------------------------------

describe('headline schema', () => {
  it('headline is NOT a member of the unconditionally-iterated OPTIONAL_ROUTING_FIELDS (PEER-9)', () => {
    assert.equal(OPTIONAL_ROUTING_FIELDS.includes('headline'), false);
    assert.equal(OPTIONAL_HEADLINE_FIELD, 'headline');
  });

  it('the closed vocabulary is the decided §3a set', () => {
    assert.deepEqual(
      [...HEADLINE_VOCAB],
      ['your-turn', 'needs-approval', 'in-progress', 'blocked', 'complete', 'failed'],
    );
    assert.ok(Object.isFrozen(HEADLINE_VOCAB));
  });

  it('isHeadlineToken is an EXACT closed-vocab membership test (Guard 2 predicate)', () => {
    for (const token of HEADLINE_VOCAB) assert.equal(isHeadlineToken(token), true);
    assert.equal(isHeadlineToken('definitely-not-a-token'), false);
    assert.equal(isHeadlineToken(' complete '), false, 'a whitespace-padded token is not a token');
    assert.equal(isHeadlineToken('COMPLETE'), false, 'case-sensitive');
    assert.equal(isHeadlineToken(''), false);
    assert.equal(isHeadlineToken(123), false);
    assert.equal(isHeadlineToken(null), false);
    assert.equal(isHeadlineToken(undefined), false);
  });

  it('the cap is a positive bound comfortably above the longest token', () => {
    const longest = HEADLINE_VOCAB.reduce((m, t) => Math.max(m, t.length), 0);
    assert.equal(typeof HEADLINE_FIELD_CAP, 'number');
    assert.ok(HEADLINE_FIELD_CAP >= longest);
  });

  it('validateEvent does NOT reject an event carrying a headline (so a bad headline never suppresses the base notification)', () => {
    // headline is intentionally OUTSIDE validateEvent's checks: the enum drop
    // happens at the egress boundary (Guard 2), not by failing validation — a
    // failed validation would suppress the whole notification (ADR §3a fail-closed:
    // omit headline WITHOUT suppressing the base).
    const okValid = validateEvent(makeEvent({ headline: 'needs-approval' }));
    const okGarbage = validateEvent(makeEvent({ headline: 'not-a-vocab-token' }));
    const okNonString = validateEvent(makeEvent({ headline: 42 }));
    assert.equal(okValid.ok, true);
    assert.equal(okGarbage.ok, true);
    assert.equal(okNonString.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Opt-in parse + load (egress-config.mjs)
// ---------------------------------------------------------------------------

describe('headline opt-in — strict boolean parse', () => {
  it('accepts only affirmative tokens; everything else is fail-closed OFF', () => {
    for (const yes of ['true', 'TRUE', ' 1 ', 'yes', 'On']) assert.equal(parseHeadlineOptInValue(yes), true, yes);
    for (const no of ['false', '0', 'no', 'off', '', 'maybe', 'truthy', '2']) {
      assert.equal(parseHeadlineOptInValue(no), false, no);
    }
    assert.equal(parseHeadlineOptInValue(undefined), false);
    assert.equal(parseHeadlineOptInValue(1), false, 'a non-string is not affirmative');
  });

  it('parseEgressLocalToml now reads egress_headline (allowlist extended), still egress-only', () => {
    const parsed = parseEgressLocalToml('egress_headline = "true"\nnotify_channel = "file-log"\nmodel = "x"\n');
    assert.equal(parsed[EGRESS_HEADLINE_LOCAL_KEY], 'true');
    assert.equal(parsed.notify_channel, undefined, 'an unrelated key never leaks in');
    assert.equal(parsed.model, undefined);
  });
});

describe('headline opt-in — loadEgressHeadlineOptIn', () => {
  it('defaults OFF with no env and no local file', () => {
    assert.equal(loadEgressHeadlineOptIn({ repoRoot: makeRepo(), homeDir: makeHome(), env: {} }), false);
  });

  it('env affirmative → ON; env false / invalid → OFF (fail-closed)', () => {
    const base = { repoRoot: makeRepo(), homeDir: makeHome() };
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 'true' } }), true);
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: '1' } }), true);
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 'false' } }), false);
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 'garbage' } }), false);
  });

  it('a NON-STRING env value is not coerced to a token (strict-boolean contract at the loader — Codex peer)', () => {
    // process.env is always string-valued; a programmatic non-string injection must
    // NOT be stringified into an affirmative (the earlier normalizeScalar path did).
    const base = { repoRoot: makeRepo(), homeDir: makeHome() };
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: true } }), false);
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 1 } }), false);
    assert.equal(loadEgressHeadlineOptIn({ ...base, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: {} } }), false);
  });

  it('NEVER throws — a bad homeDir or a throwing injected reader fails closed to OFF (Codex peer)', () => {
    assert.equal(loadEgressHeadlineOptIn({ repoRoot: makeRepo(), homeDir: null, env: {} }), false);
    assert.equal(
      loadEgressHeadlineOptIn({
        repoRoot: makeRepo(),
        homeDir: makeHome(),
        env: {},
        readLocalImpl: () => { throw new Error('boom'); },
      }),
      false,
    );
  });

  it('reads an affirmative value from the user-home verified-ignored-local layer', { skip: !HAS_GETUID }, () => {
    const home = makeHome({ localLines: ['egress_headline = "true"'] });
    const repo = makeRepo();
    const on = loadEgressHeadlineOptIn({ repoRoot: repo, homeDir: home, env: {}, getuid: ownerOf(localFilePath(home)) });
    assert.equal(on, true);
  });

  it('TRACKED config.toml is NEVER consulted (a tracked egress_headline cannot enable it)', () => {
    // egress_headline in the repo's TRACKED config.toml is inert: the loader reads
    // only env + config.LOCAL.toml, never config.toml.
    const repo = makeRepo({ configLines: ['egress_headline = "true"', 'notify_channel = "file-log"'] });
    assert.equal(loadEgressHeadlineOptIn({ repoRoot: repo, homeDir: makeHome(), env: {} }), false);
  });

  it('a repo-INSIDE config.local.toml is REFUSED even when HOME is the repo (cloned-repo threat)', { skip: !HAS_GETUID }, () => {
    // Devcontainer/CI shape: HOME === repo. A hostile clone ships
    // .agentic-plugins/config.local.toml with egress_headline=true; the inside-repo
    // proof in readVerifiedIgnoredLocal refuses it → OFF (mirrors the §2c activation
    // guarantee for the format gate).
    const repo = makeRepo();
    const dir = path.join(repo, '.agentic-plugins');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, EGRESS_LOCAL_FILENAME);
    fs.writeFileSync(file, 'egress_headline = "true"\n');
    fs.chmodSync(file, 0o600);
    const optIn = loadEgressHeadlineOptIn({ repoRoot: repo, homeDir: repo, env: {}, getuid: ownerOf(file) });
    assert.equal(optIn, false);
  });

  it('a missing repoRoot fails closed (the inside-repo proof cannot run)', { skip: !HAS_GETUID }, () => {
    const home = makeHome({ localLines: ['egress_headline = "true"'] });
    assert.equal(
      loadEgressHeadlineOptIn({ repoRoot: null, homeDir: home, env: {}, getuid: ownerOf(localFilePath(home)) }),
      false,
    );
  });

  it('env takes precedence over the verified-local layer (both directions)', { skip: !HAS_GETUID }, () => {
    const homeTrue = makeHome({ localLines: ['egress_headline = "true"'] });
    const homeFalse = makeHome({ localLines: ['egress_headline = "false"'] });
    const repo = makeRepo();
    // env false beats local true
    assert.equal(
      loadEgressHeadlineOptIn({ repoRoot: repo, homeDir: homeTrue, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 'false' }, getuid: ownerOf(localFilePath(homeTrue)) }),
      false,
    );
    // env true beats local false
    assert.equal(
      loadEgressHeadlineOptIn({ repoRoot: repo, homeDir: homeFalse, env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 'true' }, getuid: ownerOf(localFilePath(homeFalse)) }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Payload builder (egress-channel.mjs)
// ---------------------------------------------------------------------------

describe('buildEgressPayload — headline opt-in + validate-or-drop', () => {
  const ev = { kind: 'turn-complete', hostname: 'h1', topic: 'repo:main', headline: 'needs-approval' };

  it('opt-in OFF (default) → headline absent even when the event carries a valid one', () => {
    assert.equal('headline' in buildEgressPayload(ev), false);
    assert.equal('headline' in buildEgressPayload(ev, { headlineOptIn: false }), false);
  });

  it('opt-in ON + valid vocab → headline present', () => {
    const p = buildEgressPayload(ev, { headlineOptIn: true });
    assert.equal(p.headline, 'needs-approval');
  });

  it('opt-in ON + OUT-OF-VOCAB → dropped (Guard 2 validate-or-drop, never coerced)', () => {
    const secretish = buildEgressPayload({ ...ev, headline: 'sk-abcdef0123456789abcd' }, { headlineOptIn: true });
    assert.equal('headline' in secretish, false, 'an out-of-vocab (secret-shaped) headline is dropped');
    const padded = buildEgressPayload({ ...ev, headline: ' complete ' }, { headlineOptIn: true });
    assert.equal('headline' in padded, false, 'a whitespace-padded token is not a member → dropped');
  });

  it('opt-in ON + non-string headline → dropped', () => {
    assert.equal('headline' in buildEgressPayload({ ...ev, headline: { evil: true } }, { headlineOptIn: true }), false);
    assert.equal('headline' in buildEgressPayload({ ...ev, headline: 7 }, { headlineOptIn: true }), false);
  });

  it('a valid token survives the uniform scrub-before-cap pass unchanged (belt-and-suspenders no-op)', () => {
    for (const token of HEADLINE_VOCAB) {
      const p = buildEgressPayload({ kind: 'idle', headline: token }, { headlineOptIn: true });
      assert.equal(p.headline, token);
    }
  });

  it('renderEgressText shows the headline after kind when present, omits it when absent', () => {
    const withHeadline = renderEgressText(buildEgressPayload(ev, { headlineOptIn: true }));
    assert.match(withHeadline, /turn-complete · needs-approval/);
    const without = renderEgressText(buildEgressPayload(ev)); // opt-in off
    assert.equal(without.includes('needs-approval'), false);
  });
});

// ---------------------------------------------------------------------------
// Mirror builder (egress-semantics.mjs) — parity with the payload
// ---------------------------------------------------------------------------

describe('buildEgressMirrorRecord — headline parity with the payload', () => {
  const event = { event_id: 'e', kind: 'turn-complete', urgency: 'normal', hostname: 'h1', headline: 'in-progress' };
  const base = { event, service: 'telegram', egressStatus: 'dispatched', outcome: 'dispatched', now: 0 };

  it('opt-in OFF → mirror has no headline', () => {
    assert.equal('headline' in buildEgressMirrorRecord(base), false);
  });

  it('opt-in ON + valid → mirror carries the headline (same guard as the payload)', () => {
    assert.equal(buildEgressMirrorRecord({ ...base, headlineOptIn: true }).headline, 'in-progress');
  });

  it('opt-in ON + out-of-vocab → dropped from the mirror too', () => {
    const m = buildEgressMirrorRecord({ ...base, event: { ...event, headline: 'leak-me' }, headlineOptIn: true });
    assert.equal('headline' in m, false);
  });
});

// ---------------------------------------------------------------------------
// runEmit integration (notify.mjs) — SYNTHETIC event.headline end-to-end
// ---------------------------------------------------------------------------

describe('notify runEmit — headline emission + opt-in-alone inert', () => {
  it('opt-in-ALONE is inert: headline opt-in set but egress NOT activated → NO egress engaged', async () => {
    // A local channel is configured; the headline opt-in is ON but there is no
    // egress activation (no AGENTIC_NOTIFY_EGRESS_CHANNEL / token / chat). The
    // effective channel stays local, runEgressDispatch is never reached, and the
    // fetch seam is never called.
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const calls = [];
    const result = await runEmit({
      eventText: JSON.stringify(makeEvent({ headline: 'needs-approval' })),
      repoRoot,
      homeDir: makeHome(),
      now: NOW,
      env: { AGENTIC_NOTIFY_EGRESS_HEADLINE: 'true' },
      fetchImpl: fakeFetch(calls),
    });
    assert.notEqual(result.channel, 'telegram', 'the effective channel is NOT egress');
    assert.notEqual(result.stage, 'egress');
    assert.equal(calls.length, 0, 'the pinned request seam is never called by an opt-in-alone');
    const rows = readLog(repoRoot);
    assert.ok(!JSON.stringify(rows).includes('needs-approval'), 'headline never reaches the local channel record');
  });

  it('egress active + opt-in ON + valid headline → the sent body AND the mirror carry the token (synthetic source)', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    const result = await egressEmit({
      repoRoot,
      calls,
      env: egressEnv({ AGENTIC_NOTIFY_EGRESS_HEADLINE: 'true' }),
      event: makeEvent({ headline: 'needs-approval' }),
    });
    assert.equal(result.status, 'dispatched');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(body).sort(), ['chat_id', 'text']);
    assert.match(body.text, /needs-approval/, 'the opt-in headline is in the sent text');
    const rows = readLog(repoRoot);
    assert.equal(rows[0].headline, 'needs-approval', 'the mirror carries the same headline');
  });

  it('egress active + opt-in ON + OUT-OF-VOCAB headline → base dispatched, NO headline in body OR mirror (Guard 2 end-to-end)', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    const result = await egressEmit({
      repoRoot,
      calls,
      env: egressEnv({ AGENTIC_NOTIFY_EGRESS_HEADLINE: 'true' }),
      event: makeEvent({ headline: 'sk-leak-me-0123456789abcdef' }),
    });
    assert.equal(result.status, 'dispatched', 'the base notification still dispatches (drop, not suppress)');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.text.includes('sk-leak-me'), false, 'an out-of-vocab headline never egresses even with the opt-in ON');
    const rows = readLog(repoRoot);
    assert.equal('headline' in rows[0], false, 'and never reaches the mirror');
  });

  it('DEFAULT-OFF regression: egress active + valid headline present + NO opt-in → no headline in body or mirror', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    await egressEmit({ repoRoot, calls, event: makeEvent({ headline: 'needs-approval' }) }); // egressEnv has no opt-in
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.text.includes('needs-approval'), false, 'no headline in the body without the opt-in');
    const rows = readLog(repoRoot);
    assert.equal('headline' in rows[0], false, 'no headline in the mirror without the opt-in');
  });

  it('SOURCE ISOLATION: a valid headline egresses but a secret parked in title/body never does', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    await egressEmit({
      repoRoot,
      calls,
      env: egressEnv({ AGENTIC_NOTIFY_EGRESS_HEADLINE: 'true' }),
      event: makeEvent({
        headline: 'complete',
        title: 'FORBIDDEN_TITLE_SENTINEL',
        body: 'FORBIDDEN_BODY_SENTINEL sk-deadbeef0123456789ab',
      }),
    });
    const body = JSON.parse(calls[0].init.body);
    assert.match(body.text, /complete/, 'the valid headline token is present');
    assert.equal(body.text.includes('FORBIDDEN_TITLE_SENTINEL'), false);
    assert.equal(body.text.includes('FORBIDDEN_BODY_SENTINEL'), false);
    assert.equal(body.text.includes('sk-deadbeef'), false);
  });
});
