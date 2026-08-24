import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECEIVER_READ_MAX_BYTES,
  buildReceiverReinstallStep,
  classifyInstalledReceiver,
  inspectInstalledReceivers,
  normalizeRenderedReceiver,
  rollUpReceiverStates,
} from '../../plugins/runtime/scripts/lib/receiver-inventory.mjs';
import { renderAgenticStatuslineShim } from '../../plugins/runtime/scripts/lib/statusline-plan.mjs';


// Classifying what is INSTALLED at the receiver paths.
//
// Since the receivers became delegating shims (ADR-0048 §2 as amended), a
// LEGACY full copy still runs its own frozen logic and looks perfectly healthy
// from the outside — the settings step that proves "statusLine is configured"
// is satisfied by a stale shim exactly as well as by a current one. The only
// way to see the difference is to classify the installed bytes, and that has to
// happen WITHOUT executing them: these are user-installed files of unknown
// provenance.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const STATUSLINE = 'agentic-statusline.mjs';

// The real v0.91.2 template — checked in under tests/fixtures/receivers rather
// than read from git at test time. Using ACTUAL released bytes is the point (a
// hand-written fixture would only prove the classifier agrees with itself), but
// shelling out to `git show <tag>` would fail on a shallow or tagless checkout
// for an environmental reason rather than a defect. `releasedShapesRegistry`
// below binds each fixture to the release it claims to be.
function releasedTemplate(tag, basename) {
  strictEqual(tag, 'plugin-runtime-v0.91.2', 'only the v0.91.2 fixtures are checked in');
  return readFileSync(join(REPO_ROOT, 'tests/fixtures/receivers', `${basename.replace(/\.mjs$/, '')}.v0.91.2.template.mjs`), 'utf8');
}

function releasedShapesRegistry() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'plugins/runtime/data/released-receiver-shapes.json'), 'utf8')).shapes;
}

// Render a template the way the planner does, so the fixture on disk is a
// rendered file and not a template.
function renderLike(template, { items = ['model-with-reasoning'], version = '0.91.0' } = {}) {
  return template
    .replace("['__AGENTIC_STATUSLINE_ITEMS__']", JSON.stringify(items))
    .replace("'__AGENTIC_MIN_RUNTIME_VERSION__'", JSON.stringify(version));
}

async function installDirWith(files) {
  const dir = await mkdtemp(join(tmpdir(), 'receiver-inventory-'));
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(bin, name), content);
  return bin;
}

describe('installed receiver inventory — classification without execution', () => {
  it('binds each checked-in fixture to the release it claims to be', () => {
    // A fixture that drifted from the release it names would silently certify
    // the wrong shape, and every legacy assertion below would still pass. This
    // pins fixture bytes to the packaged registry entry, so the two cannot
    // disagree without failing here first.
    const registry = releasedShapesRegistry();
    for (const basename of [STATUSLINE, 'codex-notify-shuttle.mjs']) {
      const fixture = releasedTemplate('plugin-runtime-v0.91.2', basename);
      const entry = registry[basename]?.[sha256(fixture)];
      ok(entry, `${basename} fixture is not a registered released shape`);
      ok(entry.includes('v0.91.2'), `${basename} fixture claims v0.91.2 but the registry says ${entry}`);
    }
  });

  it('reports a CURRENT install by matching the packaged template through normalization', async () => {
    const current = await readFile(join(REPO_ROOT, 'plugins/runtime/receivers', STATUSLINE), 'utf8');
    const bin = await installDirWith({ [STATUSLINE]: renderAgenticStatuslineShim().body });
    const r = classifyInstalledReceiver({
      kind: STATUSLINE, path: join(bin, STATUSLINE), currentTemplateSha: sha256(current),
    });
    strictEqual(r.state, 'current');
    // The RAW hash differs (the file is rendered); only the normalized one matches.
    ok(r.sha256 !== r.normalized_sha256, 'a rendered file does not hash as its template');
    strictEqual(r.normalized_sha256, sha256(current));
    ok(r.marker, 'the current shim carries its generation marker');
  });

  it('reports a LEGACY install as the released shape it actually is', async () => {
    const legacyTemplate = releasedTemplate('plugin-runtime-v0.91.2', STATUSLINE);
    const bin = await installDirWith({ [STATUSLINE]: renderLike(legacyTemplate) });
    const current = await readFile(join(REPO_ROOT, 'plugins/runtime/receivers', STATUSLINE), 'utf8');
    const r = classifyInstalledReceiver({
      kind: STATUSLINE,
      path: join(bin, STATUSLINE),
      currentTemplateSha: sha256(current),
      knownReleasedShapes: { [sha256(legacyTemplate)]: 'plugin-runtime-v0.86.0 … v0.91.2' },
    });
    strictEqual(r.state, 'legacy', 'a released-but-superseded shape is legacy, not foreign');
    strictEqual(r.shipped_in, 'plugin-runtime-v0.86.0 … v0.91.2');
    strictEqual(r.marker, null, 'the legacy full copy predates the marker');
  });

  it('CONTROL: an unrecognized file is FOREIGN, not legacy', async () => {
    // Without this control, `legacy` could be a classifier that says "legacy"
    // to anything that is not current.
    const bin = await installDirWith({ [STATUSLINE]: '#!/usr/bin/env node\nconsole.log("mine");\n' });
    const r = classifyInstalledReceiver({
      kind: STATUSLINE,
      path: join(bin, STATUSLINE),
      currentTemplateSha: sha256('irrelevant'),
      knownReleasedShapes: { [sha256(releasedTemplate('plugin-runtime-v0.91.2', STATUSLINE))]: 'v0.91.2' },
    });
    strictEqual(r.state, 'foreign');
    ok(/edited, hand-written, or produced by another tool/.test(r.detail));
  });

  it('reports MISSING, and never invents a state for a path that is not there', async () => {
    const bin = await installDirWith({});
    const r = classifyInstalledReceiver({ kind: STATUSLINE, path: join(bin, STATUSLINE) });
    strictEqual(r.state, 'missing');
    strictEqual(r.sha256, null);
    strictEqual(r.bytes, null);
  });

  it('reports a SYMLINK without following it', async () => {
    // A symlink is reported, never resolved: following it would let the
    // classifier certify a target it does not name. This matters because an
    // operator who symlinks into a dotfiles repo gets an honest report rather
    // than a silent pass on content from somewhere else.
    const bin = await installDirWith({ 'real-target.mjs': renderAgenticStatuslineShim().body });
    await symlink(join(bin, 'real-target.mjs'), join(bin, STATUSLINE));
    const current = await readFile(join(REPO_ROOT, 'plugins/runtime/receivers', STATUSLINE), 'utf8');
    const r = classifyInstalledReceiver({
      kind: STATUSLINE, path: join(bin, STATUSLINE), currentTemplateSha: sha256(current),
    });
    strictEqual(r.state, 'not-a-regular-file', 'a symlink to CURRENT content is still reported as a symlink');
    strictEqual(r.sha256, null, 'its target is never read');
    ok(/not followed or classified/.test(r.detail));
  });

  it('reports UNREADABLE for a path it cannot stat or read, and for an over-cap file', async () => {
    const bin = await installDirWith({ [STATUSLINE]: 'x' });
    const denied = classifyInstalledReceiver({
      kind: STATUSLINE,
      path: join(bin, STATUSLINE),
      lstat: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; },
    });
    strictEqual(denied.state, 'unreadable');

    const oversized = classifyInstalledReceiver({
      kind: STATUSLINE,
      path: join(bin, STATUSLINE),
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, size: RECEIVER_READ_MAX_BYTES + 1 }),
      readFile: () => { throw new Error('must not be read'); },
    });
    strictEqual(oversized.state, 'unreadable');
    ok(/over the .* inspection cap; it is not read/.test(oversized.detail), oversized.detail);
  });

  it('restores a seat only when it holds exactly what the renderer emits', () => {
    // Normalization identifies a file by putting it back into template form. A
    // seat pattern that accepted ANY content would ERASE an edit rather than
    // detect it, landing a tampered file on the untouched template's hash — so
    // a seat is restored only when it holds the canonical JSON literal the
    // renderer produces.
    const honest = [
      '// const MIN_RUNTIME_VERSION = "9.9.9"; in a comment',
      'const MIN_RUNTIME_VERSION = "1.2.3";',
      'const STATUSLINE_ITEMS = ["a", "b"];',
    ].join('\n');
    const good = normalizeRenderedReceiver(honest);
    deepStrictEqual(good.rejected, [], 'a faithful render rejects nothing');
    deepStrictEqual(good.seats.STATUSLINE_ITEMS, ['a', 'b']);
    strictEqual(good.seats.MIN_RUNTIME_VERSION, '1.2.3');
    ok(good.normalized.includes("const MIN_RUNTIME_VERSION = '__AGENTIC_MIN_RUNTIME_VERSION__';"));
    ok(good.normalized.includes('// const MIN_RUNTIME_VERSION = "9.9.9"; in a comment'), 'a commented mention is untouched');

    // Each of these is a seat holding something the renderer never emits.
    for (const bad of [
      'const STATUSLINE_ITEMS = [globalThis.pwned = true, "a"];',
      'const STATUSLINE_ITEMS = [items];',
      'const MIN_RUNTIME_VERSION = version;',
      'const MIN_RUNTIME_VERSION = "not-a-semver";',
    ]) {
      const out = normalizeRenderedReceiver(bad);
      ok(out.rejected.length > 0, `must reject: ${bad}`);
      strictEqual(out.normalized, bad, 'a rejected seat is left exactly as found, never erased');
    }
  });

  it('each rejection layer catches a case the others do not', () => {
    // Three layers guard a seat: the canonical GRAMMAR, then JSON.parse, then a
    // type check. They overlap, so removing any one still leaves a tampered
    // file caught — which means a single mutation proves little. These are the
    // cases that isolate each layer, so a regression in one is visible even
    // while the others still hold.
    const cases = [
      // Neither canonical nor parseable — the expression the evasion used.
      ['const STATUSLINE_ITEMS = [globalThis.pwned = true, "a"];', 'grammar+parse'],
      // Valid JSON, but NOT the spacing the renderer emits: only the grammar
      // separates a hand-written array from a rendered one.
      ['const STATUSLINE_ITEMS = ["a","b"];', 'grammar only'],
      // Canonical-looking and parseable, but the wrong element type: only the
      // validator catches this.
      ['const STATUSLINE_ITEMS = [1, 2];', 'validate only'],
    ];
    for (const [src, layer] of cases) {
      const out = normalizeRenderedReceiver(src);
      deepStrictEqual(out.rejected, ['STATUSLINE_ITEMS'], `${layer} must reject: ${src}`);
      strictEqual(out.normalized, src, `${layer}: a rejected seat is never erased`);
    }
    // Control: exactly what the renderer emits is accepted.
    const okCase = normalizeRenderedReceiver('const STATUSLINE_ITEMS = ["a", "b"];');
    deepStrictEqual(okCase.rejected, []);
    ok(okCase.normalized.includes('__AGENTIC_STATUSLINE_ITEMS__'));
  });

  it('names the tampered seat in the report, not just "foreign"', async () => {
    // A rejected seat and an unrecognized file both classify as foreign; the
    // difference an operator needs is WHY. This pins the precise detail, which
    // is the value the rejection path adds over the generic fallthrough.
    const honestBody = renderAgenticStatuslineShim().body;
    const tampered = honestBody.replace(
      /const STATUSLINE_ITEMS = \[[^\]]*\];/,
      'const STATUSLINE_ITEMS = [globalThis.pwned = true, "model-with-reasoning"];',
    );
    const bin = await installDirWith({ [STATUSLINE]: tampered });
    const r = classifyInstalledReceiver({ kind: STATUSLINE, path: join(bin, STATUSLINE) });
    strictEqual(r.state, 'foreign');
    ok(/STATUSLINE_ITEMS/.test(r.detail), `the detail must name the seat, got: ${r.detail}`);
    ok(/not a faithful render/.test(r.detail));
  });

  it('hashes the installed BYTES, not a decoded string', async () => {
    // Two files differing only in an INVALID UTF-8 sequence decode to the same
    // replacement characters. Hashing the decoded string would certify them
    // identical — the reason ADR-0051 gives for hashing bytes in the artifact
    // readers.
    const dir = await mkdtemp(join(tmpdir(), 'receiver-bytes-'));
    const a = join(dir, 'a.mjs');
    const b = join(dir, 'b.mjs');
    await writeFile(a, Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0x0a]));
    await writeFile(b, Buffer.from([0x2f, 0x2f, 0x20, 0xfe, 0x0a]));
    const ra = classifyInstalledReceiver({ kind: STATUSLINE, path: a });
    const rb = classifyInstalledReceiver({ kind: STATUSLINE, path: b });
    strictEqual(ra.state, 'foreign');
    strictEqual(rb.state, 'foreign');
    ok(ra.sha256 !== rb.sha256, 'two files differing only in an invalid byte must not share a hash');
  });

  it('REGRESSION: a tampered render is FOREIGN, never current', async () => {
    // The concrete evasion: put an expression in the item seat and the file
    // still normalized onto the current template hash, so doctor reported
    // `current` for modified bytes and suppressed the re-install advice.
    const current = await readFile(join(REPO_ROOT, 'plugins/runtime/receivers', STATUSLINE), 'utf8');
    const honestBody = renderAgenticStatuslineShim().body;
    const tampered = honestBody.replace(
      /const STATUSLINE_ITEMS = \[[^\]]*\];/,
      'const STATUSLINE_ITEMS = [globalThis.pwned = true, "model-with-reasoning"];',
    );
    ok(tampered !== honestBody, 'the fixture really is modified');

    const bin = await installDirWith({ honest: honestBody, tampered });
    const classify = (name) => classifyInstalledReceiver({
      kind: STATUSLINE, path: join(bin, name), currentTemplateSha: sha256(current),
    });
    // Control first: the unmodified render must still read as current, or
    // "tampered is foreign" would prove nothing.
    strictEqual(classify('honest').state, 'current');
    strictEqual(classify('tampered').state, 'foreign');
  });

  it('an absent OPT-IN receiver is a fact, not a defect', async () => {
    // Every receiver is opt-in, and the chain receiver exists only when a prior
    // notifier had to be preserved. Treating any absence as something to fix
    // would tell most machines to install a file they deliberately do not have.
    const bin = await installDirWith({});
    const notOptedIn = inspectInstalledReceivers({ installDir: bin, expected: [] });
    strictEqual(notOptedIn.state, 'current', 'nothing installed and nothing expected is not a defect');
    strictEqual(notOptedIn.reinstall_recommended, false);
    strictEqual(buildReceiverReinstallStep(notOptedIn), null, 'a healthy machine gets no nag');

    const optedIn = inspectInstalledReceivers({ installDir: bin, expected: [STATUSLINE] });
    strictEqual(optedIn.state, 'incomplete');
    strictEqual(optedIn.reinstall_recommended, true);
  });

  it('rolls up worst-first, and never offers to overwrite a file runtime did not render', async () => {
    const entries = [
      { kind: 'a', state: 'legacy', expected: true, path_pointer: 'p/a', shipped_in: 'v1' },
      { kind: 'b', state: 'foreign', expected: true, path_pointer: 'p/b' },
    ];
    strictEqual(rollUpReceiverStates(entries), 'attention', 'foreign outranks legacy');

    const step = buildReceiverReinstallStep({ state: 'attention', receivers: entries });
    strictEqual(step.reinstall.length, 1, 'only the legacy one is offered for re-install');
    strictEqual(step.reinstall[0].kind, 'a');
    strictEqual(step.manual_review.length, 1, 'the foreign one is named for manual review');
    ok(/runtime does not overwrite a file it did not render/.test(step.manual_review[0].action));
  });

  it('states the rollback honestly for a delegating replacement', async () => {
    const step = buildReceiverReinstallStep({
      state: 'stale',
      receivers: [{ kind: STATUSLINE, state: 'legacy', expected: true, path_pointer: 'p', shipped_in: 'v0.91.2' }],
    });
    const text = step.rollback.join(' ');
    ok(/SELF-CONTAINED copy: restoring that backup fully reverts behaviour/.test(text));
    // The load-bearing half: restoring a DELEGATING backup does not revert
    // behaviour, because behaviour comes from the resolved runtime.
    ok(/restoring a backup of one does NOT revert behaviour/.test(text));
    ok(/rolling the runtime plugin back too/.test(text));
  });

  it('surfaces the inventory in doctor TEXT output, not only in JSON', async () => {
    // Text is doctor's DEFAULT format. A section wired only into the JSON
    // report is one most operators never see, which for a "your installed shim
    // is stale" signal defeats the purpose. Rendered from a REAL doctor run
    // against a temp home, so the assertion cannot pass on source text alone.
    const { formatText, runDoctor } = await import('../../plugins/runtime/scripts/doctor.mjs');
    const home = await mkdtemp(join(tmpdir(), 'receiver-doctor-home-'));
    const bin = join(home, '.agentic-plugins', 'bin');
    await mkdir(bin, { recursive: true });
    const legacy = renderLike(releasedTemplate('plugin-runtime-v0.91.2', STATUSLINE));
    await writeFile(join(bin, STATUSLINE), legacy);

    const report = await runDoctor({
      repoRoot: REPO_ROOT, homeDir: home, format: 'text',
      runner: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'probe skipped' }),
    });
    strictEqual(report.receivers.state, 'stale', 'the run observed the legacy install');

    const text = formatText(report);
    ok(text.includes('Installed Receivers (stale)'), 'the section is rendered in text');
    ok(text.includes(`${STATUSLINE}: legacy`), 'and names the stale receiver');
    ok(/next: runtime:settings/.test(text), 'and points at where the re-install plan lives');
  });

  it('never executes, imports, or spawns an installed receiver', async () => {
    // A file that would fail loudly if anything evaluated it. Classification
    // must be pure byte-reading, so this must classify cleanly.
    const booby = '#!/usr/bin/env node\nthrow new Error("EXECUTED");\nprocess.exit(3);\n';
    const bin = await installDirWith({ [STATUSLINE]: booby });
    await chmod(join(bin, STATUSLINE), 0o755);
    const r = classifyInstalledReceiver({ kind: STATUSLINE, path: join(bin, STATUSLINE) });
    strictEqual(r.state, 'foreign');
    strictEqual(r.bytes, booby.length);
    // Structural backstop: the module must not reach for an execution
    // primitive. Matched as CODE, not as prose — the limits text legitimately
    // contains the word "spawned", and a substring check on that would pass or
    // fail for the wrong reason.
    const source = await readFile(join(REPO_ROOT, 'plugins/runtime/scripts/lib/receiver-inventory.mjs'), 'utf8');
    const forbidden = [
      [/from\s+'node:child_process'/, 'import of node:child_process'],
      [/\bspawn(Sync)?\s*\(/, 'a spawn call'],
      [/\bexecFile(Sync)?\s*\(/, 'an execFile call'],
      [/\bexec(Sync)?\s*\(/, 'an exec call'],
      [/\bimport\s*\(/, 'a dynamic import'],
      [/\beval\s*\(/, 'an eval'],
    ];
    for (const [pattern, label] of forbidden) {
      ok(!pattern.test(source), `the inventory must not contain ${label}`);
    }
    // Non-vacuity: the same patterns MUST fire on a module that does execute,
    // so a passing result means "absent here", never "pattern never matches".
    const executor = await readFile(join(REPO_ROOT, 'plugins/runtime/scripts/receiver-api.mjs'), 'utf8');
    ok(forbidden.some(([pattern]) => pattern.test(executor)), 'the forbidden patterns are able to match real code');
  });
});
