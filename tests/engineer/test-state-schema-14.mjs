// plugins/engineer/scripts/state.mjs — ADR-0063 D6 schema 1.4: the flat
// next_step_* and awaiting_owner_* scalars.
//
// Covers:
//   - schema 1.4 emit; a fresh file carries none of the six keys (absent = null)
//   - round-trip of every new key through parse → assemble → parse
//   - enum, format and co-presence rejections at the parser
//   - append / set-terminal --next-step-* (all three keys replaced at once),
//     --clear-next-step, and inconsistent input refused before any write
//   - awaiting-owner-set / awaiting-owner-clear, including the gate
//     mismatch, the different-gate refusal and the refusal under autopilot
//   - a file on disk schema 1.3 keeps schema "1.3" after a next_step write
//   - isAutopilotRun: on only for a well-formed run id
//
// The 1.3-era reader round-trip lives in test-state-schema-forward-compat.mjs.
//
// Run via `node --test tests/engineer/test-state-schema-14.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, throws, rejects, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  createWorkflow,
  listWorkflowFiles,
  parseWorkflowFile,
  assembleWorkflowFile,
  readWorkflow,
  appendPhase,
  setTerminal,
  setAwaitingOwner,
  clearAwaitingOwner,
  isAutopilotRun,
} = await import(STATE_PATH);

const NEW_KEYS = [
  'next_step_kind',
  'next_step_verb',
  'next_step_confidence',
  'awaiting_owner_gate',
  'awaiting_owner_since',
  'awaiting_owner_pointer',
];
const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const POINTER = '.agentic-plugins/state/engineer/workflows/decide-x.md#decision-pending';

// The CLI child must not inherit an AGENTIC_AUTOPILOT from whoever runs the
// suite (an autopilot worker would), or every clear below would be refused.
function cliEnv(extra = {}, base = process.env) {
  const env = { ...base };
  delete env.AGENTIC_AUTOPILOT;
  return { ...env, ...extra };
}

function runCli(args, { env = cliEnv() } = {}) {
  return spawnSync('node', [STATE_PATH, ...args], { encoding: 'utf8', env });
}

function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withWorkflow(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-schema14-'));
  try {
    gitInit(dir, 'test');
    await createWorkflow({
      repoRoot: dir, verb: 'compose', host: 'claude',
      gitBaseline: MIN_BASELINE,
      originalRequest: 'schema 1.4',
    });
    const [filePath] = await listWorkflowFiles(dir);
    await fn(filePath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

// A minimal valid frontmatter with `extra` lines inserted after
// workflow_type, which is where the serializer puts the new keys.
function fixture(extra = []) {
  return [
    '---',
    'schema: "1.4"',
    'workflow_id: "compose-20260930T000000Z-000000"',
    'persona: "engineer"',
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
    '# engineer:compose',
    '',
  ].join('\n');
}

const NEXT_VERB = [
  'next_step_kind: "verb"',
  'next_step_verb: "critique"',
  'next_step_confidence: "HIGH"',
];
const AWAITING = [
  'awaiting_owner_gate: "decide-conflict"',
  'awaiting_owner_since: "2026-09-30T01:02:03Z"',
  `awaiting_owner_pointer: "${POINTER}"`,
];

// -----------------------------------------------------------------------------

describe('schema 1.4 — emit and absent-means-null', () => {
  it('SCHEMA_VERSION is "1.4" and createWorkflow writes it', async () => {
    strictEqual(SCHEMA_VERSION, '1.4');
    await withWorkflow(async (filePath) => {
      const raw = await readFile(filePath, 'utf8');
      ok(/^schema: "1\.4"$/m.test(raw), raw);
    });
  });

  it('a fresh workflow carries none of the six keys, on disk or in `read`', async () => {
    await withWorkflow(async (filePath) => {
      const raw = await readFile(filePath, 'utf8');
      for (const k of NEW_KEYS) {
        ok(!new RegExp(`^${k}:`, 'm').test(raw), `${k} must be absent on create`);
      }
      const r = runCli(['read', '--workflow-path', filePath]);
      strictEqual(r.status, 0, r.stderr);
      const json = JSON.parse(r.stdout);
      for (const k of NEW_KEYS) strictEqual(k in json, false, `${k} in read JSON`);
    });
  });
});

describe('schema 1.4 — parser round-trip and rejections', () => {
  it('round-trips all six keys byte for byte', () => {
    const text = fixture([...NEXT_VERB, ...AWAITING]);
    const { frontmatter, body } = parseWorkflowFile(text);
    strictEqual(frontmatter.next_step_kind, 'verb');
    strictEqual(frontmatter.next_step_verb, 'critique');
    strictEqual(frontmatter.next_step_confidence, 'HIGH');
    strictEqual(frontmatter.awaiting_owner_gate, 'decide-conflict');
    strictEqual(frontmatter.awaiting_owner_since, '2026-09-30T01:02:03Z');
    strictEqual(frontmatter.awaiting_owner_pointer, POINTER);
    // The frontmatter block only: parse → assemble adds one blank line
    // before the body whatever the keys (a separate, pre-existing trait).
    const block = (t) => t.slice(0, t.indexOf('\n---\n') + 5);
    strictEqual(block(assembleWorkflowFile(frontmatter, body)), block(text));
  });

  it('accepts every next_step kind and confidence, with a verb only for kind=verb', () => {
    for (const kind of ['commit', 'owner-decision', 'done']) {
      for (const c of ['HIGH', 'MEDIUM', 'LOW']) {
        const { frontmatter } = parseWorkflowFile(fixture([
          `next_step_kind: "${kind}"`, `next_step_confidence: "${c}"`,
        ]));
        strictEqual(frontmatter.next_step_kind, kind);
        strictEqual('next_step_verb' in frontmatter, false);
      }
    }
  });

  const rejected = [
    ['unknown kind', ['next_step_kind: "ship"', 'next_step_confidence: "HIGH"'], /next_step_kind must be one of/],
    ['unknown confidence', ['next_step_kind: "commit"', 'next_step_confidence: "high"'], /next_step_confidence must be one of/],
    ['non-string kind', ['next_step_kind: true', 'next_step_confidence: "HIGH"'], /next_step_kind must be one of/],
    ['unknown verb', ['next_step_kind: "verb"', 'next_step_verb: "ship"', 'next_step_confidence: "HIGH"'], /next_step_verb must be one of/],
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
    it(`rejects ${name}`, () => {
      throws(() => parseWorkflowFile(fixture(extra)), pattern);
    });
  }
});

describe('schema 1.4 — next_step writes (append / set-terminal)', () => {
  it('append --next-step-* writes the three keys; a later kind drops the stale verb', async () => {
    await withWorkflow(async (filePath) => {
      let r = runCli([
        'append', '--workflow-path', filePath, '--host', 'claude', '--event', 'updated',
        '--next-step-kind', 'verb', '--next-step-verb', 'critique',
        '--next-step-confidence', 'HIGH',
      ]);
      strictEqual(r.status, 0, r.stderr);
      let { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.next_step_kind, 'verb');
      strictEqual(frontmatter.next_step_verb, 'critique');
      strictEqual(frontmatter.next_step_confidence, 'HIGH');

      r = runCli([
        'append', '--workflow-path', filePath, '--host', 'claude', '--event', 'updated',
        '--next-step-kind', 'commit', '--next-step-confidence', 'MEDIUM',
      ]);
      strictEqual(r.status, 0, r.stderr);
      ({ frontmatter } = await readWorkflow(filePath));
      strictEqual(frontmatter.next_step_kind, 'commit');
      strictEqual(frontmatter.next_step_confidence, 'MEDIUM');
      strictEqual('next_step_verb' in frontmatter, false, 'the verb must go with kind=verb');
    });
  });

  it('the JS API takes the logical shape: verb null for a non-verb kind', async () => {
    await withWorkflow(async (filePath) => {
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        nextStep: { kind: 'owner-decision', verb: null, confidence: 'LOW' },
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.next_step_kind, 'owner-decision');
      strictEqual('next_step_verb' in frontmatter, false);
    });
  });

  it('append without next-step flags leaves next_step as it is', async () => {
    await withWorkflow(async (filePath) => {
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        nextStep: { kind: 'done', confidence: 'HIGH' },
      });
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        phaseLabel: 'unrelated', phaseNote: 'no next-step flags',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.next_step_kind, 'done');
      strictEqual(frontmatter.next_step_confidence, 'HIGH');
    });
  });

  it('append --clear-next-step true deletes all three keys', async () => {
    await withWorkflow(async (filePath) => {
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        nextStep: { kind: 'verb', verb: 'refine', confidence: 'LOW' },
      });
      const r = runCli([
        'append', '--workflow-path', filePath, '--host', 'claude',
        '--phase-label', 'Phase 0: Resume into critique', '--clear-next-step', 'true',
      ]);
      strictEqual(r.status, 0, r.stderr);
      const raw = await readFile(filePath, 'utf8');
      for (const k of ['next_step_kind', 'next_step_verb', 'next_step_confidence']) {
        ok(!new RegExp(`^${k}:`, 'm').test(raw), `${k} must be cleared`);
      }
      // Clearing an already-absent next step is a plain append.
      const again = runCli([
        'append', '--workflow-path', filePath, '--host', 'claude', '--clear-next-step', 'true',
      ]);
      strictEqual(again.status, 0, again.stderr);
    });
  });

  it('append --clear-next-step false changes nothing, alone or with a next step', async () => {
    await withWorkflow(async (filePath) => {
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        nextStep: { kind: 'verb', verb: 'refine', confidence: 'LOW' },
      });
      let r = runCli([
        'append', '--workflow-path', filePath, '--host', 'claude', '--clear-next-step', 'false',
      ]);
      strictEqual(r.status, 0, r.stderr);
      let { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.next_step_kind, 'verb');
      strictEqual(frontmatter.next_step_verb, 'refine');
      r = runCli([
        'append', '--workflow-path', filePath, '--host', 'claude', '--clear-next-step', 'false',
        '--next-step-kind', 'done', '--next-step-confidence', 'HIGH',
      ]);
      strictEqual(r.status, 0, r.stderr);
      ({ frontmatter } = await readWorkflow(filePath));
      strictEqual(frontmatter.next_step_kind, 'done');
    });
  });

  it('set-terminal --next-step-* records the next step with the terminal write', async () => {
    await withWorkflow(async (filePath) => {
      const r = runCli([
        'set-terminal', '--workflow-path', filePath, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'false',
        '--next-step-kind', 'verb', '--next-step-verb', 'critique',
        '--next-step-confidence', 'HIGH',
      ]);
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.current_phase, 'summary-complete');
      strictEqual(frontmatter.next_step_kind, 'verb');
      strictEqual(frontmatter.next_step_verb, 'critique');
      strictEqual(frontmatter.next_step_confidence, 'HIGH');
    });
  });

  const refused = [
    ['kind without confidence', ['--next-step-kind', 'commit'], /present together/],
    ['confidence without kind', ['--next-step-confidence', 'HIGH'], /kind is required/],
    ['kind=verb without a verb', ['--next-step-kind', 'verb', '--next-step-confidence', 'HIGH'], /exactly when/],
    ['a verb with kind=done', ['--next-step-kind', 'done', '--next-step-verb', 'compose', '--next-step-confidence', 'HIGH'], /exactly when/],
    ['an unknown kind', ['--next-step-kind', 'ship', '--next-step-confidence', 'HIGH'], /must be one of/],
    ['clear and write together', ['--clear-next-step', 'true', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH'], /mutually exclusive/],
    ['a non-boolean clear', ['--clear-next-step', 'tru'], /must be 'true' or 'false'/],
  ];
  for (const [name, flags, pattern] of refused) {
    it(`append refuses ${name} and leaves the file untouched`, async () => {
      await withWorkflow(async (filePath) => {
        await appendPhase({
          workflowPath: filePath, host: 'claude', event: 'updated',
          nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' },
        });
        const before = await readFile(filePath, 'utf8');
        const r = runCli(['append', '--workflow-path', filePath, '--host', 'claude', ...flags]);
        strictEqual(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
        ok(pattern.test(r.stderr), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  }

  it('set-terminal refuses an inconsistent next step before writing', async () => {
    await withWorkflow(async (filePath) => {
      const before = await readFile(filePath, 'utf8');
      await rejects(
        setTerminal({
          workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete',
          nextStep: { kind: 'verb', confidence: 'HIGH' },
        }),
        /exactly when/,
      );
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('a file on disk schema "1.3" keeps "1.3" through every 1.4 writer', async () => {
    await withWorkflow(async (filePath) => {
      const raw = await readFile(filePath, 'utf8');
      const legacy = raw.replace(/^schema: "1\.4"$/m, 'schema: "1.3"');
      ok(legacy !== raw, 'fixture must start at schema 1.3');
      await writeFile(filePath, legacy);
      const writers = [
        ['append', () => appendPhase({
          workflowPath: filePath, host: 'claude', event: 'updated',
          nextStep: { kind: 'commit', confidence: 'HIGH' },
        })],
        ['set-terminal', () => setTerminal({
          workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete',
          terminalMarker: false, nextStep: { kind: 'done', confidence: 'HIGH' },
        })],
        ['awaiting-owner-set', () => setAwaitingOwner({
          workflowPath: filePath, host: 'claude', gate: 'staging-set', pointer: POINTER,
        })],
        ['awaiting-owner-clear', () => clearAwaitingOwner({
          workflowPath: filePath, host: 'claude', gate: 'staging-set', env: {},
        })],
      ];
      for (const [name, write] of writers) {
        await write();
        const { frontmatter } = await readWorkflow(filePath);
        strictEqual(frontmatter.schema, '1.3', `${name} must not promote the schema`);
      }
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.next_step_kind, 'done');
    });
  });
});

describe('schema 1.4 — awaiting-owner-set / awaiting-owner-clear', () => {
  it('set writes the three keys; since defaults to now', async () => {
    await withWorkflow(async (filePath) => {
      const before = Math.floor(Date.now() / 1000) * 1000;
      const r = runCli([
        'awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude',
        '--gate', 'decide-conflict', '--pointer', POINTER,
      ]);
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.awaiting_owner_gate, 'decide-conflict');
      strictEqual(frontmatter.awaiting_owner_pointer, POINTER);
      ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(frontmatter.awaiting_owner_since));
      const since = Date.parse(frontmatter.awaiting_owner_since);
      ok(since >= before && since <= Date.now(), `since ${frontmatter.awaiting_owner_since} is not now`);
      strictEqual(frontmatter.host_history.at(-1).event, 'updated');
    });
  });

  it('set with --since records it; re-setting the same gate replaces pointer and since', async () => {
    await withWorkflow(async (filePath) => {
      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'staging-set',
        pointer: 'a.md#one', since: '2026-09-30T01:00:00Z',
      });
      const r = runCli([
        'awaiting-owner-set', '--workflow-path', filePath, '--host', 'codex',
        '--gate', 'staging-set', '--pointer', 'b.md#two', '--since', '2026-09-30T02:00:00Z',
      ]);
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.awaiting_owner_pointer, 'b.md#two');
      strictEqual(frontmatter.awaiting_owner_since, '2026-09-30T02:00:00Z');
    });
  });

  it('every engineer gate can be set and cleared, and clearing leaves next_step alone', async () => {
    await withWorkflow(async (filePath) => {
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        nextStep: { kind: 'owner-decision', confidence: 'MEDIUM' },
      });
      for (const gate of [
        'scope-routing', 'decide-conflict', 'recurring-finding', 'staging-set', 'pr-handling',
      ]) {
        let r = runCli([
          'awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude',
          '--gate', gate, '--pointer', POINTER,
        ]);
        strictEqual(r.status, 0, `${gate}: ${r.stderr}`);
        strictEqual((await readWorkflow(filePath)).frontmatter.awaiting_owner_gate, gate);
        r = runCli([
          'awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', gate,
        ]);
        strictEqual(r.status, 0, `${gate}: ${r.stderr}`);
        const { frontmatter } = await readWorkflow(filePath);
        strictEqual('awaiting_owner_gate' in frontmatter, false, gate);
        strictEqual(frontmatter.next_step_kind, 'owner-decision', `${gate} clear kept next_step`);
        strictEqual(frontmatter.next_step_confidence, 'MEDIUM', `${gate} clear kept next_step`);
      }
    });
  });

  it('set refuses a different gate while one is set, leaving the file untouched', async () => {
    await withWorkflow(async (filePath) => {
      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'decide-conflict', pointer: POINTER,
      });
      const before = await readFile(filePath, 'utf8');
      const r = runCli([
        'awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude',
        '--gate', 'pr-handling', '--pointer', POINTER,
      ]);
      strictEqual(r.status, 1, r.stderr);
      ok(/decide-conflict is already set/.test(r.stderr), r.stderr);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('set refuses gates engineer does not store and malformed pointer/since', async () => {
    await withWorkflow(async (filePath) => {
      const before = await readFile(filePath, 'utf8');
      for (const [gate, pointer, since] of [
        ['plan-approval', POINTER, undefined],
        ['plan-conflict', POINTER, undefined],
        ['duplicate-workflow', POINTER, undefined],
        ['merge-conflict', POINTER, undefined],
        ['decide-conflict', '/abs/x.md#a', undefined],
        ['decide-conflict', POINTER, '2026-09-30'],
      ]) {
        const args = [
          'awaiting-owner-set', '--workflow-path', filePath, '--host', 'claude',
          '--gate', gate, '--pointer', pointer,
        ];
        if (since) args.push('--since', since);
        const r = runCli(args);
        strictEqual(r.status, 1, `${gate} ${pointer} ${since}: ${r.stderr}`);
      }
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('clear deletes the keys and records the resolution as a phase note', async () => {
    await withWorkflow(async (filePath) => {
      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'decide-conflict',
        pointer: POINTER, since: '2026-09-30T01:02:03Z',
      });
      const r = runCli([
        'awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude',
        '--gate', 'decide-conflict',
      ]);
      strictEqual(r.status, 0, r.stderr);
      const raw = await readFile(filePath, 'utf8');
      for (const k of ['awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer']) {
        ok(!new RegExp(`^${k}:`, 'm').test(raw), `${k} must be cleared`);
      }
      const { body } = parseWorkflowFile(raw);
      ok(
        /^### Owner gate resolved: decide-conflict at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m.test(body),
        body,
      );
      ok(body.includes(`since 2026-09-30T01:02:03Z, pointer ${POINTER}`), body);
    });
  });

  it('clear refuses a gate that is not the one set, and when none is set', async () => {
    await withWorkflow(async (filePath) => {
      let before = await readFile(filePath, 'utf8');
      let r = runCli([
        'awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude',
        '--gate', 'decide-conflict',
      ]);
      strictEqual(r.status, 1, r.stderr);
      ok(/no owner gate is set/.test(r.stderr), r.stderr);
      strictEqual(await readFile(filePath, 'utf8'), before);

      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'recurring-finding', pointer: POINTER,
      });
      before = await readFile(filePath, 'utf8');
      r = runCli([
        'awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude',
        '--gate', 'decide-conflict',
      ]);
      strictEqual(r.status, 1, r.stderr);
      ok(/is recurring-finding, not decide-conflict/.test(r.stderr), r.stderr);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('clear is refused under autopilot and leaves the gate set', async () => {
    await withWorkflow(async (filePath) => {
      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'decide-conflict', pointer: POINTER,
      });
      const before = await readFile(filePath, 'utf8');
      const r = runCli(
        ['awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', 'decide-conflict'],
        { env: cliEnv({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }) },
      );
      strictEqual(r.status, 1, r.stderr);
      ok(/refused under autopilot/.test(r.stderr), r.stderr);
      strictEqual(await readFile(filePath, 'utf8'), before);
      await rejects(
        clearAwaitingOwner({
          workflowPath: filePath, host: 'claude', gate: 'decide-conflict',
          env: { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID },
        }),
        /refused under autopilot/,
      );
    });
  });

  it('a malformed AGENTIC_AUTOPILOT does not turn autopilot on: clear proceeds', async () => {
    await withWorkflow(async (filePath) => {
      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'pr-handling', pointer: POINTER,
      });
      const r = runCli(
        ['awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', 'pr-handling'],
        { env: cliEnv({ AGENTIC_AUTOPILOT: '1' }) },
      );
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual('awaiting_owner_gate' in frontmatter, false);
    });
  });
});

describe('schema 1.4 — a body that ends without a newline', () => {
  // Only a hand-edited file ends this way; every body this script writes ends
  // with a newline. The heading must still start its own line.
  async function stripFinalNewlines(filePath) {
    const raw = await readFile(filePath, 'utf8');
    const stripped = raw.replace(/\n+$/, '');
    ok(stripped !== raw && !stripped.endsWith('\n'));
    await writeFile(filePath, stripped);
  }

  it('awaiting-owner-clear puts its resolution heading on its own line', async () => {
    await withWorkflow(async (filePath) => {
      await setAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'decide-conflict', pointer: POINTER,
      });
      await stripFinalNewlines(filePath);
      await clearAwaitingOwner({
        workflowPath: filePath, host: 'claude', gate: 'decide-conflict', env: {},
      });
      const { body } = parseWorkflowFile(await readFile(filePath, 'utf8'));
      ok(/^### Owner gate resolved: decide-conflict at /m.test(body), body);
    });
  });

  it('append puts its phase heading on its own line', async () => {
    await withWorkflow(async (filePath) => {
      await stripFinalNewlines(filePath);
      await appendPhase({
        workflowPath: filePath, host: 'claude', event: 'updated',
        phaseLabel: 'Phase 1: after a hand edit', phaseNote: 'note',
      });
      const { body } = parseWorkflowFile(await readFile(filePath, 'utf8'));
      ok(/^### Phase 1: after a hand edit$/m.test(body), body);
    });
  });
});

describe('isAutopilotRun — ADR-0063 §0.2', () => {
  it('is on only for a well-formed run id', () => {
    strictEqual(isAutopilotRun({ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }), true);
    for (const v of [
      undefined, '', '1', 'true', 'autopilot',
      'autopilot-20260930T010203Z-ABCDEF',
      'autopilot-20260930T010203Z-abcde',
      'autopilot-20260930T010203-abcdef',
      ` ${AUTOPILOT_RUN_ID}`,
      `${AUTOPILOT_RUN_ID}\n`,
      'consensus-20260930T010203Z-abcdef',
    ]) {
      strictEqual(isAutopilotRun({ AGENTIC_AUTOPILOT: v }), false, JSON.stringify(v));
    }
    strictEqual(isAutopilotRun({}), false);
  });

  it('the CLI env drops an AGENTIC_AUTOPILOT the runner carries', () => {
    const planted = { PATH: '/usr/bin', AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
    deepStrictEqual(cliEnv({}, planted), { PATH: '/usr/bin' });
  });
});
