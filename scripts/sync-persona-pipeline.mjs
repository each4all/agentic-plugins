#!/usr/bin/env node
// Generate each persona plugin's copy of the persona pipeline from its one
// canonical source, persona-pipeline/ (ADR-0066 Decision 4).
//
//   node scripts/sync-persona-pipeline.mjs                 # check (the default)
//   node scripts/sync-persona-pipeline.mjs --write         # write
//   node scripts/sync-persona-pipeline.mjs --write --adopt # take over hand copies
//   node scripts/sync-persona-pipeline.mjs --root <dir>    # another tree (tests)
//
// Check mode exits 1 naming every failure:
//   1. a generated file or region differs from what the canonical source
//      renders for that persona (the executable bit included);
//   2. a file lacks a region the manifest requires, or holds its regions out of
//      the manifest's order;
//   3. a region or extension id is unknown to the manifest, or the region
//      grammar is broken;
//   4. an owned output exists that the manifest no longer generates, or the
//      ledger (persona-pipeline/owned.json) disagrees with what is generated;
//   5. a declaration fails its schema or a cross-field rule (its decide
//      fallback differs from its registry, a verb's default profile is not one
//      of its profiles, an enrolled region reads a field it lacks, ...); no
//      region renders from such a declaration;
//   6. the personas found (plugins/*/persona.json) differ from the manifest's,
//      by identity.
//
// Write mode first runs the whole check without touching anything. It refuses,
// changing nothing, when a failure is not one it can repair: a broken
// manifest, declaration or region grammar, a render failure, an unsafe or
// overlapping destination, or a file it does not own (present, not in the
// ledger, without the generated notice, and not already identical) — unless
// --adopt says the hand copies at the manifest's destinations are to be taken
// over: that is how a hand-maintained copy joins the pipeline, and it never
// reaches a path the manifest does not generate. Otherwise
// it writes each file through a temporary file and a rename, keeps modes,
// rewrites region bodies inside authored files (never the text around them),
// deletes owned outputs nothing generates any more, and rewrites the ledger.
// A rerun after an interrupted write repairs the tree.

import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CAPABILITIES,
  PipelineError,
  WRITE_COMMAND,
  carriesNotice,
  parseRegions,
  readJsonFile,
  regionBody,
  renderLedger,
  renderTemplate,
  renderingDeclaration,
  replaceRegionBodies,
  validateLedger,
  validateManifest,
  withNotice,
} from './lib/persona-pipeline.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECLARATION_FAMILY = 'persona-declaration-1.1';
const REGISTRY_REL = 'core/skills/decide/references/decision-axes.yml';

async function loadValidator() {
  const mod = await import(pathToFileURL(join(REPO_ROOT, 'plugins/runtime/scripts/lib/schema-validate.mjs')).href);
  return mod.validateAgainstSchema;
}

async function loadYaml() {
  return import(pathToFileURL(join(REPO_ROOT, 'persona-pipeline/files/scripts/lib/yaml-mini.mjs')).href);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

function isExecutable(path) {
  return (statSync(path).mode & 0o100) !== 0;
}

/** The registry preset as the fallback compares it: ids, labels, questions, roles, gates. */
function normalizePreset(axes) {
  return axes.map((a) => ({
    id: a.id,
    labels: { en: a.labels?.en ?? null, ko: a.labels?.ko ?? null },
    question: a.question,
    role: a.role,
    gate: a.gate === true || a.gate === 'true',
  }));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The cross-field rules the schema cannot state (ADR-0066 Decision 2 and 3).
 * Returns a list of failure messages.
 */
function crossFieldFailures({ persona, declaration, registry, units, regions }) {
  const failures = [];
  const d = declaration;
  const where = `plugins/${persona}/persona.json`;
  const caps = d.capabilities ?? {};
  const decide = d.decide ?? {};

  if (caps.profile_presets === true && !isPlainObject(decide.profile_presets)) {
    failures.push(`${where}: capabilities.profile_presets is on but decide.profile_presets is absent`);
  }
  if (caps.profile_presets === false && decide.profile_presets !== undefined) {
    failures.push(`${where}: decide.profile_presets is set but capabilities.profile_presets is off (the map would do nothing)`);
  }

  if (registry.error) {
    failures.push(`${where}: cannot check decide against plugins/${persona}/${REGISTRY_REL}: ${registry.error}`);
  } else {
    const presets = registry.presets;
    const fb = decide.fallback;
    if (fb && typeof fb.preset_id === 'string') {
      const preset = presets[fb.preset_id];
      if (!preset) {
        failures.push(`${where}: decide.fallback.preset_id ${JSON.stringify(fb.preset_id)} is not a registry preset`);
      } else if (!sameJson(normalizePreset(fb.axes ?? []), normalizePreset(preset.axes ?? []))) {
        failures.push(`${where}: decide.fallback differs from the registry preset ${JSON.stringify(fb.preset_id)} (ids, labels, questions, roles, gates must be equal)`);
      }
    }
    // Only the keys the format defines: a newer minor's extra scalar, which
    // both readers ignore, is not a preset reference.
    for (const size of ['minor', 'standard', 'major']) {
      const id = decide.size_presets?.[size];
      if (id !== undefined && !presets[id]) failures.push(`${where}: decide.size_presets.${size} names ${JSON.stringify(id)}, which is not a registry preset`);
    }
    for (const [profile, id] of Object.entries(decide.profile_presets ?? {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(profile)) continue;
      if (!presets[id]) failures.push(`${where}: decide.profile_presets.${profile} names ${JSON.stringify(id)}, which is not a registry preset`);
    }
  }
  const fallbackAxes = new Set((decide.fallback?.axes ?? []).map((a) => a.id));
  for (const axis of decide.tie_break ?? []) {
    if (!fallbackAxes.has(axis)) failures.push(`${where}: decide.tie_break names ${JSON.stringify(axis)}, which is not a fallback axis`);
  }

  for (const unit of units) {
    if (!unit.personas.includes(persona)) continue;
    for (const field of unit.requires ?? []) {
      let cur = d;
      for (const part of field.split('.')) cur = isPlainObject(cur) && Object.hasOwn(cur, part) ? cur[part] : undefined;
      if (cur === undefined) failures.push(`${where}: unit ${unit.id} (${unit.dest}) reads ${field}, which the declaration lacks`);
    }
    for (const cap of unit.off_only ?? []) {
      if (caps[cap] === true) {
        failures.push(`${where}: unit ${unit.id} (${unit.dest}) carries only the off path of ${cap}, but ${persona} declares it on`);
      }
    }
  }

  // Format 1.1: a verb's default profile is one of its profiles, and the two
  // come together.
  for (const [verb, v] of Object.entries(isPlainObject(d.verbs) ? d.verbs : {})) {
    if (!isPlainObject(v)) continue;
    if ((v.profiles === undefined) !== (v.default_profile === undefined)) {
      failures.push(`${where}: verbs.${verb} declares ${v.profiles === undefined ? 'default_profile without profiles' : 'profiles without default_profile'}; declare both or neither`);
    } else if (Array.isArray(v.profiles) && !v.profiles.includes(v.default_profile)) {
      failures.push(`${where}: verbs.${verb}.default_profile ${JSON.stringify(v.default_profile)} is not one of its profiles (${v.profiles.join(', ')})`);
    }
  }

  // A region enrolled for this persona reads only fields the declaration has,
  // so a missing one is the declaration's failure, reported before any render.
  const rendering = renderingDeclaration(d);
  for (const region of regions) {
    if (!region.personas.includes(persona)) continue;
    for (const [name, sub] of Object.entries(region.substitutions ?? {})) {
      if (!Object.hasOwn(sub, 'field')) continue;
      let cur = rendering;
      for (const part of sub.field.split('.')) cur = isPlainObject(cur) && Object.hasOwn(cur, part) ? cur[part] : undefined;
      if (cur === undefined || cur === null) {
        failures.push(`${where}: region ${region.id} (${region.dest}) reads ${sub.field} for {{${name}}}, which the declaration lacks`);
      }
    }
  }
  return failures;
}

function readRegistry(yaml, path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { error: `unreadable (${err.code ?? err.message})` };
  }
  try {
    const parsed = yaml.parse(text);
    if (!isPlainObject(parsed?.presets)) return { error: 'no presets map' };
    return { presets: parsed.presets };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * The first symlink between the tree root and `rel` (repo-relative), or null.
 * Checked from the root — `plugins/`, the persona directory, then every
 * component — so neither a symlinked plugin directory (a retired persona the
 * ledger still lists included) nor a symlinked parent can carry a write or a
 * delete outside the tree.
 */
function symlinkOnPath(root, rel) {
  let cur = root;
  for (const part of rel.split('/')) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return relative(root, cur);
  }
  return null;
}

function atomicWrite(path, content, executable) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.persona-pipeline.tmp`);
  writeFileSync(tmp, content);
  chmodSync(tmp, executable ? 0o755 : 0o644);
  renameSync(tmp, path);
}

/**
 * Run the check, and the write when asked. Returns the exit status.
 */
export async function runSync({ root = REPO_ROOT, write = false, adopt = false, out = process.stdout, err = process.stderr } = {}) {
  const fatal = [];
  const drift = [];
  const say = (line) => out.write(`${line}\n`);
  const PIPE = join(root, 'persona-pipeline');

  // ---- manifest, ledger, schema --------------------------------------------
  let manifest;
  try {
    manifest = validateManifest(readJsonFile(join(PIPE, 'manifest.json'), 'manifest'));
  } catch (e) {
    err.write(`✗ ${e.message}\n`);
    return 1;
  }
  let ledger = { owned: {} };
  const ledgerPath = join(PIPE, 'owned.json');
  if (existsSync(ledgerPath)) {
    try {
      ledger = validateLedger(readJsonFile(ledgerPath, 'owned.json'), manifest.personas);
    } catch (e) {
      fatal.push(e.message);
    }
  } else {
    drift.push('persona-pipeline/owned.json is missing');
  }
  let schema = null;
  try {
    schema = readJsonFile(join(PIPE, 'persona.schema.json'), 'persona.schema.json');
  } catch (e) {
    fatal.push(e.message);
  }

  // ---- personas: found vs named (by identity) ------------------------------
  const pluginsDir = join(root, 'plugins');
  const found = existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(pluginsDir, e.name, 'persona.json')))
      .map((e) => e.name)
      .sort()
    : [];
  const named = [...manifest.personas].sort();
  for (const p of found) if (!named.includes(p)) fatal.push(`plugins/${p}/persona.json declares a persona the manifest does not name`);
  for (const p of named) if (!found.includes(p)) fatal.push(`manifest names persona ${p}, but plugins/${p}/persona.json does not exist`);

  // ---- declarations ---------------------------------------------------------
  const validate = schema ? await loadValidator() : null;
  const yaml = await loadYaml();
  const declarations = {};
  for (const persona of named.filter((p) => found.includes(p))) {
    const where = `plugins/${persona}/persona.json`;
    let declaration;
    try {
      declaration = readJsonFile(join(pluginsDir, persona, 'persona.json'), where);
    } catch (e) {
      fatal.push(e.message);
      continue;
    }
    if (validate) {
      let result;
      try {
        result = validate(declaration, schema, { readerVersion: DECLARATION_FAMILY });
      } catch (e) {
        fatal.push(`persona.schema.json: ${e.message}`);
        continue;
      }
      if (!result.ok) {
        for (const f of result.errors) fatal.push(`${where}: ${f}`);
        continue;
      }
    }
    if (declaration.name !== persona) {
      fatal.push(`${where}: name ${JSON.stringify(declaration.name)} does not match its plugin directory ${persona}`);
      continue;
    }
    const registry = readRegistry(yaml, join(pluginsDir, persona, REGISTRY_REL));
    const failures = crossFieldFailures({ persona, declaration, registry, units: manifest.units, regions: manifest.regions });
    for (const f of failures) fatal.push(f);
    if (failures.length === 0) declarations[persona] = declaration;
  }

  // ---- canonical sources ----------------------------------------------------
  const filesDir = join(PIPE, 'files');
  const referenced = new Set(manifest.units.map((u) => u.source));
  if (existsSync(filesDir)) {
    for (const rel of walkFiles(filesDir)) {
      const source = `files/${rel}`;
      if (!referenced.has(source)) fatal.push(`persona-pipeline/${source} is not a unit of the manifest`);
    }
  }

  // ---- whole-file units -----------------------------------------------------
  const plan = []; // { persona, dest, abs, content, executable, action }
  const expected = {}; // persona -> Set(dest)
  for (const persona of named) expected[persona] = new Set();
  for (const unit of manifest.units) {
    const sourceAbs = join(PIPE, unit.source);
    let content;
    let executable;
    try {
      content = readFileSync(sourceAbs, 'utf8');
      executable = isExecutable(sourceAbs);
    } catch (e) {
      fatal.push(`unit ${unit.id}: canonical source persona-pipeline/${unit.source} is unreadable (${e.code ?? e.message})`);
      continue;
    }
    let rendered;
    try {
      rendered = withNotice(content, `persona-pipeline/${unit.source}`, unit.dest);
    } catch (e) {
      fatal.push(`unit ${unit.id}: ${e.message}`);
      continue;
    }
    for (const persona of unit.personas) {
      if (expected[persona].has(unit.dest)) {
        fatal.push(`plugins/${persona}/${unit.dest}: generated by two units`);
        continue;
      }
      expected[persona].add(unit.dest);
      plan.push({ persona, unit, dest: unit.dest, content: rendered, executable });
    }
  }
  for (const persona of named) {
    const dests = [...expected[persona]].sort();
    for (let i = 0; i < dests.length; i++) {
      for (let j = 0; j < dests.length; j++) {
        if (i !== j && dests[j].startsWith(`${dests[i]}/`)) {
          fatal.push(`plugins/${persona}: destinations overlap: ${dests[i]} contains ${dests[j]}`);
        }
      }
    }
  }

  const ledgerOwned = (persona) => new Set(ledger.owned?.[persona] ?? []);
  for (const item of plan) {
    const pluginDir = join(pluginsDir, item.persona);
    const rel = `plugins/${item.persona}/${item.dest}`;
    const link = symlinkOnPath(root, rel);
    if (link !== null) {
      fatal.push(`${rel}: refused — ${link} is a symlink, so the destination could resolve outside the plugin`);
      continue;
    }
    const abs = join(pluginDir, item.dest);
    item.abs = abs;
    if (!existsSync(abs)) {
      item.action = 'create';
      drift.push(`${rel}: missing (generated from persona-pipeline/${item.unit.source})`);
      continue;
    }
    const current = readFileSync(abs, 'utf8');
    const owned = ledgerOwned(item.persona).has(item.dest);
    if (!owned && current !== item.content && !carriesNotice(current)) {
      if (write && adopt) {
        item.action = 'adopt';
        drift.push(`${rel}: hand copy taken over (--adopt)`);
        continue;
      }
      fatal.push(`${rel}: refused — present, not in owned.json, without the generated notice and different from the canonical render; ownership is unclear`);
      continue;
    }
    if (current !== item.content) {
      item.action = 'update';
      drift.push(`${rel}: differs from persona-pipeline/${item.unit.source} (edit the source, then run ${WRITE_COMMAND})`);
    } else if (isExecutable(abs) !== item.executable) {
      item.action = 'mode';
      drift.push(`${rel}: mode differs (expected ${item.executable ? 'executable' : 'not executable'})`);
    } else {
      item.action = 'ok';
    }
  }

  const regionDests = new Map(); // persona -> Map(dest -> [regions in manifest order])
  for (const region of manifest.regions) {
    for (const persona of region.personas) {
      if (!regionDests.has(persona)) regionDests.set(persona, new Map());
      const byDest = regionDests.get(persona);
      if (!byDest.has(region.dest)) byDest.set(region.dest, []);
      byDest.get(region.dest).push(region);
    }
  }
  for (const [persona, byDest] of regionDests) {
    for (const dest of byDest.keys()) {
      if (expected[persona]?.has(dest)) {
        fatal.push(`plugins/${persona}/${dest}: both a whole-file unit and generated regions claim it; ownership is ambiguous`);
      }
    }
  }

  // ---- owned outputs nothing generates any more, and the ledger --------------
  // An owned file the manifest now gives regions instead is never deleted: it
  // becomes authored text, and the write only drops it from the ledger (the
  // region check above then asks for its markers).
  const deletions = [];
  const disowned = []; // { persona, dest }
  for (const persona of Object.keys(ledger.owned ?? {}).sort()) {
    for (const dest of ledger.owned[persona]) {
      if (expected[persona]?.has(dest)) continue;
      const rel = `plugins/${persona}/${dest}`;
      const abs = join(pluginsDir, persona, dest);
      if (regionDests.get(persona)?.has(dest)) {
        drift.push(`${rel}: owned output that now holds generated regions; it becomes authored and leaves the ledger`);
        disowned.push({ persona, dest });
        continue;
      }
      if (existsSync(abs)) {
        const link = symlinkOnPath(root, rel);
        if (link !== null) {
          fatal.push(`${rel}: refused — ${link} is a symlink`);
          continue;
        }
        drift.push(`${rel}: owned output the manifest no longer generates`);
        deletions.push({ persona, dest, abs });
      } else {
        drift.push(`persona-pipeline/owned.json lists ${rel}, which no longer exists`);
      }
    }
  }
  for (const persona of named) {
    const have = ledgerOwned(persona);
    for (const dest of expected[persona]) {
      if (!have.has(dest)) drift.push(`persona-pipeline/owned.json does not list plugins/${persona}/${dest}`);
    }
  }

  // ---- regions --------------------------------------------------------------
  const regionWrites = []; // { abs, rel, text }
  const extensionPoints = new Map(); // dest -> Map(id -> max)
  for (const ext of manifest.extension_points) {
    if (!extensionPoints.has(ext.dest)) extensionPoints.set(ext.dest, new Map());
    extensionPoints.get(ext.dest).set(ext.id, ext.max);
  }

  // A persona whose declaration failed is already reported; its regions are
  // not rendered from a declaration that is not valid.
  for (const persona of named.filter((p) => found.includes(p) && declarations[p])) {
    const pluginDir = join(pluginsDir, persona);
    const byDest = regionDests.get(persona) ?? new Map();
    // Every Markdown file that carries a marker, plus every file the manifest
    // gives regions — a marker the manifest does not know is a failure too.
    const candidates = new Set(byDest.keys());
    for (const rel of walkFiles(pluginDir)) {
      if (!rel.endsWith('.md')) continue;
      if (expected[persona].has(rel)) continue;
      if (readFileSync(join(pluginDir, rel), 'utf8').includes('<!-- pipeline:')) candidates.add(rel);
    }
    for (const dest of [...candidates].sort()) {
      const rel = `plugins/${persona}/${dest}`;
      const abs = join(pluginDir, dest);
      if (!existsSync(abs)) {
        fatal.push(`${rel}: missing, but the manifest gives it regions`);
        continue;
      }
      const link = symlinkOnPath(root, rel);
      if (link !== null) {
        fatal.push(`${rel}: refused — ${link} is a symlink`);
        continue;
      }
      const text = readFileSync(abs, 'utf8');
      const parsed = parseRegions(text, rel);
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) fatal.push(e);
        continue;
      }
      const declaredRegions = byDest.get(dest) ?? [];
      const declaredIds = declaredRegions.map((r) => r.id);
      const foundIds = parsed.regions.map((r) => r.id);
      let structural = false;
      for (const id of foundIds) {
        if (!declaredIds.includes(id)) {
          fatal.push(`${rel}: region ${id} is unknown to the manifest for ${persona}`);
          structural = true;
        }
      }
      for (const id of declaredIds) {
        if (!foundIds.includes(id)) {
          fatal.push(`${rel}: lacks the required region ${id}`);
          structural = true;
        }
      }
      if (!structural && !sameJson(foundIds, declaredIds)) {
        fatal.push(`${rel}: regions out of the canonical order (found ${foundIds.join(', ')}; expected ${declaredIds.join(', ')})`);
        structural = true;
      }
      const allowed = extensionPoints.get(dest) ?? new Map();
      const extCounts = new Map();
      for (const ext of parsed.extensions) extCounts.set(ext.id, (extCounts.get(ext.id) ?? 0) + 1);
      for (const [id, count] of extCounts) {
        if (!allowed.has(id)) {
          fatal.push(`${rel}: extension point ${id} is not declared for this file`);
          structural = true;
        } else if (count > allowed.get(id)) {
          fatal.push(`${rel}: extension point ${id} appears ${count} times; the slot allows ${allowed.get(id)}`);
          structural = true;
        }
      }
      if (structural) continue;

      const bodies = {};
      let renderFailed = false;
      for (const region of declaredRegions) {
        let template;
        try {
          template = readFileSync(join(PIPE, region.template), 'utf8');
        } catch (e) {
          fatal.push(`region ${region.id}: template persona-pipeline/${region.template} is unreadable (${e.code ?? e.message})`);
          renderFailed = true;
          continue;
        }
        try {
          const rendered = renderTemplate(template, {
            declaration: renderingDeclaration(declarations[persona]),
            substitutions: region.substitutions ?? {},
            label: `persona-pipeline/${region.template}`,
          });
          bodies[region.id] = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
        } catch (e) {
          fatal.push(`${rel}: region ${region.id}: ${e.message}`);
          renderFailed = true;
        }
      }
      if (renderFailed) continue;
      let changed = false;
      for (const region of parsed.regions) {
        if (regionBody(text, region) !== bodies[region.id]) {
          drift.push(`${rel}: region ${region.id} differs from persona-pipeline/${declaredRegions.find((r) => r.id === region.id).template}`);
          changed = true;
        }
      }
      if (changed) {
        // The document as it would be written must still parse to the same
        // regions: a rendered body holding an unclosed fence or a marker would
        // otherwise hide a region and break every later check.
        const next = replaceRegionBodies(text, parsed.regions, bodies);
        const reparsed = parseRegions(next, rel);
        if (reparsed.errors.length > 0 || !sameJson(reparsed.regions.map((r) => r.id), foundIds)) {
          fatal.push(`${rel}: the rendered regions would break the region grammar (${reparsed.errors[0] ?? 'regions changed'}); fix the template`);
          continue;
        }
        regionWrites.push({ abs, rel, text: next });
      }
    }
  }

  // ---- report / write -------------------------------------------------------
  for (const f of fatal) err.write(`✗ ${f}\n`);
  if (!write) {
    for (const d of drift) err.write(`✗ ${d}\n`);
    if (fatal.length + drift.length > 0) {
      err.write(`\npersona-pipeline: ${fatal.length + drift.length} failure(s).${fatal.length === 0 ? ` Run \`${WRITE_COMMAND}\` to regenerate.` : ''}\n`);
      return 1;
    }
    say(`OK — persona pipeline: ${plan.length} generated file(s) across ${named.length} persona(s) match the canonical source`);
    return 0;
  }
  if (fatal.length > 0) {
    err.write(`\npersona-pipeline: refused to write — ${fatal.length} failure(s) above need a source or authored fix; nothing was changed.\n`);
    return 1;
  }

  // Own the new outputs before writing them, so an interrupted write leaves
  // nothing whose ownership is unclear; drop a path only after deleting it.
  const owned = {};
  for (const persona of new Set([...named, ...Object.keys(ledger.owned ?? {})])) {
    owned[persona] = [...new Set([...(ledger.owned?.[persona] ?? []), ...(expected[persona] ?? [])])];
  }
  atomicWrite(ledgerPath, renderLedger(owned), false);
  for (const item of plan) {
    if (item.action === 'create' || item.action === 'update' || item.action === 'adopt') {
      atomicWrite(item.abs, item.content, item.executable);
      const verb = { create: 'generated', update: 'regenerated', adopt: 'taken over and regenerated' }[item.action];
      say(`✓ plugins/${item.persona}/${item.dest}: ${verb}`);
    } else if (item.action === 'mode') {
      chmodSync(item.abs, item.executable ? 0o755 : 0o644);
      say(`✓ plugins/${item.persona}/${item.dest}: mode restored`);
    }
  }
  for (const w of regionWrites) {
    atomicWrite(w.abs, w.text, isExecutable(w.abs));
    say(`✓ ${w.rel}: regions regenerated`);
  }
  for (const del of deletions) {
    rmSync(del.abs, { force: true });
    say(`✓ plugins/${del.persona}/${del.dest}: removed (no longer generated)`);
  }
  const finalOwned = {};
  for (const persona of named) finalOwned[persona] = [...expected[persona]];
  atomicWrite(ledgerPath, renderLedger(finalOwned), false);
  for (const d of disowned) say(`✓ plugins/${d.persona}/${d.dest}: left the ledger (now authored, with regions)`);
  say('OK — persona pipeline written');
  return 0;
}

function parseCli(argv) {
  const opts = { write: false, adopt: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--adopt') opts.adopt = true;
    else if (a === '--root') {
      if (!argv[i + 1]) throw new PipelineError('--root needs a directory');
      opts.root = resolve(argv[++i]);
    } else throw new PipelineError(`unknown argument ${a}`);
  }
  if (opts.adopt && !opts.write) throw new PipelineError('--adopt only applies with --write');
  return opts;
}

function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs');
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  (async () => {
    let opts;
    try {
      opts = parseCli(process.argv.slice(2));
    } catch (e) {
      process.stderr.write(`${e.message}\nUsage: node scripts/sync-persona-pipeline.mjs [--write [--adopt]] [--root <dir>]\n`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runSync(opts);
  })();
}

export { CAPABILITIES };
