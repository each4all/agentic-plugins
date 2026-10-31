// plugins/orchestrator/adapters/claude/autopilot/verify-decl.mjs
//
// ADR-0068 Decision 5, items 3 and 7 — the driver's own reading of the
// repository's check declaration (verify-exec). The persona's CLI checks a
// request against the declaration too (persona-pipeline/files/scripts/lib/
// verify.mjs), but nothing it checks is a trust boundary: the driver reads
// the declaration itself, from the commit its run started from, never from a
// lane's tree, and resolves every check it runs again here.
//
// A copy, not an import (ADR-0010 §5: the orchestrator imports nothing from a
// persona, nor from the repository's own scripts/): the parser, the resolver,
// the checks' identity (`checksDigest`) and the worst-case size of a batch's
// results (`worstCaseBytes`), each the persona's in behaviour and bytes.
// tests/orchestrator/test-autopilot-verify-decl.mjs runs one corpus through
// both copies and holds every answer, argv, digest and size equal.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

// The marker `state.mjs verify-capability` prints and the persona's
// lib/verify.mjs carries: the driver offers verification only when the
// installed persona has it (Decision 5, item 11; roots.mjs).
export const VERIFY_RECORD_CAPABILITY = 'verify-record-1';
export const VERIFY_DECLARATION_PATH = '.agentic-plugins/verify-checks.json';
export const VERIFY_DECLARATION_SCHEMA = 'agentic-verify-checks-1.0';

const REPEATS = Object.freeze(['one', 'many', 'optional-many']);
const JOINS = Object.freeze(['words', 'comma']);
const SLOT_TYPES = Object.freeze(['path', 'id']);
export const MAX_SLOT_VALUES = 400;
export const MAX_CHECK_TIMEOUT_S = 14_400;
export const MAX_BATCH_CHECKS = 128;
export const MAX_RESULTS_BYTES = 192 * 1024;
export const MAX_FAILING_TESTS = 20;
export const MAX_FAILING_TEST_CHARS = 200;
export const MAX_ARGV_WORDS = 512;
export const MAX_WORD_CHARS = 512;

const KIND_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const FIXED_WORD_RE = /^[A-Za-z0-9._:/=@+-]{1,128}$/;
const SLOT_REF_RE = /^\{([a-z][a-z0-9_]{0,31})\}$/;
const PATH_RE = /^[A-Za-z0-9._/-]{1,256}$/;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const GLOB_RE = /^[A-Za-z0-9._/*-]{1,256}$/;

const fail = (msg) => { throw new Error(msg); };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${where}: unknown field ${JSON.stringify(k)} (expected ${allowed.join(', ')})`);
  }
}

/** Canonical JSON: object keys sorted at every depth, so one value has one text. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObj(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function pathProblem(value) {
  if (typeof value !== 'string') return 'is not a string';
  if (!PATH_RE.test(value)) return 'holds a character outside [A-Za-z0-9._/-] or is longer than 256 characters';
  if (value.startsWith('-')) return 'begins with -';
  if (value.startsWith('/')) return 'is absolute';
  if (value.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'has an empty, . or .. segment';
  return null;
}

export function idProblem(value) {
  if (typeof value !== 'string') return 'is not a string';
  if (!ID_RE.test(value)) return 'is not 1 to 64 characters of [A-Za-z0-9_-] beginning with a letter, digit or _';
  return null;
}

function parseSlot(slot, where) {
  if (!isObj(slot)) fail(`${where} is not an object`);
  onlyKeys(slot, ['name', 'type', 'repeat', 'join', 'under', 'suffix', 'lead'], where);
  if (typeof slot.name !== 'string' || !SLOT_NAME_RE.test(slot.name)) fail(`${where}.name is not a slot name`);
  if (!SLOT_TYPES.includes(slot.type)) fail(`${where}.type ${JSON.stringify(slot.type)} is not one of ${SLOT_TYPES.join(', ')}`);
  if (!REPEATS.includes(slot.repeat)) fail(`${where}.repeat is not one of ${REPEATS.join(', ')}`);
  if (slot.join !== undefined && !JOINS.includes(slot.join)) fail(`${where}.join is not one of ${JOINS.join(', ')}`);
  if (slot.repeat !== 'one' && slot.join === undefined) fail(`${where}: a repeated slot names its join (${JOINS.join(', ')})`);
  if (slot.repeat === 'one' && slot.join !== undefined) fail(`${where}: a slot of one value takes no join`);
  if (slot.under !== undefined) {
    if (slot.type !== 'path') fail(`${where}.under applies to a path slot only`);
    if (!Array.isArray(slot.under) || slot.under.length === 0) fail(`${where}.under is not a non-empty list`);
    for (const u of slot.under) {
      if (typeof u !== 'string' || !u.endsWith('/') || pathProblem(u.slice(0, -1)) !== null) fail(`${where}.under ${JSON.stringify(u)} is not a directory prefix ending in /`);
    }
  }
  if (slot.suffix !== undefined) {
    if (slot.type !== 'path') fail(`${where}.suffix applies to a path slot only`);
    if (typeof slot.suffix !== 'string' || !/^\.[A-Za-z0-9]{1,16}$/.test(slot.suffix)) fail(`${where}.suffix is not a file suffix`);
  }
  if (slot.lead !== undefined) {
    if (slot.repeat !== 'optional-many') fail(`${where}.lead applies to an optional-many slot only`);
    if (!Array.isArray(slot.lead) || slot.lead.length === 0 || !slot.lead.every((w) => typeof w === 'string' && FIXED_WORD_RE.test(w))) {
      fail(`${where}.lead is not a non-empty list of fixed words`);
    }
  }
  return Object.freeze({ ...slot });
}

function parseKind(id, kind) {
  const where = `kind ${id}`;
  if (!KIND_ID_RE.test(id)) fail(`${where}: the id is not [a-z][a-z0-9-]{0,63}`);
  if (!isObj(kind)) fail(`${where} is not an object`);
  onlyKeys(kind, ['argv', 'slots', 'timeout_s', 'locks_itself', 'adds_on'], where);
  if (!Array.isArray(kind.argv) || kind.argv.length === 0 || kind.argv.length > 32) fail(`${where}.argv is not a list of 1 to 32 words`);
  if (!Array.isArray(kind.slots)) fail(`${where}.slots is not a list`);
  const slots = kind.slots.map((s, i) => parseSlot(s, `${where}.slots[${i}]`));
  const names = slots.map((s) => s.name);
  if (new Set(names).size !== names.length) fail(`${where}: a slot name is repeated`);
  const refs = [];
  kind.argv.forEach((w, i) => {
    if (typeof w !== 'string') fail(`${where}.argv[${i}] is not a string`);
    const ref = SLOT_REF_RE.exec(w);
    if (ref) refs.push(ref[1]);
    else if (!FIXED_WORD_RE.test(w)) fail(`${where}.argv[${i}] ${JSON.stringify(w)} is neither a fixed word nor a {slot}`);
  });
  if (refs.length !== new Set(refs).size) fail(`${where}: a slot is referenced twice`);
  if (refs.slice().sort().join() !== names.slice().sort().join()) fail(`${where}: argv references ${refs.join(', ') || 'no slot'}, the slots are ${names.join(', ') || 'none'}`);
  if (!Number.isInteger(kind.timeout_s) || kind.timeout_s < 1 || kind.timeout_s > MAX_CHECK_TIMEOUT_S) {
    fail(`${where}.timeout_s is not a whole number of seconds from 1 to ${MAX_CHECK_TIMEOUT_S}`);
  }
  if (typeof kind.locks_itself !== 'boolean') fail(`${where}.locks_itself is not a boolean`);
  if (!Array.isArray(kind.adds_on) || !kind.adds_on.every((g) => typeof g === 'string' && GLOB_RE.test(g) && !g.split('/').includes('..'))) {
    fail(`${where}.adds_on is not a list of path globs`);
  }
  return Object.freeze({ id, argv: Object.freeze([...kind.argv]), slots: Object.freeze(slots), timeout_s: kind.timeout_s, locks_itself: kind.locks_itself, adds_on: Object.freeze([...kind.adds_on]) });
}

// The first key a JSON object of `text` names twice, or null.
function duplicateKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && stack.at(-1)) stack.at(-1).expectKey = true;
  }
  return null;
}

/** Parse and check the declaration's text; its sha256 is its digest. Throws naming the first problem. */
export function parseDeclaration(text) {
  if (typeof text !== 'string') fail('the declaration is not text');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`the declaration is not JSON (${err.message})`);
  }
  if (!isObj(raw)) fail('the declaration is not a JSON object');
  const twice = duplicateKey(text);
  if (twice !== null) fail(`the declaration names the key ${JSON.stringify(twice)} twice in one object`);
  onlyKeys(raw, ['schema', 'kinds', 'mappings'], 'the declaration');
  if (raw.schema !== VERIFY_DECLARATION_SCHEMA) fail(`the declaration's schema is not ${VERIFY_DECLARATION_SCHEMA} (got ${JSON.stringify(raw.schema)})`);
  if (!isObj(raw.kinds) || Object.keys(raw.kinds).length === 0) fail('the declaration declares no kind');
  const kinds = {};
  for (const [id, kind] of Object.entries(raw.kinds)) kinds[id] = parseKind(id, kind);
  if (raw.mappings !== undefined && !Array.isArray(raw.mappings)) fail('the declaration\'s mappings is not a list');
  return Object.freeze({ schema: raw.schema, kinds: Object.freeze(kinds), mappings: raw.mappings ?? [], digest: sha256(text) });
}

function slotValues(slot, value, where) {
  const many = slot.repeat !== 'one';
  if (value === undefined) {
    if (slot.repeat === 'optional-many') return [];
    fail(`${where}: slot ${slot.name} is missing`);
  }
  if (!many) {
    if (typeof value !== 'string') fail(`${where}: slot ${slot.name} takes one value`);
    return [value];
  }
  if (!Array.isArray(value)) fail(`${where}: slot ${slot.name} takes a list`);
  const min = slot.repeat === 'many' ? 1 : 0;
  if (value.length < min || value.length > MAX_SLOT_VALUES) fail(`${where}: slot ${slot.name} takes ${min} to ${MAX_SLOT_VALUES} values (got ${value.length})`);
  return value;
}

function pathInTree(tree, value) {
  const full = join(tree, value);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return 'names no file in the tested tree';
  }
  if (st.isSymbolicLink()) return 'is a symbolic link';
  if (!st.isFile()) return 'is not a regular file';
  let realTree;
  let realFile;
  try {
    realTree = realpathSync(tree);
    realFile = realpathSync(full);
  } catch {
    return 'cannot be resolved in the tested tree';
  }
  if (!realFile.startsWith(`${realTree}${sep}`)) return 'resolves outside the tested tree';
  return null;
}

/**
 * The argv a requested check runs as (item 8): the kind's words with each
 * {slot} replaced by its checked values; `tree`, when given, is the tested
 * tree each path argument must name a file in. Throws naming the problem.
 */
export function resolveCheck(decl, check, { tree = null } = {}) {
  if (!isObj(check)) fail('a check is not an object');
  onlyKeys(check, ['kind', 'args'], 'a check');
  const kind = decl.kinds[check.kind];
  if (typeof check.kind !== 'string' || !Object.hasOwn(decl.kinds, check.kind) || !kind) {
    fail(`check kind ${JSON.stringify(check.kind)} is not declared`);
  }
  const where = `check ${check.kind}`;
  const args = check.args ?? {};
  if (!isObj(args)) fail(`${where}: args is not an object`);
  for (const name of Object.keys(args)) {
    if (!kind.slots.some((s) => s.name === name)) fail(`${where}: no slot ${JSON.stringify(name)}`);
  }
  const bySlot = {};
  for (const slot of kind.slots) {
    const values = slotValues(slot, args[slot.name], where);
    values.forEach((v) => {
      const problem = slot.type === 'path' ? pathProblem(v) : idProblem(v);
      if (problem) fail(`${where}: ${slot.name} value ${JSON.stringify(v)} ${problem}`);
      if (slot.type === 'path') {
        if (slot.under && !slot.under.some((u) => v.startsWith(u))) fail(`${where}: ${slot.name} value ${JSON.stringify(v)} is not under ${slot.under.join(', ')}`);
        if (slot.suffix && !v.endsWith(slot.suffix)) fail(`${where}: ${slot.name} value ${JSON.stringify(v)} does not end in ${slot.suffix}`);
        if (tree !== null) {
          const inTree = pathInTree(tree, v);
          if (inTree) fail(`${where}: ${slot.name} value ${JSON.stringify(v)} ${inTree}`);
        }
      }
    });
    if (new Set(values).size !== values.length) fail(`${where}: slot ${slot.name} repeats a value`);
    bySlot[slot.name] = { slot, values };
  }
  const argv = [];
  for (const w of kind.argv) {
    const ref = SLOT_REF_RE.exec(w);
    if (!ref) { argv.push(w); continue; }
    const { slot, values } = bySlot[ref[1]];
    if (values.length === 0) continue;
    if (slot.lead) argv.push(...slot.lead);
    if (slot.repeat === 'one' || slot.join === 'words') argv.push(...values);
    else argv.push(values.join(','));
  }
  if (argv.length > MAX_ARGV_WORDS) fail(`${where}: resolves to ${argv.length} words, more than the ${MAX_ARGV_WORDS} a batch runs`);
  const long = argv.find((w) => w.length > MAX_WORD_CHARS);
  if (long !== undefined) fail(`${where}: resolves to a word of ${long.length} characters, more than the ${MAX_WORD_CHARS} a batch runs; ask for fewer values`);
  return argv;
}

/** The identity of a batch's checks (item 7): sha256 over its argv arrays, in batch order. */
export function checksDigest(argvList) {
  return sha256(JSON.stringify(argvList));
}

/** The bytes a value takes as the frontmatter line `key: "<json>"`. */
export function scalarBytes(key, value) {
  return Buffer.byteLength(`${key}: ${JSON.stringify(JSON.stringify(value))}`, 'utf8');
}

function worstResult(index, failed) {
  return {
    index, outcome: failed ? 'failed' : 'not-reached', exit: null, signal: 'SIGXXXXXXXXXXXX',
    duration_ms: 7 * 24 * 3600 * 1000,
    failing_tests: failed ? Array.from({ length: MAX_FAILING_TESTS }, () => '"'.repeat(MAX_FAILING_TEST_CHARS)) : [],
    failing_tests_more: Number.MAX_SAFE_INTEGER, log: 'x'.repeat(256), ended_at: '2026-01-01T00:00:00Z',
    carried_from: { batch_id: 'x'.repeat(64), run_id: 'autopilot-20260101T000000Z-000000' },
  };
}

/**
 * The bytes `verify_results` would take at worst once `start` has recorded
 * its results and its end, beside `results` (the batches the persona keeps):
 * the bound the persona's `verify-batch-start` refuses a batch over
 * (MAX_RESULTS_BYTES), computed before the batch starts so that the driver
 * never starts one the persona would refuse.
 */
export function worstCaseBytes(results, start) {
  const n = start.checks.length;
  const filled = {
    ...start,
    results: Array.from({ length: n }, (_, i) => worstResult(i, i === n - 1)),
    tree_end: 'f'.repeat(64), end: 'no-evidence', cause: 'tree-unreadable', ended_at: '2026-01-01T00:00:00Z',
  };
  const link = {
    ...filled, batch_id: 'x'.repeat(64), continues: 'x'.repeat(64),
    checks: filled.checks.map((c) => ({ ...c, kind: 'k'.repeat(64) })),
  };
  return Math.max(
    scalarBytes('verify_results', { ...results, batches: [...results.batches, filled] }),
    scalarBytes('verify_results', { ...results, batches: [link, link] }),
  );
}

// git as the driver reads its own baseline: no replace ref stands in for an
// object, and no inherited GIT_* variable points it at another repository,
// object store or configuration (the persona's verify section reads it so).
function gitShow(repoRoot, spec) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['--no-replace-objects', '-C', repoRoot, 'show', spec], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
  });
  return r;
}

/**
 * The declaration at `commit` of the repository `repoRoot` is a checkout of
 * (item 3): `{ declaration }`, `{ absent: true }` when the commit holds no
 * declaration, or `{ problem }` when it holds one that does not parse, or the
 * commit cannot be read.
 */
export function readDeclarationAt(repoRoot, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return { problem: `the run's baseline ${JSON.stringify(commit)} is not a 40-hex commit` };
  const exists = spawnSync('git', ['--no-replace-objects', '-C', repoRoot, 'cat-file', '-e', `${commit}:${VERIFY_DECLARATION_PATH}`], {
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), stdio: 'ignore', timeout: 30_000,
  });
  if (exists.status !== 0) {
    const commitOk = spawnSync('git', ['--no-replace-objects', '-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`], {
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), stdio: 'ignore', timeout: 30_000,
    });
    return commitOk.status === 0 ? { absent: true } : { problem: `the run's baseline ${commit} cannot be read in ${repoRoot}` };
  }
  const shown = gitShow(repoRoot, `${commit}:${VERIFY_DECLARATION_PATH}`);
  if (shown.status !== 0) return { problem: `${VERIFY_DECLARATION_PATH} at ${commit} cannot be read (${(shown.stderr ?? '').trim().slice(0, 200)})` };
  try {
    return { declaration: parseDeclaration(shown.stdout) };
  } catch (err) {
    return { problem: `${VERIFY_DECLARATION_PATH} at ${commit} does not parse (${err.message})` };
  }
}
