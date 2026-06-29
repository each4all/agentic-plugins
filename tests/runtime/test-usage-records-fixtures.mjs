// Tests for the ADR-0038 usage-records fixtures + manifest.
//
// This validates the FIXTURES (the usage-records subtask deliverable) — it does
// NOT exercise the usage-learner (a later slice). Its job is to keep the
// fixtures honest and locked to the shipped advisor-core: every manifest
// expected_pattern/expected_grade is recomputed from generalizeCommand +
// gradeCommand, so an advisor-core change that would break the learner's
// fixtures fails here first. It also asserts the malformed parse stats and the
// redaction guarantee.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generalizeCommand } from '../../plugins/runtime/scripts/lib/permission-sanitize.mjs';
import { gradeCommand } from '../../plugins/runtime/scripts/lib/permission-advisor-core.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-records');
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));

function readLines(file) {
  return readFileSync(join(FIXTURES, file), 'utf8').split('\n');
}
function jsonParseStats(file) {
  const physical = readLines(file);
  let empty = 0, ok = 0, bad = 0;
  for (const l of physical) {
    if (l.length === 0) { empty++; continue; }
    try { JSON.parse(l); ok++; } catch { bad++; }
  }
  return { physical: physical.length - (physical[physical.length - 1] === '' ? 1 : 0), empty: empty - (physical[physical.length - 1] === '' ? 1 : 0), ok, bad };
}

describe('usage-records fixtures: presence + manifest shape', () => {
  it('manifest advertises all four statuses', () => {
    assert.deepEqual(
      Object.keys(manifest.statuses).sort(),
      ['malformed', 'missing', 'permission-denied', 'readable'],
    );
  });
  it('every manifest fixture file exists on disk', () => {
    for (const fx of manifest.fixtures) {
      assert.ok(existsSync(join(FIXTURES, fx.file)), `missing fixture ${fx.file}`);
    }
  });
  it('advisor schema version matches the manifest', () => {
    assert.equal(manifest.advisor_schema_version, '1.0');
  });
});

describe('usage-records fixtures: manifest is locked to advisor-core', () => {
  // Every observation that names a raw command + expected outputs must agree
  // with the SHIPPED grader/generalizer. This is the anti-rot guard.
  for (const fx of manifest.fixtures) {
    for (const obs of fx.observations ?? []) {
      if (obs.raw === undefined || obs.expected_pattern === undefined) continue;
      it(`${fx.file} :: ${obs.source_id} generalizes + grades as documented`, () => {
        assert.equal(generalizeCommand(obs.raw), obs.expected_pattern, 'pattern drift');
        if (obs.expected_grade !== undefined) {
          assert.equal(gradeCommand(obs.raw).grade, obs.expected_grade, 'grade drift');
        }
      });
    }
  }
});

describe('usage-records fixtures: malformed parse stats hold', () => {
  it('claude-malformed.jsonl has the documented JSON parse profile', () => {
    const s = jsonParseStats('claude-malformed.jsonl');
    const exp = manifest.fixtures.find((f) => f.file === 'claude-malformed.jsonl').expected_parse;
    assert.equal(s.ok, exp.parseable_json_lines, 'parseable count');
    assert.equal(s.bad, exp.unparseable_lines, 'unparseable count');
    assert.equal(s.empty, exp.empty_lines, 'empty-line count');
  });
  it('codex-malformed.jsonl: one truncated line + one valid line with non-JSON arguments', () => {
    const s = jsonParseStats('codex-malformed.jsonl');
    const exp = manifest.fixtures.find((f) => f.file === 'codex-malformed.jsonl').expected_parse;
    assert.equal(s.ok, exp.parseable_lines, 'parseable lines');
    assert.equal(s.bad, exp.unparseable_lines, 'unparseable lines');
    // count valid rollout lines whose shell arguments fail to parse
    let argBad = 0;
    for (const l of readLines('codex-malformed.jsonl')) {
      if (l.length === 0) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (o?.payload?.type === 'function_call' && o.payload.name === 'shell') {
        try { JSON.parse(o.payload.arguments); } catch { argBad++; }
      }
    }
    assert.equal(argBad, exp.valid_line_with_unparseable_arguments, 'unparseable-arguments count');
  });
});

describe('usage-records fixtures: redaction guarantee', () => {
  it('no generalized pattern from the secret fixture contains a secret fragment', () => {
    const fx = manifest.fixtures.find((f) => f.file === 'claude-secret-redaction.jsonl');
    const forbidden = fx.must_not_contain;
    for (const line of readLines('claude-secret-redaction.jsonl')) {
      if (line.length === 0) continue;
      const obj = JSON.parse(line);
      for (const c of obj.message?.content ?? []) {
        if (c.type === 'tool_use' && c.name === 'Bash') {
          const pattern = generalizeCommand(c.input.command);
          for (const frag of forbidden) {
            assert.ok(!pattern.includes(frag), `pattern "${pattern}" leaked "${frag}"`);
          }
        }
      }
    }
  });
});
