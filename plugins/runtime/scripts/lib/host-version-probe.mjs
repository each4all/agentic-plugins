// plugins/runtime/scripts/lib/host-version-probe.mjs
//
// The observed host-version pair, in both the raw and the normalized form, from
// two `--version` probes.
//
// WHY THIS MODULE EXISTS AT ALL. It is `buildAssuranceProbe`, moved out of
// `lib/host-assurance-facts.mjs` when ADR-0056 removed that file. The function
// was never assurance machinery: its output feeds `buildHostParityBaseline`'s
// EXACTNESS verdict (ADR-0053 §Decision 1), which ADR-0056 §Consequences keeps
// untouched — "removing assurance removes the SECOND fact at the freshness site,
// not the first". Only its name and its address were assurance-shaped, and
// leaving it in a deleted module's file would have been the sole reason to keep
// that file.
//
// ⚠ THE JSON SHAPE IS UNCHANGED. `doctor`'s `host_parity_baseline.evidence`
// carries this object's `observed` / `normalized_observed` verbatim, and
// ADR-0056 §Decision 6 item 3 moves cutover's live host pair ONTO that field. A
// rename that also reshaped the payload would have moved the reader to a
// different fact while claiming it moved to the same one.

import { normalizeVersion } from './host-parity-baseline.mjs';

/**
 * Shape the observed-version pair from two host `--version` probes.
 *
 * BOTH forms travel, and the split is a measured false-exactness guard rather
 * than a convenience. Exactness compares the normalized form; a caller that
 * needs to see what the host actually printed — including the `1.2.3.4`
 * truncation signal `normalizeVersion` erases by keeping the first three
 * components — needs the RAW one.
 *
 * @param {object} o
 * @param {string?} o.claudeProbe  probe status for `claude --version`
 * @param {string?} o.codexProbe   probe status for `codex --version`
 * @param {string?} o.claudeText   RAW version text, or null when the probe failed
 * @param {string?} o.codexText    RAW version text, or null when the probe failed
 */
export function buildHostVersionProbe({ claudeProbe = null, codexProbe = null, claudeText = null, codexText = null } = {}) {
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
