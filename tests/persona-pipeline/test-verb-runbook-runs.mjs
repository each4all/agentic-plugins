// The verb runbooks' blocks (ADR-0063 S3+S4; ADR-0066 Stage 3, PC3b U4b), run
// as written in bash and (when installed) zsh against temporary repositories
// with the persona's real scripts, for every persona the verb regions are
// generated into. Each case runs over the committed runbook and over the one
// assembled from the templates; where the two are byte-equal (the drift check
// holds) the assembled run is skipped, since it would run the same text again.
// Moved from tests/engineer/test-verb-runbook-autopilot.mjs; the commit
// surface's blocks went to test-commit-runbook.mjs (PC3b U4).
//
// Covers:
//   - a verb's Phase 0: the preflight is silent interactively and puts a
//     pending owner gate to the user without a write; with dispatch_target on
//     it prints the rules under an autopilot run and refuses before any write
//     when a gate is set, and with it off the run is ignored, said once on
//     stderr, and the verb runs interactively; with scripts that predate the
//     preflight (a stand-in, and the newest release without it) the block
//     fails before any write (new runbook text, old install);
//   - the resume block clears the previous next step;
//   - a verb's Phase 2: interactive = terminal write + next step; under an
//     autopilot run, the next step only (dispatch_target on) or the
//     interactive write (off); a refused settlement stops the block before
//     finish-verb, so no next step is published;
//   - the six verbs' finalize settles from a real run ledger — a completed run
//     records the synthesis verdict, a failed one `failed`, a never-launched
//     attempt nothing — and refuses an empty run id that would hide a launched
//     run, before finish-verb; a verb that closes only once it converged
//     (terminal_requires_convergence) stays open, with its next step, when it
//     did not;
//   - decide's Owner selection and refine's Owner decision: the owner's words
//     reach the resolved note as written, the clear writes the next step and
//     its next action, and inside a /<persona>:start lifecycle the block
//     clears the gate and leaves the terminal write to the lifecycle.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { parseRegions, renderTemplate, renderingDeclaration, replaceRegionBodies } from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, personaInfo, personasFound } from './_personas.mjs';

const VERBS = ['investigate', 'frame', 'compose', 'decide', 'critique', 'refine'];
// The verb each verb's finalize records next: the lifecycle's order, the same
// in every persona's template.
const NEXT_VERB = { investigate: 'frame', frame: 'decide', compose: 'critique', decide: 'compose', critique: 'refine', refine: 'critique' };
const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

const PERSONAS = [...new Set(MANIFEST.regions.filter((r) => VERBS.some((v) => r.dest === `commands/${v}.md`)).flatMap((r) => r.personas))].sort();

describe('the verb runbook runs reach every persona (guards a vacuous pass)', () => {
  it('the personas the verb regions are generated into are the personas on disk, and each verb runbook holds generated regions', () => {
    deepStrictEqual(PERSONAS, personasFound());
    for (const persona of PERSONAS) {
      for (const verb of VERBS) {
        ok(MANIFEST.regions.some((r) => r.dest === `commands/${verb}.md` && r.personas.includes(persona)), `${persona}/${verb}`);
      }
    }
  });
});

/** The runbook with every region body rendered fresh from its template. */
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

function section(text, heading) {
  const start = text.indexOf(heading);
  // Contract: this file slices the blocks it runs by these headings — a heading gone would run
  // nothing, or the wrong section's blocks.
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

/** A placeholder the case fills in, checked present so the fill is never vacuous. */
function fill(block, placeholder, value) {
  // Contract: the placeholder the agent fills before running the block — absent, the run would
  // execute the unfilled text and prove nothing.
  ok(block.includes(placeholder), `the block holds ${placeholder}`);
  return block.replaceAll(placeholder, value);
}

// The newest release of the persona whose state.mjs has no autopilot-preflight
// (a clone without tags has none, and the case skips).
function releaseWithoutPreflight(persona) {
  const tags = spawnSync('git', ['-C', REPO_ROOT, 'tag', '-l', `plugin-${persona}-v*`, '--sort=-v:refname'], { encoding: 'utf8' });
  for (const tag of (tags.stdout ?? '').split('\n').filter(Boolean)) {
    const r = spawnSync('git', ['-C', REPO_ROOT, 'show', `${tag}:plugins/${persona}/scripts/state.mjs`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && !r.stdout.includes('autopilot-preflight')) return tag;
  }
  return null;
}

for (const persona of PERSONAS) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const PEER_RUNNER = P.path('scripts/peer-runner.mjs');
  const { readWorkflow } = await import(pathToFileURL(STATE).href);
  const ROOT_ENV = renderingDeclaration(P.declaration).derived.root_env;
  const dispatchOn = P.capabilities.dispatch_target === true;
  const commitOn = P.capabilities.commit_surface === true;
  const convergent = (verb) => P.declaration.verbs?.[verb]?.terminal_requires_convergence === true;

  const committed = Object.fromEntries(VERBS.map((v) => [v, readFileSync(P.path(`commands/${v}.md`), 'utf8')]));
  const fresh = Object.fromEntries(VERBS.map((v) => [v, assembled(persona, `commands/${v}.md`, committed[v])]));
  const DOCUMENTS = [['committed', committed, () => false], ['assembled from the templates', fresh, (verbs) => verbs.every((v) => fresh[v] === committed[v])]];

  function runBlock(shell, dir, block, extra = {}, root = P.root) {
    const env = { ...process.env, [ROOT_ENV]: root, ...extra };
    delete env.CLAUDE_PLUGIN_ROOT;
    if (!('AGENTIC_AUTOPILOT' in extra)) delete env.AGENTIC_AUTOPILOT;
    delete env.ACCEPT_CURRENT_TREE;
    return spawnSync(shell, ['-c', block], { cwd: dir, encoding: 'utf8', env });
  }

  const state = (...args) => execFileSync('node', [STATE, ...args], { encoding: 'utf8', env: { ...process.env, AGENTIC_AUTOPILOT: '' } });

  async function withRepo(fn) {
    // realpath: the blocks resolve the repository through git, which reports
    // /private/var where mkdtemp said /var on macOS.
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${persona}-verb-runbook-`)));
    try {
      const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
      git('init', '-q', '-b', 'feat/r');
      git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
      await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
      await writeFile(join(dir, 'README.md'), '# r\n');
      git('add', '.');
      git('commit', '-qm', 'chore: base', '--no-verify');
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function createWorkflow(dir, verb, { type = null } = {}) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const digest = execFileSync('shasum', ['-a', '256'], {
      input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
      encoding: 'utf8',
    }).trim().split(/\s+/)[0];
    return execFileSync('node', [STATE, 'create', '--repo-root', dir, '--verb', verb, '--host', 'claude',
      ...(type ? ['--workflow-type', type] : []),
      '--git-baseline-branch', 'feat/r', '--git-baseline-head', head, '--status-digest', digest,
      '--original-request', 'runbook fixture'], { encoding: 'utf8' }).trim();
  }

  const archive = (dir, wf) => state('archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir);

  // A stub companions root (AGENTIC_COMPANIONS_ROOT): the runner finds a codex
  // companion that answers at once, or none at all.
  async function stubCompanions({ missing = false } = {}) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `${persona}-companions-`)));
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
    return spawnSync('node', [PEER_RUNNER, 'run', '--repo-root', dir, '--kind', 'ensemble',
      '--peer', 'codex', '--prompt-file', join(companions, 'prompt.xml'), '--output-format', 'json',
      '--workflow-path', wf, '--phase', verb, '--host', 'claude', '--cwd', dir,
      '--ensemble-type', type, '--run-id', runId], { cwd: dir, encoding: 'utf8', env });
  }

  for (const shell of SHELLS) {
    for (const [which, docs, same] of DOCUMENTS) {
      const skip = (...verbs) => (same(verbs) ? { skip: `byte-equal to the committed runbook${verbs.length > 1 ? 's' : ''}, which the committed case runs` } : {});
      const verbBlocks = (verb) => {
        const text = docs[verb];
        const all0 = blocks(section(text, '## Phase 0')).map(dedent);
        return {
          find: all0[0],
          resume: all0.find((b) => b.includes('state.mjs" append')),
          phase2: blocks(section(text, '## Phase 2 — State finalize'))[0],
          type: /^ENSEMBLE_TYPE='([^']+)'$/m.exec(text)?.[1],
        };
      };
      // The finalize with the agent's choices made: confidence HIGH and, where
      // the verb closes only once it converged, the convergence and the step
      // that resolves what is still open.
      const finalize = (verb, { converged = true } = {}) => {
        let b = fill(verbBlocks(verb).phase2, '--next-step-confidence "<HIGH|MEDIUM|LOW>"', '--next-step-confidence HIGH');
        // Contract: the agent running the finalize — the convergence step it fills exists exactly
        // where the verb waits for convergence; elsewhere it would hold back the terminal write.
        if (convergent(verb)) {
          b = b.replace(/CONVERGED="<yes\|no[^"\n]*>"/, () => `CONVERGED="${converged ? 'yes' : 'no'}"`);
          ok(b.includes(`CONVERGED="${converged ? 'yes' : 'no'}"`), 'the convergence is set in the block');
          b = fill(b, '"<refine|decide|investigate>"', 'refine');
        } else {
          ok(!b.includes('CONVERGED='), 'a verb that does not wait for convergence has no convergence step');
        }
        return b;
      };

      describe(`${persona}: verb runbook blocks (${shell}, ${which})`, () => {
        it('Phase 0: silent interactively; a pending gate is put to the user with no write; an autopilot run as the capability says', skip('critique'), async () => {
          await withRepo(async (dir) => {
            const { find } = verbBlocks('critique');
            let r = runBlock(shell, dir, find);
            strictEqual(r.status, 0, r.stderr);
            strictEqual(r.stdout, '', 'no workflow yet, interactive: nothing');
            const wf = createWorkflow(dir, 'critique');
            r = runBlock(shell, dir, find);
            strictEqual(r.status, 0, r.stderr);
            deepStrictEqual([r.stdout, r.stderr], ['', '']);
            r = runBlock(shell, dir, find, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
            strictEqual(r.status, 0, r.stderr);
            if (dispatchOn) {
              ok(r.stdout.startsWith(`Autopilot run ${AUTOPILOT_RUN_ID}`), r.stdout);
            } else {
              strictEqual(r.stdout, '', 'no rules: the persona is no autopilot subject');
              ok(r.stderr.includes(`AGENTIC_AUTOPILOT=${AUTOPILOT_RUN_ID} is ignored: ${persona} is not an autopilot dispatch target`), r.stderr);
            }
            state('awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'routing-recommendation');
            const before = await readFile(wf, 'utf8');
            r = runBlock(shell, dir, find);
            strictEqual(r.status, 0, r.stderr);
            ok(r.stdout.startsWith('Owner gate scope-routing is pending'), r.stdout);
            strictEqual(await readFile(wf, 'utf8'), before, 'the notice writes nothing');
            r = runBlock(shell, dir, find, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
            if (dispatchOn) {
              strictEqual(r.status, 1);
              ok(r.stderr.includes('owner gate scope-routing is set'), r.stderr);
            } else {
              strictEqual(r.status, 0, r.stderr);
              ok(r.stdout.startsWith('Owner gate scope-routing is pending'), r.stdout);
            }
            strictEqual(await readFile(wf, 'utf8'), before);
          });
        });

        it('Phase 0 with scripts that predate the preflight fails before any write (new text, old install)', skip('critique'), async () => {
          await withRepo(async (dir) => {
            // A stand-in for an older install: it knows find-active and refuses
            // every subcommand it does not know, as the real state.mjs does.
            const old = await realpath(await mkdtemp(join(tmpdir(), `${persona}-old-root-`)));
            try {
              await mkdir(join(old, 'scripts'), { recursive: true });
              await writeFile(join(old, 'scripts', 'state.mjs'), [
                'const [sub] = process.argv.slice(2);',
                "if (sub === 'find-active') { process.stdout.write(process.env.STUB_ACTIVE + '\\n'); process.exit(0); }",
                "process.stderr.write('state.mjs: Unknown subcommand: ' + sub + '\\n'); process.exit(2);",
              ].join('\n'));
              const wf = createWorkflow(dir, 'critique');
              const before = await readFile(wf, 'utf8');
              const { find } = verbBlocks('critique');
              const r = runBlock(shell, dir, find, { STUB_ACTIVE: wf }, old);
              strictEqual(r.status, 2, r.stderr);
              ok(r.stderr.includes('Unknown subcommand: autopilot-preflight'), r.stderr);
              strictEqual(await readFile(wf, 'utf8'), before);
            } finally {
              await rm(old, { recursive: true, force: true });
            }
          });
        });

        it('Phase 0 with the newest released scripts that predate the preflight fails before any write (new text, old install)', skip('critique'), async (t) => {
          const tag = releaseWithoutPreflight(persona);
          if (!tag) { t.skip(`no plugin-${persona}-v* release without the preflight in this clone`); return; }
          await withRepo(async (dir) => {
            const old = await mkdtemp(join(tmpdir(), `${persona}-released-`));
            try {
              // The whole plugin, as an install holds it: a release whose
              // scripts read the persona declaration needs persona.json beside them.
              const tar = execFileSync('git', ['-C', REPO_ROOT, 'archive', tag, `plugins/${persona}`, '.claude-plugin/marketplace.json'], { maxBuffer: 256 * 1024 * 1024 });
              execFileSync('tar', ['-x', '-C', old], { input: tar });
              const wf = createWorkflow(dir, 'critique');
              const before = await readFile(wf, 'utf8');
              const { find } = verbBlocks('critique');
              const r = runBlock(shell, dir, find, {}, join(old, 'plugins', persona));
              ok(r.status !== 0, `${tag}: the block stops`);
              // At the preflight, which that release does not know (an earlier
              // stop, such as find-active failing, would prove nothing).
              ok(/unknown subcommand:? autopilot-preflight/i.test(r.stderr), r.stderr);
              strictEqual(await readFile(wf, 'utf8'), before);
            } finally {
              await rm(old, { recursive: true, force: true });
            }
          });
        });

        it('resume clears the previous next step', skip('critique'), async () => {
          await withRepo(async (dir) => {
            const wf = createWorkflow(dir, 'critique');
            state('append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH');
            const r = runBlock(shell, dir, fill(verbBlocks('critique').resume, '"<profile or empty>"', '""'), { ACTIVE: wf });
            strictEqual(r.status, 0, r.stderr);
            const fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.next_step_kind, fm.current_phase], [undefined, 'phase-0-resume']);
          });
        });

        // The interactive finish and the refused settlement are each verb's
        // finalize case below; this one is the autopilot branch.
        it('Phase 2 under an autopilot run: the next step only with dispatch_target on, the interactive terminal write with it off', skip('critique'), async () => {
          await withRepo(async (dir) => {
            const wf = createWorkflow(dir, 'critique');
            const r = runBlock(shell, dir, finalize('critique'), { ACTIVE: wf, RUN_ID: '', VERDICT: 'agreed', SUMMARY: 'fine', AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
            strictEqual(r.status, 0, r.stderr);
            const fm = (await readWorkflow(wf)).frontmatter;
            // On: the terminal marker is left for the commit; off: the run is
            // ignored.
            deepStrictEqual([fm.current_phase, fm.terminal_marker === true, fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence],
              [dispatchOn ? 'phase-2-presented' : 'summary-complete', !dispatchOn, 'verb', 'refine', 'HIGH']);
          });
        });

        for (const verb of VERBS) {
          it(`${verb}'s finalize: completed → the synthesis verdict, failed → failed, never launched → nothing, each then finish-verb; an empty run id hiding a launched run stops the block first`, skip(verb), async () => {
            const ok_ = await stubCompanions();
            const gone = await stubCompanions({ missing: true });
            try {
              await withRepo(async (dir) => {
                const { type } = verbBlocks(verb);
                // Contract: the dispatch's ENSEMBLE_TYPE, which this case launches the run under —
                // unread, the launch below would book the run under no type.
                ok(typeof type === 'string', 'the runbook names its ensemble type');
                const phase2 = finalize(verb);
                const vars = { VERDICT: 'agreed', SUMMARY: 'fine' };
                const results = async (wf) => {
                  const fm = (await readWorkflow(wf)).frontmatter;
                  return { fm, results: fm.ensemble_results ?? [], pending: fm.pending_ensemble ?? [] };
                };

                // Completed: the synthesis verdict, the pending row gone, the
                // terminal write with the verb's next step and declared action.
                let wf = createWorkflow(dir, verb);
                let r = launch(dir, wf, verb, type, `${type}-done`, ok_);
                strictEqual(r.status, 0, r.stderr);
                r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: `${type}-done`, ...vars });
                strictEqual(r.status, 0, r.stderr);
                let got = await results(wf);
                deepStrictEqual(got.results.map((e) => [e.run_id, e.verdict]), [[`${type}-done`, 'agreed']]);
                deepStrictEqual([got.pending.length, got.fm.current_phase, got.fm.terminal_marker, got.fm.next_step_kind, got.fm.next_step_verb, got.fm.next_step_confidence, got.fm.next_action],
                  [0, 'summary-complete', true, 'verb', NEXT_VERB[verb], 'HIGH', P.declaration.verbs[verb].next_action]);
                archive(dir, wf);

                // Launched and failed (no companion): verdict failed, whatever the synthesis said.
                wf = createWorkflow(dir, verb);
                launch(dir, wf, verb, type, `${type}-gone`, gone);
                r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: `${type}-gone`, ...vars });
                strictEqual(r.status, 0, r.stderr);
                got = await results(wf);
                deepStrictEqual(got.results.map((e) => [e.run_id, e.verdict]), [[`${type}-gone`, 'failed']]);
                deepStrictEqual([got.pending.length, got.fm.current_phase], [0, 'summary-complete']);
                archive(dir, wf);

                // Never launched: nothing recorded, the verb still finishes.
                wf = createWorkflow(dir, verb);
                r = runBlock(shell, dir, phase2, { ACTIVE: wf, RUN_ID: '', ...vars });
                strictEqual(r.status, 0, r.stderr);
                got = await results(wf);
                deepStrictEqual([got.results.length, got.pending.length, got.fm.current_phase], [0, 0, 'summary-complete']);
                archive(dir, wf);

                if (convergent(verb)) {
                  // Not converged: settled, then an append with the step that
                  // resolves what is open; the workflow stays open, an earlier
                  // verb's terminal marker turned off.
                  wf = createWorkflow(dir, verb);
                  state('set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true');
                  r = runBlock(shell, dir, finalize(verb, { converged: false }), { ACTIVE: wf, RUN_ID: '', ...vars });
                  strictEqual(r.status, 0, r.stderr);
                  ok(r.stderr.includes('PAUSED (not converged)'), r.stderr);
                  got = await results(wf);
                  deepStrictEqual([got.fm.current_phase, got.fm.terminal_marker === true, got.fm.next_step_kind, got.fm.next_step_verb],
                    ['phase-2-presented', false, 'verb', 'refine']);
                  archive(dir, wf);
                }

                // An empty run id while a launched run is pending: settle
                // refuses, and finish-verb never runs.
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

        it('decide\'s Owner selection stops at a refused clear, writing no selection; it records the choice with its next step, and inside a start lifecycle clears the gate and stops (round-2 #7, PC3b U1)', skip('decide'), async () => {
          await withRepo(async (dir) => {
            // The generated block reads the resolution from a quoted heredoc
            // (PC3 U7); the owner's words go in place of its placeholder line.
            const placeholder = '<Owner selection: the direction the owner chose, and why>';
            const raw = blocks(section(docs.decide, '## Owner selection (decide-conflict)'))[0];
            // Contract: the owner's words go into a quoted heredoc, which the shell does not expand;
            // a placeholder elsewhere would let `$` and backticks in them run.
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
            state('finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Owner: choose a direction', '--next-step-kind', 'owner-decision',
              '--next-step-confidence', 'MEDIUM', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis');
            r = runBlock(shell, dir, block);
            strictEqual(r.status, 0, r.stderr);
            const { frontmatter: fm, body } = await readWorkflow(wf);
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_action, fm.current_phase, fm.terminal_marker],
              [undefined, 'verb', 'compose', P.declaration.verbs.decide.next_action, 'summary-complete', true]);
            ok(/### Owner gate resolved: decide-conflict at [^\n]+\n\nOwner selection: option A, the \$simplest `one`/.test(body), 'the decision sits in the resolved note as written (round-3 F1)');
            archive(dir, wf);

            // Inside a /<persona>:start lifecycle the block clears the gate and
            // stops: the lifecycle owns its phase order (PC3b U1, PC3 step-7
            // peer findings 2 and 3), so the clear records no next step and
            // replaces the gate's "Owner: …" next action, and the lifecycle
            // makes its one terminal write.
            const sw = createWorkflow(dir, 'investigate', { type: 'start' });
            state('finish-verb', '--workflow-path', sw, '--host', 'claude', '--next-action', 'Owner: choose a direction', '--next-step-kind', 'owner-decision',
              '--next-step-confidence', 'MEDIUM', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis');
            r = runBlock(shell, dir, block);
            strictEqual(r.status, 0, r.stderr);
            ok(r.stderr.includes(`Resume the lifecycle with /${persona}:start`), r.stderr);
            const s = (await readWorkflow(sw)).frontmatter;
            deepStrictEqual([s.awaiting_owner_gate, s.next_step_kind, s.next_step_verb, s.next_action, s.current_phase === 'summary-complete', s.terminal_marker === true],
              [undefined, undefined, undefined, `Resume /${persona}:start: the lifecycle continues after decide with the selected direction`, false, false]);
          });
        });

        it('refine\'s Owner decision: each block resolves the workflow itself and records the decision with the next step and its next action in one write; inside a start lifecycle each clears the gate and stops (PC3b U1)', skip('refine'), async () => {
          await withRepo(async (dir) => {
            // The generated blocks read the owner's resolution from a quoted
            // heredoc (PC3 U7); the owner's words go in place of its placeholder.
            const owner = (block, placeholder, words) => {
              // Contract: the owner's words go into a quoted heredoc, which the shell does not expand.
              ok(block.includes(`\n${placeholder}\nOWNER_RESOLUTION\n`), placeholder);
              return block.replace(placeholder, words);
            };
            const [rawFix, rawDefer] = blocks(section(docs.refine, '## Owner decision (recurring-finding)')).map(dedent);
            const fixNow = owner(rawFix, '<Owner decision: fix the finding now>', 'Owner decision: fix the cache key now');
            const deferWords = owner(rawDefer, '<Owner decision: defer the finding, with the reason and where it is tracked>', 'Owner decision: defer the cache key — tracked in C99');
            // A refine that closes only once it converged sets the convergence
            // in the Defer block; converged, the deferral ends the verb.
            const defer = convergent('refine')
              ? deferWords.replace(/CONVERGED="<yes\|no[^"\n]*>"/, 'CONVERGED="yes"')
              : deferWords;
            // Contract: the Defer block's convergence step exists exactly where refine waits for it.
            ok(convergent('refine') === defer.includes('CONVERGED="yes"'), 'the convergence is set exactly where the verb waits for it');
            // The deferral's next action: the commit /<persona>:commit makes
            // (commit_surface on), or the owner's save and commit (off).
            const deferredAction = commitOn
              ? 'Commit the refined change; the recurring finding is deferred'
              : 'The recurring finding is deferred; the owner saves and commits the refined artifact';

            const wf = createWorkflow(dir, 'refine');
            const gate = (path) => state('finish-verb', '--workflow-path', path, '--host', 'claude', '--next-action', 'Owner: fix or defer', '--next-step-kind', 'owner-decision',
              '--next-step-confidence', 'HIGH', '--owner-gate', 'recurring-finding', '--owner-gate-anchor', 'recurring-finding');
            gate(wf);
            let r = runBlock(shell, dir, fixNow);
            strictEqual(r.status, 0, r.stderr);
            let fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_action], [undefined, 'verb', 'refine', 'Fix the recurring finding in this refine, then re-critique']);
            gate(wf);
            r = runBlock(shell, dir, defer);
            strictEqual(r.status, 0, r.stderr);
            const read = await readWorkflow(wf);
            fm = read.frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_action, fm.current_phase, fm.terminal_marker], [undefined, 'commit', deferredAction, 'summary-complete', true]);
            ok(/### Owner gate resolved: recurring-finding at [^\n]+\n\nOwner decision: defer the cache key — tracked in C99/.test(read.body), read.body);
            archive(dir, wf);

            if (convergent('refine')) {
              // Not converged with the finding deferred: the gate is cleared
              // with the step that resolves what is open, and no terminal write.
              const w2 = createWorkflow(dir, 'refine');
              gate(w2);
              let open = deferWords.replace(/CONVERGED="<yes\|no[^"\n]*>"/, 'CONVERGED="no"');
              open = fill(open, '"<what the next step resolves, in a few words>"', '"Re-critique the deferred finding"');
              open = fill(open, '"<refine|decide|investigate>"', 'refine');
              open = fill(open, '"<HIGH|MEDIUM|LOW>"', 'HIGH');
              r = runBlock(shell, dir, open);
              strictEqual(r.status, 0, r.stderr);
              ok(r.stderr.includes('PAUSED (not converged)'), r.stderr);
              fm = (await readWorkflow(w2)).frontmatter;
              deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_action, fm.current_phase === 'summary-complete', fm.terminal_marker === true],
                [undefined, 'verb', 'refine', 'Re-critique the deferred finding', false, false]);
              archive(dir, w2);
            }

            // Inside a /<persona>:start lifecycle the Defer block clears the
            // gate and stops: the lifecycle makes its one terminal write (PC3 U7).
            const sw = createWorkflow(dir, 'investigate', { type: 'start' });
            gate(sw);
            r = runBlock(shell, dir, defer);
            strictEqual(r.status, 0, r.stderr);
            ok(r.stderr.includes(`Resume the lifecycle with /${persona}:start`), r.stderr);
            const s = (await readWorkflow(sw)).frontmatter;
            deepStrictEqual([s.awaiting_owner_gate, s.next_step_kind, s.next_action, s.current_phase === 'summary-complete', s.terminal_marker === true],
              [undefined, 'commit', `Resume /${persona}:start: the finding is deferred, and the lifecycle continues at its terminal step`, false, false]);

            // PC3b U1 (PC3 step-7 peer finding 1): Fix now inside the lifecycle
            // clears the gate and stops: this refine's own phases, whose
            // finalize is a terminal write, do not run before the lifecycle's
            // terminal step.
            archive(dir, sw);
            const sf = createWorkflow(dir, 'refine', { type: 'start' });
            gate(sf);
            r = runBlock(shell, dir, fixNow);
            strictEqual(r.status, 0, r.stderr);
            ok(r.stderr.includes(`Resume the lifecycle with /${persona}:start`), r.stderr);
            const sfm = (await readWorkflow(sf)).frontmatter;
            deepStrictEqual([sfm.awaiting_owner_gate, sfm.next_step_kind, sfm.next_step_verb, sfm.next_action, sfm.current_phase === 'summary-complete', sfm.terminal_marker === true],
              [undefined, 'verb', 'refine', `Resume /${persona}:start: its refine phase fixes the recurring finding`, false, false]);
          });
        });
      });
    }
  }
}
