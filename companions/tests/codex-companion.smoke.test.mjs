// Smoke test for companions/codex-companion.mjs against the real `codex` CLI.
//
// Skipped by default. Set COMPANIONS_SMOKE=1 to opt in. Requires:
//   - codex on PATH
//   - codex authenticated (codex login or env-var auth)
//   - network connectivity
//
// Run: COMPANIONS_SMOKE=1 node --test companions/tests/codex-companion.smoke.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'codex-companion.mjs');
const SMOKE = process.env.COMPANIONS_SMOKE === '1';

const PROMPT = `<task>
Reply with the single word OK and nothing else.
</task>

<grounding_rules>
<rule>Output exactly one word.</rule>
<rule>Do not add punctuation, formatting, or explanation.</rule>
</grounding_rules>`;

describe('codex-companion smoke (real `codex` CLI)', { skip: !SMOKE }, () => {
  it('text mode round trip — peer responds with "OK"', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'task'], {
      input: PROMPT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `exit ${result.status}; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /OK/,
      `peer stdout should include "OK" per prompt instruction; got: ${JSON.stringify(result.stdout)}`,
    );
  });

  it('json envelope round trip — peer responds with "OK"', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'task', '--output-format', 'json'],
      { input: PROMPT, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(result.status, 0, `exit ${result.status}; stderr=${result.stderr}`);
    const env = JSON.parse(result.stdout);
    assert.equal(env.status, 'success');
    assert.equal(env.peer_host, 'codex');
    assert.equal(env.exit_code, 0);
    assert.ok(typeof env.stdout === 'string', 'envelope.stdout is a string');
    assert.match(env.stdout, /OK/, 'envelope.stdout includes peer "OK" reply');
    assert.ok(env.metadata && typeof env.metadata.duration_ms === 'number');
    assert.match(env.metadata.started_at, /Z$/);
    assert.match(env.metadata.completed_at, /Z$/);
  });
});
