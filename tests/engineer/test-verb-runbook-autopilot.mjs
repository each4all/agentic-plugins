// ADR-0063 S3+S4 — the engineer runbook blocks, run as written in bash and
// (when installed) zsh against temporary repositories.
//
// Covers:
//   - a verb's Phase 0: the preflight is silent interactively, prints the
//     rules under autopilot, and refuses before any write when an owner gate
//     is set; with the released engineer 0.23.0 scripts (no preflight) the
//     block fails before any write (new runbook text, old install);
//   - the resume block clears the previous next step;
//   - a verb's Phase 2: interactive = terminal write + next step; autopilot =
//     next step only; a refused settlement stops the block before
//     finish-verb, so no next step is published;
//   - the six verbs, whose finalize the persona pipeline generates
//     (PC3 U7): settle decides from a real run ledger — a
//     completed run records the synthesis verdict, a failed one `failed`, a
//     never-launched attempt nothing — and refuses an empty run id that would
//     hide a launched run, before finish-verb;
//   - decide's Owner selection and refine's Owner decision: the owner's words
//     reach the resolved note as written, and inside an /engineer:start
//     lifecycle the block clears the gate and leaves the terminal write to
//     the lifecycle;
//   - /engineer:commit: Phase 0 + the Autopilot block commit, stop at the
//     staging-set gate, and refuse outside autopilot; the interactive plan and
//     close blocks; the staging-set clear block before an interactive commit.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ENG = resolve(REPO_ROOT, 'plugins/engineer');
const STATE = resolve(ENG, 'scripts/state.mjs');
const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
const { readWorkflow } = await import(STATE);

const exists = (p) => access(p).then(() => true, () => false);

function section(text, heading) {
  const start = text.indexOf(heading);
  ok(start >= 0, `missing ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}
const blocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const dedent = (b) => {
  const lines = b.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind)).join('\n');
};

async function verbBlocks(verb) {
  const text = await readFile(resolve(ENG, `commands/${verb}.md`), 'utf8');
  const phase0 = section(text, '## Phase 0');
  const all0 = blocks(phase0).map(dedent);
  return {
    find: all0[0],
    resume: all0.find((b) => b.includes('state.mjs" append')),
    phase2: blocks(section(text, '## Phase 2 — State finalize'))[0]
      .replace('--next-step-confidence "<HIGH|MEDIUM|LOW>"', '--next-step-confidence HIGH'),
  };
}

async function commitBlocks() {
  const text = await readFile(resolve(ENG, 'commands/commit.md'), 'utf8');
  return {
    phase0: blocks(section(text, '## Phase 0'))[0],
    autopilot: blocks(section(text, '## Autopilot — the whole step in one command'))[0],
    plan: blocks(section(text, '## Phase 1 — Plan (interactive)'))[0],
    clear: blocks(section(text, '## Phase 2 — Commit (interactive)'))[0],
    execute: blocks(section(text, '## Phase 2 — Commit (interactive)'))[1],
    close: blocks(section(text, '## Phase 3 — Close without a commit (interactive)'))[0],
  };
}

function runBlock(shell, dir, block, extra = {}, root = ENG) {
  const env = { ...process.env, AGENTIC_ENGINEER_ROOT: root, ...extra };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (!('AGENTIC_AUTOPILOT' in extra)) delete env.AGENTIC_AUTOPILOT;
  delete env.ACCEPT_CURRENT_TREE;
  return spawnSync(shell, ['-c', block], { cwd: dir, encoding: 'utf8', env });
}

async function withRepo(fn) {
  // realpath: the blocks resolve the repository through git, which reports
  // /private/var where mkdtemp said /var on macOS.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'engineer-verb-runbook-')));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'feat/r');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
    await writeFile(join(dir, 'README.md'), '# r\n');
    await writeFile(join(dir, 'release-please-config.json'), await readFile(resolve(REPO_ROOT, 'release-please-config.json'), 'utf8'));
    await mkdir(join(dir, 'plugins', 'engineer'), { recursive: true });
    await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 0;\n');
    git('add', '.');
    git('commit', '-qm', 'chore: base', '--no-verify');
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createWorkflow(dir, verb = 'critique') {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const digest = execFileSync('shasum', ['-a', '256'], {
    input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
    encoding: 'utf8',
  }).trim().split(/\s+/)[0];
  return execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', verb, '--host', 'claude',
    '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', digest,
    '--original-request', 'runbook fixture'], { encoding: 'utf8' }).trim();
}

// A stub companions root (AGENTIC_COMPANIONS_ROOT): the runner finds a codex
// companion that answers at once, or none at all.
async function stubCompanions({ missing = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'engineer-companions-')));
  await writeFile(join(dir, 'discover-peer.mjs'), missing
    ? 'export async function discoverPeerCompanion() { return { ok: false, reason: "not installed" }; }\n'
    : 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
  if (!missing) {
    await writeFile(join(dir, 'codex-companion.mjs'),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'the peer answer', exit_code: 0 }));\n");
    execFileSync('chmod', ['755', join(dir, 'codex-companion.mjs')]);
  }
  await writeFile(join(dir, 'prompt.xml'), '<task>fixture</task>\n');
  return dir;
}

// The dispatch, as the runbook runs it: the real runner records the pending
// row and the ledger.
function launch(dir, wf, verb, type, runId, companions) {
  const env = { ...process.env, AGENTIC_COMPANIONS_ROOT: companions };
  delete env.AGENTIC_AUTOPILOT;
  return spawnSync('node', [resolve(ENG, 'scripts/peer-runner.mjs'), 'run', '--repo-root', dir, '--kind', 'ensemble',
    '--peer', 'codex', '--prompt-file', join(companions, 'prompt.xml'), '--output-format', 'json',
    '--workflow-path', wf, '--phase', verb, '--host', 'claude', '--cwd', dir,
    '--ensemble-type', type, '--run-id', runId], { cwd: dir, encoding: 'utf8', env });
}

const state = (...args) => execFileSync('node', [STATE, ...args], { encoding: 'utf8', env: { ...process.env, AGENTIC_AUTOPILOT: '' } });

for (const shell of SHELLS) {
  describe(`verb runbook blocks (${shell})`, () => {
    it('Phase 0: silent interactively, the rules under autopilot, a refusal before any write when a gate is set', async () => {
      await withRepo(async (dir) => {
        const { find } = await verbBlocks('critique');
        let r = runBlock(shell, dir, find);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, '', 'no workflow yet, interactive: nothing');
        const wf = createWorkflow(dir);
        r = runBlock(shell, dir, find);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, '');
        r = runBlock(shell, dir, find, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.startsWith(`Autopilot run ${AUTOPILOT_RUN_ID}`), r.stdout);
        state('awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'routing-recommendation');
        const before = await readFile(wf, 'utf8');
        r = runBlock(shell, dir, find, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 1);
        ok(r.stderr.includes('owner gate scope-routing is set'), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('Phase 0 with scripts that predate the preflight fails before any write (new text, old install)', async () => {
      await withRepo(async (dir) => {
        // A stand-in for an older install: it knows find-active and refuses
        // every subcommand it does not know, as the real state.mjs does.
        const old = await realpath(await mkdtemp(join(tmpdir(), 'engineer-old-root-')));
        try {
          await mkdir(join(old, 'scripts'), { recursive: true });
          await writeFile(join(old, 'scripts', 'state.mjs'), [
            'const [sub] = process.argv.slice(2);',
            "if (sub === 'find-active') { process.stdout.write(process.env.STUB_ACTIVE + '\\n'); process.exit(0); }",
            "process.stderr.write('state.mjs: Unknown subcommand: ' + sub + '\\n'); process.exit(2);",
          ].join('\n'));
          const wf = createWorkflow(dir);
          const before = await readFile(wf, 'utf8');
          const { find } = await verbBlocks('critique');
          const r = runBlock(shell, dir, find, { STUB_ACTIVE: wf }, old);
          strictEqual(r.status, 2, r.stderr);
          ok(r.stderr.includes('Unknown subcommand: autopilot-preflight'), r.stderr);
          strictEqual(await readFile(wf, 'utf8'), before);
        } finally {
          await rm(old, { recursive: true, force: true });
        }
      });
    });

    it('Phase 0 with the released 0.23.0 scripts fails before any write (new text, old install)', async (t) => {
      const has = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', 'plugin-engineer-v0.23.0^{commit}']).status === 0;
      if (!has) { t.skip('tag plugin-engineer-v0.23.0 not in this clone'); return; }
      await withRepo(async (dir) => {
        const old = await mkdtemp(join(tmpdir(), 'engineer-0.23.0-'));
        try {
          const tar = execFileSync('git', ['-C', REPO_ROOT, 'archive', 'plugin-engineer-v0.23.0', 'plugins/engineer/scripts', '.claude-plugin/marketplace.json']);
          execFileSync('tar', ['-x', '-C', old], { input: tar });
          const oldRoot = join(old, 'plugins', 'engineer');
          const wf = createWorkflow(dir);
          const before = await readFile(wf, 'utf8');
          const { find } = await verbBlocks('critique');
          const r = runBlock(shell, dir, find, {}, oldRoot);
          ok(r.status !== 0, 'the block stops');
          ok(/Unknown subcommand|autopilot-preflight/.test(r.stderr), r.stderr);
          strictEqual(await readFile(wf, 'utf8'), before);
        } finally {
          await rm(old, { recursive: true, force: true });
        }
      });
    });

    it('resume clears the previous next step', async () => {
      await withRepo(async (dir) => {
        const wf = createWorkflow(dir);
        state('append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH');
        const { resume } = await verbBlocks('critique');
        const r = runBlock(shell, dir, resume.replace('"<profile or empty>"', '""'), { ACTIVE: wf });
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.next_step_kind, fm.current_phase], [undefined, 'phase-0-resume']);
      });
    });

    it('Phase 2: terminal + next step interactively; next step only under autopilot; a refused settlement publishes nothing', async () => {
      const companions = await stubCompanions();
      try {
        await withRepo(async (dir) => {
          // PC3 U7: critique's finalize is generated and settles the attempt
          // from its run ledger; RUN_ID is empty when no run launched.
          const { phase2 } = await verbBlocks('critique');
          const vars = { RUN_ID: '', VERDICT: 'agreed', SUMMARY: 'fine' };
          let wf = createWorkflow(dir);
          let r = runBlock(shell, dir, phase2, { ACTIVE: wf, ...vars });
          strictEqual(r.status, 0, r.stderr);
          let fm = (await readWorkflow(wf)).frontmatter;
          deepStrictEqual([fm.current_phase, fm.terminal_marker, fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence],
            ['summary-complete', true, 'verb', 'refine', 'HIGH']);
          state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

          wf = createWorkflow(dir);
          r = runBlock(shell, dir, phase2, { ACTIVE: wf, ...vars, AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
          strictEqual(r.status, 0, r.stderr);
          fm = (await readWorkflow(wf)).frontmatter;
          deepStrictEqual([fm.current_phase, fm.terminal_marker === true, fm.next_step_kind], ['phase-2-presented', false, 'verb']);
          state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

          // An empty run id while a launched run is pending: settle refuses,
          // and the block stops before finish-verb.
          wf = createWorkflow(dir);
          strictEqual(launch(dir, wf, 'critique', 'review', 'review-hidden', companions).status, 0);
          r = runBlock(shell, dir, phase2, { ACTIVE: wf, ...vars });
          ok(r.status !== 0, 'a refused settlement stops the block');
          fm = (await readWorkflow(wf)).frontmatter;
          deepStrictEqual([fm.next_step_kind, fm.terminal_marker === true], [undefined, false], 'finish-verb never ran');
        });
      } finally {
        await rm(companions, { recursive: true, force: true });
      }
    });
  });

  describe(`generated verb finalize, settled from the run ledger (${shell}, PC3 U7)`, () => {
    for (const [verb, type] of [['investigate', 'investigate'], ['frame', 'frame'], ['compose', 'plan-verify'], ['decide', 'brainstorm'], ['critique', 'review'], ['refine', 'refine-verify']]) {
      it(`${verb}: completed → the synthesis verdict, failed → failed, never launched → nothing, each then finish-verb; an empty run id hiding a launched run stops the block first`, async () => {
        const ok_ = await stubCompanions();
        const gone = await stubCompanions({ missing: true });
        try {
          await withRepo(async (dir) => {
            const { phase2 } = await verbBlocks(verb);
            ok(phase2.includes('peer-runner.mjs" settle'), 'the generated finalize settles');
            const vars = { VERDICT: 'agreed', SUMMARY: 'fine' };
            const results = async (wf) => {
              const fm = (await readWorkflow(wf)).frontmatter;
              return { fm, results: fm.ensemble_results ?? [], pending: fm.pending_ensemble ?? [] };
            };

            // Completed: the synthesis verdict, the pending row gone, the terminal write.
            let wf = createWorkflow(dir, verb);
            let r = launch(dir, wf, verb, type, `${type}-done`, ok_);
            strictEqual(r.status, 0, r.stderr);
            r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: `${type}-done`, ...vars });
            strictEqual(r.status, 0, r.stderr);
            let got = await results(wf);
            deepStrictEqual(got.results.map((e) => [e.run_id, e.verdict]), [[`${type}-done`, 'agreed']]);
            deepStrictEqual([got.pending.length, got.fm.current_phase, got.fm.next_step_kind], [0, 'summary-complete', 'verb']);
            state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

            // Launched and failed (no companion): verdict failed, whatever the synthesis said.
            wf = createWorkflow(dir, verb);
            launch(dir, wf, verb, type, `${type}-gone`, gone);
            r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: `${type}-gone`, ...vars });
            strictEqual(r.status, 0, r.stderr);
            got = await results(wf);
            deepStrictEqual(got.results.map((e) => [e.run_id, e.verdict]), [[`${type}-gone`, 'failed']]);
            deepStrictEqual([got.pending.length, got.fm.current_phase], [0, 'summary-complete']);
            state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

            // Never launched: nothing recorded, the verb still finishes.
            wf = createWorkflow(dir, verb);
            r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: '', ...vars });
            strictEqual(r.status, 0, r.stderr);
            got = await results(wf);
            deepStrictEqual([got.results.length, got.pending.length, got.fm.current_phase], [0, 0, 'summary-complete']);
            state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

            // An empty run id while a launched run is pending: settle refuses,
            // and finish-verb never runs.
            wf = createWorkflow(dir, verb);
            strictEqual(launch(dir, wf, verb, type, `${type}-hidden`, ok_).status, 0);
            r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: '', ...vars });
            ok(r.status !== 0, 'the block stops');
            got = await results(wf);
            deepStrictEqual([got.fm.next_step_kind, got.fm.terminal_marker === true, got.pending.length], [undefined, false, 1]);
          });
        } finally {
          await rm(ok_, { recursive: true, force: true });
          await rm(gone, { recursive: true, force: true });
        }
      });
    }
  });

  describe(`/engineer:commit runbook blocks (${shell})`, () => {
    async function readyWorkflow(dir, { stray = false } = {}) {
      const wf = createWorkflow(dir, 'compose');
      state('append', '--workflow-path', wf, '--host', 'claude', '--profile', 'code', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH');
      state('record-composed-file', '--workflow-path', wf, '--path', 'plugins/engineer/a.mjs', '--op', 'edit');
      await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
      if (stray) await writeFile(join(dir, 'stray.md'), 'x\n');
      return wf;
    }

    it('under autopilot: Phase 0 prints the commit rules, and the Autopilot block commits', async () => {
      await withRepo(async (dir) => {
        const wf = await readyWorkflow(dir);
        const b = await commitBlocks();
        let r = runBlock(shell, dir, b.phase0, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('the one step that commits or closes the workflow'), r.stdout);
        ok(r.stdout.includes(`Workflow: ${wf}`), r.stdout);
        r = runBlock(shell, dir, b.autopilot, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'committed');
        strictEqual(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim(), 'feat(engineer): runbook fixture');
        strictEqual((await readWorkflow(wf)).frontmatter.current_phase, 'commit-complete');
      });
    });

    it('under autopilot: a stray change stops at the staging-set gate; outside autopilot the block is refused', async () => {
      await withRepo(async (dir) => {
        const wf = await readyWorkflow(dir, { stray: true });
        const b = await commitBlocks();
        let r = runBlock(shell, dir, b.autopilot);
        strictEqual(r.status, 2, r.stderr);
        r = runBlock(shell, dir, b.autopilot, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'staging-set');
        strictEqual((await readWorkflow(wf)).frontmatter.awaiting_owner_gate, 'staging-set');
        // The owner comes back interactively: Phase 0 names the gate, the clear
        // block resolves it, and the execute block commits what they confirmed.
        r = runBlock(shell, dir, b.phase0);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('Owner gate staging-set is pending'), r.stdout);
        r = runBlock(shell, dir, b.clear);
        strictEqual(r.status, 0, r.stderr);
        // The owner opted the stray file in: the staging flags the plan asked for.
        r = runBlock(shell, dir, b.execute.replace('  --suggested-subjects\n', '  --suggested-subjects --confirm-non-interactive --include-extra stray.md\n'));
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.awaiting_owner_gate, fm.current_phase], [undefined, 'commit-complete']);
        const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
        deepStrictEqual(files, ['plugins/engineer/a.mjs', 'stray.md']);
      });
    });

    it('interactively: the plan block reports a close, and the close block archives the workflow', async () => {
      await withRepo(async (dir) => {
        const wf = createWorkflow(dir, 'investigate');
        state('append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH');
        const b = await commitBlocks();
        let r = runBlock(shell, dir, b.phase0);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, `Workflow: ${wf}\n`);
        r = runBlock(shell, dir, b.plan);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).no_changes.path, 'close');
        r = runBlock(shell, dir, b.close);
        strictEqual(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        strictEqual(await exists(wf), false);
        strictEqual((await readWorkflow(out.archived_to)).frontmatter.current_phase, 'close-complete');
      });
    });

    it('the staging clear writes the owner\'s next step: a commit that then fails leaves commit, not owner-decision (round-2 #6)', async () => {
      await withRepo(async (dir) => {
        const wf = await readyWorkflow(dir, { stray: true });
        const b = await commitBlocks();
        runBlock(shell, dir, b.autopilot, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual((await readWorkflow(wf)).frontmatter.next_step_kind, 'owner-decision');
        let r = runBlock(shell, dir, b.clear);
        strictEqual(r.status, 0, r.stderr);
        await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        r = runBlock(shell, dir, b.execute.replace('  --suggested-subjects\n', '  --suggested-subjects --confirm-non-interactive --include-extra stray.md\n'));
        ok(r.status !== 0, 'the hook refuses the commit');
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.terminal_marker === true], [undefined, 'commit', false]);
      });
    });

    it('Phase 0 refuses an /engineer:start workflow and a branch with none', async () => {
      await withRepo(async (dir) => {
        const b = await commitBlocks();
        let r = runBlock(shell, dir, b.phase0);
        strictEqual(r.status, 1);
        ok(r.stderr.includes('No active engineer workflow'), r.stderr);
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude', '--workflow-type', 'start',
          '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--original-request', 's']);
        r = runBlock(shell, dir, b.phase0);
        strictEqual(r.status, 1);
        ok(r.stderr.includes('is an /engineer:start workflow'), r.stderr);
      });
    });
  });
}

async function codexCommitBlocks() {
  const text = await readFile(resolve(ENG, 'core/skills/commit/SKILL.md'), 'utf8');
  const fill = (b) => b.replaceAll('<plugin-root>', ENG).replaceAll('<claude|codex>', 'codex');
  return {
    phase0: fill(blocks(section(text, '## Phase 0'))[0]),
    plan: fill(blocks(section(text, '## Phase 1 — Plan'))[0]),
    clear: fill(blocks(section(text, '## Phase 2 — Commit'))[0]),
    execute: fill(blocks(section(text, '## Phase 2 — Commit'))[1]).replace('<subject flags> [<staging flags>]', '--suggested-subjects'),
    close: fill(blocks(section(text, '## Phase 3 — Close without a commit'))[0]),
  };
}

for (const shell of SHELLS) {
  describe(`Codex commit skill and owner-resolution blocks (${shell})`, () => {
    it('every Codex skill block runs on its own, in a separate shell (round-2 #5)', async () => {
      await withRepo(async (dir) => {
        const wf = createWorkflow(dir, 'compose');
        state('append', '--workflow-path', wf, '--host', 'codex', '--profile', 'code', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH');
        state('record-composed-file', '--workflow-path', wf, '--path', 'plugins/engineer/a.mjs', '--op', 'edit');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 3;\n');
        const b = await codexCommitBlocks();
        let r = runBlock(shell, dir, b.phase0);
        strictEqual(r.status, 0, r.stderr);
        r = runBlock(shell, dir, b.plan);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).branch, 'manifest-intersects-git');
        r = runBlock(shell, dir, b.execute);
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await readWorkflow(wf)).frontmatter.current_phase, 'commit-complete');
        // The committed workflow is still active (no Stop hook ran); archive it first.
        state('archive', '--workflow-path', wf, '--host', 'codex', '--repo-root', dir);
        const w2 = createWorkflow(dir, 'investigate');
        state('append', '--workflow-path', w2, '--host', 'codex', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH');
        r = runBlock(shell, dir, b.close);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(await exists(w2), false);
      });
    });

    it('decide\'s Owner selection stops at a refused clear, writing no selection (round-2 #7)', async () => {
      await withRepo(async (dir) => {
        const text = await readFile(resolve(ENG, 'commands/decide.md'), 'utf8');
        // The generated block reads the resolution from a quoted heredoc
        // (PC3 U7); the owner's words go in place of its placeholder line.
        const placeholder = '<Owner selection: the direction the owner chose, and why>';
        const raw = blocks(section(text, '## Owner selection (decide-conflict)'))[0];
        ok(raw.includes(`\n${placeholder}\nOWNER_RESOLUTION\n`), 'the resolution placeholder sits inside the heredoc');
        const block = raw.replace(placeholder, 'Owner selection: option A, the $simplest `one`');
        const wf = createWorkflow(dir, 'decide');
        state('awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'routing-recommendation');
        const before = await readFile(wf, 'utf8');
        // No ACTIVE is passed in: the block resolves the workflow itself (round-3 F2).
        let r = runBlock(shell, dir, block);
        ok(r.status !== 0, 'the clear refuses a different gate and the block stops');
        strictEqual(await readFile(wf, 'utf8'), before);
        // With the right gate it records the choice and ends terminal.
        state('awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing');
        state('finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'owner', '--next-step-kind', 'owner-decision',
          '--next-step-confidence', 'MEDIUM', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis');
        r = runBlock(shell, dir, block);
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter: fm, body } = await readWorkflow(wf);
        deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.current_phase, fm.terminal_marker],
          [undefined, 'verb', 'compose', 'summary-complete', true]);
        ok(/### Owner gate resolved: decide-conflict at [^\n]+\n\nOwner selection: option A, the \$simplest `one`/.test(body), 'the decision sits in the resolved note as written (round-3 F1)');
        state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

        // Inside an /engineer:start lifecycle the block clears the gate and
        // stops: the lifecycle makes its one terminal write (PC3 U7).
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const sw = execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', 'investigate', '--host', 'claude', '--workflow-type', 'start',
          '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', 'x', '--original-request', 'start fixture'], { encoding: 'utf8' }).trim();
        state('finish-verb', '--workflow-path', sw, '--host', 'claude', '--next-action', 'owner', '--next-step-kind', 'owner-decision',
          '--next-step-confidence', 'MEDIUM', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis');
        r = runBlock(shell, dir, block);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stderr.includes('Resume the lifecycle with /engineer:start'), r.stderr);
        const s = (await readWorkflow(sw)).frontmatter;
        deepStrictEqual([s.awaiting_owner_gate, s.next_step_kind, s.next_step_verb, s.current_phase === 'summary-complete', s.terminal_marker === true],
          [undefined, 'verb', 'compose', false, false]);
      });
    });
  });
}

for (const shell of SHELLS) {
  describe(`refine's Owner decision blocks (${shell})`, () => {
    it('each resolves the workflow itself and records the decision with the next step in one write', async () => {
      await withRepo(async (dir) => {
        const text = await readFile(resolve(ENG, 'commands/refine.md'), 'utf8');
        // The generated blocks read the owner's resolution from a quoted
        // heredoc (PC3 U7); the owner's words go in place of its placeholder.
        const owner = (block, placeholder, words) => {
          ok(block.includes(`\n${placeholder}\nOWNER_RESOLUTION\n`), placeholder);
          return block.replace(placeholder, words);
        };
        const [rawFix, rawDefer] = blocks(section(text, '## Owner decision (recurring-finding)')).map(dedent);
        const fixNow = owner(rawFix, '<Owner decision: fix the finding now>', 'Owner decision: fix the cache key now');
        const defer = owner(rawDefer, '<Owner decision: defer the finding, with the reason and where it is tracked>', 'Owner decision: defer the cache key — tracked in C99');
        const wf = createWorkflow(dir, 'refine');
        const gate = () => state('finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'owner', '--next-step-kind', 'owner-decision',
          '--next-step-confidence', 'HIGH', '--owner-gate', 'recurring-finding', '--owner-gate-anchor', 'recurring-finding');
        gate();
        let r = runBlock(shell, dir, fixNow);
        strictEqual(r.status, 0, r.stderr);
        let fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb], [undefined, 'verb', 'refine']);
        gate();
        r = runBlock(shell, dir, defer);
        strictEqual(r.status, 0, r.stderr);
        const read = await readWorkflow(wf);
        fm = read.frontmatter;
        deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.current_phase, fm.terminal_marker], [undefined, 'commit', 'summary-complete', true]);
        ok(/### Owner gate resolved: recurring-finding at [^\n]+\n\nOwner decision: defer the cache key — tracked in C99/.test(read.body), read.body);
        // commit_surface on: the deferral's next action is the commit, which
        // /engineer:commit makes (PC3 U7).
        strictEqual(fm.next_action, 'Commit the refined change; the recurring finding is deferred');
        state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

        // Inside an /engineer:start lifecycle the Defer block clears the gate
        // and stops: the lifecycle makes its one terminal write (PC3 U7).
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const sw = execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', 'investigate', '--host', 'claude', '--workflow-type', 'start',
          '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', 'x', '--original-request', 'start fixture'], { encoding: 'utf8' }).trim();
        state('finish-verb', '--workflow-path', sw, '--host', 'claude', '--next-action', 'owner', '--next-step-kind', 'owner-decision',
          '--next-step-confidence', 'HIGH', '--owner-gate', 'recurring-finding', '--owner-gate-anchor', 'recurring-finding');
        r = runBlock(shell, dir, defer);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stderr.includes('Resume the lifecycle with /engineer:start'), r.stderr);
        const s = (await readWorkflow(sw)).frontmatter;
        deepStrictEqual([s.awaiting_owner_gate, s.next_step_kind, s.current_phase === 'summary-complete', s.terminal_marker === true],
          [undefined, 'commit', false, false]);
      });
    });
  });
}
