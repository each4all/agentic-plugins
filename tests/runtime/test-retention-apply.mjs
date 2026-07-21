// ADR-0047 §7 retention-apply tests — the M1 deleting executor. Safety-critical:
// dry-run default, plan-hash binding, scan_complete gate, family lock, open-receipt
// blocking, containment + no-follow re-validated at the destructive boundary,
// last-instant age re-check, write-ahead receipt state machine, per-invocation
// ceilings. Hermetic: gitTrackedFiles is injected so no git spawns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyRetention,
  resolveOpenReceipt,
  validateDeletionTarget,
  retentionStateRoot,
  computeExpectedHashHex,
  RETENTION_RECEIPT_SCHEMA_VERSION,
  APPLY_AGE_MARGIN_MS,
  APPLY_MAX_DELETIONS,
} from '../../plugins/runtime/scripts/lib/retention-apply.mjs';
import { planRetention } from '../../plugins/runtime/scripts/lib/retention-planner.mjs';

const execFileAsync = promisify(execFile);
const APPLY_LIB_URL = pathToFileURL(
  path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../plugins/runtime/scripts/lib/retention-apply.mjs'),
).href;

const NOW = new Date('2026-07-21T12:00:00Z');
const OLD_AGE = APPLY_AGE_MARGIN_MS + 24 * 60 * 60 * 1000; // a day past the margin

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-apply-'));
  fs.mkdirSync(path.join(root, '.agentic-plugins', 'runs'), { recursive: true });
  return root;
}

function familyDir(repoRoot, family) {
  const dir = path.join(repoRoot, '.agentic-plugins', 'runs', family);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Seed an OLD (age-cleared) run so it is a real deletion candidate.
function seedRun(repoRoot, family, runId, { ageMs = OLD_AGE, files = { 'snapshot.json': '{}' } } = {}) {
  const dir = path.join(familyDir(repoRoot, family), runId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(NOW.getTime() - ageMs);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, stamp, stamp);
  }
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

function writeLatest(repoRoot, family, runId) {
  fs.writeFileSync(path.join(familyDir(repoRoot, family), 'latest.json'), JSON.stringify({ run_id: runId }));
}

// The reviewed hash MUST be computed with the SAME caps the apply recomputes
// under (the hash covers the caps), so thread caps through the helper.
async function planHashFor(repoRoot, caps = {}) {
  const plan = await planRetention({ repoRoot, now: NOW, gitTrackedFiles: [], caps });
  return plan.plan_hash;
}

const C1 = 'compat-20260101T000000Z-000001';
const C2 = 'compat-20260102T000000Z-000002';
const C3 = 'compat-20260103T000000Z-000003';

describe('retention-apply validateDeletionTarget (containment + no-follow)', () => {
  it('accepts a valid run-id directory directly under runs/<family>/', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const res = await validateDeletionTarget({ repoRoot: repo, family: 'compat', runId: C1 });
    assert.equal(res.ok, true);
    assert.ok(res.runDir.endsWith(path.join('compat', C1)));
  });

  it('refuses an invalid run-id shape (no path games possible)', async () => {
    const repo = tmpRepo();
    const res = await validateDeletionTarget({ repoRoot: repo, family: 'compat', runId: '../escape' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid-run-id');
  });

  it('refuses a run path that is a SYMLINK (no-follow)', async () => {
    const repo = tmpRepo();
    const realDir = seedRun(repo, 'compat', C2);
    const linkPath = path.join(familyDir(repo, 'compat'), C1);
    fs.symlinkSync(realDir, linkPath);
    const res = await validateDeletionTarget({ repoRoot: repo, family: 'compat', runId: C1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'symlink-refused');
  });

  it('refuses when the family root itself is a symlink', async () => {
    const repo = tmpRepo();
    const realFamily = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-family-'));
    fs.mkdirSync(path.join(realFamily, C1), { recursive: true });
    fs.symlinkSync(realFamily, path.join(repo, '.agentic-plugins', 'runs', 'compat'));
    const res = await validateDeletionTarget({ repoRoot: repo, family: 'compat', runId: C1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'family-root-not-dir');
  });

  it('reports a vanished run as vanished (not an error)', async () => {
    const repo = tmpRepo();
    familyDir(repo, 'compat');
    const res = await validateDeletionTarget({ repoRoot: repo, family: 'compat', runId: C1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'vanished');
  });
});

describe('retention-apply dry-run (default; deletes nothing)', () => {
  it('reports candidates and writes NO receipt', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    seedRun(repo, 'compat', C2);
    const res = await applyRetention({ repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [] });
    assert.equal(res.status, 'dry-run');
    assert.equal(res.candidate_count, 2);
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'nothing deleted');
    assert.ok(!fs.existsSync(path.join(retentionStateRoot(repo), 'compat', 'receipt.json')), 'no receipt on dry-run');
  });
});

describe('retention-apply plan-hash binding + scan_complete gate', () => {
  it('REFUSES when the reviewed plan hash does not match the recomputed hash', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: 'sha256:' + '0'.repeat(64),
    });
    assert.equal(res.status, 'refused');
    assert.equal(res.reason, 'plan-hash-mismatch');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'refusal deletes nothing');
  });

  it('REFUSES (no deletion) when the pin scan is incomplete', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    // Force scan_complete false via a malformed doctor latest.json.
    fs.writeFileSync(path.join(familyDir(repo, 'doctor'), 'latest.json'), '{broken');
    const hash = await planHashFor(repo, { runCap: 0 });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash,
    });
    assert.equal(res.status, 'refused');
    assert.equal(res.reason, 'scan-incomplete');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)));
  });
});

describe('retention-apply execute (happy path + receipts)', () => {
  it('deletes the actionable candidates, records a closed receipt, keeps pinned + latest', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1); // oldest, unpinned → deletable
    seedRun(repo, 'compat', C2); // unpinned → deletable
    seedRun(repo, 'compat', C3); // newest, pinned via latest → kept
    writeLatest(repo, 'compat', C3);
    const hash = await planHashFor(repo, { runCap: 1 });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 1 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash,
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted.sort(), [C1, C2]);
    assert.equal(res.receipt_open, false);
    assert.ok(!fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'C1 deleted');
    assert.ok(!fs.existsSync(path.join(familyDir(repo, 'compat'), C2)), 'C2 deleted');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C3)), 'pinned C3 kept');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), 'latest.json')), 'latest.json never deleted');
    const receipt = JSON.parse(fs.readFileSync(path.join(retentionStateRoot(repo), 'compat', 'receipt.json'), 'utf8'));
    assert.equal(receipt.schema_version, RETENTION_RECEIPT_SCHEMA_VERSION);
    assert.equal(receipt.status, 'closed');
    assert.equal(receipt.plan_hash, hash);
    assert.ok(receipt.targets.every((t) => t.state === 'completed'));
  });

  it('accepts a bare-hex expected hash (normalized) and a full sha256: token', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const token = await planHashFor(repo, { runCap: 0 }); // sha256:<hex>
    const bareHex = token.slice('sha256:'.length);
    assert.equal(computeExpectedHashHex(bareHex), token);
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: computeExpectedHashHex(bareHex),
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted, [C1]);
  });

  it('transitions each target through started before the unlink (crash-safe receipt)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const hash = await planHashFor(repo, { runCap: 0 });
    const seen = [];
    // rmImpl hook: observe the receipt state at unlink time — it must read
    // `started` for the target being deleted (write-ahead), never `planned`.
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash,
      ceilings: {
        rmImpl: (runDir) => {
          const receipt = JSON.parse(fs.readFileSync(path.join(retentionStateRoot(repo), 'compat', 'receipt.json'), 'utf8'));
          seen.push(receipt.targets.find((t) => runDir.endsWith(t.run_id))?.state);
          fs.rmSync(runDir, { recursive: true, force: true });
        },
      },
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(seen, ['started'], 'the target must be `started` at unlink time');
  });
});

describe('retention-apply last-instant age re-check', () => {
  it('CONCEDES a candidate a concurrent writer touches AFTER validation, BEFORE deletion', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1); // old → passes the recompute's age guard, listed actionable
    const hash = await planHashFor(repo, { runCap: 0 });
    // afterValidate simulates the concurrent writer: it touches a file inside the
    // run to NOW between validateDeletionTarget and the in-lock age re-check. The
    // re-check must then see the fresh mtime and concede (never delete). Without
    // the re-check this run WOULD be deleted (the recompute already listed it).
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash,
      ceilings: {
        afterValidate: (runDir) => {
          const inner = path.join(runDir, 'snapshot.json');
          fs.utimesSync(inner, NOW, NOW); // a live writer just wrote
        },
      },
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted, [], 'the touched run must be conceded, not deleted');
    assert.deepEqual(res.conceded.map((c) => c.reason), ['too-recent']);
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'a concurrently-touched run survives');
  });
});

describe('retention-apply family lock + open-receipt blocking', () => {
  it('BLOCKS a new apply while an open receipt exists', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    // Plant an open receipt (a prior apply that did not close).
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({
      schema_version: RETENTION_RECEIPT_SCHEMA_VERSION, family: 'compat', status: 'open',
      targets: [{ run_id: C1, state: 'started' }],
    }));
    const hash = await planHashFor(repo, { runCap: 0 });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash,
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'open-receipt');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'blocked apply deletes nothing');
  });

  it('BLOCKS on a receipt from a newer/unknown schema (downgrade safety)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({
      schema_version: 'runtime-retention-receipt-999.0', family: 'compat', status: 'open', targets: [],
    }));
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [], execute: true, expectedPlanHash: await planHashFor(repo, { runCap: 0 }),
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'receipt-schema-mismatch');
  });
});

describe('retention-apply resolveOpenReceipt', () => {
  it('closes an open receipt, marking a planned target not-started and a started+present target state-unknown', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1); // still present → started target reads state-unknown
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({
      schema_version: RETENTION_RECEIPT_SCHEMA_VERSION, family: 'compat', status: 'open',
      targets: [{ run_id: C1, state: 'started' }, { run_id: C2, state: 'planned' }],
    }));
    const res = await resolveOpenReceipt({ repoRoot: repo, family: 'compat', now: NOW });
    assert.equal(res.status, 'resolved');
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'closed');
    assert.equal(receipt.targets.find((t) => t.run_id === C1).outcome, 'state-unknown-run-present');
    assert.equal(receipt.targets.find((t) => t.run_id === C2).outcome, 'not-started');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'resolve never deletes');
  });
});

describe('retention-apply ceilings', () => {
  it('honors the per-invocation deletion ceiling and leaves the receipt open', async () => {
    const repo = tmpRepo();
    for (const id of [C1, C2, C3]) seedRun(repo, 'compat', id);
    const hash = await planHashFor(repo, { runCap: 0 });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash, ceilings: { maxDeletions: 2 },
    });
    assert.equal(res.status, 'applied');
    assert.equal(res.deleted.length, 2, 'ceiling caps deletions at 2');
    // 2 of 3 deleted; 1 remains.
    const remaining = [C1, C2, C3].filter((id) => fs.existsSync(path.join(familyDir(repo, 'compat'), id)));
    assert.equal(remaining.length, 1);
  });

  it('honors the per-invocation BYTE ceiling and leaves the receipt open', async () => {
    const repo = tmpRepo();
    // Three ~2 MB runs; a 3 MB byte ceiling admits the first, then the second
    // would exceed the budget → stop. (A single run larger than the whole budget
    // on the FIRST deletion is still allowed so a big run is never un-deletable.)
    for (const id of [C1, C2, C3]) seedRun(repo, 'compat', id, { files: { 'big': 'x'.repeat(2_000_000) } });
    const hash = await planHashFor(repo, { runCap: 0 });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: hash, ceilings: { maxBytes: 3_000_000 },
    });
    assert.equal(res.status, 'applied');
    assert.equal(res.deleted.length, 1, 'the byte ceiling stops after the first ~2MB run');
    assert.equal(res.receipt_open, true, 'leftover targets keep the receipt open');
  });

  it('pins the ceiling constants', () => {
    assert.equal(APPLY_MAX_DELETIONS, 50);
  });
});

describe('retention-apply guards', () => {
  it('throws on a missing repoRoot and an unknown family', async () => {
    await assert.rejects(() => applyRetention({ repoRoot: '', family: 'compat' }), /repoRoot/);
    await assert.rejects(() => applyRetention({ repoRoot: '/tmp/x', family: 'bogus' }), /unknown retention family/);
  });
});

// Cross-process: two apply processes racing the family lock must not both delete
// the same run (the lock is a real mutex, not advisory).
describe('retention-apply cross-process family lock', () => {
  it('two concurrent execute applies delete each run at most once', async () => {
    const repo = tmpRepo();
    for (let i = 0; i < 6; i += 1) {
      seedRun(repo, 'compat', `compat-2026010${i}T000000Z-00000${i}`);
    }
    const hash = await planHashFor(repo, { runCap: 0 });
    const script = `
      import { applyRetention } from ${JSON.stringify(APPLY_LIB_URL)};
      const [repo, hash, nowIso] = process.argv.slice(1);
      const res = await applyRetention({
        repoRoot: repo, family: 'compat', now: new Date(nowIso), caps: { runCap: 0 },
        gitTrackedFiles: [], execute: true, expectedPlanHash: hash,
      });
      process.stdout.write(JSON.stringify({ status: res.status, deleted: res.deleted ?? [], blocked: res.reason ?? null }));
    `;
    const runs = await Promise.all([
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, '--', repo, hash, NOW.toISOString()]),
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, '--', repo, hash, NOW.toISOString()]),
    ]);
    const results = runs.map(({ stdout }) => JSON.parse(stdout));
    const allDeleted = results.flatMap((r) => r.deleted);
    // No run id deleted by BOTH processes (real mutual exclusion — a double
    // delete would either double-count here or one process would error).
    assert.equal(new Set(allDeleted).size, allDeleted.length, `a run was deleted twice: ${JSON.stringify(results)}`);
  });
});
