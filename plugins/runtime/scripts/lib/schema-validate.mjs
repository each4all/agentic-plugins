// plugins/runtime/scripts/lib/schema-validate.mjs
//
// The zero-dependency JSON Schema validator for the packaged runtime schemas:
// the three bootstrap families (machine-bootstrap-contract.md §4, §5, §1.4;
// ADR-0046 §4) and the three ADR-0044 session-capture families
// (session-capture-contract.md §3). Ships as
// runtime code, so it obeys the same zero-dependency rule as every other runtime
// script — `ajv` is not available to us, and the ADR-0035 §4 guard deferral
// decision (2026-06-11, converged) keeps tests-only devDependencies out of the
// shipped path entirely.
//
// SUPPORTED SUBSET, and why the list is closed. This validator implements exactly
// the keywords the three schemas use. Any OTHER keyword — including a misspelled
// one — is a validation ERROR against the schema itself, never a no-op. That
// choice is the whole point: an ignored keyword is a constraint that silently does
// not apply, so `maxitems: 256` would read as "capped" while capping nothing, and
// the schema would be a comment with a colon in it. This repo has shipped that bug
// before in other guards; here the failure is loud.
//
//   type · enum · const · properties · required · additionalProperties (false only)
//   patternProperties · items · maxItems · minItems · maxLength · pattern
//   $ref (internal, `#/$defs/<name>`) · $defs · description/title/$schema/$id (annotations)
//
// NOT supported, deliberately: oneOf/anyOf/allOf/not, dependencies, if/then/else,
// numeric bounds, uniqueItems, format. None of the three schemas needs them, and a
// half-implemented combinator is worse than an absent one. `type: [..]` unions cover
// the nullable cases.
//
// THE FORWARD-COMPAT MINOR RULE (§4.1) lives here rather than in the schema data,
// because it is a rule ABOUT the schema string, not a constraint the schema can
// express about itself:
//
//   * unknown MAJOR                → rejected (test #18); the reader cannot know what
//                                    the shape means, and guessing is how a silent
//                                    misread becomes a wrong machine.
//   * unknown key, non-scalar value → ALWAYS rejected, at any depth, any minor. A new
//                                    object/array key carries structure whose meaning
//                                    we would be dropping on the floor.
//   * unknown key, scalar value     → rejected on a same-or-older minor (it has no
//                                    excuse), IGNORED WITH A WARNING when the file's
//                                    minor is greater than the reader's. That is the
//                                    additive-forward-compat posture engineer's state
//                                    reader already uses, and it is why the schema
//                                    string carries a minor (`-1.0`) at all.
//
// CANONICAL ORDER (§4.1) is not a JSON Schema concept, so it is not invented as one:
// `canonicalize()` derives it from the ORDER OF `properties` IN THE SCHEMA FILE.
// JSON object key order is insertion-ordered for string keys in both JSON.parse and
// JSON.stringify, so the schema data is already the canonical order — one source,
// with no second list to drift from it.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { resolveContained } from './path-containment.mjs';

// The keyword allowlist. Splitting constraints from annotations matters: an
// annotation may appear anywhere and constrains nothing; a constraint MUST be
// implemented below or the schema is rejected.
const SUPPORTED_CONSTRAINTS = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'patternProperties', 'items', 'maxItems', 'minItems', 'maxLength', 'pattern', '$ref',
]);
const SCHEMA_ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description', 'examples']);

const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

export const SCHEMA_MAX_BYTES = 64 * 1024;
export const SCHEMA_MAX_ARRAY_ENTRIES = 256;

// ---------------------------------------------------------------------------
// THE DISCLOSURE INVARIANT (D1, ratified 2026-08-02)
// ---------------------------------------------------------------------------
//
// A value crosses the artifact → report boundary IFF the packaged schema
// GRAMMAR-CLAMPS it — an anchored `pattern`, an `enum`, a `const`, a boolean, or
// a number. Everything else leaves as its TYPE, its LENGTH, or its ORDINAL,
// never as its content.
//
// A validation finding is the hardest case for that rule, because a finding
// exists precisely BECAUSE the observed value escaped its clamp: the slot said
// `enum`, the document supplied something else, so the observed value is by
// definition unclamped. That is why a finding carries the EXPECTED constraint
// (read from the trusted packaged schema) and only the observed TYPE plus
// numeric metadata — never the observed scalar itself, at any type.
//
// So a finding MAY carry:
//   * a runtime-authored code and severity (this file writes both);
//   * the expected constraint from the packaged schema — type, enum members,
//     const, pattern source, bounds;
//   * the observed type name and numeric metadata — string length, member
//     count, entry count, byte size;
//   * a locator built ONLY from the root `$`, schema-DECLARED property names,
//     zero-based array indices, and a zero-based `member[n]` ordinal standing
//     in for any document-supplied key.
//
// And it MAY NOT carry: any observed scalar value or serialized fragment; any
// document-supplied key name; the document's own `schema` string; raw
// JSON.parse/exception text that can quote input; or a hash of a withheld value
// (equality-and-guessing leakage that does not help repair).
//
// Why HERE and not at the sinks: sink redaction was tried at this boundary and
// withdrawn on measurement — a generic 32+-hex rule ate a legitimate 64-hex plan
// hash, and `--format json` stayed exposed anyway. The root is a CLASSIFICATION
// question, not a redaction one. Binding the answer to the schema's own grammar
// clamping makes the rule mechanical, auditable against the schema file, and
// self-maintaining: a new clamped field becomes disclosable automatically and a
// new maxLength-only field is withheld automatically, with no category list for
// anyone to keep current.
//
// The threat model is moderate ACCIDENTAL disclosure: the operator (or a process
// running as them) writes a secret into a private 0600 artifact, and the report
// then travels to terminal capture, CI logs, clipboards, machine consumers, or
// an agent's context. This boundary protects that artifact → stdout transition.
// It does not defend against an adversary who already owns the account — reading
// the private artifact directly is the escape hatch, and it is deliberately not
// a flag.

// Display bounds. Findings are capped so a hostile or merely large document
// cannot flood a report: measurement on a 62,969-byte future-minor document with
// 4,000 unknown scalar keys produced 4,001 warnings / 643,305 characters (~10x
// amplification) before these caps existed.
export const FINDING_MAX_BYTES = 512;
export const FINDINGS_MAX_PER_ARTIFACT = 16;

// Bound ONE finding at 512 UTF-8 bytes. Truncation walks code POINTS, so a
// surrogate pair is never split into a lone half that renders as U+FFFD —
// sanitizing text into mojibake is its own small dishonesty.
function capFinding(text) {
  if (Buffer.byteLength(text, 'utf8') <= FINDING_MAX_BYTES) return text;
  const budget = FINDING_MAX_BYTES - Buffer.byteLength('…', 'utf8');
  let bytes = 0;
  let out = '';
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    out += point;
  }
  return `${out}…`;
}

// Every finding is `<locator>: [<severity>/<code>] <content-free detail>`. The
// severity rides INSIDE the string rather than being left implicit in which
// array the finding landed in, because consumers merge errors and warnings into
// one `diagnostics` list and the distinction would not survive the merge.
function finding(severity, code, locator, detail) {
  return capFinding(`${locator}: [${severity}/${code}] ${detail}`);
}

// The observed side of every finding: a type name plus numeric metadata, and
// never a value. `null` and `boolean` carry no metadata because their type name
// already says everything a repair needs — and a boolean's two states are not
// disclosed, because a value that reached a finding is by definition one the
// schema did not clamp.
function observe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array (${value.length} entries)`;
  if (isPlainObject(value)) return `object (${Object.keys(value).length} members)`;
  if (typeof value === 'string') return `string (length ${value.length})`;
  return typeof value;
}

// Apply the per-artifact display cap. Validation itself already ran to
// completion, so the ok/not-ok verdict is computed from the FULL count and a
// suppressed finding can never flip it.
function capFindings(findings) {
  return findings.length <= FINDINGS_MAX_PER_ARTIFACT ? findings : findings.slice(0, FINDINGS_MAX_PER_ARTIFACT);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A scalar for the unknown-key rule: string/number/boolean/null. An ARRAY is not a
// scalar — it is structure, and the §4.1 rule turns on structure-vs-value, not on
// "is it typeof object".
function isScalar(value) {
  return value === null || SCALAR_TYPES.has(typeof value);
}

// ---------------------------------------------------------------------------
// Schema version parsing
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_RE = /^([a-z0-9-]+)-(\d+)\.(\d+)$/;

// `agentic-machine-profile-1.0` → { family, major, minor }. Returns null for a
// string that is not a schema version at all, which callers treat as invalid rather
// than as version 0.
export function parseSchemaVersion(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(SCHEMA_VERSION_RE);
  if (!m) return null;
  return { family: m[1], major: Number(m[2]), minor: Number(m[3]), version: value };
}

// Compare a document's declared schema against the reader's. Returns a verdict the
// caller branches on rather than a boolean — "reject" and "accept but ignore unknown
// scalars" are different outcomes and collapsing them is how a forward-compat
// posture becomes a silent data loss.
export function compareSchemaVersion(documentVersion, readerVersion) {
  const doc = parseSchemaVersion(documentVersion);
  const reader = parseSchemaVersion(readerVersion);
  if (reader === null) throw new Error(`reader schema version '${readerVersion}' is not a valid schema version`);
  // The document's own `schema` string is UNCLAMPED free content the moment it
  // fails to parse or names a foreign family — `[a-z0-9-]+` accepts a
  // lowercase credential just as happily as a family name. So neither branch
  // echoes it: the finding reports that it did not parse (or did not match),
  // plus the EXPECTED shape, which is the reader's own trusted string.
  if (doc === null) {
    return { ok: false, reason: 'unparseable', code: 'schema-version-unparseable', allowUnknownScalars: false, message: 'the document declares no recognizable schema version (expected <family>-<major>.<minor>); the declared value is withheld because an unparseable version string is unclamped free content' };
  }
  if (doc.family !== reader.family) {
    return { ok: false, reason: 'wrong-family', code: 'schema-family-mismatch', allowUnknownScalars: false, message: `the document's schema family does not match the expected '${reader.family}'; the declared family is withheld because a family that did not match is not clamped by anything this runtime trusts` };
  }
  if (doc.major !== reader.major) {
    // The major NUMBER crosses: it parsed out of `(\d+)` and the family already
    // matched the reader's, so what is disclosed is a digit sequence in a slot
    // this runtime itself defined — and the operator cannot act on "a major you
    // may not see".
    return {
      ok: false,
      reason: 'unknown-major',
      code: 'schema-major-unreadable',
      allowUnknownScalars: false,
      message: `schema major ${doc.major} is not readable by this runtime (expects major ${reader.major}). A major means the shape changed; upgrade the runtime plugin rather than reading it as if it had not.`,
    };
  }
  // A GREATER minor is the only case that earns the benefit of the doubt, and only
  // for additive scalars (§4.1).
  return {
    ok: true,
    reason: doc.minor > reader.minor ? 'newer-minor' : 'compatible',
    code: null,
    allowUnknownScalars: doc.minor > reader.minor,
    message: null,
    // The parsed MINORS, not the version strings. Past this point family and
    // major are pinned to the reader's own values, so the minor is the only
    // document-supplied part left — and it is a number, which crosses.
    documentMinor: doc.minor,
    readerMinor: reader.minor,
  };
}

// ---------------------------------------------------------------------------
// Schema self-check — the schema is data, so it is validated too
// ---------------------------------------------------------------------------

// Walk the schema and reject any keyword this validator does not implement. Runs
// before every validation (and is asserted directly in tests), so a schema file can
// never quietly carry a constraint that does nothing.
export function assertSupportedSchema(schema, path = '#') {
  const errors = [];
  if (!isPlainObject(schema)) {
    errors.push(`${path}: schema node must be an object`);
    return errors;
  }
  for (const key of Object.keys(schema)) {
    if (SCHEMA_ANNOTATIONS.has(key) || SUPPORTED_CONSTRAINTS.has(key)) continue;
    errors.push(`${path}: unsupported schema keyword '${key}' — this validator implements a closed subset, and an unimplemented keyword would be a constraint that silently does not apply`);
  }
  if ('additionalProperties' in schema && schema.additionalProperties !== false) {
    errors.push(`${path}: additionalProperties must be false (the closed-schema rule); true/schema forms are not supported`);
  }

  // A `$ref` with SIBLING constraints. In 2020-12 the siblings apply alongside the
  // ref; this validator delegates wholly to the target and would DISCARD them, so
  // `{ $ref: '#/$defs/s', maxLength: 1 }` would silently enforce no maxLength.
  // Rejected rather than half-implemented.
  if (schema.$ref !== undefined) {
    const siblings = Object.keys(schema).filter((k) => k !== '$ref' && !SCHEMA_ANNOTATIONS.has(k));
    if (siblings.length > 0) {
      errors.push(`${path}: $ref carries sibling constraint(s) [${siblings.join(', ')}] — this validator delegates entirely to the ref target, so a sibling would be silently discarded. Inline the constraint or extend the $def.`);
    }
  }

  // The CLOSED-SCHEMA RULE, enforced on the schema itself. An object schema that
  // simply omits `additionalProperties` is OPEN by JSON Schema default — so §4.1's
  // "unknown object keys fail validation at any depth, ALWAYS" would quietly not hold
  // for that node. The rule has to be structural, not a habit of whoever wrote the file.
  const declaresObject = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
  if (declaresObject && schema.additionalProperties !== false) {
    errors.push(`${path}: an object schema must declare additionalProperties:false — the §4.1 closed-schema rule applies at every depth, and an omitted declaration leaves this node open`);
  }

  // `required` needs somewhere for the names to be required FROM.
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) errors.push(`${path}: required must be an array`);
    else if (!declaresObject) errors.push(`${path}: required is declared on a node that is not typed as an object, where it would never be evaluated`);
  }

  // A property name that ALSO matches a patternProperty: 2020-12 applies both. This
  // validator applies both too (see validateNode), but a collision is almost always an
  // authoring mistake, so it is surfaced rather than silently double-checked.
  for (const name of Object.keys(schema.properties ?? {})) {
    for (const re of Object.keys(schema.patternProperties ?? {})) {
      if (new RegExp(re).test(name)) {
        errors.push(`${path}: property '${name}' also matches patternProperties '${re}' — both would apply; make the pattern exclusive or drop the property`);
      }
    }
  }

  // Every `pattern` must be ANCHORED. JSON Schema `pattern` is a SUBSTRING match:
  // `[0-9]{6}` accepts "zzz123456zzz". An unanchored pattern in a security-relevant
  // schema is a validation that looks strict and is not.
  for (const key of ['pattern']) {
    const value = schema[key];
    if (typeof value === 'string' && !(value.startsWith('^') && value.endsWith('$'))) {
      errors.push(`${path}: pattern '${value}' is not anchored (^...$) — JSON Schema patterns are substring matches, so an unanchored one accepts anything that merely contains a match`);
    }
  }

  for (const [name, sub] of Object.entries(schema.$defs ?? {})) errors.push(...assertSupportedSchema(sub, `${path}/$defs/${name}`));
  for (const [name, sub] of Object.entries(schema.properties ?? {})) errors.push(...assertSupportedSchema(sub, `${path}/properties/${name}`));
  for (const [name, sub] of Object.entries(schema.patternProperties ?? {})) errors.push(...assertSupportedSchema(sub, `${path}/patternProperties/${name}`));
  if (schema.items !== undefined) errors.push(...assertSupportedSchema(schema.items, `${path}/items`));
  return errors;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// `ref` is read from the packaged schema, not from the document, so naming it
// discloses only what the schema file already publishes.
function resolveRef(ref, root, path, errors) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m) {
    errors.push(finding('error', 'ref-unsupported', path, `only internal '#/$defs/<name>' refs are supported, got '${ref}'`));
    return null;
  }
  const target = Object.hasOwn(root.$defs ?? {}, m[1]) ? root.$defs[m[1]] : undefined;
  if (!target) {
    errors.push(finding('error', 'ref-unresolved', path, `$ref '${ref}' does not resolve`));
    return null;
  }
  return target;
}

function typeMatches(value, type) {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    /* c8 ignore next */
    default: return false;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode({ value, schema, root, path, ctx }) {
  const errors = ctx.errors;
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root, path, errors);
    if (target) validateNode({ value, schema: target, root, path, ctx });
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(finding('error', 'type-mismatch', path, `expected ${types.join(' | ')}, got ${describe(value)}`));
      return; // Every other check below assumes the type held.
    }
  }
  // const / enum / pattern are the three ordinary constraint branches, and all
  // three used to echo the OBSERVED value. The expected side stays — it is read
  // from the trusted packaged schema and is the whole of what a repair needs —
  // while the observed side collapses to a type name plus numeric metadata.
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(finding('error', 'const-mismatch', path, `must equal ${JSON.stringify(schema.const)}; observed ${observe(value)}`));
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(finding('error', 'enum-mismatch', path, `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}; observed ${observe(value)}`));
  }
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(finding('error', 'pattern-mismatch', path, `must match ${schema.pattern}; observed ${observe(value)}`));
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(finding('error', 'max-length-exceeded', path, `string length ${value.length} exceeds maxLength ${schema.maxLength}`));
  }

  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      // Refused, never truncated (§4.1): a silently truncated permission list is a
      // security artifact, not a convenience.
      errors.push(finding('error', 'max-items-exceeded', path, `${value.length} entries exceeds maxItems ${schema.maxItems} — the artifact is refused, not truncated`));
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(finding('error', 'min-items-unmet', path, `${value.length} entries is below minItems ${schema.minItems}`));
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode({ value: item, schema: schema.items, root, path: `${path}[${i}]`, ctx }));
    }
  }

  // `required` is evaluated for ANY object value — not only when some other object
  // keyword happens to be present. Gating it on a sibling made `{type:'object',
  // required:['a']}` enforce nothing at all: a required list that requires nothing.
  if (isPlainObject(value)) {
    for (const name of schema.required ?? []) {
      // `name` is read from the SCHEMA's own required list, never from the
      // document — a required key that is missing has no document-supplied
      // spelling to leak.
      if (!Object.hasOwn(value, name)) errors.push(finding('error', 'missing-required-key', path, `missing required key '${name}'`));
    }
  }

  if (isPlainObject(value) && (schema.properties || schema.patternProperties || schema.additionalProperties === false)) {
    let ordinal = -1;
    for (const [key, child] of Object.entries(value)) {
      ordinal += 1;
      // The locator for a DOCUMENT-SUPPLIED key. A key that resolves through
      // `properties` is schema-declared and may be named; every other key —
      // a patternProperties match, an unknown key — is free content, and
      // `${path}.${key}` was itself a leak: a document whose key is
      // `Bearer sk-…` published that key into the finding while the finding was
      // busy not publishing the value. The zero-based ordinal locates the member
      // just as well without naming it.
      const memberPath = `${path}.member[${ordinal}]`;
      // 2020-12 applies `properties` AND every matching `patternProperties` — not the
      // first match and not one or the other. Stopping at the first would let a second,
      // stricter pattern silently not apply.
      let matched = false;
      // Own-property lookup ONLY: a JSON.parse'd document key like `constructor`,
      // `toString`, or `__proto__` must never resolve through the schema object's
      // prototype chain — `schema.properties?.[key]` would return Object.prototype
      // members as truthy "known property schemas" and silently bypass the
      // closed-schema rule (S2 plan-verify finding, live-reproduced).
      const propSchema = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
      if (propSchema) {
        // Schema-declared: the name came from the packaged schema's own
        // `properties`, so naming it discloses nothing the schema file does not
        // already publish.
        validateNode({ value: child, schema: propSchema, root, path: `${path}.${key}`, ctx });
        matched = true;
      }
      for (const [re, sub] of Object.entries(schema.patternProperties ?? {})) {
        if (!new RegExp(re).test(key)) continue;
        // Matching a PATTERN is not the same as being declared: the key is still
        // whatever the document wrote, so it descends under the ordinal.
        validateNode({ value: child, schema: sub, root, path: memberPath, ctx });
        matched = true;
      }
      if (matched) continue;
      if (schema.additionalProperties === false) {
        // THE §4.1 RULE, at every depth. A structural key is never forgiven; a
        // scalar is forgiven only by a genuinely newer minor.
        //
        // These three findings are the ones a flood arrives through — 4,000
        // unknown keys produce 4,000 of them — and each one used to carry the
        // document's key AND, in the two minor-related branches, the document's
        // own schema string. Both are gone: the ordinal locates the member, and
        // the minor is reported as the NUMBER it parsed to.
        if (!isScalar(child)) {
          ctx.errors.push(finding('error', 'unknown-structural-key', memberPath, `unknown key carrying ${describe(child)} — unknown structural keys are refused at any schema minor, because their meaning would be silently dropped`));
        } else if (ctx.allowUnknownScalars) {
          ctx.warnings.push(finding('warn', 'unknown-scalar-key-ignored', memberPath, `unknown scalar key ignored — the document declares a newer schema minor (${ctx.documentMinor}) than this runtime reads (${ctx.readerMinor})`));
        } else if (ctx.documentMinor === null) {
          // The `$defs` fragment path: a standalone record carries no schema
          // string, so there is no minor that could forgive anything.
          ctx.errors.push(finding('error', 'unknown-key', memberPath, 'unknown key — a standalone schema fragment carries no schema minor that could forgive it, so an unexplained key is refused outright'));
        } else {
          ctx.errors.push(finding('error', 'unknown-key', memberPath, `unknown key — the document's schema minor (${ctx.documentMinor}) is not newer than this runtime's (${ctx.readerMinor}), so it has no excuse for a key this runtime does not know`));
        }
      }
    }
  }
}

/**
 * Validate a document against a packaged schema.
 *
 * Returns { ok, errors, warnings, version } — never throws for a bad DOCUMENT (that
 * is data), only for a bad SCHEMA or a bad reader version (that is a bug here).
 *
 * The schema-version gate runs FIRST: an unknown major is rejected without any
 * structural checks, because validating a shape we do not understand against rules
 * we do understand produces confident nonsense.
 */
export function validateAgainstSchema(document, schema, { readerVersion, maxBytes = SCHEMA_MAX_BYTES } = {}) {
  const schemaErrors = assertSupportedSchema(schema);
  if (schemaErrors.length > 0) throw new Error(`schema is not supported by this validator:\n  ${schemaErrors.join('\n  ')}`);

  const documentVersion = isPlainObject(document) ? document.schema : undefined;
  const version = compareSchemaVersion(documentVersion, readerVersion);
  if (!version.ok) {
    return {
      ok: false,
      errors: [finding('error', version.code, '$.schema', version.message)],
      warnings: [],
      error_count: 1,
      warning_count: 0,
      omitted: false,
      version,
    };
  }

  const ctx = {
    errors: [],
    warnings: [],
    allowUnknownScalars: version.allowUnknownScalars,
    // MINORS, not version strings. Family and major are pinned to the reader's
    // own values by the gate above, so the minor is all that is left of the
    // document's declaration — and a number crosses the boundary where the
    // string it was cut from does not.
    documentMinor: version.documentMinor,
    readerMinor: version.readerMinor,
  };

  // The byte cap is a property of the ARTIFACT, not of any node, so it is checked
  // here rather than smuggled into the schema as a keyword the subset does not have.
  // Byte length, not string length: a multi-byte value must not slip a 64 KiB cap
  // by being counted in code units.
  let bytes = null;
  try {
    bytes = Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch {
    // The caught error is NOT interpolated: a JSON.stringify failure message can
    // quote the offending input (a circular reference names its own path, a
    // BigInt error is generic but a thrown `toJSON` is not bounded at all).
    ctx.errors.push(finding('error', 'artifact-unserializable', '$', 'the document is not serializable as JSON; the underlying error text is withheld because it can quote the input'));
  }
  if (bytes !== null && maxBytes !== null && bytes > maxBytes) {
    ctx.errors.push(finding('error', 'artifact-too-large', '$', `serialized artifact is ${bytes} bytes, over the ${maxBytes}-byte cap — refused, not truncated`));
  }

  // Traversal runs to COMPLETION even past the byte cap and past the display
  // bound, and the verdict below is computed from the full counts. That ordering
  // is the point: a finding suppressed for display must never be a finding that
  // changed the answer.
  validateNode({ value: document, schema, root: schema, path: '$', ctx });
  const errorCount = ctx.errors.length;
  const warningCount = ctx.warnings.length;
  const errors = capFindings(ctx.errors);
  const warnings = capFindings(ctx.warnings);
  return {
    ok: errorCount === 0,
    errors,
    warnings,
    error_count: errorCount,
    warning_count: warningCount,
    omitted: errors.length < errorCount || warnings.length < warningCount,
    version,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Reorder a document's keys into the schema's canonical order (§4.1) — the order in
 * which `properties` are written in the schema file, which JSON preserves. Keys the
 * schema does not name keep their relative order and follow the named ones, so a
 * forgiven newer-minor scalar still serializes deterministically.
 *
 * Values are canonicalized before hashing, so two exports of the same machine hash
 * identically regardless of the order their builders happened to assign keys.
 */
export function canonicalize(document, schema, root = schema) {
  if (Array.isArray(document)) {
    const itemSchema = schema?.items?.$ref ? resolveRefLoose(schema.items.$ref, root) : schema?.items;
    return document.map((item) => canonicalize(item, itemSchema, root));
  }
  if (!isPlainObject(document)) return document;

  const resolved = schema?.$ref ? resolveRefLoose(schema.$ref, root) : schema;
  const named = Object.keys(resolved?.properties ?? {});
  // `Object.create(null)` + `Object.hasOwn`, not `{}` + `key in out`. `in` walks the
  // PROTOTYPE chain, so a document key named `constructor` / `toString` /
  // `hasOwnProperty` / `__proto__` reads as "already emitted" and is silently DROPPED
  // — data loss in the hashing path, reachable through exactly the unknown scalar keys
  // §4.1's newer-minor rule tells us to carry. A null-prototype object has no
  // inherited names to collide with.
  const out = Object.create(null);
  for (const key of named) {
    if (Object.hasOwn(document, key)) out[key] = canonicalize(document[key], resolved.properties[key], root);
  }
  // Keys the schema does not name — dynamic patternProperties entries and forgiven
  // newer-minor scalars — are SORTED, not left in builder order. Canonical means
  // canonical: two processes that assembled the same facts in different insertion
  // orders must hash identically, which is the whole reason this function exists.
  for (const key of Object.keys(document).filter((k) => !named.includes(k)).sort()) {
    const patternEntry = Object.entries(resolved?.patternProperties ?? {}).find(([re]) => new RegExp(re).test(key));
    out[key] = canonicalize(document[key], patternEntry?.[1], root);
  }
  // Back to an ordinary object: a null-prototype value serializes identically but
  // surprises every consumer that does `instanceof`/`toString` on it.
  return { ...out };
}

function resolveRefLoose(ref, root) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  // Own-property lookup only (same prototype-chain discipline as property
  // resolution): a $def named `constructor` must resolve to the schema's own
  // definition or nothing, never to Object.prototype members.
  return m && Object.hasOwn(root.$defs ?? {}, m[1]) ? root.$defs[m[1]] : undefined;
}

// Canonical JSON text for hashing/writing: canonical key order, two-space indent,
// trailing newline — byte-identical to what the artifact writers persist.
export function canonicalJson(document, schema) {
  return `${JSON.stringify(canonicalize(document, schema), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Packaged schema loading
// ---------------------------------------------------------------------------

export const PACKAGED_SCHEMA_FILES = Object.freeze({
  // 1.1 (ADR-0048 §2.1): adds the OPTIONAL trailing `statusline_preset` scalar.
  // 1.2: adds the OPTIONAL trailing session family — `entry_brief`,
  // `entry_brief_empty`, `session_capture`, in that (alphabetical) order, which is
  // the order canonicalization gives them under an older reader. Every valid 1.0
  // and 1.1 document still validates against this reader — the three keys are not
  // required — while a 1.2 document read by a 1.1 reader gets three scalar warnings
  // and the keys ignored (§4.6), which is why the minor bumps at all.
  'agentic-machine-profile': 'agentic-machine-profile-1.2.json',
  // 1.1 (S8a5): adds the OPTIONAL probe hosts.codex.hook_state per-handler disabled
  // evidence. A 1.0 document (no hook_state) still validates against this reader —
  // the key is not required — while a 1.1 document read by a 1.0-only runtime would
  // be refused (unknown structural key), which is why the minor bumps at all.
  // 1.2 (ADR-0048 §3): adds the egress evidence vocabulary — `egress-provider-ack`
  // proof kind + `provider_ack` member (both OPTIONAL at the schema level; the
  // kind-discriminated exclusivity lives in lib/evidence-contract.mjs because the
  // validator has no oneOf) and the OPTIONAL completion.egress_receipt_attestation
  // verdict. Every valid 1.1 document still validates against this reader.
  // 1.3 (§3.3, the value-carrying interview): NO JSON shape change at all — the
  // `set:<key>=<value|unset>` answer rides the existing bounded `answer` string
  // and the two new steps ride the existing `stepId` pattern. The minor bumps
  // for a semantic reason rather than a structural one, and that is exactly the
  // fence it needs to arm: `resume` and `profile seed` refuse a FUTURE minor, so
  // a 1.2 runtime cannot mutate a run whose registry it cannot derive — it would
  // drop the two new CONFIG steps and could close the run under an expectation
  // that never included them. A schema pattern on `answer` was considered and
  // rejected: the grammar is per-step and per-key, so a pattern strong enough to
  // express it would be a second copy of lib/answer-values.mjs that drifts.
  'runtime-bootstrap-run': 'runtime-bootstrap-run-1.3.json',
  'runtime-plugin-set': 'runtime-plugin-set-1.0.json',
  // ADR-0044 session-capture families (session-capture-contract.md §3). Load-bearing
  // from S2 on: the packaged schemas ARE the validation source for the slot/entry/note
  // artifacts — the S3 executors and every consumer validate through loadSchema of
  // these families, never through a second hand-rolled field list.
  'runtime-session-capture': 'runtime-session-capture-1.0.json',
  'runtime-session-entry': 'runtime-session-entry-1.0.json',
  'runtime-session-note': 'runtime-session-note-1.0.json',
  // ADR-0045 §4 entry brief (session-capture-contract.md §15). Load-bearing the
  // same way: the arbiter self-validates its output against this family before
  // any surface renders it, and the S8 dashboard consumer validates through it.
  'runtime-entry-brief': 'runtime-entry-brief-1.0.json',
});

// Deprecated alias — the pre-S2 name for the registry, kept so an external
// import written against the bootstrap-only era keeps resolving. New code uses
// PACKAGED_SCHEMA_FILES.
export const BOOTSTRAP_SCHEMA_FILES = PACKAGED_SCHEMA_FILES;

/**
 * Load a packaged schema by family. Resolved from `import.meta.url`, never from
 * `process.cwd()` — the same rule plugin-set.mjs follows, so a bootstrap invoked
 * from an arbitrary consumer repository reads the schema that shipped with the
 * plugin rather than whatever the current directory happens to contain.
 */
export async function loadSchema(family, { pluginRoot } = {}) {
  const file = Object.hasOwn(PACKAGED_SCHEMA_FILES, family) ? PACKAGED_SCHEMA_FILES[family] : undefined;
  if (!file) throw new Error(`unknown schema family '${family}' (known: ${Object.keys(PACKAGED_SCHEMA_FILES).join(', ')})`);
  // The same packaged-asset resolution the host-parity baseline uses, for the
  // same reason. A constant relative path cannot escape LEXICALLY, so this had
  // no containment check — measured on the baseline, it escapes anyway through
  // a symlinked directory or leaf, and a schema read from outside the package
  // would validate every bootstrap artifact against rules the package does not
  // ship. `pluginRoot` is likewise required to be a real root when given: the
  // old `pluginRoot ? … : <module-relative>` turned an empty override into the
  // packaged default and validated against a different install than asked for.
  if (pluginRoot !== undefined && (typeof pluginRoot !== 'string' || !pluginRoot.trim())) {
    throw new TypeError('loadSchema: pluginRoot must be a non-empty string when provided; omit the key to use the packaged default');
  }
  const root = pluginRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const located = await resolveContained(root, join('data', 'schemas', file));
  if (located.status !== 'ok') {
    throw new Error(`schema ${file} could not be resolved inside the runtime package (${located.status}${located.code ? `: ${located.code}` : ''}) at ${located.path}`);
  }
  const raw = await readFile(located.canonicalPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`schema ${file} is not valid JSON: ${err.message}`);
  }
}

/**
 * Build the `validate` function the bootstrap artifact writers take as an injected
 * seam (lib/bootstrap-artifacts.mjs: createBootstrapRun / writeMachineProfile /
 * writeBootstrapProof). Returns `(document) => { ok, errors, warnings }` — exactly
 * the shape those writers already expect, so the storage layer never grows a second
 * copy of the schema to drift from this one.
 *
 * The schema is loaded ONCE and closed over: a writer called in a loop must not
 * re-read a file per artifact.
 *
 * ⚠ STRUCTURAL ONLY — this is NOT the whole gate, and wiring it alone would ship a
 * profile writer that looks guarded and is not. What the schema cannot express, and
 * who owns it:
 *
 *   * §4.3 guard 1 — the fail-closed SECRET SCRUB. A token-shaped `model.value`
 *     satisfies `type: string` perfectly. The profile engine (C5) must scrub before
 *     it writes.
 *   * §4.1 — `credential_required` is true IFF `declined === false` AND
 *     `channel.value !== null`. A cross-field implication is not a JSON Schema
 *     concept; C5 enforces it.
 *   * §5/§8.1 — `proofs[].status` is the aggregate RECOMPUTED from `directions`, and
 *     `bound_versions.plugins` must cover exactly the SELECTED plugin set. Both need
 *     facts (the directions, the selection) that a schema cannot see. The reducer (C5)
 *     owns them; the schema only guarantees the shape is expressible.
 *   * §4.1 canonical order — the storage writers persist the object they are HANDED.
 *     A builder that wants canonical bytes on disk (and a stable hash) must pass
 *     `canonicalize(doc, schema)` / `canonicalJson(doc, schema)` itself; validation
 *     does not reorder its input.
 */
export async function makeValidator(family, { pluginRoot, readerVersion } = {}) {
  const schema = await loadSchema(family, { pluginRoot });
  const version = readerVersion ?? schema.$id;
  return (document) => {
    const result = validateAgainstSchema(document, schema, { readerVersion: version });
    // The COUNTS ride out alongside the (display-capped) finding arrays. A
    // consumer that only reads `errors` would otherwise report "16 problems" for
    // an artifact with four thousand, which is the flood hidden rather than
    // bounded.
    return {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      error_count: result.error_count,
      warning_count: result.warning_count,
      omitted: result.omitted,
    };
  };
}

/**
 * A validator for a `$defs` SUBSCHEMA — the seam `writeBootstrapProof` needs.
 *
 * A proof record is written to its own file and has no top-level `schema` string, so
 * `makeValidator('runtime-bootstrap-run')` would reject every one of them for a
 * missing version it was never supposed to carry. The enclosing document's version
 * gate does not apply to a fragment of it; what applies is the fragment's shape.
 *
 * Unknown keys are therefore always refused here (there is no minor to forgive them):
 * a standalone fragment carrying an unexplained key is not forward-compat, it is
 * unexplained.
 */
export async function makeDefValidator(family, defName, { pluginRoot } = {}) {
  const schema = await loadSchema(family, { pluginRoot });
  const def = Object.hasOwn(schema.$defs ?? {}, defName) ? schema.$defs[defName] : undefined;
  if (!def) throw new Error(`schema ${family} has no $defs/${defName}`);
  const schemaErrors = assertSupportedSchema(schema);
  if (schemaErrors.length > 0) throw new Error(`schema is not supported by this validator:\n  ${schemaErrors.join('\n  ')}`);

  return (document) => {
    // `documentMinor: null` is the fragment marker: a standalone record has no
    // schema string, so the unknown-key branch reports "no minor could forgive
    // it" rather than interpolating a version that does not exist.
    const ctx = { errors: [], warnings: [], allowUnknownScalars: false, documentMinor: null, readerMinor: null };
    validateNode({ value: document, schema: def, root: schema, path: `$(${defName})`, ctx });
    const errorCount = ctx.errors.length;
    const warningCount = ctx.warnings.length;
    const errors = capFindings(ctx.errors);
    const warnings = capFindings(ctx.warnings);
    return {
      ok: errorCount === 0,
      errors,
      warnings,
      error_count: errorCount,
      warning_count: warningCount,
      omitted: errors.length < errorCount || warnings.length < warningCount,
    };
  };
}
