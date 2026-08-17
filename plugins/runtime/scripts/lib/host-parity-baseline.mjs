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
import {
  SCHEMA_MAX_BYTES,
  canonicalJson,
  loadSchema,
  parseSchemaVersion,
  validateAgainstSchema,
} from './schema-validate.mjs';

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
 * returns `1.2.3`.
 *
 * ⚠ CORRECTION (ADR-0054, measured). This note used to end "so no verdict
 * changes; only the reported string would". That was true of the drift
 * severity it was written about and FALSE of the exactness verdict the
 * assurance plane needs: truncating `1.2.3.4` to `1.2.3` makes it compare
 * exactly equal to a genuine `1.2.3`. The identity form above is unchanged,
 * because every existing caller parses it and ADR-0053 §Decision 1 forbids
 * narrowing it; the refusal lives in `releaseCoreParts`, which is what every
 * COMPARISON now goes through. Kept rather than rewritten so the class is not
 * re-derived as harmless a third time.
 */
export function releaseVersion(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) return null;
  return normalized.split(/[-+]/)[0];
}

// ---------------------------------------------------------------------------
// The packaged comparator — ADR-0053 §Decision 10, shaped by ADR-0054 §Decision 7
// ---------------------------------------------------------------------------
//
// §Decision 10 requires the comparator to be PACKAGED, and measured why: this
// module exported `releaseVersion` but no comparison function, while
// `compareSemver` lived in `scripts/check-host-version-drift.mjs` — a repo-only
// CI script an installed runtime cannot import. So the two halves of one
// question lived on opposite sides of the package boundary.
//
// `lib/semver.mjs` is deliberately NOT reused, and the reason is not the one
// first written down. Its `semverCompare` never calls `isSemVer` and pads
// missing components, so it does read `2.1`. What disqualifies it is that it
// returns a DIFFERENCE rather than a sign — a component past
// `Number.MAX_SAFE_INTEGER` yields a magnitude where float precision collapses
// distinct versions — that it orders prerelease by presence alone, and that
// `Number.parseInt(x, 10) || 0` maps unparseable text to `0`. It answers a
// different question, about manifests, with a strict specification grammar.
// This one reads observed host CLI text.
//
// ⚠ THE STATES ARE EVIDENCE, NEVER SAFETY (ADR-0053 §Decision 9). Nothing here
// may be promoted to coverage. Semver position, keyword silence and elapsed
// time were each measured incapable of predicting a real contract change: 17 of
// 18 Claude Code steps are patch-position, and the single lap that produced
// real adoption work was patch-position too. This code RECORDS direction. Only
// a human grant, matched by the assurance plane, produces coverage.

/**
 * The three core components as normalized digit STRINGS, or `null`.
 *
 * Strings rather than numbers, because `Number.parseInt` is where the existing
 * CI comparator loses: two distinct twenty-digit majors parse to one float and
 * compare equal. Leading zeros are stripped so `01` and `1` are one value.
 *
 * Returns `null` for a token this grammar cannot represent FAITHFULLY, which
 * includes one case `normalizeVersion` accepts: a four-or-more-component
 * version. `SEMVER_RE` matches the first three components of `1.2.3.4` and
 * silently drops the rest, so `normalizeVersion` reports it as `1.2.3` and it
 * would compare EXACTLY equal to a genuine `1.2.3`. `releaseVersion`'s note
 * used to say this class changes no verdict; for an exactness verdict it does,
 * and this is the reader where that matters. Refusing it tightens rather than
 * relaxes exactness, so it is consistent with ADR-0053 §Decision 1.
 *
 * `normalizeVersion` itself is UNCHANGED — it is the identity form every
 * existing caller already parses, and narrowing it would break the §Decision 1
 * invariant. The two answer different questions and the difference is confined
 * to this class.
 */
export function releaseCoreParts(value) {
  const read = readVersionToken(value);
  if (!read.token || read.truncated) return null;
  const core = read.token.split(/[-+]/)[0].split('.');
  while (core.length < 3) core.push('0');
  if (core.length > 3) return null;
  // Strip leading zeros without emptying the string.
  return core.map((part) => part.replace(/^0+(?=\d)/, ''));
}

/**
 * Order two versions by their release core: `-1 | 0 | 1`, or `null` when either
 * side is not a version this grammar can represent.
 *
 * A SIGN, not a difference. Prerelease and build metadata are outside the core
 * by construction, so `0.147.0-rc.1` and `0.147.0` order equal — which is why
 * `same-precedence-nonexact` has to exist as a state rather than being folded
 * into `exact`.
 */
export function compareReleaseCore(left, right) {
  const a = releaseCoreParts(left);
  const b = releaseCoreParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] === b[i]) continue;
    // Digit strings with leading zeros already stripped: longer is larger, and
    // equal length compares lexicographically. Exact at any magnitude, with no
    // float in the path.
    if (a[i].length !== b[i].length) return a[i].length < b[i].length ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The complete single-host relation vocabulary (ADR-0053 §Decision 10).
 *
 * `ahead` and `behind` are deliberately not one word: "the host moved past the
 * last review" and "this machine is behind the reviewed baseline" call for
 * different operator actions. `same-precedence-nonexact` exists because
 * exactness and precedence genuinely disagree — `normalizeVersion` preserves
 * prerelease and build metadata while the comparison form drops them.
 */
export const VERSION_RELATION_STATES = Object.freeze([
  'exact',
  'ahead',
  'behind',
  'same-precedence-nonexact',
  'unparseable',
]);

/**
 * Relate an OBSERVED version to a REVIEWED one.
 *
 * `ahead` means the observed machine is ahead of the reviewed core
 * (ADR-0054 §Decision 7). Exactness is token identity in the `normalizeVersion`
 * form — never precedence — so a prerelease is never silently equal to its
 * release.
 */
export function classifyVersionRelation({ observed, reviewed } = {}) {
  const o = readVersionToken(observed);
  const r = readVersionToken(reviewed);
  if (!o.token || !r.token || o.truncated || r.truncated) {
    return { state: 'unparseable', exact: false, core_order: null };
  }
  const order = compareReleaseCore(o.token, r.token);
  if (order === null) return { state: 'unparseable', exact: false, core_order: null };
  if (o.token === r.token) return { state: 'exact', exact: true, core_order: 0 };
  if (order === 0) return { state: 'same-precedence-nonexact', exact: false, core_order: 0 };
  return { state: order > 0 ? 'ahead' : 'behind', exact: false, core_order: order };
}

/** The pair vocabulary — the single-host states plus the one only a pair has. */
export const HOST_PAIR_RELATION_STATES = Object.freeze([
  ...VERSION_RELATION_STATES,
  'mixed-direction',
]);

/**
 * Relate an observed `{claude, codex}` pair to a reviewed one.
 *
 * `mixed-direction` is its own state because one host ahead while the other is
 * behind is not "drifted" in any single direction, and an operator action that
 * assumed one direction would be wrong for the other host. Unknown outranks
 * everything: if either host is unreadable the pair is `unparseable`, because a
 * pair verdict computed from one known half is a guess.
 */
export function classifyHostPairRelation({ observed, reviewed } = {}) {
  const hosts = {};
  for (const host of ['claude', 'codex']) {
    hosts[host] = classifyVersionRelation({ observed: observed?.[host], reviewed: reviewed?.[host] });
  }
  const states = Object.values(hosts).map((h) => h.state);
  let state;
  if (states.includes('unparseable')) state = 'unparseable';
  else if (states.includes('ahead') && states.includes('behind')) state = 'mixed-direction';
  else if (states.includes('ahead')) state = 'ahead';
  else if (states.includes('behind')) state = 'behind';
  else if (states.includes('same-precedence-nonexact')) state = 'same-precedence-nonexact';
  else state = 'exact';
  return { state, hosts };
}

/**
 * The version token in a string, plus whether extracting it DROPPED anything.
 *
 * `truncated` is true when the match is immediately followed by another dotted
 * numeric component — the `1.2.3.4` class. Deliberately narrow: real baselines
 * carry labelled text (`2.1.197 (Claude Code)`, `codex-cli 0.142.4`,
 * `rust-v0.137.0`), and measurement confirms none of those is flagged.
 *
 * STATED RESIDUAL, not an oversight (cross-host review). Three malformed shapes
 * still extract as `1.2.3` and can report exact: `1.2.3-`, `1.2.3+` (a
 * prerelease or build marker with nothing after it, which the optional groups
 * decline to match) and `1.2.3..4` (an empty component, so the next character
 * after the match is a dot rather than a digit). None is a valid version in any
 * scheme, none is a form either host prints, and widening the detector to catch
 * them costs the property the CONTROL cases pin — that ordinary prose after a
 * version (`2.1.233. See the note below.`) is not mistaken for a dropped
 * component. Refusing them is a grammar-policy change, and it should be made
 * deliberately rather than as a side effect of this one.
 */
function readVersionToken(value) {
  const text = String(value ?? '').trim();
  const match = text.match(SEMVER_RE);
  if (!match) return { token: null, truncated: false };
  return { token: match[0], truncated: /^\.\d/.test(text.slice(match.index + match[0].length)) };
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
  const read = await readPackagedBaseline(pluginRoot);
  if (read.status !== 'ok') {
    return { status: read.status, baseline: null, provenance: read.provenance };
  }
  const parsed = parseBaseline(read.text);
  if (!parsed) {
    return { status: 'unparseable', baseline: null, provenance: read.provenance };
  }
  return {
    status: 'resolved',
    baseline: parsed,
    versions: {
      claude: { version: normalizeVersion(parsed.claude) },
      codex: { version: normalizeVersion(parsed.codex) },
    },
    provenance: read.provenance,
  };
}

/**
 * Read the packaged baseline ONCE, for every grammar in this module.
 *
 * `status` is `ok` plus the decoded text, or one of the integrity failures
 * `resolveHostParityBaseline` documents — verbatim, because the dated header
 * and the assurance section are two grammars over ONE file and a second read
 * path is exactly the four-readers-disagreeing shape ADR-0051 removed. The
 * provenance a caller receives is therefore identical whichever grammar it
 * came for, including the content hash that tells two same-version installs
 * apart.
 */
async function readPackagedBaseline(pluginRoot) {
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
      text: null,
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
      text: null,
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
  return {
    status: 'ok',
    text: bytes.toString('utf8'),
    // The RAW bytes ride along beside the decoded text. `toString('utf8')` is
    // lossy — every invalid sequence becomes U+FFFD — and the assurance reader
    // needs to know that happened. The header reader deliberately does not look
    // at this, because tightening it would change what an existing caller
    // parses (ADR-0053 §Decision 1).
    bytes,
    provenance: { ...baseProvenance, content_sha256: contentSha256 },
  };
}

// ---------------------------------------------------------------------------
// Compatibility assurance — ADR-0053 §Decision 2, encoded by ADR-0054 §Decision 1
// ---------------------------------------------------------------------------
//
// A SECOND grammar over the SAME file, added here rather than anywhere else
// because this module owns grammars (ADR-0051 §Decision 4). What §Decision 4
// forbids is four callers each inventing a grammar for one fact; this adds one
// grammar for a NEW fact in the one place that owns them. The dated header is
// untouched: `HEADER_RE`, `parseBaseline` and its `{date, claude, codex}` shape
// are exactly what they were, and every existing caller parses exactly what it
// parsed before.
//
// The two grammars answer questions that must not be traded against each other
// (ADR-0053 §Decision 3). A baseline whose header parses and whose assurance
// section does not is a FRESHNESS success and an ASSURANCE failure, and vice
// versa — so the assurance reader carries its own status vocabulary rather than
// borrowing `BASELINE_STATUSES`, whose values name integrity facts about the
// file. Integrity outranks both: when the file itself is missing, unreadable or
// escaped, the assurance answer is `baseline-unavailable` and it delegates the
// operator action to `baselineFailure` instead of inventing a second name for
// one fact.
//
// THE EXTRACTED BLOCK IS WHAT IS VALIDATED, never the document: the shipped
// baseline is ~90 KB against `SCHEMA_MAX_BYTES`'s 64 KiB, so validating the
// file would fail on size alone and say nothing about the record.

export const ASSURANCE_SCHEMA_FAMILY = 'runtime-host-assurance';

/**
 * The one version this reader reads, spelled out.
 *
 * ADR-0054 §Decision 3 — enforced HERE and not only by the schema's `pattern`,
 * because the two produce different answers to "why". `compareSchemaVersion`
 * accepts a newer minor and forgives its unknown scalars; the pattern would
 * then reject the document as a generic constraint violation, which reads as a
 * malformed record rather than as a runtime too old to be trusted with it. The
 * distinction is the operator action.
 *
 * §Decision 3 describes exact pinning as diverging from "the bootstrap and
 * session families", and that is half right — measured across the seven
 * packaged schemas, FOUR already pin exactly (`runtime-session-capture`,
 * `-entry`, `-note`, `runtime-entry-brief`) and three carry the family-wide
 * `1\.[0-9]+` form (`agentic-machine-profile`, `runtime-bootstrap-run`,
 * `runtime-plugin-set`). So the shape is the majority house style, not an
 * exception, and repeating the ADR's sentence in code would teach a future
 * author a history that is not there. What IS distinctive is the reason: those
 * four have never had a second minor, so their pin has never had to refuse
 * anything, while this one exists to refuse a `1.1` that will eventually be
 * written — and refusing it is the point, because a narrowing key an older
 * reader ignored turns a restricted grant into a broad one.
 */
export const ASSURANCE_SCHEMA_VERSION = 'runtime-host-assurance-1.0';

// Sentinels, not a heading. A heading is prose that a refresh may reword; these
// are a contract between the human author and the reader, and EXACTLY ONE pair
// may appear — two records in one file is an ambiguity, and §Decision 3 resolves
// ambiguity negative rather than picking the first.
export const ASSURANCE_BEGIN_SENTINEL = '<!-- BEGIN COMPATIBILITY ASSURANCE -->';
export const ASSURANCE_END_SENTINEL = '<!-- END COMPATIBILITY ASSURANCE -->';

/**
 * The complete assurance-read vocabulary, in one place for the same reason
 * `BASELINE_STATUSES` is: so a consumer switches on THIS list instead of
 * enumerating a private copy that forgets the next entry.
 *
 * None of the non-`resolved` values is a degraded positive. Every one of them
 * means the record did not produce coverage (ADR-0053 §Decision 3: negative and
 * unknown win over positive at every layer), and they are distinct only because
 * they call for different operator actions.
 */
export const ASSURANCE_STATUSES = Object.freeze([
  'resolved',
  'absent',
  'ambiguous',
  'unparseable',
  'unknown-schema',
  'invalid',
  'noncanonical',
  'undecodable',
  'baseline-unavailable',
]);

const ASSURANCE_SUMMARIES = Object.freeze({
  absent: 'the packaged baseline carries no compatibility assurance section',
  ambiguous: 'the packaged baseline carries more than one compatibility assurance block',
  unparseable: 'the compatibility assurance block is present but does not parse',
  'unknown-schema': 'the compatibility assurance block declares a schema version this runtime does not read',
  invalid: 'the compatibility assurance block does not satisfy the packaged structural schema',
  noncanonical: 'the compatibility assurance block is not in canonical form',
  undecodable: 'the packaged baseline file contains bytes that are not valid UTF-8, so its record has no well-defined content',
  'baseline-unavailable': 'the packaged baseline file itself is not usable, so no assurance record could be reached from it',
});

/**
 * The ONE assurance predicate — `null` when the record is usable, otherwise the
 * failure with an operator action. Mirrors `baselineFailure`, including its
 * fail-CLOSED treatment of a status this reader does not recognise.
 *
 * `absent` is a failure here even though it is not a defect. An old baseline
 * read by a new runtime yields unassured, and unassured blocks (ADR-0053
 * §Decision 11) — reporting it as a usable record with no grants would be the
 * fail-open direction.
 */
export function assuranceFailure(resolved) {
  const status = resolved?.status ?? null;
  if (status === 'resolved') return null;
  if (!status || !ASSURANCE_STATUSES.includes(status)) {
    return {
      status: status ?? 'unknown',
      summary: 'the assurance reader returned a status this consumer does not recognise',
      operator_action: 'Update the runtime plugin — the installed assurance reader and its caller disagree on the failure vocabulary.',
    };
  }
  if (status === 'baseline-unavailable') {
    const underlying = resolved?.baseline_failure ?? null;
    return {
      status,
      summary: ASSURANCE_SUMMARIES[status],
      // Integrity outranks assurance, so the action is the INTEGRITY action —
      // repairing the record is meaningless while the file it lives in cannot
      // be read.
      operator_action: underlying?.operator_action
        ?? 'Reinstall or repair the runtime plugin — the packaged host-parity baseline could not be read.',
    };
  }
  const path = resolved?.provenance?.path ?? '<runtime package>/docs/host-parity-baseline.md';
  const operatorAction = status === 'absent'
    // Two causes, one reading: a baseline that predates the record and one whose
    // sentinels were altered are indistinguishable to any reader, so the action
    // names both rather than asserting the more flattering one.
    ? `Update the runtime plugin — ${path} carries no compatibility assurance record (ADR-0053 §Decision 2): it either predates the record or its sentinels were altered, and this runtime cannot establish host coverage from it either way. Assurance is granted by review; no upgrade grants it by itself.`
    : status === 'unknown-schema'
      ? `Update the runtime plugin — the assurance record in ${path} declares a schema version this runtime does not read (it reads exactly ${ASSURANCE_SCHEMA_VERSION}). Reading it anyway could treat a narrowing condition as absent, which is how absence of evidence becomes coverage.`
      : status === 'undecodable'
        ? `Repair the encoding of ${path} — it contains bytes that are not valid UTF-8. Decoding replaces each of them with U+FFFD, so two different files would read as one record; the content of an assurance record has to be well defined before it can be trusted.`
        : `Repair the compatibility assurance block in ${path} — it is present but ${ASSURANCE_SUMMARIES[status]}. It must be exactly one sentinel-delimited \`\`\`json fence, at the top level of the document rather than quoted inside another fence, whose content is the canonical serialization of a ${ASSURANCE_SCHEMA_VERSION} record.`;
  return { status, summary: ASSURANCE_SUMMARIES[status], operator_action: operatorAction };
}

/**
 * Find the sentinel lines that are actually MARKUP, not text that looks like it.
 *
 * A raw substring scan was measured wrong in both directions, and the pair is a
 * matched set rather than two bugs:
 *
 *   - FALSE POSITIVE. A record quoted as a worked example inside an outer
 *     `~~~~markdown` fence resolved as the live record. This document explains
 *     its own grammar, so an author demonstrating it is the likeliest way a
 *     grant nobody granted becomes authoritative — the exact failure this whole
 *     plane exists to prevent.
 *   - FALSE NEGATIVE, its mirror. A grant whose `note` mentioned the sentinel,
 *     or prose citing it in backticks, made the real record `ambiguous` — a
 *     legitimate document that no edit short of censoring the word could fix.
 *
 * So a sentinel counts only when it is a whole line (trailing whitespace aside)
 * at the top level of the document — never indented into a code block, never
 * inside any fence, never a fragment of a larger line. Fence tracking is the
 * CommonMark rule reduced to what this file can contain: three or more
 * backticks or tildes open a block, and a run of at least that many of the SAME
 * character closes it.
 */
function scanSentinelLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const begins = [];
  const ends = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.length) fence = null;
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      fence = { char: opener[1][0], length: opener[1].length };
      continue;
    }
    // Column 0 exactly: four leading spaces would make it an indented code
    // block, which is quoted content for the same reason a fence is.
    const trimmed = line.trimEnd();
    if (trimmed === ASSURANCE_BEGIN_SENTINEL) begins.push(i);
    else if (trimmed === ASSURANCE_END_SENTINEL) ends.push(i);
  }
  return { lines, begins, ends };
}

/**
 * The region between the sentinels must be exactly one fenced ```json block.
 *
 * Line-structural, not regex-greedy: a physical line equal to ``` cannot occur
 * INSIDE a JSON string (JSON forbids a raw newline in one), so a fence line is
 * always structural and "more than two of them" is unambiguously two blocks
 * rather than a backtick in the data. Returns the body text with the trailing
 * newline `canonicalJson` also emits, or `null` when the region is not that
 * shape.
 *
 * CRLF is normalized rather than refused, and that is a correctness fix rather
 * than a convenience. `HEADER_RE` already tolerates it (`\s*` matches `\r`), so
 * a strict reader here would make ONE module disagree with itself about ONE
 * file — measured: a CRLF copy of the shipped baseline parses its header and
 * failed to parse its record. There is no `.gitattributes` forcing LF, so that
 * copy is reachable, and the failure would have been fail-closed but
 * unrepairable: every byte of the record is right and no edit fixes it. A
 * demand that cannot be met is a dead end, not a refusal. Normalizing is
 * lossless for what this grammar decides — a line ending cannot change which
 * JSON keys exist or what order they are in — and it makes the record's content
 * hash identical across checkout styles.
 *
 * The FENCE lines are compared with trailing whitespace trimmed, for the same
 * dead-end reason and with the same safety argument: they carry no record data,
 * so a trailing space in an info string cannot change what was parsed.
 */
function extractFencedJson(regionLines) {
  const lines = [...regionLines];
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return null;
  if (lines[0].trimEnd() !== '```json') return null;
  if (lines[lines.length - 1].trimEnd() !== '```') return null;
  const body = lines.slice(1, -1);
  // A second fence inside the region. Canonical JSON never produces a line
  // starting with a backtick, so this is not a legitimate record being refused.
  if (body.some((line) => line.startsWith('```'))) return null;
  return `${body.join('\n')}\n`;
}

function assuranceResult(status, extra = {}) {
  const result = { status, record: null, block_sha256: null, findings: [], finding_count: 0, findings_omitted: false, ...extra };
  // Default the count to the array when a caller supplied findings but no
  // count, so `finding_count` is never a silently smaller number than what is
  // already visible.
  if (extra.finding_count === undefined) result.finding_count = result.findings.length;
  return result;
}

/**
 * Parse the compatibility assurance record out of a baseline's text.
 *
 * SYNC and pure, like `parseBaseline` — the schema is injected rather than
 * loaded, so this stays a grammar and the packaged-asset resolution lives in
 * exactly one place (`resolveAssuranceRecord` below). A bad SCHEMA throws,
 * because that is a bug here; a bad DOCUMENT never throws, because that is
 * data.
 *
 * Returns `{ status, record, block_sha256, findings }`. `findings` are the
 * validator's content-free diagnostics and obey its disclosure invariant: no
 * observed scalar, no document-supplied key, and — in the `unknown-schema`
 * branch — not the declared version string either, which is unclamped free
 * content the moment it fails to be the one value this reader accepts.
 */
export function parseAssuranceSection(text, { schema } = {}) {
  // Identity, not merely shape. An object-shape guard let `{ schema: {} }`
  // through, and an empty schema constrains nothing — a record missing its
  // required `grants` validated and resolved. The seam stays (this is the pure
  // grammar, and tests inject), but injecting the WRONG schema is now a loud
  // bug rather than a silently weakened gate.
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || schema.$id !== ASSURANCE_SCHEMA_VERSION) {
    throw new TypeError(`parseAssuranceSection: schema must be the packaged ${ASSURANCE_SCHEMA_VERSION} schema object`);
  }
  const { lines, begins, ends } = scanSentinelLines(text);

  if (begins.length === 0 && ends.length === 0) return assuranceResult('absent');
  if (begins.length > 1 || ends.length > 1) {
    return assuranceResult('ambiguous', {
      findings: [`$: [error/assurance-ambiguous] found ${begins.length} begin and ${ends.length} end sentinel lines — exactly one block may appear, and choosing between two records is not a decision a reader may make`],
    });
  }
  if (begins.length !== 1 || ends.length !== 1) {
    return assuranceResult('unparseable', {
      findings: [`$: [error/assurance-sentinel-unpaired] found ${begins.length} begin and ${ends.length} end sentinel lines — the block must be delimited by both`],
    });
  }
  if (ends[0] <= begins[0]) {
    return assuranceResult('unparseable', {
      findings: ['$: [error/assurance-sentinel-order] the end sentinel precedes the begin sentinel'],
    });
  }

  const blockText = extractFencedJson(lines.slice(begins[0] + 1, ends[0]));
  if (blockText === null) {
    return assuranceResult('unparseable', {
      findings: ['$: [error/assurance-fence] the sentinel-delimited region is not exactly one ```json fenced block'],
    });
  }
  // Bound the INPUT, not only the parsed object. `validateAgainstSchema` caps
  // the re-serialized document, which a block padded with whitespace shrinks
  // below — so the advertised cap was not a bound on what this reader accepts.
  const blockBytes = Buffer.byteLength(blockText, 'utf8');
  if (blockBytes > SCHEMA_MAX_BYTES) {
    return assuranceResult('unparseable', {
      findings: [`$: [error/assurance-too-large] the fenced block is ${blockBytes} bytes, over the ${SCHEMA_MAX_BYTES}-byte cap — refused, not truncated`],
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(blockText);
  } catch {
    // The exception text is NOT interpolated: a JSON.parse message quotes the
    // offending input, and an unparseable block is unclamped free content.
    return assuranceResult('unparseable', {
      findings: ['$: [error/assurance-json] the fenced block is not valid JSON; the parser message is withheld because it quotes the input'],
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return assuranceResult('unparseable', {
      findings: ['$: [error/assurance-json] the fenced block does not carry a JSON object at its root'],
    });
  }

  // The EXACT pin, before any structural check (ADR-0054 §Decision 3) — but
  // only for the case it actually names.
  //
  // Routing EVERY non-matching value here was measured wrong: a block that
  // simply omits `schema` was told to "update the runtime plugin", when the
  // record is what needs repairing and no upgrade would ever fix it. The two
  // remedies are opposite, so the classification has to be too. A declaration
  // this runtime cannot READ (right family, wrong version) is an upgrade; a
  // declaration that is missing, mistyped, malformed, or from another family is
  // a defective record and falls through to structural validation, which says
  // so in the vocabulary a repair needs.
  const declared = typeof parsed.schema === 'string' ? parseSchemaVersion(parsed.schema) : null;
  if (declared !== null && declared.family === ASSURANCE_SCHEMA_FAMILY && parsed.schema !== ASSURANCE_SCHEMA_VERSION) {
    return assuranceResult('unknown-schema', {
      findings: [`$.schema: [error/assurance-schema-unreadable] this runtime reads exactly ${ASSURANCE_SCHEMA_VERSION}; the declared value is withheld because a version that did not match is not clamped by anything this runtime trusts`],
      finding_count: 1,
    });
  }

  const validation = validateAgainstSchema(parsed, schema, { readerVersion: ASSURANCE_SCHEMA_VERSION });
  if (!validation.ok) {
    // The COUNTS travel with the (display-capped) findings. Keeping only the
    // array reported "16 problems" for a record with twenty, which is the flood
    // hidden rather than bounded — the same reason `makeValidator` carries them.
    return assuranceResult('invalid', {
      findings: validation.errors,
      finding_count: validation.error_count,
      findings_omitted: validation.omitted,
    });
  }

  // CANONICAL FORM, and it is load-bearing rather than tidiness (ADR-0054
  // §Decision 1). `JSON.parse` resolves a duplicate key last-wins and says
  // nothing, so `{"state":"revoked","state":"granted"}` would validate as a
  // grant while a human reviewer reads the file and sees a revocation. Requiring
  // the block to BE the canonical serialization of what was parsed makes that
  // visible: the re-serialization drops the shadowed member and no longer
  // matches the bytes on disk.
  const canonical = canonicalJson(parsed, schema);
  if (canonical !== blockText) {
    return assuranceResult('noncanonical', {
      findings: ['$: [error/assurance-noncanonical] the block is not byte-identical to the canonical serialization of what it parsed to — a duplicate key, a non-canonical key order, or stray whitespace'],
    });
  }

  return assuranceResult('resolved', {
    record: parsed,
    // Over the CANONICAL bytes, so the identity of a record is its content and
    // not its formatting. ADR-0054 §Decision 8's cross-tag monotonicity check
    // compares record contents across releases; a hash that moved when someone
    // re-indented the file would report every reflow as a mutation.
    block_sha256: createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'),
  });
}

/**
 * Resolve the assurance record from the packaged baseline — the answer to
 * "does this INSTALL have assurance", which is not the same question
 * `parseAssuranceSection` answers.
 *
 * The difference is ADR-0053 §Decision 3, and it is the whole reason this
 * function exists rather than being a convenience wrapper. §Decision 3 says a
 * parseable assurance section next to a broken or escaped baseline is
 * **blocked, never covered** — integrity outranks assurance, and the two are
 * not tradeable. So every integrity failure of the file, INCLUDING a dated
 * header that does not parse, is `baseline-unavailable` here even when the
 * record itself reads perfectly. The pure grammar above still reports what the
 * text says, because that is a different question and a consumer sometimes
 * needs it; this is the one a gate may use.
 *
 * The schema is loaded from the SAME `pluginRoot` and CANNOT be overridden.
 * An override existed and was removed: it defeated this function's own stated
 * guarantee, since `{ schema: {} }` constrains nothing and made a record
 * missing its required members resolve. Reader, schema and baseline resolving
 * from one installed package directory is what makes the record and the rules
 * that judge it atomic within a release (ADR-0054 §Separate PRs do not promise
 * one release).
 *
 * ⚠ TWO READS, not one. This and `resolveHostParityBaseline` share a read PATH,
 * not a read. A consumer that needs both facts about ONE revision of the file
 * must compare `provenance.content_sha256` across the two results and treat a
 * difference as a failure — otherwise a file replaced between the calls yields
 * a header from revision A and a record from revision B, both reporting
 * `resolved`.
 *
 * ⚠ THROWS when the package is missing its own packaged schema, rather than
 * returning a status. That is deliberate and is the house behaviour —
 * `loadSchema` throws for every family, and an install that cannot find its own
 * `data/schemas/**` is a corrupt package rather than a document this reader can
 * report on. A caller that turns runtime faults into a check verdict (doctor)
 * must wrap this call; a caller that would rather crash than mis-report is
 * already correct.
 */
export async function resolveAssuranceRecord({ pluginRoot = defaultPluginRoot() } = {}) {
  if (typeof pluginRoot !== 'string' || !pluginRoot.trim()) {
    throw new TypeError('resolveAssuranceRecord: pluginRoot must be a non-empty string when provided; omit the key to use the packaged default');
  }
  const read = await readPackagedBaseline(pluginRoot);
  const blocked = (status, failure) => ({
    ...assuranceResult(status),
    provenance: read.provenance,
    baseline_failure: failure,
  });

  if (read.status !== 'ok') {
    return blocked('baseline-unavailable', baselineFailure({ status: read.status, provenance: read.provenance }));
  }
  // The header, checked HERE and not left to a consumer to remember. §Decision
  // 3 names `unparseable` in the integrity layer explicitly, and a reader that
  // returned a usable record beside a broken baseline would be handing every
  // future consumer the same chance to forget it.
  if (parseBaseline(read.text) === null) {
    return blocked('baseline-unavailable', baselineFailure({ status: 'unparseable', provenance: read.provenance }));
  }
  // The decode is LOSSY, and this is the one place that can still tell.
  // `bytes.toString('utf8')` maps every invalid sequence to U+FFFD, so two
  // different files collapse to one text — measured: raw `FF` and raw `FE`
  // produced the same record AND the same block hash. This module already
  // learned that lesson one level up, where the provenance hash was moved onto
  // the bytes for exactly this reason; a content hash whose job is telling two
  // records apart must not inherit the collision class its file-level sibling
  // was fixed to avoid.
  if (!Buffer.from(read.text, 'utf8').equals(read.bytes)) {
    return blocked('undecodable', null);
  }
  const schema = await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot });
  return {
    ...parseAssuranceSection(read.text, { schema }),
    provenance: read.provenance,
    baseline_failure: null,
  };
}
