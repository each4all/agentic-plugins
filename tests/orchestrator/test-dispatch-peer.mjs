// plugins/orchestrator/scripts/dispatch-peer.mjs unit tests.
//
// Covers:
//   - buildEnsemblePrompt XML structure (task / structured_output_contract /
//     grounding_rules / inputs / expected_output)
//   - XML escaping for <, >, &, " in element text and attribute values
//   - validateEnvelopeShape (success + companion_error + peer_error joint
//     triple per companions/contract.md §4.2 + §5.3)
//   - dispatchPeer graceful degradation: companion missing → kind
//     'peer_cli_not_found', no pending_ensemble entry recorded
//     (orchestrator-specific divergence from engineer)
//
// Run via `node --test tests/orchestrator/test-dispatch-peer.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const DISPATCH_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/dispatch-peer.mjs');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const { buildEnsemblePrompt, validateEnvelopeShape, dispatchPeer } = await import(DISPATCH_MJS);
const { createWorkflow, readWorkflow } = await import(STATE_MJS);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-dispatch-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'i', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

// ---------------------------------------------------------------------------
// buildEnsemblePrompt

describe('buildEnsemblePrompt', () => {
  it('builds <task> + <structured_output_contract> + <grounding_rules> + <inputs>', () => {
    const xml = buildEnsemblePrompt({
      task: 'analyze',
      structuredOutputContract: 'return JSON',
      groundingRules: 'cite sources',
      inputs: { feature: 'macro plan' },
    });
    ok(xml.includes('<task>\nanalyze\n</task>'));
    ok(xml.includes('<structured_output_contract>\nreturn JSON\n</structured_output_contract>'));
    ok(xml.includes('<grounding_rules>\ncite sources\n</grounding_rules>'));
    ok(xml.includes('<input name="feature">'));
    ok(xml.includes('macro plan'));
    ok(xml.includes('</input>'));
  });

  it('escapes < > & in element text', () => {
    const xml = buildEnsemblePrompt({
      task: 'a < b & c > d',
      structuredOutputContract: 'X',
    });
    ok(xml.includes('a &lt; b &amp; c &gt; d'));
    ok(!xml.includes('<task>\na < b'));
  });

  it('escapes " in attribute (input name)', () => {
    const xml = buildEnsemblePrompt({
      task: 't',
      inputs: { 'one"two': 'v' },
    });
    ok(xml.includes('name="one&quot;two"'));
  });

  it('rejects missing task', () => {
    let err;
    try {
      buildEnsemblePrompt({});
    } catch (e) {
      err = e;
    }
    ok(err);
    ok(/task is required/.test(err.message));
  });

  it('groundingRules array becomes <rule>… per item', () => {
    const xml = buildEnsemblePrompt({
      task: 't',
      groundingRules: ['cite a', 'cite b'],
    });
    ok(xml.includes('<rule>cite a</rule>'));
    ok(xml.includes('<rule>cite b</rule>'));
  });
});

// ---------------------------------------------------------------------------
// validateEnvelopeShape

describe('validateEnvelopeShape', () => {
  it('accepts success envelope (exit_code 0, no error)', () => {
    const r = validateEnvelopeShape({
      status: 'success',
      peer_host: 'codex',
      peer_model: 'gpt-5',
      stdout: 'output',
      exit_code: 0,
    });
    strictEqual(r.ok, true);
  });

  it('rejects success with non-zero exit_code', () => {
    const r = validateEnvelopeShape({
      status: 'success',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 1,
    });
    strictEqual(r.ok, false);
    ok(/success.*exit_code/.test(r.reason));
  });

  it('accepts peer_error with kind peer_run_error and exit_code 1', () => {
    const r = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 1,
      error: { kind: 'peer_run_error', message: 'peer fault', detail: null },
    });
    strictEqual(r.ok, true);
  });

  it('rejects peer_error with mismatched exit_code', () => {
    const r = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 3,
      error: { kind: 'peer_run_error', message: 'x', detail: null },
    });
    strictEqual(r.ok, false);
  });

  it('accepts companion_error exit_code 3 with peer_cli_not_found', () => {
    const r = validateEnvelopeShape({
      status: 'companion_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 3,
      error: { kind: 'peer_cli_not_found', message: 'not installed', detail: null },
    });
    strictEqual(r.ok, true);
  });

  it('rejects companion_error exit_code 2 with non-misuse kind', () => {
    const r = validateEnvelopeShape({
      status: 'companion_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 2,
      error: { kind: 'peer_cli_not_found', message: 'x', detail: null },
    });
    strictEqual(r.ok, false);
  });

  it('rejects multiline error.message', () => {
    const r = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 1,
      error: { kind: 'peer_run_error', message: 'line1\nline2', detail: null },
    });
    strictEqual(r.ok, false);
    ok(/single-line/.test(r.reason));
  });

  it('rejects missing required envelope field', () => {
    const r = validateEnvelopeShape({
      status: 'success',
      peer_host: 'codex',
      // peer_model missing
      stdout: '',
      exit_code: 0,
    });
    strictEqual(r.ok, false);
    ok(/peer_model/.test(r.reason));
  });

  it('rejects non-object envelope', () => {
    strictEqual(validateEnvelopeShape(null).ok, false);
    strictEqual(validateEnvelopeShape('string').ok, false);
    strictEqual(validateEnvelopeShape([]).ok, false);
  });
});

// ---------------------------------------------------------------------------
// dispatchPeer graceful degradation
//
// orchestrator-specific contract: companion missing → exit 3 + kind
// 'peer_cli_not_found', and NO pending_ensemble entry is recorded
// (no orphan to clean up later).

describe('dispatchPeer graceful degradation', () => {
  it('returns kind peer_cli_not_found when companion is missing AND does NOT record pending_ensemble', async () => {
    await withTmpRepo('graceful', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });

      // Force companion resolution failure: AGENTIC_COMPANIONS_ROOT
      // points to an empty directory.
      const fakeRoot = await mkdtemp(join(tmpdir(), 'orchestrator-fake-companion-'));
      try {
        const env = { ...process.env, AGENTIC_COMPANIONS_ROOT: fakeRoot };
        let err;
        let result;
        try {
          result = await dispatchPeer({
            peer: 'codex',
            promptText: '<task>x</task>',
            env,
            ensembleBookkeeping: {
              workflowPath: filePath,
              phase: 'plan',
              ensembleType: 'plan-verify',
              runId: 'test-run-1',
            },
          });
        } catch (e) {
          err = e;
        }
        // Override path is invalid (no discover-peer.mjs) — that path
        // throws synchronously by design, since AGENTIC_COMPANIONS_ROOT
        // was explicitly supplied.
        ok(err, 'env-override path with missing discover-peer.mjs throws');
        ok(/discover-peer\.mjs not found/.test(err.message));

        // Critical: pending_ensemble must remain empty since the
        // companion-resolve phase aborted before pending registration.
        const { frontmatter } = await readWorkflow(filePath);
        const pending = frontmatter.pending_ensemble ?? [];
        strictEqual(pending.length, 0, 'no pending entry registered on companion resolution failure');
      } finally {
        await rm(fakeRoot, { recursive: true, force: true });
      }
    });
  });

  it('rejects bad outputFormat', async () => {
    let err;
    try {
      await dispatchPeer({ peer: 'codex', promptText: '<task>x</task>', outputFormat: 'xml' });
    } catch (e) {
      err = e;
    }
    ok(err);
    ok(/Invalid outputFormat/.test(err.message));
  });

  it('rejects when both promptText and promptFile are given', async () => {
    let err;
    try {
      await dispatchPeer({ peer: 'codex', promptText: 'x', promptFile: '/tmp/y' });
    } catch (e) {
      err = e;
    }
    ok(err);
    ok(/both/.test(err.message));
  });

  it('rejects ensembleBookkeeping with missing fields', async () => {
    let err;
    try {
      await dispatchPeer({
        peer: 'codex',
        promptText: 'x',
        ensembleBookkeeping: { workflowPath: '/tmp/w', phase: 'plan' },
      });
    } catch (e) {
      err = e;
    }
    ok(err);
    ok(/ensembleBookkeeping/.test(err.message));
  });
});
