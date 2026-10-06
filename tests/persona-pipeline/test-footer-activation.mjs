// ADR-0043 S3/S4 — persona completion-footer activation tests, one suite for
// every persona the pipeline generates scripts/session-handoff.mjs into
// (ADR-0066 Decision 5).
//
// Proves each persona's terminal path CODE-SYNTHESIZES the runtime footer on
// top of the ADR-0031 projection, honoring the binding constraints:
//   - stderr / file only, NEVER stdout (the completion scripts' stdout is a
//     load-bearing machine channel)
//   - projection → footer completion flags render CONCRETE elements 2/3/4,
//     mapped from the persona's OWN terminal semantics: with commit_surface
//     off the manually-published lifecycle (completion-output contract §2:
//     only-head_moved-unmet → publish-needed), with it on blocked /
//     next-work-available and the commit (or the no-changes close) as the
//     unblocking action (ADR-0066 D4)
//   - fail-closed silent on a missing/too-old runtime or broken projection
//     (workflow still completes; no footer; no throw)
//   - at most once per terminal transition (the Stop-hook backstop does not
//     double-render what the primary already rendered); the marker contract
//     (`<projection>.footer-rendered`, {workflow_id, status}) is pinned here
//   - SessionStart reconciliation suppresses the false "missed-footer" nudge
//
// Host-free + deterministic: throwaway git repos; the runtime is pinned to the
// repo's own plugins/runtime via AGENTIC_RUNTIME_ROOT so discovery never depends
// on the host's plugin cache. Run via
// `node --test tests/persona-pipeline/test-footer-activation.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, doesNotReject, deepStrictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';

const require = createRequire(import.meta.url);
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime'); // pin discovery deterministically
const FOOTER_HEADER = 'Runtime completion footer (advisory)';
const BASELINE_HEAD = '1111111111111111111111111111111111111111';

// Workflow next actions the cases feed in. They are inputs the footer echoes
// back, never text derived from the declaration, so one wording serves every
// persona. PUBLISH_NEXT must differ from the derived owner-publish action
// (`Save/commit the <deliverable_noun> …`) so an echo of the input can never
// satisfy an assertion on the derived text.
const CRITIQUE_NEXT = 'Critique the composed deliverable draft';
const PUBLISH_NEXT = 'Save/commit the composed draft';

function initRepo(root) {
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'footer-e2e'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'footer-e2e@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: root });
}

// Capture process.stderr.write around an async fn (the direct-call channel).
// The stand-in calls the write callback, as a stream does once the chunk is
// delivered: the sidecar counts a footer as rendered only then.
async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s, encoding, cb) => {
    chunks.push(String(s));
    const done = typeof encoding === 'function' ? encoding : cb;
    if (done) setImmediate(() => done());
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// A runtime version just above the persona's declared footer floor, so the
// stub below passes the discovery version gate for every persona (0.80.0 for
// today's 0.79.0 floor). A stub under the floor would be discarded by
// discovery and the degraded case would pass without ever reaching the
// projection_error validation it pins.
function versionAboveFloor(floor) {
  const [major, minor] = String(floor).split('-', 1)[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  return `${major}.${minor + 1}.0`;
}

// Build a STUB runtime whose footer.mjs emits a chosen body — used to force the
// degraded (projection_error) path deterministically, since the real footer.mjs
// accepts the valid projection the sidecar writes.
async function writeStubRuntime(root, footerMjs, { version }) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'footer.mjs'), footerMjs);
  return root;
}

// A stub footer that ALWAYS reports a rejected projection (projection_error set,
// no session_handoff) but still exits 0 — the exact footer.mjs degraded shape.
const DEGRADED_FOOTER = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('json')) {
  process.stdout.write(JSON.stringify({ command: 'render', projection_error: 'stub: projection rejected' }));
} else {
  process.stdout.write('Runtime completion footer (advisory)\\nworkflow projection rejected (degraded to context-state only): stub\\n');
}
process.exit(0);
`;

// A stub footer that renders the workflow_id of the projection file it is
// given, after `delayMs` in each run; with `slot`, its JSON run also writes a
// different workflow's projection to the slot, as a concurrent cross-branch
// emit would between the sidecar's two footer runs.
function echoFooter({ delayMs = 0, slot = null } = {}) {
  return `import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const file = argv[argv.indexOf('--workflow-projection-file') + 1];
const id = JSON.parse(readFileSync(file, 'utf8')).workflow_id;
await new Promise((r) => setTimeout(r, ${delayMs}));
if (argv.includes('json')) {
  ${slot ? `writeFileSync(${JSON.stringify(slot)}, JSON.stringify({ workflow_id: 'other-workflow' }));` : ''}
  process.stdout.write(JSON.stringify({ command: 'render', session_handoff: {} }));
} else {
  process.stdout.write('Runtime completion footer (advisory)\\nrendered workflow: ' + id + '\\n');
}
`;
}

for (const persona of personasFor('scripts/session-handoff.mjs')) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const PROJECTION_REL = `${P.stateDirRel}/last-session-handoff.json`;
  const PENDING_MARK = `[${P.handoffTag}]`;
  const OWNER_PUBLISH = `Save/commit the ${P.deliverableNoun}`;
  // The head_moved unblocking action: the owner publishes (commit_surface off)
  // or the persona's work is committed (on).
  const HEAD_MOVED_ACTION = P.capabilities.commit_surface
    ? 'Commit the completed work so HEAD moves past the workflow baseline'
    : OWNER_PUBLISH;
  const AUTOPILOT_RUN = 'autopilot-20261006T000000Z-abcdef';
  // Any profile string works (state.mjs stores it verbatim); use one the
  // persona declares when it has profile presets.
  const PROFILE = P.capabilities.profile_presets
    ? Object.keys(P.declaration.decide.profile_presets)[0]
    : 'plan';
  const {
    emitTerminalHandoffSidecar,
    mapCompletionFlags,
    pendingHandoffReinjectionLine,
  } = await import(pathToFileURL(P.path('scripts/session-handoff.mjs')).href);

  function createWorkflow(root, { branch = 'feat/x', baselineHead = BASELINE_HEAD } = {}) {
    return execFileSync(
      'node',
      [
        STATE, 'create', '--repo-root', root,
        '--verb', 'compose', '--host', 'claude', '--persona', persona,
        '--git-baseline-branch', branch, '--git-baseline-head', baselineHead,
        '--status-digest', 'deadbeef',
        '--profile', PROFILE, '--original-request', 'footer activation test',
        '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
      ],
      { encoding: 'utf8' },
    ).trim();
  }

  // Run the CLI set-terminal (the REAL primary path) with the runtime pinned.
  function cliSetTerminal(root, workflowPath, nextAction) {
    return spawnSync(
      'node',
      [
        STATE, 'set-terminal', '--workflow-path', workflowPath, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'true',
        '--next-action', nextAction, '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root, env: { ...process.env, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT } },
    );
  }

  describe(`${persona}: completion-footer activation (ADR-0043 S3/S4)`, () => {
    it('CLI set-terminal renders the footer on STDERR, never stdout (machine channel intact)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-stderr-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const res = cliSetTerminal(root, wf, CRITIQUE_NEXT);

      strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
      // stdout stays byte-for-byte path-only — the footer must not leak to it.
      strictEqual(res.stdout, `${wf}\n`, 'stdout must remain path-only');
      ok(!res.stdout.includes(FOOTER_HEADER), 'footer must NOT appear on stdout');
      ok(res.stderr.includes(FOOTER_HEADER), 'footer header must appear on stderr');
    });

    // PC2b: the runbooks' terminal write is finish-verb now. It takes
    // set-terminal's path, footer included; an owner gate is no terminal
    // write, so no footer. An inherited AGENTIC_AUTOPILOT changes nothing with
    // dispatch_target off (ADR-0066 Decision 3); with it on, a named run on
    // Claude is autopilot mode, whose finish-verb records the next step only
    // (no terminal write, so no footer: the driver is the handoff).
    it('CLI finish-verb renders the footer on STDERR like set-terminal; an owner gate renders none, and so does an autopilot run with dispatch_target on (PC2b, ADR-0066 D3)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-finish-`));
      initRepo(root);
      const finish = (wf, extra, env = {}) => spawnSync(
        'node',
        [STATE, 'finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', CRITIQUE_NEXT, '--next-step-confidence', 'HIGH', ...extra],
        { encoding: 'utf8', cwd: root, env: { ...process.env, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT, ...env } },
      );
      const inherited = P.capabilities.dispatch_target ? {} : { AGENTIC_AUTOPILOT: AUTOPILOT_RUN };
      const wf = createWorkflow(root);
      const res = finish(wf, ['--next-step-kind', 'verb', '--next-step-verb', 'critique'], inherited);
      strictEqual(res.status, 0, res.stderr);
      strictEqual(res.stdout, `${wf}\n`, 'stdout must remain path-only');
      ok(res.stderr.includes(FOOTER_HEADER), `footer header must appear on stderr; got:\n${res.stderr}`);
      ok(res.stderr.includes(`recommended next work: ${CRITIQUE_NEXT}`), res.stderr);
      const gated = createWorkflow(root, { branch: 'feat/gated' });
      const held = finish(gated, ['--next-step-kind', 'owner-decision', '--owner-gate', 'scope-routing', '--owner-gate-anchor', 'routing-recommendation'], inherited);
      strictEqual(held.status, 0, held.stderr);
      ok(!held.stderr.includes(FOOTER_HEADER), `an owner gate is no terminal write: no footer; got:\n${held.stderr}`);
      ok(held.stderr.includes('owner gate scope-routing recorded'), held.stderr);
      if (P.capabilities.dispatch_target) {
        const auto = createWorkflow(root, { branch: 'feat/auto' });
        const run = finish(auto, ['--next-step-kind', 'verb', '--next-step-verb', 'critique'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN });
        strictEqual(run.status, 0, run.stderr);
        ok(!run.stderr.includes(FOOTER_HEADER), `autopilot finish-verb makes no terminal write: no footer; got:\n${run.stderr}`);
        ok(!/terminal_marker:\s*true/.test(await readFile(auto, 'utf8')), 'the terminal marker stays unset under autopilot');
      }
    });

    it('promotes elements 2/3/4/7 to CONCRETE (completion state + recommended next work + continue-vs-fresh)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-elements-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const res = cliSetTerminal(root, wf, CRITIQUE_NEXT);

      strictEqual(res.status, 0, res.stderr);
      // element 3/4: the concrete next action flows into recommended-next-work.
      ok(
        res.stderr.includes(`recommended next work: ${CRITIQUE_NEXT}`),
        `recommended next work must be concrete; got:\n${res.stderr}`,
      );
      // completion state is one of the persona's mapped values (never the
      // generic default) — publish-needed is the manually-published mapping.
      match(res.stderr, /completion state: (next-work-available|publish-needed|blocked)/);
      // element 7/8: the continue-vs-fresh session handoff renders.
      ok(res.stderr.includes('session handoff (continue-vs-fresh)'), 'session handoff must render');
      // host localization (claude) — commands are /-prefixed.
      match(res.stderr, new RegExp(`/(${persona}|runtime):`));
    });

    // The sidecar owns no context-budget sensor. It used to pass a hard-coded
    // `--context-state yellow`, which the footer could only read as a caller
    // ASSERTION — so a fabricated value was rendered as if someone had looked,
    // and `session_handoff.context_risk_supplied` was stuck `true`, making the
    // runtime's own honest-fallback branch (footer.mjs, `=== false`) unreachable.
    // Passing nothing is the honest statement of "I measured nothing": runtime
    // still applies the same conservative yellow, and now says whose it is.
    it('declares no context state — an unmeasured default renders as unmeasured, not as a caller assertion', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-unmeasured-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const res = cliSetTerminal(root, wf, 'Critique the composed artifact');

      strictEqual(res.status, 0, res.stderr);
      ok(
        res.stderr.includes('context state: unmeasured (no budget sensor)'),
        `context state must render as unmeasured; got:\n${res.stderr}`,
      );
      ok(
        res.stderr.includes("context risk: yellow is runtime's conservative fallback"),
        `session handoff must name the fallback as runtime's; got:\n${res.stderr}`,
      );
      ok(
        !res.stderr.includes('[declared, not measured]'),
        `sidecar must not declare a context state it never measured; got:\n${res.stderr}`,
      );
    });

    it('is idempotent: the Stop-hook backstop does NOT re-render what the primary rendered', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-idem-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const markerFile = `${projectionFile}.footer-rendered`;

      // PRIMARY (marker absent → renders + writes marker).
      const primary = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
      strictEqual(primary.value.emitted, true);
      strictEqual(primary.value.footerRendered, true, 'primary must render the footer');
      ok(primary.stderr.includes(FOOTER_HEADER), 'primary emits the footer to stderr');
      ok(await exists(markerFile), 'primary writes the idempotency marker');
      // MARKER CONTRACT pin (ADR-0043 §2 documented cross-package contract):
      // sibling `<projection>.footer-rendered`, JSON {workflow_id, status:'rendered'}.
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
      strictEqual(marker.workflow_id, projection.workflow_id, 'marker keys on the terminalized workflow_id');
      strictEqual(marker.status, 'rendered', "a completed render upgrades the marker to 'rendered'");
      // The attention sensor's transition anchor is load-bearing on this field
      // (ADR-0043 §3): the render moment must be a parseable ISO-8601 UTC stamp.
      ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(marker.at),
        `marker.at must be ISO-8601 UTC; got: ${marker.at}`);

      // BACKSTOP (marker present → must NOT re-render).
      const backstop = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
      strictEqual(backstop.value.emitted, true);
      strictEqual(backstop.value.footerRendered, true, 'reports rendered (idempotent), from the marker');
      ok(!backstop.stderr.includes(FOOTER_HEADER), 'backstop must NOT emit a second footer');
    });

    it('fail-closed on a MISSING/too-old runtime: no footer, still emitted, no throw', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-noruntime-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, 'proj.json');

      const saved = process.env.AGENTIC_RUNTIME_ROOT;
      process.env.AGENTIC_RUNTIME_ROOT = join(root, 'no-such-runtime');
      try {
        const { value, stderr } = await captureStderr(() =>
          emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
        strictEqual(value.emitted, true, 'projection still written (guaranteed channel)');
        strictEqual(value.footerRendered, false, 'no footer when runtime is missing');
        ok(!stderr.includes(FOOTER_HEADER), 'no footer text on a fail-closed render');
        ok(await exists(projectionFile), 'the projection file is still written');
      } finally {
        if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
        else process.env.AGENTIC_RUNTIME_ROOT = saved;
      }
    });

    it('fail-closed on a broken projection: no footer, no file, no throw', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-brokenproj-`));
      const projectionFile = join(root, 'proj.json');
      // workflowPath does not resolve → non-ok projection status.
      const { value, stderr } = await captureStderr(() =>
        emitTerminalHandoffSidecar({
          repoRoot: root, workflowPath: join(root, 'nope.md'), projectionFile, host: 'claude',
        }));
      strictEqual(value.emitted, false);
      ok(!stderr.includes(FOOTER_HEADER), 'no footer when the projection is not ok');
      strictEqual(await exists(projectionFile), false, 'no projection file on a non-ok status');
      await doesNotReject(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: join(root, 'nope.md'), projectionFile }));
    });

    it('SessionStart reconciliation: a rendered footer suppresses the nudge; a missed footer keeps it', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-reconcile-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);

      // Rendered: primary emits + marks → pending line is suppressed (null).
      await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' });
      const afterRender = await pendingHandoffReinjectionLine(root);
      ok(afterRender, 'a pending handoff exists');
      strictEqual(afterRender.line, null, 'a rendered footer suppresses the missed-footer nudge');
      strictEqual(afterRender.footerRendered, true);

      // Missed: no marker (fresh projection, runtime forced missing) → nudge stays.
      const root2 = await mkdtemp(join(tmpdir(), `${persona}-footer-reconcile-missed-`));
      initRepo(root2);
      const wf2 = createWorkflow(root2);
      const projectionFile2 = join(root2, PROJECTION_REL);
      const saved = process.env.AGENTIC_RUNTIME_ROOT;
      process.env.AGENTIC_RUNTIME_ROOT = join(root2, 'no-such-runtime');
      try {
        await emitTerminalHandoffSidecar({ repoRoot: root2, workflowPath: wf2, projectionFile: projectionFile2, host: 'claude' });
      } finally {
        if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
        else process.env.AGENTIC_RUNTIME_ROOT = saved;
      }
      const afterMiss = await pendingHandoffReinjectionLine(root2);
      ok(afterMiss, 'a pending handoff exists');
      ok(afterMiss.line && afterMiss.line.includes(PENDING_MARK), 'a missed footer keeps the nudge');
    });

    it('fail-closed on a DEGRADED render (footer.mjs reports projection_error): no mark, nudge fires', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-degraded-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const markerFile = `${projectionFile}.footer-rendered`;
      // Point discovery at a stub runtime whose footer.mjs exits 0 but reports a
      // projection_error (no session_handoff) — the JSON validation must reject it.
      const stub = await writeStubRuntime(
        await mkdtemp(join(tmpdir(), `${persona}-stub-rt-`)),
        DEGRADED_FOOTER,
        { version: versionAboveFloor(P.runtimeFooterFloor) },
      );
      const saved = process.env.AGENTIC_RUNTIME_ROOT;
      process.env.AGENTIC_RUNTIME_ROOT = stub;
      try {
        const { value, stderr } = await captureStderr(() =>
          emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
        strictEqual(value.emitted, true, 'projection still written');
        strictEqual(value.footerRendered, false, 'a projection_error render must NOT count as rendered');
        ok(!stderr.includes(FOOTER_HEADER), 'the degraded footer text must not be emitted');
        strictEqual(await exists(markerFile), false, 'no marker (claim released) on a degraded render');
      } finally {
        if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
        else process.env.AGENTIC_RUNTIME_ROOT = saved;
      }
      // The nudge must still fire (the footer was NOT delivered).
      const pending = await pendingHandoffReinjectionLine(root);
      ok(pending && pending.line && pending.line.includes(PENDING_MARK),
        'a degraded render keeps the SessionStart nudge as a backstop');
    });

    // Completion-output contract — the sidecar maps completion flags from the
    // persona's OWN terminal semantics, names the phase + failed gates, and
    // always passes the explicit next action on publish-needed/blocked. With
    // commit_surface off the lifecycle is manually published (§2:
    // only-head_moved-unmet → publish-needed); with it on, head_moved is
    // blocked with the commit as its unblocking action (ADR-0066 D4).
    describe('completion-flag minimum content (completion-output contract)', () => {
      const projection = {
        workflow_kind: persona,
        workflow_id: 'compose-20260713T000000Z-abc123',
        workflow_path: `${P.workflowDirRel}/compose-20260713T000000Z-abc123.md`,
        phase: 'summary-complete',
        next_action: PUBLISH_NEXT,
        archive_gate: 'ready_to_archive',
        routing_recommendation: `${P.commandPrefix}resume`,
      };

      if (!P.capabilities.commit_surface) {
        it('maps only-head_moved-unmet to publish-needed with the owner-publish next action (commit_surface off)', () => {
          const flags = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['head_moved']);
          strictEqual(flags.state, 'publish-needed');
          ok(flags.reason.includes('terminal phase summary-complete'), flags.reason);
          ok(flags.reason.includes('head_moved'), 'the reason names the single unmet gate token');
          ok(flags.reason.includes('git probe'), 'the reason must not overclaim a single cause (fail-closed collapse)');
          ok(flags.completionNextAction.includes(OWNER_PUBLISH), flags.completionNextAction);
          ok(!/[\r\n]/.test(flags.reason), 'reason must stay single-line');
          ok(!/[\r\n]/.test(flags.completionNextAction), 'next action must stay single-line');
        });
      } else {
        it('maps only-head_moved-unmet to blocked with the commit as its unblocking action, never publish-needed (commit_surface on)', () => {
          const flags = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['head_moved']);
          strictEqual(flags.state, 'blocked');
          ok(flags.reason.includes('at phase summary-complete but archive gate(s) unmet: head_moved'), flags.reason);
          ok(flags.completionNextAction.includes(HEAD_MOVED_ACTION), flags.completionNextAction);
          ok(flags.completionNextAction.includes('a failed git probe also reports this gate'), flags.completionNextAction);
          ok(!flags.completionNextAction.includes('Save/commit the'), 'no owner-publish action where the persona commits');
          ok(!/[\r\n]/.test(flags.completionNextAction), 'next action must stay single-line');
        });

        // ADR-0063 — a no-changes close makes no commit, so HEAD is not meant to
        // move: its unblocking action is the close again, never a commit.
        it('a close-complete workflow blocked on head_moved names the no-changes close, not a commit (commit_surface on)', () => {
          const flags = mapCompletionFlags({ ...projection, phase: 'close-complete', archive_gate: 'blocked' }, ['head_moved']);
          strictEqual(flags.state, 'blocked');
          ok(flags.completionNextAction.startsWith(`Finish the no-changes close: run ${P.commandPrefix}commit ($${persona}:commit on Codex) again`), flags.completionNextAction);
          ok(!flags.completionNextAction.includes(HEAD_MOVED_ACTION), flags.completionNextAction);
        });
      }

      it('head_moved mixed with another gate stays blocked (genuinely blocking evidence)', () => {
        const flags = mapCompletionFlags(
          { ...projection, archive_gate: 'blocked' },
          ['head_moved', 'no_active_children'],
        );
        strictEqual(flags.state, 'blocked');
        ok(flags.reason.includes('archive gate(s) unmet: head_moved, no_active_children'), flags.reason);
        ok(flags.completionNextAction.includes(HEAD_MOVED_ACTION), flags.completionNextAction);
        ok(flags.completionNextAction.includes('child-completion entries'), flags.completionNextAction);
      });

      // PC2b (ADR-0063 D6 gate 5): a pending owner gate is blocked, names
      // the resolving surfaces in this persona's commands, and outranks the
      // owner's publish. The gates a capability owns are named only where it
      // is on (staging-set: commit_surface; pr-handling: dispatch_target).
      it('a pending owner gate is blocked with its resolving surfaces, alone or beside head_moved', () => {
        for (const gates of [['awaiting_owner'], ['head_moved', 'awaiting_owner']]) {
          const flags = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, gates);
          strictEqual(flags.state, 'blocked', gates.join(','));
          ok(flags.reason.includes(`archive gate(s) unmet: ${gates.join(', ')}`), flags.reason);
          ok(flags.completionNextAction.includes('Resolve the pending owner gate (awaiting_owner_gate)'), flags.completionNextAction);
          ok(flags.completionNextAction.includes(`Owner selection step of ${P.commandPrefix}decide`), flags.completionNextAction);
          ok(flags.completionNextAction.includes(`Owner decision step of ${P.commandPrefix}refine`), flags.completionNextAction);
          strictEqual(flags.completionNextAction.includes(`staging-set, an interactive ${P.commandPrefix}commit`), P.capabilities.commit_surface,
            `staging-set is named exactly with commit_surface on; got: ${flags.completionNextAction}`);
          strictEqual(flags.completionNextAction.includes('pr-handling, the owner takes or declines the outward action'), P.capabilities.dispatch_target,
            `pr-handling is named exactly with dispatch_target on; got: ${flags.completionNextAction}`);
          ok(!flags.completionNextAction.includes('Resolve the unmet archive gate(s)'), 'a known gate, not the unknown-gate fallback');
          ok(!/[\r\n]/.test(flags.completionNextAction), 'next action must stay single-line');
        }
      });

      it('a non-head_moved gate alone is blocked, never publish-needed, and lists the persona\'s terminal phases', () => {
        const flags = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['terminal_phase']);
        strictEqual(flags.state, 'blocked');
        ok(flags.completionNextAction.includes('archive-whitelisted terminal phase'), flags.completionNextAction);
        const phases = P.capabilities.commit_surface
          ? '(commit-complete, summary-complete, fix-complete, or close-complete)'
          : '(commit-complete, summary-complete, or fix-complete)';
        ok(flags.completionNextAction.includes(phases), flags.completionNextAction);
      });

      it('names the phase on the non-blocked archive-gate states (no unblocking action)', () => {
        const ready = mapCompletionFlags({ ...projection, archive_gate: 'ready_to_archive' });
        ok(ready.reason.includes('at phase summary-complete'), ready.reason);
        strictEqual(ready.state, 'next-work-available');
        strictEqual(ready.completionNextAction, undefined, 'no unblocking action when not blocked');

        const notTerminal = mapCompletionFlags({ ...projection, archive_gate: 'not_terminal' }, ['terminal_marker']);
        ok(notTerminal.reason.includes('at phase summary-complete'), notTerminal.reason);
        strictEqual(notTerminal.state, 'next-work-available');
        strictEqual(notTerminal.completionNextAction, undefined);
      });

      it('always passes an explicit unblocking action when blocked — unknown gates get the sidecar fallback', () => {
        const empty = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, []);
        strictEqual(empty.state, 'blocked', 'no gate evidence → conservative blocked, never publish-needed');
        ok(empty.reason.includes('archive gate(s) unmet: unknown'), empty.reason);
        strictEqual(
          empty.completionNextAction,
          'Resolve the unmet archive gate(s): unknown (see the workflow phase notes).',
        );

        const future = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['future_gate']);
        strictEqual(future.state, 'blocked');
        strictEqual(
          future.completionNextAction,
          'Resolve the unmet archive gate(s): future_gate (see the workflow phase notes).',
        );
      });

      it('a known gate MIXED with an unknown one keeps both: specific action + fallback naming the unknown (Codex Plan-verify)', () => {
        const mixed = mapCompletionFlags(
          { ...projection, archive_gate: 'blocked' },
          ['head_moved', 'future_gate'],
        );
        strictEqual(mixed.state, 'blocked');
        ok(mixed.reason.includes('head_moved, future_gate'), mixed.reason);
        ok(mixed.completionNextAction.includes(HEAD_MOVED_ACTION),
          'the known token keeps its specific action');
        ok(mixed.completionNextAction.includes('Resolve the unmet archive gate(s): future_gate'),
          `the unknown token must not ride silently beside a known one; got: ${mixed.completionNextAction}`);
      });

      it('single-lines multi-line projection values — a multi-line next_action must not kill the footer render (Codex Plan-verify)', () => {
        const flags = mapCompletionFlags({
          ...projection,
          next_action: `${PUBLISH_NEXT}\nthen start the next deliverable`,
          phase: 'summary-complete\r\nextra',
          archive_gate: 'ready_to_archive',
        });
        ok(!/[\r\n]/.test(flags.recommendedNextWork), flags.recommendedNextWork);
        ok(!/[\r\n]/.test(flags.reason), flags.reason);
        strictEqual(flags.recommendedNextWork, `${PUBLISH_NEXT} then start the next deliverable`);
      });

      it(`E2E: an unmoved-HEAD terminal renders ${P.capabilities.commit_surface ? 'blocked with the commit action' : 'publish-needed'} and stays generic-marker-free`, async () => {
        const root = await mkdtemp(join(tmpdir(), `${persona}-footer-publish-`));
        initRepo(root);
        // Baseline the workflow at the REAL current HEAD so head_moved is the
        // ONLY unmet gate at set-terminal time — the common "work ready, not
        // committed yet" terminal (with commit_surface off: the owner has not
        // saved/committed the deliverable yet).
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        const wf = createWorkflow(root, { baselineHead: head });
        // Precondition: the echoed input cannot satisfy the derived-action check.
        ok(!PUBLISH_NEXT.includes(HEAD_MOVED_ACTION), 'the input next action must differ from the derived one');
        const res = cliSetTerminal(root, wf, PUBLISH_NEXT);

        strictEqual(res.status, 0, res.stderr);
        if (P.capabilities.commit_surface) {
          ok(res.stderr.includes('completion state: blocked'), res.stderr);
          ok(
            res.stderr.includes('archive gate(s) unmet: head_moved'),
            `reason must name the failed gate; got:\n${res.stderr}`,
          );
        } else {
          ok(res.stderr.includes('completion state: publish-needed'), res.stderr);
          ok(
            res.stderr.includes('the only unmet archive gate is head_moved'),
            `reason must name the single failed gate; got:\n${res.stderr}`,
          );
        }
        ok(
          res.stderr.includes(`completion next action: ${HEAD_MOVED_ACTION}`),
          `the head_moved unblocking action must render; got:\n${res.stderr}`,
        );
        // The sidecar passes every completion flag explicitly — a persona terminal
        // footer must never surface a runtime generic-fallback marker (§3.2).
        ok(!res.stderr.includes('[generic fallback]'), 'sidecar footers must be generic-marker-free');
      });

      it('E2E: a moved-HEAD terminal renders next-work-available and names the phase', async () => {
        const root = await mkdtemp(join(tmpdir(), `${persona}-footer-ready-`));
        initRepo(root);
        const wf = createWorkflow(root); // baseline 1111… ≠ real HEAD → head_moved passes
        const res = cliSetTerminal(root, wf, CRITIQUE_NEXT);
        strictEqual(res.status, 0, res.stderr);
        ok(res.stderr.includes('completion state: next-work-available'), res.stderr);
        ok(
          res.stderr.includes('completion reason: Workflow at phase summary-complete is terminal and archive-ready'),
          `reason must name the phase; got:\n${res.stderr}`,
        );
        ok(!res.stderr.includes('[generic fallback]'), 'sidecar footers must be generic-marker-free');
      });
    });

    it('a PRIMARY re-terminalization re-renders over its own rendered tombstone; a backstop does not', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-reterm-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);

      // First transition (primary) renders and leaves a rendered marker.
      const first = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude', origin: 'primary' }));
      strictEqual(first.value.footerRendered, true);
      ok(first.stderr.includes(FOOTER_HEADER), 'first primary render fires');

      // A backstop emit over the tombstone must NOT re-render…
      const backstop = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
      strictEqual(backstop.value.footerRendered, true, 'reports rendered from the tombstone');
      ok(!backstop.stderr.includes(FOOTER_HEADER), 'backstop stays tombstone-suppressed');

      // …but a NEW primary transition (re-terminalization) renders again.
      const second = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude', origin: 'primary' }));
      strictEqual(second.value.footerRendered, true);
      ok(second.stderr.includes(FOOTER_HEADER), 'a primary re-terminalization renders over the tombstone');
    });

    it("a 'claimed' (in-progress/crashed) marker does not suppress the nudge — only 'rendered' does", async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-claimed-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const markerFile = `${projectionFile}.footer-rendered`;
      // Emit a projection (no runtime → no render, no marker), then simulate a
      // crashed/in-progress claim by writing a 'claimed' marker for this workflow.
      const saved = process.env.AGENTIC_RUNTIME_ROOT;
      process.env.AGENTIC_RUNTIME_ROOT = join(root, 'no-such-runtime');
      try {
        await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' });
      } finally {
        if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
        else process.env.AGENTIC_RUNTIME_ROOT = saved;
      }
      const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
      await writeFile(markerFile, `${JSON.stringify({ workflow_id: projection.workflow_id, status: 'claimed', at: '2026-01-01T00:00:00Z' })}\n`, 'utf8');
      const pending = await pendingHandoffReinjectionLine(root);
      ok(pending && pending.line && pending.line.includes(PENDING_MARK),
        "a bare 'claimed' marker must NOT suppress the nudge");
    });

    // ---- D4 hardening (PC3, Codex Plan-verify) ----------------------------------

    // state.mjs passes origin 'primary' from the must-run terminal write: a
    // re-terminalization renders again even when its phase and next action
    // equal the transition that already rendered.
    it('CLI: re-running set-terminal with the same phase and next action renders the footer again', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-cli-reterm-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const first = cliSetTerminal(root, wf, CRITIQUE_NEXT);
      strictEqual(first.status, 0, first.stderr);
      ok(first.stderr.includes(FOOTER_HEADER), first.stderr);
      const second = cliSetTerminal(root, wf, CRITIQUE_NEXT);
      strictEqual(second.status, 0, second.stderr);
      ok(second.stderr.includes(FOOTER_HEADER), `the primary emit renders over its own tombstone; got:\n${second.stderr}`);
    });

    // TRANSITION IDENTITY — a later terminal transition of the same workflow
    // whose primary emit was missed (a crash after the terminal write; the
    // no-changes close, whose primary emit the commit driver turns off) renders
    // at the Stop backstop, once, instead of being suppressed by the earlier
    // transition's tombstone.
    const laterTransitions = [['commit-complete', 'Start the next deliverable']];
    if (P.capabilities.commit_surface) laterTransitions.push(['close-complete', 'archive']);
    for (const [phase, nextAction] of laterTransitions) {
      it(`a later ${phase} transition whose primary emit was missed renders at the backstop, once`, async () => {
        const { setTerminal } = await import(pathToFileURL(STATE).href);
        const root = await mkdtemp(join(tmpdir(), `${persona}-footer-later-`));
        initRepo(root);
        const wf = createWorkflow(root);
        const markerFile = `${join(root, PROJECTION_REL)}.footer-rendered`;
        const first = cliSetTerminal(root, wf, CRITIQUE_NEXT);
        strictEqual(first.status, 0, first.stderr);
        ok(first.stderr.includes(FOOTER_HEADER), first.stderr);
        const earlier = JSON.parse(await readFile(markerFile, 'utf8'));
        strictEqual(earlier.status, 'rendered');
        // The later terminal write lands; its primary emit never runs.
        await setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: phase, nextAction });
        const backstop = await captureStderr(() =>
          emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude' }));
        strictEqual(backstop.value.footerRendered, true);
        ok(backstop.stderr.includes(FOOTER_HEADER), `the later transition renders at the backstop; got:\n${backstop.stderr}`);
        ok(backstop.stderr.includes(`recommended next work: ${nextAction}`), backstop.stderr);
        const later = JSON.parse(await readFile(markerFile, 'utf8'));
        strictEqual(later.workflow_id, earlier.workflow_id);
        strictEqual(later.status, 'rendered');
        ok(typeof later.transition === 'string' && later.transition !== earlier.transition,
          `the marker names the later transition: ${JSON.stringify([earlier, later])}`);
        const again = await captureStderr(() =>
          emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude' }));
        ok(!again.stderr.includes(FOOTER_HEADER), 'only once: the next backstop is suppressed');
      });
    }

    it("SessionStart: an earlier transition's render does not suppress the nudge for a later one; a marker without a transition does", async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-later-nudge-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const markerFile = `${projectionFile}.footer-rendered`;
      const first = cliSetTerminal(root, wf, CRITIQUE_NEXT);
      strictEqual(first.status, 0, first.stderr);
      const rendered = await readFile(projectionFile, 'utf8');
      // A later transition's projection reached the slot and its render did not.
      const later = JSON.stringify({ ...JSON.parse(rendered), phase: 'commit-complete', next_action: 'Start the next deliverable' });
      await writeFile(projectionFile, later);
      const pending = await pendingHandoffReinjectionLine(root);
      ok(pending && pending.line && pending.line.includes(PENDING_MARK), 'the later transition keeps its nudge');
      // Control: the transition that rendered is suppressed.
      await writeFile(projectionFile, rendered);
      strictEqual((await pendingHandoffReinjectionLine(root)).line, null);
      // A marker written before the field existed matches any transition of its workflow.
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      delete marker.transition;
      await writeFile(markerFile, `${JSON.stringify(marker)}\n`);
      await writeFile(projectionFile, later);
      strictEqual((await pendingHandoffReinjectionLine(root)).line, null);
    });

    it('a footer whose stderr write fails after it returned counts as not rendered: no marker, and the nudge fires', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-undelivered-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const markerFile = `${projectionFile}.footer-rendered`;
      const orig = process.stderr.write;
      const writes = [];
      // Each write is accepted, then fails: an asynchronous EPIPE on a pipe.
      process.stderr.write = (chunk, encoding, cb) => {
        writes.push(String(chunk));
        const done = typeof encoding === 'function' ? encoding : cb;
        setImmediate(() => done?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        return true;
      };
      let value;
      try {
        value = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude', origin: 'primary' });
      } finally {
        process.stderr.write = orig;
      }
      ok(writes.some((w) => w.includes(FOOTER_HEADER)), 'the footer was written, and its delivery failed');
      strictEqual(value.emitted, true);
      strictEqual(value.footerRendered, false, 'an undelivered footer is not rendered');
      strictEqual(await exists(markerFile), false, 'the claim is released');
      const pending = await pendingHandoffReinjectionLine(root);
      ok(pending && pending.line && pending.line.includes(PENDING_MARK), 'the SessionStart nudge fires');
    });

    // Phase 0 of the next verb moves the phase on without clearing the
    // inherited terminal marker; that reopening is no new completion.
    it('a workflow reopened with its terminal marker inherited renders no footer at the Stop backstop', async () => {
      const { appendPhase } = await import(pathToFileURL(STATE).href);
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-reopen-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const first = cliSetTerminal(root, wf, CRITIQUE_NEXT);
      strictEqual(first.status, 0, first.stderr);
      ok(first.stderr.includes(FOOTER_HEADER), first.stderr);
      await appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'Phase 0: Resume into critique', phaseNote: 'Resumed.', currentPhase: 'phase-0-resume', nextAction: 'Run critique skill', event: 'resumed' });
      const fm = (await import(pathToFileURL(STATE).href)).readWorkflow;
      strictEqual((await fm(wf)).frontmatter.terminal_marker, true, 'control: the marker is inherited');
      const backstop = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude' }));
      ok(!backstop.stderr.includes(FOOTER_HEADER), `a reopened workflow renders no footer; got:\n${backstop.stderr}`);
    });

    // A failed write calls back with the error and then emits 'error' on the
    // stream; with no listener left that event would crash the completion.
    it('a stderr error event after the failed write callback does not crash the emit', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-epipe-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const orig = process.stderr.write;
      process.stderr.write = (chunk, encoding, cb) => {
        const done = typeof encoding === 'function' ? encoding : cb;
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        setImmediate(() => {
          done?.(error);
          process.nextTick(() => process.stderr.emit('error', error));
        });
        return true;
      };
      let value;
      try {
        value = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude', origin: 'primary' });
        await new Promise((r) => setImmediate(r));
      } finally {
        process.stderr.write = orig;
      }
      strictEqual(value.emitted, true);
      strictEqual(value.footerRendered, false);
    });

    it('renders from its own snapshot: a write to the slot between the two footer runs does not reach the footer', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-overlap-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const projectionFile = join(root, PROJECTION_REL);
      const stub = await writeStubRuntime(
        await mkdtemp(join(tmpdir(), `${persona}-stub-rt-`)),
        echoFooter({ slot: projectionFile }),
        { version: versionAboveFloor(P.runtimeFooterFloor) },
      );
      const saved = process.env.AGENTIC_RUNTIME_ROOT;
      process.env.AGENTIC_RUNTIME_ROOT = stub;
      try {
        const { value, stderr } = await captureStderr(() =>
          emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
        strictEqual(value.footerRendered, true, stderr);
        const id = JSON.parse(await readFile(projectionFile, 'utf8')).workflow_id ?? '';
        strictEqual(id, 'other-workflow', 'control: the slot was overwritten between the runs');
        ok(stderr.includes(`rendered workflow: ${basename(wf, '.md')}\n`), stderr);
        ok(!stderr.includes('rendered workflow: other-workflow'), stderr);
      } finally {
        if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
        else process.env.AGENTIC_RUNTIME_ROOT = saved;
      }
    });

    // A terminal workflow whose first transition rendered and whose later
    // transition (commit-complete) is written without its primary emit: the
    // marker holds the earlier render, which every backstop of the later
    // transition may take over.
    async function laterTransitionPending(prefix) {
      const { setTerminal } = await import(pathToFileURL(STATE).href);
      const root = await mkdtemp(join(tmpdir(), `${persona}-${prefix}-`));
      initRepo(root);
      const wf = createWorkflow(root);
      const markerFile = `${join(root, PROJECTION_REL)}.footer-rendered`;
      const first = cliSetTerminal(root, wf, CRITIQUE_NEXT);
      strictEqual(first.status, 0, first.stderr);
      ok(first.stderr.includes(FOOTER_HEADER), first.stderr);
      const earlier = JSON.parse(await readFile(markerFile, 'utf8'));
      await setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'commit-complete', nextAction: 'Start the next deliverable' });
      const backstop = () => captureStderr(() => emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude' }));
      return { root, wf, markerFile, earlier, backstop };
    }
    const footers = (stderr) => stderr.split(FOOTER_HEADER).length - 1;

    // fs/promises.readFile patched for the sidecar (syncBuiltinESMExports
    // carries the patch into its named import): `onRead(path, result)` runs
    // after each read and before its caller sees the bytes.
    async function withReadHook(onRead, fn) {
      const fsp = require('node:fs/promises');
      const original = fsp.readFile;
      fsp.readFile = async function hookedReadFile(path, ...rest) {
        const result = await original.call(this, path, ...rest);
        await onRead(String(path), result);
        return result;
      };
      syncBuiltinESMExports();
      try {
        return await fn();
      } finally {
        fsp.readFile = original;
        syncBuiltinESMExports();
      }
    }

    // Each read of `file` has its bytes in hand, then waits for a second read
    // of it, or `windowMs`: two contenders that nothing serializes both
    // decide from the same bytes.
    function pairedReads(file, windowMs = 1500) {
      let waiting = null;
      return async (path) => {
        if (path !== file) return;
        if (waiting) {
          const partner = waiting;
          waiting = null;
          partner();
          return;
        }
        await new Promise((release) => {
          const timer = setTimeout(() => { waiting = null; release(); }, windowMs);
          waiting = () => { clearTimeout(timer); release(); };
        });
      };
    }

    // Primary emits: the claim is their first read of the marker, so the
    // paired reads are the two claim decisions.
    it('two overlapping emits of one later transition render it once (the marker lock)', async () => {
      const { root, wf, markerFile, earlier } = await laterTransitionPending('footer-lock');
      const { value, stderr } = await captureStderr(() => withReadHook(pairedReads(markerFile), () => Promise.all([0, 1].map(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude', origin: 'primary' })))));
      deepStrictEqual(value.map((v) => v.emitted), [true, true]);
      strictEqual(footers(stderr), 1, `one transition, one footer; got:\n${stderr}`);
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      strictEqual(marker.status, 'rendered');
      ok(marker.transition !== earlier.transition, JSON.stringify([earlier, marker]));
      strictEqual(await exists(`${markerFile}.lock`), false, 'the lock is released');
    });

    it('a marker lock left by a dead emit is broken; a live one makes the emit give up without rendering', async () => {
      const { markerFile, earlier, backstop } = await laterTransitionPending('footer-lock-stale');
      const lockFile = `${markerFile}.lock`;
      await writeFile(lockFile, '999999\n');
      const blocked = await backstop();
      strictEqual(footers(blocked.stderr), 0, `a held lock claims nothing; got:\n${blocked.stderr}`);
      deepStrictEqual(JSON.parse(await readFile(markerFile, 'utf8')), earlier, 'the marker is untouched');
      const old = new Date(Date.now() - 60_000);
      await utimes(lockFile, old, old);
      const freed = await backstop();
      strictEqual(footers(freed.stderr), 1, `a dead lock is broken and the transition renders; got:\n${freed.stderr}`);
      strictEqual(await exists(lockFile), false);
    });

    it('a stale lock that cannot be replaced makes the emit give up within its wait', async () => {
      const { markerFile, earlier, backstop } = await laterTransitionPending('footer-lock-stuck');
      const lockFile = `${markerFile}.lock`;
      await mkdir(lockFile);
      const old = new Date(Date.now() - 60_000);
      await utimes(lockFile, old, old);
      let timer;
      const outcome = await Promise.race([
        backstop().then((r) => ({ done: r })),
        new Promise((r) => { timer = setTimeout(() => r({ hung: true }), 8_000); }),
      ]);
      clearTimeout(timer);
      ok(outcome.done, 'the emit returned');
      strictEqual(footers(outcome.done.stderr), 0, 'no claim, no render');
      deepStrictEqual(JSON.parse(await readFile(markerFile, 'utf8')), earlier, 'the marker is untouched');
    });

    // A breaker replaced this emit's lock while it held it: the emit writes
    // nothing and leaves the replacement's lock in place.
    it('an emit whose lock was replaced while it held it claims nothing and removes no lock', async () => {
      const { root, wf, markerFile, earlier } = await laterTransitionPending('footer-lock-fenced');
      const lockFile = `${markerFile}.lock`;
      // Only the read made under the emit's own lock (the claim decision):
      // the backstop's earlier read takes no lock, and replacing a lock that
      // does not exist yet would only make the emit wait it out.
      let replaced = 0;
      const { stderr } = await captureStderr(() => withReadHook(async (path) => {
        if (path === markerFile && replaced === 0 && await exists(lockFile)) {
          replaced += 1;
          await writeFile(lockFile, 'another-holder');
        }
      }, () => emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude' })));
      strictEqual(replaced, 1, 'control: the lock was replaced inside the claim decision');
      strictEqual(footers(stderr), 0, `no claim under a lock it no longer holds; got:\n${stderr}`);
      deepStrictEqual(JSON.parse(await readFile(markerFile, 'utf8')), earlier, 'the marker is untouched');
      strictEqual(await readFile(lockFile, 'utf8'), 'another-holder', "the replacement's lock stays");
    });

    // Another attempt took the claim over while this render ran (this one was
    // paused past the stale age): neither the upgrade nor the release of this
    // attempt touches the other attempt's claim.
    for (const outcomeOfRender of ['renders', 'fails']) {
      it(`a render whose claim another attempt took over ${outcomeOfRender} without touching that claim`, async () => {
        const { root, wf, markerFile } = await laterTransitionPending(`footer-attempt-${outcomeOfRender}`);
        const stub = await writeStubRuntime(
          await mkdtemp(join(tmpdir(), `${persona}-stub-rt-`)),
          `import { readFileSync, writeFileSync } from 'node:fs';
const marker = ${JSON.stringify(markerFile)};
if (process.argv.includes('json')) {
  const m = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({ ...m, at: new Date().toISOString(), claim: 'another-attempt' }));
  process.stdout.write(JSON.stringify(${outcomeOfRender === 'renders' ? "{ command: 'render', session_handoff: {} }" : "{ command: 'render', projection_error: 'stub' }"}));
} else {
  process.stdout.write('Runtime completion footer (advisory)\\n');
}
`,
          { version: versionAboveFloor(P.runtimeFooterFloor) },
        );
        const saved = process.env.AGENTIC_RUNTIME_ROOT;
        process.env.AGENTIC_RUNTIME_ROOT = stub;
        try {
          await captureStderr(() => emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, host: 'claude' }));
        } finally {
          if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
          else process.env.AGENTIC_RUNTIME_ROOT = saved;
        }
        const marker = JSON.parse(await readFile(markerFile, 'utf8'));
        deepStrictEqual([marker.status, marker.claim], ['claimed', 'another-attempt'], JSON.stringify(marker));
      });
    }

    it('a claim left by a dead render is taken over: at once for another transition, once older than a render for the same one', async () => {
      const { markerFile, earlier, backstop } = await laterTransitionPending('footer-dead-claim');
      const claim = (transition, at) => writeFile(markerFile, `${JSON.stringify({ workflow_id: earlier.workflow_id, status: 'claimed', at, transition })}\n`);
      // The earlier transition's render claimed and died.
      await claim(earlier.transition, new Date().toISOString());
      const other = await backstop();
      strictEqual(footers(other.stderr), 1, `a claim of another transition does not suppress this one; got:\n${other.stderr}`);
      const later = JSON.parse(await readFile(markerFile, 'utf8'));
      strictEqual(later.status, 'rendered');
      ok(later.transition !== earlier.transition);
      // This transition's own claim: live, then dead.
      await claim(later.transition, new Date().toISOString());
      const live = await backstop();
      strictEqual(footers(live.stderr), 0, `a live claim of the same transition is never stolen; got:\n${live.stderr}`);
      await claim(later.transition, new Date(Date.now() - 5 * 60_000).toISOString());
      const dead = await backstop();
      strictEqual(footers(dead.stderr), 1, `a claim older than a render can take is taken over; got:\n${dead.stderr}`);
      strictEqual(JSON.parse(await readFile(markerFile, 'utf8')).status, 'rendered');
    });

    it('two renders in one process on one slot each render their own workflow', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-footer-concurrent-`));
      initRepo(root);
      const a = createWorkflow(root, { branch: 'feat/a' });
      const b = createWorkflow(root, { branch: 'feat/b' });
      const projectionFile = join(root, PROJECTION_REL);
      const stub = await writeStubRuntime(
        await mkdtemp(join(tmpdir(), `${persona}-stub-rt-`)),
        echoFooter({ delayMs: 300 }),
        { version: versionAboveFloor(P.runtimeFooterFloor) },
      );
      const saved = process.env.AGENTIC_RUNTIME_ROOT;
      process.env.AGENTIC_RUNTIME_ROOT = stub;
      try {
        const { value, stderr } = await captureStderr(() => Promise.all([a, b].map((workflowPath) =>
          emitTerminalHandoffSidecar({ repoRoot: root, workflowPath, projectionFile, host: 'claude' }))));
        deepStrictEqual(value.map((v) => v.footerRendered), [true, true], stderr);
        for (const wf of [a, b]) {
          ok(stderr.includes(`rendered workflow: ${basename(wf, '.md')}\n`), `${basename(wf)}:\n${stderr}`);
        }
      } finally {
        if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
        else process.env.AGENTIC_RUNTIME_ROOT = saved;
      }
    });
  });
}
