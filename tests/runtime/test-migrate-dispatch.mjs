// Tests for the `runtime:migrate` dispatcher (`scripts/migrate.mjs`).
//
// COMPATIBILITY FIRST, deliberately. The workflow-storage CLI shipped before
// this dispatcher existed, and `commands/migrate.md` invokes it with
// `--repo-root` placed BEFORE `$ARGUMENTS`. A dispatcher written in the shape
// `retention.mjs` uses — `command = argv.shift()` — would read `--repo-root` as
// the subcommand and break every invocation, so the old surface is pinned here
// before anything about the new one is asserted.
//
// These run the CLIs as real SUBPROCESSES. Exit codes and the entry-point guard
// are the contract under test, and neither is observable from an in-process
// import of the module's exported functions.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { splitSubcommand, parseDiscoveryArgs, MIGRATE_SUBCOMMANDS } from '../../plugins/runtime/scripts/migrate.mjs';
import { EGRESS_INTENT_DIR_SUFFIX } from '../../plugins/runtime/scripts/lib/egress-intent-wal.mjs';

const run = promisify(execFile);
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'runtime', 'scripts');
const DISPATCHER = join(SCRIPTS, 'migrate.mjs');
const LEGACY_ENTRY = join(SCRIPTS, 'migrate-workflow-storage.mjs');

async function cli(script, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function writeWorkflow(path, branch) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    '---',
    'schema: "1.0"',
    'workflow_id: "workflow-test"',
    'current_phase: "compose"',
    'git_baseline:',
    `  branch: "${branch}"`,
    '---',
    '',
    '# Workflow',
    '',
  ].join('\n'), 'utf8');
}

// A repo whose apply is BLOCKED: one active workflow on a branch in the LEGACY
// home and another on the SAME branch in the canonical one is
// `ambiguous_active_workflows`.
async function seedBlockedRepo() {
  const root = await mkdtemp(join(tmpdir(), 'migrate-blocked-'));
  await writeWorkflow(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'), 'feat/shared');
  await writeWorkflow(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260514T000001Z-bbbbbb.md'), 'feat/shared');
  return root;
}

// A repo with LEGACY state only and no `.agentic-plugins` directory at all, so
// "no migration manifest was written" is an observable assertion.
async function seedLegacyOnlyRepo() {
  const root = await mkdtemp(join(tmpdir(), 'migrate-legacy-only-'));
  await writeWorkflow(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'), 'feat/x');
  return root;
}

// A stable digest of every file under `root`, so "byte-identical afterwards" is
// asserted rather than assumed.
async function treeDigest(root) {
  const hash = createHash('sha256');
  const walk = async (dir, rel) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const key = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`D:${key}\n`);
        await walk(abs, key);
      } else {
        hash.update(`F:${key}:`);
        hash.update(await readFile(abs));
        hash.update('\n');
      }
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

describe('runtime:migrate dispatcher — workflow-storage compatibility', () => {
  it('the wrapper argv order (--repo-root FIRST, no subcommand) routes to workflow-storage', async () => {
    // This is THE regression. `commands/migrate.md` emits exactly this shape,
    // and a shift-based dispatcher reads `--repo-root` as the subcommand.
    const root = await mkdtemp(join(tmpdir(), 'migrate-default-'));
    const res = await cli(DISPATCHER, ['--repo-root', root, '--format', 'json']);
    strictEqual(res.code, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    strictEqual(report.schema_version, 'workflow-storage-migration-1.0');
    strictEqual(report.repo_root, root);
  });

  it('a --repo-root VALUE that happens to be named like a subcommand is not eaten', async () => {
    // `--repo-root workflow-storage` must keep the directory as the repo root
    // and still default the subcommand. A naive "first known name wins" search
    // loses the repo root silently.
    const { subcommand, explicit, rest } = splitSubcommand(['--repo-root', 'workflow-storage', '--format', 'json']);
    strictEqual(explicit, false);
    strictEqual(subcommand, 'workflow-storage');
    deepStrictEqual(rest, ['--repo-root', 'workflow-storage', '--format', 'json']);
  });

  it('an explicit subcommand AFTER the pre-placed flag is honored', async () => {
    const { subcommand, explicit, rest } = splitSubcommand(['--repo-root', '/r', 'legacy-egress-intents', '--format', 'json']);
    strictEqual(explicit, true);
    strictEqual(subcommand, 'legacy-egress-intents');
    deepStrictEqual(rest, ['--repo-root', '/r', '--format', 'json']);
  });

  it('the inline --flag=value form does not consume the next element', async () => {
    const { subcommand, rest } = splitSubcommand(['--repo-root=/r', 'legacy-egress-intents']);
    strictEqual(subcommand, 'legacy-egress-intents');
    deepStrictEqual(rest, ['--repo-root=/r']);
  });

  it('bare --help describes BOTH subcommands, not just the default one', async () => {
    // The first cut routed a subcommand-less `--help` to workflow-storage, so an
    // operator asking what this command does was never told the read-only
    // discovery subcommand exists.
    const res = await cli(DISPATCHER, ['--help']);
    strictEqual(res.code, 0, res.stderr);
    const flat = res.stdout.replace(/\s+/g, ' ');
    match(flat, /workflow-storage/);
    match(flat, /legacy-egress-intents/);
    match(flat, /--apply moves legacy \.claude\/agentic-\* workflow state/);
  });

  it('an explicit subcommand --help still routes to that subcommand', async () => {
    const res = await cli(DISPATCHER, ['workflow-storage', '--help']);
    strictEqual(res.code, 0, res.stderr);
    match(res.stdout.replace(/\s+/g, ' '), /Usage: migrate\.mjs \[workflow-storage\]/);
  });

  it('the direct entry point prints ITS OWN name in usage, not the dispatcher’s', async () => {
    // A compatibility regression the refactor introduced: `--help` on the direct
    // script told the operator to run a different file.
    const res = await cli(LEGACY_ENTRY, ['--help']);
    strictEqual(res.code, 0, res.stderr);
    match(res.stdout, /Usage: migrate-workflow-storage\.mjs/);
  });

  it('a subcommand name eaten as a flag value is REFUSED, not silently defaulted', async () => {
    // `--repo-root legacy-egress-intents --apply` is indistinguishable from a
    // dropped flag value, and guessing costs a workflow-storage APPLY against a
    // repo root that does not exist.
    const res = await cli(DISPATCHER, ['--repo-root', 'legacy-egress-intents', '--apply']);
    strictEqual(res.code, 1);
    match(res.stderr, /ambiguous: 'legacy-egress-intents' is a subcommand name but was read as the value of --repo-root/);
    match(res.stderr, /write --repo-root=legacy-egress-intents/);
  });

  it('the inline form disambiguates it without ceremony', () => {
    const { subcommand, explicit, consumedAsValue } = splitSubcommand(['--repo-root=legacy-egress-intents', '--apply']);
    strictEqual(subcommand, 'workflow-storage');
    strictEqual(explicit, false);
    deepStrictEqual(consumedAsValue, [], 'the inline form consumes no following element');
  });

  it('a blocked --apply exits 1 through the dispatcher', async () => {
    const root = await seedBlockedRepo();
    const res = await cli(DISPATCHER, ['--repo-root', root, '--plugin', 'engineer', '--apply', '--format', 'json']);
    strictEqual(res.code, 1);
    const report = JSON.parse(res.stdout);
    strictEqual(report.overall.status, 'blocked');
  });

  it('the same blocked --apply exits 1 through the OLD direct entry point too', async () => {
    const root = await seedBlockedRepo();
    const res = await cli(LEGACY_ENTRY, ['--repo-root', root, '--plugin', 'engineer', '--apply', '--format', 'json']);
    strictEqual(res.code, 1);
    strictEqual(JSON.parse(res.stdout).overall.status, 'blocked');
  });

  it('dispatcher and direct entry point produce the same report for the same argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'migrate-parity-'));
    const argv = ['--repo-root', root, '--format', 'json'];
    const viaDispatcher = JSON.parse((await cli(DISPATCHER, argv)).stdout);
    const viaDirect = JSON.parse((await cli(LEGACY_ENTRY, argv)).stdout);
    // `generated_at` is a timestamp; everything else must agree.
    delete viaDispatcher.generated_at;
    delete viaDirect.generated_at;
    deepStrictEqual(viaDispatcher, viaDirect);
  });

  it('an unknown flag is rejected with the workflow-storage usage, exit 1', async () => {
    const res = await cli(DISPATCHER, ['--repo-root', '/tmp', '--nope']);
    strictEqual(res.code, 1);
    match(res.stderr, /unknown argument: --nope/);
    match(res.stderr.replace(/\s+/g, ' '), /--apply moves legacy/);
  });
});

describe('runtime:migrate dispatcher — legacy-egress-intents is read-only', () => {
  for (const flag of ['--apply', '--plugin']) {
    it(`${flag} exits nonzero BEFORE any workflow migration code runs`, async () => {
      const root = await seedLegacyOnlyRepo();
      const before = await treeDigest(root);
      // `--root root` and a tiny budget are scoping, not part of the property:
      // the refusal must happen during PARSING, so no scan should start at all.
      // They exist so that when this refusal is mutated away the fallback run is
      // a millisecond scan of an empty temp dir rather than a 120s walk of the
      // real `$HOME` — measured at 121s before they were added.
      const scoping = ['--root', root, '--time-budget-ms', '50'];
      const args = flag === '--plugin'
        ? ['--repo-root', root, 'legacy-egress-intents', ...scoping, '--plugin', 'engineer']
        : ['--repo-root', root, 'legacy-egress-intents', ...scoping, '--apply'];
      const res = await cli(DISPATCHER, args);
      strictEqual(res.code, 1);
      match(res.stderr, new RegExp(`${flag} is not accepted by legacy-egress-intents`));
      // Nothing moved, and no migration manifest was written.
      strictEqual(await treeDigest(root), before, 'the seeded workflow tree changed');
      const entries = await readdir(root);
      strictEqual(entries.includes('.agentic-plugins'), false, 'a migration manifest was created');
    });
  }

  it('CONTROL — the SAME seeded tree IS mutated by a real workflow-storage apply', async () => {
    // Without this the assertion above could be green because the fixture was
    // never mutable in the first place. Here the apply is unblocked, so the
    // tree provably changes — which is what makes the refusal meaningful.
    const root = await seedLegacyOnlyRepo();
    const before = await treeDigest(root);
    const res = await cli(DISPATCHER, ['--repo-root', root, '--plugin', 'engineer', '--apply', '--format', 'json']);
    strictEqual(res.code, 0, res.stderr);
    ok(await treeDigest(root) !== before, 'the control fixture must actually be mutable');
  });

  it('a read-only discovery run writes nothing under the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'migrate-ro-repo-'));
    const scanRoot = await mkdtemp(join(tmpdir(), 'migrate-ro-scan-'));
    await mkdir(join(scanRoot, 'checkout', ...EGRESS_INTENT_DIR_SUFFIX), { recursive: true });
    await writeFile(join(scanRoot, 'checkout', ...EGRESS_INTENT_DIR_SUFFIX, 'a.json'), '{}');
    await writeFile(join(repo, 'sentinel'), 'x');
    const before = await treeDigest(repo);
    const scanBefore = await treeDigest(scanRoot);

    const res = await cli(DISPATCHER, ['--repo-root', repo, 'legacy-egress-intents', '--root', scanRoot, '--format', 'json']);
    strictEqual(res.code, 2, 'findings present → exit 2');
    strictEqual(JSON.parse(res.stdout).findings.length, 1);
    strictEqual(await treeDigest(repo), before, 'the repo root was written to');
    strictEqual(await treeDigest(scanRoot), scanBefore, 'the scanned tree was written to');
  });

  it('exit codes: 0 when nothing is found, 2 with findings, 1 when incomplete', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'migrate-exit-empty-'));
    strictEqual((await cli(DISPATCHER, ['legacy-egress-intents', '--root', empty])).code, 0);

    // The directory must hold a RECORD. An empty legacy directory is reported
    // but is not actionable — there is nothing in flight and directory-level
    // action is forbidden — so it no longer drives exit 2.
    const withFinding = await mkdtemp(join(tmpdir(), 'migrate-exit-find-'));
    await mkdir(join(withFinding, 'c', ...EGRESS_INTENT_DIR_SUFFIX), { recursive: true });
    await writeFile(join(withFinding, 'c', ...EGRESS_INTENT_DIR_SUFFIX, 'a.json'), '{}');
    strictEqual((await cli(DISPATCHER, ['legacy-egress-intents', '--root', withFinding])).code, 2);

    const emptyLegacyDir = await mkdtemp(join(tmpdir(), 'migrate-exit-empty-wal-'));
    await mkdir(join(emptyLegacyDir, 'c', ...EGRESS_INTENT_DIR_SUFFIX), { recursive: true });
    strictEqual((await cli(DISPATCHER, ['legacy-egress-intents', '--root', emptyLegacyDir])).code, 0,
      'an emptied legacy directory converges rather than being reported as actionable forever');

    strictEqual((await cli(DISPATCHER, ['legacy-egress-intents', '--root', '/definitely/not/here'])).code, 1);
  });

  it('--root / is refused rather than capped into a permanently incomplete scan', async () => {
    const res = await cli(DISPATCHER, ['legacy-egress-intents', '--root', '/']);
    strictEqual(res.code, 1);
    match(res.stderr, /--root \/ is refused/);
  });

  it('numeric flags reject non-integers, unsafe integers, and out-of-range values', () => {
    const rejected = [
      [['--max-depth', 'deep'], /must be a non-negative integer/],
      [['--time-budget-ms', '-5'], /must be a non-negative integer/],
      [['--time-budget-ms', '1.5'], /must be a non-negative integer/],
      // A 20-digit run of ASCII digits passes `/^\d+$/` and lands outside the
      // safe-integer range, where comparisons stop meaning what they read as.
      [['--time-budget-ms', '99999999999999999999'], /too large to be represented exactly/],
      [['--max-depth', '99999999999999999999'], /too large to be represented exactly/],
      // …and inside the safe range there is still an upper bound.
      [['--max-depth', '9007199254740991'], /must be at most/],
      [['--time-budget-ms', '9007199254740991'], /must be at most/],
      [['--time-budget-ms', '0'], /must be at least 1/],
    ];
    for (const [argv, expected] of rejected) {
      let threw = null;
      try { parseDiscoveryArgs(argv); } catch (err) { threw = err; }
      ok(threw, `${argv.join(' ')} was accepted`);
      match(threw.message, expected, `${argv.join(' ')} produced: ${threw.message}`);
    }
    // CONTROL — ordinary values still pass.
    strictEqual(parseDiscoveryArgs(['--max-depth', '3']).maxDepth, 3);
    strictEqual(parseDiscoveryArgs(['--time-budget-ms', '5000']).timeBudgetMs, 5000);
  });

  it('the subcommand list is closed', () => {
    deepStrictEqual([...MIGRATE_SUBCOMMANDS], ['workflow-storage', 'legacy-egress-intents']);
    const { subcommand, explicit } = splitSubcommand(['not-a-subcommand']);
    strictEqual(explicit, false);
    strictEqual(subcommand, 'workflow-storage');
  });
});
