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
import { validatePluginSet } from './plugin-set.mjs';
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

    const packages = isPlainObject(grant.packages) ? grant.packages : null;
    if (packages === null || Object.keys(packages).length === 0) {
      err(`${at}.packages is empty — a grant must name the consuming package set it was reviewed against (ADR-0053 §Decision 8)`);
    }

    // The durable identity of the accepted review (ADR-0053 §Decision 2/5). The
    // schema requires it; this re-checks it because a positive with no provenance
    // is a grant nobody can be shown to have made, and cross-host review reached
    // `covered` on exactly that record by calling the matcher directly.
    if (!isPlainObject(grant.review_provenance)
      || typeof grant.review_provenance.kind !== 'string'
      || typeof grant.review_provenance.reference !== 'string'
      || grant.review_provenance.reference.trim() === '') {
      err(`${at}.review_provenance must name the kind and reference of the accepted review — assurance is granted by review, and a grant that cannot point at one is not evidence`);
    }

    // Residual coherence (ADR-0053 §Decision 6). `residuals` is REQUIRED to be
    // present (an empty array says "none"); absent says nothing, and the
    // difference is the reviewer's own caveats.
    if (!Array.isArray(grant.residuals)) {
      err(`${at}.residuals must be an array — an empty array records "no open questions"; an absent one records nothing`);
    } else {
      const surfaces = new Set();
      grant.residuals.forEach((residual, i) => {
        if (!isPlainObject(residual)) return;
        if (residual.consumption === 'consumed' && residual.disposition === 'not-applicable') {
          err(`${at}.residuals[${i}] is consumed AND not-applicable — a surface this framework consumes cannot be inapplicable`);
        }
        if (residual.consumption === 'unadopted' && residual.consuming_package) {
          err(`${at}.residuals[${i}] is unadopted but names consuming_package "${residual.consuming_package}" — unadopted means no package consumes it`);
        }
        // A CONSUMED residual must say which package consumes it, AND that
        // package must be in the binding set. Cross-host review reached
        // `covered` through this gap: a grant bound only to `runtime` carried a
        // `consumed` residual naming `attention`, so the reviewer's own record
        // said `attention` consumes the surface while nothing ever checked
        // `attention`'s version. ADR-0053 §Decision 8 binds assurance to the
        // code whose compatibility was reviewed, and the record named that code.
        if (residual.consumption === 'consumed') {
          if (typeof residual.consuming_package !== 'string' || residual.consuming_package === '') {
            err(`${at}.residuals[${i}] is consumed but names no consuming_package — ADR-0053 §Decision 8 binds a consumed surface to the package that consumes it`);
          } else if (packages !== null && !Object.hasOwn(packages, residual.consuming_package)) {
            err(`${at}.residuals[${i}] names consuming_package "${residual.consuming_package}", which ${at}.packages does not bind — a package the record itself calls a consumer must carry a reviewed version`);
          }
        }
        if (typeof residual.surface === 'string') {
          if (surfaces.has(residual.surface)) {
            err(`${at}.residuals[${i}].surface "${residual.surface}" is listed twice — two dispositions for one surface is a contradiction, not two residuals`);
          }
          surfaces.add(residual.surface);
        }
      });
    }

    // The predicate, checked HERE as well as in the matcher. The matcher's job is
    // to refuse coverage; this is so an author is told the record is defective
    // rather than merely ineffective.
    if (grant.predicate !== undefined && !isPlainObject(grant.predicate)) {
      err(`${at}.predicate must be an object when present — an unreadable scope is not an absent one`);
    } else if (isPlainObject(grant.predicate)) {
      for (const key of Object.keys(grant.predicate)) {
        if (!Object.hasOwn(UNOBSERVABLE_PREDICATE_KEYS, key)) {
          err(`${at}.predicate carries the unrecognised key "${key}" — this reader cannot evaluate it, and a narrowing condition it ignored would turn a restricted grant into a broad one (ADR-0054 §Decision 3)`);
        }
      }
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

  // Pass 2 — the retirement GRAPH. Needs the complete id index, so it cannot be
  // folded into pass 1: a grant may legitimately supersede one declared after it.
  //
  // ⚠ THE TWO EDGE TYPES ARE NOT INTERCHANGEABLE, and conflating them was a
  // measured FALSE-COVERAGE hole in the first version of this module (found in
  // self-review, confirmed independently by cross-host review). Both edges were
  // dropped into one `retired` set, so `supersedes: ["<a revoked id>"]` retired a
  // revocation — bypassing every guard on the re-approval path and reporting
  // `covered`. ADR-0054 §Decision 8 is explicit that a revoked grant "is never
  // un-revoked, only replaced by a NEW id carrying `reapproval_of`", so the edge
  // that may retire a revocation is exactly one, and it is the guarded one.
  //
  //   supersedes    → target MUST be `superseded`. Replaces a live review with a
  //                   newer one. Never touches a revocation.
  //   reapproval_of → target MUST be `revoked`. The one path where a positive
  //                   outranks a negative, so it carries the date guard and the
  //                   at-most-one guard.
  const supersedesEdges = new Map();
  const reapprovalEdges = new Map();
  for (const [id, { grant }] of byId) {
    const reapproval = typeof grant.reapproval_of === 'string' ? grant.reapproval_of : null;
    for (const target of Array.isArray(grant.supersedes) ? grant.supersedes : []) {
      if (!byId.has(target)) {
        err(`grant "${id}" supersedes "${target}", which no grant in this record declares — a dangling reference cannot retire anything`);
        continue;
      }
      if (target === reapproval) {
        err(`grant "${id}" both supersedes and re-approves "${target}" — the two edges mean different things and a grant cannot be replaced and restored by one successor`);
        continue;
      }
      const targetGrant = byId.get(target).grant;
      if (targetGrant.state === 'revoked') {
        err(`grant "${id}" supersedes "${target}", which is REVOKED — supersession never un-revokes; a withdrawn review is restored only by a new id carrying reapproval_of (ADR-0054 §Decision 8)`);
        continue;
      }
      if (targetGrant.state !== 'superseded') {
        err(`grant "${id}" supersedes "${target}", whose state is "${targetGrant.state}" — mark the replaced grant "superseded", so the record reads the same way to a human and to this reader`);
        continue;
      }
      if (isCalendarDate(grant.reviewed_at) && isCalendarDate(targetGrant.reviewed_at) && grant.reviewed_at < targetGrant.reviewed_at) {
        err(`grant "${id}" supersedes "${target}" but was reviewed earlier (${grant.reviewed_at} < ${targetGrant.reviewed_at}) — a replacement cannot predate what it replaces`);
        continue;
      }
      if (!supersedesEdges.has(target)) supersedesEdges.set(target, []);
      supersedesEdges.get(target).push(id);
    }

    if (reapproval === null || reapproval === id) continue;
    if (!byId.has(reapproval)) {
      err(`grant "${id}" declares reapproval_of "${reapproval}", which no grant in this record declares`);
      continue;
    }
    const target = byId.get(reapproval).grant;
    if (target.state !== 'revoked') {
      err(`grant "${id}" re-approves "${reapproval}", whose state is "${target.state}" — only a revoked grant can be re-approved (ADR-0054 §Decision 8)`);
      continue;
    }
    if (isCalendarDate(grant.reviewed_at) && isCalendarDate(target.reviewed_at) && grant.reviewed_at < target.reviewed_at) {
      err(`grant "${id}" re-approves "${reapproval}" but was reviewed earlier (${grant.reviewed_at} < ${target.reviewed_at}) — a re-approval cannot predate what it re-approves`);
      continue;
    }
    if (!reapprovalEdges.has(reapproval)) reapprovalEdges.set(reapproval, []);
    reapprovalEdges.get(reapproval).push(id);
  }

  // NOTE on a rule that is deliberately ABSENT. An earlier version also reported
  // "grant X has state granted but is retired by Y". Once the edges above became
  // typed, that branch became unreachable — an edge is only recorded after its
  // target's state is confirmed `superseded` or `revoked`, so no `granted` grant
  // can appear as a retirement target. It was removed rather than left in place:
  // a guard that cannot fire reads as coverage this module does not have, and the
  // test that asserted its message now asserts the reachable one (the typed-edge
  // rejection), which says the same thing to an author in more actionable words.
  for (const [id, { grant }] of byId) {
    const supersededBy = supersedesEdges.get(id) ?? [];
    const reapprovedBy = reapprovalEdges.get(id) ?? [];
    if (grant.state === 'superseded' && supersededBy.length === 0) {
      err(`grant "${id}" has state "superseded" but no grant supersedes it — a retirement with no successor is a revocation`);
    }
    if (reapprovedBy.length > 1) {
      // Two re-approvals of one withdrawal is a duplicate, and the matcher
      // resolves duplicates negative — so the record could never cover anything
      // through either of them. Named here because the author's intent was
      // presumably one.
      err(`grant "${id}" is re-approved by ${reapprovedBy.length} grants (${reapprovedBy.join(', ')}) — a withdrawal is restored once, by one successor`);
    }
  }

  // Acyclicity, over the supersession edges only (`reapproval_of` is a single
  // scalar into a `revoked` target, and a revoked grant's own edges cannot form
  // a cycle back through it). A cycle means no member has a live successor, so
  // the chain describes nothing — and the transitive walk below must terminate.
  // The precedent is `plugin-set.mjs`, which rejects a cyclic hard-requires
  // graph for the same reason.
  for (const [id] of byId) {
    const seen = new Set();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const successor of supersedesEdges.get(current) ?? []) {
        if (successor === id) {
          err(`the supersession graph contains a cycle through grant "${id}" — a chain of replacements has to end at a live review`);
          stack.length = 0;
          break;
        }
        if (seen.has(successor)) continue;
        seen.add(successor);
        stack.push(successor);
      }
    }
  }

  // Contradictory polarity over one reviewed tuple, unexplained by a
  // retirement. ADR-0054's second measured case, narrowed by TWO exemptions a
  // naive version gets wrong:
  //
  //   - a revoked grant beside its own re-approval IS `granted` + `revoked` over
  //     one cohort, and it is the mechanism §Decision 8 prescribes;
  //   - supersession is TRANSITIVE. `C` replaces `B` replaces `A` is the natural
  //     way a third review gets authored, and a direct-edge-only rule reported it
  //     as a contradiction — telling the author their correct record was wrong.
  //     Measured, and cross-host review named it too.
  const retiresFrom = (startId) => {
    const out = new Set();
    const stack = [startId];
    while (stack.length > 0) {
      const current = stack.pop();
      const grant = byId.get(current)?.grant;
      if (!grant) continue;
      for (const target of Array.isArray(grant.supersedes) ? grant.supersedes : []) {
        // Only edges that SURVIVED validation above may retire anything, so a
        // rejected `supersedes → revoked` cannot launder its target here either.
        if (!(supersedesEdges.get(target) ?? []).includes(current)) continue;
        if (out.has(target)) continue;
        out.add(target);
        stack.push(target);
      }
    }
    const start = byId.get(startId)?.grant;
    if (start && (reapprovalEdges.get(start.reapproval_of) ?? []).includes(startId)) out.add(start.reapproval_of);
    return out;
  };

  const positives = [...byId].filter(([, { grant }]) => grant.state === 'granted');
  const negatives = [...byId].filter(([, { grant }]) => NEGATIVE_STATES.has(grant.state));
  for (const [posId, { grant: pos }] of positives) {
    const retires = retiresFrom(posId);
    for (const [negId, { grant: neg }] of negatives) {
      if (retires.has(negId)) continue;
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

/**
 * The retirement closure a QUALIFYING positive grant carries, recomputed for the
 * matcher over a record `assuranceRecordIssues` has already accepted.
 *
 * Recomputed rather than shared, and the duplication is deliberate: the
 * validator's copy exists to report authoring errors, this one to decide
 * coverage. Sharing one mutable structure between the two is how a reporting
 * relaxation becomes a coverage relaxation. Both are pinned to the same answers
 * by test.
 *
 * The edge rules are re-applied here too — `supersedes` walks only `superseded`
 * targets, `reapproval_of` retires only a `revoked` one. ⚠ THAT REDUNDANCY IS
 * CURRENTLY UNREACHABLE and is labelled rather than left to look tested:
 * `matchAssurance` validates before it matches, so a `supersedes → revoked` edge
 * never arrives here, and no test can drive the branch. It is kept because it is
 * the second guard on the path that produced the worst defect adversarial review
 * found, and because reordering validate-then-match would make it load-bearing.
 * The neighbouring unreachable branch — "state is granted but something retires
 * it" — was DELETED instead, on the opposite reasoning: nothing would ever make
 * that one reachable. A guard that cannot fire is either justified out loud or
 * removed.
 */
function retirementClosure(grant, byId) {
  const out = new Set();
  const stack = [grant.id];
  while (stack.length > 0) {
    const current = byId.get(stack.pop());
    if (!current) continue;
    for (const target of Array.isArray(current.supersedes) ? current.supersedes : []) {
      const candidate = byId.get(target);
      if (!candidate || candidate.state !== 'superseded' || out.has(target)) continue;
      out.add(target);
      stack.push(target);
    }
  }
  if (typeof grant.reapproval_of === 'string' && byId.get(grant.reapproval_of)?.state === 'revoked') {
    out.add(grant.reapproval_of);
  }
  return out;
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
export function observePackages({ claudePluginList = null, claudeListStatus = null, codexPluginList = null } = {}) {
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
    // ⚠ THE CLAUDE STATUS IS REQUIRED, and treating any map as authoritative was
    // a measured false-coverage path (cross-host review). The asymmetry is in the
    // producer: `parseCodexPluginList` carries a status because it parses a JSON
    // envelope, while `parseClaudePluginList` is handed `claudeRaw.plugin?.stdout
    // ?? ''` and parses it whether or not the command SUCCEEDED. A failed
    // `claude plugin list` that still printed partial text therefore produced
    // entries that looked exactly like a clean probe's. ADR-0053 §Decision 3 puts
    // an unreadable host probe in the integrity layer: blocked, never covered.
    //
    // Defaulting `claudeListStatus` to null means a caller that does not pass it
    // gets `authoritative: false`. That is the fail-closed direction, and it is
    // why this is a required fact rather than an optional one.
    claude: {
      authoritative: claudeListStatus === 'available' && isPlainObject(claudePluginList),
      packages: claude,
      list_status: claudeListStatus ?? 'unknown',
    },
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
/**
 * Framework packages INSTALLED on either host that this grant does not name.
 *
 * Evidence, never a verdict — see the note at the `covered` return. Sorted so
 * two runs of the same machine produce the same artifact bytes.
 */
function unboundPackages({ grant, observed, pluginSet }) {
  const named = new Set(Object.keys(grant?.packages ?? {}));
  const declared = Object.keys(pluginSet?.plugins ?? {});
  const unbound = declared.filter((name) => !named.has(name)
    && HOSTS.some((host) => observed?.[host]?.packages?.[name]?.present === true));
  return Object.freeze(unbound.sort());
}

function hostsForPackage(pluginSet, name) {
  const declared = pluginSet?.plugins?.[name]?.hosts;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  const known = declared.filter((host) => HOSTS.includes(host));
  // A declared host this module does not know is NOT quietly dropped. Filtering
  // silently was a measured false-coverage path (cross-host review):
  // `hosts: ['not-a-host']` filtered to `[]`, `evaluatePackages` then ran zero
  // checks, and the empty loop reported the binding satisfied. `['claude',
  // 'not-a-host']` was worse, because it looked like it worked.
  //
  // ⚠ UNREACHABLE as `matchAssurance` calls it today, and labelled rather than
  // left to look tested: `validatePluginSet` now runs first and refuses a host
  // outside its own enum, so no such list arrives here. Mutation-verified — this
  // line can be deleted without turning any test red, which is exactly why it
  // needs the note instead of a case that pretends otherwise. Kept for the same
  // reason as `retirementClosure`'s duplicate edge check: it is the second guard
  // on a path that reached `covered`. The REACHABLE half of this function is the
  // `declared` absent/empty return above, which is tested.
  if (known.length !== declared.length || known.length === 0) return null;
  return known;
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

/**
 * Which predicate conditions block this grant.
 *
 * ⚠ EVERY key present blocks, including one this reader has never heard of, and
 * the unknown case is the one that was measured wrong. The first version
 * enumerated only the three known keys, so `predicate: { expires_at: ... }` —
 * an EXPIRY, the very example ADR-0054 §Decision 3 names — was silently ignored
 * and the grant reported `covered`. §Decision 3 pins the schema version exactly
 * to stop a narrowing key from being read as absent; a semantic layer that
 * enumerated keys reintroduced the same failure through a different door.
 * Found in self-review and independently by cross-host review.
 *
 * A non-object `predicate` blocks for the same reason: a scope this reader
 * cannot read is not an absent scope.
 */
function predicateBlockers(grant) {
  if (grant.predicate === undefined) return [];
  if (!isPlainObject(grant.predicate)) {
    return ['grant carries a `predicate` that is not an object — a scope this reader cannot read is not an absent scope'];
  }
  return Object.keys(grant.predicate).map((key) => (
    Object.hasOwn(UNOBSERVABLE_PREDICATE_KEYS, key)
      ? `grant scopes itself with predicate.${key}, which runtime cannot observe: ${UNOBSERVABLE_PREDICATE_KEYS[key]}`
      : `grant scopes itself with the unrecognised condition predicate.${key} — an unknown narrowing key read as absent is how absence of evidence becomes coverage (ADR-0054 §Decision 3)`
  ));
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
  // The plugin set is VALIDATED, not merely shape-checked. Cross-host review
  // reached `covered` with `plugins: { runtime: { hosts: ['not-a-host'] } }`,
  // because an object was enough and the host filter then emptied the check.
  // `validatePluginSet` is the existing authority and already rejects that, so
  // the fix is to call it rather than to re-derive its rules here.
  const pluginSetCheck = validatePluginSet(pluginSet);
  if (!pluginSetCheck.ok) {
    return unassured(
      [`the supplied plugin set is not valid (${pluginSetCheck.errors.length} error${pluginSetCheck.errors.length === 1 ? '' : 's'}) — which hosts a package must satisfy cannot be read from it`],
      { plugin_set_errors: Object.freeze([...pluginSetCheck.errors]) },
    );
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
  // Retirement is granted only by a QUALIFYING positive, and only along a typed
  // edge. `retirementClosure` re-applies the edge rules, so `supersedes` naming a
  // revoked grant retires nothing here even if a caller skipped validation — the
  // false-coverage hole this replaced put both edge types into one flat set.
  const byId = new Map(record.grants.map((grant) => [grant.id, grant]));
  const retired = new Set();
  for (const { grant } of qualifying) {
    for (const id of retirementClosure(grant, byId)) retired.add(id);
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
    // WHAT THE GRANT DID NOT NAME, carried with the positive.
    //
    // ADR-0054 §Decision 2 lists "exact package-set equality" among the rules
    // this module holds. It holds exact VERSION equality for every package the
    // grant names; it holds nothing about a package the grant omits, and ST5's
    // audit measured the consequence — a grant naming only `runtime` returned
    // `covered` with `attention` installed at an unreviewed version, disabled,
    // and ambiguous, in three separate runs.
    //
    // Deciding WHICH packages a grant is obliged to name is a policy question
    // this subtask deliberately does not answer: requiring every installed
    // plugin would make assurance strictly harder to satisfy than exactness,
    // which is the treadmill ADR-0053 §Decision 6 exists to avoid, and the
    // authoritative "consuming set" is exactly what ADR-0054 §Decision 9 fenced
    // off as a follow-up. What is landed here is the difference between silent
    // and visible: an operator reading a `covered` verdict can see which
    // installed framework packages no reviewer bound.
    unbound_packages: unboundPackages({ grant: winner.grant, observed, pluginSet }),
    // The residuals travel WITH the positive, because ADR-0053 §Decision 6
    // grants with recorded residuals and a consumer that reported `covered`
    // without them would drop the reviewer's own caveats.
    residuals: Object.freeze((Array.isArray(winner.grant.residuals) ? winner.grant.residuals : []).map((residual) => Object.freeze({ ...residual }))),
    review_provenance: Object.freeze({ ...(winner.grant.review_provenance ?? {}) }),
    reviewed_at: winner.grant.reviewed_at ?? null,
  };
}
