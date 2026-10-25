// scripts/lib/verify.mjs — the repository's check declaration and how a
// requested check resolves to an argv (ADR-0068 Decision 5, items 2, 3 and 8),
// for every persona the pipeline generates the library into.
//
// Covers:
//   - this repository's .agentic-plugins/verify-checks.json parses, with the
//     kinds the ADR lists for it;
//   - the declaration's refusals: an unknown slot type, a timeout over 4
//     hours, a kind named twice, a fixed word outside the alphabet, a slot
//     the argv does not reference;
//   - every kind's argv, by words and by comma joins, and the optional lead;
//   - the argument refusals: a path that is no file of the tree, a link, a
//     link that leaves the tree, outside the alphabet, a leading `-`, a `.` or
//     `..` segment, a missing slot, an extra slot, a value outside `under` or
//     without the suffix, test-suite given arguments;
//   - the checks digest is the documented encoding, order-sensitive.
//
// Run via `node --test tests/persona-pipeline/test-verify-declaration.mjs`.

import { after, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { personaInfo, personasFor, REPO_ROOT } from './_personas.mjs';

const DECLARATION_TEXT = readFileSync(join(REPO_ROOT, '.agentic-plugins/verify-checks.json'), 'utf8');

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tree-'));
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '// fixture\n');
  }
  return dir;
}

const kind = (over = {}) => ({ argv: ['npm', 'test'], slots: [], timeout_s: 60, locks_itself: false, adds_on: [], ...over });
const decl = (kinds) => JSON.stringify({ schema: 'agentic-verify-checks-1.0', kinds });

for (const persona of personasFor('scripts/lib/verify.mjs')) {
  const P = personaInfo(persona);
  const lib = await import(pathToFileURL(P.path('scripts/lib/verify.mjs')).href);
  const { parseDeclaration, resolveCheck, checksDigest } = lib;

  describe(`${persona}: the repository's declaration`, () => {
    it('parses, declaring the kinds ADR-0068 Decision 5 item 3 lists', () => {
      const d = parseDeclaration(DECLARATION_TEXT);
      deepStrictEqual(Object.keys(d.kinds).sort(), ['lint-plugin-shape', 'mutate', 'mutate-static', 'sync-persona-pipeline', 'test', 'test-suite']);
      strictEqual(d.kinds.mutate.locks_itself, true);
      strictEqual(d.kinds.test.locks_itself, false);
      strictEqual(d.digest, createHash('sha256').update(DECLARATION_TEXT).digest('hex'));
      ok(Object.values(d.kinds).every((k) => k.timeout_s <= 14_400));
    });
  });

  describe(`${persona}: declaration refusals`, () => {
    const refused = (text, pattern) => throws(() => parseDeclaration(text), pattern);

    it('an unknown slot type', () => {
      refused(decl({ k: kind({ argv: ['npm', '{x}'], slots: [{ name: 'x', type: 'shell', repeat: 'one' }] }) }), /type "shell" is not one of path, id/);
    });

    it('a timeout over 4 hours, or none', () => {
      refused(decl({ k: kind({ timeout_s: 14_401 }) }), /timeout_s is not a whole number of seconds from 1 to 14400/);
      refused(decl({ k: kind({ timeout_s: 0 }) }), /timeout_s/);
      parseDeclaration(decl({ k: kind({ timeout_s: 14_400 }) }));
    });

    it('a kind named twice', () => {
      const text = `{"schema":"agentic-verify-checks-1.0","kinds":{"k":${JSON.stringify(kind())},"k":${JSON.stringify(kind({ timeout_s: 9 }))}}}`;
      refused(text, /names the key "k" twice/);
    });

    it('a fixed word outside the alphabet, a slot the argv does not reference, another schema', () => {
      refused(decl({ k: kind({ argv: ['npm', 'test;rm'] }) }), /neither a fixed word nor a \{slot\}/);
      refused(decl({ k: kind({ argv: ['npm'], slots: [{ name: 'x', type: 'id', repeat: 'one' }] }) }), /argv references no slot, the slots are x/);
      refused(JSON.stringify({ schema: 'other', kinds: { k: kind() } }), /schema is not agentic-verify-checks-1.0/);
    });
  });

  describe(`${persona}: a requested check resolves to an argv`, () => {
    const d = parseDeclaration(DECLARATION_TEXT);
    const dir = tree(['tests/a.mjs', 'tests/sub/b.mjs', 'kit/c.mjs', 'scripts/mutation-specs/s.mjs', 'scripts/mutation-specs/t.mjs', 'docs/x.md']);
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('every kind, by words and by comma joins', () => {
      deepStrictEqual(resolveCheck(d, { kind: 'test-suite', args: {} }, { tree: dir }), ['npm', 'test']);
      deepStrictEqual(resolveCheck(d, { kind: 'test', args: { files: ['tests/a.mjs', 'tests/sub/b.mjs', 'kit/c.mjs'] } }, { tree: dir }),
        ['npm', 'test', '--', 'tests/a.mjs', 'tests/sub/b.mjs', 'kit/c.mjs']);
      deepStrictEqual(resolveCheck(d, { kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs', ids: ['V1', 'W_2'] } }, { tree: dir }),
        ['npm', 'run', 'mutate', '--', 'scripts/mutation-specs/s.mjs', '--only', 'V1,W_2']);
      deepStrictEqual(resolveCheck(d, { kind: 'mutate-static', args: {} }, { tree: dir }), ['npm', 'run', 'mutate:static']);
      deepStrictEqual(resolveCheck(d, { kind: 'mutate-static', args: { specs: ['scripts/mutation-specs/s.mjs', 'scripts/mutation-specs/t.mjs'] } }, { tree: dir }),
        ['npm', 'run', 'mutate:static', '--', 'scripts/mutation-specs/s.mjs', 'scripts/mutation-specs/t.mjs']);
      deepStrictEqual(resolveCheck(d, { kind: 'sync-persona-pipeline' }, { tree: dir }), ['npm', 'run', 'sync:persona-pipeline']);
      deepStrictEqual(resolveCheck(d, { kind: 'lint-plugin-shape', args: {} }, { tree: dir }), ['npm', 'run', 'lint:plugin-shape']);
    });

    const refused = (check, pattern) => throws(() => resolveCheck(d, check, { tree: dir }), pattern);

    it('a path that names no file of the tested tree', () => {
      refused({ kind: 'test', args: { files: ['tests/missing.mjs'] } }, /names no file in the tested tree/);
      refused({ kind: 'test', args: { files: ['tests/sub'] } }, /does not end in \.mjs/);
    });

    it('a symbolic link, and one whose target leaves the tree', () => {
      const outside = tree(['tests/z.mjs']);
      try {
        symlinkSync(join(dir, 'tests/a.mjs'), join(dir, 'tests/link.mjs'));
        refused({ kind: 'test', args: { files: ['tests/link.mjs'] } }, /is a symbolic link/);
        symlinkSync(join(outside, 'tests'), join(dir, 'tests/out'));
        refused({ kind: 'test', args: { files: ['tests/out/z.mjs'] } }, /resolves outside the tested tree/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('a directory is not a file, under a name the slot takes', () => {
      mkdirSync(join(dir, 'tests/dir.mjs'), { recursive: true });
      refused({ kind: 'test', args: { files: ['tests/dir.mjs'] } }, /is not a regular file/);
    });

    it('a leading - is refused where no other rule would refuse it: a path slot with no under, naming a file of the tree', () => {
      const open = parseDeclaration(decl({ k: kind({ argv: ['node', '{file}'], slots: [{ name: 'file', type: 'path', repeat: 'one' }] }) }));
      const t = tree(['-r.mjs', 'r.mjs']);
      try {
        // Control: the same slot takes the name without the dash.
        deepStrictEqual(resolveCheck(open, { kind: 'k', args: { file: 'r.mjs' } }, { tree: t }), ['node', 'r.mjs']);
        throws(() => resolveCheck(open, { kind: 'k', args: { file: '-r.mjs' } }, { tree: t }), /begins with -/);
      } finally {
        rmSync(t, { recursive: true, force: true });
      }
    });

    it('a value outside the alphabet, or beginning with -', () => {
      refused({ kind: 'test', args: { files: ['tests/a b.mjs'] } }, /outside \[A-Za-z0-9\._\/-\]/);
      refused({ kind: 'test', args: { files: ['tests/$(x).mjs'] } }, /outside/);
      refused({ kind: 'test', args: { files: ['-tests/a.mjs'] } }, /begins with -/);
      refused({ kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs', ids: ['-V1'] } }, /ids value "-V1" is not 1 to 64 characters/);
      refused({ kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs', ids: ['V1,V2'] } }, /ids value "V1,V2"/);
    });

    it('a . or .. segment, or an absolute path', () => {
      refused({ kind: 'test', args: { files: ['tests/../tests/a.mjs'] } }, /has an empty, \. or \.\. segment/);
      refused({ kind: 'test', args: { files: ['tests/./a.mjs'] } }, /segment/);
      refused({ kind: 'test', args: { files: ['/tests/a.mjs'] } }, /is absolute/);
    });

    it('a missing slot, an extra slot, a slot outside under, test-suite given arguments', () => {
      refused({ kind: 'test', args: {} }, /slot files is missing/);
      refused({ kind: 'test', args: { files: [] } }, /takes 1 to 400 values/);
      refused({ kind: 'mutate', args: { spec: 'scripts/mutation-specs/s.mjs' } }, /slot ids is missing/);
      refused({ kind: 'test', args: { files: ['tests/a.mjs'], extra: 'x' } }, /no slot "extra"/);
      refused({ kind: 'test', args: { files: ['docs/x.md'] } }, /is not under tests\/, companions\/tests\/, kit\//);
      refused({ kind: 'test-suite', args: { files: ['tests/a.mjs'] } }, /no slot "files"/);
      refused({ kind: 'nope', args: {} }, /check kind "nope" is not declared/);
      refused({ kind: 'toString', args: {} }, /is not declared/);
    });
  });

  describe(`${persona}: the identity of the same checks`, () => {
    it('is sha256 over JSON of the argv arrays in batch order', () => {
      const list = [['npm', 'test', '--', 'tests/a.mjs'], ['npm', 'run', 'lint:plugin-shape']];
      strictEqual(checksDigest(list), createHash('sha256').update(JSON.stringify(list)).digest('hex'));
      ok(checksDigest(list) !== checksDigest([...list].reverse()), 'the order is part of the identity');
      ok(checksDigest([['a', 'b']]) !== checksDigest([['a b']]), 'word boundaries are part of the identity');
    });
  });
}
