// The persona declaration (ADR-0066 Decision 2): its schema, the loader every
// canonical script reads it through, the identity derived from it, and the
// cross-field rules the generator enforces.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateAgainstSchema } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import { runSync } from '../../scripts/sync-persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, personaInfo, personasFound } from './_personas.mjs';

const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, 'persona-pipeline/persona.schema.json'), 'utf8'));
const validate = (doc) => validateAgainstSchema(doc, SCHEMA, { readerVersion: 'persona-declaration-1.0' });
const clone = (v) => JSON.parse(JSON.stringify(v));

// Documents the schema rejects; the loader must reject each of them too.
const SCHEMA_REJECTS = {
  'a missing capability flag (no flag reads as off by absence)': (d) => { delete d.capabilities.legacy_homes; },
  'a non-boolean capability flag': (d) => { d.capabilities.dispatch_target = 'no'; },
  'an unknown capability': (d) => { d.capabilities.telepathy = true; },
  'an unknown top-level key': (d) => { d.surprise = 1; },
  'an unknown format major': (d) => { d.schema = 'persona-declaration-2.0'; },
  'a malformed name': (d) => { d.name = 'Founder'; },
  'a missing decide object': (d) => { delete d.decide; },
  'a fallback axis without gate': (d) => { delete d.decide.fallback.axes[0].gate; },
  'a fallback axis with an unknown role': (d) => { d.decide.fallback.axes[0].role = 'veto'; },
  'a fallback with one axis': (d) => { d.decide.fallback.axes = d.decide.fallback.axes.slice(0, 1); },
  'a size map missing a tier': (d) => { delete d.decide.size_presets.major; },
  'a malformed footer floor': (d) => { d.runtime_footer_floor = '0.79'; },
  'a malformed deliverable noun': (d) => { d.deliverable_noun = 'Business $(deliverable)'; },
  'an empty tie-break list': (d) => { d.decide.tie_break = []; },
  'a profile map value that is not a preset id': (d) => { d.decide.profile_presets = { cta: 'Conversion!' }; },
};

describe('the personas found are the manifest personas (by identity)', () => {
  it('plugins/*/persona.json names exactly manifest.personas', () => {
    deepStrictEqual(personasFound(), [...MANIFEST.personas].sort());
  });
});

describe('persona.schema.json', () => {
  for (const persona of MANIFEST.personas) {
    it(`accepts plugins/${persona}/persona.json`, () => {
      const result = validate(declaration(persona));
      ok(result.ok, JSON.stringify(result.errors));
    });
  }

  const base = () => clone(declaration('founder'));
  const rejects = SCHEMA_REJECTS;
  for (const [what, edit] of Object.entries(rejects)) {
    it(`rejects ${what}`, () => {
      const d = base();
      edit(d);
      strictEqual(validate(d).ok, false);
    });
  }
});

// A minimal plugin directory holding only the loader, a manifest and a
// declaration, so each case gets its own module instance (its own URL).
function loaderPlugin({ name = 'founder', decl, manifestName = name, codexOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-loader-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  cpSync(join(REPO_ROOT, `plugins/${name}/scripts/lib/persona.mjs`), join(root, 'scripts/lib/persona.mjs'));
  const host = codexOnly ? '.codex-plugin' : '.claude-plugin';
  mkdirSync(join(root, host));
  writeFileSync(join(root, host, 'plugin.json'), JSON.stringify({ name: manifestName }));
  if (decl !== undefined) writeFileSync(join(root, 'persona.json'), typeof decl === 'string' ? decl : JSON.stringify(decl));
  return root;
}
const load = (root) => import(pathToFileURL(join(root, 'scripts/lib/persona.mjs')).href);

describe('scripts/lib/persona.mjs — the loader', () => {
  it('loads a valid declaration found next to itself, whatever the working directory', async () => {
    const root = loaderPlugin({ decl: declaration('founder') });
    const mod = await load(root);
    strictEqual(mod.loadPersona().name, 'founder');
    strictEqual(realpathSync(mod.personaPluginRoot()), realpathSync(root));
  });

  it('checks the name against the Codex manifest when there is no Claude manifest', async () => {
    const mod = await load(loaderPlugin({ decl: declaration('founder'), codexOnly: true }));
    strictEqual(mod.personaName(), 'founder');
  });

  const failures = {
    'a missing declaration': [{}, /is missing; refusing to act/],
    'malformed JSON': [{ decl: '{"schema": ' }, /malformed JSON/],
    'a non-object declaration': [{ decl: '[1]' }, /not a JSON object/],
    'an unknown format': [{ decl: { ...declaration('founder'), schema: 'persona-declaration-2.0' } }, /unknown format/],
    'a name that is not the plugin it sits in': [{ decl: declaration('designer'), manifestName: 'founder' }, /names persona "designer", but it sits in plugin "founder"/],
    'a missing capability flag': [{ decl: (() => { const d = clone(declaration('founder')); delete d.capabilities.profile_presets; return d; })() }, /capabilities must set exactly/],
    'a missing decide object (schema-invalid)': [{ decl: (() => { const d = clone(declaration('founder')); delete d.decide; return d; })() }, /does not match persona-pipeline\/persona\.schema\.json: decide is missing/],
  };
  for (const [what, [opts, re]] of Object.entries(failures)) {
    it(`throws PersonaDeclarationError on ${what}, and never falls back`, async () => {
      const mod = await load(loaderPlugin({ decl: opts.decl, manifestName: opts.manifestName ?? 'founder' }));
      throws(() => mod.loadPersona(), (err) => err.name === 'PersonaDeclarationError' && re.test(err.message));
      throws(() => mod.stateDirRel(), { name: 'PersonaDeclarationError' });
    });
  }

  it('refuses a field the caller requires and the declaration lacks', async () => {
    const mod = await load(loaderPlugin({ name: 'engineer', decl: declaration('engineer') }));
    throws(() => mod.loadPersona({ require: ['deliverable_noun'] }), /lacks deliverable_noun, which this script reads/);
    strictEqual(mod.loadPersona({ require: ['decide.fallback'] }).name, 'engineer');
  });

  it('rejects every document the schema rejects, and accepts the three real declarations (loader and schema in step)', async () => {
    for (const [what, edit] of Object.entries(SCHEMA_REJECTS)) {
      const d = clone(declaration('founder'));
      edit(d);
      strictEqual(validate(d).ok, false, `schema must reject ${what}`);
      const mod = await load(loaderPlugin({ decl: d, manifestName: typeof d.name === 'string' && /^[a-z][a-z0-9-]*$/.test(d.name) ? d.name : 'founder' }));
      throws(() => mod.loadPersona(), { name: 'PersonaDeclarationError' }, `the loader must reject ${what} too`);
    }
  });

  it('reads nothing at import time: importing with no declaration does not throw', async () => {
    const mod = await load(loaderPlugin({}));
    strictEqual(typeof mod.loadPersona, 'function');
  });
});

describe('derived identity (V1) equals the literals the plugins used before ADR-0066', () => {
  const today = {
    engineer: { state: '.agentic-plugins/state/engineer', prefix: '/engineer:', tag: 'engineer-active-metadata', env: 'AGENTIC_ENGINEER_PROFILE' },
    founder: { state: '.agentic-plugins/state/founder', prefix: '/founder:', tag: 'founder-active-metadata', env: 'AGENTIC_FOUNDER_PROFILE' },
    designer: { state: '.agentic-plugins/state/designer', prefix: '/designer:', tag: 'designer-active-metadata', env: 'AGENTIC_DESIGNER_PROFILE' },
  };
  for (const persona of MANIFEST.personas) {
    it(`${persona}: state home, command prefix, re-injection marker, profile variable`, async () => {
      const mod = await import(pathToFileURL(personaInfo(persona).path('scripts/lib/persona.mjs')).href);
      strictEqual(mod.stateDirRel(), today[persona].state);
      strictEqual(mod.commandPrefix(), today[persona].prefix);
      strictEqual(mod.metadataTag(), today[persona].tag);
      strictEqual(mod.profileEnvVar(), today[persona].env);
    });
  }

  it('the footer floors are the ones the resolvers pinned (V18): founder and designer 0.79.0; engineer declares none in Stage 1', () => {
    strictEqual(declaration('founder').runtime_footer_floor, '0.79.0');
    strictEqual(declaration('designer').runtime_footer_floor, '0.79.0');
    strictEqual(declaration('engineer').runtime_footer_floor, undefined);
  });

  it('capabilities (ADR-0066 Decision 3): no persona gains one it lacked', () => {
    deepStrictEqual(declaration('engineer').capabilities, { dispatch_target: true, commit_surface: true, legacy_homes: true, profile_presets: false });
    deepStrictEqual(declaration('founder').capabilities, { dispatch_target: false, commit_surface: false, legacy_homes: false, profile_presets: false });
    deepStrictEqual(declaration('designer').capabilities, { dispatch_target: false, commit_surface: false, legacy_homes: false, profile_presets: true });
  });
});

// ---- cross-field rules, enforced by the generator's check ----------------------

function repoSubsetCopy() {
  const root = mkdtempSync(join(tmpdir(), 'pp-decl-'));
  cpSync(join(REPO_ROOT, 'persona-pipeline'), join(root, 'persona-pipeline'), { recursive: true });
  for (const persona of MANIFEST.personas) {
    cpSync(join(REPO_ROOT, 'plugins', persona), join(root, 'plugins', persona), { recursive: true });
  }
  return root;
}
async function check(root) {
  let err = '';
  const code = await runSync({ root, out: { write: () => true }, err: { write: (s) => { err += s; return true; } } });
  return { code, err };
}
function editDecl(root, persona, edit) {
  const path = join(root, 'plugins', persona, 'persona.json');
  const d = JSON.parse(readFileSync(path, 'utf8'));
  edit(d);
  writeFileSync(path, `${JSON.stringify(d, null, 2)}\n`);
}

describe('cross-field rules (the generator check)', () => {
  it('the repository passes', async () => {
    const { code, err } = await check(repoSubsetCopy());
    strictEqual(code, 0, err);
  });

  const cases = {
    'a decide fallback that differs from its registry preset': ['founder', (d) => { d.decide.fallback.axes[0].question = 'Hand-edited question?'; }, /decide\.fallback differs from the registry preset "default"/],
    'a fallback gate that differs from the registry': ['designer', (d) => { d.decide.fallback.axes.at(-1).gate = false; }, /decide\.fallback differs from the registry preset "balanced"/],
    'a fallback preset the registry lacks': ['engineer', (d) => { d.decide.fallback.preset_id = 'nope'; }, /decide\.fallback\.preset_id "nope" is not a registry preset/],
    'profile_presets on without its map': ['designer', (d) => { delete d.decide.profile_presets; }, /capabilities\.profile_presets is on but decide\.profile_presets is absent/],
    'a profile map with profile_presets off': ['founder', (d) => { d.decide.profile_presets = { general: 'default' }; }, /decide\.profile_presets is set but capabilities\.profile_presets is off/],
    'a profile map naming a preset the registry lacks': ['designer', (d) => { d.decide.profile_presets.cta = 'missing-preset'; }, /decide\.profile_presets\.cta names "missing-preset"/],
    'a size map naming a preset the registry lacks': ['founder', (d) => { d.decide.size_presets.major = 'nine-axis'; }, /decide\.size_presets\.major names "nine-axis"/],
    'a tie-break axis that is not a fallback axis': ['engineer', (d) => { d.decide.tie_break = ['market-attractiveness']; }, /decide\.tie_break names "market-attractiveness", which is not a fallback axis/],
    'a field an enrolled unit reads': ['founder', (d) => { delete d.deliverable_noun; }, /unit session-handoff \(scripts\/session-handoff\.mjs\) reads deliverable_noun/],
    'a capability on that an enrolled unit carries only the off path of': ['designer', (d) => { d.capabilities.dispatch_target = true; }, /unit state \(scripts\/state\.mjs\) carries only the off path of dispatch_target/],
    'a name that is not its directory': ['founder', (d) => { d.name = 'designer'; }, /does not match its plugin directory founder/],
  };
  for (const [what, [persona, edit, re]] of Object.entries(cases)) {
    it(`fails on ${what}`, async () => {
      const root = repoSubsetCopy();
      editDecl(root, persona, edit);
      const { code, err } = await check(root);
      strictEqual(code, 1);
      match(err, re);
    });
  }

  it('fails when a persona.json appears that the manifest does not name, or a named one is missing', async () => {
    const root = repoSubsetCopy();
    cpSync(join(root, 'plugins/founder'), join(root, 'plugins/venture'), { recursive: true });
    let r = await check(root);
    strictEqual(r.code, 1);
    match(r.err, /plugins\/venture\/persona\.json declares a persona the manifest does not name/);
    const root2 = repoSubsetCopy();
    writeFileSync(join(root2, 'plugins/designer/persona.json.bak'), '');
    const manifestPath = join(root2, 'persona-pipeline/manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.personas.push('ghost');
    writeFileSync(manifestPath, JSON.stringify(m));
    r = await check(root2);
    strictEqual(r.code, 1);
    match(r.err, /manifest names persona ghost, but plugins\/ghost\/persona\.json does not exist/);
  });
});
