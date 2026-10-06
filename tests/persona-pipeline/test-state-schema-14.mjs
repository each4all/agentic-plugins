// The canonical state.mjs reads and writes schema 1.4 (ADR-0063 D6, ADR-0066
// Decisions 3 and 7; PC2b): the flat next_step_* and awaiting_owner_* scalars,
// validated per key, in every persona the unit is enrolled into.
//
// Covers:
//   - "1.4" emitted and accepted; a fresh file carries none of the six keys
//   - round-trip of every key through parse → assemble → parse
//   - enum, format and co-presence rejections at the parser (ported from
//     tests/engineer/test-state-schema-14.mjs)
//   - the reader's gate enum is engineer's five, whatever a persona can set
//   - a file on disk schema "1.3" may carry the keys, and every writer keeps
//     both its schema and the keys
//   - the writers: append/set-terminal --next-step-*, --clear-next-step,
//     awaiting-owner-set/-clear (one gate at a time, only the gates whose
//     capability is on), finish-verb (terminal for every kind; an owner gate
//     keeps it open), autopilot-preflight (AGENTIC_AUTOPILOT ignored with one
//     line, dispatch_target off; the gate notice)

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const NEW_KEYS = [
  'next_step_kind',
  'next_step_verb',
  'next_step_confidence',
  'awaiting_owner_gate',
  'awaiting_owner_since',
  'awaiting_owner_pointer',
];
const BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

function cliEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AGENTIC_')) delete env[k];
  return env;
}

for (const persona of personasFor('scripts/state.mjs')) {
  const STATE_PATH = personaInfo(persona).path('scripts/state.mjs');
  const {
    SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    VALID_NEXT_STEP_KINDS,
    VALID_CONFIDENCE,
    VALID_WORKFLOW_OWNER_GATES,
    createWorkflow,
    listWorkflowFiles,
    parseWorkflowFile,
    assembleWorkflowFile,
    appendPhase,
    setCheckpoint,
    setTerminal,
    setAwaitingOwner,
    clearAwaitingOwner,
    finishVerb,
    settableOwnerGates,
  } = await import(pathToFileURL(STATE_PATH).href);

  const POINTER = `.agentic-plugins/state/${persona}/workflows/decide-x.md#decision-pending`;

  // A minimal valid frontmatter with `extra` lines after workflow_type, which
  // is where the serializer puts the new keys.
  const fixture = (extra = [], schema = '1.4') => [
    '---',
    `schema: "${schema}"`,
    'workflow_id: "compose-20260930T000000Z-000000"',
    `persona: "${persona}"`,
    'verb: "compose"',
    'profile: ""',
    'original_request: "fixture"',
    'started_at: "2026-09-30T00:00:00Z"',
    'updated_at: "2026-09-30T00:00:00Z"',
    'repo_root: "/tmp/x"',
    'git_baseline:',
    '  branch: "test"',
    '  head: "0000000000000000000000000000000000000000"',
    '  status_digest: ""',
    'current_phase: "phase-0"',
    'next_action: ""',
    'tasks: []',
    'host_history: []',
    'workflow_type: "verb-chain"',
    ...extra,
    '---',
    '',
    `# ${persona}:compose`,
    '',
  ].join('\n');

  const NEXT_VERB = ['next_step_kind: "verb"', 'next_step_verb: "critique"', 'next_step_confidence: "HIGH"'];
  const AWAITING = [
    'awaiting_owner_gate: "decide-conflict"',
    'awaiting_owner_since: "2026-09-30T01:02:03Z"',
    `awaiting_owner_pointer: "${POINTER}"`,
  ];

  async function withRepo(fn) {
    const dir = await mkdtemp(join(tmpdir(), `${persona}-schema14-`));
    try {
      execFileSync('git', ['init', '-q', '-b', 'test'], { cwd: dir, stdio: 'ignore' });
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // A workflow created by this build, then given `extra` keys and `schema` on
  // disk, as an older or a newer writer would leave it.
  async function withGatedFile(schema, extra, fn) {
    await withRepo(async (dir) => {
      await createWorkflow({ repoRoot: dir, verb: 'compose', host: 'claude', persona, gitBaseline: BASELINE, originalRequest: 'schema 1.4' });
      const [filePath] = await listWorkflowFiles(dir);
      const raw = await readFile(filePath, 'utf8');
      const withKeys = raw
        .replace(/^schema: "[^"]*"$/m, `schema: "${schema}"`)
        .replace(/^(workflow_type: "verb-chain")$/m, `$1\n${extra.join('\n')}`);
      ok(withKeys !== raw && extra.every((l) => withKeys.includes(l)), 'the keys went in');
      await writeFile(filePath, withKeys);
      await fn(filePath, dir);
    });
  }

  describe(`${persona}: schema 1.4 — emitted and read`, () => {
    it('"1.4" is supported and emitted; a fresh workflow carries none of the six keys', async () => {
      ok(SUPPORTED_SCHEMA_VERSIONS.has('1.4'));
      strictEqual(SCHEMA_VERSION, '1.4');
      await withRepo(async (dir) => {
        await createWorkflow({ repoRoot: dir, verb: 'compose', host: 'claude', persona, gitBaseline: BASELINE, originalRequest: 'x' });
        const [filePath] = await listWorkflowFiles(dir);
        const raw = await readFile(filePath, 'utf8');
        ok(/^schema: "1\.4"$/m.test(raw), raw);
        for (const k of NEW_KEYS) ok(!new RegExp(`^${k}:`, 'm').test(raw), `${k} absent on create`);
        const r = spawnSync(process.execPath, [STATE_PATH, 'read', '--workflow-path', filePath], { encoding: 'utf8', env: cliEnv() });
        strictEqual(r.status, 0, r.stderr);
        const json = JSON.parse(r.stdout);
        for (const k of NEW_KEYS) strictEqual(k in json, false, `${k} in read JSON`);
      });
    });

    it('the enums are engineer\'s: four kinds, three confidences, five workflow gates', () => {
      deepStrictEqual([...VALID_NEXT_STEP_KINDS], ['verb', 'commit', 'owner-decision', 'done']);
      deepStrictEqual([...VALID_CONFIDENCE], ['HIGH', 'MEDIUM', 'LOW']);
      deepStrictEqual([...VALID_WORKFLOW_OWNER_GATES].sort(), ['decide-conflict', 'pr-handling', 'recurring-finding', 'scope-routing', 'staging-set']);
    });
  });

  describe(`${persona}: schema 1.4 — parser round-trip and rejections`, () => {
    it('round-trips all six keys byte for byte, as known keys rather than carried unknowns', () => {
      const text = fixture([...NEXT_VERB, ...AWAITING]);
      const { frontmatter, body } = parseWorkflowFile(text);
      deepStrictEqual(
        NEW_KEYS.map((k) => frontmatter[k]),
        ['verb', 'critique', 'HIGH', 'decide-conflict', '2026-09-30T01:02:03Z', POINTER],
      );
      // Known keys are visible to `in`; the forward-compat carrier is not.
      for (const k of NEW_KEYS) ok(k in frontmatter, k);
      const block = (t) => t.slice(0, t.indexOf('\n---\n') + 5);
      strictEqual(block(assembleWorkflowFile(frontmatter, body)), block(text));
    });

    it('accepts every next_step kind and confidence, with a verb only for kind=verb', () => {
      for (const kind of ['commit', 'owner-decision', 'done']) {
        for (const c of ['HIGH', 'MEDIUM', 'LOW']) {
          const { frontmatter } = parseWorkflowFile(fixture([`next_step_kind: "${kind}"`, `next_step_confidence: "${c}"`]));
          strictEqual(frontmatter.next_step_kind, kind);
          strictEqual('next_step_verb' in frontmatter, false);
        }
      }
      for (const verb of ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine']) {
        strictEqual(parseWorkflowFile(fixture(['next_step_kind: "verb"', `next_step_verb: "${verb}"`, 'next_step_confidence: "LOW"'])).frontmatter.next_step_verb, verb);
      }
    });

    it('reads every one of the five workflow gates, including those this persona cannot set', () => {
      for (const gate of ['scope-routing', 'decide-conflict', 'recurring-finding', 'staging-set', 'pr-handling']) {
        strictEqual(parseWorkflowFile(fixture([`awaiting_owner_gate: "${gate}"`, ...AWAITING.slice(1)])).frontmatter.awaiting_owner_gate, gate);
      }
    });

    const rejected = [
      ['unknown kind', ['next_step_kind: "ship"', 'next_step_confidence: "HIGH"'], /next_step_kind must be one of/],
      ['unknown confidence', ['next_step_kind: "commit"', 'next_step_confidence: "high"'], /next_step_confidence must be one of/],
      ['non-string kind', ['next_step_kind: true', 'next_step_confidence: "HIGH"'], /next_step_kind must be one of/],
      ['unknown verb', ['next_step_kind: "verb"', 'next_step_verb: "ship"', 'next_step_confidence: "HIGH"'], /next_step_verb must be one of/],
      ['the lifecycle macro as a verb', ['next_step_kind: "verb"', 'next_step_verb: "start"', 'next_step_confidence: "HIGH"'], /next_step_verb must be one of/],
      ['kind without confidence', ['next_step_kind: "commit"'], /present together/],
      ['confidence without kind', ['next_step_confidence: "HIGH"'], /present together/],
      ['kind=verb without a verb', ['next_step_kind: "verb"', 'next_step_confidence: "HIGH"'], /next_step_verb must be present exactly when/],
      ['a verb with kind=commit', ['next_step_kind: "commit"', 'next_step_verb: "compose"', 'next_step_confidence: "HIGH"'], /next_step_verb must be present exactly when/],
      ['a verb with no kind', ['next_step_verb: "compose"'], /next_step_verb must be present exactly when/],
      ['awaiting gate alone', ['awaiting_owner_gate: "decide-conflict"'], /all or none/],
      ['awaiting without pointer', AWAITING.slice(0, 2), /all or none/],
      ['macro-owned gate', ['awaiting_owner_gate: "plan-approval"', ...AWAITING.slice(1)], /awaiting_owner_gate must be one of/],
      ['unstored gate', ['awaiting_owner_gate: "duplicate-workflow"', ...AWAITING.slice(1)], /awaiting_owner_gate must be one of/],
      ['since with milliseconds', [AWAITING[0], 'awaiting_owner_since: "2026-09-30T01:02:03.000Z"', AWAITING[2]], /awaiting_owner_since must be/],
      ['since that is not a date', [AWAITING[0], 'awaiting_owner_since: "2026-02-30T00:00:00Z"', AWAITING[2]], /awaiting_owner_since must be/],
      ['since with an offset', [AWAITING[0], 'awaiting_owner_since: "2026-09-30T01:02:03+09:00"', AWAITING[2]], /awaiting_owner_since must be/],
      ['absolute pointer', [...AWAITING.slice(0, 2), 'awaiting_owner_pointer: "/etc/passwd#x"'], /awaiting_owner_pointer must be/],
      ['pointer with ..', [...AWAITING.slice(0, 2), 'awaiting_owner_pointer: "docs/../x.md#a"'], /awaiting_owner_pointer must be/],
      ['pointer without anchor', [...AWAITING.slice(0, 2), 'awaiting_owner_pointer: "docs/x.md"'], /awaiting_owner_pointer must be/],
      ['pointer with free text', [...AWAITING.slice(0, 2), 'awaiting_owner_pointer: "docs/x.md#see the note"'], /awaiting_owner_pointer must be/],
    ];
    for (const [name, extra, pattern] of rejected) {
      it(`rejects ${name}, on a "1.4" file and on a "1.3" one (validated per key)`, () => {
        throws(() => parseWorkflowFile(fixture(extra)), pattern);
        throws(() => parseWorkflowFile(fixture(extra, '1.3')), pattern);
      });
    }
  });

  describe(`${persona}: schema 1.4 — the keys survive every writer, and no writer changes the disk schema`, () => {
    for (const schema of ['1.3', '1.4']) {
      it(`a "${schema}" file with a next step and a gate keeps both, and its schema, through checkpoint, append and set-terminal`, async () => {
        await withGatedFile(schema, [...NEXT_VERB, ...AWAITING], async (filePath) => {
          const keysOf = async () => {
            const raw = await readFile(filePath, 'utf8');
            const { frontmatter } = parseWorkflowFile(raw);
            strictEqual(frontmatter.schema, schema, 'the disk schema is kept');
            return NEW_KEYS.map((k) => frontmatter[k]);
          };
          const before = await keysOf();
          deepStrictEqual(before, ['verb', 'critique', 'HIGH', 'decide-conflict', '2026-09-30T01:02:03Z', POINTER]);
          await setCheckpoint({ workflowPath: filePath, host: 'claude', summary: 'step' });
          deepStrictEqual(await keysOf(), before, 'checkpoint');
          await appendPhase({ workflowPath: filePath, host: 'codex', phaseLabel: 'Phase 1', phaseNote: 'note', currentPhase: 'phase-1', nextAction: 'next', event: 'updated' });
          deepStrictEqual(await keysOf(), before, 'append');
          await setTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete', nextAction: 'done' });
          deepStrictEqual(await keysOf(), before, 'set-terminal');
        });
      });
    }

    it('a file whose gate fails validation is refused by a writer, which leaves it as it was', async () => {
      await withGatedFile('1.3', ['awaiting_owner_gate: "plan-approval"', ...AWAITING.slice(1)], async (filePath) => {
        const raw = await readFile(filePath, 'utf8');
        let error = null;
        try {
          await appendPhase({ workflowPath: filePath, host: 'claude', phaseLabel: 'P', phaseNote: 'n', currentPhase: 'p', nextAction: 'a', event: 'updated' });
        } catch (err) { error = err; }
        ok(error && /awaiting_owner_gate must be one of/.test(error.message), String(error));
        strictEqual(await readFile(filePath, 'utf8'), raw);
      });
    });
  });
  // ---------------------------------------------------------------------------
  // The writers (PC2b code step 3).

  const cli = (args, env = {}) => spawnSync(process.execPath, [STATE_PATH, ...args], { encoding: 'utf8', env: { ...cliEnv(), ...env } });
  const RUN = 'autopilot-20261006T005001Z-c4e3a4';
  const keysOf = async (filePath) => {
    const { frontmatter } = parseWorkflowFile(await readFile(filePath, 'utf8'));
    return Object.fromEntries(NEW_KEYS.filter((k) => k in frontmatter).map((k) => [k, frontmatter[k]]));
  };
  const fmOf = async (filePath) => parseWorkflowFile(await readFile(filePath, 'utf8')).frontmatter;
  async function withFile(fn) {
    await withRepo(async (dir) => {
      await createWorkflow({ repoRoot: dir, verb: 'decide', host: 'claude', persona, gitBaseline: BASELINE, originalRequest: 'writers' });
      const [filePath] = await listWorkflowFiles(dir);
      await fn(filePath, dir);
    });
  }
  const relPointer = (filePath, dir, anchor) => `${filePath.slice(dir.length + 1)}#${anchor}`;

  describe(`${persona}: schema 1.4 — next-step writes (append / set-terminal)`, () => {
    it('append --next-step-* writes the three keys; a later kind drops the stale verb; --clear-next-step true deletes them', async () => {
      await withFile(async (filePath) => {
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH']).status, 0);
        deepStrictEqual(await keysOf(filePath), { next_step_kind: 'verb', next_step_verb: 'critique', next_step_confidence: 'HIGH' });
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--next-step-kind', 'commit', '--next-step-confidence', 'LOW']).status, 0);
        deepStrictEqual(await keysOf(filePath), { next_step_kind: 'commit', next_step_confidence: 'LOW' });
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--phase-note', 'x']).status, 0);
        deepStrictEqual(await keysOf(filePath), { next_step_kind: 'commit', next_step_confidence: 'LOW' }, 'no flags leave it as it is');
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--clear-next-step', 'false']).status, 0);
        deepStrictEqual(await keysOf(filePath), { next_step_kind: 'commit', next_step_confidence: 'LOW' }, 'false changes nothing');
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--clear-next-step', 'true']).status, 0);
        deepStrictEqual(await keysOf(filePath), {});
      });
    });

    for (const [name, flags, pattern] of [
      ['clear with a next step', ['--clear-next-step', 'true', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH'], /mutually exclusive/],
      ['a verb with kind done', ['--next-step-kind', 'done', '--next-step-verb', 'frame', '--next-step-confidence', 'HIGH'], /next_step_verb must be present exactly when/],
      ['a kind without confidence', ['--next-step-kind', 'done'], /present together/],
      ['a malformed boolean', ['--clear-next-step', 'yes'], /must be 'true' or 'false'/],
      ['a malformed marker boolean', ['--clear-terminal-marker', 'yes'], /--clear-terminal-marker must be 'true' or 'false'/],
    ]) {
      it(`append refuses ${name} and leaves the file untouched`, async () => {
        await withFile(async (filePath) => {
          const before = await readFile(filePath, 'utf8');
          const r = cli(['append', '--workflow-path', filePath, '--host', 'claude', ...flags]);
          strictEqual(r.status, 1, r.stderr);
          ok(pattern.test(r.stderr), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before);
        });
      });
    }

    // PC2b U5b: a refine or start that did not converge records its next step
    // and turns off a terminal marker an earlier verb left, in one write, so
    // the Stop hook cannot archive the unresolved workflow.
    it('append --clear-terminal-marker true turns an inherited terminal marker off with the next step; false and absent leave it on', async () => {
      await withFile(async (filePath) => {
        const marked = () => cli(['set-terminal', '--workflow-path', filePath, '--host', 'claude', '--terminal-phase', 'summary-complete']);
        strictEqual(marked().status, 0);
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--phase-note', 'x']).status, 0);
        strictEqual((await fmOf(filePath)).terminal_marker, true, 'absent leaves it on');
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--clear-terminal-marker', 'false']).status, 0);
        strictEqual((await fmOf(filePath)).terminal_marker, true, 'false leaves it on');
        strictEqual(cli(['append', '--workflow-path', filePath, '--host', 'claude', '--current-phase', 'phase-2-presented', '--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'MEDIUM', '--clear-terminal-marker', 'true']).status, 0);
        const f = await fmOf(filePath);
        deepStrictEqual([f.current_phase, f.terminal_marker, f.next_step_kind, f.next_step_verb], ['phase-2-presented', false, 'verb', 'refine']);
      });
    });

    it('set-terminal --next-step-* records the next step with the terminal write', async () => {
      await withFile(async (filePath) => {
        strictEqual(cli(['set-terminal', '--workflow-path', filePath, '--host', 'claude', '--terminal-phase', 'summary-complete', '--next-step-kind', 'done', '--next-step-confidence', 'MEDIUM']).status, 0);
        const f = await fmOf(filePath);
        deepStrictEqual([f.current_phase, f.terminal_marker, f.next_step_kind, f.next_step_confidence], ['summary-complete', true, 'done', 'MEDIUM']);
      });
    });
  });

  describe(`${persona}: schema 1.4 — owner gates (awaiting-owner-set / -clear)`, () => {
    it('only the gates whose capability is on can be set: the three, never staging-set or pr-handling', () => {
      deepStrictEqual([...settableOwnerGates()].sort(), ['decide-conflict', 'recurring-finding', 'scope-routing']);
    });

    it('set writes the three keys from an anchor; since defaults to now; an inherited terminal marker turns off', async () => {
      await withFile(async (filePath, dir) => {
        await setTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete' });
        const r = cli(['awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude', '--gate', 'decide-conflict', '--anchor', 'ensemble-synthesis']);
        strictEqual(r.status, 0, r.stderr);
        const f = await fmOf(filePath);
        deepStrictEqual([f.awaiting_owner_gate, f.awaiting_owner_pointer, f.terminal_marker], ['decide-conflict', relPointer(filePath, dir, 'ensemble-synthesis'), false]);
        ok(Math.abs(Date.parse(f.awaiting_owner_since) - Date.now()) < 60_000, f.awaiting_owner_since);
      });
    });

    it('re-setting the same gate replaces pointer and since; a different gate is refused, the file untouched', async () => {
      await withFile(async (filePath, dir) => {
        strictEqual(cli(['awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'a', '--since', '2026-10-01T00:00:00Z']).status, 0);
        strictEqual(cli(['awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'b', '--since', '2026-10-02T00:00:00Z']).status, 0);
        deepStrictEqual(await keysOf(filePath), { awaiting_owner_gate: 'scope-routing', awaiting_owner_since: '2026-10-02T00:00:00Z', awaiting_owner_pointer: relPointer(filePath, dir, 'b') });
        const before = await readFile(filePath, 'utf8');
        const r = cli(['awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude', '--gate', 'decide-conflict', '--anchor', 'c']);
        strictEqual(r.status, 1);
        ok(/owner gate scope-routing is already set/.test(r.stderr), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    for (const [gate, capability] of [['staging-set', 'commit_surface'], ['pr-handling', 'dispatch_target']]) {
      it(`${gate} is refused, naming ${capability} — by the CLI, by finish-verb and by the programmatic path`, async () => {
        await withFile(async (filePath) => {
          const before = await readFile(filePath, 'utf8');
          const message = new RegExp(`cannot set the owner gate ${gate}: it belongs to ${capability}`);
          const r = cli(['awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude', '--gate', gate, '--anchor', 'x']);
          strictEqual(r.status, 1);
          ok(message.test(r.stderr), r.stderr);
          const f = cli(['finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action', 'n', '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', gate, '--owner-gate-anchor', 'x']);
          strictEqual(f.status, 1);
          ok(message.test(f.stderr), f.stderr);
          await rejects(setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate, anchor: 'x' }), message);
          await rejects(appendPhase({ workflowPath: filePath, host: 'claude', ownerGate: { gate, anchor: 'x' } }), message);
          strictEqual(await readFile(filePath, 'utf8'), before);
        });
      });
    }

    it('clear deletes the keys, records the resolution as a phase note and writes the next step in the same write', async () => {
      await withFile(async (filePath, dir) => {
        await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis', since: '2026-10-01T00:00:00Z' });
        await appendPhase({ workflowPath: filePath, host: 'claude', nextStep: { kind: 'owner-decision', confidence: 'HIGH' } });
        const r = cli(['awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', 'decide-conflict',
          '--next-step-kind', 'verb', '--next-step-verb', 'compose', '--next-step-confidence', 'HIGH', '--resolution', 'Direction B, for its reversibility.'], { AGENTIC_AUTOPILOT: RUN });
        strictEqual(r.status, 0, `AGENTIC_AUTOPILOT is ignored: ${r.stderr}`);
        deepStrictEqual(await keysOf(filePath), { next_step_kind: 'verb', next_step_verb: 'compose', next_step_confidence: 'HIGH' });
        const text = await readFile(filePath, 'utf8');
        ok(/### Owner gate resolved: decide-conflict at \S+\n\nDirection B, for its reversibility\.\n\nCleared awaiting_owner \(since 2026-10-01T00:00:00Z, pointer /.test(text), text.slice(-400));
        ok(text.includes(relPointer(filePath, dir, 'ensemble-synthesis')));
      });
    });

    it('clear refuses a gate that is not the one set, and when none is set', async () => {
      await withFile(async (filePath) => {
        const none = cli(['awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', 'scope-routing']);
        strictEqual(none.status, 1);
        ok(/no owner gate is set/.test(none.stderr), none.stderr);
        await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'recurring-finding', anchor: 'x' });
        const other = cli(['awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', 'scope-routing']);
        strictEqual(other.status, 1);
        ok(/is recurring-finding, not scope-routing/.test(other.stderr), other.stderr);
        strictEqual((await fmOf(filePath)).awaiting_owner_gate, 'recurring-finding');
      });
    });
  });

  describe(`${persona}: schema 1.4 — finish-verb (commit_surface off, dispatch_target off)`, () => {
    for (const [kind, verb] of [['verb', 'critique'], ['commit', null], ['done', null], ['owner-decision', null]]) {
      it(`kind ${kind} closes the workflow: summary-complete with the terminal marker and the next step`, async () => {
        await withFile(async (filePath) => {
          const flags = ['--next-step-kind', kind, '--next-step-confidence', 'HIGH', ...(verb ? ['--next-step-verb', verb] : [])];
          const r = cli(['finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action', 'Publish the plan', ...flags]);
          strictEqual(r.status, 0, r.stderr);
          const f = await fmOf(filePath);
          deepStrictEqual([f.current_phase, f.terminal_marker, f.next_action, f.next_step_kind, f.next_step_verb], ['summary-complete', true, 'Publish the plan', kind, verb ?? undefined]);
        });
      });
    }

    it('an inherited AGENTIC_AUTOPILOT does not suppress the terminal write (acceptance)', async () => {
      await withFile(async (filePath) => {
        const r = cli(['finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action', 'n', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH'], { AGENTIC_AUTOPILOT: RUN });
        strictEqual(r.status, 0, r.stderr);
        const f = await fmOf(filePath);
        deepStrictEqual([f.current_phase, f.terminal_marker], ['summary-complete', true]);
        const t = cli(['set-terminal', '--workflow-path', filePath, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true'], { AGENTIC_AUTOPILOT: RUN });
        strictEqual(t.status, 0, `set-terminal true is accepted: ${t.stderr}`);
      });
    });

    it('with an owner gate: recorded with owner-decision in one write, an inherited marker turned off, not terminal', async () => {
      await withFile(async (filePath, dir) => {
        await setTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete' });
        const r = cli(['finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action', 'The owner selects a direction',
          '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis'], { AGENTIC_AUTOPILOT: RUN });
        strictEqual(r.status, 0, r.stderr);
        ok(/owner gate decide-conflict recorded; the workflow stays open/.test(r.stderr), r.stderr);
        const f = await fmOf(filePath);
        deepStrictEqual(
          [f.terminal_marker, f.next_step_kind, f.awaiting_owner_gate, f.awaiting_owner_pointer, f.next_action],
          [false, 'owner-decision', 'decide-conflict', relPointer(filePath, dir, 'ensemble-synthesis'), 'The owner selects a direction'],
        );
      });
    });

    for (const [name, flags, pattern] of [
      ['a gate with kind verb', ['--next-step-kind', 'verb', '--next-step-verb', 'frame', '--next-step-confidence', 'HIGH', '--owner-gate', 'scope-routing', '--owner-gate-anchor', 'r'], /an owner gate goes with the next step owner-decision/],
      ['a gate without its anchor', ['--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'scope-routing'], /go together/],
      ['no next step', [], /Missing required flags: --next-step-kind, --next-step-confidence/],
    ]) {
      it(`refuses ${name} before writing`, async () => {
        await withFile(async (filePath) => {
          const before = await readFile(filePath, 'utf8');
          const r = cli(['finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action', 'n', ...flags]);
          strictEqual(r.status, 1, r.stderr);
          ok(pattern.test(r.stderr), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before);
        });
      });
    }

    it('a file on disk schema "1.3" keeps "1.3" through finish-verb and the gate writers', async () => {
      await withGatedFile('1.3', [], async (filePath) => {
        await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'scope-routing', anchor: 'r' });
        await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'done', confidence: 'HIGH' } });
        await finishVerb({ workflowPath: filePath, host: 'claude', nextAction: 'n', nextStep: { kind: 'verb', verb: 'frame', confidence: 'LOW' } });
        const f = await fmOf(filePath);
        deepStrictEqual([f.schema, f.next_step_verb, f.terminal_marker], ['1.3', 'frame', true]);
      });
    });
  });

  describe(`${persona}: autopilot-preflight (ADR-0066 Decision 3: dispatch_target off)`, () => {
    it('interactive with no gate: silent, exit 0', async () => {
      await withFile(async (filePath) => {
        const r = cli(['autopilot-preflight', '--workflow-path', filePath, '--host', 'claude']);
        deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
      });
    });

    it('an inherited AGENTIC_AUTOPILOT: one line saying it is ignored, exit 0, and nothing written', async () => {
      await withFile(async (filePath) => {
        const before = await readFile(filePath, 'utf8');
        const r = cli(['autopilot-preflight', '--workflow-path', filePath, '--host', 'claude'], { AGENTIC_AUTOPILOT: RUN });
        strictEqual(r.status, 0);
        strictEqual(r.stdout, '');
        strictEqual(r.stderr, `AGENTIC_AUTOPILOT=${RUN} is ignored: ${persona} is not an autopilot dispatch target (dispatch_target off, ADR-0066 Decision 3); this command runs interactively.\n`);
        strictEqual(await readFile(filePath, 'utf8'), before);
        for (const value of ['1', 'true', 'autopilot']) {
          const m = cli(['autopilot-preflight', '--workflow-path', filePath], { AGENTIC_AUTOPILOT: value });
          deepStrictEqual([m.status, m.stderr], [0, ''], `a malformed value ${value} is no run`);
        }
      });
    });

    it('a gate set: the notice names the gate, its pointer and its resolving surface in this persona, never a refusal', async () => {
      await withFile(async (filePath, dir) => {
        await setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis' });
        for (const [host, prefix] of [['claude', `/${persona}:`], ['codex', `$${persona}:`]]) {
          const r = cli(['autopilot-preflight', '--workflow-path', filePath, '--host', host], { AGENTIC_AUTOPILOT: RUN });
          strictEqual(r.status, 0, 'never refuses: dispatch_target off');
          ok(r.stdout.startsWith(`Owner gate decide-conflict is pending since `), r.stdout);
          ok(r.stdout.includes(relPointer(filePath, dir, 'ensemble-synthesis')), r.stdout);
          ok(r.stdout.includes(`selects a direction in ${prefix}decide, whose Owner selection step clears the gate`), r.stdout);
          ok(r.stdout.includes(`awaiting-owner-clear --workflow-path "${filePath}" --host ${host} --gate decide-conflict`), r.stdout);
          ok(/is ignored/.test(r.stderr), r.stderr);
        }
      });
    });
  });
}
