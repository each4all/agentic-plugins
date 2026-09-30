// Autopilot state-contract parity (ADR-0063 §0.2, D4, D6).
//
// WHY THIS EXISTS. ADR-0010 §5 forbids cross-plugin imports, so each plugin
// that reads the autopilot contract carries its own copy of the small shared
// pieces: the `isAutopilotRun` predicate over AGENTIC_AUTOPILOT, and the
// `awaiting_owner_pointer` shape. A copy that drifts turns a gate on in one
// plugin and off in the other for the same environment. Tests are not
// plugins, so this file reads both copies and holds them equal. The owner
// gates are split between the plugins — the engineer workflow stores some,
// the macro the others — so the two sets must not overlap, and together they
// stay inside ADR-0063 D4's closed enum.
//
// Copies today: engineer (S1) and orchestrator (S2). Runtime's entry-brief
// readers get theirs with S7; add it to COPIES then.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const COPIES = {
  engineer: resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs'),
  orchestrator: resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs'),
};
const modules = Object.fromEntries(
  await Promise.all(Object.entries(COPIES).map(async ([name, path]) => [name, await import(path)])),
);
const sources = Object.fromEntries(
  await Promise.all(Object.entries(COPIES).map(async ([name, path]) => [name, await readFile(path, 'utf8')])),
);

// The single regex literal a line of the given shape carries in each copy.
function literalIn(name, pattern) {
  const found = sources[name].match(new RegExp(pattern, 'gm')) ?? [];
  strictEqual(found.length, 1, `${name}: exactly one match for ${pattern}`);
  return found[0].trim();
}

describe('isAutopilotRun is the same predicate in every copy', () => {
  it('the source line is identical', () => {
    const lines = Object.keys(COPIES).map((name) =>
      literalIn(name, String.raw`^\s*return /\^autopilot-.*\.test\(env\?\.AGENTIC_AUTOPILOT \?\? ''\);$`));
    ok(lines[0].includes('^autopilot-\\d{8}T\\d{6}Z-[0-9a-f]{6}$'), lines[0]);
    for (const line of lines) strictEqual(line, lines[0]);
  });

  it('every copy decides the same on a battery of values', () => {
    const values = [
      undefined, '', '0', '1', 'true', 'autopilot',
      'autopilot-20260930T010203Z-abcdef',
      'autopilot-20260930T010203Z-ABCDEF',
      'autopilot-20260930T010203Z-abcde',
      'autopilot-20260930T0102Z-abcdef',
      ' autopilot-20260930T010203Z-abcdef',
      'autopilot-20260930T010203Z-abcdef\n',
      'context-20260930T010203Z-abcdef',
    ];
    for (const value of values) {
      const env = value === undefined ? {} : { AGENTIC_AUTOPILOT: value };
      const answers = Object.values(modules).map((m) => m.isAutopilotRun(env));
      ok(answers.every((a) => a === answers[0]), `${JSON.stringify(value)}: ${answers}`);
    }
    strictEqual(modules.engineer.isAutopilotRun({ AGENTIC_AUTOPILOT: 'autopilot-20260930T010203Z-abcdef' }), true);
  });
});

describe('awaiting_owner_pointer has one shape', () => {
  it('the pointer regex literal is identical', () => {
    const lines = Object.keys(COPIES).map((name) =>
      literalIn(name, String.raw`^const AWAITING_OWNER_POINTER_RE = .*;$`));
    for (const line of lines) strictEqual(line, lines[0]);
  });
});

describe('owner gates are split between engineer and macro', () => {
  it('the two sets do not overlap and stay inside the ADR-0063 D4 enum', async () => {
    const engineer = [...modules.engineer.VALID_ENGINEER_OWNER_GATES];
    const macro = [...modules.orchestrator.VALID_MACRO_OWNER_GATES];
    deepStrictEqual(engineer.filter((g) => macro.includes(g)), []);

    const adr = await readFile(resolve(REPO_ROOT, 'docs/adr/0063-autopilot-fresh-session-driver.md'), 'utf8');
    const start = adr.indexOf('**`awaiting_owner.gate`** is a closed enum');
    ok(start >= 0, 'ADR-0063 D4 states the gate enum');
    const paragraph = adr.slice(start, adr.indexOf('\n\n', start));
    const d4 = [...paragraph.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]);
    ok(d4.length >= 9, `D4 lists the gates (${d4.join(', ')})`);
    for (const gate of [...engineer, ...macro]) ok(d4.includes(gate), `${gate} is a D4 gate`);
  });
});
