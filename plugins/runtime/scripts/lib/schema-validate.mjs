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
import { dirname, resolve } from 'node:path';

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
  if (doc === null) {
    return { ok: false, reason: 'unparseable', allowUnknownScalars: false, message: `schema '${documentVersion}' is not a recognized schema version (expected <family>-<major>.<minor>)` };
  }
  if (doc.family !== reader.family) {
    return { ok: false, reason: 'wrong-family', allowUnknownScalars: false, message: `schema family '${doc.family}' does not match the expected '${reader.family}'` };
  }
  if (doc.major !== reader.major) {
    return {
      ok: false,
      reason: 'unknown-major',
      allowUnknownScalars: false,
      message: `schema major ${doc.major} is not readable by this runtime (expects major ${reader.major}). A major means the shape changed; upgrade the runtime plugin rather than reading it as if it had not.`,
    };
  }
  // A GREATER minor is the only case that earns the benefit of the doubt, and only
  // for additive scalars (§4.1).
  return { ok: true, reason: doc.minor > reader.minor ? 'newer-minor' : 'compatible', allowUnknownScalars: doc.minor > reader.minor, message: null };
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

function resolveRef(ref, root, path, errors) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m) {
    errors.push(`${path}: only internal '#/$defs/<name>' refs are supported, got '${ref}'`);
    return null;
  }
  const target = Object.hasOwn(root.$defs ?? {}, m[1]) ? root.$defs[m[1]] : undefined;
  if (!target) {
    errors.push(`${path}: $ref '${ref}' does not resolve`);
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
      errors.push(`${path}: expected ${types.join(' | ')}, got ${describe(value)}`);
      return; // Every other check below assumes the type held.
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(`${path}: string length ${value.length} exceeds maxLength ${schema.maxLength}`);
  }

  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      // Refused, never truncated (§4.1): a silently truncated permission list is a
      // security artifact, not a convenience.
      errors.push(`${path}: ${value.length} entries exceeds maxItems ${schema.maxItems} — the artifact is refused, not truncated`);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} entries is below minItems ${schema.minItems}`);
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
      if (!Object.hasOwn(value, name)) errors.push(`${path}: missing required key '${name}'`);
    }
  }

  if (isPlainObject(value) && (schema.properties || schema.patternProperties || schema.additionalProperties === false)) {
    for (const [key, child] of Object.entries(value)) {
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
        validateNode({ value: child, schema: propSchema, root, path: `${path}.${key}`, ctx });
        matched = true;
      }
      for (const [re, sub] of Object.entries(schema.patternProperties ?? {})) {
        if (!new RegExp(re).test(key)) continue;
        validateNode({ value: child, schema: sub, root, path: `${path}.${key}`, ctx });
        matched = true;
      }
      if (matched) continue;
      if (schema.additionalProperties === false) {
        // THE §4.1 RULE, at every depth. A structural key is never forgiven; a
        // scalar is forgiven only by a genuinely newer minor.
        if (!isScalar(child)) {
          ctx.errors.push(`${path}.${key}: unknown key carrying ${describe(child)} — unknown structural keys are refused at any schema minor, because their meaning would be silently dropped`);
        } else if (ctx.allowUnknownScalars) {
          ctx.warnings.push(`${path}.${key}: unknown scalar key ignored — the document declares a newer schema minor (${ctx.documentVersion}) than this runtime reads (${ctx.readerVersion})`);
        } else {
          ctx.errors.push(`${path}.${key}: unknown key — the document's schema minor (${ctx.documentVersion}) is not newer than this runtime's (${ctx.readerVersion}), so it has no excuse for a key this runtime does not know`);
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
    return { ok: false, errors: [`schema: ${version.message}`], warnings: [], version };
  }

  const ctx = {
    errors: [],
    warnings: [],
    allowUnknownScalars: version.allowUnknownScalars,
    documentVersion,
    readerVersion,
  };

  // The byte cap is a property of the ARTIFACT, not of any node, so it is checked
  // here rather than smuggled into the schema as a keyword the subset does not have.
  // Byte length, not string length: a multi-byte value must not slip a 64 KiB cap
  // by being counted in code units.
  let bytes = null;
  try {
    bytes = Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch {
    ctx.errors.push('schema: document is not serializable as JSON');
  }
  if (bytes !== null && maxBytes !== null && bytes > maxBytes) {
    ctx.errors.push(`schema: serialized artifact is ${bytes} bytes, over the ${maxBytes}-byte cap — refused, not truncated`);
  }

  validateNode({ value: document, schema, root: schema, path: '$', ctx });
  return { ok: ctx.errors.length === 0, errors: ctx.errors, warnings: ctx.warnings, version, bytes };
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
  'agentic-machine-profile': 'agentic-machine-profile-1.0.json',
  // 1.1 (S8a5): adds the OPTIONAL probe hosts.codex.hook_state per-handler disabled
  // evidence. A 1.0 document (no hook_state) still validates against this reader —
  // the key is not required — while a 1.1 document read by a 1.0-only runtime would
  // be refused (unknown structural key), which is why the minor bumps at all.
  'runtime-bootstrap-run': 'runtime-bootstrap-run-1.1.json',
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
  const base = pluginRoot ? resolve(pluginRoot, 'data', 'schemas') : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'schemas');
  const raw = await readFile(resolve(base, file), 'utf8');
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
    return { ok: result.ok, errors: result.errors, warnings: result.warnings };
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
    const ctx = { errors: [], warnings: [], allowUnknownScalars: false, documentVersion: `${family}/$defs/${defName}`, readerVersion: schema.$id };
    validateNode({ value: document, schema: def, root: schema, path: `$(${defName})`, ctx });
    return { ok: ctx.errors.length === 0, errors: ctx.errors, warnings: ctx.warnings };
  };
}
