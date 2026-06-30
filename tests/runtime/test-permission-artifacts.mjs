// Tests for the ADR-0038 permission advisory ARTIFACT slice.
//
// This slice owns the sanitized plan/evidence artifact ENVELOPE, its latest
// pointer, the retention/inventory family registration, and pointer-only
// (text/json) output — all under the M1 boundary (no host-config writes).
//
// Design decision exercised here (the macro's "run-family vs settings-artifact
// reuse" question): the artifact reuses the SETTINGS-ARTIFACT shape — a fresh
// per-run directory (`runs/permission/<runId>/advisory.json`) plus an
// overwritten `runs/permission/latest.json` singleton pointer — NOT the
// consensus run-family state machine. A dir-per-run keeps doctor's
// subdirectory-counting inventory honest while the latest.json file is not
// counted as a run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeRule,
  makeEvidence,
  makeFragmentContract,
  ADVISOR_SCHEMA_VERSION,
} from '../../plugins/runtime/scripts/lib/permission-advisor-core.mjs';
import {
  PERMISSION_ARTIFACT_SCHEMA_VERSION,
  PERMISSION_LATEST_SCHEMA_VERSION,
  PERMISSION_ARTIFACT_KIND,
  PERMISSION_ARTIFACT_FAMILY,
  PERMISSION_ARTIFACT_SURFACES,
  PERMISSION_ARTIFACT_STATUSES,
  PERMISSION_RUN_ID_RE,
  makePermissionRunId,
  isValidPermissionRunId,
  validatePermissionRunId,
  permissionRunRoot,
  permissionRunDir,
  permissionArtifactFile,
  permissionLatestFile,
  makePermissionAdvisoryArtifact,
  isValidPermissionAdvisoryArtifact,
  isCurrentPermissionAdvisoryArtifact,
  writePermissionAdvisoryArtifact,
  recordPermissionAdvisoryArtifact,
  readPermissionAdvisoryArtifact,
  readLatestPermissionPointer,
  loadPermissionAdvisoryArtifact,
  loadLatestPermissionPointer,
  isValidPermissionLatestPointer,
  isCurrentPermissionLatestPointer,
  permissionArtifactPointers,
  permissionFooterArtifacts,
} from '../../plugins/runtime/scripts/lib/permission-artifacts.mjs';

const RUN_ID = 'permission-20260629T080824Z-0a1b2c';
const RUN_ID_2 = 'permission-20260629T090000Z-0d1e2f';
const CREATED_AT = '2026-06-29T08:08:24.000Z';

function sampleRule(host = 'claude') {
  return makeRule({
    host,
    cause: 'claude.bash-not-allowlisted',
    pattern: 'npm run *',
    grade: 'allow',
    evidence: makeEvidence({ count: 5, source: 'usage', note: 'seen 5x' }),
  });
}

function sampleClaudeFragment() {
  return makeFragmentContract({
    host: 'claude',
    rules: [sampleRule('claude')],
    modeRecommendation: { setting: 'defaultMode', value: 'acceptEdits', reason: 'clear file-modification prompts' },
    notes: ['apply via .claude/settings.json'],
  });
}

// A usage-learner learnFromSources()-shaped summary. Deliberately carries a raw
// transcript `path` so the path-stripping privacy guarantee can be asserted.
function sampleEvidence({ baselineUsed = false } = {}) {
  return {
    status: baselineUsed ? 'no_records_available' : 'analyzed',
    sources: [
      {
        path: '/Users/SECRETUSER/.claude/projects/acme/transcript.jsonl',
        host: 'claude',
        status: 'readable',
        observationCount: 5,
        malformedLines: 0,
      },
    ],
    rules: [sampleRule('claude')],
    modeEvidence: [{ host: 'claude', cause: 'claude.file-modification', count: 3 }],
    baselineCount: 2,
    baselineUsed,
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'permission-artifacts-'));
}

describe('permission-artifacts: run id', () => {
  it('makePermissionRunId stamps a regex-valid id from an injected clock', () => {
    const id = makePermissionRunId(new Date('2026-06-29T08:08:24.123Z'));
    assert.match(id, PERMISSION_RUN_ID_RE);
    assert.ok(id.startsWith('permission-20260629T080824Z-'));
  });
  it('isValidPermissionRunId accepts a well-formed id and rejects junk', () => {
    assert.equal(isValidPermissionRunId(RUN_ID), true);
    assert.equal(isValidPermissionRunId('consensus-20260629T080824Z-0a1b2c'), false);
    assert.equal(isValidPermissionRunId('permission-bogus'), false);
    assert.equal(isValidPermissionRunId(''), false);
    assert.equal(isValidPermissionRunId(null), false);
  });
  it('validatePermissionRunId throws on a path-traversal-shaped id', () => {
    assert.throws(() => validatePermissionRunId('../escape'), /invalid permission run id/);
    assert.throws(() => validatePermissionRunId('permission-20260629T080824Z-0a1b2c/../x'), /invalid permission run id/);
  });
});

describe('permission-artifacts: path resolution (settings-artifact shape)', () => {
  it('resolves the family dir, per-run dir, run file and latest pointer', () => {
    const repo = '/repo';
    assert.equal(permissionRunRoot(repo), '/repo/.agentic-plugins/runs/permission');
    assert.equal(permissionRunDir(repo, RUN_ID), `/repo/.agentic-plugins/runs/permission/${RUN_ID}`);
    assert.equal(permissionArtifactFile(repo, RUN_ID), `/repo/.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`);
    assert.equal(permissionLatestFile(repo), '/repo/.agentic-plugins/runs/permission/latest.json');
  });
  it('the family constant matches the on-disk segment doctor inventories', () => {
    assert.equal(PERMISSION_ARTIFACT_FAMILY, 'permission');
    assert.ok(permissionRunRoot('/r').endsWith('/runs/permission'));
  });
});

describe('permission-artifacts: artifact envelope', () => {
  it('builds a valid settings-surface artifact (plan + evidence)', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID,
      surface: 'settings',
      hosts: ['claude'],
      plan: [sampleClaudeFragment()],
      evidence: sampleEvidence(),
      createdAt: CREATED_AT,
    });
    assert.equal(a.schema_version, PERMISSION_ARTIFACT_SCHEMA_VERSION);
    assert.equal(a.advisor_schema_version, ADVISOR_SCHEMA_VERSION);
    assert.equal(a.kind, PERMISSION_ARTIFACT_KIND);
    assert.equal(a.run_id, RUN_ID);
    assert.equal(a.surface, 'settings');
    assert.equal(a.created_at, CREATED_AT);
    assert.equal(a.repo_root_pointer, '.');
    assert.deepEqual(a.hosts, ['claude']);
    assert.equal(a.status, 'analyzed');
    assert.equal(typeof a.runtime_version, 'string');
    assert.ok(a.runtime_version.length > 0);
    assert.equal(isValidPermissionAdvisoryArtifact(a), true);
    assert.equal(isCurrentPermissionAdvisoryArtifact(a), true);
  });

  it('builds a valid doctor-surface artifact with no plan', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID,
      surface: 'doctor',
      hosts: ['claude', 'codex'],
      evidence: sampleEvidence(),
      createdAt: CREATED_AT,
    });
    assert.equal(a.surface, 'doctor');
    assert.equal(a.plan, null);
    assert.deepEqual(a.hosts, ['claude', 'codex']);
    assert.equal(isValidPermissionAdvisoryArtifact(a), true);
  });

  it('derives status=baseline when the evidence fell back to baseline', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID,
      surface: 'doctor',
      hosts: ['claude'],
      evidence: sampleEvidence({ baselineUsed: true }),
      createdAt: CREATED_AT,
    });
    assert.equal(a.status, 'baseline');
    assert.ok(PERMISSION_ARTIFACT_STATUSES.includes(a.status));
  });

  it('stamps the ADR-0035/0038 boundary invariants as false', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude'], createdAt: CREATED_AT,
    });
    assert.equal(a.boundary.writes_host_config, false);
    assert.equal(a.boundary.ships_guard_hook, false);
    assert.equal(a.boundary.recommends_bypass_by_default, false);
  });

  it('rejects an unknown surface and an empty host set', () => {
    assert.throws(() => makePermissionAdvisoryArtifact({ runId: RUN_ID, surface: 'nope', hosts: ['claude'], createdAt: CREATED_AT }), /unknown surface/);
    assert.throws(() => makePermissionAdvisoryArtifact({ runId: RUN_ID, surface: 'doctor', hosts: [], createdAt: CREATED_AT }), /at least one valid host/);
    assert.throws(() => makePermissionAdvisoryArtifact({ runId: 'bad', surface: 'doctor', hosts: ['claude'], createdAt: CREATED_AT }), /invalid permission run id/);
  });

  it('rejects a plan fragment whose host is outside the artifact host set', () => {
    assert.throws(
      () => makePermissionAdvisoryArtifact({
        runId: RUN_ID, surface: 'settings', hosts: ['codex'],
        plan: [sampleClaudeFragment()], createdAt: CREATED_AT,
      }),
      /not in artifact hosts/,
    );
  });

  it('rejects an invalid fragment contract in the plan', () => {
    assert.throws(
      () => makePermissionAdvisoryArtifact({
        runId: RUN_ID, surface: 'settings', hosts: ['claude'],
        plan: [{ host: 'claude', rules: 'not-an-array' }], createdAt: CREATED_AT,
      }),
      /invalid fragment contract/,
    );
  });
});

describe('permission-artifacts: privacy (ADR-0038 §5 / ADR-0035 §6)', () => {
  it('strips the raw transcript path out of stored evidence sources', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude'],
      evidence: sampleEvidence(), createdAt: CREATED_AT,
    });
    assert.equal(a.evidence.sources.length, 1);
    const src = a.evidence.sources[0];
    assert.equal(Object.prototype.hasOwnProperty.call(src, 'path'), false);
    assert.equal(src.host, 'claude');
    assert.equal(src.status, 'readable');
    assert.equal(src.observation_count, 5);
    assert.equal(src.malformed_lines, 0);
    // The raw path (which may embed a local username / secret) appears nowhere.
    assert.ok(!JSON.stringify(a).includes('SECRETUSER'), 'raw source path must not survive into the artifact');
  });

  it('preserves only valid sanitized rules and the mode evidence counts', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude'],
      evidence: sampleEvidence(), createdAt: CREATED_AT,
    });
    assert.equal(a.evidence.rules.length, 1);
    assert.equal(a.evidence.rules[0].pattern, 'npm run *');
    assert.equal(a.evidence.mode_evidence[0].cause, 'claude.file-modification');
    assert.equal(a.evidence.mode_evidence[0].count, 3);
    assert.equal(a.evidence.baseline_count, 2);
    assert.equal(a.evidence.baseline_used, false);
  });

  it('collapses multi-line notes to a single sanitized line', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude'],
      notes: ['first line\nsecond line', '   ', 'kept'], createdAt: CREATED_AT,
    });
    assert.ok(a.notes.every((n) => !n.includes('\n')));
    assert.ok(a.notes.includes('kept'));
    assert.equal(a.notes.includes('   '), false, 'whitespace-only notes are dropped');
  });
});

describe('permission-artifacts: structural validator', () => {
  const base = () => makePermissionAdvisoryArtifact({
    runId: RUN_ID, surface: 'settings', hosts: ['claude'],
    plan: [sampleClaudeFragment()], evidence: sampleEvidence(), createdAt: CREATED_AT,
  });
  it('accepts a well-formed artifact', () => {
    assert.equal(isValidPermissionAdvisoryArtifact(base()), true);
  });
  it('rejects a wrong schema version (stale shape)', () => {
    assert.equal(isValidPermissionAdvisoryArtifact({ ...base(), schema_version: 'old' }), false);
    assert.equal(isCurrentPermissionAdvisoryArtifact({ ...base(), advisor_schema_version: '0.9' }), false);
  });
  it('rejects a tampered boundary that claims it writes host config', () => {
    const a = base();
    const tampered = { ...a, boundary: { ...a.boundary, writes_host_config: true } };
    assert.equal(isValidPermissionAdvisoryArtifact(tampered), false);
  });
  it('rejects evidence sources that smuggle a raw path back in', () => {
    const a = base();
    const tampered = {
      ...a,
      evidence: { ...a.evidence, sources: [{ ...a.evidence.sources[0], path: '/leak' }] },
    };
    assert.equal(isValidPermissionAdvisoryArtifact(tampered), false);
  });
  it('rejects a plan fragment for a host not in hosts[]', () => {
    const a = base();
    const tampered = { ...a, hosts: ['codex'] };
    assert.equal(isValidPermissionAdvisoryArtifact(tampered), false);
  });
});

describe('permission-artifacts: persistence (write/read round-trip)', () => {
  it('writes advisory.json under a per-run dir + an overwritten latest.json singleton', async () => {
    const repo = tmp();
    try {
      const a = makePermissionAdvisoryArtifact({
        runId: RUN_ID, surface: 'settings', hosts: ['claude'],
        plan: [sampleClaudeFragment()], evidence: sampleEvidence(), createdAt: CREATED_AT,
      });
      const pointers = await writePermissionAdvisoryArtifact({ repoRoot: repo, artifact: a });

      // Repo-relative, posix-separated pointers (never absolute).
      assert.equal(pointers.report_pointer, `.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`);
      assert.equal(pointers.run_pointer, `.agentic-plugins/runs/permission/${RUN_ID}`);
      assert.equal(pointers.latest_pointer, '.agentic-plugins/runs/permission/latest.json');
      assert.equal(pointers.family, 'permission');

      assert.ok(existsSync(permissionArtifactFile(repo, RUN_ID)));
      assert.ok(existsSync(permissionLatestFile(repo)));

      const back = await readPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID });
      assert.deepEqual(back, a);

      const latest = await readLatestPermissionPointer({ repoRoot: repo });
      assert.equal(latest.schema_version, PERMISSION_LATEST_SCHEMA_VERSION);
      assert.equal(latest.run_id, RUN_ID);
      assert.equal(latest.surface, 'settings');
      assert.equal(latest.report_pointer, `.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`);

      // A second run overwrites latest.json but preserves the first run dir.
      const a2 = makePermissionAdvisoryArtifact({
        runId: RUN_ID_2, surface: 'doctor', hosts: ['claude'],
        evidence: sampleEvidence(), createdAt: '2026-06-29T09:00:00.000Z',
      });
      await writePermissionAdvisoryArtifact({ repoRoot: repo, artifact: a2 });
      const latest2 = await readLatestPermissionPointer({ repoRoot: repo });
      assert.equal(latest2.run_id, RUN_ID_2);
      assert.ok(existsSync(permissionArtifactFile(repo, RUN_ID)), 'first run is retained, not pruned');
      assert.ok(existsSync(permissionArtifactFile(repo, RUN_ID_2)));

      // The artifact JSON is pretty-printed with a trailing newline (repo idiom).
      const raw = readFileSync(permissionArtifactFile(repo, RUN_ID), 'utf8');
      assert.ok(raw.endsWith('}\n'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses to write a structurally invalid artifact', async () => {
    const repo = tmp();
    try {
      await assert.rejects(
        () => writePermissionAdvisoryArtifact({ repoRoot: repo, artifact: { kind: 'nope', run_id: RUN_ID } }),
        /failed validation/,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('loadPermissionAdvisoryArtifact gates ok / missing / stale', async () => {
    const repo = tmp();
    try {
      assert.equal((await loadPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID })).status, 'missing');

      const a = makePermissionAdvisoryArtifact({
        runId: RUN_ID, surface: 'doctor', hosts: ['claude'], evidence: sampleEvidence(), createdAt: CREATED_AT,
      });
      await writePermissionAdvisoryArtifact({ repoRoot: repo, artifact: a });
      const ok = await loadPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID });
      assert.equal(ok.status, 'ok');
      assert.deepEqual(ok.artifact, a);

      // Hand-write a stale-schema artifact at a new run id.
      const stale = { ...a, run_id: RUN_ID_2, schema_version: 'runtime-permission-advisory-0.0' };
      await writePermissionAdvisoryArtifactUnchecked(repo, RUN_ID_2, stale);
      const got = await loadPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID_2 });
      assert.equal(got.status, 'stale');
      assert.match(got.reason, /schema mismatch/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('permission-artifacts: pointer output (text/json)', () => {
  it('permissionArtifactPointers returns repo-relative json pointers', () => {
    const p = permissionArtifactPointers({ repoRoot: '/repo', runId: RUN_ID });
    assert.deepEqual(p, {
      run_id: RUN_ID,
      family: 'permission',
      run_pointer: `.agentic-plugins/runs/permission/${RUN_ID}`,
      report_pointer: `.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`,
      latest_pointer: '.agentic-plugins/runs/permission/latest.json',
    });
  });
  it('permissionFooterArtifacts renders kind:path specs for the runtime footer', () => {
    const specs = permissionFooterArtifacts({ repoRoot: '/repo', runId: RUN_ID });
    assert.ok(specs.includes(`permission-advisory:.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`));
    assert.ok(specs.includes('permission-advisory-latest:.agentic-plugins/runs/permission/latest.json'));
    // Pointer-only: never the artifact body.
    assert.ok(specs.every((s) => !s.includes('{')));
  });
  it('exposes a closed surface + status vocabulary', () => {
    assert.deepEqual([...PERMISSION_ARTIFACT_SURFACES], ['doctor', 'settings']);
    assert.deepEqual([...PERMISSION_ARTIFACT_STATUSES].sort(), ['analyzed', 'baseline']);
  });
});

// Helper: write a JSON blob to a run path WITHOUT the validation gate, to seed
// stale-schema fixtures the loader must reject.
async function writePermissionAdvisoryArtifactUnchecked(repoRoot, runId, value) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const path = permissionArtifactFile(repoRoot, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRaw(path, text) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

function codexRule() {
  return makeRule({
    host: 'codex',
    cause: 'codex.sandbox-blocked',
    pattern: 'docker *',
    grade: 'ask',
    evidence: makeEvidence({ count: 2, source: 'usage', note: 'seen 2x' }),
  });
}

// --- Plan-verify peer MAJOR #1: strict-key privacy hardening ----------------

describe('permission-artifacts: strict-key validator (peer MAJOR #1)', () => {
  const base = () => makePermissionAdvisoryArtifact({
    runId: RUN_ID, surface: 'doctor', hosts: ['claude'], evidence: sampleEvidence(), createdAt: CREATED_AT,
  });
  it('rejects an injected unknown top-level key', () => {
    assert.equal(isValidPermissionAdvisoryArtifact({ ...base(), leaked_dump: 'secret' }), false);
  });
  it('rejects an evidence source carrying an extra leak-shaped key', () => {
    const a = base();
    const tampered = {
      ...a,
      evidence: { ...a.evidence, sources: [{ ...a.evidence.sources[0], source_path: '/Users/x/.claude/t.jsonl' }] },
    };
    assert.equal(isValidPermissionAdvisoryArtifact(tampered), false);
  });
  it('rejects an unknown evidence key and an unknown boundary key', () => {
    const a = base();
    assert.equal(isValidPermissionAdvisoryArtifact({ ...a, evidence: { ...a.evidence, raw_transcript: 'x' } }), false);
    assert.equal(isValidPermissionAdvisoryArtifact({ ...a, boundary: { ...a.boundary, extra: true } }), false);
  });
  it('recordPermissionAdvisoryArtifact builds through the constructor and writes', async () => {
    const repo = tmp();
    try {
      const { artifact, pointers } = await recordPermissionAdvisoryArtifact({
        repoRoot: repo, runId: RUN_ID, surface: 'doctor', hosts: ['claude'],
        evidence: sampleEvidence(), createdAt: CREATED_AT,
      });
      assert.equal(artifact.run_id, RUN_ID);
      assert.equal(pointers.report_pointer, `.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`);
      const loaded = await loadPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID });
      assert.equal(loaded.status, 'ok');
      assert.ok(!JSON.stringify(loaded.artifact).includes('SECRETUSER'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- Plan-verify peer MAJOR #2: latest pointer gating -----------------------

describe('permission-artifacts: latest pointer gating (peer MAJOR #2)', () => {
  it('loadLatestPermissionPointer gates missing / ok / stale / invalid', async () => {
    const repo = tmp();
    try {
      assert.equal((await loadLatestPermissionPointer({ repoRoot: repo })).status, 'missing');

      const a = makePermissionAdvisoryArtifact({
        runId: RUN_ID, surface: 'settings', hosts: ['claude'], plan: [sampleClaudeFragment()], createdAt: CREATED_AT,
      });
      await writePermissionAdvisoryArtifact({ repoRoot: repo, artifact: a });
      const ok = await loadLatestPermissionPointer({ repoRoot: repo });
      assert.equal(ok.status, 'ok');
      assert.equal(ok.pointer.run_id, RUN_ID);
      assert.equal(isValidPermissionLatestPointer(ok.pointer), true);
      assert.equal(isCurrentPermissionLatestPointer(ok.pointer), true);

      await writeRaw(permissionLatestFile(repo), `${JSON.stringify({ ...ok.pointer, schema_version: 'old' }, null, 2)}\n`);
      assert.equal((await loadLatestPermissionPointer({ repoRoot: repo })).status, 'stale');

      await writeRaw(permissionLatestFile(repo), '{ truncated');
      assert.equal((await loadLatestPermissionPointer({ repoRoot: repo })).status, 'invalid');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('isValidPermissionLatestPointer rejects an extra key', () => {
    const repo = '/repo';
    const valid = {
      schema_version: PERMISSION_LATEST_SCHEMA_VERSION,
      kind: 'permission-advisory',
      run_id: RUN_ID,
      surface: 'doctor',
      status: 'analyzed',
      hosts: ['claude'],
      updated_at: CREATED_AT,
      report_pointer: `.agentic-plugins/runs/permission/${RUN_ID}/advisory.json`,
      run_pointer: `.agentic-plugins/runs/permission/${RUN_ID}`,
    };
    assert.equal(isValidPermissionLatestPointer(valid), true);
    assert.equal(isValidPermissionLatestPointer({ ...valid, smuggled: 'x' }), false);
    void repo;
  });
});

// --- Plan-verify peer MINOR #3: atomicity + guarded parse -------------------

describe('permission-artifacts: atomicity + guarded parse (peer MINOR #3)', () => {
  it('classifies a truncated artifact body as invalid (never throws)', async () => {
    const repo = tmp();
    try {
      await writeRaw(permissionArtifactFile(repo, RUN_ID), '{ "kind": "permission-adviso');
      const got = await loadPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID });
      assert.equal(got.status, 'invalid');
      assert.match(got.reason, /not valid JSON/);
      // The lenient raw reader returns null rather than throwing.
      assert.equal(await readPermissionAdvisoryArtifact({ repoRoot: repo, runId: RUN_ID }), null);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('leaves no .tmp-* sidecar after an atomic write', async () => {
    const repo = tmp();
    try {
      const a = makePermissionAdvisoryArtifact({
        runId: RUN_ID, surface: 'doctor', hosts: ['claude'], createdAt: CREATED_AT,
      });
      await writePermissionAdvisoryArtifact({ repoRoot: repo, artifact: a });
      const { readdirSync } = await import('node:fs');
      const runEntries = readdirSync(permissionRunDir(repo, RUN_ID));
      assert.ok(runEntries.every((e) => !e.includes('.tmp-')), 'no temp sidecar in run dir');
      const rootEntries = readdirSync(permissionRunRoot(repo));
      assert.ok(rootEntries.every((e) => !e.includes('.tmp-')), 'no temp sidecar at family root');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- Plan-verify peer MINOR #4: evidence host-scoping -----------------------

describe('permission-artifacts: evidence host-scoping (peer MINOR #4)', () => {
  function mixedHostEvidence() {
    return {
      status: 'analyzed',
      sources: [
        { path: '/x/claude.jsonl', host: 'claude', status: 'readable', observationCount: 5, malformedLines: 0 },
        { path: '/x/codex.jsonl', host: 'codex', status: 'readable', observationCount: 2, malformedLines: 0 },
      ],
      rules: [sampleRule('claude'), codexRule()],
      modeEvidence: [
        { host: 'claude', cause: 'claude.file-modification', count: 3 },
        { host: 'codex', cause: 'codex.approval-requested', count: 1 },
      ],
      baselineCount: 0,
      baselineUsed: false,
    };
  }
  it('drops codex evidence from a claude-only artifact', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude'], evidence: mixedHostEvidence(), createdAt: CREATED_AT,
    });
    assert.deepEqual(a.evidence.sources.map((s) => s.host), ['claude']);
    assert.deepEqual(a.evidence.rules.map((r) => r.host), ['claude']);
    assert.deepEqual(a.evidence.mode_evidence.map((m) => m.host), ['claude']);
    assert.equal(a.evidence.source_count, 1);
    assert.equal(isValidPermissionAdvisoryArtifact(a), true);
  });
  it('keeps both hosts when the artifact scope includes both', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude', 'codex'], evidence: mixedHostEvidence(), createdAt: CREATED_AT,
    });
    assert.equal(a.evidence.sources.length, 2);
    assert.equal(a.evidence.rules.length, 2);
    assert.equal(a.evidence.mode_evidence.length, 2);
  });
  it('validator rejects a foreign-host evidence source / rule', () => {
    const a = makePermissionAdvisoryArtifact({
      runId: RUN_ID, surface: 'doctor', hosts: ['claude'], evidence: sampleEvidence(), createdAt: CREATED_AT,
    });
    const foreignSource = {
      ...a,
      evidence: { ...a.evidence, sources: [{ host: 'codex', status: 'readable', observation_count: 1, malformed_lines: 0 }] },
    };
    assert.equal(isValidPermissionAdvisoryArtifact(foreignSource), false);
    const foreignRule = { ...a, evidence: { ...a.evidence, rules: [codexRule()] } };
    assert.equal(isValidPermissionAdvisoryArtifact(foreignRule), false);
  });
});
