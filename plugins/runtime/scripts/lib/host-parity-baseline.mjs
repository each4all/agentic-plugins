// Host-parity baseline resolver — ADR-0051.
//
// One source, one grammar, one failure vocabulary, for every runtime command.
//
// Before this module, four readers disagreed on where the baseline lives and
// how to parse it: compat read PLUGIN_ROOT with a loose version-only regex,
// doctor and dashboard read repoRoot with the dated header and then disagreed
// on what to call a parse failure (`missing` vs `unparsed`), and the CI drift
// script imported compat's parser but resolved its own repository path.
//
// ADR-0051 makes the PACKAGED copy the sole authority for runtime commands.
// The repository copy is what gets reviewed and released; it is never a
// runtime read. `scripts/check-host-version-drift.mjs` is the one carve-out —
// it is a CI script operating on the source tree — and it keeps importing this
// module's parser so the grammar stays single-sourced rather than forked.
//
// Two consequences worth stating, because they are the point:
//
//   - There is no fallback. That is what makes strict parsing safe: a
//     present-but-unparseable baseline is a VISIBLE failure, not a silent
//     degrade through some older copy.
//   - Provenance is content-identifying, not just locational. `PLUGIN_ROOT`
//     can itself be a development checkout, so "packaged" is not a truthful
//     label on its own, and a path cannot distinguish the same file before and
//     after mutation. The measured incident behind ADR-0051 was exactly that:
//     two installs of runtime `0.89.0` carrying different baselines, because
//     `16b1833` changed packaged content without changing the version, so a
//     version-keyed updater had nothing to do. A content hash is what makes
//     that observable.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_RELATIVE_PATH = 'docs/host-parity-baseline.md';

// The canonical grammar. A baseline states WHEN it was observed and WHICH
// versions were observed; a version pair with no date cannot be aged, so it is
// not a baseline. compat previously accepted the dateless form.
const HEADER_RE = /Observed on ([0-9]{4}-[0-9]{2}-[0-9]{2}) with Claude Code\s*`([^`]+)`,\s*Codex CLI\s*`([^`]+)`/m;

// Two- or three-component, matching VERSION_TOKEN_RE below and the CI drift
// script's own normalizer. An earlier three-component-only form made
// `parseBaseline` accept `2.1` while `normalizeVersion` returned null for
// it — the module disagreeing with itself.
const SEMVER_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;
// A version token must CONTAIN a version. Matching only the date and the
// backtick structure let `Claude Code \`banana\`, Codex CLI \`potato\`` resolve —
// a malformed baseline that cross-host review showed could reach a `current`
// verdict.
//
// Deliberately "contains", not "equals": real baselines record the observed
// CLI text, and `2.1.197 (Claude Code)` / `codex-cli 0.142.4` are how the
// hosts actually print themselves. The failure being excluded is a slot with
// NO version in it, not a version wearing a label — an anchored form rejected
// existing valid documents.
const VERSION_TOKEN_RE = SEMVER_RE;

/** Package root of the runtime plugin this module was loaded from. */
export function defaultPluginRoot() {
  // lib/ -> scripts/ -> <plugin root>
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function normalizeVersion(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // Returning the raw text when nothing matched made `banana` a version.
  // Nothing downstream can tell that apart from a real one, so it is null.
  return text.match(SEMVER_RE)?.[0] ?? null;
}

/**
 * Parse the canonical dated header.
 *
 * Returns `null` when the text does not carry it. Callers distinguish "no
 * file" from "file that does not parse" — collapsing those two was one of the
 * inconsistencies ADR-0051 §Decision 4 removes.
 */
export function parseBaseline(text) {
  const match = String(text ?? '').match(HEADER_RE);
  if (!match) return null;
  const [, date, claude, codex] = match;
  // Both halves of the grammar, not just the shape: a header whose version
  // slots hold arbitrary text is malformed, and saying so is the whole point
  // of having no fallback to degrade through.
  if (!VERSION_TOKEN_RE.test(claude.trim()) || !VERSION_TOKEN_RE.test(codex.trim())) return null;
  if (!isCalendarDate(date)) return null;
  return { date, claude, codex };
}

// The header regex already fixes the digit shape; this rejects 2026-13-45.
// Runtime accepted such dates while the CI drift check rejected them, so
// "one grammar" was not yet true across the two readers.
function isCalendarDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * Compat-compatible view of the parsed baseline.
 *
 * Kept as a named export because `scripts/check-host-version-drift.mjs` and
 * compat's snapshot schema both consume this shape. It now requires the dated
 * header like every other reader (ADR-0051 §Decision 4).
 */
export function extractBaselineVersions(text) {
  const parsed = parseBaseline(text);
  return {
    claude: { version: normalizeVersion(parsed?.claude ?? null) },
    codex: { version: normalizeVersion(parsed?.codex ?? null) },
  };
}

async function readRuntimeVersion(pluginRoot) {
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    try {
      const raw = await readFile(resolve(pluginRoot, manifest), 'utf8');
      const version = JSON.parse(raw)?.version;
      if (typeof version === 'string' && version) return version;
    } catch {
      /* try the next manifest; a missing manifest is not a baseline failure */
    }
  }
  return null;
}

/**
 * Resolve the host-parity baseline from the packaged copy.
 *
 * status:
 *   - `resolved`    — file read and header parsed
 *   - `missing`     — no readable file at the packaged path
 *   - `unparseable` — file present but no canonical dated header
 *
 * `missing` and `unparseable` are deliberately distinct. They call for
 * different operator actions (a broken install versus a malformed document),
 * and with no fallback source either one is a hard stop rather than a quiet
 * downgrade.
 */
export async function resolveHostParityBaseline({ pluginRoot = defaultPluginRoot() } = {}) {
  const path = resolve(pluginRoot, BASELINE_RELATIVE_PATH);
  const runtimeVersion = await readRuntimeVersion(pluginRoot);

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return {
      status: 'missing',
      baseline: null,
      provenance: {
        source: 'package',
        path,
        runtime_version: runtimeVersion,
        content_sha256: null,
        reason: err?.code ?? 'unreadable',
      },
    };
  }

  const contentSha256 = createHash('sha256').update(text).digest('hex');
  const parsed = parseBaseline(text);
  const provenance = {
    source: 'package',
    path,
    runtime_version: runtimeVersion,
    content_sha256: contentSha256,
    reason: null,
  };

  if (!parsed) {
    return { status: 'unparseable', baseline: null, provenance };
  }

  return {
    status: 'resolved',
    baseline: parsed,
    versions: {
      claude: { version: normalizeVersion(parsed.claude) },
      codex: { version: normalizeVersion(parsed.codex) },
    },
    provenance,
  };
}
