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
import { ok, strictEqual, notStrictEqual, rejects } from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  BASELINE_RELATIVE_PATH,
  BASELINE_STATUSES,
  baselineFailure,
  extractBaselineVersions,
  normalizeVersion,
  parseBaseline,
  releaseVersion,
  resolveHostParityBaseline,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { isUnder, resolveContained, resolveContainedSync } from '../../plugins/runtime/scripts/lib/path-containment.mjs';
import { readPluginManifestVersions, readPluginManifestVersionsSync } from '../../plugins/runtime/scripts/lib/plugin-manifest.mjs';
import { isSemVer } from '../../plugins/runtime/scripts/lib/semver.mjs';

const HEADER = 'Observed on 2026-08-08 with Claude Code `2.1.226`, Codex CLI\n`0.147.0`, official docs.\n';

async function fixturePackage({ baseline, version = '0.89.0', codexVersion, claudeRaw } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hpb-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  if (claudeRaw !== undefined) {
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), claudeRaw);
  } else if (version !== null) {
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
  }
  if (codexVersion !== undefined) {
    await mkdir(join(root, '.codex-plugin'), { recursive: true });
    await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: codexVersion }));
  }
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

    // The KNOWN_DIVERGENCE list this case used to carry is gone, and deleting
    // it was NOT the fix — the divergence was real, and four implementations
    // wide, not two: this module, the CI script, `compat.extractSemver`, and
    // `doctor.normalizeHostVersion`. Measured across ten inputs, four produced
    // at least two different answers, and `doctor`'s answered `banana` with
    // `banana`.
    //
    // What closes it is naming the TWO legitimate forms and putting both in
    // one module: `normalizeVersion` preserves a prerelease (identity of the
    // observed version) and `releaseVersion` drops it (comparison). CI's
    // stripping POLICY is unchanged; what is gone is CI's own copy of it.
    strictEqual(ci.normalizeVersion, lib.releaseVersion, 'CI must USE the shared comparison form, not re-implement it');

    const inputs = ['2.1.226', 'v2.1.226', '2.1.226-rc.1', '0.147.0', 'banana', '', '2.1', '2.1.226 (Claude Code)', '2.1.226+build.5'];
    const unexpected = [];
    for (const input of inputs) {
      const a = String(ci.normalizeVersion(input));
      const b = String(lib.releaseVersion(input));
      if (a !== b) unexpected.push(`${JSON.stringify(input)}: ci=${a} lib=${b}`);
    }
    strictEqual(unexpected.join(' | '), '', 'the CI normalizer IS the shared comparison form');

    // Non-vacuity: the comparison must actually be exercising the functions,
    // and the two forms must still be genuinely different from each other —
    // otherwise this test would pass with one form deleted.
    strictEqual(ci.normalizeVersion('v2.1.226'), '2.1.226');
    strictEqual(lib.normalizeVersion('banana'), null, 'the resolver must not treat arbitrary text as a version');
    strictEqual(lib.normalizeVersion('2.1.226-rc.1'), '2.1.226-rc.1', 'the identity form keeps the prerelease');
    strictEqual(lib.releaseVersion('2.1.226-rc.1'), '2.1.226', 'the comparison form drops it');
    strictEqual(lib.releaseVersion('2.1.226+build.5'), '2.1.226', 'and drops build metadata');
  });

  // ── ADR-0051 P2 hardening ────────────────────────────────────────────────
  //
  // Each case below was reproduced against the pre-fix resolver before it was
  // written. The two CONTROL cases exist because this fix invites exactly one
  // over-correction — refusing legitimate symlinked installs — and a fix that
  // is measured only where it should refuse cannot tell that apart.

  it('refuses a baseline that resolves OUTSIDE the package, through a leaf symlink', async () => {
    // Reproduced pre-fix: `status: resolved`, `source: 'package'`, and an
    // arbitrary outside file deciding host-parity verdicts. A constant
    // relative path cannot escape lexically, which is why there was no check;
    // it escapes through the filesystem instead.
    const outside = await mkdtemp(join(tmpdir(), 'hpb-outside-'));
    await writeFile(join(outside, 'evil.md'), 'Observed on 2000-01-01 with Claude Code `9.9.9`, Codex CLI `9.9.9`.\n');
    const root = await fixturePackage({ baseline: null });
    await symlink(join(outside, 'evil.md'), join(root, BASELINE_RELATIVE_PATH));

    const resolved = await resolveHostParityBaseline({ pluginRoot: root });
    strictEqual(resolved.status, 'escaped');
    strictEqual(resolved.baseline, null, 'an escaped file must not supply a baseline value');
    // Compared against the CANONICAL spelling of the outside directory: on
    // macOS `/var/folders/…` realpaths to `/private/var/folders/…`, and
    // asserting on the lexical spelling would fail here for the wrong reason.
    strictEqual(resolved.provenance.canonical_path, join(await realpath(outside), 'evil.md'), 'provenance must substantiate the escape');
    notStrictEqual(resolved.provenance.path, resolved.provenance.canonical_path, 'both spellings travel, and their difference IS the evidence');
  });

  it('refuses an escape through a symlinked docs/ directory too', async () => {
    // The leaf and the directory are two directions of one defect. Fixing one
    // and shipping the other is the shape this repository has been bitten by.
    const outside = await mkdtemp(join(tmpdir(), 'hpb-outdir-'));
    await writeFile(join(outside, 'host-parity-baseline.md'), HEADER);
    const root = await mkdtemp(join(tmpdir(), 'hpb-pkg-'));
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.89.0' }));
    await symlink(outside, join(root, 'docs'));

    const resolved = await resolveHostParityBaseline({ pluginRoot: root });
    strictEqual(resolved.status, 'escaped');
  });

  it('CONTROL: a symlinked PACKAGE ROOT still resolves — the over-correction this invites', async () => {
    // Canonicalizing only the leaf would refuse every development checkout and
    // several install layouts. Both sides are canonicalized, and this is the
    // case that proves it rather than asserting it.
    const real = await fixturePackage({ baseline: HEADER });
    const parent = await mkdtemp(join(tmpdir(), 'hpb-link-'));
    await symlink(real, join(parent, 'runtime'));

    const resolved = await resolveHostParityBaseline({ pluginRoot: join(parent, 'runtime') });
    strictEqual(resolved.status, 'resolved');
    strictEqual(resolved.baseline.claude, '2.1.226');
  });

  it('CONTROL: a symlink that stays INSIDE the package is not an escape', async () => {
    const root = await fixturePackage({ baseline: null });
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'b.md'), HEADER);
    await symlink(join(root, 'real', 'b.md'), join(root, BASELINE_RELATIVE_PATH));

    const resolved = await resolveHostParityBaseline({ pluginRoot: root });
    strictEqual(resolved.status, 'resolved');
  });

  it('containment is canonical, so a PREFIX SIBLING is outside', async () => {
    // `/x/runtime-evil`.startsWith(`/x/runtime`) is true — measured. The shared
    // predicate appends the separator, and this pins that it keeps doing so.
    const base = await mkdtemp(join(tmpdir(), 'hpb-prefix-'));
    await mkdir(join(base, 'runtime'), { recursive: true });
    await mkdir(join(base, 'runtime-evil', 'docs'), { recursive: true });
    await writeFile(join(base, 'runtime-evil', 'docs', 'x.md'), 'x');
    await symlink(join(base, 'runtime-evil', 'docs', 'x.md'), join(base, 'runtime', 'x.md'));

    const located = await resolveContained(join(base, 'runtime'), 'x.md');
    strictEqual(located.status, 'escaped');
  });

  it('separates unreadable from missing — a file that is THERE is not absent', async () => {
    // A present-but-unreadable baseline reported "is not present", sending an
    // operator to reinstall a file already on disk. A directory in the file's
    // place gives EISDIR on every platform and every uid, so this does not
    // depend on the test process not being root (a chmod-000 fixture would).
    const root = await fixturePackage({ baseline: null });
    await mkdir(join(root, BASELINE_RELATIVE_PATH), { recursive: true });

    const resolved = await resolveHostParityBaseline({ pluginRoot: root });
    strictEqual(resolved.status, 'unreadable');
    strictEqual(resolved.provenance.reason, 'EISDIR');
    // CONTROL: genuinely absent is still `missing`, not the new status.
    const absent = await resolveHostParityBaseline({ pluginRoot: await fixturePackage({ baseline: null }) });
    strictEqual(absent.status, 'missing');
    strictEqual(absent.provenance.reason, 'ENOENT');
  });

  it('a path that cannot be WALKED is unreadable; a broken link is missing', async () => {
    // Two branches, and only one of them was reachable through the case above.
    // A mutation collapsing `resolveContained`'s unreadable verdict into
    // `missing` survived the EISDIR case cleanly — that failure is caught in
    // the RESOLVER's read, not in the containment walk — so the walk needs its
    // own case. This is the hole the mutation run found.
    const looped = await fixturePackage({ baseline: null });
    await symlink(join(looped, 'docs', 'loop-b.md'), join(looped, 'docs', 'loop-a.md'));
    await symlink(join(looped, 'docs', 'loop-a.md'), join(looped, 'docs', 'loop-b.md'));
    await symlink(join(looped, 'docs', 'loop-a.md'), join(looped, BASELINE_RELATIVE_PATH));

    const resolved = await resolveHostParityBaseline({ pluginRoot: looped });
    strictEqual(resolved.status, 'unreadable');
    strictEqual(resolved.provenance.reason, 'ELOOP');

    // A BROKEN symlink is `missing`, not `escaped` and not `unreadable`:
    // nothing was read, so there is no escape to report — only an incomplete
    // package. It points outside the root here precisely to pin that ordering.
    const outside = await mkdtemp(join(tmpdir(), 'hpb-gone-'));
    const dangling = await fixturePackage({ baseline: null });
    await symlink(join(outside, 'never-created.md'), join(dangling, BASELINE_RELATIVE_PATH));
    const broken = await resolveHostParityBaseline({ pluginRoot: dangling });
    strictEqual(broken.status, 'missing');
    strictEqual(broken.provenance.reason, 'ENOENT');

    // And a package root that does not exist at all resolves the same way.
    const noRoot = await resolveHostParityBaseline({ pluginRoot: join(outside, 'no-such-package') });
    strictEqual(noRoot.status, 'missing');
  });

  it('hashes the FILE, not a re-encoding of it', async () => {
    // Reproduced: `FF FE` and `FF FF` both decode to U+FFFD, so a string hash
    // gave two different files ONE digest — a collision class in the exact
    // field whose job is telling two same-version installs apart.
    const a = await fixturePackage({ baseline: null });
    const b = await fixturePackage({ baseline: null });
    await writeFile(join(a, BASELINE_RELATIVE_PATH), Buffer.from([0xff, 0xfe]));
    await writeFile(join(b, BASELINE_RELATIVE_PATH), Buffer.from([0xff, 0xff]));

    const ra = await resolveHostParityBaseline({ pluginRoot: a });
    const rb = await resolveHostParityBaseline({ pluginRoot: b });
    strictEqual(ra.status, 'unparseable');
    notStrictEqual(ra.provenance.content_sha256, rb.provenance.content_sha256);
    strictEqual(ra.provenance.content_sha256, createHash('sha256').update(Buffer.from([0xff, 0xfe])).digest('hex'));
  });

  it('CONTROL: the BOM half of the original hash diagnosis was wrong', async () => {
    // Recorded so it is not "fixed" again: UTF-8 decoding does not erase a
    // BOM, and the digests already differed with or without one. The real
    // defect was invalid-byte collisions, and narrowing the claim is part of
    // the fix.
    const withBom = await fixturePackage({ baseline: null });
    await writeFile(join(withBom, BASELINE_RELATIVE_PATH), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(HEADER, 'utf8')]));
    const without = await fixturePackage({ baseline: HEADER });

    const a = await resolveHostParityBaseline({ pluginRoot: withBom });
    const b = await resolveHostParityBaseline({ pluginRoot: without });
    notStrictEqual(a.provenance.content_sha256, b.provenance.content_sha256);
  });

  it('reports a manifest DISAGREEMENT instead of silently picking a side', async () => {
    // Measured: the resolver read `.claude-plugin` first and `version.mjs`
    // read `.codex-plugin` first, so one corrupt install reported two
    // different versions on two surfaces and neither said so.
    const root = await fixturePackage({ baseline: HEADER, version: '1.1.1', codexVersion: '2.2.2' });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });

    strictEqual(resolved.provenance.manifest.status, 'disagreement');
    strictEqual(resolved.provenance.manifest.claude.version, '1.1.1');
    strictEqual(resolved.provenance.manifest.codex.version, '2.2.2');
  });

  it('names a malformed manifest instead of falling through to the other one', async () => {
    const root = await fixturePackage({ baseline: HEADER, claudeRaw: '{ not json', codexVersion: '3.3.3' });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });

    strictEqual(resolved.provenance.runtime_version, '3.3.3', 'the usable half still supplies a version');
    strictEqual(resolved.provenance.manifest.status, 'partial');
    strictEqual(resolved.provenance.manifest.claude.status, 'malformed', 'and the broken half is REPORTED');
  });

  it('rejects a manifest version that is not a version, keeping the raw text as evidence', async () => {
    // `normalizeVersion('banana')` is null one module over; `runtime_version`
    // accepted the same string. A package that disagrees with itself about
    // what a version is cannot report installed state honestly.
    const root = await fixturePackage({ baseline: HEADER, version: 'banana' });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });

    strictEqual(resolved.provenance.runtime_version, null);
    strictEqual(resolved.provenance.manifest.claude.status, 'invalid');
    strictEqual(resolved.provenance.manifest.claude.raw, 'banana');
  });

  it('refuses an explicit empty pluginRoot instead of reading its own package', async () => {
    // The callers used to launder `''` into the packaged default with
    // `pluginRoot ? {…} : {}`, so a caller inspecting a specific install
    // silently inspected the running one and reported on the wrong package.
    await rejects(() => resolveHostParityBaseline({ pluginRoot: '' }), TypeError);
    await rejects(() => resolveHostParityBaseline({ pluginRoot: null }), TypeError);
    // CONTROL: omitting the key is still the documented default.
    const resolved = await resolveHostParityBaseline();
    ok(BASELINE_STATUSES.includes(resolved.status));
  });

  // ── cross-host review of the first hardening pass ────────────────────────

  it('CONTROL: containment compares IDENTITY when spellings disagree', async function () {
    // macOS firmlinks give one directory two canonical spellings. A symlink
    // written with the aliased spelling canonicalized outside a root spelled
    // the plain way, and a legitimate package was refused — reproduced by
    // cross-host review, with matching dev/ino on both spellings.
    //
    // Skipped where the alias does not exist (Linux CI), because a case that
    // silently passes on a platform without firmlinks proves nothing. The
    // generic identity path is covered by the escape control below on every
    // platform.
    const root = await mkdtemp(join('/private/tmp', 'hpb-firmlink-'));
    const aliased = join('/System/Volumes/Data', root);
    let aliasUsable = true;
    try {
      await realpath(aliased);
    } catch {
      aliasUsable = false;
    }
    if (!aliasUsable) return;
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'b.md'), HEADER);
    await symlink(join(aliased, 'real', 'b.md'), join(root, BASELINE_RELATIVE_PATH));

    const located = await resolveContained(root, BASELINE_RELATIVE_PATH);
    strictEqual(located.status, 'ok', 'two spellings of one inode are one directory');
  });

  it('a filesystem ROOT is a valid containment boundary', async () => {
    // `'/' + sep` is `'//'`, so nothing was ever inside `/` — every filesystem
    // root, drive root, and UNC share root failed the predicate.
    strictEqual(isUnder('/etc/hosts', '/'), true);
    const located = await resolveContained('/', 'etc/hosts');
    strictEqual(located.status, 'ok');
  });

  it('the sync and async containment predicates are one implementation', async () => {
    // A hand-rolled sync copy compared with a hard-coded `/`, so on Windows
    // every valid manifest canonicalized to a `\`-separated path, failed
    // containment, and every runtime command stamped `0.0.0-dev`. Rather than
    // pin a platform this suite cannot run, pin that the two agree — a second
    // implementation is what made them disagree.
    const root = await fixturePackage({ baseline: HEADER });
    const outside = await mkdtemp(join(tmpdir(), 'hpb-sync-out-'));
    await writeFile(join(outside, 'evil.md'), HEADER);
    await mkdir(join(root, 'esc'), { recursive: true });
    await symlink(join(outside, 'evil.md'), join(root, 'esc', 'x.md'));

    for (const relative of [BASELINE_RELATIVE_PATH, 'esc/x.md', 'nope.md']) {
      const asyncResult = await resolveContained(root, relative);
      const syncResult = resolveContainedSync(root, relative);
      strictEqual(syncResult.status, asyncResult.status, `disagreement on ${relative}`);
      strictEqual(syncResult.path, asyncResult.path);
      strictEqual(syncResult.canonicalPath ?? null, asyncResult.canonicalPath ?? null);
    }
  });

  it('the SYNC manifest reader goes through the shared predicate', async () => {
    // `version.mjs` is this function's only caller, and nothing exercised it
    // against a fixture package — so a mutation replacing the shared predicate
    // with a hand-rolled `${root}/${relative}` (the exact shape whose
    // hard-coded separator made every Windows manifest `escaped`) survived the
    // suite. The verdict, not the wiring, is what this pins: an escaped
    // manifest must be reported as escaped by BOTH readers.
    const outside = await mkdtemp(join(tmpdir(), 'hpb-sync-manifest-'));
    await writeFile(join(outside, 'plugin.json'), JSON.stringify({ version: '99.99.99' }));
    const root = await fixturePackage({ baseline: HEADER, version: null, codexVersion: '0.90.1' });
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await symlink(join(outside, 'plugin.json'), join(root, '.claude-plugin', 'plugin.json'));

    const sync = readPluginManifestVersionsSync(root);
    strictEqual(sync.manifests.claude.status, 'escaped');
    strictEqual(sync.version, '0.90.1', 'the contained half still supplies a version');
    notStrictEqual(sync.version, '99.99.99');

    // And the two readers must agree — a second implementation is what made
    // them able to disagree in the first place.
    const asyncResult = await readPluginManifestVersions(root);
    strictEqual(sync.status, asyncResult.status);
    strictEqual(sync.version, asyncResult.version);
    strictEqual(sync.manifests.claude.status, asyncResult.manifests.claude.status);
    strictEqual(sync.manifests.codex.status, asyncResult.manifests.codex.status);

    // CONTROL: an ordinary package still reads through cleanly.
    const healthy = readPluginManifestVersionsSync(await fixturePackage({ baseline: HEADER, version: '0.90.1', codexVersion: '0.90.1' }));
    strictEqual(healthy.status, 'ok');
    strictEqual(healthy.version, '0.90.1');
  });

  it('the manifest shape predicate is SemVer, not a loose approximation', async () => {
    // `01.2.3` and `1.2.3-01` are not SemVer, and a private regex accepted
    // both — a manifest saying `01.2.3` was classified `ok` and stamped onto
    // artifacts (cross-host review).
    strictEqual(isSemVer('01.2.3'), false);
    strictEqual(isSemVer('1.2.3-01'), false);
    strictEqual(isSemVer('1.2.3'), true);
    strictEqual(isSemVer('0.90.1-beta.1+build.5'), true);

    const root = await fixturePackage({ baseline: HEADER, version: '01.2.3' });
    const resolved = await resolveHostParityBaseline({ pluginRoot: root });
    strictEqual(resolved.provenance.manifest.claude.status, 'invalid');
    strictEqual(resolved.provenance.manifest.claude.raw, '01.2.3');
  });

  it('the identity form keeps build metadata that follows a prerelease', async () => {
    // One `[-+]` alternative stopped at the first of the two, so
    // `0.147.0-rc.1+build.5` and `…+build.6` were one token — a lossy
    // "identity" form (cross-host review).
    strictEqual(normalizeVersion('0.147.0-rc.1+build.5'), '0.147.0-rc.1+build.5');
    notStrictEqual(normalizeVersion('0.147.0-rc.1+build.5'), normalizeVersion('0.147.0-rc.1+build.6'));
    // And the comparison form still drops both halves, as SemVer precedence requires.
    strictEqual(releaseVersion('0.147.0-rc.1+build.5'), '0.147.0');
    strictEqual(releaseVersion('0.147.0-rc.1+build.5'), releaseVersion('0.147.0-rc.1+build.6'));
  });

  it('fails CLOSED on a status it does not recognise', async () => {
    // This is the whole consumer migration in one assertion. Every reader used
    // to enumerate two statuses and give everything else a benign meaning —
    // `stale` in doctor, `available` in dashboard. A predicate that treats an
    // unknown status as a failure is what makes a SIXTH status safe to add.
    strictEqual(baselineFailure({ status: 'resolved' }), null);
    for (const status of BASELINE_STATUSES.filter((s) => s !== 'resolved')) {
      ok(baselineFailure({ status, provenance: { path: '/p' } })?.operator_action, `${status} must carry an operator action`);
    }
    const unknown = baselineFailure({ status: 'a-status-from-the-future' });
    ok(unknown, 'an unrecognised status is itself an integrity problem');
    strictEqual(unknown.status, 'a-status-from-the-future');
    ok(baselineFailure(null), 'and so is no result at all');
  });
});
