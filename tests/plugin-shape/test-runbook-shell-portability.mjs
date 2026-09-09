// Runbook shell portability — the globbing guard must be honored by the
// operator's actual shell, not only by bash.
//
// WHY THIS EXISTS. Four command runbooks guarded their unquoted argument
// expansion with `set -f`. Measured 2026-09-09: that form does not set
// `noglob` under zsh —
//
//   zsh  -c 'set -f; setopt | grep -c noglob'   → 0
//   zsh  -c 'set -f;    node … A냐 B냐?'         → zsh: no matches found: B냐?
//   bash -c 'set -f;    node … A냐 B냐?'         → ["A냐","B냐?"]
//   zsh  -c 'set -o noglob; node … A냐 B냐?'     → ["A냐","B냐?"]
//
// so the guard was inert on a zsh default shell while passing every review
// in bash. A decision topic carrying `(`, `?` or `[...]` — ordinary in
// prose, and common in Korean topics — aborted the whole block.
//
// The assertions below are on the SPELLING, which is decidable on any
// runner. The behavioural half was measured at authoring time and is
// deliberately not repeated here: zsh is not guaranteed on the CI image,
// and a behavioural test that silently skips where the defect lives would
// report coverage it does not have.

import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

/** Every markdown file shipped by any plugin. */
function runbooks(dir = PLUGINS_DIR, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) runbooks(p, acc);
    else if (entry.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// An executable line, not prose: the guard as the shell would see it.
// Anchored at line start (allowing indentation) and nothing after it, so
// a comment *mentioning* `set -f` — which the fixed runbooks now carry as
// the rationale — is correctly not a hit.
const EXECUTABLE_SET_F = /^[ \t]*set [-+]f[ \t]*$/;
const NOGLOB_ON = /^[ \t]*set -o noglob[ \t]*$/;
const NOGLOB_OFF = /^[ \t]*set \+o noglob[ \t]*$/;

const FILES = runbooks();

test('runbook shell portability', async (t) => {
  await t.test('the corpus is not empty (guards a vacuous pass)', () => {
    ok(FILES.length > 0, 'no plugin markdown was discovered at all');
  });

  await t.test('at least one runbook still carries a globbing guard', () => {
    // Without this, deleting every guard would make the suite green while
    // removing the protection it exists to hold in place.
    const guarded = FILES.filter((f) =>
      readFileSync(f, 'utf8').split('\n').some((l) => NOGLOB_ON.test(l)));
    ok(guarded.length > 0,
      'no `set -o noglob` guard found in any runbook — either the guards were removed, or this test is matching the wrong shape');
  });

  await t.test('no runbook uses the bash-only `set -f` / `set +f` form', () => {
    const offenders = [];
    for (const f of FILES) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (EXECUTABLE_SET_F.test(line)) offenders.push(`${relative(REPO_ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    strictEqual(offenders.length, 0,
      `\`set -f\`/\`set +f\` does not set noglob under zsh; use \`set -o noglob\`/\`set +o noglob\`:\n  ${offenders.join('\n  ')}`);
  });

  await t.test('every globbing guard is restored in the same file', () => {
    const unbalanced = [];
    for (const f of FILES) {
      const lines = readFileSync(f, 'utf8').split('\n');
      const on = lines.filter((l) => NOGLOB_ON.test(l)).length;
      const off = lines.filter((l) => NOGLOB_OFF.test(l)).length;
      if (on !== off) unbalanced.push(`${relative(REPO_ROOT, f)}: ${on} × 'set -o noglob' vs ${off} × 'set +o noglob'`);
    }
    strictEqual(unbalanced.length, 0,
      `a runbook disables globbing without restoring it:\n  ${unbalanced.join('\n  ')}`);
  });
});
