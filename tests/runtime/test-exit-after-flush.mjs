// The runtime package's copy of exitAfterFlush (R2), tested by the shared
// suite. The CLIs that end through it have their own regressions:
// test-bootstrap-exit-flush.mjs, test-doctor-exit.mjs and
// test-settings-exit-flush.mjs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineExitAfterFlushSuite } from '../_exit-after-flush-suite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

defineExitAfterFlushSuite({
  label: 'runtime scripts/lib/exit-after-flush.mjs',
  modulePath: path.resolve(HERE, '../../plugins/runtime/scripts/lib/exit-after-flush.mjs'),
});
