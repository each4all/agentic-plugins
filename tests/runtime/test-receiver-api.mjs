import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECEIVER_API_MAJORS,
  mapCodexNotifyPayload,
  renderStatusline,
  statuslineRendererIds,
} from '../../plugins/runtime/scripts/receiver-api.mjs';
import { deriveRepoIdent } from '../../plugins/runtime/scripts/lib/notify-schema.mjs';

// The packaged receiver API is the half of the receiver contract that UPGRADES:
// the installed shims are frozen at install time, so behaviour lives here. Two
// properties therefore have to hold that do not apply to an ordinary runtime
// script — it is evaluated inside the statusline shim's own process, on every
// prompt render.

const API_PATH = fileURLToPath(new URL('../../plugins/runtime/scripts/receiver-api.mjs', import.meta.url));
const NOTIFY_PATH = fileURLToPath(new URL('../../plugins/runtime/scripts/notify.mjs', import.meta.url));

describe('receiver API — the boundary the installed shims delegate across', () => {
  it('is side-effect-free on import: no stdout, no stderr, no non-zero exit', () => {
    // The statusline shim imports this module and then writes ONE line to
    // stdout. Anything printed at import time would be interleaved into that
    // line — the host displays the first stdout line, whatever wrote it. Proved
    // in a FRESH process, since the module is already cached in this one.
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(API_PATH)});`], {
      encoding: 'utf8', timeout: 10000,
    });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout, '', 'importing the API must not write to stdout');
    strictEqual(r.stderr, '', 'importing the API must not write to stderr');
  });

  it('keeps its STATIC import graph to leaf modules only', async () => {
    // The statusline renders synchronously on every prompt, so the import graph
    // is a latency budget, not a style question. `lib/notify-schema.mjs` is
    // deliberately NOT static: the notify mapping imports it lazily, so only the
    // shuttle path pays for it. A future static import of a heavy module
    // (footer.mjs measured 27 ms to import) would be charged to every render.
    const source = await readFile(API_PATH, 'utf8');
    const statics = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    const allowed = new Set(['node:child_process', 'node:crypto', 'node:fs', 'node:path']);
    const unexpected = statics.filter((spec) => !allowed.has(spec));
    strictEqual(unexpected.length, 0, `unexpected static imports: ${unexpected.join(', ')}`);
    // Non-vacuity: the extractor must actually be finding this file's imports.
    ok(statics.length >= 3, `the import scan found only ${statics.length} imports — check the pattern`);
    ok(!statics.includes('./lib/notify-schema.mjs'), 'the notify graph must stay off the statusline path');
    ok(/await import\('\.\/lib\/notify-schema\.mjs'\)/.test(source), 'and must be reached lazily instead');
  });

  it('derives the repo ident through the ONE canonical implementation', async () => {
    // The shuttle used to carry its own copy of this contract. Re-implementing
    // it here would only move the duplicate from installed bytes into packaged
    // bytes, so the mapping imports notify-schema's — pinned here.
    const dir = await mkdtemp(join(tmpdir(), 'receiver-api-ident-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    const mapped = await mapCodexNotifyPayload({
      payloadText: JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 't' }),
      cwd: dir,
    });
    strictEqual(mapped.event.event_id.split(':')[0], deriveRepoIdent(dir));
  });

  it('versions the two receivers separately, as integers', () => {
    strictEqual(typeof RECEIVER_API_MAJORS.statusline, 'number');
    strictEqual(typeof RECEIVER_API_MAJORS.codexNotify, 'number');
    ok(Object.isFrozen(RECEIVER_API_MAJORS), 'the declared majors are not mutable at runtime');
  });

  it('skips unknown policy items with order preserved, and returns null when nothing renders', () => {
    // Order-preserving-under-missing-data (ADR-0048 §2). A newer installed shim
    // naming an item an older runtime lacks must get a SHORTER line, never no
    // line — that is what keeps a shim/runtime mismatch degrading gracefully.
    const session = { model: { display_name: 'Opus 5' }, pr: { number: 7 } };
    strictEqual(
      renderStatusline({ session, items: ['pull-request-number', 'not-a-real-item', 'model-with-reasoning'] }),
      'PR#7 · Opus 5',
    );
    strictEqual(renderStatusline({ session: {}, items: ['model-with-reasoning'] }), null);
    strictEqual(renderStatusline({ session: null, items: [] }), null);
    strictEqual(renderStatusline({ session, items: 'not-an-array' }), null);
  });

  it('exposes the renderer ids the statusline policy is bound against', () => {
    const ids = statuslineRendererIds();
    ok(ids.includes('model-with-reasoning'));
    ok(ids.includes('git-branch'));
  });

  it('never lets a hostile session value break out of the single line', () => {
    const ESC = String.fromCharCode(0x1b);
    const RLO = String.fromCharCode(0x202e);
    const line = renderStatusline({
      session: { model: { display_name: `A${ESC}[31mB\nC${RLO}D${'x'.repeat(200)}` } },
      items: ['model-with-reasoning'],
    });
    ok(!/[\u0000-\u001f]/.test(line), 'no control bytes');
    ok(!line.includes(RLO), 'no bidi override');
    ok(line.length <= 64, `segment cap applies, got ${line.length}`);
  });

  it('maps only the accepted Codex variant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'receiver-api-map-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    const accepted = JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 't-1' });
    ok(await mapCodexNotifyPayload({ payloadText: accepted, cwd: dir }));
    for (const bad of ['', 'not json', '[]', 'null', JSON.stringify({ type: 'approval-requested' })]) {
      strictEqual(await mapCodexNotifyPayload({ payloadText: bad, cwd: dir }), null, `refused: ${bad}`);
    }
  });

  it('does not carry a discarded payload field into the mapped event', async () => {
    // Raw delegation moved fields the old shuttle dropped locally
    // (input-messages) across a process boundary. The mapped event must carry
    // only the fields the notify contract names, so a secret in a discarded
    // field cannot ride along into notify state, artifacts, or a diagnostic.
    const dir = await mkdtemp(join(tmpdir(), 'receiver-api-privacy-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    const SECRET = 'sk-live-DO-NOT-PERSIST-9f3a';
    const mapped = await mapCodexNotifyPayload({
      payloadText: JSON.stringify({
        type: 'agent-turn-complete',
        'turn-id': 't-1',
        'input-messages': [`please use ${SECRET}`],
        'last-assistant-message': 'ok',
      }),
      cwd: dir,
    });
    ok(mapped, 'the payload maps');
    ok(!JSON.stringify(mapped).includes(SECRET), 'a discarded field never reaches the mapped event');
    strictEqual(mapped.event.body, 'ok', 'only last-assistant-message becomes the body');
  });

  it('receive takes the payload from stdin only, bounded, and stays silent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'receiver-api-receive-'));
    await mkdir(join(dir, '.git'), { recursive: true });

    // A --payload-file option would invite raw payloads onto disk; there is none.
    const rejected = spawnSync(process.execPath, [NOTIFY_PATH, 'receive', '--source', 'codex-notify', '--payload-file', '/tmp/x'], {
      input: '', encoding: 'utf8', timeout: 10000,
    });
    strictEqual(rejected.status, 0, 'fail-closed exit posture');
    ok(/unknown argument/.test(rejected.stderr), 'a payload-file option is not accepted');

    // Over-cap input is refused rather than buffered into an event. Asserting
    // exit 0 / empty stdout would NOT show this: notify is silent either way,
    // so both a bounded and an unbounded read look identical there. The
    // observable difference is whether an event is EMITTED, so this reads the
    // file-log channel — with a positive control first, since absence evidence
    // is worthless unless the observation is known to detect a presence.
    await mkdir(join(dir, '.agentic-plugins'), { recursive: true });
    await writeFile(
      join(dir, '.agentic-plugins', 'config.toml'),
      'notify_channel = "file-log"\nnotify_dedupe_ttl_seconds = "300"\n',
    );
    const logPath = join(dir, '.agentic-plugins', 'state', 'runtime', 'notify', 'log.ndjson');
    const readLog = async () => {
      try { return await readFile(logPath, 'utf8'); } catch { return ''; }
    };
    const emitAndSettle = (payload) => {
      spawnSync(process.execPath, [NOTIFY_PATH, 'receive', '--source', 'codex-notify', '--cwd', dir], {
        input: payload, encoding: 'utf8', timeout: 30000, cwd: dir,
        env: { ...process.env, HOME: dir },
      });
    };

    emitAndSettle(JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 'ctl', 'last-assistant-message': 'ok' }));
    const afterControl = (await readLog()).trim().split('\n').filter(Boolean).length;
    strictEqual(afterControl, 1, 'positive control: an in-bounds payload DOES emit one record');

    const huge = JSON.stringify({
      type: 'agent-turn-complete',
      'turn-id': 'oversized',
      'last-assistant-message': 'x'.repeat(2 * 1024 * 1024),
    });
    emitAndSettle(huge);
    const afterHuge = (await readLog()).trim().split('\n').filter(Boolean).length;
    strictEqual(afterHuge, afterControl, 'an oversized payload emits nothing at all');
    ok(!(await readLog()).includes('oversized'), 'and never reaches notify state');

    // An unsupported source is refused without touching the payload.
    const badSource = spawnSync(process.execPath, [NOTIFY_PATH, 'receive', '--source', 'nope'], {
      input: '{}', encoding: 'utf8', timeout: 10000,
    });
    strictEqual(badSource.status, 0);
    ok(/unsupported --source/.test(badSource.stderr));
  });
});
