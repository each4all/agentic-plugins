// plugins/runtime/scripts/lib/assurance-contract.mjs
//
// ADR-0054 §Decision 2 — the SEMANTIC half of the compatibility assurance
// record. `data/schemas/runtime-host-assurance-1.0.json` carries the structure;
// this module carries everything the validator's closed keyword subset provably
// cannot express, and the membership matcher ADR-0053 §Decision 5 requires.
//
// The split is the repository's existing one, not a new invention.
// `lib/evidence-contract.mjs` exists for the same missing `oneOf` and says so;
// `lib/plugin-set.mjs` splits `loadPluginSet` from `validatePluginSet` the same
// way. ADR-0054 measured eight semantic cases passing the real validator that
// must not be accepted (duplicate ids, `granted` + `revoked` over one cohort, a
// `supersedes` naming a nonexistent id, `packages: {}`, `cohort: []`, a
// `consumed` + `not-applicable` residual, a future `reviewed_at`, and the
// calendar-invalid `2026-13-45`). Those eight are the reason this file exists,
// and each has a test.
//
// TWO FUNCTIONS, TWO QUESTIONS, and keeping them apart is the point:
//
//   `assuranceRecordIssues`  — is this record COHERENT? A pure predicate over
//                              the record alone. Its answer does not depend on
//                              any machine.
//   `matchAssurance`         — is THIS machine a member of what a human
//                              granted? Membership evaluation only
//                              (ADR-0053 §Decision 5). It never derives a
//                              grant, never widens one, and has no path that
//                              turns absence of evidence into coverage.
//
// ⚠ THE ONE INVARIANT THIS FILE EXISTS TO HOLD. `matchAssurance` returns
// `covered` only when a human-authored grant names this exact host pair, that
// grant's package bindings all hold on every host the plugin set says the
// package runs on, nothing in the record contradicts it, and no unobservable
// condition was attached. Every other path returns `unassured`. There is no
// third state, no partial credit, and no reason string that a caller may read
// as "close enough" — ADR-0053 §Decision 3: negative and unknown win over
// positive at every layer.
//
// Deliberately NOT here: reading the baseline (host-parity-baseline.mjs owns
// the grammars and the packaged-asset resolution), the doctor report shape
// (ADR-0054 §Decision 4's nested `host_parity_assurance` result), the minimum
// assurance-capable runtime floor (§Decision 5 puts it in `plugin-set.json`,
// enforced at bootstrap and cutover), and the cross-tag monotonicity check
// (§Decision 8 — `scripts/check-assurance-monotonicity.mjs`, a repo-level gate
// over release history rather than a runtime read).

import { ASSURANCE_SCHEMA_VERSION, readVersionToken } from './host-parity-baseline.mjs';
import { isSemVer } from './semver.mjs';

const HOSTS = Object.freeze(['claude', 'codex']);

/** The grant states, in the schema's enum order. */
export const ASSURANCE_GRANT_STATES = Object.freeze(['granted', 'revoked', 'superseded']);

/**
 * A grant's POLARITY, which is what negative-wins resolves over.
 *
 * `superseded` is negative for the same reason `revoked` is: it is a tombstone.
 * ADR-0054 §Decision 8 requires removing a positive grant to leave one, and a
 * tombstone that still read as coverage would be a tombstone in name only.
 */
const NEGATIVE_STATES = new Set(['revoked', 'superseded']);

/** The complete match vocabulary. Two values, and that is deliberate. */
export const ASSURANCE_MATCH_STATES = Object.freeze(['covered', 'unassured']);

/**
 * Predicate keys and why runtime cannot observe them (ADR-0053 §Decision 5).
 *
 * ALL THREE are unobservable in this release, so any `predicate` narrows its
 * grant to `unassured`. That is not a stub — it is the only reading of
 * §Decision 5 that holds for each key on measurement:
 *
 *   - `models`: the active model is a property of the host SESSION. Nothing a
 *     runtime script can read reports it; `machine-probe.mjs` probes CLI
 *     versions, auth status and installed plugins, and none of those is the
 *     model in use for the turn that spawned the script.
 *   - `integrations`: whether the operator is in the terminal, Desktop, VS Code
 *     or the web app is likewise session-scoped, and the framework has no
 *     host-native probe for it. `docs/assurance/statusline-host-truth-*.md`
 *     records the same limit for a neighbouring fact.
 *   - `env_flags`: these LOOK observable — `process.env` is right there — and
 *     that is exactly the trap. A runtime script's environment is the one it
 *     was spawned with, which a wrapper, a launcher, or a hook may have
 *     changed; it is not a witness to what the host session runs under. Reading
 *     it would produce a positive derived from something the reviewer did not
 *     scope. Turning any of these three observable is a deliberate change that
 *     owes its own measurement of what is actually being witnessed.
 *
 * A reviewer may still record a predicate: it documents the scope of the review
 * for a human. It just cannot produce coverage, which is the fail-closed
 * direction and the one §Decision 5 names.
 */
export const UNOBSERVABLE_PREDICATE_KEYS = Object.freeze({
  models: 'the active model is a host-session property no runtime probe reports',
  integrations: 'the host integration surface (terminal/Desktop/VS Code/JetBrains/web) has no host-native probe',
  env_flags: "a script's own environment is not a witness to the host session's environment",
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Calendar validity, not shape — the schema's `pattern` already fixed the shape
 * and ADR-0054 measured `2026-13-45` passing it.
 *
 * Round-tripping through `Date` is what catches a day that does not exist in
 * the month it names: `new Date('2026-02-30')` is a real Date object pointing
 * at March 2, so only comparing the formatted result back to the input rejects
 * it. `Date.parse` alone would not.
 */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Do two reviewed host tuples name the same pair? Used to detect duplicate
 * cohort entries and overlapping grants.
 *
 * Compared as WRITTEN, not by version identity, because two spellings of one
 * release (`0.147.0` and `0.147.0+build.5`) are different tuples to the
 * membership matcher below and must stay different here too — otherwise the
 * duplicate check and the matcher would disagree about what "the same cohort"
 * means.
 */
function sameTuple(a, b) {
  return HOSTS.every((host) => String(a?.[host]) === String(b?.[host]));
}

/**
 * SEMANTIC validation of an assurance record. Returns a `string[]` of
 * violations; empty means coherent.
 *
 * Structure is NOT re-checked here beyond the minimum needed to walk the
 * record safely — `parseAssuranceSection` has already run the packaged schema,
 * and duplicating its work would create the second grammar ADR-0051
 * §Decision 4 forbids. What IS re-checked is anything a caller reaching this
 * function directly could otherwise skip past: a non-object record, a missing
 * `grants` array, an unknown `state`. Those are cheap and fail closed.
 *
 * `today` is injected so the future-`reviewed_at` rule is testable; omitted, it
 * reads the real clock, because a rule that silently does not run is the hole
 * this module exists to close.
 */
export function assuranceRecordIssues(record, { today = null } = {}) {
  if (!isPlainObject(record)) return ['assurance record is not an object'];
  const issues = [];
  const err = (msg) => issues.push(msg);

  if (record.schema !== ASSURANCE_SCHEMA_VERSION) {
    err(`schema must be "${ASSURANCE_SCHEMA_VERSION}", got ${JSON.stringify(record.schema)}`);
  }
  if (!Array.isArray(record.grants)) return [...issues, 'grants must be an array'];

  const now = today ?? todayISO();
  const byId = new Map();
  const seenIds = new Set();

  // Pass 1 — per-grant coherence and the id index the cross-grant pass needs.
  record.grants.forEach((grant, index) => {
    const at = `grants[${index}]`;
    if (!isPlainObject(grant)) {
      err(`${at} is not an object`);
      return;
    }
    const id = typeof grant.id === 'string' ? grant.id : null;
    if (!id) {
      err(`${at}.id must be a string`);
    } else if (seenIds.has(id)) {
      // ADR-0054's first measured semantic case. Two grants sharing an id make
      // `supersedes`/`reapproval_of` ambiguous and make the cross-tag
      // monotonicity check unable to say which record was mutated.
      err(`${at}.id "${id}" is a duplicate — grant ids are immutable identities and must be unique`);
    } else {
      seenIds.add(id);
      byId.set(id, { grant, index });
    }

    if (!ASSURANCE_GRANT_STATES.includes(grant.state)) {
      err(`${at}.state must be one of ${ASSURANCE_GRANT_STATES.join(', ')}, got ${JSON.stringify(grant.state)}`);
    }

    if (!isCalendarDate(grant.reviewed_at)) {
      err(`${at}.reviewed_at ${JSON.stringify(grant.reviewed_at)} is not a calendar date`);
    } else if (grant.reviewed_at > now) {
      // String comparison is sound for zero-padded ISO dates and avoids a
      // timezone argument the record does not carry.
      err(`${at}.reviewed_at ${grant.reviewed_at} is in the future (today is ${now}) — a review that has not happened is not evidence`);
    }

    // Vacuous positives (ADR-0054 §Decision 2). Both are enforced for EVERY
    // state, not only `granted`: a revoked record with an empty cohort names
    // nothing it withdrew, and the cross-tag check compares its contents.
    if (!Array.isArray(grant.cohort) || grant.cohort.length === 0) {
      err(`${at}.cohort is empty — a grant that names no reviewed host tuple covers nothing (ADR-0053 §Decision 7)`);
    } else {
      grant.cohort.forEach((tuple, i) => {
        const dup = grant.cohort.findIndex((other) => sameTuple(tuple, other));
        if (dup !== i) err(`${at}.cohort[${i}] repeats cohort[${dup}] — a reviewed tuple is listed twice`);
      });
    }

    if (!isPlainObject(grant.packages) || Object.keys(grant.packages).length === 0) {
      err(`${at}.packages is empty — a grant must name the consuming package set it was reviewed against (ADR-0053 §Decision 8)`);
    }

    // Residual coherence (ADR-0053 §Decision 6).
    if (Array.isArray(grant.residuals)) {
      const surfaces = new Set();
      grant.residuals.forEach((residual, i) => {
        if (!isPlainObject(residual)) return;
        if (residual.consumption === 'consumed' && residual.disposition === 'not-applicable') {
          err(`${at}.residuals[${i}] is consumed AND not-applicable — a surface this framework consumes cannot be inapplicable`);
        }
        if (residual.consumption === 'unadopted' && residual.consuming_package) {
          err(`${at}.residuals[${i}] is unadopted but names consuming_package "${residual.consuming_package}" — unadopted means no package consumes it`);
        }
        if (typeof residual.surface === 'string') {
          if (surfaces.has(residual.surface)) {
            err(`${at}.residuals[${i}].surface "${residual.surface}" is listed twice — two dispositions for one surface is a contradiction, not two residuals`);
          }
          surfaces.add(residual.surface);
        }
      });
    }

    if (grant.reapproval_of !== undefined && grant.reapproval_of === id) {
      err(`${at}.reapproval_of names its own id — a grant cannot re-approve itself`);
    }
    if (Array.isArray(grant.supersedes)) {
      grant.supersedes.forEach((target, i) => {
        if (target === id) err(`${at}.supersedes[${i}] names its own id`);
        if (grant.supersedes.indexOf(target) !== i) err(`${at}.supersedes[${i}] repeats "${target}"`);
      });
    }
  });

  // Pass 2 — cross-grant references and polarity. Needs the complete id index,
  // so it cannot be folded into pass 1: a grant may legitimately supersede one
  // declared after it.
  const supersededBy = new Map();
  const reapprovedBy = new Map();
  for (const [id, { grant }] of byId) {
    for (const target of Array.isArray(grant.supersedes) ? grant.supersedes : []) {
      if (!byId.has(target)) {
        err(`grant "${id}" supersedes "${target}", which no grant in this record declares — a dangling reference cannot retire anything`);
        continue;
      }
      if (!supersededBy.has(target)) supersededBy.set(target, []);
      supersededBy.get(target).push(id);
    }
    const reapproval = grant.reapproval_of;
    if (reapproval === undefined || reapproval === id) continue;
    if (!byId.has(reapproval)) {
      err(`grant "${id}" declares reapproval_of "${reapproval}", which no grant in this record declares`);
      continue;
    }
    const target = byId.get(reapproval).grant;
    if (target.state !== 'revoked') {
      // Re-approval is the ONE path where a positive outranks a negative, so
      // its precondition is checked rather than assumed: only a revocation can
      // be re-approved. A `reapproval_of` pointing at a live grant would be a
      // duplicate wearing a retirement's clothes.
      err(`grant "${id}" re-approves "${reapproval}", whose state is "${target.state}" — only a revoked grant can be re-approved (ADR-0054 §Decision 8)`);
    }
    if (isCalendarDate(grant.reviewed_at) && isCalendarDate(target.reviewed_at) && grant.reviewed_at < target.reviewed_at) {
      err(`grant "${id}" re-approves "${reapproval}" but was reviewed earlier (${grant.reviewed_at} < ${target.reviewed_at}) — a re-approval cannot predate what it re-approves`);
    }
    if (!reapprovedBy.has(reapproval)) reapprovedBy.set(reapproval, []);
    reapprovedBy.get(reapproval).push(id);
  }

  for (const [id, { grant }] of byId) {
    const retiredBy = [...(supersededBy.get(id) ?? []), ...(reapprovedBy.get(id) ?? [])];
    if (grant.state === 'granted' && retiredBy.length > 0) {
      // The record would read one way to the machine and the opposite way to a
      // human scanning `state:` fields. `matchAssurance` resolves this
      // negative-wins regardless; it is an issue here so an author fixes the
      // record rather than relying on the matcher to paper over it.
      err(`grant "${id}" has state "granted" but is retired by ${retiredBy.join(', ')} — mark it revoked or superseded`);
    }
    if (grant.state === 'superseded' && (supersededBy.get(id) ?? []).length === 0) {
      err(`grant "${id}" has state "superseded" but no grant supersedes it — a retirement with no successor is a revocation`);
    }
  }

  // Contradictory polarity over one reviewed tuple, unexplained by a
  // retirement. ADR-0054's second measured case, narrowed by the exemption a
  // naive version gets wrong: a revoked grant beside its own re-approval IS
  // `granted` + `revoked` over the same cohort, and it is the mechanism
  // §Decision 8 prescribes.
  const positives = [...byId].filter(([, { grant }]) => grant.state === 'granted');
  const negatives = [...byId].filter(([, { grant }]) => NEGATIVE_STATES.has(grant.state));
  for (const [posId, { grant: pos }] of positives) {
    for (const [negId, { grant: neg }] of negatives) {
      const explained = (Array.isArray(pos.supersedes) && pos.supersedes.includes(negId))
        || pos.reapproval_of === negId;
      if (explained) continue;
      const overlap = (Array.isArray(pos.cohort) ? pos.cohort : []).filter((tuple) =>
        (Array.isArray(neg.cohort) ? neg.cohort : []).some((other) => sameTuple(tuple, other)));
      if (overlap.length === 0) continue;
      err(
        `grants "${posId}" (granted) and "${negId}" (${neg.state}) both name host tuple `
        + `${JSON.stringify(overlap[0])} with no supersedes/reapproval_of link between them — `
        + 'a contradiction, not two grants',
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Observation — machine facts, list-authoritative, ambiguity preserved
// ---------------------------------------------------------------------------

/**
 * Normalize `machine-probe.mjs`'s per-host installed-plugin facts into the one
 * shape the matcher reads.
 *
 * ⚠ THIS DELIBERATELY DOES NOT USE `doctor.mjs`'s `summarizePluginStatus`, and
 * ADR-0054 §Decision 9 says so by name. That function's `codexListInstalled`
 * counts `decision === 'disabled'` toward `available`, so a DISABLED Codex
 * install reports as available — and "is disabled" is one of the three things
 * ADR-0053 §Decision 8 requires to invalidate a grant. Reusing the coarse
 * status would make the invalidation structurally unable to fire.
 *
 * LIST-AUTHORITATIVE ONLY. A `fallback` decision means the list probe did not
 * succeed and the answer is coming from a filesystem cache; that is evidence
 * about what is on disk, not about what the host will load. The matcher treats
 * it as unknown, which blocks. The cache scanner collapses multiple installed
 * versions to the newest and is therefore ANOTHER ambiguity-losing producer —
 * it needs no fix here precisely because a cache-sourced answer never reaches
 * a positive.
 *
 * Each entry carries `ambiguous` and the count that produced it, because
 * ADR-0053 §Decision 5 makes an ambiguous match `unassured` and a matcher that
 * received a pre-collapsed answer could not tell.
 */
export function observePackages({ claudePluginList = null, codexPluginList = null } = {}) {
  const claude = {};
  for (const [name, row] of Object.entries(isPlainObject(claudePluginList) ? claudePluginList : {})) {
    claude[name] = {
      present: true,
      version: typeof row?.version === 'string' ? row.version.trim() : null,
      // `enabled` is TRISTATE and the third value is load-bearing: Claude's
      // text list prints `Status: enabled` or `Status: failed`, and anything
      // else (including no Status line at all) is unknown rather than enabled.
      enabled: row?.status === 'enabled' ? true : row?.status === 'failed' ? false : null,
      ambiguous: row?.ambiguous === true,
      observations: Number.isInteger(row?.observations) ? row.observations : 1,
      source: 'list',
    };
  }

  const codex = {};
  const codexStatus = codexPluginList?.status ?? 'unavailable';
  if (codexStatus === 'available') {
    for (const [name, row] of Object.entries(isPlainObject(codexPluginList?.entries) ? codexPluginList.entries : {})) {
      codex[name] = {
        present: row?.status !== 'not_installed',
        version: typeof row?.version === 'string' ? row.version.trim() : null,
        enabled: row?.status === 'enabled' ? true : (row?.status === 'disabled' ? false : (typeof row?.enabled === 'boolean' ? row.enabled : null)),
        ambiguous: row?.ambiguous === true,
        observations: Number.isInteger(row?.observations) ? row.observations : 1,
        source: 'list',
      };
    }
  }

  return {
    claude: { authoritative: isPlainObject(claudePluginList), packages: claude },
    // Anything but `available` is non-authoritative — an older Codex without
    // the subcommand, a nonzero exit, a parse error, an empty list.
    codex: { authoritative: codexStatus === 'available', packages: codex, list_status: codexStatus },
  };
}

// ---------------------------------------------------------------------------
// Membership matching — ADR-0053 §Decision 5
// ---------------------------------------------------------------------------

/**
 * Is an observed host version the SAME RELEASE as a reviewed one?
 *
 * Normalized identity equality, never precedence (ADR-0054 §Decision 7). The
 * comparator this module could have called — `classifyVersionRelation` — is
 * deliberately not in this path: it exists to RECORD direction, and direction
 * is evidence that ADR-0053 §Decision 9 forbids promoting to coverage. Keeping
 * the two code paths separate means a future change to the comparator's
 * `exact` field cannot silently widen what is covered. A test pins them to the
 * same answers over ADR-0054's direction table, so the separation costs no
 * drift.
 *
 * The token grammar itself IS shared, from the module that owns grammars, and
 * `truncated` is why. `SEMVER_RE` matches the first three components of
 * `1.2.3.4`, so a four-component observed version would compare exactly equal
 * to a genuine `1.2.3` — the one row ADR-0054's direction table records as
 * `false-exact`. Refusing a truncated token is what §Decision 7 means by
 * "requiring the observed token's component count to match", and it tightens
 * exactness rather than relaxing it.
 */
function sameRelease(observed, reviewed) {
  const o = readVersionToken(observed);
  const r = readVersionToken(reviewed);
  if (!o.token || !r.token || o.truncated || r.truncated) return false;
  return o.token === r.token;
}

function unassured(reasons, extra = {}) {
  return {
    state: 'unassured',
    grant_id: null,
    reasons: Object.freeze([...reasons]),
    ...extra,
  };
}

/**
 * Which hosts must satisfy a package binding, from the plugin set — the
 * repository's existing authority for "which packages exist and where".
 *
 * Hardcoding "both hosts" would be true today (every entry declares both) and
 * would quietly become a false positive the day a single-host plugin is added:
 * the binding for a Claude-only package would be evaluated against a Codex
 * install that is correctly absent, and an author would be pushed to work
 * around the check.
 */
function hostsForPackage(pluginSet, name) {
  const declared = pluginSet?.plugins?.[name]?.hosts;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  return declared.filter((host) => HOSTS.includes(host));
}

/**
 * Evaluate one grant's package bindings. Returns `{ ok, reasons }`.
 *
 * Every named package must be, on every host the plugin set declares it for:
 * present, enabled, unambiguous, and at EXACTLY the reviewed version
 * (ADR-0053 §Decision 8's three invalidations are "changes version, is absent,
 * or is disabled" — all three, plus the ambiguity §Decision 5 requires).
 * Absence of a package from the grant means it was not reviewed, never that it
 * is covered, so nothing is inferred about packages the grant does not name.
 */
function evaluatePackages({ grant, observed, pluginSet }) {
  const reasons = [];
  for (const [name, reviewedVersion] of Object.entries(grant.packages ?? {})) {
    const hosts = hostsForPackage(pluginSet, name);
    if (hosts === null) {
      reasons.push(`grant names package "${name}", which the plugin set does not declare — runtime cannot observe it, and an unobservable condition is unassured`);
      continue;
    }
    if (!isSemVer(reviewedVersion)) {
      reasons.push(`grant names package "${name}" at ${JSON.stringify(reviewedVersion)}, which is not a version this framework releases`);
      continue;
    }
    for (const host of hosts) {
      const hostFacts = observed?.[host];
      if (!hostFacts?.authoritative) {
        reasons.push(`${host}: the installed-plugin list is not authoritative (${hostFacts?.list_status ?? 'unavailable'}) — a cache-sourced answer is evidence about disk, not about what the host loads`);
        continue;
      }
      const entry = hostFacts.packages?.[name];
      if (!entry?.present) {
        reasons.push(`${host}: package "${name}" is absent, so the reviewed code is not what is installed`);
        continue;
      }
      if (entry.ambiguous) {
        reasons.push(`${host}: package "${name}" was observed ${entry.observations} times with differing facts — an ambiguous match is unassured`);
        continue;
      }
      if (entry.enabled !== true) {
        reasons.push(`${host}: package "${name}" is ${entry.enabled === false ? 'disabled' : 'of unknown enablement'} — a package the host will not load cannot carry a reviewed behaviour`);
        continue;
      }
      if (!isSemVer(entry.version ?? '')) {
        reasons.push(`${host}: package "${name}" reports version ${JSON.stringify(entry.version)}, which cannot be compared with the reviewed ${reviewedVersion}`);
        continue;
      }
      if (entry.version !== reviewedVersion) {
        reasons.push(`${host}: package "${name}" is ${entry.version}, reviewed at ${reviewedVersion} — a version change invalidates the grant`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Which unobservable predicate keys this grant attached, if any. */
function predicateBlockers(grant) {
  if (!isPlainObject(grant.predicate)) return [];
  return Object.entries(UNOBSERVABLE_PREDICATE_KEYS)
    .filter(([key]) => grant.predicate[key] !== undefined)
    .map(([key, why]) => `grant scopes itself with predicate.${key}, which runtime cannot observe: ${why}`);
}

/**
 * Does this grant's cohort name the observed host pair?
 *
 * BOTH hosts, from ONE tuple. ADR-0053 §Decision 7: independent per-host
 * cohorts do not authorize their Cartesian product, and the schema makes the
 * per-host form unrepresentable so this function cannot be asked the wrong
 * question. An unreadable observed version matches nothing.
 */
function cohortMatch({ grant, hosts }) {
  const tuples = Array.isArray(grant.cohort) ? grant.cohort : [];
  return tuples.some((tuple) => HOSTS.every((host) => sameRelease(hosts?.[host], tuple?.[host])));
}

/**
 * Match this machine against the record. Returns
 * `{ state, grant_id, reasons, ... }` where `state` is `covered` or
 * `unassured` and nothing else.
 *
 * Inputs are all INJECTED — the record, the observed host versions, the
 * observed package facts, and the plugin set. This function reads no file,
 * spawns no process, and consults no clock beyond the `today` the record
 * validation needs. That is what makes it a membership evaluator rather than
 * something that could derive a grant.
 *
 * ORDER MATTERS and is stated rather than implied:
 *
 *   1. an incoherent record covers nothing — the semantic issues are re-run
 *      here rather than trusted from a caller, so a path that forgot to
 *      validate cannot reach a positive;
 *   2. an unreadable observed host version covers nothing;
 *   3. grants whose cohort names this pair are the only ones that APPLY;
 *   4. among applying grants, positives must additionally satisfy package
 *      bindings and carry no unobservable predicate to QUALIFY;
 *   5. a negative that no qualifying positive retires wins (§Decision 3);
 *   6. exactly one qualifying positive is `covered`. Two are a duplicate, and
 *      a duplicate resolves negative.
 */
export function matchAssurance({ record, hosts = null, observed = null, pluginSet = null, today = null } = {}) {
  const issues = assuranceRecordIssues(record, { today });
  if (issues.length > 0) {
    return unassured(
      [`the assurance record is not coherent (${issues.length} issue${issues.length === 1 ? '' : 's'}) — an incoherent record covers nothing`],
      { record_issues: Object.freeze([...issues]) },
    );
  }
  if (!isPlainObject(pluginSet)) {
    return unassured(['no plugin set was supplied — which hosts a package must satisfy is not derivable without it']);
  }
  const unreadable = HOSTS.filter((host) => readVersionToken(hosts?.[host]).token === null
    || readVersionToken(hosts?.[host]).truncated);
  if (unreadable.length > 0) {
    return unassured([`observed host version unreadable for ${unreadable.join(', ')} — a pair verdict computed from one known half is a guess`]);
  }

  const applying = record.grants
    .map((grant, index) => ({ grant, index }))
    .filter(({ grant }) => cohortMatch({ grant, hosts }));

  if (applying.length === 0) {
    return unassured([
      `no grant names the host pair claude ${readVersionToken(hosts.claude).token} / codex ${readVersionToken(hosts.codex).token}`
      + ' — assurance is granted by review, and no review named this pair',
    ]);
  }

  const evaluated = applying.map((entry) => {
    const negative = NEGATIVE_STATES.has(entry.grant.state);
    if (negative) return { ...entry, negative, qualifies: false, reasons: [] };
    const predicate = predicateBlockers(entry.grant);
    const packages = evaluatePackages({ grant: entry.grant, observed, pluginSet });
    return {
      ...entry,
      negative,
      qualifies: predicate.length === 0 && packages.ok,
      reasons: [...predicate, ...packages.reasons],
    };
  });

  const qualifying = evaluated.filter((entry) => entry.qualifies);
  const retired = new Set();
  for (const { grant } of qualifying) {
    for (const target of Array.isArray(grant.supersedes) ? grant.supersedes : []) retired.add(target);
    if (typeof grant.reapproval_of === 'string') retired.add(grant.reapproval_of);
  }

  const activeNegatives = evaluated.filter((entry) => entry.negative && !retired.has(entry.grant.id));
  if (activeNegatives.length > 0) {
    return unassured(
      activeNegatives.map(({ grant }) =>
        `grant "${grant.id}" is ${grant.state} for this host pair — a withdrawn review is not restored by anything observable here`),
      { negative_grant_ids: Object.freeze(activeNegatives.map(({ grant }) => grant.id)) },
    );
  }

  if (qualifying.length > 1) {
    return unassured(
      [`${qualifying.length} grants (${qualifying.map(({ grant }) => `"${grant.id}"`).join(', ')}) all cover this host pair — duplicate records resolve negative (ADR-0053 §Decision 3)`],
      { candidate_grant_ids: Object.freeze(qualifying.map(({ grant }) => grant.id)) },
    );
  }

  if (qualifying.length === 0) {
    const blocked = evaluated.filter((entry) => !entry.negative);
    return unassured(
      blocked.flatMap(({ grant, reasons }) => reasons.map((reason) => `grant "${grant.id}": ${reason}`)),
      { candidate_grant_ids: Object.freeze(blocked.map(({ grant }) => grant.id)) },
    );
  }

  const [winner] = qualifying;
  return {
    state: 'covered',
    grant_id: winner.grant.id,
    reasons: Object.freeze([]),
    // The residuals travel WITH the positive, because ADR-0053 §Decision 6
    // grants with recorded residuals and a consumer that reported `covered`
    // without them would drop the reviewer's own caveats.
    residuals: Object.freeze((Array.isArray(winner.grant.residuals) ? winner.grant.residuals : []).map((residual) => Object.freeze({ ...residual }))),
    review_provenance: Object.freeze({ ...(winner.grant.review_provenance ?? {}) }),
    reviewed_at: winner.grant.reviewed_at ?? null,
  };
}
