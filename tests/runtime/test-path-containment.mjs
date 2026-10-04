import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep, dirname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { isUnder, resolveContained, resolveContainedSync, sameDirectory } from '../../plugins/runtime/scripts/lib/path-containment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, '../../plugins/runtime/scripts/lib');

// Does THIS filesystem fold case? The case-variant assertions below only mean
// something where it does; where it does not, the two spellings are genuinely
// two different directories and the predicate must say so. Both readings are
// asserted, so the test carries information on either platform rather than
// skipping into silence.
async function foldsCase(root) {
  const probe = join(root, 'CaseProbe');
  await mkdir(probe);
  try {
    statSync(join(root, 'caseprobe'));
    return true;
  } catch {
    return false;
  }
}

describe('runtime path identity (sameDirectory)', () => {
  it('answers identity by inode, not by spelling — the case-alias the lexical compare misses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'path-identity-case-'));
    const real = join(root, 'RealDir');
    await mkdir(real);
    const variant = join(root, 'realdir');
    const folds = await foldsCase(root);

    // The CONTROL that gives this test its meaning: the lexical predicate the
    // shipped code used disagrees with the filesystem here. Without this the
    // assertion below could pass on a fix that changed nothing.
    strictEqual(resolve(real) === resolve(variant), false, 'the two spellings are lexically distinct');

    const verdict = await sameDirectory(real, variant);
    if (folds) {
      strictEqual(verdict.same, true, 'on a case-folding filesystem the two spellings ARE one directory');
    } else {
      strictEqual(verdict.same, false, 'on a case-sensitive filesystem they are genuinely two directories');
    }
  });

  it('follows a symlink to the same identity, and a trailing separator changes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'path-identity-link-'));
    const real = join(root, 'target');
    await mkdir(real);
    const link = join(root, 'alias');
    await symlink(real, link);

    strictEqual((await sameDirectory(real, link)).same, true, 'a symlink and its target are one directory');
    strictEqual((await sameDirectory(real, real + sep)).same, true, 'a trailing separator is the same directory');
    strictEqual((await sameDirectory(real, real)).same, true, 'a path is itself');
  });

  it('calls two genuinely distinct directories distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'path-identity-distinct-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    strictEqual((await sameDirectory(a, b)).same, false);
  });

  it('treats an absent path as distinct, not as unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'path-identity-absent-'));
    const a = join(root, 'a');
    await mkdir(a);
    const verdict = await sameDirectory(a, join(root, 'never-created'));
    strictEqual(verdict.same, false, 'a directory that does not exist is not the same directory');
    strictEqual(verdict.unknown, undefined, 'absence is a definite answer, not an unknown one');
  });

  it('reports UNKNOWN — never a guess — when the filesystem refuses to answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'path-identity-unknown-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);

    // An injected error, not a chmod fixture: a mode-000 directory is readable
    // as root, so on privileged CI the real fixture silently skips and a mutant
    // that swallowed EACCES would survive. The seam makes the branch reachable
    // on every platform and under every uid.
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      const stat = async (path) => {
        if (path === b) {
          const err = new Error(`injected ${code}`);
          err.code = code;
          throw err;
        }
        return statSync(path);
      };
      const verdict = await sameDirectory(a, b, { stat });
      strictEqual(verdict.same, undefined, `${code}: no verdict is invented`);
      strictEqual(verdict.unknown, true, `${code}: the refusal is reported as unknown`);
      ok(verdict.reason.includes(code), `${code}: the reason names the errno`);
    }

    // Control: the same seam, no injected failure, answers definitely.
    const clean = await sameDirectory(a, b, { stat: async (p) => statSync(p) });
    strictEqual(clean.unknown, undefined, 'without an injected failure the answer is definite');
    strictEqual(clean.same, false);
  });

  it('is the ONE identity predicate — a second private copy is the mirror', async () => {
    // The same guard test-bootstrap.mjs applies to isUnder. Identity was a
    // security predicate for doctor's egress fence (removed by ADR-0064), and a
    // second copy is still the failure mode, so the sweep covers every lib module.
    const PRIVATE_COPY = /function sameDirectory\s*\(/;
    const names = (await readdir(LIB)).filter((name) => name.endsWith('.mjs') && name !== 'path-containment.mjs');
    ok(names.includes('bootstrap-artifacts.mjs') && names.length > 20, `the sweep reached the lib modules (${names.length})`);
    for (const rel of names) {
      const src = await readFile(join(LIB, rel), 'utf8');
      ok(!PRIVATE_COPY.test(src), `${rel} does not define a private sameDirectory`);
    }
    ok(PRIVATE_COPY.test(await readFile(join(LIB, 'path-containment.mjs'), 'utf8')), 'the pattern matches the one real definition');
  });

  it('leaves isUnder pure — the containment predicate still touches no filesystem', async () => {
    // isUnder was written for the notify emit path (removed by ADR-0064) and
    // keeps its property: it stays answerable without syscalls; identity is the
    // part that needs them.
    ok(isUnder('/a/b', '/a'));
    ok(!isUnder('/ab', '/a'));
    const src = await readFile(join(LIB, 'path-containment.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export function isUnder'));
    ok(!/await|statImpl|stat\(/.test(body.slice(0, body.indexOf('\n}') + 2)), 'isUnder performs no filesystem call');
  });
});

describe('sameDirectory — identity precision', () => {
  it('refuses an identity it cannot compare exactly rather than guessing', async () => {
    // dev/ino above 2^53 collapse as JavaScript Numbers, and the direction that
    // harms is two DISTINCT directories comparing EQUAL — doctor then skips a
    // real legacy fence and sends. Reproduced with 2^53 and 2^53+1 before the
    // BigInt switch: `same: true`.
    const big = 2 ** 53;
    const lossy = async (path) => ({
      dev: 1, ino: path === '/a' ? big : big + 1, isDirectory: () => true,
    });
    const result = await sameDirectory('/a', '/b', { stat: lossy });
    strictEqual(result.same, undefined, 'a lossy identity must not produce a boolean answer');
    strictEqual(result.unknown, true);
    strictEqual(result.code, 'unrepresentable-identity');
  });

  it('CONTROL — exact BigInt identities still compare normally', async () => {
    const exact = (dev, ino) => async () => ({ dev, ino, isDirectory: () => true });
    strictEqual((await sameDirectory('/a', '/b', { stat: exact(1n, 7n) })).same, true);
    let n = 0;
    const differing = async () => { n += 1; return { dev: 1n, ino: BigInt(n), isDirectory: () => true }; };
    strictEqual((await sameDirectory('/a', '/b', { stat: differing })).same, false);
  });
});

// ── resolveContained ─────────────────────────────────────────────────────────
//
// These cases lived in test-host-parity-baseline.mjs and test-baseline-consumer-
// contract.mjs, where the packaged baseline was the asset being located. ADR-0060
// deleted that document and its resolver; the predicate survives, and now guards
// the plugin manifests, the plugin set, the packaged schemas, the session-readiness
// floors and the rendered statusline and notification templates. Each case is
// therefore anchored on the predicate itself, with a neutral relative path.
//
// Every refusal below was reproduced against the pre-fix code before it was
// written. The CONTROL cases exist because this predicate invites exactly one
// over-correction — refusing legitimate symlinked installs — and a fix measured
// only where it should refuse cannot tell that apart.

const ASSET = join('docs', 'asset.md');

async function fixturePackage() {
  const root = await mkdtemp(join(tmpdir(), 'contained-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  return root;
}

describe('resolveContained — a packaged asset must resolve inside its package', () => {
  it('refuses an asset that resolves OUTSIDE the package, through a leaf symlink', async () => {
    // A constant relative path cannot escape lexically, which is why there was
    // no check; it escapes through the filesystem instead.
    const outside = await mkdtemp(join(tmpdir(), 'contained-outside-'));
    await writeFile(join(outside, 'evil.md'), 'outside\n');
    const root = await fixturePackage();
    await symlink(join(outside, 'evil.md'), join(root, ASSET));

    const located = await resolveContained(root, ASSET);
    strictEqual(located.status, 'escaped');
    // Compared against the CANONICAL spelling of the outside directory: on
    // macOS `/var/folders/…` realpaths to `/private/var/folders/…`, and
    // asserting on the lexical spelling would fail here for the wrong reason.
    strictEqual(located.canonicalPath, join(await realpath(outside), 'evil.md'), 'the verdict must substantiate the escape');
    ok(located.path !== located.canonicalPath, 'both spellings travel, and their difference IS the evidence');
  });

  it('refuses an escape through a symlinked directory too', async () => {
    // The leaf and the directory are two directions of one defect.
    const outside = await mkdtemp(join(tmpdir(), 'contained-outdir-'));
    await writeFile(join(outside, 'asset.md'), 'outside\n');
    const root = await mkdtemp(join(tmpdir(), 'contained-pkg-'));
    await symlink(outside, join(root, 'docs'));

    strictEqual((await resolveContained(root, ASSET)).status, 'escaped');
  });

  it('CONTROL: a symlinked PACKAGE ROOT still resolves — the over-correction this invites', async () => {
    // Canonicalizing only the leaf would refuse every development checkout and
    // several install layouts. Both sides are canonicalized.
    const real = await fixturePackage();
    await writeFile(join(real, ASSET), 'inside\n');
    const parent = await mkdtemp(join(tmpdir(), 'contained-link-'));
    await symlink(real, join(parent, 'runtime'));

    strictEqual((await resolveContained(join(parent, 'runtime'), ASSET)).status, 'ok');
  });

  it('CONTROL: a symlink that stays INSIDE the package is not an escape', async () => {
    const root = await fixturePackage();
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'b.md'), 'inside\n');
    await symlink(join(root, 'real', 'b.md'), join(root, ASSET));

    strictEqual((await resolveContained(root, ASSET)).status, 'ok');
  });

  it('containment is canonical, so a PREFIX SIBLING is outside', async () => {
    // `/x/runtime-evil`.startsWith(`/x/runtime`) is true — measured. The shared
    // predicate appends the separator, and this pins that it keeps doing so.
    const base = await mkdtemp(join(tmpdir(), 'contained-prefix-'));
    await mkdir(join(base, 'runtime'), { recursive: true });
    await mkdir(join(base, 'runtime-evil', 'docs'), { recursive: true });
    await writeFile(join(base, 'runtime-evil', 'docs', 'x.md'), 'x');
    await symlink(join(base, 'runtime-evil', 'docs', 'x.md'), join(base, 'runtime', 'x.md'));

    strictEqual((await resolveContained(join(base, 'runtime'), 'x.md')).status, 'escaped');
  });

  it('a path that cannot be WALKED is unreadable; a broken link is missing', async () => {
    // A mutation collapsing the walk's unreadable verdict into `missing`
    // survived a suite that only exercised a read failure, so the walk has its
    // own case.
    const looped = await fixturePackage();
    await symlink(join(looped, 'docs', 'loop-b.md'), join(looped, 'docs', 'loop-a.md'));
    await symlink(join(looped, 'docs', 'loop-a.md'), join(looped, 'docs', 'loop-b.md'));
    await symlink(join(looped, 'docs', 'loop-a.md'), join(looped, ASSET));

    const loop = await resolveContained(looped, ASSET);
    strictEqual(loop.status, 'unreadable');
    strictEqual(loop.code, 'ELOOP');

    // A BROKEN symlink is `missing`, not `escaped` and not `unreadable`:
    // nothing was read, so there is no escape to report — only an incomplete
    // package. It points outside the root here precisely to pin that ordering.
    const outside = await mkdtemp(join(tmpdir(), 'contained-gone-'));
    const dangling = await fixturePackage();
    await symlink(join(outside, 'never-created.md'), join(dangling, ASSET));
    const broken = await resolveContained(dangling, ASSET);
    strictEqual(broken.status, 'missing');
    strictEqual(broken.code, 'ENOENT');

    // And a package root that does not exist at all resolves the same way.
    strictEqual((await resolveContained(join(outside, 'no-such-package'), ASSET)).status, 'missing');
  });

  it('CONTROL: containment compares IDENTITY when spellings disagree', async () => {
    // macOS firmlinks give one directory two canonical spellings — `/private/tmp/x`
    // and `/System/Volumes/Data/private/tmp/x` are one inode — so a symlink
    // written with the aliased spelling canonicalized outside a root spelled
    // the plain way, and a legitimate package was refused (cross-host review,
    // reproduced on Darwin with matching dev/ino).
    //
    // Driven through the INJECTED seams rather than a real firmlink: the first
    // version of this case built its fixture under a hard-coded `/private/tmp`
    // and died on Linux CI. The condition is what matters, so it is forced:
    // two canonical spellings that disagree lexically and agree by dev/ino.
    const SPELLING_A = '/alias-a/pkg';
    const SPELLING_B = '/alias-b/pkg';
    const oneInode = { dev: 1n, ino: 42n };
    const realpathFake = async (target) => (String(target).includes('docs') ? `${SPELLING_B}/docs/asset.md` : SPELLING_A);
    const statFake = async (target) => {
      if (target === SPELLING_A || target === SPELLING_B) return oneInode;
      return { dev: 1n, ino: 999n };
    };

    const located = await resolveContained(SPELLING_A, ASSET, { realpath: realpathFake, stat: statFake });
    strictEqual(located.status, 'ok', 'two spellings of one inode are one directory');
    strictEqual(located.canonicalPath, `${SPELLING_B}/docs/asset.md`);

    // CONTROL: the SAME lexical disagreement with a DIFFERENT inode must stay
    // an escape. Without this the identity fallback could return true
    // unconditionally and the case above would still be green.
    const twoInodes = async (target) => (target === SPELLING_A ? oneInode : { dev: 1n, ino: 7n });
    strictEqual((await resolveContained(SPELLING_A, ASSET, { realpath: realpathFake, stat: twoInodes })).status, 'escaped');

    // And a filesystem that will not answer leaves the refusal standing.
    const refuses = async () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); };
    strictEqual(
      (await resolveContained(SPELLING_A, ASSET, { realpath: realpathFake, stat: refuses })).status,
      'escaped',
      'an unanswerable identity question fails closed',
    );

    // The sync twin takes the same seams and must reach the same verdicts.
    const syncRealpath = (target) => (String(target).includes('docs') ? `${SPELLING_B}/docs/asset.md` : SPELLING_A);
    strictEqual(resolveContainedSync(SPELLING_A, ASSET, {
      realpathSync: syncRealpath,
      statSync: (target) => ((target === SPELLING_A || target === SPELLING_B) ? oneInode : { dev: 1n, ino: 999n }),
    }).status, 'ok');
    strictEqual(resolveContainedSync(SPELLING_A, ASSET, {
      realpathSync: syncRealpath,
      statSync: (target) => (target === SPELLING_A ? oneInode : { dev: 1n, ino: 7n }),
    }).status, 'escaped');
  });

  it('a filesystem ROOT is a valid containment boundary', async () => {
    // `'/' + sep` is `'//'`, so nothing was ever inside `/` — every filesystem
    // root, drive root, and UNC share root failed the predicate. The fixture is
    // created rather than borrowed, so the case asserts nothing about the machine.
    const dir = await mkdtemp(join(tmpdir(), 'contained-root-'));
    const file = join(dir, 'inside.md');
    await writeFile(file, 'inside\n');
    const root = parse(file).root;

    strictEqual(isUnder(file, root), true);
    strictEqual((await resolveContained(root, relative(root, file))).status, 'ok');
    // CONTROL: the boundary still refuses when it should. Nothing is outside
    // the filesystem root, so the pair is checked one level down instead.
    strictEqual(isUnder(join(dir, '..', 'contained-root-sibling'), dir), false);
  });

  it('the sync and async predicates are one implementation', async () => {
    // A hand-rolled sync copy compared with a hard-coded `/`, so on Windows
    // every valid manifest canonicalized to a `\`-separated path, failed
    // containment, and every runtime command stamped `0.0.0-dev`. Rather than
    // pin a platform this suite cannot run, pin that the two agree.
    const root = await fixturePackage();
    await writeFile(join(root, ASSET), 'inside\n');
    const outside = await mkdtemp(join(tmpdir(), 'contained-sync-out-'));
    await writeFile(join(outside, 'evil.md'), 'outside\n');
    await mkdir(join(root, 'esc'), { recursive: true });
    await symlink(join(outside, 'evil.md'), join(root, 'esc', 'x.md'));

    for (const rel of [ASSET, join('esc', 'x.md'), 'nope.md']) {
      const asyncResult = await resolveContained(root, rel);
      const syncResult = resolveContainedSync(root, rel);
      strictEqual(syncResult.status, asyncResult.status, `disagreement on ${rel}`);
      strictEqual(syncResult.path, asyncResult.path);
      strictEqual(syncResult.canonicalPath ?? null, asyncResult.canonicalPath ?? null);
    }
  });

  it('packaged assets that are RENDERED or gate a verdict get the same containment', async () => {
    // Cross-host review found packaged authorities with a raw-join shape and
    // reproduced real consequences: an outside marker reaching the statusline
    // shim offered for installation, and an outside `runtime-floors.json`
    // producing `ready` against an attacker-supplied floor of `0.1.0`. What is
    // asserted is the PROPERTY — the read is refused when the asset resolves
    // outside the package — through the shared predicate, so the case does not
    // depend on the private layout of any one renderer.
    const pkg = await mkdtemp(join(tmpdir(), 'contained-assets-'));
    await mkdir(join(pkg, 'receivers'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'contained-assets-out-'));
    await writeFile(join(outside, 'evil.mjs'), '// OUTSIDE MARKER\n');
    await symlink(join(outside, 'evil.mjs'), join(pkg, 'receivers', 'template.mjs'));

    strictEqual(resolveContainedSync(join(pkg, 'receivers'), 'template.mjs').status, 'escaped');
    strictEqual((await resolveContained(pkg, 'receivers/template.mjs')).status, 'escaped');

    // CONTROL: an ordinary packaged file resolves, so the guard is not simply
    // refusing everything.
    await writeFile(join(pkg, 'receivers', 'real.mjs'), '// packaged\n');
    strictEqual(resolveContainedSync(join(pkg, 'receivers'), 'real.mjs').status, 'ok');
  });
});
