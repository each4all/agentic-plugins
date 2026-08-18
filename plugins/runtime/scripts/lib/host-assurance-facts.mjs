// plugins/runtime/scripts/lib/host-assurance-facts.mjs
//
// ADR-0053 §Decision 2 / ADR-0054 §Decision 4 — the I/O COMPOSITION that turns a
// packaged install plus a host probe into the inputs `evaluateAssurance` needs.
//
// WHY A FOURTH MODULE, when three already describe this record. The other three
// are split by the QUESTION they answer; this one is split by the fact that it
// is the only one allowed to touch a disk:
//
//   host-parity-baseline.mjs   the grammars, and every packaged-asset read
//   assurance-contract.mjs     the semantics of a record and of installed state
//   assurance-result.mjs       the report fact, and a ladder that is PURE
//   this module                the composition: read the package, catch what
//                              throws, shape the probe, call the pure ladder
//
// It could not be folded into any of them, and the reasons are structural
// rather than stylistic:
//
//   * `assurance-result.mjs` states its own invariant — `evaluateAssurance`
//     "reads no file, spawns nothing, and consults no clock" — and that purity
//     is what makes its hash-disagreement branch reachable in a test at all.
//     Putting the reads there would delete the property the module exists for.
//   * `host-parity-baseline.mjs` would have to import `assurance-result.mjs`,
//     which imports it. That is a cycle, not a preference.
//
// It exists at all because of a cross-host Plan-verify finding on the compat
// slice: `evaluateAssurance` needs the resolved baseline, the record AND the
// fault its reader throws, the plugin set AND its fault, raw and normalized
// versions, both probe statuses, the package observation, and an injected date.
// `doctor.mjs` already composed all of that privately. A second caller wiring
// the same three low-level imports would have reproduced roughly a hundred
// lines — the four-private-copies failure ADR-0051 §Decision 4 forbids, arriving
// for a fact that is one release old.
//
// ⚠ THIS MODULE DECIDES NO POLICY. It reads, it catches, it shapes, and it hands
// the result to the ladder. Every verdict below belongs to `evaluateAssurance`.

import {
  normalizeVersion,
  resolveAssuranceRecord,
  resolveHostParityBaseline,
} from './host-parity-baseline.mjs';
import { observePackages } from './assurance-contract.mjs';
import { evaluateAssurance } from './assurance-result.mjs';
import { loadPluginSet } from './plugin-set.mjs';
import { sanitizeValue } from './permission-sanitize.mjs';

/**
 * Shape the observed-version half of `evaluateAssurance`'s `probe` input.
 *
 * BOTH forms travel, and the split is a measured false-coverage guard rather
 * than a convenience. Exactness needs the normalized form; membership and
 * direction need the RAW one, because `normalizeVersion` keeps the first three
 * components and so erases the `1.2.3.4` truncation signal — measured end to
 * end, a machine reporting `1.2.3.4` reaches `covered` against a human grant for
 * `1.2.3` when the normalized form is handed to the matcher.
 *
 * @param {object} o
 * @param {string?} o.claudeProbe  probe status for `claude --version`
 * @param {string?} o.codexProbe   probe status for `codex --version`
 * @param {string?} o.claudeText   RAW version text, or null when the probe failed
 * @param {string?} o.codexText    RAW version text, or null when the probe failed
 */
export function buildAssuranceProbe({ claudeProbe = null, codexProbe = null, claudeText = null, codexText = null } = {}) {
  // Gate on a successful probe on BOTH hosts. A failed `--version` carries
  // stderr or an error message in its text, so normalizing it would manufacture
  // an observed version out of a diagnostic.
  const probesOk = claudeProbe === 'available' && codexProbe === 'available';
  const observedClaude = probesOk ? claudeText ?? null : null;
  const observedCodex = probesOk ? codexText ?? null : null;
  return {
    claude_probe: claudeProbe,
    codex_probe: codexProbe,
    probes_ok: probesOk,
    observed: { claude: observedClaude, codex: observedCodex },
    normalized_observed: {
      claude: normalizeVersion(observedClaude),
      codex: normalizeVersion(observedCodex),
    },
  };
}

/**
 * Read the packaged assurance inputs from ONE install.
 *
 * Returns `{resolved, record, recordFault, pluginSet, pluginSetFault}` — the
 * faults are values rather than exceptions because every consumer turns a
 * runtime fault into a check verdict, and `evaluateAssurance` is the one that
 * decides which verdict.
 *
 * ⚠ `TypeError` IS RETHROWN, and that is not decoration. Both packaged readers
 * raise `TypeError` for an empty or null `pluginRoot` override, which is a
 * CALLER bug; swallowing it would turn a programmer error into a package
 * verdict and hide it.
 *
 * `pluginRoot === undefined` means "no override" and is passed as an absent key
 * so each reader applies its own packaged default. Anything else is passed
 * THROUGH, so an explicit empty override throws instead of being laundered into
 * the default — a caller that meant to inspect a specific install must never
 * silently inspect this one.
 */
export async function readAssuranceInputs({ pluginRoot } = {}) {
  const resolveOpts = pluginRoot === undefined ? {} : { pluginRoot };
  const resolved = await resolveHostParityBaseline(resolveOpts);

  let record = null;
  let recordFault = null;
  try {
    record = await resolveAssuranceRecord(resolveOpts);
  } catch (err) {
    if (err instanceof TypeError) throw err;
    recordFault = sanitizeValue(err?.message) ?? 'unknown error';
  }

  let pluginSet = null;
  let pluginSetFault = null;
  try {
    pluginSet = await loadPluginSet(resolveOpts);
  } catch (err) {
    if (err instanceof TypeError) throw err;
    pluginSetFault = sanitizeValue(err?.message) ?? 'unknown error';
  }

  return { resolved, record, recordFault, pluginSet, pluginSetFault };
}

/**
 * Observe installed packages from a machine probe's plugin listings.
 *
 * NOT `summarizePluginStatus`, and ADR-0054 §Decision 9 rules it out by name:
 * its Codex accounting counts `decision === 'disabled'` toward `available`, and
 * "is disabled" is one of the three conditions ADR-0053 §Decision 8 requires to
 * invalidate a grant. Reusing the coarse status would make that invalidation
 * structurally unable to fire.
 *
 * `claudeListStatus` is threaded explicitly because `parseClaudePluginList` is
 * handed stdout whether or not the command SUCCEEDED, so a failed
 * `claude plugin list` that printed partial text yields entries indistinguishable
 * from a clean probe's. Omitting it yields `authoritative: false`, which blocks —
 * the fail-closed direction.
 */
export function observeMachinePackages(machine) {
  return observePackages({
    claudePluginList: machine?.claudePluginList ?? null,
    claudeListStatus: machine?.claude?.plugin?.status ?? null,
    codexPluginList: machine?.codexPluginList ?? null,
  });
}

/**
 * The whole composition: packaged reads + a shaped probe + package observation,
 * handed to the PURE ladder.
 *
 * Returns `{resolved, probe, packageObservation, assurance}`. `resolved` and
 * `probe` are returned rather than kept private because a caller that also
 * reports EXACTNESS must derive it from the SAME read and the SAME observation —
 * a report whose exactness line and assurance line named different host versions
 * would be unreadable in exactly the case that matters.
 *
 * @param {object} o
 * @param {object} o.probe   `buildAssuranceProbe` output.
 * @param {object?} o.packageObservation `observePackages` output, or null when no
 *                           listing was taken. Passed in rather than derived here
 *                           because doctor already destructures its machine probe
 *                           into fields and compat holds the whole machine object;
 *                           `observeMachinePackages` is exported for the latter.
 * @param {string} o.today   the evaluation date, `YYYY-MM-DD`, INJECTED — reading
 *                           the clock here would let one artifact carry a
 *                           `generated_at` and a coverage verdict decided on
 *                           different days, and `assuranceRecordIssues` rejects a
 *                           `reviewed_at` in the future.
 */
export async function resolveHostAssuranceFacts({ pluginRoot, probe, packageObservation = null, today } = {}) {
  const inputs = await readAssuranceInputs({ pluginRoot });
  return {
    resolved: inputs.resolved,
    probe,
    packageObservation,
    assurance: evaluateAssurance({
      resolvedBaseline: inputs.resolved,
      record: inputs.record,
      recordFault: inputs.recordFault,
      pluginSet: inputs.pluginSet,
      pluginSetFault: inputs.pluginSetFault,
      probe,
      packageObservation,
      today,
    }),
  };
}
