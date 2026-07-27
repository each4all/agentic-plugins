// Minimal JSON-Schema-subset validator + provenance meta-check for the
// ADR-0049 evidence store.
//
// WHY A SEPARATE VALIDATOR, and not `plugins/runtime/scripts/lib/schema-validate.mjs`:
// two independent reasons, either sufficient.
//
//   1. That module's `SUPPORTED_CONSTRAINTS` / `SCHEMA_ANNOTATIONS` are CLOSED
//      allowlists and it rejects any unknown keyword, so `x-provenance` — the
//      one thing this store's schema exists to carry — is rejected today.
//   2. It lives under `plugins/runtime`, a release-please package path. Editing
//      it would route a runtime release from this slice, and the macro that
//      schedules this work reserves the NEXT runtime release for the slice that
//      authors the first live record (ADR-0049 Amendment item 3). Adding a
//      keyword to a plugin's packaged validator to serve a repo-level docs gate
//      would also be the wrong direction of dependency.
//
// The supported subset mirrors that module's deliberately small surface, plus
// `x-provenance`. Anything outside it is a hard error rather than a silent
// pass — an unrecognised keyword in a schema reads as a constraint and would
// otherwise be no constraint at all.

import { readFileSync } from 'node:fs';

// ADR-0049 Decision 2. Closed set; a fifth class needs an ADR, not an edit.
export const PROVENANCE_CLASSES = new Set(['derived', 'observed', 'operator-attested', 'authored']);

const SUPPORTED_CONSTRAINTS = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'maxLength', 'pattern', '$ref',
]);
const SCHEMA_ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description', 'x-provenance']);
const KNOWN_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, allowed) {
  const actual = typeOf(value);
  for (const t of allowed) {
    if (t === actual) return true;
    // `integer` is a `number`; the reverse is not true.
    if (t === 'number' && actual === 'integer') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Meta-check: the schema itself
// ---------------------------------------------------------------------------

/**
 * Walk the schema and assert:
 *   - every keyword is in the supported subset (unknown keyword = error, not skip);
 *   - every entry of every `properties` map declares exactly one `x-provenance`
 *     drawn from the closed set;
 *   - every `$ref` resolves inside `$defs`.
 *
 * The provenance rule is applied per PROPERTY, not per schema node. An array
 * property's class describes its MEMBERSHIP (always `authored` in this store,
 * per Amendment item 4); the entry fields under its `items` are properties in
 * their own right and carry their own classes. That is exactly the granularity
 * the amendment says the ADR's row-level table was missing.
 */
export function checkSchemaShape(schema) {
  const findings = [];
  if (!isPlainObject(schema)) {
    return [{ check: 'schema-shape', path: '$', detail: 'schema root is not an object' }];
  }
  const defs = isPlainObject(schema.$defs) ? schema.$defs : {};
  const seenDefs = new Set();

  const walk = (node, path) => {
    if (!isPlainObject(node)) {
      findings.push({ check: 'schema-shape', path, detail: 'schema node is not an object' });
      return;
    }
    for (const key of Object.keys(node)) {
      if (SUPPORTED_CONSTRAINTS.has(key) || SCHEMA_ANNOTATIONS.has(key)) continue;
      findings.push({
        check: 'schema-shape',
        path,
        detail: `unsupported schema keyword \`${key}\` — the subset is ${[...SUPPORTED_CONSTRAINTS].join(', ')} plus annotations`,
      });
    }
    if (node.$ref !== undefined) {
      const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
      if (!m) {
        findings.push({ check: 'schema-shape', path, detail: `\`$ref\` must be #/$defs/<name>, got \`${node.$ref}\`` });
      } else if (!Object.hasOwn(defs, m[1])) {
        findings.push({ check: 'schema-shape', path, detail: `\`$ref\` target \`${m[1]}\` is not defined in $defs` });
      } else {
        seenDefs.add(m[1]);
      }
    }
    if (node.type !== undefined) {
      const list = Array.isArray(node.type) ? node.type : [node.type];
      for (const t of list) {
        if (!KNOWN_TYPES.has(t)) findings.push({ check: 'schema-shape', path, detail: `unknown type \`${t}\`` });
      }
    }
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties)) {
        findings.push({ check: 'schema-shape', path, detail: '`properties` is not an object' });
      } else {
        // An object schema that declares properties must be closed. An open
        // object in an evidence record means a fact can be carried with no
        // declared provenance at all, which is the whole failure mode.
        if (node.additionalProperties !== false) {
          findings.push({
            check: 'schema-shape',
            path,
            detail: 'object schema declares `properties` but is not closed (`additionalProperties: false` required)',
          });
        }
        for (const [name, sub] of Object.entries(node.properties)) {
          const subPath = `${path}.${name}`;
          if (!isPlainObject(sub)) {
            findings.push({ check: 'schema-shape', path: subPath, detail: 'property schema is not an object' });
            continue;
          }
          const prov = sub['x-provenance'];
          if (prov === undefined) {
            findings.push({ check: 'provenance', path: subPath, detail: 'property declares no `x-provenance`' });
          } else if (typeof prov !== 'string' || !PROVENANCE_CLASSES.has(prov)) {
            findings.push({
              check: 'provenance',
              path: subPath,
              detail: `\`x-provenance\` must be one of ${[...PROVENANCE_CLASSES].join(' | ')}, got ${JSON.stringify(prov)}`,
            });
          } else if (path === '$' && (Array.isArray(sub.type) ? sub.type.includes('array') : sub.type === 'array')) {
            // Membership provenance, and ONLY for the PER-LOOP arrays — the
            // ones hanging directly off the record root. Decision 1 keys the
            // record on the evidence loop and the loop boundary is asserted,
            // not derived, so nothing can decide which of them owns an entry.
            //
            // The rule stops there deliberately. An array nested inside an
            // entry (a proof's `readings`, say) is not a membership question
            // about the loop: which readings a doctor run emitted is observed
            // along with the run. Applying the rule to every array anywhere
            // would force `authored` onto observations — this check caught
            // exactly that on its first run against this schema.
            if (prov !== 'authored') {
              findings.push({
                check: 'provenance',
                path: subPath,
                detail: `per-loop array membership must be \`authored\` (Amendment item 4), got \`${prov}\``,
              });
            }
          }
          walk(sub, subPath);
        }
      }
    }
    if (node.items !== undefined) walk(node.items, `${path}[]`);
  };

  walk(schema, '$');
  // Walk EVERY definition before judging references. A def referenced only by
  // a later-walked def (fullSha, used from packageRelease) would otherwise be
  // reported unreferenced purely because of key order — this check's first run
  // against this schema produced exactly that false finding.
  for (const [name, sub] of Object.entries(defs)) walk(sub, `$defs.${name}`);
  for (const name of Object.keys(defs)) {
    if (!seenDefs.has(name)) {
      // A $defs entry nothing references is either dead or a typo'd $ref
      // elsewhere that silently validated against nothing.
      findings.push({ check: 'schema-shape', path: `$defs.${name}`, detail: 'definition is never referenced' });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Instance validation
// ---------------------------------------------------------------------------

/** Validate `value` against `schema`. Returns an array of findings (empty = valid). */
export function validateInstance(value, schema, { path = '$' } = {}) {
  const defs = isPlainObject(schema.$defs) ? schema.$defs : {};
  const findings = [];

  const check = (node, val, at) => {
    if (node.$ref !== undefined) {
      const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
      const target = m && defs[m[1]];
      if (!target) {
        findings.push({ check: 'schema', path: at, detail: `unresolvable $ref ${node.$ref}` });
        return;
      }
      check(target, val, at);
      // Siblings of $ref still apply (JSON Schema 2020-12); only annotations
      // and x-provenance are used as siblings here, so nothing more to do.
    }
    if (node.type !== undefined) {
      const allowed = Array.isArray(node.type) ? node.type : [node.type];
      if (!typeMatches(val, allowed)) {
        findings.push({ check: 'schema', path: at, detail: `expected type ${allowed.join('|')}, got ${typeOf(val)}` });
        return;
      }
    }
    if (node.const !== undefined && val !== node.const) {
      findings.push({ check: 'schema', path: at, detail: `expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(val)}` });
    }
    if (node.enum !== undefined && !node.enum.some((e) => e === val)) {
      findings.push({ check: 'schema', path: at, detail: `${JSON.stringify(val)} is not one of ${node.enum.map((e) => JSON.stringify(e)).join(', ')}` });
    }
    if (typeof val === 'string') {
      if (node.maxLength !== undefined && [...val].length > node.maxLength) {
        findings.push({ check: 'schema', path: at, detail: `longer than maxLength ${node.maxLength}` });
      }
      if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(val)) {
        findings.push({ check: 'schema', path: at, detail: `does not match pattern ${node.pattern}` });
      }
    }
    if (Array.isArray(val)) {
      if (node.minItems !== undefined && val.length < node.minItems) {
        findings.push({ check: 'schema', path: at, detail: `fewer than minItems ${node.minItems}` });
      }
      if (node.maxItems !== undefined && val.length > node.maxItems) {
        findings.push({ check: 'schema', path: at, detail: `more than maxItems ${node.maxItems}` });
      }
      if (node.items !== undefined) val.forEach((entry, i) => check(node.items, entry, `${at}[${i}]`));
    }
    if (isPlainObject(val)) {
      for (const name of node.required ?? []) {
        if (!Object.hasOwn(val, name)) findings.push({ check: 'schema', path: `${at}.${name}`, detail: 'required property is missing' });
      }
      if (node.properties !== undefined) {
        if (node.additionalProperties === false) {
          for (const name of Object.keys(val)) {
            if (!Object.hasOwn(node.properties, name)) {
              findings.push({ check: 'schema', path: `${at}.${name}`, detail: 'property is not allowed (schema is closed)' });
            }
          }
        }
        for (const [name, sub] of Object.entries(node.properties)) {
          if (Object.hasOwn(val, name)) check(sub, val[name], `${at}.${name}`);
        }
      }
    }
  };

  check(schema, value, path);
  return findings;
}

export function loadSchema(schemaPath) {
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}
