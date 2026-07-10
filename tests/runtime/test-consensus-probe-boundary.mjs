// Static boundary gate: `consensus.mjs` must never be able to probe a host CLI.
//
// The runtime gate in test-consensus.mjs ('resolves peer context WITHOUT spawning any
// host CLI') only observes spawns routed through the INJECTED runner. Both reviewers
// showed it is therefore defeatable:
//
//   - `runDoctor()` called with its DEFAULT runner (`runner = runCommand`) spawns for
//     real and bypasses the injected recorder entirely;
//   - `runCommand('claude', ['--version'])` — and `runCommand` is already imported by
//     consensus for the companion launch — probes for real and is equally invisible.
//
// Neither is caught by the executor-guard (consensus is not a capability importer) nor
// by the peer-execution-context allowlist (which scans only that one file). So the
// boundary is asserted statically, over consensus's whole local dependency closure, with
// `./doctor.mjs` treated as a named-export boundary.
//
// SCOPE, honestly: this is a REGRESSION gate, not a sandbox. It catches the ways this
// code would actually drift back — re-importing `runDoctor`, naming a host CLI as a
// command, reaching `child_process`, or hiding an import behind `import()`. A determined
// author can still defeat it: alias the allowed `runCommand` binding, build the command
// from a template literal, or route it through a wrapper module that imports `runCommand`
// and passes 'claude' itself. Closing THAT requires a capability-narrowed executor —
// consensus should receive a `runCompanion(scriptPath, …)` that cannot express an
// arbitrary command — which is a separate deliverable. Do not read this file as proof
// that probing is impossible; read it as proof that probing cannot happen by accident.

import { describe, it } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(REPO_ROOT, 'plugins/runtime/scripts');
const CONSENSUS = join(SCRIPTS, 'consensus.mjs');
const DOCTOR = join(SCRIPTS, 'doctor.mjs');

// doctor.mjs is the one module allowed in the closure, and ONLY for this symbol.
// `runDoctor` would drag in the 14-probe fan-out; `runCommand` is the companion spawner.
const DOCTOR_ALLOWED_SPECIFIERS = ['runCommand'];

// Any call that passes a host CLI as the command argument.
const HOST_COMMAND_LITERAL = /\(\s*['"](?:claude|codex)['"]\s*,/;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Deliberately semicolon-agnostic: a semicolonless `import x from './y.mjs'` must not
// slip past the scan (Codex found exactly that hole in the first version of this gate).
function parseImports(code) {
  const out = [];
  for (const match of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    out.push({ clause: match[1], spec: match[2] });
  }
  for (const match of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    out.push({ clause: '', spec: match[1] });
  }
  return out;
}

function namedSpecifiers(clause) {
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return [];
  return braces[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
}

const isLocal = (spec) => spec.startsWith('.');

async function readCode(path) {
  return stripComments(await readFile(path, 'utf8'));
}

/** Every local module consensus can reach, with doctor.mjs as a closed boundary. */
async function localClosure(entry) {
  const seen = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const code = await readCode(path);
    seen.set(path, code);
    if (path === DOCTOR) continue; // boundary: audited by specifier, not traversed
    for (const { spec } of parseImports(code)) {
      if (isLocal(spec)) queue.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}

describe('consensus probe boundary (static)', () => {
  it('imports exactly `runCommand` from doctor.mjs — never runDoctor', async () => {
    const code = await readCode(CONSENSUS);
    // Exact path, not a suffix: `./lib/evil-doctor.mjs` also ends in 'doctor.mjs'.
    const doctorImports = parseImports(code).filter(({ spec }) => resolve(dirname(CONSENSUS), spec) === DOCTOR);
    deepStrictEqual(doctorImports.length, 1, 'consensus should import doctor.mjs exactly once');
    deepStrictEqual(
      namedSpecifiers(doctorImports[0].clause).sort(),
      DOCTOR_ALLOWED_SPECIFIERS,
      'importing runDoctor would re-introduce the 14-probe fan-out the seam removed',
    );
    ok(!/\brunDoctor\b/.test(code), 'runDoctor must not appear in consensus code');
  });

  it('never names a host CLI as a command in code', async () => {
    const code = await readCode(CONSENSUS);
    // `runner(...)`/`runCommand(...)` may only ever launch the companion via execPath.
    ok(!HOST_COMMAND_LITERAL.test(code), "consensus must not pass 'claude'/'codex' as a command");
    ok(/runner\(process\.execPath/.test(code), 'the companion launch must go through process.execPath');
  });

  it('no module in the local closure can spawn, except doctor.mjs at its allowed boundary', async () => {
    const closure = await localClosure(CONSENSUS);
    const paths = [...closure.keys()].map((p) => p.replace(`${REPO_ROOT}/`, ''));
    ok(paths.length >= 3, `the closure walk must actually traverse; saw ${paths.join(', ')}`);

    for (const [path, code] of closure) {
      const rel = path.replace(`${REPO_ROOT}/`, '');
      if (path === DOCTOR) continue; // its spawn capability is fenced by the specifier gate above
      ok(!/child_process/.test(code), `${rel} must not reach child_process`);
      ok(!/\brunDoctor\b/.test(code), `${rel} must not reach runDoctor`);
      ok(!/\bimport\s*\(/.test(code), `${rel} must not use a dynamic import (it would defeat this scan)`);
      // Closes the wrapper hole: a lib module that imports the allowed `runCommand` and
      // passes 'claude' itself would otherwise probe on consensus's behalf.
      ok(!HOST_COMMAND_LITERAL.test(code), `${rel} must not name a host CLI as a command`);
    }
  });

  it('the closure walk reaches the seam and the doctor boundary (so the scan is not vacuous)', async () => {
    const closure = await localClosure(CONSENSUS);
    const rel = [...closure.keys()].map((p) => p.replace(`${REPO_ROOT}/`, '')).sort();
    ok(rel.includes('plugins/runtime/scripts/consensus.mjs'));
    ok(rel.includes('plugins/runtime/scripts/doctor.mjs'), 'doctor is reachable, but only for runCommand');
    ok(rel.includes('plugins/runtime/scripts/lib/peer-execution-context.mjs'), 'the seam must be in the closure');
  });
});
