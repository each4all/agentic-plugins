// tests/runtime/test-compat-schema-era.mjs
//
// ADR-0056 §Decisions 5 and 6 — the SCHEMA ERA, which is what replaced the
// removed assurance verdict at every readiness site.
//
// ⚠ WHY THIS FILE EXISTS. Removing the grant/cohort matcher left a measured
// fail-open behind it: `checkCompatFreshness` had a live-coverage clause, and it
// was that clause — not exactness — that stopped a STORED bit from passing on
// its own. An old `runtime-compat-gap-1.1` run whose status was `current` or
// `assured` still parses, and its recorded host pair can still equal the live
// one, so deleting the clause without a replacement makes an assurance-era
// verdict satisfy current readiness.
//
// The replacement is the era, and it has three separable pieces, each of which
// can regress independently:
//
//   1. `projectGapFamily` must name THREE eras. The two-era shape it replaced
//      asked "is this schema in the assurance-bearing list?", so every family
//      NOT in that list took the legacy branch — and merely adding `1.2` to the
//      readable list would have classified this runtime's OWN artifacts as
//      legacy history.
//   2. The era must TRAVEL out of `state-readers`' projection, which used to
//      drop it.
//   3. The ready predicate must take BOTH halves, because `current` exists in
//      two eras and means two different things.
//
// Each case below was mutation-verified: reverting the production line it names
// turns it red.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GAP_SCHEMA_ERAS,
  isReadyCompatState,
  PLAN_SCHEMA_ERAS,
  projectGapFamily,
  projectPlanFamily,
  READABLE_GAP_SCHEMAS,
} from '../../plugins/runtime/scripts/lib/compat-artifacts.mjs';
import { inspectCompatRuns } from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { checkSnapshot } from '../../plugins/runtime/scripts/compat.mjs';

describe('projectGapFamily names three eras, and this runtime\'s own is not legacy', () => {
  it('CONTROL: the post-assurance family is READABLE — not legacy, not unrecognized', () => {
    // The case the two-era shape got wrong. Without this control, every legacy
    // assertion below would pass against an implementation that called
    // everything legacy.
    const projected = projectGapFamily({ schema_version: 'runtime-compat-gap-1.2' });
    strictEqual(projected.kind, 'readable');
    strictEqual(projected.era, 'post-assurance');
  });

  it('the assurance era is LEGACY, and its reason names the removal rather than a truncated write', () => {
    const projected = projectGapFamily({ schema_version: 'runtime-compat-gap-1.1' });
    strictEqual(projected.kind, 'legacy');
    strictEqual(projected.era, 'assurance-era');
    ok(/ADR-0056/.test(projected.reason), projected.reason);
  });

  it('the pre-assurance era is LEGACY too, and keeps its own distinct reason', () => {
    const projected = projectGapFamily({ schema_version: 'runtime-compat-gap-1.0' });
    strictEqual(projected.kind, 'legacy');
    strictEqual(projected.era, 'pre-assurance');
    ok(/predates/.test(projected.reason), projected.reason);
  });

  it('an unknown family is UNRECOGNIZED with a null era — never legacy, never readable', () => {
    for (const schema of ['runtime-compat-gap-9.9', 'runtime-compat-gap-2.0', '', null, undefined]) {
      const projected = projectGapFamily(schema === undefined ? undefined : { schema_version: schema });
      strictEqual(projected.kind, 'unrecognized', `${JSON.stringify(schema)} must be unrecognized`);
      strictEqual(projected.era, null);
    }
  });

  it('every readable family has an era, and every era-mapped family is readable — no half-taught entry', () => {
    // The map and the list are two lists of the same thing, and this is the
    // assertion that stops them drifting apart. A family added to one and
    // forgotten in the other reads as `unrecognized` (readable-but-unmapped) or
    // is simply unreachable (mapped-but-unreadable), and both are silent.
    for (const schema of READABLE_GAP_SCHEMAS) {
      ok(GAP_SCHEMA_ERAS[schema], `${schema} is readable but has no era`);
    }
    for (const schema of Object.keys(GAP_SCHEMA_ERAS)) {
      ok(READABLE_GAP_SCHEMAS.includes(schema), `${schema} has an era but is not readable`);
    }
  });
});

describe('the ready predicate takes the ERA as well as the token', () => {
  it('CONTROL: this era\'s `current` is ready', () => {
    strictEqual(isReadyCompatState({ status: 'current', schemaEra: 'post-assurance' }), true);
  });

  it('the assurance era\'s `current` is NOT ready — the token is the same and the claim is not', () => {
    // Under `runtime-compat-gap-1.1`, `current` required a human grant naming
    // this host pair AS WELL AS no drift. Under `1.2` it means no drift alone.
    // A token-only reader silently converts the stronger record into the weaker
    // claim, and passes.
    strictEqual(isReadyCompatState({ status: 'current', schemaEra: 'assurance-era' }), false);
  });

  it('`assured` is not ready in any era — it left the vocabulary with its layer', () => {
    strictEqual(isReadyCompatState({ status: 'assured', schemaEra: 'assurance-era' }), false);
    strictEqual(isReadyCompatState({ status: 'assured', schemaEra: 'post-assurance' }), false);
  });

  it('a missing era is not ready — null never satisfies, which is the fail-closed direction', () => {
    strictEqual(isReadyCompatState({ status: 'current', schemaEra: null }), false);
    strictEqual(isReadyCompatState({ status: 'current' }), false);
    strictEqual(isReadyCompatState({}), false);
    strictEqual(isReadyCompatState(), false);
  });
});

describe('the era travels out of the state-readers projection', () => {
  async function seedRun(schemaVersion, overall) {
    const repoRoot = await mkdtemp(join(tmpdir(), 'era-'));
    const runId = 'compat-20260827T000000Z-aaaaaa';
    const dir = join(repoRoot, '.agentic-plugins', 'runs', 'compat', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      schema_version: 'runtime-compat-snapshot-1.2',
      run_id: runId,
      created_at: '2026-08-27T00:00:00.000Z',
      hosts: {},
    }));
    await writeFile(join(dir, 'gap-analysis.json'), JSON.stringify({
      schema_version: schemaVersion,
      run_id: runId,
      overall,
      host_gaps: [],
    }));
    return { repoRoot, runId };
  }

  it('CONTROL: a post-assurance `current` run carries its era and reads available', async () => {
    const { repoRoot } = await seedRun('runtime-compat-gap-1.2', { status: 'current', drift_class: 'none' });
    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.schema_era, 'post-assurance');
    strictEqual(runs.latest.status, 'current');
    strictEqual(runs.status, 'available');
  });

  it('an assurance-era `current` run carries ITS era and does NOT read available', async () => {
    // ⚠ THE STATUS CHANGES TOO, and both halves matter. The projected per-run
    // status becomes `legacy_era`, and the collection refuses to call it
    // available. A reader that kept the token and dropped the era would report
    // `current / available` for a verdict from a layer that no longer exists.
    const { repoRoot } = await seedRun('runtime-compat-gap-1.1', { status: 'current', drift_class: 'none' });
    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.schema_era, 'assurance-era');
    strictEqual(runs.latest.status, 'legacy_era');
    strictEqual(runs.status, 'needs_attention');
    ok(runs.latest.next_steps.some((step) => /earlier compatibility schema era/.test(step)), runs.latest.next_steps.join(' | '));
  });

  it('a run whose gap is unreadable carries a NULL era, which no predicate accepts', async () => {
    const { repoRoot } = await seedRun('runtime-compat-gap-9.9', { status: 'current', drift_class: 'none' });
    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.schema_era, null);
    strictEqual(runs.latest.status, 'unrecognized');
    strictEqual(runs.status, 'blocked');
  });
});

describe('a gap inherits the OLDER of its own era and its source snapshot\'s', () => {
  // ⚠ THE LAUNDERING PATH THE REMOVAL OPENS (cross-host review). `check`
  // re-reads ANY selected snapshot and writes a gap in THIS runtime's family, so
  // checking a `1.0` or `1.1` snapshot produces a `runtime-compat-gap-1.2`
  // artifact. Reading only the gap's own schema labels that `post-assurance` and
  // admits it to the ready set — an observation taken under the old contract
  // promoted into the current one by nothing more than being re-read.
  const gapFrom = (sourceEra) => projectGapFamily({
    schema_version: 'runtime-compat-gap-1.2',
    overall: sourceEra === undefined ? {} : { snapshot_schema_era: sourceEra },
  });

  it('CONTROL: a gap from a post-assurance snapshot stays readable', () => {
    strictEqual(gapFrom('post-assurance').kind, 'readable');
    strictEqual(gapFrom('post-assurance').era, 'post-assurance');
  });

  it('CONTROL: a gap that names no source keeps its own era', () => {
    // Correct for every artifact written before the field existed, and for the
    // pre-`1.2` families that are legacy on their own account anyway.
    strictEqual(gapFrom(undefined).kind, 'readable');
  });

  for (const sourceEra of ['assurance-era', 'pre-assurance']) {
    it(`a gap computed from a ${sourceEra} snapshot is LEGACY, whatever its own schema says`, () => {
      const projected = gapFrom(sourceEra);
      strictEqual(projected.kind, 'legacy');
      strictEqual(projected.era, sourceEra);
      strictEqual(isReadyCompatState({ status: 'current', schemaEra: projected.era }), false);
      ok(/earlier contract/.test(projected.reason), projected.reason);
    });
  }

  it('an UNKNOWN source era is the oldest of all — never a promotion', () => {
    const projected = gapFrom('martian');
    strictEqual(projected.kind, 'legacy');
    strictEqual(isReadyCompatState({ status: 'current', schemaEra: projected.era }), false);
  });
});

describe('the PLAN has its own family reader, so it cannot outrank a gap it predates', () => {
  // ⚠ MEASURED OVERRIDE. `state-readers.mjs` lets a plan outrank the gap's
  // status and switched on the persisted `plan.status` string with no family
  // check — so an assurance-era plan carrying `blocked_assurance` matched
  // neither named status and fell through to `plan_ready`, presenting a verdict
  // from the removed layer as this era's "there is a plan to act on".
  it('CONTROL: this era\'s plan is readable and may decide', () => {
    const projected = projectPlanFamily({ schema_version: 'runtime-compat-plan-1.2' });
    strictEqual(projected.kind, 'readable');
    strictEqual(projected.era, 'post-assurance');
  });

  for (const [schema, era] of Object.entries(PLAN_SCHEMA_ERAS)) {
    if (era === 'post-assurance') continue;
    it(`a ${era} plan is legacy — pointed at, never deciding`, () => {
      strictEqual(projectPlanFamily({ schema_version: schema }).kind, 'legacy');
    });
  }

  it('an unknown plan family is unrecognized with a null era', () => {
    for (const schema of ['runtime-compat-plan-9.9', '', null, undefined]) {
      const projected = projectPlanFamily(schema === undefined ? undefined : { schema_version: schema });
      strictEqual(projected.kind, 'unrecognized', `${JSON.stringify(schema)}`);
      strictEqual(projected.era, null);
    }
  });
});

describe('a truncated observed host version cannot reach `current`', () => {
  // ⚠ THE SECOND HALF OF THE `liveCovered` FAIL-OPEN (cross-host review of the
  // removal). `observed.version` is `normalizeVersion(version_text)`, which
  // keeps the first three components — so a host printing `1.2.3.4` is stored
  // as `1.2.3` and compares EQUAL to a genuine `1.2.3` baseline, yielding
  // `drift_class: none` and `current`.
  //
  // Under ADR-0053 that false match could not reach readiness alone: the
  // assurance ladder consumed the RAW text and refused the truncated class
  // before coverage. Removing the ladder without this guard leaves the false
  // `current` reaching the cutover gate.
  async function checkWith(claudeText) {
    const repoRoot = await mkdtemp(join(tmpdir(), 'trunc-'));
    const runId = 'compat-20260827T000000Z-bbbbbb';
    const dir = join(repoRoot, '.agentic-plugins', 'runs', 'compat', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      schema_version: 'runtime-compat-snapshot-1.2',
      run_id: runId,
      created_at: '2026-08-27T00:00:00.000Z',
      hosts: {
        claude: { host: 'claude', available: true, version: '2.1.233', version_text: claudeText },
        codex: { host: 'codex', available: true, version: '0.147.0', version_text: '0.147.0' },
      },
      remembered_baseline: { claude: { version: '2.1.233' }, codex: { version: '0.147.0' } },
    }));
    await writeFile(join(repoRoot, '.agentic-plugins', 'runs', 'compat', 'latest.json'), JSON.stringify({
      schema_version: 'runtime-compat-latest-1.0',
      run_id: runId,
      snapshot_pointer: `.agentic-plugins/runs/compat/${runId}/snapshot.json`,
    }));
    return checkSnapshot({ repoRoot, runId });
  }

  it('CONTROL: a faithfully-read version with no drift is `current`', async () => {
    const result = await checkWith('2.1.233');
    strictEqual(result.drift_class, 'none');
    strictEqual(result.status, 'current');
  });

  it('a four-component version is refused — the comparison could not see the difference', async () => {
    const result = await checkWith('2.1.233.7');
    strictEqual(result.status, 'host_version_unreadable');
    // The drift vocabulary is deliberately UNTOUCHED (ADR-0053 §Decision 4);
    // the truncation is evidence beside it and the readiness ladder is what
    // refuses. Without this the guard could be mistaken for a drift change.
    strictEqual(result.drift_class, 'none');
    ok(result.host_gaps.some((gap) => gap.observed_version_truncated === true));
  });

  it('trailing residue is refused too — the same class, three more shapes', async () => {
    for (const text of ['2.1.233-', '2.1.233+', '2.1.233..4']) {
      const result = await checkWith(text);
      strictEqual(result.status, 'host_version_unreadable', text);
    }
  });

  it('CONTROL: ordinary prose after a version is NOT truncation', async () => {
    // The property a wider detector would cost. `readVersionToken`'s own
    // controls pin this; repeated here because this is the caller that would
    // start refusing every real host string if the predicate widened.
    for (const text of ['2.1.233 (Claude Code)', '2.1.233. See the note below.', 'v2.1.233']) {
      const result = await checkWith(text);
      strictEqual(result.status, 'current', text);
    }
  });
});

describe('a legacy PLAN cannot decide the status of a current gap — the wiring, not the projector', () => {
  // ⚠ THE UNIT TESTS ABOVE DO NOT COVER THIS, and a mutation proved it:
  // replacing `planDecides` with a bare `plan.status === 'available'` in
  // `state-readers.mjs` left every `projectPlanFamily` case green. The projector
  // and its CALLER are two things, and the defect the review found lives in the
  // caller.
  async function seed({ gapStatus, planSchema, planStatus, actionable }) {
    const repoRoot = await mkdtemp(join(tmpdir(), 'plan-era-'));
    const runId = 'compat-20260827T000000Z-cccccc';
    const dir = join(repoRoot, '.agentic-plugins', 'runs', 'compat', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      schema_version: 'runtime-compat-snapshot-1.2', run_id: runId, created_at: '2026-08-27T00:00:00.000Z', hosts: {},
    }));
    await writeFile(join(dir, 'gap-analysis.json'), JSON.stringify({
      schema_version: 'runtime-compat-gap-1.2',
      run_id: runId,
      overall: { status: gapStatus, drift_class: 'none', snapshot_schema_era: 'post-assurance' },
      host_gaps: [],
    }));
    await writeFile(join(dir, 'plan.json'), JSON.stringify({
      schema_version: planSchema, run_id: runId, status: planStatus, actionable,
    }));
    return inspectCompatRuns({ repoRoot });
  }

  it('CONTROL: THIS era\'s plan still decides — an actionable plan outranks a current gap', async () => {
    // Without this, every refusal below would pass against a reader that ignores
    // plans entirely, which is a different defect with the same green suite.
    const runs = await seed({
      gapStatus: 'current', planSchema: 'runtime-compat-plan-1.2', planStatus: 'planned', actionable: true,
    });
    strictEqual(runs.latest.status, 'plan_ready');
  });

  it('an assurance-era plan does NOT reach `plan_ready` past a current gap', async () => {
    // The measured shape: `blocked_assurance` matches neither status the plan
    // branch names, so it fell through to `plan_ready` — a verdict from the
    // removed layer presenting itself as this era's "there is a plan to act on".
    const runs = await seed({
      gapStatus: 'current', planSchema: 'runtime-compat-plan-1.1', planStatus: 'blocked_assurance', actionable: true,
    });
    strictEqual(runs.latest.status, 'current', 'the gap decides; the legacy plan is pointed at and does not');
    ok(runs.latest.plan_pointer, 'the legacy plan is still POINTED AT — it is readable history, not a malformed artifact');
  });

  it('an unrecognized plan family does not decide either', async () => {
    const runs = await seed({
      gapStatus: 'current', planSchema: 'runtime-compat-plan-9.9', planStatus: 'planned', actionable: true,
    });
    strictEqual(runs.latest.status, 'current');
  });
});
