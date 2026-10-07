// plugins/<persona>/adapters/{claude,codex}/hooks/* unit tests, run once for
// every persona whose hooks these cases can drive (ADR-0066 Decision 5).
//
// The hook files are generated into every persona, but these cases drive the
// hooks through the persona's own state.mjs (and, inside the hooks,
// session-handoff.mjs / stop-archive.mjs), which the pipeline generates only
// into the personas enrolled for scripts/state.mjs. So the cases run over
// personasFor('scripts/state.mjs'); engineer's hooks are covered by
// tests/engineer.
//
// Covers:
//   - session-start.mjs (both hosts): [<persona>-active-metadata] marker
//     pair + JSON metadata + canonical '/<persona>:<verb>' command form
//   - pre-compact.mjs (both hosts): writes last_snapshot.trigger='pre-compact'
//   - graceful no-op when no active workflow on the current branch
//   - graceful no-op on a malformed workflow file (host lifecycle must
//     never crash on hook errors — ADR-0011 §4)
//   - hooks/hooks.json + .codex-plugin manifest expose the hook surface
//     consistently (drift defense between hook files and manifests)
//
// stop.mjs end-to-end coverage (archive gates, orphan sweep) lives in
// tests/persona-pipeline/test-stop-archive.mjs.
//
// Run via `node --test tests/persona-pipeline/test-hooks.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo, MANIFEST } from './_personas.mjs';

const PERSONAS = personasFor('scripts/state.mjs');

// Import every persona's generated state.mjs before any suite is declared, so
// the suites below are registered synchronously.
const STATE_MODULES = new Map();
for (const persona of PERSONAS) {
  const P = personaInfo(persona);
  STATE_MODULES.set(persona, await import(pathToFileURL(P.path('scripts/state.mjs')).href));
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

for (const persona of PERSONAS) {
  const P = personaInfo(persona);
  const HOOKS_CLAUDE = P.path('adapters/claude/hooks');
  const HOOKS_CODEX = P.path('adapters/codex/hooks');
  // Every other persona the pipeline knows: none of their names may leak
  // into this persona's hook output or hook manifests (engineer included).
  const OTHER_PERSONAS = MANIFEST.personas.filter((p) => p !== persona);

  const { createWorkflow, readWorkflow } = STATE_MODULES.get(persona);

  async function withTmpRepo(name, fn) {
    const dir = await mkdtemp(join(tmpdir(), `${persona}-hooks-${name}-`));
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

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const OPEN_TAG = `[${P.metadataTag}]`;
  const CLOSE_TAG = `[/${P.metadataTag}]`;

  describe(`${persona}: session-start.mjs`, () => {
    it(`emits the ${P.metadataTag} marker pair with the ${P.commandPrefix}<verb> command form`, async () => {
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
        match(stdout, new RegExp(escapeRe(OPEN_TAG)));
        match(stdout, new RegExp(escapeRe(CLOSE_TAG)));
        for (const other of OTHER_PERSONAS) {
          ok(!stdout.includes(`[${other}-active-metadata]`),
            `${persona} hooks must not emit the ${other} marker`);
        }
        const m = stdout.match(
          new RegExp(`${escapeRe(OPEN_TAG)}\\s*([\\s\\S]*?)\\s*${escapeRe(CLOSE_TAG)}`),
        );
        ok(m, `marker pair must wrap the metadata JSON: ${stdout}`);
        const json = JSON.parse(m[1]);
        match(json.workflow_id, /^investigate-/);
        strictEqual(json.canonical_command, `${P.commandPrefix}investigate`);
        ok(typeof json.workflow_path === 'string'
          && json.workflow_path.includes(`/${P.workflowDirRel}/`),
          `metadata must point at the canonical ${persona} state home`);
      });
    });

    it(`Codex adapter emits the same ${persona} marker pair`, async () => {
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
        match(stdout, new RegExp(escapeRe(OPEN_TAG)));
        match(stdout, new RegExp(escapeRe(`${P.commandPrefix}frame`)));
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
        const dir = join(repoRoot, P.workflowDirRel);
        execFileSync('mkdir', ['-p', dir]);
        await writeFile(join(dir, 'investigate-20260101T000000Z-aaaaaa.md'), '---\nbroken yaml: [\n');
        const { code } = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot });
        strictEqual(code, 0);
      });
    });
  });

  describe(`${persona}: pre-compact.mjs`, () => {
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

  describe(`${persona}: hook manifests — drift defense`, () => {
    it('hooks/hooks.json wires SessionStart/PreCompact/Stop to the claude adapter scripts', async () => {
      const manifest = JSON.parse(await readFile(P.path('hooks/hooks.json'), 'utf8'));
      const commands = JSON.stringify(manifest);
      // Contract: Claude Code runs the hook commands hooks.json names — a missing script never
      // fires, and another persona's path runs that persona's hook.
      for (const script of ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs']) {
        ok(commands.includes(`adapters/claude/hooks/${script}`),
          `hooks/hooks.json must reference adapters/claude/hooks/${script}`);
      }
      for (const other of OTHER_PERSONAS) {
        ok(!commands.includes(other), `no ${other} paths may leak into ${persona} hooks.json`);
      }
    });

    it('adapters/codex/hooks/hooks.json wires the three events to the codex adapter scripts', async () => {
      const manifest = JSON.parse(await readFile(join(HOOKS_CODEX, 'hooks.json'), 'utf8'));
      // Contract: Codex registers the events its hooks.json names, and runs the commands under them.
      deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
      for (const other of OTHER_PERSONAS) {
        ok(!JSON.stringify(manifest).includes(other),
          `no ${other} paths may leak into the codex hooks.json`);
      }
    });

    it('.codex-plugin manifest exposes the codex hooks manifest path', async () => {
      const manifest = JSON.parse(
        await readFile(P.path('.codex-plugin/plugin.json'), 'utf8'),
      );
      // Contract: Codex finds a plugin's hooks through the manifest's `hooks` path.
      strictEqual(manifest.hooks, './adapters/codex/hooks/hooks.json');
    });
  });
}
