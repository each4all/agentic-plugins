import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(OUT_DIR, '..');
const BUNDLE_ROOT = join(WORKSPACE, 'bundle');

const INPUT_PATHS = Object.freeze({
  contract: 'docs/assurance/evidence/measurement/measurement-contract.md',
  registry: 'docs/assurance/evidence/measurement/family-registry.json',
  manifest: 'docs/assurance/evidence/measurement/corpus-manifest.json',
  schema: 'docs/assurance/evidence/measurement/artifact-schema.json',
});

const BUNDLE_MEMBERS = Object.freeze([
  INPUT_PATHS.contract,
  INPUT_PATHS.registry,
  INPUT_PATHS.manifest,
  INPUT_PATHS.schema,
]);

// The registry uses the regex term "word character" without defining a
// Unicode expansion. This lane adopts ECMAScript \w's ASCII vocabulary.
const WORD_RE = /[A-Za-z0-9_]/u;
const ALNUM_RE = /[A-Za-z0-9]/u;
const JSON_SCHEMA_ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$defs',
  'title',
  'description',
]);
const JSON_SCHEMA_ASSERTIONS = new Set([
  '$ref',
  'type',
  'required',
  'additionalProperties',
  'properties',
  'items',
  'enum',
  'const',
  'pattern',
  'minLength',
  'minimum',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, depth, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  assert(typeof value !== 'bigint', 'canonical JSON cannot contain bigint');
  assert(typeof value !== 'undefined', 'canonical JSON cannot contain undefined');
  assert(typeof value !== 'function', 'canonical JSON cannot contain functions');
  assert(typeof value !== 'symbol', 'canonical JSON cannot contain symbols');
  assert(value && typeof value === 'object', 'canonical JSON received an unsupported value');
  assert(!ancestors.has(value), 'canonical JSON cannot contain a cycle');

  ancestors.add(value);
  const indentation = '  '.repeat(depth);
  const childIndentation = '  '.repeat(depth + 1);
  let result;

  if (Array.isArray(value)) {
    if (value.length === 0) {
      result = '[]';
    } else {
      const members = value.map(
        (member) => `${childIndentation}${canonicalValue(member, depth + 1, ancestors)}`,
      );
      result = `[\n${members.join(',\n')}\n${indentation}]`;
    }
  } else {
    assert(isPlainObject(value), 'canonical JSON only accepts plain objects');
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      result = '{}';
    } else {
      const members = keys.map((key) => {
        const member = canonicalValue(value[key], depth + 1, ancestors);
        return `${childIndentation}${JSON.stringify(key)}: ${member}`;
      });
      result = `{\n${members.join(',\n')}\n${indentation}}`;
    }
  }

  ancestors.delete(value);
  return result;
}

/** Contract §2.1 canonical serialization. */
export function canonicalJson(value) {
  return `${canonicalValue(value, 0, new Set())}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gitBlobOid(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

export function declarationDigest(declaration) {
  const { digest: _discarded, ...withoutDigest } = declaration;
  return sha256(Buffer.from(canonicalJson(withoutDigest), 'utf8'));
}

export function artifactDigest(artifact) {
  const { attestation: _discarded, ...withoutAttestation } = artifact;
  return sha256(Buffer.from(canonicalJson(withoutAttestation), 'utf8'));
}

export function computeBundleDigest(memberBytes) {
  const hash = createHash('sha256');
  for (const memberPath of BUNDLE_MEMBERS) {
    const bytes = memberBytes.get(memberPath);
    assert(Buffer.isBuffer(bytes), `missing sealed bundle member ${memberPath}`);
    hash.update(memberPath, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(String(bytes.length), 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function previousCodePoint(text, index) {
  if (index <= 0) return null;
  let start = index - 1;
  const last = text.charCodeAt(start);
  if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
    const first = text.charCodeAt(start - 1);
    if (first >= 0xd800 && first <= 0xdbff) start -= 1;
  }
  return String.fromCodePoint(text.codePointAt(start));
}

function nextCodePoint(text, index) {
  if (index >= text.length) return null;
  return String.fromCodePoint(text.codePointAt(index));
}

function buildByteMap(text) {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = 0;
  let index = 0;
  offsets[0] = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const encodedWidth = Buffer.byteLength(String.fromCodePoint(codePoint), 'utf8');
    offsets[index] = byteOffset;
    if (width === 2) offsets[index + 1] = byteOffset;
    index += width;
    byteOffset += encodedWidth;
    offsets[index] = byteOffset;
  }
  return offsets;
}

function makeLines(text) {
  const lines = [];
  let start = 0;
  let activeFence = null;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const contentEnd = newline === -1 ? text.length : newline;
    const end = newline === -1 ? text.length : newline + 1;
    const content = text.slice(start, contentEnd).replace(/\r$/, '');
    const marker = content.match(/^\s*(`{3,}|~{3,})/u)?.[1] ?? null;
    let fenced = activeFence !== null;
    if (marker !== null) {
      fenced = true;
      const markerKind = marker[0];
      if (activeFence === null) activeFence = markerKind;
      else if (activeFence === markerKind) activeFence = null;
    }
    lines.push({ start, contentEnd, end, content, fenced });
    if (newline === -1) break;
    start = end;
  }
  return lines;
}

function lineIndexAt(lines, index) {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle];
    if (index < line.start) high = middle - 1;
    else if (index >= line.end && middle < lines.length - 1) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(lines.length - 1, low));
}

function recordFor(document, index) {
  const { text, lines } = document;
  const lineNumber = lineIndexAt(lines, index);
  const line = lines[lineNumber];
  const trimmed = line.content.trimStart();

  if (line.fenced) {
    return { start: line.start, end: line.contentEnd, kind: 'code-fence', fenced: true };
  }
  if (trimmed.startsWith('|')) {
    return { start: line.start, end: line.contentEnd, kind: 'table-row', fenced: false };
  }

  const bulletPattern = /^(\s*)(?:[-+*]|[0-9]+[.)])\s+/u;
  let listStart = -1;
  for (let cursor = lineNumber; cursor >= 0; cursor -= 1) {
    if (lines[cursor].content.trim() === '') break;
    if (bulletPattern.test(lines[cursor].content)) {
      listStart = cursor;
      break;
    }
  }
  if (listStart >= 0) {
    const baseIndent = lines[listStart].content.match(bulletPattern)[1].length;
    let listEnd = listStart + 1;
    while (listEnd < lines.length && lines[listEnd].content.trim() !== '') {
      const nextBullet = lines[listEnd].content.match(bulletPattern);
      if (nextBullet && nextBullet[1].length <= baseIndent) break;
      listEnd += 1;
    }
    const last = lines[listEnd - 1];
    return {
      start: lines[listStart].start,
      end: last.contentEnd,
      kind: 'list-item',
      fenced: false,
    };
  }

  let first = lineNumber;
  let last = lineNumber;
  while (first > 0 && lines[first - 1].content.trim() !== '') first -= 1;
  while (last + 1 < lines.length && lines[last + 1].content.trim() !== '') last += 1;
  return {
    start: lines[first].start,
    end: lines[last].contentEnd,
    kind: 'paragraph',
    fenced: false,
  };
}

function clauseFor(document, anchor) {
  let record = recordFor(document, anchor._charStart);
  if (record.kind === 'code-fence') return record;

  if (record.kind === 'table-row') {
    const row = document.text.slice(record.start, record.end);
    const anchorLocal = anchor._charStart - record.start;
    const previousPipe = row.lastIndexOf('|', Math.max(0, anchorLocal - 1));
    const nextPipe = row.indexOf('|', anchorLocal);
    record = {
      start: record.start + (previousPipe < 0 ? 0 : previousPipe + 1),
      end: record.start + (nextPipe < 0 ? row.length : nextPipe),
      kind: 'table-cell',
      fenced: false,
    };
  }

  const local = document.text.slice(record.start, record.end);
  const anchorLocal = anchor._charStart - record.start;
  const boundaries = [0];
  for (let index = 0; index < local.length; index += 1) {
    const character = local[index];
    if (character === ';') {
      boundaries.push(index + 1);
      continue;
    }
    if (character === '.' || character === '?' || character === '!') {
      const after = nextCodePoint(local, index + 1);
      if (after === null || /\s/u.test(after)) boundaries.push(index + 1);
    }
  }
  boundaries.push(local.length);
  const unique = [...new Set(boundaries)].sort((a, b) => a - b);
  let start = 0;
  let end = local.length;
  for (let index = 0; index < unique.length - 1; index += 1) {
    if (anchorLocal >= unique[index] && anchorLocal < unique[index + 1]) {
      start = unique[index];
      end = unique[index + 1];
      break;
    }
  }
  return {
    start: record.start + start,
    end: record.start + end,
    kind: `${record.kind}-clause`,
    fenced: false,
  };
}

function identity(occurrence) {
  return {
    path: occurrence.path,
    blob: occurrence.blob,
    start_byte: occurrence.start_byte,
    end_byte: occurrence.end_byte,
  };
}

function physicalKey(occurrence) {
  return [
    occurrence.path,
    occurrence.blob,
    occurrence.start_byte,
    occurrence.end_byte,
  ].join('\0');
}

function familyPhysicalKey(occurrence) {
  return `${occurrence.family}\0${physicalKey(occurrence)}`;
}

function state(value) {
  return { state: 'present', value };
}

function matchAll(regex, text) {
  regex.lastIndex = 0;
  return [...text.matchAll(regex)];
}

function isInside(candidateStart, candidateEnd, containers) {
  return containers.some(
    (container) => candidateStart >= container._charStart && candidateEnd <= container._charEnd,
  );
}

function contentDigestShape(text, charStart) {
  const lineStart = text.lastIndexOf('\n', charStart - 1) + 1;
  const before = text.slice(lineStart, charStart);
  if (before.endsWith('sha256:')) return 'prefixed';
  const fieldIntroducer = /(?:^|[^\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*_sha256["'`]?\s*(?::|=|\|)\s*["'`]?\s*$/u;
  return fieldIntroducer.test(before) ? 'prefixed' : 'bare';
}

function occurrenceFromMatch(context, family, match, fields = {}) {
  const charStart = match.index;
  const charEnd = charStart + match[0].length;
  const startByte = context.byteMap[charStart];
  const endByte = context.byteMap[charEnd];
  const literal = context.bytes.subarray(startByte, endByte).toString('utf8');
  assert(literal === match[0], `internal byte mapping failed for ${family} in ${context.path}`);
  return {
    profile: context.profile,
    path: context.path,
    blob: context.blob,
    start_byte: startByte,
    end_byte: endByte,
    family,
    literal,
    fields: { literal: state(literal), ...fields },
    _charStart: charStart,
    _charEnd: charEnd,
  };
}

/**
 * Apply the registry's lexical observables to one exact UTF-8 blob (§3.4–3.5).
 * The few underspecified tokenization judgments are documented in NOTES.md.
 */
export function recognizeDocument({ path, blob, profile, bytes }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(bytes);
  const byteMap = buildByteMap(text);
  assert(byteMap[text.length] === bytes.length, `UTF-8 map length mismatch for ${path}`);
  const context = { path, blob, profile, bytes, text, byteMap };
  const occurrences = [];

  const packagePattern = /(?<![\p{L}\p{N}_-])plugin-([\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*)-v([0-9]+)\.([0-9]+)\.([0-9]+)(?![\p{L}\p{N}_-]|\.[0-9])/gu;
  const packageTags = matchAll(packagePattern, text).map((match) =>
    occurrenceFromMatch(context, 'package-tag', match, {
      package: state(match[1]),
      version: state(`${match[2]}.${match[3]}.${match[4]}`),
    }),
  );
  occurrences.push(...packageTags);

  const proofPattern = /(?<![\p{L}\p{N}_-])([\p{L}\p{N}][\p{L}\p{N}_-]*)-([0-9]{8})T([0-9]{6})Z-([0-9a-f]+)(?![\p{L}\p{N}_-])/gu;
  const proofRuns = matchAll(proofPattern, text).map((match) =>
    occurrenceFromMatch(context, 'proof-run-id', match, { kind: state(match[1]) }),
  );
  occurrences.push(...proofRuns);

  for (const match of matchAll(/[0-9a-f]+/g, text)) {
    const length = match[0].length;
    const start = match.index;
    const end = start + length;
    if (length > 40) {
      occurrences.push(
        occurrenceFromMatch(context, 'content-digest', match, {
          shape: state(contentDigestShape(text, start)),
        }),
      );
      continue;
    }
    if (length < 7) continue;
    const left = previousCodePoint(text, start);
    const right = nextCodePoint(text, end);
    if (left !== null && (ALNUM_RE.test(left) || left === '\u2026' || left === '-')) continue;
    if (right !== null && (ALNUM_RE.test(right) || right === '\u2026')) continue;
    occurrences.push(occurrenceFromMatch(context, 'commit-citation', match));
  }

  const prPattern = /#[0-9]{2,4}/g;
  for (const match of matchAll(prPattern, text)) {
    const end = match.index + match[0].length;
    const right = nextCodePoint(text, end);
    // Judgment: "terminated by a non-word character" requires an actual byte;
    // unlike the ISO-date rule, EOF is not named as a boundary.
    if (right === null || WORD_RE.test(right)) continue;
    occurrences.push(occurrenceFromMatch(context, 'pr-citation', match));
  }

  const isoPattern = /[0-9]{4}-[0-9]{2}-[0-9]{2}Z?/g;
  for (const match of matchAll(isoPattern, text)) {
    const start = match.index;
    const end = start + match[0].length;
    const left = previousCodePoint(text, start);
    const right = nextCodePoint(text, end);
    if (left !== null && WORD_RE.test(left)) continue;
    if (right !== null && WORD_RE.test(right)) continue;
    if (isInside(start, end, proofRuns)) continue;
    occurrences.push(occurrenceFromMatch(context, 'iso-date', match));
  }

  const semverPattern = /[0-9]+\.[0-9]+\.[0-9]+/g;
  for (const match of matchAll(semverPattern, text)) {
    const start = match.index;
    const end = start + match[0].length;
    const left = previousCodePoint(text, start);
    const right = nextCodePoint(text, end);
    if (left !== null && (WORD_RE.test(left) || left === '-' || left === '.')) continue;
    if (right !== null && (WORD_RE.test(right) || right === '-' || right === '.')) continue;
    if (isInside(start, end, packageTags)) continue;
    occurrences.push(occurrenceFromMatch(context, 'bare-semver', match));
  }

  occurrences.sort(compareOccurrences);
  return {
    path,
    blob,
    profile,
    bytes,
    text,
    byteMap,
    lines: makeLines(text),
    occurrences,
  };
}

function compareOccurrences(left, right) {
  return (
    compareStrings(left.path, right.path) ||
    left.start_byte - right.start_byte ||
    left.end_byte - right.end_byte ||
    compareStrings(left.family, right.family) ||
    compareStrings(left.profile, right.profile)
  );
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function wireOccurrence(occurrence) {
  const {
    _charStart: _discardedStart,
    _charEnd: _discardedEnd,
    ...wire
  } = occurrence;
  return wire;
}

function occurrencesInRange(occurrences, family, range) {
  return occurrences.filter(
    (occurrence) =>
      occurrence.family === family &&
      occurrence._charStart >= range.start &&
      occurrence._charEnd <= range.end,
  );
}

function labelsInRange(text, range, pattern) {
  const local = text.slice(range.start, range.end);
  return matchAll(pattern, local).map((match) => ({
    start: range.start + match.index,
    end: range.start + match.index + match[0].length,
  }));
}

function labeledCandidates(document, occurrences, range, family, pattern, maxGap) {
  const candidates = occurrencesInRange(occurrences, family, range);
  const labels = labelsInRange(document.text, range, pattern);
  return candidates.filter((candidate) =>
    labels.some(
      (label) => {
        if (label.end > candidate._charStart || candidate._charStart - label.end > maxGap) {
          return false;
        }
        // A label binds through Markdown wrappers and punctuation, not through
        // another word/token. This admits `release PR [#12]` and
        // `squash `abcdef0`` without letting a label capture every later
        // occurrence of the same family in the clause.
        const connector = document.text.slice(label.end, candidate._charStart);
        return /^[\s`*_"'\[\]{}():=<>/\\|,+\-–—]*$/u.test(connector);
      },
    ),
  );
}

function uniqueByPhysical(occurrences) {
  const byKey = new Map();
  for (const occurrence of occurrences) byKey.set(physicalKey(occurrence), occurrence);
  return [...byKey.values()];
}

export const POLICY_PARAMETERS = Object.freeze({
  'release-triple': Object.freeze({
    candidate_scope: 'smallest Markdown table-cell, list-item, or paragraph clause',
    clause_boundaries: 'semicolon unconditionally; .?! only before whitespace or clause end',
    code_fence_disposition: 'not-a-claim',
    fence_markers: 'three or more backticks or tildes',
    fence_line_start: 'optional whitespace followed by a fence marker',
    fence_close: 'same marker character; delimiter lines are fenced',
    fence_trailing_text: 'ignored for opening and closing detection',
    list_item_markers: '-|+|*|decimal followed by . or )',
    list_anchor_assignment: 'nearest preceding item marker since the last blank line',
    list_item_termination: 'blank line or next same-or-lower-indented item',
    paragraph_termination: 'blank line',
    table_cell_delimiter: 'literal vertical bar',
    table_row_start: 'first non-whitespace character is a vertical bar',
    lexical_matching_case: 'Unicode case-insensitive for labels and claim cues',
    label_gap_code_units: 96,
    label_connector_characters: 'whitespace ` * _ quotes [] {} () : = <> / backslash | , + - en-dash em-dash',
    release_pr_labels: 'release PR|release pull request|released as PR',
    claim_cues: 'released|published|cut|shipped',
    claim_cue_direction: 'preceding anchor in same structural clause',
    claim_cue_gap_code_units: 96,
    tag_labels: 'tag|tags',
    tag_list_gap_code_units: 192,
    tag_list_joiners: 'case-insensitive word and plus label-connector characters',
    squash_labels: 'squash|squash commit',
    marketplace_sync_labels: 'marketplace sync|marketplace sync commit',
    singleton_unlabelled_anchor_requires_labeled_release_pr: true,
    shared_role_identity_policy: 'ambiguous',
    zero_required_candidate_on_claim: 'incomplete',
    no_admitted_claim_predicate: 'not-a-claim',
  }),
  'proof-date-binding': Object.freeze({
    candidate_scope: 'smallest Markdown table-cell, list-item, or paragraph clause',
    clause_boundaries: 'semicolon unconditionally; .?! only before whitespace or clause end',
    code_fence_disposition: 'not-a-claim',
    fence_markers: 'three or more backticks or tildes',
    fence_line_start: 'optional whitespace followed by a fence marker',
    fence_close: 'same marker character; delimiter lines are fenced',
    fence_trailing_text: 'ignored for opening and closing detection',
    list_item_markers: '-|+|*|decimal followed by . or )',
    list_anchor_assignment: 'nearest preceding item marker since the last blank line',
    list_item_termination: 'blank line or next same-or-lower-indented item',
    paragraph_termination: 'blank line',
    table_cell_delimiter: 'literal vertical bar',
    table_row_start: 'first non-whitespace character is a vertical bar',
    lexical_matching_case: 'Unicode case-insensitive for connectors and claim cues',
    date_candidate_gap_code_units: 120,
    date_left_context_code_units: 32,
    date_after_anchor_connectors: "opening parenthesis '('|on|dated|date|recorded on|was recorded on",
    date_before_anchor_left_cues: 'on|dated|date',
    date_before_anchor_joiners: 'as|for|by; optional only when a left cue is present',
    date_connector_wrapper_characters: 'whitespace ` * _ quotes [] {} , : ; () - en-dash em-dash',
    table_cell_rule: 'every ISO date in the same semicolon/sentence-bounded cell clause is a candidate',
    claim_cues: 'recorded|proof|evidence|snapshot|run|current|historical|date',
    zero_date_candidate_on_claim: 'incomplete',
    no_admitted_claim_predicate: 'not-a-claim',
  }),
});

export function makePolicies(registry) {
  return registry.relations.map((relation) => {
    const declaration = {
      relation: relation.id,
      anchor_domain: {
        family: relation.anchor_domain.family,
        profile: relation.anchor_domain.profile,
        restriction: relation.anchor_domain.restriction,
      },
      class: 'markdown-lexical-construction-grammar',
      parameters: { ...POLICY_PARAMETERS[relation.id] },
      ranking: 'none; all candidates admitted by a construction remain unranked',
      tie_policy: 'ambiguous',
    };
    return { ...declaration, digest: declarationDigest(declaration) };
  });
}

function releaseTripleRow(anchor, document, documentOccurrences) {
  const clause = clauseFor(document, anchor);
  if (clause.fenced) {
    return { relation: 'release-triple', anchor: identity(anchor), disposition: 'not-a-claim', roles: {} };
  }

  const parameters = POLICY_PARAMETERS['release-triple'];
  const gap = parameters.label_gap_code_units;
  const anchors = occurrencesInRange(documentOccurrences, 'package-tag', clause);
  const releasePrs = uniqueByPhysical(
    labeledCandidates(
      document,
      documentOccurrences,
      clause,
      'pr-citation',
      /\b(?:release\s+(?:PR|pull\s+request)|released\s+as\s+PR)\b/giu,
      gap,
    ),
  );
  const tagLabels = labelsInRange(document.text, clause, /\btags?\b/giu);
  const explicitlyTagged = tagLabels.some((label) => {
    if (
      label.end > anchor._charStart ||
      anchor._charStart - label.end > parameters.tag_list_gap_code_units
    ) {
      return false;
    }
    let connector = document.text.slice(label.end, anchor._charStart);
    const interveningAnchors = anchors
      .filter(
        (candidate) =>
          candidate._charStart >= label.end && candidate._charEnd <= anchor._charStart,
      )
      .sort((left, right) => right._charStart - left._charStart);
    for (const intervening of interveningAnchors) {
      const start = intervening._charStart - label.end;
      const end = intervening._charEnd - label.end;
      connector = `${connector.slice(0, start)}${connector.slice(end)}`;
    }
    connector = connector.replace(/\band\b/giu, '');
    return /^[\s`*_"'\[\]{}():=<>/\\|,+\-–—]*$/u.test(connector);
  });
  const singletonConstruction = anchors.length === 1 && releasePrs.length > 0;
  const actionClaim = labelsInRange(
    document.text,
    clause,
    /\b(?:released|published|cut|shipped)\b/giu,
  ).some(
    (cue) =>
      cue.end <= anchor._charStart &&
      anchor._charStart - cue.end <= parameters.claim_cue_gap_code_units,
  );
  const isClaim = explicitlyTagged || singletonConstruction || actionClaim;

  if (!isClaim) {
    return { relation: 'release-triple', anchor: identity(anchor), disposition: 'not-a-claim', roles: {} };
  }

  const squash = uniqueByPhysical(
    labeledCandidates(
      document,
      documentOccurrences,
      clause,
      'commit-citation',
      /\bsquash(?:\s+commit)?\b/giu,
      gap,
    ),
  );
  const marketplace = uniqueByPhysical(
    labeledCandidates(
      document,
      documentOccurrences,
      clause,
      'commit-citation',
      /\bmarketplace\s+sync(?:\s+commit)?\b/giu,
      gap,
    ),
  );

  const optionalCollision = squash.some((left) =>
    marketplace.some((right) => physicalKey(left) === physicalKey(right)),
  );
  if (releasePrs.length > 1 || squash.length > 1 || marketplace.length > 1 || optionalCollision) {
    return { relation: 'release-triple', anchor: identity(anchor), disposition: 'ambiguous', roles: {} };
  }

  const roles = {};
  if (releasePrs.length === 1) roles.release_pr = identity(releasePrs[0]);
  if (squash.length === 1) roles.squash = identity(squash[0]);
  if (marketplace.length === 1) roles.marketplace_sync = identity(marketplace[0]);
  return {
    relation: 'release-triple',
    anchor: identity(anchor),
    disposition: releasePrs.length === 1 ? 'bound' : 'incomplete',
    roles,
  };
}

function proofDateRow(anchor, document, documentOccurrences) {
  const clause = clauseFor(document, anchor);
  if (clause.fenced) {
    return { relation: 'proof-date-binding', anchor: identity(anchor), disposition: 'not-a-claim', roles: {} };
  }

  const parameters = POLICY_PARAMETERS['proof-date-binding'];
  const datesInClause = occurrencesInRange(documentOccurrences, 'iso-date', clause);
  let candidates;
  if (clause.kind === 'table-cell-clause') {
    candidates = datesInClause;
  } else {
    candidates = datesInClause.filter((date) => {
      const left = anchor._charStart < date._charStart ? anchor : date;
      const right = left === anchor ? date : anchor;
      const connector = document.text.slice(left._charEnd, right._charStart);
      const distance = connector.length;
      if (distance > parameters.date_candidate_gap_code_units) return false;
      if (left === anchor) {
        return /^[\s`*_"'\[\]{},:;()\-–—]*(?:\(|(?:was\s+)?recorded\s+on\b|on\b|dated\b|date\b)[\s`*_"'\[\]{},:;()\-–—]*$/iu.test(connector);
      }
      const beforeDate = document.text.slice(
        Math.max(clause.start, date._charStart - parameters.date_left_context_code_units),
        date._charStart,
      );
      const wrappersOnlyOrJoin = /^[\s`*_"'\[\]{},:;()\-–—]*(?:(?:as|for|by)\b)?[\s`*_"'\[\]{},:;()\-–—]*$/iu;
      const explicitJoin = /^[\s`*_"'\[\]{},:;()\-–—]*(?:as|for|by)\b[\s`*_"'\[\]{},:;()\-–—]*$/iu;
      return (
        (/\b(?:on|dated|date)\s*$/iu.test(beforeDate) && wrappersOnlyOrJoin.test(connector)) ||
        explicitJoin.test(connector)
      );
    });
  }
  candidates = uniqueByPhysical(candidates);

  if (candidates.length > 1) {
    return { relation: 'proof-date-binding', anchor: identity(anchor), disposition: 'ambiguous', roles: {} };
  }
  if (candidates.length === 1) {
    return {
      relation: 'proof-date-binding',
      anchor: identity(anchor),
      disposition: 'bound',
      roles: { date: identity(candidates[0]) },
    };
  }

  const withoutAnchor =
    document.text.slice(clause.start, anchor._charStart) +
    document.text.slice(anchor._charEnd, clause.end);
  const claimCue = /\b(?:recorded|proof|evidence|snapshot|run|current|historical|date)\b/iu.test(withoutAnchor);
  return {
    relation: 'proof-date-binding',
    anchor: identity(anchor),
    disposition: claimCue ? 'incomplete' : 'not-a-claim',
    roles: {},
  };
}

/** Contract §4.3 total rows over each registry-declared anchor domain. */
export function makeAnchors(registry, documents) {
  const rows = [];
  for (const relation of registry.relations) {
    const anchorFamily = relation.anchor_domain.family;
    const profile = relation.anchor_domain.profile;
    for (const document of documents.values()) {
      if (document.profile !== profile) continue;
      for (const anchor of document.occurrences.filter((item) => item.family === anchorFamily)) {
        if (relation.id === 'release-triple') {
          rows.push(releaseTripleRow(anchor, document, document.occurrences));
        } else if (relation.id === 'proof-date-binding') {
          rows.push(proofDateRow(anchor, document, document.occurrences));
        } else {
          throw new Error(`no lane policy implementation for relation ${relation.id}`);
        }
      }
    }
  }
  rows.sort(
    (left, right) =>
      compareStrings(left.relation, right.relation) ||
      compareStrings(left.anchor.path, right.anchor.path) ||
      left.anchor.start_byte - right.anchor.start_byte ||
      left.anchor.end_byte - right.anchor.end_byte,
  );
  return rows;
}

function jsonPointerResolve(root, reference) {
  assert(reference.startsWith('#/'), `only local JSON Schema references are supported: ${reference}`);
  let current = root;
  for (const rawPart of reference.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    assert(current && Object.hasOwn(current, part), `unresolvable JSON Schema reference ${reference}`);
    current = current[part];
  }
  return current;
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    case 'integer': return Number.isFinite(value) && Number.isInteger(value);
    case 'number': return Number.isFinite(value) && typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: throw new Error(`unsupported JSON Schema type ${type}`);
  }
}

function schemaEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateSchemaNode(value, node, root, instancePath, errors) {
  assert(isPlainObject(node), `invalid JSON Schema node at ${instancePath}`);
  for (const keyword of Object.keys(node)) {
    assert(
      JSON_SCHEMA_ANNOTATIONS.has(keyword) || JSON_SCHEMA_ASSERTIONS.has(keyword),
      `unsupported JSON Schema keyword ${keyword}`,
    );
  }
  if (node.$ref) {
    validateSchemaNode(value, jsonPointerResolve(root, node.$ref), root, instancePath, errors);
    return;
  }

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      errors.push(`${instancePath}: expected type ${types.join('|')}`);
      return;
    }
  }
  if (node.const !== undefined && !schemaEqual(value, node.const)) {
    errors.push(`${instancePath}: value does not equal const`);
  }
  if (node.enum && !node.enum.some((candidate) => schemaEqual(value, candidate))) {
    errors.push(`${instancePath}: value is outside enum`);
  }
  if (typeof value === 'string') {
    if (node.pattern && !new RegExp(node.pattern, 'u').test(value)) {
      errors.push(`${instancePath}: string does not match ${node.pattern}`);
    }
    if (node.minLength !== undefined && [...value].length < node.minLength) {
      errors.push(`${instancePath}: string is shorter than ${node.minLength}`);
    }
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${instancePath}: number is below ${node.minimum}`);
  }
  if (Array.isArray(value) && node.items) {
    value.forEach((member, index) =>
      validateSchemaNode(member, node.items, root, `${instancePath}/${index}`, errors),
    );
  }
  if (isPlainObject(value)) {
    const properties = node.properties ?? {};
    for (const required of node.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${instancePath}: missing required key ${required}`);
    }
    for (const [key, member] of Object.entries(value)) {
      const childPath = `${instancePath}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (Object.hasOwn(properties, key)) {
        validateSchemaNode(member, properties[key], root, childPath, errors);
      } else if (node.additionalProperties === false) {
        errors.push(`${childPath}: additional property is forbidden`);
      } else if (isPlainObject(node.additionalProperties)) {
        validateSchemaNode(member, node.additionalProperties, root, childPath, errors);
      }
    }
  }
}

/** Validate the exact subset of Draft 2020-12 used by the sealed schema (§3.8). */
export function validateAgainstSchema(value, schema) {
  const errors = [];
  validateSchemaNode(value, schema, schema, '$', errors);
  return errors;
}

function safeManifestPath(manifestPath) {
  return (
    manifestPath.length > 0 &&
    !manifestPath.startsWith('/') &&
    !manifestPath.startsWith('bundle/') &&
    posix.normalize(manifestPath) === manifestPath &&
    !manifestPath.split('/').includes('..')
  );
}

async function loadInputs(bundleRoot = BUNDLE_ROOT) {
  const byteEntries = await Promise.all(
    BUNDLE_MEMBERS.map(async (memberPath) => [memberPath, await readFile(join(bundleRoot, memberPath))]),
  );
  const memberBytes = new Map(byteEntries);
  const parse = (memberPath) => JSON.parse(memberBytes.get(memberPath).toString('utf8'));
  const registry = parse(INPUT_PATHS.registry);
  const manifest = parse(INPUT_PATHS.manifest);
  const schema = parse(INPUT_PATHS.schema);
  const delivery = JSON.parse(await readFile(join(bundleRoot, 'bundle-manifest.json'), 'utf8'));
  return { memberBytes, registry, manifest, schema, delivery };
}

async function verifyAndReadCorpus(manifest, bundleRoot = BUNDLE_ROOT) {
  const pathEntries = new Map();
  for (const [profile, profileDeclaration] of Object.entries(manifest.profiles)) {
    for (const entry of profileDeclaration.files) {
      assert(safeManifestPath(entry.path), `unsafe or rewritten manifest path ${entry.path}`);
      const existing = pathEntries.get(entry.path);
      if (existing) {
        assert(existing.blob === entry.blob, `profile blob mismatch for ${entry.path}`);
        assert(existing.bytes === entry.bytes, `profile byte-count mismatch for ${entry.path}`);
        existing.profiles.add(profile);
      } else {
        pathEntries.set(entry.path, { ...entry, profiles: new Set([profile]) });
      }
    }
  }

  const results = await Promise.all(
    [...pathEntries.values()].map(async (entry) => {
      const bytes = await readFile(join(bundleRoot, entry.path));
      assert(bytes.length === entry.bytes, `byte count mismatch for ${entry.path}`);
      assert(gitBlobOid(bytes) === entry.blob, `Git blob mismatch for ${entry.path}`);
      // Judgment forced by the scalar wire field and overlapping profiles:
      // stage-docs wins so relation anchors carry their relation profile.
      const profile = entry.profiles.has('stage-docs') ? 'stage-docs' : 'discovered-md';
      return recognizeDocument({ path: entry.path, blob: entry.blob, profile, bytes });
    }),
  );
  return new Map(results.map((document) => [document.path, document]));
}

function manifestMembership(manifest) {
  const membership = new Map();
  for (const [profile, declaration] of Object.entries(manifest.profiles)) {
    for (const entry of declaration.files) membership.set(`${profile}\0${entry.path}`, entry);
  }
  return membership;
}

function validateFieldValues(occurrence, family) {
  const declaredFields = new Map(family.fields.map((field) => [field.name, field]));
  for (const [name, fieldValue] of Object.entries(occurrence.fields ?? {})) {
    assert(declaredFields.has(name), `undeclared field ${name} on ${occurrence.family}`);
    const declaration = declaredFields.get(name);
    assert(declaration.states.includes(fieldValue.state), `invalid state for ${occurrence.family}.${name}`);
    assert(
      fieldValue.state === 'present' ? Object.hasOwn(fieldValue, 'value') : !Object.hasOwn(fieldValue, 'value'),
      `field value/state mismatch for ${occurrence.family}.${name}`,
    );
    if (declaration.vocabulary && fieldValue.state === 'present') {
      assert(declaration.vocabulary.includes(fieldValue.value), `invalid vocabulary for ${occurrence.family}.${name}`);
    }
  }
  for (const declaration of family.fields) {
    if (declaration.authority) continue;
    assert(Object.hasOwn(occurrence.fields ?? {}, declaration.name), `missing field ${occurrence.family}.${declaration.name}`);
  }
}

/** Semantic checks that the schema cannot express (§3.8, §8.2). */
export function validateArtifactSemantics(artifact, { manifest, registry, documents, bundleDigest }) {
  assert(artifact.contract_version === registry.contract_version, 'artifact contract version mismatch');
  assert(artifact.role === 'lane', 'lane exporter emitted a non-lane role');
  assert(artifact.artifact_only_scope === 'out-of-scope', 'clean-room artifact-only scope must be out-of-scope');
  assert(artifact.bundle_digest === bundleDigest, 'artifact bundle digest mismatch');
  assert(artifact.manifest_digest === manifest.digest, 'artifact manifest digest mismatch');
  assert(artifact.corpus_commit === manifest.commit, 'artifact corpus commit mismatch');
  assert(artifact.attestation.contract_version === artifact.contract_version, 'attestation contract mismatch');
  assert(artifact.attestation.bundle_digest === artifact.bundle_digest, 'attestation bundle mismatch');
  assert(artifact.attestation.manifest_digest === artifact.manifest_digest, 'attestation manifest mismatch');
  assert(artifact.attestation.artifact_digest === artifactDigest(artifact), 'attestation artifact digest mismatch');

  const membership = manifestMembership(manifest);
  const familyById = new Map(registry.families.map((family) => [family.id, family]));
  const seenOccurrences = new Set();
  const occurrenceByFamilyIdentity = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const occurrence of artifact.occurrences) {
    assert(familyById.has(occurrence.family), `unknown family ${occurrence.family}`);
    const family = familyById.get(occurrence.family);
    assert(family.profiles.includes(occurrence.profile), `family/profile mismatch for ${occurrence.family}`);
    const member = membership.get(`${occurrence.profile}\0${occurrence.path}`);
    assert(member, `occurrence outside profile: ${occurrence.profile}:${occurrence.path}`);
    assert(member.blob === occurrence.blob, `occurrence blob mismatch for ${occurrence.path}`);
    const document = documents.get(occurrence.path);
    assert(document, `occurrence path unavailable ${occurrence.path}`);
    assert(occurrence.start_byte < occurrence.end_byte, `empty/reversed span in ${occurrence.path}`);
    assert(occurrence.end_byte <= document.bytes.length, `span outside blob in ${occurrence.path}`);
    const decoded = decoder.decode(document.bytes.subarray(occurrence.start_byte, occurrence.end_byte));
    assert(decoded === occurrence.literal, `span does not round-trip in ${occurrence.path}`);
    const key = familyPhysicalKey(occurrence);
    assert(!seenOccurrences.has(key), `duplicate same-family physical occurrence ${key}`);
    seenOccurrences.add(key);
    occurrenceByFamilyIdentity.set(key, occurrence);
    validateFieldValues(occurrence, family);
  }

  assert(artifact.policies.length === registry.relations.length, 'policy count does not match relations');
  const policiesByRelation = new Map();
  for (const policy of artifact.policies) {
    assert(!policiesByRelation.has(policy.relation), `duplicate policy ${policy.relation}`);
    policiesByRelation.set(policy.relation, policy);
    assert(policy.digest === declarationDigest(policy), `policy digest mismatch for ${policy.relation}`);
    for (const value of Object.values(policy.parameters)) {
      assert(value === null || ['string', 'number', 'boolean'].includes(typeof value), 'policy parameters must be flat scalars');
    }
  }

  const rowsByRelationAndAnchor = new Map();
  for (const row of artifact.anchors) {
    const relation = registry.relations.find((item) => item.id === row.relation);
    assert(relation, `unknown relation ${row.relation}`);
    const rowKey = `${row.relation}\0${physicalKey(row.anchor)}`;
    assert(!rowsByRelationAndAnchor.has(rowKey), `duplicate anchor row ${rowKey}`);
    rowsByRelationAndAnchor.set(rowKey, row);
    const roles = new Map(relation.roles.map((role) => [role.name, role]));
    assert(!Object.hasOwn(row.roles, relation.anchor_role), `anchor role repeated for ${row.relation}`);
    for (const [roleName, roleIdentity] of Object.entries(row.roles)) {
      assert(roles.has(roleName), `unknown role ${row.relation}.${roleName}`);
      const role = roles.get(roleName);
      assert(roleName !== relation.anchor_role, `anchor role repeated for ${row.relation}`);
      const occurrenceKey = `${role.family}\0${physicalKey(roleIdentity)}`;
      assert(occurrenceByFamilyIdentity.has(occurrenceKey), `role identity absent from inventory: ${row.relation}.${roleName}`);
    }
    const requiredNonAnchor = relation.roles.filter(
      (role) => role.required && role.name !== relation.anchor_role,
    );
    const allRequiredFilled = requiredNonAnchor.every((role) => Object.hasOwn(row.roles, role.name));
    if (row.disposition === 'bound') assert(allRequiredFilled, `bound row missing required role ${rowKey}`);
    if (row.disposition === 'incomplete') assert(!allRequiredFilled, `incomplete row fills every required role ${rowKey}`);
    if (row.disposition === 'not-a-claim') assert(Object.keys(row.roles).length === 0, `not-a-claim row fills a role ${rowKey}`);
  }

  for (const relation of registry.relations) {
    const policy = policiesByRelation.get(relation.id);
    assert(policy, `missing policy ${relation.id}`);
    assert(schemaEqual(policy.anchor_domain, {
      family: relation.anchor_domain.family,
      profile: relation.anchor_domain.profile,
      restriction: relation.anchor_domain.restriction,
    }), `policy anchor domain mismatch for ${relation.id}`);
    const anchors = artifact.occurrences.filter(
      (occurrence) =>
        occurrence.family === relation.anchor_domain.family &&
        occurrence.profile === relation.anchor_domain.profile,
    );
    for (const anchor of anchors) {
      const key = `${relation.id}\0${physicalKey(anchor)}`;
      assert(rowsByRelationAndAnchor.has(key), `missing anchor row ${key}`);
    }
    const relationRows = artifact.anchors.filter((row) => row.relation === relation.id);
    assert(relationRows.length === anchors.length, `anchor total mismatch for ${relation.id}`);
  }
}

export async function buildArtifact({ bundleRoot = BUNDLE_ROOT, sealedAt = new Date() } = {}) {
  const { memberBytes, registry, manifest, schema, delivery } = await loadInputs(bundleRoot);
  const { digest: recordedManifestDigest, ...manifestWithoutDigest } = manifest;
  const computedManifestDigest = sha256(Buffer.from(canonicalJson(manifestWithoutDigest), 'utf8'));
  assert(computedManifestDigest === recordedManifestDigest, 'manifest self-digest does not verify');

  const bundleDigest = computeBundleDigest(memberBytes);
  assert(bundleDigest === delivery.bundle_digest, 'computed bundle digest disagrees with recorded delivery seal');
  assert(delivery.manifest_digest === manifest.digest, 'delivery manifest digest mismatch');
  assert(delivery.corpus_commit === manifest.commit, 'delivery corpus commit mismatch');
  assert(delivery.contract_version === registry.contract_version, 'delivery contract version mismatch');

  const documents = await verifyAndReadCorpus(manifest, bundleRoot);
  const occurrences = [...documents.values()]
    .flatMap((document) => document.occurrences)
    .sort(compareOccurrences)
    .map(wireOccurrence);
  const policies = makePolicies(registry);
  const anchors = makeAnchors(registry, documents);

  const artifact = {
    schema: 'evidence-measurement-artifact-1.0',
    contract_version: registry.contract_version,
    role: 'lane',
    artifact_id: 'lane-s1-markdown-lexical-grammar-v1',
    artifact_only_scope: 'out-of-scope',
    bundle_digest: bundleDigest,
    manifest_digest: manifest.digest,
    corpus_commit: manifest.commit,
    policies,
    occurrences,
    anchors,
  };
  artifact.attestation = {
    contract_version: artifact.contract_version,
    bundle_digest: artifact.bundle_digest,
    manifest_digest: artifact.manifest_digest,
    artifact_digest: artifactDigest(artifact),
    sealed_at: sealedAt.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    // TASK.md was required reading and is outside bundle/. It is named here
    // under the user's stricter reporting instruction even though it is the
    // task brief, not one of contract §11.2's prohibited measurement inputs.
    prohibited_inputs_accessed: ['TASK.md'],
  };

  const schemaErrors = validateAgainstSchema(artifact, schema);
  assert(schemaErrors.length === 0, `artifact schema validation failed:\n${schemaErrors.join('\n')}`);
  validateArtifactSemantics(artifact, { manifest, registry, documents, bundleDigest });
  return { artifact, schema, manifest, registry, documents, bundleDigest };
}

export async function main() {
  const { artifact } = await buildArtifact();
  await writeFile(join(OUT_DIR, 'artifact.json'), canonicalJson(artifact), 'utf8');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
