// plugins/engineer/scripts/dispatch-peer.mjs unit tests (Stage 2
// Deliverable E, Cluster 2 Option B — regression protection for Phase 6
// fixes).
//
// Covers:
//   - buildEnsemblePrompt:
//       * required `task` argument
//       * structuredOutputContract optional emission (Phase 6 fix #11)
//       * groundingRules string and array forms
//       * inputs object → <input name="..."> elements
//       * expectedOutput emission
//       * XML escaping of special characters
//   - validateEnvelopeShape (Phase 6 fix #3 — companions/contract.md
//     §4.2 required + §5.3 joint triple):
//       * malformed object rejected
//       * missing required field rejected
//       * invalid status / peer_host enum rejected
//       * success status with non-zero exit_code rejected
//       * peer_error joint triple (exit_code=1, kind=peer_run_error)
//       * companion_error exit_code 2 ↔ companion_misuse, 3 ↔ peer_*
//   - resolveCompanionPath (Phase 6 fix #4 — env override path):
//       * AGENTIC_COMPANIONS_ROOT env var honored (single root, not per-peer)
//       * relative path rejected
//       * env override missing discover-peer.mjs rejected
//       * unknown peer rejected
//
// Live spawn flows (companion not installed, peer CLI missing, etc.)
// are NOT covered here — those are integration concerns exercised by the
// dogfood session in Cluster 3.
//
// Run via `node --test tests/engineer/test-dispatch-peer.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const DISPATCH_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/dispatch-peer.mjs');

const {
  buildEnsemblePrompt,
  validateEnvelopeShape,
  resolveCompanionPath,
} = await import(DISPATCH_PATH);

describe('dispatch-peer.mjs — buildEnsemblePrompt (Phase 6 fix #11 structuredOutputContract)', () => {
  it('requires `task`', () => {
    try {
      buildEnsemblePrompt({});
      ok(false, 'should have thrown for missing task');
    } catch (err) {
      ok(/task is required/i.test(err.message), `unexpected: ${err.message}`);
    }
  });

  it('emits <task> only when nothing else is supplied', () => {
    const out = buildEnsemblePrompt({ task: 'hello world' });
    ok(/<task>\s*hello world\s*<\/task>/.test(out), `out: ${out}`);
    ok(!/<structured_output_contract>/.test(out));
    ok(!/<grounding_rules>/.test(out));
    ok(!/<inputs>/.test(out));
    ok(!/<expected_output>/.test(out));
  });

  it('emits <structured_output_contract> only when supplied (optional, Phase 6)', () => {
    const without = buildEnsemblePrompt({ task: 't' });
    ok(!/<structured_output_contract>/.test(without));
    const withContract = buildEnsemblePrompt({ task: 't', structuredOutputContract: 'C' });
    ok(/<structured_output_contract>\s*C\s*<\/structured_output_contract>/.test(withContract));
  });

  it('groundingRules string form emits single block', () => {
    const out = buildEnsemblePrompt({ task: 't', groundingRules: 'no fabrication' });
    ok(/<grounding_rules>\s*no fabrication\s*<\/grounding_rules>/.test(out));
  });

  it('groundingRules array form emits per-rule <rule> elements', () => {
    const out = buildEnsemblePrompt({
      task: 't',
      groundingRules: ['rule1', 'rule2'],
    });
    ok(/<rule>rule1<\/rule>/.test(out));
    ok(/<rule>rule2<\/rule>/.test(out));
  });

  it('inputs object → named <input> elements', () => {
    const out = buildEnsemblePrompt({
      task: 't',
      inputs: { context: 'ctx text', diff: 'diff text' },
    });
    ok(/<input name="context">\s*ctx text\s*<\/input>/.test(out));
    ok(/<input name="diff">\s*diff text\s*<\/input>/.test(out));
  });

  it('XML-escapes < > & in task body (text-content escape rules)', () => {
    // escapeXml is text-content level (XML 1.0): & < > are escaped.
    // " and ' are valid in text content and only need escaping inside
    // attribute values (handled by escapeXmlAttr for input names).
    const out = buildEnsemblePrompt({ task: 'a < b & c > d "e" \'f\'' });
    ok(out.includes('a &lt; b &amp; c &gt; d "e" \'f\''));
  });

  it('XML-escapes attribute values in <input name="...">', () => {
    const out = buildEnsemblePrompt({
      task: 't',
      inputs: { 'tricky"name': 'value' },
    });
    // attribute escape includes "
    ok(/<input name="tricky&quot;name">/.test(out), `out: ${out}`);
  });

  it('emits <expected_output> when supplied', () => {
    const out = buildEnsemblePrompt({ task: 't', expectedOutput: 'JSON object' });
    ok(/<expected_output>\s*JSON object\s*<\/expected_output>/.test(out));
  });
});

describe('dispatch-peer.mjs — validateEnvelopeShape (Phase 6 fix #3 — strict §4.2 + §5.3)', () => {
  const baseSuccess = {
    status: 'success',
    peer_host: 'codex',
    peer_model: 'gpt-5',
    stdout: 'output',
    exit_code: 0,
  };

  it('accepts a well-formed success envelope', () => {
    const r = validateEnvelopeShape(baseSuccess);
    strictEqual(r.ok, true);
  });

  it('rejects null', () => {
    const r = validateEnvelopeShape(null);
    strictEqual(r.ok, false);
  });

  it('rejects array', () => {
    const r = validateEnvelopeShape([]);
    strictEqual(r.ok, false);
  });

  it('rejects empty object (missing required fields)', () => {
    const r = validateEnvelopeShape({});
    strictEqual(r.ok, false);
    ok(/missing required field/.test(r.reason), `reason: ${r.reason}`);
  });

  it('rejects unknown status enum', () => {
    const r = validateEnvelopeShape({ ...baseSuccess, status: 'partial' });
    strictEqual(r.ok, false);
    ok(/invalid envelope\.status/.test(r.reason));
  });

  it('rejects unknown peer_host enum', () => {
    const r = validateEnvelopeShape({ ...baseSuccess, peer_host: 'gpt' });
    strictEqual(r.ok, false);
    ok(/invalid envelope\.peer_host/.test(r.reason));
  });

  it('rejects success with non-zero exit_code (joint triple §5.3)', () => {
    const r = validateEnvelopeShape({ ...baseSuccess, exit_code: 1 });
    strictEqual(r.ok, false);
    ok(/success status requires exit_code 0/.test(r.reason));
  });

  it('rejects success carrying error object (joint triple §5.3)', () => {
    const r = validateEnvelopeShape({
      ...baseSuccess,
      error: { kind: 'peer_run_error', message: 'should not appear' },
    });
    strictEqual(r.ok, false);
    ok(/must not include error/.test(r.reason));
  });

  it('peer_error requires (exit_code=1, kind=peer_run_error) joint triple', () => {
    const ok1 = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: 'claude-opus',
      stdout: '',
      exit_code: 1,
      error: { kind: 'peer_run_error', message: 'peer crashed' },
    });
    strictEqual(ok1.ok, true);

    const wrongCode = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: 'claude-opus',
      stdout: '',
      exit_code: 2,
      error: { kind: 'peer_run_error', message: 'x' },
    });
    strictEqual(wrongCode.ok, false);

    const wrongKind = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: 'claude-opus',
      stdout: '',
      exit_code: 1,
      error: { kind: 'companion_misuse', message: 'x' },
    });
    strictEqual(wrongKind.ok, false);
  });

  it('error.message is required, non-empty, single-line (§4.2)', () => {
    const baseError = {
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: 'claude-opus',
      stdout: '',
      exit_code: 1,
    };

    const noMessage = validateEnvelopeShape({ ...baseError, error: { kind: 'peer_run_error' } });
    strictEqual(noMessage.ok, false);
    ok(/error\.message/.test(noMessage.reason));

    const emptyMessage = validateEnvelopeShape({
      ...baseError, error: { kind: 'peer_run_error', message: '' },
    });
    strictEqual(emptyMessage.ok, false);

    const nonStringMessage = validateEnvelopeShape({
      ...baseError, error: { kind: 'peer_run_error', message: 42 },
    });
    strictEqual(nonStringMessage.ok, false);

    const multilineMessage = validateEnvelopeShape({
      ...baseError, error: { kind: 'peer_run_error', message: 'line1\nline2' },
    });
    strictEqual(multilineMessage.ok, false);
    ok(/single-line/.test(multilineMessage.reason));
  });

  it('error.detail accepts string or null when present (§4.2)', () => {
    const base = {
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: 'claude-opus',
      stdout: '',
      exit_code: 1,
    };

    const stringDetail = validateEnvelopeShape({
      ...base,
      error: { kind: 'peer_run_error', message: 'x', detail: 'multi\nline\ndetail' },
    });
    strictEqual(stringDetail.ok, true);

    const nullDetail = validateEnvelopeShape({
      ...base,
      error: { kind: 'peer_run_error', message: 'x', detail: null },
    });
    strictEqual(nullDetail.ok, true);

    const numberDetail = validateEnvelopeShape({
      ...base,
      error: { kind: 'peer_run_error', message: 'x', detail: 42 },
    });
    strictEqual(numberDetail.ok, false);
  });

  it('rejects array-shaped error', () => {
    const r = validateEnvelopeShape({
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: 'claude-opus',
      stdout: '',
      exit_code: 1,
      error: ['kind', 'peer_run_error'],
    });
    strictEqual(r.ok, false);
  });

  it('companion_error exit_code=2 must pair with kind=companion_misuse', () => {
    const ok1 = validateEnvelopeShape({
      status: 'companion_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 2,
      error: { kind: 'companion_misuse', message: 'bad flags' },
    });
    strictEqual(ok1.ok, true);

    const mismatch = validateEnvelopeShape({
      status: 'companion_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 2,
      error: { kind: 'peer_cli_not_found', message: 'x' },
    });
    strictEqual(mismatch.ok, false);
  });

  it('companion_error exit_code=3 must pair with peer_* kinds', () => {
    for (const kind of ['peer_cli_not_found', 'peer_unauthenticated', 'peer_invocation_error']) {
      const r = validateEnvelopeShape({
        status: 'companion_error',
        peer_host: 'codex',
        peer_model: null,
        stdout: '',
        exit_code: 3,
        error: { kind, message: 'x' },
      });
      strictEqual(r.ok, true, `kind=${kind} should pair with exit_code=3`);
    }

    const wrongKindWithCode3 = validateEnvelopeShape({
      status: 'companion_error',
      peer_host: 'codex',
      peer_model: null,
      stdout: '',
      exit_code: 3,
      error: { kind: 'companion_misuse', message: 'x' },
    });
    strictEqual(wrongKindWithCode3.ok, false);
  });

  it('peer_model must be string or null', () => {
    const r = validateEnvelopeShape({ ...baseSuccess, peer_model: 42 });
    strictEqual(r.ok, false);
    ok(/peer_model must be string or null/.test(r.reason));
  });

  it('exit_code must be integer', () => {
    const r = validateEnvelopeShape({ ...baseSuccess, exit_code: 0.5 });
    strictEqual(r.ok, false);
    ok(/exit_code must be integer/.test(r.reason));
  });
});

describe('dispatch-peer.mjs — resolveCompanionPath (Phase 6 fix #4)', () => {
  // The env override is AGENTIC_COMPANIONS_ROOT (a directory), not
  // per-peer paths. ADR-0008 §e specifies the override points at the
  // companions scripts/ directory; resolveCompanionPath imports
  // discover-peer.mjs from it and delegates discovery there.
  const COMPANIONS_SCRIPTS_DIR = resolve(REPO_ROOT, 'companions');

  it('honors AGENTIC_COMPANIONS_ROOT env override (canonical companions/ as override target)', async () => {
    const env = { AGENTIC_COMPANIONS_ROOT: COMPANIONS_SCRIPTS_DIR };
    const path = await resolveCompanionPath('codex', { env });
    ok(typeof path === 'string' && path.endsWith('codex-companion.mjs'),
      `expected codex-companion.mjs path, got: ${path}`);
    ok(path.startsWith(COMPANIONS_SCRIPTS_DIR),
      `path should be under override root: ${path}`);
  });

  it('rejects relative env override path', async () => {
    const env = { AGENTIC_COMPANIONS_ROOT: 'relative/path' };
    try {
      await resolveCompanionPath('codex', { env });
      ok(false, 'should have thrown for relative path');
    } catch (err) {
      ok(/must be absolute/i.test(err.message), `err: ${err.message}`);
    }
  });

  it('rejects env override where discover-peer.mjs is missing', async () => {
    const env = { AGENTIC_COMPANIONS_ROOT: '/tmp' };
    try {
      await resolveCompanionPath('codex', { env });
      ok(false, 'should have thrown for missing discover-peer.mjs');
    } catch (err) {
      ok(/discover-peer\.mjs not found/i.test(err.message), `err: ${err.message}`);
    }
  });

  it('rejects unknown peer values', async () => {
    try {
      await resolveCompanionPath('invalid', { env: {} });
      ok(false, 'should have thrown for unknown peer');
    } catch (err) {
      ok(/Invalid peer/i.test(err.message), `err: ${err.message}`);
    }
  });
});
