// plugins/orchestrator/scripts/discover-engineer.mjs unit tests
// (ADR-0019 PR-D — engineer plugin root resolver mirroring
// plugins/engineer/scripts/parent-writeback.mjs's discover-orchestrator).
//
// Scope:
//   - discoverEngineerPluginRoot — env override → Claude cache
//     (SemVer) → Codex cache (fixed) → sibling fallback (via
//     fileURLToPath(import.meta.url)).
//   - preflightEngineerCapability — feature-probe via
//     `state.mjs create --help` to detect ADR-0019 PR-A's
//     `--parent-workflow` flag. Pre-PR-A installs lack the flag and
//     must be rejected before /orchestrator:next dispatches.
//
// Run via `node --test tests/orchestrator/test-discover-engineer.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ENGINEER_ROOT = resolve(REPO_ROOT, 'plugins/engineer');
const DISCOVER_PATH = resolve(
  REPO_ROOT,
  'plugins/orchestrator/scripts/discover-engineer.mjs',
);

const { discoverEngineerPluginRoot, preflightEngineerCapability } =
  await import(DISCOVER_PATH);

// -----------------------------------------------------------------------------
// Test fixture helpers

async function withTmpHomeAndRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'discover-engineer-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeEngineerLayout(root, { name, version, statePayload } = {}) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: name ?? 'engineer', version: version ?? '1.0.0' }),
  );
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'scripts', 'state.mjs'),
    statePayload ?? '// engineer state stub\n',
  );
}

// Place a fake orchestrator plugin file at <dir>/plugins/orchestrator/scripts/discover-engineer.mjs
// so the sibling fallback (`fileURLToPath(import.meta.url)` → `<root>/scripts/discover-engineer.mjs`
// → resolve('../../engineer')`) computes <dir>/plugins/engineer as the
// engineer sibling.
function fakeOrchestratorSelfUrl(tmpDir) {
  const path = join(tmpDir, 'plugins', 'orchestrator', 'scripts', 'discover-engineer.mjs');
  return `file://${path}`;
}

// -----------------------------------------------------------------------------
// discoverEngineerPluginRoot

describe('discoverEngineerPluginRoot — env override', () => {
  it('AGENTIC_ENGINEER_ROOT env override returns that path when scripts/state.mjs exists', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const override = join(dir, 'custom-eng');
      await writeEngineerLayout(override, { version: '9.9.9' });
      const result = await discoverEngineerPluginRoot({
        env: { AGENTIC_ENGINEER_ROOT: override },
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, override);
    });
  });

  it('AGENTIC_ENGINEER_ROOT env override returns null when scripts/state.mjs missing', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const override = join(dir, 'bogus-eng');
      await mkdir(override, { recursive: true });
      const result = await discoverEngineerPluginRoot({
        env: { AGENTIC_ENGINEER_ROOT: override },
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });

  it('AGENTIC_ENGINEER_ROOT env override returns null for relative path', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const result = await discoverEngineerPluginRoot({
        env: { AGENTIC_ENGINEER_ROOT: 'plugins/engineer' },
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });
});

describe('discoverEngineerPluginRoot — Claude cache layout (multi-version SemVer)', () => {
  it('selects latest SemVer when multiple cached versions exist', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const base = join(dir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer');
      const v090 = join(base, '0.9.0');
      const v110 = join(base, '1.1.0');
      const v101 = join(base, '1.0.1');
      await writeEngineerLayout(v090, { version: '0.9.0' });
      await writeEngineerLayout(v110, { version: '1.1.0' });
      await writeEngineerLayout(v101, { version: '1.0.1' });
      const result = await discoverEngineerPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, v110);
    });
  });

  it('skips directories whose plugin.json name is not engineer', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const base = join(dir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer');
      const v100 = join(base, '1.0.0');
      await writeEngineerLayout(v100, { name: 'something-else', version: '1.0.0' });
      const result = await discoverEngineerPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });
});

describe('discoverEngineerPluginRoot — Codex cache layout (single fixed path)', () => {
  it('returns the Codex cache path when scripts/state.mjs exists', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const codexBase = join(
        dir, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'engineer',
      );
      await writeEngineerLayout(codexBase, { version: '1.0.0' });
      const result = await discoverEngineerPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, codexBase);
    });
  });
});

describe('discoverEngineerPluginRoot — sibling fallback (orchestrator plugin root → ../engineer)', () => {
  it('returns the sibling engineer under the orchestrator plugin root derived from selfUrl', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const engineer = join(dir, 'plugins', 'engineer');
      await writeEngineerLayout(engineer, { version: '1.0.0' });
      const result = await discoverEngineerPluginRoot({
        env: {},
        home: join(dir, 'home'),
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, engineer);
    });
  });

  it('returns null when sibling has no scripts/state.mjs', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const result = await discoverEngineerPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeOrchestratorSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });

  it('does NOT use caller user-project paths as a search root (Codex P2 regression guard)', async () => {
    // Builds a "user project" tree at <dir>/userproject/plugins/engineer/.
    // The sibling fallback must IGNORE this tree — discovery should fail
    // (return null) rather than execute an unrelated state.mjs. Mirrors
    // the same guard tested for PR-C's discoverOrchestratorPluginRoot.
    await withTmpHomeAndRepo(async (dir) => {
      const userEngineer = join(dir, 'userproject', 'plugins', 'engineer');
      await writeEngineerLayout(userEngineer, { version: '999.0.0' });
      const isolatedSelfUrl = `file://${join(dir, 'unrelated-location', 'discover-engineer.mjs')}`;
      const result = await discoverEngineerPluginRoot({
        env: {},
        home: join(dir, 'home'),
        selfUrl: isolatedSelfUrl,
      });
      strictEqual(result, null,
        'discovery must not leak into user-project plugin trees');
    });
  });

  it('uses the real monorepo engineer when invoked with REPO_ROOT (smoke)', async () => {
    const result = await discoverEngineerPluginRoot({
      env: {},
      home: '/nonexistent-home-xyz',
      selfUrl: `file://${resolve(REPO_ROOT, 'plugins/orchestrator/scripts/discover-engineer.mjs')}`,
    });
    strictEqual(result, ENGINEER_ROOT);
  });
});

// -----------------------------------------------------------------------------
// preflightEngineerCapability — feature-probe for --parent-workflow

describe('preflightEngineerCapability — PR-A flag detection', () => {
  it('returns ok=true when scripts/state.mjs help text mentions --parent-workflow', async () => {
    // Real monorepo engineer install — already includes PR-A flag.
    const result = await preflightEngineerCapability(ENGINEER_ROOT);
    strictEqual(result.ok, true, `expected ok=true; got reason=${result.reason}`);
  });

  it('returns ok=false for pre-PR-A engineer (no --parent-workflow in --help)', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const fakeRoot = join(dir, 'fake-engineer');
      await writeEngineerLayout(fakeRoot, {
        version: '0.0.1',
        statePayload:
          `#!/usr/bin/env node\n` +
          `if (process.argv.includes('--help') || process.argv.includes('-h')) {\n` +
          `  process.stdout.write('legacy engineer state.mjs\\n  create --repo-root <path>\\n');\n` +
          `  process.exit(0);\n` +
          `}\n` +
          `process.exit(0);\n`,
      });
      await chmod(join(fakeRoot, 'scripts', 'state.mjs'), 0o755);
      const result = await preflightEngineerCapability(fakeRoot);
      strictEqual(result.ok, false);
      match(result.reason, /parent-workflow/);
    });
  });

  it('returns ok=false when scripts/state.mjs exits non-zero', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const fakeRoot = join(dir, 'broken-engineer');
      await writeEngineerLayout(fakeRoot, {
        statePayload: `#!/usr/bin/env node\nprocess.exit(1);\n`,
      });
      await chmod(join(fakeRoot, 'scripts', 'state.mjs'), 0o755);
      const result = await preflightEngineerCapability(fakeRoot);
      strictEqual(result.ok, false);
      match(result.reason, /preflight-failed|exit/i);
    });
  });

  it('returns ok=false when root is null / invalid', async () => {
    const result = await preflightEngineerCapability(null);
    strictEqual(result.ok, false);
  });

  // -----------------------------------------------------------------------------
  // ADR-0019 PR-E extension — preflight also probes for the two new
  // engineer CLI subcommands (detach-archive + stop-archive) that
  // orchestrator /finalize·/abort step 2 invokes. A real (PR-E or later)
  // engineer install ships both; a PR-A-only install (after-PR-A,
  // before-PR-E) ships --parent-workflow and AGENTIC_PARENT_WORKFLOW
  // but NOT the two new subcommands, so dispatch must abort cleanly.

  it('returns ok=true when engineer state.mjs ships detach-archive + stop-archive subcommands (PR-E or later)', async () => {
    // Real monorepo engineer install — PR-E ships both subcommands.
    const result = await preflightEngineerCapability(ENGINEER_ROOT);
    strictEqual(result.ok, true, `expected ok=true; got reason=${result.reason}`);
  });

  it('returns ok=false when engineer state.mjs lacks the detach-archive subcommand', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const fakeRoot = join(dir, 'pr-a-only-engineer');
      // Include `--parent-workflow` (PR-A) and AGENTIC_PARENT_WORKFLOW
      // command-file reference (PR-D) so prior preflight gates pass,
      // but DON'T include `'detach-archive'` or `'stop-archive'` tokens.
      // String concatenation prevents the literal tokens from appearing
      // verbatim in the source bytes that preflight greps.
      await writeEngineerLayout(fakeRoot, {
        version: '0.5.0',
        statePayload:
          "#!/usr/bin/env node\n"
          + "// PR-A gate marker: --parent-workflow flag\n"
          + "if (process.argv.includes('--help')) process.stdout.write('legacy engineer\\n');\n"
          + "process.exit(0);\n",
      });
      // PR-D Phase 0 env-var probe needs commands/investigate.md with
      // 'AGENTIC_PARENT_WORKFLOW' token.
      await mkdir(join(fakeRoot, 'commands'), { recursive: true });
      await writeFile(
        join(fakeRoot, 'commands', 'investigate.md'),
        '# investigate\nAGENTIC_PARENT_WORKFLOW reading boilerplate\n',
      );
      await chmod(join(fakeRoot, 'scripts', 'state.mjs'), 0o755);
      const result = await preflightEngineerCapability(fakeRoot);
      strictEqual(result.ok, false);
      match(result.reason, /detach-archive|stop-archive|PR-E/i);
    });
  });

  it('returns ok=false when engineer state.mjs has detach-archive but lacks stop-archive', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const fakeRoot = join(dir, 'partial-pr-e-engineer');
      // Quoted 'detach-archive' present so the first PR-E gate passes;
      // 'stop-archive' deliberately omitted (the surrounding comments
      // never use the literal so the source-grep does NOT match).
      const detachToken = "'detach-" + "archive'"; // assemble at runtime to avoid the source bytes carrying the quoted literal in this test file too
      await writeEngineerLayout(fakeRoot, {
        version: '0.6.0',
        statePayload:
          "#!/usr/bin/env node\n"
          + "// PR-A gate marker: --parent-workflow flag\n"
          + `case ${detachToken}: process.exit(0);\n`
          + "if (process.argv.includes('--help')) process.stdout.write('partial pr-e engineer\\n');\n"
          + "process.exit(0);\n",
      });
      await mkdir(join(fakeRoot, 'commands'), { recursive: true });
      await writeFile(
        join(fakeRoot, 'commands', 'investigate.md'),
        '# investigate\nAGENTIC_PARENT_WORKFLOW reading boilerplate\n',
      );
      await chmod(join(fakeRoot, 'scripts', 'state.mjs'), 0o755);
      const result = await preflightEngineerCapability(fakeRoot);
      strictEqual(result.ok, false);
      match(result.reason, /stop-archive|PR-E/i);
    });
  });
});
