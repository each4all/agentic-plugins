#!/usr/bin/env node
// kit/lint/check-plugin-shape.mjs — generic plugin-shape validator
//
// Validates that a directory has the canonical agentic-plugins plugin
// shape: a Claude manifest, a Codex manifest, consistent names, any
// shipped script files have the executable bit set, the Codex
// manifest's `skills` path (if declared) resolves to a real directory,
// every packaged SKILL.md carries conformant frontmatter, and a Claude
// hook registration (if shipped) is structurally valid with every
// plugin-rooted command target present.
//
// Skill frontmatter: every SKILL.md under the declared (and conventional)
// skills root is validated against the full rule set enforced by Codex's
// bundled skills/.system/skill-creator/scripts/quick_validate.py — allowed
// keys only, required name and description, hyphen-case name within 64
// chars, and a description that carries no angle brackets and stays within
// 1024 chars. Checking these here means a skill Codex would reject fails CI
// instead of being found by hand.
//
// Parity is measured against that validator's actual behaviour, not its
// source read literally: it loads through Path.read_text() (so CRLF is
// normalized and valid) and resolves plain scalars through PyYAML (so an
// unquoted `123`, `true`, `2026-08-03` or `*alias` is not a string and is
// rejected). Lengths are counted in code points and stripped with Python's
// whitespace set, because JavaScript's .length and trim() disagree with
// Python on emoji and on U+FEFF respectively.
//
// Two rules are deliberately STRICTER than that validator, both fail-closed:
// a duplicate frontmatter key is an error (PyYAML silently keeps the last),
// and a block scalar or multi-line value is rejected rather than measured,
// because this linter carries no YAML dependency and a parser that guessed
// at a value it cannot read exactly would make the whole check vacuous.
// Single-line quoted scalars are the repository convention; see kit/README.md.
//
// Script-bearing directories scanned for executable bit:
//   <plugin-dir>/scripts/                            (script-only library plugins)
//   <plugin-dir>/adapters/<host>/scripts/            (per-host adapter scripts)
//   <plugin-dir>/adapters/<host>/hooks/              (per-host hook entry scripts)
//
// Hook-bearing plugins (ADR-0040 §3 formalized the hook-only category —
// hooks + sensor scripts only, the hook-bearing sibling of the ADR-0008
// script-only shape): every Claude hook registration file must
//   - parse as JSON with a top-level `hooks` object mapping event names
//     to arrays of matcher groups,
//   - carry `type: "command"` entries with non-empty command strings,
//   - reference only existing files inside the plugin for every
//     `${CLAUDE_PLUGIN_ROOT}/…` command target (a hooks.json pointing at
//     a missing sensor script is the hook-only shape's core failure mode).
//
// Registration files come from TWO sources, both validated:
//   - the root default <plugin-dir>/hooks/hooks.json when it exists
//     (Codex default-file discovery also reads this location, so it is
//     always validated even when a manifest path is declared), and
//   - `.claude-plugin/plugin.json` `hooks` — a `./`-prefixed,
//     `.json`-suffixed, POSIX-separator plugin-relative string path or a
//     non-empty array of such strings (Claude Code also accepts an inline
//     object; the agentic-plugins canonical shape is file-backed JSON
//     following ADR-0006's layout convention — the rejection policy is set
//     by this linter). A declared path must exist, stay inside the plugin
//     both lexically and physically (existing targets are realpath-checked,
//     so an in-plugin symlink to outside content is rejected), and not
//     redeclare the root default — by real file identity, not just
//     spelling.
//
//   node kit/lint/check-plugin-shape.mjs <plugin-dir>
//
// Exit codes:
//   0 — plugin shape OK
//   1 — plugin-shape errors found
//   2 — misuse (bad arguments, plugin-dir not a directory)
//
// This is the "minimal" Stage 1 lint per Deliverable B.10, generalized
// in C.2 to handle adapter-bearing plugins (e.g., plugins/engineer/)
// and extended for ADR-0040's hook-only category. Additional checks
// (drift detection, SemVer cross-version constraints, marketplace
// registration coverage) remain in their own scripts/tests and may be
// folded in here as the kit/lint surface matures.

import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node kit/lint/check-plugin-shape.mjs <plugin-dir>');
  process.exit(2);
}

const PLUGIN_DIR = resolve(args[0]);

let pluginStat;
try {
  pluginStat = await stat(PLUGIN_DIR);
} catch (err) {
  console.error(`✗ ${PLUGIN_DIR}: ${err.message}`);
  process.exit(2);
}
if (!pluginStat.isDirectory()) {
  console.error(`✗ ${PLUGIN_DIR}: not a directory`);
  process.exit(2);
}

const errors = [];

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function checkManifest(label, path, requiredScalarFields) {
  if (!(await exists(path))) {
    errors.push(`${label}: missing`);
    return null;
  }
  let json;
  try {
    json = await readJSON(path);
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
  for (const field of requiredScalarFields) {
    if (typeof json[field] !== 'string' || json[field].length === 0) {
      errors.push(`${label}: ${field} must be non-empty string`);
    }
  }
  return json;
}

const claudePath = resolve(PLUGIN_DIR, '.claude-plugin/plugin.json');
const codexPath = resolve(PLUGIN_DIR, '.codex-plugin/plugin.json');

const claudeManifest = await checkManifest('.claude-plugin/plugin.json', claudePath, [
  'name',
  'version',
  'description',
]);
const codexManifest = await checkManifest('.codex-plugin/plugin.json', codexPath, [
  'name',
  'version',
  'description',
]);

if (codexManifest && codexManifest.interface !== undefined) {
  if (typeof codexManifest.interface !== 'object' || codexManifest.interface === null || Array.isArray(codexManifest.interface)) {
    errors.push('.codex-plugin/plugin.json: interface must be object when present');
  }
}

if (claudeManifest && codexManifest && claudeManifest.name !== codexManifest.name) {
  errors.push(`manifest name mismatch — claude="${claudeManifest.name}" vs codex="${codexManifest.name}"`);
}

async function checkScriptsDir(label, dir) {
  if (!(await exists(dir))) return;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js') && !entry.name.endsWith('.sh')) continue;
    const filePath = resolve(dir, entry.name);
    try {
      const st = await stat(filePath);
      if ((st.mode & 0o111) === 0) {
        errors.push(`${label}/${entry.name}: executable bit not set`);
      }
    } catch (err) {
      errors.push(`${label}/${entry.name}: ${err.message}`);
    }
  }
}

await checkScriptsDir('scripts', resolve(PLUGIN_DIR, 'scripts'));

const adaptersDir = resolve(PLUGIN_DIR, 'adapters');
if (await exists(adaptersDir)) {
  let hostEntries = [];
  try {
    hostEntries = await readdir(adaptersDir, { withFileTypes: true });
  } catch (err) {
    errors.push(`adapters/: ${err.message}`);
  }
  for (const host of hostEntries) {
    if (!host.isDirectory()) continue;
    const hostScripts = resolve(adaptersDir, host.name, 'scripts');
    await checkScriptsDir(`adapters/${host.name}/scripts`, hostScripts);
    const hostHooks = resolve(adaptersDir, host.name, 'hooks');
    await checkScriptsDir(`adapters/${host.name}/hooks`, hostHooks);
  }
}

// Claude hook registration — structural validation plus command-target
// existence for every `${CLAUDE_PLUGIN_ROOT}/…` reference. Hook absence is
// non-fatal (ADR-0011 §4); hook-only plugins per ADR-0040 §3 hinge on their
// shape tests to require presence. Known edge (pre-existing): the command
// regex reads targets out of quoted commands textually, so an unquoted
// command with unusual shell quoting can yield a false missing-target
// diagnostic.
const HOOK_COMMAND_ROOT_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/g;

// Containment is checked twice: a LEXICAL gate via path arithmetic
// (`relative()` handles `..` traversal and absolute escapes, and works for
// paths that do not exist yet), then — for targets that exist — a PHYSICAL
// gate comparing `realpath()` on both sides, so a symlink inside the plugin
// pointing at a file outside it is rejected rather than silently linted as
// in-plugin content (and a symlinked plugin root itself stays legitimate,
// because both sides resolve through the same realpath).
function escapesDir(baseDir, absTarget) {
  const rel = relative(baseDir, absTarget);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function escapesPluginDir(absTarget) {
  return escapesDir(PLUGIN_DIR, absTarget);
}

let realPluginDirPromise = null;
function realPluginDir() {
  realPluginDirPromise ??= realpath(PLUGIN_DIR).catch(() => PLUGIN_DIR);
  return realPluginDirPromise;
}

// Physical containment for an EXISTING path; returns the real path when it
// stays inside the plugin, or null when it resolves outside (symlink escape)
// or cannot be resolved.
async function containedRealPath(absTarget) {
  try {
    const realBase = await realPluginDir();
    const realTarget = await realpath(absTarget);
    if (escapesDir(realBase, realTarget)) return null;
    return realTarget;
  } catch {
    return null;
  }
}

async function checkHooksJson(label, path) {
  if (!(await exists(path))) return;
  let json;
  try {
    json = await readJSON(path);
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return;
  }
  const hooks = json?.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    errors.push(`${label}: top-level "hooks" must be an object mapping event names to matcher-group arrays`);
    return;
  }
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.length === 0) {
      errors.push(`${label}: "${eventName}" must be a non-empty array of matcher groups`);
      continue;
    }
    for (const [gi, group] of groups.entries()) {
      const groupLabel = `${label}: "${eventName}"[${gi}]`;
      if (typeof group !== 'object' || group === null || Array.isArray(group)) {
        errors.push(`${groupLabel}: matcher group must be an object`);
        continue;
      }
      if (group.matcher !== undefined && (typeof group.matcher !== 'string' || group.matcher.length === 0)) {
        errors.push(`${groupLabel}: matcher must be a non-empty string when present`);
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        errors.push(`${groupLabel}: hooks must be a non-empty array`);
        continue;
      }
      for (const [hi, hook] of group.hooks.entries()) {
        const hookLabel = `${groupLabel}.hooks[${hi}]`;
        if (typeof hook !== 'object' || hook === null || Array.isArray(hook)) {
          errors.push(`${hookLabel}: hook entry must be an object`);
          continue;
        }
        if (hook.type !== 'command') {
          errors.push(`${hookLabel}: type must be "command"`);
        }
        if (typeof hook.command !== 'string' || hook.command.length === 0) {
          errors.push(`${hookLabel}: command must be a non-empty string`);
          continue;
        }
        const rootMatches = [...hook.command.matchAll(HOOK_COMMAND_ROOT_RE)];
        // A plugin hook command that references no ${CLAUDE_PLUGIN_ROOT}
        // target ships no plugin-owned behavior and dodges the existence
        // check entirely — reject rather than silently pass.
        if (rootMatches.length === 0) {
          errors.push(`${hookLabel}: command must reference at least one \${CLAUDE_PLUGIN_ROOT}/… target`);
          continue;
        }
        for (const match of rootMatches) {
          const target = resolve(PLUGIN_DIR, match[1]);
          if (escapesPluginDir(target)) {
            errors.push(`${hookLabel}: command target "${match[1]}" escapes the plugin directory`);
            continue;
          }
          let targetStat;
          try {
            targetStat = await stat(target);
          } catch {
            errors.push(`${hookLabel}: command target "${match[1]}" does not exist`);
            continue;
          }
          if (!targetStat.isFile()) {
            errors.push(`${hookLabel}: command target "${match[1]}" is not a regular file`);
            continue;
          }
          if ((await containedRealPath(target)) === null) {
            errors.push(`${hookLabel}: command target "${match[1]}" resolves outside the plugin directory (symlink)`);
          }
        }
      }
    }
  }
}

// Collect `.claude-plugin/plugin.json` `hooks` declarations into validated,
// deduplicated plugin-relative paths. Returns canonical relative paths for
// entries that pass the shape checks; shape violations land in `errors`.
function collectDeclaredHookPaths(manifest) {
  const value = manifest?.hooks;
  if (value === undefined) return [];
  const manifestLabel = '.claude-plugin/plugin.json';
  let entries;
  if (typeof value === 'string') {
    entries = [{ raw: value, label: `${manifestLabel}: hooks` }];
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      errors.push(`${manifestLabel}: hooks must not be an empty array`);
      return [];
    }
    entries = value.map((raw, i) => ({ raw, label: `${manifestLabel}: hooks[${i}]` }));
  } else if (typeof value === 'object' && value !== null) {
    errors.push(`${manifestLabel}: inline hooks config is not supported by the agentic-plugins file-backed shape (ADR-0006) — declare a ./-relative .json path instead`);
    return [];
  } else {
    errors.push(`${manifestLabel}: hooks must be a ./-relative string path or an array of string paths`);
    return [];
  }

  const seen = new Map();
  const declared = [];
  for (const { raw, label } of entries) {
    if (typeof raw !== 'string') {
      errors.push(`${label} must be a string path (inline hook objects are not supported by the agentic-plugins file-backed shape)`);
      continue;
    }
    if (raw.length === 0) {
      errors.push(`${label} must be a non-empty string path`);
      continue;
    }
    if (raw.includes('\\')) {
      errors.push(`${label}: declared hooks path "${raw}" must use POSIX separators (no backslashes)`);
      continue;
    }
    if (!raw.startsWith('./')) {
      errors.push(`${label}: declared hooks path "${raw}" must start with "./"`);
      continue;
    }
    if (!raw.endsWith('.json')) {
      errors.push(`${label}: declared hooks path "${raw}" must end with ".json"`);
      continue;
    }
    const abs = resolve(PLUGIN_DIR, raw);
    if (escapesPluginDir(abs)) {
      errors.push(`${label}: declared hooks path "${raw}" escapes the plugin directory`);
      continue;
    }
    const canonical = normalize(relative(PLUGIN_DIR, abs));
    if (canonical === normalize('hooks/hooks.json')) {
      errors.push(`${label}: declared hooks path "${raw}" redeclares the default hooks/hooks.json — remove the declaration or move the file`);
      continue;
    }
    if (seen.has(canonical)) {
      errors.push(`${label}: duplicate declared hooks path "${raw}" (already declared as "${seen.get(canonical)}")`);
      continue;
    }
    seen.set(canonical, raw);
    declared.push({ raw, label, abs, canonical });
  }
  return declared;
}

{
  const rootDefaultAbs = resolve(PLUGIN_DIR, 'hooks/hooks.json');
  const rootDefaultReal = await containedRealPath(rootDefaultAbs);
  const seenReal = new Map();
  for (const entry of collectDeclaredHookPaths(claudeManifest)) {
    let st;
    try {
      st = await stat(entry.abs);
    } catch {
      errors.push(`${entry.label}: declared hooks path "${entry.raw}" does not exist`);
      continue;
    }
    if (!st.isFile()) {
      errors.push(`${entry.label}: declared hooks path "${entry.raw}" is not a regular file`);
      continue;
    }
    const real = await containedRealPath(entry.abs);
    if (real === null) {
      errors.push(`${entry.label}: declared hooks path "${entry.raw}" resolves outside the plugin directory (symlink)`);
      continue;
    }
    if (rootDefaultReal !== null && real === rootDefaultReal) {
      errors.push(`${entry.label}: declared hooks path "${entry.raw}" redeclares the default hooks/hooks.json — remove the declaration or move the file`);
      continue;
    }
    if (seenReal.has(real)) {
      errors.push(`${entry.label}: duplicate declared hooks path "${entry.raw}" (already declared as "${seenReal.get(real)}")`);
      continue;
    }
    seenReal.set(real, entry.raw);
    await checkHooksJson(entry.canonical, entry.abs);
  }
}

// The root default is validated whenever it exists — including alongside a
// declared custom path — because Codex default-file discovery reads this
// location regardless of the Claude manifest (host truth, 0.144.1).
await checkHooksJson('hooks/hooks.json', resolve(PLUGIN_DIR, 'hooks/hooks.json'));

if (codexManifest && typeof codexManifest.skills === 'string' && codexManifest.skills.length > 0) {
  const skillsPath = resolve(PLUGIN_DIR, codexManifest.skills);
  if (!(await exists(skillsPath))) {
    errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" does not resolve to an existing directory`);
  } else {
    try {
      const st = await stat(skillsPath);
      if (!st.isDirectory()) {
        errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" is not a directory`);
      }
    } catch (err) {
      errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" stat failed: ${err.message}`);
    }
  }
}

// --- Skill frontmatter conformance (Codex skill-creator rule set) ---------
//
// Mirrors every rule in Codex's bundled
// skills/.system/skill-creator/scripts/quick_validate.py, so a packaged
// skill that Codex would reject fails here first. Checking only the
// description length would leave the sibling rules (angle brackets,
// allowed keys, name shape) to be found by hand — which is how the
// over-cap descriptions this check was added for were found.

const SKILL_ALLOWED_KEYS = ['allowed-tools', 'description', 'license', 'metadata', 'name'];
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
// Traversal bounds mirroring Codex's own skill discovery, so a pathological
// tree cannot turn a lint run into an unbounded filesystem walk.
const MAX_SKILL_SCAN_DEPTH = 6;
const MAX_SKILL_SCAN_DIRS = 2000;
const MAX_SKILL_SCAN_ENTRIES = 20000;

// Python's str.strip() removes exactly the characters str.isspace() accepts.
// That set is NOT JavaScript's trim(): Python also strips U+001C..U+001F and
// U+0085, and — the case that matters — does NOT strip U+FEFF, which trim()
// does. Measuring with trim() therefore under-counts a description ending in
// a BOM and lets an over-cap value through.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
const pythonStrip = (s) => s.replace(PY_STRIP_RE, '');

// Python's len() counts code points; JavaScript's .length counts UTF-16 code
// units, so a description containing an emoji measures two units per code
// point and would be rejected at a length Codex accepts.
const codePointLength = (s) => [...s].length;

// Implicit-resolver patterns transliterated from PyYAML's
// Resolver.yaml_implicit_resolvers (re.X whitespace removed) — the resolver
// quick_validate.py runs through. A plain scalar matching any of these is
// NOT a string there, and quick_validate rejects it for that reason. Reading
// every plain scalar as a string is the permissive direction, so this
// classifies instead.
const YAML_NULL = /^(?:~|null|Null|NULL|)$/;
const YAML_BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const YAML_INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const YAML_FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const YAML_TIMESTAMP = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;
// `&anchor`, `*alias`, flow collections and comments are structure, not text.
// The alias case is load-bearing: `description: *long` measures five
// characters here but resolves to the anchored value in PyYAML, which is how
// an over-cap description could otherwise pass this gate.
const YAML_INDICATOR_START = /^[,[\]{}#&*!%@`]/;
// `-`, `?` and `:` open structure only when alone or followed by a space;
// `-foo` and `:x` are ordinary plain strings.
const YAML_SPACED_INDICATOR = /^[-?:]([ \t]|$)/;

function plainScalarKind(text) {
  if (YAML_NULL.test(text)) return 'null';
  if (YAML_BOOL.test(text)) return 'a boolean';
  if (YAML_INT.test(text)) return 'an integer';
  if (YAML_FLOAT.test(text)) return 'a float';
  if (YAML_TIMESTAMP.test(text)) return 'a timestamp';
  if (text === '=' || text === '<<') return 'a YAML directive';
  if (YAML_INDICATOR_START.test(text) || YAML_SPACED_INDICATOR.test(text)) return 'a YAML structure indicator';
  if (/:([ \t]|$)/.test(text)) return 'a nested mapping';
  return null;
}

class SkillScanError extends Error {}

// Collect every SKILL.md at or below `dir`. Symlinks are resolved (a
// symlinked skill directory or SKILL.md is real content and must be
// checked), with physical containment enforced so a link cannot walk the
// scan out of the plugin. A missing directory is not an error — the
// manifest check owns that — but any other readdir failure is fatal rather
// than a silently empty subtree, which would lint an unreadable tree clean.
async function collectSkillFiles(dir, budget, depth = 0) {
  const found = [];
  if (depth > MAX_SKILL_SCAN_DEPTH) return found;
  if (++budget.dirs > MAX_SKILL_SCAN_DIRS) {
    throw new SkillScanError(`skill scan exceeded ${MAX_SKILL_SCAN_DIRS} directories`);
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return found;
    throw new SkillScanError(`cannot read "${relative(PLUGIN_DIR, dir).split(sep).join('/')}": ${err.message}`);
  }
  for (const entry of entries) {
    if (++budget.entries > MAX_SKILL_SCAN_ENTRIES) {
      throw new SkillScanError(`skill scan exceeded ${MAX_SKILL_SCAN_ENTRIES} entries`);
    }
    // Codex's discovery skips hidden directories; matching that keeps .git
    // and friends out of the walk.
    if (entry.name.startsWith('.')) continue;
    const abs = resolve(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const real = await containedRealPath(abs);
      if (real === null) continue; // dangling, or escapes the plugin
      try {
        const st = await stat(abs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      found.push(...(await collectSkillFiles(abs, budget, depth + 1)));
    } else if (isFile && entry.name === 'SKILL.md') {
      found.push(abs);
    }
  }
  return found;
}

// Parse one single-line YAML scalar (plain, 'single-quoted', or
// "double-quoted"). Returns {value} or {error}. It never guesses at a form
// it cannot measure: a parser that silently yielded a truncated value would
// make this whole check vacuously green, which is the precise failure it
// exists to prevent.
const DQ_ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r',
  e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: ' ', P: ' ',
};

function parseSingleLineScalar(raw) {
  const text = pythonStrip(raw);
  // No early return for the empty value: PyYAML resolves it to None, which
  // quick_validate.py rejects, so it must reach the plain-scalar classifier
  // below rather than be handed back as an empty string.
  if (text.startsWith('|') || text.startsWith('>')) {
    return { error: 'block scalar (| or >) is not measurable by this check — use a single-line quoted scalar' };
  }
  if (text.startsWith('"')) {
    let out = '';
    let i = 1;
    for (; i < text.length && text[i] !== '"'; i++) {
      if (text[i] !== '\\') {
        out += text[i];
        continue;
      }
      const next = text[i + 1];
      const hex = { x: 2, u: 4, U: 8 }[next];
      if (next !== undefined && next in DQ_ESCAPES) {
        out += DQ_ESCAPES[next];
        i += 1;
      } else if (hex && new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(text.slice(i + 2, i + 2 + hex))) {
        out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + hex), 16));
        i += 1 + hex;
      } else {
        return { error: `unsupported escape "\\${next ?? ''}" in double-quoted scalar` };
      }
    }
    if (text[i] !== '"') {
      return { error: 'unterminated double-quoted scalar — a multi-line scalar is not measurable by this check' };
    }
    const trailing = pythonStrip(text.slice(i + 1));
    if (trailing !== '' && !trailing.startsWith('#')) {
      return { error: 'unexpected content after the closing quote — PyYAML rejects this as invalid YAML' };
    }
    return { value: out };
  }
  if (text.startsWith("'")) {
    let out = '';
    let i = 1;
    for (; i < text.length; i++) {
      if (text[i] !== "'") {
        out += text[i];
        continue;
      }
      if (text[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      break;
    }
    if (text[i] !== "'") {
      return { error: 'unterminated single-quoted scalar — a multi-line scalar is not measurable by this check' };
    }
    const trailing = pythonStrip(text.slice(i + 1));
    if (trailing !== '' && !trailing.startsWith('#')) {
      return { error: 'unexpected content after the closing quote — PyYAML rejects this as invalid YAML' };
    }
    return { value: out };
  }
  const comment = text.search(/\s#/);
  const plain = pythonStrip(comment === -1 ? text : text.slice(0, comment));
  const kind = plainScalarKind(plain);
  if (kind !== null) {
    return { error: `must be a quoted string — YAML reads this unquoted value as ${kind}` };
  }
  return { value: plain, plain: true };
}

async function checkSkillFrontmatter(label, path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    errors.push(`${label}: read failed: ${err.message}`);
    return;
  }
  // quick_validate.py reads through Path.read_text(), whose universal-newline
  // translation turns CRLF (and lone CR) into LF before its `^---\n` regex
  // ever runs — so a CRLF SKILL.md is valid there. Normalizing the same way
  // keeps this check from rejecting a file Codex accepts.
  const normalized = content.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---')) {
    errors.push(`${label}: no YAML frontmatter found`);
    return;
  }
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) {
    errors.push(`${label}: invalid frontmatter format`);
    return;
  }

  const fields = new Map();
  let lastKey = null;
  for (const line of match[1].split('\n')) {
    if (pythonStrip(line) === '' || pythonStrip(line).startsWith('#')) continue;
    if (/^[ \t]/.test(line)) {
      // Indented continuation. Allowed under a structured key such as
      // `metadata`, which this check does not measure; fatal under a key it
      // must measure, because the value then spans lines.
      if (lastKey === 'name' || lastKey === 'description') {
        errors.push(`${label}: "${lastKey}" spans multiple lines — not measurable by this check, use a single-line quoted scalar`);
        return;
      }
      continue;
    }
    const parsed = /^([^:]+):(.*)$/.exec(line);
    if (!parsed) {
      errors.push(`${label}: unparsable frontmatter line: "${pythonStrip(line).slice(0, 48)}"`);
      return;
    }
    // A quoted key is the same key to PyYAML, so unwrap before comparing.
    lastKey = pythonStrip(parsed[1]).replace(/^(["'])(.*)\1$/, '$2');
    if (fields.has(lastKey)) {
      // Stricter than PyYAML, which silently keeps the last value. A
      // duplicated key in a shipped skill is a defect either way.
      errors.push(`${label}: duplicate frontmatter key "${lastKey}"`);
      return;
    }
    fields.set(lastKey, parsed[2]);
  }

  const unexpected = [...fields.keys()].filter((k) => !SKILL_ALLOWED_KEYS.includes(k)).sort();
  if (unexpected.length > 0) {
    errors.push(`${label}: unexpected frontmatter key(s): ${unexpected.join(', ')} (allowed: ${SKILL_ALLOWED_KEYS.join(', ')})`);
  }

  for (const field of ['name', 'description']) {
    if (!fields.has(field)) errors.push(`${label}: missing "${field}" in frontmatter`);
  }

  if (fields.has('name')) {
    const scalar = parseSingleLineScalar(fields.get('name'));
    if (scalar.error) {
      errors.push(`${label}: name ${scalar.error}`);
    } else {
      const name = pythonStrip(scalar.value);
      if (name !== '') {
        if (!/^[a-z0-9-]+$/.test(name)) {
          errors.push(`${label}: name "${name}" must be hyphen-case (lowercase letters, digits, and hyphens only)`);
        } else if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
          errors.push(`${label}: name "${name}" cannot start/end with a hyphen or contain consecutive hyphens`);
        }
        if (codePointLength(name) > MAX_SKILL_NAME_LENGTH) {
          errors.push(`${label}: name is too long (${codePointLength(name)} characters, maximum is ${MAX_SKILL_NAME_LENGTH})`);
        }
      }
    }
  }

  if (fields.has('description')) {
    const scalar = parseSingleLineScalar(fields.get('description'));
    if (scalar.error) {
      errors.push(`${label}: description ${scalar.error}`);
    } else {
      const description = pythonStrip(scalar.value);
      if (description !== '') {
        if (description.includes('<') || description.includes('>')) {
          errors.push(`${label}: description cannot contain angle brackets (< or >)`);
        }
        if (codePointLength(description) > MAX_SKILL_DESCRIPTION_LENGTH) {
          errors.push(`${label}: description is too long (${codePointLength(description)} characters, maximum is ${MAX_SKILL_DESCRIPTION_LENGTH})`);
        }
      }
    }
  }
}

// Scan the manifest-declared skills root and the conventional one. Codex
// itself uses the declared root and falls back to the conventional one;
// checking both is deliberately broader, so a skill directory that is
// packaged but not declared still gets linted. A directory without a
// SKILL.md (e.g. skills/_shared/) is not a skill and is simply not
// collected.
const skillsRoots = [];
if (codexManifest && typeof codexManifest.skills === 'string' && codexManifest.skills.length > 0) {
  const declared = resolve(PLUGIN_DIR, codexManifest.skills);
  if (escapesPluginDir(declared)) {
    errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" escapes the plugin directory`);
  } else {
    skillsRoots.push(declared);
  }
}
const conventionalSkillsRoot = resolve(PLUGIN_DIR, 'skills');
if (!skillsRoots.includes(conventionalSkillsRoot)) skillsRoots.push(conventionalSkillsRoot);

const seenSkillFiles = new Set();
const scanBudget = { dirs: 0, entries: 0 };
for (const root of skillsRoots) {
  let files;
  try {
    files = await collectSkillFiles(root, scanBudget);
  } catch (err) {
    if (!(err instanceof SkillScanError)) throw err;
    errors.push(`skills scan: ${err.message}`);
    continue;
  }
  for (const file of files) {
    // Deduplicate by real path so two roots aliased by a symlink do not
    // report the same file twice.
    const key = (await containedRealPath(file)) ?? file;
    if (seenSkillFiles.has(key)) continue;
    seenSkillFiles.add(key);
    await checkSkillFrontmatter(relative(PLUGIN_DIR, file).split(sep).join('/'), file);
  }
}

if (errors.length > 0) {
  console.error(`✗ ${PLUGIN_DIR}:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const name = claudeManifest?.name ?? codexManifest?.name ?? '<unknown>';
console.log(`✓ ${PLUGIN_DIR}: plugin "${name}" shape OK`);
