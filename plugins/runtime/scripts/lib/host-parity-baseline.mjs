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
import { canonicalJson, loadSchema, validateAgainstSchema } from './schema-validate.mjs';

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
  'baseline-unavailable',
]);

const ASSURANCE_SUMMARIES = Object.freeze({
  absent: 'the packaged baseline carries no compatibility assurance section',
  ambiguous: 'the packaged baseline carries more than one compatibility assurance block',
  unparseable: 'the compatibility assurance block is present but does not parse',
  'unknown-schema': 'the compatibility assurance block declares a schema version this runtime does not read',
  invalid: 'the compatibility assurance block does not satisfy the packaged structural schema',
  noncanonical: 'the compatibility assurance block is not in canonical form',
  'baseline-unavailable': 'the packaged baseline file itself could not be read, so no assurance record could be reached',
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
      : `Repair the compatibility assurance block in ${path} — it is present but ${ASSURANCE_SUMMARIES[status]}. It must be exactly one sentinel-delimited \`\`\`json fence whose content is the canonical serialization of a ${ASSURANCE_SCHEMA_VERSION} record.`;
  return { status, summary: ASSURANCE_SUMMARIES[status], operator_action: operatorAction };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
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
function extractFencedJson(region) {
  const lines = region.split(/\r?\n/);
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
  return { status, record: null, block_sha256: null, findings: [], ...extra };
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
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('parseAssuranceSection: schema must be the packaged runtime-host-assurance schema object');
  }
  const source = String(text ?? '');
  const begins = countOccurrences(source, ASSURANCE_BEGIN_SENTINEL);
  const ends = countOccurrences(source, ASSURANCE_END_SENTINEL);

  if (begins === 0 && ends === 0) return assuranceResult('absent');
  if (begins > 1 || ends > 1) {
    return assuranceResult('ambiguous', {
      findings: [`$: [error/assurance-ambiguous] found ${begins} begin and ${ends} end sentinels — exactly one block may appear, and choosing between two records is not a decision a reader may make`],
    });
  }
  if (begins !== 1 || ends !== 1) {
    return assuranceResult('unparseable', {
      findings: [`$: [error/assurance-sentinel-unpaired] found ${begins} begin and ${ends} end sentinels — the block must be delimited by both`],
    });
  }

  const beginAt = source.indexOf(ASSURANCE_BEGIN_SENTINEL);
  const endAt = source.indexOf(ASSURANCE_END_SENTINEL);
  if (endAt < beginAt + ASSURANCE_BEGIN_SENTINEL.length) {
    return assuranceResult('unparseable', {
      findings: ['$: [error/assurance-sentinel-order] the end sentinel precedes the begin sentinel'],
    });
  }

  const blockText = extractFencedJson(source.slice(beginAt + ASSURANCE_BEGIN_SENTINEL.length, endAt));
  if (blockText === null) {
    return assuranceResult('unparseable', {
      findings: ['$: [error/assurance-fence] the sentinel-delimited region is not exactly one ```json fenced block'],
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

  // The EXACT pin, before any structural check (ADR-0054 §Decision 3).
  if (parsed.schema !== ASSURANCE_SCHEMA_VERSION) {
    return assuranceResult('unknown-schema', {
      findings: [`$.schema: [error/assurance-schema-unreadable] this runtime reads exactly ${ASSURANCE_SCHEMA_VERSION}; the declared value is withheld because a version that did not match is not clamped by anything this runtime trusts`],
    });
  }

  const validation = validateAgainstSchema(parsed, schema, { readerVersion: ASSURANCE_SCHEMA_VERSION });
  if (!validation.ok) {
    return assuranceResult('invalid', { findings: validation.errors });
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

  return {
    status: 'resolved',
    record: parsed,
    // Over the CANONICAL bytes, so the identity of a record is its content and
    // not its formatting. ADR-0054 §Decision 8's cross-tag monotonicity check
    // compares record contents across releases; a hash that moved when someone
    // re-indented the file would report every reflow as a mutation.
    block_sha256: createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'),
    findings: [],
  };
}

/**
 * Resolve the assurance record from the packaged baseline.
 *
 * Same package, same read, same provenance as `resolveHostParityBaseline` —
 * and the schema is loaded from the SAME `pluginRoot`, because reader, schema
 * and baseline resolving from one installed package directory is what makes the
 * record and the rules that judge it atomic within a release (ADR-0054
 * §Separate PRs do not promise one release).
 *
 * ⚠ THROWS when the package is missing its own packaged schema, rather than
 * returning a status. That is deliberate and is the house behaviour —
 * `loadSchema` throws for every family, and an install that cannot find its own
 * `data/schemas/**` is a corrupt package rather than a document this reader can
 * report on. A caller that turns runtime faults into a check verdict (doctor)
 * must wrap this call; a caller that would rather crash than mis-report is
 * already correct.
 */
export async function resolveAssuranceRecord({ pluginRoot = defaultPluginRoot(), schema } = {}) {
  if (typeof pluginRoot !== 'string' || !pluginRoot.trim()) {
    throw new TypeError('resolveAssuranceRecord: pluginRoot must be a non-empty string when provided; omit the key to use the packaged default');
  }
  const read = await readPackagedBaseline(pluginRoot);
  if (read.status !== 'ok') {
    return {
      ...assuranceResult('baseline-unavailable'),
      provenance: read.provenance,
      baseline_failure: baselineFailure({ status: read.status, provenance: read.provenance }),
    };
  }
  const resolvedSchema = schema ?? await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot });
  return {
    ...parseAssuranceSection(read.text, { schema: resolvedSchema }),
    provenance: read.provenance,
    baseline_failure: null,
  };
}
