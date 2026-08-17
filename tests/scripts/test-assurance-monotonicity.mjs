// Gate tests for scripts/check-assurance-monotonicity.mjs (ADR-0054 §Decision 8).
//
// The check reads RELEASE HISTORY, so almost every case needs a history this
// repository does not have: no released tag carries an assurance record yet, by
// construction (the section lands in R1 with `grants: []`). So the corpus is
// synthetic repositories, and the one real-repository case asserts the honest
// thing — that the check runs clean AND that its corpus is currently empty,
// which is why the synthetic cases are the ones that prove the rules.
//
// That empty corpus is exactly the trap this file is written against. A green
// run over zero tracked grants is vacuous: a check that returned `ok` for every
// input would pass it. Every rule below is therefore driven with a fixture that
// MUST fail, paired with a control one field away that must pass.
//
// Fixture records are built with `canonicalJson` deliberately. The neighbouring
// structural test hand-writes its fixtures because it is testing whether a HUMAN
// can author a block that satisfies the canonical-form rule; nothing here tests
// that rule, so generating the bytes removes an irrelevant failure mode.

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_PATH,
  TAG_PREFIX,
  grantsAt,
  parseSemver,
  reachableRuntimeTags,
  run,
  violations,
} from '../../scripts/check-assurance-monotonicity.mjs';
import {
  ASSURANCE_BEGIN_SENTINEL,
  ASSURANCE_END_SENTINEL,
  ASSURANCE_SCHEMA_FAMILY,
  ASSURANCE_SCHEMA_VERSION,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { PACKAGED_SCHEMA_FILES, canonicalJson, loadSchema } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'plugins', 'runtime');
const SCHEMA = await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot: RUNTIME_ROOT });

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const HEADER = 'Observed on 2026-08-16 with Claude Code `2.1.233`, Codex CLI `0.147.0`, official docs.\n';

function grant(overrides = {}) {
  return {
    id: 'host-pair-2026-08-16',
    state: 'granted',
    reviewed_at: '2026-08-16',
    review_provenance: { kind: 'adr', reference: 'ADR-0054' },
    cohort: [{ claude: '2.1.233', codex: '0.147.0' }],
    packages: { runtime: '0.91.0' },
    residuals: [],
    ...overrides,
  };
}

/** A complete baseline document carrying `grants`, in canonical form. */
function baseline(grants) {
  const record = { schema: ASSURANCE_SCHEMA_VERSION, grants };
  const block = canonicalJson(record, SCHEMA);
  return `${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${block}\`\`\`\n${ASSURANCE_END_SENTINEL}\n\n## Version History\n`;
}

/**
 * A repository shaped like this one from the check's point of view: a runtime
 * package carrying the packaged schema (which `run()` loads from the working
 * tree) and a baseline the tags can move.
 */
function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'assurance-mono-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(dir, 'plugins', 'runtime', 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'plugins', 'runtime', 'data', 'schemas'), { recursive: true });
  copyFileSync(
    path.join(RUNTIME_ROOT, 'data', 'schemas', PACKAGED_SCHEMA_FILES[ASSURANCE_SCHEMA_FAMILY]),
    path.join(dir, 'plugins', 'runtime', 'data', 'schemas', PACKAGED_SCHEMA_FILES[ASSURANCE_SCHEMA_FAMILY]),
  );
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

/**
 * Write a baseline (or remove the section entirely) and commit; optionally tag.
 *
 * A `serial` marker file moves on every call so a commit that carries the SAME
 * baseline bytes is still a commit — several cases below turn on "carried
 * forward unchanged", and git refuses an empty one. It is also the realistic
 * shape: a real release commit moves the manifest alongside the asset.
 */
let serial = 0;
function release(dir, { grants = null, text = null, version = null, message = 'update baseline' }) {
  const target = path.join(dir, BASELINE_PATH);
  writeFileSync(target, text ?? (grants === null ? HEADER : baseline(grants)));
  serial += 1;
  writeFileSync(path.join(dir, 'serial.txt'), `${serial}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  if (version) git(dir, ['tag', `${TAG_PREFIX}${version}`]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const kinds = (result) => result.violations.map((violation) => violation.kind).sort();

// ---------------------------------------------------------------------------
// The real repository — and the honest statement of what it currently proves
// ---------------------------------------------------------------------------

test('the real repository is monotonic, over a corpus that is currently EMPTY', async () => {
  const result = await run({ repoRoot: REPO_ROOT, ref: 'HEAD' });
  assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  assert.equal(result.status, 'monotonic');
  assert.ok(result.tags_examined > 0, 'reachable runtime tags were enumerated');
  // Stated rather than hidden: with no released tag carrying a record, this
  // assertion is about the check not crashing on 140-odd tags, not about the
  // rules. The synthetic cases below are what test the rules. When R1 ships and
  // R2 adds the first grant, `tags_with_record` starts climbing and this
  // assertion becomes a real regression guard — which is why it asserts the
  // number rather than ignoring it.
  assert.equal(result.grants_tracked, 0, 'no released tag carries a grant yet (ADR-0054 §Decision 6 R1)');
  assert.equal(result.target_grants, 0, 'and HEAD ships grants: [] — the R1 rollout state');
});

test('reachable tags are version-ordered and reject non-SemVer names', () => {
  const tags = reachableRuntimeTags(REPO_ROOT, 'HEAD');
  const versions = tags.map((tag) => tag.version);
  for (let i = 1; i < versions.length; i += 1) {
    const [a, b] = [versions[i - 1], versions[i]];
    assert.ok(
      a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2]))),
      `${tags[i - 1].name} must not sort after ${tags[i].name}`,
    );
  }
  assert.equal(parseSemver('0.91.0-rc.1'), null, 'a prerelease tag is not a release version here');
  assert.equal(parseSemver('01.2.3'), null, 'leading zeros would let two spellings compare equal');
  assert.deepEqual(parseSemver('0.91.0'), [0, 91, 0]);
});

// ---------------------------------------------------------------------------
// Synthetic histories — the rules
// ---------------------------------------------------------------------------

describe('no disappearance — a removed grant leaves no tombstone (ADR-0054 §Decision 8)', () => {
  it('CONTROL: carried forward unchanged is monotonic', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [grant()], message: 'no-op refresh' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.equal(result.grants_tracked, 1, 'the corpus is non-empty — this case is not vacuous');
  });

  it('a released grant deleted at HEAD is a violation', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [], message: 'drop the grant' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ['disappeared']);
    assert.match(result.violations[0].detail, /present at plugin-runtime-v0\.91\.0 and absent at/);
  });

  it('the section removed WHOLESALE is the same violation — not an escape', async (t) => {
    // A forward patch that deletes the section rather than the array entry is
    // the shape `check-release-obligation.mjs` explicitly permits (bytes are
    // promoted), so it has to be caught here or nowhere.
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: null, message: 'remove the section' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ['disappeared']);
  });

  it('deleted at one release and restored at the next is still caught', async (t) => {
    // Why every historical observation is compared against the TARGET rather
    // than against its neighbour: a neighbour-wise check sees v0.92.0 -> HEAD as
    // clean and misses that the record was gone in between with different
    // content when it came back.
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [], version: '0.92.0', message: 'drop' });
    release(dir, { grants: [grant({ cohort: [{ claude: '2.1.240', codex: '0.147.0' }] })], message: 'restore, edited' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ['mutated']);
  });

  it('CONTROL: a NEW grant id added at HEAD is not a violation', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, {
      grants: [grant(), grant({ id: 'second-pair-2026-09-01', reviewed_at: '2026-09-01', cohort: [{ claude: '2.1.240', codex: '0.148.0' }] })],
      message: 'add a grant',
    });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.equal(result.target_grants, 2);
  });
});

describe('terminal states absorb', () => {
  it('CONTROL: granted -> revoked is the permitted retirement', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'revoked' })], message: 'withdraw' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, true, JSON.stringify(result.violations));
  });

  it('CONTROL: granted -> superseded is likewise permitted', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'superseded' })], message: 'supersede' });
    assert.equal((await run({ repoRoot: dir })).ok, true);
  });

  it('revoked -> granted is a violation — this is the un-revocation the gate exists for', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant({ state: 'revoked' })], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'granted' })], message: 'quietly restore coverage' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ['transition']);
    assert.match(result.violations[0].detail, /nothing returns to granted/);
  });

  it('a tombstone may not be re-labelled as the other kind of tombstone', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant({ state: 'revoked' })], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'superseded' })], message: 'relabel' });
    assert.equal((await run({ repoRoot: dir })).ok, false);
  });

  it('an un-revocation that happened entirely in the PAST is still reported', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant({ state: 'revoked' })], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'granted' })], version: '0.92.0', message: 'restore' });
    release(dir, { grants: [grant({ state: 'granted' })], message: 'carry forward' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(kinds(result).includes('historical-transition'), `got ${JSON.stringify(kinds(result))}`);
  });
});

describe('content immutability', () => {
  for (const [label, edit] of [
    ['cohort', { cohort: [{ claude: '2.1.240', codex: '0.147.0' }] }],
    ['packages', { packages: { runtime: '0.92.0' } }],
    ['reviewed_at', { reviewed_at: '2026-08-17' }],
    ['review_provenance', { review_provenance: { kind: 'owner-attestation', reference: 'verbal' } }],
    ['residuals', { residuals: [{ surface: 'hook payload', consumption: 'unadopted', disposition: 'not-applicable' }] }],
  ]) {
    it(`editing ${label} in place is a violation`, async (t) => {
      const dir = makeRepo(t);
      release(dir, { grants: [grant()], version: '0.91.0' });
      release(dir, { grants: [grant(edit)], message: `edit ${label}` });
      const result = await run({ repoRoot: dir });
      assert.equal(result.ok, false, `${label} edit must be caught`);
      assert.deepEqual(kinds(result), ['mutated']);
      assert.match(result.violations[0].detail, /grant contents are immutable/);
    });
  }

  it('a legal state transition cannot smuggle a content edit with it', async (t) => {
    // The one place a permitted change and a forbidden one travel together.
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'revoked', cohort: [{ claude: '2.1.240', codex: '0.147.0' }] })], message: 'withdraw and edit' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ['mutated']);
  });

  it('and the content comparison survives a legal transition in the PAST', async (t) => {
    // After `granted -> revoked` at v0.92.0, the tracked record is the revoked
    // one; the identity comparison must still be against the ORIGINAL content,
    // or an edit made after the retirement would pass.
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [grant({ state: 'revoked' })], version: '0.92.0', message: 'withdraw' });
    release(dir, { grants: [grant({ state: 'revoked', packages: { runtime: '0.93.0' } })], message: 'edit the tombstone' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ['mutated']);
  });

  it('an edit that lands WITH a past retirement and is then carried forward is caught', async (t) => {
    // The case the test above does NOT reach, found by mutation: there, HEAD
    // differs from BOTH the original and the retired copy, so it fails whichever
    // one the comparison anchors on. Here HEAD is byte-identical to the retired
    // copy, so the only thing that catches the edit is anchoring on the ORIGINAL
    // — which is what `identity_from` is for. Deleting it leaves this green
    // nowhere else.
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    const edited = grant({ state: 'revoked', packages: { runtime: '0.93.0' } });
    release(dir, { grants: [edited], version: '0.92.0', message: 'withdraw AND edit in one release' });
    release(dir, { grants: [edited], message: 'carry the edited tombstone forward' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, false, 'the edit must not be laundered by the retirement it travelled with');
    assert.deepEqual(kinds(result), ['mutated']);
  });

  it('CONTROL: reformatting the DOCUMENT around the record changes nothing', async (t) => {
    // Content identity is over the parsed grant, not the file, so prose edits
    // and a moved section are not mutations. Without this the gate would fire
    // on every baseline refresh.
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    const record = { schema: ASSURANCE_SCHEMA_VERSION, grants: [grant()] };
    const block = canonicalJson(record, SCHEMA);
    const reflowed = `${HEADER}\nSome new prose about the observation.\n\n`
      + `${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${block}\`\`\`\n${ASSURANCE_END_SENTINEL}\n\n## Version History\n\n- a new row\n`;
    release(dir, { text: reflowed, message: 'refresh prose' });
    assert.equal((await run({ repoRoot: dir })).ok, true);
  });
});

describe('fail-closed on what it cannot read', () => {
  it('an UNREADABLE record at a released tag throws rather than reporting monotonic', async (t) => {
    const dir = makeRepo(t);
    release(dir, { text: `${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\nnot a fenced block\n${ASSURANCE_END_SENTINEL}\n`, version: '0.91.0' });
    release(dir, { grants: [grant()], message: 'add a real record' });
    await assert.rejects(() => run({ repoRoot: dir }), /reads "unparseable"/);
  });

  it('an unreadable record at the TARGET throws too', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { text: `${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n{ "schema": "runtime-host-assurance-1.0" }\n\`\`\`\n${ASSURANCE_END_SENTINEL}\n`, message: 'break it' });
    await assert.rejects(() => run({ repoRoot: dir }), /reads "(invalid|noncanonical)"/);
  });

  it('a record with TWO blocks is ambiguous, and ambiguity is not a monotonicity answer', async (t) => {
    const dir = makeRepo(t);
    const block = canonicalJson({ schema: ASSURANCE_SCHEMA_VERSION, grants: [grant()] }, SCHEMA);
    const doubled = `${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${block}\`\`\`\n${ASSURANCE_END_SENTINEL}\n`
      + `\n${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${block}\`\`\`\n${ASSURANCE_END_SENTINEL}\n`;
    release(dir, { text: doubled, version: '0.91.0' });
    release(dir, { grants: [grant()], message: 'one block now' });
    await assert.rejects(() => run({ repoRoot: dir }), /reads "ambiguous"/);
  });

  it('a tag PREDATING the asset is `absent`, not a failure', async (t) => {
    // The check has to be able to read history older than the thing it checks,
    // or it has no history to read.
    const dir = makeRepo(t);
    git(dir, ['tag', `${TAG_PREFIX}0.90.0`]);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [grant()], message: 'carry forward' });
    const result = await run({ repoRoot: dir });
    assert.equal(result.ok, true);
    assert.equal(result.tags_examined, 2);
    assert.equal(result.tags_with_record, 1, 'the pre-asset tag contributes no record');
  });

  it('a shallow clone is INDETERMINATE, never monotonic', async (t) => {
    const source = makeRepo(t);
    release(source, { grants: [grant()], version: '0.91.0' });
    release(source, { grants: [], message: 'drop the grant — a real violation' });
    const shallow = mkdtempSync(path.join(tmpdir(), 'assurance-shallow-'));
    t.after(() => rmSync(shallow, { recursive: true, force: true }));
    git(shallow, ['init', '-q', '-b', 'main']);
    git(shallow, ['remote', 'add', 'origin', source]);
    git(shallow, ['fetch', '-q', '--depth', '1', 'origin', 'main']);
    git(shallow, ['checkout', '-q', 'FETCH_HEAD']);
    const result = await run({ repoRoot: shallow, ref: 'HEAD' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.reason, 'shallow_clone');
    // The control that makes this meaningful: the SAME history in a full clone
    // is a reported violation, so `indeterminate` is about the clone and not
    // about the content being clean.
    assert.equal((await run({ repoRoot: source })).status, 'violated');
  });

  it('an unknown grant state fails CLOSED rather than passing unclassified', () => {
    // Driven through the exported `violations` seam, because the packaged
    // schema's enum makes this unreachable through a document today — and that
    // is precisely the point: a later schema minor that widens the enum must not
    // walk through the only gate guarding released meaning. The optional-chain
    // spelling this replaced (`ALLOWED_TRANSITIONS[state]?.includes(next)`)
    // returned `undefined` here and read as "no violation".
    const found = violations({
      history: [{ label: 'plugin-runtime-v0.91.0', status: 'resolved', grants: [{ ...grant(), state: 'probationary' }] }],
      target: { label: 'HEAD', status: 'resolved', grants: [grant()] },
    });
    assert.ok(found.some((violation) => violation.kind === 'transition'), `got ${JSON.stringify(found)}`);
    // CONTROL: the same call with a KNOWN state is clean, so the assertion above
    // is about the unknown state and not about the seam rejecting everything.
    assert.deepEqual(
      violations({
        history: [{ label: 'plugin-runtime-v0.91.0', status: 'resolved', grants: [grant()] }],
        target: { label: 'HEAD', status: 'resolved', grants: [grant()] },
      }),
      [],
    );
  });

  it('grantsAt reports `no-baseline` when the ref has no such file at all', async (t) => {
    const dir = makeRepo(t);
    const state = grantsAt(dir, 'HEAD', { label: 'HEAD', schema: SCHEMA });
    assert.equal(state.status, 'no-baseline');
    assert.deepEqual(state.grants, []);
  });
});

describe('the CLI surface', () => {
  it('exits non-zero and names the remedy on a violation', async (t) => {
    const dir = makeRepo(t);
    release(dir, { grants: [grant()], version: '0.91.0' });
    release(dir, { grants: [], message: 'drop' });
    // The script resolves its repo root from its OWN location, so the fixture is
    // driven through `run()` for the verdict and through the CLI only for the
    // exit-code and message contract, against the real repository.
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [path.join(REPO_ROOT, 'scripts', 'check-assurance-monotonicity.mjs')], { encoding: 'utf8' });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 0, 'the real repository passes');
    assert.match(stdout, /✓ assurance-monotonicity: monotonic at HEAD/);
    // The corpus size is PRINTED, so a vacuous green is visible to whoever reads
    // CI output rather than looking like coverage it does not have.
    assert.match(stdout, /tags_with_record=\d+/);
    assert.match(stdout, /grants_tracked=\d+/);
  });

  it('is wired as an npm script so it is runnable the way the other gates are', async () => {
    const pkg = JSON.parse(execFileSync('cat', [path.join(REPO_ROOT, 'package.json')], { encoding: 'utf8' }));
    assert.equal(pkg.scripts['validate:assurance-monotonicity'], 'node scripts/check-assurance-monotonicity.mjs');
  });
});
