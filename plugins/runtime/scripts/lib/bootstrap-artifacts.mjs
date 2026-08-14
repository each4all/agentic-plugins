// plugins/runtime/scripts/lib/bootstrap-artifacts.mjs
//
// Machine-global artifact PRIMITIVES for `runtime:bootstrap` — the storage layer
// underneath the run manifest (machine-bootstrap-contract.md §5), the portable
// profile (§4), and the completion reducer (§8). Authorized by ADR-0046 §4 as an
// M1 *location* extension: agentic-plugins-owned writes, at a machine-global home
// instead of a repo-relative one. No new effect class — no host config, no
// credential, no network, no executor.
//
// This module owns WHERE and HOW, never WHAT. It persists whatever object it is
// handed, behind an injected `validate`; the run/profile SCHEMAS (S8a2 C4) and the
// profile/reducer engines (C5) supply meaning. Keeping the schema out of the
// storage layer is deliberate: the security gates below must hold for every future
// artifact shape, including ones this commit cannot see.
//
// Layout (contract §10, artifact-policy.md §Machine-global artifacts):
//
//   ~/.agentic-plugins/runs/bootstrap/<run-id>/run.json
//   ~/.agentic-plugins/runs/bootstrap/<run-id>/fragments/
//   ~/.agentic-plugins/runs/bootstrap/<run-id>/proof/
//   ~/.agentic-plugins/runs/bootstrap/latest.json
//   ~/.agentic-plugins/profiles/<name>.json
//   ~/.agentic-plugins/.locks/bootstrap.lock
//
// SECURITY POSTURE (contract §10.2, ADR-0035 §3). Every gate here is fail-closed
// and every refusal is REPORTED as data — this module never throws at a caller for
// an operator-environment condition, only for a programming error (a bad run id, a
// missing required argument).
//
//   * $HOME-is-the-repo — refused, not softened. The machine home's entire premise
//     is that it is outside every repository (artifact-policy.md); in a devcontainer
//     where $HOME IS the checkout, that premise is false and the write would land in
//     the repo. The egress config's verified-ignored-local reader already
//     established this exact posture (`inside-repo` → refuse); bootstrap does not
//     invent a softer one.
//   * Symlink refusal + canonical containment — per COMPONENT, not just the leaf.
//     A symlinked parent redirects every path below it, so checking only the final
//     name would be checking the one component a misconfiguration does not need.
//   * 0700 dirs / 0600 files, atomic temp+rename for every write.
//
// THREAT MODEL — stated, because these gates are easy to over-read. They defend
// against MISCONFIGURATION and ACCIDENTAL REDIRECTION: a devcontainer whose $HOME is
// the checkout, a symlink left behind by a moved home, a path built from the wrong
// root. They are NOT a defense against a local adversary racing us inside the
// operator's own 0700 home. Two reasons, both structural:
//   - Anyone who can swap a component of ~/.agentic-plugins between our check and
//     our write already has the operator's account, and can simply edit this file,
//     runtime's scripts, or ~/.claude/settings.json instead. There is no privilege
//     boundary here to defend.
//   - Closing those windows properly needs fd-relative syscalls (openat/mkdirat/
//     renameat with O_NOFOLLOW), which Node does not expose at all. A check-then-use
//     window is therefore inherent, not an oversight — and pretending otherwise
//     would be the dishonest part.
// Read paths (scanBootstrapRuns / readBootstrapLatest / listMachineProfiles) inherit
// the same model: they can be redirected by a symlinked ancestor, and doctor could
// then REPORT data from outside the home. It still cannot write there.
//
// CONCURRENCY. One family-wide lock covers run creation, open-run discovery,
// latest.json writes, and profile writes (contract §10.2). A per-run lock cannot
// serialize the thing that actually races — two processes each allocating a
// DIFFERENT run id and then both writing latest.json — because they would take two
// different locks and both win.
//
// RESIDUAL RACE, stated honestly. `assertOwned()` is a re-CHECK, not a fence. A
// process that lost its lock to a stale-break can still be told "you own it" and
// then stall before its write. Fencing needs a kernel mutex (flock/fcntl), which
// Node does not expose and which a zero-dependency policy will not add. What makes
// the residual acceptable is arithmetic, not hope: the stale bound is TEN MINUTES
// and the critical sections here are single-digit milliseconds, so losing the lock
// mid-section means the process was frozen ~10^5× longer than its own work takes —
// and at that point it is already the crashed run `abandon` exists for. The contract
// itself specifies pid + age as the staleness rule (§13), which is the same
// engineering trade made explicit.
//
// READ/WRITE SPLIT. `readBootstrapLatest` RESOLVES a corrupt pointer by scanning
// and reports the resolution, but never writes: doctor is ADR-0035 R0 read-only and
// calls it. `repairBootstrapLatest` persists, takes the lock, and is called only
// from paths that are already mutating.

import { randomBytes, createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { scrubSecrets } from './egress-channel.mjs';
import { EVIDENCE_FAMILIES, EVIDENCE_KINDS, validateEvidenceRecord } from './evidence-contract.mjs';
import { isUnder } from './path-containment.mjs';
import { makeValidator } from './schema-validate.mjs';
import { machineGlobalRoot, machinePointer, MACHINE_BOOTSTRAP_RETENTION_CAP } from './state-readers.mjs';

// The run-manifest validator, loaded once per process (ADR-0048 §3: every
// manifest read boundary validates before selection/reduction). Lazy because
// most module consumers never touch a manifest; a singleton because the scan
// re-reads every run under the retention cap on every verb.
let runManifestValidatorPromise = null;
function runManifestValidator() {
  runManifestValidatorPromise ??= makeValidator('runtime-bootstrap-run');
  return runManifestValidatorPromise;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BOOTSTRAP_ARTIFACT_FAMILY = 'bootstrap';
// The run-schema version this storage layer stamps (tombstones) and gates on
// (the post-terminal receipt window). bootstrap.mjs imports THIS — one lockstep
// site, not two.
export const BOOTSTRAP_RUN_SCHEMA_VERSION = 'runtime-bootstrap-run-1.2';
export const BOOTSTRAP_LATEST_SCHEMA_VERSION = 'runtime-bootstrap-latest-1.0';

// bootstrap-YYYYMMDDTHHMMSSZ-<6hex> — the same run-id shape as every other family
// (consensus/compat/settings/permission), so one regex idiom validates them all.
export const BOOTSTRAP_RUN_ID_RE = /^bootstrap-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// The §5 run statuses. 'open' is the only non-terminal one; C3 owns the open →
// abandoned transition (the operator's escape from a crashed run), while
// complete / configured-not-verified are the reducer's to assign (§8, C5).
export const BOOTSTRAP_RUN_STATUSES = Object.freeze(['open', 'complete', 'configured-not-verified', 'abandoned']);
export const BOOTSTRAP_TERMINAL_RUN_STATUSES = Object.freeze(['complete', 'configured-not-verified', 'abandoned']);
// The terminal statuses the D0.1 receipt attestation may still append into —
// the reducer-assigned completions, NEVER `abandoned`: an abandoned run is an
// escape hatch, not a completed bootstrap anyone can testify about.
export const BOOTSTRAP_COMPLETION_RUN_STATUSES = Object.freeze(['complete', 'configured-not-verified']);

// Profile --name charset (contract §10.2). No '/', no '\', no '..', no leading
// '.', no NUL — enforced as an ALLOWLIST, because an allowlist cannot be
// out-thought by an encoding the denylist author never met.
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Stale-lock bound (contract §13): pid gone OR age past ten minutes.
export const LOCK_STALE_MS = 10 * 60 * 1000;

// How far ahead of now a lock's mtime may sit before its metadata is treated as
// unusable rather than obeyed. Generous, because an NTP correction or a slightly
// skewed network filesystem is ordinary; anything past it is not a clock, and a
// pid-less lock dated in the future would otherwise block the family until that date.
const FUTURE_MTIME_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export const BOOTSTRAP_RETENTION_CAP = MACHINE_BOOTSTRAP_RETENTION_CAP;

// Applied at CREATE, never chmod-after, so a file is never briefly world-readable.
// LIMIT, stated: these govern what this module CREATES. A pre-existing
// ~/.agentic-plugins (say 0755 from an older version, or the operator's own mkdir)
// is left as the operator made it — mkdir's mode does not apply to a directory that
// already exists, and silently chmod'ing a directory the operator owns is a
// mutation nobody asked for. The umask can only REMOVE bits from these, never add,
// so a restrictive umask yields a stricter result, never a looser one.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Ids and names
// ---------------------------------------------------------------------------

// The ONE clock resolver. `now` may be a Date, epoch ms, or omitted — and omitted
// must mean "now", not `new Date(undefined)`, which throws RangeError on
// .toISOString(). Every entry point funnels through this so a caller that omits the
// clock gets a timestamp rather than a crash.
function resolveNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

// Built from an INJECTED clock — never read internally — so callers stay
// deterministic in tests (the permission-artifacts precedent).
export function makeBootstrapRunId(now) {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `bootstrap-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function isValidBootstrapRunId(runId) {
  return typeof runId === 'string' && BOOTSTRAP_RUN_ID_RE.test(runId);
}

// Throwing guard at every path-construction boundary, so a traversal-shaped id can
// never escape runs/bootstrap/. This throws (unlike the environment gates, which
// report) because a bad run id is a caller bug, not an operator condition.
export function validateBootstrapRunId(runId) {
  if (!isValidBootstrapRunId(runId)) {
    throw new Error(`invalid bootstrap run id '${runId}' (expected bootstrap-YYYYMMDDTHHMMSSZ-<6hex>)`);
  }
  return runId;
}

export function isValidProfileName(name) {
  return typeof name === 'string' && PROFILE_NAME_RE.test(name);
}

export function validateProfileName(name) {
  if (!isValidProfileName(name)) {
    throw new Error(
      `invalid profile name '${name}' (expected 1-64 chars of [A-Za-z0-9._-] starting alphanumeric; no '/', '\\', '..', leading '.', or NUL)`,
    );
  }
  return name;
}

// Timestamp embedded in a run id — the ordering key for retention and pointer
// recovery. Returns null for an unparseable id so a foreign directory can never
// sort itself newest.
export function bootstrapRunIdTimestampMs(runId) {
  if (!isValidBootstrapRunId(runId)) return null;
  const m = runId.match(/^bootstrap-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function bootstrapFamilyRoot(homeDir) {
  return join(machineGlobalRoot(homeDir), 'runs', BOOTSTRAP_ARTIFACT_FAMILY);
}

export function bootstrapRunDir(homeDir, runId) {
  return join(bootstrapFamilyRoot(homeDir), validateBootstrapRunId(runId));
}

export function bootstrapRunManifestFile(homeDir, runId) {
  return join(bootstrapRunDir(homeDir, runId), 'run.json');
}

export function bootstrapFragmentsDir(homeDir, runId) {
  return join(bootstrapRunDir(homeDir, runId), 'fragments');
}

export function bootstrapProofDir(homeDir, runId) {
  return join(bootstrapRunDir(homeDir, runId), 'proof');
}

export function bootstrapLatestFile(homeDir) {
  return join(bootstrapFamilyRoot(homeDir), 'latest.json');
}

export function profilesRoot(homeDir) {
  return join(machineGlobalRoot(homeDir), 'profiles');
}

export function profileFile(homeDir, name) {
  return join(profilesRoot(homeDir), `${validateProfileName(name)}.json`);
}

// The family-wide lock. Lives under .locks/ — OUTSIDE runs/ — so the inventory
// never counts it: a lock file inside the family root would make an otherwise
// empty family report `available` because a lock happened to exist.
export function bootstrapLockFile(homeDir) {
  return join(machineGlobalRoot(homeDir), '.locks', 'bootstrap.lock');
}

// ---------------------------------------------------------------------------
// Security gates
// ---------------------------------------------------------------------------

// Resolve the machine-global home, fail-closed. Returns a RESULT, never throws:
// every failure here is an operator-environment condition the caller must report,
// not a crash.
//
// `repoRoot` is a REQUIRED argument and must be passed explicitly — a path, or
// `null` to assert "no repository context". Omitting it fails closed
// ('repo-root-required'), because a caller that forgot it looks identical to a
// caller running inside the repo that $HOME points at, and the whole containment
// check is exactly that distinction. (The egress verified-ignored-local reader
// fails closed on a missing repoRoot for the same reason.)
export async function resolveMachineArtifactHome({ homeDir, repoRoot }) {
  if (typeof homeDir !== 'string' || homeDir.trim() === '') {
    return { ok: false, reason: 'home-required', root: null, diagnostic: 'No home directory resolved; bootstrap artifacts have no machine-global home to write to.' };
  }
  if (repoRoot === undefined) {
    return { ok: false, reason: 'repo-root-required', root: null, diagnostic: 'repoRoot was not passed; pass the repository root, or null to assert there is no repository context. Refusing to write unchecked.' };
  }

  const root = machineGlobalRoot(homeDir);

  // Compare CANONICAL forms of both sides. A symlinked home (/home/x → /Users/x, or
  // macOS's /var → /private/var) is ordinary and must not read as containment; a
  // home that canonically resolves into the repo must not escape the check by
  // looking different lexically. The home need not exist yet — canonicalPath
  // resolves what does exist.
  if (repoRoot !== null) {
    let realRoot;
    let realRepo;
    try {
      realRoot = await canonicalPath(root);
      realRepo = await canonicalPath(repoRoot);
    } catch (err) {
      // Canonicalization failed for a reason that is not "absent" — a permission
      // wall, a symlink loop, an I/O error. The containment question is therefore
      // UNANSWERED, and an unanswered safety question fails closed.
      return {
        ok: false,
        reason: 'canonicalization-failed',
        root: null,
        diagnostic: `Could not canonically resolve the machine-global home or the repository root (${err?.code ?? err?.message ?? String(err)}); cannot prove the home is outside the repository, so refusing to write.`,
      };
    }
    if (isUnder(realRoot, realRepo)) {
      return {
        ok: false,
        reason: 'home-is-repo',
        root: null,
        diagnostic:
          'The machine-global artifact home (~/.agentic-plugins) resolves INSIDE the current repository. ' +
          'That home exists to hold per-machine state outside every repository; writing it here would put machine state in a checkout. ' +
          'This is usually a devcontainer or CI image whose $HOME is the workspace. Set HOME to a real per-user directory and re-run.',
      };
    }
  }

  // `root` is the LOGICAL home, not the canonical one: every path helper builds
  // from the same logical homeDir, so the containment base must line up with them
  // lexically. Canonical comparison happens where it is load-bearing — the
  // home-is-repo gate above, and the post-mkdir re-verify in ensureSecureDir.
  return { ok: true, reason: 'ok', root, diagnostic: null };
}

// null ⇒ the path genuinely does not exist (ENOENT/ENOTDIR). Any OTHER error is
// thrown to the caller, because "I could not resolve this" and "this is not there"
// are different answers and only one of them is safe to build a containment decision
// on. Collapsing them is fail-OPEN: an EACCES or ELOOP would read as "absent", the
// canonicaliser would climb past it and re-append a lexical tail, and a home that
// really does resolve inside the repo could slip through the gate.
async function realpathOrNull(path) {
  try {
    return await realpath(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

// Canonical form of a path that MAY NOT EXIST YET — resolve the deepest existing
// ancestor and re-append the rest.
//
// Plain realpath is not enough and the gap is not theoretical: on the first run
// `~/.agentic-plugins` does not exist, so realpath fails and a caller falls back to
// the lexical path — then compares that against a realpath'd repo root. On macOS
// `/var` IS a symlink to `/private/var`, so the two forms of the same directory
// never match, and a $HOME-that-is-the-repo sails through the containment check
// because the strings differ. Canonicalizing BOTH sides is what makes the
// comparison mean what it says.
async function canonicalPath(path) {
  const abs = resolve(path);
  let current = abs;
  const tail = [];
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) return tail.length > 0 ? join(real, ...tail) : real;
    const parent = dirname(current);
    /* c8 ignore next */
    if (parent === current) return abs;
    tail.unshift(basename(current));
    current = parent;
  }
}

// null ⇒ genuinely absent. Any other error THROWS — deliberately, and the callers
// convert it to a fail-closed result. Returning null on EACCES would make the
// symlink walk below treat an unreadable component as a clean one and continue: a
// security walk that cannot see must refuse, not shrug.
async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

// Render a path under the machine home as `~/.agentic-plugins/...` for operator
// output. `root` is always `<homeDir>/.agentic-plugins`, so the home is its parent.
// Diagnostics get the same treatment as pointers: sanitizing the field named
// `pointer` and then interpolating the raw path into the message beside it would
// leak exactly what the pointer rule exists to prevent.
function homeRel(root, path) {
  return machinePointer(dirname(root), path);
}

// Per-COMPONENT symlink refusal + canonical containment for a path under `root`.
// Walking every component matters: a symlinked PARENT redirects everything below
// it, so a leaf-only check inspects the one component an attacker does not need to
// touch. Components that do not exist yet are not a finding — there is nothing to
// follow.
async function assertSecurePath({ root, path }) {
  const rel = relative(root, path);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    return { ok: false, reason: 'outside-containment', path, diagnostic: `Refusing to touch ${homeRel(root, path)}: it is not under the machine-global home ~/.agentic-plugins.` };
  }
  let current = root;
  for (const part of rel === '' ? [] : rel.split(sep)) {
    current = join(current, part);
    let st;
    try {
      st = await lstatOrNull(current);
    } catch (err) {
      // The walk could not SEE this component (permissions, I/O). An unanswered
      // security question fails closed — never "assume it is a directory".
      return { ok: false, reason: 'stat-failed', path: current, diagnostic: `Could not inspect ${homeRel(root, current)} (${err?.code ?? err?.message ?? String(err)}); cannot prove it is not a symlink, so refusing.` };
    }
    if (st === null) break;
    if (st.isSymbolicLink()) {
      return { ok: false, reason: 'symlinked-component', path: current, diagnostic: `Refusing to follow ${homeRel(root, current)}: a symlinked path component under the machine-global home is refused, not resolved.` };
    }
  }
  return { ok: true, reason: 'ok', path, diagnostic: null };
}

// Create a directory (0700) with the security gates applied, then RE-verify
// containment against the canonical path. The re-verify closes the window between
// the check and the mkdir — the same bind-the-decision-to-what-you-actually-got
// discipline the egress reader applies with its dev/ino recheck.
async function ensureSecureDir({ root, path }) {
  const gate = await assertSecurePath({ root, path });
  if (!gate.ok) return gate;
  try {
    await mkdir(path, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    // Same operator-environment class as the write itself (read-only home, revoked
    // permission, full disk) — reported, not thrown.
    return { ok: false, reason: 'write-failed', path, diagnostic: `Could not create ${homeRel(root, path)}: ${err?.code ?? err?.message ?? String(err)}.` };
  }
  // Both sides canonical: `root` is the logical home, so realpath'ing only the
  // child would compare /private/var/... against /var/... and refuse every write on
  // a Mac. The root itself MAY be a symlink (an operator moving ~/.agentic-plugins
  // to another disk is ordinary); what is refused is a symlinked component BELOW
  // it, which assertSecurePath already walked.
  let real;
  let realRoot;
  try {
    real = await realpathOrNull(path);
    realRoot = await canonicalPath(root);
  } catch (err) {
    return { ok: false, reason: 'canonicalization-failed', path, diagnostic: `Could not canonically resolve ${homeRel(root, path)} (${err?.code ?? err?.message ?? String(err)}); cannot prove containment, so refusing.` };
  }
  if (real === null || !isUnder(real, realRoot)) {
    return { ok: false, reason: 'outside-containment', path, diagnostic: `Refusing to use ${homeRel(root, path)}: it does not canonically resolve under the machine-global home.` };
  }
  return { ok: true, reason: 'ok', path, diagnostic: null };
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

// Atomic: write a sibling temp then rename. rename(2) within one directory is
// atomic on POSIX, so a crash or a concurrent writer never leaves a torn run.json
// or half-written pointer. Mode is set at CREATE (not chmod-after) so the file is
// never briefly world-readable.
async function writeFileAtomic({ root, path, text }) {
  const dir = join(path, '..');
  const dirGate = await ensureSecureDir({ root, path: dir });
  if (!dirGate.ok) return dirGate;
  const gate = await assertSecurePath({ root, path });
  if (!gate.ok) return gate;

  // A write failure here is an OPERATOR-ENVIRONMENT condition (a full disk, a
  // read-only home, a revoked permission), not a caller bug — so it is reported as
  // data like every other gate in this module, and the temp file is never left
  // behind to be inventoried as a mystery artifact.
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, text, { mode: FILE_MODE, encoding: 'utf8' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    return { ok: false, reason: 'write-failed', path, diagnostic: `Could not write ${homeRel(root, path)}: ${err?.code ?? err?.message ?? String(err)}.` };
  }
  return { ok: true, reason: 'ok', path, diagnostic: null };
}

async function writeJsonAtomic({ root, path, value }) {
  // Serialize BEFORE touching the filesystem. JSON.stringify throws on a circular
  // object or a BigInt, and a caller composing a manifest can hand us either; letting
  // that throw mid-write would escape as an exception from a module that promises
  // results, and — worse — would do it after the run directory was already reserved.
  let text;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (err) {
    // D1 §3.2 — a JSON.stringify failure message QUOTES THE INPUT: a circular
    // structure names the property that closes the cycle, which is a
    // document-supplied key. The failure mode is named without it.
    return { ok: false, reason: 'unserializable', path, diagnostic: `Refusing to write ${homeRel(root, path)}: the value is not serializable as JSON (the serializer's message is withheld because it names document-supplied keys).` };
  }
  return writeFileAtomic({ root, path, text });
}

async function readJsonSafe(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { status: 'missing', value: null };
    return { status: 'unreadable', value: null, reason: err?.code ?? String(err) };
  }
  try {
    return { status: 'ok', value: JSON.parse(text) };
  } catch {
    return { status: 'invalid_json', value: null };
  }
}

// Buffers hash as bytes; strings keep the previous behavior. The write side
// hashes the STRING it is about to encode (exact by construction); the read
// side must hash the bytes it found (a decode is not reversible).
function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Family lock
// ---------------------------------------------------------------------------

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — gone. EPERM: exists, owned by another user — alive.
    // Anything else: assume alive, because "I could not tell" must not read as
    // "safe to break someone's lock".
    return err?.code !== 'ESRCH';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acquire the family lock.
//
// The lock is CREATED with link(2) — a DELIBERATE deviation from the contract's
// "atomic temp-file + rename for every write", and the one place where following
// that letter would be the bug: rename(2) silently REPLACES an existing
// destination, so a temp+rename lock would overwrite whatever lock is already
// there and hand two processes the family. link(2) fails EEXIST instead, which is
// precisely the "claim it only if unclaimed" the rule is trying to express. It also
// publishes a fully-populated file (the content exists before the name does), so a
// reader can never see a created-but-empty lock and mistake a live holder for a
// corrupt one. Every ARTIFACT write — run.json, latest.json, profiles, fragments,
// proofs — uses temp+rename exactly as specified; this deviation is scoped to the
// lock's claim.
//
// Stale reclaim is TOKEN-KEYED and ATOMIC (contract §13 "never check-then-unlink").
// The naive form — read, judge stale, unlink — can delete a DIFFERENT lock than the
// one it judged, if the holder released and a new process acquired in between. Here
// the break is a rename to a breaker-unique path: rename(2) of the lock name is the
// arbiter, so exactly one breaker can win it per lock generation, and the winner
// then re-reads the moved file to confirm it is still the token it judged. If it is
// not, a fresh holder was displaced — link it back and concede.
// CLOCKS — there are two, and conflating them is a bug this module already made.
//
//   * `now` (injected, may be a logical test clock) stamps ARTIFACTS: run ids,
//     started_at, updated_at. Deterministic on purpose.
//   * `staleNowMs` (real wall clock by default) decides STALENESS, against the
//     lock's file mtime.
//
// They must never be crossed. Staleness asks "has a real process held this for ten
// real minutes", and both of its terms come from the filesystem's clock. Judging a
// real mtime with an injected `now` compares two unrelated timelines: with `now` set
// a few hours ahead of the machine's actual time — an ordinary thing for a test
// clock — every freshly-created lock reads as hours stale, and concurrent processes
// break each other's LIVE locks. `staleNowMs` exists as a seam for tests that need
// one; tests that can should move the lock's mtime instead, which is the real thing.
export async function acquireBootstrapFamilyLock({
  homeDir,
  repoRoot,
  now,
  pid = process.pid,
  staleMs = LOCK_STALE_MS,
  isPidAlive = defaultIsPidAlive,
  attempts = 20,
  retryDelayMs = 50,
  staleNowMs = null,
} = {}) {
  const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
  if (!home.ok) return { ok: false, reason: home.reason, diagnostics: [home.diagnostic], handle: null, holder: null };

  const root = home.root;
  const lockPath = bootstrapLockFile(homeDir);
  const lockDir = join(lockPath, '..');
  const dirGate = await ensureSecureDir({ root, path: lockDir });
  if (!dirGate.ok) return { ok: false, reason: dirGate.reason, diagnostics: [dirGate.diagnostic], handle: null, holder: null };

  const diagnostics = [];
  const staleClock = () => (typeof staleNowMs === 'number' ? staleNowMs : Date.now());
  const lockName = basename(lockPath);

  const displacedRefusal = (names) =>
    `A bootstrap family lock record is parked at ${names.join(', ')} under ${homeRel(root, lockDir)} instead of at ${lockName}. `
      + 'A previous run moved it aside and could not put it back, so the lock NAME is free while its holder may still believe it holds the family — running now would let two invocations proceed at once. '
      + `Move the parked file back to ${lockName} if no bootstrap is running, or delete it if the run that owned it is long gone; then re-run. This one is not reclaimed automatically, because only an operator can tell those two cases apart.`;

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    // AN EMPTY LOCK NAME IS NOT PROOF THAT NOBODY HOLDS THE FAMILY.
    //
    // Both displacement paths in this file move the lock RECORD off its
    // canonical name before deciding what to do with it — the release parks it
    // at `.release-<token>`, the stale break at `.breaking-<token>` — and both
    // put it back when the record turns out not to be theirs. When that restore
    // FAILS, the record stays parked and the canonical name stays free while its
    // holder still believes it holds the family. Acquisition used to look only
    // at the canonical name, so it would link it and hand two processes the
    // family: the same shape as the egress WAL race, one subsystem over.
    //
    // This PRE-scan catches the persistent state. It cannot catch the transient
    // one, and an earlier version of this comment claimed it did not need to —
    // on the grounds that a displacing process has already left its critical
    // section. That is true of the RELEASE path and FALSE of the stale BREAK,
    // where the displaced holder is the live one. Peer-measured: with the
    // pre-scan alone, a break landing between this readdir and the link below
    // produced two holders in 3 of 60 races (60 of 60 with no scan at all). The
    // post-link re-check after a successful acquire is what closes that.
    const parked = await listParkedLocks(lockDir, lockName);
    if (parked.error) {
      return {
        ok: false,
        reason: 'lock-unavailable',
        diagnostics: [...diagnostics, `Could not list ${homeRel(root, lockDir)} to check for a displaced bootstrap family lock (${parked.error}). Refusing to acquire a lock whose exclusion cannot be proven.`],
        holder: null,
        handle: null,
      };
    }
    if (parked.names.length > 0) {
      if (attempt < Math.max(1, attempts) - 1) {
        await sleep(retryDelayMs);
        continue;
      }
      return { ok: false, reason: 'lock-displaced', diagnostics: [...diagnostics, displacedRefusal(parked.names)], holder: null, handle: null };
    }

    const token = randomBytes(12).toString('hex');
    const owner = { owner_token: token, pid, acquired_at: new Date(staleClock()).toISOString() };
    const tmp = join(lockDir, `.acquire-${token}.tmp`);
    let acquired = false;
    try {
      await writeFile(tmp, `${JSON.stringify(owner)}\n`, { mode: FILE_MODE, encoding: 'utf8' });
      await link(tmp, lockPath);
      acquired = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        // link(2) can be unsupported on exotic mounts, and the home can be full or
        // read-only. REPORT it — never silently fall back to a weaker primitive,
        // because a lock that only looks like a lock is worse than an honest
        // refusal to proceed without one.
        await unlink(tmp).catch(() => {});
        return {
          ok: false,
          reason: 'lock-unavailable',
          diagnostics: [...diagnostics, `Could not create the bootstrap family lock at ${homeRel(root, lockPath)}: ${err?.code ?? err?.message ?? String(err)}. Refusing to run unserialized.`],
          holder: null,
          handle: null,
        };
      }
    } finally {
      await unlink(tmp).catch(() => {});
    }

    if (acquired) {
      // POST-LINK RE-CHECK. Not belt-and-braces — it closes the window the
      // pre-scan structurally cannot, and it does so DETERMINISTICALLY rather
      // than by narrowing odds.
      //
      // The argument is an ordering one, and it is bounded — an earlier draft
      // claimed "every dangerous ordering", which a peer disproved (see below).
      //
      // The case it covers: a breaker that MISMATCHES, i.e. renames aside a
      // record that is not the one it judged. That rename has to land after this
      // attempt's pre-scan and before its link — otherwise the pre-scan sees the
      // park, or the link fails EEXIST — so the park already exists when the
      // link returns. And it is still there, because the breaker's restore can
      // only succeed if the canonical name is free, and it is not: this attempt
      // is in it. Re-reading the directory here therefore sees that park every
      // time.
      //
      // The case it does NOT cover, stated because the proof must not be read as
      // broader than it is: a holder whose pid is live but whose claim has aged
      // past the stale bound is DELIBERATELY reclaimable (that policy is pinned
      // by its own regression), and a successful break unlinks its park before
      // this scan runs. That is the stale-reclaim policy working as designed,
      // not a race this check is failing to catch — but it is why the sentence
      // above says "a breaker that mismatches" and not "any breaker".
      //
      // What follows is a give-back, not a takeover: this attempt drops the lock
      // it just took rather than run beside a holder that may still believe it
      // holds the family. Its own release is safe for the usual reason — it is
      // dropping a record it published microseconds ago and has not acted on.
      //
      // MEASURED with a 60-race harness: 60/60 two-holder outcomes with no scan
      // at all, 3/60 with the pre-scan alone, 0/60 with this.
      const after = await listParkedLocks(lockDir, lockName);
      if (after.error || after.names.length > 0) {
        const dropped = await makeLockHandle({ lockPath, token, root }).release();
        const note = dropped.released
          ? ''
          : ` The lock this invocation had just taken could not be dropped again (${dropped.reason}${dropped.error ? `: ${dropped.error}` : ''}); it may need clearing by hand.`;
        if (after.error) {
          return {
            ok: false,
            reason: 'lock-unavailable',
            diagnostics: [...diagnostics, `Could not re-check ${homeRel(root, lockDir)} for a displaced bootstrap family lock after acquiring (${after.error}). Refusing to run on a lock whose exclusion cannot be proven.${note}`],
            holder: null,
            handle: null,
          };
        }
        diagnostics.push(`A bootstrap family lock record was displaced to ${after.names.join(', ')} while this invocation was acquiring; the lock it had just taken was given back rather than run alongside a holder that may still believe it holds the family.${note}`);
        if (attempt < Math.max(1, attempts) - 1) {
          await sleep(retryDelayMs);
          continue;
        }
        return { ok: false, reason: 'lock-displaced', diagnostics: [...diagnostics, displacedRefusal(after.names)], holder: null, handle: null };
      }
      return {
        ok: true,
        reason: 'ok',
        diagnostics,
        holder: null,
        handle: makeLockHandle({ lockPath, token, root }),
      };
    }

    const broke = await tryBreakStaleLock({ lockPath, nowMs: staleClock(), staleMs, isPidAlive, diagnostics });
    if (broke.broke || broke.vanished) continue;

    if (attempt < Math.max(1, attempts) - 1) {
      await sleep(retryDelayMs);
      continue;
    }
    const holder = sanitizeLockHolder(broke.holder);
    return {
      ok: false,
      reason: 'lock-held',
      diagnostics: [
        ...diagnostics,
        `The bootstrap family lock is held by pid ${holder.pid ?? 'unknown'} since ${holder.acquired_at ?? 'unknown'} and is not yet stale. ` +
          'Another bootstrap invocation is running; wait for it to finish and re-run. Do not delete the lock by hand — a stale lock is reclaimed automatically.',
      ],
      holder,
      handle: null,
    };
  }
  /* c8 ignore next */
  return { ok: false, reason: 'lock-held', diagnostics, holder: null, handle: null };
}

// The two parked shapes this module can produce, and ONLY those.
//
// Matching every `bootstrap.lock.*` sibling instead would be fail-closed in the
// wrong direction: an operator's own `bootstrap.lock.bak` would then block the
// family forever, for a state this code never creates and has no remedy for.
// The suffixes are the two verbs, each followed by the hex token that makes a
// park unique to its displacer.
const PARKED_LOCK_SUFFIX_RE = /^(release|breaking)-[0-9a-f]{8,}$/;

async function listParkedLocks(lockDir, lockName) {
  let entries;
  try {
    entries = await readdir(lockDir);
  } catch (err) {
    // ENOENT means the lock directory does not exist yet, so nothing can be
    // parked in it. Every other failure leaves the question unanswered, and an
    // unanswerable exclusion question is answered `no`.
    if (err?.code === 'ENOENT') return { names: [], error: null };
    return { names: [], error: err?.code ?? String(err) };
  }
  const prefix = `${lockName}.`;
  return {
    names: entries.filter((name) => name.startsWith(prefix) && PARKED_LOCK_SUFFIX_RE.test(name.slice(prefix.length))).sort(),
    error: null,
  };
}

// A lock body is UNTRUSTED input: it is whatever bytes are at that path, which on a
// bad day is a truncated write and on a worse one is something hand-placed. Only
// validated, known fields leave this module — never the parsed object itself, whose
// `pid` could be a string carrying an absolute path straight into a diagnostic (and
// whose extra keys nobody has vetted).
function sanitizeLockHolder(holder) {
  const pid = holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : null;
  const acquiredAt = typeof holder?.acquired_at === 'string' && Number.isFinite(Date.parse(holder.acquired_at))
    ? holder.acquired_at
    : null;
  return { pid, acquired_at: acquiredAt };
}

function makeLockHandle({ lockPath, token, root }) {
  let released = false;
  return {
    token,
    lockPath,
    root,
    // The holder's own ownership proof. A stale-breaker may have taken this lock
    // away while we were slow (that is the POINT of a stale bound), so a critical
    // section re-checks before it publishes rather than committing while
    // dispossessed.
    async assertOwned() {
      const read = await readJsonSafe(lockPath);
      return read.status === 'ok' && read.value?.owner_token === token;
    },
    async release() {
      if (released) return { released: false, reason: 'already-released' };
      // PRE-CHECK before touching anything. A dispossessed handle (a stale-breaker
      // took our lock and someone else now holds it) must not displace the current
      // holder even momentarily: the rename below removes the lock from its name for
      // the width of the verify, and a concurrent acquirer can slip into that gap and
      // leave two holders. Reading first costs one syscall and means the ONLY handle
      // that ever renames is one with reason to believe the lock is its own.
      const pre = await readJsonSafe(lockPath);
      if (pre.status === 'missing') {
        released = true;
        return { released: false, reason: 'not-held' };
      }
      if (pre.status === 'ok' && pre.value?.owner_token !== token) {
        released = true;
        return { released: false, reason: 'not-owner' };
      }

      // Token-keyed release, for the same reason the break is token-keyed: never
      // unlink a lock we no longer own (a stale-breaker may have re-issued it).
      const parked = `${lockPath}.release-${token}`;
      try {
        await rename(lockPath, parked);
      } catch (err) {
        // Mark released ONLY on a known terminal outcome: an ENOENT means the lock is
        // already gone (nothing to release), but any other error left it in place —
        // flagging `released` there would refuse the retry that could still free it.
        if (err?.code === 'ENOENT') {
          released = true;
          return { released: false, reason: 'not-held' };
        }
        return { released: false, reason: 'release-failed', error: err?.code ?? String(err) };
      }
      released = true;
      const read = await readJsonSafe(parked);
      // Restore unless we can POSITIVELY prove the parked lock is ours. An
      // unparseable body is not proof of ownership — deleting it because we could not
      // read it would destroy a lock we may never have held.
      if (!(read.status === 'ok' && read.value?.owner_token === token)) {
        // We took a lock that is not ours. Put it back — see restoreDisplacedLock
        // for why a failed restore must never be followed by an unlink — and
        // report where it went, because only an operator can move it back.
        const restore = await restoreDisplacedLock(parked, lockPath);
        if (!restore.restored) return { released: false, reason: 'release-failed', error: restore.code, parked };
        // Restored, but possibly with its duplicate still on disk. That is not a
        // release failure — the lock is back where it belongs — yet it must not
        // be silent either, because a parked name blocks the next acquisition.
        return restore.parkedRemoved
          ? { released: false, reason: 'not-owner' }
          : { released: false, reason: 'not-owner', parked, debris: parkedDebrisNote(parked, lockPath, restore).trim() };
      }
      try {
        await unlink(parked);
      } catch (err) {
        // Our OWN parked copy survived. The lock is genuinely released (the
        // canonical name is free), but the leftover would block every later
        // acquisition, so it is reported instead of dropped.
        return { released: true, reason: 'ok', parked, debris: `The released bootstrap family lock left a parked copy at ${basename(parked)} that could not be removed (${err?.code ?? String(err)}). Delete it: nothing holds the lock now, and a parked file blocks the next acquisition by design.` };
      }
      return { released: true, reason: 'ok' };
    },
  };
}

async function tryBreakStaleLock({ lockPath, nowMs, staleMs, isPidAlive, diagnostics }) {
  // Read the body and the identity from ONE open file descriptor. Two separate
  // syscalls (readJsonSafe then lstat) can see two DIFFERENT files: a breaker could
  // read stale lock S, have S replaced by live lock F, then stat F — and the recheck
  // below would compare F against F, pass, and delete a live holder's lock. Binding
  // both to one fd is what makes "the thing I judged" a single object.
  const judged = await readLockFile(lockPath);
  if (judged.status === 'missing') return { broke: false, vanished: true, holder: null };

  const holder = judged.value && typeof judged.value === 'object' ? judged.value : null;

  // AGE AUTHORITY IS THE FILE MTIME, not `acquired_at`. The body is data the lock
  // carries about itself; the mtime is what the kernel observed when the lock was
  // created (link(2) preserves the temp file's mtime, set microseconds earlier).
  // Trusting the body gives two failures at once:
  //   - a future `acquired_at` (say year 9999) makes the age permanently negative,
  //     so with a live-looking pid NOBODY can ever reclaim the lock — the permanent
  //     block §10.2 exists to prevent;
  //   - a caller's INJECTED clock stamps `acquired_at`, so a process that captured
  //     `now` and acquired eleven minutes later would write a lock born stale.
  // `acquired_at` stays as reported metadata; it is not the arbiter.
  const ageMs = nowMs - judged.mtimeMs;

  // A pid we cannot probe is NOT gone: only an explicit ESRCH says gone (EPERM means
  // it exists under another uid). The pid is taken from an UNTRUSTED body, so it is
  // accepted only as a positive integer — never handed to the probe as whatever the
  // file happened to contain.
  const pid = holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : null;
  const pidGone = pid === null ? false : !isPidAlive(pid);

  // A lock with NO usable pid can only be judged on age — so an mtime in the future
  // would block the family until that date arrives. Moving the age authority to the
  // mtime fixed the FORGEABLE half (a body claiming year 9999); this closes the
  // other: metadata that cannot be true is treated as unusable rather than
  // obeyed. A lock that DOES carry a live pid is never broken this way — its pid is
  // the better evidence, and a backwards clock jump must not evict a running holder.
  const impossiblyFuture = pid === null && judged.mtimeMs > nowMs + FUTURE_MTIME_TOLERANCE_MS;
  if (!(pidGone || ageMs >= staleMs || impossiblyFuture)) return { broke: false, vanished: false, holder };

  const breaker = randomBytes(8).toString('hex');
  const parked = `${lockPath}.breaking-${breaker}`;
  try {
    await rename(lockPath, parked);
  } catch (err) {
    // ENOENT: the holder released (or another breaker won the rename) — retry the
    // acquire. Any other error means we could not break it; concede rather than
    // throw, and let the caller report a held lock.
    if (err?.code === 'ENOENT') return { broke: false, vanished: true, holder };
    return { broke: false, vanished: false, holder };
  }

  // RECHECK, after the atomic move: is what we actually took what we judged stale?
  // Both identities are checked, and the dev/ino half is load-bearing — without it a
  // TOKENLESS (unparseable) lock has no token to compare, so this recheck would be
  // skipped and the break would unlink whatever it grabbed. That is a live-lock
  // destroyer: breaker B removes the corrupt lock, holder C acquires a fresh one,
  // and slow breaker A then renames C's lock away and deletes it — leaving C and a
  // later D both believing they hold the family lock, which is exactly the "two
  // processes both create a run" outcome the lock exists to prevent.
  // Identity is compared whatever the body's readability — an unreadable lock is
  // still a recognizable file, and requiring a successful READ here would concede
  // every break of one, i.e. never reclaim it.
  //
  // dev/ino is NOT sufficient on its own, and CI proved it: Linux REUSES an inode
  // number as soon as it is freed, so a lock that was unlinked and immediately
  // recreated can land on the very inode we judged — and the recheck would wave a LIVE
  // holder's lock through as "the same file". (macOS/APFS does not reuse as eagerly,
  // which is exactly why this passed locally and failed on Linux.) mtime and the raw
  // bytes are compared too: an inode may be recycled, but a recreated lock does not
  // also reproduce the nanosecond it was written AND the token inside it.
  const moved = await readLockFile(parked);
  const sameFile = moved.status !== 'missing'
    && moved.dev === judged.dev
    && moved.ino === judged.ino
    && moved.mtimeMs === judged.mtimeMs
    && moved.text === judged.text;
  const sameToken = holder?.owner_token === undefined
    ? true
    : moved.value?.owner_token === holder.owner_token;
  if (!sameFile || !sameToken) {
    // We displaced a lock we never judged. Put it back and concede; never delete
    // it — and "never delete it" has to hold when the RESTORE fails too, which is
    // what the unconditional unlink under this comment used to break. Same rule,
    // same helper as the release path: see restoreDisplacedLock.
    //
    // Coverage, stated because it is partial: the RULE is pinned by the release
    // regressions, which exercise the same helper. This CALL SITE's wiring is
    // not — reaching it needs a lock that changes identity between the judge and
    // the rename, which is a race, not a fixture, and no seam here can force it.
    // Mutation-measured: replacing the helper body fails two tests; inlining the
    // old shape HERE fails none. Calling the helper is what keeps that gap one
    // line wide.
    const restore = await restoreDisplacedLock(parked, lockPath);
    diagnostics.push(restore.restored
      ? `A bootstrap family lock was re-acquired while a stale break was in flight; the fresh lock was restored and the break abandoned.${parkedDebrisNote(parked, lockPath, restore)}`
      : `A bootstrap family lock was re-acquired while a stale break was in flight, and the displaced lock could NOT be restored (${restore.code}). `
        + `It is parked at ${basename(parked)} and was deliberately not deleted. Move it back to ${basename(lockPath)} before the next run: until then the lock name is free while its holder still believes it holds the family, which is why the next acquisition refuses outright rather than proceeding.`);
    return { broke: false, vanished: false, holder: moved.value ?? holder };
  }

  await unlink(parked).catch(() => {});
  diagnostics.push(
    `Reclaimed a stale bootstrap family lock (${pidGone ? `owning pid ${pid} is gone` : impossiblyFuture ? 'its timestamp is dated implausibly far in the future, so its age cannot be trusted' : `age ${Math.round(ageMs / 1000)}s exceeds the ${Math.round(staleMs / 1000)}s bound`}). ` +
      'The previous invocation did not release it — usually a crash or a kill. The lock was broken automatically after an owner-token recheck; no operator action is needed.',
  );
  return { broke: true, vanished: false, holder };
}

// Put back a lock this process displaced but does not own, and drop the parked
// copy ONLY if that succeeded.
//
// One helper for both displacement sites (the release and the stale-break
// recheck) because they had the same bug, in the same shape, in the same file:
// `link(...).catch(() => {})` followed by an unconditional `unlink`. When the
// link-back fails, the parked name holds the ONLY link to a live holder's lock,
// so deleting it frees the lock NAME while that holder still believes it holds
// the family — two holders, the one outcome this lock exists to prevent. Merging
// them is the fix rather than patching each: a second copy is how the first
// survived a review, and the egress WAL take in doctor.mjs was written from this
// code and inherited it a third time.
//
// `link(2)`, never `rename(2)`: if the lock name has been claimed again while we
// held the record aside, link fails EEXIST and the newcomer keeps it, where a
// rename would silently destroy that lock too.
//
// The parked copy's removal is REPORTED rather than swallowed. It used to be a
// bare `.catch(() => {})` under a `restored: true`, which was already dishonest
// (silent debris) and became load-bearing the moment acquisition started
// refusing while a parked lock exists: a leftover copy would then block every
// future run, with nothing in the output saying where it came from. After a
// successful link-back both names point at the SAME inode, so deleting the
// parked one is provably safe — and that is exactly the sentence the caller
// needs to be able to give the operator.
//
// COVERAGE, STATED BECAUSE IT IS ABSENT — not partial, absent. Nothing pins the
// failure branch below, and that was MEASURED rather than assumed: reverting
// this function to the swallowing form fails ZERO tests in the whole suite,
// while the acquisition refusal it feeds fails two.
//
// An earlier version of this note argued the branch was UNREACHABLE, on the
// grounds that `link` needs write permission on the destination directory and
// `unlink` on the source, and here they are the same directory — so an unlink
// failure implies the link already failed. Peer round 5 disproved it: that holds
// only if the directory is unchanging. A concurrent `chmod`, or an I/O fault,
// between the two syscalls reaches this branch, and the peer built exactly that
// (link, chmod 0500, unlink → EACCES; chmod 0700 → control succeeds). So the
// branch is reachable, just not constructible as a FIXTURE without an ordering
// seam this module does not offer — the same position it takes on its clock.
// Recorded as an open coverage item rather than argued away a second time.
// What IS pinned is the success side: the release regression asserts the lock
// directory ends EMPTY, so a mutant that always reports debris fails (measured:
// 17 failures).
async function restoreDisplacedLock(parked, lockPath) {
  try {
    await link(parked, lockPath);
  } catch (err) {
    return { restored: false, code: err?.code ?? String(err), parkedRemoved: false, parkedCode: null };
  }
  try {
    await unlink(parked);
  } catch (err) {
    return { restored: true, code: null, parkedRemoved: false, parkedCode: err?.code ?? String(err) };
  }
  return { restored: true, code: null, parkedRemoved: true, parkedCode: null };
}

// The operator-facing tail for a restore that put the lock back but could not
// drop its parked duplicate. Shared by both displacement sites so the two cannot
// drift into describing the same state differently.
function parkedDebrisNote(parked, lockPath, restore) {
  if (restore.parkedRemoved) return '';
  return ` The lock was restored, but its parked duplicate at ${basename(parked)} could not be removed (${restore.parkedCode}). `
    + `That copy is the SAME file as ${basename(lockPath)}, so deleting it is safe — and it must be deleted, because a parked lock blocks every later acquisition by design.`;
}

// Read a lock's body AND its identity from one fd, so both describe the same inode.
// Never throws: every failure is a status a caller branches on.
async function readLockFile(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { status: 'missing', value: null, text: null, dev: null, ino: null, mtimeMs: 0 };
    // Unreadable (mode 000, an I/O error) — but IDENTITY and MTIME survive, because
    // lstat needs only the directory. They must: without them the post-rename recheck
    // has nothing to compare, concedes every time, and an unreadable lock becomes
    // unbreakable — the permanent block, rebuilt one layer down. A body we cannot
    // read is still a file we can recognize.
    const st = await lstat(path).catch(() => null);
    if (st === null) return { status: 'missing', value: null, text: null, dev: null, ino: null, mtimeMs: 0 };
    // No text to compare, so identity rests on dev/ino/mtime alone for this one case.
    return { status: 'unreadable', value: null, text: null, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  }
  try {
    const st = await handle.stat();
    const text = await handle.readFile('utf8');
    let value = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null; // an unparseable body is still a lock: identity and mtime hold.
    }
    return { status: 'ok', value, text, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return { status: 'unreadable', value: null, text: null, dev: null, ino: null, mtimeMs: 0 };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Run `fn` under the family lock, releasing it on every path. `fn` receives the
// lock handle so a critical section can re-prove ownership before it publishes.
export async function withBootstrapFamilyLock(options, fn) {
  const lock = await acquireBootstrapFamilyLock(options);
  if (!lock.ok) return { ok: false, reason: lock.reason, diagnostics: lock.diagnostics, holder: lock.holder, value: null };
  try {
    const value = await fn(lock.handle);
    return { ok: true, reason: 'ok', diagnostics: lock.diagnostics, holder: null, value };
  } finally {
    // Releasing must never mask the critical section's outcome: a throw from
    // release() inside `finally` REPLACES whatever fn returned or threw, so a
    // successful create could surface as an unlink error. release() reports rather
    // than throws, and this catch is the belt to that braces.
    //
    // But "must not mask" is not "must not report": discarding the result made
    // release()'s failure reporting inert, including the parked path an operator
    // needs to put a displaced lock back. Pushing into `lock.diagnostics` here is
    // visible to the caller because it is the same array the returns above hand
    // out and `finally` runs before the value leaves this function. Only genuine
    // failures are reported — not-held / not-owner / already-released are normal
    // outcomes of a handle that was superseded or released twice.
    const released = await lock.handle.release().catch((err) => ({ released: false, reason: `release-threw:${err?.code ?? err?.message ?? 'error'}` }));
    if (released?.released === false && !['not-held', 'not-owner', 'already-released'].includes(released.reason)) {
      lock.diagnostics.push(
        `Releasing the bootstrap family lock did not complete (${released.reason}${released.error ? `: ${released.error}` : ''})` +
          `${released.parked ? `; the displaced lock is parked at ${basename(released.parked)} and was not deleted` : ''}.`,
      );
    }
    // Debris is reported INDEPENDENTLY of the released/reason verdict. A release
    // that succeeded and a not-owner restore that succeeded are both normal
    // outcomes filtered out above, and both can still leave a parked file behind
    // — which now blocks every later acquisition, so it cannot ride on a branch
    // that exists to stay quiet about normal outcomes.
    if (released?.debris) lock.diagnostics.push(released.debris);
  }
}

// ---------------------------------------------------------------------------
// Run discovery
// ---------------------------------------------------------------------------

// Scan the family for run directories. Metadata + status only; never a fragment or
// proof body. A directory whose name is not a valid run id is IGNORED as a run but
// REPORTED as foreign, so a stray path is visible without being able to sort itself
// newest or block a plan.
export async function scanBootstrapRuns({ homeDir }) {
  const root = bootstrapFamilyRoot(homeDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err?.code ?? '') === 'ENOENT';
    return { status: missing ? 'missing' : 'blocked', root: machinePointer(homeDir, root), runs: [], foreign: [], error: missing ? null : (err?.code ?? String(err)) };
  }

  const runs = [];
  const foreign = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidBootstrapRunId(entry.name)) {
      foreign.push(entry.name);
      continue;
    }
    const read = await readJsonSafe(join(root, entry.name, 'run.json'));
    const manifest = read.status === 'ok' && read.value && typeof read.value === 'object' ? read.value : null;
    const rawStatus = manifest && typeof manifest.status === 'string' ? manifest.status : null;
    const status = rawStatus && BOOTSTRAP_RUN_STATUSES.includes(rawStatus) ? rawStatus : null;
    // ADR-0048 §3 — the scan is the EARLIEST manifest trust boundary: runPlan's
    // open-run check consumes `terminal` before selectRun ever runs, so a
    // schema-invalid body claiming `{status:"complete"}` used to prove a run
    // terminal and let a second plan proceed. `terminal` therefore requires a
    // schema-VALID manifest, not merely a recognized status string; an invalid
    // one stays not-proven-terminal, blocks new plans, and is named for the
    // operator to `abandon` (which replaces an invalid record with a valid
    // tombstone).
    const schemaValid = manifest ? (await runManifestValidator())(manifest).ok : null;
    runs.push({
      run_id: entry.name,
      status,
      // The status as WRITTEN, retained separately so an unrecognized value can be
      // named in a diagnostic instead of vanishing into `status: null` — the operator
      // needs to know whether their run.json says nothing or says something this
      // version does not understand.
      raw_status: rawStatus,
      manifest_status: read.status,
      schema_valid: schemaValid,
      terminal: status !== null && schemaValid === true && BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(status),
      started_at: typeof manifest?.started_at === 'string' ? manifest.started_at : null,
      updated_at: typeof manifest?.updated_at === 'string' ? manifest.updated_at : null,
      created_ms: bootstrapRunIdTimestampMs(entry.name),
      pointer: machinePointer(homeDir, join(root, entry.name)),
    });
  }
  runs.sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0) || b.run_id.localeCompare(a.run_id));
  return { status: 'available', root: machinePointer(homeDir, root), runs, foreign, error: null };
}

// The runs that block a new plan (contract §10.2: "a second plan while a run is
// open is rejected, naming the open run's id").
//
// The predicate is "NOT PROVEN TERMINAL", not "looks open". Those differ, and the
// difference is a false-negative that lets two runs exist: a `run.json` containing
// `{}` parses fine (manifest_status 'ok') and has no `status`, so an is-it-open test
// answers "not open" and a second plan is created against a run nobody can prove
// finished. Same for a status this version does not know. Only a positively
// recognized terminal status (complete / configured-not-verified / abandoned) closes
// a run — the same rule §6 states for steps, where `unknown` is never satisfied.
//
// It never traps the machine: every blocker is named with its run id, and `abandon`
// closes it by id — which works precisely because the id comes from the directory
// name and not from a body we could not read or understand.
export function selectBlockingRuns(runs) {
  return runs.filter((run) => !run.terminal);
}

// ---------------------------------------------------------------------------
// latest.json — pointer + scan recovery
// ---------------------------------------------------------------------------

// READ-ONLY (ADR-0035 R0). Resolves a missing / malformed / orphaned pointer by
// scanning run directories and reports the resolution — but never writes it, so
// doctor can call this without becoming a mutation. `repairBootstrapLatest`
// persists.
export async function readBootstrapLatest({ homeDir }) {
  const latestPath = bootstrapLatestFile(homeDir);
  const scan = await scanBootstrapRuns({ homeDir });

  // A BLOCKED scan cannot answer anything the rest of this function asserts. Without
  // this, an unreadable family plus a malformed pointer reports `empty` with no
  // diagnostic — claiming the family is empty when we could not read it — and a
  // perfectly valid pointer reports `orphaned` because the scan that would have
  // confirmed its run failed. "I could not look" is not "there is nothing there".
  if (scan.status === 'blocked') {
    return {
      status: 'blocked',
      pointer_state: 'unknown',
      run_id: null,
      pointer: machinePointer(homeDir, latestPath),
      run_pointer: null,
      recovered: false,
      recovery_source: null,
      diagnostics: [`Cannot read the bootstrap family at ${scan.root} (${scan.error}); the latest-run pointer cannot be resolved or recovered.`],
    };
  }

  const newest = scan.runs[0] ?? null;
  const read = await readJsonSafe(latestPath);

  const recover = (reason) => ({
    status: newest ? 'recovered' : scan.status === 'missing' ? 'missing' : 'empty',
    pointer_state: reason,
    run_id: newest?.run_id ?? null,
    pointer: machinePointer(homeDir, latestPath),
    run_pointer: newest ? machinePointer(homeDir, join(bootstrapFamilyRoot(homeDir), newest.run_id)) : null,
    recovered: Boolean(newest),
    recovery_source: newest ? 'scan' : null,
    diagnostics: newest
      ? [`The bootstrap latest.json pointer was ${reason.replace(/_/g, ' ')}; the newest run (${newest.run_id}) was recovered by scanning run directories. Run a bootstrap command that writes to persist the repair.`]
      : [],
  });

  if (read.status === 'missing') {
    return scan.runs.length === 0
      ? { status: scan.status === 'missing' ? 'missing' : 'empty', pointer_state: 'absent', run_id: null, pointer: machinePointer(homeDir, latestPath), run_pointer: null, recovered: false, recovery_source: null, diagnostics: [] }
      : recover('absent');
  }
  if (read.status !== 'ok') return recover(read.status === 'invalid_json' ? 'malformed' : 'unreadable');

  const runId = read.value?.run_id;
  if (!isValidBootstrapRunId(runId)) return recover('malformed');
  if (!scan.runs.some((run) => run.run_id === runId)) return recover('orphaned');

  return {
    status: 'ok',
    pointer_state: 'ok',
    run_id: runId,
    pointer: machinePointer(homeDir, latestPath),
    run_pointer: machinePointer(homeDir, join(bootstrapFamilyRoot(homeDir), runId)),
    recovered: false,
    recovery_source: null,
    diagnostics: [],
  };
}

// Persist the pointer. Caller MUST already hold the family lock — latest.json is
// exactly the file two concurrent run creations race on, which is why the lock is
// family-wide and not per-run.
async function writeLatestLocked({ root, homeDir, runId, status, updatedAt, handle }) {
  if (handle && !(await handle.assertOwned())) {
    return { ok: false, reason: 'lock-lost', diagnostic: 'The family lock was reclaimed mid-write; refusing to publish latest.json without it.', path: null };
  }
  return writeJsonAtomic({
    root,
    path: bootstrapLatestFile(homeDir),
    value: {
      schema_version: BOOTSTRAP_LATEST_SCHEMA_VERSION,
      family: BOOTSTRAP_ARTIFACT_FAMILY,
      run_id: runId,
      status,
      updated_at: updatedAt,
      run_pointer: machinePointer(homeDir, join(bootstrapFamilyRoot(homeDir), runId)),
    },
  });
}

// Repair a corrupt/orphaned pointer durably, under the lock. Separate from
// readBootstrapLatest so the read path stays read-only.
export async function repairBootstrapLatest({ homeDir, repoRoot, now, ...lockOptions }) {
  const result = await withBootstrapFamilyLock({ homeDir, repoRoot, now, ...lockOptions }, async (handle) => {
    const latest = await readBootstrapLatest({ homeDir });
    if (latest.status !== 'recovered') return { repaired: false, ...latest };
    const scan = await scanBootstrapRuns({ homeDir });
    const newest = scan.runs.find((run) => run.run_id === latest.run_id);
    const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
    /* c8 ignore next */
    if (!home.ok) return { repaired: false, ...latest };
    const write = await writeLatestLocked({
      root: home.root,
      homeDir,
      runId: latest.run_id,
      status: newest?.status ?? null,
      updatedAt: newest?.updated_at ?? new Date(resolveNowMs(now)).toISOString(),
      handle,
    });
    return write.ok ? { repaired: true, ...latest } : { repaired: false, ...latest, diagnostics: [...latest.diagnostics, write.diagnostic] };
  });

  // Unwrapped, like createBootstrapRun / abandonBootstrapRun / writeMachineProfile:
  // every mutating entry point in this module returns its own result shape, so a
  // caller never has to know which of them happen to take the lock.
  if (!result.ok) return { repaired: false, status: 'blocked', reason: result.reason, run_id: null, diagnostics: result.diagnostics };
  return { ...result.value, diagnostics: [...result.diagnostics, ...result.value.diagnostics] };
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

// Create a run — the check-then-create that the family lock exists to make atomic.
// Two concurrent plans cannot both create a run: whoever takes the lock first
// creates and publishes; the second sees the now-open run and is REJECTED naming
// it. Without the lock, both would see "no open run" and both would create one.
//
// `manifest` is whatever the caller composes (§5 shape, C4 schema); `validate` is
// injected, so the storage layer never grows a second, drifting copy of the schema.
export async function createBootstrapRun({ homeDir, repoRoot, now, manifest, validate = null, ...lockOptions }) {
  const nowMs = resolveNowMs(now);
  const result = await withBootstrapFamilyLock({ homeDir, repoRoot, now, ...lockOptions }, async (handle) => {
    const scan = await scanBootstrapRuns({ homeDir });
    if (scan.status === 'blocked') {
      return { created: false, reason: 'family-unreadable', run_id: null, blocking: [], diagnostics: [`Cannot read the bootstrap family at ${scan.root} (${scan.error}).`] };
    }
    const blocking = selectBlockingRuns(scan.runs);
    if (blocking.length > 0) {
      return {
        created: false,
        reason: 'run-open',
        run_id: null,
        blocking,
        diagnostics: blocking.map((run) =>
          run.status === 'open'
            ? `Run ${run.run_id} is still open (started ${run.started_at ?? 'unknown'}). Continue it with \`resume --latest-open\`, or close it with \`abandon ${run.run_id}\`.`
            : run.manifest_status !== 'ok'
              ? `Run ${run.run_id} has an unreadable manifest (${run.manifest_status}), so it cannot be proven closed. Close it with \`abandon ${run.run_id}\`.`
              : `Run ${run.run_id} carries no recognized status (${run.raw_status === null ? 'absent' : `'${run.raw_status}'`}), so it cannot be proven closed. Close it with \`abandon ${run.run_id}\`.`,
        ),
      };
    }

    const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
    /* c8 ignore next */
    if (!home.ok) return { created: false, reason: home.reason, run_id: null, blocking: [], diagnostics: [home.diagnostic] };

    const runId = isValidBootstrapRunId(manifest?.run_id) ? manifest.run_id : makeBootstrapRunId(nowMs);
    const startedAt = new Date(nowMs).toISOString();
    const value = { ...manifest, run_id: runId, status: 'open', started_at: manifest?.started_at ?? startedAt, updated_at: startedAt };
    if (validate) {
      const verdict = validate(value);
      if (!verdict?.ok) {
        return { created: false, reason: 'invalid-manifest', run_id: null, blocking: [], diagnostics: verdict?.errors ?? ['The run manifest failed validation; refusing to write it.'] };
      }
    }

    // Re-prove ownership before the FIRST durable effect, not only before
    // latest.json. The open-run scan above is the check half of a check-then-create;
    // if a stale-breaker took the lock away between the scan and here, another
    // process may have created its own run against the same "no open run" answer,
    // and writing ours anyway would produce the two-runs outcome the lock exists to
    // prevent. This narrows that window to the section below; it does not fence it
    // (see the RESIDUAL RACE note at the top of the lock section).
    if (!(await handle.assertOwned())) {
      return { created: false, reason: 'lock-lost', run_id: null, blocking: [], diagnostics: ['The family lock was reclaimed mid-create; refusing to create a run without it. Re-run.'] };
    }

    // RESERVE the run directory with a NON-recursive mkdir: EEXIST is the answer we
    // want. The open-run scan only blocks runs that are not terminal, so a caller
    // supplying `manifest.run_id` of an existing COMPLETE run would sail past it and
    // the atomic manifest write would replace that run's run.json — silently
    // destroying a retained run, which is the auto-deletion §10.2 forbids outright.
    // Reservation makes the id's uniqueness a filesystem fact rather than a promise
    // the caller keeps.
    const reserved = await reserveRunDir({ root: home.root, homeDir, runId });
    if (!reserved.ok) {
      return { created: false, reason: reserved.reason, run_id: null, blocking: [], diagnostics: [reserved.diagnostic] };
    }

    const write = await writeJsonAtomic({ root: home.root, path: bootstrapRunManifestFile(homeDir, runId), value });
    if (!write.ok) {
      // Roll the reservation back. The directory is one WE just created and, if the
      // manifest never landed, it is empty — leaving it would block every later plan
      // with a run that never existed. rmdir is non-recursive on purpose: it refuses a
      // non-empty directory, so this can only ever remove our own failed claim, never
      // an artifact. If it does not come off, the id is REPORTED so the operator can
      // abandon it rather than hunt for it.
      const rolledBack = await rmdir(bootstrapRunDir(homeDir, runId)).then(() => true).catch(() => false);
      return {
        created: false,
        reason: write.reason,
        run_id: rolledBack ? null : runId,
        blocking: [],
        diagnostics: rolledBack
          ? [write.diagnostic]
          : [write.diagnostic, `The reserved run directory ${machinePointer(homeDir, bootstrapRunDir(homeDir, runId))} could not be removed and will block the next plan; close it with \`abandon ${runId}\`.`],
      };
    }
    const latest = await writeLatestLocked({ root: home.root, homeDir, runId, status: 'open', updatedAt: startedAt, handle });
    if (!latest.ok) return { created: false, reason: latest.reason, run_id: runId, blocking: [], diagnostics: [latest.diagnostic] };

    return { created: true, reason: 'ok', run_id: runId, blocking: [], manifest: value, pointer: machinePointer(homeDir, bootstrapRunDir(homeDir, runId)), diagnostics: [] };
  });

  if (!result.ok) return { created: false, reason: result.reason, run_id: null, blocking: [], diagnostics: result.diagnostics };
  return { ...result.value, diagnostics: [...result.diagnostics, ...result.value.diagnostics] };
}

// Reserve <family>/<run-id>/ so the id cannot collide with an existing run. mkdir
// without `recursive` fails EEXIST on an existing directory — that failure IS the
// collision check, decided by the kernel rather than by a preceding read. The
// parents are created first (recursive, gated), so only the leaf is the claim.
async function reserveRunDir({ root, homeDir, runId }) {
  const parentGate = await ensureSecureDir({ root, path: bootstrapFamilyRoot(homeDir) });
  if (!parentGate.ok) return parentGate;
  const dir = bootstrapRunDir(homeDir, runId);
  const gate = await assertSecurePath({ root, path: dir });
  if (!gate.ok) return gate;
  try {
    await mkdir(dir, { recursive: false, mode: DIR_MODE });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return {
        ok: false,
        reason: 'run-id-exists',
        path: dir,
        diagnostic: `Run ${runId} already exists at ${machinePointer(homeDir, dir)}; refusing to overwrite a retained run. Runtime never deletes or replaces run artifacts.`,
      };
    }
    return { ok: false, reason: 'write-failed', path: dir, diagnostic: `Could not create ${machinePointer(homeDir, dir)}: ${err?.code ?? err?.message ?? String(err)}.` };
  }
  return { ok: true, reason: 'ok', path: dir, diagnostic: null };
}

// Close an open run (contract §10.2). Not a convenience: a crashed run leaves an
// open run behind, and without abandon one interrupted invocation would block the
// machine permanently.
//
// Idempotent on an already-terminal run — reports the existing status rather than
// rewriting it, because re-abandoning a `complete` run would destroy the record of
// a completion that actually happened.
export async function abandonBootstrapRun({ homeDir, repoRoot, runId, reason = 'operator abandoned the run', now, ...lockOptions }) {
  validateBootstrapRunId(runId);
  const nowMs = resolveNowMs(now);
  const at = new Date(nowMs).toISOString();

  const result = await withBootstrapFamilyLock({ homeDir, repoRoot, now, ...lockOptions }, async (handle) => {
    const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
    /* c8 ignore next */
    if (!home.ok) return { abandoned: false, reason: home.reason, run_id: runId, diagnostics: [home.diagnostic] };

    const manifestPath = bootstrapRunManifestFile(homeDir, runId);
    const read = await readJsonSafe(manifestPath);

    // A missing manifest is TWO different situations, and collapsing them would
    // build the permanent block §10.2 exists to prevent:
    //   - no run directory at all  → there is genuinely nothing to abandon;
    //   - a run directory with no manifest → a create that died between mkdir and
    //     the manifest rename. That run BLOCKS new plans (selectBlockingRuns counts
    //     an unreadable manifest), so if abandon called it 'run-missing' the machine
    //     would be blocked by a run its own recovery command refused to touch.
    let dirExists;
    try {
      dirExists = (await lstatOrNull(bootstrapRunDir(homeDir, runId))) !== null;
    } catch (err) {
      return { abandoned: false, reason: 'stat-failed', run_id: runId, diagnostics: [`Could not inspect run ${runId} (${err?.code ?? String(err)}); refusing to guess whether it exists.`] };
    }
    if (read.status === 'missing' && !dirExists) {
      return { abandoned: false, reason: 'run-missing', run_id: runId, diagnostics: [`No run ${runId} under ${machinePointer(homeDir, bootstrapFamilyRoot(homeDir))}.`] };
    }

    // An unreadable manifest is precisely the case abandon must still close — a run
    // whose body is corrupt is the one most likely to be blocking the machine. The
    // record is REPLACED rather than merged (there is nothing trustworthy to merge),
    // and it says so.
    //
    // A PARSEABLE-but-schema-INVALID manifest is the same case wearing JSON (ADR-0048
    // §3 read-boundary finding): it can never prove itself terminal (scan refuses to,
    // above), so honoring its `status: "complete"` here with `already-terminal` would
    // leave a permanently blocking run its own recovery command refuses to touch.
    // Only a schema-valid record is trusted for the already-terminal refusal or the
    // merge; an invalid one is replaced by the fresh tombstone, and the history row
    // says why.
    const parsed = read.status === 'ok' && read.value && typeof read.value === 'object' ? read.value : null;
    const parsedValid = parsed ? (await runManifestValidator())(parsed).ok : false;
    const previous = parsedValid ? parsed : null;
    if (previous && BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(previous.status)) {
      return { abandoned: false, reason: 'already-terminal', run_id: runId, status: previous.status, diagnostics: [`Run ${runId} is already ${previous.status}; leaving it as recorded.`] };
    }

    const replacedWhy = parsed && !parsedValid ? 'schema-invalid' : read.status;
    const value = previous
      ? {
          ...previous,
          status: 'abandoned',
          updated_at: at,
          history: [...(Array.isArray(previous.history) ? previous.history : []), { step_id: null, from: previous.status ?? 'open', to: 'abandoned', reason, at }],
        }
      : {
          schema: BOOTSTRAP_RUN_SCHEMA_VERSION,
          run_id: runId,
          started_at: at,
          updated_at: at,
          status: 'abandoned',
          // The recovery tombstone must ITSELF validate against the run schema (peer
          // finding): schema-required selection/boundary were omitted, so replacing a
          // corrupt manifest wrote a record every schema-aware reader rejects — a
          // recovery that manufactures the next unreadable run. `custom`+empty is the
          // honest selection for a run whose real selection is unrecoverable, and the
          // boundary is the §5 all-false invariant this writer honors anyway.
          selection: { bundle: 'custom', desired: [], excluded: [] },
          history: [{ step_id: null, from: 'unknown', to: 'abandoned', reason: `${reason} (manifest was ${replacedWhy}; the previous record could not be trusted and was replaced)`, at }],
          steps: [],
          boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
        };

    // Re-prove ownership before the manifest rewrite, on the same grounds as create:
    // the read-then-decide above is a check half.
    if (!(await handle.assertOwned())) {
      return { abandoned: false, reason: 'lock-lost', run_id: runId, diagnostics: ['The family lock was reclaimed mid-abandon; refusing to rewrite the run record without it. Re-run.'] };
    }

    const write = await writeJsonAtomic({ root: home.root, path: manifestPath, value });
    if (!write.ok) return { abandoned: false, reason: write.reason, run_id: runId, diagnostics: [write.diagnostic] };

    // The pointer update is a SECOND durable effect and can fail on its own. Reporting
    // `abandoned: true` while latest.json still advertises this run as open would tell
    // the operator the machine is unblocked when their next `plan` will disagree — so
    // the partial outcome is surfaced, not swallowed.
    const diagnostics = previous === null
      ? [`Run ${runId} had an unreadable manifest (${read.status}); it was replaced with an abandoned record so a new plan can proceed.`]
      : [];
    const latest = await readBootstrapLatest({ homeDir });
    diagnostics.push(...latest.diagnostics);
    let pointerUpdated = null;
    if (latest.status === 'blocked') {
      // We cannot tell whether latest.json still advertises this run as open, so we
      // must not imply we reconciled it.
      pointerUpdated = false;
      diagnostics.push('The run was recorded as abandoned, but the latest.json pointer could not be read, so its state is unknown. Re-run once the family is readable to reconcile it.');
    } else if (latest.run_id === runId) {
      const latestWrite = await writeLatestLocked({ root: home.root, homeDir, runId, status: 'abandoned', updatedAt: at, handle });
      pointerUpdated = latestWrite.ok;
      if (!latestWrite.ok) {
        diagnostics.push(`The run was recorded as abandoned, but the latest.json pointer still shows it as open (${latestWrite.diagnostic}). Re-run to reconcile the pointer.`);
      }
    }
    return {
      abandoned: true,
      reason: pointerUpdated === false ? 'partial-pointer-not-updated' : 'ok',
      run_id: runId,
      status: 'abandoned',
      pointer_updated: pointerUpdated,
      recovered_unreadable: previous === null,
      diagnostics,
    };
  });

  if (!result.ok) return { abandoned: false, reason: result.reason, run_id: runId, diagnostics: result.diagnostics };
  return { ...result.value, diagnostics: [...result.diagnostics, ...result.value.diagnostics] };
}

// Rewrite an OPEN run's manifest under the family lock (contract §3 — `resume` and
// `profile seed` are the M1 verbs that persist invalidation stamps, step
// transitions, choices, and seeded defaults). The mutation is a caller-supplied
// pure function over a deep copy of the previous manifest; `updated_at` is stamped
// here so no caller can forget it, and a terminal run is refused rather than
// silently reopened — `abandon` is the only verb that may rewrite a non-open run,
// and even it refuses a terminal one.
export async function updateBootstrapRun({ homeDir, repoRoot, runId, mutate, validate = null, now, ...lockOptions }) {
  validateBootstrapRunId(runId);
  if (typeof mutate !== 'function') throw new Error('updateBootstrapRun requires a mutate(manifest) function');
  const nowMs = resolveNowMs(now);
  const at = new Date(nowMs).toISOString();

  const result = await withBootstrapFamilyLock({ homeDir, repoRoot, now, ...lockOptions }, async (handle) => {
    const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
    /* c8 ignore next */
    if (!home.ok) return { updated: false, reason: home.reason, run_id: runId, manifest: null, diagnostics: [home.diagnostic] };

    const manifestPath = bootstrapRunManifestFile(homeDir, runId);
    const read = await readJsonSafe(manifestPath);
    if (read.status !== 'ok' || !read.value || typeof read.value !== 'object') {
      return {
        updated: false,
        reason: read.status === 'missing' ? 'run-missing' : 'manifest-unreadable',
        run_id: runId,
        manifest: null,
        diagnostics: [
          read.status === 'missing'
            ? `No run ${runId} under ${machinePointer(homeDir, bootstrapFamilyRoot(homeDir))}.`
            : `Run ${runId} has an unreadable manifest (${read.status}); it cannot be updated. Close it with \`abandon ${runId}\` and start a new plan.`,
        ],
      };
    }
    const previous = read.value;
    if (BOOTSTRAP_TERMINAL_RUN_STATUSES.includes(previous.status)) {
      return { updated: false, reason: 'already-terminal', run_id: runId, status: previous.status, manifest: null, diagnostics: [`Run ${runId} is already ${previous.status}; a terminal run is never rewritten.`] };
    }
    // ADR-0048 §3 — the locked read is a trust boundary too: when the caller
    // supplied a validator, the PREVIOUS record must pass it before mutate sees
    // it. Post-mutation validation alone lets a mutate that spreads `...previous`
    // launder an invalid field forward whenever the mutation happens to shadow
    // the invalid part with a valid one — the write would then bless a record
    // nobody ever validated whole. An invalid previous is an abandon case, not
    // an update case.
    if (validate) {
      const previousVerdict = validate(previous);
      if (!previousVerdict?.ok) {
        return { updated: false, reason: 'previous-invalid', run_id: runId, manifest: null, diagnostics: [`Run ${runId} has a schema-invalid manifest; it cannot be updated. Close it with \`abandon ${runId}\` and start a new plan.`, ...(previousVerdict?.errors ?? []).slice(0, 5)] };
      }
    }

    const next = mutate(structuredClone(previous));
    if (!next || typeof next !== 'object') {
      return { updated: false, reason: 'mutate-returned-nothing', run_id: runId, manifest: null, diagnostics: ['The update produced no manifest; refusing to write nothing over a run record.'] };
    }
    const value = { ...next, run_id: runId, updated_at: at };
    if (validate) {
      const verdict = validate(value);
      if (!verdict?.ok) {
        return { updated: false, reason: 'invalid-manifest', run_id: runId, manifest: null, diagnostics: verdict?.errors ?? ['The updated run manifest failed validation; refusing to write it.'] };
      }
    }

    if (!(await handle.assertOwned())) {
      return { updated: false, reason: 'lock-lost', run_id: runId, manifest: null, diagnostics: ['The family lock was reclaimed mid-update; refusing to rewrite the run record without it. Re-run.'] };
    }
    const write = await writeJsonAtomic({ root: home.root, path: manifestPath, value });
    if (!write.ok) return { updated: false, reason: write.reason, run_id: runId, manifest: null, diagnostics: [write.diagnostic] };

    const diagnostics = [];
    const latest = await readBootstrapLatest({ homeDir });
    if (latest.status !== 'blocked' && latest.run_id === runId && typeof value.status === 'string' && BOOTSTRAP_RUN_STATUSES.includes(value.status)) {
      const latestWrite = await writeLatestLocked({ root: home.root, homeDir, runId, status: value.status, updatedAt: at, handle });
      if (!latestWrite.ok) diagnostics.push(`The run was updated, but the latest.json pointer could not be refreshed (${latestWrite.diagnostic}).`);
    }
    return { updated: true, reason: 'ok', run_id: runId, manifest: value, diagnostics };
  });

  if (!result.ok) return { updated: false, reason: result.reason, run_id: runId, manifest: null, diagnostics: result.diagnostics };
  return { ...result.value, diagnostics: [...result.diagnostics, ...result.value.diagnostics] };
}

// ---------------------------------------------------------------------------
// Fragment + proof writers
// ---------------------------------------------------------------------------

// A fragment/proof write must land INSIDE a run that already exists. Without this the
// writers are a blocker factory: their `mkdir -p` happily creates
// `<family>/<run-id>/fragments/` for any well-formed id, and a manifest-less run
// directory blocks EVERY subsequent plan (selectBlockingRuns cannot prove it
// terminal). One caller typo would then wedge the machine until someone abandoned a
// run that never existed.
async function requireExistingRun({ homeDir, runId }) {
  const read = await readJsonSafe(bootstrapRunManifestFile(homeDir, runId));
  if (read.status === 'missing') {
    return {
      ok: false,
      reason: 'run-missing',
      status: null,
      diagnostic: `No run ${runId} under ${machinePointer(homeDir, bootstrapFamilyRoot(homeDir))}; create the run before writing into it. Runtime does not conjure a run directory from a write.`,
    };
  }
  // Surface the manifest's recognized status (or null for unreadable/unrecognized)
  // so the proof writer can apply its open-run gate. Membership-checked, not
  // trusted further — reduction-grade validation is the read boundary's job.
  const status = read.status === 'ok' && BOOTSTRAP_RUN_STATUSES.includes(read.value?.status) ? read.value.status : null;
  return { ok: true, reason: 'ok', status, manifest: read.status === 'ok' ? read.value : null, diagnostic: null };
}

// Persist a rendered host-config fragment and return the METADATA the run manifest
// carries (pointer, hash, bytes) — never the body. The fragment is an artifact
// DESCRIBING an edit; ADR-0041 §2c is why bootstrap renders it here instead of
// applying it. `name` is validated on the profile charset for the same reason
// --name is: it becomes a path component.
export async function writeBootstrapFragment({ homeDir, repoRoot, runId, name, content }) {
  validateBootstrapRunId(runId);
  validateProfileName(name);
  const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
  if (!home.ok) return { ok: false, reason: home.reason, diagnostics: [home.diagnostic], fragment: null };

  const exists = await requireExistingRun({ homeDir, runId });
  if (!exists.ok) return { ok: false, reason: exists.reason, diagnostics: [exists.diagnostic], fragment: null };

  const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  // Fragments render host-config EDITS, never credentials — the same
  // scrub-before-write fail-close every bootstrap artifact writer carries
  // (Codex review MAJOR: this writer had none).
  if (scrubSecrets(text) !== text) {
    return { ok: false, reason: 'secret-shaped-content', diagnostics: [`Fragment ${name} contains secret-shaped content; refusing to persist it.`], fragment: null };
  }
  const path = join(bootstrapFragmentsDir(homeDir, runId), `${name}.fragment`);
  const write = await writeFileAtomic({ root: home.root, path, text });
  if (!write.ok) return { ok: false, reason: write.reason, diagnostics: [write.diagnostic], fragment: null };

  return {
    ok: true,
    reason: 'ok',
    diagnostics: [],
    fragment: { name, pointer: machinePointer(homeDir, path), sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') },
  };
}

// Persist proof METADATA (contract §8.2) — hashes, byte counts, bound versions,
// direction results. Never raw peer output or prompt text: that is the doctor-proof
// rule this home inherits, and the reason a proof is evidence you can publish.
//
// Validation is MANDATORY and internal (ADR-0048 §3): the pre-1.2 shape took an
// optional injected `validate` that both production callers omitted, so proof
// evidence landed on disk unvalidated. The kind→$def binding now lives in
// lib/evidence-contract.mjs and there is no parameter to forget — a record that
// fails its family's structural def OR its kind-discriminated shape is refused.
//
// Three more gates, in refusal order:
//   - unknown-evidence-kind — the kind must be in EVIDENCE_FAMILIES; the old
//     path-charset check let any well-formed name become a proof file;
//   - run-not-open — evidence lands only in an OPEN run. Terminal evidence is
//     immutable history (§7); the single exception is the D0.1 receipt
//     attestation (postTerminalWritable) into a complete/configured-not-verified
//     run — never into an abandoned one;
//   - secret-shaped-content — the serialized record must survive scrubSecrets
//     unchanged (ADR-0048 §4 scrub-before-write; same fail-closed pattern as
//     the egress launcher plan). A proof that trips it is refused, not
//     laundered: a scrubbed-then-written record would hash differently than
//     what the caller believes it recorded.
export async function writeBootstrapProof({ homeDir, repoRoot, runId, kind, record }) {
  validateBootstrapRunId(runId);
  validateProfileName(kind);
  const family = EVIDENCE_FAMILIES[kind];
  if (!family) {
    return { ok: false, reason: 'unknown-evidence-kind', diagnostics: [`"${kind}" is not an evidence kind this contract knows (${EVIDENCE_KINDS.join(', ')}); refusing to write an unclassifiable proof file.`], proof: null };
  }
  const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
  if (!home.ok) return { ok: false, reason: home.reason, diagnostics: [home.diagnostic], proof: null };

  const exists = await requireExistingRun({ homeDir, runId });
  if (!exists.ok) return { ok: false, reason: exists.reason, diagnostics: [exists.diagnostic], proof: null };
  const runStatus = exists.status;
  if (runStatus !== 'open') {
    const terminalButAttestable = family.postTerminalWritable && BOOTSTRAP_COMPLETION_RUN_STATUSES.includes(runStatus);
    if (!terminalButAttestable) {
      return {
        ok: false,
        reason: 'run-not-open',
        diagnostics: [`Run ${runId} is ${runStatus ?? 'in an unknown state'} — evidence writes land only in an open run (terminal evidence is immutable history, §7${family.postTerminalWritable ? '' : `; only the receipt attestation may append to a completed run, and "${kind}" is not it`}).`],
        proof: null,
      };
    }
    // The post-terminal window is the NARROWEST door in this writer, so it
    // carries the strictest gate (Codex review MAJOR): the terminal manifest
    // must be schema-valid AND current-schema — a status string alone let a
    // receipt land inside a schema-invalid or legacy record whose verdict
    // machinery cannot even read it.
    const manifestVerdict = exists.manifest ? (await runManifestValidator())(exists.manifest) : { ok: false, errors: ['manifest unreadable'] };
    if (!manifestVerdict.ok || exists.manifest?.schema !== BOOTSTRAP_RUN_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: 'run-not-attestable',
        diagnostics: [`Run ${runId} is terminal but ${manifestVerdict.ok ? `carries schema ${exists.manifest?.schema}, not ${BOOTSTRAP_RUN_SCHEMA_VERSION} — receipt testimony is current-schema vocabulary` : `its manifest is schema-invalid (${manifestVerdict.errors.slice(0, 3).join('; ')})`}; refusing the receipt append.`],
        proof: null,
      };
    }
  }

  // SERIALIZE ONCE, SCRUB FIRST, VALIDATE THE PARSED BYTES, WRITE THE SAME
  // BYTES (Codex review MAJOR). The earlier shape validated the live object,
  // scrubbed one serialization, then re-serialized for the write — a stateful
  // toJSON could show the scrub safe content and hand the write something
  // else, and a validation error raised BEFORE the scrub could echo a
  // secret-shaped value through its diagnostics. Exactly one text exists now:
  // it is scrubbed, parsed, validated, hashed, and written.
  let text;
  try {
    text = `${JSON.stringify(record, null, 2)}\n`;
  } catch (err) {
    return { ok: false, reason: 'unserializable', diagnostics: ['The proof record is not serializable as JSON (the serializer\'s message is withheld because it names document-supplied keys — §3.2).'], proof: null };
  }
  if (scrubSecrets(text) !== text) {
    return { ok: false, reason: 'secret-shaped-content', diagnostics: ['The serialized proof record contains secret-shaped content (token/bearer/credential-URL pattern); refusing to persist it. Evidence carries hashes and enum results, never credentials.'], proof: null };
  }
  const parsed = JSON.parse(text);
  const verdict = await validateEvidenceRecord({ kind, record: parsed });
  if (!verdict.ok) return { ok: false, reason: 'invalid-proof', diagnostics: verdict.errors, proof: null };

  const path = join(bootstrapProofDir(homeDir, runId), `${kind}.json`);
  const write = await writeFileAtomic({ root: home.root, path, text });
  if (!write.ok) return { ok: false, reason: write.reason, diagnostics: [write.diagnostic], proof: null };

  return {
    ok: true,
    reason: 'ok',
    diagnostics: [],
    proof: { kind, pointer: machinePointer(homeDir, path), sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') },
  };
}

// A recorded evidence file may not exceed this. Proof records are hashes, enums
// and version maps — a proof/ file anywhere near this bound is not a proof
// record, it is something else wearing the filename (the same 128 KiB bound the
// CLI applies to operator-supplied answer/profile files).
export const PROOF_FILE_MAX_BYTES = 128 * 1024;

/**
 * Read the run's RECORDED evidence back from proof/ (ADR-0048 §3).
 *
 * This is the read half the 1.1 lifecycle never had: proof files were
 * write-only, so re-judgement consumed the manifest's REDUCED
 * `completion.proofs` — a shape that has no `directions` — and a once-passed
 * proof demoted to `absent` on the very next resume/verify. The recorded
 * files are the authoritative evidence; the manifest's completion is a cached
 * reduction over them.
 *
 * Fail-closed and all-or-nothing: every entry must be a regular file named
 * `<known-kind>.json`, within the size bound, parseable, and valid under the
 * kind's structural def + discriminator (filename↔embedded-kind equality
 * included). ONE bad file fails the whole read — partial acceptance would
 * silently hide tampered or corrupt evidence behind the valid remainder.
 * Errors name the rule, and name the FILE only when its name is one this
 * runtime defined (`<kind>.json` for a known evidence kind). An unrecognized
 * entry name is free content that arrived from the filesystem, so it is located
 * by ordinal instead (D1 §3.2) — quoting it back is how a file named after a
 * credential publishes itself. A missing proof/
 * directory is simply "no evidence yet" (ok, empty).
 *
 * Each returned row carries the file's own sha256 (over the exact stored
 * bytes) — the hash writeBootstrapProof returned at write time, re-derived —
 * so a receipt attestation's `provider_proof_artifact_hash` link can be
 * verified byte-for-byte, and any consumer can detect a swapped record.
 */
export async function readBootstrapProofRecords({ homeDir, runId }) {
  validateBootstrapRunId(runId);
  const dir = bootstrapProofDir(homeDir, runId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { ok: true, errors: [], records: [] };
    return { ok: false, errors: [`proof directory unreadable (${err?.code ?? String(err)})`], records: null };
  }

  const errors = [];
  const records = [];
  const seen = new Set();
  let ordinal = -1;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    ordinal += 1;
    // D1 §3.2 — a directory ENTRY NAME is not clamped by anything. The
    // evidence kinds are a closed set, so `<kind>.json` is a name this runtime
    // itself defined and may be quoted; every other name is free content that
    // arrived from the filesystem, and quoting it published it. `Bearer
    // sk-….json` in the proof directory used to render its own filename back
    // out through these diagnostics. Unrecognized entries are located by
    // ordinal and described by the rule they broke.
    const recognized = name.endsWith('.json') && EVIDENCE_KINDS.includes(name.slice(0, -'.json'.length));
    const label = recognized ? name : `entry[${ordinal}]`;
    if (!entry.isFile()) {
      errors.push(`${label}: not a regular file (symlinks and directories are not evidence)`);
      continue;
    }
    if (!name.endsWith('.json')) {
      errors.push(`${label}: not a .json evidence file`);
      continue;
    }
    const kind = name.slice(0, -'.json'.length);
    if (!EVIDENCE_KINDS.includes(kind)) {
      // The offending stem is withheld; the EXPECTED vocabulary is named
      // instead, which is what an operator needs to rename the file.
      errors.push(`${label}: unknown evidence kind — expected one of ${EVIDENCE_KINDS.join(', ')}`);
      continue;
    }
    /* c8 ignore next 4 — one filename per kind by construction; kept as a tripwire */
    if (seen.has(kind)) {
      errors.push(`${label}: duplicate evidence kind "${kind}"`);
      continue;
    }
    seen.add(kind);
    const path = join(dir, name);
    let stat;
    try {
      stat = await lstatOrNull(path);
    } catch (err) {
      errors.push(`${label}: could not stat (${err?.code ?? String(err)})`);
      continue;
    }
    if (!stat?.isFile()) {
      errors.push(`${label}: not a regular file at read time`);
      continue;
    }
    if (stat.size > PROOF_FILE_MAX_BYTES) {
      errors.push(`${label}: ${stat.size} bytes exceeds the ${PROOF_FILE_MAX_BYTES}-byte evidence bound`);
      continue;
    }
    // READ side, so the file's BYTES are the source of truth — unlike the
    // write side above, where the string is what gets encoded and hashing it
    // is exact. Reading with `'utf8'` and hashing the decoded string mapped
    // every invalid byte sequence to U+FFFD, so this returned a digest and a
    // byte count for a re-encoding rather than for the file. Measured: 386
    // reported for a 384-byte record, and a sha256 that does not match the
    // file's (cross-host review). The docstring above promises a
    // `provider_proof_artifact_hash` link verifiable byte-for-byte; this is
    // what makes that true.
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (err) {
      errors.push(`${label}: unreadable (${err?.code ?? String(err)})`);
      continue;
    }
    const text = bytes.toString('utf8');
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      errors.push(`${label}: not valid JSON`);
      continue;
    }
    const verdict = await validateEvidenceRecord({ kind, record });
    if (!verdict.ok) {
      errors.push(`${label}: ${verdict.errors.join('; ')}`);
      continue;
    }
    records.push({ kind, record, sha256: sha256(bytes), bytes: bytes.byteLength, pointer: machinePointer(homeDir, path) });
  }

  if (errors.length > 0) return { ok: false, errors, records: null };
  return { ok: true, errors: [], records };
}

// ---------------------------------------------------------------------------
// Profile store
// ---------------------------------------------------------------------------

// Write a portable machine profile. Takes the family lock so an --overwrite cannot
// interleave with a concurrent read (contract §10.2).
//
// #30 — an existing name without `overwrite` is REFUSED. The refusal is a
// check-then-write under the lock, which is what makes it a real guard rather than
// a suggestion; the lock is the same one run creation takes, so a profile write and
// a plan cannot interleave either.
export async function writeMachineProfile({ homeDir, repoRoot, name, profile, overwrite = false, validate = null, now, ...lockOptions }) {
  validateProfileName(name);
  const result = await withBootstrapFamilyLock({ homeDir, repoRoot, now, ...lockOptions }, async (handle) => {
    const home = await resolveMachineArtifactHome({ homeDir, repoRoot });
    /* c8 ignore next */
    if (!home.ok) return { written: false, reason: home.reason, name, diagnostics: [home.diagnostic] };

    const path = profileFile(homeDir, name);
    let existing;
    try {
      existing = await lstatOrNull(path);
    } catch (err) {
      // Fail CLOSED: an unreadable target must never be mistaken for an absent one,
      // or the --overwrite guard silently becomes an overwrite.
      return { written: false, reason: 'stat-failed', name, diagnostics: [`Could not inspect ${machinePointer(homeDir, path)} (${err?.code ?? String(err)}); refusing to write without knowing whether a profile is already there.`] };
    }
    if (existing !== null && !overwrite) {
      return {
        written: false,
        reason: 'exists',
        name,
        pointer: machinePointer(homeDir, path),
        diagnostics: [`Profile '${name}' already exists at ${machinePointer(homeDir, path)}. Re-run with --overwrite to replace it; profiles are never replaced implicitly.`],
      };
    }
    if (validate) {
      const verdict = validate(profile);
      if (!verdict?.ok) return { written: false, reason: 'invalid-profile', name, diagnostics: verdict?.errors ?? ['The profile failed validation; refusing to write it.'] };
    }

    // The exists-check above is the check half of a check-then-write; re-prove
    // ownership before the write so a lock reclaimed in between cannot turn an
    // `overwrite: false` refusal into an overwrite of a profile another process
    // created while we were dispossessed.
    if (!(await handle.assertOwned())) {
      return { written: false, reason: 'lock-lost', name, diagnostics: ['The family lock was reclaimed mid-write; refusing to write the profile without it. Re-run.'] };
    }

    const write = await writeJsonAtomic({ root: home.root, path, value: profile });
    if (!write.ok) return { written: false, reason: write.reason, name, diagnostics: [write.diagnostic] };
    const text = `${JSON.stringify(profile, null, 2)}\n`;
    return {
      written: true,
      reason: 'ok',
      name,
      replaced: existing !== null,
      pointer: machinePointer(homeDir, path),
      sha256: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      diagnostics: [],
    };
  });

  if (!result.ok) return { written: false, reason: result.reason, name, diagnostics: result.diagnostics };
  return { ...result.value, diagnostics: [...result.diagnostics, ...result.value.diagnostics] };
}

// Read a profile by name. Read-only, no lock: a torn read is impossible because
// every write lands by rename.
export async function readMachineProfile({ homeDir, name }) {
  validateProfileName(name);
  const path = profileFile(homeDir, name);
  const gate = await assertSecurePath({ root: machineGlobalRoot(homeDir), path });
  if (!gate.ok) return { status: 'refused', reason: gate.reason, name, profile: null, diagnostics: [gate.diagnostic] };
  const read = await readJsonSafe(path);
  return {
    status: read.status === 'ok' ? 'available' : read.status === 'missing' ? 'missing' : 'malformed',
    reason: read.status,
    name,
    pointer: machinePointer(homeDir, path),
    profile: read.value,
    diagnostics: read.status === 'invalid_json' ? [`Profile '${name}' at ${machinePointer(homeDir, path)} is not valid JSON.`] : [],
  };
}

// List profiles — metadata only, never bodies. Profiles are retention-EXEMPT
// (artifact-policy.md §Retention), so this reports no pressure at any count.
export async function listMachineProfiles({ homeDir }) {
  const root = profilesRoot(homeDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err?.code ?? '') === 'ENOENT';
    return { status: missing ? 'missing' : 'blocked', root: machinePointer(homeDir, root), pointer: machinePointer(homeDir, root), profiles: [], error: missing ? null : (err?.code ?? String(err)) };
  }
  const profiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((name) => isValidProfileName(name))
    .sort()
    .map((name) => ({ name, pointer: machinePointer(homeDir, join(root, `${name}.json`)) }));
  return { status: 'available', root: machinePointer(homeDir, root), pointer: machinePointer(homeDir, root), profiles, error: null };
}

// ---------------------------------------------------------------------------
// Retention (report-only)
// ---------------------------------------------------------------------------

// Report retention pressure past the cap. REPORT-ONLY, by contract (§10.2) and by
// the repo-wide no-silent-destructive posture: nothing here deletes, and the
// operator is told exactly which run directories are the overflow so their own
// deletion is an informed one rather than a guess.
export async function reportBootstrapRetention({ homeDir, cap = BOOTSTRAP_RETENTION_CAP }) {
  const scan = await scanBootstrapRuns({ homeDir });
  if (scan.status !== 'available') return { status: scan.status, cap, run_count: 0, over_cap: 0, pressure: [], diagnostics: [] };
  const overflow = scan.runs.slice(cap);
  return {
    status: overflow.length > 0 ? 'needs_attention' : 'available',
    cap,
    run_count: scan.runs.length,
    over_cap: overflow.length,
    pressure: overflow.map((run) => ({ run_id: run.run_id, status: run.status, pointer: run.pointer })),
    diagnostics: overflow.length > 0
      ? [`${scan.runs.length} bootstrap runs exceed the retention cap of ${cap}. The ${overflow.length} oldest are listed as pressure; runtime never deletes them.`]
      : [],
  };
}
