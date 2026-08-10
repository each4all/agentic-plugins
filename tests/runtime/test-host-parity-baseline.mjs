// Host-parity baseline resolver — ADR-0051.
//
// The rules under test are the ones the ADR had to be corrected to reach, so
// each case names the failure it pins rather than the function it calls:
//
//   - the packaged copy is the only source (no repository fallback);
//   - `missing` and `unparseable` are different verdicts, both visible;
//   - one grammar, shared with the CI drift script, requiring the DATE —
//     compat used to accept a dateless version pair while doctor and dashboard
//     did not, so one file parsed for one reader and not another;
//   - provenance identifies CONTENT, because the incident behind the ADR was
//     two installs of runtime `0.89.0` carrying different baselines.

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  BASELINE_RELATIVE_PATH,
  extractBaselineVersions,
  parseBaseline,
  resolveHostParityBaseline,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';

const HEADER = 'Observed on 2026-08-08 with Claude Code `2.1.226`, Codex CLI\n`0.147.0`, official docs.\n';

async function fixturePackage({ baseline, version = '0.89.0' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hpb-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
  if (baseline !== null && baseline !== undefined) {
    await writeFile(join(root, BASELINE_RELATIVE_PATH), baseline);
  }
  return root;
}

describe('host-parity baseline resolver (ADR-0051)', () => {
  it('resolves the packaged copy with content-identifying provenance', async () => {
    const root = await fixturePackage({ baseline: HEADER });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });

    strictEqual(resolved.status, 'resolved');
    strictEqual(resolved.baseline.date, '2026-08-08');
    strictEqual(resolved.baseline.claude, '2.1.226');
    strictEqual(resolved.baseline.codex, '0.147.0');
    strictEqual(resolved.versions.claude.version, '2.1.226');
    strictEqual(resolved.versions.codex.version, '0.147.0');

    strictEqual(resolved.provenance.source, 'package');
    strictEqual(resolved.provenance.runtime_version, '0.89.0');
    strictEqual(resolved.provenance.path, join(root, BASELINE_RELATIVE_PATH));
    strictEqual(resolved.provenance.content_sha256, createHash('sha256').update(HEADER).digest('hex'));
  });

  it('gives two same-version packages different provenance when their bytes differ', async () => {
    // The measured incident: runtime `0.89.0` installed twice, carrying
    // different baselines, because content moved under an unchanged version.
    // A version-labelled provenance would call these identical.
    const older = await fixturePackage({
      baseline: 'Observed on 2026-07-25 with Claude Code `2.1.220`, Codex CLI\n`0.145.0`.\n',
      version: '0.89.0',
    });
    const newer = await fixturePackage({ baseline: HEADER, version: '0.89.0' });

    const a = await resolveHostParityBaseline({ pluginRoot: older });
    const b = await resolveHostParityBaseline({ pluginRoot: newer });

    strictEqual(a.provenance.runtime_version, b.provenance.runtime_version);
    notStrictEqual(a.provenance.content_sha256, b.provenance.content_sha256);
    notStrictEqual(a.baseline.date, b.baseline.date);
  });

  it('reports a missing package file as missing, never as a parse failure', async () => {
    const root = await fixturePackage({ baseline: null });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });

    strictEqual(resolved.status, 'missing');
    strictEqual(resolved.baseline, null);
    strictEqual(resolved.provenance.content_sha256, null);
    strictEqual(resolved.provenance.reason, 'ENOENT');
  });

  it('reports a present-but-malformed baseline as unparseable, with its hash', async () => {
    // Visible failure, not a silent degrade: there is no second source to fall
    // back through, which is exactly what makes strict parsing safe here.
    const root = await fixturePackage({ baseline: 'no canonical header here\n' });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });

    strictEqual(resolved.status, 'unparseable');
    strictEqual(resolved.baseline, null);
    ok(resolved.provenance.content_sha256, 'a malformed file still has bytes worth identifying');
  });

  it('never reads the repository when the package lacks the file', async () => {
    // The rule with teeth. A fixture package with no baseline must not be
    // rescued by this repository's own copy sitting under process.cwd().
    const root = await fixturePackage({ baseline: null });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });
    strictEqual(resolved.status, 'missing');
    ok(
      !resolved.provenance.path.includes(`plugins${'/'}runtime${'/'}docs`)
      || resolved.provenance.path.startsWith(root),
      'the resolved path must stay inside the given package root',
    );
  });

  it('requires the date — a version pair that cannot be aged is not a baseline', async () => {
    strictEqual(parseBaseline('Observed with Claude Code `2.1.141`, Codex CLI `0.130.0`.'), null);
    const loose = extractBaselineVersions('Observed with Claude Code `2.1.141`, Codex CLI `0.130.0`.');
    strictEqual(loose.claude.version, null);
    strictEqual(loose.codex.version, null);
  });

  it('rejects a header whose version slots hold no version, and keeps labelled ones', async () => {
    // Cross-host review: matching only the date and the backtick structure let
    // `Claude Code \`banana\`, Codex CLI \`potato\`` resolve, and a malformed
    // baseline could then reach a `current` verdict.
    strictEqual(parseBaseline('Observed on 2026-08-08 with Claude Code `banana`, Codex CLI `potato`.'), null);
    // But "contains a version", not "equals one": real baselines record the
    // observed CLI text. An anchored form rejected existing valid documents.
    const labelled = parseBaseline('Observed on 2026-07-01 with Claude Code `2.1.197 (Claude Code)`, Codex CLI `codex-cli 0.142.4`.');
    ok(labelled, 'a version wearing its host label is still a version');
    strictEqual(labelled.date, '2026-07-01');
    // And the date must be a real calendar date — runtime used to accept
    // 2026-13-45 while the CI drift check rejected it, so "one grammar" was
    // not yet true across the two readers.
    strictEqual(parseBaseline('Observed on 2026-13-45 with Claude Code `2.1.226`, Codex CLI `0.147.0`.'), null);
  });

  it('does not fork the grammar the CI drift script uses — BEHAVIOURALLY', async () => {
    // The first version of this case only checked that an import string was
    // present and accepted either import success or any error. Cross-host
    // review showed it passed while CI routed through a private loose parser
    // behind an unused import: a text assertion cannot see a fork.
    //
    // So compare the two implementations on inputs instead. The CI script
    // keeps its own `normalizeVersion`; every input where the two disagree is
    // a place a baseline means different things to the repository gate and to
    // the runtime, and each such input is named here or the test fails.
    const ci = await import('../../scripts/check-host-version-drift.mjs');
    const lib = await import('../../plugins/runtime/scripts/lib/host-parity-baseline.mjs');

    // Known and deliberately unresolved: CI strips a prerelease suffix while
    // the resolver preserves it. Tracked as the ADR-0051 review's F10 (compat
    // reports a false drift on an identical prerelease); out of scope for the
    // source decision, pinned here so it stays a KNOWN exception rather than
    // drifting into an unnoticed second grammar.
    const KNOWN_DIVERGENCE = new Set(['2.1.226-rc.1']);

    const inputs = ['2.1.226', 'v2.1.226', '2.1.226-rc.1', '0.147.0', 'banana', '', '2.1', '2.1.226 (Claude Code)'];
    const unexpected = [];
    for (const input of inputs) {
      const a = String(ci.normalizeVersion(input));
      const b = String(lib.normalizeVersion(input));
      if (a === b) continue;
      if (KNOWN_DIVERGENCE.has(input)) continue;
      unexpected.push(`${JSON.stringify(input)}: ci=${a} lib=${b}`);
    }
    strictEqual(unexpected.join(' | '), '', 'the two normalizers must not gain a NEW disagreement');

    // Non-vacuity: the comparison must actually be exercising both functions.
    strictEqual(ci.normalizeVersion('v2.1.226'), lib.normalizeVersion('v2.1.226'));
    strictEqual(lib.normalizeVersion('banana'), null, 'the resolver must not treat arbitrary text as a version');
    // And the known exception must still BE an exception — if CI stops
    // stripping prereleases, this list is stale and should shrink.
    notStrictEqual(ci.normalizeVersion('2.1.226-rc.1'), lib.normalizeVersion('2.1.226-rc.1'));
  });
});
