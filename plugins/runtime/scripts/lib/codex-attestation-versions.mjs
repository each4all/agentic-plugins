// plugins/runtime/scripts/lib/codex-attestation-versions.mjs
//
// The version authority for the Codex /hooks attestation (machine-bootstrap-contract.md
// §8.2, S8a4). An attestation is an operator claim bound to specific versions — "a claim
// made against Codex 0.137 does not survive an upgrade" — so the PRODUCER (settings) and
// doctor's currency MIRROR must resolve "the installed version" identically. When they
// disagree, a freshly recorded attestation reads as stale on the machine that wrote it.
//
// This leaf is that single authority. It carries no I/O and knows nothing about either
// caller, so settings and doctor share it without importing each other.

// The attestation binds a Codex CLI version INTO the record that the completion reducer
// (recomputeHookAttestation) later re-validates, so the grammar here MUST match the
// reducer's SEMVER_RE exactly — a version this accepts but the reducer rejects would bind
// an attestation the reducer then reports permanently stale.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const CODEX_CLI_PREFIX = 'codex-cli ';

/**
 * Strictly parse a Codex CLI `--version` string into a bare semver, or null.
 *
 * `codex --version` prints `codex-cli 0.144.1`; a bare `0.144.1` is also accepted. Anything
 * else — empty, a captured error message, multiple version tokens, trailing junk — is null,
 * because an UNPARSEABLE version must make the attestation not-attestable, never bind it to
 * a guess. This deliberately does NOT reuse doctor's normalizeHostVersion: that helper
 * greedily extracts the first semver-shaped substring and, failing that, returns the raw
 * text — exactly the two behaviors that would let junk or an error string bind an
 * attestation.
 */
export function parseCodexCliVersion(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidate = trimmed.startsWith(CODEX_CLI_PREFIX)
    ? trimmed.slice(CODEX_CLI_PREFIX.length).trim()
    : trimmed;
  // A single token only. `0.1.0 0.2.0`, `0.1.0 (build)`, `codex-cli 0.1.0 extra` all carry
  // whitespace after the prefix is stripped and must be rejected as ambiguous.
  if (/\s/.test(candidate)) return null;
  return SEMVER_RE.test(candidate) ? candidate : null;
}

/**
 * Resolve the Codex list-authoritative INSTALLED version of a plugin, for binding into a
 * /hooks attestation.
 *
 * An operator attests the hooks of the plugin that is INSTALLED on Codex and whose handlers
 * are actually loaded — so the authority is the Codex plugin list (`codex_resolved`), never
 * the source manifest a dev checkout carries regardless, and never the Claude install. This
 * is why the generic `installed_version` field is wrong here: it falls through Codex → Claude
 * → source, so a machine with the plugin installed only on Claude would bind a Codex
 * attestation to a version Codex never loaded.
 *
 * @param plugin a buildPluginPlans result entry, carrying `codex_installed: { version,
 *   decision, enabled }`.
 * @returns { version: string|null, attestable: boolean, reason: string|null }
 *   - `installed`     → the list version; attestable when that version is present.
 *   - `disabled`      → the list version, but NOT attestable (a disabled plugin loads no hooks).
 *   - `not_installed` → null, NOT attestable, and NO cache/source/Claude fallback.
 *   - `fallback`      → the Codex cache version (the list probe was unavailable); attestable
 *                        when present, because the cache is the best remaining Codex evidence.
 *   - null decision   → a legacy doctor report predating codex_resolved; cache fallback, same rule.
 */
export function resolveCodexInstalledPluginVersion(plugin) {
  const codexInstalled = plugin?.codex_installed ?? null;
  const decision = codexInstalled?.decision ?? null;
  const version = codexInstalled?.version ?? null;

  if (decision === 'disabled') {
    return { version, attestable: false, reason: 'plugin is installed but disabled on Codex — a disabled plugin loads no hooks' };
  }
  if (decision === 'not_installed') {
    return { version: null, attestable: false, reason: 'plugin is not installed on Codex (list-authoritative)' };
  }
  // 'installed', 'fallback', or a legacy null decision: the version field already folds
  // fallback → Codex cache. A present version is attestable; a null one is not.
  if (version === null) {
    return { version: null, attestable: false, reason: 'no Codex-installed version could be resolved' };
  }
  return { version, attestable: true, reason: null };
}
