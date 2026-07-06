// ADR-0041 - cross-machine notification egress (E1): BLACK-BOX ACCEPTANCE.
//
// The holistic, cross-surface AND cross-host acceptance gate for the ADR-0041
// series (boundary-doc -> egress-config -> event-schema -> fetch-gate ->
// egress-semantics -> telegram-channel -> THIS gate). The per-component suites
// (tests/runtime/test-egress-config.mjs, test-egress-channel.mjs,
// test-egress-semantics.mjs, test-notify.mjs's egress block, and the keystone
// tests/plugin-shape/runtime-executor-scan.mjs / runtime-executor-registry.mjs)
// prove each path's mechanics in depth. THIS suite proves the load-bearing E1
// acceptance criteria hold END-TO-END through the REAL entry points an operator
// or host lifecycle actually drives:
//
//   (A) §2b/§2f/§3/§5 -- the ONE pinned request an active machine issues carries
//       the pinned URL/method/redirect, an enumerated-fields-ONLY body, and a
//       fake token that escapes to NOWHERE in the persisted notify state tree.
//   (B) §2a -- no operator input can ever name a destination URL: the only
//       egress-activation inputs are a fixed service ENUM + a recipient + an env
//       credential; an arbitrary/self-host URL is rejected, never dispatched.
//   (C) §2c -- activation resolves ONLY from the operator env or a fail-closed-
//       verified user-home ignored-local file, NEVER tracked/repo config, and a
//       token alone never activates -- proven through the REAL notify.mjs CLI +
//       the REAL filesystem verified-local reader, including the HOME-is-the-repo
//       hostile-clone rejection (§10's load-bearing impossibility proof).
//   (D) §6/§7 -- the attempt-mirror + the E1 amendment to ADR-0040 dedupe
//       persistence (failed dispatch RELEASES the claim so a fixed config
//       re-fires; a repeated failure ENGAGES the throttle; a config fix BYPASSES
//       it), observed as DURABLE filesystem state (dedupe claims + throttle
//       records + mirror rows). The ADR calls this out explicitly for acceptance
//       "so the two rules do not read as contradictory".
//   (E) cross-host -- ONE channel serves BOTH hosts: the REAL Claude attention
//       Notification sensor AND the REAL rendered Codex notify= shuttle each
//       drive the REAL notify.mjs emitter to a telegram egress attempt (no unit
//       wires a real producer to egress; each host adapter is exercised).
//   (G) the ADR-0010 §5 subprocess-only boundary: no attention sensor and no
//       persona self-sensor STATICALLY/DYNAMICALLY/re-export imports the runtime
//       emit substrate -- notify.mjs, notify-schema.mjs, OR the new egress-*.mjs
//       libs -- it is reached only by subprocess (the emitter) or copy (the §1
//       contract lib).
//   (H) §2b/§5 deterministic LEAK SCAN (this [acceptance-gate] slice): a fake
//       credential, present end-to-end, is asserted ABSENT from every observable
//       surface -- a spawned child's argv + sanitized env, the real CLI's
//       stdout/stderr, and the persisted artifact + state tree. A SCAN, not a review.
//   (I) §2e FAIL-CLOSED transport: a thrown/absent transport degrades to a recorded
//       failed outcome (claim released, throttle recorded, mirror row) and NEVER
//       throws or wedges the fire-and-forget hook path.
//   (J) §7 outcome-classification matrix: every provider result/error (2xx ok,
//       4xx/5xx, {ok:false}, TimeoutError, native ETIMEDOUT, redirect, ENOTFOUND)
//       maps to the right outcome/status/reason + claim/throttle disposition -- the
//       runtime complement to the static executor guard's SHAPE proof.
//   (K) opt-in REAL-network smoke (CI-SKIPPED): the ONE gate that opens a real
//       socket, behind AGENTIC_EGRESS_REAL_SMOKE=1. Deterministic CI is necessary
//       but NOT sufficient; real delivery proof is the [release-dogfood] subtask.
//
// Two properties inherently need injection and use the runtime's OWN public
// `runEmit` API (documented, deliberate -- NOT a cross-plugin reach; the
// ADR-0010 §5 ban is on PLUGINS importing across the seam, and a test is not a
// plugin), mirroring the ADR-0040 acceptance precedent (quiet-hours `now`,
// osascript `spawnImpl`):
//   - the pinned request URL/body cannot be OBSERVED through the fire-and-forget
//     CLI without capturing the network call -- `runEmit({ fetchImpl })`;
//   - the §7 provider-outcome scenarios (timeout / later-success / throttle /
//     config-fix bypass) need a DETERMINISTIC provider result -- `runEmit({
//     fetchImpl, now })`.
// A FAKE, shape-valid token is used everywhere a request is issued; it never
// reaches a real endpoint -- the node:https transport is injected via `fetchImpl`
// (a node:https-shaped double as of the [impl-transport] swap + this slice's seam
// rework), so no socket opens. The SOLE exception is the opt-in (K) real-network
// smoke, CI-skipped by default. Every real-subprocess path that cannot inject the
// transport is kept network-free by DESIGN: a MISSING or SHAPE-INVALID token (or a
// missing recipient) resolves BEFORE the pinned request, so the real notify.mjs
// never opens a socket -- the acceptance criterion there is the mirror/throttle/
// claim state, not a send.
//
// Host-free + deterministic: throwaway git repos + state homes + a fixture HOME
// so no real user config leaks in; the runtime is pinned via AGENTIC_RUNTIME_ROOT
// so sensor/shuttle discovery never depends on the host's plugin cache. Run via
// `node --test tests/acceptance/test-cross-machine-egress-acceptance.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime PUBLIC API -- used ONLY for the two injection-dependent properties
// (A pinned-request capture, D provider-outcome scenarios). No persona/attention
// PLUGIN is imported anywhere in this file (the (G) scan enforces that on them).
import { runEmit } from '../../plugins/runtime/scripts/notify.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime');
const NOTIFY_CLI = resolve(RUNTIME_ROOT, 'scripts/notify.mjs');
const ATTENTION_ROOT = resolve(REPO_ROOT, 'plugins/attention');
const NOTIFICATION_SENSOR = resolve(ATTENTION_ROOT, 'adapters/claude/hooks/notification.mjs');
const SHUTTLE_TEMPLATE = resolve(RUNTIME_ROOT, 'receivers/codex-notify-shuttle.mjs');

// HERMETICITY (peer CRITICAL): several real-CLI/sensor tests build their subprocess
// env as `{ ...process.env, ... }`. The owner DOGFOODS this channel with a LIVE
// @e16tae_notification_bot and may export TELEGRAM_BOT_TOKEN / the egress activation
// in the same shell that runs `npm test` (the [release-dogfood] subtask literally
// asks for it). Left inherited, a "network-free, missing-credential" test would then
// engage egress with the REAL token + a valid recipient and open a REAL node:https
// socket to api.telegram.org carrying the live credential -- defeating the suite's
// own hermeticity, flipping missing-* asserts to dispatched/provider-error, and
// putting the secret on the wire from the very suite meant to contain it. Scrub the
// AMBIENT egress activation ONCE at module load (before any test body runs). Every
// test sets the activation it needs explicitly; none relies on the ambient value.
// A no-op on a clean CI env. This also keeps the ONE real socket exclusively behind
// the (K) AGENTIC_EGRESS_REAL_SMOKE opt-in. NOTE: `node:https` core (not undici,
// no proxy-aware agent) is also a containment gain -- the token-in-URL is never
// auto-routed through an ambient HTTP(S)_PROXY.
for (const k of ['AGENTIC_NOTIFY_EGRESS_CHANNEL', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']) {
  delete process.env[k];
}

// The notify state layout (ADR-0040 §1 / ADR-0041 §7; canonical: notify-schema
// notifyStateDir + egress-semantics egressThrottleDir). Hardcoded here -- a
// black-box observer reads the documented paths, never imports the layout helper.
const NOTIFY_DIR_REL = join('.agentic-plugins', 'state', 'runtime', 'notify');
const LOG_REL = join(NOTIFY_DIR_REL, 'log.ndjson');
const DEDUPE_REL = join(NOTIFY_DIR_REL, 'dedupe');
const THROTTLE_REL = join(NOTIFY_DIR_REL, 'egress-throttle');

// A shape-valid FAKE Telegram bot token (§2b: no real/token-shaped value ever
// reaches a real endpoint, log, mirror, or artifact). Matches
// validateTelegramToken's /^\d{5,}:[A-Za-z0-9_-]{20,}$/.
const FAKE_TOKEN = '123456789:AAA_bbbCCCdddEEEfffGGGhhhIIIjjjKKK';
const FAKE_TOKEN_FIXED = '987654321:ZZZ_yyyXXXwwwVVVuuuTTTsssRRRqqqPPP';
const FAKE_CHAT_ID = '-1001234567890';
// A token fragment that must never appear anywhere in persisted state. NOTE: this
// is only the token's LOW-ENTROPY, semi-public bot-id half, and (peer MAJOR) it is
// a substring of FAKE_CHAT_ID ('-1001234567890') and all-hex, so it is a weak,
// collision-prone witness. It is kept as a secondary check on CONTENT surfaces only.
const TOKEN_BOT_ID = '123456789';
// The token's SECRET half (the high-entropy auth part after the ':'). A leak of THIS
// is the real breach -- a regression that persisted ONLY the auth suffix would slip
// past every bot-id/full-token scan (peer MAJOR). This distinctive, non-hex,
// single-occurrence slice is the unambiguous witness the leak scans key on.
const TOKEN_SECRET_FRAGMENT = 'AAA_bbbCCCddd';
// A SHAPE-INVALID token: present (so activation still ENGAGES) but rejected by
// validateTelegramToken BEFORE the pinned request. Used in every real-CLI
// NEGATIVE activation test so the network-free premise holds UNCONDITIONALLY —
// even a would-be bug that wrongly honored the activation source resolves to
// invalid-local-activation before any socket to api.telegram.org opens (peer
// MAJOR: a valid token in those tests could open a real socket if the guard
// regressed).
const INVALID_TOKEN = 'not-a-valid-telegram-token';
// A recipient distinct from FAKE_CHAT_ID, so a test can prove a chat-id came
// from the verified-ignored-local FILE (not the env) by its value.
const LOCAL_CHAT_ID = '-1009876543210';

// C0 + DEL + C1 control-character class, written with \u escapes so no literal
// control byte lives in this source.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// ---------------------------------------------------------------------------
// Fixtures + drivers
// ---------------------------------------------------------------------------

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `adr0041-${prefix}-`));
}

// A bare-.git marker repo: the emitter's resolveRepoRoot only needs a .git
// marker; the sensors/shuttle walk to .git. No real history required.
function markerRepo(prefix) {
  const root = tmp(prefix);
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

// An empty fixture HOME so the emitter's user-config layer + the verified-local
// reader never see the real developer's ~/.agentic-plugins.
function fixtureHome() {
  return tmp('home');
}

// Tracked repo config (.agentic-plugins/config.toml) -- the ADR-0040 local
// notify config surface. Egress keys placed here MUST be inert (§2c).
function writeConfig(root, kv) {
  const dir = join(root, '.agentic-plugins');
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(kv).map(([k, v]) => `${k} = "${v}"`).join('\n');
  writeFileSync(join(dir, 'config.toml'), `${body}\n`);
}

// The single honored verified-ignored-local file: <home>/.agentic-plugins/
// config.local.toml (egress-config EGRESS_LOCAL_FILENAME). mode 0600 so the
// reader's group/other-writable gate passes; owner is this process (uid match).
function writeVerifiedLocal(home, kv) {
  const dir = join(home, '.agentic-plugins');
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(kv).map(([k, v]) => `${k} = "${v}"`).join('\n');
  const file = join(dir, 'config.local.toml');
  writeFileSync(file, `${body}\n`, { mode: 0o600 });
  return file;
}

// A §1 event_id: <repoIdent>:<kind>:<subject>:<status>, colon-free repoIdent +
// status, kind segment == kind. The emitter validates shape + uses it verbatim.
function buildId(repoIdent, kind, subject, status) {
  return `${repoIdent}:${kind}:${subject}:${status}`;
}

// Every NON-enumerated field carries a unique sentinel so §2f/§3 exclusion can be
// asserted by absence (peer MAJOR: the exclusion test must cover message /
// next_action / transcript / refs.run_id / raw text, not just title/body/path).
const SENTINELS = Object.freeze([
  'SENTINEL-TITLE',
  'SENTINEL-BODY-local-never-egressed',
  'SENTINEL-MESSAGE-free-text',
  'SENTINEL-NEXTACTION-free-text',
  'SENTINEL-TRANSCRIPT-tail',
  '/SENTINEL/local/only/path',
  'SENTINEL-RUNID',
]);

// A host-woven event carrying the §4 routing fields + secret/free-text LOCAL
// fields (title, body, message, next_action, transcript, refs.path, refs.run_id)
// that MUST NOT egress (§2f/§3). Only kind + hostname + topic + session_hint +
// refs.workflow_id/phase are enumerated.
function egressEvent(overrides = {}) {
  return {
    event_id: buildId('accept-repo', 'approval', 'host-mba:session:s1:aaaa', 'fired'),
    source: 'attention-claude',
    kind: 'approval',
    title: 'Approval needed — SENTINEL-TITLE',
    body: 'SENTINEL-BODY-local-never-egressed',
    message: 'SENTINEL-MESSAGE-free-text',
    next_action: 'SENTINEL-NEXTACTION-free-text',
    transcript: 'SENTINEL-TRANSCRIPT-tail',
    urgency: 'urgent',
    hostname: 'mba',
    topic: 'repo:main',
    session_hint: 'sess12',
    refs: { workflow_id: 'wf-1', phase: 'phase-3', path: '/SENTINEL/local/only/path', run_id: 'SENTINEL-RUNID' },
    ...overrides,
  };
}

// The EXACT plain-text an egressEvent renders to — only the enumerated §3 fields,
// in renderEgressText order. An exact-match assertion is far stronger than a set
// of loose "includes" regexes (peer MAJOR): any extra field leaking in makes the
// string longer and fails.
const EXPECTED_EGRESS_TEXT = 'approval · @mba · repo:main · wf wf-1/phase-3 · sess12';

// The operator-environment activation triple (§2c). Any key can be dropped via
// an explicit `undefined` override to exercise a missing-input path.
function egressEnv(overrides = {}) {
  const base = {
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
  };
  const merged = { ...base, ...overrides };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged;
}

// Synchronous real-CLI emit (fail-closed contract: exit 0 always, stdout empty
// always). `env` is the FULL subprocess env (HOME + egress vars). No fetch can
// be injected here by design -- callers keep the token missing/invalid so the
// real notify.mjs never opens a socket.
function emitCli(root, ev, env) {
  return spawnSync(process.execPath, [NOTIFY_CLI, 'emit', '--repo-root', root], {
    input: `${JSON.stringify(ev)}\n`,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// A fetchImpl double (the §2b injection seam, mirroring the spawnImpl
// precedent). Records every (url, init) and returns/throws a configurable
// outcome. `respond(callNumber)` maps to { status, ok } or an Error to throw.
function fakeFetch(calls, respond = () => ({ status: 200, ok: true })) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = respond(calls.length);
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => ({ ok: r.ok }) };
  };
}

function timeoutError() {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
}

// A native node:https socket timeout surfaces as a system Error with
// code:'ETIMEDOUT' (name 'Error') -- NOT a TimeoutError; classifyTelegramError maps
// it to TIMEOUT all the same (§2d transport). ENOTFOUND/ECONNREFUSED (a reachable-
// but-broken or absent transport) is instead a plain provider error. A redirect-
// mentioning rejection classifies REDIRECT_ERROR (node:https never follows a
// redirect, so this arises only from an error message, never a real 3xx follow).
function etimedoutError() {
  const e = new Error('connect ETIMEDOUT 149.154.167.220:443');
  e.code = 'ETIMEDOUT';
  return e;
}
function transportAbsentError() {
  const e = new Error('getaddrinfo ENOTFOUND api.telegram.org');
  e.code = 'ENOTFOUND';
  return e;
}
function redirectError() {
  return new TypeError('unexpected redirect response from api.telegram.org');
}

// A spawnImpl double (the local §2 osascript channel seam, mirroring
// test-notify.mjs's fakeSpawn): records every (cmd, args, opts) a would-be child
// receives so an argv/child-env token scan can prove the credential never rides a
// spawned process. Returns a minimal detached-child stub so notify's fire-and-
// forget contract (child.on / child.unref) is satisfied.
function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() { return this; }, unref() {} };
  };
}

// The frozen clock the injection-dependent gates share (matches (A)/(D)'s NOW).
const ACCEPT_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

// Drive the REAL runEmit egress pipeline with an injected transport double --
// hoisted so the (H)/(I)/(J) deterministic gates below reuse the exact (A)/(D)
// injection shape instead of redefining it per block.
function emitEgress({
  root, home, env = egressEnv(), calls = [], respond, event = egressEvent(), now = ACCEPT_NOW, spawnImpl,
} = {}) {
  return runEmit({
    eventText: JSON.stringify(event),
    repoRoot: root,
    homeDir: home ?? fixtureHome(),
    now,
    env,
    fetchImpl: fakeFetch(calls, respond),
    ...(spawnImpl ? { spawnImpl } : {}),
  });
}

function readLog(root) {
  try {
    return readFileSync(join(root, LOG_REL), 'utf8')
      .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function egressRows(root) {
  return readLog(root).filter((r) => typeof r.egress_channel === 'string');
}

function countFiles(root, rel, suffix) {
  try {
    return readdirSync(join(root, rel)).filter((n) => n.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}
const claimCount = (root) => countFiles(root, DEDUPE_REL, '.claim');
const throttleCount = (root) => countFiles(root, THROTTLE_REL, '.throttle');

// The whole persisted notify-state tree as one string -- for the "escapes to
// NOWHERE" scan (log + every dedupe claim body + every throttle record body).
function dumpNotifyState(root) {
  const parts = [];
  const dir = join(root, NOTIFY_DIR_REL);
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { parts.push(readFileSync(p, 'utf8')); } catch { /* skip */ } }
    }
  };
  walk(dir);
  return parts.join('\n');
}

// The EGRESS ARTIFACTS only: the attempt-mirror log + the throttle records.
// Deliberately EXCLUDES the dedupe-claim files. The dedupe claim is ADR-0040
// LOCAL infrastructure that stores the raw event_id verbatim (for debuggability
// + the dashboard's per-event inspect) and NEVER egresses — the egress payload
// (buildEgressPayload) provably excludes event_id, the mirror scrubs it, and the
// throttle stores a hash. So a token-shaped event_id is an egress non-issue: this
// scan proves the token never reaches anything egress-derived, without asserting
// a false claim about ADR-0040's local claim format (peer finding: correctly
// scoped to the egress threat model — a secret LEAVING the machine).
function dumpEgressArtifacts(root) {
  const parts = [];
  const log = readLogRaw(root);
  if (log) parts.push(log);
  let throttleNames;
  try { throttleNames = readdirSync(join(root, THROTTLE_REL)); } catch { throttleNames = []; }
  for (const name of throttleNames) {
    try { parts.push(readFileSync(join(root, THROTTLE_REL, name), 'utf8')); } catch { /* skip */ }
  }
  return parts.join('\n');
}

function readLogRaw(root) {
  try { return readFileSync(join(root, LOG_REL), 'utf8'); } catch { return null; }
}

// Every relative PATH (dir + file NAME) under the notify state tree, joined -- for a
// FILENAME leak scan (peer MAJOR: dumpNotifyState / dumpEgressArtifacts read file
// CONTENTS only; a token embedded in a claim / throttle / log FILENAME would slip
// past a content-only scan). State filenames are hashes today, so this is a
// forward-looking tripwire against a future name scheme embedding cleartext.
function dumpNotifyPaths(root) {
  const names = [];
  const base = join(root, NOTIFY_DIR_REL);
  const walk = (d, rel) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      names.push(join(rel, e.name));
      if (e.isDirectory()) walk(join(d, e.name), join(rel, e.name));
    }
  };
  walk(base, NOTIFY_DIR_REL);
  return names.join('\n');
}

// Assert a captured surface (content OR a joined filename list) carries NO token
// material: the full token, the high-entropy SECRET fragment, AND the bot-id. The
// secret fragment is the load-bearing witness (a suffix-only leak); the full token
// and bot-id are belt-and-suspenders. None of the scanned surfaces legitimately
// carries FAKE_CHAT_ID (which embeds the bot-id), so the bot-id check does not
// false-positive here.
function assertNoTokenLeak(haystack, where) {
  ok(!haystack.includes(FAKE_TOKEN), `the full token must NOT appear in ${where}`);
  ok(!haystack.includes(TOKEN_SECRET_FRAGMENT), `the token SECRET (auth half) must NOT appear in ${where}`);
  ok(!haystack.includes(TOKEN_BOT_ID), `not even the bot-id fragment must appear in ${where}`);
}

function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

// Poll for a detached producer's egress mirror row (the Codex shuttle spawns
// notify.mjs detached + unref'd, so the row lands asynchronously after the
// shuttle process exits).
async function pollEgressRows(root, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = egressRows(root);
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await sleep(intervalMs);
  }
}

// Render the Codex shuttle template into a runnable script: substitute the
// MIN-runtime-version placeholder (quotes included, per notification-plan's
// substituteOnce token) with 0.0.0 so any real runtime passes the version gate.
function renderShuttle() {
  const template = readFileSync(SHUTTLE_TEMPLATE, 'utf8');
  const token = "'__AGENTIC_MIN_RUNTIME_VERSION__'";
  ok(template.includes(token), 'the shuttle template carries the MIN-version placeholder');
  const rendered = template.replace(token, "'0.0.0'");
  const dir = tmp('shuttle');
  const file = join(dir, 'codex-notify-shuttle.mjs');
  writeFileSync(file, rendered);
  return file;
}

// ===========================================================================
// (A) §2b/§2f/§3/§5 -- the ONE pinned request: URL/method/redirect, enumerated
//     body only, and a fake token that escapes to NOWHERE. Injection-dependent
//     (runEmit + fetchImpl); a fake token is captured but never sent.
// ===========================================================================

describe('ADR-0041 acceptance (A) -- the one pinned request through the real runEmit pipeline', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  async function emit({ root, home, env = egressEnv(), calls = [], respond, event = egressEvent(), now = NOW }) {
    return runEmit({
      eventText: JSON.stringify(event),
      repoRoot: root,
      homeDir: home ?? fixtureHome(),
      now,
      env,
      fetchImpl: fakeFetch(calls, respond),
    });
  }

  it('§2b/§2d -- an active machine issues EXACTLY the pinned POST (fake token, node:https shape, bounded)', async () => {
    const root = markerRepo('A-pinned');
    const calls = [];
    const result = await emit({ root, calls });
    deepStrictEqual(
      { status: result.status, stage: result.stage, channel: result.channel },
      { status: 'dispatched', stage: 'egress', channel: 'telegram' },
    );
    strictEqual(calls.length, 1, 'exactly one request');
    const { url, init } = calls[0];
    strictEqual(url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`, 'the fully-pinned URL');
    strictEqual(init.method, 'POST');
    // node:https shape (§2d): the reworked injection seam mirrors the real
    // https.request options. There is NO fetch `redirect` key -- node:https never
    // follows redirects, so egress-bounding is STRUCTURAL (the executor guard's
    // maxCalls:1 single call site — a Location would need a forbidden second
    // request), not a `redirect:'error'` option. A content-length header pins the
    // exact body byte length, exactly as the real transport sends it.
    ok(!('redirect' in init), 'no fetch redirect option -- redirects are bounded structurally, not via init');
    strictEqual(init.headers['content-type'], 'application/json');
    strictEqual(init.headers['content-length'], Buffer.byteLength(init.body), 'content-length matches the POST body (node:https shape)');
    ok(init.signal && typeof init.signal === 'object' && 'aborted' in init.signal, 'a bounded AbortSignal (§2e)');
  });

  it('§2f/§3 -- the egress body is EXACTLY the enumerated render; every non-enumerated field is excluded', async () => {
    const root = markerRepo('A-enum');
    const calls = [];
    await emit({ root, calls });
    const body = JSON.parse(calls[0].init.body);
    deepStrictEqual(Object.keys(body).sort(), ['chat_id', 'text'], 'no free-form keys');
    strictEqual(body.chat_id, FAKE_CHAT_ID);
    // Exact-match (not loose regexes): only the enumerated §3 fields, in order.
    // Any extra field leaking in would lengthen this string and fail.
    strictEqual(body.text, EXPECTED_EGRESS_TEXT, 'the body text is EXACTLY the enumerated render');
    // Belt: every non-enumerated sentinel (title/body/message/next_action/
    // transcript/refs.path/refs.run_id) is structurally absent from body + state.
    const state = dumpNotifyState(root);
    for (const sentinel of SENTINELS) {
      ok(!body.text.includes(sentinel), `${sentinel} must never egress in the body`);
      ok(!state.includes(sentinel), `${sentinel} must never land in any notify state`);
    }
  });

  it('§2b/§5 -- the fake token escapes to NOWHERE in the persisted notify state (log + claims + throttle)', async () => {
    const root = markerRepo('A-noleak');
    // Include a credential-URL in an enumerated field (§5 scrub) + drive a
    // dispatched success (writes a claim + a mirror row).
    const event = egressEvent({ topic: 'https://user:supersecretpw@host.example/x' });
    const calls = [];
    await emit({ root, calls, event });
    const body = JSON.parse(calls[0].init.body);
    ok(!body.text.includes('supersecretpw'), 'the credential-URL is scrubbed from the egress body (§5)');
    ok(/\[redacted\]/.test(body.text), 'the scrub left a redaction marker');
    // The token was sent (captured by fakeFetch) but must not persist anywhere.
    const state = dumpNotifyState(root);
    ok(state.length > 0, 'notify state was written (a mirror row exists)');
    ok(!state.includes(FAKE_TOKEN), 'the full token never lands in persisted state');
    ok(!state.includes(TOKEN_BOT_ID), 'not even a token fragment lands in persisted state');
    ok(!state.includes('supersecretpw'), 'no scrubbed secret lands in persisted state');
  });

  it('§5 -- a secret that CROSSES the field cap is still scrubbed (scrub-before-cap), not leaked as a fragment', async () => {
    const root = markerRepo('A-truncsecret');
    // A credential URL positioned so the topic cap (120) would truncate it
    // mid-credential -- the `@` falls PAST the cap. A scrub applied AFTER the cap
    // (the peer-caught CRITICAL) would see `...u:TRUNCSECR` with no `@`, match no
    // pattern, and leak the fragment; scrub-BEFORE-cap redacts the intact URL
    // first, so nothing survives the cap.
    const event = egressEvent({ topic: `${'x'.repeat(100)} https://u:TRUNCSECRETVALUE@host.example/p` });
    const calls = [];
    await emit({ root, calls, event });
    const body = JSON.parse(calls[0].init.body);
    ok(!body.text.includes('TRUNCSECR'), 'no truncated secret fragment survives into the egress body');
    // The mirror caps the same routing field -- the same scrub-before-cap must
    // protect it. Scan ALL persisted state (mirror + claims + throttle).
    ok(!dumpNotifyState(root).includes('TRUNCSECR'), 'no truncated secret fragment lands in any notify state');
  });

  it('§2b/§3 -- a token-shaped event_id never reaches the egress body or any egress artifact (mirror/throttle)', async () => {
    const root = markerRepo('A-tokenid');
    // A malformed producer parks token-shaped material in a syntactically-valid
    // event_id subject. The egress payload (buildEgressPayload) provably EXCLUDES
    // event_id, the mirror scrubs it, and the throttle stores a hash -- so it
    // never leaves the machine. (The ADR-0040 dedupe CLAIM stores the raw
    // event_id verbatim for local debuggability; it never egresses, so it is
    // outside E1's threat model and outside this egress-artifact scan -- see
    // dumpEgressArtifacts.)
    const tokenSubject = 'tok:987654321:AAA_bbbCCCdddEEEfffGGGhhhIIIjjjKKK';
    const event = egressEvent({ event_id: buildId('accept-repo', 'approval', tokenSubject, 'fired') });
    const calls = [];
    // Drive a provider FAILURE so a throttle record is also written (proving the
    // throttle key carries no raw token either).
    const result = await emit({ root, calls, event, respond: () => ({ status: 500, ok: false }) });
    strictEqual(result.status, 'failed');
    const body = JSON.parse(calls[0].init.body);
    ok(!body.text.includes('AAA_bbbCCCddd'), 'event_id is excluded from the egress body entirely');
    ok(!body.text.includes('987654321'), 'no token-shaped fragment in the egress body');
    const artifacts = dumpEgressArtifacts(root);
    ok(artifacts.length > 0, 'egress artifacts were written (mirror + throttle)');
    ok(!artifacts.includes('AAA_bbbCCCddd'), 'the token-shaped event_id is scrubbed/hashed out of every egress artifact');
    ok(throttleCount(root) >= 1, 'a throttle record exists (its identity is a hash, carrying no raw event_id)');
  });
});

// ===========================================================================
// (B) §2a -- no operator input can name a destination URL.
// ===========================================================================

describe('ADR-0041 acceptance (B) -- a user-supplied URL can never become a destination (real CLI)', () => {
  it('an arbitrary/self-host URL in the channel key is rejected (engaged-but-invalid, no request)', () => {
    const root = markerRepo('B-url-channel');
    const home = fixtureHome();
    // The activation "channel" is a fixed ENUM (telegram-only). A URL is not in
    // it -> unknown-egress-channel -> mirrored suppression, never a dispatch.
    const env = {
      ...process.env, HOME: home,
      AGENTIC_NOTIFY_EGRESS_CHANNEL: 'https://evil.example/webhook',
      TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    };
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    strictEqual(res.stdout, '', 'fail-closed silent');
    const rows = egressRows(root);
    strictEqual(rows.length, 1, 'the invalid activation is mirrored (attempt-visible)');
    strictEqual(rows[0].egress_status, 'suppressed');
    strictEqual(rows[0].egress_outcome, 'invalid-local-activation');
    // The URL must never be persisted as a destination anywhere.
    ok(!dumpNotifyState(root).includes('evil.example'), 'the rejected URL never lands in notify state');
  });

  it('a URL-shaped recipient (chat-id) is shape-rejected, never interpolated or sent', () => {
    const root = markerRepo('B-url-recipient');
    const home = fixtureHome();
    const env = {
      ...process.env, HOME: home,
      AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
      TELEGRAM_CHAT_ID: 'https://evil.example/webhook',
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    };
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = egressRows(root);
    strictEqual(rows.length, 1);
    strictEqual(rows[0].egress_outcome, 'invalid-local-activation', 'a malformed recipient never yields a send');
    ok(!dumpNotifyState(root).includes('evil.example'), 'the URL-shaped recipient never lands in notify state');
  });
});

// ===========================================================================
// (C) §2c -- activation matrix: env / verified-local only; token alone inert;
//     tracked + repo-local config never activate. Real CLI + real filesystem.
// ===========================================================================

describe('ADR-0041 acceptance (C) -- activation only from env or verified-ignored-local (real CLI + fs)', () => {
  // A missing token keeps every real-subprocess path network-free: activation
  // ENGAGES (channel + recipient resolve) but resolves missing-credential BEFORE
  // the pinned request, so the acceptance signal is the egress mirror row.
  it('c1 -- a token ALONE never activates: no channel key => local pipeline runs, no egress', () => {
    const root = markerRepo('C-token-alone');
    const home = fixtureHome();
    writeConfig(root, { notify_channel: 'file-log' });
    const env = { ...process.env, HOME: home, TELEGRAM_BOT_TOKEN: FAKE_TOKEN }; // token only
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = readLog(root);
    strictEqual(rows.length, 1, 'the local channel dispatched');
    ok(!('egress_status' in rows[0]), 'a token alone is inert -- no egress engaged');
  });

  it('c2 -- env activation ENGAGES egress and OVERRIDES the local channel (no local record)', () => {
    const root = markerRepo('C-env');
    const home = fixtureHome();
    writeConfig(root, { notify_channel: 'file-log' });
    // Channel + recipient from env; NO token -> engaged, missing-credential.
    const env = {
      ...process.env, HOME: home,
      AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
    };
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = readLog(root);
    strictEqual(rows.length, 1, 'exactly one row -- egress overrode the local file-log');
    strictEqual(rows[0].egress_channel, 'telegram', 'the engaged egress owns the emit');
    strictEqual(rows[0].egress_outcome, 'missing-token');
  });

  it('c3 -- a verified user-home config.local.toml activates egress (the §10 happy path, real fs reader)', () => {
    const root = markerRepo('C-verified-local');
    const home = fixtureHome();
    writeConfig(root, { notify_channel: 'none' });
    // Activation + recipient come ONLY from the user-home verified-local file;
    // env carries NO egress vars at all. If the reader did not honor the file,
    // egress would not engage and no egress row would appear.
    writeVerifiedLocal(home, { egress_channel: 'telegram', egress_chat_id: FAKE_CHAT_ID });
    const env = { ...process.env, HOME: home };
    delete env.AGENTIC_NOTIFY_EGRESS_CHANNEL;
    delete env.TELEGRAM_CHAT_ID;
    delete env.TELEGRAM_BOT_TOKEN;
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = egressRows(root);
    strictEqual(rows.length, 1, 'the verified-ignored-local file engaged egress end-to-end');
    strictEqual(rows[0].egress_channel, 'telegram');
    strictEqual(rows[0].egress_outcome, 'missing-token', 'engaged from the local file, no token => missing-token');
  });

  it('c4 -- egress keys in TRACKED repo config.toml are inert (no repo-controlled activation vector)', () => {
    const root = markerRepo('C-tracked');
    const home = fixtureHome();
    // A hostile/tracked repo tries to activate egress via config.toml + names a
    // recipient. The egress loader never reads repo config.toml, so this is inert.
    writeConfig(root, {
      notify_channel: 'file-log',
      egress_channel: 'telegram',
      egress_chat_id: FAKE_CHAT_ID,
    });
    // INVALID (present but shape-invalid) token: if this guard REGRESSED and the
    // tracked config were honored, egress would engage -- and resolve to
    // invalid-local-activation BEFORE any socket, surfacing the bug as a mirror
    // row (egress_status present) rather than a real request to Telegram (peer
    // MAJOR: a valid token here could open a real socket on regression).
    const env = { ...process.env, HOME: home, TELEGRAM_BOT_TOKEN: INVALID_TOKEN };
    delete env.AGENTIC_NOTIFY_EGRESS_CHANNEL;
    delete env.TELEGRAM_CHAT_ID;
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = readLog(root);
    strictEqual(rows.length, 1);
    ok(!('egress_status' in rows[0]), 'tracked config.toml can NEVER activate egress -- local channel only');
  });

  it('c5 -- HOME-is-the-repo: an INSIDE-repo config.local.toml is fail-closed rejected (hostile-clone defense)', () => {
    const root = markerRepo('C-home-is-repo');
    // The devcontainer/CI threat: HOME === the repo root, so a cloned repo's
    // tracked config.local.toml would sit at the verified-local path. The reader
    // must refuse it (inside-repo) so a hostile clone cannot activate egress.
    writeConfig(root, { notify_channel: 'file-log' });
    writeVerifiedLocal(root, { egress_channel: 'telegram', egress_chat_id: FAKE_CHAT_ID });
    // INVALID token (see c4): network-free even if the inside-repo guard regressed.
    const env = { ...process.env, HOME: root, TELEGRAM_BOT_TOKEN: INVALID_TOKEN };
    delete env.AGENTIC_NOTIFY_EGRESS_CHANNEL;
    delete env.TELEGRAM_CHAT_ID;
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = readLog(root);
    strictEqual(rows.length, 1);
    ok(!('egress_status' in rows[0]), 'an inside-repo config.local.toml must NOT activate egress');
  });

  it('c6 -- the verified-local recipient COMBINES with the env token for a real pinned send (runEmit + fetchImpl)', async () => {
    // c3 proves the local file ENGAGES egress; this proves the local recipient is
    // actually COMBINED with the env token into a real request -- a bug that reads
    // the file enough to mark engaged but drops its chat id would pass c3 as
    // missing/absent yet fail here (peer MAJOR). Injection-dependent (a valid fake
    // token would otherwise open a real socket) -> runEmit({ fetchImpl }).
    const root = markerRepo('C-local-send');
    const home = fixtureHome();
    // Recipient ONLY in the verified-local file (a value distinct from any env
    // default); token ONLY in env; activation channel from the file.
    writeVerifiedLocal(home, { egress_channel: 'telegram', egress_chat_id: LOCAL_CHAT_ID });
    const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN }; // token only; channel+recipient from the file
    const calls = [];
    const result = await runEmit({
      eventText: JSON.stringify(egressEvent()),
      repoRoot: root,
      homeDir: home,
      now: Date.UTC(2026, 0, 15, 12, 0, 0),
      env,
      fetchImpl: fakeFetch(calls),
    });
    strictEqual(result.status, 'dispatched', 'the file recipient + env token combined into a real send');
    strictEqual(calls.length, 1, 'exactly one pinned request');
    strictEqual(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`, 'the env token pinned the URL');
    strictEqual(JSON.parse(calls[0].init.body).chat_id, LOCAL_CHAT_ID, 'the chat_id came from the verified-local FILE, not env');
  });
});

// ===========================================================================
// (D) §6/§7 -- attempt-mirror + the E1 amendment to ADR-0040 dedupe persistence,
//     observed as DURABLE state (claims / throttle / mirror). Called out by the
//     ADR for acceptance so §7 and ADR-0040's dedupe do not read as contradictory.
// ===========================================================================

describe('ADR-0041 acceptance (D) -- attempt-mirror + dedupe-failure taxonomy as durable state', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  async function emit({ root, home, env = egressEnv(), calls = [], respond, event = egressEvent(), now = NOW }) {
    return runEmit({
      eventText: JSON.stringify(event),
      repoRoot: root,
      homeDir: home ?? fixtureHome(),
      now,
      env,
      fetchImpl: fakeFetch(calls, respond),
    });
  }

  it('§6 -- a missing-token attempt mirrors a sanitized row, RELEASES the claim, records the throttle (real CLI)', () => {
    const root = markerRepo('D-mirror');
    const home = fixtureHome();
    // Real fire-and-forget CLI; channel + recipient set, no token -> network-free.
    const env = {
      ...process.env, HOME: home,
      AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
    };
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0);
    const rows = egressRows(root);
    strictEqual(rows.length, 1);
    deepStrictEqual(
      {
        channel: rows[0].egress_channel,
        status: rows[0].egress_status,
        outcome: rows[0].egress_outcome,
        phase: rows[0].egress_phase,
      },
      { channel: 'telegram', status: 'suppressed', outcome: 'missing-token', phase: 'outcome' },
    );
    ok(!CONTROL_CHARS.test(JSON.stringify(rows[0])), 'the mirror row is control-sanitized');
    strictEqual(claimCount(root), 0, 'the pre-claim is RELEASED so a config fix re-fires (§7)');
    strictEqual(throttleCount(root), 1, 'a failure throttle is recorded (§7)');
  });

  it('§7 -- a failed dispatch RELEASES the claim; a later success within TTL still gets through (past cooldown)', async () => {
    const root = markerRepo('D-release-ttl');
    const home = fixtureHome();
    const calls = [];
    // Provider 5xx failure: releases the claim + records the throttle.
    const fail = await emit({ root, home, calls, respond: () => ({ status: 500, ok: false }) });
    strictEqual(fail.status, 'failed');
    strictEqual(claimCount(root), 0, 'a failed dispatch does NOT burn the success TTL');
    // Same event, PAST the cooldown -> throttle lapsed -> a genuine retry succeeds.
    const ok2 = await emit({ root, home, calls, now: NOW + 120_000, respond: () => ({ status: 200, ok: true }) });
    strictEqual(ok2.status, 'dispatched', 'the released claim let the later success through');
    strictEqual(calls.length, 2, 'two real attempts (the failure did not suppress the retry)');
    strictEqual(claimCount(root), 1, 'success PROMOTES the claim (now owns the TTL)');
  });

  it('§7 -- a repeated failure ENGAGES the throttle: the next event within cooldown is suppressed, NO request, NO mirror spam', async () => {
    const root = markerRepo('D-throttle');
    const home = fixtureHome();
    const calls = [];
    await emit({ root, home, calls, respond: () => ({ status: 500, ok: false }) });
    const mirrorsAfterFail = egressRows(root).length;
    // A NEW identical event 1s later: claim free, but the cooldown gates the retry.
    const throttled = await emit({ root, home, calls, now: NOW + 1000, respond: () => ({ status: 200, ok: true }) });
    strictEqual(throttled.status, 'suppressed');
    strictEqual(throttled.reason, 'egress-throttled');
    strictEqual(calls.length, 1, 'the throttle stopped a re-dispatch against a persistent failure');
    strictEqual(egressRows(root).length, mirrorsAfterFail, 'a per-event cooldown does not spam the file-log');
    strictEqual(claimCount(root), 0, 'the throttled attempt releases its claim for the post-cooldown retry');
  });

  it('§7 -- config-fix BYPASS: fixing the credential mints a new fingerprint that skips the cooldown', async () => {
    const root = markerRepo('D-bypass');
    const home = fixtureHome();
    const calls = [];
    await emit({ root, home, calls, respond: () => ({ status: 500, ok: false }) });
    // Same event, STILL within cooldown, but the operator fixed the token: the
    // (event+service+fingerprint) key changes -> not throttled -> re-attempts.
    const fixed = await emit({
      root, home, calls, now: NOW + 1000,
      env: egressEnv({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN_FIXED }),
      respond: () => ({ status: 200, ok: true }),
    });
    strictEqual(fixed.status, 'dispatched', 'a credential change bypassed the cooldown');
    strictEqual(calls.length, 2, 'the fix produced a genuine second attempt');
  });

  it('§7 -- a timeout is a caught FAILURE (never thrown on the hook path), claim released, throttle recorded', async () => {
    const root = markerRepo('D-timeout');
    const home = fixtureHome();
    const calls = [];
    const result = await emit({ root, home, calls, respond: () => timeoutError() });
    strictEqual(result.status, 'failed');
    strictEqual(result.reason, 'egress-timeout');
    strictEqual(claimCount(root), 0, 'a timeout releases the claim (retryable after fix)');
    strictEqual(throttleCount(root), 1);
    strictEqual(egressRows(root)[0].egress_status, 'failed');
  });
});

// ===========================================================================
// (E) cross-host -- ONE channel serves BOTH hosts: the REAL Claude Notification
//     sensor AND the REAL rendered Codex notify= shuttle each reach a telegram
//     egress attempt through the REAL emitter. Network-free (no token).
// ===========================================================================

describe('ADR-0041 acceptance (E) -- one channel serves both host producers (real sensor + real shuttle)', () => {
  // Egress env WITHOUT a token: activation engages (channel + recipient) but the
  // real notify.mjs resolves missing-credential BEFORE the pinned request -> no
  // socket. The acceptance signal is the mirrored telegram attempt.
  function producerEnv(home, extra = {}) {
    const env = {
      ...process.env,
      HOME: home,
      AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT,
      AGENTIC_NOTIFY_HOSTNAME: 'accept-host',
      AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
      TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
      ...extra,
    };
    delete env.TELEGRAM_BOT_TOKEN;
    return env;
  }

  it('the REAL Claude attention Notification sensor drives a telegram egress attempt (host-woven hostname mirrored)', () => {
    const root = markerRepo('E-claude');
    const home = fixtureHome();
    const payload = {
      cwd: root,
      session_id: 'sess-claude-1',
      notification_type: 'permission_prompt',
      message: 'Allow write to config?',
    };
    const res = spawnSync(process.execPath, [NOTIFICATION_SENSOR], {
      input: JSON.stringify(payload),
      env: producerEnv(home),
      encoding: 'utf8',
      timeout: 30_000,
    });
    // The sensor's emitEvent uses spawnSync (synchronous) -> the mirror is
    // written before the sensor process exits; no polling needed.
    strictEqual(res.status, 0, `sensor must be fail-closed exit 0; stderr:\n${res.stderr}`);
    const rows = egressRows(root);
    ok(rows.length >= 1, `a telegram egress attempt was mirrored; sensor stderr:\n${res.stderr}`);
    strictEqual(rows[0].egress_channel, 'telegram');
    strictEqual(rows[0].kind, 'approval', 'the real approval event drove the egress');
    strictEqual(rows[0].hostname, 'accept-host', 'the §4 host-woven routing field rides the mirror');
    ok(!dumpNotifyState(root).includes('Allow write to config?'), 'the approval message (local body) never egresses/persists in an egress artifact');
  });

  it('the REAL rendered Codex notify= shuttle drives a telegram egress attempt through the same emitter', async () => {
    const root = markerRepo('E-codex');
    const home = fixtureHome();
    const shuttle = renderShuttle();
    const payload = {
      type: 'agent-turn-complete',
      'turn-id': 'turn-42',
      'input-messages': ['hi'],
      'last-assistant-message': 'done',
    };
    // The shuttle resolves the repo by walking cwd -> .git, so run it FROM the
    // repo. It spawns notify.mjs DETACHED + unref'd, so poll for the mirror row.
    const res = spawnSync(process.execPath, [shuttle, JSON.stringify(payload)], {
      cwd: root,
      env: producerEnv(home),
      encoding: 'utf8',
      timeout: 30_000,
    });
    strictEqual(res.status, 0, `the shuttle is fail-closed exit 0; stderr:\n${res.stderr}`);
    const rows = await pollEgressRows(root);
    ok(rows.length >= 1, `the Codex shuttle drove a telegram egress attempt; shuttle stderr:\n${res.stderr}`);
    strictEqual(rows[0].egress_channel, 'telegram', 'the same channel serves the Codex host');
    strictEqual(rows[0].kind, 'turn-complete', 'the real codex-notify turn-complete event drove the egress');
  });
});

// ===========================================================================
// (E2) §4/§8 cross-machine identity -- hostname weaves into the event_id so two
//      machines converging on ONE chat stay DISTINCT (not deduped into one),
//      while the same machine/session dedupes. Proven black-box through the REAL
//      attention sensor. The event_id is channel-agnostic (the sensor builds it
//      identically for local + egress), so the deterministic file-log channel
//      proves the SAME dedupe key that egress rides -- a promoted claim the
//      network-free missing-token egress path cannot exercise (it releases).
// ===========================================================================

describe('ADR-0041 acceptance (E2) -- hostname weaves into event_id for cross-machine distinctness', () => {
  it('two machines (same repo/session/message, different hostname) stay DISTINCT; the same machine dedupes', () => {
    const root = markerRepo('E2-hostid');
    const home = fixtureHome();
    writeConfig(root, { notify_channel: 'file-log' });
    // Identical hook payload on every "machine" -- only AGENTIC_NOTIFY_HOSTNAME
    // differs, exactly the multi-machine ssh+tmux case (§8).
    const payload = { cwd: root, session_id: 'sess-shared', notification_type: 'permission_prompt', message: 'identical approval' };
    const run = (hostname) => spawnSync(process.execPath, [NOTIFICATION_SENSOR], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT, AGENTIC_NOTIFY_HOSTNAME: hostname },
      encoding: 'utf8',
      timeout: 30_000,
    });
    strictEqual(run('machine-A').status, 0);
    strictEqual(run('machine-B').status, 0);
    let rows = readLog(root);
    strictEqual(rows.length, 2, 'two machines -> two notifications (hostname prevents cross-machine dedupe, §8)');
    ok(
      rows[0].event_id !== rows[1].event_id,
      'the hostname is woven into the event_id -- if it were removed from buildEventId these would collide',
    );
    // Machine A fires AGAIN (identical session/message/hostname): the SAME
    // event_id -> the ADR-0040 dedupe suppresses it (the key incorporates hostname).
    strictEqual(run('machine-A').status, 0);
    rows = readLog(root);
    strictEqual(rows.length, 2, 'the same machine/session dedupes -- A repeats collapse onto the first A claim');
  });
});

// ===========================================================================
// (H) the credential leaks to NOWHERE -- a deterministic SCAN (not a review) of the
//     captured argv / stderr / artifacts / state (§2b/§5). The transport double
//     never opens a socket, so a fake token can ride the pipeline end-to-end while
//     every surface an operator or `ps` could observe is asserted token-free.
// ===========================================================================

describe('ADR-0041 acceptance (H) -- the credential leaks to NOWHERE (scan argv/stderr/artifacts/state)', () => {
  it('H1 -- a real CLI attempt carrying a VALID token in env never emits it to argv, stdout, or stderr', () => {
    const root = markerRepo('H-cli');
    const home = fixtureHome();
    // A VALID-shape token (a real scan target) but NO recipient -> the engaged egress
    // resolves MISSING-RECIPIENT before the pinned request, so the real notify.mjs is
    // network-free while the token rides the whole subprocess (env + in-memory only).
    // The module-load scrub above guarantees the ambient env carries no real token.
    const argv = [NOTIFY_CLI, 'emit', '--repo-root', root];
    const env = { ...process.env, HOME: home, AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_BOT_TOKEN: FAKE_TOKEN };
    delete env.TELEGRAM_CHAT_ID;
    const res = spawnSync(process.execPath, argv, {
      input: `${JSON.stringify(egressEvent())}\n`, env, encoding: 'utf8', timeout: 30_000,
    });
    strictEqual(res.status, 0, `fail-closed exit 0; stderr:\n${res.stderr}`);
    strictEqual(res.stdout, '', 'stdout is always empty (fail-closed silent)');
    // argv scan: the token rides the ENV only -- never the command line (where `ps`
    // would expose it). We construct argv, so this is a standing regression tripwire.
    assertNoTokenLeak(argv.join('\n'), 'the process argv');
    // stderr scan: at most one truncated reason line, never the credential.
    assertNoTokenLeak(res.stderr, 'stderr');
    // the attempt WAS mirrored -- and pin the SPECIFIC outcome (peer: coarse
    // 'suppressed' also matches missing-token / invalid-activation, so assert the
    // missing-RECIPIENT path actually ran, not merely some suppression).
    const rows = egressRows(root);
    strictEqual(rows.length, 1, 'the engaged, network-free attempt was mirrored');
    strictEqual(rows[0].egress_status, 'suppressed', 'a missing recipient is a suppressed attempt');
    strictEqual(rows[0].egress_outcome, 'missing-recipient', 'the valid-token + no-recipient path resolved missing-recipient');
    // ...and neither the full token, its secret half, nor the bot-id landed in the
    // persisted state -- scanning BOTH file contents AND file NAMES.
    assertNoTokenLeak(dumpNotifyState(root), 'persisted notify state (contents)');
    assertNoTokenLeak(dumpNotifyPaths(root), 'persisted notify state (filenames)');
  });

  it("H2 -- the env token never rides a SPAWNED child's argv or its sanitized env (fake spawn capture)", async () => {
    const root = markerRepo('H-spawn');
    const home = fixtureHome();
    // Egress NOT engaged (no channel key), so the LOCAL macos-osascript channel runs
    // and spawns a child. The token is in env; capture the spawn and prove it reaches
    // neither the child argv nor the SPAWN_ENV_ALLOWLIST-sanitized child env.
    writeConfig(root, { notify_channel: 'macos-osascript' });
    const spawnCalls = [];
    await runEmit({
      eventText: JSON.stringify(egressEvent()),
      repoRoot: root,
      homeDir: home,
      now: ACCEPT_NOW,
      env: { HOME: home, TELEGRAM_BOT_TOKEN: FAKE_TOKEN },
      spawnImpl: fakeSpawn(spawnCalls),
    });
    ok(spawnCalls.length >= 1, 'the local osascript channel spawned a child');
    for (const c of spawnCalls) {
      // JSON.stringify covers object KEYS and values, so a token-as-key is caught too.
      assertNoTokenLeak(JSON.stringify(c.args), "the spawned child's argv");
      assertNoTokenLeak(JSON.stringify(c.opts?.env ?? {}), "the spawned child's env (SPAWN_ENV_ALLOWLIST excludes the token)");
    }
  });

  it('H3 -- a dispatched success with a fake token persists NO token to any egress artifact or state', async () => {
    const root = markerRepo('H-success');
    const calls = [];
    // A real dispatched success writes a mirror row + promotes a claim; the token was
    // captured by the double (in the pinned URL) but must persist NOWHERE.
    const result = await emitEgress({ root, calls });
    strictEqual(result.status, 'dispatched');
    strictEqual(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`, 'the token was in the captured (un-sent) URL');
    const artifacts = dumpEgressArtifacts(root);
    ok(artifacts.length > 0, 'egress artifacts were written (a mirror row exists)');
    assertNoTokenLeak(artifacts, 'any egress artifact');
    assertNoTokenLeak(dumpNotifyState(root), 'any persisted state (contents)');
    assertNoTokenLeak(dumpNotifyPaths(root), 'any persisted state (filenames)');
  });
});

// ===========================================================================
// (I) transport failure is FAIL-CLOSED -- a thrown or absent transport degrades to a
//     recorded outcome (never a throw, never a wedged hook path, §2e). Injection-
//     dependent: a double models the failure a real broken socket would surface.
// ===========================================================================

describe('ADR-0041 acceptance (I) -- a failing/absent transport is fail-closed (degrades, never throws)', () => {
  it('I1 -- a transport that THROWS (unreachable/absent) resolves failed, RELEASES the claim, records the throttle, mirrors failed', async () => {
    const root = markerRepo('I-throw');
    const calls = [];
    const result = await emitEgress({ root, calls, respond: () => transportAbsentError() });
    strictEqual(result.status, 'failed', 'a thrown transport error never escapes -- it degrades to failed');
    strictEqual(result.reason, 'egress-provider-error');
    strictEqual(calls.length, 1, 'the one bounded attempt ran');
    strictEqual(claimCount(root), 0, 'the claim is RELEASED (retryable after fix)');
    strictEqual(throttleCount(root), 1, 'a failure throttle is recorded');
    const row = egressRows(root)[0];
    strictEqual(row.egress_status, 'failed');
    strictEqual(row.egress_outcome, 'provider-error');
  });

  it('I2 -- the fire-and-forget CLI stays fail-closed (exit 0, empty stdout) on a mirrored failure', () => {
    const root = markerRepo('I-cli');
    const home = fixtureHome();
    // The real CLI cannot inject a transport, so keep it network-free (no token) and
    // assert the fail-closed contract holds on the mirrored missing-token failure.
    const env = { ...process.env, HOME: home, AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_CHAT_ID: FAKE_CHAT_ID };
    const res = emitCli(root, egressEvent(), env);
    strictEqual(res.status, 0, 'exit 0 always');
    strictEqual(res.stdout, '', 'stdout empty always');
    strictEqual(egressRows(root)[0].egress_outcome, 'missing-token', 'the network-free failure was mirrored, not thrown');
  });
});

// ===========================================================================
// (J) provider-outcome classification matrix -- each transport result/error maps to
//     the right §7 outcome, coarse status, pipeline reason, and claim/throttle
//     disposition, observed through the REAL runEmit pipeline (not a classifier unit
//     test). This is the runtime complement to the static executor guard: the guard
//     proves the request SHAPE is pinned; this proves the RESULT handling.
// ===========================================================================

describe('ADR-0041 acceptance (J) -- provider-outcome classification matrix', () => {
  // claim: 1 == promoted (owns the dedupe TTL), 0 == released. throttle: 1 ==
  // recorded, 0 == cleared. Mirrors OUTCOME_TABLE (egress-semantics.mjs).
  const CASES = [
    { name: 'HTTP 200 + {ok:true} -> dispatched', respond: () => ({ status: 200, ok: true }), outcome: 'dispatched', status: 'dispatched', reason: 'egress-dispatched', claim: 1, throttle: 0 },
    { name: 'HTTP 500 -> provider-error', respond: () => ({ status: 500, ok: false }), outcome: 'provider-error', status: 'failed', reason: 'egress-provider-error', claim: 0, throttle: 1 },
    { name: 'HTTP 200 + {ok:false} -> provider-rejected', respond: () => ({ status: 200, ok: false }), outcome: 'provider-rejected', status: 'failed', reason: 'egress-provider-rejected', claim: 0, throttle: 1 },
    { name: 'AbortSignal TimeoutError -> timeout', respond: () => timeoutError(), outcome: 'timeout', status: 'failed', reason: 'egress-timeout', claim: 0, throttle: 1 },
    { name: 'native ETIMEDOUT code -> timeout', respond: () => etimedoutError(), outcome: 'timeout', status: 'failed', reason: 'egress-timeout', claim: 0, throttle: 1 },
    // The classifier's redirect branch is DEFENSIVE/vestigial from the fetch era: the
    // real node:https transport never follows redirects, so a 3xx returns as a
    // statusCode -> httpOk=false -> provider-error, never redirect-error. This case
    // still exercises a live classifier branch (kept -- its disposition is identical
    // to provider-error), but the outcome is unreachable via the shipped transport
    // (peer LOW).
    { name: 'redirect-mentioning error -> redirect-error', respond: () => redirectError(), outcome: 'redirect-error', status: 'failed', reason: 'egress-redirect-error', claim: 0, throttle: 1 },
    { name: 'ENOTFOUND -> provider-error', respond: () => transportAbsentError(), outcome: 'provider-error', status: 'failed', reason: 'egress-provider-error', claim: 0, throttle: 1 },
  ];
  for (const c of CASES) {
    it(`J -- ${c.name}`, async () => {
      const root = markerRepo('J-outcome');
      const calls = [];
      const result = await emitEgress({ root, calls, respond: c.respond });
      strictEqual(result.status, c.status, 'pipeline status');
      strictEqual(result.reason, c.reason, 'pipeline reason');
      strictEqual(calls.length, 1, 'exactly one bounded attempt');
      const row = egressRows(root)[0];
      strictEqual(row.egress_outcome, c.outcome, 'mirror egress_outcome');
      strictEqual(row.egress_status, c.status, 'mirror coarse status');
      strictEqual(claimCount(root), c.claim, 'claim disposition (promote=1/release=0)');
      strictEqual(throttleCount(root), c.throttle, 'throttle disposition (record=1/clear=0)');
    });
  }
});

// ===========================================================================
// (K) opt-in REAL-network smoke -- CI-SKIPPED by default. Deterministic CI is
//     NECESSARY but NOT SUFFICIENT (§2d): every gate above injects a transport
//     double and NEVER opens a socket, so none can prove the real node:https
//     transport DELIVERS -- nor exercise the IPv4-preferred family fallback, the
//     secureConnect body-write timing, or the no-retry-after-write idempotency (the
//     guard forbids the aliasing an injection needs; a node:https module-mock needs
//     an experimental flag this suite does not enable -- so the pure budget helper
//     `telegramAttemptTimeoutMs` is unit-tested and the socket behavior is left to
//     this smoke + release-dogfood). The fetch->node:https swap exists precisely
//     because a green fakeFetch suite hid an undici delivery failure on the owner's
//     IPv6-broken host. Real delivery proof is the [release-dogfood] subtask (the
//     owner receives a live Telegram message). This is the manual hook: it runs the
//     REAL transport (no fetchImpl) ONLY when AGENTIC_EGRESS_REAL_SMOKE=1 with real
//     env credentials, so CI stays hermetic and network-free.
// ===========================================================================

describe('ADR-0041 acceptance (K) -- opt-in real-network smoke (skipped unless AGENTIC_EGRESS_REAL_SMOKE=1)', () => {
  const REAL = process.env.AGENTIC_EGRESS_REAL_SMOKE === '1';
  it('K -- the REAL node:https transport delivers to a live endpoint', { skip: !REAL }, async () => {
    const token = process.env.AGENTIC_EGRESS_REAL_SMOKE_TOKEN;
    const chatId = process.env.AGENTIC_EGRESS_REAL_SMOKE_CHAT_ID;
    ok(token && chatId, 'AGENTIC_EGRESS_REAL_SMOKE=1 requires AGENTIC_EGRESS_REAL_SMOKE_TOKEN + AGENTIC_EGRESS_REAL_SMOKE_CHAT_ID');
    const root = markerRepo('K-real');
    const home = fixtureHome();
    // NO fetchImpl -> dispatchTelegramRequest's REAL node:https branch runs and opens
    // a real socket (IPv4-preferred family, bounded shared deadline).
    const result = await runEmit({
      eventText: JSON.stringify(egressEvent()),
      repoRoot: root,
      homeDir: home,
      env: { AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_CHAT_ID: chatId, TELEGRAM_BOT_TOKEN: token },
    });
    strictEqual(result.status, 'dispatched', 'the real transport delivered (status dispatched)');
    // Even a REAL token must persist to NOWHERE.
    ok(!dumpNotifyState(root).includes(token), 'the real token never lands in persisted state');
  });
});

// ===========================================================================
// (G) ADR-0010 §5 subprocess-only boundary -- the emit substrate (incl. the new
//     egress-*.mjs libs) is never imported by attention or the personas.
// ===========================================================================

describe('ADR-0041 acceptance (G) -- attention + persona self-sensors reach the emit substrate only by subprocess', () => {
  // notify.mjs + notify-schema.mjs + the egress-*.mjs libs are L1 runtime;
  // attention is a separate L1 plugin and the personas are L2/L3 -- none may
  // import across the seam (ADR-0010 §5). They reach the emitter by SUBPROCESS
  // and hold the §1/§4 contract by COPY. This extends the ADR-0040 (e) boundary
  // scan to the new egress substrate. STATIC-ANALYSIS LIMIT (same as the footer
  // + ADR-0040 gates): a FULLY-COMPUTED dynamic import (specifier assembled at
  // runtime) cannot be caught; the subprocess-only convention + review +
  // per-plugin tests are the backstop for that residual.
  //
  // Discovered from plugins/* (peer MAJOR: a hardcoded list omitted plugins/image
  // -- and would silently omit any future plugin). runtime is excluded (it owns
  // the substrate). Every OTHER plugin, present or future, is scanned.
  const PLUGINS_DIR = resolve(REPO_ROOT, 'plugins');
  const SCANNED_DIRS = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'runtime')
    .map((e) => join('plugins', e.name))
    .sort();
  const TARGETS = [
    'notify\\.mjs', 'notify-schema\\.mjs',
    'egress-config\\.mjs', 'egress-channel\\.mjs', 'egress-semantics\\.mjs',
  ];
  const SPEC_OPEN = '[`\'"]';
  const SPEC_BODY = '[^`\'"\\n]';
  const patternsFor = (mod) => [
    new RegExp(`^\\s*import\\b[^\\n]*\\bfrom\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    new RegExp(`^\\s*import\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    new RegExp(`^\\s*export\\b[^\\n]*\\bfrom\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    // Multiline import/export: `from '<spec>'` on a continuation line (the
    // Codex-caught false-negative the ADR-0040 gate fixed).
    new RegExp(`^\\s*\\}?\\s*from\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    new RegExp(`\\bimport\\s*\\(\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`),
    new RegExp(`\\brequire\\s*\\(\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`),
  ];

  // Best-effort BLOCK-comment strip so an obfuscated `from /* … */ '<spec>'` or
  // `import(/* … */ '<spec>')` specifier is still caught (peer MAJOR: an inline
  // comment between the keyword and the quote defeated the raw regex). Block
  // comments ONLY -- never `//` (which cannot hold an anchored `^import`/`^from`
  // and would over-strip `https://` URLs in string literals). Not string-aware:
  // a `/*` inside a string is over-stripped, which can only cause a LOUD false
  // positive, never a missed import. Applied to CODE files only.
  const stripBlockComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const isCode = (name) => /\.(mjs|js|cjs)$/.test(name);

  async function collectFiles(dir) {
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...await collectFiles(p));
      else if (/\.(mjs|js|cjs|md)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it('the scan set is discovered from plugins/* and includes image (not a hardcoded list)', () => {
    ok(SCANNED_DIRS.length >= 5, `expected >=5 non-runtime plugin dirs; got ${SCANNED_DIRS.join(', ')}`);
    ok(SCANNED_DIRS.includes(join('plugins', 'image')), 'plugins/image is scanned (peer-caught omission)');
    ok(!SCANNED_DIRS.includes(join('plugins', 'runtime')), 'runtime is excluded (it owns the substrate)');
  });

  for (const rel of SCANNED_DIRS) {
    it(`${rel} imports no runtime emit substrate (notify / notify-schema / egress-*)`, async () => {
      const files = await collectFiles(resolve(REPO_ROOT, rel));
      ok(files.length > 0, `expected to scan files under ${rel}`);
      for (const file of files) {
        const raw = await readFile(file, 'utf8');
        // Scan the raw text AND -- for code files -- a block-comment-stripped copy.
        const variants = isCode(file) ? [raw, stripBlockComments(raw)] : [raw];
        for (const text of variants) {
          for (const mod of TARGETS) {
            for (const pattern of patternsFor(mod)) {
              ok(
                !pattern.test(text),
                `${file} imports the L1 runtime emit substrate (${pattern}) -- ADR-0010 §5 forbids the cross-plugin import; reach notify.mjs by subprocess and hold the §1/§4 contract by copy`,
              );
            }
          }
        }
      }
    });
  }
});
