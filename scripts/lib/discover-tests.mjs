// The test files `npm test` runs: Node 24's own no-argument discovery
// (ADR-0033 Decision 1), computed the way Node computes it.
//
// `node --test` with no file argument globs its default pattern from the
// working directory and leaves out every `node_modules` directory. This module
// runs the same pattern through the same glob (`fs.globSync`, which Node's test
// runner uses internally), with the same exclusion, so it inherits Node's
// rules for hidden directories, symbolic links and file extensions instead of
// restating them. tests/scripts/test-discover-tests.mjs runs a real
// `node --test` over a fixture tree and checks that the files it executes are
// exactly the ones listed here; a Node upgrade that changes the pattern fails
// there.
//
// The pattern is Node 24's `kDefaultPattern` (lib/internal/test_runner/utils.js)
// with type stripping on, its default since Node 23.6.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TEST_PATTERN = '**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}';

/**
 * Every file `node --test` discovers under `repoRoot`, as sorted repository-
 * relative POSIX paths. Only the platform's own separator becomes `/`: on
 * Linux and macOS a backslash is part of a file name, and turning it into `/`
 * would name a different file.
 */
export function listTestFiles(repoRoot) {
  return fs.globSync(DEFAULT_TEST_PATTERN, {
    cwd: repoRoot,
    exclude: (name) => name === 'node_modules',
  })
    .map((rel) => rel.split(path.sep).join('/'))
    .sort();
}
