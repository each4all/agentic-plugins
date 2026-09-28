// Regression tests for the reader/consumer hardening that SURVIVES the removal
// of the compatibility-assurance plane (ADR-0056) and of host-version tracking
// (ADR-0060).
//
// ⚠ THIS FILE WAS `test-assurance-plane-hardening.mjs`, AND RENAMING IT IS THE
// POINT. ADR-0056's test manifest listed that file for deletion in full. Four of
// its `describe`s were not about assurance at all, and deleting the file
// wholesale would have deleted four guards because their neighbours went away,
// which is the failure mode this repository has hit before: a fix that removes a
// property nobody decided to remove.
//
// ADR-0060 then removed two of those four subjects outright: the version-token
// grammar (`readVersionToken`) and the exactly-one-dated-header rule
// (`parseBaseline`) had no reader left once the host-parity baseline and
// `runtime:compat` were deleted, so their `describe`s went with them. The
// future-timestamp clock rule and the peer-run staleness rule survive, and so
// does the byte-exact artifact read, relocated here from the deleted
// `test-baseline-consumer-contract.mjs`.
//
// One file, because these are one finding class seen from several modules: a
// reader that accepts input it cannot faithfully read, and a consumer that reads
// absence as permission. Each `describe` names the measured failure and carries
// the CONTROL that failed first when the fix was prototyped.
//
// Every test here was mutation-verified when it was written: reverting the
// production line it names turns it red.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FUTURE_SKEW_TOLERANCE_MS, elapsedMsSince } from '../../plugins/runtime/scripts/lib/clock.mjs';
import { inspectWorkflowNamespace, readBytesIfExists } from '../../plugins/runtime/scripts/lib/state-readers.mjs';

describe('a beyond-skew future timestamp establishes no age', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');

  it('a past timestamp yields its elapsed time', () => {
    assert.equal(elapsedMsSince(now, now - 3600_000), 3600_000);
  });

  it('CONTROL: drift WITHIN the bound is age 0, not a refusal', () => {
    assert.equal(elapsedMsSince(now, now + FUTURE_SKEW_TOLERANCE_MS), 0);
    assert.equal(elapsedMsSince(now, now + 1), 0);
  });

  it('BEYOND the bound is null — never 0, which is the freshest value there is', () => {
    assert.equal(elapsedMsSince(now, now + FUTURE_SKEW_TOLERANCE_MS + 1), null);
    assert.equal(elapsedMsSince(now, Date.parse('2099-01-01T00:00:00.000Z')), null);
  });

  it('an unparseable timestamp is null too — both are "no age"', () => {
    assert.equal(elapsedMsSince(now, Number.NaN), null);
    assert.equal(elapsedMsSince(Number.NaN, now), null);
  });
});

describe('a peer run stamped in the future is stale, not eternally fresh', () => {
  // The mirror the `Math.max(0, …)` sweep could not find, because there is no
  // clamp here to grep for — just an unbounded subtraction. A postdated
  // `updated_at` made `now - updatedAt` negative, so a non-terminal peer run
  // could sit forever and never be counted in `stale_non_terminal`.
  async function ledgerFor(updatedAt) {
    const root = await mkdtemp(join(tmpdir(), 'st5-peer-runs-'));
    try {
      const dir = join(root, '.agentic-plugins', 'state', 'engineer', 'peer-runs', 'run-1');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'handle.json'), JSON.stringify({
        run_id: 'run-1',
        plugin: 'engineer',
        status: 'running',
        kind: 'ensemble',
        peer_host: 'claude',
        model: 'm',
        effort: 'high',
        updated_at: updatedAt,
      }));
      return await inspectWorkflowNamespace({
        repoRoot: root,
        plugin: 'engineer',
        legacyNamespace: 'agentic-engineer',
        expectedPlugin: 'engineer',
        now: new Date('2026-08-18T00:00:00.000Z'),
        staleGraceMs: 60 * 60 * 1000,
      });
    } finally {
      // Cleaned up rather than left for the OS: this is the only test in the
      // file that writes outside its own process, and a suite that litters
      // `tmpdir()` is a variable in every timing-sensitive test that runs after it.
      await rm(root, { recursive: true, force: true });
    }
  }

  it('CONTROL: a recent non-terminal run is not stale', async () => {
    const ledger = await ledgerFor('2026-08-17T23:30:00.000Z');
    assert.equal(ledger.peer_runs.non_terminal, 1);
    assert.equal(ledger.peer_runs.stale_non_terminal, 0);
  });

  it('CONTROL: an old non-terminal run is stale', async () => {
    const ledger = await ledgerFor('2026-08-01T00:00:00.000Z');
    assert.equal(ledger.peer_runs.stale_non_terminal, 1);
  });

  it('a FUTURE non-terminal run is stale too — an unreadable age is not a fresh one', async () => {
    const ledger = await ledgerFor('2099-01-01T00:00:00.000Z');
    assert.equal(ledger.peer_runs.non_terminal, 1);
    assert.equal(ledger.peer_runs.stale_non_terminal, 1);
  });
});

describe('read-time artifact hashes identify the FILE, not a re-encoding of it', () => {
  it('two files differing by one invalid byte do not share a digest', async () => {
    // Two hashes documented as binding "the EXACT bytes on disk" read with
    // `'utf8'` and hashed the decoded string, so two artifacts differing only
    // by `0xff` versus `0xfe` certified identical (cross-host review). This
    // pins the reader those hashes now go through — doctor's settings
    // `artifact_hash` among them.
    const dir = await mkdtemp(join(tmpdir(), 'hardening-bytes-'));
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await writeFile(a, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    await writeFile(b, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xfe]), Buffer.from('"}')]));

    const ra = await readBytesIfExists(a);
    const rb = await readBytesIfExists(b);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.notEqual(hash(ra.bytes), hash(rb.bytes), 'different files must not share a digest');
    // The byte count is the FILE's. Stated as the inequality rather than a
    // literal, because the literal is what the re-encoding gets wrong: a lone
    // 0xff decodes to U+FFFD and re-encodes to three bytes.
    assert.notEqual(ra.bytes.byteLength, Buffer.byteLength(ra.text, 'utf8'));
    assert.equal(ra.bytes.byteLength, 9);
    // CONTROL: the decoded-string route is exactly what collapses them, which
    // is why the byte reader had to exist.
    assert.equal(hash(Buffer.from(ra.text, 'utf8')), hash(Buffer.from(rb.text, 'utf8')));
  });
});
