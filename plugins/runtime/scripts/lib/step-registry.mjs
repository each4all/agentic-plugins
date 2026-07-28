// plugins/runtime/scripts/lib/step-registry.mjs
//
// The EXPECTED-STEP REGISTRY (machine-bootstrap-contract.md §6.1) — the exact set
// of steps a given selection owes, with each step's stage, applicability,
// declinability, and `blocked_by` edges.
//
// WHY A REGISTRY AND NOT THE MANIFEST'S OWN steps[]. The reducer walks an exact
// EXPECTED set derived from the selection, not the array the manifest happens to
// contain. A manifest that simply omits a required step would otherwise pass the
// reducer — the exact false-pass this command exists to prevent (§6.1, test #11).
// The same reasoning bans trusting a manifest's stage/declinable/blocked_by values:
// a run file is operator-editable data, so an edited copy could grant itself a
// stage, mark a mandatory step declinable, or drop a blocker. Everything derivable
// is derived HERE, from the validated plugin-set; only step STATE is read from the
// manifest (which is what §7's second trap requires — inspect blocked / manual /
// follow-up / unknown states directly).
//
// APPLICABILITY IS A FUNCTION OF FACTS, not of the run's own claims. Each entry
// declares what it needs from an explicit context — the resolved selection, the
// plugin-set's per-host hook_bearing, and (for the permission proof only) whether a
// fragment was actually applied. Passing that context in keeps every rule pure and
// testable, and keeps the "derive, never trust" boundary visible in the signature.

import { hostPluginsOf } from './effective-selection.mjs';
import { PLUGIN_SET_HOSTS, codexHookBearingPlugins, hardRequiredClosure } from './plugin-set.mjs';

// §8 — the reducer partitions the expected steps by stage. CONFIG (1–7) and PROOF
// (8) are separated because the two terminal states differ ONLY on PROOF: both
// require every CONFIG step resolved, and `configured-not-verified` is exactly
// "CONFIG done, PROOF not". A single "every expected step resolved" clause made that
// state unreachable, since proof steps are themselves expected steps (the §8 reducer
// defect corrected in S8a2 C0).
export const CONFIG_STAGES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const PROOF_STAGES = Object.freeze([8]);

export const STEP_STATUSES = Object.freeze([
  'satisfied', 'pending', 'blocked', 'manual-follow-up', 'declined', 'unknown', 'not-applicable',
]);

// §6 — the statuses that COUNT toward completion. `unknown` is deliberately absent:
// the probe could not determine the state, and unknown is never satisfied.
export const RESOLVED_STEP_STATUSES = Object.freeze(['satisfied', 'declined', 'not-applicable']);

// The step-id builders. One place constructs every id, so a template and its parser
// can never drift into disagreement.
export const stepIds = Object.freeze({
  hostPresent: (host) => `host.${host}.present`,
  hostAuthenticated: (host) => `host.${host}.authenticated`,
  marketplaceRegistered: (host) => `marketplace.${host}.registered`,
  pluginInstalled: (name, host) => `plugin.${name}.${host}.installed`,
  pluginEnabled: (name) => `plugin.${name}.codex.enabled`,
  configModelEffort: () => 'config.model_effort',
  notifyConfigured: () => 'notify.configured',
  // ADR-0048 §1 (notify split): `notify.configured` keeps meaning exactly the
  // LOCAL runtime notification policy (~/.agentic-plugins/config.toml notify
  // family); this one observes the CODEX-side wiring (`notify =` in
  // $CODEX_HOME/config.toml) separately. One id per host-shaped fact, like
  // permission.<host>.applied.
  notifyCodexConfigured: () => 'notify.codex.configured',
  egressConfigured: () => 'egress.configured',
  permissionApplied: (host) => `permission.${host}.applied`,
  hooksAttested: () => 'hooks.codex.attested',
  proofDeepPeerSmoke: () => 'proof.deep-peer-smoke',
  proofWorkflowContinuation: () => 'proof.workflow-continuation',
  proofPermission: () => 'proof.permission',
  // ADR-0048 §3 — the OPT-IN egress delivery evidence step. The kind string is
  // pinned as `egress-provider-ack` (never "dispatch"/"delivery"): it proves
  // exactly that the pinned provider request returned HTTP 2xx + {ok:true}.
  proofEgressProviderAck: () => 'proof.egress-provider-ack',
  // ADR-0048 §1 — per-host statusline configuration steps. The Claude step's
  // meaning is pinned to "canonical configuration OBSERVED" — never
  // "statusline runs" (workspace trust / disableAllHooks / safe mode gate
  // execution and no probe may relax them).
  statuslineConfigured: (host) => `statusline.${host}.configured`,
});

// §6.2 — not declinable, EVER: host CLI presence and authentication; marketplace
// registration; `runtime`; `companions`; and any plugin reached by a hard edge from
// a retained plugin. The last is selection-dependent, so it is computed per run
// rather than listed here.
export const NEVER_DECLINABLE_PLUGINS = Object.freeze(['runtime', 'companions']);

/**
 * Derive the exact expected-step set for a selection.
 *
 * @param pluginSet   the VALIDATED plugin-set (lib/plugin-set.mjs) — the authority for
 *                    per-host membership, hook_bearing, AND the hard-edge closure.
 * @param selection   { plugins: string[], byHost?: { claude: string[], codex: string[] } }
 *                    — the EFFECTIVE selection (lib/effective-selection.mjs): the
 *                    bundle expanded and closed, then narrowed by whatever the
 *                    operator declined (§6.2). `byHost` carries the per-host retained
 *                    sets, which is what the Codex-hook-bearing expectation is owed
 *                    against; it is optional, and its absence falls back to `plugins`
 *                    so a caller cannot silently derive an EMPTY host set by omitting
 *                    it. Note there is deliberately no
 *                    `hardRequired` input: which plugins a hard edge protects is
 *                    DERIVED from the plugin-set here. Accepting it from the caller
 *                    was the same forgery this registry exists to prevent — a caller
 *                    who forgot to compute it made `engineer` declinable inside a
 *                    bundle whose `orchestrator` hard-requires it, and the operator
 *                    would have been offered a decline that breaks their selection.
 * @param permissionFragmentApplied
 *                    per-host booleans read from the run's OWN step states. This is the
 *                    one input that legitimately comes from the manifest: §5 and §8.1
 *                    both require the permission proof "iff a permission.*.applied step
 *                    carries fragment_applied: true", so a machine whose permissions
 *                    already matched does not trip a proof it never needed. (§6.1's
 *                    table said "is satisfied" — a looser restatement that would demand
 *                    a proof for a config this run never changed; corrected in C4.)
 * @param egressProofRequested
 *                    ADR-0048 §3 / D0.2 — the OPT-IN signal for the
 *                    `proof.egress-provider-ack` step. Callers derive it through
 *                    `egressProofOptedIn` (lib/completion-reducer.mjs), which
 *                    accepts exactly three provenances: an `execute`/`decline`
 *                    answer in the run's `choices[]` ledger, a `declined` status
 *                    on the step's row (a status the judge only ever restores
 *                    from an operator answer), or a RECORDED
 *                    `egress-provider-ack` proof. Default false: a machine that
 *                    never opted in never owes the proof, and §8.1's "required
 *                    iff opted in" falls out of applicability.
 *
 *                    Note what this must NEVER be derived from. Not the mere
 *                    PRESENCE of the step in steps[]: this function enumerates
 *                    the step on every run (below) so it can be reported, and
 *                    judgeSteps persists that enumeration, so a presence test is
 *                    true on every machine — which made the proof required
 *                    everywhere and put `complete` out of reach for every machine
 *                    that never opted in. Nor the row's generic status: `pending`
 *                    is what judgeSteps writes for every `proof.*` step and
 *                    `blocked` is what its demotion pass rewrites that to, so
 *                    treating "any status but not-applicable" as consent reads
 *                    machine output as an operator answer — and lets the defect
 *                    above outlive its fix on any run the broken code resumed.
 *                    Applicability derived from the row this derivation itself
 *                    produces is circular; it has to come from a fact about the
 *                    operator, or about evidence on disk.
 *
 * Returns steps in canonical order (stage, then id), each with an EXPLICIT blocked_by
 * array — `[]` is written, never omitted, so "no predecessors" and "edges missing from
 * the file" are not the same bytes.
 */
export function deriveExpectedSteps({ pluginSet, selection, permissionFragmentApplied = {}, egressProofRequested = false }) {
  const plugins = [...new Set(selection.plugins ?? [])].sort();
  // DERIVED from the plugin-set's hard edges, transitively — never taken from the
  // caller (§6.2, and the registry-authority rule in this file's header).
  const hardRequired = hardRequiredClosure(pluginSet, plugins);
  const steps = [];

  const hostsFor = (name) => (pluginSet.plugins[name]?.hosts ?? []).filter((h) => PLUGIN_SET_HOSTS.includes(h));
  const isDeclinablePlugin = (name) => !NEVER_DECLINABLE_PLUGINS.includes(name) && !hardRequired.has(name);

  // Stage 1 — host CLI presence and authentication. Never declinable (§6.2).
  for (const host of PLUGIN_SET_HOSTS) {
    steps.push({ id: stepIds.hostPresent(host), stage: 1, applicable: true, declinable: false, blocked_by: [] });
    steps.push({ id: stepIds.hostAuthenticated(host), stage: 1, applicable: true, declinable: false, blocked_by: [stepIds.hostPresent(host)] });
  }

  // Stage 2 — marketplace registration. Blocked by the CLI's presence only: a
  // marketplace is registered THROUGH the CLI, but registering a public catalog does
  // not itself require an authenticated session, and asserting an edge we cannot
  // stand behind would block a step that is actually reachable.
  for (const host of PLUGIN_SET_HOSTS) {
    steps.push({ id: stepIds.marketplaceRegistered(host), stage: 2, applicable: true, declinable: false, blocked_by: [stepIds.hostPresent(host)] });
  }

  // Stage 3 — per plugin, per host it targets. Enumerated from the PLUGIN-level
  // retained set, deliberately not the per-host one: a host-scoped decline
  // (`plugin.image.claude.installed` refused while Codex is kept) has nowhere else to
  // live. `selection.desired` is a flat name list, so a partial refusal is
  // recoverable only from the declined ROW — dropping that row from the expectation
  // would delete the evidence the next run derives the same narrowing from.
  for (const name of plugins) {
    for (const host of hostsFor(name)) {
      steps.push({
        id: stepIds.pluginInstalled(name, host),
        stage: 3,
        applicable: true,
        declinable: isDeclinablePlugin(name),
        blocked_by: [stepIds.marketplaceRegistered(host)],
      });
    }
    // `.enabled` is Codex-only and follows `.installed` (§6.1). Claude has no
    // disabled state to enable (test #31).
    if (hostsFor(name).includes('codex')) {
      steps.push({
        id: stepIds.pluginEnabled(name),
        stage: 3,
        applicable: true,
        declinable: isDeclinablePlugin(name),
        blocked_by: [stepIds.pluginInstalled(name, 'codex')],
      });
    }
  }

  // Stage 4–6 — agentic-plugins' own config, then the operator-applied fragments.
  steps.push({ id: stepIds.configModelEffort(), stage: 4, applicable: true, declinable: false, blocked_by: [] });
  steps.push({ id: stepIds.notifyConfigured(), stage: 5, applicable: true, declinable: true, blocked_by: [] });
  // ADR-0048 §1 — the Codex-side notify wiring, split from the local policy
  // step above (the pre-split judge only ever read ~/.agentic-plugins/config.toml,
  // so the Codex `notify =` merge was presented but never re-observed). Edged
  // on the Codex CLI being present, the permission.<host>.applied precedent
  // for a host-targeted config step.
  steps.push({ id: stepIds.notifyCodexConfigured(), stage: 5, applicable: true, declinable: true, blocked_by: [stepIds.hostPresent('codex')] });
  // ADR-0048 §1 — the two per-host, DECLINABLE statusline steps (a single
  // combined step could false-pass after only one host is configured).
  for (const host of PLUGIN_SET_HOSTS) {
    steps.push({ id: stepIds.statuslineConfigured(host), stage: 5, applicable: true, declinable: true, blocked_by: [stepIds.hostPresent(host)] });
  }
  steps.push({ id: stepIds.egressConfigured(), stage: 5, applicable: true, declinable: true, blocked_by: [] });
  for (const host of PLUGIN_SET_HOSTS) {
    steps.push({ id: stepIds.permissionApplied(host), stage: 6, applicable: true, declinable: true, blocked_by: [stepIds.hostPresent(host)] });
  }

  // Stage 7 — Codex hook attestation. Applicable IFF a RETAINED plugin is
  // Codex-hook-bearing; keys off the CODEX value, because Claude trusts plugin hooks
  // by install and exposes no /hooks review flow (§6.1, as corrected in C0).
  //
  // Read from the per-host retained set, not from `plugins` (§6.2): this step is
  // non-declinable, so a refused Codex hook plugin left in the expectation makes it
  // permanently unsatisfiable — no attestation can cover a plugin the operator will
  // not install or enable, and the run is `incomplete` on a step with no reachable
  // resolution.
  const codexHookPlugins = codexHookBearingPlugins(pluginSet, hostPluginsOf(selection, 'codex'));
  steps.push({
    id: stepIds.hooksAttested(),
    stage: 7,
    applicable: codexHookPlugins.length > 0,
    declinable: false,
    blocked_by: codexHookPlugins.flatMap((name) => [stepIds.pluginInstalled(name, 'codex'), stepIds.pluginEnabled(name)]),
  });

  // Stage 8 — proofs. Every proof is declinable, and declining one caps the run at
  // `configured-not-verified` — never `complete` (§6.2).
  const companionsHosts = hostsFor('companions');
  steps.push({
    id: stepIds.proofDeepPeerSmoke(),
    stage: 8,
    // Always applicable, and that is not an accident: `companions` is mandatory in
    // every selection precisely so this proof stays reachable (§6.2).
    applicable: true,
    declinable: true,
    blocked_by: [
      ...PLUGIN_SET_HOSTS.map((h) => stepIds.hostAuthenticated(h)),
      ...companionsHosts.map((h) => stepIds.pluginInstalled('companions', h)),
      ...(companionsHosts.includes('codex') ? [stepIds.pluginEnabled('companions')] : []),
    ],
  });

  const engineerSelected = plugins.includes('engineer');
  const engineerHosts = engineerSelected ? hostsFor('engineer') : [];
  steps.push({
    id: stepIds.proofWorkflowContinuation(),
    stage: 8,
    applicable: engineerSelected,
    declinable: true,
    blocked_by: engineerSelected
      ? [
          ...engineerHosts.map((h) => stepIds.pluginInstalled('engineer', h)),
          ...(engineerHosts.includes('codex') ? [stepIds.pluginEnabled('engineer')] : []),
        ]
      : [],
  });

  steps.push({
    id: stepIds.proofPermission(),
    stage: 8,
    applicable: PLUGIN_SET_HOSTS.some((h) => permissionFragmentApplied[h] === true),
    declinable: true,
    blocked_by: PLUGIN_SET_HOSTS.map((h) => stepIds.permissionApplied(h)),
  });

  // ADR-0048 §3 — OPT-IN delivery evidence (D0.2): applicable only once the
  // operator asked for it; a machine that never opted in reduces it
  // not-applicable, which is §8.1's "required iff opted in". Edged on the
  // egress activation step — an ack proof over an unconfigured egress channel
  // is unreachable by construction.
  steps.push({
    id: stepIds.proofEgressProviderAck(),
    stage: 8,
    applicable: egressProofRequested === true,
    declinable: true,
    blocked_by: [stepIds.egressConfigured()],
  });

  return steps.sort((a, b) => a.stage - b.stage || a.id.localeCompare(b.id));
}

/**
 * Structural validation of a derived step set: every `blocked_by` target exists, the
 * graph is acyclic, and no id repeats. Returns { ok, errors }.
 *
 * Acyclicity is checked rather than assumed. A cycle would not throw anywhere — it
 * would make two steps permanently `blocked`, each waiting on the other, and the run
 * would simply never complete with no diagnostic naming why. That is the kind of
 * failure that reads as "the tool is stuck" instead of "the registry is wrong".
 */
export function validateStepGraph(steps) {
  const errors = [];
  const byId = new Map();
  for (const step of steps) {
    if (byId.has(step.id)) errors.push(`duplicate step id '${step.id}'`);
    byId.set(step.id, step);
    if (!Array.isArray(step.blocked_by)) errors.push(`${step.id}: blocked_by must be an explicit array (write [] rather than omitting it)`);
    if (!CONFIG_STAGES.includes(step.stage) && !PROOF_STAGES.includes(step.stage)) {
      errors.push(`${step.id}: stage ${step.stage} is outside the 1-8 taxonomy`);
    }
  }
  for (const step of steps) {
    for (const target of step.blocked_by ?? []) {
      if (!byId.has(target)) errors.push(`${step.id}: blocked_by names '${target}', which is not an expected step for this selection`);
    }
  }

  // Iterative DFS with an explicit colour map — a recursive walk would be simpler but
  // would blow the stack on a pathological registry rather than reporting the cycle.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map([...byId.keys()].map((id) => [id, WHITE]));
  for (const root of byId.keys()) {
    if (colour.get(root) !== WHITE) continue;
    const stack = [[root, 0]];
    const path = [];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [id, index] = frame;
      if (index === 0) {
        colour.set(id, GREY);
        path.push(id);
      }
      const edges = byId.get(id)?.blocked_by ?? [];
      if (index < edges.length) {
        frame[1] += 1;
        const next = edges[index];
        if (!byId.has(next)) continue;
        if (colour.get(next) === GREY) {
          errors.push(`cycle in blocked_by: ${[...path.slice(path.indexOf(next)), next].join(' → ')}`);
          continue;
        }
        if (colour.get(next) === WHITE) stack.push([next, 0]);
        continue;
      }
      colour.set(id, BLACK);
      path.pop();
      stack.pop();
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * The ids a selection expects, as a Set — what `completion.missing_steps` is computed
 * against. Only APPLICABLE steps are expected; a not-applicable step is enumerated by
 * `deriveExpectedSteps` (so it can be reported) but is not owed by the manifest.
 */
export function expectedStepIds(steps) {
  return new Set(steps.filter((step) => step.applicable).map((step) => step.id));
}
