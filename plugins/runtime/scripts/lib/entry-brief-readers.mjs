// ADR-0045 §2.1/§3 — the entry arbiter's bounded read layer (macro S7a).
//
// R0: reads only, consumes nothing — never touches projection lifecycles,
// markers, or any write path. A versioned, tolerant parser layer over the
// persona/orchestrator state homes plus the generic runtime sources. The
// workflow homes are read across the ADR-0067 read set (lib/state-root.mjs):
// the default state root, then the checkout when it differs. On any
// schema drift, parse failure, ambiguity (same-home duplicates, dual-home
// conflicts, the two state roots, one workflow id in two files, ambiguous
// macro bridge), overflow, or unreadable directory it
// degrades to `indeterminate` instead of interpreting — mirroring the owners'
// fail-closed throws (engineer/orchestrator per-branch lookups) without
// throwing. ENOENT alone is the fail-open "no state" case; ENOTDIR (an
// ancestor that is a regular file) is corruption, not absence.
//
// Command-synthesis isolation starts HERE, not at the brief: no stored free
// text (original_request, next_action, current_phase, routing, checkpoint,
// topic, label, summary_line, branch strings from generic artifacts, raw
// status strings, …) ever crosses this reader's return values, and `reason`
// strings are fixed codes that never quote file content or file names. Only
// closed enums, pattern-validated identifiers, collision-resistant linkage
// tokens, booleans, timestamps, counts, and derived repo-relative pointers
// leave this module.
//
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.
// This module must never import a `scripts/*.mjs` sibling (context.mjs will
// import it for the S7b arbiter — a reverse import is a cycle) and is
// spawn-free (the ADR-0035 executor guard's import-gate enforces it); lib→lib
// imports only.

import { createHash } from 'node:crypto';
import { constants as fsConstants, realpath as realpathCallback } from 'node:fs';
import { lstat, open, opendir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  inspectSessionCaptureFileCore,
  sessionCaptureDir,
} from './session-capture-inspect.mjs';
import { checkoutOnlyReadSet, stateReadSet } from './state-root.mjs';

export const ENTRY_READER_CAPS = Object.freeze({
  MAX_DIR_ENTRIES: 128,
  // A JSON source (handoff slot, marker, run ledger) is read whole, up to this.
  MAX_FILE_BYTES: 256 * 1024,
  // A workflow `.md` is read only as far as its frontmatter closes, and the
  // close must end within this many bytes; the body is never read, whatever
  // its size (C124).
  MAX_FRONTMATTER_BYTES: 256 * 1024,
  FRONTMATTER_CHUNK_BYTES: 8 * 1024,
  // Bytes read from one `workflows/` directory, across its listings.
  MAX_HOME_TOTAL_BYTES: 2 * 1024 * 1024,
  // Listings of one `workflows/` directory before a file that keeps vanishing
  // between the listing and its read degrades the source (ADR-0067 Decision 4,
  // item 1: another lane's archive moving a file out is routine once state is
  // shared).
  MAX_SCAN_ATTEMPTS: 3,
  HANDOFF_FRESHNESS_MS: 10 * 60 * 1000,
  FUTURE_SKEW_MS: 60 * 1000,
});

// Identifier families (ADR-0045 §4): one validator cannot cover both — the
// persona family is `<verb>-<timestamp>-<hex>`, macros are `macro-<verb>-…`.
export const PERSONA_WORKFLOW_ID_RE = /^(?!macro-)[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const MACRO_WORKFLOW_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// Schema tolerance mirrors the owners' own gates: persona state accepts the
// legacy UNQUOTED numeric 1 plus any "1.x" string (engineer state.mjs
// isSupportedSchema distinguishes the YAML number from the string '1', which
// it rejects); orchestrator accepts "1.x" strings only. Macro schema "1.0"
// parses but is NOT dispatch-actionable (the owner's next-ready refuses it) —
// the bridge carries that as a closed boolean.
const PERSONA_SCHEMA_STRING_RE = /^1\.(0|[1-9]\d*)$/;
const MACRO_SCHEMA_RE = /^1\.(0|[1-9]\d*)$/;
const SUBTASK_STATUSES = new Set(['pending', 'blocked', 'in_progress', 'completed', 'deferred', 'abandoned']);
const SUBTASK_TERMINAL_STATUSES = new Set(['completed', 'deferred', 'abandoned']);
const CONTEXT_RUN_ID_RE = /^context-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONSENSUS_RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONSENSUS_TERMINAL_STATUSES = new Set(['cancelled', 'converged', 'owner-decided']);
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,128}$/;

// Storage homes (state-schema facts): engineer/orchestrator have a pre-ADR-0025
// legacy home under .claude/; founder (ADR-0036 SD5) and designer (ADR-0042
// SD7) are canonical-only — probing a legacy path their writers can never
// produce would invent a source that cannot exist.
const LEGACY_HOME_PERSONAS = new Set(['engineer', 'orchestrator']);

// Every home of `persona` under each state root of the read set, in read-set
// order (ADR-0067 Decision 1(a): the default state root first, then the
// checkout when it differs).
function personaHomes(stateRoots, persona) {
  const homes = [];
  for (const { location, root: stateRoot } of stateRoots) {
    homes.push({ location, stateRoot, home: 'canonical', root: join(stateRoot, '.agentic-plugins', 'state', persona) });
    if (LEGACY_HOME_PERSONAS.has(persona)) {
      homes.push({ location, stateRoot, home: 'legacy', root: join(stateRoot, '.claude', `agentic-${persona}`) });
    }
  }
  return homes;
}

// A pointer is relative to the state root its file was found under
// (ADR-0067 Decision 1(c)), so a record under the main worktree is spelled
// `.agentic-plugins/state/…` as a local one is: never absolute, never `..`,
// and the arbiter's pointer hardening applies unchanged. A consumer resolves
// it in its own read set, the default state root first.
function toPointer(stateRoot, path) {
  return relative(stateRoot, path).split(sep).join('/');
}

// Linkage token for free-string identifiers (macro subtask ids, originating
// subtask): equality-preserving and collision-resistant. A value already in
// the safe-identifier alphabet passes through verbatim; anything else becomes
// a sha256-derived token. Distinct owner-valid ids can NEVER collide (a lossy
// character-replacement sanitizer could — codex review MAJOR), and hostile
// free text can never ride through as prose. Matching consumers apply the
// same function to both sides.
export function linkageToken(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (SAFE_IDENTIFIER_RE.test(value)) return value;
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function parseIsoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Fixed-code reasons only: a reason never quotes file content, scalar values,
// or file names — the reader's isolation boundary covers its own diagnostics
// (codex review MAJOR: schema text was previously copied into reasons).
function indeterminate(extra, reason) {
  return { ...extra, status: 'indeterminate', reason };
}

// Every reason a source of this module can degrade with: the brief names a
// skipped source's reason only from this set (`skippedSourcesOf`), and the
// packaged brief schema lists the same codes. A test extracts each code the
// source passes to `indeterminate(…)` or writes as a `reason:` and holds both
// lists to this one.
export const ENTRY_READER_REASON_CODES = Object.freeze(new Set([
  // directory listings
  'not-a-directory', 'unreadable-directory', 'scan-overflow', 'directory-iteration-failed',
  // bounded reads
  'symlink-refused', 'ancestor-not-a-directory', 'open-failed', 'not-a-regular-file',
  'over-read-bound', 'grew-past-read-bound', 'read-failed',
  // workflow homes and entries
  'home-unresolvable', 'home-aliases-other-persona', 'home-encloses-state', 'stat-failed', 'realpath-failed',
  'symlink-outside-state', 'workflow-identity-changed', 'frontmatter-over-read-bound',
  'read-budget-exceeded', 'workflow-file-vanished',
  // workflow records
  'unparseable-workflow-frontmatter', 'missing-workflow-branch', 'unsupported-workflow-schema',
  'invalid-terminal-marker', 'invalid-parent-detached', 'duplicate-active-workflows',
  'dual-home-ambiguity', 'cross-root-ambiguity', 'duplicate-workflow-id', 'duplicate-pointer',
  'invalid-workflow-type', 'unsupported-macro-schema', 'malformed-macro-subtasks',
  'duplicate-active-macros', 'ambiguous-macro-bridge',
  // handoff slots
  'slot-not-json', 'slot-not-an-object', 'slot-kind-mismatch', 'marker-unreadable', 'marker-malformed',
  // entry capture
  'entry-validation-failed',
]));

// --- bounded low-level reads -----------------------------------------------

// The one open in this module: read-only, never through a symlinked final
// component, never waiting on a FIFO. The io seam hands readers this
// function, never `open` itself, so no caller can pass other flags.
function openReadOnly(filePath) {
  return open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
}

// Handle-based atomic read (codex review MAJOR — the previous lstat→readFile
// pair was TOCTOU-prone): O_NOFOLLOW refuses a symlinked FINAL component at
// open time, O_NONBLOCK keeps a repo-controlled FIFO from blocking the open,
// fstat on the handle re-checks type/size on the same inode, and the read is
// capped through the same handle. Ancestor symlinks remain accepted, matching
// the session-capture read-path contract (only its WRITE path walks the
// ancestor chain). The JSON sources read this way; a workflow `.md` is read
// by `readWorkflowEntry` below.
async function readBoundedFile(filePath, maxBytes) {
  let handle;
  try {
    handle = await openReadOnly(filePath);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    if (code === 'ENOENT') return { state: 'absent' };
    if (code === 'ELOOP' || code === 'EMLINK') return { state: 'refused', reason: 'symlink-refused' };
    if (code === 'ENOTDIR') return { state: 'refused', reason: 'ancestor-not-a-directory' };
    return { state: 'refused', reason: 'open-failed' };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { state: 'refused', reason: 'not-a-regular-file' };
    if (st.size > maxBytes) return { state: 'refused', reason: 'over-read-bound' };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return { state: 'refused', reason: 'grew-past-read-bound' };
    return { state: 'ok', text: buffer.subarray(0, bytesRead).toString('utf8'), mtimeMs: st.mtimeMs, bytes: bytesRead };
  } catch {
    return { state: 'refused', reason: 'read-failed' };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Early-terminating directory scan (codex review MAJOR — a plain readdir
// materializes the whole listing before the cap can judge it).
async function listBoundedDir(dir, caps) {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    if (code === 'ENOENT') return { state: 'absent', entries: [] };
    if (code === 'ENOTDIR') return { state: 'refused', reason: 'not-a-directory' };
    return { state: 'refused', reason: 'unreadable-directory' };
  }
  const entries = [];
  try {
    for await (const entry of handle) {
      entries.push(entry);
      if (entries.length > caps.MAX_DIR_ENTRIES) return { state: 'overflow', reason: 'scan-overflow' };
    }
  } catch {
    return { state: 'refused', reason: 'directory-iteration-failed' };
  }
  return { state: 'ok', entries };
}

// The owners resolve a workflow file's identity with `realpathSync`, Node's
// JS resolver, which keeps the spelling a link names (state.mjs
// workflowFilesIn). fs/promises' `realpath` is the native resolver, which
// canonicalizes case on a case-insensitive volume, so there `inside.md` and
// `alias.md -> INSIDE.md` would be one file to this reader and two to the
// owners. The callback form is the JS resolver.
const realpath = promisify(realpathCallback);

// The filesystem the workflow readers use (`io`); a test wraps it to make a
// file vanish between the listing and the read, to swap a path between the
// containment check and the open, or to return short reads. Read-only by
// construction: `openReadOnly` fixes its flags.
export const ENTRY_READER_IO = Object.freeze({ listDir: listBoundedDir, openReadOnly, realpath, stat, lstat });

// --- workflow files: frontmatter-only, contained, identity-checked ----------

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const OPEN_FENCE = Buffer.from('---');
const CLOSE_FENCE = Buffer.from('\n---');

// Reads `handle` from its start through the line that closes its frontmatter,
// the body never (C124: a long body is no reason to refuse a workflow). The
// lines are those `splitFrontmatterLines` reads from the whole file: the first
// line is exactly `---`, and the frontmatter closes at the next line that is
// exactly `---`, ended by LF, CRLF or the end of the file. Returns
// { state: 'ok', text, bytes } with the text through that line's end;
// { state: 'unparseable', bytes } when no frontmatter opens, or the file ends
// before one closes; { state: 'refused', reason: 'frontmatter-over-read-bound',
// bytes } when no close ends within MAX_FRONTMATTER_BYTES. `bytes` is what the
// reads took, charged to the home's budget. A read shorter than asked is not
// the end: only a read of 0 bytes is. The bytes are joined, and decoded once,
// only after the close is found, so a character split across reads stays
// whole. Exported for its unit tests, which drive it with a fake handle.
export async function readFrontmatterHead(handle, caps = ENTRY_READER_CAPS) {
  const max = caps.MAX_FRONTMATTER_BYTES;
  // One byte past the bound tells a close ending at the bound (accepted) from
  // one ending after it, and a file ending at the bound from a longer one.
  const limit = max + 1;
  let buffer = Buffer.alloc(Math.min(caps.FRONTMATTER_CHUNK_BYTES, limit));
  let length = 0;
  let eof = false;
  let bodyStart = null; // the newline that ends the opening `---` line
  let searchFrom = 0;

  // { end } when the close is found, { none: true } when there is none,
  // null when more bytes must be read to tell.
  const judge = () => {
    const bytes = buffer.subarray(0, length);
    if (bodyStart === null) {
      if (length < OPEN_FENCE.length + 1) return eof ? { none: true } : null;
      if (!bytes.subarray(0, OPEN_FENCE.length).equals(OPEN_FENCE)) return { none: true };
      if (bytes[3] === NEWLINE) bodyStart = 3;
      else if (bytes[3] !== CARRIAGE_RETURN) return { none: true };
      else if (length < 5) return eof ? { none: true } : null;
      else if (bytes[4] === NEWLINE) bodyStart = 4;
      else return { none: true };
      searchFrom = bodyStart;
    }
    for (;;) {
      const at = bytes.indexOf(CLOSE_FENCE, searchFrom);
      if (at < 0) {
        // A close could begin in the last bytes already searched.
        searchFrom = Math.max(bodyStart, length - (CLOSE_FENCE.length - 1));
        return eof ? { none: true } : null;
      }
      const fenceEnd = at + CLOSE_FENCE.length;
      if (fenceEnd === length) {
        searchFrom = at;
        return eof ? { end: fenceEnd } : null;
      }
      if (bytes[fenceEnd] === NEWLINE) return { end: fenceEnd + 1 };
      if (bytes[fenceEnd] === CARRIAGE_RETURN) {
        if (fenceEnd + 1 === length) {
          searchFrom = at;
          // `---\r` at the end of the file is not the line `---`.
          if (!eof) return null;
        } else if (bytes[fenceEnd + 1] === NEWLINE) {
          return { end: fenceEnd + 2 };
        }
      }
      searchFrom = at + 1;
    }
  };

  for (;;) {
    const verdict = judge();
    if (verdict?.none) return { state: 'unparseable', bytes: length };
    if (verdict) {
      if (verdict.end > max) return { state: 'refused', reason: 'frontmatter-over-read-bound', bytes: length };
      return { state: 'ok', text: buffer.toString('utf8', 0, verdict.end), bytes: length };
    }
    if (length >= limit) return { state: 'refused', reason: 'frontmatter-over-read-bound', bytes: length };
    if (length === buffer.length) {
      const grown = Buffer.alloc(Math.min(buffer.length * 2, limit));
      buffer.copy(grown, 0, 0, length);
      buffer = grown;
    }
    const want = Math.min(caps.FRONTMATTER_CHUNK_BYTES, buffer.length - length);
    const { bytesRead } = await handle.read(buffer, length, want, length);
    if (bytesRead === 0) eof = true;
    else length += bytesRead;
  }
}

// A filesystem object's identity: its device and inode, read as bigints, so
// two inodes past 2^53 never compare equal by rounding.
function identityOf(st) {
  return `${st.dev}:${st.ino}`;
}

// The directory `path` resolves to: { identity, chain }, its identity and the
// set of its own and every ancestor's identities; { identity: null } when
// nothing is there (ENOENT: no state); { error: true } when it cannot be
// resolved otherwise (EACCES, ELOOP, ENOTDIR).
async function ancestryAt(path, io) {
  let dir;
  try {
    dir = await io.realpath(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? { identity: null } : { error: true };
  }
  let identity = null;
  const chain = new Set();
  for (;;) {
    try {
      const id = identityOf(await io.lstat(dir, { bigint: true }));
      identity ??= id;
      chain.add(id);
    } catch {
      return { error: true };
    }
    const parent = dirname(dir);
    if (parent === dir) return { identity, chain };
    dir = parent;
  }
}

// Every persona with workflow homes, for the alias check below.
const WORKFLOW_PERSONAS = Object.freeze(['engineer', 'founder', 'designer', 'orchestrator']);

// The homes of `persona` in the read set, each with its identity, and the set
// of those identities: the containment roots of its workflow files. A home
// reached through a symlink (a lane's home linked into the main worktree's,
// the precedent's layout) counts as the directory it names. A home is refused
// when it would make files that are not this persona's its own:
// `home-aliases-other-persona` when it is another persona's home, lies inside
// one or holds one; `home-encloses-state` when it holds a state root, the
// `.agentic-plugins/state` or `.claude` directory of one (a home linked to
// the state directory, or to `/`, would hold every home, and everything else
// on disk). A home that exists and cannot be resolved degrades the source;
// only absence is no state.
async function resolveHomes(stateRoots, persona, io) {
  const homes = [];
  for (const home of personaHomes(stateRoots, persona)) {
    const found = await ancestryAt(home.root, io);
    if (found.error) return { state: 'refused', reason: 'home-unresolvable' };
    homes.push({ ...home, identity: found.identity, chain: found.chain ?? new Set() });
  }
  const present = homes.filter(({ identity }) => identity !== null);
  for (const other of WORKFLOW_PERSONAS) {
    if (other === persona) continue;
    for (const home of personaHomes(stateRoots, other)) {
      // Another persona's unresolvable home is that persona's source to report.
      const found = await ancestryAt(home.root, io);
      if (!found.identity) continue;
      if (present.some(({ identity, chain }) => found.chain.has(identity) || chain.has(found.identity))) {
        return { state: 'refused', reason: 'home-aliases-other-persona' };
      }
    }
  }
  for (const { root: stateRoot } of stateRoots) {
    for (const holder of [stateRoot, join(stateRoot, '.agentic-plugins', 'state'), join(stateRoot, '.claude')]) {
      // A holder that cannot be resolved holds no home this persona resolved
      // (each of those lies under its state root, resolved here too): a
      // broken `.claude` is the legacy homes' source to report, not founder's.
      const found = await ancestryAt(holder, io);
      if (found.identity && present.some(({ identity }) => found.chain.has(identity))) {
        return { state: 'refused', reason: 'home-encloses-state' };
      }
    }
  }
  return { state: 'ok', homes, roots: new Set(present.map(({ identity }) => identity)) };
}

// Whether the real path `real` lies inside one of the homes `roots`: its
// ancestors are examined upward, each with lstat, and compared by identity,
// so a home reached through a firmlink, a case variant of its spelling or a
// bind mount still holds it, where a string prefix would not
// (path-containment.mjs found the same on Darwin). A real path has no
// symlinked component, so an ancestor that is a symlink now was swapped in
// after the realpath: it leaves the file outside, as does an ancestor the
// filesystem will not describe. Runs after the file's own stat, so a swap
// that stat followed is still in place for this walk to see.
async function insideHomes(real, roots, io) {
  let dir = dirname(real);
  for (;;) {
    let st;
    try {
      st = await io.lstat(dir, { bigint: true });
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    if (roots.has(identityOf(st))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// One `.md` entry of a `workflows/` directory, read as far as its frontmatter
// closes. Its identity is its real path, as the owners' lookups count files
// (two hard-linked names are two files to them, and so here); its lines are
// cached under the real path and the file's device, inode, size and mtime, so
// a name reaching a file already read reads nothing, and a file rewritten in
// place between two listings is read again.
//
// A symlinked entry is followed only when its real path lies inside a home of
// this persona in the read set: the state directories, not the checkout (C122;
// the owners' workflowFilesIn, ADR-0067 Decision 4 item 1, takes a link to a
// workflow file as that file, and this reader takes it only there). So is
// every entry, a plain one under a `workflows/` linked out of its home
// included. A link to nothing is skipped as gone, as the owners skip it.
//
// The file opened is the checked real path, with O_NOFOLLOW, and the handle's
// identity must be the one checked: a final component swapped for a link is
// refused at the open, and a different file at the path by identity. Then the
// path is judged again, after the open: the walk must still find no link and
// a home above it, and the path must still name the handle's file. So one
// rename, at any point, never yields a file other than the one checked inside
// a home: before the open it is refused, the checked file moved out with its
// directory and reached through a link included (critique MAJOR); after the
// open the handle already holds the checked file, which a rename can only
// move (renamed during the second walk, it is read where it now lies; a
// different file put in its place fails the final identity check). LIMIT: the
// walk and the lookups are separate path lookups (Node has no openat), so
// renames alternating out and back, each timed to a lookup, can reach another
// file, as path-containment.mjs states for the same reason. A file
// hard-linked into a home is in it: a hard link has no target to contain.
// Whoever can rename the directories of a state home already controls the
// state.
async function readWorkflowEntry(path, ctx) {
  const { caps, io, roots, cache } = ctx;
  let entry;
  try {
    entry = await io.lstat(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'vanished' } : { state: 'refused', reason: 'stat-failed' };
  }
  const link = entry.isSymbolicLink();
  let real;
  try {
    real = await io.realpath(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { state: 'refused', reason: 'realpath-failed' };
    return link ? { state: 'gone' } : { state: 'vanished' };
  }
  let checked;
  try {
    checked = await io.stat(real, { bigint: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'vanished' } : { state: 'refused', reason: 'stat-failed' };
  }
  if (!(await insideHomes(real, roots, io))) return { state: 'refused', reason: 'symlink-outside-state' };
  const identity = real;
  const version = `${identity}\0${identityOf(checked)}:${checked.size}:${checked.mtimeNs}`;
  if (cache.has(version)) return { state: 'ok', identity, link, lines: cache.get(version), bytes: 0 };
  let handle;
  try {
    handle = await io.openReadOnly(real);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    if (code === 'ENOENT') return { state: 'vanished' };
    if (code === 'ELOOP' || code === 'EMLINK') return { state: 'refused', reason: 'symlink-refused' };
    if (code === 'ENOTDIR') return { state: 'refused', reason: 'ancestor-not-a-directory' };
    return { state: 'refused', reason: 'open-failed' };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return { state: 'refused', reason: 'not-a-regular-file' };
    if (identityOf(opened) !== identityOf(checked)) return { state: 'refused', reason: 'workflow-identity-changed' };
    if (!(await insideHomes(real, roots, io))) return { state: 'refused', reason: 'symlink-outside-state' };
    let after;
    try {
      after = await io.lstat(real, { bigint: true });
    } catch (error) {
      return error?.code === 'ENOENT' ? { state: 'vanished' } : { state: 'refused', reason: 'stat-failed' };
    }
    if (after.isSymbolicLink() || identityOf(after) !== identityOf(opened)) {
      return { state: 'refused', reason: 'workflow-identity-changed' };
    }
    const head = await readFrontmatterHead(handle, caps);
    if (head.state === 'refused') return { state: 'refused', reason: head.reason };
    const lines = head.state === 'ok' ? splitFrontmatterLines(head.text) : null;
    cache.set(version, lines);
    return { state: 'ok', identity, link, lines, bytes: head.bytes };
  } catch {
    return { state: 'refused', reason: 'read-failed' };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Lists one `workflows/` directory and reads each `.md` entry in it. A file
// that disappears between the listing and its read is listed again, up to
// MAX_SCAN_ATTEMPTS listings; every other failure degrades at once (a
// workflow file we cannot read might be the active one on this branch — the
// owners throw here; we degrade, the fail-closed mirror). The byte budget
// covers every listing of the directory, charged with the bytes each read
// took: a relist reads only what it has not read, and what it reads still
// counts.
async function readWorkflowDir(dir, ctx) {
  const { caps, io } = ctx;
  let dirBytes = 0;
  for (let attempt = 0; attempt < caps.MAX_SCAN_ATTEMPTS; attempt++) {
    const listing = await io.listDir(dir, caps);
    if (listing.state === 'absent') return { state: 'ok', entries: [] };
    if (listing.state !== 'ok') return { state: 'refused', reason: listing.reason };
    const entries = [];
    let vanished = false;
    for (const listed of listing.entries) {
      if (!listed.name.endsWith('.md')) continue;
      const path = join(dir, listed.name);
      const read = await readWorkflowEntry(path, ctx);
      if (read.state === 'gone') continue;
      if (read.state === 'vanished') {
        vanished = true;
        break;
      }
      if (read.state !== 'ok') return { state: 'refused', reason: read.reason };
      dirBytes += read.bytes;
      if (dirBytes > caps.MAX_HOME_TOTAL_BYTES) return { state: 'refused', reason: 'read-budget-exceeded' };
      entries.push({ path, identity: read.identity, link: read.link, lines: read.lines });
    }
    if (!vanished) return { state: 'ok', entries };
  }
  return { state: 'refused', reason: 'workflow-file-vanished' };
}

// Every home of `persona` in the read set, scanned: each name listed in a
// `workflows/` directory as an occurrence (home, identity, link, pointer), and
// each file's frontmatter lines (`records`, null when it has no frontmatter).
// A pointer is spelled against the state root its name was listed under
// (Decision 1(c)).
async function scanWorkflowHomes({ repoRoot, persona, caps, stateRoots, io }) {
  const resolved = await resolveHomes(stateRoots ?? await stateReadSet(repoRoot), persona, io);
  if (resolved.state !== 'ok') return resolved;
  const ctx = { caps, io, roots: resolved.roots, cache: new Map() };
  const occurrences = [];
  const records = new Map();
  for (const home of resolved.homes) {
    const read = await readWorkflowDir(join(home.root, 'workflows'), ctx);
    if (read.state !== 'ok') return read;
    for (const { path, identity, link, lines } of read.entries) {
      occurrences.push({ home, identity, link, pointer: toPointer(home.stateRoot, path) });
      records.set(identity, lines);
    }
  }
  return { state: 'ok', occurrences, records };
}

// The physical files of `occurrences`, each once, in the order first listed.
function physicalFiles(occurrences) {
  return [...new Set(occurrences.map(({ identity }) => identity))];
}

// The pointer of a physical file: under the name that is not a link, else the
// first listed (the default state root comes first), as the owners'
// workflowFilesIn keeps it.
function pointerOf(occurrences, identity) {
  const names = occurrences.filter((occurrence) => occurrence.identity === identity);
  return (names.find(({ link }) => !link) ?? names[0]).pointer;
}

// How the files `identities` sit in the homes, judged per state root before a
// file reached through both roots counts once: 'pair-in-home' when one home
// lists two of them; 'two-homes' when two homes of one state root list them,
// two files or one file listed by both (a legacy home aliasing the canonical
// one, directly or through the main worktree's home: the owners refuse that
// layout); null otherwise.
function homeAmbiguity(occurrences, identities) {
  const filesByHome = new Map();
  const homesByLocation = new Map();
  for (const { home, identity } of occurrences) {
    if (!identities.has(identity)) continue;
    addTo(filesByHome, home, identity);
    addTo(homesByLocation, home.location, home.home);
  }
  if ([...filesByHome.values()].some((files) => files.size > 1)) return 'pair-in-home';
  if ([...homesByLocation.values()].some((homes) => homes.size > 1)) return 'two-homes';
  return null;
}

function addTo(index, key, value) {
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(value);
}

// --- tolerant frontmatter parsing ------------------------------------------

// CRLF-tolerant by construction (state files may be Windows-edited): split on
// \r?\n and scan lines. Returns null when no frontmatter block terminates.
// Exported for the differential test of `readFrontmatterHead`.
export function splitFrontmatterLines(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return lines.slice(1, end);
}

// Scalar token: { value, quoted } — or null when the raw text cannot be
// decoded. Owner writers serialize strings via JSON.stringify, so a
// double-quoted scalar is JSON-decoded (escaped quotes round-trip — codex
// review MAJOR: naive quote-stripping missed `feat/"q"` branches). Quoting is
// preserved so type-sensitive fields (legacy numeric schema 1, boolean
// terminal_marker) can tell the YAML string "true" from the YAML boolean.
function decodeScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const value = JSON.parse(trimmed);
      return typeof value === 'string' ? { value, quoted: true } : null;
    } catch {
      return null;
    }
  }
  const single = /^'(.*)'$/.exec(trimmed);
  if (single) return { value: single[1].replace(/''/g, "'"), quoted: true };
  return { value: trimmed, quoted: false };
}

// null = key absent; { invalid: true } = present but undecodable.
function topLevelScalar(lines, key) {
  for (const line of lines) {
    if (!line.startsWith(`${key}:`)) continue;
    const token = decodeScalar(line.slice(key.length + 1));
    return token ?? { invalid: true };
  }
  return null;
}

function gitBaselineBranch(lines) {
  const start = lines.findIndex((line) => /^git_baseline:\s*$/.test(line));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s{2}/.test(line)) break;
    const m = /^\s{2}branch:\s*(.*)$/.exec(line);
    if (m) {
      const token = decodeScalar(m[1]);
      return token ?? { invalid: true };
    }
  }
  return null;
}

// Tri-state boolean scalar: true/false only when UNQUOTED (the owners emit
// YAML booleans and throw on non-boolean values); absent → null; anything
// else (quoted "true", junk) → { invalid: true } so callers degrade.
function booleanScalar(lines, key) {
  const token = topLevelScalar(lines, key);
  if (token === null) return { value: null };
  if (token.invalid || token.quoted) return { invalid: true };
  if (token.value === 'true') return { value: true };
  if (token.value === 'false') return { value: false };
  return { invalid: true };
}

function personaSchemaSupported(token) {
  if (!token || token.invalid) return false;
  if (!token.quoted && token.value === '1') return true; // legacy YAML number
  return PERSONA_SCHEMA_STRING_RE.test(token.value);
}

// Line-oriented macro subtask scanner (dashboard parseMacroSubtasks shape,
// extended): extracts only linkage/ordering facts — id, branch, status,
// blocked_by, engineer_workflow_id — and fails closed ({ ok: false }) on any
// malformed field instead of defaulting it (codex review MAJOR: a malformed
// blocked_by previously became [] and could misreport readiness=ready).
// Free-text fields (label, topic, …) are deliberately never read.
function parseMacroSubtasks(lines) {
  const planStart = lines.findIndex((line) => /^plan:\s*$/.test(line));
  if (planStart < 0) return { ok: true, subtasks: [] };
  const subtasks = [];
  let inSubtasks = false;
  let current = null;
  for (let i = planStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key ends the plan block
    if (/^\s{2}subtasks:\s*$/.test(line)) {
      inSubtasks = true;
      continue;
    }
    if (!inSubtasks) continue;
    const idM = /^\s{4}-\s+id:\s*(.*)$/.exec(line);
    if (idM) {
      const token = decodeScalar(idM[1]);
      if (!token || token.value.length === 0) return { ok: false };
      current = { id: token.value, branch: null, status: null, blocked_by: null, engineer_workflow_id: null };
      subtasks.push(current);
      continue;
    }
    if (!current) continue;
    const fieldM = /^\s{6}([a-z_]+):\s*(.*)$/.exec(line);
    if (!fieldM) continue;
    const [, key, rawValue] = fieldM;
    if (key === 'branch' || key === 'status' || key === 'engineer_workflow_id') {
      const token = decodeScalar(rawValue);
      if (!token) return { ok: false };
      current[key] = token.value;
    } else if (key === 'blocked_by') {
      const listM = /^\[(.*)\]$/.exec(rawValue.trim());
      if (!listM) return { ok: false };
      const deps = [];
      const inner = listM[1].trim();
      if (inner.length > 0) {
        for (const part of inner.split(',')) {
          const token = decodeScalar(part);
          if (!token || token.value.length === 0) return { ok: false };
          deps.push(token.value);
        }
      }
      current.blocked_by = deps;
    }
  }
  for (const st of subtasks) {
    if (st.status === null || !SUBTASK_STATUSES.has(st.status)) return { ok: false };
    if (st.blocked_by === null) return { ok: false };
    if (st.branch === null) return { ok: false };
  }
  return { ok: true, subtasks };
}

// --- persona workflow source (engineer / founder / designer) ---------------

// Reads every home of the read set (ADR-0067 Decision 4, item 1): a workflow
// stored under the main worktree is found from a linked worktree, and one in
// the linked worktree's own home still is. The same physical file reached
// through both state roots, or under a link inside the homes, counts once;
// listed by two homes of one state root it is dual-home ambiguity. Two files
// on this branch, this branch's workflow id in a second file, or its pointer
// spelling naming a second file (Decision 1(c) resolves a pointer
// default-root-first, so it would reach the other one) are ambiguity, never a
// choice.
export async function readPersonaWorkflowSource({
  repoRoot,
  persona,
  branch,
  caps = ENTRY_READER_CAPS,
  stateRoots = null,
  io = ENTRY_READER_IO,
}) {
  const base = { source: 'persona-workflow', persona };
  const scan = await scanWorkflowHomes({ repoRoot, persona, caps, stateRoots, io });
  if (scan.state !== 'ok') return indeterminate(base, scan.reason);
  const matches = new Map();
  const filesById = new Map();
  const filesByPointer = new Map();
  // Every spelling is indexed, an alias of a file already read included:
  // resolved default-root-first, the alias's spelling reaches that file, so a
  // second file under the same spelling is a pair (Decision 1(c)).
  for (const { pointer, identity } of scan.occurrences) addTo(filesByPointer, pointer, identity);
  for (const identity of physicalFiles(scan.occurrences)) {
    const lines = scan.records.get(identity);
    if (!lines) return indeterminate(base, 'unparseable-workflow-frontmatter');
    // Branch classification FIRST (owner parity — codex review MINOR): a
    // cross-branch file with schema drift must not poison this branch's
    // source; only a file whose branch cannot be established degrades.
    const branchToken = gitBaselineBranch(lines);
    if (branchToken === null || branchToken.invalid) return indeterminate(base, 'missing-workflow-branch');
    const idToken = topLevelScalar(lines, 'workflow_id');
    const idValue = idToken && !idToken.invalid ? idToken.value : null;
    if (idValue !== null) addTo(filesById, idValue, identity);
    if (branchToken.value !== branch) continue;
    const schemaToken = topLevelScalar(lines, 'schema');
    if (!personaSchemaSupported(schemaToken)) return indeterminate(base, 'unsupported-workflow-schema');
    const terminal = booleanScalar(lines, 'terminal_marker');
    if (terminal.invalid) return indeterminate(base, 'invalid-terminal-marker');
    const detached = booleanScalar(lines, 'parent_detached');
    if (detached.invalid) return indeterminate(base, 'invalid-parent-detached');
    const idValid = idValue !== null && PERSONA_WORKFLOW_ID_RE.test(idValue);
    const parentToken = topLevelScalar(lines, 'parent_workflow');
    const parentValue = parentToken && !parentToken.invalid ? parentToken.value : null;
    const subToken = topLevelScalar(lines, 'originating_subtask');
    const updatedToken = topLevelScalar(lines, 'updated_at');
    matches.set(identity, {
      rawId: idValue,
      summary: {
        workflow_id: idValid ? idValue : null,
        workflow_id_valid: idValid,
        branch: branchToken.value,
        terminal_marker: terminal.value,
        parent_workflow: parentValue !== null && MACRO_WORKFLOW_ID_RE.test(parentValue) ? parentValue : null,
        // Closed boolean the §5.1 linked-child validation needs (codex review
        // MAJOR): a detached child must be distinguishable from a linked one.
        parent_detached: detached.value,
        originating_subtask: subToken && !subToken.invalid ? linkageToken(subToken.value) : null,
        updated_at_ms: updatedToken && !updatedToken.invalid ? parseIsoMs(updatedToken.value) : null,
        pointer: pointerOf(scan.occurrences, identity),
      },
    });
  }
  // Most specific first: two in one home, then two homes of one state root,
  // then the two state roots.
  const homes = homeAmbiguity(scan.occurrences, new Set(matches.keys()));
  if (homes === 'pair-in-home') return indeterminate(base, 'duplicate-active-workflows');
  if (homes === 'two-homes') return indeterminate(base, 'dual-home-ambiguity');
  if (matches.size > 1) return indeterminate(base, 'cross-root-ambiguity');
  const [match = null] = matches.values();
  if (match !== null && match.rawId !== null && filesById.get(match.rawId).size > 1) {
    return indeterminate(base, 'duplicate-workflow-id');
  }
  if (match !== null && filesByPointer.get(match.summary.pointer).size > 1) {
    return indeterminate(base, 'duplicate-pointer');
  }
  return { ...base, status: 'ok', reason: null, active: match === null ? null : match.summary };
}

// --- orchestrator macro sources (own-branch active + subtask-branch bridge) --

export function deriveMacroReadiness(subtasks) {
  if (!Array.isArray(subtasks) || subtasks.length === 0) return 'empty_plan';
  const completed = new Set(subtasks.filter((st) => st.status === 'completed').map((st) => st.id));
  if (subtasks.every((st) => SUBTASK_TERMINAL_STATUSES.has(st.status))) return 'all_terminal';
  const anyReady = subtasks.some(
    (st) => st.status === 'pending' && st.blocked_by.every((dep) => completed.has(dep)),
  );
  return anyReady ? 'ready' : 'in_progress_or_blocked';
}

// Reads the orchestrator homes of the read set, as the persona reader does:
// a macro under the main worktree is found from a linked worktree, the same
// physical file reached through both state roots counts once, one listed by
// two homes of one state root is dual-home ambiguity, and a second file
// holding a matched macro's id or its pointer spelling is ambiguity. So is a
// second macro on the bridged macro's integration branch: one active macro per
// integration branch per repository (ADR-0067 Decision 1(a)), and the owner's
// lookup by that branch refuses the pair.
export async function readMacroSources({
  repoRoot,
  branch,
  caps = ENTRY_READER_CAPS,
  stateRoots = null,
  io = ENTRY_READER_IO,
}) {
  const base = { source: 'macro' };
  // archive/ is deliberately not scanned (owner parity)
  const scan = await scanWorkflowHomes({ repoRoot, persona: 'orchestrator', caps, stateRoots, io });
  if (scan.state !== 'ok') return indeterminate(base, scan.reason);
  const activeMatches = new Map();
  const bridgeMatches = new Map();
  const filesById = new Map();
  const filesByPointer = new Map();
  const macrosByBranch = new Map();
  // Every spelling is indexed, as in the persona reader.
  for (const { pointer, identity } of scan.occurrences) addTo(filesByPointer, pointer, identity);
  for (const identity of physicalFiles(scan.occurrences)) {
    const lines = scan.records.get(identity);
    // A corrupt file in the macro home could BE the matching macro — the
    // owner's findMacroBySubtaskBranch throws here (fail-closed); mirror it.
    if (!lines) return indeterminate(base, 'unparseable-workflow-frontmatter');
    const typeToken = topLevelScalar(lines, 'workflow_type');
    if (typeToken === null) continue; // persona-shaped file — not a macro
    if (typeToken.invalid) return indeterminate(base, 'invalid-workflow-type');
    if (typeToken.value !== 'macro') continue;
    const schemaToken = topLevelScalar(lines, 'schema');
    if (!schemaToken || schemaToken.invalid || !MACRO_SCHEMA_RE.test(schemaToken.value)) {
      return indeterminate(base, 'unsupported-macro-schema');
    }
    // Schema "1.0" parses but the owner's next-ready refuses to dispatch it
    // (codex review MAJOR): carry actionability as a closed boolean so the
    // arbiter never synthesizes a command guaranteed to fail.
    const schemaActionable = schemaToken.value !== '1.0';
    const terminal = booleanScalar(lines, 'terminal_marker');
    if (terminal.invalid) return indeterminate(base, 'invalid-terminal-marker');
    const idToken = topLevelScalar(lines, 'workflow_id');
    const idValue = idToken && !idToken.invalid ? idToken.value : null;
    if (idValue !== null) addTo(filesById, idValue, identity);
    const idValid = idValue !== null && MACRO_WORKFLOW_ID_RE.test(idValue);
    const parsed = parseMacroSubtasks(lines);
    if (!parsed.ok) return indeterminate(base, 'malformed-macro-subtasks');
    const updatedToken = topLevelScalar(lines, 'updated_at');
    const summary = {
      workflow_id: idValid ? idValue : null,
      workflow_id_valid: idValid,
      terminal_marker: terminal.value,
      updated_at_ms: updatedToken && !updatedToken.invalid ? parseIsoMs(updatedToken.value) : null,
      pointer: pointerOf(scan.occurrences, identity),
    };
    const branchToken = gitBaselineBranch(lines);
    if (branchToken === null || branchToken.invalid) return indeterminate(base, 'missing-workflow-branch');
    addTo(macrosByBranch, branchToken.value, identity);
    if (branchToken.value === branch) activeMatches.set(identity, { rawId: idValue, summary });
    const matchingSubtasks = parsed.subtasks.filter((st) => st.branch === branch);
    if (matchingSubtasks.length > 0) {
      bridgeMatches.set(identity, {
        rawId: idValue,
        integrationBranch: branchToken.value,
        macro_id: summary.workflow_id,
        macro_id_valid: summary.workflow_id_valid,
        pointer: summary.pointer,
        readiness: deriveMacroReadiness(parsed.subtasks),
        schema_actionable: schemaActionable,
        subtask_matches: matchingSubtasks,
      });
    }
  }
  if (activeMatches.size > 1) return indeterminate(base, 'duplicate-active-macros');
  if (bridgeMatches.size > 1) return indeterminate(base, 'ambiguous-macro-bridge');
  const matched = [
    ...[...activeMatches].map(([identity, { rawId, summary }]) => ({ identity, rawId, pointer: summary.pointer })),
    ...[...bridgeMatches].map(([identity, { rawId, pointer }]) => ({ identity, rawId, pointer })),
  ];
  for (const { identity, rawId, pointer } of matched) {
    // One matched macro listed by two homes of one state root (judged per
    // macro: an active macro and a different bridging one are no pair).
    if (homeAmbiguity(scan.occurrences, new Set([identity])) !== null) return indeterminate(base, 'dual-home-ambiguity');
    if (rawId !== null && filesById.get(rawId).size > 1) return indeterminate(base, 'duplicate-workflow-id');
    if (filesByPointer.get(pointer).size > 1) return indeterminate(base, 'duplicate-pointer');
  }
  for (const { integrationBranch } of bridgeMatches.values()) {
    if (macrosByBranch.get(integrationBranch).size > 1) return indeterminate(base, 'duplicate-active-macros');
  }
  let bridge = null;
  if (bridgeMatches.size === 1) {
    const [match] = bridgeMatches.values();
    if (match.subtask_matches.length > 1) return indeterminate(base, 'ambiguous-macro-bridge');
    const st = match.subtask_matches[0];
    bridge = {
      macro_id: match.macro_id,
      macro_id_valid: match.macro_id_valid,
      pointer: match.pointer,
      readiness: match.readiness,
      schema_actionable: match.schema_actionable,
      subtask: {
        id: linkageToken(st.id),
        status: st.status,
        engineer_workflow_id: st.engineer_workflow_id !== null && PERSONA_WORKFLOW_ID_RE.test(st.engineer_workflow_id)
          ? st.engineer_workflow_id
          : null,
      },
    };
  }
  return {
    ...base,
    status: 'ok',
    reason: null,
    active_on_branch: activeMatches.size === 1 ? [...activeMatches.values()][0].summary : null,
    bridge,
  };
}

// --- persona handoff slots (dual-anchor, marker matrix) ---------------------

// Marker filename shape per persona — the ADR-0043 §2 cross-package contract
// (attention's sensor mirrors the same table): engineer/founder/designer key
// one marker per slot; orchestrator bakes the workflow id into the filename.
function markerFileFor(persona, projectionPath, workflowId) {
  if (persona === 'orchestrator') {
    const safe = String(workflowId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    return `${projectionPath}.${safe}.footer-rendered`;
  }
  return `${projectionPath}.footer-rendered`;
}

function withinFreshClass(ageMs, caps) {
  return ageMs <= caps.HANDOFF_FRESHNESS_MS && ageMs >= -caps.FUTURE_SKEW_MS;
}

export async function readHandoffSlotSource({ repoRoot, persona, nowMs, caps = ENTRY_READER_CAPS }) {
  const base = { source: 'handoff-slot', persona };
  // First existing candidate wins (sensor parity): when both homes hold a
  // slot the repo is already inconsistent — never trust the shadowed second.
  // The slot is this checkout's last terminal handoff, so only the checkout's
  // homes are read, never the default state root's (ADR-0067 Decision 1(a), W9).
  let projectionPath = null;
  let file = null;
  for (const { root } of personaHomes(checkoutOnlyReadSet(repoRoot), persona)) {
    const candidate = join(root, 'last-session-handoff.json');
    const read = await readBoundedFile(candidate, caps.MAX_FILE_BYTES);
    if (read.state === 'absent') continue;
    projectionPath = candidate;
    file = read;
    break;
  }
  if (!file) return { ...base, status: 'absent', reason: null };
  if (file.state !== 'ok') return indeterminate(base, file.reason);
  let projection;
  try {
    projection = JSON.parse(file.text);
  } catch {
    return indeterminate(base, 'slot-not-json');
  }
  if (!isPlainObject(projection)) return indeterminate(base, 'slot-not-an-object');
  // The slot in a persona's home must belong to that persona (codex review
  // MINOR: an engineer-home slot claiming workflow_kind founder is corrupt,
  // not a founder handoff).
  if (projection.workflow_kind !== persona) return indeterminate(base, 'slot-kind-mismatch');
  const idRe = persona === 'orchestrator' ? MACRO_WORKFLOW_ID_RE : PERSONA_WORKFLOW_ID_RE;
  const rawId = projection.workflow_id;
  const workflowId = typeof rawId === 'string' && idRe.test(rawId) ? rawId : null;

  const mtimeAge = nowMs - file.mtimeMs;
  const mtimeFresh = withinFreshClass(mtimeAge, caps);

  // Marker matrix (ADR-0045 §3.3): rendered(matching) → surfaced; absent /
  // claimed / mismatched → pending. A marker we cannot read or cannot
  // interpret is corruption → indeterminate (fail-closed), never "pending".
  let marker = 'absent';
  let markerAtMs = null;
  const markerRead = await readBoundedFile(markerFileFor(persona, projectionPath, rawId), caps.MAX_FILE_BYTES);
  if (markerRead.state === 'refused') return indeterminate(base, 'marker-unreadable');
  if (markerRead.state === 'ok') {
    let parsed;
    try {
      parsed = JSON.parse(markerRead.text);
    } catch {
      return indeterminate(base, 'marker-malformed');
    }
    if (!isPlainObject(parsed)) return indeterminate(base, 'marker-malformed');
    if (parsed.workflow_id !== rawId) marker = 'mismatched';
    else if (parsed.status === 'claimed') marker = 'claimed';
    else if (parsed.status === 'rendered') {
      // Sensor parity: the render instant must be strict ISO-UTC — a
      // permissive Date.parse would accept locale junk as an anchor.
      if (typeof parsed.at !== 'string' || !ISO_UTC_RE.test(parsed.at)) return indeterminate(base, 'marker-malformed');
      marker = 'rendered';
      markerAtMs = Date.parse(parsed.at);
    } else {
      return indeterminate(base, 'marker-malformed');
    }
  }

  // Dual-anchor freshness (sensor parity): the projection mtime always
  // anchors; a rendered marker adds its `at` as the second anchor because
  // Stop-path snapshots keep refreshing mtime while `at` moves once per
  // terminal transition. Non-rendered markers leave the slot on the single
  // mtime anchor — a pending handoff has no render instant yet (deliberate
  // divergence from the sensor, which returns null on a missing marker: its
  // job is transition-edge enrichment, this reader's is row visibility).
  let fresh = mtimeFresh;
  if (marker === 'rendered') {
    fresh = fresh && markerAtMs !== null && withinFreshClass(nowMs - markerAtMs, caps);
  }

  return {
    ...base,
    status: 'ok',
    reason: null,
    fresh,
    label: marker === 'rendered' ? 'surfaced' : 'pending',
    marker,
    marker_at_ms: markerAtMs,
    projection_mtime_ms: file.mtimeMs,
    workflow_id: workflowId,
    workflow_kind: persona,
    pointer: toPointer(repoRoot, projectionPath),
  };
}

// --- ADR-0044 entry.json (validate-or-skip, branch-checkable) ---------------

export async function readEntryCaptureSource({ repoRoot, branch }) {
  const base = { source: 'entry-capture' };
  const core = await inspectSessionCaptureFileCore({
    dir: sessionCaptureDir(repoRoot),
    fileName: 'entry.json',
    family: 'runtime-session-entry',
  });
  if (core.state === 'absent') return { ...base, status: 'absent', reason: null };
  if (core.state !== 'valid') return { ...base, status: 'invalid', reason: 'entry-validation-failed' };
  const doc = core.document;
  // branch_matches only — the stored branch string itself is free text and
  // never crosses the reader (codex review MAJOR); summary_source and host
  // are schema-enforced closed enums.
  return {
    ...base,
    status: 'ok',
    reason: null,
    branch_matches: typeof branch === 'string' && branch.length > 0 && doc.branch !== null ? doc.branch === branch : null,
    captured_at_ms: parseIsoMs(doc.captured_at),
    note_staged_at_ms: parseIsoMs(doc.note_staged_at),
    summary_source: doc.summary_source,
    host: doc.host,
  };
}

// --- row-only ledgers (latest context artifact, latest open consensus) ------

async function selectLatestRun({ repoRoot, family, runIdRe, fileName, nowMs, caps, classify }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', family);
  const listing = await listBoundedDir(root, caps);
  if (listing.state === 'absent') return { state: 'absent' };
  if (listing.state !== 'ok') return { state: 'refused', reason: listing.reason };
  let selected = null;
  let skippedInvalid = 0;
  let skippedTerminal = 0;
  let sawRun = false;
  for (const entry of listing.entries) {
    if (!entry.isDirectory() || !runIdRe.test(entry.name)) continue;
    sawRun = true;
    const read = await readBoundedFile(join(root, entry.name, fileName), caps.MAX_FILE_BYTES);
    if (read.state !== 'ok') {
      skippedInvalid++;
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(read.text);
    } catch {
      skippedInvalid++;
      continue;
    }
    // Plain-object gate inside the per-entry failure boundary (codex review
    // MAJOR: a literal-null document previously threw and aborted the whole
    // collection).
    if (!isPlainObject(doc)) {
      skippedInvalid++;
      continue;
    }
    const verdict = classify(entry.name, doc);
    if (verdict === 'invalid') {
      skippedInvalid++;
      continue;
    }
    if (verdict === 'terminal') {
      skippedTerminal++;
      continue;
    }
    const timestampMs = runTimestampMs(doc, entry.name);
    if (timestampMs === null) {
      skippedInvalid++;
      continue;
    }
    // Uniform future-skew bound (ADR-0045 §3): a far-future timestamp must
    // not win the latest slot and shadow the real latest row.
    if (timestampMs - nowMs > ENTRY_READER_CAPS.FUTURE_SKEW_MS) {
      skippedInvalid++;
      continue;
    }
    // Deterministic selection (ADR-0045 §11): newest timestamp wins; equal
    // timestamps resolve by lexicographic run-id — unlike the existing
    // latest-open selector, enumeration order never decides.
    if (!selected || timestampMs > selected.timestampMs
      || (timestampMs === selected.timestampMs && entry.name > selected.runId)) {
      selected = { runId: entry.name, timestampMs };
    }
  }
  if (!sawRun && skippedInvalid === 0) return { state: 'absent' };
  return { state: 'ok', selected, skippedInvalid, skippedTerminal };
}

function runTimestampMs(doc, runId) {
  for (const value of [doc.updated_at, doc.created_at]) {
    const ms = parseIsoMs(value);
    if (ms !== null) return ms;
  }
  const m = /^(?:context|consensus)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/.exec(runId);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export async function readContextLedgerSource({ repoRoot, nowMs = Date.now(), caps = ENTRY_READER_CAPS }) {
  const base = { source: 'context-ledger' };
  const result = await selectLatestRun({
    repoRoot,
    family: 'context',
    runIdRe: CONTEXT_RUN_ID_RE,
    fileName: 'context.json',
    nowMs,
    caps,
    classify: () => 'open',
  });
  if (result.state === 'absent') return { ...base, status: 'absent', reason: null };
  if (result.state !== 'ok') return indeterminate(base, result.reason);
  return {
    ...base,
    status: 'ok',
    reason: null,
    latest: result.selected ? { run_id: result.selected.runId, updated_at_ms: result.selected.timestampMs } : null,
    skipped_invalid: result.skippedInvalid,
  };
}

export async function readOpenConsensusSource({ repoRoot, nowMs = Date.now(), caps = ENTRY_READER_CAPS }) {
  const base = { source: 'consensus-open' };
  const result = await selectLatestRun({
    repoRoot,
    family: 'consensus',
    runIdRe: CONSENSUS_RUN_ID_RE,
    fileName: 'manifest.json',
    nowMs,
    caps,
    classify: (runId, manifest) => {
      if (manifest.run_id !== runId) return 'invalid';
      if (typeof manifest.status !== 'string') return 'invalid';
      // Open = no terminal pointer recorded AND status outside the terminal
      // set (consensus.mjs isOpenConsensusManifest parity — pointer
      // truthiness, not presence).
      if (manifest.cancellation_pointer || manifest.owner_decision_pointer || manifest.ratification_pointer) return 'terminal';
      if (CONSENSUS_TERMINAL_STATUSES.has(manifest.status)) return 'terminal';
      return 'open';
    },
  });
  if (result.state === 'absent') return { ...base, status: 'absent', reason: null };
  if (result.state !== 'ok') return indeterminate(base, result.reason);
  // run_id + age only — a non-terminal manifest status is an open free-string
  // set and never crosses the reader (codex review MAJOR).
  return {
    ...base,
    status: 'ok',
    reason: null,
    latest_open: result.selected ? { run_id: result.selected.runId, updated_at_ms: result.selected.timestampMs } : null,
    skipped_invalid: result.skippedInvalid,
    skipped_terminal: result.skippedTerminal,
  };
}

// --- orchestration ----------------------------------------------------------

const PERSONA_SOURCES = Object.freeze(['engineer', 'founder', 'designer']);
const SLOT_PERSONAS = Object.freeze(['engineer', 'orchestrator', 'founder', 'designer']);

// `branchProbe` is REQUIRED, never defaulted: this reader is a spawn-free R0
// filesystem leaf (the ADR-0035 executor guard's import-gate enforces that no
// unregistered lib module reaches for node:child_process). The consuming
// surface owns the git observation — the S7b arbiter threads its existing
// bounded probe (source-snapshot's git facts) in, exactly like the sensor
// threads `--host claude`. Contract: resolve a branch name string, '' for
// detached HEAD, or null when git is unavailable; a rejection is treated as
// null (degrade, never escape). A missing probe is a wiring bug and throws.
export async function collectEntrySources({ repoRoot, branchProbe, now = Date.now(), caps = ENTRY_READER_CAPS }) {
  if (typeof branchProbe !== 'function') {
    throw new TypeError('collectEntrySources requires an explicit branchProbe function (spawn-free reader — the caller owns git observation)');
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const probe = async () => {
    try {
      const value = await branchProbe(repoRoot);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };
  const initial = await probe();
  const branch = typeof initial === 'string' && initial.length > 0 ? initial : null;

  // Workflow records are read across the read set; the handoff slots, the
  // entry capture and the run ledgers below stay the checkout's (ADR-0067 W9).
  const stateRoots = await stateReadSet(repoRoot);
  const personas = {};
  for (const persona of PERSONA_SOURCES) {
    personas[persona] = branch
      ? await readPersonaWorkflowSource({ repoRoot, persona, branch, caps, stateRoots })
      : { source: 'persona-workflow', persona, status: 'no-branch', reason: null };
  }
  const macro = branch
    ? await readMacroSources({ repoRoot, branch, caps, stateRoots })
    : { source: 'macro', status: 'no-branch', reason: null };

  const handoffSlots = {};
  for (const persona of SLOT_PERSONAS) {
    handoffSlots[persona] = await readHandoffSlotSource({ repoRoot, persona, nowMs, caps });
  }
  const entryCapture = await readEntryCaptureSource({ repoRoot, branch });
  const contextLedger = await readContextLedgerSource({ repoRoot, nowMs, caps });
  const consensusOpen = await readOpenConsensusSource({ repoRoot, nowMs, caps });

  // Branch re-check after reads (ADR-0045 §3): a branch switch mid-scan makes
  // every per-branch fact unattributable — report the instability instead of
  // letting the arbiter emit cross-branch guidance.
  const final = await probe();
  const sources = {
    personas,
    macro,
    handoff_slots: handoffSlots,
    entry_capture: entryCapture,
    context_ledger: contextLedger,
    consensus_open: consensusOpen,
  };
  const skipped = skippedSourcesOf(sources);
  return {
    branch: {
      initial: branch,
      final: typeof final === 'string' && final.length > 0 ? final : null,
      stable: initial === final,
      state: initial === null ? 'unavailable' : initial === '' ? 'detached' : 'branch',
    },
    git_available: initial !== null,
    now_ms: nowMs,
    sources,
    sources_skipped: skipped.length,
    skipped_sources: skipped,
  };
}

// Each collected source that degraded (`indeterminate`, or `invalid` for the
// entry capture), in fixed order, as { source, kind, reason }: the reader's
// source name, the persona it belongs to (null for a generic source), and the
// fixed-code reason, or null for a code outside ENTRY_READER_REASON_CODES. At
// most one entry per source, so the list is bounded by the source set (11),
// and every value is a closed code: nothing read from a file crosses. The
// arbiter calls this on the sources it arbitrates, so the brief's list and its
// count cannot disagree.
export function skippedSourcesOf(sources) {
  const skipped = [];
  const note = (value, source, kind) => {
    if (value?.status !== 'indeterminate' && value?.status !== 'invalid') return;
    skipped.push({
      source,
      kind,
      reason: ENTRY_READER_REASON_CODES.has(value.reason) ? value.reason : null,
    });
  };
  for (const persona of PERSONA_SOURCES) note(sources?.personas?.[persona], 'persona-workflow', persona);
  note(sources?.macro, 'macro', 'orchestrator');
  for (const persona of SLOT_PERSONAS) note(sources?.handoff_slots?.[persona], 'handoff-slot', persona);
  note(sources?.entry_capture, 'entry-capture', null);
  note(sources?.context_ledger, 'context-ledger', null);
  note(sources?.consensus_open, 'consensus-open', null);
  return skipped;
}
