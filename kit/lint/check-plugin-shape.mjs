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

import { readFile, lstat, realpath, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

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

// --- Relocation invariant (ADR-0006 Amendment) ----------------------------
//
// When the Codex manifest points the skills root somewhere other than the
// conventional plugins/<p>/skills, Claude Code's conventional discovery must
// find nothing there. Four clauses, each measured against Claude Code 2.1.276
// with `claude --plugin-dir <dir> plugin details <name>` on a relocated copy
// of plugins/image:
//
//   1. skills/ must EXIST. With it deleted, a plugin-root SKILL.md registers
//      (Skills 6 -> 7). With a README-only skills/ present, the same root
//      SKILL.md does not. The tombstone is a mechanism, not documentation.
//   2. No SKILL.md reachable under skills/. A per-skill symlink
//      skills/frame -> ../core/skills/frame re-registers (6 -> 7, ~232 ->
//      ~389 always-on tok). A container-level link did not re-register at
//      that version; it is rejected anyway, because the conventional root
//      must be inert and this check should not have to track which link
//      depths a given host release follows.
//   3. No plugin-root SKILL.md. Clause 1 suppresses it today; stating it
//      separately keeps a future relaxation of clause 1 from silently
//      re-opening the path.
//   4. The CLAUDE manifest must not declare the relocated root. Adding
//      "skills": "./core/skills/" there restores every duplicate
//      registration (Skills 6 -> 12, ~232 -> ~1,183 always-on tok) — the
//      exact state the relocation removes — and nothing else notices.
//
// This walk is deliberately NOT collectSkillFiles. That collector stops past
// MAX_SKILL_SCAN_DEPTH, skips hidden entries, and resolves symlinks — all
// correct for "find the skills worth linting", all wrong for "prove there are
// none". Proving absence has to fail closed on everything it cannot read.
// The shared skill scan budgets 20000 entries because it walks real skill
// trees. This walk only has to prove a tombstone directory is inert, and a
// tombstone holds one README, so the bound is set to what that directory is
// supposed to contain rather than to what a skill tree may. Exceeding it is
// reported, never silently treated as absence.
const MAX_RELOCATION_SCAN_ENTRIES = 1000;

async function walkConventionalRoot(dir, budget, onFinding) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    onFinding(`cannot read "${rel(dir)}" to prove it holds no skills: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (++budget.entries > MAX_RELOCATION_SCAN_ENTRIES) {
      onFinding(`gave up proving absence after ${MAX_RELOCATION_SCAN_ENTRIES} entries under "${rel(dir)}"`);
      return;
    }
    const abs = resolve(dir, entry.name);
    // Symlinks are reported, never followed: following one would make the
    // proof depend on the target, and a dangling link would read as clean.
    if (entry.isSymbolicLink()) {
      onFinding(`"${rel(abs)}" is a symlink; the conventional root must be inert`);
      continue;
    }
    if (entry.isDirectory()) {
      await walkConventionalRoot(abs, budget, onFinding);
      continue;
    }
    if (entry.name === 'SKILL.md') {
      onFinding(`"${rel(abs)}" would still register as a Claude skill`);
    }
  }
}

function rel(abs) {
  return relative(PLUGIN_DIR, abs).split(sep).join('/') || '.';
}

// Assert the four clauses for a plugin whose declared skills root is not the
// conventional one. Every finding is prefixed so one grep-able phrase covers
// the whole rule.
async function checkRelocatedConventionalRoot(conventionalRoot, declaredSpelling) {
  const findings = [];
  const add = (msg) => findings.push(msg);

  let info = null;
  try {
    info = await lstat(conventionalRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      add(
        `"${rel(conventionalRoot)}/" is missing. Keep it as a tombstone directory (a README is enough): `
        + 'with it absent, a plugin-root SKILL.md becomes discoverable again.',
      );
    } else {
      add(`cannot stat "${rel(conventionalRoot)}": ${err.message}`);
    }
  }

  if (info?.isSymbolicLink()) {
    add(`"${rel(conventionalRoot)}" is a symlink; the conventional root must be a real, inert directory`);
  } else if (info && !info.isDirectory()) {
    add(`"${rel(conventionalRoot)}" is not a directory`);
  } else if (info) {
    await walkConventionalRoot(conventionalRoot, { entries: 0 }, add);
  }

  const rootSkill = resolve(PLUGIN_DIR, 'SKILL.md');
  if (await exists(rootSkill)) {
    add('"SKILL.md" at the plugin root would register as a Claude skill');
  }

  // Clause 4 — the CLAUDE manifest must stay silent. Codex resolves its root
  // from its own manifest; Claude has no such key and discovers by convention,
  // which is the entire reason relocating works. Declaring the relocated root
  // in `.claude-plugin/plugin.json` reads like finishing the job and silently
  // undoes it: measured on plugins/image at Claude Code 2.1.276, adding
  // `"skills": "./core/skills/"` there took `Skills (6)` / ~232 always-on tok
  // back to `Skills (12)` / ~1,183, every capability registered twice again,
  // while this linter and the plugin's own shape test both stayed green.
  if (claudeManifest && claudeManifest.skills !== undefined) {
    add(
      '".claude-plugin/plugin.json" declares "skills" — it must stay silent for a relocated '
      + 'plugin. Claude Code discovers skills by convention, so naming the relocated root there '
      + 're-registers every skill alongside its command (measured on plugins/image: Skills 6 -> 12, '
      + '~232 -> ~1,183 always-on tok).',
    );
  }

  for (const finding of findings) {
    errors.push(`relocated skills root (declared "${declaredSpelling}"): ${finding}`);
  }
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

// --- Skill agent manifest conformance (Codex plugin-validation rule set) ---
//
// Mirrors validate_skill_agent_manifest in the plugin validator Codex bundles
// at skills/.system/plugin-creator/scripts/validate_plugin.py (read directly
// from disk 2026-09-10; those bytes match the copy embedded in codex-cli
// 0.154.0). The rules, in its order:
//   payload must be a mapping
//   top-level keys subset of {interface, policy, dependencies}
//   interface must be a mapping (otherwise Codex stops there)
//   interface keys subset of {display_name, short_description, icon_small,
//     icon_large, brand_color, default_prompt}
//   display_name, short_description: a string, non-empty after stripping
//   icon_small, icon_large: when present, a non-empty relative path that stays
//     inside the plugin and names an existing file
//   brand_color: when present, a string matching #RRGGBB
//   default_prompt: when present, a string, non-empty after stripping
//   policy: when present, a mapping; keys subset of
//     {allow_implicit_invocation}; that value, when present, a boolean
//   dependencies: when present, a mapping; keys subset of {tools}
// "When present" follows Python's payload.get(): an absent key and an
// explicit null are the same thing, and both skip the check.
//
// Why this file is checked at all. `allow_implicit_invocation` is read ONLY
// from inside `policy`. A copy at the top level is never read as policy, so a
// skill carrying it there stays implicitly invocable while appearing to opt
// out — which is what shipped in runtime:cutover, and it was the one packaged
// skill of 55 that a Codex session listed. The text-level
// /allow_implicit_invocation:\s*false/ assertions in tests/plugin-shape cannot
// see that: the string is present at either nesting.
//
// This linter carries no YAML dependency (see the header note), so the reader
// below accepts the flat two-level mapping shape these manifests use and
// reports anything it cannot decide — block scalars, flow collections,
// anchors, aliases, tabs, deeper nesting, a colon with no separating space —
// as unmeasurable rather than interpreting it. Plain scalars are classified
// through the same plainScalarKind() resolver the frontmatter check uses, so
// `False`, `yes` and `~` are read the way PyYAML reads them rather than by
// spelling.
const AGENT_TOP_KEYS = ['dependencies', 'interface', 'policy'];
const AGENT_INTERFACE_KEYS = [
  'brand_color',
  'default_prompt',
  'display_name',
  'icon_large',
  'icon_small',
  'short_description',
];
const AGENT_POLICY_KEYS = ['allow_implicit_invocation'];
const AGENT_DEPENDENCY_KEYS = ['tools'];
const AGENT_STRING_REQUIRED = ['display_name', 'short_description'];
const AGENT_ASSET_FIELDS = ['icon_small', 'icon_large'];
const AGENT_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Drop a trailing comment. PyYAML only starts one at a `#` preceded by
// whitespace, so `a#b` stays the string "a#b" — matching that keeps a plain
// scalar containing a hash from being truncated.
function stripPlainComment(text) {
  const at = text.search(/(^|\s)#/);
  return at === -1 ? text : text.slice(0, at);
}

// Classify one value region. Returns {kind:'null'} | {kind:'scalar', ...} |
// {error}. `scalar.isString` is what Codex's isinstance(value, str) sees.
function parseAgentScalar(region) {
  const text = pythonStrip(region);
  if (text === '') return { kind: 'null' };
  if (/^[|>]/.test(text)) return { error: 'block scalar (| or >) is not measurable by this check' };
  if (/^[[{]/.test(text)) return { error: 'flow collection ([ or {) is not measurable by this check' };
  if (/^[&*]/.test(text)) return { error: 'anchor or alias is not measurable by this check' };
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    // Let a trailing comment past the closing quote through; PyYAML allows it
    // and parseSingleLineScalar would otherwise call it trailing content.
    let end = -1;
    for (let i = 1; i < text.length; i++) {
      if (text[i] === '\\' && quote === '"') { i += 1; continue; }
      if (text[i] === quote) {
        if (quote === "'" && text[i + 1] === "'") { i += 1; continue; }
        end = i;
        break;
      }
    }
    const body = end === -1 ? text : text.slice(0, end + 1);
    const rest = end === -1 ? '' : pythonStrip(text.slice(end + 1));
    if (rest !== '' && !rest.startsWith('#')) {
      return { error: 'unexpected content after the closing quote — PyYAML rejects this as invalid YAML' };
    }
    const parsed = parseSingleLineScalar(body);
    if (parsed.error) return { error: parsed.error };
    return { kind: 'scalar', value: parsed.value, isString: true };
  }
  const plain = stripPlainComment(text);
  const stripped = pythonStrip(plain);
  if (stripped === '') return { kind: 'null' };
  const resolved = plainScalarKind(stripped);
  if (resolved === 'null') return { kind: 'null' };
  if (resolved === 'a YAML structure indicator' || resolved === 'a nested mapping' || resolved === 'a YAML directive') {
    return { error: `value reads as ${resolved} — not measurable by this check` };
  }
  return { kind: 'scalar', value: stripped, isString: resolved === null, resolved };
}

// Read the document into Map<string, node>, where a node is
// {kind:'map', entries} | {kind:'sequence'} | {kind:'null'} |
// {kind:'scalar', ...}. Returns a string on failure.
function parseAgentDocument(text) {
  const top = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    if (raw.includes('\t')) return 'tab character is not measurable by this check — indent with spaces';
    if (pythonStrip(raw) === '') continue;
    if (pythonStrip(raw).startsWith('#')) continue;
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) return 'multi-document YAML is not measurable by this check';
    const indent = raw.length - raw.replace(/^ +/, '').length;
    if (indent !== 0 && indent !== 2) {
      return `indentation of ${indent} space(s) is not measurable by this check — use top-level keys plus two-space children`;
    }
    const body = raw.slice(indent);
    if (body.startsWith('- ') || body === '-') {
      if (indent === 0) return 'a top-level sequence is not a mapping';
      if (current === null) return 'indented line before any top-level key';
      const node = top.get(current);
      if (node.kind === 'map' && node.entries.size > 0) return `key "${current}" mixes mapping entries and sequence items`;
      top.set(current, { kind: 'sequence' });
      continue;
    }
    // A mapping key needs its colon followed by a space or the end of line.
    // Without that, `a:b` is one plain scalar to YAML, not an entry — the
    // difference between `policy` holding a mapping and holding a string.
    const parsed = /^([^:]+):(?:[ ](.*))?$/.exec(body);
    if (!parsed) {
      return `unparsable line: "${pythonStrip(body).slice(0, 48)}" — a mapping key needs a space after its colon`;
    }
    const key = pythonStrip(parsed[1]).replace(/^(["'])(.*)\1$/, '$2');
    const value = parseAgentScalar(parsed[2] ?? '');
    if (value.error) return `${current === null || indent === 0 ? key : `${current}.${key}`}: ${value.error}`;

    if (indent === 0) {
      if (top.has(key)) return `duplicate top-level key "${key}"`;
      top.set(key, value.kind === 'null' ? { kind: 'map', entries: new Map(), empty: true } : value);
      current = key;
      continue;
    }
    if (current === null) return 'indented line before any top-level key';
    const node = top.get(current);
    if (node.kind !== 'map') return `key "${current}" carries a scalar, so "${key}" beneath it is not measurable by this check`;
    if (node.entries.has(key)) return `duplicate key "${current}.${key}"`;
    node.entries.set(key, value);
  }
  // A top-level key with neither an inline value nor children is null to
  // PyYAML, not an empty mapping.
  for (const [key, node] of top) {
    if (node.kind === 'map' && node.empty && node.entries.size === 0) top.set(key, { kind: 'null' });
  }
  return top;
}

async function checkSkillAgentManifest(label, path, skillDir) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    errors.push(`${label}: read failed: ${err.message}`);
    return;
  }
  const doc = parseAgentDocument(content.replace(/\r\n?/g, '\n'));
  if (typeof doc === 'string') {
    errors.push(`${label}: ${doc}`);
    return;
  }
  if (doc.size === 0) {
    errors.push(`${label}: agent YAML must be an object`);
    return;
  }

  for (const key of [...doc.keys()].sort()) {
    if (!AGENT_TOP_KEYS.includes(key)) {
      errors.push(`${label}: field \`${key}\` is not accepted by plugin validation`);
    }
  }

  const iface = doc.get('interface');
  if (iface === undefined || iface.kind !== 'map') {
    errors.push(`${label}: field \`interface\` must be an object`);
  } else {
    for (const key of [...iface.entries.keys()].sort()) {
      if (!AGENT_INTERFACE_KEYS.includes(key)) {
        errors.push(`${label}: field \`interface.${key}\` is not accepted by plugin validation`);
      }
    }
    for (const key of AGENT_STRING_REQUIRED) {
      const node = iface.entries.get(key);
      if (node === undefined || node.kind !== 'scalar' || !node.isString || pythonStrip(node.value) === '') {
        errors.push(`${label}: field \`interface.${key}\` must be non-empty`);
      }
    }
    const prompt = iface.entries.get('default_prompt');
    if (prompt !== undefined && prompt.kind !== 'null' && (!prompt.isString || pythonStrip(prompt.value) === '')) {
      errors.push(`${label}: field \`interface.default_prompt\` must be non-empty`);
    }
    const colour = iface.entries.get('brand_color');
    if (colour !== undefined && colour.kind !== 'null' && (!colour.isString || !AGENT_HEX_COLOR_RE.test(colour.value))) {
      errors.push(`${label}: field \`interface.brand_color\` must use \`#RRGGBB\``);
    }
    for (const key of AGENT_ASSET_FIELDS) {
      const node = iface.entries.get(key);
      if (node === undefined || node.kind === 'null') continue;
      await checkAgentAssetPath(`${label}: field \`interface.${key}\``, node, skillDir);
    }
  }

  for (const [key, allowed] of [['policy', AGENT_POLICY_KEYS], ['dependencies', AGENT_DEPENDENCY_KEYS]]) {
    const node = doc.get(key);
    if (node === undefined || node.kind === 'null') continue;
    if (node.kind !== 'map') {
      errors.push(`${label}: field \`${key}\` must be an object`);
      continue;
    }
    for (const child of [...node.entries.keys()].sort()) {
      if (!allowed.includes(child)) {
        errors.push(`${label}: field \`${key}.${child}\` is not accepted by plugin validation`);
      }
    }
  }

  const policy = doc.get('policy');
  if (policy !== undefined && policy.kind === 'map') {
    const flag = policy.entries.get('allow_implicit_invocation');
    if (flag !== undefined && flag.kind !== 'null' && flag.resolved !== 'a boolean') {
      errors.push(`${label}: field \`policy.allow_implicit_invocation\` must be a boolean`);
    }
  }
}

// Mirrors validate_asset_path: a non-empty relative path, no empty/./..
// segment, resolving inside the plugin, naming an existing file. The base is
// the skill directory and the allowed root is the plugin directory, matching
// the validator's (skill_root, plugin_root) arguments.
async function checkAgentAssetPath(label, node, skillDir) {
  if (node.kind !== 'scalar' || !node.isString || pythonStrip(node.value) === '') {
    errors.push(`${label} must be a non-empty relative path`);
    return;
  }
  const candidate = node.value.replace(/\\/g, '/');
  const parts = candidate.split('/');
  if (candidate.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    errors.push(`${label} must stay inside the plugin archive`);
    return;
  }
  const resolved = resolve(skillDir, candidate);
  if (escapesPluginDir(resolved)) {
    errors.push(`${label} must stay inside the plugin archive`);
    return;
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    errors.push(`${label} points to a missing file`);
    return;
  }
  if (!info.isFile()) errors.push(`${label} points to a missing file`);
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

// ADR-0006 Amendment: a plugin whose declared root is NOT the conventional one
// must leave the conventional one inert. Compared by resolved path, not raw
// string — "skills", "./skills", "./skills/" and "./skills/." are the same
// root. The rule applies only when the manifest resolves to a different
// directory.
if (codexManifest && typeof codexManifest.skills === 'string' && codexManifest.skills.length > 0) {
  const declaredRoot = resolve(PLUGIN_DIR, codexManifest.skills);
  if (!escapesPluginDir(declaredRoot) && declaredRoot !== conventionalSkillsRoot) {
    await checkRelocatedConventionalRoot(conventionalSkillsRoot, codexManifest.skills);
  }
}

// --- Command skill pointers ----------------------------------------------
//
// A command runbook that names its skill does so by explicit path,
// `$CLAUDE_PLUGIN_ROOT/<root>/<verb>/SKILL.md`. That is a file read rather
// than directory-convention registration, which is precisely what lets a
// relocated skills root keep working — and nothing checked that the path
// resolves. Measured on a relocated copy of plugins/image: pointing one
// command back at the pre-relocation `skills/compose/SKILL.md` left both this
// linter and the plugin's shape test green while the target did not exist, so
// a half-finished move ships a command that reads nothing.
//
// SCOPE, stated because it is narrower than it looks. Across this repository
// the pattern matches 43 pointers, in designer, engineer, founder, image and
// orchestrator. `plugins/runtime` carries none — its command runbooks are
// inline — so this rule does NOT cover runtime's own relocation, and
// `attention` / `companions` ship no commands at all.
const COMMAND_SKILL_POINTER = /\$CLAUDE_PLUGIN_ROOT\/([A-Za-z0-9_@./-]*SKILL\.md)/g;

async function checkCommandSkillPointers() {
  const commandsDir = resolve(PLUGIN_DIR, 'commands');
  let entries;
  try {
    entries = await readdir(commandsDir, { withFileTypes: true });
  } catch (err) {
    // A plugin with no commands/ has no pointers to check. Every other read
    // failure is reported rather than read as "there were none".
    if (err.code !== 'ENOENT') {
      errors.push(`cannot read "commands/" to check its skill pointers: ${err.message}`);
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const abs = resolve(commandsDir, entry.name);
    let text;
    try {
      text = await readFile(abs, 'utf8');
    } catch (err) {
      errors.push(`commands/${entry.name}: cannot read it to check its skill pointers: ${err.message}`);
      continue;
    }
    const seen = new Set();
    for (const match of text.matchAll(COMMAND_SKILL_POINTER)) {
      const pointer = match[1];
      if (seen.has(pointer)) continue;
      seen.add(pointer);
      const label = `commands/${entry.name}: skill pointer "$CLAUDE_PLUGIN_ROOT/${pointer}"`;
      const target = resolve(PLUGIN_DIR, pointer);
      if (escapesPluginDir(target)) {
        errors.push(`${label} escapes the plugin directory`);
        continue;
      }
      let info;
      try {
        info = await stat(target);
      } catch {
        errors.push(
          `${label} does not resolve — the command would read nothing. A skills-root `
          + 'relocation moves the pointer with the file.',
        );
        continue;
      }
      if (!info.isFile()) errors.push(`${label} resolves to something that is not a file`);
    }
  }
}

await checkCommandSkillPointers();

// --- References inside the skills tree ------------------------------------
//
// The command-pointer rule above only reads `commands/*.md`. A runbook INSIDE
// the skills tree names its siblings too, and a relocation breaks those in two
// ways at once: a `../`-relative reference whose target stayed put now sits one
// level too shallow, and a plugin-root-relative `skills/...` reference names a
// directory that is now a tombstone. Measured on plugins/engineer during its
// move: 17 of the first kind and 27 of the second, none of them visible to any
// test or to this linter, because every other check either reads commands/ or
// asserts a file exists rather than that a reference to it resolves.
//
// TWO LIMITS, both measured rather than assumed:
//
//   1. Only a reference naming a file with a managed extension is checked.
//      Across all eight plugins that leaves 313 references checked and
//      excludes exactly 4, every one of them illustrative rather than a real
//      pointer: `../../etc/passwd` in three copies of a path-traversal rule,
//      and an example worktree directory name in runtime. An extension-less
//      token in prose is not a file reference, and treating it as one would
//      make this rule unshippable.
//   2. A reference leaving the plugin is checked ONLY when the surrounding
//      repository layout is actually present. Several references legitimately
//      point at repository docs, and requiring those to resolve would make the
//      rule fail on any copy of a plugin taken out of its repository — which
//      it immediately did, on the very first attempt to probe it. So the
//      layout is detected rather than assumed: the check applies to an
//      outbound reference only when the plugin sits at <root>/plugins/<name>
//      and <root>/docs exists. Where it does not, outbound references are
//      skipped and this rule makes no claim about them.
const SKILL_REF_MANAGED_EXT = /\.(md|mjs|js|json|ya?ml|txt)$/;
// <root>/plugins/<name> with a sibling docs/ — the shape this repository has,
// and the only one in which an outbound reference is decidable.
const repoLayoutPresent = basename(dirname(PLUGIN_DIR)) === 'plugins'
  && existsSync(resolve(PLUGIN_DIR, '..', '..', 'docs'));
const SKILL_REF_RELATIVE = /(\.\.\/)+[A-Za-z0-9_@./-]+/g;
const SKILL_REF_ROOT_RELATIVE = /(?<![A-Za-z0-9_/.$-])(?:core\/)?skills\/[A-Za-z0-9_@./-]+/g;
// A third shape: the full repository-relative path. It is how a runbook cites a
// SIBLING plugin's shared reference, and neither pattern above sees it — the
// plugin-root-relative one requires the token to start at `skills/`. Measured
// while relocating designer: two of these had been dead since engineer moved,
// one of them inside plugins/orchestrator, and nothing reported either.
const SKILL_REF_REPO_RELATIVE = /(?<![A-Za-z0-9_@.-])plugins\/[a-z0-9-]+\/[A-Za-z0-9_@./-]+/g;

async function checkSkillTreeReferences(skillsRoot) {
  let files;
  try {
    files = await collectTextFiles(skillsRoot);
  } catch (err) {
    errors.push(`cannot walk "${rel(skillsRoot)}" to check its references: ${err.message}`);
    return;
  }
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      errors.push(`${rel(file)}: cannot read it to check its references: ${err.message}`);
      continue;
    }
    const seen = new Set();
    const check = async (raw, base, shape) => {
      const ref = raw.replace(/[.,)`'"]+$/, '');
      if (!SKILL_REF_MANAGED_EXT.test(ref)) return;
      const key = `${shape}:${ref}`;
      if (seen.has(key)) return;
      seen.add(key);
      const target = resolve(base, ref);
      // Outbound references are only decidable where the repository layout is
      // present; see limit 2 in the header.
      if (escapesPluginDir(target) && !repoLayoutPresent) return;
      if (!(await exists(target))) {
        errors.push(
          `${rel(file)}: ${shape} reference "${ref}" does not resolve. After a skills-root `
          + 'relocation a reference to a target that did NOT move needs one more "../", and a '
          + 'plugin-root-relative "skills/..." reference needs the new root.',
        );
      }
    };
    for (const m of text.matchAll(SKILL_REF_RELATIVE)) await check(m[0], dirname(file), 'relative');
    for (const m of text.matchAll(SKILL_REF_ROOT_RELATIVE)) await check(m[0], PLUGIN_DIR, 'plugin-root-relative');
    // Repo-relative paths leave the plugin by construction, so they are only
    // decidable where the surrounding layout is present — same limit as above.
    if (repoLayoutPresent) {
      const repoRoot = resolve(PLUGIN_DIR, '..', '..');
      for (const m of text.matchAll(SKILL_REF_REPO_RELATIVE)) await check(m[0], repoRoot, 'repo-relative');
    }
  }
}

/** Every .md / .yaml / .yml under `dir`, recursively. Read failures throw. */
async function collectTextFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) await collectTextFiles(abs, out);
    else if (/\.(md|ya?ml)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

// Run against the root the manifest declares, falling back to the conventional
// one so a plugin that has not moved is covered too.
for (const root of skillsRoots) {
  if (await exists(root)) await checkSkillTreeReferences(root);
}


const seenSkillFiles = new Set();
// Agent manifests are deduplicated on their OWN real path. Keying them off
// the SKILL.md dedup would skip a distinct manifest whenever two skill
// directories share a symlinked SKILL.md.
const seenAgentFiles = new Set();
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
    // Codex reads the skill's invocation policy from the sibling agent
    // manifest, not from SKILL.md, so it is checked here — before the
    // frontmatter dedup, and against its own seen-set.
    const skillDir = dirname(file);
    const agentPath = resolve(skillDir, 'agents', 'openai.yaml');
    if (await exists(agentPath)) {
      const agentKey = (await containedRealPath(agentPath)) ?? agentPath;
      if (!seenAgentFiles.has(agentKey)) {
        seenAgentFiles.add(agentKey);
        await checkSkillAgentManifest(relative(PLUGIN_DIR, agentPath).split(sep).join('/'), agentPath, skillDir);
      }
    }
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
