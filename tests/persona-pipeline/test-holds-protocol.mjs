// ADR-0068 Decision 2, implementation note of 2026-10-25 — the persona's reads
// of a macro's holds directory (lib/holds.mjs), held to the shared fixtures
// under tests/fixtures/holds-protocol/ for every persona it is generated into.
// The orchestrator's half (impl-hold) is held to the same files.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, personaInfo, personasFor } from './_personas.mjs';

const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'holds-protocol');
const CASES = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8'));
const TRANSITIONS = JSON.parse(readFileSync(join(FIXTURES, 'release-transitions.json'), 'utf8'));
const AUTOPILOT = '.agentic-plugins/runs/autopilot';

function resolveEntry(spec) {
  if (spec === '$marker') return CASES.marker;
  if (spec === '$hold') return { json: CASES.hold };
  if (typeof spec === 'string' && spec.startsWith('$op:')) return { json: { ...CASES.op, operation_id: spec.slice(4) } };
  if (spec && typeof spec === 'object' && spec.hold) return { json: { ...CASES.hold, ...spec.hold } };
  return spec;
}

function materialize(main, c) {
  const holds = join(main, AUTOPILOT, 'holds', CASES.macro);
  if (c.holds_path !== undefined) {
    mkdirSync(dirname(holds), { recursive: true });
    writeFileSync(holds, c.holds_path);
    return;
  }
  if (c.files === null) return;
  mkdirSync(holds, { recursive: true });
  for (const [rel, raw] of Object.entries(c.files)) {
    const spec = resolveEntry(raw);
    const p = join(holds, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (typeof spec === 'string') writeFileSync(p, spec);
    else if (spec.json !== undefined) writeFileSync(p, `${JSON.stringify(spec.json)}\n`);
    else if (spec.dir) mkdirSync(p, { recursive: true });
    else if (spec.fifo) execFileSync('mkfifo', [p]);
    else if (spec.link) symlinkSync(spec.link, p);
    else throw new Error(`fixture ${c.id}: unknown entry ${rel}`);
  }
}

function withMain(fn) {
  const main = mkdtempSync(join(tmpdir(), 'holds-protocol-'));
  try {
    return fn(main);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
}

for (const persona of personasFor('scripts/lib/holds.mjs')) {
  const holds = await import(pathToFileURL(personaInfo(persona).path('scripts/lib/holds.mjs')).href);

  describe(`${persona}: holds protocol fixtures (ADR-0068 implementation note, N2-N4)`, () => {
    for (const c of CASES.cases) {
      it(c.id, () => withMain((main) => {
        materialize(main, c);
        const workflowId = c.workflow_id === undefined ? CASES.workflow_id : c.workflow_id;
        const activation = holds.readActivation(main, CASES.macro);
        strictEqual(activation.state, c.expect.activation, `activation: ${JSON.stringify(activation)}`);
        if (c.expect.owner !== undefined || c.expect.applies !== undefined) {
          const owner = holds.readOwnerHold(main, CASES.macro, CASES.subtask);
          strictEqual(owner.state, c.expect.owner, `owner: ${JSON.stringify(owner)}`);
          strictEqual(holds.holdApplies(owner, { branch: CASES.branch, workflowId }).applies, c.expect.applies);
        }
        if (c.expect.park !== undefined) {
          strictEqual(holds.readKeptPark(main, CASES.macro, CASES.subtask).kept, c.expect.park);
        }
        if (c.expect.ops !== undefined) {
          const ops = holds.readOps(main, CASES.macro, CASES.subtask);
          strictEqual(ops.state, c.expect.ops_state);
          deepStrictEqual(ops.ops.map((o) => ({ id: o.id, open: !o.cleared, record: o.record !== null ? 'ok' : o.error !== undefined ? 'unreadable' : 'none' })), c.expect.ops);
          for (const o of c.expect.ops) {
            strictEqual(holds.operationCleared(main, CASES.macro, CASES.subtask, o.id), !o.open);
          }
        }
        if (c.expect.activation !== 'active') {
          deepStrictEqual(holds.laneHoldFacts({ mainRoot: main, macroId: CASES.macro, subtaskId: CASES.subtask, branch: CASES.branch }), { activation });
        }
      }));
    }

    it('every owner-record state of the release table reads as the table says', () => {
      for (const [state, want] of Object.entries(TRANSITIONS.persona_reads)) {
        const read = { state: 'ok', record: { ...CASES.hold, ...want.record } };
        strictEqual(holds.holdApplies(read, { branch: CASES.branch, workflowId: CASES.workflow_id }).applies, want.applies, state);
      }
    });

    it('refuses an operation id that is no string', () => {
      let threw = false;
      try { holds.operationCleared('/tmp', CASES.macro, CASES.subtask, ['op-20261025T090000Z-0123abcd']); } catch { threw = true; }
      ok(threw);
    });

    it('builds no path from an id outside its form', () => {
      for (const bad of ['../x', 'macro-x', '', null]) {
        let threw = false;
        try { holds.holdsDir('/tmp', bad); } catch { threw = true; }
        ok(threw, `macro id ${JSON.stringify(bad)}`);
      }
      for (const bad of ['../x', '.hidden', 'a/b', '']) {
        let threw = false;
        try { holds.opsDir('/tmp', CASES.macro, bad); } catch { threw = true; }
        ok(threw, `subtask id ${JSON.stringify(bad)}`);
      }
    });

    it('carries the capability token the driver floor reads (N8)', () => {
      strictEqual(holds.HOLD_PERSONA_CAPABILITY, 'hold-persona-1');
      ok(readFileSync(personaInfo(persona).path('scripts/lib/holds.mjs'), 'utf8').includes('hold-persona-1'));
    });
  });

  describe(`${persona}: a live run of the macro (N3)`, () => {
    const lockDir = (main) => join(main, AUTOPILOT, 'locks', `${CASES.macro}.lock`);
    const entry = (main, name, value) => {
      mkdirSync(lockDir(main), { recursive: true });
      writeFileSync(join(lockDir(main), name), typeof value === 'string' ? value : JSON.stringify(value));
    };

    it('no lock: no run', () => withMain((main) => {
      strictEqual(holds.macroRunLive(main, CASES.macro).live, false);
    }));

    it('a live driver: live', () => withMain((main) => {
      entry(main, `h-${process.pid}-aa.json`, { run_id: 'autopilot-x', pid: process.pid, fingerprint: holds.processFingerprint(process.pid), worker: null });
      strictEqual(holds.macroRunLive(main, CASES.macro).live, true);
    }));

    it('a dead driver whose worker lives: no live run', async () => {
      const child = spawn(process.execPath, ['-e', '']);
      await new Promise((r) => child.once('exit', r));
      withMain((main) => {
        entry(main, `h-${child.pid}-aa.json`, { run_id: 'autopilot-x', pid: child.pid, fingerprint: { kind: 'none' }, worker: { pid: process.pid, fingerprint: holds.processFingerprint(process.pid), pgid: process.pid } });
        strictEqual(holds.macroRunLive(main, CASES.macro).live, false);
      });
    });

    it('a pid reused by a process that started at another time: no live run', () => withMain((main) => {
      const fp = holds.processFingerprint(process.pid);
      ok(fp.kind !== 'none', 'this platform fingerprints processes');
      const other = fp.kind === 'linux_proc_starttime' ? { ...fp, starttime: '1' } : { ...fp, lstart: 'Thu Jan  1 00:00:00 1970' };
      entry(main, `h-${process.pid}-aa.json`, { run_id: 'autopilot-x', pid: process.pid, fingerprint: other, worker: null });
      strictEqual(holds.macroRunLive(main, CASES.macro).live, false);
    }));

    it('an entry too fresh to parse counts live; an old one is debris', () => withMain((main) => {
      entry(main, 'h-1-aa.json', '{');
      strictEqual(holds.macroRunLive(main, CASES.macro).live, true);
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(lockDir(main), 'h-1-aa.json'), old, old);
      strictEqual(holds.macroRunLive(main, CASES.macro).live, false);
    }));

    it("an interactive command's admission entry is no run", () => withMain((main) => {
      entry(main, `s-${'0'.repeat(32)}.json`, { kind: 'session', pid: process.pid, fingerprint: holds.processFingerprint(process.pid) });
      strictEqual(holds.macroRunLive(main, CASES.macro).live, false);
    }));

    it('a run-lock entry that is no regular file counts live, without blocking', () => withMain((main) => {
      mkdirSync(lockDir(main), { recursive: true });
      execFileSync('mkfifo', [join(lockDir(main), 'h-123-aa.json')]);
      // Judged in a child process, so a read that blocks fails the test on its timeout.
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const h = await import(${JSON.stringify(pathToFileURL(personaInfo(persona).path('scripts/lib/holds.mjs')).href)}); console.log(JSON.stringify(h.macroRunLive(${JSON.stringify(main)}, ${JSON.stringify(CASES.macro)})));`],
      { encoding: 'utf8', timeout: 10_000 });
      strictEqual(r.status, 0, r.stderr || 'timed out');
      strictEqual(JSON.parse(r.stdout).live, true);
    }));

    it('a lock that cannot be listed counts live', () => withMain((main) => {
      mkdirSync(join(main, AUTOPILOT, 'locks'), { recursive: true });
      writeFileSync(lockDir(main), 'x');
      strictEqual(holds.macroRunLive(main, CASES.macro).live, true);
    }));
  });
}

describe('release transitions table (N7)', () => {
  it('is deterministic, closed over its states, and leaves its terminal states alone', () => {
    const states = new Set(TRANSITIONS.states);
    const seen = new Set();
    for (const t of TRANSITIONS.transitions) {
      ok(states.has(t.from) && states.has(t.to), JSON.stringify(t));
      const key = `${t.from} ${t.event}`;
      ok(!seen.has(key), `two transitions for ${key}`);
      seen.add(key);
      ok(!TRANSITIONS.terminal.includes(t.from), `a terminal state moves: ${key}`);
    }
    for (const r of TRANSITIONS.refused) ok(!seen.has(`${r.from} ${r.event}`), `refused yet listed: ${r.from} ${r.event}`);
    deepStrictEqual(new Set(Object.keys(TRANSITIONS.persona_reads)), states);
    // Every state is reachable from the initial one.
    const reach = new Set([TRANSITIONS.initial]);
    for (let grew = true; grew;) {
      grew = false;
      for (const t of TRANSITIONS.transitions) if (reach.has(t.from) && !reach.has(t.to)) { reach.add(t.to); grew = true; }
    }
    deepStrictEqual(reach, states);
  });
});
