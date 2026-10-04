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

import { splitSubcommand, MIGRATE_SUBCOMMANDS, RETIRED_MIGRATE_SUBCOMMANDS } from '../../plugins/runtime/scripts/migrate.mjs';

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
    const { subcommand, explicit, rest } = splitSubcommand(['--repo-root', '/r', 'workflow-storage', '--format', 'json']);
    strictEqual(explicit, true);
    strictEqual(subcommand, 'workflow-storage');
    deepStrictEqual(rest, ['--repo-root', '/r', '--format', 'json']);
  });

  it('the inline --flag=value form does not consume the next element', async () => {
    const { subcommand, explicit, rest } = splitSubcommand(['--repo-root=/r', 'workflow-storage']);
    strictEqual(subcommand, 'workflow-storage');
    strictEqual(explicit, true);
    deepStrictEqual(rest, ['--repo-root=/r']);
  });

  it('bare --help belongs to the dispatcher: the subcommand, and the one ADR-0064 removed', async () => {
    const res = await cli(DISPATCHER, ['--help']);
    strictEqual(res.code, 0, res.stderr);
    const flat = res.stdout.replace(/\s+/g, ' ');
    match(flat, /workflow-storage/);
    match(flat, /legacy-egress-intents was removed with the egress subsystem \(ADR-0064\)/);
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
    // `--repo-root workflow-storage --apply` is indistinguishable from a dropped
    // flag value, and guessing costs a workflow-storage APPLY against a repo
    // root that does not exist. A retired name is a subcommand name too.
    for (const name of ['workflow-storage', 'legacy-egress-intents']) {
      const res = await cli(DISPATCHER, ['--repo-root', name, '--apply']);
      strictEqual(res.code, 1);
      match(res.stderr, new RegExp(`ambiguous: '${name}' is a subcommand name but was read as the value of --repo-root`));
      match(res.stderr, new RegExp(`write --repo-root=${name}`));
    }
  });

  it('the inline form disambiguates it without ceremony', () => {
    const { subcommand, explicit, consumedAsValue } = splitSubcommand(['--repo-root=workflow-storage', '--apply']);
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

describe('runtime:migrate dispatcher — legacy-egress-intents is refused by name (ADR-0064)', () => {
  // The subcommand went with the egress subsystem (ADR-0064 Decision 1). Left
  // unknown, its name would fall through to the default subcommand, so an
  // operator's `legacy-egress-intents --apply` would reach a workflow-storage
  // APPLY. It is refused by name instead, before any migration code runs.
  for (const extra of [[], ['--apply'], ['--root', '/tmp', '--format', 'json']]) {
    it(`legacy-egress-intents ${extra.join(' ')} exits 1 and runs nothing`.trim(), async () => {
      const root = await seedLegacyOnlyRepo();
      const before = await treeDigest(root);
      const res = await cli(DISPATCHER, ['--repo-root', root, 'legacy-egress-intents', ...extra]);
      strictEqual(res.code, 1);
      match(res.stderr, /legacy-egress-intents was removed by ADR-0064 with the egress subsystem it served/);
      strictEqual(res.stdout, '', 'no report was produced');
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

  it('rejected argv is defused before it reaches stderr', async () => {
    // stderr is outside any report's defuser and just as forgeable: a flag
    // carrying a newline and an escape forges an operator line there.
    const hostile = `--evil${String.fromCharCode(27)}[31m\n>>> forged instruction`;
    const res = await cli(DISPATCHER, [hostile]);
    strictEqual(res.code, 1);
    strictEqual(res.stderr.includes(String.fromCharCode(27)), false, 'a raw escape reached stderr');
    strictEqual(
      res.stderr.split('\n').some((l) => l.startsWith('>>> forged instruction')),
      false,
      'a forged line reached stderr',
    );
    match(res.stderr, /unknown argument/);
  });

  it('the subcommand lists are closed', () => {
    deepStrictEqual([...MIGRATE_SUBCOMMANDS], ['workflow-storage']);
    deepStrictEqual(Object.keys(RETIRED_MIGRATE_SUBCOMMANDS), ['legacy-egress-intents']);
    const { subcommand, explicit } = splitSubcommand(['not-a-subcommand']);
    strictEqual(explicit, false);
    strictEqual(subcommand, 'workflow-storage');
  });
});
