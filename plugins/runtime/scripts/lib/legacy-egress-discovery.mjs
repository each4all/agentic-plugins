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

import { lstat as defaultLstat, opendir as defaultOpendir, realpath as defaultRealpath, stat as defaultStat } from 'node:fs/promises';
import { homedir as defaultHomedir, hostname as defaultHostname, userInfo } from 'node:os';
import { join, parse as parsePath } from 'node:path';

import { EGRESS_INTENT_DIR_SUFFIX, egressIntentDir, safeOperatorText, safeRecordName } from './egress-intent-wal.mjs';
// `sameDirectory` is deliberately NOT used here. It re-stats both paths, and
// this scanner already holds the candidate's identity from the `stat` that
// established it was a directory — asking twice opens a window in which a path
// can stop and start resolving to the live WAL. `directoryIdentity` below
// resolves each fixed reference point once instead.
import { isUnder } from './path-containment.mjs';
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
  maxReportedPerBucket: 50,
});

// How many entries of each completeness bucket are LISTED. The totals are always
// reported alongside, so this bounds the output without hiding a cap — a
// depth-capped `$HOME` walk produced 60,405 entries in one measurement, and a
// report nobody can read is not a report.
//
// Overridable through `caps.maxReportedPerBucket`. That is not a feature anyone
// asked for; it exists so the separation between the DISPLAYED list and the
// count the status is decided from is a tested property rather than a defensive
// comment. At 50 the two can never disagree in the dangerous direction (bounding
// a non-empty list leaves it non-empty), so the first attempt at that guard was
// both wrong and untested — see `resolveDiscoveryStatus` below.
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
export function resolveDiscoveryStatus({ scanComplete, blocked, blockedTotal, findings, directoriesExamined } = {}) {
  if (scanComplete !== true) return DISCOVERY_STATUS.incomplete;
  if (!Array.isArray(blocked)) return DISCOVERY_STATUS.incomplete;
  if (!Array.isArray(findings)) return DISCOVERY_STATUS.incomplete;
  // "No findings" is only an answer if something was LOOKED AT. Reproduced:
  // `--root X --skip X` reported no_findings_in_scanned_scope with
  // scan.complete=true, zero directories examined and exit 0 — reassurance over
  // an empty scope (cross-host review). Omitting the count keeps the older
  // two-argument callers working; supplying zero is what fails closed.
  if (directoriesExamined !== undefined) {
    if (!Number.isSafeInteger(directoriesExamined) || directoriesExamined < 0) return DISCOVERY_STATUS.incomplete;
    if (directoriesExamined === 0) return DISCOVERY_STATUS.incomplete;
  }
  // `blocked` is the BOUNDED display list; `blockedTotal` is the unbounded
  // count. They are separate arguments because they can disagree, and the first
  // attempt at this got it wrong: it guarded only `total === 0` and otherwise
  // handed the status function the bounded array, so a bound of 0 produced an
  // empty list beside a count of 1 and the report read CLEAN while a directory
  // had failed to open. A test that set the bound to 0 is what surfaced it.
  //
  // Omitting `blockedTotal` means the array IS the count — the only case where
  // the two agree by construction, and the shape the unit tests use.
  const total = blockedTotal === undefined ? blocked.length : blockedTotal;
  if (!Number.isInteger(total) || total < 0) return DISCOVERY_STATUS.incomplete;
  if (total > 0 || blocked.length > 0) return DISCOVERY_STATUS.incomplete;
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
      st = await ops.statIdentity(canonical);
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
    const identity = identityOf(st);
    if (identity === null) {
      blocked.push({ path: safeOperatorText(entry.requested), reason: 'root reported an identity this runtime cannot compare exactly' });
      continue;
    }
    // The `/` refusal lives HERE, on the CANONICAL path, and the CLI's
    // pre-realpath check is only an early, friendlier message. `--root <symlink
    // to />` passed the lexical check and then canonicalized to `/`, so a
    // whole-filesystem walk — an explicit non-goal — was reachable through a
    // one-line symlink (cross-host review, reproduced).
    // `parse().root` rather than a literal `'/'`: on Windows the forbidden
    // whole-drive and UNC roots are `C:\` and `\\server\share\`, which a
    // POSIX-only comparison does not recognise (cross-host review, conditional
    // on Windows support — cheap enough to close regardless).
    if (canonical === parsePath(canonical).root) {
      blocked.push({
        path: safeOperatorText(entry.requested),
        reason: 'root resolves to a filesystem root; a whole-filesystem scan is a non-goal',
      });
      continue;
    }
    roots.push({ ...entry, canonical, identity });
  }

  // Dedupe by physical identity FIRST (two spellings of one directory — a
  // symlink, a case variant on a case-folding volume — reach the same dev/ino
  // while comparing unequal as strings), then drop any root nested inside a
  // retained one so a tree is not walked twice.
  const byIdentity = new Map();
  for (const root of roots) {
    if (!byIdentity.has(root.identity)) byIdentity.set(root.identity, root);
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
    // ATTEMPTS, not successes. `dirs_scanned` counts directories that opened, so
    // a tree of fast EACCES failures was unbounded by this cap — the cap measured
    // the wrong quantity, which is the same class as the candidate cap that
    // counted records kept instead of entries seen (cross-host review).
    if (ctx.stats.dirs_attempted >= ctx.caps.maxDirs) {
      abandonRemainder(stack, 'dir-cap', ctx);
      return;
    }
    const { path: dir, depth } = stack.pop();

    let handle;
    ctx.stats.dirs_attempted += 1;
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
          // A capped listing means entries were never seen — including, possibly,
          // a `.agentic-plugins` marker sitting after the cap. Recording the
          // prune without marking the scan incomplete let a run report
          // complete + no findings + exit 0 over a directory it had not read.
          ctx.exhausted = true;
          ctx.exhaustedReason = ctx.exhaustedReason ?? 'entry-cap';
          capped = true;
          break;
        }
        // The budget is checked HERE as well as between directories. Checking it
        // only at the top of the walk loop meant one directory with a very large
        // listing on a slow mount could run far past the deadline while the
        // report still said the walk completed (cross-host review).
        if (ctx.clock() >= ctx.deadline) {
          recordPruned(ctx, dir, 'time-budget');
          ctx.exhausted = true;
          ctx.exhaustedReason = 'time-budget';
          capped = true;
          break;
        }
        const name = entry.name;
        // The skip decision runs BEFORE the marker branch. It used to run after
        // it, so `--skip <path>/.agentic-plugins` still inspected the candidate
        // the operator had excluded (cross-host review).
        if (ctx.skipIdentities.size > 0 && (entry.isDirectory() || name === CHECKOUT_MARKER)) {
          const decision = await skipDecision(join(dir, name), ctx);
          if (decision === 'skip') { recordPruned(ctx, join(dir, name), 'operator-skip'); continue; }
          if (decision === 'unknown') {
            recordBucket(ctx.blocked, ctx.blockedTotals, 'skip-undecidable', {
              path: safeOperatorText(join(dir, name)),
              reason: 'could not be told apart from an excluded directory; it was not read',
            });
            continue;
          }
        }
        // A DESCENDANT SYMLINK IS NEVER DEREFERENCED.
        //
        // An earlier cut `stat`ed it to learn whether it was a directory, so the
        // boundary list would name real checkout candidates instead of every
        // `*.dylib` symlink. Cross-host review showed that trade was wrong in
        // three ways: `stat` follows the link, so it can block on the very
        // remote mount the budget exists to survive; it can reach outside the
        // scanned root; and when it FAILED the code fell through to `continue`
        // and the boundary vanished from the report entirely — a silent omission
        // in exactly the bucket that exists to prevent silent omissions.
        //
        // So every descendant symlink is recorded as a boundary, unexamined. The
        // list is noisier (measured: 4,526 entries under `$HOME` at depth 4), and
        // that is affordable now that buckets carry an exact total and a bounded
        // sample. This also settles the marker case below: a marker that is a
        // symlink is a boundary too, not a hit.
        if (entry.isSymbolicLink()) {
          recordBucket(ctx.notFollowed, ctx.notFollowedTotals, 'descendant-symlink', { path: safeOperatorText(join(dir, name)) });
          continue;
        }
        if (name === CHECKOUT_MARKER) {
          // A real marker directory. The candidate is a fixed four-component
          // suffix under it — `stat`ed and listed, never walked into.
          await inspectCandidate(dir, ctx);
          continue;
        }
        if (!entry.isDirectory()) continue;
        const childPath = join(dir, name);
        if (PRUNE_DIR_NAMES.has(name)) {
          recordPruned(ctx, childPath, `name-prune (${name})`);
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
      // A listing that threw did NOT complete. Leaving `capped` false made
      // `dirs_completed` contradict the blocked entry that sits beside it.
      capped = true;
    } finally {
      if (typeof handle?.close === 'function') await handle.close().catch(() => {});
    }
    if (!capped) ctx.stats.dirs_completed += 1;
    // The QUEUE is bounded too. `maxDirs` bounds what is scanned; without this a
    // wide tree could park millions of paths in memory before that cap ever
    // fired. The excess is reported, not dropped.
    for (const child of children) {
      if (stack.length >= ctx.caps.maxDirs) {
        recordPruned(ctx, child.path, 'queue-cap');
        continue;
      }
      stack.push(child);
    }
    // An EMPTY directory never enters the entry loop, so a slow `opendir` of one
    // was the one path that could overrun the budget without any check seeing it.
    if (ctx.clock() >= ctx.deadline && stack.length > 0) {
      abandonRemainder(stack, 'time-budget', ctx);
      return;
    }
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
// Three answers, not two. A skip is a READ BOUNDARY the operator drew, so
// "I could not tell whether this is the excluded directory" must not resolve to
// "read it" — that walks a subtree they explicitly excluded, which may be the
// sensitive or the slow one the flag existed for (cross-host review).
//   'skip'    identity matches an exclusion
//   'walk'    identity is known and matches nothing
//   'unknown' the filesystem would not say — the caller blocks rather than reads
async function skipDecision(path, ctx) {
  if (ctx.skipIdentities.size === 0) return 'walk';
  try {
    const key = identityOf(await ctx.ops.statIdentity(path));
    if (key === null) return 'unknown';
    return ctx.skipIdentities.has(key) ? 'skip' : 'walk';
  } catch (err) {
    // ENOENT is a definite answer: a directory that is not there is not the one
    // the operator excluded, and the walk will report its own failure.
    if (err?.code === 'ENOENT') return 'walk';
    return 'unknown';
  }
}

// A directory's physical identity as a comparable string, or null when it is
// not exactly comparable.
//
// dev/ino above 2^53 collapse when they arrive as JavaScript Numbers — two
// distinct directories then compare EQUAL, and the direction that harms is a
// real legacy directory classified as the live WAL and dropped from the report
// (cross-host review). The identity stat therefore asks for BigInt, and a
// non-BigInt result is accepted only while it is exactly representable.
// The home from the passwd entry, which `$HOME` cannot override. `userInfo()`
// throws when the uid has no passwd entry (some containers), and that is not a
// reason to fail the scan — the `$HOME` reference point still stands.
function safePasswdHome() {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

export function identityOf(st) {
  if (!st) return null;
  const { dev, ino } = st;
  if (typeof dev === 'bigint' && typeof ino === 'bigint') return `${dev}:${ino}`;
  if (Number.isSafeInteger(dev) && Number.isSafeInteger(ino)) return `${dev}:${ino}`;
  return null;
}

// The live machine-global WAL's physical identity.
//
//   { key: 'dev:ino' }            it exists; compare candidates against this
//   { key: null }                 it does not exist, so nothing can BE it
//   { unknown: true, reason }     the filesystem would not say — every caller blocks
//
// A POSITIVE answer is cached: it is compared against every candidate, and
// re-observing it per candidate multiplies the window this exists to close. A
// `null` answer is NOT cached — "the fence does not exist yet" is exactly the
// state that can change during a 120-second scan, and caching it would let a
// WAL created mid-scan be reported as a removable legacy location.
async function liveWalIdentity(ctx) {
  if (ctx.liveWalIdentityCache?.keys?.size) return ctx.liveWalIdentityCache;
  const keys = new Set();
  const seen = [];
  for (const dir of ctx.liveWalDirs) {
    const resolved = await directoryIdentity(dir, ctx);
    if (resolved.unknown) return { unknown: true, reason: resolved.reason };
    seen.push({ dir, present: resolved.key !== null });
    if (resolved.key) keys.add(resolved.key);
  }
  const answer = { keys, probed: seen };
  // Cache only when EVERY reference resolved to something. Caching a partial
  // answer froze a sibling's absence: with home A present and passwd B
  // absent at probe time, a B created later in a 120-second scan was never
  // compared against and could be handed to the operator for removal.
  if (keys.size === ctx.liveWalDirs.length) ctx.liveWalIdentityCache = answer;
  return answer;
}

// The current checkout's legacy WAL identity, same shape. `key: null` when no
// repo root was supplied or the directory does not exist — the annotation is
// advisory, so an unknown here is FALSE (an extra review) rather than a block.
async function repoLegacyIdentity(ctx) {
  if (!ctx.repoLegacyDir) return { key: null };
  if (ctx.repoLegacyIdentityCache === null) {
    const result = await directoryIdentity(ctx.repoLegacyDir, ctx);
    ctx.repoLegacyIdentityCache = result.unknown ? { key: null } : result;
  }
  return ctx.repoLegacyIdentityCache;
}

// A candidate whose contents could not be fully listed. It stays a FINDING (the
// location is what the operator needs) but it also enters `blocked`, because a
// location whose records were never enumerated cannot be the subject of "remove
// the specific records you reviewed" — and `blocked` is what withdraws that
// instruction, for the whole report.
function markUnreadable(finding, candidate, reason, ctx) {
  finding.unreadable = true;
  finding.unreadable_reason = reason;
  recordBucket(ctx.blocked, ctx.blockedTotals, 'candidate-listing', {
    path: safeOperatorText(candidate),
    reason: `legacy egress records could not be fully listed (${reason})`,
  });
}

async function directoryIdentity(path, ctx) {
  try {
    const st = await ctx.ops.statIdentity(path);
    if (!st.isDirectory()) return { key: null };
    const key = identityOf(st);
    if (key === null) return { unknown: true, reason: `${path} reported an identity this runtime cannot compare exactly` };
    return { key };
  } catch (err) {
    // ENOENT is a definite answer: a directory that is not there is not the
    // directory anything can be identical to. Anything else means we could not
    // look, and the caller decides what that costs.
    if (err?.code === 'ENOENT') return { key: null };
    return { unknown: true, reason: `${path} could not be inspected (${err?.code ?? 'error'})` };
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

  // EVERY component of the fixed suffix is checked, not just the marker.
  //
  // The previous round made a symlinked MARKER a boundary and stopped there.
  // The suffix has four components, and a symlink at `runs`, `doctor` or
  // `egress-intents` was still dereferenced by the `stat`/`opendir` below —
  // reproduced: `.agentic-plugins/runs -> /outside` produced an actionable
  // finding outside the requested root with `not_followed_total = 0`. Fixing
  // one of four components is the same one-of-two-copies shape as everything
  // else this contract has been bitten by, so the check is over the whole path.
  const suffix = [CHECKOUT_MARKER, ...MARKER_REMAINDER];
  let walked = checkoutRoot;
  for (const component of suffix) {
    walked = join(walked, component);
    let lst;
    try {
      lst = await ctx.ops.lstat(walked);
    } catch (err) {
      const code = err?.code ?? 'error';
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      recordBucket(ctx.blocked, ctx.blockedTotals, 'candidate-stat', { path: safeOperatorText(walked), reason: `candidate path component could not be inspected (${code})` });
      return;
    }
    if (lst.isSymbolicLink()) {
      recordBucket(ctx.notFollowed, ctx.notFollowedTotals, 'candidate-suffix-symlink', { path: safeOperatorText(walked) });
      return;
    }
    if (!lst.isDirectory()) return;
    // A `--skip` IS A SUBTREE BOUNDARY HERE TOO.
    //
    // The walker consults `ctx.skipIdentities` for every directory entry it
    // lists, including the marker. The fixed components BELOW the marker are
    // never listed — they are `stat`ed straight through — so
    // `--skip <checkout>/.agentic-plugins/runs` (or `/doctor`, or the WAL
    // directory itself) was accepted, reported as "skipped by operator", and then
    // read anyway. An exclusion the report claims to have honored and did not is
    // worse than one it refuses outright.
    //
    // Checked AFTER the lstat, never before it: `skipDecision` stats, and a stat
    // follows a symlink — asking the skip question first would dereference the
    // very component the lstat walk exists to refuse.
    //
    // The first component re-asks what the walker already asked. That redundancy
    // is deliberate: one check in one place is exactly how the marker came to be
    // covered while its three siblings were not.
    if (ctx.skipIdentities.size > 0) {
      const decision = await skipDecision(walked, ctx);
      if (decision === 'skip') {
        recordPruned(ctx, walked, 'operator-skip');
        return;
      }
      if (decision === 'unknown') {
        recordBucket(ctx.blocked, ctx.blockedTotals, 'skip-undecidable', {
          path: safeOperatorText(walked),
          reason: 'could not be told apart from an excluded directory; it was not read',
        });
        return;
      }
    }
  }

  // `lstat` on the final component already proved it is a real directory that
  // no symlink was crossed to reach. This `stat` is for its IDENTITY.
  let st;
  try {
    st = await ctx.ops.statIdentity(candidate);
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

  const identityKey = identityOf(st);
  if (identityKey === null) {
    // dev/ino that cannot be represented exactly is not an identity. Comparing
    // lossy numbers is how a real legacy directory gets classified as the live
    // WAL and silently dropped (cross-host review) — so it is refused, not
    // approximated.
    recordBucket(ctx.blocked, ctx.blockedTotals, 'candidate-identity', { path: safeOperatorText(candidate), reason: 'filesystem reported an identity this runtime cannot compare exactly' });
    return;
  }
  // One physical directory reported once, however many spellings reached it.
  if (ctx.seenCandidates.has(identityKey)) return;
  ctx.seenCandidates.add(identityKey);

  // THE exclusion — decided from the identity ALREADY CAPTURED above, not from a
  // second `stat` of the same path.
  //
  // The first cut called `sameDirectory(candidate, liveWalDir)`, which re-stats
  // the candidate. That is two observations of one path with a window between
  // them, and `sameDirectory` reads a transient `ENOENT` as a definite "these
  // are different directories" — correct for its own callers, wrong here. A path
  // that resolved to the live WAL, vanished for the re-stat, and resolved to it
  // again before the listing would have been reported as a removable legacy
  // location: the live fence, offered for removal. That is the duplicate-send
  // this whole WAL exists to prevent, reached by a different route than the
  // string-comparison defect that shipped before it (cross-host review).
  //
  // The candidate's identity is decided ONCE, at the same moment the directory
  // check was made, and only the live WAL's identity is resolved separately —
  // and that one is cached, so it is one observation per scan rather than one
  // per candidate.
  const live = await liveWalIdentity(ctx);
  if (live.unknown) {
    // A filesystem that will not say must not be resolved by guessing. Guessing
    // "different" reports the live fence for removal; guessing "same" drops a
    // real legacy location. Neither — the operator is told the question is open.
    recordBucket(ctx.blocked, ctx.blockedTotals, 'live-wal-identity', { path: safeOperatorText(candidate), reason: `could not be told apart from the live machine-global WAL (${safeOperatorText(live.reason)})` });
    return;
  }
  if (live.keys.has(identityKey)) {
    ctx.exclusions.push({ path: safeOperatorText(candidate), reason: 'current-machine-global-wal' });
    return;
  }

  // Advisory annotation only. When identity cannot be decided it stays FALSE,
  // which costs the operator a review they may not have needed — the safe
  // direction. Claiming "already fenced" about a directory that is not would be
  // the harmful one.
  const repoLegacy = await repoLegacyIdentity(ctx);
  const alreadyFenced = repoLegacy.key !== null && repoLegacy.key === identityKey;

  const finding = {
    dir: safeOperatorText(candidate),
    checkout_root: safeOperatorText(checkoutRoot),
    record_count: null,
    records: [],
    records_listed: 0,
    already_fenced_by_current_doctor: alreadyFenced,
    unreadable: false,
  };

  let handle;
  try {
    handle = await ctx.ops.opendir(candidate);
  } catch (err) {
    // An UNREADABLE candidate is an INCOMPLETE candidate, and the plan is
    // explicit that it gets "no removal advice".
    //
    // The first cut recorded `unreadable` on the finding and stopped there. That
    // left the report at `findings_present`, which selects the guidance whose
    // instruction is "manually remove the specific records you reviewed" — for a
    // directory whose records were never listed, so there is nothing the
    // operator could have reviewed. `markUnreadable` also records the candidate
    // in `blocked`, which demotes the whole report to `incomplete` and withdraws
    // every removal instruction (cross-host review CRITICAL).
    markUnreadable(finding, candidate, `contents could not be listed (${err?.code ?? 'error'})`, ctx);
    ctx.findings.push(finding);
    return;
  }
  const records = [];
  let recordEntries = 0;
  try {
    for await (const entry of handle) {
      recordEntries += 1;
      // Counts ENTRIES SEEN, not records kept. The first cut capped
      // `records.length`, so a candidate holding millions of non-`.json` entries
      // was enumerated in full with no cap and no deadline ever acting — the cap
      // measured the wrong quantity (cross-host review).
      if (recordEntries > ctx.caps.maxEntriesPerDir) {
        markUnreadable(finding, candidate, `record listing exceeded the entry cap (${ctx.caps.maxEntriesPerDir} entries)`, ctx);
        break;
      }
      if (ctx.clock() >= ctx.deadline) {
        markUnreadable(finding, candidate, 'record listing hit the time budget', ctx);
        ctx.exhausted = true;
        ctx.exhaustedReason = ctx.exhaustedReason ?? 'time-budget';
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
    markUnreadable(finding, candidate, `record listing failed mid-scan (${err?.code ?? 'error'})`, ctx);
  } finally {
    if (typeof handle?.close === 'function') await handle.close().catch(() => {});
  }
  // BIND THE CLASSIFICATION TO WHAT WAS ACTUALLY LISTED.
  //
  // The identity above decided that this candidate is NOT the live WAL. The
  // listing then re-opened the PATHNAME, and a pathname is not an object: a
  // component swapped in between means the records just enumerated belong to a
  // different directory than the one that was classified — possibly the live
  // fence, which would then be printed with removal wording. The previous round
  // closed the comparison window and left this one open, which is the same
  // defect one step later (cross-host review CRITICAL).
  //
  // Node has no readdir-from-descriptor, so the binding is by DETECTION: observe
  // the identity again after the listing and refuse to report anything if it
  // moved. A swap is then a blocked entry, never a finding.
  //
  // WHAT DETECTION IS NOT. This is not a binding, and describing it as one is
  // what made each earlier round read as closed while the window merely narrowed.
  // Two interleavings pass it, and both are stated in `residual[]` rather than
  // implied away here:
  //
  //   A→B→A. A swap that is UNDONE before this second observation reports the
  //   original identity, so the listing that came from B is attributed to A.
  //   Only a swap that PERSISTS past this line is caught.
  //
  //   Number reuse. Identity is dev/ino. Remove the classified directory and the
  //   filesystem may hand its inode number to the next one created at that path;
  //   both observations then read equal while naming different objects. This is
  //   the shape `path-containment.mjs` marks as the dangerous one — a REMEMBERED
  //   identity compared against a later observation — and unlike `sameDirectory`,
  //   which sees both directories inside one call, this code has a window.
  //   Directories cannot be hardlinked, so unlike the file case there is no way
  //   to force it deterministically on a real filesystem; the seam test named
  //   "the residual, executable" pins the behavior instead.
  //
  // Both need write access INSIDE the scanned root — the operator's own `$HOME`
  // — to provoke. That is the reason they are residual rather than blocking, and
  // it is a threat-model judgement, not a claim that the window is shut.
  let after = null;
  try {
    after = identityOf(await ctx.ops.statIdentity(candidate));
  } catch {
    after = null;
  }
  if (after !== identityKey) {
    ctx.seenCandidates.delete(identityKey);
    recordBucket(ctx.blocked, ctx.blockedTotals, 'candidate-moved', {
      path: safeOperatorText(candidate),
      reason: 'the directory changed identity between classification and listing; nothing about it is reported',
    });
    return;
  }

  records.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  // An unreadable listing has an UNKNOWN count, not a partial one presented as
  // whole. An empty but readable directory has a known count of 0 — a real
  // answer, and a different one.
  finding.record_count = finding.unreadable ? null : records.length;
  // The LISTING is bounded like every other list in this report; `record_count`
  // above is the exact number. Unbounded, a scan could hold 200,000 candidates
  // times 4,096 records in memory and produce an output nobody can read — or
  // none at all (cross-host review).
  finding.records = records.slice(0, ctx.caps.maxReportedPerBucket);
  finding.records_listed = finding.records.length;
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
  passwdHome = safePasswdHome(),
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
    // `lstat` never follows the final component — it is how the fixed suffix is
    // walked without crossing a symlink at any of its four parts.
    lstat: defaultLstat,
    // Identity is asked for in BigInt so dev/ino above 2^53 stay exact.
    statIdentity: (path) => defaultStat(path, { bigint: true }),
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
    // TWO reference points, not one.
    //
    // `os.homedir()` follows `$HOME`. Reproduced: running under an overridden
    // HOME made the REAL machine-global WAL a finding with removal wording —
    // the live fence, offered for removal, with no race and nothing in the
    // report to notice it by. `os.userInfo().homedir` reads the passwd entry
    // and ignores `$HOME`, so the two disagree exactly in the case that harms,
    // and a candidate matching EITHER is excluded.
    // `.filter(Boolean)` on the RESULTS was too late: `egressIntentDir(null)`
    // throws before the filter ever runs, so a uid with no passwd entry
    // crashed the scan outright. The inputs are filtered.
    liveWalDirs: [...new Set([homeDir, passwdHome].filter(Boolean).map((h) => egressIntentDir(h)))],
    repoLegacyDir: repoRoot ? egressIntentDir(repoRoot) : null,
    liveWalIdentityCache: null,
    repoLegacyIdentityCache: null,
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
    stats: { dirs_attempted: 0, dirs_scanned: 0, dirs_completed: 0, entries_seen: 0 },
    exhausted: false,
    exhaustedReason: null,
  };
  for (const entry of rootBlocked) recordBucket(ctx.blocked, ctx.blockedTotals, 'root', entry);
  // A `--skip` the operator named and that could not be resolved is NOT silently
  // dropped: the scan would then walk a tree they asked it not to, which is the
  // opposite of what they requested and (given one measured mount at ~286ms per
  // directory) can consume the whole budget.
  for (const entry of skipUnresolved) recordBucket(ctx.blocked, ctx.blockedTotals, 'skip', entry);

  for (const [index, root] of roots.entries()) {
    // A root the operator ALSO named in `--skip` is skipped, not walked. The
    // skip check used to run only on children, so `--root X --skip X` walked X
    // in full (cross-host review, reproduced).
    //
    // ANCESTRY, not only equality. A skip is a subtree boundary everywhere else
    // in this scan, and `--root ~/w/checkout --skip ~/w` starts the walk BELOW
    // the excluded directory — no entry is ever listed that could match it by
    // identity, so the checkout was walked in full while the report rendered
    // "skipped by operator: ~/w".
    //
    // Both sides were realpath'd, so this lexical containment is already
    // symlink-resolved. What it inherits from `isUnder` is case SENSITIVITY,
    // which is why the identity test stays beside it rather than being replaced
    // by it: the identity test is what still answers when one directory is
    // reached by two spellings.
    const skipAncestor = skips.find((s) => isUnder(root.canonical, s.canonical));
    if (ctx.skipIdentities.has(root.identity) || skipAncestor !== undefined) {
      recordPruned(ctx, root.canonical, 'operator-skip');
      continue;
    }
    await walkRoot(root, ctx);
    if (ctx.exhausted) {
      // Every root after this one is unexamined. Leaving them out of the totals
      // reported the scan as if those roots had simply held nothing.
      for (const remaining of roots.slice(index + 1)) {
        recordPruned(ctx, remaining.canonical, ctx.exhaustedReason ?? 'budget-exhausted');
      }
      break;
    }
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  const totals = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const sum = (map) => [...map.values()].reduce((s, n) => s + n, 0);
  // Sort BEFORE bounding so the listed sample is deterministic, then bound.
  const bound = (list) => list.slice().sort(byPath).slice(0, caps.maxReportedPerBucket);

  const blockedTotal = sum(ctx.blockedTotals);
  const blocked = bound(ctx.blocked);
  const notFollowed = bound(ctx.notFollowed);
  const pruned = bound(ctx.pruned);
  const exclusions = [...ctx.exclusions].sort(byPath);
  const allFindings = [...ctx.findings].sort((a, b) => a.dir.localeCompare(b.dir));
  // Findings are bounded too. They were the one list left unbounded, and a
  // hostile or merely enormous tree could put 200,000 of them in one report
  // (cross-host review). Bounding cannot change the STATUS — `findings_present`
  // keys on the total below, and a truncated non-empty list is still non-empty.
  const findingsTotal = allFindings.length;
  const findings = allFindings.slice(0, caps.maxReportedPerBucket);
  // An EMPTY, readable legacy directory holds nothing that can be in flight, so
  // there is nothing for the operator to act on and directory-level action is
  // forbidden. Counting it as an actionable finding meant the workflow could not
  // converge: the operator removes the last record, reruns, and is told
  // `findings_present` about a location with no records (cross-host review).
  // It is still REPORTED — the location is real — it just does not drive status.
  const actionable = allFindings.filter((f) => f.unreadable === true || (f.record_count ?? 0) > 0);

  // `scan_complete` describes the TRAVERSAL: every root was walked to its end
  // without a cap or the budget cutting it short. It is deliberately separate
  // from `blocked` — a scan can run to completion and still have failed to open
  // three directories, and the status function requires BOTH.
  const scanComplete = ctx.exhausted === false;
  const operatorSkipped = ctx.prunedTotals.get('operator-skip') ?? 0;
  const liveProbe = await liveWalIdentity(ctx);
  const liveWalState = liveProbe.unknown ? 'unknown' : (liveProbe.keys.size > 0 ? 'present' : 'absent');
  // The count and the display list are passed separately, because bounding must
  // never be able to turn a blocked scan into a clean one.
  const status = resolveDiscoveryStatus({
    // An UNIDENTIFIABLE live fence means nothing below has been proven not to be
    // it, so no finding is safely actionable and the report must withhold every
    // removal instruction. A definitively ABSENT fence is a different answer —
    // a machine that never ran the proof has none, and every legacy directory
    // there really is legacy — so that state keeps its guidance and carries a
    // caveat instead. The review proposed treating both alike; conflating "I
    // could not tell" with "there is none" would make the common case unusable.
    scanComplete: scanComplete && liveWalState !== 'unknown',
    blocked,
    blockedTotal,
    findings: actionable,
    directoriesExamined: ctx.stats.dirs_scanned,
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
        max_reported_per_bucket: caps.maxReportedPerBucket,
      },
    },
    // The reference point the exclusion was decided against, ALWAYS reported —
    // present or not, reached or not. An overridden `$HOME` used to make the
    // real fence a finding with nothing in the report to notice it by; naming
    // what the scan treated as the fence is what makes that visible.
    live_wal: {
      compared_against: ctx.liveWalDirs.map((d) => safeOperatorText(d)),
      state: liveWalState,
    },
    exclusions,
    findings,
    findings_total: findingsTotal,
    actionable_total: actionable.length,
    overall: { status, guidance: guidanceFor(status, { operatorSkipped, liveWalState }) },
    residual: buildResidual({ roots, ctx, prunedTotal: sum(ctx.prunedTotals), notFollowedTotal: sum(ctx.notFollowedTotals), operatorSkipped, liveWalState }),
    mutation_boundary: {
      writes_allowed: 'none',
      forbidden: [
        // Phrased WITHOUT a removal verb on purpose. The obvious wording ("no
        // file is created, moved, or removed") put `removed` into every report,
        // including incomplete ones where the contract is that no removal verb
        // appears at all. The alternative was to carve the mutation-boundary
        // block out of that check — and a carve-out is exactly where a real leak
        // would later hide. Rewording keeps the property literally true.
        'this command makes no change to any file or directory',
        // Scoped honestly rather than claimed absolutely. The SCAN spawns no
        // subprocess — that is the ADR-0035 R0 condition. The `/runtime:migrate`
        // wrapper does run `git rev-parse` to resolve the repo root, as every
        // runtime command does, and a flat "spawns nothing" was false at the
        // surface the operator actually invokes (cross-host review).
        'the scan spawns no subprocess (the /runtime:migrate wrapper resolves the repo root with git rev-parse, like every runtime command)',
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
      const key = identityOf(await ops.statIdentity(canonical));
      if (key === null) throw Object.assign(new Error('EIDENTITY'), { code: 'unrepresentable-identity' });
      identities.add(key);
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

function guidanceFor(status, { operatorSkipped = 0, liveWalState = 'present' } = {}) {
  const base = status === DISCOVERY_STATUS.incomplete
    ? GUIDANCE.incomplete
    : (status === DISCOVERY_STATUS.findings ? GUIDANCE.findings : GUIDANCE.none);
  const caveats = [];
  // A deliberate exclusion is not the same class as a depth cap, and burying it
  // in a combined prune total is how the DOCUMENTED invocation came to return a
  // reassuring status over a real pre-upgrade record sitting in the skipped
  // mount (reproduced on the dogfood machine). It is named in the guidance the
  // operator reads, not only in a count further down.
  if (operatorSkipped > 0) {
    caveats.push(`You excluded ${operatorSkipped} location(s) with --skip; nothing under them was examined, and a separate checkout commonly lives on exactly the mount an operator is tempted to exclude.`);
  }
  if (liveWalState === 'absent') {
    // Worded without a removal verb: this sentence must be able to appear in an
    // INCOMPLETE report, where the contract is that no removal verb appears at
    // all. Saying "acting on it" carries the same warning and keeps the
    // whole-document assertion literally true.
    caveats.push('No machine-global WAL was found at the locations this scan treated as the live fence (see live_wal.compared_against). If your runtime keeps it elsewhere — a different $HOME, another user — then a location listed below may BE that fence, and acting on it would defeat the protection this scan exists to preserve.');
  }
  if (liveWalState === 'unknown') {
    caveats.push('The live fence could not be identified (see live_wal.compared_against); nothing below has been proven not to be it.');
  }
  return caveats.length > 0 ? `${base} ${caveats.join(' ')}` : base;
}

// The limits of this answer, in every output format. The first one is
// irreducible: closing it would need a full-filesystem scan (disproportionate)
// or a checkout registry (which does not exist).
function buildResidual({ roots, ctx, prunedTotal, notFollowedTotal, operatorSkipped = 0, liveWalState = 'present' }) {
  const residual = [
    `checkouts outside the scanned roots are not covered (scanned: ${roots.length} root(s))`,
    'the time budget is cooperative — it is checked between directory reads and cannot preempt one stuck syscall; a single remote mount was measured at ~286ms per directory, so --skip is the lever for that case',
    'a directory component can be replaced between the listing that named it and the read that opens it (TOCTOU); the scan is read-only, so the worst outcome is listing a directory that was not intended',
    'the post-listing identity re-check is DETECTION, not binding: it catches a replacement that PERSISTS, and misses one that is undone before the re-check (A→B→A), because Node exposes no readdir-from-descriptor to tie the listing to the object that was classified',
    // NO REMOVAL VERB, like every other line that can appear in an incomplete
    // report. The first wording said "a removed directory can have its number
    // reused" and put `removed` into every report this command emits — the exact
    // shape the mutation_boundary phrasing above was already rewritten to avoid,
    // caught here by the same test (which is why that test exists).
    'directory identity is dev/ino, and those numbers can be reused: if the classified directory goes away mid-scan and the filesystem hands its number to a new one at the same path, the re-check reads "unchanged" while the records listed came from a different object',
    'the annotation already_fenced_by_current_doctor is FALSE when identity could not be decided — it costs a review, never skips one',
  ];
  if (ctx.exhaustedReason) {
    residual.push(`the walk ended early (${ctx.exhaustedReason}); every directory still queued is counted under scan.pruned and was never examined`);
  }
  // Operator exclusions get their OWN line. Folded into the combined prune
  // total they were indistinguishable from 41,833 routine depth caps.
  if (operatorSkipped > 0) residual.push(`${operatorSkipped} location(s) were excluded by --skip and were NOT examined — this result says nothing about them`);
  if (liveWalState !== 'present') residual.push(`the live machine-global WAL was ${liveWalState} at the locations compared against — see live_wal`);
  if (prunedTotal > 0) residual.push(`${prunedTotal} location(s) were not descended into in total (including any --skip above) — see scan.pruned_by_reason`);
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
  lines.push(`- dirs: attempted=${report.scan.stats.dirs_attempted}; opened=${report.scan.stats.dirs_scanned}; completed=${report.scan.stats.dirs_completed}; entries=${report.scan.stats.entries_seen}; elapsed_ms=${report.scan.stats.elapsed_ms}`);
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
  lines.push('Live fence (the reference point every exclusion was decided against)');
  lines.push(`- state: ${report.live_wal.state}`);
  for (const path of report.live_wal.compared_against) lines.push(`- compared against: ${path}`);
  lines.push('');
  lines.push('Exclusions');
  if (report.exclusions.length === 0) lines.push('- (none)');
  for (const entry of report.exclusions) lines.push(`- ${entry.path} — ${entry.reason}`);
  lines.push('');
  lines.push(`Findings (${report.findings_total}; ${report.actionable_total} hold records or could not be listed)`);
  if (report.findings_total === 0) lines.push('- (none in the scanned scope)');
  for (const finding of report.findings) {
    const count = finding.record_count === null ? 'unknown' : String(finding.record_count);
    lines.push(`- ${finding.dir}`);
    lines.push(`  checkout: ${finding.checkout_root}`);
    lines.push(`  records: ${count}${finding.unreadable ? ` (INCOMPLETE — ${finding.unreadable_reason})` : ''}${finding.already_fenced_by_current_doctor ? '; already fenced by the current checkout’s doctor' : ''}`);
    for (const record of finding.records) lines.push(`    ${record.name} [${record.kind}]`);
    if (finding.record_count !== null && finding.record_count > finding.records_listed) {
      lines.push(`    … and ${finding.record_count - finding.records_listed} more (listing bounded; the count above is exact)`);
    }
  }
  if (report.findings_total > report.findings.length) {
    lines.push(`- … and ${report.findings_total - report.findings.length} more location(s) (listing bounded; the count above is exact)`);
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
