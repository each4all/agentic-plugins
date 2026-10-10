// ADR-0063 S3+S4 — the calls engineer's verb runbooks make for autopilot, in
// the order that makes them safe.
//
// The behavior lives in code (state.mjs autopilot-preflight / finish-verb /
// owner-gate clears, phase7-commit.mjs --mode autopilot|close) and is exercised
// end to end in tests/persona-pipeline/test-autopilot-verbs.mjs,
// test-commit-surface.mjs, test-verb-runbook-runs.mjs and
// test-commit-runbook.mjs. This file pins that every runbook calls it where it
// must:
//   - Phase 0: the preflight runs before any write and stops the block when it
//     refuses; resuming clears the previous next step and stops on failure;
//   - Phase 2: every write stops the block when it fails, and the last one is
//     finish-verb with the next step — never set-terminal; the proposal hands
//     commit and done to /engineer:commit;
//   - the peer runner runs as a host background task, never behind a shell `&`;
//   - compose and refine never run `git commit` under autopilot;
//   - the decide-conflict and recurring-finding gates are recorded on their
//     condition and cleared by one write that names the next step;
//   - every owner-gate anchor the runbooks and phase7-commit.mjs record is the
//     one the routing contract tables.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ENG = resolve(REPO_ROOT, 'plugins/engineer');
const VERBS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const read = (rel) => readFile(resolve(ENG, rel), 'utf8');

// Slices the runbook section under `heading`; the checks below look for calls
// inside it.
function section(text, heading) {
  const start = text.indexOf(heading);
  ok(start >= 0, `missing section ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

// PC3 U7: a verb whose runbook joined the persona pipeline renders its
// finalize block from persona-pipeline/regions/verb-finalize.md, which settles
// the ensemble attempt with peer-runner.mjs settle (ADR-0066 D2) and quotes
// its literals; the others still commit it with state.mjs ensemble-commit.
const generated = (text, verb) => text.includes(`<!-- pipeline:begin ${verb}-finalize -->`);

function bashBlocks(text) {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe('verb runbooks — Phase 0 (ADR-0063 D4, D6)', () => {
  for (const verb of VERBS) {
    it(`${verb}: the preflight runs before any write and stops the block when it refuses`, async () => {
      const phase0 = section(await read(`commands/${verb}.md`), '## Phase 0');
      // Contract: the agent running Phase 0 under autopilot — a preflight after a
      // write, or one whose refusal does not exit, writes over a pending owner gate.
      const pre = phase0.indexOf('scripts/state.mjs" autopilot-preflight');
      ok(pre >= 0, 'Phase 0 runs autopilot-preflight');
      ok(/autopilot-preflight \\\n\s+--workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" \|\| exit \$\?\n/.test(phase0),
        'with the workflow, the host, and || exit $?');
      for (const write of ['state.mjs" create', 'state.mjs" append']) {
        const at = phase0.indexOf(write);
        ok(at > pre, `${write} comes after the preflight`);
      }
    });

    it(`${verb}: resuming clears the previous next step and stops on failure`, async () => {
      const phase0 = section(await read(`commands/${verb}.md`), '## Phase 0');
      // Contract: the agent resuming a workflow — without --clear-next-step a verb
      // that dies after Phase 0 leaves the previous verb's next step, which the
      // driver reads as progress; without `|| exit $?` a failed append runs on.
      const resume = bashBlocks(phase0).find((b) => b.includes('state.mjs" append'));
      ok(resume, 'Phase 0 has its append-on-resume block');
      ok(/--clear-next-step true \\\n/.test(resume), resume);
      ok(/--event resumed \|\| exit \$\?\n/.test(resume), 'the resume append stops the block when it fails');
    });
  }
});

describe('verb runbooks — Phase 2 (ADR-0063 D3)', () => {
  for (const verb of VERBS) {
    it(`${verb}: every write stops the block on failure; the last write is finish-verb with the next step`, async () => {
      const text = await read(`commands/${verb}.md`);
      const phase2 = section(text, '## Phase 2 — State finalize');
      // Contract: the agent finishing a verb — a write that fails without stopping
      // lets finish-verb publish a next step for a verb that did not finish;
      // set-terminal instead of finish-verb ends an autopilot run's workflow.
      const block = bashBlocks(phase2)[0];
      ok(block, 'Phase 2 has its block');
      ok(!/state\.mjs" set-terminal/.test(block), 'no set-terminal call in a verb: finish-verb branches by mode');
      const gen = generated(text, verb);
      const append = block.indexOf('state.mjs" append');
      const commit = block.indexOf(gen ? 'peer-runner.mjs" settle' : 'state.mjs" ensemble-commit');
      const finish = block.indexOf('state.mjs" finish-verb');
      ok(append >= 0 && commit > append && finish > commit, gen ? 'append → settle → finish-verb' : 'append → ensemble-commit → finish-verb');
      ok(/--event updated \|\| exit \$\?\n/.test(block.slice(append, commit)), 'the append stops the block when it fails');
      ok((gen ? /--summary "\$SUMMARY" \|\| exit \$\?\n/ : /--completed-at "[^\n]*" \|\| exit \$\?\n/).test(block.slice(commit, finish)), 'the ensemble write stops the block when it fails');
      // Contract: finish-verb's flags — the closed-enum next step the autopilot
      // driver reads; terminal flags here would close the workflow mid-run.
      // The call itself, up to its last continued line: in a block with a
      // conflict branch (ADR-0067 Decision 8) an indented comment follows it.
      const callLines = block.slice(finish).split('\n');
      const finishCall = callLines.slice(0, callLines.findIndex((l) => !l.endsWith('\\')) + 1).join('\n');
      ok(/--next-action (?:"[^"\n]*"|'[^'\n]*') \\\n/.test(finishCall), finishCall);
      ok(/--next-step-kind verb --next-step-verb (?:[a-z]+|'[a-z]+'|"<next verb>") \\\n/.test(finishCall), finishCall);
      ok(finishCall.includes('--next-step-confidence "<HIGH|MEDIUM|LOW>"'), 'confidence comes from the proposal');
      ok(!/--terminal-marker|--terminal-phase/.test(finishCall), finishCall);
    });

    it(`${verb}: the proposal templates offer done, and commit routes to /engineer:commit`, async () => {
      const text = await read(`commands/${verb}.md`);
      // Contract: the hand-off the proposal names — without `done` and the
      // /engineer:commit route, a finished verb has no command that commits or
      // closes its workflow. Generated, the phase note holds the one template.
      const copies = generated(text, verb) ? 1 : 2;
      strictEqual((text.match(/- selected_next:\s+<verb \| commit \| (?:owner decision \| done|done \| owner decision)>/g) ?? []).length, copies);
      strictEqual((text.match(/\/engineer:commit for commit or done/g) ?? []).length, copies);
    });

    it(`${verb}: the peer runner runs as a host background task, never behind a shell &`, async () => {
      const text = await read(`commands/${verb}.md`);
      // Contract: the agent launching the peer — a shell `&` detaches the runner
      // where neither the agent nor the autopilot host can wait for it.
      const launch = bashBlocks(text).find((b) => b.includes('peer-runner.mjs" run'));
      ok(launch, 'a peer launch block');
      ok(!/&\s*$/m.test(launch.replace(/&&/g, '')), 'no line ends in a background &');
      ok(/run_in_background/.test(text.slice(0, text.indexOf(launch))), 'the text before it says to use the host background task');
    });

    it(`${verb}: under autopilot the agent waits for the peer's notification and reports again after finish-verb`, async () => {
      const ap = section(await read(`commands/${verb}.md`), '## Autopilot mode (ADR-0063, Claude only)');
      // Contract: the agent running a verb under autopilot — without these it
      // sleep-polls, or takes the report it filed while waiting as final and
      // leaves the ensemble unsettled (docket C87).
      ok(ap.includes('never sleep-poll'), verb);
      ok(/finish the verb through `finish-verb`, then report again/.test(ap.replace(/\s+/g, ' ')), verb);
    });
  }

  it('compose and refine never run git commit under autopilot; they hand off with --next-step-kind commit', async () => {
    for (const verb of ['compose', 'refine']) {
      const ap = section(await read(`commands/${verb}.md`), '## Autopilot mode (ADR-0063, Claude only)');
      // Contract: the agent running compose or refine under autopilot — a verb
      // that commits takes the commit away from /engineer:commit's staging rules.
      ok(ap.includes('**Never run `git commit`.**'), verb);
      ok(ap.includes('Set `--next-step-kind commit`'), verb);
    }
  });

  it('decide: a CONFLICT ends with the decide-conflict gate at the synthesis\'s confidence, resolved by the Owner selection step', async () => {
    const text = await read('commands/decide.md');
    const phase2 = section(text, '## Phase 2 — State finalize');
    // Contract: the agent finishing decide — the gate it records, and when: a
    // CONFLICT left unrecorded lets autopilot pick a direction only the owner can.
    if (generated(text, 'decide')) {
      // PC3 U7: the generated finalize names each gate with its heading and
      // anchor above the block, and the block's owner-decision form takes it.
      ok(/^- `decide-conflict` \(the `Ensemble synthesis` heading, anchor\n  `ensemble-synthesis`\): [^\n]*\n[^\n]*CONFLICT remained/m.test(phase2), phase2);
      ok(/#   --next-step-kind owner-decision --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \\\n#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' \|\| exit \$\?\n/.test(phase2), phase2);
    } else {
      ok(/#   --next-step-kind owner-decision --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \\\n#   --owner-gate decide-conflict --owner-gate-anchor ensemble-synthesis\n/.test(phase2), phase2);
    }
    // Contract: the agent running the Owner selection block — one write records
    // the decision, clears the gate and names the next step, and stops on
    // failure; a separate append could publish the step without the decision.
    const sel = section(text, '## Owner selection (decide-conflict)');
    const [block] = bashBlocks(sel);
    ok(/--gate decide-conflict \\\n\s+--resolution "[^"\n]+" --next-action "\$NEXT_ACTION" \\\n\s+"\$\{NEXT_STEP\[@\]\}" \|\| exit \$\?\n/.test(block),
      'one write records the decision, clears the gate and names the next step, and stops the block on failure');
    ok(/^ {2}NEXT_STEP=\(--next-step-kind verb --next-step-verb compose --next-step-confidence HIGH\)$/m.test(block), 'outside the lifecycle the next step is compose');
    ok(/^ {2}NEXT_STEP=\(--clear-next-step true\)$/m.test(block), 'inside the lifecycle no next step');
    ok(!block.includes('state.mjs" append'), 'no separate write can publish the next step without the decision');
    ok(/ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active/.test(block), 'the block resolves the workflow itself');
    ok(block.indexOf('awaiting-owner-clear') < block.indexOf('finish-verb'), 'clear, then the terminal write');
  });

  it('refine: a recurring finding ends with the recurring-finding gate, resolved by the Owner decision step', async () => {
    const text = await read('commands/refine.md');
    const phase2 = section(text, '## Phase 2 — State finalize');
    // Contract: the agent finishing refine — the owner-decision form records the
    // gate and stops the block when the write fails.
    if (generated(text, 'refine')) {
      ok(phase2.includes("#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?\n"), phase2);
    } else {
      ok(/#   --owner-gate recurring-finding --owner-gate-anchor recurring-finding\n/.test(phase2));
    }
    // Contract: the agent running an Owner decision block — each resolution is one
    // write that names its next step (refine for fix now, commit for defer) and
    // stops on failure; a separate append could publish the step without it.
    const blocks = bashBlocks(section(text, '## Owner decision (recurring-finding)'));
    ok(blocks.some((b) => /--gate recurring-finding \\\n\s+--resolution "[^"\n]+" --next-action "\$NEXT_ACTION" \\\n\s+--next-step-kind verb --next-step-verb refine --next-step-confidence HIGH \|\| exit \$\?\n/.test(b)), 'fix now: one write, naming this refine, stopping the block on failure');
    ok(blocks.some((b) => /--gate recurring-finding \\\n\s+--resolution "[^"\n]+" --next-action "\$NEXT_ACTION" \\\n\s+--next-step-kind commit --next-step-confidence HIGH \|\| exit \$\?\n/.test(b)), 'defer: one write naming commit, stopping the block on failure');
    for (const b of blocks) {
      ok(/ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active/.test(b), 'every resolution block resolves the workflow itself');
      ok(!b.includes('state.mjs" append'), 'no separate write can publish the next step without the decision');
    }
  });
});

// /engineer:commit's blocks and its Codex skill are the commit surface's
// generated regions (PC3b U4): the Phase 0 preflight, the autopilot block
// with no bypass flag and the driver modes are checked for every persona that
// declares the capability on, in tests/persona-pipeline/test-runbook-contracts.mjs
// and test-skill-contracts.mjs, and run in test-commit-runbook.mjs.

describe('owner-gate anchors', () => {
  it('every owner-gate anchor the runbooks and scripts record is the one the routing contract tables', async () => {
    // Contract: the autopilot halt points the owner at the gate's anchor — a
    // runbook or phase7-commit.mjs recording an anchor other than the one the
    // routing contract tables for that gate sends the owner to a missing section.
    const doc = await read('core/skills/_shared/references/entry-routing-contract.md');
    const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| [^|]+ \| [^|]+ · `([a-z0-9-]+)` \|/gm)]
      .map((m) => [m[1], m[2]]);
    deepStrictEqual(Object.fromEntries(rows), {
      'decide-conflict': 'ensemble-synthesis',
      'peer-conflict': 'ensemble-synthesis',
      'recurring-finding': 'recurring-finding',
      'scope-routing': 'routing-recommendation',
      'staging-set': 'phase7-plan',
      'pr-handling': 'pr-handling',
    });
    const used = [];
    // PC3 U7: a generated finalize names each gate it can end with in a bullet
    // above its block; each verb names exactly its own (the gate it owns, if
    // any, scope-routing, and pr-handling with dispatch_target on).
    // ADR-0067 Decision 8: critique and investigate own peer-conflict.
    const OWN = { decide: ['decide-conflict'], critique: ['peer-conflict'], investigate: ['peer-conflict'], refine: ['recurring-finding'] };
    for (const verb of VERBS) {
      const text = await read(`commands/${verb}.md`);
      for (const m of text.matchAll(/--owner-gate ([a-z-]+) --owner-gate-anchor ([a-z0-9-]+)/g)) used.push([m[1], m[2]]);
      const bullets = [...text.matchAll(/^- `([a-z-]+)` \([^)]*?anchor\s+`([a-z0-9-]+)`\)/gm)].map((m) => [m[1], m[2]]);
      if (generated(text, verb)) deepStrictEqual(bullets.map(([g]) => g), [...(OWN[verb] ?? []), 'scope-routing', 'pr-handling'], `${verb}: the gates its finalize names`);
      used.push(...bullets);
    }
    const phase7 = await read('scripts/phase7-commit.mjs');
    for (const m of phase7.matchAll(/ownerGate: \{ gate: '([a-z-]+)', anchor: '([a-z0-9-]+)' \}/g)) used.push([m[1], m[2]]);
    ok(used.length >= 3, JSON.stringify(used));
    for (const [gate, anchor] of used) strictEqual(anchor, Object.fromEntries(rows)[gate], `${gate}#${anchor}`);
  });
});
