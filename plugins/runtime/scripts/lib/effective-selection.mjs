// plugins/runtime/scripts/lib/effective-selection.mjs
//
// The EFFECTIVE SELECTION (machine-bootstrap-contract.md §6.2) — the plugins the
// operator has not refused, which is what every selection-derived expectation is
// owed against.
//
// WHY THIS EXISTS. §6.2 says declining a plugin "creates a new effective `custom`
// selection and re-runs hard dependency closure". The implementation computed that
// retained set inside `applyAnswers`, used it to VALIDATE the decline, and threw it
// away. Everything downstream kept reading the planned `selection.desired`, so a
// declined plugin was refused and demanded at the same time:
//
//   * `requiredBoundPlugins` demanded every selected plugin's version be bound,
//     while `currentBoundVersions` can only bind an INSTALLED one — so a declined
//     plugin staled every proof forever, with a reason naming a plugin the operator
//     had refused, and no re-execution could ever produce a fresh proof;
//   * `hooks.codex.attested` stayed applicable and non-declinable over a refused
//     hook-bearing plugin, so the run was `incomplete` on an unsatisfiable step;
//   * the hard-required closure was computed over refused plugins too, so declining
//     `orchestrator` still left `engineer` non-declinable.
//
// The only escape was `abandon` plus a re-plan. This module is the retained set,
// derived ONCE and consumed everywhere.
//
// WHAT IT READS, and why that is legitimate. `plugin.<name>.<host>.installed` /
// `plugin.<name>.codex.enabled` rows carrying `status: 'declined'` — the same
// manifest-legitimate field the reducer already reads for `fragment_applied` and the
// egress opt-in. The judge never GENERATES `declined`; it only restores one an
// operator answer wrote (§6.2), so the status traces back to a person.
//
// WHAT IT REFUSES TO DO. It never narrows past declinability: a decline recorded
// against a mandatory plugin, or against one reached by a hard edge from a retained
// plugin, is NOT honoured here — at EITHER grain. A run file is operator-editable, so
// a hand-written `declined` on `companions` would otherwise delete
// `proof.deep-peer-smoke` from the expected set, and a per-host one would drop
// mandatory `companions` from that host's version binding: a false pass bought by
// editing the file the reducer is judging, through the front door or the side one.
//
// Declinability is recomputed to a FIXPOINT rather than once, because removing a
// plugin can free its hard-edge targets: `orchestrator` declined makes `engineer`
// declinable, and a single pass would honour the first decline and silently drop the
// second. The fixpoint is order-independent — removals only ever shrink the closure,
// so the same declined rows reduce alike whatever order they appear in.
//
// That is a property of THIS derivation and not an end-to-end claim about the CLI
// (Refine-verify peer, High): the answers gate judges each answer against the
// declinability the registry derived BEFORE the file was applied, so one answers file
// declining `orchestrator` and `engineer` together is refused on the `engineer` row.
// Chained declines take one resume each. What the fixpoint is for is a manifest that
// ALREADY carries both — a legacy run, or two resumes' worth of rows — which would
// otherwise honour one refusal and silently discard the other.

import { MANDATORY_PLUGINS, PLUGIN_SET_HOSTS, hardRequiredClosure } from './plugin-set.mjs';

// `plugin.<name>.<host>.installed` and `plugin.<name>.codex.enabled` — built by
// stepIds.pluginInstalled / stepIds.pluginEnabled. Parsed with an explicit grammar
// rather than a loose prefix match so a future `plugin.<name>.<something-else>` row
// cannot be read as a decline of the plugin itself.
const PLUGIN_STEP_RE = /^plugin\.([a-z][a-z0-9-]*)\.(claude|codex)\.(installed|enabled)$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The declined plugin rows, grouped by plugin: which hosts were refused outright
 * (`.installed`) and which Codex enablement was refused (`.enabled`).
 *
 * A `.enabled` decline is a real host-scoped refusal even though the plugin may be
 * installed: an un-enabled Codex plugin bears no hooks and runs nothing, so binding
 * its version into a proof would let a plugin the operator switched off stale the
 * evidence.
 */
export function declinedPluginRows(steps) {
  const rows = new Map();
  for (const step of steps ?? []) {
    if (!isPlainObject(step) || step.status !== 'declined' || typeof step.id !== 'string') continue;
    const m = step.id.match(PLUGIN_STEP_RE);
    if (!m) continue;
    const [, name, host, kind] = m;
    if (!rows.has(name)) rows.set(name, { installed: new Set(), enabled: new Set() });
    rows.get(name)[kind === 'installed' ? 'installed' : 'enabled'].add(host);
  }
  return rows;
}

/**
 * Resolve the effective selection for a run.
 *
 * @param pluginSet  the VALIDATED plugin-set — the authority for per-host membership
 *                   and the hard-edge closure.
 * @param selection  the run's recorded selection ({ bundle, desired, excluded }) or
 *                   any `{ desired }`-shaped object.
 * @param steps      the manifest's steps[] — read for `declined` status only.
 *
 * Returns:
 *   plugins   — plugin-level retained set (sorted). A plugin drops out when every
 *               host it targets was refused; a partial refusal keeps the plugin and
 *               narrows `byHost` instead, because the selection vocabulary
 *               (`desired: string[]`) cannot express "on Codex but not Claude" and
 *               dropping the whole plugin would refuse more than the operator did.
 *   byHost    — per-host retained sets. This is what version binding and the
 *               Codex-hook-bearing set are owed against.
 *   dropped   — plugins removed from the selection (sorted).
 *   refusedButRetained — declines this derivation did NOT honour, each with a reason.
 *               Surfaced rather than swallowed: a decline that cannot take effect is
 *               something the operator must be told about, not a silent no-op.
 */
export function effectiveSelection({ pluginSet, selection, steps = [] }) {
  const planned = [...new Set(selection?.desired ?? [])].sort();
  const rows = declinedPluginRows(steps);

  const hostsFor = (name) => (pluginSet?.plugins?.[name]?.hosts ?? []).filter((h) => PLUGIN_SET_HOSTS.includes(h));

  // Is this plugin refused ON THIS HOST — before any declinability rule is applied?
  // Two shapes count, and they are not the same fact: an `.installed` refusal says
  // the plugin will not be there, a Codex `.enabled` refusal says it will be there
  // and switched off. Both mean it runs nothing on that host, so both must stop it
  // binding versions and bearing hooks there.
  const rawHostRefusal = (name, host) => {
    const row = rows.get(name);
    if (!row) return false;
    if (row.installed.has(host)) return true;
    // Claude has no enable/disable state to refuse (test #31), so only Codex has a
    // second grain.
    return host === 'codex' && row.enabled.has('codex');
  };

  // A plugin is fully refused when EVERY host it targets is refused — by either
  // grain (Refine-verify peer, Medium): a Claude `.installed` refusal plus a Codex
  // `.enabled` one leaves the plugin valid nowhere, and counting only `.installed`
  // kept it in `plugins` while it was absent from both `byHost` lists — binding and
  // hooks treating it as gone while the proof registry treated it as present.
  //
  // A plugin the plugin-set gives no hosts at all is never "fully refused" by
  // vacuous truth — an empty host list would otherwise make `every` true and drop a
  // plugin nobody refused.
  const fullyRefused = (name) => {
    const hosts = hostsFor(name);
    if (hosts.length === 0) return false;
    return hosts.every((host) => rawHostRefusal(name, host));
  };

  let plugins = planned;
  // FIXPOINT (see the header): each round drops the fully-refused plugins that are
  // declinable AGAINST THE CURRENT retained set, then recomputes the closure. Bounded
  // by the selection size — every round removes at least one plugin or stops.
  for (let round = 0; round <= planned.length; round += 1) {
    const hardRequired = hardRequiredClosure(pluginSet, plugins);
    const removable = plugins.filter((name) => {
      if (!fullyRefused(name)) return false;
      if (MANDATORY_PLUGINS.includes(name)) return false;
      if (hardRequired.has(name)) return false;
      return true;
    });
    if (removable.length === 0) break;
    plugins = plugins.filter((name) => !removable.includes(name));
  }

  // Protection is a property of the PLUGIN, and it governs the host grain too
  // (Refine-verify peer, High). Honouring a host-scoped refusal against a protected
  // plugin while refusing the whole-plugin one is the same false pass through a
  // smaller door: a hand-written `plugin.companions.claude.installed: declined` would
  // otherwise drop mandatory `companions` from Claude version binding — the decline
  // that "cannot narrow the selection" narrowing it one host at a time.
  const finalHardRequired = hardRequiredClosure(pluginSet, plugins);
  const isProtected = (name) => MANDATORY_PLUGINS.includes(name) || finalHardRequired.has(name);

  // Report every refusal this derivation will not honour — whole-plugin or
  // host-scoped — with the rule that blocked it, computed against the FINAL retained
  // set so the reason names the state the operator would have to change.
  const refusedButRetained = [];
  for (const name of plugins) {
    if (!isProtected(name)) continue;
    const refusedHosts = hostsFor(name).filter((host) => rawHostRefusal(name, host));
    if (refusedHosts.length === 0) continue;
    const scope = refusedHosts.length === hostsFor(name).length ? '' : ` on ${refusedHosts.join(', ')}`;
    refusedButRetained.push({
      plugin: name,
      hosts: refusedHosts,
      reason: MANDATORY_PLUGINS.includes(name)
        ? `${name} is mandatory in every selection (§6.2), so its decline${scope} cannot narrow the selection`
        : `${name} is reached by a hard edge from a retained plugin (§6.2/§9.1), so its decline${scope} cannot narrow the selection`,
    });
  }
  const dropped = planned.filter((name) => !plugins.includes(name));

  const byHost = {};
  for (const host of PLUGIN_SET_HOSTS) {
    byHost[host] = plugins
      .filter((name) => hostsFor(name).includes(host))
      .filter((name) => isProtected(name) || !rawHostRefusal(name, host))
      .sort();
  }

  return { plugins, byHost, dropped, refusedButRetained };
}

/**
 * The effective selection as a SELECTION OBJECT ready to persist — §6.2's "new
 * effective `custom` selection", literally.
 *
 * The bundle becomes `custom` and that is load-bearing, not cosmetic: `resolveSelection`
 * re-expands a NAMED bundle from the plugin-set, so a narrowed `desired` left under
 * `bundle: "design"` would be silently re-widened the moment the selection is seeded
 * into a new run through a machine profile — the operator's decline undone by the
 * export/seed round trip.
 *
 * Returns `{ selection, changed, dropped, refusedButRetained }`. `changed: false`
 * returns the input object unchanged, so a caller can persist unconditionally without
 * rewriting a selection nobody narrowed.
 */
export function narrowSelectionByDeclines({ pluginSet, selection, steps = [] }) {
  return narrowSelectionToEffective({ pluginSet, selection, effective: effectiveSelection({ pluginSet, selection, steps }) });
}

/**
 * The same narrowing from an ALREADY-RESOLVED effective selection.
 *
 * Callers that re-derived and re-judged in between MUST use this rather than
 * re-deriving from `steps`: once a plugin leaves the selection its rows leave the
 * expectation too, so the declined rows that justified the narrowing are no longer in
 * `steps[]` to be found a second time. Re-deriving there concluded "nothing was
 * declined" and persisted the ORIGINAL selection over a correctly narrowed judgement
 * — the narrowing reverting inside the very verb that made it.
 */
export function narrowSelectionToEffective({ pluginSet, selection, effective }) {
  const planned = [...new Set(selection?.desired ?? [])].sort();
  const dropped = planned.filter((name) => !effective.plugins.includes(name));
  if (dropped.length === 0) {
    return { selection, changed: false, dropped: [], refusedButRetained: effective.refusedButRetained };
  }
  const known = Object.keys(pluginSet?.plugins ?? {}).sort();
  return {
    selection: {
      bundle: 'custom',
      desired: [...effective.plugins].sort(),
      excluded: known.filter((name) => !effective.plugins.includes(name)),
    },
    changed: true,
    dropped,
    refusedButRetained: effective.refusedButRetained,
  };
}

/**
 * The per-host plugin list a version-binding computation is owed against, from a
 * selection that may or may not carry `byHost`.
 *
 * Callers that never resolved an effective selection (library consumers, older
 * call sites, the tests' plain `{ plugins: [...] }` fixtures) fall back to the
 * plugin-level list — the pre-effective-selection behaviour, so a caller cannot
 * accidentally bind NOTHING by omitting the new member.
 */
export function hostPluginsOf(selection, host) {
  const byHost = selection?.byHost?.[host];
  const names = Array.isArray(byHost) ? byHost : (selection?.plugins ?? []);
  return [...new Set(names)].sort();
}
