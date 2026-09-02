#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(MODULE_PATH));
const DEFAULT_BUNDLE_ROOT = path.join(ROOT, 'bundle');
const MEASUREMENT_DIR = 'docs/assurance/evidence/measurement';

export const BUNDLE_MEMBERS = [
  `${MEASUREMENT_DIR}/measurement-contract.md`,
  `${MEASUREMENT_DIR}/family-registry.json`,
  `${MEASUREMENT_DIR}/corpus-manifest.json`,
  `${MEASUREMENT_DIR}/artifact-schema.json`,
];

export const RELEASE_POLICY_PARAMETERS = Object.freeze({
  disposition_precedence: 'ambiguous over incomplete over bound; no construction is not-a-claim',
  max_gap_bytes: 320,
  pr_cue_gap_bytes: 48,
  pr_cues: 'release PR|released as PR|PR ... released ... tag',
  record_boundary: 'a direct release-PR cue starts a record and the next direct release-PR cue ends it',
  reverse_pr_connector_bytes: 160,
  squash_cue_gap_bytes: 32,
  squash_cues: 'squash between the record release PR and tag',
  sync_cue_gap_bytes: 48,
  sync_cues: 'marketplace sync|marketplace sync commit|unqualified sync|unqualified sync commit after tag',
  tag_cue_gap_bytes: 64,
  tag_group_gap_bytes: 200,
  tag_group_connectors: 'punctuation|and|alongside',
});

export const PROOF_DATE_POLICY_PARAMETERS = Object.freeze({
  construction_order: 'DATE-AS|RUN-ON|DATE-DIRECT|RUN-PARENTHETICAL|DATE-LABELLED|LABELLED-GROUP',
  date_equivalence: 'YYYYMMDD in run id equals YYYY-MM-DD with optional trailing Z',
  disposition_precedence: 'ambiguous over bound over incomplete over not-a-claim',
  full_timestamp_fallback: 'YYYY-MM-DDTHH:MM[:SS]Z connected by a direct form yields incomplete',
  group_child_separators: 'opening parenthesis|semicolon|comma',
  hard_boundaries: 'period|semicolon|question mark|exclamation mark|table-cell bar|blank line',
  label_nouns: 'run|record|proof|attestation|artifact|snapshot|datapoint',
  markdown_decorations_removed: 'backtick|asterisk|underscore|square brackets',
  max_gap_bytes: 256,
  scope: 'same blob',
  whitespace_normalization: 'collapse ASCII whitespace for connector matching only',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalBody(value, level) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot encode a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const childIndent = '  '.repeat(level + 1);
    const closeIndent = '  '.repeat(level);
    return `[\n${value.map((item) => `${childIndent}${canonicalBody(item, level + 1)}`).join(',\n')}\n${closeIndent}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return '{}';
    const childIndent = '  '.repeat(level + 1);
    const closeIndent = '  '.repeat(level);
    const members = keys.map((key) => {
      if (value[key] === undefined) throw new TypeError(`canonical JSON cannot encode undefined at ${key}`);
      return `${childIndent}${JSON.stringify(key)}: ${canonicalBody(value[key], level + 1)}`;
    });
    return `{\n${members.join(',\n')}\n${closeIndent}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

// Contract 2.1: lexicographic object keys at every depth, two spaces, final LF.
// This emits members directly rather than sorting into a plain JS object, because
// JSON.stringify reorders integer-index-looking keys numerically.
export function canonicalSerialize(value) {
  return `${canonicalBody(value, 0)}\n`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalDigest(value) {
  return sha256Hex(Buffer.from(canonicalSerialize(value), 'utf8'));
}

export function gitBlobId(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

// Contract 11.3: exact member bytes, fixed order, repository-relative paths,
// decimal byte lengths, and NUL delimiters.
export function computeBundleDigest(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  const hash = createHash('sha256');
  for (const member of BUNDLE_MEMBERS) {
    const bytes = readFileSync(path.join(bundleRoot, member));
    hash.update(Buffer.from(member, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(bytes.length), 'ascii'));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function makeCharToByteMap(text) {
  const map = new Uint32Array(text.length + 1);
  let byte = 0;
  for (let index = 0; index < text.length;) {
    map[index] = byte;
    const point = text.codePointAt(index);
    const character = String.fromCodePoint(point);
    if (character.length === 2) map[index + 1] = byte;
    byte += Buffer.byteLength(character, 'utf8');
    index += character.length;
    map[index] = byte;
  }
  return map;
}

function characterBefore(text, index) {
  if (index === 0) return null;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return text.slice(index - 2, index);
  return text[index - 1];
}

function characterAfter(text, index) {
  if (index >= text.length) return null;
  return String.fromCodePoint(text.codePointAt(index));
}

function isAlphanumeric(character) {
  return character !== null && /^[\p{L}\p{N}]$/u.test(character);
}

function isWordCharacter(character) {
  return character !== null && /^[A-Za-z0-9_]$/.test(character);
}

function isPackageTokenCharacter(character) {
  return character !== null && /^[A-Za-z0-9_-]$/.test(character);
}

function present(value) {
  return { state: 'present', value };
}

function unresolved() {
  return { state: 'unresolved' };
}

function notApplicable() {
  return { state: 'not-applicable' };
}

function contentDigestShape(text, start) {
  const prefix = text.slice(0, start);
  if (/sha256:\s*[`'\"]?\s*$/i.test(prefix)) return 'prefixed';
  if (/[A-Za-z0-9_.-]+_sha256\b(?:[\s:`'\"=]*)$/i.test(prefix)) return 'prefixed';
  return 'bare';
}

function occurrenceSort(left, right) {
  return left.path.localeCompare(right.path)
    || left.start_byte - right.start_byte
    || left.end_byte - right.end_byte
    || left.family.localeCompare(right.family)
    || left.profile.localeCompare(right.profile);
}

/**
 * Apply the registry's lexical observables to one exact blob. Recognised token
 * bodies are ASCII, but char-to-byte mapping is retained so non-ASCII text and
 * CRLF before a token cannot leak character offsets into the artifact (§3.5).
 */
export function scanBuffer({ buffer, path: manifestPath, blob, profile }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(buffer);
  const charToByte = makeCharToByteMap(text);
  const occurrences = [];

  function add(family, start, end, extraFields = {}) {
    const literal = text.slice(start, end);
    occurrences.push({
      profile,
      path: manifestPath,
      blob,
      start_byte: charToByte[start],
      end_byte: charToByte[end],
      family,
      literal,
      fields: {
        literal: present(literal),
        ...extraFields,
      },
      _start_char: start,
      _end_char: end,
    });
  }

  const proofSpans = [];
  const proofPattern = /[A-Za-z0-9][A-Za-z0-9_-]*-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+/g;
  for (const match of text.matchAll(proofPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const left = characterBefore(text, start);
    const right = characterAfter(text, end);
    if ((left !== null && /^[A-Za-z0-9_-]$/.test(left))
        || (right !== null && /^[A-Za-z0-9_-]$/.test(right))) continue;
    const dateMarker = match[0].search(/-[0-9]{8}T[0-9]{6}Z-/);
    const kind = match[0].slice(0, dateMarker);
    proofSpans.push({ start, end });
    add('proof-run-id', start, end, {
      kind: present(kind),
      artifact_present: notApplicable(),
    });
  }

  const packageSpans = [];
  const packagePattern = /plugin-([A-Za-z0-9][A-Za-z0-9._-]*?)-v([0-9]+)\.([0-9]+)\.([0-9]+)/g;
  for (const match of text.matchAll(packagePattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const right = characterAfter(text, end);
    // A full stop may delimit prose or the two sides of a `tag..tag` range.
    // Reject only a dot that actually continues the numeric version.
    if (isPackageTokenCharacter(characterBefore(text, start))
        || isPackageTokenCharacter(right)
        || (right === '.' && /^[0-9]$/.test(characterAfter(text, end + 1) ?? ''))) continue;
    packageSpans.push({ start, end });
    add('package-tag', start, end, {
      package: present(match[1]),
      version: present(`${match[2]}.${match[3]}.${match[4]}`),
      canonical: unresolved(),
    });
  }

  const hexadecimalPattern = /[0-9a-f]+/g;
  for (const match of text.matchAll(hexadecimalPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0].length > 40) {
      add('content-digest', start, end, {
        shape: present(contentDigestShape(text, start)),
      });
      continue;
    }
    if (match[0].length < 7) continue;
    const left = characterBefore(text, start);
    const right = characterAfter(text, end);
    if (left === '-' || left === '\u2026' || right === '\u2026'
        || isAlphanumeric(left) || isAlphanumeric(right)) continue;
    add('commit-citation', start, end, { canonical: unresolved() });
  }

  const prPattern = /#[0-9]{2,4}/g;
  for (const match of text.matchAll(prPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const right = characterAfter(text, end);
    // The registry says "terminated by a non-word character"; unlike the date
    // rule it does not admit end-of-blob as an alternative.
    if (right === null || isWordCharacter(right)) continue;
    add('pr-citation', start, end);
  }

  const datePattern = /[0-9]{4}-[0-9]{2}-[0-9]{2}Z?/g;
  for (const match of text.matchAll(datePattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isWordCharacter(characterBefore(text, start))
        || isWordCharacter(characterAfter(text, end))) continue;
    if (proofSpans.some((span) => start >= span.start && end <= span.end)) continue;
    add('iso-date', start, end);
  }

  const semverPattern = /[0-9]+\.[0-9]+\.[0-9]+/g;
  for (const match of text.matchAll(semverPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const forbiddenBoundary = (character) => character !== null && /^[A-Za-z0-9_.-]$/.test(character);
    if (forbiddenBoundary(characterBefore(text, start))
        || forbiddenBoundary(characterAfter(text, end))) continue;
    if (packageSpans.some((span) => start >= span.start && end <= span.end)) continue;
    add('bare-semver', start, end);
  }

  return occurrences.sort(occurrenceSort);
}

function stripInternalOccurrenceFields(occurrence) {
  const { _start_char, _end_char, ...wire } = occurrence;
  return wire;
}

function manifestPathIndex(manifest) {
  const index = new Map();
  for (const [profile, declaration] of Object.entries(manifest.profiles)) {
    for (const file of declaration.files) {
      const prior = index.get(file.path);
      if (prior && (prior.blob !== file.blob || prior.bytes !== file.bytes)) {
        throw new Error(`manifest profiles disagree for ${file.path}`);
      }
      if (prior) prior.profiles.add(profile);
      else index.set(file.path, { ...file, profiles: new Set([profile]) });
    }
  }
  return index;
}

/**
 * Scan each physical file once. For overlapping profile membership the
 * stage-docs label is retained because both relations use that profile; this
 * avoids duplicate same-family physical identities (§3.2).
 */
export function scanCorpus(bundleRoot, manifest) {
  const files = manifestPathIndex(manifest);
  const occurrences = [];
  const buffers = new Map();
  for (const [manifestPath, file] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const buffer = readFileSync(path.join(bundleRoot, manifestPath));
    if (buffer.length !== file.bytes) throw new Error(`byte length mismatch for ${manifestPath}`);
    if (gitBlobId(buffer) !== file.blob) throw new Error(`git blob mismatch for ${manifestPath}`);
    buffers.set(manifestPath, buffer);
    const profile = file.profiles.has('stage-docs')
      ? 'stage-docs'
      : [...file.profiles].sort()[0];
    occurrences.push(...scanBuffer({
      buffer,
      path: manifestPath,
      blob: file.blob,
      profile,
    }));
  }
  return {
    buffers,
    occurrences: occurrences.sort(occurrenceSort).map(stripInternalOccurrenceFields),
  };
}

function physicalKey(identity) {
  return `${identity.path}\0${identity.blob}\0${identity.start_byte}\0${identity.end_byte}`;
}

function identity(occurrence, profile) {
  return {
    profile,
    path: occurrence.path,
    blob: occurrence.blob,
    start_byte: occurrence.start_byte,
    end_byte: occurrence.end_byte,
  };
}

function spanGap(left, right) {
  if (left.end_byte < right.start_byte) return right.start_byte - left.end_byte;
  if (right.end_byte < left.start_byte) return left.start_byte - right.end_byte;
  return 0;
}

function asciiLookBehind(buffer, endByte, byteCount) {
  return buffer.subarray(Math.max(0, endByte - byteCount), endByte).toString('utf8');
}

function hasDirectReleasePrCue(buffer, occurrence) {
  const prefix = asciiLookBehind(buffer, occurrence.start_byte, RELEASE_POLICY_PARAMETERS.pr_cue_gap_bytes);
  return /(?:\brelease\s+PR|\breleased\s+as\s+PR)\s*(?:\[|`)?\s*$/i.test(prefix);
}

function hasBarePrCue(buffer, occurrence) {
  const prefix = asciiLookBehind(buffer, occurrence.start_byte, RELEASE_POLICY_PARAMETERS.pr_cue_gap_bytes);
  return /\bPR\s*(?:\[|`)?\s*$/i.test(prefix);
}

function hasSquashCue(buffer, occurrence) {
  const prefix = asciiLookBehind(buffer, occurrence.start_byte, RELEASE_POLICY_PARAMETERS.squash_cue_gap_bytes);
  return /\bsquash\s*(?:\[|`)?\s*$/i.test(prefix);
}

function hasSyncCue(buffer, occurrence) {
  const prefix = asciiLookBehind(buffer, occurrence.start_byte, RELEASE_POLICY_PARAMETERS.sync_cue_gap_bytes);
  if (/\bmarketplace\s+sync(?:\s+commit)?\s*(?:\[|`)?\s*$/i.test(prefix)) return true;
  const match = prefix.match(/\bsync(?:\s+commit)?\s*(?:\[|`)?\s*$/i);
  if (!match) return false;
  const preceding = prefix.slice(0, match.index).trimEnd().at(-1);
  return preceding === undefined || !/[A-Za-z0-9-]/.test(preceding);
}

function directTagCue(buffer, anchor) {
  const before = asciiLookBehind(buffer, anchor.start_byte, RELEASE_POLICY_PARAMETERS.tag_cue_gap_bytes);
  return /\b(?:release\s+|cut(?:ting)?\s+)?tags?\s*(?:`)?\s*$/i.test(before);
}

function tagGroupClaim(buffer, anchor, packageTags) {
  const earlierSeeds = packageTags.filter((candidate) => candidate.path === anchor.path
    && candidate.start_byte < anchor.start_byte
    && anchor.start_byte - candidate.end_byte <= RELEASE_POLICY_PARAMETERS.tag_group_gap_bytes
    && directTagCue(buffer, candidate));
  for (const seed of earlierSeeds) {
    const bridge = buffer.subarray(seed.end_byte, anchor.start_byte).toString('utf8');
    const withoutTags = bridge.replace(/plugin-[A-Za-z0-9][A-Za-z0-9._-]*?-v[0-9]+\.[0-9]+\.[0-9]+/g, '');
    if (/^(?:(?:and|alongside)\b|[\s`'\",/+&()[\]{}:;—–-])*$/i.test(withoutTags)) return true;
  }
  const immediatePrefix = asciiLookBehind(buffer, anchor.start_byte, RELEASE_POLICY_PARAMETERS.tag_cue_gap_bytes);
  return earlierSeeds.length > 0 && /\b(?:and|alongside)\s*`?\s*$/i.test(immediatePrefix);
}

function reverseReleasePrCandidates(buffer, anchor, prOccurrences) {
  const maxGap = RELEASE_POLICY_PARAMETERS.max_gap_bytes;
  return prOccurrences.filter((candidate) => candidate.path === anchor.path
    && candidate.end_byte <= anchor.start_byte
    && spanGap(anchor, candidate) <= maxGap
    && hasBarePrCue(buffer, candidate)
    && (() => {
      const between = buffer.subarray(candidate.end_byte, anchor.start_byte);
      if (between.length > RELEASE_POLICY_PARAMETERS.reverse_pr_connector_bytes) return false;
      if (!/(?:\breleased\b[\s\S]*\btags?\b|\bcut(?:ting)?\s+tags?\b)/i.test(between.toString('utf8'))) return false;
      return !prOccurrences.some((other) => other.path === anchor.path
        && other.start_byte > candidate.start_byte
        && other.start_byte < anchor.start_byte);
    })());
}

function candidatesNear(anchor, familyOccurrences, maxGap, predicate = () => true) {
  return familyOccurrences.filter((candidate) => candidate.path === anchor.path
    && spanGap(anchor, candidate) <= maxGap
    && predicate(candidate));
}

function releaseAnchorRow(anchor, byFamily, buffers, relation) {
  const buffer = buffers.get(anchor.path);
  const maxGap = RELEASE_POLICY_PARAMETERS.max_gap_bytes;
  const prOccurrences = byFamily.get('pr-citation') ?? [];
  const directPrs = prOccurrences.filter((candidate) => candidate.path === anchor.path
    && candidate.end_byte <= anchor.start_byte
    && spanGap(anchor, candidate) <= maxGap
    && hasDirectReleasePrCue(buffer, candidate))
    .sort((left, right) => left.start_byte - right.start_byte);
  // Direct release-PR cues delimit records. The final cue preceding the tag is
  // therefore the start of the containing construction, not a proximity tie-break.
  const prCandidates = directPrs.length > 0
    ? [directPrs.at(-1)]
    : reverseReleasePrCandidates(buffer, anchor, prOccurrences);
  const packageTags = byFamily.get('package-tag') ?? [];
  const carriesClaim = directTagCue(buffer, anchor)
    || tagGroupClaim(buffer, anchor, packageTags);
  if (!carriesClaim) {
    return {
      relation: relation.id,
      anchor: identity(anchor, relation.profile),
      disposition: 'not-a-claim',
      roles: {},
    };
  }

  const roles = { [relation.anchor_role]: identity(anchor, relation.profile) };
  if (prCandidates.length === 1) roles.release_pr = identity(prCandidates[0], relation.profile);

  const squashCandidates = prCandidates.length === 1
    ? (byFamily.get('commit-citation') ?? []).filter((candidate) => candidate.path === anchor.path
      && candidate.start_byte >= prCandidates[0].end_byte
      && candidate.end_byte <= anchor.start_byte
      && hasSquashCue(buffer, candidate))
    : [];
  if (squashCandidates.length === 1) roles.squash = identity(squashCandidates[0], relation.profile);

  const nextDirectPr = prOccurrences
    .filter((candidate) => candidate.path === anchor.path
      && candidate.start_byte > anchor.start_byte
      && hasDirectReleasePrCue(buffer, candidate))
    .sort((left, right) => left.start_byte - right.start_byte)[0];
  const recordEnd = Math.min(
    buffer.length,
    anchor.end_byte + maxGap,
    nextDirectPr?.start_byte ?? Number.POSITIVE_INFINITY,
  );
  const syncCandidates = prCandidates.length === 1
    ? (byFamily.get('commit-citation') ?? []).filter((candidate) => candidate.path === anchor.path
      && candidate.start_byte >= anchor.end_byte
      && candidate.end_byte <= recordEnd
      && hasSyncCue(buffer, candidate))
    : [];
  if (syncCandidates.length === 1) roles.marketplace_sync = identity(syncCandidates[0], relation.profile);

  const hasUnrankedMultiplicity = prCandidates.length > 1
    || squashCandidates.length > 1
    || syncCandidates.length > 1;
  return {
    relation: relation.id,
    anchor: identity(anchor, relation.profile),
    disposition: hasUnrankedMultiplicity
      ? 'ambiguous'
      : (prCandidates.length === 0 ? 'incomplete' : 'bound'),
    roles,
  };
}

function normalizedConnector(buffer, earlier, later, { allowSemicolon = false } = {}) {
  if (later.start_byte < earlier.end_byte) return null;
  const gap = buffer.subarray(earlier.end_byte, later.start_byte);
  if (gap.length > PROOF_DATE_POLICY_PARAMETERS.max_gap_bytes) return null;
  const source = gap.toString('utf8');
  const hardPunctuation = allowSemicolon ? /[.?!|]/ : /[.;?!|]/;
  if (hardPunctuation.test(source) || /\n[ \t]*\n/.test(source)) return null;
  return source.replace(/[`*_\[\]]/g, '').replace(/[ \t\r\n\f\v]+/g, ' ').trim();
}

const CONNECTOR_PUNCTUATION = '[,:()\\-–— ]*';
const LABEL_NOUNS = '(?:run|record|proof|attestation|artifact|snapshot|datapoint)';

export function classifyDirectDateConstruction(buffer, date, anchor) {
  if (date.end_byte <= anchor.start_byte) {
    const connector = normalizedConnector(buffer, date, anchor);
    if (connector === null) return null;
    const dateAs = new RegExp(`(?:^|\\b)as\\s*${CONNECTOR_PUNCTUATION}$`, 'i');
    const dateDirect = new RegExp(`^${CONNECTOR_PUNCTUATION}$`);
    const dateLabelled = new RegExp(`\\b${LABEL_NOUNS}(?:\\s+(?:recorded|as))*\\s*${CONNECTOR_PUNCTUATION}$`, 'i');
    if (dateAs.test(connector)) return 'DATE-AS';
    if (dateDirect.test(connector)) return 'DATE-DIRECT';
    if (dateLabelled.test(connector)) return 'DATE-LABELLED';
    return null;
  }
  if (anchor.end_byte <= date.start_byte) {
    const connector = normalizedConnector(buffer, anchor, date);
    if (connector === null) return null;
    const runOn = new RegExp(`^${CONNECTOR_PUNCTUATION}(?:(?:recorded|attested)\\s+)?(?:on|at)${CONNECTOR_PUNCTUATION}$`, 'i');
    const runParenthetical = new RegExp(`^${CONNECTOR_PUNCTUATION}(?:(?:recorded|attested)${CONNECTOR_PUNCTUATION})?$`, 'i');
    if (runOn.test(connector)) return 'RUN-ON';
    if (runParenthetical.test(connector)) return 'RUN-PARENTHETICAL';
    return null;
  }
  return null;
}

function isInsideOpenInlineGroup(source, openingIndex) {
  let inCode = false;
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === '`') {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') depth -= 1;
  }
  return depth > 0;
}

export function labelledGroupConstruction(buffer, date, anchor) {
  if (date.end_byte > anchor.start_byte) return false;
  const connector = normalizedConnector(buffer, date, anchor, { allowSemicolon: true });
  if (connector === null || !connector.includes(';')) return false;
  const raw = buffer.subarray(date.end_byte, anchor.start_byte).toString('utf8');
  const openingPattern = new RegExp(`\\b${LABEL_NOUNS}\\s*\\(`, 'i');
  const openingMatch = openingPattern.exec(raw.replace(/[`*_\[\]]/g, ''));
  if (!openingMatch) return false;
  // Locate the corresponding opening parenthesis in the unnormalised bytes;
  // decoration removal does not remove parentheses, and requiring an open
  // group at the anchor prevents a later sentence from borrowing the date.
  const openingIndex = raw.indexOf('(', Math.max(0, openingMatch.index));
  if (openingIndex < 0 || !isInsideOpenInlineGroup(raw, openingIndex)) return false;
  const lastSeparator = Math.max(raw.lastIndexOf(';'), raw.lastIndexOf(','), raw.lastIndexOf('('));
  const child = raw.slice(lastSeparator + 1)
    .replace(/[`*_\[\]]/g, '')
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    .trim();
  return new RegExp(`\\b(?:run|record|proof|attestation|artifact|snapshot)\\s*$`, 'i').test(child);
}

const fullTimestampCache = new WeakMap();

function fullTimestampSpans(buffer, pathName, blob, profile) {
  if (fullTimestampCache.has(buffer)) return fullTimestampCache.get(buffer);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const spans = [];
  for (const match of text.matchAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?Z/g)) {
    const startByte = Buffer.byteLength(text.slice(0, match.index), 'utf8');
    spans.push({
      profile,
      path: pathName,
      blob,
      start_byte: startByte,
      end_byte: startByte + Buffer.byteLength(match[0], 'utf8'),
      literal: match[0],
    });
  }
  fullTimestampCache.set(buffer, spans);
  return spans;
}

function proofDateAnchorRow(anchor, byFamily, relation, buffer) {
  const dateParts = anchor.literal.match(/-([0-9]{4})([0-9]{2})([0-9]{2})T/);
  if (!dateParts) throw new Error(`proof-run-id did not retain its date component: ${anchor.literal}`);
  const expected = `${dateParts[1]}-${dateParts[2]}-${dateParts[3]}`;
  const candidatesByIdentity = new Map();
  for (const candidate of byFamily.get('iso-date') ?? []) {
    if (candidate.path !== anchor.path || candidate.literal.slice(0, 10) !== expected) continue;
    if (classifyDirectDateConstruction(buffer, candidate, anchor)
        || labelledGroupConstruction(buffer, candidate, anchor)) {
      candidatesByIdentity.set(physicalKey(candidate), candidate);
    }
  }
  const candidates = [...candidatesByIdentity.values()];
  if (candidates.length > 1) {
    return {
      relation: relation.id,
      anchor: identity(anchor, relation.profile),
      disposition: 'ambiguous',
      roles: { [relation.anchor_role]: identity(anchor, relation.profile) },
    };
  }
  if (candidates.length === 1) {
    return {
      relation: relation.id,
      anchor: identity(anchor, relation.profile),
      disposition: 'bound',
      roles: {
        [relation.anchor_role]: identity(anchor, relation.profile),
        date: identity(candidates[0], relation.profile),
      },
    };
  }

  const connectedFullTimestamps = fullTimestampSpans(
    buffer,
    anchor.path,
    anchor.blob,
    relation.profile,
  ).filter((candidate) => candidate.literal.slice(0, 10) === expected
    && classifyDirectDateConstruction(buffer, candidate, anchor));
  if (connectedFullTimestamps.length > 0) {
    return {
      relation: relation.id,
      anchor: identity(anchor, relation.profile),
      disposition: 'incomplete',
      roles: { [relation.anchor_role]: identity(anchor, relation.profile) },
    };
  }

  return {
    relation: relation.id,
    anchor: identity(anchor, relation.profile),
    disposition: 'not-a-claim',
    roles: {},
  };
}

export function buildAnchors(occurrences, buffers, registry, manifest = null) {
  const byFamily = new Map();
  for (const occurrence of occurrences) {
    const values = byFamily.get(occurrence.family) ?? [];
    values.push(occurrence);
    byFamily.set(occurrence.family, values);
  }
  let membership = null;
  if (manifest) {
    membership = new Map(Object.entries(manifest.profiles).map(([profile, declaration]) => [
      profile,
      new Set(declaration.files.map((file) => file.path)),
    ]));
  }
  const anchors = [];
  for (const relation of registry.relations) {
    if (relation.anchor_domain.restriction !== null) {
      throw new Error(`unsupported non-null anchor restriction for ${relation.id}`);
    }
    const domain = (byFamily.get(relation.anchor_domain.family) ?? []).filter((occurrence) => {
      if (!membership) return occurrence.profile === relation.anchor_domain.profile;
      return membership.get(relation.anchor_domain.profile)?.has(occurrence.path);
    });
    for (const anchor of domain) {
      if (relation.id === 'release-triple') {
        anchors.push(releaseAnchorRow(anchor, byFamily, buffers, relation));
      } else if (relation.id === 'proof-date-binding') {
        anchors.push(proofDateAnchorRow(anchor, byFamily, relation, buffers.get(anchor.path)));
      } else {
        throw new Error(`no lane policy implemented for relation ${relation.id}`);
      }
    }
  }
  return anchors;
}

export function createPolicies(registry) {
  return registry.relations.map((relation) => {
    let declaration;
    if (relation.id === 'release-triple') {
      declaration = {
        relation: relation.id,
        anchor_domain: {
          family: relation.anchor_domain.family,
          profile: relation.anchor_domain.profile,
          restriction: relation.anchor_domain.restriction,
        },
        class: 'lexical-cue construction grammar',
        parameters: { ...RELEASE_POLICY_PARAMETERS },
        ranking: 'construction boundaries assign a record; within it no candidates are ranked and only cardinality-one role sets are filled',
        tie_policy: 'ambiguous',
      };
    } else if (relation.id === 'proof-date-binding') {
      declaration = {
        relation: relation.id,
        anchor_domain: {
          family: relation.anchor_domain.family,
          profile: relation.anchor_domain.profile,
          restriction: relation.anchor_domain.restriction,
        },
        class: 'connector construction grammar',
        parameters: { ...PROOF_DATE_POLICY_PARAMETERS },
        ranking: 'none; construction-qualified physical candidates are deduplicated but never proximity-ranked',
        tie_policy: 'ambiguous',
      };
    } else {
      throw new Error(`no policy declaration implemented for ${relation.id}`);
    }
    return { ...declaration, digest: canonicalDigest(declaration) };
  });
}

function resolveLocalReference(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`only local schema references are supported: ${reference}`);
  return reference.slice(2).split('/').reduce((value, part) => {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    return value[key];
  }, rootSchema);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

/** A dependency-free validator for every assertion keyword used by the sealed schema. */
export function validateJsonSchema(instance, rootSchema) {
  const errors = [];
  function check(value, schema, pointer) {
    if (schema.$ref) {
      check(value, resolveLocalReference(rootSchema, schema.$ref), pointer);
      return;
    }
    if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
    }
    if (schema.enum && !schema.enum.some((member) => JSON.stringify(member) === JSON.stringify(value))) {
      errors.push(`${pointer}: value is not in enum`);
    }
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => typeMatches(value, type))) {
        errors.push(`${pointer}: expected type ${types.join('|')}`);
        return;
      }
    }
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && [...value].length < schema.minLength) {
        errors.push(`${pointer}: shorter than minLength`);
      }
      if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
        errors.push(`${pointer}: does not match pattern ${schema.pattern}`);
      }
    }
    if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pointer}: smaller than minimum`);
    }
    if (Array.isArray(value) && schema.items) {
      value.forEach((item, index) => check(item, schema.items, `${pointer}/${index}`));
    }
    if (isPlainObject(value)) {
      for (const required of schema.required ?? []) {
        if (!Object.hasOwn(value, required)) errors.push(`${pointer}: missing required property ${required}`);
      }
      const properties = schema.properties ?? {};
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) check(child, properties[key], `${pointer}/${key}`);
        else if (schema.additionalProperties === false) errors.push(`${pointer}: unexpected property ${key}`);
        else if (isPlainObject(schema.additionalProperties)) {
          check(child, schema.additionalProperties, `${pointer}/${key}`);
        }
      }
    }
  }
  check(instance, rootSchema, '#');
  return errors;
}

function withoutKey(object, key) {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

function deepEqual(left, right) {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

/**
 * Checks the semantic requirements that JSON Schema cannot express (§3.8),
 * including byte round trips, field completeness, policy digests, dispositions,
 * and total anchor coverage.
 */
export function semanticErrors(artifact, {
  bundleRoot = DEFAULT_BUNDLE_ROOT,
  manifest,
  registry,
  schema,
} = {}) {
  const loadedManifest = manifest ?? JSON.parse(readFileSync(path.join(bundleRoot, MEASUREMENT_DIR, 'corpus-manifest.json'), 'utf8'));
  const loadedRegistry = registry ?? JSON.parse(readFileSync(path.join(bundleRoot, MEASUREMENT_DIR, 'family-registry.json'), 'utf8'));
  const loadedSchema = schema ?? JSON.parse(readFileSync(path.join(bundleRoot, MEASUREMENT_DIR, 'artifact-schema.json'), 'utf8'));
  const errors = validateJsonSchema(artifact, loadedSchema);
  if (errors.length > 0) return errors;

  const manifestWithoutDigest = withoutKey(loadedManifest, 'digest');
  if (canonicalDigest(manifestWithoutDigest) !== loadedManifest.digest) errors.push('manifest: declared digest does not verify');
  if (artifact.contract_version !== loadedRegistry.contract_version) errors.push('artifact: contract version differs from registry');
  if (artifact.manifest_digest !== loadedManifest.digest) errors.push('artifact: manifest digest mismatch');
  if (artifact.corpus_commit !== loadedManifest.commit) errors.push('artifact: corpus commit mismatch');
  if (artifact.bundle_digest !== computeBundleDigest(bundleRoot)) errors.push('artifact: bundle digest mismatch');
  if (artifact.attestation.contract_version !== artifact.contract_version) errors.push('attestation: contract version mismatch');
  if (artifact.attestation.bundle_digest !== artifact.bundle_digest) errors.push('attestation: bundle digest mismatch');
  if (artifact.attestation.manifest_digest !== artifact.manifest_digest) errors.push('attestation: manifest digest mismatch');
  const artifactWithoutAttestation = withoutKey(artifact, 'attestation');
  if (artifact.attestation.artifact_digest !== canonicalDigest(artifactWithoutAttestation)) {
    errors.push('attestation: artifact digest mismatch');
  }

  const familyById = new Map(loadedRegistry.families.map((family) => [family.id, family]));
  const relationById = new Map(loadedRegistry.relations.map((relation) => [relation.id, relation]));
  const files = manifestPathIndex(loadedManifest);
  const profileMembership = new Map(Object.entries(loadedManifest.profiles).map(([profile, declaration]) => [
    profile,
    new Map(declaration.files.map((file) => [file.path, file])),
  ]));
  const buffers = new Map();
  const occurrenceIndex = new Map();
  const sameFamilyIdentities = new Set();

  for (const occurrence of artifact.occurrences) {
    const family = familyById.get(occurrence.family);
    if (!family) {
      errors.push(`occurrence: unknown family ${occurrence.family}`);
      continue;
    }
    if (!family.profiles.includes(occurrence.profile)) {
      errors.push(`occurrence: family ${family.id} is not bound to profile ${occurrence.profile}`);
    }
    const member = profileMembership.get(occurrence.profile)?.get(occurrence.path);
    if (!member || member.blob !== occurrence.blob) errors.push(`occurrence: membership/blob mismatch at ${occurrence.path}`);
    const file = files.get(occurrence.path);
    if (!file || file.blob !== occurrence.blob) errors.push(`occurrence: path/blob absent from manifest at ${occurrence.path}`);
    let buffer = buffers.get(occurrence.path);
    if (!buffer && file) {
      buffer = readFileSync(path.join(bundleRoot, occurrence.path));
      buffers.set(occurrence.path, buffer);
    }
    if (!Number.isSafeInteger(occurrence.start_byte) || !Number.isSafeInteger(occurrence.end_byte)
        || occurrence.start_byte < 0 || occurrence.start_byte >= occurrence.end_byte
        || !buffer || occurrence.end_byte > buffer.length) {
      errors.push(`occurrence: invalid byte range at ${occurrence.path}:${occurrence.start_byte}-${occurrence.end_byte}`);
    } else {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true })
          .decode(buffer.subarray(occurrence.start_byte, occurrence.end_byte));
        if (decoded !== occurrence.literal) errors.push(`occurrence: literal round trip failed at ${physicalKey(occurrence)}`);
      } catch {
        errors.push(`occurrence: span is not valid UTF-8 at ${physicalKey(occurrence)}`);
      }
    }
    const fields = occurrence.fields ?? {};
    const declaredFields = new Map(family.fields.map((field) => [field.name, field]));
    for (const field of family.fields) {
      if (!Object.hasOwn(fields, field.name)) errors.push(`occurrence: missing ${family.id}.${field.name}`);
    }
    for (const [name, fieldValue] of Object.entries(fields)) {
      const declaration = declaredFields.get(name);
      if (!declaration) {
        errors.push(`occurrence: undeclared ${family.id}.${name}`);
        continue;
      }
      if (!declaration.states.includes(fieldValue.state)) errors.push(`occurrence: invalid state for ${family.id}.${name}`);
      const hasValue = Object.hasOwn(fieldValue, 'value');
      if (fieldValue.state === 'present' && !hasValue) errors.push(`occurrence: present field lacks value ${family.id}.${name}`);
      if (fieldValue.state !== 'present' && hasValue) errors.push(`occurrence: non-present field carries value ${family.id}.${name}`);
    }
    if (fields.literal?.state !== 'present' || fields.literal?.value !== occurrence.literal) {
      errors.push(`occurrence: registry literal field differs from root literal at ${physicalKey(occurrence)}`);
    }
    const familyIdentity = `${occurrence.family}\0${physicalKey(occurrence)}`;
    if (sameFamilyIdentities.has(familyIdentity)) errors.push(`occurrence: duplicate same-family physical identity ${familyIdentity}`);
    sameFamilyIdentities.add(familyIdentity);
    const values = occurrenceIndex.get(physicalKey(occurrence)) ?? [];
    values.push(occurrence);
    occurrenceIndex.set(physicalKey(occurrence), values);
  }

  const policiesByRelation = new Map();
  for (const policy of artifact.policies) {
    const values = policiesByRelation.get(policy.relation) ?? [];
    values.push(policy);
    policiesByRelation.set(policy.relation, values);
    const declaration = withoutKey(policy, 'digest');
    if (policy.digest !== canonicalDigest(declaration)) errors.push(`policy: digest mismatch for ${policy.relation}`);
  }
  for (const relation of loadedRegistry.relations) {
    const policies = policiesByRelation.get(relation.id) ?? [];
    if (policies.length !== 1) errors.push(`policy: expected exactly one declaration for ${relation.id}`);
    else {
      const expectedDomain = {
        family: relation.anchor_domain.family,
        profile: relation.anchor_domain.profile,
        restriction: relation.anchor_domain.restriction,
      };
      if (!deepEqual(policies[0].anchor_domain, expectedDomain)) errors.push(`policy: anchor domain mismatch for ${relation.id}`);
    }
  }
  for (const relation of policiesByRelation.keys()) {
    if (!relationById.has(relation)) errors.push(`policy: unknown relation ${relation}`);
  }

  const rowsByRelationAndAnchor = new Map();
  for (const row of artifact.anchors) {
    const relation = relationById.get(row.relation);
    if (!relation) {
      errors.push(`anchor: unknown relation ${row.relation}`);
      continue;
    }
    const rowKey = `${row.relation}\0${physicalKey(row.anchor)}`;
    const prior = rowsByRelationAndAnchor.get(rowKey) ?? [];
    prior.push(row);
    rowsByRelationAndAnchor.set(rowKey, prior);
    const anchorOccurrences = occurrenceIndex.get(physicalKey(row.anchor)) ?? [];
    if (!anchorOccurrences.some((item) => item.family === relation.anchor_domain.family)) {
      errors.push(`anchor: anchor occurrence missing/wrong family for ${rowKey}`);
    }
    if (!profileMembership.get(relation.profile)?.has(row.anchor.path)) errors.push(`anchor: outside relation profile for ${rowKey}`);
    const roleDeclarations = new Map(relation.roles.map((role) => [role.name, role]));
    for (const [name, binding] of Object.entries(row.roles)) {
      const role = roleDeclarations.get(name);
      if (!role) {
        errors.push(`anchor: unknown role ${row.relation}.${name}`);
        continue;
      }
      const roleOccurrences = occurrenceIndex.get(physicalKey(binding)) ?? [];
      if (!roleOccurrences.some((item) => item.family === role.family)) {
        errors.push(`anchor: binding missing/wrong family for ${row.relation}.${name}`);
      }
      if (!profileMembership.get(relation.profile)?.has(binding.path)) errors.push(`anchor: role outside relation profile for ${row.relation}.${name}`);
      if (binding.profile !== undefined && binding.profile !== relation.profile) errors.push(`anchor: role profile mismatch for ${row.relation}.${name}`);
    }
    if (Object.hasOwn(row.roles, relation.anchor_role)
        && physicalKey(row.roles[relation.anchor_role]) !== physicalKey(row.anchor)) {
      errors.push(`anchor: anchor role does not name anchor for ${rowKey}`);
    }
    const missingRequired = relation.roles.filter((role) => role.required && !Object.hasOwn(row.roles, role.name));
    if (row.disposition === 'bound' && missingRequired.length > 0) errors.push(`anchor: bound row misses required role for ${rowKey}`);
    if (row.disposition === 'incomplete' && missingRequired.length === 0) errors.push(`anchor: incomplete row fills every required role for ${rowKey}`);
    if (row.disposition === 'not-a-claim' && Object.keys(row.roles).length !== 0) errors.push(`anchor: not-a-claim row fills roles for ${rowKey}`);
  }

  for (const relation of loadedRegistry.relations) {
    if (relation.anchor_domain.restriction !== null) {
      errors.push(`anchor: semantic validator cannot enumerate restriction for ${relation.id}`);
      continue;
    }
    const memberPaths = profileMembership.get(relation.anchor_domain.profile);
    const expectedAnchors = artifact.occurrences.filter((occurrence) => occurrence.family === relation.anchor_domain.family
      && memberPaths?.has(occurrence.path));
    for (const anchor of expectedAnchors) {
      const rowKey = `${relation.id}\0${physicalKey(anchor)}`;
      const rows = rowsByRelationAndAnchor.get(rowKey) ?? [];
      if (rows.length !== 1) errors.push(`anchor: expected exactly one row for ${rowKey}, found ${rows.length}`);
    }
    for (const [rowKey, rows] of rowsByRelationAndAnchor) {
      if (!rowKey.startsWith(`${relation.id}\0`)) continue;
      if (rows.length > 1) errors.push(`anchor: duplicate rows for ${rowKey}`);
      const expected = expectedAnchors.some((anchor) => physicalKey(anchor) === physicalKey(rows[0].anchor));
      if (!expected) errors.push(`anchor: row outside domain for ${rowKey}`);
    }
  }
  return errors;
}

export function assertArtifactSemantics(artifact, options) {
  const errors = semanticErrors(artifact, options);
  if (errors.length > 0) throw new Error(`artifact validation failed:\n- ${errors.join('\n- ')}`);
}

function secondPrecisionTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
}

export function buildArtifact({
  bundleRoot = DEFAULT_BUNDLE_ROOT,
  sealedAt = secondPrecisionTimestamp(),
} = {}) {
  const manifest = JSON.parse(readFileSync(path.join(bundleRoot, MEASUREMENT_DIR, 'corpus-manifest.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(path.join(bundleRoot, MEASUREMENT_DIR, 'family-registry.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(path.join(bundleRoot, MEASUREMENT_DIR, 'artifact-schema.json'), 'utf8'));
  const { buffers, occurrences } = scanCorpus(bundleRoot, manifest);
  const policies = createPolicies(registry);
  const anchors = buildAnchors(occurrences, buffers, registry, manifest);
  const artifactWithoutAttestation = {
    schema: 'evidence-measurement-artifact-1.0',
    contract_version: registry.contract_version,
    role: 'lane',
    artifact_id: 'lane-s1-byte-first-construction-grammar-v1',
    bundle_digest: computeBundleDigest(bundleRoot),
    manifest_digest: manifest.digest,
    corpus_commit: manifest.commit,
    policies,
    occurrences,
    anchors,
  };
  const artifact = {
    ...artifactWithoutAttestation,
    attestation: {
      contract_version: registry.contract_version,
      bundle_digest: artifactWithoutAttestation.bundle_digest,
      manifest_digest: manifest.digest,
      artifact_digest: canonicalDigest(artifactWithoutAttestation),
      sealed_at: sealedAt,
      prohibited_inputs_accessed: [],
    },
  };
  assertArtifactSemantics(artifact, { bundleRoot, manifest, registry, schema });
  return artifact;
}

export function main() {
  const artifact = buildArtifact();
  const outDir = path.join(ROOT, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'artifact.json'), canonicalSerialize(artifact), 'utf8');
  const counts = new Map();
  for (const row of artifact.anchors) {
    const key = `${row.relation}:${row.disposition}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  process.stdout.write(`wrote out/artifact.json (${artifact.occurrences.length} occurrences, ${artifact.anchors.length} anchors)\n`);
  for (const [key, count] of [...counts.entries()].sort()) process.stdout.write(`${key} ${count}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) main();
