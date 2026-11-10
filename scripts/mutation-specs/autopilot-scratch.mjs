// Mutation spec — do the suites of a run's temporary root and of the run
// retention hold the refusals they are named for?
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-scratch.mjs
//
// ADR-0068, amendment of 2026-11-10 (C175). scratch.mjs removes directories
// and retention.mjs removes a run's bulk; each is safe only through its
// refusals: a root proven the run's (its layout, its marker), a step
// directory kept while a peer's snapshot is not proven over, a starting run
// that never sweeps itself, a run a workflow names kept whole, and a
// citation read that keeps everything when it fails. Each mutation below
// removes one of them and names the case that must then fail. Every removal
// the suites make is under a directory the case made in the system's
// temporary directory, so a mutated guard deletes nothing else.

const T_SCRATCH = 'tests/orchestrator/test-autopilot-scratch.mjs';
const T_RETENTION = 'tests/orchestrator/test-autopilot-retention.mjs';
const SCRATCH = 'plugins/orchestrator/adapters/claude/autopilot/scratch.mjs';
const RETENTION = 'plugins/orchestrator/adapters/claude/autopilot/retention.mjs';

export const TESTS = [T_SCRATCH, T_RETENTION];

export const MUTATIONS = [
  {
    id: 'S1', file: SCRATCH, tests: [T_SCRATCH],
    from: "  if (marker.schema !== SCRATCH_SCHEMA || marker.run_id !== runId) throw new ScratchRefusal('marker-of-another-run', dir);",
    to: '  void SCRATCH_SCHEMA;',
    why: 'a root whose marker names another run is removed as this run\'s',
    killed_by: [/proveScratch reads the root, its marker and the child/, /keeps a root whose marker names another run/],
  },
  {
    id: 'S2', file: SCRATCH, tests: [T_SCRATCH],
    from: "  if (`${RUN_PREFIX}${path.basename(root)}` !== runId || path.basename(path.dirname(root)) !== SCRATCH_HOME) return refuse('root-layout');",
    to: '  void SCRATCH_HOME;',
    why: 'any absolute directory passes for a run\'s root, whatever it is named and wherever it lies',
    killed_by: /scratchTarget judges the paths alone/,
  },
  {
    id: 'S3', file: SCRATCH, tests: [T_SCRATCH],
    from: "    if (judged.verdict !== 'ended') { keep(`the peer snapshot ${snap} is not proven over (${judged.verdict}: ${judged.why})`); continue; }",
    to: '    void judged;',
    why: 'a live peer\'s snapshot is removed under it, and its step directory with it',
    killed_by: /a live peer's snapshot keeps the whole step directory/,
  },
  {
    id: 'S4', file: SCRATCH, tests: [T_SCRATCH],
    from: '    if (runId === selfRunId || open.has(runId)) continue;',
    to: '    if (open.has(runId)) continue;',
    why: 'a sweep takes the caller\'s own root when its index entry does not prove its driver alive',
    killed_by: /sweeps a dead driver's root, and never the caller's own/,
  },
  {
    id: 'S5', file: RETENTION, tests: [T_RETENTION],
    from: '      else if (cites.cited.has(j.run_id)) why = \'a workflow names the run\';',
    to: '      else if (cites.cited.has(null)) why = \'a workflow names the run\';',
    why: 'a run a workflow names is trimmed like any other, its worker streams and its verification logs',
    killed_by: /each keep whole the runs they name/,
  },
  {
    id: 'S6', file: RETENTION, tests: [T_RETENTION],
    from: '    return { ok: false, problem: `a workflow or journal does not read (${err.code ?? err.message})` };',
    to: '    return { ok: true, cited };',
    why: 'a citation source that does not read counts as one that names no run, and every run past the floors is trimmed',
    killed_by: /a workflow home that does not read keeps every run past the floors whole/,
  },
];
