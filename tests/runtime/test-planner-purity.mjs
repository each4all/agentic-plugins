import { describe, it } from 'node:test';
import { ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// machine-bootstrap-contract.md §1.3 split the planners into gather (I/O) /
// deterministic build / persist, and this file pinned the build layer of the
// notification and egress-launcher planners. ADR-0064 Decision 1 removed both
// planners and their build-layer cases; the §1.1 import-closure guard below is
// about the planner LAYER, so it stays, re-pointed at the surviving planner.

// ---------------------------------------------------------------------------
// §1.1 — the planner import-closure boundary
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(REPO_ROOT, 'plugins/runtime/scripts/lib');

// ADR-0057 deleted `permission-plan.mjs`, which was the ONLY module this closure
// guard was ever pointed at. The §1.1 rule it enforces — a planner must not reach
// doctor.mjs, the host-CLI probe, a subprocess, or a dynamic import — is about the
// planner LAYER, not about that one file, so the guard is RE-POINTED at the
// surviving planners rather than deleted with its first subject. Deleting it would
// have removed the repository's only instance of this check as a side effect of
// removing something else.
//
// ADR-0064 then deleted the two planners it was re-pointed at, and it is
// re-pointed again for the same reason: the statusline planner is the one that
// renders bootstrap's Stage 5 fragments. (`plugin-management-plan.mjs` is not a
// candidate: it reads the probe's plugin table through `machine-probe.mjs` by
// design.)
const CLOSURE_GUARDED_PLANNERS = ['statusline-plan.mjs'];

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Semicolon-agnostic (the test-consensus-probe-boundary.mjs precedent — Codex found a
// semicolonless import slipping past the first version of that gate).
function parseImports(code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) out.push(m[2]);
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

async function localClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const code = stripComments(await readFile(path, 'utf8'));
    for (const spec of parseImports(code)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}


describe('planner purity §1.1: planner import closure', () => {
  for (const planner of CLOSURE_GUARDED_PLANNERS) {
    it(`${planner} never reaches doctor.mjs, the host-CLI probe, or a subprocess`, async () => {
      // §1.1 forbids the bootstrap chain from inheriting doctor's reads: "the reads still
      // happen, and any future consumer of the filtered report re-inherits them".
      const closure = await localClosure(join(LIB, planner));
      // Non-vacuity: an empty closure would pass every assertion below without
      // reading a byte of the planner.
      ok(closure.size > 0, `${planner} closure is empty — the walker never read the entry`);
      for (const forbidden of ['doctor.mjs', 'machine-probe.mjs', 'settings.mjs', 'consensus.mjs']) {
        ok(
          ![...closure].some((f) => f.endsWith(`/${forbidden}`)),
          `${forbidden} must not be reachable from ${planner} — closure: ${[...closure].map((f) => f.replace(REPO_ROOT, '')).join(', ')}`,
        );
      }
      for (const path of closure) {
        const code = stripComments(await readFile(path, 'utf8'));
        ok(!/from\s+['"]node:child_process['"]/.test(code), `${path} must not import node:child_process`);
        ok(!/\bimport\s*\(/.test(code), `${path} must not use a dynamic import (it would route around this gate)`);
      }
    });
  }
});
