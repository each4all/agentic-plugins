import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  RECEIVER_API_MAJORS,
  renderStatusline,
  statuslineRendererIds,
} from '../../plugins/runtime/scripts/receiver-api.mjs';

// The packaged receiver API is the half of the receiver contract that UPGRADES:
// the installed shim is frozen at install time, so behaviour lives here. Two
// properties therefore have to hold that do not apply to an ordinary runtime
// script — it is evaluated inside the statusline shim's own process, on every
// prompt render. (ADR-0064 removed the Codex notify mapping and its cases.)

const API_PATH = fileURLToPath(new URL('../../plugins/runtime/scripts/receiver-api.mjs', import.meta.url));

describe('receiver API — the boundary the installed shim delegates across', () => {
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

  it('keeps its STATIC import graph to leaf modules only, with no dynamic import', async () => {
    // The statusline renders synchronously on every prompt, so the import graph
    // is a latency budget, not a style question. A future static import of a
    // heavy module (footer.mjs measured 27 ms to import) would be charged to
    // every render.
    const source = await readFile(API_PATH, 'utf8');
    const statics = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    const allowed = new Set(['node:child_process', 'node:fs']);
    const unexpected = statics.filter((spec) => !allowed.has(spec));
    strictEqual(unexpected.length, 0, `unexpected static imports: ${unexpected.join(', ')}`);
    // Non-vacuity: the extractor must actually be finding this file's imports.
    ok(statics.length >= 2, `the import scan found only ${statics.length} imports — check the pattern`);
    // The lazy notify-schema import went with the Codex notify mapping
    // (ADR-0064 Decision 1); nothing else may reach a graph lazily either.
    ok(!/\bimport\s*\(/.test(source), 'no dynamic import remains');
  });

  it('versions the statusline receiver as an integer major, and no longer offers the Codex notify major', () => {
    strictEqual(typeof RECEIVER_API_MAJORS.statusline, 'number');
    // An installed Codex shuttle resolves only a runtime that still carries
    // scripts/notify.mjs (ADR-0064 Decision 7), so no major is offered for it.
    deepStrictEqual(Object.keys(RECEIVER_API_MAJORS), ['statusline']);
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
});
