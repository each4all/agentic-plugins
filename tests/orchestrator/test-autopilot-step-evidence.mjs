// tests/orchestrator/test-autopilot-step-evidence.mjs
//
// C163 (ADR-0063, implementation note of 2026-11-04) — what a step that runs
// an engineer verb must leave, judged from facts the observer reads itself:
//
//   - the phase notes (phase-evidence.mjs): a new `### Phase 1: <Verb>
//     (synthesized)` section of the step's verb, with its synthesis or
//     artifact, after everything the look before the step read
//     (policy.mjs stepEvidence), for a dispatch's first verb and every later
//     verb step;
//   - the content of the checkout's files (lane-digest.mjs contentProjection),
//     which an edit of a file the porcelain status already lists moves: a fact
//     of progress for the no-progress rule (policy.mjs contentMoved).
//
// The grammar, the rule and the content fact on their own; the serial driver
// and the scheduler end to end are in test-autopilot-step-evidence-runs.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const P = await import(resolve(AP, 'policy.mjs'));
const E = await import(resolve(AP, 'phase-evidence.mjs'));
const LD = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/lane-digest.mjs'));
const { stepEvidence, verifyStep } = P;

const ENG_A = 'compose-20261001T000100Z-aaaaaa';
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };

// ---------------------------------------------------------------------------
// Bodies, as the engineer writes them.

const HEAD = '# engineer:compose\n\n## Original Request\n\ndo A\n\n## Phase notes\n\n### phase-0-bootstrap\n\n';
const synth = (Verb, text = '### Ensemble synthesis: x verdict=agreed\n\nAGREED: it holds.\n\n### Artifact\n\nThe change.\n\n') =>
  `### Phase 1: ${Verb} (synthesized)\n\n### Ensemble launched: x at 2026-11-04T00:00:00Z\n\nPeer run r.\n\n${text}### Active next-action proposal\n\n- selected_next: commit\n\n`;
const resume = (verb) => `### Phase 0: Resume into ${verb}\n\nResumed.\n\n`;

describe('phase evidence (phase-evidence.mjs)', () => {
  it('reports each synthesized section in order, with its verb and whether it holds the verb\'s work', () => {
    const body = `${HEAD}${synth('Investigate')}${resume('decide')}${synth('Decide', '')}`;
    const ev = E.evidenceOfBody(body);
    strictEqual(ev.error, null);
    deepStrictEqual(ev.sections.map((x) => [x.verb, x.substantive]), [['investigate', true], ['decide', false]],
      'a section whose only text is the launch line and the next-action proposal is not the verb\'s work');
  });

  it('a no-change conclusion is the verb\'s work; text before the first subsection is not', () => {
    const none = E.evidenceOfBody(`${HEAD}### Phase 1: Refine (synthesized)\n\n### Changes applied\n\nNone: nothing to change.\n\n`);
    deepStrictEqual(none.sections.map((x) => [x.verb, x.substantive]), [['refine', true]]);
    const preamble = E.evidenceOfBody(`${HEAD}### Phase 1: Refine (synthesized)\n\nonly a preamble\n\n### Active next-action proposal\n\n- commit\n`);
    deepStrictEqual(preamble.sections.map((x) => x.substantive), [false]);
  });

  it('a heading inside a fenced block is text; another Phase heading ends a section; an unknown verb label is no section', () => {
    const fenced = `${HEAD}### Ensemble skipped\n\n\`\`\`markdown\n### Phase 1: Compose (synthesized)\n\n### Artifact\n\nx\n\`\`\`\n\n`;
    deepStrictEqual(E.evidenceOfBody(fenced).sections, []);
    const ended = E.evidenceOfBody(`${HEAD}### Phase 1: Compose (synthesized)\n\n${resume('critique')}### Artifact\n\nnot compose's\n\n`);
    deepStrictEqual(ended.sections.map((x) => [x.verb, x.substantive]), [['compose', false]]);
    deepStrictEqual(E.evidenceOfBody(`${HEAD}### Phase 1: Audit (synthesized)\n\n### Artifact\n\nx\n\n`).sections, []);
  });

  it('a fence in the request opens nothing, and a backtick line whose info string holds a backtick is no fence (CommonMark 4.5)', () => {
    const request = HEAD.replace('do A', '```js``` fix it\n\n```\nnever closed');
    deepStrictEqual(E.evidenceOfBody(`${request}${synth('Compose')}`).sections.map((x) => [x.verb, x.substantive]), [['compose', true]],
      'the notes heading after an unclosed fence in the request is still the notes heading');
    const inline = `${HEAD}### Phase 1: Critique (synthesized)\n\n### Findings\n\n\`\`\`a\`\`\` inline\n\n${synth('Refine')}`;
    deepStrictEqual(E.evidenceOfBody(inline).sections.map((x) => [x.verb, x.substantive]), [['critique', true], ['refine', true]],
      'a later section after the line is not swallowed');
    const tilde = `${HEAD}### Phase 1: Critique (synthesized)\n\n### Findings\n\n~~~a~~~\n### Phase 1: Refine (synthesized)\n~~~\n\n`;
    deepStrictEqual(E.evidenceOfBody(tilde).sections.map((x) => x.verb), ['critique'], 'a tilde fence\'s info string may hold anything');
    const sep = `${HEAD}### Phase 1: Critique (synthesized)\n\n### Findings\n\n~~~text${String.fromCodePoint(0x2028)}example\n### Phase 1: Refine (synthesized)\n\n### Artifact\n\nquoted\n~~~\n\n`;
    deepStrictEqual(E.evidenceOfBody(sep).sections.map((x) => x.verb), ['critique'], 'an info string holding U+2028 still opens a fence');
    const nbsp = `${HEAD}### Phase 1: Critique (synthesized)\n\n### Findings\n\n\`\`\`\nx\n\`\`\`${String.fromCodePoint(0xa0)}\n### Phase 1: Refine (synthesized)\n\n### Artifact\n\nquoted\n\`\`\`\n\n`;
    deepStrictEqual(E.evidenceOfBody(nbsp).sections.map((x) => x.verb), ['critique'], 'a closing fence is followed by spaces or tabs only');
    const closed = `${HEAD}### Phase 1: Critique (synthesized)\n\n### Findings\n\n  \`\`\`\nx\n\`\`\`\` \t\n${synth('Refine')}`;
    deepStrictEqual(E.evidenceOfBody(closed).sections.map((x) => x.verb), ['critique', 'refine'], 'a longer closing run with trailing blanks closes');
  });

  it('the engineer\'s own writer: backticks in the request and an inline-backtick note line leave a fresh section after them counted', async () => {
    const eng = await import(resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs'));
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'c163-writer-')));
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q', '-b', 'feat/a');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
      const { filePath } = await eng.createWorkflow({
        repoRoot: dir, verb: 'critique', host: 'claude', env: {}, originalRequest: 'see ```js``` and fix ``` it',
        gitBaseline: { branch: 'feat/a', head: git('rev-parse', 'HEAD'), status_digest: 'a'.repeat(64) },
        currentPhase: 'phase-0-bootstrap', nextAction: 'run',
      });
      const add = (label, phaseNote) => eng.appendPhase({ workflowPath: filePath, host: 'claude', phaseLabel: label, phaseNote, currentPhase: 'phase-2-presented', nextAction: 'next', event: 'updated' });
      await add('Phase 1: Critique (synthesized)', '### Findings\n\n```a``` inline is a paragraph.\n\n### Active next-action proposal\n\n- refine');
      const before = E.phaseEvidence(filePath);
      strictEqual(before.error, null);
      await add('Phase 0: Resume into refine', 'Resumed.');
      await add('Phase 1: Refine (synthesized)', '### Changes applied\n\nThe fix.');
      const after = E.phaseEvidence(filePath);
      deepStrictEqual(after.sections.map((x) => [x.verb, x.substantive]), [['critique', true], ['refine', true]]);
      ok(after.body.startsWith(before.body), 'the writer only appends');
      strictEqual(after.sections[1].start >= before.body.length, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an artifact held in a code block is the verb\'s work', () => {
    const ev = E.evidenceOfBody(`${HEAD}### Phase 1: Compose (synthesized)\n\n### Artifact\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n`);
    deepStrictEqual(ev.sections.map((x) => x.substantive), [true]);
  });

  it('keeps the body it read and each section\'s offset in it; only headings after "## Phase notes" are sections', () => {
    const body = `${HEAD}${synth('Compose')}`;
    const ev = E.evidenceOfBody(body);
    strictEqual(ev.body, body);
    strictEqual(ev.sections[0].start, HEAD.length);
    const quoted = `# engineer:compose\n\n## Original Request\n\n${synth('Compose')}## Phase notes\n\n### phase-0-bootstrap\n\n`;
    deepStrictEqual(E.evidenceOfBody(quoted).sections, [], 'a section quoted in the request is the owner\'s text');
  });

  it('an empty code block is not the verb\'s work', () => {
    const ev = E.evidenceOfBody(`${HEAD}### Phase 1: Critique (synthesized)\n\n### Findings\n\n\`\`\`\n\n\`\`\`\n\n`);
    deepStrictEqual(ev.sections.map((x) => x.substantive), [false]);
  });

  it('a body with no "## Phase notes", or a file that cannot be read, is no evidence (never zero sections)', () => {
    const ev = E.evidenceOfBody('# something else\n\n### Phase 1: Compose (synthesized)\n\n### Artifact\n\nx\n');
    strictEqual(ev.sections, null);
    match(ev.error, /no "## Phase notes" heading/);
    const gone = E.phaseEvidence(join(tmpdir(), 'c163-no-such-workflow.md'));
    strictEqual(gone.sections, null);
    match(gone.error, /cannot read/);
  });

  it('reads a workflow file\'s body after its frontmatter, CRLF or not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c163-ev-'));
    try {
      const f = join(dir, 'w.md');
      writeFileSync(f, `---\nworkflow_id: "w"\n---\n${HEAD}${synth('Frame')}`.replace(/\n/g, '\r\n'));
      deepStrictEqual(E.phaseEvidence(f).sections.map((x) => [x.verb, x.substantive]), [['frame', true]]);
      // The blank lines a workflow's writes add before its body are no change
      // of its notes.
      writeFileSync(f, `---\nworkflow_id: "w"\n---\n\n${HEAD}${synth('Frame')}`);
      const one = E.phaseEvidence(f).body;
      writeFileSync(f, `---\nworkflow_id: "w"\n---\n\n\n\n${HEAD}${synth('Frame')}`);
      strictEqual(E.phaseEvidence(f).body, one);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VERB_LABELS are the six --phase-label literals the engineer\'s finalize blocks write (drift)', () => {
    for (const [verb, label] of Object.entries(E.VERB_LABELS)) {
      const text = readFileSync(resolve(REPO_ROOT, 'plugins/engineer/commands', `${verb}.md`), 'utf8');
      const labels = [...text.matchAll(/--phase-label '(Phase 1: [^']*)'/g)].map((m) => m[1]);
      deepStrictEqual(labels, [`Phase 1: ${label} (synthesized)`], `${verb}.md's Phase 1 label`);
      ok(text.includes(`--phase-label '${E.synthesizedHeading(verb).slice(4)}'`), verb);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule (policy.mjs stepEvidence) on hand-made views.

const evidence = (body) => E.evidenceOfBody(body);
const childWith = (body, over = {}) => ({
  location: 'active', workflow_id: ENG_A, branch: 'feat/a', next_step: COMMIT, awaiting_owner: null,
  dispatched_verb: null, evidence: evidence(body), ...over,
});
const vw = (children, git = {}) => ({ git: { branch: 'feat/a', head: 'h0', porcelain: '', content: null, ...git }, children });

describe('stepEvidence (policy.mjs)', () => {
  const before = vw({ A: childWith(`${HEAD}${synth('Compose')}`) });
  const verb = { kind: 'verb', verb: 'critique', subtaskId: 'A', branch: 'feat/a' };

  it('a later verb that appended its own synthesized section passes', () => {
    strictEqual(stepEvidence({ step: verb, before, after: vw({ A: childWith(`${HEAD}${synth('Compose')}${resume('critique')}${synth('Critique')}`) }) }), null);
  });

  it('a later verb that only rewrote the next step halts owner-choice on its subtask, with no pointer', () => {
    const after = vw({ A: childWith(`${HEAD}${synth('Compose')}${resume('critique')}`, { next_step: COMMIT }) });
    const h = stepEvidence({ step: verb, before, after });
    deepStrictEqual([h?.outcome, h?.reason, h?.subtaskId, h?.pointer ?? null], ['halt', 'owner-choice', 'A', null]);
    match(h.detail, /the \/engineer:critique step left no new "### Phase 1: Critique \(synthesized\)" section with its synthesis or artifact in compose-20261001T000100Z-aaaaaa; it changed the workflow's record \(next step commit @ HIGH\) without the verb's work/);
  });

  it('a section of another verb, or one with no synthesis or artifact, is not the step\'s work', () => {
    const other = vw({ A: childWith(`${HEAD}${synth('Compose')}${synth('Compose')}`) });
    strictEqual(stepEvidence({ step: verb, before, after: other })?.reason, 'owner-choice');
    const bare = vw({ A: childWith(`${HEAD}${synth('Compose')}${synth('Critique', '')}`) });
    strictEqual(stepEvidence({ step: verb, before, after: bare })?.reason, 'owner-choice');
  });

  it('a step that changed the notes before it halts, though it appended a section', () => {
    const after = vw({ A: childWith(`${HEAD.replace('do A', 'do B')}${synth('Compose')}${synth('Critique')}`) });
    match(stepEvidence({ step: verb, before, after })?.detail ?? '', /changed phase notes of \S+ that were there before it/);
    const fewer = vw({ A: childWith(`${HEAD}`) });
    strictEqual(stepEvidence({ step: verb, before, after: fewer })?.reason, 'owner-choice');
  });

  it('a heading put into the last section before the step, which makes its old text read as new, halts', () => {
    const old = `${HEAD}${synth('Compose')}${resume('critique')}### Phase 1: Critique (synthesized)\n\n### Findings\n\nF1: an old finding.\n\n`;
    const prior = vw({ A: childWith(old) });
    const inserted = old.replace('### Findings', '### Phase 1: Critique (synthesized)\n\n### Findings');
    deepStrictEqual(E.evidenceOfBody(inserted).sections.map((x) => [x.verb, x.substantive]), [['compose', true], ['critique', false], ['critique', true]]);
    match(stepEvidence({ step: verb, before: prior, after: vw({ A: childWith(inserted) }) })?.detail ?? '', /changed phase notes of \S+ that were there before it/);
  });

  it('a later verb step is bound to the child the look before it read: another workflow id, none, or an error child halts', () => {
    const after = vw({ A: childWith(`${HEAD}${synth('Compose')}${synth('Critique')}`, { workflow_id: 'critique-20261001T000200Z-bbbbbb' }) });
    const h = stepEvidence({ step: verb, before, after });
    deepStrictEqual([h?.reason, h?.subtaskId], ['owner-choice', 'A']);
    match(h.detail, /the \/engineer:critique step ran on subtask A's engineer workflow compose-20261001T000100Z-aaaaaa \(active\) as the look before it read it, and the look after it found critique-20261001T000200Z-bbbbbb/);
    const old = vw({ A: childWith(`${HEAD}${synth('Critique')}`) });
    match(stepEvidence({ step: verb, before: vw({}), after: old })?.detail ?? '', /workflow none as the look before it read it/,
      'with no child before, an old section is not fresh');
    match(stepEvidence({ step: verb, before: vw({ A: { location: 'error', detail: 'x' } }), after: old })?.detail ?? '', /a workflow with no id \(error\)/);
    match(stepEvidence({ step: { ...verb, resume: 'verify' }, before: vw({}), after: old })?.detail ?? '', /resumption after verification ran on/);
    strictEqual(stepEvidence({ step: { kind: 'dispatch', subtaskId: 'A', verb: 'critique' }, before: vw({}), after: old }), null,
      'a dispatch alone starts from no notes');
  });

  it('a later verb step that leaves its child archived, or its subtask with no child observed, halts', () => {
    const archived = vw({ A: childWith(`${HEAD}${synth('Compose')}${synth('Critique')}`, { location: 'archived' }) });
    match(stepEvidence({ step: verb, before, after: archived })?.detail ?? '', /the \/engineer:critique step left subtask A's engineer workflow archived/);
    match(stepEvidence({ step: verb, before, after: vw({}) })?.detail ?? '', /left subtask A's engineer workflow unobserved/);
    strictEqual(stepEvidence({ step: { kind: 'dispatch', subtaskId: 'A', verb: 'compose' }, before: vw({}), after: vw({}) }), null,
      'a dispatch\'s child is held by its own postcondition');
  });

  it('a dispatch\'s first verb is judged from no sections, by the plan\'s verb or else the verb its dispatch recorded', () => {
    const dispatch = { kind: 'dispatch', subtaskId: 'A', verb: 'investigate' };
    const none = vw({});
    strictEqual(stepEvidence({ step: dispatch, before: none, after: vw({ A: childWith(`${HEAD}${synth('Investigate')}`) }) }), null);
    match(stepEvidence({ step: dispatch, before: none, after: vw({ A: childWith(HEAD) }) })?.detail ?? '',
      /the dispatch of subtask A left no new "### Phase 1: Investigate \(synthesized\)"/);
    strictEqual(stepEvidence({ step: dispatch, before: none, after: vw({ A: childWith(`${HEAD}${synth('Compose')}`) }) })?.reason, 'owner-choice');
    const unnamed = { kind: 'dispatch', subtaskId: 'A', verb: null };
    strictEqual(stepEvidence({ step: unnamed, before: none, after: vw({ A: childWith(`${HEAD}${synth('Frame')}`, { dispatched_verb: 'frame' }) }) }), null);
    strictEqual(stepEvidence({ step: unnamed, before: none, after: vw({ A: childWith(`${HEAD}${synth('Compose')}`, { dispatched_verb: 'frame' }) }) })?.reason, 'owner-choice');
  });

  it('a verification resumption is held to the rule: its verb\'s section, a no-change one included, passes', () => {
    const resumed = { ...verb, verb: 'compose', resume: 'verify' };
    match(stepEvidence({ step: resumed, before, after: vw({ A: childWith(`${HEAD}${synth('Compose')}${resume('compose')}`) }) })?.detail ?? '',
      /the \/engineer:compose resumption after verification left no new/);
    const noChange = `${HEAD}${synth('Compose')}${resume('compose')}### Phase 1: Compose (synthesized)\n\n### Ensemble skipped: compose (local-only)\n\nThe failing test was flaky; nothing to change.\n\n`;
    strictEqual(stepEvidence({ step: resumed, before, after: vw({ A: childWith(noChange) }) }), null);
  });

  it('an owner-forced step, a step whose child records an owner gate, and the steps that run no verb are not judged', () => {
    const after = vw({ A: childWith(`${HEAD}${synth('Compose')}`) });
    strictEqual(stepEvidence({ step: { ...verb, forced: true }, before, after }), null);
    const gated = vw({ A: childWith(`${HEAD}${synth('Compose')}`, { awaiting_owner: { gate: 'scope-routing' } }) });
    strictEqual(stepEvidence({ step: verb, before, after: gated }), null);
    for (const kind of ['verify', 'commit', 'done', 'finalize']) strictEqual(stepEvidence({ step: { kind, subtaskId: 'A' }, before, after }), null, kind);
  });

  it('phase notes the look could not read halt, before or after the step', () => {
    const unread = (e) => vw({ A: { ...childWith(HEAD), evidence: e } });
    match(stepEvidence({ step: verb, before, after: unread({ sections: null, error: 'cannot read x: EACCES' }) })?.detail ?? '',
      /the look after the step could not read the phase notes of \S+ \(cannot read x: EACCES\)/);
    match(stepEvidence({ step: verb, before: unread({ sections: null, error: 'gone' }), after: vw({ A: childWith(`${HEAD}${synth('Critique')}`) }) })?.detail ?? '',
      /the look before the step could not read the phase notes/);
    strictEqual(stepEvidence({ step: verb, before, after: unread(undefined) })?.reason, 'owner-choice');
  });
});

// ---------------------------------------------------------------------------
// The content fact (lane-digest.mjs contentProjection, policy.mjs contentMoved).

describe('the content of the checkout\'s files', () => {
  it('an edit of a file the porcelain status already lists moves the projection; a commit, HEAD and the generated state do not', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'c163-content-')));
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    try {
      git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'base.txt'), 'base\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      writeFileSync(join(dir, 'a.txt'), 'one\n');
      const status0 = git('status', '--porcelain');
      const c0 = LD.contentProjection(dir);
      appendFileSync(join(dir, 'a.txt'), 'two\n');
      strictEqual(git('status', '--porcelain'), status0, 'the porcelain status is the same');
      const c1 = LD.contentProjection(dir);
      ok(c1 !== c0, 'the content moved');
      // A tracked file, modified, then edited again.
      writeFileSync(join(dir, 'base.txt'), 'base\nchanged\n');
      const status1 = git('status', '--porcelain');
      const t0 = LD.contentProjection(dir);
      appendFileSync(join(dir, 'base.txt'), 'again\n');
      strictEqual(git('status', '--porcelain'), status1);
      ok(LD.contentProjection(dir) !== t0, 'an edit of an already-modified tracked file moves it');
      writeFileSync(join(dir, 'base.txt'), 'base\n');
      mkdirSync(join(dir, '.agentic-plugins/state/engineer'), { recursive: true });
      writeFileSync(join(dir, '.agentic-plugins/state/engineer/w.md'), 'bookkeeping\n');
      mkdirSync(join(dir, '.agentic-plugins/runs'), { recursive: true });
      writeFileSync(join(dir, '.agentic-plugins/runs/x.json'), '{}\n');
      strictEqual(LD.contentProjection(dir), c1, 'the generated state and the run ledgers are not content');
      git('add', 'a.txt');
      git('commit', '-q', '-m', 'a');
      strictEqual(LD.contentProjection(dir), c1, 'a commit of the same files leaves it: HEAD is not content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a checked-out submodule counts by its own content: a commit inside it leaves the projection, an edit moves it', () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'c163-sub-')));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...a], { encoding: 'utf8', env });
    const lib = join(top, 'lib');
    const work = join(top, 'work');
    try {
      mkdirSync(lib);
      git(lib, 'init', '-q', '-b', 'main');
      writeFileSync(join(lib, 'x.txt'), 'x\n');
      git(lib, 'add', '.');
      git(lib, 'commit', '-q', '-m', 'lib');
      mkdirSync(work);
      git(work, 'init', '-q', '-b', 'main');
      git(work, 'submodule', 'add', '-q', lib, 'lib');
      git(work, 'commit', '-q', '-m', 'with lib');
      const c0 = LD.contentProjection(work);
      git(join(work, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'empty');
      strictEqual(LD.contentProjection(work), c0, 'the submodule\'s HEAD is no content');
      appendFileSync(join(work, 'lib', 'x.txt'), 'y\n');
      ok(LD.contentProjection(work) !== c0, 'an edit inside it is');
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it('a step whose only change is its files\' content is progress; with the content unmoved, or not projected, it is not', () => {
    const okWorker = { exitCode: 0, signal: null, aborted: null, spawnError: null, lastResult: { is_error: false, subtype: 'success' },
      report: { outcome: 'completed', workflow: ENG_A, next_step: COMMIT, awaiting_owner: null, summary: 's' }, denials: [] };
    const sub = { id: 'A', status: 'in_progress', engineer_workflow_id: ENG_A, branch: 'feat/a' };
    const at = (content) => ({
      ...vw({ A: childWith(`${HEAD}${synth('Compose')}`) }, { porcelain: '?? a.txt', clean: false, content }),
      macro: { id: 'm', archived: false, fm: { plan: { subtasks: [sub] }, host_history: [] } },
    });
    const step = { kind: 'verb', verb: 'critique', subtaskId: 'A', branch: 'feat/a', forced: true };
    strictEqual(verifyStep({ step, worker: okWorker, before: at('c0'), after: at('c1') }), null);
    strictEqual(verifyStep({ step: { ...step, lane: 'A' }, worker: okWorker, before: at('c0'), after: at('c1') }), null, 'a lane step too');
    strictEqual(verifyStep({ step, worker: okWorker, before: at('c0'), after: at('c0') })?.reason, 'no-progress');
    strictEqual(verifyStep({ step, worker: okWorker, before: at(null), after: at('c1') })?.reason, 'no-progress', 'a look that did not project it compares as before');
    strictEqual(P.peersOnlyProgress({ step, before: at('c0'), after: at('c1') }), null);
    strictEqual(P.peersOnlyProgress({ step, before: at('c0'), after: at('c0') })?.reason, 'no-progress');
  });
});
