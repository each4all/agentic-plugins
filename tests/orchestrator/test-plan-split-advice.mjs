// C120 — /orchestrator:plan proposes a document subtask that would settle more
// than two decisions as chained slices of one or two. The advice lives in the
// plan skill's Step 2 (what each slice owns and claims, how later slices amend
// the ADR, the landing-round cost), the command's Phase 1 points at it, and
// the Plan-verify template asks the peer to flag such a subtask. Advice only:
// plan-set accepts a large document subtask as before.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, 'plugins', 'orchestrator', rel), 'utf8');

// The paragraph under a bold lead, up to the next heading.
function section(text, lead) {
  const at = text.indexOf(lead);
  ok(at >= 0, `${lead} is present`);
  const rest = text.slice(at);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('orchestrator plan: split a document that carries many decisions (C120)', () => {
  const skill = read('core/skills/plan/SKILL.md');

  it('the advice sits in Step 2, after the shared numbers rule, and names ownership, claim, amendment and cost', () => {
    const step2 = skill.slice(skill.indexOf('### Step 2: Order by dependencies'), skill.indexOf('### Step 3: Present and confirm'));
    const advice = section(step2, '**Split a document that carries many decisions** (C120)');
    ok(step2.indexOf('**Shared numbers**') < step2.indexOf('**Split a document'), 'after the shared numbers rule');
    for (const clause of [
      /more than two decisions/,
      /slices of one or two decisions each, linked by `blocked_by`/,
      /never a `plan-set` refusal/,
      /what it owns: the decisions it settles/,
      /the ADR number, pre-assigned in every slice's topic/,
      /later slices amend it under a dated heading/,
      /a chain of N slices costs N landing rounds/,
      /Keep one subtask when the decisions cannot be read apart/,
    ]) ok(clause.test(advice), `the advice says ${clause}`);
  });

  it('the command points at it and the Plan-verify template asks the peer to flag it', () => {
    const command = read('commands/plan.md');
    const phase1 = command.slice(command.indexOf('## Phase 1'), command.indexOf('### Ensemble dispatch (Plan-verify point type)'));
    ok(/more than two decisions is proposed as chained slices of one or two decisions each, per the plan skill's Step 2 \(C120\): advice, not a `plan-set` rule\./.test(phase1));
    const protocol = read('core/skills/_shared/references/ensemble-protocol.md');
    const risk = protocol.split('\n').filter((l) => l.includes('3. Risk areas:'));
    strictEqual(risk.length, 1);
    ok(/document subtask .* more than two decisions .* chained slices of one or two/.test(risk[0]));
  });
});
