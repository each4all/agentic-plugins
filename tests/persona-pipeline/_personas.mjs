// Shared helpers for the parametrized persona-pipeline suite (ADR-0066
// Decision 5): each canonical unit is tested once for every persona the
// manifest's enrollment matrix generates it into.
//
// A suite asks `personasFor(dest)` for the personas a unit reaches and runs
// its cases per persona; persona values come from `personaInfo(persona)`,
// which reads the persona's own declaration (plugins/<persona>/persona.json),
// so a case never hard-codes one persona's data. test-personas.mjs asserts
// that the personas found on disk are the manifest's personas.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'persona-pipeline', 'manifest.json'), 'utf8'));

/** The personas a whole-file unit is generated into, by its plugin-relative dest. */
export function personasFor(dest) {
  const unit = MANIFEST.units.find((u) => u.dest === dest);
  if (!unit) throw new Error(`persona-pipeline manifest has no unit for ${dest}`);
  return [...unit.personas].sort();
}

/** The personas found on disk: plugins/<name>/persona.json. */
export function personasFound() {
  const plugins = join(REPO_ROOT, 'plugins');
  return readdirSync(plugins, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(plugins, e.name, 'persona.json')))
    .map((e) => e.name)
    .sort();
}

export function pluginRoot(persona) {
  return join(REPO_ROOT, 'plugins', persona);
}

export function declaration(persona) {
  return JSON.parse(readFileSync(join(pluginRoot(persona), 'persona.json'), 'utf8'));
}

/**
 * Everything a parametrized case needs about one persona: its plugin root, its
 * declaration, and the identity derived from its name (ADR-0066 V1).
 */
export function personaInfo(persona) {
  const decl = declaration(persona);
  const root = pluginRoot(persona);
  const stateDirRel = `.agentic-plugins/state/${persona}`;
  return Object.freeze({
    name: persona,
    root,
    declaration: decl,
    capabilities: decl.capabilities,
    deliverableNoun: decl.deliverable_noun,
    runtimeFooterFloor: decl.runtime_footer_floor,
    stateDirRel,
    workflowDirRel: `${stateDirRel}/workflows`,
    archiveDirRel: `${stateDirRel}/archive`,
    peerRunsDirRel: `${stateDirRel}/peer-runs`,
    commandPrefix: `/${persona}:`,
    metadataTag: `${persona}-active-metadata`,
    handoffTag: `${persona}-handoff-pending`,
    profileEnvVar: `AGENTIC_${persona.toUpperCase().replace(/-/g, '_')}_PROFILE`,
    /** Absolute path of a file inside the persona plugin. */
    path: (rel) => join(root, rel),
  });
}
