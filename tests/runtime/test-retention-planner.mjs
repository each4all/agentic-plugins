// ADR-0047 §7 citation-aware retention planner tests. Pure read-only planner:
// closed family registry, the four pin sources, fail-closed scan_complete,
// actionable-vs-pinned overage, minimum-age guard, and the canonical plan hash.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RETENTION_PLANNER_VERSION,
  RETENTION_SCANNER_VERSION,
  RETENTION_FAMILY_REGISTRY,
  RETENTION_FAMILIES,
  CITATION_SCAN_MAX_FILES,
  CITATION_SCAN_MAX_FILE_BYTES,
  CITATION_SCAN_MAX_TOTAL_BYTES,
  RETENTION_MIN_AGE_MS,
  runIdTimestamp,
  scanTrackedDocCitations,
  resolveLatestPins,
  resolveLivePins,
  scanCrossArtifactReferences,
  planRetention,
  computeRetentionPlanHash,
  projectRetentionAttention,
  reconcileRetentionAttention,
} from '../../plugins/runtime/scripts/lib/retention-planner.mjs';

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  fs.mkdirSync(path.join(root, '.agentic-plugins', 'runs'), { recursive: true });
  return root;
}

function familyDir(repoRoot, family) {
  const dir = path.join(repoRoot, '.agentic-plugins', 'runs', family);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Seed a run directory with files and a controllable newest mtime (drives the
// age guard). `ageMs` is how far in the past to stamp relative to NOW.
const NOW = new Date('2026-07-21T12:00:00Z');
function seedRun(repoRoot, family, runId, { files = { 'x.json': '{}' }, ageMs = RETENTION_MIN_AGE_MS + 60_000, bytes = null } = {}) {
  const dir = path.join(familyDir(repoRoot, family), runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const body = bytes !== null ? 'x'.repeat(bytes) : content;
    fs.writeFileSync(path.join(dir, name), body);
  }
  const stamp = new Date(NOW.getTime() - ageMs);
  for (const name of Object.keys(files)) {
    fs.utimesSync(path.join(dir, name), stamp, stamp);
  }
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

function writeLatest(repoRoot, family, runId) {
  fs.writeFileSync(
    path.join(familyDir(repoRoot, family), 'latest.json'),
    JSON.stringify({ schema_version: 'x', run_id: runId }),
  );
}

const DOCTOR_A = 'doctor-20260101T000000Z-aaaaaa';
const DOCTOR_B = 'doctor-20260201T000000Z-bbbbbb';
const COMPAT_A = 'compat-20260101T000000Z-cccccc';
const SETTINGS_A = 'settings-20260101T000000Z-dddddd';

describe('retention-planner registry + constants', () => {
  it('pins the closed v1 family registry to exactly doctor/compat/settings', () => {
    assert.deepEqual([...RETENTION_FAMILIES].sort(), ['compat', 'doctor', 'settings']);
    assert.ok(Object.isFrozen(RETENTION_FAMILY_REGISTRY));
    for (const family of RETENTION_FAMILIES) {
      assert.ok(RETENTION_FAMILY_REGISTRY[family].runIdRe instanceof RegExp);
    }
  });

  it('pins scan-bound + version constants', () => {
    assert.equal(RETENTION_PLANNER_VERSION, 'runtime-retention-planner-1.0');
    assert.equal(RETENTION_SCANNER_VERSION, 'runtime-retention-scanner-1.0');
    assert.equal(CITATION_SCAN_MAX_FILES, 5000);
    assert.equal(CITATION_SCAN_MAX_FILE_BYTES, 1024 * 1024);
    assert.equal(CITATION_SCAN_MAX_TOTAL_BYTES, 64 * 1024 * 1024);
    assert.equal(RETENTION_MIN_AGE_MS, 15 * 60 * 1000);
  });

  it('runIdTimestamp orders run-ids by embedded timestamp; malformed → 0', () => {
    assert.ok(runIdTimestamp(DOCTOR_A) < runIdTimestamp(DOCTOR_B));
    assert.equal(runIdTimestamp('not-a-run-id'), 0);
    assert.equal(runIdTimestamp(''), 0);
    assert.equal(runIdTimestamp(undefined), 0);
  });
});

describe('retention-planner pin 1 — tracked-doc citations', () => {
  it('pins a run-id cited as a bare token AND as a runs/ path string', async () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'doc1.md'), `see ${DOCTOR_A} for details`);
    fs.writeFileSync(path.join(repo, 'doc2.md'), `path .agentic-plugins/runs/compat/${COMPAT_A}/snapshot.json`);
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: ['doc1.md', 'doc2.md'] });
    assert.equal(res.scanComplete, true);
    assert.ok(res.pinned.get('doctor').has(DOCTOR_A));
    assert.ok(res.pinned.get('compat').has(COMPAT_A));
  });

  it('records a NUL-byte binary file as skipped (isolates the NUL check) and does NOT flip scan_complete', async () => {
    const repo = tmpRepo();
    // NUL byte but otherwise valid UTF-8 — only the NUL check can refuse it, so
    // disabling that check alone must break this test (the '�' check cannot save it).
    // 'plain\x00text' via explicit bytes (no raw NUL in source): valid UTF-8 with an embedded NUL.
    fs.writeFileSync(path.join(repo, 'nul.bin'), Buffer.from([0x70, 0x6c, 0x61, 0x69, 0x6e, 0x00, 0x74, 0x65, 0x78, 0x74]));
    fs.writeFileSync(path.join(repo, 'doc.md'), `cite ${DOCTOR_A}`);
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: ['nul.bin', 'doc.md'] });
    assert.equal(res.scanComplete, true, 'binary skip must not flip scan_complete');
    assert.equal(res.files_skipped_binary, 1);
    assert.ok(res.pinned.get('doctor').has(DOCTOR_A));
  });

  it('records an invalid-UTF-8 file as skipped (isolates the undecodable check)', async () => {
    const repo = tmpRepo();
    // A lone 0xff is invalid UTF-8 with NO NUL byte — only the '�' check refuses it.
    fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0x41, 0x42, 0xff, 0x43]));
    fs.writeFileSync(path.join(repo, 'doc.md'), `cite ${DOCTOR_A}`);
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: ['img.bin', 'doc.md'] });
    assert.equal(res.scanComplete, true);
    assert.equal(res.files_skipped_binary, 1);
    assert.ok(res.pinned.get('doctor').has(DOCTOR_A));
  });

  it('flips scan_complete when git enumeration fails (null provider result)', async () => {
    const repo = tmpRepo();
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: 'not-an-array' });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /enumeration failed/);
  });

  it('flips scan_complete when the tracked file count exceeds the cap', async () => {
    const repo = tmpRepo();
    const many = Array.from({ length: CITATION_SCAN_MAX_FILES + 1 }, (_, i) => `f${i}.txt`);
    // Only need one real file to exercise the prefix scan; the rest are absent.
    fs.writeFileSync(path.join(repo, 'f0.txt'), `cite ${DOCTOR_A}`);
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: many });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /exceeds scan cap/);
  });

  it('flips scan_complete when a tracked file exceeds the per-file byte cap', async () => {
    const repo = tmpRepo();
    const big = path.join(repo, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(CITATION_SCAN_MAX_FILE_BYTES + 1));
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: ['big.txt'] });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /per-file cap/);
  });

  it('flips scan_complete when a tracked file is unreadable (present in list, fs error)', async () => {
    const repo = tmpRepo();
    // A directory named like a file: readFile raises EISDIR after lstat says non-file.
    // Use a real unreadable case: a path that lstat can stat but readFile denies.
    const p = path.join(repo, 'noperm.txt');
    fs.writeFileSync(p, `cite ${DOCTOR_A}`);
    if (process.getuid?.() === 0) return; // root bypasses perms
    fs.chmodSync(p, 0o000);
    try {
      const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: ['noperm.txt'] });
      assert.equal(res.scanComplete, false);
      assert.match(res.incomplete[0].reason, /unreadable/);
    } finally {
      fs.chmodSync(p, 0o600);
    }
  });

  it('a tracked-but-deleted file (ENOENT) is skipped without flipping scan_complete', async () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'present.md'), `cite ${DOCTOR_A}`);
    const res = await scanTrackedDocCitations({ repoRoot: repo, gitTrackedFiles: ['present.md', 'gone.md'] });
    assert.equal(res.scanComplete, true);
    assert.ok(res.pinned.get('doctor').has(DOCTOR_A));
  });
});

describe('retention-planner pin 2 — latest pointers', () => {
  it('pins the run in a valid latest.json; absent latest is not an error', async () => {
    const repo = tmpRepo();
    writeLatest(repo, 'doctor', DOCTOR_A);
    // compat + settings have no latest.json
    const res = await resolveLatestPins({ repoRoot: repo });
    assert.equal(res.scanComplete, true);
    assert.ok(res.pinned.get('doctor').has(DOCTOR_A));
    assert.equal(res.pinned.get('compat').size, 0);
  });

  it('flips scan_complete on a malformed latest.json', async () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(familyDir(repo, 'compat'), 'latest.json'), '{not json');
    const res = await resolveLatestPins({ repoRoot: repo });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /malformed/);
  });

  it('flips scan_complete when latest.json run_id is missing or invalid', async () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(familyDir(repo, 'settings'), 'latest.json'), JSON.stringify({ run_id: 'bogus' }));
    const res = await resolveLatestPins({ repoRoot: repo });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /run_id missing or malformed/);
  });
});

describe('retention-planner pin 3 — live / reader-selected', () => {
  it('pins a non-terminal settings execution artifact', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'settings', SETTINGS_A, {
      files: { 'settings.json': JSON.stringify({ status: 'in-progress', terminal: false }) },
    });
    const res = await resolveLivePins({ repoRoot: repo });
    assert.ok(res.pinned.get('settings').has(SETTINGS_A));
  });

  it('pins the settings run carrying a resolved attestation', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'settings', SETTINGS_A, {
      files: { 'settings.json': JSON.stringify({ status: 'completed', terminal: true, codex_hook_review: { attested: true, status: 'attested' } }) },
    });
    const res = await resolveLivePins({ repoRoot: repo });
    assert.ok(res.pinned.get('settings').has(SETTINGS_A));
  });

  it('does NOT pin a terminal settings run with no attestation', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'settings', SETTINGS_A, {
      files: { 'settings.json': JSON.stringify({ status: 'completed', terminal: true }) },
    });
    const res = await resolveLivePins({ repoRoot: repo });
    assert.equal(res.pinned.get('settings').has(SETTINGS_A), false);
  });

  it('pins the doctor latest run as the reader fallback floor', async () => {
    const repo = tmpRepo();
    writeLatest(repo, 'doctor', DOCTOR_B);
    const res = await resolveLivePins({ repoRoot: repo });
    assert.ok(res.pinned.get('doctor').has(DOCTOR_B));
  });

  it('flips scan_complete when a settings artifact is malformed', async () => {
    const repo = tmpRepo();
    const dir = path.join(familyDir(repo, 'settings'), SETTINGS_A);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{bad');
    const res = await resolveLivePins({ repoRoot: repo });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /unreadable\/malformed/);
  });
});

describe('retention-planner pin 4 — cross-artifact references', () => {
  it('pins a run cited inside a doctor.json snapshot', async () => {
    const repo = tmpRepo();
    // doctor run whose doctor.json embeds a COMPAT evidence id
    seedRun(repo, 'doctor', DOCTOR_A, {
      files: { 'doctor.json': JSON.stringify({ report: { compat: { recorded_run_id: COMPAT_A } } }) },
    });
    const res = await scanCrossArtifactReferences({ repoRoot: repo });
    assert.equal(res.scanComplete, true);
    assert.ok(res.pinned.get('compat').has(COMPAT_A));
  });

  it('pins a run cited inside a cutover evidence artifact-pointer list', async () => {
    const repo = tmpRepo();
    const cutoverRun = 'cutover-20260101T000000Z-eeeeee';
    seedRun(repo, 'cutover', cutoverRun, {
      files: { 'evidence.json': JSON.stringify({ artifacts: [`.agentic-plugins/runs/settings/${SETTINGS_A}/settings.json`] }) },
    });
    const res = await scanCrossArtifactReferences({ repoRoot: repo });
    assert.ok(res.pinned.get('settings').has(SETTINGS_A));
  });

  it('flips scan_complete on a malformed (undecodable) cross-artifact source', async () => {
    const repo = tmpRepo();
    const dir = path.join(familyDir(repo, 'doctor'), DOCTOR_A);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'doctor.json'), Buffer.from([0x00, 0xff, 0x00]));
    const res = await scanCrossArtifactReferences({ repoRoot: repo });
    assert.equal(res.scanComplete, false);
    assert.match(res.incomplete[0].reason, /undecodable/);
  });
});

describe('retention-planner planRetention integration', () => {
  it('classifies over-cap runs into actionable (unpinned, aged) vs pinned overage', async () => {
    const repo = tmpRepo();
    // 3 compat runs, cap 1. One is pinned via latest, the other two are old + unpinned.
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002');
    seedRun(repo, 'compat', 'compat-20260103T000000Z-000003');
    writeLatest(repo, 'compat', 'compat-20260103T000000Z-000003'); // newest pinned
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 1, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    const compat = plan.families.compat;
    assert.equal(compat.over_cap, true);
    // cap 1, 3 runs, excess 2. newest is pinned → the two OLDEST unpinned are actionable.
    assert.deepEqual(compat.actionable_excess, ['compat-20260101T000000Z-000001', 'compat-20260102T000000Z-000002']);
    assert.deepEqual(compat.pinned_overage, ['compat-20260103T000000Z-000003']);
  });

  it('never makes a run younger than the minimum-age guard actionable', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001', { ageMs: RETENTION_MIN_AGE_MS + 60_000 }); // old
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002', { ageMs: 60_000 }); // TOO YOUNG (1 min)
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 0, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    const compat = plan.families.compat;
    assert.deepEqual(compat.actionable_excess, ['compat-20260101T000000Z-000001']);
    assert.deepEqual(compat.withheld_too_young, ['compat-20260102T000000Z-000002']);
  });

  it('when pins alone exceed the cap, nothing is actionable — all pinned overage', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002');
    // Both cited in a tracked doc → both pinned.
    fs.writeFileSync(path.join(repo, 'doc.md'), 'compat-20260101T000000Z-000001 compat-20260102T000000Z-000002');
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 1, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: ['doc.md'] });
    const compat = plan.families.compat;
    assert.equal(compat.over_cap, true);
    assert.equal(compat.actionable_excess.length, 0);
    assert.equal(compat.pinned_overage.length, 2);
  });

  it('byte-cap pressure makes oldest unpinned runs actionable even under the count cap', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001', { files: { 'big': '' }, bytes: 2_000_000 });
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002', { files: { 'big': '' }, bytes: 2_000_000 });
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 10, maxBytes: 3_000_000 }, gitTrackedFiles: [] });
    const compat = plan.families.compat;
    assert.equal(compat.over_cap_by_bytes, true);
    assert.equal(compat.over_cap_by_count, false);
    // total 4MB, cap 3MB → must delete the oldest to get under.
    assert.deepEqual(compat.actionable_excess, ['compat-20260101T000000Z-000001']);
  });

  it('withholds ALL actionable removals when scan_complete is false (fail-closed)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002');
    // Force scan_complete false via a malformed latest.json.
    fs.writeFileSync(path.join(familyDir(repo, 'doctor'), 'latest.json'), '{broken');
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 0, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    assert.equal(plan.scan_complete, false);
    assert.equal(plan.families.compat.actionable_excess.length, 0);
    assert.ok(plan.families.compat.actionable_withheld_scan_incomplete.length >= 1);
    assert.equal(plan.families.compat.deletable_bytes, 0);
  });

  it('only counts validated run-id directories; ignores temp/lock/malformed names', async () => {
    const repo = tmpRepo();
    const dir = familyDir(repo, 'compat');
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    fs.mkdirSync(path.join(dir, 'compat-tmp'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stray.json'), '{}');
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 20, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    assert.equal(plan.families.compat.run_count, 1);
  });
});

describe('retention-planner plan hash', () => {
  async function planWith(repo, caps = { runCap: 1, maxBytes: 50 * 1024 * 1024 }) {
    return planRetention({ repoRoot: repo, now: NOW, caps, gitTrackedFiles: [] });
  }

  it('is stable across runs with identical inputs and excludes volatile fields', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    const a = await planWith(repo);
    const b = await planRetention({ repoRoot: repo, now: new Date(NOW.getTime() + 999_999), caps: { runCap: 1, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    assert.equal(a.plan_hash, b.plan_hash, 'a different generated_at must not change the hash');
  });

  it('changes when a cap changes', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002');
    const a = await planWith(repo, { runCap: 1, maxBytes: 50 * 1024 * 1024 });
    const b = await planWith(repo, { runCap: 2, maxBytes: 50 * 1024 * 1024 });
    assert.notEqual(a.plan_hash, b.plan_hash);
  });

  it('changes when the pin set changes (a new citation pins a run)', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002');
    const before = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 1, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    fs.writeFileSync(path.join(repo, 'doc.md'), 'compat-20260101T000000Z-000001');
    const after = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 1, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: ['doc.md'] });
    assert.notEqual(before.plan_hash, after.plan_hash);
  });
});

describe('retention-planner projection', () => {
  it('projects the actionable/pinned split for doctor/dashboard adoption', async () => {
    const repo = tmpRepo();
    seedRun(repo, 'compat', 'compat-20260101T000000Z-000001');
    seedRun(repo, 'compat', 'compat-20260102T000000Z-000002');
    writeLatest(repo, 'compat', 'compat-20260102T000000Z-000002');
    const plan = await planRetention({ repoRoot: repo, now: NOW, caps: { runCap: 1, maxBytes: 50 * 1024 * 1024 }, gitTrackedFiles: [] });
    const proj = projectRetentionAttention(plan);
    assert.equal(proj.scan_complete, true);
    assert.equal(proj.plan_hash, plan.plan_hash);
    assert.equal(proj.families.compat.over_cap, true);
    assert.equal(proj.families.compat.actionable, 1);
    assert.equal(proj.families.compat.pinned_overage, 1);
  });
});

describe('retention-planner reconciliation (doctor/dashboard adoption)', () => {
  // A projection stub shaped like projectRetentionAttention output.
  function proj({ scanComplete = true, families = {} } = {}) {
    return { scan_complete: scanComplete, plan_hash: 'sha256:x', families };
  }
  const overCapItem = (family) => ({ family, kind: 'run_count_exceeds_cap', observed: 30, limit: 20, recommendation: 'x' });

  it('demotes a registry family over cap ONLY because of pins to informational', () => {
    const projection = proj({ families: { compat: { over_cap: true, actionable: 0, pinned_overage: 10 } } });
    const { attention, demoted } = reconcileRetentionAttention([overCapItem('compat')], projection);
    assert.equal(attention.length, 0, 'pinned-only overage is not a fault');
    assert.equal(demoted.length, 1);
    assert.equal(demoted[0].kind, 'pinned_overage');
    assert.equal(demoted[0].pinned_overage, 10);
  });

  it('keeps a registry family with genuine actionable overage as a fault', () => {
    const projection = proj({ families: { compat: { over_cap: true, actionable: 3, pinned_overage: 2 } } });
    const { attention, demoted } = reconcileRetentionAttention([overCapItem('compat')], projection);
    assert.equal(attention.length, 1, 'actionable overage stays a fault');
    assert.equal(demoted.length, 0);
  });

  it('never demotes a non-registry family (e.g. consensus)', () => {
    const projection = proj({ families: {} }); // consensus is not in the registry projection
    const { attention, demoted } = reconcileRetentionAttention([overCapItem('consensus')], projection);
    assert.equal(attention.length, 1);
    assert.equal(demoted.length, 0);
  });

  it('does not demote when the pin scan is incomplete (fail-closed) and adds a scan-incomplete fault', () => {
    const projection = proj({ scanComplete: false, families: { compat: { over_cap: true, actionable: 0, pinned_overage: 10 } } });
    const { attention, demoted } = reconcileRetentionAttention([overCapItem('compat')], projection);
    assert.equal(demoted.length, 0, 'an incomplete scan cannot prove pinned-only');
    assert.ok(attention.some((a) => a.kind === 'pin_scan_incomplete'));
    assert.ok(attention.some((a) => a.family === 'compat'), 'the raw over-cap stays a fault too');
  });

  it('tolerates a null/garbage attention array without throwing', () => {
    assert.doesNotThrow(() => reconcileRetentionAttention(null, proj()));
    assert.doesNotThrow(() => reconcileRetentionAttention(undefined, undefined));
  });
});

describe('retention-planner guards', () => {
  it('rejects a missing repoRoot', async () => {
    await assert.rejects(() => planRetention({ repoRoot: '' }), /repoRoot/);
  });

  it('a missing runs/ tree yields empty families, scan_complete true', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-empty-'));
    const plan = await planRetention({ repoRoot: repo, now: NOW, gitTrackedFiles: [] });
    assert.equal(plan.scan_complete, true);
    for (const family of RETENTION_FAMILIES) {
      assert.equal(plan.families[family].run_count, 0);
      assert.equal(plan.families[family].over_cap, false);
    }
  });
});
