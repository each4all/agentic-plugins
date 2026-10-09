// ADR-0067 Decisions 1 and 2: the state-root library shared by the personas
// (generated from persona-pipeline/files/scripts/lib/state-root.mjs) and
// orchestrator (a byte-for-byte copy), and the two CLI subcommands built on
// it, `state-root` (read-only) and `shared-creation --enable|--disable` (the
// operator's switch).
//
// The fixtures are real git repositories: a main checkout with a linked
// worktree, a separate-git-dir layout (whose main checkout is not where the
// default state root points), and a sparse checkout.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual, throws } from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { personasFor, pluginRoot, REPO_ROOT } from './_personas.mjs';

const SOURCE = join(REPO_ROOT, 'persona-pipeline/files/scripts/lib/state-root.mjs');
const ORCH_COPY = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/state-root.mjs');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const RUNTIME_COPY = join(REPO_ROOT, 'plugins/runtime/scripts/lib/state-root.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** main (with a commit) and a linked worktree `lane` on branch feat/x. */
function makeRepo(dir) {
  const main = join(dir, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'add', 'README.md');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const lane = join(dir, 'lane');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', lane);
  return { main: realpathSync(main), lane: realpathSync(lane) };
}

const lib = await import(pathToFileURL(SOURCE).href);
const orchLib = await import(pathToFileURL(ORCH_COPY).href);
const runtimeLib = await import(pathToFileURL(RUNTIME_COPY).href);

describe('state-root library (ADR-0067 Decision 1(a))', () => {
  let dir;
  let repo;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  // Contract: the orchestrator copy is the source byte for byte (ADR-0010 §5
  // forbids the import, so the copy is held here), and the generated persona
  // copies are held by the drift check.
  it('the orchestrator copy is the persona-pipeline source, byte for byte', () => {
    strictEqual(readFileSync(ORCH_COPY, 'utf8'), readFileSync(SOURCE, 'utf8'));
  });

  it('a linked worktree: the default state root is the main checkout, read first', () => {
    strictEqual(lib.defaultStateRoot(repo.lane), repo.main);
    deepStrictEqual(lib.readSet(repo.lane), [repo.main, repo.lane]);
  });

  it('the main checkout: one location, spelled as the checkout', () => {
    strictEqual(lib.defaultStateRoot(repo.main), repo.main);
    deepStrictEqual(lib.readSet(repo.main), [repo.main]);
  });

  it('a directory that is no git checkout falls back to itself', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    strictEqual(lib.defaultStateRoot(plain), plain);
    deepStrictEqual(lib.readSet(plain), [plain]);
  });

  // Contract: readers (runtime, RR) and writers (this library) agree on the
  // default state root, or a record created by one is missed by the other.
  it("runtime's reader copy computes the same default state root", () => {
    for (const checkout of [repo.main, repo.lane]) {
      strictEqual(runtimeLib.defaultStateRoot(checkout), lib.defaultStateRoot(checkout), checkout);
      strictEqual(orchLib.defaultStateRoot(checkout), lib.defaultStateRoot(checkout), checkout);
    }
  });

  it('a separate git dir: the default state root is the directory holding .git, not the checkout', () => {
    const sep = join(dir, 'sep');
    const checkout = join(sep, 'work');
    const gitParent = join(sep, 'd');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(gitParent, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', join(gitParent, '.git'), checkout], { env: cleanEnv() });
    strictEqual(lib.defaultStateRoot(checkout), realpathSync(gitParent));
    // The main checkout fails the toplevel check: its .git is a file pointing elsewhere.
    writeFileSync(join(checkout, 'a.txt'), 'a\n');
    git(checkout, 'add', 'a.txt');
    git(checkout, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'a');
    const checks = lib.attestationChecks(checkout);
    strictEqual(checks.ok, false);
    strictEqual(checks.checks.find((c) => c.id === 'toplevel-is-default-state-root').ok, false);
  });

  it('a git dir not named .git: the checkout is its own default state root', () => {
    const odd = join(dir, 'odd');
    mkdirSync(odd, { recursive: true });
    const gitDir = join(dir, 'odd.gitdir');
    execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', gitDir, odd], { env: cleanEnv() });
    strictEqual(lib.defaultStateRoot(odd), realpathSync(odd));
  });
});

// U4d — the third Plan-verify's findings on the library: a repository whose
// identity cannot be read is told from no repository, and the working-tree
// facts of a branch come only from a working tree.
describe('state-root library: identity and working trees (ADR-0067 Decisions 1(b), 2)', () => {
  let dir;
  let repo;
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-u4d-')));
    repo = makeRepo(dir);
  });
  after(() => {
    try { execFileSync('chmod', ['644', join(repo.lane, '.git')]); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('no .git is no repository; a .git that cannot be read is an unreadable identity, and the worktree list fails closed', { skip: asRoot && 'root reads any file' }, () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    strictEqual(lib.gitIdentity(plain).state, 'none');
    deepStrictEqual(lib.otherWorktreeRoots(plain), []);
    strictEqual(lib.gitIdentity(repo.lane).state, 'ok');
    const gitFile = join(repo.lane, '.git');
    execFileSync('chmod', ['000', gitFile]);
    try {
      strictEqual(lib.gitIdentity(repo.lane).state, 'unreadable');
      strictEqual(lib.gitCommonDir(repo.lane), null, 'readers still read it as none');
      throws(() => lib.otherWorktreeRoots(repo.lane), /repository identity cannot be read/);
      // The storage root's identity cannot be read: the command's checkout
      // cannot be told, whatever directory it runs in.
      strictEqual(lib.commandCheckout(repo.lane, repo.main), null);
    } finally {
      execFileSync('chmod', ['644', gitFile]);
    }
    strictEqual(lib.commandCheckout(repo.lane, repo.lane), repo.lane, 'control');
  });

  it('a directory that is no checkout, gitdir line missing: unreadable, not none', () => {
    const broken = join(dir, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '.git'), 'not a gitdir line\n');
    strictEqual(lib.gitIdentity(broken).state, 'unreadable');
    throws(() => lib.otherWorktreeRoots(broken), /repository identity cannot be read/);
  });

  it('runInCommandDirectory names the checkout a writer judges; outside it, the working directory', async () => {
    strictEqual(lib.commandDirectory(), process.cwd());
    strictEqual(await lib.runInCommandDirectory(repo.lane, async () => lib.commandDirectory()), repo.lane);
    strictEqual(lib.runInCommandDirectory(repo.lane, () => lib.commandCheckout(repo.main)), repo.lane);
    strictEqual(lib.commandDirectory(), process.cwd(), 'nothing leaks out of the run');
  });

  it('runInCommandDirectory holds across awaits, as the writers read it after their I/O', async () => {
    const seen = await lib.runInCommandDirectory(repo.lane, async () => {
      await new Promise((done) => setTimeout(done, 5));
      await Promise.resolve();
      const first = lib.commandDirectory();
      await new Promise((done) => setImmediate(done));
      return [first, lib.commandDirectory(), lib.commandCheckout(repo.main)];
    });
    deepStrictEqual(seen, [repo.lane, repo.lane, repo.lane]);
  });

  it('a .git link that names nothing is a lost identity, not no repository: the worktree list fails closed', () => {
    const lost = join(dir, 'lost-link');
    mkdirSync(lost, { recursive: true });
    symlinkSync(join(dir, 'nowhere', '.git'), join(lost, '.git'));
    strictEqual(lib.gitIdentity(lost).state, 'unreadable');
    throws(() => lib.otherWorktreeRoots(lost), /repository identity cannot be read/);
    strictEqual(lib.gitCommonDir(lost), runtimeLib.gitCommonDir(lost), "the reader's rule, as runtime's copy");
    strictEqual(lib.defaultStateRoot(lost), runtimeLib.defaultStateRoot(lost));
  });

  it('a commondir naming a directory that is gone is a lost identity; readers keep the name, as runtime does', () => {
    const moved = join(dir, 'moved');
    const gitDir = join(dir, 'moved-gitdir');
    mkdirSync(moved, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(moved, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'commondir'), '../gone/.git\n');
    const identity = lib.gitIdentity(moved);
    strictEqual(identity.state, 'unreadable');
    match(identity.why, /gone/);
    throws(() => lib.otherWorktreeRoots(moved), /repository identity cannot be read/);
    strictEqual(lib.commandCheckout(moved, repo.main), null, 'the checkout of a lost repository cannot be told');
    strictEqual(lib.gitCommonDir(moved), join(dir, 'gone', '.git'));
    strictEqual(lib.gitCommonDir(moved), runtimeLib.gitCommonDir(moved));
    strictEqual(lib.defaultStateRoot(moved), runtimeLib.defaultStateRoot(moved));
    mkdirSync(join(dir, 'gone', '.git'), { recursive: true });
    strictEqual(lib.gitIdentity(moved).state, 'ok', 'control: the common dir there, the identity reads');
  });

  it('a commondir link that names nothing is a lost identity; readers take it as no commondir, as runtime does', () => {
    const linked = join(dir, 'commondir-link');
    const gitDir = join(dir, 'commondir-link-gitdir');
    mkdirSync(linked, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(linked, '.git'), `gitdir: ${gitDir}\n`);
    symlinkSync(join(dir, 'no-such-commondir'), join(gitDir, 'commondir'));
    const identity = lib.gitIdentity(linked);
    strictEqual(identity.state, 'unreadable');
    match(identity.why, /commondir/);
    throws(() => lib.otherWorktreeRoots(linked), /repository identity cannot be read/);
    strictEqual(lib.gitCommonDir(linked), runtimeLib.gitCommonDir(linked), "the reader's rule, as runtime's copy");
    strictEqual(lib.defaultStateRoot(linked), runtimeLib.defaultStateRoot(linked));
    unlinkSync(join(gitDir, 'commondir'));
    deepStrictEqual(lib.gitIdentity(linked), { state: 'ok', commonDir: gitDir }, 'control: no commondir at all, the git dir is its own');
  });

  it('readFrontmatterText reads through the frontmatter, never a FIFO, never past the close', () => {
    const files = join(dir, 'frontmatter');
    mkdirSync(files, { recursive: true });
    // A frontmatter longer than any one read, whose close straddles a chunk
    // boundary, with a key after the first 256 KiB.
    const pad = 'x'.repeat(300 * 1024);
    const fm = `---\nschema: "1.4"\npad: "${pad}"\nworkflow_id: "late-id"\n---\n`;
    const long = join(files, 'long.md');
    writeFileSync(long, `${fm}${'body\n'.repeat(100_000)}`);
    const text = lib.readFrontmatterText(long);
    strictEqual(text, fm, 'through the close, and no body');
    strictEqual(lib.workflowIdOfText(text), 'late-id');
    for (const cut of [64 * 1024 - 2, 64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1]) {
      const head = `---\nworkflow_id: "cut-${cut}"\npad: "`;
      const doc = `${head}${'y'.repeat(cut - head.length - 6)}"\n---\nbody\n`;
      const at = join(files, `cut-${cut}.md`);
      writeFileSync(at, doc);
      strictEqual(lib.readFrontmatterText(at), doc.slice(0, doc.indexOf('\n---\n', 4) + 5), `close near the boundary (${cut})`);
    }
    const plain = join(files, 'plain.md');
    writeFileSync(plain, `no frontmatter\n${'z'.repeat(200 * 1024)}`);
    ok(lib.readFrontmatterText(plain).length <= 64 * 1024, 'a file that opens none: its first bytes only');
    const open = join(files, 'open.md');
    writeFileSync(open, '---\nworkflow_id: "never-closed"\n');
    strictEqual(lib.readFrontmatterText(open), '---\nworkflow_id: "never-closed"\n', 'never closed: the whole file');
    const fifo = join(files, 'fifo.md');
    execFileSync('mkfifo', [fifo]);
    strictEqual(lib.readFrontmatterText(fifo), null, 'a FIFO is no regular file, and is not waited on');
    throws(() => lib.readFrontmatterText(join(files, 'absent.md')), (error) => error.code === 'ENOENT');
  });

  it('readFrontmatterText reads no body, and joins what it reads about once: linear, never quadratic', () => {
    const files = join(dir, 'frontmatter-cost');
    mkdirSync(files, { recursive: true });
    const fm = `---\npad: "${'x'.repeat(2 * 1024 * 1024)}"\n---\n`;
    const file = join(files, 'big.md');
    writeFileSync(file, `${fm}${'b'.repeat(4 * 1024 * 1024)}`);
    let read = 0;
    let joined = 0;
    const realRead = fs.readSync;
    const realConcat = Buffer.concat;
    fs.readSync = (...args) => {
      const n = realRead(...args);
      read += n;
      return n;
    };
    Buffer.concat = (list, length) => {
      const out = realConcat.call(Buffer, list, length);
      joined += out.length;
      return out;
    };
    let text;
    try {
      text = lib.readFrontmatterText(file);
    } finally {
      fs.readSync = realRead;
      Buffer.concat = realConcat;
    }
    strictEqual(text, fm);
    ok(read > 0 && read <= fm.length + 64 * 1024, `${read} bytes read for a ${fm.length}-byte frontmatter: the body is never read`);
    ok(joined <= 3 * fm.length, `${joined} bytes joined for ${fm.length} read: each about once, not once per chunk`);
  });

  it("runDirectoryEntries: a directory is a run directory, a link never is, as runtime's readers list them", () => {
    const runs = join(dir, 'peer-runs');
    const elsewhere = join(dir, 'elsewhere-run');
    mkdirSync(join(runs, 'r-dir'), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(runs, 'r-link'));
    symlinkSync(join(dir, 'no-such-run'), join(runs, 'r-dangling'));
    writeFileSync(join(runs, 'r-file'), 'x');
    symlinkSync(join(runs, 'r-file'), join(runs, 'r-file-link'));
    deepStrictEqual(lib.runDirectoryEntries(runs).map(({ runId }) => runId), ['r-dir']);
    deepStrictEqual(lib.runDirectoryEntries(join(dir, 'absent-runs')), []);
    // runDirectoryAt, the same rule for one path.
    deepStrictEqual(
      ['r-dir', 'r-link', 'r-dangling', 'r-file', 'r-file-link', 'r-absent'].map((n) => lib.runDirectoryAt(join(runs, n))),
      [true, false, false, false, false, false],
    );
    // ledgersHolding: each physical run directory holding the id, once.
    const other = join(dir, 'peer-runs-other');
    mkdirSync(join(other, 'r-dir'), { recursive: true });
    symlinkSync(runs, join(dir, 'peer-runs-alias'));
    deepStrictEqual(lib.ledgersHolding([runs, join(dir, 'peer-runs-alias')], 'r-dir'), [join(runs, 'r-dir')], 'one directory reached twice');
    deepStrictEqual(lib.ledgersHolding([runs, other], 'r-dir'), [join(runs, 'r-dir'), join(other, 'r-dir')]);
    deepStrictEqual(lib.ledgersHolding([runs], 'r-link'), [], 'a link holds no ledger');
  });

  it('ledgerIdentity: a run directory recreated under its run id, or its handle rewritten with new times, is another ledger', () => {
    const runDir = join(dir, 'identity-runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const handle = { run_id: 'r1', status: 'completed', started_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:01.000Z', completed_at: '2026-10-08T00:00:01.000Z' };
    const planned = lib.ledgerIdentity(runDir, handle);
    strictEqual(lib.ledgerIdentity(runDir, { ...handle }), planned, 'the same ledger');
    strictEqual(lib.ledgerIdentity(runDir, { ...handle, updated_at: '2031-01-01T00:00:00.000Z' }) === planned, false, 'a new time');
    strictEqual(lib.ledgerIdentity(runDir, { ...handle, started_at: '2031-01-01T00:00:00.000Z' }) === planned, false, 'a new start');
    throws(() => lib.ledgerIdentity(join(dir, 'identity-runs', 'gone'), handle), (err) => err.code === 'ENOENT');
  });

  it('a commondir that is a FIFO is a lost identity, read at once, never waited on', { timeout: 30_000 }, () => {
    const checkout = join(dir, 'commondir-fifo');
    const gitDir = join(dir, 'commondir-fifo-gitdir');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(checkout, '.git'), `gitdir: ${gitDir}\n`);
    execFileSync('mkfifo', [join(gitDir, 'commondir')]);
    // In a child process, so a read that waits on the FIFO times out there
    // rather than hanging this one.
    const probe = `const lib = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib/state-root.mjs')).href)}); process.stdout.write(JSON.stringify(lib.gitIdentity(${JSON.stringify(checkout)})));`;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 20_000 });
    strictEqual(ran.error?.code, undefined, 'not waited on');
    const identity = JSON.parse(ran.stdout);
    strictEqual(identity.state, 'unreadable');
    match(identity.why, /not a regular file/);
    rmSync(join(gitDir, 'commondir'));
    mkdirSync(join(gitDir, 'commondir'));
    strictEqual(lib.gitIdentity(checkout).state, 'unreadable', 'a directory there too');
    strictEqual(lib.gitCommonDir(checkout), runtimeLib.gitCommonDir(checkout), "the reader's rule for it, as runtime's copy");
    rmSync(join(gitDir, 'commondir'), { recursive: true });
    deepStrictEqual(lib.gitIdentity(checkout), { state: 'ok', commonDir: realpathSync(gitDir) }, 'control');
  });

  it('the holder of a branch is a working tree: a linked worktree and a main checkout with files are', () => {
    strictEqual(lib.worktreeHoldingBranch(repo.lane, 'main'), repo.main);
    strictEqual(lib.worktreeHoldingBranch(repo.main, 'feat/x'), repo.lane);
  });

  it('a separate git dir named .git: the metadata directory git names is no working tree', () => {
    const base = join(dir, 'sgd');
    mkdirSync(join(base, 'meta'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', join(base, 'meta', '.git'), join(base, 'work')], { env: cleanEnv() });
    const work = realpathSync(join(base, 'work'));
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git(work, 'add', 'a.txt');
    git(work, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'a');
    git(work, 'worktree', 'add', '-q', '-b', 'feat/x', join(base, 'lane'));
    const lane = realpathSync(join(base, 'lane'));
    match(git(lane, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${realpathSync(join(base, 'meta'))}\\n`), 'git names the metadata directory');
    strictEqual(lib.worktreeHoldingBranch(lane, 'main'), null);
    strictEqual(lib.worktreeHoldingBranch(work, 'feat/x'), lane, 'control: the linked worktree is one');
  });

  it('a separate git dir: the git dir git names is no working tree, even holding a .git', () => {
    const base = join(dir, 'sgd2');
    mkdirSync(base, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', join(base, 'repo.git'), join(base, 'work')], { env: cleanEnv() });
    const work = realpathSync(join(base, 'work'));
    git(work, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'a');
    git(work, 'worktree', 'add', '-q', '-b', 'feat/x', join(base, 'lane'));
    const lane = realpathSync(join(base, 'lane'));
    const gitDir = realpathSync(join(base, 'repo.git'));
    writeFileSync(join(gitDir, '.git'), `gitdir: ${gitDir}\n`);
    strictEqual(lib.gitCommonDir(gitDir), gitDir, 'the planted .git reads as this repository');
    strictEqual(lib.worktreeHoldingBranch(lane, 'main'), null);
  });
});

describe('the shared-creation switch and AGENTIC_STATE_BASE (ADR-0067 Decisions 1(a), 2)', () => {
  let dir;
  let repo;
  const switchFile = () => join(repo.main, '.agentic-plugins/state/shared-creation.json');
  const writeSwitch = (value) => {
    mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
    writeFileSync(switchFile(), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const on = { schema: 'agentic-shared-creation-1.0', enabled: true, enabled_at: '2026-10-08T00:00:00Z', versions: {} };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-switch-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('absent switch: off, and a record is created in the checkout, as before', () => {
    rmSync(switchFile(), { force: true });
    strictEqual(lib.readSharedCreation(repo.lane).state, 'off');
    strictEqual(lib.creationRoot(repo.lane, { env: {} }).root, repo.lane);
    strictEqual(lib.creationRoot(repo.main, { env: {} }).root, repo.main);
  });

  it('switch on: creation goes to the default state root, from any checkout', () => {
    writeSwitch(on);
    strictEqual(lib.readSharedCreation(repo.lane).state, 'on');
    strictEqual(lib.creationRoot(repo.lane, { env: {} }).root, repo.main);
    rmSync(switchFile());
  });

  it('an unreadable or malformed switch refuses every creation, never guesses', () => {
    for (const bad of ['{not json', JSON.stringify({ ...on, schema: 'other' }), JSON.stringify({ ...on, enabled: 'yes' }),
      JSON.stringify({ ...on, enabled_at: 'today' }), JSON.stringify([1])]) {
      writeSwitch(bad);
      strictEqual(lib.readSharedCreation(repo.lane).state, 'unreadable', bad);
      throws(() => lib.creationRoot(repo.lane, { env: {} }), (e) => e.code === 'switch-unreadable', bad);
    }
    rmSync(switchFile());
  });

  it('AGENTIC_STATE_BASE naming the checkout keeps creation in it, switch on or off', () => {
    strictEqual(lib.creationRoot(repo.lane, { env: { AGENTIC_STATE_BASE: repo.lane } }).root, repo.lane);
    writeSwitch(on);
    strictEqual(lib.creationRoot(repo.lane, { env: { AGENTIC_STATE_BASE: repo.lane } }).root, repo.lane);
    rmSync(switchFile());
  });

  it('AGENTIC_STATE_BASE naming the default state root: refused while off, allowed once on', () => {
    throws(() => lib.creationRoot(repo.lane, { env: { AGENTIC_STATE_BASE: repo.main } }), (e) => e.code === 'state-base-refused' && /shared creation is off/.test(e.message));
    writeSwitch(on);
    strictEqual(lib.creationRoot(repo.lane, { env: { AGENTIC_STATE_BASE: repo.main } }).root, repo.main);
    rmSync(switchFile());
  });

  it('AGENTIC_STATE_BASE anywhere else, relative or unnormalized fails closed', () => {
    writeSwitch(on);
    const other = join(dir, 'elsewhere');
    mkdirSync(other, { recursive: true });
    for (const value of [other, 'repo', `${repo.lane}/`, `${repo.lane}/../lane`, `${repo.lane}/.`]) {
      throws(() => lib.creationRoot(repo.lane, { env: { AGENTIC_STATE_BASE: value } }), (e) => e.code === 'state-base-refused', value);
    }
    // Another worktree's toplevel is "anywhere else" too.
    throws(() => lib.creationRoot(repo.main, { env: { AGENTIC_STATE_BASE: repo.lane } }), (e) => e.code === 'state-base-refused');
    // Empty is unset.
    strictEqual(lib.creationRoot(repo.lane, { env: { AGENTIC_STATE_BASE: '' } }).root, repo.main);
    rmSync(switchFile());
  });

  it('AGENTIC_STATE_BASE naming a lane (a worktree under <repo>-lanes) is refused', () => {
    const laneDir = join(dir, 'repo-lanes', 'macro-x', 'T1');
    mkdirSync(join(dir, 'repo-lanes', 'macro-x'), { recursive: true });
    git(repo.main, 'worktree', 'add', '-q', '-b', 'feat/t1', laneDir);
    const lane = realpathSync(laneDir);
    throws(() => lib.creationRoot(lane, { env: { AGENTIC_STATE_BASE: lane } }), (e) => e.code === 'state-base-refused' && /names a lane/.test(e.message));
    // Without the variable, a lane's records go where the switch says, never in the lane.
    strictEqual(lib.creationRoot(lane, { env: {} }).root, lane);
    writeSwitch(on);
    strictEqual(lib.creationRoot(lane, { env: {} }).root, repo.main);
    rmSync(switchFile());
  });
});

describe('the main-checkout attestation (ADR-0067 Decision 1(a))', () => {
  let dir;
  let repo;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-attest-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('the main checkout passes all three checks', () => {
    const r = lib.attestationChecks(repo.main);
    deepStrictEqual(r.checks.map((c) => [c.id, c.ok]), [
      ['git-dir-is-common-dir', true], ['toplevel-is-default-state-root', true], ['checked-out-entry-on-disk', true],
    ]);
    strictEqual(r.ok, true);
  });

  it('a linked worktree fails the first two', () => {
    const r = lib.attestationChecks(repo.lane);
    strictEqual(r.checks.find((c) => c.id === 'git-dir-is-common-dir').ok, false);
    strictEqual(r.checks.find((c) => c.id === 'toplevel-is-default-state-root').ok, false);
    strictEqual(r.ok, false);
  });

  it('a checkout whose every checked-out file is missing on disk fails the third', () => {
    const gone = join(dir, 'gone');
    mkdirSync(gone);
    git(gone, 'init', '-q', '-b', 'main');
    writeFileSync(join(gone, 'f.txt'), 'f\n');
    git(gone, 'add', 'f.txt');
    rmSync(join(gone, 'f.txt'));
    const r = lib.attestationChecks(gone);
    strictEqual(r.checks.find((c) => c.id === 'checked-out-entry-on-disk').ok, false);
    strictEqual(r.ok, false);
  });

  it('skip-worktree (S) entries are not counted: a sparse checkout with nothing checked out fails', () => {
    const sparse = join(dir, 'sparse');
    mkdirSync(sparse);
    git(sparse, 'init', '-q', '-b', 'main');
    mkdirSync(join(sparse, 'a'));
    writeFileSync(join(sparse, 'a', 'f.txt'), 'f\n');
    git(sparse, 'add', 'a/f.txt');
    git(sparse, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'f');
    git(sparse, 'update-index', '--skip-worktree', 'a/f.txt');
    // A stray file stands where the skip-worktree entry points: present on
    // disk, but not checked out, so it must not count.
    writeFileSync(join(sparse, 'a', 'f.txt'), 'stray\n');
    strictEqual(git(sparse, 'ls-files', '-t'), 'S a/f.txt');
    const r = lib.attestationChecks(sparse);
    strictEqual(r.checks.find((c) => c.id === 'checked-out-entry-on-disk').ok, false);
  });
});

const stateClis = [
  ...personasFor('scripts/lib/state-root.mjs').map((p) => ({ name: p, cli: join(pluginRoot(p), 'scripts/state.mjs') })),
  { name: 'orchestrator', cli: ORCH_STATE },
];

for (const { name, cli } of stateClis) {
  describe(`${name} state.mjs state-root and shared-creation`, () => {
    let dir;
    let repo;
    const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv(env) });
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-cli-${name}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('state-root from a linked worktree reports the read set and where a record is created', () => {
      const r = run(['state-root', '--repo-root', repo.lane]);
      strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      strictEqual(out.schema, 'agentic-state-root-1.0');
      strictEqual(out.default_state_root, repo.main);
      deepStrictEqual(out.read_set, [repo.main, repo.lane]);
      strictEqual(out.shared_creation.state, 'off');
      strictEqual(out.creation_root, repo.lane);
      strictEqual(out.attestation, null);
    });

    it('state-root reports a refused AGENTIC_STATE_BASE without writing anything', () => {
      const r = run(['state-root', '--repo-root', repo.lane], { AGENTIC_STATE_BASE: repo.main });
      strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      strictEqual(out.creation_root, null);
      match(out.creation_error, /shared creation is off/);
      strictEqual(out.state_base.ok, false);
      ok(!existsSync(join(repo.main, '.agentic-plugins')), 'state-root wrote nothing');
    });

    it('shared-creation --enable refuses outside the main checkout and writes nothing', () => {
      const r = run(['shared-creation', '--repo-root', repo.lane, '--enable', '--versions', '{"claude":{}}']);
      strictEqual(r.status, 1);
      match(r.stderr, /main-checkout checks/);
      ok(!existsSync(join(repo.main, '.agentic-plugins/state/shared-creation.json')));
    });

    it('--enable in the main checkout records the inventory, then the switch; --disable turns it off', () => {
      // One archived and one active record under the default state root.
      const wf = join(repo.main, '.agentic-plugins/state/engineer/workflows');
      const ar = join(repo.main, '.agentic-plugins/state/orchestrator/archive');
      mkdirSync(wf, { recursive: true });
      mkdirSync(ar, { recursive: true });
      writeFileSync(join(wf, 'compose-1.md'), '---\nworkflow_id: "compose-1"\n---\n');
      writeFileSync(join(ar, 'macro-plan-2-20261008T000000Z.md'), '---\nworkflow_id: "macro-plan-2"\n---\n');
      const r = run(['shared-creation', '--repo-root', repo.main, '--enable', '--versions', '{"claude":{"engineer":"9.9.9"}}']);
      strictEqual(r.status, 0, r.stderr);
      const sw = JSON.parse(readFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), 'utf8'));
      strictEqual(sw.enabled, true);
      deepStrictEqual(sw.versions, { claude: { engineer: '9.9.9' } });
      const manifests = readdirSync(join(repo.main, '.agentic-plugins/runs/cutover'));
      strictEqual(manifests.length, 1);
      const manifest = JSON.parse(readFileSync(join(repo.main, '.agentic-plugins/runs/cutover', manifests[0]), 'utf8'));
      deepStrictEqual(manifest.inventory.workflow_ids, ['compose-1', 'macro-plan-2']);
      strictEqual(sw.manifest, `.agentic-plugins/runs/cutover/${manifests[0]}`);
      // Now a linked worktree creates under the default state root.
      const lane = JSON.parse(run(['state-root', '--repo-root', repo.lane]).stdout);
      strictEqual(lane.shared_creation.state, 'on');
      strictEqual(lane.creation_root, repo.main);
      // Enabling again changes nothing.
      const again = run(['shared-creation', '--repo-root', repo.main, '--enable', '--versions', '{}']);
      strictEqual(again.status, 0, again.stderr);
      strictEqual(JSON.parse(again.stdout).changed, false);
      const off = run(['shared-creation', '--repo-root', repo.main, '--disable']);
      strictEqual(off.status, 0, off.stderr);
      strictEqual(JSON.parse(run(['state-root', '--repo-root', repo.lane]).stdout).creation_root, repo.lane);
      rmSync(join(repo.main, '.agentic-plugins'), { recursive: true, force: true });
    });

    it('--disable is refused once lanes have run', () => {
      mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
      const file = join(repo.main, '.agentic-plugins/state/shared-creation.json');
      writeFileSync(file, JSON.stringify({
        schema: 'agentic-shared-creation-1.0', enabled: true, enabled_at: '2026-10-08T00:00:00Z',
        versions: {}, lanes_first_run_at: '2026-10-09T00:00:00Z',
      }));
      const r = run(['shared-creation', '--repo-root', repo.main, '--disable']);
      strictEqual(r.status, 1);
      match(r.stderr, /can no longer be rolled back/);
      strictEqual(JSON.parse(readFileSync(file, 'utf8')).enabled, true);
      rmSync(join(repo.main, '.agentic-plugins'), { recursive: true, force: true });
    });

    it('shared-creation needs exactly one of --enable and --disable', () => {
      for (const args of [[], ['--enable', '--disable']]) {
        const r = run(['shared-creation', '--repo-root', repo.main, ...args, '--versions', '{}']);
        strictEqual(r.status, 1, args.join(' '));
        match(r.stderr, /exactly one of --enable and --disable/i);
      }
    });
  });
}

// U4c — what the second Plan-verify asked of the library: a scan that cannot
// run fails closed, a checkout that cannot be told is no checkout, a copy is
// judged by workflow id, and only a working tree holds a branch.
describe('state-root library: failing closed, identity by workflow id (ADR-0067 Decisions 1, 2, 4)', () => {
  let dir;
  let repo;
  let noGit;
  let failingRevParse;
  const withPath = (value, fn) => {
    const saved = process.env.PATH;
    process.env.PATH = value;
    try {
      return fn();
    } finally {
      process.env.PATH = saved;
    }
  };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-u4c-')));
    repo = makeRepo(dir);
    noGit = join(dir, 'no-git-bin');
    mkdirSync(noGit);
    // A git whose `rev-parse` fails and whose every other command works.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    failingRevParse = join(dir, 'failing-rev-parse-bin');
    mkdirSync(failingRevParse);
    writeFileSync(join(failingRevParse, 'git'), `#!/bin/sh\nif [ "$1" = "rev-parse" ]; then exit 128; fi\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('otherWorktreeRoots fails closed when git cannot list a repository that has linked worktrees', () => {
    strictEqual(lib.otherWorktreeRoots(repo.main).map((r) => realpathSync(r)).join(), repo.lane);
    throws(() => withPath(noGit, () => lib.otherWorktreeRoots(repo.main)), (err) => err.code === 'worktrees-unlisted');
    deepStrictEqual(withPath(noGit, () => lib.otherWorktreeRoots(dir)), [], 'outside a repository there is nothing to list');
  });

  it('commandCheckout: this repository\'s checkout, the storage root for anything else, null when git fails inside it', () => {
    strictEqual(lib.commandCheckout(repo.main, repo.lane), repo.lane);
    strictEqual(lib.commandCheckout(repo.main, dir), repo.main, 'no checkout at all: the storage root, as before');
    strictEqual(withPath(failingRevParse, () => lib.commandCheckout(repo.main, repo.lane)), null, 'a checkout of this repository that git cannot name');
    strictEqual(withPath(failingRevParse, () => lib.commandCheckout(repo.main, dir)), repo.main);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    git(elsewhere, 'init', '-q', '-b', 'main');
    strictEqual(withPath(failingRevParse, () => lib.commandCheckout(repo.main, elsewhere)), repo.main, 'another repository');
  });

  it('worktreeHoldingBranch names a working tree only, never the git dir a separate-git-dir layout lists', () => {
    strictEqual(realpathSync(lib.worktreeHoldingBranch(repo.main, 'feat/x')), repo.lane);
    strictEqual(realpathSync(lib.worktreeHoldingBranch(repo.lane, 'main')), repo.main);
    const sep = join(dir, 'sep');
    mkdirSync(sep);
    git(sep, 'init', '-q', '-b', 'main', `--separate-git-dir=${join(dir, 'sep.git')}`, 'work');
    const work = realpathSync(join(sep, 'work'));
    git(work, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
    // Control: git does name the git dir as the main worktree here.
    ok(git(work, 'worktree', 'list', '--porcelain').split('\n')[0].endsWith('sep.git'));
    strictEqual(lib.worktreeHoldingBranch(work, 'main'), null);
  });

  it('aliasedComponent finds a symbolic link on the way down, and stops at the first absent directory', () => {
    const base = join(dir, 'alias-base');
    mkdirSync(join(base, 'real/inner'), { recursive: true });
    strictEqual(lib.aliasedComponent(base, 'real/inner'), null);
    strictEqual(lib.aliasedComponent(base, 'real/missing/deeper'), null);
    symlinkSync(join(base, 'real'), join(base, 'link'));
    strictEqual(lib.aliasedComponent(base, 'link/inner'), join(base, 'link'));
  });

  it('otherCopiesOf: a copy is the same name or the same workflow id, each physical file once, and an unreadable directory fails closed', () => {
    const a = join(dir, 'copies-a');
    const b = join(dir, 'copies-b');
    mkdirSync(a);
    mkdirSync(b);
    const fm = (id) => `---\nworkflow_id: "${id}"\n---\n`;
    const file = join(a, 'compose-20261008T000000Z-aaaaaa.md');
    writeFileSync(file, fm('compose-20261008T000000Z-aaaaaa'));
    writeFileSync(join(b, 'compose-20261008T000000Z-other0.md'), fm('compose-20261008T000000Z-other0'));
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-aaaaaa', dirs: [a, b] }), []);
    const renamed = join(b, 'compose-20261008T000000Z-renamd.md');
    writeFileSync(renamed, fm('compose-20261008T000000Z-aaaaaa'));
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-aaaaaa', dirs: [a, b] }), [renamed]);
    symlinkSync(b, join(dir, 'copies-b-link'));
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-aaaaaa', dirs: [a, b, join(dir, 'copies-b-link')] }), [renamed], 'once');
    const loop = join(dir, 'copies-loop');
    symlinkSync(loop, loop);
    throws(() => lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-aaaaaa', dirs: [a, loop] }), (err) => err.code === 'scan-failed');
  });

  it('otherCopiesOf: a workflow name that is no regular file fails closed, never waited on', () => {
    const a = join(dir, 'copies-fifo-a');
    const b = join(dir, 'copies-fifo-b');
    mkdirSync(a);
    mkdirSync(b);
    const file = join(a, 'compose-20261008T000000Z-ffffff.md');
    writeFileSync(file, '---\nworkflow_id: "compose-20261008T000000Z-ffffff"\n---\n');
    execFileSync('mkfifo', [join(b, 'compose-20261008T000000Z-f1f0f1.md')]);
    throws(() => lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-ffffff', dirs: [a, b] }), (err) => err.code === 'scan-failed' && /not a regular file/.test(err.message));
    mkdirSync(join(b, 'compose-20261008T000000Z-d1d1d1.md'));
    rmSync(join(b, 'compose-20261008T000000Z-f1f0f1.md'));
    throws(() => lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-ffffff', dirs: [a, b] }), /not a regular file/, 'a directory under a workflow name');
    rmSync(join(b, 'compose-20261008T000000Z-d1d1d1.md'), { recursive: true });
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-ffffff', dirs: [a, b] }), [], 'control');
  });

  it('a workflow name that is a link is the file it names: a link to the record is the record, a link to a copy a copy', () => {
    const a = join(dir, 'copies-link-a');
    const b = join(dir, 'copies-link-b');
    mkdirSync(a);
    mkdirSync(b);
    const file = join(a, 'compose-20261008T000000Z-111111.md');
    writeFileSync(file, '---\nworkflow_id: "compose-20261008T000000Z-111111"\n---\n');
    const link = join(b, 'compose-20261008T000000Z-1a1a1a.md');
    symlinkSync(file, link);
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-111111', dirs: [a, b] }), [], 'the record itself, through a link');
    const copy = join(dir, 'copies-link-copy.md');
    writeFileSync(copy, '---\nworkflow_id: "compose-20261008T000000Z-111111"\n---\n');
    unlinkSync(link);
    symlinkSync(copy, link);
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-111111', dirs: [a, b] }), [link], 'a second file, through a link');
    unlinkSync(link);
    symlinkSync(join(dir, 'nothing-there.md'), link);
    const fifo = join(b, 'compose-20261008T000000Z-f1f0f2.md');
    execFileSync('mkfifo', [fifo]);
    const fifoLink = join(b, 'compose-20261008T000000Z-f1f0f3.md');
    symlinkSync(fifo, fifoLink);
    deepStrictEqual(
      [file, link, join(dir, 'no-such.md'), fifo, fifoLink].map((p) => lib.workflowEntryProblem(p)),
      [null, 'gone', 'gone', 'not a regular file', 'not a regular file'],
    );
  });

  it("a file in a directory's place is no absence: the scans throw, as runtime's readers refuse it", () => {
    const notDir = join(dir, 'enotdir-file');
    writeFileSync(notDir, 'x');
    const file = join(dir, 'enotdir-record.md');
    writeFileSync(file, '---\nworkflow_id: "compose-20261008T000000Z-333333"\n---\n');
    throws(() => lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-333333', dirs: [notDir] }), (err) => err.code === 'scan-failed');
    throws(() => lib.runDirectoryEntries(notDir), (err) => err.code === 'scan-failed');
    throws(() => lib.runDirectoryAt(join(notDir, 'r1')), (err) => err.code === 'scan-failed');
    throws(() => lib.workflowEntryProblem(join(notDir, 'x.md')), (err) => err.code === 'ENOTDIR');
    strictEqual(lib.absentAt(join(dir, 'enotdir-nothing')), true);
    strictEqual(lib.absentAt(notDir), false);
    throws(() => lib.absentAt(join(notDir, 'x')), (err) => err.code === 'scan-failed');
  });

  it('ledgerIdentity: a directory made anew at the same path is another ledger, the same handle notwithstanding', () => {
    const runDir = join(dir, 'identity-anew', 'r1');
    mkdirSync(runDir, { recursive: true });
    const handle = { run_id: 'r1', status: 'completed', started_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:01.000Z', completed_at: '2026-10-08T00:00:01.000Z' };
    const planned = lib.ledgerIdentity(runDir, handle);
    // The original is kept elsewhere, so its inode cannot be handed out again.
    fs.renameSync(runDir, join(dir, 'identity-anew', 'kept'));
    mkdirSync(runDir);
    strictEqual(lib.ledgerIdentity(runDir, { ...handle }) === planned, false);
  });

  it('otherCopiesOf: a name gone between the listing and its read is no copy', () => {
    const a = join(dir, 'copies-gone-a');
    const b = join(dir, 'copies-gone-b');
    mkdirSync(a);
    mkdirSync(b);
    const file = join(a, 'compose-20261008T000000Z-222222.md');
    writeFileSync(file, '---\nworkflow_id: "compose-20261008T000000Z-222222"\n---\n');
    const sameName = join(b, 'compose-20261008T000000Z-222222.md');
    writeFileSync(sameName, '---\nworkflow_id: "compose-20261008T000000Z-222222"\n---\n');
    const realOpen = fs.openSync;
    fs.openSync = function openSync(p, ...rest) {
      if (p === sameName) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return realOpen.call(this, p, ...rest);
    };
    try {
      deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-222222', dirs: [a, b] }), []);
    } finally {
      fs.openSync = realOpen;
    }
    deepStrictEqual(lib.otherCopiesOf({ file, workflowId: 'compose-20261008T000000Z-222222', dirs: [a, b] }), [sameName], 'control');
  });

  it('writerRoots: a directory the caller names that is no checkout of the repository reads every root of it', () => {
    const third = join(dir, 'third');
    git(repo.main, 'worktree', 'add', '-q', '-b', 'feat/w', third);
    const elsewhere = join(dir, 'writer-roots-elsewhere');
    mkdirSync(elsewhere);
    git(elsewhere, 'init', '-q', '-b', 'main');
    const unrelated = join(dir, 'writer-roots-unrelated');
    mkdirSync(unrelated);
    const real = (roots) => roots.map((r) => realpathSync(r));
    const named = (at) => real(lib.runInCommandDirectory(at, () => lib.writerRoots(repo.main)));
    try {
      const every = [repo.main, repo.lane, realpathSync(third)];
      for (const at of [unrelated, join(dir, 'writer-roots-not-there'), elsewhere]) {
        deepStrictEqual(named(at), every, `named ${at}: every root of the repository`);
      }
      deepStrictEqual(named(repo.lane), [repo.main, repo.lane], "a checkout named: the read sets of the record's root and of that checkout");
      deepStrictEqual(named(repo.main), [repo.main]);
      deepStrictEqual(real(lib.writerRoots(repo.main, unrelated)), [repo.main], 'a process outside, naming nothing: the storage root, as before');
    } finally {
      git(repo.main, 'worktree', 'remove', '--force', third);
      git(repo.main, 'branch', '-q', '-D', 'feat/w');
    }
  });
});
