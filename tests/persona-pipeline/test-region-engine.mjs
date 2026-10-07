// The region engine of the persona pipeline, proven on fixtures (ADR-0066
// Decision 4, Stage 1): the marker grammar, the renderer's substitution
// contexts and capability blocks, and the generator's handling of regions in
// authored files (tests/persona-pipeline/fixtures/regions/).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseRegions,
  placeholderPlacements,
  regionBody,
  renderTemplate,
  renderingDeclaration,
  replaceRegionBodies,
  shellQuote,
  validateManifest,
  variantEnrolmentFailures,
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
  // dispatch_target on needs commit_surface on (the generator's rule, PC3 U7).
  capabilities: { dispatch_target: true, commit_surface: true, legacy_homes: false, profile_presets: false },
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
    const template = 'make the {{noun}}\n```bash\nN={{q}}\n```\n{{#capability dispatch_target}}\non\n{{/capability}}\n{{^capability dispatch_target}}\noff\n{{/capability}}\n';
    strictEqual(renderTemplate(template, { declaration: declaration(), substitutions: subs }),
      "make the alpha deliverable\n```bash\nN='alpha deliverable'\n```\non\n");
    const off = declaration({ capabilities: { ...declaration().capabilities, dispatch_target: false } });
    strictEqual(renderTemplate(template, { declaration: off, substitutions: subs }),
      "make the alpha deliverable\n```bash\nN='alpha deliverable'\n```\noff\n");
  });

  // A list of lines (declaration 1.1's phase-note artifact sections) renders
  // one line per item, verbatim, in markdown or text only (PC2a2 T1').
  describe('list values', () => {
    const listSubs = {
      lines: { field: 'verbs.compose.artifact', context: 'markdown' },
      shellLines: { field: 'verbs.compose.artifact', context: 'shell' },
    };
    const withLines = (artifact) => ({ declaration: declaration({ verbs: { compose: { artifact } } }), substitutions: listSubs });
    const hostileLines = ['### Artifact', '', '$(touch /tmp/pwned) `id` "${HOME}"', "it's \\", '  indented — 디자인'];

    it('renders each item on its own line with the placeholder line\'s indentation; an empty item is a blank line', () => {
      strictEqual(renderTemplate('```markdown\n{{lines}}\n```', withLines(hostileLines)),
        `\`\`\`markdown\n${hostileLines.join('\n')}\n\`\`\``);
      strictEqual(renderTemplate('> intro\n  {{lines}}\nend', withLines(['a', '', 'b'])), '> intro\n  a\n\n  b\nend');
    });
    it('refuses a value that opens or closes a code fence, so a later markdown value cannot land in a shell block', () => {
      const subsWithNoun = { ...listSubs, noun: { field: 'deliverable_noun', context: 'markdown' } };
      const opts = (artifact, noun = 'x') => ({ declaration: declaration({ deliverable_noun: noun, verbs: { compose: { artifact } } }), substitutions: subsWithNoun });
      // Codex review of PC2a2: ["```", "```bash"] closed the markdown fence and
      // opened a shell one, and {{noun}} then rendered into bash verbatim.
      throws(() => renderTemplate('```markdown\n{{lines}}\n{{noun}}\n```', opts(['```', '```bash'], '$(touch /tmp/pwned)')), /opens or closes a code fence/);
      throws(() => renderTemplate('{{lines}}', opts(['~~~'])), /opens or closes a code fence/);
      throws(() => renderTemplate('{{noun}}', opts(['a'], 'a\n```sh')), /opens or closes a code fence/);
      strictEqual(renderTemplate('```markdown\n{{lines}}\n```', opts(['a ``` b', '`code`'])), '```markdown\na ``` b\n`code`\n```');
    });
    it('refuses a list that does not stand alone on its line', () => {
      throws(() => renderTemplate('Artifact: {{lines}}', withLines(['a'])), /a list renders one line per item, so it stands alone on its line/);
    });
    it('refuses a list as a shell value, and a list placeholder inside a shell block', () => {
      throws(() => renderTemplate('```bash\nX=\n{{shellLines}}\n```', withLines(['a'])), /verbs\.compose\.artifact is a list, and a shell value is one literal/);
      throws(() => renderTemplate('```bash\n{{lines}}\n```', withLines(['a'])), /markdown value inside a shell block/);
    });
    it('refuses an item that is not a string, holds a line break, or holds "{{"', () => {
      throws(() => renderTemplate('{{lines}}', withLines(['a', 3])), /verbs\.compose\.artifact\[1\] is not a string/);
      throws(() => renderTemplate('{{lines}}', withLines(['a\nb'])), /artifact\[0\] holds a line break/);
      throws(() => renderTemplate('{{lines}}', withLines(['a\rb'])), /artifact\[0\] holds a line break/);
      throws(() => renderTemplate('{{lines}}', withLines(['{{noun}}'])), /holds "\{\{"/);
    });
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
      const rendered = renderTemplate('```sh\nV={{q}}\n```', { declaration: declaration({ deliverable_noun: value }), substitutions: subs })
        .split('\n')[1];
      strictEqual(rendered, `V=${shellQuote(value)}`);
      ok(rendered.startsWith("V='") && rendered.endsWith("'"));
      // Outside the quotes nothing but the escaped quote sequence remains.
      strictEqual(rendered.slice(2).split("'\\''").join('').replace(/^'|'$/g, '').includes("'"), false);
    });
  }
  // Placement (ADR-0066 Decision 4, PC2a DD9): a single-quoted literal means
  // what it says only at an unquoted word position of a shell block.
  describe('placement', () => {
    const d = (value = 'alpha deliverable') => ({ declaration: declaration({ deliverable_noun: value }), substitutions: subs });
    const sh = (line) => `\`\`\`bash\n${line}\n\`\`\``;
    it('accepts a shell value at a word position, also inside $(…) nested in double quotes', () => {
      strictEqual(renderTemplate(sh('X={{q}}'), d()), sh("X='alpha deliverable'"));
      strictEqual(renderTemplate(sh('mktemp -t {{q}}-x.XXXXXX'), d()), sh("mktemp -t 'alpha deliverable'-x.XXXXXX"));
      strictEqual(renderTemplate(sh('X="$(find ~/c/{{q}} -type d)"'), d()), sh('X="$(find ~/c/\'alpha deliverable\' -type d)"'));
      strictEqual(renderTemplate(sh('N=$((1 + 2)); X={{q}}'), d()), sh("N=$((1 + 2)); X='alpha deliverable'"));
    });
    const refused = {
      'inside double quotes': ['X="a {{q}}"', /sits inside "…"/],
      'inside single quotes': ["X='a {{q}}'", /sits inside '…'/],
      // In $'…' a backslash-escaped quote does not end the string.
      'inside an ANSI-C string after an escaped quote': ["X=$'a\\' {{q}}'", /sits inside \$'…'/],
      'inside a parameter expansion': ['X="${Y:-{{q}}}"', /sits inside \$\{…\}/],
      'inside an unquoted parameter expansion': ['X=${Y:-{{q}}}', /sits inside \$\{…\}/],
      'inside backticks': ['X=`echo {{q}}`', /sits inside backticks/],
      'in a comment': ['true # {{q}}', /sits in a shell comment/],
      'in a heredoc': ['cat <<EOF\n{{q}}\nEOF', /sits in a heredoc/],
      'in prose': [null, /sits in prose/],
      // Codex review of PC2a: each of these rendered and ran the value's $(…).
      'right after a backslash, inside double quotes': ['X="\\{{q}}"', /right after a backslash/],
      'right after a backslash, unquoted': ['X=\\{{q}}', /right after a backslash/],
      'in an arithmetic expansion inside double quotes': ['X="$(({{q}}))"', /arithmetic expansion/],
      'in an arithmetic command': ['(( {{q}} ))', /arithmetic expansion/],
      'in a heredoc with a numeric delimiter': ['cat <<1\n{{q}}\n1', /in a heredoc/],
      'in a heredoc with a quoted punctuated delimiter': ["cat <<'X-1'\n{{q}}\nX-1", /in a heredoc/],
      'in the second of two heredocs': ['cat <<A <<B\na\nA\n{{q}}\nB', /in a heredoc/],
      'after a heredoc whose delimiter cannot be read': ['cat <<\n{{q}}', /in a heredoc/],
    };
    for (const [what, [line, re]] of Object.entries(refused)) {
      it(`refuses a shell value ${what}`, () => {
        throws(() => renderTemplate(line === null ? 'make {{q}}' : sh(line), d()), re);
      });
    }
    it('refuses a shell value in a fence that is not shell', () => {
      throws(() => renderTemplate('```text\n{{q}}\n```', d()), /not shell/);
    });
    it('refuses a markdown or text value anywhere in a shell block', () => {
      throws(() => renderTemplate(sh('X={{noun}}'), d()), /markdown value inside a shell block/);
      throws(() => renderTemplate(sh('X="{{noun}}"'), d()), /markdown value inside a shell block/);
      strictEqual(renderTemplate('```text\n{{noun}}\n```', d()), '```text\nalpha deliverable\n```');
    });
    it('a quote closed on its line leaves the next placeholder unquoted; a heredoc ends at its delimiter', () => {
      strictEqual(renderTemplate(sh(`echo "a" 'b' {{q}}`), d()), sh(`echo "a" 'b' 'alpha deliverable'`));
      strictEqual(renderTemplate(sh('cat <<-EOF\nx\n\tEOF\nX={{q}}'), d()), sh("cat <<-EOF\nx\n\tEOF\nX='alpha deliverable'"));
    });
    it('reads every shell block the plugins carry as closed: a placeholder after it is at a word position', () => {
      // The lexer only has to read the shell the runbooks use; a block it left
      // inside a quote would make it refuse a correct position, or accept a
      // wrong one, in every template that follows that shape.
      const files = [];
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.md')) files.push(full);
        }
      };
      walk(join(REPO_ROOT, 'plugins'));
      let blocks = 0;
      const misread = [];
      for (const f of files) {
        const lines = readFileSync(f, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = /^(\s*)```(bash|sh|zsh|shell)\s*$/.exec(lines[i]);
          if (!m) continue;
          let e = i + 1;
          while (e < lines.length && lines[e].trim() !== '```') e++;
          const body = lines.slice(i + 1, e).map((l) => l.slice(m[1].length));
          if (!body.some((l) => l.includes('{{'))) {
            blocks++;
            const where = placeholderPlacements(['```bash', ...body, '{{probe}}', '```'].join('\n')).filter((x) => x.name === 'probe').map((x) => x.where);
            if (where.join() !== 'word') misread.push(`${f.slice(REPO_ROOT.length + 1)}:${i + 1} → ${where.join()}`);
          }
          i = e;
        }
      }
      ok(blocks > 300, `only ${blocks} shell blocks found`);
      deepStrictEqual(misread, []);
    });
    it('refuses a placeholder that spans lines, and one the lexer cannot read', () => {
      throws(() => renderTemplate(sh('X={{q\n}}'), d()), /could not read/);
      throws(() => renderTemplate('make {{noun\n}}', d()), /could not read/);
      throws(() => renderTemplate(sh('X=${{q}}'), d()), /could not read/);
    });
    it('a heredoc ends at its own delimiter, and a placeholder after both of two heredocs is a word', () => {
      strictEqual(renderTemplate(sh("cat <<A <<'B-2'\na\nA\nb\nB-2\nX={{q}}"), d()), sh("cat <<A <<'B-2'\na\nA\nb\nB-2\nX='alpha deliverable'"));
    });
    it('refuses a value holding "{{", and anything left unresolved', () => {
      throws(() => renderTemplate(sh('X={{q}}'), d('{{q}}')), /holds "\{\{"/);
      throws(() => renderTemplate('make {{noun}}', d('a {{x')), /holds "\{\{"/);
      throws(() => renderTemplate('a {{ b', d()), /could not read/);
      // A value ending in "{" next to a template "{" makes a "{{" only after rendering.
      throws(() => renderTemplate('make {{noun}}{x', d('a{')), /unresolved "\{\{" left after rendering/);
    });
    it('renders a manifest value and a derived field, and refuses a substitution with both or neither', () => {
      const s2 = { verb: { value: 'checkpoint', context: 'shell' }, env: { field: 'derived.root_env', context: 'shell' } };
      strictEqual(renderTemplate(sh('V={{verb}} E={{env}}'), { declaration: renderingDeclaration(declaration({ name: 'web-ux' })), substitutions: s2 }),
        sh("V='checkpoint' E='AGENTIC_WEB_UX_ROOT'"));
      const manifest = (sub) => ({ schema: 'persona-pipeline-manifest-1.0', personas: ['alpha'], units: [], extension_points: [],
        regions: [{ id: 'r', template: 't.md', dest: 'c.md', personas: ['alpha'], substitutions: { x: sub } }] });
      throws(() => validateManifest(manifest({ field: 'name', value: 'a', context: 'shell' })), /exactly one of field and value/);
      throws(() => validateManifest(manifest({ context: 'shell' })), /exactly one of field and value/);
      throws(() => validateManifest(manifest({ value: '', context: 'shell' })), /non-empty string/);
      validateManifest(manifest({ value: 'a', context: 'shell' }));
    });
    it('derives the privacy spec as a skill cites it, from any skill directory, and nothing without a spec', () => {
      const derived = (privacy_spec) => renderingDeclaration(declaration({ name: 'alpha', ...(privacy_spec === undefined ? {} : { peer: { privacy_spec } }) })).derived;
      strictEqual(derived('core/skills/investigate/references/spec.md').skill_privacy_spec, '../investigate/references/spec.md');
      strictEqual(derived('docs/privacy.md').skill_privacy_spec, '../../../docs/privacy.md');
      ok(!Object.hasOwn(derived(undefined), 'skill_privacy_spec'), 'no spec, no derived citation');
      ok(!Object.hasOwn(derived(''), 'skill_privacy_spec'), 'an empty spec, no derived citation');
      throws(() => renderTemplate('See {{spec}}.', { declaration: renderingDeclaration(declaration({ name: 'alpha' })), substitutions: { spec: { field: 'derived.skill_privacy_spec', context: 'markdown' } } }), /unresolved placeholder \{\{spec\}\}/);
    });
    it('derives the spec as a shared reference cites it, and the brief file and output-root variable from the investigate default profile (PC2a4)', () => {
      const derived = (extra) => renderingDeclaration(declaration({ name: 'web-ux', ...extra })).derived;
      strictEqual(derived({ peer: { privacy_spec: 'core/skills/investigate/references/spec.md' } }).shared_privacy_spec, '../../investigate/references/spec.md');
      strictEqual(derived({ peer: { privacy_spec: 'docs/privacy.md' } }).shared_privacy_spec, '../../../../docs/privacy.md');
      ok(!Object.hasOwn(derived({}), 'shared_privacy_spec'), 'no spec, no derived citation');
      const withBrief = derived({ verbs: { investigate: { profiles: ['design-brief'], default_profile: 'design-brief' } } });
      strictEqual(withBrief.brief_file, 'design_brief.md');
      strictEqual(withBrief.output_root_env, 'WEB_UX_OUTPUT_ROOT');
      for (const extra of [{}, { verbs: { investigate: {} } }, { verbs: { frame: {} } }]) {
        const d = derived(extra);
        ok(!Object.hasOwn(d, 'brief_file') && !Object.hasOwn(d, 'output_root_env'), `no investigate default profile, no brief names: ${JSON.stringify(extra)}`);
      }
    });
    it('a declared brief file and output-root variable win over the derivation; neither is derived without a default profile (PC3 U7, format 1.3)', () => {
      const derived = (investigate) => renderingDeclaration(declaration({ name: 'web-ux', verbs: { investigate } })).derived;
      const declared = derived({ profiles: ['analysis', 'cited-brief'], default_profile: 'analysis', brief_file: 'research_brief.md', output_root_env: 'RESEARCH_OUTPUT_ROOT' });
      deepStrictEqual([declared.brief_file, declared.output_root_env], ['research_brief.md', 'RESEARCH_OUTPUT_ROOT']);
      const one = derived({ profiles: ['analysis'], default_profile: 'analysis', brief_file: 'research_brief.md' });
      deepStrictEqual([one.brief_file, one.output_root_env], ['research_brief.md', 'WEB_UX_OUTPUT_ROOT'], 'each declared name wins on its own');
      const none = derived({ brief_file: 'research_brief.md', output_root_env: 'RESEARCH_OUTPUT_ROOT' });
      ok(!Object.hasOwn(none, 'brief_file') && !Object.hasOwn(none, 'output_root_env'), 'no default profile, no brief names');
    });
    it('the brief profile and brief ensemble type: the default profile and ensemble type unless declared, and the brief file follows the brief profile (PC3b U5d, format 1.4)', () => {
      const derived = (investigate) => renderingDeclaration(declaration({ name: 'web-ux', verbs: { investigate } })).derived;
      const plain = derived({ profiles: ['design-brief'], default_profile: 'design-brief', ensemble_type: 'reference-scan' });
      deepStrictEqual([plain.brief_profile, plain.brief_ensemble_type, plain.brief_file], ['design-brief', 'reference-scan', 'design_brief.md']);
      const declared = derived({ profiles: ['analysis', 'cited-brief'], default_profile: 'analysis', ensemble_type: 'investigate', brief_profile: 'cited-brief', brief_ensemble_type: 'research-scan' });
      deepStrictEqual([declared.brief_profile, declared.brief_ensemble_type, declared.brief_file], ['cited-brief', 'research-scan', 'cited_brief.md'], 'the brief file is named after the brief profile, not the default one');
      const untyped = derived({ profiles: ['design-brief'], default_profile: 'design-brief' });
      ok(untyped.brief_profile === 'design-brief' && !Object.hasOwn(untyped, 'brief_ensemble_type'), 'no ensemble type declared, none derived');
      const none = derived({ brief_profile: 'cited-brief', brief_ensemble_type: 'research-scan' });
      ok(!Object.hasOwn(none, 'brief_profile') && !Object.hasOwn(none, 'brief_ensemble_type'), 'no default profile, no brief profile or type');
    });
    it('derives what the investigate headings name: the type and the profile with one profile, investigate (profile=<profile>) for both with several (PC3 U7)', () => {
      const derived = (investigate) => renderingDeclaration(declaration({ name: 'web-ux', verbs: { investigate } })).derived;
      const one = derived({ profiles: ['design-brief'], default_profile: 'design-brief', ensemble_type: 'reference-scan' });
      deepStrictEqual([one.investigate_launched, one.investigate_synthesis], ['reference-scan', 'design-brief']);
      const several = derived({ profiles: ['analysis', 'root-cause'], default_profile: 'analysis', ensemble_type: 'investigate' });
      deepStrictEqual([several.investigate_launched, several.investigate_synthesis], ['investigate (profile=<profile>)', 'investigate (profile=<profile>)']);
      const untyped = derived({ profiles: ['design-brief'], default_profile: 'design-brief' });
      ok(!Object.hasOwn(untyped, 'investigate_launched') && untyped.investigate_synthesis === 'design-brief', 'one profile, no type: no launched heading to name');
      const bare = derived({});
      ok(!Object.hasOwn(bare, 'investigate_launched') && !Object.hasOwn(bare, 'investigate_synthesis'), 'no profiles, no headings');
    });
    it('derives the profile variable from the name, as the persona loader names it (PC2a4)', () => {
      strictEqual(renderingDeclaration(declaration({ name: 'web-ux' })).derived.profile_env, 'AGENTIC_WEB_UX_PROFILE');
      strictEqual(renderingDeclaration(declaration({ name: 'designer' })).derived.profile_env, 'AGENTIC_DESIGNER_PROFILE');
    });
  });

  it('refuses a newline in a shell context and keeps it verbatim in markdown', () => {
    throws(() => renderTemplate('```sh\nV={{q}}\n```', { declaration: declaration({ deliverable_noun: 'a\nrm -rf /' }), substitutions: subs }), /newline/);
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
    match(alpha, /NOUN='alpha deliverable'\nnode "\$PLUGIN_ROOT\/scripts\/tool\.mjs" --persona 'alpha'/);
    match(alpha, /Record the parent linkage before finishing\./);
    ok(!alpha.includes('There is no parent to record.'));
    match(beta, /NOUN='beta'\\''s deliverable'/);
    match(beta, /There is no parent to record\./);
    ok(!beta.includes('Record the parent linkage'));
    // The variant region (DD2): alpha declares peer.images false and is
    // enrolled; beta, format 1.0 without peer, is outside the rule.
    match(alpha, /<!-- pipeline:begin no-image -->\nNo dispatch passes an image: the peer reads text only\.\n<!-- pipeline:end no-image -->/);
    ok(!beta.includes('pipeline:begin no-image'));

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

  const MARKER = '<!-- pipeline:extension persona-steps -->\n';
  // Each case breaks one thing; the rest of the file stays valid, so the
  // diagnostic it asserts is the one check that fails.
  const structural = {
    'a missing required region': [(t) => t.replace(/<!-- pipeline:begin intro -->\n[\s\S]*?<!-- pipeline:end intro -->\n/, '')],
    'regions out of order': [(t) => {
      const intro = /<!-- pipeline:begin intro -->\n[\s\S]*?<!-- pipeline:end intro -->\n/.exec(t)[0];
      return t.replace(intro, '').replace('Authored prose after the last region.', `${intro}Authored prose after the last region.`);
    }],
    'an unknown region id': [(t) => `${t}\n<!-- pipeline:begin surprise -->\n<!-- pipeline:end surprise -->\n`],
    'an undeclared extension point': [(t) => t.replace(MARKER, `${MARKER}<!-- pipeline:extension elsewhere -->\n`), /extension point elsewhere is not declared for this file/],
    // Both markers inside the slot: only the count can fail it.
    'an extension point over its slot count': [(t) => t.replace(MARKER, `${MARKER}\n${MARKER}`), /extension point persona-steps appears 2 time\(s\); the slot takes 1/],
    'a required extension point missing': [(t) => t.replace(MARKER, ''), /extension point persona-steps appears 0 time\(s\); the slot takes 1/],
    'an extension marker after its slot': [(t) => t.replace(MARKER, '').replace('Authored prose after the last region.', `${MARKER}Authored prose after the last region.`), /:\d+: extension point persona-steps sits outside its slot \(after region intro, before region finalize\)/],
    'an extension marker before its slot': [(t) => t.replace(MARKER, '').replace('Authored prose before the first region.', `${MARKER}Authored prose before the first region.`), /extension point persona-steps sits outside its slot/],
    'a broken marker': [(t) => t.replace('<!-- pipeline:end intro -->', '<!-- pipeline:end intro')],
  };
  for (const [what, [edit, diagnostic]] of Object.entries(structural)) {
    it(`fails the check on ${what}, and the write refuses leaving authored text as it was`, async () => {
      const root = fixtureCopy();
      strictEqual((await sync(root, { write: true })).code, 0, 'the fixture regenerates clean first');
      const path = join(root, 'plugins/beta/commands/run.md');
      const broken = edit(readFileSync(path, 'utf8'));
      ok(broken !== readFileSync(path, 'utf8'), 'the edit applies');
      writeFileSync(path, broken);
      const check = await sync(root);
      strictEqual(check.code, 1);
      match(check.err, /plugins\/beta\/commands\/run\.md/);
      if (diagnostic) {
        match(check.err, diagnostic);
        strictEqual(check.err.split('\n').filter((l) => l.startsWith('✗ ')).length, 1, `one failure, the one asserted: ${check.err}`);
      }
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

  // The render-time form of this failure is the renderTemplate case above
  // ("the declaration has no deliverable_noun"); the generator reports it
  // earlier, as the declaration's own failure, and renders nothing from it.
  it('fails a declaration that lacks a field an enrolled region reads, before any render', async () => {
    const root = fixtureCopy();
    const declPath = join(root, 'plugins/beta/persona.json');
    const d = JSON.parse(readFileSync(declPath, 'utf8'));
    delete d.deliverable_noun;
    writeFileSync(declPath, `${JSON.stringify(d, null, 2)}\n`);
    const check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /plugins\/beta\/persona\.json: region intro \(commands\/run\.md\) reads deliverable_noun for \{\{noun\}\}, which the declaration lacks/);
    ok(!/unresolved placeholder/.test(check.err), check.err);
  });
});

// Extension slots (PC2a3 DD6): owned, bounded on both sides, counted.
describe('extension slots (DD6)', () => {
  const FIXTURE_MANIFEST = JSON.parse(readFileSync(join(FIXTURE, 'persona-pipeline/manifest.json'), 'utf8'));
  const withSlot = (edit) => {
    const m = JSON.parse(JSON.stringify(FIXTURE_MANIFEST));
    edit(m.extension_points[0], m);
    return m;
  };

  it('the fixture slot validates', () => {
    validateManifest(withSlot(() => {}));
  });

  const refused = {
    'swapped bounds': [(e) => { e.after = 'finalize'; e.before = 'intro'; }, /after \(finalize\) does not come before before \(intro\) in commands\/run\.md for alpha/],
    'the same region on both sides': [(e) => { e.before = 'intro'; }, /does not come before before/],
    'an unknown bound': [(e) => { e.before = 'nowhere'; }, /extension_points\[0\]\.before: names no region of commands\/run\.md: "nowhere"/],
    'a bound of another file': [(e, m) => { m.regions.push({ ...m.regions[0], id: 'elsewhere', dest: 'commands/other.md' }); e.after = 'elsewhere'; }, /names no region of commands\/run\.md: "elsewhere"/],
    'a bound not enrolled for an owner': [(e, m) => { e.personas = ['alpha', 'beta']; e.before = 'no-image'; e.after = 'finalize'; }, /region no-image is not enrolled for beta in commands\/run\.md/],
    'min greater than max': [(e) => { e.min = 2; e.max = 1; }, /min 2 is greater than max 1/],
    'a negative min': [(e) => { e.min = -1; }, /min: must be an integer >= 0/],
    'a zero max': [(e) => { e.min = 0; e.max = 0; }, /max: must be an integer >= 1/],
    'a missing min': [(e) => { delete e.min; }, /min: must be an integer >= 0/],
    'a missing bound': [(e) => { delete e.before; }, /before: must be a region id/],
    'no owners': [(e) => { e.personas = []; }, /personas: must not be empty/],
    'an owner the manifest does not name': [(e) => { e.personas = ['alpha', 'gamma']; }, /persona "gamma" is not in manifest\.personas/],
    'an unknown key': [(e) => { e.position = 'end'; }, /unknown key "position"/],
  };
  for (const [what, [edit, re]] of Object.entries(refused)) {
    it(`the manifest refuses ${what}`, () => {
      throws(() => validateManifest(withSlot(edit)), re);
    });
  }

  it('fails a marker in a slot its persona does not own, and only that marker', async () => {
    const root = fixtureCopy();
    strictEqual((await sync(root, { write: true })).code, 0);
    const manifestPath = join(root, 'persona-pipeline/manifest.json');
    writeFileSync(manifestPath, JSON.stringify(withSlot((e) => { e.personas = ['alpha']; })));
    const check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /plugins\/beta\/commands\/run\.md:19: extension point persona-steps is not beta's \(it belongs to alpha\)/);
    strictEqual(check.err.split('\n').filter((l) => l.startsWith('✗ ')).length, 1, check.err);
  });

  it('a slot with min 0 passes with no marker', async () => {
    const root = fixtureCopy();
    strictEqual((await sync(root, { write: true })).code, 0);
    writeFileSync(join(root, 'persona-pipeline/manifest.json'), JSON.stringify(withSlot((e) => { e.min = 0; })));
    const path = join(root, 'plugins/beta/commands/run.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('<!-- pipeline:extension persona-steps -->\n', ''));
    strictEqual((await sync(root)).code, 0);
  });
});

// Variant regions (PC2a3 DD2): enrollment follows a declared value, both ways.
describe('variant regions (DD2)', () => {
  const region = (personas, equals = false) => ({ id: 'no-image', dest: 'commands/run.md', personas, when: { field: 'peer.images', equals } });
  const decl = (peer) => (peer === undefined ? { name: 'alpha' } : { name: 'alpha', peer });

  it('passes an enrolled persona whose value matches, and one without the field that is not enrolled', () => {
    deepStrictEqual(variantEnrolmentFailures({ persona: 'alpha', declaration: decl({ images: false }), regions: [region(['alpha'])] }), []);
    deepStrictEqual(variantEnrolmentFailures({ persona: 'alpha', declaration: decl(), regions: [region(['beta'])] }), []);
    deepStrictEqual(variantEnrolmentFailures({ persona: 'alpha', declaration: decl({ images: true }), regions: [region(['beta'])] }), []);
  });

  const failing = {
    'an enrolled persona whose value differs': [decl({ images: true }), ['alpha'], false, /enrolled in region no-image \(commands\/run\.md\), but declares peer\.images = true, not false/],
    'a matching persona left out': [decl({ images: false }), ['beta'], false, /declares peer\.images = false, so region no-image \(commands\/run\.md\) must enrol it/],
    'an enrolled persona without the field': [decl(), ['alpha'], false, /whose variant reads peer\.images, which the declaration lacks/],
    // Strict JSON type equality: false, "false", null and 0 all differ.
    'the string "false" for false': [decl({ images: 'false' }), ['alpha'], false, /declares peer\.images = "false", not false/],
    'null for false': [decl({ images: null }), ['alpha'], false, /declares peer\.images = null, not false/],
    '0 for false': [decl({ images: 0 }), ['alpha'], false, /declares peer\.images = 0, not false/],
    'false for the string "false"': [decl({ images: false }), ['alpha'], 'false', /declares peer\.images = false, not "false"/],
  };
  for (const [what, [d, personas, equals, re]] of Object.entries(failing)) {
    it(`fails ${what}`, () => {
      const failures = variantEnrolmentFailures({ persona: 'alpha', declaration: d, regions: [region(personas, equals)] });
      strictEqual(failures.length, 1, JSON.stringify(failures));
      match(failures[0], re);
    });
  }

  it('the manifest refuses a malformed when', () => {
    const manifest = (when) => ({ schema: 'persona-pipeline-manifest-1.0', personas: ['alpha'], units: [], extension_points: [],
      regions: [{ id: 'r', template: 't.md', dest: 'c.md', personas: ['alpha'], when }] });
    validateManifest(manifest({ field: 'peer.images', equals: false }));
    throws(() => validateManifest(manifest({ field: 'peer.images' })), /equals must be a string, a number or a boolean/);
    throws(() => validateManifest(manifest({ field: 'peer.images', equals: null })), /equals must be a string, a number or a boolean/);
    throws(() => validateManifest(manifest({ field: 'Peer Images', equals: false })), /field must be a dotted declaration path/);
    throws(() => validateManifest(manifest({ field: 'peer.images', equals: false, unless: true })), /unknown key "unless"/);
    throws(() => validateManifest(manifest(false)), /when: is not an object/);
  });

  // The generator applies the rule in both directions, per persona.
  it('the generator fails a mismatched enrollment in either direction, naming the persona', async () => {
    let root = fixtureCopy();
    const edit = (r, persona, fn) => {
      const path = join(r, 'plugins', persona, 'persona.json');
      const d = JSON.parse(readFileSync(path, 'utf8'));
      fn(d);
      writeFileSync(path, JSON.stringify(d, null, 2));
    };
    edit(root, 'alpha', (d) => { d.peer.images = true; });
    let check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /plugins\/alpha\/persona\.json: enrolled in region no-image \(commands\/run\.md\), but declares peer\.images = true, not false/);

    root = fixtureCopy();
    edit(root, 'beta', (d) => { d.schema = 'persona-declaration-1.2'; d.peer = { privacy_scope: 'beta secrets', privacy_spec: 'commands/run.md', images: false }; });
    check = await sync(root);
    strictEqual(check.code, 1);
    match(check.err, /plugins\/beta\/persona\.json: declares peer\.images = false, so region no-image \(commands\/run\.md\) must enrol it/);
  });
});
