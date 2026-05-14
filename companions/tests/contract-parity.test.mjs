// Cross-companion parity tests for companions/contract.md.
//
// Direction-specific tests cover each script in depth. This file verifies
// the contract-level surface that must remain identical between
// claude-companion.mjs and codex-companion.mjs.
//
// Run: node --test companions/tests/contract-parity.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as claude from '../claude-companion.mjs';
import * as codex from '../codex-companion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(__dirname, '..', 'contract.md');

function contractVersionFromMarkdown() {
  const text = readFileSync(CONTRACT_PATH, 'utf8');
  const match = text.match(/^- \*\*Version\*\*:\s*`v(\d+\.\d+\.\d+)`/m);
  assert.ok(match, 'contract.md Version line should be parseable');
  return match[1];
}

function parseBoth(argv) {
  return {
    claude: claude.parseArguments(argv),
    codex: codex.parseArguments(argv),
  };
}

function comparableParseResult(result) {
  return {
    subcommand: result.subcommand,
    promptArg: result.promptArg,
    options: result.options,
  };
}

function comparableEnvelope(envelope) {
  return {
    keys: Object.keys(envelope).sort(),
    status: envelope.status,
    peer_model: envelope.peer_model,
    stdout: envelope.stdout,
    exit_code: envelope.exit_code,
    error_kind: envelope.error?.kind ?? null,
    error_detail: envelope.error?.detail ?? null,
  };
}

describe('companions contract parity', () => {
  it('both companions export the same contract version, exit codes, statuses, and error kinds', () => {
    const contractVersion = contractVersionFromMarkdown();
    assert.equal(claude.CONTRACT_VERSION, contractVersion);
    assert.equal(codex.CONTRACT_VERSION, contractVersion);

    assert.deepEqual(
      {
        EXIT_SUCCESS: claude.EXIT_SUCCESS,
        EXIT_PEER_RUN_ERROR: claude.EXIT_PEER_RUN_ERROR,
        EXIT_COMPANION_MISUSE: claude.EXIT_COMPANION_MISUSE,
        EXIT_PEER_INFRA: claude.EXIT_PEER_INFRA,
        STATUS: claude.STATUS,
        ERROR_KIND: claude.ERROR_KIND,
        STDERR_MAX: claude.STDERR_MAX,
      },
      {
        EXIT_SUCCESS: codex.EXIT_SUCCESS,
        EXIT_PEER_RUN_ERROR: codex.EXIT_PEER_RUN_ERROR,
        EXIT_COMPANION_MISUSE: codex.EXIT_COMPANION_MISUSE,
        EXIT_PEER_INFRA: codex.EXIT_PEER_INFRA,
        STATUS: codex.STATUS,
        ERROR_KIND: codex.ERROR_KIND,
        STDERR_MAX: codex.STDERR_MAX,
      },
    );
  });

  it('both companions expose the same pinned invocation options and defaults', () => {
    const { claude: claudeBare, codex: codexBare } = parseBoth(['task']);
    assert.deepEqual(comparableParseResult(claudeBare), comparableParseResult(codexBare));
    assert.equal(claudeBare.options.outputFormat, 'text');

    const argv = [
      'task',
      '--prompt-file', '/tmp/prompt.xml',
      '--model', 'peer-model',
      '--effort', 'high',
      '--cwd', '/workspace',
      '--output-format', 'json',
    ];
    const { claude: claudeParsed, codex: codexParsed } = parseBoth(argv);
    assert.deepEqual(comparableParseResult(claudeParsed), comparableParseResult(codexParsed));
  });

  it('both companions reject the same contract-level invocation misuse', () => {
    for (const argv of [
      [],
      ['review'],
      ['task', '--unknown', 'x'],
      ['task', '--output-format', 'yaml'],
      ['task', 'first', 'second'],
    ]) {
      assert.throws(() => claude.parseArguments(argv), claude.CompanionMisuseError, `claude argv=${argv.join(' ')}`);
      assert.throws(() => codex.parseArguments(argv), codex.CompanionMisuseError, `codex argv=${argv.join(' ')}`);
    }
  });

  it('both companions classify success, peer failure, spawn failure, and signal termination into the same contract buckets', () => {
    const cases = [
      {
        name: 'success',
        invocation: { stdout: 'ok', stderr: '', exitCode: 0, signal: null, spawnError: null },
      },
      {
        name: 'peer non-zero',
        invocation: { stdout: 'partial', stderr: 'bad flag', exitCode: 9, signal: null, spawnError: null },
      },
      {
        name: 'missing peer CLI',
        invocation: { stdout: '', stderr: '', exitCode: null, signal: null, spawnError: Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      },
      {
        name: 'signal',
        invocation: { stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', spawnError: null },
      },
    ];

    for (const { name, invocation } of cases) {
      const claudeClassification = claude.classifyResult(invocation);
      const codexClassification = codex.classifyResult(invocation);
      assert.equal(claudeClassification.status, codexClassification.status, `${name}: status`);
      assert.equal(claudeClassification.exit_code, codexClassification.exit_code, `${name}: exit_code`);
      assert.equal(claudeClassification.error?.kind ?? null, codexClassification.error?.kind ?? null, `${name}: error.kind`);
      assert.equal(claudeClassification.error?.detail ?? null, codexClassification.error?.detail ?? null, `${name}: error.detail`);
    }
  });

  it('both companions emit the same JSON envelope schema for success and peer-run errors', () => {
    const successInvocation = { stdout: 'peer text', stderr: '', exitCode: 0, signal: null, spawnError: null };
    const peerErrorInvocation = { stdout: 'partial text', stderr: 'peer failed', exitCode: 5, signal: null, spawnError: null };
    const options = { model: 'peer-model', outputFormat: 'json' };

    for (const invocation of [successInvocation, peerErrorInvocation]) {
      const claudeEnvelope = claude.buildEnvelope({
        invocation,
        classification: claude.classifyResult(invocation),
        options,
      });
      const codexEnvelope = codex.buildEnvelope({
        invocation,
        classification: codex.classifyResult(invocation),
        options,
      });

      assert.deepEqual(comparableEnvelope(claudeEnvelope), comparableEnvelope(codexEnvelope));
      assert.equal(claudeEnvelope.peer_host, 'claude');
      assert.equal(codexEnvelope.peer_host, 'codex');
    }
  });
});
