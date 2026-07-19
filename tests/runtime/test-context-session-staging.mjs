// ADR-0044 S3a staging-executor tests: the `note` staging write
// (--text/--file/--clear), its source-file and byte-cap gates, the
// hook-grade vs operator output-mode split, and the read-only
// `status --slot` inspection with per-file fail-closed skip
// (session-capture-contract.md §11 S3a obligations).
//
// Mutation discipline (the S2 rule): every rejection case is paired with a
// passing control first, so a green run proves the gate bites rather than
// the fixture never reaching it.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  NOTE_CONTENT_MAX_BYTES,
  formatText,
  noteContext,
  parseArgs,
  readSlotStatus,
  runContext,
} from '../../plugins/runtime/scripts/context.mjs';
import {
  loadSchema,
  validateAgainstSchema,
} from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const run = promisify(execFile);
const CONTEXT_CLI = fileURLToPath(new URL('../../plugins/runtime/scripts/context.mjs', import.meta.url));
const CAPTURE_SEGMENTS = ['.agentic-plugins', 'state', 'runtime', 'session-capture'];

// Pre-computed vectors — computed OUTSIDE the implementation under test, so a
// hash-construction bug (wrong encoding, hashing the JSON instead of the
// content bytes) fails loudly instead of comparing the bug to itself.
const HELLO_SHA256 = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const UNICODE_CONTENT = '한글 노트 ✓ vector'; // 24 UTF-8 bytes, 16 codepoints
const UNICODE_SHA256 = 'sha256:f39933dde6400efbdc7ceb790c8dbe7bbd28362bdfe80f48699066a18c3692f1';

async function makeGitRepo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ctx-staging-')));
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await run('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
  return { root, repoRoot };
}

function captureDir(repoRoot) {
  return join(repoRoot, ...CAPTURE_SEGMENTS);
}

function notePath(repoRoot) {
  return join(captureDir(repoRoot), 'note.json');
}

async function runCli(args, { cwd }) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CONTEXT_CLI, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function validSlotDocument(overrides = {}) {
  return {
    schema: 'runtime-session-capture-1.0',
    captured_at: '2026-07-19T00:00:00Z',
    origin: 'stop-hook',
    summary_source: 'structural',
    host: 'claude',
    session_id: null,
    repo_recent_terminal_evidence: 'none',
    repo_root: '/tmp/example-repo',
    branch: 'main',
    head_short: 'abcdef1234',
    dirty_count: 0,
    status_digest: 'a'.repeat(64),
    note: null,
    fingerprint: `fp1:${'b'.repeat(64)}`,
    ...overrides,
  };
}

function validEntryDocument(overrides = {}) {
  return {
    schema: 'runtime-session-entry-1.0',
    captured_at: '2026-07-19T00:00:00Z',
    origin: 'stop-hook',
    summary_source: 'structural',
    host: 'claude',
    branch: 'main',
    head_short: 'abcdef1234',
    dirty_count: 0,
    repo_recent_terminal_evidence: 'none',
    summary_line: null,
    note_staged_at: null,
    fingerprint: `fp1:${'b'.repeat(64)}`,
    ...overrides,
  };
}

describe('note staging (contract §3.3/§6)', () => {
  it('stages a schema-round-trip note with the exact content hash and second-precision staged_at', async () => {
    const { repoRoot } = await makeGitRepo();
    const report = await noteContext({
      text: 'hello',
      host: 'claude',
      repoRoot,
      now: new Date('2026-07-19T01:02:03.456Z'),
    });
    strictEqual(report.command, 'note');
    strictEqual(report.status, 'staged');
    strictEqual(report.staged_at, '2026-07-19T01:02:03Z', 'second precision — schema pattern carries no millis');
    strictEqual(report.host, 'claude');
    strictEqual(report.branch, 'main');
    match(report.head_short, /^[0-9a-f]{12}$/);
    strictEqual(report.content_bytes, 5);
    strictEqual(report.content_hash, HELLO_SHA256, 'exact pre-computed vector');
    strictEqual(report.note_pointer, '.agentic-plugins/state/runtime/session-capture/note.json');

    const document = JSON.parse(await readFile(notePath(repoRoot), 'utf8'));
    strictEqual(document.content, 'hello');
    const schema = await loadSchema('runtime-session-note');
    const verdict = validateAgainstSchema(document, schema, { readerVersion: schema.$id });
    deepStrictEqual(verdict.errors, [], 'written file re-validates against the packaged schema');
    strictEqual(verdict.ok, true);

    const leftovers = (await readdir(captureDir(repoRoot))).filter((name) => name.includes('.tmp-'));
    deepStrictEqual(leftovers, [], 'temp+rename leaves no staging temps behind');
  });

  it('hashes the exact UTF-8 content bytes (Unicode vector)', async () => {
    const { repoRoot } = await makeGitRepo();
    const report = await noteContext({ text: UNICODE_CONTENT, repoRoot, now: new Date('2026-07-19T01:02:03Z') });
    strictEqual(report.content_bytes, 24);
    strictEqual(report.content_hash, UNICODE_SHA256);
    strictEqual(report.host, null, 'absent --host stages as null');
  });

  it('re-staging identical text refreshes staged_at (settlement (b))', async () => {
    const { repoRoot } = await makeGitRepo();
    const first = await noteContext({ text: 'same', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(first.staged_at, '2026-07-19T01:00:00Z');
    const second = await noteContext({ text: 'same', repoRoot, now: new Date('2026-07-19T02:00:00Z') });
    strictEqual(second.staged_at, '2026-07-19T02:00:00Z');
    const document = JSON.parse(await readFile(notePath(repoRoot), 'utf8'));
    strictEqual(document.staged_at, '2026-07-19T02:00:00Z');
  });

  it('enforces the 4096-byte cap in UTF-8 BYTES, not codepoints', async () => {
    const { repoRoot } = await makeGitRepo();
    // Control: exactly at the cap passes.
    const atCap = await noteContext({ text: 'x'.repeat(NOTE_CONTENT_MAX_BYTES), repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(atCap.content_bytes, NOTE_CONTENT_MAX_BYTES);
    // One past the cap is refused.
    await rejects(
      noteContext({ text: 'x'.repeat(NOTE_CONTENT_MAX_BYTES + 1), repoRoot }),
      /4097 UTF-8 bytes, over the 4096-byte cap/,
    );
    // The writer cap is BYTE-denominated: 1366 * '가' = 1366 codepoints (far
    // under the schema's codepoint maxLength backstop) but 4098 UTF-8 bytes.
    const multibyte = '가'.repeat(1366);
    strictEqual(Buffer.byteLength(multibyte, 'utf8'), 4098, 'control: fixture really exceeds the byte cap');
    await rejects(noteContext({ text: multibyte, repoRoot }), /4098 UTF-8 bytes, over the 4096-byte cap/);
  });

  it('rejects empty content, pointing at --clear', async () => {
    const { repoRoot } = await makeGitRepo();
    await rejects(noteContext({ text: '', repoRoot }), /must not be empty — use --clear/);
  });

  it('requires exactly one of --text/--file/--clear and scopes --host to staging', async () => {
    const { repoRoot } = await makeGitRepo();
    await rejects(noteContext({ repoRoot }), /exactly one of --text, --file, or --clear/);
    await rejects(noteContext({ text: 'a', file: 'b', repoRoot }), /exactly one of --text, --file, or --clear/);
    await rejects(noteContext({ clear: true, text: 'a', repoRoot }), /exactly one of --text, --file, or --clear/);
    await rejects(noteContext({ clear: true, host: 'claude', repoRoot }), /--host does not combine with --clear/);
  });

  it('validates --host against the claude|codex enum', async () => {
    const { repoRoot } = await makeGitRepo();
    const control = await noteContext({ text: 'a', host: 'codex', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(control.host, 'codex');
    await rejects(noteContext({ text: 'a', host: 'gemini', repoRoot }), /--host must be claude or codex/);
  });

  it('degrades branch to null on detached HEAD while still staging', async () => {
    const { repoRoot } = await makeGitRepo();
    await run('git', ['checkout', '-q', '--detach'], { cwd: repoRoot });
    const report = await noteContext({ text: 'detached', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(report.status, 'staged');
    strictEqual(report.branch, null);
    match(report.head_short, /^[0-9a-f]{12}$/, 'head survives detached HEAD');
  });

  it('clears idempotently', async () => {
    const { repoRoot } = await makeGitRepo();
    await noteContext({ text: 'to clear', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    const first = await noteContext({ clear: true, repoRoot });
    strictEqual(first.status, 'cleared');
    strictEqual(first.removed, true);
    const second = await noteContext({ clear: true, repoRoot });
    strictEqual(second.status, 'cleared');
    strictEqual(second.removed, false, 'clearing an empty slot is a no-op, not an error');
  });

  it('is repo-scoped: non-git rejects for operators and silently skips for hook-grade', async () => {
    const nonGit = await realpath(await mkdtemp(join(tmpdir(), 'ctx-nongit-')));
    await rejects(noteContext({ text: 'x', repoRoot: nonGit }), /repo-scoped: no git repository found/);
    const skipped = await noteContext({ text: 'x', repoRoot: nonGit, hookGrade: true });
    strictEqual(skipped.status, 'skipped');
    strictEqual(skipped.reason, 'no-repo-root');
    const entries = await readdir(nonGit);
    deepStrictEqual(entries, [], 'the hook-grade skip writes nothing');
  });
});

describe('note --file source gates (contract §3.3)', () => {
  it('reads a regular file (control) and rejects a missing one', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const source = join(root, 'source.txt');
    await writeFile(source, 'from a file');
    const report = await noteContext({ file: source, repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(report.status, 'staged');
    const document = JSON.parse(await readFile(notePath(repoRoot), 'utf8'));
    strictEqual(document.content, 'from a file');
    await rejects(noteContext({ file: join(root, 'missing.txt'), repoRoot }), /--file is unreadable: ENOENT/);
  });

  it('rejects a FIFO source (lstat no-follow, non-regular)', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const fifo = join(root, 'pipe.fifo');
    await run('mkfifo', [fifo]);
    const st = await lstat(fifo);
    strictEqual(st.isFIFO(), true, 'control: the fixture really is a FIFO');
    await rejects(noteContext({ file: fifo, repoRoot }), /regular file \(FIFO\/device\/directory/);
  });

  it('rejects a symlinked source even when the target is a regular file', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const target = join(root, 'real.txt');
    await writeFile(target, 'real content');
    const link = join(root, 'link.txt');
    await symlink(target, link);
    const st = await lstat(link);
    strictEqual(st.isSymbolicLink(), true, 'control: the fixture really is a symlink');
    await rejects(noteContext({ file: link, repoRoot }), /symlinked source rejected — lstat no-follow/);
  });

  it('rejects an oversize source file — refused, not truncated', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const atCap = join(root, 'at-cap.txt');
    await writeFile(atCap, 'y'.repeat(NOTE_CONTENT_MAX_BYTES));
    const control = await noteContext({ file: atCap, repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(control.content_bytes, NOTE_CONTENT_MAX_BYTES, 'control: exactly at the cap passes');
    const over = join(root, 'over-cap.txt');
    await writeFile(over, 'y'.repeat(NOTE_CONTENT_MAX_BYTES + 1));
    await rejects(noteContext({ file: over, repoRoot }), /4097 bytes, over the 4096-byte note cap/);
  });

  it('refuses a symlinked session-capture parent BEFORE any mutation (write-root containment, ADR-0044 §10)', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await mkdir(join(repoRoot, '.agentic-plugins', 'state'), { recursive: true });
    await symlink(outside, join(repoRoot, '.agentic-plugins', 'state', 'runtime'));
    await rejects(
      noteContext({ text: 'x', repoRoot }),
      /write root resolves outside the repo \(symlinked parent refused\)/,
    );
    // The refusal must fire before mkdir: the outside directory stays
    // COMPLETELY unchanged — not even an empty session-capture/ subdir
    // (plan-verify peer blocker, live-reproduced against the pre-fix draft).
    deepStrictEqual(await readdir(outside, { recursive: true }), [], 'no directory was created through the symlink');
  });

  it('rejects an invalid-UTF-8 source file instead of replacement-decoding it', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const source = join(root, 'binary.bin');
    await writeFile(source, Buffer.from([0xff, 0xfe, 0x41, 0x42]));
    await rejects(noteContext({ file: source, repoRoot }), /not valid UTF-8 — refused, never replacement-decoded/);
  });

  it('--clear never creates the staging directory', async () => {
    const { repoRoot } = await makeGitRepo();
    const report = await noteContext({ clear: true, repoRoot });
    strictEqual(report.status, 'cleared');
    strictEqual(report.removed, false);
    await rejects(lstat(captureDir(repoRoot)), /ENOENT/, 'clearing an empty repo leaves no directory behind');
  });
});

describe('status --slot (contract §7/§10)', () => {
  it('reports an all-absent staging area honestly', async () => {
    const { repoRoot } = await makeGitRepo();
    const report = await readSlotStatus({ repoRoot });
    strictEqual(report.mode, 'slot');
    strictEqual(report.read_only, true);
    strictEqual(report.generation, 'absent');
    for (const key of ['slot', 'entry', 'note']) {
      strictEqual(report.files[key].state, 'absent');
      strictEqual(report.files[key].summary, null);
    }
  });

  it('reports a committed generation for a valid fingerprint-matched pair', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'slot.json'), `${JSON.stringify(validSlotDocument(), null, 2)}\n`);
    await writeFile(join(dir, 'entry.json'), `${JSON.stringify(validEntryDocument(), null, 2)}\n`);
    const report = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T00:30:00Z') });
    strictEqual(report.files.slot.state, 'valid');
    strictEqual(report.files.entry.state, 'valid');
    strictEqual(report.generation, 'committed');
    strictEqual(report.files.slot.summary.summary_source, 'structural');
    strictEqual(report.files.slot.summary.note_folded, false);
    strictEqual(report.files.entry.summary.summary_line, null);
    strictEqual(report.files.entry.summary.fingerprint, `fp1:${'b'.repeat(64)}`);
  });

  it('marks a fingerprint mismatch and a half-published pair as mixed', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'slot.json'), `${JSON.stringify(validSlotDocument(), null, 2)}\n`);
    await writeFile(
      join(dir, 'entry.json'),
      `${JSON.stringify(validEntryDocument({ fingerprint: `fp1:${'c'.repeat(64)}` }), null, 2)}\n`,
    );
    const mismatch = await readSlotStatus({ repoRoot });
    strictEqual(mismatch.generation, 'mixed', 'fingerprint divergence is a mixed generation');

    await writeFile(join(dir, 'entry.json'), 'not json at all');
    const half = await readSlotStatus({ repoRoot });
    strictEqual(half.generation, 'mixed', 'slot without a committed entry is a mixed generation');
  });

  it('skips a malformed file fail-closed while the others still report (independent recovery)', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'slot.json'), `${JSON.stringify(validSlotDocument(), null, 2)}\n`);
    await writeFile(join(dir, 'entry.json'), `${JSON.stringify(validEntryDocument(), null, 2)}\n`);
    await writeFile(join(dir, 'note.json'), '{ broken');
    const report = await readSlotStatus({ repoRoot });
    strictEqual(report.files.note.state, 'invalid');
    strictEqual(report.files.note.reason, 'not valid JSON');
    strictEqual(report.files.note.summary, null, 'an invalid file exposes no fields');
    strictEqual(report.files.slot.state, 'valid', 'slot recovers independently of the malformed note');
    strictEqual(report.files.entry.state, 'valid');
    strictEqual(report.generation, 'committed', 'the slot pair is judged on its own');
  });

  it('rejects closed-schema violations (unknown structural key) fail-closed', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    // Control first: the same document without the unknown key is valid.
    await writeFile(join(dir, 'entry.json'), `${JSON.stringify(validEntryDocument(), null, 2)}\n`);
    const control = await readSlotStatus({ repoRoot });
    strictEqual(control.files.entry.state, 'valid');
    // An unknown STRUCTURAL key (an imperative smuggle attempt) is refused.
    const smuggled = { ...validEntryDocument(), next_action: { command: 'rm -rf /' } };
    await writeFile(join(dir, 'entry.json'), `${JSON.stringify(smuggled, null, 2)}\n`);
    const report = await readSlotStatus({ repoRoot });
    strictEqual(report.files.entry.state, 'invalid');
    match(report.files.entry.reason, /next_action/);
    strictEqual(report.files.entry.summary, null);
  });

  it('reports note fold-window age diagnostics with an inclusive 24h boundary', async () => {
    const { repoRoot } = await makeGitRepo();
    await noteContext({ text: 'aging note', repoRoot, now: new Date('2026-07-18T00:00:00Z') });
    const inside = await readSlotStatus({ repoRoot, now: new Date('2026-07-18T12:00:00Z') });
    strictEqual(inside.files.note.summary.within_fold_window, true);
    strictEqual(inside.files.note.summary.age_hours, 12);
    strictEqual(inside.files.note.summary.clock_state, 'ok');
    const boundary = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T00:00:00Z') });
    strictEqual(boundary.files.note.summary.within_fold_window, true, 'exactly 24h is still within the fold window');
    const past = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T00:00:01Z') });
    strictEqual(past.files.note.summary.within_fold_window, false, 'one second past 24h is outside');
    const outside = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T06:00:00Z') });
    strictEqual(outside.files.note.summary.within_fold_window, false, 'a 30h-old note is outside the 24h fold window');
  });

  it('bounds future-skewed staged_at by the 60s tolerance (contract §4)', async () => {
    const { repoRoot } = await makeGitRepo();
    await noteContext({ text: 'future note', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    const tolerated = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T00:59:01Z') });
    strictEqual(tolerated.files.note.summary.clock_state, 'ok', '59s of future skew is tolerated');
    strictEqual(tolerated.files.note.summary.age_hours, 0);
    strictEqual(tolerated.files.note.summary.within_fold_window, true);
    const skewed = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T00:58:59Z') });
    strictEqual(skewed.files.note.summary.clock_state, 'future-skewed', '61s of future skew is not "fresh"');
    strictEqual(skewed.files.note.summary.age_hours, null);
    strictEqual(skewed.files.note.summary.within_fold_window, false);
  });

  it('enforces the §11 semantic invariants beyond the schema (hash and structural⇔null)', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    // Control: a staged note passes the semantic check end-to-end.
    await noteContext({ text: 'semantic control', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    const control = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(control.files.note.state, 'valid');
    // A schema-valid note whose hash does not match its content is refused.
    const forged = JSON.parse(await readFile(join(dir, 'note.json'), 'utf8'));
    forged.content = 'tampered content';
    await writeFile(join(dir, 'note.json'), `${JSON.stringify(forged, null, 2)}\n`);
    const tampered = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(tampered.files.note.state, 'invalid');
    match(tampered.files.note.reason, /content_hash does not match the content bytes/);
    // slot: summary_source=structural with a folded note contradicts itself.
    const contradictory = validSlotDocument({
      summary_source: 'structural',
      note: {
        staged_at: '2026-07-19T00:00:00Z',
        host: null,
        branch: null,
        head_short: null,
        content: 'x',
        content_hash: `sha256:${createHash('sha256').update('x').digest('hex')}`,
      },
    });
    await writeFile(join(dir, 'slot.json'), `${JSON.stringify(contradictory, null, 2)}\n`);
    const slotReport = await readSlotStatus({ repoRoot });
    strictEqual(slotReport.files.slot.state, 'invalid');
    match(slotReport.files.slot.reason, /structural requires note=null/);
  });

  it('never echoes note bodies (standalone or folded) in the slot report, and sanitizes rejection reasons', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await noteContext({ text: 'SECRET-STAGED-BODY', repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    const foldedContent = 'SECRET-FOLDED-BODY';
    const folded = validSlotDocument({
      summary_source: 'staged-note',
      note: {
        staged_at: '2026-07-19T00:00:00Z',
        host: 'claude',
        branch: 'main',
        head_short: 'abcdef1234',
        content: foldedContent,
        content_hash: `sha256:${createHash('sha256').update(foldedContent, 'utf8').digest('hex')}`,
      },
    });
    await writeFile(join(dir, 'slot.json'), `${JSON.stringify(folded, null, 2)}\n`);
    await writeFile(
      join(dir, 'entry.json'),
      `${JSON.stringify(validEntryDocument({ summary_source: 'staged-note', summary_line: 'a clamped line', note_staged_at: '2026-07-19T00:00:00Z' }), null, 2)}\n`,
    );
    const report = await readSlotStatus({ repoRoot, now: new Date('2026-07-19T01:00:00Z') });
    strictEqual(report.files.slot.state, 'valid');
    strictEqual(report.files.slot.summary.note_folded, true);
    const serialized = JSON.stringify(report);
    ok(!serialized.includes('SECRET-STAGED-BODY'), 'staged note body never appears in the JSON report');
    ok(!serialized.includes('SECRET-FOLDED-BODY'), 'folded note body never appears in the JSON report');
    const text = formatText(report);
    ok(!text.includes('SECRET-STAGED-BODY') && !text.includes('SECRET-FOLDED-BODY'), 'nor in the text report');
    match(text, /summary_line \(untrusted, quoted\): "a clamped line"/);

    // Rejection reasons carry field paths, never the rejected value.
    await writeFile(
      join(dir, 'entry.json'),
      `${JSON.stringify(validEntryDocument({ summary_line: 'EVIL-VALUE\u0007with-control', note_staged_at: '2026-07-19T00:00:00Z', summary_source: 'staged-note' }), null, 2)}\n`,
    );
    const rejected = await readSlotStatus({ repoRoot });
    strictEqual(rejected.files.entry.state, 'invalid');
    ok(!rejected.files.entry.reason.includes('EVIL-VALUE'), 'the rejected value is not quoted into the reason');
    match(rejected.files.entry.reason, /schema validation failed at .*summary_line/);
  });

  it('skips oversized and symlinked artifact files fail-closed before reading', async () => {
    const { root, repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'slot.json'), `{"pad":"${'x'.repeat(256 * 1024)}"}`);
    const oversized = await readSlotStatus({ repoRoot });
    strictEqual(oversized.files.slot.state, 'invalid');
    match(oversized.files.slot.reason, /over the 262144-byte read bound/);

    const target = join(root, 'real-note.json');
    await writeFile(target, `${JSON.stringify(validEntryDocument(), null, 2)}\n`);
    await symlink(target, join(dir, 'entry.json'));
    const linked = await readSlotStatus({ repoRoot });
    strictEqual(linked.files.entry.state, 'invalid');
    match(linked.files.entry.reason, /symlinked artifact file refused/);
  });

  it('marks an entry-only staging area as mixed', async () => {
    const { repoRoot } = await makeGitRepo();
    const dir = captureDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'entry.json'), `${JSON.stringify(validEntryDocument(), null, 2)}\n`);
    const report = await readSlotStatus({ repoRoot });
    strictEqual(report.files.slot.state, 'absent');
    strictEqual(report.files.entry.state, 'valid');
    strictEqual(report.generation, 'mixed');
  });
});

describe('argument surface (output-mode and selector splits)', () => {
  it('parses note and status --slot forms (controls)', () => {
    const note = parseArgs(['note', '--text', 'hi', '--host', 'claude']);
    strictEqual(note.command, 'note');
    strictEqual(note.text, 'hi');
    const hooked = parseArgs(['note', '--clear', '--hook-grade']);
    strictEqual(hooked.hookGrade, true);
    const slot = parseArgs(['status', '--slot']);
    strictEqual(slot.slot, true);
  });

  it('scopes the staging flags to note and --slot to status', () => {
    throws(() => parseArgs(['capture', '--text', 'x']), /--text applies only to note/);
    throws(() => parseArgs(['status', '--latest', '--clear']), /--clear applies only to note/);
    throws(() => parseArgs(['check', '--risk', 'green', '--host', 'claude']), /--host applies only to note/);
    throws(() => parseArgs(['capture', '--slot']), /--slot applies only to status/);
  });

  it('keeps --slot and the run-ledger selectors mutually exclusive', () => {
    throws(() => parseArgs(['status', '--slot', '--latest']), /--slot or the run-ledger selectors/);
    throws(() => parseArgs(['status', '--slot', '--run-id', 'context-20260513T000000Z-abcdef']), /--slot or the run-ledger selectors/);
    throws(() => parseArgs(['status', '--slot', '--stale-after-hours', '2']), /--stale-after-hours applies to the run-ledger selectors/);
    throws(() => parseArgs(['status', '--slot', '--workflow-projection-file', 'p.json']), /projection flags apply to the run-ledger status/);
  });

  it('restricts --hook-grade to note and keeps it stdout-free', () => {
    throws(() => parseArgs(['capture', '--summary', 's', '--hook-grade']), /--hook-grade applies only to note/);
    throws(() => parseArgs(['note', '--text', 'x', '--hook-grade', '--format', 'json']), /does not combine with --format/);
  });

  it('routes status --slot through runContext', async () => {
    const { repoRoot } = await makeGitRepo();
    const report = await runContext({ command: 'status', slot: true, repoRoot });
    strictEqual(report.mode, 'slot');
    strictEqual(report.generation, 'absent');
  });
});

describe('CLI output-mode split (ADR-0044 §9 — subprocess level)', () => {
  it('operator failure exits 1 on the reporter path (control for the silent mode)', async () => {
    const { repoRoot } = await makeGitRepo();
    const result = await runCli(['note', '--text', ''], { cwd: repoRoot });
    strictEqual(result.code, 1);
    match(result.stderr, /must not be empty/);
  });

  it('hook-grade success is fully silent with exit 0', async () => {
    const { repoRoot } = await makeGitRepo();
    const result = await runCli(['note', '--text', 'hook staged', '--hook-grade'], { cwd: repoRoot });
    strictEqual(result.code, 0);
    strictEqual(result.stdout, '');
    strictEqual(result.stderr, '');
    const document = JSON.parse(await readFile(notePath(repoRoot), 'utf8'));
    strictEqual(document.content, 'hook staged', 'the silent mode still stages');
  });

  it('hook-grade failure exits 0 with exactly one stderr line and no stdout', async () => {
    const { repoRoot } = await makeGitRepo();
    const result = await runCli(['note', '--text', '', '--hook-grade'], { cwd: repoRoot });
    strictEqual(result.code, 0);
    strictEqual(result.stdout, '');
    const lines = result.stderr.split('\n').filter(Boolean);
    strictEqual(lines.length, 1, `at most one stderr line, got: ${JSON.stringify(result.stderr)}`);
    match(lines[0], /note failed/);
  });

  it('hook-grade survives even a parse failure without exiting non-zero', async () => {
    const { repoRoot } = await makeGitRepo();
    const result = await runCli(['note', '--text', 'x', '--hook-grade', '--bogus-flag'], { cwd: repoRoot });
    strictEqual(result.code, 0);
    strictEqual(result.stdout, '');
    const lines = result.stderr.split('\n').filter(Boolean);
    strictEqual(lines.length, 1);
    match(lines[0], /failed at args/);
  });

  it('hook-grade in a non-git cwd is a fully silent no-op', async () => {
    const nonGit = await realpath(await mkdtemp(join(tmpdir(), 'ctx-nongit-cli-')));
    const result = await runCli(['note', '--text', 'x', '--hook-grade'], { cwd: nonGit });
    strictEqual(result.code, 0);
    strictEqual(result.stdout, '');
    strictEqual(result.stderr, '');
    deepStrictEqual(await readdir(nonGit), [], 'nothing written outside a repo');
  });
});
