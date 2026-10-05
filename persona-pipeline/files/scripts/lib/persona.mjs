// scripts/lib/persona.mjs — the persona declaration loader (ADR-0066 Decision 2).
//
// The pipeline scripts are persona-neutral: every persona plugin runs the same
// bytes, and each reads who it is from its own plugins/<persona>/persona.json.
// This module finds that file from its own location (import.meta.url), never
// from the working directory or a repository checkout — an installed plugin has
// no repository — so the read stays inside one plugin.
//
// Rules:
//   - Nothing reads the declaration at import time. A module that needs it
//     calls loadPersona() (or an accessor below) when it runs, so a broken
//     declaration cannot break an import: a hook can still exit 0 doing
//     nothing, and a CLI can still say what is wrong.
//   - The format is checked (persona-declaration-1.x), and the declared name
//     must match the plugin the file sits in (.claude-plugin/plugin.json name,
//     else .codex-plugin/plugin.json).
//   - When the declaration is missing, malformed, of an unknown format or for
//     another plugin, loadPersona() throws PersonaDeclarationError. Nothing
//     falls back to another persona's paths: every state-writing command
//     refuses, and every hook does nothing.
//
// The loader checks the declaration's whole structure — the rules of
// persona-pipeline/persona.schema.json, restated here because a plugin carries
// no schema validator — so a schema-invalid declaration refuses writes like a
// missing one. tests/persona-pipeline/test-persona-declaration.mjs holds the
// two in step: every document the schema rejects, the loader rejects. The
// cross-field rules (the decide fallback equals the registry preset, ...) are
// checked at development time by scripts/sync-persona-pipeline.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORMAT_RE = /^persona-declaration-1\.(0|[1-9][0-9]*)$/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const CAPABILITIES = Object.freeze(['dispatch_target', 'commit_surface', 'legacy_homes', 'profile_presets']);
const ID_RE = /^[a-z][a-z0-9-]*$/;
const NOUN_RE = /^[a-z][a-z '/-]*[a-z]$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TOP_KEYS = ['schema', 'name', 'deliverable_noun', 'runtime_footer_floor', 'capabilities', 'decide'];
const DECIDE_KEYS = ['fallback', 'size_presets', 'profile_presets', 'tie_break'];

export class PersonaDeclarationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersonaDeclarationError';
  }
}

let cached = null;

/** The plugin directory this copy belongs to. */
export function personaPluginRoot() {
  return PLUGIN_ROOT;
}

function manifestName(root) {
  for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    try {
      const name = JSON.parse(text)?.name;
      if (typeof name === 'string' && name.length > 0) return name;
    } catch {
      /* try the other host's manifest */
    }
  }
  return null;
}

function readDeclaration(root) {
  const path = join(root, 'persona.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PersonaDeclarationError(
      `persona declaration ${path} is ${err.code === 'ENOENT' ? 'missing' : `unreadable (${err.code ?? err.message})`}; `
      + 'refusing to act without knowing which persona this plugin is (ADR-0066 Decision 2)',
    );
  }
  let d;
  try {
    d = JSON.parse(text);
  } catch (err) {
    throw new PersonaDeclarationError(`persona declaration ${path} is malformed JSON (${err.message})`);
  }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    throw new PersonaDeclarationError(`persona declaration ${path} is not a JSON object`);
  }
  if (typeof d.schema !== 'string' || !FORMAT_RE.test(d.schema)) {
    throw new PersonaDeclarationError(
      `persona declaration ${path} has an unknown format ${JSON.stringify(d.schema)} (expected persona-declaration-1.x)`,
    );
  }
  if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) {
    throw new PersonaDeclarationError(`persona declaration ${path} has no valid name`);
  }
  const minor = Number(FORMAT_RE.exec(d.schema)[1]);
  const problems = structureProblems(d, minor);
  if (problems.length > 0) {
    throw new PersonaDeclarationError(
      `persona declaration ${path} does not match persona-pipeline/persona.schema.json: ${problems.join('; ')}`,
    );
  }
  const plugin = manifestName(root);
  if (plugin === null) {
    throw new PersonaDeclarationError(
      `persona declaration ${path}: no plugin manifest (.claude-plugin/plugin.json or .codex-plugin/plugin.json) to check its name against`,
    );
  }
  if (plugin !== d.name) {
    throw new PersonaDeclarationError(
      `persona declaration ${path} names persona ${JSON.stringify(d.name)}, but it sits in plugin ${JSON.stringify(plugin)}`,
    );
  }
  return Object.freeze(d);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length <= 64 && ID_RE.test(v);

/**
 * The schema's structure, as a list of what is wrong (empty when valid). A
 * newer minor format may carry unknown top-level scalars; they are ignored, as
 * the schema validator ignores them (forward compatibility).
 */
function structureProblems(d, minor) {
  const problems = [];
  const no = (what) => problems.push(what);
  for (const key of Object.keys(d)) {
    if (TOP_KEYS.includes(key)) continue;
    if (minor > 0 && !isObject(d[key]) && !Array.isArray(d[key])) continue;
    no(`unknown key ${key}`);
  }
  if (d.name.length > 32) no('name longer than 32 characters');
  if (d.deliverable_noun !== undefined && !(typeof d.deliverable_noun === 'string' && d.deliverable_noun.length <= 64 && NOUN_RE.test(d.deliverable_noun))) no('invalid deliverable_noun');
  if (d.runtime_footer_floor !== undefined && !(typeof d.runtime_footer_floor === 'string' && SEMVER_RE.test(d.runtime_footer_floor))) no('invalid runtime_footer_floor');
  const caps = d.capabilities;
  if (!isObject(caps) || CAPABILITIES.some((c) => typeof caps[c] !== 'boolean') || Object.keys(caps).some((k) => !CAPABILITIES.includes(k))) {
    no(`capabilities must set exactly ${CAPABILITIES.join(', ')} to true or false`);
  }
  const decide = d.decide;
  if (!isObject(decide)) {
    no('decide is missing');
    return problems;
  }
  for (const key of Object.keys(decide)) if (!DECIDE_KEYS.includes(key)) no(`unknown key decide.${key}`);
  const fb = decide.fallback;
  if (!isObject(fb) || Object.keys(fb).some((k) => k !== 'preset_id' && k !== 'axes') || !isId(fb.preset_id)
    || !Array.isArray(fb.axes) || fb.axes.length < 2 || fb.axes.length > 16) {
    no('decide.fallback must be { preset_id, axes[2..16] }');
  } else {
    fb.axes.forEach((a, i) => {
      const ok = isObject(a)
        && Object.keys(a).every((k) => ['id', 'labels', 'question', 'role', 'gate'].includes(k))
        && isId(a.id)
        && isObject(a.labels) && Object.keys(a.labels).every((k) => k === 'en' || k === 'ko')
        && typeof a.labels.en === 'string' && a.labels.en.length <= 128
        && (a.labels.ko === null || (typeof a.labels.ko === 'string' && a.labels.ko.length <= 128))
        && typeof a.question === 'string' && a.question.length <= 2048
        && (a.role === 'decisive' || a.role === 'supporting')
        && typeof a.gate === 'boolean';
      if (!ok) no(`decide.fallback.axes[${i}] must be { id, labels {en, ko}, question, role, gate }`);
    });
  }
  const sizes = decide.size_presets;
  if (!isObject(sizes) || Object.keys(sizes).sort().join() !== 'major,minor,standard' || !Object.values(sizes).every(isId)) {
    no('decide.size_presets must map minor, standard and major to preset ids');
  }
  if (decide.profile_presets !== undefined
    && !(isObject(decide.profile_presets) && Object.entries(decide.profile_presets).every(([k, v]) => ID_RE.test(k) && isId(v)))) {
    no('decide.profile_presets must map profile ids to preset ids');
  }
  if (decide.tie_break !== undefined
    && !(Array.isArray(decide.tie_break) && decide.tie_break.length >= 1 && decide.tie_break.length <= 16 && decide.tie_break.every(isId))) {
    no('decide.tie_break must be a list of 1..16 axis ids');
  }
  return problems;
}

function field(d, path) {
  let cur = d;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * The validated declaration. `require` names the fields the caller reads
 * (dotted paths); a missing one throws.
 */
export function loadPersona({ require = [] } = {}) {
  if (cached === null) cached = readDeclaration(PLUGIN_ROOT);
  for (const path of require) {
    if (field(cached, path) === undefined) {
      throw new PersonaDeclarationError(
        `persona declaration ${join(PLUGIN_ROOT, 'persona.json')} lacks ${path}, which this script reads`,
      );
    }
  }
  return cached;
}

/** The persona name. */
export function personaName() {
  return loadPersona().name;
}

/** Whether the persona declares a capability on (ADR-0066 Decision 3). */
export function capabilityOn(capability) {
  if (!CAPABILITIES.includes(capability)) throw new PersonaDeclarationError(`unknown capability ${capability}`);
  return loadPersona().capabilities[capability] === true;
}

// ---- derived identity (V1) ----------------------------------------------------

/** `.agentic-plugins/state/<name>` — the persona's state home, repo-relative. */
export function stateDirRel() {
  return `.agentic-plugins/state/${personaName()}`;
}

/** `/<name>:` — the command prefix. */
export function commandPrefix() {
  return `/${personaName()}:`;
}

/** `<name>-active-metadata` — the SessionStart re-injection marker. */
export function metadataTag() {
  return `${personaName()}-active-metadata`;
}

/** `AGENTIC_<NAME>_PROFILE` — the L4 profile variable, read only with profile_presets on. */
export function profileEnvVar() {
  return `AGENTIC_${personaName().toUpperCase().replace(/-/g, '_')}_PROFILE`;
}

/**
 * For a CLI entry: load the declaration, or print why it cannot be loaded and
 * return false, so the caller exits non-zero before touching any state.
 */
export function personaOrRefuse(scriptName, stderr = process.stderr) {
  try {
    loadPersona();
    return true;
  } catch (err) {
    if (!(err instanceof PersonaDeclarationError)) throw err;
    stderr.write(`✗ ${scriptName}: ${err.message}\n`);
    return false;
  }
}
