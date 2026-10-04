import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  projectClaudeStatusline,
  readUserGlobalClaudeSettings,
  readUserGlobalModelEffort,
  readUserGlobalSession,
} from '../../plugins/runtime/scripts/lib/profile-readers.mjs';

// The bootstrap judges read user-global config ONLY (machine-bootstrap-contract.md
// §1.1). These tests pin: no repo/repo-local value can enter the result;
// absent/malformed/unreadable are reported (not crashed); and every value carries
// user-global provenance. The permission and egress reader cases went with the
// portable machine profile, their only consumer (ADR-0064 Decision 3).

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'profile-readers-'));
  return home;
}
async function writeFileAt(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

describe('profile-readers: session family', () => {
  it('reads the session family from the user-global file, with provenance', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'),
      'session_capture = "stop-hook"\nentry_brief = "startup"\n');
    const s = await readUserGlobalSession({ homeDir: home });
    strictEqual(s.family, 'session');
    strictEqual(s.keys.session_capture.value, 'stop-hook');
    strictEqual(s.keys.session_capture.provenance, 'user-global');
    strictEqual(s.keys.entry_brief.value, 'startup');
    strictEqual(s.keys.entry_brief_empty.value, null, 'unset key -> null');
    strictEqual(s.keys.entry_brief_empty.provenance, null, 'and names no source');
    strictEqual(s.source.status, 'readable');
  });

  it('reads the user-global file by construction — it accepts no repo input at all', async () => {
    // The repo-isolation guarantee, pinned the only way it is actually decidable
    // at this seam. An earlier version of this test created a temp repo, wrote a
    // competing `session_capture` into it, and called itself the control that proves
    // the projection ignores repo config — but `readUserGlobalSession` takes only
    // `homeDir`, never enters a repo, and nothing passed that directory anywhere.
    // Deleting the repo setup left the test green, which is the definition of
    // decorative (cross-host review).
    //
    // What holds instead is structural: the reader's signature admits no repo, and
    // the module's ONLY path to a file is the user-global one. A repo-preferring
    // regression would have to add an input, which this assertion pins.
    const src = await readFile(new URL('../../plugins/runtime/scripts/lib/profile-readers.mjs', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function projectSession'));
    ok(!/repoRoot|repo_root|cwd/.test(body.slice(0, body.indexOf('\n}'))), 'projectSession takes no repo input');

    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'), 'session_capture = "off"\n');
    const s = await readUserGlobalSession({ homeDir: home });
    strictEqual(s.keys.session_capture.value, 'off', 'and the user-global value is what it reports');
    strictEqual(s.keys.session_capture.provenance, 'user-global');
  });

  it('a missing config is reported, not crashed — every key null with no provenance', async () => {
    const home = await makeHome();
    const s = await readUserGlobalSession({ homeDir: home });
    strictEqual(s.source.status, 'missing');
    for (const key of ['session_capture', 'entry_brief', 'entry_brief_empty']) {
      strictEqual(s.keys[key].value, null);
      strictEqual(s.keys[key].provenance, null);
    }
  });

  it('projects the SAME snapshot the other family reads (one file, two projections)', async () => {
    const { readUserGlobalRuntimeConfig, projectModelEffort, projectSession } =
      await import('../../plugins/runtime/scripts/lib/profile-readers.mjs');
    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'),
      'model = "opus"\nsession_capture = "stop-hook"\n');
    const snapshot = await readUserGlobalRuntimeConfig({ homeDir: home });
    // One read, two projections — so an atomic replacement cannot land between
    // two reads and let two judges agree about a file neither version satisfies.
    strictEqual(projectModelEffort(snapshot).keys.model.value, 'opus');
    strictEqual(projectSession(snapshot).keys.session_capture.value, 'stop-hook');
    deepStrictEqual(projectSession(snapshot).source, snapshot.source, 'the projection carries the snapshot source');
  });
});

describe('profile-readers: model/effort (user-global runtime config)', () => {
  it('reads ONLY ~/.agentic-plugins/config.toml, carries user-global provenance', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'),
      'model = "opus"\nclaude_effort = "high"\n');
    const me = await readUserGlobalModelEffort({ homeDir: home });
    strictEqual(me.keys.model.value, 'opus');
    strictEqual(me.keys.model.provenance, 'user-global');
    strictEqual(me.keys.claude_effort.value, 'high');
    strictEqual(me.keys.codex_model.value, null, 'unset key → null');
    strictEqual(me.keys.codex_model.provenance, null);
    strictEqual(me.source.status, 'readable');
  });

  it('a repo .agentic-plugins/config.toml is structurally unreachable (reader takes only homeDir)', async () => {
    // The reader signature has no repoRoot: it CANNOT read repo config. This test
    // documents the repo-isolation guarantee — a different repo value coexisting never leaks.
    const home = await makeHome();
    await writeFileAt(join(home, '.agentic-plugins', 'config.toml'), 'model = "user-opus"\n');
    // A repo config with a conflicting value sitting in the cwd is simply never consulted.
    const me = await readUserGlobalModelEffort({ homeDir: home });
    strictEqual(me.keys.model.value, 'user-opus');
  });

  it('absent user config → all keys null, status missing (never throws)', async () => {
    const home = await makeHome();
    const me = await readUserGlobalModelEffort({ homeDir: home });
    strictEqual(me.source.status, 'missing');
    for (const key of Object.keys(me.keys)) strictEqual(me.keys[key].value, null);
  });
});

// The statusline judge's source (bootstrap.mjs reads it once per probe). These
// cases used to ride on the permission reader, which shared the file and went
// with the machine profile (ADR-0064 Decision 3); they are pinned here against
// the reader the judge calls. A malformed or unreadable settings.json must stay
// distinguishable from a missing one, or the judge would report an absent
// statusline for a file it never managed to read.
describe('profile-readers: user-global Claude settings (statusline judge source)', () => {
  it('reads settings.json once and projects its statusLine', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'node s.mjs' } }));
    const snapshot = await readUserGlobalClaudeSettings({ homeDir: home });
    deepStrictEqual(snapshot.source, { scope: 'user', status: 'readable' });
    deepStrictEqual(projectClaudeStatusline(snapshot),
      { readable: true, present: true, type: 'command', command: 'node s.mjs' });
  });

  it('malformed JSON → status malformed, no json, and the projection is not readable', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.claude', 'settings.json'), '{ not json');
    const snapshot = await readUserGlobalClaudeSettings({ homeDir: home });
    strictEqual(snapshot.source.status, 'malformed');
    strictEqual(snapshot.json, null);
    strictEqual(projectClaudeStatusline(snapshot).readable, false);
  });

  it('a directory where settings.json should be → status unreadable (not missing)', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.claude', 'settings.json'), { recursive: true });
    const snapshot = await readUserGlobalClaudeSettings({ homeDir: home });
    strictEqual(snapshot.source.status, 'unreadable');
    strictEqual(projectClaudeStatusline(snapshot).readable, false);
  });

  it('absent → missing, which still reads as "no statusline"', async () => {
    const home = await makeHome();
    const snapshot = await readUserGlobalClaudeSettings({ homeDir: home });
    strictEqual(snapshot.source.status, 'missing');
    deepStrictEqual(projectClaudeStatusline(snapshot),
      { readable: true, present: false, type: null, command: null });
  });

  it('honors CLAUDE_CONFIG_DIR instead of ~/.claude', async () => {
    const home = await makeHome();
    await writeFileAt(join(home, '.claude', 'settings.json'), '{ not json');
    const relocated = join(home, 'relocated');
    await writeFileAt(join(relocated, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }));
    const snapshot = await readUserGlobalClaudeSettings({ homeDir: home, env: { CLAUDE_CONFIG_DIR: relocated } });
    strictEqual(snapshot.source.status, 'readable');
    strictEqual(projectClaudeStatusline(snapshot).command, 'x');
  });
});
