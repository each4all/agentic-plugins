// ADR-0061 §Decision 3 — no production code resolves a sibling plugin from the
// Codex marketplace clone, ~/.codex/.tmp/marketplaces/agentic-plugins/.
//
// The clone tracks the repository's main branch. Codex installs from it into
// its versioned cache, and after ADR-0061's activation the cache holds each
// package's release commit while the clone keeps moving, so any reader of the
// clone runs unreleased code beside skills that came from a release. Decision
// 3 removes the clone from every ladder, with no fallback, and §Consequences
// says a future reader "reintroduces the defect"; this gate is what makes that
// a failing test instead of a review comment.
//
// The implementation manifest moves the locators in three steps (S1 companion
// discovery, S2 sibling resolvers, S3 runtime diagnostics and receivers), so
// PENDING lists the files a later step still owns. The comparison is EXACT, in
// both directions:
//   - a new reference anywhere fails, whoever writes it;
//   - a PENDING file that no longer references the clone fails too, so the
//     list can only shrink with the code and never outlives it. When S3 lands,
//     PENDING is empty.
// OBSERVATION is the one file ADR-0061 keeps: machine-probe.mjs reports the
// clone's presence as a fact and never resolves code from it (Decision 4:
// "Snapshot presence remains 'not installation evidence'").

import { describe, it } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// Owned by ADR-0061 S2 (sibling resolvers) or S3 (runtime diagnostics and
// receivers). Remove each entry in the change that removes its reference.
const PENDING = [
  'plugins/attention/scripts/discover-runtime.mjs', // S2
  'plugins/designer/scripts/discover-runtime.mjs', // S2
  'plugins/engineer/scripts/discover-runtime.mjs', // S2
  'plugins/engineer/scripts/parent-writeback.mjs', // S2
  'plugins/founder/scripts/discover-runtime.mjs', // S2
  'plugins/orchestrator/scripts/discover-engineer.mjs', // S2
  'plugins/orchestrator/scripts/discover-runtime.mjs', // S2
  'plugins/runtime/receivers/agentic-statusline.mjs', // S3
  'plugins/runtime/receivers/codex-notify-shuttle.mjs', // S3
  'plugins/runtime/scripts/doctor.mjs', // S2 (engineer resolver), S3 (effective hooks)
  'plugins/runtime/scripts/lib/peer-execution-context.mjs', // S2
];

const OBSERVATION = [
  'plugins/runtime/scripts/lib/machine-probe.mjs',
];

// Both spellings the tree uses: path segments passed to join() (possibly split
// across lines) and a literal '.tmp/marketplaces' path.
const CLONE_REFERENCE = /(['"`])\.tmp\1\s*,\s*(['"`])marketplaces\2|\.tmp\/marketplaces/;

const CODE = /\.(?:mjs|cjs|js)$/;

// Comment-only lines are prose, not locators: the comments that explain why
// the clone is excluded have to be able to name it. A path on a code line
// still counts, trailing comment or not.
const codeLines = (text) => text.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');

// A filesystem walk rather than `git ls-files`: an untracked new locator is
// exactly what this gate should catch before it is committed, and the gate has
// to run in copies that are not git checkouts (the mutation harness's).
function productionCode() {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['tests', 'fixtures', 'node_modules', '.git'].includes(entry.name)) walk(child);
      } else if (entry.isFile() && CODE.test(entry.name)) {
        out.push(child);
      }
    }
  };
  // The shipped packages. Repository tooling under scripts/ and kit/ is never
  // installed, and the mutation specs spell the clone on purpose.
  for (const top of ['companions', 'plugins']) walk(top);
  return out;
}

describe('ADR-0061 §Decision 3 — the Codex marketplace clone is never a discovery candidate', () => {
  it('the scanned corpus is the production code, not an empty list', () => {
    const files = productionCode();
    // Identity, not a count: the corpus must contain the files this gate is
    // about, including ones S1 moved off the clone.
    for (const path of [
      'companions/discover-peer.mjs',
      'plugins/companions/scripts/discover-peer.mjs',
      'plugins/engineer/scripts/dispatch-peer.mjs',
      'plugins/image/scripts/compose-dispatch.mjs',
      ...PENDING,
      ...OBSERVATION,
    ]) {
      ok(files.includes(path), `${path} is not in the scanned corpus`);
    }
  });

  it('exactly the pending (S2/S3) files and the machine-probe observation reference the clone', () => {
    const referencing = productionCode()
      .filter((path) => CLONE_REFERENCE.test(codeLines(readFileSync(join(REPO_ROOT, path), 'utf8'))))
      .sort();
    deepStrictEqual(referencing, [...PENDING, ...OBSERVATION].sort());
  });
});
