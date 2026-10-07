// Autopilot state-contract parity (ADR-0063 §0.2, D4, D6).
//
// WHY THIS EXISTS. ADR-0010 §5 forbids cross-plugin imports, so each plugin
// that reads the autopilot contract carries its own copy of the small shared
// pieces: the `isAutopilotRun` predicate over AGENTIC_AUTOPILOT, and the
// `awaiting_owner_pointer` shape. A copy that drifts turns a gate on in one
// plugin and off in the other for the same environment. Tests are not
// plugins, so this file reads both copies and holds them equal. The owner
// gates are split between the plugins — the engineer workflow stores some,
// the macro the others — so the two sets must not overlap. The autopilot
// driver's copies of engineer's closed enums are held equal to engineer's.
//
// Copies today: engineer (S1) and orchestrator (S2). Runtime's entry-brief
// readers get theirs with S7; add it to COPIES then. founder and designer
// (ADR-0066 PC2b) carry the predicate, the pointer and the workflow gates,
// held below against engineer's.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // Contract: every plugin's isAutopilotRun parses AGENTIC_AUTOPILOT — a copy
  // whose regex differs, or one that stops matching the run id the driver
  // mints, turns autopilot on in one plugin and off in another for one run.
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
  // Contract: each plugin's state.mjs validates awaiting_owner_pointer with this
  // (unexported) regex — copies that differ accept a pointer another rejects.
  it('the pointer regex literal is identical', () => {
    const lines = Object.keys(COPIES).map((name) =>
      literalIn(name, String.raw`^const AWAITING_OWNER_POINTER_RE = .*;$`));
    for (const line of lines) strictEqual(line, lines[0]);
  });
});

describe('owner gates are split between engineer and macro', () => {
  it('the two sets do not overlap', () => {
    const engineer = [...modules.engineer.VALID_WORKFLOW_OWNER_GATES];
    const macro = [...modules.orchestrator.VALID_MACRO_OWNER_GATES];
    deepStrictEqual(engineer.filter((g) => macro.includes(g)), []);
  });
});

// The persona plugins' state.mjs (generated from persona-pipeline/, ADR-0066)
// read schema 1.4 workflow files (PC2b): the same pointer shape and the same
// workflow-file gates as engineer, so a file reads the same under every
// persona. Which gates a persona can set is a capability question, not the
// reader's (ADR-0066 Decision 3).
describe('the persona plugins read the workflow-file contract engineer reads', async () => {
  const { personasFor, personaInfo } = await import('../persona-pipeline/_personas.mjs');
  for (const persona of personasFor('scripts/state.mjs')) {
    const path = personaInfo(persona).path('scripts/state.mjs');
    const mod = await import(pathToFileURL(path).href);
    const source = await readFile(path, 'utf8');

    it(`${persona}: the isAutopilotRun source line is engineer's, and decides the same`, () => {
      // Contract: as above — this persona's copy parses AGENTIC_AUTOPILOT for the
      // same run.
      const pattern = String.raw`^\s*return /\^autopilot-.*\.test\(env\?\.AGENTIC_AUTOPILOT \?\? ''\);$`;
      const found = source.match(new RegExp(pattern, 'gm')) ?? [];
      strictEqual(found.length, 1, `${persona}: exactly one predicate line`);
      strictEqual(found[0].trim(), literalIn('engineer', pattern));
      for (const value of [undefined, '', 'true', 'autopilot-20260930T010203Z-abcdef', 'autopilot-20260930T010203Z-ABCDEF']) {
        const env = value === undefined ? {} : { AGENTIC_AUTOPILOT: value };
        strictEqual(mod.isAutopilotRun(env), modules.engineer.isAutopilotRun(env), JSON.stringify(value));
      }
    });

    it(`${persona}: the pointer regex literal is engineer's`, () => {
      // Contract: as above — this persona's state.mjs validates the same pointer.
      const pattern = String.raw`^const AWAITING_OWNER_POINTER_RE = .*;$`;
      const found = source.match(new RegExp(pattern, 'gm')) ?? [];
      strictEqual(found.length, 1, `${persona}: exactly one match for ${pattern}`);
      strictEqual(found[0].trim(), literalIn('engineer', pattern));
    });

    it(`${persona}: the gate, kind and confidence enums are engineer's, and no macro gate`, () => {
      deepStrictEqual([...mod.VALID_WORKFLOW_OWNER_GATES], [...modules.engineer.VALID_WORKFLOW_OWNER_GATES]);
      deepStrictEqual([...mod.VALID_NEXT_STEP_KINDS], [...modules.engineer.VALID_NEXT_STEP_KINDS]);
      deepStrictEqual([...mod.VALID_CONFIDENCE], [...modules.engineer.VALID_CONFIDENCE]);
      const macro = [...modules.orchestrator.VALID_MACRO_OWNER_GATES];
      deepStrictEqual([...mod.VALID_WORKFLOW_OWNER_GATES].filter((g) => macro.includes(g)), []);
    });
  }
});

// The autopilot driver (ADR-0063 S8) lives in orchestrator and reads the
// engineer workflow's closed enums, so it carries copies of them
// (plugins/orchestrator/adapters/claude/autopilot/policy.mjs). A copy that
// drifts from engineer's would read a valid next step as outside the enum and
// halt every run — or accept a value engineer never writes.
describe('the autopilot driver reads the engineer enums it was given', () => {
  const policyPath = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs');

  it('verbs, next-step kinds, confidences, engineer gates and terminal phases match engineer', async () => {
    const policy = await import(policyPath);
    // Contract: engineer's state.mjs validates --verb against VALID_VERBS, read
    // here from its source because it is not exported.
    const verbs = sources.engineer.match(/^const VALID_VERBS = new Set\(\[([\s\S]*?)\]\);$/m);
    ok(verbs, 'engineer state.mjs declares VALID_VERBS');
    const engineerVerbs = [...verbs[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    deepStrictEqual([...policy.VERBS], engineerVerbs);
    deepStrictEqual([...policy.NEXT_STEP_KINDS], [...modules.engineer.VALID_NEXT_STEP_KINDS]);
    deepStrictEqual([...policy.CONFIDENCES], [...modules.engineer.VALID_CONFIDENCE]);
    deepStrictEqual([...policy.ENGINEER_OWNER_GATES], [...modules.engineer.VALID_WORKFLOW_OWNER_GATES]);
    deepStrictEqual([...policy.ENGINEER_TERMINAL_PHASES], [...modules.engineer.terminalPhases()]);
    deepStrictEqual([...policy.MACRO_OWNER_GATES], [...modules.orchestrator.VALID_MACRO_OWNER_GATES]);
  });
});
