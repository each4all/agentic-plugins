// C142 O-F2 — the listing of every process the peer snapshot suites' runs
// judge, installed under peer-snapshot.mjs's LISTING_HOOK: imported by a suite
// for its own process, and preloaded (`node --import`, through the NODE_OPTIONS
// cleanEnv sets) into every runner, cancel, settle and dispatch it starts.
//
// It is the system's listing narrowed to the processes the system read in the
// temporary directory, where every case makes its trees. On a busy machine
// (another lane's test suite, measured 2026-10-21) the listing leaves
// processes started while it ran unread, and such a process, which descends
// from the test runner and so from an ancestor of the test's supervisor,
// makes every tree `unknown`; a process elsewhere whose name lsof escapes
// makes a tree under a temporary directory with a name it would escape
// `occupied` (refine-verify of 2026-10-22). Either would make a removal the
// case expects hang on what else runs on the machine. A process the case
// starts in a tree is read there, as any process of the user's own that runs
// long enough is. The cases about the listing itself pass their own
// (`listProcesses`).
//
// PEER_SNAPSHOT_TEST_OCCUPANT, when set, names a directory one more process
// is listed in: the case that proves the runner reads this listing, never the
// system's alone.

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

const HOOK = Symbol.for('agentic-plugins.peer-snapshot.list-processes');

// The temporary directory as the case spells it and as the system reports a
// cwd in it (macOS: /var/folders → /private/var/folders), read when a listing
// is taken. Every node process a case starts loads this module, some with a
// TMPDIR that does not exist (or no longer does): that one has only its
// spelling.
function tmpRoots() {
  const roots = [resolve(tmpdir())];
  try {
    roots.push(realpathSync.native(tmpdir()));
  } catch {
    /* not there */
  }
  return roots.map((r) => (r.endsWith(sep) ? r : r + sep));
}

// A listing of every process that proves nothing (null) is taken again, a
// few times: on Linux a process that starts and exits as the last round reads
// /proc leaves the whole listing unproved (C142 R-F2), and on a busy machine
// that hangs on what else runs, as an unread process does (C142 S-F2).
export async function listAgain(list, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    const all = await list();
    if (all !== null || attempt >= attempts) return all;
  }
}

globalThis[HOOK] = async (list) => {
  const all = await listAgain(list);
  if (all === null) return null;
  const roots = tmpRoots();
  const inRoot = (path) => typeof path === 'string' && roots.some((r) => path === r.slice(0, -1) || path.startsWith(r));
  const read = all.filter((m) => m.unreadable !== true && (inRoot(m.cwd) || inRoot(m.raw)));
  const occupant = process.env.PEER_SNAPSHOT_TEST_OCCUPANT;
  return occupant ? [...read, { pid: process.pid, cwd: occupant, raw: occupant }] : read;
};
