import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCodexConfigToml,
  readCodexConfigToml,
} from '../../plugins/runtime/scripts/lib/codex-config.mjs';

// `parseCodexConfigToml` and its tests moved here from lib/notification-plan.mjs and
// test-notification-plan.mjs (ADR-0064 Decision 2, item 6): bootstrap's Codex
// statusline judge reads the `[tui]` table through it and outlives the notification
// plan. The `notify` cases go with ADR-0064 Decision 1.
describe('codex-config parseCodexConfigToml (top-level notify + [tui] table)', () => {
  it('reports an absent notify key', () => {
    const parsed = parseCodexConfigToml('model = "gpt-5"\n[tools]\nweb_search = true\n');
    strictEqual(parsed.notify.present, false);
    strictEqual(parsed.notify.raw, null);
    strictEqual(parsed.notify.values, null);
    strictEqual(parsed.tuiNotifications.present, false);
  });

  it('parses a single-line array, keeping # and ] inside strings and dropping a trailing comment', () => {
    const parsed = parseCodexConfigToml(
      'notify = ["notify-send", "msg # not-a-comment", "a]b"] # trailing "quoted" comment\n',
    );
    strictEqual(parsed.notify.present, true);
    deepStrictEqual(parsed.notify.values, ['notify-send', 'msg # not-a-comment', 'a]b']);
    ok(!parsed.notify.raw.includes('trailing'), 'comment after the closing bracket is not captured');
  });

  it('parses a multi-line array with per-line comments and escaped quotes', () => {
    const parsed = parseCodexConfigToml([
      'notify = [',
      '  "python3", # interpreter',
      '  "/home/me/my notify.py",',
      '  "say \\"done\\"",',
      "  'literal\"quote',",
      ']',
      '',
    ].join('\n'));
    deepStrictEqual(parsed.notify.values, ['python3', '/home/me/my notify.py', 'say "done"', 'literal"quote']);
  });

  it('flags a non-array notify value as present but not parseable', () => {
    const parsed = parseCodexConfigToml('notify = "python3 notify.py"\n');
    strictEqual(parsed.notify.present, true);
    strictEqual(parsed.notify.values, null);
  });

  it('flags an array with non-string elements as not parseable', () => {
    const parsed = parseCodexConfigToml('notify = ["python3", 42]\n');
    strictEqual(parsed.notify.present, true);
    strictEqual(parsed.notify.values, null);
  });

  it('decodes the full TOML escape set faithfully and fail-safes on forms it cannot decode', () => {
    // n must decode to 'n' — passing it through as 'u006e' would chain a
    // DIFFERENT command than the configured one (Plan-verify peer MAJOR).
    const unicode = parseCodexConfigToml('notify = ["\\u006eotify-send", "tab\\there", "\\U0001F514"]\n');
    deepStrictEqual(unicode.notify.values, ['notify-send', 'tab\there', '\u{1F514}']);
    // An escape outside the TOML set cannot be decoded faithfully → null.
    const unknownEscape = parseCodexConfigToml('notify = ["bad\\qescape"]\n');
    strictEqual(unknownEscape.notify.present, true);
    strictEqual(unknownEscape.notify.values, null);
    // Truncated/invalid unicode escapes → null.
    strictEqual(parseCodexConfigToml('notify = ["\\u00"]\n').notify.values, null);
    // Triple-quoted (multi-line) string forms → null, both flavors.
    strictEqual(parseCodexConfigToml('notify = ["""python3"""]\n').notify.values, null);
    strictEqual(parseCodexConfigToml("notify = ['''python3''']\n").notify.values, null);
  });

  it('honors notify only at the top level; a DUPLICATE key is invalid TOML and fails closed (peer finding — last-wins was wrong)', () => {
    const sectioned = parseCodexConfigToml('[tools]\nnotify = ["hidden"]\n');
    strictEqual(sectioned.notify.present, false, 'notify inside a section is not the top-level key');
    const duplicated = parseCodexConfigToml('notify = ["first"]\nnotify = ["second"]\n');
    strictEqual(duplicated.notify.present, true);
    strictEqual(duplicated.notify.values, null, 'duplicate top-level keys are invalid TOML — no argv is trusted from them');
  });

  it('reads [tui] notifications (array and boolean shapes)', () => {
    const arrayShape = parseCodexConfigToml('[tui]\nnotifications = ["agent-turn-complete"]\n');
    strictEqual(arrayShape.tuiNotifications.present, true);
    ok(arrayShape.tuiNotifications.raw.includes('agent-turn-complete'));
    const boolShape = parseCodexConfigToml('[tui]\nnotifications = true\n');
    strictEqual(boolShape.tuiNotifications.present, true);
    strictEqual(boolShape.tuiNotifications.raw, 'true');
    const otherSection = parseCodexConfigToml('[tools]\nnotifications = true\n');
    strictEqual(otherSection.tuiNotifications.present, false);
  });

  it('reads the dotted top-level tui.notifications form', () => {
    const dotted = parseCodexConfigToml('tui.notifications = ["approval-requested"]\nnotify = ["x"]\n');
    strictEqual(dotted.tuiNotifications.present, true);
    ok(dotted.tuiNotifications.raw.includes('approval-requested'));
    deepStrictEqual(dotted.notify.values, ['x']);
    // The dotted form is only a TOP-LEVEL key; inside a section it is a
    // different table and must not be misread.
    const sectioned = parseCodexConfigToml('[other]\ntui.notifications = ["approval-requested"]\n');
    strictEqual(sectioned.tuiNotifications.present, false);
  });

  // ADR-0040 §4b — `form` is the TYPED classification a judge may interpret.
  // A boolean "is the capture clean" flag was tried first and does NOT work:
  // the structural facts alone call `["a" "b"]` and `true junk` clean, because
  // the capture closed with no trailing junk. So the classification is
  // exhaustive and fails closed to `invalid`, and `raw` is never interpreted.
  it('classifies every observable [tui] notifications shape, failing closed to invalid', () => {
    const form = (text) => parseCodexConfigToml(text).tuiNotifications.form;
    const tui = (line) => `[tui]\n${line}\n`;

    strictEqual(form('[tui]\nstatus_line = []\n'), 'absent');
    strictEqual(form(tui('notifications = true')), 'true');
    strictEqual(form(tui('notifications = false')), 'false');
    strictEqual(form(tui('notifications = true # deliberate')), 'true', 'a comment is not part of the value');
    strictEqual(form(tui('notifications = ["approval-requested", "agent-turn-complete"]')), 'array');
    strictEqual(form(tui('notifications = []')), 'array', 'an empty array is a present operator selection, not a malformed one');

    // Everything a probe must refuse. `true junk`/`false junk` matter most:
    // the scanner reports them as structurally clean, so only an EXACT scalar
    // match may promote them — a prefix test would certify the junk.
    strictEqual(form(tui('notifications = true junk')), 'invalid');
    strictEqual(form(tui('notifications = false junk')), 'invalid');
    strictEqual(form(tui('notifications = "approval-requested"')), 'invalid', 'a bare string is neither boolean nor array');
    strictEqual(form(tui('notifications = ["a" "b"]')), 'invalid', 'no comma — not a flat string array');
    strictEqual(form(tui('notifications = ["approval-requested"] junk')), 'invalid', 'trailing non-comment junk');
    strictEqual(form(tui('notifications = ["approval-requested"')), 'invalid', 'unclosed array');
    strictEqual(form('[tui]\nnotifications = false\nnotifications = ["approval-requested"]\n'), 'invalid', 'duplicate key');
    strictEqual(form('[tui]\nnotifications = ["approval-requested"]\n[other]\nx = 1\n[tui]\ny = 2\n'), 'invalid', 'redefined [tui] table');
  });

  // The forgery this closes: a dotted assignment IMPLICITLY creates [tui], so a
  // later explicit [tui] header redefines it — invalid TOML Codex will not
  // load, whose captured raw nonetheless reads exactly like a canonical value.
  // `tuiRedefined` gates every [tui] key, so the same fix covers status_line,
  // whose EXACT probe already ships.
  it('a dotted tui.<key> followed by an explicit [tui] header is a redefinition — for BOTH tui keys', () => {
    const notif = parseCodexConfigToml('tui.notifications = ["approval-requested", "agent-turn-complete"]\n[tui]\nstatus_line = ["model-with-reasoning"]\n');
    strictEqual(notif.tuiNotifications.form, 'invalid');
    strictEqual(notif.tuiNotifications.values, null, 'a canonical-LOOKING raw must never yield trusted values');
    ok(notif.tuiNotifications.raw.includes('approval-requested'), 'the raw is still surfaced for the operator — it just may not be interpreted');

    const status = parseCodexConfigToml('tui.status_line = ["model-with-reasoning"]\n[tui]\nnotifications = false\n');
    strictEqual(status.tuiStatusLine.form, 'invalid');
    strictEqual(status.tuiStatusLine.values, null, 'the sibling EXACT probe must not certify an invalid config either');

    // Without the later header the dotted form is ordinary, trusted TOML.
    const clean = parseCodexConfigToml('tui.notifications = ["approval-requested"]\nnotify = ["x"]\n');
    strictEqual(clean.tuiNotifications.form, 'array');
    deepStrictEqual(clean.tuiNotifications.values, ['approval-requested']);
  });

  // Round-2 review: the first redefinition fix covered only the two keys this
  // scan READS, but ANY `tui.<…>` assignment creates the table, and a key's
  // identity can be clouded several other ways. Each shape below was measured
  // certifying a canonical-looking array out of a config Codex rejects.
  it('refuses every construct that clouds the [tui] table or the key identity', () => {
    const form = (text) => parseCodexConfigToml(text).tuiNotifications.form;
    const CANON = 'notifications = ["approval-requested", "agent-turn-complete"]';

    strictEqual(form(`tui.color = "blue"\n[tui]\n${CANON}\n`), 'invalid',
      'an UNRELATED dotted tui key also creates the table, so the later header still redefines it');
    strictEqual(form(`[tui.notifications]\nx = 1\n[tui]\n${CANON}\n`), 'invalid',
      'the key name was claimed as a sub-table first');
    strictEqual(form(`[tui]\nnotifications.enabled = true\n${CANON}\n`), 'invalid',
      'a deeper dotted path defines the key as a table');
    strictEqual(form(`tui.notifications.enabled = true\n`), 'invalid',
      'the same, in the dotted top-level form');
    strictEqual(form(`[tui]\n${CANON}\n'notifications' = false\n`), 'invalid',
      'a literal-quoted key is the SAME key — matching only bare/double-quoted let the duplicate through');
    strictEqual(form(`tui = { notifications = ["approval-requested", "agent-turn-complete"] }\n`), 'invalid',
      'an inline table is a form this scan cannot read — reporting it ABSENT would send the operator a [tui] merge that breaks a config Codex accepts');

    // Legal shapes must keep working: defining a super-table after a sub-table
    // is valid TOML, and an unrelated sub-table name collides with nothing.
    strictEqual(form(`[tui.other]\nx = 1\n[tui]\n${CANON}\n`), 'array');
    strictEqual(form(`[tui]\n"notifications" = ["approval-requested", "agent-turn-complete"]\n`), 'array');
    strictEqual(form(`[tui]\n'notifications' = ["approval-requested", "agent-turn-complete"]\n`), 'array');
  });

  it('a triple delimiter inside a COMMENT does not open a string, so a section transition is never swallowed', () => {
    const CANON = 'notifications = ["approval-requested", "agent-turn-complete"]';
    // `# """` then `[tui.child] # """` made the scanner consume the header and
    // read the nested value as if it sat under [tui]. The value genuinely lives
    // at tui.child.notifications, so the honest answer is ABSENT — the key is
    // unset, exactly as Codex sees it.
    const nested = parseCodexConfigToml(`[tui]\n# """\n[tui.child] # """\n${CANON}\n`);
    strictEqual(nested.tuiNotifications.form, 'absent');
    // The same trick against the sibling probe, with literal triples.
    const sl = parseCodexConfigToml("[tui]\n# '''\n[tui.child] # '''\nstatus_line = [\"model-with-reasoning\"]\n");
    strictEqual(sl.tuiStatusLine.form, 'absent');
    // A name-colliding nested table still poisons the key.
    strictEqual(parseCodexConfigToml(`[tui]\n# """\n[tui.notifications] # """\nx = 1\n`).tuiNotifications.form, 'invalid');
    // CONTROL — a REAL triple-quoted value still hides a look-alike key inside
    // it, and a `#` after the opening delimiter is part of the string.
    strictEqual(parseCodexConfigToml(`[tui]\nother = """\n${CANON}\n"""\n`).tuiNotifications.form, 'absent');
    strictEqual(parseCodexConfigToml(`[tui]\nother = """  # inside\n${CANON}\n"""\n`).tuiNotifications.form, 'absent');
    // CONTROL — a `#` inside an ordinary string value must not truncate the line.
    strictEqual(parseCodexConfigToml(`[tui]\nother = "a # b"\n${CANON}\n`).tuiNotifications.form, 'array');
  });
});

// The one $CODEX_HOME/config.toml read (ADR-0064 Decision 2, item 6): bootstrap
// projects it for its Codex permission, notify and statusline judges, so its home
// resolution and provenance label are what those judges report.
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
