import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCodexConfigToml,
  readCodexConfigToml,
} from '../../plugins/runtime/scripts/lib/codex-config.mjs';

// `parseCodexConfigToml` and its tests moved here from the notification plan and
// its tests (ADR-0064 Decision 2, item 6): bootstrap's Codex statusline judge
// reads the `[tui]` table through it and outlived the notification plan. ADR-0064
// Decision 1 removed the `notify` and `[tui] notifications` reads; the cases that
// pinned the scanner's generic rules through `notifications` now pin them through
// `status_line`, the key the scan still reads.
describe('codex-config parseCodexConfigToml ([tui] status_line)', () => {
  it('returns only the status_line projection, and reports it absent when unset', () => {
    const parsed = parseCodexConfigToml('model = "gpt-5"\n[tools]\nweb_search = true\n');
    deepStrictEqual(Object.keys(parsed), ['tuiStatusLine']);
    strictEqual(parsed.tuiStatusLine.present, false);
    strictEqual(parsed.tuiStatusLine.raw, null);
    strictEqual(parsed.tuiStatusLine.values, null);
    strictEqual(parsed.tuiStatusLine.form, 'absent');
  });

  it('parses a single-line array, keeping # and ] inside strings and dropping a trailing comment', () => {
    const parsed = parseCodexConfigToml(
      '[tui]\nstatus_line = ["model", "msg # not-a-comment", "a]b"] # trailing "quoted" comment\n',
    );
    strictEqual(parsed.tuiStatusLine.present, true);
    deepStrictEqual(parsed.tuiStatusLine.values, ['model', 'msg # not-a-comment', 'a]b']);
    ok(!parsed.tuiStatusLine.raw.includes('trailing'), 'comment after the closing bracket is not captured');
  });

  it('parses a multi-line array with per-line comments and escaped quotes', () => {
    const parsed = parseCodexConfigToml([
      '[tui]',
      'status_line = [',
      '  "model", # first item',
      '  "/home/me/a b",',
      '  "say \\"done\\"",',
      "  'literal\"quote',",
      ']',
      '',
    ].join('\n'));
    deepStrictEqual(parsed.tuiStatusLine.values, ['model', '/home/me/a b', 'say "done"', 'literal"quote']);
  });

  it('decodes the full TOML escape set faithfully and fail-safes on forms it cannot decode', () => {
    // n must decode to 'n' — passing it through as 'u006e' would trust a
    // DIFFERENT value than the configured one (Plan-verify peer MAJOR).
    const values = (line) => parseCodexConfigToml(`[tui]\n${line}\n`).tuiStatusLine.values;
    deepStrictEqual(values('status_line = ["\\u006eame", "tab\\there", "\\U0001F514"]'), ['name', 'tab\there', '\u{1F514}']);
    // An escape outside the TOML set cannot be decoded faithfully → null.
    strictEqual(values('status_line = ["bad\\qescape"]'), null);
    // Truncated/invalid unicode escapes → null.
    strictEqual(values('status_line = ["\\u00"]'), null);
    // Triple-quoted (multi-line) string forms → null, both flavors.
    strictEqual(values('status_line = ["""model"""]'), null);
    strictEqual(values("status_line = ['''model''']"), null);
    // Non-string elements → null.
    strictEqual(values('status_line = ["model", 42]'), null);
  });

  it('reads status_line only under [tui] or as the dotted top-level tui.status_line', () => {
    strictEqual(parseCodexConfigToml('[tools]\nstatus_line = ["model"]\n').tuiStatusLine.present, false);
    const dotted = parseCodexConfigToml('tui.status_line = ["model"]\n');
    deepStrictEqual(dotted.tuiStatusLine.values, ['model']);
    // The dotted form is only a TOP-LEVEL key; inside a section it is a
    // different table and must not be misread.
    strictEqual(parseCodexConfigToml('[other]\ntui.status_line = ["model"]\n').tuiStatusLine.present, false);
  });

  // ADR-0064 Decision 9: an operator's Codex config keeps its `notify =` line
  // until the owner's cleanup, and `[tui] notifications` is Codex's own key. The
  // scan no longer reads either, but it still steps over each as ONE value: a
  // multi-line array scanned line by line would put its lines in front of the
  // header and key matchers.
  it('steps over a multi-line notify array and [tui] notifications array without reading them', () => {
    const parsed = parseCodexConfigToml([
      'notify = [',
      '  "node",',
      '[tui]',
      'status_line = ["forged"]',
      ']',
      '[tui]',
      'notifications = [',
      '  "agent-turn-complete",',
      'status_line = ["forged-too"]',
      ']',
      'status_line = ["model"]',
      '',
    ].join('\n'));
    strictEqual(parsed.tuiStatusLine.form, 'array');
    deepStrictEqual(parsed.tuiStatusLine.values, ['model'],
      'a line inside either array is part of that value, never a header or the status_line key');
    strictEqual(parsed.notify, undefined);
    strictEqual(parsed.tuiNotifications, undefined);
  });

  it('steps over the dotted tui.notifications form as one value too (Refine-verify peer)', () => {
    // A triple delimiter inside a valid multi-line array must not open a string
    // that swallows the real status_line after it…
    const hidden = parseCodexConfigToml([
      'tui.notifications = [',
      `  '"""',`,
      ']',
      'tui.status_line = ["model"]',
      '',
    ].join('\n'));
    deepStrictEqual(hidden.tuiStatusLine.values, ['model']);
    // …and an assignment-looking line inside the array is part of that value,
    // never the status_line key.
    const embedded = parseCodexConfigToml([
      'tui.notifications = [',
      '  "x",',
      'tui.status_line = ["forged"]',
      ']',
      '',
    ].join('\n'));
    strictEqual(embedded.tuiStatusLine.form, 'absent');
  });

  // ADR-0040 §4b — `form` is the TYPED classification a judge may interpret.
  // A boolean "is the capture clean" flag was tried first and does NOT work:
  // the structural facts alone call `["a" "b"]` and `true junk` clean, because
  // the capture closed with no trailing junk. So the classification is
  // exhaustive and fails closed to `invalid`, and `raw` is never interpreted.
  it('classifies every observable [tui] status_line shape, failing closed to invalid', () => {
    const form = (text) => parseCodexConfigToml(text).tuiStatusLine.form;
    const tui = (line) => `[tui]\n${line}\n`;

    strictEqual(form('[tui]\nnotifications = []\n'), 'absent');
    strictEqual(form(tui('status_line = true')), 'true');
    strictEqual(form(tui('status_line = false')), 'false');
    strictEqual(form(tui('status_line = true # deliberate')), 'true', 'a comment is not part of the value');
    strictEqual(form(tui('status_line = ["model", "context-remaining"]')), 'array');
    strictEqual(form(tui('status_line = []')), 'array', 'an empty array is a present operator selection, not a malformed one');

    // Everything a probe must refuse. `true junk`/`false junk` matter most:
    // the scanner reports them as structurally clean, so only an EXACT scalar
    // match may promote them — a prefix test would certify the junk.
    strictEqual(form(tui('status_line = true junk')), 'invalid');
    strictEqual(form(tui('status_line = false junk')), 'invalid');
    strictEqual(form(tui('status_line = "model"')), 'invalid', 'a bare string is neither boolean nor array');
    strictEqual(form(tui('status_line = ["a" "b"]')), 'invalid', 'no comma — not a flat string array');
    strictEqual(form(tui('status_line = ["model"] junk')), 'invalid', 'trailing non-comment junk');
    strictEqual(form(tui('status_line = ["model"')), 'invalid', 'unclosed array');
    strictEqual(form('[tui]\nstatus_line = false\nstatus_line = ["model"]\n'), 'invalid', 'duplicate key');
    strictEqual(form('[tui]\nstatus_line = ["model"]\n[other]\nx = 1\n[tui]\ny = 2\n'), 'invalid', 'redefined [tui] table');
  });

  // The forgery this closes: a dotted assignment IMPLICITLY creates [tui], so a
  // later explicit [tui] header redefines it — invalid TOML Codex will not
  // load, whose captured raw nonetheless reads exactly like a canonical value.
  it('a dotted tui.<key> followed by an explicit [tui] header is a redefinition', () => {
    const status = parseCodexConfigToml('tui.status_line = ["model-with-reasoning"]\n[tui]\nnotifications = false\n');
    strictEqual(status.tuiStatusLine.form, 'invalid');
    strictEqual(status.tuiStatusLine.values, null, 'a canonical-LOOKING raw must never yield trusted values');
    ok(status.tuiStatusLine.raw.includes('model-with-reasoning'), 'the raw is still surfaced for the operator — it just may not be interpreted');

    // The other way round: the dotted key is Codex's own, the read key sits
    // under the redefining header.
    const viaSibling = parseCodexConfigToml('tui.notifications = ["approval-requested"]\n[tui]\nstatus_line = ["model-with-reasoning"]\n');
    strictEqual(viaSibling.tuiStatusLine.form, 'invalid');

    // Without the later header the dotted form is ordinary, trusted TOML.
    const clean = parseCodexConfigToml('tui.status_line = ["model-with-reasoning"]\nnotify = ["x"]\n');
    strictEqual(clean.tuiStatusLine.form, 'array');
    deepStrictEqual(clean.tuiStatusLine.values, ['model-with-reasoning']);
  });

  // Round-2 review: the first redefinition fix covered only the keys this scan
  // READ, but ANY `tui.<…>` assignment creates the table, and a key's identity
  // can be clouded several other ways. Each shape below was measured
  // certifying a canonical-looking array out of a config Codex rejects.
  it('refuses every construct that clouds the [tui] table or the key identity', () => {
    const form = (text) => parseCodexConfigToml(text).tuiStatusLine.form;
    const CANON = 'status_line = ["model-with-reasoning", "context-remaining"]';

    strictEqual(form(`tui.color = "blue"\n[tui]\n${CANON}\n`), 'invalid',
      'an UNRELATED dotted tui key also creates the table, so the later header still redefines it');
    strictEqual(form(`[tui.status_line]\nx = 1\n[tui]\n${CANON}\n`), 'invalid',
      'the key name was claimed as a sub-table first');
    strictEqual(form(`[tui]\nstatus_line.enabled = true\n${CANON}\n`), 'invalid',
      'a deeper dotted path defines the key as a table');
    strictEqual(form(`tui.status_line.enabled = true\n`), 'invalid',
      'the same, in the dotted top-level form');
    strictEqual(form(`[tui]\n${CANON}\n'status_line' = false\n`), 'invalid',
      'a literal-quoted key is the SAME key — matching only bare/double-quoted let the duplicate through');
    strictEqual(form(`tui = { status_line = ["model-with-reasoning"] }\n`), 'invalid',
      'an inline table is a form this scan cannot read — reporting it ABSENT would send the operator a [tui] merge that breaks a config Codex accepts');

    // Legal shapes must keep working: defining a super-table after a sub-table
    // is valid TOML, and an unrelated sub-table name collides with nothing —
    // including Codex's own `notifications`, which this scan no longer reads.
    strictEqual(form(`[tui.other]\nx = 1\n[tui]\n${CANON}\n`), 'array');
    strictEqual(form(`[tui.notifications]\nx = 1\n[tui]\n${CANON}\n`), 'array');
    strictEqual(form(`[tui]\n"status_line" = ["model-with-reasoning", "context-remaining"]\n`), 'array');
    strictEqual(form(`[tui]\n'status_line' = ["model-with-reasoning", "context-remaining"]\n`), 'array');
  });

  it('a triple delimiter inside a COMMENT does not open a string, so a section transition is never swallowed', () => {
    const CANON = 'status_line = ["model-with-reasoning"]';
    // `# """` then `[tui.child] # """` made the scanner consume the header and
    // read the nested value as if it sat under [tui]. The value genuinely lives
    // at tui.child.status_line, so the honest answer is ABSENT — the key is
    // unset, exactly as Codex sees it.
    strictEqual(parseCodexConfigToml(`[tui]\n# """\n[tui.child] # """\n${CANON}\n`).tuiStatusLine.form, 'absent');
    strictEqual(parseCodexConfigToml(`[tui]\n# '''\n[tui.child] # '''\n${CANON}\n`).tuiStatusLine.form, 'absent');
    // A name-colliding nested table still poisons the key.
    strictEqual(parseCodexConfigToml(`[tui]\n# """\n[tui.status_line] # """\nx = 1\n`).tuiStatusLine.form, 'invalid');
    // CONTROL — a REAL triple-quoted value still hides a look-alike key inside
    // it, and a `#` after the opening delimiter is part of the string.
    strictEqual(parseCodexConfigToml(`[tui]\nother = """\n${CANON}\n"""\n`).tuiStatusLine.form, 'absent');
    strictEqual(parseCodexConfigToml(`[tui]\nother = """  # inside\n${CANON}\n"""\n`).tuiStatusLine.form, 'absent');
    // CONTROL — a `#` inside an ordinary string value must not truncate the line.
    strictEqual(parseCodexConfigToml(`[tui]\nother = "a # b"\n${CANON}\n`).tuiStatusLine.form, 'array');
  });
});

// The one $CODEX_HOME/config.toml read (ADR-0064 Decision 2, item 6): bootstrap
// projects it for its Codex statusline judge, so its home resolution and
// provenance label are what that judge reports.
describe('codex-config readCodexConfigToml', () => {
  it('reads $CODEX_HOME/config.toml when CODEX_HOME is set, not the default home', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-codex-config-read-'));
    const codexHome = join(dir, 'custom-codex');
    await mkdir(codexHome);
    await writeFile(join(codexHome, 'config.toml'), 'model = "override"\n');
    await mkdir(join(dir, '.codex'));
    await writeFile(join(dir, '.codex', 'config.toml'), 'model = "default"\n');
    const { read, codexHomeSource } = await readCodexConfigToml({ homeDir: dir, env: { CODEX_HOME: codexHome } });
    strictEqual(read.ok, true);
    strictEqual(read.text, 'model = "override"\n');
    strictEqual(codexHomeSource, 'CODEX_HOME env override');
  });

  it('falls back to ~/.codex and reports a missing file as ENOENT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-codex-config-read-'));
    const { read, codexHomeSource } = await readCodexConfigToml({ homeDir: dir, env: {} });
    strictEqual(read.ok, false);
    strictEqual(read.reason, 'ENOENT');
    strictEqual(read.path, join(dir, '.codex', 'config.toml'));
    strictEqual(codexHomeSource, 'default ~/.codex');
  });
});
