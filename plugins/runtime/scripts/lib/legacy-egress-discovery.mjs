// plugins/runtime/scripts/lib/legacy-egress-discovery.mjs
//
// ADR-0048 residual (d): cross-checkout discovery of PRE-UPGRADE, repo-scoped
// egress intent WALs.
//
// The problem this closes. The egress intent WAL used to live under the repo
// (`<checkout>/.agentic-plugins/runs/doctor/egress-intents/`) and now lives once
// per machine under `$HOME`. `doctor.mjs` already refuses to send while a legacy
// WAL sits in the CURRENT checkout — but the old runtime could have sent from a
// DIFFERENT checkout, and that one's records are invisible to a same-checkout
// scan. An upgrade that resumes the machine-global run from another checkout
// could therefore still re-send to the operator's phone.
//
// What this is, exactly:
//
//   READ-ONLY. It writes no artifact and spawns no subprocess. Those are not
//   preferences — they are the two conditions that keep this an ADR-0035 §2 R0
//   surface (`:111`). Writing a completion/report artifact would make it M1;
//   shelling out to `find` would need capability/argv registry work. Neither is
//   worth it for a one-time inventory.
//
//   AN INVENTORY, NOT AN ACTION. It never moves, never removes, never generates
//   a shell command, and never advises directory-level deletion. The guidance is
//   uniform and cautious for EVERY location it reports — see GUIDANCE below for
//   why "verify the phone, then delete" (the wording the residual itself used)
//   is unsafe.
//
// Three design decisions worth stating because the obvious alternatives are
// wrong:
//
//  1. It hunts the `.agentic-plugins` MARKER and then `stat`s the fixed
//     four-component remainder, rather than walking to full depth looking for the
//     leaf. Measured on the dogfood machine: a full-depth `$HOME` walk is not
//     viable (depth 5 = 81,173 dirs / 14.9s; depth 8 did not finish in 120s;
//     pruning `node_modules`/`.git`/`Library` cut 48% and did not rescue depth 8).
//     Real checkout markers sit at depth 3 from `$HOME` here.
//
//  2. It streams with `opendir`, never `readdir`. A cap cannot act on a listing
//     that has already been materialized — the same correction
//     `entry-brief-readers.mjs:152` carries.
//
//  3. Identity is dev/ino, never spelling. The live machine-global WAL is the
//     ONE exclusion, and a scanner that mistook it for clearable legacy state
//     would hand the operator the fence whose removal re-opens the duplicate
//     send. That defect shipped once already, by string comparison, and is why
//     `sameDirectory` exists.

import { opendir as defaultOpendir, realpath as defaultRealpath, stat as defaultStat } from 'node:fs/promises';
import { homedir as defaultHomedir, hostname as defaultHostname } from 'node:os';
import { join } from 'node:path';

import { EGRESS_INTENT_DIR_SUFFIX, egressIntentDir, safeOperatorText, safeRecordName } from './egress-intent-wal.mjs';
import { isUnder, sameDirectory } from './path-containment.mjs';
import { RUNTIME_VERSION } from '../version.mjs';

export const LEGACY_EGRESS_DISCOVERY_SCHEMA = 'legacy-egress-discovery-1.0';

// The directory whose presence marks a checkout root. It is the first component
// of EGRESS_INTENT_DIR_SUFFIX by construction, not by coincidence — deriving it
// keeps the hunt and the stat from drifting apart.
export const CHECKOUT_MARKER = EGRESS_INTENT_DIR_SUFFIX[0];
const MARKER_REMAINDER = EGRESS_INTENT_DIR_SUFFIX.slice(1);

// Names never descended into. Both are enormous and neither can contain a
// checkout marker that matters: a `.git` directory holds no working tree, and a
// `node_modules` copy of this repo is a dependency, not a checkout an operator
// ran a proof from. Every prune is REPORTED, so this is a stated boundary
// rather than a silent cap.
const PRUNE_DIR_NAMES = new Set(['node_modules', '.git']);

// MEASURED on the dogfood machine (macOS/APFS, `$HOME`, marker-hunt walk with
// `~/mnt` — a remote mount — excluded, since including it costs 92s on its own):
//
//   prune            depth   wall     dirs      markers found
//   node_modules,.git    4    3.6s    13,313    7
//   node_modules,.git    5   35.7s    69,792    9
//   node_modules,.git    6   71.6s   148,399    9
//   + Library            6   28.9s   113,256    9
//   + Library            8   45.0s   184,378    9
//
// Two things that table settles, and one it does not:
//
//   The 20s budget the plan proposed is not viable. The default configuration
//   costs 71.6s here, so 20s would report `incomplete` on EVERY run and the
//   command would never get far enough to find anything. 120s is chosen against
//   the measured default, not as a round number.
//
//   Depth beyond 5 buys nothing on this machine — 5, 6 and 8 all find the same
//   9 markers. 6 is kept anyway: it is the reviewed value, it costs only time
//   (never correctness), and one machine's nesting habits are not a contract.
//
//   What it does NOT settle is whether `Library` belongs in the default prune
//   set. It halves the cost, but it is a macOS-specific NAME and pruning it is a
//   coverage decision taken on every user's behalf. `--skip` is the explicit
//   lever instead, and every prune is reported either way.
export const DEFAULT_DISCOVERY_CAPS = Object.freeze({
  maxDepth: 6,
  maxEntriesPerDir: 4096,
  maxDirs: 200000,
  timeBudgetMs: 120000,
});

// How many entries of each completeness bucket are LISTED. The totals are always
// reported alongside, so this bounds the output without hiding a cap — a
// depth-capped `$HOME` walk produced 60,405 entries in one measurement, and a
// report nobody can read is not a report.
export const MAX_REPORTED_PER_BUCKET = 50;

// The three statuses. `no_findings_in_scanned_scope` is deliberately NOT called
// "clean": plain "clean" implies a durability this scan cannot give, because
// checkouts outside the scanned roots are an irreducible residual.
export const DISCOVERY_STATUS = Object.freeze({
  none: 'no_findings_in_scanned_scope',
  findings: 'findings_present',
  incomplete: 'incomplete',
});

// Exit codes. `incomplete` is 1 — the fail-closed signal — so a `set -e` script
// stops rather than reading an un-finished scan as an inventory.
export const DISCOVERY_EXIT_CODES = Object.freeze({
  [DISCOVERY_STATUS.none]: 0,
  [DISCOVERY_STATUS.incomplete]: 1,
  [DISCOVERY_STATUS.findings]: 2,
});

// ---------------------------------------------------------------------------
// T4 — status, total over its INPUT
// ---------------------------------------------------------------------------

// Decide the report status.
//
// TOTAL OVER ITS INPUT, not over its own enum — the distinction this repo has
// already shipped wrong twice (`doctor.mjs:3783` records the second). Every
// argument is re-validated here rather than trusted: `scan_complete` is checked
// with STRICT equality, so the string `"false"`, `undefined`, `null`, `0` and a
// number all fail closed; `blocked` and `findings` must be real arrays, so a
// caller that passed an object or forgot a field cannot produce a clean status
// by omission.
//
// The asymmetry is the point. Only ONE combination yields the reassuring
// answer; anything unrecognized yields `incomplete`.
export function resolveDiscoveryStatus({ scanComplete, blocked, findings } = {}) {
  if (scanComplete !== true) return DISCOVERY_STATUS.incomplete;
  if (!Array.isArray(blocked) || blocked.length > 0) return DISCOVERY_STATUS.incomplete;
  if (!Array.isArray(findings)) return DISCOVERY_STATUS.incomplete;
  return findings.length === 0 ? DISCOVERY_STATUS.none : DISCOVERY_STATUS.findings;
}

// ---------------------------------------------------------------------------
// T6 — the guidance contract
// ---------------------------------------------------------------------------

// Why this is not "check the phone, then delete", which is what ADR-0048's own
// residual text proposed:
//
// A pre-upgrade pending record may carry NO pid, and this runtime deliberately
// reads a missing process identity as UNKNOWN rather than dead
// (`doctor.mjs` classifyClaimHolder). So an older sender may still be running.
// A flat delete instruction frees the fence's name while a message is in
// flight, and the next attempt sends a second one to the same phone — the exact
// duplicate this WAL exists to prevent. Directory-level removal is worse again:
// it takes records this scan never examined and never read.
//
// So the guidance is uniform for every location, and its unit is the individual
// REVIEWED record. The directory is never the unit to act on.
export const GUIDANCE = Object.freeze({
  // No removal verb appears here, at all. When the scan did not complete, the
  // report is not an inventory, and an operator acting on a partial list may act
  // on the wrong thing — or believe the locations NOT listed are absent.
  incomplete: 'This scan did not complete, so it is not an inventory: entries under scan.blocked were intended to be examined and could not be. Resolve them and run the discovery again before acting on anything below.',
  findings: 'Each location below may hold an attempt that already reached the phone, and the pre-upgrade format records no process identity, so an older sender may still be running. For each one: make sure no older proof is running, check the phone, then manually remove the specific records you reviewed. The directory itself is never the unit to act on, and neither are records this scan did not list.',
  none: 'No legacy egress intent location was found under the scanned roots. This is not a statement about the whole machine — see residual.',
});

// ---------------------------------------------------------------------------
// T2 — roots: canonical, deduped by identity, provenance retained
// ---------------------------------------------------------------------------

// Resolve the roots to scan.
//
// `--root` REPLACES `$HOME` rather than adding to it. Stated because both
// readings are defensible and the other one silently triples the scan an
// operator asked to narrow.
//
// A root the operator NAMED and that is missing is `blocked`, never silently
// skipped: "I could not look there" and "there is nothing there" are different
// answers, and only one of them may contribute to a clean status. The default
// home is treated the same way — a `$HOME` that cannot be resolved means
// nothing was scanned, and reporting that as clean is the failure this whole
// contract is shaped against.
async function resolveRoots({ requestedRoots, homeDir, ops }) {
  const requested = requestedRoots.length > 0
    ? requestedRoots.map((r) => ({ requested: r, source: '--root' }))
    : [{ requested: homeDir, source: 'default-home' }];

  const roots = [];
  const blocked = [];
  for (const entry of requested) {
    let canonical;
    try {
      canonical = await ops.realpath(entry.requested);
    } catch (err) {
      blocked.push({
        path: safeOperatorText(entry.requested),
        reason: `root could not be resolved (${err?.code ?? 'error'})`,
      });
      continue;
    }
    let st;
    try {
      st = await ops.stat(canonical);
    } catch (err) {
      blocked.push({
        path: safeOperatorText(entry.requested),
        reason: `root could not be inspected (${err?.code ?? 'error'})`,
      });
      continue;
    }
    if (!st.isDirectory()) {
      blocked.push({ path: safeOperatorText(entry.requested), reason: 'root is not a directory' });
      continue;
    }
    roots.push({ ...entry, canonical, dev: st.dev, ino: st.ino });
  }

  // Dedupe by physical identity FIRST (two spellings of one directory — a
  // symlink, a case variant on a case-folding volume — reach the same dev/ino
  // while comparing unequal as strings), then drop any root nested inside a
  // retained one so a tree is not walked twice.
  const byIdentity = new Map();
  for (const root of roots) {
    const key = `${root.dev}:${root.ino}`;
    if (!byIdentity.has(key)) byIdentity.set(key, root);
  }
  const unique = [...byIdentity.values()].sort((a, b) => a.canonical.length - b.canonical.length || a.canonical.localeCompare(b.canonical));
  const retained = [];
  for (const root of unique) {
    if (retained.some((kept) => isUnder(root.canonical, kept.canonical))) continue;
    retained.push(root);
  }
  return { roots: retained, blocked };
}

// ---------------------------------------------------------------------------
// T3 — the streaming marker-hunt walker
// ---------------------------------------------------------------------------

// Walk one root, hunting CHECKOUT_MARKER. Never enumerates below a marker: on a
// hit, the fixed remainder is `stat`ed and the subtree is left alone.
//
// Symlinks: the ROOT is followed once (it was realpath'd above — `find -H`
// semantics, matching `bootstrap-artifacts.mjs`), descendants never are. A
// descendant symlink is a reported BOUNDARY (`not_followed`), not a failure —
// measured basis: this `$HOME` holds 9 directory symlinks within depth 3, so
// routing them all to `blocked` would make the status constant and therefore
// carry no information at all.
//
// RESIDUAL, stated rather than papered over: this cannot claim "never follows a
// symlink" under all interleavings. Node has no `openat`, so a directory
// component can be swapped for a symlink between the `opendir` that listed it
// and the `opendir` that descends into it. The window is TOCTOU-narrow and
// read-only — the worst outcome is listing a directory the operator did not
// intend, never writing to one.
async function walkRoot(root, ctx) {
  const stack = [{ path: root.canonical, depth: 0 }];
  while (stack.length > 0) {
    // When a cap ends the walk, EVERY directory still queued is unscanned. An
    // earlier cut reported only the one at the top of the stack, which reads as
    // "one location was skipped" while thousands were — the silent-cap failure
    // this contract exists to avoid. The whole remainder is reported.
    if (ctx.clock() >= ctx.deadline) {
      abandonRemainder(stack, 'time-budget', ctx);
      return;
    }
    if (ctx.stats.dirs_scanned >= ctx.caps.maxDirs) {
      abandonRemainder(stack, 'dir-cap', ctx);
      return;
    }
    const { path: dir, depth } = stack.pop();

    let handle;
    try {
      handle = await ctx.ops.opendir(dir);
    } catch (err) {
      const code = err?.code ?? 'error';
      // A directory that vanished mid-scan is still a place we intended to look
      // and could not. It demotes the status exactly like a permission error —
      // the scan cannot tell "it was empty" from "it was moved away".
      recordBucket(ctx.blocked, ctx.blockedTotals, 'opendir', { path: safeOperatorText(dir), reason: `directory could not be opened (${code})` });
      continue;
    }
    ctx.stats.dirs_scanned += 1;

    const children = [];
    let entryCount = 0;
    let capped = false;
    try {
      for await (const entry of handle) {
        entryCount += 1;
        ctx.stats.entries_seen += 1;
        // The cap acts HERE, mid-stream, before the rest of the listing is
        // materialized. That is the whole reason this is `opendir`.
        if (entryCount > ctx.caps.maxEntriesPerDir) {
          recordPruned(ctx, dir, 'entry-cap');
          capped = true;
          break;
        }
        const name = entry.name;
        if (name === CHECKOUT_MARKER) {
          // A marker hit — by NAME, whether the entry is a real directory or a
          // symlink standing in for one. The candidate below is a single `stat`
          // of a fixed path, not a traversal, so resolving through a symlinked
          // marker costs nothing and missing it would be a silent gap.
          await inspectCandidate(dir, ctx);
          continue;
        }
        if (entry.isSymbolicLink()) {
          // Learn whether it is a directory (so the boundary list is about real
          // checkout candidates and not every `*.dylib` symlink) WITHOUT
          // descending. `stat` follows the link; the walk still does not.
          let target;
          try {
            target = await ctx.ops.stat(join(dir, name));
          } catch {
            // A dangling or unreachable symlink is definitively not a directory
            // we can enumerate. It is not `blocked`: we were never going to walk
            // it, so nothing was lost.
            continue;
          }
          if (target.isDirectory()) {
            recordBucket(ctx.notFollowed, ctx.notFollowedTotals, 'descendant-symlink', { path: safeOperatorText(join(dir, name)) });
          }
          continue;
        }
        if (!entry.isDirectory()) continue;
        const childPath = join(dir, name);
        if (PRUNE_DIR_NAMES.has(name)) {
          recordPruned(ctx, childPath, `name-prune (${name})`);
          continue;
        }
        // An operator-named skip. Matched by dev/ino rather than by spelling,
        // for the same reason the live-WAL exclusion is: `--skip ~/mnt` must
        // still hold when the walk reaches that directory by another name.
        if (ctx.skipIdentities.size > 0 && await isSkipped(childPath, ctx)) {
          recordPruned(ctx, childPath, 'operator-skip');
          continue;
        }
        if (depth + 1 > ctx.caps.maxDepth) {
          recordPruned(ctx, childPath, 'depth-cap');
          continue;
        }
        children.push({ path: childPath, depth: depth + 1 });
      }
    } catch (err) {
      // Mid-iteration failure: part of this directory WAS listed and the rest
      // was not, so the entries already queued stay queued and the directory is
      // reported blocked. Reporting only the completed part as if it were whole
      // is the fail-open direction.
      recordBucket(ctx.blocked, ctx.blockedTotals, 'mid-scan', { path: safeOperatorText(dir), reason: `directory listing failed mid-scan (${err?.code ?? 'error'})` });
    } finally {
      if (typeof handle?.close === 'function') await handle.close().catch(() => {});
    }
    if (!capped) ctx.stats.dirs_completed += 1;
    for (const child of children) stack.push(child);
  }
}

// Entries kept per bucket for the SAMPLE. Exact totals are counted separately
// and never bounded, so a cap is always visible as a number even when the list
// is not.
const MAX_STORED_PER_BUCKET = 5000;

function recordBucket(bucket, totals, key, entry) {
  totals.set(key, (totals.get(key) ?? 0) + 1);
  if (bucket.length < MAX_STORED_PER_BUCKET) bucket.push(entry);
}

function recordPruned(ctx, path, reason) {
  // `name-prune (node_modules)` and `name-prune (.git)` share one total: the
  // operator wants to know how much was pruned by name, not a histogram.
  const key = reason.startsWith('name-prune') ? 'name-prune' : reason;
  recordBucket(ctx.pruned, ctx.prunedTotals, key, { path: safeOperatorText(path), reason });
}

// Report the whole unwalked remainder when a cap ends the scan.
function abandonRemainder(stack, reason, ctx) {
  ctx.exhausted = true;
  ctx.exhaustedReason = reason;
  for (const item of stack) recordPruned(ctx, item.path, reason);
}

// Is this directory one the operator asked to skip? By dev/ino, for the same
// reason the live-WAL exclusion is: a skip named as `~/mnt` must still hold when
// the walk arrives by a different spelling.
async function isSkipped(path, ctx) {
  try {
    const st = await ctx.ops.stat(path);
    return ctx.skipIdentities.has(`${st.dev}:${st.ino}`);
  } catch {
    // Unstattable is not skipped — it will fail at `opendir` and be reported as
    // blocked, which is the honest outcome. Treating it as skipped here would
    // convert an error into a silent omission.
    return false;
  }
}

// ---------------------------------------------------------------------------
// T5 — the findings model
// ---------------------------------------------------------------------------

// Examine one `<checkoutRoot>/.agentic-plugins/runs/doctor/egress-intents`.
//
// The current repo's own legacy directory is a FINDING annotated
// `already_fenced_by_current_doctor`, NOT an exclusion. Excluding it would
// produce a false clean: follow-ups.md § "Egress-ack intent WAL" requires
// reporting EVERY legacy
// location, and an operator who sees "nothing found" while a legacy directory
// sits in the checkout they are standing in has been told something untrue.
//
// The ONE exclusion is the live machine-global WAL — the fence itself.
async function inspectCandidate(checkoutRoot, ctx) {
  const candidate = join(checkoutRoot, CHECKOUT_MARKER, ...MARKER_REMAINDER);
  let st;
  try {
    st = await ctx.ops.stat(candidate);
  } catch (err) {
    const code = err?.code ?? 'error';
    // ENOENT/ENOTDIR are definite answers: there is no WAL directory here. A
    // marker without one is the common case (every checkout has
    // `.agentic-plugins`; few have run an egress proof).
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    recordBucket(ctx.blocked, ctx.blockedTotals, 'candidate-stat', { path: safeOperatorText(candidate), reason: `candidate could not be inspected (${code})` });
    return;
  }
  if (!st.isDirectory()) return;

  const identityKey = `${st.dev}:${st.ino}`;
  // One physical directory reported once, however many spellings reached it.
  if (ctx.seenCandidates.has(identityKey)) return;
  ctx.seenCandidates.add(identityKey);

  // THE exclusion — and by dev/ino, never by string. A symlinked checkout or a
  // case-variant spelling reaches the live WAL by a second name; comparing the
  // strings said "different", and the operator was handed the live fence as
  // clearable legacy state.
  const isLive = await sameDirectory(candidate, ctx.liveWalDir, { stat: ctx.ops.stat });
  if (isLive.unknown) {
    // A filesystem that will not say must not be resolved by guessing. Guessing
    // "different" reports the live fence for removal; guessing "same" drops a
    // real legacy location. Neither — the operator is told the question is open.
    recordBucket(ctx.blocked, ctx.blockedTotals, 'live-wal-identity', { path: safeOperatorText(candidate), reason: `could not be told apart from the live machine-global WAL (${isLive.reason})` });
    return;
  }
  if (isLive.same) {
    ctx.exclusions.push({ path: safeOperatorText(candidate), reason: 'current-machine-global-wal' });
    return;
  }

  // Advisory annotation only. When identity cannot be decided it stays FALSE,
  // which costs the operator a review they may not have needed — the safe
  // direction. Claiming "already fenced" about a directory that is not would be
  // the harmful one.
  let alreadyFenced = false;
  if (ctx.repoLegacyDir) {
    const sameAsRepo = await sameDirectory(candidate, ctx.repoLegacyDir, { stat: ctx.ops.stat });
    alreadyFenced = sameAsRepo.same === true;
  }

  const finding = {
    dir: safeOperatorText(candidate),
    checkout_root: safeOperatorText(checkoutRoot),
    record_count: null,
    records: [],
    already_fenced_by_current_doctor: alreadyFenced,
    unreadable: false,
  };

  let handle;
  try {
    handle = await ctx.ops.opendir(candidate);
  } catch (err) {
    // An UNREADABLE candidate is an incomplete candidate: it is reported, with
    // an unknown record count and no per-record detail. It is not `blocked` —
    // the location itself was found, which is what the operator needs; only its
    // contents are unknown, and the guidance is uniform anyway.
    finding.unreadable = true;
    finding.unreadable_reason = `contents could not be listed (${err?.code ?? 'error'})`;
    ctx.findings.push(finding);
    return;
  }
  const records = [];
  try {
    for await (const entry of handle) {
      if (records.length >= ctx.caps.maxEntriesPerDir) {
        finding.unreadable = true;
        finding.unreadable_reason = 'record listing exceeded the entry cap';
        break;
      }
      if (!entry.name.endsWith('.json')) continue;
      // Bodies are NEVER read — not the record's, not a special file's. The
      // kind comes from the directory entry the listing already carries, so a
      // `*.json` that is really a FIFO or a directory is named as such without
      // ever being opened.
      records.push({ name: safeRecordName(entry.name), kind: entryKind(entry) });
    }
  } catch (err) {
    finding.unreadable = true;
    finding.unreadable_reason = `record listing failed mid-scan (${err?.code ?? 'error'})`;
  } finally {
    if (typeof handle?.close === 'function') await handle.close().catch(() => {});
  }
  records.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  finding.records = records;
  // An unreadable listing has an UNKNOWN count, not a partial one presented as
  // whole. An empty but readable directory has a known count of 0 — a real
  // answer, and a different one.
  finding.record_count = finding.unreadable ? null : records.length;
  ctx.findings.push(finding);
}

function entryKind(entry) {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  if (typeof entry.isFIFO === 'function' && entry.isFIFO()) return 'fifo';
  if (typeof entry.isSocket === 'function' && entry.isSocket()) return 'socket';
  return 'other';
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export async function discoverLegacyEgressIntents({
  requestedRoots = [],
  skipPaths = [],
  repoRoot = null,
  homeDir = defaultHomedir(),
  now = new Date(),
  host = defaultHostname(),
  runtimeVersion = RUNTIME_VERSION,
  caps: capOverrides = {},
  ops: opOverrides = {},
  clock = () => Date.now(),
} = {}) {
  const ops = {
    opendir: defaultOpendir,
    stat: defaultStat,
    realpath: defaultRealpath,
    ...opOverrides,
  };
  const caps = { ...DEFAULT_DISCOVERY_CAPS, ...capOverrides };
  const started = clock();

  const { roots, blocked: rootBlocked } = await resolveRoots({ requestedRoots, homeDir, ops });
  const { identities: skipIdentities, resolved: skips, unresolved: skipUnresolved } = await resolveSkips({ skipPaths, ops });

  const ctx = {
    ops,
    caps,
    clock,
    deadline: started + caps.timeBudgetMs,
    liveWalDir: egressIntentDir(homeDir),
    repoLegacyDir: repoRoot ? egressIntentDir(repoRoot) : null,
    skipIdentities,
    blocked: [],
    blockedTotals: new Map(),
    notFollowed: [],
    notFollowedTotals: new Map(),
    pruned: [],
    prunedTotals: new Map(),
    exclusions: [],
    findings: [],
    seenCandidates: new Set(),
    stats: { dirs_scanned: 0, dirs_completed: 0, entries_seen: 0 },
    exhausted: false,
    exhaustedReason: null,
  };
  for (const entry of rootBlocked) recordBucket(ctx.blocked, ctx.blockedTotals, 'root', entry);
  // A `--skip` the operator named and that could not be resolved is NOT silently
  // dropped: the scan would then walk a tree they asked it not to, which is the
  // opposite of what they requested and (given one measured mount at ~286ms per
  // directory) can consume the whole budget.
  for (const entry of skipUnresolved) recordBucket(ctx.blocked, ctx.blockedTotals, 'skip', entry);

  for (const root of roots) {
    await walkRoot(root, ctx);
    if (ctx.exhausted) break;
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  const totals = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const sum = (map) => [...map.values()].reduce((s, n) => s + n, 0);
  // Sort BEFORE bounding so the listed sample is deterministic, then bound.
  const bound = (list) => list.slice().sort(byPath).slice(0, MAX_REPORTED_PER_BUCKET);

  const blockedTotal = sum(ctx.blockedTotals);
  const blocked = bound(ctx.blocked);
  const notFollowed = bound(ctx.notFollowed);
  const pruned = bound(ctx.pruned);
  const exclusions = [...ctx.exclusions].sort(byPath);
  const findings = [...ctx.findings].sort((a, b) => a.dir.localeCompare(b.dir));

  // `scan_complete` describes the TRAVERSAL: every root was walked to its end
  // without a cap or the budget cutting it short. It is deliberately separate
  // from `blocked` — a scan can run to completion and still have failed to open
  // three directories, and the status function requires BOTH.
  const scanComplete = ctx.exhausted === false;
  // Status is decided from the TOTAL, not from the bounded sample: bounding must
  // never be able to turn a blocked scan into a clean one. (It cannot today —
  // bounding a non-empty list leaves it non-empty — but deriving the decision
  // from the display would make that an accident rather than a property.)
  const status = resolveDiscoveryStatus({
    scanComplete,
    blocked: blockedTotal === 0 ? [] : blocked,
    findings,
  });

  return {
    schema_version: LEGACY_EGRESS_DISCOVERY_SCHEMA,
    runtime_version: runtimeVersion,
    scanned_at: now instanceof Date ? now.toISOString() : String(now),
    host: safeOperatorText(host),
    roots: roots.map((r) => ({
      requested: safeOperatorText(r.requested),
      canonical: safeOperatorText(r.canonical),
      source: r.source,
    })),
    skips: skips.map((s) => ({ requested: safeOperatorText(s.requested), canonical: safeOperatorText(s.canonical) })),
    scan: {
      complete: scanComplete,
      ended_early_because: ctx.exhaustedReason,
      blocked,
      blocked_total: blockedTotal,
      blocked_by_kind: totals(ctx.blockedTotals),
      not_followed: notFollowed,
      not_followed_total: sum(ctx.notFollowedTotals),
      pruned,
      pruned_total: sum(ctx.prunedTotals),
      pruned_by_reason: totals(ctx.prunedTotals),
      stats: { ...ctx.stats, elapsed_ms: Math.max(0, clock() - started) },
      caps: {
        max_depth: caps.maxDepth,
        max_entries_per_dir: caps.maxEntriesPerDir,
        max_dirs: caps.maxDirs,
        time_budget_ms: caps.timeBudgetMs,
        max_reported_per_bucket: MAX_REPORTED_PER_BUCKET,
      },
    },
    exclusions,
    findings,
    overall: { status, guidance: guidanceFor(status) },
    residual: buildResidual({ roots, ctx, prunedTotal: sum(ctx.prunedTotals), notFollowedTotal: sum(ctx.notFollowedTotals) }),
    mutation_boundary: {
      writes_allowed: 'none',
      forbidden: [
        'no file is created, moved, or removed by this command',
        'no subprocess is spawned',
        'no record body is read',
        'no shell command is generated for the operator to run',
      ],
    },
  };
}

// Resolve `--skip` paths to physical identities.
//
// This flag exists because of a measurement, not a preference. On the dogfood
// machine one top-level directory — a remote mount at `~/mnt` — cost 23.7s for
// 83 directories (~286ms each) while the other 95 top-level directories cost
// 6.3s for ~14,000 (~0.45ms each). One mount was 79% of the wall time and 0.6%
// of the directories, so without a lever the scan reports `incomplete` on every
// run and never gets far enough to find anything.
//
// Deliberately OPERATOR-EXPLICIT rather than a heuristic. Auto-skipping "slow"
// directories, or every non-local filesystem, would silently drop a checkout
// that happens to live on an external volume — and a discovery command whose
// omissions are invisible is worse than one that is slow. Every skip is
// reported, so it cannot produce a false clean.
async function resolveSkips({ skipPaths, ops }) {
  const identities = new Set();
  const resolved = [];
  const unresolved = [];
  for (const requested of skipPaths) {
    let canonical;
    try {
      canonical = await ops.realpath(requested);
      const st = await ops.stat(canonical);
      identities.add(`${st.dev}:${st.ino}`);
      resolved.push({ requested, canonical });
    } catch (err) {
      unresolved.push({
        path: safeOperatorText(requested),
        reason: `--skip target could not be resolved (${err?.code ?? 'error'}); the scan would have walked it`,
      });
    }
  }
  return { identities, resolved, unresolved };
}

function guidanceFor(status) {
  if (status === DISCOVERY_STATUS.incomplete) return GUIDANCE.incomplete;
  if (status === DISCOVERY_STATUS.findings) return GUIDANCE.findings;
  return GUIDANCE.none;
}

// The limits of this answer, in every output format. The first one is
// irreducible: closing it would need a full-filesystem scan (disproportionate)
// or a checkout registry (which does not exist).
function buildResidual({ roots, ctx, prunedTotal, notFollowedTotal }) {
  const residual = [
    `checkouts outside the scanned roots are not covered (scanned: ${roots.length} root(s))`,
    'the time budget is cooperative — it is checked between directory reads and cannot preempt one stuck syscall; a single remote mount was measured at ~286ms per directory, so --skip is the lever for that case',
    'a directory component can be replaced between the listing that named it and the read that opens it (TOCTOU); the scan is read-only, so the worst outcome is listing a directory that was not intended',
    'the annotation already_fenced_by_current_doctor is FALSE when identity could not be decided — it costs a review, never skips one',
  ];
  if (ctx.exhaustedReason) {
    residual.push(`the walk ended early (${ctx.exhaustedReason}); every directory still queued is counted under scan.pruned and was never examined`);
  }
  if (prunedTotal > 0) residual.push(`${prunedTotal} location(s) were not descended into — see scan.pruned_by_reason`);
  if (notFollowedTotal > 0) residual.push(`${notFollowedTotal} descendant directory symlink(s) were not followed — see scan.not_followed`);
  return residual;
}

// ---------------------------------------------------------------------------
// T8 — renderers
// ---------------------------------------------------------------------------

export function renderDiscoveryJson(report) {
  return JSON.stringify(report, null, 2);
}

// Render a bounded bucket sample, and SAY when it is a sample. A truncated list
// with no marker reads as the whole set.
function sampleLines(entries, total) {
  const lines = entries.map((e) => (e.reason ? `${e.path} — ${e.reason}` : e.path));
  if (total > entries.length) {
    lines.push(`… and ${total - entries.length} more (listing bounded at ${MAX_REPORTED_PER_BUCKET}; the count above is exact)`);
  }
  return lines;
}

export function renderDiscoveryText(report) {
  const lines = [];
  lines.push(`runtime:migrate legacy-egress-intents ${report.runtime_version} — READ-ONLY discovery (${report.schema_version})`);
  lines.push(`scanned_at: ${report.scanned_at}; host: ${report.host}`);
  lines.push(`overall: ${report.overall.status}`);
  lines.push('');
  lines.push('Mutation Boundary');
  lines.push(`- writes: ${report.mutation_boundary.writes_allowed}`);
  for (const forbidden of report.mutation_boundary.forbidden) lines.push(`- ${forbidden}`);
  lines.push('');
  lines.push('Roots');
  for (const root of report.roots) {
    lines.push(`- ${root.canonical} (source=${root.source}; requested=${root.requested})`);
  }
  if (report.roots.length === 0) lines.push('- (none resolved)');
  for (const skip of report.skips) lines.push(`- skipped by operator: ${skip.canonical} (requested=${skip.requested})`);
  lines.push('');
  lines.push('Scan');
  lines.push(`- complete: ${report.scan.complete}${report.scan.ended_early_because ? ` (ended early: ${report.scan.ended_early_because})` : ''}`);
  lines.push(`- dirs: scanned=${report.scan.stats.dirs_scanned}; completed=${report.scan.stats.dirs_completed}; entries=${report.scan.stats.entries_seen}; elapsed_ms=${report.scan.stats.elapsed_ms}`);
  lines.push(`- caps: depth=${report.scan.caps.max_depth}; entries-per-dir=${report.scan.caps.max_entries_per_dir}; dirs=${report.scan.caps.max_dirs}; time-budget-ms=${report.scan.caps.time_budget_ms}`);
  // Totals FIRST, then a bounded sample. The count is the honest part: a list
  // truncated without its total reads as "that was all of them".
  lines.push(`- blocked: ${report.scan.blocked_total}${report.scan.blocked_total > 0 ? ` by kind ${JSON.stringify(report.scan.blocked_by_kind)}` : ''}`);
  for (const entry of sampleLines(report.scan.blocked, report.scan.blocked_total)) lines.push(`    blocked: ${entry}`);
  lines.push(`- not-followed (descendant symlinks): ${report.scan.not_followed_total}`);
  for (const entry of sampleLines(report.scan.not_followed, report.scan.not_followed_total)) lines.push(`    not-followed: ${entry}`);
  lines.push(`- pruned: ${report.scan.pruned_total}${report.scan.pruned_total > 0 ? ` by reason ${JSON.stringify(report.scan.pruned_by_reason)}` : ''}`);
  for (const entry of sampleLines(report.scan.pruned, report.scan.pruned_total)) lines.push(`    pruned: ${entry}`);
  lines.push('');
  lines.push('Exclusions');
  if (report.exclusions.length === 0) lines.push('- (none)');
  for (const entry of report.exclusions) lines.push(`- ${entry.path} — ${entry.reason}`);
  lines.push('');
  lines.push(`Findings (${report.findings.length})`);
  if (report.findings.length === 0) lines.push('- (none in the scanned scope)');
  for (const finding of report.findings) {
    const count = finding.record_count === null ? 'unknown' : String(finding.record_count);
    lines.push(`- ${finding.dir}`);
    lines.push(`  checkout: ${finding.checkout_root}`);
    lines.push(`  records: ${count}${finding.unreadable ? ` (unreadable — ${finding.unreadable_reason})` : ''}${finding.already_fenced_by_current_doctor ? '; already fenced by the current checkout’s doctor' : ''}`);
    for (const record of finding.records) lines.push(`    ${record.name} [${record.kind}]`);
  }
  lines.push('');
  lines.push('Guidance');
  lines.push(`- ${report.overall.guidance}`);
  lines.push('');
  lines.push('Residual');
  for (const item of report.residual) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

// Exported for direct unit tests: root resolution is the path where a bug tells
// the operator to act on the LIVE fence, so it is tested on its own terms rather
// than only through a full scan.
export { resolveRoots as resolveDiscoveryRoots };
