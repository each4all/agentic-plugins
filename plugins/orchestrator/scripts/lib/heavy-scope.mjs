// plugins/orchestrator/scripts/lib/heavy-scope.mjs
//
// The scope of a mutation-harness test launch (ADR-0023 §6, amendments of
// 2026-11-22 and 2026-11-24, C181; C154). A test run leads a process group of
// its own, which the harness stops at every end; a process that leaves the
// group (a detached spawn, `setsid`, a nested `agentic-autopilot heavy`)
// outlives every group signal. Where the user manager can make one, each test
// launch therefore starts in a scope of its own (lib/scope-launch.mjs), whose
// kill (lib/scope-reader.mjs) reaches what left the group. The launch's
// identity is recorded on its heavy-work ownership entry (lib/heavy-lock.mjs
// registerGroup, `recordScope`) before the gate's word, and names the harness
// as the scope's supervisor.
//
// This file holds what the harness and the lock's readers need of such an
// entry, apart from the lock itself:
//
//   planHarnessScope  whether this process makes scopes for its launches, and
//                     where it makes none, the record that says why (no user
//                     manager here, or the harness runs inside another
//                     launcher's scope, whose kill already covers it);
//   harnessOwner      the identity's owner: the ownership's token and the
//                     entry's name, which exist only once the group is
//                     registered;
//   entryScope        what an entry's `scope` grants its reader: a scope bound
//                     to this very entry (token, name, gate pid), withheld (a
//                     version this reader does not know), or no authority;
//   endHarnessScope   the harness's own end of a launch's scope: the kill under
//                     every check, then fresh readings up to
//                     SCOPE_EMPTY_WAIT_MS;
//   scopeCollector    a lock reader's collector (ADR-0023, readers' budget):
//                     for each pass over the entries of an ownership, every
//                     owed kill first (bound scope, supervisor proven gone),
//                     then one fresh reading of each scope, with no wait.
//
// A collector keeps, for its process, the supervisors it proved gone (gone is
// final) and the kills it wrote (one invocation writes a scope's kill once); a
// withheld kill is no write and is tried again at the next pass. It never
// caches a reading: a loop that already polls reads each scope again at each
// pass, and the pass that reads gone lets the loop go on.

import { SCOPE_EMPTY_WAIT_MS, scopeRecordState } from './scope.mjs';
import { launcherPlacement, noScopeRecord, scopeAvailability, scopeUnitName } from './scope-launch.mjs';
import { SYSTEM, createScopeEnder, readScopeOnce, supervisorGone } from './scope-reader.mjs';

// How often the harness reads its own killed scope while it waits for gone.
const GONE_POLL_MS = 50;

function sleep(ms) {
  return new Promise((wake) => {
    setTimeout(wake, ms);
  });
}

/**
 * Whether this process makes a scope for each test launch: `{ kind: 'gated' }`,
 * or `{ kind: 'direct', record, why }` with the `scope` record an entry keeps
 * (`none`, with its reason) and, where the check failed rather than said no,
 * why. Never throws.
 */
export function planHarnessScope({ system = SYSTEM } = {}) {
  try {
    const availability = scopeAvailability({ system });
    if (!availability.available) return { kind: 'direct', record: noScopeRecord('unavailable'), why: availability.check };
    const placement = launcherPlacement({ system });
    if (placement.inside === true) return { kind: 'direct', record: noScopeRecord('inside-launcher', placement.enclosingUnit), why: null };
    if (placement.inside !== false) return { kind: 'direct', record: noScopeRecord('unavailable'), why: placement.withheld ?? 'placement' };
    return { kind: 'gated' };
  } catch (err) {
    return { kind: 'direct', record: noScopeRecord('unavailable'), why: `check-failed: ${String(err?.message ?? err)}` };
  }
}

/** The identity's owner for the entry `entryName` of the ownership `token`. */
export function harnessOwner(token, entryName) {
  return { kind: 'harness-launch', token, entry: entryName };
}

/**
 * A scope unit name, used once, for a test launch of the harness `pid`. It is
 * made before the launch is registered (the entry is named by the group, which
 * exists only once the gate runs), so the unit carries the harness's pid and a
 * random suffix, and the identity binds the unit to the entry.
 */
export function harnessUnitName(pid = process.pid) {
  return scopeUnitName(`harness-${pid}`);
}

/**
 * What the `scope` of the ownership entry `entry`, listed as `name` in the
 * ownership of `token`, grants its reader:
 *   { held: 'scoped', identity }   a whole identity bound to this entry: its
 *                                  owner is a harness launch naming this token
 *                                  and this entry, and its gate is the entry's
 *                                  group leader;
 *   { held: 'withheld', check }    a `scope` of a version this reader does not
 *                                  know: read withheld, so the entry counts as
 *                                  running (fail-closed);
 *   { held: null, state }          no authority outside the group: no scope
 *                                  (an earlier release's entry, or none made),
 *                                  one abandoned before the word, a malformed
 *                                  one, or one bound to another entry (a copied
 *                                  identity grants nothing).
 */
export function entryScope(entry, { token, name }) {
  const s = scopeRecordState(entry);
  if (s.state === 'unknown-version') return { held: 'withheld', check: 'unknown-version' };
  if (s.state !== 'scoped') return { held: null, state: s.state };
  const { identity } = s;
  const owner = identity.owner;
  if (owner.kind !== 'harness-launch' || owner.entry !== name || owner.token !== token || identity.gate.pid !== entry.pgid) {
    return { held: null, state: 'unbound' };
  }
  return { held: 'scoped', identity };
}

// A reading that never throws.
function readOnce(identity, system) {
  try {
    return readScopeOnce(identity, { system });
  } catch {
    return { state: 'withheld', check: 'reading-failed' };
  }
}

/**
 * The harness's own end of a launch's scope (ADR-0023, amendment of
 * 2026-11-24, the mutation harness): the kill under every check, written at
 * once, then fresh readings until one reads gone or SCOPE_EMPTY_WAIT_MS passes.
 * A kill withheld or refused gets one reading, which needs no authority.
 * Resolves the reading `{ state, check? }`.
 */
export async function endHarnessScope(identity, { system = SYSTEM, waitMs = SCOPE_EMPTY_WAIT_MS, pollMs = GONE_POLL_MS } = {}) {
  const ender = createScopeEnder({ system });
  let kill;
  try {
    kill = ender.kill(identity);
  } catch {
    kill = { state: 'withheld', check: 'kill-failed' };
  }
  if (kill.state === 'gone') return { state: 'gone', ...(kill.check ? { check: kill.check } : {}) };
  if (kill.state !== 'written') {
    try {
      return ender.read(identity);
    } catch {
      return { state: kill.state, check: kill.check };
    }
  }
  const until = system.now() + waitMs;
  for (;;) {
    const reading = readOnce(identity, system);
    if (reading.state === 'gone' || system.now() >= until) return reading;
    await sleep(pollMs);
  }
}

// The canonical key of a supervisor or a scope: its fields, in a fixed order.
const supervisorKey = (s) => `${s.pid}/${s.fingerprint?.starttime}/${s.clock}/${s.boot_id}`;
const scopeKey = (id) => `${id.unit}/${id.invocation_id}/${id.cgroup_id}/${id.boot_id}`;

/**
 * A lock reader's collector of harness scopes. `pass(items)` takes one pass's
 * scoped entries, `[{ identity, groupRunning }]`, and answers, in order, the
 * reading of each: `{ state, check? }`. Every owed kill is written first: a
 * scope whose supervisor (the harness that launched it) is proven gone, once
 * per process; then each scope is read once, its group running or not (a
 * group that runs keeps its entry held whatever the scope reads). The seams
 * are for tests.
 */
export function scopeCollector({
  system = SYSTEM,
  proveGone = (supervisor) => supervisorGone(supervisor, { system }),
  killScope = (identity) => createScopeEnder({ system }).kill(identity),
  readScope = (identity) => readScopeOnce(identity, { system }),
} = {}) {
  const proven = new Set();
  const kills = new Map();
  return {
    pass(items) {
      const withheld = new Map();
      for (const { identity } of items) {
        const key = scopeKey(identity);
        if (kills.has(key)) continue;
        const sup = supervisorKey(identity.supervisor);
        if (!proven.has(sup)) {
          let gone = false;
          try {
            gone = proveGone(identity.supervisor)?.gone === true;
          } catch {
            gone = false;
          }
          if (!gone) continue;
          proven.add(sup);
        }
        let kill;
        try {
          kill = killScope(identity);
        } catch {
          kill = { state: 'withheld', check: 'kill-failed' };
        }
        // A withheld kill is no write: the next pass tries it again.
        if (kill.state === 'withheld') withheld.set(key, kill);
        else kills.set(key, kill);
      }
      return items.map(({ identity }) => {
        const key = scopeKey(identity);
        const kill = kills.get(key) ?? withheld.get(key) ?? null;
        if (kill?.state === 'gone') return { state: 'gone', ...(kill.check ? { check: kill.check } : {}) };
        let reading;
        try {
          reading = readScope(identity);
        } catch {
          reading = { state: 'withheld', check: 'reading-failed' };
        }
        if (reading.state === 'gone' || reading.state === 'emptied') return reading;
        if (kill !== null && (kill.state === 'withheld' || kill.state === 'refused')) return { state: kill.state, check: kill.check };
        return reading;
      });
    },
  };
}

let shared = null;

/** The collector of this process, made at its first use. */
export function processCollector() {
  shared ??= scopeCollector();
  return shared;
}

/** How a held entry is named in a line: its group, and its scope's unit with how to stop it by hand. */
export function heldText(g) {
  const group = g.pgid ?? 'unreadable';
  if (!g.scope) return `${group}`;
  if (!g.scope.unit) return `${group} (its scope is ${g.scope.state}${g.scope.check ? `: ${g.scope.check}` : ''})`;
  return `${group} (its scope ${g.scope.unit} is ${g.scope.state}; the owner may stop it with systemctl --user stop ${g.scope.unit})`;
}
