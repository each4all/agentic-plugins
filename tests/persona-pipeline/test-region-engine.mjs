// The region engine of the persona pipeline, proven on fixtures (ADR-0066
// Decision 4, Stage 1): the marker grammar, the renderer's substitution
// contexts and capability blocks, and the generator's handling of regions in
// authored files (tests/persona-pipeline/fixtures/regions/).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseRegions,
  regionBody,
  renderTemplate,
  replaceRegionBodies,
  shellQuote,
} from '../../scripts/lib/persona-pipeline.mjs';
import { runSync } from '../../scripts/sync-persona-pipeline.mjs';
import { REPO_ROOT } from './_personas.mjs';

const FIXTURE = join(REPO_ROOT, 'tests/persona-pipeline/fixtures/regions');

function fixtureCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'pp-regions-'));
  cpSync(FIXTURE, dir, { recursive: true });
  cpSync(join(REPO_ROOT, 'persona-pipeline/persona.schema.json'), join(dir, 'persona-pipeline/persona.schema.json'));
  return dir;
}

function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

async function sync(root, opts = {}) {
  const out = sink();
  const err = sink();
  const code = await runSync({ root, out, err, ...opts });
  return { code, out: out.text, err: err.text };
}

const declaration = (overrides = {}) => ({
  name: 'alpha',
  deliverable_noun: 'alpha deliverable',
  capabilities: { dispatch_target: true, commit_surface: false, legacy_homes: false, profile_presets: false },
  ...overrides,
});

describe('region grammar', () => {
  it('finds regions and extension points, and ignores marker text inside ``` and ~~~ fences', () => {
    const text = [
      '# t',
      '<!-- pipeline:begin a -->',
      'body a',
      '<!-- pipeline:end a -->',
      '```md',
      '<!-- pipeline:begin a -->',
      '```',
      '~~~',
      '<!-- pipeline:end zzz -->',
      '~~~',
      '<!-- pipeline:extension slot -->',
      '<!-- pipeline:begin b -->',
      '<!-- pipeline:end b -->',
    ].join('\n');
    const parsed = parseRegions(text, 'f.md');
    deepStrictEqual(parsed.errors, []);
    deepStrictEqual(parsed.regions.map((r) => r.id), ['a', 'b']);
    deepStrictEqual(parsed.extensions.map((e) => e.id), ['slot']);
    strictEqual(regionBody(text, parsed.regions[0]), 'body a');
    strictEqual(regionBody(text, parsed.regions[1]), '');
  });

  const broken = {
    'a begin without an end': ['<!-- pipeline:begin a -->', 'x'],
    'an end without a begin': ['<!-- pipeline:end a -->'],
    'a mismatched end': ['<!-- pipeline:begin a -->', '<!-- pipeline:end b -->', '<!-- pipeline:end a -->'],
    'nested regions': ['<!-- pipeline:begin a -->', '<!-- pipeline:begin b -->', '<!-- pipeline:end b -->', '<!-- pipeline:end a -->'],
    'a duplicate id': ['<!-- pipeline:begin a -->', '<!-- pipeline:end a -->', '<!-- pipeline:begin a -->', '<!-- pipeline:end a -->'],
    'a marker that does not stand alone on its line': ['text <!-- pipeline:begin a -->', '<!-- pipeline:end a -->'],
    'an indented marker': ['  <!-- pipeline:begin a -->', '<!-- pipeline:end a -->'],
    'an unknown marker kind': ['<!-- pipeline:start a -->'],
    'a marker without an id': ['<!-- pipeline:begin -->'],
    'an extension point inside a region': ['<!-- pipeline:begin a -->', '<!-- pipeline:extension x -->', '<!-- pipeline:end a -->'],
    'an unterminated fence': ['```', '<!-- pipeline:begin a -->'],
  };
  for (const [what, lines] of Object.entries(broken)) {
    it(`rejects ${what}`, () => {
      const parsed = parseRegions(lines.join('\n'), 'f.md');
      ok(parsed.errors.length > 0, `expected a grammar error for ${what}`);
      for (const e of parsed.errors) match(e, /^f\.md/);
    });
  }

  it('replaces region bodies and leaves every other line byte-identical', () => {
    const text = 'a\n<!-- pipeline:begin x -->\nold\nold2\n<!-- pipeline:end x -->\nb\n<!-- pipeline:begin y -->\n<!-- pipeline:end y -->\nc\n';
    const parsed = parseRegions(text);
    const next = replaceRegionBodies(text, parsed.regions, { x: 'new', y: 'one\ntwo' });
    strictEqual(next, 'a\n<!-- pipeline:begin x -->\nnew\n<!-- pipeline:end x -->\nb\n<!-- pipeline:begin y -->\none\ntwo\n<!-- pipeline:end y -->\nc\n');
  });
});

describe('region rendering', () => {
  const subs = {
    noun: { field: 'deliverable_noun', context: 'markdown' },
    q: { field: 'deliverable_noun', context: 'shell' },
  };

  it('substitutes declared fields per context and includes or omits capability blocks', () => {
    const template = 'make the {{noun}}\nN={{q}}\n{{#capability dispatch_target}}\non\n{{/capability}}\n{{^capability dispatch_target}}\noff\n{{/capability}}\n';
    strictEqual(renderTemplate(template, { declaration: declaration(), substitutions: subs }),
      "make the alpha deliverable\nN='alpha deliverable'\non\n");
    const off = declaration({ capabilities: { ...declaration().capabilities, dispatch_target: false } });
    strictEqual(renderTemplate(template, { declaration: off, substitutions: subs }),
      "make the alpha deliverable\nN='alpha deliverable'\noff\n");
  });

  it('fails on an unresolved or undeclared placeholder', () => {
    throws(() => renderTemplate('{{nope}}', { declaration: declaration(), substitutions: subs }), /unresolved placeholder \{\{nope\}\}/);
    throws(() => renderTemplate('{{noun}}', {
      declaration: declaration({ deliverable_noun: undefined }), substitutions: subs,
    }), /unresolved placeholder \{\{noun\}\}: the declaration has no deliverable_noun/);
  });

  it('refuses nested, unclosed, stray and inline capability blocks, and unknown capabilities', () => {
    const d = { declaration: declaration(), substitutions: subs };
    throws(() => renderTemplate('{{#capability dispatch_target}}\n{{#capability legacy_homes}}\n{{/capability}}\n{{/capability}}', d), /never nest/);
    throws(() => renderTemplate('{{#capability dispatch_target}}\nx', d), /has no \{\{\/capability\}\}/);
    throws(() => renderTemplate('{{/capability}}', d), /without an open block/);
    throws(() => renderTemplate('x {{#capability dispatch_target}} y', d), /stands alone on its line/);
    throws(() => renderTemplate('{{#capability telepathy}}\n{{/capability}}', d), /unknown capability telepathy/);
  });

  // Hostile values are compared as strings and never run (ADR-0066 Decision 4).
  const hostile = {
    'a single quote': "it's",
    'a command substitution': '$(touch /tmp/pwned)',
    'backticks': '`id`',
    'a dollar brace': '${HOME}',
    'a double quote and a backslash': 'a"b\\c',
    'non-ASCII': '디자인 산출물 — ç',
  };
  for (const [what, value] of Object.entries(hostile)) {
    it(`emits ${what} as an inert single-quoted shell literal`, () => {
      const rendered = renderTemplate('V={{q}}', { declaration: declaration({ deliverable_noun: value }), substitutions: subs });
      strictEqual(rendered, `V=${shellQuote(value)}`);
      ok(rendered.startsWith("V='") && rendered.endsWith("'"));
      // Outside the quotes nothing but the escaped quote sequence remains.
      strictEqual(rendered.slice(2).split("'\\''").join('').replace(/^'|'$/g, '').includes("'"), false);
    });
  }
  it('refuses a newline in a shell context and keeps it verbatim in markdown', () => {
    throws(() => renderTemplate('V={{q}}', { declaration: declaration({ deliverable_noun: 'a\nrm -rf /' }), substitutions: subs }), /newline/);
    strictEqual(renderTemplate('{{noun}}', { declaration: declaration({ deliverable_noun: 'a\nb' }), substitutions: subs }), 'a\nb');
  });
});

describe('regions in authored files (fixture)', () => {
  it('regenerates stale region bodies per persona and leaves authored text byte-identical', async () => {
    const root = fixtureCopy();
    const before = readFileSync(join(root, 'plugins/beta/commands/run.md'), 'utf8');
    const first = await sync(root);
    strictEqual(first.code, 1);
    match(first.err, /plugins\/alpha\/commands\/run\.md: region intro differs/);
    match(first.err, /plugins\/beta\/commands\/run\.md: region finalize differs/);

    const write = await sync(root, { write: true });
    strictEqual(write.code, 0, write.err);
    const check = await sync(root);
    strictEqual(check.code, 0, check.err);

    const alpha = readFileSync(join(root, 'plugins/alpha/commands/run.md'), 'utf8');
    const beta = readFileSync(join(root, 'plugins/beta/commands/run.md'), 'utf8');
    match(alpha, /<!-- pipeline:begin intro -->\nThis runbook produces the alpha deliverable\.\n<!-- pipeline:end intro -->/);
    match(alpha, /NOUN='alpha deliverable'\nnode "\$PLUGIN_ROOT\/scripts\/tool\.mjs" --persona alpha/);
    match(alpha, /Record the parent linkage before finishing\./);
    ok(!alpha.includes('There is no parent to record.'));
    match(beta, /NOUN='beta'\\''s deliverable'/);
    match(beta, /There is no parent to record\./);
    ok(!beta.includes('Record the parent linkage'));

    // Everything outside the region bodies is exactly the authored text.
    const strip = (t) => t.replace(/(<!-- pipeline:begin (\w+) -->\n)[\s\S]*?(<!-- pipeline:end \2 -->)/g, '$1$3');
    strictEqual(strip(beta).replace(/```text\n<!-- pipeline:begin intro -->\n```/, ''),
      strip(before).replace(/```text\n<!-- pipeline:begin intro -->\n```/, ''));
    ok(beta.includes('```text\n<!-- pipeline:begin intro -->\n```'), 'the fenced marker text is untouched');

    // Idempotent: a second write changes nothing.
    const again = await sync(root, { write: true });
    strictEqual(again.code, 0);
    strictEqual(readFileSync(join(root, 'plugins/beta/commands/run.md'), 'utf8'), beta);
  });

  it('PC1 acceptance (fixture region): a hand edit inside a region fails the check naming the region, and --write restores it', async () => {
    const root = fixtureCopy();
    strictEqual((await sync(root, { write: true })).code, 0);
    const path = join(root, 'plugins/alpha/commands/run.md');
    const good = readFileSync(path, 'utf8');
    writeFileSync(path, good.replace('This runbook produces the alpha deliverable.', 'This runbook produces whatever I like.'));
    const check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /plugins\/alpha\/commands\/run\.md: region intro differs from persona-pipeline\/templates\/intro\.md/);
    strictEqual((await sync(root, { write: true })).code, 0);
    strictEqual(readFileSync(path, 'utf8'), good);
  });

  const structural = {
    'a missing required region': (t) => t.replace(/<!-- pipeline:begin intro -->\n[\s\S]*?<!-- pipeline:end intro -->\n/, ''),
    'regions out of order': (t) => {
      const intro = /<!-- pipeline:begin intro -->\n[\s\S]*?<!-- pipeline:end intro -->\n/.exec(t)[0];
      return t.replace(intro, '').replace('Authored prose after the last region.', `${intro}Authored prose after the last region.`);
    },
    'an unknown region id': (t) => `${t}\n<!-- pipeline:begin surprise -->\n<!-- pipeline:end surprise -->\n`,
    'an undeclared extension point': (t) => `${t}\n<!-- pipeline:extension elsewhere -->\n`,
    'an extension point over its slot count': (t) => `${t}\n<!-- pipeline:extension persona-steps -->\n`,
    'a broken marker': (t) => t.replace('<!-- pipeline:end intro -->', '<!-- pipeline:end intro'),
  };
  for (const [what, edit] of Object.entries(structural)) {
    it(`fails the check on ${what}, and the write refuses leaving authored text as it was`, async () => {
      const root = fixtureCopy();
      const path = join(root, 'plugins/beta/commands/run.md');
      const broken = edit(readFileSync(path, 'utf8'));
      writeFileSync(path, broken);
      const check = await sync(root);
      strictEqual(check.code, 1);
      match(check.err, /plugins\/beta\/commands\/run\.md/);
      const write = await sync(root, { write: true });
      strictEqual(write.code, 1);
      match(write.err, /refused to write/);
      strictEqual(readFileSync(path, 'utf8'), broken);
    });
  }

  it('fails on markers in a file the manifest gives no regions', async () => {
    const root = fixtureCopy();
    writeFileSync(join(root, 'plugins/alpha/commands/other.md'), '<!-- pipeline:begin intro -->\n<!-- pipeline:end intro -->\n');
    const check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /plugins\/alpha\/commands\/other\.md: region intro is unknown to the manifest for alpha/);
  });

  it('fails a render whose placeholder the declaration cannot resolve', async () => {
    const root = fixtureCopy();
    const declPath = join(root, 'plugins/beta/persona.json');
    const d = JSON.parse(readFileSync(declPath, 'utf8'));
    delete d.deliverable_noun;
    writeFileSync(declPath, `${JSON.stringify(d, null, 2)}\n`);
    const check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /region intro: .*unresolved placeholder \{\{noun\}\}: the declaration has no deliverable_noun/);
  });
});
