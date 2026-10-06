// ADR-0063 S3+S4 — the engineer runbooks' autopilot deltas, pinned by shape.
//
// The behavior lives in code (state.mjs autopilot-preflight / finish-verb,
// phase7-commit.mjs --mode autopilot|close) and is exercised end to end in
// tests/persona-pipeline/test-autopilot-verbs.mjs and test-commit-surface.mjs
// and tests/engineer/test-verb-runbook-autopilot.mjs. This file pins that
// every runbook calls it
// where it must, in the order that makes it safe:
//   - Phase 0: the preflight runs before any write and stops the block when it
//     refuses; resuming clears the previous next step and stops on failure;
//   - Phase 2: every write stops the block when it fails, and the last one is
//     finish-verb with the next step — never set-terminal;
//   - the peer runner is not detached with a shell `&`;
//   - the autopilot section, the owner-gate variants and their resolving
//     steps are present, and every gate anchor the runbooks and scripts use is
//     the one autopilot-mode.md documents;
//   - interactive runs keep their ceremonies: the autopilot rules are
//     conditional text, and the Codex mirrors say autopilot is Claude-only.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ENG = resolve(REPO_ROOT, 'plugins/engineer');
const VERBS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const read = (rel) => readFile(resolve(ENG, rel), 'utf8');

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
      const finishCall = block.slice(finish).split('\n#')[0];
      ok(/--next-action (?:"[^"\n]*"|'[^'\n]*') \\\n/.test(finishCall), finishCall);
      ok(/--next-step-kind verb --next-step-verb (?:[a-z]+|'[a-z]+'|"<next verb>") \\\n/.test(finishCall), finishCall);
      ok(finishCall.includes('--next-step-confidence "<HIGH|MEDIUM|LOW>"'), 'confidence comes from the proposal');
      ok(!/--terminal-marker|--terminal-phase/.test(finishCall), finishCall);
    });

    it(`${verb}: the proposal templates offer done, and commit routes to /engineer:commit`, async () => {
      const text = await read(`commands/${verb}.md`);
      // Generated, the phase note holds the one proposal template and the
      // Completion section points at it (a second copy is a re-enumeration).
      const copies = generated(text, verb) ? 1 : 2;
      strictEqual((text.match(/- selected_next:\s+<verb \| commit \| (?:owner decision \| done|done \| owner decision)>/g) ?? []).length, copies);
      strictEqual((text.match(/\/engineer:commit for commit or done/g) ?? []).length, copies);
    });

    it(`${verb}: the peer runner runs as a host background task, never behind a shell &`, async () => {
      const text = await read(`commands/${verb}.md`);
      const launch = bashBlocks(text).find((b) => b.includes('peer-runner.mjs" run'));
      ok(launch, 'a peer launch block');
      ok(!/&\s*$/m.test(launch.replace(/&&/g, '')), 'no line ends in a background &');
      ok(/run_in_background/.test(text.slice(0, text.indexOf(launch))), 'the text before it says to use the host background task');
    });

    it(`${verb}: the completion footer paragraph says autopilot prints none: the driver is the handoff`, async () => {
      const flat = (await read(`commands/${verb}.md`)).replace(/\s+/g, ' ');
      strictEqual(flat.split('Under an autopilot run `finish-verb` makes no terminal write, so no footer is printed: the driver is the handoff.').length - 1, 1);
    });

    it(`${verb}: the autopilot section names the rules file and the finish-verb contract`, async () => {
      const ap = section(await read(`commands/${verb}.md`), '## Autopilot mode (ADR-0063, Claude only)');
      ok(ap.includes('core/skills/_shared/references/autopilot-mode.md'), ap);
      ok(ap.includes('the preflight prints nothing interactively, and none of this applies then'), ap);
      ok(ap.includes('No presentation-mode prompt (present in\n  batch)'), ap);
      ok(ap.includes("`set-terminal --terminal-marker\n  true` is refused"), ap);
      ok(ap.includes('wait for the background notification; never sleep-poll'), ap);
      ok(ap.includes('taken while you wait is provisional: when the notification re-invokes you,\n  finish the verb through `finish-verb`, then report again'), ap);
    });
  }

  it('compose and refine never commit; critique carries CRITICAL and MAJOR only', async () => {
    for (const verb of ['compose', 'refine']) {
      const ap = section(await read(`commands/${verb}.md`), '## Autopilot mode (ADR-0063, Claude only)');
      ok(ap.includes('**Never run `git commit`.** Set `--next-step-kind commit` when the artifact\n  is ready'), verb);
    }
    const critique = await read('commands/critique.md');
    ok(section(critique, '## Autopilot mode (ADR-0063, Claude only)').includes('**Refine carries CRITICAL and MAJOR findings only**'));
    ok(critique.includes('under\nautopilot, CRITICAL + MAJOR only, with no pick'));
  });

  it('decide: a CONFLICT ends with the decide-conflict gate at the synthesis\'s confidence, resolved by the Owner selection step', async () => {
    const text = await read('commands/decide.md');
    const phase2 = section(text, '## Phase 2 — State finalize');
    if (generated(text, 'decide')) {
      // PC3 U7: the generated finalize names each gate with its heading and
      // anchor above the block, and the block's owner-decision form takes it.
      ok(/^- `decide-conflict` \(the `Ensemble synthesis` heading, anchor\n  `ensemble-synthesis`\): [^\n]*\n[^\n]*CONFLICT remained/m.test(phase2), phase2);
      ok(/#   --next-step-kind owner-decision --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \\\n#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' \|\| exit \$\?\n/.test(phase2), phase2);
    } else {
      ok(/#   --next-step-kind owner-decision --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \\\n#   --owner-gate decide-conflict --owner-gate-anchor ensemble-synthesis\n/.test(phase2), phase2);
    }
    const sel = section(text, '## Owner selection (decide-conflict)');
    const [block] = bashBlocks(sel);
    ok(/--gate decide-conflict \\\n\s+--resolution "[^"\n]+" \\\n\s+--next-step-kind verb --next-step-verb compose --next-step-confidence HIGH \|\| exit \$\?\n/.test(block),
      'one write records the decision, clears the gate and names the next step, and stops the block on failure');
    ok(!block.includes('state.mjs" append'), 'no separate write can publish the next step without the decision');
    ok(/ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active/.test(block), 'the block resolves the workflow itself');
    ok(block.indexOf('awaiting-owner-clear') < block.indexOf('finish-verb'), 'clear, then the terminal write');
  });

  it('refine: a recurring finding ends with the recurring-finding gate, resolved by the Owner decision step', async () => {
    const text = await read('commands/refine.md');
    const phase2 = section(text, '## Phase 2 — State finalize');
    if (generated(text, 'refine')) {
      // PC3 U7: the generated finalize names the gate with its heading and
      // anchor above the block, and the block's owner-decision form takes it.
      ok(/^- `recurring-finding` \(heading `### Recurring finding`, anchor\n  `recurring-finding`\): /m.test(phase2), phase2);
      ok(phase2.includes("#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?\n"), phase2);
    } else {
      ok(/#   --owner-gate recurring-finding --owner-gate-anchor recurring-finding\n/.test(phase2));
    }
    const blocks = bashBlocks(section(text, '## Owner decision (recurring-finding)'));
    ok(blocks.some((b) => /--gate recurring-finding \\\n\s+--resolution "[^"\n]+" \\\n\s+--next-step-kind verb --next-step-verb refine --next-step-confidence HIGH(?: \|\| exit \$\?)?\n/.test(b)), 'fix now: one write, naming this refine');
    ok(blocks.some((b) => /--gate recurring-finding \\\n\s+--resolution "[^"\n]+" \\\n\s+--next-step-kind commit --next-step-confidence HIGH \|\| exit \$\?\n/.test(b)), 'defer: one write naming commit, stopping the block on failure');
    for (const b of blocks) {
      ok(/ACTIVE="\$\(node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" find-active/.test(b), 'every resolution block resolves the workflow itself');
      ok(!b.includes('state.mjs" append'), 'no separate write can publish the next step without the decision');
    }
  });
});

describe('/engineer:commit (ADR-0063 D3, spec §1.8)', () => {
  it('Phase 0 runs the commit surface\'s preflight; the Autopilot block is one command with no bypass flag', async () => {
    const text = await read('commands/commit.md');
    const phase0 = bashBlocks(section(text, '## Phase 0'))[0];
    ok(/autopilot-preflight \\\n\s+--workflow-path "\$ACTIVE" --host "\$\{AGENTIC_HOST:-claude\}" --surface commit \|\| exit \$\?/.test(phase0), phase0);
    ok(phase0.includes('"$WORKFLOW_TYPE" = "start"'), 'start workflows are refused');
    const auto = bashBlocks(section(text, '## Autopilot — the whole step in one command'))[0];
    ok(/phase7-commit\.mjs" --mode autopilot \\\n/.test(auto), auto);
    for (const flag of ['--confirm-non-interactive', '--non-interactive', '--include-extra', '--accept-current-tree', '--subject', 'ACCEPT_CURRENT_TREE']) {
      ok(!auto.includes(flag), `the autopilot block never passes ${flag}`);
    }
    ok(bashBlocks(section(text, '## Phase 3 — Close without a commit (interactive)'))[0].includes('--mode close'));
  });

  it('the Codex skill documents the same modes and the Claude-only autopilot', async () => {
    const skill = await read('core/skills/commit/SKILL.md');
    for (const s of ['--mode plan', '--mode execute', '--mode close', '--mode autopilot', '--surface commit', 'Claude-only (ADR-0063 D9)']) {
      ok(skill.includes(s), s);
    }
  });
});

describe('Codex verb mirrors and shared references', () => {
  for (const verb of VERBS) {
    it(`${verb}: the Codex mirror names the next step fields and says autopilot is Claude-only`, async () => {
      const skill = await read(`core/skills/${verb}/SKILL.md`);
      ok(skill.includes('`next_step_kind`, `next_step_verb` and `next_step_confidence` (ADR-0063 D6;'), verb);
      ok(skill.includes('is Claude-only (ADR-0063);\nignore it on Codex.'), verb);
    });
  }

  it('the approval points in the decide, compose and refine skills say what autopilot does there', async () => {
    const decide = await read('core/skills/decide/SKILL.md');
    strictEqual((decide.match(/\*\*Autopilot mode \(Claude only, ADR-0063 D4 \/ R4\):\*\*/g) ?? []).length, 2);
    ok((await read('core/skills/compose/SKILL.md')).includes('**Autopilot mode (Claude only, ADR-0063 D4):** the approval is the\ndriver\'s.'));
    ok((await read('core/skills/refine/SKILL.md')).includes('record the `recurring-finding` owner gate'));
  });

  it('presentation, ensemble and entry-routing references carry their autopilot rules', async () => {
    const pres = await read('core/skills/_shared/references/presentation-protocol.md');
    strictEqual((pres.match(/\*\*Autopilot mode \(ADR-0063, Claude only\):\*\*/g) ?? []).length, 2);
    const ens = await read('core/skills/_shared/references/ensemble-protocol.md');
    ok(ens.includes('never behind a shell `&`'));
    ok(ens.includes('never sleep-poll a file'));
    ok(ens.includes('when you end a turn to wait is provisional'));
    const mode = await read('core/skills/_shared/references/autopilot-mode.md');
    ok(mode.includes('**A report taken while you wait is provisional.**'));
    ok(mode.includes('step by the last report only'));
    const contract = await read('core/skills/_shared/references/entry-routing-contract.md');
    ok(contract.includes('**Closed-enum projection: `next_step` (ADR-0063 D6, amending ADR-0029\n§3).**'));
    ok(contract.includes('| done — the deliverable is complete and needs no commit | `done` | absent |'));
  });

  it('every owner-gate anchor the runbooks and scripts record is the one autopilot-mode.md documents', async () => {
    const doc = await read('core/skills/_shared/references/autopilot-mode.md');
    const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| [^|]+ \| [^|]+ \| [^|]+ · `([a-z0-9-]+)` \|/gm)]
      .map((m) => [m[1], m[2]]);
    deepStrictEqual(Object.fromEntries(rows), {
      'decide-conflict': 'ensemble-synthesis',
      'recurring-finding': 'recurring-finding',
      'scope-routing': 'routing-recommendation',
      'staging-set': 'phase7-plan',
      'pr-handling': 'pr-handling',
    });
    const used = [];
    // PC3 U7: a generated finalize names each gate it can end with in a bullet
    // above its block; each verb names exactly its own (the gate it owns, if
    // any, scope-routing, and pr-handling with dispatch_target on).
    const OWN = { decide: ['decide-conflict'], refine: ['recurring-finding'] };
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
