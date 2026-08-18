// plugins/runtime/scripts/lib/assurance-result.mjs
//
// ADR-0054 §Decision 4 — the nested, separately versioned assurance RESULT: the
// shape a doctor report carries, the ladder that decides it, and the fail-closed
// projection a consumer reads it back with.
//
// WHY A THIRD MODULE, when two already describe this record. The other two
// answer questions about the RECORD; this one answers a question about a
// REPORT, and the split is the one both of them already drew:
//
//   host-parity-baseline.mjs   the grammars — is there a record, and does it
//                              parse? Owns every packaged-asset read.
//   assurance-contract.mjs     the semantics — is the record coherent, and is
//                              this machine a member of what it grants? Its
//                              header scopes "the doctor report shape" OUT of
//                              itself by name.
//   this module                the report fact — which of those failures is
//                              blocked and which is unassured, what a covered
//                              result must carry, and what a reader may
//                              conclude from a recorded one.
//
// It exists as a module rather than as code inside `doctor.mjs` for two
// measured reasons, not for tidiness:
//
//   1. ONE VOCABULARY. The producer (doctor) and the consumer (dashboard) both
//      need the status list and the schema version. The first draft of this
//      slice declared them in both files — which is precisely the four-private-
//      copies failure ADR-0051 §Decision 4 exists to prevent, reintroduced for
//      a new fact on the day it was born.
//   2. THE LADDER IS TESTABLE ONLY IF IT IS PURE. `evaluateAssurance` reads no
//      file, spawns nothing, and consults no clock. Cross-host review found the
//      concrete consequence: the two-reads hash-disagreement branch cannot be
//      driven through `runDoctor` at all, because the only seam is `pluginRoot`
//      and swapping the file between two reads is a race. As a pure function
//      over injected resolver output it is one deterministic call.
//
// ⚠ THIS MODULE DECIDES NO POLICY. Every rule below is ADR-0053's, and the one
// invariant is its §Decision 3: negative and unknown win over positive at every
// layer. There is no branch that produces `covered` except the one that asks
// `matchAssurance`, and `matchAssurance` produces it only for a human-authored
// grant naming this exact host pair.

import {
  assuranceFailure,
  baselineFailure,
  classifyHostPairRelation,
  readVersionToken,
} from './host-parity-baseline.mjs';
import { matchAssurance } from './assurance-contract.mjs';
import { validatePluginSet } from './plugin-set.mjs';
import { describeFloorFailure, evaluateRuntimeFloor } from './runtime-floor.mjs';
import { sanitizeValue } from './permission-sanitize.mjs';

const HOSTS = Object.freeze(['claude', 'codex']);

/**
 * The assurance answer's OWN version, nested inside a `runtime-doctor-1.0`
 * report that does NOT bump (ADR-0054 §Decision 4).
 *
 * Measured on the retained corpus rather than argued, and re-measured for this
 * slice: with 70 artifacts on disk, bumping the report to `1.1` moves
 * `doctor_runs` from `available malformed=0` to `blocked malformed=70`, and
 * `status: malformed > 0 ? 'blocked' : ...` means no fresh proof ever clears
 * it. One bumped artifact among two is enough — the mixed cell measures
 * `blocked malformed=1 count=2`. Carrying the version on the fact instead costs
 * nothing: a report carrying this section under schema `1.0` still measures
 * `available malformed=0`.
 */
export const ASSURANCE_RESULT_SCHEMA_VERSION = 'runtime-host-assurance-result-1.0';

/**
 * The complete PRODUCER vocabulary, listed for the same reason
 * `BASELINE_STATUSES` and `ASSURANCE_STATUSES` are lists: so a consumer
 * switches on this instead of enumerating a private copy that forgets the next
 * entry.
 *
 * THREE values, exactly one positive. `blocked` and `unassured` are both
 * non-coverage and differ only in the operator's next move — `blocked` means
 * something must be repaired or upgraded before the question can be asked at
 * all, `unassured` means the question was asked and the answer is no. Neither
 * is a degraded positive, and there is deliberately no fourth value a reader
 * could take for "close enough".
 */
export const ASSURANCE_RESULT_STATUSES = Object.freeze(['covered', 'unassured', 'blocked']);

/**
 * The READER vocabulary — the producer's three plus two a reader alone can
 * reach. Kept apart from the producer list because a producer that emitted
 * either of these would be describing its own report rather than the machine.
 */
export const RECORDED_ASSURANCE_STATUSES = Object.freeze([
  ...ASSURANCE_RESULT_STATUSES,
  // No recorded run at all — which is NOT the same as a run that predates the
  // section, and collapsing the two was a measured mis-statement: the reader
  // reported "the recorded report predates the section" for a repository that
  // has never recorded one, asserting something about a document that does not
  // exist. The remedies differ too — record a proof, versus re-record it.
  'no-recorded-run',
  // ADR-0054 §Decision 4, and the ONLY place `legacy-unassured` is definitively
  // knowable. A packaged record that is `absent` has two indistinguishable
  // causes — a baseline predating the record, or altered sentinels — so the
  // producer must not claim legacy. A recorded REPORT is different: a valid
  // historical artifact that carries no assurance section can only be one that
  // predates the section.
  'legacy-unassured',
  // The section is present and this reader cannot read it. Never collapsed into
  // `legacy-unassured`: the two call for opposite actions (upgrade versus
  // re-run), and a newer result minor could carry a NARROWING field whose
  // omission would turn a restricted result into an unrestricted one.
  'unreadable',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Is this a grant id a human review could actually have written?
 *
 * ONE PREDICATE FOR FIVE READERS. `covered` implies "a grant covers this pair",
 * and five places asked that question as `typeof grant_id === 'string'` —
 * `projectRecordedAssurance` here, `compat`'s frozen-snapshot projection, both
 * of `cutover-audit`'s readiness reads, and `doctor`'s experience criterion.
 * Measured in ST5's audit: `''` and `'   '` passed all five, so a report
 * claiming coverage while naming no grant reached `satisfied`, `fresh`,
 * `live_covered`, full experience weight, and `covered` respectively.
 *
 * The rule is not invented here — it is `runtime-host-assurance-1.0.json`'s own
 * `grant.id` pattern, which is exactly what makes a blank id as unemittable as
 * an absent one, and therefore exactly as much a sign of a forged or truncated
 * report. Duplicated as a literal rather than read from the schema because
 * every one of these five readers must work on a RECORDED artifact without
 * loading the packaged schema; the pairing is asserted by test instead.
 */
const GRANT_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function isGrantId(value) {
  return typeof value === 'string' && GRANT_ID_RE.test(value);
}

/** Is this observed version text something the membership grammar can use? */
function usableVersion(value) {
  const read = readVersionToken(value);
  return Boolean(read.token) && !read.truncated;
}

/**
 * Decide the assurance result from already-gathered facts. PURE.
 *
 * Every input is injected: the caller does the I/O, catches the two readers
 * that throw, and hands the outcome here. That is what makes the ladder
 * testable at all, and it is also what makes "this function cannot derive a
 * grant" checkable by reading it.
 *
 * @param {object}  o
 * @param {object}  o.resolvedBaseline  `resolveHostParityBaseline` output.
 * @param {object?} o.record            `resolveAssuranceRecord` output, or null when it threw.
 * @param {string?} o.recordFault       sanitized message when the record read threw.
 * @param {object?} o.pluginSet         `loadPluginSet` output, or null when it threw.
 * @param {string?} o.pluginSetFault    sanitized message when the plugin-set load threw.
 * @param {object}  o.probe             `{claude_probe, codex_probe, probes_ok, observed, normalized_observed}`.
 *                                      `observed` carries RAW host-version text — see the note on step 6.
 * @param {object?} o.packageObservation `observePackages` output, or null when probes were unusable.
 * @param {string}  o.today             the evaluation date, `YYYY-MM-DD`, injected.
 *
 * THE LADDER, ordered. The order is load-bearing rather than stylistic: each
 * step exists because the one below it would otherwise answer confidently a
 * question that could not be asked.
 *
 *   1. baseline integrity failed         → blocked   (§Decision 3, the hard stop)
 *   2. the record read threw             → blocked   (a corrupt package)
 *   3. the two reads saw different bytes → blocked   (a file swapped underneath)
 *   4. the plugin set is missing/invalid → blocked   (a corrupt package)
 *   5. the record itself is unreadable   → blocked, except `absent` → unassured
 *   6. a host version is unusable        → blocked   (no pair to be a member of)
 *   7. package facts are non-authoritative AND a grant applies → blocked
 *   8. membership                        → covered | unassured
 *
 * Step 3 reads like paranoia and is not: `resolveHostParityBaseline` and
 * `resolveAssuranceRecord` share a read PATH and not a read, and the module
 * says so — a file replaced between them yields a header from revision A and a
 * record from revision B, both reporting `resolved`. It is ordered BEFORE the
 * record's own failure classification because a record defect observed across a
 * straddled write may belong to a revision that no longer exists, and telling
 * an operator to repair it would point at bytes that are already gone.
 *
 * ⚠ RESIDUAL, stated rather than implied. The hash binds the two BASELINE
 * reads. It does not bind the schema or the plugin set, which are separate
 * files read at separate moments from the same directory. ADR-0054's atomicity
 * guarantee is release-level — one installed package directory per tag — and
 * that is an assumption about the install being immutable while runtime reads
 * it, not a snapshot this code takes.
 *
 * Step 5's split is decided rather than invented: §Decision 3 names an unknown
 * schema as `blocked` by name, while §Decision 11 names a new reader against an
 * old baseline as `unassured`. What this code must NOT do is claim to know
 * which of `absent`'s two causes it is looking at — the reader cannot
 * distinguish a baseline predating the record from one whose sentinels were
 * altered, and `assuranceFailure`'s own operator action names both. The verdict
 * follows §Decision 11 regardless; only the story would have been a guess.
 *
 * Step 6 is why `probe.observed` must be RAW text and not
 * `probe.normalized_observed`, and this is a MEASURED false-coverage path
 * rather than a stylistic preference (cross-host review). `normalizeVersion`
 * keeps the first three components, so `1.2.3.4` normalizes to `1.2.3` and
 * `readVersionToken` then reports it un-truncated — measured end to end, a
 * machine reporting `1.2.3.4` reaches **covered** against a human grant for
 * `1.2.3`. Passing the raw text preserves the `truncated` signal the grammar
 * emits, and the control still holds: a genuine `1.2.3` reaches `covered`
 * through the same path, so this tightens exactness rather than refusing
 * everything.
 *
 * Step 7 exists because `matchAssurance` reports a non-authoritative
 * installed-plugin list as one membership reason among others, while
 * `observePackages`'s own note places an unreadable host probe in the INTEGRITY
 * layer. Both are non-coverage, so nothing about safety rides on it; the
 * operator action does. It is conditioned on a grant actually applying — with
 * no grant naming this pair the package facts were never consulted, and telling
 * an operator to repair a probe that changed no verdict would be a wrong
 * instruction, not a cautious one.
 */
export function evaluateAssurance({
  resolvedBaseline,
  record = null,
  recordFault = null,
  pluginSet = null,
  pluginSetFault = null,
  probe,
  packageObservation = null,
  today,
} = {}) {
  const baseline = resolvedBaseline?.baseline ?? null;
  // Direction over RAW text for the same reason step 6 uses it: the normalized
  // form cannot report `1.2.3.4` as unparseable, and direction that quietly
  // called a four-component version exact would be evidence that agrees with
  // the bug it sits next to.
  const direction = classifyHostPairRelation({
    observed: probe?.observed ?? null,
    reviewed: baseline ? { claude: baseline.claude, codex: baseline.codex } : null,
  });
  const baselineSha = resolvedBaseline?.provenance?.content_sha256 ?? null;

  const result = (status, { next_action = null, evidence = {} } = {}) => ({
    schema_version: ASSURANCE_RESULT_SCHEMA_VERSION,
    id: 'host_parity_assurance',
    label: 'Host compatibility assurance',
    status,
    evidence: {
      record_status: null,
      grant_id: null,
      // The only strings here that a document or a host CLI supplied are the
      // matcher's reasons and the two fault messages, and those are sanitized.
      // The HASHES deliberately are not: `redactSecrets` rewrites any hex run
      // of 32+ characters to `<redacted-hex>`, which would destroy the one
      // field whose whole job is telling two revisions of a file apart.
      reasons: [],
      residuals: [],
      review_provenance: null,
      reviewed_at: null,
      observed: probe?.observed ?? { claude: null, codex: null },
      normalized_observed: probe?.normalized_observed ?? { claude: null, codex: null },
      probes: { claude: probe?.claude_probe ?? null, codex: probe?.codex_probe ?? null },
      direction,
      baseline_content_sha256: baselineSha,
      record_content_sha256: null,
      block_sha256: null,
      package_observation: null,
      runtime_floor: null,
      provenance: null,
      ...evidence,
    },
    next_action,
  });

  // 1 — INTEGRITY outranks everything. A parseable assurance section next to a
  // broken or escaped baseline is blocked, never covered, and the action is the
  // INTEGRITY action: repairing a record is meaningless while the file it lives
  // in cannot be read.
  const failure = baselineFailure(resolvedBaseline);
  if (failure) {
    return result('blocked', {
      next_action: failure.operator_action,
      evidence: { record_status: 'baseline-unavailable' },
    });
  }

  // 2 — the record read faulted. `resolveAssuranceRecord` throws rather than
  // returning a status when the package cannot find its own packaged schema,
  // and says so: that is a corrupt package, not a document it can report on.
  if (recordFault !== null || record === null) {
    return result('blocked', {
      next_action: `Reinstall or repair the runtime plugin — its packaged assurance schema could not be read (${recordFault ?? 'no record read was supplied'}).`,
    });
  }
  const recordSha = record?.provenance?.content_sha256 ?? null;

  // 3 — ONE revision, or none.
  if (baselineSha === null || recordSha === null || baselineSha !== recordSha) {
    return result('blocked', {
      next_action: 'Re-run runtime:doctor — the packaged host-parity baseline was read twice and the two reads did not see the same bytes, '
        + 'so the dated header and the assurance record may describe different revisions of the file. '
        + 'If this repeats, the packaged file is being modified while runtime reads it (reinstall the runtime plugin).',
      evidence: {
        record_status: record?.status ?? null,
        record_content_sha256: recordSha,
        provenance: record?.provenance ? { ...record.provenance, status: record.status } : null,
      },
    });
  }

  // 4 — the plugin set, which decides WHICH HOSTS a package binding must hold
  // on. Loaded and VALIDATED: `loadPluginSet` only resolves and parses, and
  // `validatePluginSet`'s own header calls a malformed definition a runtime bug
  // that callers should treat as fatal. Left to `matchAssurance` it would come
  // back `unassured`, which reads as "this machine is not covered" for what is
  // actually a corrupt install (cross-host review).
  if (pluginSetFault !== null || !isPlainObject(pluginSet)) {
    return result('blocked', {
      next_action: `Reinstall or repair the runtime plugin — its packaged plugin set could not be read (${pluginSetFault ?? 'no plugin set was supplied'}), so which hosts a reviewed package must satisfy is unknown.`,
      evidence: { record_status: record.status, record_content_sha256: recordSha },
    });
  }
  const pluginSetCheck = validatePluginSet(pluginSet);
  if (!pluginSetCheck.ok) {
    return result('blocked', {
      next_action: `Reinstall or repair the runtime plugin — its packaged plugin set is semantically invalid (${pluginSetCheck.errors.length} error${pluginSetCheck.errors.length === 1 ? '' : 's'}), so which hosts a reviewed package must satisfy cannot be read from it.`,
      evidence: {
        record_status: record.status,
        record_content_sha256: recordSha,
        reasons: pluginSetCheck.errors.map((error) => sanitizeValue(error)).filter(Boolean),
      },
    });
  }

  // 5 — the record's own readability.
  const recordFailure = assuranceFailure(record);
  if (recordFailure) {
    return result(recordFailure.status === 'absent' ? 'unassured' : 'blocked', {
      next_action: recordFailure.operator_action,
      evidence: {
        record_status: recordFailure.status,
        record_content_sha256: recordSha,
        provenance: { ...record.provenance, status: record.status },
      },
    });
  }

  // 6 — the pair. `probes_ok` is necessary and NOT sufficient: a command that
  // exits 0 can still print text no version grammar can read, and §Decision 3
  // puts an unreadable host probe in the integrity layer rather than letting it
  // arrive as a membership miss.
  const unusable = HOSTS.filter((host) => !usableVersion(probe?.observed?.[host]));
  if (!probe?.probes_ok || unusable.length > 0) {
    const detail = !probe?.probes_ok
      ? 'claude/codex --version did not return a usable version (one or both unavailable)'
      : `the version text reported by ${unusable.join(' and ')} is not a version this grammar can read`;
    return result('blocked', {
      next_action: `Probe host CLIs first — ${detail}. `
        + 'Assurance is a claim about the host pair this machine runs, so it cannot be evaluated without both versions.',
      evidence: {
        record_status: record.status,
        record_content_sha256: recordSha,
        provenance: { ...record.provenance, status: record.status },
      },
    });
  }

  // 7 — THE FLOOR (ADR-0054 §Decision 5). A host whose installed runtime predates
  // the reader cannot read the assurance record at all, so no coverage claim
  // about that host pair has a reader behind it.
  //
  // ORDERED HERE by CAUSALITY, and the position was corrected by measurement. It
  // cannot precede step 4, because the floor VALUE is read from the plugin set
  // that step validates — an unvalidated set is not a source for a refusal. It
  // also cannot precede step 6: the floor is decided from the installed-plugin
  // LISTING, and a host whose CLI did not run produces no listing, so an earlier
  // floor answered a failed `--version` probe with "the installed-plugin list was
  // not authoritative" — true, downstream, and not the thing to fix. Measured on
  // the probe-failure case before the move.
  //
  // ⚠ UNCONDITIONAL, unlike step 7's package check. Step 7 is conditioned on a
  // grant applying, on the principle that an operator must not be told to repair
  // a probe that changed no verdict — and the floor is the case where that
  // principle does not hold. Below the floor, no future grant could help either,
  // because the host still could not read it. ADR-0054 §Decision 5 states the
  // consequence as accepted rather than regrettable: a `0.90.x` install reads as
  // not satisfied even for an operator who never runs cutover, and that is the
  // honest meaning of a floor once assurance is the policy.
  //
  // BOTH HOSTS' INSTALLED runtime, never the executing process's — the process
  // running this code is not evidence about either install.
  const floorVerdict = evaluateRuntimeFloor({
    floor: pluginSet?.plugins?.runtime?.minimum_version ?? null,
    packageObservation,
  });
  if (!floorVerdict.satisfied) {
    return result('blocked', {
      next_action: describeFloorFailure(floorVerdict),
      evidence: {
        record_status: record.status,
        record_content_sha256: recordSha,
        runtime_floor: floorVerdict,
      },
    });
  }
  // The SATISFIED verdict travels too. A consumer that must gate on the floor
  // separately — ADR-0054 §Decision 5 requires a hard cutover check — would
  // otherwise have to recompute it from `checkPluginVersions`, which accepts a
  // cache fallback, or from the readiness matrix, which can label cache-only
  // evidence installed. Neither is the raw observation this verdict was built
  // from, and two sources for one fact is how they come to disagree.
  //
  // `null` therefore means "not evaluated" — an integrity step above returned
  // first — and never "satisfied".
  const floorEvidence = { runtime_floor: floorVerdict };

  // 8/9 — MEMBERSHIP, and nothing else. `matchAssurance` reads no file, spawns
  // no process, derives no grant, and has no path that turns absence of
  // evidence into coverage; every input is handed to it here.
  const match = matchAssurance({
    record: record.record,
    // RAW text, and this is the SECOND guard rather than the reachable one —
    // labelled instead of left to look tested, the way `hostsForPackage`'s
    // unknown-host branch is.
    //
    // Cross-host review found the hazard: `normalizeVersion` keeps the first
    // three components, so `1.2.3.4` normalizes to `1.2.3` and reads back
    // un-truncated, and a machine reporting `1.2.3.4` reaches `covered` against
    // a human grant for `1.2.3`. Measured, that is real — with BOTH this line
    // and step 6 mutated away, the four-component case reports `covered`.
    // Measured equally: mutating ONLY this line changes nothing, because step 6
    // refuses a truncated token first, and after step 6 the raw and normalized
    // forms were measured to give identical membership answers for every shape
    // either host prints. So the reachable guard is step 6; this stays because
    // it is the CORRECT input and because a future reordering of the ladder
    // would silently restore the hole if the normalized form were passed here.
    hosts: probe.observed,
    observed: packageObservation,
    pluginSet,
    today,
  });

  const observation = {
    ...floorEvidence,
    record_status: record.status,
    record_content_sha256: recordSha,
    block_sha256: record.block_sha256 ?? null,
    provenance: { ...record.provenance, status: record.status },
    package_observation: packageObservation
      ? {
        claude: { authoritative: packageObservation.claude.authoritative, list_status: packageObservation.claude.list_status },
        codex: { authoritative: packageObservation.codex.authoritative, list_status: packageObservation.codex.list_status },
      }
      : null,
    reasons: match.reasons.map((reason) => sanitizeValue(reason)).filter(Boolean),
    grant_id: match.grant_id ?? null,
  };

  if (match.state === 'covered') {
    return result('covered', {
      // No action: a grant is not a defect. ADR-0053 §Decision 6 permits a grant
      // carrying recorded residuals precisely so assurance does not become
      // strictly harder to satisfy than exactness, so the reviewer's caveats
      // travel as evidence rather than as operator work.
      next_action: null,
      evidence: {
        ...observation,
        residuals: (match.residuals ?? []).map((residual) => ({
          surface: sanitizeValue(residual.surface),
          consumption: sanitizeValue(residual.consumption),
          disposition: sanitizeValue(residual.disposition),
          consuming_package: sanitizeValue(residual.consuming_package),
        })),
        review_provenance: match.review_provenance ?? null,
        reviewed_at: match.reviewed_at ?? null,
        // Installed framework packages the grant did not name. Empty is the
        // meaningful common case; non-empty says a reviewer bound less than
        // this machine runs (ADR-0054 §Decision 2, see `unboundPackages`).
        unbound_packages: match.unbound_packages ?? [],
      },
    });
  }

  // 8 — a grant APPLIED and the installed facts could not be read
  //
  // ⚠ SECOND GUARD, and labelled rather than left to look tested — the same
  // treatment this module already gives the raw-versus-normalized input.
  //
  // ITS ORIGINAL JUSTIFICATION IS NOW VOID, and saying so is the point of
  // rewriting this note rather than leaving it. It used to read "unreachable
  // with a floor DECLARED; it stays for the configuration where
  // `minimum_version` is null". ST5's audit removed that configuration:
  // `evaluateRuntimeFloor` no longer reports a missing floor as satisfied, so
  // step 7 runs `evaluateHostFloor` for BOTH hosts in every configuration and
  // `authoritative` is the first thing it requires. A second refusal was added
  // at the same time inside `matchAssurance`, so `candidate_grant_ids` cannot be
  // populated from a non-authoritative listing either.
  //
  // The branch is therefore dead by TWO independent gates rather than one. It is
  // kept, not deleted, for the reason this module keeps its other second guards:
  // it is the last thing between a non-authoritative listing and a membership
  // answer computed from it, and a future reordering of the ladder is exactly
  // what would restore the hole. What must not happen is this note going stale
  // again — a guard whose stated reason has been falsified reads as tested.
  // authoritatively. Decided on the structured fields rather than on the reason
  // text: `candidate_grant_ids` is non-empty only when a grant's cohort named
  // this pair, and `authoritative` is the producer's own flag.
  const nonAuthoritative = HOSTS.filter((host) => packageObservation?.[host]?.authoritative !== true);
  if (nonAuthoritative.length > 0 && (match.candidate_grant_ids?.length ?? 0) > 0) {
    return result('blocked', {
      next_action: `Repair the installed-plugin listing on ${nonAuthoritative.join(' and ')} — a grant names this host pair, but the list probe was not authoritative `
        + `(${nonAuthoritative.map((host) => `${host}=${packageObservation?.[host]?.list_status ?? 'unavailable'}`).join(', ')}), `
        + 'so whether the reviewed packages are the ones installed cannot be established. A cache-sourced answer is evidence about disk, not about what the host loads.',
      evidence: observation,
    });
  }

  return result('unassured', {
    next_action: 'Assurance is granted by human review of this host pair against this installed code — not by a version match, an upgrade, or elapsed time. '
      + 'Until a release carries a grant naming this pair, assurance stays ungranted (ADR-0053 §Decision 5).',
    evidence: observation,
  });
}

/**
 * Read an assurance answer back out of a RECORDED doctor report. FAIL-CLOSED.
 *
 * The mirror of `evaluateAssurance`, and the reason both live here: a consumer
 * that reimplemented this would be the second copy of one vocabulary, and the
 * copy would be the one that forgot the next status.
 *
 * Four distinct outcomes, and collapsing any pair of them loses an operator
 * action (cross-host review):
 *
 *   no report / no section  → `legacy-unassured` — readable, never malformed,
 *                             never covered. Re-run doctor to get an answer.
 *   unknown version/status  → `unreadable` — this reader is too old for the
 *                             report. Upgrade, do not re-run.
 *   a producer status       → carried verbatim, with its grant id.
 *
 * The `covered`-without-a-`grant_id` case is refused rather than trusted: the
 * producer cannot emit it, so a report that carries it is either corrupt or
 * from a producer this reader does not understand, and both are non-coverage.
 */
export const NO_RECORDED_ASSURANCE = Object.freeze({
  status: 'no-recorded-run',
  grant_id: null,
  direction: null,
  reason: 'no runtime:doctor artifact has been recorded, so no assurance verdict has ever been written down here',
});

export function projectRecordedAssurance(report) {
  // A report is required. `null` means "no run", which is the CALLER's fact and
  // not this report's, so the caller names it with `NO_RECORDED_ASSURANCE`
  // directly — and every in-repo caller does: `inspectLatestDoctorRun` reaches
  // here only past a shape check that already required `report.schema_version`,
  // and `readHostAssurance` supplies the constant itself when it has no run.
  //
  // ⚠ SECOND GUARD, labelled rather than left to look tested. Mutation-verified:
  // deleting this line turns no test red, because the reachable site is the
  // caller's fallback. It stays because a future caller reading an artifact
  // whose `report` key is absent would otherwise fall through to
  // `legacy-unassured` and assert something about a document that does not
  // exist — the exact mis-statement this constant was added to fix.
  if (report === undefined || report === null) return NO_RECORDED_ASSURANCE;
  const section = report?.host_parity_assurance;
  if (section === undefined || section === null) {
    return {
      status: 'legacy-unassured',
      grant_id: null,
      direction: null,
      reason: 'the recorded report carries no assurance result — it predates the section, so it is readable but establishes no coverage',
    };
  }
  if (!isPlainObject(section)
    || section.schema_version !== ASSURANCE_RESULT_SCHEMA_VERSION
    || !ASSURANCE_RESULT_STATUSES.includes(section.status)
    || (section.status === 'covered' && !isGrantId(section.evidence?.grant_id))) {
    return {
      status: 'unreadable',
      grant_id: null,
      direction: null,
      reason: 'the recorded report carries an assurance result this runtime does not read — an unread narrowing condition is how absence of evidence becomes coverage',
    };
  }
  return {
    status: section.status,
    grant_id: sanitizeValue(section.evidence?.grant_id) ?? null,
    direction: sanitizeValue(section.evidence?.direction?.state) ?? null,
    // Carried, not dropped: the dashboard reads this projection, and a `covered`
    // row that hides which installed packages no reviewer bound is the same
    // silence the field was added to break.
    unbound_packages: Object.freeze(
      (Array.isArray(section.evidence?.unbound_packages) ? section.evidence.unbound_packages : [])
        .map((name) => sanitizeValue(name))
        .filter(Boolean),
    ),
    reason: null,
  };
}
