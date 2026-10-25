// C96 — the orchestrator's copies of the peer snapshot libraries, and (C93)
// of the CLI exit helper.
//
// A plugin may not import another's script (ADR-0010 §5), and the
// persona-pipeline manifest generates only into personas (ADR-0066), so
// plugins/orchestrator/scripts/lib/{peer-snapshot,process-identity,cli-entry}.mjs
// are copies of the persona-pipeline sources: a three-line copy notice, then
// the source byte for byte. One owner-record schema, worktree lock reason and
// reclaim rule must hold across the four plugins, since a reclaim run by any
// of them judges the others' snapshots, and every CLI of the four exits the
// same way, once its output has drained (the owner's discussion-2 decision
// R2): a copy that drifts fails here, naming the file.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIBS = ['peer-snapshot.mjs', 'process-identity.mjs', 'cli-entry.mjs'];
// The orchestrator CLIs and hooks that exit through the cli-entry copy, each
// with the import specifier its directory reaches the copy by.
const CLI_ENTRY_CONSUMERS = [
  ...['dispatch-peer.mjs', 'peer-runner.mjs', 'session-handoff.mjs', 'discover-engineer.mjs', 'discover-runtime.mjs']
    .map((rel) => ({ rel: `scripts/${rel}`, specifier: './lib/cli-entry.mjs' })),
  ...['claude', 'codex'].flatMap((host) => ['pre-compact.mjs', 'session-start.mjs', 'stop.mjs']
    .map((hook) => ({ rel: `adapters/${host}/hooks/${hook}`, specifier: '../../../scripts/lib/cli-entry.mjs' }))),
];

function notice(name) {
  return [
    '// COPIED from persona-pipeline — do not edit this copy.',
    `// Source: persona-pipeline/files/scripts/lib/${name}, byte for byte below these`,
    '// three lines; tests/scripts/test-orchestrator-peer-snapshot-parity.mjs checks it.',
    '',
  ].join('\n');
}

describe('orchestrator peer snapshot and CLI exit libraries are the persona-pipeline sources (C96, C93)', () => {
  for (const name of LIBS) {
    it(`plugins/orchestrator/scripts/lib/${name} is its notice, then the source byte for byte`, () => {
      const source = readFileSync(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib', name));
      const copy = readFileSync(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib', name));
      const head = Buffer.from(notice(name), 'utf8');
      ok(copy.subarray(0, head.length).equals(head), `plugins/orchestrator/scripts/lib/${name}: the copy notice is missing or changed`);
      ok(
        copy.subarray(head.length).equals(source),
        `plugins/orchestrator/scripts/lib/${name} drifted from persona-pipeline/files/scripts/lib/${name}: `
          + 'edit the source, then copy it here under the notice',
      );
    });
  }

  it('the run locks and the runner judge a process by the copy\'s one definition', async () => {
    const lib = (rel) => import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts', rel)).href);
    const identity = await lib('lib/process-identity.mjs');
    const locks = await lib('lib/run-locks.mjs');
    const runner = await lib('peer-runner.mjs');
    for (const name of ['isProcessAlive', 'fingerprintsMatch']) {
      strictEqual(locks[name], identity[name], `lib/run-locks.mjs re-exports process-identity's ${name}`);
      strictEqual(runner[name], identity[name], `peer-runner.mjs re-exports process-identity's ${name}`);
    }
    strictEqual(runner.fingerprintForPid, identity.fingerprintForPid);
    strictEqual(runner.createRunCancellation, identity.createRunCancellation);
  });

  it('the orchestrator imports the copies, never a persona plugin\'s', () => {
    for (const script of ['peer-runner.mjs', 'dispatch-peer.mjs', 'lib/run-locks.mjs']) {
      const text = readFileSync(join(REPO_ROOT, 'plugins/orchestrator/scripts', script), 'utf8');
      ok(/from '\.\.?\/(lib\/)?process-identity\.mjs'/.test(text), `${script} imports the orchestrator's process-identity copy`);
      strictEqual(/from '[^']*\/(engineer|designer|founder)\//.test(text), false, `${script} imports no persona plugin`);
    }
  });

  it('the orchestrator CLIs and hooks exit through the cli-entry copy, never a persona plugin\'s (C93)', () => {
    for (const { rel, specifier } of CLI_ENTRY_CONSUMERS) {
      const text = readFileSync(join(REPO_ROOT, 'plugins/orchestrator', rel), 'utf8');
      ok(
        new RegExp(`import \\{[^}]*\\bexitAfterFlush\\b[^}]*\\} from '${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}';`).test(text),
        `${rel} imports exitAfterFlush from the orchestrator's copy (${specifier})`,
      );
      strictEqual(/from '[^']*\/(engineer|designer|founder)\//.test(text), false, `${rel} imports no persona plugin`);
      strictEqual(/\bprocess\.exit\(/.test(text), false, `${rel} calls process.exit only through exitAfterFlush`);
    }
  });
});

// C142 — the orchestrator's peer-runner.mjs is kept by hand, so no byte check
// holds its rules to the personas'. Each rule the persona spec's mutations
// guard in the personas' runner, where the same text is in the orchestrator's,
// is a second guard there: the orchestrator spec makes that same edit, and an
// orchestrator case kills it (the sixteenth review's W-F1, after V-F1 found
// one such rule with no case). This lists the edits; the harness scores them.
describe('the orchestrator spec mutates every persona runner rule its hand-kept runner shares (C142 W-F1)', () => {
  const RUNNER = 'plugins/orchestrator/scripts/peer-runner.mjs';
  const editsOf = (mutation) => {
    const edits = [];
    if (mutation.from !== undefined) edits.push({ file: mutation.file, from: mutation.from, to: mutation.to });
    mutation.prepare?.('/nonexistent', { applyEdit: (_copy, edit) => edits.push(edit) });
    return edits;
  };
  const spec = async (name) => (await import(pathToFileURL(join(REPO_ROOT, 'scripts/mutation-specs', name)).href)).MUTATIONS;

  it('each persona edit of engineer\'s peer-runner.mjs whose text the orchestrator runner holds is an orchestrator mutation\'s edit', async () => {
    const runner = readFileSync(join(REPO_ROOT, RUNNER), 'utf8');
    const orchestrator = (await spec('peer-snapshot-orchestrator.mjs'))
      .flatMap((m) => editsOf(m).filter((e) => e.file === RUNNER).map((e) => ({ id: m.id, ...e })));
    const shared = [];
    for (const m of await spec('peer-snapshot.mjs')) {
      for (const e of editsOf(m)) {
        if (e.file === 'plugins/engineer/scripts/peer-runner.mjs' && runner.includes(e.from)) shared.push({ id: m.id, ...e });
      }
    }
    // Not vacuous: the persona cases V-F1, W-F1 and X-F1 measured are among them.
    for (const id of ['H7', 'H10', 'H53', 'H128', 'H132']) ok(shared.some((e) => e.id === id), `persona ${id} edits a rule the orchestrator runner shares`);
    const missing = shared.filter((e) => !orchestrator.some((o) => o.from === e.from && o.to === e.to)).map((e) => e.id);
    strictEqual(missing.join(', '), '', `persona runner cases with no orchestrator mutation making the same edit in ${RUNNER}: add one to scripts/mutation-specs/peer-snapshot-orchestrator.mjs, killed by an orchestrator case`);
  });
});
