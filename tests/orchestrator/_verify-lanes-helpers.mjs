// tests/orchestrator/_verify-lanes-helpers.mjs
//
// Helpers shared by the verification tests of a run with lanes
// (test-autopilot-verify-lanes.mjs, test-autopilot-verify-lanes-instruct.mjs):
// a verify step, the bounds, the checks committed on main, the hold-aware
// engineer, a lane's child, a bounded wait, an instruction entry by its id, the
// batch's check logs and the hold protocol on. The leading underscore keeps it
// out of node --test discovery.

import { strictEqual } from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHECK_SCRIPT, DECLARATION } from './_verify-fixtures.mjs';

const HR = await import('../../plugins/orchestrator/scripts/lib/holds.mjs');

export const verify = (checks) => ({ kind: 'verify', verb: null, confidence: 'HIGH', checks, on_pass: { kind: 'commit', confidence: 'HIGH' } });
export const BOUNDS = { secondMs: 100, killGraceMs: 300, lingerMs: 500, pollMs: 25 };
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The checks committed on main, and the origin fetched: what each lane forks from.
export function commitChecks(t, declaration = DECLARATION) {
  mkdirSync(join(t.work, 'scripts'), { recursive: true });
  mkdirSync(join(t.work, '.agentic-plugins'), { recursive: true });
  writeFileSync(join(t.work, 'scripts/check.mjs'), CHECK_SCRIPT);
  writeFileSync(join(t.work, '.agentic-plugins/verify-checks.json'), declaration);
  t.git(t.work, 'add', '-A');
  t.git(t.work, 'commit', '-q', '-m', 'chore: checks');
  t.git(t.work, 'push', '-q', 'origin', 'HEAD:main');
  t.git(t.work, 'fetch', '-q', 'origin');
}

// The owner's instruction (Decision 7): the hold-aware engineer on both hosts,
// so a run's application can make its operation visible (item 9); a lane's
// child as the main checkout keeps it; a bounded wait; an entry by its id.
export function installEngineers(t) {
  for (const host of ['.claude', '.codex']) {
    const dir = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
  }
}
// The lane's active child, or with `archived`, an archived one when no active
// one is left.
export function childOf(t, id, { archived = false } = {}) {
  for (const sub of archived ? ['workflows', 'archive'] : ['workflows']) {
    const dir = join(t.work, '.agentic-plugins/state/engineer', sub);
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const name of names) {
      const text = readFileSync(join(dir, name), 'utf8');
      if (text.includes(`originating_subtask: "${id}"`)) return { path: join(dir, name), text, id: /workflow_id: "([^"]+)"/.exec(text)[1] };
    }
  }
  return null;
}
export async function untilTrue(pred, what, t, ms = 120_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try { if (pred()) return; } catch { /* not yet */ }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}\n${t.lines.join('\n')}`);
}
export const entryOf = (I, t, id, subtaskId = 'A') => I.readInstructions(t.work, t.fx.macroId, subtaskId).record.entries.find((x) => x.id === id);

export function checkLogs(r) {
  const dir = join(r.dir, 'verify');
  try {
    return readdirSync(dir).flatMap((b) => readdirSync(join(dir, b)).filter((n) => n.endsWith('.log')).map((n) => `${b}/${n}: ${readFileSync(join(dir, b, n), 'utf8').slice(-600)}`)).join('\n');
  } catch (e) { return String(e); }
}

// The hold protocol on for the macro: the persona then refuses a held lane's
// writes (the fixture's hosts carry no engineer cache, so the run cannot turn
// it on itself).
export function holdsOn(t) {
  HR.writeProtocol(t.work, t.fx.macroId, { writtenBy: 'test' });
  strictEqual(HR.readActivation(t.work, t.fx.macroId).state, 'active');
}
