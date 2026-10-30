// tests/orchestrator/test-autopilot-verify-decl.mjs
//
// ADR-0068 Decision 5, items 3 and 7 — the driver's copy of the check
// declaration (plugins/orchestrator/adapters/claude/autopilot/verify-decl.mjs)
// against the persona's (persona-pipeline/files/scripts/lib/verify.mjs).
//
// Covers:
//   - parity: one corpus of declarations, checks and batches through both
//     copies gives the same accept or refusal, the same argv, the same
//     checks digest and the same worst-case results size;
//   - the declaration is read from a commit, never from the working tree: an
//     edit of the file in the checkout changes nothing the driver reads, a
//     commit with no declaration is absent, and one that does not parse is a
//     problem, not an offer.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GIT_ISOLATION } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const D = await import(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/verify-decl.mjs'));
const P = await import(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib/verify.mjs'));

const KIND = (over = {}) => ({ argv: ['npm', 'test', '--', '{files}'], slots: [{ name: 'files', type: 'path', repeat: 'many', join: 'words', under: ['tests/'], suffix: '.mjs' }], timeout_s: 60, locks_itself: false, adds_on: [], ...over });
const decl = (kinds, extra = {}) => JSON.stringify({ schema: 'agentic-verify-checks-1.0', kinds, ...extra });

const DECLARATIONS = [
  decl({ test: KIND() }),
  decl({ test: KIND(), mutate: { argv: ['npm', 'run', 'mutate', '--', '{spec}', '--only', '{ids}'], slots: [{ name: 'spec', type: 'path', repeat: 'one', under: ['scripts/'], suffix: '.mjs' }, { name: 'ids', type: 'id', repeat: 'many', join: 'comma' }], timeout_s: 14400, locks_itself: true, adds_on: [] } }),
  decl({ st: { argv: ['npm', 'run', 'mutate:static', '{specs}'], slots: [{ name: 'specs', type: 'path', repeat: 'optional-many', join: 'words', lead: ['--'] }], timeout_s: 10, locks_itself: false, adds_on: ['scripts/*.mjs'] } }),
  decl({ test: KIND({ timeout_s: 14401 }) }),
  decl({ test: KIND({ timeout_s: 0 }) }),
  decl({ test: KIND({ argv: ['npm', 'test', '{files}', '{files}'] }) }),
  decl({ test: KIND({ argv: ['npm', 'te st'] , slots: [] }) }),
  decl({ Test: KIND() }),
  decl({ test: KIND({ extra: 1 }) }),
  decl({ test: KIND({ locks_itself: 'no' }) }),
  decl({ test: KIND({ adds_on: ['../x'] }) }),
  decl({}),
  '{"schema":"agentic-verify-checks-1.0","kinds":{"a":{"argv":["x"],"slots":[],"timeout_s":1,"locks_itself":false,"adds_on":[]},"a":{"argv":["y"],"slots":[],"timeout_s":1,"locks_itself":false,"adds_on":[]}}}',
  '{"schema":"other","kinds":{}}',
  'not json',
  '[]',
];

const CHECKS = [
  { kind: 'test', args: { files: ['tests/a.mjs'] } },
  { kind: 'test', args: { files: ['tests/a.mjs', 'tests/b.mjs'] } },
  { kind: 'test', args: { files: ['-tests/a.mjs'] } },
  { kind: 'test', args: { files: ['tests/../a.mjs'] } },
  { kind: 'test', args: { files: ['other/a.mjs'] } },
  { kind: 'test', args: { files: ['tests/a.js'] } },
  { kind: 'test', args: { files: ['tests/a.mjs', 'tests/a.mjs'] } },
  { kind: 'test', args: { files: [] } },
  { kind: 'test', args: {} },
  { kind: 'test', args: { nope: ['tests/a.mjs'] } },
  { kind: 'mutate', args: { spec: 'scripts/s.mjs', ids: ['a', 'b-1'] } },
  { kind: 'mutate', args: { spec: 'scripts/s.mjs', ids: ['$x'] } },
  { kind: 'st', args: {} },
  { kind: 'st', args: { specs: ['scripts/s.mjs'] } },
  { kind: 'absent', args: {} },
  { kind: 'test', args: { files: ['tests/' + 'x'.repeat(600) + '.mjs'] } },
  'not a check',
];

const answer = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    return { error: e.message };
  }
};

describe('verify-decl: the driver\'s copy of the declaration', () => {
  it('parses, refuses and digests every declaration of the corpus as the persona does', () => {
    for (const text of DECLARATIONS) {
      const a = answer(() => D.parseDeclaration(text));
      const b = answer(() => P.parseDeclaration(text));
      deepStrictEqual(a.error ?? null, b.error ?? null, text);
      if (a.ok) {
        strictEqual(a.ok.digest, b.ok.digest);
        deepStrictEqual(JSON.parse(JSON.stringify(a.ok.kinds)), JSON.parse(JSON.stringify(b.ok.kinds)));
      }
    }
  });

  it('resolves and refuses every check as the persona does, with the same argv and digest', () => {
    let resolved = 0;
    for (const text of DECLARATIONS) {
      const a = answer(() => D.parseDeclaration(text));
      if (!a.ok) continue;
      const b = P.parseDeclaration(text);
      for (const check of CHECKS) {
        const x = answer(() => D.resolveCheck(a.ok, check));
        const y = answer(() => P.resolveCheck(b, check));
        deepStrictEqual(x, y, JSON.stringify(check));
        if (x.ok) {
          resolved += 1;
          strictEqual(D.checksDigest([x.ok]), P.checksDigest([y.ok]));
        }
      }
    }
    ok(resolved >= 4, `the corpus resolves checks (${resolved})`);
  });

  it('holds a path argument to the tested tree as the persona does', () => {
    const tree = mkdtempSync(join(tmpdir(), 'verify-decl-tree-'));
    try {
      mkdirSync(join(tree, 'tests'));
      writeFileSync(join(tree, 'tests', 'a.mjs'), '');
      const d = D.parseDeclaration(DECLARATIONS[0]);
      const p = P.parseDeclaration(DECLARATIONS[0]);
      for (const check of [CHECKS[0], CHECKS[1]]) {
        deepStrictEqual(answer(() => D.resolveCheck(d, check, { tree })), answer(() => P.resolveCheck(p, check, { tree })));
      }
      ok(answer(() => D.resolveCheck(d, CHECKS[1], { tree })).error.includes('names no file'));
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('bounds a batch\'s worst-case results as the persona does', () => {
    const argv = ['npm', 'test', '--', 'tests/a.mjs'];
    for (const n of [1, 2, 17, 128]) {
      const start = {
        batch_id: 'b1', run_id: 'autopilot-20261001T000000Z-abcdef', continues: null, tree_start: 'a'.repeat(64),
        declaration_commit: 'c'.repeat(40), declaration_digest: 'd'.repeat(64),
        checks: Array.from({ length: n }, (_, i) => ({ index: i, kind: 'test', origin: i === 0 ? 'worker' : 'driver', argv })),
        checks_digest: 'e'.repeat(64), started_at: '2026-10-01T00:00:00Z',
      };
      const kept = { v: 1, request_id: '0123456789abcdef', batches: [] };
      strictEqual(D.worstCaseBytes(kept, start), P.worstCaseBytes(kept, start), `n=${n}`);
    }
    strictEqual(D.MAX_RESULTS_BYTES, P.MAX_RESULTS_BYTES);
    strictEqual(D.VERIFY_RECORD_CAPABILITY, P.VERIFY_RECORD_CAPABILITY);
    strictEqual(D.VERIFY_DECLARATION_PATH, P.VERIFY_DECLARATION_PATH);
  });
});

describe('verify-decl: the declaration at a commit', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...GIT_ISOLATION } }).trim();

  it('reads the committed declaration, never the working tree\'s, and tells absence from a broken file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verify-decl-repo-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README'), 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'none');
      const none = git(repo, 'rev-parse', 'HEAD');
      deepStrictEqual(D.readDeclarationAt(repo, none), { absent: true });
      mkdirSync(join(repo, '.agentic-plugins'));
      writeFileSync(join(repo, D.VERIFY_DECLARATION_PATH), DECLARATIONS[0]);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'decl');
      const base = git(repo, 'rev-parse', 'HEAD');
      // A worker's edit in its tree widens nothing the driver reads.
      writeFileSync(join(repo, D.VERIFY_DECLARATION_PATH), decl({ test: KIND(), evil: KIND({ argv: ['sh', '-c', 'x'], slots: [] }) }));
      const r = D.readDeclarationAt(repo, base);
      ok(r.declaration, JSON.stringify(r));
      deepStrictEqual(Object.keys(r.declaration.kinds), ['test']);
      strictEqual(r.declaration.digest, D.sha256(DECLARATIONS[0]));
      writeFileSync(join(repo, D.VERIFY_DECLARATION_PATH), 'not json');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'broken');
      const broken = D.readDeclarationAt(repo, git(repo, 'rev-parse', 'HEAD'));
      ok(broken.problem?.includes('does not parse'), JSON.stringify(broken));
      ok(D.readDeclarationAt(repo, 'f'.repeat(40)).problem);
      ok(D.readDeclarationAt(repo, 'HEAD').problem);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
