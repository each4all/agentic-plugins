// ADR-0071 — the autopilot's model and effort settings: the `autopilot_*` keys
// of `.agentic-plugins/config.toml`, read once when a run starts.
//
// A copy of the runtime's flat-key contract (plugins/runtime/scripts/lib/
// runtime-config.mjs: CONFIG_KEY_FAMILIES.autopilot, its validators and the
// line scan), not an import: a plugin never loads another plugin's code
// (ADR-0010 §5). tests/orchestrator/test-autopilot-model-settings.mjs holds the
// two equal: the key list, and the values each validator accepts and refuses.
//
// The rules the copy keeps from the runtime's reader:
//   * two layers, the repository's `.agentic-plugins/config.toml` over the
//     user's `~/.agentic-plugins/config.toml`, per key;
//   * a `#` comment is stripped, a `[table]` header ends what is read;
//   * `.` and `-` in a key read as `_`; a later line of a key wins;
//   * an empty value is kept and validated (so it refuses), never dropped, or a
//     lower layer would win against the value the higher one set;
//   * only ENOENT and ENOTDIR read as an absent layer; any other read failure
//     refuses the whole read;
//   * the value that wins is validated after layering, as the runtime's
//     loadEffectiveConfig does: an invalid winning value refuses the read (a
//     broken config never starts a run on a guess), while an invalid user value
//     a repository value shadows is not read at all (the runtime's settings
//     report warns of it).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveModelTable } from './policy.mjs';

export const MODEL_STEPS = Object.freeze(['investigate', 'frame', 'decide', 'compose', 'critique', 'refine', 'commit', 'done', 'finalize']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
export const AUTOPILOT_KEYS = Object.freeze([
  'autopilot_model',
  'autopilot_effort',
  ...MODEL_STEPS.flatMap((step) => [`autopilot_${step}_model`, `autopilot_${step}_effort`]),
]);

/** The one check of a model or effort value: the CLI's flags and the settings keys. Returns an error message, or null. */
export function modelValueProblem(coord, value, label) {
  if (coord === 'effort') return EFFORTS.includes(value) ? null : `${label} must be one of ${EFFORTS.join(', ')}`;
  return MODEL_RE.test(value) ? null : `${label} ${JSON.stringify(value)} is not a model name`;
}

const coordOf = (key) => (key.endsWith('_effort') ? 'effort' : 'model');

function scanKeys(text) {
  const found = {};
  for (const line of String(text).split('\n')) {
    const body = line.replace(/\r$/, '').replace(/#.*/, '').trim();
    if (!body) continue;
    if (body.startsWith('[')) break;
    const m = body.match(/^([A-Za-z0-9_.-]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (!m) continue;
    const key = m[1].replace(/[.-]/g, '_');
    if (AUTOPILOT_KEYS.includes(key)) found[key] = m[3].trim();
  }
  return found;
}

function readLayer(file) {
  try {
    return { text: readFileSync(file, 'utf8'), error: null };
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { text: '', error: null };
    return { text: null, error: `${file}: ${e?.code ?? e?.message ?? 'unreadable'}` };
  }
}

/**
 * The autopilot keys the two layers set: {ok: true, values: {key: {value,
 * layer}}} with only the keys some layer sets, or {ok: false, errors}.
 */
export function readModelSettings({ repoRoot, homeDir = homedir() } = {}) {
  const layers = [
    ['repo', join(repoRoot, '.agentic-plugins', 'config.toml')],
    ['user', join(homeDir, '.agentic-plugins', 'config.toml')],
  ].map(([layer, file]) => ({ layer, file, ...readLayer(file) }));
  const unreadable = layers.filter((l) => l.error !== null);
  if (unreadable.length > 0) return { ok: false, errors: unreadable.map((l) => `config layer unreadable: ${l.error}`) };
  const scanned = layers.map((l) => ({ ...l, keys: scanKeys(l.text) }));
  const values = {};
  const errors = [];
  for (const key of AUTOPILOT_KEYS) {
    const l = scanned.find((x) => Object.hasOwn(x.keys, key));
    if (!l) continue;
    const problem = modelValueProblem(coordOf(key), l.keys[key], `${key} (${l.file})`);
    if (problem) errors.push(problem);
    else values[key] = { value: l.keys[key], layer: l.layer };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, values };
}

/**
 * The run's model table, prepared once (ADR-0071 D5): the start question shows
 * it, startRun records it as `options.model_table`, and every step reads it.
 * {ok: true, table, settings, anySet} — settings the values read, anySet when
 * some layer sets an autopilot key —
 * or {ok: false, errors} when the settings cannot be read or one is invalid.
 */
export function prepareModelTable({ repoRoot, options = {}, homeDir = homedir() } = {}) {
  const read = readModelSettings({ repoRoot, homeDir });
  if (!read.ok) return { ok: false, errors: read.errors };
  const table = resolveModelTable({
    preset: options.models ?? null,
    flags: { model: options.model ?? null, effort: options.effort ?? null },
    settings: read.values,
  });
  return { ok: true, table, settings: read.values, anySet: Object.keys(read.values).length > 0 };
}
