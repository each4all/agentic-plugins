// ADR-0047 §7 retention-apply tests — the M1 deleting executor. Safety-critical:
// dry-run default, plan-hash binding, scan_complete gate, family lock, open-receipt
// blocking, containment + no-follow re-validated at the destructive boundary,
// last-instant age re-check, write-ahead receipt state machine, per-invocation
// ceilings. Hermetic: gitTrackedFiles is injected so no git spawns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
  // A real (empty) git repo: execute mode forces the real `git ls-files` scan
  // (an injected gitTrackedFiles is ignored for a real deletion), and an empty
  // repo enumerates to [] — no citations — so the hermetic fixtures still work.
  execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
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
    assert.equal(res.reason, 'ancestor-symlink');
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
        // rmImpl receives the capture TOMBSTONE (`<runDir>.gc-<nonce>`), which
        // still contains the run_id before the suffix.
        rmImpl: (tombstone) => {
          const receipt = JSON.parse(fs.readFileSync(path.join(retentionStateRoot(repo), 'compat', 'receipt.json'), 'utf8'));
          seen.push(receipt.targets.find((t) => tombstone.includes(t.run_id))?.state);
          fs.rmSync(tombstone, { recursive: true, force: true });
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
// the same run (the lock is a real mutex, not advisory). A GO-file barrier lines
// the children up so their critical sections actually OVERLAP — without it the
// test could pass trivially by the two runs not contending (Codex review MAJOR).
describe('retention-apply cross-process family lock', () => {
  it('barrier-synchronized concurrent execute applies delete each run at most once', async () => {
    const repo = tmpRepo();
    for (let i = 0; i < 6; i += 1) {
      seedRun(repo, 'compat', `compat-2026020${i}T000000Z-00000${i}`);
    }
    const hash = await planHashFor(repo, { runCap: 0 });
    const goPath = path.join(repo, 'GO');
    const barrier = `
      const fsb = await import('node:fs');
      const deadline = Date.now() + 5000;
      while (!fsb.existsSync(${JSON.stringify(goPath)})) { if (Date.now() > deadline) throw new Error('barrier timeout'); }
    `;
    const script = `
      import { applyRetention } from ${JSON.stringify(APPLY_LIB_URL)};
      ${barrier}
      const [repo, hash, nowIso] = process.argv.slice(1);
      const res = await applyRetention({
        repoRoot: repo, family: 'compat', now: new Date(nowIso), caps: { runCap: 0 },
        execute: true, expectedPlanHash: hash,
      });
      process.stdout.write(JSON.stringify({ status: res.status, deleted: res.deleted ?? [] }));
    `;
    const children = [
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, '--', repo, hash, NOW.toISOString()]),
      execFileAsync(process.execPath, ['--input-type=module', '-e', script, '--', repo, hash, NOW.toISOString()]),
    ];
    fs.writeFileSync(goPath, 'go'); // release both at once
    const results = (await Promise.all(children)).map(({ stdout }) => JSON.parse(stdout));
    const allDeleted = results.flatMap((r) => r.deleted);
    // No run id deleted by BOTH processes — real mutual exclusion. (One process
    // typically applies; the other blocks on the lock or finds the receipt.)
    assert.equal(new Set(allDeleted).size, allDeleted.length, `a run was deleted twice: ${JSON.stringify(results)}`);
  });
});

// ── Codex review fold: the safety-critical fixes ──
describe('retention-apply guard-layer fixes (Codex review CRITICAL/MAJOR)', () => {
  it('refuses an ANCESTOR symlink at .agentic-plugins/runs (not just the family root)', async () => {
    const repo = tmpRepo();
    const realRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-runs-'));
    fs.mkdirSync(path.join(realRuns, 'compat', C1), { recursive: true });
    // Replace .agentic-plugins/runs with a symlink to an external tree.
    fs.rmSync(path.join(repo, '.agentic-plugins', 'runs'), { recursive: true, force: true });
    fs.symlinkSync(realRuns, path.join(repo, '.agentic-plugins', 'runs'));
    const res = await validateDeletionTarget({ repoRoot: repo, family: 'compat', runId: C1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ancestor-symlink', 'a symlink at the runs level must be refused');
  });

  it('execute:true with a NULL expectedPlanHash THROWS (lib-level plan-hash binding)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    await assert.rejects(
      () => applyRetention({ repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [], execute: true }),
      /requires expectedPlanHash/,
    );
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'a bare execute must delete nothing');
  });

  it('a truthy non-true execute value does NOT enter deletion mode', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const res = await applyRetention({ repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [], execute: 'yes' });
    assert.equal(res.status, 'dry-run', 'only execute === true deletes');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)));
  });

  it('CONCEDES a run a writer pins (repoints latest.json) AFTER the recompute', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const hash = await planHashFor(repo, { runCap: 0 });
    // afterValidate simulates the pin-writer racing the deletion: it repoints
    // latest.json to the candidate between validation and deletion. The
    // per-target fast pin re-check must then concede it.
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, execute: true, expectedPlanHash: hash,
      ceilings: {
        afterValidate: () => { writeLatest(repo, 'compat', C1); },
      },
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted, [], 'a newly-pinned run must not be deleted');
    assert.deepEqual(res.conceded.map((c) => c.reason), ['now-pinned']);
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)));
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), 'latest.json')), 'latest.json is not left dangling');
  });

  it('BLOCKS on a receipt carrying an UNKNOWN target state (fail-closed, not overwritten)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({
      schema_version: RETENTION_RECEIPT_SCHEMA_VERSION, family: 'compat', status: 'closed',
      targets: [{ run_id: C1, state: 'weird-unknown-state' }],
    }));
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, execute: true, expectedPlanHash: await planHashFor(repo, { runCap: 0 }),
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'receipt-unknown-target-state');
  });

  it('BLOCKS on a receipt missing its schema_version (fail-closed)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({ family: 'compat', status: 'closed', targets: [] }));
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, execute: true, expectedPlanHash: await planHashFor(repo, { runCap: 0 }),
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'receipt-schema-mismatch');
  });

  it('CLAMPS a raised ceiling to the hard default (cannot widen the deletion budget)', async () => {
    const repo = tmpRepo();
    // 3 candidates; a caller tries maxDeletions: 9999 — clamped to APPLY_MAX_DELETIONS,
    // so it never exceeds the hard cap. (Here just assert the reported ceiling.)
    for (const id of [C1, C2, C3]) seedRun(repo, 'compat', id);
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      ceilings: { maxDeletions: 9999 },
    });
    assert.equal(res.status, 'dry-run');
    assert.equal(res.ceilings.maxDeletions, APPLY_MAX_DELETIONS, 'a raised ceiling is clamped to the hard default');
  });

  it('maxBytes:0 deletes NOTHING (the byte ceiling admits nothing)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1, { files: { 'x': 'nonempty' } });
    const hash = await planHashFor(repo, { runCap: 0 });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, execute: true, expectedPlanHash: hash, ceilings: { maxBytes: 0 },
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted, [], 'maxBytes:0 admits no deletion');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)));
  });

  it('resolveOpenReceipt reports an UNREADABLE (invalid-JSON) receipt honestly, never silently closed', async () => {
    const repo = tmpRepo();
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), '{ not json');
    const res = await resolveOpenReceipt({ repoRoot: repo, family: 'compat', now: NOW });
    assert.equal(res.status, 'unreadable');
  });

  it('resolveOpenReceipt reports a parseable-but-MALFORMED receipt (non-object targets) honestly', async () => {
    const repo = tmpRepo();
    const receiptDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(receiptDir, { recursive: true });
    // Valid JSON but `targets` is not an array → malformed, must not be closed.
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify({ schema_version: RETENTION_RECEIPT_SCHEMA_VERSION, targets: 'nope' }));
    const res = await resolveOpenReceipt({ repoRoot: repo, family: 'compat', now: NOW });
    assert.equal(res.status, 'malformed');
  });

  it('a FRESH family lock BLOCKS apply (staleness judged against real time, not injected now)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    // Plant a fresh lock (mtime ~ real now). The injected `now` is in the PAST
    // (NOW=2026-07-21). A lock judged by the injected clock would look
    // far-future-stale and be taken over; judged by REAL time it is held.
    const lockDir = path.join(retentionStateRoot(repo), 'compat');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, '.lock'), '99999:deadbeefdeadbeef');
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [],
      execute: true, expectedPlanHash: await planHashFor(repo, { runCap: 0 }),
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'family-lock:lock-held', 'a fresh lock must be honored, not taken over');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)), 'a blocked apply deletes nothing');
  });

  it('a REAL deletion ignores an injected gitTrackedFiles and runs the full git citation scan', async () => {
    const repo = tmpRepo(); // git-inited
    seedRun(repo, 'compat', C1);
    // A TRACKED doc cites C1 → the real git scan pins it. A caller injecting
    // gitTrackedFiles:[] (an empty scan) must NOT be able to weaken this and
    // delete the cited run.
    fs.writeFileSync(path.join(repo, 'CITES.md'), `pinned: ${C1}\n`);
    execFileSync('git', ['-C', repo, 'add', 'CITES.md'], { stdio: 'ignore' });
    // Compute the reviewed hash the SAME way execute recomputes (real scan) so
    // the plan-hash binding passes and we exercise the deletion path.
    const realPlan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 0 } });
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, gitTrackedFiles: [], // injected empty — must be ignored
      execute: true, expectedPlanHash: realPlan.plan_hash,
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted, [], 'the git-cited run must not be deleted despite the injected empty scan');
    assert.ok(fs.existsSync(path.join(familyDir(repo, 'compat'), C1)));
  });

  it('CONCEDES (never external-deletes) a run swapped to a SYMLINK after validation — capture-rename', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', C1);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'external-target-'));
    fs.writeFileSync(path.join(external, 'precious.txt'), 'must survive');
    const hash = await planHashFor(repo, { runCap: 0 });
    const runPath = path.join(familyDir(repo, 'compat'), C1);
    const res = await applyRetention({
      repoRoot: repo, family: 'compat', now: NOW, caps: { runCap: 0 }, execute: true, expectedPlanHash: hash,
      ceilings: {
        afterValidate: (runDir) => {
          // A hostile swap: replace the validated run dir with a symlink to an
          // external tree between validation and deletion. Backdate the link so
          // the age re-check passes and the capture-rename + re-lstat is the
          // guard that refuses the recursive removal.
          fs.rmSync(runDir, { recursive: true, force: true });
          fs.symlinkSync(external, runDir);
          const old = new Date(NOW.getTime() - OLD_AGE);
          fs.lutimesSync(runDir, old, old);
        },
      },
    });
    assert.equal(res.status, 'applied');
    assert.deepEqual(res.deleted, [], 'a swapped symlink must not be reported deleted');
    assert.ok(res.conceded.some((c) => c.reason === 'capture-not-dir'), 'the capture re-lstat must concede a non-dir');
    assert.ok(fs.existsSync(path.join(external, 'precious.txt')), 'the external symlink target must survive');
    fs.rmSync(runPath, { recursive: true, force: true }); // cleanup the leftover link
  });
});
