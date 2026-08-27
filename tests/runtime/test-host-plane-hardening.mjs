// Regression tests for the reader/consumer hardening that SURVIVES the removal
// of the compatibility-assurance plane (ADR-0056).
//
// ⚠ THIS FILE WAS `test-assurance-plane-hardening.mjs`, AND RENAMING IT IS THE
// POINT. ADR-0056's test manifest listed that file for deletion in full. Four of
// its `describe`s are not about assurance at all — they pin the version-token
// grammar, the future-timestamp clock rule, the peer-run staleness rule, and the
// exactly-one-dated-header rule — and every one of those subjects survives the
// removal. Deleting the file wholesale would have deleted four guards because
// their neighbours went away, which is the failure mode this repository has hit
// before: a fix that removes a property nobody decided to remove.
//
// One file rather than four, because these are one finding class seen from four
// modules: a reader that accepts input it cannot faithfully read, and a consumer
// that reads absence as permission. Each `describe` names the measured failure,
// and each carries the CONTROL that failed first when the fix was prototyped —
// these fixes all tighten a predicate, and a tightening with no control is how a
// guard grows until it refuses correct input.
//
// Every test here was mutation-verified when it was written: reverting the
// production line it names turns it red.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseBaseline,
  readVersionToken,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { FUTURE_SKEW_TOLERANCE_MS, elapsedMsSince } from '../../plugins/runtime/scripts/lib/clock.mjs';
import { inspectWorkflowNamespace } from '../../plugins/runtime/scripts/lib/state-readers.mjs';

// ---------------------------------------------------------------------------
// A malformed observed version aliased to a reviewed release
// ---------------------------------------------------------------------------

describe('readVersionToken reports every DROPPED residue, not only a further component', () => {
  // The old rule flagged `1.2.3.4` and nothing else, and its own note recorded
  // the three shapes it let through as a stated residual to be decided
  // deliberately. ST5 is that decision: `2.1.234-` reached `covered` against a
  // human grant for `2.1.234`, which is the plane's whole failure mode.
  for (const malformed of ['1.2.3.4', '1.2.3-', '1.2.3+', '1.2.3..4']) {
    it(`refuses ${JSON.stringify(malformed)} — the token is not what the text said`, () => {
      const read = readVersionToken(malformed);
      assert.equal(read.token, '1.2.3');
      assert.equal(read.truncated, true, `${malformed} must be flagged as having dropped something`);
    });
  }

  // CONTROLS. These are the exact strings the original note named as the
  // property a wider detector would cost, plus the two real host output shapes.
  // A fix that flags any of them is over-tightened, not fixed.
  for (const [faithful, token] of [
    ['1.2.3', '1.2.3'],
    ['1.2.3-rc.1', '1.2.3-rc.1'],
    ['1.2.3+build.5', '1.2.3+build.5'],
    ['0.147.0-rc.1', '0.147.0-rc.1'],
    ['v1.2.3', '1.2.3'],
    ['  1.2.3  ', '1.2.3'],
    ['2.1.197 (Claude Code)', '2.1.197'],
    ['codex-cli 0.142.4', '0.142.4'],
    ['rust-v0.137.0', '0.137.0'],
    ['2.1.233. See the note below.', '2.1.233'],
    ['1.2', '1.2'],
  ]) {
    it(`CONTROL: ${JSON.stringify(faithful)} is read faithfully`, () => {
      const read = readVersionToken(faithful);
      assert.equal(read.token, token);
      assert.equal(read.truncated, false, `${faithful} must NOT be flagged`);
    });
  }
});

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

describe('exactly one dated header, and quoted ones do not count', () => {
  const real = 'Observed on 2026-08-16 with Claude Code `2.1.233`, Codex CLI `0.147.0`.';
  const stale = 'Observed on 2020-01-01 with Claude Code `1.0.0`, Codex CLI `0.1.0`.';

  it('CONTROL: one header parses', () => {
    assert.deepEqual(parseBaseline(real), { date: '2026-08-16', claude: '2.1.233', codex: '0.147.0' });
  });

  it('a stale header ABOVE the canonical one is refused, not preferred by position', () => {
    // `HEADER_RE` is unanchored and the reader took the FIRST match, so a stale
    // line left above the real one silently won — and both the exactness verdict
    // and the direction evidence then named a pair nobody observed.
    assert.equal(parseBaseline(`${stale}\n\n${real}`), null);
    assert.equal(parseBaseline(`${real}\n\n${stale}`), null);
  });

  it('a header that exists ONLY as a quoted example is not a header', () => {
    assert.equal(parseBaseline(`# doc\n\n\`\`\`\n${real}\n\`\`\`\n`), null);
    assert.equal(parseBaseline(`# doc\n\n<pre>\n${real}\n</pre>\n`), null);
  });

  it('CONTROL: a quoted example beside the real header leaves the real one readable', () => {
    // This document explains its own grammar, so worked examples are expected.
    // Counting them would make the shipped file ambiguous against itself.
    assert.deepEqual(
      parseBaseline(`\`\`\`\n${stale}\n\`\`\`\n\n${real}`),
      { date: '2026-08-16', claude: '2.1.233', codex: '0.147.0' },
    );
  });
});
