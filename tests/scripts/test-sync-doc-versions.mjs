// Unit tests for scripts/sync-doc-versions.mjs.
//
// Every assertion here is written against a temp repo so the real docs are
// never mutated, and every "the script refuses" case is paired with a
// control that proves the same input DOES sync when the refusal condition
// is removed. A refusal test that passes because the fixture was never
// eligible in the first place is worthless, and this file has one guard
// (`heterogeneous-match-set`) whose failure mode is exactly that.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';

import { syncDocVersionsToManifest, checkHomogeneity, readDoctorProofPointer, RULES } from '../../scripts/sync-doc-versions.mjs';

const ARCH = 'docs/ARCHITECTURE.md';
const DEV = 'docs/DEVELOPMENT.md';
const SCORECARD = 'docs/assurance/omcc-cutover-scorecard.md';

function makeRepo({ manifestVersion = '0.87.0', docVersion = '0.86.2', proofVersion = '0.86.2', proof = true, docs = {} } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sync-doc-versions-'));
  const write = (rel, body) => {
    mkdirSync(dirname(resolve(root, rel)), { recursive: true });
    writeFileSync(resolve(root, rel), body);
  };

  write('.release-please-manifest.json', JSON.stringify({
    companions: '0.1.0',
    'plugins/runtime': manifestVersion,
    'plugins/engineer': '0.21.0',
  }, null, 2));

  write(ARCH, docs[ARCH] ?? [
    '# Architecture',
    '',
    `- **Stage 3+** — as of \`plugin-runtime\` v${docVersion} it ships the surfaces.`,
    '',
  ].join('\n'));

  // The DEVELOPMENT fixture deliberately reproduces two traps from the
  // real file: the blockquote hard-wrap ("As of\n> `plugin-runtime` v"),
  // and BACKTICKED historical release tags, which the real file carries
  // ten of because the de-backticking convention only applies to the
  // scorecard. A repo-wide tag rule would rewrite those.
  write(DEV, docs[DEV] ?? [
    '# Development',
    '',
    '> reframes the immediate Stage 3+ candidate. As of',
    `> \`plugin-runtime\` v${docVersion} (the shipped surfaces —`,
    '> more prose).',
    '',
    `- As of \`plugin-runtime\` v${docVersion}, \`plugins/runtime\` is an L1 primitive.`,
    '',
    `| 2 | round-trip | satisfied | Latest installed proof: \`plugin-runtime\` \`${docVersion}\` carries the proof re-recorded as \`doctor-20260726T014023Z-1b377b\`; earlier tags \`plugin-runtime-v0.83.0\` / \`plugin-runtime-v0.79.0\` / \`plugin-runtime-v0.77.1\` remain as history. |`,
    '',
  ].join('\n'));

  write(SCORECARD, docs[SCORECARD] ?? [
    '# Scorecard',
    '',
    `Zero writes planned against the installed \`plugin-runtime\` \`${docVersion}\` state.`,
    '',
    `Execution evidence is native to \`plugin-runtime\` \`${docVersion}\`: three proofs passed.`,
    '',
    `Release PR #642 squash \`9e2af7d\`, tag \`plugin-runtime-v${docVersion}\`, sync \`668c325\`.`,
    '',
    'The preceding loop cut tag plugin-runtime-v0.85.0 — backticks deliberately omitted for the freshness gate.',
    '',
  ].join('\n'));

  if (proof) {
    write('.agentic-plugins/runs/doctor/latest.json', JSON.stringify({
      schema_version: 'runtime-doctor-latest-1.0',
      runtime_version: proofVersion,
      run_id: 'doctor-20260726T014023Z-1b377b',
    }, null, 2));
  }

  return { root, read: (rel) => readFileSync(resolve(root, rel), 'utf8'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('sync-doc-versions rule table', () => {
  it('scopes release-tag syncing to the scorecard only', () => {
    // The real docs/DEVELOPMENT.md carries ten backticked historical
    // `plugin-runtime-vX` tags; only the scorecard de-backticks
    // superseded tags. A tag rule pointed at DEVELOPMENT.md would rewrite
    // history, so the rule table must never grow one.
    const tagRuleFiles = RULES.filter((r) => r.id.includes('release-tag')).map((r) => r.file);
    deepStrictEqual(tagRuleFiles, ['docs/assurance/omcc-cutover-scorecard.md']);
  });

  it('classifies every rule as exactly one of the two token classes', () => {
    for (const rule of RULES) {
      ok(['shipped-version', 'proof-coupled'].includes(rule.tokenClass), `${rule.id} has a known token class`);
    }
    ok(RULES.some((r) => r.tokenClass === 'shipped-version'), 'at least one shipped-version rule');
    ok(RULES.some((r) => r.tokenClass === 'proof-coupled'), 'at least one proof-coupled rule');
  });
});

describe('checkHomogeneity', () => {
  it('accepts a uniformly lagging match set', () => {
    strictEqual(checkHomogeneity(['0.86.2', '0.86.2'], '0.87.0').ok, true);
  });

  it('accepts a half-applied edit so the script can repair it', () => {
    strictEqual(checkHomogeneity(['0.87.0', '0.86.2'], '0.87.0').ok, true);
  });

  it('rejects a match set spanning several superseded versions', () => {
    const r = checkHomogeneity(['0.87.0', '0.83.0', '0.79.0'], '0.87.0');
    strictEqual(r.ok, false);
    deepStrictEqual(r.distinctOther.sort(), ['0.79.0', '0.83.0']);
  });
});

describe('sync-doc-versions token classes', () => {
  it('syncs shipped-version tokens and refuses proof-coupled ones when the proof is stale', () => {
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proofVersion: '0.86.2' });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      strictEqual(r.targetVersion, '0.87.0');

      deepStrictEqual(r.diffs.map((d) => d.rule).sort(), ['architecture-as-of', 'development-as-of', 'scorecard-release-tag']);
      deepStrictEqual(
        r.refusals.map((x) => `${x.rule}:${x.reason}`).sort(),
        ['development-latest-installed-proof:proof-not-recorded', 'scorecard-installed-proof-version:proof-not-recorded'],
      );

      ok(repo.read(ARCH).includes('`plugin-runtime` v0.87.0'), 'architecture as-of moved');
      ok(repo.read(DEV).includes('> `plugin-runtime` v0.87.0'), 'hard-wrapped blockquote as-of moved');
      ok(repo.read(DEV).includes('As of `plugin-runtime` v0.87.0,'), 'inline as-of moved');
      ok(repo.read(SCORECARD).includes('`plugin-runtime-v0.87.0`'), 'scorecard release tag moved');

      // The refused class must be untouched, not partially written.
      ok(repo.read(DEV).includes('Latest installed proof: `plugin-runtime` `0.86.2`'), 'proof-coupled token held back');
      ok(repo.read(SCORECARD).includes('installed `plugin-runtime` `0.86.2` state'), 'scorecard proof token held back');
    } finally { repo.cleanup(); }
  });

  it('syncs proof-coupled tokens once a proof has been recorded for the manifest version', () => {
    // Control for the refusal above: identical fixture, fresh proof.
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proofVersion: '0.87.0' });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      deepStrictEqual(r.refusals, []);
      ok(repo.read(DEV).includes('Latest installed proof: `plugin-runtime` `0.87.0`'), 'proof-coupled token synced');
      ok(repo.read(SCORECARD).includes('installed `plugin-runtime` `0.87.0` state'), 'scorecard proof token synced');
      ok(repo.read(SCORECARD).includes('native to `plugin-runtime` `0.87.0`'), 'second scorecard proof token synced');
    } finally { repo.cleanup(); }
  });

  it('refuses proof-coupled tokens when no doctor artifact is readable at all', () => {
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proof: false });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      strictEqual(r.proofPointer.present, false);
      ok(r.refusals.every((x) => x.reason === 'proof-not-recorded'), 'absent artifact refuses rather than throwing');
      ok(r.diffs.length > 0, 'shipped-version class still syncs without any local artifacts (the CI case)');
    } finally { repo.cleanup(); }
  });

  it('leaves superseded records in the same documents untouched', () => {
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proofVersion: '0.87.0' });
    try {
      syncDocVersionsToManifest(repo.root, { checkOnly: false });
      const dev = repo.read(DEV);
      for (const historical of ['plugin-runtime-v0.83.0', 'plugin-runtime-v0.79.0', 'plugin-runtime-v0.77.1']) {
        ok(dev.includes(`\`${historical}\``), `${historical} survives the sync`);
      }
      ok(dev.includes('doctor-20260726T014023Z-1b377b'), 'cited run id is never rewritten');
      ok(repo.read(SCORECARD).includes('plugin-runtime-v0.85.0 — backticks deliberately omitted'), 'de-backticked superseded tag survives');
    } finally { repo.cleanup(); }
  });
});

describe('sync-doc-versions safety preconditions', () => {
  it('refuses a rule whose anchor has stopped matching instead of silently succeeding', () => {
    const repo = makeRepo({
      manifestVersion: '0.87.0',
      docs: { [ARCH]: '# Architecture\n\nNo version statement here at all.\n' },
    });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      const refusal = r.refusals.find((x) => x.rule === 'architecture-as-of');
      ok(refusal, 'a dead rule is reported');
      strictEqual(refusal.reason, 'anchor-not-found');
      ok(!r.diffs.some((d) => d.rule === 'architecture-as-of'), 'and contributes no diff');
    } finally { repo.cleanup(); }
  });

  it('refuses a heterogeneous match set rather than rewriting possibly-superseded records', () => {
    // The scorecard fixture is given TWO extra backticked tags at
    // superseded versions, simulating the de-backticking convention
    // having been broken. The rule's match set then spans three
    // versions and must refuse.
    const repo = makeRepo({
      manifestVersion: '0.87.0',
      docs: {
        [SCORECARD]: [
          '# Scorecard',
          '',
          'Zero writes planned against the installed `plugin-runtime` `0.86.2` state.',
          '',
          'Release PR #642 squash `9e2af7d`, tag `plugin-runtime-v0.86.2`, sync `668c325`.',
          'Earlier: tag `plugin-runtime-v0.85.0` and tag `plugin-runtime-v0.84.0`.',
          '',
        ].join('\n'),
      },
    });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      const refusal = r.refusals.find((x) => x.rule === 'scorecard-release-tag');
      ok(refusal, 'heterogeneous tag set is refused');
      strictEqual(refusal.reason, 'heterogeneous-match-set');
      const after = repo.read(SCORECARD);
      ok(after.includes('`plugin-runtime-v0.85.0`') && after.includes('`plugin-runtime-v0.84.0`'), 'superseded tags survive the refusal');
      ok(after.includes('`plugin-runtime-v0.86.2`'), 'and the current tag is not half-written either');
    } finally { repo.cleanup(); }
  });

  it('CONTROL: the same fixture syncs once the heterogeneity is removed', () => {
    // Without this control the refusal test above would still pass if the
    // rule simply never matched the fixture at all.
    const repo = makeRepo({
      manifestVersion: '0.87.0',
      docs: {
        [SCORECARD]: [
          '# Scorecard',
          '',
          'Zero writes planned against the installed `plugin-runtime` `0.86.2` state.',
          '',
          'Release PR #642 squash `9e2af7d`, tag `plugin-runtime-v0.86.2`, sync `668c325`.',
          'Earlier: tag plugin-runtime-v0.85.0 and tag plugin-runtime-v0.84.0 (de-backticked).',
          '',
        ].join('\n'),
      },
    });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      ok(!r.refusals.some((x) => x.rule === 'scorecard-release-tag'), 'no refusal when the convention holds');
      ok(repo.read(SCORECARD).includes('`plugin-runtime-v0.87.0`'), 'the tag rule does fire on this fixture');
    } finally { repo.cleanup(); }
  });
});

describe('sync-doc-versions modes', () => {
  it('checkOnly reports diffs without writing', () => {
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proofVersion: '0.87.0' });
    try {
      const before = repo.read(ARCH);
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: true });
      ok(r.diffs.length > 0, 'drift is reported');
      deepStrictEqual(r.written, [], 'nothing is written');
      strictEqual(repo.read(ARCH), before, 'file is byte-identical');
    } finally { repo.cleanup(); }
  });

  it('is idempotent — a second run reports no diffs', () => {
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proofVersion: '0.87.0' });
    try {
      syncDocVersionsToManifest(repo.root, { checkOnly: false });
      const second = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      deepStrictEqual(second.diffs, []);
      deepStrictEqual(second.refusals, []);
      deepStrictEqual(second.written, []);
    } finally { repo.cleanup(); }
  });

  it('shippedOnly skips the proof-coupled class instead of refusing it', () => {
    // The release-please Action runs from a fresh checkout where the
    // artifact tree (gitignored) cannot exist, so a proof-coupled refusal
    // there is the expected state, not a problem. Without this mode the
    // CLI would exit 1 and turn the release workflow red on every
    // release.
    const repo = makeRepo({ manifestVersion: '0.87.0', docVersion: '0.86.2', proof: false });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false, shippedOnly: true });
      deepStrictEqual(r.refusals, [], 'no refusal is raised for the skipped class');
      deepStrictEqual(r.diffs.map((d) => d.tokenClass), ['shipped-version', 'shipped-version', 'shipped-version']);
      ok(repo.read(ARCH).includes('`plugin-runtime` v0.87.0'), 'shipped-version class still syncs');
      ok(repo.read(DEV).includes('Latest installed proof: `plugin-runtime` `0.86.2`'), 'proof-coupled token is untouched');
    } finally { repo.cleanup(); }
  });

  it('shippedOnly does NOT suppress a genuine anchor failure', () => {
    // Control: the skip must be scoped to the proof-coupled class alone,
    // not degrade into "report nothing".
    const repo = makeRepo({
      manifestVersion: '0.87.0',
      proof: false,
      docs: { [ARCH]: '# Architecture\n\nNo version statement here at all.\n' },
    });
    try {
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false, shippedOnly: true });
      ok(r.refusals.some((x) => x.rule === 'architecture-as-of' && x.reason === 'anchor-not-found'), JSON.stringify(r.refusals));
    } finally { repo.cleanup(); }
  });

  it('reads a malformed doctor pointer as absent rather than throwing', () => {
    const repo = makeRepo({ manifestVersion: '0.87.0' });
    try {
      writeFileSync(resolve(repo.root, '.agentic-plugins/runs/doctor/latest.json'), '{ not json');
      const pointer = readDoctorProofPointer(repo.root);
      strictEqual(pointer.present, false);
      ok(pointer.error, 'the parse failure is reported, not swallowed');
      const r = syncDocVersionsToManifest(repo.root, { checkOnly: false });
      ok(r.diffs.length > 0, 'shipped-version class still syncs');
      ok(r.refusals.some((x) => x.reason === 'proof-not-recorded'), 'proof-coupled class refuses');
    } finally { repo.cleanup(); }
  });
});

describe('sync-doc-versions against the real repository', () => {
  it('reports the checked-in docs as already in sync', async () => {
    const REPO_ROOT = resolve(import.meta.dirname, '../..');
    const r = syncDocVersionsToManifest(REPO_ROOT, { checkOnly: true });
    deepStrictEqual(r.diffs, [], 'no stage-doc version drift on this checkout');
    deepStrictEqual(r.refusals, [], 'no rule refused — every anchor still matches the real documents');
  });
});
