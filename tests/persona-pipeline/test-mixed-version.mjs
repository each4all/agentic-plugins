// Mixed versions (ADR-0066 Decision 7, PC2b RV10): what the previous founder
// release does with a workflow file this one writes, recorded rather than
// assumed. A host still on the older release can share the repository with a
// host on this one (the Codex pin moves only with a release), so the rule the
// READMEs state — while a workflow carries an owner gate, every host that
// touches it runs the Stage 2 release or later — rests on these facts:
//
//   - the older reader keeps a 1.4 file's schema and its six keys through its
//     own writes (its forward-compat carrier), so it never corrupts one;
//   - the older Stop evaluator knows no gate 5: it archives a gated workflow
//     whose marker is on once HEAD moved, where this release refuses;
//   - an older terminal write leaves next_step_* as they were (stale), and
//     this release's resume clears them.
//
// The older code is read from the release tag with `git archive`; a missing
// tag fails the test (CI checks out with full history and tags), never skips.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, personaInfo } from './_personas.mjs';

// The founder release before PC2b (the persona's schema 1.3, no owner gates).
const PREVIOUS = 'plugin-founder-v0.4.21';
const NEW_KEYS = ['next_step_kind', 'next_step_verb', 'next_step_confidence', 'awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer'];

const oldRoot = mkdtempSync(join(tmpdir(), 'founder-previous-'));
process.on('exit', () => rmSync(oldRoot, { recursive: true, force: true }));
{
  const tag = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '-q', `${PREVIOUS}^{commit}`], { encoding: 'utf8' });
  if (tag.status !== 0) throw new Error(`${PREVIOUS} is not in this clone: fetch the tags (CI checks out with fetch-depth 0); this test fails rather than skip`);
  const tar = execFileSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', PREVIOUS, 'plugins/founder'], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldRoot], { input: tar });
}
const OLD = join(oldRoot, 'plugins/founder');
const NEW = personaInfo('founder');
const oldState = await import(pathToFileURL(join(OLD, 'scripts/state.mjs')).href);
const oldStop = await import(pathToFileURL(join(OLD, 'scripts/stop-archive.mjs')).href);
const newState = await import(pathToFileURL(NEW.path('scripts/state.mjs')).href);
const newStop = await import(pathToFileURL(NEW.path('scripts/stop-archive.mjs')).href);

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));
const cli = (root, args, cwd) => spawnSync(process.execPath, [join(root, 'scripts/state.mjs'), ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
const keyLines = (text) => text.split('\n').filter((l) => NEW_KEYS.some((k) => l.startsWith(`${k}:`)));

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'founder-mixed-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: base');
    return await fn({ dir, git, head: git('rev-parse', 'HEAD') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A workflow this release writes: schema 1.4, a next step and an owner gate.
async function gatedWorkflow(dir, head) {
  const { filePath } = await newState.createWorkflow({
    repoRoot: dir, verb: 'decide', host: 'claude', persona: 'founder', originalRequest: 'mixed',
    gitBaseline: { branch: 'main', head, status_digest: '' },
  });
  await newState.finishVerb({
    workflowPath: filePath, host: 'claude', nextAction: 'The owner selects a direction',
    nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'decide-conflict', anchor: 'ensemble-synthesis' },
  });
  return filePath;
}

describe(`founder mixed versions: ${PREVIOUS} against a schema 1.4 workflow (Decision 7)`, () => {
  it('the previous release really is the one before: it reads up to 1.3 and has no owner gate', () => {
    strictEqual(oldState.SCHEMA_VERSION, '1.3');
    strictEqual(oldState.VALID_WORKFLOW_OWNER_GATES, undefined);
    strictEqual(newState.SCHEMA_VERSION, '1.4');
  });

  it('its reader keeps a 1.4 gated file\'s schema and its six keys, byte for byte, through its own append and set-terminal', () => withRepo(async ({ dir, head }) => {
    const filePath = await gatedWorkflow(dir, head);
    const before = readFileSync(filePath, 'utf8');
    deepStrictEqual(keyLines(before).map((l) => l.split(':')[0]), ['next_step_kind', 'next_step_confidence', 'awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer']);
    const a = cli(OLD, ['append', '--workflow-path', filePath, '--host', 'codex', '--phase-note', 'older host'], dir);
    strictEqual(a.status, 0, a.stderr);
    const t = cli(OLD, ['set-terminal', '--workflow-path', filePath, '--host', 'codex', '--terminal-phase', 'summary-complete'], dir);
    strictEqual(t.status, 0, t.stderr);
    const after = readFileSync(filePath, 'utf8');
    ok(/^schema: "1\.4"$/m.test(after), 'the schema is kept');
    deepStrictEqual(keyLines(after), keyLines(before), 'the six keys are carried as they were');
    const { frontmatter } = newState.parseWorkflowFile(after);
    deepStrictEqual([frontmatter.awaiting_owner_gate, frontmatter.terminal_marker], ['decide-conflict', true], 'and this release reads them back; the older write set the marker');
  }));

  it('its Stop evaluator archives a gated workflow whose marker is on once HEAD moved; this release refuses (gate 5)', () => withRepo(async ({ dir, git, head }) => {
    const filePath = await gatedWorkflow(dir, head);
    // An older host's terminal write turns the marker back on beside the gate.
    strictEqual(cli(OLD, ['set-terminal', '--workflow-path', filePath, '--host', 'codex', '--terminal-phase', 'summary-complete'], dir).status, 0);
    writeFileSync(join(dir, 'plan.md'), 'plan\n');
    git('add', 'plan.md');
    git('commit', '-q', '-m', 'docs: plan');
    const moved = git('rev-parse', 'HEAD');
    const { frontmatter } = newState.parseWorkflowFile(readFileSync(filePath, 'utf8'));
    const older = oldStop.evaluateStopArchive({ frontmatter, headSha: moved, headSubject: 'docs: plan' });
    const newer = newStop.evaluateStopArchive({ frontmatter, headSha: moved, headSubject: 'docs: plan' });
    deepStrictEqual([older.shouldArchive, older.gateFailures], [true, []], 'the older release archives it');
    deepStrictEqual([newer.shouldArchive, newer.gateFailures], [false, ['awaiting_owner']], 'this release keeps it');
    // Through the hooks themselves: the older Stop hook moves it to the archive.
    const hook = spawnSync(process.execPath, [join(OLD, 'adapters/claude/hooks/stop.mjs')], { cwd: dir, input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env: cleanEnv() });
    strictEqual(hook.status, 0, hook.stderr);
    deepStrictEqual(readdirSync(join(dir, newState.workflowDirRel())).filter((f) => f.endsWith('.md')), [], 'archived by the older hook, the gate unresolved');
  }));

  it('this release\'s Stop hook keeps the same gated workflow', () => withRepo(async ({ dir, git, head }) => {
    const filePath = await gatedWorkflow(dir, head);
    strictEqual(cli(OLD, ['set-terminal', '--workflow-path', filePath, '--host', 'codex', '--terminal-phase', 'summary-complete'], dir).status, 0);
    writeFileSync(join(dir, 'plan.md'), 'plan\n');
    git('add', 'plan.md');
    git('commit', '-q', '-m', 'docs: plan');
    const hook = spawnSync(process.execPath, [NEW.path('adapters/claude/hooks/stop.mjs')], { cwd: dir, input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env: cleanEnv() });
    strictEqual(hook.status, 0, hook.stderr);
    strictEqual(readdirSync(join(dir, newState.workflowDirRel())).filter((f) => f.endsWith('.md')).length, 1, 'kept until the owner resolves the gate');
  }));

  it('an older terminal write leaves next_step_* stale; this release\'s resume clears them', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await newState.createWorkflow({
      repoRoot: dir, verb: 'frame', host: 'claude', persona: 'founder', originalRequest: 'stale',
      gitBaseline: { branch: 'main', head, status_digest: '' },
    });
    await newState.finishVerb({ workflowPath: filePath, host: 'claude', nextAction: 'Decide', nextStep: { kind: 'verb', verb: 'decide', confidence: 'HIGH' } });
    const t = cli(OLD, ['set-terminal', '--workflow-path', filePath, '--host', 'codex', '--terminal-phase', 'summary-complete', '--next-action', 'Publish the frame'], dir);
    strictEqual(t.status, 0, t.stderr);
    const stale = newState.parseWorkflowFile(readFileSync(filePath, 'utf8')).frontmatter;
    deepStrictEqual([stale.next_action, stale.next_step_kind, stale.next_step_verb], ['Publish the frame', 'verb', 'decide'], 'the older write changed next_action and left the next step');
    const r = cli(NEW.root, ['append', '--workflow-path', filePath, '--host', 'claude', '--current-phase', 'phase-0-resume', '--clear-next-step', 'true', '--event', 'resumed'], dir);
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(keyLines(readFileSync(filePath, 'utf8')), [], 'the resume cleared it');
  }));
});
