#!/usr/bin/env node
// A JSON Schema validator for the subset the measurement artifact schema uses.
//
// WHY A SUBSET, AND WHY IT REFUSES WHAT IT DOES NOT KNOW.
//
// This repository carries no runtime dependencies, so a full draft 2020-12
// implementation is not on the table. A subset is: the artifact schema is
// written against the standard vocabulary (AGENTS.md's standards-aligned-core
// principle), and this validates the sixteen keywords that schema actually
// uses.
//
// A subset validator has one characteristic failure, and it is the failure this
// session kept meeting in other clothes: an unimplemented keyword is SILENTLY
// IGNORED, so a constraint written in the schema is enforced nowhere and
// nothing says so. A later author adds `oneOf`, believes the artifact is
// constrained, and it is not.
//
// So `compile` FAILS CLOSED. Any keyword outside SUPPORTED is an error at
// compile time, naming the keyword and where it appeared. Widening the
// validator is then a deliberate act with a test, rather than a silent gap.
//
// Annotations ($schema, $id, title, description) are supported-and-ignored,
// which is what the standard says they are — that is not the same as unknown.

export const SUPPORTED = Object.freeze(new Set([
  // annotations — carried, asserted on nothing
  '$schema', '$id', 'title', 'description',
  // structure
  '$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items',
  // assertions
  'enum', 'const', 'pattern', 'minLength', 'minimum',
]));

const TYPES = Object.freeze(new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']));

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;  // object | string | number | boolean
}

function typeMatches(declared, actual) {
  // `integer` is a `number`; nothing else widens.
  if (declared === actual) return true;
  if (declared === 'number' && actual === 'integer') return true;
  return false;
}

/**
 * Walk every subschema and refuse anything this validator cannot enforce.
 * Returns the schema so it can be used inline; throws on the first defect.
 */
export function compile(schema, where = '#') {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${where}: a schema must be an object or a boolean`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) {
      throw new Error(`${where}: keyword ${JSON.stringify(key)} is not supported by this validator. It would be IGNORED, so the constraint you wrote would be enforced nowhere. Implement it in json-schema-mini.mjs (with a test) or express the constraint with a supported keyword.`);
    }
  }
  if ('type' in schema) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of declared) if (!TYPES.has(t)) throw new Error(`${where}.type: unknown type ${JSON.stringify(t)}`);
  }
  if ('$ref' in schema && !/^#\/\$defs\/[A-Za-z0-9_]+$/.test(schema.$ref)) {
    throw new Error(`${where}.$ref: only local "#/$defs/<name>" references are supported, got ${JSON.stringify(schema.$ref)}`);
  }
  if ('pattern' in schema) {
    try { new RegExp(schema.pattern, 'u'); } catch (err) { throw new Error(`${where}.pattern: ${err.message}`); }
  }
  if ('required' in schema && !Array.isArray(schema.required)) throw new Error(`${where}.required must be an array`);
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw new Error(`${where}.enum must be a non-empty array`);
  for (const [name, sub] of Object.entries(schema.$defs ?? {})) compile(sub, `${where}/$defs/${name}`);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) compile(sub, `${where}/properties/${name}`);
  if (schema.items !== undefined) compile(schema.items, `${where}/items`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    compile(schema.additionalProperties, `${where}/additionalProperties`);
  }
  return schema;
}

function resolve(root, schema) {
  if (!schema || typeof schema !== 'object' || !('$ref' in schema)) return schema;
  const name = schema.$ref.slice('#/$defs/'.length);
  const target = root.$defs?.[name];
  if (!target) throw new Error(`$ref ${schema.$ref} does not resolve`);
  // A $ref alongside other keywords would need all of them to hold; the
  // artifact schema never does that, and `compile` would have to grow to
  // support it, so it is refused here rather than half-applied.
  const siblings = Object.keys(schema).filter((k) => k !== '$ref' && k !== 'description' && k !== 'title');
  if (siblings.length > 0) {
    throw new Error(`$ref with sibling keyword(s) ${JSON.stringify(siblings)} is not supported; the sibling would be silently dropped`);
  }
  return resolve(root, target);
}

function check(root, schema, value, path, out) {
  const s = resolve(root, schema);
  if (s === true || s === undefined) return;
  if (s === false) { out.push({ path, detail: 'no value is valid here' }); return; }

  const actual = typeOf(value);
  if ('type' in s) {
    const declared = Array.isArray(s.type) ? s.type : [s.type];
    if (!declared.some((t) => typeMatches(t, actual))) {
      out.push({ path, detail: `is ${actual}, expected ${declared.join(' | ')}` });
      return;  // every other assertion here would be about the wrong type
    }
  }
  if ('const' in s && JSON.stringify(value) !== JSON.stringify(s.const)) {
    out.push({ path, detail: `is ${JSON.stringify(value)}, expected the constant ${JSON.stringify(s.const)}` });
  }
  if ('enum' in s && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push({ path, detail: `is ${JSON.stringify(value)}, not one of ${JSON.stringify(s.enum)}` });
  }
  if (typeof value === 'string') {
    if ('pattern' in s && !new RegExp(s.pattern, 'u').test(value)) {
      out.push({ path, detail: `does not match ${s.pattern}` });
    }
    if ('minLength' in s && value.length < s.minLength) {
      out.push({ path, detail: `is ${value.length} characters, minimum ${s.minLength}` });
    }
  }
  if (typeof value === 'number' && 'minimum' in s && value < s.minimum) {
    out.push({ path, detail: `is ${value}, minimum ${s.minimum}` });
  }
  if (actual === 'array' && s.items !== undefined) {
    value.forEach((v, i) => check(root, s.items, v, `${path}[${i}]`, out));
  }
  if (actual === 'object') {
    for (const key of s.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) out.push({ path: `${path}.${key}`, detail: 'is required and missing' });
    }
    const known = new Set(Object.keys(s.properties ?? {}));
    for (const [key, v] of Object.entries(value)) {
      if (known.has(key)) { check(root, s.properties[key], v, `${path}.${key}`, out); continue; }
      if (s.additionalProperties === false) { out.push({ path: `${path}.${key}`, detail: 'is not a permitted property' }); continue; }
      if (s.additionalProperties !== undefined && typeof s.additionalProperties === 'object') {
        check(root, s.additionalProperties, v, `${path}.${key}`, out);
      }
    }
  }
}

/** Returns [] when `value` conforms. Throws only when the SCHEMA is unusable. */
export function validate(schema, value) {
  const root = compile(schema);
  const out = [];
  check(root, root, value, '$', out);
  return out;
}
