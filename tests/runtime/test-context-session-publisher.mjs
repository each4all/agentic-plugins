// ADR-0044 S3b publisher tests: the `publish-session` transaction (config
// gate → containment → O_EXCL owner-token lock → committed entry.json read →
// bounded git observation → fingerprint no-op or slot-then-entry publish →
// own-staging sweep → token-checked release) and its hook-grade CLI
// discipline (session-capture-contract.md §11 S3b obligations).
//
// Mutation discipline (the S2/S3a rule): every rejection or no-op case is
// paired with a passing control first, so a green run proves the gate bites
// rather than the fixture never reaching it. Fingerprint vectors are
// recomputed INDEPENDENTLY from the contract §5.1 text (compact
// JSON.stringify over the six pinned keys), so a canonicalJson reuse or a
// key-order drift in the implementation fails loudly.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  LOCK_STALE_AGE_MS,
  PUBLISH_REFRESH_TTL_MS,
  SWEEP_MAX_AGE_MS,
  SWEEP_MAX_REMOVALS,
  computeSessionFingerprint,
  noteContext,
  publishSessionCapture,
  readSlotStatus,
} from '../../plugins/runtime/scripts/context.mjs';
import { observeSessionGitFacts, resolveGitTopLevel } from '../../plugins/runtime/scripts/source-snapshot.mjs';
import { loadSchema, validateAgainstSchema } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const run = promisify(execFile);
const CONTEXT_CLI = fileURLToPath(new URL('../../plugins/runtime/scripts/context.mjs', import.meta.url));
const CAPTURE_SEGMENTS = ['.agentic-plugins', 'state', 'runtime', 'session-capture'];
const BEL = String.fromCharCode(7);

async function makeGitRepo({ gate = 'stop-hook' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ctx-pub-')));
  const repoRoot = join(root, 'repo');
  const homeDir = join(root, 'home');
  await mkdir(repoRoot);
  await mkdir(homeDir);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await commitEmpty(repoRoot, 'init');
  if (gate !== null) {
    await mkdir(join(repoRoot, '.agentic-plugins'), { recursive: true });
    await writeFile(join(repoRoot, '.agentic-plugins', 'config.toml'), `session_capture = "${gate}"` + String.fromCharCode(10));
  }
  return { root, repoRoot, homeDir };
}

async function commitEmpty(repoRoot, message) {
  await run('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message], { cwd: repoRoot });
}

function captureDir(repoRoot) {
  return join(repoRoot, ...CAPTURE_SEGMENTS);
}

function publish(overrides) {
  return publishSessionCapture({ host: 'claude', ...overrides });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Contract §5.1 recomputation, assembled from the contract TEXT (six keys,
// this exact order, compact JSON.stringify) — deliberately NOT calling the
// implementation's helper, so this is an independent vector.
function contractFingerprint({ branch, headShort, statusDigest, sessionId, note, workflowEvidence }) {
  const input = JSON.stringify({
    branch: branch ?? null,
    head_short: headShort ?? null,
    status_digest: statusDigest ?? null,
    session_id: sessionId ?? null,
    note: note ? { content_hash: note.content_hash, staged_at: note.staged_at } : null,
    workflow_evidence: workflowEvidence,
  });
  return 'fp1:' + createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex');
}

async function runCli(args, { cwd, homeDir }) {
  const env = { ...process.env };
  if (homeDir) env.HOME = homeDir;
  try {
    const { stdout, stderr } = await run(process.execPath, [CONTEXT_CLI, ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('publish-session config gate (contract §1/§9)', () => {
  it('control: gate on publishes a committed generation', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const report = await publish({ repoRoot, homeDir });
    strictEqual(report.status, 'published');
    strictEqual(report.summary_source, 'structural');
    const status = await readSlotStatus({ repoRoot });
    strictEqual(status.generation, 'committed');
  });

  it('gate-off default: no config at all mutates NOTHING (no directory, no lock, no sweep)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo({ gate: null });
    const report = await publish({ repoRoot, homeDir });
    strictEqual(report.status, 'skipped');
    strictEqual(report.reason, 'gate-off');
    await rejects(() => readdir(join(repoRoot, '.agentic-plugins')), /ENOENT/);
  });

  it('explicit session_capture = "off" also skips', async () => {
    const { repoRoot, homeDir } = await makeGitRepo({ gate: 'off' });
    const report = await publish({ repoRoot, homeDir });
    strictEqual(report.status, 'skipped');
    strictEqual(report.reason, 'gate-off');
    await rejects(() => readdir(captureDir(repoRoot)), /ENOENT/);
  });

  it('an unreadable config layer fail-closes (broken config never turns capture on)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo({ gate: null });
    // config.toml as a DIRECTORY → EISDIR on read → fail-closed skip.
    await mkdir(join(repoRoot, '.agentic-plugins', 'config.toml'), { recursive: true });
    const report = await publish({ repoRoot, homeDir });
    strictEqual(report.status, 'skipped');
    strictEqual(report.reason, 'config-fail-closed');
    await rejects(() => readdir(captureDir(repoRoot)), /ENOENT/);
  });

  it('non-git start dir is a silent no-op (v1 is repo-scoped)', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ctx-pub-nogit-')));
    const report = await publish({ repoRoot: root, homeDir: root });
    strictEqual(report.status, 'skipped');
    strictEqual(report.reason, 'no-repo-root');
    deepStrictEqual(await readdir(root), []);
  });
});

describe('publish-session artifact assembly (contract §3.1/§3.2)', () => {
  it('publishes schema-valid slot+entry sharing one fingerprint; entry carries no repo_root and no note body', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await noteContext({ text: 'headline for the entry', host: 'claude', repoRoot });
    const report = await publish({ repoRoot, homeDir, sessionId: 'sess-A', workflowEvidence: 'fresh' });
    strictEqual(report.status, 'published');
    strictEqual(report.summary_source, 'staged-note');

    const slot = await readJson(join(captureDir(repoRoot), 'slot.json'));
    const entry = await readJson(join(captureDir(repoRoot), 'entry.json'));
    const slotVerdict = validateAgainstSchema(slot, await loadSchema('runtime-session-capture'), { readerVersion: 'runtime-session-capture-1.0' });
    const entryVerdict = validateAgainstSchema(entry, await loadSchema('runtime-session-entry'), { readerVersion: 'runtime-session-entry-1.0' });
    deepStrictEqual(slotVerdict.errors, []);
    deepStrictEqual(entryVerdict.errors, []);

    strictEqual(slot.fingerprint, entry.fingerprint);
    strictEqual(slot.captured_at, entry.captured_at);
    match(slot.captured_at, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    strictEqual(slot.repo_root, repoRoot);
    strictEqual(slot.host, 'claude');
    strictEqual(slot.session_id, 'sess-A');
    strictEqual(slot.repo_recent_terminal_evidence, 'fresh');
    strictEqual(slot.branch, 'main');
    match(slot.head_short, /^[0-9a-f]{7,40}$/);
    // one porcelain entry: the untracked .agentic-plugins/ fixture dir itself
    strictEqual(slot.dirty_count, 1);
    match(slot.status_digest, /^[0-9a-f]{64}$/);
    strictEqual(slot.note.content, 'headline for the entry');

    ok(!('repo_root' in entry), 'entry.json must stay path-free (settlement (a))');
    ok(!('note' in entry), 'entry.json must not carry the note body');
    strictEqual(entry.summary_line, 'headline for the entry');
    strictEqual(entry.note_staged_at, slot.note.staged_at);
  });

  it('structural publication has summary_line and note_staged_at exactly null (required-null, not absent)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const report = await publish({ repoRoot, homeDir });
    strictEqual(report.summary_source, 'structural');
    const entry = await readJson(join(captureDir(repoRoot), 'entry.json'));
    ok('summary_line' in entry);
    ok('note_staged_at' in entry);
    strictEqual(entry.summary_line, null);
    strictEqual(entry.note_staged_at, null);
    const slot = await readJson(join(captureDir(repoRoot), 'slot.json'));
    strictEqual(slot.note, null);
  });
});

describe('commit-record no-op and mixed-generation republish (contract §5.1/§7.2)', () => {
  it('control: an identical rerun within the TTL no-ops (and still sweeps)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const first = await publish({ repoRoot, homeDir, sessionId: 's1' });
    strictEqual(first.status, 'published');
    const again = await publish({ repoRoot, homeDir, sessionId: 's1' });
    strictEqual(again.status, 'skipped');
    strictEqual(again.reason, 'fresh-no-op');
    strictEqual(again.fingerprint, first.fingerprint);
  });

  it('the no-op decision reads the COMMITTED entry.json — a missing commit record forces republication even with a fresh slot', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 's1' });
    await rm(join(captureDir(repoRoot), 'entry.json'));
    const report = await publish({ repoRoot, homeDir, sessionId: 's1' });
    strictEqual(report.status, 'published', 'slot.json alone must never satisfy the no-op check');
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed');
  });

  it('a fingerprint-divergent slot/entry pair (mixed generation) forces republication and self-heals', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 's1' });
    const slotPath = join(captureDir(repoRoot), 'slot.json');
    const slot = await readJson(slotPath);
    slot.fingerprint = 'fp1:' + 'e'.repeat(64);
    await writeFile(slotPath, JSON.stringify(slot));
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'mixed');
    const report = await publish({ repoRoot, homeDir, sessionId: 's1' });
    strictEqual(report.status, 'published', 'a mixed generation must never be load-bearing');
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed');
  });

  it('a same-fingerprint pair with DIVERGING captured_at is a mixed generation (crash between renames) and republishes', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 's1' });
    const slotPath = join(captureDir(repoRoot), 'slot.json');
    const slot = await readJson(slotPath);
    slot.captured_at = '2020-01-01T00:00:00Z'; // fingerprint untouched
    await writeFile(slotPath, JSON.stringify(slot));
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'mixed', 'same-generation identity is fingerprint AND captured_at');
    const report = await publish({ repoRoot, homeDir, sessionId: 's1' });
    strictEqual(report.status, 'published', 'a timestamp-diverged pair must never be load-bearing');
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed');
  });

  it('exactly-at-TTL is NOT fresh (strictly younger-than, contract §4)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const base = new Date('2026-07-19T12:00:00Z');
    await publish({ repoRoot, homeDir, sessionId: 's1', now: base });
    const atBoundary = await publish({ repoRoot, homeDir, sessionId: 's1', now: new Date(base.getTime() + PUBLISH_REFRESH_TTL_MS) });
    strictEqual(atBoundary.status, 'published');
  });

  it('a malformed committed entry.json fail-closes into republication', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 's1' });
    await writeFile(join(captureDir(repoRoot), 'entry.json'), 'not json at all');
    const report = await publish({ repoRoot, homeDir, sessionId: 's1' });
    strictEqual(report.status, 'published');
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed');
  });

  it('the refresh TTL bounds the no-op window; far-future commit timestamps are never trusted as fresh', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const base = new Date('2026-07-19T12:00:00Z');
    await publish({ repoRoot, homeDir, sessionId: 's1', now: base });
    // control: just inside the TTL still no-ops
    const inside = await publish({ repoRoot, homeDir, sessionId: 's1', now: new Date(base.getTime() + PUBLISH_REFRESH_TTL_MS - 1000) });
    strictEqual(inside.reason, 'fresh-no-op');
    // past the TTL republishes
    const past = await publish({ repoRoot, homeDir, sessionId: 's1', now: new Date(base.getTime() + PUBLISH_REFRESH_TTL_MS + 1000) });
    strictEqual(past.status, 'published');
    // a commit record 61 s in the FUTURE of the caller clock republishes
    const skewed = await publish({ repoRoot, homeDir, sessionId: 's1', now: new Date(base.getTime() + PUBLISH_REFRESH_TTL_MS + 1000 - 61000 - 61000) });
    strictEqual(skewed.status, 'published', 'beyond the 60s skew bound the committed captured_at is untrustworthy');
  });
});

describe('fingerprint sensitivity with contract-recomputed vectors (contract §5.1/§5.2)', () => {
  it('the published fingerprint equals the independent §5.1 recomputation (no-note vector)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const report = await publish({ repoRoot, homeDir, sessionId: 'vec-1' });
    const facts = await observeSessionGitFacts(repoRoot);
    const expected = contractFingerprint({
      branch: facts.branch,
      headShort: facts.headShort,
      statusDigest: facts.statusDigest,
      sessionId: 'vec-1',
      note: null,
      workflowEvidence: 'none',
    });
    strictEqual(report.fingerprint, expected);
    strictEqual(computeSessionFingerprint({
      branch: facts.branch, headShort: facts.headShort, statusDigest: facts.statusDigest,
      sessionId: 'vec-1', note: null, workflowEvidence: 'none',
    }), expected);
  });

  it('Unicode note content vector: fingerprint folds the exact content hash + staging instant', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const staged = await noteContext({ text: '한글 노트 ✓ vector', host: 'claude', repoRoot });
    const report = await publish({ repoRoot, homeDir, sessionId: 'vec-2' });
    const facts = await observeSessionGitFacts(repoRoot);
    const expected = contractFingerprint({
      branch: facts.branch,
      headShort: facts.headShort,
      statusDigest: facts.statusDigest,
      sessionId: 'vec-2',
      note: { content_hash: staged.content_hash, staged_at: staged.staged_at },
      workflowEvidence: 'none',
    });
    strictEqual(report.fingerprint, expected);
    strictEqual(report.summary_source, 'staged-note');
  });

  it('re-staging IDENTICAL content with a refreshed staged_at republishes (settlement (b))', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const t1 = new Date('2026-07-19T12:00:00Z');
    const t2 = new Date('2026-07-19T12:00:05Z');
    await noteContext({ text: 'same text', host: 'claude', repoRoot, now: t1 });
    const first = await publish({ repoRoot, homeDir, sessionId: 's', now: t1 });
    strictEqual(first.status, 'published');
    // control: nothing changed → no-op
    strictEqual((await publish({ repoRoot, homeDir, sessionId: 's', now: t2 })).reason, 'fresh-no-op');
    // identical text, refreshed metadata → the note component moves → republish
    const restaged = await noteContext({ text: 'same text', host: 'claude', repoRoot, now: t2 });
    strictEqual(restaged.status, 'staged');
    const second = await publish({ repoRoot, homeDir, sessionId: 's', now: t2 });
    strictEqual(second.status, 'published');
    notStrictEqual(second.fingerprint, first.fingerprint);
  });

  it('each structural component change republishes: session id, evidence, HEAD, status digest, branch', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const r1 = await publish({ repoRoot, homeDir, sessionId: 'a' });
    strictEqual(r1.status, 'published');

    const r2 = await publish({ repoRoot, homeDir, sessionId: 'b' });
    strictEqual(r2.status, 'published', 'session id change must republish');

    const r3 = await publish({ repoRoot, homeDir, sessionId: 'b', workflowEvidence: 'fresh' });
    strictEqual(r3.status, 'published', 'workflow evidence change must republish');

    await commitEmpty(repoRoot, 'move head');
    const r4 = await publish({ repoRoot, homeDir, sessionId: 'b', workflowEvidence: 'fresh' });
    strictEqual(r4.status, 'published', 'HEAD change must republish');

    await writeFile(join(repoRoot, 'dirty.txt'), 'x');
    const r5 = await publish({ repoRoot, homeDir, sessionId: 'b', workflowEvidence: 'fresh' });
    strictEqual(r5.status, 'published', 'status digest change must republish');
    // untracked .agentic-plugins/ fixture dir + dirty.txt
    strictEqual((await readJson(join(captureDir(repoRoot), 'slot.json'))).dirty_count, 2);

    await run('git', ['switch', '-q', '-c', 'feature/x'], { cwd: repoRoot });
    const r6 = await publish({ repoRoot, homeDir, sessionId: 'b', workflowEvidence: 'fresh' });
    strictEqual(r6.status, 'published', 'branch change must republish');
    strictEqual((await readJson(join(captureDir(repoRoot), 'entry.json'))).branch, 'feature/x');

    const fingerprints = new Set([r1, r2, r3, r4, r5, r6].map((r) => r.fingerprint));
    strictEqual(fingerprints.size, 6, 'every component change must move the fingerprint');
  });
});

describe('note folding window and races (contract §4/§6, ADR-0044 §10 note races)', () => {
  it('control: a note inside the fold window folds; an expired note is ignored, not deleted', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const staleStage = new Date('2026-07-18T00:00:00Z');
    const now = new Date('2026-07-19T12:00:00Z'); // 36 h later — outside 24 h
    await noteContext({ text: 'old note', host: 'claude', repoRoot, now: staleStage });
    const report = await publish({ repoRoot, homeDir, now });
    strictEqual(report.status, 'published');
    strictEqual(report.summary_source, 'structural', 'an expired note must not fold');
    ok((await readFile(join(captureDir(repoRoot), 'note.json'), 'utf8')).includes('old note'), 'expired notes are ignored, never deleted');
    // control half: the same note within the window folds
    const fresh = await publish({ repoRoot, homeDir, now: new Date(staleStage.getTime() + 60 * 60 * 1000) });
    strictEqual(fresh.summary_source, 'staged-note');
  });

  it('a far-future staged_at must not read as fresh (fold-window skew bound)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const now = new Date('2026-07-19T12:00:00Z');
    await noteContext({ text: 'time traveler', host: 'claude', repoRoot, now: new Date(now.getTime() + 3600 * 1000) });
    const report = await publish({ repoRoot, homeDir, now });
    strictEqual(report.summary_source, 'structural');
  });

  it('publisher vs --clear: clearing after a folded publication flips the next generation back to structural', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await noteContext({ text: 'to be cleared', host: 'claude', repoRoot });
    const withNote = await publish({ repoRoot, homeDir });
    strictEqual(withNote.summary_source, 'staged-note');
    const cleared = await noteContext({ clear: true, repoRoot });
    strictEqual(cleared.removed, true);
    const after = await publish({ repoRoot, homeDir });
    strictEqual(after.status, 'published', 'note removal moves the fingerprint');
    strictEqual(after.summary_source, 'structural');
    strictEqual((await readJson(join(captureDir(repoRoot), 'entry.json'))).summary_line, null);
  });

  it('concurrent stagings: the last staged note wins the fold', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    // Publication clock injected AFTER both stagings — a staged_at ahead of
    // the publisher clock would (correctly) be skew-refused by the fold gate.
    await noteContext({ text: 'first staging', host: 'claude', repoRoot, now: new Date('2026-07-19T12:00:00Z') });
    await noteContext({ text: 'second staging', host: 'claude', repoRoot, now: new Date('2026-07-19T12:00:01Z') });
    const report = await publish({ repoRoot, homeDir, now: new Date('2026-07-19T12:00:02Z') });
    strictEqual(report.summary_source, 'staged-note');
    strictEqual((await readJson(join(captureDir(repoRoot), 'slot.json'))).note.content, 'second staging');
  });

  it('two concurrent publishers serialize through the lock without corrupting the pair', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const [a, b] = await Promise.all([
      publish({ repoRoot, homeDir, sessionId: 'race-a' }),
      publish({ repoRoot, homeDir, sessionId: 'race-b' }),
    ]);
    const statuses = [a.status, b.status].sort();
    ok(statuses.includes('published'), `at least one publisher must land (got ${a.status}/${a.reason ?? ''} and ${b.status}/${b.reason ?? ''})`);
    for (const r of [a, b]) {
      if (r.status === 'skipped') ok(['lock-held', 'fresh-no-op', 'lock-takeover-race'].includes(r.reason), `unexpected skip reason ${r.reason}`);
    }
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed', 'the surviving pair must be a committed generation');
  });
});

describe('injection clamps on entry.json (contract §3.2/§11)', () => {
  it('the summary line is the FIRST line only, control-stripped and clamped to 160 chars', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const longFirst = ('A'.repeat(100)) + BEL + ('B'.repeat(100));
    const content = [longFirst, 'second line must never appear'].join(String.fromCharCode(10));
    await noteContext({ text: content, host: 'claude', repoRoot });
    const report = await publish({ repoRoot, homeDir });
    strictEqual(report.status, 'published');
    const entry = await readJson(join(captureDir(repoRoot), 'entry.json'));
    strictEqual(entry.summary_line.length, 160);
    strictEqual(entry.summary_line, ('A'.repeat(100)) + ('B'.repeat(60)), 'BEL stripped, then clamped');
    ok(!entry.summary_line.includes('second line'), 'only the first line may project');
    const verdict = validateAgainstSchema(entry, await loadSchema('runtime-session-entry'), { readerVersion: 'runtime-session-entry-1.0' });
    deepStrictEqual(verdict.errors, []);
  });

  it('a hostile session id is clamped (control chars stripped, 128-char cap), never rejected', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const hostile = BEL + 'sess' + BEL + '-' + 'x'.repeat(200);
    const report = await publish({ repoRoot, homeDir, sessionId: hostile });
    strictEqual(report.status, 'published');
    const slot = await readJson(join(captureDir(repoRoot), 'slot.json'));
    strictEqual(slot.session_id.length, 128);
    ok(slot.session_id.startsWith('sess-x'));
    ok(!slot.session_id.includes(BEL));
  });

  it('an all-control session id clamps to null (omitted-when-absent equivalence)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const report = await publish({ repoRoot, homeDir, sessionId: BEL + BEL });
    strictEqual(report.status, 'published');
    strictEqual((await readJson(join(captureDir(repoRoot), 'slot.json'))).session_id, null);
  });

  it('a bare-CR line break also ends the first line (it must not merge lines after control stripping)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const content = 'first' + String.fromCharCode(13) + 'second-must-not-appear';
    await noteContext({ text: content, host: 'claude', repoRoot });
    await publish({ repoRoot, homeDir });
    const entry = await readJson(join(captureDir(repoRoot), 'entry.json'));
    strictEqual(entry.summary_line, 'first');
  });

  it('the entry biconditional is enforced in BOTH directions by the validating reader', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await noteContext({ text: 'note line', host: 'claude', repoRoot });
    await publish({ repoRoot, homeDir });
    const entryPath = join(captureDir(repoRoot), 'entry.json');
    const good = await readJson(entryPath);
    strictEqual(good.summary_source, 'staged-note'); // control: the real pair validates
    strictEqual((await readSlotStatus({ repoRoot })).files.entry.state, 'valid');
    const broken = { ...good, note_staged_at: null };
    await writeFile(entryPath, JSON.stringify(broken));
    const status = await readSlotStatus({ repoRoot });
    strictEqual(status.files.entry.state, 'invalid', 'staged-note with null note_staged_at must fail the semantic check');
    match(status.files.entry.reason, /staged-note requires/);
  });

  it('a negative dirty_count fails the semantic check (fail-closed skip)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir });
    const entryPath = join(captureDir(repoRoot), 'entry.json');
    const good = await readJson(entryPath);
    await writeFile(entryPath, JSON.stringify({ ...good, dirty_count: -1 }));
    const status = await readSlotStatus({ repoRoot });
    strictEqual(status.files.entry.state, 'invalid');
    match(status.files.entry.reason, /non-negative integer/);
  });

  it('an invalid workflow-evidence value is refused (validated argv, hook-grade CLI converts to silence)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await rejects(() => publish({ repoRoot, homeDir, workflowEvidence: 'maybe' }), /--workflow-evidence must be none or fresh/);
    // control: the valid values pass
    strictEqual((await publish({ repoRoot, homeDir, workflowEvidence: 'fresh' })).status, 'published');
  });
});

describe('hostile paths (ADR-0044 §10 containment)', () => {
  it('control first: the honest chain publishes; then a symlinked session-capture parent is refused with nothing written through it', async () => {
    const control = await makeGitRepo();
    strictEqual((await publish({ repoRoot: control.repoRoot, homeDir: control.homeDir })).status, 'published');

    const { root, repoRoot, homeDir } = await makeGitRepo();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await mkdir(join(repoRoot, '.agentic-plugins', 'state', 'runtime'), { recursive: true });
    await symlink(outside, join(repoRoot, '.agentic-plugins', 'state', 'runtime', 'session-capture'));
    await rejects(
      () => publish({ repoRoot, homeDir }),
      /symlinked parent refused/,
    );
    deepStrictEqual(await readdir(outside), [], 'nothing may be written through the symlink');
  });
});

describe('slot lock (contract §8)', () => {
  it('a fresh foreign lock skips silently; the slot pair is untouched', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 'before' });
    const dir = captureDir(repoRoot);
    await writeFile(join(dir, '.lock'), '9999:feedface');
    const report = await publish({ repoRoot, homeDir, sessionId: 'after' });
    strictEqual(report.status, 'skipped');
    strictEqual(report.reason, 'lock-held');
    strictEqual((await readJson(join(dir, 'slot.json'))).session_id, 'before', 'a held lock must block publication');
    strictEqual(await readFile(join(dir, '.lock'), 'utf8'), '9999:feedface', 'a held lock is never rewritten');
    await rm(join(dir, '.lock'));
  });

  it('a stale lock (older than the stale age) is taken over, republished through, and released', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 'before' });
    const dir = captureDir(repoRoot);
    const lockPath = join(dir, '.lock');
    await writeFile(lockPath, '9999:stale');
    const old = new Date(Date.now() - LOCK_STALE_AGE_MS - 5000);
    await utimes(lockPath, old, old);
    const report = await publish({ repoRoot, homeDir, sessionId: 'after' });
    strictEqual(report.status, 'published');
    strictEqual(report.lock_takeover, true);
    await rejects(() => lstat(lockPath), /ENOENT/, 'the takeover owner releases its rewritten lock');
    strictEqual((await readJson(join(dir, 'slot.json'))).session_id, 'after');
  });

  it('a lock mtime within the future-skew bound reads as held; far beyond it, as stale (self-healing)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 'before' });
    const dir = captureDir(repoRoot);
    const lockPath = join(dir, '.lock');

    await writeFile(lockPath, '9999:nearfuture');
    const near = new Date(Date.now() + 30 * 1000); // inside the 60 s bound
    await utimes(lockPath, near, near);
    const held = await publish({ repoRoot, homeDir, sessionId: 'after' });
    strictEqual(held.reason, 'lock-held');

    const far = new Date(Date.now() + 3600 * 1000); // way past the bound — untrustworthy
    await utimes(lockPath, far, far);
    const takeover = await publish({ repoRoot, homeDir, sessionId: 'after' });
    strictEqual(takeover.status, 'published');
    strictEqual(takeover.lock_takeover, true);
  });

  it('a symlinked .lock is refused outright (never written through, never taken over)', async () => {
    const { root, repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 'before' });
    const dir = captureDir(repoRoot);
    const victim = join(root, 'victim');
    await writeFile(victim, 'innocent');
    await symlink(victim, join(dir, '.lock'));
    const report = await publish({ repoRoot, homeDir, sessionId: 'after' });
    strictEqual(report.status, 'skipped');
    strictEqual(report.reason, 'lock-not-regular');
    strictEqual(await readFile(victim, 'utf8'), 'innocent');
    strictEqual((await readJson(join(dir, 'slot.json'))).session_id, 'before');
  });

  it('the lock is gone after a normal publication (released in finally)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir });
    const names = await readdir(captureDir(repoRoot));
    ok(!names.includes('.lock'), `lock must be released, saw ${names.join(',')}`);
  });

  it('stale takeover is mutually exclusive: two racing contenders yield at most ONE takeover (claim-rename atomicity)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 'before' });
    const lockPath = join(captureDir(repoRoot), '.lock');
    await writeFile(lockPath, '9999:stale');
    const old = new Date(Date.now() - LOCK_STALE_AGE_MS - 5000);
    await utimes(lockPath, old, old);
    const [a, b] = await Promise.all([
      publish({ repoRoot, homeDir, sessionId: 'race-a' }),
      publish({ repoRoot, homeDir, sessionId: 'race-b' }),
    ]);
    const takeovers = [a, b].filter((r) => r.lock_takeover === true).length;
    ok(takeovers <= 1, `at most one contender may win the stale-lock claim (got ${takeovers}: ${a.status}/${a.reason ?? ''} ${b.status}/${b.reason ?? ''})`);
    ok([a, b].some((r) => r.status === 'published'), 'the winning contender must publish');
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed');
  });
});

describe('own-staging sweep (contract §7.3)', () => {
  it('removes only old temp-pattern files, bounded per run, preserving fresh temps and foreign names — on the no-op path too', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 's' });
    const dir = captureDir(repoRoot);
    const oldTime = new Date(Date.now() - SWEEP_MAX_AGE_MS - 60 * 1000);

    // SWEEP_MAX_REMOVALS + 2 old temps, one fresh temp, one non-temp stray.
    const oldTemps = [];
    for (let i = 0; i < SWEEP_MAX_REMOVALS + 2; i += 1) {
      const name = `slot.json.tmp-${1000 + i}-` + 'ab'.repeat(4);
      oldTemps.push(name);
      await writeFile(join(dir, name), 'stale');
      await utimes(join(dir, name), oldTime, oldTime);
    }
    await writeFile(join(dir, 'entry.json.tmp-1-ffff'), 'fresh temp');
    await writeFile(join(dir, 'stray.txt'), 'not a temp');
    await utimes(join(dir, 'stray.txt'), oldTime, oldTime);

    const report = await publish({ repoRoot, homeDir, sessionId: 's' });
    strictEqual(report.reason, 'fresh-no-op', 'a no-op publication still sweeps');
    strictEqual(report.swept_temps, SWEEP_MAX_REMOVALS, 'sweep is bounded per run');

    const names = await readdir(dir);
    strictEqual(names.filter((n) => oldTemps.includes(n)).length, 2, 'exactly the bounded remainder survives this run');
    ok(names.includes('entry.json.tmp-1-ffff'), 'a fresh temp is not swept');
    ok(names.includes('stray.txt'), 'non-temp names are never candidates');
  });

  it('a symlink planted at a temp name is skipped, never followed', async () => {
    const { root, repoRoot, homeDir } = await makeGitRepo();
    await publish({ repoRoot, homeDir, sessionId: 's' });
    const dir = captureDir(repoRoot);
    const victim = join(root, 'victim-file');
    await writeFile(victim, 'innocent');
    const linkName = join(dir, 'note.json.tmp-77-9999');
    await symlink(victim, linkName);
    // lutimes is not universally available; the sweep must skip the symlink
    // regardless of its age because lstat says it is not a regular file.
    await publish({ repoRoot, homeDir, sessionId: 's2' });
    strictEqual(await readFile(victim, 'utf8'), 'innocent');
    ok((await readdir(dir)).includes('note.json.tmp-77-9999'), 'symlinked temp names are skipped');
  });
});

describe('publish-session CLI hook-grade discipline (contract §1/§9)', () => {
  it('a successful publication is exit 0, stdout-silent, stderr-silent', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const result = await runCli(['publish-session', '--host', 'claude', '--repo-root', repoRoot], { cwd: repoRoot, homeDir });
    deepStrictEqual(result, { code: 0, stdout: '', stderr: '' });
    strictEqual((await readSlotStatus({ repoRoot })).generation, 'committed');
  });

  it('a gate-off skip is exit 0 and fully silent', async () => {
    const { repoRoot, homeDir } = await makeGitRepo({ gate: null });
    const result = await runCli(['publish-session', '--host', 'claude', '--repo-root', repoRoot], { cwd: repoRoot, homeDir });
    deepStrictEqual(result, { code: 0, stdout: '', stderr: '' });
  });

  it('a non-git cwd is exit 0 and fully silent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctx-pub-cli-'));
    const result = await runCli(['publish-session', '--host', 'claude'], { cwd: root, homeDir: root });
    deepStrictEqual(result, { code: 0, stdout: '', stderr: '' });
  });

  it('options BEFORE the command still classify as hook-grade (argv-order independence)', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const good = await runCli(['--repo-root', repoRoot, 'publish-session', '--host', 'claude'], { cwd: repoRoot, homeDir });
    deepStrictEqual(good, { code: 0, stdout: '', stderr: '' });
    // and an argv FAILURE in that order still exits 0 with one stderr line
    const bad = await runCli(['--repo-root', repoRoot, 'publish-session', '--host', 'claude', '--format', 'json'], { cwd: repoRoot, homeDir });
    strictEqual(bad.code, 0);
    strictEqual(bad.stdout, '');
    strictEqual(bad.stderr.trim().split(String.fromCharCode(10)).length, 1);
  });

  it('an argv failure is exit 0, stdout-silent, exactly ONE stderr line', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    for (const argv of [
      ['publish-session', '--host', 'claude', '--format', 'json'],
      ['publish-session', '--host', 'claude', '--help'],
      ['publish-session', '--host', 'claude', '--slot'],
      ['publish-session'],
      ['publish-session', '--host', 'nope'],
      ['publish-session', '--host', 'claude', '--workflow-evidence', 'maybe'],
    ]) {
      const result = await runCli(argv, { cwd: repoRoot, homeDir });
      strictEqual(result.code, 0, `${argv.join(' ')} must exit 0`);
      strictEqual(result.stdout, '', `${argv.join(' ')} must not print to stdout`);
      strictEqual(result.stderr.trim().split(String.fromCharCode(10)).length, 1, `${argv.join(' ')} must emit exactly one stderr line`);
    }
  });

  it('operator surfaces are untouched: --session-id / --workflow-evidence are refused outside publish-session', async () => {
    const { repoRoot, homeDir } = await makeGitRepo();
    const noteResult = await runCli(['note', '--text', 'x', '--session-id', 's'], { cwd: repoRoot, homeDir });
    strictEqual(noteResult.code, 1);
    match(noteResult.stderr, /--session-id applies only to publish-session/);
    const statusResult = await runCli(['status', '--slot', '--workflow-evidence', 'fresh'], { cwd: repoRoot, homeDir });
    strictEqual(statusResult.code, 1);
    match(statusResult.stderr, /--workflow-evidence applies only to publish-session/);
  });
});

describe('resolveGitTopLevel + observeSessionGitFacts (contract §6 per-field degradation)', () => {
  it('resolves the toplevel from a subdirectory; a non-git dir resolves null (publisher no-ops upstream)', async () => {
    const { repoRoot } = await makeGitRepo({ gate: null });
    const sub = join(repoRoot, 'sub');
    await mkdir(sub);
    strictEqual(await resolveGitTopLevel(sub), repoRoot);
    const nogit = await mkdtemp(join(tmpdir(), 'ctx-facts-nogit-'));
    strictEqual(await resolveGitTopLevel(nogit), null);
  });

  it('a repo path with a trailing space is preserved verbatim (trim would resolve a SIBLING directory)', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ctx-trim-')));
    const spaced = join(root, 'repo ');
    await mkdir(spaced);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: spaced });
    strictEqual(await resolveGitTopLevel(spaced), spaced, 'only the terminating line break may be stripped');
  });

  it('observes branch/head/digest/dirty-count in a normal repo (control)', async () => {
    const { repoRoot } = await makeGitRepo({ gate: null }); // no .agentic-plugins fixture — clean porcelain baseline
    await writeFile(join(repoRoot, 'a.txt'), '1');
    await writeFile(join(repoRoot, 'b.txt'), '2');
    const facts = await observeSessionGitFacts(repoRoot);
    strictEqual(facts.branch, 'main');
    match(facts.headShort, /^[0-9a-f]{7,40}$/);
    strictEqual(facts.dirtyCount, 2);
    match(facts.statusDigest, /^[0-9a-f]{64}$/);
  });

  it('detached HEAD degrades branch to null while the rest observes', async () => {
    const { repoRoot } = await makeGitRepo();
    await run('git', ['checkout', '-q', '--detach'], { cwd: repoRoot });
    const facts = await observeSessionGitFacts(repoRoot);
    strictEqual(facts.branch, null);
    match(facts.headShort, /^[0-9a-f]{7,40}$/);
  });

  it('unborn HEAD degrades head_short to null; branch and digest still observe', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ctx-facts-')));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    strictEqual(await resolveGitTopLevel(root), root);
    const facts = await observeSessionGitFacts(root);
    strictEqual(facts.branch, 'main');
    strictEqual(facts.headShort, null);
    match(facts.statusDigest, /^[0-9a-f]{64}$/);
    strictEqual(facts.dirtyCount, 0);
  });
});
