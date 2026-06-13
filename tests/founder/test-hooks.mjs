// plugins/founder/adapters/{claude,codex}/hooks/* unit tests (ADR-0036 PR2).
//
// Covers:
//   - session-start.mjs (both hosts): [founder-active-metadata] marker
//     pair + JSON metadata + canonical '/founder:<verb>' command form
//   - pre-compact.mjs (both hosts): writes last_snapshot.trigger='pre-compact'
//   - graceful no-op when no active workflow on the current branch
//   - graceful no-op on a malformed workflow file (host lifecycle must
//     never crash on hook errors — ADR-0011 §4)
//   - hooks/hooks.json + .codex-plugin manifest expose the hook surface
//     consistently (drift defense between hook files and manifests)
//
// stop.mjs end-to-end coverage (archive gates, orphan sweep) lives in
// tests/founder/test-stop-archive.mjs.
//
// Run via `node --test tests/founder/test-hooks.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/founder');
const HOOKS_CLAUDE = resolve(PLUGIN_ROOT, 'adapters/claude/hooks');
const HOOKS_CODEX = resolve(PLUGIN_ROOT, 'adapters/codex/hooks');
const STATE_MJS = resolve(PLUGIN_ROOT, 'scripts/state.mjs');

const { createWorkflow, readWorkflow } = await import(STATE_MJS);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `founder-hooks-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'i', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

function runHook(scriptPath, { repoRoot, stdinJson = {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', rejectP);
    child.on('close', (code) => {
      resolveP({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.stdin.write(JSON.stringify(stdinJson));
    child.stdin.end();
  });
}

describe('founder session-start.mjs', () => {
  it('emits the founder-active-metadata marker pair with the /founder:<verb> command form', async () => {
    await withTmpRepo('ss-claude', async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'session-start marker test',
      });
      const { code, stdout } = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot });
      strictEqual(code, 0);
      match(stdout, /\[founder-active-metadata\]/);
      match(stdout, /\[\/founder-active-metadata\]/);
      ok(!stdout.includes('[engineer-active-metadata]'),
        'founder hooks must not emit the engineer marker');
      const m = stdout.match(/\[founder-active-metadata\]\s*([\s\S]*?)\s*\[\/founder-active-metadata\]/);
      ok(m, `marker pair must wrap the metadata JSON: ${stdout}`);
      const json = JSON.parse(m[1]);
      match(json.workflow_id, /^investigate-/);
      strictEqual(json.canonical_command, '/founder:investigate');
      ok(typeof json.workflow_path === 'string'
        && json.workflow_path.includes('/.agentic-plugins/state/founder/workflows/'),
        'metadata must point at the canonical founder state home');
    });
  });

  it('Codex adapter emits the same founder marker pair', async () => {
    await withTmpRepo('ss-codex', async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'frame',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'codex session-start marker test',
      });
      const { code, stdout } = await runHook(join(HOOKS_CODEX, 'session-start.mjs'), { repoRoot });
      strictEqual(code, 0);
      match(stdout, /\[founder-active-metadata\]/);
      match(stdout, /\/founder:frame/);
    });
  });

  it('emits empty stdout when no active workflow exists on the current branch', async () => {
    await withTmpRepo('ss-empty', async (repoRoot) => {
      const { code, stdout } = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot });
      strictEqual(code, 0);
      strictEqual(stdout.trim(), '');
    });
  });

  it('gracefully no-ops on a malformed workflow file (host lifecycle must not crash)', async () => {
    await withTmpRepo('ss-malformed', async (repoRoot) => {
      const dir = join(repoRoot, '.agentic-plugins/state/founder/workflows');
      execFileSync('mkdir', ['-p', dir]);
      await writeFile(join(dir, 'investigate-20260101T000000Z-aaaaaa.md'), '---\nbroken yaml: [\n');
      const { code } = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot });
      strictEqual(code, 0);
    });
  });
});

describe('founder pre-compact.mjs', () => {
  it('writes last_snapshot with trigger=pre-compact + host=claude', async () => {
    await withTmpRepo('pc-claude', async (repoRoot) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'pre-compact snapshot test',
      });
      const { code } = await runHook(join(HOOKS_CLAUDE, 'pre-compact.mjs'), { repoRoot });
      strictEqual(code, 0);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot?.trigger, 'pre-compact');
      const lastHistory = frontmatter.host_history.at(-1);
      strictEqual(lastHistory.host, 'claude');
      strictEqual(lastHistory.event, 'snapshot');
    });
  });

  it('Codex adapter writes last_snapshot with host=codex', async () => {
    await withTmpRepo('pc-codex', async (repoRoot) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'codex pre-compact snapshot test',
      });
      const { code } = await runHook(join(HOOKS_CODEX, 'pre-compact.mjs'), { repoRoot });
      strictEqual(code, 0);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot?.trigger, 'pre-compact');
      strictEqual(frontmatter.host_history.at(-1).host, 'codex');
    });
  });

  it('gracefully no-ops when no active workflow exists', async () => {
    await withTmpRepo('pc-empty', async (repoRoot) => {
      const { code } = await runHook(join(HOOKS_CLAUDE, 'pre-compact.mjs'), { repoRoot });
      strictEqual(code, 0);
    });
  });
});

describe('founder hook manifests — drift defense', () => {
  it('hooks/hooks.json wires SessionStart/PreCompact/Stop to the claude adapter scripts', async () => {
    const manifest = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8'));
    const commands = JSON.stringify(manifest);
    for (const script of ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs']) {
      ok(commands.includes(`adapters/claude/hooks/${script}`),
        `hooks/hooks.json must reference adapters/claude/hooks/${script}`);
    }
    ok(!commands.includes('engineer'), 'no engineer paths may leak into founder hooks.json');
  });

  it('adapters/codex/hooks/hooks.json wires the three events to the codex adapter scripts', async () => {
    const manifest = JSON.parse(await readFile(resolve(HOOKS_CODEX, 'hooks.json'), 'utf8'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
    ok(!JSON.stringify(manifest).includes('engineer'),
      'no engineer paths may leak into the codex hooks.json');
  });

  it('.codex-plugin manifest exposes the codex hooks manifest path', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'), 'utf8'),
    );
    strictEqual(manifest.hooks, './adapters/codex/hooks/hooks.json');
  });
});
