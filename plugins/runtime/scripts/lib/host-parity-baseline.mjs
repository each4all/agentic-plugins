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

import { readPluginManifestVersions } from './plugin-manifest.mjs';
import { resolveContained } from './path-containment.mjs';

export const BASELINE_RELATIVE_PATH = 'docs/host-parity-baseline.md';

// The canonical grammar. A baseline states WHEN it was observed and WHICH
// versions were observed; a version pair with no date cannot be aged, so it is
// not a baseline. compat previously accepted the dateless form.
const HEADER_RE = /Observed on ([0-9]{4}-[0-9]{2}-[0-9]{2}) with Claude Code\s*`([^`]+)`,\s*Codex CLI\s*`([^`]+)`/m;

// Two- or three-component, matching VERSION_TOKEN_RE below and the CI drift
// script's own normalizer. An earlier three-component-only form made
// `parseBaseline` accept `2.1` while `normalizeVersion` returned null for
// it — the module disagreeing with itself.
// Prerelease and build metadata are SEPARATE optional groups, in that order.
// A single `[-+]` alternative stopped at the first of the two, so
// `0.147.0-rc.1+build.5` tokenized as `0.147.0-rc.1` and two builds of one
// prerelease became one token — a lossy "identity" form (cross-host review).
// Still deliberately permissive about the CORE (two components allowed, no
// leading-zero rule): this reads observed CLI text, not a manifest. The strict
// specification shape lives in `semver.mjs` and is what validates manifests.
const SEMVER_RE = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;
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
 * The COMPARISON form: the same token with prerelease and build metadata
 * dropped.
 *
 * Two forms, one module, and that is the point. Four private normalizers had
 * grown around this file — this one, `compat.mjs`'s `extractSemver`,
 * `doctor.mjs`'s `normalizeHostVersion`, and the CI drift script's own copy —
 * and they disagreed on prerelease suffixes, on build metadata, on four-part
 * versions, and on whether `banana` is a version. Measured across ten inputs:
 * four produced at least two different answers.
 *
 * The disagreement only becomes a BUG where the forms are compared against
 * each other, and they were: `compat` matched a stripped observed version
 * against an unstripped baseline version, so an install running exactly the
 * baselined `0.147.0-rc.1` reported `version_changed`. Naming the two forms
 * and putting them in one module is what removes the second implementation;
 * deleting the test's KNOWN_DIVERGENCE entry alone would have removed only the
 * evidence.
 *
 * Existing severity policy is unchanged, and the one place it is not identical
 * is measured rather than asserted. The CI drift check compares by numeric
 * position only, so `0.147.0-rc.1` and `0.147.0` are already the same release
 * to it, and that is preserved. Across the fourteen inputs the two
 * implementations were compared on, they differ on exactly one class: a
 * FOUR-component string, where the old CI regex returned `1.2.3.4` and this
 * returns `1.2.3`. `semverParts` slices to three components before any
 * comparison, so no verdict changes; only the reported string would, for a
 * release shape neither npm nor SemVer produces.
 */
export function releaseVersion(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) return null;
  return normalized.split(/[-+]/)[0];
}

/**
 * Every version token mentioned in a block of prose, in the same grammar.
 *
 * The release-note scanner had a FIFTH copy of the pattern, and it was the
 * mirror of the drift bug rather than a separate one: it dropped prerelease
 * suffixes while the observed version kept them, and `buildReleaseNoteCoverage`
 * compares the two — so a note that explicitly names `0.147.0-rc.1` did not
 * count as covering an install running `0.147.0-rc.1`, and the operator was
 * told to ingest notes they had already ingested, with no way to satisfy it.
 * Failing closed is the safe direction; a demand that cannot be met is a dead
 * end, not a refusal.
 */
export function scanVersionTokens(text) {
  const pattern = new RegExp(SEMVER_RE.source, 'g');
  return [...new Set([...String(text ?? '').matchAll(pattern)].map((match) => match[0]))];
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

/**
 * The complete status vocabulary, in one place so no consumer has to enumerate
 * it — and so adding a sixth is a change to this list rather than a silent new
 * value falling through five `if` ladders. Measured before it was written:
 * every consumer had exactly the fall-through this exists to remove.
 */
export const BASELINE_STATUSES = Object.freeze([
  'resolved',
  'missing',
  'unreadable',
  'escaped',
  'unparseable',
]);

const FAILURE_SUMMARIES = Object.freeze({
  missing: 'the packaged baseline file is not present',
  unreadable: 'the packaged baseline file is present but could not be read',
  escaped: 'the packaged baseline path resolves OUTSIDE the runtime package',
  unparseable: 'the packaged baseline file carries no canonical dated header',
});

/**
 * The ONE integrity predicate. `null` when the baseline is usable; otherwise
 * the failure, with an operator action.
 *
 * Every consumer asks THIS instead of listing statuses. That is the whole
 * migration: before it, `doctor` enumerated two statuses and turned anything
 * else into `stale` (a freshness verdict for an integrity failure),
 * `dashboard` enumerated the same two and turned anything else into
 * `available` with a null baseline, and `compat` enumerated them a third time
 * so a new failure would have joined the drift comparison as though a version
 * had been read. Three copies of one list is three chances to forget the
 * fourth entry.
 */
export function baselineFailure(resolved) {
  const status = resolved?.status ?? null;
  if (status === 'resolved') return null;
  if (!status || !BASELINE_STATUSES.includes(status)) {
    // Fail CLOSED on a value this module does not know: an unrecognised status
    // is itself an integrity problem, and treating it as usable is the exact
    // direction that harms.
    return {
      status: status ?? 'unknown',
      summary: 'the baseline resolver returned a status this reader does not recognise',
      operator_action: 'Update the runtime plugin — the installed baseline reader and its caller disagree on the failure vocabulary.',
    };
  }
  const path = resolved?.provenance?.path ?? '<runtime package>/docs/host-parity-baseline.md';
  const reason = resolved?.provenance?.reason ?? null;
  const operatorAction = status === 'unparseable'
    ? `Repair ${path} — it is present but carries no canonical "Observed on <date> with Claude Code \`x\`, Codex CLI \`y\`" header.`
    : status === 'escaped'
      ? `Reinstall the runtime plugin — ${path} resolves outside the package (${resolved?.provenance?.canonical_path ?? 'unknown target'}), so a file the package does not own would decide host-parity verdicts.`
      : `Reinstall or repair the runtime plugin — ${path} could not be read (${reason ?? status}).`;
  return { status, summary: FAILURE_SUMMARIES[status], operator_action: operatorAction };
}

/**
 * Resolve the host-parity baseline from the packaged copy.
 *
 * status:
 *   - `resolved`    — file read and header parsed
 *   - `missing`     — nothing at the packaged path (includes a broken symlink)
 *   - `unreadable`  — present, but the path could not be walked or read
 *   - `escaped`     — the path resolves outside the package root
 *   - `unparseable` — read, but no canonical dated header
 *
 * These are deliberately distinct because they call for different operator
 * actions, and with no fallback source each one is a hard stop rather than a
 * quiet downgrade. `unreadable` and `escaped` were split out of `missing`
 * after measurement: a chmod-000 baseline reported "is not present" (an
 * operator would reinstall a file that is already there), and a symlinked
 * `docs/` made an arbitrary outside file the authority while still reporting
 * `source: 'package'`.
 *
 * `pluginRoot` is REQUIRED to be a non-empty string when given. Omitting the
 * key selects the package this module was loaded from; passing `''` or `null`
 * used to be laundered into that same default by the callers, so a caller that
 * meant to inspect a specific install silently inspected its own.
 */
export async function resolveHostParityBaseline({ pluginRoot = defaultPluginRoot() } = {}) {
  if (typeof pluginRoot !== 'string' || !pluginRoot.trim()) {
    throw new TypeError('resolveHostParityBaseline: pluginRoot must be a non-empty string when provided; omit the key to use the packaged default');
  }
  const manifest = await readPluginManifestVersions(pluginRoot);
  const located = await resolveContained(pluginRoot, BASELINE_RELATIVE_PATH);
  const baseProvenance = {
    source: 'package',
    path: located.path,
    // Both spellings travel, because they answer different questions: `path`
    // is what an operator opens or edits, `canonical_path` is what was
    // actually read. When they differ, the difference is itself the evidence —
    // and it is the only place an `escaped` verdict can be substantiated.
    canonical_path: located.canonicalPath ?? null,
    runtime_version: manifest.version,
    manifest: { status: manifest.status, ...manifest.manifests },
    content_sha256: null,
    reason: null,
  };

  if (located.status !== 'ok') {
    return {
      status: located.status,
      baseline: null,
      provenance: { ...baseProvenance, reason: located.code ?? located.status },
    };
  }

  let bytes;
  try {
    // Read the CANONICAL path: the containment check above resolved the
    // symlinks, and re-walking the caller's spelling would traverse them
    // again — guarding one read while performing another.
    bytes = await readFile(located.canonicalPath);
  } catch (err) {
    return {
      status: err?.code === 'ENOENT' ? 'missing' : 'unreadable',
      baseline: null,
      provenance: { ...baseProvenance, reason: err?.code ?? 'unreadable' },
    };
  }

  // Hash the BYTES, and decode the same buffer.
  //
  // `readFile(path, 'utf8')` then `update(text)` hashed a re-encoding, not the
  // file: every invalid byte sequence decodes to U+FFFD, so two different
  // files collide. Reproduced — `FF FE` and `FF FF` produced one hash. Content
  // provenance whose whole job is telling two same-version installs apart must
  // not have a collision class that a corrupt copy falls into.
  //
  // The BOM half of the original diagnosis was DISPROVED and is recorded so it
  // is not re-fixed: a BOM survives the round trip and changes the hash either
  // way.
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8');
  const parsed = parseBaseline(text);
  const provenance = { ...baseProvenance, content_sha256: contentSha256 };

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
