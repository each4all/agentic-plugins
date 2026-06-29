// Tests for the ADR-0038 §2 usage-record learner (the "C engine").
//
// Drives the committed usage-records fixtures + manifest oracle: parses both
// host formats, aggregates to evidence-grounded rules, and asserts the four
// status taxonomy outcomes (readable / missing / permission-denied / malformed)
// plus the no_records_available baseline fallback and the redaction guarantee.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readRecordSource,
  parseClaudeTranscript,
  parseCodexRollout,
  aggregateObservations,
  learnFromSources,
  RECORD_STATUSES,
} from '../../plugins/runtime/scripts/lib/permission-usage-learner.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-records');
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
const fx = (name) => manifest.fixtures.find((f) => f.file === name);
const text = (name) => readFileSync(join(FIXTURES, name), 'utf8');

describe('usage-learner: status taxonomy', () => {
  it('exposes exactly the four documented statuses', () => {
    assert.deepEqual([...RECORD_STATUSES].sort(), [...Object.keys(manifest.statuses)].sort());
  });
  it('classifies a readable file', () => {
    assert.equal(readRecordSource(join(FIXTURES, 'claude-session-readable.jsonl')).status, 'readable');
  });
  it('classifies a missing path', () => {
    assert.equal(readRecordSource(join(FIXTURES, 'no-such-file.jsonl')).status, 'missing');
  });
  it('classifies a permission-denied path (chmod 000)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-learner-'));
    const p = join(dir, 'denied.jsonl');
    try {
      writeFileSync(p, '{"type":"permission-mode","permissionMode":"default"}\n');
      chmodSync(p, 0o000);
      const got = readRecordSource(p).status;
      // root bypasses mode bits — only assert the EACCES path when it actually denies.
      if (got !== 'readable') assert.equal(got, 'permission-denied');
    } finally {
      try { chmodSync(p, 0o600); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('usage-learner: Claude transcript parsing', () => {
  const parsed = parseClaudeTranscript(text('claude-session-readable.jsonl'));
  it('extracts one observation per prompt-causing tool_use', () => {
    assert.equal(parsed.status, 'readable');
    assert.equal(parsed.observations.length, fx('claude-session-readable.jsonl').observations.length);
  });
  it('flags the user-rejected command', () => {
    const pushed = parsed.observations.find((o) => o.rawCommand === 'git push --force origin main');
    assert.ok(pushed, 'git push observation present');
    assert.equal(pushed.rejected, true);
  });
  it('maps each tool to its advisor-core cause', () => {
    const causes = new Set(parsed.observations.map((o) => o.cause));
    assert.ok(causes.has('claude.bash-not-allowlisted'));
    assert.ok(causes.has('claude.file-modification'));
    assert.ok(causes.has('claude.webfetch-domain'));
    assert.ok(causes.has('claude.mcp-not-allowed'));
  });
});

describe('usage-learner: Codex rollout parsing', () => {
  const parsed = parseCodexRollout(text('codex-session-readable.jsonl'));
  it('parses both shell shapes and pairs causes off events', () => {
    const sandbox = parsed.observations.find((o) => o.cause === 'codex.sandbox-blocked');
    const approval = parsed.observations.find((o) => o.cause === 'codex.approval-requested');
    assert.ok(sandbox && sandbox.rawCommand.includes('echo'), 'sandbox-blocked derived from exec_command_end marker');
    assert.ok(approval && approval.rawCommand.includes('rm -rf'), 'approval-requested derived from exec_approval_request event');
    assert.equal(approval.rejected, true);
  });
  it('treats clean in-sandbox runs as cause=null (baseline, not a prompt)', () => {
    const clean = parsed.observations.filter((o) => o.cause === null);
    assert.equal(clean.length, 2); // npm test + git status
  });
});

describe('usage-learner: aggregation is locked to the manifest oracle', () => {
  // For every readable fixture observation that names a command + expected
  // pattern/grade, the aggregated rule must carry exactly that pattern/grade.
  for (const file of ['claude-session-readable.jsonl', 'codex-session-readable.jsonl']) {
    const host = fx(file).host;
    const parser = host === 'claude' ? parseClaudeTranscript : parseCodexRollout;
    const { rules } = aggregateObservations(parser(text(file)).observations);
    for (const obs of fx(file).observations) {
      if (obs.expected_pattern === undefined || obs.cause === null || obs.cause === undefined) continue;
      it(`${file} :: ${obs.source_id} -> rule[${obs.cause} ${obs.expected_pattern}] grade=${obs.expected_grade}`, () => {
        const rule = rules.find((r) => r.cause === obs.cause && r.pattern === obs.expected_pattern);
        assert.ok(rule, `expected a rule for ${obs.cause} ${obs.expected_pattern}`);
        assert.equal(rule.grade, obs.expected_grade);
        assert.equal(rule.evidence.source, 'usage');
        assert.ok(rule.evidence.count >= 1);
      });
    }
  }
  it('file-modification becomes mode evidence, not an allow-rule', () => {
    const { rules, modeEvidence } = aggregateObservations(parseClaudeTranscript(text('claude-session-readable.jsonl')).observations);
    assert.ok(!rules.some((r) => r.cause === 'claude.file-modification'));
    const mode = modeEvidence.find((m) => m.cause === 'claude.file-modification');
    assert.ok(mode && mode.count === 1);
  });
  it('merges duplicate (host,cause,pattern) to the worst grade with a summed count', () => {
    const obs = [
      { host: 'claude', cause: 'claude.bash-not-allowlisted', mechanism: 'bash', rawCommand: 'rm foo', rejected: false },
      { host: 'claude', cause: 'claude.bash-not-allowlisted', mechanism: 'bash', rawCommand: 'rm -rf bar', rejected: false },
    ];
    const { rules } = aggregateObservations(obs);
    const rm = rules.find((r) => r.pattern === 'rm *');
    assert.ok(rm);
    assert.equal(rm.grade, 'deny'); // worst of ask (rm foo) and deny (rm -rf bar)
    assert.equal(rm.evidence.count, 2);
  });
});

describe('usage-learner: malformed handling', () => {
  it('claude-malformed: skips unparseable lines, extracts survivors', () => {
    const p = parseClaudeTranscript(text('claude-malformed.jsonl'));
    assert.equal(p.status, 'malformed');
    assert.equal(p.malformedLines, fx('claude-malformed.jsonl').expected_parse.unparseable_lines);
    assert.equal(p.observations.length, 2); // ls -la + cat package.json
  });
  it('codex-malformed: one bad line + one valid line with non-JSON arguments', () => {
    const p = parseCodexRollout(text('codex-malformed.jsonl'));
    assert.equal(p.status, 'malformed');
    assert.equal(p.malformedLines, fx('codex-malformed.jsonl').expected_parse.unparseable_lines);
    assert.equal(p.malformedArguments, fx('codex-malformed.jsonl').expected_parse.valid_line_with_unparseable_arguments);
    assert.equal(p.observations.length, 2); // git status + cat README.md
  });
});

describe('usage-learner: redaction guarantee', () => {
  it('no rule pattern or evidence note leaks a secret fragment', () => {
    const forbidden = fx('claude-secret-redaction.jsonl').must_not_contain;
    const { rules } = aggregateObservations(parseClaudeTranscript(text('claude-secret-redaction.jsonl')).observations);
    assert.ok(rules.length >= 5);
    for (const r of rules) {
      const hay = `${r.pattern} ${r.reason ?? ''} ${r.evidence.note ?? ''}`;
      for (const frag of forbidden) {
        assert.ok(!hay.includes(frag), `rule leaked "${frag}": ${hay}`);
      }
    }
  });
});

describe('usage-learner: no_records_available baseline', () => {
  it('returns the baseline status when every source is unusable', () => {
    const r = learnFromSources([
      { path: join(FIXTURES, 'no-such-file.jsonl'), host: 'claude' },
      { path: join(FIXTURES, 'also-missing.jsonl'), host: 'codex' },
    ]);
    assert.equal(r.status, 'no_records_available');
    assert.equal(r.baselineUsed, true);
    assert.equal(r.rules.length, 0);
    assert.equal(r.sources[0].status, 'missing');
  });
  it('reports analyzed with evidence when records exist', () => {
    const r = learnFromSources([{ path: join(FIXTURES, 'claude-session-readable.jsonl'), host: 'claude' }]);
    assert.equal(r.status, 'analyzed');
    assert.equal(r.baselineUsed, false);
    assert.ok(r.rules.length >= 6);
  });
});

// ---------------------------------------------------------------------------
// Codex schema-hardening edge cases (from the Plan-verify peer review)
// ---------------------------------------------------------------------------
const J = (o) => JSON.stringify(o);
const rollout = (lines) => parseCodexRollout(lines.join('\n'));

describe('usage-learner: Codex schema hardening (Plan-verify)', () => {
  it('#1 sandbox marker in function_call_output (string and typed-array)', () => {
    const strForm = rollout([
      J({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: J({ command: ['bash', '-lc', 'cat /etc/shadow'] }) } }),
      J({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Command denied by sandbox: read blocked' } }),
    ]);
    assert.equal(strForm.observations[0].cause, 'codex.sandbox-blocked');
    const arrForm = rollout([
      J({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c2', arguments: J({ command: ['rm', '/sys/x'] }) } }),
      J({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'sandbox denied exec error' }] } }),
    ]);
    assert.equal(arrForm.observations[0].cause, 'codex.sandbox-blocked');
  });

  it('#3 apply_patch_approval_request is learned as approval-policy evidence, no command rule', () => {
    const p = rollout([
      J({ type: 'event_msg', payload: { type: 'apply_patch_approval_request', call_id: 'p1', reason: 'edit outside workspace' } }),
    ]);
    const patch = p.observations.find((o) => o.mechanism === 'patch');
    assert.ok(patch && patch.cause === 'codex.approval-requested');
    const { rules, modeEvidence } = aggregateObservations(p.observations);
    assert.ok(!rules.some((r) => r.pattern === 'apply_patch'), 'patch approval is not a command rule');
    assert.ok(modeEvidence.some((m) => m.cause === 'codex.approval-requested' && m.count === 1));
  });

  it('#4 a shell call with events present but no clean end is not counted as baseline', () => {
    const p = rollout([
      // an approval event exists (so hasExecEvents) but THIS call never ends cleanly
      J({ type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'other', command: ['bash', '-lc', 'rm -rf x'] } }),
      J({ type: 'response_item', payload: { type: 'local_shell_call', call_id: 'inflight', action: { type: 'exec', command: ['npm', 'run', 'build'] } } }),
    ]);
    assert.ok(!p.observations.some((o) => o.rawCommand === 'npm run build'), 'in-flight call dropped');
  });

  it('#4 legacy rollout with no exec events still yields baseline observations', () => {
    const p = rollout([
      J({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c', arguments: J({ command: ['ls', '-la'] }) } }),
    ]);
    const ls = p.observations.find((o) => o.rawCommand === 'ls -la');
    assert.ok(ls && ls.cause === null, 'no-event legacy rollout -> baseline');
  });

  it('#5 no-payload shell wrapper is dropped, env + /bin/bash wrappers normalize', () => {
    const noPayload = rollout([
      J({ type: 'response_item', payload: { type: 'local_shell_call', call_id: 'np', action: { type: 'exec', command: ['bash', '-lc'] } } }),
    ]);
    assert.equal(noPayload.observations.length, 0);
    const env = rollout([
      J({ type: 'response_item', payload: { type: 'local_shell_call', call_id: 'e', action: { type: 'exec', command: ['/usr/bin/env', 'bash', '-lc', 'npm test'] } } }),
    ]);
    assert.equal(env.observations[0].rawCommand, 'npm test');
    const binbash = rollout([
      J({ type: 'response_item', payload: { type: 'local_shell_call', call_id: 'b', action: { type: 'exec', command: ['/bin/bash', '-lc', 'git status'] } } }),
    ]);
    assert.equal(binbash.observations[0].rawCommand, 'git status');
  });
});
