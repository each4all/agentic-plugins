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

// Residue that means the extracted token DROPPED something (see `readVersionToken`).
// `.4` / `..4` — a further dotted component, empty or not. `-` / `+` — a prerelease or
// build marker the optional groups declined because nothing valid followed it.
// Deliberately NOT `.` followed by anything else: `2.1.233. See the note below.` is prose.
const TOKEN_RESIDUE_RE = /^(?:\.[.\d]|[-+])/;

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
 *
 * EXPORTED because more than one caller needs exactly this pair — the token, and
 * whether reading it dropped anything — and ADR-0051 §Decision 4 keeps one
 * grammar in one module. The alternative was a private `SEMVER_RE` copy plus a
 * private truncation rule at each caller, which is the four-private-normalizers
 * failure `releaseVersion`'s note records. Its original consumer was
 * `lib/assurance-contract.mjs`'s cohort matcher, removed by ADR-0056; the export
 * stays because the truncation signal is exactness evidence, which ADR-0056
 * §Consequences keeps.
 */
export function readVersionToken(value) {
  const text = String(value ?? '').trim();
  const match = text.match(SEMVER_RE);
  if (!match) return { token: null, truncated: false };
  return { token: match[0], truncated: TOKEN_RESIDUE_RE.test(text.slice(match.index + match[0].length)) };
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
 * The document with every QUOTED region blanked out, line-for-line.
 *
 * ADR-0053 §Decision 1 states that the dated-header grammar is untouched and
 * "every existing caller keeps parsing exactly what it parses today". `HEADER_RE`
 * has no anchor, so that holds for the regex and not for the DOCUMENT: a header
 * shown as a worked example inside a fence would otherwise be read as the
 * header. Blanking the quoted regions rather than amending `HEADER_RE` is what
 * keeps §Decision 1 — the grammar does not change, only the text it is applied
 * to. Line count is preserved so any future offset-based caller sees the same
 * geometry.
 *
 * ⚠ THIS FUNCTION USED TO BLANK THE ASSURANCE REGION TOO, and that half went
 * with the region (ADR-0056 §Decision 2). What it guarded — ST5 reproduced a
 * document with no dated header whose schema-VALID `review_provenance.reference`
 * carried header-shaped text, yielding `{date: '2099-01-01', claude: '9.9.9',
 * codex: '9.9.9'}` — is unreachable through a packaged baseline that no longer
 * carries the section. Measured on the shipped document after the section was
 * cut: one header match with the mask and one without, the same triple. The
 * residual (a `pluginRoot` pointed at an OLDER install whose baseline still
 * carries the block) is recorded in `docs/follow-ups.md` rather than left
 * silent, and `parseBaseline`'s exactly-one rule still refuses that document
 * whenever it also carries its own real header.
 *
 * Fences and literal HTML blocks only: an indented code block needs a preceding
 * blank line to be one, and mis-reading an indented prose line as quoted would
 * silently hide a real header, which is the wrong direction for a reader whose
 * absence is an integrity failure.
 */
function withoutQuotedRegions(text) {
  const masked = String(text ?? '').split(/\r?\n/);
  let fence = null;
  let htmlBlock = null;
  for (let i = 0; i < masked.length; i += 1) {
    const line = masked[i];
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      masked[i] = '';
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.length) fence = null;
      continue;
    }
    if (htmlBlock) {
      const closes = new RegExp(`</${htmlBlock}\\s*>`, 'i').test(line);
      masked[i] = '';
      if (closes) htmlBlock = null;
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      fence = { char: opener[1][0], length: opener[1].length };
      masked[i] = '';
      continue;
    }
    const htmlOpener = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(line);
    if (htmlOpener) {
      htmlBlock = htmlOpener[1].toLowerCase();
      if (new RegExp(`</${htmlBlock}\\s*>`, 'i').test(line)) htmlBlock = null;
      masked[i] = '';
    }
  }
  return masked.join('\n');
}

/**
 * Parse the canonical dated header.
 *
 * Returns `null` when the text does not carry it. Callers distinguish "no
 * file" from "file that does not parse" — collapsing those two was one of the
 * inconsistencies ADR-0051 §Decision 4 removes.
 */
export function parseBaseline(text) {
  // EXACTLY ONE, and this replaced "the first one". `HEADER_RE` is unanchored,
  // so a stale header left above the canonical one silently WON — measured in
  // ST5's audit: a file carrying `2020-01-01 / 1.0.0 / 0.1.0` above the real
  // line parsed as the stale pair, and both the exactness verdict and the
  // direction evidence then named a host pair nobody observed. Two headers is
  // not a document this grammar can read, and ADR-0051 §Decision 4's whole
  // point is that there is one answer, so ambiguity is refused rather than
  // resolved by position.
  const readable = withoutQuotedRegions(text);
  const matches = [...readable.matchAll(new RegExp(HEADER_RE.source, 'gm'))];
  if (matches.length !== 1) return null;
  const match = matches[0];
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
