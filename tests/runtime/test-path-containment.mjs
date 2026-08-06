import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { isUnder, sameDirectory } from '../../plugins/runtime/scripts/lib/path-containment.mjs';

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
    // The same guard test-bootstrap.mjs applies to isUnder. Identity is a
    // security predicate now (it decides whether the LIVE egress fence is
    // reported as deletable legacy state), so a second copy is the failure mode.
    const PRIVATE_COPY = /function sameDirectory\s*\(/;
    for (const rel of ['egress-config.mjs', 'bootstrap-artifacts.mjs']) {
      const src = await readFile(join(LIB, rel), 'utf8');
      ok(!PRIVATE_COPY.test(src), `${rel} does not define a private sameDirectory`);
    }
  });

  it('leaves isUnder pure — the containment predicate still touches no filesystem', async () => {
    // isUnder is loaded on the notify emit path through egress-config. It must
    // stay answerable without syscalls; identity is the part that needs them.
    ok(isUnder('/a/b', '/a'));
    ok(!isUnder('/ab', '/a'));
    const src = await readFile(join(LIB, 'path-containment.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export function isUnder'));
    ok(!/await|statImpl|stat\(/.test(body.slice(0, body.indexOf('\n}') + 2)), 'isUnder performs no filesystem call');
  });
});
