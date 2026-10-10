// The commit surface's runbook blocks, run as written in bash and (when
// installed) zsh against temporary repositories with the persona's real
// scripts, for every persona whose declaration turns commit_surface on (the
// manifest enrolls the commit regions exactly there). Each case runs over the
// committed command and skill and over the ones assembled from the templates,
// so a template defect the drift check cannot see still fails. The
// `plugins/engineer` paths and `feat(engineer)` subjects below are
// commit-routing data (this repository's release-please packages), not the
// persona under test.
//
// Covers:
//   - with dispatch_target on: Phase 0 + the Autopilot block commit, stop at
//     the staging-set gate, and refuse outside autopilot;
//   - the interactive plan and close blocks;
//   - the staging-set clear before an interactive commit: one write with the
//     next step and its next action, so a commit that then fails leaves
//     neither the gate's owner-decision nor its "Owner: …" next action;
//   - Phase 0 refuses a /start workflow and a branch with none;
//   - every Codex skill block runs on its own, in a separate shell;
//   - with dispatch_target off, the commit templates name no autopilot call
//     and no orchestrator hand-off.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { parseRegions, renderTemplate, renderingDeclaration, replaceRegionBodies } from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, personaInfo } from './_personas.mjs';

const COMMAND = 'commands/commit.md';
const SKILL = 'core/skills/commit/SKILL.md';
const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

const PERSONAS = [...new Set(MANIFEST.regions.filter((r) => r.dest === COMMAND).flatMap((r) => r.personas))].sort();

const exists = (p) => access(p).then(() => true, () => false);

/** The document with every region body rendered fresh from its template. */
function assembled(persona, dest, text) {
  const parsed = parseRegions(text, dest);
  deepStrictEqual(parsed.errors, [], `${persona}/${dest}: region grammar`);
  const bodies = {};
  for (const region of MANIFEST.regions.filter((r) => r.dest === dest && r.personas.includes(persona))) {
    const rendered = renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', region.template), 'utf8'), {
      declaration: renderingDeclaration(declaration(persona)),
      substitutions: region.substitutions ?? {},
      label: region.template,
    });
    bodies[region.id] = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
  }
  return replaceRegionBodies(text, parsed.regions, bodies);
}

// Contract: the headings below are where each case slices out the block it
// runs — a renamed heading fails here instead of running the wrong block.
function section(text, heading) {
  const start = text.indexOf(heading);
  ok(start >= 0, `missing ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}
const blocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
// A section's one block that runs a command, picked by the command and not by
// position: a step a section gains (the private directory an edited subject
// goes into, ADR-0059's amendment of 2026-10-10) moves no case onto another block.
function blockWith(text, re) {
  const found = blocks(text).filter((b) => re.test(b));
  // Contract: each case runs the one block its command names — none, or two, would run nothing
  // or the wrong one.
  strictEqual(found.length, 1, `one block matches ${re}`);
  return found[0];
}

describe('the commit runbook suite reaches every persona with the commit surface (guards a vacuous pass)', () => {
  it('the personas enrolled in the commit regions are exactly the ones that declare commit_surface on', () => {
    const on = ['designer', 'engineer', 'founder'].filter((p) => declaration(p).capabilities?.commit_surface === true);
    ok(on.length > 0, 'no persona declares commit_surface on');
    deepStrictEqual(PERSONAS, on);
  });
});

for (const persona of PERSONAS) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const { readWorkflow } = await import(pathToFileURL(STATE).href);
  const itDispatchOn = P.capabilities.dispatch_target ? it : it.skip;
  const committed = { command: readFileSync(P.path(COMMAND), 'utf8'), skill: readFileSync(P.path(SKILL), 'utf8') };
  const DOCUMENTS = [
    ['committed', committed],
    ['assembled from the templates', { command: assembled(persona, COMMAND, committed.command), skill: assembled(persona, SKILL, committed.skill) }],
  ];

  function runBlock(shell, dir, block, extra = {}) {
    const env = { ...process.env, [renderingDeclaration(P.declaration).derived.root_env]: P.root, ...extra };
    delete env.CLAUDE_PLUGIN_ROOT;
    if (!('AGENTIC_AUTOPILOT' in extra)) delete env.AGENTIC_AUTOPILOT;
    delete env.ACCEPT_CURRENT_TREE;
    return spawnSync(shell, ['-c', block], { cwd: dir, encoding: 'utf8', env });
  }

  const state = (...args) => execFileSync('node', [STATE, ...args], { encoding: 'utf8', env: { ...process.env, AGENTIC_AUTOPILOT: '' } });

  async function withRepo(fn) {
    // realpath: the blocks resolve the repository through git, which reports
    // /private/var where mkdtemp said /var on macOS.
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${persona}-commit-runbook-`)));
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

  function createWorkflow(dir, verb) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const digest = execFileSync('shasum', ['-a', '256'], {
      input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
      encoding: 'utf8',
    }).trim().split(/\s+/)[0];
    return execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', verb, '--host', 'claude',
      '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', digest,
      '--original-request', 'runbook fixture'], { encoding: 'utf8' }).trim();
  }

  async function readyWorkflow(dir, { stray = false, host = 'claude' } = {}) {
    const wf = createWorkflow(dir, 'compose');
    state('append', '--workflow-path', wf, '--host', host, '--profile', 'code', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH');
    state('record-composed-file', '--workflow-path', wf, '--path', 'plugins/engineer/a.mjs', '--op', 'edit');
    await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
    if (stray) await writeFile(join(dir, 'stray.md'), 'x\n');
    return wf;
  }

  for (const shell of SHELLS) {
    for (const [which, doc] of DOCUMENTS) {
      const commandBlocks = () => ({
        phase0: blockWith(section(doc.command, '## Phase 0'), /state\.mjs" autopilot-preflight /),
        autopilot: P.capabilities.dispatch_target ? blockWith(section(doc.command, '## Autopilot — the whole step in one command'), /--mode autopilot\b/) : null,
        plan: blockWith(section(doc.command, '## Phase 1 — Plan (interactive)'), /--mode plan\b/),
        clear: blockWith(section(doc.command, '## Phase 2 — Commit (interactive)'), /state\.mjs" awaiting-owner-clear /),
        execute: blockWith(section(doc.command, '## Phase 2 — Commit (interactive)'), /--mode execute\b/),
        close: blockWith(section(doc.command, '## Phase 3 — Close without a commit (interactive)'), /--mode close\b/),
      });
      // An edited subject, as the prose before the execute block says: the agent
      // writes it into a private directory with its file tool, opens the block
      // with TEXT_DIR, and passes --subject-file in place of --suggested-subjects.
      const edited = async (execute, subject) => {
        const text = await realpath(await mkdtemp(join(tmpdir(), `${persona} agentic text.`)));
        await writeFile(join(text, 'subject.txt'), `${subject}\n`);
        ok(execute.includes('  --suggested-subjects\n'), 'the execute block passes the accepted suggestions');
        return { text, block: `TEXT_DIR='${text}'\n${execute.replace('  --suggested-subjects\n', '  --subject-file "$TEXT_DIR/subject.txt"\n')}` };
      };
      // A subject a shell would read if it were spliced into the command.
      const HOSTILE_SUBJECT = 'feat(engineer): it\'s "done" $(touch pwned) `touch pwned2`';
      const optIn = (execute) => {
        // Contract: the test splices the owner's opt-in flags in at this line; a
        // block without it would run without them and fail for another reason.
        ok(execute.includes('  --suggested-subjects\n'), 'the execute block passes the accepted suggestions');
        return execute.replace('  --suggested-subjects\n', '  --suggested-subjects --confirm-non-interactive --include-extra stray.md\n');
      };

      describe(`${persona}/${COMMAND} blocks (${shell}, ${which})`, () => {
        itDispatchOn('under autopilot: Phase 0 prints the commit rules, and the Autopilot block commits', async () => {
          await withRepo(async (dir) => {
            const wf = await readyWorkflow(dir);
            const b = commandBlocks();
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

        itDispatchOn('under autopilot: a stray change stops at the staging-set gate; outside autopilot the block is refused; the owner then confirms and commits', async () => {
          await withRepo(async (dir) => {
            const wf = await readyWorkflow(dir, { stray: true });
            const b = commandBlocks();
            let r = runBlock(shell, dir, b.autopilot);
            strictEqual(r.status, 2, r.stderr);
            r = runBlock(shell, dir, b.autopilot, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
            strictEqual(r.status, 0, r.stderr);
            strictEqual(JSON.parse(r.stdout).action, 'staging-set');
            strictEqual((await readWorkflow(wf)).frontmatter.awaiting_owner_gate, 'staging-set');
            // The owner comes back interactively: Phase 0 names the gate, the
            // clear block resolves it, and the execute block commits what they
            // confirmed (the stray file opted in).
            r = runBlock(shell, dir, b.phase0);
            strictEqual(r.status, 0, r.stderr);
            ok(r.stdout.includes('Owner gate staging-set is pending'), r.stdout);
            r = runBlock(shell, dir, b.clear);
            strictEqual(r.status, 0, r.stderr);
            r = runBlock(shell, dir, optIn(b.execute));
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
            const b = commandBlocks();
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

        it('the staging clear writes the owner\'s next step and its next action: a commit that then fails leaves commit and that action, not the gate\'s (round-2 #6, PC3b U4)', async () => {
          await withRepo(async (dir) => {
            const wf = await readyWorkflow(dir, { stray: true });
            const b = commandBlocks();
            if (P.capabilities.dispatch_target) {
              runBlock(shell, dir, b.autopilot, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
            } else {
              state('finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', `Owner: confirm the staging set with /${persona}:commit`,
                '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'staging-set', '--owner-gate-anchor', 'phase7-plan');
            }
            let fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_action], ['staging-set', 'owner-decision', `Owner: confirm the staging set with /${persona}:commit`]);
            let r = runBlock(shell, dir, b.clear);
            strictEqual(r.status, 0, r.stderr);
            await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
            r = runBlock(shell, dir, optIn(b.execute));
            ok(r.status !== 0, 'the hook refuses the commit');
            fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_action, fm.terminal_marker === true],
              [undefined, 'commit', `Commit the confirmed staging set with /${persona}:commit`, false]);
          });
        });

        // ADR-0059's amendment of 2026-10-10: a subject the user edited is text;
        // it reaches the driver as the file the agent wrote, never shell source.
        it('interactively: an edited subject reaches the commit as the file the agent wrote, and nothing in it runs', async () => {
          await withRepo(async (dir) => {
            const wf = await readyWorkflow(dir);
            const b = commandBlocks();
            // Contract: the agent editing a subject — the prose before the block names the
            // file transport, the steps and the flag.
            const prose = section(doc.command, '## Phase 2 — Commit (interactive)').replace(/\s+/g, ' ');
            for (const part of ['An edited subject reaches the driver as a file, never in the block', 'mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"', 'with your file-writing tool, not the shell, write each edited subject there', '--subject-file "$TEXT_DIR/subject.txt"']) ok(prose.includes(part), part);
            const { text, block } = await edited(b.execute, HOSTILE_SUBJECT);
            try {
              const r = runBlock(shell, dir, block);
              strictEqual(r.status, 0, r.stderr);
              strictEqual(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim(), HOSTILE_SUBJECT);
              strictEqual((await readWorkflow(wf)).frontmatter.current_phase, 'commit-complete');
              for (const side of ['pwned', 'pwned2']) strictEqual(await exists(join(dir, side)), false, `${side}: nothing in the subject ran`);
            } finally {
              await rm(text, { recursive: true, force: true });
            }
          });
        });

        it('Phase 0 refuses a /start workflow and a branch with none', async () => {
          await withRepo(async (dir) => {
            const b = commandBlocks();
            let r = runBlock(shell, dir, b.phase0);
            strictEqual(r.status, 1);
            ok(r.stderr.includes(`No active ${persona} workflow`), r.stderr);
            const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
            const sw = execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude', '--workflow-type', 'start',
              '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--original-request', 's'], { encoding: 'utf8' }).trim();
            const before = await readFile(sw, 'utf8');
            r = runBlock(shell, dir, b.phase0);
            strictEqual(r.status, 1);
            ok(r.stderr.includes(`is an /${persona}:start workflow`), r.stderr);
            strictEqual(await readFile(sw, 'utf8'), before, 'the refusal writes nothing');
          });
        });
      });

      describe(`${persona}/${SKILL} blocks (${shell}, ${which})`, () => {
        const fill = (b) => b.replaceAll('<plugin-root>', P.root).replaceAll('<claude|codex>', 'codex');
        it('every Codex skill block runs on its own, in a separate shell (round-2 #5)', async () => {
          await withRepo(async (dir) => {
            const phase0 = fill(blockWith(section(doc.skill, '## Phase 0'), /state\.mjs" autopilot-preflight /));
            const plan = fill(blockWith(section(doc.skill, '## Phase 1 — Plan'), /--mode plan\b/));
            const execute = fill(blockWith(section(doc.skill, '## Phase 2 — Commit'), /--mode execute\b/));
            const close = fill(blockWith(section(doc.skill, '## Phase 3 — Close without a commit'), /--mode close\b/));
            const wf = await readyWorkflow(dir, { host: 'codex' });
            await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 3;\n');
            let r = runBlock(shell, dir, phase0);
            strictEqual(r.status, 0, r.stderr);
            strictEqual(r.stdout, `Workflow: ${wf}\n`);
            r = runBlock(shell, dir, plan);
            strictEqual(r.status, 0, r.stderr);
            strictEqual(JSON.parse(r.stdout).branch, 'manifest-intersects-git');
            r = runBlock(shell, dir, execute);
            strictEqual(r.status, 0, r.stderr);
            strictEqual((await readWorkflow(wf)).frontmatter.current_phase, 'commit-complete');
            // The committed workflow is still active (no Stop hook ran); archive it first.
            state('archive', '--workflow-path', wf, '--host', 'codex', '--repo-root', dir);
            const w2 = createWorkflow(dir, 'investigate');
            state('append', '--workflow-path', w2, '--host', 'codex', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH');
            r = runBlock(shell, dir, close);
            strictEqual(r.status, 0, r.stderr);
            strictEqual(await exists(w2), false);
          });
        });

        it('the Codex staging clear writes the owner\'s next step and its next action in one write', async () => {
          await withRepo(async (dir) => {
            const clear = fill(blockWith(section(doc.skill, '## Phase 2 — Commit'), /state\.mjs" awaiting-owner-clear /));
            const wf = await readyWorkflow(dir, { stray: true, host: 'codex' });
            state('finish-verb', '--workflow-path', wf, '--host', 'codex', '--next-action', `Owner: confirm the staging set with /${persona}:commit`,
              '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'staging-set', '--owner-gate-anchor', 'phase7-plan');
            const r = runBlock(shell, dir, clear);
            strictEqual(r.status, 0, r.stderr);
            const fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_action], [undefined, 'commit', `Commit the confirmed staging set with /${persona}:commit`]);
          });
        });
      });
    }
  }
}

// A declaration may turn commit_surface on without dispatch_target (the sync
// refuses only the reverse). No persona does today, so the off branches of the
// commit templates are rendered here from each enrolled persona's declaration
// with dispatch_target turned off. The same patterns must occur with it on, or
// the check proves nothing.
// Contract: the agent running /commit — a persona without dispatch_target has
// no autopilot mode and no parent macro, so its runbook must not hand it a
// `--mode autopilot` call or an `/orchestrator:` command to run next.
describe('the commit templates with dispatch_target off name no autopilot call and no orchestrator hand-off', () => {
  const DISPATCH_ONLY = [/--mode autopilot/, /\/orchestrator:/];
  const render = (decl, r) => renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', r.template), 'utf8'), {
    declaration: renderingDeclaration(decl), substitutions: r.substitutions ?? {}, label: r.template,
  });
  for (const persona of PERSONAS) {
    it(`${persona}: each commit_surface region rendered with dispatch_target off`, () => {
      const decl = declaration(persona);
      const regions = MANIFEST.regions.filter((r) => [COMMAND, SKILL].includes(r.dest) && r.personas.includes(persona) && r.when?.field === 'capabilities.commit_surface');
      ok(regions.length >= 14, `the commit_surface regions: ${regions.length}`);
      const off = { ...decl, capabilities: { ...decl.capabilities, dispatch_target: false } };
      for (const r of regions) {
        const out = render(off, r);
        for (const re of DISPATCH_ONLY) ok(!re.test(out), `${r.dest}#${r.id}: ${re} with dispatch_target off:\n${out}`);
      }
      const on = regions.map((r) => render({ ...decl, capabilities: { ...decl.capabilities, dispatch_target: true } }, r)).join('\n');
      for (const re of DISPATCH_ONLY) ok(re.test(on), `${re} never occurs with dispatch_target on, so its absence proves nothing`);
    });
  }
});
