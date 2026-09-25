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
// The implementation manifest moved the locators in three steps (S1 companion
// discovery, S2 sibling resolvers, S3 runtime diagnostics and receivers). S3
// was the last, so no production file is waiting to move: the comparison below
// is EXACT, and a new reference anywhere fails, whoever writes it.
// OBSERVATION is the one file ADR-0061 keeps: machine-probe.mjs reports the
// clone's presence as a fact and never resolves code from it (Decision 4:
// "Snapshot presence remains 'not installation evidence'"). doctor.mjs no
// longer reads that observation for its effective hooks (S3): they come from
// the installed package alone, which tests/runtime/test-doctor.mjs pins.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// The home-rendered receivers S3 moved off the clone. They name it only in
// comments; `using` below pins that neither needed the host-tree exemption.
const MOVED_BY_S3 = [
  'plugins/runtime/receivers/agentic-statusline.mjs',
  'plugins/runtime/receivers/codex-notify-shuttle.mjs',
];

// The sibling resolvers S2 moved off the clone. Each still names it in a
// comment, which is why comment-only lines are excluded below.
const MOVED_BY_S2 = [
  'plugins/attention/scripts/discover-runtime.mjs',
  'plugins/designer/scripts/discover-runtime.mjs',
  'plugins/engineer/scripts/discover-runtime.mjs',
  'plugins/engineer/scripts/parent-writeback.mjs',
  'plugins/founder/scripts/discover-runtime.mjs',
  'plugins/orchestrator/scripts/discover-engineer.mjs',
  'plugins/orchestrator/scripts/discover-runtime.mjs',
  'plugins/runtime/scripts/doctor.mjs',
  'plugins/runtime/scripts/lib/peer-execution-context.mjs',
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
//
// One code line is exempt, by its exact text: the sibling resolvers list the
// clone as one of Codex's host trees, to REFUSE it — a caller inside it is
// Codex-hosted and a sibling resolving into it is not a checkout (ADR-0061 S2
// review). That entry is the line below, alone on its line inside a `roots`
// array. Any other spelling (a `base:`, a longer join, a string path) is still
// a reference.
const HOST_TREE_ROOT = "join(codexHome, '.tmp', 'marketplaces'),";
const codeLines = (text) => text.split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
  .filter((line) => line.trim() !== HOST_TREE_ROOT)
  .join('\n');

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
    // about, including the ones S1 and S2 moved off the clone.
    for (const path of [
      'companions/discover-peer.mjs',
      'plugins/companions/scripts/discover-peer.mjs',
      'plugins/engineer/scripts/dispatch-peer.mjs',
      'plugins/image/scripts/compose-dispatch.mjs',
      ...MOVED_BY_S2,
      ...MOVED_BY_S3,
      ...OBSERVATION,
    ]) {
      ok(files.includes(path), `${path} is not in the scanned corpus`);
    }
  });

  it('the host-tree exemption is used where it is meant to be, and nowhere else', () => {
    const using = productionCode()
      .filter((path) => readFileSync(join(REPO_ROOT, path), 'utf8').split('\n').some((line) => line.trim() === HOST_TREE_ROOT))
      .sort();
    // Every S2 sibling resolver refuses the clone through that entry; nothing
    // else carries it.
    deepStrictEqual(using, MOVED_BY_S2.filter((path) => !path.endsWith('peer-execution-context.mjs')).sort());
  });

  it('only the machine-probe observation references the clone', () => {
    const referencing = productionCode()
      .filter((path) => CLONE_REFERENCE.test(codeLines(readFileSync(join(REPO_ROOT, path), 'utf8'))))
      .sort();
    deepStrictEqual(referencing, [...OBSERVATION].sort());
  });
});
